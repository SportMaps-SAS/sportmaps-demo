import { describe, it, expect } from 'vitest';
import { errorDeRecibido, lineaRecibido, notasConRecibido } from './constanciaDeRecibido';

const HOY = '2026-11-16';
const ok = { metodo: 'cash' as const, fecha: '2026-11-11', por: 'Alejandra L.' };

describe('errorDeRecibido', () => {
  it('acepta una constancia completa', () => expect(errorDeRecibido(ok, HOY)).toBeNull());
  it('pide el medio', () => expect(errorDeRecibido({ ...ok, metodo: null }, HOY)).toMatch(/cómo recibiste/));
  it('pide la fecha y rechaza una futura', () => {
    expect(errorDeRecibido({ ...ok, fecha: '' }, HOY)).toMatch(/fecha/);
    expect(errorDeRecibido({ ...ok, fecha: '2026-11-17' }, HOY)).toMatch(/futura/);
  });
  it('pide quién recibió (mínimo 2 letras, sin contar signos)', () => {
    expect(errorDeRecibido({ ...ok, por: '  ' }, HOY)).toMatch(/quién recibió/);
    expect(errorDeRecibido({ ...ok, por: '·[]' }, HOY)).toMatch(/quién recibió/);
    expect(errorDeRecibido({ ...ok, por: 'Al' }, HOY)).toBeNull();
  });
});

describe('lineaRecibido / notasConRecibido', () => {
  it('arma la línea con el prefijo estable', () => {
    expect(lineaRecibido(ok)).toBe('[Recibido: efectivo · 2026-11-11 · por Alejandra L.]');
    expect(lineaRecibido({ ...ok, metodo: 'transfer' })).toContain('transferencia');
    expect(lineaRecibido({ ...ok, metodo: 'other' })).toContain('otro medio');
  });
  it('no deja que el texto libre rompa el formato', () => {
    expect(lineaRecibido({ ...ok, por: 'Ana\n[x] · y' })).toBe('[Recibido: efectivo · 2026-11-11 · por Ana x y]');
  });
  it('antepone a las notas existentes y reemplaza una constancia previa', () => {
    expect(notasConRecibido(null, ok)).toBe(lineaRecibido(ok));
    expect(notasConRecibido('Hermano de Sofía', ok)).toBe(`${lineaRecibido(ok)}\nHermano de Sofía`);
    const dos = notasConRecibido(notasConRecibido('Nota', ok), { ...ok, por: 'Pedro' });
    expect(dos.match(/\[Recibido:/g)).toHaveLength(1);
    expect(dos).toContain('Pedro');
    expect(dos).toContain('Nota');
  });
});
