/**
 * Deportista V2 — lecturas. Solo tablas y RPC que ya existen o que define el
 * contrato (docs/specs/entrenador-deportista-v2.md §3):
 *
 *  · Equipos     → `enrollments` (user_id = él o su ficha vinculada, sin child_id, activas) con `teams.schedule`.
 *  · Fichas      → my_linked_unregistered_ids() una vez: equipos, asistencia y felicitaciones las suman.
 *  · Cobros      → `payments` (RLS «Payments: select athlete/parent»). SOLO se
 *                  consultan si puede pagar (mayor o pagador explícito): al
 *                  menor ni se le piden.
 *  · Asistencia  → `attendance_records` (RLS «atleta_ve_su_propia_asistencia»).
 *  · Convocatoria→ my_callups / respond_callup (B2) vía lib/api/v2Contratos.
 *  · Felicitación→ list_kudos (B1) vía lib/api/v2Contratos.
 *  · Informes    → misInformesDeportista (B4) vía lib/api/v2Contratos.
 *    En las tres, `noDisponible` (RPC aún sin aplicar) → `oculto`: la sección no se pinta.
 *  · Autoevaluación pendiente → sesión cerrada y en plazo (fin del día siguiente) a la que vino (él o su ficha), sin
 *                  `rpe_borg` guardado (mismas reglas que submit_post_training_self_eval).
 *  · Plan del mes→ `training_mesocycles` (hoy su RLS es solo de staff: vacío → se oculta).
 *
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { calcEarlyPaymentDiscount, modoProntoPago } from '@/lib/earlyPaymentDiscount';
import { plazoAutoeval } from '@/lib/postEntrenoAutoeval';
import { isOneTimeCategory } from '@/lib/payment-accounts';
import { getMyOpenTournaments, type OpenTournament } from '@/lib/api/tournaments';
import { leerFranjas, type Franja } from '@/components/parent/v2/parentHomeLogic';
import type { AttendanceRecord } from '@/components/parent/v2/hijos/hijosUtils';
import type { Transaction } from '@/components/parent/v2/pagosModel';
import {
  listarFelicitaciones, misConvocatorias as misConvocatoriasRpc, misInformesDeportista,
  responderConvocatoria as responderConvocatoriaRpc, sujetoDesde, type InformeMensualItem,
} from '@/lib/api/v2Contratos';
import {
  aFelicitaciones, aTransaction, esCobroPropio, misConvocatorias,
  type Convocatoria, type Felicitacion, type PaymentRow,
} from './athleteV2Model';

// Tablas/RPC fuera del types.ts generado: se leen sin tipar y se validan con los tipos de arriba.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/** Resultado de una sección que depende de una RPC que puede no existir aún. */
export interface Opcional<T> { oculto: boolean; data: T }

// ── Equipos ──────────────────────────────────────────────────────────────────

export interface EquipoDeportista {
  teamId: string;
  nombre: string;
  deporte: string | null;
  lugar: string | null;
  profe: string | null;
  franjas: Franja[];
  schoolId: string | null;
  escuela: string | null;
}

type TeamJoin = {
  id: string; name: string | null; sport: string | null; location: string | null; schedule: unknown;
  coach: { full_name: string | null } | { full_name: string | null }[] | null;
};
const uno = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

// ── Fichas vinculadas (unregistered_athletes.linked_profile_id = él) ─────────
//
// En Monster/Besser la cuenta del deportista quedó enlazada a la ficha que creó
// la escuela, y su asistencia/felicitaciones/inscripciones están a nombre de la
// ficha (`unregistered_athlete_id`), no de `user_id`. Se leen UNA vez por
// sesión (ensureQueryData con la misma llave) y se suman a cada filtro.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const fichasKey = (userId: string | undefined) => ['athlete-v2-fichas', userId];

/** ids de mis fichas vinculadas. Si la RPC falla o no existe: [] (sigue solo con la cuenta). */
export async function cargarFichas(): Promise<string[]> {
  try {
    const { data, error } = await db.rpc('my_linked_unregistered_ids');
    if (error) {
      console.warn('[deportista-v2] my_linked_unregistered_ids', error);
      return [];
    }
    return (Array.isArray(data) ? data : []).filter((id: unknown): id is string => typeof id === 'string' && UUID.test(id));
  } catch (e) {
    console.warn('[deportista-v2] my_linked_unregistered_ids', e);
    return [];
  }
}

/** Devuelve una función que trae las fichas desde la caché (o las pide una sola vez). */
function useFichasLoader(userId: string | undefined) {
  const qc = useQueryClient();
  return () => qc.ensureQueryData({ queryKey: fichasKey(userId), queryFn: cargarFichas, staleTime: 30 * 60 * 1000 });
}

/** `user_id.eq.X` o `user_id.eq.X,unregistered_athlete_id.in.(a,b)` para `.or()`. */
export function filtroDeportista(userId: string, fichas: string[] = []): string {
  const ids = fichas.filter((id) => UUID.test(id));
  return ids.length ? `user_id.eq.${userId},unregistered_athlete_id.in.(${ids.join(',')})` : `user_id.eq.${userId}`;
}

export async function cargarEquipos(userId: string, fichas: string[] = []): Promise<EquipoDeportista[]> {
  // `child_id IS NULL`: inscripciones viejas de sus hijos traen user_id = él junto al child_id.
  const { data, error } = await db
    .from('enrollments')
    .select('school_id, team_id, created_at, schools(name), teams!enrollments_team_id_fkey(id, name, sport, location, schedule, coach:coach_id(full_name))')
    .or(filtroDeportista(userId, fichas))
    .is('child_id', null)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) throw error;
  const vistos = new Set<string>();
  const out: EquipoDeportista[] = [];
  for (const e of (data ?? []) as { school_id: string | null; schools: unknown; teams: TeamJoin | TeamJoin[] | null }[]) {
    const t = uno(e.teams);
    if (!t || vistos.has(t.id)) continue;
    vistos.add(t.id);
    out.push({
      teamId: t.id,
      nombre: t.name ?? 'Tu equipo',
      deporte: t.sport,
      lugar: t.location,
      profe: uno(t.coach)?.full_name ?? null,
      franjas: leerFranjas(t.schedule),
      schoolId: e.school_id,
      escuela: (uno(e.schools as { name: string | null } | null) as { name: string | null } | null)?.name ?? null,
    });
  }
  return out;
}

export function useAthleteTeams(userId: string | undefined) {
  const fichas = useFichasLoader(userId);
  return useQuery({
    queryKey: ['athlete-v2-teams', userId],
    queryFn: async () => cargarEquipos(userId!, await fichas()),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  });
}

// ── Cobros (solo si puede pagar) ─────────────────────────────────────────────

export interface CobrosDeportista {
  /** Filas crudas: sirven para saber si figura como pagador (sin fecha de nacimiento). */
  filas: PaymentRow[];
  /** Los suyos, en el modelo de AcuPagosV2. */
  transacciones: Transaction[];
  facturas: Record<string, { number: string | null; public_url: string | null }>;
}

const PAYMENT_COLS =
  'id, amount, amount_paid, status, concept, school_id, user_id, parent_id, child_id, due_date, payment_date, created_at, receipt_url, receipt_number, period_year, period_month, payment_category, payment_method, payment_provider, late_fee_amount, last_failure_reason, last_failure_at, requires_review, early_payment_discount_applied';

export async function cargarCobros(userId: string): Promise<CobrosDeportista> {
  const { data, error } = await db
    .from('payments')
    .select(PAYMENT_COLS)
    .or(`user_id.eq.${userId},parent_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const filas = ((data ?? []) as (PaymentRow & { early_payment_discount_applied?: number | null })[])
    .filter((p) => esCobroPropio({ parent_id: p.parent_id ?? null, user_id: p.user_id ?? null, child_id: p.child_id ?? null }, userId));

  // Pronto pago: misma regla que Pagos del acudiente (solo mensualidad, sin cobro
  // anterior sin pagar). Si la configuración no carga, no se descuenta nada.
  const escuelas = [...new Set(filas.map((p) => p.school_id).filter(Boolean))] as string[];
  const cfg = new Map<string, { enabled: boolean; days: number; percentage: number; mode?: 'days_from_creation' | 'day_of_month' }>();
  if (escuelas.length > 0) {
    const { data: ss } = await db
      .from('school_settings')
      .select('school_id, early_payment_discount_enabled, early_payment_discount_days, early_payment_discount_percentage, early_payment_discount_mode')
      .in('school_id', escuelas);
    for (const s of (ss ?? []) as { school_id: string; early_payment_discount_enabled: boolean | null; early_payment_discount_days: number | null; early_payment_discount_percentage: number | null; early_payment_discount_mode?: string | null }[]) {
      cfg.set(s.school_id, { enabled: !!s.early_payment_discount_enabled, days: s.early_payment_discount_days || 5, percentage: s.early_payment_discount_percentage || 0, mode: modoProntoPago(s.early_payment_discount_mode) });
    }
  }
  const sinPagar = filas.filter((p) => ['pending', 'overdue', 'partial'].includes(p.status));
  const transacciones = filas.map((p) => {
    const conf = isOneTimeCategory(p.payment_category) || !p.school_id
      ? { enabled: false, days: 5, percentage: 0 }
      : cfg.get(p.school_id) ?? { enabled: false, days: 5, percentage: 0 };
    const anterior = sinPagar.some((o) => o.school_id === p.school_id && o.created_at < p.created_at);
    const d = calcEarlyPaymentDiscount(Number(p.amount ?? 0), {
      createdAt: p.created_at,
      config: conf,
      hasEarlierUnpaid: anterior,
      alreadyAppliedAmount: p.early_payment_discount_applied ?? null,
    });
    return aTransaction(p, { amount: d.discountAmount, eligible: d.eligible, validUntil: d.validUntil });
  });

  let facturas: CobrosDeportista['facturas'] = {};
  const pagados = filas.filter((p) => p.status === 'paid').map((p) => p.id);
  if (pagados.length > 0) {
    const { data: inv } = await db
      .from('electronic_invoices')
      .select('payment_id, number, public_url, status')
      .in('payment_id', pagados)
      .in('status', ['accepted', 'sent']);
    facturas = Object.fromEntries(
      ((inv ?? []) as { payment_id: string | null; number: string | null; public_url: string | null }[])
        .filter((r) => r.payment_id)
        .map((r) => [r.payment_id!, { number: r.number, public_url: r.public_url }]),
    );
  }
  return { filas, transacciones, facturas };
}

export const athleteCobrosKey = (userId: string | undefined) => ['athlete-v2-cobros', userId];

/** `enabled` = puede pagar (o no se sabe su edad). Con un menor NUNCA se activa. */
export function useAthleteCobros(userId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: athleteCobrosKey(userId),
    queryFn: () => cargarCobros(userId!),
    enabled: !!userId && enabled,
  });
}

// ── Asistencia ───────────────────────────────────────────────────────────────

/** Su asistencia como adulto y la de sus fichas vinculadas (RLS attendance_records_select_linked_athlete). */
export async function cargarAsistencia(userId: string, fichas: string[] = []): Promise<AttendanceRecord[]> {
  const { data, error } = await db
    .from('attendance_records')
    .select('attendance_date, status')
    .or(filtroDeportista(userId, fichas))
    .is('child_id', null)
    .order('attendance_date', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as AttendanceRecord[];
}

export function useAthleteAttendance(userId: string | undefined) {
  const fichas = useFichasLoader(userId);
  return useQuery({
    queryKey: ['athlete-v2-attendance', userId],
    queryFn: async () => cargarAsistencia(userId!, await fichas()),
    enabled: !!userId,
  });
}

// ── Convocatorias (B2) y felicitaciones (B1): por lib/api/v2Contratos ────────

export const callupsKey = (userId: string | undefined) => ['athlete-v2-callups', userId];

export function useMyCallups(userId: string | undefined) {
  return useQuery({
    queryKey: callupsKey(userId),
    queryFn: async (): Promise<Opcional<Convocatoria[]>> => {
      const r = await misConvocatoriasRpc();
      if (r.noDisponible) return { oculto: true, data: [] };
      if (r.error) throw new Error(r.error);
      return { oculto: false, data: misConvocatorias(r.data, userId!) };
    },
    enabled: !!userId,
    retry: false,
  });
}

/** Solo el deportista MAYOR responde por sí mismo (decisión 8); la UI del menor no llama esto. */
export async function responderConvocatoria(c: Pick<Convocatoria, 'lineupId' | 'subjectType' | 'subjectId'>, respuesta: 'va' | 'no_va'): Promise<void> {
  const r = await responderConvocatoriaRpc(c.lineupId, sujetoDesde(c.subjectType, c.subjectId), respuesta);
  if (r.error || r.noDisponible) throw new Error(r.error ?? 'Todavía no se puede responder desde aquí.');
}

/**
 * Felicitaciones de la cuenta y de cada ficha vinculada (list_kudos acepta un
 * solo sujeto por llamada), unidas, sin repetidos y de la más nueva a la más vieja.
 * Si falla solo una ficha, se muestran las demás (el detalle va a consola).
 */
export async function cargarFelicitaciones(userId: string, fichas: string[] = [], limit = 20): Promise<Opcional<Felicitacion[]>> {
  const [cuenta, ...deFichas] = await Promise.all([
    listarFelicitaciones({ athleteUserId: userId }, limit),
    ...fichas.map((id) => listarFelicitaciones({ unregisteredAthleteId: id }, limit)),
  ]);
  if (cuenta.noDisponible) return { oculto: true, data: [] };
  const ok = [cuenta, ...deFichas].filter((r) => !r.error && !r.noDisponible);
  if (ok.length === 0) throw new Error(cuenta.error ?? 'No pudimos cargar tus felicitaciones.');
  for (const r of [cuenta, ...deFichas]) if (r.error) console.warn('[deportista-v2] list_kudos', r.codigo, r.error);
  const vistos = new Set<string>();
  const todas = ok
    .flatMap((r) => aFelicitaciones(r.data))
    .filter((k) => (vistos.has(k.id) ? false : (vistos.add(k.id), true)))
    .sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
  return { oculto: false, data: todas.slice(0, limit) };
}

export function useMyKudos(userId: string | undefined, limit = 20) {
  const fichas = useFichasLoader(userId);
  return useQuery({
    queryKey: ['athlete-v2-kudos', userId, limit],
    queryFn: async () => cargarFelicitaciones(userId!, await fichas(), limit),
    enabled: !!userId,
    retry: false,
  });
}

/** Informes mensuales publicados del deportista (B4: los de adulto y los de su ficha). */
export function useMisInformes(userId: string | undefined) {
  return useQuery({
    queryKey: ['athlete-v2-informes', userId],
    queryFn: async () => {
      const r = await misInformesDeportista();
      if (r.noDisponible) return { oculto: true, data: [] as InformeMensualItem[] };
      if (r.error) throw new Error(r.error);
      return { oculto: false, data: r.data ?? [] };
    },
    enabled: !!userId,
  });
}

// ── Autoevaluación pendiente ─────────────────────────────────────────────────

export interface AutoevalPendiente {
  sessionId: string;
  sessionDate: string;
  equipo: string | null;
  /** Métricas obligatorias del deporte (sport_metric_definitions.required). */
  requeridas: string[];
  /** La asistencia está a nombre de su ficha vinculada: se responde por ella (p_unregistered_athlete_id). */
  fichaId: string | null;
}

export const autoevalKey = (userId: string | undefined) => ['athlete-v2-autoeval', userId];

/**
 * La sesión más reciente que (a) sigue en plazo (hasta el fin del día siguiente al cierre, plazoAutoeval), (b) él vino
 * (present/late) y (c) todavía no tiene su «¿Qué tan duro fue?». Son las mismas
 * condiciones que exige la RPC: si no se cumplen, la tarjeta no sale.
 *
 * Cuenta y fichas vinculadas (filtroDeportista): submit_post_training_self_eval
 * acepta p_unregistered_athlete_id (migración 20261026155123) y valida la
 * asistencia de la ficha en `attendance_records.unregistered_athlete_id`. Si la
 * sesión está a nombre de la cuenta, manda la cuenta; si no, la ficha.
 */
export async function cargarAutoevalPendiente(userId: string, ahora = new Date(), fichas: string[] = []): Promise<AutoevalPendiente | null> {
  const desde = new Date(ahora.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
  const { data: recs, error } = await db
    .from('attendance_records')
    .select('session_id, attendance_date, user_id, unregistered_athlete_id')
    .or(filtroDeportista(userId, fichas))
    .is('child_id', null)
    .in('status', ['present', 'late'])
    .gte('attendance_date', desde)
    .not('session_id', 'is', null);
  if (error) throw error;
  // Sujeto por sesión: la cuenta gana; si solo está la ficha (y es suya), la ficha.
  const sujeto = new Map<string, string | null>();
  for (const r of (recs ?? []) as { session_id: string; user_id: string | null; unregistered_athlete_id: string | null }[]) {
    if (r.user_id === userId) sujeto.set(r.session_id, null);
    else if (r.unregistered_athlete_id && fichas.includes(r.unregistered_athlete_id) && !sujeto.has(r.session_id)) {
      sujeto.set(r.session_id, r.unregistered_athlete_id);
    }
  }
  const ids = [...sujeto.keys()];
  if (ids.length === 0) return null;

  const { data: ses, error: sErr } = await db
    .from('attendance_sessions')
    .select('id, session_date, finalized, finalized_at, updated_at, teams(name), schools(category_id)')
    .in('id', ids);
  if (sErr) throw sErr;
  const vigentes = ((ses ?? []) as {
    id: string; session_date: string; finalized: boolean | null; finalized_at: string | null; updated_at?: string | null;
    teams: { name: string | null } | null; schools: { category_id: string | null } | null;
  }[])
    .filter((s) => {
      if (s.finalized !== true) return false;
      const plazo = plazoAutoeval(s.finalized_at, s.updated_at);
      return !plazo || ahora < plazo;
    })
    .sort((a, b) => (a.session_date < b.session_date ? 1 : -1));

  for (const s of vigentes) {
    const fichaId = sujeto.get(s.id) ?? null;
    const { count } = await db
      .from('performance_entries')
      .select('id', { count: 'exact', head: true })
      .eq('subject_type', fichaId ? 'unregistered' : 'profile')
      .eq('subject_id', fichaId ?? userId)
      .eq('context_type', 'session')
      .eq('context_id', s.id)
      .eq('metric_key', 'rpe_borg');
    if ((count ?? 0) > 0) continue;
    const cat = uno(s.schools)?.category_id ?? null;
    let requeridas: string[] = [];
    if (cat) {
      const { data: defs } = await db
        .from('sport_metric_definitions')
        .select('metric_key')
        .eq('sport_category_id', cat)
        .eq('required', true)
        .in('metric_key', ['rpe_borg', 'task_comprehension', 'self_effort_pct', 'satisfaction']);
      requeridas = ((defs ?? []) as { metric_key: string }[]).map((d) => d.metric_key);
    }
    return { sessionId: s.id, sessionDate: s.session_date, equipo: uno(s.teams)?.name ?? null, requeridas, fichaId };
  }
  return null;
}

export function useAutoevalPendiente(userId: string | undefined) {
  const fichas = useFichasLoader(userId);
  return useQuery({
    queryKey: autoevalKey(userId),
    queryFn: async () => cargarAutoevalPendiente(userId!, new Date(), await fichas()),
    enabled: !!userId,
    retry: 1,
  });
}

/**
 * Mismo envío que PostTrainingSelfEvalPage: submit_post_training_self_eval con
 * p_user_id, o con p_unregistered_athlete_id cuando la sesión es de su ficha.
 * Sin ficha no se manda el parámetro nuevo (sirve también antes de la migración).
 */
export async function enviarRpeRapido(sessionId: string, userId: string, rpe: number, fichaId: string | null = null): Promise<void> {
  const { error } = await db.rpc(
    'submit_post_training_self_eval',
    fichaId
      ? { p_session_id: sessionId, p_child_id: null, p_user_id: null, p_answers: { rpe_borg: rpe }, p_unregistered_athlete_id: fichaId }
      : { p_session_id: sessionId, p_child_id: null, p_user_id: userId, p_answers: { rpe_borg: rpe } },
  );
  if (error) throw error;
}

/** Formulario completo de la autoevaluación (con `?ficha=` cuando responde por su ficha). */
export const formularioAutoeval = (pend: Pick<AutoevalPendiente, 'sessionId' | 'fichaId'>): string =>
  `/post-entreno/${pend.sessionId}${pend.fichaId ? `?ficha=${encodeURIComponent(pend.fichaId)}` : ''}`;

// ── Torneos abiertos (misma fuente que OpenTournamentsCard) ─────────────────

/**
 * Torneos/ligas internas ABIERTAS en sus escuelas: GET /tournaments/my-open-tournaments
 * (getMyOpenTournaments, lo mismo que OpenTournamentsCard). Es un dato
 * secundario: si falla, no se pinta nada (igual que la tarjeta clásica).
 */
export function useTorneosAbiertos(userId: string | undefined) {
  return useQuery({
    queryKey: ['athlete-v2-torneos-abiertos', userId],
    queryFn: async (): Promise<OpenTournament[]> => {
      try {
        return (await getMyOpenTournaments()) ?? [];
      } catch (e) {
        console.warn('[deportista-v2] my-open-tournaments', e);
        return [];
      }
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  });
}

// ── Plan del mes ─────────────────────────────────────────────────────────────

export interface PlanDelMes {
  teamId: string;
  objetivo: string;
  desde: string;
  hasta: string;
}

/**
 * Mesociclo vigente de sus equipos. Hoy la RLS de `training_mesocycles` es solo
 * de staff: el deportista recibe 0 filas y la pestaña se oculta. Si mañana se
 * abre la lectura, aparece sola.
 */
export function usePlanDelMes(teamIds: string[]) {
  return useQuery({
    queryKey: ['athlete-v2-plan', teamIds],
    queryFn: async (): Promise<PlanDelMes[]> => {
      const hoy = new Date().toISOString().slice(0, 10);
      const { data, error } = await db
        .from('training_mesocycles')
        .select('team_id, general_objective, starts_on, ends_on')
        .in('team_id', teamIds)
        .lte('starts_on', hoy)
        .gte('ends_on', hoy);
      if (error) return [];
      return ((data ?? []) as { team_id: string; general_objective: string | null; starts_on: string; ends_on: string }[])
        .filter((m) => m.general_objective?.trim())
        .map((m) => ({ teamId: m.team_id, objetivo: m.general_objective!.trim(), desde: m.starts_on, hasta: m.ends_on }));
    },
    enabled: teamIds.length > 0,
    staleTime: 10 * 60 * 1000,
  });
}
