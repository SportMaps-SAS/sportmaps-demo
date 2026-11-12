/**
 * Informe Mensual del Atleta, versión 2: une lo mejor del diseño nuevo (comentario del entrenador, indicadores claros,
 * calendario por asistencia, enfoque y meta) con lo que ya tenía el informe completo (radar «panorama completo»,
 * fortalezas, en qué trabajar, métricas por categoría, autoevaluación después del entreno).
 *
 * Dos tonos: 'infantil' (palabras y semáforo; casi sin números) y 'tecnico' (categorías mayores: cifras y variación).
 * REGLA: lo que no hay como dato NO se dibuja, y nunca se imputa. Por eso el informe de Carmel (1 métrica) sale corto
 * y el de Besser (17 métricas) sale completo con el mismo código.
 *
 * Sin I/O: recibe el snapshot ya calculado. Todavía NO está conectado a la ruta /athlete-reports/:id/pdf.
 * Requiere un doc con margin 60 y bufferPages (como el informe actual): los helpers compartidos asumen ese margen.
 */
import type { ReportSnapshot, SnapshotMetric } from '../services/report-snapshot.service';
import { INK, MUTED, HAIRLINE, capitalize, fmt, addFooterToAllPages } from './reportPdfHelpers';
import { drawRadarChart } from './radarPdf';
import { groupSessionMetrics, drawSessionMetric } from './sessionMetricsPdf';

export type TonoInforme = 'infantil' | 'tecnico';

export interface InformeV2Opciones {
    snapshot: ReportSnapshot;
    tono: TonoInforme;
    marca: {
        primaryColor: string;
        /** Color secundario de la marca: subtítulo de la banda y filete (como el estado de cuenta). */
        secondaryColor: string;
        showWatermark: boolean;
        /** Fondo de la banda del encabezado = el fondo del logo (negro en Besser). '#ffffff' si el logo es transparente. */
        headerBg: string;
        /** Nombre del club en la banda. */
        clubName: string;
    };
    /** Logo de la escuela (idealmente PNG transparente). */
    logo: Buffer | null;
    /** Promedio de «compromiso en el entreno» del mes anterior; null si no hay. */
    compromisoAnterior: number | null;
    /** Comentario ya redactado (borrador de Mapi o del entrenador). null = no se dibuja el bloque. */
    comentario: { texto: string; autor: string | null; esBorrador: boolean } | null;
    enfoqueDelMes: string | null;
    metaProximoMes: string | null;
}

const VERDE = '#16a34a', ROJO = '#dc2626', GRIS = '#9ca3af', AMARILLO = '#d97706';
const M = 60, PAGE_H = 842, LIMITE = PAGE_H - 70;
const BAND: Record<string, string> = { green: VERDE, yellow: AMARILLO, red: ROJO };
const BAND_PALABRA: Record<string, string> = { green: 'Va muy bien', yellow: 'Va bien', red: 'A trabajar' };
const CATEGORIA: Record<string, string> = { physical: 'Físico', technical: 'Técnico', tactical: 'Táctico', other: 'Otras mediciones' };

/** «Categoria 2018-19» → «Categoría 2018-19». */
const categoria = (n: string) => n.replace(/^Categoria\b/i, 'Categoría');

/** Métricas que ya cubren las cajas de fútbol o la asistencia: repetirlas en las listas es lo que contradecía (Goles 2 vs 0). */
const REDUNDANTE = /\b(gol(es)?|minutos?|partidos?|amarillas?|rojas?|tarjetas?)\b|^asist(encia|\.)/i;

function nivel(v: number): { palabra: string; color: string } {
    if (v >= 75) return { palabra: 'Alto', color: VERDE };
    if (v >= 50) return { palabra: 'Medio', color: AMARILLO };
    return { palabra: 'En proceso', color: ROJO };
}

function recortar(t: string, max: number): string {
    const primera = t.split(/(?<=[.!?])\s/)[0];
    return primera.length <= max ? primera : t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/** Mayor racha de días seguidos con asistencia. */
export function mejorRacha(cal: ReportSnapshot['calendar']): number {
    let best = 0, cur = 0;
    for (const d of cal) {
        if (!d.has_session) continue;
        if (d.attended === true) { cur++; best = Math.max(best, cur); } else cur = 0;
    }
    return best;
}

/** Triángulo de variación: sube verde, baja ámbar. Helvetica no trae ↑/↓. Devuelve el ancho usado. */
function flecha(doc: PDFKit.PDFDocument, x: number, y: number, delta: number, texto: string, size = 10): number {
    const up = delta > 0, col = up ? VERDE : AMARILLO;
    doc.polygon(up ? [x, y + 8] : [x, y], up ? [x + 10, y + 8] : [x + 10, y], up ? [x + 5, y] : [x + 5, y + 8]).fill(col);
    doc.fillColor(col).font('Helvetica-Bold').fontSize(size).text(texto, x + 13, y - 1, { lineBreak: false });
    return 13 + doc.widthOfString(texto);
}

export function renderAthleteReportV2(doc: PDFKit.PDFDocument, o: InformeV2Opciones) {
    const s = o.snapshot, c = o.marca.primaryColor, inf = o.tono === 'infantil';
    const W = doc.page.width, CW = W - M * 2;
    const nombre = s.athlete.name, primer = nombre.split(' ')[0];
    const mes = capitalize(s.period.label);
    const compromiso = s.metrics_session.find((m) => m.metric_key === 'coach_effort_rating');
    let y = 40;

    /** Si el bloque no cabe, página nueva. */
    const ensure = (h: number) => { if (y + h > LIMITE) { doc.addPage(); y = 40; } };
    const titulo = (t: string, color = INK) => {
        ensure(40);
        doc.fillColor(color).font('Helvetica-Bold').fontSize(12).text(t, M, y, { width: CW, lineBreak: false });
        y += 20;
    };

    // ── Encabezado: banda a todo el ancho como el estado de cuenta (logo + club + tipo de documento) y doble filete ──
    const bandH = 92;
    const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
    const oscuro = lum(o.marca.headerBg) < 0.5;
    doc.rect(0, 0, W, bandH).fill(o.marca.headerBg);
    doc.rect(0, bandH, W, 7).fill(c);
    doc.rect(0, bandH + 7, W, 3).fill(o.marca.secondaryColor);
    let tx = 44;
    if (o.logo) { doc.image(o.logo, 44, 14, { fit: [120, 64] }); tx = 44 + 120 + 18; }
    const tw = W - tx - 44;
    doc.fillColor(oscuro ? '#ffffff' : '#111111').font('Helvetica-Bold').fontSize(18)
        .text(o.marca.clubName.toUpperCase(), tx, 24, { width: tw, lineBreak: false });
    doc.fillColor(o.marca.secondaryColor).font('Helvetica-Bold').fontSize(12)
        .text('INFORME MENSUAL', tx, 48, { width: tw, characterSpacing: 2, lineBreak: false });
    doc.fillColor(oscuro ? '#ffffff' : '#374151').font('Helvetica').fontSize(9.5)
        .text(`${mes}${s.governing_team ? ' · ' + categoria(s.governing_team.name) : ''}`, tx, 66, { width: tw, lineBreak: false });
    y = bandH + 10 + 22;

    // ── Nombre y frase de apertura ──
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text(nombre, M, y, { width: CW });
    y = doc.y + 2;
    const pct = s.attendance.pct;
    const apertura = inf
        ? (pct !== null && pct >= 90 ? `¡${primer} tuvo un mes para aplaudir! Así le fue en ${mes.toLowerCase()}.`
            : `Cada entreno cuenta. Así va ${primer} en ${mes.toLowerCase()}.`)
        : `Resumen del desempeño de ${primer} en ${mes.toLowerCase()}.`;
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(10.5).text(apertura, M, y, { width: CW });
    y = doc.y + 12;

    // ── Comentario del entrenador (lo más importante) ──
    if (o.comentario) {
        const padX = 14, padY = 10;
        const th = doc.font('Helvetica').fontSize(10.5).heightOfString(o.comentario.texto, { width: CW - padX * 2 });
        const h = padY * 2 + 14 + th + (o.comentario.esBorrador ? 12 : 0);
        ensure(h);
        doc.roundedRect(M, y, CW, h, 8).fillAndStroke('#f7f9fb', c);
        doc.fillColor(c).font('Helvetica-Bold').fontSize(9)
            .text(('Comentario de ' + (o.comentario.autor ?? 'tu entrenador')).toUpperCase(), M + padX, y + padY, { characterSpacing: 0.4, lineBreak: false });
        doc.fillColor(INK).font('Helvetica').fontSize(10.5)
            .text(o.comentario.texto, M + padX, y + padY + 15, { width: CW - padX * 2 });
        if (o.comentario.esBorrador) {
            doc.fillColor(AMARILLO).font('Helvetica-Oblique').fontSize(7.5)
                .text('Borrador pendiente de aprobación del entrenador', M + padX, y + h - padY - 6, { lineBreak: false });
        }
        y += h + 14;
    }

    // ── Indicadores: asistencia, compromiso, entrenos ──
    const gap = 10, bh = 78;
    const cajas: { titulo: string; valor: string; detalle: string; color: string; delta: number | null }[] = [];
    cajas.push({
        titulo: 'Asistencia',
        valor: pct !== null ? `${pct} %` : '—',
        detalle: s.attendance.total > 0 ? `Asistió a ${s.attendance.present} de ${s.attendance.total} entrenos` : 'Sin entrenos registrados',
        color: pct === null ? GRIS : pct >= 80 ? VERDE : pct >= 60 ? AMARILLO : ROJO, delta: null,
    });
    if (compromiso?.avg !== undefined) {
        const v = compromiso.avg, n = nivel(v);
        cajas.push({
            titulo: inf ? 'Compromiso en el entreno' : 'Evaluación del entrenador',
            valor: inf ? n.palabra : `${Math.round(v)}/100`,
            detalle: inf ? `${Math.round(v)}/100 · ${compromiso.n} entrenos evaluados` : `${compromiso.n} entrenos evaluados`,
            color: n.color,
            delta: o.compromisoAnterior !== null ? Math.round(v) - Math.round(o.compromisoAnterior) : null,
        });
    }
    if (s.attendance.total > 0) {
        cajas.push({ titulo: 'Entrenos del mes', valor: String(s.attendance.total), detalle: `Mejor racha: ${mejorRacha(s.calendar)} días seguidos`, color: c, delta: null });
    }
    ensure(bh + 16);
    const bw = (CW - gap * (cajas.length - 1)) / cajas.length;
    cajas.forEach((b, i) => {
        const x = M + i * (bw + gap);
        doc.roundedRect(x, y, bw, bh, 8).lineWidth(1).strokeColor(HAIRLINE).stroke();
        doc.rect(x, y + 10, 3, bh - 20).fill(b.color);
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text(b.titulo.toUpperCase(), x + 12, y + 10, { width: bw - 16, characterSpacing: 0.2, lineBreak: false });
        doc.fillColor(b.color).font('Helvetica-Bold').fontSize(20).text(b.valor, x + 12, y + 25, { lineBreak: false });
        if (b.delta !== null && b.delta !== 0) flecha(doc, x + bw - 52, y + 31, b.delta, `${b.delta > 0 ? '+' : ''}${b.delta}`);
        doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(b.detalle, x + 12, y + 54, { width: bw - 16 });
    });
    y += bh + 12;

    // ── Fútbol: solo las cifras que existen (nunca una fila de ceros) ──
    const fb = s.football;
    if (fb) {
        const stats: [string, number][] = ([
            ['Partidos', fb.matches_played], ['Minutos', fb.minutes_played], ['Goles', fb.goals],
            ['Asistencias', fb.assists], ['Amarillas', fb.yellow_cards], ['Rojas', fb.red_cards],
        ] as [string, number][]).filter(([, v]) => v > 0);
        if (stats.length) {
            ensure(40);
            const sw = CW / stats.length;
            stats.forEach(([l, v], i) => {
                const x = M + i * sw;
                doc.fillColor(c).font('Helvetica-Bold').fontSize(15).text(String(v), x, y, { width: sw, align: 'center', lineBreak: false });
                doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(l.toUpperCase(), x, y + 19, { width: sw, align: 'center', lineBreak: false });
            });
            y += 40;
        }
    }
    y += 6;

    // ── Panorama completo (radar) — solo con 3+ métricas ──
    const radar = s.radar ?? [];
    if (radar.length >= 3) {
        ensure(200);
        titulo('Panorama completo');
        const r = 74, cx = M + r + 12, cy = y + r + 4;
        doc.y = y;
        drawRadarChart(doc, radar as any, cx, cy, r, c);
        const destacadas = radar.filter((m) => m.band === 'green').slice(0, 6);
        const lx = cx + r + 34, lw = W - M - lx;
        let ly = y + 4;
        doc.fillColor(VERDE).font('Helvetica-Bold').fontSize(9).text('LO QUE MÁS DESTACA', lx, ly, { width: lw, characterSpacing: 0.3, lineBreak: false });
        ly += 16;
        if (destacadas.length === 0) {
            doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9.5).text('Todavía nada en verde: vamos paso a paso.', lx, ly, { width: lw });
        } else {
            for (const m of destacadas) {
                doc.fillColor(INK).font('Helvetica').fontSize(10).text(inf ? m.label : `${m.label}: ${fmt(m.value, m.unit)}`, lx, ly, { width: lw, lineBreak: false });
                ly += 15;
            }
        }
        doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`${radar.length} habilidades medidas en total`, lx, Math.max(ly + 6, y + r * 2 - 8), { width: lw, lineBreak: false });
        y += r * 2 + 22;
    }

    // ── Fortalezas / A mejorar / otras mediciones ──
    const util = (m: SnapshotMetric) => !REDUNDANTE.test(m.label);
    const fuertes = (s.highlights ?? []).filter(util);
    const aMejorar = (s.to_work_on ?? []).filter(util);
    const usadas = new Set([...fuertes, ...aMejorar].map((m) => m.metric_key));
    const otras = (s.metrics ?? []).filter((m) => util(m) && !usadas.has(m.metric_key));

    const linea = (m: SnapshotMetric, x: number, w: number) => {
        const col = m.band ? BAND[m.band] : GRIS;
        doc.circle(x + 4, y + 6, 3.5).fill(col);
        doc.fillColor(INK).font('Helvetica').fontSize(10)
            .text(inf && m.band ? `${m.label} · ${BAND_PALABRA[m.band]}` : `${m.label}: ${fmt(m.value, m.unit)}`, x + 14, y, { width: w - 14 - (m.delta ? 42 : 0), lineBreak: false });
        // Variación solo si hubo cambio: «(0)» no le dice nada a un padre.
        if (m.delta !== null && m.delta !== undefined && m.delta !== 0) {
            flecha(doc, x + w - 40, y + 1.5, m.delta, `${m.delta > 0 ? '+' : ''}${fmt(m.delta, null)}`, 9);
        }
        y += 18;
    };
    const lista = (t: string, color: string, ms: SnapshotMetric[]) => {
        if (!ms.length) return;
        ensure(30 + ms.length * 18);
        titulo(t, color);
        for (const m of ms) linea(m, M, CW);
        y += 8;
    };
    lista(inf ? `En qué brilla ${primer}` : 'Fortalezas del mes', VERDE, fuertes);
    lista(inf ? `En qué vamos a trabajar` : 'En qué trabajar', '#b45309', aMejorar);
    for (const cat of ['physical', 'technical', 'tactical', 'other']) {
        const rows = otras.filter((m) => (CATEGORIA[m.category ?? 'other'] ? (m.category ?? 'other') : 'other') === cat);
        if (rows.length) lista(CATEGORIA[cat], INK, rows);
    }

    // ── Calendario (izquierda) + enfoque y meta (derecha) ──
    const calW = 300, colX = M + calW + 24, colW = W - M - colX;
    const cell = calW / 7, ch = 24;
    const filas = Math.ceil(((new Date(Date.UTC(s.period.year, s.period.month - 1, 1)).getUTCDay() + 6) % 7 + s.calendar.length) / 7);
    ensure(40 + filas * (ch + 2) + 30);
    titulo(`${mes}, día a día`);
    const top = y - 4;
    ['L', 'M', 'M', 'J', 'V', 'S', 'D'].forEach((d, i) => {
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text(d, M + i * cell, top, { width: cell, align: 'center', lineBreak: false });
    });
    let col = (new Date(Date.UTC(s.period.year, s.period.month - 1, 1)).getUTCDay() + 6) % 7;
    let ry = top + 14;
    for (const d of s.calendar) {
        const x = M + col * cell;
        if (d.has_session) {
            const fill = d.attended === true ? VERDE : d.attended === false ? ROJO : '#e5e7eb';
            doc.roundedRect(x + 2, ry + 1, cell - 4, ch - 2, 4).fill(fill);
            if (d.is_match) doc.roundedRect(x + 2, ry + 1, cell - 4, ch - 2, 4).lineWidth(2).strokeColor('#0F172A').stroke();
            doc.fillColor(d.attended === null ? INK : '#ffffff').font('Helvetica-Bold').fontSize(8.5)
                .text(String(d.day), x + 2, ry + 8, { width: cell - 4, align: 'center', lineBreak: false });
        }
        col++;
        if (col > 6) { col = 0; ry += ch + 2; }
    }
    const calEnd = ry + (col > 0 ? ch + 2 : 0) + 6;
    const leyenda: [string, string][] = [['Asistió', VERDE], ['No asistió', ROJO], ['Sin registro', '#e5e7eb']];
    if (s.calendar.some((d) => d.is_match)) leyenda.push(['Partido', '#0F172A']);
    let lx = M;
    for (const [t, f] of leyenda) {
        doc.roundedRect(lx, calEnd + 1, 9, 9, 2).fill(f);
        doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(t, lx + 13, calEnd + 1.5, { lineBreak: false });
        lx += 13 + doc.widthOfString(t) + 12;
    }
    let ry2 = top;
    const bloque = (t: string, texto: string) => {
        doc.fillColor(c).font('Helvetica-Bold').fontSize(9).text(t.toUpperCase(), colX, ry2, { width: colW, characterSpacing: 0.4, lineBreak: false });
        const h = doc.fillColor(INK).font('Helvetica').fontSize(10.5).heightOfString(texto, { width: colW });
        doc.text(texto, colX, ry2 + 14, { width: colW });
        ry2 += 14 + h + 14;
    };
    if (o.enfoqueDelMes) bloque('Enfoque del mes', recortar(o.enfoqueDelMes, 150));
    if (o.metaProximoMes) bloque('Meta para el próximo mes', o.metaProximoMes);
    y = Math.max(calEnd + 22, ry2);

    // ── Después de cada entreno (autoevaluación): solo si hay datos distintos al compromiso ──
    const grupos = groupSessionMetrics(s.metrics_session ?? []).filter((g) => g.section.key !== 'coach_effort_rating');
    if (grupos.length) {
        ensure(120);
        titulo(inf ? 'Cómo se siente después de entrenar' : 'Después de cada entreno');
        doc.y = y;
        for (const { section, metrics } of grupos) {
            if (doc.y > LIMITE - 90) doc.addPage();
            doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text(section.title.toUpperCase(), M, doc.y, { characterSpacing: 0.3 });
            doc.moveDown(0.3);
            if (section.key === 'focus') {
                // Compacto: las 3 más elegidas, en una línea cada una (el detalle por barra ocupaba media página).
                const top3 = [...metrics].filter((m) => (m.count ?? 0) > 0).sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 3);
                for (const m of top3) {
                    doc.fillColor(INK).font('Helvetica').fontSize(10).text(`${m.label} · ${m.count} de ${m.n} entrenos`, M + 10, doc.y, { width: CW - 10 });
                }
            } else {
                for (const m of metrics) drawSessionMetric(doc, m, c);
            }
            doc.moveDown(0.3);
        }
        y = doc.y;
    }

    addFooterToAllPages(doc, o.marca.showWatermark);
}
