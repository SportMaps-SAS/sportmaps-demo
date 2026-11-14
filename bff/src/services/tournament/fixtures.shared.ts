/**
 * Generador de calendarios — PURO. Tres formatos independientes:
 *   · liga:   todos contra todos (ida o ida y vuelta, o solo N partidos por equipo).
 *   · copa:   eliminación directa con byes, cuadro estándar y tercer puesto opcional.
 *   · grupos: fase de grupos (todos contra todos por grupo) + fase final con cruces tipo 1.º A vs 2.º B.
 * El sorteo puede ser aleatorio (con semilla reproducible) o manual (el orden dado = siembra).
 */

export type Format = 'liga' | 'copa' | 'grupos';
export type Stage = 'league' | 'group' | 'knockout' | 'third_place';

export interface ScheduleConfig {
  /** ISO local o con zona, ej. 2026-11-07T08:00:00-05:00 */
  start: string;
  courts: number;
  slot_minutes: number;
  break_minutes?: number;
}

/** Una copa de la fase final: qué posiciones de cada grupo la juegan (ej. oro = 1.º y 2.º). */
export interface CupConfig {
  label: string;
  positions: number[];
  /** Partido por el tercer puesto de ESTA copa (si no viene, usa `third_place` del formato). */
  third_place?: boolean;
}

export interface FormatConfig {
  draw?: 'random' | 'manual';
  seed?: number | string;
  /** Orden de siembra cuando draw = 'manual' (ids de equipos). */
  team_order?: string[];
  /** Liga: cuántos partidos juega cada equipo (null = todos contra todos). */
  matches_per_team?: number | null;
  /** Liga/grupos: ida y vuelta. */
  double_round?: boolean;
  /** Grupos: cuántos grupos y cuántos clasifican de cada uno. */
  groups?: { count: number; advance: number };
  /** Copa/grupos: partido por el tercer puesto. */
  third_place?: boolean;
  /** Grupos: varias copas (oro/plata…). Si viene, reemplaza a `groups.advance`. */
  cups?: CupConfig[] | null;
  schedule?: ScheduleConfig | null;
}

export interface FixtureRow {
  stage: Stage;
  group_label: string | null;
  round: number;
  slot: number;
  home_team_id: string | null;
  away_team_id: string | null;
  /** Referencias a resolver: 'G1:A' (1.º del grupo A), 'L:1:1' (perdedor del partido ronda 1 slot 1). */
  home_ref: string | null;
  away_ref: string | null;
  court: string | null;
  scheduled_at: string | null;
  /** Copa de la fase final (null = grupos/liga o copa única). */
  cup_label: string | null;
}

export interface GenerateResult { rows: FixtureRow[]; seed: number; groups?: Record<string, string[]> }

// ── Azar reproducible ────────────────────────────────────────────────────────

function hashSeed(seed: number | string): number {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ── Validación ───────────────────────────────────────────────────────────────

export function validateFormat(format: Format, n: number, cfg: FormatConfig): string | null {
  if (n < 2) return 'Se necesitan al menos 2 equipos en la categoría.';
  if (cfg.draw === 'manual' && cfg.team_order && cfg.team_order.length) {
    // se valida contra los equipos reales al generar
  }
  if (format === 'liga') {
    const maxPer = (n % 2 === 0 ? n - 1 : n - 1) * (cfg.double_round ? 2 : 1);
    if (cfg.matches_per_team != null && (!Number.isInteger(cfg.matches_per_team) || cfg.matches_per_team < 1 || cfg.matches_per_team > maxPer)) {
      return `Los partidos por equipo deben estar entre 1 y ${maxPer}.`;
    }
  }
  if (format === 'grupos') {
    const g = cfg.groups;
    const hasCups = Array.isArray(cfg.cups) && cfg.cups.length > 0;
    if (!g || !Number.isInteger(g.count) || (!hasCups && !Number.isInteger(g.advance))) return 'Indica cuántos grupos y cuántos equipos clasifican por grupo.';
    if (g.count < 1 || g.count > 26) return 'Los grupos deben ser entre 1 y 26.';
    if (n < g.count * 2) return `Con ${g.count} grupos se necesitan al menos ${g.count * 2} equipos (2 por grupo).`;
    const minSize = Math.floor(n / g.count);
    if (hasCups) {
      const err = validateCups(cfg.cups!, g.count, minSize);
      if (err) return err;
    } else {
      if (g.advance < 1 || g.advance > minSize) return `Por grupo pueden clasificar entre 1 y ${minSize} equipos.`;
      if (g.count * g.advance < 2) return 'La fase final necesita al menos 2 clasificados.';
    }
  } else if (Array.isArray(cfg.cups) && cfg.cups.length > 0) {
    return 'Las copas (oro, plata…) solo aplican al formato de grupos + fase final.';
  }
  if (cfg.schedule) {
    const s = cfg.schedule;
    if (!Number.isFinite(Date.parse(s.start))) return 'La fecha de inicio del calendario no es válida.';
    if (!Number.isInteger(s.courts) || s.courts < 1 || s.courts > 50) return 'Las canchas deben estar entre 1 y 50.';
    if (!Number.isInteger(s.slot_minutes) || s.slot_minutes < 5 || s.slot_minutes > 600) return 'La duración por partido debe estar entre 5 y 600 minutos.';
  }
  return null;
}

/** Copas: nombre único, posiciones 1..minSize sin repetir entre copas, al menos 2 equipos por copa. */
export function validateCups(cups: CupConfig[], groupCount: number, minSize: number): string | null {
  if (cups.length > 8) return 'Máximo 8 copas.';
  const labels = new Set<string>();
  const used = new Set<number>();
  for (const c of cups) {
    const label = String(c?.label ?? '').trim();
    if (!label) return 'Ponle nombre a cada copa (por ejemplo «Copa oro»).';
    if (label.length > 40) return 'El nombre de la copa puede tener máximo 40 caracteres.';
    if (labels.has(label.toLowerCase())) return `La copa «${label}» está repetida.`;
    labels.add(label.toLowerCase());
    if (!Array.isArray(c.positions) || c.positions.length === 0) return `Indica qué posiciones juegan la ${label}.`;
    for (const p of c.positions) {
      if (!Number.isInteger(p) || p < 1 || p > minSize) return `En la ${label} las posiciones deben estar entre 1 y ${minSize} (el grupo más pequeño).`;
      if (used.has(p)) return `El ${p}.º de cada grupo está en dos copas.`;
      used.add(p);
    }
    if (c.positions.length * groupCount < 2) return `La ${label} necesita al menos 2 equipos.`;
  }
  return null;
}

// ── Todos contra todos ───────────────────────────────────────────────────────

export function roundRobinRounds(ids: string[]): Array<Array<[string, string]>> {
  const teams: (string | null)[] = [...ids];
  if (teams.length % 2 !== 0) teams.push(null); // descanso
  const n = teams.length;
  const rounds: Array<Array<[string, string]>> = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < n / 2; i++) {
      const a = teams[i], b = teams[n - 1 - i];
      if (a && b) pairs.push(r % 2 === 0 ? [a, b] : [b, a]); // alterna localía
    }
    rounds.push(pairs);
    teams.splice(1, 0, teams.pop()!); // rota dejando el primero fijo
  }
  return rounds;
}

function leagueRounds(ids: string[], cfg: FormatConfig): Array<Array<[string, string]>> {
  let rounds = roundRobinRounds(ids);
  if (cfg.double_round) rounds = [...rounds, ...roundRobinRounds(ids).map((r) => r.map(([a, b]) => [b, a] as [string, string]))];
  if (cfg.matches_per_team != null) rounds = rounds.slice(0, cfg.matches_per_team);
  return rounds;
}

// ── Cuadro eliminatorio ──────────────────────────────────────────────────────

/** Orden estándar de siembra del cuadro: 1 y 2 en mitades opuestas, 1v16, 8v9… */
export function bracketOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

export interface Entrant { team_id: string | null; ref: string | null; group?: string | null }

/** Arma la ronda 1 con byes y las rondas siguientes vacías. `entrants` viene en orden de siembra. */
export function buildKnockout(entrants: Entrant[], opts: { thirdPlace?: boolean; stageRoundOffset?: number; cupLabel?: string | null } = {}): FixtureRow[] {
  let size = 1; while (size < entrants.length) size *= 2;
  const seeds: (Entrant | null)[] = [...entrants];
  while (seeds.length < size) seeds.push(null);
  const totalRounds = Math.round(Math.log2(size));
  const order = bracketOrder(size);
  const rows: FixtureRow[] = [];
  const mk = (p: Partial<FixtureRow>): FixtureRow => ({
    stage: 'knockout', group_label: null, round: 1, slot: 1, home_team_id: null, away_team_id: null,
    home_ref: null, away_ref: null, court: null, scheduled_at: null, cup_label: opts.cupLabel ?? null, ...p,
  });
  for (let i = 0; i < size / 2; i++) {
    const h = seeds[order[2 * i] - 1], a = seeds[order[2 * i + 1] - 1];
    rows.push(mk({
      round: 1, slot: i + 1,
      home_team_id: h?.team_id ?? null, away_team_id: a?.team_id ?? null,
      home_ref: h?.ref ?? null, away_ref: a?.ref ?? null,
    }));
  }
  for (let r = 2; r <= totalRounds; r++) {
    for (let s = 0; s < size / Math.pow(2, r); s++) rows.push(mk({ round: r, slot: s + 1 }));
  }
  if (opts.thirdPlace && totalRounds >= 2) {
    rows.push(mk({ stage: 'third_place', round: totalRounds, slot: 2, home_ref: `L:${totalRounds - 1}:1`, away_ref: `L:${totalRounds - 1}:2` }));
  }
  return rows;
}

// ── Grupos ───────────────────────────────────────────────────────────────────

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Reparte en serpiente: 1.º→A, 2.º→B … y de regreso. Con sorteo aleatorio el orden ya viene barajado. */
export function dealIntoGroups(ids: string[], count: number): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (let g = 0; g < count; g++) groups[LABELS[g]] = [];
  ids.forEach((id, i) => {
    const lap = Math.floor(i / count), pos = i % count;
    const g = lap % 2 === 0 ? pos : count - 1 - pos;
    groups[LABELS[g]].push(id);
  });
  return groups;
}

/** Clasificados en orden de siembra: primeros de cada grupo, luego segundos, etc. (rotando para evitar cruces del mismo grupo). */
export function groupQualifiers(count: number, advance: number): Array<{ pos: number; group: string }> {
  return groupQualifiersFor(count, Array.from({ length: advance }, (_, i) => i + 1));
}

/** Igual que `groupQualifiers` pero con posiciones arbitrarias (ej. copa plata = 3.º y 4.º). */
export function groupQualifiersFor(count: number, positions: number[]): Array<{ pos: number; group: string }> {
  const sameGroupInRound1 = (list: Array<{ pos: number; group: string }>): boolean => {
    let size = 1; while (size < list.length) size *= 2;
    const order = bracketOrder(size);
    for (let i = 0; i < size / 2; i++) {
      const a = list[order[2 * i] - 1], b = list[order[2 * i + 1] - 1];
      if (a && b && a.group === b.group) return true;
    }
    return false;
  };
  const build = (rot: number) => {
    const list: Array<{ pos: number; group: string }> = [];
    positions.forEach((p, i) => {
      const shift = i === 0 ? 0 : (rot * i) % count;
      for (let g = 0; g < count; g++) list.push({ pos: p, group: LABELS[(g + shift) % count] });
    });
    return list;
  };
  for (let rot = 1; rot <= Math.max(count, 1); rot++) {
    const cand = build(rot);
    if (!sameGroupInRound1(cand)) return cand;
  }
  return build(1);
}

// ── Calendario (cancha y hora) ───────────────────────────────────────────────

function pad(n: number) { return String(n).padStart(2, '0'); }

/** Suma minutos a un ISO conservando su zona (si trae offset) o en hora local sin zona. */
export function addMinutesISO(iso: string, minutes: number): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(.*)$/.exec(iso);
  const tz = m ? m[2] : '';
  const base = m ? m[1] : iso;
  const d = new Date(base + 'Z'); // aritmética en "reloj de pared" sin saltos de horario
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00${tz}`;
}

/** Asigna cancha y hora ronda por ronda: un equipo nunca juega dos partidos en el mismo bloque. */
export function assignSchedule(rows: FixtureRow[], sch: ScheduleConfig): FixtureRow[] {
  const stageRank: Record<Stage, number> = { league: 0, group: 0, knockout: 1, third_place: 2 };
  const sorted = rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => stageRank[x.r.stage] - stageRank[y.r.stage] || x.r.round - y.r.round || x.r.slot - y.r.slot);
  const step = sch.slot_minutes + (sch.break_minutes ?? 0);
  let block = 0;
  let inRound = 0;
  let key: string | null = null;
  const out = rows.map((r) => ({ ...r }));
  for (const { r, i } of sorted) {
    const k = `${stageRank[r.stage] === 0 ? 'g' : r.stage}:${r.round}`;
    if (k !== key) { if (key !== null) block++; key = k; inRound = 0; } // cada ronda arranca un bloque nuevo
    else if (inRound % sch.courts === 0) block++;
    out[i].court = `Cancha ${(inRound % sch.courts) + 1}`;
    out[i].scheduled_at = addMinutesISO(sch.start, block * step);
    inRound++;
  }
  return out;
}

// ── Punto de entrada ─────────────────────────────────────────────────────────

export function generateFixtures(format: Format, teamIds: string[], cfg: FormatConfig = {}): GenerateResult {
  const err = validateFormat(format, teamIds.length, cfg);
  if (err) throw new Error(err);

  const seed = cfg.seed != null ? hashSeed(cfg.seed) : Math.floor(Math.random() * 4294967296);
  const rng = mulberry32(seed);

  let ids = [...teamIds];
  if (cfg.draw === 'manual' && cfg.team_order && cfg.team_order.length) {
    const known = new Set(teamIds);
    const ordered = cfg.team_order.filter((id) => known.has(id));
    const rest = teamIds.filter((id) => !ordered.includes(id));
    ids = [...ordered, ...rest];
  } else {
    ids = shuffle(ids, rng); // aleatorio por defecto
  }

  const base = (p: Partial<FixtureRow>): FixtureRow => ({
    stage: 'league', group_label: null, round: 1, slot: 1, home_team_id: null, away_team_id: null,
    home_ref: null, away_ref: null, court: null, scheduled_at: null, cup_label: null, ...p,
  });

  let rows: FixtureRow[] = [];
  let groupsOut: Record<string, string[]> | undefined;

  if (format === 'liga') {
    leagueRounds(ids, cfg).forEach((pairs, ri) => pairs.forEach((pair, si) => rows.push(base({
      stage: 'league', round: ri + 1, slot: si + 1, home_team_id: pair[0], away_team_id: pair[1],
    }))));
  } else if (format === 'copa') {
    rows = buildKnockout(ids.map((id) => ({ team_id: id, ref: null })), { thirdPlace: cfg.third_place });
  } else {
    const { count, advance } = cfg.groups!;
    groupsOut = dealIntoGroups(ids, count);
    for (const [label, members] of Object.entries(groupsOut)) {
      leagueRounds(members, { double_round: cfg.double_round }).forEach((pairs, ri) => pairs.forEach((pair, si) => rows.push(base({
        stage: 'group', group_label: label, round: ri + 1, slot: si + 1, home_team_id: pair[0], away_team_id: pair[1],
      }))));
    }
    const cups = Array.isArray(cfg.cups) && cfg.cups.length > 0
      ? cfg.cups.map((c) => ({ label: String(c.label).trim() as string | null, positions: c.positions, third: c.third_place ?? cfg.third_place }))
      : [{ label: null as string | null, positions: Array.from({ length: advance }, (_, i) => i + 1), third: cfg.third_place }];
    for (const cup of cups) {
      const qualifiers = groupQualifiersFor(count, cup.positions);
      rows.push(...buildKnockout(
        qualifiers.map((q) => ({ team_id: null, ref: `G${q.pos}:${q.group}`, group: q.group })),
        { thirdPlace: cup.third, cupLabel: cup.label },
      ));
    }
  }

  if (cfg.schedule) rows = assignSchedule(rows, cfg.schedule);
  return { rows, seed, groups: groupsOut };
}

/** Partidos que juega como máximo cada equipo en la liga (útil para mostrar al configurar). */
export function leagueMatchesPerTeam(n: number, cfg: FormatConfig): number {
  return leagueRounds(Array.from({ length: n }, (_, i) => `t${i}`), cfg).filter((r) => r.length > 0).length;
}
