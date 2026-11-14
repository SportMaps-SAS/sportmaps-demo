/**
 * Pequeñas reglas de la barra de la pizarra (paquete de arreglos 2026-10-27).
 * Lógica pura, sin React (src/test/tacticalBoardUx.test.ts).
 */
import type { TacticalArrow } from './footballQueries';
import { drawableShapes } from './tacticalCourt';

// ─── «Jugadores»: en cancha y en el banco ───────────────────────────────────

export interface RosterCounts {
  /** Jugadores del equipo puestos en la cancha. */
  onPitch: number;
  /** Jugadores del equipo que NO están en la cancha (disponibles + banca). */
  bench: number;
}

/**
 * Cuántos hay en la cancha y cuántos en el banco. Antes el botón contaba solo
 * a los que NO estaban en la cancha: con la cancha vacía decía 3 y con los 3
 * puestos decía 0 (se leía al revés). Solo cuentan los del roster: un jugador
 * guardado que ya no está en el equipo no suma en ningún lado.
 */
export function rosterCounts(rosterKeys: Iterable<string>, placedKeys: Iterable<string>): RosterCounts {
  const roster = new Set(rosterKeys);
  let onPitch = 0;
  for (const k of new Set(placedKeys)) if (roster.has(k)) onPitch += 1;
  return { onPitch, bench: Math.max(0, roster.size - onPitch) };
}

/** «En cancha 3 · Banco 0». */
export const rosterCountsLabel = (c: RosterCounts) => `En cancha ${c.onPitch} · Banco ${c.bench}`;

// ─── Exportar: qué se puede y por qué no ────────────────────────────────────

export interface ExportOption {
  enabled: boolean;
  /** Por qué está apagada (se muestra debajo del ítem). */
  reason: string | null;
}

export interface ExportAvailability {
  png: ExportOption;
  pdf: ExportOption;
  video: ExportOption & {
    /** Con un solo cuadro: ofrecer «+ Cuadro» desde el menú. */
    offerAddFrame: boolean;
  };
}

export const EMPTY_BOARD_REASON = 'La cancha está vacía: pon jugadores o dibuja algo primero';
export const VIDEO_FRAMES_REASON = 'Necesita 2 cuadros o más';

/** ¿Hay algo que exportar en algún cuadro? (jugadores o figuras dibujadas; la
 *  configuración del «Campo» sola no cuenta). */
export function boardHasContent(frames: { players?: unknown[] | null; arrows?: TacticalArrow[] | null }[]): boolean {
  return frames.some((f) => (f.players?.length ?? 0) > 0 || drawableShapes(f.arrows ?? []).length > 0);
}

/**
 * PNG y PDF apagados con la cancha vacía (salía una cancha en blanco con el
 * logo); el video además necesita dos cuadros, y en ese caso el menú ofrece
 * ir a «+ Cuadro» si quien mira puede editar.
 */
export function exportAvailability(opts: { hasContent: boolean; frameCount: number; canAddFrame: boolean }): ExportAvailability {
  const empty = !opts.hasContent;
  const still: ExportOption = empty ? { enabled: false, reason: EMPTY_BOARD_REASON } : { enabled: true, reason: null };
  const needsFrames = opts.frameCount < 2;
  return {
    png: still,
    pdf: still,
    video: {
      enabled: !empty && !needsFrames,
      reason: empty ? EMPTY_BOARD_REASON : needsFrames ? VIDEO_FRAMES_REASON : null,
      offerAddFrame: !empty && needsFrames && opts.canAddFrame,
    },
  };
}
