/**
 * Lo social de un partido / torneo: comentarios, fotos / videos / noticias, MVP y estadísticas por
 * jugadora. Todo pasa por el BFF (service_role); las tablas están cerradas a anon y authenticated
 * (migración 20261027180907).
 *
 * Privacidad: de una jugadora solo sale `publicPlayerName` (nombre de pila; inicial del apellido
 * solo si consta que es mayor de edad). Nunca documento, año de nacimiento ni nombre completo.
 * Disk IO: las lecturas públicas tienen caché en memoria de 10 s por partido / torneo.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { supabase } from '../../config/supabase';
import { publicPlayerName, validateComment, validVideoUrl } from './tournament-follow.notices';
import type { PublicEventRow } from './tournament-follow.service';
import { eligibilityContext, playerEligibility } from './tournament-players.service';

export class SocialError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export const MEDIA_BUCKET = 'tournament-media';
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; value: any }>();
const cached = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return value;
};
const bust = (prefix: string) => { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); };
export const _clearSocialCache = () => cache.clear();

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Partido ──────────────────────────────────────────────────────────────────

export interface SocialMatch {
  id: string; event_id: string; status: string; home_team_id: string | null; away_team_id: string | null;
  finished_at: string | null; live_state: any;
}

export async function loadSocialMatch(eventId: string, matchId: string): Promise<SocialMatch> {
  if (!/^[0-9a-f-]{36}$/i.test(matchId)) throw new SocialError(404, 'partido_no_encontrado', 'Partido no encontrado');
  const { data } = await supabase.from('tournament_matches')
    .select('id, event_id, status, home_team_id, away_team_id, finished_at, live_state').eq('id', matchId).eq('event_id', eventId).maybeSingle();
  if (!data) throw new SocialError(404, 'partido_no_encontrado', 'Partido no encontrado');
  return data as SocialMatch;
}

// ── Planilla (roster) pública ────────────────────────────────────────────────

export interface RosterEntry { id: string; team_id: string; side: 'home' | 'away'; name: string }

/**
 * Jugadoras HABILITADAS de los dos equipos con su nombre público. Vacío = sin planilla (no hay MVP
 * por jugadora ni estadísticas). Suspendidas y fuera de edad no salen (ni en el etiquetador ni como
 * candidatas a MVP): misma regla que la validación del carné, `playerEligibility`.
 */
export async function matchRoster(m: Pick<SocialMatch, 'home_team_id' | 'away_team_id'>): Promise<RosterEntry[]> {
  const teams = [m.home_team_id, m.away_team_id].filter(Boolean) as string[];
  if (teams.length === 0) return [];
  const [{ data }, ctx] = await Promise.all([
    supabase.from('event_team_members').select('id, team_id, full_name, birth_year, birth_date, suspended, suspended_reason').in('team_id', teams).limit(80),
    eligibilityContext(teams),
  ]);
  const year = new Date().getFullYear();
  return ((data ?? []) as any[])
    .filter((r) => { const t = ctx.teams.get(r.team_id); return playerEligibility(r, t?.cat ?? null, ctx.on, t?.status).length === 0; })
    .map((r) => ({
      id: r.id, team_id: r.team_id, side: r.team_id === m.home_team_id ? 'home' as const : 'away' as const,
      name: publicPlayerName(r.full_name, r.birth_year, { year }),
    })).sort((a, b) => a.side.localeCompare(b.side) || a.name.localeCompare(b.name));
}

// ── Estadísticas por jugadora ────────────────────────────────────────────────

export type StatKind = 'ace' | 'attack' | 'block';
export const STAT_KINDS: StatKind[] = ['ace', 'attack', 'block'];

export interface StatRow { member_id: string; side: 'home' | 'away'; stat: StatKind; point_index: number; match_id: string }

/**
 * Una estadística cuenta solo si su punto sigue existiendo en la secuencia del partido
 * (no se deshizo) y lo ganó el lado de la jugadora. `points` = live_state.points ('h'/'a').
 */
export function countableStats(rows: StatRow[], pointsByMatch: Map<string, string>): StatRow[] {
  return rows.filter((r) => {
    const p = pointsByMatch.get(r.match_id) ?? '';
    const ch = p.charAt(r.point_index);
    return r.point_index < p.length && ((r.side === 'home' && ch === 'h') || (r.side === 'away' && ch === 'a'));
  });
}

export interface PlayerStatLine { member_id: string; name: string; team_id: string; side?: 'home' | 'away'; ace: number; attack: number; block: number; points: number }

export function aggregateStats(rows: StatRow[], names: Map<string, { name: string; team_id: string; side?: 'home' | 'away' }>): PlayerStatLine[] {
  const by = new Map<string, PlayerStatLine>();
  for (const r of rows) {
    const who = names.get(r.member_id);
    if (!who) continue;
    const line = by.get(r.member_id) ?? { member_id: r.member_id, name: who.name, team_id: who.team_id, side: who.side, ace: 0, attack: 0, block: 0, points: 0 };
    line[r.stat]++; line.points++;
    by.set(r.member_id, line);
  }
  return [...by.values()].sort((a, b) => b.points - a.points || b.attack - a.attack || a.name.localeCompare(b.name));
}

export async function matchPlayerStats(m: SocialMatch, roster: RosterEntry[]): Promise<PlayerStatLine[]> {
  if (roster.length === 0) return [];
  const { data } = await supabase.from('tournament_player_stats').select('member_id, side, stat, point_index, match_id').eq('match_id', m.id);
  const points = new Map([[m.id, String(m.live_state?.points ?? '')]]);
  return aggregateStats(countableStats((data ?? []) as StatRow[], points), new Map(roster.map((r) => [r.id, { name: r.name, team_id: r.team_id, side: r.side }])));
}

/** Ranking del torneo (Aces / Puntos / Ataque / Bloqueos). Para `player_stats` del payload público. */
export async function eventPlayerStats(eventId: string): Promise<PlayerStatLine[]> {
  return cached(`ev:${eventId}:stats`, async () => {
    const { data: rows } = await supabase.from('tournament_player_stats').select('member_id, side, stat, point_index, match_id').eq('event_id', eventId).limit(20000);
    const stats = (rows ?? []) as StatRow[];
    if (stats.length === 0) return [];
    const matchIds = [...new Set(stats.map((s) => s.match_id))];
    const memberIds = [...new Set(stats.map((s) => s.member_id))];
    const [{ data: ms }, { data: mem }] = await Promise.all([
      supabase.from('tournament_matches').select('id, live_state').in('id', matchIds),
      supabase.from('event_team_members').select('id, team_id, full_name, birth_year').in('id', memberIds),
    ]);
    const points = new Map(((ms ?? []) as any[]).map((m) => [m.id, String(m.live_state?.points ?? '')]));
    const year = new Date().getFullYear();
    const names = new Map(((mem ?? []) as any[]).map((r) => [r.id, { name: publicPlayerName(r.full_name, r.birth_year, { year }), team_id: r.team_id }]));
    return aggregateStats(countableStats(stats, points), names);
  });
}

/** Etiquetar un punto (opcional, desde el anotador). */
export async function tagPoint(m: SocialMatch, body: { member_id?: unknown; stat?: unknown; point_index?: unknown }) {
  const stat = String(body.stat ?? '') as StatKind;
  if (!STAT_KINDS.includes(stat)) throw new SocialError(400, 'stat_invalida', 'Tipo inválido: ace, ataque o bloqueo.');
  const idx = Number(body.point_index);
  const points = String(m.live_state?.points ?? '');
  if (!Number.isInteger(idx) || idx < 0 || idx >= points.length) throw new SocialError(422, 'punto_invalido', 'Ese punto ya no está en el marcador.');
  const roster = await matchRoster(m);
  const who = roster.find((r) => r.id === body.member_id);
  if (!who) throw new SocialError(404, 'jugadora_no_encontrada', 'Esa jugadora no está en la planilla de este partido.');
  if ((who.side === 'home' ? 'h' : 'a') !== points.charAt(idx)) throw new SocialError(422, 'lado_incorrecto', 'Ese punto lo ganó el otro equipo.');
  const { error } = await supabase.from('tournament_player_stats').upsert({
    event_id: m.event_id, match_id: m.id, team_id: who.team_id, member_id: who.id, side: who.side, stat, point_index: idx,
  }, { onConflict: 'match_id,point_index' });
  if (error) throw new SocialError(500, 'error_guardando', 'No se pudo guardar la estadística.');
  bust(`m:${m.id}`); bust(`ev:${m.event_id}`);
  return { ok: true };
}

export async function untagPoint(m: SocialMatch, pointIndex: number) {
  await supabase.from('tournament_player_stats').delete().eq('match_id', m.id).eq('point_index', pointIndex);
  bust(`m:${m.id}`); bust(`ev:${m.event_id}`);
  return { ok: true };
}

// ── MVP ──────────────────────────────────────────────────────────────────────

/** Se vota mientras el partido está en juego y hasta 3 h después de terminar. */
export function mvpVotingOpen(m: Pick<SocialMatch, 'status' | 'finished_at'>, now = Date.now()): boolean {
  if (m.status === 'live') return true;
  if ((m.status === 'played') && m.finished_at) return now - Date.parse(m.finished_at) < 3 * 3600_000;
  return false;
}

export interface MvpSummary {
  available: boolean; reason?: 'sin_planilla'; voting_open: boolean;
  candidates: RosterEntry[]; votes: Record<string, number>; total: number;
  winner: { member_id: string; name: string; side: 'home' | 'away'; source: 'organizer' | 'public' } | null;
}

export function pickWinner(candidates: RosterEntry[], votes: Record<string, number>, organizer: string | null): MvpSummary['winner'] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  if (organizer && byId.has(organizer)) { const c = byId.get(organizer)!; return { member_id: c.id, name: c.name, side: c.side, source: 'organizer' }; }
  let best: RosterEntry | null = null; let bestN = 0;
  for (const c of candidates) { const n = votes[c.id] ?? 0; if (n > bestN) { best = c; bestN = n; } }
  return best ? { member_id: best.id, name: best.name, side: best.side, source: 'public' } : null;
}

async function mvpSummary(m: SocialMatch, roster: RosterEntry[]): Promise<MvpSummary> {
  if (roster.length === 0) return { available: false, reason: 'sin_planilla', voting_open: false, candidates: [], votes: {}, total: 0, winner: null };
  const [{ data: votes }, { data: pick }] = await Promise.all([
    supabase.from('tournament_mvp_votes').select('member_id').eq('match_id', m.id).limit(10000),
    supabase.from('tournament_match_mvp').select('member_id').eq('match_id', m.id).maybeSingle(),
  ]);
  const tally: Record<string, number> = {};
  for (const v of (votes ?? []) as any[]) tally[v.member_id] = (tally[v.member_id] ?? 0) + 1;
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  return { available: true, voting_open: mvpVotingOpen(m), candidates: roster, votes: tally, total, winner: pickWinner(roster, tally, (pick as any)?.member_id ?? null) };
}

export async function voteMvp(m: SocialMatch, memberId: unknown, deviceId: unknown, ip: string) {
  if (typeof deviceId !== 'string' || deviceId.length < 16 || deviceId.length > 64) throw new SocialError(400, 'dispositivo_invalido', 'No pudimos identificar tu dispositivo.');
  if (!mvpVotingOpen(m)) throw new SocialError(422, 'votacion_cerrada', 'La votación del MVP de este partido está cerrada.');
  const roster = await matchRoster(m);
  if (!roster.some((r) => r.id === memberId)) throw new SocialError(404, 'jugadora_no_encontrada', 'Esa jugadora no está en este partido.');
  const voter_hash = sha(`${deviceId}:${m.id}`);
  const { error } = await supabase.from('tournament_mvp_votes').insert({ match_id: m.id, member_id: memberId, voter_hash, ip_hash: sha(`ip:${ip}`).slice(0, 32) });
  if (error) {
    if (/duplicate|unique/i.test(error.message)) throw new SocialError(409, 'ya_votaste', 'Ya votaste en este partido desde este dispositivo.');
    throw new SocialError(500, 'error_guardando', 'No se pudo guardar tu voto.');
  }
  bust(`m:${m.id}`);
  return { ok: true };
}

export async function chooseMvp(m: SocialMatch, memberId: unknown, userId: string) {
  if (memberId == null) {
    await supabase.from('tournament_match_mvp').delete().eq('match_id', m.id);
  } else {
    const roster = await matchRoster(m);
    if (!roster.some((r) => r.id === memberId)) throw new SocialError(404, 'jugadora_no_encontrada', 'Esa jugadora no está en este partido.');
    await supabase.from('tournament_match_mvp').upsert({ match_id: m.id, member_id: memberId, chosen_by: userId, chosen_at: new Date().toISOString() }, { onConflict: 'match_id' });
  }
  bust(`m:${m.id}`);
  return { ok: true };
}

// ── Comentarios ──────────────────────────────────────────────────────────────

const secret = () => process.env.TOURNAMENT_SOCIAL_SECRET || sha(`social:${process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'dev'}`);

/** Reto anti-spam sin estado: «¿Cuánto es 3 + 5?», firmado con HMAC y con vencimiento. */
export function issueChallenge(now = Date.now(), rnd: () => number = Math.random, key = secret()) {
  const a = 1 + Math.floor(rnd() * 9);
  const b = 1 + Math.floor(rnd() * 9);
  const body = `${a + b}.${now}`;
  const sig = createHmac('sha256', key).update(body).digest('base64url').slice(0, 22);
  return { question: `¿Cuánto es ${a} + ${b}?`, token: `${Buffer.from(String(now)).toString('base64url')}.${sig}` };
}

export type ChallengeVerdict = 'ok' | 'muy_rapido' | 'vencido' | 'incorrecto';

/**
 * Válido si la respuesta cuadra, pasaron ≥ 3 s (un bot responde al instante) y < 30 min.
 * Distingue «muy rápido» de «suma mal» para no decirle a una persona que respondió mal cuando no.
 */
export function challengeVerdict(token: unknown, answer: unknown, now = Date.now(), key = secret()): ChallengeVerdict {
  if (typeof token !== 'string' || !token.includes('.')) return 'incorrecto';
  const [tsB64, sig] = token.split('.');
  const ts = Number(Buffer.from(tsB64, 'base64url').toString());
  if (!Number.isFinite(ts)) return 'incorrecto';
  const n = Number(answer);
  if (!Number.isInteger(n)) return 'incorrecto';
  const expected = createHmac('sha256', key).update(`${n}.${ts}`).digest('base64url').slice(0, 22);
  const a = Buffer.from(expected); const b = Buffer.from(String(sig));
  if (!(a.length === b.length && timingSafeEqual(a, b))) return 'incorrecto';
  if (now - ts < 3000) return 'muy_rapido';
  if (now - ts > 30 * 60_000) return 'vencido';
  return 'ok';
}

export function checkChallenge(token: unknown, answer: unknown, now = Date.now(), key = secret()): boolean {
  return challengeVerdict(token, answer, now, key) === 'ok';
}

export interface CommentInput {
  author_name?: unknown; body?: unknown; device_id?: unknown; challenge_token?: unknown; challenge_answer?: unknown; website?: unknown;
}

export async function postComment(ev: PublicEventRow, matchId: string | null, input: CommentInput, ctx: { userId: string | null; userName: string | null; ip: string }) {
  if (input.website) throw new SocialError(400, 'spam', 'No se pudo publicar.'); // trampa para bots
  if (matchId) await loadSocialMatch(ev.id, matchId);
  const name = ctx.userId && ctx.userName ? ctx.userName : String(input.author_name ?? '').trim();
  const bad = validateComment(name, input.body);
  if (bad) throw new SocialError(400, 'comentario_invalido', bad);
  if (!ctx.userId) {
    const v = challengeVerdict(input.challenge_token, input.challenge_answer);
    if (v === 'muy_rapido') throw new SocialError(400, 'reto_muy_rapido', 'Espera un momento y vuelve a enviar.');
    if (v === 'vencido') throw new SocialError(400, 'reto_vencido', 'La comprobación venció. Responde la nueva suma y envía otra vez.');
    if (v !== 'ok') throw new SocialError(400, 'reto_invalido', 'Responde bien la suma para comprobar que no eres un robot.');
  }
  const voter = typeof input.device_id === 'string' && input.device_id.length >= 16 ? sha(`c:${input.device_id}`) : null;
  const ipHash = sha(`ip:${ctx.ip}`).slice(0, 32);
  // Un comentario cada 20 s por dispositivo/usuario (además del tope por IP de la ruta).
  const since = new Date(Date.now() - 20_000).toISOString();
  let recent = supabase.from('tournament_comments').select('id').eq('event_id', ev.id).gte('created_at', since).limit(1);
  recent = ctx.userId ? recent.eq('author_user_id', ctx.userId) : voter ? recent.eq('voter_hash', voter) : recent.eq('ip_hash', ipHash);
  const { data: r } = await recent;
  if ((r ?? []).length > 0) throw new SocialError(429, 'muy_seguido', 'Espera unos segundos antes de comentar otra vez.');
  const { data, error } = await supabase.from('tournament_comments').insert({
    event_id: ev.id, match_id: matchId, author_user_id: ctx.userId, author_name: name.slice(0, 40), body: String(input.body).trim(),
    voter_hash: voter, ip_hash: ipHash,
  }).select('id, author_name, body, created_at').single();
  if (error || !data) throw new SocialError(500, 'error_guardando', 'No se pudo publicar el comentario.');
  bust(matchId ? `m:${matchId}` : `ev:${ev.id}`);
  return { ok: true, comment: { ...(data as any), verified: !!ctx.userId } };
}

export async function moderateComment(eventId: string, commentId: string, action: 'hide' | 'show' | 'delete', userId: string) {
  const q = supabase.from('tournament_comments');
  if (action === 'delete') await q.delete().eq('id', commentId).eq('event_id', eventId);
  else await q.update({ status: action === 'hide' ? 'hidden' : 'visible', moderated_by: userId }).eq('id', commentId).eq('event_id', eventId);
  bust('m:'); bust(`ev:${eventId}`);
  return { ok: true };
}

// ── Fotos, videos y noticias ─────────────────────────────────────────────────

export function mediaPublicUrl(path: string): string {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  return `${base}/storage/v1/object/public/${MEDIA_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** URL firmada para subir UNA foto directo a Storage (el BFF no recibe el archivo). */
export async function mediaUploadUrl(eventId: string, mime: unknown) {
  const ext = EXT[String(mime)];
  if (!ext) throw new SocialError(400, 'formato_invalido', 'Sube una foto JPG, PNG o WEBP.');
  const path = `${eventId}/${randomUUID()}.${ext}`;
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new SocialError(500, 'error_subida', 'No se pudo preparar la subida.');
  return { path, signedUrl: (data as any).signedUrl, token: (data as any).token };
}

export interface PostInput { kind?: unknown; match_id?: unknown; title?: unknown; body?: unknown; media_path?: unknown; video_url?: unknown }

export async function createPost(eventId: string, input: PostInput, by: { userId?: string | null; scorekeeperId?: string | null }) {
  const kind = String(input.kind ?? '');
  if (!['photo', 'video', 'news'].includes(kind)) throw new SocialError(400, 'tipo_invalido', 'Tipo inválido: foto, video o noticia.');
  if (kind === 'news' && by.scorekeeperId) throw new SocialError(403, 'solo_organizador', 'Las noticias las publica el organizador.');
  const matchId = input.match_id ? String(input.match_id) : null;
  if (matchId) await loadSocialMatch(eventId, matchId);
  const title = input.title ? String(input.title).trim().slice(0, 120) : null;
  const body = input.body ? String(input.body).trim().slice(0, 2000) : null;
  const row: Record<string, unknown> = { event_id: eventId, match_id: matchId, kind, title, body, created_by: by.userId ?? null, scorekeeper_id: by.scorekeeperId ?? null };
  if (kind === 'photo') {
    const p = String(input.media_path ?? '');
    if (!p.startsWith(`${eventId}/`) || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/i.test(p)) throw new SocialError(400, 'foto_invalida', 'La foto no es válida.');
    row.media_path = p;
  } else if (kind === 'video') {
    const v = validVideoUrl(input.video_url);
    if (!v) throw new SocialError(400, 'video_invalido', 'Pega un enlace https de YouTube, Facebook, Instagram, TikTok o Vimeo.');
    row.video_url = v;
  } else if (!body) throw new SocialError(400, 'noticia_vacia', 'Escribe el texto de la noticia.');
  const { data, error } = await supabase.from('tournament_posts').insert(row).select('id').single();
  if (error || !data) throw new SocialError(500, 'error_guardando', 'No se pudo publicar.');
  bust(matchId ? `m:${matchId}` : `ev:${eventId}`); bust(`ev:${eventId}`);
  return { ok: true, id: (data as any).id };
}

export async function removePost(eventId: string, postId: string) {
  const { data } = await supabase.from('tournament_posts').select('media_path').eq('id', postId).eq('event_id', eventId).maybeSingle();
  await supabase.from('tournament_posts').delete().eq('id', postId).eq('event_id', eventId);
  const path = (data as any)?.media_path;
  if (path) await supabase.storage.from(MEDIA_BUCKET).remove([path]);
  bust('m:'); bust(`ev:${eventId}`);
  return { ok: true };
}

const toMedia = (p: any) => ({
  id: p.id, kind: p.kind as 'photo' | 'video' | 'news', match_id: p.match_id, title: p.title, body: p.body,
  url: p.media_path ? mediaPublicUrl(p.media_path) : null, video_url: p.video_url, created_at: p.created_at,
});
const toComment = (c: any) => ({ id: c.id, author_name: c.author_name, body: c.body, created_at: c.created_at, verified: !!c.author_user_id });

// ── Lecturas públicas ────────────────────────────────────────────────────────

/** GET /public/:slug/matches/:id/social → { comments[], media[], mvp, player_stats } */
export async function matchSocial(ev: PublicEventRow, matchId: string, opts: { includeHidden?: boolean } = {}) {
  const m = await loadSocialMatch(ev.id, matchId);
  const run = async () => {
    const roster = await matchRoster(m);
    let cq = supabase.from('tournament_comments').select('id, author_name, body, created_at, author_user_id, status').eq('match_id', m.id).order('created_at', { ascending: false }).limit(100);
    if (!opts.includeHidden) cq = cq.eq('status', 'visible');
    const [{ data: comments }, { data: posts }, mvp, stats] = await Promise.all([
      cq,
      supabase.from('tournament_posts').select('id, kind, match_id, title, body, media_path, video_url, created_at').eq('match_id', m.id).eq('status', 'visible').order('created_at', { ascending: false }).limit(60),
      mvpSummary(m, roster),
      matchPlayerStats(m, roster),
    ]);
    return {
      comments: ((comments ?? []) as any[]).map((c) => (opts.includeHidden ? { ...toComment(c), status: c.status } : toComment(c))),
      media: ((posts ?? []) as any[]).map(toMedia),
      mvp,
      player_stats: stats,
    };
  };
  return opts.includeHidden ? run() : cached(`m:${m.id}:social`, run);
}

/** Medios y noticias del torneo (todos los partidos + los del torneo). */
export async function eventSocial(ev: PublicEventRow) {
  return cached(`ev:${ev.id}:social`, async () => {
    const [{ data: posts }, { data: comments }] = await Promise.all([
      supabase.from('tournament_posts').select('id, kind, match_id, title, body, media_path, video_url, created_at').eq('event_id', ev.id).eq('status', 'visible').order('created_at', { ascending: false }).limit(100),
      supabase.from('tournament_comments').select('id, author_name, body, created_at, author_user_id').eq('event_id', ev.id).is('match_id', null).eq('status', 'visible').order('created_at', { ascending: false }).limit(100),
    ]);
    return { comments: ((comments ?? []) as any[]).map(toComment), media: ((posts ?? []) as any[]).map(toMedia) };
  });
}
