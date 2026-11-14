/**
 * Radar "panorama completo" del informe mensual del atleta -- misma idea que
 * `PlayerCard.tsx` (normaliza por banda, no por valor crudo: las métricas
 * tienen escalas distintas y graficar el número crudo en el mismo eje no
 * dice nada), pero dibujado a mano con primitivas de PDFKit porque no hay
 * motor de gráficos en el servidor.
 */
import type { SnapshotMetric } from '../services/report-snapshot.service';

const BAND_SCORE: Record<string, number> = { green: 85, yellow: 55, red: 25 };

/** Dibuja la telaraña + el polígono de datos centrado en (cx, cy). Sin
 *  rótulos por eje: con 15-20 métricas se amontonan y ya hay un listado de
 *  texto debajo (`drawRadarHighlights`) que dice lo mismo mejor. */
export function drawRadarChart(
    doc: PDFKit.PDFDocument,
    metrics: SnapshotMetric[],
    cx: number,
    cy: number,
    radius: number,
    color: string,
) {
    const n = metrics.length;
    if (n < 3) return;
    const angleStep = (2 * Math.PI) / n;
    const angleFor = (i: number) => -Math.PI / 2 + i * angleStep;

    for (const frac of [0.25, 0.5, 0.75, 1]) {
        const pts: [number, number][] = [];
        for (let i = 0; i < n; i++) {
            const a = angleFor(i);
            pts.push([cx + radius * frac * Math.cos(a), cy + radius * frac * Math.sin(a)]);
        }
        doc.polygon(...pts).strokeColor('#e5e7eb').lineWidth(0.75).stroke();
    }
    for (let i = 0; i < n; i++) {
        const a = angleFor(i);
        doc.moveTo(cx, cy).lineTo(cx + radius * Math.cos(a), cy + radius * Math.sin(a))
            .strokeColor('#e5e7eb').lineWidth(0.75).stroke();
    }

    const dataPts: [number, number][] = metrics.map((m, i) => {
        const score = m.band ? (BAND_SCORE[m.band] ?? 50) : 50;
        const a = angleFor(i);
        const r = (radius * score) / 100;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });
    doc.polygon(...dataPts).fillOpacity(0.35).fillAndStroke(color, color);
    doc.fillOpacity(1).lineWidth(1);
}
