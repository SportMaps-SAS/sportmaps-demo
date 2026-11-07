import { describe, it, expect } from 'vitest';
import {
  agruparPorMes, resumenCuenta, estadoCobro, detalleCobro, tituloCobro, valorCobro, type CobroCuenta,
} from './estadoCuentaModel';

const HOY = new Date(2026, 9, 24, 10, 0); // 24 de octubre de 2026
const fmt = (n: number) => `$ ${n.toLocaleString('es-CO')}`;

const cobro = (over: Partial<CobroCuenta>): CobroCuenta => ({
  id: 'p', status: 'pending', amount: 210_000, amount_paid: null, concept: 'Mensualidad 10/2026 - Sofía Herrera',
  due_date: '2026-10-10', payment_date: null, period_year: 2026, period_month: 10, created_at: '2026-10-01T06:30:00Z',
  ...over,
});

// Datos reales de la cuenta demo (Sofía Herrera, 24-oct-2026).
const SOFIA: CobroCuenta[] = [
  cobro({ id: 'oct', status: 'overdue' }),
  cobro({ id: 'sep-rev', status: 'awaiting_approval', amount: 90_000, concept: 'Mensualidad 09/2026 - Natación Infantil - Sofía Herrera', due_date: '2026-09-30', payment_date: '2026-09-19', period_month: 9 }),
  cobro({ id: 'sep', status: 'overdue', due_date: '2026-09-10', period_month: 9, concept: 'Mensualidad 09/2026 - Sofía Herrera' }),
  cobro({ id: 'jul', status: 'paid', amount: 200_000, amount_paid: 200_000, due_date: '2026-07-10', payment_date: '2026-07-06', period_month: 7, concept: 'Mensualidad Julio 2026 — Natación Infantil' }),
];

describe('estadoCobro: siempre en palabras', () => {
  it('traduce cada estado técnico', () => {
    expect(estadoCobro(cobro({ status: 'overdue' }), HOY).label).toBe('Vencido');
    expect(estadoCobro(cobro({ status: 'pending', due_date: '2026-11-10' }), HOY).label).toBe('Por pagar');
    expect(estadoCobro(cobro({ status: 'pending', due_date: '2026-10-01' }), HOY).label).toBe('Vencido');
    expect(estadoCobro(cobro({ status: 'awaiting_approval' }), HOY).label).toBe('En revisión');
    expect(estadoCobro(cobro({ status: 'paid' }), HOY).label).toBe('Pagado');
    expect(estadoCobro(cobro({ status: 'glosado' }), HOY).label).toBe('Necesita aclaración');
    expect(estadoCobro(cobro({ status: 'algo_nuevo' as string }), HOY).label).not.toMatch(/_/);
  });
});

describe('agruparPorMes', () => {
  it('un mes por periodo, el más reciente arriba, con el estado más urgente', () => {
    const meses = agruparPorMes(SOFIA, HOY);
    expect(meses.map((m) => m.titulo)).toEqual(['Octubre de 2026', 'Septiembre de 2026', 'Julio de 2026']);
    expect(meses.map((m) => m.estado.label)).toEqual(['Vencido', 'Vencido', 'Pagado']);
    // Dentro del mes, lo que se debe va primero.
    expect(meses[1].cobros.map((c) => c.id)).toEqual(['sep', 'sep-rev']);
  });
  it('no muestra los anulados', () => {
    expect(agruparPorMes([cobro({ status: 'cancelled' })], HOY)).toEqual([]);
  });
  it('sin periodo usa la fecha límite', () => {
    const [m] = agruparPorMes([cobro({ period_year: null, period_month: null, due_date: '2026-03-15' })], HOY);
    expect(m.titulo).toBe('Marzo de 2026');
  });
  it('primer cobro sin recargo (Dreamers): agrupa por el periodo aunque venza el mes siguiente', () => {
    // Alta el 5/nov con corte día 1: periodo 11, vence el 01/12. Es la
    // mensualidad de NOVIEMBRE; agrupar por el vencimiento la mostraba en
    // «Diciembre» (heurística de 469b9eaf, retirada).
    const [m] = agruparPorMes([cobro({ id: 'amira', period_year: 2026, period_month: 11, due_date: '2026-12-01', concept: 'Plan PGP4x1 — Mensualidad completa, vence el 01/12 — Amira' })], HOY);
    expect(m.titulo).toBe('Noviembre de 2026');
  });
});

describe('resumenCuenta: una frase y un botón', () => {
  it('debe varios: el saldo es el de la RPC y el botón va a Pagos', () => {
    const r = resumenCuenta('Sofía Herrera', 765_000, SOFIA, fmt, HOY);
    expect(r.titulo).toBe('Sofía debe $ 765.000');
    expect(r.subtitulo).toContain('2 cobros vencidos.');
    expect(r.subtitulo).toContain('1 pago está en revisión.');
    expect(r.boton).toEqual({ label: 'Pagar 2 cobros', href: '/my-payments' });
  });
  it('un solo cobro pagable: el botón abre ese cobro', () => {
    const r = resumenCuenta('Sofía Herrera', 210_000, [cobro({ id: 'abc', status: 'overdue' })], fmt, HOY);
    expect(r.boton).toEqual({ label: 'Pagar', href: '/my-payments?pay=abc' });
  });
  it('un abono parcial no se abre directo (va a Pagos)', () => {
    const r = resumenCuenta('Sofía', 50_000, [cobro({ id: 'x', status: 'partial' })], fmt, HOY);
    expect(r.boton?.href).toBe('/my-payments');
  });
  it('al día', () => {
    const r = resumenCuenta('Tomás Herrera', 0, [cobro({ status: 'paid' })], fmt, HOY);
    expect(r.titulo).toBe('Tomás está al día');
    expect(r.boton).toBeNull();
  });
  it('solo en revisión: no dice «debe» ni muestra botón de pagar', () => {
    const r = resumenCuenta('Sofía', 90_000, [cobro({ status: 'awaiting_approval' })], fmt, HOY);
    expect(r.titulo).toBe('Sofía no tiene nada por pagar');
    expect(r.boton).toBeNull();
  });
  it('glosa: botón para responder', () => {
    const r = resumenCuenta('Sofía', 90_000, [cobro({ status: 'glosado' })], fmt, HOY);
    expect(r.boton?.label).toBe('Responder a la escuela');
  });
});

describe('textos de cada cobro', () => {
  it('quita el nombre del hijo del concepto', () => {
    expect(tituloCobro(SOFIA[1], 'Sofía Herrera')).toBe('Mensualidad 09/2026 · Natación Infantil');
    expect(tituloCobro(SOFIA[3], 'Sofía Herrera')).toBe('Mensualidad Julio 2026 · Natación Infantil');
  });
  it('detalle con fechas en palabras', () => {
    expect(detalleCobro(SOFIA[0], HOY)).toBe('Venció el 10 de octubre');
    expect(detalleCobro(SOFIA[3], HOY)).toBe('Pagado el 6 de julio');
    expect(detalleCobro(SOFIA[1], HOY)).toMatch(/^Enviaste el comprobante el 19 de septiembre/);
  });
  it('valor: lo pagado si está pagado, si no el valor del cobro', () => {
    expect(valorCobro(cobro({ status: 'paid', amount: 200_000, amount_paid: 180_000 }))).toBe(180_000);
    expect(valorCobro(cobro({ status: 'overdue', amount: 210_000 }))).toBe(210_000);
  });
});
