/**
 * resolver-cobros-auditados — deja cada cobro «Por validar» que una PERSONA ya auditó donde
 * corresponde (valor, cobro nuevo, comprobante en su sitio) para que después se apruebe con
 * scripts/aprobar-pagos-auditados.ts. Simula por defecto.
 *
 *   npx tsx scripts/resolver-cobros-auditados.ts --escuela <school_id> --plan <plan.json>              # simulación
 *   npx tsx scripts/resolver-cobros-auditados.ts --escuela <school_id> --plan <plan.json> --aplicar    # escribe
 *   ... --solo <clave>             un solo caso del plan
 *   ... --incluir-propuestas       aplica también los casos con estado «propuesta» (por defecto se simulan, no se aplican)
 *
 * Nació el 2026-11-09 con Monster: 11 comprobantes que la auditoría del 8-nov dejó sin aprobar porque
 * el cobro no era el correcto (torneo cargado a la mensualidad, clase de otra persona, valor que la
 * escuela ya había fijado por chat, excedente que el sistema iba a acreditar dos veces).
 *
 * El script NO decide: ejecuta los pasos del plan en su orden y cada uno verifica antes de escribir
 * que la fila esté como se auditó. Por caso:
 *   · antes de escribir, el caso entero se evalúa en seco; si algún paso encuentra otro estado
 *     (alguien aprobó, movió o cambió algo), el caso se salta y se avisa;
 *   · volver a correrlo es seguro: lo hecho se reconoce (en «Cobros y pagos» por client_request_id
 *     determinístico; en lo demás, por el estado de la fila).
 * Cada escritura directa deja ANTES su fila en `audit_logs` (actor del plan, acción
 * `resolver_cobros_auditados`) con el estado anterior y lo que cambia.
 *
 * Pasos (campo `accion`):
 *   verificar               tabla, id, esperado{}, [despues_de]      afirma un estado, no escribe
 *   corregir_valor          cobro, esperado{}, valor, inscripcion, motivo
 *        Lo mismo que «Cobros abiertos → Cambiar valor» (resolver_cobros_abiertos, acción 'valor'):
 *        UPDATE payments.amount + fila en payment_corrections (kind valor_cambio_plan). Es el único
 *        camino de la app que admite un cobro EN REVISIÓN: los descuentos de «Cobros y pagos»
 *        (payment_adjustments) exigen lote y el lote responde EN_REVISION. La RPC pide sesión de
 *        admin de la escuela (is_school_admin con auth.uid()); acá se escribe lo mismo a nombre del
 *        actor de plataforma, sin el aviso en la app (lo da la aprobación).
 *   crear_cobro             ref, atleta{type,id} | atleta_nuevo{}, linea{}
 *        preview_charge_batch + create_charge_batch (modo un atleta), igual que el modal.
 *   descontar_pendiente     ref, atleta, cobro, esperado{}, descuento{}, monto_final
 *        Descuento sobre un cobro pendiente por «Cobros y pagos» (payment_adjustments con lote).
 *   mover_comprobante       desde, hacia, sha256, ocr_reference, monto_comprobante, estado_origen_final, [cola], nota_origen
 *        El comprobante pasa de un cobro EN REVISIÓN (que vuelve a pendiente) a otro pendiente
 *        (que queda en revisión). Orden por los índices únicos (uq_payments_school_receipt_hash
 *        solo ignora anulados; uq_payments_school_ocr_reference no mira el estado):
 *        A destino ← archivo y lectura (sin huella ni referencia) · B origen ← sin comprobante ·
 *        C destino ← huella y referencia · D fila de la cola → destino.
 *   ligar_cola              cola, hacia, esperado{}, nota      comprobante de una fila de la bandeja → cobro (queda en revisión)
 *   compartir_comprobante   desde, hacia, esperado{}, nota     el MISMO archivo en otro cobro vivo, sin tocar su estado
 *        (regla (b) de fn_payments_saldo_a_favor_al_aprobar y de wa_cubrir_cobros_con_comprobante)
 *   cerrar_cola             cola, esperado{}, motivo            fila de la bandeja que no se aplica (repetida)
 *   aprobar                 cobro, tipo, monto, aviso{}         NO aprueba: arma la lista de scripts/aprobar-pagos-auditados.ts
 *        En la simulación además predice el trigger de saldo a favor (cuánto crearía y de qué cobro lo descontaría).
 *   verificar_sin_saldo_a_favor  cobros[], despues_de          ningún ajuste de saldo a favor en esos cobros
 *
 * Un paso con `despues_de: <cobro>` solo corre cuando ese cobro ya está pagado (segunda corrida,
 * después del script de aprobación). Un cobro nuevo se nombra con `@<ref>` del `crear_cobro`.
 *
 * Flujo: simulación → --aplicar (deja <plan>-aprobar.json) → aprobar-pagos-auditados.ts --archivo
 * <plan>-aprobar.json (simula, luego --aplicar: aprueba y avisa) → este script --aplicar otra vez
 * (verificaciones de después).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function arg(nombre: string): string | null {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const ESCUELA = arg('--escuela');
const PLAN = arg('--plan');
const SOLO = arg('--solo');
const APLICAR = process.argv.includes('--aplicar');
const CON_PROPUESTAS = process.argv.includes('--incluir-propuestas');

const ABIERTOS = ['pending', 'overdue', 'partial', 'awaiting_approval'];
/** Columnas del comprobante que viajan con él (mismas que fusionar-fichas-duplicadas.ts). */
const RECIBO = [
    'receipt_url', 'receipt_image_sha256', 'receipt_image_sha256_source', 'receipt_reference_norm',
    'receipt_submitted_at', 'receipt_verdict', 'receipt_verdict_at', 'receipt_verdict_reasons',
    'ocr_amount', 'ocr_bank', 'ocr_currency', 'ocr_date', 'ocr_time', 'ocr_destination',
    'ocr_destination_name', 'ocr_origin_name', 'ocr_provider', 'ocr_raw_response', 'ocr_reference',
] as const;
const UNICOS = ['receipt_image_sha256', 'ocr_reference'] as const;
const RECIBO_PAGO = ['payment_method', 'payment_date'] as const;
const SUJETO = ['child_id', 'user_id', 'unregistered_athlete_id'] as const;

type Fila = Record<string, any>;
type Tabla = 'payments' | 'enrollments' | 'unregistered_athletes' | 'children' | 'whatsapp_inbound_queue';
interface Paso { accion: string; [k: string]: any }
interface Caso {
    clave: string; nombre: string; estado?: 'listo' | 'propuesta'; certeza?: string;
    evidencia?: string[]; pasos: Paso[]; mensaje?: { para: string; canal: string; texto: string };
}
interface Plan { id: string; escuela: string; actor: string; motivo: string; paso_aviso: string; casos: Caso[] }

type Accion =
    | { tipo: 'update'; tabla: Tabla; id: string; filtro: Fila; patch: Fila; antes: Fila }
    | { tipo: 'insert_correccion'; fila: Fila }
    | { tipo: 'lote'; ref: string; crid: string; args: Fila; cobro?: string };
type Estado = 'pendiente' | 'hecho' | 'conflicto' | 'espera';
interface Resultado { estado: Estado; detalle: string; acciones: Accion[]; extra?: string[] }
interface ItemAprobacion {
    pago: string; tipo: 'completo' | 'abono'; monto: number;
    texto?: string; conversacion?: string; atleta?: string; concepto?: string; _caso: string;
}

const cop = (n: unknown) => (n === null || n === undefined ? '—' : `$${Math.round(Number(n)).toLocaleString('es-CO').replace(/,/g, '.')}`);
const corto = (id: unknown) => (String(id ?? '').startsWith('nuevo') ? String(id) : String(id ?? '—').slice(0, 8));
const hoyBogota = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const igual = (a: unknown, b: unknown) => {
    if (a === null || a === undefined) return b === null || b === undefined;
    if (b === null || b === undefined) return false;
    if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
    return String(a) === String(b);
};
const describir = (patch: Fila) => Object.entries(patch)
    .map(([k, v]) => `${k}=${v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 70)}`)
    .join(', ');
const sub = (f: Fila, cols: readonly string[]) => Object.fromEntries(cols.map((c) => [c, f[c] ?? null]));
const nota = (previa: unknown, nueva: string) => [previa, nueva].filter(Boolean).join(' | ').slice(0, 1000);
/** Misma regla que debidoDe() de aprobar-pagos-auditados.ts: amount − pronto pago − lo ya pagado. */
const debidoDe = (p: Fila) => Math.max((Number(p.amount) || 0) - (Number(p.early_payment_discount_applied) || 0) - (Number(p.amount_paid) || 0), 0);
const normRef = (r: unknown) => (r ? String(r).toUpperCase().replace(/[^A-Z0-9]/g, '') : null);

/** UUID estable por escuela + plan + caso + ref: el client_request_id que hace idempotente el lote. */
function uuidEstable(semilla: string): string {
    const h = crypto.createHash('sha1').update(semilla).digest('hex').slice(0, 32).split('');
    h[12] = '5';
    h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
    const s = h.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Al mover un comprobante, el «monto distinto» del cobro anterior deja de aplicar. */
function veredictoTrasMover(o: Fila, nuevoMonto: number): Fila {
    const razones = Array.isArray(o.receipt_verdict_reasons) ? o.receipt_verdict_reasons : null;
    if (!razones) return {};
    const quedan = razones.filter((r: any) => !(r?.code === 'MONTO_DIFIERE' && Number(r?.detail?.extracted) === nuevoMonto));
    if (quedan.length === razones.length) return {};
    const peor = quedan.some((r: any) => r?.level === 'rojo') ? 'rojo' : quedan.some((r: any) => r?.level === 'amarillo') ? 'amarillo' : 'verde';
    return { receipt_verdict_reasons: quedan, receipt_verdict: peor };
}

// ─── Estado en memoria (lo que la simulación cree que hay) ──────────────────
class Memoria {
    filas = new Map<string, Fila>();
    correcciones: Fila[] = [];
    ajustes: Fila[] = [];
    lotes = new Map<string, Fila>();          // client_request_id → charge_batches
    refs = new Map<string, string>();         // ref → id del cobro (real o 'nuevo:<ref>')
    nuestras = new Set<string>();             // record_id con audit_logs nuestro de corregir_valor
    k(t: Tabla, id: string) { return `${t}:${id}`; }
    get(t: Tabla, id: string) { return this.filas.get(this.k(t, id)); }
    put(t: Tabla, f: Fila) { this.filas.set(this.k(t, f.id), { ...f }); }
    aplicar(t: Tabla, id: string, patch: Fila) { const f = this.get(t, id); if (f) this.put(t, { ...f, ...patch }); }
    de(t: Tabla) { return [...this.filas.entries()].filter(([k]) => k.startsWith(`${t}:`)).map(([, v]) => v); }
    clonar(): Memoria {
        const m = new Memoria();
        m.filas = new Map([...this.filas.entries()].map(([k, v]) => [k, { ...v }]));
        m.correcciones = this.correcciones.map((x) => ({ ...x }));
        m.ajustes = this.ajustes.map((x) => ({ ...x }));
        m.lotes = new Map(this.lotes);
        m.refs = new Map(this.refs);
        m.nuestras = new Set(this.nuestras);
        return m;
    }
}

function difiere(f: Fila | undefined, esperado: Fila): string[] {
    if (!f) return ['la fila no existe'];
    return Object.entries(esperado).filter(([k, v]) => !igual(f[k], v))
        .map(([k, v]) => `${k}: auditado ${v === null ? 'NULL' : JSON.stringify(v)}, hoy ${f[k] === null || f[k] === undefined ? 'NULL' : JSON.stringify(f[k])}`);
}
const dueno = (p: Fila) => p.child_id ? `c:${p.child_id}` : p.unregistered_athlete_id ? `u:${p.unregistered_athlete_id}`
    : (p.user_id || p.parent_id) ? `p:${p.user_id || p.parent_id}` : null;

// ─── Contexto de ejecución ──────────────────────────────────────────────────
interface Ctx {
    sb: any; plan: Plan; caso: Caso; m: Memoria; real: boolean;
    aprobaciones: ItemAprobacion[];
    /** El caso ya empezó (audit_logs nuestro o un cobro suyo aprobado por el actor): las precondiciones ya se consumieron. */
    iniciado: boolean;
}
const resolver = (m: Memoria, id: string) => (id?.startsWith('@') ? m.refs.get(id.slice(1)) ?? null : id);

// ─── Lotes («Cobros y pagos») ───────────────────────────────────────────────
async function telefonoDeConversacion(sb: any, escuela: string, conv: string): Promise<string | null> {
    const { data } = await sb.from('whatsapp_conversations').select('contact_wa_id').eq('id', conv).eq('school_id', escuela).maybeSingle();
    const d = String(data?.contact_wa_id ?? '').replace(/\D/g, '');
    return d ? (d.startsWith('57') && d.length === 12 ? d.slice(2) : d) : null;
}

async function argsDeLote(c: Ctx, p: Paso): Promise<Fila> {
    const base: Fila = {
        p_school_id: c.plan.escuela, p_actor: c.plan.actor, p_athletes: [], p_lines: [], p_pending: [],
        p_global_discount: null, p_payment: null, p_new_athlete: null, p_overrides: [], p_mode: 'single',
    };
    if (p.accion === 'crear_cobro') {
        const l = p.linea;
        base.p_lines = [{
            idx: 0, category: l.category, amount: l.amount, concept: l.concept,
            due_date: l.due_date === 'hoy' ? hoyBogota() : l.due_date,
            ...(l.notes ? { notes: l.notes } : {}), pay_amount: 0,
        }];
        if (p.atleta_nuevo) {
            const a = p.atleta_nuevo;
            const tel = a.guardian_phone ?? (a.telefono_de_conversacion ? await telefonoDeConversacion(c.sb, c.plan.escuela, a.telefono_de_conversacion) : null);
            if (!tel) throw new Error(`${c.caso.clave}: sin teléfono del acudiente para el atleta nuevo`);
            base.p_new_athlete = {
                kind: a.kind, full_name: a.full_name, guardian_phone: tel,
                ...(a.guardian_name ? { guardian_name: a.guardian_name } : {}),
                ...(a.date_of_birth ? { date_of_birth: a.date_of_birth } : {}),
                allow_duplicate: a.allow_duplicate === true,
            };
        } else {
            base.p_athletes = [{ type: p.atleta.type, id: p.atleta.id }];
        }
    } else {
        const f = c.m.get('payments', p.cobro)!;
        base.p_athletes = [{ type: p.atleta.type, id: p.atleta.id }];
        base.p_pending = [{
            payment_id: p.cobro,
            seen: { amount: Number(f.amount), amount_paid: Number(f.amount_paid) || 0 },
            discount: p.descuento, pay_amount: 0, close_mode: 'abono',
        }];
    }
    return base;
}

async function vistaPrevia(c: Ctx, args: Fila): Promise<Fila> {
    const { data, error } = await c.sb.rpc('preview_charge_batch', args);
    if (error) throw new Error(`preview_charge_batch: ${error.message}${error.details ? ` (${error.details})` : ''}`);
    return data as Fila;
}

// ─── Evaluación de cada paso ────────────────────────────────────────────────
async function evaluar(p: Paso, c: Ctx): Promise<Resultado> {
    const m = c.m;
    const ok = (detalle: string, acciones: Accion[] = [], extra?: string[]): Resultado => ({ estado: 'pendiente', detalle, acciones, extra });
    const hecho = (detalle: string, extra?: string[]): Resultado => ({ estado: 'hecho', detalle, acciones: [], extra });
    const choque = (detalle: string): Resultado => ({ estado: 'conflicto', detalle, acciones: [] });
    const espera = (detalle: string): Resultado => ({ estado: 'espera', detalle, acciones: [] });
    const upd = (tabla: Tabla, id: string, filtro: Fila, patch: Fila): Accion => {
        const antes = m.get(tabla, id) ?? {};
        m.aplicar(tabla, id, patch);
        return { tipo: 'update', tabla, id, filtro, patch, antes: sub(antes, Object.keys({ ...filtro, ...patch })) };
    };

    // Pasos de después: solo cuando el cobro de referencia ya está pagado.
    if (p.despues_de) {
        const ref = resolver(m, p.despues_de);
        const f = ref ? m.get('payments', ref) : undefined;
        if (!f || f.status !== 'paid') return espera(`espera la aprobación de ${p.despues_de.startsWith('@') ? p.despues_de : corto(p.despues_de)} (${f?.status ?? 'sin crear'})`);
    }

    switch (p.accion) {
        case 'verificar': {
            const id = resolver(m, p.id)!;
            const d = difiere(m.get(p.tabla, id), p.esperado);
            if (d.length && !p.despues_de && c.iniciado) return hecho(`${p.tabla} ${corto(id)}: precondición ya consumida (el caso está en curso)`);
            return d.length ? choque(`${p.tabla} ${corto(id)} no está como se auditó: ${d.join('; ')}`) : hecho(`${p.tabla} ${corto(id)} está como se auditó`);
        }

        case 'corregir_valor': {
            const f = m.get('payments', p.cobro);
            if (!f) return choque(`cobro ${corto(p.cobro)} no existe`);
            const ya = m.correcciones.find((x) => x.payment_id === p.cobro && igual(x.amount_after, p.valor));
            if (igual(f.amount, p.valor) && ya) return hecho(`cobro ${corto(p.cobro)} ya vale ${cop(p.valor)} (payment_corrections ${corto(ya.id)})`);
            const esMens = f.payment_category === 'mensualidad' || (f.payment_category == null && f.payment_type === 'subscription');
            if (!esMens || !f.period_year || !f.period_month) return choque(`cobro ${corto(p.cobro)} no es una mensualidad con mes: «Cambiar valor» no aplica`);
            const ins = m.get('enrollments', p.inscripcion);
            if (!ins || SUJETO.every((s) => !ins[s] || ins[s] !== f[s])) return choque(`la inscripción ${corto(p.inscripcion)} no es del deportista del cobro`);
            const fila = {
                school_id: f.school_id, payment_id: f.id, enrollment_id: p.inscripcion, kind: 'valor_cambio_plan',
                amount_before: Number(p.esperado.amount), amount_after: p.valor, status_before: p.esperado.status,
                motivo: String(p.motivo).slice(0, 500), created_by: c.plan.actor,
            };
            if (igual(f.amount, p.valor)) {
                // Corte entre el UPDATE y el INSERT de una corrida anterior: completar solo si el UPDATE fue nuestro.
                if (!m.nuestras.has(f.id)) return choque(`cobro ${corto(p.cobro)} ya vale ${cop(p.valor)} pero sin rastro nuestro: alguien lo cambió; revisar`);
                m.correcciones.push({ ...fila, id: 'nuevo' });
                return ok(`completar el rastro: payment_corrections de ${corto(p.cobro)}`, [{ tipo: 'insert_correccion', fila }]);
            }
            const d = difiere(f, p.esperado);
            if (d.length) return choque(`cobro ${corto(p.cobro)} cambió: ${d.join('; ')}`);
            if (!(p.valor > 0) || p.valor <= (Number(f.amount_paid) || 0)) return choque(`valor ${cop(p.valor)} no puede ser ≤ lo abonado`);
            const a = upd('payments', f.id, { status: p.esperado.status, amount: p.esperado.amount }, { amount: p.valor });
            m.correcciones.push({ ...fila, id: 'nuevo' });
            return ok(`cambiar valor ${corto(f.id)} ${cop(p.esperado.amount)} → ${cop(p.valor)} (${f.status}) + payment_corrections valor_cambio_plan «${p.motivo}»`,
                [a, { tipo: 'insert_correccion', fila }]);
        }

        case 'crear_cobro':
        case 'descontar_pendiente': {
            const crid = uuidEstable(`${c.plan.escuela}:${c.plan.id}:${c.caso.clave}:${p.ref}`);
            const lote = m.lotes.get(crid);
            if (p.accion === 'crear_cobro') {
                if (lote) {
                    const creado = m.de('payments').find((x) => x.charge_batch_id === lote.id);
                    if (!creado) return choque(`el lote ${corto(lote.id)} existe pero no encuentro su cobro`);
                    m.refs.set(p.ref, creado.id);
                    return hecho(`@${p.ref} ya existe: ${corto(creado.id)} ${cop(creado.amount)} «${creado.concept}» (${creado.status})`);
                }
            } else {
                const f = m.get('payments', p.cobro);
                if (!f) return choque(`cobro ${corto(p.cobro)} no existe`);
                if (lote || (igual(f.amount, p.monto_final) && m.ajustes.some((a) => a.payment_id === f.id && a.origin === 'modal' && a.reason_code === p.descuento.reason_code))) {
                    return hecho(`cobro ${corto(f.id)} ya está en ${cop(f.amount)} (descuento ${p.descuento.reason_code})`);
                }
                const d = difiere(f, p.esperado);
                if (d.length) return choque(`cobro ${corto(p.cobro)} cambió: ${d.join('; ')}`);
            }
            const args = await argsDeLote(c, p);
            const vista = await vistaPrevia(c, args);
            const errores = (vista.errors ?? []) as Fila[];
            if (errores.length) return choque(`la vista previa del lote trae errores: ${JSON.stringify(errores).slice(0, 300)}`);
            const extra: string[] = [];
            if (Array.isArray(vista.duplicates) && vista.duplicates.length) extra.push(`posibles duplicados del atleta nuevo: ${vista.duplicates.map((d: any) => `${d.full_name} [${(d.matched_by ?? []).join('+')}]`).join('; ')}`);
            if (p.accion === 'crear_cobro') {
                const it = ((vista.items ?? []) as Fila[]).find((x) => x.type === 'new');
                if (!it) return choque('la vista previa no trae la línea nueva');
                if (!it.will_create) return choque(`el lote no crearía el cobro: ${it.skip_reason ?? it.skip_reason_raw}`);
                if (!igual(it.amount, p.linea.amount)) return choque(`el lote lo crearía por ${cop(it.amount)}, se auditó ${cop(p.linea.amount)}`);
                if ((it.warnings ?? []).length) extra.push(`avisos del lote: ${(it.warnings as string[]).join(', ')}`);
                const id = `nuevo:${p.ref}`;
                m.put('payments', {
                    id, school_id: c.plan.escuela, status: 'pending', amount: it.amount, amount_paid: null, concept: it.concept,
                    payment_category: it.category, due_date: it.due_date, period_year: it.period_year, period_month: it.period_month,
                    team_id: it.team_id, branch_id: it.branch_id, parent_id: it.parent_id,
                    child_id: it.child_id ?? (p.atleta_nuevo?.kind === 'menor' ? `nuevo-atleta:${p.ref}` : null),
                    unregistered_athlete_id: it.unregistered_athlete_id ?? (p.atleta_nuevo && p.atleta_nuevo.kind !== 'menor' ? `nuevo-atleta:${p.ref}` : null),
                    user_id: it.user_id ?? null, receipt_url: null, receipt_image_sha256: null, ocr_reference: null,
                    early_payment_discount_applied: null, charge_batch_id: `nuevo-lote:${p.ref}`,
                });
                m.refs.set(p.ref, id);
                return ok(`crear por «Cobros y pagos» ${it.category} ${cop(it.amount)} «${it.concept}» · equipo ${corto(it.team_id)} · vence ${it.due_date} · ${p.atleta_nuevo ? `atleta NUEVO (${p.atleta_nuevo.kind}) «${p.atleta_nuevo.full_name}»` : `${p.atleta.type} ${corto(p.atleta.id)}`} · client_request_id ${corto(crid)}`,
                    [{ tipo: 'lote', ref: p.ref, crid, args: { ...args, preview_hash: vista.preview_hash } }], extra);
            }
            const it = ((vista.pending ?? vista.items ?? []) as Fila[]).find((x) => x.payment_id === p.cobro);
            if (!it) return choque('la vista previa no trae el pendiente');
            if (!igual(it.amount, p.monto_final)) return choque(`el descuento lo dejaría en ${cop(it.amount)}, se auditó ${cop(p.monto_final)}`);
            const f = m.get('payments', p.cobro)!;
            m.aplicar('payments', f.id, {
                amount: p.monto_final, discount_amount: (Number(f.discount_amount) || 0) + Number(p.descuento.value),
                list_amount: f.list_amount ?? Number(f.amount) + (Number(f.discount_amount) || 0) - (Number(f.late_fee_amount) || 0),
            });
            m.ajustes.push({ payment_id: f.id, origin: 'modal', kind: 'descuento', reason_code: p.descuento.reason_code, amount: p.descuento.value });
            return ok(`descuento por «Cobros y pagos» en ${corto(f.id)}: ${cop(f.amount)} → ${cop(p.monto_final)} (${p.descuento.reason_code} ${cop(p.descuento.value)}: «${p.descuento.reason_text}») · client_request_id ${corto(crid)}`,
                [{ tipo: 'lote', ref: p.ref, crid, args: { ...args, preview_hash: vista.preview_hash }, cobro: f.id }], extra);
        }

        case 'mover_comprobante': {
            const hacia = resolver(m, p.hacia);
            const o = m.get('payments', p.desde);
            const t = hacia ? m.get('payments', hacia) : undefined;
            if (!o || !t) return choque(`cobro ${!o ? corto(p.desde) : p.hacia} no existe`);
            const q = p.cola ? m.get('whatsapp_inbound_queue', p.cola) : undefined;
            if (p.cola && !q) return choque(`fila de la bandeja ${corto(p.cola)} no existe`);
            const oTiene = o.receipt_image_sha256 === p.sha256;
            const colaLista = !q || q.result_ref_id === t.id;
            // «pending» incluye «overdue»: el job de vencidos lo puede mover después de la corrida.
            const origenListo = p.estado_origen_final === 'pending' ? ['pending', 'overdue'].includes(o.status) : o.status === p.estado_origen_final;
            if (t.receipt_image_sha256 === p.sha256 && igual(t.ocr_reference, p.ocr_reference) && !oTiene && origenListo && colaLista) {
                return hecho(`el comprobante ya está en ${corto(t.id)} y ${corto(o.id)} quedó ${o.status}`);
            }
            // Estado esperado de cada lado según el tramo en que esté.
            const tSinNada = !t.receipt_url && !t.receipt_image_sha256 && t.status === 'pending';
            const tConArchivo = !!t.receipt_url && t.status === 'awaiting_approval' && (!t.receipt_image_sha256 || t.receipt_image_sha256 === p.sha256);
            if (!tSinNada && !tConArchivo) return choque(`el destino ${corto(t.id)} está ${t.status}${t.receipt_image_sha256 ? ` con OTRO comprobante (${corto(t.receipt_image_sha256)})` : ''}`);
            if (!igual(t.amount, p.monto_comprobante)) return choque(`el destino vale ${cop(t.amount)} y el comprobante ${cop(p.monto_comprobante)}`);
            if (oTiene) {
                if (o.status !== 'awaiting_approval') return choque(`el origen ${corto(o.id)} está ${o.status}, se auditó en revisión`);
                if (!igual(o.ocr_reference, p.ocr_reference) || !igual(o.ocr_amount, p.monto_comprobante)) {
                    return choque(`el comprobante de ${corto(o.id)} dice ${cop(o.ocr_amount)} ref ${o.ocr_reference}, se auditó ${cop(p.monto_comprobante)} ref ${p.ocr_reference}`);
                }
            } else if (o.receipt_image_sha256) {
                return choque(`el origen ${corto(o.id)} tiene OTRO comprobante (${corto(o.receipt_image_sha256)})`);
            } else if (tSinNada) {
                return choque(`ni el origen ni el destino tienen el comprobante ${corto(p.sha256)}`);
            }
            if (p.ocr_reference) {
                const otro = m.de('payments').find((x) => x.id !== o.id && x.id !== t.id && (x.ocr_reference === p.ocr_reference || x.receipt_image_sha256 === p.sha256));
                if (otro) return choque(`la huella o la referencia ya están en otro cobro (${corto(otro.id)})`);
            }
            const acciones: Accion[] = [];
            if (tSinNada) {
                const copia: Fila = {};
                for (const col of RECIBO) if (!(UNICOS as readonly string[]).includes(col) && o[col] !== null && o[col] !== undefined) copia[col] = o[col];
                for (const col of RECIBO_PAGO) if ((t[col] === null || t[col] === undefined) && o[col] != null) copia[col] = o[col];
                Object.assign(copia, veredictoTrasMover(o, Number(t.amount)), { status: 'awaiting_approval' });
                acciones.push(upd('payments', t.id, { status: 'pending', receipt_url: null }, copia));
            }
            if (oTiene || !origenListo) {
                if (!oTiene && o.status !== 'awaiting_approval') return choque(`el origen ${corto(o.id)} quedó ${o.status} sin comprobante: revisar`);
                const suelta: Fila = {};
                for (const col of RECIBO) if (o[col] !== null && o[col] !== undefined) suelta[col] = null;
                if (p.estado_origen_final === 'pending') for (const col of RECIBO_PAGO) if (o[col] != null) suelta[col] = null;
                suelta.status = p.estado_origen_final;
                suelta.notes = nota(o.notes, `${p.nota_origen} (${hoyBogota()}, cobro ${corto(t.id)})`);
                acciones.push(upd('payments', o.id, { status: 'awaiting_approval', receipt_image_sha256: oTiene ? p.sha256 : null }, suelta));
            }
            if (t.receipt_image_sha256 !== p.sha256) {
                acciones.push(upd('payments', t.id, { status: 'awaiting_approval', receipt_image_sha256: null, ocr_reference: null },
                    { receipt_image_sha256: p.sha256, ocr_reference: p.ocr_reference }));
            }
            if (q && q.result_ref_id !== t.id) {
                if (q.result_ref_id !== o.id) return choque(`la fila ${corto(q.id)} apunta a ${corto(q.result_ref_id)}, se auditó ${corto(o.id)}`);
                acciones.push(upd('whatsapp_inbound_queue', q.id, { result_ref_id: o.id }, { result_ref_id: t.id }));
            }
            return ok(`comprobante ${cop(p.monto_comprobante)} (huella ${corto(p.sha256)}, ref ${p.ocr_reference}): ${corto(o.id)} → ${corto(t.id)}; ${corto(o.id)} vuelve a ${p.estado_origen_final}, ${corto(t.id)} queda en revisión`, acciones);
        }

        case 'ligar_cola': {
            const hacia = resolver(m, p.hacia);
            const q = m.get('whatsapp_inbound_queue', p.cola);
            const t = hacia ? m.get('payments', hacia) : undefined;
            if (!q || !t) return choque(`${!q ? `fila ${corto(p.cola)}` : `cobro ${p.hacia}`} no existe`);
            const ocr = q.pregunta_ocr?.ocr ?? {};
            const sha = q.pregunta_ocr?.sha ?? null;
            if (t.receipt_image_sha256 === sha && q.result_ref_id === t.id) return hecho(`la fila ${corto(q.id)} ya está ligada a ${corto(t.id)}`);
            const d = difiere({ status: q.status, result_ref_id: q.result_ref_id, sha, monto: ocr.amount, referencia: ocr.reference },
                p.esperado);
            if (d.length) return choque(`fila ${corto(q.id)} no está como se auditó: ${d.join('; ')}`);
            if (!q.storage_path) return choque(`fila ${corto(q.id)} sin archivo`);
            const acciones: Accion[] = [];
            if (t.receipt_image_sha256 !== sha) {
                if (t.status !== 'pending' || t.receipt_url) return choque(`el destino ${corto(t.id)} está ${t.status}${t.receipt_url ? ' con comprobante' : ''}`);
                if (!igual(t.amount, ocr.amount)) return choque(`el destino vale ${cop(t.amount)} y el comprobante ${cop(ocr.amount)}`);
                const otro = m.de('payments').find((x) => x.id !== t.id && (x.receipt_image_sha256 === sha || (ocr.reference && x.ocr_reference === ocr.reference)));
                if (otro) return choque(`la huella o la referencia ya están en otro cobro (${corto(otro.id)})`);
                acciones.push(upd('payments', t.id, { status: 'pending', receipt_url: null }, {
                    receipt_url: q.storage_path, receipt_image_sha256: sha, receipt_image_sha256_source: 'server_verified',
                    ocr_reference: ocr.reference ?? null, receipt_reference_norm: normRef(ocr.reference),
                    ocr_amount: ocr.amount ?? null, ocr_date: ocr.date ?? null, ocr_time: ocr.time ?? null, ocr_bank: ocr.bank ?? null,
                    ocr_currency: ocr.currency ?? null, ocr_destination: ocr.destination ?? null,
                    ocr_destination_name: ocr.destinationName ?? null, ocr_origin_name: ocr.originName ?? null, ocr_provider: ocr.provider ?? null,
                    payment_method: t.payment_method ?? 'transfer', payment_date: t.payment_date ?? ocr.date ?? null,
                    status: 'awaiting_approval',
                }));
            }
            acciones.push(upd('whatsapp_inbound_queue', q.id, { status: q.status, result_ref_id: null }, {
                status: 'done', result_type: 'payment_receipt', result_ref_id: t.id, outcome_notified_at: new Date().toISOString(),
                error_message: nota(`aplicado tras la auditoría ${hoyBogota()}: ${p.nota}`, q.error_message),
            }));
            return ok(`fila ${corto(q.id)} (${cop(ocr.amount)}, ref ${ocr.reference}, ${ocr.date}) → cobro ${corto(t.id)}, que queda en revisión`, acciones);
        }

        case 'compartir_comprobante': {
            const o = m.get('payments', p.desde);
            const t = m.get('payments', p.hacia);
            if (!o || !t) return choque(`cobro ${!o ? corto(p.desde) : corto(p.hacia)} no existe`);
            if (!o.receipt_url) return choque(`el origen ${corto(o.id)} no tiene comprobante`);
            if (t.receipt_url === o.receipt_url) return hecho(`${corto(t.id)} ya comparte el comprobante de ${corto(o.id)}`);
            const d = difiere(t, p.esperado);
            if (d.length) return choque(`cobro ${corto(t.id)} cambió: ${d.join('; ')}`);
            return ok(`${corto(t.id)} (${t.status}, abonado ${cop(t.amount_paid)}) ← archivo del comprobante de ${corto(o.id)}; sin tocar estado ni abono`,
                [upd('payments', t.id, { status: t.status, receipt_url: null }, { receipt_url: o.receipt_url, notes: nota(t.notes, `${p.nota} (${hoyBogota()})`) })]);
        }

        case 'cerrar_cola': {
            const q = m.get('whatsapp_inbound_queue', p.cola);
            if (!q) return choque(`fila ${corto(p.cola)} no existe`);
            if (String(q.error_message ?? '').startsWith('cerrado_escuela:')) return hecho(`fila ${corto(q.id)} ya está cerrada`);
            const d = difiere({ status: q.status, sha: q.pregunta_ocr?.sha ?? null }, p.esperado);
            if (d.length) return choque(`fila ${corto(q.id)} no está como se auditó: ${d.join('; ')}`);
            return ok(`cerrar fila ${corto(q.id)} (${q.status}): ${p.motivo}`, [upd('whatsapp_inbound_queue', q.id, { status: q.status }, {
                status: 'ignored', locked_until: null, outcome_notified_at: new Date().toISOString(),
                error_message: `cerrado_escuela: resuelto_auditoria — ${p.motivo} | ${q.error_message ?? ''}`.slice(0, 1000),
            })]);
        }

        case 'aprobar': {
            const id = resolver(m, p.cobro);
            const f = id ? m.get('payments', id) : undefined;
            if (!f) return choque(`cobro ${p.cobro} no existe`);
            if (f.status === 'paid') return hecho(`${corto(f.id)} ya está pagado (${cop(f.amount_paid)})`);
            if (f.status !== 'awaiting_approval') return choque(`${corto(f.id)} está ${f.status}: para aprobarlo debe estar en revisión`);
            const debido = debidoDe(f);
            if (p.tipo === 'completo' && Number(p.monto) + 1 < debido) return choque(`«completo» por ${cop(p.monto)} no cubre lo debido ${cop(debido)}`);
            const item: ItemAprobacion = {
                pago: f.id, tipo: p.tipo, monto: p.monto, _caso: c.caso.clave,
                ...(p.aviso?.texto ? { texto: p.aviso.texto } : {}), ...(p.aviso?.conversacion ? { conversacion: p.aviso.conversacion } : {}),
                ...(p.aviso?.atleta ? { atleta: p.aviso.atleta } : {}), ...(p.aviso?.concepto ? { concepto: p.aviso.concepto } : {}),
            };
            c.aprobaciones.push(item);
            if (c.real) return espera(`queda en la lista de aprobación: ${corto(f.id)} ${p.tipo} ${cop(p.monto)} (lo aprueba aprobar-pagos-auditados.ts)`);
            // Simulación: se aprueba en memoria y se predice el trigger de saldo a favor.
            const extra = predecirSaldoAFavor(m, f);
            m.aplicar('payments', f.id, { status: 'paid', amount_paid: (Number(f.amount_paid) || 0) + debido, approved_by: c.plan.actor });
            return ok(`aprobar ${corto(f.id)} ${p.tipo} ${cop(p.monto)} (debido ${cop(debido)}) → paid  [lo hace aprobar-pagos-auditados.ts]`, [], extra);
        }

        case 'verificar_sin_saldo_a_favor': {
            const ids = (p.cobros as string[]).map((x) => resolver(m, x));
            const ajustes = m.ajustes.filter((a) => ids.includes(a.payment_id) && a.origin === 'saldo_a_favor');
            return ajustes.length
                ? choque(`HAY saldo a favor: ${ajustes.map((a) => `${a.kind} ${cop(a.amount)} en ${corto(a.payment_id)}`).join('; ')} — revisar a mano`)
                : hecho(`ningún ajuste de saldo a favor en ${ids.map(corto).join(', ')}`);
        }

        default:
            return choque(`acción desconocida: ${p.accion}`);
    }
}

/** Espejo de fn_payments_saldo_a_favor_al_aprobar + _saldo_a_favor_consumir (base viva 2026-11-09). */
function predecirSaldoAFavor(m: Memoria, f: Fila): string[] {
    const ocr = Number(f.ocr_amount);
    const esperado = Number(f.amount) - (Number(f.early_payment_discount_applied) || 0);
    if (!f.ocr_amount || !f.receipt_url || ocr <= esperado) return [`trigger de saldo a favor: nada (comprobante ${cop(f.ocr_amount)} ≤ lo esperado ${cop(esperado)})`];
    const cubiertos = m.de('payments').filter((o) => o.id !== f.id && o.school_id === f.school_id && o.receipt_url === f.receipt_url
        && !['rejected', 'cancelled', 'failed'].includes(o.status)).reduce((s, o) => s + Number(o.amount), 0);
    if (ocr <= esperado + cubiertos) return [`trigger de saldo a favor: nada (el mismo comprobante cubre otros cobros por ${cop(cubiertos)})`];
    if (ocr > 4 * (esperado + cubiertos)) return ['trigger de saldo a favor: nada (lectura dudosa, más de 4 veces lo esperado)'];
    let saldo = ocr - esperado - cubiertos;
    const lineas = [`trigger de saldo a favor: crearía ${cop(saldo)} en ${corto(f.id)}`];
    m.ajustes.push({ payment_id: f.id, origin: 'saldo_a_favor', kind: 'saldo_a_favor', amount: saldo });
    const quien = dueno(f);
    const candidatos = m.de('payments').filter((x) => x.school_id === f.school_id && ['pending', 'overdue'].includes(x.status)
        && !(Number(x.amount_paid) > 0) && !(Number(x.early_payment_discount_applied) > 0) && dueno(x) === quien)
        .sort((a, b) => String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
    for (const x of candidatos) {
        if (saldo <= 0) break;
        const disc = Number(x.discount_amount) || 0;
        const list = x.list_amount != null ? Number(x.list_amount) : Number(x.amount) + disc - (Number(x.late_fee_amount) || 0);
        const v = Math.min(saldo, list - disc);
        if (!(v > 0)) continue;
        const nuevo = Number(x.amount) - v;
        lineas.push(`  … y lo descontaría de ${corto(x.id)} «${String(x.concept).slice(0, 50)}»: ${cop(x.amount)} → ${cop(nuevo)}`);
        m.aplicar('payments', x.id, { amount: nuevo, list_amount: list, discount_amount: disc + v, ...(nuevo === 0 ? { status: 'paid' } : {}) });
        m.ajustes.push({ payment_id: x.id, origin: 'saldo_a_favor', kind: 'descuento', amount: v });
        saldo -= v;
    }
    if (saldo > 0) lineas.push(`  … quedan ${cop(saldo)} disponibles para el próximo cobro del deportista`);
    return lineas;
}

// ─── Carga ──────────────────────────────────────────────────────────────────
async function cargar(sb: any, plan: Plan, casos: Caso[]): Promise<Memoria> {
    const m = new Memoria();
    const ids: Record<Tabla, Set<string>> = {
        payments: new Set(), enrollments: new Set(), unregistered_athletes: new Set(), children: new Set(), whatsapp_inbound_queue: new Set(),
    };
    const atletas: Fila[] = [];
    const crids: string[] = [];
    const esId = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x);
    for (const caso of casos) {
        for (const p of caso.pasos) {
            for (const k of ['cobro', 'desde', 'hacia']) if (esId(p[k])) ids.payments.add(p[k]);
            for (const x of p.cobros ?? []) if (esId(x)) ids.payments.add(x);
            if (esId(p.despues_de)) ids.payments.add(p.despues_de);
            if (esId(p.inscripcion)) ids.enrollments.add(p.inscripcion);
            if (esId(p.cola)) ids.whatsapp_inbound_queue.add(p.cola);
            if (p.tabla && esId(p.id)) ids[p.tabla as Tabla]?.add(p.id);
            if (p.atleta) atletas.push(p.atleta);
            if (p.ref) crids.push(uuidEstable(`${plan.escuela}:${plan.id}:${caso.clave}:${p.ref}`));
        }
    }
    for (const [tabla, set] of Object.entries(ids) as [Tabla, Set<string>][]) {
        if (!set.size) continue;
        const { data, error } = await sb.from(tabla).select('*').in('id', [...set]);
        if (error) throw new Error(`${tabla}: ${error.message}`);
        for (const f of data ?? []) m.put(tabla, f);
    }
    // Cobros de cada deportista del plan (dueño del saldo a favor, índices únicos, lo que queda abierto).
    const porCol: Record<string, Set<string>> = { child_id: new Set(), user_id: new Set(), unregistered_athlete_id: new Set() };
    for (const f of m.de('payments')) for (const s of SUJETO) if (f[s]) porCol[s].add(f[s]);
    for (const a of atletas) porCol[a.type === 'child' ? 'child_id' : a.type === 'adult' ? 'user_id' : 'unregistered_athlete_id'].add(a.id);
    for (const [col, set] of Object.entries(porCol)) {
        if (!set.size) continue;
        const { data, error } = await sb.from('payments').select('*').eq('school_id', plan.escuela).in(col, [...set]);
        if (error) throw new Error(`payments.${col}: ${error.message}`);
        for (const f of data ?? []) if (!m.get('payments', f.id)) m.put('payments', f);
    }
    // Comprobantes que se mueven o se ligan: ¿su huella o referencia ya están en otro cobro?
    const huellas = new Set<string>(); const referencias = new Set<string>(); const archivos = new Set<string>();
    for (const caso of casos) for (const p of caso.pasos) {
        if (p.sha256) huellas.add(p.sha256);
        if (p.ocr_reference) referencias.add(p.ocr_reference);
        if (p.esperado?.sha) huellas.add(p.esperado.sha);
        if (p.esperado?.referencia) referencias.add(p.esperado.referencia);
    }
    for (const f of m.de('payments')) if (f.receipt_url && f.status === 'awaiting_approval') archivos.add(f.receipt_url);
    const extras: Array<[string, string[]]> = [['receipt_image_sha256', [...huellas]], ['ocr_reference', [...referencias]], ['receipt_url', [...archivos]]];
    for (const [col, vals] of extras) {
        if (!vals.length) continue;
        const { data, error } = await sb.from('payments').select('*').eq('school_id', plan.escuela).in(col, vals);
        if (error) throw new Error(`payments.${col}: ${error.message}`);
        for (const f of data ?? []) if (!m.get('payments', f.id)) m.put('payments', f);
    }
    // Inscripciones de cada deportista (para corregir_valor).
    for (const [col, set] of Object.entries(porCol)) {
        if (!set.size) continue;
        const { data } = await sb.from('enrollments').select('*').eq('school_id', plan.escuela).in(col, [...set]);
        for (const f of data ?? []) if (!m.get('enrollments', f.id)) m.put('enrollments', f);
    }
    await recargarRastro(sb, plan, m, m.de('payments').map((f) => f.id));
    if (crids.length) {
        const { data, error } = await sb.from('charge_batches').select('id, client_request_id, status, created_at').eq('school_id', plan.escuela).in('client_request_id', crids);
        if (error) throw new Error(`charge_batches: ${error.message}`);
        for (const l of data ?? []) m.lotes.set(l.client_request_id, l);
        const lotes = (data ?? []).map((l: Fila) => l.id);
        if (lotes.length) {
            const { data: pagos } = await sb.from('payments').select('*').eq('school_id', plan.escuela).in('charge_batch_id', lotes);
            for (const f of pagos ?? []) m.put('payments', f);
        }
    }
    return m;
}

async function recargarRastro(sb: any, plan: Plan, m: Memoria, pagos: string[]): Promise<void> {
    const reales = pagos.filter((x) => !x.startsWith('nuevo'));
    if (!reales.length) return;
    const [{ data: corr, error: e1 }, { data: adj, error: e2 }, { data: aud, error: e3 }] = await Promise.all([
        sb.from('payment_corrections').select('*').in('payment_id', reales),
        sb.from('payment_adjustments').select('id, payment_id, kind, origin, reason_code, amount, charge_batch_id, reverts_id').in('payment_id', reales),
        sb.from('audit_logs').select('record_id, new_data').eq('school_id', plan.escuela).eq('action', 'resolver_cobros_auditados')
            .eq('table_name', 'payments').in('record_id', reales),
    ]);
    if (e1 || e2 || e3) throw new Error(`rastro: ${(e1 ?? e2 ?? e3).message}`);
    m.correcciones = [...m.correcciones.filter((x) => !reales.includes(x.payment_id)), ...(corr ?? [])];
    m.ajustes = [...m.ajustes.filter((x) => !reales.includes(x.payment_id)), ...(adj ?? [])];
    for (const a of aud ?? []) if (a.new_data?._paso === 'corregir_valor') m.nuestras.add(a.record_id);
}

// ─── Escritura (solo con --aplicar) ─────────────────────────────────────────
async function ejecutar(sb: any, c: Ctx, paso: Paso, acciones: Accion[]): Promise<string | null> {
    if (!APLICAR || !c.real) throw new Error('ejecutar() sin --aplicar');
    const auditar = (tabla: string, record: string, antes: Fila | null, nuevo: Fila) => sb.from('audit_logs').insert({
        school_id: c.plan.escuela, profile_id: c.plan.actor, table_name: tabla, record_id: record,
        action: 'resolver_cobros_auditados', old_data: antes,
        new_data: { ...nuevo, _paso: paso.accion, _caso: c.caso.clave, _plan: c.plan.id, _motivo: c.plan.motivo },
    } as never);
    for (const a of acciones) {
        if (a.tipo === 'update') {
            const { error: ea } = await auditar(a.tabla, a.id, a.antes, a.patch);
            if (ea) return `audit_logs: ${ea.message}`;
            let q: any = sb.from(a.tabla).update(a.patch as never).eq('id', a.id);
            for (const [k, v] of Object.entries(a.filtro)) q = v === null ? q.is(k, null) : q.eq(k, v);
            const { data, error } = await q.select('*');
            if (error) return `${a.tabla} ${corto(a.id)}: ${error.message}`;
            if (!data?.length) return `${a.tabla} ${corto(a.id)}: la fila cambió mientras tanto (0 filas)`;
            c.m.put(a.tabla, data[0]);
        } else if (a.tipo === 'insert_correccion') {
            const { error: ea } = await auditar('payment_corrections', a.fila.payment_id, null, a.fila);
            if (ea) return `audit_logs: ${ea.message}`;
            const { data, error } = await sb.from('payment_corrections').insert(a.fila as never).select('*');
            if (error) return `payment_corrections: ${error.message}`;
            c.m.correcciones = [...c.m.correcciones.filter((x) => x.id !== 'nuevo'), ...(data ?? [])];
        } else {
            const { preview_hash, ...resto } = a.args;
            const args = {
                p_school_id: resto.p_school_id, p_actor: resto.p_actor, p_client_request_id: a.crid, p_mode: 'single',
                p_target: { kind: 'athlete', ids: resto.p_athletes.map((x: Fila) => x.id) },
                p_athletes: resto.p_athletes, p_lines: resto.p_lines, p_overrides: [], p_notify: false,
                p_preview_hash: preview_hash, p_pending: resto.p_pending, p_global_discount: null, p_payment: null,
                ...(resto.p_new_athlete ? { p_new_athlete: resto.p_new_athlete } : {}),
            };
            const { error: ea } = await sb.from('audit_logs').insert({
                school_id: c.plan.escuela, profile_id: c.plan.actor, table_name: 'charge_batches', record_id: a.crid,
                action: 'resolver_cobros_auditados', old_data: null,
                new_data: { _paso: paso.accion, _caso: c.caso.clave, _plan: c.plan.id, lineas: resto.p_lines, pendientes: resto.p_pending, atleta_nuevo: resto.p_new_athlete ? { ...resto.p_new_athlete, guardian_phone: '••' } : null },
            } as never);
            if (ea) return `audit_logs: ${ea.message}`;
            const { data, error } = await sb.rpc('create_charge_batch', args);
            if (error) return `create_charge_batch: ${error.message}${error.details ? ` (${String(error.details).slice(0, 300)})` : ''}`;
            const r = (data ?? {}) as Fila;
            c.m.lotes.set(a.crid, { id: r.batch_id, client_request_id: a.crid });
            if (paso.accion === 'crear_cobro') {
                const nuevo = (r.payment_ids ?? [])[0];
                if (!nuevo) return `create_charge_batch no devolvió el cobro (lote ${corto(r.batch_id)}, duplicado ${r.duplicated})`;
                const { data: f } = await sb.from('payments').select('*').eq('id', nuevo).maybeSingle();
                if (!f) return `no encuentro el cobro ${corto(nuevo)} recién creado`;
                c.m.filas.delete(`payments:nuevo:${a.ref}`);
                c.m.put('payments', f);
                c.m.refs.set(a.ref, f.id);
            } else if (a.cobro) {
                const { data: f } = await sb.from('payments').select('*').eq('id', a.cobro).maybeSingle();
                if (f) c.m.put('payments', f);
                await recargarRastro(sb, c.plan, c.m, [a.cobro]);
            }
        }
    }
    return null;
}

// ─── Principal ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
    if (!ESCUELA || !PLAN) {
        console.error('Uso: npx tsx scripts/resolver-cobros-auditados.ts --escuela <school_id> --plan <plan.json> [--aplicar] [--solo <clave>] [--incluir-propuestas]');
        process.exit(1);
    }
    const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8')) as Plan;
    if (plan.escuela !== ESCUELA) throw new Error(`El plan es de la escuela ${plan.escuela}, no de ${ESCUELA}`);
    if (!plan.id || !plan.actor || !plan.motivo || !plan.paso_aviso || !Array.isArray(plan.casos)) throw new Error('El plan necesita id, actor, motivo, paso_aviso y casos');
    const casos = plan.casos.filter((x) => !SOLO || x.clave === SOLO);
    if (!casos.length) throw new Error(SOLO ? `No hay caso con clave ${SOLO}` : 'El plan no trae casos');

    const { supabase: cliente } = await import('../src/config/supabase');
    const sb: any = cliente;
    const { data: escuela } = await sb.from('schools').select('id, name').eq('id', ESCUELA).maybeSingle();
    if (!escuela) throw new Error(`Escuela ${ESCUELA} no existe`);
    const { data: actor } = await sb.from('profiles').select('id, full_name, role').eq('id', plan.actor).maybeSingle();
    if (!actor) throw new Error(`actor ${plan.actor} no es un perfil`);

    let m = await cargar(sb, plan, casos);
    const fuera = m.de('payments').filter((f) => f.school_id && f.school_id !== ESCUELA);
    if (fuera.length) throw new Error(`Cobros de OTRA escuela en el plan: ${fuera.map((f) => corto(f.id)).join(', ')}`);

    console.log(`${APLICAR ? 'APLICANDO' : 'SIMULACIÓN (no escribe nada; las vistas previas de «Cobros y pagos» son STABLE)'} · ${escuela.name} · ${casos.length} caso(s) · actor ${actor.full_name} (${actor.role})`);
    console.log(`Plan: ${PLAN} · ${new Date().toISOString()}\nMotivo: ${plan.motivo}\n`);

    // Casos ya empezados por una corrida anterior de este plan (para no exigir de nuevo las precondiciones).
    const { data: rastros, error: eRastro } = await sb.from('audit_logs').select('new_data')
        .eq('school_id', ESCUELA).eq('action', 'resolver_cobros_auditados').eq('new_data->>_plan', plan.id).limit(1000);
    if (eRastro) throw new Error(`audit_logs: ${eRastro.message}`);
    const empezados = new Set<string>(((rastros ?? []) as Fila[]).map((r) => r.new_data?._caso).filter(Boolean));
    const iniciadoEn = (caso: Caso) => empezados.has(caso.clave) || caso.pasos.some((p) => {
        if (p.accion !== 'aprobar') return false;
        const id = resolver(m, p.cobro);
        const f = id ? m.get('payments', id) : undefined;
        return f?.status === 'paid' && f?.approved_by === plan.actor;
    });

    const aprobaciones: ItemAprobacion[] = [];
    const resumen = { listos: 0, aplicados: 0, yaHechos: 0, saltados: 0, fallidos: 0, propuestas: 0 };
    let escrituras = 0;

    for (const caso of casos) {
        console.log('═'.repeat(100));
        const propuesta = caso.estado === 'propuesta';
        console.log(`${caso.nombre} [${caso.clave}]${propuesta ? ' · PROPUESTA' : ''}${caso.certeza ? ` · certeza ${caso.certeza}` : ''}`);
        const aplicaEste = APLICAR && (!propuesta || CON_PROPUESTAS);
        if (APLICAR && !aplicaEste) {
            console.log('  ⏸ Propuesta: no se aplica sin --incluir-propuestas. Se simula para revisar.');
            resumen.propuestas++;
        }

        // 1) Pasada en seco sobre una copia (también con --aplicar): un caso con conflicto no escribe nada.
        const seco = m.clonar();
        const iniciado = iniciadoEn(caso);
        const cs: Ctx = { sb, plan, caso, m: seco, real: false, aprobaciones: [], iniciado };
        let conflicto = false;
        let pendientes = 0;
        const lineas: string[] = [];
        for (const [i, paso] of caso.pasos.entries()) {
            const r = await evaluar(paso, cs);
            const marca = r.estado === 'hecho' ? '✓' : r.estado === 'conflicto' ? '✗ CONFLICTO' : r.estado === 'espera' ? '…' : '→';
            lineas.push(`  ${String(i + 1).padStart(2)}. ${paso.accion.padEnd(26)} ${marca} ${r.detalle}`);
            for (const a of r.acciones) {
                if (a.tipo === 'update') lineas.push(`        UPDATE ${a.tabla} ${corto(a.id)} SET ${describir(a.patch)}  WHERE ${describir(a.filtro)}`);
                else if (a.tipo === 'insert_correccion') lineas.push(`        INSERT payment_corrections (${describir({ payment_id: corto(a.fila.payment_id), kind: a.fila.kind, amount_before: a.fila.amount_before, amount_after: a.fila.amount_after, status_before: a.fila.status_before, enrollment_id: corto(a.fila.enrollment_id), created_by: corto(a.fila.created_by) })})`);
                else lineas.push(`        RPC create_charge_batch (client_request_id ${a.crid}, preview_hash ${String(a.args.preview_hash).slice(0, 10)}…)`);
            }
            for (const x of r.extra ?? []) lineas.push(`        ${x}`);
            if (r.estado === 'pendiente') pendientes++;
            if (r.estado === 'conflicto') { conflicto = true; break; }
        }
        for (const l of lineas) console.log(l);
        if (conflicto) {
            console.log('  ⛔ Caso SALTADO: el estado no es el auditado. No se escribió nada de este caso.');
            resumen.saltados++;
            continue;
        }
        if (!aplicaEste) {
            // Con --aplicar, un caso que no se aplica (propuesta) no entra a la lista real de aprobación.
            if (!APLICAR) aprobaciones.push(...cs.aprobaciones);
            if (propuesta && !APLICAR) resumen.propuestas++;
            else if (!propuesta) { if (pendientes) resumen.listos++; else resumen.yaHechos++; }
            if (!APLICAR) m = seco; // la simulación sigue sobre lo simulado (casos que comparten filas)
            if (caso.mensaje) {
                console.log(`  Mensaje propuesto (NO se envía) → ${caso.mensaje.para}`);
                console.log(`    Canal: ${caso.mensaje.canal}`);
                console.log(`    «${caso.mensaje.texto}»`);
            }
            continue;
        }

        // 2) Pasada real, paso a paso: evaluar sobre lo vivo y escribir.
        const cr: Ctx = { sb, plan, caso, m, real: true, aprobaciones: [], iniciado };
        let fallo: string | null = null;
        for (const [i, paso] of caso.pasos.entries()) {
            const r = await evaluar(paso, cr);
            if (r.estado === 'conflicto') { fallo = `paso ${i + 1} (${paso.accion}): ${r.detalle}`; break; }
            if (r.estado !== 'pendiente' || !r.acciones.length) {
                if (r.estado === 'espera') console.log(`  … paso ${i + 1}: ${r.detalle}`);
                continue;
            }
            const e = await ejecutar(sb, cr, paso, r.acciones);
            if (e) { fallo = `paso ${i + 1} (${paso.accion}): ${e}`; break; }
            escrituras += r.acciones.length;
            console.log(`  ✓ paso ${i + 1} escrito: ${r.detalle}`);
        }
        aprobaciones.push(...cr.aprobaciones);
        if (fallo) {
            console.log(`  ✗ FALLÓ: ${fallo}\n    Lo escrito hasta acá está en audit_logs (resolver_cobros_auditados). Corregir y volver a correr: lo hecho se reconoce.`);
            resumen.fallidos++;
            continue;
        }
        resumen.aplicados++;
    }

    // Lista para aprobar-pagos-auditados.ts (mismo formato).
    const salida = PLAN.replace(/\.json$/i, '') + (APLICAR ? '-aprobar.json' : '-aprobar.simulacion.json');
    const lista = {
        escuela: plan.escuela, aprobadoPor: plan.actor, paso: plan.paso_aviso,
        items: aprobaciones.map(({ _caso, ...x }) => x),
    };
    // Con --aplicar, una lista vacía no pisa la que ya se usó para aprobar (queda como registro).
    if (!(APLICAR && !lista.items.length && fs.existsSync(salida))) fs.writeFileSync(salida, JSON.stringify(lista, null, 2));

    console.log('═'.repeat(100));
    console.log(`Casos: ${resumen.listos} listos para aplicar · ${resumen.aplicados} aplicados · ${resumen.yaHechos} ya estaban · ${resumen.saltados} saltados · ${resumen.fallidos} fallidos${resumen.propuestas ? ` · ${resumen.propuestas} propuesta(s) (solo con --incluir-propuestas)` : ''}`);
    if (APLICAR) console.log(`Escrituras: ${escrituras} (cada una con su audit_logs; los lotes dejan además charge_batch_created)`);
    console.log(`Lista de aprobación (${lista.items.length}): ${path.resolve(salida)}`);
    for (const it of aprobaciones) console.log(`  · [${it._caso}] ${String(it.pago).startsWith('nuevo') ? it.pago : corto(it.pago)} ${it.tipo} ${cop(it.monto)}${it.texto ? ' · con texto (ventana)' : ''}`);
    if (!APLICAR) console.log('\n(SIMULACIÓN: no se escribió nada. Siguiente: --aplicar; después aprobar-pagos-auditados.ts con la lista -aprobar.json; después este script --aplicar otra vez.)');
    else if (lista.items.length) console.log(`\nSiguiente: npx tsx scripts/aprobar-pagos-auditados.ts --archivo ${path.resolve(salida)}  (simula; luego --aplicar). Después, este script --aplicar otra vez para las verificaciones.`);
}

main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
});
