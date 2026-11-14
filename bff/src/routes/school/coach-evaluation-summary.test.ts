/**
 * Resumen por período para la evaluación de entrenadores: mismo criterio de
 * lista tomada y atribución que Seguimiento deportivo, corte en "hoy",
 * semanas con plan y adherencia del mesociclo. Cero base.
 */
import { describe, expect, it } from 'vitest';
import { buildCoachPeriodSummary, type CoachPeriodInput } from './coach-evaluation-summary';

function base(overrides: Partial<CoachPeriodInput> = {}): CoachPeriodInput {
  return {
    from: '2026-10-01',
    to: '2026-10-31',
    today: '2026-10-15',
    staff: { id: 'st-ana', full_name: 'Ana', coach_auth_id: 'u-ana' },
    teams: [
      { id: 't-sub11', name: 'Sub 11', coach_id: 'st-ana', extra_coach_ids: [] },
      { id: 't-sub13', name: 'Sub 13', coach_id: 'st-beto', extra_coach_ids: [] },
    ],
    trainingSessions: [],
    attendanceSessions: [],
    attendanceRecords: [],
    performanceEntries: [],
    mesoEvaluations: [],
    ...overrides,
  };
}

const ts = (id: string, team_id: string, session_date: string, meso = false, created_by: string | null = null) => ({
  id, team_id, session_date, created_by, updated_by: created_by,
  created_at: `${session_date}T12:00:00Z`, updated_at: `${session_date}T12:00:00Z`,
  objectives: '', blocks_count: 0, microcycle_day_id: meso ? 'md' : null,
});
const as = (id: string, team_id: string, session_date: string, extra: Record<string, unknown> = {}) => ({
  id, team_id, session_date, coach_id: null, created_by: null, finalized_by: null,
  finalized: false, finalized_at: null, created_at: `${session_date}T12:00:00Z`, ...extra,
});

describe('buildCoachPeriodSummary', () => {
  it('cuenta solo sus equipos y lo que creó él; corta en hoy para lo vencido', () => {
    const r = buildCoachPeriodSummary(base({
      trainingSessions: [
        ts('s1', 't-sub11', '2026-10-06', true),
        ts('s2', 't-sub11', '2026-10-08', true),
        ts('s3', 't-sub11', '2026-10-27', true), // futuro: planificada pero no vencida
        ts('s4', 't-sub13', '2026-10-07'),       // equipo ajeno
        ts('s5', 't-sub13', '2026-10-09', false, 'u-ana'), // ajeno pero la creó ella
        ts('s6', 't-sub11', '2026-09-29'),       // fuera del período
      ],
      attendanceSessions: [as('a1', 't-sub11', '2026-10-06', { finalized: true, coach_id: 'st-ana' })],
    }));
    expect(r.sesiones_planificadas.planned).toBe(4);
    expect(r.listas_tomadas).toMatchObject({ lists: 1, days: 1, due_sessions: 2, due_with_list: 1, pct: 50 });
    expect(r.adherencia_mesociclo).toEqual({ due: 2, done: 1, pct: 50 });
    expect(r.cutoff).toBe('2026-10-15');
  });

  it('semanas medibles hasta el corte y cuántas tienen plan', () => {
    const r = buildCoachPeriodSummary(base({
      trainingSessions: [ts('s1', 't-sub11', '2026-10-06'), ts('s2', 't-sub11', '2026-10-14')],
    }));
    // Semanas que empiezan 29-sep, 6-oct y 13-oct (el corte es el 15).
    expect(r.sesiones_planificadas).toMatchObject({ weeks_total: 3, weeks_with_plan: 2 });
  });

  it('lista vacía y sin finalizar no cuenta; con registros marcados por ella sí', () => {
    const r = buildCoachPeriodSummary(base({
      attendanceSessions: [as('a1', 't-sub11', '2026-10-06'), as('a2', 't-sub11', '2026-10-08')],
      attendanceRecords: [{ session_id: 'a2', marked_by: 'u-ana', status: 'present', created_at: '2026-10-08T13:00:00Z' }],
    }));
    expect(r.listas_tomadas.lists).toBe(1);
    expect(r.last_activity_at).toBe('2026-10-08T12:00:00Z');
  });

  it('evaluaciones en hora de Colombia y sin cuenta no hay atribución por usuario', () => {
    const input = base({
      performanceEntries: [
        { recorded_by: 'u-ana', subject_id: 'x', recorded_at: '2026-11-01T03:00:00Z' }, // 31-oct 10 p. m. en Colombia
        { recorded_by: 'u-ana', subject_id: 'x', recorded_at: '2026-10-10T15:00:00Z' },
        { recorded_by: 'u-otro', subject_id: 'y', recorded_at: '2026-10-10T15:00:00Z' },
      ],
      mesoEvaluations: [{ created_by: 'u-ana', created_at: '2026-10-12T15:00:00Z', mesocycle_id: 'm' }],
    });
    expect(buildCoachPeriodSummary(input).evaluaciones).toEqual({ entries: 2, athletes: 1, mesocycle_evaluations: 1 });
    const sinCuenta = buildCoachPeriodSummary({ ...input, staff: { id: 'st-ana', full_name: 'Ana', coach_auth_id: null } });
    expect(sinCuenta.has_account).toBe(false);
    expect(sinCuenta.evaluaciones.entries).toBe(0);
  });

  it('período futuro: nada vencido, porcentajes en null', () => {
    const r = buildCoachPeriodSummary(base({ from: '2026-11-01', to: '2026-11-30', trainingSessions: [ts('s1', 't-sub11', '2026-11-03')] }));
    expect(r.sesiones_planificadas.weeks_total).toBe(0);
    expect(r.listas_tomadas.pct).toBeNull();
  });
});
