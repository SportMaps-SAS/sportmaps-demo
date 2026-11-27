import { Router, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';
import { todayInZone } from '../utils/businessDate';
import { requireAuth, requireRole, auditLog, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { guardarSesionAsistencia, resolverFechaDeTrabajo, type RegistroAsistencia } from '../services/attendance-register.service';

const router = Router();

function todayString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Hallazgo de seguridad 2026-09-08: estas rutas validaban rol + escuela activa,
// pero NUNCA cruzaban que el coach que llama esté en `team_coaches` (o sea el
// `coach_id` legacy) del `teamId` recibido. La UI nunca ofrece un equipo ajeno,
// pero el BFF corre con service role (bypassa RLS) — sin este chequeo, un coach
// que arme la URL/payload a mano podía leer o escribir asistencia de un equipo
// de otro coach dentro de su misma escuela. owner/super_admin/admin/school_admin
// siguen viendo todos los equipos, igual que ya hace el frontend con `isAdmin`.
// ─────────────────────────────────────────────────────────────────────────────
async function assertCoachHasTeamAccess(req: AuthenticatedRequest, teamId: string): Promise<boolean> {
  if (req.role !== 'coach') return true;
  const { schoolId } = req;

  const { data: staffData } = await supabase
    .from('school_staff')
    .select('id')
    .eq('coach_auth_id', req.user?.id)
    .eq('school_id', schoolId)
    .maybeSingle();
  if (!staffData?.id) return false;

  const { data: team } = await supabase
    .from('teams')
    .select('coach_id')
    .eq('id', teamId)
    .eq('school_id', schoolId)
    .maybeSingle();
  if (team?.coach_id === staffData.id) return true;

  const { data: tc } = await supabase
    .from('team_coaches')
    .select('id')
    .eq('team_id', teamId)
    .eq('coach_id', staffData.id)
    .maybeSingle();
  return !!tc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hallazgo de seguridad 2026-09-18: el chequeo de arriba solo cubre el camino
// por `teamId`. El camino por `offeringId` (asistencia de "Planes" — clases/
// mensualidades sueltas, sin equipo) no tenía ningún cruce de pertenencia:
// cualquier coach de la escuela podía leer y marcar asistencia del roster de
// una `offering` de OTRO coach/disciplina. Mismo patrón, mismo fix: resolver
// el `offering_coaches` del coach que llama y exigir que contenga la offering.
// ─────────────────────────────────────────────────────────────────────────────
async function assertCoachHasOfferingAccess(req: AuthenticatedRequest, offeringId: string): Promise<boolean> {
  if (req.role !== 'coach') return true;
  const { schoolId } = req;

  const { data: staffData } = await supabase
    .from('school_staff')
    .select('id')
    .eq('coach_auth_id', req.user?.id)
    .eq('school_id', schoolId)
    .maybeSingle();
  if (!staffData?.id) return false;

  const { data: offering } = await supabase
    .from('offerings')
    .select('id')
    .eq('id', offeringId)
    .eq('school_id', schoolId)
    .maybeSingle();
  if (!offering) return false;

  const { data: oc } = await supabase
    .from('offering_coaches')
    .select('id')
    .eq('offering_id', offeringId)
    .eq('coach_id', staffData.id)
    .maybeSingle();
  return !!oc;
}

const TEAM_ACCESS_DENIED = { error: 'No tienes ese equipo asignado.', reason: 'not_your_team' };
const OFFERING_ACCESS_DENIED = { error: 'No tienes ese plan asignado.', reason: 'not_your_offering' };

// ─────────────────────────────────────────────────────────────────────────────
// Créditos de sesión — docs/plan-asistencia-y-creditos-de-sesion.md
//
// Regla de fondo: los créditos viven SIEMPRE en la inscripción que tiene
// `offering_plan_id`. El equipo solo pone al atleta en el roster, así que un
// entrenador asignado únicamente al equipo descuenta del plan del atleta sin
// tener vínculo con la oferta. Por eso el crédito se resuelve POR ATLETA y no
// por la fila que mandó la pantalla.
//
// Y registrar la asistencia NUNCA falla por falta de saldo: dejar constancia de
// que el atleta vino, y cobrarle el crédito, son dos cosas distintas.
// ─────────────────────────────────────────────────────────────────────────────


import {
  athleteFilter,
  athleteKey,
  findCreditEnrollment,
  loadCreditEnrollment,
  avisarHitoDePlan,
  moveCredit,
  findFreeBookingOfDay,
  consumeBooking,
  findTeamSessionOfDay,
  pausedEnrollmentIds,
  toCreditEnrollment,
  pickCreditFields,
  tieneSaldo,
  releaseConsumedBooking,
  PLAN_JOIN,
} from '../services/attendance-credits';
import type { AthleteRef, CreditEnrollment, FreeBooking, CreditOutcome, HitoPlan } from '../services/attendance-credits';
export { athleteFilter, athleteKey, findCreditEnrollment, loadCreditEnrollment, avisarHitoDePlan, moveCredit, findFreeBookingOfDay, consumeBooking, findTeamSessionOfDay };
export type { AthleteRef, CreditEnrollment, FreeBooking, CreditOutcome, HitoPlan };
type PlanStatus = {
  /** false = la inscripción no existe o no está activa. Es lo ÚNICO que bloquea. */
  found: boolean;
  /** La inscripción que aporta los créditos. null = el atleta no maneja sesiones. */
  credit: CreditEnrollment | null;
  /** Motivo por el que no se va a descontar, aunque la asistencia sí se registre. */
  warning: 'expired' | 'no_credits' | 'no_secondary_credits' | null;
};

async function validatePlanForAttendance(
  enrollmentId: string, isSecondary: boolean = false,
  schoolId?: string, athlete: AthleteRef = {},
): Promise<PlanStatus> {
  const { data: enr, error } = await supabase
    .from('enrollments')
    .select(`id, sessions_used, secondary_sessions_used, expires_at, status, offering_plan_id, ${PLAN_JOIN}`)
    .eq('id', enrollmentId).eq('status', 'active').maybeSingle();

  if (error || !enr) return { found: false, credit: null, warning: null };

  // La fila recibida solo confirma que la inscripción existe y está activa; el
  // saldo sale de la que tiene el plan, que puede ser esta misma u otra.
  const credit = (enr as any).offering_plan_id
    ? toCreditEnrollment(enr)
    : (schoolId ? await findCreditEnrollment(schoolId, athlete, isSecondary) : null);

  if (!credit) return { found: true, credit: null, warning: null };

  const today = todayString();
  if (credit.expires_at && credit.expires_at < today) return { found: true, credit, warning: 'expired' };

  if (isSecondary) {
    if (credit.max_secondary_sessions !== null && credit.secondary_sessions_used >= credit.max_secondary_sessions) {
      return { found: true, credit, warning: 'no_secondary_credits' };
    }
  } else if (credit.max_sessions !== null && credit.sessions_used >= credit.max_sessions) {
    return { found: true, credit, warning: 'no_credits' };
  }

  return { found: true, credit, warning: null };
}

/** Estado del plan tal como lo consume el frontend (badge de la fila + toast). */
function planSummary(credit: CreditEnrollment | null, booking?: FreeBooking | null) {
  if (!credit) return null;
  return {
    plan_name: credit.plan_name,
    sessions_used: credit.sessions_used,
    max_sessions: credit.max_sessions,
    sessions_remaining: credit.max_sessions !== null ? Math.max(0, credit.max_sessions - credit.sessions_used) : null,
    secondary_sessions_used: credit.secondary_sessions_used,
    max_secondary_sessions: credit.max_secondary_sessions,
    expires_at: credit.expires_at,
    booking_today: booking ? { start_time: booking.start_time, source: booking.source } : null,
  };
}

// GET /session/:teamId — sesión de hoy + registros (ahora incluye unregistered_athlete_id)

// ─────────────────────────────────────────────────────────────────────────────
// Check-in por evento (torniquete ZKTeco / QR de carnet) — Fase 2,
// docs/specs/asistencia-rapida-checkin.md §2.2 y §5.
//
// Reusa EXACTAMENTE la misma lógica de crédito que POST /session (findCredit-
// Enrollment/moveCredit/findFreeBookingOfDay/consumeBooking/avisarHitoDePlan)
// en vez de un INSERT simplificado a attendance_records: un check-in que solo
// marca presente sin descontar la clase del plan rompe el sistema de créditos
// y nunca dispara el aviso de "última clase" (avisarHitoDePlan). Nunca marca
// ausente ni toca sesiones ya finalizadas — eso lo sigue resolviendo el coach
// a mano.
//
// Idempotencia (D3 del spec: "gana el primer scan"): si el atleta YA estaba
// presente en esta sesión, el upsert solo actualiza check_in_method/timestamp
// — no vuelve a descontar crédito ni a disparar avisos.
// ─────────────────────────────────────────────────────────────────────────────
export type CheckInOutcome =
  | CreditOutcome
  | 'no_team'           // el atleta no tiene equipo asociado, o hay varias sesiones hoy (ambiguo)
  | 'session_closed'    // la sesión de hoy ya está finalizada; no se reabre desde acá
  | 'already_present';  // ya había check-in hoy para esta sesión; no se cobra dos veces

export async function checkInPresenceFromEvent(params: {
  schoolId: string;
  athlete: AthleteRef;
  enrollmentId: string;
  occurredAt: string; // ISO
  checkInMethod: 'turnstile' | 'qr';
}): Promise<{ outcome: CheckInOutcome; sessionId?: string }> {
  const { schoolId, athlete, enrollmentId, occurredAt, checkInMethod } = params;
  const athleteId = athleteKey(athlete);
  if (!athleteId) return { outcome: 'no_team' };

  const { data: enr } = await supabase
    .from('enrollments')
    .select('team_id')
    .eq('id', enrollmentId)
    .eq('school_id', schoolId)
    .maybeSingle();
  const teamId = (enr as any)?.team_id as string | undefined;
  if (!teamId) return { outcome: 'no_team' }; // sin equipo, no hay a qué sesión hacer check-in

  const today = new Date(occurredAt).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

  const lookup = await findTeamSessionOfDay(teamId, today);
  if (lookup.kind === 'many') return { outcome: 'no_team' }; // ambiguo — no adivinar (§2.2)

  let finalSessionId: string;
  if (lookup.kind === 'one') {
    if ((lookup as any).session.finalized) return { outcome: 'session_closed' };
    finalSessionId = (lookup as any).session.id;
  } else {
    const { data: session, error } = await supabase.from('attendance_sessions')
      .insert({ school_id: schoolId, team_id: teamId, session_date: today, created_by: null, coach_id: null })
      .select('id').single();
    if (error) throw error;
    finalSessionId = session.id;
  }

  // ¿Ya estaba presente en ESTA sesión? Antes de escribir, para no cobrar
  // crédito dos veces por dos escaneos del mismo entrenamiento (D3).
  const { data: prev } = await supabase
    .from('attendance_records')
    .select('status')
    .eq('session_id', finalSessionId)
    .match(athleteFilter(athlete))
    .maybeSingle();
  const wasPresent = (prev as any)?.status === 'present';

  const { error: upsertErr } = await supabase.rpc('upsert_attendance_record', {
    p_school_id:       schoolId,
    p_session_id:      finalSessionId,
    p_attendance_date: today,
    p_status:          'present',
    p_team_id:         teamId,
    p_marked_by:       null,
    p_child_id:        athlete.childId ?? null,
    p_user_id:         athlete.userId ?? null,
    p_unregistered_id: athlete.unregisteredId ?? null,
    p_check_in_method: checkInMethod,
  });
  if (upsertErr) throw upsertErr;

  if (wasPresent) return { outcome: 'already_present', sessionId: finalSessionId };

  // ── Crédito, igual que POST /session — nunca bloquea el check-in ya escrito ──
  const credit = (await loadCreditEnrollment(enrollmentId, schoolId))
    ?? (await findCreditEnrollment(schoolId, athlete, false, today));
  if (!credit) return { outcome: 'no_plan', sessionId: finalSessionId };

  const freeBooking = await findFreeBookingOfDay(schoolId, athlete, today, false, finalSessionId);
  if (freeBooking) {
    await consumeBooking(freeBooking);
    return { outcome: 'covered_by_booking', sessionId: finalSessionId };
  }

  if (credit.expires_at && credit.expires_at < today) {
    await avisarHitoDePlan(schoolId, athlete, 'vencida', { fecha: today, plan: credit.plan_name, tope: credit.max_sessions });
    return { outcome: 'expired', sessionId: finalSessionId };
  }

  const usadas = credit.sessions_used;
  const tope   = credit.max_sessions;
  if (tope !== null && usadas >= tope) {
    await avisarHitoDePlan(schoolId, athlete, 'excedida', { fecha: today, plan: credit.plan_name, tope, usadas });
    return { outcome: 'no_credits', sessionId: finalSessionId };
  }

  const moved = await moveCredit(credit.id, 1, false);
  if (moved?.moved && tope !== null && usadas + 1 >= tope) {
    await avisarHitoDePlan(schoolId, athlete, 'ultima', { fecha: today, plan: credit.plan_name, tope, usadas: usadas + 1 });
  }
  return { outcome: moved?.moved ? 'deducted' : 'no_credits', sessionId: finalSessionId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check-in por QR de carnet — Fase 4, docs/specs/asistencia-rapida-checkin.md
// §3.2. Resuelve el atleta y su inscripción a partir del qr_token y delega en
// checkInPresenceFromEvent — mismo resolver que el torniquete, no un tercer
// camino de escritura.
// ─────────────────────────────────────────────────────────────────────────────
export type CardCheckInOutcome =
  | CheckInOutcome
  | 'card_not_found'
  | 'card_revoked'
  | 'card_expired'
  | 'wrong_school'
  | 'no_team';

export async function checkInByCardToken(params: {
  qrToken: string;
  /** Escuela del staff que hace el escaneo — un carnet de OTRA escuela nunca
   *  pasa, así el caller no tenga que acordarse de chequearlo. */
  requestingSchoolId: string;
}): Promise<{ outcome: CardCheckInOutcome; athleteName?: string; sessionId?: string }> {
  const { qrToken, requestingSchoolId } = params;

  const { data: card } = await supabase
    .from('athlete_id_cards')
    .select('school_id, status, valid_until, child_id, profile_id, unregistered_athlete_id')
    .eq('qr_token', qrToken)
    .maybeSingle();

  if (!card) return { outcome: 'card_not_found' };
  if ((card as any).status === 'revoked') return { outcome: 'card_revoked' };
  if ((card as any).school_id !== requestingSchoolId) return { outcome: 'wrong_school' };

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  if ((card as any).valid_until < today) return { outcome: 'card_expired' };

  const athlete: AthleteRef = {
    childId: (card as any).child_id,
    userId: (card as any).profile_id,
    unregisteredId: (card as any).unregistered_athlete_id,
  };
  const schoolId = (card as any).school_id as string;

  // Nombre para mostrarle al coach en el resultado del escaneo.
  let athleteName = 'Atleta';
  if (athlete.childId) {
    const { data } = await supabase.from('children').select('full_name').eq('id', athlete.childId).maybeSingle();
    athleteName = (data as any)?.full_name ?? athleteName;
  } else if (athlete.userId) {
    const { data } = await supabase.from('profiles').select('full_name').eq('id', athlete.userId).maybeSingle();
    athleteName = (data as any)?.full_name ?? athleteName;
  } else if (athlete.unregisteredId) {
    const { data } = await supabase.from('unregistered_athletes').select('full_name').eq('id', athlete.unregisteredId).maybeSingle();
    athleteName = (data as any)?.full_name ?? athleteName;
  }

  // Inscripción activa CON equipo — sin esto no hay a qué sesión hacer check-in
  // (mismo criterio "no adivinar" que el puente ZKTeco). Si hay más de una
  // (multi-equipo), gana la más reciente — igual que el resto de heurísticas
  // de esta misma tabla cuando el llamador no puede decir cuál es.
  const { data: enrollments } = await supabase
    .from('enrollments')
    .select('id, team_id, created_at')
    .eq('school_id', schoolId)
    .eq('status', 'active')
    .not('team_id', 'is', null)
    .match(athleteFilter(athlete))
    .order('created_at', { ascending: false });

  const enrollmentId = (enrollments || [])[0]?.id as string | undefined;
  if (!enrollmentId) return { outcome: 'no_team', athleteName };

  const result = await checkInPresenceFromEvent({
    schoolId,
    athlete,
    enrollmentId,
    occurredAt: new Date().toISOString(),
    checkInMethod: 'qr',
  });

  return { outcome: result.outcome, athleteName, sessionId: result.sessionId };
}

const MESES_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
/** "agosto 2026" — el concepto del cobro lo lee un papá, no un sistema. */
function monthLabelEs(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MESES_ES[m - 1]} ${y}`;
}

const MULTIPLE_SESSIONS_MSG =
  'Este equipo tiene varios bloques hoy. Elige el bloque específico antes de pasar lista.';

// POST /checkin-by-card — escáner in-app del carnet (Fase 4). Body: { qrToken }.
// Requiere sesión de staff — es justo lo que evita que compartir el link del
// carnet alcance para marcar asistencia por su cuenta (docs/specs, §3.3).
router.post('/checkin-by-card', requireAuth, requireRole('owner', 'super_admin', 'admin', 'school_admin', 'coach'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { qrToken } = req.body as { qrToken?: string };
      if (!qrToken) return res.status(400).json({ error: 'qrToken es requerido.' });
      if (!req.schoolId) return res.status(400).json({ error: 'Falta la escuela activa (x-school-id).' });
      const result = await checkInByCardToken({ qrToken, requestingSchoolId: req.schoolId });
      return res.json(result);
    } catch (err: any) {
      req.log?.error({ err: err.message || err }, 'Error en check-in por QR de carnet');
      return res.status(500).json({ error: 'Error interno marcando asistencia por QR.' });
    }
  }
);

router.get('/session/:teamId', requireAuth, requireRole('owner', 'super_admin', 'admin', 'school_admin', 'coach'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const teamId = req.params.teamId as string;
      if (!(await assertCoachHasTeamAccess(req, teamId))) {
        return res.status(403).json(TEAM_ACCESS_DENIED);
      }
      // `?date=` para poder abrir un día pasado. Leer no tiene ventana: ver lo
      // que pasó es distinto de reescribirlo, y el histórico ya es visible en
      // Supervisión. El permiso se aplica al guardar.
      const pedida = req.query.date as string | undefined;
      const today = pedida && /^\d{4}-\d{2}-\d{2}$/.test(pedida) ? pedida : todayInZone();
      const lookup = await findTeamSessionOfDay(
        teamId, today,
        'id, team_id, session_date, finalized, finalized_at, created_by, created_at, start_time',
      );

      // Ambiguo: se responde 200 con la lista para que la pantalla ofrezca
      // elegir bloque, en vez de romperse. El 409 lo dan POST y walk-in.
      if (lookup.kind === 'many') {
        return res.json({
          session: null,
          records: [],
          sessions: lookup.sessions,
          reason: 'multiple_sessions_today',
        });
      }
      if (lookup.kind === 'none') return res.json({ session: null, records: [] });
      const session = lookup.session;
      const { data: records, error: recordsErr } = await supabase
        .from('attendance_records')
        .select('child_id, user_id, unregistered_athlete_id, status')
        .eq('team_id', teamId).eq('attendance_date', today);
      if (recordsErr) throw recordsErr;
      return res.json({ session, records: records || [] });
    } catch (err: any) {
      req.log?.error({ err: err.message || err }, 'Error consultando sesión');
      return res.status(500).json({ error: 'Error interno consultando la sesión.' });
    }
  }
);

// ── GET /roster/:contextType/:contextId ───────────────────────────────────────
router.get(
  '/roster/:contextType/:contextId',
  requireAuth,
  requireRole('owner', 'super_admin', 'admin', 'school_admin', 'coach'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const contextType = req.params.contextType as string;
      const contextId = req.params.contextId as string;
      const { schoolId } = req;

      if (!['team', 'offering', 'facility_session'].includes(contextType)) {
        return res.status(400).json({ error: 'contextType debe ser "team", "offering" o "facility_session".' });
      }

      if (contextType === 'team' && !(await assertCoachHasTeamAccess(req, contextId))) {
        return res.status(403).json(TEAM_ACCESS_DENIED);
      }
      if (contextType === 'offering' && !(await assertCoachHasOfferingAccess(req, contextId))) {
        return res.status(403).json(OFFERING_ACCESS_DENIED);
      }

      // Besser (y cualquier otra escuela con el flag activo): el coach no ve
      // dinero en ninguna pantalla. Se enmascara acá porque este endpoint
      // corre con service role (bypassa RLS) — la vista `school_athletes` ya
      // lo hace para su propio camino de lectura directa, esto cubre el BFF.
      let hideMoney = false;
      if (req.role === 'coach') {
        const { data: settingsRow } = await supabase
          .from('school_settings')
          .select('coach_hide_financial_info')
          .eq('school_id', schoolId)
          .maybeSingle();
        hideMoney = !!settingsRow?.coach_hide_financial_info;
      }

      // ── Instalación: no hay "membresía" fija — el roster son las reservas ──
      // reales de ESE bloque puntual (contextId = attendance_sessions.id).
      // A diferencia de team/offering, cada persona puede venir de un plan distinto.
      if (contextType === 'facility_session') {
        const isNew = contextId.startsWith('new_');
        let bks: any[] = [];
        let favRes: any[] = [];

        if (isNew) {
          const facilityAvailabilityId = contextId.replace('new_', '');
          const queryDate = req.query.date as string;

          const { data: avail } = await supabase
            .from('facility_availability')
            .select('facility_id, start_time, end_time')
            .eq('id', facilityAvailabilityId)
            .maybeSingle();

          if (avail && queryDate) {
            const startStr = avail.start_time.substring(0, 5);
            const { data: reservations } = await supabase
              .from('facility_reservations')
              .select('id, user_id, child_id, enrollment_id, status, start_time')
              .eq('facility_id', avail.facility_id)
              .eq('school_id', schoolId)
              .eq('reservation_date', queryDate)
              .neq('status', 'cancelled');

            favRes = (reservations || []).filter((r: any) => r.start_time.substring(0, 5) === startStr);
          }
        } else {
          const { data: sess } = await supabase
            .from('attendance_sessions')
            .select('facility_id, session_date, start_time')
            .eq('id', contextId)
            .maybeSingle();

          if (sess) {
            const startStr = sess.start_time.substring(0, 5);
            const [bksRes, favResResult] = await Promise.all([
              supabase
                .from('session_bookings')
                .select('id, user_id, child_id, unregistered_athlete_id, enrollment_id, booking_type')
                .eq('session_id', contextId)
                .eq('school_id', schoolId)
                .neq('status', 'cancelled'),
              supabase
                .from('facility_reservations')
                .select('id, user_id, child_id, enrollment_id, status, start_time')
                .eq('facility_id', sess.facility_id)
                .eq('school_id', schoolId)
                .eq('reservation_date', sess.session_date)
                .neq('status', 'cancelled')
            ]);

            bks = bksRes.data || [];
            favRes = (favResResult.data || []).filter((r: any) => r.start_time.substring(0, 5) === startStr);
          }
        }

        const mergedBks = [
          ...bks.map((b: any) => ({ ...b, source: 'session_bookings' })),
          ...favRes.map((r: any) => ({
            id: r.id,
            user_id: r.user_id,
            child_id: r.child_id,
            unregistered_athlete_id: null,
            enrollment_id: r.enrollment_id,
            booking_type: 'secondary_class',
            source: 'facility_reservations'
          }))
        ];

        if (!mergedBks.length) return res.json({ athletes: [], bookings: [] });

        const enrIds = [...new Set(mergedBks.map((b: any) => b.enrollment_id).filter(Boolean))];
        const unregWithoutEnrIds = [...new Set(
          mergedBks.filter((b: any) => !b.enrollment_id && b.unregistered_athlete_id)
            .map((b: any) => b.unregistered_athlete_id)
        )];
        const [enrByIdRes, enrByUnregRes] = await Promise.all([
          enrIds.length
            ? supabase.from('enrollments')
                .select(`id, child_id, user_id, unregistered_athlete_id, expires_at, sessions_used,
                  offering_plans!enrollments_offering_plan_id_fkey(name, max_sessions, price, currency)`)
                .in('id', enrIds)
            : Promise.resolve({ data: [] }),
          unregWithoutEnrIds.length
            ? supabase.from('enrollments')
                .select(`id, unregistered_athlete_id, expires_at, sessions_used,
                  offering_plans!enrollments_offering_plan_id_fkey(name, max_sessions, price, currency)`)
                .in('unregistered_athlete_id', unregWithoutEnrIds)
                .eq('status', 'active')
            : Promise.resolve({ data: [] }),
        ]);
        const enrMap = Object.fromEntries((enrByIdRes.data || []).map((e: any) => [e.id, e]));
        const enrByUnregMap = Object.fromEntries((enrByUnregRes.data || []).map((e: any) => [e.unregistered_athlete_id, e]));

        const childIds = mergedBks.filter((b: any) => b.child_id).map((b: any) => b.child_id);
        const userIds = mergedBks.filter((b: any) => b.user_id).map((b: any) => b.user_id);
        const unregIds = mergedBks.filter((b: any) => b.unregistered_athlete_id).map((b: any) => b.unregistered_athlete_id);
        const [childRes, profileRes, unregRes] = await Promise.all([
          childIds.length ? supabase.from('children').select('id, full_name, avatar_url').in('id', childIds) : Promise.resolve({ data: [] }),
          userIds.length ? supabase.from('profiles').select('id, full_name, avatar_url').in('id', userIds) : Promise.resolve({ data: [] }),
          unregIds.length ? supabase.from('unregistered_athletes').select('id, full_name').in('id', unregIds) : Promise.resolve({ data: [] }),
        ]);
        const childMap = Object.fromEntries((childRes.data || []).map((x: any) => [x.id, x]));
        const profileMap = Object.fromEntries((profileRes.data || []).map((x: any) => [x.id, x]));
        const unregMap = Object.fromEntries((unregRes.data || []).map((x: any) => [x.id, x]));
        const today = todayInZone();

        const athletes = mergedBks.map((b: any) => {
          const athleteId = b.user_id ?? b.child_id ?? b.unregistered_athlete_id;
          const athleteType = b.child_id ? 'child' : b.user_id ? 'adult' : 'unregistered';
          const person = b.child_id ? childMap[b.child_id] : b.user_id ? profileMap[b.user_id] : unregMap[b.unregistered_athlete_id];
          const enr = enrMap[b.enrollment_id] ?? enrByUnregMap[b.unregistered_athlete_id];
          const plan = enr?.offering_plans;
          const maxSess = plan?.max_sessions ?? null;
          const used = enr?.sessions_used ?? 0;
          const expiresAt = enr?.expires_at ?? null;
          return {
            id: athleteId,
            full_name: person?.full_name ?? 'Sin nombre',
            avatar_url: person?.avatar_url ?? null,
            athlete_type: athleteType,
            enrollment_id: b.enrollment_id ?? null,
            plan: plan ? {
              name: plan.name,
              start_date: null,
              expires_at: expiresAt,
              days_left: expiresAt ? Math.ceil((new Date(expiresAt).getTime() - new Date(today).getTime()) / 86400000) : null,
              is_expired: expiresAt ? expiresAt < today : false,
              sessions_used: used,
              max_sessions: maxSess,
              sessions_remaining: maxSess !== null ? Math.max(0, maxSess - used) : null,
              secondary_sessions_used: 0,
              max_secondary_sessions: null,
              secondary_remaining: null,
              payment_status: null, payment_due_date: null,
              price: hideMoney ? null : plan.price,
              currency: hideMoney ? null : plan.currency,
            } : null,
            payment: null,
          };
        }).sort((a: any, b: any) => a.full_name.localeCompare(b.full_name));

        return res.json({ athletes, bookings: bks, context_type: 'facility_session', context_id: contextId });
      }

      const today = todayInZone();

      // ── 1. Resolver plan_ids del offering (solo si contextType = offering) ──
      let offeringPlanIds: string[] = [];
      if (contextType === 'offering') {
        const { data: plans, error: plansErr } = await supabase
          .from('offering_plans')
          .select('id')
          .eq('offering_id', contextId)
          .eq('is_active', true);
        if (plansErr) throw plansErr;
        offeringPlanIds = (plans || []).map((p: any) => p.id);
        if (!offeringPlanIds.length) return res.json({ athletes: [], bookings: [] });
      }

      // ── 2. Obtener enrollments activos del contexto ───────────────────────
      let enrollmentQuery = supabase
        .from('enrollments')
        .select(`
          id, child_id, user_id, unregistered_athlete_id,
          start_date, expires_at, sessions_used, secondary_sessions_used,
          offering_plan_id,
          offering_plans!enrollments_offering_plan_id_fkey(
            name, max_sessions, max_secondary_sessions, price, currency
          )
        `)
        .eq('school_id', schoolId)
        .eq('status', 'active');

      if (contextType === 'team') {
        enrollmentQuery = enrollmentQuery.eq('team_id', contextId);
      } else {
        enrollmentQuery = enrollmentQuery.in('offering_plan_id', offeringPlanIds);
      }

      const { data: enrollmentsRaw, error: enrErr } = await enrollmentQuery;
      if (enrErr) throw enrErr;

      // Pausados por vacaciones/lesión: fuera del roster del día. `?date=` puede
      // apuntar a un día pasado, así que la ventana se evalúa contra ESE día, no
      // contra hoy — abrir la lista del 20 de julio muestra quién estaba activo
      // el 20 de julio.
      const rosterDate = (req.query.date as string | undefined) &&
        /^\d{4}-\d{2}-\d{2}$/.test(req.query.date as string)
          ? (req.query.date as string)
          : todayInZone();
      const pausadas = await pausedEnrollmentIds(schoolId as string, rosterDate);
      const enrollments = (enrollmentsRaw ?? []).filter((e: any) => !pausadas.has(e.id));
      const atletasPausados = (enrollmentsRaw ?? []).length - enrollments.length;

      // ── Los que NO van a aparecer, y por qué ──────────────────────────────
      //
      // El roster de equipo sale de las inscripciones activas con
      // `team_id = contextId`. Quien esté en la escuela pero cuya inscripción
      // no apunte a ningún equipo simplemente no sale, sin una línea que lo
      // explique — y el entrenador no tiene forma de distinguirlo de "ese
      // atleta no existe". Se cuentan y se devuelven para que la pantalla lo
      // diga. Solo aplica a `team`: en `offering` el roster va por plan y no
      // hay tal cosa como quedarse sin equipo.
      let sinEquipo = 0;
      if (contextType === 'team') {
        const { count } = await supabase
          .from('enrollments')
          .select('id', { count: 'exact', head: true })
          .eq('school_id', schoolId)
          .eq('status', 'active')
          .is('team_id', null);
        sinEquipo = count ?? 0;
      }

      if (!enrollments?.length)
        return res.json({ athletes: [], bookings: [], atletas_sin_equipo: sinEquipo, atletas_pausados: atletasPausados });

      // ── 3. Resolver nombres e info de cada tipo de atleta ─────────────────
      const childIds        = enrollments.filter((e: any) => e.child_id).map((e: any) => e.child_id);
      const userIds         = enrollments.filter((e: any) => e.user_id).map((e: any) => e.user_id);
      const unregisteredIds = enrollments.filter((e: any) => e.unregistered_athlete_id).map((e: any) => e.unregistered_athlete_id);

      const [childRes, profileRes, unregRes] = await Promise.all([
        childIds.length
          ? supabase.from('children').select('id, full_name, avatar_url').in('id', childIds)
          : Promise.resolve({ data: [] }),
        userIds.length
          ? supabase.from('profiles').select('id, full_name, avatar_url').in('id', userIds)
          : Promise.resolve({ data: [] }),
        unregisteredIds.length
          ? supabase.from('unregistered_athletes').select('id, full_name').in('id', unregisteredIds)
          : Promise.resolve({ data: [] }),
      ]);

      const childMap   = Object.fromEntries((childRes.data   || []).map((x: any) => [x.id, x]));
      const profileMap = Object.fromEntries((profileRes.data || []).map((x: any) => [x.id, x]));
      const unregMap   = Object.fromEntries((unregRes.data   || []).map((x: any) => [x.id, x]));

      // ── 4. Pagos CONTEXTUALES (específicos del equipo o plan) ─────────────
      let paymentQuery = supabase
        .from('payments')
        .select('child_id, user_id, unregistered_athlete_id, status, due_date, created_at')
        .eq('school_id', schoolId);

      if (contextType === 'team') {
        paymentQuery = paymentQuery.eq('team_id', contextId);
      } else {
        paymentQuery = paymentQuery.in('offering_plan_id', offeringPlanIds);
      }

      const { data: payments } = await paymentQuery.order('created_at', { ascending: false });

      const paymentByAthlete: Record<string, { status: string; due_date: string | null }> = {};
      (payments || []).forEach((p: any) => {
        const id = p.child_id ?? p.user_id ?? p.unregistered_athlete_id;
        if (id && !paymentByAthlete[id]) {
          paymentByAthlete[id] = { status: p.status, due_date: p.due_date };
        }
      });

      // ── 4b. Reservas de hoy ───────────────────────────────────────────────
      // El entrenador tiene que ver que el atleta ya reservó: en ese caso pasar
      // lista NO le descuenta otra clase, y sin el aviso parece un error.
      const bookingByAthlete: Record<string, { start_time: string | null; status: string }> = {};
      {
        const { data: todayBks } = await supabase
          .from('session_bookings')
          .select('child_id, user_id, unregistered_athlete_id, status, attendance_sessions!inner(session_date, start_time)')
          .eq('school_id', schoolId)
          .in('status', ['confirmed', 'attended'])
          .eq('attendance_sessions.session_date', todayString());

        for (const b of todayBks || []) {
          const key = (b as any).child_id ?? (b as any).user_id ?? (b as any).unregistered_athlete_id;
          if (key && !bookingByAthlete[key]) {
            bookingByAthlete[key] = {
              start_time: (b as any).attendance_sessions?.start_time ?? null,
              status: (b as any).status,
            };
          }
        }
      }

      // ── 4c. Avisos de ausencia de la familia (WhatsApp, mig 20261006101628) ─
      // «Mi hija no puede ir hoy»: la pantalla precarga «excusado» y muestra el
      // motivo. No es un registro de asistencia (eso lo sigue escribiendo el
      // coach al guardar) y 'excused' no descuenta créditos.
      const avisoByAthlete: Record<string, { motivo: string | null; nota: string | null; fuente: string }> = {};
      {
        const { data: avisos, error: avisosErr } = await supabase
          .from('athlete_absence_notices')
          .select('child_id, user_id, reason, note, source')
          .eq('school_id', schoolId)
          .eq('absence_date', rosterDate)
          .eq('status', 'active');
        // Sin la migración aplicada la tabla no existe: el roster sigue igual.
        if (avisosErr) req.log?.warn({ err: avisosErr.message }, 'avisos de ausencia no disponibles');
        for (const a of avisos || []) {
          const key = (a as any).child_id ?? (a as any).user_id;
          if (key) avisoByAthlete[key] = { motivo: (a as any).reason, nota: (a as any).note, fuente: (a as any).source };
        }
      }

      // ── 5. Construir athletes enriquecidos ────────────────────────────────
      const athletes = enrollments.map((e: any) => {
        const athleteId   = e.child_id ?? e.user_id ?? e.unregistered_athlete_id;
        const athleteType = e.child_id ? 'child' : e.user_id ? 'adult' : 'unregistered';
        const person      = e.child_id ? childMap[e.child_id] : e.user_id ? profileMap[e.user_id] : unregMap[e.unregistered_athlete_id];

        const plan        = (e as any).offering_plans ?? null;
        const maxSessions   = plan?.max_sessions      ?? null;
        const maxSecondary  = plan?.max_secondary_sessions ?? null;
        const used          = e.sessions_used          ?? 0;
        const usedSecondary = e.secondary_sessions_used ?? 0;
        const expiresAt     = e.expires_at             ?? null;
        const isExpired     = expiresAt ? expiresAt < today : false;
        const daysLeft      = expiresAt
          ? Math.ceil((new Date(expiresAt).getTime() - new Date(today).getTime()) / 86400000)
          : null;

        const payment = paymentByAthlete[athleteId] ?? null;

        return {
          id:           athleteId,
          full_name:    person?.full_name   ?? 'Sin nombre',
          avatar_url:   person?.avatar_url  ?? null,
          athlete_type: athleteType,
          enrollment_id: e.id,
          // Para EQUIPOS: plan null siempre — el equipo no tiene plan
          // Para PLANES:  plan con toda la info
          // Reserva de hoy: el descuento la consume en vez de cobrar otra clase.
          booking_today: bookingByAthlete[athleteId] ?? null,
          // La familia avisó que no viene ese día (WhatsApp).
          aviso_ausencia: avisoByAthlete[athleteId] ?? null,
          // El plan se expone en AMBOS contextos. El equipo no tiene plan propio,
          // pero el atleta sí, y es de su plan de donde sale el descuento: con
          // `plan: null` forzado por equipo el entrenador descontaba a ciegas y
          // solo se enteraba por un 422 seco. Atleta de equipo puro → plan null
          // natural, que es lo correcto: no maneja sesiones.
          plan: plan ? {
            name:                    plan.name,
            start_date:              e.start_date    ?? null,
            expires_at:              expiresAt,
            days_left:               daysLeft,
            is_expired:              isExpired,
            sessions_used:           used,
            max_sessions:            maxSessions,
            sessions_remaining:      maxSessions !== null ? Math.max(0, maxSessions - used) : null,
            secondary_sessions_used: usedSecondary,
            max_secondary_sessions:  maxSecondary,
            secondary_remaining:     maxSecondary !== null ? Math.max(0, maxSecondary - usedSecondary) : null,
            payment_status:          hideMoney ? null : (payment?.status   ?? null),
            payment_due_date:        hideMoney ? null : (payment?.due_date ?? null),
            price:                   hideMoney ? null : plan.price,
            currency:                hideMoney ? null : plan.currency,
          } : null,
          // Pago contextual siempre disponible (independiente del plan) — salvo
          // cuando la escuela oculta dinero al coach (ver hideMoney arriba).
          payment: hideMoney ? null : (payment ?? null),
        };
      }).sort((a: any, b: any) => a.full_name.localeCompare(b.full_name));

      // ── 6. Bookings del día para offerings ────────────────────────────────
      let bookings: any[] = [];
      if (contextType === 'offering') {
        const { data: todaySessions } = await supabase
          .from('attendance_sessions')
          .select('id')
          .eq('school_id', schoolId)
          .eq('offering_id', contextId)
          .eq('session_date', today)
          .eq('finalized', false);

        if (todaySessions?.length) {
          const sessionIds = todaySessions.map((s: any) => s.id);
          const { data: bks } = await supabase
            .from('session_bookings')
            .select('id, session_id, user_id, child_id, unregistered_athlete_id, booking_type, enrollment_id')
            .in('session_id', sessionIds)
            .neq('status', 'cancelled');
          bookings = bks || [];
        }
      }

      return res.json({
        athletes, bookings,
        context_type: contextType, context_id: contextId,
        atletas_sin_equipo: sinEquipo,
        // Cuántos quedaron fuera por pausa de vacaciones/lesión, para que la
        // pantalla lo diga en vez de dejar al entrenador buscando a alguien que
        // "desapareció" de la lista.
        atletas_pausados: atletasPausados,
      });
    } catch (err: any) {
      req.log?.error({ err: err.message || err }, 'Error cargando roster');
      return res.status(500).json({ error: 'Error interno cargando el roster.' });
    }
  }
);

// POST /session — guarda registros. Soporta child_id, user_id y unregistered_athlete_id.
router.post('/session', requireAuth, requireRole('owner', 'super_admin', 'admin', 'school_admin', 'coach'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req;
      // `enrollmentId` e `isSecondary` viajan POR RECORD desde que esta ruta es
      // también el camino de los presentes. Antes la pantalla mandaba un POST
      // /walk-in por cada atleta presente: con 31 atletas eran 31 requests, y
      // si el token vencía o se caía la red a mitad, media lista quedaba
      // guardada y la otra media no.
      const { teamId, sessionId, records, date } = req.body as {
        teamId?: string; sessionId?: string; date?: string;
        records: {
          childId?: string; userId?: string; unregisteredAthleteId?: string;
          status: string; enrollmentId?: string; isSecondary?: boolean;
        }[];
      };
      if ((!teamId && !sessionId) || !Array.isArray(records) || records.length === 0)
        return res.status(400).json({ error: 'teamId (o sessionId) y records son requeridos.' });
      if (records.find(r => !r.childId && !r.userId && !r.unregisteredAthleteId))
        return res.status(400).json({ error: 'Cada record debe tener childId, userId o unregisteredAthleteId.' });
      if (teamId && !(await assertCoachHasTeamAccess(req, teamId))) {
        return res.status(403).json(TEAM_ACCESS_DENIED);
      }

      const fecha = await resolverFechaDeTrabajo(date, req.role, req.schoolId);
      if (!fecha.ok) return res.status(fecha.status).json(fecha.body);
      // `today` conserva el nombre pero ya no es necesariamente hoy: es la fecha
      // de trabajo. Todo lo que sigue —sesión, registros y saldo— cuelga de ella.
      const today = fecha.date;
      const resultado = await guardarSesionAsistencia({
        schoolId: schoolId!, teamId, sessionId, date: today, esRetroactiva: fecha.esRetroactiva,
        records: records as RegistroAsistencia[], markedBy: req.user?.id ?? null,
        autorizarSesionExistente: async (existing) => {
          // Si el sessionId llegó solo (sin teamId en el body), igual hay que
          // validar contra el team_id real de la sesión; una sesión de offering
          // tiene team_id NULL: mismo cruce contra offering_coaches.
          if (existing.team_id && !(await assertCoachHasTeamAccess(req, existing.team_id))) {
            return { status: 403, body: TEAM_ACCESS_DENIED };
          }
          if (!existing.team_id && existing.offering_id && !(await assertCoachHasOfferingAccess(req, existing.offering_id))) {
            return { status: 403, body: OFFERING_ACCESS_DENIED };
          }
          return null;
        },
      });
      if (!resultado.ok) return res.status(resultado.status).json(resultado.body);
      const finalSessionId = resultado.sessionId;
      const creditOutcomes = resultado.creditOutcomes;


      // Reescribir el pasado mueve créditos, y los créditos son plata. Queda
      // registrado quién lo hizo y para qué fecha. El del día corriente no se
      // audita: es la operación normal y llenaría la tabla de ruido.
      if (fecha.esRetroactiva) {
        await auditLog(req, 'attendance_backdated', 'attendance_sessions', finalSessionId, null, {
          fecha_registrada: today,
          fecha_real: todayInZone(),
          team_id: teamId ?? null,
          registros: records.length,
          creditos: creditOutcomes,
        });
      }

      return res.json({
        success: true, sessionId: finalSessionId, date: today,
        retroactiva: fecha.esRetroactiva,
        credit_outcomes: creditOutcomes,
      });
    } catch (err: any) {
      console.error('SESSION ERROR DETAIL:', {
        message: err.message,
        code: err.code,
        details: err.details,
        hint: err.hint,
        body: req.body,
      });
      req.log?.error({ err: err.message || err }, 'Error guardando sesión de asistencia');
      return res.status(500).json({ error: 'Error interno guardando la asistencia.' });
    }
  }
);

// POST /walk-in — valida plan, registra asistencia y descuenta crédito en una operación.
// POST /walk-in — valida plan, registra asistencia y descuenta crédito en una operación.
router.post('/walk-in', requireAuth, requireRole('owner', 'super_admin', 'admin', 'school_admin', 'coach'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { schoolId } = req;
      const { enrollmentId, teamId, sessionId, offeringId, facilityAvailabilityId, status = 'present', childId, userId, unregisteredAthleteId, is_secondary = false, date } = req.body as {
        enrollmentId: string; teamId?: string; sessionId?: string; offeringId?: string; facilityAvailabilityId?: string; status?: string;
        childId?: string; userId?: string; unregisteredAthleteId?: string; is_secondary?: boolean; date?: string;
      };
      if (!enrollmentId) return res.status(400).json({ error: 'enrollmentId es requerido.' });
      if (!childId && !userId && !unregisteredAthleteId) return res.status(400).json({ error: 'Debe especificar childId, userId o unregisteredAthleteId.' });
      if (!teamId && !sessionId && !offeringId && !facilityAvailabilityId) {
        return res.status(400).json({ error: 'teamId, sessionId, offeringId o facilityAvailabilityId son requeridos.' });
      }
      if (teamId && !(await assertCoachHasTeamAccess(req, teamId))) {
        return res.status(403).json(TEAM_ACCESS_DENIED);
      }
      if (offeringId && !(await assertCoachHasOfferingAccess(req, offeringId))) {
        return res.status(403).json(OFFERING_ACCESS_DENIED);
      }

      const fecha = await resolverFechaDeTrabajo(date, req.role, req.schoolId);
      if (!fecha.ok) return res.status(fecha.status).json(fecha.body);
      const today = fecha.date;
      let finalSessionId = sessionId;

      if (!finalSessionId && facilityAvailabilityId) {
        // Anotar en un bloque de instalación que nadie reservó online todavía
        const { data: avail } = await supabase
          .from('facility_availability')
          .select('facility_id, start_time, end_time, max_group_capacity')
          .eq('id', facilityAvailabilityId)
          .single();
        if (!avail) return res.status(404).json({ error: 'Disponibilidad de instalación no encontrada.' });

        const { data: existing } = await supabase
          .from('attendance_sessions')
          .select('id, finalized')
          .eq('facility_availability_id', facilityAvailabilityId)
          .eq('session_date', today)
          .maybeSingle();

        if (existing?.finalized) return res.status(409).json({ error: 'La sesión de hoy ya fue finalizada.' });
        if (existing) {
          finalSessionId = existing.id;
        } else {
          const start_time = avail.start_time.length === 5 ? `${avail.start_time}:00` : avail.start_time;
          const end_time = avail.end_time.length === 5 ? `${avail.end_time}:00` : avail.end_time;
          const { data: newSession, error } = await supabase.from('attendance_sessions')
            .insert({
              school_id: schoolId,
              facility_id: avail.facility_id,
              facility_availability_id: facilityAvailabilityId,
              coach_id: null,
              offering_id: null,
              session_date: today,
              start_time, end_time,
              max_capacity: avail.max_group_capacity ?? 10,
              current_bookings: 0,
              is_bookable: true,
              finalized: false,
            })
            .select('id').single();

          if (error && error.code === '23505') {
            const { data: retryS, error: retryErr } = await supabase
              .from('attendance_sessions')
              .select('id')
              .eq('facility_availability_id', facilityAvailabilityId)
              .eq('session_date', today)
              .single();
            if (retryErr || !retryS) return res.status(500).json({ error: 'No se pudo resolver el bloque.' });
            finalSessionId = retryS.id;
          } else if (error) {
            throw error;
          } else {
            finalSessionId = newSession.id;
          }
        }
      } else if (!finalSessionId && offeringId) {
        const { data: todaySessions } = await supabase
          .from('attendance_sessions')
          .select('id, finalized, start_time')
          .eq('school_id', schoolId)
          .eq('offering_id', offeringId)
          .eq('session_date', today)
          .eq('finalized', false)
          .order('start_time', { ascending: true });

        if ((todaySessions?.length ?? 0) > 1) {
          return res.status(409).json({
            error: 'Este plan tiene varios horarios hoy. Selecciona el bloque específico antes de marcar asistencia.',
            reason: 'multiple_sessions_today',
            sessions: todaySessions,
          });
        }

        const existing = todaySessions?.[0];
        if (existing) {
          finalSessionId = existing.id;
        } else {
          return res.status(404).json({ error: 'No hay sesión activa para este plan hoy.', reason: 'no_session' });
        }
      } else if (!finalSessionId && teamId) {
        const lookup = await findTeamSessionOfDay(teamId, today);
        if (lookup.kind === 'many') {
          return res.status(409).json({
            error: MULTIPLE_SESSIONS_MSG,
            reason: 'multiple_sessions_today',
            sessions: lookup.sessions,
          });
        }
        const existing = lookup.kind === 'one' ? lookup.session : null;
        if (existing?.finalized) return res.status(409).json({ error: 'La sesión de hoy ya fue finalizada.' });
        if (existing) {
          finalSessionId = existing.id;
        } else {
          // Resolver staffId para el coach
          const { data: staffData } = await supabase
            .from('school_staff')
            .select('id')
            .eq('coach_auth_id', req.user?.id)
            .eq('school_id', schoolId)
            .maybeSingle();

          const { data: newSession, error } = await supabase.from('attendance_sessions')
            .insert({ 
              school_id: schoolId, 
              team_id: teamId, 
              session_date: today, 
              created_by: req.user?.id, 
              coach_id: staffData?.id || null 
            })
            .select('id').single();
          if (error) throw error;
          finalSessionId = newSession.id;
        }
      } else if (finalSessionId) {
        const { data: sess } = await supabase.from('attendance_sessions').select('finalized, team_id, offering_id').eq('id', finalSessionId).single();
        if (sess?.finalized) return res.status(409).json({ error: 'La sesión ya fue finalizada.' });
        if (sess?.team_id && !(await assertCoachHasTeamAccess(req, sess.team_id))) {
          return res.status(403).json(TEAM_ACCESS_DENIED);
        }
        if (!sess?.team_id && sess?.offering_id && !(await assertCoachHasOfferingAccess(req, sess.offering_id))) {
          return res.status(403).json(OFFERING_ACCESS_DENIED);
        }
      }

      // ── Estado del plan y reserva del día, con finalSessionId ya resuelto ──
      // Lo único que bloquea es que la inscripción no exista o no esté activa. Que
      // al atleta le falten clases o tenga el plan vencido NO impide pasar lista:
      // se registra la asistencia y se le informa al entrenador.
      const athlete: AthleteRef = { childId, userId, unregisteredId: unregisteredAthleteId };

      const planStatus = await validatePlanForAttendance(enrollmentId, is_secondary, schoolId!, athlete);
      if (!planStatus.found) {
        return res.status(422).json({ error: 'Enrollment no encontrado.', reason: 'not_found' });
      }

      // Reserva de HOY que esta asistencia puede consumir en lugar de descontar
      // otra clase. Antes se buscaba solo la reserva de ESTA sesión (o de la
      // misma hora exacta en instalaciones): quien reservaba a las 6pm y aparecía
      // en la sesión de las 4pm pagaba dos clases por un solo entrenamiento.
      const freeBooking = (status === 'present' && planStatus.credit)
        ? await findFreeBookingOfDay(schoolId!, athlete, today, is_secondary, finalSessionId)
        : null;

      // Consulta del estado previo para transición de créditos
      let previousStatus: string | null = null;
      if (finalSessionId || teamId) {
        const whereClause = childId
          ? { child_id: childId }
          : userId
            ? { user_id: userId }
            : { unregistered_athlete_id: unregisteredAthleteId };

        if (finalSessionId) {
          const { data: existing } = await supabase
            .from('attendance_records')
            .select('status')
            .eq('session_id', finalSessionId)
            .match(whereClause)
            .maybeSingle();
          previousStatus = existing?.status ?? null;
        }

        if (!previousStatus && teamId) {
          const { data: existingTeam } = await supabase
            .from('attendance_records')
            .select('status')
            .eq('team_id', teamId)
            .eq('attendance_date', today)
            .match(whereClause)
            .maybeSingle();
          previousStatus = existingTeam?.status ?? null;
        }
      }

      const { error: recErr } = await supabase.rpc('upsert_attendance_record', {
        p_school_id:       schoolId,
        p_session_id:      finalSessionId,
        p_attendance_date: today,
        p_status:          status,
        p_team_id:         teamId              || null,
        p_marked_by:       req.user?.id        || null,
        p_child_id:        childId             || null,
        p_user_id:         userId              || null,
        p_unregistered_id: unregisteredAthleteId || null,
      });
      if (recErr) throw recErr;

      // ── Créditos, por transición de estado ───────────────────────────────
      // créditos del día = reservas hechas + asistencias que no encontraron
      // reserva libre. Todo el movimiento del saldo pasa por move_session_credit.
      const wasPresent   = previousStatus === 'present';
      const isNowPresent = status === 'present';
      let credit  = planStatus.credit;
      let outcome: CreditOutcome = 'unchanged';

      if (!wasPresent && isNowPresent) {
        if (!credit) {
          outcome = 'no_plan';
        } else if (freeBooking) {
          // Ya pagó esta clase al reservar: se consume la reserva, no el saldo.
          await consumeBooking(freeBooking);
          outcome = 'covered_by_booking';
        } else if (planStatus.warning) {
          // Sin saldo o vencido: la asistencia queda registrada igual.
          outcome = planStatus.warning === 'expired' ? 'expired' : 'no_credits';
        } else {
          const moved = await moveCredit(credit.id, 1, is_secondary);
          if (moved?.moved) {
            credit = { ...credit, ...pickCreditFields(moved) };
            outcome = 'deducted';
          } else {
            outcome = moved?.reason === 'no_plan' ? 'no_plan' : 'no_credits';
          }
        }
      } else if (wasPresent && !isNowPresent) {
        // Corrección a ausente/tarde/excusado. Si la presencia se había cubierto
        // con una reserva, lo que se devuelve es la reserva (que seguirá viva y
        // se quemará como no-show), no el crédito: ese ya lo cobró la reserva.
        const released = await releaseConsumedBooking(schoolId!, athlete, today, is_secondary, finalSessionId);
        if (released) {
          outcome = 'booking_released';
        } else if (credit) {
          const moved = await moveCredit(credit.id, -1, is_secondary);
          if (moved?.moved) {
            credit = { ...credit, ...pickCreditFields(moved) };
            outcome = 'returned';
          }
        }
      }

      if (fecha.esRetroactiva) {
        await auditLog(req, 'attendance_backdated', 'attendance_sessions', finalSessionId!, null, {
          fecha_registrada: today,
          fecha_real: todayInZone(),
          enrollment_id: enrollmentId,
          status,
          credito: outcome,
        });
      }

      return res.status(201).json({
        success: true,
        sessionId: finalSessionId,
        date: today,
        retroactiva: fecha.esRetroactiva,
        credit_outcome: outcome,
        plan_summary: planSummary(credit, freeBooking),
      });
    } catch (err: any) {
      // TEMPORAL — log detallado
      console.error('WALK-IN ERROR DETAIL:', {
        message: err.message,
        code: err.code,
        details: err.details,
        hint: err.hint,
        body: req.body,
      });
      req.log?.error({ err: err.message || err }, 'Error procesando walk-in');
      return res.status(500).json({ error: 'Error interno procesando el walk-in.' });
    }
  }
);

// ── POST /facturar-fuera-de-plan ─────────────────────────────────────────────
//
// Emite el cobro de las clases que la escuela dictó por fuera del plan. NO es
// automático a propósito: cobrarle a una familia una clase que ya se dictó es
// una conversación, no un cálculo. La escuela decide, atleta por atleta, desde
// la pestaña «Plan vs consumo».
//
// El precio sale del plan que la familia contrató (`price / max_sessions`), que
// es la única cifra defendible cuando el papá pregunta de dónde salió.
//
// Los dos motivos se facturan POR SEPARADO y con conceptos distintos. No es lo
// mismo pasarse del plan que entrenar sin plan vigente: la conversación con la
// familia es otra, y mezclarlos en un solo cargo hace imposible saber después
// qué se cobró. Además, la guarda contra doble cobro es POR MOTIVO — facturar
// el excedente no puede bloquear el cobro de las vencidas, ni al revés.
const CONCEPTOS = {
  excedente: 'Clases por encima del plan',
  vencidas:  'Clases sin plan vigente',
} as const;

router.post('/facturar-fuera-de-plan', requireAuth, requireRole('owner', 'super_admin', 'admin', 'school_admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { schoolId } = req;
      const { month, items } = req.body as {
        month?: string;
        items: { athleteId: string; athleteType: 'child' | 'adult' | 'unregistered';
                 motivo: 'excedente' | 'vencidas';
                 clases: number; precioClase: number; teamId?: string | null;
                 planId?: string | null; nombre?: string; fechas?: string[] }[];
      };

      if (!Array.isArray(items) || !items.length)
        return res.status(400).json({ error: 'No hay atletas para facturar.' });
      if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
        return res.status(400).json({ error: 'El mes debe venir como YYYY-MM.' });

      const [year, mon] = month.split('-').map(Number);
      const ultimoDia = new Date(Date.UTC(year, mon, 0)).getUTCDate();
      const vence = `${month}-${String(ultimoDia).padStart(2, '0')}`;

      const emitidos: any[] = [];
      const omitidos: any[] = [];

      for (const it of items) {
        const concepto = CONCEPTOS[it.motivo];
        if (!it.athleteId || !concepto || !it.clases || it.clases < 1 || !it.precioClase) {
          omitidos.push({ athleteId: it.athleteId, motivo: it.motivo, razon: 'datos_incompletos' });
          continue;
        }

        const col = it.athleteType === 'child' ? 'child_id'
                  : it.athleteType === 'adult' ? 'user_id'
                  : 'unregistered_athlete_id';

        // Guarda contra doble cobro. Es plata: que la escuela le dé dos veces al
        // botón, o que dos personas lo hagan a la vez, no puede duplicar el
        // cargo. La busqueda va por atleta + periodo + ESTE concepto, para que
        // los dos motivos convivan sin taparse.
        const { data: yaExiste } = await supabase
          .from('payments')
          .select('id, amount')
          .eq('school_id', schoolId)
          .eq(col, it.athleteId)
          .eq('period_year', year)
          .eq('period_month', mon)
          .ilike('concept', `${concepto}%`)
          .maybeSingle();

        if (yaExiste) {
          omitidos.push({
            athleteId: it.athleteId, motivo: it.motivo,
            razon: 'ya_facturado', paymentId: (yaExiste as any).id, monto: (yaExiste as any).amount,
          });
          continue;
        }

        const monto = it.clases * it.precioClase;
        // Las fechas van en el concepto: es el soporte que la escuela le muestra
        // a la familia cuando pregunta de dónde salió el cobro.
        const detalleFechas = it.fechas?.length
          ? ` (${it.fechas.map(f => f.slice(8) + '/' + f.slice(5, 7)).join(', ')})`
          : '';

        const { data: creado, error } = await supabase.from('payments').insert({
          school_id:        schoolId,
          [col]:            it.athleteId,
          team_id:          it.teamId ?? null,
          offering_plan_id: it.planId ?? null,
          amount:           monto,
          concept:          `${concepto} — ${monthLabelEs(month)} — ${it.clases} `
                          + `${it.clases === 1 ? 'clase' : 'clases'} × $${it.precioClase.toLocaleString('es-CO')}`
                          + `${detalleFechas}${it.nombre ? ` — ${it.nombre}` : ''}`,
          due_date:         vence,
          status:           'pending',
          payment_type:     'one_time',
          // Explícito: el trigger que rellena el periodo desde due_date manda el
          // cobro al mes siguiente, y este cargo es del mes que se está mirando.
          period_year:      year,
          period_month:     mon,
          // F-E (B3/B7): categoría propia para que pagarlo NO extienda la
          // vigencia del plan ni lo cuente open_month (requiere la migración
          // de F-A), y exento de la unicidad por periodo para convivir con la
          // mensualidad del mismo mes (antes chocaba 23505 en menores).
          payment_category: 'excedente',
          period_uniqueness_exempt: true,
        }).select('id').single();

        if (error) {
          // B7: el SELECT de arriba no cierra la carrera (doble clic, dos
          // pestañas). La cierra el índice único uniq_payment_out_of_plan_classes
          // (migración 20261005214302): el segundo INSERT choca y se informa
          // como ya facturado, no como error.
          if ((error as any).code === '23505') {
            omitidos.push({ athleteId: it.athleteId, motivo: it.motivo, razon: 'ya_facturado' });
            continue;
          }
          omitidos.push({ athleteId: it.athleteId, motivo: it.motivo, razon: 'error', detalle: error.message });
          continue;
        }

        emitidos.push({ athleteId: it.athleteId, motivo: it.motivo, paymentId: (creado as any).id, monto, clases: it.clases });
        await auditLog(req, 'billed_out_of_plan_classes', 'payments', (creado as any).id, null, {
          mes: month, motivo: it.motivo, clases: it.clases,
          precio_clase: it.precioClase, monto, fechas: it.fechas ?? null,
        });
      }

      return res.json({
        success: true,
        emitidos: emitidos.length,
        omitidos: omitidos.length,
        total: emitidos.reduce((s, e) => s + e.monto, 0),
        detalle: { emitidos, omitidos },
      });
    } catch (err: any) {
      req.log?.error({ err: err.message || err }, 'Error facturando clases fuera de plan');
      return res.status(500).json({ error: 'Error interno emitiendo los cobros.' });
    }
  }
);

// ── PATCH /session/:sessionId/reopen ─────────────────────────────────────────
//
// Finalizar dejó de ser irreversible. Antes no había forma de deshacerlo: ni
// ruta, ni RPC. Y como `auto_finalize_stale_sessions` cierra cada noche todo lo
// que tenga fecha anterior a hoy, una lista mal llena quedaba mal para siempre.
//
// Se reabre solo dentro de la ventana de quien lo pide — la misma regla que
// para escribir. Ojo con una consecuencia natural: el cron la vuelve a cerrar
// esta noche, así que la corrección hay que terminarla el mismo día.
router.patch('/session/:sessionId/reopen', requireAuth, requireRole('owner', 'super_admin', 'admin', 'school_admin', 'coach'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const sessionId = req.params.sessionId as string;
      const { data: session, error: fetchErr } = await supabase
        .from('attendance_sessions')
        .select('id, finalized, session_date, team_id, offering_id, school_id')
        .eq('id', sessionId)
        .single();
      if (fetchErr || !session) return res.status(404).json({ error: 'Sesión no encontrada.' });
      if (session.school_id !== req.schoolId)
        return res.status(404).json({ error: 'Sesión no encontrada.' });
      if (session.team_id && !(await assertCoachHasTeamAccess(req, session.team_id))) {
        return res.status(403).json(TEAM_ACCESS_DENIED);
      }
      if (!session.team_id && session.offering_id && !(await assertCoachHasOfferingAccess(req, session.offering_id))) {
        return res.status(403).json(OFFERING_ACCESS_DENIED);
      }
      if (!session.finalized)
        return res.status(409).json({ error: 'Esa sesión ya está abierta.', reason: 'not_finalized' });

      // La ventana se evalúa contra la fecha de la sesión: reabrir el martes
      // pasado es tan retroactivo como escribirlo.
      const permiso = await resolverFechaDeTrabajo(session.session_date, req.role, req.schoolId);
      if (!permiso.ok) return res.status(permiso.status).json(permiso.body);

      const { error: updErr } = await supabase
        .from('attendance_sessions')
        .update({ finalized: false, finalized_at: null, finalized_by: null, updated_at: new Date().toISOString() })
        .eq('id', sessionId);
      if (updErr) throw updErr;

      await auditLog(req, 'attendance_session_reopened', 'attendance_sessions', sessionId, null, {
        session_date: session.session_date,
        team_id: session.team_id,
      });

      return res.json({
        success: true,
        sessionId,
        date: session.session_date,
        aviso: 'La sesión quedó abierta. El cierre automático la vuelve a finalizar esta noche.',
      });
    } catch (err: any) {
      req.log?.error({ err: err.message || err }, 'Error reabriendo sesión de asistencia');
      return res.status(500).json({ error: 'Error interno reabriendo la sesión.' });
    }
  }
);

// PATCH /session/:sessionId/finalize — finaliza la sesión.
router.patch('/session/:sessionId/finalize', requireAuth, requireRole('owner', 'super_admin', 'admin', 'school_admin', 'coach'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const { data: session, error: fetchErr } = await supabase.from('attendance_sessions').select('id, finalized, team_id, offering_id, school_id').eq('id', sessionId).single();
      if (fetchErr || !session) return res.status(404).json({ error: 'Sesión no encontrada.' });
      // SEG-33: igual que reopen, solo sesiones de la escuela del caller.
      if (session.school_id !== req.schoolId)
        return res.status(404).json({ error: 'Sesión no encontrada.' });
      if (session.team_id && !(await assertCoachHasTeamAccess(req, session.team_id))) {
        return res.status(403).json(TEAM_ACCESS_DENIED);
      }
      if (!session.team_id && session.offering_id && !(await assertCoachHasOfferingAccess(req, session.offering_id))) {
        return res.status(403).json(OFFERING_ACCESS_DENIED);
      }
      if (session.finalized) return res.status(409).json({ error: 'La sesión ya estaba finalizada.' });

      const { data: bookingsPreview } = await supabase.from('session_bookings')
        .select('id, user_id, child_id, unregistered_athlete_id, is_secondary, booking_type, enrollment_id')
        .eq('session_id', sessionId).eq('status', 'confirmed');

      const { error: updateErr } = await supabase.from('attendance_sessions')
        .update({ finalized: true, finalized_at: new Date().toISOString(), finalized_by: req.user?.id })
        .eq('id', sessionId);
      if (updateErr) throw updateErr;

      // Pieza D (docs/specs/asistencia-rapida-checkin.md §4.2): a quien tenía
      // inscripción activa y quedó sin registro se lo marca ausente y se avisa.
      // Nunca debe tumbar la finalización ya confirmada arriba.
      let ausenciasMarcadas = 0;
      try {
        const { data: absResult } = await supabase.rpc('mark_session_absences', { p_session_id: sessionId });
        ausenciasMarcadas = (absResult as any)?.marked ?? 0;
      } catch (err) {
        req.log?.error({ err }, 'mark_session_absences falló al finalizar (no bloquea)');
      }

      return res.json({
        success: true, message: 'Sesión finalizada correctamente.',
        summary: {
          bookings_processed: bookingsPreview?.length ?? 0,
          details: (bookingsPreview || []).map((b: any) => ({ booking_id: b.id, booking_type: b.booking_type, is_secondary: b.is_secondary })),
          ausencias_marcadas: ausenciasMarcadas,
        },
      });
    } catch (err: any) {
      req.log?.error({ err: err.message || err }, 'Error finalizando sesión');
      return res.status(500).json({ error: 'Error interno finalizando la sesión.' });
    }
  }
);

// GET /rate/:teamId — porcentaje de asistencia para reportes.
router.get('/rate/:teamId', requireAuth, requireRole('owner', 'super_admin', 'admin', 'school_admin', 'coach'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const teamId = req.params.teamId as string;
      if (!(await assertCoachHasTeamAccess(req, teamId))) {
        return res.status(403).json(TEAM_ACCESS_DENIED);
      }
      const { data, error } = await supabase.from('attendance_records').select('status').eq('team_id', teamId);
      if (error) throw error;
      const total = data?.length || 0;
      const present = data?.filter((r: any) => r.status === 'present' || r.status === 'late').length || 0;
      return res.json({ rate: total > 0 ? Math.round((present / total) * 100) : 0 });
    } catch (err: any) {
      req.log?.error({ err: err.message || err }, 'Error calculando asistencia');
      return res.status(500).json({ error: 'Error interno calculando asistencia.', rate: 0 });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /history?month=YYYY-MM[&teamId=&offeringId=]
//
// Histórico de asistencia de la escuela para un mes. Devuelve las tres vistas
// que necesita el panel en una sola llamada: consolidado por atleta, consolidado
// por día, y la matriz atleta × día. Solo lectura: no toca créditos ni sesiones.
//
// El rol coach queda fuera a propósito: esto es el mes completo de TODA la
// escuela, no de sus equipos.
// ─────────────────────────────────────────────────────────────────────────────

type HistoryRecord = {
  attendance_date: string;
  status: string;
  child_id: string | null;
  user_id: string | null;
  unregistered_athlete_id: string | null;
  team_id: string | null;
  session_id: string | null;
  /** Auth uid de quien pasó la lista. Es la única cara del entrenador que nunca
      viene nula: `attendance_sessions.coach_id` sí lo está cuando marca la
      administración desde el panel. */
  marked_by: string | null;
};

/** El cliente de Supabase corta en 1000 filas: un mes de una escuela grande son más. */
async function fetchAllAttendanceRecords(
  schoolId: string, from: string, to: string,
): Promise<HistoryRecord[]> {
  const PAGE = 1000;
  const out: HistoryRecord[] = [];

  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from('attendance_records')
      .select('attendance_date, status, child_id, user_id, unregistered_athlete_id, team_id, session_id, marked_by')
      .eq('school_id', schoolId)
      .gte('attendance_date', from)
      .lte('attendance_date', to)
      // `id` como desempate: sin orden único, dos páginas pueden repetir o
      // saltarse filas del mismo día y el consolidado sale mal.
      .order('attendance_date', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);

    if (error) throw error;
    out.push(...((data || []) as HistoryRecord[]));
    if (!data || data.length < PAGE) return out;
  }
}

/** id → full_name, en lotes, para no armar un `in()` de miles de ids. */
async function fetchNames(table: string, ids: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase
      .from(table).select('id, full_name').in('id', ids.slice(i, i + CHUNK));
    if (error) throw error;
    for (const row of data || []) map[(row as any).id] = (row as any).full_name;
  }
  return map;
}

// El % de asistencia cuenta `present` + `late` como asistió, igual que /rate y
// el reporte del coach, para que los tres números coincidan entre pantallas.

/** Un atleta puede tener dos registros el mismo día (equipo + instalación). */
const STATUS_RANK: Record<string, number> = { present: 4, late: 3, excused: 2, absent: 1 };

/**
 * El enum `attend_status` trae 'justified' además de 'excused', y la UI solo
 * ofrece los cuatro estados de siempre. Sin normalizar, las columnas no suman
 * el total y la falta justificada vieja desaparece del informe.
 */
type NormalStatus = 'present' | 'absent' | 'late' | 'excused';
const normalizeStatus = (s: string): NormalStatus =>
  s === 'present' ? 'present'
    : s === 'late' ? 'late'
      : s === 'excused' || s === 'justified' ? 'excused'
        : 'absent';

router.get('/history', requireAuth, requireRole('owner', 'super_admin', 'admin', 'school_admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { schoolId } = req;
      if (!schoolId) return res.status(400).json({ error: 'Falta el contexto de escuela.' });
      const r = await historialDeAsistencia(schoolId, req.query as Record<string, unknown>);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      return res.json(r.datos);
    } catch (err: any) {
      req.log?.error({ err: err.message || err }, 'Error obteniendo histórico de asistencia');
      return res.status(500).json({ error: 'Error interno obteniendo el histórico de asistencia.' });
    }
  }
);

/**
 * El histórico de asistencia de la escuela (la respuesta de GET /history), sin
 * Express: lo usan esa ruta y el reporte de asistencia de Mapi
 * (services/mapi-agente/herramientas/informes.ts). Recibe los mismos parámetros
 * de la query: `month` (AAAA-MM o 'all'), `fromMonth`/`toMonth`, `teamId`,
 * `offeringId` y `coachId`. Solo lectura. Quien llama valida el rol: la ruta
 * deja fuera al coach y Mapi solo se lo da filtrado por uno de sus equipos.
 */
export async function historialDeAsistencia(schoolId: string, query: Record<string, unknown>) {
  // Un mes (`month=YYYY-MM`, lo de siempre) o un rango de meses
  // (`fromMonth`/`toMonth`, o `month=all` = desde la primera lista de la
  // escuela). Carmel pidió ver "todos los meses" juntos, no mes por mes.
  const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
  const thisMonth = todayString().slice(0, 7);
  const monthParam = (query.month as string) ?? '';
  let fromMonth: string;
  let toMonth: string;
  if (monthParam === 'all') {
    const { data: first } = await supabase
      .from('attendance_records')
      .select('attendance_date')
      .eq('school_id', schoolId)
      .order('attendance_date', { ascending: true })
      .limit(1)
      .maybeSingle();
    fromMonth = ((first as any)?.attendance_date ?? todayString()).slice(0, 7);
    toMonth = thisMonth;
  } else if (YM.test(String(query.fromMonth ?? '')) && YM.test(String(query.toMonth ?? ''))) {
    fromMonth = String(query.fromMonth);
    toMonth = String(query.toMonth);
    if (fromMonth > toMonth) [fromMonth, toMonth] = [toMonth, fromMonth];
  } else {
    fromMonth = toMonth = YM.test(monthParam) ? monthParam : thisMonth;
  }
  // Tope de 24 meses: más que eso es un volcado, no un informe.
  const [fy, fm] = fromMonth.split('-').map(Number);
  const [ty, tm] = toMonth.split('-').map(Number);
  if ((ty - fy) * 12 + (tm - fm) >= 24) {
    return { ok: false as const, status: 400 as const, error: 'El rango máximo es de 24 meses.' };
  }
  const isRange = fromMonth !== toMonth;
  const month = fromMonth;

  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const from = `${fromMonth}-01`;
  const to = `${toMonth}-${String(lastDay).padStart(2, '0')}`;

  const teamFilter = (query.teamId as string) || null;
  const offeringFilter = (query.offeringId as string) || null;
  // `coachId` es un school_staff.id. Para filtrar hacen falta las dos caras:
  // quién quedó asignado a la sesión (`attendance_sessions.coach_id`, que es
  // FK a school_staff) y quién efectivamente pasó lista (`marked_by`, que es
  // el auth uid). No alcanza con una: 11 de las 33 sesiones de Dynasty
  // tienen coach_id nulo porque las marcó la dueña desde el panel, y al revés
  // un coach puede figurar asignado y que haya marcado un reemplazo.
  const coachFilter = (query.coachId as string) || null;
  let coachAuthId: string | null = null;
  if (coachFilter) {
    const { data: staff } = await supabase
      .from('school_staff')
      .select('coach_auth_id')
      .eq('id', coachFilter)
      .eq('school_id', schoolId)
      .maybeSingle();
    coachAuthId = (staff as any)?.coach_auth_id ?? null;
  }

  let records = await fetchAllAttendanceRecords(schoolId, from, to);

  // ── Contexto de cada registro ────────────────────────────────────────
  // team_id viene directo en el registro; las asistencias de planes e
  // instalaciones solo se pueden ubicar a través de su sesión.
  const sessionIds = [...new Set(records.map(r => r.session_id).filter(Boolean))] as string[];
  const sessionCtx: Record<string, { team_id: string | null; offering_id: string | null; facility_id: string | null; coach_id: string | null }> = {};

  if (sessionIds.length) {
    const CHUNK = 300;
    for (let i = 0; i < sessionIds.length; i += CHUNK) {
      const { data, error } = await supabase
        .from('attendance_sessions')
        .select('id, team_id, offering_id, facility_id, coach_id')
        .in('id', sessionIds.slice(i, i + CHUNK));
      if (error) throw error;
      for (const s of data || []) {
        sessionCtx[(s as any).id] = {
          team_id: (s as any).team_id ?? null,
          offering_id: (s as any).offering_id ?? null,
          facility_id: (s as any).facility_id ?? null,
          coach_id: (s as any).coach_id ?? null,
        };
      }
    }
  }

  const ctxOf = (r: HistoryRecord) => {
    const s = r.session_id ? sessionCtx[r.session_id] : undefined;
    return {
      teamId: r.team_id ?? s?.team_id ?? null,
      offeringId: s?.offering_id ?? null,
      facilityId: s?.facility_id ?? null,
      coachId: s?.coach_id ?? null,
    };
  };

  if (teamFilter) records = records.filter(r => ctxOf(r).teamId === teamFilter);
  if (offeringFilter) records = records.filter(r => ctxOf(r).offeringId === offeringFilter);
  if (coachFilter) {
    records = records.filter(r =>
      ctxOf(r).coachId === coachFilter
      || (!!coachAuthId && r.marked_by === coachAuthId));
  }

  // ── Identidad precargada ya vinculada a una cuenta ───────────────────
  // La asistencia se escribe sobre la columna con la que se pasó lista, así
  // que un atleta que la escuela precargó sigue apareciendo por
  // `unregistered_athlete_id` aunque después haya creado su cuenta. Mirar
  // solo la columna rotulaba "Sin cuenta" a gente que sí la tiene (caso real:
  // DAIMARIS VASQUEZ PEREZ = Dai Vázquez), y si además tiene asistencias bajo
  // su perfil el mes se le parte en dos filas. `linked_profile_id` manda.
  const rawUnregIds = [...new Set(records.map(r => r.unregistered_athlete_id).filter(Boolean))] as string[];
  const unregMeta: Record<string, { full_name: string; linked_profile_id: string | null }> = {};

  if (rawUnregIds.length) {
    const CHUNK = 300;
    for (let i = 0; i < rawUnregIds.length; i += CHUNK) {
      const { data, error } = await supabase
        .from('unregistered_athletes')
        .select('id, full_name, linked_profile_id')
        .in('id', rawUnregIds.slice(i, i + CHUNK));
      if (error) throw error;
      for (const u of data || []) {
        unregMeta[(u as any).id] = {
          full_name: (u as any).full_name,
          linked_profile_id: (u as any).linked_profile_id ?? null,
        };
      }
    }
  }

  /** Identidad con la que se agrupa: la cuenta vinculada gana sobre la precargada. */
  const athleteIdOf = (r: HistoryRecord): string | null =>
    r.child_id
    ?? r.user_id
    ?? (r.unregistered_athlete_id
      ? unregMeta[r.unregistered_athlete_id]?.linked_profile_id ?? r.unregistered_athlete_id
      : null);

  // ── Nombres (atletas y contextos) ────────────────────────────────────
  const childIds = [...new Set(records.map(r => r.child_id).filter(Boolean))] as string[];
  const linkedProfileIds = rawUnregIds
    .map(id => unregMeta[id]?.linked_profile_id)
    .filter(Boolean) as string[];
  const userIds = [...new Set([
    ...records.map(r => r.user_id).filter(Boolean) as string[],
    ...linkedProfileIds,
  ])];
  const unregIds = rawUnregIds;

  const teamIds = [...new Set(records.map(r => ctxOf(r).teamId).filter(Boolean))] as string[];
  const offeringIds = [...new Set(records.map(r => ctxOf(r).offeringId).filter(Boolean))] as string[];
  const facilityIds = [...new Set(records.map(r => ctxOf(r).facilityId).filter(Boolean))] as string[];

  const [childNames, userNames, unregNames, teamNames, offeringNames, facilityNames] = await Promise.all([
    childIds.length ? fetchNames('children', childIds) : Promise.resolve({} as Record<string, string>),
    userIds.length ? fetchNames('profiles', userIds) : Promise.resolve({} as Record<string, string>),
    unregIds.length ? fetchNames('unregistered_athletes', unregIds) : Promise.resolve({} as Record<string, string>),
    teamIds.length
      ? supabase.from('teams').select('id, name').in('id', teamIds)
          .then(({ data }) => Object.fromEntries((data || []).map((t: any) => [t.id, t.name])))
      : Promise.resolve({} as Record<string, string>),
    offeringIds.length
      ? supabase.from('offerings').select('id, name').in('id', offeringIds)
          .then(({ data }) => Object.fromEntries((data || []).map((o: any) => [o.id, o.name])))
      : Promise.resolve({} as Record<string, string>),
    facilityIds.length
      ? supabase.from('facilities').select('id, name').in('id', facilityIds)
          .then(({ data }) => Object.fromEntries((data || []).map((f: any) => [f.id, f.name])))
      : Promise.resolve({} as Record<string, string>),
  ]);

  // ── Agregación ───────────────────────────────────────────────────────
  type AthleteRow = {
    id: string; athlete_type: 'child' | 'adult' | 'unregistered'; full_name: string;
    /** Otros nombres de la misma persona (p.ej. como la precargó la escuela). */
    aliases: string[];
    contexts: string[]; present: number; absent: number; late: number; excused: number;
    total: number; rate: number; by_day: Record<string, string>;
    /** Conteo por mes (YYYY-MM): la tabla "Por atleta" en modo rango. */
    by_month: Record<string, { present: number; absent: number; late: number; excused: number; total: number }>;
  };

  const athletes = new Map<string, AthleteRow & { _ctx: Set<string>; _aliases: Set<string> }>();
  // Agregado por contexto (equipo / oferta / instalación), para el bloque
  // "Asistencia del mes" del reporte gerencial: "% por equipo" no se puede
  // reconstruir desde `athletes[].contexts` sin contar dos veces a quien
  // está en dos equipos (Carmel: categoría + arqueros).
  const byContext = new Map<string, {
    name: string; present: number; absent: number; late: number; excused: number;
    total: number; rate: number; _athletes: Set<string>;
  }>();
  const days = new Map<string, {
    date: string; present: number; absent: number; late: number; excused: number;
    total: number; athletes: number; rate: number; _athletes: Set<string>;
  }>();
  const months = new Map<string, {
    month: string; present: number; absent: number; late: number; excused: number;
    total: number; athletes: number; days: number; rate: number;
    _athletes: Set<string>; _days: Set<string>;
  }>();

  for (const r of records) {
    const id = athleteIdOf(r);
    if (!id) continue;

    const linked = r.unregistered_athlete_id
      ? unregMeta[r.unregistered_athlete_id]?.linked_profile_id ?? null
      : null;

    // "Sin cuenta" solo si de verdad no hay cuenta detrás.
    const athleteType = r.child_id ? 'child'
      : r.user_id || linked ? 'adult'
        : 'unregistered';

    // Con cuenta vinculada manda el nombre del perfil, que es la identidad
    // que sobrevive; el nombre precargado se guarda como alias para que la
    // escuela siga encontrándola buscando como ella la escribió.
    const unregName = r.unregistered_athlete_id
      ? unregNames[r.unregistered_athlete_id] ?? unregMeta[r.unregistered_athlete_id]?.full_name
      : undefined;
    const fullName = (r.child_id ? childNames[r.child_id]
      : r.user_id ? userNames[r.user_id]
      : linked ? userNames[linked] ?? unregName
        : unregName) ?? 'Sin nombre';
    const alias = linked && unregName && unregName !== fullName ? unregName : null;

    const ctx = ctxOf(r);
    const ctxLabel = (ctx.teamId && teamNames[ctx.teamId])
      || (ctx.offeringId && offeringNames[ctx.offeringId])
      || (ctx.facilityId && facilityNames[ctx.facilityId])
      || null;

    let row = athletes.get(id);
    if (!row) {
      row = {
        id, athlete_type: athleteType, full_name: fullName, aliases: [], contexts: [],
        present: 0, absent: 0, late: 0, excused: 0, total: 0, rate: 0,
        by_day: {}, by_month: {}, _ctx: new Set<string>(), _aliases: new Set<string>(),
      };
      athletes.set(id, row);
    }
    if (ctxLabel) row._ctx.add(ctxLabel);
    if (alias) row._aliases.add(alias);

    let day = days.get(r.attendance_date);
    if (!day) {
      day = {
        date: r.attendance_date, present: 0, absent: 0, late: 0, excused: 0,
        total: 0, athletes: 0, rate: 0, _athletes: new Set<string>(),
      };
      days.set(r.attendance_date, day);
    }
    day._athletes.add(id);

    const status = normalizeStatus(r.status);
    row[status] += 1;
    day[status] += 1;
    row.total += 1;
    day.total += 1;

    const ym = r.attendance_date.slice(0, 7);
    let mrow = months.get(ym);
    if (!mrow) {
      mrow = {
        month: ym, present: 0, absent: 0, late: 0, excused: 0, total: 0,
        athletes: 0, days: 0, rate: 0, _athletes: new Set<string>(), _days: new Set<string>(),
      };
      months.set(ym, mrow);
    }
    mrow[status] += 1;
    mrow.total += 1;
    mrow._athletes.add(id);
    mrow._days.add(r.attendance_date);
    const am = (row.by_month[ym] ??= { present: 0, absent: 0, late: 0, excused: 0, total: 0 });
    am[status] += 1;
    am.total += 1;

    if (ctxLabel) {
      let ctxRow = byContext.get(ctxLabel);
      if (!ctxRow) {
        ctxRow = {
          name: ctxLabel, present: 0, absent: 0, late: 0, excused: 0,
          total: 0, rate: 0, _athletes: new Set<string>(),
        };
        byContext.set(ctxLabel, ctxRow);
      }
      ctxRow[status] += 1;
      ctxRow.total += 1;
      ctxRow._athletes.add(id);
    }

    // En la matriz manda el mejor estado del día: quien faltó a un equipo
    // pero entrenó en la instalación asistió ese día.
    const prev = row.by_day[r.attendance_date];
    if (!prev || STATUS_RANK[status] > (STATUS_RANK[prev] ?? 0)) {
      row.by_day[r.attendance_date] = status;
    }
  }

  const athleteRows: AthleteRow[] = [...athletes.values()]
    .map(({ _ctx, _aliases, ...row }) => ({
      ...row,
      contexts: [..._ctx].sort(),
      aliases: [..._aliases].sort(),
      rate: row.total > 0 ? Math.round(((row.present + row.late) / row.total) * 100) : 0,
    }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name, 'es'));

  const dayRows = [...days.values()]
    .map(({ _athletes, ...day }) => ({
      ...day,
      athletes: _athletes.size,
      rate: day.total > 0 ? Math.round(((day.present + day.late) / day.total) * 100) : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const monthRows = [...months.values()]
    .map(({ _athletes, _days, ...m }) => ({
      ...m,
      athletes: _athletes.size,
      days: _days.size,
      rate: m.total > 0 ? Math.round(((m.present + m.late) / m.total) * 100) : 0,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const contextRows = [...byContext.values()]
    .map(({ _athletes, ...ctx }) => ({
      ...ctx,
      athletes: _athletes.size,
      rate: ctx.total > 0 ? Math.round(((ctx.present + ctx.late) / ctx.total) * 100) : 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  // ── Plan vs consumo ──────────────────────────────────────────────────
  //
  // La asistencia se registra SIEMPRE, tenga saldo o no: es deliberado
  // (dejar constancia de que el atleta vino y cobrarle la clase son cosas
  // distintas). El efecto secundario es que nadie ve el desfase, y la
  // escuela termina regalando clases sin enterarse.
  //
  // Se cuenta contra las asistencias DEL MES, no contra `sessions_used`:
  // ese contador es acumulado y nunca se resetea, así que comparado con un
  // tope mensual miente a partir del segundo mes.
  const idsPorTipo = {
    child: athleteRows.filter(a => a.athlete_type === 'child').map(a => a.id),
    adult: athleteRows.filter(a => a.athlete_type === 'adult').map(a => a.id),
    unreg: athleteRows.filter(a => a.athlete_type === 'unregistered').map(a => a.id),
  };

  const planPorAtleta: Record<string, any> = {};
  // El tope del plan es MENSUAL: contra un rango de varios meses casi todos
  // saldrían "excedidos". En modo rango no se calcula ni se ofrece facturar.
  for (const [tipo, ids] of isRange ? [] : Object.entries(idsPorTipo)) {
    if (!ids.length) continue;
    const col = tipo === 'child' ? 'child_id' : tipo === 'adult' ? 'user_id' : 'unregistered_athlete_id';
    const { data } = await supabase
      .from('enrollments')
      .select(`id, child_id, user_id, unregistered_athlete_id, team_id, expires_at, sessions_used,
        offering_plan_id,
        offering_plans!enrollments_offering_plan_id_fkey(name, max_sessions, price, currency)`)
      .eq('school_id', schoolId)
      .eq('status', 'active')
      .in(col, ids);
    for (const e of (data || []) as any[]) {
      const key = e.child_id ?? e.user_id ?? e.unregistered_athlete_id;
      // Si tiene varias, gana la de tope más alto: es la que mejor explica
      // cuántas clases le corresponden en el mes.
      const tope = e.offering_plans?.max_sessions ?? null;
      const prev = planPorAtleta[key];
      if (!prev || (tope ?? 0) > (prev.tope ?? 0)) {
        const precio = Number(e.offering_plans?.price ?? 0);
        planPorAtleta[key] = {
          enrollment_id: e.id,
          plan_id: e.offering_plan_id ?? null,
          team_id: e.team_id ?? null,
          nombre: e.offering_plans?.name ?? null,
          tope,
          // Lo que vale una clase suelta de ESE plan. Es la única cifra
          // defendible frente a la familia: sale del plan que contrató, no
          // de una tarifa inventada.
          precio_clase: tope && tope > 0 ? Math.round(precio / tope) : null,
          moneda: e.offering_plans?.currency ?? 'COP',
          vence: e.expires_at ?? null,
          descontadas: e.sessions_used ?? 0,
        };
      }
    }
  }

  for (const row of (isRange ? [] : athleteRows) as any[]) {
    const p = planPorAtleta[row.id];
    const asistidas = row.present + row.late;
    if (!p) {
      // MISMA forma que la rama con plan. Antes esta emitia `excedente: 0`
      // como NUMERO mientras la otra emitia objetos, y la pantalla —que
      // incluye a los `sin_plan` en el desglose— hacia `cubo.fechas.length`
      // sobre un 0. Tumbaba el histórico entero con un ErrorBoundary.
      const vacio = { clases: 0, valor: null, fechas: [] as string[] };
      row.plan = {
        estado: 'sin_plan', nombre: null, tope: null, vence: null, descontadas: 0,
        asistidas, cubiertas: 0, precio_clase: null, moneda: 'COP',
        excedente: { ...vacio }, vencidas: { ...vacio },
        fuera_de_plan: 0, valor: null,
      };
      continue;
    }
    // ── Clasificación clase por clase, en cubos EXCLUYENTES ────────────
    //
    // Una clase cae en uno y solo uno: o está cubierta, o se pasó del tope,
    // o el plan ya había vencido. Si el plan vencía el 5 y entrenó el 11, esa
    // clase NO es "excedente" — el tope ni siquiera aplica ya. Contarla en
    // los dos cubos la facturaría dos veces, que es justo lo que no puede
    // pasar cuando esto emite cobros.
    //
    // Se ordena por fecha porque el tope se consume en orden: las primeras 8
    // están cubiertas y de la 9 en adelante son excedente.
    const diasAsistidos = Object.entries(row.by_day as Record<string, string>)
      .filter(([, st]) => st === 'present' || st === 'late')
      .map(([fecha]) => fecha)
      .sort();

    const diasVigentes = p.vence ? diasAsistidos.filter(f => f <= p.vence) : diasAsistidos;
    const vencidas   = diasAsistidos.length - diasVigentes.length;
    const excedente  = p.tope !== null ? Math.max(diasVigentes.length - p.tope, 0) : 0;
    const cubiertas  = diasVigentes.length - excedente;

    // Ahora SÍ se suman: son disjuntos por construcción.
    const fueraDePlan = excedente + vencidas;
    const precio = p.precio_clase;

    row.plan = {
      nombre: p.nombre, tope: p.tope, vence: p.vence, descontadas: p.descontadas,
      asistidas, cubiertas,
      precio_clase: precio, moneda: p.moneda,
      // Los dos conceptos van separados hasta el final: se muestran, se
      // valorizan y se facturan por su cuenta.
      excedente:   { clases: excedente, valor: precio ? excedente * precio : null,
                     fechas: diasVigentes.slice(p.tope ?? 0) },
      vencidas:    { clases: vencidas,  valor: precio ? vencidas  * precio : null,
                     fechas: p.vence ? diasAsistidos.filter(f => f > p.vence) : [] },
      fuera_de_plan: fueraDePlan,
      valor: precio ? fueraDePlan * precio : null,
      enrollment_id: p.enrollment_id, plan_id: p.plan_id, team_id: p.team_id,
      estado: fueraDePlan > 0 ? (vencidas > 0 ? 'vencido' : 'excedido') : 'ok',
    };
  }

  const desfases = isRange ? null : {
    excedidos:      (athleteRows as any[]).filter(a => a.plan?.estado === 'excedido').length,
    con_vencido:    (athleteRows as any[]).filter(a => a.plan?.estado === 'vencido').length,
    sin_plan:       (athleteRows as any[]).filter(a => a.plan?.estado === 'sin_plan').length,
    clases_de_mas:   (athleteRows as any[]).reduce((s, a) => s + (a.plan?.excedente?.clases ?? 0), 0),
    clases_vencidas: (athleteRows as any[]).reduce((s, a) => s + (a.plan?.vencidas?.clases ?? 0), 0),
    valor_excedente: (athleteRows as any[]).reduce((s, a) => s + (a.plan?.excedente?.valor ?? 0), 0),
    valor_vencidas:  (athleteRows as any[]).reduce((s, a) => s + (a.plan?.vencidas?.valor ?? 0), 0),
    valor_total:     (athleteRows as any[]).reduce((s, a) => s + (a.plan?.valor ?? 0), 0),
  };

  const totals = athleteRows.reduce(
    (acc, a) => ({
      records: acc.records + a.total,
      present: acc.present + a.present,
      absent: acc.absent + a.absent,
      late: acc.late + a.late,
      excused: acc.excused + a.excused,
    }),
    { records: 0, present: 0, absent: 0, late: 0, excused: 0 },
  );

  return {
    ok: true as const,
    datos: {
      month, from, to,
      range: { from: fromMonth, to: toMonth, is_range: isRange },
      months: monthRows,
      days: dayRows,
      athletes: athleteRows,
      contexts: contextRows,
      desfases,
      totals: {
        ...totals,
        rate: totals.records > 0
          ? Math.round(((totals.present + totals.late) / totals.records) * 100)
          : 0,
        athletes: athleteRows.length,
        days: dayRows.length,
      },
    },
  };
}

// GET /school-roster?search=nombre — busca cualquier atleta con enrollment activo
// en la escuela, sin importar el plan/offering. Usado por el walk-in de instalaciones,
// donde cualquier persona con crédito primario puede aparecer en cualquier bloque.
router.get('/school-roster', requireAuth, requireRole('owner', 'super_admin', 'admin', 'school_admin', 'coach'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { schoolId } = req;
      const search = ((req.query.search as string) ?? '').trim();
      if (search.length < 2) return res.json({ athletes: [] });

      const { data: enrollmentsRaw, error } = await supabase
        .from('enrollments')
        .select(`id, child_id, user_id, unregistered_athlete_id, expires_at, sessions_used,
          offering_plans!enrollments_offering_plan_id_fkey(name, max_sessions, price, currency)`)
        .eq('school_id', schoolId)
        .eq('status', 'active')
        .limit(500); // filtramos por nombre en memoria tras resolver los nombres

      if (error) throw error;
      if (!enrollmentsRaw?.length) return res.json({ athletes: [] });

      // Un pausado por vacaciones no se puede marcar por carnet/QR: se saca de
      // la búsqueda igual que del roster del equipo, o el entrenador lo
      // encontraría acá y le descontaría un crédito de un plan en pausa.
      const pausadasSR = await pausedEnrollmentIds(schoolId as string, todayInZone());
      const enrollments = enrollmentsRaw.filter((e: any) => !pausadasSR.has(e.id));
      if (!enrollments.length) return res.json({ athletes: [] });

      const childIds = enrollments.filter((e: any) => e.child_id).map((e: any) => e.child_id);
      const userIds = enrollments.filter((e: any) => e.user_id).map((e: any) => e.user_id);
      const unregIds = enrollments.filter((e: any) => e.unregistered_athlete_id).map((e: any) => e.unregistered_athlete_id);

      const [childRes, profileRes, unregRes] = await Promise.all([
        childIds.length ? supabase.from('children').select('id, full_name, avatar_url').in('id', childIds) : Promise.resolve({ data: [] }),
        userIds.length ? supabase.from('profiles').select('id, full_name, avatar_url').in('id', userIds) : Promise.resolve({ data: [] }),
        unregIds.length ? supabase.from('unregistered_athletes').select('id, full_name').in('id', unregIds) : Promise.resolve({ data: [] }),
      ]);
      const childMap = Object.fromEntries((childRes.data || []).map((x: any) => [x.id, x]));
      const profileMap = Object.fromEntries((profileRes.data || []).map((x: any) => [x.id, x]));
      const unregMap = Object.fromEntries((unregRes.data || []).map((x: any) => [x.id, x]));
      const today = todayInZone();
      const q = search.toLowerCase();

      const athletes = enrollments
        .map((e: any) => {
          const athleteId = e.child_id ?? e.user_id ?? e.unregistered_athlete_id;
          const athleteType = e.child_id ? 'child' : e.user_id ? 'adult' : 'unregistered';
          const person = e.child_id ? childMap[e.child_id] : e.user_id ? profileMap[e.user_id] : unregMap[e.unregistered_athlete_id];
          const plan = e.offering_plans;
          const maxSess = plan?.max_sessions ?? null;
          const used = e.sessions_used ?? 0;
          return {
            id: athleteId,
            full_name: person?.full_name ?? 'Sin nombre',
            avatar_url: person?.avatar_url ?? null,
            athlete_type: athleteType,
            enrollment_id: e.id,
            plan: plan ? {
              name: plan.name,
              expires_at: e.expires_at ?? null,
              is_expired: e.expires_at ? e.expires_at < today : false,
              sessions_used: used,
              max_sessions: maxSess,
              sessions_remaining: maxSess !== null ? Math.max(0, maxSess - used) : null,
              price: plan.price, currency: plan.currency,
            } : null,
          };
        })
        .filter((a: any) => a.full_name.toLowerCase().includes(q))
        .slice(0, 20);

      return res.json({ athletes });
    } catch (err: any) {
      req.log?.error({ err: err.message || err }, 'Error buscando school-roster');
      return res.status(500).json({ error: 'Error interno buscando atletas.' });
    }
  }
);

// POST /quick-guest — crea un unregistered_athletes nuevo desde el panel del owner.
// IMPORTANTE (alcance real): esto SOLO crea el registro de la persona para que exista
// en el sistema y pueda buscarse en /school-roster. NO crea una inscripcion/plan ni
// hace walk-in inmediato, porque /walk-in requiere un enrollmentId con credito activo
// y crear una inscripcion implica flujo de pago/plan que excede el modulo de asistencia.
// El owner debe inscribirla en un plan (flujo de inscripcion ya existente) antes de
// poder marcarle asistencia con descuento de credito.
router.post('/quick-guest', requireAuth, requireRole('owner', 'super_admin', 'admin', 'school_admin', 'coach'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { schoolId } = req;
      const { fullName, phone, docNumber } = req.body as { fullName: string; phone?: string; docNumber?: string };
      if (!fullName?.trim()) return res.status(400).json({ error: 'fullName es requerido.' });

      const { data, error } = await supabase
        .from('unregistered_athletes')
        .insert({
          school_id: schoolId,
          full_name: fullName.trim(),
          phone: phone || null,
          doc_number: docNumber || null,
        })
        .select('id, full_name')
        .single();

      if (error) throw error;
      return res.status(201).json({
        success: true,
        athlete: data,
        message: 'Invitado creado. Debe inscribirse en un plan antes de poder registrarle asistencia con crédito.',
      });
    } catch (err: any) {
      req.log?.error({ err: err.message || err }, 'Error creando invitado rápido');
      return res.status(500).json({ error: 'Error interno creando el invitado.' });
    }
  }
);

// POST /api/v1/attendance/link-unregistered
// Migración manual: enlaza un atleta no registrado a su perfil ya registrado.
// Útil cuando el atleta se registró sin usar el link de invitación.
router.post(
  '/link-unregistered',
  requireAuth,
  requireRole('owner', 'super_admin', 'admin', 'school_admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { unregisteredAthleteId, targetUserId, targetChildId } = req.body as {
        unregisteredAthleteId: string;
        targetUserId?: string;
        targetChildId?: string;
      };

      if (!unregisteredAthleteId || (!targetUserId && !targetChildId)) {
        return res.status(400).json({
          error: 'Se requiere unregisteredAthleteId y targetUserId o targetChildId.',
        });
      }

      const { data, error } = await supabase.rpc('link_unregistered_to_profile', {
        p_unregistered_id:  unregisteredAthleteId,
        p_target_user_id:   targetUserId  ?? null,
        p_target_child_id:  targetChildId ?? null,
      });

      if (error) throw error;

      return res.json({ success: true, migration: data });
    } catch (err: any) {
      // El RPC ya valida permisos y lanza excepciones descriptivas
      const isPermission = err.message?.includes('permisos');
      return res
        .status(isPermission ? 403 : 500)
        .json({ error: err.message || 'Error enlazando atleta.' });
    }
  }
);

export default router;
