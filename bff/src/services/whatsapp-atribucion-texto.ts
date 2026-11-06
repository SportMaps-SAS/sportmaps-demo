/**
 * whatsapp-atribucion-texto — atribuye un chat a un anuncio o canal por el TEXTO del
 * primer mensaje cuando Meta no manda `referral`.
 *
 * Por qué existe (Monster 2026-11-04/06): Meta contó 60 conversaciones de los anuncios y a
 * WhatsApp entraron 62 chats nuevos, pero solo 28 traían la marca del anuncio. Los otros 34
 * escribieron un texto propio o entraron por un enlace de perfil. Si cada anuncio y cada canal
 * deja una frase distinta (o una marca entre paréntesis como «(Instagram)»), podemos
 * reconocerlos igual.
 *
 * Cómo funciona:
 *   · Las reglas viven en `whatsapp_anuncio_regla` (por escuela; school_id NULL = plataforma).
 *   · Solo se mira el PRIMER mensaje entrante de la conversación, y solo si no trae `referral`.
 *   · Si calza una regla y la conversación no tiene atribución, se guarda en
 *     `whatsapp_atribucion` con source_id 'texto:<etiqueta>' (source_type 'texto'). Un
 *     `referral` real siempre manda: nunca se pisa una atribución existente.
 *   · Nunca lanza ni frena el webhook; sin la tabla (migración sin aplicar) no hace nada.
 *
 * Plan: docs/plan-anuncios-atribucion-multiescuela-2026-11-06.md, fase 1.
 */

import { supabase } from '../config/supabase';
import { esMigracionPendiente } from './ventas-servicios.service';

export type TipoRegla = 'anuncio' | 'canal';

export interface ReglaAtribucion {
    id: string;
    school_id: string | null;
    patron: string;
    etiqueta: string;
    tipo: TipoRegla;
}

/**
 * Minúsculas, sin tildes y sin signos de puntuación; se conservan letras, números y paréntesis
 * (para poder usar marcas como «(instagram)»). Pura.
 */
export function normalizarParaRegla(t: string | null | undefined): string {
    return (t || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Texto de la etiqueta → pedazo seguro para el source_id. Pura. */
export function slugDeEtiqueta(etiqueta: string): string {
    const s = (etiqueta || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return s.slice(0, 80) || 'sin-nombre';
}

/** El id que queda en `whatsapp_atribucion.primer_source_id`. Pura. */
export function sourceIdDeRegla(r: Pick<ReglaAtribucion, 'etiqueta'>): string {
    return `texto:${slugDeEtiqueta(r.etiqueta)}`;
}

/**
 * La regla que calza con el mensaje. Gana la de anuncio sobre la de canal (más específica); luego
 * la frase más larga; a igualdad, la de la escuela sobre la de la plataforma. Pura.
 */
export function buscarRegla(texto: string | null | undefined, reglas: readonly ReglaAtribucion[]): ReglaAtribucion | null {
    const t = ` ${normalizarParaRegla(texto)} `;
    if (t.trim() === '') return null;
    let mejor: { r: ReglaAtribucion; largo: number } | null = null;
    for (const r of reglas) {
        const p = normalizarParaRegla(r.patron);
        if (p.length < 2) continue;
        // Una frase de anuncio exige palabras completas; la marca entre paréntesis, solo contenerse.
        const calza = p.includes('(') ? t.includes(p) : t.includes(` ${p} `);
        if (!calza) continue;
        const mejorTipo = !mejor || (r.tipo === 'anuncio' && mejor.r.tipo !== 'anuncio');
        const mismoTipo = mejor && r.tipo === mejor.r.tipo;
        const masLarga = mejor && p.length > mejor.largo;
        const empateYEscuela = mejor && p.length === mejor.largo && r.school_id && !mejor.r.school_id;
        if (mejorTipo || (mismoTipo && (masLarga || empateYEscuela))) mejor = { r, largo: p.length };
    }
    return mejor ? mejor.r : null;
}

// ─── Lectura de reglas (con caché corta: el webhook no debe pegarle a la base por mensaje) ───

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; reglas: ReglaAtribucion[] }>();

/** Solo para pruebas. */
export function vaciarCacheDeReglas(): void { cache.clear(); }

function reglaDesdeFila(f: Record<string, unknown>): ReglaAtribucion | null {
    if (typeof f.id !== 'string' || typeof f.patron !== 'string' || typeof f.etiqueta !== 'string') return null;
    return {
        id: f.id,
        school_id: typeof f.school_id === 'string' ? f.school_id : null,
        patron: f.patron,
        etiqueta: f.etiqueta,
        tipo: f.tipo === 'canal' ? 'canal' : 'anuncio',
    };
}

/** Reglas activas de la escuela más las de la plataforma. Nunca lanza; sin tabla, []. */
export async function reglasDeEscuela(schoolId: string, ahora = Date.now()): Promise<ReglaAtribucion[]> {
    if (!schoolId) return [];
    const hit = cache.get(schoolId);
    if (hit && ahora - hit.at < TTL_MS) return hit.reglas;
    try {
        const { data, error } = await supabase.from('whatsapp_anuncio_regla')
            .select('id, school_id, patron, etiqueta, tipo')
            .eq('activa', true)
            .or(`school_id.eq.${schoolId},school_id.is.null`)
            .limit(200);
        if (error) {
            const pendiente = esMigracionPendiente(error) || (error as { code?: string }).code === 'PGRST205';
            if (!pendiente) console.warn('[wa-atribucion-texto] no se pudieron leer las reglas', { schoolId, code: (error as { code?: string }).code });
            cache.set(schoolId, { at: ahora, reglas: [] });
            return [];
        }
        const reglas = (Array.isArray(data) ? data : [])
            .map((f) => reglaDesdeFila(f as Record<string, unknown>))
            .filter((r): r is ReglaAtribucion => r !== null);
        cache.set(schoolId, { at: ahora, reglas });
        return reglas;
    } catch {
        return [];
    }
}

// ─── Atribución ─────────────────────────────────────────────────────────────

export type ResultadoAtribucion =
    | 'no_es_texto' | 'trae_referral' | 'sin_regla' | 'no_es_el_primero' | 'ya_atribuida' | 'atribuida' | 'error';

export interface EntradaAtribucionTexto {
    integrationId: string;
    schoolId: string;
    conversationId: string;
    contactWaId: string;
    type: string;
    texto: string | null | undefined;
    raw: unknown;
    ahora?: Date;
}

/** ¿El payload del mensaje trae `referral` (vino de un anuncio)? Pura. */
export function traeReferral(raw: unknown): boolean {
    const r = (raw as { referral?: unknown } | null | undefined)?.referral;
    return !!r && typeof r === 'object';
}

/**
 * Atribuye el chat por el texto. Solo consulta la base cuando una regla calzó (caso raro), así
 * que no suma lecturas a cada mensaje. Nunca lanza.
 */
export async function atribuirPorTexto(o: EntradaAtribucionTexto): Promise<ResultadoAtribucion> {
    try {
        if (o.type !== 'text' || !o.texto) return 'no_es_texto';
        if (traeReferral(o.raw)) return 'trae_referral';

        const regla = buscarRegla(o.texto, await reglasDeEscuela(o.schoolId));
        if (!regla) return 'sin_regla';

        // Solo el primer entrante de la conversación: una familia que vuelve a escribir meses después
        // con la misma marca no cambia de dónde llegó.
        const { data: entrantes, error: eEntr } = await supabase.from('whatsapp_messages')
            .select('id').eq('conversation_id', o.conversationId).eq('direction', 'inbound').limit(2);
        if (eEntr) return 'error';
        if (Array.isArray(entrantes) && entrantes.length > 1) return 'no_es_el_primero';

        const { data: previa, error: ePrevia } = await supabase.from('whatsapp_atribucion')
            .select('conversation_id').eq('conversation_id', o.conversationId).limit(1);
        if (ePrevia) return 'error';
        if (Array.isArray(previa) && previa.length > 0) return 'ya_atribuida';

        const cuando = (o.ahora ?? new Date()).toISOString();
        const sid = sourceIdDeRegla(regla);
        const { error } = await supabase.from('whatsapp_atribucion').upsert({
            conversation_id: o.conversationId,
            integration_id: o.integrationId,
            school_id: o.schoolId,
            contact_wa_id: o.contactWaId,
            primer_source_id: sid,
            primer_source_type: 'texto',
            primer_headline: regla.etiqueta.slice(0, 300),
            primer_body: o.texto.slice(0, 1000),
            primer_at: cuando,
            primer_historial: false,
            ultimo_source_id: sid,
            ultimo_source_type: 'texto',
            ultimo_headline: regla.etiqueta.slice(0, 300),
            ultimo_at: cuando,
            toques: 1,
        }, { onConflict: 'conversation_id', ignoreDuplicates: true });
        if (error) return 'error';
        return 'atribuida';
    } catch {
        return 'error';
    }
}
