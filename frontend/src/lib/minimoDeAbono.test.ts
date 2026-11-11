import { describe, expect, it } from 'vitest';
import { minimoDeAbono } from './minimoDeAbono';

describe('minimoDeAbono', () => {
  it('sin ítem: el mínimo de la escuela, igual que hoy', () => {
    expect(minimoDeAbono({ minEscuela: 72500, precio: 145000 })).toBe(72500);
    expect(minimoDeAbono({ pctItem: null, minEscuela: 72500, precio: 145000 })).toBe(72500);
  });
  it('sin ítem ni mínimo de escuela: 0 (sin mínimo)', () => {
    expect(minimoDeAbono({})).toBe(0);
    expect(minimoDeAbono({ minEscuela: 0, precio: 100 })).toBe(0);
  });
  it('sin ítem: 72.500 se acepta y 72.499 se rechaza (como hoy)', () => {
    const min = minimoDeAbono({ minEscuela: 72500, precio: 145000 });
    expect(72500 < min).toBe(false);
    expect(72499 < min).toBe(true);
  });
  it('con ítem 50 % sobre 175.000: 87.500', () => {
    expect(minimoDeAbono({ pctItem: 50, minEscuela: 72500, precio: 175000 })).toBe(87500);
  });
  it('redondea hacia arriba y no sube un peso por coma flotante', () => {
    expect(minimoDeAbono({ pctItem: 50, precio: 175001 })).toBe(87501);
    expect(minimoDeAbono({ pctItem: 30, precio: 100000 })).toBe(30000);
  });
  it('pct inválido o sin precio cae al mínimo de la escuela', () => {
    expect(minimoDeAbono({ pctItem: 0, minEscuela: 10000, precio: 100000 })).toBe(10000);
    expect(minimoDeAbono({ pctItem: 150, minEscuela: 10000, precio: 100000 })).toBe(10000);
    expect(minimoDeAbono({ pctItem: 50, minEscuela: 10000, precio: 0 })).toBe(10000);
  });
});
