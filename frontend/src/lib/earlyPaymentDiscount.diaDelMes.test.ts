import { describe, it, expect, vi, afterEach } from 'vitest';
import { calcEarlyPaymentDiscount } from './earlyPaymentDiscount';

vi.mock('@/lib/dateUtils', () => ({ todayColombia: () => (globalThis as any).__hoy }));

const cfg = { enabled: true, days: 5, percentage: 5, mode: 'day_of_month' as const };
const calc = (hoy: string, createdAt: string, amount = 135000) => {
  (globalThis as any).__hoy = hoy;
  return calcEarlyPaymentDiscount(amount, { createdAt, config: cfg, hasEarlierUnpaid: false });
};

afterEach(() => { delete (globalThis as any).__hoy; });

describe('pronto pago hasta el día N del mes', () => {
  it('cobro creado el 4 sigue con descuento el 5 (5 % de 135.000 = 6.750)', () => {
    const r = calc('2026-11-05', '2026-11-04T15:00:00Z');
    expect(r.eligible).toBe(true);
    expect(r.discountAmount).toBe(6750);
    expect(r.finalAmount).toBe(128250);
    expect(r.validUntil).toBe('2026-11-05');
  });
  it('el día 6 ya no hay descuento', () => {
    expect(calc('2026-11-06', '2026-11-01T15:00:00Z').eligible).toBe(false);
  });
  it('145.000 con 5 % = 137.750', () => {
    expect(calc('2026-11-02', '2026-11-01T15:00:00Z', 145000).finalAmount).toBe(137750);
  });
  it('el modo por días sigue igual', () => {
    (globalThis as any).__hoy = '2026-11-06';
    const r = calcEarlyPaymentDiscount(100000, {
      createdAt: '2026-11-01T15:00:00Z', config: { enabled: true, days: 5, percentage: 5 }, hasEarlierUnpaid: false,
    });
    expect(r.eligible).toBe(true);
  });
});
