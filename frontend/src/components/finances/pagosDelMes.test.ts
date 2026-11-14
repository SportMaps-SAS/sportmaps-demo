import { describe, it, expect } from 'vitest';
import { filasDelMes, resumenPagos, grupoDe, type CobroDelMes } from './pagosDelMes';

const HOY = new Date(2026, 10, 12, 10, 0); // 12 de noviembre de 2026

const cobro = (over: Partial<CobroDelMes>): CobroDelMes => ({
  id: 'p', status: 'pending', amount: 380_000, amount_paid: null, concept: 'Mensualidad 11/2026',
  due_date: '2026-11-10', payment_date: null, period_year: 2026, period_month: 11, created_at: '2026-11-01T06:30:00Z',
  child_id: null, user_id: null, unregistered_athlete_id: null, ...over,
});

const NOMBRES = new Map([['a', 'Camila Torres'], ['b', 'Santiago Beltrán'], ['c', 'Valentina Ospina'], ['d', 'Mateo Cifuentes'], ['e', 'Luciana Montoya'], ['f', 'Samuel Quiroga']]);

const COBROS: CobroDelMes[] = [
  cobro({ id: '1', child_id: 'a', status: 'paid', amount_paid: 380_000, payment_date: '2026-11-06' }),
  cobro({ id: '2', child_id: 'b', status: 'overdue' }),
  cobro({ id: '3', child_id: 'c', status: 'paid', amount_paid: 380_000, payment_date: '2026-11-12' }),
  cobro({ id: '4', unregistered_athlete_id: 'd', status: 'awaiting_approval', payment_date: '2026-11-11' }),
  cobro({ id: '5', child_id: 'e', status: 'partial', amount: 210_000, amount_paid: 100_000 }),
  cobro({ id: '6', child_id: 'f', status: 'paid', amount: 0, amount_paid: 0 }),
];

describe('grupoDe', () => {
  it('agrupa por lo que hay que hacer', () => {
    expect(grupoDe(cobro({ status: 'paid' }), HOY)).toBe('pago');
    expect(grupoDe(cobro({ status: 'overdue' }), HOY)).toBe('vencido');
    expect(grupoDe(cobro({ status: 'pending', due_date: '2026-11-30' }), HOY)).toBe('pendiente');
    expect(grupoDe(cobro({ status: 'pending', due_date: '2026-11-01' }), HOY)).toBe('vencido');
    expect(grupoDe(cobro({ status: 'awaiting_approval' }), HOY)).toBe('revision');
    expect(grupoDe(cobro({ status: 'glosado' }), HOY)).toBe('revision');
    expect(grupoDe(cobro({ status: 'partial' }), HOY)).toBe('abono');
  });
});

describe('filasDelMes', () => {
  it('lo urgente primero: vencidos, abonos, en revisión y al final los que pagaron', () => {
    const filas = filasDelMes(COBROS, NOMBRES, HOY);
    expect(filas.map((f) => f.nombre)).toEqual([
      'Santiago Beltrán', 'Luciana Montoya', 'Mateo Cifuentes', 'Valentina Ospina', 'Camila Torres', 'Samuel Quiroga',
    ]);
  });

  it('entre los que pagaron, primero quien pagó más tarde', () => {
    const filas = filasDelMes(COBROS, NOMBRES, HOY).filter((f) => f.grupo === 'pago');
    expect(filas[0].nombre).toBe('Valentina Ospina'); // pagó el 12: 2 días tarde
    expect(filas[0].dias).toBe(2);
    expect(filas.find((f) => f.nombre === 'Camila Torres')?.dias).toBe(0);
  });

  it('el objetivo apunta al hijo, a la ficha o al adulto según el cobro', () => {
    const filas = filasDelMes([
      cobro({ id: 'h', child_id: 'a' }),
      cobro({ id: 'u', unregistered_athlete_id: 'd' }),
      cobro({ id: 'x', user_id: 'e' }),
    ], NOMBRES, HOY);
    const por = (n: string) => filas.find((f) => f.nombre === n)!.objetivo;
    expect(por('Camila Torres')).toMatchObject({ child_id: 'a', adult_id: null, unregistered_athlete_id: null });
    expect(por('Mateo Cifuentes')).toMatchObject({ child_id: null, adult_id: null, unregistered_athlete_id: 'd' });
    expect(por('Luciana Montoya')).toMatchObject({ child_id: null, adult_id: 'e', unregistered_athlete_id: null });
  });

  it('no esconde a quien no tiene nombre ni cuenta los anulados', () => {
    const filas = filasDelMes([
      cobro({ id: 'n', child_id: 'zzz', status: 'overdue' }),
      cobro({ id: 'c', child_id: 'a', status: 'cancelled' }),
    ], NOMBRES, HOY);
    expect(filas).toHaveLength(1);
    expect(filas[0].nombre).toBe('Sin nombre');
  });

  it('varios cobros del mismo atleta: una fila con el más urgente', () => {
    const filas = filasDelMes([
      cobro({ id: 'm', child_id: 'a', status: 'paid', amount_paid: 380_000, payment_date: '2026-11-05' }),
      cobro({ id: 'k', child_id: 'a', status: 'overdue', concept: 'Camiseta', amount: 60_000 }),
    ], NOMBRES, HOY);
    expect(filas).toHaveLength(1);
    expect(filas[0].cobro.id).toBe('k');
    expect(filas[0].otros).toBe(1);
  });
});

describe('resumenPagos: cuenta personas, no pesos', () => {
  it('cuántos pagaron, a tiempo, vencidos, en revisión y con abono', () => {
    const r = resumenPagos(filasDelMes(COBROS, NOMBRES, HOY));
    // Samuel (becado, $0) no cuenta.
    expect(r).toEqual({ total: 5, pagaron: 2, aTiempo: 1, vencidos: 1, enRevision: 1, abonos: 1, porPagar: 0 });
  });
});
