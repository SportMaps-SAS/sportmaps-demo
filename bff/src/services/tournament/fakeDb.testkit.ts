/**
 * Base en memoria para probar torneos en vivo sin tocar Supabase.
 * Soporta lo que usa tournament-live.service: select/eq/neq/in/order/limit/single/maybeSingle,
 * insert/update/delete, el join `home:home_team_id(team_name)` y la RPC apply_tournament_match_action
 * (misma lógica que el SQL: versión optimista, duplicado por client_action_id, log).
 */
import { randomUUID } from 'crypto';

type Row = Record<string, any>;
export const db: { tables: Record<string, Row[]>; rpcCalls: number } = { tables: {}, rpcCalls: 0 };

export function resetDb() {
  db.tables = {
    events: [], tournament_matches: [], tournament_match_log: [], tournament_scorekeepers: [],
    event_teams: [], event_team_members: [], event_categories_config: [], notifications: [], tournament_sponsors: [], tournament_team_invites: [], children: [],
  };
  db.rpcCalls = 0;
}

const DEFAULTS: Record<string, () => Row> = {
  tournament_matches: () => ({
    status: 'scheduled', stage: 'league', group_label: null, home_ref: null, away_ref: null, home_score: null, away_score: null,
    court: null, scheduled_at: null, version: 0, live_state: null, scorer_ref: null, scorer_label: null,
    started_at: null, finished_at: null, updated_at: new Date().toISOString(),
  }),
  events: () => ({ live_enabled: false, scoring_config: null, format_config: null, stream_url: null, visibility: 'public', competition_format: null }),
};

function join(table: string, row: Row, select: string): Row {
  // Enlace del anotador con su torneo embebido (`event:event_id(...)`), como lo pide authScorekeeper.
  if (table === 'tournament_scorekeepers' && /event:event_id\(/.test(select)) {
    return { ...row, event: db.tables.events.find((e) => e.id === row.event_id) ?? null };
  }
  if (table !== 'tournament_matches') return row;
  const out = { ...row };
  if (/home:home_team_id/.test(select)) {
    const t = db.tables.event_teams.find((x) => x.id === row.home_team_id);
    out.home = t ? { team_name: t.team_name } : null;
  }
  if (/away:away_team_id/.test(select)) {
    const t = db.tables.event_teams.find((x) => x.id === row.away_team_id);
    out.away = t ? { team_name: t.team_name } : null;
  }
  if (table === 'tournament_matches') { /* nada más */ }
  return out;
}

function builder(table: string) {
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let payload: any = null;
  let selectStr = '*';
  const filters: Array<(r: Row) => boolean> = [];
  let orderBy: Array<{ col: string; asc: boolean }> = [];
  let lim: number | null = null;
  let single: 'single' | 'maybe' | null = null;

  const run = () => {
    const rows = (db.tables[table] ??= []);
    const match = (r: Row) => filters.every((f) => f(r));
    if (op === 'insert') {
      const list = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...(DEFAULTS[table]?.() ?? {}), ...p }));
      rows.push(...list);
      return { data: list, error: null };
    }
    if (op === 'update') {
      const hit = rows.filter(match);
      hit.forEach((r) => Object.assign(r, payload));
      return { data: hit, error: null };
    }
    if (op === 'delete') {
      db.tables[table] = rows.filter((r) => !match(r));
      return { data: null, error: null };
    }
    let out = rows.filter(match).map((r) => join(table, r, selectStr));
    for (const o of [...orderBy].reverse()) {
      out = [...out].sort((a, b) => (a[o.col] > b[o.col] ? 1 : a[o.col] < b[o.col] ? -1 : 0) * (o.asc ? 1 : -1));
    }
    if (lim != null) out = out.slice(0, lim);
    return { data: out, error: null };
  };

  const finish = () => {
    const r: any = run();
    if (single) {
      const first = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
      if (single === 'single' && !first) return { data: null, error: { message: 'not found' } };
      return { data: first, error: null };
    }
    return r;
  };

  const api: any = {
    select: (s = '*') => { selectStr = s; return api; },
    insert: (p: any) => { op = 'insert'; payload = p; return api; },
    update: (p: any) => { op = 'update'; payload = p; return api; },
    delete: () => { op = 'delete'; return api; },
    eq: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return api; },
    neq: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) !== v); return api; },
    gte: (c: string, v: any) => { filters.push((r) => r[c] != null && r[c] >= v); return api; },
    in: (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return api; },
    ilike: (c: string, pat: string) => {
      const needle = String(pat).replace(/%/g, '').toLowerCase(); // solo el caso «%texto%»
      filters.push((r) => String(r[c] ?? '').toLowerCase().includes(needle)); return api;
    },
    order: (col: string, o: { ascending?: boolean } = {}) => { orderBy.push({ col, asc: o.ascending !== false }); return api; },
    limit: (n: number) => { lim = n; return api; },
    single: () => { single = 'single'; return Promise.resolve(finish()); },
    maybeSingle: () => { single = 'maybe'; return Promise.resolve(finish()); },
    then: (ok: any, ko: any) => Promise.resolve(finish()).then(ok, ko),
  };
  return api;
}

export const fakeSupabase = {
  from: (t: string) => builder(t),
  storage: {
    from: (bucket: string) => ({
      createSignedUploadUrl: async (path: string) => ({ data: { token: 'tok', signedUrl: `https://x.supabase.co/upload/${bucket}/${path}` }, error: null }),
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://x.supabase.co/signed/${bucket}/${path}` }, error: null }),
      remove: async () => ({ data: null, error: null }),
    }),
  },
  rpc: async (fn: string, a: any) => {
    db.rpcCalls++;
    if (fn === 'reschedule_tournament_match') {
      const m = db.tables.tournament_matches.find((x) => x.id === a.p_match_id);
      if (!m) return { data: { error: 'not_found' }, error: null };
      const before = { scheduled_at: m.scheduled_at ?? null, court: m.court ?? null };
      if (a.p_set_time) m.scheduled_at = a.p_scheduled_at;
      if (a.p_set_court) m.court = a.p_court && String(a.p_court).trim() ? String(a.p_court).trim() : null;
      db.tables.tournament_match_log.push({
        id: randomUUID(), match_id: m.id, event_id: m.event_id, actor_type: 'user', actor_id: a.p_actor_id, action: 'reschedule',
        before_state: before, after_state: { scheduled_at: m.scheduled_at ?? null, court: m.court ?? null }, client_action_id: null, created_at: new Date().toISOString(),
      });
      return { data: { ok: true }, error: null };
    }
    if (fn !== 'apply_tournament_match_action') return { data: null, error: { message: 'rpc desconocida' } };
    const m = db.tables.tournament_matches.find((x) => x.id === a.p_match_id);
    if (!m) return { data: { error: 'not_found' }, error: null };
    if (a.p_client_action_id && db.tables.tournament_match_log.some((l) => l.match_id === m.id && l.client_action_id === a.p_client_action_id)) {
      return { data: { duplicate: true, version: m.version }, error: null };
    }
    if (m.version !== a.p_expected_version) return { data: { error: 'version_conflict', version: m.version }, error: null };
    Object.assign(m, {
      status: a.p_status, live_state: a.p_live_state, home_score: a.p_home_score, away_score: a.p_away_score,
      started_at: a.p_started_at, finished_at: a.p_finished_at, scorer_ref: a.p_scorer_ref, scorer_label: a.p_scorer_label,
      version: m.version + 1, updated_at: new Date().toISOString(),
    });
    db.tables.tournament_match_log.push({
      id: randomUUID(), match_id: m.id, event_id: m.event_id, actor_type: a.p_actor_type, actor_id: a.p_actor_id, action: a.p_action,
      before_state: a.p_before, after_state: a.p_after, client_action_id: a.p_client_action_id, created_at: new Date().toISOString(),
    });
    return { data: { ok: true, version: m.version }, error: null };
  },
};

// ── Fábricas ─────────────────────────────────────────────────────────────────

export function seedEvent(over: Row = {}): Row {
  const ev = { id: randomUUID(), title: 'Copa Monster', sport: 'Voleibol', slug: 'copa-monster-abc123', city: 'Medellín', event_date: '2026-11-07',
    school_id: 'school-1', creator_role: 'school', school: { name: 'Monster Volley' }, ...(DEFAULTS.events()), ...over };
  db.tables.events.push(ev);
  return ev;
}

export function seedTeams(eventId: string, categoryId: string, n: number): Row[] {
  const teams = Array.from({ length: n }, (_, i) => ({ id: randomUUID(), event_id: eventId, category_id: categoryId, team_name: `Equipo ${i + 1}`, status: 'approved' }));
  db.tables.event_teams.push(...teams);
  return teams;
}

/** Rival externo (sin delegación), como lo crea addExternalTeams. */
export function seedExternalTeam(eventId: string, categoryId: string, name: string, over: Row = {}): Row {
  const t = { id: randomUUID(), event_id: eventId, category_id: categoryId, team_name: name, status: 'confirmed', delegation_id: null, is_external: true, ...over };
  db.tables.event_teams.push(t);
  return t;
}

export function seedCategory(eventId: string): string {
  const id = randomUUID();
  db.tables.event_categories_config.push({ id, event_id: eventId, division: 'Infantil', level: 'A', category: 'Sub 14', rama: 'Femenina' });
  return id;
}
