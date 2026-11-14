import { describe, expect, it } from 'vitest';
import { inicialesPersona } from './iniciales';

describe('inicialesPersona (nombre + apellido)', () => {
  it('Carlos Ramírez → CR (la barra decía CA)', () => {
    expect(inicialesPersona('Carlos Ramírez')).toBe('CR');
  });
  it('nombre + dos apellidos → primer nombre + primer apellido', () => {
    expect(inicialesPersona('Carlos Ramírez Gómez')).toBe('CR');
  });
  it('dos nombres + dos apellidos → primer nombre + primer apellido', () => {
    expect(inicialesPersona('María Fernanda López Díaz')).toBe('ML');
  });
  it('ignora partículas, espacios de más y minúsculas', () => {
    expect(inicialesPersona('  juan   de la Cruz ')).toBe('JC');
    expect(inicialesPersona('Ana María de los Ríos Pérez')).toBe('AR');
  });
  it('un solo nombre → una letra; acentos y ñ se conservan', () => {
    expect(inicialesPersona('Ñusta')).toBe('Ñ');
    expect(inicialesPersona('Ángela Úsuga')).toBe('ÁÚ');
  });
  it('sin nombre → respaldo (correo) o U', () => {
    expect(inicialesPersona('', 'carlos@x.co')).toBe('CA');
    expect(inicialesPersona(null)).toBe('U');
    expect(inicialesPersona(undefined, null)).toBe('U');
  });
});
