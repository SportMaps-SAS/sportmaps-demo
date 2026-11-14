/**
 * Torneos en vivo — /api/v1/tournament-live
 *   · Organizador (school / school_admin): ajustes, calendario por formato, anotar, anotadores sin cuenta, log,
 *     equipos rivales externos, patrocinadores y hora/cancha a mano.
 *   · Anotador sin cuenta: token en la ruta (solo el hash vive en la base).
 *   · Público: GET /public/:slug/live (sin login, caché de 5 s, solo equipos y marcadores).
 * Spec: docs/specs/torneos-en-vivo-multideporte-plan.md
 */
import { Router, Response, Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { supabase } from '../config/supabase';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middlewares/authMiddleware';
import {
  Actor, LiveError, authScorekeeper, buildCategoryStandings, createScorekeeper, generateCategoryFixtures, getConfig, hashToken,
  listScorekeepers, loadEvent, loadMatches, patchConfig, performMatchAction, preloadMatchAction, publicLive, revokeScorekeeper,
  scorerMatches, takeMatch, toMatchDto, touchScorekeeper, LiveEvent,
  addExternalTeams, deleteExternalTeam, listTeams, updateTeam,
  createSponsor, deleteSponsor, listSponsors, updateSponsor, rescheduleMatch,
} from '../services/tournament/tournament-live.service';
import { resolveConfig } from '../services/tournament/scoring.shared';
import { assertTournamentOrganizer } from '../services/tournament/tournament-access';
import {
  addFromSchool, addPlayers, cardsFor, deletePlayer, getCardConfig, getPlayerForm, listPlayers, reissueCard,
  saveCardConfig, savePlayerForm, schoolAthletes, updatePlayer, validateCardPublic,
} from '../services/tournament/tournament-players.service';
import {
  authInvite, createInvite, inviteAddPlayers, inviteHome, invitePaymentProofUrl, inviteRemovePlayer, inviteSubmit,
  inviteUpdateTeam, inviteUploadUrl, listInvites, markInvitePaid, revokeInvite, signupPrefill,
} from '../services/tournament/tournament-invites.service';
import { matchSheetRoster, rosterFromPhoto } from '../services/tournament/tournament-players.service';

const router = Router();
const prod = process.env.NODE_ENV === 'production';

// Varias familias comparten la wifi del coliseo: el tope por IP es alto a propósito; la carga real
// la contiene la caché de 5 s del BFF (una consulta a la base cada 5 s por torneo).
const publicLimiter = rateLimit({
  windowMs: 60 * 1000, max: prod ? 3000 : 20000, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Intenta de nuevo en un minuto.', code: 'rate_limited' },
});
const scorerLimiter = rateLimit({
  windowMs: 60 * 1000, max: prod ? 600 : 5000, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `scorer-${hashToken(String(req.params.token ?? '')).slice(0, 16)}-${ipKeyGenerator(req.ip ?? '')}`,
  message: { error: 'Demasiadas acciones seguidas. Espera un momento.', code: 'rate_limited' },
});
// Link del delegado: un equipo lo usa desde uno o dos celulares; el tope por token+IP corta abusos.
const inviteLimiter = rateLimit({
  windowMs: 60 * 1000, max: prod ? 120 : 5000, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `invite-${hashToken(String(req.params.token ?? '')).slice(0, 16)}-${ipKeyGenerator(req.ip ?? '')}`,
  message: { error: 'Demasiadas peticiones. Espera un momento.', code: 'rate_limited' },
});
// La foto de la planilla gasta OCR (proveedor externo): pocas por hora.
const ocrLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: prod ? 15 : 500, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `ocr-${String(req.params.token ?? req.params.id ?? '').slice(0, 40)}-${ipKeyGenerator(req.ip ?? '')}`,
  message: { error: 'Ya leímos varias planillas. Intenta de nuevo en una hora o pega la lista.', code: 'rate_limited' },
});
const orgLimiter = rateLimit({
  windowMs: 60 * 1000, max: prod ? 600 : 5000, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Espera un momento.', code: 'rate_limited' },
});

function fail(res: Response, req: Request, err: unknown) {
  if (err instanceof LiveError) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra ?? {}) });
  }
  (req as any).log?.error({ err }, 'Error inesperado en torneos en vivo');
  return res.status(500).json({ error: 'Error interno del servidor', code: 'interno' });
}

/** El torneo debe ser del organizador (un solo helper: services/tournament/tournament-access.ts). */
const ownedEvent = (req: AuthenticatedRequest, eventId: string): Promise<LiveEvent> => assertTournamentOrganizer(req, eventId);

const org = [orgLimiter, requireAuth, requireRole('school', 'school_admin')] as const;

const userActor = (req: AuthenticatedRequest): Actor => ({ type: 'user', id: req.user!.id, label: 'Administración' });

const actionInput = (req: Request) => ({
  action: req.body?.action, client_action_id: req.body?.client_action_id ?? null,
  expected_version: Number.isInteger(req.body?.expected_version) ? req.body.expected_version : null,
});

// ── Organizador ──────────────────────────────────────────────────────────────

router.get('/school/:id/config', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await getConfig(await ownedEvent(req, String(req.params.id)))); } catch (e) { return fail(res, req, e); }
});

router.patch('/school/:id/config', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await patchConfig(await ownedEvent(req, String(req.params.id)), req.body ?? {})); } catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/categories/:catId/fixtures', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    const out = await generateCategoryFixtures(ev, String(req.params.catId), req.body?.format, req.body?.config ?? {});
    return res.status(201).json(out);
  } catch (e) { return fail(res, req, e); }
});

router.get('/school/:id/matches', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    const rows = await loadMatches(ev.id, req.query.category_id ? String(req.query.category_id) : null);
    return res.json(rows.map((m) => toMatchDto(m, resolveConfig(ev.scoring_config, m.category_id))));
  } catch (e) { return fail(res, req, e); }
});

router.get('/school/:id/standings', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    const st = await buildCategoryStandings(ev, req.query.category_id ? String(req.query.category_id) : null);
    return res.json({ ...st, scorers: [] });
  } catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/matches/:matchId/actions', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const eventId = String(req.params.id), matchId = String(req.params.matchId);
    const input = actionInput(req);
    // Autorización y lecturas del partido en paralelo (B9: un round-trip menos por punto). El partido se
    // filtra por el torneo y no se usa ni se devuelve si la autorización falla.
    const [ev, pre] = await Promise.all([ownedEvent(req, eventId), preloadMatchAction(eventId, matchId, input.client_action_id)]);
    const out = await performMatchAction(ev, matchId, userActor(req), input, pre);
    return res.json({ ok: true, ...out });
  } catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/matches/:matchId/take', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    return res.json(await takeMatch(ev, String(req.params.matchId), userActor(req)));
  } catch (e) { return fail(res, req, e); }
});

router.get('/school/:id/scorekeepers', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { const ev = await ownedEvent(req, String(req.params.id)); return res.json(await listScorekeepers(ev.id)); } catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/scorekeepers', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    const origin = String(process.env.FRONTEND_URL || req.get('origin') || 'https://app.sportmaps.co');
    return res.status(201).json(await createScorekeeper(ev, req.user!.id, req.body ?? {}, origin));
  } catch (e) { return fail(res, req, e); }
});

router.delete('/school/:id/scorekeepers/:sid', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { const ev = await ownedEvent(req, String(req.params.id)); return res.json(await revokeScorekeeper(ev.id, String(req.params.sid))); } catch (e) { return fail(res, req, e); }
});

// Hora y cancha a mano (queda en el log como «reschedule»).
router.patch('/school/:id/matches/:matchId/schedule', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    return res.json(await rescheduleMatch(ev, String(req.params.matchId), userActor(req), req.body ?? {}));
  } catch (e) { return fail(res, req, e); }
});

// ── Equipos (internos + rivales externos sin cuenta) ─────────────────────────

router.get('/school/:id/teams', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await listTeams(await ownedEvent(req, String(req.params.id)))); } catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/teams/external', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    return res.status(201).json(await addExternalTeams(ev, req.body ?? {}));
  } catch (e) { return fail(res, req, e); }
});

router.patch('/school/:id/teams/:teamId', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    return res.json(await updateTeam(ev, String(req.params.teamId), req.body ?? {}));
  } catch (e) { return fail(res, req, e); }
});

router.delete('/school/:id/teams/:teamId', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    return res.json(await deleteExternalTeam(ev, String(req.params.teamId)));
  } catch (e) { return fail(res, req, e); }
});

// ── Patrocinadores ───────────────────────────────────────────────────────────

router.get('/school/:id/sponsors', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { const ev = await ownedEvent(req, String(req.params.id)); return res.json(await listSponsors(ev.id)); } catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/sponsors', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { const ev = await ownedEvent(req, String(req.params.id)); return res.status(201).json(await createSponsor(ev, req.body ?? {})); } catch (e) { return fail(res, req, e); }
});

router.patch('/school/:id/sponsors/:sid', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { const ev = await ownedEvent(req, String(req.params.id)); return res.json(await updateSponsor(ev, String(req.params.sid), req.body ?? {})); } catch (e) { return fail(res, req, e); }
});

router.delete('/school/:id/sponsors/:sid', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { const ev = await ownedEvent(req, String(req.params.id)); return res.json(await deleteSponsor(ev, String(req.params.sid))); } catch (e) { return fail(res, req, e); }
});

// ── Jugadores, formulario y carnés ───────────────────────────────────────────

router.get('/school/:id/player-form', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await getPlayerForm(await ownedEvent(req, String(req.params.id)))); } catch (e) { return fail(res, req, e); }
});

router.put('/school/:id/player-form', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await savePlayerForm(await ownedEvent(req, String(req.params.id)), req.body ?? {})); } catch (e) { return fail(res, req, e); }
});

router.get('/school/:id/teams/:teamId/players', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await listPlayers(await ownedEvent(req, String(req.params.id)), String(req.params.teamId))); } catch (e) { return fail(res, req, e); }
});

/** Uno o varios (planilla importada): { players: [...] }. */
router.post('/school/:id/teams/:teamId/players', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    return res.status(201).json(await addPlayers(ev, String(req.params.teamId), req.body?.players));
  } catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/teams/:teamId/players/from-school', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    return res.status(201).json(await addFromSchool(ev, String(req.params.teamId), req.body?.child_ids));
  } catch (e) { return fail(res, req, e); }
});

router.get('/school/:id/school-athletes', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    return res.json(await schoolAthletes(ev, req.query.q ? String(req.query.q) : undefined));
  } catch (e) { return fail(res, req, e); }
});

router.patch('/school/:id/players/:pid', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await updatePlayer(await ownedEvent(req, String(req.params.id)), String(req.params.pid), req.body ?? {})); } catch (e) { return fail(res, req, e); }
});

router.delete('/school/:id/players/:pid', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await deletePlayer(await ownedEvent(req, String(req.params.id)), String(req.params.pid))); } catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/players/:pid/reissue-card', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await reissueCard(await ownedEvent(req, String(req.params.id)), String(req.params.pid))); } catch (e) { return fail(res, req, e); }
});

router.get('/school/:id/card-config', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await getCardConfig(await ownedEvent(req, String(req.params.id)))); } catch (e) { return fail(res, req, e); }
});

router.put('/school/:id/card-config', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await saveCardConfig(await ownedEvent(req, String(req.params.id)), req.body ?? {})); } catch (e) { return fail(res, req, e); }
});

router.get('/school/:id/cards', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    const origin = String(process.env.FRONTEND_URL || req.get('origin') || 'https://app.sportmaps.co');
    return res.json(await cardsFor(ev, origin, req.query.team_id ? String(req.query.team_id) : null));
  } catch (e) { return fail(res, req, e); }
});

// ── Link de inscripción del equipo (organizador) ─────────────────────────────

router.get('/school/:id/invites', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await listInvites(await ownedEvent(req, String(req.params.id)))); } catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/teams/:teamId/invite', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    const origin = String(process.env.FRONTEND_URL || req.get('origin') || 'https://app.sportmaps.co');
    return res.status(201).json(await createInvite(ev, req.user!.id, String(req.params.teamId), req.body ?? {}, origin));
  } catch (e) { return fail(res, req, e); }
});

router.post('/school/:id/invites/:iid/revoke', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await revokeInvite(await ownedEvent(req, String(req.params.id)), String(req.params.iid))); } catch (e) { return fail(res, req, e); }
});

router.patch('/school/:id/invites/:iid/payment', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await markInvitePaid(await ownedEvent(req, String(req.params.id)), String(req.params.iid), req.body?.paid === true)); } catch (e) { return fail(res, req, e); }
});

router.get('/school/:id/invites/:iid/proof', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await invitePaymentProofUrl(await ownedEvent(req, String(req.params.id)), String(req.params.iid))); } catch (e) { return fail(res, req, e); }
});

/** Foto de la planilla en papel → nombres para revisar (no guarda nada). */
router.post('/school/:id/roster-photo', ocrLimiter, ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { await ownedEvent(req, String(req.params.id)); return res.json(await rosterFromPhoto(req.body?.image_base64, req.body?.mime)); } catch (e) { return fail(res, req, e); }
});

/** Nómina del partido para la planilla en PDF: dorsal, categoría y quién no está habilitado (misma regla del QR). */
router.get('/school/:id/matches/:matchId/sheet-roster', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try { return res.json(await matchSheetRoster(await ownedEvent(req, String(req.params.id)), String(req.params.matchId))); } catch (e) { return fail(res, req, e); }
});

// ── Link de inscripción del equipo (delegado, sin cuenta) ────────────────────

const inviteCtx = (req: Request) => authInvite(String(req.params.token), loadEvent);

router.get('/invite/:token', inviteLimiter, async (req: Request, res: Response) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); return res.json(await inviteHome(await inviteCtx(req))); } catch (e) { return fail(res, req, e); }
});

router.patch('/invite/:token/team', inviteLimiter, async (req: Request, res: Response) => {
  try { return res.json(await inviteUpdateTeam(await inviteCtx(req), req.body ?? {})); } catch (e) { return fail(res, req, e); }
});

router.post('/invite/:token/players', inviteLimiter, async (req: Request, res: Response) => {
  try { return res.status(201).json(await inviteAddPlayers(await inviteCtx(req), req.body?.players)); } catch (e) { return fail(res, req, e); }
});

router.delete('/invite/:token/players/:pid', inviteLimiter, async (req: Request, res: Response) => {
  try { return res.json(await inviteRemovePlayer(await inviteCtx(req), String(req.params.pid))); } catch (e) { return fail(res, req, e); }
});

router.post('/invite/:token/upload-url', inviteLimiter, async (req: Request, res: Response) => {
  try { return res.json(await inviteUploadUrl(await inviteCtx(req), req.body?.kind, req.body?.mime)); } catch (e) { return fail(res, req, e); }
});

router.post('/invite/:token/roster-photo', ocrLimiter, async (req: Request, res: Response) => {
  try { await inviteCtx(req); return res.json(await rosterFromPhoto(req.body?.image_base64, req.body?.mime)); } catch (e) { return fail(res, req, e); }
});

router.post('/invite/:token/submit', inviteLimiter, async (req: Request, res: Response) => {
  try {
    const ctx = await inviteCtx(req);
    const out = await inviteSubmit(ctx, req.body ?? {});
    const fresh = await inviteCtx(req);
    return res.json({ ...out, signup_prefill: signupPrefill(fresh) });
  } catch (e) { return fail(res, req, e); }
});

router.get('/school/:id/log', ...org, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await ownedEvent(req, String(req.params.id));
    let q = supabase.from('tournament_match_log')
      .select('id, match_id, action, actor_type, actor_id, created_at, before_state, after_state')
      .eq('event_id', ev.id).order('created_at', { ascending: false }).limit(100);
    if (req.query.match_id) q = q.eq('match_id', String(req.query.match_id));
    const { data } = await q;
    return res.json(data ?? []);
  } catch (e) { return fail(res, req, e); }
});

// ── Anotador sin cuenta ──────────────────────────────────────────────────────

router.get('/scorer/:token', scorerLimiter, async (req: Request, res: Response) => {
  try {
    const sk = await authScorekeeper(String(req.params.token));
    return res.json({
      event: { id: sk.event.id, title: sk.event.title, sport: sk.event.sport, slug: sk.event.slug },
      scorekeeper: { label: sk.label, court: sk.court },
      matches: await scorerMatches(sk),
    });
  } catch (e) { return fail(res, req, e); }
});

router.post('/scorer/:token/matches/:matchId/actions', scorerLimiter, async (req: Request, res: Response) => {
  try {
    const matchId = String(req.params.matchId);
    const input = actionInput(req);
    // Token y partido en paralelo (B9). El partido se lee por id: si no es del torneo del enlace,
    // performMatchAction responde 404 como antes.
    const [sk, pre] = await Promise.all([authScorekeeper(String(req.params.token)), preloadMatchAction(null, matchId, input.client_action_id)]);
    const m = pre.match && pre.match.event_id === sk.event.id ? pre.match : null;
    if (m && sk.court && m.court && m.court !== sk.court) throw new LiveError(403, 'otra_cancha', 'Este enlace es de otra cancha');
    const out = await performMatchAction(sk.event, matchId, { type: 'scorekeeper', id: sk.id, label: sk.label }, input, pre);
    touchScorekeeper(sk.id).catch((e) => console.warn('[tournament-live] último uso del enlace:', e?.message));
    return res.json({ ok: true, ...out });
  } catch (e) { return fail(res, req, e); }
});

router.post('/scorer/:token/matches/:matchId/take', scorerLimiter, async (req: Request, res: Response) => {
  try {
    const sk = await authScorekeeper(String(req.params.token));
    return res.json(await takeMatch(sk.event, String(req.params.matchId), { type: 'scorekeeper', id: sk.id, label: sk.label }));
  } catch (e) { return fail(res, req, e); }
});

// ── Público ──────────────────────────────────────────────────────────────────

// Validación en cancha del carné (QR). Mínimo público: nombre de pila, foto si se permite, equipo y Habilitado/No.
router.get('/public/:slug/validate/:token', publicLimiter, async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug);
    if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(slug)) return res.status(404).json({ error: 'Carné no válido', code: 'carne_invalido' });
    const out = await validateCardPublic(slug, String(req.params.token));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (!out) return res.status(404).json({ error: 'Carné no válido', code: 'carne_invalido' });
    return res.json(out);
  } catch (e) { return fail(res, req, e); }
});

router.get('/public/:slug/live', publicLimiter, async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug);
    if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(slug)) return res.status(404).json({ error: 'Torneo no encontrado', code: 'torneo_no_encontrado' });
    const out = await publicLive(slug);
    if (!out) return res.status(404).json({ error: 'Torneo no encontrado', code: 'torneo_no_encontrado' });
    res.setHeader('Cache-Control', 'public, max-age=5');
    res.setHeader('ETag', out.etag);
    res.setHeader('X-Robots-Tag', 'noindex');
    if (req.get('if-none-match') === out.etag) return res.status(304).end();
    return res.json(out.payload);
  } catch (e) { return fail(res, req, e); }
});

export default router;
