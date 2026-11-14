/**
 * llm-usage.service — Registro ligero de lo que gasta cada llamada a un modelo.
 *
 * Hasta el 2026-10-08 el uso de Claude solo quedaba en un `console.info` de
 * llm.service y el OCR no lo guardaba en ningún lado: no había forma de saber
 * cuánto cuesta el bot de una escuela, ni por conversación. Ahora cada llamada
 * que responde bien deja una fila en `public.llm_usage` (migración
 * 20261008164445): escuela, conversación, función (bot / ocr / transcripcion /
 * sportbot), proveedor, modelo y tokens. Sin texto de nadie.
 *
 * Reglas:
 *   - BEST-EFFORT: `registrarUsoLlm` no se espera, no lanza y no demora la
 *     respuesta a la familia. Si la tabla no existe todavía (migración sin
 *     aplicar), el insert falla en silencio y se avisa UNA vez en el log.
 *   - La escuela y la conversación salen del contexto asíncrono que fija quien
 *     inicia el trabajo (`conContextoLlm`): el webhook de WhatsApp, la cola de
 *     comprobantes, Mapi. Así llm.service y ocr.service no necesitan que
 *     cada llamador les pase el school_id.
 *   - Kill-switch: DISABLE_LLM_USAGE_LOG=true.
 *
 * Los precios viven en `PRECIOS_POR_MILLON` (más abajo): cámbialos ahí.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { supabase } from '../config/supabase';

// 'sportbot' es la clave de Mapi en llm_usage: nombre viejo conservado a propósito
// (CHECK de la tabla + filas históricas). Renombrarla exige migración y reescribir el histórico.
export type FuncionLlm = 'bot' | 'ocr' | 'transcripcion' | 'sportbot' | 'pizarra_ia';

export interface ContextoUsoLlm {
    schoolId?: string | null;
    conversationId?: string | null;
    /** Función por defecto de las llamadas hechas dentro del contexto. */
    feature?: FuncionLlm;
}

const contexto = new AsyncLocalStorage<ContextoUsoLlm>();

/**
 * Corre `fn` con escuela/conversación/función para las llamadas a modelos que
 * se hagan adentro (aunque sea en un setTimeout o en otra promesa). Un contexto
 * interno hereda lo que no redefine.
 */
export function conContextoLlm<T>(ctx: ContextoUsoLlm, fn: () => T): T {
    const padre = contexto.getStore() ?? {};
    const limpio = Object.fromEntries(Object.entries(ctx).filter(([, v]) => v !== undefined));
    return contexto.run({ ...padre, ...limpio }, fn);
}

export function contextoLlmActual(): ContextoUsoLlm | undefined {
    return contexto.getStore();
}

// ─── Normalización del uso que devuelve cada API ────────────────────────────

export interface TokensUso {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

const n = (v: unknown): number => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.round(x) : 0;
};

/**
 * Lleva a un solo formato el uso de las respuestas de:
 *   - Anthropic (`usage.input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`).
 *     Ahí `input_tokens` YA excluye lo cacheado.
 *   - Gemini (`usageMetadata.promptTokenCount` incluye lo cacheado; el
 *     «thinking» se cobra como salida).
 *   - OpenAI-compatible chat/completions (`usage.prompt_tokens` incluye lo
 *     cacheado en `prompt_tokens_details.cached_tokens`) — también Groq.
 *   - OpenAI /v1/responses (`usage.input_tokens` con `input_tokens_details.cached_tokens`).
 * `input` queda SIN lo cacheado en todos, para cobrar cada parte a su precio.
 * null si la respuesta no trae uso.
 */
export function tokensDeRespuesta(json: any): TokensUso | null {
    if (!json || typeof json !== 'object') return null;
    const gm = json.usageMetadata;
    if (gm && typeof gm === 'object') {
        const cache = n(gm.cachedContentTokenCount);
        return {
            input: Math.max(0, n(gm.promptTokenCount) - cache),
            output: n(gm.candidatesTokenCount) + n(gm.thoughtsTokenCount),
            cacheRead: cache,
            cacheWrite: 0,
        };
    }
    const u = json.usage;
    if (!u || typeof u !== 'object') return null;
    if ('prompt_tokens' in u || 'completion_tokens' in u) {
        const cache = n(u.prompt_tokens_details?.cached_tokens);
        return {
            input: Math.max(0, n(u.prompt_tokens) - cache),
            output: n(u.completion_tokens),
            cacheRead: cache,
            cacheWrite: 0,
        };
    }
    if ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) {
        return {
            input: n(u.input_tokens),
            output: n(u.output_tokens),
            cacheRead: n(u.cache_read_input_tokens),
            cacheWrite: n(u.cache_creation_input_tokens),
        };
    }
    if ('input_tokens' in u || 'output_tokens' in u) {
        const cache = n(u.input_tokens_details?.cached_tokens);
        return {
            input: Math.max(0, n(u.input_tokens) - cache),
            output: n(u.output_tokens),
            cacheRead: cache,
            cacheWrite: 0,
        };
    }
    return null;
}

// ─── Registro ───────────────────────────────────────────────────────────────

export interface UsoLlm {
    feature?: FuncionLlm;
    provider: string;
    model: string;
    tokens?: TokensUso | null;
    audioSegundos?: number | null;
}

let avisoDeFalla = false;

/** Fila lista para insertar (pura: se prueba sin base). null si no hay nada que guardar. */
export function filaDeUso(uso: UsoLlm, ctx: ContextoUsoLlm | undefined): Record<string, unknown> | null {
    const t = uso.tokens;
    const audio = uso.audioSegundos != null && Number.isFinite(Number(uso.audioSegundos)) ? Number(uso.audioSegundos) : null;
    if (!t && audio === null) return null;
    return {
        school_id: ctx?.schoolId ?? null,
        conversation_id: ctx?.conversationId ?? null,
        feature: uso.feature ?? ctx?.feature ?? 'bot',
        provider: String(uso.provider || 'desconocido').slice(0, 40),
        model: String(uso.model || 'desconocido').slice(0, 120),
        input_tokens: t?.input ?? 0,
        output_tokens: t?.output ?? 0,
        cache_read_tokens: t?.cacheRead ?? 0,
        cache_write_tokens: t?.cacheWrite ?? 0,
        audio_segundos: audio,
    };
}

/**
 * Guarda el uso de UNA llamada que respondió. No se espera ni lanza: nunca
 * rompe el flujo que llama. Devuelve la promesa solo para las pruebas.
 */
export function registrarUsoLlm(uso: UsoLlm): Promise<void> {
    try {
        if (process.env.DISABLE_LLM_USAGE_LOG === 'true') return Promise.resolve();
        // Las pruebas del bot mockean supabase con cadenas estrictas: un insert
        // inesperado les cambiaría los conteos. Solo se registra si la prueba lo pide.
        if (process.env.VITEST && process.env.LLM_USAGE_EN_PRUEBAS !== 'true') return Promise.resolve();
        const fila = filaDeUso(uso, contexto.getStore());
        if (!fila) return Promise.resolve();
        return Promise.resolve(supabase.from('llm_usage').insert(fila))
            .then((r: any) => {
                if (r?.error && !avisoDeFalla) {
                    avisoDeFalla = true;
                    console.warn('[llm-usage] no se pudo registrar el uso (¿falta la migración llm_usage?):', r.error.message);
                }
            })
            .catch((err: any) => {
                if (!avisoDeFalla) {
                    avisoDeFalla = true;
                    console.warn('[llm-usage] no se pudo registrar el uso:', err?.message || String(err));
                }
            });
    } catch {
        return Promise.resolve();
    }
}

// ─── Precios ────────────────────────────────────────────────────────────────

export interface PrecioModelo {
    /** Etiqueta legible para el informe. */
    nombre: string;
    patron: RegExp;
    /** USD por millón de tokens. */
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    /** USD por minuto de audio (transcripción). */
    audioMinuto?: number;
    /** false = valor de referencia sin confirmar contra la página del proveedor. */
    confirmado: boolean;
}

/**
 * Precios de lista en USD. El primero cuyo `patron` coincide con el modelo gana.
 *
 *  - Claude: tabla de precios de Anthropic (skill claude-api, caché del
 *    2026-09-25). Escritura de caché de 5 min = 1,25 × entrada; lectura según
 *    la tabla (Sonnet 5.5 y Opus 5.5: $0,20; Haiku 4.5: 0,1 × entrada).
 *  - Gemini, Groq y OpenAI: POR CONFIRMAR (`confirmado: false`). Son precios de
 *    referencia; que alguien los revise en la página de cada proveedor y
 *    cambie `confirmado` a true. `gemini-flash-latest` es un ALIAS que Google
 *    mueve al Flash vigente, así que su precio puede cambiar sin aviso.
 */
export const PRECIOS_POR_MILLON: PrecioModelo[] = [
    { nombre: 'Claude Sonnet 5.5', patron: /claude-sonnet-5-5/i, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, confirmado: true },
    { nombre: 'Claude Opus 5.5', patron: /claude-opus-5-5/i, input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, confirmado: true },
    // Respuesta a prospectos (2026-10-28). Hasta 100K tokens de prompt; lectura de
    // caché 0,1 × y escritura de 5 min 1,25 × la entrada.
    { nombre: 'Claude Haiku 5.5', patron: /claude-haiku-5-5/i, input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, confirmado: true },
    { nombre: 'Claude Haiku 4.5', patron: /claude-haiku-4-5/i, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, confirmado: true },
    { nombre: 'Claude Sonnet 5', patron: /claude-sonnet-5\b(?!-5)/i, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, confirmado: true },
    { nombre: 'Claude Sonnet 4.6', patron: /claude-sonnet-4-6/i, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, confirmado: true },
    // ── POR CONFIRMAR ──
    { nombre: 'Gemini Flash', patron: /gemini.*flash/i, input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0, confirmado: false },
    { nombre: 'Groq gpt-oss-120b', patron: /gpt-oss-120b/i, input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0, confirmado: false },
    { nombre: 'OpenAI gpt-4o-mini-transcribe', patron: /gpt-4o-mini-transcribe/i, audioMinuto: 0.003, confirmado: false },
    { nombre: 'OpenAI gpt-4o-mini', patron: /gpt-4o-mini/i, input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0, confirmado: false },
    { nombre: 'Groq Whisper large v3', patron: /whisper-large-v3/i, audioMinuto: 0.111 / 60, confirmado: false },
    { nombre: 'Groq Llama 4 Scout (visión)', patron: /llama-4-scout/i, input: 0.11, output: 0.34, cacheRead: 0, cacheWrite: 0, confirmado: false },
];

export function precioDe(modelo: string): PrecioModelo | null {
    return PRECIOS_POR_MILLON.find((p) => p.patron.test(modelo)) ?? null;
}

export interface FilaUso {
    model: string;
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_tokens?: number | null;
    cache_write_tokens?: number | null;
    audio_segundos?: number | string | null;
}

/** Costo estimado en USD de una fila de `llm_usage`. null si el modelo no tiene precio. */
export function costoUsd(f: FilaUso): number | null {
    const p = precioDe(f.model);
    if (!p) return null;
    const tok = (x: number | null | undefined, precio: number | undefined) => ((x ?? 0) * (precio ?? 0)) / 1_000_000;
    const audio = Number(f.audio_segundos ?? 0);
    return tok(f.input_tokens, p.input) + tok(f.output_tokens, p.output)
        + tok(f.cache_read_tokens, p.cacheRead) + tok(f.cache_write_tokens, p.cacheWrite ?? p.input)
        + (Number.isFinite(audio) ? (audio / 60) * (p.audioMinuto ?? 0) : 0);
}
