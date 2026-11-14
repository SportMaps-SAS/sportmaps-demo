/**
 * Datos de Asistencia V2. Mismos endpoints y tablas que CoachAttendancePage:
 *  - equipos del coach (teams + team_coaches por ficha de staff)
 *  - planes (offerings + offering_coaches), clases de plan de hoy (attendance_sessions)
 *  - roster por BFF: GET /api/v1/attendance/roster/{team|offering}/:id
 *  - lista del día: GET /api/v1/attendance/session/:teamId?date= (equipo) o
 *    attendance_sessions + attendance_records (clase de plan)
 *  - historial: attendance_sessions + attendance_records + school_athletes (nombres)
 * No escribe nada: el guardado va por la cola (colaAsistencia.ts).
 */
import { agendaPersonalDelDia, agendaPersonalSinAcceso } from './agendaPersonal';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import type { DeportistaLista, RegistroGuardado, SesionHistorial } from './asistenciaModel';
import { sumarDias } from './asistenciaModel';

/* eslint-disable @typescript-eslint/no-explicit-any -- tablas sin tipar en types.ts (team_coaches, offering_coaches) igual que en CoachAttendancePage */

export interface EquipoV2 { id: string; name: string; sport: string | null; current_students: number | null }
export interface PlanV2 { id: string; name: string }
export interface ClaseHoyV2 { id: string; name: string; start_time: string | null; end_time: string | null }

export type ContextoLista =
  | { tipo: 'team'; id: string; nombre: string }
  | { tipo: 'offering'; id: string; nombre: string }
  | { tipo: 'session'; id: string; nombre: string };

export const claveContexto = (c: ContextoLista) => `${c.tipo}:${c.id}`;

export interface RosterV2 extends DeportistaLista {
  avatar_url?: string | null;
  plan?: { is_expired?: boolean | null } | null;
  booking_today?: { start_time: string | null; status: string } | null;
  is_booking?: boolean;
}

export interface RosterRespuesta { athletes: RosterV2[]; atletas_sin_equipo?: number; atletas_pausados?: number }

export interface OpcionClase { id: string; start_time?: string | null; finalized?: boolean | null }

export interface SesionDelDia {
  session: { id: string; session_date: string; finalized: boolean | null; team_id?: string | null; offering_id?: string | null } | null;
  records: RegistroGuardado[];
  /** Varias clases/bloques ese día: hay que elegir uno. */
  varias?: boolean;
  opciones?: OpcionClase[];
  /** Plan sin clase programada ese día. */
  sinClase?: boolean;
}

/**
 * En la cancha no siempre hay señal: lo último que se cargó con señal (equipos,
 * roster, lista del día) se guarda en el teléfono y se usa si la red falla.
 * localStorage con try/catch, como la cola: si no se puede, se comporta como antes.
 */
export async function conCache<T>(clave: string, fn: () => Promise<T>): Promise<T> {
  const k = `sm_coach_v2_cache:${clave}`;
  try {
    const v = await fn();
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* lleno o bloqueado */ }
    return v;
  } catch (err) {
    try {
      const raw = localStorage.getItem(k);
      if (raw) return JSON.parse(raw) as T;
    } catch { /* ilegible */ }
    throw err;
  }
}

const ADMIN_ROLES =['admin', 'super_admin', 'school_admin', 'school', 'owner'];
export const esAdministracion = (rol: string | null | undefined) => ADMIN_ROLES.includes(rol ?? '');

export function useEquiposCoach(schoolId: string | null, userId: string | undefined, staffId: string | null, isAdmin: boolean) {
  return useQuery<EquipoV2[]>({
    queryKey: ['v2-asis-equipos', schoolId, userId, staffId, isAdmin],
    enabled: !!schoolId && !!userId,
    queryFn: () => conCache(`equipos:${schoolId}:${userId}`, async () => {
      const { data, error } = await (supabase as any)
        .from('teams')
        .select('id, name, sport, current_students, coach_id, team_coaches(coach_id)')
        .eq('school_id', schoolId);
      if (error) throw error;
      return ((data ?? []) as any[])
        .filter((t) => isAdmin
          || t.coach_id === userId || (staffId && t.coach_id === staffId)
          || (t.team_coaches ?? []).some((tc: any) => tc.coach_id === userId || (staffId && tc.coach_id === staffId)))
        .map((t) => ({ id: t.id, name: t.name, sport: t.sport ?? null, current_students: t.current_students ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }),
  });
}

export function useSoloEquipos(schoolId: string | null) {
  return useQuery<boolean>({
    queryKey: ['coach-attendance-teams-only', schoolId],
    enabled: !!schoolId,
    queryFn: () => conCache(`solo-equipos:${schoolId}`, async () => {
      const { data } = await supabase.from('school_settings').select('coach_attendance_teams_only').eq('school_id', schoolId!).maybeSingle();
      return (data as any)?.coach_attendance_teams_only ?? false;
    }),
  });
}

export function usePlanesCoach(schoolId: string | null, staffId: string | null, isAdmin: boolean) {
  return useQuery<PlanV2[]>({
    queryKey: ['v2-asis-planes', schoolId, staffId, isAdmin],
    enabled: !!schoolId,
    queryFn: () => conCache(`planes:${schoolId}:${staffId}`, async () => {
      const { data, error } = await supabase
        .from('offerings').select('id, name').eq('school_id', schoolId!).eq('is_active', true).order('name');
      if (error) throw error;
      const todas = (data ?? []) as PlanV2[];
      if (isAdmin) return todas;
      if (!staffId) return [];
      const { data: asignadas } = await (supabase as any).from('offering_coaches').select('offering_id').eq('coach_id', staffId);
      const propias = new Set(((asignadas ?? []) as { offering_id: string }[]).map((x) => x.offering_id));
      return todas.filter((o) => propias.has(o.id));
    }),
  });
}

export function useClasesHoy(schoolId: string | null, hoy: string, staffId: string | null, userId: string | undefined, isAdmin: boolean) {
  return useQuery<ClaseHoyV2[]>({
    queryKey: ['v2-asis-clases-hoy', schoolId, hoy, staffId, isAdmin],
    enabled: !!schoolId && (!!userId || !!staffId),
    queryFn: () => conCache(`clases:${schoolId}:${hoy}:${staffId}`, async () => {
      let q = supabase
        .from('attendance_sessions')
        .select('id, start_time, end_time, title, offerings!attendance_sessions_offering_id_fkey(name)')
        .eq('school_id', schoolId!)
        .eq('session_date', hoy)
        .not('offering_id', 'is', null);
      if (!isAdmin) q = q.eq('coach_id', staffId || userId!);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as any[])
        .map((s) => ({ id: s.id, name: s.title || s.offerings?.name || 'Clase de plan', start_time: s.start_time, end_time: s.end_time }))
        .sort((a, b) => (a.start_time ?? '').localeCompare(b.start_time ?? ''));
    }),
  });
}

/** Clase de plan elegida directamente: de qué equipo/plan es (para pedir su roster). */
export function useOrigenClase(sessionId: string | null) {
  return useQuery<{ team_id: string | null; offering_id: string | null; session_date: string } | null>({
    queryKey: ['v2-asis-origen-clase', sessionId],
    enabled: !!sessionId,
    queryFn: () => conCache(`origen:${sessionId}`, async () => {
      const { data, error } = await supabase
        .from('attendance_sessions').select('team_id, offering_id, session_date').eq('id', sessionId!).maybeSingle();
      if (error) throw error;
      return data as any;
    }),
  });
}

export function useRoster(tipo: 'team' | 'offering' | null, id: string | null) {
  return useQuery<RosterRespuesta>({
    queryKey: ['v2-asis-roster', tipo, id],
    enabled: !!tipo && !!id,
    queryFn: () => conCache(`roster:${tipo}:${id}`, async () => {
      const r = await bffClient.get<RosterRespuesta & { bookings?: any[] }>(`/api/v1/attendance/roster/${tipo}/${id}`);
      // Reservas de gente que no está en el roster: se suman, como en la versión clásica.
      const base = [...(r.athletes ?? [])];
      const ids = new Set(base.map((a) => a.id));
      for (const b of r.bookings ?? []) {
        const pid = b.user_id || b.child_id || b.unregistered_athlete_id;
        if (pid && !ids.has(pid)) {
          base.push({
            id: pid, full_name: b.person?.full_name ?? 'Deportista', avatar_url: b.person?.avatar_url,
            athlete_type: b.child_id ? 'child' : b.unregistered_athlete_id ? 'unregistered' : 'adult',
            enrollment_id: b.enrollment_id, is_booking: true,
          });
          ids.add(pid);
        }
      }
      base.sort((a, b) => a.full_name.localeCompare(b.full_name));
      return { athletes: base, atletas_sin_equipo: r.atletas_sin_equipo, atletas_pausados: r.atletas_pausados };
    }),
  });
}

export function useSesionDelDia(ctx: ContextoLista | null, fecha: string) {
  return useQuery<SesionDelDia>({
    queryKey: ['v2-asis-sesion', ctx ? claveContexto(ctx) : null, fecha],
    enabled: !!ctx,
    queryFn: () => conCache(`sesion:${ctx ? claveContexto(ctx) : ''}:${fecha}`, async (): Promise<SesionDelDia> => {
      if (!ctx) return { session: null, records: [] };
      if (ctx.tipo === 'team') {
        const r = await bffClient.get<SesionDelDia & { reason?: string; sessions?: OpcionClase[] }>(`/api/v1/attendance/session/${ctx.id}?date=${fecha}`);
        // Varios bloques ese día: el BFF responde 200 con la lista para elegir.
        if (r.reason === 'multiple_sessions_today') return { session: null, records: [], varias: true, opciones: r.sessions ?? [] };
        return { session: r.session ?? null, records: r.records ?? [] };
      }
      let sesiones: any[] = [];
      if (ctx.tipo === 'session') {
        const { data, error } = await supabase
          .from('attendance_sessions').select('id, session_date, finalized, team_id, offering_id').eq('id', ctx.id).maybeSingle();
        if (error) throw error;
        sesiones = data ? [data] : [];
      } else {
        const { data, error } = await supabase
          .from('attendance_sessions').select('id, session_date, finalized, team_id, offering_id, start_time')
          .eq('offering_id', ctx.id).eq('session_date', fecha).order('start_time', { ascending: true });
        if (error) throw error;
        sesiones = data ?? [];
      }
      if (sesiones.length === 0) return { session: null, records: [], sinClase: ctx.tipo === 'offering' };
      if (sesiones.length > 1) return { session: null, records: [], varias: true, opciones: sesiones };
      const session = sesiones[0];
      const { data: records, error: rErr } = await (supabase as any)
        .from('attendance_records').select('child_id, user_id, unregistered_athlete_id, status').eq('session_id', session.id);
      if (rErr) throw rErr;
      return { session, records: records ?? [] };
    }),
  });
}

export interface HistorialV2 {
  sesiones: (SesionHistorial & { team_id: string | null; offering_id: string | null; nombre: string; start_time: string | null })[];
  nombres: Map<string, string>;
}

/**
 * Registros de la lista de cada (equipo, día) por el BFF — mismo endpoint que usa la
 * versión clásica para abrir una lista. De a 5 en paralelo; lo que falle queda sin datos.
 */
export async function registrosPorEquipoYDia(pares: { teamId: string; fecha: string }[]): Promise<Map<string, RegistroGuardado[]>> {
  const clave = (p: { teamId: string; fecha: string }) => `${p.teamId}|${p.fecha}`;
  const unicos = [...new Map(pares.map((p) => [clave(p), p])).values()];
  const out = new Map<string, RegistroGuardado[]>();
  for (let i = 0; i < unicos.length; i += 5) {
    await Promise.all(unicos.slice(i, i + 5).map(async (p) => {
      try {
        const r = await bffClient.get<{ records?: RegistroGuardado[] }>(`/api/v1/attendance/session/${p.teamId}?date=${p.fecha}`);
        out.set(clave(p), r.records ?? []);
      } catch { /* sin datos para ese día */ }
    }));
  }
  return out;
}

/** Últimos 90 días de listas del coach (sus equipos y sus clases de plan). */
export function useHistorial(schoolId: string | null, hoy: string, equipos: EquipoV2[], staffId: string | null, habilitado: boolean) {
  const teamIds = equipos.map((e) => e.id);
  return useQuery<HistorialV2>({
    queryKey: ['v2-asis-historial', schoolId, hoy, teamIds.join(','), staffId],
    enabled: habilitado && !!schoolId && (teamIds.length > 0 || !!staffId),
    queryFn: async () => {
      const desde = sumarDias(hoy, -90);
      const filtros: string[] = [];
      if (teamIds.length) filtros.push(`team_id.in.(${teamIds.join(',')})`);
      if (staffId) filtros.push(`coach_id.eq.${staffId}`);
      const { data: ses, error } = await (supabase as any)
        .from('attendance_sessions')
        .select('id, team_id, offering_id, session_date, start_time, finalized, title, offerings!attendance_sessions_offering_id_fkey(name)')
        .eq('school_id', schoolId)
        .gte('session_date', desde)
        .lte('session_date', hoy)
        .or(filtros.join(','))
        .order('session_date', { ascending: false })
        .limit(200);
      if (error) throw error;
      const lista = (ses ?? []) as any[];
      const ids = lista.map((s) => s.id);
      const porSesion = new Map<string, RegistroGuardado[]>();
      if (ids.length) {
        // La administración los lee directo; al coach la RLS viva de attendance_records
        // no se los muestra (por eso la versión clásica lee la lista del equipo por el BFF).
        const { data: recs } = await (supabase as any)
          .from('attendance_records')
          .select('session_id, child_id, user_id, unregistered_athlete_id, status')
          .in('session_id', ids)
          .limit(5000);
        for (const r of (recs ?? []) as any[]) {
          const l = porSesion.get(r.session_id) ?? [];
          l.push(r);
          porSesion.set(r.session_id, l);
        }
      }
      // Listas de equipo que no salieron directo: por el BFF (GET /attendance/session/:teamId?date=), las 15 más recientes.
      const faltan = lista.filter((x) => x.team_id && !porSesion.has(x.id)).slice(0, 15);
      const porEquipoDia = await registrosPorEquipoYDia(faltan.map((x) => ({ teamId: x.team_id, fecha: x.session_date })));
      for (const x of faltan) {
        const recs = porEquipoDia.get(`${x.team_id}|${x.session_date}`);
        if (recs?.length) porSesion.set(x.id, recs);
      }
      const equipoNombre = new Map(equipos.map((e) => [e.id, e.name]));
      const sesiones = lista
        .map((s) => ({
          id: s.id, session_date: s.session_date, finalized: s.finalized, team_id: s.team_id, offering_id: s.offering_id,
          start_time: s.start_time ?? null,
          nombre: (s.team_id && equipoNombre.get(s.team_id)) || s.title || s.offerings?.name || 'Entreno',
          records: porSesion.get(s.id) ?? [],
        }))
        // Una sesión sin ninguna marca no es una lista tomada (p. ej. clase de plan creada por la agenda).
        .filter((s) => s.records.length > 0);

      const atletaIds = [...new Set(sesiones.flatMap((s) => s.records.map((r) => r.child_id ?? r.user_id ?? r.unregistered_athlete_id).filter(Boolean)))] as string[];
      const nombres = new Map<string, string>();
      for (let i = 0; i < atletaIds.length; i += 200) {
        const { data: ath } = await (supabase as any)
          .from('school_athletes').select('id, full_name').eq('school_id', schoolId).in('id', atletaIds.slice(i, i + 200));
        for (const a of (ath ?? []) as any[]) nombres.set(a.id, a.full_name);
      }
      return { sesiones, nombres };
    },
  });
}

/** Planillas de papel por revisar (bandeja del BFF). Si no hay permiso o falla, no se muestra el aviso. */
export function usePlanillasPorRevisar(schoolId: string | null, habilitado: boolean) {
  return useQuery<{ total: number; primera: { teamName: string | null; sessionDate: string | null } | null } | null>({
    queryKey: ['v2-asis-planillas', schoolId],
    enabled: habilitado && !!schoolId,
    retry: false,
    queryFn: async () => {
      try {
        const r = await bffClient.get<{ items?: { teamName: string | null; sessionDate: string | null }[]; disponible?: boolean }>(
          '/api/v1/attendance-sheet-intake?status=por_revisar',
        );
        if (r.disponible === false) return null;
        const items = r.items ?? [];
        return { total: items.length, primera: items[0] ?? null };
      } catch { return null; }
    },
  });
}

/**
 * Cierra la lista (PATCH …/finalize). Al cerrar sale la encuesta a las familias
 * de los que vinieron (trigger post_training_notify_on_finalize), se descuentan
 * clases y se marcan las ausencias; y solo con la lista cerrada se puede evaluar.
 * Si ya estaba cerrada (409, p. ej. la cerró la escuela) cuenta como cerrada:
 * lo que sigue es evaluar igual.
 */
export async function cerrarListaSesion(sessionId: string): Promise<{ yaEstabaCerrada: boolean }> {
  try {
    await bffClient.patch(`/api/v1/attendance/session/${sessionId}/finalize`, {});
    return { yaEstabaCerrada: false };
  } catch (e) {
    if ((e as { status?: number } | null)?.status === 409) return { yaEstabaCerrada: true };
    throw e;
  }
}

export function usePtDeHoy(userId: string | undefined, hoy: string) {
  return useQuery<{ sessions: any[] } | null>({
    queryKey: ['coach-pt-sessions', userId, hoy],
    // Solo entrenadores personales tienen agenda: tras el primer 403 no se vuelve a pedir.
    enabled: !!userId && !agendaPersonalSinAcceso(),
    retry: false,
    queryFn: () => agendaPersonalDelDia<{ sessions: any[] }>(hoy),
  });
}
