import { describe, it, expect } from 'vitest';
import { resultadoPago, metodoEnPalabras, destinoResultado } from './paymentResultModel';
import { estadoCarnet, venceCarnet, fraseCarnets } from '@/components/cards/myCardsModel';
import { estadoConstancia, fraseConstancias } from '@/components/certificates/myCertificatesModel';

describe('resultado del pago (V2 «Pago recibido»)', () => {
  it('nunca muestra el estado técnico de Wompi', () => {
    for (const s of ['APPROVED', 'DECLINED', 'ERROR', 'VOIDED', 'PENDING', 'RARO', null]) {
      const r = resultadoPago(s);
      expect(r.titulo).not.toMatch(/[A-Z]{4,}/);
      expect(r.frase).not.toMatch(/[A-Z]{4,}/);
    }
    expect(resultadoPago('APPROVED').titulo).toBe('Pago recibido');
    expect(resultadoPago('DECLINED').accion).toBe('Intentar de nuevo');
    expect(resultadoPago('PENDING').frase).toContain('no lo pagues otra vez');
  });
  it('medio en palabras; desconocido no se muestra', () => {
    expect(metodoEnPalabras('CARD')).toBe('Tarjeta');
    expect(metodoEnPalabras('nequi')).toBe('Nequi');
    expect(metodoEnPalabras('UNKNOWN')).toBeNull();
  });
  it('a dónde vuelve según quién mira', () => {
    expect(destinoResultado({ logueado: true, rol: 'parent' })).toBe('/my-payments');
    expect(destinoResultado({ logueado: true, rol: 'school' })).toBe('/dashboard');
    expect(destinoResultado({ logueado: false, rol: null })).toBe('/');
  });
});

describe('carnets', () => {
  it('estado en palabras', () => {
    expect(estadoCarnet({ status: 'active', is_expired: false }).label).toBe('Vigente');
    expect(estadoCarnet({ status: 'active', is_expired: true }).label).toBe('Vencido');
    expect(estadoCarnet({ status: 'revoked', is_expired: false }).label).toBe('Anulado');
  });
  it('fecha de vencimiento', () => {
    expect(venceCarnet({ status: 'active', is_expired: false, valid_until: '2026-12-31' })).toBe('Vence el 31 de diciembre de 2026');
    expect(venceCarnet({ status: 'active', is_expired: true, valid_until: '2026-01-31' })).toBe('Venció el 31 de enero de 2026');
  });
  it('frase de arriba', () => {
    const ok = { status: 'active', is_expired: false, valid_until: '2026-12-31', athlete_name: 'Sofía Herrera' };
    expect(fraseCarnets([ok], false).titulo).toBe('El carnet de Sofía está vigente');
    expect(fraseCarnets([ok], true).titulo).toBe('Tu carnet está vigente');
    expect(fraseCarnets([ok, { ...ok, athlete_name: 'Tomás Herrera', is_expired: true }], false).titulo).toBe('El carnet de Tomás no está vigente');
  });
});

describe('constancias', () => {
  it('estado en palabras', () => {
    expect(estadoConstancia('issued').label).toBe('Lista');
    expect(estadoConstancia('pending_review').label).toBe('En revisión');
    // Sin cobro desde 2026-11-24: lo heredado «pendiente de pago» se ve en revisión.
    expect(estadoConstancia('pending_payment').label).toBe('En revisión');
    expect(estadoConstancia('otro').label).not.toMatch(/_/);
  });
  it('frase de arriba', () => {
    expect(fraseConstancias([]).titulo).toBe('Aún no tienes constancias');
    expect(fraseConstancias([{ status: 'issued' }, { status: 'pending_review' }]).titulo).toBe('1 constancia lista');
    expect(fraseConstancias([{ status: 'pending_review' }]).titulo).toBe('Tu constancia está en camino');
    expect(fraseConstancias([{ status: 'revoked' }]).titulo).toBe('No tienes constancias vigentes');
  });
});
