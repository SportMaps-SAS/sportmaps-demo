/**
 * referidos.service — campañas de descuento por referidos (spec
 * docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §4, F1).
 *
 * Dos capas:
 *  · Lógica PURA (tramos por edad, edad en una fecha, validación de tramos, mapeo de errores de
 *    la base a respuestas en español). Es la copia en TypeScript de `_referral_pct_for_age` y
 *    `_referral_tiers_valid` de la migración 20261106160001: la base manda, esto sirve para
 *    validar antes de viajar y para que pantalla y bot muestren lo mismo sin otra consulta.
 *  · Llamadas a las RPC. La BFF entra con service_role (auth.uid() NULL), así que cada RPC recibe
 *    `p_actor` = el usuario autenticado y la base RE-VALIDA el alcance sobre ESE school_id.
 *
 * El descuento NUNCA lo calcula ni lo aplica este servicio: lo aplica `open_month`.
 */
import { z } from 'zod';
import { supabase } from '../config/supabase';

// ─── Tramos por edad ─────────────────────────────────────────────────────────

export interface Tramo {
    age_min: number;
    age_max: number | null;
    pct: number;
}

/** Valores por defecto aprobados (D1): 4–15 años → 50 %, 16 o más → 25 %. */
export const TRAMOS_POR_DEFECTO: readonly Tramo[] = [
    { age_min: 4, age_max: 15, pct: 50 },
    { age_min: 16, age_max: null, pct: 25 },
];

/** % del tramo que contiene la edad, o null si no califica (p. ej. menor de 4). */
export function porcentajeParaEdad(tramos: readonly Tramo[], edad: number): number | null {
    if (!Number.isFinite(edad) || edad < 0) return null;
    const candidatos = tramos
        .filter((t) => edad >= t.age_min && (t.age_max === null || edad <= t.age_max))
        .sort((a, b) => b.age_min - a.age_min);
    return candidatos.length ? candidatos[0].pct : null;
}

/** Edad cumplida en `fecha` (ambas YYYY-MM-DD o Date). Null si falta la fecha de nacimiento. */
export function edadEnFecha(nacimiento: string | Date | null | undefined, fecha: string | Date): number | null {
    if (!nacimiento) return null;
    const n = new Date(nacimiento);
    const f = new Date(fecha);
    if (Number.isNaN(n.getTime()) || Number.isNaN(f.getTime())) return null;
    let edad = f.getUTCFullYear() - n.getUTCFullYear();
    const aunNoCumple = f.getUTCMonth() < n.getUTCMonth()
        || (f.getUTCMonth() === n.getUTCMonth() && f.getUTCDate() < n.getUTCDate());
    if (aunNoCumple) edad -= 1;
    return Math.max(edad, 0);
}

/** Misma regla que `_referral_tiers_valid`: 1–10 tramos, sin pisarse, 0 < pct < 100. Devuelve el motivo o null. */
export function motivoTramosInvalidos(tramos: readonly Tramo[]): string | null {
    if (tramos.length < 1 || tramos.length > 10) return 'Define entre 1 y 10 tramos de edad.';
    for (const t of tramos) {
        if (t.age_min < 0) return 'La edad mínima no puede ser negativa.';
        if (t.age_max !== null && t.age_max < t.age_min) return 'En un tramo, la edad máxima no puede ser menor que la mínima.';
        if (!(t.pct > 0 && t.pct < 100)) return 'El porcentaje de cada tramo debe estar entre 1 y 99.';
    }
    for (let i = 0; i < tramos.length; i++) {
        for (let j = i + 1; j < tramos.length; j++) {
            const a = tramos[i];
            const b = tramos[j];
            if (a.age_min <= (b.age_max ?? 1000) && b.age_min <= (a.age_max ?? 1000)) {
                return 'Los tramos de edad no pueden pisarse.';
            }
        }
    }
    return null;
}

// ─── Esquemas Zod (cuerpos y consultas) ──────────────────────────────────────

const Uuid = (msg: string) => z.string().uuid(msg);
const Fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe ser AAAA-MM-DD.');

export const TramoSchema = z.object({
    age_min: z.number().int('La edad debe ser un número entero.').min(0, 'La edad mínima no puede ser negativa.').max(120),
    age_max: z.number().int('La edad debe ser un número entero.').min(0).max(120).nullable(),
    pct: z.number().gt(0, 'El porcentaje debe ser mayor que 0.').lt(100, 'El porcentaje debe ser menor que 100.'),
});

export const CampanaSchema = z.object({
    name: z.string().trim().min(1, 'Ponle un nombre a la campaña.').max(120, 'El nombre es muy largo (máximo 120).'),
    active: z.boolean(),
    tiers: z.array(TramoSchema).min(1, 'Define al menos un tramo de edad.').max(10, 'Máximo 10 tramos.'),
    starts_on: Fecha.nullish(),
    ends_on: Fecha.nullish(),
    max_pending: z.number().int().min(1, 'El tope debe ser al menos 1.').max(36, 'El tope máximo es 36.').default(12),
    require_referrer_current: z.boolean().default(true),
}).superRefine((c, ctx) => {
    const motivo = motivoTramosInvalidos(c.tiers);
    if (motivo) ctx.addIssue({ code: 'custom', path: ['tiers'], message: motivo });
    if (c.starts_on && c.ends_on && c.ends_on < c.starts_on) {
        ctx.addIssue({ code: 'custom', path: ['ends_on'], message: 'La fecha final no puede ser anterior a la inicial.' });
    }
});
export type CampanaInput = z.infer<typeof CampanaSchema>;

export const RegistrarReferidoSchema = z.object({
    referred_enrollment_id: Uuid('Inscripción del referido inválida.'),
    referrer_enrollment_id: Uuid('Inscripción del referente inválida.').nullish(),
    referrer_profile_id: Uuid('Persona referente inválida.').nullish(),
    referrer_name_text: z.string().trim().max(120, 'El nombre es muy largo (máximo 120).').nullish(),
}).refine(
    (b) => !!(b.referrer_enrollment_id || b.referrer_profile_id || (b.referrer_name_text && b.referrer_name_text.length > 0)),
    { message: 'Indica quién refirió (buscador o nombre).', path: ['referrer_name_text'] },
);
export type RegistrarReferidoInput = z.infer<typeof RegistrarReferidoSchema>;

export const ActualizarReferidoSchema = z.object({
    action: z.enum(['vincular', 'cambiar_inscripcion', 'anular'], { message: 'Acción inválida.' }),
    referrer_enrollment_id: Uuid('Inscripción del referente inválida.').nullish(),
    referrer_profile_id: Uuid('Persona referente inválida.').nullish(),
    referrer_name_text: z.string().trim().max(120).nullish(),
    reason: z.string().trim().max(200, 'El motivo es muy largo (máximo 200).').nullish(),
}).superRefine((b, ctx) => {
    if ((b.action === 'vincular' || b.action === 'cambiar_inscripcion')
        && !b.referrer_enrollment_id && !b.referrer_profile_id) {
        ctx.addIssue({ code: 'custom', path: ['referrer_profile_id'], message: 'Indica el referente (persona o inscripción).' });
    }
    if (b.action === 'cambiar_inscripcion' && !b.referrer_enrollment_id) {
        ctx.addIssue({ code: 'custom', path: ['referrer_enrollment_id'], message: 'Indica la inscripción donde se aplica el descuento.' });
    }
});
export type ActualizarReferidoInput = z.infer<typeof ActualizarReferidoSchema>;

export const ESTADOS = ['sin_confirmar', 'pendiente', 'ganado', 'aplicado', 'anulado', 'vencido'] as const;
export const InformeQuerySchema = z.object({
    year: z.coerce.number().int('El año debe ser un número entero.').min(2020).max(2100).optional(),
    month: z.coerce.number().int('El mes debe ser un número entero.').min(1, 'El mes va de 1 a 12.').max(12, 'El mes va de 1 a 12.').optional(),
    status: z.enum(ESTADOS, { message: 'Estado inválido.' }).optional(),
    referred_enrollment_id: Uuid('Inscripción inválida.').optional(),
}).refine((q) => q.month === undefined || q.year !== undefined, { message: 'Para filtrar por mes indica también el año.', path: ['year'] });
export type InformeQuery = z.infer<typeof InformeQuerySchema>;

// ─── Errores ─────────────────────────────────────────────────────────────────

export class ReferidosError extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(message);
    }
}

const MENSAJES: Record<string, [number, string]> = {
    REF_CAMPANA_INACTIVA: [409, 'La campaña de referidos de esta escuela está apagada.'],
    REF_FUERA_DE_VIGENCIA: [409, 'La campaña de referidos no está vigente en esta fecha.'],
    REF_SIN_REFERENTE: [422, 'Indica quién refirió (buscador o nombre).'],
    REF_NO_ES_NUEVO: [409, 'Este deportista ya tuvo inscripción en la escuela en los últimos 12 meses: no cuenta como referido nuevo.'],
    REF_SIN_FECHA_NACIMIENTO: [422, 'Falta la fecha de nacimiento del deportista para calcular el descuento.'],
    REF_AUTOREFERIDO: [422, 'Un deportista no puede referirse a sí mismo.'],
    REF_MISMA_FAMILIA: [422, 'El referente no puede ser de la misma familia (hermanos ya tiene su propio descuento).'],
    REF_REFERENTE_INACTIVO: [409, 'El referente no tiene una inscripción activa.'],
    REF_ESTADO_FINAL: [409, 'Este referido ya no se puede modificar (aplicado, anulado o vencido).'],
    REF_TRAMOS_INVALIDOS: [422, 'Los tramos de edad no son válidos.'],
    REF_ACCION_INVALIDA: [422, 'Acción inválida.'],
    REF_MES_INVALIDO: [422, 'El mes va de 1 a 12.'],
    REF_INSCRIPCION_NO_ENCONTRADA: [404, 'No encontramos esa inscripción en tu escuela.'],
    REF_REFERENTE_NO_ENCONTRADO: [404, 'No encontramos al referente en tu escuela.'],
    REF_NO_ENCONTRADO: [404, 'No encontramos ese referido.'],
};

interface ErrorRpc { code?: string; message?: string }

/** Traduce el error de la base (códigos REF_*, SQLSTATE) a un ReferidosError en español. */
export function mapearErrorRpc(error: ErrorRpc | null | undefined): ReferidosError {
    const msg = error?.message ?? '';
    const ref = /REF_[A-Z_]+/.exec(msg)?.[0];
    if (ref && MENSAJES[ref]) {
        const [status, texto] = MENSAJES[ref];
        return new ReferidosError(status, ref, texto);
    }
    switch (error?.code) {
        case '42501': return new ReferidosError(403, 'SIN_PERMISO', 'No tienes permiso para administrar los referidos de esta escuela.');
        case '23505': return new ReferidosError(409, 'YA_REGISTRADO', 'Este deportista ya tiene un referente registrado.');
        case '23514': return new ReferidosError(422, 'VALIDACION', 'Algún dato no cumple las reglas de la campaña.');
        case '22023': return new ReferidosError(422, 'VALIDACION', 'Algún dato no es válido.');
        case 'PGRST202': case '42883': case '42P01':
            return new ReferidosError(503, 'MIGRACION_PENDIENTE', 'Los referidos aún no están disponibles en este ambiente.');
        default:
            return new ReferidosError(500, 'ERROR_INTERNO', 'No se pudo completar la operación. Intenta de nuevo.');
    }
}

// ─── Llamadas a la base ──────────────────────────────────────────────────────

async function rpc<T>(nombre: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.rpc(nombre, args);
    if (error) throw mapearErrorRpc(error);
    return data as T;
}

export interface CampanaFila extends Omit<CampanaInput, 'starts_on' | 'ends_on'> {
    id: string;
    school_id: string;
    kind: 'referral';
    starts_on: string | null;
    ends_on: string | null;
    reward_months: number;
    updated_at: string;
}

export async function leerCampana(schoolId: string): Promise<CampanaFila | null> {
    const { data, error } = await supabase
        .from('school_discount_campaigns')
        .select('*')
        .eq('school_id', schoolId)
        .eq('kind', 'referral')
        .maybeSingle();
    if (error) throw mapearErrorRpc(error);
    return (data as CampanaFila | null) ?? null;
}

export function guardarCampana(schoolId: string, actor: string, c: CampanaInput) {
    return rpc<CampanaFila>('upsert_school_discount_campaign', {
        p_school_id: schoolId,
        p_name: c.name,
        p_active: c.active,
        p_tiers: c.tiers,
        p_starts_on: c.starts_on ?? null,
        p_ends_on: c.ends_on ?? null,
        p_max_pending: c.max_pending,
        p_require_referrer_current: c.require_referrer_current,
        p_actor: actor,
    });
}

export type ResultadoRegistro =
    | { ok: true; referral: Record<string, unknown> }
    | { ok: false; califica: false; motivo: string; edad: number };

/**
 * Registra el referido. `actor` null = el bot / un proceso interno (sin usuario): la RPC solo lo
 * acepta por service_role. Las rutas de la BFF SIEMPRE pasan al usuario.
 */
export function registrarReferido(schoolId: string, actor: string | null, b: RegistrarReferidoInput) {
    return rpc<ResultadoRegistro>('register_enrollment_referral', {
        p_school_id: schoolId,
        p_referred_enrollment_id: b.referred_enrollment_id,
        p_referrer_enrollment_id: b.referrer_enrollment_id ?? null,
        p_referrer_profile_id: b.referrer_profile_id ?? null,
        p_referrer_name_text: b.referrer_name_text ?? null,
        p_actor: actor,
    });
}

export function actualizarReferido(referralId: string, actor: string, b: ActualizarReferidoInput) {
    return rpc<{ ok: true; referral: Record<string, unknown> }>('update_enrollment_referral', {
        p_referral_id: referralId,
        p_action: b.action,
        p_referrer_enrollment_id: b.referrer_enrollment_id ?? null,
        p_referrer_profile_id: b.referrer_profile_id ?? null,
        p_referrer_name_text: b.referrer_name_text ?? null,
        p_reason: b.reason ?? null,
        p_actor: actor,
    });
}

export interface InformeReferidos {
    school_id: string;
    year: number | null;
    month: number | null;
    rows: Array<Record<string, unknown>>;
    totals: { total: number; por_estado: Record<string, number>; dejado_de_cobrar: number };
    by_month: Array<{ year: number; month: number; aplicados: number; ganados_por_aplicar: number; dejado_de_cobrar: number }>;
}

export function informeReferidos(schoolId: string, actor: string, q: InformeQuery) {
    return rpc<InformeReferidos>('referrals_report', {
        p_school_id: schoolId,
        p_year: q.year ?? null,
        p_month: q.month ?? null,
        p_actor: actor,
        p_status: q.status ?? null,
        p_referred_enrollment_id: q.referred_enrollment_id ?? null,
    });
}

export interface GanadoDetalle {
    referral_id: string;
    pct: number;
    apply_year: number;
    apply_month: number;
    referrer_user_id: string | null;
    referred_name: string | null;
}
export interface ResultadoCalificacion {
    ok: true;
    campana_activa: boolean;
    ganados: number;
    anulados: number;
    vencidos: number;
    detalle: GanadoDetalle[];
}

/** Lote de UNA escuela (lo usa el job diario; sin actor = service_role). */
export function calificarReferidos(schoolId: string, actor: string | null = null) {
    return rpc<ResultadoCalificacion>('qualify_enrollment_referrals', { p_school_id: schoolId, p_actor: actor });
}

// ─── Aviso a quien refiere (texto puro) ──────────────────────────────────────

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function nombreDelMes(mes: number): string {
    return MESES[mes - 1] ?? String(mes);
}

export function pctLegible(pct: number): string {
    return Number.isInteger(pct) ? String(pct) : String(pct);
}

export function claveAvisoGanado(referralId: string): string {
    return `referido-ganado:${referralId}`;
}

export function avisoGanado(d: GanadoDetalle): { titulo: string; mensaje: string } {
    const quien = d.referred_name ? ` por referir a ${d.referred_name}` : ' por tu referido';
    return {
        titulo: '¡Ganaste un descuento!',
        mensaje: `¡Ganaste ${pctLegible(Number(d.pct))} % en tu mensualidad de ${nombreDelMes(d.apply_month)}${quien}!`,
    };
}
