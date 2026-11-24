/**
 * Registro de consumo de modelos (services/llm-usage.service).
 *
 * Lo que se vigila:
 *   · el uso de cada API (Anthropic, Gemini, OpenAI chat y responses, Groq) se
 *     normaliza igual, con la caché aparte;
 *   · el costo usa la tabla de precios y un modelo sin precio da null;
 *   · la escuela/conversación sale del contexto asíncrono (también tras un
 *     setTimeout) y chatWithTools({ uso }) la fija;
 *   · el insert es best-effort: ni un error de la base ni una excepción rompen
 *     a quien llama; kill-switch.
 *
 * Cero red: Supabase y fetch moqueados.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const estado = vi.hoisted(() => ({
    inserts: [] as any[],
    modo: 'ok' as 'ok' | 'error' | 'lanza',
}));

vi.mock('../config/supabase', () => ({
    supabase: {
        from: (tabla: string) => ({
            insert: (fila: any) => {
                if (estado.modo === 'lanza') throw new Error('base caída');
                estado.inserts.push({ tabla, fila });
                return Promise.resolve(estado.modo === 'error'
                    ? { error: { message: 'relation "llm_usage" does not exist' } }
                    : { error: null });
            },
        }),
    },
}));

import {
    conContextoLlm, costoUsd, filaDeUso, precioDe, registrarUsoLlm, tokensDeRespuesta,
} from './llm-usage.service';

beforeEach(() => {
    estado.inserts = [];
    estado.modo = 'ok';
    process.env.LLM_USAGE_EN_PRUEBAS = 'true';
    delete process.env.DISABLE_LLM_USAGE_LOG;
});
afterEach(() => {
    delete process.env.LLM_USAGE_EN_PRUEBAS;
    vi.unstubAllGlobals();
});

describe('tokensDeRespuesta', () => {
    it('Anthropic: input ya excluye la caché', () => {
        expect(tokensDeRespuesta({ usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500 } }))
            .toEqual({ input: 120, output: 40, cacheRead: 3000, cacheWrite: 500 });
    });
    it('Gemini: el prompt incluye la caché y el «thinking» va como salida', () => {
        expect(tokensDeRespuesta({ usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 50, thoughtsTokenCount: 30 } }))
            .toEqual({ input: 400, output: 80, cacheRead: 600, cacheWrite: 0 });
    });
    it('OpenAI-compatible (Groq): prompt_tokens incluye cached_tokens', () => {
        expect(tokensDeRespuesta({ usage: { prompt_tokens: 900, completion_tokens: 70, prompt_tokens_details: { cached_tokens: 100 } } }))
            .toEqual({ input: 800, output: 70, cacheRead: 100, cacheWrite: 0 });
    });
    it('OpenAI /v1/responses', () => {
        expect(tokensDeRespuesta({ usage: { input_tokens: 500, output_tokens: 20, input_tokens_details: { cached_tokens: 200 } } }))
            .toEqual({ input: 300, output: 20, cacheRead: 200, cacheWrite: 0 });
    });
    it('sin uso → null', () => {
        expect(tokensDeRespuesta({})).toBeNull();
        expect(tokensDeRespuesta(null)).toBeNull();
    });
});

describe('precios y costo', () => {
    it('Sonnet 5.5: $2 entrada, $10 salida, $0,20 caché leída, $2,50 caché escrita por millón', () => {
        expect(costoUsd({ model: 'claude-sonnet-5-5', input_tokens: 1_000_000 })).toBeCloseTo(2);
        expect(costoUsd({ model: 'claude-sonnet-5-5', output_tokens: 1_000_000 })).toBeCloseTo(10);
        expect(costoUsd({ model: 'claude-sonnet-5-5', cache_read_tokens: 1_000_000 })).toBeCloseTo(0.2);
        expect(costoUsd({ model: 'claude-sonnet-5-5', cache_write_tokens: 1_000_000 })).toBeCloseTo(2.5);
    });
    it('Opus 5.5 y Haiku 4.5 tienen su propio precio', () => {
        expect(costoUsd({ model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(24);
        expect(costoUsd({ model: 'claude-haiku-4-5', input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(6);
    });
    it('Sonnet 5 no se confunde con Sonnet 5.5', () => {
        expect(precioDe('claude-sonnet-5')?.nombre).toBe('Claude Sonnet 5');
        expect(precioDe('claude-sonnet-5-5')?.nombre).toBe('Claude Sonnet 5.5');
    });
    it('transcripción se cobra por minuto de audio', () => {
        expect(costoUsd({ model: 'whisper-large-v3', audio_segundos: 3600 })).toBeCloseTo(0.111);
    });
    it('Gemini/Groq quedan marcados como precio por confirmar', () => {
        expect(precioDe('gemini-flash-latest')?.confirmado).toBe(false);
        expect(precioDe('openai/gpt-oss-120b')?.confirmado).toBe(false);
    });
    it('modelo sin precio → null', () => {
        expect(costoUsd({ model: 'modelo-inventado', input_tokens: 10 })).toBeNull();
    });
});

describe('registrarUsoLlm', () => {
    it('toma escuela y conversación del contexto, también después de un setTimeout', async () => {
        await conContextoLlm({ schoolId: 'esc-1', conversationId: 'conv-1', feature: 'bot' }, async () => {
            await new Promise((r) => setTimeout(r, 5));
            await registrarUsoLlm({ provider: 'claude', model: 'claude-sonnet-5-5', tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 } });
        });
        expect(estado.inserts).toHaveLength(1);
        expect(estado.inserts[0]).toMatchObject({
            tabla: 'llm_usage',
            fila: { school_id: 'esc-1', conversation_id: 'conv-1', feature: 'bot', provider: 'claude', input_tokens: 10, cache_read_tokens: 100 },
        });
    });

    it('la función explícita gana a la del contexto; un contexto interno hereda la escuela', async () => {
        await conContextoLlm({ schoolId: 'esc-1', feature: 'bot' }, () =>
            conContextoLlm({ conversationId: 'conv-2' }, () =>
                registrarUsoLlm({ feature: 'ocr', provider: 'gemini', model: 'gemini-flash-latest', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })));
        expect(estado.inserts[0].fila).toMatchObject({ school_id: 'esc-1', conversation_id: 'conv-2', feature: 'ocr' });
    });

    it('sin contexto: escuela null y función bot por defecto', () => {
        expect(filaDeUso({ provider: 'groq', model: 'x', tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }, undefined))
            .toMatchObject({ school_id: null, conversation_id: null, feature: 'bot' });
    });

    it('sin tokens ni audio no inserta nada', async () => {
        await registrarUsoLlm({ provider: 'claude', model: 'claude-sonnet-5-5', tokens: null });
        expect(estado.inserts).toHaveLength(0);
    });

    it('un error de la base (tabla sin crear) no rompe a quien llama', async () => {
        estado.modo = 'error';
        await expect(registrarUsoLlm({ provider: 'claude', model: 'm', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })).resolves.toBeUndefined();
    });

    it('una excepción del cliente tampoco', async () => {
        estado.modo = 'lanza';
        expect(() => registrarUsoLlm({ provider: 'claude', model: 'm', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })).not.toThrow();
    });

    it('kill-switch DISABLE_LLM_USAGE_LOG', async () => {
        process.env.DISABLE_LLM_USAGE_LOG = 'true';
        await registrarUsoLlm({ provider: 'claude', model: 'm', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
        expect(estado.inserts).toHaveLength(0);
    });
});

describe('chatWithTools registra el consumo con el contexto que se le pasa', () => {
    it('Gemini: guarda los tokens con la escuela de `uso`', async () => {
        const prevAnthropic = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        process.env.GEMINI_API_KEY = 'k';
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: 'Hola' }] } }],
                usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 12 },
                modelVersion: 'gemini-flash-latest',
            }),
        })));
        const { chatWithTools } = await import('./llm.service');
        const r = await chatWithTools({
            system: 's', messages: [{ role: 'user', content: 'hola' }], provider: 'gemini',
            uso: { feature: 'sportbot', schoolId: 'esc-9' },
        });
        await new Promise((x) => setTimeout(x, 0));
        expect(r.text).toBe('Hola');
        expect(estado.inserts[0].fila).toMatchObject({
            school_id: 'esc-9', feature: 'sportbot', provider: 'gemini', input_tokens: 300, output_tokens: 12,
        });
        if (prevAnthropic) process.env.ANTHROPIC_API_KEY = prevAnthropic;
    // El `await import('./llm.service')` transforma un módulo pesado DENTRO de la
    // prueba: con la máquina cargada pasaba los 5 s por defecto sin fallar nada.
    }, 30_000);
});
