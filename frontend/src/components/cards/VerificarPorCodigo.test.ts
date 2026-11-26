import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

import { normalizarCodigo, veredictoCodigo } from './VerificarPorCodigo';

describe('normalizarCodigo', () => {
  it.each([
    ['SM-2026-00123', 'SM-2026-00123'],
    ['sm-2026-00123', 'SM-2026-00123'],
    [' sm 2026 00123 ', 'SM-2026-00123'],
    ['SM202600123', 'SM-2026-00123'],
    ['2026-123', 'SM-2026-00123'],
  ])('«%s» → %s', (entrada, esperado) => {
    expect(normalizarCodigo(entrada)).toBe(esperado);
  });

  it.each(['', 'SM-26-00123', 'SM-2026-001234', 'abc', 'SM-2026-'])('«%s» no es un código', (entrada) => {
    expect(normalizarCodigo(entrada)).toBeNull();
  });
});

describe('veredictoCodigo', () => {
  it('válido con nombre enmascarado y club', () => {
    expect(veredictoCodigo({ found: true, valido: true, estado: 'active', nombre: 'Juan P.', club: { name: 'Besser', logo_url: null } }))
      .toEqual({ tono: 'ok', titulo: 'Carnet válido', detalle: 'Juan P. · Besser' });
  });

  it('anulado y vencido no son válidos', () => {
    expect(veredictoCodigo({ found: true, valido: false, estado: 'revoked' }).titulo).toMatch(/anulado/);
    expect(veredictoCodigo({ found: true, valido: false, estado: 'expired' }).titulo).toMatch(/vencido/);
  });

  it('no existe, formato y error de red', () => {
    expect(veredictoCodigo({ found: false, motivo: 'no_existe' }).titulo).toMatch(/no corresponde/);
    expect(veredictoCodigo({ found: false, motivo: 'formato' }).titulo).toMatch(/formato/);
    expect(veredictoCodigo(null).tono).toBe('error');
  });
});
