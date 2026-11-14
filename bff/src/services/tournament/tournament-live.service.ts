/**
 * Torneos en vivo — capa de datos sobre los motores puros (scoring / standings / fixtures).
 * Una sola vía para cambiar un marcador: `performMatchAction` (versión optimista + log + idempotencia
 * en una RPC transaccional). Todo lo demás (avance de llaves, fase final desde grupos, avisos) cuelga de ahí.
 */
import { createHash, randomBytes } from 'crypto';
import { supabase } from '../../config/supabase';
import {
  Action, ACTION_TYPES, ApplyResult, LiveState, MatchStatus, ScoringConfig, Side,
  applyAction, derive, emptyState, matchOutcome, presetKeyForSport, resolveConfig, SCORING_PRESETS, validateConfig,
} from './scoring.shared';
import { computeStandings, StandingRow } from './standings.shared';
import { FormatConfig, Format, generateFixtures, validateFormat } from './fixtures.shared';
import { onMatchActionApplied } from './tournament-follow.service';
import { eventPlayerStats, type PlayerStatLine } from './tournament-social.service';

// ── Utilidades ───────────────────────────────────────────────────────────────

/** Interruptor de emergencia global: apaga lo «en vivo» en todos los torneos sin desplegar. */
export const liveGloballyDisabled = () => process.env.TOURNAMENT_LIVE_DISABLED === 'true';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const FINISHED: MatchStatus[] = ['played', 'walkover'];
const isFinished = (s: string) => s === 'played' || s === 'walkover';
/** Un anotador distinto necesita «tomar» el partido si el anterior actuó hace menos de esto. */
const SCORER_LOCK_MS = 10 * 60 * 1000;

export class LiveError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) { super(message); }
}

export function refLabel(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const g = /^G(\d+):([A-Z])$/.exec(ref);
  if (g) return `${g[1]}.º Grupo ${g[2]}`;
  const l = /^L:(\d+):(\d+)$/.exec(ref);
  if (l) return `Perdedor partido ${l[2]} de la ronda ${l[1]}`;
  return null;
}

// ── Carga ────────────────────────────────────────────────────────────────────

const MATCH_COLS = 'id, event_id, category_id, stage, group_label, cup_label, round, slot, home_team_id, away_team_id, home_ref, away_ref, '
  + 'home_score, away_score, status, scheduled_at, court, version, live_state, scorer_ref, scorer_label, started_at, finished_at, updated_at, '
  + 'home:home_team_id(team_name), away:away_team_id(team_name)';

export interface LiveEvent {
  id: string; title: string; sport: string | null; slug: string | null; city: string | null; event_date: string | null;
  school_id: string | null; visibility: string | null; competition_format: string | null;
  /** Quién creó el torneo: el organizador es la escuela dueña con creator_role = 'school' (tournament-access.ts). */
  creator_role?: string | null;
  live_enabled: boolean; scoring_config: any; format_config: any; stream_url: string | null;
  school?: { name: string | null } | null;
  /** Identidad pública (payload v2). Opcionales: eventos viejos o tests sin estas columnas. */
  status?: string | null; end_date?: string | null; banner_url?: string | null; logo_url?: string | null;
  rules_url?: string | null; venue_name?: string | null; venue_maps_url?: string | null; organizer_name?: string | null;
  address?: string | null; lat?: number | null; lng?: number | null;
}

const EVENT_COLS = 'id, title, sport, slug, city, event_date, school_id, creator_role, visibility, competition_format, live_enabled, scoring_config, format_config, stream_url, '
  + 'status, end_date, banner_url, logo_url, rules_url, venue_name, venue_maps_url, organizer_name, address, lat, lng, school:school_id(name)';

// Columnas previas a la migración 20261027180825. Si el BFF se despliega antes de aplicarla, las lecturas
// caen a estas en vez de romper (PostgREST responde 42703 / PGRST204 por columna inexistente).
const EVENT_COLS_V1 = 'id, title, sport, slug, city, event_date, school_id, creator_role, visibility, competition_format, live_enabled, scoring_config, format_config, stream_url, school:school_id(name)';
const MATCH_COLS_V1 = 'id, event_id, category_id, stage, group_label, round, slot, home_team_id, away_team_id, home_ref, away_ref, '
  + 'home_score, away_score, status, scheduled_at, court, version, live_state, scorer_ref, scorer_label, started_at, finished_at, updated_at, '
  + 'home:home_team_id(team_name), away:away_team_id(team_name)';
const TEAM_COLS_V1 = 'id, team_name, category_id, status';

export const isMissingColumn = (error: any) => !!error && (error.code === '42703' || error.code === 'PGRST204'
  || /column .* does not exist|could not find .* column/i.test(String(error.message ?? '')));

/** Ejecuta la consulta con las columnas nuevas y, si la base aún no las tiene, con las de antes. */
async function selectCompat<T>(run: (cols: string) => PromiseLike<{ data: any; error: any }>, cols: string, legacy: string): Promise<T | null> {
  const first = await run(cols);
  if (!isMissingColumn(first.error)) return (first.data as T) ?? null;
  const second = await run(legacy);
  return (second.data as T) ?? null;
}

export async function loadEvent(eventId: string): Promise<LiveEvent | null> {
  return selectCompat<LiveEvent>((c) => supabase.from('events').select(c).eq('id', eventId).maybeSingle(), EVENT_COLS, EVENT_COLS_V1);
}

export const liveEffective = (ev: Pick<LiveEvent, 'live_enabled'>) => !!ev.live_enabled && !liveGloballyDisabled();

export interface MatchRow {
  id: string; event_id: string; category_id: string | null; stage: string; group_label: string | null; cup_label?: string | null; round: number; slot: number;
  home_team_id: string | null; away_team_id: string | null; home_ref: string | null; away_ref: string | null;
  home_score: number | null; away_score: number | null; status: MatchStatus; scheduled_at: string | null; court: string | null;
  version: number; live_state: any; scorer_ref: string | null; scorer_label: string | null;
  started_at: string | null; finished_at: string | null; updated_at: string | null;
  home?: { team_name: string } | null; away?: { team_name: string } | null;
}

export async function loadMatch(eventId: string, matchId: string): Promise<MatchRow | null> {
  return selectCompat<MatchRow>((c) => supabase.from('tournament_matches').select(c).eq('id', matchId).eq('event_id', eventId).maybeSingle(), MATCH_COLS, MATCH_COLS_V1);
}

export async function loadMatches(eventId: string, categoryId?: string | null): Promise<MatchRow[]> {
  const run = (c: string) => {
    let q = supabase.from('tournament_matches').select(c).eq('event_id', eventId).order('stage').order('round').order('slot');
    if (categoryId) q = q.eq('category_id', categoryId);
    return q;
  };
  return (await selectCompat<MatchRow[]>(run, MATCH_COLS, MATCH_COLS_V1)) ?? [];
}

// ── DTO ──────────────────────────────────────────────────────────────────────

export function stateOf(m: Pick<MatchRow, 'status' | 'live_state' | 'home_score' | 'away_score'>, cfg: ScoringConfig): LiveState {
  const ls = m.live_state;
  if (ls && typeof ls === 'object' && typeof ls.points === 'string') {
    const st: LiveState = { status: m.status, points: ls.points, walkover: (ls.walkover as Side | null) ?? null };
    if (ls.detail && typeof ls.detail === 'object') st.detail = ls.detail;
    return st;
  }
  // Partido anterior al motor: si es de goles reconstruimos la secuencia desde el marcador.
  if (cfg.model === 'goals' && (m.home_score != null || m.away_score != null)) {
    return { status: m.status, points: 'h'.repeat(Math.max(0, Number(m.home_score ?? 0))) + 'a'.repeat(Math.max(0, Number(m.away_score ?? 0))), walkover: null };
  }
  return { ...emptyState(m.status), status: m.status };
}

export function isByeRow(m: Pick<MatchRow, 'stage' | 'home_team_id' | 'away_team_id' | 'home_ref' | 'away_ref'>): boolean {
  return m.stage === 'knockout' && ((!m.home_team_id && !m.home_ref) || (!m.away_team_id && !m.away_ref));
}

export function toMatchDto(m: MatchRow, cfg: ScoringConfig, opts: { pub?: boolean } = {}) {
  const st = stateOf(m, cfg);
  const sets = cfg.model === 'sets' && m.live_state ? derive(st, cfg).sets : [];
  const base = {
    id: m.id, category_id: m.category_id, stage: m.stage, group_label: m.group_label, cup_label: m.cup_label ?? null, round: m.round, slot: m.slot,
    home_team_id: m.home_team_id, away_team_id: m.away_team_id,
    home_name: m.home?.team_name ?? null, away_name: m.away?.team_name ?? null,
    home_label: m.home_team_id ? null : refLabel(m.home_ref), away_label: m.away_team_id ? null : refLabel(m.away_ref),
    is_bye: isByeRow(m),
    home_score: m.home_score, away_score: m.away_score, status: m.status,
    scheduled_at: m.scheduled_at, court: m.court, started_at: m.started_at, finished_at: m.finished_at,
    sets, model: cfg.model,
  };
  if (opts.pub) return base;
  return { ...base, version: m.version, live_state: m.live_state ?? null, scorer_label: m.scorer_label, config: cfg };
}

// ── Avance de llaves ─────────────────────────────────────────────────────────

interface AdvancePlan { updates: Array<{ id: string; patch: Record<string, unknown> }> }

async function planAdvance(m: MatchRow, winnerTeam: string | null, loserTeam: string | null): Promise<AdvancePlan> {
  const plan: AdvancePlan = { updates: [] };
  if (m.stage !== 'knockout' || !m.category_id) return plan;

  const { data: sibs } = await supabase.from('tournament_matches')
    .select('id, stage, cup_label, round, slot, status, home_team_id, away_team_id, home_ref, away_ref')
    .eq('event_id', m.event_id).eq('category_id', m.category_id);
  // Cada copa (oro, plata…) es un cuadro aparte: el ganador solo avanza dentro de la suya.
  const cup = m.cup_label ?? null;
  const all = ((sibs ?? []) as any[]).filter((x) => (x.cup_label ?? null) === cup);

  const guard = (target: any, field: 'home_team_id' | 'away_team_id', value: string | null) => {
    if ((target[field] ?? null) === (value ?? null)) return;
    if (target.status !== 'scheduled') {
      throw new LiveError(422, 'siguiente_ronda_en_curso', 'El partido de la siguiente ronda ya empezó: no se puede cambiar este resultado.');
    }
    plan.updates.push({ id: target.id, patch: { [field]: value } });
  };

  const parent = all.find((x) => x.stage === 'knockout' && x.round === m.round + 1 && x.slot === Math.ceil(m.slot / 2));
  if (parent) guard(parent, m.slot % 2 === 1 ? 'home_team_id' : 'away_team_id', winnerTeam);

  const ref = `L:${m.round}:${m.slot}`;
  const third = all.find((x) => x.stage === 'third_place' && (x.home_ref === ref || x.away_ref === ref));
  if (third) guard(third, third.home_ref === ref ? 'home_team_id' : 'away_team_id', loserTeam);

  return plan;
}

async function applyPlan(plan: AdvancePlan) {
  if (plan.updates.length === 0) return;
  // Filas distintas: en paralelo (un round-trip en vez de uno por partido).
  const now = new Date().toISOString();
  const res = await Promise.all(plan.updates.map((u) => supabase.from('tournament_matches').update({ ...u.patch, updated_at: now }).eq('id', u.id)));
  for (const r of res as Array<{ error?: { message?: string } | null }>) {
    if (r?.error) console.error('[tournament-live] avance de llave:', r.error.message);
  }
}

/** Rondas con un solo equipo y el otro lado sin referencia (bye): avanzan solas. */
export async function advanceByes(eventId: string, categoryId: string): Promise<void> {
  const { data } = await supabase.from('tournament_matches')
    .select(MATCH_COLS).eq('event_id', eventId).eq('category_id', categoryId).eq('stage', 'knockout').eq('round', 1);
  for (const m of ((data ?? []) as unknown as MatchRow[])) {
    if (m.status !== 'scheduled') continue;
    const homeBye = !m.home_team_id && !m.home_ref;
    const awayBye = !m.away_team_id && !m.away_ref;
    const winnerSide: Side | null = m.home_team_id && awayBye ? 'home' : m.away_team_id && homeBye ? 'away' : null;
    if (!winnerSide) continue;
    await supabase.from('tournament_matches')
      .update({ status: 'walkover', home_score: winnerSide === 'home' ? 1 : 0, away_score: winnerSide === 'away' ? 1 : 0, updated_at: new Date().toISOString() })
      .eq('id', m.id);
    const plan = await planAdvance({ ...m, status: 'walkover' }, winnerSide === 'home' ? m.home_team_id : m.away_team_id, null);
    await applyPlan(plan);
  }
}

// ── Grupos → fase final ──────────────────────────────────────────────────────

export interface CategoryStandings {
  model: 'goals' | 'sets';
  standings: StandingRow[];
  groups?: Record<string, StandingRow[]>;
}

export function standingsFor(
  teams: Array<{ id: string; team_name: string }>, matches: MatchRow[], cfg: ScoringConfig,
): CategoryStandings {
  const groupMatches = matches.filter((m) => m.stage === 'group');
  if (groupMatches.length === 0) {
    return { model: cfg.model, standings: computeStandings(teams, matches.filter((m) => m.stage !== 'third_place'), cfg) };
  }
  const byLabel = new Map<string, Set<string>>();
  for (const m of groupMatches) {
    const s = byLabel.get(m.group_label ?? '?') ?? new Set<string>();
    if (m.home_team_id) s.add(m.home_team_id);
    if (m.away_team_id) s.add(m.away_team_id);
    byLabel.set(m.group_label ?? '?', s);
  }
  const groups: Record<string, StandingRow[]> = {};
  [...byLabel.keys()].sort().forEach((label) => {
    const ids = byLabel.get(label)!;
    groups[label] = computeStandings(teams.filter((t) => ids.has(t.id)), groupMatches.filter((m) => m.group_label === label), cfg);
  });
  return { model: cfg.model, standings: [], groups };
}

export interface TeamRow {
  id: string; team_name: string; category_id: string | null; is_external?: boolean | null;
  club_name?: string | null; short_name?: string | null; logo_url?: string | null; status?: string;
  delegation?: { school?: { name: string | null } | null } | null;
}

const TEAM_COLS = 'id, team_name, category_id, is_external, club_name, short_name, logo_url, status, delegation:delegation_id(school:school_id(name))';

/** Internos (por delegación) y externos (solo nombre) entran igual al sorteo, al calendario y a la tabla. */
export async function loadTeams(eventId: string, categoryId?: string | null): Promise<TeamRow[]> {
  const run = (c: string) => {
    let q = supabase.from('event_teams').select(c).eq('event_id', eventId).neq('status', 'rejected');
    if (categoryId) q = q.eq('category_id', categoryId);
    return q;
  };
  const rows = (await selectCompat<TeamRow[]>(run, TEAM_COLS, TEAM_COLS_V1)) ?? [];
  return rows.slice().sort((a, b) => a.team_name.localeCompare(b.team_name, 'es'));
}

export function toTeamDto(t: TeamRow) {
  return {
    id: t.id, name: t.team_name, category_id: t.category_id, short_name: t.short_name ?? null, logo_url: t.logo_url ?? null,
    is_external: !!t.is_external, club_name: t.club_name ?? t.delegation?.school?.name ?? null,
  };
}

/**
 * Cuando TODOS los partidos de grupo de la categoría terminaron, llena los cruces de la fase final
 * (1.º A vs 2.º B…). Si luego se corrige un partido de grupo, vuelve a calcular mientras la fase final
 * no haya empezado; si ya empezó, avisa en vez de cambiar los cruces por debajo.
 */
export async function resolveGroupKnockout(ev: LiveEvent, categoryId: string): Promise<{ resolved: boolean }> {
  const matches = await loadMatches(ev.id, categoryId);
  const groupMatches = matches.filter((m) => m.stage === 'group');
  const koMatches = matches.filter((m) => m.stage === 'knockout' || m.stage === 'third_place');
  if (groupMatches.length === 0 || koMatches.length === 0) return { resolved: false };

  const allDone = groupMatches.every((m) => isFinished(m.status) || m.status === 'cancelled');
  const cfg = resolveConfig(ev.scoring_config, categoryId);
  const teams = await loadTeams(ev.id, categoryId);

  const refMap = new Map<string, string>();
  if (allDone) {
    const { groups } = standingsFor(teams, matches, cfg);
    for (const [label, rows] of Object.entries(groups ?? {})) rows.forEach((r, i) => refMap.set(`G${i + 1}:${label}`, r.team_id));
  }

  const touched = koMatches.filter((m) => m.home_ref?.startsWith('G') || m.away_ref?.startsWith('G'));
  const started = koMatches.some((m) => m.status !== 'scheduled' && !(m.status === 'walkover' && isByeRow(m)));
  const wouldChange = touched.some((m) => (m.home_ref?.startsWith('G') && (m.home_team_id ?? null) !== (refMap.get(m.home_ref) ?? null))
    || (m.away_ref?.startsWith('G') && (m.away_team_id ?? null) !== (refMap.get(m.away_ref!) ?? null)));
  if (!wouldChange) return { resolved: allDone };
  if (started) throw new LiveError(422, 'fase_final_en_curso', 'La fase final ya empezó: no se pueden cambiar los clasificados de los grupos.');

  // Se limpia todo lo que dependía de los cruces anteriores y se vuelve a llenar.
  const r1ids = koMatches.filter((m) => m.stage === 'knockout' && m.round === 1).map((m) => m.id);
  const writes: PromiseLike<unknown>[] = [];
  for (const m of koMatches) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (m.home_ref?.startsWith('G')) patch.home_team_id = refMap.get(m.home_ref) ?? null;
    if (m.away_ref?.startsWith('G')) patch.away_team_id = refMap.get(m.away_ref) ?? null;
    if (m.stage === 'knockout' && m.round > 1) { patch.home_team_id = null; patch.away_team_id = null; }
    if (m.stage === 'third_place') { patch.home_team_id = null; patch.away_team_id = null; }
    if (m.status === 'walkover' && isByeRow(m)) { patch.status = 'scheduled'; patch.home_score = null; patch.away_score = null; }
    writes.push(supabase.from('tournament_matches').update(patch).eq('id', m.id));
  }
  // Una fila por partido de la fase final, todas distintas: en paralelo en vez de N round-trips seguidos.
  await Promise.all(writes);
  if (allDone && r1ids.length) await advanceByes(ev.id, categoryId);
  return { resolved: allDone };
}

// ── Acción única sobre un partido ────────────────────────────────────────────

export interface Actor { type: 'user' | 'scorekeeper'; id: string; label: string }

export interface ActionInput { action: Action; client_action_id?: string | null; expected_version?: number | null }

const LIVE_FREE_ACTIONS = new Set(['correct', 'walkover', 'cancel']);

export function validateAction(a: any): Action {
  if (!a || typeof a !== 'object' || !ACTION_TYPES.includes(a.type)) throw new LiveError(400, 'accion_invalida', 'Acción inválida');
  return a as Action;
}

/** Lo que se lee antes de aplicar una acción: el partido y si ese client_action_id ya se aplicó. */
export interface ActionPreload { match: MatchRow | null; duplicate: boolean }

/**
 * Lecturas previas a una acción, las dos en paralelo (un round-trip). Las rutas la lanzan a la vez que
 * la autorización: desde Render cada round-trip a la base cuesta ~250 ms y el anotador lo siente en
 * cada punto (B9). Con `eventId` null (anotador sin cuenta: el torneo sale del token) se lee por id y
 * `performMatchAction` descarta el partido si no es del torneo.
 */
export async function preloadMatchAction(eventId: string | null, matchId: string, clientActionId?: string | null): Promise<ActionPreload> {
  const [match, duplicate] = await Promise.all([
    selectCompat<MatchRow>((c) => {
      let q = supabase.from('tournament_matches').select(c).eq('id', matchId);
      if (eventId) q = q.eq('event_id', eventId);
      return q.maybeSingle();
    }, MATCH_COLS, MATCH_COLS_V1),
    clientActionId
      ? Promise.resolve(supabase.from('tournament_match_log').select('id').eq('match_id', matchId).eq('client_action_id', clientActionId).maybeSingle())
        .then((r) => !!r.data)
      : Promise.resolve(false),
  ]);
  return { match, duplicate };
}

/**
 * Camino crítico (lo que espera el anotador): [lecturas previas] → RPC → respuesta. El Broadcast sale
 * apenas la RPC confirma; avance de llaves, fase final y avisos van después y nunca lo retrasan.
 */
export async function performMatchAction(ev: LiveEvent, matchId: string, actor: Actor, input: ActionInput, pre?: ActionPreload) {
  const action = validateAction(input.action);
  const loaded = pre ?? await preloadMatchAction(ev.id, matchId, input.client_action_id);
  const match = loaded.match && loaded.match.event_id === ev.id ? loaded.match : null;
  if (!match) throw new LiveError(404, 'partido_no_encontrado', 'Partido no encontrado');

  const cfg = resolveConfig(ev.scoring_config, match.category_id);
  const dto = () => toMatchDto(match, cfg);

  // Marcador en vivo apagado: solo se permite cargar el resultado final a mano (como antes).
  if (!liveEffective(ev) && !(LIVE_FREE_ACTIONS.has(action.type) && match.status === 'scheduled') && !(action.type === 'correct' && isFinished(match.status))) {
    throw new LiveError(403, 'live_disabled', liveGloballyDisabled()
      ? 'El marcador en vivo está apagado temporalmente.' : 'Este torneo no tiene el marcador en vivo encendido.');
  }

  if (!match.home_team_id || !match.away_team_id) {
    throw new LiveError(422, 'equipos_sin_definir', 'Este partido aún no tiene los dos equipos definidos.');
  }

  // Idempotencia: un reintento con el mismo client_action_id no se aplica dos veces (la RPC lo vuelve a comprobar).
  if (input.client_action_id && loaded.duplicate) return { duplicate: true, match: dto() };

  // Un anotador activo por partido.
  const actorRef = `${actor.type === 'user' ? 'u' : 's'}:${actor.id}`;
  if (match.status === 'live' && match.scorer_ref && match.scorer_ref !== actorRef && match.updated_at
    && Date.now() - Date.parse(match.updated_at) < SCORER_LOCK_MS) {
    throw new LiveError(409, 'otro_anotador', `${match.scorer_label ?? 'Otro anotador'} está anotando este partido. Tómalo para continuar.`, { match: dto() });
  }

  const before = stateOf(match, cfg);
  const knockout = match.stage === 'knockout' || match.stage === 'third_place';
  const result: ApplyResult = applyAction(before, action, cfg, { knockout });
  if (!result.ok) throw new LiveError(422, result.code, result.message);

  const next = result.state;
  const d = result.derived;
  const nowIso = new Date().toISOString();
  const becameFinished = isFinished(next.status) && !isFinished(match.status);
  const startedAt = action.type === 'start' ? nowIso : match.started_at;
  const finishedAt = isFinished(next.status) ? (isFinished(match.status) ? match.finished_at ?? nowIso : nowIso) : null;

  // Llaves: antes de guardar, comprobar que el cambio no pisa una ronda que ya empezó.
  let plan: AdvancePlan = { updates: [] };
  if (knockout && (isFinished(next.status) || isFinished(match.status))) {
    const winnerTeam = isFinished(next.status) && d.winner ? (d.winner === 'home' ? match.home_team_id : match.away_team_id) : null;
    const loserTeam = isFinished(next.status) && d.winner ? (d.winner === 'home' ? match.away_team_id : match.home_team_id) : null;
    plan = await planAdvance(match, winnerTeam, loserTeam);
  }

  const expected = input.expected_version ?? match.version;
  const liveState = { status: next.status, points: next.points, walkover: next.walkover ?? null, ...(next.detail ? { detail: next.detail } : {}) };
  const { data: rpc, error } = await supabase.rpc('apply_tournament_match_action', {
    p_match_id: matchId, p_expected_version: expected, p_status: next.status,
    p_live_state: liveState,
    p_home_score: d.homeScore, p_away_score: d.awayScore,
    p_started_at: startedAt, p_finished_at: finishedAt,
    p_scorer_ref: actorRef, p_scorer_label: actor.label,
    p_actor_type: actor.type, p_actor_id: actor.id, p_action: action.type,
    p_client_action_id: input.client_action_id ?? null,
    p_before: before, p_after: { status: next.status, points: next.points, walkover: next.walkover ?? null, ...(next.detail ? { detail: next.detail } : {}), home: d.homeScore, away: d.awayScore },
  });
  if (error) throw new LiveError(500, 'error_guardando', 'No se pudo guardar la acción');
  const out = rpc as { ok?: boolean; duplicate?: boolean; error?: string; version?: number };
  if (out?.error === 'version_conflict') {
    const fresh = await loadMatch(ev.id, matchId);
    throw new LiveError(409, 'version_conflict', 'El partido cambió mientras anotabas. Se cargó la versión actual.', { match: fresh ? toMatchDto(fresh, cfg) : dto() });
  }
  if (out?.error === 'not_found') throw new LiveError(404, 'partido_no_encontrado', 'Partido no encontrado');

  if (out?.duplicate) {
    const again = await loadMatch(ev.id, matchId);
    return { duplicate: true, match: again ? toMatchDto(again, cfg) : dto() };
  }

  // Lo guardado es exactamente lo que se mandó a la RPC + la versión que devolvió: se arma aquí en vez
  // de releer el partido (un round-trip menos por punto). Sin versión en la respuesta, se relee.
  const fresh: MatchRow | null = typeof out?.version === 'number'
    ? {
      ...match, status: next.status, live_state: liveState, home_score: d.homeScore, away_score: d.awayScore,
      started_at: startedAt, finished_at: finishedAt, scorer_ref: actorRef, scorer_label: actor.label, version: out.version, updated_at: nowIso,
    }
    : await loadMatch(ev.id, matchId);
  const freshDto = fresh ? toMatchDto(fresh, cfg) : dto();

  // Terminar, reabrir o corregir un partido terminado cambia la tabla y la llave: la caché pública de ese
  // torneo se descarta YA (y otra vez tras el avance), así el refresco que dispara el Broadcast la ve al día.
  const affectsStandings = isFinished(next.status) || isFinished(match.status);
  if (affectsStandings) invalidatePublicLive(ev.slug);

  // Tiempo real (Broadcast `tlive:<slug>`) + avisos a quien sigue el torneo, apenas la acción quedó
  // guardada y ANTES de los efectos secundarios. No espera la red y nunca lanza. (agente «vivo»)
  if (fresh) onMatchActionApplied({ id: ev.id, title: ev.title, slug: ev.slug, live: liveEffective(ev) }, match.status, freshDto as any, action.type);

  await applyPlan(plan);

  let warning: string | undefined;
  if (match.stage === 'group' && match.category_id && affectsStandings) {
    try { await resolveGroupKnockout(ev, match.category_id); }
    catch (e: any) {
      if (e instanceof LiveError) warning = e.message; // el marcador ya quedó guardado; los cruces no se tocan
      else console.error('[tournament-live] resolviendo fase final:', e?.message);
    }
  }
  if (affectsStandings && (plan.updates.length > 0 || match.stage === 'group')) invalidatePublicLive(ev.slug);

  if (becameFinished) {
    notifyMatchFinished(ev, match, d.homeScore, d.awayScore, cfg)
      .catch((e: any) => console.error('[tournament-live] aviso de resultado:', e?.message));
  }
  return { duplicate: false, match: freshDto, ...(warning ? { warning } : {}) };
}

/** «Tomar» el partido: el anotador actual pasa a ser quien lo toma. */
export async function takeMatch(ev: LiveEvent, matchId: string, actor: Actor) {
  const match = await loadMatch(ev.id, matchId);
  if (!match) throw new LiveError(404, 'partido_no_encontrado', 'Partido no encontrado');
  await supabase.from('tournament_matches').update({
    scorer_ref: `${actor.type === 'user' ? 'u' : 's'}:${actor.id}`, scorer_label: actor.label,
    scorer_taken_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', matchId);
  return { ok: true };
}

// ── Avisos (solo resultado final; nunca punto a punto) ───────────────────────

async function notifyMatchFinished(ev: LiveEvent, m: MatchRow, hs: number, as: number, cfg: ScoringConfig) {
  const teamIds = [m.home_team_id, m.away_team_id].filter(Boolean) as string[];
  if (teamIds.length === 0) return;
  const { data: members } = await supabase.from('event_team_members').select('profile_id, child_id, children:child_id(parent_id)').in('team_id', teamIds);
  const ids = Array.from(new Set((members ?? []).map((x: any) => x.profile_id || x.children?.parent_id).filter(Boolean)));
  if (ids.length === 0) return;
  const unit = cfg.model === 'sets' ? ' en sets' : '';
  const link = ev.slug && liveEffective(ev) ? `/torneo/${ev.slug}/en-vivo` : `/tournaments/${ev.id}/results`;
  await supabase.from('notifications').insert(ids.map((user_id) => ({
    user_id, title: '📣 Resultado del partido', message: `${m.home?.team_name ?? 'Local'} ${hs} - ${as} ${m.away?.team_name ?? 'Visitante'}${unit}. Ya puedes verlo y compartirlo.`,
    type: 'info', category: 'tournament', link, data: { eventId: ev.id, matchId: m.id },
  })));
}

// ── Calendario ───────────────────────────────────────────────────────────────

export async function generateCategoryFixtures(ev: LiveEvent, categoryId: string, format: Format, cfg: FormatConfig) {
  if (!['liga', 'copa', 'grupos'].includes(format)) throw new LiveError(400, 'formato_invalido', 'Formato inválido: liga, copa o grupos');
  const teams = await loadTeams(ev.id, categoryId);
  const ids = teams.map((t) => t.id);
  const err = validateFormat(format, ids.length, cfg ?? {});
  if (err) throw new LiveError(400, 'config_invalida', err);

  const existing = await loadMatches(ev.id, categoryId);
  const blocking = existing.filter((m) => m.status !== 'scheduled' && !(m.status === 'walkover' && isByeRow(m)));
  if (blocking.length > 0) {
    throw new LiveError(409, 'hay_partidos_jugados', 'Ya hay partidos jugados o en juego en esta categoría: no se puede regenerar el calendario.');
  }

  let gen;
  try { gen = generateFixtures(format, ids, cfg ?? {}); }
  catch (e: any) { throw new LiveError(400, 'config_invalida', e?.message ?? 'Configuración inválida'); }

  if (existing.length) await supabase.from('tournament_matches').delete().in('id', existing.map((m) => m.id));
  const rows = gen.rows.map((r) => ({
    event_id: ev.id, category_id: categoryId, status: 'scheduled', stage: r.stage, group_label: r.group_label, cup_label: r.cup_label ?? null,
    round: r.round, slot: r.slot, home_team_id: r.home_team_id, away_team_id: r.away_team_id,
    home_ref: r.home_ref, away_ref: r.away_ref, court: r.court, scheduled_at: r.scheduled_at,
  }));
  if (rows.length) {
    const { error } = await supabase.from('tournament_matches').insert(rows);
    if (error) throw new LiveError(500, 'error_generando', 'Error al generar el calendario');
  }
  await supabase.from('events').update({
    competition_format: format, format_config: { ...cfg, seed: gen.seed }, updated_at: new Date().toISOString(),
  }).eq('id', ev.id);
  if (format !== 'liga') await advanceByes(ev.id, categoryId);
  return { matches: rows.length, format, seed: gen.seed, groups: gen.groups };
}

// ── Tabla ────────────────────────────────────────────────────────────────────

export async function buildCategoryStandings(ev: LiveEvent, categoryId?: string | null): Promise<CategoryStandings> {
  const [teams, matches] = await Promise.all([loadTeams(ev.id, categoryId), loadMatches(ev.id, categoryId)]);
  return standingsFor(teams, matches, resolveConfig(ev.scoring_config, categoryId));
}

// ── Configuración del torneo ─────────────────────────────────────────────────

export async function getConfig(ev: LiveEvent) {
  return {
    event: {
      id: ev.id, title: ev.title, sport: ev.sport, slug: ev.slug, competition_format: ev.competition_format,
      live_enabled: ev.live_enabled, scoring_config: ev.scoring_config ?? null, format_config: ev.format_config ?? null, stream_url: ev.stream_url,
    },
    presets: Object.entries(SCORING_PRESETS).map(([key, p]) => ({ key, label: p.label, config: p.config })),
    suggested_preset: presetKeyForSport(ev.sport),
    global_live_disabled: liveGloballyDisabled(),
  };
}

// Veo: el en vivo se comparte como enlace de app.veo.co / live.veo.co (no se incrusta).
const STREAM_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'facebook.com', 'www.facebook.com', 'fb.watch', 'vimeo.com', 'player.vimeo.com', 'veo.co', 'app.veo.co', 'live.veo.co'];

export function validateStreamUrl(url: unknown): string | null {
  if (url == null || url === '') return null;
  if (typeof url !== 'string' || url.length > 500) throw new LiveError(400, 'stream_invalido', 'El enlace de transmisión no es válido');
  let u: URL;
  try { u = new URL(url); } catch { throw new LiveError(400, 'stream_invalido', 'El enlace de transmisión no es válido'); }
  if (u.protocol !== 'https:' || !STREAM_HOSTS.includes(u.hostname.toLowerCase())) {
    throw new LiveError(400, 'stream_invalido', 'Solo se admiten enlaces https de YouTube, Facebook, Vimeo o Veo');
  }
  return u.toString();
}

export async function patchConfig(ev: LiveEvent, body: Record<string, any>) {
  const patch: Record<string, unknown> = {};
  if ('live_enabled' in body) {
    if (typeof body.live_enabled !== 'boolean') throw new LiveError(400, 'invalido', 'live_enabled debe ser true o false');
    patch.live_enabled = body.live_enabled;
  }
  if (body.preset != null) {
    const p = SCORING_PRESETS[String(body.preset)];
    if (!p) throw new LiveError(400, 'preset_invalido', 'Plantilla de marcador desconocida');
    patch.scoring_config = p.config.model ? { ...p.config } : { model: 'goals', ...p.config };
    // Cambiar la plantilla del torneo no borra las reglas que ya tenga cada categoría.
    const byCat = ev.scoring_config?.by_category;
    if (byCat && typeof byCat === 'object' && Object.keys(byCat).length) (patch.scoring_config as any).by_category = byCat;
  } else if ('scoring_config' in body) {
    const bad = validateConfig(body.scoring_config);
    if (bad) throw new LiveError(400, 'config_invalida', bad);
    patch.scoring_config = body.scoring_config ?? null;
  }
  if ('stream_url' in body) patch.stream_url = validateStreamUrl(body.stream_url);
  if (Object.keys(patch).length === 0) throw new LiveError(400, 'nada', 'No hay nada que guardar');

  // No se cambian las reglas de marcador con partidos ya en juego o jugados con otro modelo.
  if (patch.scoring_config !== undefined) {
    const matches = await loadMatches(ev.id);
    const hasScore = (m: MatchRow) => m.status === 'live' || (isFinished(m.status) && m.live_state && typeof m.live_state.points === 'string' && m.live_state.points.length > 0);
    // Se compara por categoría: una regla por categoría (by_category) tampoco puede cambiar goles ↔ sets con marcador.
    const changed = matches.some((m) => hasScore(m)
      && resolveConfig(patch.scoring_config as any, m.category_id).model !== resolveConfig(ev.scoring_config, m.category_id).model);
    if (changed) throw new LiveError(409, 'modelo_en_uso', 'Ya hay partidos con marcador: no se puede cambiar el modelo (goles/sets).');
    if (matches.some((m) => m.status === 'live')) throw new LiveError(409, 'partidos_en_juego', 'Hay partidos en juego: cambia las reglas cuando terminen.');
  }
  patch.updated_at = new Date().toISOString();
  const { error } = await supabase.from('events').update(patch).eq('id', ev.id);
  if (error) throw new LiveError(500, 'error_guardando', 'No se pudo guardar la configuración');
  publicCache.clear();
  return { success: true };
}

// ── Anotadores sin cuenta ────────────────────────────────────────────────────

export async function createScorekeeper(ev: LiveEvent, createdBy: string, body: { label?: string; court?: string | null; expires_hours?: number }, origin: string) {
  const label = String(body.label ?? '').trim().slice(0, 60);
  if (!label) throw new LiveError(400, 'label_requerido', 'Ponle un nombre al enlace (ej. «Mesa cancha 1»)');
  let hours = Number(body.expires_hours);
  if (!Number.isFinite(hours) || hours <= 0) {
    // por defecto: hasta 24 h después del día del torneo
    const end = ev.event_date ? Date.parse(`${ev.event_date}T23:59:59-05:00`) + 24 * 3600_000 : 0;
    hours = end > Date.now() ? (end - Date.now()) / 3600_000 : 24;
  }
  hours = Math.min(Math.max(hours, 1), 24 * 30);
  const token = randomBytes(32).toString('base64url');
  const expires_at = new Date(Date.now() + hours * 3600_000).toISOString();
  const { data, error } = await supabase.from('tournament_scorekeepers').insert({
    event_id: ev.id, label, court: body.court ? String(body.court).slice(0, 40) : null,
    token_hash: hashToken(token), expires_at, created_by: createdBy,
  }).select('id').single();
  if (error || !data) throw new LiveError(500, 'error_guardando', 'No se pudo crear el enlace');
  return { id: (data as any).id as string, token, url: `${origin.replace(/\/$/, '')}/anotador/${token}`, expires_at };
}

export async function listScorekeepers(eventId: string) {
  const { data } = await supabase.from('tournament_scorekeepers')
    .select('id, label, court, expires_at, revoked_at, last_used_at').eq('event_id', eventId).order('created_at', { ascending: false });
  return data ?? [];
}

export async function revokeScorekeeper(eventId: string, id: string) {
  await supabase.from('tournament_scorekeepers').update({ revoked_at: new Date().toISOString() }).eq('id', id).eq('event_id', eventId);
  return { success: true };
}

export interface ScorekeeperAuth { id: string; label: string; court: string | null; event: LiveEvent }

export async function authScorekeeper(token: string): Promise<ScorekeeperAuth> {
  if (!token || token.length < 20 || token.length > 100) throw new LiveError(401, 'token_invalido', 'Enlace inválido');
  // Enlace + torneo en UNA lectura (embed por la FK event_id): el anotador la paga en cada punto.
  const sk = await selectCompat<any>((c) => supabase.from('tournament_scorekeepers')
    .select(`id, event_id, label, court, expires_at, revoked_at, event:event_id(${c})`).eq('token_hash', hashToken(token)).maybeSingle(), EVENT_COLS, EVENT_COLS_V1);
  if (!sk) throw new LiveError(401, 'token_invalido', 'Enlace inválido');
  if (sk.revoked_at) throw new LiveError(403, 'token_revocado', 'Este enlace fue revocado');
  if (Date.parse(sk.expires_at) < Date.now()) throw new LiveError(403, 'token_vencido', 'Este enlace venció');
  const embedded = sk.event && typeof sk.event === 'object' && sk.event.id === sk.event_id ? (sk.event as LiveEvent) : null;
  const ev = embedded ?? await loadEvent(sk.event_id);
  if (!ev) throw new LiveError(404, 'torneo_no_encontrado', 'Torneo no encontrado');
  return { id: sk.id, label: sk.label, court: sk.court, event: ev };
}

const lastTouch = new Map<string, number>();
const TOUCH_EVERY_MS = 60_000;

/** «Último uso» del enlace: como mucho una escritura por minuto por enlace (no una por punto: Disk IO). */
export async function touchScorekeeper(id: string, now = Date.now()) {
  if (now - (lastTouch.get(id) ?? -Infinity) < TOUCH_EVERY_MS) return;
  lastTouch.set(id, now);
  if (lastTouch.size > 2000) lastTouch.clear();
  await supabase.from('tournament_scorekeepers').update({ last_used_at: new Date(now).toISOString() }).eq('id', id);
}

export async function scorerMatches(sk: ScorekeeperAuth) {
  const all = await loadMatches(sk.event.id);
  const mine = all.filter((m) => !sk.court || !m.court || m.court === sk.court);
  const open = mine.filter((m) => !isFinished(m.status) && m.status !== 'cancelled' && m.home_team_id && m.away_team_id);
  const recent = mine.filter((m) => isFinished(m.status) && !isByeRow(m)).sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at))).slice(0, 10);
  return [...open, ...recent].map((m) => toMatchDto(m, resolveConfig(sk.event.scoring_config, m.category_id)));
}

/// ── Equipos: internos (delegación) y rivales externos (solo nombre) ─────────

const MAX_EXTERNAL_BATCH = 64;
const NAME_MAX = 80;

/** Imágenes: solo https y, si se conoce el proyecto, solo del storage de SportMaps (bucket school-assets). */
export function validateImageUrl(url: unknown, what = 'La imagen'): string | null {
  if (url == null || url === '') return null;
  if (typeof url !== 'string' || url.length > 500) throw new LiveError(400, 'imagen_invalida', `${what} no es válida`);
  let u: URL;
  try { u = new URL(url); } catch { throw new LiveError(400, 'imagen_invalida', `${what} no es válida`); }
  if (u.protocol !== 'https:') throw new LiveError(400, 'imagen_invalida', `${what} debe ser un enlace https`);
  let project: string | null = null;
  try { project = process.env.SUPABASE_URL ? new URL(String(process.env.SUPABASE_URL)).hostname : null; } catch { project = null; }
  if (project && u.hostname !== project) throw new LiveError(400, 'imagen_invalida', `${what} debe subirse desde SportMaps`);
  return u.toString();
}

/** Enlaces externos (sitio del patrocinador, reglamento, mapa): https, máximo 500. */
export function validateHttpsUrl(url: unknown, what = 'El enlace'): string | null {
  if (url == null || url === '') return null;
  if (typeof url !== 'string' || url.length > 500) throw new LiveError(400, 'enlace_invalido', `${what} no es válido`);
  let u: URL;
  try { u = new URL(url.trim()); } catch { throw new LiveError(400, 'enlace_invalido', `${what} no es válido`); }
  if (u.protocol !== 'https:') throw new LiveError(400, 'enlace_invalido', `${what} debe empezar por https://`);
  return u.toString();
}

export function cleanText(v: unknown, max: number, what: string): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') throw new LiveError(400, 'texto_invalido', `${what} no es válido`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length > max) throw new LiveError(400, 'texto_largo', `${what} puede tener máximo ${max} caracteres`);
  return t;
}

export function cleanShortName(v: unknown): string | null {
  const t = cleanText(v, 4, 'El nombre corto');
  return t ? t.toUpperCase() : null;
}

export async function listTeams(ev: LiveEvent) {
  const teams = await loadTeams(ev.id);
  return teams.map((t) => ({ ...toTeamDto(t), status: t.status ?? null }));
}

async function assertCategory(ev: LiveEvent, categoryId: unknown): Promise<string> {
  if (typeof categoryId !== 'string' || !categoryId) throw new LiveError(400, 'categoria_requerida', 'Elige la categoría');
  const { data } = await supabase.from('event_categories_config').select('id').eq('id', categoryId).eq('event_id', ev.id).maybeSingle();
  if (!data) throw new LiveError(404, 'categoria_no_encontrada', 'Categoría no encontrada en este torneo');
  return categoryId;
}

export interface ExternalTeamInput { team_name?: unknown; club_name?: unknown; short_name?: unknown; logo_url?: unknown }

/** Agrega uno o varios rivales externos (pegando una lista). Los repetidos en la categoría se saltan. */
export async function addExternalTeams(ev: LiveEvent, body: { category_id?: unknown; teams?: unknown }) {
  const categoryId = await assertCategory(ev, body.category_id);
  if (!Array.isArray(body.teams) || body.teams.length === 0) throw new LiveError(400, 'sin_equipos', 'Escribe al menos un nombre de equipo');
  if (body.teams.length > MAX_EXTERNAL_BATCH) throw new LiveError(400, 'demasiados', `Máximo ${MAX_EXTERNAL_BATCH} equipos por vez`);

  const existing = await loadTeams(ev.id, categoryId);
  const taken = new Set(existing.map((t) => t.team_name.trim().toLowerCase()));
  const rows: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  for (const raw of body.teams as ExternalTeamInput[]) {
    const name = cleanText(raw?.team_name, NAME_MAX, 'El nombre del equipo');
    if (!name) continue;
    const key = name.toLowerCase();
    if (taken.has(key)) { skipped.push(name); continue; }
    taken.add(key);
    rows.push({
      event_id: ev.id, category_id: categoryId, delegation_id: null, is_external: true, status: 'confirmed',
      team_name: name, club_name: cleanText(raw?.club_name, 120, 'El club'), short_name: cleanShortName(raw?.short_name),
      logo_url: validateImageUrl(raw?.logo_url, 'El logo'),
    });
  }
  if (rows.length === 0) {
    if (skipped.length) return { created: [], skipped };
    throw new LiveError(400, 'sin_equipos', 'Escribe al menos un nombre de equipo');
  }
  const { data, error } = await supabase.from('event_teams').insert(rows).select(TEAM_COLS);
  if (error) {
    if (String(error.code) === '23505') throw new LiveError(409, 'equipo_repetido', 'Uno de los equipos ya existe en la categoría');
    throw new LiveError(500, 'error_guardando', 'No se pudieron agregar los equipos');
  }
  publicCache.clear();
  return { created: ((data ?? []) as unknown as TeamRow[]).map(toTeamDto), skipped };
}

async function teamInMatches(ev: LiveEvent, teamId: string) {
  const matches = await loadMatches(ev.id);
  const mine = matches.filter((m) => m.home_team_id === teamId || m.away_team_id === teamId);
  return { any: mine.length > 0, started: mine.some((m) => m.status !== 'scheduled' && !(m.status === 'walkover' && isByeRow(m))) };
}

async function loadOneTeam(ev: LiveEvent, teamId: string): Promise<TeamRow> {
  const team = await selectCompat<TeamRow>((c) => supabase.from('event_teams').select(c).eq('id', teamId).eq('event_id', ev.id).maybeSingle(), TEAM_COLS, TEAM_COLS_V1);
  if (!team || team.status === 'rejected') throw new LiveError(404, 'equipo_no_encontrado', 'Equipo no encontrado');
  return team;
}

/** Internos: solo logo y nombre corto (el nombre viene de la inscripción). Externos: todo. */
export async function updateTeam(ev: LiveEvent, teamId: string, body: Record<string, unknown>) {
  const team = await loadOneTeam(ev, teamId);
  const patch: Record<string, unknown> = {};
  if ('logo_url' in body) patch.logo_url = validateImageUrl(body.logo_url, 'El logo');
  if ('short_name' in body) patch.short_name = cleanShortName(body.short_name);
  if (team.is_external) {
    if ('team_name' in body) {
      const name = cleanText(body.team_name, NAME_MAX, 'El nombre del equipo');
      if (!name) throw new LiveError(400, 'nombre_requerido', 'El equipo necesita un nombre');
      patch.team_name = name;
    }
    if ('club_name' in body) patch.club_name = cleanText(body.club_name, 120, 'El club');
    if ('category_id' in body && body.category_id !== team.category_id) {
      const cat = await assertCategory(ev, body.category_id);
      if ((await teamInMatches(ev, teamId)).any) throw new LiveError(409, 'equipo_en_calendario', 'El equipo ya está en el calendario: regenera el calendario sin él antes de cambiarlo de categoría.');
      patch.category_id = cat;
    }
  } else if ('team_name' in body || 'club_name' in body || 'category_id' in body) {
    throw new LiveError(400, 'equipo_interno', 'El nombre y la categoría de un equipo inscrito se cambian desde la inscripción');
  }
  if (Object.keys(patch).length === 0) throw new LiveError(400, 'nada', 'No hay nada que guardar');
  patch.updated_at = new Date().toISOString();
  const { error } = await supabase.from('event_teams').update(patch).eq('id', teamId).eq('event_id', ev.id);
  if (error) {
    if (String(error.code) === '23505') throw new LiveError(409, 'equipo_repetido', 'Ya hay un equipo con ese nombre en la categoría');
    throw new LiveError(500, 'error_guardando', 'No se pudo guardar el equipo');
  }
  publicCache.clear();
  return toTeamDto(await loadOneTeam(ev, teamId));
}

/** Solo rivales externos. Con partidos jugados o en juego no se borra (rompería resultados). */
export async function deleteExternalTeam(ev: LiveEvent, teamId: string) {
  const team = await loadOneTeam(ev, teamId);
  if (!team.is_external) throw new LiveError(400, 'equipo_interno', 'Solo se pueden quitar rivales externos; los inscritos se rechazan desde Inscritos');
  const usage = await teamInMatches(ev, teamId);
  if (usage.started) throw new LiveError(409, 'equipo_con_resultados', 'Este equipo ya tiene partidos jugados o en juego: no se puede quitar.');
  await supabase.from('event_teams').delete().eq('id', teamId).eq('event_id', ev.id);
  publicCache.clear();
  return { success: true, regenerate: usage.any };
}

// ── Patrocinadores ───────────────────────────────────────────────────────────

export const SPONSOR_TIERS = ['principal', 'oficial', 'aliado'] as const;
export type SponsorTier = typeof SPONSOR_TIERS[number];
const MAX_SPONSORS = 30;
const SPONSOR_COLS = 'id, name, logo_url, url, tier, sort_order';

export interface SponsorRow { id: string; name: string; logo_url: string | null; url: string | null; tier: SponsorTier; sort_order: number }

function sponsorPatch(body: Record<string, unknown>, creating: boolean) {
  const out: Record<string, unknown> = {};
  if (creating || 'name' in body) {
    const name = cleanText(body.name, 120, 'El nombre del patrocinador');
    if (!name) throw new LiveError(400, 'nombre_requerido', 'Escribe el nombre del patrocinador');
    out.name = name;
  }
  if ('logo_url' in body) out.logo_url = validateImageUrl(body.logo_url, 'El logo');
  if ('url' in body) out.url = validateHttpsUrl(body.url, 'El enlace del patrocinador');
  if (creating || 'tier' in body) {
    const tier = body.tier ?? 'aliado';
    if (!SPONSOR_TIERS.includes(tier as SponsorTier)) throw new LiveError(400, 'tier_invalido', 'Categoría de patrocinio inválida (principal, oficial o aliado)');
    out.tier = tier;
  }
  if ('sort_order' in body) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n) || n < 0 || n > 999) throw new LiveError(400, 'orden_invalido', 'El orden debe ser un número entre 0 y 999');
    out.sort_order = n;
  }
  return out;
}

const TIER_RANK: Record<SponsorTier, number> = { principal: 0, oficial: 1, aliado: 2 };

/** Sin la tabla (migración sin aplicar) devuelve [] en vez de romper. Orden: tier y luego `sort_order`. */
export async function listSponsors(eventId: string): Promise<SponsorRow[]> {
  const { data, error } = await supabase.from('tournament_sponsors').select(SPONSOR_COLS).eq('event_id', eventId).order('sort_order');
  if (error) return [];
  return ((data ?? []) as SponsorRow[]).slice().sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || a.sort_order - b.sort_order);
}

export async function createSponsor(ev: LiveEvent, body: Record<string, unknown>) {
  const current = await listSponsors(ev.id);
  if (current.length >= MAX_SPONSORS) throw new LiveError(400, 'demasiados', `Máximo ${MAX_SPONSORS} patrocinadores por torneo`);
  const row = { event_id: ev.id, sort_order: current.length, ...sponsorPatch(body, true) };
  const { data, error } = await supabase.from('tournament_sponsors').insert(row).select(SPONSOR_COLS).single();
  if (error || !data) throw new LiveError(500, 'error_guardando', 'No se pudo guardar el patrocinador');
  publicCache.clear();
  return data as SponsorRow;
}

export async function updateSponsor(ev: LiveEvent, id: string, body: Record<string, unknown>) {
  const patch = sponsorPatch(body, false);
  if (Object.keys(patch).length === 0) throw new LiveError(400, 'nada', 'No hay nada que guardar');
  const { data, error } = await supabase.from('tournament_sponsors').update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).eq('event_id', ev.id).select(SPONSOR_COLS);
  if (error) throw new LiveError(500, 'error_guardando', 'No se pudo guardar el patrocinador');
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new LiveError(404, 'patrocinador_no_encontrado', 'Patrocinador no encontrado');
  publicCache.clear();
  return row as SponsorRow;
}

export async function deleteSponsor(ev: LiveEvent, id: string) {
  await supabase.from('tournament_sponsors').delete().eq('id', id).eq('event_id', ev.id);
  publicCache.clear();
  return { success: true };
}

// ── Editar a mano hora y cancha ──────────────────────────────────────────────

/** Cambia hora y/o cancha (solo lo que venga en el cuerpo). Cambio + log en una RPC transaccional. */
export async function rescheduleMatch(ev: LiveEvent, matchId: string, actor: Actor, body: Record<string, unknown>) {
  const match = await loadMatch(ev.id, matchId);
  if (!match) throw new LiveError(404, 'partido_no_encontrado', 'Partido no encontrado');
  const setTime = 'scheduled_at' in body;
  const setCourt = 'court' in body;
  if (!setTime && !setCourt) throw new LiveError(400, 'nada', 'Indica la hora o la cancha');
  let when: string | null = null;
  if (setTime && body.scheduled_at != null && body.scheduled_at !== '') {
    if (typeof body.scheduled_at !== 'string' || !Number.isFinite(Date.parse(body.scheduled_at))) throw new LiveError(400, 'hora_invalida', 'La fecha y hora no son válidas');
    when = new Date(body.scheduled_at).toISOString();
  }
  const court = setCourt ? cleanText(body.court, 40, 'La cancha') : null;
  const { data, error } = await supabase.rpc('reschedule_tournament_match', {
    p_match_id: matchId, p_set_time: setTime, p_scheduled_at: when, p_set_court: setCourt, p_court: court, p_actor_id: actor.id,
  });
  if (error) throw new LiveError(500, 'error_guardando', 'No se pudo guardar el cambio');
  if ((data as any)?.error === 'not_found') throw new LiveError(404, 'partido_no_encontrado', 'Partido no encontrado');
  publicCache.clear();
  const fresh = await loadMatch(ev.id, matchId);
  return toMatchDto(fresh ?? match, resolveConfig(ev.scoring_config, match.category_id));
}

// ── Lectura pública (caché de 5 s, solo equipos y marcadores) ────────────────

const publicCache = new Map<string, { at: number; payload: any; etag: string }>();
const PUBLIC_TTL_MS = 5000;
/** Lecturas en curso por torneo: los espectadores que piden a la vez comparten UNA ronda de consultas. */
const publicInflight = new Map<string, Promise<{ payload: any; etag: string } | null>>();
/** Sube con cada invalidación: una lectura que empezó antes no deja en caché datos viejos. */
let publicGen = 0;

/**
 * Las pantallas de administración cambian datos públicos: la próxima lectura vuelve a la base.
 * Con `slug` solo se descarta ese torneo (p. ej. al terminar un partido).
 */
export const invalidatePublicLive = (slug?: string | null) => {
  publicGen++;
  if (slug) { publicCache.delete(slug); publicInflight.delete(slug); return; }
  publicCache.clear(); publicInflight.clear();
};

export type PublicStatus = 'draft' | 'published' | 'in_progress' | 'finished' | 'cancelled';

type StatusMatch = Pick<MatchRow, 'status' | 'stage' | 'home_team_id' | 'away_team_id' | 'home_ref' | 'away_ref'>;

/** Estado público derivado de events.status + partidos (no hay columna nueva). */
export function publicStatus(evStatus: string | null | undefined, matches: StatusMatch[]): PublicStatus {
  if (evStatus === 'draft') return 'draft';
  if (evStatus === 'cancelled') return 'cancelled';
  if (evStatus === 'completed') return 'finished';
  const real = matches.filter((m) => !isByeRow(m) && m.status !== 'cancelled');
  if (real.length > 0 && real.every((m) => isFinished(m.status))) return 'finished';
  if (real.some((m) => m.status === 'live' || isFinished(m.status))) return 'in_progress';
  return 'published';
}

export function venueOf(ev: Pick<LiveEvent, 'address' | 'city' | 'lat' | 'lng' | 'venue_name' | 'venue_maps_url'>) {
  const address = [ev.address, ev.city].filter(Boolean).join(', ') || null;
  let maps = ev.venue_maps_url ?? null;
  if (!maps && ev.lat != null && ev.lng != null) maps = `https://www.google.com/maps/search/?api=1&query=${ev.lat},${ev.lng}`;
  if (!maps && ev.address && address) maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return { name: ev.venue_name ?? null, address, maps_url: maps };
}

/** Adjuntos públicos del torneo (reglamento, programación…). Sin la columna (migración sin aplicar) = []. */
export async function loadAttachments(eventId: string): Promise<Array<{ name: string; url: string }>> {
  const { data, error } = await supabase.from('events').select('attachments').eq('id', eventId).maybeSingle();
  if (error) return [];
  const raw = (data as any)?.attachments;
  return Array.isArray(raw) ? raw.filter((a) => a && typeof a.name === 'string' && typeof a.url === 'string').map((a) => ({ name: a.name, url: a.url })) : [];
}

/** Fila del ranking público (contrato `PlayerStat` de la página pública). */
export interface PublicPlayerStat {
  id: string; player_label: string; team_id: string; team_name: string | null; category_id: string | null;
  aces: number; attack_points: number; blocks: number; points: number;
}

/**
 * Líneas de «vivo» (`aggregateStats`: member_id/name/ace/attack/block) → contrato público del ranking.
 * La categoría sale del equipo: sin ella el filtro por categoría de la página mezclaría todas.
 */
export function toPublicPlayerStats(lines: PlayerStatLine[], teamById: Map<string, { name: string; category_id: string | null }>): PublicPlayerStat[] {
  return lines.map((l) => {
    const t = teamById.get(l.team_id);
    return {
      id: l.member_id, player_label: l.name ?? '', team_id: l.team_id, team_name: t?.name ?? null, category_id: t?.category_id ?? null,
      aces: l.ace ?? 0, attack_points: l.attack ?? 0, blocks: l.block ?? 0, points: l.points ?? 0,
    };
  });
}

export async function publicLive(slug: string): Promise<{ payload: any; etag: string } | null> {
  const hit = publicCache.get(slug);
  if (hit && Date.now() - hit.at < PUBLIC_TTL_MS) return { payload: hit.payload, etag: hit.etag };
  // Al terminar un partido todos los celulares refrescan la tabla casi a la vez: una sola lectura.
  const pending = publicInflight.get(slug);
  if (pending) return pending;
  const gen = publicGen;
  const p = buildPublicLive(slug, gen).finally(() => { if (publicInflight.get(slug) === p) publicInflight.delete(slug); });
  publicInflight.set(slug, p);
  return p;
}

async function buildPublicLive(slug: string, gen: number): Promise<{ payload: any; etag: string } | null> {
  const ev = await selectCompat<LiveEvent>((c) => supabase.from('events').select(c).eq('slug', slug).maybeSingle(), EVENT_COLS, EVENT_COLS_V1);
  if (!ev) return null;
  if (ev.visibility === 'school_only' && !ev.live_enabled) return null;

  const [{ data: cats }, teams, matches, sponsors, attachments, playerStats] = await Promise.all([
    supabase.from('event_categories_config').select('id, division, level, category, rama').eq('event_id', ev.id),
    loadTeams(ev.id),
    loadMatches(ev.id),
    listSponsors(ev.id),
    loadAttachments(ev.id),
    eventPlayerStats(ev.id).catch(() => []),
  ]);
  const live = liveEffective(ev);
  const categories = ((cats ?? []) as any[]).map((c) => ({ id: c.id as string, name: [c.division, c.level, c.category, c.rama].filter(Boolean).join(' · ') }));
  const catIds = new Set<string | null>([...categories.map((c) => c.id), ...matches.map((m) => m.category_id)]);
  const teamDtos = teams.map(toTeamDto);
  const teamById = new Map(teamDtos.map((t) => [t.id, t]));
  const teamBits = (id: string | null) => {
    const t = id ? teamById.get(id) : undefined;
    return { logo_url: t?.logo_url ?? null, short_name: t?.short_name ?? null, is_external: t?.is_external ?? false };
  };
  const enrichRows = (rows: StandingRow[]) => rows.map((r) => ({ ...r, ...teamBits(r.team_id) }));

  const standings: Record<string, CategoryStandings> = {};
  const outMatches: any[] = [];
  for (const cid of catIds) {
    const cfg = resolveConfig(ev.scoring_config, cid);
    const cm = matches.filter((m) => m.category_id === cid);
    if (cid) {
      const st = standingsFor(teams.filter((t) => t.category_id === cid), cm, cfg);
      standings[cid] = {
        ...st,
        standings: enrichRows(st.standings),
        ...(st.groups ? { groups: Object.fromEntries(Object.entries(st.groups).map(([k, v]) => [k, enrichRows(v)])) } : {}),
      };
    }
    for (const m of cm) {
      const dto: any = toMatchDto(m, cfg, { pub: true });
      const h = teamBits(m.home_team_id), a = teamBits(m.away_team_id);
      Object.assign(dto, { home_logo_url: h.logo_url, away_logo_url: a.logo_url, home_short_name: h.short_name, away_short_name: a.short_name });
      if (!live && m.status === 'live') Object.assign(dto, { status: 'scheduled', home_score: null, away_score: null, sets: [] });
      outMatches.push(dto);
    }
  }

  const tournament = {
    id: ev.id, title: ev.title, sport: ev.sport, city: ev.city, event_date: ev.event_date,
    school_name: ev.school?.name ?? null, live_enabled: live, stream_url: live ? ev.stream_url : null, format: ev.competition_format,
    // ── v2 ──
    status: publicStatus(ev.status, matches),
    start_date: ev.event_date ?? null,
    end_date: ev.end_date ?? ev.event_date ?? null,
    cover_url: ev.banner_url ?? null,
    logo_url: ev.logo_url ?? null,
    organizer_name: ev.organizer_name ?? ev.school?.name ?? null,
    rules_url: ev.rules_url ?? null,
    venue: venueOf(ev),
    sponsors: sponsors.map((sp) => ({ id: sp.id, name: sp.name, logo_url: sp.logo_url ?? null, url: sp.url ?? null, tier: sp.tier })),
    attachments,
  };
  const payload = {
    payload_version: 2,
    event: tournament,
    /** Mismo objeto que `event`, con el nombre del contrato v2. */
    tournament,
    categories,
    teams: teamDtos,
    matches: outMatches,
    standings,
    /** Ranking por jugadora con el contrato de la página pública ({id, player_label, team_id, team_name, category_id, aces, attack_points, blocks, points}). */
    player_stats: toPublicPlayerStats(playerStats, teamById),
    server_time: new Date().toISOString(),
  };
  const etag = `"${createHash('sha1').update(JSON.stringify({ ...payload, tournament: undefined, server_time: undefined })).digest('hex').slice(0, 20)}"`;
  if (gen === publicGen) {
    publicCache.set(slug, { at: Date.now(), payload, etag });
    if (publicCache.size > 200) publicCache.delete(publicCache.keys().next().value as string);
  }
  return { payload, etag };
}

export const _clearPublicCache = () => invalidatePublicLive();

export { matchOutcome, FINISHED };
