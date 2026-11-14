/**
 * Animación GIF de la jugada: la alternativa al video cuando el navegador no
 * tiene MediaRecorder o no graba ningún formato (Safari viejo, algunos WebView
 * de iOS, Capacitor). Spec docs/specs/pizarra-nivel-tacticalpad.md §4 «Export de video».
 *
 * Mismo pintor que el video (tacticalFrameRenderer.ts → misma interpolación),
 * pero sin reloj de pared: cada cuadro se pinta, se leen los píxeles y se
 * codifica con gifEncoder.ts. Para que pese pocos MB:
 *  - 10 fps y 360 px de ancho por defecto;
 *  - tope de cuadros (una jugada de 30 cuadros baja los fps solita);
 *  - cada cuadro guarda solo el rectángulo que cambió y los repetidos se funden.
 */
import type { TacticalTeamsConfig } from '@/lib/school/tacticalTeams';
import { ColorHistogram, GifAnimator } from './gifEncoder';
import { pickAnimationKind, type TacticalAnimationKind } from './tacticalAnimationFormat';
import { abortError, createTacticalFrameRenderer } from './tacticalFrameRenderer';
import {
  exportVideo,
  isTacticalVideoUnsupported,
  TacticalVideoUnsupportedError,
  type ExportVideoOptions,
} from './tacticalVideo';
import type { TacticalFrame } from '@/lib/school/tacticalFrames';
import type { TacticalSport } from '@/lib/school/tacticalSports';
import type { TacticalPlaybackOptions } from '@/lib/school/tacticalBoardSettings';
import type { ExportBranding } from './tacticalWatermark';

export interface ExportGifOptions {
  frames: TacticalFrame[];
  /** Ajustes de la pizarra (M6g): curva de velocidad y rastros. */
  playback?: TacticalPlaybackOptions;
  playerLabels?: Record<string, string>;
  playerJerseys?: Record<string, number | null>;
  /** M6b: configuración de los equipos (sin ella, el dibujo de siempre). */
  teams?: TacticalTeamsConfig | null;
  /** M6b: clave → nombre real. Solo viaja con «Mostrar nombres» prendido. */
  playerNames?: Record<string, string>;
  /** Cancha de fondo (T4). */
  sport?: TacticalSport | null;
  /** «Hecho con SportMaps · sportmaps.co» y logo del club en cada cuadro. */
  branding?: ExportBranding;
  /** 10 por defecto (rango 4-15). */
  fps?: number;
  /** Ancho en px, 360 por defecto (rango 160-720). */
  width?: number;
  holdStartMs?: number;
  holdEndMs?: number;
  /** Tope de cuadros muestreados; si la jugada es larga baja los fps. */
  maxFrames?: number;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}

export interface ExportGifResult {
  blob: Blob;
  mime: 'image/gif';
  ext: 'gif';
  /** Cuadros que quedaron en el archivo (los repetidos se funden). */
  frames: number;
  width: number;
  height: number;
}

/** Instantes (ms) a pintar: de 0 a `length` cada `step`, el último exacto. */
export function gifSampleTimes(length: number, fps: number, maxFrames: number): number[] {
  const step = Math.max(1000 / fps, length / Math.max(2, maxFrames - 1));
  const times: number[] = [];
  for (let t = 0; t < length - 1e-6; t += step) times.push(t);
  times.push(length);
  return times;
}

/** Cede el hilo para que la página no se congele mientras codifica. */
const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

export async function exportGif(opts: ExportGifOptions): Promise<ExportGifResult> {
  const { frames, signal, onProgress } = opts;
  if (!frames || frames.length < 2) throw new TacticalVideoUnsupportedError('too_few_frames');
  const fps = Math.min(15, Math.max(4, opts.fps ?? 10));
  const maxFrames = Math.max(10, Math.min(400, opts.maxFrames ?? 240));

  const renderer = await createTacticalFrameRenderer({
    frames,
    playerLabels: opts.playerLabels,
    playerJerseys: opts.playerJerseys,
    teams: opts.teams,
    playerNames: opts.playerNames,
    sport: opts.sport,
    playback: opts.playback,
    branding: opts.branding,
    width: Math.min(720, Math.max(160, opts.width ?? 360)),
    holdStartMs: opts.holdStartMs ?? 600,
    holdEndMs: opts.holdEndMs ?? 1200,
    willReadFrequently: true,
    signal,
  });
  const { ctx, width, height, length, draw } = renderer;
  try {
    const times = gifSampleTimes(length, fps, maxFrames);
    const read = (t: number) => {
      draw(t);
      return ctx.getImageData(0, 0, width, height).data;
    };

    // Pasada 1: paleta global con una muestra de ~40 cuadros.
    const hist = new ColorHistogram();
    const sampleEvery = Math.max(1, Math.round(times.length / 40));
    for (let i = 0; i < times.length; i += sampleEvery) {
      if (signal?.aborted) throw abortError();
      hist.add(read(times[i]), 2);
    }
    hist.add(read(length), 2);
    const palette = hist.palette(256);
    await yieldToBrowser();

    // Pasada 2: codificar.
    const anim = new GifAnimator(width, height, palette, { loop: 0 });
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) throw abortError();
      // Cada cuadro dura hasta el siguiente; el último (igual al anterior, se funde) un paso.
      const delay = i + 1 < times.length ? times[i + 1] - times[i] : 1000 / fps;
      anim.addFrame(read(times[i]), delay);
      onProgress?.((i + 1) / times.length);
      if (i % 5 === 4) await yieldToBrowser();
    }
    const bytes = anim.finish();
    return { blob: new Blob([bytes], { type: 'image/gif' }), mime: 'image/gif', ext: 'gif', frames: anim.frameCount, width, height };
  } finally {
    renderer.dispose();
  }
}

export type ExportAnimationOptions = Omit<ExportVideoOptions, 'fps' | 'width' | 'format'> & {
  /** Forzar un formato (pruebas); por defecto lo decide el navegador. */
  kind?: TacticalAnimationKind;
};

export interface ExportAnimationResult {
  kind: TacticalAnimationKind;
  blob: Blob;
  mime: string;
  ext: 'mp4' | 'webm' | 'gif';
}

/**
 * Video si el navegador lo graba; si no, GIF. Si el video falla por soporte
 * (p. ej. MediaRecorder existe pero el canvas no tiene captureStream) también
 * cae al GIF. Con 1 cuadro lanza too_few_frames en los dos caminos.
 */
export async function exportAnimation(opts: ExportAnimationOptions): Promise<ExportAnimationResult> {
  const kind = opts.kind ?? pickAnimationKind();
  if (kind === 'video') {
    try {
      const v = await exportVideo(opts);
      return { kind: 'video', blob: v.blob, mime: v.mime, ext: v.ext };
    } catch (e) {
      if (!isTacticalVideoUnsupported(e) || e.reason === 'too_few_frames') throw e;
    }
  }
  const g = await exportGif(opts);
  return { kind: 'gif', blob: g.blob, mime: g.mime, ext: g.ext };
}
