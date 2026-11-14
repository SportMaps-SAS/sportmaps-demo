/**
 * Seguir torneo / equipo + avisos del partido + «hoy juega» para la app de las familias.
 *
 * Los avisos usan el camino EXISTENTE de notificaciones: se inserta en `public.notifications`
 * (campana in-app) y de ahí el trigger + despachador unificado lo llevan a Web Push / FCM.
 * No se toca `notifications-dispatch.job` ni el trigger legacy. Si el despachador está atascado,
 * el aviso queda en la campana y sale por push cuando el despachador se recupere (dependencia
 * documentada en el plan).
 *
 * Disk IO: nada de N+1. El recordatorio corre cada 5 min con UNA consulta de partidos y, solo si
 * hay partidos en la ventana, una de follows, una de planillas, un upsert de marcas y un insert.
 */
import { supabase } from '../../config/supabase';
import { buildNotice, type NoticeKind, type NoticeMatch, type NoticeEvent } from './tournament-follow.notices';
import { pushMatchUpdate, type MatchLike } from './live-push';

export interface PublicEventRow {
  id: string; title: string; slug: string | null; school_id: string | null; visibility: string | null;
  live_enabled: boolean; scoring_config: any; sport: string | null;
}

/** Misma regla que GET /public/:slug/live: un torneo «solo escuela» sin vivo no es público. */
export async function resolvePublicEvent(slug: string): Promise<PublicEventRow | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(slug)) return null;
  const { data } = await supabase.from('events')
    .select('id, title, slug, school_id, visibility, live_enabled, scoring_config, sport').eq('slug', slug).maybeSingle();
  const ev = data as PublicEventRow | null;
  if (!ev) return null;
  if (ev.visibility === 'school_only' && !ev.live_enabled) return null;
  return ev;
}

// ── Follows ──────────────────────────────────────────────────────────────────

export class FollowError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function listMyFollows(userId: string, eventId: string) {
  const { data } = await supabase.from('tournament_follows').select('id, team_id, created_at').eq('event_id', eventId).eq('user_id', userId);
  return (data ?? []) as Array<{ id: string; team_id: string | null; created_at: string }>;
}

export async function follow(userId: string, ev: PublicEventRow, teamId: string | null) {
  if (teamId) {
    const { data: t } = await supabase.from('event_teams').select('id').eq('id', teamId).eq('event_id', ev.id).maybeSingle();
    if (!t) throw new FollowError(404, 'equipo_no_encontrado', 'Ese equipo no es de este torneo.');
  }
  const mine = await listMyFollows(userId, ev.id);
  if (mine.some((f) => (f.team_id ?? null) === (teamId ?? null))) return { ok: true, already: true };
  if (mine.length >= 20) throw new FollowError(422, 'demasiados', 'Ya sigues 20 equipos de este torneo.');
  const { error } = await supabase.from('tournament_follows').insert({ event_id: ev.id, user_id: userId, team_id: teamId });
  if (error && !/duplicate/i.test(error.message)) throw new FollowError(500, 'error_guardando', 'No pudimos guardar. Intenta de nuevo.');
  return { ok: true, already: false };
}

export async function unfollow(userId: string, eventId: string, teamId: string | null) {
  let q = supabase.from('tournament_follows').delete().eq('event_id', eventId).eq('user_id', userId);
  q = teamId ? q.eq('team_id', teamId) : q.is('team_id', null);
  await q;
  return { ok: true };
}

// ── Destinatarios y envío ────────────────────────────────────────────────────

export interface NoticeItem { kind: NoticeKind; ev: NoticeEvent; match: NoticeMatch & { home_team_id: string | null; away_team_id: string | null } }

/**
 * Quién recibe cada aviso:
 *   - quien sigue el torneo completo o a uno de los dos equipos;
 *   - las familias y deportistas de la planilla de los dos equipos (salvo en «final»: a ellos ya
 *     les llega el aviso de resultado que manda `notifyMatchFinished` en tournament-live.service).
 */
export async function recipientsFor(items: NoticeItem[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (items.length === 0) return out;
  const evIds = [...new Set(items.map((i) => i.ev.id))];
  const teamIds = [...new Set(items.flatMap((i) => [i.match.home_team_id, i.match.away_team_id]).filter(Boolean) as string[])];
  const needMembers = items.some((i) => i.kind !== 'final');
  const [{ data: follows }, membersRes] = await Promise.all([
    supabase.from('tournament_follows').select('event_id, team_id, user_id').in('event_id', evIds),
    needMembers && teamIds.length
      ? supabase.from('event_team_members').select('team_id, profile_id, children:child_id(parent_id)').in('team_id', teamIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const members = (membersRes as any).data ?? [];
  for (const it of items) {
    const key = `${it.match.id}|${it.kind}`;
    const set = new Set<string>();
    const teams = new Set([it.match.home_team_id, it.match.away_team_id].filter(Boolean));
    for (const f of (follows ?? []) as any[]) {
      if (f.event_id === it.ev.id && (!f.team_id || teams.has(f.team_id))) set.add(f.user_id);
    }
    if (it.kind !== 'final') {
      for (const m of members as any[]) {
        if (!teams.has(m.team_id)) continue;
        const uid = m.profile_id || m.children?.parent_id;
        if (uid) set.add(uid);
      }
    }
    out.set(key, set);
  }
  return out;
}

/** Envía los avisos que aún no se mandaron (marca por partido+tipo). Devuelve cuántas notificaciones insertó. */
export async function sendMatchNotices(items: NoticeItem[], now: Date = new Date()): Promise<number> {
  if (items.length === 0) return 0;
  const recips = await recipientsFor(items);
  const withPeople = items.filter((i) => (recips.get(`${i.match.id}|${i.kind}`)?.size ?? 0) > 0);
  if (withPeople.length === 0) return 0;

  // ON CONFLICT DO NOTHING + RETURNING: solo vuelven las marcas nuevas → ese proceso envía.
  const { data: claimed, error } = await supabase.from('tournament_match_notices')
    .upsert(withPeople.map((i) => ({ match_id: i.match.id, kind: i.kind, recipients: recips.get(`${i.match.id}|${i.kind}`)!.size })),
      { onConflict: 'match_id,kind', ignoreDuplicates: true })
    .select('match_id, kind');
  if (error) { console.warn('[tournament-follow] marca de avisos:', error.message); return 0; }
  const won = new Set(((claimed ?? []) as any[]).map((r) => `${r.match_id}|${r.kind}`));

  const rows: any[] = [];
  for (const it of withPeople) {
    const key = `${it.match.id}|${it.kind}`;
    if (!won.has(key)) continue;
    const n = buildNotice(it.kind, it.ev, it.match, now);
    for (const user_id of recips.get(key)!) {
      rows.push({ user_id, title: n.title, message: n.message, type: 'info', category: 'tournament', link: n.link, data: n.data });
    }
  }
  if (rows.length === 0) return 0;
  // Un solo insert (por tandas de 500 para no armar un cuerpo gigante).
  for (let i = 0; i < rows.length; i += 500) {
    const { error: insErr } = await supabase.from('notifications').insert(rows.slice(i, i + 500));
    if (insErr) console.warn('[tournament-follow] insert de avisos:', insErr.message);
  }
  return rows.length;
}

// ── Enchufe tras cada acción del anotador ────────────────────────────────────

export interface AfterActionMatch extends MatchLike {
  home_team_id: string | null; away_team_id: string | null; home_name: string | null; away_name: string | null;
  court: string | null; scheduled_at: string | null; model?: 'goals' | 'sets';
}

/**
 * Lo llama `performMatchAction` (tournament-live.service) después de guardar una acción NO duplicada.
 * Un mensaje de tiempo real por acción (agrupado si llegan en ráfaga) y, si cambió el estado,
 * el aviso «Empezó…» / «Final…». Nunca lanza: lo en vivo no puede tumbar el anotador.
 */
export function onMatchActionApplied(
  ev: { id: string; title: string; slug: string | null; live: boolean },
  beforeStatus: string,
  after: AfterActionMatch,
  actionType?: string,
): void {
  try {
    const finished = (s: string) => s === 'played' || s === 'walkover';
    // Terminar / reabrir / corregir uno terminado mueve la tabla: el mensaje lo avisa para que la página
    // pública la pida ya (tournament-live.service descartó la caché de ese torneo antes de llamar aquí).
    if (ev.live) pushMatchUpdate(ev.slug, after, undefined, { standings: finished(beforeStatus) || finished(after.status) });
    // Deshacer / corregir acorta la secuencia de puntos: las estadísticas de los puntos que ya no
    // existen se borran (si no, un punto nuevo en la misma posición heredaría la etiqueta vieja).
    // Solo en esas acciones: un punto normal no escribe nada extra.
    if (actionType && ['undo', 'correct', 'reopen', 'walkover', 'cancel'].includes(actionType)) {
      const len = typeof (after as any).live_state?.points === 'string' ? (after as any).live_state.points.length : 0;
      Promise.resolve(supabase.from('tournament_player_stats').delete().eq('match_id', after.id).gte('point_index', len))
        .catch((e: any) => console.warn('[tournament-follow] limpiando estadísticas:', e?.message));
    }
    let kind: NoticeKind | null = null;
    if (ev.live && beforeStatus === 'scheduled' && after.status === 'live') kind = 'started';
    else if (!finished(beforeStatus) && finished(after.status)) kind = 'final';
    if (kind) {
      sendMatchNotices([{ kind, ev: { id: ev.id, title: ev.title, slug: ev.slug }, match: after }])
        .catch((e) => console.warn('[tournament-follow] aviso:', e?.message));
    }
  } catch (e: any) {
    console.warn('[tournament-follow] onMatchActionApplied:', e?.message);
  }
}

// ── Recordatorio «empieza en 15 min» ─────────────────────────────────────────

export const REMINDER_FROM_MIN = 10;
export const REMINDER_TO_MIN = 20;

export async function runStartingSoonReminders(now: Date = new Date()): Promise<{ matches: number; sent: number }> {
  const from = new Date(now.getTime() + REMINDER_FROM_MIN * 60000).toISOString();
  const to = new Date(now.getTime() + REMINDER_TO_MIN * 60000).toISOString();
  const { data } = await supabase.from('tournament_matches')
    .select('id, event_id, home_team_id, away_team_id, court, scheduled_at, status, home_score, away_score, '
      + 'home:home_team_id(team_name), away:away_team_id(team_name), event:event_id(id, title, slug)')
    .eq('status', 'scheduled').gte('scheduled_at', from).lt('scheduled_at', to).limit(300);
  const rows = ((data ?? []) as any[]).filter((m) => m.home_team_id && m.away_team_id && m.event);
  if (rows.length === 0) return { matches: 0, sent: 0 };
  const items: NoticeItem[] = rows.map((m) => ({
    kind: 'starting_soon',
    ev: { id: m.event.id, title: m.event.title, slug: m.event.slug },
    match: {
      id: m.id, home_team_id: m.home_team_id, away_team_id: m.away_team_id, home_name: m.home?.team_name ?? null,
      away_name: m.away?.team_name ?? null, court: m.court, scheduled_at: m.scheduled_at, home_score: null, away_score: null,
    },
  }));
  const sent = await sendMatchNotices(items, now);
  return { matches: rows.length, sent };
}

// ── «Hoy juega…» para el Inicio del acudiente y del deportista ───────────────

/** Inicio y fin del día en Bogotá (UTC-5, sin horario de verano). */
export function bogotaDayRange(now: Date): { start: string; end: string } {
  const b = new Date(now.getTime() - 5 * 3600000);
  const start = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), 5, 0, 0);
  return { start: new Date(start).toISOString(), end: new Date(start + 24 * 3600000).toISOString() };
}

export interface TodayMatch {
  match_id: string; event_title: string; slug: string | null; live_enabled: boolean;
  home_name: string | null; away_name: string | null; court: string | null; scheduled_at: string | null; status: string;
  home_score: number | null; away_score: number | null;
  /** Para quién de la familia es: { nombre de pila, relación }. */
  who: Array<{ first_name: string; relation: 'self' | 'hija' | 'hijo' | 'child' }>;
}

const firstName = (s: string | null | undefined) => {
  const w = String(s ?? '').trim().split(/\s+/)[0] ?? '';
  return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '';
};

export function relationFromGender(g: string | null | undefined): 'hija' | 'hijo' | 'child' {
  const v = String(g ?? '').trim().toLowerCase();
  if (['f', 'female', 'femenino', 'mujer', 'niña'].includes(v)) return 'hija';
  if (['m', 'male', 'masculino', 'hombre', 'niño'].includes(v)) return 'hijo';
  return 'child';
}

export async function myTodayMatches(userId: string, now: Date = new Date()): Promise<TodayMatch[]> {
  const { data: kids } = await supabase.from('children').select('id, full_name, gender').eq('parent_id', userId).limit(20);
  const kidIds = ((kids ?? []) as any[]).map((k) => k.id);
  const orFilter = [`profile_id.eq.${userId}`, ...(kidIds.length ? [`child_id.in.(${kidIds.join(',')})`] : [])].join(',');
  const { data: mem } = await supabase.from('event_team_members').select('team_id, profile_id, child_id, full_name').or(orFilter).limit(100);
  const members = (mem ?? []) as any[];
  if (members.length === 0) return [];
  const teamIds = [...new Set(members.map((m) => m.team_id))];
  const list = teamIds.join(',');
  const { start, end } = bogotaDayRange(now);
  const { data: ms } = await supabase.from('tournament_matches')
    .select('id, status, court, scheduled_at, home_score, away_score, home_team_id, away_team_id, '
      + 'home:home_team_id(team_name), away:away_team_id(team_name), event:event_id(title, slug, live_enabled)')
    .or(`home_team_id.in.(${list}),away_team_id.in.(${list})`)
    .in('status', ['scheduled', 'live', 'played'])
    .gte('scheduled_at', start).lt('scheduled_at', end)
    .order('scheduled_at').limit(20);
  const kidsById = new Map(((kids ?? []) as any[]).map((k) => [k.id, k]));
  return ((ms ?? []) as any[]).map((m) => {
    const teams = new Set([m.home_team_id, m.away_team_id]);
    const who = members.filter((x) => teams.has(x.team_id)).map((x) => {
      if (x.profile_id === userId) return { first_name: firstName(x.full_name), relation: 'self' as const };
      const k = kidsById.get(x.child_id);
      return { first_name: firstName(k?.full_name ?? x.full_name), relation: relationFromGender(k?.gender) };
    });
    const uniq = [...new Map(who.map((w) => [`${w.relation}:${w.first_name}`, w])).values()];
    return {
      match_id: m.id, event_title: m.event?.title ?? 'Torneo', slug: m.event?.slug ?? null, live_enabled: !!m.event?.live_enabled,
      home_name: m.home?.team_name ?? null, away_name: m.away?.team_name ?? null, court: m.court, scheduled_at: m.scheduled_at,
      status: m.status, home_score: m.home_score, away_score: m.away_score, who: uniq,
    };
  });
}
