/**
 * Sellado del comprobante por el servidor (spec seguridad-veredicto-comprobante §3.3, §7.3).
 *
 * La familia escribía con su sesión el veredicto, los ocr_* y la huella de su
 * propio cobro (2026-11-25). Ahora el servidor lee el archivo GUARDADO y escribe
 * con el monto y la categoría REALES del cobro. Datos inventados.
 */
import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Resp = { data: any; error: any };
const llamadas: { tabla: string; op: string; args: any[] }[] = [];
let respuestas: Record<string, Resp[]> = {};
const descargas: string[] = [];
let archivo: { bytes: Buffer | null; error: any } = { bytes: null, error: null };
const rpcs: { name: string; args: any }[] = [];
let rpcRespuesta: Resp = { data: { ok: true }, error: null };

function builder(tabla: string) {
    let op = 'select';
    const b: any = {};
    const siguiente = () => {
        const cola = respuestas[`${tabla}:${op}`] ?? [];
        return cola.length > 0 ? cola.shift()! : { data: null, error: null };
    };
    const encadenar = (nombre: string) => (...args: any[]) => { llamadas.push({ tabla, op: nombre, args }); return b; };
    for (const m of ['select', 'eq', 'neq', 'not', 'in', 'limit']) b[m] = encadenar(m);
    b.update = (...args: any[]) => { op = 'update'; llamadas.push({ tabla, op: 'update', args }); return b; };
    b.maybeSingle = () => Promise.resolve(siguiente());
    b.then = (ok: any, ko: any) => Promise.resolve(siguiente()).then(ok, ko);
    return b;
}

vi.mock('../config/supabase', () => ({
    supabase: {
        from: (t: string) => builder(t),
        rpc: (name: string, args: any) => { rpcs.push({ name, args }); return Promise.resolve(rpcRespuesta); },
        storage: {
            from: () => ({
                download: (ruta: string) => {
                    descargas.push(ruta);
                    if (archivo.error || !archivo.bytes) return Promise.resolve({ data: null, error: archivo.error ?? { message: 'not found' } });
                    const bytes = archivo.bytes;
                    return Promise.resolve({ data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, error: null });
                },
            }),
        },
    },
}));

const lecturaMock = vi.fn();
vi.mock('./ocr.service', () => ({
    extractReceiptWithFallback: (...a: any[]) => lecturaMock(...a),
    listConfiguredProviders: () => ['gemini', 'claude'],
    tipoPorFirma: () => 'image/png',
}));

import {
    sellarComprobante, respuestaDelSellado, rutaDelComprobante, rutaEsDeLaCarpeta, _reiniciarSellado,
    MOTIVO_LECTURA_FALLIDA, type DependenciasSellado, type CobroParaSellar,
} from './comprobante-sellado.service';

const FAMILIA = '11111111-1111-4111-8111-111111111111';
const AJENO = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const PAGO = 'a1000000-0000-4000-8000-0000000000a1';
const BYTES = Buffer.from('comprobante-real-guardado');
const SHA_REAL = crypto.createHash('sha256').update(BYTES).digest('hex');

const cobro = (o: Partial<CobroParaSellar> = {}): CobroParaSellar => ({
    id: PAGO, school_id: 'S1', status: 'awaiting_approval', amount: 150000, amount_paid: 0,
    early_payment_discount_applied: 7500, receipt_url: `${FAMILIA}/1700000000_abc.png`,
    parent_id: FAMILIA, user_id: null, child_id: 'H1', payment_category: 'mensualidad', concept: 'Mensualidad 11/2026',
    ...o,
});

const OCR = {
    amount: 142500, currency: 'COP', date: '2026-11-25', time: '10:31', bank: 'Nequi', reference: 'M00944183',
    destination: '3001112222', destinationName: 'Escuela', originName: 'Familia', isReceipt: true,
    isTransactionList: false, missingFields: [], provider: 'gemini', rawResponse: '{"amount":142500}',
};

let deps: { [K in keyof DependenciasSellado]: ReturnType<typeof vi.fn> };

beforeEach(() => {
    llamadas.length = 0; descargas.length = 0; rpcs.length = 0;
    respuestas = {};
    archivo = { bytes: BYTES, error: null };
    rpcRespuesta = { data: { ok: true }, error: null };
    lecturaMock.mockReset().mockResolvedValue({ provider: 'gemini', result: OCR });
    _reiniciarSellado();
    deps = {
        estamparComprobante: vi.fn(async () => ({ ok: true, veredicto: { verdict: 'verde', reasons: [], referenceNorm: 'M00944183' }, actualizado: true })),
        evaluatePaymentReceipt: vi.fn(async () => ({ action: 'none' })),
        montoEsperadoDelComprobante: vi.fn(() => 142500),
    };
});

/** Cobro leído + «no hay otro cobro con ese archivo». */
function conCobro(c: CobroParaSellar) {
    respuestas['payments:select'] = [{ data: c, error: null }, { data: [], error: null }];
}
const sellar = (uid: string | null) =>
    sellarComprobante(PAGO, uid ? { uid } : { sistema: true }, undefined, deps as unknown as DependenciasSellado);

describe('reglas puras', () => {
    it('ruta relativa de payment-receipts o nada', () => {
        expect(rutaDelComprobante(`${FAMILIA}/a.png`)).toBe(`${FAMILIA}/a.png`);
        expect(rutaDelComprobante('https://x.supabase.co/storage/v1/object/public/a.png')).toBeNull();
        expect(rutaDelComprobante('/abs/a.png')).toBeNull();
        expect(rutaDelComprobante(`${FAMILIA}/../${AJENO}/a.png`)).toBeNull();
        expect(rutaDelComprobante('')).toBeNull();
        expect(rutaDelComprobante(null)).toBeNull();
    });
    it('carpeta propia = empieza por {uid}/', () => {
        expect(rutaEsDeLaCarpeta(`${FAMILIA}/a.png`, FAMILIA)).toBe(true);
        expect(rutaEsDeLaCarpeta(`${AJENO}/a.png`, FAMILIA)).toBe(false);
        expect(rutaEsDeLaCarpeta(`${FAMILIA}x/a.png`, FAMILIA)).toBe(false);
    });
    it('la respuesta HTTP no lleva los motivos (SEG-26: traen cuentas de la escuela)', () => {
        expect(respuestaDelSellado({ ok: true, verdict: 'verde', action: 'none' }))
            .toEqual({ status: 200, body: { verdict: 'verde', action: 'none', glosaId: null, duplicado: false } });
        expect(respuestaDelSellado({ ok: false, status: 403, error: 'No' })).toEqual({ status: 403, body: { error: 'No' } });
    });
});

describe('autorización (igual que las policies de UPDATE)', () => {
    it('acudiente del cobro (parent_id)', async () => {
        conCobro(cobro());
        const r = await sellar(FAMILIA);
        expect(r).toMatchObject({ ok: true, verdict: 'verde' });
        expect(descargas).toEqual([`${FAMILIA}/1700000000_abc.png`]);
    });

    it('atleta adulto (user_id)', async () => {
        conCobro(cobro({ parent_id: null, user_id: FAMILIA }));
        expect((await sellar(FAMILIA)).ok).toBe(true);
    });

    it('hijo del usuario con parent_id NULL en el cobro (antes daba 403)', async () => {
        conCobro(cobro({ parent_id: null }));
        respuestas['children:select'] = [{ data: { parent_id: FAMILIA }, error: null }];
        expect((await sellar(FAMILIA)).ok).toBe(true);
    });

    it('ajeno → 403, sin leer nada', async () => {
        conCobro(cobro());
        respuestas['children:select'] = [{ data: { parent_id: FAMILIA }, error: null }];
        respuestas['schools:select'] = [{ data: { owner_id: ADMIN }, error: null }];
        respuestas['school_members:select'] = [{ data: null, error: null }];
        const r = await sellar(AJENO);
        expect(r).toEqual({ ok: false, status: 403, error: 'No autorizado sobre este cobro.' });
        expect(descargas).toHaveLength(0);
        expect(deps.estamparComprobante).not.toHaveBeenCalled();
    });

    it('administración de la escuela: puede sellar un archivo que no está en su carpeta', async () => {
        conCobro(cobro({ parent_id: null, child_id: null }));
        respuestas['schools:select'] = [{ data: { owner_id: 'otro' }, error: null }];
        respuestas['school_members:select'] = [{ data: { role: 'school_admin', status: 'active' }, error: null }];
        expect((await sellar(ADMIN)).ok).toBe(true);
    });

    it('un coach no es administración', async () => {
        conCobro(cobro({ parent_id: null, child_id: null }));
        respuestas['schools:select'] = [{ data: { owner_id: 'otro' }, error: null }];
        respuestas['school_members:select'] = [{ data: { role: 'coach', status: 'active' }, error: null }];
        expect(await sellar(AJENO)).toMatchObject({ ok: false, status: 403 });
    });
});

describe('validación', () => {
    it('receipt_url fuera de la carpeta de la familia → 422 (hallazgo D10)', async () => {
        conCobro(cobro({ receipt_url: `${AJENO}/comprobante-de-otra.png` }));
        const r = await sellar(FAMILIA);
        expect(r).toMatchObject({ ok: false, status: 422 });
        expect(descargas).toHaveLength(0);
    });

    it('cobro que no está por validar → 409', async () => {
        conCobro(cobro({ status: 'paid' }));
        expect(await sellar(FAMILIA)).toMatchObject({ ok: false, status: 409 });
        expect(descargas).toHaveLength(0);
    });

    it('cobro inexistente → 404', async () => {
        respuestas['payments:select'] = [{ data: null, error: null }];
        expect(await sellar(FAMILIA)).toMatchObject({ ok: false, status: 404 });
    });
});

describe('lectura y veredicto del servidor', () => {
    it('lee el archivo GUARDADO y calcula con el monto y la categoría del cobro, no con lo del cliente', async () => {
        const c = cobro();
        conCobro(c);
        await sellar(FAMILIA);

        expect(lecturaMock).toHaveBeenCalledTimes(1);
        expect(lecturaMock.mock.calls[0][1]).toBe(BYTES.toString('base64'));
        expect(deps.montoEsperadoDelComprobante).toHaveBeenCalledWith(expect.objectContaining({ amount: 150000, early_payment_discount_applied: 7500 }));

        const [ctx, pago, esperado, opciones] = deps.estamparComprobante.mock.calls[0];
        expect(ctx).toMatchObject({ schoolId: 'S1', storagePath: c.receipt_url, sha: SHA_REAL, ocr: OCR });
        expect(pago).toMatchObject({ id: PAGO, amount: 150000, categoria: 'mensualidad' });
        expect(esperado).toBe(142500);
        expect(opciones).toEqual({
            estados: ['awaiting_approval'],
            archivo: c.receipt_url,
            categoria: { paymentCategory: 'mensualidad', concept: 'Mensualidad 11/2026' },
        });
        expect(deps.evaluatePaymentReceipt).toHaveBeenCalledWith(PAGO, undefined, {
            lecturaA: { provider: 'gemini', result: OCR, sha: SHA_REAL },
        });
    });

    it('devuelve la decisión de evaluatePaymentReceipt', async () => {
        conCobro(cobro());
        deps.evaluatePaymentReceipt.mockResolvedValue({ action: 'approved' });
        expect(await sellar(FAMILIA)).toEqual({ ok: true, verdict: 'verde', action: 'approved', glosaId: null });
    });

    it('23505 al sellar → reject_payment_receipt REFERENCIA_DUPLICADA (D4)', async () => {
        conCobro(cobro());
        deps.estamparComprobante.mockResolvedValue({ ok: false, duplicado: true, yaAplicado: null });
        const r = await sellar(FAMILIA);
        expect(r).toEqual({ ok: true, verdict: null, action: 'rejected', duplicado: true });
        expect(rpcs).toEqual([{ name: 'reject_payment_receipt', args: expect.objectContaining({ p_payment_id: PAGO, p_reason_code: 'REFERENCIA_DUPLICADA' }) }]);
        expect(deps.evaluatePaymentReceipt).not.toHaveBeenCalled();
    });

    it('la familia cambió el archivo en el medio → no se escribe ni se evalúa', async () => {
        conCobro(cobro());
        deps.estamparComprobante.mockResolvedValue({ ok: true, veredicto: { verdict: 'verde', reasons: [], referenceNorm: null }, actualizado: false });
        const r = await sellar(FAMILIA);
        expect(r).toMatchObject({ ok: true, action: 'none', motivo: 'archivo_cambio', verdict: null });
        expect(deps.evaluatePaymentReceipt).not.toHaveBeenCalled();
    });

    it('lectura fallida → amarillo LECTURA_FALLIDA, sin glosa (no se evalúa) y con la huella real', async () => {
        conCobro(cobro());
        lecturaMock.mockResolvedValue(null);
        respuestas['payments:update'] = [{ data: [{ id: PAGO }], error: null }];
        const r = await sellar(FAMILIA);
        expect(r).toEqual({ ok: true, verdict: 'amarillo', action: 'none', motivo: 'lectura_fallida' });
        const upd = llamadas.find((l) => l.tabla === 'payments' && l.op === 'update')!.args[0];
        expect(upd).toMatchObject({
            receipt_verdict: 'amarillo', ocr_amount: null, ocr_reference: null,
            receipt_image_sha256: SHA_REAL, receipt_image_sha256_source: 'server_verified',
        });
        expect(upd.receipt_verdict_reasons[0]).toMatchObject({ code: MOTIVO_LECTURA_FALLIDA, level: 'amarillo', detail: { etapa: 'ocr' } });
        // Escritura optimista: solo si sigue en revisión con ESE archivo.
        expect(llamadas).toContainEqual({ tabla: 'payments', op: 'eq', args: ['receipt_url', `${FAMILIA}/1700000000_abc.png`] });
        expect(deps.estamparComprobante).not.toHaveBeenCalled();
        expect(deps.evaluatePaymentReceipt).not.toHaveBeenCalled();
    });

    it('archivo que no se puede descargar → lectura fallida (etapa descarga)', async () => {
        conCobro(cobro());
        archivo = { bytes: null, error: { message: 'Object not found' } };
        respuestas['payments:update'] = [{ data: [{ id: PAGO }], error: null }];
        expect(await sellar(FAMILIA)).toMatchObject({ motivo: 'lectura_fallida' });
        const upd = llamadas.find((l) => l.op === 'update')!.args[0];
        expect(upd.receipt_verdict_reasons[0].detail).toEqual({ etapa: 'descarga' });
        expect(lecturaMock).not.toHaveBeenCalled();
    });

    it('un comprobante para varios cobros: el cubierto no se sella (chocaría con la huella del principal)', async () => {
        respuestas['payments:select'] = [{ data: cobro(), error: null }, { data: [{ id: 'principal' }], error: null }];
        const r = await sellar(FAMILIA);
        expect(r).toEqual({ ok: true, verdict: null, action: 'none', motivo: 'comprobante_compartido' });
        expect(descargas).toHaveLength(0);
    });

    it('barrido (sistema) con receipt_url heredado http → lo marca para no reelegirlo', async () => {
        respuestas['payments:select'] = [{ data: cobro({ receipt_url: 'https://viejo/a.png' }), error: null }];
        respuestas['payments:update'] = [{ data: [{ id: PAGO }], error: null }];
        expect(await sellar(null)).toMatchObject({ ok: true, motivo: 'lectura_fallida' });
        const upd = llamadas.find((l) => l.op === 'update')!.args[0];
        expect(upd.receipt_verdict_reasons[0].detail).toEqual({ etapa: 'ruta' });
    });

    it('idempotente: el mismo (cobro, archivo) se lee una sola vez', async () => {
        // Las dos leen el cobro antes de que la primera revise si el archivo es compartido.
        respuestas['payments:select'] = [
            { data: cobro(), error: null }, { data: cobro(), error: null },
            { data: [], error: null },
        ];
        const [a, b] = await Promise.all([sellar(FAMILIA), sellar(FAMILIA)]);
        expect(a).toEqual(b);
        expect(lecturaMock).toHaveBeenCalledTimes(1);
        expect(deps.estamparComprobante).toHaveBeenCalledTimes(1);
    });
});
