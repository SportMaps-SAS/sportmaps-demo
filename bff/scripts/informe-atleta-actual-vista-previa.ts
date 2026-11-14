/**
 * Vista previa del informe mensual ACTUAL (el que hoy reciben las familias) de una escuela, con un atleta real ANONIMIZADO.
 * Solo lee. Usa el mismo dibujo y la misma marca que la ruta /athlete-reports/:id/pdf.
 *   SCHOOL_ID=<uuid> npx tsx scripts/informe-atleta-actual-vista-previa.ts <salida.pdf> [año] [mes]
 */
import 'dotenv/config';
import { createWriteStream } from 'node:fs';
import PDFDocument from 'pdfkit';
import { supabase } from '../src/config/supabase';
import { buildReportSnapshot } from '../src/services/report-snapshot.service';
import { renderAthleteReportPdf } from '../src/routes/athlete-reports-pdf';
import { resolveSchoolBranding } from '../src/utils/schoolBrandingResolver';
import { loadSportmapsLogo, fetchSchoolLogo, addFooterToAllPages } from '../src/utils/reportPdfHelpers';

const SCHOOL_ID = process.env.SCHOOL_ID!;

async function main() {
    const [salida, y, m] = process.argv.slice(2);
    if (!SCHOOL_ID || !salida) throw new Error('Uso: SCHOOL_ID=<uuid> ... <salida.pdf> [año] [mes]');
    const year = Number(y ?? 2026), month = Number(m ?? 10);
    const desde = `${year}-${String(month).padStart(2, '0')}-01`;
    const hasta = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);

    const { data: pe } = await supabase.from('performance_entries').select('subject_id')
        .eq('school_id', SCHOOL_ID).eq('subject_type', 'child').gte('recorded_at', desde).lt('recorded_at', hasta).limit(5000);
    const conteo = new Map<string, number>();
    for (const r of pe ?? []) conteo.set((r as any).subject_id, (conteo.get((r as any).subject_id) ?? 0) + 1);
    const top = [...conteo.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) throw new Error('Sin evaluaciones ese mes.');
    const { data: insc } = await supabase.from('enrollments').select('team_id').eq('child_id', top[0]).eq('school_id', SCHOOL_ID).eq('status', 'active').limit(1);

    const snapshot: any = await buildReportSnapshot({
        schoolId: SCHOOL_ID, subjectType: 'child', subjectId: top[0], year, month,
        governingTeamId: (insc?.[0] as any)?.team_id ?? null, coachNote: null,
    });
    snapshot.athlete = { ...snapshot.athlete, name: 'Santiago Ejemplo' };
    snapshot.coach_note = null;
    snapshot.team_notes = [];

    const branding = await resolveSchoolBranding(SCHOOL_ID);
    const schoolLogo = await fetchSchoolLogo(branding.logoUrl);
    const headerLogo = branding.hasWhitelabel ? schoolLogo : (schoolLogo ?? loadSportmapsLogo());
    const doc = new PDFDocument({ size: 'A4', margin: 60, bufferPages: true });
    doc.pipe(createWriteStream(salida));
    renderAthleteReportPdf(doc, snapshot, branding, headerLogo);
    doc.end();
    console.log('PDF actual:', salida, `· ${snapshot.metrics.length} métricas, ${snapshot.radar.length} en radar`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
