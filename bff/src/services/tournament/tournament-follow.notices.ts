/**
 * Piezas PURAS de «seguir torneo» y lo social (sin base): textos de los avisos, calendario .ics,
 * nombre público de una jugadora y filtro de groserías. Probadas en tournament-follow.notices.test.ts.
 */

export type NoticeKind = 'starting_soon' | 'started' | 'final';

export interface NoticeMatch {
  id: string;
  home_name: string | null;
  away_name: string | null;
  court: string | null;
  scheduled_at: string | null;
  home_score: number | null;
  away_score: number | null;
  sets?: Array<{ home: number; away: number; closed: boolean }> | null;
  model?: 'goals' | 'sets';
}

export interface NoticeEvent { id: string; title: string; slug: string | null }

export interface Notice { title: string; message: string; link: string; data: Record<string, unknown> }

const name = (n: string | null | undefined, fallback: string) => (n && n.trim()) || fallback;

/** «Cancha 3» → «la cancha 3»; texto libre se deja tal cual. */
export function courtPhrase(court: string | null | undefined): string | null {
  if (!court || !court.trim()) return null;
  const c = court.trim();
  return /^cancha\b/i.test(c) ? `la ${c.charAt(0).toLowerCase()}${c.slice(1)}` : c;
}

export function liveLink(ev: NoticeEvent): string {
  return ev.slug ? `/torneo/${ev.slug}/en-vivo` : `/tournaments/${ev.id}/results`;
}

/** «Final: Monsters 2-0 Orange (25-22, 25-20)». El ganador va primero y los sets desde su lado. */
export function finalLine(m: NoticeMatch): string {
  const hs = m.home_score ?? 0;
  const as = m.away_score ?? 0;
  const homeWins = hs >= as;
  const [wn, ln, ws, ls] = homeWins
    ? [name(m.home_name, 'Local'), name(m.away_name, 'Visitante'), hs, as]
    : [name(m.away_name, 'Visitante'), name(m.home_name, 'Local'), as, hs];
  const closed = (m.sets ?? []).filter((s) => s.closed);
  const detail = m.model === 'sets' && closed.length
    ? ` (${closed.map((s) => (homeWins ? `${s.home}-${s.away}` : `${s.away}-${s.home}`)).join(', ')})`
    : '';
  if (hs === as) return `Final: ${name(m.home_name, 'Local')} ${hs}-${as} ${name(m.away_name, 'Visitante')}`;
  return `Final: ${wn} ${ws}-${ls} ${ln}${detail}`;
}

export function buildNotice(kind: NoticeKind, ev: NoticeEvent, m: NoticeMatch, now: Date = new Date()): Notice {
  const vs = `${name(m.home_name, 'Local')} vs ${name(m.away_name, 'Visitante')}`;
  const where = courtPhrase(m.court);
  const link = liveLink(ev);
  const data = { eventId: ev.id, matchId: m.id, kind };
  if (kind === 'starting_soon') {
    const mins = m.scheduled_at ? Math.max(1, Math.round((Date.parse(m.scheduled_at) - now.getTime()) / 60000)) : 15;
    return {
      title: '⏰ Tu partido empieza pronto',
      message: `${vs} empieza en ${mins} min${where ? ` en ${where}` : ''}. ${ev.title}.`,
      link, data,
    };
  }
  if (kind === 'started') {
    return { title: `🏐 Empezó ${vs}`, message: `${where ? `${where.charAt(0).toUpperCase()}${where.slice(1)} · ` : ''}Síguelo en vivo en ${ev.title}.`, link, data };
  }
  return { title: '🏆 Resultado final', message: `${finalLine(m)}. ${ev.title}.`, link, data };
}

// ── Calendario .ics (para seguir sin cuenta) ─────────────────────────────────

const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Pliega líneas a 75 octetos (RFC 5545 §3.1). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, 'utf8') > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

export interface IcsMatch extends NoticeMatch { status: string; home_team_id: string | null; away_team_id: string | null }

export function buildIcs(ev: NoticeEvent, matches: IcsMatch[], opts: { teamId?: string | null; origin: string; durationMin?: number; now?: Date }): string {
  const dur = (opts.durationMin ?? 60) * 60000;
  const stamp = icsDate(opts.now ?? new Date());
  const url = `${opts.origin.replace(/\/$/, '')}${liveLink(ev)}`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SportMaps//Torneos en vivo//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(ev.title)}`, 'X-WR-TIMEZONE:America/Bogota'];
  for (const m of matches) {
    if (!m.scheduled_at || m.status === 'cancelled') continue;
    if (opts.teamId && m.home_team_id !== opts.teamId && m.away_team_id !== opts.teamId) continue;
    if (!m.home_team_id && !m.away_team_id) continue;
    const start = new Date(m.scheduled_at);
    if (Number.isNaN(start.getTime())) continue;
    lines.push('BEGIN:VEVENT', `UID:${m.id}@torneos.sportmaps.co`, `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(new Date(start.getTime() + dur))}`,
      `SUMMARY:${icsEscape(`${name(m.home_name, 'Por definir')} vs ${name(m.away_name, 'Por definir')}`)}`,
      ...(m.court ? [`LOCATION:${icsEscape(m.court)}`] : []),
      `DESCRIPTION:${icsEscape(`${ev.title} · Marcador en vivo: ${url}`)}`, `URL:${url}`,
      'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape('Tu partido empieza en 15 min')}`, 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// ── Nombre público de una jugadora ───────────────────────────────────────────

/**
 * Lo único que sale a lo público de una jugadora: el nombre de pila. Solo si se sabe que es
 * mayor de edad se agrega la inicial del apellido (sin año de nacimiento = se trata como menor).
 * La planilla (`event_team_members`) no tiene número de camiseta: si algún día lo tiene, va
 * como `#7` después del nombre, también para menores.
 */
export function publicPlayerName(fullName: string | null | undefined, birthYear: number | null | undefined, opts: { year?: number; number?: string | number | null } = {}): string {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase() : 'Jugadora';
  const year = opts.year ?? new Date().getFullYear();
  const adult = typeof birthYear === 'number' && birthYear > 1900 && year - birthYear >= 18;
  const initial = adult && parts.length > 1 ? ` ${parts[parts.length - 1].charAt(0).toUpperCase()}.` : '';
  const num = opts.number != null && String(opts.number).trim() !== '' ? ` #${String(opts.number).trim()}` : '';
  return `${first}${initial}${num}`;
}

// ── Filtro de groserías (básico) ─────────────────────────────────────────────

const BAD = [
  'hijueputa', 'hijuepucha', 'hp', 'hpta', 'gonorrea', 'malparido', 'malparida', 'marica', 'puta', 'puto', 'pirobo', 'piroba',
  'careverga', 'verga', 'mierda', 'culo', 'perra', 'zorra', 'imbecil', 'idiota', 'estupido', 'estupida', 'maldito', 'maldita',
  'chimba', 'carechimba', 'mamaguevo', 'mamahuevo', 'cabron', 'pendejo', 'pendeja', 'coño', 'joder', 'fuck', 'shit', 'bitch',
];

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[0@]/g, 'o').replace(/[1!]/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/\$/g, 's');

const BAD_SET = new Set(BAD.map(norm));

/** true si el texto tiene una grosería de la lista (por palabra, ignorando tildes y leet básico). */
export function hasProfanity(text: string): boolean {
  const words = norm(text).split(/[^a-zñ]+/).filter(Boolean);
  return words.some((w) => BAD_SET.has(w) || BAD_SET.has(w.replace(/(.)\1+/g, '$1')));
}

/** Validación de un comentario. Devuelve el mensaje de error o null. */
export function validateComment(authorName: unknown, body: unknown): string | null {
  const n = typeof authorName === 'string' ? authorName.trim() : '';
  const b = typeof body === 'string' ? body.trim() : '';
  if (n.length < 2 || n.length > 40) return 'Escribe un nombre de 2 a 40 letras.';
  if (b.length < 1) return 'Escribe tu comentario.';
  if (b.length > 500) return 'El comentario puede tener hasta 500 caracteres.';
  if (/https?:\/\/|www\./i.test(b)) return 'Los comentarios no pueden tener enlaces.';
  if (hasProfanity(n) || hasProfanity(b)) return 'Tu comentario tiene palabras que no se permiten. Cámbialo y envíalo de nuevo.';
  return null;
}

/** Enlaces de video aceptados para un post (los mismos hosts que la transmisión). */
const VIDEO_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'facebook.com', 'www.facebook.com', 'fb.watch', 'vimeo.com', 'player.vimeo.com', 'www.instagram.com', 'instagram.com', 'www.tiktok.com', 'tiktok.com'];
export function validVideoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && VIDEO_HOSTS.includes(u.hostname.toLowerCase()) ? u.toString() : null;
  } catch { return null; }
}
