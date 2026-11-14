/**
 * Ficha del ejercicio en PDF (spec docs/specs/pizarra-nivel-tacticalpad.md, T2).
 *
 * Una sola hoja A4: encabezado, la jugada grande (cuadro 1), la secuencia de
 * cuadros en miniatura si hay más de uno (máx. 6 casillas; con más, la última
 * dice «+n») y los campos del ejercicio. Lo que no cabe en la hoja se corta
 * con «…»: es una ficha, no un documento.
 */
import type { TacticalTeamsConfig } from '@/lib/school/tacticalTeams';
import jsPDF from 'jspdf';
import { format } from 'date-fns';
import type { TacticalArrow } from '@/lib/school/footballQueries';
import type { TacticalFrame } from '@/lib/school/tacticalFrames';
import type { TacticalSport } from '@/lib/school/tacticalSports';
import type { TacticalStaticPlayer } from '@/components/school/TacticalStaticSvg';
import { renderTacticalPng } from './tacticalImage';
import { frameToStatic } from './tacticalInterpolation';
import { cleanPdfText as clean } from './tacticalExportUtils';
import { logoDataUrl, wantsWatermark, WATERMARK_TEXT, WATERMARK_URL, type ExportBranding } from './tacticalWatermark';
import {
  PROVIDER_LABEL, formatClock, noteToPlainLines, publicVideos, watchUrl,
  type PlayNotes, type PlayVideo,
} from '@/lib/school/tacticalMedia';

export interface ExercisePdfInput {
  title: string;
  objective?: string | null;
  minutes?: number | string | null;
  ageGroup?: string | null;
  materials?: string | null;
  description?: string | null;
  teamName?: string | null;
  frames: TacticalFrame[] | null;
  players: TacticalStaticPlayer[];
  arrows: TacticalArrow[];
  playerLabels?: Record<string, string>;
  playerJerseys?: Record<string, number | null>;
  /** M6b: configuración de los equipos (sin ella, el dibujo de siempre). */
  teams?: TacticalTeamsConfig | null;
  /** M6b: clave → nombre real. Solo viaja con «Mostrar nombres» prendido. */
  playerNames?: Record<string, string>;
  /** Deporte de la cancha (T4). Sin él, fútbol 11. */
  sport?: TacticalSport | null;
  /** M6c: notas de la jugada y videos (enlaces como texto, nunca incrustados). */
  notes?: PlayNotes | null;
  videos?: PlayVideo[] | null;
  /** «Hecho con SportMaps · sportmaps.co» en el pie y logo del club en el encabezado. */
  branding?: ExportBranding;
}

export interface PdfMediaSections {
  noteLines: string[];
  tags: string;
  frameNotes: string[];
  videos: { label: string; url: string }[];
  /** Videos con «enlace privado»: la ficha se comparte, no salen. */
  privateCount: number;
}

/** Lo que la ficha muestra de notas y videos (lógica pura, se prueba en unidad). */
export function pdfMediaSections(input: Pick<ExercisePdfInput, 'notes' | 'videos' | 'frames'>): PdfMediaSections {
  const noteLines = input.notes?.text ? noteToPlainLines(input.notes.text).map((l) => clean(l)) : [];
  const tags = (input.notes?.tags ?? []).map((t) => clean(t)).filter(Boolean).join(' · ');
  const frames = input.frames && input.frames.length > 1 ? input.frames : [];
  const frameNotes = frames.flatMap((f, i) => (f.note ? [`Cuadro ${i + 1}: ${noteToPlainLines(f.note).map((l) => clean(l)).filter(Boolean).join(' ')}`] : []));
  const all = input.videos ?? [];
  const shown = publicVideos(all);
  const videos = shown.flatMap((v) => {
    const url = watchUrl(v);
    if (!url) return [];
    const when = v.start_s ? ` · desde ${formatClock(v.start_s)}${v.end_s ? ` hasta ${formatClock(v.end_s)}` : ''}` : '';
    return [{ label: clean(`${v.title} (${PROVIDER_LABEL[v.provider]}${when})`), url }];
  });
  return { noteLines, tags, frameNotes, videos, privateCount: all.length - shown.length };
}

const BRAND_GREEN: [number, number, number] = [26, 97, 24]; // mismo verde que MesocycleExportButton/executivePdf
const BRAND_GREEN_SOFT: [number, number, number] = [232, 243, 231];
const TEXT_DARK: [number, number, number] = [31, 41, 55];
const TEXT_MUTED: [number, number, number] = [107, 114, 128];
const MARGIN = 15;
const PITCH_ASPECT = 340 / 300;
export const PDF_MAX_STRIP = 6;

/** Casillas de la tira: hasta 6 miniaturas; con más cuadros, 5 + «+n». */
export function stripSlots(frameCount: number): { thumbs: number; more: number } {
  if (frameCount <= 1) return { thumbs: 0, more: 0 };
  if (frameCount <= PDF_MAX_STRIP) return { thumbs: frameCount, more: 0 };
  return { thumbs: PDF_MAX_STRIP - 1, more: frameCount - (PDF_MAX_STRIP - 1) };
}

export async function exportExercisePdf(input: ExercisePdfInput): Promise<Blob> {
  const frames = input.frames && input.frames.length > 0 ? input.frames : null;
  const first = frames
    ? frameToStatic(frames[0], input.playerLabels, input.playerJerseys, input.playerNames)
    : { players: input.players || [], arrows: input.arrows || [] };
  const { thumbs, more } = stripSlots(frames?.length ?? 0);

  const main = await renderTacticalPng(first.players, first.arrows, 900, input.sport, input.teams);
  const thumbImgs: string[] = [];
  for (let i = 0; i < thumbs; i++) {
    const s = frameToStatic(frames![i], input.playerLabels, input.playerJerseys, input.playerNames);
    thumbImgs.push((await renderTacticalPng(s.players, s.arrows, 300, input.sport, input.teams)).dataUrl);
  }

  const logo = await logoDataUrl(input.branding?.clubLogoUrl);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const contentW = pageW - MARGIN * 2;
  const bottom = pageH - 16;

  // ── Encabezado ──────────────────────────────────────────────────────────
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, 0, pageW, 24, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text('FICHA DEL EJERCICIO', MARGIN, 8);
  const team = clean(input.teamName);
  // Logo del club (solo con el permiso del tier) arriba a la derecha.
  let logoW = 0;
  if (logo) {
    const lh = 16;
    logoW = Math.min(lh * 3, lh * logo.aspect);
    try { doc.addImage(logo.dataUrl, 'PNG', pageW - MARGIN - logoW, 4, logoW, lh); } catch { logoW = 0; }
  }
  if (team) doc.text(doc.splitTextToSize(team, 80)[0] ?? '', pageW - MARGIN - (logoW ? logoW + 3 : 0), 8, { align: 'right' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(doc.splitTextToSize(clean(input.title) || 'Ejercicio', contentW - (logoW ? logoW + 4 : 0))[0] ?? '', MARGIN, 17.5);

  // ── Jugada grande ───────────────────────────────────────────────────────
  let y = 30;
  const mainW = thumbs > 0 ? 100 : 118;
  const mainH = mainW * (main.aspect || PITCH_ASPECT);
  doc.addImage(main.dataUrl, 'PNG', (pageW - mainW) / 2, y, mainW, mainH);
  doc.setDrawColor(209, 213, 219);
  doc.setLineWidth(0.3);
  doc.rect((pageW - mainW) / 2, y, mainW, mainH);
  y += mainH + 6;

  // ── Secuencia de cuadros ────────────────────────────────────────────────
  if (thumbs > 0 && frames) {
    doc.setTextColor(...TEXT_MUTED);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.text(`SECUENCIA (${frames.length} cuadros)`, MARGIN, y);
    y += 2.5;
    const gap = 3;
    const slotW = (contentW - gap * (PDF_MAX_STRIP - 1)) / PDF_MAX_STRIP;
    // M6d: misma proporción que la jugada grande (cámara/orientación del «Campo»).
    const slotH = slotW * (main.aspect || PITCH_ASPECT);
    thumbImgs.forEach((img, i) => {
      const x = MARGIN + i * (slotW + gap);
      doc.addImage(img, 'PNG', x, y, slotW, slotH);
      doc.setDrawColor(209, 213, 219);
      doc.rect(x, y, slotW, slotH);
      doc.setFillColor(...BRAND_GREEN);
      doc.circle(x + 3.6, y + 3.6, 2.8, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.text(String(i + 1), x + 3.6, y + 4.6, { align: 'center' });
    });
    if (more > 0) {
      const x = MARGIN + thumbs * (slotW + gap);
      doc.setFillColor(...BRAND_GREEN_SOFT);
      doc.setDrawColor(209, 213, 219);
      doc.rect(x, y, slotW, slotH, 'FD');
      doc.setTextColor(...BRAND_GREEN);
      doc.setFontSize(16);
      doc.text(`+${more}`, x + slotW / 2, y + slotH / 2 + 2, { align: 'center' });
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.text('cuadros más', x + slotW / 2, y + slotH / 2 + 7, { align: 'center' });
    }
    y += slotH + 7;
  }

  // ── Campos ──────────────────────────────────────────────────────────────
  const minutes = clean(input.minutes);
  const meta: [string, string][] = [
    ['Duración', minutes ? `${minutes} min` : ''],
    ['Edad o categoría', clean(input.ageGroup)],
  ];
  const metaFilled = meta.filter(([, v]) => v);
  if (metaFilled.length) {
    doc.setFillColor(...BRAND_GREEN_SOFT);
    doc.rect(MARGIN, y - 4.5, contentW, 8, 'F');
    let x = MARGIN + 3;
    for (const [label, value] of metaFilled) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...BRAND_GREEN);
      doc.text(`${label}:`, x, y + 0.6);
      const lw = doc.getTextWidth(`${label}: `);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...TEXT_DARK);
      doc.text(value, x + lw, y + 0.6);
      x += lw + doc.getTextWidth(value) + 10;
    }
    y += 9;
  }

  const sections: [string, string][] = [
    ['Objetivo', clean(input.objective)],
    ['Material', clean(input.materials)],
    ['Descripción', clean(input.description)],
  ];
  const LINE = 4.4;
  for (const [label, value] of sections) {
    if (!value) continue;
    if (y + 10 > bottom) break;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...BRAND_GREEN);
    doc.text(label.toUpperCase(), MARGIN, y);
    y += 4.8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...TEXT_DARK);
    const lines = doc.splitTextToSize(value, contentW) as string[];
    const room = Math.max(1, Math.floor((bottom - y) / LINE));
    const shown = lines.slice(0, room);
    if (lines.length > room) shown[shown.length - 1] = `${shown[shown.length - 1].replace(/\s*\S{0,3}$/, '')}…`;
    doc.text(shown, MARGIN, y);
    y += shown.length * LINE + 4;
  }

  // ── Notas y videos (M6c) ────────────────────────────────────────────────
  // Lo que no entra en la hoja sigue en una segunda: una nota no se corta.
  const media = pdfMediaSections(input);
  const ensure = (h: number) => {
    if (y + h <= bottom) return;
    doc.addPage();
    y = MARGIN + 4;
  };
  const heading = (label: string) => {
    ensure(12);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...BRAND_GREEN);
    doc.text(label.toUpperCase(), MARGIN, y);
    y += 4.8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...TEXT_DARK);
  };
  const paragraph = (lines: string[]) => {
    for (const raw of lines) {
      if (!raw) { y += 1.6; continue; }
      for (const l of doc.splitTextToSize(raw, contentW) as string[]) {
        ensure(LINE);
        doc.text(l, MARGIN, y);
        y += LINE;
      }
    }
    y += 3;
  };
  if (media.noteLines.length || media.tags) {
    heading('Notas');
    if (media.noteLines.length) paragraph(media.noteLines);
    if (media.tags) {
      doc.setTextColor(...TEXT_MUTED);
      paragraph([`Etiquetas: ${media.tags}`]);
      doc.setTextColor(...TEXT_DARK);
    }
  }
  if (media.frameNotes.length) {
    heading('Notas por cuadro');
    paragraph(media.frameNotes);
  }
  if (media.videos.length || media.privateCount) {
    heading('Videos');
    for (const v of media.videos) {
      paragraph([v.label]);
      y -= 3;
      doc.setTextColor(37, 99, 235);
      for (const l of doc.splitTextToSize(v.url, contentW) as string[]) {
        ensure(LINE);
        doc.textWithLink(l, MARGIN, y, { url: v.url });
        y += LINE;
      }
      doc.setTextColor(...TEXT_DARK);
      y += 2;
    }
    if (media.privateCount) {
      doc.setTextColor(...TEXT_MUTED);
      paragraph([`${media.privateCount} ${media.privateCount === 1 ? 'video privado no se incluye' : 'videos privados no se incluyen'} en la ficha.`]);
      doc.setTextColor(...TEXT_DARK);
    }
  }

  // ── Pie (en cada hoja) ──────────────────────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let pg = 1; pg <= pages; pg++) {
    doc.setPage(pg);
    doc.setDrawColor(229, 231, 235);
    doc.line(MARGIN, pageH - 11, pageW - MARGIN, pageH - 11);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...TEXT_MUTED);
    const footer = `${wantsWatermark(input.branding) ? `${clean(WATERMARK_TEXT)} · ` : ''}Ficha generada el ${format(new Date(), 'dd/MM/yyyy')}${pages > 1 ? ` · ${pg}/${pages}` : ''}`;
    if (wantsWatermark(input.branding)) doc.textWithLink(footer, MARGIN, pageH - 6.5, { url: WATERMARK_URL });
    else doc.text(footer, MARGIN, pageH - 6.5);
    if (team) doc.text(doc.splitTextToSize(team, 80)[0] ?? '', pageW - MARGIN, pageH - 6.5, { align: 'right' });
  }

  return doc.output('blob');
}
