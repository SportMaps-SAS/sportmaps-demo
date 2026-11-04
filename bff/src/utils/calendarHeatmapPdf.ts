/**
 * "Día a día" del informe mensual -- pedido explícito de Besser (2026-11-03):
 * un mapa de calor del mes, no solo el promedio. Entrada: `CalendarDay[]`
 * (ver `report-snapshot.service.ts`), siempre el mes completo empezando en
 * lunes.
 */
import type { CalendarDay } from '../services/report-snapshot.service';
import { INK, MUTED } from './reportPdfHelpers';

// Rampa fija, independiente de la marca de la escuela: la intensidad del
// entreno no es una categoría ni un semáforo (esos colores están RESERVADOS
// -- ver docs/gotchas-tecnicos.md), así que usa su propia escala neutra.
const HEAT: string[] = ['#efe9e0', '#e3b9ad', '#cf7d6a', '#b94a37', '#8e2a1f'];

function heatLevel(effort: number | null): number {
    if (effort === null) return 1; // hubo entreno pero sin cansancio cargado
    if (effort <= 2.5) return 1;
    if (effort <= 5) return 2;
    if (effort <= 7.5) return 3;
    return 4;
}

const DOW = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

export function drawCalendarHeatmap(
    doc: PDFKit.PDFDocument,
    days: CalendarDay[],
    year: number,
    month: number,
    accent: string,
) {
    if (days.length === 0) return;

    const left = 60;
    const width = doc.page.width - 120;
    const cell = width / 7;
    const startWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // lunes=0

    let x = left;
    const headerY = doc.y;
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8);
    for (const d of DOW) {
        doc.text(d, x, headerY, { width: cell, align: 'center' });
        x += cell;
    }
    doc.y = headerY + 14;

    let col = startWeekday;
    let rowY = doc.y;
    const cellH = 26;

    for (const day of days) {
        const cx = left + col * cell;
        if (day.has_session) {
            const level = heatLevel(day.effort);
            doc.roundedRect(cx + 1.5, rowY + 1.5, cell - 3, cellH - 3, 3).fill(HEAT[level]);
            if (day.is_match) {
                doc.roundedRect(cx + 1.5, rowY + 1.5, cell - 3, cellH - 3, 3).lineWidth(1.3).strokeColor(accent).stroke();
            }
            doc.fillColor(level >= 3 ? '#ffffff' : INK).font('Helvetica-Bold').fontSize(8)
                .text(String(day.day), cx + 5, rowY + 4);
            if (day.minutes_played) {
                doc.font('Helvetica').fontSize(6.5)
                    .text(`${day.minutes_played}'`, cx + 3, rowY + cellH - 11, { width: cell - 8, align: 'right' });
            }
        } else {
            doc.fillColor('#c7c0b5').font('Helvetica').fontSize(8).text(String(day.day), cx + 5, rowY + 4);
        }

        col++;
        if (col > 6) {
            col = 0;
            rowY += cellH + 3;
        }
    }

    doc.fillColor(INK);
    doc.y = rowY + (col > 0 ? cellH + 3 : 0) + 6;

    // Leyenda
    const legendY = doc.y;
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text('Intensidad del entreno:', left, legendY + 2);
    let lx = left + 92;
    for (let level = 1; level <= 4; level++) {
        doc.roundedRect(lx, legendY, 11, 11, 2).fill(HEAT[level]);
        lx += 15;
    }
    doc.fillColor(MUTED).fontSize(7.5).text('suave a fuerte', lx + 2, legendY + 2);
    doc.roundedRect(lx + 78, legendY, 11, 11, 2).lineWidth(1.3).strokeColor(accent).stroke();
    doc.fillColor(MUTED).text('día de partido', lx + 94, legendY + 2);
    doc.y = legendY + 18;
}
