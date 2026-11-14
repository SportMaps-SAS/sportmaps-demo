/**
 * Calendario del acudiente (rediseño V2): lógica pura, sin React ni Supabase,
 * para poder probarla. Arma la agenda «Próximos» con lo que ya existe:
 *  - `calendar_events` (lo que publica la escuela o el profe, más lo propio);
 *  - el horario fijo de cada equipo (`teams.schedule`), convertido en entrenos
 *    de los próximos días.
 * No hay tabla de festivos ni de cancelaciones: un aviso de la escuela es un
 * evento sin equipo (team_id null) y, si su título dice «festivo», «cancelado»
 * o «no hay entreno», ese día no se inventan entrenos del horario fijo.
 */

export type AgendaKind = 'training' | 'match' | 'tournament' | 'notice' | 'other';

export interface ChildLite {
  id: string;
  name: string;
  schoolId: string | null;
  teamIds: string[];
}

export interface TeamLite {
  id: string;
  name: string;
  schoolId: string | null;
  location: string | null;
  coachName: string | null;
  schedule: unknown;
}

export interface CalendarEventLite {
  id: string;
  title: string;
  description?: string | null;
  event_type: string | null;
  start_time: string;
  end_time?: string | null;
  location?: string | null;
  all_day?: boolean | null;
  team_id?: string | null;
  school_id?: string | null;
  user_id?: string | null;
}

export interface AgendaItem {
  key: string;
  start: Date;
  allDay: boolean;
  kind: AgendaKind;
  /** «Entreno · Sofía» */
  title: string;
  /** «Fútbol Sub 11 · Cancha 2 · Profe Laura» */
  subtitle: string | null;
  /** Etiqueta a la derecha: «Partido», «Torneo», «Aviso». */
  tag: string | null;
  /** Nota corta del evento («Llevar el uniforme azul»). */
  note: string | null;
  // ── Para el detalle al tocar la fila (opcionales) ──
  /** Equipo del evento: con él se encuentra la convocatoria del partido. */
  teamId?: string | null;
  /** Hijos a los que aplica. */
  childIds?: string[];
  end?: Date | null;
  /** Lugar completo (sin mezclar con el equipo ni el profe). */
  location?: string | null;
  /** Descripción completa del evento (la nota es solo la primera línea). */
  description?: string | null;
}

export interface AgendaDay {
  dayKey: string;
  label: string;
  items: AgendaItem[];
}

// ─── Fechas ──────────────────────────────────────────────────────────────────
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** «Hoy · jueves 8», «Mañana · viernes 9», «Sábado 10», «Lunes 2 de noviembre». */
export function dayLabel(day: Date, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  const base = `${WEEKDAYS[d.getDay()]} ${d.getDate()}`;
  if (diff === 0) return `Hoy · ${base}`;
  if (diff === 1) return `Mañana · ${base}`;
  const withMonth = d.getMonth() !== today.getMonth() ? `${base} de ${MONTHS[d.getMonth()]}` : base;
  return cap(withMonth);
}

/** «4:00» + «p. m.» por separado, como en el diseño. */
export function timeParts(d: Date): { time: string; period: string } {
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { time: `${h12}:${String(d.getMinutes()).padStart(2, '0')}`, period: h >= 12 ? 'p. m.' : 'a. m.' };
}

/** «domingo 18 de octubre» */
export function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const [y, m, dd] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !dd) return null;
  const d = new Date(y, m - 1, dd);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
}

// ─── Horario fijo de los equipos ─────────────────────────────────────────────
const DAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, 'miércoles': 3, jueves: 4, viernes: 5, sabado: 6, 'sábado': 6,
};

export interface ScheduleSlot { dow: number; hh: number; mm: number }

/**
 * `teams.schedule` es jsonb y en la base conviven varias formas (ver
 * lib/api/schools.ts). Se entienden las dos de array:
 *   [{ day: 'monday', start_time: '16:00' }]  y  [{ day: 2, time: '16:00' }]
 * Lo demás (texto libre, objeto por día) se ignora: mejor no mostrar un
 * entreno que mostrar uno a la hora equivocada.
 */
export function parseTeamSchedule(schedule: unknown): ScheduleSlot[] {
  if (!Array.isArray(schedule)) return [];
  const out: ScheduleSlot[] = [];
  for (const s of schedule) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    let dow: number | null = null;
    if (typeof r.day === 'number' && Number.isInteger(r.day)) dow = r.day;
    else if (typeof r.day === 'string') {
      const k = r.day.trim().toLowerCase();
      dow = k in DAY_INDEX ? DAY_INDEX[k] : /^\d$/.test(k) ? Number(k) : null;
    }
    if (dow === null || dow < 0 || dow > 6) continue;
    const raw = typeof r.start_time === 'string' ? r.start_time : typeof r.time === 'string' ? r.time : null;
    const m = raw ? /^(\d{1,2}):(\d{2})/.exec(raw.trim()) : null;
    if (!m) continue;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) continue;
    out.push({ dow, hh, mm });
  }
  return out;
}

// ─── Armado de la agenda ─────────────────────────────────────────────────────
const NO_TRAINING_RE = /festivo|cancelad|no hay entreno|suspendid/i;

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

function firstName(full: string | null | undefined): string | null {
  const n = (full || '').trim().split(/\s+/)[0];
  return n || null;
}

function shortNote(desc: string | null | undefined): string | null {
  const line = (desc || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > 90 ? `${line.slice(0, 87)}…` : line;
}

function sub(parts: (string | null | undefined)[]): string | null {
  const s = parts.filter((p) => p && String(p).trim()).join(' · ');
  return s || null;
}

export function buildAgenda(params: {
  children: ChildLite[];
  teams: TeamLite[];
  events: CalendarEventLite[];
  now: Date;
  days: number;
  userId?: string | null;
}): AgendaItem[] {
  const { children, teams, events, now, days, userId } = params;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + days);

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const kidsOfTeam = (teamId: string) => children.filter((c) => c.teamIds.includes(teamId));
  const kidsOfSchool = (schoolId: string) => children.filter((c) => c.schoolId === schoolId);

  const items: AgendaItem[] = [];
  // Días en que el profe ya publicó el entreno del equipo, o la escuela/equipo avisó que no hay.
  const trainingPublished = new Set<string>();
  const noTrainingTeam = new Set<string>();
  const noTrainingSchool = new Set<string>();

  for (const ev of events) {
    const d = new Date(ev.start_time);
    if (Number.isNaN(d.getTime()) || d < start || d >= end) continue;
    const dk = localDayKey(d);
    const team = ev.team_id ? teamById.get(ev.team_id) : undefined;
    const kids = ev.team_id ? kidsOfTeam(ev.team_id) : ev.school_id ? kidsOfSchool(ev.school_id) : [];
    const names = joinNames(kids.map((k) => k.name));
    const isNotice = !ev.team_id && !!ev.school_id;
    const type = ev.event_type || 'other';

    if (ev.team_id && type === 'training') trainingPublished.add(`${ev.team_id}|${dk}`);
    if (NO_TRAINING_RE.test(ev.title || '')) {
      if (ev.team_id) noTrainingTeam.add(`${ev.team_id}|${dk}`);
      else if (ev.school_id) noTrainingSchool.add(`${ev.school_id}|${dk}`);
    }

    let kind: AgendaKind = 'other';
    let title = ev.title;
    let subtitle: string | null;
    let tag: string | null = null;
    const coach = team?.coachName ? `Profe ${firstName(team.coachName)}` : null;

    if (isNotice) {
      kind = 'notice';
      subtitle = 'Aviso de la escuela';
      tag = null;
    } else if (type === 'training') {
      kind = 'training';
      title = names ? `Entreno · ${names}` : ev.title || 'Entreno';
      subtitle = sub([team?.name, ev.location || team?.location, coach]);
    } else if (type === 'match') {
      kind = 'match';
      title = names ? `Partido · ${names}` : 'Partido';
      subtitle = sub([ev.title, ev.location || team?.location]);
      tag = 'Partido';
    } else if (type === 'competition') {
      kind = 'tournament';
      title = names ? `${ev.title} · ${names}` : ev.title;
      subtitle = sub([team?.name, ev.location]);
      tag = 'Torneo';
    } else {
      title = names && ev.team_id ? `${ev.title} · ${names}` : ev.title;
      subtitle = sub([team?.name, ev.location]);
      if (!ev.team_id && !ev.school_id && ev.user_id && ev.user_id === userId) tag = 'Tuyo';
    }

    const fin = ev.end_time ? new Date(ev.end_time) : null;
    items.push({
      key: `ev-${ev.id}`,
      start: d,
      allDay: !!ev.all_day,
      kind,
      title,
      subtitle,
      tag,
      note: shortNote(ev.description),
      teamId: ev.team_id ?? null,
      childIds: kids.map((k) => k.id),
      end: fin && !Number.isNaN(fin.getTime()) ? fin : null,
      location: ev.location || team?.location || null,
      description: (ev.description ?? '').trim() || null,
    });
  }

  // Entrenos del horario fijo: uno por equipo y día, con todos los hijos del equipo.
  for (const team of teams) {
    const kids = kidsOfTeam(team.id);
    if (kids.length === 0) continue;
    const slots = parseTeamSchedule(team.schedule);
    if (slots.length === 0) continue;
    for (let i = 0; i < days; i++) {
      const day = new Date(start);
      day.setDate(day.getDate() + i);
      const dk = localDayKey(day);
      if (trainingPublished.has(`${team.id}|${dk}`)) continue;
      if (noTrainingTeam.has(`${team.id}|${dk}`)) continue;
      if (team.schoolId && noTrainingSchool.has(`${team.schoolId}|${dk}`)) continue;
      for (const s of slots.filter((x) => x.dow === day.getDay())) {
        const at = new Date(day);
        at.setHours(s.hh, s.mm, 0, 0);
        items.push({
          key: `sch-${team.id}-${dk}-${s.hh}${s.mm}`,
          start: at,
          allDay: false,
          kind: 'training',
          title: `Entreno · ${joinNames(kids.map((k) => k.name))}`,
          subtitle: sub([team.name, team.location, team.coachName ? `Profe ${firstName(team.coachName)}` : null]),
          tag: null,
          note: null,
          teamId: team.id,
          childIds: kids.map((k) => k.id),
          end: null,
          location: team.location,
          description: null,
        });
      }
    }
  }

  return items.sort((a, b) => {
    const t = a.start.getTime() - b.start.getTime();
    if (t !== 0) return t;
    // Mismo instante: el aviso de todo el día primero.
    return Number(b.allDay) - Number(a.allDay);
  });
}

/** Agrupa por día local, en orden, con su etiqueta. */
export function groupByDay(items: AgendaItem[], now: Date): AgendaDay[] {
  const out: AgendaDay[] = [];
  for (const it of [...items].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const dk = localDayKey(it.start);
    let day = out.find((d) => d.dayKey === dk);
    if (!day) {
      day = { dayKey: dk, label: dayLabel(it.start, now), items: [] };
      out.push(day);
    }
    day.items.push(it);
  }
  return out;
}

/** ¿Usa /calendar la vista V2 del acudiente? Solo el rol activo `parent`. */
export function usesParentCalendarV2(activeRole: string | null | undefined, profileRole: string | null | undefined): boolean {
  if (activeRole) return activeRole === 'parent';
  return profileRole === 'parent';
}
