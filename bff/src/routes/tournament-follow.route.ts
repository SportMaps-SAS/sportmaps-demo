/**
 * Torneos en vivo — lo que hace única la experiencia (agente «vivo»). Se monta en el MISMO prefijo
 * que tournament-live.route (`/api/v1/tournament-live`), con rutas que no chocan con las suyas.
 *
 *   Público (sin login):
 *     GET  /public/:slug/calendar.ics[?team=<id>]          seguir sin cuenta (Agregar al calendario)
 *     GET  /public/:slug/challenge                         reto anti-spam para comentar sin cuenta
 *     GET  /public/:slug/social                            medios, noticias y comentarios del torneo
 *     GET  /public/:slug/player-stats                      ranking por jugadora (Aces/Puntos/Ataque/Bloqueos)
 *     GET  /public/:slug/matches/:matchId/social           { comments[], media[], mvp, player_stats }
 *     POST /public/:slug/matches/:matchId/comments         comentar (con cuenta, o nombre + reto)
 *     POST /public/:slug/comments                          comentar en el torneo
 *     POST /public/:slug/matches/:matchId/mvp-vote         un voto por dispositivo
 *   Con cuenta:
 *     GET  /me/today                                       «Hoy juega…» del Inicio V2
 *     GET|POST|DELETE /me/follows/:slug                    seguir torneo / equipo
 *   Organizador (school / school_admin, torneo de su escuela):
 *     GET  /school/:id/matches/:matchId/social             incluye comentarios ocultos
 *     PATCH /school/:id/comments/:commentId                { action: hide | show | delete }
 *     POST /school/:id/media/upload-url · POST /school/:id/posts · DELETE /school/:id/posts/:postId
 *     PUT  /school/:id/matches/:matchId/mvp                { member_id | null }
 *     GET  /school/:id/matches/:matchId/roster · POST|DELETE …/stats
 *   Anotador sin cuenta (token): roster, stats, fotos/video del partido.
 */
import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { supabase } from '../config/supabase';
import { requireAuth, requireRole, optionalAuth, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { authScorekeeper, hashToken, loadEvent, publicLive, LiveError, type LiveEvent } from '../services/tournament/tournament-live.service';
import { FollowError, follow, listMyFollows, myTodayMatches, resolvePublicEvent, unfollow } from '../services/tournament/tournament-follow.service';
import { buildIcs } from '../services/tournament/tournament-follow.notices';
import {
  SocialError, chooseMvp, createPost, eventPlayerStats, eventSocial, issueChallenge, loadSocialMatch, matchRoster, matchSocial,
  mediaUploadUrl, moderateComment, postComment, removePost, tagPoint, untagPoint, voteMvp,
} from '../services/tournament/tournament-social.service';

const router = Router();
const prod = process.env.NODE_ENV === 'production';

const limiter = (max: number, devMax: number, msg: string, key?: (req: Request) => string) => rateLimit({
  windowMs: 60 * 1000, max: prod ? max : devMax, standardHeaders: true, legacyHeaders: false,
  ...(key ? { keyGenerator: key } : {}),
  message: { error: msg, code: 'rate_limited' },
});
// Lecturas públicas: alto a propósito (wifi compartida del coliseo); la base la cuida la caché de 10 s.
const readLimiter = limiter(1200, 20000, 'Demasiadas peticiones. Intenta de nuevo en un minuto.');
const commentLimiter = limiter(6, 100, 'Vas muy rápido. Espera un minuto para comentar otra vez.');
const voteLimiter = limiter(30, 300, 'Demasiados votos desde esta red. Espera un minuto.');
const meLimiter = limiter(120, 2000, 'Demasiadas peticiones. Espera un momento.');
const orgLimiter = limiter(300, 5000, 'Demasiadas peticiones. Espera un momento.');
const scorerLimiter = limiter(300, 5000, 'Demasiadas acciones seguidas. Espera un momento.',
  (req) => `scorer-social-${hashToken(String(req.params.token ?? '')).slice(0, 16)}-${ipKeyGenerator(req.ip ?? '')}`);

function fail(res: Response, req: Request, err: unknown) {
  if (err instanceof SocialError || err instanceof FollowError || err instanceof LiveError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  (req as any).log?.error({ err }, 'Error inesperado en torneos (social/seguir)');
  return res.status(500).json({ error: 'Error interno del servidor', code: 'interno' });
}

async function publicEventOr404(slug: string) {
  const ev = await resolvePublicEvent(slug);
  if (!ev) throw new SocialError(404, 'torneo_no_encontrado', 'Torneo no encontrado');
  return ev;
}

async function ownedEvent(req: AuthenticatedRequest, eventId: string): Promise<LiveEvent> {
  const schoolId = req.schoolId;
  if (!schoolId) throw new SocialError(403, 'sin_escuela', 'No se pudo resolver la escuela del usuario.');
  const ev = await loadEvent(eventId);
  if (!ev || ev.school_id !== schoolId) throw new SocialError(404, 'torneo_no_encontrado', 'Torneo no encontrado');
  return ev;
}

const org = [orgLimiter, requireAuth, requireRole('school', 'school_admin')] as const;

/** Nombre visible de quien comenta con cuenta: nombre de pila + inicial. */
async function displayName(userId: string): Promise<string | null> {
  const { data } = await supabase.from('profiles').select('full_name').eq('id', userId).maybeSingle();
  const parts = String((data as any)?.full_name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.` : parts[0];
}

// ── Público ──────────────────────────────────────────────────────────────────

router.get('/public/:slug/calendar.ics', readLimiter, async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug);
    const ev = await publicEventOr404(slug);
    const live = await publicLive(slug); // misma caché de 5 s que la página pública: cero consultas extra
    if (!live) throw new SocialError(404, 'torneo_no_encontrado', 'Torneo no encontrado');
    const team = req.query.team ? String(req.query.team) : null;
    const origin = String(process.env.FRONTEND_URL || 'https://app.sportmaps.co');
    const ics = buildIcs({ id: ev.id, title: ev.title, slug: ev.slug }, live.payload.matches, { teamId: team, origin });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.ics"`);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(ics);
  } catch (e) { return fail(res, req, e); }
});

router.get('/public/:slug/challenge', readLimiter, async (req: Request, res: Response) => {
  try { await publicEventOr404(String(req.params.slug)); res.setHeader('Cache-Control', 'no-store'); return res.json(issueChallenge()); }
  catch (e) { return fail(res, req, e); }
});

router.get('/public/:slug/social', readLimiter, async (req: Request, res: Response) => {
  try { res.setHeader('Cache-Control', 'public, max-age=10'); return res.json(await eventSocial(await publicEventOr404(String(req.params.slug)))); }
  catch (e) { return fail(res, req, e); }
});

router.get('/public/:slug/player-stats', readLimiter, async (req: Request, res: Response) => {
  try {
    const ev = await publicEventOr404(String(req.params.slug));
    res.setHeader('Cache-Control', 'public, max-age=10');
    return res.json({ player_stats: await eventPlayerStats(ev.id) });
  } catch (e) { return fail(res, req, e); }
});

router.get('/public/:slug/matches/:matchId/social', readLimiter, async (req: Request, res: Response) => {
  try {
    const ev = await publicEventOr404(String(req.params.slug));
    res.setHeader('Cache-Control', 'public, max-age=10');
    return res.json(await matchSocial(ev, String(req.params.matchId)));
  } catch (e) { return fail(res, req, e); }
});

const commentHandler = (withMatch: boolean) => async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await publicEventOr404(String(req.params.slug));
    const userId = req.user?.id ?? null;
    const out = await postComment(ev, withMatch ? String(req.params.matchId) : null, req.body ?? {}, {
      userId, userName: userId ? await displayName(userId) : null, ip: req.ip ?? '',
    });
    return res.status(201).json(out);
  } catch (e) { return fail(res, req, e); }
};
router.post('/public/:slug/matches/:matchId/comments', commentLimiter, optionalAuth, commentHandler(true));
router.post('/public/:slug/comments', commentLimiter, optionalAuth, commentHandler(false));

router.post('/public/:slug/matches/:matchId/mvp-vote', voteLimiter, async (req: Request, res: Response) => {
  try {
    const ev = await publicEventOr404(String(req.params.slug));
    const m = await loadSocialMatch(ev.id, String(req.params.matchId));
    return res.status(201).json(await voteMvp(m, req.body?.member_id, req.body?.device_id, req.ip ?? ''));
  } catch (e) { return fail(res, req, e); }
});

// ── Con cuenta ───────────────────────────────────────────────────────────────

router.get('/me/today', meLimiter, requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json({ matches: await myTodayMatches(req.user!.id) }); } catch (e) { return fail(res, req, e); }
});

router.get('/me/follows/:slug', meLimiter, requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await publicEventOr404(String(req.params.slug));
    return res.json({ follows: await listMyFollows(req.user!.id, ev.id) });
  } catch (e) { return fail(res, req, e); }
});

router.post('/me/follows/:slug', meLimiter, requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await publicEventOr404(String(req.params.slug));
    const team = req.body?.team_id ? String(req.body.team_id) : null;
    return res.status(201).json(await follow(req.user!.id, ev, team));
  } catch (e) { return fail(res, req, e); }
});

router.delete('/me/follows/:slug', meLimiter, requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await publicEventOr404(String(req.params.slug));
    return res.json(await unfollow(req.user!.id, ev.id, req.query.team_id ? String(req.query.team_id) : null));
  } catch (e) { return fail(res, req, e); }
});

// ── Organizador ──────────────────────────────────────────────────────────────

router.get('/school/:id/matches/:matchId/social', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    return res.json(await matchSocial({ ...ev, slug: ev.slug } as any, String(req.params.matchId), { includeHidden: true }));
  } catch (e) { return fail(res, req, e); }
});

router.patch('/school/:id/comments/:commentId', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    const action = String(req.body?.action ?? '');
    if (!['hide', 'show', 'delete'].includes(action)) throw new SocialError(400, 'accion_invalida', 'Acción inválida: hide, show o delete.');
    return res.json(await moderateComment(ev.id, String(req.params.commentId), action as any, req.user!.id));
  } catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/media/upload-url', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { const ev = await ownedEvent(req, String(req.params.id)); return res.json(await mediaUploadUrl(ev.id, req.body?.mime)); }
  catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/posts', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { const ev = await ownedEvent(req, String(req.params.id)); return res.status(201).json(await createPost(ev.id, req.body ?? {}, { userId: req.user!.id })); }
  catch (e) { return fail(res, req, e); }
});

router.delete('/school/:id/posts/:postId', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { const ev = await ownedEvent(req, String(req.params.id)); return res.json(await removePost(ev.id, String(req.params.postId))); }
  catch (e) { return fail(res, req, e); }
});

router.put('/school/:id/matches/:matchId/mvp', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    const m = await loadSocialMatch(ev.id, String(req.params.matchId));
    return res.json(await chooseMvp(m, req.body?.member_id ?? null, req.user!.id));
  } catch (e) { return fail(res, req, e); }
});

router.get('/school/:id/matches/:matchId/roster', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    return res.json({ roster: await matchRoster(await loadSocialMatch(ev.id, String(req.params.matchId))) });
  } catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/matches/:matchId/stats', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    return res.status(201).json(await tagPoint(await loadSocialMatch(ev.id, String(req.params.matchId)), req.body ?? {}));
  } catch (e) { return fail(res, req, e); }
});

router.delete('/school/:id/matches/:matchId/stats/:pointIndex', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    return res.json(await untagPoint(await loadSocialMatch(ev.id, String(req.params.matchId)), Number(req.params.pointIndex)));
  } catch (e) { return fail(res, req, e); }
});

// ── Anotador sin cuenta ──────────────────────────────────────────────────────

async function scorerMatch(req: Request) {
  const sk = await authScorekeeper(String(req.params.token));
  const m = await loadSocialMatch(sk.event.id, String(req.params.matchId));
  return { sk, m };
}

router.get('/scorer/:token/matches/:matchId/roster', scorerLimiter, async (req: Request, res: Response) => {
  try { const { m } = await scorerMatch(req); return res.json({ roster: await matchRoster(m) }); } catch (e) { return fail(res, req, e); }
});

router.post('/scorer/:token/matches/:matchId/stats', scorerLimiter, async (req: Request, res: Response) => {
  try { const { m } = await scorerMatch(req); return res.status(201).json(await tagPoint(m, req.body ?? {})); } catch (e) { return fail(res, req, e); }
});

router.delete('/scorer/:token/matches/:matchId/stats/:pointIndex', scorerLimiter, async (req: Request, res: Response) => {
  try { const { m } = await scorerMatch(req); return res.json(await untagPoint(m, Number(req.params.pointIndex))); } catch (e) { return fail(res, req, e); }
});

router.post('/scorer/:token/media/upload-url', scorerLimiter, async (req: Request, res: Response) => {
  try { const sk = await authScorekeeper(String(req.params.token)); return res.json(await mediaUploadUrl(sk.event.id, req.body?.mime)); }
  catch (e) { return fail(res, req, e); }
});

router.post('/scorer/:token/posts', scorerLimiter, async (req: Request, res: Response) => {
  try {
    const sk = await authScorekeeper(String(req.params.token));
    return res.status(201).json(await createPost(sk.event.id, req.body ?? {}, { scorekeeperId: sk.id }));
  } catch (e) { return fail(res, req, e); }
});

export default router;
