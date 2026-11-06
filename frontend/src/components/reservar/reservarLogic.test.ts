import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY, bogotaDateKey, bogotaHHmm, buildIcs, computeRefund, durationOptions, formatCOP, formatCountdown,
  formatHM, formatRange, idempotencyKeyFor, mapApiError, newIdemStore, normalizeCoPhone, normalizePolicy,
  policyOneLiner, rangeFromToday, statusView, summarySignature,
} from './reservarLogic';

describe('horas en Bogotá', () => {
  it('convierte UTC a hora de pared de Bogotá (UTC-5)', () => {
    expect(bogotaHHmm('2026-11-06T22:00:00Z')).toBe('17:00');
    expect(bogotaHHmm('2026-11-07T04:30:00Z')).toBe('23:30');
  });
  it('la fecha de Bogotá no cruza el día antes de tiempo', () => {
    expect(bogotaDateKey('2026-11-07T04:30:00Z')).toBe('2026-11-06');
    expect(bogotaDateKey('2026-11-07T05:00:00Z')).toBe('2026-11-07');
  });
  it('formatea am/pm en español', () => {
    expect(formatHM('17:00')).toBe('5:00 p. m.');
    expect(formatHM('00:30')).toBe('12:30 a. m.');
    expect(formatHM('12:00')).toBe('12:00 p. m.');
    expect(formatRange('2026-11-06T22:00:00Z', '2026-11-06T23:30:00Z')).toBe('5:00 p. m. – 6:30 p. m.');
  });
  it('rango de 14 días desde hoy en Bogotá', () => {
    // 03:00Z del 6 = 22:00 del 5 en Bogotá
    expect(rangeFromToday(14, new Date('2026-11-06T03:00:00Z'))).toEqual({ from: '2026-11-05', to: '2026-11-18' });
  });
  it('formatea pesos y cuenta regresiva', () => {
    expect(formatCOP(120000).replace(/\s/g, ' ')).toMatch(/120\.000/);
    expect(formatCountdown(125_000)).toBe('02:05');
    expect(formatCountdown(-5)).toBe('00:00');
  });
  it('duraciones: múltiplos del paso desde el mínimo', () => {
    expect(durationOptions(60, 30)).toEqual([60, 90, 120, 150]);
    expect(durationOptions(60, 60)).toEqual([60, 120, 180]);
  });
});

describe('llave de idempotencia por resumen', () => {
  const sig = summarySignature({ facilityId: 'f1', startsAt: 'a', endsAt: 'b', paymentMethod: 'online' });
  it('doble tap / reintento = misma llave', () => {
    const store = newIdemStore();
    let n = 0;
    const gen = () => `k${++n}`;
    const k1 = idempotencyKeyFor(store, sig, gen);
    const k2 = idempotencyKeyFor(store, sig, gen);
    expect(k1).toBe(k2);
    expect(n).toBe(1);
  });
  it('cambia al cambiar franja o método', () => {
    const store = newIdemStore();
    let n = 0;
    const gen = () => `k${++n}`;
    const k1 = idempotencyKeyFor(store, sig, gen);
    const k2 = idempotencyKeyFor(store, summarySignature({ facilityId: 'f1', startsAt: 'a', endsAt: 'b', paymentMethod: 'transfer' }), gen);
    const k3 = idempotencyKeyFor(store, summarySignature({ facilityId: 'f1', startsAt: 'c', endsAt: 'd', paymentMethod: 'transfer' }), gen);
    expect(new Set([k1, k2, k3]).size).toBe(3);
  });
  it('la llave por defecto cumple 8..128 caracteres', () => {
    const k = idempotencyKeyFor(newIdemStore(), sig);
    expect(k.length).toBeGreaterThanOrEqual(8);
    expect(k.length).toBeLessThanOrEqual(128);
  });
});

describe('mapeo de errores', () => {
  it('traduce códigos del contrato', () => {
    expect(mapApiError({ status: 409, code: 'SLOT_TAKEN' }).message).toMatch(/acaba de ocuparse/);
    expect(mapApiError({ status: 403, code: 'AUDIENCE_NOT_ALLOWED' }).message).toMatch(/socios/);
  });
  it('404/501 sin código = pronto', () => {
    expect(mapApiError({ status: 501 }).pending).toBe(true);
    expect(mapApiError({ status: 404 }).pending).toBe(true);
    expect(mapApiError({ status: 404, code: 'RESERVATION_NOT_FOUND' }).pending).toBe(false);
  });
  it('red caída y límite de intentos', () => {
    expect(mapApiError({ status: 0 }).code).toBe('NETWORK');
    expect(mapApiError({ status: 429 }).code).toBe('RATE_LIMITED');
  });
  it('código desconocido usa el mensaje del servidor', () => {
    expect(mapApiError({ status: 422, code: 'RARO', message: 'texto bff' }).message).toBe('texto bff');
  });
});

describe('política y devolución', () => {
  it('sin política del BFF usa la de defecto marcada como tal', () => {
    expect(normalizePolicy(undefined)).toEqual(DEFAULT_POLICY);
    expect(DEFAULT_POLICY.source).toBe('default');
  });
  it('calcula 100 / 50 / 0 % según la antelación', () => {
    const start = '2026-11-10T22:00:00Z';
    const at = (h: number) => new Date(new Date(start).getTime() - h * 3600_000).getTime();
    expect(computeRefund(DEFAULT_POLICY, 100000, start, at(30)).amount).toBe(100000);
    expect(computeRefund(DEFAULT_POLICY, 100000, start, at(8)).amount).toBe(50000);
    expect(computeRefund(DEFAULT_POLICY, 100000, start, at(2)).amount).toBe(0);
  });
  it('la línea de política trae hora exacta de Bogotá', () => {
    expect(policyOneLiner(DEFAULT_POLICY, '2026-11-10T22:00:00Z')).toContain('5:00 p. m.');
  });
});

describe('teléfono, estados y .ics', () => {
  it('normaliza celulares colombianos', () => {
    expect(normalizeCoPhone('300 123 4567')).toBe('+573001234567');
    expect(normalizeCoPhone('+57 300 123 4567')).toBe('+573001234567');
    expect(normalizeCoPhone('123')).toBeNull();
  });
  it('estados', () => {
    expect(statusView('expired').tone).toBe('bad');
    expect(statusView('confirmed', 'paid').label).toMatch(/pagada/);
  });
  it('genera un .ics válido con CRLF y UTC', () => {
    const ics = buildIcs({ uid: 'abc', title: 'Cancha, 1', startsAt: '2026-11-06T22:00:00Z', endsAt: '2026-11-06T23:00:00Z' }, new Date('2026-11-05T00:00:00Z'));
    expect(ics).toContain('DTSTART:20261106T220000Z');
    expect(ics).toContain('SUMMARY:Cancha\\, 1');
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
