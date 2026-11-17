// bff/src/routes/usage.routes.ts
//
// Uso por pantalla y botón, agregado por usuario y día.
//
//   POST /api/v1/usage   → suma contadores al día del caller (ver ui_usage_daily)
//
// El cliente acumula contadores y manda UNO cada ~90 s mientras hay actividad (y al
// ocultar la pestaña). La escuela y el rol NO se aceptan del cliente: la RPC los
// resuelve contra school_members. Nunca falla de cara al usuario: es telemetría.

import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { requireAuth } from '../middlewares/authMiddleware';
import { requireCsrfHeader } from '../middlewares/csrfHeader';

const router = Router();

// 10/min/usuario: el cliente manda ~1 cada 90 s; esto solo frena un bucle.
const usageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 10 : 200,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `usage-${(req as any).user?.id || ipKeyGenerator(req.ip ?? '')}`,
});

// Claves: prefijo `sess` | `v:` | `c:` | `a:`; solo caracteres de ruta/etiqueta, sin
// espacios arbitrarios ni nada que parezca un correo.
const KEY_RE = /^(sess|[vca]:[A-Za-z0-9_\-./:|áéíóúñÁÉÍÓÚÑ ]{1,160})$/;

const UsageSchema = z.object({
    display_mode: z.enum(['browser', 'standalone', 'native']),
    app_version: z.string().max(64).optional(),
    counters: z
        .record(z.string().regex(KEY_RE), z.number().int().min(0).max(10000))
        .refine((c) => Object.keys(c).length > 0 && Object.keys(c).length <= 200, {
            message: 'counters debe tener entre 1 y 200 claves',
        }),
});

/** Cuentas internas (QA/demo): se marcan para poder excluirlas al medir. */
function esCuentaInterna(email: string | undefined): boolean {
    const e = (email ?? '').toLowerCase();
    return (
        e.endsWith('@demo.sportmaps.co') ||
        e.endsWith('@sportmaps.test') ||
        e.endsWith('.demo') ||
        e.startsWith('spoortmaps+') ||
        e.startsWith('sportmaps+')
    );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/', requireAuth, requireCsrfHeader, usageLimiter, async (req: Request, res: Response) => {
    const parsed = UsageSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_payload' });
    }
    const body = parsed.data;
    const hint = req.headers['x-school-id'];
    const schoolHint = typeof hint === 'string' && UUID_RE.test(hint) ? hint : null;

    try {
        const { error } = await supabase.rpc('track_ui_usage', {
            p_user_id: req.user.id,
            p_school_hint: schoolHint,
            p_mode: body.display_mode,
            p_version: body.app_version ?? null,
            p_internal: esCuentaInterna(req.user.email),
            p_counters: body.counters,
        });
        if (error) {
            req.log?.warn({ err: error }, 'track_ui_usage falló');
            return res.status(202).json({ ok: false });
        }
        return res.json({ ok: true });
    } catch (err) {
        req.log?.warn({ err }, 'Error POST /usage');
        return res.status(202).json({ ok: false });
    }
});

export default router;
