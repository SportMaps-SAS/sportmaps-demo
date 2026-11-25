/**
 * Constancias — armado del texto y del PDF.
 *
 * Funciones puras (variables, fechas, render) separadas de la ruta para poder
 * probarlas sin Supabase. La ruta (`routes/certificates.ts`) carga los datos,
 * resuelve el branding y sube el PDF.
 */
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import sharp from 'sharp';

// ─────────────────────────────────────────────────────────────────────────────
// Fechas en español, sin corrimiento de zona horaria
// ─────────────────────────────────────────────────────────────────────────────

const MESES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** Partes de una fecha en Bogotá. Un 'YYYY-MM-DD' se toma tal cual (es una
 *  fecha de calendario, no un instante: con new Date() se corría un día). */
function partesFecha(value: unknown): { y: number; m: number; d: number } | null {
    if (value == null || value === '') return null;
    if (typeof value === 'string') {
        const solo = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
        if (solo) return { y: +solo[1], m: +solo[2], d: +solo[3] };
    }
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return null;
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const get = (t: string) => Number(fmt.find((p) => p.type === t)?.value);
    return { y: get('year'), m: get('month'), d: get('day') };
}

/** «31 de diciembre de 2026». Vacío si no hay fecha. */
export function fechaLarga(value: unknown): string {
    const p = partesFecha(value);
    if (!p || p.m < 1 || p.m > 12) return '';
    return `${p.d} de ${MESES[p.m - 1]} de ${p.y}`;
}

/** Edad cumplida en años a una fecha de referencia. */
export function edadEn(nacimiento: unknown, referencia: unknown): string {
    const n = partesFecha(nacimiento);
    const r = partesFecha(referencia);
    if (!n || !r) return '';
    let edad = r.y - n.y;
    if (r.m < n.m || (r.m === n.m && r.d < n.d)) edad--;
    return edad >= 0 && edad < 120 ? String(edad) : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Variables
// ─────────────────────────────────────────────────────────────────────────────

/** Catálogo de variables. La pantalla de plantillas muestra la misma lista. */
export const VARIABLES_CONSTANCIA: Array<{ clave: string; etiqueta: string; ejemplo: string }> = [
    { clave: 'atleta.nombre', etiqueta: 'Nombre del deportista', ejemplo: 'Sofía Herrera Gómez' },
    { clave: 'atleta.tipo_doc', etiqueta: 'Tipo de documento', ejemplo: 'TI' },
    { clave: 'atleta.documento', etiqueta: 'Número de documento', ejemplo: '1.023.456.789' },
    { clave: 'atleta.fecha_nac', etiqueta: 'Fecha de nacimiento', ejemplo: '9 de abril de 2017' },
    { clave: 'atleta.edad', etiqueta: 'Edad (años)', ejemplo: '9' },
    { clave: 'atleta.genero', etiqueta: 'Género', ejemplo: 'femenino' },
    { clave: 'atleta.inscrito', etiqueta: '«inscrito» o «inscrita»', ejemplo: 'inscrita' },
    { clave: 'atleta.activo', etiqueta: '«activo» o «activa»', ejemplo: 'activa' },
    { clave: 'atleta.identificacion', etiqueta: 'Documento de identidad', ejemplo: 'identificada con TI 1.023.456.789' },
    { clave: 'equipo', etiqueta: 'Equipo o categoría', ejemplo: 'Natación — Infantil' },
    { clave: 'sede', etiqueta: 'Sede', ejemplo: 'Sede Norte' },
    { clave: 'inscripcion.inicio', etiqueta: 'Fecha de inscripción', ejemplo: '1 de mayo de 2026' },
    { clave: 'inscripcion.vence', etiqueta: 'Vigencia de la inscripción', ejemplo: '8 de diciembre de 2026' },
    { clave: 'escuela.nombre', etiqueta: 'Nombre de la escuela', ejemplo: 'Club Deportivo Ejemplo' },
    { clave: 'escuela.ciudad', etiqueta: 'Ciudad de la escuela', ejemplo: 'Bogotá' },
    { clave: 'escuela.direccion', etiqueta: 'Dirección de la escuela', ejemplo: 'Calle 100 # 15-20' },
    { clave: 'escuela.telefono', etiqueta: 'Teléfono de la escuela', ejemplo: '601 555 0000' },
    { clave: 'folio', etiqueta: 'Folio de la constancia', ejemplo: 'CDE-2026-00001' },
    { clave: 'fecha_emision', etiqueta: 'Fecha de expedición', ejemplo: '24 de noviembre de 2026' },
    { clave: 'fecha_actual', etiqueta: 'Fecha de expedición (nombre anterior)', ejemplo: '24 de noviembre de 2026' },
];

type Concordancia = { genero: string; inscrito: string; activo: string; identificado: string };
const FEM: Concordancia = { genero: 'femenino', inscrito: 'inscrita', activo: 'activa', identificado: 'identificada' };
const MASC: Concordancia = { genero: 'masculino', inscrito: 'inscrito', activo: 'activo', identificado: 'identificado' };
const GENERO: Record<string, Concordancia> = { f: FEM, female: FEM, femenino: FEM, m: MASC, male: MASC, masculino: MASC };

/**
 * Diccionario de variables a partir de la foto de datos de la constancia.
 * `fechaEmision` es la fecha de expedición (issued_at), no la de hoy: antes,
 * regenerar el PDF cambiaba la fecha del documento.
 */
export function buildVars(snapshot: any, folio: string, fechaEmision: unknown, schoolName?: string | null) {
    const athlete = snapshot?.athlete ?? {};
    const school = snapshot?.school ?? {};
    const g = GENERO[String(athlete.gender ?? '').trim().toLowerCase()];
    const emision = fechaLarga(fechaEmision) || fechaLarga(new Date());
    return {
        atleta: {
            nombre: athlete.full_name ?? '',
            documento: athlete.doc_number ?? '',
            tipo_doc: athlete.doc_type ?? '',
            fecha_nac: fechaLarga(athlete.date_of_birth),
            edad: edadEn(athlete.date_of_birth, fechaEmision ?? new Date()),
            genero: g?.genero ?? (athlete.gender ?? ''),
            inscrito: g?.inscrito ?? 'inscrito(a)',
            activo: g?.activo ?? 'activo(a)',
            // Frase completa o nada: sin documento en la ficha, el texto no queda
            // en «identificado(a) con ,».
            identificacion: athlete.doc_number
                ? `${g?.identificado ?? 'identificado(a)'} con ${athlete.doc_type ? `${athlete.doc_type} ` : ''}${athlete.doc_number}`
                : '',
        },
        escuela: {
            nombre: schoolName || school.name || '',
            ciudad: school.city ?? '',
            direccion: school.address ?? '',
            telefono: school.phone ?? '',
        },
        equipo: snapshot?.team_name ?? '',
        sede: snapshot?.branch_name ?? '',
        folio,
        fecha_emision: emision,
        fecha_actual: emision,
        inscripcion: {
            inicio: fechaLarga(snapshot?.enrollment?.start_date),
            estado: snapshot?.enrollment?.status ?? '',
            vence: fechaLarga(snapshot?.enrollment?.expires_at),
        },
    };
}

/**
 * Reemplaza {{a.b}} por su valor y devuelve además qué variables usadas
 * quedaron vacías (para avisarle a la escuela qué dato falta en la ficha).
 */
export function renderTemplate(template: string, vars: Record<string, any>): { texto: string; vacias: string[] } {
    const vacias = new Set<string>();
    const texto = String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
        let v: any = vars;
        for (const p of path.split('.')) {
            if (v == null) break;
            v = v[p];
        }
        if (v == null || v === '' || typeof v === 'object') {
            vacias.add(path);
            return '';
        }
        return String(v);
    });
    // Un dato vacío deja «con  ,» o «equipo  de»: se limpian los espacios dobles
    // y el espacio antes de un signo de puntuación.
    const limpio = texto
        .split('\n')
        .map((l) => l
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/ +([,.;:])/g, '$1')
            .replace(/,(\s*,)+/g, ',')
            .trimEnd())
        .join('\n');
    return { texto: limpio, vacias: [...vacias] };
}

export function etiquetaVariable(clave: string): string {
    return VARIABLES_CONSTANCIA.find((v) => v.clave === clave)?.etiqueta ?? clave;
}

/** Foto de datos de ejemplo para la vista previa del editor. */
export function snapshotDeEjemplo(school: { name?: string | null; city?: string | null; address?: string | null; phone?: string | null }) {
    return {
        athlete: {
            kind: 'child',
            full_name: 'Sofía Herrera Gómez',
            doc_type: 'TI',
            doc_number: '1.023.456.789',
            date_of_birth: '2017-04-09',
            gender: 'F',
        },
        school: { name: school.name ?? 'Tu escuela', city: school.city ?? 'Bogotá', address: school.address ?? '', phone: school.phone ?? '' },
        team_name: 'Natación — Infantil',
        branch_name: 'Unidad Norte',
        enrollment: { start_date: '2026-02-01', status: 'active', expires_at: '2026-12-15' },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Imágenes (logo y firma)
// ─────────────────────────────────────────────────────────────────────────────

/** PDFKit solo incrusta PNG y JPEG: se mira la firma de bytes, no la extensión. */
export function esImagenIncrustable(buf: Buffer | null | undefined): boolean {
    if (!buf || buf.length < 4) return false;
    const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    return png || jpg;
}

/**
 * Deja la imagen en un formato que PDFKit incrusta. Lo que se sube a
 * school-assets se recomprime a WEBP en el navegador (imageCompression.ts,
 * perfil «logo»), así que el logo y la firma casi siempre llegan en WEBP:
 * se pasan a PNG conservando la transparencia.
 */
export async function aFormatoIncrustable(buf: Buffer | null | undefined): Promise<Buffer | null> {
    if (!buf || buf.length === 0) return null;
    if (esImagenIncrustable(buf)) return buf;
    try {
        return await sharp(buf, { limitInputPixels: 40_000_000 })
            .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer();
    } catch {
        return null;
    }
}

/** Descarga una imagen pública (máx. 3 MB, 6 s) lista para el PDF. Null si falla. */
export async function descargarImagen(url: string | null | undefined): Promise<Buffer | null> {
    if (!url || !/^https:\/\//i.test(url)) return null;
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 3 * 1024 * 1024) return null;
        return await aFormatoIncrustable(buf);
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF
// ─────────────────────────────────────────────────────────────────────────────

export interface ConstanciaPdfInput {
    folio: string;
    titulo: string;
    cuerpo: string;                 // ya renderizado
    fechaEmision: string;           // «24 de noviembre de 2026»
    ciudad?: string | null;
    escuela: string;
    color: string;                  // hex validado
    logo?: Buffer | null;
    firma?: Buffer | null;
    firmaNombre?: string | null;
    firmaCargo?: string | null;
    pie?: string | null;
    verifyUrl: string;
    marcaSportMaps?: boolean;
    vistaPrevia?: boolean;
    incluirLineaFecha?: boolean;
}

export async function generarPdfConstancia(o: ConstanciaPdfInput): Promise<Buffer> {
    const qrPng = await QRCode.toBuffer(o.verifyUrl, { width: 220, margin: 0 });

    return await new Promise<Buffer>((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 60, info: { Title: `${o.titulo} — ${o.folio}`, Author: o.escuela } });
        const chunks: Buffer[] = [];
        doc.on('data', (c) => chunks.push(c as Buffer));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const W = doc.page.width;
        const H = doc.page.height;
        const M = 60;

        // ── Franja superior con logo, escuela y folio ──
        doc.rect(0, 0, W, 104).fill(o.color);
        let nombreX = M;
        if (o.logo) {
            try {
                doc.roundedRect(M, 20, 64, 64, 10).fill('#ffffff');
                doc.image(o.logo, M + 6, 26, { fit: [52, 52], align: 'center', valign: 'center' });
                nombreX = M + 80;
            } catch {
                nombreX = M;
            }
        }
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19)
            .text(o.escuela, nombreX, 34, { width: W - nombreX - 200, ellipsis: true, height: 48 });
        doc.font('Helvetica').fontSize(9)
            .text(`FOLIO ${o.folio}`, W - 200, 38, { width: 140, align: 'right' })
            .text(o.fechaEmision, W - 200, 52, { width: 140, align: 'right' });

        // ── Marca de agua de vista previa ──
        if (o.vistaPrevia) {
            doc.save();
            doc.rotate(-30, { origin: [W / 2, H / 2] });
            doc.fillColor('#e5e7eb').font('Helvetica-Bold').fontSize(72)
                .text('VISTA PREVIA', 0, H / 2 - 40, { width: W, align: 'center' });
            doc.restore();
        }

        // ── Título y cuerpo ──
        doc.fillColor('#111827').font('Helvetica-Bold').fontSize(18)
            .text(o.titulo || 'CONSTANCIA', M, 150, { width: W - 2 * M, align: 'center', characterSpacing: 1.5 });
        doc.moveDown(1.6);
        doc.fillColor('#1f2937').font('Helvetica').fontSize(11.5)
            .text(o.cuerpo, M, doc.y, { width: W - 2 * M, align: 'justify', lineGap: 5, paragraphGap: 8 });

        if (o.incluirLineaFecha) {
            doc.moveDown(1.2);
            doc.fontSize(11).text(
                `${o.ciudad ? `${o.ciudad}, ` : ''}${o.fechaEmision}`,
                M, doc.y, { width: W - 2 * M, align: 'right' },
            );
        }

        // ── Firma ── (si no cabe antes del QR, a la página siguiente)
        const qrY = H - 190;
        const tieneFirma = !!(o.firma || o.firmaNombre || o.firmaCargo);
        if (tieneFirma) {
            const alto = (o.firma ? 70 : 0) + 60;
            if (doc.y + 30 + alto > qrY - 10) doc.addPage();
            const x = W - M - 230;
            let y = Math.max(doc.y + 30, 0);
            if (o.firma) {
                try {
                    doc.image(o.firma, x + 35, y, { fit: [160, 64], align: 'center', valign: 'bottom' });
                } catch { /* firma ilegible: se deja la línea */ }
                y += 68;
            } else {
                y += 30;
            }
            doc.moveTo(x, y).lineTo(x + 230, y).strokeColor('#374151').lineWidth(0.7).stroke();
            doc.fillColor('#111827').font('Helvetica-Bold').fontSize(10.5)
                .text(o.firmaNombre || '', x, y + 6, { width: 230, align: 'center' });
            if (o.firmaCargo) {
                doc.font('Helvetica').fontSize(9.5).fillColor('#374151')
                    .text(o.firmaCargo, x, doc.y + 1, { width: 230, align: 'center' });
            }
        }

        // ── QR de verificación ── (un cuerpo largo que bajó hasta acá no se pisa)
        if (doc.y > qrY - 10) doc.addPage();
        const pageH = doc.page.height;
        const yQr = pageH - 190;
        doc.image(qrPng, M, yQr, { width: 92, height: 92 });
        doc.fontSize(8.5).font('Helvetica').fillColor('#374151')
            .text('Verifica la autenticidad de este documento escaneando el código o en:', M + 106, yQr + 8, { width: W - 2 * M - 106 });
        doc.font('Helvetica-Bold').fillColor('#111827').fontSize(8.5)
            .text(o.verifyUrl, M + 106, doc.y + 2, { width: W - 2 * M - 106 });
        doc.font('Helvetica').fillColor('#6b7280').fontSize(8)
            .text(`Folio único: ${o.folio}`, M + 106, doc.y + 6, { width: W - 2 * M - 106 });

        // ── Pie ──
        if (o.pie) {
            doc.fontSize(8).fillColor('#6b7280').font('Helvetica')
                .text(o.pie, M, pageH - 72, { width: W - 2 * M, align: 'center' });
        }
        if (o.marcaSportMaps) {
            doc.fontSize(7).fillColor('#9ca3af').font('Helvetica')
                .text('Emitido con SportMaps', M, pageH - 48, { width: W - 2 * M, align: 'center' });
        }

        doc.end();
    });
}

/** ¿La plantilla ya escribe la fecha de expedición? Si no, el PDF la agrega. */
export function plantillaTraeFecha(body: string | null | undefined): boolean {
    return /\{\{\s*(fecha_actual|fecha_emision)\s*\}\}/.test(String(body ?? ''));
}
