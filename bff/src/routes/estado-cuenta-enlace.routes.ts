/**
 * estado-cuenta-enlace.routes — el enlace del estado de cuenta de una familia.
 *
 *   PÚBLICA (SIN login, el token es la credencial) — /api/v1/public/estado-cuenta
 *     GET /:token   → lo que ve la familia en https://app.sportmaps.co/e/:token
 *
 *   ADMINISTRACIÓN — /api/v1/estado-cuenta  (requireAuth + rol de administración)
 *     POST /enviar  → «Enviar al acudiente». `aplicar: false` (por defecto) solo
 *                     simula: dice a quién llegaría y por qué canal, sin escribir nada.
 *
 * Plan: docs/specs/estado-de-cuenta-envio-a-familias.md.
 *
 * Respuestas de la ruta pública (iguales a /api/v1/public/cobro):
 *   404 'no_existe'  → token mal formado o inexistente (indistinguibles a propósito)
 *   410 'vencido' / 'revocado' → el enlace existió pero ya no abre
 * Nunca se cachea (es información de un menor) ni se indexa.
 */

import express, { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middlewares/authMiddleware';
import {
    enviarEstadoAFamilia, TOKEN_ESTADO_RE, vistaPublicaDeEnlace, type MotivoNoEnvio,
} from '../services/estado-cuenta-enlace.service';
import { UrlNoPublicaError } from '../utils/url-publica-familias';

// ─────────────────────────────────────────────────────────────────────────────
// Pública
// ─────────────────────────────────────────────────────────────────────────────

export const estadoCuentaPublicoRouter = Router();

// Varias familias comparten IP en el wifi de la escuela: 120 lecturas / 15 min por IP,
// y 40 por token: abrir el mismo enlace más de eso es alguien martillando, no una familia.
const lecturaIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `estado-get-ip-${ipKeyGenerator(req.ip ?? '')}`,
    message: { error: 'Demasiadas consultas. Intenta de nuevo en unos minutos.', code: 'rate_limited' },
});
const lecturaTokenLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `estado-get-tk-${String(req.params?.token ?? '').slice(0, 32)}`,
    message: { error: 'Demasiadas consultas. Intenta de nuevo en unos minutos.', code: 'rate_limited' },
});

estadoCuentaPublicoRouter.get('/:token', lecturaIpLimiter, lecturaTokenLimiter, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const token = String(req.params.token ?? '');
    if (!TOKEN_ESTADO_RE.test(token)) return res.status(404).json({ error: 'no_existe' });
    try {
        const r = await vistaPublicaDeEnlace(token);
        if (r.estado !== 'vigente') {
            return r.estado === 'no_existe'
                ? res.status(404).json({ error: 'no_existe' })
                : res.status(410).json({ error: r.estado });
        }
        return res.json(r.vista);
    } catch (e: any) {
        req.log?.error({ err: e }, 'estado-cuenta público falló');
        return res.status(500).json({ error: 'error_interno' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Administración
// ─────────────────────────────────────────────────────────────────────────────

export const estadoCuentaAdminRouter = Router();
estadoCuentaAdminRouter.use(express.json({ limit: '4kb' }));

// Enviar un correo a una familia: 30 por usuario y escuela cada 10 min alcanza para
// un barrido a mano; más que eso es un script. (El envío masivo es la fase 4.)
const enviarLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `estado-enviar-${req.user?.id ?? ''}-${req.schoolId ?? ''}`,
    message: { error: 'Demasiados envíos seguidos. Espera unos minutos.', code: 'rate_limited' },
});

const EnviarSchema = z.object({
    atleta: z.object({
        tipo: z.enum(['hijo', 'adulto', 'ficha']),
        id: z.string().uuid(),
    }),
    /** false/ausente = simulación. Solo `true` manda de verdad. */
    aplicar: z.boolean().optional(),
    reenviar: z.boolean().optional(),
}).strict();

const ESTADO_HTTP: Record<MotivoNoEnvio, number> = {
    no_pertenece: 404, sin_correo: 422, fuera_de_horario: 409, ya_enviado_hoy: 409,
    contactada_hoy: 409, no_disponible: 503, fallo_envio: 502,
};

// requireRole('school_admin'): pasan owner, admin y super_admin (privilegiados) y school_admin.
// El coach, el contador y los demás roles quedan fuera. La escuela sale de la membresía
// validada por requireAuth (x-school-id), nunca del cuerpo.
estadoCuentaAdminRouter.post('/enviar', requireAuth, requireRole('school_admin'), enviarLimiter, async (req: Request, res: Response) => {
    const parsed = EnviarSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'datos_invalidos', detail: parsed.error.issues.map((i) => i.path.join('.')).join(', ') });
    if (!req.schoolId) return res.status(400).json({ error: 'Falta la escuela (x-school-id).' });
    try {
        const r = await enviarEstadoAFamilia({
            schoolId: req.schoolId,
            atleta: parsed.data.atleta,
            creadoPor: req.user.id,
            aplicar: parsed.data.aplicar === true,
            reenviar: parsed.data.reenviar === true,
        });
        if (r.ok) return res.json(r);
        return res.status(ESTADO_HTTP[r.motivo]).json(r);
    } catch (e: any) {
        if (e instanceof UrlNoPublicaError) {
            req.log?.error({ err: e }, 'URL de familias no pública: no se envía');
            return res.status(503).json({ ok: false, motivo: 'no_disponible', mensaje: 'El envío no está disponible en este ambiente.' });
        }
        req.log?.error({ err: e }, 'enviar estado de cuenta falló');
        return res.status(500).json({ error: 'error_interno' });
    }
});
