/**
 * «Uso de IA de pizarra» — super admin ÚNICAMENTE (spec pizarra §6, 2026-10-14).
 *
 *   GET  /api/v1/admin/tactical-ai/usage?period=YYYY-MM   por escuela y coach, por deporte
 *   POST /api/v1/admin/tactical-ai/grant                  «Dar más cupo» (USD, a un coach o a la escuela)
 *
 * Gate estricto (req.role === 'super_admin'): requireRole('super_admin') deja
 * pasar a 'admin' y 'owner' por PRIVILEGED_ROLES (ver admin-support.routes.ts).
 * El grant va con la sesión del super admin (userClient): la RPC vuelve a
 * validar is_super_admin() y guarda quién lo dio.
 */
import { Router, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';
import { requireAuth, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { userClient } from '../utils/userClient';
import { buildUsageReport, currentPeriodBogota, PERIOD_RE } from '../services/tactical-ai-report';
import { isMissingRpc } from '../services/tactical-ai.service';

const router = Router();
router.use(requireAuth);

function requireSuperAdminStrict(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (req.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acceso denegado. Este panel es exclusivo de super_admin.' });
  }
  next();
}
router.use(requireSuperAdminStrict);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RUNS = 20_000;

async function namesOf(table: 'schools' | 'profiles', col: 'name' | 'full_name', ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from(table as any).select(`id, ${col}`).in('id', ids.slice(i, i + 200));
    for (const r of (data ?? []) as any[]) out[r.id] = String(r[col] ?? '');
  }
  return out;
}

/**
 * Cupo ampliado temporal VIGENTE por escuela (20261027110401). Si la tabla
 * todavía no existe (migración sin aplicar) no hay multiplicador: {}.
 * Si hay dos vigentes manda el mayor, igual que tactical_ai_quota_multiplier().
 */
async function activeQuotaMultipliers(schoolIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!schoolIds.length) return out;
  const nowIso = new Date().toISOString();
  for (let i = 0; i < schoolIds.length; i += 200) {
    const { data, error } = await supabase.from('tactical_ai_quota_overrides' as any)
      .select('school_id, multiplier')
      .in('school_id', schoolIds.slice(i, i + 200))
      .lte('starts_at', nowIso)
      .gt('expires_at', nowIso);
    if (error) return out;
    for (const r of (data ?? []) as any[]) {
      const m = Number(r.multiplier);
      if (Number.isFinite(m) && m > (out[r.school_id] ?? 0)) out[r.school_id] = m;
    }
  }
  return out;
}

// GET /api/v1/admin/tactical-ai/usage?period=YYYY-MM
router.get('/usage', async (req: AuthenticatedRequest, res: Response) => {
  const period = typeof req.query.period === 'string' && PERIOD_RE.test(req.query.period) ? req.query.period : currentPeriodBogota();
  try {
    const [u, s, r] = await Promise.all([
      supabase.from('tactical_ai_user_usage' as any).select('*').eq('period', period),
      supabase.from('tactical_ai_school_usage' as any).select('*').eq('period', period),
      supabase.from('tactical_ai_runs' as any)
        .select('school_id, user_id, sport, status, cost_micro_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens')
        .eq('period', period)
        .in('status', ['settled', 'cache_hit'])
        .limit(MAX_RUNS),
    ]);
    const err = u.error ?? s.error ?? r.error;
    if (err) {
      if (isMissingRpc(err) || String((err as any).code) === '42P01' || /does not exist|schema cache/i.test(String((err as any).message))) {
        return res.status(503).json({ error: 'El cupo de IA por entrenador todavía no está habilitado (migración 20261014155445 sin aplicar).' });
      }
      throw err;
    }
    const users = (u.data ?? []) as any[];
    const schools = (s.data ?? []) as any[];
    const schoolIds = [...new Set([...schools.map((x) => x.school_id), ...users.map((x) => x.school_id)])];
    const userIds = [...new Set(users.map((x) => x.user_id))];
    const [schoolNames, userNames] = await Promise.all([
      namesOf('schools', 'name', schoolIds),
      namesOf('profiles', 'full_name', userIds),
    ]);
    const multipliers = period === currentPeriodBogota() ? await activeQuotaMultipliers(schoolIds) : {};
    const report = buildUsageReport({ period, users, schools, runs: (r.data ?? []) as any[], schoolNames, userNames, multipliers });
    return res.json({ ...report, truncated_runs: (r.data ?? []).length >= MAX_RUNS });
  } catch (err: any) {
    req.log?.error({ err }, 'admin/tactical-ai/usage');
    return res.status(500).json({ error: 'No se pudo armar el uso de IA.' });
  }
});

// POST /api/v1/admin/tactical-ai/grant  { school_id, user_id?, amount_usd, note? }
router.post('/grant', async (req: AuthenticatedRequest, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const schoolId = String(b.school_id ?? '');
  const userId = b.user_id == null || b.user_id === '' ? null : String(b.user_id);
  const amount = Number(b.amount_usd);
  const note = typeof b.note === 'string' ? b.note.slice(0, 300) : null;
  if (!UUID.test(schoolId)) return res.status(422).json({ error: 'school_id inválido.' });
  if (userId !== null && !UUID.test(userId)) return res.status(422).json({ error: 'user_id inválido.' });
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 1000) {
    return res.status(422).json({ error: 'El monto debe estar entre US$ 0,01 y US$ 1.000.' });
  }
  try {
    const { data, error } = await userClient(req).rpc('grant_tactical_ai_credits', {
      p_school_id: schoolId, p_amount_usd: Math.round(amount * 100) / 100, p_user_id: userId, p_note: note,
    } as any);
    if (error) {
      if (isMissingRpc(error)) return res.status(503).json({ error: 'El cupo de IA por entrenador todavía no está habilitado.' });
      if (String((error as any).code) === '42501') return res.status(403).json({ error: 'Solo un super admin puede dar cupo.' });
      if (String((error as any).code) === '22023') return res.status(422).json({ error: (error as any).message });
      throw error;
    }
    req.log?.info({ actor: req.user.id, schoolId, userId, amount }, 'admin/tactical-ai/grant');
    return res.json(data);
  } catch (err: any) {
    req.log?.error({ err }, 'admin/tactical-ai/grant');
    return res.status(500).json({ error: 'No se pudo dar el cupo.' });
  }
});

export default router;
