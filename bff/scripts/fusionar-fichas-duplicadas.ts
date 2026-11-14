/**
 * fusionar-fichas-duplicadas — une dos identidades de la MISMA persona dentro de UNA escuela,
 * siguiendo un plan que una persona ya revisó caso por caso. Simula por defecto.
 *
 *   npx tsx scripts/fusionar-fichas-duplicadas.ts --escuela <school_id> --plan <plan.json>              # simulación
 *   npx tsx scripts/fusionar-fichas-duplicadas.ts --escuela <school_id> --plan <plan.json> --aplicar    # escribe
 *   ... --solo <clave>      una sola persona del plan
 *
 * Nació el 2026-11-08 con Monster: la lista de Mixto del 4-nov creó fichas sin cuenta con sus
 * cobros, y el 6-nov las mismas personas entraron por solicitud de unión con otro plan y otro
 * cobro. Receta probada en Dynasty (scripts/dynasty-fusion-identidades-2026-08-12.sql y la memoria
 * project_duplicate_athlete_identities): sobrevive la identidad que puede entrar y pagar (adulto o
 * acudiente) o la que tiene el pago real; la otra se cierra sin borrarse.
 *
 * El script NO decide nada: ejecuta los pasos del plan, en su orden, y cada uno verifica antes de
 * escribir que la fila esté como se auditó. Por persona:
 *   · si TODOS los pasos están «pendiente» o «ya aplicado», la persona corre;
 *   · si alguno encuentra un estado distinto (alguien aprobó, movió o anuló algo en el medio),
 *     la persona entera se salta y se avisa. Nunca se aplica media fusión a sabiendas.
 * Volver a correrlo es seguro: lo ya hecho se reconoce y no se repite.
 *
 * Pasos (campo `accion`):
 *   trasplantar_inscripcion  inscripcion, esperado{}, cambios{}            completa la inscripción que sobrevive
 *   anular_cobro             cobro, esperado{}, nota                        status='cancelled' (nunca un `paid`)
 *   reapuntar_cobro          cobro, esperado{}, hacia{tipo,id}              mueve el cobro al sobreviviente
 *   mover_comprobante        desde, hacia, sha256, estado_destino_*         el comprobante sigue al cobro correcto
 *   reapuntar_inscripcion    inscripcion, esperado{}, hacia{}, cambios{}    (doble categoría: no se cancela)
 *   cancelar_inscripcion     inscripcion, esperado{}                        status='cancelled', end_date=hoy
 *   reapuntar_fila           tabla, id, cambios{col:{de,a}}                 otras tablas con punteros
 *   completar_vacios         tabla, id, campos{}                            solo donde hoy hay NULL
 *   verificar                tabla, id, esperado{}                          afirma un estado, no escribe
 *   cerrar_ficha             tipo('unregistered'|'child'), id, linked_profile_id?
 *
 * El orden importa y es el del plan. Lo que este script exige por su cuenta:
 *   · `anular_cobro` del duplicado ANTES de mover otro cobro del mismo mes al sobreviviente:
 *     `uniq_payment_active_period_per_child|adult|unreg` revienta si no (se comprueba en memoria).
 *   · `mover_comprobante` solo desde un cobro ya anulado: `uq_payments_school_receipt_hash`
 *     ignora los anulados, y `uq_payments_school_ocr_reference` NO (por eso la referencia se
 *     suelta del origen antes de ponerla en el destino).
 *   · `cancelar_inscripcion` / `cerrar_ficha` solo cuando la identidad que se va ya no tiene cobros
 *     abiertos: el trigger fn_cancel_payments_on_enrollment_cancel los anularía en silencio.
 *
 * Cada escritura deja antes su fila en `audit_logs` (actor = `actor` del plan, acción
 * `merge_athlete_identities`), con el estado anterior y lo que se cambia.
 *
 * No aprueba comprobantes ni avisa a nadie: la aprobación va con scripts/aprobar-pagos-auditados.ts.
 */
import fs from 'node:fs';

function arg(nombre: string): string | null {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const ESCUELA = arg('--escuela');
const PLAN = arg('--plan');
const SOLO = arg('--solo');
const APLICAR = process.argv.includes('--aplicar');

/** Estados que cuenta el índice único de un cobro por período (y que «tienen deuda o plata»). */
const VIVOS_PERIODO = ['pending', 'awaiting_approval', 'paid', 'partial', 'overdue', 'glosado'];
const ABIERTOS = ['pending', 'awaiting_approval', 'overdue', 'partial', 'glosado'];
/** Columnas del comprobante que viajan con él de un cobro a otro. */
const RECIBO = [
    'receipt_url', 'receipt_image_sha256', 'receipt_image_sha256_source', 'receipt_reference_norm',
    'receipt_submitted_at', 'receipt_verdict', 'receipt_verdict_at', 'receipt_verdict_reasons',
    'ocr_amount', 'ocr_bank', 'ocr_currency', 'ocr_date', 'ocr_time', 'ocr_destination',
    'ocr_destination_name', 'ocr_origin_name', 'ocr_provider', 'ocr_raw_response', 'ocr_reference',
] as const;
/** Datos del pago que trae el comprobante; en el destino solo se llenan si están vacíos. */
const RECIBO_PAGO = ['payment_method', 'payment_date'] as const;
const SUJETO = ['child_id', 'user_id', 'unregistered_athlete_id'] as const;

type Fila = Record<string, any>;
type Tabla = 'payments' | 'enrollments' | 'unregistered_athletes' | 'children' | 'profiles'
    | 'school_members' | 'school_join_requests' | 'whatsapp_inbound_queue';
interface Paso { accion: string; [k: string]: any }
interface Persona {
    clave: string; nombre: string; clasificacion?: string;
    sobrevive: { tipo: 'adult' | 'child' | 'unregistered'; id: string };
    absorbe: { tipo: 'adult' | 'child' | 'unregistered'; id: string };
    pasos: Paso[];
    aprobacion_posterior?: { cobro: string; tipo: string; monto: number; previo: string | null } | null;
    aviso_propuesto?: { para: string; cuando: string; texto: string } | null;
    conflictos_para_la_escuela?: string[];
    decisiones_pendientes?: string[];
}
interface Plan { escuela: string; actor: string; motivo: string; personas: Persona[] }
interface Escritura {
    tabla: Tabla; id: string;
    /** Condiciones extra del UPDATE (además de id): si la fila cambió, no se escribe. */
    filtro: Fila;
    patch: Fila;
    antes: Fila;
}
type Estado = 'pendiente' | 'hecho' | 'conflicto';
interface Resultado { estado: Estado; detalle: string; escrituras: Escritura[] }

const cop = (n: unknown) => (n === null || n === undefined ? '—' : `$${Math.round(Number(n)).toLocaleString('es-CO').replace(/,/g, '.')}`);
const corto = (id: unknown) => String(id ?? '—').slice(0, 8);
const hoyBogota = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const igual = (a: unknown, b: unknown) => {
    if (a === null || a === undefined) return b === null || b === undefined;
    if (b === null || b === undefined) return false;
    if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
    return String(a) === String(b);
};
const sub = (f: Fila, cols: readonly string[]) => Object.fromEntries(cols.map((c) => [c, f[c] ?? null]));
const describir = (patch: Fila) => Object.entries(patch)
    .map(([k, v]) => `${k}=${v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 60)}`)
    .join(', ');

// ─── Estado en memoria: la simulación aplica cada paso sobre esta copia ──────
class Memoria {
    filas = new Map<string, Fila>();
    clave(t: Tabla, id: string) { return `${t}:${id}`; }
    get(t: Tabla, id: string): Fila | undefined { return this.filas.get(this.clave(t, id)); }
    put(t: Tabla, f: Fila) { this.filas.set(this.clave(t, f.id), { ...f }); }
    aplicar(t: Tabla, id: string, patch: Fila) {
        const f = this.get(t, id);
        if (f) this.filas.set(this.clave(t, id), { ...f, ...patch });
    }
    de(t: Tabla): Fila[] { return [...this.filas.entries()].filter(([k]) => k.startsWith(`${t}:`)).map(([, v]) => v); }
    foto() { return new Map([...this.filas.entries()].map(([k, v]) => [k, { ...v }])); }
    restaurar(f: Map<string, Fila>) { this.filas = f; }
}

function difiere(fila: Fila | undefined, esperado: Fila): string[] {
    if (!fila) return ['la fila no existe'];
    return Object.entries(esperado)
        .filter(([k, v]) => !igual(fila[k], v))
        .map(([k, v]) => `${k}: auditado ${v === null ? 'NULL' : v}, hoy ${fila[k] ?? 'NULL'}`);
}

/** Columnas de sujeto de un cobro/inscripción hacia el sobreviviente. */
function sujetoHacia(hacia: { tipo: string; id: string }): Fila {
    if (hacia.tipo === 'child') return { child_id: hacia.id, user_id: null, unregistered_athlete_id: null };
    if (hacia.tipo === 'adult') return { child_id: null, user_id: hacia.id, unregistered_athlete_id: null };
    return { child_id: null, user_id: null, unregistered_athlete_id: hacia.id };
}
function esDelSujeto(f: Fila, tipo: string, id: string): boolean {
    if (tipo === 'child') return f.child_id === id;
    if (tipo === 'adult') return f.user_id === id && !f.child_id;
    return f.unregistered_athlete_id === id;
}

// ─── Evaluación de cada paso (pura: lee y escribe solo la memoria) ───────────
function evaluar(p: Paso, m: Memoria, actor: string): Resultado {
    const ok = (detalle: string, escrituras: Escritura[] = []): Resultado => ({ estado: 'pendiente', detalle, escrituras });
    const hecho = (detalle: string): Resultado => ({ estado: 'hecho', detalle, escrituras: [] });
    const choque = (detalle: string): Resultado => ({ estado: 'conflicto', detalle, escrituras: [] });
    const esc = (tabla: Tabla, id: string, filtro: Fila, patch: Fila): Escritura => {
        const antes = m.get(tabla, id) ?? {};
        m.aplicar(tabla, id, patch);
        return { tabla, id, filtro, patch, antes: sub(antes, Object.keys({ ...filtro, ...patch })) };
    };

    switch (p.accion) {
        case 'verificar': {
            const d = difiere(m.get(p.tabla, p.id), p.esperado);
            return d.length ? choque(`${p.tabla} ${corto(p.id)} cambió: ${d.join('; ')}`) : hecho(`${p.tabla} ${corto(p.id)} sigue como se auditó`);
        }

        case 'trasplantar_inscripcion': {
            const f = m.get('enrollments', p.inscripcion);
            if (!f) return choque(`inscripción ${corto(p.inscripcion)} no existe`);
            if (difiere(f, p.cambios).length === 0) return hecho(`inscripción ${corto(p.inscripcion)} ya tiene ${describir(p.cambios)}`);
            const d = difiere(f, p.esperado);
            if (d.length) return choque(`inscripción ${corto(p.inscripcion)} cambió: ${d.join('; ')}`);
            const e = esc('enrollments', p.inscripcion, { ...p.esperado }, { ...p.cambios });
            return ok(`inscripción ${corto(p.inscripcion)}: ${describir(p.cambios)}`, [e]);
        }

        case 'anular_cobro': {
            const f = m.get('payments', p.cobro);
            if (!f) return choque(`cobro ${corto(p.cobro)} no existe`);
            if (p.esperado?.status === 'paid' || ['paid', 'partial'].includes(f.status)) {
                return choque(`cobro ${corto(p.cobro)} tiene plata (${f.status}): un pago se MUEVE, nunca se anula`);
            }
            if (f.status === 'cancelled') return hecho(`cobro ${corto(p.cobro)} ya está anulado`);
            const d = difiere(f, p.esperado);
            if (d.length) return choque(`cobro ${corto(p.cobro)} cambió: ${d.join('; ')}`);
            const notas = [f.notes, p.nota].filter(Boolean).join(' | ').slice(0, 1000);
            const e = esc('payments', p.cobro, { ...p.esperado }, { status: 'cancelled', notes: notas });
            return ok(`anular ${corto(p.cobro)} ${cop(f.amount)} ${f.period_year}-${f.period_month} (${f.status} → cancelled)`, [e]);
        }

        case 'reapuntar_cobro': {
            const f = m.get('payments', p.cobro);
            if (!f) return choque(`cobro ${corto(p.cobro)} no existe`);
            const destino = sujetoHacia(p.hacia);
            if (difiere(f, destino).length === 0) return hecho(`cobro ${corto(p.cobro)} ya es de ${p.hacia.tipo} ${corto(p.hacia.id)}`);
            const d = difiere(f, p.esperado);
            if (d.length) return choque(`cobro ${corto(p.cobro)} cambió: ${d.join('; ')}`);
            // Índice único por período: el sobreviviente no puede tener otro cobro vivo del mismo mes.
            if (VIVOS_PERIODO.includes(f.status) && !f.period_uniqueness_exempt && f.period_year && f.period_month) {
                const gemelo = m.de('payments').find((o) => o.id !== f.id && o.school_id === f.school_id
                    && esDelSujeto(o, p.hacia.tipo, p.hacia.id)
                    && o.period_year === f.period_year && o.period_month === f.period_month
                    && VIVOS_PERIODO.includes(o.status) && !o.period_uniqueness_exempt);
                if (gemelo) {
                    return choque(`el sobreviviente ya tiene ${corto(gemelo.id)} (${gemelo.status}) de ${f.period_year}-${f.period_month}: anúlalo antes o el índice revienta`);
                }
            }
            const patch: Fila = { ...destino };
            if (p.hacia.tipo === 'child') {
                // Mismo criterio que migrate_unregistered_athlete_to_profile: el cobro hereda el acudiente.
                const hijo = m.get('children', p.hacia.id);
                if (!f.parent_id && hijo?.parent_id) patch.parent_id = hijo.parent_id;
            }
            const filtro: Fila = { status: f.status };
            for (const c of SUJETO) filtro[c] = f[c] ?? null;
            const e = esc('payments', p.cobro, filtro, patch);
            return ok(`mover ${corto(p.cobro)} ${cop(f.amount)} ${f.period_year}-${f.period_month} (${f.status}) → ${p.hacia.tipo} ${corto(p.hacia.id)}`, [e]);
        }

        case 'mover_comprobante': {
            // Cuatro escrituras, en este orden, para que un corte a mitad de camino se pueda retomar:
            //   A destino ← comprobante (sin la referencia) [+ estado final]
            //   B origen  ← suelta la referencia            (uq_payments_school_ocr_reference no mira el estado)
            //   C destino ← la referencia                   (la del plan: si B ya corrió, el origen ya no la tiene)
            //   D origen  ← sin comprobante + nota de a dónde se fue
            const o = m.get('payments', p.desde);
            const t = m.get('payments', p.hacia);
            if (!o || !t) return choque(`cobro ${corto(o ? p.hacia : p.desde)} no existe`);
            const sha = p.sha256 as string;
            const ref: string | null = p.ocr_reference ?? null;
            const final = p.estado_destino_final ?? p.estado_destino_esperado;
            const oTiene = o.receipt_image_sha256 === sha;
            const tInicial = !t.receipt_image_sha256 && t.status === p.estado_destino_esperado;
            const tEnCurso = t.receipt_image_sha256 === sha;
            if (tEnCurso && !oTiene && !o.ocr_reference && igual(t.ocr_reference, ref) && t.status === final) {
                return hecho(`el comprobante ya está en ${corto(p.hacia)}`);
            }
            if (o.status !== 'cancelled') return choque(`el origen ${corto(p.desde)} está en ${o.status}: hay que anularlo antes de mover el comprobante`);
            if (!tInicial && !tEnCurso) {
                return choque(t.receipt_image_sha256
                    ? `el destino ${corto(p.hacia)} ya tiene OTRO comprobante (${corto(t.receipt_image_sha256)})`
                    : `el destino ${corto(p.hacia)} está en ${t.status}, se auditó ${p.estado_destino_esperado}`);
            }
            if (tInicial && !oTiene) return choque(`el origen ${corto(p.desde)} ya no tiene el comprobante auditado (huella ${corto(o.receipt_image_sha256)})`);
            if (o.receipt_image_sha256 && !oTiene) return choque(`el origen ${corto(p.desde)} tiene otro comprobante (${corto(o.receipt_image_sha256)})`);
            if (o.ocr_reference && !igual(o.ocr_reference, ref)) return choque(`la referencia del origen es ${o.ocr_reference}, se auditó ${ref ?? 'ninguna'}`);
            if (tInicial && p.monto_comprobante != null && !igual(o.ocr_amount, p.monto_comprobante)) {
                return choque(`el comprobante de ${corto(p.desde)} dice ${cop(o.ocr_amount)}, se auditó ${cop(p.monto_comprobante)}`);
            }
            if (ref) {
                const otro = m.de('payments').find((x) => x.id !== o.id && x.id !== t.id && x.ocr_reference === ref);
                if (otro) return choque(`la referencia ${ref} ya está en otro cobro (${corto(otro.id)})`);
            }
            const escs: Escritura[] = [];
            if (tInicial) {
                const copia: Fila = {};
                for (const c of RECIBO) if (c !== 'ocr_reference' && o[c] !== null && o[c] !== undefined) copia[c] = o[c];
                for (const c of RECIBO_PAGO) if ((t[c] === null || t[c] === undefined) && o[c] !== null && o[c] !== undefined) copia[c] = o[c];
                if (p.estado_destino_final && p.estado_destino_final !== t.status) copia.status = p.estado_destino_final;
                escs.push(esc('payments', p.hacia, { status: t.status, receipt_image_sha256: null }, copia));
            }
            if (ref && o.ocr_reference === ref) escs.push(esc('payments', p.desde, { status: 'cancelled', ocr_reference: ref }, { ocr_reference: null }));
            if (ref && !igual(t.ocr_reference, ref)) escs.push(esc('payments', p.hacia, { receipt_image_sha256: sha, ocr_reference: null }, { ocr_reference: ref }));
            if (oTiene) {
                const suelta: Fila = {};
                for (const c of RECIBO) if (c !== 'ocr_reference' && o[c] !== null && o[c] !== undefined) suelta[c] = null;
                suelta.notes = [o.notes, `Comprobante movido a ${corto(p.hacia)} al unificar fichas (${hoyBogota()}).`].filter(Boolean).join(' | ').slice(0, 1000);
                escs.push(esc('payments', p.desde, { status: 'cancelled', receipt_image_sha256: sha }, suelta));
            }
            const estado = p.estado_destino_final && p.estado_destino_final !== t.status ? ` (${t.status} → ${p.estado_destino_final})` : ` (sigue ${t.status})`;
            return ok(`comprobante ${cop(o.ocr_amount ?? p.monto_comprobante)} (huella ${corto(sha)}, ref ${ref ?? '—'}): ${corto(p.desde)} → ${corto(p.hacia)}${estado}${tEnCurso ? ' · retomando un movimiento a medias' : ''}`, escs);
        }

        case 'reapuntar_inscripcion': {
            const f = m.get('enrollments', p.inscripcion);
            if (!f) return choque(`inscripción ${corto(p.inscripcion)} no existe`);
            const destino = { ...sujetoHacia(p.hacia), ...(p.cambios ?? {}) };
            const sinMarca = Object.fromEntries(Object.entries(destino).filter(([k]) => !['fee_set_at', 'fee_set_by'].includes(k)));
            if (difiere(f, sinMarca).length === 0) return hecho(`inscripción ${corto(p.inscripcion)} ya es de ${p.hacia.tipo} ${corto(p.hacia.id)}`);
            const d = difiere(f, p.esperado);
            if (d.length) return choque(`inscripción ${corto(p.inscripcion)} cambió: ${d.join('; ')}`);
            const choca = m.de('enrollments').find((o) => o.id !== f.id && o.status === 'active' && esDelSujeto(o, p.hacia.tipo, p.hacia.id)
                && ((f.team_id && o.team_id === f.team_id) || (f.offering_plan_id && o.offering_plan_id === f.offering_plan_id)));
            if (choca) return choque(`el sobreviviente ya tiene la inscripción activa ${corto(choca.id)} con el mismo equipo/plan`);
            const patch: Fila = { ...destino };
            if ('monthly_fee' in (p.cambios ?? {}) || 'fee_is_manual' in (p.cambios ?? {})) {
                patch.fee_set_by = actor;
                patch.fee_set_at = new Date().toISOString();
            }
            const filtro: Fila = { status: 'active' };
            for (const c of SUJETO) filtro[c] = f[c] ?? null;
            const e = esc('enrollments', p.inscripcion, filtro, patch);
            return ok(`inscripción ${corto(p.inscripcion)} → ${p.hacia.tipo} ${corto(p.hacia.id)}${p.cambios ? ` (${describir(p.cambios)})` : ''}`, [e]);
        }

        case 'cancelar_inscripcion': {
            const f = m.get('enrollments', p.inscripcion);
            if (!f) return choque(`inscripción ${corto(p.inscripcion)} no existe`);
            if (f.status === 'cancelled') return hecho(`inscripción ${corto(p.inscripcion)} ya está cancelada`);
            const d = difiere(f, p.esperado);
            if (d.length) return choque(`inscripción ${corto(p.inscripcion)} cambió: ${d.join('; ')}`);
            const sujeto = SUJETO.find((c) => f[c]);
            const abiertos = m.de('payments').filter((x) => sujeto && x[sujeto] === f[sujeto] && x.school_id === f.school_id && ABIERTOS.includes(x.status));
            if (abiertos.length) {
                return choque(`la identidad que se va aún tiene cobros abiertos (${abiertos.map((x) => `${corto(x.id)} ${x.status}`).join(', ')}): el trigger los anularía en silencio`);
            }
            const e = esc('enrollments', p.inscripcion, { ...p.esperado }, { status: 'cancelled', end_date: f.end_date ?? hoyBogota() });
            return ok(`cancelar inscripción ${corto(p.inscripcion)}`, [e]);
        }

        case 'reapuntar_fila': {
            const f = m.get(p.tabla, p.id);
            if (!f) return choque(`${p.tabla} ${corto(p.id)} no existe`);
            const a = Object.fromEntries(Object.entries(p.cambios as Record<string, { de: unknown; a: unknown }>).map(([k, v]) => [k, v.a]));
            const de = Object.fromEntries(Object.entries(p.cambios as Record<string, { de: unknown; a: unknown }>).map(([k, v]) => [k, v.de]));
            if (difiere(f, a).length === 0) return hecho(`${p.tabla} ${corto(p.id)} ya apunta al sobreviviente`);
            const d = difiere(f, de);
            if (d.length) return choque(`${p.tabla} ${corto(p.id)} cambió: ${d.join('; ')}`);
            const e = esc(p.tabla, p.id, de, a);
            return ok(`${p.tabla} ${corto(p.id)}: ${Object.entries(p.cambios).map(([k, v]: [string, any]) => `${k} ${corto(v.de)} → ${corto(v.a)}`).join(', ')}`, [e]);
        }

        case 'completar_vacios': {
            const f = m.get(p.tabla, p.id);
            if (!f) return choque(`${p.tabla} ${corto(p.id)} no existe`);
            const patch: Fila = {};
            const omitidos: string[] = [];
            for (const [k, v] of Object.entries(p.campos as Fila)) {
                if (f[k] === null || f[k] === undefined || f[k] === '') patch[k] = v;
                else if (!igual(f[k], v)) omitidos.push(`${k} (ya tiene otro valor: no se pisa)`);
            }
            if (!Object.keys(patch).length) return hecho(`${p.tabla} ${corto(p.id)} sin vacíos que llenar${omitidos.length ? `; ${omitidos.join(', ')}` : ''}`);
            const filtro = Object.fromEntries(Object.keys(patch).map((k) => [k, null]));
            const e = esc(p.tabla, p.id, filtro, patch);
            return ok(`${p.tabla} ${corto(p.id)}: llenar ${describir(patch)}${omitidos.length ? `; ${omitidos.join(', ')}` : ''}`, [e]);
        }

        case 'cerrar_ficha': {
            const tabla: Tabla = p.tipo === 'child' ? 'children' : 'unregistered_athletes';
            const f = m.get(tabla, p.id);
            if (!f) return choque(`${tabla} ${corto(p.id)} no existe`);
            const objetivo: Fila = p.tipo === 'child' ? { is_active: false } : { is_active: false, linked_profile_id: p.linked_profile_id ?? null };
            if (difiere(f, objetivo).length === 0) return hecho(`ficha ${corto(p.id)} ya está cerrada`);
            if (p.tipo !== 'child' && f.linked_profile_id && f.linked_profile_id !== p.linked_profile_id) {
                return choque(`la ficha ${corto(p.id)} ya está vinculada a OTRO perfil (${corto(f.linked_profile_id)})`);
            }
            const tipo = p.tipo === 'child' ? 'child' : 'unregistered';
            const vivas = m.de('enrollments').filter((e) => esDelSujeto(e, tipo, p.id) && e.status === 'active');
            const abiertos = m.de('payments').filter((x) => esDelSujeto(x, tipo, p.id) && ABIERTOS.includes(x.status));
            if (vivas.length || abiertos.length) {
                return choque(`la ficha ${corto(p.id)} aún tiene ${vivas.length} inscripción(es) activa(s) y ${abiertos.length} cobro(s) abierto(s)`);
            }
            const filtro: Fila = p.tipo === 'child' ? { is_active: true } : { linked_profile_id: null };
            const e = esc(tabla, p.id, filtro, objetivo);
            return ok(`cerrar ficha ${p.tipo} ${corto(p.id)} (${describir(objetivo)})`, [e]);
        }

        default:
            return choque(`acción desconocida: ${p.accion}`);
    }
}

// ─── Carga: todo lo que el plan toca, más los cobros/inscripciones de cada sujeto ───
async function cargar(supabase: any, plan: Plan, personas: Persona[]): Promise<Memoria> {
    const m = new Memoria();
    const ids: Record<Tabla, Set<string>> = {
        payments: new Set(), enrollments: new Set(), unregistered_athletes: new Set(), children: new Set(),
        profiles: new Set(), school_members: new Set(), school_join_requests: new Set(), whatsapp_inbound_queue: new Set(),
    };
    const sujetos: { tipo: string; id: string }[] = [];
    for (const per of personas) {
        sujetos.push(per.sobrevive, per.absorbe);
        for (const p of per.pasos) {
            if (p.cobro) ids.payments.add(p.cobro);
            if (p.desde) ids.payments.add(p.desde);
            if (p.hacia && typeof p.hacia === 'string') ids.payments.add(p.hacia);
            if (p.inscripcion) ids.enrollments.add(p.inscripcion);
            if (p.tabla && p.id) ids[p.tabla as Tabla]?.add(p.id);
            if (p.accion === 'cerrar_ficha') ids[p.tipo === 'child' ? 'children' : 'unregistered_athletes'].add(p.id);
            if (p.hacia?.tipo === 'child') ids.children.add(p.hacia.id);
        }
    }
    for (const s of sujetos) {
        if (s.tipo === 'child') ids.children.add(s.id);
        else if (s.tipo === 'unregistered') ids.unregistered_athletes.add(s.id);
        else ids.profiles.add(s.id);
    }
    for (const [tabla, set] of Object.entries(ids) as [Tabla, Set<string>][]) {
        if (!set.size) continue;
        const { data, error } = await supabase.from(tabla).select('*').in('id', [...set]);
        if (error) throw new Error(`${tabla}: ${error.message}`);
        for (const f of data ?? []) m.put(tabla, f);
    }
    // Cobros e inscripciones de cada sujeto en la escuela (para los índices y lo que queda abierto).
    const porCol: Record<string, string[]> = { child_id: [], user_id: [], unregistered_athlete_id: [] };
    for (const s of sujetos) porCol[s.tipo === 'child' ? 'child_id' : s.tipo === 'adult' ? 'user_id' : 'unregistered_athlete_id'].push(s.id);
    for (const [col, vals] of Object.entries(porCol)) {
        if (!vals.length) continue;
        for (const tabla of ['payments', 'enrollments'] as Tabla[]) {
            const { data, error } = await supabase.from(tabla).select('*').eq('school_id', plan.escuela).in(col, vals);
            if (error) throw new Error(`${tabla}.${col}: ${error.message}`);
            for (const f of data ?? []) if (!m.get(tabla, f.id)) m.put(tabla, f);
        }
    }
    const adultos = sujetos.filter((s) => s.tipo === 'adult').map((s) => s.id);
    if (adultos.length) {
        const { data } = await supabase.from('school_members').select('*').eq('school_id', plan.escuela).in('profile_id', adultos);
        for (const f of data ?? []) m.put('school_members', f);
    }
    return m;
}

/** Pertenencia: cada fila del plan es de esta escuela (children puede venir con school_id NULL). */
function ajenas(m: Memoria, escuela: string): string[] {
    const fuera: string[] = [];
    for (const t of ['payments', 'enrollments', 'unregistered_athletes', 'school_join_requests', 'whatsapp_inbound_queue'] as Tabla[]) {
        for (const f of m.de(t)) if (f.school_id && f.school_id !== escuela) fuera.push(`${t} ${corto(f.id)}`);
    }
    for (const f of m.de('children')) if (f.school_id && f.school_id !== escuela) fuera.push(`children ${corto(f.id)}`);
    return fuera;
}

function resumenFinal(m: Memoria, per: Persona): string[] {
    const s = per.sobrevive, a = per.absorbe;
    const linea = (tipo: string, id: string) => {
        const ins = m.de('enrollments').filter((e) => esDelSujeto(e, tipo, id) && e.status === 'active');
        const cob = m.de('payments').filter((x) => esDelSujeto(x, tipo, id) && x.status !== 'cancelled')
            .sort((x, y) => `${x.period_year}-${String(x.period_month).padStart(2, '0')}`.localeCompare(`${y.period_year}-${String(y.period_month).padStart(2, '0')}`));
        const fichaTabla: Tabla | null = tipo === 'child' ? 'children' : tipo === 'unregistered' ? 'unregistered_athletes' : null;
        const ficha = fichaTabla ? m.get(fichaTabla, id) : null;
        const visible = tipo === 'child' ? ficha?.is_active : tipo === 'unregistered' ? (ficha?.is_active && !ficha?.linked_profile_id) : true;
        return [
            `    ${tipo} ${corto(id)}: ${visible ? 'VISIBLE en el listado' : 'oculta (cerrada)'} · ${ins.length} inscripción(es) activa(s)`
            + (ins.length ? ` [${ins.map((e) => `${corto(e.team_id)}${e.offering_plan_id ? '+plan' : ''} cuota ${e.monthly_fee ?? 'equipo'}${e.fee_is_manual ? ' manual' : ''}`).join('; ')}]` : ''),
            ...cob.map((x) => `      · ${corto(x.id)} ${x.period_year}-${x.period_month} ${String(x.payment_category ?? 'mensualidad').padEnd(11)} ${x.status.padEnd(17)} ${cop(x.amount)}${x.receipt_image_sha256 ? ` · comprobante ${cop(x.ocr_amount)}` : ''}`),
        ];
    };
    return ['  Queda así:', ...linea(s.tipo, s.id), ...linea(a.tipo, a.id)];
}

async function main(): Promise<void> {
    if (!ESCUELA || !PLAN) {
        console.error('Uso: npx tsx scripts/fusionar-fichas-duplicadas.ts --escuela <school_id> --plan <plan.json> [--aplicar] [--solo <clave>]');
        process.exit(1);
    }
    const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8')) as Plan;
    if (plan.escuela !== ESCUELA) throw new Error(`El plan es de la escuela ${plan.escuela}, no de ${ESCUELA}`);
    if (!plan.actor || !plan.motivo || !Array.isArray(plan.personas)) throw new Error('El plan necesita actor, motivo y personas');
    const personas = plan.personas.filter((p) => !SOLO || p.clave === SOLO);
    if (!personas.length) throw new Error(SOLO ? `No hay persona con clave ${SOLO}` : 'El plan no trae personas');

    const { supabase: cliente } = await import('../src/config/supabase');
    // Tablas por nombre dinámico: el cliente tipado no acepta la unión de nombres.
    const supabase: any = cliente;
    const { data: escuela } = await supabase.from('schools').select('id, name').eq('id', ESCUELA).maybeSingle();
    if (!escuela) throw new Error(`Escuela ${ESCUELA} no existe`);
    const { data: actor } = await supabase.from('profiles').select('id, full_name, role').eq('id', plan.actor).maybeSingle();
    if (!actor) throw new Error(`actor ${plan.actor} no es un perfil`);
    if ((actor as any).role !== 'super_admin') console.log(`⚠ el actor ${(actor as any).full_name} tiene rol ${(actor as any).role}, no super_admin`);

    const m = await cargar(supabase, plan, personas);
    const fuera = ajenas(m, ESCUELA);
    if (fuera.length) throw new Error(`Filas de OTRA escuela en el plan: ${fuera.join(', ')}`);

    console.log(`${APLICAR ? 'APLICANDO' : 'SIMULACIÓN (no escribe nada)'} · ${(escuela as any).name} · ${personas.length} persona(s) · actor ${(actor as any).full_name}`);
    console.log(`Plan: ${PLAN}\nMotivo: ${plan.motivo}\n`);

    const conteo: Record<string, number> = {};
    const resumen = { aplicadas: 0, yaHechas: 0, saltadas: 0, fallidas: 0 };

    for (const per of personas) {
        console.log('═'.repeat(100));
        console.log(`${per.nombre} [${per.clave}] · ${per.clasificacion ?? ''}`);
        console.log(`  sobrevive ${per.sobrevive.tipo} ${per.sobrevive.id} · se absorbe ${per.absorbe.tipo} ${per.absorbe.id}`);
        const foto = m.foto();
        const resultados: { paso: Paso; r: Resultado }[] = [];
        let conflicto = false;
        for (const paso of per.pasos) {
            const r = evaluar(paso, m, plan.actor);
            resultados.push({ paso, r });
            if (r.estado === 'conflicto') { conflicto = true; break; }
        }
        for (const [i, { paso, r }] of resultados.entries()) {
            const marca = r.estado === 'hecho' ? '✓' : r.estado === 'conflicto' ? '✗ CONFLICTO' : '→';
            console.log(`  ${String(i + 1).padStart(2)}. ${paso.accion.padEnd(24)} ${marca} ${r.detalle}`);
            for (const e of r.escrituras) console.log(`        UPDATE ${e.tabla} ${corto(e.id)} SET ${describir(e.patch)}  WHERE ${describir(e.filtro)}`);
        }
        if (conflicto) {
            m.restaurar(foto);
            console.log('  ⛔ Persona SALTADA: el estado no es el auditado. No se escribió nada de esta persona.');
            resumen.saltadas++;
            continue;
        }
        const escrituras = resultados.flatMap(({ paso, r }) => r.escrituras.map((e) => ({ paso, e })));
        if (!escrituras.length) {
            console.log('  ✓ Ya estaba fusionada: nada que escribir.');
            resumen.yaHechas++;
            for (const l of resumenFinal(m, per)) console.log(l);
            continue;
        }
        // Prueba de idempotencia sobre el estado simulado: correr el plan otra vez no debe escribir nada.
        const despues = m.foto();
        const repetidos = per.pasos.map((paso) => evaluar(paso, m, plan.actor)).filter((r) => r.estado !== 'hecho');
        m.restaurar(despues);
        if (repetidos.length) {
            m.restaurar(foto);
            console.log(`  ⛔ Persona SALTADA: el plan no es idempotente (${repetidos.map((r) => r.detalle).join(' | ')}). Revisar el plan.`);
            resumen.saltadas++;
            continue;
        }
        console.log(`  ✓ Re-ejecución simulada: los ${per.pasos.length} pasos se reconocen como ya aplicados (idempotente).`);

        if (APLICAR) {
            let fallo: string | null = null;
            for (const { paso, e } of escrituras) {
                // 1) auditoría ANTES de escribir: ninguna escritura queda sin rastro
                const { error: errAudit } = await supabase.from('audit_logs').insert({
                    school_id: ESCUELA,
                    profile_id: plan.actor,
                    table_name: e.tabla,
                    record_id: e.id,
                    action: 'merge_athlete_identities',
                    old_data: e.antes,
                    new_data: { ...e.patch, _paso: paso.accion, _persona: per.clave, _sobrevive: per.sobrevive, _absorbe: per.absorbe, _motivo: plan.motivo },
                } as never);
                if (errAudit) { fallo = `audit_logs: ${errAudit.message}`; break; }
                // 2) UPDATE condicionado al estado auditado
                let q: any = supabase.from(e.tabla).update(e.patch as never).eq('id', e.id);
                for (const [k, v] of Object.entries(e.filtro)) q = v === null ? q.is(k, null) : q.eq(k, v);
                const { data, error } = await q.select('id');
                if (error) fallo = `${e.tabla} ${corto(e.id)}: ${error.message}`;
                else if (!data?.length) fallo = `${e.tabla} ${corto(e.id)}: la fila cambió mientras tanto (0 filas)`;
                if (fallo) {
                    // La fila de auditoría de arriba quedó sin efecto: se deja constancia (best effort).
                    await supabase.from('audit_logs').insert({
                        school_id: ESCUELA, profile_id: plan.actor, table_name: e.tabla, record_id: e.id,
                        action: 'merge_athlete_identities_fallo', old_data: e.antes,
                        new_data: { _paso: paso.accion, _persona: per.clave, _error: fallo },
                    } as never);
                    break;
                }
                conteo[e.tabla] = (conteo[e.tabla] ?? 0) + 1;
            }
            if (fallo) {
                console.log(`  ✗ FALLÓ a mitad de camino: ${fallo}`);
                console.log('    Lo escrito hasta acá está en audit_logs (merge_athlete_identities). Corregir y volver a correr: lo hecho se reconoce.');
                resumen.fallidas++;
                continue;
            }
            console.log(`  ✓ Fusionada (${escrituras.length} escrituras).`);
        } else {
            for (const { e } of escrituras) conteo[e.tabla] = (conteo[e.tabla] ?? 0) + 1;
        }
        resumen.aplicadas++;
        for (const l of resumenFinal(m, per)) console.log(l);
        if (per.conflictos_para_la_escuela?.length) {
            console.log('  Para que lo verifique la escuela (no se tocó):');
            for (const c of per.conflictos_para_la_escuela) console.log(`    · ${c}`);
        }
        if (per.decisiones_pendientes?.length) {
            console.log('  Decisiones pendientes:');
            for (const c of per.decisiones_pendientes) console.log(`    · ${c}`);
        }
        if (per.aprobacion_posterior) {
            const a = per.aprobacion_posterior;
            console.log(`  Después: aprobar ${corto(a.cobro)} como ${a.tipo} por ${cop(a.monto)}${a.previo ? `\n    Antes: ${a.previo}` : ''}`);
        }
        if (per.aviso_propuesto) {
            console.log(`  Aviso propuesto (NO se envía) → ${per.aviso_propuesto.para} · ${per.aviso_propuesto.cuando}`);
            console.log(`    «${per.aviso_propuesto.texto}»`);
        }
    }

    console.log('═'.repeat(100));
    const verbo = APLICAR ? 'Escrito' : 'Se escribiría';
    console.log(`${verbo}: ${Object.entries(conteo).map(([t, n]) => `${t} ${n}`).join(' · ') || 'nada'}`
        + `${APLICAR ? ` · audit_logs ${Object.values(conteo).reduce((a, b) => a + b, 0)}` : ` · audit_logs ${Object.values(conteo).reduce((a, b) => a + b, 0)} (una por escritura)`}`);
    console.log(`Personas: ${resumen.aplicadas} ${APLICAR ? 'fusionadas' : 'listas para fusionar'} · ${resumen.yaHechas} ya estaban · ${resumen.saltadas} saltadas · ${resumen.fallidas} fallidas`);
    if (!APLICAR) console.log('\n(SIMULACIÓN: no se escribió nada. Para aplicar, agregar --aplicar.)');
}

main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
});
