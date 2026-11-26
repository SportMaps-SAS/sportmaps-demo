// bff/src/routes/schools.routes.ts
//
// Endpoints relacionados con la escuela activa del usuario.
// Hoy: branding (white-label). Futuro: settings, custom domains.
//
// Seguridad:
//  - requireAuth: valida JWT + membresia en school_members
//  - requireRole: solo owner/admin/school_admin/super_admin
//  - requireCsrfHeader: previene CSRF para state-changing routes
//  - rate-limit dedicado: 10/hora por escuela (anti-abuse)
//  - validacion server-side con zod (hex strict, logo_url whitelisted)
//  - RPC seguro update_school_branding (audit log automatico)
//  - auditLog adicional en security_audit_log (correlacion cross-action)

import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { requireAuth, requireRole, auditLog } from '../middlewares/authMiddleware';
import { esAdminDePlataforma } from '../middlewares/requirePlatformAdmin';
import { requireCsrfHeader } from '../middlewares/csrfHeader';
import { validateLogoUrl } from '../utils/logoValidator';
import { invalidateBrandingCache } from '../utils/schoolBrandingResolver';
import { generarIconosPwa } from '../services/pwaIcons.service';
import { invalidatePwaManifestCache } from './pwa.routes';
import { clienteConJwtDelUsuario, STATUS_POR_ERROR_BRANDING } from './branding-escudo';

const router = Router();

// ── Rate limit especifico para branding ──────────────────────────────────────
// Espejo del rate-limit del RPC SQL (max 10/hora). El doble-cap (BFF + DB)
// protege incluso si alguien bypassea el BFF llamando al RPC directo.
const brandingLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: process.env.NODE_ENV === 'production' ? 10 : 100,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Cap por escuela, no por IP (varios admins desde misma red).
        const schoolId = (req as any).params?.id || (req as any).schoolId;
        return schoolId ? `branding-school-${schoolId}` : `branding-ip-${ipKeyGenerator(req.ip ?? '')}`;
    },
    message: {
        error: 'rate_limited',
        message: 'Demasiados cambios de marca recientes. Intenta en 1 hora.',
    },
});

// ── Schema de validacion ─────────────────────────────────────────────────────
// Regex hex estricto: anti-XSS via CSS var injection. Ej. payload malicioso
// como "#fff; background: url(javascript:..." seria rechazado.
const HEX_COLOR = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'invalid_hex_color');

const brandingUpdateSchema = z.object({
    // Si se envia logo_url, debe ser del bucket Supabase Storage school-assets
    // con la ruta logos/<school_id>/... La validacion estricta del prefix la
    // hace el RPC SQL, aqui solo verificamos forma general.
    logo_url:         z.string().url().max(1024).nullable().optional(),
    primary_color:    HEX_COLOR.optional(),
    secondary_color:  HEX_COLOR.optional(),
    accent_color:     HEX_COLOR.optional(),
    // «Restablecer»: vuelve al diseño base SportMaps (borra los tres colores).
    reset_colores:    z.boolean().optional(),
    show_watermark:   z.boolean().optional(),
}).refine(
    (data) => Object.keys(data).length > 0,
    { message: 'at_least_one_field_required' },
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/schools/:id/branding
//
// Actualiza el branding de una escuela (logo + colores + watermark toggle).
// Solo accesible para admins de la escuela en tier Pro+ (gate hecho por RPC).
//
// Body (todos opcionales, al menos uno requerido):
//   { logo_url?, primary_color?, secondary_color?, accent_color?,
//     reset_colores?, show_watermark? }
//
// Respuestas:
//   200 { ok: true, school_id, logo_url, branding_settings }
//   400 invalid_payload | invalid_*_color | invalid_logo_url
//   401 auth_required
//   403 forbidden | feature_not_available
//   429 rate_limited
//   500 server_error
// ─────────────────────────────────────────────────────────────────────────────
router.put(
    '/:id/branding',
    requireAuth,
    requireRole('owner', 'admin', 'school_admin', 'school'),
    requireCsrfHeader,
    brandingLimiter,
    async (req: Request, res: Response) => {
        const schoolIdParam = req.params.id as string;

        // Forzar coincidencia entre param y header x-school-id resuelto por requireAuth.
        // Anti-IDOR: super-admin puede cambiar otra escuela enviando x-school-id especifico,
        // resto debe match exacto. requireAuth ya garantiza membership en req.schoolId.
        // Solo plataforma salta el match de escuela. 'owner'/'admin' son roles de
        // MEMBRESÍA: con ellos un dueño editaba/leía la marca de CUALQUIER escuela.
        const isPrivileged = req.role === 'super_admin' && await esAdminDePlataforma(req.user.id);
        if (!isPrivileged && req.schoolId !== schoolIdParam) {
            req.log?.warn(
                { userId: req.user?.id, role: req.role, paramSchool: schoolIdParam, sessionSchool: req.schoolId },
                'IDOR attempt: branding update cross-school',
            );
            return res.status(403).json({ error: 'forbidden', message: 'school_id mismatch' });
        }

        // Validacion zod
        const parsed = brandingUpdateSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: 'invalid_payload',
                details: parsed.error.flatten(),
            });
        }
        const { logo_url, primary_color, secondary_color, accent_color, reset_colores, show_watermark } = parsed.data;

        // Forensics: IP real considerando proxy (Render setea x-forwarded-for)
        const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null;
        const userAgent = req.headers['user-agent'] || null;

        // ── Defense-in-depth: validacion MIME real del logo (Fase 1.8) ──
        // El bucket Storage ya valida MIME al subir, pero confiamos en el
        // cliente para que pase el tipo correcto. Aqui re-validamos:
        //   - host es el Storage de SportMaps
        //   - path es logos/<school_id>/
        //   - magic bytes coinciden con el header Content-Type
        //   - SVG no contiene <script>, onload, javascript:, foreignObject
        //   - tamaño <= 2MB
        if (logo_url) {
            const validation = await validateLogoUrl(logo_url, schoolIdParam);
            if (!validation.ok) {
                req.log?.warn(
                    {
                        userId: req.user?.id,
                        schoolId: schoolIdParam,
                        logoUrl: logo_url,
                        validationError: validation.error,
                        detail: validation.detail,
                        ip,
                        ua: userAgent,
                    },
                    'Logo validation rejected (defense-in-depth)',
                );
                // Audit cruzado para forense (puede haber sido intento de bypass)
                await auditLog(
                    req,
                    'branding_logo_rejected',
                    'schools',
                    schoolIdParam,
                    null,
                    { logo_url, validation_error: validation.error, detail: validation.detail },
                );
                return res.status(400).json({
                    error: validation.error,
                    message: 'El logo no pasó la validación de seguridad. Volvé a subir el archivo.',
                    detail: validation.detail,
                });
            }
        }

        try {
            // Con el JWT del usuario: la RPC valida auth.uid() (con el cliente
            // service role auth.uid() es NULL y respondía siempre auth_required).
            const userClient = clienteConJwtDelUsuario(req.headers.authorization);
            const { data, error } = await userClient.rpc('update_school_branding', {
                p_school_id:        schoolIdParam,
                p_logo_url:         logo_url ?? null,
                p_primary_color:    primary_color ?? null,
                p_secondary_color:  secondary_color ?? null,
                p_show_watermark:   show_watermark ?? null,
                p_ip_address:       ip,
                p_user_agent:       userAgent,
                p_accent_color:     accent_color ?? null,
                p_reset_colores:    reset_colores ?? null,
            });

            if (error) {
                req.log?.error({ err: error, schoolIdParam }, 'update_school_branding RPC failed');
                return res.status(500).json({ error: 'server_error', detail: error.message });
            }

            if (!data?.ok) {
                // Mapear errores conocidos del RPC a status HTTP apropiados
                const errCode = data?.error || 'unknown';
                // Mapa compartido con POST /branding/escudo (incluye invalid_accent_color).
                return res.status(STATUS_POR_ERROR_BRANDING[errCode] ?? 400).json(data);
            }

            // Audit cruzado en security_audit_log (corre en background, no
            // bloquea respuesta). El branding_change_log ya lo hizo el RPC.
            await auditLog(
                req,
                'branding_update',
                'schools',
                schoolIdParam,
                null,
                {
                    logo_url:        data.logo_url,
                    branding_settings: data.branding_settings,
                },
            );

            // Invalidar cache del resolver para que emails / PDFs / push
            // futuros usen el branding actualizado inmediatamente (sin
            // esperar al TTL de 60s).
            invalidateBrandingCache(schoolIdParam);

            // ── Iconos del manifest PWA ──────────────────────────────────────
            // Si cambio el logo, se regeneran los PNG 192/512 que usa el
            // manifest para que la app instalada muestre la marca de la escuela.
            //
            // Deliberadamente NO bloquea la respuesta ni la hace fallar: guardar
            // el branding es la operacion que el usuario pidio y ya esta hecha.
            // Si sharp falla, el manifest sirve la marca SportMaps (fail-open) y
            // queda el log para reintentar. Romper el guardado del logo por un
            // derivado seria peor que no tener el icono.
            if (logo_url) {
                const bg = (data.branding_settings as any)?.primary_color ?? null;
                void generarIconosPwa({
                    schoolId: schoolIdParam,
                    logoUrl: data.logo_url,
                    backgroundColor: bg,
                    actorId: req.user.id,
                })
                    .then((r) => {
                        if (r.ok) {
                            invalidatePwaManifestCache();
                            req.log?.info({ schoolId: schoolIdParam }, 'iconos PWA regenerados');
                        } else {
                            req.log?.warn({ schoolId: schoolIdParam, error: r.error }, 'no se pudieron generar los iconos PWA');
                        }
                    })
                    .catch((err) => {
                        req.log?.error({ err, schoolId: schoolIdParam }, 'error inesperado generando iconos PWA');
                    });
            }

            return res.json(data);
        } catch (err: any) {
            req.log?.error({ err }, 'Error en PUT /schools/:id/branding');
            return res.status(500).json({ error: 'server_error' });
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/schools/:id/pwa-icons/regenerate   (solo super_admin)
//
// Regenera los iconos PNG del manifest a partir del logo YA cargado.
//
// Por que existe: los iconos se generan como efecto del PUT de branding, o sea
// solo cuando alguien vuelve a guardar la marca. Una escuela que ya tenia logo
// desde antes —o a la que se le prende el addon hoy— no tiene iconos y el
// manifest le devuelve la marca SportMaps hasta que su admin entre y reguarde el
// logo. Eso es pedirle al cliente que haga un paso que no entiende. Con esto se
// resuelve desde la consola de super admin.
//
// Tambien es la forma de probar la marca en una escuela de pruebas sin tener que
// loguearse como ella.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    '/:id/pwa-icons/regenerate',
    requireAuth,
    requireCsrfHeader,
    brandingLimiter,
    async (req: Request, res: Response) => {
        if (req.role !== 'super_admin') {
            return res.status(403).json({ error: 'forbidden', message: 'Solo super_admin.' });
        }

        const schoolId = req.params.id as string;

        try {
            const { data: school, error } = await supabase
                .from('schools')
                .select('id, logo_url, branding_settings')
                .eq('id', schoolId)
                .maybeSingle();

            if (error)  return res.status(500).json({ error: 'server_error', detail: error.message });
            if (!school) return res.status(404).json({ error: 'school_not_found' });
            if (!school.logo_url) {
                return res.status(400).json({
                    error: 'sin_logo',
                    message: 'La escuela todavía no cargó un logo. Sin logo no hay ícono que generar.',
                });
            }

            const bg = (school.branding_settings as any)?.primary_color ?? null;
            const r = await generarIconosPwa({
                schoolId,
                logoUrl: school.logo_url,
                backgroundColor: bg,
                actorId: req.user.id,
            });

            if (!r.ok) {
                req.log?.warn({ schoolId, error: r.error }, 'regeneracion de iconos PWA fallida');
                return res.status(422).json({ error: 'generacion_fallida', detail: r.error });
            }

            invalidatePwaManifestCache();
            invalidateBrandingCache(schoolId);

            return res.json({ ok: true, icon_192: r.icon192, icon_512: r.icon512 });
        } catch (err: any) {
            req.log?.error({ err, schoolId }, 'Error POST /schools/:id/pwa-icons/regenerate');
            return res.status(500).json({ error: 'server_error' });
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/schools/:id/branding/audit
//
// Devuelve el historial de cambios de branding (max 50). Util para super-admin
// o admin que quiere ver "quien cambio que y cuando". La RLS sobre
// branding_change_log ya filtra por membership.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
    '/:id/branding/audit',
    requireAuth,
    requireRole('owner', 'admin', 'school_admin', 'school'),
    async (req: Request, res: Response) => {
        const schoolIdParam = req.params.id;
        // Solo plataforma salta el match de escuela. 'owner'/'admin' son roles de
        // MEMBRESÍA: con ellos un dueño editaba/leía la marca de CUALQUIER escuela.
        const isPrivileged = req.role === 'super_admin' && await esAdminDePlataforma(req.user.id);
        if (!isPrivileged && req.schoolId !== schoolIdParam) {
            return res.status(403).json({ error: 'forbidden' });
        }

        try {
            const { data, error } = await supabase
                .from('branding_change_log')
                .select('id, changed_by, changed_at, before_state, after_state, ip_address, user_agent, change_source')
                .eq('school_id', schoolIdParam)
                .order('changed_at', { ascending: false })
                .limit(50);

            if (error) {
                req.log?.error({ err: error, schoolIdParam }, 'Error leyendo branding_change_log');
                return res.status(500).json({ error: 'server_error' });
            }

            return res.json({ ok: true, entries: data ?? [] });
        } catch (err: any) {
            req.log?.error({ err }, 'Error en GET /schools/:id/branding/audit');
            return res.status(500).json({ error: 'server_error' });
        }
    },
);

export default router;
