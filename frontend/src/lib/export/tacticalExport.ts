/**
 * Exportar la pizarra táctica (spec docs/specs/pizarra-nivel-tacticalpad.md, T2):
 * imagen PNG, ficha del ejercicio en PDF, video de la jugada y compartir.
 *
 * Punto de entrada único; cada pieza vive en su archivo:
 *  - tacticalPdf.ts          ficha A4
 *  - tacticalVideo.ts        MediaRecorder sobre canvas
 *  - tacticalGif.ts          GIF cuando no hay MediaRecorder (gifEncoder.ts)
 *  - tacticalFrameRenderer.ts pintor de cuadros compartido por video y GIF
 *  - tacticalShare.ts        Web Share API / descarga + wa.me
 *  - tacticalInterpolation.ts interpolación pura de cuadros
 */
import type { TacticalArrow } from '@/lib/school/footballQueries';
import type { TacticalFrame } from '@/lib/school/tacticalFrames';
import type { TacticalSport } from '@/lib/school/tacticalSports';
import type { PlayNotes, PlayVideo } from '@/lib/school/tacticalMedia';
import type { TacticalTeamsConfig } from '@/lib/school/tacticalTeams';
import type { TacticalPlaybackOptions } from '@/lib/school/tacticalBoardSettings';
import type { TacticalStaticPlayer } from '@/components/school/TacticalStaticSvg';
import { renderTacticalPng } from './tacticalImage';
import { canvasToBlob, loadImage } from './tacticalExportUtils';
import { loadLogo, wantsWatermark, WATERMARK_TEXT, type ExportBranding } from './tacticalWatermark';

export { exportExercisePdf, stripSlots, type ExercisePdfInput } from './tacticalPdf';
export {
  exportVideo,
  canRecordVideo,
  pickVideoMime,
  isTacticalVideoUnsupported,
  TacticalVideoUnsupportedError,
  type ExportVideoOptions,
  type ExportVideoResult,
  type TacticalVideoFormat,
} from './tacticalVideo';
export {
  exportGif,
  exportAnimation,
  gifSampleTimes,
  type ExportGifOptions,
  type ExportGifResult,
  type ExportAnimationOptions,
  type ExportAnimationResult,
} from './tacticalGif';
export { pickAnimationKind, animationLabel, type TacticalAnimationKind } from './tacticalAnimationFormat';
export { shareFile, canShareFiles, whatsappTextUrl, isMobileDevice, type ShareResult, type ShareMethod } from './tacticalShare';
export { interpolateFrames, framesDuration, frameToStatic, easeInOutCubic, type InterpolatedState } from './tacticalInterpolation';
export { exportFileName, cleanPdfText } from './tacticalExportUtils';
export { WATERMARK_TEXT, resolveExportBranding, type ExportBranding } from './tacticalWatermark';

/** Lo que la pizarra entrega al menú de exportar. */
export interface TacticalExportInput {
  title: string;
  teamName?: string | null;
  /** null o 1 cuadro = jugada estática. */
  frames: TacticalFrame[] | null;
  /** Estado que se ve AHORA en la pizarra (para el PNG). */
  players: TacticalStaticPlayer[];
  arrows: TacticalArrow[];
  /** `TacticalFramePlayer.key` → nombre a mostrar bajo el disco. */
  playerLabels?: Record<string, string>;
  /** `TacticalFramePlayer.key` → dorsal. */
  playerJerseys?: Record<string, number | null>;
  /** M6b: configuración de los equipos (sin ella, el dibujo de siempre). */
  teams?: TacticalTeamsConfig | null;
  /** M6b: clave → nombre real. Solo viaja con «Mostrar nombres» prendido. */
  playerNames?: Record<string, string>;
  objective?: string | null;
  minutes?: number | string | null;
  ageGroup?: string | null;
  materials?: string | null;
  description?: string | null;
  /** Deporte de la cancha (T4). Sin él, fútbol 11. */
  sport?: TacticalSport | null;
  /** M6c: notas y videos de la jugada (la ficha PDF los lista). */
  notes?: PlayNotes | null;
  videos?: PlayVideo[] | null;
  /** Ajustes de la pizarra del coach (M6g): curva de velocidad y rastros
   *  para el GIF/video y el visor 3D. */
  playback?: TacticalPlaybackOptions;
  /** Marca de agua «Hecho con SportMaps» y logo del club (tacticalWatermark.ts). */
  branding?: ExportBranding;
}

export interface ExportPngInput {
  players: TacticalStaticPlayer[];
  arrows: TacticalArrow[];
  title?: string | null;
  teamName?: string | null;
  /** M6b: configuración de los equipos. */
  teams?: TacticalTeamsConfig | null;
  /** Ancho del PNG en px (1080 = nítido en WhatsApp sin pesar de más). */
  widthPx?: number;
  /** Deporte de la cancha (T4). Sin él, fútbol 11. */
  sport?: TacticalSport | null;
  /** Marca de agua y logo del club. Sin dato: marca de agua, sin logo. */
  branding?: ExportBranding;
}

const BRAND_GREEN = '#1a6118';

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Jugada → PNG con una franja abajo: (logo del club) título + equipo a la
 *  izquierda, «Hecho con SportMaps · sportmaps.co» a la derecha. */
export async function exportPng(input: ExportPngInput): Promise<Blob> {
  const width = Math.round(input.widthPx ?? 1080);
  const { dataUrl, aspect } = await renderTacticalPng(input.players || [], input.arrows || [], width, input.sport, input.teams);
  const pitchH = Math.round(width * aspect);
  const band = Math.max(48, Math.round(width * 0.085));
  const img = await loadImage(dataUrl);
  const logo = await loadLogo(input.branding?.clubLogoUrl);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = pitchH + band;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas no disponible.');
  ctx.drawImage(img, 0, 0, width, pitchH);

  ctx.fillStyle = BRAND_GREEN;
  ctx.fillRect(0, pitchH, width, band);
  const pad = Math.round(band * 0.32);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  let brandW = 0;
  if (wantsWatermark(input.branding)) {
    ctx.font = `700 ${Math.round(band * 0.24)}px Helvetica, Arial, sans-serif`;
    brandW = ctx.measureText(WATERMARK_TEXT).width;
    ctx.textAlign = 'right';
    ctx.fillText(WATERMARK_TEXT, width - pad, pitchH + band / 2);
  }
  // Logo del club (solo con el permiso del tier) a la izquierda de la franja.
  let left = pad;
  if (logo) {
    const lh = band - pad;
    const lw = Math.min(lh * 3, lh * (logo.naturalWidth / Math.max(1, logo.naturalHeight)));
    ctx.drawImage(logo, pad, pitchH + pad / 2, lw, lh);
    left = pad * 2 + lw;
  }

  const maxW = width - left - pad * 2 - brandW;
  const title = (input.title ?? '').trim();
  const team = (input.teamName ?? '').trim();
  ctx.textAlign = 'left';
  if (title && team) {
    ctx.font = `700 ${Math.round(band * 0.28)}px Helvetica, Arial, sans-serif`;
    ctx.fillText(fitText(ctx, title, maxW), left, pitchH + band * 0.36);
    ctx.globalAlpha = 0.85;
    ctx.font = `500 ${Math.round(band * 0.22)}px Helvetica, Arial, sans-serif`;
    ctx.fillText(fitText(ctx, team, maxW), left, pitchH + band * 0.7);
    ctx.globalAlpha = 1;
  } else if (title || team) {
    ctx.font = `700 ${Math.round(band * 0.3)}px Helvetica, Arial, sans-serif`;
    ctx.fillText(fitText(ctx, title || team, maxW), left, pitchH + band / 2);
  }

  return canvasToBlob(canvas, 'image/png');
}
