import { describe, it, expect } from 'vitest';
import { safeRedirectUrl } from './safeRedirect';

describe('safeRedirectUrl', () => {
  it('acepta https y rutas internas', () => {
    expect(safeRedirectUrl('https://checkout.wompi.co/p/?public-key=abc')).toBe('https://checkout.wompi.co/p/?public-key=abc');
    expect(safeRedirectUrl('/r/abc123')).toBe('/r/abc123');
    expect(safeRedirectUrl('  /reservar/club?x=1 ')).toBe('/reservar/club?x=1');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://x.co/abc',
    'vbscript:x',
    'http://evil.com',
    '//evil.com',
    '//evil.com/x',
    '/\\evil.com',
    '\\\\evil.com',
    'https://user:pass@evil.com/',
    'https://',
    'java\nscript:alert(1)',
    '/ok\r\nLocation: x',
    'evil.com',
    'ftp://x.co',
    '',
    '   ',
  ])('rechaza %j', (v) => {
    expect(safeRedirectUrl(v)).toBeNull();
  });

  it('rechaza lo que no es texto', () => {
    expect(safeRedirectUrl(undefined)).toBeNull();
    expect(safeRedirectUrl(null)).toBeNull();
    expect(safeRedirectUrl({ href: 'https://x.co' })).toBeNull();
    expect(safeRedirectUrl(42)).toBeNull();
  });
});
