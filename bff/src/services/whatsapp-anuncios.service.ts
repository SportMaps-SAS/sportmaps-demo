/**
 * whatsapp-anuncios.service — WhatsApp › Anuncios (fase 1 de
 * docs/specs/whatsapp-anuncios-atribucion.md).
 *
 * Monster prendió anuncios de Meta con clic a WhatsApp y quiere saber qué pasa
 * después del clic. El dato ya estaba: el webhook guarda el mensaje completo y,
 * si viene de un anuncio, trae `referral`. La migración 20261104115612 lo baja a
 * `whatsapp_atribucion` (primer y último toque por conversación) y arma el
 * embudo en la RPC `wa_embudo_anuncios`.
 *
 * Dos decisiones de esta capa:
 *
 *  1. La RPC se llama con el JWT del USUARIO (cliente anon + su Authorization),
 *     no con service_role: su candado está adentro (`auth.uid()` administra ESA
 *     escuela o es admin de plataforma) y con service_role respondería 42501.
 *     La ruta además autoriza antes (`administraEstaEscuela`): son dos candados
 *     y ninguno devuelve ceros creíbles.
 *  2. El mapeo «este anuncio va a…» (`whatsapp_anuncio_destino`) se lee y
 *     escribe con service role después de autorizar en la ruta. La tabla tiene
 *     RLS (lee el staff, escribe la administración) para un acceso directo
 *     futuro, pero el servicio de la escuela se valida en un trigger de la base,
 *     que también cubre al BFF.
 *
 * Lo puro (rango, normalización, validación) va arriba y está probado en
 * whatsapp-anuncios.service.test.ts.
 */

import { createClient } from '@supabase/supabase-js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/supabase';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export const DESTINOS = ['clase_prueba', 'servicio', 'persona'] as const;
export type Destino = typeof DESTINOS[number];

export interface MotivoDePago {
    motivo: string;
    servicio_id: string | null;
    servicio: string | null;
    conversaciones: number;
    pagos: number;
    monto: number;
}

export interface FilaEmbudo {
    source_id: string | null;
    source_type: string | null;
    headline: string | null;
    body: string | null;
    source_url: string | null;
    media_url: string | null;
    conversaciones: number;
    de_historial: number;
    contestaron: number;
    separaron_o_agendaron: number;
    pagaron: number;
    monto: number;
    pagos_por_motivo: MotivoDePago[];
    asistieron: number;
    matriculados: number;
    volvieron: number;
    primera_conversacion: string | null;
    ultima_conversacion: string | null;
}

export interface MapeoDestino {
    source_id: string;
    destino: Destino;
    servicio_id: string | null;
    nota: string | null;
    updated_at: string | null;
}

export interface ServicioDelCatalogo {
    id: string;
    nombre: string;
    tipo: string | null;
    activo: boolean;
}

export type Resultado<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

// ─── Rango de fechas (Bogotá) ────────────────────────────────────────────────

export const DIAS_POR_DEFECTO = 30;
/** El tope de la RPC (`p_hasta - p_desde > 400` → 22023). */
export const DIAS_MAXIMO = 400;
const DIA_MS = 24 * 3600_000;
/** Bogotá no tiene horario de verano: UTC-5 fijo. */
const OFFSET_BOGOTA_MS = -5 * 3600_000;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD de hoy en Bogotá. Pura. */
export function hoyBogota(ahora: number = Date.now()): string {
    return new Date(ahora + OFFSET_BOGOTA_MS).toISOString().slice(0, 10);
}

function sumarDias(fecha: string, dias: number): string {
    return new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
}

function esFechaValida(s: string): boolean {
    if (!FECHA.test(s)) return false;
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * Rango del panel: fechas de Bogotá, ambas incluidas. Sin `hasta` → hoy; sin
 * `desde` → los últimos 30 días hasta `hasta`. Pura.
 */
export function leerRangoAnuncios(desdeQ: unknown, hastaQ: unknown, ahora: number = Date.now()):
    { ok: true; desde: string; hasta: string } | { ok: false; error: string } {
    const leer = (v: unknown): string | null | undefined => {
        if (v === undefined || v === null || v === '') return undefined;
        const s = String(v);
        return esFechaValida(s) ? s : null;
    };
    const h = leer(hastaQ);
    const d = leer(desdeQ);
    if (h === null || d === null) return { ok: false, error: 'fecha_invalida' };
    const hasta = h ?? hoyBogota(ahora);
    const desde = d ?? sumarDias(hasta, -(DIAS_POR_DEFECTO - 1));
    if (desde > hasta) return { ok: false, error: 'rango_invalido' };
    if ((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS > DIAS_MAXIMO) {
        return { ok: false, error: 'rango_demasiado_largo' };
    }
    return { ok: true, desde, hasta };
}

// ─── Normalización de la RPC ─────────────────────────────────────────────────

const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export const FILA_VACIA: FilaEmbudo = {
    source_id: null, source_type: null, headline: null, body: null, source_url: null, media_url: null,
    conversaciones: 0, de_historial: 0, contestaron: 0, separaron_o_agendaron: 0, pagaron: 0, monto: 0,
    pagos_por_motivo: [], asistieron: 0, matriculados: 0, volvieron: 0,
    primera_conversacion: null, ultima_conversacion: null,
};

function motivos(v: unknown): MotivoDePago[] {
    if (!Array.isArray(v)) return [];
    return v.filter((m) => m && typeof m === 'object').map((m: any) => ({
        motivo: str(m.motivo) ?? 'otro',
        servicio_id: str(m.servicio_id),
        servicio: str(m.servicio),
        conversaciones: num(m.conversaciones),
        pagos: num(m.pagos),
        monto: num(m.monto),
    }));
}

function fila(r: any): FilaEmbudo {
    return {
        source_id: str(r?.source_id),
        source_type: str(r?.source_type),
        headline: str(r?.headline),
        body: str(r?.body),
        source_url: str(r?.source_url),
        media_url: str(r?.media_url),
        conversaciones: num(r?.conversaciones),
        de_historial: num(r?.de_historial),
        contestaron: num(r?.contestaron),
        separaron_o_agendaron: num(r?.separaron_o_agendaron),
        pagaron: num(r?.pagaron),
        monto: num(r?.monto),
        pagos_por_motivo: motivos(r?.pagos_por_motivo),
        asistieron: num(r?.asistieron),
        matriculados: num(r?.matriculados),
        volvieron: num(r?.volvieron),
        primera_conversacion: str(r?.primera_conversacion),
        ultima_conversacion: str(r?.ultima_conversacion),
    };
}

/** Filas de la RPC → anuncios (sin la fila total) + total. Sin total: ceros. Pura. */
export function normalizarEmbudo(data: unknown): { anuncios: FilaEmbudo[]; total: FilaEmbudo } {
    const filas = Array.isArray(data) ? data : [];
    const anuncios = filas.filter((r: any) => r && r.es_total !== true && str(r.source_id)).map(fila);
    const t = filas.find((r: any) => r && r.es_total === true);
    return { anuncios, total: t ? { ...fila(t), source_id: null } : { ...FILA_VACIA } };
}

// ─── Validación del mapeo ────────────────────────────────────────────────────

/** El id del anuncio tal como lo manda Meta (numérico; los posts traen `pagina_post`). */
export const SOURCE_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NOTA_MAX = 300;

/** Cuerpo del PUT → fila del mapeo (o el error en palabras del BFF). Pura. */
export function validarMapeo(body: unknown):
    { ok: true; valor: { destino: Destino; servicio_id: string | null; nota: string | null } }
    | { ok: false; error: string } {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const destino = String(b.destino ?? '');
    if (!(DESTINOS as readonly string[]).includes(destino)) return { ok: false, error: 'destino_invalido' };
    const servicio = typeof b.servicio_id === 'string' && b.servicio_id.trim() ? b.servicio_id.trim() : null;
    if (destino === 'servicio' && (!servicio || !UUID.test(servicio))) return { ok: false, error: 'falta_servicio' };
    const nota = typeof b.nota === 'string' && b.nota.trim() ? b.nota.trim() : null;
    if (nota && nota.length > NOTA_MAX) return { ok: false, error: 'nota_muy_larga' };
    return {
        ok: true,
        valor: { destino: destino as Destino, servicio_id: destino === 'servicio' ? servicio : null, nota },
    };
}

/** Sin la migración: la función o la tabla no existen. */
export function esMigracionPendiente(e: { code?: string; message?: string } | null | undefined): boolean {
    if (!e) return false;
    if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(String(e.code))) return true;
    return /could not find the (function|table)|does not exist/i.test(String(e.message ?? ''));
}

// ─── Acceso a datos ──────────────────────────────────────────────────────────

/**
 * El embudo por anuncio, con el JWT del usuario. `authorization` es el header
 * tal cual llegó (`Bearer …`, ya validado por requireAuth).
 */
export async function embudoDeAnuncios(authorization: string, p: {
    schoolId: string; desde: string; hasta: string; branchId: string | null;
}): Promise<Resultado<{ anuncios: FilaEmbudo[]; total: FilaEmbudo }> | { ok: false; pendiente: true }> {
    const comoUsuario = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authorization } },
        auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await comoUsuario.rpc('wa_embudo_anuncios', {
        p_school_id: p.schoolId, p_desde: p.desde, p_hasta: p.hasta, p_branch_id: p.branchId,
    });
    if (error) {
        if (esMigracionPendiente(error)) return { ok: false, pendiente: true };
        if (error.code === '42501') return { ok: false, status: 403, error: 'forbidden' };
        if (error.code === '22023') {
            return { ok: false, status: 400, error: /SEDE/.test(error.message ?? '') ? 'sede_invalida' : 'rango_invalido' };
        }
        throw new Error(`wa_embudo_anuncios: ${error.code ?? ''} ${error.message ?? ''}`);
    }
    return { ok: true, ...normalizarEmbudo(data) };
}

/** Los mapeos de la escuela. `null` si la tabla aún no existe. */
export async function mapeosDeEscuela(schoolId: string): Promise<MapeoDestino[] | null> {
    const { data, error } = await supabase.from('whatsapp_anuncio_destino')
        .select('source_id, destino, servicio_id, nota, updated_at')
        .eq('school_id', schoolId)
        .order('updated_at', { ascending: false });
    if (error) {
        if (esMigracionPendiente(error)) return null;
        throw new Error(`whatsapp_anuncio_destino: ${error.message}`);
    }
    return ((data as any[]) ?? []).map((m) => ({
        source_id: String(m.source_id), destino: m.destino as Destino, servicio_id: m.servicio_id ?? null,
        nota: m.nota ?? null, updated_at: m.updated_at ?? null,
    }));
}

/**
 * Servicios que el bot puede vender (catálogo sin evento: la inscripción a un
 * torneo no se vende por el bot). Van también los inactivos, marcados, para no
 * perder el nombre de uno que ya está mapeado.
 */
export async function serviciosDeEscuela(schoolId: string): Promise<ServicioDelCatalogo[]> {
    const { data, error } = await supabase.from('school_tournament_items')
        .select('id, name, kind, active')
        .eq('school_id', schoolId)
        .is('event_id', null)
        .order('sort_order', { ascending: true })
        .limit(200);
    if (error) throw new Error(`school_tournament_items: ${error.message}`);
    return ((data as any[]) ?? []).map((s) => ({
        id: String(s.id), nombre: String(s.name ?? ''), tipo: s.kind ?? null, activo: s.active !== false,
    }));
}

export async function sedesDeEscuela(schoolId: string): Promise<{ id: string; nombre: string }[]> {
    const { data } = await supabase.from('school_branches').select('id, name').eq('school_id', schoolId).order('name');
    return ((data as any[]) ?? []).map((s) => ({ id: String(s.id), nombre: String(s.name ?? '') }));
}

/** Crea o cambia el mapeo (uno por escuela + anuncio). El trigger valida el servicio. */
export async function guardarMapeo(
    schoolId: string, sourceId: string,
    valor: { destino: Destino; servicio_id: string | null; nota: string | null }, userId: string,
): Promise<Resultado<{ mapeo: MapeoDestino }>> {
    const { data, error } = await supabase.from('whatsapp_anuncio_destino')
        .upsert({
            school_id: schoolId, source_id: sourceId, destino: valor.destino,
            servicio_id: valor.servicio_id, nota: valor.nota, actualizado_por: userId,
        }, { onConflict: 'school_id,source_id' })
        .select('source_id, destino, servicio_id, nota, updated_at')
        .single();
    if (error) {
        if (esMigracionPendiente(error)) return { ok: false, status: 503, error: 'migracion_pendiente' };
        // SERVICIO_INVALIDO (trigger) o FK: el servicio no es de esta escuela.
        if (error.code === '23503' || /SERVICIO_INVALIDO/.test(error.message ?? '')) {
            return { ok: false, status: 400, error: 'servicio_invalido' };
        }
        if (error.code === '23514') return { ok: false, status: 400, error: 'mapeo_invalido' };
        throw new Error(`guardar mapeo: ${error.code ?? ''} ${error.message ?? ''}`);
    }
    const m = data as any;
    return {
        ok: true,
        mapeo: {
            source_id: String(m.source_id), destino: m.destino, servicio_id: m.servicio_id ?? null,
            nota: m.nota ?? null, updated_at: m.updated_at ?? null,
        },
    };
}

/** Quita el mapeo: el bot vuelve a inferir el destino por el texto del anuncio. */
export async function borrarMapeo(schoolId: string, sourceId: string): Promise<Resultado<{ borrados: number }>> {
    const { data, error } = await supabase.from('whatsapp_anuncio_destino')
        .delete()
        .eq('school_id', schoolId)
        .eq('source_id', sourceId)
        .select('source_id');
    if (error) {
        if (esMigracionPendiente(error)) return { ok: false, status: 503, error: 'migracion_pendiente' };
        throw new Error(`borrar mapeo: ${error.message}`);
    }
    return { ok: true, borrados: ((data as any[]) ?? []).length };
}
