import { describe, expect, it } from 'vitest';
import { coordenadasZona, zonaDeJuego } from './zonaDeJuego';

const zona = (p: string | null | undefined) => zonaDeJuego(p)?.zona ?? null;

describe('zonaDeJuego', () => {
  it('códigos de la alineación', () => {
    expect(zona('arquero')).toBe('arquero');
    expect(zona('defensa')).toBe('defensa');
    expect(zona('medio')).toBe('medio');
    expect(zona('delantero')).toBe('delantero');
  });

  it.each([
    ['Portero', 'arquero'],
    ['guardameta', 'arquero'],
    ['GK', 'arquero'],
    ['Lateral derecho', 'defensa'],
    ['Defensa central', 'defensa'],
    ['zaguero', 'defensa'],
    ['Volante', 'medio'],
    ['volante de contención', 'medio'],
    ['Volante defensivo', 'medio'],
    ['Mediocampista', 'medio'],
    ['Mediapunta', 'medio'],
    ['Extremo izquierdo', 'delantero'],
    ['Centrodelantero', 'delantero'],
    ['Delantera', 'delantero'],
    ['Punta', 'delantero'],
    ['9', 'delantero'],
    ['el 9', 'delantero'],
    ['#1', 'arquero'],
    ['10', 'medio'],
    ['4', 'defensa'],
  ])('«%s» → %s', (texto, esperado) => {
    expect(zona(texto)).toBe(esperado);
  });

  it('ignora tildes y mayúsculas', () => {
    expect(zona('CONTENCIÓN')).toBe('medio');
    expect(zona('  líbero ')).toBe('defensa');
  });

  it('detecta el lado', () => {
    expect(zonaDeJuego('Lateral izquierdo')).toMatchObject({ zona: 'defensa', lado: 'izquierda' });
    expect(zonaDeJuego('Extremo derecho')).toMatchObject({ zona: 'delantero', lado: 'derecha' });
    expect(zonaDeJuego('7')).toMatchObject({ zona: 'delantero', lado: 'derecha' });
    expect(zonaDeJuego('11')).toMatchObject({ zona: 'delantero', lado: 'izquierda' });
    expect(zonaDeJuego('Volante')).toMatchObject({ lado: 'centro' });
  });

  it('el arquero siempre va al centro', () => {
    expect(zonaDeJuego('portero izquierdo')).toMatchObject({ zona: 'arquero', lado: 'centro' });
  });

  it('da la etiqueta para mostrar', () => {
    expect(zonaDeJuego('volante')?.etiqueta).toBe('Medio');
  });

  it('lo que no reconoce → null (la cancha queda sin marcar)', () => {
    expect(zonaDeJuego(null)).toBeNull();
    expect(zonaDeJuego(undefined)).toBeNull();
    expect(zonaDeJuego('')).toBeNull();
    expect(zonaDeJuego('capitán')).toBeNull();
    expect(zonaDeJuego('99')).toBeNull();
  });
});

describe('coordenadasZona', () => {
  it('el arquero queda abajo (arco propio) y el delantero arriba', () => {
    const arq = coordenadasZona({ zona: 'arquero', lado: 'centro' });
    const del = coordenadasZona({ zona: 'delantero', lado: 'centro' });
    expect(arq.y).toBeGreaterThan(del.y);
    expect(arq.x).toBe(50);
  });

  it('los lados quedan dentro de la cancha (100 × 140)', () => {
    for (const lado of ['izquierda', 'centro', 'derecha'] as const) {
      for (const z of ['arquero', 'defensa', 'medio', 'delantero'] as const) {
        const { x, y } = coordenadasZona({ zona: z, lado });
        expect(x).toBeGreaterThan(5);
        expect(x).toBeLessThan(95);
        expect(y).toBeGreaterThan(5);
        expect(y).toBeLessThan(135);
      }
    }
  });
});
