/**
 * whatsapp-campanas-cupo — cuánto del límite de Meta puede gastar HOY una
 * campaña, dejando una RESERVA para lo que sí o sí tiene que salir.
 *
 * POR QUÉ EXISTE (2026-11-04, Monster conectado con TIER_250)
 *
 * Meta deja escribirle con plantilla (mensajes que inicia la escuela) a un
 * máximo de N personas DISTINTAS en una ventana móvil de 24 h (`messaging_limit_tier`:
 * TIER_250 → 250; negocio sin verificar se queda ahí). Responderle a quien
 * escribió en las últimas 24 h no cuenta. Si la campaña se come las 250, el
 * recordatorio de la clase de prueba, el cupo por vencer, la clase reprogramada,
 * la cobranza o el aviso del comprobante de ESE día rebotan, justo con los
 * interesados que la campaña acaba de despertar. El usuario: «antes del límite
 * debemos dejar de enviar, para esas retomadas como leads».
 *
 * LA REGLA
 *
 *   reserva          = máx(RESERVA_AVISOS_MIN, 20 % del límite)       (250 → 50; 1000 → 200)
 *   cupo de campañas = mín(tope_diario_max, límite − reserva − usados_24h)
 *
 * `usados_24h` = personas distintas a las que la integración les mandó una
 * PLANTILLA en las últimas 24 h (todas: cobranza, recordatorios, campañas). Es
 * conservador: cuenta también plantillas que salieron con la ventana abierta y
 * que Meta no cobra contra el límite.
 *
 * Quién lo hace cumplir: `wa_campana_tomar_lote` (M3) ya descuenta, bajo su
 * candado por integración, las plantillas de 24 h y los envíos en curso de
 * `p_limite_meta`; el tick le pasa `límite − reserva` en vez del límite. Así el
 * freno es atómico entre los 3 BFF. Este módulo calcula lo mismo para no pedir
 * un lote que no cabe y para mostrarlo en la pestaña Campañas. Al liberarse la
 * ventana móvil, el siguiente tick vuelve a tener cupo: no hay que reanudar nada.
 *
 * El límite: Graph `messaging_limit_tier` (la misma llamada que pide el color
 * del número para el freno), en caché 1 h por proceso; si Graph no responde, el
 * último `phone_number_quality_update` (`current_limit`) o
 * `business_capability_update` (`max_daily_conversation_per_phone`) guardado por
 * el webhook; sin dato, 250 (el más bajo de un número nuevo).
 *
 * Reserva por escuela: hoy es esta constante. Si alguna escuela necesita otra,
 * la propuesta es `whatsapp_campanas_ajustes.reserva_avisos int NULL` (NULL = la
 * regla de arriba), sin crear todavía.
 */

import { supabase } from '../config/supabase';
import { decryptToken } from './whatsapp.service';

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/** Sin dato de Meta, el tope más bajo de un número nuevo con Coexistence. */
export const LIMITE_META_POR_DEFECTO = 250;
/** Piso de la reserva para avisos e interesados. */
export const RESERVA_AVISOS_MIN = 30;
/** Fracción del límite que se reserva (si da más que el piso). */
export const RESERVA_AVISOS_FRACCION = 0.2;
/** Cuánto se confía en el `messaging_limit_tier` leído de Graph. */
export const CACHE_LIMITE_MS = 3600_000;
/** Si Graph falló, cuánto se espera antes de volver a preguntarle. */
const CACHE_FALLO_MS = 10 * 60_000;
const VENTANA_MS = 24 * 3600_000;

/** 'TIER_250' → 250, 'TIER_1K' → 1000, 'TIER_UNLIMITED' → 1 000 000; un número suelto, tal cual. Pura. */
export function limiteDeTier(tier: string | number | null | undefined): number | null {
    if (typeof tier === 'number') return Number.isInteger(tier) && tier > 0 ? tier : null;
    const t = String(tier ?? '').toUpperCase().trim();
    if (t === 'TIER_UNLIMITED' || t === 'UNLIMITED') return 1_000_000;
    if (/^\d+$/.test(t)) return Number(t) > 0 ? Number(t) : null;
    const m = t.match(/^TIER_(\d+)(K)?$/);
    if (!m) return null;
    return Number(m[1]) * (m[2] ? 1000 : 1);
}

/** Inicio del día de hoy en Bogotá (UTC-5, sin horario de verano), como instante. Pura. */
export function inicioDelDiaCot(ahora: Date): Date {
    const cot = new Date(ahora.getTime() - 5 * 3600_000);
    return new Date(Date.UTC(cot.getUTCFullYear(), cot.getUTCMonth(), cot.getUTCDate()) + 5 * 3600_000);
}

/** La reserva para avisos e interesados: máx(30, 20 % del límite), nunca más que el límite. Pura. */
export function reservaDeAvisos(limite: number): number {
    const l = Math.max(0, Math.floor(limite));
    return Math.min(l, Math.max(RESERVA_AVISOS_MIN, Math.ceil(l * RESERVA_AVISOS_FRACCION)));
}

export type FuenteLimite = 'graph' | 'evento' | 'por_defecto';

export interface CupoMeta {
    /** Personas distintas por 24 h que Meta deja escribir con plantilla. */
    limite: number;
    tier: string | null;
    fuente: FuenteLimite;
    /** Lo que nunca usa una campaña. */
    reserva: number;
    /** Personas distintas con plantilla en las últimas 24 h (null = no se pudo contar). */
    usados24h: number | null;
    /** límite − reserva: lo máximo que las campañas pueden ocupar de la ventana. */
    limiteCampanas: number;
    /** límite − reserva − usados_24h (≥ 0): lo que las campañas pueden mandar ya. */
    disponibleCampanas: number;
}

/** Arma el cupo con el límite y lo usado. Pura. */
export function cupoMeta(p: { limite: number; tier?: string | null; fuente?: FuenteLimite; usados24h: number | null }): CupoMeta {
    const limite = Math.max(0, Math.floor(p.limite));
    const reserva = reservaDeAvisos(limite);
    const limiteCampanas = Math.max(0, limite - reserva);
    return {
        limite, tier: p.tier ?? null, fuente: p.fuente ?? 'por_defecto', reserva,
        usados24h: p.usados24h,
        limiteCampanas,
        disponibleCampanas: Math.max(0, limiteCampanas - (p.usados24h ?? 0)),
    };
}

export interface CupoDeHoy extends CupoMeta {
    topeDiario: number;
    /** Envíos de campaña de la escuela desde las 00:00 de Bogotá. */
    enviadosHoy: number;
    /** «de Y»: mín(tope diario, límite − reserva). */
    cupoHoy: number;
    /** «X»: lo que todavía puede salir hoy (tope y ventana de Meta). */
    disponibleHoy: number;
}

/** Lo que ve la escuela: «Cupo de hoy: X de Y · reserva Z». Pura. */
export function cupoDeHoy(meta: CupoMeta, topeDiario: number, enviadosHoy: number): CupoDeHoy {
    const cupoHoy = Math.min(Math.max(0, topeDiario), meta.limiteCampanas);
    const disponibleHoy = Math.max(0, Math.min(cupoHoy - enviadosHoy, meta.disponibleCampanas));
    return { ...meta, topeDiario, enviadosHoy, cupoHoy, disponibleHoy };
}

// ─── El número en Graph (color y límite en UNA llamada) ──────────────────────

export interface IntegracionDelNumero {
    id: string;
    phone_number_id: string;
    access_token_encrypted: string | null;
}

export interface EstadoDelNumero { calidad: string | null; tier: string | null }

const cacheTier = new Map<string, { tier: string | null; vence: number }>();

/** Solo para pruebas. */
export function _olvidarLimites(): void { cacheTier.clear(); }

/** Guarda en caché el tier que trajo Graph (lo llama también el freno). */
export function recordarTier(integrationId: string, tier: string | null, ahora = Date.now()): void {
    const sirve = limiteDeTier(tier) !== null;
    cacheTier.set(integrationId, { tier: sirve ? tier : null, vence: ahora + (sirve ? CACHE_LIMITE_MS : CACHE_FALLO_MS) });
}

/**
 * GET `/{phone_number_id}?fields=quality_rating,messaging_limit_tier`. null si
 * no hay token o Graph no responde. Nunca lanza.
 */
export async function estadoDelNumero(integ: IntegracionDelNumero): Promise<EstadoDelNumero | null> {
    if (!integ.access_token_encrypted) return null;
    let token: string;
    try {
        token = decryptToken(integ.access_token_encrypted);
    } catch {
        return null;
    }
    try {
        const r = await fetch(`${GRAPH}/${integ.phone_number_id}?fields=quality_rating,messaging_limit_tier`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
        });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) return null;
        return {
            calidad: typeof j?.quality_rating === 'string' ? j.quality_rating : null,
            tier: typeof j?.messaging_limit_tier === 'string' ? j.messaging_limit_tier : null,
        };
    } catch {
        return null;
    }
}

/** El último límite que informó el webhook (`current_limit` o `max_daily_conversation_per_phone`). Nunca lanza. */
async function limiteDeEventos(integrationId: string): Promise<{ limite: number; tier: string | null } | null> {
    try {
        const { data } = await supabase.from('whatsapp_account_events')
            .select('field, nuevo_estado, payload, created_at')
            .eq('integration_id', integrationId)
            .in('field', ['phone_number_quality_update', 'business_capability_update'])
            .order('created_at', { ascending: false })
            .limit(5);
        for (const ev of (data as any[] | null) ?? []) {
            const v = ev?.payload?.value ?? {};
            const crudo = v.current_limit ?? v.max_daily_conversation_per_phone ?? ev?.nuevo_estado;
            const limite = limiteDeTier(crudo);
            if (limite) return { limite, tier: typeof crudo === 'string' ? crudo : null };
        }
    } catch { /* sin evento */ }
    return null;
}

/** El límite de Meta del número: Graph (caché 1 h) → evento del webhook → 250. Nunca lanza. */
export async function limiteMetaDelNumero(
    integ: IntegracionDelNumero, ahora = Date.now(),
): Promise<{ limite: number; tier: string | null; fuente: FuenteLimite }> {
    let c = cacheTier.get(integ.id);
    if (!c || c.vence <= ahora) {
        const e = await estadoDelNumero(integ);
        recordarTier(integ.id, e?.tier ?? null, ahora);
        c = cacheTier.get(integ.id)!;
    }
    const deGraph = limiteDeTier(c.tier);
    if (deGraph) return { limite: deGraph, tier: c.tier, fuente: 'graph' };
    const ev = await limiteDeEventos(integ.id);
    if (ev) return { ...ev, fuente: 'evento' };
    return { limite: LIMITE_META_POR_DEFECTO, tier: null, fuente: 'por_defecto' };
}

const soloDigitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/**
 * Personas DISTINTAS a las que la integración les mandó una plantilla en las
 * últimas 24 h: las plantillas salientes del buzón (índice parcial
 * `idx_wa_msg_plantillas_salientes`) más los envíos de campaña (por si su
 * registro en el buzón falló). null si no se pudo leer. Nunca lanza.
 */
export async function destinatariosDePlantillas24h(integrationId: string, ahora = Date.now()): Promise<number | null> {
    const desde = new Date(ahora - VENTANA_MS).toISOString();
    try {
        const personas = new Set<string>();
        let sinNumero = 0;
        for (let a = 0; a < 20_000; a += 1000) {
            const { data, error } = await supabase.from('whatsapp_messages')
                .select('to_wa_id')
                .eq('integration_id', integrationId)
                .eq('direction', 'outbound')
                .eq('type', 'template')
                .gte('created_at', desde)
                .order('created_at', { ascending: true })
                .range(a, a + 999);
            if (error) return null;
            const filas = (data as { to_wa_id: string | null }[] | null) ?? [];
            for (const f of filas) {
                const n = soloDigitos(f.to_wa_id);
                if (n) personas.add(n); else sinNumero++;
            }
            if (filas.length < 1000) break;
        }
        const { data: envios, error: errEnvios } = await supabase.from('whatsapp_campana_envios')
            .select('contact_wa_id')
            .eq('integration_id', integrationId)
            .gte('enviado_at', desde)
            .limit(20_000);
        if (!errEnvios) {
            for (const e of (envios as { contact_wa_id: string }[] | null) ?? []) {
                const n = soloDigitos(e.contact_wa_id);
                if (n) personas.add(n);
            }
        }
        return personas.size + sinNumero;
    } catch {
        return null;
    }
}

/** Límite + lo usado en 24 h → el cupo de Meta de las campañas. Nunca lanza. */
export async function cupoMetaDelNumero(integ: IntegracionDelNumero, ahora = Date.now()): Promise<CupoMeta> {
    const [lim, usados24h] = await Promise.all([
        limiteMetaDelNumero(integ, ahora),
        destinatariosDePlantillas24h(integ.id, ahora),
    ]);
    return cupoMeta({ ...lim, usados24h });
}

/** Para la pestaña Campañas: el cupo de Meta + lo que la escuela ya mandó hoy. Nunca lanza. */
export async function cupoDeCampanasHoy(
    integ: IntegracionDelNumero & { school_id: string }, topeDiario: number, ahora = new Date(),
): Promise<CupoDeHoy | null> {
    try {
        const [meta, enviados] = await Promise.all([
            cupoMetaDelNumero(integ, ahora.getTime()),
            supabase.from('whatsapp_campana_envios').select('id', { count: 'exact', head: true })
                .eq('school_id', integ.school_id).gte('enviado_at', inicioDelDiaCot(ahora).toISOString()),
        ]);
        return cupoDeHoy(meta, topeDiario, (enviados as any)?.error ? 0 : Number((enviados as any)?.count ?? 0));
    } catch {
        return null;
    }
}
