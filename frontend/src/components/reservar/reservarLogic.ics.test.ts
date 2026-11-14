import { describe, it, expect } from 'vitest';
import { buildIcs, icsEscape, icsToken, mapApiError } from './reservarLogic';

const base = { uid: 'abc', startsAt: '2026-11-06T22:00:00Z', endsAt: '2026-11-06T23:00:00Z' };
const now = new Date('2026-11-05T00:00:00Z');
const CRLF = String.fromCharCode(13, 10);
const BS = String.fromCharCode(92);

describe('.ics: escape RFC 5545 e inyección de propiedades', () => {
  it('un nombre con CRLF + ATTENDEE no crea una línea nueva', () => {
    const ics = buildIcs({ ...base, title: 'Cancha 1' + CRLF + 'ATTENDEE:evil@x.com' }, now);
    const lineas = ics.split(CRLF);
    expect(lineas.some((l) => l.startsWith('ATTENDEE'))).toBe(false);
    expect(lineas).toContain('SUMMARY:Cancha 1' + BS + 'nATTENDEE:evil@x.com');
  });

  it('CR suelto y LF suelto tampoco rompen la línea (location y description)', () => {
    const ics = buildIcs({
      ...base,
      title: 't',
      location: 'Calle 1' + String.fromCharCode(13) + 'ORGANIZER:x',
      description: 'a' + String.fromCharCode(10) + 'ATTACH:http://x',
    }, now);
    const lineas = ics.split(CRLF);
    expect(lineas.some((l) => l.startsWith('ORGANIZER') || l.startsWith('ATTACH'))).toBe(false);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('escapa barra, punto y coma y coma', () => {
    expect(icsEscape('a' + BS + 'b;c,d')).toBe('a' + BS + BS + 'b' + BS + ';c' + BS + ',d');
  });

  it('el UID no puede traer saltos ni separadores', () => {
    expect(icsToken('id' + CRLF + 'ATTENDEE:x@y')).toBe('idATTENDEEx@y');
    const ics = buildIcs({ ...base, uid: 'id' + CRLF + 'ATTENDEE:x@y', title: 't' }, now);
    expect(ics.split(CRLF).some((l) => l.startsWith('ATTENDEE'))).toBe(false);
  });
});

describe('mapApiError: errores de seguridad amables', () => {
  it('401, 403 sin filtrar el detalle técnico', () => {
    expect(mapApiError({ status: 401, message: 'jwt expired at x' }).message).not.toMatch(/jwt/);
    expect(mapApiError({ status: 403, message: 'RLS policy violation on facility_reservations' }).message).not.toMatch(/RLS/);
  });

  it('429 respeta Retry-After', () => {
    expect(mapApiError({ status: 429, retryAfterSeconds: 30 }).message).toMatch(/30 segundos/);
    expect(mapApiError({ status: 429, retryAfterSeconds: 120 }).message).toMatch(/2 minutos/);
    expect(mapApiError({ status: 429 }).code).toBe('RATE_LIMITED');
  });
});
