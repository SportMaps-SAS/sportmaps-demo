import { useState } from 'react';
import jsPDF from 'jspdf';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Download, Loader2 } from 'lucide-react';
import { getFootballLineup, getFootballLineups, type Lineup } from '@/lib/school/footballQueries';
import { renderTacticalPng } from '@/lib/export/tacticalImage';
import { fetchTeamSportRow } from '@/hooks/useTeamTacticalSport';
import { sportFromTeam } from '@/lib/school/tacticalSports';

/**
 * PDF del mesociclo COMPLETO (spec rediseno-seguimiento-deportivo.md, F3):
 * portada con el plan, cada semana con su objetivo y su cierre, cada día con
 * sus sesiones, cada sesión con TODOS sus bloques y la jugada dibujada en la
 * pizarra (TacticalStaticSvg → PNG), las sesiones sin enganchar, la rúbrica y
 * el cierre del mesociclo.
 *
 * Todo se lee fresco de la base al tocar el botón (no del caché de la
 * pantalla): el PDF es lo que hay guardado, no lo que se está editando.
 */

const BRAND_GREEN: [number, number, number] = [26, 97, 24]; // #1a6118, mismo verde que executivePdf.tsx
const BRAND_GREEN_SOFT: [number, number, number] = [232, 243, 231];
const INK: [number, number, number] = [30, 30, 30];
const MUTED: [number, number, number] = [110, 110, 110];
const LINE: [number, number, number] = [215, 215, 215];

const DAY_TYPE_LABEL: Record<string, string> = {
    descanso: 'Descanso',
    entrenamiento: 'Entrenamiento',
    partido: 'Partido',
    regenerativo: 'Regenerativo',
    activacion: 'Activación',
};

const COMPONENT_LABEL: Record<string, string> = {
    tecnico: 'Técnico',
    tactico: 'Táctico',
    fisico: 'Físico',
    arqueros: 'Arqueros',
    mixto: 'Mixto',
};

const OBJECTIVES_MET_LABEL: Record<string, string> = { si: 'Sí', parcial: 'Parcial', no: 'No' };

/** Mismos indicadores y cortes que MesocycleRubricTable (no se exportan desde allá). */
const RUBRIC_INDICATORS = [
    { key: 'tecnica_individual', label: 'Técnica individual' },
    { key: 'toma_decisiones', label: 'Toma de decisiones' },
    { key: 'principios_juego', label: 'Principios de juego' },
    { key: 'condicion_fisica', label: 'Condición física' },
    { key: 'comportamiento_colectivo', label: 'Comportamiento colectivo' },
    { key: 'rendimiento_competitivo', label: 'Rendimiento competitivo' },
] as const;
const RUBRIC_CHECKPOINTS = [
    { key: 'inicial', label: 'Inicial' },
    { key: 'semana_2', label: 'Sem. 2' },
    { key: 'semana_3', label: 'Sem. 3' },
    { key: 'semana_4', label: 'Sem. 4' },
    { key: 'final', label: 'Final' },
] as const;

// ─── Tipos de lo que se lee ─────────────────────────────────────────────────

interface MesocycleRow {
    id: string;
    team_id?: string;
    starts_on: string;
    ends_on: string;
    general_objective?: string | null;
    game_model?: string | null;
    n_sessions_planned?: number | null;
    session_duration_minutes?: number | null;
    evaluation_mode?: string | null;
    closing_review?: { strengths?: string; areas_to_improve?: string; next_cycle_notes?: string } | null;
}
interface MicrocycleRow {
    id: string;
    number?: number | null;
    starts_on: string;
    ends_on: string;
    objective?: string | null;
    objective_compliance?: string | null;
    collective_performance?: string | null;
    improvement_notes?: string | null;
}
interface DayRow {
    id: string;
    microcycle_id: string;
    day_date: string;
    day_type: string;
    planned_rpe?: number | null;
    planned_minutes?: number | null;
    focus?: string | null;
}
interface SessionBlockRow {
    id?: string;
    name?: string;
    minutes?: string | number | null;
    activity?: string | null;
    objective?: string | null;
    description?: string | null;
    component?: string | null;
}
interface SessionRow {
    id: string;
    session_date: string;
    microcycle_day_id: string | null;
    objectives?: string | null;
    game_principles?: string | null;
    materials?: string | null;
    notes?: string | null;
    warmup?: string | null;
    drills?: { name?: string; focus?: string; duration?: string }[] | null;
    session_blocks?: SessionBlockRow[] | null;
    evaluation?: { rpe?: number; objectives_met?: string } | null;
}
interface RubricRow { indicator: string; checkpoint: string; score: number | null; not_applicable?: boolean }
interface BlockImage { dataUrl: string; aspect: number }

interface MesocycleExportButtonProps {
    mesocycleId: string;
    /** Se usa como respaldo si la lectura fresca falla; MesocycleSection pasa
     *  la fila completa de training_mesocycles. */
    mesocycle: {
        starts_on: string;
        ends_on: string;
        general_objective?: string | null;
        game_model?: string | null;
        team_id?: string;
    };
    teamName: string;
}

// ─── Utilidades ─────────────────────────────────────────────────────────────

function formatDateLabel(dateStr: string) {
    return format(new Date(`${dateStr}T12:00:00`), "d 'de' MMMM", { locale: es });
}

function formatLongDay(dateStr: string) {
    const s = format(new Date(`${dateStr}T12:00:00`), "EEEE d 'de' MMMM", { locale: es });
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function slugifyForFilename(value: string) {
    return value
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

/** Caracteres extra de WinAnsi (lo que las fuentes estándar de jsPDF pintan
 *  además de Latin-1). Fuera de eso un carácter sale como basura: se cambia
 *  por un equivalente o se quita (emojis, flechas, etc.). */
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function clean(value: unknown): string {
    if (value == null) return '';
    return String(value)
        .replace(/\r\n?/g, '\n')
        .replace(/[→⇒➜➔]/g, '->')
        .replace(/[←⇐]/g, '<-')
        .replace(/[✓✔]/g, 'v')
        .replace(/[^\n\t\x20-\xFF]/g, (ch) => (WIN_ANSI_EXTRA.includes(ch) ? ch : ''))
        .trim();
}

function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

// ─── Escritor paginado ──────────────────────────────────────────────────────

const MARGIN = 15;
const TOP_FIRST = 14;
const TOP_NEXT = 26;
const BOTTOM_LIMIT = 18; // espacio reservado para el pie

class PdfWriter {
    doc: jsPDF;
    y: number;
    readonly pageWidth: number;
    readonly pageHeight: number;
    readonly contentWidth: number;

    constructor(private teamName: string, private rangeLabel: string) {
        this.doc = new jsPDF({ unit: 'mm', format: 'a4' });
        this.pageWidth = this.doc.internal.pageSize.getWidth();
        this.pageHeight = this.doc.internal.pageSize.getHeight();
        this.contentWidth = this.pageWidth - MARGIN * 2;
        this.y = TOP_FIRST;
    }

    get bottom() {
        return this.pageHeight - BOTTOM_LIMIT;
    }

    newPage() {
        this.doc.addPage();
        this.drawRunningHeader();
        this.y = TOP_NEXT;
    }

    /** Salta de página si lo que viene (en mm) no entra. */
    ensure(needed: number) {
        if (this.y + needed > this.bottom) this.newPage();
    }

    drawRunningHeader() {
        const { doc } = this;
        doc.setFillColor(...BRAND_GREEN);
        doc.rect(0, 0, this.pageWidth, 16, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        doc.text(clean(this.teamName), MARGIN, 10);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.text(`Mesociclo · ${this.rangeLabel}`, this.pageWidth - MARGIN, 10, { align: 'right' });
    }

    setFont(size: number, style: 'normal' | 'bold' | 'italic' | 'bolditalic' = 'normal', color: [number, number, number] = INK) {
        this.doc.setFont('helvetica', style);
        this.doc.setFontSize(size);
        this.doc.setTextColor(...color);
    }

    lineHeight(size: number) {
        return size * 0.42 + 0.6;
    }

    /** Párrafo con salto de página línea por línea: nunca se sale del borde. */
    paragraph(text: string, opts: { x?: number; width?: number; size?: number; style?: 'normal' | 'bold' | 'italic' | 'bolditalic'; color?: [number, number, number]; after?: number } = {}) {
        const value = clean(text);
        if (!value) return;
        const x = opts.x ?? MARGIN;
        const width = opts.width ?? this.pageWidth - MARGIN - x;
        const size = opts.size ?? 9.5;
        const lh = this.lineHeight(size);
        this.setFont(size, opts.style ?? 'normal', opts.color ?? INK);
        const lines: string[] = this.doc.splitTextToSize(value, width);
        for (const line of lines) {
            this.ensure(lh);
            // ensure() puede haber cambiado de página y de fuente (encabezado).
            this.setFont(size, opts.style ?? 'normal', opts.color ?? INK);
            this.doc.text(line, x, this.y + lh * 0.75);
            this.y += lh;
        }
        this.y += opts.after ?? 1;
    }

    /** "Etiqueta: valor" con la etiqueta en negrita y el valor envuelto debajo
     *  si es largo. Mantiene etiqueta + primera línea juntas. */
    field(label: string, value: unknown, opts: { x?: number; size?: number } = {}) {
        const v = clean(value);
        if (!v) return;
        const x = opts.x ?? MARGIN;
        const size = opts.size ?? 9;
        const width = this.pageWidth - MARGIN - x;
        this.setFont(size, 'bold', [70, 70, 70]);
        const labelText = `${label}: `;
        const labelW = this.doc.getTextWidth(labelText);
        this.setFont(size, 'normal', INK);
        const firstLines: string[] = this.doc.splitTextToSize(v, width - labelW);
        const lh = this.lineHeight(size);
        this.ensure(lh * Math.min(2, firstLines.length));
        this.setFont(size, 'bold', [70, 70, 70]);
        this.doc.text(labelText, x, this.y + lh * 0.75);
        this.setFont(size, 'normal', INK);
        this.doc.text(firstLines[0], x + labelW, this.y + lh * 0.75);
        this.y += lh;
        const rest = firstLines.slice(1).join(' ');
        if (rest) this.paragraph(rest, { x: x + labelW, size, after: 0 });
        this.y += 0.8;
    }

    sectionTitle(text: string, right?: string) {
        this.ensure(14);
        this.setFont(13, 'bold', BRAND_GREEN);
        this.doc.text(clean(text), MARGIN, this.y + 5);
        if (right) {
            this.setFont(9, 'normal', MUTED);
            this.doc.text(clean(right), this.pageWidth - MARGIN, this.y + 5, { align: 'right' });
        }
        this.y += 7;
        this.doc.setDrawColor(...BRAND_GREEN);
        this.doc.setLineWidth(0.5);
        this.doc.line(MARGIN, this.y, this.pageWidth - MARGIN, this.y);
        this.y += 4;
    }

    finish() {
        const { doc } = this;
        const total = doc.getNumberOfPages();
        for (let i = 1; i <= total; i++) {
            doc.setPage(i);
            doc.setDrawColor(...LINE);
            doc.setLineWidth(0.2);
            doc.line(MARGIN, this.pageHeight - 14, this.pageWidth - MARGIN, this.pageHeight - 14);
            doc.setTextColor(140, 140, 140);
            doc.setFontSize(7.5);
            doc.setFont('helvetica', 'normal');
            doc.text('SportMaps · Plan de mesociclo', MARGIN, this.pageHeight - 9);
            doc.text(`Página ${i} de ${total}`, this.pageWidth - MARGIN, this.pageHeight - 9, { align: 'right' });
        }
    }
}

// ─── Secciones del PDF ──────────────────────────────────────────────────────

function drawCover(w: PdfWriter, meso: MesocycleRow, teamName: string, rangeLabel: string, stats: { weeks: number; sessions: number; drawings: number }) {
    const { doc } = w;
    doc.setFillColor(...BRAND_GREEN);
    doc.rect(0, 0, w.pageWidth, 46, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('PLAN DE MESOCICLO', MARGIN, 14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.text(doc.splitTextToSize(clean(teamName), w.contentWidth)[0] ?? '', MARGIN, 26);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text(rangeLabel, MARGIN, 35);
    doc.setFontSize(8);
    doc.text(`Generado el ${format(new Date(), "d 'de' MMMM yyyy, HH:mm", { locale: es })}`, MARGIN, 41);
    w.y = 54;

    // Tarjetas de resumen.
    const cards: { label: string; value: string }[] = [
        { label: 'Sesiones planificadas', value: meso.n_sessions_planned != null ? String(meso.n_sessions_planned) : '—' },
        { label: 'Minutos por sesión', value: meso.session_duration_minutes != null ? `${meso.session_duration_minutes} min` : '—' },
        { label: 'Semanas', value: String(stats.weeks) },
        { label: 'Sesiones cargadas', value: String(stats.sessions) },
    ];
    const gap = 4;
    const cardW = (w.contentWidth - gap * (cards.length - 1)) / cards.length;
    cards.forEach((c, i) => {
        const x = MARGIN + i * (cardW + gap);
        doc.setFillColor(...BRAND_GREEN_SOFT);
        doc.roundedRect(x, w.y, cardW, 18, 2, 2, 'F');
        w.setFont(14, 'bold', BRAND_GREEN);
        doc.text(c.value, x + cardW / 2, w.y + 9, { align: 'center' });
        w.setFont(7.5, 'normal', MUTED);
        doc.text(c.label, x + cardW / 2, w.y + 14.5, { align: 'center' });
    });
    w.y += 24;
    if (stats.drawings > 0) {
        w.paragraph(`Incluye ${stats.drawings} jugada${stats.drawings === 1 ? '' : 's'} dibujada${stats.drawings === 1 ? '' : 's'} en la pizarra táctica.`, { size: 8.5, style: 'italic', color: MUTED, after: 3 });
    }

    w.setFont(10.5, 'bold', INK);
    w.ensure(10);
    doc.text('Objetivo general', MARGIN, w.y + 4);
    w.y += 6.5;
    w.paragraph(meso.general_objective || 'Sin objetivo general cargado.', { size: 9.5, color: meso.general_objective ? INK : MUTED, after: 4 });

    w.setFont(10.5, 'bold', INK);
    w.ensure(10);
    doc.text('Modelo de juego', MARGIN, w.y + 4);
    w.y += 6.5;
    w.paragraph(meso.game_model || 'Sin modelo de juego cargado.', { size: 9.5, color: meso.game_model ? INK : MUTED, after: 6 });
}

function drawWeekHeader(w: PdfWriter, n: number, mc: MicrocycleRow) {
    w.ensure(30); // título + algo de contenido: nunca un título huérfano al pie
    w.sectionTitle(`Semana ${n}`, `${formatDateLabel(mc.starts_on)} – ${formatDateLabel(mc.ends_on)}`);
    if (mc.objective) w.field('Objetivo del microciclo', mc.objective);
}

function drawWeekClosing(w: PdfWriter, mc: MicrocycleRow) {
    const items: [string, string | null | undefined][] = [
        ['Cumplimiento de objetivos', mc.objective_compliance],
        ['Rendimiento colectivo', mc.collective_performance],
        ['Aspectos a mejorar', mc.improvement_notes],
    ];
    if (!items.some(([, v]) => clean(v))) return;
    w.ensure(16);
    w.y += 1;
    w.setFont(9.5, 'bold', BRAND_GREEN);
    w.doc.text(`Cierre de la semana`, MARGIN, w.y + 4);
    w.y += 6;
    items.forEach(([label, value]) => w.field(label, value, { x: MARGIN + 3 }));
    w.y += 2;
}

function drawDayHeader(w: PdfWriter, date: string, day: DayRow | null) {
    w.ensure(22);
    const { doc } = w;
    doc.setFillColor(245, 245, 245);
    doc.rect(MARGIN, w.y, w.contentWidth, 7, 'F');
    w.setFont(10, 'bold', INK);
    doc.text(formatLongDay(date), MARGIN + 2, w.y + 4.9);
    const label = day ? (DAY_TYPE_LABEL[day.day_type] || day.day_type) : 'Sin día planificado';
    const labelX = MARGIN + 2 + doc.getTextWidth(formatLongDay(date)) + 4;
    w.setFont(8.5, 'normal', day ? BRAND_GREEN : MUTED);
    doc.text(clean(label), labelX, w.y + 4.9);
    if (day) {
        const meta: string[] = [];
        if (day.planned_rpe != null) meta.push(`RPE planificado ${day.planned_rpe}`);
        if (day.planned_minutes != null) meta.push(`${day.planned_minutes} min`);
        if (meta.length) {
            w.setFont(8.5, 'normal', MUTED);
            doc.text(meta.join(' · '), w.pageWidth - MARGIN - 2, w.y + 4.9, { align: 'right' });
        }
    }
    w.y += 9;
    if (day?.focus) w.paragraph(`Enfoque: ${day.focus}`, { x: MARGIN + 2, size: 8.5, style: 'italic', color: MUTED, after: 1.5 });
}

function drawBlock(w: PdfWriter, block: SessionBlockRow, index: number, image: BlockImage | null) {
    const { doc } = w;
    const x = MARGIN + 4;
    const width = w.pageWidth - MARGIN - x;
    // Encabezado del bloque + al menos dos líneas juntos.
    w.ensure(16);
    doc.setFillColor(...BRAND_GREEN_SOFT);
    doc.rect(x, w.y, width, 6, 'F');
    doc.setFillColor(...BRAND_GREEN);
    doc.rect(x, w.y, 1.2, 6, 'F');
    w.setFont(9, 'bold', INK);
    const name = clean(block.name) || `Bloque ${index + 1}`;
    doc.text(`${index + 1}. ${name}`, x + 3, w.y + 4.2);
    const meta: string[] = [];
    const minutes = clean(block.minutes);
    if (minutes) meta.push(`${minutes} min`);
    if (block.component) meta.push(COMPONENT_LABEL[block.component] || clean(block.component));
    if (meta.length) {
        w.setFont(8.5, 'bold', BRAND_GREEN);
        doc.text(meta.join(' · '), x + width - 2, w.y + 4.2, { align: 'right' });
    }
    w.y += 7.5;

    const inner = x + 3;
    w.field('Actividad', block.activity, { x: inner, size: 8.5 });
    w.field('Objetivo', block.objective, { x: inner, size: 8.5 });
    w.field('Descripción', block.description, { x: inner, size: 8.5 });
    if (!clean(block.activity) && !clean(block.objective) && !clean(block.description) && !image) {
        w.paragraph('Sin contenido cargado.', { x: inner, size: 8, style: 'italic', color: MUTED, after: 0.5 });
    }

    if (image) {
        const imgW = 70;
        const imgH = imgW * image.aspect;
        w.ensure(imgH + 7);
        w.setFont(7.5, 'bold', MUTED);
        doc.text(`Jugada en la pizarra: ${name}`, inner, w.y + 3);
        w.y += 4.5;
        doc.addImage(image.dataUrl, 'PNG', inner, w.y, imgW, imgH);
        doc.setDrawColor(...LINE);
        doc.setLineWidth(0.2);
        doc.rect(inner, w.y, imgW, imgH);
        w.y += imgH + 2;
    }
    w.y += 2;
}

function drawSession(w: PdfWriter, session: SessionRow, ordinal: number | null, loose: boolean, images: Map<string, BlockImage>) {
    w.ensure(18);
    const x = MARGIN + 2;
    w.setFont(9.5, 'bold', INK);
    const title = `${ordinal != null ? `Sesión ${ordinal}` : 'Sesión'}${loose ? ' (sin enganchar a un día del plan)' : ''}`;
    w.doc.text(title, x, w.y + 4);
    const ev = session.evaluation || null;
    const evParts: string[] = [];
    if (ev?.rpe != null) evParts.push(`RPE real ${ev.rpe}`);
    if (ev?.objectives_met) evParts.push(`Objetivos cumplidos: ${OBJECTIVES_MET_LABEL[ev.objectives_met] || ev.objectives_met}`);
    if (evParts.length) {
        w.setFont(8, 'normal', MUTED);
        w.doc.text(evParts.join(' · '), w.pageWidth - MARGIN - 2, w.y + 4, { align: 'right' });
    }
    w.y += 6;

    w.field('Objetivo de la sesión', session.objectives || 'Sin objetivo', { x });
    w.field('Principios de juego', session.game_principles, { x });

    const blocks = asArray<SessionBlockRow>(session.session_blocks);
    if (blocks.length > 0) {
        const total = blocks.reduce((acc, b) => acc + (Number(b.minutes) || 0), 0);
        w.ensure(8);
        w.setFont(8.5, 'bold', MUTED);
        w.doc.text(`Bloques (${blocks.length})${total > 0 ? ` · ${total} min en total` : ''}`, x, w.y + 3.5);
        w.y += 5.5;
        blocks.forEach((b, i) => drawBlock(w, b, i, b.id ? images.get(b.id) ?? null : null));
    } else {
        // Sesiones viejas (antes de los bloques): calentamiento + ejercicios.
        w.field('Calentamiento', session.warmup, { x });
        const drills = asArray<{ name?: string; focus?: string; duration?: string }>(session.drills).filter((d) => clean(d.name));
        drills.forEach((d, i) => {
            const extra = [clean(d.focus), clean(d.duration) ? `${clean(d.duration)} min` : ''].filter(Boolean).join(' · ');
            w.paragraph(`${i + 1}. ${clean(d.name)}${extra ? ` — ${extra}` : ''}`, { x: x + 3, size: 8.5, after: 0.5 });
        });
    }

    w.field('Material', session.materials, { x });
    w.field('Notas', session.notes, { x });
    w.y += 3;
}

function drawRubric(w: PdfWriter, meso: MesocycleRow, rows: RubricRow[]) {
    w.ensure(60);
    w.sectionTitle('Rúbrica de evaluación del mesociclo');
    if (meso.evaluation_mode === 'individual' && rows.length === 0) {
        w.paragraph('Este mesociclo se evalúa por deportista (modo individual). Las notas de cada deportista se consultan en la app.', { size: 9, style: 'italic', color: MUTED, after: 4 });
        return;
    }
    if (rows.length === 0) {
        w.paragraph('Todavía no hay calificaciones cargadas en la rúbrica.', { size: 9, style: 'italic', color: MUTED, after: 4 });
        return;
    }
    const scores = new Map<string, number | 'N/A' | null>(rows.map((r) => [`${r.indicator}__${r.checkpoint}`, r.not_applicable ? 'N/A' : r.score]));
    const { doc } = w;
    const firstCol = 62;
    const colW = (w.contentWidth - firstCol) / RUBRIC_CHECKPOINTS.length;
    const rowH = 7;
    // Encabezado
    doc.setFillColor(...BRAND_GREEN);
    doc.rect(MARGIN, w.y, w.contentWidth, rowH, 'F');
    w.setFont(8.5, 'bold', [255, 255, 255]);
    doc.text('Indicador', MARGIN + 2, w.y + 4.7);
    RUBRIC_CHECKPOINTS.forEach((cp, i) => doc.text(cp.label, MARGIN + firstCol + colW * i + colW / 2, w.y + 4.7, { align: 'center' }));
    w.y += rowH;
    RUBRIC_INDICATORS.forEach((ind, r) => {
        if (r % 2 === 1) {
            doc.setFillColor(247, 247, 247);
            doc.rect(MARGIN, w.y, w.contentWidth, rowH, 'F');
        }
        w.setFont(8.5, 'normal', INK);
        doc.text(ind.label, MARGIN + 2, w.y + 4.7);
        RUBRIC_CHECKPOINTS.forEach((cp, i) => {
            const v = scores.get(`${ind.key}__${cp.key}`);
            w.setFont(9, typeof v === 'number' ? 'bold' : 'normal', typeof v === 'number' ? INK : [170, 170, 170]);
            doc.text(v != null ? String(v) : '—', MARGIN + firstCol + colW * i + colW / 2, w.y + 4.7, { align: 'center' });
        });
        w.y += rowH;
    });
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.2);
    doc.rect(MARGIN, w.y - rowH * (RUBRIC_INDICATORS.length + 1), w.contentWidth, rowH * (RUBRIC_INDICATORS.length + 1));
    w.y += 6;
}

function drawClosing(w: PdfWriter, meso: MesocycleRow) {
    const c = meso.closing_review || {};
    w.ensure(30);
    w.sectionTitle('Cierre del mesociclo');
    const items: [string, string | undefined][] = [
        ['Fortalezas', c.strengths],
        ['Aspectos a mejorar', c.areas_to_improve],
        ['Notas para el próximo mesociclo', c.next_cycle_notes],
    ];
    if (!items.some(([, v]) => clean(v))) {
        w.paragraph('Todavía no se registró el cierre del mesociclo.', { size: 9, style: 'italic', color: MUTED });
        return;
    }
    items.forEach(([label, value]) => w.field(label, value || '—'));
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function MesocycleExportButton({ mesocycleId, mesocycle, teamName }: MesocycleExportButtonProps) {
    const { toast } = useToast();
    const [isGenerating, setIsGenerating] = useState(false);
    const [status, setStatus] = useState('');

    async function handleExport() {
        setIsGenerating(true);
        setStatus('Leyendo el plan…');
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tablas fuera de los tipos generados
            const db = supabase as any;

            const { data: mesoFresh } = await db.from('training_mesocycles').select('*').eq('id', mesocycleId).maybeSingle();
            const meso: MesocycleRow = { ...(mesocycle as MesocycleRow), ...((mesoFresh as MesocycleRow) || {}), id: mesocycleId };

            const { data: mcData, error: mcError } = await db
                .from('training_microcycles')
                .select('*')
                .eq('mesocycle_id', mesocycleId)
                .order('starts_on', { ascending: true });
            if (mcError) throw mcError;
            const microcycles = (mcData || []) as MicrocycleRow[];

            const mcIds = microcycles.map((m) => m.id);
            const { data: dayData, error: daysError } = mcIds.length > 0
                ? await db.from('training_microcycle_days').select('*').in('microcycle_id', mcIds).order('day_date', { ascending: true })
                : { data: [], error: null };
            if (daysError) throw daysError;
            const days = (dayData || []) as DayRow[];

            const dayIds = days.map((d) => d.id);
            const { data: sessData, error: sessionsError } = dayIds.length > 0
                ? await db.from('training_sessions').select('*').in('microcycle_day_id', dayIds).order('created_at', { ascending: true })
                : { data: [], error: null };
            if (sessionsError) throw sessionsError;
            const daySessions = (sessData || []) as SessionRow[];

            // Sesiones del equipo dentro de las fechas del mesociclo que no
            // quedaron enganchadas a un día (las "sueltas" de MesocycleSection).
            let looseSessions: SessionRow[] = [];
            if (meso.team_id) {
                const { data: looseData } = await db
                    .from('training_sessions')
                    .select('*')
                    .eq('team_id', meso.team_id)
                    .is('microcycle_day_id', null)
                    .gte('session_date', meso.starts_on)
                    .lte('session_date', meso.ends_on)
                    .order('session_date', { ascending: true });
                looseSessions = (looseData || []) as SessionRow[];
            }

            const { data: rubricData } = await db
                .from('training_mesocycle_evaluations')
                .select('indicator, checkpoint, score, not_applicable')
                .eq('mesocycle_id', mesocycleId);
            const rubric = (rubricData || []) as RubricRow[];

            // Jugadas de la pizarra: UNA lectura por equipo, mapeada por bloque.
            const allSessions = [...daySessions, ...looseSessions];
            const blockIds = new Set(
                allSessions.flatMap((s) => asArray<SessionBlockRow>(s.session_blocks).map((b) => b.id).filter((id): id is string => !!id)),
            );
            const images = new Map<string, BlockImage>();
            if (meso.team_id && blockIds.size > 0) {
                // T4: la cancha del deporte del equipo (sin deporte → fútbol 11).
                const sport = sportFromTeam(await fetchTeamSportRow(meso.team_id).catch(() => null));
                let lineups: Lineup[] = [];
                try {
                    lineups = await getFootballLineups({ team_id: meso.team_id, source_type: 'training_session' });
                } catch {
                    lineups = []; // sin pizarra (no fútbol, BFF caído): el PDF sale igual, sin dibujos
                }
                const byBlock = new Map(lineups.filter((l) => blockIds.has(l.source_id)).map((l) => [l.source_id, l]));
                let done = 0;
                for (const [blockId, lineup] of byBlock) {
                    done++;
                    setStatus(`Dibujando jugadas ${done}/${byBlock.size}…`);
                    try {
                        const detail = await getFootballLineup(lineup.id);
                        const players = (detail.players || [])
                            .filter((p) => p.role === 'starter' && p.x != null && p.y != null)
                            .map((p) => ({ x: Number(p.x), y: Number(p.y), label: p.slot_label ?? undefined, jersey: p.jersey_number ?? null, role: 'starter' as const }));
                        const arrows = asArray<Lineup['arrows'][number]>(detail.arrows ?? lineup.arrows);
                        if (players.length === 0 && arrows.length === 0) continue;
                        images.set(blockId, await renderTacticalPng(players, arrows, undefined, sport));
                    } catch {
                        // Una jugada que no se pudo leer o dibujar no tumba el PDF.
                    }
                }
            }

            setStatus('Armando el PDF…');
            const rangeLabel = `${formatDateLabel(meso.starts_on)} – ${formatDateLabel(meso.ends_on)}`;
            const w = new PdfWriter(teamName, rangeLabel);
            drawCover(w, meso, teamName, rangeLabel, { weeks: microcycles.length, sessions: allSessions.length, drawings: images.size });

            const sessionsByDayId = new Map<string, SessionRow[]>();
            daySessions.forEach((s) => {
                if (!s.microcycle_day_id) return;
                sessionsByDayId.set(s.microcycle_day_id, [...(sessionsByDayId.get(s.microcycle_day_id) || []), s]);
            });
            const placedLoose = new Set<string>();

            microcycles.forEach((mc, idx) => {
                drawWeekHeader(w, idx + 1, mc);
                const mcDays = days.filter((d) => d.microcycle_id === mc.id);
                const looseHere = looseSessions.filter((s) => mc.starts_on <= s.session_date && s.session_date <= mc.ends_on && !placedLoose.has(s.id));
                const dates = Array.from(new Set([...mcDays.map((d) => d.day_date), ...looseHere.map((s) => s.session_date)])).sort();
                if (dates.length === 0) {
                    w.paragraph('Sin días cargados en esta semana.', { size: 9, style: 'italic', color: MUTED, after: 3 });
                }
                dates.forEach((date) => {
                    const dayRowsForDate = mcDays.filter((d) => d.day_date === date);
                    const looseForDate = looseHere.filter((s) => s.session_date === date);
                    const entries = dayRowsForDate.length > 0 ? dayRowsForDate : [null];
                    entries.forEach((day, entryIdx) => {
                        drawDayHeader(w, date, day);
                        const list = day ? sessionsByDayId.get(day.id) || [] : [];
                        const loose = entryIdx === 0 ? looseForDate : [];
                        const total = list.length + loose.length;
                        if (total === 0 && day && day.day_type !== 'descanso') {
                            w.paragraph('Sin sesión cargada.', { x: MARGIN + 2, size: 8.5, style: 'italic', color: MUTED, after: 2 });
                        }
                        list.forEach((s, i) => drawSession(w, s, total > 1 ? i + 1 : null, false, images));
                        loose.forEach((s, i) => {
                            placedLoose.add(s.id);
                            drawSession(w, s, total > 1 ? list.length + i + 1 : null, true, images);
                        });
                    });
                });
                drawWeekClosing(w, mc);
                w.y += 4;
            });

            const leftover = looseSessions.filter((s) => !placedLoose.has(s.id));
            if (leftover.length > 0) {
                w.sectionTitle('Sesiones sin semana');
                leftover.forEach((s) => {
                    drawDayHeader(w, s.session_date, null);
                    drawSession(w, s, null, true, images);
                });
            }

            drawRubric(w, meso, rubric);
            drawClosing(w, meso);
            w.finish();

            const filename = `mesociclo-${slugifyForFilename(teamName)}-${meso.starts_on}.pdf`;
            w.doc.save(filename);
        } catch (error: unknown) {
            toast({
                title: 'No se pudo generar el PDF',
                description: (error as { message?: string })?.message || 'Ocurrió un error al armar el mesociclo.',
                variant: 'destructive',
            });
        } finally {
            setIsGenerating(false);
            setStatus('');
        }
    }

    return (
        <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExport} disabled={isGenerating} aria-busy={isGenerating}>
            {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            {isGenerating ? status || 'Generando PDF…' : 'Exportar PDF'}
        </Button>
    );
}
