/**
 * `estamparComprobante` escribe la lectura COMPLETA del servidor (spec
 * seguridad-veredicto-comprobante §3.4, §7.3): con el guard de la base, lo que
 * mande la familia se ignora, así que `ocr_currency`, `ocr_time`,
 * `ocr_destination_name`, `ocr_raw_response` y `receipt_reference_norm` (antes
 * solo del navegador) los pone el servidor. Y el sellado de la app escribe solo
 * si el cobro sigue con el MISMO archivo. Datos inventados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const llamadas: { op: string; args: any[] }[] = [];
let respuesta: { data: any; error: any } = { data: [{ id: 'p1' }], error: null };

function chain() {
    const c: any = {};
    for (const m of ['select', 'eq', 'in', 'not', 'neq', 'limit', 'update']) {
        c[m] = (...args: any[]) => { llamadas.push({ op: m, args }); return c; };
    }
    c.maybeSingle = () => Promise.resolve({ data: null, error: null });
    c.then = (ok: any, ko: any) => Promise.resolve(respuesta).then(ok, ko);
    return c;
}

vi.mock('../config/supabase', () => ({
    supabase: { from: () => chain(), rpc: () => Promise.resolve({ data: null, error: null }) },
}));

const contexto = vi.fn();
vi.mock('../services/receipt-context.service', () => ({
    buildVerdictContext: (...a: any[]) => { contexto(...a); return Promise.resolve({ today: '2026-11-25', expectedAmount: a[1]?.expectedAmount }); },
}));

import { estamparComprobante, columnasDeLectura } from './whatsapp-queue.job';
import { evaluateVerdict } from '../services/receipt-verdict';

const OCR = {
    amount: 142500, currency: 'COP', date: '2026-11-25', time: '10:31', bank: 'Nequi', reference: 'M-00944183',
    destination: '3001112222', destinationName: 'Escuela Demo', originName: 'Familia Demo', isReceipt: true,
    isTransactionList: false, missingFields: [], provider: 'gemini', rawResponse: '{"amount":142500,"currency":"COP"}',
};
const SHA = 'a'.repeat(64);
const PAGO = { id: 'p1', amount: 150000, concept: 'Mensualidad 11/2026', due_date: null, child_id: 'h1', atleta: null };

beforeEach(() => { llamadas.length = 0; contexto.mockClear(); respuesta = { data: [{ id: 'p1' }], error: null }; });

describe('columnasDeLectura', () => {
    it('incluye las columnas que antes solo escribía el navegador', () => {
        const v = evaluateVerdict(OCR, { today: '2026-11-25' });
        const cols = columnasDeLectura(OCR, v, SHA);
        expect(cols).toMatchObject({
            receipt_image_sha256: SHA,
            receipt_image_sha256_source: 'server_verified',
            ocr_amount: 142500, ocr_currency: 'COP', ocr_date: '2026-11-25', ocr_time: '10:31',
            ocr_bank: 'Nequi', ocr_reference: 'M-00944183', ocr_destination: '3001112222',
            ocr_destination_name: 'Escuela Demo', ocr_origin_name: 'Familia Demo', ocr_provider: 'gemini',
            ocr_raw_response: { amount: 142500, currency: 'COP' },
            receipt_reference_norm: v.referenceNorm,
            receipt_verdict: v.verdict,
        });
        expect(cols.receipt_reference_norm).toBeTruthy();
        expect(typeof cols.receipt_verdict_at).toBe('string');
    });

    it('respuesta cruda que no es JSON: se guarda el texto', () => {
        const v = evaluateVerdict(OCR, { today: '2026-11-25' });
        expect(columnasDeLectura({ ...OCR, rawResponse: 'no json' }, v, SHA).ocr_raw_response).toBe('no json');
        expect(columnasDeLectura({ ...OCR, rawResponse: undefined }, v, SHA).ocr_raw_response).toBeNull();
    });
});

describe('estamparComprobante', () => {
    const ctx = { schoolId: 's1', storagePath: 'u1/a.png', sha: SHA, ocr: OCR, queueId: 'q1' };

    it('el bot: escribe las columnas nuevas, sin condición de archivo', async () => {
        const r = await estamparComprobante(ctx, PAGO);
        expect(r.ok).toBe(true);
        const upd = llamadas.find((l) => l.op === 'update')!.args[0];
        expect(upd).toMatchObject({
            receipt_url: 'u1/a.png', status: 'awaiting_approval',
            ocr_currency: 'COP', ocr_time: '10:31', ocr_destination_name: 'Escuela Demo',
            ocr_raw_response: { amount: 142500, currency: 'COP' },
        });
        expect(upd.receipt_reference_norm).toBeTruthy();
        expect(llamadas).toContainEqual({ op: 'in', args: ['status', ['pending', 'overdue']] });
        expect(llamadas.some((l) => l.op === 'eq' && l.args[0] === 'receipt_url')).toBe(false);
    });

    it('el sellado: solo si el cobro sigue con ESE archivo, desde awaiting_approval, con la categoría real', async () => {
        await estamparComprobante(ctx, PAGO, 142500, {
            estados: ['awaiting_approval'],
            archivo: 'u1/a.png',
            categoria: { paymentCategory: 'mensualidad', concept: 'Mensualidad 11/2026' },
        });
        expect(llamadas).toContainEqual({ op: 'in', args: ['status', ['awaiting_approval']] });
        expect(llamadas).toContainEqual({ op: 'eq', args: ['receipt_url', 'u1/a.png'] });
        expect(contexto).toHaveBeenCalledWith('s1', expect.objectContaining({
            imageSha256: SHA, expectedAmount: 142500, paymentId: 'p1',
            paymentCategory: 'mensualidad', concept: 'Mensualidad 11/2026',
        }));
    });

    it('archivo cambiado en el medio → actualizado: false', async () => {
        respuesta = { data: [], error: null };
        const r = await estamparComprobante(ctx, PAGO, 142500, { estados: ['awaiting_approval'], archivo: 'u1/a.png' });
        expect(r).toMatchObject({ ok: true, actualizado: false });
    });
});
