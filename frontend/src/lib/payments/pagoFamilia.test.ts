import { describe, it, expect } from 'vitest';
import {
  repartirExcedente,
  excedenteDeGrupo,
  recibidoMenorQueSuma,
  recibidoPorDefecto,
  avisoReparto,
} from './pagoFamilia';

describe('repartirExcedente', () => {
  it('reparte $5.500 entre dos hermanas en partes iguales', () => {
    expect(repartirExcedente(5500, ['a', 'b'], 'a')).toEqual([
      { childId: 'a', monto: 2750 },
      { childId: 'b', monto: 2750 },
    ]);
  });

  it('el residuo de un excedente impar va a la ancla', () => {
    expect(repartirExcedente(5501, ['a', 'b'], 'a')).toEqual([
      { childId: 'a', monto: 2751 },
      { childId: 'b', monto: 2750 },
    ]);
    expect(repartirExcedente(5501, ['a', 'b'], 'b')).toEqual([
      { childId: 'a', monto: 2750 },
      { childId: 'b', monto: 2751 },
    ]);
  });

  it('con una sola deportista, completo a ella', () => {
    expect(repartirExcedente(5500, ['a'], 'a')).toEqual([{ childId: 'a', monto: 5500 }]);
  });

  it('cuenta por deportista, no por cobro: ids repetidos cuentan una vez', () => {
    expect(repartirExcedente(3000, ['a', 'a', 'b'], 'b')).toEqual([
      { childId: 'a', monto: 1500 },
      { childId: 'b', monto: 1500 },
    ]);
  });

  it('suma exactamente el excedente (tres hermanas, residuo 1 a la ancla)', () => {
    const partes = repartirExcedente(1000, ['a', 'b', 'c'], 'b');
    expect(partes.reduce((s, p) => s + p.monto, 0)).toBe(1000);
    expect(partes.find((p) => p.childId === 'b')?.monto).toBe(334);
    expect(partes.find((p) => p.childId === 'a')?.monto).toBe(333);
  });

  it('sin excedente o sin deportistas no reparte nada', () => {
    expect(repartirExcedente(0, ['a'], 'a')).toEqual([]);
    expect(repartirExcedente(-5, ['a'], 'a')).toEqual([]);
    expect(repartirExcedente(100, [], 'a')).toEqual([]);
  });

  it('una ancla que no está en el grupo cae en la primera', () => {
    expect(repartirExcedente(5501, ['a', 'b'], 'zzz')[0]).toEqual({ childId: 'a', monto: 2751 });
  });

  it('monto con decimales se redondea a pesos enteros', () => {
    expect(repartirExcedente(5500.4, ['a', 'b'], 'a').reduce((s, p) => s + p.monto, 0)).toBe(5500);
  });
});

describe('excedente y recibido', () => {
  it('excedente = recibido − suma, nunca negativo', () => {
    expect(excedenteDeGrupo(1451500, 1446000)).toBe(5500);
    expect(excedenteDeGrupo(1000, 2000)).toBe(0);
  });

  it('recibido menor que la suma se bloquea; igual o mayor no', () => {
    expect(recibidoMenorQueSuma(1445999, 1446000)).toBe(true);
    expect(recibidoMenorQueSuma(1446000, 1446000)).toBe(false);
    expect(recibidoMenorQueSuma(1451500, 1446000)).toBe(false);
  });

  it('precarga: OCR si lo hay, suma si no', () => {
    expect(recibidoPorDefecto(1446000, 1451500)).toBe(1451500);
    expect(recibidoPorDefecto(1446000, null)).toBe(1446000);
    expect(recibidoPorDefecto(1446000, 0)).toBe(1446000);
    expect(recibidoPorDefecto(1446000, undefined)).toBe(1446000);
  });
});

describe('avisoReparto', () => {
  const nombres = { a: 'Ana', b: 'Bea' };
  it('partes iguales: «a favor de cada una»', () => {
    const msg = avisoReparto(repartirExcedente(5500, ['a', 'b'], 'a'), nombres, 5500)!;
    expect(msg).toContain('Sobran');
    expect(msg).toContain('a favor de cada una');
    expect(msg.replace(/\s/g, ' ')).toMatch(/2\.750/);
  });

  it('partes distintas: por nombre', () => {
    const msg = avisoReparto(repartirExcedente(5501, ['a', 'b'], 'a'), nombres, 5501)!;
    expect(msg).toContain('Ana');
    expect(msg).toContain('Bea');
  });

  it('una sola: a su nombre; sin excedente: null', () => {
    expect(avisoReparto(repartirExcedente(5500, ['a'], 'a'), nombres, 5500)).toContain('Ana');
    expect(avisoReparto([], nombres, 0)).toBeNull();
  });
});
