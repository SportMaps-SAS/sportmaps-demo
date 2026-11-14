/**
 * Galería de formaciones de la pizarra (M6a de docs/specs/pizarra-m6-paridad-tacticalpad.md).
 *
 * Lógica pura, sin React (src/test/tacticalFormationGallery.test.ts):
 *  - el RIVAL en espejo: la formación se gira 180° alrededor del centro del
 *    tablero (todas las canchas están centradas en el viewBox), así el arquero
 *    rival queda en el arco de arriba y su «izquierda» en nuestra derecha;
 *  - el rival se representa como hoy en la pizarra: figuras `opponent` (un
 *    punto, x2/y2 = x1/y1) dentro de las figuras de la jugada. M6b le pone la
 *    configuración del equipo encima de esa misma representación;
 *  - familias (grupos) y filtros de la galería.
 *
 * El catálogo NO vive acá: fútbol 11 en tacticalFormations.ts, el resto en
 * tacticalSports.ts. Esto solo lo consulta.
 */
import type { TacticalArrow } from './footballQueries';
import { sportDef, type CourtRectPct, type TacticalSport } from './tacticalSports';

export interface GalleryFormation {
  key: string;
  label: string;
  players: number;
  slots: { x: number; y: number; label: string }[];
  /** Familia en la galería: «Clásicas», «Zonas», «Rotaciones 5-1»… */
  group?: string;
  /** Una línea: qué es y cuándo se usa. */
  description?: string;
}

/** Familia por defecto de una formación sin `group` (formaciones viejas o de
 *  un catálogo que todavía no las agrupa). */
export const DEFAULT_GROUP = 'Formaciones';

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Punto en espejo (giro de 180° alrededor del centro del tablero). */
export const mirrorPoint = (p: { x: number; y: number }) => ({ x: round1(100 - p.x), y: round1(100 - p.y) });

/** Figuras `opponent` del rival en espejo, en el orden de la formación. */
export function rivalShapesFor(formation: Pick<GalleryFormation, 'slots'>): TacticalArrow[] {
  return formation.slots.map((s) => {
    const p = mirrorPoint(s);
    return { type: 'opponent', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: 'red' };
  });
}

export const isRivalShape = (a: TacticalArrow) => a.type === 'opponent';

/** Cuántos rivales hay en la cancha. */
export const countRivals = (shapes: TacticalArrow[]) => shapes.filter(isRivalShape).length;

/**
 * Pone al rival en una formación: saca los rivales que ya estaban (si no, al
 * cambiar de formación quedarían dos equipos rivales) y agrega los nuevos al
 * final. El resto de las figuras (flechas, material, texto) no se toca.
 */
export function replaceRivalShapes(shapes: TacticalArrow[], formation: Pick<GalleryFormation, 'slots'>): TacticalArrow[] {
  return [...shapes.filter((a) => !isRivalShape(a)), ...rivalShapesFor(formation)];
}

/** Quita a todos los rivales. */
export const removeRivalShapes = (shapes: TacticalArrow[]) => shapes.filter((a) => !isRivalShape(a));

/** Orden de las familias en la galería; las que no están aquí van al final,
 *  en el orden del catálogo. */
export const GROUP_ORDER = [
  'Básicas', 'Clásicas', 'Modernas', 'Rotaciones 5-1', 'Rotaciones 4-2', 'Rotaciones 6-2',
  'Defensas', 'Zonas', 'Presiones', 'Defensivas', 'Ofensivas', 'Especiales', 'Históricas', 'Fútbol 7',
];

/** Familias presentes, en el orden de GROUP_ORDER. */
export function formationGroups(formations: GalleryFormation[]): string[] {
  const out: string[] = [];
  for (const f of formations) {
    const g = f.group ?? DEFAULT_GROUP;
    if (!out.includes(g)) out.push(g);
  }
  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i < 0 ? GROUP_ORDER.length : i;
  };
  return out
    .map((g, i) => ({ g, i }))
    .sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)
    .map((x) => x.g);
}

/** Cantidades de jugadores distintas (fútbol 11 trae también la de F7). */
export const playerCounts = (formations: GalleryFormation[]) =>
  [...new Set(formations.map((f) => f.players))].sort((a, b) => b - a);

const normalize = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export interface GalleryFilter {
  query?: string;
  group?: string | null;
  players?: number | null;
}

/** Filtro de la galería: texto (nombre, familia, descripción o posición; sin
 *  tildes ni mayúsculas, y «433» encuentra «4-3-3»), familia y jugadores. */
export function filterFormations<T extends GalleryFormation>(formations: T[], filter: GalleryFilter): T[] {
  const q = normalize(filter.query ?? '').trim();
  const qDigits = q.replace(/[^0-9]/g, '');
  return formations.filter((f) => {
    if (filter.group && (f.group ?? DEFAULT_GROUP) !== filter.group) return false;
    if (filter.players && f.players !== filter.players) return false;
    if (!q) return true;
    const hay = normalize([f.label, f.group ?? '', f.description ?? '', ...f.slots.map((s) => s.label)].join(' '));
    if (hay.includes(q)) return true;
    // «433» o «4 3 3» → «4-3-3»: solo si lo escrito son cifras.
    return qDigits.length >= 2 && qDigits === q.replace(/[\s-]/g, '') && f.label.replace(/[^0-9]/g, '').includes(qDigits);
  });
}

// ─── Modalidad de la cancha (F11 / F7 / F5) ─────────────────────────────────

/** Catálogos de fútbol chico que se ofrecen también en la cancha de fútbol 11
 *  (equipo «Fútbol» que juega F7 o F5 en una cancha grande). */
const SMALL_FOOTBALL: { sport: 'futbol7' | 'futbol5'; players: number }[] = [
  { sport: 'futbol7', players: 7 },
  { sport: 'futbol5', players: 5 },
];

/** Pasa un punto del rectángulo de juego `from` al `to` (los dos en % del tablero). */
function remapPoint(p: { x: number; y: number }, from: CourtRectPct, to: CourtRectPct) {
  const fx = (p.x - from.x0) / Math.max(0.01, from.x1 - from.x0);
  const fy = (p.y - from.y0) / Math.max(0.01, from.y1 - from.y0);
  return { x: round1(to.x0 + fx * (to.x1 - to.x0)), y: round1(to.y0 + fy * (to.y1 - to.y0)) };
}

/**
 * Formaciones que ofrece la galería. En fútbol 11 suma las de fútbol 7 y
 * fútbol 5 (llevadas a la cancha grande), para que un equipo que juega F7
 * no vea solo las de 11: antes la galería decía «38 formaciones de Fútbol 11»
 * y traía una sola de 7. Las que ya están (misma etiqueta y jugadores) no se
 * repiten. Los demás deportes ya traen su catálogo propio: no se tocan.
 */
export function galleryFormations<T extends GalleryFormation>(sport: TacticalSport, formations: T[]): (T | GalleryFormation)[] {
  if (sport !== 'futbol') return formations;
  const big = sportDef('futbol').court;
  const norm = (label: string) => label.replace(/^F\d+\s*·?\s*/i, '').replace(/\s*\(F\d+\)\s*$/i, '').trim();
  const seen = new Set(formations.map((f) => `${f.players}|${norm(f.label)}`));
  const extra: GalleryFormation[] = [];
  for (const { sport: small } of SMALL_FOOTBALL) {
    const def = sportDef(small);
    for (const f of def.formations) {
      const id = `${f.players}|${norm(f.label)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      extra.push({
        ...f,
        key: `${small}:${f.key}`,
        group: f.group ? `${def.label} · ${f.group}` : def.label,
        slots: f.slots.map((s) => ({ ...remapPoint(s, def.court, big), label: s.label })),
      });
    }
  }
  return [...formations, ...extra];
}

/**
 * Con qué filtro de jugadores abre la galería: la modalidad de la cancha.
 * Manda la formación puesta; si no hay, cuántos hay en cancha (si coincide con
 * una modalidad del catálogo); si no, la formación con la que arrancaría la
 * cancha vacía. Con un solo tamaño en el catálogo no se filtra (null).
 */
export function initialPlayersFilter(
  formations: GalleryFormation[],
  ctx: { currentKey?: string | null; onPitch?: number; defaultPlayers?: number | null },
): number | null {
  const counts = playerCounts(formations);
  if (counts.length < 2) return null;
  const current = ctx.currentKey ? formations.find((f) => f.key === ctx.currentKey) : undefined;
  if (current) return current.players;
  if (ctx.onPitch && counts.includes(ctx.onPitch)) return ctx.onPitch;
  if (ctx.defaultPlayers && counts.includes(ctx.defaultPlayers)) return ctx.defaultPlayers;
  return null;
}

/** «12 formaciones de Fútbol 7»: el subtítulo dice la modalidad que se ve. */
export function galleryCaption(sport: TacticalSport, count: number, players: number | null): string {
  const noun = count === 1 ? 'formación' : 'formaciones';
  const isFootball = sport === 'futbol' || sport === 'futbol7' || sport === 'futbol5';
  const what = isFootball && players ? `Fútbol ${players}` : players ? `${sportDef(sport).label} · ${players} jugadores` : sportDef(sport).label;
  return `${count} ${noun} de ${what}`;
}
