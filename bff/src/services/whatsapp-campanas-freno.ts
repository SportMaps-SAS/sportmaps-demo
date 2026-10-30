/**
 * whatsapp-campanas-freno — cuándo una campaña de marketing se detiene sola
 * para cuidar el número de la escuela (plan B5 T3, docs/specs/whatsapp-monster-plan-B5.md).
 *
 * POR QUÉ EXISTE
 *
 * En Coexistence el número de la campaña es el WhatsApp de diario de la
 * escuela. Si la gente bloquea o reporta, Meta baja la calidad, luego el tope
 * de envío y al final restringe el número: la escuela se queda sin cobranza y
 * sin atender a sus familias. El freno pausa ANTES de llegar ahí.
 *
 * LAS SEÑALES (forma real, base viva 2026-10-30)
 *
 *  1. Graph `quality_rating` del número: YELLOW o RED pausa. Es la única fuente
 *     del COLOR del número (el webhook no lo trae).
 *  2. `phone_number_quality_update` con `event` FLAGGED o DOWNGRADE posterior a
 *     la aprobación de la campaña. Trae `{event, current_limit, old_limit}`
 *     sin color; ONBOARDING, UPGRADE y UNFLAGGED NO frenan.
 *  3. La plantilla de la campaña: `message_template_quality_update` YELLOW/RED,
 *     o un estado distinto de APPROVED (PAUSED, DISABLED…).
 *  4. Bajas > 5 % o fallos > 20 % de lo enviado en 24 h.
 *
 * Lo que NO frena: `account_update` llega a diario con `ACCOUNT_DELETED`
 * (23→29-oct, de otras cuentas de la app); frenar con «cualquier
 * account_update» pausaría siempre. Por eso ni se lee.
 *
 * Pausar = `whatsapp_campanas_ajustes.pausada_at` + campaña 'pausada' + aviso a
 * la administración + correo a soporte. Reanudar es SIEMPRE a mano.
 */

import { supabase } from '../config/supabase';
import { decryptToken } from './whatsapp.service';

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/** Umbrales del plan B5: bajas sobre lo enviado y fallos sobre lo enviado, en 24 h. */
export const UMBRAL_BAJAS = 0.05;
export const UMBRAL_FALLOS = 0.20;
/**
 * Denominador mínimo de las tasas. Con 3 envíos, una baja sería el 33 % y
 * pausaría el piloto por una sola persona; con 20 de base, una baja entre los
 * primeros 10 (5 %) no frena y dos (10 %) sí.
 */
export const MUESTRA_MINIMA = 20;

/** Eventos del número que SÍ frenan. Los demás (ONBOARDING, UPGRADE, UNFLAGGED) no. */
const EVENTOS_DE_NUMERO_QUE_FRENAN = new Set(['FLAGGED', 'DOWNGRADE']);
const COLORES_QUE_FRENAN = new Set(['YELLOW', 'RED']);

export type MotivoFreno =
    | 'calidad_del_numero'      // Graph quality_rating YELLOW/RED
    | 'numero_marcado'          // phone_number_quality_update FLAGGED/DOWNGRADE
    | 'calidad_de_plantilla'    // message_template_quality_update YELLOW/RED
    | 'plantilla_no_aprobada'   // la plantilla dejó de estar APPROVED
    | 'muchas_bajas'
    | 'muchos_fallos';

/** Lo que ve la escuela en el aviso. */
export const MOTIVO_LEGIBLE: Record<MotivoFreno, string> = {
    calidad_del_numero: 'Meta bajó la calidad de tu número',
    numero_marcado: 'Meta marcó tu número por la reacción de los destinatarios',
    calidad_de_plantilla: 'Meta bajó la calidad del mensaje de la campaña',
    plantilla_no_aprobada: 'el mensaje de la campaña ya no está aprobado por Meta',
    muchas_bajas: 'muchas personas pidieron no recibir más mensajes',
    muchos_fallos: 'muchos mensajes no se pudieron entregar',
};

export interface EventoDeCuenta {
    field: string;
    nuevo_estado?: string | null;
    motivo?: string | null;
    template_name?: string | null;
    payload?: any;
    created_at: string;
}

export interface SenalesDeCalidad {
    /** Graph `quality_rating` del número (GREEN/YELLOW/RED/UNKNOWN) o null si no se pudo leer. */
    calidadNumero: string | null;
    /** Eventos `phone_number_quality_update` y `message_template_quality_update` de la integración. */
    eventos: EventoDeCuenta[];
    /** Desde cuándo cuentan los eventos (aprobación de la campaña). */
    desde: string | null;
    plantilla: { nombre: string; estado: string | null };
    /** Envíos de las últimas 24 h de la integración, por estado final. */
    enviados24h: number;
    bajas24h: number;
    fallidos24h: number;
}

export type DecisionFreno = { frenar: false } | { frenar: true; motivo: MotivoFreno; detalle: string };

/** El `event` real de un phone_number_quality_update (el campo `motivo` lo trae; si no, el payload). */
function eventoDeNumero(e: EventoDeCuenta): string {
    return String(e.payload?.value?.event ?? e.motivo ?? '').toUpperCase();
}

/** El color de un message_template_quality_update. */
function colorDePlantilla(e: EventoDeCuenta): string {
    return String(e.payload?.value?.new_quality_score ?? e.nuevo_estado ?? '').toUpperCase();
}

function nombreDePlantillaDelEvento(e: EventoDeCuenta): string | null {
    return (e.template_name ?? e.payload?.value?.message_template_name ?? null) as string | null;
}

/**
 * ¿Hay que frenar? Pura: recibe las señales ya leídas. El orden importa solo
 * para el motivo que se informa (el más grave primero).
 */
export function evaluarFreno(s: SenalesDeCalidad): DecisionFreno {
    const calidad = String(s.calidadNumero ?? '').toUpperCase();
    if (COLORES_QUE_FRENAN.has(calidad)) {
        return { frenar: true, motivo: 'calidad_del_numero', detalle: `quality_rating ${calidad}` };
    }

    const desde = s.desde ? new Date(s.desde).getTime() : 0;
    const posteriores = s.eventos.filter((e) => new Date(e.created_at).getTime() >= desde);

    for (const e of posteriores) {
        if (e.field !== 'phone_number_quality_update') continue;
        const evento = eventoDeNumero(e);
        if (EVENTOS_DE_NUMERO_QUE_FRENAN.has(evento)) {
            return { frenar: true, motivo: 'numero_marcado', detalle: `phone_number_quality_update ${evento}` };
        }
    }

    if (s.plantilla.estado !== 'APPROVED') {
        return { frenar: true, motivo: 'plantilla_no_aprobada', detalle: `${s.plantilla.nombre}: ${s.plantilla.estado ?? 'sin estado'}` };
    }
    for (const e of posteriores) {
        if (e.field !== 'message_template_quality_update') continue;
        if (nombreDePlantillaDelEvento(e) !== s.plantilla.nombre) continue;
        const color = colorDePlantilla(e);
        if (COLORES_QUE_FRENAN.has(color)) {
            return { frenar: true, motivo: 'calidad_de_plantilla', detalle: `${s.plantilla.nombre}: ${color}` };
        }
    }

    const base = Math.max(s.enviados24h, MUESTRA_MINIMA);
    if (s.bajas24h / base > UMBRAL_BAJAS) {
        return { frenar: true, motivo: 'muchas_bajas', detalle: `${s.bajas24h} bajas de ${s.enviados24h} envíos en 24 h` };
    }
    if (s.fallidos24h / base > UMBRAL_FALLOS) {
        return { frenar: true, motivo: 'muchos_fallos', detalle: `${s.fallidos24h} fallos de ${s.enviados24h} envíos en 24 h` };
    }
    return { frenar: false };
}

// ─── Lectura de las señales ──────────────────────────────────────────────────

/** Estados de envío que cuentan como «salió» para las tasas. */
const SALIERON = new Set(['enviado', 'incierto', 'respondio_si', 'respondio_luego', 'baja', 'fallido']);

export interface IntegracionParaFreno {
    id: string;
    waba_id: string | null;
    phone_number_id: string;
    access_token_encrypted: string | null;
}

/** GET del color del número. Una llamada por tick y número; null si Graph no responde. */
export async function calidadDelNumero(integ: IntegracionParaFreno): Promise<string | null> {
    if (!integ.access_token_encrypted) return null;
    let token: string;
    try {
        token = decryptToken(integ.access_token_encrypted);
    } catch {
        return null;
    }
    try {
        const r = await fetch(`${GRAPH}/${integ.phone_number_id}?fields=quality_rating`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
        });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) return null;
        return typeof j?.quality_rating === 'string' ? j.quality_rating : null;
    } catch {
        return null;
    }
}

/**
 * Lee las señales de una campaña. Nunca lanza: lo que no se puede leer cuenta
 * como «sin señal» (salvo el estado de la plantilla, que lo trae quien llama).
 */
export async function leerSenales(p: {
    integ: IntegracionParaFreno;
    plantilla: { nombre: string; estado: string | null };
    aprobadaAt: string | null;
    ahora: number;
    /** Cache por tick: el color del número se pregunta una vez aunque haya dos campañas. */
    calidadCache?: Map<string, string | null>;
}): Promise<SenalesDeCalidad> {
    let calidadNumero: string | null;
    if (p.calidadCache?.has(p.integ.id)) {
        calidadNumero = p.calidadCache.get(p.integ.id) ?? null;
    } else {
        calidadNumero = await calidadDelNumero(p.integ);
        p.calidadCache?.set(p.integ.id, calidadNumero);
    }

    let eventos: EventoDeCuenta[] = [];
    try {
        let q = supabase.from('whatsapp_account_events')
            .select('field, nuevo_estado, motivo, template_name, payload, created_at')
            .in('field', ['phone_number_quality_update', 'message_template_quality_update']);
        q = p.integ.waba_id
            ? q.or(`integration_id.eq.${p.integ.id},waba_id.eq.${p.integ.waba_id}`)
            : q.eq('integration_id', p.integ.id);
        if (p.aprobadaAt) q = q.gte('created_at', p.aprobadaAt);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(50);
        if (!error && Array.isArray(data)) eventos = data as EventoDeCuenta[];
    } catch { /* sin eventos */ }

    // Por `updated_at` y no por `enviado_at`: un envío que Graph rechazó tres
    // veces queda 'fallido' sin haber salido nunca, y también cuenta.
    let enviados24h = 0, bajas24h = 0, fallidos24h = 0;
    try {
        const { data, error } = await supabase.from('whatsapp_campana_envios')
            .select('estado')
            .eq('integration_id', p.integ.id)
            .gte('updated_at', new Date(p.ahora - 24 * 3600_000).toISOString())
            .limit(5000);
        if (!error && Array.isArray(data)) {
            for (const f of data as { estado: string }[]) {
                if (!SALIERON.has(f.estado)) continue;
                enviados24h++;
                if (f.estado === 'baja') bajas24h++;
                if (f.estado === 'fallido') fallidos24h++;
            }
        }
    } catch { /* sin tasas */ }

    return {
        calidadNumero, eventos, desde: p.aprobadaAt, plantilla: p.plantilla,
        enviados24h, bajas24h, fallidos24h,
    };
}

/** Lee y decide. */
export async function frenoDeCalidad(p: Parameters<typeof leerSenales>[0]): Promise<DecisionFreno> {
    return evaluarFreno(await leerSenales(p));
}
