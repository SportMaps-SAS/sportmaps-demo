/**
 * Claude como segundo lector de la aprobación automática (2026-11-09).
 *
 * Caso real de Monster: comprobante verde de $165.000 que cuadraba exacto, tope
 * de $400.000, y quedó «Por validar» porque producción solo tenía un proveedor
 * de OCR en la doble lectura (Gemini). Aquí el `ocr.service` es el REAL: decide
 * los proveedores con las variables de entorno de producción, Gemini responde
 * por un `fetch` falso y Claude por un SDK falso. El veredicto y la evidencia
 * de auto-aprobación también son los reales: lo único simulado es la red, la
 * base y el contexto de la escuela.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { baseVacia, supabaseFalso, type BaseFalsa } from '../jobs/base-falsa.test-helpers';
import { normalizeDestination } from './receipt-verdict';

const h = vi.hoisted(() => ({
    db: null as any,
    claude: vi.fn(),
    glosas: [] as any[][],
}));

vi.mock('../config/supabase', () => ({
    supabase: {
        from: (...a: any[]) => h.db.from(...a),
        rpc: (...a: any[]) => h.db.rpc(...a),
        storage: { from: (...a: any[]) => h.db.storage.from(...a) },
    },
}));
vi.mock('@anthropic-ai/sdk', () => {
    class Anthropic { messages = { create: h.claude }; }
    return { default: Anthropic };
});
vi.mock('./llm-usage.service', () => ({
    registrarUsoLlm: () => Promise.resolve(),
    tokensDeRespuesta: () => null,
}));
vi.mock('./receipt-context.service', () => ({
    buildVerdictContext: async (_school: string, args: any) => ({
        expectedAmount: args.expectedAmount,
        registeredAccounts: [normalizeDestination('3194505150')!],
        restrictedAccounts: [],
        dateWindowDays: 5,
        today: '2026-11-09',
        referenceAlreadyUsed: false,
        imageHashDuplicate: false,
    }),
}));
vi.mock('./glosa.service', () => ({
    autoCreateGlosaFromReasons: async (_id: string, _s: string, reasons: any[]) => { h.glosas.push(reasons); return 'glosa1'; },
    maybeAutoCreateGlosa: async () => null,
}));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: async () => ({ success: true }) } }));
vi.mock('../utils/emailTemplates', () => ({
    BrandedEmailTemplates: { paymentConfirmation: async () => ({ subject: 's', html: 'h' }) },
}));

import { evaluatePaymentReceipt } from './receipt-approval.service';

/** Lo que el comprobante muestra, en el formato del prompt común. */
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
    description: 'Mensualidad noviembre',
    is_receipt: true,
    is_transaction_list: false,
    missing_fields: [],
    raw_text: 'Nequi Envío realizado Para Monsters Volley Club 319 450 5150 $ 165.000 8 nov 2026 10:15 a.m. Referencia M48217730',
    suspicious_instructions: false,
};

/** JPEG de verdad en los primeros bytes: Claude recibe el tipo real. */
const IMAGEN = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x07]);

function leeGemini(json: Record<string, unknown>) {
    const fetchFalso = vi.fn(async (url: string) => {
        if (!String(url).includes('generativelanguage.googleapis.com')) throw new Error(`red inesperada: ${url}`);
        return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }],
            modelVersion: 'gemini-flash-latest',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchFalso);
    return fetchFalso;
}

function leeClaude(json: Record<string, unknown>) {
    h.claude.mockResolvedValue({
        model: 'claude-haiku-5-5',
        stop_reason: 'end_turn',
        content: [
            { type: 'thinking', thinking: '', signature: 'sig' },
            { type: 'text', text: JSON.stringify(json) },
        ],
        usage: { input_tokens: 1500, output_tokens: 300 },
    });
}

function escenario(): BaseFalsa {
    const base = baseVacia({
        payments: [{
            id: 'pay1', school_id: 's1', status: 'awaiting_approval', amount: 165000, amount_paid: 0,
            early_payment_discount_applied: null, receipt_url: 'padre1/1762600000_abc.jpg', receipt_image_sha256: null,
            parent_id: 'padre1', child_id: 'hijo1', team_id: null, concept: 'Mensualidad noviembre 2026',
            ocr_reference: 'M48217730', receipt_verdict: 'verde', receipt_verdict_reasons: [], amount_source: 'servidor',
        }],
        school_settings: [{ school_id: 's1', auto_approve_enabled: true, auto_approve_max_amount: 400000 }],
        profiles: [{ id: 'padre1', full_name: 'Carolina Pérez', email: 'c@x.co' }],
    });
    base.archivos['padre1/1762600000_abc.jpg'] = IMAGEN;
    base.rpc.auto_approve_payment = () => ({ data: true });
    return base;
}

const VARS = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'GROQ_OCR_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OCR_MODEL', 'CLAUDE_OCR_MODEL'];
let guardado: Record<string, string | undefined> = {};
const logFalso = () => ({ info: vi.fn(), warn: vi.fn() });

beforeEach(() => {
    guardado = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    for (const v of VARS) delete process.env[v];
    // Las variables de producción del 2026-11-09: sin OpenAI y sin modelo de visión en Groq.
    process.env.GEMINI_API_KEY = 'g';
    process.env.GROQ_API_KEY = 'q';
    process.env.ANTHROPIC_API_KEY = 'a';
    h.claude.mockReset();
    h.glosas = [];
});
afterEach(() => {
    vi.unstubAllGlobals();
    for (const v of VARS) {
        if (guardado[v] === undefined) delete process.env[v];
        else process.env[v] = guardado[v];
    }
});

const aprobo = (base: BaseFalsa) => base.llamadasRpc.some((c) => c.nombre === 'auto_approve_payment');

describe('aprobación automática con Gemini (A) y Claude (B)', () => {
    it('las dos lecturas coinciden → llama a auto_approve_payment y aprueba', async () => {
        const base = escenario();
        h.db = supabaseFalso(base);
        const fetchGemini = leeGemini(COMPROBANTE);
        leeClaude(COMPROBANTE);
        const log = logFalso();

        const r = await evaluatePaymentReceipt('pay1', log as any);

        expect(r.action).toBe('approved');
        expect(base.llamadasRpc.filter((c) => c.nombre === 'auto_approve_payment')).toEqual([
            { nombre: 'auto_approve_payment', args: { p_payment_id: 'pay1' } },
        ]);
        expect(fetchGemini).toHaveBeenCalledTimes(1);
        expect(h.claude).toHaveBeenCalledTimes(1);
        expect(h.claude.mock.calls[0][0].messages[0].content[0].source.media_type).toBe('image/jpeg');
        expect(log.info).toHaveBeenCalledWith(
            expect.objectContaining({ paymentId: 'pay1', providerA: 'gemini', providerB: 'claude' }),
            '[auto-approve] aprobado',
        );
        expect(h.glosas).toHaveLength(0);
    });

    it('Claude lee otro monto → NO aprueba (lectura inconsistente, glosa)', async () => {
        const base = escenario();
        h.db = supabaseFalso(base);
        leeGemini(COMPROBANTE);
        leeClaude({ ...COMPROBANTE, amount: 156000 });

        const r = await evaluatePaymentReceipt('pay1', logFalso() as any);

        expect(r.action).not.toBe('approved');
        expect(aprobo(base)).toBe(false);
        expect(h.glosas.flat().map((x: any) => x.code)).toContain('LECTURA_INCONSISTENTE');
    });

    it('Claude lee otra referencia con el mismo monto → NO aprueba', async () => {
        const base = escenario();
        h.db = supabaseFalso(base);
        leeGemini(COMPROBANTE);
        leeClaude({ ...COMPROBANTE, reference: 'M48217739' });

        const r = await evaluatePaymentReceipt('pay1', logFalso() as any);

        expect(r.action).not.toBe('approved');
        expect(aprobo(base)).toBe(false);
    });

    it('Claude caído → sin lectura B no se aprueba (queda para revisión manual)', async () => {
        const base = escenario();
        h.db = supabaseFalso(base);
        leeGemini(COMPROBANTE);
        h.claude.mockRejectedValue(new Error('529 overloaded'));

        const r = await evaluatePaymentReceipt('pay1', logFalso() as any);

        expect(r.action).toBe('none');
        expect(aprobo(base)).toBe(false);
    });

    it('control (producción antes del arreglo): sin ANTHROPIC_API_KEY no hay segundo lector y no se aprueba nada', async () => {
        delete process.env.ANTHROPIC_API_KEY;
        const base = escenario();
        h.db = supabaseFalso(base);
        leeGemini(COMPROBANTE);
        leeClaude(COMPROBANTE);

        const r = await evaluatePaymentReceipt('pay1', logFalso() as any);

        expect(r.action).toBe('none');
        expect(aprobo(base)).toBe(false);
        expect(h.claude).not.toHaveBeenCalled();
    });
});
