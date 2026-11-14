import { describe, it, expect, vi } from 'vitest';

// El cliente de Supabase se crea al importar; aquí solo se prueba lógica pura.
vi.mock('../config/supabase', () => ({ supabase: {} }));

import { buildAltaPayments, vencimientoPrimerCobroAlta } from './students-create-one.route';
import { esTablaInexistente } from './me.routes';

// B5 — alta por código de escuela (rama child_existing): Mateo Pardo Demo,
// alta el 26-oct con corte 10 → el cobro nacía con parent_id NULL y vencía el 26.
const base = {
  schoolId: 's-1', athleteCol: 'child_id' as const, athleteId: 'c-mateo',
  branchId: null, teamId: 't-1', offeringPlanId: null, baseFee: 180_000,
  startDate: '2026-10-26', cycleType: 'fixed_calendar' as const, cutoffDay: 10,
  conceptName: 'Suscripción', personName: 'Mateo Pardo Demo', remaining: null, today: '2026-10-26',
};

describe('buildAltaPayments — pagador (B5)', () => {
  it('con el acudiente del menor, el cobro nace con parent_id', () => {
    const [row] = buildAltaPayments({ ...base, parentId: 'u-familia' });
    expect(row.parent_id).toBe('u-familia');
    expect(row.child_id).toBe('c-mateo');
  });

  it('sin acudiente con cuenta no se inventa: la fila es la de siempre (sin parent_id)', () => {
    const [row] = buildAltaPayments(base);
    expect('parent_id' in row).toBe(false);
  });
});

describe('vencimientoPrimerCobroAlta (B5)', () => {
  it('un cobro que vence el mismo día del alta pasa a hoy + gracia, y el concepto lo dice', () => {
    const rows = buildAltaPayments({ ...base, parentId: 'u-familia' });
    expect(rows[0].due_date).toBe('2026-10-26');
    const [r] = vencimientoPrimerCobroAlta(rows, '2026-10-26', 5);
    expect(r.due_date).toBe('2026-10-31');
    expect(r.concept).toContain('vence el 31 de octubre');
    expect(r.concept).not.toContain('vence día 26');
    // El periodo NO se mueve: sigue siendo octubre.
    expect([r.period_year, r.period_month]).toEqual([2026, 10]);
  });

  it('cruza de mes si la gracia lo pide', () => {
    const rows = buildAltaPayments({ ...base, startDate: '2026-10-29', today: '2026-10-29' });
    const [r] = vencimientoPrimerCobroAlta(rows, '2026-10-29', 5);
    expect(r.due_date).toBe('2026-11-03');
    expect(r.concept).toContain('vence el 3 de noviembre');
  });

  it('si vence después de hoy (alta antes del corte) no lo toca', () => {
    const rows = buildAltaPayments({ ...base, startDate: '2026-10-02', today: '2026-10-02' });
    expect(vencimientoPrimerCobroAlta(rows, '2026-10-02', 5)).toEqual(rows);
  });

  it('gracia 0 es la regla de la escuela: queda como estaba', () => {
    const rows = buildAltaPayments(base);
    expect(vencimientoPrimerCobroAlta(rows, '2026-10-26', 0)).toEqual(rows);
  });

  it('no toca cobros únicos (inscripción, seguro)', () => {
    const rows = [{ payment_category: 'inscripcion', due_date: '2026-10-26', concept: 'Inscripción' }];
    expect(vencimientoPrimerCobroAlta(rows, '2026-10-26', 5)).toEqual(rows);
  });
});

describe('esTablaInexistente (B12)', () => {
  it('reconoce la tabla que falta en la base viva', () => {
    expect(esTablaInexistente({ code: '42P01', message: 'relation "public.account_deletion_requests" does not exist' })).toBe(true);
    expect(esTablaInexistente({ code: 'PGRST205', message: "Could not find the table 'public.account_deletion_requests' in the schema cache" })).toBe(true);
  });
  it('cualquier otro error sigue siendo error', () => {
    expect(esTablaInexistente({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(esTablaInexistente(null)).toBe(false);
  });
});
