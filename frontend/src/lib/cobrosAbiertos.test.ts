import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import {
  ayudaAsistencia, decisionInicial, decisionesParaEnviar, erroresDeDecisiones, hayAlgoQueResolver,
  leyendaAjuste, mesLegible, type CobroAbierto, type CobrosAbiertosResumen,
} from './cobrosAbiertos';
import {
  ajusteNota, esAnuladoReciente, groupTransactions, waitingLabel, type Transaction,
} from '@/components/parent/v2/pagosModel';

const cobro = (o: Partial<CobroAbierto> = {}): CobroAbierto => ({
  payment_id: 'p1', concepto: 'Mensualidad 09/2026', period_year: 2026, period_month: 9,
  status: 'overdue', amount: 340000, amount_paid: 0, late_fee_amount: 0, discount_pct: null,
  tiene_comprobante: false, ocr_amount: null, asistencias: 0, clases_con_lista: 12,
  monto_sugerido: 210000, puede_anular: true, puede_cambiar_valor: true, ...o,
});

describe('ayuda de asistencia', () => {
  it('escuela que no toma lista: no hay columna', () => {
    expect(ayudaAsistencia(cobro(), false)).toBeNull();
  });
  it('equipo sin ninguna lista ese mes: «sin registro», nunca «0 asistencias»', () => {
    expect(ayudaAsistencia(cobro({ clases_con_lista: 0 }), true)).toEqual({ texto: 'Sin registro de asistencia', tono: 'sin_dato' });
  });
  it('hubo clases y no vino: alerta', () => {
    expect(ayudaAsistencia(cobro({ asistencias: 0, clases_con_lista: 12 }), true)).toEqual({ texto: '0 asistencias de 12 clases', tono: 'alerta' });
  });
  it('vino: normal, singular bien escrito', () => {
    expect(ayudaAsistencia(cobro({ asistencias: 1, clases_con_lista: 1 }), true)?.texto).toBe('1 de 1 clase');
  });
});

describe('decisión inicial', () => {
  it('nunca preselecciona anular, ni con 0 asistencias', () => {
    expect(decisionInicial(cobro({ asistencias: 0 }), 'no_asistio').accion).toBe('dejar');
    expect(decisionInicial(cobro({ asistencias: 0 }), 'cambio_plan').accion).not.toBe('anular');
  });
  it('tras cambio de plan propone el valor nuevo si difiere', () => {
    expect(decisionInicial(cobro({ status: 'awaiting_approval' }), 'cambio_plan')).toEqual({ accion: 'valor', monto: 210000 });
  });
  it('tras cambio de plan no propone nada si ya tiene el valor', () => {
    expect(decisionInicial(cobro({ amount: 210000 }), 'cambio_plan').accion).toBe('dejar');
  });
  it('no propone un valor menor o igual a lo abonado', () => {
    expect(decisionInicial(cobro({ status: 'partial', amount_paid: 250000 }), 'cambio_plan').accion).toBe('dejar');
  });
});

describe('validación y envío', () => {
  const cobros = [cobro({ payment_id: 'sep' }), cobro({ payment_id: 'oct', period_month: 10, status: 'awaiting_approval', puede_anular: false })];

  it('anular exige motivo', () => {
    const d = { sep: { accion: 'anular' as const, monto: null }, oct: { accion: 'dejar' as const, monto: null } };
    expect(erroresDeDecisiones(cobros, d, '  ')).toHaveLength(1);
    expect(erroresDeDecisiones(cobros, d, 'la mamá avisó')).toEqual([]);
  });
  it('no deja anular lo que la base marcó como no anulable', () => {
    const d = { oct: { accion: 'anular' as const, monto: null } };
    expect(erroresDeDecisiones(cobros, d, 'x')[0]).toMatch(/Octubre 2026 no se puede anular/);
  });
  it('valor nuevo debe ser positivo', () => {
    const d = { oct: { accion: 'valor' as const, monto: 0 } };
    expect(erroresDeDecisiones(cobros, d, '')).toHaveLength(1);
  });
  it('el caso Isabella: septiembre anulado + octubre a 210.000', () => {
    const d = { sep: { accion: 'anular' as const, monto: null }, oct: { accion: 'valor' as const, monto: 210000 } };
    expect(decisionesParaEnviar(cobros, d)).toEqual([
      { payment_id: 'sep', accion: 'anular' },
      { payment_id: 'oct', accion: 'valor', monto: 210000 },
    ]);
  });
  it('«dejar» y un valor igual al actual no viajan', () => {
    const d = { sep: { accion: 'dejar' as const, monto: null }, oct: { accion: 'valor' as const, monto: 340000 } };
    expect(decisionesParaEnviar(cobros, d)).toEqual([]);
  });
});

describe('cuándo se abre sola tras guardar', () => {
  const res = (cobros: CobroAbierto[]): CobrosAbiertosResumen =>
    ({ enrollment_id: 'e', school_id: 's', atleta: 'A', cuota_vigente: 210000, escuela_toma_lista: true, cobros });
  it('sin cobros abiertos: no', () => expect(hayAlgoQueResolver(res([]))).toBe(false));
  it('cobro con el valor viejo: sí', () => expect(hayAlgoQueResolver(res([cobro({ status: 'pending' })]))).toBe(true));
  it('todo al día con el valor nuevo: no', () =>
    expect(hayAlgoQueResolver(res([cobro({ status: 'pending', amount: 210000 })]))).toBe(false));
});

it('mes legible', () => expect(mesLegible({ period_year: 2026, period_month: 9 })).toBe('Septiembre 2026'));

describe('lado familia', () => {
  const fmt = (n: number) => `$${n}`;
  it('leyendas del ajuste', () => {
    expect(leyendaAjuste(undefined, fmt)).toBeNull();
    expect(leyendaAjuste({ payment_id: 'p', kind: 'anulado_no_asistio', amount_before: 340000, amount_after: null, motivo: null, created_at: '' }, fmt))
      .toBe('Anulado por la escuela: no asistió');
  });

  const now = new Date('2026-10-29T12:00:00Z');
  const tx = (o: Partial<Transaction>): Transaction =>
    ({ id: 'x', amount: 340000, status: 'pending', reference: 'r', transaction_date: '2026-09-05', ...o });

  it('el mes anulado por «no asistió» se le muestra a la familia como «No se cobra»', () => {
    const t = tx({ status: 'cancelled', ajuste_kind: 'anulado_no_asistio', ajuste_at: '2026-10-29T10:00:00Z', ajuste_motivo: 'Estuvo fuera.' });
    expect(esAnuladoReciente(t, now)).toBe(true);
    expect(groupTransactions([t], now).waiting).toHaveLength(1);
    expect(waitingLabel(t)).toEqual({ label: 'No se cobra', detail: 'La escuela anuló este mes: no asistió. Estuvo fuera.' });
  });
  it('pasado el aviso, el anulado vuelve a ocultarse; un anulado común nunca se ve', () => {
    const viejo = tx({ status: 'cancelled', ajuste_kind: 'anulado_no_asistio', ajuste_at: '2026-08-01T10:00:00Z' });
    const comun = tx({ status: 'cancelled' });
    const g = groupTransactions([viejo, comun], now);
    expect(g.waiting.length + g.payable.length + g.paid.length).toBe(0);
  });
  it('cobro con valor ajustado lleva la nota con el monto anterior', () => {
    const t = tx({ amount: 210000, status: 'awaiting_approval', ajuste_kind: 'valor_cambio_plan', ajuste_antes: 340000 });
    expect(ajusteNota(t)).toMatch(/^Ajustado por cambio de plan \(antes \$\s?340\.000\)$/);
    expect(ajusteNota(tx({}))).toBeNull();
  });
});
