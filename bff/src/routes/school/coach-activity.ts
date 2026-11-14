/**
 * GET /api/v1/school/coach-activity?week=YYYY-MM-DD
 *
 * "Seguimiento deportivo" del dueño (spec docs/specs/rediseno-seguimiento-
 * deportivo.md, F4): una sola llamada que devuelve, por entrenador activo de
 * la escuela, qué planificó, en qué días tomó lista y a cuántos evaluó en la
 * semana, con semáforo y la serie de las últimas 8 semanas para la gráfica.
 * Solo lectura.
 *
 * Lee con el cliente de servicio (salta RLS): el gate es requireRole + el
 * filtro explícito por req.schoolId en CADA consulta. Todas las lecturas van
 * paginadas (PostgREST corta en 1000 filas en silencio) y los `.in()` en
 * tandas de 30 ids (límite de headers, ver routes/reports.ts).
 *
 * El cruce de datos vive en coach-activity.aggregate.ts (puro, con test).
 */
import { Router, Response } from 'express';
import { supabase } from '../../config/supabase';
import { requireAuth, requireRole, AuthenticatedRequest } from '../../middlewares/authMiddleware';
import {
  addDaysYmd, bogotaYmd, buildCoachActivity, isValidYmd, mondayOf,
  type AttendanceRecordRow, type AttendanceSessionRow, type MesoEvalRow, type MesocycleRow,
  type PerformanceEntryRow, type StaffRow, type TeamRow, type TrainingSessionRow,
} from './coach-activity.aggregate';
import { buildCoachPeriodSummary } from './coach-evaluation-summary';

const router = Router();

const ADMIN_ROLES = ['owner', 'super_admin', 'admin', 'school_admin'] as const;
const WEEKS_BACK = 8;
const PG_PAGE = 1000;
const IN_CHUNK = 30;

async function fetchAllRows<T>(build: () => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PG_PAGE) {
    const { data, error } = await build().range(from, from + PG_PAGE - 1);
    if (error) throw error;
    const page = (data || []) as T[];
    out.push(...page);
    if (page.length < PG_PAGE) return out;
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Inicio del día YYYY-MM-DD en Colombia, como instante UTC. */
const bogotaStartIso = (ymd: string) => `${ymd}T05:00:00.000Z`;

/** ¿El error es "esa columna no existe"? (migración 20261008154652 sin aplicar) */
const isMissingColumn = (err: any) =>
  err?.code === '42703' || err?.code === 'PGRST204' || /column .* does not exist/i.test(err?.message ?? '');

router.get(
  '/coach-activity',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const schoolId = req.schoolId;
      if (!schoolId) return res.status(403).json({ error: 'Sin escuela asociada.' });

      const today = bogotaYmd(new Date().toISOString());
      const rawWeek = req.query.week;
      if (rawWeek !== undefined && !isValidYmd(rawWeek)) {
        return res.status(400).json({ error: 'week debe ser una fecha YYYY-MM-DD.' });
      }
      const week = mondayOf(typeof rawWeek === 'string' ? rawWeek : today);
      const weekEnd = addDaysYmd(week, 6);
      const chartStart = addDaysYmd(week, -7 * (WEEKS_BACK - 1));

      // 1) Entrenadores activos y equipos.
      const staffRaw = await fetchAllRows<any>(() => supabase
        .from('school_staff')
        .select('id, full_name, coach_auth_id')
        .eq('school_id', schoolId)
        .eq('status', 'active')
        .order('id'));
      const staff: StaffRow[] = staffRaw.map((s) => ({
        id: s.id, full_name: s.full_name || 'Sin nombre', coach_auth_id: s.coach_auth_id ?? null,
      }));
      const authIds = [...new Set(staff.map((s) => s.coach_auth_id).filter((x): x is string => !!x))];

      const teamsRaw = await fetchAllRows<any>(() => supabase
        .from('teams')
        .select('id, name, coach_id, active, team_coaches(coach_id)')
        .eq('school_id', schoolId)
        .order('id'));
      const teams: TeamRow[] = teamsRaw
        .filter((t) => t.active !== false)
        .map((t) => ({
          id: t.id,
          name: t.name || 'Equipo',
          coach_id: t.coach_id ?? null,
          extra_coach_ids: (t.team_coaches || []).map((tc: any) => tc.coach_id).filter(Boolean),
        }));

      // 2) Mesociclos que tocan la semana; amplían la ventana de lectura para
      //    poder medir su adherencia desde el inicio.
      const mesocycles = await fetchAllRows<MesocycleRow>(() => supabase
        .from('training_mesocycles')
        .select('id, team_id, starts_on, ends_on, n_sessions_planned, general_objective')
        .eq('school_id', schoolId)
        .lte('starts_on', weekEnd)
        .gte('ends_on', week)
        .order('id'));
      const fetchStart = mesocycles.reduce((min, m) => (m.starts_on < min ? m.starts_on : min), chartStart);
      // Hasta hoy aunque la semana pedida sea vieja: "última actividad" es la real.
      const fetchEnd = today > weekEnd ? today : weekEnd;

      // 3) Sesiones planificadas (training_sessions). created_by/updated_by
      //    llegan con la migración 20261008154652; sin ella se sigue sin
      //    atribución personal (solo por equipo).
      const sessionCols = 'id, team_id, session_date, created_at, updated_at, objectives, session_blocks, microcycle_day_id';
      const loadSessions = (withActor: boolean) => fetchAllRows<any>(() => supabase
        .from('training_sessions')
        .select(withActor ? `${sessionCols}, created_by, updated_by` : sessionCols)
        .eq('school_id', schoolId)
        .gte('session_date', fetchStart)
        .lte('session_date', fetchEnd)
        .order('id'));
      let sessionsRaw: any[];
      try {
        sessionsRaw = await loadSessions(true);
      } catch (err) {
        if (!isMissingColumn(err)) throw err;
        sessionsRaw = await loadSessions(false);
      }
      const trainingSessions: TrainingSessionRow[] = sessionsRaw.map((s) => ({
        id: s.id,
        team_id: s.team_id,
        session_date: s.session_date,
        created_by: s.created_by ?? null,
        updated_by: s.updated_by ?? null,
        created_at: s.created_at ?? null,
        updated_at: s.updated_at ?? null,
        objectives: s.objectives,
        blocks_count: Array.isArray(s.session_blocks) ? s.session_blocks.length : 0,
        microcycle_day_id: s.microcycle_day_id ?? null,
      }));

      // 4) Listas de asistencia y sus registros.
      const attendanceSessions = await fetchAllRows<AttendanceSessionRow>(() => supabase
        .from('attendance_sessions')
        .select('id, team_id, session_date, coach_id, created_by, finalized_by, finalized, finalized_at, created_at')
        .eq('school_id', schoolId)
        .gte('session_date', fetchStart)
        .lte('session_date', fetchEnd)
        .order('id'));
      const attendanceRecords = await fetchAllRows<AttendanceRecordRow>(() => supabase
        .from('attendance_records')
        .select('session_id, marked_by, status, created_at')
        .eq('school_id', schoolId)
        .gte('attendance_date', fetchStart)
        .lte('attendance_date', fetchEnd)
        .not('session_id', 'is', null)
        .order('id'));

      // 5) Evaluaciones: performance_entries.recorded_by y rúbrica del mesociclo.
      const fromIso = bogotaStartIso(fetchStart);
      const toIso = bogotaStartIso(addDaysYmd(fetchEnd, 1));
      const performanceEntries: PerformanceEntryRow[] = [];
      const mesoEvaluations: MesoEvalRow[] = [];
      for (const ids of chunk(authIds, IN_CHUNK)) {
        performanceEntries.push(...await fetchAllRows<PerformanceEntryRow>(() => supabase
          .from('performance_entries')
          .select('recorded_by, subject_id, recorded_at')
          .eq('school_id', schoolId)
          .in('recorded_by', ids)
          .gte('recorded_at', fromIso)
          .lt('recorded_at', toIso)
          .order('id')));
        mesoEvaluations.push(...await fetchAllRows<MesoEvalRow>(() => supabase
          .from('training_mesocycle_evaluations')
          .select('created_by, created_at, mesocycle_id')
          .not('score', 'is', null)  // «No aplica» no cuenta como evaluación hecha
          .eq('school_id', schoolId)
          .in('created_by', ids)
          .gte('created_at', fromIso)
          .lt('created_at', toIso)
          .order('id')));
      }

      // 6) Nombres de quien creó cada sesión (puede ser el dueño, no un coach).
      const profileNames: Record<string, string> = {};
      for (const s of staff) if (s.coach_auth_id) profileNames[s.coach_auth_id] = s.full_name;
      const unknownCreators = [...new Set(trainingSessions.map((s) => s.created_by).filter((x): x is string => !!x && !profileNames[x]))];
      for (const ids of chunk(unknownCreators, IN_CHUNK)) {
        const { data, error } = await supabase.from('profiles').select('id, full_name').in('id', ids);
        if (error) throw error;
        for (const p of data || []) profileNames[p.id] = p.full_name || 'Sin nombre';
      }

      const result = buildCoachActivity({
        week, today, weeksBack: WEEKS_BACK,
        staff, teams, trainingSessions, attendanceSessions, attendanceRecords,
        performanceEntries, mesoEvaluations, mesocycles, profileNames,
      });
      res.json(result);
    } catch (err: any) {
      req.log?.error({ err }, 'school/coach-activity unhandled error');
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  },
);

/**
 * GET /api/v1/school/coach-evaluation-summary?staff_id=&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Lo que hizo UN entrenador en el período a calificar (spec
 * evaluacion-de-entrenadores §7). Solo lo pide la pantalla de calificar (nada
 * de jobs): lecturas acotadas a sus equipos, su usuario y el rango (máx. 1 año).
 */
router.get(
  '/coach-evaluation-summary',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const schoolId = req.schoolId;
      if (!schoolId) return res.status(403).json({ error: 'Sin escuela asociada.' });
      const { staff_id: staffId, from, to } = req.query;
      if (typeof staffId !== 'string' || !/^[0-9a-f-]{36}$/i.test(staffId)) {
        return res.status(400).json({ error: 'staff_id inválido.' });
      }
      if (!isValidYmd(from) || !isValidYmd(to) || to < from || to > addDaysYmd(from, 366)) {
        return res.status(400).json({ error: 'from/to deben ser fechas YYYY-MM-DD, en orden y a lo sumo un año.' });
      }
      const today = bogotaYmd(new Date().toISOString());

      const { data: st, error: stErr } = await supabase
        .from('school_staff')
        .select('id, full_name, coach_auth_id')
        .eq('id', staffId)
        .eq('school_id', schoolId)
        .maybeSingle();
      if (stErr) throw stErr;
      if (!st) return res.status(404).json({ error: 'Ese entrenador no es de tu escuela.' });
      const staff: StaffRow = { id: st.id, full_name: st.full_name || 'Sin nombre', coach_auth_id: st.coach_auth_id ?? null };
      const auth = staff.coach_auth_id;

      const teamsRaw = await fetchAllRows<any>(() => supabase
        .from('teams')
        .select('id, name, coach_id, active, team_coaches(coach_id)')
        .eq('school_id', schoolId)
        .order('id'));
      const teams: TeamRow[] = teamsRaw
        .filter((t) => t.active !== false)
        .map((t) => ({
          id: t.id,
          name: t.name || 'Equipo',
          coach_id: t.coach_id ?? null,
          extra_coach_ids: (t.team_coaches || []).map((tc: any) => tc.coach_id).filter(Boolean),
        }));
      const teamIds = teams
        .filter((t) => t.coach_id === staff.id || t.extra_coach_ids.includes(staff.id))
        .map((t) => t.id);

      // Sesiones de sus equipos + las que creó él en otros (si existe created_by).
      const sessionCols = 'id, team_id, session_date, created_at, updated_at, objectives, session_blocks, microcycle_day_id';
      const sessionsRaw: any[] = [];
      for (const ids of chunk(teamIds, IN_CHUNK)) {
        sessionsRaw.push(...await fetchAllRows<any>(() => supabase
          .from('training_sessions')
          .select(`${sessionCols}, created_by, updated_by`)
          .eq('school_id', schoolId)
          .in('team_id', ids)
          .gte('session_date', from)
          .lte('session_date', to)
          .order('id')));
      }
      if (auth) {
        const seen = new Set(sessionsRaw.map((s) => s.id));
        const own = await fetchAllRows<any>(() => supabase
          .from('training_sessions')
          .select(`${sessionCols}, created_by, updated_by`)
          .eq('school_id', schoolId)
          .eq('created_by', auth)
          .gte('session_date', from)
          .lte('session_date', to)
          .order('id'));
        for (const s of own) if (!seen.has(s.id)) sessionsRaw.push(s);
      }
      const trainingSessions: TrainingSessionRow[] = sessionsRaw.map((s) => ({
        id: s.id,
        team_id: s.team_id,
        session_date: s.session_date,
        created_by: s.created_by ?? null,
        updated_by: s.updated_by ?? null,
        created_at: s.created_at ?? null,
        updated_at: s.updated_at ?? null,
        objectives: s.objectives,
        blocks_count: Array.isArray(s.session_blocks) ? s.session_blocks.length : 0,
        microcycle_day_id: s.microcycle_day_id ?? null,
      }));

      // Listas del rango en la escuela (la atribución se decide en el agregado).
      const attendanceSessions = await fetchAllRows<AttendanceSessionRow>(() => supabase
        .from('attendance_sessions')
        .select('id, team_id, session_date, coach_id, created_by, finalized_by, finalized, finalized_at, created_at')
        .eq('school_id', schoolId)
        .gte('session_date', from)
        .lte('session_date', to)
        .order('id'));
      const attendanceRecords: AttendanceRecordRow[] = [];
      for (const ids of chunk(attendanceSessions.map((s) => s.id), IN_CHUNK)) {
        attendanceRecords.push(...await fetchAllRows<AttendanceRecordRow>(() => supabase
          .from('attendance_records')
          .select('session_id, marked_by, status, created_at')
          .in('session_id', ids)
          .order('id')));
      }

      const performanceEntries: PerformanceEntryRow[] = [];
      const mesoEvaluations: MesoEvalRow[] = [];
      if (auth) {
        const fromIso = bogotaStartIso(from);
        const toIso = bogotaStartIso(addDaysYmd(to, 1));
        performanceEntries.push(...await fetchAllRows<PerformanceEntryRow>(() => supabase
          .from('performance_entries')
          .select('recorded_by, subject_id, recorded_at')
          .eq('school_id', schoolId)
          .eq('recorded_by', auth)
          .gte('recorded_at', fromIso)
          .lt('recorded_at', toIso)
          .order('id')));
        mesoEvaluations.push(...await fetchAllRows<MesoEvalRow>(() => supabase
          .from('training_mesocycle_evaluations')
          .select('created_by, created_at, mesocycle_id')
          .not('score', 'is', null)  // «No aplica» no cuenta como evaluación hecha
          .eq('school_id', schoolId)
          .eq('created_by', auth)
          .gte('created_at', fromIso)
          .lt('created_at', toIso)
          .order('id')));
      }

      res.json(buildCoachPeriodSummary({
        from, to, today, staff, teams, trainingSessions,
        attendanceSessions, attendanceRecords, performanceEntries, mesoEvaluations,
      }));
    } catch (err: any) {
      req.log?.error({ err }, 'school/coach-evaluation-summary unhandled error');
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  },
);

export default router;
