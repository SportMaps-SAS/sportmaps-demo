/**
 * Video de la jugada animada (spec docs/specs/pizarra-nivel-tacticalpad.md §4, T2).
 *
 * Se pinta la animación en un <canvas> fuera de la página (tacticalFrameRenderer.ts,
 * el mismo pintor que usa el GIF) y se graba con canvas.captureStream() +
 * MediaRecorder. Todo en el cliente: cero almacenamiento.
 *
 * MediaRecorder graba a reloj de pared: la grabación dura lo que dura la jugada.
 * Sin MediaRecorder (o sin captureStream, o sin codec) se lanza
 * TacticalVideoUnsupportedError; exportAnimation() (tacticalGif.ts) lo atrapa y
 * hace el GIF en su lugar.
 */
import type { TacticalTeamsConfig } from '@/lib/school/tacticalTeams';
import type { TacticalFrame } from '@/lib/school/tacticalFrames';
import type { TacticalSport } from '@/lib/school/tacticalSports';
import type { TacticalPlaybackOptions } from '@/lib/school/tacticalBoardSettings';
import { pickVideoMime, type TacticalVideoFormat } from './tacticalAnimationFormat';
import { abortError, createTacticalFrameRenderer } from './tacticalFrameRenderer';
import type { ExportBranding } from './tacticalWatermark';

export { pickVideoMime, canRecordVideo, type TacticalVideoFormat } from './tacticalAnimationFormat';

export interface ExportVideoOptions {
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
  fps?: number;
  width?: number;
  format?: TacticalVideoFormat;
  /** Pausa en el primer cuadro antes de arrancar y en el último al terminar. */
  holdStartMs?: number;
  holdEndMs?: number;
  /** 0-1 a medida que avanza la grabación. */
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}

export interface ExportVideoResult {
  blob: Blob;
  mime: string;
  ext: 'mp4' | 'webm';
}

export type TacticalVideoUnsupportedReason = 'no_media_recorder' | 'no_capture_stream' | 'no_codec' | 'too_few_frames';

/** Error tipado: la UI lo distingue para ofrecer la imagen (o el GIF) en lugar del video. */
export class TacticalVideoUnsupportedError extends Error {
  readonly code = 'TACTICAL_VIDEO_UNSUPPORTED' as const;
  constructor(readonly reason: TacticalVideoUnsupportedReason) {
    super(
      reason === 'too_few_frames'
        ? 'La jugada necesita al menos 2 cuadros para animarse.'
        : 'Este navegador no puede grabar video. Descarga la imagen.',
    );
    this.name = 'TacticalVideoUnsupportedError';
  }
}

export function isTacticalVideoUnsupported(e: unknown): e is TacticalVideoUnsupportedError {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'TACTICAL_VIDEO_UNSUPPORTED';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function exportVideo(opts: ExportVideoOptions): Promise<ExportVideoResult> {
  const { frames, signal, onProgress } = opts;
  const fps = Math.min(60, Math.max(10, opts.fps ?? 30));

  if (!frames || frames.length < 2) throw new TacticalVideoUnsupportedError('too_few_frames');
  if (typeof MediaRecorder === 'undefined') throw new TacticalVideoUnsupportedError('no_media_recorder');
  const picked = pickVideoMime((t) => MediaRecorder.isTypeSupported(t), opts.format ?? 'auto');
  if (!picked) throw new TacticalVideoUnsupportedError('no_codec');
  if (typeof HTMLCanvasElement === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    throw new TacticalVideoUnsupportedError('no_capture_stream');
  }

  let renderer;
  try {
    renderer = await createTacticalFrameRenderer({
      frames,
      playerLabels: opts.playerLabels,
      playerJerseys: opts.playerJerseys,
    teams: opts.teams,
    playerNames: opts.playerNames,
      sport: opts.sport,
      playback: opts.playback,
      branding: opts.branding,
      width: opts.width ?? 720,
      holdStartMs: opts.holdStartMs ?? 600,
      holdEndMs: opts.holdEndMs ?? 1200,
      signal,
    });
  } catch (e) {
    if (e instanceof Error && e.message === 'Canvas no disponible.') throw new TacticalVideoUnsupportedError('no_capture_stream');
    throw e;
  }
  const { canvas, draw, length } = renderer;

  let stream: MediaStream | null = null;
  try {
    stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType: picked.mime, videoBitsPerSecond: 2_500_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error('Falló la grabación del video.'));
    });
    // Si falla mientras se pinta, el rechazo se ve abajo: que no quede «unhandled».
    stopped.catch(() => undefined);

    draw(0);
    recorder.start(250);
    const t0 = performance.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (signal?.aborted) return reject(abortError());
          const elapsed = performance.now() - t0;
          draw(Math.min(elapsed, length));
          onProgress?.(Math.min(1, elapsed / length));
          if (elapsed >= length) return resolve();
          // setTimeout y no requestAnimationFrame: rAF se congela si la pestaña
          // queda de fondo y el video saldría cortado.
          setTimeout(tick, 1000 / fps);
        };
        tick();
      });
      // Un cuadro más para que el último quede grabado.
      await sleep(1000 / fps + 50);
    } finally {
      if (recorder.state !== 'inactive') recorder.stop();
    }
    await stopped;

    const mime = picked.mime.split(';')[0];
    return { blob: new Blob(chunks, { type: mime }), mime, ext: picked.ext };
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    renderer.dispose();
  }
}
