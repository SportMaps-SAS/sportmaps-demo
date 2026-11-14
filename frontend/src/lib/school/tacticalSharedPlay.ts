/**
 * Jugada compartida por enlace (/jugada/:token): lo que se guarda y lo que se
 * muestra en la vista pública de solo lectura. Lógica pura (src/test/tacticalSharedPlay.test.ts).
 *
 * PRIVACIDAD: el enlace lo abre cualquiera. Nunca viajan nombres de
 * deportistas ni sus ids: cada jugador pasa a ser p1…pn, con su dorsal o, sin
 * dorsal, las iniciales de su etiqueta (la etiqueta pudo ser renombrada a mano
 * con el nombre del jugador). Sin notas ni videos. La RPC de creación además
 * borra 'playerNames', 'notes' y 'videos' si llegaran.
 */
import type { TacticalArrow } from './footballQueries';
import type { TacticalFrame } from './tacticalFrames';
import type { TacticalSport } from './tacticalSports';
import { isTacticalSport } from './tacticalSports';
import type { TacticalTeamsConfig } from './tacticalTeams';

export interface SharedPlayPayload {
  v: 1;
  sport: TacticalSport | null;
  frames: TacticalFrame[];
  /** Clave pública (p1…) → iniciales (solo si no hay dorsal). */
  labels: Record<string, string>;
  jerseys: Record<string, number | null>;
  teams: TacticalTeamsConfig | null;
}

export interface SharedPlay {
  title: string;
  sport: TacticalSport | null;
  payload: SharedPlayPayload;
  createdAt: string | null;
}

/** Lo que la pizarra entrega (subconjunto de TacticalExportInput). */
export interface SharedPlaySource {
  sport?: TacticalSport | null;
  frames: TacticalFrame[] | null;
  players: { x: number; y: number; label?: string; jersey?: number | null }[];
  arrows: TacticalArrow[];
  playerLabels?: Record<string, string>;
  playerJerseys?: Record<string, number | null>;
  teams?: TacticalTeamsConfig | null;
}

/** «Defensa central izq.» → «DC»; «Juan Pérez» → «JP»; «Arquero» → «ARQ». */
export function initialsOf(label: string | null | undefined): string {
  const words = (label || '').replace(/[.()·,-]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

const finiteOr = (n: unknown, d: number | null) => {
  if (n == null || n === '') return d;
  const v = Number(n);
  return Number.isFinite(v) ? v : d;
};

/** Configuración de equipos sin nada que muestre nombres de nuestros atletas. */
function publicTeams(teams: TacticalTeamsConfig | null | undefined): TacticalTeamsConfig | null {
  if (!teams) return null;
  const home = teams.home.caption === 'name' ? { ...teams.home, caption: 'initials' as const } : teams.home;
  return { ...teams, home, export_names: false };
}

/**
 * Arma lo que se guarda para el enlace. Con un solo cuadro (sin `frames`) lo
 * arma desde lo que se ve; con varios, remapea las claves de todos.
 */
export function buildSharedPlayPayload(src: SharedPlaySource): SharedPlayPayload {
  const labels: Record<string, string> = {};
  const jerseys: Record<string, number | null> = {};
  let frames: TacticalFrame[];

  if (src.frames && src.frames.length > 0) {
    const keyOf = new Map<string, string>();
    const pub = (k: string) => {
      let p = keyOf.get(k);
      if (!p) {
        p = `p${keyOf.size + 1}`;
        keyOf.set(k, p);
        const jersey = finiteOr(src.playerJerseys?.[k], null);
        jerseys[p] = jersey;
        if (jersey == null) labels[p] = initialsOf(src.playerLabels?.[k]);
      }
      return p;
    };
    frames = src.frames.map((f, i) => {
      const players = (f.players || []).map((pl) => ({ key: pub(pl.key), x: Number(pl.x), y: Number(pl.y) }));
      const owner = f.ball_owner && keyOf.has(f.ball_owner) ? keyOf.get(f.ball_owner)! : (f.ball_owner ? pub(f.ball_owner) : null);
      return {
        id: `f${i + 1}`,
        duration_ms: f.duration_ms,
        players,
        ball: f.ball ?? null,
        arrows: f.arrows || [],
        ...(owner ? { ball_owner: owner } : {}),
      };
    });
  } else {
    const players = (src.players || []).map((pl, i) => {
      const key = `p${i + 1}`;
      const jersey = finiteOr(pl.jersey, null);
      jerseys[key] = jersey;
      if (jersey == null) labels[key] = initialsOf(pl.label);
      return { key, x: Number(pl.x), y: Number(pl.y) };
    });
    frames = [{ id: 'f1', duration_ms: 1200, players, ball: null, arrows: src.arrows || [] }];
  }

  return { v: 1, sport: src.sport ?? null, frames, labels, jerseys, teams: publicTeams(src.teams) };
}

/** Respuesta de get_tactical_shared_play → jugada (o null si no sirve). */
export function parseSharedPlay(raw: unknown): SharedPlay | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const p = r.payload as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || !Array.isArray(p.frames) || p.frames.length === 0) return null;
  const frames = (p.frames as TacticalFrame[]).filter((f) => f && Array.isArray(f.players));
  if (frames.length === 0) return null;
  const sportRaw = (r.sport ?? p.sport) as string | null | undefined;
  const sport = isTacticalSport(sportRaw) ? sportRaw : null;
  return {
    title: typeof r.title === 'string' ? r.title : '',
    sport,
    createdAt: typeof r.created_at === 'string' ? r.created_at : null,
    payload: {
      v: 1,
      sport,
      frames: frames.map((f) => ({ ...f, arrows: Array.isArray(f.arrows) ? f.arrows : [], ball: f.ball ?? null })),
      labels: (p.labels && typeof p.labels === 'object' ? p.labels : {}) as Record<string, string>,
      jerseys: (p.jerseys && typeof p.jerseys === 'object' ? p.jerseys : {}) as Record<string, number | null>,
      teams: (p.teams && typeof p.teams === 'object' ? p.teams : null) as TacticalTeamsConfig | null,
    },
  };
}

/** Dominio de la app web. En la app nativa (capacitor://, file://) el origen
 *  no sirve para un enlace: se usa el de producción. */
export const PUBLIC_WEB_ORIGIN = 'https://app.sportmaps.co';
export function publicOrigin(origin: string | null | undefined): string {
  return origin && /^https?:\/\//i.test(origin) && !/^https?:\/\/localhost(:\d+)?$/i.test(origin) ? origin : PUBLIC_WEB_ORIGIN;
}

/** URL pública de la jugada. */
export function sharedPlayUrl(origin: string, token: string): string {
  return `${publicOrigin(origin).replace(/\/+$/, '')}/jugada/${encodeURIComponent(token)}`;
}

/** Texto del mensaje de WhatsApp. */
export function sharedPlayMessage(title: string | null | undefined, url: string): string {
  const t = (title || '').trim();
  return `${t ? `Mira esta jugada: ${t}` : 'Mira esta jugada'} 👉 ${url}`;
}

/** Mensaje en palabras para cada error de la RPC de creación. */
export function sharedPlayErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case 'not_allowed': return 'Tu rol no puede compartir jugadas de este equipo.';
    case 'too_large': return 'La jugada es muy grande para compartirla por enlace. Quita algunos cuadros.';
    case 'rate_limited': return 'Compartiste muchas jugadas hoy. Inténtalo mañana.';
    case 'not_authenticated': return 'Tu sesión se cerró. Vuelve a entrar.';
    default: return 'No se pudo crear el enlace. Inténtalo de nuevo.';
  }
}
