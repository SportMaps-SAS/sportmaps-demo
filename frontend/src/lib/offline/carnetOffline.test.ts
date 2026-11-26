/** Carnet del deportista sin señal (Fase 5): copia por usuario, vigencia recalculada, solo el propio. */
import { beforeEach, describe, expect, it } from 'vitest';
import { aplicarVigencia, guardarCarnets, leerCarnets } from './carnetOffline';
import { limpiarDatosOffline } from './arranqueSinRed';

const fila = (o: Partial<{ valid_until: string; is_expired: boolean; relation: string; qr_token: string }> = {}) => ({
  qr_token: 'tok-1', valid_until: '2026-12-31', is_expired: false, relation: 'self', ...o,
});
const D = (s: string) => new Date(s).getTime();

beforeEach(() => { localStorage.clear(); });

describe('aplicarVigencia', () => {
  it('el día de vencimiento todavía vale (hasta las 23:59 locales)', () => {
    expect(aplicarVigencia([fila()], D('2026-12-31T12:00:00'))[0].is_expired).toBe(false);
  });
  it('pasado el día, queda vencido aunque el servidor lo mandó vigente', () => {
    expect(aplicarVigencia([fila()], D('2027-01-02T08:00:00'))[0].is_expired).toBe(true);
  });
  it('un vencido del servidor nunca vuelve a vigente; fecha ilegible no inventa vencimiento', () => {
    expect(aplicarVigencia([fila({ is_expired: true })], D('2026-01-01T00:00:00'))[0].is_expired).toBe(true);
    expect(aplicarVigencia([fila({ valid_until: 'no-es-fecha' })], D('2030-01-01T00:00:00'))[0].is_expired).toBe(false);
  });
  it('no muta las filas originales', () => {
    const f = fila();
    aplicarVigencia([f], D('2030-01-01T00:00:00'));
    expect(f.is_expired).toBe(false);
  });
});

describe('copia del carnet', () => {
  it('guarda y lee lo del mismo usuario, con la vigencia recalculada', () => {
    guardarCarnets('u1', [fila()]);
    const c = leerCarnets<ReturnType<typeof fila>>('u1', Date.now());
    expect(c?.rows).toHaveLength(1);
    expect(c?.rows[0].qr_token).toBe('tok-1');
    expect(c?.guardadoEn).toBeGreaterThan(0);
    expect(leerCarnets<ReturnType<typeof fila>>('u1', D('2027-02-01T00:00:00'))).toBeNull(); // la copia de arranque vence a los 14 días
  });

  it('otra cuenta en el mismo teléfono no lee la copia', () => {
    guardarCarnets('u1', [fila()]);
    expect(leerCarnets('u2')).toBeNull();
  });

  it('solo guarda el carnet propio, nunca el de un hijo', () => {
    guardarCarnets('u1', [fila({ relation: 'parent', qr_token: 'hijo' })]);
    expect(leerCarnets('u1')).toBeNull();
    guardarCarnets('u1', [fila({ relation: 'parent', qr_token: 'hijo' }), fila()]);
    expect(leerCarnets<ReturnType<typeof fila>>('u1')?.rows.map((r) => r.qr_token)).toEqual(['tok-1']);
  });

  it('sin usuario no guarda ni lee', () => {
    guardarCarnets(undefined, [fila()]);
    expect(leerCarnets(undefined)).toBeNull();
  });

  it('el cierre de sesión borra la copia', async () => {
    guardarCarnets('u1', [fila()]);
    await limpiarDatosOffline();
    expect(leerCarnets('u1')).toBeNull();
  });

  it('una copia sin filas (lista vacía) no cuenta como copia', () => {
    guardarCarnets('u1', []);
    expect(leerCarnets('u1')).toBeNull();
  });
});
