/**
 * Vista previa del Informe Mensual del Atleta (V2, una página) de Club Carmel con datos REALES y el atleta ANONIMIZADO.
 * Solo lee: no escribe en la base ni publica nada.
 *
 *   cd bff
 *   npx tsx scripts/informe-atleta-vista-previa.ts <logo.jpg|png> <salida.pdf> [año] [mes] [infantil|tecnico]
 *
 * El comentario es un BORRADOR armado con reglas a partir de los datos del mes (no es IA ni lo escribió el entrenador):
 * en producción lo redactaría Mapi y el entrenador lo aprobaría o editaría.
 */
import 'dotenv/config';
import { readFileSync, createWriteStream } from 'node:fs';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { supabase } from '../src/config/supabase';
import { buildReportSnapshot } from '../src/services/report-snapshot.service';
import { renderAthleteReportV2, mejorRacha, type TonoInforme } from '../src/utils/athleteReportPdfV2';

const SCHOOL_ID = process.env.SCHOOL_ID ?? '374a6716-af42-4745-afe1-8d089153e01b'; // Carmel por defecto

/** Quita el fondo claro de un logo JPG para que no salga el recuadro gris (los PNG con alfa pasan tal cual). */
async function logoTransparente(path: string): Promise<Buffer> {
    const buf = readFileSync(path);
    const meta = await sharp(buf).metadata();
    if (meta.hasAlpha) return buf;
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) {
        const claridad = Math.min(data[i], data[i + 1], data[i + 2]);
        data[i + 3] = claridad >= 238 ? 0 : claridad <= 195 ? 255 : Math.round(((238 - claridad) / 43) * 255);
    }
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function logoDeUrl(url: string | null): Promise<Buffer | null> {
    if (!url) return null;
    const r = await fetch(url);
    if (!r.ok) return null;
    const tmp = Buffer.from(await r.arrayBuffer());
    const meta = await sharp(tmp).metadata();
    if (meta.hasAlpha) return sharp(tmp).png().toBuffer();
    const { data, info } = await sharp(tmp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // Fondo sólido (JPG): se deja tal cual; el logo de la escuela se muestra como lo subió.
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Color de fondo del logo (esquina) si es un JPG con fondo; '#ffffff' si ya trae transparencia o es claro. */
async function fondoDelLogo(src: string | null): Promise<string> {
    if (!src) return '#ffffff';
    const buf = src.startsWith('http') ? Buffer.from(await (await fetch(src)).arrayBuffer()) : readFileSync(src);
    const meta = await sharp(buf).metadata();
    if (meta.hasAlpha) return '#ffffff';
    const { data } = await sharp(buf).extract({ left: 0, top: 0, width: 4, height: 4 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const [r, g, b] = [data[0], data[1], data[2]];
    // Casi blanco → banda blanca (el logo se vuelve transparente); si no, el color del fondo del logo.
    return Math.min(r, g, b) >= 238 ? '#ffffff' : '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

async function main() {
    const [logoPath, salida, y, m, tonoArg] = process.argv.slice(2);
    // logoPath = 'db' → usa el logo y el color que la escuela tiene guardados.
    const { data: esc } = await supabase.from('schools').select('name, logo_url, branding_settings').eq('id', SCHOOL_ID).maybeSingle();
    const color = (esc as any)?.branding_settings?.primary_color ?? '#1D6FB8';
    const sec = (esc as any)?.branding_settings?.secondary_color ?? '#0F172A';
    if (!logoPath || !salida) throw new Error('Uso: <logo> <salida.pdf> [año] [mes] [infantil|tecnico]');
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
    const teamId = (insc?.[0] as any)?.team_id ?? null;
    const base = { schoolId: SCHOOL_ID, subjectType: 'child' as const, subjectId: top[0], governingTeamId: teamId, coachNote: null };

    const snapshot = await buildReportSnapshot({ ...base, year, month });
    const mesAnt = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
    const anterior = await buildReportSnapshot({ ...base, ...mesAnt }).catch(() => null);
    const prevAvg = anterior?.metrics_session.find((x) => x.metric_key === 'coach_effort_rating');

    // Anonimizar: nada que identifique al niño.
    snapshot.athlete = { ...snapshot.athlete, name: 'Santiago Ejemplo' };
    snapshot.coach_note = null;
    snapshot.team_notes = [];

    // Tono: categorías con año de nacimiento <= 2012 (14+) van técnicas; el resto, infantil.
    const anio = Number(/(\d{4})/.exec(snapshot.governing_team?.name ?? '')?.[1] ?? 0);
    const tono: TonoInforme = (tonoArg as TonoInforme) ?? ((anio && anio <= 2012) || /juvenil|mayores|senior|adult|sub-?1[5-9]/i.test(snapshot.governing_team?.name ?? '') ? 'tecnico' : 'infantil');

    // Enfoque del mes: objetivo general del mesociclo vigente del equipo.
    let enfoque: string | null = null;
    if (teamId) {
        const { data: meso } = await supabase.from('training_mesocycles').select('general_objective')
            .eq('team_id', teamId).lte('starts_on', hasta).gte('ends_on', desde).order('starts_on', { ascending: false }).limit(1);
        enfoque = ((meso?.[0] as any)?.general_objective as string | undefined)?.trim() || null;
    }

    // Comentario BORRADOR, solo con lo que el dato permite afirmar.
    const comp = snapshot.metrics_session.find((x) => x.metric_key === 'coach_effort_rating');
    const racha = mejorRacha(snapshot.calendar);
    const { present, total, pct } = snapshot.attendance;
    const primer = 'Santiago';
    const mesNombre = snapshot.period.label.split(' ')[0];
    const partes: string[] = [];
    if (pct !== null && total > 0) {
        partes.push(tono === 'infantil'
            ? `${primer} vino a ${present} de los ${total} entrenos de ${mesNombre}${racha >= 3 ? ` y llegó a ${racha} días seguidos sin faltar` : ''}. ¡Eso se nota en el grupo!`
            : `${primer} asistió a ${present} de ${total} entrenos (${pct} %)${racha >= 3 ? `, con una racha de ${racha} días seguidos` : ''}.`);
    }
    if (comp?.avg !== undefined) {
        const delta = prevAvg?.avg !== undefined ? Math.round(comp.avg) - Math.round(prevAvg.avg) : null;
        partes.push(comp.avg >= 75
            ? (tono === 'infantil' ? `Se comprometió mucho en cada práctica${delta && delta > 0 ? ' y mejoró frente al mes pasado' : ''}.` : `Compromiso en el entreno alto (${Math.round(comp.avg)}/100)${delta ? `, ${delta > 0 ? '+' : ''}${delta} frente al mes anterior` : ''}.`)
            : (tono === 'infantil' ? 'Vamos a seguir animándolo a dar su mejor esfuerzo en cada práctica.' : `Compromiso en el entreno medio (${Math.round(comp.avg)}/100): hay espacio para subirlo.`));
    }
    const comentario = partes.length ? { texto: partes.join(' '), autor: null, esBorrador: true } : null;

    const meta = pct === null ? null
        : pct < 90 ? `Llegar al 90 % de asistencia: ${tono === 'infantil' ? 'cada entreno suma.' : `faltan ${Math.max(1, Math.ceil(total * 0.9) - present)} entrenos para lograrlo.`}`
        : 'Mantener la asistencia por encima del 90 % y seguir con ese compromiso.';

    const doc = new PDFDocument({ size: 'A4', margin: 60, bufferPages: true });
    doc.pipe(createWriteStream(salida));
    renderAthleteReportV2(doc, {
        snapshot, tono, marca: { primaryColor: logoPath === 'db' ? color : '#1D6FB8', secondaryColor: logoPath === 'db' ? sec : '#0F172A', showWatermark: true, headerBg: await fondoDelLogo(logoPath === 'db' ? (esc as any)?.logo_url : logoPath), clubName: logoPath === 'db' ? ((esc as any)?.name ?? '') : 'Carmel Club Campestre' },
        logo: logoPath === 'db' ? await logoDeUrl((esc as any)?.logo_url) : await logoTransparente(logoPath),
        compromisoAnterior: prevAvg?.avg ?? null, comentario, enfoqueDelMes: enfoque, metaProximoMes: meta,
    });
    doc.end();
    console.log(`PDF (${tono}${enfoque ? ', con enfoque del mesociclo' : ', sin mesociclo vigente'}):`, salida);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
