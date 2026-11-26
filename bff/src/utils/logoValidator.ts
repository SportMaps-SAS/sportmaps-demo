// bff/src/utils/logoValidator.ts
//
// Validacion server-side del logo de escuela (defense-in-depth).
// El bucket Supabase Storage `school-assets` ya valida MIME al subir, pero
// confiamos en el cliente para que pase el tipo correcto. Esta utilidad
// re-valida desde el BFF descargando los primeros bytes del archivo y
// comparando magic numbers contra una whitelist.
//
// Tambien valida:
//   - host (solo Supabase Storage del proyecto)
//   - path (debe ser logos/<school_id>/...)
//   - Content-Length (max 2MB, mismo cap que el bucket)
//   - SVG: sin <script> ni atributos on* ni javascript: URIs
//
// Si todo OK, devuelve { ok: true, mimeType }. Si no, { ok: false, error, detail }.

import { URL } from 'url';

const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const MAGIC_BYTES_PREFIX = 16; // bytes a leer para detectar formato
// Para SVG (text-based) necesitamos mas para hacer scan del contenido peligroso
const SVG_SCAN_BYTES = 64 * 1024; // 64KB suficiente para SVG razonable

type MimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

interface ValidationOk {
    ok: true;
    mimeType: MimeType;
    sizeBytes: number;
}
interface ValidationFail {
    ok: false;
    error:
        | 'logo_url_invalid_host'
        | 'logo_url_invalid_path'
        | 'logo_url_unreachable'
        | 'logo_url_unsupported_mime'
        | 'logo_url_magic_bytes_mismatch'
        | 'logo_url_too_large'
        | 'logo_url_svg_unsafe';
    detail?: string;
}
export type LogoValidationResult = ValidationOk | ValidationFail;

/**
 * Resuelve el host esperado del bucket Storage segun el SUPABASE_URL del
 * entorno. Acepta el bucket publico (`/storage/v1/object/public/school-assets/`).
 */
function expectedHost(): string {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    try {
        return new URL(supabaseUrl).host;
    } catch {
        return '';
    }
}

function magicMatches(buf: Buffer, magic: number[], offset = 0): boolean {
    for (let i = 0; i < magic.length; i++) {
        if (buf[i + offset] !== magic[i]) return false;
    }
    return true;
}

export function detectMimeFromMagicBytes(buf: Buffer): MimeType | null {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (magicMatches(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return 'image/png';
    }
    // JPEG: FF D8 FF
    if (magicMatches(buf, [0xff, 0xd8, 0xff])) {
        return 'image/jpeg';
    }
    // WEBP: "RIFF" .... "WEBP"
    if (magicMatches(buf, [0x52, 0x49, 0x46, 0x46]) && magicMatches(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
        return 'image/webp';
    }
    // SVG (text-based) detection mas abajo
    return null;
}

export function looksLikeSvg(buf: Buffer): boolean {
    // Skip BOM si esta
    const start = buf.toString('utf8', 0, 256).trimStart();
    return start.startsWith('<?xml') || start.toLowerCase().startsWith('<svg');
}

export function svgIsSafe(content: string): { safe: boolean; reason?: string } {
    const lower = content.toLowerCase();
    // <script>...</script>
    if (/<script[\s>]/i.test(content)) {
        return { safe: false, reason: 'contains_script_tag' };
    }
    // Atributos onload, onclick, onerror, on*=
    if (/\son[a-z]+\s*=/.test(lower)) {
        return { safe: false, reason: 'contains_event_handler' };
    }
    // javascript: URI
    if (/javascript:/i.test(content)) {
        return { safe: false, reason: 'contains_javascript_uri' };
    }
    // <foreignObject> con HTML embebido — puede meter scripts indirectamente
    if (/<foreignobject[\s>]/i.test(lower)) {
        return { safe: false, reason: 'contains_foreign_object' };
    }
    // <use href="data:..."> tambien puede ser vector
    if (/<use[^>]+href\s*=\s*["']?data:/i.test(lower)) {
        return { safe: false, reason: 'contains_data_use_href' };
    }
    return { safe: true };
}

/**
 * Valida que `url` apunte a un logo legitimo en el bucket de Storage de
 * SportMaps para la escuela `expectedSchoolId`. Hace 2 requests: HEAD
 * (para tamaño) + GET parcial (para magic bytes / scan SVG).
 */
export async function validateLogoUrl(
    url: string,
    expectedSchoolId: string,
): Promise<LogoValidationResult> {
    // 1. Validacion estatica del URL (host + path)
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, error: 'logo_url_invalid_host', detail: 'malformed_url' };
    }

    const expectedHostname = expectedHost();
    if (!expectedHostname || parsed.host !== expectedHostname) {
        return { ok: false, error: 'logo_url_invalid_host', detail: parsed.host };
    }

    // Path esperado: /storage/v1/object/public/school-assets/logos/<school_id>/...
    const expectedPathPrefix = `/storage/v1/object/public/school-assets/logos/${expectedSchoolId}/`;
    if (!parsed.pathname.startsWith(expectedPathPrefix)) {
        return { ok: false, error: 'logo_url_invalid_path', detail: parsed.pathname };
    }

    // 2. HEAD para tamaño
    let headRes: Response;
    try {
        headRes = await fetch(url, { method: 'HEAD' });
    } catch (err: any) {
        return { ok: false, error: 'logo_url_unreachable', detail: err?.message || 'network_error' };
    }
    if (!headRes.ok) {
        return { ok: false, error: 'logo_url_unreachable', detail: `head_status_${headRes.status}` };
    }

    const contentLength = parseInt(headRes.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BYTES) {
        return { ok: false, error: 'logo_url_too_large', detail: `${contentLength}_bytes` };
    }

    const contentTypeHeader = (headRes.headers.get('content-type') || '').toLowerCase();
    const allowedMimes: MimeType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
    const headerMime = allowedMimes.find((m) => contentTypeHeader.startsWith(m));
    if (!headerMime) {
        return { ok: false, error: 'logo_url_unsupported_mime', detail: contentTypeHeader };
    }

    // 3. GET parcial para magic bytes / scan SVG
    // SVG: necesitamos mas bytes (hasta 64KB) para scan completo. Para
    // formatos binarios alcanza con 16 bytes.
    const bytesToFetch = headerMime === 'image/svg+xml' ? SVG_SCAN_BYTES : MAGIC_BYTES_PREFIX;

    let getRes: Response;
    try {
        getRes = await fetch(url, {
            headers: { Range: `bytes=0-${bytesToFetch - 1}` },
        });
    } catch (err: any) {
        return { ok: false, error: 'logo_url_unreachable', detail: err?.message || 'network_error' };
    }
    if (!getRes.ok && getRes.status !== 206) {
        return { ok: false, error: 'logo_url_unreachable', detail: `get_status_${getRes.status}` };
    }

    const buf = Buffer.from(await getRes.arrayBuffer());

    if (headerMime === 'image/svg+xml') {
        if (!looksLikeSvg(buf)) {
            return { ok: false, error: 'logo_url_magic_bytes_mismatch', detail: 'svg_header_missing' };
        }
        const txt = buf.toString('utf8');
        const safe = svgIsSafe(txt);
        if (!safe.safe) {
            return { ok: false, error: 'logo_url_svg_unsafe', detail: safe.reason };
        }
        return { ok: true, mimeType: 'image/svg+xml', sizeBytes: contentLength };
    }

    const detected = detectMimeFromMagicBytes(buf);
    if (detected !== headerMime) {
        return {
            ok: false,
            error: 'logo_url_magic_bytes_mismatch',
            detail: `header=${headerMime}, actual=${detected || 'unknown'}`,
        };
    }

    return { ok: true, mimeType: headerMime, sizeBytes: contentLength };
}
