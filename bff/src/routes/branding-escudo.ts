// bff/src/routes/branding-escudo.ts
//
// POST /api/v1/branding/escudo — sube el escudo del club (carnet 3D, F2).
// Spec: docs/specs/carnet-3d-club.md §2 D5/D6, §6, §10.
//
// Qué hace:
//  1. Valida el archivo por FIRMA DE BYTES (PNG, WebP o SVG; no por extensión
//     ni por el tipo que diga el cliente), ≤ 2 MB y ≥ 512 px en el lado menor.
//  2. SVG: rechaza lo inseguro (script, on*, javascript:, foreignObject,
//     entidades, enlaces externos) y lo rasteriza a PNG con sharp. El SVG
//     nunca se guarda ni se sirve tal cual (D5).
//  3. Normaliza a WebP CON ALFA (la transparencia se conserva, D6) y avisa
//     —sin bloquear— si la imagen no tiene transparencia.
//  4. Sube con service role a school-assets/logos/<school_id>/<ts>_escudo.webp.
//  5. Llama update_school_branding CON EL JWT DEL USUARIO (auth.uid() = él)
//     con p_logo_url y p_confirma_derechos_escudo = true: quién y cuándo
//     confirmó los derechos los pone el servidor.
//
// Body JSON (el BFF no usa multipart; mismo patrón que enrollment-intake):
//   { school_id: uuid, confirmo_derechos: true, archivo_base64: string }

import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { supabase, supabaseUrl, supabaseAnonKey } from '../config/supabase';
import { requireAuth, requireRole, auditLog } from '../middlewares/authMiddleware';
import { esAdminDePlataforma } from '../middlewares/requirePlatformAdmin';
import { requireCsrfHeader } from '../middlewares/csrfHeader';
import { detectMimeFromMagicBytes, looksLikeSvg, svgIsSafe } from '../utils/logoValidator';
import { invalidateBrandingCache } from '../utils/schoolBrandingResolver';
import { generarIconosPwa } from '../services/pwaIcons.service';
import { invalidatePwaManifestCache } from './pwa.routes';

// ── Reglas del archivo (spec §6) ─────────────────────────────────────────────
export const ESCUDO_MAX_BYTES = 2 * 1024 * 1024;
export const ESCUDO_MIN_LADO_PX = 512;
/** Lado mayor del WebP guardado: el carnet no necesita más. */
export const ESCUDO_MAX_LADO_SALIDA_PX = 1024;
/** Anti «bomba de descompresión»: un PNG de 2 MB puede declarar 30 000 × 30 000. */
const LIMITE_PIXELES_ENTRADA = 50_000_000;
const BUCKET = 'school-assets';

export type FormatoEscudo = 'png' | 'webp' | 'svg';

export type ErrorEscudo =
    | 'archivo_vacio'
    | 'archivo_muy_grande'
    | 'formato_no_permitido'
    | 'svg_inseguro'
    | 'imagen_ilegible'
    | 'imagen_muy_pequena';

/** Mensajes para la pantalla: frases cortas, sin jerga. */
export const MENSAJES_ESCUDO: Record<ErrorEscudo, string> = {
    archivo_vacio: 'El archivo llegó vacío. Vuelve a elegirlo.',
    archivo_muy_grande: 'El escudo pesa más de 2 MB. Usa uno más liviano.',
    formato_no_permitido: 'Sube el escudo en PNG, WebP o SVG.',
    svg_inseguro: 'Ese SVG trae contenido que no podemos usar. Expórtalo de nuevo o súbelo en PNG.',
    imagen_ilegible: 'No pudimos abrir la imagen. Prueba con otro archivo.',
    imagen_muy_pequena: 'El escudo es muy pequeño: necesita al menos 512 px por lado.',
};

/**
 * Formato por firma de bytes. Solo PNG, WebP y SVG (el escudo necesita
 * transparencia: JPEG no la tiene y se rechaza). null = no permitido.
 */
export function detectarFormatoEscudo(buf: Buffer): FormatoEscudo | null {
    if (!buf || buf.length < 4) return null;
    const mime = detectMimeFromMagicBytes(buf);
    if (mime === 'image/png') return 'png';
    if (mime === 'image/webp') return 'webp';
    if (mime) return null; // JPEG u otro binario conocido
    // Texto: SVG (con o sin prólogo XML / BOM). El prólogo solo no basta:
    // tiene que haber un <svg en el documento.
    const sinBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
    if (looksLikeSvg(sinBom) && /<svg[\s>]/i.test(sinBom.toString('utf8'))) return 'svg';
    return null;
}

/**
 * ¿El SVG se puede rasterizar sin riesgo? Además de lo de logoValidator
 * (script, on*, javascript:, foreignObject, <use href=data:>), rechaza
 * entidades XML (XXE / «billion laughs») y cualquier referencia externa
 * (href o url() que no sea un ancla interna o una imagen embebida en data:).
 */
export function validarSvgEscudo(texto: string): { ok: true } | { ok: false; motivo: string } {
    const base = svgIsSafe(texto);
    if (!base.safe) return { ok: false, motivo: base.reason ?? 'unsafe' };
    if (/<!entity/i.test(texto)) return { ok: false, motivo: 'contains_entity' };
    // href / xlink:href hacia afuera
    const hrefs = texto.matchAll(/(?:xlink:)?href\s*=\s*["']\s*([^"']*)["']/gi);
    for (const m of hrefs) {
        const v = (m[1] ?? '').trim().toLowerCase();
        if (v === '' || v.startsWith('#')) continue;
        if (/^data:image\/(png|jpeg|jpg|gif|webp);/.test(v)) continue;
        return { ok: false, motivo: 'external_href' };
    }
    // url(...) en estilos que no sea un ancla interna
    const urls = texto.matchAll(/url\(\s*["']?\s*([^"')\s]*)/gi);
    for (const m of urls) {
        const v = (m[1] ?? '').trim();
        if (!v.startsWith('#')) return { ok: false, motivo: 'external_url' };
    }
    if (/@import/i.test(texto)) return { ok: false, motivo: 'css_import' };
    return { ok: true };
}

export type ResultadoEscudo =
    | {
          ok: true;
          webp: Buffer;
          ancho: number;
          alto: number;
          formatoOriginal: FormatoEscudo;
          /** true → la imagen es opaca (aviso, no bloquea). */
          sinTransparencia: boolean;
      }
    | { ok: false; error: ErrorEscudo; detalle?: string };

/** SVG → PNG (D5). Densidad calculada para que el lado menor quede ≈ 1024 px. */
export async function rasterizarSvg(svg: Buffer): Promise<Buffer> {
    const meta = await sharp(svg, { limitInputPixels: LIMITE_PIXELES_ENTRADA }).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) throw new Error('svg_sin_dimensiones');
    // A 72 dpi el SVG mide w × h. Escalar para lado menor ≈ 1024 sin que el
    // mayor pase de 4096 (un SVG muy alargado no explota en píxeles).
    const escala = Math.min(1024 / Math.min(w, h), 4096 / Math.max(w, h));
    const density = Math.max(1, Math.min(100_000, Math.round(72 * escala)));
    return sharp(svg, { density, limitInputPixels: LIMITE_PIXELES_ENTRADA }).png().toBuffer();
}

/**
 * Valida y normaliza el escudo. Función pura (sin red ni base): la usa la ruta
 * y la prueban los tests.
 */
export async function procesarEscudo(buf: Buffer): Promise<ResultadoEscudo> {
    if (!buf || buf.length === 0) return { ok: false, error: 'archivo_vacio' };
    if (buf.length > ESCUDO_MAX_BYTES) return { ok: false, error: 'archivo_muy_grande', detalle: `${buf.length}_bytes` };

    const formato = detectarFormatoEscudo(buf);
    if (!formato) return { ok: false, error: 'formato_no_permitido' };

    let raster: Buffer = buf;
    if (formato === 'svg') {
        const v = validarSvgEscudo(buf.toString('utf8'));
        if (!v.ok) return { ok: false, error: 'svg_inseguro', detalle: v.motivo };
        try {
            raster = await rasterizarSvg(buf);
        } catch (err: any) {
            return { ok: false, error: 'imagen_ilegible', detalle: err?.message };
        }
    }

    let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
        meta = await sharp(raster, { limitInputPixels: LIMITE_PIXELES_ENTRADA }).metadata();
    } catch (err: any) {
        return { ok: false, error: 'imagen_ilegible', detalle: err?.message };
    }
    const ancho = meta.width ?? 0;
    const alto = meta.height ?? 0;
    if (!ancho || !alto) return { ok: false, error: 'imagen_ilegible', detalle: 'sin_dimensiones' };
    if (Math.min(ancho, alto) < ESCUDO_MIN_LADO_PX) {
        return { ok: false, error: 'imagen_muy_pequena', detalle: `${ancho}x${alto}` };
    }

    try {
        // isOpaque mira los píxeles reales: un PNG con canal alfa pero todo
        // opaco también cuenta como «sin transparencia».
        const stats = await sharp(raster, { limitInputPixels: LIMITE_PIXELES_ENTRADA }).stats();
        const { data, info } = await sharp(raster, { limitInputPixels: LIMITE_PIXELES_ENTRADA, animated: false })
            .resize({
                width: ESCUDO_MAX_LADO_SALIDA_PX,
                height: ESCUDO_MAX_LADO_SALIDA_PX,
                fit: 'inside',
                withoutEnlargement: true,
            })
            // alphaQuality 100 = alfa sin pérdida: un píxel transparente sigue transparente.
            .webp({ quality: 90, alphaQuality: 100 })
            .toBuffer({ resolveWithObject: true });
        return {
            ok: true,
            webp: data,
            ancho: info.width,
            alto: info.height,
            formatoOriginal: formato,
            sinTransparencia: stats.isOpaque,
        };
    } catch (err: any) {
        return { ok: false, error: 'imagen_ilegible', detalle: err?.message };
    }
}

/**
 * Cliente de Supabase con el JWT del usuario: las RPC ven auth.uid() = él.
 * (El cliente del BFF es service role y para él auth.uid() es NULL.)
 */
export function clienteConJwtDelUsuario(authorization: string | undefined) {
    return createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authorization ?? '' } },
        auth: { autoRefreshToken: false, persistSession: false },
    });
}

/** Errores de update_school_branding → HTTP (mismo mapa que schools.routes.ts). */
export const STATUS_POR_ERROR_BRANDING: Record<string, number> = {
    auth_required: 401,
    school_id_required: 400,
    forbidden: 403,
    feature_not_available: 403,
    rate_limited: 429,
    invalid_primary_color: 400,
    invalid_secondary_color: 400,
    invalid_accent_color: 400,
    invalid_logo_url: 400,
    school_not_found: 404,
};

// ── Ruta ─────────────────────────────────────────────────────────────────────
const router = Router();

const escudoLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 10 : 100,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const schoolId = (req as any).body?.school_id || (req as any).schoolId;
        return schoolId ? `escudo-school-${schoolId}` : `escudo-ip-${ipKeyGenerator(req.ip ?? '')}`;
    },
    message: { error: 'rate_limited', message: 'Demasiados cambios de escudo seguidos. Intenta en 1 hora.' },
});

const bodySchema = z.object({
    school_id: z.string().uuid(),
    confirmo_derechos: z.boolean().optional(),
    // 2 MB en base64 ≈ 2,8 MB; el tope duro lo pone el tamaño decodificado.
    archivo_base64: z.string().min(16).max(3_000_000),
});

router.post(
    '/escudo',
    requireAuth,
    requireRole('owner', 'admin', 'school_admin', 'school'),
    requireCsrfHeader,
    escudoLimiter,
    async (req: Request, res: Response) => {
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: 'invalid_payload',
                message: 'Falta el archivo del escudo o el club.',
                details: parsed.error.flatten(),
            });
        }
        const { school_id: schoolId, confirmo_derechos, archivo_base64 } = parsed.data;

        if (confirmo_derechos !== true) {
            return res.status(400).json({
                error: 'derechos_sin_confirmar',
                message: 'Confirma que el club tiene derecho a usar este escudo.',
            });
        }

        // Anti-IDOR: mismo criterio que PUT /schools/:id/branding.
        const isPrivileged = req.role === 'super_admin' && await esAdminDePlataforma(req.user.id);
        if (!isPrivileged && req.schoolId !== schoolId) {
            req.log?.warn(
                { userId: req.user?.id, role: req.role, bodySchool: schoolId, sessionSchool: req.schoolId },
                'IDOR attempt: escudo upload cross-school',
            );
            return res.status(403).json({ error: 'forbidden', message: 'school_id mismatch' });
        }

        const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null;
        const userAgent = req.headers['user-agent'] || null;

        const buffer = Buffer.from(archivo_base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
        const resultado = await procesarEscudo(buffer);
        if (!resultado.ok) {
            if (resultado.error === 'svg_inseguro') {
                await auditLog(req, 'branding_logo_rejected', 'schools', schoolId, null, {
                    origen: 'escudo', validation_error: resultado.error, detail: resultado.detalle,
                });
            }
            return res.status(resultado.error === 'archivo_muy_grande' ? 413 : 400).json({
                error: resultado.error,
                message: MENSAJES_ESCUDO[resultado.error],
            });
        }

        const path = `logos/${schoolId}/${Date.now()}_escudo.webp`;
        try {
            const { error: upErr } = await supabase.storage
                .from(BUCKET)
                .upload(path, resultado.webp, { contentType: 'image/webp', upsert: false, cacheControl: '31536000' });
            if (upErr) {
                req.log?.error({ err: upErr, schoolId }, '[escudo] no se pudo subir a Storage');
                return res.status(500).json({ error: 'server_error', message: 'No se pudo guardar el escudo. Intenta de nuevo.' });
            }
            const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
            const logoUrl = pub.publicUrl;

            const userClient = clienteConJwtDelUsuario(req.headers.authorization);
            const { data, error } = await userClient.rpc('update_school_branding', {
                p_school_id: schoolId,
                p_logo_url: logoUrl,
                p_ip_address: ip,
                p_user_agent: userAgent,
                p_confirma_derechos_escudo: true,
            });

            if (error || !data?.ok) {
                // El archivo quedó huérfano: se borra (best effort).
                void supabase.storage.from(BUCKET).remove([path]).catch(() => undefined);
                if (error) {
                    req.log?.error({ err: error, schoolId }, '[escudo] update_school_branding falló');
                    return res.status(500).json({ error: 'server_error', detail: error.message });
                }
                const code = (data as any)?.error || 'unknown';
                return res.status(STATUS_POR_ERROR_BRANDING[code] ?? 400).json(data);
            }

            await auditLog(req, 'branding_escudo_upload', 'schools', schoolId, null, {
                logo_url: data.logo_url,
                formato_original: resultado.formatoOriginal,
                ancho: resultado.ancho,
                alto: resultado.alto,
                sin_transparencia: resultado.sinTransparencia,
                escudo_derechos: (data.branding_settings as any)?.escudo_derechos ?? null,
            });

            invalidateBrandingCache(schoolId);

            // Iconos PWA: mismo efecto que el PUT de branding, sin bloquear.
            const bg = (data.branding_settings as any)?.primary_color ?? null;
            void generarIconosPwa({ schoolId, logoUrl: data.logo_url, backgroundColor: bg, actorId: req.user.id })
                .then((r) => {
                    if (r.ok) invalidatePwaManifestCache();
                    else req.log?.warn({ schoolId, error: r.error }, 'no se pudieron generar los iconos PWA');
                })
                .catch((err) => req.log?.error({ err, schoolId }, 'error inesperado generando iconos PWA'));

            return res.json({
                ...data,
                aviso: resultado.sinTransparencia
                    ? 'Tu escudo no tiene fondo transparente. Se verá con un recuadro en el carnet.'
                    : null,
                ancho: resultado.ancho,
                alto: resultado.alto,
            });
        } catch (err: any) {
            req.log?.error({ err, schoolId }, 'Error en POST /branding/escudo');
            return res.status(500).json({ error: 'server_error' });
        }
    },
);

export default router;
