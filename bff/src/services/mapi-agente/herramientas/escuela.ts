/**
 * Acciones de la oleada 3, módulo ESCUELA (plan §19.4, fila 3). Solo administración.
 *
 * Regla del spec (§19.2): una herramienta por acción de pantalla, sobre el MISMO
 * servicio o la MISMA RPC que usa la pantalla. Mapi no lleva reglas propias:
 *
 *   pausar_inscripcion     → RPC preview_enrollment_pause + pause_enrollment_directly
 *                            (botón «Vacaciones / pausa» de Alumnos, hooks/usePauses.ts)
 *   reactivar_inscripcion  → RPC resume_enrollment («Reactivar de la pausa»)
 *   dar_de_baja            → RPC set_school_athlete_status (Alumnos → inactivar)
 *   cambiar_plan           → crearInscripcion (cuerpo de POST /api/v1/enrollments,
 *                            «Inscribir en el plan»), con previewPlanChange del banco de horas
 *   crear_cobro_unico      → previewChargeBatch / createChargeBatch (modal «Cobros y pagos»)
 *
 * EL ACTOR. Las RPC de pausa y baja autorizan con `auth.uid()`: llamadas con
 * service_role pelado, la de baja responde «No autorizado» y las de pausa pasan
 * de largo SIN dejar quién lo hizo (docs/gotchas-tecnicos.md). Por eso se llaman
 * por su `<rpc>_por` (rpc-por.ts, plan mapi-rpc-por-actor): service_role con
 * `p_actor = alcance.userId`; la base valida que el actor sea administración de
 * la escuela de la inscripción, lo fija en la transacción y llama a la RPC de la
 * pantalla, cuyo gate sigue siendo el real. Funciona con o sin JWT (WhatsApp).
 *
 * Plata: el modelo nunca la ve calculada por él. Los montos de la tarjeta salen
 * de la base o de la RPC; el coach no tiene ninguna de estas herramientas.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { supabase } from '../../../config/supabase';
import { motivoDeLaPor, rpcPor, type RpcPor } from '../rpc-por';
import { saldoDelCobro } from '../../../utils/saldo-cobro';
import { crearInscripcion, type DatosInscripcion } from '../../../routes/enrollments';
import { nivelFinanzasEnEscuela } from '../../../middlewares/assertSchoolFinanceAdmin';
import { MAX_MESES_PAUSA, mapearErrorRpc, mesesEntre } from '../../retiro-y-pausa.service';
import { previewPlanChange } from '../../planChange.service';
import { isPeriodCharge } from '../../enrollmentBilling';
import { ChargeBatchCreateSchema, ChargeBatchRequestSchema, primerError, type ChargeBatchRequest } from '../../charge-batches.schemas';
import { CobrosError, atletasDelGrupo, createChargeBatch, previewChargeBatch, verificarPertenencia } from '../../charge-batches.service';
import { buscarCobroDuplicadoReciente, mensajeDeDuplicado, type CobroReciente } from '../../cobro-duplicado-reciente';
import { MOTIVO } from '../../motivos-de-cobro';
import { fmtCop } from '../../estado-de-cuenta.service';
import { columnaDe, normalizar, resolverDeportista, type Deportista } from '../deportistas';
import { esFechaIso, esMes, fechaLarga, nombreDelMes } from '../fechas';
import { RechazoHerramienta, type Alcance, type Herramienta, type HerramientaAccion } from '../tipos';

// ─── Comunes ────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const mayuscula = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function soloAdmin(a: Alcance): void {
    if (a.rol !== 'admin') throw new RechazoHerramienta('Esto lo hace solo la administración de la escuela.');
}

/** Llama la `_por` de la RPC de la pantalla a nombre del actor. Errores → texto para la persona. */
async function rpcDelActor(a: Alcance, nombre: RpcPor, args: Record<string, unknown>):
    Promise<{ ok: true; data: any } | { ok: false; motivo: string }> {
    const { data, error } = await rpcPor(a, nombre, args);
    if (error) {
        const propio = motivoDeLaPor(error, nombre);
        if (propio) return { ok: false, motivo: propio };
        const m = mapearErrorRpc(error as any);
        if (m.status === 500) {
            console.error('[mapi-agente] RPC falló', { nombre, code: (error as any).code, msg: (error as any).message });
            return { ok: false, motivo: 'La base no pudo completarlo. Intenta de nuevo o hazlo desde Alumnos.' };
        }
        return { ok: false, motivo: m.error };
    }
    return { ok: true, data };
}

interface FilaInscripcion {
    id: string;
    status: string;
    team_id: string | null;
    offering_plan_id: string | null;
    paused_reason: string | null;
    pause_request_id: string | null;
    monthly_fee: number | null;
    /** Becado o cuota negociada. */
    fee_is_manual: boolean;
}

/** Inscripciones abiertas (activas o pendientes) del deportista en ESTA escuela. */
async function inscripcionesAbiertas(a: Alcance, d: Deportista): Promise<FilaInscripcion[]> {
    const { data, error } = await supabase.from('enrollments')
        .select('id, status, team_id, offering_plan_id, paused_reason, pause_request_id, monthly_fee, fee_is_manual, created_at')
        .eq('school_id', a.schoolId).eq(columnaDe(d.tipo), d.id).in('status', ['active', 'pending'])
        .order('created_at', { ascending: true });
    if (error) throw new Error(`enrollments: ${error.message}`);
    return ((data as any[]) ?? []).map((f) => ({
        id: String(f.id), status: String(f.status), team_id: f.team_id ?? null, offering_plan_id: f.offering_plan_id ?? null,
        paused_reason: f.paused_reason ?? null, pause_request_id: f.pause_request_id ?? null,
        monthly_fee: f.monthly_fee != null ? Number(f.monthly_fee) : null, fee_is_manual: f.fee_is_manual === true,
    }));
}

/** La fila de Alumnos sobre la que actúa la pantalla: la activa que cobra (con plan) o la única activa. */
function inscripcionPrincipal(filas: FilaInscripcion[], nombre: string): FilaInscripcion {
    const activas = filas.filter((f) => f.status === 'active');
    const conPlan = activas.filter((f) => f.offering_plan_id);
    if (conPlan.length === 1) return conPlan[0];
    if (!activas.length) throw new RechazoHerramienta(`${nombre} no tiene una inscripción activa.`);
    if (conPlan.length === 0 && activas.length === 1) return activas[0];
    throw new RechazoHerramienta(`${nombre} tiene ${activas.length} inscripciones activas: hazlo desde Alumnos, en la fila de cada una.`);
}

/** ¿La escuela prendió la pausa? (school_settings.pause_enabled; sin él, la pantalla no muestra el botón). */
async function pausaActiva(schoolId: string): Promise<boolean> {
    const { data, error } = await supabase.from('school_settings').select('pause_enabled').eq('school_id', schoolId).maybeSingle();
    return !error && (data as any)?.pause_enabled === true;
}

const PAUSA_APAGADA = 'La pausa por vacaciones o lesión no está activa en esta escuela (se prende en la configuración de pagos). Sin ella, la pantalla tampoco la ofrece.';

/** Equipo o plan por id o por nombre (sin tildes ni signos), solo de esta escuela. */
async function resolverPorNombre(
    tabla: 'teams' | 'offering_plans', schoolId: string, texto: string, cosa: 'equipo' | 'plan',
): Promise<{ id: string; nombre: string; precio: number | null }> {
    const cols = tabla === 'teams' ? 'id, name' : 'id, name, price';
    const fila = (r: any) => ({
        id: String(r.id), nombre: String(r.name ?? '').trim() || `${mayuscula(cosa)} sin nombre`,
        precio: tabla === 'offering_plans' && r.price != null ? Number(r.price) : null,
    });
    let q = supabase.from(tabla).select(cols).eq('school_id', schoolId);
    if (tabla === 'offering_plans') q = q.eq('is_active', true);
    if (UUID.test(texto)) {
        const { data } = await q.eq('id', texto.toLowerCase()).maybeSingle();
        if (!data) throw new RechazoHerramienta(`No encontré ese ${cosa} en esta escuela.`);
        return fila(data);
    }
    const clave = (s: string) => normalizar(s).replace(/[^a-z0-9]/g, '');
    const buscado = clave(texto);
    if (!buscado) throw new RechazoHerramienta(`Dime el nombre del ${cosa}.`);
    const { data, error } = await q.limit(500);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    const todos = ((data as any[]) ?? []).map(fila);
    const exactos = todos.filter((t) => clave(t.nombre) === buscado);
    const candidatos = exactos.length ? exactos : todos.filter((t) => clave(t.nombre).includes(buscado));
    if (candidatos.length === 1) return candidatos[0];
    if (!candidatos.length) throw new RechazoHerramienta(`No encontré un ${cosa} llamado «${texto}» en esta escuela.`);
    throw new RechazoHerramienta(`Hay varios ${cosa === 'plan' ? 'planes' : 'equipos'} que coinciden: ${candidatos.slice(0, 6).map((t) => t.nombre).join(', ')}. ¿Cuál?`);
}

const validarCon = <T>(schema: z.ZodType<T>, falta: string) => (args: unknown): T => {
    const r = schema.safeParse(args ?? {});
    if (!r.success) throw new RechazoHerramienta(falta);
    return r.data;
};

const nulo = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

// ─── pausar_inscripcion ─────────────────────────────────────────────────────

export const MOTIVOS_PAUSA = ['vacaciones', 'lesion', 'otro'] as const;
const MOTIVO_RPC: Record<(typeof MOTIVOS_PAUSA)[number], string> = { vacaciones: 'vacation', lesion: 'injury', otro: 'other' };
const MOTIVO_PAUSA_LEGIBLE: Record<(typeof MOTIVOS_PAUSA)[number], string> = { vacaciones: 'vacaciones', lesion: 'lesión', otro: 'otro' };

/** «Diciembre de 2026» o «Diciembre de 2026 a enero de 2027». Pura. */
export function mesesLegibles(desde: string, hasta: string): string {
    return desde === hasta ? mayuscula(nombreDelMes(desde)) : `${mayuscula(nombreDelMes(desde))} a ${nombreDelMes(hasta)}`;
}

/** Valida el rango de meses como el diálogo de la pantalla (desde el mes en curso, máximo 12). Pura. */
export function errorDeMeses(hoy: string, desde: string, hasta: string): string | null {
    if (!esMes(desde) || !esMes(hasta)) return 'Los meses tienen que venir como AAAA-MM (ej. 2026-12).';
    if (desde < hoy.slice(0, 7)) return 'La pausa empieza este mes o después: un mes que ya pasó no se puede pausar.';
    if (hasta < desde) return 'El mes final es anterior al inicial.';
    if (mesesEntre(desde, hasta) > MAX_MESES_PAUSA) return `La pausa no puede pasar de ${MAX_MESES_PAUSA} meses.`;
    return null;
}

export interface ArgsPausar {
    deportista: string;
    desde: string;
    hasta: string;
    motivo: (typeof MOTIVOS_PAUSA)[number];
    nota: string | null;
}

export const pausarInscripcion: HerramientaAccion<ArgsPausar> = {
    tipo: 'accion',
    nombre: 'pausar_inscripcion',
    descripcion: 'PREPARA la pausa de un deportista por meses completos (vacaciones, lesión), como «Vacaciones / pausa» en Alumnos; no la ejecuta, la persona confirma. Esos meses no se cobran y se anulan sus cobros pendientes de mensualidad. Solo administración y solo si la escuela tiene la pausa activa.',
    esquema: {
        type: 'object',
        properties: {
            deportista: { type: 'string', description: 'id del deportista (ej. "child:…")' },
            desde: { type: 'string', description: 'Primer mes, AAAA-MM' },
            hasta: { type: 'string', description: 'Último mes, AAAA-MM (igual a desde si es uno)' },
            motivo: { type: 'string', enum: [...MOTIVOS_PAUSA] },
            nota: { type: ['string', 'null'], description: 'Nota corta o null' },
        },
        required: ['deportista', 'desde', 'hasta', 'motivo', 'nota'],
        additionalProperties: false,
    },
    roles: ['admin'],
    validar: (args) => {
        const r = validarCon(z.object({
            deportista: z.string().min(5).max(80), desde: z.string().trim(), hasta: z.string().trim(),
            motivo: z.enum(MOTIVOS_PAUSA), nota: z.string().max(300).nullable().optional(),
        }), 'Faltan datos para la pausa: deportista, desde y hasta (AAAA-MM) y motivo.')(args);
        return { ...r, nota: nulo(r.nota) };
    },
    async preparar(a, args) {
        soloAdmin(a);
        if (!(await pausaActiva(a.schoolId))) return { ok: false, motivo: PAUSA_APAGADA };
        const malo = errorDeMeses(a.hoy, args.desde, args.hasta);
        if (malo) return { ok: false, motivo: malo };
        const d = await resolverDeportista(a, args.deportista);
        const insc = inscripcionPrincipal(await inscripcionesAbiertas(a, d), d.nombre);
        if (insc.paused_reason) return { ok: false, motivo: `${d.nombre} ya está en pausa. Para cambiar las fechas, reactívalo primero.` };

        const pv = await rpcDelActor(a, 'preview_enrollment_pause', {
            p_enrollment_id: insc.id, p_month_from: `${args.desde}-01`, p_month_to: `${args.hasta}-01`,
        });
        if (!pv.ok) return { ok: false, motivo: pv.motivo };
        const anular = Number(pv.data?.payments_a_anular ?? 0);
        const dudosos = Number(pv.data?.payments_ambiguos ?? 0);
        const n = mesesEntre(args.desde, args.hasta);
        return {
            ok: true,
            args: { ...args, deportista: d.clave },
            targetKey: `pausa:${d.clave}`,
            vista: {
                titulo: `Pausar a ${d.nombre}`,
                lineas: [
                    `${mesesLegibles(args.desde, args.hasta)} · ${plural(n, 'mes', 'meses')} sin cobro`,
                    `Motivo: ${MOTIVO_PAUSA_LEGIBLE[args.motivo]}${args.nota ? ` · «${args.nota}»` : ''}`,
                    anular
                        ? `Se ${anular === 1 ? 'anula 1 cobro pendiente' : `anulan ${anular} cobros pendientes`} de mensualidad de esos meses.`
                        : 'No hay cobros pendientes de esos meses para anular.',
                    ...(dudosos ? [`${plural(dudosos, 'cobro', 'cobros')} de esos meses sin categoría clara no se anula${dudosos === 1 ? '' : 'n'} solo${dudosos === 1 ? '' : 's'}: revísalo${dudosos === 1 ? '' : 's'} a mano.`] : []),
                    'No sale en la lista de asistencia mientras dure la pausa.',
                    'A la familia le llega el aviso en la app.',
                ],
                aviso: 'Se puede reactivar antes; el mes en que vuelva ya no se cobra.',
                botonConfirmar: 'Pausar',
            },
            huella: { inscripcion: insc.id, desde: args.desde, hasta: args.hasta, anular, dudosos, motivo: args.motivo, nota: args.nota },
        };
    },
    async ejecutar(a, args) {
        soloAdmin(a);
        const d = await resolverDeportista(a, args.deportista);
        const insc = inscripcionPrincipal(await inscripcionesAbiertas(a, d), d.nombre);
        const r = await rpcDelActor(a, 'pause_enrollment_directly', {
            p_enrollment_id: insc.id, p_reason: MOTIVO_RPC[args.motivo],
            p_month_from: `${args.desde}-01`, p_month_to: `${args.hasta}-01`, p_note: args.nota,
        });
        if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
        return {
            estado: 'executed',
            resultado: {
                nombre: d.nombre,
                meses: Number(r.data?.meses_pausados ?? 0),
                anulados: Number(r.data?.payments_cancelled ?? 0),
                dudosos: Number(r.data?.payments_ambiguos ?? 0),
            },
        };
    },
    mensajeResultado(r, args) {
        const x = r.resultado as any;
        if (r.estado === 'failed') return `No se pausó. ${x.motivo || ''}`.trim();
        return [
            `${x.nombre} quedó en pausa (${mesesLegibles(args.desde, args.hasta).toLowerCase()}): no se cobran ${plural(x.meses, 'mes', 'meses')}.`,
            x.anulados ? `Se ${x.anulados === 1 ? 'anuló 1 cobro pendiente' : `anularon ${x.anulados} cobros pendientes`}.` : '',
            x.dudosos ? `Quedaron ${plural(x.dudosos, 'cobro', 'cobros')} de categoría dudosa sin anular: revísalos a mano.` : '',
        ].filter(Boolean).join(' ');
    },
};

// ─── reactivar_inscripcion ──────────────────────────────────────────────────

export interface ArgsReactivar { deportista: string; nota: string | null }

export const reactivarInscripcion: HerramientaAccion<ArgsReactivar> = {
    tipo: 'accion',
    nombre: 'reactivar_inscripcion',
    descripcion: 'PREPARA reactivar a un deportista que está en pausa («Reactivar de la pausa» en Alumnos): vuelve a la lista de asistencia desde hoy. No lo ejecuta, la persona confirma. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            deportista: { type: 'string', description: 'id del deportista' },
            nota: { type: ['string', 'null'], description: 'Nota corta o null' },
        },
        required: ['deportista', 'nota'],
        additionalProperties: false,
    },
    roles: ['admin'],
    validar: (args) => {
        const r = validarCon(z.object({ deportista: z.string().min(5).max(80), nota: z.string().max(300).nullable().optional() }),
            'Falta el deportista que vuelve de la pausa.')(args);
        return { deportista: r.deportista, nota: nulo(r.nota) };
    },
    async preparar(a, args) {
        soloAdmin(a);
        if (!(await pausaActiva(a.schoolId))) return { ok: false, motivo: PAUSA_APAGADA };
        const d = await resolverDeportista(a, args.deportista);
        const pausadas = (await inscripcionesAbiertas(a, d)).filter((f) => f.status === 'active' && f.paused_reason);
        if (!pausadas.length) return { ok: false, motivo: `${d.nombre} no está en pausa.` };
        if (pausadas.length > 1) return { ok: false, motivo: `${d.nombre} tiene ${pausadas.length} inscripciones en pausa: reactívalas desde Alumnos.` };
        const insc = pausadas[0];

        let pausa: { month_from: string; month_to: string } | null = null;
        if (insc.pause_request_id) {
            const { data } = await supabase.from('enrollment_pause_requests').select('month_from, month_to')
                .eq('id', insc.pause_request_id).eq('school_id', a.schoolId).maybeSingle();
            pausa = (data as any) ?? null;
        }
        const mesActual = a.hoy.slice(0, 7);
        const desde = pausa ? String(pausa.month_from).slice(0, 7) : null;
        const hasta = pausa ? String(pausa.month_to).slice(0, 7) : null;
        const mesSinCobro = !!(desde && hasta && mesActual >= desde && mesActual <= hasta);
        return {
            ok: true,
            args: { ...args, deportista: d.clave },
            targetKey: `reactivar:${d.clave}`,
            vista: {
                titulo: `Reactivar a ${d.nombre}`,
                lineas: [
                    ...(desde && hasta ? [`Estaba en pausa: ${mesesLegibles(desde, hasta).toLowerCase()}.`] : []),
                    'Vuelve a aparecer en la lista de asistencia desde hoy.',
                    ...(mesSinCobro ? [`${mayuscula(nombreDelMes(mesActual))} sigue sin cobro: ese mes ya se decidió con la pausa. Si hay que cobrarlo, se registra a mano.`] : []),
                    'Si tenía vigencia paga sin usar, se le corre los días que no usó.',
                    'A la familia le llega el aviso en la app.',
                    ...(args.nota ? [`Nota: «${args.nota}»`] : []),
                ],
                aviso: null,
                botonConfirmar: 'Reactivar',
            },
            huella: { inscripcion: insc.id, pausa: insc.pause_request_id, nota: args.nota },
        };
    },
    async ejecutar(a, args) {
        soloAdmin(a);
        const d = await resolverDeportista(a, args.deportista);
        const insc = (await inscripcionesAbiertas(a, d)).find((f) => f.status === 'active' && f.paused_reason);
        if (!insc) return { estado: 'failed', resultado: { motivo: `${d.nombre} ya no estaba en pausa.` } };
        const r = await rpcDelActor(a, 'resume_enrollment', { p_enrollment_id: insc.id, p_note: args.nota });
        if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
        return {
            estado: 'executed',
            resultado: {
                nombre: d.nombre,
                dias_corridos: Number(r.data?.days_extended ?? 0),
                mes_en_curso_sin_cobro: r.data?.mes_en_curso_sin_cobro === true,
            },
        };
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado === 'failed') return `No se reactivó. ${x.motivo || ''}`.trim();
        return [
            `${x.nombre} volvió de la pausa: aparece en la lista de asistencia desde hoy.`,
            x.dias_corridos > 0 ? `Se le corrió la vigencia ${plural(x.dias_corridos, 'día', 'días')}.` : '',
            x.mes_en_curso_sin_cobro ? 'El mes en curso sigue sin cobro; si hay que cobrarlo, se registra a mano.' : '',
        ].filter(Boolean).join(' ');
    },
};

// ─── dar_de_baja ────────────────────────────────────────────────────────────

/** Los mismos estados que anula set_school_athlete_status (`partial` y `paid` son plata recibida). */
const ESTADOS_QUE_ANULA_LA_BAJA = ['pending', 'awaiting_approval', 'overdue'];
const COLS_COBRO = 'id, concept, amount, amount_paid, early_payment_discount_applied, status, due_date, period_year, period_month';

/** Cobros que la baja anularía: mismo predicado que la RPC, solo lectura (para la tarjeta). */
async function cobrosQueAnulaLaBaja(a: Alcance, d: Deportista): Promise<any[]> {
    const base = () => supabase.from('payments').select(COLS_COBRO)
        .eq('school_id', a.schoolId).in('status', ESTADOS_QUE_ANULA_LA_BAJA);
    const consultas = d.tipo === 'adult'
        // La RPC toma el adulto por user_id o como pagador de sus propios cobros sin menor.
        ? [base().eq('user_id', d.id), base().eq('parent_id', d.id).is('child_id', null)]
        : [base().eq(columnaDe(d.tipo), d.id)];
    const res = await Promise.all(consultas.map((q) => q.limit(500)));
    const porId = new Map<string, any>();
    for (const r of res) {
        if (r.error) throw new Error(`payments: ${r.error.message}`);
        for (const p of (r.data as any[]) ?? []) porId.set(String(p.id), p);
    }
    return [...porId.values()].sort((x, y) => String(x.id).localeCompare(String(y.id)));
}

const mesDeCobro = (p: any): string | null => (p.period_year && p.period_month
    ? `${p.period_year}-${String(p.period_month).padStart(2, '0')}`
    : p.due_date ? String(p.due_date).slice(0, 7) : null);

export interface ArgsBaja { deportista: string; motivo: string }

export const darDeBaja: HerramientaAccion<ArgsBaja> = {
    tipo: 'accion',
    nombre: 'dar_de_baja',
    descripcion: 'PREPARA dar de baja (inactivar) a un deportista, como «Inactivar» en Alumnos: cancela su plan y anula sus cobros pendientes; lo pagado no se toca. No lo borra: se puede reactivar. La persona confirma. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            deportista: { type: 'string', description: 'id del deportista' },
            motivo: { type: 'string', description: 'Por qué se va (corto)' },
        },
        required: ['deportista', 'motivo'],
        additionalProperties: false,
    },
    roles: ['admin'],
    validar: validarCon(z.object({ deportista: z.string().min(5).max(80), motivo: z.string().trim().min(3).max(200) }),
        'Faltan datos: el deportista y el motivo de la baja.'),
    async preparar(a, args) {
        soloAdmin(a);
        const d = await resolverDeportista(a, args.deportista);
        if (!d.activo) return { ok: false, motivo: `${d.nombre} ya está inactivo.` };
        const [filas, cobros] = await Promise.all([inscripcionesAbiertas(a, d), cobrosQueAnulaLaBaja(a, d)]);
        const activas = filas.filter((f) => f.status === 'active');
        const total = cobros.reduce((s, p) => s + saldoDelCobro(p), 0);
        const equipos = d.equipos.map((e) => e.nombre).filter(Boolean);
        return {
            ok: true,
            args: { ...args, deportista: d.clave },
            targetKey: `baja:${d.clave}`,
            vista: {
                titulo: `Dar de baja a ${d.nombre}`,
                lineas: [
                    activas.length
                        ? `Se cancela su inscripción${activas.length > 1 ? ` (${activas.length})` : ''}${equipos.length ? ` en ${equipos.join(', ')}` : ''} y deja de generar mensualidades.`
                        : 'No tiene inscripción activa.',
                    cobros.length
                        ? `Se ${cobros.length === 1 ? 'anula 1 cobro pendiente' : `anulan ${cobros.length} cobros pendientes`} por ${fmtCop(total)}.`
                        : 'No tiene cobros pendientes para anular.',
                    'Lo que ya pagó o abonó no se toca.',
                    ...(d.tipo !== 'adult' ? ['Si la invitación al acudiente seguía pendiente, se cancela.'] : []),
                    `Motivo: «${args.motivo}»`,
                ],
                aviso: 'No se borra: se puede reactivar desde Alumnos > Inactivos, y ahí hay que asignarle equipo y plan otra vez.',
                detalle: cobros.length ? {
                    etiqueta: `Ver ${cobros.length === 1 ? 'el cobro' : `los ${cobros.length} cobros`}`,
                    items: cobros.map((p) => {
                        const mes = mesDeCobro(p);
                        return [p.concept || 'Cobro', ...(mes ? [nombreDelMes(mes)] : []), fmtCop(saldoDelCobro(p))].join(' · ');
                    }),
                } : null,
                botonConfirmar: 'Dar de baja',
            },
            huella: {
                deportista: d.clave,
                inscripciones: activas.map((f) => f.id).sort(),
                cobros: cobros.map((p) => [String(p.id), saldoDelCobro(p)]),
            },
        };
    },
    async ejecutar(a, args) {
        soloAdmin(a);
        const d = await resolverDeportista(a, args.deportista);
        const r = await rpcDelActor(a, 'set_school_athlete_status', {
            // La escuela de la SESIÓN, nunca la del modelo: la RPC autoriza contra ella.
            p_school_id: a.schoolId, p_athlete_type: d.tipo, p_athlete_id: d.id, p_active: false,
        });
        if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
        return {
            estado: 'executed',
            resultado: {
                nombre: d.nombre,
                motivo: args.motivo,
                inscripciones: Number(r.data?.enrollments_cancelled ?? 0),
                cobros: Number(r.data?.payments_cancelled ?? 0),
                invitaciones: Number(r.data?.invitations_cancelled ?? 0),
            },
        };
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado === 'failed') return `No se dio de baja. ${x.motivo || ''}`.trim();
        return [
            `${x.nombre} quedó inactivo: se canceló su plan${x.cobros ? ` y se ${x.cobros === 1 ? 'anuló 1 cobro pendiente' : `anularon ${x.cobros} cobros pendientes`}` : ''}.`,
            x.invitaciones ? 'Se canceló la invitación pendiente al acudiente.' : '',
            'Para volver a activarlo: Alumnos > Inactivos.',
        ].filter(Boolean).join(' ');
    },
};

// ─── cambiar_plan ───────────────────────────────────────────────────────────


export interface ArgsCambiarPlan {
    deportista: string;
    /** Id del plan (o su nombre; preparar lo resuelve y guarda el id). */
    plan: string;
    /** Solo banco de horas con el periodo ya pago: lo que elige el admin en la pantalla. */
    cobro: 'parcial' | 'completo' | null;
}

interface ArmadoPlan {
    d: Deportista;
    plan: { id: string; nombre: string; precio: number | null };
    viejos: { id: string; nombre: string; precio: number | null }[];
    anulados: any[];
    conPagos: any[];
    modo: 'partial' | 'full' | null;
    banco: { aplica: boolean; partial: number; full: number; paid: number } | null;
    /** Cuota negociada (becado) que la ruta reemplaza por el precio del plan nuevo. */
    cuotaNegociada: number | null;
}

async function armarCambioDePlan(a: Alcance, args: ArgsCambiarPlan): Promise<{ ok: true; x: ArmadoPlan } | { ok: false; motivo: string }> {
    soloAdmin(a);
    const d = await resolverDeportista(a, args.deportista);
    if (!d.activo) return { ok: false, motivo: `${d.nombre} está inactivo: reactívalo antes de asignarle plan.` };
    const plan = await resolverPorNombre('offering_plans', a.schoolId, args.plan, 'plan');
    const filas = await inscripcionesAbiertas(a, d);
    const conPlan = filas.filter((f) => f.status === 'active' && f.offering_plan_id);
    if (conPlan.some((f) => f.offering_plan_id === plan.id)) return { ok: false, motivo: `${d.nombre} ya tiene el plan ${plan.nombre}.` };
    if (!conPlan.length) {
        return { ok: false, motivo: `${d.nombre} no tiene un plan activo para cambiar. El primer plan se asigna desde Alumnos > Editar deportista.` };
    }
    // Con una fila abierta SIN plan la ruta no reemplaza: le pone el plan a esa
    // fila y el viejo sigue vivo. Eso lo arregla el editor de Alumnos, no Mapi.
    if (filas.some((f) => !f.offering_plan_id)) {
        return { ok: false, motivo: `${d.nombre} tiene la inscripción partida (equipo y plan en filas distintas). Cámbiale el plan desde Alumnos > Editar deportista, que la une.` };
    }

    const col = columnaDe(d.tipo);
    const [{ data: planesViejos }, { data: abiertos, error: errCobros }, pv] = await Promise.all([
        supabase.from('offering_plans').select('id, name, price').eq('school_id', a.schoolId)
            .in('id', [...new Set(conPlan.map((f) => f.offering_plan_id as string))]),
        supabase.from('payments').select(`${COLS_COBRO}, offering_plan_id, payment_category`)
            .eq('school_id', a.schoolId).eq(col, d.id).in('status', ['pending', 'overdue']).limit(300),
        previewPlanChange({ schoolId: a.schoolId, athleteCol: col, athleteId: d.id, newPlanId: plan.id }),
    ]);
    if (errCobros) throw new Error(`payments: ${errCobros.message}`);

    // Mismo predicado que cancelPendingPlanPayments + cancelUnpaidPeriodCharges
    // (la ruta cambia el plan con fecha de hoy), solo para contarlo en la tarjeta.
    const idsViejos = new Set(conPlan.map((f) => f.offering_plan_id as string));
    const [y, m] = a.hoy.split('-').map(Number);
    const anulados: any[] = [];
    const conPagos: any[] = [];
    for (const p of ((abiertos as any[]) ?? []).sort((u, v) => String(u.id).localeCompare(String(v.id)))) {
        if (!isPeriodCharge(p.payment_category)) continue;
        const delPlanViejo = p.status === 'pending' && idsViejos.has(p.offering_plan_id);
        const delPeriodo = Number(p.period_year) === y && Number(p.period_month) === m;
        const conPago = Number(p.amount_paid) > 0;
        if (delPlanViejo || (delPeriodo && !conPago)) anulados.push(p);
        else if (delPeriodo && conPago) conPagos.push(p);
    }

    let modo: 'partial' | 'full' | null = null;
    if (pv.applies && pv.needs_choice) {
        if (!args.cobro) {
            const recomienda = pv.recommended === 'partial' ? ' Se recomienda el parcial.'
                : pv.recommended === 'full' ? ' Se recomienda el completo: ya gastó sus horas.'
                    : pv.recommended === 'wait' ? ' Faltan pocos días del periodo: conviene esperar al día 1.' : '';
            return {
                ok: false,
                motivo: `${d.nombre} ya pagó ${fmtCop(pv.paid_in_period)} de este periodo y la escuela usa banco de horas. `
                    + `Pregúntale si el cobro del cambio es parcial (${fmtCop(pv.partial_amount)}, la diferencia) o completo (${fmtCop(pv.full_amount)}).${recomienda}`,
            };
        }
        modo = args.cobro === 'parcial' ? 'partial' : 'full';
    }

    const viejos = ((planesViejos as any[]) ?? []).map((p) => ({ id: String(p.id), nombre: String(p.name ?? 'Plan'), precio: p.price != null ? Number(p.price) : null }));
    // La ruta deja monthly_fee = precio del plan nuevo: una cuota negociada se pierde. La tarjeta lo dice.
    const negociada = conPlan.find((f) => f.fee_is_manual);
    return {
        ok: true,
        x: {
            d, plan, viejos, anulados, conPagos, modo,
            banco: pv.applies ? { aplica: true, partial: pv.partial_amount, full: pv.full_amount, paid: pv.paid_in_period } : null,
            cuotaNegociada: negociada ? (negociada.monthly_fee ?? 0) : null,
        },
    };
}

const conPrecio = (p: { nombre: string; precio: number | null }) => (p.precio != null ? `${p.nombre} (${fmtCop(p.precio)})` : p.nombre);

export const cambiarPlan: HerramientaAccion<ArgsCambiarPlan> = {
    tipo: 'accion',
    nombre: 'cambiar_plan',
    plata: true,
    descripcion: 'PREPARA el cambio de plan de un deportista que ya tiene plan activo, con las mismas reglas que «Inscribir en el plan»: anula lo pendiente del plan anterior y emite la mensualidad del nuevo. No lo ejecuta, la persona confirma. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            deportista: { type: 'string', description: 'id del deportista' },
            plan: { type: 'string', description: 'id o nombre del plan nuevo' },
            cobro: {
                type: ['string', 'null'], enum: ['parcial', 'completo', null],
                description: 'Solo si Mapi lo pidió (banco de horas con el periodo pago); si no, null',
            },
        },
        required: ['deportista', 'plan', 'cobro'],
        additionalProperties: false,
    },
    roles: ['admin'],
    habilitada: () => process.env.MAPI_CAMBIAR_PLAN === 'true',
    validar: (args) => {
        const r = validarCon(z.object({
            deportista: z.string().min(5).max(80), plan: z.string().trim().min(1).max(120),
            cobro: z.enum(['parcial', 'completo']).nullable().optional(),
        }), 'Faltan datos: el deportista y el plan nuevo.')(args);
        return { deportista: r.deportista, plan: r.plan, cobro: r.cobro ?? null };
    },
    async preparar(a, args) {
        const r = await armarCambioDePlan(a, args);
        if (!r.ok) return r;
        const { d, plan, viejos, anulados, conPagos, modo, banco, cuotaNegociada } = r.x;
        const mes = nombreDelMes(a.hoy.slice(0, 7));
        const totalAnulado = anulados.reduce((s, p) => s + saldoDelCobro(p), 0);
        const lineaCobro = modo === 'partial' && banco
            ? `Se emite el cobro parcial de ${fmtCop(banco.partial)} (la diferencia con lo que ya pagó).`
            : modo === 'full' && banco
                ? `Se emite el cobro completo del plan nuevo: ${fmtCop(banco.full)}.`
                : (plan.precio ?? 0) > 0
                    ? `Se emite la mensualidad de ${plan.nombre} de ${mes}: ${fmtCop(plan.precio as number)}.`
                    : `${plan.nombre} no tiene precio: no se emite cobro.`;
        return {
            ok: true,
            args: { deportista: d.clave, plan: plan.id, cobro: modo ? args.cobro : null },
            targetKey: `plan:${d.clave}`,
            vista: {
                titulo: `Cambiar el plan de ${d.nombre}`,
                lineas: [
                    `De ${viejos.map(conPrecio).join(' y ') || 'su plan actual'} a ${conPrecio(plan)}.`,
                    anulados.length
                        ? `Se ${anulados.length === 1 ? 'anula 1 cobro sin pagos' : `anulan ${anulados.length} cobros sin pagos`} del plan anterior o de ${mes} (${fmtCop(totalAnulado)}).`
                        : 'No hay cobros pendientes del plan anterior para anular.',
                    lineaCobro,
                    ...(conPagos.length ? [`${conPagos.length === 1 ? 'El cobro' : `${conPagos.length} cobros`} de ${mes} ya ${conPagos.length === 1 ? 'tiene' : 'tienen'} pagos o abonos: no se anula${conPagos.length === 1 ? '' : 'n'}. Revisa su saldo antes de cobrar el plan nuevo.`] : []),
                    ...(banco ? ['Las horas ya usadas pasan al plan nuevo.'] : []),
                    'Inscripción, seguro y meses anteriores no se tocan.',
                ],
                aviso: cuotaNegociada != null
                    ? `Hoy tiene cuota negociada (${fmtCop(cuotaNegociada)}): con el cambio queda en el precio del plan nuevo. Si debe conservar el descuento, ajústalo después en Alumnos > Editar deportista.`
                    : null,
                detalle: anulados.length ? {
                    etiqueta: `Ver ${anulados.length === 1 ? 'el cobro que se anula' : `los ${anulados.length} cobros que se anulan`}`,
                    items: anulados.map((p) => {
                        const m = mesDeCobro(p);
                        return [p.concept || 'Cobro', ...(m ? [nombreDelMes(m)] : []), fmtCop(saldoDelCobro(p))].join(' · ');
                    }),
                } : null,
                botonConfirmar: 'Cambiar plan',
            },
            huella: {
                deportista: d.clave, plan: plan.id, precio: plan.precio, viejos: viejos.map((p) => p.id).sort(),
                anulados: anulados.map((p) => [String(p.id), saldoDelCobro(p)]), conPagos: conPagos.map((p) => String(p.id)),
                modo, banco, cuotaNegociada,
            },
        };
    },
    async ejecutar(a, args) {
        const r = await armarCambioDePlan(a, args);
        if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
        const { d, plan, viejos, modo } = r.x;
        const datos = {
            [columnaDe(d.tipo)]: d.id,
            offering_plan_id: plan.id,
            status: 'active',
            ...(modo ? { plan_change_charge: modo } : {}),
        } as DatosInscripcion;
        // El mismo cuerpo que POST /api/v1/enrollments («Inscribir en el plan»).
        const res = await crearInscripcion({ schoolId: a.schoolId, role: 'admin', userId: a.userId }, datos);
        if (res.status >= 300 || !res.body?.replaced) {
            return { estado: 'failed', resultado: { motivo: String(res.body?.error ?? 'No se pudo cambiar el plan.') } };
        }
        const cargo = res.body.plan_change?.charge ?? null;
        return {
            estado: 'executed',
            resultado: {
                nombre: d.nombre,
                de: viejos.map((p) => p.nombre).join(' y '),
                a: plan.nombre,
                cobro: cargo ? { modo: cargo.mode, monto: Number(cargo.amount) } : null,
                avisos: Array.isArray(res.body.warnings) ? res.body.warnings.map(String) : [],
            },
        };
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado === 'failed') return `No se cambió el plan. ${x.motivo || ''}`.trim();
        return [
            `${x.nombre} pasó de ${x.de || 'su plan anterior'} a ${x.a}.`,
            x.cobro ? `Se emitió el cobro ${x.cobro.modo === 'partial' ? 'parcial' : 'completo'} de ${fmtCop(x.cobro.monto)}.` : 'Se emitió la mensualidad del plan nuevo.',
            ...(x.avisos ?? []),
        ].join(' ');
    },
};

// ─── crear_cobro_unico ──────────────────────────────────────────────────────

/** Categorías de un cobro único (las del catálogo que no son mensualidad, inscripción, seguro ni del sistema). */
export const CATEGORIAS_UNICAS = ['torneo', 'articulos', 'viaje', 'vacacional', 'clase_extra', 'otro'] as const;
/** `target.ids` admite 50 en el modal: una lista más larga va por equipo. */
export const TOPE_LISTA = 50;

export interface ArgsCobroUnico {
    deportistas: string[] | null;
    equipo: string | null;
    categoria: (typeof CATEGORIAS_UNICAS)[number];
    concepto: string;
    monto: number;
    vence: string;
    avisar_familias: boolean;
}

interface Lote {
    body: ChargeBatchRequest;
    claves: string[];
    nombres: string[];
    equipo: { id: string; nombre: string } | null;
    pausados: number;
    sinAcudiente: number;
}

const MOTIVO_OMITIDO: Record<string, string> = {
    misma_linea_hoy: 'ya tienen este mismo cobro creado hoy',
    fee_unica_vez: 'ya pagaron este cobro de una sola vez',
    exonerado: 'están exonerados',
};

async function armarLote(a: Alcance, args: ArgsCobroUnico): Promise<{ ok: true; x: Lote } | { ok: false; motivo: string }> {
    soloAdmin(a);
    // El gate de la pantalla (assertSchoolFinanceAdmin): dueño o admin EN ESTA escuela.
    const nivel = await nivelFinanzasEnEscuela(a.userId, a.schoolId);
    if (nivel !== 'dueno' && nivel !== 'admin') throw new RechazoHerramienta('Solo la administración de la escuela puede crear cobros.');
    const lista = (args.deportistas ?? []).filter(Boolean);
    if (!!args.equipo === lista.length > 0) {
        return { ok: false, motivo: 'Dime a quién se le cobra: un equipo o una lista de deportistas, no los dos.' };
    }

    let athletes: { type: 'child' | 'adult' | 'unregistered'; id: string }[] = [];
    let nombres: string[] = [];
    let equipo: { id: string; nombre: string } | null = null;
    let pausados = 0;
    let sinAcudiente = 0;
    if (args.equipo) {
        const e = await resolverPorNombre('teams', a.schoolId, args.equipo, 'equipo');
        equipo = { id: e.id, nombre: e.nombre };
        // Los mismos destinos que «Equipo» en el modal (activos; los pausados fuera).
        const g = await atletasDelGrupo(a.schoolId, 'team', e.id, false);
        athletes = g.athletes.map((x: any) => ({ type: x.type, id: x.id }));
        nombres = g.athletes.map((x: any) => String(x.name || 'Deportista'));
        pausados = Number(g.paused_excluded ?? 0);
        sinAcudiente = g.athletes.filter((x: any) => x.has_guardian === false).length;
    } else {
        const claves = [...new Set(lista)];
        if (claves.length > TOPE_LISTA) return { ok: false, motivo: `Máximo ${TOPE_LISTA} deportistas por lista: para más, cóbralo por equipo.` };
        for (const c of claves) {
            const d = await resolverDeportista(a, c);
            if (!d.activo) return { ok: false, motivo: `${d.nombre} está inactivo: no se le crean cobros.` };
            athletes.push({ type: d.tipo, id: d.id });
            nombres.push(d.nombre);
        }
    }
    if (!athletes.length) {
        return { ok: false, motivo: equipo ? `${equipo.nombre} no tiene deportistas activos${pausados ? ` (${pausados} en pausa)` : ''}.` : 'No hay deportistas a quién cobrarle.' };
    }
    // Orden fijo: la misma operación da la misma vista previa (y el mismo hash) al confirmar.
    athletes = [...new Map(athletes.map((x) => [`${x.type}:${x.id}`, x])).values()]
        .sort((x, y) => `${x.type}:${x.id}`.localeCompare(`${y.type}:${y.id}`));

    const r = ChargeBatchRequestSchema.safeParse({
        mode: 'multi',
        target: equipo ? { kind: 'team', ids: [equipo.id] } : { kind: 'list', ids: athletes.map((x) => x.id) },
        athletes,
        lines: [{ category: args.categoria, amount: args.monto, due_date: args.vence, concept: args.concepto }],
        pending: [],
    });
    if (!r.success) return { ok: false, motivo: primerError(r.error) };
    await verificarPertenencia(a.schoolId, r.data);
    return {
        ok: true,
        x: { body: r.data, claves: athletes.map((x) => `${x.type}:${x.id}`), nombres: nombres.sort((u, v) => u.localeCompare(v, 'es')), equipo, pausados, sinAcudiente },
    };
}

/** Lo que dice la vista previa de la RPC, normalizado como el modal (normalizePreview). Pura. */
export function resumenDeVistaPrevia(p: any) {
    const omitidos: any[] = Array.isArray(p?.skipped) ? p.skipped : [];
    const porMotivo: Record<string, number> = {};
    for (const s of omitidos) porMotivo[String(s?.reason ?? 'otro')] = (porMotivo[String(s?.reason ?? 'otro')] ?? 0) + 1;
    return {
        hash: String(p?.preview_hash ?? ''),
        cobros: Number(p?.rows_to_create ?? p?.to_create?.n ?? 0),
        total: Number(p?.total_amount ?? p?.to_create?.total ?? 0),
        omitidos: omitidos.length,
        porMotivo,
        errores: (Array.isArray(p?.errors) ? p.errors : []).map((e: any) => String(e?.message || e?.code || 'error')),
    };
}

/**
 * client_request_id de la operación: sale de la vista previa que se confirma, así
 * un reintento del mismo borrador no crea el lote dos veces (la RPC es idempotente
 * por ese id). Formato UUID v4. Pura.
 */
export function idDeOperacion(schoolId: string, userId: string, previewHash: string): string {
    const h = createHash('sha256').update(`${schoolId}|${userId}|${previewHash}`).digest('hex');
    const variante = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variante}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const crearCobroUnico: HerramientaAccion<ArgsCobroUnico> = {
    tipo: 'accion',
    nombre: 'crear_cobro_unico',
    plata: true,
    descripcion: 'PREPARA un cobro único (torneo, uniforme, viaje…) para un equipo o una lista de deportistas, con el mismo motor de «Cobros y pagos». No registra pagos. No lo ejecuta: la persona confirma. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            deportistas: { type: ['array', 'null'], items: { type: 'string' }, description: 'ids de deportistas, o null si es un equipo' },
            equipo: { type: ['string', 'null'], description: 'id o nombre del equipo, o null si es una lista' },
            categoria: { type: 'string', enum: [...CATEGORIAS_UNICAS], description: 'articulos = uniformes y dotación' },
            concepto: { type: 'string', description: 'Lo que verá la familia (ej. "Torneo Copa Navidad")' },
            monto: { type: 'integer', description: 'Pesos por deportista' },
            vence: { type: 'string', description: 'AAAA-MM-DD, hoy o después' },
            avisar_familias: { type: 'boolean', description: 'true = sale el aviso de cobro a las familias' },
        },
        required: ['deportistas', 'equipo', 'categoria', 'concepto', 'monto', 'vence', 'avisar_familias'],
        additionalProperties: false,
    },
    roles: ['admin'],
    // Crea deuda: nace apagada hasta que el usuario la revise (regla 7 del encargo).
    habilitada: () => process.env.MAPI_COBROS_UNICOS === 'true',
    validar: (args) => {
        // Mensajes por campo ANTES del genérico (evals 11-24): con $0 o $50.000.000
        // el modelo recibía «faltan datos» y no podía explicar qué pasaba.
        const crudo = (args ?? {}) as Record<string, unknown>;
        const monto = typeof crudo.monto === 'number' ? crudo.monto : Number(crudo.monto);
        if (Number.isFinite(monto)) {
            if (monto <= 0) throw new RechazoHerramienta('El monto del cobro tiene que ser mayor que $0.');
            if (!Number.isInteger(monto)) throw new RechazoHerramienta('El monto va en pesos enteros, sin centavos.');
            if (monto > 20_000_000) {
                throw new RechazoHerramienta(`$${monto.toLocaleString('es-CO')} por deportista supera el tope de $20.000.000. ¿Era otra cifra (por ejemplo $${Math.round(monto / 1000).toLocaleString('es-CO')})? Confírmalo con la persona.`);
            }
        }
        if (typeof crudo.concepto === 'string' && crudo.concepto.trim().length < 3) {
            throw new RechazoHerramienta('Falta el concepto del cobro: lo que verá la familia (ej. «Torneo Copa Navidad»).');
        }
        if (!crudo.equipo && !(Array.isArray(crudo.deportistas) && crudo.deportistas.length)) {
            throw new RechazoHerramienta('Falta a quién se le cobra: un equipo o una lista de deportistas.');
        }
        const r = validarCon(z.object({
            deportistas: z.array(z.string().min(5).max(80)).max(200).nullable().optional(),
            equipo: z.string().trim().max(120).nullable().optional(),
            categoria: z.enum(CATEGORIAS_UNICAS),
            concepto: z.string().trim().min(3).max(120),
            monto: z.number().int().positive().max(20_000_000),
            vence: z.string().trim(),
            avisar_familias: z.boolean(),
        }), 'Faltan datos del cobro: a quién (equipo o deportistas), categoría, concepto, monto, vencimiento (AAAA-MM-DD) y si se avisa a las familias.')(args);
        if (!esFechaIso(r.vence)) throw new RechazoHerramienta('El vencimiento tiene que venir como AAAA-MM-DD.');
        return {
            deportistas: r.deportistas?.length ? r.deportistas : null,
            equipo: nulo(r.equipo),
            categoria: r.categoria, concepto: r.concepto, monto: r.monto, vence: r.vence, avisar_familias: r.avisar_familias,
        };
    },
    async preparar(a, args) {
        let lote: Lote;
        let p: ReturnType<typeof resumenDeVistaPrevia>;
        let recientes: CobroReciente[];
        try {
            const r = await armarLote(a, args);
            if (!r.ok) return r;
            lote = r.x;
            p = resumenDeVistaPrevia(await previewChargeBatch(a.schoolId, a.userId, lote.body));
            // Aviso (no bloqueo), igual que el modal: ¿alguien registró lo mismo hace pocos minutos?
            recientes = await buscarCobroDuplicadoReciente(a.schoolId, lote.body);
        } catch (err) {
            if (err instanceof CobrosError) return { ok: false, motivo: err.message };
            throw err;
        }
        if (p.errores.length) return { ok: false, motivo: p.errores[0] };
        const omitidas = Object.entries(p.porMotivo).map(([k, n]) => `${plural(n, 'deportista', 'deportistas')} no ${n === 1 ? 'recibe' : 'reciben'} el cobro: ${MOTIVO_OMITIDO[k] ?? 'no aplica'}.`);
        if (!p.cobros || !p.hash) return { ok: false, motivo: ['No se crearía ningún cobro.', ...omitidas].join(' ') };

        const etiqueta = MOTIVO[args.categoria]?.etiqueta ?? 'Cobro';
        const n = lote.claves.length;
        return {
            ok: true,
            args: { ...args, equipo: lote.equipo?.id ?? null, deportistas: lote.equipo ? null : lote.claves },
            targetKey: `cobro-unico:${lote.equipo?.id ?? 'lista'}:${normalizar(args.concepto)}`,
            vista: {
                titulo: `Cobro único · ${args.concepto}`,
                lineas: [
                    `${etiqueta} · ${fmtCop(args.monto)} por deportista · vence el ${fechaLarga(args.vence)}`,
                    `${plural(p.cobros, 'cobro', 'cobros')} para ${lote.equipo ? `${lote.equipo.nombre} (${plural(n, 'deportista', 'deportistas')})` : plural(n, 'deportista', 'deportistas')} · total ${fmtCop(p.total)}`,
                    ...omitidas,
                    ...(lote.pausados ? [`${plural(lote.pausados, 'deportista en pausa no se incluye', 'deportistas en pausa no se incluyen')}.`] : []),
                    ...(lote.sinAcudiente ? [`${plural(lote.sinAcudiente, 'menor sin acudiente vinculado', 'menores sin acudiente vinculado')}: no podrá${lote.sinAcudiente === 1 ? '' : 'n'} pagarlo en línea.`] : []),
                    args.avisar_familias ? 'Las familias reciben el aviso de cobro.' : 'No se avisa a las familias: el cobro queda en su estado de cuenta.',
                ],
                aviso: recientes.length
                    ? `Ojo: ${mensajeDeDuplicado(recientes[0])} Si confirmas, se crea igual.`
                    : 'Se puede anular después desde Gestión de pagos > Operaciones.',
                detalle: { etiqueta: `Ver ${n === 1 ? 'el deportista' : `los ${n} deportistas`}`, items: lote.nombres },
                botonConfirmar: `Crear ${plural(p.cobros, 'cobro', 'cobros')}`,
            },
            huella: {
                preview: p.hash, deportistas: lote.claves, categoria: args.categoria, concepto: args.concepto,
                monto: args.monto, vence: args.vence, avisar: args.avisar_familias, recientes: recientes.map((c) => c.batch_id).sort(),
            },
        };
    },
    async ejecutar(a, args) {
        try {
            const r = await armarLote(a, args);
            if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
            const p = resumenDeVistaPrevia(await previewChargeBatch(a.schoolId, a.userId, r.x.body));
            if (!p.hash || !p.cobros) return { estado: 'failed', resultado: { motivo: 'La vista previa ya no da cobros para crear.' } };
            const crear = ChargeBatchCreateSchema.safeParse({
                ...r.x.body,
                client_request_id: idDeOperacion(a.schoolId, a.userId, p.hash),
                preview_hash: p.hash,
                overrides: [],
                notify_families: args.avisar_familias,
                // La tarjeta que confirmó la persona ya decía si había uno igual reciente
                // (Confirmar re-prepara y compara antes de llegar aquí).
                confirmar_duplicado: true,
            });
            if (!crear.success) return { estado: 'failed', resultado: { motivo: primerError(crear.error) } };
            const data = await createChargeBatch(a.schoolId, a.userId, crear.data);
            const cobros = Number(data.rows_created ?? 0);
            const repetida = data.duplicated === true;
            if (!cobros && !repetida) return { estado: 'failed', resultado: { motivo: 'No se creó ningún cobro.' } };
            return {
                estado: 'executed',
                resultado: {
                    lote: data.batch_id ?? null,
                    concepto: args.concepto,
                    cobros,
                    total: Number(data.total_amount ?? 0),
                    omitidos: Array.isArray(data.skipped) ? data.skipped.length : 0,
                    repetida,
                    avisar: args.avisar_familias,
                },
            };
        } catch (err) {
            if (err instanceof CobrosError) return { estado: 'failed', resultado: { motivo: err.message } };
            throw err;
        }
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado === 'failed') return `No se creó el cobro. ${x.motivo || ''}`.trim();
        if (x.repetida) return `El cobro «${x.concepto}» ya estaba creado (misma operación): no se repitió.`;
        return [
            `Quedó creado el cobro «${x.concepto}»: ${plural(x.cobros, 'cobro', 'cobros')} por ${fmtCop(x.total)}.`,
            x.omitidos ? `${plural(x.omitidos, 'deportista quedó', 'deportistas quedaron')} por fuera.` : '',
            x.avisar ? 'Las familias reciben el aviso.' : 'No se avisó a las familias.',
            'Se puede anular desde Gestión de pagos > Operaciones.',
        ].filter(Boolean).join(' ');
    },
};

export const HERRAMIENTAS_ESCUELA: Herramienta[] = [
    pausarInscripcion,
    reactivarInscripcion,
    darDeBaja,
    cambiarPlan,
    crearCobroUnico,
];
