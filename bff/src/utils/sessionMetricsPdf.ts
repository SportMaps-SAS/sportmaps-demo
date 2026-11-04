/**
 * Agrupación y dibujo de `SessionMetricSummary` (avg/distribution/count) para
 * PDF — compartido entre el informe de equipo (`routes/school/reports.ts`) y
 * el informe individual del atleta (`routes/athlete-reports-pdf.ts`).
 *
 * Extraído de `routes/school/reports.ts`, que lo construyó primero para el
 * informe grupal: el individual calculaba estos mismos datos en el snapshot
 * (`buildReportSnapshot` → `metrics_session`) pero nunca los dibujaba, así
 * que el padre no veía lo que el atleta respondió después de cada entreno
 * (cansancio, comprensión, esfuerzo, satisfacción, aspectos a mejorar).
 */
import type { SessionMetricSummary } from '../services/report-snapshot.service';
import { INK, MUTED, drawDistributionBar } from './reportPdfHelpers';

export const SESSION_METRIC_SECTIONS: { key: string; title: string; metricKeys: string[] }[] = [
    { key: 'rpe_borg', title: 'Cansancio (BORG)', metricKeys: ['rpe_borg'] },
    { key: 'task_comprehension', title: 'Comprensión de las tareas', metricKeys: ['task_comprehension'] },
    { key: 'self_effort_pct', title: 'Esfuerzo y entrega', metricKeys: ['self_effort_pct'] },
    { key: 'satisfaction', title: 'Satisfacción y alegría', metricKeys: ['satisfaction'] },
    { key: 'focus', title: 'Aspectos a mejorar', metricKeys: [] }, // se completa dinámico: focus_*
    { key: 'coach_effort_rating', title: 'Lo que vio el entrenador', metricKeys: ['coach_effort_rating'] },
];

/** Dibuja una `SessionMetricSummary` (avg/distribution/count) como se ve en
 *  pantalla (`MetricCard`), pero en papel: número grande para `avg`, barras
 *  horizontales para `distribution`, y una sola barra "seleccionado N de M"
 *  para `count`. */
export function drawSessionMetric(doc: PDFKit.PDFDocument, m: SessionMetricSummary, accent: string) {
    if (doc.y > doc.page.height - 130) doc.addPage();

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(m.label, 60, doc.y);
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
        .text(`${m.n} respuesta${m.n === 1 ? '' : 's'}`, doc.page.width - 180, doc.y - 12, { width: 120, align: 'right' });
    doc.moveDown(0.3);

    if (m.aggregation === 'avg') {
        doc.fillColor(accent).font('Helvetica-Bold').fontSize(20).text(String(m.avg ?? '—'), 60, doc.y);
        doc.moveDown(0.5);
    } else if (m.aggregation === 'distribution') {
        for (const o of m.distribution ?? []) {
            drawDistributionBar(doc, o.label, o.pct, o.n, accent);
        }
        doc.moveDown(0.2);
    } else if (m.aggregation === 'count') {
        const pct = m.n > 0 ? Math.round(((m.count ?? 0) / m.n) * 1000) / 10 : 0;
        drawDistributionBar(doc, 'Veces seleccionado', pct, m.count ?? 0, accent);
        doc.moveDown(0.2);
    }
    doc.fillColor(INK);
}

/** Agrupa `metrics_session` por `SESSION_METRIC_SECTIONS`, resolviendo
 *  `focus_*` dinámicamente. Devuelve solo las secciones con al menos una
 *  métrica. */
export function groupSessionMetrics(metricsSession: SessionMetricSummary[]) {
    const metricsByKey = new Map(metricsSession.map((m) => [m.metric_key, m]));
    const focusMetrics = metricsSession.filter((m) => m.metric_key.startsWith('focus_'));

    return SESSION_METRIC_SECTIONS
        .map((section) => ({
            section,
            metrics: section.key === 'focus'
                ? focusMetrics
                : section.metricKeys.map((k) => metricsByKey.get(k)).filter((m): m is SessionMetricSummary => !!m),
        }))
        .filter((g) => g.metrics.length > 0);
}
