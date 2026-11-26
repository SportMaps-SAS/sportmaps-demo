import { describe, expect, it } from 'vitest';
import {
  MAX_GRADOS,
  brilloDesdeInclinacion,
  inclinacionDesdeGiroscopio,
  inclinacionDesdePuntero,
  limitar,
  llego,
  suavizar,
  transformTarjeta,
} from './useTilt3D';

const rect = { left: 100, top: 50, width: 340, height: 540 };

describe('inclinacionDesdePuntero', () => {
  it('en el centro la tarjeta queda derecha', () => {
    const r = inclinacionDesdePuntero(100 + 170, 50 + 270, rect);
    expect(r.rx).toBeCloseTo(0);
    expect(r.ry).toBeCloseTo(0);
  });

  it('en las esquinas llega al máximo, con el signo hacia el puntero', () => {
    expect(inclinacionDesdePuntero(100 + 340, 50, rect)).toEqual({ rx: MAX_GRADOS, ry: MAX_GRADOS });
    expect(inclinacionDesdePuntero(100, 50 + 540, rect)).toEqual({ rx: -MAX_GRADOS, ry: -MAX_GRADOS });
  });

  it('fuera de la tarjeta no se pasa del máximo', () => {
    const r = inclinacionDesdePuntero(5000, -5000, rect, 10);
    expect(r).toEqual({ rx: 10, ry: 10 });
  });

  it('sin tamaño (aún no pintada) no inclina', () => {
    expect(inclinacionDesdePuntero(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ rx: 0, ry: 0 });
  });
});

describe('inclinacionDesdeGiroscopio', () => {
  it('en la postura base no inclina', () => {
    expect(inclinacionDesdeGiroscopio(45, 0, 45)).toEqual({ rx: -0, ry: 0 });
  });

  it('30° de giro del celular = inclinación máxima, y se limita', () => {
    expect(inclinacionDesdeGiroscopio(45, 30, 45).ry).toBeCloseTo(MAX_GRADOS);
    expect(inclinacionDesdeGiroscopio(45, 80, 45).ry).toBeCloseTo(MAX_GRADOS);
    expect(inclinacionDesdeGiroscopio(75, 0, 45).rx).toBeCloseTo(-MAX_GRADOS);
    expect(inclinacionDesdeGiroscopio(15, 0, 45).rx).toBeCloseTo(MAX_GRADOS);
  });

  it('en horizontal intercambia los ejes', () => {
    const vertical = inclinacionDesdeGiroscopio(45, 15, 45, 14, 0);
    const horizontal = inclinacionDesdeGiroscopio(60, 0, 45, 14, 90);
    expect(vertical.ry).toBeCloseTo(7);
    expect(horizontal.ry).toBeCloseTo(7);
    expect(horizontal.rx).toBeCloseTo(0);
  });

  it('sin lectura (null) no inclina', () => {
    expect(inclinacionDesdeGiroscopio(null, 10, 0)).toEqual({ rx: 0, ry: 0 });
  });
});

describe('suavizar / llego / limitar', () => {
  it('se acerca al objetivo una fracción por cuadro', () => {
    expect(suavizar(0, 10, 0.5)).toBe(5);
    expect(suavizar(0, 10, 2)).toBe(10);
  });

  it('converge y detecta la llegada', () => {
    let v = 0;
    let cuadros = 0;
    while (!llego(v, 180, 0.3) && cuadros < 200) { v = suavizar(v, 180, 0.14); cuadros++; }
    expect(llego(v, 180, 0.3)).toBe(true);
    // ~1 s a 60 fps: el giro no se arrastra.
    expect(cuadros).toBeLessThan(60);
  });

  it('NaN no rompe la tarjeta', () => {
    expect(limitar(Number.NaN, -1, 1)).toBe(0);
  });
});

describe('transformTarjeta', () => {
  it('suma el giro al eje Y y redondea', () => {
    expect(transformTarjeta(1.23456, -2, 180)).toBe('rotateX(1.23deg) rotateY(178deg)');
    expect(transformTarjeta(0, 0, 0)).toBe('rotateX(0deg) rotateY(0deg)');
  });

  it('solo usa rotaciones (transform), nunca filtros', () => {
    expect(transformTarjeta(3, 4, 0)).not.toMatch(/blur|filter|shadow/);
  });
});

describe('brilloDesdeInclinacion', () => {
  it('quieto: brillo tenue y centrado', () => {
    expect(brilloDesdeInclinacion(0, 0)).toEqual({ tx: -25, ty: -25, opacidad: 0.15 });
  });

  it('se mueve en contra de la inclinación y crece con ella', () => {
    const b = brilloDesdeInclinacion(0, MAX_GRADOS);
    expect(b.tx).toBe(-45);
    expect(b.opacidad).toBe(0.7);
    const c = brilloDesdeInclinacion(MAX_GRADOS, 0);
    expect(c.ty).toBe(-5);
  });

  it('nunca pasa de la opacidad máxima', () => {
    expect(brilloDesdeInclinacion(99, 99).opacidad).toBeLessThanOrEqual(0.7);
  });
});
