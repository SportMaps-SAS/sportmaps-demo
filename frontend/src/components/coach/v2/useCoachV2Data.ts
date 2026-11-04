/**
 * Datos del entrenador V2. Solo lectura: las escrituras viven en cada pantalla
 * (con Deshacer). Las RPC del contrato B1–B3 pueden no estar aplicadas todavía:
 * si la función no existe se devuelve `disponible: false` y la sección se oculta.
 *
 * Plata: NINGUNA consulta de este archivo pide montos. `school_athletes` se lee
 * con columnas explícitas (sin price_monthly / plan_monthly_fee / payment_*), y
 * el estado de pago solo llega por `team_payment_status` (tres estados).
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import { fetchCoachTeams } from '@/lib/coachTeamScope';
import { getFootballLineup, getFootballLineups, type LineupDetail } from '@/lib/school/footballQueries';
import { agendaPersonalDelDia, agendaPersonalSinAcceso } from './agendaPersonal';
import { estadoConvocatoria, estadoPagoEquipo, listarFelicitaciones, type SujetoDeportista } from '@/lib/api/v2Contratos';
import {
  claveConvocado,
  comoDesdeEffort,
  isoDia,
  leerFranjas,
  mapaEstadosPago,
  sujetoDe,
  type ComoLeFue,
  type Deportista,
  type EquipoHorario,
  type EstadoPago,
  type InformeEquipo,
  type Partido,
  type SesionReciente,
  type TipoDeportista,
} from './coachV2Logic';

// supabase.rpc/from tipado no conoce las RPC nuevas: un solo cast acá.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export interface EquipoCoach extends EquipoHorario {
  deporte: string | null;
  imagen: string | null;
}

/** Equipos del profe (principal o asistente), con horario. */
export function useEquiposCoach(schoolId: string | null | undefined) {
  return useQuery({
    queryKey: ['coach-v2', 'equipos', schoolId],
    enabled: !!schoolId,
    staleTime: 60_000,
    queryFn: async (): Promise<EquipoCoach[]> => {
      const { teamIds } = await fetchCoachTeams(schoolId as string);
      if (teamIds.length === 0) return [];
      const { data, error } = await db
        .from('teams')
        .select('id, name, schedule, location, current_students, sport, image_url')
        .in('id', teamIds);
      if (error) throw error;
      return ((data ?? []) as Array<Record<string, unknown>>)
        .map((t) => ({
          id: String(t.id),
          nombre: String(t.name ?? 'Equipo'),
          lugar: (t.location as string) ?? null,
          franjas: leerFranjas(t.schedule),
          deportistas: Number(t.current_students ?? 0),
          deporte: (t.sport as string) ?? null,
          imagen: (t.image_url as string) ?? null,
        }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    },
  });
}

/** Deportistas activos del equipo, sin ninguna columna de plata. */
export function useDeportistasEquipo(schoolId: string | null | undefined, teamId: string | null | undefined) {
  return useQuery({
    queryKey: ['coach-v2', 'deportistas', schoolId, teamId],
    enabled: !!schoolId && !!teamId,
    queryFn: async (): Promise<Deportista[]> => {
      const { data, error } = await db
        .from('school_athletes')
        .select('id, user_id, athlete_type, full_name, avatar_url, parent_name, parent_phone')
        .eq('school_id', schoolId)
        .eq('enrolled_team_id', teamId)
        .eq('is_active', true);
      if (error) throw error;
      const vistos = new Set<string>();
      const out: Deportista[] = [];
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const id = r.id ? String(r.id) : null;
        if (!id || vistos.has(id)) continue;
        vistos.add(id);
        const tipo: TipoDeportista = r.athlete_type === 'child' ? 'child' : r.athlete_type === 'unregistered' ? 'unregistered' : 'adult';
        out.push({
          id,
          tipo,
          userId: (r.user_id as string) ?? null,
          nombre: String(r.full_name ?? 'Deportista'),
          avatarUrl: (r.avatar_url as string) ?? null,
          acudiente: (r.parent_name as string) ?? null,
          telefonoAcudiente: (r.parent_phone as string) ?? null,
        });
      }
      return out.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    },
  });
}

export interface ResultadoBusquedaRefuerzo {
  subject_type: 'child' | 'profile' | 'unregistered';
  subject_id: string;
  nombre: string;
  /** Categoría/equipo actual del deportista, para no confundir homónimos. */
  equipo: string | null;
}

/**
 * Deportistas ACTIVOS de la escuela (cualquier categoría, excepto `teamId`) por
 * nombre, para convocarlos como refuerzo a un partido que no es el de su
 * equipo. Los de `teamId` ya se marcan desde la cuadrícula del roster, así que
 * se excluyen acá para no duplicar la fila. Sin consulta por debajo de 2
 * caracteres: la escuela puede tener cientos de deportistas.
 */
export function useBuscarRefuerzos(schoolId: string | null | undefined, teamId: string | null | undefined, texto: string) {
  const q = texto.trim();
  return useQuery({
    queryKey: ['coach-v2', 'buscar-refuerzos', schoolId, teamId, q],
    enabled: !!schoolId && q.length >= 2,
    queryFn: async (): Promise<ResultadoBusquedaRefuerzo[]> => {
      const { data, error } = await db
        .from('school_athletes')
        .select('id, user_id, athlete_type, full_name, enrolled_team_id, team_name')
        .eq('school_id', schoolId)
        .eq('is_active', true)
        .ilike('full_name', `%${q}%`)
        .limit(15);
      if (error) throw error;
      const vistos = new Set<string>();
      const out: ResultadoBusquedaRefuerzo[] = [];
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const id = r.id ? String(r.id) : null;
        if (!id || (teamId && r.enrolled_team_id === teamId)) continue;
        const tipo: TipoDeportista = r.athlete_type === 'child' ? 'child' : r.athlete_type === 'unregistered' ? 'unregistered' : 'adult';
        const sujeto = sujetoDe({ id, tipo, userId: (r.user_id as string) ?? null });
        const k = claveConvocado(sujeto);
        if (vistos.has(k)) continue;
        vistos.add(k);
        out.push({ ...sujeto, nombre: String(r.full_name ?? 'Deportista'), equipo: (r.team_name as string) ?? null });
      }
      return out.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    },
  });
}

/** B3. `disponible: false` = la RPC todavía no existe (o la escuela oculta pagos al profe). */
export function useEstadoPagoEquipo(teamId: string | null | undefined, habilitado: boolean) {
  return useQuery({
    queryKey: ['coach-v2', 'pago', teamId],
    enabled: !!teamId && habilitado,
    retry: false,
    queryFn: async (): Promise<{ disponible: boolean; mapa: Map<string, EstadoPago> }> => {
      const r = await estadoPagoEquipo(teamId as string);
      if (r.noDisponible) return { disponible: false, mapa: new Map() };
      // 42501 «No diriges este equipo»: no es un error, simplemente no hay chips.
      if (r.codigo === '42501') return { disponible: false, mapa: new Map() };
      if (r.error) throw new Error(r.error);
      return { disponible: true, mapa: mapaEstadosPago(r.data) };
    },
  });
}

const MEMO_KUDOS = 'sm_coach_v2_kudos_disponible';
let kudosEnMemoria: boolean | undefined;

function leerMemoKudos(): boolean | undefined {
  if (kudosEnMemoria !== undefined) return kudosEnMemoria;
  try {
    const v = sessionStorage.getItem(MEMO_KUDOS);
    if (v === '1' || v === '0') kudosEnMemoria = v === '1';
  } catch { /* sin sessionStorage */ }
  return kudosEnMemoria;
}

function guardarMemoKudos(v: boolean) {
  kudosEnMemoria = v;
  try { sessionStorage.setItem(MEMO_KUDOS, v ? '1' : '0'); } catch { /* sin sessionStorage */ }
}

/** Solo para pruebas: olvida lo aprendido en esta sesión. */
export function _olvidarFelicitarDisponible() {
  kudosEnMemoria = undefined;
  try { sessionStorage.removeItem(MEMO_KUDOS); } catch { /* sin sessionStorage */ }
}

/**
 * B1. ¿Existe Felicitar? Se pregunta UNA vez por sesión con `list_kudos` (solo
 * lectura) sobre un deportista REAL de la pantalla: sin deportista la RPC
 * responde 400 (22023) y ensuciaba la consola en cada pantalla. El resultado se
 * recuerda en memoria y en sessionStorage. Sin deportista a mano, no se pregunta
 * (data undefined = no se muestra Felicitar todavía).
 */
export function useFelicitarDisponible(sujeto?: SujetoDeportista | null) {
  const memo = leerMemoKudos();
  return useQuery({
    queryKey: ['coach-v2', 'kudos-disponible'],
    enabled: memo === undefined && !!sujeto,
    initialData: memo,
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<boolean> => {
      // Solo PGRST202/404 la da por ausente; cualquier otra respuesta prueba que existe.
      const r = await listarFelicitaciones(sujeto as SujetoDeportista, 1);
      const ok = !r.noDisponible;
      guardarMemoKudos(ok);
      return ok;
    },
  });
}

/** Sesiones de lista de los últimos `dias` de estos equipos, y si ya tienen evaluación del profe. */
export function useSesionesRecientes(teamIds: string[], hoy: Date, dias = 7) {
  const desde = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - dias);
  return useQuery({
    queryKey: ['coach-v2', 'sesiones', [...teamIds].sort().join(','), isoDia(hoy), dias],
    enabled: teamIds.length > 0,
    queryFn: async (): Promise<SesionReciente[]> => {
      const { data, error } = await db
        .from('attendance_sessions')
        .select('id, team_id, session_date, finalized')
        .in('team_id', teamIds)
        .gte('session_date', isoDia(desde))
        .lte('session_date', isoDia(hoy))
        .order('session_date', { ascending: false })
        .limit(60);
      if (error) throw error;
      const filas = (data ?? []) as Array<{ id: string; team_id: string; session_date: string; finalized: boolean | null }>;
      const cerradas = filas.filter((s) => s.finalized).map((s) => s.id);
      const evaluadas = new Set<string>();
      if (cerradas.length) {
        const { data: pe } = await db
          .from('performance_entries')
          .select('context_id')
          .eq('context_type', 'session')
          .eq('metric_key', 'coach_effort_rating')
          .in('context_id', cerradas);
        for (const r of (pe ?? []) as Array<{ context_id: string }>) evaluadas.add(r.context_id);
      }
      return filas.map((s) => ({
        id: s.id,
        teamId: s.team_id,
        fecha: s.session_date,
        cerrada: !!s.finalized,
        evaluada: evaluadas.has(s.id),
      }));
    },
  });
}

export interface PresenteSesion {
  clave: string;
  childId: string | null;
  userId: string | null;
  unregisteredId: string | null;
  sinCuenta: boolean;
  nombre: string;
  avatarUrl: string | null;
}

/** Los que vinieron (presente o tarde) a una sesión ya cerrada. */
export function usePresentesSesion(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: ['coach-v2', 'presentes', sessionId],
    enabled: !!sessionId,
    queryFn: async (): Promise<PresenteSesion[]> => {
      const { data, error } = await db.rpc('get_post_training_pending_roster', { p_session_id: sessionId });
      if (error) throw error;
      return ((data ?? []) as Array<Record<string, string | null>>)
        .map((r) => ({
          clave: (r.child_id ?? r.user_id ?? r.unregistered_athlete_id) as string,
          childId: r.child_id ?? null,
          userId: r.user_id ?? null,
          unregisteredId: r.unregistered_athlete_id ?? null,
          sinCuenta: !r.child_id && !r.user_id,
          nombre: r.full_name ?? 'Deportista',
          avatarUrl: r.avatar_url ?? null,
        }))
        .filter((r) => !!r.clave)
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    },
  });
}

export interface SesionDetalle {
  id: string;
  teamId: string | null;
  schoolId: string | null;
  fecha: string;
  cerrada: boolean;
  nota: string | null;
  equipo: string | null;
  /** Cómo le fue ya guardado (si se evaluó antes), por clave child/user. */
  previas: Record<string, ComoLeFue>;
}

export function useSesionDetalle(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: ['coach-v2', 'sesion', sessionId],
    enabled: !!sessionId,
    queryFn: async (): Promise<SesionDetalle> => {
      const { data, error } = await db
        .from('attendance_sessions')
        .select('id, team_id, school_id, session_date, finalized, coach_notes, teams(name)')
        .eq('id', sessionId)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Sesión no encontrada');
      const { data: pe } = await db
        .from('performance_entries')
        .select('subject_id, value')
        .eq('context_type', 'session')
        .eq('context_id', sessionId)
        .eq('metric_key', 'coach_effort_rating');
      const previas: Record<string, ComoLeFue> = {};
      for (const r of (pe ?? []) as Array<{ subject_id: string; value: number }>) {
        const c = comoDesdeEffort(r.value);
        if (c) previas[r.subject_id] = c;
      }
      return {
        id: data.id,
        teamId: data.team_id ?? null,
        schoolId: data.school_id ?? null,
        fecha: data.session_date,
        cerrada: !!data.finalized,
        nota: data.coach_notes ?? null,
        equipo: data.teams?.name ?? null,
        previas,
      };
    },
  });
}

export interface PlanDeHoy {
  id: string;
  teamId: string;
  objetivo: string | null;
  session_blocks: unknown;
  drills: unknown;
  warmup: string | null;
}

export function usePlanesDeHoy(teamIds: string[], hoy: Date) {
  return useQuery({
    queryKey: ['coach-v2', 'plan-hoy', [...teamIds].sort().join(','), isoDia(hoy)],
    enabled: teamIds.length > 0,
    queryFn: async (): Promise<PlanDeHoy[]> => {
      const { data, error } = await db
        .from('training_sessions')
        .select('id, team_id, objectives, session_blocks, drills, warmup')
        .in('team_id', teamIds)
        .eq('session_date', isoDia(hoy));
      if (error) throw error;
      return ((data ?? []) as Array<Record<string, unknown>>).map((s) => ({
        id: String(s.id),
        teamId: String(s.team_id),
        objetivo: (s.objectives as string) || null,
        session_blocks: s.session_blocks,
        drills: s.drills,
        warmup: (s.warmup as string) ?? null,
      }));
    },
  });
}

interface CoberturaBff {
  team_id: string | null;
  team_name: string;
  total: number;
  listos: number;
  faltan_nota: number;
  publicados: number;
}

/**
 * Informe mensual del periodo. `release_by` = quién publica (decisión 3): solo
 * con 'coach' el profe ve «Publicar». Si el BFF falla, `null`: no se inventa nada.
 */
export function useInformesDelMes(schoolId: string | null | undefined, year: number, month: number) {
  return useQuery({
    queryKey: ['coach-v2', 'informes', schoolId, year, month],
    enabled: !!schoolId,
    retry: 1,
    queryFn: async (): Promise<{ puedePublicar: boolean; equipos: InformeEquipo[] }> => {
      const r = await bffClient.get<{ release_by?: 'school' | 'coach'; cobertura?: CoberturaBff[] }>(
        `/api/v1/school/reports?year=${year}&month=${month}`,
      );
      return {
        puedePublicar: r?.release_by === 'coach',
        equipos: (r?.cobertura ?? [])
          .filter((c) => !!c.team_id)
          .map((c) => ({
            teamId: c.team_id as string,
            equipo: c.team_name,
            total: Number(c.total ?? 0),
            listos: Number(c.listos ?? 0),
            publicados: Number(c.publicados ?? 0),
            faltanNota: Number(c.faltan_nota ?? 0),
          })),
      };
    },
  });
}

const aPartido = (m: Record<string, unknown>): Partido => ({
  id: String(m.id),
  rival: String(m.opponent ?? 'Rival'),
  fecha: String(m.match_date ?? ''),
  kickoffAt: (m.kickoff_at as string) ?? null,
  lugar: (m.location as string) ?? null,
  enCasa: (m.is_home as boolean | null) ?? null,
  golesLocal: (m.home_score as number | null) ?? null,
  golesVisita: (m.away_score as number | null) ?? null,
  estado: (m.status as string) ?? null,
  tipo: (m.match_type as string) ?? null,
  nota: (m.notes as string) ?? null,
});

const COLUMNAS_PARTIDO = 'id, team_id, opponent, match_date, kickoff_at, location, is_home, home_score, away_score, status, match_type, notes';

export function usePartidosEquipo(teamId: string | null | undefined) {
  return useQuery({
    queryKey: ['coach-v2', 'partidos', teamId],
    enabled: !!teamId,
    queryFn: async (): Promise<Partido[]> => {
      const { data, error } = await db
        .from('match_results')
        .select(COLUMNAS_PARTIDO)
        .eq('team_id', teamId)
        .order('match_date', { ascending: false })
        .limit(30);
      if (error) throw error;
      return ((data ?? []) as Array<Record<string, unknown>>).map(aPartido);
    },
  });
}

/** Partidos de los próximos 7 días de mis equipos, y si ya tienen convocatoria. */
export function usePartidosProximos(teamIds: string[], hoy: Date) {
  const hasta = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 7);
  return useQuery({
    queryKey: ['coach-v2', 'partidos-proximos', [...teamIds].sort().join(','), isoDia(hoy)],
    enabled: teamIds.length > 0,
    queryFn: async (): Promise<Array<Partido & { teamId: string; convocado: boolean }>> => {
      const { data, error } = await db
        .from('match_results')
        .select(COLUMNAS_PARTIDO)
        .in('team_id', teamIds)
        .gte('match_date', isoDia(hoy))
        .lte('match_date', isoDia(hasta))
        .order('match_date', { ascending: true })
        .limit(10);
      if (error) throw error;
      const filas = ((data ?? []) as Array<Record<string, unknown>>)
        .filter((m) => m.status !== 'cancelled' && (m.home_score == null || m.away_score == null));
      return Promise.all(filas.map(async (m) => {
        let convocado = false;
        try {
          const l = await getFootballLineups({ source_type: 'team_match', source_id: String(m.id) });
          convocado = (l ?? []).length > 0;
        } catch {
          convocado = true; // sin saberlo, no se insiste con un pendiente que puede ser falso
        }
        return { ...aPartido(m), teamId: String(m.team_id), convocado };
      }));
    },
  });
}

/** Convocatoria (alineación) de un partido de club. null = todavía no hay. */
export function useConvocatoria(matchId: string | null | undefined) {
  return useQuery({
    queryKey: ['coach-v2', 'convocatoria', matchId],
    enabled: !!matchId,
    queryFn: async (): Promise<LineupDetail | null> => {
      const lista = await getFootballLineups({ source_type: 'team_match', source_id: matchId as string });
      if (!lista?.length) return null;
      return getFootballLineup(lista[0].id);
    },
  });
}

/**
 * Nombres de convocados que no están en el roster activo (refuerzos de otra
 * categoría o inactivos). Lee school_athletes de la escuela SIN filtrar por
 * equipo ni por activo, solo id y nombre. Mapa clave «tipo:id» → nombre.
 */
export function useNombresConvocados(schoolId: string | null | undefined, sujetos: Array<{ subject_type: string; subject_id: string }>) {
  const ids = [...new Set(sujetos.map((s) => s.subject_id))].sort();
  return useQuery({
    queryKey: ['coach-v2', 'nombres-convocados', schoolId, ids.join(',')],
    enabled: !!schoolId && ids.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, string>> => {
      const lista = ids.join(',');
      const { data, error } = await db
        .from('school_athletes')
        .select('id, user_id, athlete_type, full_name')
        .eq('school_id', schoolId)
        .or(`id.in.(${lista}),user_id.in.(${lista})`);
      if (error) throw error;
      const mapa = new Map<string, string>();
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const nombre = String(r.full_name ?? '').trim();
        if (!nombre) continue;
        const tipo = r.athlete_type === 'child' ? 'child' : r.athlete_type === 'unregistered' ? 'unregistered' : 'profile';
        if (r.id) mapa.set(`${tipo}:${r.id}`, nombre);
        if (tipo === 'profile' && r.user_id) mapa.set(`profile:${r.user_id}`, nombre);
      }
      return mapa;
    },
  });
}

export interface RespuestaConvocado { nombre: string; respuesta: 'va' | 'no_va' | null }

/** B2. Respuestas «Va / No va» de la familia. `disponible: false` = RPC aún no existe. */
export function useRespuestasConvocatoria(lineupId: string | null | undefined) {
  return useQuery({
    queryKey: ['coach-v2', 'callup', lineupId],
    enabled: !!lineupId,
    retry: false,
    queryFn: async (): Promise<{ disponible: boolean; filas: RespuestaConvocado[] }> => {
      const r = await estadoConvocatoria(lineupId as string);
      if (r.noDisponible) return { disponible: false, filas: [] };
      if (r.error) throw new Error(r.error);
      return {
        disponible: true,
        filas: (r.data ?? []).map((x) => ({
          nombre: x.athlete_name ?? 'Deportista',
          respuesta: x.response === 'va' || x.response === 'no_va' ? x.response : null,
        })),
      };
    },
  });
}

/** Citas personales de hoy (agenda del profe). 0 = no se muestra nada. */
export function useCitasDeHoy(userId: string | null | undefined, hoy: Date) {
  return useQuery({
    queryKey: ['coach-v2', 'agenda', userId, isoDia(hoy)],
    // Solo entrenadores personales tienen agenda: tras el primer 403 no se vuelve a pedir.
    enabled: !!userId && !agendaPersonalSinAcceso(),
    retry: false,
    queryFn: async (): Promise<Array<{ hora: string | null; con: string | null }>> => {
      try {
        const r = await agendaPersonalDelDia(isoDia(hoy));
        return (r?.sessions ?? [])
          .filter((s) => s.status !== 'cancelled')
          .map((s) => ({
            hora: (s.start_time as string) ?? null,
            con: ((s.client as { full_name?: string } | null)?.full_name ?? (s.athlete_name as string)) ?? null,
          }));
      } catch {
        return [];
      }
    },
  });
}

export interface UltimaJugada {
  id: string;
  teamId: string | null;
  fuente: string | null;
  fecha: string; // ISO
}

/**
 * La última jugada que el profe guardó en la pizarra (match_lineups: bloques de
 * sesión, partidos o la pizarra libre). Para «Hoy no entrenas» (ítem 30).
 * Un solo registro, filtrado por autor: barato.
 */
export function useUltimaJugada(schoolId: string | null | undefined, userId: string | null | undefined) {
  return useQuery({
    queryKey: ['coach-v2', 'ultima-jugada', schoolId, userId],
    enabled: !!schoolId && !!userId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<UltimaJugada | null> => {
      const { data, error } = await db
        .from('match_lineups')
        .select('id, team_id, source_type, updated_at, created_at')
        .eq('school_id', schoolId)
        .eq('created_by', userId)
        .order('updated_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        id: String(data.id),
        teamId: (data.team_id as string) ?? null,
        fuente: (data.source_type as string) ?? null,
        fecha: String(data.updated_at ?? data.created_at),
      };
    },
  });
}
