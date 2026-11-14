/**
 * IA de jugadas — M3 de docs/specs/pizarra-multideporte-3d-ia.md (D6, §6).
 *
 *   POST /api/v1/school/tactical/analyze      analiza la jugada (cupo + caché)
 *   GET  /api/v1/school/tactical/ai-balance   «Te queda el 60 % de tu IA este mes»
 *                                             (?sport= para el «Quiero más»)
 *   POST /api/v1/school/tactical/ai-feedback  «Útil / No útil» de una sugerencia y
 *                                             si terminó en «Guardar como nueva jugada»
 *
 * Cupo por costo real por usuario y techo por escuela (§6, decisión
 * 2026-10-14, migración 20261014155445). Agotado → 402 needs_more con el
 * mensaje de WhatsApp para el comercial (request_more_message).
 *
 * Mismo gate que editar el tablero (football.ts / exercises.ts):
 * TACTICAL_EDIT_ROLES y el equipo debe ser de la escuela activa. Padres,
 * atletas y otra escuela → 403. La IA nunca recibe nombres ni ids de atletas
 * (tacticalAiShapes.anonymizePlay) y su respuesta se valida antes de salir.
 * Rate limit por USUARIO (además del generalLimiter del montaje).
 */
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { supabase } from '../../config/supabase';
import { requireAuth, requireRole, AuthenticatedRequest } from '../../middlewares/authMiddleware';
import { isAiSport, parseAnalyzeInput } from './tacticalAiShapes';
import { analyzeTacticalPlay, getAiBalance, requestMoreMessage } from '../../services/tactical-ai.service';
import { parseFeedbackInput, recordSuggestionFeedback } from '../../services/tactical-ai-feedback';
import { userClient } from '../../utils/userClient';

const router = Router();

/** Espejo de TACTICAL_EDIT_ROLES de football.ts / exercises.ts. */
const TACTICAL_EDIT_ROLES = ['owner', 'super_admin', 'coach'] as const;

export const TACTICAL_AI_PER_MINUTE = Number(process.env.TACTICAL_AI_PER_MINUTE) || 6;

const perUserLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: TACTICAL_AI_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  // Va DESPUÉS de requireAuth: la llave es el usuario, no la IP (detrás de
  // Cloudflare la IP es la del borde).
  keyGenerator: (req: any) => `tactical-ai-${req.user?.id ?? 'anon'}`,
  validate: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Vas muy rápido: espera un minuto antes de analizar otra jugada.' });
  },
});

async function teamBelongsToSchool(teamId: string, schoolId: string): Promise<boolean> {
  const { data, error } = await supabase.from('teams').select('id, school_id').eq('id', teamId).maybeSingle();
  if (error) throw error;
  return !!data && (data as any).school_id === schoolId;
}

// POST /api/v1/school/tactical/analyze
// Body: { team_id, sport, frames, labels?: { [playerKey]: puesto }, colors?: { own, rival } }
router.post(
  '/tactical/analyze',
  requireAuth,
  requireRole(...TACTICAL_EDIT_ROLES),
  perUserLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { errors, input } = parseAnalyzeInput(req.body);
      if (!input) return res.status(422).json({ error: 'Jugada inválida.', details: errors.slice(0, 10) });
      if (!(await teamBelongsToSchool(input.teamId, req.schoolId))) {
        return res.status(403).json({ error: 'Ese equipo no es de tu escuela.' });
      }
      const out = await analyzeTacticalPlay({ schoolId: req.schoolId, userId: req.user.id, input, log: req.log as any });
      if (out.status === 402) {
        const request_more_message = await requestMoreMessage({
          schoolId: req.schoolId, userId: req.user.id, sport: input.sport, balance: out.body.balance,
        });
        return res.status(402).json({ ...out.body, request_more_message });
      }
      return res.status(out.status).json(out.body);
    } catch (err: any) {
      req.log?.error({ err }, 'school/tactical/analyze unhandled error');
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }
  },
);

// GET /api/v1/school/tactical/ai-balance
router.get(
  '/tactical/ai-balance',
  requireAuth,
  requireRole(...TACTICAL_EDIT_ROLES),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const balance = await getAiBalance(req.schoolId, req.user.id);
      if (!balance) return res.status(503).json({ error: 'El análisis con IA todavía no está habilitado en esta cuenta.' });
      if (!balance.exhausted) return res.json(balance);
      const sport = isAiSport(req.query.sport) ? req.query.sport : null;
      const request_more_message = await requestMoreMessage({ schoolId: req.schoolId, userId: req.user.id, sport, balance });
      return res.json({ ...balance, request_more_message });
    } catch (err: any) {
      req.log?.error({ err }, 'school/tactical/ai-balance unhandled error');
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }
  },
);

// POST /api/v1/school/tactical/ai-feedback
// Body: { analysis_ref, sport, kind: 'contraataque'|'variante', index, verdict?: 'util'|'no_util'|null, saved?: true }
router.post(
  '/tactical/ai-feedback',
  requireAuth,
  requireRole(...TACTICAL_EDIT_ROLES),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { errors, input } = parseFeedbackInput(req.body);
      if (!input) return res.status(422).json({ error: 'Valoración inválida.', details: errors });
      const out = await recordSuggestionFeedback({
        service: supabase, asUser: userClient(req), schoolId: req.schoolId, userId: req.user.id, input, log: req.log as any,
      });
      return res.status(out.status).json(out.body);
    } catch (err: any) {
      req.log?.error({ err }, 'school/tactical/ai-feedback unhandled error');
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }
  },
);

export default router;
