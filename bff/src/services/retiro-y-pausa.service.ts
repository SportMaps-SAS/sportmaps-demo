/**
 * retiro-y-pausa.service — pausar, retirar y reactivar el plan desde la app y
 * desde WhatsApp (docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §6).
 *
 * Contrato con la base: migración 20261106160004_retiro_y_pausa_por_canales.sql.
 *
 * DOS CAMINOS, UNA SOLA AUTORIZACIÓN
 *   · App (HTTP): `ctx.authorization` trae el `Bearer …` ya validado por requireAuth.
 *     Las RPC se llaman con el JWT del usuario, así su propio candado
 *     (acudiente del menor / adulto dueño / administración) es el gate real y no un
 *     adorno que el BFF puentea (ver docs/specs/pausa-vacaciones-enrollments.md §8).
 *   · Bot de WhatsApp (sin JWT): `ctx.authorization` va vacío y las RPC se llaman con
 *     service_role + `p_actor` = la persona que el bot YA identificó por teléfono/OTP.
 *     La RPC solo honra p_actor con service_role. El bot nunca resuelve solicitudes.
 *   En ambos casos este servicio comprueba ANTES que la inscripción sea de quien
 *   pide (acudiente del menor o el propio adulto) para devolver 403/404 claros; la
 *   RPC lo vuelve a comprobar adentro.
 *
 * Resolver (aprobar/rechazar) es solo administración y exige JWT.
 */
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/supabase';

// ── Tipos ────────────────────────────────────────────────────────────────────
export type Tipo = 'pausa' | 'retiro' | 'reactivacion';
export type Canal = 'app' | 'whatsapp';
export type Estado = 'solicitado' | 'aprobado' | 'rechazado' | 'cancelado';

export interface Ctx {
    /** Quién pide (profile id), ya autenticado/identificado. */
    actorId: string;
    canal: Canal;
    /** Header `Authorization: Bearer …` del usuario. Sin él (bot) se usa service_role + p_actor. */
    authorization?: string;
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code?: string };

const fallo = (status: number, error: string, code?: string): { ok: false; status: number; error: string; code?: string } =>
    ({ ok: false, status, error, ...(code ? { code } : {}) });

// ── Validación de entradas (Zod) ─────────────────────────────────────────────
const UUID = z.string().uuid('Identificador inválido');
const MES = /^\d{4}-(0[1-9]|1[0-2])(-01)?$/;

/** 'YYYY-MM' o 'YYYY-MM-01' → 'YYYY-MM-01'. Cualquier otro día se rechaza (D5: meses completos). */
export function normalizarMes(valor: string): string | null {
    if (!MES.test(valor)) return null;
    return `${valor.slice(0, 7)}-01`;
}

const mesSchema = z.string().refine((v) => normalizarMes(v) !== null, 'Usa el formato AAAA-MM (mes completo)')
    .transform((v) => normalizarMes(v) as string);

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const fechaSchema = z.string().refine((v) => FECHA.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Usa el formato AAAA-MM-DD');

export const MAX_MESES_PAUSA = 12;

export function mesesEntre(desde: string, hasta: string): number {
    const [ya, ma] = desde.split('-').map(Number);
    const [yb, mb] = hasta.split('-').map(Number);
    return (yb * 12 + mb) - (ya * 12 + ma) + 1;
}

export const PausaSchema = z.object({
    enrollment_id: UUID,
    reason: z.enum(['injury', 'vacation', 'other']),
    month_from: mesSchema,
    month_to: mesSchema,
    note: z.string().trim().max(500).optional(),
}).strict().superRefine((v, ctx) => {
    const n = mesesEntre(v.month_from, v.month_to);
    if (n < 1) ctx.addIssue({ code: 'custom', path: ['month_to'], message: 'El mes final no puede ser anterior al inicial' });
    if (n > MAX_MESES_PAUSA) ctx.addIssue({ code: 'custom', path: ['month_to'], message: `La pausa no puede pasar de ${MAX_MESES_PAUSA} meses` });
});

export const RetiroSchema = z.object({
    enrollment_id: UUID,
    exit_date: fechaSchema,
    reason: z.string().trim().max(500).optional(),
}).strict();

export const ReactivacionSchema = z.object({
    enrollment_id: UUID,
    from_month: mesSchema,
    reason: z.string().trim().max(500).optional(),
}).strict();

export const ResolverSchema = z.object({
    decision: z.enum(['aprobar', 'rechazar']),
    note: z.string().trim().max(500).optional(),
    /** Solo retiro: además de retirar la inscripción, dar de baja al atleta (set_school_athlete_status). */
    dar_de_baja: z.boolean().optional(),
}).strict();

export const TipoSchema = z.enum(['pausa', 'retiro', 'reactivacion']);

export const ListaEscuelaQuery = z.object({
    estado: z.enum(['solicitado', 'aprobado', 'rechazado', 'cancelado']).optional(),
    tipo: TipoSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

export const ListaMiasQuery = z.object({
    estado: z.enum(['solicitado', 'aprobado', 'rechazado', 'cancelado']).optional(),
}).strict();

// ── Errores de la base → HTTP ────────────────────────────────────────────────
/**
 * Las RPC levantan `RAISE EXCEPTION` con texto en español pensado para la
 * persona (SQLSTATE P0001): se devuelve tal cual. Cualquier otro error de la
 * base es un fallo nuestro y NO se filtra su texto.
 */
export function mapearErrorRpc(error: { code?: string; message?: string }): { status: number; error: string; code?: string } {
    const code = error.code ?? '';
    const msg = String(error.message ?? '');
    if (code === 'PGRST202' || code === '42883') {
        return { status: 503, error: 'Esta función todavía no está disponible.', code: 'migracion_pendiente' };
    }
    if (code === '42501') return { status: 403, error: 'No autorizado.', code: 'forbidden' };
    if (code === 'P0001') {
        if (/^No autorizado/i.test(msg)) return { status: 403, error: msg, code: 'forbidden' };
        if (/^Sesión requerida/i.test(msg)) return { status: 401, error: msg, code: 'sesion' };
        if (/no encontrada|ya no existe/i.test(msg)) return { status: 404, error: msg, code: 'no_encontrada' };
        if (/^Ya hay|ya fue resuelta|Solo se puede/i.test(msg)) return { status: 409, error: msg, code: 'conflicto' };
        return { status: 422, error: msg, code: 'regla' };
    }
    if (code === '23505') return { status: 409, error: 'Ya hay una solicitud abierta para esta inscripción.', code: 'conflicto' };
    return { status: 500, error: 'No se pudo completar la solicitud.', code: 'interno' };
}

// ── Cliente ──────────────────────────────────────────────────────────────────
function clienteDelUsuario(authorization: string) {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authorization } },
        auth: { autoRefreshToken: false, persistSession: false },
    });
}

/** Llama una RPC con el JWT del usuario (app) o con service_role + p_actor (bot). */
async function llamarRpc(ctx: Ctx, nombre: string, args: Record<string, unknown>, conActor = true): Promise<Resultado<any>> {
    const { data, error } = ctx.authorization
        ? await clienteDelUsuario(ctx.authorization).rpc(nombre, args)
        : await supabase.rpc(nombre, conActor ? { ...args, p_actor: ctx.actorId } : args);
    if (error) {
        const m = mapearErrorRpc(error);
        if (m.status === 500) console.error('[retiro-y-pausa] RPC falló', { nombre, code: error.code, msg: error.message });
        return fallo(m.status, m.error, m.code);
    }
    return { ok: true, data };
}

// ── Autorización previa ──────────────────────────────────────────────────────
/**
 * ¿La inscripción es de quien pide? Acudiente del menor (children.parent_id) o
 * el propio adulto (enrollments.user_id). Devuelve la escuela o el motivo.
 */
export async function titularDeInscripcion(enrollmentId: string, actorId: string):
    Promise<{ ok: true; schoolId: string; rol: 'parent' | 'athlete' } | { ok: false; status: 403 | 404; error: string }> {
    const { data: enr, error } = await supabase.from('enrollments')
        .select('id, school_id, child_id, user_id')
        .eq('id', enrollmentId).maybeSingle();
    if (error) throw new Error(`enrollments: ${error.message}`);
    if (!enr) return { ok: false, status: 404, error: 'Inscripción no encontrada.' };
    const e = enr as { school_id: string; child_id: string | null; user_id: string | null };

    if (e.child_id) {
        const { data: hijo, error: eh } = await supabase.from('children')
            .select('id, parent_id').eq('id', e.child_id).maybeSingle();
        if (eh) throw new Error(`children: ${eh.message}`);
        if (hijo && (hijo as any).parent_id === actorId) return { ok: true, schoolId: e.school_id, rol: 'parent' };
    } else if (e.user_id && e.user_id === actorId) {
        return { ok: true, schoolId: e.school_id, rol: 'athlete' };
    }
    return { ok: false, status: 403, error: 'No autorizado: esta inscripción no es tuya.' };
}

/** Administración de la escuela: plataforma activa, dueño o miembro owner/admin/school_admin activo (igual que administraEstaEscuela). */
export async function esAdminDeEscuela(userId: string, schoolId: string): Promise<boolean> {
    const [plataforma, escuela, miembro] = await Promise.all([
        supabase.from('platform_admins').select('profile_id').eq('profile_id', userId).eq('is_active', true).limit(1),
        supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle(),
        supabase.from('school_members').select('role, status').eq('school_id', schoolId).eq('profile_id', userId).maybeSingle(),
    ]);
    if ((plataforma.data ?? []).length > 0) return true;
    if ((escuela.data as any)?.owner_id === userId) return true;
    return (miembro.data as any)?.status === 'active'
        && ['owner', 'admin', 'school_admin'].includes(String((miembro.data as any)?.role));
}

// ── Pedir ────────────────────────────────────────────────────────────────────
export async function pedirPausa(ctx: Ctx, i: z.infer<typeof PausaSchema>): Promise<Resultado<any>> {
    const t = await titularDeInscripcion(i.enrollment_id, ctx.actorId);
    if (!t.ok) return fallo(t.status, t.error, t.status === 404 ? 'no_encontrada' : 'forbidden');
    return llamarRpc(ctx, 'request_enrollment_pause_v2', {
        p_enrollment_id: i.enrollment_id,
        p_reason: i.reason,
        p_month_from: i.month_from,
        p_month_to: i.month_to,
        p_reason_note: i.note ?? null,
        p_channel: ctx.canal,
    });
}

export async function pedirRetiro(ctx: Ctx, i: z.infer<typeof RetiroSchema>): Promise<Resultado<any>> {
    const t = await titularDeInscripcion(i.enrollment_id, ctx.actorId);
    if (!t.ok) return fallo(t.status, t.error, t.status === 404 ? 'no_encontrada' : 'forbidden');
    return llamarRpc(ctx, 'request_enrollment_withdrawal', {
        p_enrollment_id: i.enrollment_id,
        p_effective_date: i.exit_date,
        p_reason: i.reason ?? null,
        p_channel: ctx.canal,
    });
}

export async function pedirReactivacion(ctx: Ctx, i: z.infer<typeof ReactivacionSchema>): Promise<Resultado<any>> {
    const t = await titularDeInscripcion(i.enrollment_id, ctx.actorId);
    if (!t.ok) return fallo(t.status, t.error, t.status === 404 ? 'no_encontrada' : 'forbidden');
    return llamarRpc(ctx, 'request_enrollment_reactivation', {
        p_enrollment_id: i.enrollment_id,
        p_effective_date: i.from_month,
        p_reason: i.reason ?? null,
        p_channel: ctx.canal,
    });
}

/** Cancelar la propia solicitud mientras siga abierta (o la administración). */
export async function cancelarSolicitud(ctx: Ctx, tipo: Tipo, id: string): Promise<Resultado<any>> {
    return llamarRpc(ctx, 'cancel_enrollment_request', { p_tipo: tipo, p_request_id: id });
}

// ── Resolver (solo administración, con JWT) ──────────────────────────────────
export async function resolverSolicitud(
    ctx: Ctx, tipo: Tipo, id: string, i: z.infer<typeof ResolverSchema>,
): Promise<Resultado<any>> {
    if (!ctx.authorization) return fallo(403, 'Solo la administración, con sesión, puede resolver solicitudes.', 'forbidden');

    const tabla = tipo === 'pausa' ? 'enrollment_pause_requests' : 'enrollment_withdrawal_requests';
    let q = supabase.from(tabla).select('id, school_id').eq('id', id);
    if (tipo !== 'pausa') q = q.eq('kind', tipo);
    const { data: fila, error } = await q.maybeSingle();
    if (error) throw new Error(`${tabla}: ${error.message}`);
    if (!fila) return fallo(404, 'Solicitud no encontrada.', 'no_encontrada');
    const schoolId = (fila as { school_id: string }).school_id;

    if (!(await esAdminDeEscuela(ctx.actorId, schoolId))) return fallo(403, 'No autorizado.', 'forbidden');

    if (tipo === 'pausa') {
        if (i.dar_de_baja) return fallo(400, 'dar_de_baja solo aplica a retiros.', 'regla');
        return llamarRpc(
            ctx,
            i.decision === 'aprobar' ? 'approve_enrollment_pause' : 'reject_enrollment_pause',
            { p_request_id: id, p_review_note: i.note ?? null },
            false,
        );
    }
    if (tipo === 'reactivacion' && i.dar_de_baja) return fallo(400, 'dar_de_baja solo aplica a retiros.', 'regla');
    return llamarRpc(ctx, 'resolve_enrollment_withdrawal', {
        p_request_id: id,
        p_decision: i.decision,
        p_review_note: i.note ?? null,
        p_dar_de_baja: i.dar_de_baja ?? false,
    }, false);
}

// ── Listar ───────────────────────────────────────────────────────────────────
export interface SolicitudDto {
    id: string;
    tipo: Tipo;
    enrollment_id: string;
    school_id: string;
    estado: Estado;
    atleta_nombre: string | null;
    /** pausa: primer mes (AAAA-MM-01); retiro: fecha de salida; reactivacion: mes de regreso. */
    desde: string;
    /** pausa: último mes; retiro/reactivacion: null. */
    hasta: string | null;
    motivo: string | null;
    detalle_motivo: string | null;
    canal: 'app' | 'whatsapp' | 'admin' | null;
    solicitante_rol: 'parent' | 'athlete' | 'admin' | null;
    auto_aprobada: boolean;
    fuera_de_tope: boolean;
    nota_administracion: string | null;
    creada_at: string | null;
    resuelta_at: string | null;
}

const ESTADO_PAUSA: Record<string, Estado> = {
    pending: 'solicitado', approved: 'aprobado', rejected: 'rechazado', cancelled: 'cancelado',
};

export function dtoDePausa(r: any): SolicitudDto {
    return {
        id: r.id, tipo: 'pausa', enrollment_id: r.enrollment_id, school_id: r.school_id,
        estado: ESTADO_PAUSA[r.status] ?? 'solicitado',
        atleta_nombre: null,
        desde: r.month_from, hasta: r.month_to,
        motivo: r.reason ?? null, detalle_motivo: r.reason_note ?? null,
        canal: r.channel ?? (r.source === 'admin' ? 'admin' : 'app'),
        solicitante_rol: r.source ?? null,
        auto_aprobada: r.auto_approved === true,
        fuera_de_tope: r.fuera_de_tope === true,
        nota_administracion: r.review_note ?? null,
        creada_at: r.requested_at ?? r.created_at ?? null,
        resuelta_at: r.reviewed_at ?? null,
    };
}

export function dtoDeRetiro(r: any): SolicitudDto {
    return {
        id: r.id, tipo: r.kind, enrollment_id: r.enrollment_id, school_id: r.school_id,
        estado: r.status,
        atleta_nombre: null,
        desde: r.effective_date, hasta: null,
        motivo: null, detalle_motivo: r.reason ?? null,
        canal: r.channel ?? null,
        solicitante_rol: r.requester_role ?? null,
        auto_aprobada: false, fuera_de_tope: false,
        nota_administracion: r.review_note ?? null,
        creada_at: r.requested_at ?? r.created_at ?? null,
        resuelta_at: r.processed_at ?? null,
    };
}

/** Pone el nombre del atleta con TRES consultas en lote (sin N+1). */
async function conNombres(items: Array<{ dto: SolicitudDto; child_id: string | null; user_id: string | null; unregistered_athlete_id: string | null }>): Promise<SolicitudDto[]> {
    const ids = (k: 'child_id' | 'user_id' | 'unregistered_athlete_id') =>
        [...new Set(items.map((x) => x[k]).filter((v): v is string => !!v))];
    const [hijos, perfiles, fichas] = await Promise.all([
        ids('child_id').length ? supabase.from('children').select('id, full_name').in('id', ids('child_id')) : Promise.resolve({ data: [] as any[] }),
        ids('user_id').length ? supabase.from('profiles').select('id, full_name').in('id', ids('user_id')) : Promise.resolve({ data: [] as any[] }),
        ids('unregistered_athlete_id').length ? supabase.from('unregistered_athletes').select('id, full_name').in('id', ids('unregistered_athlete_id')) : Promise.resolve({ data: [] as any[] }),
    ]);
    const mapa = new Map<string, string>();
    for (const f of [...(hijos.data ?? []), ...(perfiles.data ?? []), ...(fichas.data ?? [])] as any[]) mapa.set(f.id, f.full_name);
    return items.map((x) => ({
        ...x.dto,
        atleta_nombre: mapa.get(x.child_id ?? x.user_id ?? x.unregistered_athlete_id ?? '') ?? null,
    }));
}

const COLS_PAUSA = 'id, school_id, enrollment_id, child_id, user_id, unregistered_athlete_id, reason, reason_note, month_from, month_to, status, source, channel, auto_approved, fuera_de_tope, review_note, requested_at, reviewed_at';
const COLS_RETIRO = 'id, school_id, enrollment_id, child_id, user_id, unregistered_athlete_id, kind, effective_date, reason, channel, requester_role, status, review_note, requested_at, processed_at';

function ordenar(a: SolicitudDto, b: SolicitudDto): number {
    return String(b.creada_at ?? '').localeCompare(String(a.creada_at ?? ''));
}

/** Las solicitudes de quien consulta: de sus hijos (acudiente) o propias (adulto). */
export async function listarMias(actorId: string, estado?: Estado): Promise<SolicitudDto[]> {
    const { data: hijos, error: eh } = await supabase.from('children').select('id').eq('parent_id', actorId);
    if (eh) throw new Error(`children: ${eh.message}`);
    const childIds = ((hijos as any[]) ?? []).map((h) => h.id as string);

    const consultas: PromiseLike<{ data: any[] | null; error: any }>[] = [];
    const quiero = (tabla: string, cols: string, col: string, valor: string | string[]) => {
        let q: any = supabase.from(tabla).select(cols);
        q = Array.isArray(valor) ? q.in(col, valor) : q.eq(col, valor);
        return q.order('requested_at', { ascending: false }).limit(200);
    };
    const filtroEstadoPausa = estado ? Object.entries(ESTADO_PAUSA).find(([, v]) => v === estado)?.[0] : undefined;

    if (childIds.length) {
        consultas.push(quiero('enrollment_pause_requests', COLS_PAUSA, 'child_id', childIds));
        consultas.push(quiero('enrollment_withdrawal_requests', COLS_RETIRO, 'child_id', childIds));
    }
    consultas.push(quiero('enrollment_pause_requests', COLS_PAUSA, 'user_id', actorId));
    consultas.push(quiero('enrollment_withdrawal_requests', COLS_RETIRO, 'user_id', actorId));

    const res = await Promise.all(consultas);
    const vistos = new Set<string>();
    const items: Array<{ dto: SolicitudDto; child_id: string | null; user_id: string | null; unregistered_athlete_id: string | null }> = [];
    for (const r of res) {
        if (r.error) throw new Error(`solicitudes: ${r.error.message}`);
        for (const f of r.data ?? []) {
            if (vistos.has(f.id)) continue;
            vistos.add(f.id);
            const esPausa = 'month_from' in f;
            if (estado && (esPausa ? f.status !== filtroEstadoPausa : f.status !== estado)) continue;
            // Las pausas 'no_asistio' son anulaciones de cobro de la administración, no una pausa pedida.
            if (esPausa && f.reason === 'no_asistio') continue;
            items.push({
                dto: esPausa ? dtoDePausa(f) : dtoDeRetiro(f),
                child_id: f.child_id ?? null, user_id: f.user_id ?? null, unregistered_athlete_id: f.unregistered_athlete_id ?? null,
            });
        }
    }
    return (await conNombres(items)).sort(ordenar);
}

/** La bandeja de la administración de una escuela (la autorización la hace la ruta). */
export async function listarDeEscuela(schoolId: string, f: { estado?: Estado; tipo?: Tipo; limit: number }): Promise<SolicitudDto[]> {
    const traerPausas = !f.tipo || f.tipo === 'pausa';
    const traerRetiros = !f.tipo || f.tipo !== 'pausa';
    const filtroEstadoPausa = f.estado ? Object.entries(ESTADO_PAUSA).find(([, v]) => v === f.estado)?.[0] : undefined;

    let qp: any = traerPausas
        ? supabase.from('enrollment_pause_requests').select(COLS_PAUSA).eq('school_id', schoolId).neq('reason', 'no_asistio')
        : null;
    if (qp && filtroEstadoPausa) qp = qp.eq('status', filtroEstadoPausa);
    let qr: any = traerRetiros
        ? supabase.from('enrollment_withdrawal_requests').select(COLS_RETIRO).eq('school_id', schoolId)
        : null;
    if (qr && f.estado) qr = qr.eq('status', f.estado);
    if (qr && f.tipo && f.tipo !== 'pausa') qr = qr.eq('kind', f.tipo);

    const [rp, rr] = await Promise.all([
        qp ? qp.order('requested_at', { ascending: false }).limit(f.limit) : Promise.resolve({ data: [], error: null }),
        qr ? qr.order('requested_at', { ascending: false }).limit(f.limit) : Promise.resolve({ data: [], error: null }),
    ]);
    if (rp.error) throw new Error(`enrollment_pause_requests: ${rp.error.message}`);
    if (rr.error) throw new Error(`enrollment_withdrawal_requests: ${rr.error.message}`);

    const items = [
        ...((rp.data as any[]) ?? []).map((x) => ({ dto: dtoDePausa(x), child_id: x.child_id ?? null, user_id: x.user_id ?? null, unregistered_athlete_id: x.unregistered_athlete_id ?? null })),
        ...((rr.data as any[]) ?? []).map((x) => ({ dto: dtoDeRetiro(x), child_id: x.child_id ?? null, user_id: x.user_id ?? null, unregistered_athlete_id: x.unregistered_athlete_id ?? null })),
    ];
    return (await conNombres(items)).sort(ordenar).slice(0, f.limit);
}
