import { describe, expect, it } from 'vitest';
import {
  construirHorario,
  contarPorConfirmar,
  ingresosDelMes,
  minutosAbiertosDeLaSemana,
  ocupacionSemanal,
  type VenueReservationRow,
} from './venueMetrics';

const r = (over: Partial<VenueReservationRow>): VenueReservationRow => ({
  id: 'x', facility_id: 'f1', reservation_date: '2026-11-03',
  start_time: '18:00:00', end_time: '19:00:00', status: 'confirmed', price: 100000, ...over,
});

describe('venueMetrics', () => {
  it('construirHorario cubre los 7 días y suma las horas abiertas', () => {
    const h = construirHorario({ desde: '06:00', hasta: '22:00' });
    expect(Object.keys(h)).toHaveLength(7);
    expect(minutosAbiertosDeLaSemana(h)).toBe(7 * 16 * 60);
  });

  it('ocupacionSemanal: horas reservadas sobre horas abiertas; cancelada no cuenta', () => {
    const f = [{ id: 'f1', name: 'C1', available_hours: construirHorario({ desde: '08:00', hasta: '18:00' }) }];
    const reservas = [r({}), r({ status: 'cancelled' }), r({ start_time: '10:00', end_time: '12:00' })];
    // 3 h reservadas / 70 h abiertas = 4.28 → 4 %
    expect(ocupacionSemanal(f, reservas)).toBe(4);
  });

  it('ocupacionSemanal es null sin horario (no inventa un porcentaje)', () => {
    expect(ocupacionSemanal([{ id: 'f1', name: 'C1', available_hours: {} }], [r({})])).toBeNull();
  });

  it('contarPorConfirmar y ingresosDelMes', () => {
    const rows = [r({ status: 'pending' }), r({ status: 'pending_payment' }), r({}), r({ status: 'completed', price: 50000 }), r({ status: 'cancelled' })];
    expect(contarPorConfirmar(rows)).toBe(2);
    expect(ingresosDelMes(rows)).toBe(150000);
  });
});
