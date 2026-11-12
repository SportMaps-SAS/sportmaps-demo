/**
 * F4 del Informe Mensual del Atleta — PDF al vuelo (spec §8.4, §15).
 *
 * El resto de F4 (lista + detalle interactivo + mark_report_viewed) ya estaba
 * construido en frontend/src/pages/Child{Reports,ReportDetail}Page.tsx — esto
 * era lo único que faltaba. Diseño alineado con saasInvoicePdf.service.ts
 * (fondo blanco, línea de acento fina, cajas con borde redondeado, footer
 * "Powered by SportMaps") en vez del look de certificates.ts (banda sólida) —
 * es el mismo patrón de marca condicional que ya usan los correos
 * (schoolBrandingResolver: logo propio si hay whitelabel, si no SportMaps).
 *
 * §8.4: "El snapshot es la única fuente de la vista del padre y del PDF."
 * Este archivo NO lee performance_entries ni recalcula nada — solo el jsonb
 * ya congelado al publicar.
 */
import { Router, Request, Response, NextFunction } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { requireAuth } from '../middlewares/authMiddleware';
import { esAdminDePlataforma } from '../middlewares/requirePlatformAdmin';
import { resolveSchoolBranding } from '../utils/schoolBrandingResolver';
import {
    INK, MUTED, HAIRLINE,
    loadSportmapsLogo, fetchSchoolLogo, fmt, capitalize,
    sectionTitle, noteBox, addFooterToAllPages, drawBrandHeader,
} from '../utils/reportPdfHelpers';
import { groupSessionMetrics, drawSessionMetric } from '../utils/sessionMetricsPdf';
import { drawRadarChart } from '../utils/radarPdf';
import { renderAthleteReportV2 } from '../utils/athleteReportPdfV2';
import { opcionesV2 } from '../utils/athleteReportV2Context';
import { drawCalendarHeatmap } from '../utils/calendarHeatmapPdf';

const router = Router();

const BAND_HEX: Record<string, string> = { green: '#16a34a', yellow: '#d97706', red: '#dc2626' };
const CATEGORY_LABEL: Record<string, string> = {
    physical: 'Físico', technical: 'Técnico', tactical: 'Táctico', attendance: 'Asistencia', other: 'Otro',
};

async function isAuthorized(req: Request, report: any): Promise<boolean> {
    const userId = req.user!.id;

    if (report.recipient_id && report.recipient_id === userId) return true;
    if (report.subject_type === 'profile' && report.subject_id === userId) return true;
    if (report.subject_type === 'child') {
        const { data: child } = await supabase
            .from('children').select('parent_id').eq('id', report.subject_id).maybeSingle();
        if (child?.parent_id === userId) return true;
    }

    const staffRoles = ['owner', 'admin', 'school_admin', 'school', 'super_admin', 'coach'];
    if (staffRoles.includes(req.role)) {
        // 'admin' es admin DE ESCUELA (membresía): no da alcance global. Solo
        // plataforma ve informes de cualquier escuela; el resto cae al chequeo
        // de school_staff de abajo.
        if (req.role === 'super_admin' && await esAdminDePlataforma(userId)) return true;
        // Admin de la escuela DUEÑA del informe (req.schoolId viene de school_members).
        if (['owner', 'admin', 'school_admin', 'school'].includes(req.role) && report.school_id === req.schoolId) return true;
        const { data: staff } = await supabase
            .from('school_staff').select('id').eq('coach_auth_id', userId).eq('school_id', report.school_id).maybeSingle();
        if (staff) return true;
    }

    return false;
}

const ParamId = z.object({ id: z.string().uuid() });

// ============================================================================
// GET /api/v1/athlete-reports/:id/pdf
// ============================================================================
router.get(
    '/:id/pdf',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const parse = ParamId.safeParse(req.params);
            if (!parse.success) return res.status(400).json({ error: 'invalid_id' });

            const { data: report, error } = await supabase
                .from('athlete_reports' as any)
                .select('id, school_id, subject_type, subject_id, status, recipient_id, period_year, period_month, snapshot')
                .eq('id', parse.data.id)
                .maybeSingle();

            if (error || !report) return res.status(404).json({ error: 'report_not_found' });

            if ((report as any).status !== 'publicado') {
                return res.status(403).json({ error: 'report_not_published' });
            }

            if (!(await isAuthorized(req, report))) {
                return res.status(403).json({ error: 'forbidden' });
            }

            const snapshot = (report as any).snapshot;
            if (!snapshot) return res.status(409).json({ error: 'snapshot_missing' });

            // Interruptor por escuela del diseño: 'v2' = una página con banda de marca; cualquier otra cosa = el de siempre.
            const { data: cfg } = await supabase.from('school_settings' as any)
                .select('report_pdf_version').eq('school_id', (report as any).school_id).maybeSingle();
            if ((cfg as any)?.report_pdf_version === 'v2') {
                const opts = await opcionesV2(snapshot, report as any);
                const doc2 = new PDFDocument({ size: 'A4', margin: 60, bufferPages: true });
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `inline; filename="informe-${snapshot.period.year}-${String(snapshot.period.month).padStart(2, '0')}.pdf"`);
                doc2.pipe(res);
                renderAthleteReportV2(doc2, opts);
                doc2.end();
                return;
            }

            const branding = await resolveSchoolBranding((report as any).school_id);
            const [sportmapsLogo, schoolLogo] = await Promise.all([
                Promise.resolve(loadSportmapsLogo()),
                fetchSchoolLogo(branding.logoUrl),
            ]);

            // bufferPages: el footer se dibuja al final sobre las páginas YA
            // creadas (switchToPage), no "al vuelo" mientras se escribe el
            // contenido -- escribir texto cerca del borde inferior dispara la
            // paginación automática de pdfkit y deja una página fantasma casi
            // en blanco con el footer duplicado (bug real, visto en QA).
            const doc = new PDFDocument({ size: 'A4', margin: 60, bufferPages: true });
            // No cachear: el snapshot puede regenerarse (snapshot_version sube) y el
            // padre tiene que ver siempre la última versión, no una descarga vieja
            // que el navegador sirvió de su caché HTTP.
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader(
                'Content-Disposition',
                `inline; filename="informe-${snapshot.period.year}-${String(snapshot.period.month).padStart(2, '0')}.pdf"`,
            );
            doc.pipe(res);

            renderAthleteReportPdf(doc, snapshot, branding, branding.hasWhitelabel ? schoolLogo : (schoolLogo ?? sportmapsLogo));

            doc.end();
        } catch (err) {
            next(err);
        }
    },
);

/** Dibuja el Informe Mensual del Atleta en `doc`. Sin I/O: la usa la ruta y los scripts de vista previa. */
export function renderAthleteReportPdf(doc: PDFKit.PDFDocument, snapshot: any, branding: any, headerLogo: Buffer | null) {
    // ── Header: logo (propio si hay whitelabel, si no SportMaps) + línea de acento ──
    // Con marca blanca nunca cae al logo de SportMaps: si el propio no
    // descarga, va el nombre de la escuela en texto.
    const accentY = drawBrandHeader(doc, headerLogo, branding.schoolName, 'Informe Mensual del Atleta');

    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
        .text(capitalize(snapshot.period.label), doc.page.width - 220, 55, { width: 160, align: 'right' });
    if (snapshot.governing_team) {
        doc.fillColor(INK).fontSize(11).font('Helvetica-Bold')
            .text(snapshot.governing_team.name, doc.page.width - 220, 69, { width: 160, align: 'right' });
    }

    doc.rect(60, accentY, doc.page.width - 120, 2.5).fill(branding.primaryColor);
    doc.x = 60;
    doc.y = accentY + 24;

    // ── Atleta ──
    doc.fillColor(MUTED).fontSize(9).font('Helvetica-Bold').text('ATLETA', 60, doc.y, { characterSpacing: 0.5 });
    doc.fillColor(INK).fontSize(18).font('Helvetica-Bold').text(snapshot.athlete.name, 60, doc.y + 2);
    doc.moveDown(0.3);
    // Una frase que reconoce el esfuerzo del mes -- el informe es para
    // que un papá o una mamá lo lea con ganas, no una planilla.
    const primerNombre = (snapshot.athlete.name as string).split(' ')[0];
    const fraseMotivacion = snapshot.highlights?.length > 0
        ? `¡${primerNombre} tuvo un gran mes! Así le fue en ${capitalize(snapshot.period.label)}.`
        : `Cada entreno cuenta. Así va ${primerNombre} en ${capitalize(snapshot.period.label)}.`;
    doc.fillColor(MUTED).fontSize(10).font('Helvetica-Oblique').text(fraseMotivacion, 60, doc.y);
    doc.moveDown(0.8);

    // ── Fila de cajas: fútbol + asistencia ──
    const boxesTop = doc.y;
    const boxH = 62;
    const gap = 10;
    const footballStats: [string, string][] = snapshot.football
        ? [
            ['Partidos', String(snapshot.football.matches_played)],
            ['Minutos', `${snapshot.football.minutes_played}'`],
            ['Goles', String(snapshot.football.goals)],
            ['Asist.', String(snapshot.football.assists)],
            ['Amar.', String(snapshot.football.yellow_cards)],
            ['Roja', String(snapshot.football.red_cards)],
        ]
        : [];
    const a = snapshot.attendance;
    const trainingLoadCell: [string, string][] = snapshot.training_load
        ? [['Carga (UA)', snapshot.training_load.total_ua.toFixed(0)]]
        : [];
    const cells = [...footballStats, ['Asistencia', a.pct !== null ? `${a.pct}%` : `${a.present}/${a.total}`], ...trainingLoadCell];
    const boxW = (doc.page.width - 120 - gap * (cells.length - 1)) / cells.length;
    cells.forEach(([label, value], i) => {
        const x = 60 + i * (boxW + gap);
        doc.roundedRect(x, boxesTop, boxW, boxH, 6).lineWidth(1).strokeColor(HAIRLINE).stroke();
        doc.fillColor(branding.primaryColor).fontSize(15).font('Helvetica-Bold')
            .text(value, x, boxesTop + 14, { width: boxW, align: 'center' });
        doc.fillColor(MUTED).fontSize(7).font('Helvetica')
            .text(label.toUpperCase(), x, boxesTop + 38, { width: boxW, align: 'center', characterSpacing: 0.3 });
    });
    // Las cajas de arriba se dibujan con x explícito por caja; sin
    // devolver el cursor al margen izquierdo, el próximo .text() sin
    // x/y (sectionTitle) arranca desde la ÚLTIMA caja (la de más a la
    // derecha) y el título se parte en 3 líneas angostas -- bug real,
    // visto renderizando el PDF.
    doc.x = 60;
    doc.y = boxesTop + boxH + 22;

    // ── Panorama completo (radar) ──
    // TODAS las métricas con historia, no solo las de este mes --
    // pedido explícito: "que se alimente de todo lo que se le puede
    // medir a un deportista". Mismo radar que ve el coach en el
    // roster (PlayerCard.tsx), congelado acá para el padre.
    if (snapshot.radar?.length >= 3) {
        sectionTitle(doc, 'Panorama completo', INK);
        doc.fillColor(MUTED).fontSize(9).font('Helvetica')
            .text(`${snapshot.radar.length} métricas medidas en total`, 60, doc.y);
        doc.moveDown(0.4);
        const radarTop = doc.y;
        const radarRadius = 78;
        const cx = 60 + radarRadius + 10;
        const cy = radarTop + radarRadius;
        drawRadarChart(doc, snapshot.radar, cx, cy, radarRadius, branding.primaryColor);

        const destacadas = snapshot.radar.filter((m: any) => m.band === 'green');
        const listX = cx + radarRadius + 30;
        const listW = doc.page.width - 60 - listX;
        let listY = radarTop + 4;
        doc.fillColor('#15803d').font('Helvetica-Bold').fontSize(9).text('LO QUE MÁS DESTACA', listX, listY, { width: listW, characterSpacing: 0.3 });
        listY += 16;
        if (destacadas.length === 0) {
            doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9).text('Todavía nada en banda verde.', listX, listY, { width: listW });
        } else {
            for (const m of destacadas.slice(0, 6)) {
                doc.fillColor(INK).font('Helvetica').fontSize(9.5)
                    .text(`${m.label}: ${fmt(m.value, m.unit)}`, listX, listY, { width: listW });
                listY += 14;
            }
        }
        doc.x = 60; // la lista de destacados quedó dibujada a la derecha (listX)
        doc.y = Math.max(radarTop + radarRadius * 2 + 10, listY + 6);
        doc.fillColor(INK);
        doc.moveDown(0.6);
    }

    // ── Destacados ──
    if (snapshot.highlights?.length > 0) {
        sectionTitle(doc, 'Lo mejor del mes', '#15803d');
        for (const m of snapshot.highlights) drawMetricLine(doc, m);
        doc.moveDown(0.8);
    }

    // ── A trabajar ──
    if (snapshot.to_work_on?.length > 0) {
        sectionTitle(doc, 'En qué trabajar', '#b45309');
        for (const m of snapshot.to_work_on) drawMetricLine(doc, m);
        doc.moveDown(0.8);
    }

    // ── Todas las métricas, por categoría ──
    const byCategory = new Map<string, any[]>();
    for (const m of snapshot.metrics ?? []) {
        const cat = m.category ?? 'other';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(m);
    }
    for (const cat of ['physical', 'technical', 'tactical', 'attendance', 'other']) {
        const rows = byCategory.get(cat);
        if (!rows?.length) continue;
        if (doc.y > doc.page.height - 150) doc.addPage();
        sectionTitle(doc, CATEGORY_LABEL[cat], INK);
        for (const m of rows) drawMetricLine(doc, m);
        doc.moveDown(0.5);
    }

    // ── Autoevaluación después de cada entreno (§3.4) ──
    // Lo que se mide VARIAS veces al mes (cansancio, comprensión,
    // esfuerzo, satisfacción, aspectos a mejorar, rating del coach por
    // sesión) no entra en `metrics` arriba -- esa sección solo compara
    // última-vs-anterior, que es ruido para algo que se registra 8-18
    // veces. Sin esto el informe salía incompleto: el padre veía estos
    // datos en "Historial y Evolución" pero nunca en el informe mensual.
    const sessionGroups = groupSessionMetrics(snapshot.metrics_session ?? []);
    if (sessionGroups.length > 0) {
        if (doc.y > doc.page.height - 150) doc.addPage();
        sectionTitle(doc, 'Después de cada entreno', INK);
        for (const { section, metrics } of sessionGroups) {
            if (doc.y > doc.page.height - 130) doc.addPage();
            doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9)
                .text(section.title.toUpperCase(), 60, doc.y, { characterSpacing: 0.3 });
            doc.moveDown(0.3);
            for (const m of metrics) drawSessionMetric(doc, m, branding.primaryColor);
            doc.moveDown(0.3);
        }
    }

    // ── Día a día (mapa de calor) ──
    if (snapshot.calendar?.length > 0) {
        if (doc.y > doc.page.height - 260) doc.addPage();
        sectionTitle(doc, `${capitalize(snapshot.period.label)}, día a día`, INK);
        drawCalendarHeatmap(doc, snapshot.calendar, snapshot.period.year, snapshot.period.month, branding.primaryColor);
    }

    // ── Notas ──
    if (doc.y > doc.page.height - 220) doc.addPage();
    if (snapshot.coach_note) {
        doc.moveDown(0.4);
        noteBox(doc, 'Nota del entrenador', snapshot.coach_note, branding.primaryColor);
    }
    for (const n of snapshot.team_notes ?? []) {
        doc.moveDown(0.4);
        noteBox(doc, n.team_name, n.body, branding.primaryColor);
    }

    // Footer en cada página ya creada, después de que todo el contenido
    // se terminó de escribir -- range() es estable recién acá.
    addFooterToAllPages(doc, branding.showWatermark);
}

function drawMetricLine(doc: PDFKit.PDFDocument, m: any) {
    const bandColor = m.band ? BAND_HEX[m.band] : '#9ca3af';
    const deltaTxt = m.delta !== null && m.delta !== undefined
        ? ` (${m.delta > 0 ? '+' : ''}${fmt(m.delta, m.unit)})`
        : '';
    const y = doc.y;
    doc.circle(64, y + 6, 3).fill(bandColor);
    doc.fillColor(INK).font('Helvetica').fontSize(10)
        .text(`${m.label}: ${fmt(m.value, m.unit)}${deltaTxt}`, 74, y);
    doc.moveDown(0.25);
}

export default router;
