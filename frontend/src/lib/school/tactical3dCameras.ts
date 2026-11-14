/**
 * Cámaras del visor 3D (M6e, docs/specs/pizarra-m6e-camaras-3d.md). Lógica
 * PURA: dado el instante de la jugada (balón, jugador elegido, reloj) devuelve
 * dónde va la cámara y hacia dónde mira. El rig de Scene3D solo la aplica.
 *
 * Ejes de tactical3d.ts: x a lo ancho, z a lo largo (arco propio = +z, rival =
 * −z), y hacia arriba, metros.
 */
import { easeInOutCubic, frameStartMs } from './tacticalAnimation';
import type { TacticalFrame } from './tacticalFrames';
import type { TacticalSport } from './tacticalSports';
import {
  figureScale, fixedCameraPose, fixtureFor, playerCameraPose, toMeters,
  type CameraPose, type Court3D, type Vec3,
} from './tactical3d';
import { frameBallPct } from './tactical3dMotion';

// ─── Catálogo ───────────────────────────────────────────────────────────────

export type CameraKind =
  | 'tv' | 'tactica' | 'cenital' | 'iso' | 'detras' | 'rival'
  | 'balon' | 'jugador' | 'spider' | 'dron' | 'libre';

/** Orden de los botones del visor. */
export const CAMERA_KINDS: CameraKind[] = ['tv', 'tactica', 'cenital', 'iso', 'detras', 'rival', 'balon', 'jugador', 'spider', 'dron', 'libre'];

/** Cámaras que se mueven solas (prefers-reduced-motion las deja quietas o no las ofrece). */
export const AUTO_MOVING: ReadonlySet<CameraKind> = new Set(['dron']);

export type PlayerView = 'pov' | 'tercera';

/** Rótulo por deporte: arco (fútbol, futsal, balonmano), aro (básquet), fondo (vóley y genérico). */
export function cameraKindLabel(kind: CameraKind, sport: TacticalSport): string {
  const fx = fixtureFor(sport).kind;
  // M6f: el poste de netball se trata como el aro de básquet; rugby y americano, palos en H.
  const end = fx === 'goals' ? 'arco' : fx === 'hoops' || fx === 'rings' ? 'aro' : fx === 'hposts' ? 'palos' : null;
  switch (kind) {
    case 'tv': return 'Transmisión TV';
    case 'tactica': return 'Táctica alta';
    case 'cenital': return 'Cenital';
    case 'iso': return 'Isométrica';
    case 'detras': return end === 'palos' ? 'Detrás de los palos' : end ? `Detrás del ${end}` : 'Fondo propio';
    // «Detrás del arco» (alta, desde nuestro fondo) y la del rival se veían casi
    // iguales (eran espejo una de la otra). Ahora la del rival es la toma BAJA
    // del arquero rival: a ras del arco, viendo venir el ataque de frente.
    case 'rival': return end === 'arco' ? 'Ojos del arquero rival' : end === 'aro' ? 'Bajo el aro rival' : end === 'palos' ? 'Bajo los palos rivales' : 'Fondo rival, a ras';
    case 'balon': return 'Seguir balón';
    case 'jugador': return 'Seguir jugador';
    case 'spider': return 'Spider-cam';
    case 'dron': return 'Dron';
    case 'libre': return 'Libre';
  }
}

/** «Seguir jugador» sin jugador elegido sigue al primero; sin jugadores, TV. */
export function resolveCameraKind(
  kind: CameraKind, selectedKey: string | null, keys: string[],
): { kind: CameraKind; playerKey: string | null } {
  if (kind !== 'jugador') return { kind, playerKey: selectedKey && keys.includes(selectedKey) ? selectedKey : null };
  if (selectedKey && keys.includes(selectedKey)) return { kind, playerKey: selectedKey };
  if (keys.length > 0) return { kind, playerKey: keys[0] };
  return { kind: 'tv', playerKey: null };
}

/** Pantalla vertical: px que tapan la barra de título + chips (arriba) y los controles (abajo). */
export const PORTRAIT_INSET_TOP_PX = 190;
export const PORTRAIT_INSET_BOTTOM_PX = 160;

/**
 * Zona libre del lienzo en vertical: el encuadre se calcula para ese rectángulo
 * (aspect y FOV efectivos) y luego se desplaza con setViewOffset, así el campo
 * queda centrado en el espacio visible y no en el centro geométrico.
 */
export function portraitFraming(w: number, h: number, fovDeg: number) {
  if (!(w > 0 && h > 0) || w / h >= 1) return null;
  const maxInset = h * 0.62;
  const k = Math.min(1, maxInset / (PORTRAIT_INSET_TOP_PX + PORTRAIT_INSET_BOTTOM_PX));
  const top = PORTRAIT_INSET_TOP_PX * k;
  const bottom = PORTRAIT_INSET_BOTTOM_PX * k;
  const free = h - top - bottom;
  return {
    aspect: w / free,
    fovDeg: 2 * Math.atan(Math.tan((fovDeg * Math.PI) / 360) * (free / h)) * (180 / Math.PI),
    shiftPx: (top - bottom) / 2,
  };
}

// ─── Poses ──────────────────────────────────────────────────────────────────

export interface CameraContext {
  court: Court3D;
  /** Ancho/alto del canvas. */
  aspect: number;
  fovDeg: number;
  /** Balón YA suavizado (metros; y = altura del centro). null sin balón. */
  ball: Vec3 | null;
  /** Jugador seguido (metros) y hacia dónde mira (rad: dirección (sin h, cos h) en x/z). */
  player: { x: number; z: number; heading: number } | null;
  playerView: PlayerView;
  /** Segundos acumulados del dron. */
  elapsedS: number;
  /** Hacia dónde viaja el balón (rad, misma convención que `player.heading`). */
  ballHeading?: number;
}

const halfAngles = (aspect: number, fovDeg: number) => {
  const halfV = Math.tan(((fovDeg / 2) * Math.PI) / 180);
  // FOV horizontal efectivo: hfov = 2·atan(tan(vfov/2)·aspect). Sin piso en vertical:
  // en el celular el ancho de la cancha TIENE que caber.
  return { halfV, halfH: halfV * Math.max(0.2, aspect) };
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Lo que muestra a lo ancho la cámara de transmisión (m): media cancha
 *  larga en fútbol 11; casi toda la cancha en las chicas. */
export function tvSpanM(court: Court3D, aspect = 16 / 9): number {
  // Pantalla vertical: la cancha entera a lo ancho (sin paneo que la corte).
  if (aspect < 1) return court.lengthM * 1.16;
  return Math.max(court.lengthM * 0.55, Math.min(court.lengthM * 1.05, 22));
}

/** Hasta dónde se desplaza a lo largo el paneo de TV (no muestra la nada detrás del fondo). */
export function tvPanLimitM(court: Court3D, aspect = 16 / 9): number {
  return Math.max(0, court.lengthM / 2 - tvSpanM(court, aspect) / 2 + court.lengthM * 0.06);
}

/** Elevación de la cámara de TV (grados): plataforma alta de la tribuna principal. */
export const TV_ELEVATION_DEG = 30;

function tvPose(ctx: CameraContext): CameraPose {
  const { court } = ctx;
  const { halfV, halfH } = halfAngles(ctx.aspect, ctx.fovDeg);
  const span = tvSpanM(court, ctx.aspect);
  // Distancia: el tramo `span` entra a lo ancho y casi todo el ancho de la cancha a lo alto.
  const dist = Math.max((span / 2) / halfH, (court.widthM * 0.72) / (2 * halfV));
  const lim = tvPanLimitM(court, ctx.aspect);
  const bz = ctx.ball ? clamp(ctx.ball.z, -lim, lim) : 0;
  const bx = ctx.ball ? clamp(ctx.ball.x * 0.25, -court.widthM / 6, court.widthM / 6) : 0;
  const e = (TV_ELEVATION_DEG * Math.PI) / 180;
  // Mira a media altura del balón: en vóley y básquet va alto y se salía del cuadro.
  const by = ctx.ball ? Math.max(0, ctx.ball.y) * 0.5 : 0;
  const target = v(bx - court.widthM * 0.06, by, bz);
  // La cámara NO se mueve a lo ancho (está en la tribuna): paneo = solo z.
  return {
    position: v(-court.widthM * 0.06 - Math.cos(e) * dist, by + Math.sin(e) * dist, bz * 0.92),
    target,
  };
}

function cenitalPose(ctx: CameraContext): CameraPose {
  const { court } = ctx;
  const { halfV, halfH } = halfAngles(ctx.aspect, ctx.fovDeg);
  // 1,18: aire para que las barras de arriba y abajo no tapen los fondos.
  const h = Math.max((court.lengthM / 2) * 1.18 / halfV, (court.widthM / 2) * 1.06 / halfH);
  // Un pelo corrido hacia el arco propio: lookAt cenital exacto es degenerado
  // y así el arco rival queda ARRIBA en la pantalla, como en el 2D.
  return { position: v(0, h, h * 0.01), target: v(0, 0, 0) };
}

function isoPose(ctx: CameraContext): CameraPose {
  const { court } = ctx;
  const { halfV, halfH } = halfAngles(ctx.aspect, ctx.fovDeg);
  const r = 0.5 * Math.hypot(court.widthM, court.lengthM);
  // Vertical: la esquina cercana se agranda por la perspectiva, más aire.
  const dist = (r / Math.min(halfV, halfH)) * (ctx.aspect < 1 ? 1.12 : 0.92);
  // Dirección isométrica clásica: 45° en planta, 35,26° de elevación.
  const el = Math.atan(1 / Math.SQRT2);
  const d = v(-Math.cos(el) * Math.SQRT1_2, Math.sin(el), Math.cos(el) * Math.SQRT1_2);
  return { position: v(d.x * dist, d.y * dist, d.z * dist), target: v(0, 0, 0) };
}

/**
 * Toma baja desde el fondo rival (−z): a la altura de los ojos de un arquero,
 * un poco detrás de la línea, mirando hacia la zona de definición y el medio
 * campo. Se diferencia a propósito de «Detrás del arco» (alta y desde el fondo
 * propio): antes era su espejo y las dos se veían casi iguales. En vertical se
 * aleja lo justo para que el ancho de la cancha quepa.
 */
export function rivalLowPose(court: Court3D, aspect = 16 / 9, fovDeg = 45): CameraPose {
  const { halfH } = halfAngles(aspect, fovDeg);
  const s = figureScale(court);
  const ahead = court.lengthM * 0.3;
  let back = Math.max(1.5 * s, court.lengthM * 0.025);
  if (aspect < 1) back = Math.max(back, (court.widthM / 2) * 1.05 / halfH - ahead);
  const eye = Math.max(2.2 * s, court.lengthM * 0.03, back * 0.18);
  return {
    position: v(0, eye, -court.lengthM / 2 - back),
    target: v(0, 0.9 * s, -court.lengthM / 2 + ahead),
  };
}

function rivalPose(ctx: CameraContext): CameraPose {
  return rivalLowPose(ctx.court, ctx.aspect, ctx.fovDeg);
}

/** Distancias de la cámara que sigue al balón. */
export function ballCamOffsets(court: Court3D): { back: number; up: number } {
  return { back: Math.max(5, court.lengthM * 0.11), up: Math.max(3, court.lengthM * 0.06) };
}

function ballPose(ctx: CameraContext): CameraPose {
  const b = ctx.ball ?? v(0, 0, 0);
  const { back, up } = ballCamOffsets(ctx.court);
  // Detrás del balón según hacia dónde viaja (sin dato: hacia el arco rival).
  const h = ctx.ballHeading ?? Math.PI;
  const dx = Math.sin(h);
  const dz = Math.cos(h);
  // Mira bien adelante del balón: con la mira pegada al balón, la mitad de
  // abajo del cuadro era césped vacío entre la cámara y el balón.
  return {
    position: v(b.x - dx * back, up + b.y * 0.6, b.z - dz * back),
    target: v(b.x + dx * back * 0.8, b.y * 0.85, b.z + dz * back * 0.8),
  };
}

function thirdPersonPose(ctx: CameraContext): CameraPose {
  const s = figureScale(ctx.court);
  const p = ctx.player!;
  const dx = Math.sin(p.heading);
  const dz = Math.cos(p.heading);
  // Mira más lejos (10 m y no 6): menos césped vacío delante del jugador.
  return {
    position: v(p.x - dx * 4.2 * s, 2.7 * s, p.z - dz * 4.2 * s),
    target: v(p.x + dx * 10 * s, 1.2 * s, p.z + dz * 10 * s),
  };
}

/** Altura de la spider-cam (cable): por encima de todo, sin tapar. */
export function spiderHeightM(court: Court3D): number {
  return Math.max(9, court.lengthM * 0.22);
}

function spiderPose(ctx: CameraContext): CameraPose {
  const b = ctx.ball ?? v(0, 0, 0);
  // Sube si el balón va alto (vóley): nunca queda a menos de 7 m por encima.
  let h = Math.max(spiderHeightM(ctx.court), b.y + 7);
  if (ctx.aspect < 1) {
    // Vertical: sube lo justo para que el ancho de la cancha quepa (distancia ≈ 1,17·h).
    const { halfH } = halfAngles(ctx.aspect, ctx.fovDeg);
    h = Math.max(h, (ctx.court.widthM / 2) * 1.2 / (halfH * 1.17));
  }
  return { position: v(b.x * 0.7, h, b.z + h * 0.6), target: v(b.x, b.y * 0.5, b.z) };
}

/** Una vuelta del dron cada 48 s. */
export const DRONE_PERIOD_S = 48;

export function dronePose(court: Court3D, elapsedS: number, aspect = 16 / 9, fovDeg = 45): CameraPose {
  // Arranca sobre la banda izquierda (x < 0, como la tribuna) y gira despacio.
  const a = Math.PI + (elapsedS / DRONE_PERIOD_S) * Math.PI * 2;
  let r = Math.max(court.lengthM, court.widthM) * 0.7 + 6;
  if (aspect < 1) {
    // Vertical: el radio deja entera la cancha en cualquier ángulo de la órbita.
    const { halfV, halfH } = halfAngles(aspect, fovDeg);
    r = Math.max(r, (0.5 * Math.hypot(court.widthM, court.lengthM) * 1.0) / Math.min(halfV, halfH));
  }
  return { position: v(Math.cos(a) * r, r * 0.55, Math.sin(a) * r), target: v(0, 0, 0) };
}

/**
 * Pose de la cámara `kind` en este instante. null = «Libre» (la mueve el
 * dedo/mouse con la órbita: el rig no la toca).
 */
export function cameraPose(kind: CameraKind, ctx: CameraContext): CameraPose | null {
  switch (kind) {
    case 'libre': return null;
    case 'tv': return tvPose(ctx);
    case 'tactica': return fixedCameraPose(ctx.court, 'tribuna', ctx.aspect, ctx.fovDeg);
    case 'cenital': return cenitalPose(ctx);
    case 'iso': return isoPose(ctx);
    case 'detras': return fixedCameraPose(ctx.court, 'detras', ctx.aspect, ctx.fovDeg);
    case 'rival': return rivalPose(ctx);
    case 'balon': return ballPose(ctx);
    case 'spider': return spiderPose(ctx);
    case 'dron': return dronePose(ctx.court, ctx.elapsedS, ctx.aspect, ctx.fovDeg);
    case 'jugador': {
      if (!ctx.player) return tvPose(ctx);
      if (ctx.playerView === 'tercera') return thirdPersonPose(ctx);
      const pose = playerCameraPose(ctx.court, ctx.player, ctx.ball);
      return pose;
    }
  }
}

// ─── Seguimiento suave ──────────────────────────────────────────────────────

/** Constante de tiempo del suavizado (s) por cámara: TV panea con calma, la
 *  spider-cam (cable) más lenta, la del balón casi pegada. */
export const FOLLOW_TAU_S: Partial<Record<CameraKind, number>> = { tv: 0.45, balon: 0.22, spider: 0.9, jugador: 0.18 };

/**
 * Suavizado exponencial independiente de los fps: dos pasos de dt/2 = un paso
 * de dt. `tauS` = segundos para recorrer el 63 % de la distancia.
 */
export function smoothToward(prev: Vec3, target: Vec3, dtS: number, tauS: number): Vec3 {
  if (!(tauS > 0) || !(dtS > 0)) return dtS > 0 ? { ...target } : { ...prev };
  const k = 1 - Math.exp(-dtS / tauS);
  return { x: prev.x + (target.x - prev.x) * k, y: prev.y + (target.y - prev.y) * k, z: prev.z + (target.z - prev.z) * k };
}

/** Giro suave por el camino corto (rad). */
export function smoothAngle(prev: number, target: number, dtS: number, tauS: number): number {
  let d = (target - prev) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  const k = tauS > 0 ? 1 - Math.exp(-Math.max(0, dtS) / tauS) : 1;
  return prev + d * k;
}

// ─── Transiciones ───────────────────────────────────────────────────────────

/** Duración de la transición entre dos poses: 600 ms cerca, hasta 900 ms lejos. */
export function transitionMs(from: CameraPose, to: CameraPose): number {
  const d = Math.hypot(to.position.x - from.position.x, to.position.y - from.position.y, to.position.z - from.position.z);
  return Math.round(clamp(600 + d * 2.5, 600, 900));
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpV = (a: Vec3, b: Vec3, k: number): Vec3 => v(lerp(a.x, b.x, k), lerp(a.y, b.y, k), lerp(a.z, b.z, k));

/** Pose intermedia (posición y objetivo) con ease in-out cúbico. */
export function blendPose(from: CameraPose, to: CameraPose, elapsedMs: number, durationMs: number): { pose: CameraPose; done: boolean } {
  const p = durationMs > 0 ? Math.min(1, Math.max(0, elapsedMs / durationMs)) : 1;
  const k = easeInOutCubic(p);
  return { pose: { position: lerpV(from.position, to.position, k), target: lerpV(from.target, to.target, k) }, done: p >= 1 };
}

// ─── Director automático ────────────────────────────────────────────────────

/** Pase largo: al menos 30 % del largo de la cancha (31,5 m en fútbol 11), mínimo 6 m. */
export const longPassM = (court: Court3D) => Math.max(6, court.lengthM * 0.3);
/** Zona de definición: el último 20 % de la cancha hacia cada fondo. */
export const finishZoneM = (court: Court3D) => court.lengthM * 0.2;

/**
 * Regla del director para el tramo que se está reproduciendo (simple a
 * propósito, ver el spec):
 *  1. el balón termina el tramo en la zona de definición de un fondo y va
 *     hacia él (remate / tiro / lanzamiento) → cámara DETRÁS de ese arco/aro;
 *  2. el balón recorre un pase largo → «Seguir balón»;
 *  3. todo lo demás (salida, elaboración) → «Transmisión TV».
 * Vóley (red) y genérico no tienen arco: solo 2 y 3.
 */
export function directorShot(court: Court3D, frames: TacticalFrame[], tMs: number): CameraKind {
  if (!frames || frames.length < 2) return 'tv';
  let seg = frames.length - 1;
  for (let i = 1; i < frames.length; i++) {
    if (tMs < frameStartMs(frames, i)) { seg = i; break; }
  }
  const a = frameBallPct(frames[seg - 1]);
  const b = frameBallPct(frames[seg]);
  if (!a || !b) return 'tv';
  const ma = toMeters(court, a.x, a.y);
  const mb = toMeters(court, b.x, b.y);
  const dz = mb.z - ma.z;
  const d = Math.hypot(mb.x - ma.x, dz);
  // M6f: netball (aros) y rugby/americano (palos) también tienen fondos a los que se ataca.
  const endKind = fixtureFor(court.sport).kind;
  const hasEnds = endKind === 'goals' || endKind === 'hoops' || endKind === 'rings' || endKind === 'hposts';
  if (hasEnds && d > 2) {
    const zone = finishZoneM(court);
    if (mb.z < -court.lengthM / 2 + zone && dz < 0) return 'rival';
    if (mb.z > court.lengthM / 2 - zone && dz > 0) return 'detras';
  }
  if (d >= longPassM(court)) return 'balon';
  return 'tv';
}

/** Tiempo mínimo en una cámara antes de que el director corte a otra. */
export const DIRECTOR_HOLD_MS = 1200;

/**
 * Histéresis del director: no corta antes de `holdMs` desde el último corte
 * (con la jugada a 0,25× el tramo dura más y no hace falta más regla).
 */
export function createDirector(holdMs = DIRECTOR_HOLD_MS) {
  let current: CameraKind | null = null;
  let since = 0;
  return {
    step(wanted: CameraKind, nowMs: number): CameraKind {
      if (current === null) { current = wanted; since = nowMs; return current; }
      if (wanted !== current && nowMs - since >= holdMs) { current = wanted; since = nowMs; }
      return current;
    },
    reset() { current = null; since = 0; },
    get current() { return current; },
  };
}
