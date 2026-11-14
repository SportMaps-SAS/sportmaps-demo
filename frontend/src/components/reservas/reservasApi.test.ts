import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api/bffClient', () => ({ bffClient: {} }));

import {
  bookingSignature,
  checkoutErrorMessage,
  checkoutUrlOf,
  createIdempotencyHolder,
  describeCancellationPolicy,
  describeRefund,
  dropStartedSlots,
  durationOptions,
  formatCountdown,
  newIdempotencyKey,
  parseBookingError,
  pickDaySlots,
  secondsLeft,
  slotFromAlternative,
  usesNewReservationRoutes,
  type AvailabilityResponse,
  type CreateBookingBody,
} from './reservasApi';
import { describeWeekdays, validatePolicy, validateRate, EMPTY_RATE_FORM } from './ratesLogic';

describe('parseBookingError', () => {
  it('lee el código de body.error y trae las alternativas del 409 SLOT_TAKEN', () => {
    const alt = { facility_id: 'f', starts_at: 'a', ends_at: 'b', start_local: '18:00', end_local: '19:00', price: 1000 };
    const info = parseBookingError({ status: 409, message: 'SLOT_TAKEN', body: { error: 'SLOT_TAKEN', message: 'x', alternatives: [alt] } });
    expect(info.code).toBe('SLOT_TAKEN');
    expect(info.alternatives).toEqual([alt]);
    expect(info.message).toMatch(/otra reserva/);
  });
  it('forma real del BFF: error=texto, code=CODIGO (gemelo local 2026-11-05)', () => {
    const alt = { facility_id: 'f', starts_at: 'a', ends_at: 'b', start_local: '18:00', end_local: '19:00', price: 1000 };
    const info = parseBookingError({ status: 409, message: 'Esa franja ya no está disponible', body: { error: 'Esa franja ya no está disponible', code: 'SLOT_TAKEN', reason: 'slot_taken', alternatives: [alt] } });
    expect(info.code).toBe('SLOT_TAKEN');
    expect(info.alternatives).toEqual([alt]);
    expect(info.message).toMatch(/otra reserva/);
    // código desconocido: se muestra el texto del servidor, no el código
    expect(parseBookingError({ message: 'Texto X', body: { error: 'Texto X', code: 'NUEVO' } }).message).toBe('Texto X');
  });
  it('MINOR_CANNOT_BOOK da el mensaje acordado', () => {
    expect(parseBookingError({ status: 403, message: 'MINOR_CANNOT_BOOK', body: { error: 'MINOR_CANNOT_BOOK' } }).message)
      .toBe('Los menores no pueden reservar; pídele a tu acudiente.');
  });
  it('usa body.message si el código no está en la tabla', () => {
    expect(parseBookingError({ message: 'NUEVO_CODIGO', body: { error: 'NUEVO_CODIGO', message: 'Texto del servidor' } }).message).toBe('Texto del servidor');
  });
  it('un error de red sin código no se traga el mensaje, y "Error 500" cae al genérico', () => {
    expect(parseBookingError(new Error('Failed to fetch')).message).toBe('Failed to fetch');
    expect(parseBookingError({ status: 500, message: 'Error 500' }).message).toMatch(/No se pudo completar/);
    expect(parseBookingError(null).alternatives).toEqual([]);
  });
});

describe('llave de idempotencia por resumen', () => {
  it('reusa la llave mientras los datos no cambian (doble tap / reintento)', () => {
    let n = 0;
    const h = createIdempotencyHolder(() => `key-${++n}-abcdefgh`);
    const a = h.forSummary('s1');
    expect(h.forSummary('s1')).toBe(a);
    expect(h.forSummary('s1')).toBe(a);
    expect(n).toBe(1);
  });
  it('cambia la llave si cambian los datos, y tras reset()', () => {
    let n = 0;
    const h = createIdempotencyHolder(() => `key-${++n}-abcdefgh`);
    const a = h.forSummary('s1');
    expect(h.forSummary('s2')).not.toBe(a);
    const b = h.peek();
    h.reset();
    expect(h.forSummary('s2')).not.toBe(b);
  });
  it('newIdempotencyKey cumple 8..128 caracteres y no se repite', () => {
    const k = newIdempotencyKey();
    expect(k.length).toBeGreaterThanOrEqual(8);
    expect(k.length).toBeLessThanOrEqual(128);
    expect(newIdempotencyKey()).not.toBe(k);
  });
  it('la firma cambia con la franja o el reservante, no con el orden de las claves', () => {
    const base: CreateBookingBody = { facility_id: 'f', starts_at: 's', ends_at: 'e', payment_method: 'cash' };
    expect(bookingSignature(base)).toBe(bookingSignature({ payment_method: 'cash', ends_at: 'e', starts_at: 's', facility_id: 'f' }));
    expect(bookingSignature(base)).not.toBe(bookingSignature({ ...base, starts_at: 's2' }));
    expect(bookingSignature(base)).not.toBe(bookingSignature({ ...base, booker_profile_id: 'u' }));
  });
});

const AV: AvailabilityResponse = {
  school_id: 's', from: '2026-11-06', to: '2026-11-06',
  facilities: [{
    facility_id: 'f1', name: 'C1', type: 'x', capacity: 10, audience: 'public',
    slot_step_min: 30, min_duration_min: 60, duration_min: 60, min_deposit_pct: 30,
    days: [{
      date: '2026-11-06', weekday: 5, is_holiday: false,
      slots: [
        { starts_at: '2026-11-06T23:00:00Z', ends_at: '2026-11-07T00:00:00Z', start_local: '18:00', end_local: '19:00', price: 120000, deposit_min: 36000 },
        { starts_at: '2026-11-06T22:00:00Z', ends_at: '2026-11-06T23:00:00Z', start_local: '17:00', end_local: '18:00', price: 100000, deposit_min: 30000 },
      ],
    }],
  }],
};

describe('franjas', () => {
  it('pickDaySlots filtra por cancha y día y ordena por hora', () => {
    expect(pickDaySlots(AV, 'f1', '2026-11-06').map((s) => s.start_local)).toEqual(['17:00', '18:00']);
    expect(pickDaySlots(AV, 'f1', '2026-11-07')).toEqual([]);
    expect(pickDaySlots(AV, 'otra', '2026-11-06')).toEqual([]);
    expect(pickDaySlots(null, 'f1', '2026-11-06')).toEqual([]);
  });
  it('dropStartedSlots descarta las que ya empezaron', () => {
    const slots = pickDaySlots(AV, 'f1', '2026-11-06');
    expect(dropStartedSlots(slots, new Date('2026-11-06T22:30:00Z')).map((s) => s.start_local)).toEqual(['18:00']);
  });
  it('durationOptions: múltiplos del paso desde el mínimo, hasta 4 h', () => {
    expect(durationOptions({ slot_step_min: 30, min_duration_min: 60 })).toEqual([60, 90, 120, 150, 180, 210, 240]);
    expect(durationOptions({ slot_step_min: 60, min_duration_min: 60 })).toEqual([60, 120, 180, 240]);
    expect(durationOptions(null)).toEqual([]);
  });
  it('slotFromAlternative conserva rango y precio', () => {
    const s = slotFromAlternative({ facility_id: 'f', starts_at: 'a', ends_at: 'b', start_local: '1', end_local: '2', price: 5 }, 2);
    expect(s).toMatchObject({ starts_at: 'a', ends_at: 'b', price: 5, deposit_min: 2 });
  });
});

describe('hold y cancelación', () => {
  it('secondsLeft y formatCountdown', () => {
    const now = new Date('2026-11-05T15:00:00Z').getTime();
    expect(secondsLeft('2026-11-05T15:10:00Z', now)).toBe(600);
    expect(secondsLeft('2026-11-05T14:00:00Z', now)).toBe(0);
    expect(secondsLeft(null, now)).toBe(0);
    expect(formatCountdown(600)).toBe('10:00');
    expect(formatCountdown(65)).toBe('01:05');
  });
  it('describe la política y la devolución', () => {
    expect(describeCancellationPolicy()).toMatch(/100 % si cancelas con 24 h/);
    expect(describeRefund({ pct: 50, amount: 60000, status: 'manual' })).toMatch(/50 %.*60\.000/);
    expect(describeRefund({ pct: 0, amount: 0, status: 'none' })).toMatch(/No hay devolución/);
  });
  it('checkout: url y errores amables', () => {
    expect(checkoutUrlOf({ checkout_url: 'https://pay.example/x' })).toBe('https://pay.example/x');
    expect(checkoutUrlOf({ url: 'javascript:alert(1)' })).toBeNull();
    expect(checkoutErrorMessage({ status: 404, message: 'Error 404' })).toMatch(/todavía no está disponible/);
  });
  it('usesNewReservationRoutes: solo filas con starts_at que no son clases de cortesía', () => {
    expect(usesNewReservationRoutes({ starts_at: '2026-11-06T22:00:00Z' })).toBe(true);
    expect(usesNewReservationRoutes({ starts_at: null })).toBe(false);
    expect(usesNewReservationRoutes({ starts_at: 'x', isSessionBooking: true })).toBe(false);
  });
});

describe('validaciones de tarifas y política', () => {
  it('validateRate', () => {
    expect(validateRate({ ...EMPTY_RATE_FORM, price_per_hour: '120000' })).toBeNull();
    expect(validateRate({ ...EMPTY_RATE_FORM, price_per_hour: '' })).toMatch(/precio/);
    expect(validateRate({ ...EMPTY_RATE_FORM, price_per_hour: '1', weekdays: [] })).toMatch(/día/);
    expect(validateRate({ ...EMPTY_RATE_FORM, price_per_hour: '1', from_time: '10:00', to_time: '09:00' })).toMatch(/posterior/);
  });
  it('validatePolicy', () => {
    expect(validatePolicy({ hours_full_refund: '24', hours_partial_refund: '6', partial_pct: '50' })).toBeNull();
    expect(validatePolicy({ hours_full_refund: '6', hours_partial_refund: '24', partial_pct: '50' })).toMatch(/parcial/);
    expect(validatePolicy({ hours_full_refund: '24', hours_partial_refund: '6', partial_pct: '150' })).toMatch(/100/);
    expect(validatePolicy({ hours_full_refund: '', hours_partial_refund: '6', partial_pct: '50' })).toMatch(/Completa/);
  });
  it('describeWeekdays', () => {
    expect(describeWeekdays([0, 1, 2, 3, 4, 5, 6])).toBe('Todos los días');
    expect(describeWeekdays([6, 1])).toBe('Lun, Sáb');
  });
});
