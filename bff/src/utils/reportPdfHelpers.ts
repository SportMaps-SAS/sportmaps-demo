/**
 * Helpers compartidos de dibujo PDFKit para los informes de SportMaps
 * (informe mensual del atleta y, desde F4 segunda mitad, el informe grupal
 * de equipo — spec evaluacion-post-entrenamiento.md §3.5/§5.3).
 *
 * Extraído de `athlete-reports-pdf.ts` (que fue el primero en construirse)
 * para no duplicar el mismo dibujo de sección/nota/footer/logo en
 * `team-reports-pdf.ts`. Nada acá conoce la forma de `ReportSnapshot` ni de
 * `TeamReportSnapshot` — son solo primitivas de dibujo + branding.
 */
import fs from 'fs';
import path from 'path';

export const INK = '#1f2937';
export const MUTED = '#6b7280';
export const HAIRLINE = '#e5e7eb';

// Mismo patrón de cache-por-proceso que saasInvoicePdf.service.ts — el logo
// de SportMaps no cambia en caliente, y si el asset no copió en el build, el
// PDF sigue generándose sin logo en vez de tumbarse.
let cachedSportmapsLogo: Buffer | null | undefined;
export function loadSportmapsLogo(): Buffer | null {
    if (cachedSportmapsLogo !== undefined) return cachedSportmapsLogo;
    try {
        cachedSportmapsLogo = fs.readFileSync(path.join(__dirname, '../assets/sportmaps-logo.png'));
    } catch {
        cachedSportmapsLogo = null;
    }
    return cachedSportmapsLogo;
}

/** Logo propio de la escuela (solo si tiene whitelabel) — se descarga por
 *  request porque a diferencia del de SportMaps no es un asset local, y con
 *  timeout corto para que una URL caída no cuelgue la descarga del informe. */
export async function fetchSchoolLogo(url: string | null): Promise<Buffer | null> {
    if (!url) return null;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
    } catch {
        return null;
    }
}

export function fmt(value: number, unit?: string | null): string {
    const n = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return unit ? `${n} ${unit}` : n;
}

export function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Logo + nombre de la escuela + subtítulo, apilados. Antes cuando había logo
 * el nombre NUNCA se dibujaba (rama `else` descartada) y el logo salía a
 * 34pt de alto -- se veía "escondido, pequeño" (feedback real del usuario
 * viendo el PDF). Ahora el logo crece y el nombre SIEMPRE se dibuja debajo,
 * en grande. Devuelve el `y` donde debe empezar la línea de acento.
 */
export function drawBrandHeader(
    doc: PDFKit.PDFDocument,
    logo: Buffer | null,
    schoolName: string,
    subtitle: string,
): number {
    let y = 48;
    if (logo) {
        try {
            doc.image(logo, 60, y, { height: 46 });
            y += 46 + 10;
        } catch {
            // sigue con el nombre en texto, como si no hubiera logo
        }
    }
    doc.fillColor(INK).fontSize(17).font('Helvetica-Bold')
        .text(schoolName, 60, y, { width: doc.page.width - 220 });
    y += 22;
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
        .text(subtitle, 60, y, { width: doc.page.width - 220 });
    doc.fillColor(INK);
    return y + 24;
}

export function sectionTitle(doc: PDFKit.PDFDocument, text: string, color: string) {
    // x/width explícitos SIEMPRE: `.text(text)` sin opciones hereda el
    // width/align de la ÚLTIMA llamada con opciones que haya corrido antes
    // (p.ej. las cajas de KPI, angostas y centradas) -- sin esto el título
    // se parte en 2-3 líneas angostas en el margen derecho. Bug real, visto
    // renderizando el PDF.
    doc.fillColor(color).font('Helvetica-Bold').fontSize(11)
        .text(text, 60, doc.y, { width: doc.page.width - 120, align: 'left' });
    doc.moveDown(0.3);
    doc.fillColor(INK);
}

export function noteBox(doc: PDFKit.PDFDocument, title: string, body: string, accent: string) {
    const startY = doc.y;
    doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold')
        .text(title.toUpperCase(), 68, startY, { characterSpacing: 0.4 });
    doc.moveDown(0.25);
    doc.fillColor(INK).font('Helvetica').fontSize(10).text(body, 68, doc.y, {
        width: doc.page.width - 128, align: 'justify', lineGap: 2,
    });
    // Barra de acento a la izquierda del bloque completo (título + cuerpo).
    doc.rect(60, startY, 2.5, doc.y - startY).fill(accent);
    doc.fillColor(INK);
    doc.moveDown(0.6);
}

/** "Powered by SportMaps" — mismo criterio de showWatermark que ya rige
 *  correos y PWA: forzado en free tier, opcional recién con la app nativa de
 *  marca blanca (BrandingSettingsForm.tsx). Solo texto: `sportmaps-logo.png`
 *  trae el wordmark completo integrado a la imagen (mismo comentario que
 *  saasInvoicePdf.service.ts), y a la escala de un footer (~12px) el wordmark
 *  se ve ilegible y se pisa con el texto -- probado en QA visual, se sacó. */
export function addFooter(doc: PDFKit.PDFDocument, showWatermark: boolean) {
    // El footer vive DENTRO del margen inferior (60pt) a propósito. Sin bajar
    // el margen a 0 acá, cualquier .text() por debajo de `page.height - 60`
    // dispara la paginación automática de pdfkit y crea una página fantasma
    // -- el mismo bug que bufferPages+switchToPage por sí solos no evitan.
    const originalBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    try {
        const y = doc.page.height - 42;
        doc.moveTo(60, y - 10).lineTo(doc.page.width - 60, y - 10).strokeColor(HAIRLINE).lineWidth(0.75).stroke();
        if (!showWatermark) return;
        const label = 'Powered by SportMaps';
        doc.fillColor('#9ca3af').fontSize(7.5).font('Helvetica');
        const textWidth = doc.widthOfString(label);
        doc.text(label, doc.page.width / 2 - textWidth / 2, y);
    } finally {
        doc.page.margins.bottom = originalBottom;
    }
}

/** Dibuja el footer en TODAS las páginas ya creadas del documento. Llamar
 *  después de terminar de escribir el contenido (range() es estable recién
 *  ahí) y antes de `doc.end()`. */
export function addFooterToAllPages(doc: PDFKit.PDFDocument, showWatermark: boolean) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        addFooter(doc, showWatermark);
    }
}

/**
 * Barra horizontal de distribución (opción · % · n) — el gráfico simplificado
 * en papel de una `distribution`/`count` de `SessionMetricSummary` (spec
 * evaluacion-post-entrenamiento.md §3.4). No conoce esos tipos: recibe una
 * lista plana de { label, pct, n } ya resuelta por el caller.
 */
export function drawDistributionBar(
    doc: PDFKit.PDFDocument,
    label: string,
    pct: number,
    n: number,
    accent: string,
    opts: { labelWidth?: number } = {},
) {
    const labelWidth = opts.labelWidth ?? 180;
    const barX = 60 + labelWidth + 8;
    const barMaxWidth = doc.page.width - 60 - barX - 70;
    const y = doc.y;
    const barH = 10;

    doc.fillColor(INK).font('Helvetica').fontSize(9)
        .text(label, 60, y + 1, { width: labelWidth, ellipsis: true });

    doc.roundedRect(barX, y, barMaxWidth, barH, 2).fillColor('#f3f4f6').fill();
    const filled = Math.max(0, Math.min(100, pct)) / 100 * barMaxWidth;
    if (filled > 0.5) {
        doc.roundedRect(barX, y, filled, barH, 2).fillColor(accent).fill();
    }

    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
        .text(`${pct}% (${n})`, barX + barMaxWidth + 6, y + 1, { width: 60, align: 'right' });

    doc.fillColor(INK);
    doc.y = y + barH + 6;
}
