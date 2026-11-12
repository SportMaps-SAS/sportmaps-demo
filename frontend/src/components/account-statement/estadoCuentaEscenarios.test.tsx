/**
 * Escenarios del estado de cuenta, armados con lo que de verdad hay en la base de
 * Besser (corte 2026-11-12): pagos en transferencia, efectivo y registrados por la
 * escuela; pagos «pagados» sin fecha de pago; un abono parcial; comprobantes por
 * revisar; cobros vencidos desde septiembre; cobros anulados; asistencia con
 * presentes, faltas, excusadas y tardanzas.
 *
 * Cada caso protege algo que ya salió mal en otra parte del producto o que
 * saldría mal si alguien cambia el modelo sin mirar los datos reales.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  agruparPorMes, resumenCuenta, estadoCobro, detalleCobro, lineaFechas, puntualidad, abonoDe, valorCobro,
  asistenciaPorMes, textoAsistencia, parametrosEstadoCuenta, type CobroCuenta,
} from './estadoCuentaModel';
import { EstadoCuentaAcudienteView } from './EstadoCuentaAcudiente';
import type { StatementData } from './statementPrint';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

const HOY = new Date(2026, 10, 12, 10, 0); // 12 de noviembre de 2026
const fmt = (n: number) => `$ ${n.toLocaleString('es-CO')}`;

const cobro = (over: Partial<CobroCuenta>): CobroCuenta => ({
  id: 'p', status: 'pending', amount: 380_000, amount_paid: null, concept: 'Mensualidad - Valentina Ospina',
  due_date: '2026-11-10', payment_date: null, period_year: 2026, period_month: 11, created_at: '2026-11-01T06:30:00Z', ...over,
});

describe('escenarios de un cobro', () => {
  it('paga a tiempo por transferencia con comprobante', () => {
    const c = cobro({ status: 'paid', amount_paid: 380_000, due_date: '2026-09-10', payment_date: '2026-09-08', payment_channel: 'transfer', receipt_url: 'x.jpg', period_month: 9 });
    expect(estadoCobro(c, HOY)).toEqual({ label: 'Pagado', tono: 'ok' });
    expect(lineaFechas(c, HOY)).toBe('Límite 10 de septiembre · pagó 8 de septiembre');
    expect(puntualidad(c, HOY)).toEqual({ label: 'Pagó a tiempo', tono: 'ok' });
  });

  it('paga el mismo día del límite: a tiempo', () => {
    expect(puntualidad(cobro({ status: 'paid', payment_date: '2026-11-10' }), HOY)?.label).toBe('Pagó a tiempo');
  });

  it('paga un día tarde y varios días tarde', () => {
    expect(puntualidad(cobro({ status: 'paid', payment_date: '2026-11-11' }), HOY)?.label).toBe('Pagó 1 día tarde');
    expect(puntualidad(cobro({ status: 'paid', payment_date: '2026-11-12' }), HOY)).toEqual({ label: 'Pagó 2 días tarde', tono: 'aviso' });
  });

  it('pagado SIN fecha de pago (hay 3 así en Besser): no inventa puntualidad', () => {
    const c = cobro({ status: 'paid', amount_paid: 380_000, payment_date: null });
    expect(puntualidad(c, HOY)).toBeNull();
    expect(lineaFechas(c, HOY)).toBe('Límite 10 de noviembre · pagado');
    expect(detalleCobro(c, HOY)).toBe('Pagado');
    expect(estadoCobro(c, HOY).label).toBe('Pagado');
  });

  it('pagado sin fecha límite: solo dice que pagó', () => {
    const c = cobro({ status: 'paid', due_date: null, payment_date: '2026-11-05' });
    expect(lineaFechas(c, HOY)).toBe('pagó 5 de noviembre');
    expect(puntualidad(c, HOY)).toBeNull();
  });

  it('el pago cruza el cambio de año: 26 días tarde', () => {
    const c = cobro({ status: 'paid', due_date: '2026-12-10', payment_date: '2027-01-05', period_month: 12 });
    expect(puntualidad(c, new Date(2027, 0, 20))?.label).toBe('Pagó 26 días tarde');
    expect(lineaFechas(c, new Date(2027, 0, 20))).toBe('Límite 10 de diciembre de 2026 · pagó 5 de enero');
  });

  it('el día del límite todavía no está vencido', () => {
    const c = cobro({ status: 'pending', due_date: '2026-11-12' });
    expect(estadoCobro(c, HOY).label).toBe('Por pagar');
    expect(puntualidad(c, HOY)).toBeNull();
  });

  it('un día después del límite ya está vencido, con su conteo', () => {
    const c = cobro({ status: 'pending', due_date: '2026-11-11' });
    expect(estadoCobro(c, HOY).label).toBe('Vencido');
    expect(puntualidad(c, HOY)?.label).toBe('Lleva 1 día vencido');
  });

  it('vencido desde septiembre: 63 días', () => {
    expect(puntualidad(cobro({ status: 'overdue', due_date: '2026-09-10', period_month: 9 }), HOY)?.label).toBe('Lleva 63 días vencido');
  });

  it('vencido sin fecha límite: está vencido pero no cuenta días', () => {
    const c = cobro({ status: 'overdue', due_date: null });
    expect(estadoCobro(c, HOY).label).toBe('Vencido');
    expect(puntualidad(c, HOY)).toBeNull();
    expect(lineaFechas(c, HOY)).toBe('sin pagar');
  });

  it('abono parcial vencido: cuánto abonó, cuánto falta y hace cuánto venció', () => {
    const c = cobro({ status: 'partial', amount: 210_000, amount_paid: 100_000, due_date: '2026-10-10', payment_date: '2026-10-14', period_month: 10 });
    expect(abonoDe(c)).toEqual({ abonado: 100_000, falta: 110_000 });
    expect(lineaFechas(c, HOY)).toBe('Límite 10 de octubre · abonó 14 de octubre');
    expect(puntualidad(c, HOY, fmt)?.label).toBe('Falta $ 110.000 · vencido hace 33 días');
  });

  it('abono que ya cubre todo el valor no inventa un «falta $0»', () => {
    const c = cobro({ status: 'partial', amount: 210_000, amount_paid: 210_000 });
    expect(abonoDe(c)).toBeNull();
    expect(detalleCobro(c, HOY, fmt)).toBe('Ya abonaste una parte. El saldo se paga desde Pagos.');
  });

  it('comprobante por revisar: sin puntualidad y sin llamarlo «pagado»', () => {
    const c = cobro({ status: 'awaiting_approval', payment_date: '2026-11-11' });
    expect(estadoCobro(c, HOY).label).toBe('En revisión');
    expect(puntualidad(c, HOY)).toBeNull();
    expect(lineaFechas(c, HOY)).toBe('Límite 10 de noviembre · comprobante enviado 11 de noviembre');
  });

  it('comprobante rechazado, pago que no pasó y glosa: ninguno cuenta puntualidad', () => {
    for (const status of ['rejected', 'failed', 'glosado']) {
      expect(puntualidad(cobro({ status }), HOY)).toBeNull();
    }
    expect(estadoCobro(cobro({ status: 'rejected' }), HOY).label).toBe('Rechazado');
    expect(estadoCobro(cobro({ status: 'failed' }), HOY).label).toBe('No pasó');
  });

  it('cobro anulado: no sale en los meses', () => {
    expect(agruparPorMes([cobro({ status: 'cancelled' })], HOY)).toEqual([]);
  });

  it('un valor pagado mayor al cobrado se muestra tal cual (el club decide qué hacer)', () => {
    expect(valorCobro(cobro({ status: 'paid', amount: 135_000, amount_paid: 155_000 }))).toBe(155_000);
  });

  it('un estado que no conocemos nunca se ve en inglés ni con guion bajo', () => {
    const { label } = estadoCobro(cobro({ status: 'algo_nuevo' }), HOY);
    expect(label).not.toMatch(/_|algo_nuevo/);
  });
});

describe('escenarios de la cuenta completa', () => {
  const CUENTA: CobroCuenta[] = [
    cobro({ id: 'sep', status: 'paid', amount_paid: 380_000, due_date: '2026-09-10', payment_date: '2026-09-08', period_month: 9 }),
    cobro({ id: 'oct', status: 'partial', amount_paid: 200_000, due_date: '2026-10-10', payment_date: '2026-10-14', period_month: 10 }),
    cobro({ id: 'nov', status: 'overdue' }),
    cobro({ id: 'x', status: 'cancelled', period_month: 8, due_date: '2026-08-10' }),
  ];

  it('meses de más reciente a más antiguo, con el estado más urgente', () => {
    const meses = agruparPorMes(CUENTA, HOY);
    expect(meses.map((m) => m.titulo)).toEqual(['Noviembre de 2026', 'Octubre de 2026', 'Septiembre de 2026']);
    expect(meses.map((m) => m.estado.label)).toEqual(['Vencido', 'Abono parcial', 'Pagado']);
  });

  it('la frase dice cuánto debe y cuántos cobros están vencidos', () => {
    const r = resumenCuenta('Valentina Ospina', 560_000, CUENTA, fmt, HOY);
    expect(r.titulo).toBe('Valentina debe $ 560.000');
    expect(r.subtitulo).toContain('2 cobros vencidos.');
    expect(r.boton?.label).toBe('Pagar 2 cobros');
  });

  it('un mes con mensualidad y camiseta: sale en un solo mes con los dos cobros', () => {
    const meses = agruparPorMes([
      cobro({ id: 'm', status: 'paid', payment_date: '2026-11-05', amount_paid: 380_000 }),
      cobro({ id: 'k', status: 'overdue', concept: 'Camiseta - Valentina Ospina', amount: 60_000 }),
    ], HOY);
    expect(meses).toHaveLength(1);
    expect(meses[0].cobros.map((c) => c.id)).toEqual(['k', 'm']); // lo que se debe va primero
    expect(meses[0].estado.label).toBe('Vencido');
  });

  it('sin ningún cobro: no hay meses ni errores', () => {
    expect(agruparPorMes([], HOY)).toEqual([]);
  });
});

describe('voz de la página pública: no manda a pantallas que no existen', () => {
  it('el abono dice cuánto falta, sin «se paga desde Pagos»', () => {
    const c = cobro({ status: 'partial', amount: 380_000, amount_paid: 200_000 });
    expect(detalleCobro(c, HOY, fmt, 'publica')).toBe('Abonaste $ 200.000. Falta $ 180.000.');
    expect(detalleCobro(c, HOY, fmt, 'familia')).toContain('se paga desde Pagos');
  });
  it('rechazado y «no pasó» no piden volver a subir ni reintentar', () => {
    expect(detalleCobro(cobro({ status: 'rejected' }), HOY, fmt, 'publica')).toBe('La escuela rechazó el comprobante.');
    expect(detalleCobro(cobro({ status: 'failed' }), HOY, fmt, 'publica')).toBe('El pago no pasó.');
  });
});

describe('asistencia por mes', () => {
  const ev = (fecha: string, attendance_status: string | null, tipo = 'sesion') => ({ tipo, fecha, attendance_status });

  it('cuenta presentes, tarde, excusadas y faltas por mes', () => {
    const m = asistenciaPorMes([
      ev('2026-10-02', 'present'), ev('2026-10-04', 'present'), ev('2026-10-09', 'late'),
      ev('2026-10-11', 'absent'), ev('2026-10-16', 'excused'),
      ev('2026-11-03', 'present'),
    ]);
    expect(m.get('2026-10')).toEqual({ asistio: 3, tarde: 1, excusada: 1, falto: 1, total: 5 });
    expect(m.get('2026-11')).toEqual({ asistio: 1, tarde: 0, excusada: 0, falto: 0, total: 1 });
  });

  it('ignora los pagos de la línea de tiempo', () => {
    expect(asistenciaPorMes([ev('2026-10-05', null, 'pago')]).size).toBe(0);
  });

  it('un estado desconocido suma a las clases pero a ningún otro grupo', () => {
    const m = asistenciaPorMes([ev('2026-10-02', 'otro_estado')]);
    expect(m.get('2026-10')).toEqual({ asistio: 0, tarde: 0, excusada: 0, falto: 0, total: 1 });
  });

  it('el texto es corto y en palabras', () => {
    expect(textoAsistencia({ asistio: 8, tarde: 0, excusada: 0, falto: 0, total: 8 })).toBe('Asistió a 8 de 8 clases');
    expect(textoAsistencia({ asistio: 1, tarde: 1, excusada: 1, falto: 1, total: 3 })).toBe('Asistió a 1 de 3 clases · 1 falta · 1 excusada · llegó tarde 1 vez');
    expect(textoAsistencia({ asistio: 0, tarde: 0, excusada: 0, falto: 2, total: 2 })).toBe('Asistió a 0 de 2 clases · 2 faltas');
    expect(textoAsistencia({ asistio: 1, tarde: 0, excusada: 0, falto: 0, total: 1 })).toBe('Asistió a 1 de 1 clase');
  });
});

describe('a quién pertenece el estado de cuenta', () => {
  const base = { child_id: null, adult_id: null, unregistered_athlete_id: null, name: 'X' };
  it('arma el enlace según el tipo de atleta', () => {
    expect(parametrosEstadoCuenta({ ...base, child_id: 'h' })).toBe('child_id=h');
    expect(parametrosEstadoCuenta({ ...base, adult_id: 'u' })).toBe('user_id=u');
    expect(parametrosEstadoCuenta({ ...base, unregistered_athlete_id: 'f' })).toBe('unregistered_athlete_id=f');
  });
});

describe('la pantalla con los escenarios', () => {
  const STATEMENT: StatementData = {
    athlete_name: 'Valentina Ospina',
    summary: { count_expected: 3, total_expected: 1_140_000, count_settled: 1, total_settled: 580_000, count_open: 2, total_open: 560_000, total_late_fees: 0 },
    meses: [],
    events: [
      { tipo: 'sesion', fecha: '2026-11-03', status: null, amount: null, amount_paid: null, attendance_status: 'present' },
      { tipo: 'sesion', fecha: '2026-11-05', status: null, amount: null, amount_paid: null, attendance_status: 'absent' },
      { tipo: 'sesion', fecha: '2026-10-07', status: null, amount: null, amount_paid: null, attendance_status: 'present' },
      { tipo: 'pago', fecha: '2026-09-08', status: 'paid', amount: 380_000, amount_paid: 380_000, attendance_status: null },
    ],
  };
  const COBROS: CobroCuenta[] = [
    cobro({ id: 'sep', status: 'paid', amount_paid: 380_000, due_date: '2026-09-10', payment_date: '2026-09-08', period_month: 9, payment_channel: 'transfer', receipt_url: 'c.jpg' }),
    cobro({ id: 'oct', status: 'partial', amount_paid: 200_000, due_date: '2026-10-10', payment_date: '2026-10-14', period_month: 10, payment_channel: 'cash' }),
    cobro({ id: 'nov', status: 'overdue' }),
  ];

  const pintar = (modo: 'familia' | 'escuela', extra: Partial<Parameters<typeof EstadoCuentaAcudienteView>[0]> = {}) =>
    render(
      <MemoryRouter>
        <EstadoCuentaAcudienteView state="ready" statement={STATEMENT} cobros={COBROS} months={12} onRetry={vi.fn()} onPrint={vi.fn()} now={HOY} modo={modo} {...extra} />
      </MemoryRouter>,
    );

  it('familia: ve la frase, el botón de pagar y la asistencia del mes', () => {
    pintar('familia');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Valentina debe/);
    expect(screen.getByRole('link', { name: 'Pagar 2 cobros' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Octubre de 2026/ }));
    expect(screen.getByText(/Asistió a 1 de 1 clase/)).toBeTruthy();
  });

  it('escuela: lo mismo pero sin pagar, y con el cómo pagó', () => {
    pintar('escuela');
    expect(screen.queryByRole('link', { name: /Pagar/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Septiembre de 2026/ }));
    expect(screen.getByText('Transferencia')).toBeTruthy();
    expect(screen.getByText('con comprobante', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Octubre de 2026/ }));
    expect(screen.getByText('Efectivo')).toBeTruthy();
  });

  it('el resumen de asistencia de todo el período aparece abajo', () => {
    pintar('familia');
    expect(screen.getByText(/Asistencia en los últimos 12 meses: Asistió a 2 de 3 clases · 1 falta/)).toBeTruthy();
  });

  it('con más de 12 meses ofrece «Ver meses anteriores» y los muestra al pedirlos', () => {
    const catorce: CobroCuenta[] = Array.from({ length: 14 }, (_, i) => {
      const mes = ((10 - i + 12) % 12) + 1; // nov 2026 hacia atrás
      const anio = i <= 10 ? 2026 : 2025;
      return cobro({ id: `m${i}`, status: 'paid', amount_paid: 380_000, period_year: anio, period_month: mes, due_date: `${anio}-${String(mes).padStart(2, '0')}-10`, payment_date: `${anio}-${String(mes).padStart(2, '0')}-08` });
    });
    pintar('familia', { cobros: catorce });
    const antes = screen.getAllByRole('button', { name: /de 202[56]/ }).length;
    expect(antes).toBe(12);
    fireEvent.click(screen.getByRole('button', { name: 'Ver meses anteriores' }));
    expect(screen.getAllByRole('button', { name: /de 202[56]/ }).length).toBe(14);
  });

  it('un mes cerrado y abierto de nuevo conserva su contenido', () => {
    pintar('familia');
    const sep = screen.getByRole('button', { name: /Septiembre de 2026/ });
    fireEvent.click(sep);
    expect(within(sep.parentElement as HTMLElement).getByText('Pagó a tiempo')).toBeTruthy();
    fireEvent.click(sep);
    expect(within(sep.parentElement as HTMLElement).queryByText('Pagó a tiempo')).toBeNull();
    fireEvent.click(sep);
    expect(within(sep.parentElement as HTMLElement).getByText('Pagó a tiempo')).toBeTruthy();
  });
});
