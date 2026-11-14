/**
 * Claude como segundo lector de comprobantes (2026-11-09).
 *
 * En producción había GEMINI_API_KEY y ANTHROPIC_API_KEY, pero no
 * OPENAI_API_KEY ni GROQ_OCR_MODEL, y `listConfiguredProviders()` no contaba a
 * Claude: quedaba un solo proveedor, la aprobación automática nunca tenía
 * lectura B y no aprobaba nada. Acá: la lista con y sin la llave, y que la
 * respuesta de Claude pase por el MISMO parser que la de los demás.
 *
 * El SDK de Anthropic es un mock: ninguna prueba sale a la red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    create: vi.fn(),
    usos: [] as any[],
}));

vi.mock('@anthropic-ai/sdk', () => {
    class Anthropic { messages = { create: h.create }; }
    return { default: Anthropic };
});
vi.mock('./llm-usage.service', () => ({
    registrarUsoLlm: (u: any) => { h.usos.push(u); return Promise.resolve(); },
    tokensDeRespuesta: () => null,
}));

import {
    extractReceiptWith, extractReceiptWithFallback, listConfiguredProviders, modeloClaudeOcr, tipoPorFirma,
} from './ocr.service';
import { describeAiProviders } from './ai-providers.health';

const VARS = [
    'GEMINI_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'GROQ_OCR_MODEL',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_OCR_MODEL', 'CLAUDE_OCR_MODEL',
];
let guardado: Record<string, string | undefined> = {};

beforeEach(() => {
    guardado = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    for (const v of VARS) delete process.env[v];
    h.create.mockReset();
    h.usos = [];
});
afterEach(() => {
    for (const v of VARS) {
        if (guardado[v] === undefined) delete process.env[v];
        else process.env[v] = guardado[v];
    }
});

// Primeros bytes reales de cada formato, en base64.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).toString('base64');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1').toString('base64');
const WEBP = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1').toString('base64');
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3', 'latin1').toString('base64');
const HEIC = Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00', 'latin1').toString('base64');

/** Una respuesta de Claude como la que devuelve Haiku 5.5: pensamiento primero, después el JSON. */
function respuestaClaude(json: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        stop_reason: 'end_turn',
        content: [
            { type: 'thinking', thinking: '', signature: 'sig' },
            { type: 'text', text: '```json\n' + JSON.stringify(json) + '\n```' },
        ],
        usage: { input_tokens: 1500, output_tokens: 300 },
        ...extra,
    };
}

const COMPROBANTE = {
    amount: 165000,
    currency: 'COP',
    date: '2026-11-08',
    time: '10:15',
    bank: 'Nequi',
    reference: 'M48217730',
    destination: '319 450 5150',
    destination_name: 'Monsters Volley Club',
    origin_name: 'Carolina Pérez',
    description: 'Mensualidad noviembre Sofía',
    is_receipt: true,
    is_transaction_list: false,
    missing_fields: [],
    raw_text: 'Envío realizado $ 165.000 Para Monsters Volley Club 319 450 5150 Referencia M48217730',
    suspicious_instructions: false,
};

describe('listConfiguredProviders', () => {
    it('producción de hoy (Gemini + Anthropic, sin OpenAI ni GROQ_OCR_MODEL) → gemini y claude: hay segundo lector', () => {
        process.env.GEMINI_API_KEY = 'g';
        process.env.GROQ_API_KEY = 'q';
        process.env.ANTHROPIC_API_KEY = 'a';
        expect(listConfiguredProviders()).toEqual(['gemini', 'claude']);
    });

    it('sin ANTHROPIC_API_KEY queda solo gemini: sin lectura B no se aprueba nada (el bug del 2026-11-09)', () => {
        process.env.GEMINI_API_KEY = 'g';
        process.env.GROQ_API_KEY = 'q';
        expect(listConfiguredProviders()).toEqual(['gemini']);
        process.env.ANTHROPIC_API_KEY = '';
        expect(listConfiguredProviders()).toEqual(['gemini']);
    });

    it('Gemini sigue leyendo primero y Claude va de segundo aunque haya OpenAI y Groq con modelo', () => {
        process.env.GEMINI_API_KEY = 'g';
        process.env.OPENAI_API_KEY = 'o';
        process.env.GROQ_API_KEY = 'q';
        process.env.GROQ_OCR_MODEL = 'modelo-vision';
        process.env.ANTHROPIC_API_KEY = 'a';
        expect(listConfiguredProviders()).toEqual(['gemini', 'claude', 'openai', 'groq']);
    });

    it('solo Anthropic → claude', () => {
        process.env.ANTHROPIC_API_KEY = 'a';
        expect(listConfiguredProviders()).toEqual(['claude']);
    });
});

describe('Claude lee el comprobante', () => {
    beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'a'; });

    it('la respuesta de Claude pasa por el mismo parser: OcrResult completo, sin tocar el bloque de pensamiento', async () => {
        h.create.mockResolvedValueOnce(respuestaClaude(COMPROBANTE));
        const r = await extractReceiptWith('claude', JPEG, 'image/jpeg');
        expect(r).toMatchObject({
            amount: 165000,
            currency: 'COP',
            date: '2026-11-08',
            time: '10:15',
            bank: 'Nequi',
            reference: 'M48217730',
            destination: '319 450 5150',
            destinationName: 'Monsters Volley Club',
            originName: 'Carolina Pérez',
            description: 'Mensualidad noviembre Sofía',
            isReceipt: true,
            isTransactionList: false,
            missingFields: [],
            injectionSuspected: false,
            provider: 'claude',
        });
        expect(r.rawText).toContain('M48217730');
        expect(h.usos).toEqual([expect.objectContaining({ feature: 'ocr', provider: 'claude', model: 'claude-haiku-5-5' })]);
    });

    it('pide Haiku 5.5 con esfuerzo bajo, el prompt común y un techo de 20 s', async () => {
        h.create.mockResolvedValueOnce(respuestaClaude(COMPROBANTE));
        await extractReceiptWith('claude', JPEG, 'image/jpeg');
        const [body, opciones] = h.create.mock.calls[0];
        expect(body.model).toBe('claude-haiku-5-5');
        expect(body.output_config).toEqual({ effort: 'low' });
        expect(body).not.toHaveProperty('temperature'); // Haiku 5.5 responde 400 con temperature
        expect(body.system).toContain('extractor de datos de comprobantes de pago colombianos');
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].role).toBe('user');
        expect(body.messages[0].content[0]).toEqual({
            type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG },
        });
        expect(body.messages[0].content[1]).toEqual({ type: 'text', text: 'Extrae los datos de este comprobante de pago:' });
        expect(opciones.signal).toBeInstanceOf(AbortSignal);
    });

    it('un JPEG guardado como .png se manda como image/jpeg (la API daría 400 con el tipo de la extensión)', async () => {
        h.create.mockResolvedValueOnce(respuestaClaude(COMPROBANTE));
        await extractReceiptWith('claude', JPEG, 'image/png');
        expect(h.create.mock.calls[0][0].messages[0].content[0].source.media_type).toBe('image/jpeg');
    });

    it('un PDF va como documento', async () => {
        h.create.mockResolvedValueOnce(respuestaClaude(COMPROBANTE));
        await extractReceiptWith('claude', PDF, 'application/pdf');
        expect(h.create.mock.calls[0][0].messages[0].content[0]).toEqual({
            type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF },
        });
    });

    it('un formato que Claude no lee (HEIC) falla sin gastar la llamada', async () => {
        await expect(extractReceiptWith('claude', HEIC, 'image/heic')).rejects.toThrow(/no lee/);
        expect(h.create).not.toHaveBeenCalled();
    });

    it('ANTHROPIC_OCR_MODEL cambia el modelo; CLAUDE_OCR_MODEL (el nombre viejo) se sigue respetando', () => {
        expect(modeloClaudeOcr()).toBe('claude-haiku-5-5');
        process.env.CLAUDE_OCR_MODEL = 'claude-sonnet-5-5';
        expect(modeloClaudeOcr()).toBe('claude-sonnet-5-5');
        process.env.ANTHROPIC_OCR_MODEL = 'claude-opus-5-5';
        expect(modeloClaudeOcr()).toBe('claude-opus-5-5');
    });

    it('con Haiku 4.5 (no acepta `effort`) no se manda output_config', async () => {
        process.env.ANTHROPIC_OCR_MODEL = 'claude-haiku-4-5';
        h.create.mockResolvedValueOnce(respuestaClaude(COMPROBANTE));
        await extractReceiptWith('claude', JPEG, 'image/jpeg');
        expect(h.create.mock.calls[0][0]).not.toHaveProperty('output_config');
    });

    it('JSON truncado → comprobante sin leer (campos nulos), no un rechazo', async () => {
        h.create.mockResolvedValueOnce({
            ...respuestaClaude(COMPROBANTE),
            stop_reason: 'max_tokens',
            content: [{ type: 'text', text: '{"amount": 165000, "reference": "M482' }],
        });
        const r = await extractReceiptWith('claude', JPEG, 'image/jpeg');
        expect(r.amount).toBeNull();
        expect(r.isReceipt).toBe(true);
        expect(r.missingFields).toEqual(['amount', 'date', 'reference']);
    });

    it('si Claude se niega, la doble lectura lo trata como proveedor caído (null), no revienta', async () => {
        h.create.mockResolvedValueOnce({ ...respuestaClaude(COMPROBANTE), stop_reason: 'refusal', content: [] });
        await expect(extractReceiptWithFallback(['claude'], JPEG, 'image/jpeg')).resolves.toBeNull();
    });

    it('sin ANTHROPIC_API_KEY falla antes de llamar', async () => {
        delete process.env.ANTHROPIC_API_KEY;
        await expect(extractReceiptWith('claude', JPEG, 'image/jpeg')).rejects.toThrow(/ANTHROPIC_API_KEY/);
        expect(h.create).not.toHaveBeenCalled();
    });
});

describe('reporte de salud de IA (/health/ai)', () => {
    it('con la configuración de producción muestra a Claude en OCR y la doble lectura completa', () => {
        process.env.GEMINI_API_KEY = 'g';
        process.env.GROQ_API_KEY = 'q';
        process.env.ANTHROPIC_API_KEY = 'a';
        const r = describeAiProviders();
        expect(r.dobleLectura).toEqual(['gemini', 'claude']);
        expect(r.checks.filter((c) => c.role === 'ocr').map((c) => c.provider)).toEqual(['gemini', 'openai', 'claude']);
        expect(r.checks.find((c) => c.role === 'ocr' && c.provider === 'claude')).toMatchObject({
            keyEnv: 'ANTHROPIC_API_KEY', keyPresent: true, model: 'claude-haiku-5-5',
        });
        expect(r.warnings.join(' ')).not.toMatch(/no puede aprobar/);
    });

    it('con un solo proveedor en la doble lectura lo advierte (la falla que pasó sin un error en el log)', () => {
        process.env.GEMINI_API_KEY = 'g';
        process.env.GROQ_API_KEY = 'q';
        const r = describeAiProviders();
        expect(r.dobleLectura).toEqual(['gemini']);
        expect(r.warnings.join(' ')).toMatch(/aprobacion automatica no puede aprobar/);
    });
});

describe('tipoPorFirma', () => {
    it('reconoce los formatos por sus primeros bytes', () => {
        expect(tipoPorFirma(JPEG)).toBe('image/jpeg');
        expect(tipoPorFirma(PNG)).toBe('image/png');
        expect(tipoPorFirma(GIF)).toBe('image/gif');
        expect(tipoPorFirma(WEBP)).toBe('image/webp');
        expect(tipoPorFirma(PDF)).toBe('application/pdf');
        expect(tipoPorFirma(HEIC)).toBeNull();
        expect(tipoPorFirma('')).toBeNull();
    });
});
