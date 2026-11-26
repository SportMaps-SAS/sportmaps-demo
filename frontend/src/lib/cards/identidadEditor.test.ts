import { describe, it, expect } from 'vitest';
import { revisarArchivoEscudo, revisarMedidasEscudo, mensajeDeErrorIdentidad, MENSAJE_GENERICO } from './identidadEditor';

describe('revisarArchivoEscudo', () => {
  it('acepta PNG, WebP y SVG hasta 2 MB', () => {
    expect(revisarArchivoEscudo({ type: 'image/png', size: 1000 })).toBeNull();
    expect(revisarArchivoEscudo({ type: 'image/webp', size: 2 * 1024 * 1024 })).toBeNull();
    expect(revisarArchivoEscudo({ type: 'image/svg+xml', size: 10 })).toBeNull();
  });
  it('rechaza JPEG, otros tipos, > 2 MB y vacío', () => {
    expect(revisarArchivoEscudo({ type: 'image/jpeg', size: 1000 })).toMatch(/PNG, WebP o SVG/);
    expect(revisarArchivoEscudo({ type: 'application/pdf', size: 1000 })).not.toBeNull();
    expect(revisarArchivoEscudo({ type: 'image/png', size: 2 * 1024 * 1024 + 1 })).toMatch(/2 MB/);
    expect(revisarArchivoEscudo({ type: 'image/png', size: 0 })).not.toBeNull();
  });
});

describe('revisarMedidasEscudo', () => {
  it('exige 512 px en el lado menor', () => {
    expect(revisarMedidasEscudo(512, 512)).toBeNull();
    expect(revisarMedidasEscudo(1200, 511)).toMatch(/512 px/);
  });
});

describe('mensajeDeErrorIdentidad', () => {
  it('traduce códigos del BFF (BFFError.message = código) sin mostrar claves', () => {
    expect(mensajeDeErrorIdentidad({ message: 'invalid_accent_color' })).toBe('El color de acento no es válido.');
    expect(mensajeDeErrorIdentidad({ message: 'x', body: { error: 'feature_not_available' } })).toMatch(/plan/);
  });
  it('usa la frase del BFF si no es una clave, y si no, la genérica', () => {
    expect(mensajeDeErrorIdentidad({ message: 'otro', body: { message: 'Algo claro.' } })).toBe('Algo claro.');
    expect(mensajeDeErrorIdentidad({ message: 'school_id mismatch', body: { message: 'school_id mismatch' } })).toBe(MENSAJE_GENERICO);
    expect(mensajeDeErrorIdentidad(null)).toBe(MENSAJE_GENERICO);
  });
});
