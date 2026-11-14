/**
 * Arma lo que necesita `renderAthleteReportV2` a partir de un informe real: marca de la escuela, logo para la banda,
 * tono por categoría, mes anterior, enfoque del mesociclo y meta. Se usa solo cuando `school_settings.report_pdf_version = 'v2'`.
 *
 * El comentario sale ÚNICAMENTE de la nota que escribió el entrenador (`snapshot.coach_note`): un informe que llega a
 * una familia nunca lleva un borrador automático.
 */
import sharp from 'sharp';
import { supabase } from '../config/supabase';
import { buildReportSnapshot, type ReportSnapshot } from '../services/report-snapshot.service';
import { fetchSchoolLogo, loadSportmapsLogo } from './reportPdfHelpers';
import { resolveSchoolBranding } from './schoolBrandingResolver';
import type { InformeV2Opciones, TonoInforme } from './athleteReportPdfV2';

const HEX = /^#[0-9A-Fa-f]{6}$/;
const hex = (v: unknown, d: string) => (typeof v === 'string' && HEX.test(v) ? v : d);

/** Categorías con año de nacimiento <= 2012 (14+) o juveniles/mayores van técnicas; el resto, infantil. */
export function tonoPorCategoria(nombre: string | null | undefined): TonoInforme {
    const anio = Number(/(\d{4})/.exec(nombre ?? '')?.[1] ?? 0);
    return (anio && anio <= 2012) || /juvenil|mayores|senior|adult|sub-?1[5-9]/i.test(nombre ?? '') ? 'tecnico' : 'infantil';
}

/**
 * Logo para la banda: un JPG de fondo CLARO se vuelve transparente sobre banda blanca; un JPG de fondo oscuro (Besser)
 * se deja tal cual y la banda toma ese color, igual que el estado de cuenta. PNG con alfa: banda blanca.
 */
export async function logoParaBanda(buf: Buffer | null): Promise<{ logo: Buffer | null; headerBg: string }> {
    if (!buf) return { logo: null, headerBg: '#ffffff' };
    try {
        const meta = await sharp(buf).metadata();
        if (meta.hasAlpha) return { logo: await sharp(buf).png().toBuffer(), headerBg: '#ffffff' };
        const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const [r, g, b] = [data[0], data[1], data[2]]; // esquina superior izquierda = fondo del logo
        if (Math.min(r, g, b) >= 238) {
            for (let i = 0; i < data.length; i += 4) {
                const claridad = Math.min(data[i], data[i + 1], data[i + 2]);
                data[i + 3] = claridad >= 238 ? 0 : claridad <= 195 ? 255 : Math.round(((238 - claridad) / 43) * 255);
            }
            return { logo: await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer(), headerBg: '#ffffff' };
        }
        return { logo: await sharp(buf).png().toBuffer(), headerBg: '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('') };
    } catch {
        return { logo: null, headerBg: '#ffffff' };
    }
}

/** Marca efectiva para el V2: se le muestra su marca si tiene tier con branding O el addon pwa_branding. */
export async function marcaParaV2(schoolId: string) {
    const base = await resolveSchoolBranding(schoolId);
    const [{ data: esc }, { data: muestra }] = await Promise.all([
        supabase.from('schools').select('name, logo_url, branding_settings').eq('id', schoolId).maybeSingle(),
        supabase.rpc('school_shows_own_brand', { p_school_id: schoolId }),
    ]);
    if (!base.hasWhitelabel && muestra !== true) {
        const { logo, headerBg } = await logoParaBanda(loadSportmapsLogo());
        return { clubName: base.schoolName, primaryColor: base.primaryColor, secondaryColor: base.secondaryColor, showWatermark: true, logo, headerBg };
    }
    const st = ((esc as any)?.branding_settings ?? {}) as Record<string, unknown>;
    const { logo, headerBg } = await logoParaBanda(await fetchSchoolLogo((esc as any)?.logo_url ?? null));
    return {
        clubName: String((esc as any)?.name ?? base.schoolName),
        primaryColor: hex(st.primary_color, base.primaryColor),
        secondaryColor: hex(st.secondary_color, base.secondaryColor),
        // El watermark solo lo apaga la marca blanca (addon whitelabel), nunca por tier ni por pwa_branding.
        showWatermark: base.hasWhitelabel ? st.show_sportmaps_watermark !== false : true,
        logo, headerBg,
    };
}

export async function opcionesV2(snapshot: ReportSnapshot, report: { school_id: string; subject_type: any; subject_id: string }): Promise<InformeV2Opciones> {
    const m = await marcaParaV2(report.school_id);
    const { year, month } = snapshot.period;
    const ant = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
    const teamId = snapshot.governing_team?.id ?? null;

    const anterior = await buildReportSnapshot({
        schoolId: report.school_id, subjectType: report.subject_type, subjectId: report.subject_id,
        governingTeamId: teamId, coachNote: null, ...ant,
    }).catch(() => null);
    const prev = anterior?.metrics_session.find((x) => x.metric_key === 'coach_effort_rating')?.avg ?? null;

    let enfoque: string | null = null;
    if (teamId) {
        const desde = `${year}-${String(month).padStart(2, '0')}-01`;
        const hasta = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
        const { data } = await supabase.from('training_mesocycles').select('general_objective')
            .eq('team_id', teamId).lte('starts_on', hasta).gte('ends_on', desde).order('starts_on', { ascending: false }).limit(1);
        enfoque = ((data?.[0] as any)?.general_objective as string | undefined)?.trim() || null;
    }

    const tono = tonoPorCategoria(snapshot.governing_team?.name);
    const { pct, total, present } = snapshot.attendance;
    const meta = pct === null ? null
        : pct < 90 ? `Llegar al 90 % de asistencia: ${tono === 'infantil' ? 'cada entreno suma.' : `faltan ${Math.max(1, Math.ceil(total * 0.9) - present)} entrenos para lograrlo.`}`
        : 'Mantener la asistencia por encima del 90 % y seguir con ese compromiso.';

    return {
        snapshot, tono,
        marca: { primaryColor: m.primaryColor, secondaryColor: m.secondaryColor, showWatermark: m.showWatermark, headerBg: m.headerBg, clubName: m.clubName },
        logo: m.logo, compromisoAnterior: prev,
        comentario: snapshot.coach_note ? { texto: snapshot.coach_note, autor: null, esBorrador: false } : null,
        enfoqueDelMes: enfoque, metaProximoMes: meta,
    };
}
