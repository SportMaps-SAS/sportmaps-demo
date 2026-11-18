import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { decidir, decidirSiNo, clasificarMensajeFamilia, CATEGORIAS_MENSAJE_FAMILIA } from './gemini-decisions.service';

const respuesta = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;

describe('gemini-decisions.service', () => {
    const llave = process.env.GEMINI_API_KEY;
    beforeEach(() => { process.env.GEMINI_API_KEY = 'k'; });
    afterEach(() => { vi.restoreAllMocks(); if (llave === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = llave; });

    it('sin llave o sin texto: null y no llama a la red', async () => {
        const f = vi.spyOn(globalThis, 'fetch');
        delete process.env.GEMINI_API_KEY;
        expect(await decidirSiNo('hola', 'x')).toBeNull();
        process.env.GEMINI_API_KEY = 'k';
        expect(await decidirSiNo('   ', 'x')).toBeNull();
        expect(f).not.toHaveBeenCalled();
    });

    it('arma la petición como pide la API (un solo bloque de texto, llave en la cabecera)', async () => {
        const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respuesta({ answers: { q: { type: 'noul', noul: 0.9, confidence: 0.9 } }, usage: { total_input_tokens: 42 } }));
        const r = await decidirSiNo('hoy no va', 'pregunta');
        expect(r).toMatchObject({ pSi: 0.9, confianza: 0.9 });
        const [url, init] = f.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/decisions');
        expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ model: 'gemini-decision-1', input: [{ type: 'text', text: 'hoy no va' }], questions: { q: { type: 'noul', instructions: 'pregunta' } } });
    });

    it('clasificarMensajeFamilia manda las categorías como criteria y devuelve la elegida', async () => {
        const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respuesta({ answers: { q: { type: 'choice', choice: 'pagos', probabilities: { pagos: 0.97 }, confidence: 0.97 } } }));
        const r = await clasificarMensajeFamilia('ya pagué');
        expect(r).toMatchObject({ opcion: 'pagos', confianza: 0.97 });
        expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body)).questions.q.criteria).toEqual(CATEGORIAS_MENSAJE_FAMILIA);
    });

    it('nunca lanza: error HTTP, JSON raro o red caída devuelven null', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(respuesta({}, false, 429));
        expect(await decidirSiNo('a', 'b')).toBeNull();
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(respuesta({ nada: 1 }));
        expect(await decidir('a', { q: { type: 'noul', instructions: 'b' } })).toBeNull();
        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('red'));
        expect(await decidirSiNo('a', 'b')).toBeNull();
    });
});
