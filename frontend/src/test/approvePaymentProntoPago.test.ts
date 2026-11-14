/**
 * Pronto pago al aprobar (2026-11-08, Monster: 5 % hasta el día 5). Un
 * comprobante de $137.750 sobre un cobro de $145.000 con $7.250 de pronto pago
 * se proponía como ABONO y la familia leía «saldo $7.250». Lo debido es
 * amount − descuento − ya pagado; en el pago completo amount_paid = amount −
 * descuento (igual que auto_approve_payment).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  notifs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/integrations/supabase/client', () => {
  function builder(tabla: string) {
    let cambios: Record<string, unknown> | null = null;
    const api: any = {
      update: (c: Record<string, unknown>) => { cambios = c; if (tabla === 'payments') st.updates.push(c); return api; },
      eq: () => api,
      in: () => api,
      is: () => api,
      select: () => Promise.resolve({ data: [{ id: 'pay-1', payment_category: 'mensualidad' }], error: null }),
      then: (ok: any, ko: any) => Promise.resolve({ data: null, error: null, cambios }).then(ok, ko),
    };
    return api;
  }
  return {
    supabase: {
      from: (t: string) => builder(t),
      rpc: (fn: string, args: Record<string, unknown>) => {
        if (fn === 'notify_user') st.notifs.push(args);
        return Promise.resolve({ data: null, error: null });
      },
    },
  };
});

const { approvePayment, approvalMath, notifyGroupApproved } = await import('@/lib/approvePayment');
const { remainingOf, dueOf, greenExclusion, bulkGreenSelection } = await import('@/lib/receiptReview');

const PRONTO = {
  id: 'pay-1', amount: 145000, amount_paid: 0, early_payment_discount_applied: 7250,
  concept: 'Mensualidad noviembre 2026', parent_id: 'par-1', child_id: 'kid-1',
};
const OPTS = { userId: 'admin-1', schoolId: 'esc-1', schoolName: 'Monster´s Volley Club' };
const digitos = (s: unknown) => String(s).replace(/[^\d]/g, '');

beforeEach(() => { st.updates = []; st.notifs = []; });

describe('approvePayment con pronto pago', () => {
  it('pago completo: amount_paid = $137.750 (no $145.000), estado paid y aviso «confirmó tu pago de $137.750»', async () => {
    const r = await approvePayment(PRONTO, OPTS);
    expect(r).toMatchObject({ ok: true, isAbono: false, saldoPendiente: 0 });
    expect(st.updates[0]).toMatchObject({ status: 'paid', amount_paid: 137750 });
    const msg = String(st.notifs[0].p_message);
    expect(st.notifs[0].p_title).toBe('✅ Pago confirmado');
    expect(msg).toMatch(/confirmó tu pago de/);
    expect(digitos(msg.match(/pago de (.+?) por/)![1])).toBe('137750');
    expect(msg).not.toMatch(/145\.000/);
  });

  it('el valor del comprobante (137.750) NO es abono: sin «saldo $7.250»', () => {
    const m = approvalMath(PRONTO, 137750);
    expect(m).toMatchObject({ due: 137750, remaining: 137750, isAbono: false, saldoPendiente: 0, amountPaid: 137750 });
  });

  it('abono real con pronto pago: saldo = lo debido − lo abonado', async () => {
    const r = await approvePayment(PRONTO, { ...OPTS, abonoAmount: 50000 });
    expect(r).toMatchObject({ ok: true, isAbono: true, abono: 50000, saldoPendiente: 87750 });
    expect(st.updates[0]).toMatchObject({ status: 'partial', amount_paid: 50000 });
    expect(digitos(String(st.notifs[0].p_message).split('Saldo pendiente:')[1])).toBe('87750');
  });

  it('completar el saldo de un abono previo con pronto pago: amount_paid = lo debido y el aviso dice el saldo', async () => {
    const r = await approvePayment({ ...PRONTO, amount_paid: 50000 }, OPTS);
    expect(r).toMatchObject({ ok: true, isAbono: false });
    expect(st.updates[0]).toMatchObject({ status: 'paid', amount_paid: 137750 });
    expect(digitos(String(st.notifs[0].p_message).match(/pago de (.+?) por/)![1])).toBe('87750');
  });

  it('sin pronto pago nada cambia: completo = amount', async () => {
    await approvePayment({ ...PRONTO, early_payment_discount_applied: null }, OPTS);
    expect(st.updates[0]).toMatchObject({ status: 'paid', amount_paid: 145000 });
  });

  it('aviso de un comprobante de varios meses: suma lo debido de cada uno', async () => {
    await notifyGroupApproved([
      { payment: PRONTO, label: 'Noviembre 2026' },
      { payment: { ...PRONTO, id: 'pay-2', early_payment_discount_applied: null }, label: 'Diciembre 2026' },
    ], 'Monster');
    expect(digitos(String(st.notifs[0].p_message).match(/pago de (.+?) por/)![1])).toBe(String(137750 + 145000));
  });
});

describe('«Aprobar todos los verdes» con pronto pago', () => {
  const item = (o: Record<string, unknown> = {}) => ({
    id: 'v1', status: 'awaiting_approval', amount: 145000, amount_paid: null, early_payment_discount_applied: 7250,
    receipt_verdict: 'verde', ocr_amount: 137750, receipt_url: 'r/v1.jpg', created_at: '2026-11-01T00:00:00Z', ...o,
  });

  it('saldo = amount − amount_paid − pronto pago', () => {
    expect(dueOf(item())).toBe(137750);
    expect(remainingOf(item())).toBe(137750);
    expect(remainingOf(item({ amount_paid: 50000 }))).toBe(87750);
    expect(remainingOf(item({ early_payment_discount_applied: null }))).toBe(145000);
  });

  it('el comprobante de $137.750 entra (antes: «el monto leído no coincide») y el total es lo debido', () => {
    expect(greenExclusion(item())).toBeNull();
    expect(greenExclusion(item({ early_payment_discount_applied: null }))).toBe('el monto leído no coincide');
    const sel = bulkGreenSelection([item(), item({ id: 'v2', receipt_url: 'r/v2.jpg', early_payment_discount_applied: null, ocr_amount: 145000 })]);
    expect(sel.eligible).toHaveLength(2);
    expect(sel.total).toBe(137750 + 145000);
  });
});
