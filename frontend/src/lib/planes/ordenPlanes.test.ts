import { describe, it, expect } from 'vitest';
import { porOrdenDeCreacion, coincide, normalizar } from './ordenPlanes';

describe('porOrdenDeCreacion', () => {
  it('con sort_order igual (el caso común) ordena por fecha de creación', () => {
    const planes = [
      { name: 'PGC8x3', sort_order: 0, created_at: '2026-09-12T10:00:00Z' },
      { name: 'PGP4x1', sort_order: 0, created_at: '2026-07-19T10:00:00Z' },
      { name: 'Viáticos', sort_order: 0, created_at: '2026-10-23T10:00:00Z' },
    ];
    expect([...planes].sort(porOrdenDeCreacion).map((p) => p.name)).toEqual(['PGP4x1', 'PGC8x3', 'Viáticos']);
  });
  it('el sort_order que fija la escuela manda sobre la fecha', () => {
    const planes = [
      { name: 'Viejo', sort_order: 2, created_at: '2026-01-01' },
      { name: 'Nuevo', sort_order: 1, created_at: '2026-10-01' },
    ];
    expect([...planes].sort(porOrdenDeCreacion).map((p) => p.name)).toEqual(['Nuevo', 'Viejo']);
  });
  it('a igual fecha desempata por nombre con números en orden natural', () => {
    const planes = [{ name: 'PGC12x3', created_at: 'x' }, { name: 'PGC8x3', created_at: 'x' }];
    expect([...planes].sort(porOrdenDeCreacion).map((p) => p.name)).toEqual(['PGC8x3', 'PGC12x3']);
  });
});

describe('coincide / normalizar', () => {
  it('busca sin tildes ni mayúsculas', () => {
    expect(normalizar('Viáticos ')).toBe('viaticos');
    expect(coincide('Competencia: Viáticos', 'VIATICOS')).toBe(true);
    expect(coincide('PGC16x4', 'pgc16')).toBe(true);
    expect(coincide('PGC16x4', 'pga')).toBe(false);
  });
  it('búsqueda vacía coincide con todo', () => {
    expect(coincide('PGC16x4', '   ')).toBe(true);
    expect(coincide(null, '')).toBe(true);
  });
});
