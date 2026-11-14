import { describe, expect, it } from 'vitest';
import { cobroEnSede, filtroDeSede } from './filtroDeSede';

describe('filtroDeSede', () => {
  it('sin sede activa («Todas») no filtra', () => {
    expect(filtroDeSede(null)).toBeNull();
    expect(filtroDeSede(undefined)).toBeNull();
    expect(filtroDeSede('')).toBeNull();
  });

  it('con sede activa incluye también los cobros sin sede', () => {
    expect(filtroDeSede('3f2a-bb')).toBe('branch_id.is.null,branch_id.eq.3f2a-bb');
  });

  it('descarta caracteres que romperían el filtro de PostgREST', () => {
    expect(filtroDeSede('abc),status.eq.paid')).toBe('branch_id.is.null,branch_id.eq.abcstatuseqpaid');
    expect(filtroDeSede('),(')).toBeNull();
  });
});

describe('cobroEnSede', () => {
  it('«Todas» deja pasar todo', () => {
    expect(cobroEnSede('x', null)).toBe(true);
    expect(cobroEnSede(null, null)).toBe(true);
  });
  it('con sede: la propia y «Sin sede» sí; otra sede no', () => {
    expect(cobroEnSede('A', 'A')).toBe(true);
    expect(cobroEnSede(null, 'A')).toBe(true);
    expect(cobroEnSede('B', 'A')).toBe(false);
  });
});
