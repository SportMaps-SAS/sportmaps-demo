/**
 * Resumen de UN entrenador en un período cualquiera (semana a año) para la
 * evaluación de entrenadores (spec docs/specs/evaluacion-de-entrenadores.md).
 * Mismas reglas que Seguimiento deportivo (coach-activity.aggregate.ts): qué
 * cuenta como lista tomada, a quién se le atribuye y las fechas en hora de
 * Colombia. Puro: el router trae las filas, esta función las cruza.
 *
 * Cada bloque corresponde a un `auto_metric` de coach_evaluation_criteria.
 */
import {
  addDaysYmd, bogotaYmd, mondayOf,
  type AttendanceRecordRow, type AttendanceSessionRow, type MesoEvalRow,
  type PerformanceEntryRow, type StaffRow, type TeamRow, type TrainingSessionRow,
} from './coach-activity.aggregate';

export interface CoachPeriodInput {
  from: string;
  to: string;
  /** Hoy en Colombia: lo que todavía no vence no cuenta como incumplido. */
  today: string;
  staff: StaffRow;
  teams: TeamRow[];
  trainingSessions: TrainingSessionRow[];
  attendanceSessions: AttendanceSessionRow[];
  attendanceRecords: AttendanceRecordRow[];
  performanceEntries: PerformanceEntryRow[];
  mesoEvaluations: MesoEvalRow[];
}

export interface CoachPeriodSummary {
  staff_id: string;
  full_name: string;
  has_account: boolean;
  from: string;
  to: string;
  /** Último día que ya se puede medir: min(to, hoy). */
  cutoff: string;
  teams: string[];
  sesiones_planificadas: { planned: number; weeks_total: number; weeks_with_plan: number };
  listas_tomadas: { lists: number; days: number; due_sessions: number; due_with_list: number; pct: number | null };
  evaluaciones: { entries: number; athletes: number; mesocycle_evaluations: number };
  adherencia_mesociclo: { due: number; done: number; pct: number | null };
  last_activity_at: string | null;
}

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : null);

export function buildCoachPeriodSummary(input: CoachPeriodInput): CoachPeriodSummary {
  const { from, to, today, staff: st } = input;
  const auth = st.coach_auth_id;
  const cutoff = today < to ? today : to;
  const inRange = (ymd: string) => ymd >= from && ymd <= to;
  let lastActivity: string | null = null;
  const touch = (iso: string | null | undefined) => {
    if (iso && (!lastActivity || Date.parse(iso) > Date.parse(lastActivity))) lastActivity = iso;
  };

  const myTeams = input.teams.filter((t) => t.coach_id === st.id || t.extra_coach_ids.includes(st.id));
  const teamIds = new Set(myTeams.map((t) => t.id));

  // Sesiones planificadas: las de sus equipos + las que creó él en otro equipo.
  const planned = input.trainingSessions.filter((s) => inRange(s.session_date)
    && (teamIds.has(s.team_id) || (!!auth && s.created_by === auth)));
  if (auth) for (const s of input.trainingSessions) {
    if (s.created_by === auth) touch(s.created_at);
    if (s.updated_by === auth) touch(s.updated_at);
  }

  // Semanas medibles (las que empezaron hasta el corte) y cuántas tienen plan.
  const weeks: string[] = [];
  if (cutoff >= from) for (let w = mondayOf(from); w <= cutoff; w = addDaysYmd(w, 7)) weeks.push(w);
  const plannedWeeks = new Set(planned.map((s) => mondayOf(s.session_date)));

  // Listas tomadas = con registros o finalizadas (igual que Seguimiento).
  const recordsBySession = new Map<string, AttendanceRecordRow[]>();
  for (const r of input.attendanceRecords) {
    if (!r.session_id) continue;
    const list = recordsBySession.get(r.session_id) ?? [];
    list.push(r);
    recordsBySession.set(r.session_id, list);
  }
  const taken = input.attendanceSessions.filter(
    (s) => inRange(s.session_date) && (s.finalized === true || (recordsBySession.get(s.id)?.length ?? 0) > 0),
  );
  const listDatesByTeam = new Map<string, Set<string>>();
  for (const s of taken) {
    if (!s.team_id) continue;
    const set = listDatesByTeam.get(s.team_id) ?? new Set<string>();
    set.add(s.session_date);
    listDatesByTeam.set(s.team_id, set);
  }
  let lists = 0;
  const listDays = new Set<string>();
  for (const s of taken) {
    const recs = recordsBySession.get(s.id) ?? [];
    const mine = s.coach_id === st.id
      || (!!auth && (s.created_by === auth || s.finalized_by === auth || recs.some((r) => r.marked_by === auth)));
    if (!mine) continue;
    lists += 1;
    listDays.add(s.session_date);
    touch(s.finalized_at ?? s.created_at);
  }

  // Sesiones planificadas de sus equipos que ya vencieron: ¿tienen lista ese día?
  const dueOf = (rows: TrainingSessionRow[]) => {
    const keys = new Set(rows
      .filter((s) => teamIds.has(s.team_id) && s.session_date <= cutoff)
      .map((s) => `${s.team_id}|${s.session_date}`));
    let done = 0;
    for (const k of keys) {
      const [team, day] = k.split('|');
      if (listDatesByTeam.get(team)?.has(day)) done += 1;
    }
    return { due: keys.size, done };
  };
  const dueAll = dueOf(planned);
  const dueMeso = dueOf(planned.filter((s) => !!s.microcycle_day_id));

  // Evaluaciones a deportistas y de la rúbrica del mesociclo.
  let entries = 0;
  const athletes = new Set<string>();
  let mesoEvals = 0;
  if (auth) {
    for (const e of input.performanceEntries) {
      if (e.recorded_by !== auth) continue;
      touch(e.recorded_at);
      if (!inRange(bogotaYmd(e.recorded_at))) continue;
      entries += 1;
      athletes.add(e.subject_id);
    }
    for (const e of input.mesoEvaluations) {
      if (e.created_by !== auth) continue;
      touch(e.created_at);
      if (inRange(bogotaYmd(e.created_at))) mesoEvals += 1;
    }
  }

  return {
    staff_id: st.id,
    full_name: st.full_name,
    has_account: !!auth,
    from,
    to,
    cutoff,
    teams: myTeams.map((t) => t.name).sort((a, b) => a.localeCompare(b, 'es')),
    sesiones_planificadas: {
      planned: planned.length,
      weeks_total: weeks.length,
      weeks_with_plan: weeks.filter((w) => plannedWeeks.has(w)).length,
    },
    listas_tomadas: {
      lists,
      days: listDays.size,
      due_sessions: dueAll.due,
      due_with_list: dueAll.done,
      pct: pct(dueAll.done, dueAll.due),
    },
    evaluaciones: { entries, athletes: athletes.size, mesocycle_evaluations: mesoEvals },
    adherencia_mesociclo: { due: dueMeso.due, done: dueMeso.done, pct: pct(dueMeso.done, dueMeso.due) },
    last_activity_at: lastActivity,
  };
}
