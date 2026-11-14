import { describe, it, expect } from 'vitest';
import { nombresParecidos } from './nombreParecido';

describe('nombresParecidos', () => {
  it('atrapa la errata real de Dreamers (Rodriguez / Rodruguez)', () => {
    expect(nombresParecidos('Santiago Rodriguez Mesa', 'Santiago Rodruguez Mesa')).toBe(true);
  });

  it('ignora tildes, mayúsculas y espacios dobles', () => {
    expect(nombresParecidos('Sofía  García', 'sofia garcia')).toBe(false); // idénticos: lo bloquea el chequeo exacto
    expect(nombresParecidos('Sofía  García', 'sofia garcis')).toBe(true);
  });

  it('no marca nombres idénticos (eso es del chequeo exacto)', () => {
    expect(nombresParecidos('Ana López', 'ana lopez')).toBe(false);
  });

  it('no marca hermanos con nombres distintos', () => {
    expect(nombresParecidos('Juan David Pérez', 'Juan Daniel Pérez')).toBe(false);
    expect(nombresParecidos('Santiago Rodriguez Mesa', 'Mateo Rodriguez Mesa')).toBe(false);
  });

  it('no marca un nombre de pila suelto ni distinto número de palabras', () => {
    expect(nombresParecidos('Santiago', 'Santiagos')).toBe(false);
    expect(nombresParecidos('Santiago Rodriguez', 'Santiago Rodriguez Mesa')).toBe(false);
  });

  it('tolera vacíos', () => {
    expect(nombresParecidos('', 'Ana López')).toBe(false);
    expect(nombresParecidos(null, undefined)).toBe(false);
  });
});
