import { describe, it, expect } from 'vitest';
import { blackoutErrorMessage, buildBlackoutBody, checkoutUrlOf, parseBookingError } from './reservasApi';

describe('checkoutUrlOf usa safeRedirectUrl', () => {
  it('solo https o ruta interna', () => {
    expect(checkoutUrlOf({ checkout_url: 'https://pay.example.com/x' })).toBe('https://pay.example.com/x');
    expect(checkoutUrlOf({ checkout_url: '/r/abc' })).toBe('/r/abc');
    expect(checkoutUrlOf({ checkout_url: 'javascript:alert(1)' })).toBeNull();
    expect(checkoutUrlOf({ checkout_url: 'http://pay.example.com' })).toBeNull();
    expect(checkoutUrlOf({ checkout_url: '//evil.com' })).toBeNull();
    expect(checkoutUrlOf({ url: 'data:text/html,x' })).toBeNull();
  });
});

describe('errores de seguridad (staff)', () => {
  it('401/403/404 sin código: texto fijo, sin detalle del servidor', () => {
    expect(parseBookingError({ status: 401, message: 'jwt malformed', body: { error: 'jwt malformed' } }).message).toMatch(/sesión expiró/);
    expect(parseBookingError({ status: 403, message: 'x', body: { error: 'new row violates row-level security policy' } }).message).toBe('No tienes permiso para hacer esto.');
    expect(parseBookingError({ status: 404, message: 'relation x does not exist', body: { error: 'relation x does not exist' } }).message).toMatch(/No encontramos/);
  });

  it('429 respeta Retry-After', () => {
    const e = { status: 429, message: 'Too many', retryAfterSeconds: 45, body: { error: 'Too many requests' } };
    expect(parseBookingError(e).message).toMatch(/45 segundos/);
    expect(parseBookingError(e).retryAfterSeconds).toBe(45);
    expect(parseBookingError({ status: 429, body: { code: 'RATE_LIMITED' } }).message).toMatch(/Espera/);
  });

  it('bloqueo que choca con una reserva (409)', () => {
    expect(
      blackoutErrorMessage({ status: 409, message: 'conflict', body: { error: 'conflict', code: 'RESERVATION_CONFLICT' } }),
    ).toMatch(/reserva vigente/);
  });
});

describe('buildBlackoutBody', () => {
  it('motivo de máximo 200 caracteres y sin saltos de línea; tipo por defecto other', () => {
    const reason = ('x' + String.fromCharCode(13, 10) + 'y').padEnd(300, 'z');
    const b = buildBlackoutBody({ facility_id: 'f', starts_at: 'a', ends_at: 'b', reason });
    expect(b.kind).toBe('other');
    expect(b.reason!.length).toBe(200);
    expect(b.reason).not.toMatch(/[\r\n]/);
    expect(buildBlackoutBody({ facility_id: 'f', starts_at: 'a', ends_at: 'b', reason: '  ' })).not.toHaveProperty('reason');
  });
});
