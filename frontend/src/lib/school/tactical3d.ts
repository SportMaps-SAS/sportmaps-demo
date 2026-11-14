/**
 * Visor 3D de la pizarra (fase M4, decisión D5 de
 * docs/specs/pizarra-multideporte-3d-ia.md). Lógica PURA, sin three.js ni
 * React (las pruebas de unidad no necesitan un canvas). Solo la importa el
 * chunk del visor; lo que necesita la pizarra ANTES de cargarlo (¿hay WebGL2?,
 * armar la entrada) vive en tactical3dLaunch.ts, para no engordar su chunk.
 *
 * Ejes del mundo 3D (metros): origen en el CENTRO de la cancha, x a lo ancho
 * (derecha del tablero = +x), z a lo largo (arco propio, abajo en el tablero
 * = +z), y hacia arriba. 1 unidad = 1 metro real.
 *
 * Coordenadas guardadas → metros: todo lo guardado es % del tablero 300×340
 * (x*3, y*3.4 en unidades del viewBox) y cada cancha está centrada en el
 * tablero con su escala metro→unidad (sx, sy) del catálogo tacticalSports.ts.
 * Por eso el centro del tablero es el centro de la cancha y basta dividir por
 * la escala: el estiramiento del ancho (MAX_STRETCH) que usa el 2D desaparece
 * y el 3D queda a escala real.
 */
import {
  BOARD_H, BOARD_W, isTacticalSport, sportDef, DEFAULT_SPORT,
  type CourtFrame, type TacticalSport,
} from './tacticalSports';
import {
  GOAL_LINE_FROM_END_M, GOAL_WIDTH_EXTRA_M, GOAL_WIDTH_M, H_POSTS_M, NET_M, NETBALL_POST_M, VOLLEY_POST_OUTSIDE_M,
} from '@/components/school/courts/courtGeometry';
import { isGoalkeeperLabel } from './tacticalPalette';
import { DEFAULT_FRAME_MS, type TacticalFrame } from './tacticalFrames';
import type { Viewer3DSource } from './tactical3dLaunch';
import { interpolateFrames, type InterpolatedFrame } from './tacticalAnimation';
import type { AnimationCurve } from './tacticalBoardSettings';
import { ballPathPoint, curveControlPoint, isLoftedPath, pairsOf } from './tacticalGeometry';
import type { TacticalArrow } from './footballQueries';
import { chipLook, type TacticalTeamConfig } from './tacticalTeams';

// ─── Cancha en metros ───────────────────────────────────────────────────────

/** Fútbol 11 reglamentario de escuela (FIFA admite 64-75 × 100-110 m). El 2D
 *  de fútbol 11 (FootballPitchBackground) no está a escala: se lo estira a
 *  estas medidas, igual que se ve en la pizarra. */
export const FOOTBALL11_M = { w: 68, l: 105 } as const;

/** Marco del fútbol 11 armado desde su rectángulo en el catálogo (6..294 ×
 *  6..334 del viewBox), con la escala de las medidas reales. */
function football11Frame(): CourtFrame {
  const r = sportDef('futbol').court;
  const ox = (r.x0 / 100) * BOARD_W;
  const oy = (r.y0 / 100) * BOARD_H;
  const w = ((r.x1 - r.x0) / 100) * BOARD_W;
  const h = ((r.y1 - r.y0) / 100) * BOARD_H;
  return { ox, oy, w, h, sx: w / FOOTBALL11_M.w, sy: h / FOOTBALL11_M.l, widthM: FOOTBALL11_M.w, lengthM: FOOTBALL11_M.l };
}

export interface Court3D {
  sport: TacticalSport;
  /** Medidas de la cancha (líneas exteriores), metros. */
  widthM: number;
  lengthM: number;
  /** El tablero ENTERO (cancha + zona libre) en metros: el piso texturizado. */
  floorW: number;
  floorL: number;
  /** Unidades del viewBox por metro (a lo ancho y a lo largo). */
  sx: number;
  sy: number;
}

export function court3D(sport: TacticalSport | null | undefined): Court3D {
  const key: TacticalSport = isTacticalSport(sport) ? sport : DEFAULT_SPORT;
  const f = sportDef(key).frame ?? football11Frame();
  return {
    sport: key,
    widthM: f.widthM,
    lengthM: f.lengthM,
    floorW: BOARD_W / f.sx,
    floorL: BOARD_H / f.sy,
    sx: f.sx,
    sy: f.sy,
  };
}

/** % del tablero (lo guardado) → metros del mundo 3D (x, z). */
export function toMeters(court: Court3D, xPct: number, yPct: number): { x: number; z: number } {
  return {
    x: ((xPct / 100) * BOARD_W - BOARD_W / 2) / court.sx,
    z: ((yPct / 100) * BOARD_H - BOARD_H / 2) / court.sy,
  };
}

/** Figuras: la de 1,8 m se agranda en canchas grandes (un jugador de verdad
 *  en una cancha de 105 m vista desde la tribuna es un punto). Fútbol 11 =
 *  1,5×; las canchas de hasta 70 m de largo, tamaño real. */
export function figureScale(court: Court3D): number {
  return Math.min(1.5, Math.max(1, Math.round((court.lengthM / 70) * 100) / 100));
}

// ─── Elementos del deporte ──────────────────────────────────────────────────

/** Alto del travesaño por deporte (el ancho es el del 2D: GOAL_WIDTH_M). */
export const GOAL_HEIGHT_M = { futbol: 2.44, futbol7: 2, futbol5: 2, futsal: 2, balonmano: 2 } as const;

/** M6f: alto de los arcos de hockey césped (2,14 m, FIH), hockey sobre
 *  patines (1,05 m, World Skate art. 3) y waterpolo (0,90 m sobre el agua,
 *  World Aquatics WP 2; el piso del 3D es la superficie del agua). */
export const GOAL_HEIGHT_EXTRA_M = { hockey_cesped: 2.14, hockey_patines: 1.05, waterpolo: 0.9 } as const;

/** Alturas de la canasta FIBA (la planta es la del 2D: BASKET_M). */
export const BASKET_HEIGHTS_M = { boardHeight: 1.05, boardBottom: 2.9, rimHeight: 3.05 } as const;

/** Red de voleibol: borde superior a 2,43 m (2,24 m en femenino), 1 m de malla
 *  y antenas que sobresalen 0,8 m. */
export const VOLLEY_NET_M = { height: 2.43, meshHeight: 1, antennaAbove: 0.8 } as const;

/** Red al medio de la cancha: borde superior a `height`, malla de
 *  `meshHeight` (hasta el piso en tenis y pádel), postes a `postOutside` de
 *  la banda y antenas (vóley). */
export interface NetSpec { height: number; meshHeight: number; postOutside: number; antennas: boolean }

export type Fixture3D =
  /** `lineFromEnd`: la línea de gol está corrida del fondo (hockey sobre patines). */
  | { kind: 'goals'; width: number; height: number; lineFromEnd?: number }
  | { kind: 'net'; net: NetSpec }
  | { kind: 'hoops' }
  /** Palos en H (rugby, fútbol americano). */
  | { kind: 'hposts'; width: number; crossbar: number; height: number; lineFromEnd: number }
  /** Postes de netball con aro, sobre la línea de fondo. */
  | { kind: 'rings'; height: number; ringRadius: number; ringFromGoalLine: number }
  | { kind: 'none' };

export const VOLLEY_NET: NetSpec = { height: VOLLEY_NET_M.height, meshHeight: VOLLEY_NET_M.meshHeight, postOutside: VOLLEY_POST_OUTSIDE_M, antennas: true };

export function fixtureFor(sport: TacticalSport): Fixture3D {
  switch (sport) {
    case 'futbol': case 'futbol7': case 'futbol5': case 'futsal': case 'balonmano':
      return { kind: 'goals', width: GOAL_WIDTH_M[sport], height: GOAL_HEIGHT_M[sport] };
    case 'hockey_cesped': case 'hockey_patines': case 'waterpolo': {
      const lineFromEnd = GOAL_LINE_FROM_END_M[sport];
      return {
        kind: 'goals', width: GOAL_WIDTH_EXTRA_M[sport], height: GOAL_HEIGHT_EXTRA_M[sport],
        ...(lineFromEnd ? { lineFromEnd } : {}),
      };
    }
    case 'voleibol':
      return { kind: 'net', net: VOLLEY_NET };
    case 'tenis': case 'padel': case 'badminton': case 'voley_playa': {
      const n = NET_M[sport];
      // Tenis y pádel: la red baja hasta el piso; bádminton 0,76 m de malla;
      // vóley playa 1 m como el de sala.
      const meshHeight = sport === 'badminton' ? 0.76 : sport === 'voley_playa' ? 1 : n.height;
      return { kind: 'net', net: { height: n.height, meshHeight, postOutside: n.postOutside, antennas: n.antennas } };
    }
    case 'baloncesto':
      return { kind: 'hoops' };
    case 'rugby': case 'futbol_americano':
      return { kind: 'hposts', ...H_POSTS_M[sport] };
    case 'netball':
      return { kind: 'rings', ...NETBALL_POST_M };
    default:
      // Ultimate y genérico: piso plano (los conos de las esquinas van en la textura).
      return { kind: 'none' };
  }
}

/** Estilos del balón. M6f: el ovalado (rugby, americano), pelotas chicas
 *  (tenis, pádel, hockey), volante de bádminton y disco de ultimate se
 *  dibujan como esfera con su color y tamaño real (no hay modelos propios). */
export type BallStyle = 'football' | 'volleyball' | 'basketball' | 'handball'
  | 'oval' | 'tennis' | 'shuttlecock' | 'hockey' | 'waterpolo' | 'disc';
export interface BallSpec {
  style: BallStyle;
  /** Radio real, metros. */
  radius: number;
  /** Altura del centro sobre el piso: el balón de vóley va arriba (toque), el
   *  de básquet a la altura de la mano; los de pie, en el piso. */
  height: number;
}

export function ballFor(sport: TacticalSport): BallSpec {
  switch (sport) {
    case 'voleibol': return { style: 'volleyball', radius: 0.105, height: 2.3 };
    case 'baloncesto': return { style: 'basketball', radius: 0.12, height: 1 };
    case 'balonmano': return { style: 'handball', radius: 0.095, height: 1.1 };
    case 'futsal': return { style: 'football', radius: 0.1, height: 0.1 };
    case 'rugby': return { style: 'oval', radius: 0.1, height: 1 };
    case 'futbol_americano': return { style: 'oval', radius: 0.09, height: 1 };
    case 'tenis': return { style: 'tennis', radius: 0.034, height: 1 };
    case 'padel': return { style: 'tennis', radius: 0.033, height: 1 };
    case 'badminton': return { style: 'shuttlecock', radius: 0.035, height: 2 };
    case 'voley_playa': return { style: 'volleyball', radius: 0.105, height: 2.3 };
    case 'hockey_cesped': return { style: 'hockey', radius: 0.037, height: 0.037 };
    case 'hockey_patines': return { style: 'hockey', radius: 0.036, height: 0.036 };
    case 'netball': return { style: 'volleyball', radius: 0.11, height: 1.2 };
    case 'waterpolo': return { style: 'waterpolo', radius: 0.11, height: 0.25 };
    case 'ultimate': return { style: 'disc', radius: 0.0875, height: 1 };
    default: return { style: 'football', radius: 0.11, height: 0.11 };
  }
}

// ─── Cámaras ────────────────────────────────────────────────────────────────

export type CameraMode = 'tribuna' | 'detras' | 'jugador';
export const CAMERA_MODES: CameraMode[] = ['tribuna', 'detras', 'jugador'];

export function cameraLabel(mode: CameraMode, sport: TacticalSport): string {
  if (mode === 'tribuna') return 'Tribuna';
  if (mode === 'jugador') return 'Vista del jugador';
  const fx = fixtureFor(sport).kind;
  if (fx === 'goals') return 'Detrás del arco';
  if (fx === 'hoops' || fx === 'rings') return 'Detrás del aro';
  if (fx === 'hposts') return 'Detrás de los palos';
  return 'Detrás de la cancha';
}

export interface Vec3 { x: number; y: number; z: number }
export interface CameraPose { position: Vec3; target: Vec3 }

/** Cámaras fijas. `fovDeg` vertical de la cámara; `aspect` ancho/alto. */
export function fixedCameraPose(court: Court3D, mode: Exclude<CameraMode, 'jugador'>, aspect = 16 / 9, fovDeg = 45): CameraPose {
  const halfV = Math.tan(((fovDeg / 2) * Math.PI) / 180);
  // FOV horizontal efectivo real: en vertical la cancha entera cabe a lo ancho.
  const halfH = halfV * Math.max(0.2, aspect);
  const tall = aspect < 1;
  if (mode === 'tribuna' && tall) {
    // Vertical: desde el fondo propio y alto (casi cenital con perspectiva), de modo
    // que el ANCHO de la cancha sea el ancho de la pantalla y el largo use el alto.
    const el = (58 * Math.PI) / 180;
    const d = Math.max(
      (court.widthM / 2) * 1.32 / halfH,
      (court.lengthM / 2) * 1.3 * Math.sin(el) / halfV,
    );
    return { position: { x: 0, y: Math.sin(el) * d, z: Math.cos(el) * d }, target: { x: 0, y: 0, z: 0 } };
  }
  if (mode === 'tribuna') {
    // Desde la banda izquierda, elevada: el largo entra a lo ancho del cuadro
    // (con aire: la perspectiva agranda la banda cercana).
    const need = (court.lengthM / 2) * 1.08;
    const d = (Math.max(need / halfH, (court.widthM / 2) / halfV) * 0.95 + court.widthM * 0.35) * 1.15;
    return { position: { x: -d * 0.82, y: d * 0.52, z: 0 }, target: { x: 0, y: 0, z: 0 } };
  }
  const fxKind = fixtureFor(court.sport).kind;
  if (tall) {
    // Vertical: el fondo propio visto desde atrás y arriba, tan lejos como haga falta
    // para que el ancho de la cancha (y el fondo rival) quepan en la pantalla.
    const back = Math.max((court.widthM / 2) * 1.2 / halfH - court.lengthM * 0.3, court.lengthM * 0.12);
    const hgt = Math.max(5, court.lengthM * 0.3, back * 0.55);
    return {
      position: { x: 0, y: hgt, z: court.lengthM / 2 + back },
      target: { x: 0, y: 0, z: court.lengthM * 0.02 },
    };
  }
  if (fxKind === 'hoops' || fxKind === 'rings') {
    // Detrás del aro: arriba del tablero propio (el poste queda a la espalda,
    // no tapa), mirando hacia la otra canasta. Igual el poste de netball.
    return {
      position: { x: 0, y: 6.5, z: court.lengthM / 2 - 0.3 },
      target: { x: 0, y: 0, z: -court.lengthM * 0.15 },
    };
  }
  // Detrás del arco propio (abajo en el tablero = +z), mirando hacia el rival.
  // La mira va al medio campo rival (antes, al propio): la toma quedaba con
  // la mitad de abajo de césped vacío delante del arco.
  const d = Math.max((court.widthM / 2) * 1.15 / halfH, court.lengthM * 0.28);
  return {
    position: { x: 0, y: Math.max(4, court.lengthM * 0.22), z: court.lengthM / 2 + d * 0.6 },
    target: { x: 0, y: 0, z: -court.lengthM * 0.08 },
  };
}

/** Pantalla angosta (celular vertical): los carteles muestran solo el dorsal. */
export const isCompactAspect = (aspect: number) => aspect < 0.8;

/** Cámara con la que abre el visor: en el celular vertical, «Táctica alta»
 *  (el ancho de la cancha a lo ancho de la pantalla, el largo a lo alto); la
 *  de TV mira de costado y en vertical dejaba los jugadores diminutos. */
export const defaultViewerCamera = (aspect: number): 'tv' | 'tactica' => (isCompactAspect(aspect) ? 'tactica' : 'tv');

/** Figuras más grandes en el celular vertical (se leen sin hacer zoom). */
export const figureBoost = (aspect: number) => (isCompactAspect(aspect) ? 1.35 : 1);

/** Alto del cartel (fracción del alto de la vista): más chico en vertical. */
export const labelScreenSize = (aspect: number) => (isCompactAspect(aspect) ? 0.024 : 0.034);

/**
 * Cartel corto sobre cada jugador: el dorsal o, sin dorsal, las iniciales de
 * la etiqueta («Defensa central» → «DC»). La etiqueta completa sale solo en el
 * jugador tocado: con todas a la vez, desde arriba se montaban unas sobre otras.
 */
export function shortTag(visual: Pick<PlayerVisual, 'number' | 'label'>): string {
  if (visual.number) return visual.number;
  const words = (visual.label || '').replace(/[.()]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

/** Altura de los ojos de la «Vista del jugador», metros (escala incluida). */
export const EYE_HEIGHT_M = 1.65;

/**
 * Cámara «Vista del jugador»: desde los ojos del jugador mirando al balón
 * (si está a más de 2 m) o, si no, hacia el arco rival (−z).
 */
export function playerCameraPose(
  court: Court3D, player: { x: number; z: number }, ball: { x: number; z: number } | null,
): CameraPose {
  const s = figureScale(court);
  const eye = { x: player.x, y: EYE_HEIGHT_M * s, z: player.z };
  if (ball && Math.hypot(ball.x - player.x, ball.z - player.z) > 2 * s) {
    return { position: eye, target: { x: ball.x, y: 0.4 * s, z: ball.z } };
  }
  return { position: eye, target: { x: player.x * 0.6, y: 0.8 * s, z: -court.lengthM / 2 } };
}

/**
 * Qué cámara se usa de verdad. «Vista del jugador» necesita un jugador: si el
 * elegido no está en la jugada, cae al primero de la jugada; sin jugadores,
 * a «Tribuna».
 */
export function resolveCamera(
  mode: CameraMode, selectedKey: string | null, keys: string[],
): { mode: CameraMode; playerKey: string | null } {
  if (mode !== 'jugador') return { mode, playerKey: null };
  if (selectedKey && keys.includes(selectedKey)) return { mode, playerKey: selectedKey };
  if (keys.length > 0) return { mode, playerKey: keys[0] };
  return { mode: 'tribuna', playerKey: null };
}

// ─── Jugadores ──────────────────────────────────────────────────────────────

/** Todas las claves de jugador de la jugada, en orden de aparición. */
export function collectPlayerKeys(frames: TacticalFrame[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of frames ?? []) {
    for (const p of f.players ?? []) {
      if (p && typeof p.key === 'string' && !seen.has(p.key)) { seen.add(p.key); out.push(p.key); }
    }
  }
  return out;
}

export const TEAM_COLOR = '#10b981';
export const GOALKEEPER_COLOR = '#facc15';
export const OVERLAY_COLOR = '#ef4444';

export interface PlayerVisual {
  /** Dorsal o, sin dorsal, la etiqueta corta. */
  number: string | null;
  label: string;
  isGoalkeeper: boolean;
  color: string;
  /** M6b: pantaloneta (color secundario) y color del dorsal. Sin ellos, los de siempre. */
  shorts?: string;
  numberColor?: string;
}

/** M6b: la figura con los colores del equipo configurado (arquero aparte si
 *  el coach lo pidió; el dorsal ya corregido por contraste). */
export function teamVisual(v: PlayerVisual, team: TacticalTeamConfig): PlayerVisual {
  const look = chipLook(team, v.isGoalkeeper);
  return { ...v, color: look.fill, shorts: look.accent, numberColor: look.text };
}

/** Mismo criterio que la pizarra: arquero/portero en amarillo (tacticalGlyphs:
 *  isGoalkeeperLabel), salvo en deportes sin arquero. */
export function playerVisual(
  key: string,
  opts: { labels?: Record<string, string>; jerseys?: Record<string, number | null>; color?: string; sport: TacticalSport },
): PlayerVisual {
  const label = opts.labels?.[key] ?? '';
  const jersey = opts.jerseys?.[key];
  const isGoalkeeper = sportDef(opts.sport).hasGoalkeeper && isGoalkeeperLabel(label);
  return {
    number: jersey != null && Number.isFinite(jersey) ? String(jersey) : null,
    label,
    isGoalkeeper,
    color: isGoalkeeper ? GOALKEEPER_COLOR : (opts.color ?? TEAM_COLOR),
  };
}

// ─── ¿Aguanta el celular? ───────────────────────────────────────────────────

/** Ventana de medición de fps al abrir y piso aceptable (D5). */
export const FPS_WINDOW_MS = 2000;
export const MIN_FPS = 20;

/**
 * Medidor de fps de los primeros 2 s. `tick(nowMs)` en cada cuadro dibujado;
 * devuelve 'pending' hasta completar la ventana y después el veredicto (una
 * sola vez: luego queda 'done').
 */
export function createFpsMeter(
  windowMs = FPS_WINDOW_MS,
  minFps = MIN_FPS,
  opts: { warmupMs?: number; windows?: number } = {},
) {
  const warmupMs = opts.warmupMs ?? 0;
  let windowsLeft = Math.max(1, opts.windows ?? 1);
  let origin: number | null = null;
  let start: number | null = null;
  let frames = 0;
  let decided = false;
  let fps = 0;
  return {
    tick(nowMs: number): 'pending' | 'ok' | 'slow' | 'done' {
      if (decided) return 'done';
      if (origin === null) {
        origin = nowMs;
        if (warmupMs <= 0) start = nowMs;
        return 'pending';
      }
      // Calentamiento: los primeros cuadros compilan shaders y suben texturas
      // (cientos de ms en cualquier equipo); no dicen nada del ritmo real.
      if (nowMs - origin < warmupMs) return 'pending';
      if (start === null) { start = nowMs; frames = 0; return 'pending'; }
      frames += 1;
      const elapsed = nowMs - start;
      if (elapsed < windowMs) return 'pending';
      fps = (frames * 1000) / elapsed;
      if (fps >= minFps) { decided = true; return 'ok'; }
      // Una ventana lenta sola puede ser un tirón (otra pestaña, el SW, el GC):
      // se exige que la siguiente también lo sea antes de volver a 2D.
      if (windowsLeft > 1) { windowsLeft -= 1; start = nowMs; frames = 0; return 'pending'; }
      decided = true;
      return 'slow';
    },
    get fps() { return fps; },
  };
}

/** Piso de fps según el equipo: un PC (puntero fino) con GPU integrada rinde
 *  menos que un celular de gama media y aun así el 3D le sirve a 12 fps. */
export function defaultMinFps(): number {
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches) return 12;
  } catch { /* sin matchMedia: piso de celular */ }
  return MIN_FPS;
}

/** prefers-reduced-motion: sin animación automática de cámara. */
// ─── Carteles que no se montan ──────────────────────────────────────────────

/** Rectángulo de un cartel en pantalla (px, y hacia abajo) y su distancia a la cámara. */
export interface LabelRect { id: number; x: number; y: number; w: number; h: number; depth: number }

/**
 * Qué carteles se dejan ver: del más cercano a la cámara al más lejano, el que
 * se monta (con `pad` px de aire) sobre uno ya puesto se esconde. Desde la
 * vista del jugador los de lejos quedaban unos encima de otros («Ri Rival 6»).
 */
export function visibleLabels(rects: LabelRect[], pad = 2): Set<number> {
  const placed: LabelRect[] = [];
  const out = new Set<number>();
  for (const r of [...rects].sort((a, b) => a.depth - b.depth)) {
    const hit = placed.some((q) => r.x < q.x + q.w + pad && r.x + r.w + pad > q.x && r.y < q.y + q.h + pad && r.y + r.h + pad > q.y);
    if (hit) continue;
    placed.push(r);
    out.add(r.id);
  }
  return out;
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}


// ─── Trazos sobre el piso ───────────────────────────────────────────────────

export interface StrokePath3D {
  /** Puntos en metros; `y` > 0 solo en recorridos elevados (remate/penal). */
  points: Vec3[];
  /** Punta de flecha al final. */
  head: boolean;
}

/** Figura de la pizarra (flecha, curva, recorrido, trazo libre) → polilínea
 *  en metros sobre el piso, con la MISMA comba que dibuja el 2D. null para
 *  zonas, textos y material (se dibujan aparte). */
export function strokePath(court: Court3D, shape: TacticalArrow, liftM = 1.6): StrokePath3D | null {
  const type = shape.type ?? 'arrow';
  const at = (xPct: number, yPct: number, y = 0): Vec3 => { const m = toMeters(court, xPct, yPct); return { x: m.x, y, z: m.z }; };
  if (type === 'arrow') return { points: [at(shape.x1, shape.y1), at(shape.x2, shape.y2)], head: true };
  if (type === 'curve') {
    const p1 = { x: shape.x1 * 3, y: shape.y1 * 3.4 };
    const p2 = { x: shape.x2 * 3, y: shape.y2 * 3.4 };
    const c = curveControlPoint(p1, p2);
    const pts: Vec3[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const mt = 1 - t;
      pts.push(at((mt * mt * p1.x + 2 * mt * t * c.x + t * t * p2.x) / 3, (mt * mt * p1.y + 2 * mt * t * c.y + t * t * p2.y) / 3.4));
    }
    return { points: pts, head: true };
  }
  if (type === 'ball_path') {
    const lofted = isLoftedPath(shape);
    const n = lofted ? 24 : 1;
    const pts: Vec3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = ballPathPoint(shape, t);
      pts.push(at(p.x, p.y, lofted ? Math.sin(Math.PI * t) * liftM : 0));
    }
    return { points: pts, head: true };
  }
  if (type === 'freehand') {
    const pts = pairsOf(shape.points).map((p) => at(p.x, p.y));
    return pts.length >= 2 ? { points: pts, head: false } : null;
  }
  return null;
}

// ─── Entrada del visor ──────────────────────────────────────────────────────

/** Jugada → cuadros + etiquetas. Una jugada de un solo cuadro (frames null)
 *  se arma con lo que se ve en la cancha. */
export function viewerFrames(src: Viewer3DSource): {
  frames: TacticalFrame[]; labels: Record<string, string>; jerseys: Record<string, number | null>;
} {
  if (src.frames && src.frames.length > 0) {
    return { frames: src.frames, labels: { ...(src.playerLabels ?? {}) }, jerseys: { ...(src.playerJerseys ?? {}) } };
  }
  const labels: Record<string, string> = {};
  const jerseys: Record<string, number | null> = {};
  const players = src.players.map((p, i) => {
    const key = `p#${i}`;
    labels[key] = p.label ?? '';
    jerseys[key] = p.jersey ?? null;
    return { key, x: p.x, y: p.y };
  });
  return {
    frames: [{ id: 'f0', duration_ms: DEFAULT_FRAME_MS, players, ball: null, arrows: src.arrows }],
    labels,
    jerseys,
  };
}

// ─── Instante de la jugada ──────────────────────────────────────────────────

/** Estado de la jugada en el instante `t` para todas las capas del visor. */
export interface LiveState {
  t: number;
  /** La MISMA interpolación del 2D (tacticalAnimation.interpolateFrames). */
  main: InterpolatedFrame;
  /** Superposición (contraataque del rival) con el mismo reloj. */
  overlay: InterpolatedFrame | null;
  /** Balón en metros: el del cuadro o, si la pizarra lo movió como material, ese. */
  ball: { x: number; z: number; opacity: number } | null;
  /** Altura extra del balón en el aire (m, tactical3dMotion.ballArc; M6e).
   *  La escribe el bucle de la escena; 0 o ausente = en el piso / en la mano. */
  ballLift?: number;
}

export function computeLive(
  court: Court3D, frames: TacticalFrame[], overlay: TacticalFrame[] | null, t: number, curve?: AnimationCurve,
): LiveState {
  // Misma interpolación y misma curva (Ajustes, M6g) que el 2D y el export.
  const main = interpolateFrames(frames, t, { curve });
  let ball: LiveState['ball'] = null;
  if (main.ball) ball = { ...toMeters(court, main.ball.x, main.ball.y), opacity: main.ball.opacity };
  else {
    const obj = main.arrows.find((a) => a.shape.type === 'ball');
    if (obj) ball = { ...toMeters(court, obj.shape.x1, obj.shape.y1), opacity: obj.opacity };
  }
  return { t, main, overlay: overlay && overlay.length > 0 ? interpolateFrames(overlay, t, { curve }) : null, ball };
}
