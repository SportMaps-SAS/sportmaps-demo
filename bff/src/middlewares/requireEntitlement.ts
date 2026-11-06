// requireEntitlement(key) — ¿la escuela de la request tiene el addon/entitlement `key`?
// Usa la RPC has_entitlement(p_school_id, p_key), igual que invoicing.routes.ts
// y payment-providers.routes.ts.
//
// Modo por env GATING_MODE (se lee en cada request, así se puede cambiar sin tocar código):
//   audit   (default) — nunca bloquea; si falta el entitlement, loguea warn.
//   soft              — no bloquea, pero loguea y responde el header X-Entitlement-Missing: <key>.
//   enforce           — 403 si falta. Si la RPC falla: 503 (fail-closed, como payment-providers).
//
// Va DESPUÉS de requireAuth (necesita req.schoolId). Todavía no está enrutado.
import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';

export type GatingMode = 'audit' | 'soft' | 'enforce';

export function resolveGatingMode(raw: string | undefined = process.env.GATING_MODE): GatingMode {
    const v = (raw || '').trim().toLowerCase();
    return v === 'soft' || v === 'enforce' ? v : 'audit';
}

export function requireEntitlement(key: string) {
    return async (req: Request, res: Response, next: NextFunction) => {
        const mode = resolveGatingMode();
        try {
            const schoolId = req.schoolId;
            if (!schoolId) {
                if (mode === 'enforce') {
                    return res.status(400).json({ error: 'No se pudo determinar la escuela.', reason: 'school_required' });
                }
                req.log?.warn({ key, mode }, 'requireEntitlement: request sin schoolId');
                return next();
            }

            const { data, error } = await supabase.rpc('has_entitlement', { p_school_id: schoolId, p_key: key });

            if (error) {
                req.log?.error({ err: error, key, schoolId, mode }, 'requireEntitlement: has_entitlement falló');
                if (mode === 'enforce') {
                    return res.status(503).json({ error: 'No se pudo verificar el plan de la escuela. Intenta de nuevo.', reason: 'entitlement_check_failed' });
                }
                return next();
            }

            if (data === true) return next();

            req.log?.warn({ key, schoolId, mode, path: req.originalUrl }, 'requireEntitlement: la escuela no tiene el entitlement');
            if (mode === 'enforce') {
                return res.status(403).json({
                    error: 'Tu plan no incluye esta función.',
                    reason: 'entitlement_required',
                    entitlement: key,
                });
            }
            if (mode === 'soft') res.setHeader('X-Entitlement-Missing', key);
            return next();
        } catch (err) {
            next(err);
        }
    };
}
