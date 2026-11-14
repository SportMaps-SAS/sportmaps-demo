import { describe, it, expect } from 'vitest';
import {
  sortReviewQueue, waitingLabel, greenExclusion, bulkGreenSelection, rejectReasonError, rejectErrorMessage,
  REJECT_REASONS, type QueueItem, receiptGroups, keepReceiptGroupsTogether, orderReceiptGroup, joinSpanish,
} from '@/lib/receiptReview';

const base = (o: Partial<QueueItem> & { id: string }): QueueItem => ({
  status: 'awaiting_approval', amount: 180000, amount_paid: null, receipt_verdict: 'verde', ocr_amount: 180000,
  // Un archivo por cobro: el mismo receipt_url en dos cobros es UN comprobante de varios.
  receipt_url: `r/${o.id}.jpg`, created_at: '2026-10-01T00:00:00Z', submitted_at: '2026-10-08T10:00:00Z', ...o,
});

describe('orden de la cola', () => {
  it('verde → amarillo → sin veredicto → rojo, y dentro el más antiguo primero', () => {
    const items = [
      base({ id: 'rojo', receipt_verdict: 'rojo', submitted_at: '2026-10-01T00:00:00Z' }),
      base({ id: 'sin', receipt_verdict: null }),
      base({ id: 'amarillo', receipt_verdict: 'amarillo', submitted_at: '2026-10-02T00:00:00Z' }),
      base({ id: 'verde-nuevo', submitted_at: '2026-10-08T12:00:00Z' }),
      base({ id: 'verde-viejo', submitted_at: '2026-10-08T08:00:00Z' }),
    ];
    expect(sortReviewQueue(items).map((i) => i.id)).toEqual(['verde-viejo', 'verde-nuevo', 'amarillo', 'sin', 'rojo']);
  });

  it('sin fecha de entrada usa la creación y no muta la lista', () => {
    const items = [base({ id: 'b', submitted_at: null, created_at: '2026-10-05T00:00:00Z' }), base({ id: 'a', submitted_at: '2026-10-04T00:00:00Z' })];
    const copia = [...items];
    expect(sortReviewQueue(items).map((i) => i.id)).toEqual(['a', 'b']);
    expect(items).toEqual(copia);
  });
});

describe('espera', () => {
  const now = Date.parse('2026-10-08T15:00:00Z');
  it('etiquetas y tonos', () => {
    expect(waitingLabel('2026-10-08T14:45:00Z', now)).toMatchObject({ label: '15 min', tone: 'ok' });
    expect(waitingLabel('2026-10-08T12:00:00Z', now)).toMatchObject({ label: '3 h', tone: 'warn' });
    expect(waitingLabel('2026-10-06T15:00:00Z', now)).toMatchObject({ label: '2 d', tone: 'late' });
  });
});

describe('aprobar todos los verdes', () => {
  it('entra solo lo que se aprobaría sin dudar', () => {
    expect(greenExclusion(base({ id: 'ok' }))).toBeNull();
    expect(greenExclusion(base({ id: 'x', receipt_verdict: 'amarillo' }))).toBe('no está en verde');
    expect(greenExclusion(base({ id: 'x', ocr_amount: 150000 }))).toBe('el monto leído no coincide');
    expect(greenExclusion(base({ id: 'x', ocr_amount: null }))).toBe('sin monto leído');
    expect(greenExclusion(base({ id: 'x', amount_paid: 50000 }))).toBe('tiene abonos previos');
    expect(greenExclusion(base({ id: 'x', period_already_settled: true }))).toBe('ese mes ya estaba pagado');
    expect(greenExclusion(base({ id: 'x', requires_review: true }))).toMatch(/pasarela/);
    expect(greenExclusion(base({ id: 'x', status: 'partial' }))).toBe('no está por validar');
    // Tolerancia de 0,5 % (la misma de la hoja de aprobación).
    expect(greenExclusion(base({ id: 'x', ocr_amount: 180500 }))).toBeNull();
  });

  it('cuenta y total; los verdes excluidos se listan con el motivo', () => {
    const sel = bulkGreenSelection([
      base({ id: 'a' }),
      base({ id: 'b', amount: 90000, ocr_amount: 90000 }),
      base({ id: 'c', ocr_amount: 100 }),
      base({ id: 'd', receipt_verdict: 'amarillo' }),
    ]);
    expect(sel.eligible.map((p) => p.id)).toEqual(['a', 'b']);
    expect(sel.total).toBe(270000);
    expect(sel.excludedGreens.map((e) => e.item.id)).toEqual(['c']);
  });
});

describe('motivo del rechazo', () => {
  it('es obligatorio, y con «Otro» el texto también', () => {
    expect(rejectReasonError(null, '')).toBe('Elige un motivo.');
    expect(rejectReasonError('OTRO', '  ')).toMatch(/Escribe el motivo/);
    expect(rejectReasonError('OTRO', 'Pagó a la cuenta vieja')).toBeNull();
    expect(rejectReasonError('ILEGIBLE', '')).toBeNull();
    expect(rejectReasonError('INVENTADO', '')).toBe('Motivo no válido.');
  });

  it('los códigos son los del CHECK de la base (sin AUTOMATICO, que es del sistema)', () => {
    expect(REJECT_REASONS.map((r) => r.code).sort()).toEqual([
      'DESTINO_NO_COINCIDE', 'FECHA_FUERA_DE_RANGO', 'ILEGIBLE', 'IS_TRANSACTION_LIST',
      'MONTO_NO_COINCIDE', 'NOT_A_RECEIPT', 'OTRO', 'REFERENCIA_DUPLICADA',
    ]);
  });

  it('traduce los errores de la RPC', () => {
    expect(rejectErrorMessage({ code: 'PGRST202', message: 'Could not find the function public.reject_payment_receipt' })).toMatch(/migración/);
    expect(rejectErrorMessage({ code: 'P0001', message: 'PAYMENT_NOT_IN_REVIEW' })).toMatch(/ya no tiene un comprobante/);
    expect(rejectErrorMessage({ code: '42501', message: 'PAYMENT_FORBIDDEN' })).toMatch(/dueño o un administrador/);
  });
});

describe('un comprobante, varios cobros (Juliana: $450.000 por sept, oct y nov)', () => {
  const foto = 'escuela/whatsapp/juliana.jpeg';
  const sept = { ...base({ id: 'sept', amount: 150000, ocr_amount: 450000, receipt_url: foto }), period_year: 2026, period_month: 9 };
  const oct = { ...base({ id: 'oct', amount: 150000, ocr_amount: null, receipt_verdict: null, receipt_url: foto }), period_year: 2026, period_month: 10 };
  const nov = { ...base({ id: 'nov', amount: 150000, ocr_amount: null, receipt_verdict: null, receipt_url: foto }), period_year: 2026, period_month: 11 };
  const otro = base({ id: 'otro', receipt_url: 'r/otro.jpg' });

  it('agrupa por receipt_url y deja fuera los comprobantes de un solo cobro', () => {
    const g = receiptGroups([sept, otro, nov, oct]);
    expect([...g.keys()]).toEqual([foto]);
    expect(g.get(foto)!.map((i) => i.id)).toEqual(['sept', 'nov', 'oct']);
  });

  it('en la cola, los meses sin monto leído quedan pegados al que trae la foto', () => {
    const verde2 = base({ id: 'verde2', receipt_url: 'r/v2.jpg', submitted_at: '2026-10-08T12:00:00Z' });
    const rojo = base({ id: 'rojo', receipt_verdict: 'rojo', receipt_url: 'r/rojo.jpg' });
    const ordenada = sortReviewQueue([nov, rojo, verde2, sept, oct]);
    expect(ordenada.map((i) => i.id)).toEqual(['sept', 'verde2', 'nov', 'oct', 'rojo']);
    expect(keepReceiptGroupsTogether(ordenada).map((i) => i.id)).toEqual(['sept', 'nov', 'oct', 'verde2', 'rojo']);
    expect(ordenada.map((i) => i.id)).toEqual(['sept', 'verde2', 'nov', 'oct', 'rojo']); // no muta
  });

  it('se aprueba primero el que trae el monto leído y luego por mes', () => {
    expect(orderReceiptGroup([nov, oct, sept]).map((i) => i.id)).toEqual(['sept', 'oct', 'nov']);
  });

  it('«Aprobar todos los verdes» no aprueba un mes suelto de un comprobante de varios', () => {
    const r = bulkGreenSelection([sept, oct, nov, otro]);
    expect(r.eligible.map((i) => i.id)).toEqual(['otro']);
    expect(r.excludedGreens.map((e) => [e.item.id, e.reason])).toEqual([['sept', 'el comprobante cubre varios cobros: apruébalo desde su fila']]);
  });

  it('une la lista en español', () => {
    expect(joinSpanish([])).toBe('');
    expect(joinSpanish(['Septiembre 2026'])).toBe('Septiembre 2026');
    expect(joinSpanish(['Septiembre 2026', 'Octubre 2026', 'Noviembre 2026'])).toBe('Septiembre 2026, Octubre 2026 y Noviembre 2026');
  });
});
