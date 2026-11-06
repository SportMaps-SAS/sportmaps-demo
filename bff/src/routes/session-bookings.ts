import { Router, Request, Response } from 'express';
import { requireAuth, requireRole, auditLog } from '../middlewares/authMiddleware';
import { supabase } from '../config/supabase';
import { z } from 'zod';
import {
  dayNotAllowedBody,
  getAllowedDaysForPlans,
  isDateAllowedForEnrollment,
  isDayAllowed,
} from '../utils/planDayRules';

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayInBogota(): string {
  return new Date()
    .toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

// "HH:MM" en hora de Bogotá — nunca la del navegador del cliente (podría
// estar en otro huso) ni la del server (Render corre en UTC). Con esto se
// filtran horas ya pasadas de HOY tanto al listar (GET /athlete/available)
// como al revalidar en servidor (POST /athlete/book-session) — 15 min de
// gracia, mismo criterio que ya usaba el front para no ocultar una clase
// que recién empezó.
function nowHHMMInBogota(): string {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour12: false }).substring(0, 5);
}

const PAST_HOUR_GRACE_MINUTES = 15;

function isPastInBogota(dateStr: string, startTimeHHMM: string): boolean {
  if (dateStr !== todayInBogota()) return dateStr < todayInBogota();
  return toMinutesHHMM(startTimeHHMM) < toMinutesHHMM(nowHHMMInBogota()) - PAST_HOUR_GRACE_MINUTES;
}

// Insertar en `notifications` (NO llamar a la RPC notify_user: exige
// auth.uid(), y acá corremos con el service_role del BFF) alcanza para que
// se dispare todo el pipeline unificado — el trigger
// trg_enqueue_notification_delivery encola el outbox y despacha push/web
// solo. Best-effort: un fallo acá nunca debe tumbar una reserva que ya se
// confirmó, por eso el caller la envuelve en try/catch y no espera nada.
async function notifyBookingConfirmed(userId: string, dateStr: string, startTimeHHMM: string) {
  const dateLabel = new Date(`${dateStr}T00:00:00`).toLocaleDateString('es-CO', {
    weekday: 'long', day: '2-digit', month: 'long',
  });
  const timeLabel = startTimeHHMM.substring(0, 5);
  await supabase.from('notifications').insert({
    user_id: userId,
    title: 'Clase agendada',
    message: `Quedó agendada para el ${dateLabel} a las ${timeLabel}.`,
    type: 'booking_confirmed',
    link: '/enrollments',
  });
}

// ── Piloto "agendamiento flexible de banco de horas" ─────────────────────────
// Un plan de horas puede exigir un mínimo por sesión (ej. 120 min) mientras
// coach_availability sigue chocheada en bloques atómicos de 1h — estos
// helpers agrupan bloques CONSECUTIVOS del mismo coach (mismo día, sin huecos,
// sin sesión manual encima) para satisfacer ese mínimo, y exponen hasta dónde
// se podría extender (sesión personalizada) sin inventar disponibilidad que
// no existe. Se usan tanto al listar (GET /athlete/available) como al
// reservar (POST /athlete/book-session, donde se revalida todo en servidor —
// la lista que ve el cliente nunca es la fuente de verdad).
const MAX_BOOKABLE_MINUTES_CAP = 8 * 60; // tope de sensatez, nadie agenda 8h+ seguidas en un intento

function toMinutesHHMM(hhmm: string): number {
  const [h, m] = hhmm.substring(0, 5).split(':').map(Number);
  return h * 60 + m;
}

/**
 * Desde sortedSlots[startIndex] (ya ordenados por start_time, del MISMO
 * coach/día), camina mientras cada siguiente bloque empiece exactamente
 * donde termina el anterior y ninguno esté bloqueado por una sesión manual.
 * Devuelve el índice final alcanzado y los minutos totales acumulados
 * (capados en MAX_BOOKABLE_MINUTES_CAP).
 */
function walkConsecutiveRun(
  sortedSlots: any[], startIndex: number, coachId: string, dateStr: string, busySet: Set<string>,
): { endIndex: number; totalMinutes: number } {
  const startSlot = sortedSlots[startIndex];
  let endIndex = startIndex;
  let cursorEnd = toMinutesHHMM(startSlot.end_time);
  let totalMinutes = cursorEnd - toMinutesHHMM(startSlot.start_time);

  while (totalMinutes < MAX_BOOKABLE_MINUTES_CAP && endIndex + 1 < sortedSlots.length) {
    const next = sortedSlots[endIndex + 1];
    if (toMinutesHHMM(next.start_time) !== cursorEnd) break; // hueco — no es contiguo
    const nextBusyKey = `${coachId}_${dateStr}_${next.start_time.substring(0, 5)}`;
    if (busySet.has(nextBusyKey)) break;
    endIndex += 1;
    cursorEnd = toMinutesHHMM(next.end_time);
    totalMinutes = cursorEnd - toMinutesHHMM(startSlot.start_time);
  }

  return { endIndex, totalMinutes };
}

function buildBundledSessionsForDay(params: {
  slotsForDay: any[];
  dateStr: string;
  requiredBlockMinutes: number;
  busySet: Set<string>;
  sessionCapacityMap: Record<string, { current: number; max: number | null }>;
  offeringIdForEnrollment: string | null;
  enrollment: any;
  // Personal y grupal son el TIPO de disponibilidad (quién puede reservar
  // ese bloque — exclusivo vs compartido), independiente de la duración.
  // El bloque fijo del plan y la sesión personalizada aplican IGUAL a los
  // dos — por eso esta función corre una vez por cada kind, nunca solo para
  // personal.
  kind: 'personal' | 'group';
}): any[] {
  const { slotsForDay, dateStr, requiredBlockMinutes, busySet, sessionCapacityMap, offeringIdForEnrollment, enrollment, kind } = params;
  const results: any[] = [];

  const kindSlots = slotsForDay.filter((a) =>
    kind === 'personal' ? a.available_for_personal_classes : a.available_for_group_classes
  );

  // La ventana solo tiene sentido dentro del mismo coach.
  const byCoach = new Map<string, any[]>();
  for (const a of kindSlots) {
    if (!byCoach.has(a.coach_id)) byCoach.set(a.coach_id, []);
    byCoach.get(a.coach_id)!.push(a);
  }

  for (const [coachId, slots] of byCoach) {
    const sorted = [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time));

    // Un candidato por cada hora de inicio posible (no solo cada
    // requiredBlockMinutes) — "sesión personalizada" necesita poder
    // arrancar en CUALQUIER hora y extenderse lo que dé la disponibilidad
    // real, no solo desde los inicios fijos del modo "bloque". El frontend
    // colapsa esta misma lista a bloques sin solapar cuando el usuario
    // eligió "Por bloque" — acá se genera el superset completo.
    for (let start = 0; start < sorted.length; start++) {
      const startSlot = sorted[start];
      const slotStart = startSlot.start_time.substring(0, 5);

      const busyKey = `${coachId}_${dateStr}_${slotStart}`;
      if (busySet.has(busyKey)) continue;

      const { endIndex, totalMinutes: maxBookableMinutes } = walkConsecutiveRun(sorted, start, coachId, dateStr, busySet);
      if (maxBookableMinutes < requiredBlockMinutes) continue; // no alcanza el mínimo desde este inicio

      // La tarjeta que se ve por defecto dura el MÍNIMO del plan — "más
      // horas" es la opción de sesión personalizada, no lo que se muestra
      // de entrada. Se busca el primer bloque cuya duración acumulada ya
      // cumpla el mínimo.
      let defaultEndIndex = start;
      let acc = toMinutesHHMM(sorted[start].end_time) - toMinutesHHMM(sorted[start].start_time);
      while (acc < requiredBlockMinutes && defaultEndIndex < endIndex) {
        defaultEndIndex += 1;
        acc = toMinutesHHMM(sorted[defaultEndIndex].end_time) - toMinutesHHMM(sorted[start].start_time);
      }
      const endSlot = sorted[defaultEndIndex];
      const endTimeStr = endSlot.end_time.length === 5 ? `${endSlot.end_time}:00` : endSlot.end_time;

      // Capacidad: personal siempre ancla a 1 (bloque individual/exclusivo);
      // grupal usa la capacidad real del slot (varios atletas pueden
      // compartir el mismo bloque de 2-3h, igual que hoy comparten la hora
      // suelta).
      const capacityKey = `${startSlot.id}_${dateStr}`;
      const existing = sessionCapacityMap[capacityKey];
      const currentBookings = existing?.current ?? 0;
      const maxCapacity = kind === 'personal' ? 1 : (existing?.max ?? startSlot.max_group_capacity ?? 10);
      const isFull = currentBookings >= maxCapacity;

      results.push({
        id: `avail_${kind === 'personal' ? 'p' : 'g'}_${startSlot.id}_${dateStr}`,
        session_type: 'offering',
        session_date: dateStr,
        start_time: startSlot.start_time.length === 5 ? `${startSlot.start_time}:00` : startSlot.start_time,
        end_time: endTimeStr,
        max_capacity: maxCapacity,
        current_bookings: currentBookings,
        available_spots: Math.max(0, maxCapacity - currentBookings),
        already_booked: false,
        team: null,
        team_id: null,
        offering_id: offeringIdForEnrollment,
        coach: startSlot.coach,
        sessions_left: null,
        enrollment_id: enrollment.id,
        booking_status: isFull ? 'full' : 'open',
        is_pseudo: true,
        available_for_personal_classes: kind === 'personal',
        available_for_group_classes: kind === 'group',
        // Piloto "agendamiento flexible": el front usa esto para ofrecer
        // "sesión personalizada" — de default_minutes hasta max_bookable_minutes.
        default_minutes: requiredBlockMinutes,
        max_bookable_minutes: maxBookableMinutes,
      });
    }
  }

  return results;
}

async function validateChildAccess(childId: string, parentId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('children')
    .select('id')
    .eq('id', childId)
    .eq('parent_id', parentId)
    .maybeSingle();
  return !error && !!data;
}

// Identidad del atleta que agenda: exactamente UNO de los tres. `userId` es
// el atleta adulto autenticado; `childId`, un hijo (ya validado contra su
// padre); `unregisteredAthleteId`, alguien con ficha en la escuela pero sin
// cuenta (agenda vía booking_token en el link público, sin loguearse — ver
// public-booking.routes.ts /available-for-enrollment y /book-for-enrollment).
export type AthleteIdentity = { userId?: string; childId?: string; unregisteredAthleteId?: string };

function identityColumn(identity: AthleteIdentity): 'user_id' | 'child_id' | 'unregistered_athlete_id' {
  if (identity.childId) return 'child_id';
  if (identity.unregisteredAthleteId) return 'unregistered_athlete_id';
  return 'user_id';
}

function identityValue(identity: AthleteIdentity): string {
  return (identity.childId ?? identity.unregisteredAthleteId ?? identity.userId)!;
}

/**
 * Verifica que un enrollment pertenece a la identidad que agenda.
 * Para adulto: enrollment.user_id === userId
 * Para hijo:   enrollment.child_id === childId (y childId ya fue validado contra parent)
 * Para ficha sin cuenta: enrollment.unregistered_athlete_id === unregisteredAthleteId
 */
async function validateEnrollmentOwnership(
  enrollmentId: string,
  identity: AthleteIdentity
): Promise<{ valid: boolean; schoolId?: string }> {
  const { data: enrollment, error } = await supabase
    .from('enrollments')
    .select('id, user_id, child_id, unregistered_athlete_id, school_id, status')
    .eq('id', enrollmentId)
    .maybeSingle();

  if (error || !enrollment || enrollment.status !== 'active') {
    return { valid: false };
  }

  const belongs = (enrollment as any)[identityColumn(identity)] === identityValue(identity);

  return { valid: belongs, schoolId: enrollment.school_id };
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const BookSessionSchema = z.object({
  enrollment_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  child_id: z.string().uuid().optional(),
  is_secondary: z.boolean().default(false),
  booking_type: z.enum(['reservation', 'drop_in', 'walk_in']).default('reservation'),
}).refine(
  (data) => (data.user_id && !data.child_id) || (!data.user_id && data.child_id),
  { message: 'Debe especificar user_id o child_id, no ambos' }
);

const AthleteBookSchema = z.object({
  session_id: z.string(), // Permite UUID real o avail_ pseudo-id
  enrollment_id: z.string().uuid(),
  is_secondary: z.boolean().optional().default(false),
  child_id: z.string().uuid().optional(),
  // Piloto "agendamiento flexible de banco de horas" — sesión personalizada:
  // minutos totales que el atleta quiere agendar, cuando quiere más que el
  // mínimo del plan. Se revalida siempre en servidor contra la disponibilidad
  // consecutiva real — nunca se confía en este número tal cual.
  duration_minutes: z.number().int().positive().optional(),
});

const BookSecondarySchema = z.object({
  enrollment_id: z.string().uuid(),
  facility_id: z.string().uuid(),
  reservation_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slots: z.array(z.object({
    start_time: z.string().regex(/^\d{2}:\d{2}$/),
    end_time: z.string().regex(/^\d{2}:\d{2}$/),
  })).min(1).max(2),
  notes: z.string().optional(),
  child_id: z.string().uuid().optional(),
});

// ── ADMIN / SCHOOL STAFF ROUTES ──────────────────────────────────────────────

router.get('/:id/availability', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { schoolId } = req;
    const { data: s, error: e } = await supabase
      .from('attendance_sessions')
      .select('id, max_capacity, current_bookings, requires_capacity_check, finalized, session_date')
      .eq('id', id).eq('school_id', schoolId).single();

    if (e || !s) return res.status(404).json({ error: 'Sesión no encontrada' });
    res.json({
      ...s,
      available_spots: s.max_capacity ? Math.max(0, s.max_capacity - s.current_bookings) : null,
      is_full: s.max_capacity ? s.current_bookings >= s.max_capacity : false,
    });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.post('/:id/book', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id: sessionId } = req.params;
    const { schoolId } = req;
    const parsed = BookSessionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });

    const { enrollment_id, user_id, child_id, is_secondary, booking_type } = parsed.data;

    // Días permitidos del plan (D9, utils/planDayRules.ts): 422 ANTES de
    // mover saldo o crear nada. NULL en el plan = sin restricción (hoy).
    {
      const { data: sessForDay } = await supabase
        .from('attendance_sessions')
        .select('session_date')
        .eq('id', sessionId)
        .maybeSingle();
      if (sessForDay?.session_date) {
        const { allowed, allowedDays } = await isDateAllowedForEnrollment(enrollment_id, sessForDay.session_date);
        if (!allowed) return res.status(422).json(dayNotAllowedBody(allowedDays!));
      }
    }

    // Banco de horas (docs/specs/dreamers-banco-de-horas-torniquete.md): si la
    // inscripción tiene un plan por horas, la reserva mueve reserve_hour_bank
    // en vez de move_session_credit — un solo saldo, sin importar is_secondary
    // (el banco es una sola bolsa de minutos, no cuenta primaria/secundaria
    // por separado como sí hace el sistema viejo).
    const { data: enrollmentPlan } = await supabase
      .from('enrollments')
      .select('id, offering_plans(included_minutes_per_period)')
      .eq('id', enrollment_id)
      .maybeSingle();
    const isHoursPlan = (enrollmentPlan as any)?.offering_plans?.included_minutes_per_period != null;

    let hourBankReservationId: string | null = null;
    if (isHoursPlan) {
      const { data: session } = await supabase
        .from('attendance_sessions')
        .select('session_date')
        .eq('id', sessionId)
        .maybeSingle();
      const reservationDate = session?.session_date
        || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

      const { data: reserveResult } = await supabase.rpc('reserve_hour_bank', {
        p_enrollment_id: enrollment_id, p_reservation_date: reservationDate, p_created_by: req.user.id,
      });
      const r = reserveResult as any;
      if (!r?.reserved) {
        // D-2: sin saldo, la reserva se bloquea ANTES de crear el booking —
        // el 422 lleva available_minutes para que el frontend muestre el
        // saldo real, no un genérico "no se pudo reservar".
        return res.status(422).json(r);
      }
      hourBankReservationId = r.reservation_id;
    }

    const { data, error } = await supabase.from('session_bookings').insert({
      school_id: schoolId, session_id: sessionId, enrollment_id,
      user_id: user_id || null, child_id: child_id || null,
      is_secondary, booking_type, status: 'confirmed',
      hour_bank_reservation_id: hourBankReservationId,
    }).select().single();

    if (error) {
      // El insert del booking falló (ej. choque de horario) DESPUÉS de haber
      // reservado el saldo de horas — liberar para no dejarlo fantasma.
      if (hourBankReservationId) {
        await supabase.rpc('cancel_hour_bank_reservation', { p_reservation_id: hourBankReservationId });
      }
      return res.status(409).json({ error: error.message });
    }

    // El saldo del sistema VIEJO se mueve SOLO por el RPC. El read-modify-write
    // que había acá (leer sessions_used, sumar 1 en Node, escribir) hacía que
    // dos reservas simultáneas del mismo atleta consumieran una sola clase:
    // las dos leían el mismo valor. El RPC toma SELECT … FOR UPDATE sobre la
    // inscripción. No se llama si ya se movió el banco de horas arriba.
    if (!isHoursPlan) {
      await supabase.rpc('move_session_credit', {
        p_enrollment_id: enrollment_id, p_delta: 1, p_is_secondary: !!is_secondary,
      });
    }

    res.status(201).json({ booking: data });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.get('/:id/bookings', requireAuth, requireRole('owner', 'admin', 'school_admin', 'coach'), async (req: Request, res: Response) => {
  try {
    const { id: sessionId } = req.params;
    const { schoolId } = req;
    const { data, error } = await supabase.from('session_bookings')
      .select('id, status, booking_type, is_secondary, booked_at, user_id, child_id, unregistered_athlete_id, enrollment_id')
      .eq('session_id', sessionId).eq('school_id', schoolId).neq('status', 'cancelled');

    if (error) throw error;
    if (!data?.length) return res.json({ bookings: [] });

    const uIds = [...new Set(data.map(b => b.user_id).filter(Boolean))];
    const cIds = [...new Set(data.map(b => b.child_id).filter(Boolean))];
    const urIds = [...new Set(data.map(b => (b as any).unregistered_athlete_id).filter(Boolean))];
    const eIds = [...new Set(data.map(b => b.enrollment_id))];

    const [pRes, cRes, urRes, eRes] = await Promise.all([
      uIds.length ? supabase.from('profiles').select('id, full_name, avatar_url').in('id', uIds) : Promise.resolve({ data: [] }),
      cIds.length ? supabase.from('children').select('id, full_name, avatar_url').in('id', cIds) : Promise.resolve({ data: [] }),
      urIds.length ? supabase.from('unregistered_athletes').select('id, full_name').in('id', urIds) : Promise.resolve({ data: [] }),
      supabase.from('enrollments').select('id, sessions_used, plan:offering_plans(name)').in('id', eIds),
    ]);

    const pM = Object.fromEntries((pRes.data || []).map(p => [p.id, p]));
    const cM = Object.fromEntries((cRes.data || []).map(c => [c.id, c]));
    const urM = Object.fromEntries((urRes.data || []).map((u: any) => [u.id, u]));
    const eM = Object.fromEntries((eRes.data || []).map(e => [e.id, e]));

    res.json({
      bookings: data.map(b => {
        const urId = (b as any).unregistered_athlete_id;
        const person = b.user_id
          ? pM[b.user_id as string]
          : b.child_id
            ? cM[b.child_id as string]
            : urM[urId];
        return { ...b, person, enrollment: eM[b.enrollment_id] };
      })
    });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});


router.delete('/bookings/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { data: b, error } = await supabase
      .from('session_bookings')
      .select('id, user_id, child_id, status, session_id, enrollment_id, is_secondary, hour_bank_reservation_id')
      .eq('id', id).single();

    if (error || !b) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (b.status !== 'confirmed') return res.status(400).json({ error: 'Solo reservas confirmadas' });

    if (b.user_id !== userId && !['owner', 'admin', 'school_admin'].includes(req.role)) {
      let isParent = false;
      if (b.child_id) {
        const { data: child } = await supabase.from('children').select('parent_id').eq('id', b.child_id).single();
        isParent = child?.parent_id === userId;
      }
      if (!isParent) return res.status(403).json({ error: 'Sin permiso' });
    }

    await supabase.from('session_bookings')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', id);

    // Banco de horas si esta reserva se hizo por esa vía; si no, el sistema
    // viejo — nunca los dos (ver hour_bank_reservation_id en la migración).
    if (b.hour_bank_reservation_id) {
      await supabase.rpc('cancel_hour_bank_reservation', { p_reservation_id: b.hour_bank_reservation_id });
    } else {
      await supabase.rpc('move_session_credit', {
        p_enrollment_id: b.enrollment_id, p_delta: -1, p_is_secondary: !!b.is_secondary,
      });
    }

    res.json({ success: true });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.get('/my-bookings', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user.id;
    const { child_id } = req.query;
    if (child_id && !(await validateChildAccess(child_id as string, userId)))
      return res.status(403).json({ error: 'No autorizado' });

    let query = supabase.from('session_bookings')
      .select(`id, status, booked_at, session:attendance_sessions(id, session_date)`)
      .eq('school_id', req.schoolId)
      .order('booked_at', { ascending: false });
    if (child_id) query = query.eq('child_id', child_id);
    else query = query.eq('user_id', userId);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ bookings: data });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ── ATHLETE / PARENT ROUTES ──────────────────────────────────────────────────

// Núcleo de GET /athlete/available, parametrizado por identidad — nada de lo
// que sigue después de resolver `enrs` distingue quién agenda, así que se
// comparte tal cual entre el atleta autenticado (ruta de abajo) y quien
// agenda por booking_token sin cuenta (public-booking.routes.ts).
export async function listAvailableSessions(identity: AthleteIdentity) {
  {
    // ── Fetch enrollments separados por tipo ──────────────────────────────
    let q = supabase.from('enrollments').select(`
      id, school_id, team_id, offering_plan_id, offering_id, sessions_used, scheduling_team_id,
      offering_plans!enrollments_offering_plan_id_fkey(max_sessions, offering_id, included_minutes_per_period, session_block_minutes)
    `).eq('status', 'active').eq(identityColumn(identity), identityValue(identity));

    const { data: enrs, error: eErr } = await q;
    if (eErr || !enrs?.length) return { sessions: [] };

    const allSchoolIds = [...new Set(enrs.map((e: any) => e.school_id))];

    // Piloto "agendar por equipo": gateado por escuela (team_scheduling_enabled).
    // Sin esto, CUALQUIER escuela donde "Inscribir Deportistas" deje una
    // inscripción con team_id + offering_plan_id a la vez (patrón que ya
    // existe hoy fuera del piloto) empezaría a restringir su agendamiento a
    // los coaches de ese equipo sin haberlo pedido.
    const { data: schoolSettingsRows } = await supabase
      .from('school_settings')
      .select('school_id, team_scheduling_enabled, hour_bank_flexible_booking_enabled, hours_session_block_minutes')
      .in('school_id', allSchoolIds);
    const teamSchedulingEnabledMap: Record<string, boolean> = {};
    // Piloto "agendamiento flexible de banco de horas": agrupa bloques
    // atómicos de coach_availability consecutivos hasta el mínimo del plan.
    const flexibleBookingEnabledMap: Record<string, boolean> = {};
    const schoolDefaultBlockMinutesMap: Record<string, number> = {};
    (schoolSettingsRows || []).forEach((s: any) => {
      teamSchedulingEnabledMap[s.school_id] = !!s.team_scheduling_enabled;
      flexibleBookingEnabledMap[s.school_id] = !!s.hour_bank_flexible_booking_enabled;
      schoolDefaultBlockMinutesMap[s.school_id] = s.hours_session_block_minutes ?? 120;
    });

    // Enrollments de EQUIPO: tienen team_id y NO tienen offering_plan_id
    const teamEnrollments = enrs.filter(e => e.team_id && !e.offering_plan_id);
    // Enrollments de PLAN:   tienen offering_plan_id
    const planEnrollments = enrs.filter(e => e.offering_plan_id);

    const tIds = teamEnrollments.map(e => e.team_id).filter(Boolean);
    
    // Extracción robusta de offering_id (puede venir en el enrollment o en el join)
    const getOfferingId = (e: any) => {
      if (e.offering_id) return e.offering_id;
      const op = e.offering_plans;
      if (Array.isArray(op)) return op[0]?.offering_id;
      return op?.offering_id;
    };

    const oIds = planEnrollments.map(getOfferingId).filter(Boolean);

    // Piloto "agendar por equipo": la señal es simplemente "el atleta está EN
    // el equipo" (enrollments.team_id) — lo que ya deja "Inscribir
    // Deportistas" al agregar a alguien que ya tiene plan a un equipo, sin
    // pasos aparte. scheduling_team_id existe solo como override manual para
    // casos donde se necesite forzar un equipo distinto al de team_id.
    // Ambos caminos quedan detrás del flag por escuela.
    const getSchedulingTeamId = (e: any) =>
      teamSchedulingEnabledMap[e.school_id] ? (e.scheduling_team_id ?? e.team_id ?? null) : null;

    // Piloto "agendamiento flexible de banco de horas": para una inscripción
    // de plan de horas en una escuela con el flag, el mínimo agendable son
    // los minutos del plan (o el default de la escuela) — no un bloque
    // atómico suelto. Devuelve null si no aplica (no es plan de horas, o el
    // flag está apagado), en cuyo caso el comportamiento es el de siempre.
    const getRequiredBlockMinutes = (e: any): number | null => {
      if (!flexibleBookingEnabledMap[e.school_id]) return null;
      const plan = Array.isArray(e.offering_plans) ? e.offering_plans[0] : e.offering_plans;
      if (!plan || plan.included_minutes_per_period == null) return null; // no es plan de horas
      return plan.session_block_minutes ?? schoolDefaultBlockMinutesMap[e.school_id] ?? 120;
    };

    const today = todayInBogota();

    // ── Modo de agendamiento por offering (coach | facility | both) ──────────
    // Toggle configurado por el owner/admin en el plan (offerings.booking_mode).
    // Default 'coach' para offerings sin el campo aún migrado en el cliente.
    const offeringModeMap: Record<string, { booking_mode: 'coach' | 'facility' | 'both'; facility_id: string | null }> = {};
    if (oIds.length) {
      const { data: offeringModes } = await supabase
        .from('offerings')
        .select('id, booking_mode, facility_id')
        .in('id', oIds);

      (offeringModes || []).forEach((o: any) => {
        offeringModeMap[o.id] = { booking_mode: o.booking_mode ?? 'coach', facility_id: o.facility_id ?? null };
      });
    }
    const modeAllowsCoach = (offeringId: string | null | undefined) =>
      !offeringId || (offeringModeMap[offeringId]?.booking_mode ?? 'coach') !== 'facility';
    const modeAllowsFacility = (offeringId: string | null | undefined) =>
      !!offeringId && (offeringModeMap[offeringId]?.booking_mode === 'facility' || offeringModeMap[offeringId]?.booking_mode === 'both');

    // ── Coaches asignados por offering (si los hay) ──────────────────────────
    const offeringCoachMap: Record<string, string[]> = {};
    if (oIds.length) {
      const { data: offeringCoaches } = await supabase
        .from('offering_coaches')
        .select('offering_id, coach_id')
        .in('offering_id', oIds);

      (offeringCoaches || []).forEach(oc => {
        if (!offeringCoachMap[oc.offering_id]) offeringCoachMap[oc.offering_id] = [];
        offeringCoachMap[oc.offering_id].push(oc.coach_id);
      });
    }

    // ── Coaches del equipo, para inscripciones con scheduling_team_id ────────
    // Piloto "agendar por equipo": el horario sigue siendo el de CADA coach
    // (coach_availability) — el equipo (team_coaches) solo dice cuáles cuentan
    // para ese grupo. Si un coach sale del equipo, sus horarios dejan de
    // contar automáticamente, sin tocar ninguna configuración de horario.
    const schedulingTeamIds = [...new Set(
      planEnrollments.map(getSchedulingTeamId).filter(Boolean)
    )] as string[];
    const teamCoachMap: Record<string, string[]> = {};
    if (schedulingTeamIds.length) {
      const { data: teamCoaches } = await supabase
        .from('team_coaches')
        .select('team_id, coach_id')
        .in('team_id', schedulingTeamIds);

      (teamCoaches || []).forEach((tc: any) => {
        if (!teamCoachMap[tc.team_id]) teamCoachMap[tc.team_id] = [];
        teamCoachMap[tc.team_id].push(tc.coach_id);
      });
    }

    const [tRes, oRes] = await Promise.all([
      tIds.length
        ? supabase.from('attendance_sessions')
          .select(`
              id, team_id, session_date, start_time, end_time,
              max_capacity, current_bookings, coach_availability_id,
              team:teams!attendance_sessions_team_id_fkey(id, name, sport),
              coach:school_staff!attendance_sessions_coach_id_fkey(id, full_name, specialty)
            `)
          .in('school_id', allSchoolIds)
          .in('team_id', tIds)
          .eq('is_bookable', true)
          .eq('finalized', false)
          // sin hora no es una franja agendable (asistencia por equipo sin horario)
          .not('start_time', 'is', null)
          .gte('session_date', today)
        : Promise.resolve({ data: [] }),
      oIds.length
        ? supabase.from('attendance_sessions')
            .select(`
                id, offering_id, team_id, session_date, start_time, end_time,
                max_capacity, current_bookings, coach_availability_id,
                coach:school_staff!attendance_sessions_coach_id_fkey(id, full_name, specialty)
              `)
            .in('school_id', allSchoolIds)
            .in('offering_id', oIds)
            .eq('is_bookable', true)
            .eq('finalized', false)
            .not('start_time', 'is', null)
            .gte('session_date', today)
        : Promise.resolve({ data: [] }),
    ]);

    // ── Fetch coach availability para generar pseudo-sessions ────────────────
    const { data: availData } = await supabase
      .from('coach_availability')
      .select(`id, school_id, coach_id, day_of_week, start_time, end_time, available_for_group_classes, available_for_personal_classes, max_group_capacity, coach:school_staff!coach_availability_coach_id_fkey(id, full_name, specialty)`)
      .in('school_id', allSchoolIds);

    const coachIds = [...new Set((availData || []).map(a => a.coach_id))];
    const availIds = (availData || []).map(a => a.id);

    // Por qué una inscripción "agendar por equipo" no tiene franjas: el front
    // lo dice explícito en vez de un genérico «Sin clases disponibles» (R4 del
    // spec dreamers-cierre-total). Solo para inscripciones con equipo de
    // agendamiento; las demás no traen motivo.
    const noScheduleReasonByEnrollment: Record<string, 'team_without_coach' | 'team_without_schedule'> = {};
    planEnrollments.forEach((e: any) => {
      const tid = getSchedulingTeamId(e) as string | null;
      if (!tid) return;
      const coaches = teamCoachMap[tid] ?? [];
      if (coaches.length === 0) { noScheduleReasonByEnrollment[e.id] = 'team_without_coach'; return; }
      const hasAvail = (availData || []).some((a: any) => a.school_id === e.school_id && coaches.includes(a.coach_id));
      if (!hasAvail) noScheduleReasonByEnrollment[e.id] = 'team_without_schedule';
    });

    // Fetch attendance_sessions vinculadas a estos slots para:
    // (a) marcar el slot como ocupado si el coach tiene otra clase a esa hora
    // (b) obtener current_bookings POR FECHA (no acumulado entre semanas)
    const { data: existingSessions } = await supabase
      .from('attendance_sessions')
      .select('id, coach_id, facility_id, session_date, start_time, coach_availability_id, facility_availability_id, current_bookings, max_capacity')
      .in('school_id', allSchoolIds)
      .not('start_time', 'is', null)
      .gte('session_date', today);

    const busySet = new Set(
      (existingSessions || [])
        // solo sesiones sin vínculo de disponibilidad bloquean; las que no tienen
        // hora (asistencia tomada sin horario, p. ej. Dreamers) no ocupan ninguna franja
        .filter((s: any) => !s.coach_availability_id && s.start_time)
        .map((s: any) => `${s.coach_id}_${s.session_date}_${s.start_time.substring(0, 5)}`)
    );

    // Mapa: "availId_fecha" → { current_bookings, max_capacity }
    // Esto garantiza que cada ocurrencia semanal cuenta independientemente
    const sessionCapacityMap: Record<string, { current: number; max: number | null }> = {};
    (existingSessions || []).forEach((s: any) => {
      if (!s.coach_availability_id) return;
      const key = `${s.coach_availability_id}_${s.session_date}`;
      sessionCapacityMap[key] = {
        current: s.current_bookings ?? 0,
        max: s.max_capacity,
      };
    });

    // Genera pseudo-sesiones de coach_availability POR CADA plan activo por
    // separado — nunca "un solo enrollment ganador por escuela, o una sola
    // lista de coaches restringidos para todos los planes". Un atleta puede
    // tener un plan con coach específico en la Escuela B y un plan general
    // (sin restricción) en la Escuela A: antes, el coach de B "contaminaba"
    // el filtro de A y A se quedaba sin ningún horario — el bug real detrás
    // de "el plan tiene disponibilidad activa pero no aparecen horas".
    const generatedSessions: any[] = [];
    // Piloto "agendamiento flexible": grilla de horas ATÓMICAS reales (no los
    // candidatos de 2h+ de buildBundledSessionsForDay) — el front la usa para
    // que el usuario arme su propio bloque tocando horas sueltas consecutivas
    // (ej. toca 05, 06, 07 y arma 3h), en vez de escoger entre bloques ya
    // armados. Incluye la última hora del día aunque sola no alcance el
    // mínimo del plan (ej. 16:00-17:00) — esa hora nunca aparece como
    // candidato propio en buildBundledSessionsForDay, pero sí hace falta
    // para poder seleccionarla como parte de un rango que empieza antes.
    const flexibleHourGrid: any[] = [];

    if (availData?.length) {
      const [year, month, day] = today.split('-').map(Number);
      const DAYS_AHEAD = 14;

      for (const enrollment of planEnrollments) {
        const offeringIdForEnrollment = getOfferingId(enrollment);
        const schedulingTeamId = getSchedulingTeamId(enrollment) as string | null;

        let coachIdsForRestriction: string[];
        if (schedulingTeamId) {
          // Piloto "agendar por equipo": el horario sigue saliendo de
          // coach_availability — solo cambia la fuente de la restricción,
          // de offering_coaches a los coaches ACTUALES del equipo. Si el
          // equipo todavía no tiene coach asignado, no hay nada que mostrar
          // (a diferencia de "sin restricción" cuando la lista viene vacía
          // por otros motivos).
          coachIdsForRestriction = teamCoachMap[schedulingTeamId] ?? [];
          if (coachIdsForRestriction.length === 0) continue;
        } else {
          // El plan puede tener booking_mode='facility' (sin superficie de coach).
          if (!modeAllowsCoach(offeringIdForEnrollment)) continue;

          // Restricción de coach SOLO de este offering — nunca la unión de
          // todos los planes del atleta.
          coachIdsForRestriction = offeringCoachMap[offeringIdForEnrollment] ?? [];
        }

        const availForSchool = availData.filter((a: any) => a.school_id === enrollment.school_id);
        const filteredAvailData = coachIdsForRestriction.length > 0
          ? availForSchool.filter((a: any) => coachIdsForRestriction.includes(a.coach_id))
          : availForSchool;

        // Piloto "agendamiento flexible de banco de horas": si el plan exige
        // un mínimo de minutos por sesión, el bloque atómico de
        // coach_availability deja de ser la unidad reservable — se agrupan
        // bloques CONSECUTIVOS del mismo coach hasta completar ese mínimo.
        const requiredBlockMinutes = getRequiredBlockMinutes(enrollment);

        for (let i = 0; i < DAYS_AHEAD; i++) {
          const d = new Date(Date.UTC(year, month - 1, day + i));
          const dateStr = d.toISOString().split('T')[0];
          const dbDay = d.getUTCDay();

          if (dateStr < today) continue;

          // Hora colombiana, nunca la del navegador del cliente — si HOY ya
          // pasó de las 05:00, ese bloque no debe salir para agendar (ni el
          // "por bloque" ni la grilla de "personalizada"), 15 min de gracia
          // para no ocultar la clase que recién empezó.
          const slotsForDay = filteredAvailData
            .filter((a: any) => a.day_of_week === dbDay)
            .filter((a: any) => !isPastInBogota(dateStr, a.start_time));

          if (requiredBlockMinutes) {
            // Personal y grupal son el TIPO de disponibilidad, no la
            // duración — el bloque fijo del plan y la sesión personalizada
            // aplican IGUAL a los dos, por eso se corre una vez por kind.
            generatedSessions.push(...buildBundledSessionsForDay({
              slotsForDay, dateStr, requiredBlockMinutes,
              busySet, sessionCapacityMap, offeringIdForEnrollment, enrollment,
              kind: 'personal',
            }));
            generatedSessions.push(...buildBundledSessionsForDay({
              slotsForDay, dateStr, requiredBlockMinutes,
              busySet, sessionCapacityMap, offeringIdForEnrollment, enrollment,
              kind: 'group',
            }));

            (['personal', 'group'] as const).forEach((kind) => {
              const kindSlots = slotsForDay.filter((a: any) =>
                kind === 'personal' ? a.available_for_personal_classes : a.available_for_group_classes
              );
              const byCoach = new Map<string, any[]>();
              kindSlots.forEach((a: any) => {
                if (!byCoach.has(a.coach_id)) byCoach.set(a.coach_id, []);
                byCoach.get(a.coach_id)!.push(a);
              });
              byCoach.forEach((slots, coachId) => {
                const sorted = [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time));
                flexibleHourGrid.push({
                  enrollment_id: enrollment.id,
                  school_id: enrollment.school_id,
                  coach_id: coachId,
                  coach: sorted[0].coach ?? null,
                  session_date: dateStr,
                  kind,
                  default_minutes: requiredBlockMinutes,
                  hours: sorted.map((a: any) => ({
                    avail_id: a.id,
                    start_time: a.start_time.length === 5 ? `${a.start_time}:00` : a.start_time,
                    end_time: a.end_time.length === 5 ? `${a.end_time}:00` : a.end_time,
                    busy: busySet.has(`${coachId}_${dateStr}_${a.start_time.substring(0, 5)}`),
                  })),
                });
              });
            });
          }

          // El camino atómico (1 tarjeta por hora suelta) es el fallback
          // para escuelas SIN el piloto de banco de horas flexible — con
          // requiredBlockMinutes ya se generaron los bloques arriba para
          // los dos tipos, así que acá no se duplica ninguno.
          for (const avail of slotsForDay) {
            const slotStart = avail.start_time.substring(0, 5); // "HH:MM"
            const slotMaxCapacity = (avail as any).max_group_capacity ?? (avail.available_for_personal_classes ? 1 : 10);

            // Bloquear si el coach tiene una sesión manual (sin coach_availability_id) a esa hora
            const busyKey = `${avail.coach_id}_${dateStr}_${slotStart}`;
            if (busySet.has(busyKey)) continue;

            // Capacidad por fecha específica (de la sesión ya creada para esa fecha)
            const capacityKey = `${avail.id}_${dateStr}`;
            const existing = sessionCapacityMap[capacityKey];
            const currentBookings = existing?.current ?? 0;
            const maxCapacity = existing?.max ?? slotMaxCapacity;
            const isFull = currentBookings >= maxCapacity;

            // Generar una entrada por cada tipo disponible (Personal / Grupal).
            // La personal atómica de 1h se omite cuando ya se generó como
            // bloque combinado arriba (requiredBlockMinutes) — si no, un
            // mismo horario saldría duplicado (1h suelta + bloque de 2h+).
            if (avail.available_for_personal_classes && !requiredBlockMinutes) {
              generatedSessions.push({
                id: `avail_p_${avail.id}_${dateStr}`, // Prefijo p_ para personal
                session_type: 'offering',
                session_date: dateStr,
                start_time: `${slotStart}:00`,
                end_time: avail.end_time.length === 5 ? `${avail.end_time}:00` : avail.end_time,
                max_capacity: 1,
                current_bookings: currentBookings,
                available_spots: Math.max(0, 1 - currentBookings),
                already_booked: false,
                team: null,
                team_id: null,
                offering_id: offeringIdForEnrollment,
                coach: avail.coach,
                sessions_left: null,
                enrollment_id: enrollment.id,
                booking_status: currentBookings >= 1 ? 'full' : 'open',
                is_pseudo: true,
                available_for_personal_classes: true,
                available_for_group_classes: false,
              });
            }

            if (avail.available_for_group_classes && !requiredBlockMinutes) {
              generatedSessions.push({
                id: `avail_g_${avail.id}_${dateStr}`, // Prefijo g_ para grupal
                session_type: 'offering',
                session_date: dateStr,
                start_time: `${slotStart}:00`,
                end_time: avail.end_time.length === 5 ? `${avail.end_time}:00` : avail.end_time,
                max_capacity: maxCapacity,
                current_bookings: currentBookings,
                available_spots: Math.max(0, maxCapacity - currentBookings),
                already_booked: false,
                team: null,
                team_id: null,
                offering_id: offeringIdForEnrollment,
                coach: avail.coach,
                sessions_left: null,
                enrollment_id: enrollment.id,
                booking_status: isFull ? 'full' : 'open',
                is_pseudo: true,
                available_for_personal_classes: false,
                available_for_group_classes: true,
              });
            }
          }
        }
      }
    }

    // ── Generación de pseudo-sesiones de INSTALACIÓN, por offering ────────────
    // A diferencia del intento anterior (revertido): esto SOLO corre para el
    // offering específico cuyo booking_mode sea 'facility' o 'both', y SOLO
    // contra la instalación que ese offering tiene configurada (facility_id).
    // Nunca "cualquier instalación de la escuela para cualquier plan con
    // crédito" — esa mezcla fue justo el bug que sacó clases de gimnasio del
    // agendamiento de un plan con entrenador asignado. Clases de prueba/
    // cortesía siguen siendo un camino aparte (public-booking.routes.ts).
    const facilityOfferingIds = [...new Set(
      oIds.filter(oid => modeAllowsFacility(oid))
    )];

    const facilityGeneratedSessions: any[] = [];

    if (facilityOfferingIds.length) {
      const facilityIds = [...new Set(
        facilityOfferingIds.map(oid => offeringModeMap[oid]?.facility_id).filter(Boolean)
      )] as string[];

      const { data: facilityAvailData } = facilityIds.length
        ? await supabase
            .from('facility_availability')
            .select('id, school_id, facility_id, day_of_week, start_time, end_time, max_group_capacity, facility:facilities(id, name, type)')
            .in('facility_id', facilityIds)
        : { data: [] as any[] };

      const facilityCapacityMap: Record<string, { current: number; max: number | null }> = {};
      (existingSessions || []).forEach((s: any) => {
        if (!s.facility_availability_id) return;
        const key = `${s.facility_availability_id}_${s.session_date}`;
        facilityCapacityMap[key] = { current: s.current_bookings ?? 0, max: s.max_capacity };
      });

      const [year, month, day] = today.split('-').map(Number);
      const DAYS_AHEAD = 14;

      for (const offeringId of facilityOfferingIds) {
        const facilityId = offeringModeMap[offeringId]?.facility_id;
        if (!facilityId) continue; // el CHECK de la migración ya lo evita, pero por si acaso

        const enrollmentForOffering = planEnrollments.find(e => getOfferingId(e) === offeringId);
        if (!enrollmentForOffering) continue;

        const slotsForFacility = (facilityAvailData || []).filter((a: any) => a.facility_id === facilityId);

        for (let i = 0; i < DAYS_AHEAD; i++) {
          const d = new Date(Date.UTC(year, month - 1, day + i));
          const dateStr = d.toISOString().split('T')[0];
          const dbDay = d.getUTCDay();
          if (dateStr < today) continue;

          const slotsForDay = slotsForFacility.filter((a: any) => a.day_of_week === dbDay);

          for (const avail of slotsForDay) {
            const facility = (avail as any).facility;
            if (!facility) continue;

            const slotStart = avail.start_time.substring(0, 5);
            const capacityKey = `${avail.id}_${dateStr}`;
            const existingCap = facilityCapacityMap[capacityKey];
            const currentBookings = existingCap?.current ?? 0;
            const maxCapacity = existingCap?.max ?? avail.max_group_capacity ?? 10;
            const isFull = currentBookings >= maxCapacity;

            facilityGeneratedSessions.push({
              id: `favail_${avail.id}_${dateStr}`,
              session_type: 'offering',
              session_date: dateStr,
              start_time: `${slotStart}:00`,
              end_time: avail.end_time.length === 5 ? `${avail.end_time}:00` : avail.end_time,
              max_capacity: maxCapacity,
              current_bookings: currentBookings,
              available_spots: Math.max(0, maxCapacity - currentBookings),
              already_booked: false,
              team: null,
              team_id: null,
              offering_id: offeringId,
              coach: null,
              facility_id: facilityId, // solo para el dedup de abajo; se descarta al mapear la respuesta
              sessions_left: null,
              enrollment_id: enrollmentForOffering.id,
              booking_status: isFull ? 'full' : 'open',
              is_pseudo: true,
              available_for_personal_classes: false,
              available_for_group_classes: true,
            });
          }
        }
      }
    }

    const availMap = Object.fromEntries((availData || []).map(a => [a.id, a]));

    const enrichRealSession = (s: any) => {
      const avail = s.coach_availability_id ? availMap[s.coach_availability_id] : null;
      return {
        ...s,
        available_for_personal_classes: avail ? avail.available_for_personal_classes : false,
        available_for_group_classes: avail ? avail.available_for_group_classes : (s.max_capacity > 1),
      };
    };

    const teamSessions = (tRes.data || []).map((s: any) => enrichRealSession({ ...s, session_type: 'team' as const }));
    // La restricción de coaches es POR OFFERING (offeringCoachMap), nunca una unión global:
    // un atleta con un plan restringido en la Escuela B no puede perder visibilidad de los
    // coaches sin restricción de su plan en la Escuela A. Antes se armaba una única lista
    // "assignedCoachIds" con los coaches de TODOS los planes del atleta y se aplicaba a todos
    // por igual — un plan de otra escuela con un coach específico volvía invisibles los
    // coaches de un plan general en una escuela completamente distinta.
    const offeringSessions = (oRes.data || [])
      .filter((s: any) => {
        const restricted = offeringCoachMap[s.offering_id] ?? [];
        return restricted.length === 0 || restricted.includes(s.coach?.id);
      })
      .map((s: any) => enrichRealSession({ ...s, session_type: 'offering' as const }));

    // Deduplicar: las sesiones REALES tienen prioridad sobre las pseudo-sesiones.
    // Si un coach, una instalación o un equipo ya aparece en teamSessions/
    // offeringSessions a la misma hora+fecha, la pseudo-sesión correspondiente
    // se descarta. team_id va primero: una sesión de equipo (piloto "agendar
    // por equipo", o una inscripción de equipo normal) se identifica por el
    // equipo, nunca por el coach que le haya quedado asignado a esa fila.
    const resourceKey = (s: any) => {
      if (s.team_id) return `t_${s.team_id}`;
      if (s.facility_id) return `f_${s.facility_id}`;
      return s.coach?.id ?? s.coach_id ?? '';
    };

    const realSlotKeys = new Set<string>();
    [...teamSessions, ...offeringSessions].forEach((s: any) => {
      if (!s.start_time) return; // sesión sin hora: no corresponde a ninguna franja
      realSlotKeys.add(`${resourceKey(s)}_${s.session_date}_${s.start_time.substring(0, 5)}`);
    });

    // También deduplicar entre pseudo-sesiones por coach/instalación/equipo+fecha+hora+tipo
    // (quedar con la de mayor cupo para el mismo tipo)
    const allGeneratedSessions = [...generatedSessions, ...facilityGeneratedSessions];
    const dedupedGenerated: any[] = [];
    const seenPseudoKey = new Set<string>();
    allGeneratedSessions.sort((a, b) => (b.max_capacity ?? 0) - (a.max_capacity ?? 0));
    for (const gs of allGeneratedSessions) {
      if (!gs.start_time) continue; // defensivo: una franja sin hora no se puede ofrecer
      const rKey = resourceKey(gs);
      const typeStr = gs.id.startsWith('avail_p_') ? 'p' : 'g';
      const key = `${rKey}_${gs.session_date}_${gs.start_time.substring(0, 5)}_${typeStr}`;

      const generalSlotKey = `${rKey}_${gs.session_date}_${gs.start_time.substring(0, 5)}`;

      if (!realSlotKeys.has(generalSlotKey) && !seenPseudoKey.has(key)) {
        seenPseudoKey.add(key);
        dedupedGenerated.push(gs);
      }
    }

    // Sesiones reales sin hora no son agendables (ya se filtran en la query; esto es defensivo).
    const baseSessions = [...teamSessions, ...offeringSessions, ...dedupedGenerated]
      .filter((s: any) => !!s.start_time);
    const allSessions: any[] = [];

    baseSessions.forEach((s: any) => {
      // Si la sesión permite ambos y está vacía, la desdoblamos para que el usuario elija modalidad
      const isDual = s.available_for_personal_classes && s.available_for_group_classes;
      const isEmpty = (s.current_bookings ?? 0) === 0;

      if (s.session_type !== 'facility' && isDual && isEmpty) {
        // Opción Personal
        allSessions.push({
          ...s,
          id: `${s.id}_p`,
          max_capacity: 1,
          available_for_personal_classes: true,
          available_for_group_classes: false,
        });
        // Opción Grupal
        allSessions.push({
          ...s,
          id: `${s.id}_g`,
          max_capacity: s.max_capacity,
          available_for_personal_classes: false,
          available_for_group_classes: true,
        });
      } else {
        allSessions.push(s);
      }
    });

    // Ordenar por fecha y hora
    allSessions.sort((a, b) => {
      const dateCmp = a.session_date.localeCompare(b.session_date);
      if (dateCmp !== 0) return dateCmp;
      return a.start_time.localeCompare(b.start_time);
    });

    if (!allSessions.length) return { sessions: [], no_schedule_reason_by_enrollment: noScheduleReasonByEnrollment };

    // ── Bookings del atleta para marcar already_booked ────────────────────
    // IMPORTANTE: limpiar IDs de desdoblamiento (_p, _g) para consultar DB
    const sIds = allSessions
      .filter(s => !s.is_pseudo)
      .map(s => s.id.includes('_p') || s.id.includes('_g') ? s.id.slice(0, -2) : s.id);

    let bQ = supabase.from('session_bookings')
      .select('session_id')
      .in('session_id', sIds.length ? sIds : ['00000000-0000-0000-0000-000000000000'])
      .neq('status', 'cancelled')
      .eq(identityColumn(identity), identityValue(identity));

    const { data: booked } = await bQ;
    const bookedSet = new Set((booked || []).map(b => b.session_id));

    // ── Mapear manteniendo teams y offerings separados ────────────────────
    const sessions = allSessions.map((s: any) => {
      const availableSpots = Math.max(0, s.max_capacity - s.current_bookings);
      const cleanIdForBooked = s.id.includes('_p') || s.id.includes('_g') ? s.id.slice(0, -2) : s.id;
      const alreadyBooked = bookedSet.has(cleanIdForBooked);
      const isFull = s.current_bookings >= s.max_capacity;

      if (s.session_type === 'team') {
        // Enrollment del equipo correspondiente
        const enrollment = teamEnrollments.find(e => e.team_id === s.team_id);
        return {
          id: s.id,
          session_type: 'team',
          session_date: s.session_date,
          start_time: s.start_time,
          end_time: s.end_time,
          max_capacity: s.max_capacity,
          current_bookings: s.current_bookings,
          available_spots: availableSpots,
          already_booked: alreadyBooked,
          // Datos del equipo — nunca offering
          team: s.team ?? null,
          team_id: s.team_id,
          offering_id: null,
          coach: s.coach ?? null,
          // Créditos: equipos no tienen límite de sesiones
          sessions_left: null,
          enrollment_id: enrollment?.id ?? null,
          school_id: enrollment?.school_id ?? null,
          booking_status: alreadyBooked ? 'already_booked' : isFull ? 'full' : 'open',
        };
      }

      // session_type === 'offering'
      const enrollment = planEnrollments.find(
        e => (e.offering_plans as any)?.offering_id === s.offering_id
      );
      const plan = (enrollment as any)?.offering_plans ?? null;
      const maxSess = plan?.max_sessions ?? null;
      const used = enrollment?.sessions_used ?? 0;
      const sessLeft = maxSess !== null ? Math.max(0, maxSess - used) : null;
      const noCredits = sessLeft !== null && sessLeft <= 0;

      return {
        id: s.id,
        session_type: 'offering',
        session_date: s.session_date,
        start_time: s.start_time,
        end_time: s.end_time,
        max_capacity: s.max_capacity,
        current_bookings: s.current_bookings,
        available_spots: availableSpots,
        already_booked: alreadyBooked,
        // Datos del offering — nunca team
        team: null,
        team_id: null,
        offering_id: s.offering_id,
        coach: s.coach ?? null,
        // Créditos del plan
        sessions_left: sessLeft,
        enrollment_id: enrollment?.id ?? null,
        school_id: enrollment?.school_id ?? null,
        booking_status: alreadyBooked ? 'already_booked'
          : isFull ? 'full'
            : noCredits ? 'no_credits'
              : 'open',
        available_for_personal_classes: (s as any).available_for_personal_classes ?? null,
        available_for_group_classes: (s as any).available_for_group_classes ?? null,
        // Piloto "agendamiento flexible de banco de horas": buildBundledSessionsForDay
        // los pone en la pseudo-sesión generada — sin esto el front nunca ve el
        // mínimo del plan ni el margen para personalizar, así la sesión venga
        // agrupada por dentro.
        default_minutes: (s as any).default_minutes ?? undefined,
        max_bookable_minutes: (s as any).max_bookable_minutes ?? undefined,
      };
    });

    // ── Días permitidos del plan (D9, utils/planDayRules.ts) ───────────────
    // Las sesiones de un día que el plan no permite no se ofrecen (la reserva
    // igual las rechaza con 422). allowed_days_by_enrollment va al front para
    // pintar esos días en gris con su explicación. Plan sin días = sin cambio.
    const allowedDaysByPlan = await getAllowedDaysForPlans(planEnrollments.map((e: any) => e.offering_plan_id));
    const allowedDaysByEnrollment: Record<string, number[]> = {};
    planEnrollments.forEach((e: any) => {
      const days = allowedDaysByPlan[e.offering_plan_id];
      if (days) allowedDaysByEnrollment[e.id] = days;
    });
    const dayOk = (enrollmentId: string | null | undefined, date: string) =>
      !enrollmentId || isDayAllowed(allowedDaysByEnrollment[enrollmentId], date);

    return {
      sessions: sessions.filter((s: any) => dayOk(s.enrollment_id, s.session_date)),
      flexible_hour_grid: flexibleHourGrid.filter((g: any) => dayOk(g.enrollment_id, g.session_date)),
      allowed_days_by_enrollment: allowedDaysByEnrollment,
      no_schedule_reason_by_enrollment: noScheduleReasonByEnrollment,
    };
  }
}

router.get('/athlete/available', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { child_id } = req.query;
    if (child_id && !(await validateChildAccess(child_id as string, userId)))
      return res.status(403).json({ error: 'No autorizado' });

    const result = await listAvailableSessions(child_id ? { childId: child_id as string } : { userId });
    res.json(result);
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Núcleo de POST /athlete/book-session, parametrizado por identidad — mismo
// criterio que listAvailableSessions: todo lo que sigue después de resolver
// el enrollment es agnóstico de QUIÉN agenda. `req`/`res` se pasan tal cual
// para no tocar ninguna de las respuestas ya afinadas en esta función.
export async function bookSession(
  req: Request, res: Response, identity: AthleteIdentity,
  bookParams: { session_id: string; enrollment_id: string; is_secondary?: boolean; duration_minutes?: number },
  // Quién creó la reserva para auditoría/notificación — el padre cuando
  // agenda para un hijo (identity sería childId, no userId). undefined para
  // quien agenda sin cuenta (identity.unregisteredAthleteId): no hay perfil
  // al que notificar in-app, ese caso manda su propio correo de confirmación.
  actingUserId?: string,
  // Hook opcional post-éxito (ej. correo de confirmación para quien agenda
  // sin cuenta) — corre ANTES de responder, y lo que devuelva se mezcla en
  // el body de la respuesta (ej. { email_sent: true }).
  postSuccess?: (booking: any) => Promise<Record<string, any> | void>
) {
  {
    const { session_id, enrollment_id, is_secondary, duration_minutes } = bookParams;

    // ── 2. Validar que el enrollment pertenece al atleta ──────────────────
    const { valid: enrollmentValid, schoolId: enrollmentSchoolId } =
      await validateEnrollmentOwnership(enrollment_id, identity);
    if (!enrollmentValid)
      return res.status(403).json({ error: 'enrollment_unauthorized' });

    // ── 2b. Días permitidos del plan (D9, utils/planDayRules.ts) ──────────
    // Va ANTES del paso 3 porque la rama avail_ puede materializar/estirar
    // attendance_sessions: un día no permitido se corta sin mutar nada.
    // Cubre /athlete/book-session y la reserva pública (public-booking).
    // NULL en el plan = sin restricción (comportamiento de hoy).
    {
      let targetDate: string | null = null;
      if (session_id.startsWith('avail_')) {
        const tail = session_id.slice(-10);
        targetDate = /^\d{4}-\d{2}-\d{2}$/.test(tail) ? tail : null;
      } else {
        const cleanId = (session_id.endsWith('_p') || session_id.endsWith('_g')) ? session_id.slice(0, -2) : session_id;
        const { data: sessForDay } = await supabase
          .from('attendance_sessions')
          .select('session_date')
          .eq('id', cleanId)
          .maybeSingle();
        targetDate = sessForDay?.session_date ?? null;
      }
      if (targetDate) {
        const { allowed, allowedDays } = await isDateAllowedForEnrollment(enrollment_id, targetDate);
        if (!allowed) return res.status(422).json(dayNotAllowedBody(allowedDays!));
      }
    }

    // ── 3. Validar sesión y capacidad ─────────────────────────────────────
    let actualSessionId = session_id;
    let s: any = null;

    if (session_id.startsWith('avail_')) {
      // Formato: avail_p_{availId}_{YYYY-MM-DD} o avail_g_{availId}_{YYYY-MM-DD}
      const isPersonal = session_id.includes('_p_');
      const isGroup = session_id.includes('_g_');
      const prefixLen = isPersonal ? 'avail_p_'.length : (isGroup ? 'avail_g_'.length : 'avail_'.length);

      const dateStr = session_id.slice(-10);          // últimos 10: "YYYY-MM-DD"
      const availId = session_id.slice(prefixLen, -11); // entre el prefijo y "_YYYY-MM-DD"

      if (!availId || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr))
        return res.status(400).json({ error: 'invalid_avail_format' });

      // Obtener detalles del slot de disponibilidad
      const { data: avail } = await supabase
        .from('coach_availability')
        .select('coach_id, school_id, day_of_week, start_time, end_time, available_for_group_classes, available_for_personal_classes, max_group_capacity')
        .eq('id', availId)
        .single();

      if (!avail) return res.status(404).json({ error: 'avail_not_found' });

      // Hora colombiana en servidor — el GET ya filtra esto para lo que
      // lista, pero nunca es autoritativo: sin este chequeo, cualquiera
      // podía mandar un avail_ de una hora que ya pasó hoy directo a este
      // endpoint y la sesión se creaba igual.
      if (isPastInBogota(dateStr, avail.start_time)) {
        return res.status(409).json({ error: 'Ese horario ya pasó.', reason: 'slot_in_the_past' });
      }

      const coach_id = avail.coach_id;
      let start_time = avail.start_time.length === 5 ? `${avail.start_time}:00` : avail.start_time;
      let end_time = avail.end_time.length === 5 ? `${avail.end_time}:00` : avail.end_time;
      const maxCap = isPersonal ? 1 : (avail.max_group_capacity ?? 10);

      // Buscar si ya existe una attendance_session para esta fecha exacta vinculada a este slot
      const { data: existS } = await supabase
        .from('attendance_sessions')
        .select('id, school_id, max_capacity, current_bookings, start_time, end_time')
        .eq('coach_availability_id', availId)
        .eq('session_date', dateStr)
        .maybeSingle();

      // Si el atleta ya tiene una reserva activa sobre este mismo bloque
      // atómico, cortar ACÁ — antes de intentar estirarlo a un rango más
      // ancho. Sin esto, pedir "personalizada" empezando en una hora que ya
      // tenías reservada primero ensanchaba attendance_sessions (y ocultaba
      // las horas intermedias) y RECIÉN DESPUÉS el chequeo de cupo (más
      // abajo, compartido con las otras vías) lo rechazaba — la mutación ya
      // había pasado, sin revertir.
      if (existS) {
        let dupCheck = supabase
          .from('session_bookings')
          .select('id')
          .eq('session_id', existS.id)
          .neq('status', 'cancelled');
        dupCheck = dupCheck.eq(identityColumn(identity), identityValue(identity));
        const { data: existingOwnBooking } = await dupCheck.maybeSingle();
        if (existingOwnBooking) {
          return res.status(409).json({
            error: 'Ya tienes una reserva activa para esta clase.',
            reason: 'already_booked',
            booking_id: existingOwnBooking.id,
          });
        }
      }

      // Estos datos hacían falta SOLO en la rama "sin existS" — pero el
      // horario se pre-materializa con antelación (una attendance_sessions
      // de 1h por cada bloque atómico de coach_availability), así que existS
      // casi SIEMPRE aparece. Antes eso hacía que la reautorización de coach
      // y, sobre todo, la extensión de duración (sesión personalizada, y
      // hasta el bloque por defecto de 2h) nunca corrieran — se reusaba el
      // bloque atómico de 1h tal cual, sin importar qué pidió el atleta.
      const { data: eData } = await supabase.from('enrollments')
        .select('offering_plans(offering_id, included_minutes_per_period, session_block_minutes), scheduling_team_id, team_id')
        .eq('id', enrollment_id)
        .single();

      const offering_id = eData?.offering_plans
        ? (eData.offering_plans as any).offering_id
        : null;

      // Piloto "agendar por equipo": basta con estar EN el equipo
      // (enrollments.team_id, lo que ya deja "Inscribir Deportistas") —
      // scheduling_team_id es solo un override manual si hiciera falta.
      // Gateado por escuela: sin esto, cualquier inscripción con team_id +
      // offering_plan_id a la vez (patrón que ya existe fuera del piloto)
      // quedaría restringida a los coaches de ese equipo sin haberlo pedido.
      const { data: schoolSettingsRow } = await supabase
        .from('school_settings')
        .select('team_scheduling_enabled, hour_bank_flexible_booking_enabled, hours_session_block_minutes')
        .eq('school_id', enrollmentSchoolId)
        .maybeSingle();

      const schedulingTeamId = schoolSettingsRow?.team_scheduling_enabled
        ? (((eData as any)?.scheduling_team_id ?? (eData as any)?.team_id ?? null) as string | null)
        : null;

      // Revalidar en servidor la restricción de coaches — el GET
      // /athlete/available ya filtra la lista que ve el cliente, pero eso
      // no es autoritativo: sin este chequeo, cualquiera podía llamar este
      // endpoint directo con el avail_ de un coach NO autorizado y la
      // sesión se creaba igual con ese coach. Piloto "agendar por equipo":
      // si la inscripción está en un equipo, la fuente de verdad es
      // team_coaches (quién dicta HOY por ese equipo), no offering_coaches.
      if (schedulingTeamId) {
        const { data: teamCoaches } = await supabase
          .from('team_coaches')
          .select('coach_id')
          .eq('team_id', schedulingTeamId);

        if (!teamCoaches?.some(tc => tc.coach_id === coach_id)) {
          return res.status(403).json({
            error: 'Este entrenador ya no pertenece al equipo asignado.',
            reason: 'coach_not_in_team',
          });
        }
      } else if (offering_id) {
        const { data: allowedCoaches } = await supabase
          .from('offering_coaches')
          .select('coach_id')
          .eq('offering_id', offering_id);

        if (allowedCoaches && allowedCoaches.length > 0 &&
            !allowedCoaches.some(ac => ac.coach_id === coach_id)) {
          return res.status(403).json({
            error: 'Este entrenador no está autorizado para dictar este plan.',
            reason: 'coach_not_authorized',
          });
        }
      }

      // Piloto "agendamiento flexible de banco de horas": sesión
      // personalizada (o el bloque de 2h+ por defecto) — si pidió más
      // minutos que este único bloque atómico, extender el rango caminando
      // bloques CONSECUTIVOS reales del mismo coach. Nunca se confía en
      // duration_minutes tal cual: se revalida contra disponibilidad real,
      // igual que hace el GET. swallowedAvailIds guarda los ids de los
      // bloques atómicos intermedios que este rango más ancho se traga —
      // sus attendance_sessions pre-generadas (si existen) quedan ocultas
      // más abajo, para no dejarlas sueltas como si fueran agendables aparte.
      const plan = (eData?.offering_plans as any) ?? null;
      const isFlexibleEligible =
        !!schoolSettingsRow?.hour_bank_flexible_booking_enabled && plan?.included_minutes_per_period != null;
      const singleSlotMinutes = toMinutesHHMM(end_time) - toMinutesHHMM(start_time);
      const needsExtension = isFlexibleEligible && !!duration_minutes && duration_minutes > singleSlotMinutes;
      let swallowedAvailIds: string[] = [];

      if (needsExtension) {
        const [{ data: siblingSlots }, { data: manualSessions }] = await Promise.all([
          supabase
            .from('coach_availability')
            .select('id, start_time, end_time')
            .eq('coach_id', coach_id)
            .eq('school_id', avail.school_id)
            .eq('day_of_week', avail.day_of_week)
            .eq(isPersonal ? 'available_for_personal_classes' : 'available_for_group_classes', true),
          supabase
            .from('attendance_sessions')
            .select('start_time')
            .eq('coach_id', coach_id)
            .eq('session_date', dateStr)
            .is('coach_availability_id', null)
            .not('start_time', 'is', null),
        ]);

        const busySetForCoach = new Set(
          (manualSessions || [])
            .filter((m: any) => m.start_time)
            .map((m: any) => `${coach_id}_${dateStr}_${m.start_time.substring(0, 5)}`)
        );
        const sorted = [...(siblingSlots || [])].sort((a: any, b: any) => a.start_time.localeCompare(b.start_time));
        const startIdx = sorted.findIndex((sl: any) => sl.id === availId);

        if (startIdx === -1) {
          return res.status(404).json({ error: 'avail_not_found' });
        }

        const { endIndex, totalMinutes: maxAvailableMinutes } =
          walkConsecutiveRun(sorted, startIdx, coach_id, dateStr, busySetForCoach);

        if (duration_minutes! > maxAvailableMinutes) {
          return res.status(409).json({
            error: 'No hay suficiente disponibilidad consecutiva de ese entrenador para esa duración.',
            reason: 'insufficient_consecutive_availability',
            max_bookable_minutes: maxAvailableMinutes,
          });
        }

        // Caminar hasta acumular exactamente duration_minutes (o el bloque
        // que primero lo cubra) — mismo criterio que buildBundledSessionsForDay.
        let acc = 0;
        let chosenEndIdx = startIdx;
        for (let k = startIdx; k <= endIndex; k++) {
          acc = toMinutesHHMM(sorted[k].end_time) - toMinutesHHMM(sorted[startIdx].start_time);
          chosenEndIdx = k;
          if (acc >= duration_minutes!) break;
        }
        const chosenEndSlot = sorted[chosenEndIdx];
        end_time = chosenEndSlot.end_time.length === 5 ? `${chosenEndSlot.end_time}:00` : chosenEndSlot.end_time;
        swallowedAvailIds = sorted.slice(startIdx + 1, chosenEndIdx + 1).map((sl: any) => sl.id);
      }

      // Los bloques atómicos que el rango más ancho absorbe pueden YA tener
      // su propia attendance_sessions pre-generada (el caso normal). Si
      // alguna ya tiene reservas propias, no se puede extender por ahí —
      // busySet/max_bookable_minutes en el GET ya debería haberlo evitado,
      // pero nunca se confía en lo que mandó el cliente para algo que mueve
      // banco de horas real.
      let swallowedSessionIds: string[] = [];
      if (swallowedAvailIds.length > 0) {
        const { data: swallowedSessions } = await supabase
          .from('attendance_sessions')
          .select('id, current_bookings')
          .in('coach_availability_id', swallowedAvailIds)
          .eq('session_date', dateStr);

        const alreadyBooked = (swallowedSessions ?? []).find((row: any) => (row.current_bookings ?? 0) > 0);
        if (alreadyBooked) {
          return res.status(409).json({
            error: 'Uno de los bloques de esa hora ya tiene una reserva — elige otro horario.',
            reason: 'partial_slot_already_booked',
          });
        }
        swallowedSessionIds = (swallowedSessions ?? []).map((row: any) => row.id);
      }

      if (existS) {
        if (needsExtension) {
          const { data: updatedS, error: updErr } = await supabase
            .from('attendance_sessions')
            .update({ end_time })
            .eq('id', existS.id)
            .select('id, school_id, max_capacity, current_bookings, start_time, end_time')
            .single();
          if (updErr || !updatedS) return res.status(500).json({ error: 'No se pudo extender el bloque.' });
          s = updatedS;
        } else {
          s = existS;
        }
      } else {
        const { data: newS, error: newErr } = await supabase.from('attendance_sessions')
          .insert({
            school_id: enrollmentSchoolId,
            coach_id,
            session_date: dateStr,
            start_time,
            end_time,
            offering_id,
            max_capacity: maxCap,
            current_bookings: 0,
            is_bookable: true,
            finalized: false,
            coach_availability_id: availId,   // ← vínculo clave para conteo por fecha
          }).select('id, school_id, max_capacity, current_bookings, start_time, end_time').single();

        if (newErr && newErr.code === '23505') {
          const { data: retryS, error: retryErr } = await supabase
            .from('attendance_sessions')
            .select('id, school_id, max_capacity, current_bookings, start_time, end_time')
            .eq('coach_availability_id', availId)
            .eq('session_date', dateStr)
            .single();
          if (retryErr || !retryS) return res.status(500).json({ error: 'No se pudo resolver el bloque.' });
          s = retryS;
        } else if (newErr) {
          return res.status(500).json({ error: 'failed_creating_session' });
        } else {
          s = newS;
        }
      }
      actualSessionId = s.id;

      // Ocultar (nunca borrar) las attendance_sessions atómicas que este
      // bloque más ancho absorbió — dejan de ser agendables por su cuenta.
      if (swallowedSessionIds.length > 0) {
        await supabase
          .from('attendance_sessions')
          .update({ is_bookable: false })
          .in('id', swallowedSessionIds);
      }
    } else if (session_id.startsWith('favail_')) {
      // Formato: favail_{availId}_{YYYY-MM-DD} — booking_mode='facility'/'both' en el offering
      const prefixLen = 'favail_'.length;
      const dateStr = session_id.slice(-10);
      const availId = session_id.slice(prefixLen, -11);

      if (!availId || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr))
        return res.status(400).json({ error: 'invalid_favail_format' });

      const { data: avail } = await supabase
        .from('facility_availability')
        .select('facility_id, start_time, end_time, max_group_capacity')
        .eq('id', availId)
        .single();

      if (!avail) return res.status(404).json({ error: 'favail_not_found' });

      const { data: eData } = await supabase.from('enrollments')
        .select('offering_plans(offering_id)')
        .eq('id', enrollment_id)
        .single();

      const offering_id = eData?.offering_plans
        ? (eData.offering_plans as any).offering_id
        : null;

      if (!offering_id) return res.status(400).json({ error: 'offering_required_for_facility_booking' });

      // Revalidar en servidor — el GET /athlete/available ya filtra lo que ve el
      // cliente, pero eso no es autoritativo: sin este chequeo, cualquiera podía
      // llamar este endpoint directo con el favail_ de una instalación ajena al
      // plan, o de un plan con booking_mode='coach' (sin superficie de instalación).
      const { data: offering } = await supabase
        .from('offerings')
        .select('booking_mode, facility_id')
        .eq('id', offering_id)
        .single();

      const modeAllowsFacilityForOffering = offering?.booking_mode === 'facility' || offering?.booking_mode === 'both';
      if (!modeAllowsFacilityForOffering || offering?.facility_id !== avail.facility_id) {
        return res.status(403).json({
          error: 'Esta instalación no está habilitada para este plan.',
          reason: 'facility_not_authorized',
        });
      }

      const start_time = avail.start_time.length === 5 ? `${avail.start_time}:00` : avail.start_time;
      const end_time = avail.end_time.length === 5 ? `${avail.end_time}:00` : avail.end_time;
      const maxCap = avail.max_group_capacity ?? 10;

      const { data: existS } = await supabase
        .from('attendance_sessions')
        .select('id, school_id, max_capacity, current_bookings')
        .eq('facility_availability_id', availId)
        .eq('session_date', dateStr)
        .maybeSingle();

      if (existS) {
        s = existS;
        actualSessionId = s.id;
      } else {
        const { data: newS, error: newErr } = await supabase.from('attendance_sessions')
          .insert({
            school_id: enrollmentSchoolId,
            facility_id: avail.facility_id,
            session_date: dateStr,
            start_time,
            end_time,
            offering_id,
            max_capacity: maxCap,
            current_bookings: 0,
            is_bookable: true,
            finalized: false,
            facility_availability_id: availId,   // ← vínculo clave para conteo por fecha
          }).select('id, school_id, max_capacity, current_bookings').single();

        if (newErr && newErr.code === '23505') {
          const { data: retryS, error: retryErr } = await supabase
            .from('attendance_sessions')
            .select('id, school_id, max_capacity, current_bookings')
            .eq('facility_availability_id', availId)
            .eq('session_date', dateStr)
            .single();
          if (retryErr || !retryS) return res.status(500).json({ error: 'No se pudo resolver el bloque.' });
          s = retryS;
        } else if (newErr) {
          return res.status(500).json({ error: 'failed_creating_session' });
        } else {
          s = newS;
        }
        actualSessionId = s.id;
      }
    } else {
      // Manejar IDs con sufijo _p o _g para sesiones reales (desdoblamiento universal)
      const isPersonal = session_id.endsWith('_p');
      const isGroup = session_id.endsWith('_g');
      const cleanSessionId = (isPersonal || isGroup) ? session_id.slice(0, -2) : session_id;
      actualSessionId = cleanSessionId;

      const { data: fetchS } = await supabase
        .from('attendance_sessions')
        .select('school_id, max_capacity, current_bookings')
        .eq('id', cleanSessionId)
        .single();
      s = fetchS;

      // VALIDACIÓN de exclusividad sin modificar DB:
      if (isPersonal) {
        // Personal solo puede reservar si nadie más ha reservado ese slot
        const { count: existingCount } = await supabase
          .from('session_bookings')
          .select('id', { count: 'exact', head: true })
          .eq('session_id', actualSessionId)
          .neq('status', 'cancelled');

        if ((existingCount ?? 0) > 0) {
          return res.status(409).json({
            error: 'Este horario ya tiene una reserva. No puede agendarse como clase personal.',
            reason: 'capacity_full',
          });
        }
      }
    }

    if (!s) return res.status(404).json({ error: 'not_found' });

    // Validar cupo con conteo real de session_bookings (fuente de verdad)
    // Evita falsos "llena" cuando current_bookings se desincroniza por cancel+re-book
    if (s.max_capacity !== null && s.max_capacity !== undefined) {
      const { count: activeCount } = await supabase
        .from('session_bookings')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', actualSessionId)
        .neq('status', 'cancelled');

      if ((activeCount ?? 0) >= s.max_capacity) {
        return res.status(409).json({
          error: 'Esta clase ya alcanzó su cupo máximo.',
          reason: 'capacity_full',
          capacity: s.max_capacity,
          current: activeCount,
        });
      }
    }

    // ── 3b. Verificar que el atleta no tenga ya una reserva activa ────────
    {
      let dupQ = supabase
        .from('session_bookings')
        .select('id, status')
        .eq('session_id', actualSessionId)
        .neq('status', 'cancelled');
      dupQ = dupQ.eq(identityColumn(identity), identityValue(identity));

      const { data: existingBooking } = await dupQ.maybeSingle();
      if (existingBooking) {
        return res.status(409).json({
          error: 'Ya tienes una reserva activa para esta clase.',
          reason: 'already_booked',
          booking_id: existingBooking.id,
        });
      }
    }

    // ── 3c. Banco de horas — mismo criterio que el resto de las vías de
    // reserva: si la inscripción tiene included_minutes_per_period, se
    // reserva ANTES de insertar el booking (D-2, bloquea sin crear nada).
    const { data: enrollmentPlan } = await supabase
      .from('enrollments')
      .select('id, offering_plans(included_minutes_per_period)')
      .eq('id', enrollment_id)
      .maybeSingle();
    const isHoursPlan = (enrollmentPlan as any)?.offering_plans?.included_minutes_per_period != null;

    let hourBankReservationId: string | null = null;
    if (isHoursPlan) {
      const { data: sessDate } = await supabase
        .from('attendance_sessions')
        .select('session_date')
        .eq('id', actualSessionId)
        .maybeSingle();
      const reservationDate = sessDate?.session_date
        || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

      // Piloto "agendamiento flexible de banco de horas": si la escuela tiene
      // el flag Y la sesión (s) trae start_time/end_time reales (flujo
      // avail_, posiblemente varios bloques combinados), el descuento son
      // los minutos REALES agendados — no el bloque fijo del plan. Fuera del
      // piloto, o sin esas horas, el comportamiento es idéntico al de
      // siempre (el RPC self-computa el bloque fijo).
      let minutesOverride: number | undefined;
      if (s?.start_time && s?.end_time) {
        const { data: flexSchool } = await supabase
          .from('school_settings')
          .select('hour_bank_flexible_booking_enabled')
          .eq('school_id', enrollmentSchoolId)
          .maybeSingle();
        if (flexSchool?.hour_bank_flexible_booking_enabled) {
          minutesOverride = toMinutesHHMM(s.end_time) - toMinutesHHMM(s.start_time);
        }
      }

      const { data: reserveResult } = await supabase.rpc('reserve_hour_bank', {
        p_enrollment_id: enrollment_id, p_reservation_date: reservationDate, p_created_by: actingUserId,
        ...(minutesOverride !== undefined ? { p_minutes_override: minutesOverride } : {}),
      });
      const r = reserveResult as any;
      if (!r?.reserved) {
        return res.status(422).json(r);
      }
      hourBankReservationId = r.reservation_id;
    }

    // ── 4. Insertar booking ───────────────────────────────────────────────
    // CHECK chk_booking_identity en session_bookings: si unregistered_athlete_id
    // va seteado, enrollment_id/user_id/child_id deben ser NULL — son modos
    // mutuamente excluyentes (mismo criterio que ya documentaba trial_class_public_create
    // en 20260827184021_clases_de_prueba_agenda.sql). El enrollment sigue
    // resuelto arriba para validar ownership/banco de horas — solo se omite acá.
    const { data: b, error } = await supabase.from('session_bookings').insert({
      school_id: s.school_id,
      session_id: actualSessionId,
      enrollment_id: identity.unregisteredAthleteId ? null : enrollment_id,
      is_secondary: !!is_secondary,
      user_id: identity.userId ?? null,
      child_id: identity.childId ?? null,
      unregistered_athlete_id: identity.unregisteredAthleteId ?? null,
      status: 'confirmed',
      hour_bank_reservation_id: hourBankReservationId,
    }).select().single();

    if (error) {
      if (hourBankReservationId) {
        await supabase.rpc('cancel_hour_bank_reservation', { p_reservation_id: hourBankReservationId });
      }
      return res.status(409).json({ error: error.message });
    }

    // ── 5. Consumir la clase (atómico, ver move_session_credit) — solo el
    // sistema viejo, si no se movió el banco de horas arriba. ─────────────
    if (!isHoursPlan) {
      await supabase.rpc('move_session_credit', {
        p_enrollment_id: enrollment_id, p_delta: 1, p_is_secondary: !!is_secondary,
      });
    }

    if (actingUserId) {
      try {
        const { data: sessInfo } = await supabase
          .from('attendance_sessions')
          .select('session_date, start_time')
          .eq('id', actualSessionId)
          .maybeSingle();
        if (sessInfo) await notifyBookingConfirmed(actingUserId, sessInfo.session_date, sessInfo.start_time);
      } catch (notifErr) {
        req.log?.error({ err: notifErr }, 'book-session: fallo notificando (no bloquea la reserva)');
      }
    }

    let extra: Record<string, any> = {};
    if (postSuccess) {
      try {
        extra = (await postSuccess(b)) || {};
      } catch (postErr) {
        req.log?.error({ err: postErr }, 'bookSession: postSuccess falló (no bloquea la reserva)');
      }
    }

    res.status(201).json({ booking: b, ...extra });
  }
}

router.post('/athlete/book-session', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const parsed = AthleteBookSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid' });
    const { session_id, enrollment_id, child_id, is_secondary, duration_minutes } = parsed.data;

    // ── 1. Validar ownership del child_id ─────────────────────────────────
    if (child_id && !(await validateChildAccess(child_id, userId)))
      return res.status(403).json({ error: 'unauthorized' });

    await bookSession(
      req, res,
      child_id ? { childId: child_id } : { userId },
      { session_id, enrollment_id, is_secondary, duration_minutes },
      userId,
    );
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.get('/athlete/my-bookings', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { child_id } = req.query;
    if (child_id && !(await validateChildAccess(child_id as string, userId)))
      return res.status(403).json({ error: 'unauthorized' });

    // Resolver todas las escuelas activas del atleta
    let schoolEnrQ = supabase.from('enrollments').select('school_id').eq('status', 'active');
    if (child_id) schoolEnrQ = schoolEnrQ.eq('child_id', child_id as string);
    else schoolEnrQ = schoolEnrQ.eq('user_id', userId);
    const { data: schoolEnrs } = await schoolEnrQ;
    const athleteSchoolIds = [...new Set((schoolEnrs || []).map((e: any) => e.school_id).filter(Boolean))];
    const schoolFilter = athleteSchoolIds.length ? athleteSchoolIds : [req.schoolId];

    // ── 1. Fetch de regular bookings (session_bookings) ────────────────────
    let q = supabase.from('session_bookings').select(`
      id, status, booked_at, is_secondary, enrollment_id,
      attendance_sessions(
        id, session_date, start_time, end_time, finalized,
        coach:school_staff!attendance_sessions_coach_id_fkey(id, full_name)
      )
    `)
      .in('school_id', schoolFilter)
      .neq('status', 'cancelled')
      .order('booked_at', { ascending: false });

    if (child_id) q = q.eq('child_id', child_id);
    else q = q.eq('user_id', userId);

    const { data: bookingsReq } = await q;
    const bookings = bookingsReq || [];

    // ── 2. Fetch de PT bookings (trainer_session_plans) ───────────────────
    // Obtener enrollment IDs activos del atleta
    let enrQ = supabase.from('enrollments').select('id').eq('status', 'active');
    if (child_id) enrQ = enrQ.eq('child_id', child_id);
    else enrQ = enrQ.eq('user_id', userId);
    const { data: activeEnrs } = await enrQ;
    const activeEnrIds = (activeEnrs || []).map(e => e.id);

    // PT sessions solo de enrollments activos
    let ptQ = supabase.from('trainer_session_plans').select(`
      id, status, booked_at, enrollment_id, trainer_id,
      session_date, session_time, name
    `)
      .in('enrollment_id', activeEnrIds.length ? activeEnrIds : ['00000000-0000-0000-0000-000000000000'])
      .neq('status', 'cancelled')
      .order('booked_at', { ascending: false });
    
    if (child_id) ptQ = ptQ.eq('client_id', child_id);
    else ptQ = ptQ.eq('client_id', userId);

    const { data: ptSessionsReq } = await ptQ;
    const ptSessions = ptSessionsReq || [];

    // ── 3. Resolver enrollments, contexto y perfiles de trainer ────────────
    const enrollmentIds = [...new Set([
      ...bookings.map(b => b.enrollment_id),
      ...ptSessions.map(s => s.enrollment_id)
    ].filter(Boolean))];

    const trainerIds = [...new Set(ptSessions.map(s => s.trainer_id).filter(Boolean))];

    const [enrollmentsRes, trainersRes] = await Promise.all([
      enrollmentIds.length 
        ? supabase.from('enrollments').select('id, team_id, offering_plan_id, school_id').in('id', enrollmentIds)
        : Promise.resolve({ data: [] }),
      trainerIds.length
        ? supabase.from('profiles').select('id, full_name, avatar_url').in('id', trainerIds)
        : Promise.resolve({ data: [] }),
    ]);

    const enrollments = enrollmentsRes.data || [];
    const trainers    = trainersRes.data || [];

    const enrollmentMap = Object.fromEntries(enrollments.map(e => [e.id, e]));
    const trainerMap    = Object.fromEntries(trainers.map(t => [t.id, t]));

    const teamIds   = [...new Set(enrollments.map(e => e.team_id).filter(Boolean))];
    const planIds   = [...new Set(enrollments.map(e => e.offering_plan_id).filter(Boolean))];
    const schoolIds = [...new Set(enrollments.map(e => e.school_id).filter(Boolean))];

    const [teamsRes, plansRes, schoolsRes] = await Promise.all([
      teamIds.length   ? supabase.from('teams').select('id, name').in('id', teamIds) : Promise.resolve({ data: [] }),
      planIds.length   ? supabase.from('offering_plans').select('id, name').in('id', planIds) : Promise.resolve({ data: [] }),
      schoolIds.length ? supabase.from('schools').select('id, name, city, school_type').in('id', schoolIds) : Promise.resolve({ data: [] }),
    ]);

    const teamMap   = Object.fromEntries((teamsRes.data || []).map(t => [t.id, t]));
    const planMap   = Object.fromEntries((plansRes.data || []).map(p => [p.id, p]));
    const schoolMap = Object.fromEntries((schoolsRes.data || []).map(s => [s.id, s]));

    // ── 4. Mapear respuesta unificada ──────────────────────────────────────
    const mappedRegular = bookings.map((b: any) => {
      const enrollment = enrollmentMap[b.enrollment_id] ?? null;
      const isTeamBooking = enrollment?.team_id && !enrollment?.offering_plan_id;
      return {
        id: b.id,
        status: b.status,
        booked_at: b.booked_at,
        is_secondary: b.is_secondary,
        booking_type: isTeamBooking ? 'team' : 'offering',
        enrollment_id: b.enrollment_id,
        school_id: enrollment?.school_id ?? null,
        attendance_sessions: b.attendance_sessions,
        school_type: enrollment?.school_id ? (schoolMap[enrollment.school_id]?.school_type || 'academy') : 'academy',
        enrollments: isTeamBooking
          ? { teams: teamMap[enrollment.team_id] ?? null, offering_plans: null }
          : { teams: null, offering_plans: planMap[enrollment?.offering_plan_id] ?? null },
      };
    });

    const mappedPT = ptSessions.map((s: any) => {
      const enrollment = enrollmentMap[s.enrollment_id] ?? null;
      const trainer    = trainerMap[s.trainer_id] ?? null;
      return {
        id: s.id,
        status: s.status === 'assigned' ? 'confirmed' : s.status,
        booked_at: s.booked_at,
        is_secondary: false,
        booking_type: 'pt_session',
        enrollment_id: s.enrollment_id,
        session_type: s.session_type || 'personal',
        attendance_sessions: {
          id: s.id,
          session_date: s.session_date,
          start_time: s.session_time,
          end_time: s.session_time, // Placeholder
          finalized: s.status === 'completed',
          coach: trainer ? { id: trainer.id, full_name: trainer.full_name } : null
        },
        school_id: enrollment?.school_id ?? null,
        school_type: enrollment?.school_id ? (schoolMap[enrollment.school_id]?.school_type || 'academy') : 'academy',
        enrollments: {
          teams: null,
          offering_plans: planMap[enrollment?.offering_plan_id] ?? (s.name ? { name: s.name } : null)
        },
      };
    });

    const result = [...mappedRegular, ...mappedPT].sort((a, b) => 
      new Date(b.booked_at).getTime() - new Date(a.booked_at).getTime()
    );

    res.json(result);
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});


// Núcleo de la cancelación de session_bookings (Regular/Grupales), parametrizado
// por identidad — reusado por la ruta autenticada y por /cancel-for-enrollment
// (agendar sin cuenta). Devuelve false si la reserva no existe en esta tabla
// (para que el caller siga probando en trainer_session_plans) — en cualquier
// otro caso ya escribió la respuesta y devuelve true.
export async function cancelSessionBooking(
  req: Request, res: Response, identity: AthleteIdentity, bookingId: string,
): Promise<boolean> {
  {
    // ── 1. Intentar en session_bookings (Regular/Grupales) ────────────────
    const { data: booking } = await supabase
      .from('session_bookings')
      .select(`id, status, user_id, child_id, unregistered_athlete_id, enrollment_id, is_secondary, hour_bank_reservation_id, session_id,
        attendance_sessions ( id, coach_id, session_date, start_time, end_time, coach_availability_id, facility_id, facilities ( min_cancellation_hours ) )`)
      .eq('id', bookingId)
      .maybeSingle();

    if (booking) {
      const belongs = (booking as any)[identityColumn(identity)] === identityValue(identity);

      if (!belongs) { res.status(403).json({ error: 'unauthorized' }); return true; }
      if (booking.status === 'cancelled') { res.status(400).json({ error: 'Ya cancelada' }); return true; }
      if (booking.status !== 'confirmed') {
        res.status(400).json({
          error: 'Esta clase ya fue registrada y no se puede cancelar.',
          reason: 'not_cancellable',
        });
        return true;
      }

      const sessInfo: any = Array.isArray((booking as any).attendance_sessions)
        ? (booking as any).attendance_sessions[0]
        : (booking as any).attendance_sessions;
      if (sessInfo?.facility_id) {
        const cancelHours = sessInfo.facilities?.min_cancellation_hours ?? 0;
        if (cancelHours > 0 && sessInfo.session_date && sessInfo.start_time) {
          const sessionCO = new Date(`${sessInfo.session_date}T${sessInfo.start_time.substring(0, 8)}`);
          const sessionUTC = new Date(sessionCO.getTime() + 5 * 60 * 60 * 1000);
          const hoursUntil = (sessionUTC.getTime() - Date.now()) / 3_600_000;
          if (hoursUntil < cancelHours) {
            res.status(400).json({
              error: `Faltan menos de ${cancelHours}h para tu reserva. No se puede cancelar.`,
              reason: 'outside_cancellation_window',
            });
            return true;
          }
        }
      }

      const { error: updateError } = await supabase
        .from('session_bookings')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_reason: 'Cancelado por el atleta' })
        .eq('id', bookingId);

      if (updateError) throw updateError;

      // Reembolso de crédito — banco de horas si esta reserva se hizo por
      // esa vía, si no el sistema viejo (nunca los dos).
      if (booking.hour_bank_reservation_id) {
        await supabase.rpc('cancel_hour_bank_reservation', { p_reservation_id: booking.hour_bank_reservation_id });
      } else {
        await supabase.rpc('move_session_credit', {
          p_enrollment_id: booking.enrollment_id, p_delta: -1, p_is_secondary: !!booking.is_secondary,
        });
      }

      // Piloto "agendamiento flexible de banco de horas": si esta sesión se
      // había ESTIRADO más allá de su hora atómica (bloque de 2h+ o
      // personalizada), cancelar la reserva sin revertir esto dejaba esas
      // horas perdidas para siempre — is_bookable seguía en false y el
      // rango seguía ancho, aunque el atleta ya no tuviera nada agendado
      // ahí. Solo aplica si nadie más quedó con reservas en ese mismo
      // bloque (current_bookings en 0 tras cancelar este).
      if (sessInfo?.id && sessInfo?.coach_availability_id) {
        const { data: freshSess } = await supabase
          .from('attendance_sessions')
          .select('current_bookings')
          .eq('id', sessInfo.id)
          .maybeSingle();

        if ((freshSess?.current_bookings ?? 0) === 0) {
          const { data: origAvail } = await supabase
            .from('coach_availability')
            .select('end_time')
            .eq('id', sessInfo.coach_availability_id)
            .maybeSingle();

          if (origAvail && origAvail.end_time < sessInfo.end_time) {
            const { data: swallowed } = await supabase
              .from('attendance_sessions')
              .select('id')
              .eq('coach_id', sessInfo.coach_id)
              .eq('session_date', sessInfo.session_date)
              .eq('is_bookable', false)
              .gte('start_time', sessInfo.start_time)
              .lte('end_time', sessInfo.end_time)
              .neq('id', sessInfo.id);

            if (swallowed?.length) {
              await supabase
                .from('attendance_sessions')
                .update({ is_bookable: true })
                .in('id', swallowed.map((row: any) => row.id));
            }

            await supabase
              .from('attendance_sessions')
              .update({ end_time: origAvail.end_time })
              .eq('id', sessInfo.id);
          }
        }
      }

      res.json({ success: true });
      return true;
    }

    return false;
  }
}

// ── Static route BEFORE dynamic /athlete/:id/cancel ─────────────────────────
router.delete('/athlete/cancel-booking', requireAuth, async (req: Request, res: Response) => {
  try {
    const { booking_id, child_id } = req.query as { booking_id: string; child_id?: string };
    const userId = req.user?.id;

    const handled = await cancelSessionBooking(req, res, child_id ? { childId: child_id } : { userId }, booking_id);
    if (handled) return;

    // ── 2. Intentar en trainer_session_plans (PT) ─────────────────────────
    const { data: ptBooking } = await supabase
      .from('trainer_session_plans')
      .select('id, status, client_id')
      .eq('id', booking_id)
      .maybeSingle();

    if (ptBooking) {
      // Validar acceso (client_id es o el usuario o el hijo)
      const isMyPT = ptBooking.client_id === req.user?.id;
      let isMyChildPT = false;
      if (!isMyPT && child_id) {
        const { data: c } = await supabase.from('children').select('id').eq('id', ptBooking.client_id).eq('parent_id', req.user?.id).maybeSingle();
        isMyChildPT = !!c;
      }

      if (!isMyPT && !isMyChildPT) return res.status(403).json({ error: 'unauthorized' });
      if (ptBooking.status === 'cancelled') return res.status(400).json({ error: 'Ya cancelada' });

      // Usar el RPC para cancelar (maneja créditos)
      const { data: cancelRes, error: cancelError } = await supabase.rpc('fn_cancel_pt_session', {
        p_plan_id: booking_id,
        p_caller_id: req.user?.id
      });

      if (cancelError) throw cancelError;
      if (!cancelRes?.success) return res.status(400).json({ error: cancelRes?.error || 'No se pudo cancelar' });

      return res.json({ success: true });
    }

    return res.status(404).json({ error: 'Reserva no encontrada' });
  } catch (err) {
    console.error('Error cancelling booking:', err);
    res.status(500).json({ error: 'Error al cancelar la reserva' });
  }
});

router.delete('/athlete/:id/cancel', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { child_id } = req.query;

    // ── 1. Validar ownership del child_id ─────────────────────────────────
    if (child_id && !(await validateChildAccess(child_id as string, userId)))
      return res.status(403).json({ error: 'unauthorized' });

    // ── 2. Fetch booking ──────────────────────────────────────────────────
    const { data: b } = await supabase
      .from('session_bookings')
      .select(`id, user_id, child_id, session_id, enrollment_id, is_secondary, status,
        attendance_sessions ( session_date, start_time, facility_id, facilities ( min_cancellation_hours ) )`)
      .eq('id', id)
      .maybeSingle();

    if (!b) return res.status(404).json({ error: 'not_found' });
    if (b.status === 'cancelled') return res.status(400).json({ error: 'already_cancelled' });
    if (b.status !== 'confirmed') {
      // 'attended' / 'no_show' -> la sesion ya paso, no se puede cancelar ni devolver credito
      return res.status(400).json({
        error: 'Esta clase ya fue registrada y no se puede cancelar.',
        reason: 'not_cancellable',
      });
    }

    // Ventana de cancelación de la instalación (bloqueo duro — sin excepción,
    // a diferencia del PT donde el entrenador decide si faltan menos de 4h)
    const sessInfo: any = Array.isArray((b as any).attendance_sessions)
      ? (b as any).attendance_sessions[0]
      : (b as any).attendance_sessions;
    if (sessInfo?.facility_id) {
      const cancelHours = sessInfo.facilities?.min_cancellation_hours ?? 0;
      if (cancelHours > 0 && sessInfo.session_date && sessInfo.start_time) {
        const sessionCO = new Date(`${sessInfo.session_date}T${sessInfo.start_time.substring(0, 8)}`);
        const sessionUTC = new Date(sessionCO.getTime() + 5 * 60 * 60 * 1000);
        const hoursUntil = (sessionUTC.getTime() - Date.now()) / 3_600_000;
        if (hoursUntil < cancelHours) {
          return res.status(400).json({
            error: `Faltan menos de ${cancelHours}h para tu reserva. No se puede cancelar para no quitarle el cupo a otra persona.`,
            reason: 'outside_cancellation_window',
          });
        }
      }
    }

    // ── 3. Verificar que el booking pertenece al usuario autenticado ───────
    const bookingBelongsToUser = child_id
      ? b.child_id === child_id
      : b.user_id === userId;

    if (!bookingBelongsToUser)
      return res.status(403).json({ error: 'unauthorized' });

    // ── 4. Cancelar y decrementar ─────────────────────────────────────────
    await supabase.from('session_bookings')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', id);

    await supabase.rpc('move_session_credit', {
      p_enrollment_id: b.enrollment_id, p_delta: -1, p_is_secondary: !!b.is_secondary,
    });

    res.json({ success: true });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.get('/athlete/upcoming', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { child_id } = req.query;
    if (child_id && !(await validateChildAccess(child_id as string, userId)))
      return res.status(403).json({ error: 'unauthorized' });

    // Resolver todas las escuelas e inscripciones activas del atleta
    let schoolEnrQ = supabase.from('enrollments').select('id, school_id').eq('status', 'active');
    if (child_id) schoolEnrQ = schoolEnrQ.eq('child_id', child_id as string);
    else schoolEnrQ = schoolEnrQ.eq('user_id', userId);
    const { data: schoolEnrs } = await schoolEnrQ;
    const athleteSchoolIds = [...new Set((schoolEnrs || []).map((e: any) => e.school_id).filter(Boolean))];
    const activeEnrIds = (schoolEnrs || []).map(e => e.id);
    const schoolFilter = athleteSchoolIds.length ? athleteSchoolIds : [req.schoolId];

    const today = todayInBogota();

    // ── 1. Fetch de regular bookings futuros ───────────────────────────────
    let q = supabase.from('session_bookings').select(`
      id,
      attendance_sessions!inner(
        id, session_date, start_time, end_time,
        team:teams!attendance_sessions_team_id_fkey(name, school_id),
        coach:school_staff!attendance_sessions_coach_id_fkey(full_name)
      )
    `)
      .in('school_id', schoolFilter)
      .neq('status', 'cancelled')
      .gte('attendance_sessions.session_date', today)
      .order('session_date', { ascending: true, referencedTable: 'attendance_sessions' })
      .limit(10);

    if (child_id) q = q.eq('child_id', child_id);
    else q = q.eq('user_id', userId);

    const { data: regularData } = await q;

    // ── 2. Fetch de PT bookings futuros ───────────────────────────────────
    let ptQ = supabase.from('trainer_session_plans').select(`
      id, session_date, session_time, status, name, trainer_id
    `)
      .in('enrollment_id', activeEnrIds.length ? activeEnrIds : ['00000000-0000-0000-0000-000000000000'])
      .neq('status', 'cancelled')
      .gte('session_date', today)
      .order('session_date', { ascending: true })
      .limit(10);

    if (child_id) ptQ = ptQ.eq('client_id', child_id);
    else ptQ = ptQ.eq('client_id', userId);

    const { data: ptData } = await ptQ;

    // ── 3. Unificar y Enriquecer ──────────────────────────────────────────
    const trainerIds = [...new Set((ptData || []).map(s => s.trainer_id).filter(Boolean))];
    const { data: trainers } = trainerIds.length
      ? await supabase.from('profiles').select('id, full_name').in('id', trainerIds)
      : { data: [] };
    const trainerMap = Object.fromEntries((trainers || []).map(t => [t.id, t]));

    const rawSessions = (regularData || []).map((d: any) => ({
      ...d.attendance_sessions,
      _type: 'regular'
    }));

    const ptSessions = (ptData || []).map((s: any) => {
      const trainer = trainerMap[s.trainer_id];
      return {
        id: s.id,
        session_date: s.session_date,
        start_time: s.session_time,
        end_time: s.session_time,
        team: { 
          name: s.name || 'Sesión PT', 
          school_id: null
        },
        coach: trainer ? { full_name: trainer.full_name } : null,
        _type: 'pt'
      };
    });

    const combined = [...rawSessions, ...ptSessions];

    if (!combined.length) return res.json({ sessions: [] });

    // Resolver tipos de escuela
    const schoolIds = [...new Set(combined.map((s: any) => s.team?.school_id).filter(Boolean))];
    const { data: schools } = await supabase
      .from('schools')
      .select('id, school_type')
      .in('id', schoolIds);
    
    const schoolMap = Object.fromEntries((schools || []).map(s => [s.id, s]));

    const enriched = combined.map((s: any) => ({
      ...s,
      school_type: s.team?.school_id ? (schoolMap[s.team.school_id]?.school_type || 'academy') : 'academy'
    })).sort((a, b) => {
      const dateA = a.session_date + 'T' + a.start_time;
      const dateB = b.session_date + 'T' + b.start_time;
      return dateA.localeCompare(dateB);
    }).slice(0, 5);

    res.json({ sessions: enriched });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.post('/athlete/book-secondary', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const parsed = BookSecondarySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid' });
    const { enrollment_id, facility_id, reservation_date, slots, child_id } = parsed.data;

    // ── 1. Validar ownership del child_id ─────────────────────────────────
    if (child_id && !(await validateChildAccess(child_id, userId)))
      return res.status(403).json({ error: 'unauthorized' });

    // ── 2. Validar que el enrollment pertenece al atleta ──────────────────
    const { valid: enrollmentValid, schoolId: enrollmentSchoolId } =
      await validateEnrollmentOwnership(enrollment_id, child_id ? { childId: child_id } : { userId });
    if (!enrollmentValid || !enrollmentSchoolId)
      return res.status(403).json({ error: 'enrollment_unauthorized' });

    // ── 2a. Instalación: debe ser de la escuela de la inscripción, recibir
    // reservas y estar disponible. Antes se aceptaba cualquier facility_id
    // (de otra escuela, deshabilitada o en mantenimiento). Un solo 404 para
    // "no existe" y "es de otra escuela" para no filtrar qué ids existen.
    const { data: facilityRow } = await supabase
      .from('facilities')
      .select('id, school_id, booking_enabled, status')
      .eq('id', facility_id)
      .maybeSingle();
    if (!facilityRow || facilityRow.school_id !== enrollmentSchoolId) {
      return res.status(404).json({ error: 'Instalación no encontrada para tu escuela.', reason: 'facility_not_found' });
    }
    if (facilityRow.booking_enabled === false) {
      return res.status(422).json({ error: 'Esta instalación no recibe reservas por ahora.', reason: 'facility_not_bookable' });
    }
    if (facilityRow.status !== 'available') {
      return res.status(422).json({ error: 'Esta instalación no está disponible en este momento.', reason: 'facility_unavailable' });
    }

    // ── 2b. Idempotencia (opcional): header Idempotency-Key. Si ya hay una
    // reserva de esta escuela con esa llave se devuelve la misma, sin volver
    // a mover crédito ni banco de horas. Sin header: comportamiento de siempre.
    const idemRaw = req.header('Idempotency-Key');
    const idempotencyKey = idemRaw ? idemRaw.trim() : null;
    if (idemRaw !== undefined && (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
      return res.status(400).json({ error: 'Idempotency-Key inválida: debe tener entre 8 y 128 caracteres.', reason: 'invalid_idempotency_key' });
    }
    const findByIdempotencyKey = async () => {
      const { data } = await supabase
        .from('facility_reservations')
        .select('*')
        .eq('school_id', enrollmentSchoolId)
        .eq('idempotency_key', idempotencyKey as string)
        .maybeSingle();
      return data as any;
    };
    if (idempotencyKey) {
      const prior = await findByIdempotencyKey();
      if (prior) {
        const sameOwner = child_id ? prior.child_id === child_id : prior.user_id === userId;
        if (!sameOwner || prior.facility_id !== facility_id || prior.reservation_date !== reservation_date) {
          return res.status(409).json({ error: 'Esa Idempotency-Key ya se usó con otra solicitud distinta.', reason: 'idempotency_key_conflict' });
        }
        return res.status(200).json({ reservation: prior, idempotent_replay: true });
      }
    }

    // ── 3b. Banco de horas — mismo criterio que /:id/book: si la inscripción
    // tiene plan por horas, reserve_hour_bank ANTES de insertar (D-2: bloquea
    // sin saldo, no crea la reserva a medias).
    const { data: enrollmentPlan } = await supabase
      .from('enrollments')
      .select('id, offering_plans(included_minutes_per_period)')
      .eq('id', enrollment_id)
      .maybeSingle();
    const isHoursPlan = (enrollmentPlan as any)?.offering_plans?.included_minutes_per_period != null;

    let hourBankReservationId: string | null = null;
    if (isHoursPlan) {
      const { data: reserveResult } = await supabase.rpc('reserve_hour_bank', {
        p_enrollment_id: enrollment_id, p_reservation_date: reservation_date, p_created_by: userId,
      });
      const r = reserveResult as any;
      if (!r?.reserved) {
        return res.status(422).json(r);
      }
      hourBankReservationId = r.reservation_id;
    }

    // ── 3a. Tope de secundarias (offering_plans.max_secondary_sessions) ────
    // move_session_credit toma SELECT … FOR UPDATE sobre la inscripción y
    // topa en el máximo (NULL = ilimitado): reservar el cupo ANTES de insertar
    // es atómico — dos llamadas simultáneas no pasan ambas el tope. Si el
    // insert falla se compensa con delta -1. Planes por horas: el tope es el
    // saldo del banco (ya validado arriba), no este contador.
    let secondaryCreditReserved = false;
    if (!isHoursPlan) {
      const { data: moved, error: moveErr } = await supabase.rpc('move_session_credit', {
        p_enrollment_id: enrollment_id, p_delta: 1, p_is_secondary: true,
      });
      if (moveErr) throw moveErr; // fail-closed: sin saber el tope no se reserva
      const m = moved as any;
      if (m?.capped && !m?.moved) {
        return res.status(409).json({
          error: 'Ya usaste todas las clases secundarias de tu plan.',
          code: 'SECONDARY_CAP_REACHED',
          reason: 'secondary_cap_reached',
          secondary_sessions_used: m.secondary_sessions_used ?? null,
          max_secondary_sessions: m.max_secondary_sessions ?? null,
        });
      }
      secondaryCreditReserved = !!m?.moved;
    }

    // ── 3. Insertar reserva ───────────────────────────────────────────────
    const { data: b, error } = await supabase.from('facility_reservations').insert({
      facility_id,
      school_id: enrollmentSchoolId,
      user_id: child_id ? null : userId,
      child_id: child_id || null,
      enrollment_id,
      reservation_date,
      start_time: slots[0].start_time,
      end_time: slots[slots.length - 1].end_time,
      status: 'confirmed',
      resv_type: 'secondary_class',
      hour_bank_reservation_id: hourBankReservationId,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    }).select().single();

    if (error) {
      if (hourBankReservationId) {
        await supabase.rpc('cancel_hour_bank_reservation', { p_reservation_id: hourBankReservationId });
      }
      if (secondaryCreditReserved) {
        await supabase.rpc('move_session_credit', {
          p_enrollment_id: enrollment_id, p_delta: -1, p_is_secondary: true,
        });
      }
      // Carrera de dos llamadas con la misma llave: ganó la otra (UNIQUE
      // school_id+idempotency_key). Se compensó el banco arriba; se devuelve la ganadora.
      if (idempotencyKey && (error as any).code === '23505' && error.message?.includes('idempotency')) {
        const winner = await findByIdempotencyKey();
        if (winner) return res.status(200).json({ reservation: winner, idempotent_replay: true });
      }
      // Trigger fn_check_facility_reservation_overlap (DB) rechaza choques de horario
      if (error.message?.includes('facility_slot_conflict')) {
        return res.status(409).json({
          error: 'Ese horario ya fue reservado por otra persona. Elige otro horario.',
          reason: 'facility_slot_conflict',
        });
      }
      throw error;
    }

    // (4. La secundaria ya se consumió en 3a, antes del insert.)

    try {
      await notifyBookingConfirmed(userId, reservation_date, slots[0].start_time);
    } catch (notifErr) {
      req.log?.error({ err: notifErr }, 'book-secondary: fallo notificando (no bloquea la reserva)');
    }

    await auditLog(req, 'facility_reservation_book_secondary', 'facility_reservations', String((b as any)?.id), null,
      { facility_id, reservation_date, enrollment_id, school_id: enrollmentSchoolId, hours_plan: isHoursPlan }, { metadata: { school_id: enrollmentSchoolId } });
    res.status(201).json({ reservation: b });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.get('/athlete/secondary-bookings', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { child_id } = req.query;
    if (child_id && !(await validateChildAccess(child_id as string, userId)))
      return res.status(403).json({ error: 'unauthorized' });

    // Resolver todas las escuelas activas del atleta
    let schoolEnrQ = supabase.from('enrollments').select('school_id').eq('status', 'active');
    if (child_id) schoolEnrQ = schoolEnrQ.eq('child_id', child_id as string);
    else schoolEnrQ = schoolEnrQ.eq('user_id', userId);
    const { data: schoolEnrs } = await schoolEnrQ;
    const athleteSchoolIds = [...new Set((schoolEnrs || []).map((e: any) => e.school_id).filter(Boolean))];
    const schoolFilter = athleteSchoolIds.length ? athleteSchoolIds : [req.schoolId];

    let q = supabase.from('facility_reservations')
      .select('id, status, reservation_date, start_time, end_time, enrollment_id, facilities(name, id)')
      .in('school_id', schoolFilter)
      .eq('resv_type', 'secondary_class')
      .neq('status', 'cancelled')
      .order('reservation_date', { ascending: false });

    if (child_id) q = q.eq('child_id', child_id);
    else q = q.eq('user_id', userId);

    const { data } = await q;
    if (!data?.length) return res.json([]);

    const enrollmentIds = [...new Set(data.map((r: any) => r.enrollment_id).filter(Boolean))];
    const { data: enrollments } = await supabase
      .from('enrollments')
      .select('id, school_id')
      .in('id', enrollmentIds);

    const enrMap = Object.fromEntries((enrollments || []).map(e => [e.id, e]));
    const schoolIds = [...new Set((enrollments || []).map(e => e.school_id).filter(Boolean))];

    const { data: schools } = await supabase
      .from('schools')
      .select('id, school_type')
      .in('id', schoolIds);

    const schoolMap = Object.fromEntries((schools || []).map(s => [s.id, s]));

    const enriched = data.map((r: any) => {
      const enr = enrMap[r.enrollment_id];
      const schoolType = enr?.school_id ? (schoolMap[enr.school_id]?.school_type || 'academy') : 'academy';
      return { ...r, school_type: schoolType };
    });

    res.json(enriched);
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.delete('/athlete/secondary/:id/cancel', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { child_id } = req.query;

    // ── 1. Validar ownership del child_id ─────────────────────────────────
    if (child_id && !(await validateChildAccess(child_id as string, userId)))
      return res.status(403).json({ error: 'unauthorized' });

    // ── 2. Fetch reserva ──────────────────────────────────────────────────
    const { data: r } = await supabase
      .from('facility_reservations')
      .select('id, user_id, child_id, enrollment_id, status, hour_bank_reservation_id')
      .eq('id', id)
      .maybeSingle();

    if (!r) return res.status(404).json({ error: 'not_found' });
    if (r.status === 'cancelled') return res.status(400).json({ error: 'already_cancelled' });

    // ── 3. Verificar que la reserva pertenece al usuario autenticado ───────
    const reservationBelongsToUser = child_id
      ? r.child_id === child_id
      : r.user_id === userId;

    if (!reservationBelongsToUser)
      return res.status(403).json({ error: 'unauthorized' });

    // ── 4. Cancelar y decrementar ─────────────────────────────────────────
    await supabase.from('facility_reservations')
      .update({ status: 'cancelled' })
      .eq('id', id);

    if (r.hour_bank_reservation_id) {
      await supabase.rpc('cancel_hour_bank_reservation', { p_reservation_id: r.hour_bank_reservation_id });
    } else {
      await supabase.rpc('move_session_credit', {
        p_enrollment_id: r.enrollment_id, p_delta: -1, p_is_secondary: true,
      });
    }

    await auditLog(req, 'facility_reservation_cancel_secondary', 'facility_reservations', String(id), { status: r.status }, { status: 'cancelled', enrollment_id: r.enrollment_id });
    res.json({ success: true });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.get('/athlete/facilities', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { child_id } = req.query;
    if (child_id && !(await validateChildAccess(child_id as string, userId)))
      return res.status(403).json({ error: 'unauthorized' });

    let q = supabase.from('enrollments')
      .select('school_id')
      .eq('status', 'active');
    if (child_id) q = q.eq('child_id', child_id);
    else q = q.eq('user_id', userId);

    const { data: enrs } = await q;
    const sIds = [...new Set((enrs || []).map(e => e.school_id))];
    if (!sIds.length) return res.json({ facilities: [] });

    const { data: facs } = await supabase
      .from('facilities')
      .select('id, name, type, school_id')
      .in('school_id', sIds)
      .eq('status', 'available')
      .eq('booking_enabled', true);

    res.json({ facilities: facs || [] });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.get('/facility/:id/slots', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { date, child_id } = req.query;
    const userId = req.user?.id;

    if (child_id && !(await validateChildAccess(child_id as string, userId)))
      return res.status(403).json({ error: 'unauthorized' });

    const dStr = (date as string) || todayInBogota();

    const { data: f } = await supabase.from('facilities').select('*').eq('id', id).single();
    if (!f) return res.status(404).json({ error: 'not_found' });

    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dName = days[new Date(dStr + 'T12:00:00').getDay()];
    const hs = (f.available_hours as any)?.[dName] || [];

    let slots: { start: string; end: string }[] = [];
    if (hs.length > 0) {
      const [start, end] = hs[0].split('-').map((h: string) => parseInt(h));
      for (let i = start; i < end; i++) {
        slots.push({
          start: `${String(i).padStart(2, '0')}:00`,
          end: `${String(i + 1).padStart(2, '0')}:00`,
        });
      }
    }

    const { data: booked } = await supabase
      .from('facility_reservations')
      .select('start_time, user_id, child_id')
      .eq('facility_id', id)
      .eq('reservation_date', dStr)
      .neq('status', 'cancelled');

    const bookedSet = new Set((booked || []).map(b => b.start_time.slice(0, 5)));
    const mySet = new Set(
      (booked || [])
        .filter(b => child_id ? b.child_id === child_id : b.user_id === userId)
        .map(b => b.start_time.slice(0, 5))
    );

    res.json({
      facility_name: f.name,
      slots: slots.map(s => ({
        ...s,
        available: !bookedSet.has(s.start),
        already_booked: mySet.has(s.start),
      })),
    });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ── UTILITY ROUTES ────────────────────────────────────────────────────────────

router.post('/generate-sessions', requireAuth, requireRole('owner', 'admin'), async (req: Request, res: Response) => {
  try {
    const { team_id, weeks } = req.body;
    const { data, error } = await supabase.rpc('fn_generate_bookable_sessions', {
      p_school_id: req.schoolId, p_team_id: team_id, p_weeks: weeks || 2,
    });
    if (error) throw error;
    res.json({ message: 'success', sessions: data });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.post('/generate-offering-sessions', requireAuth, requireRole('owner', 'admin'), async (req: Request, res: Response) => {
  try {
    const { offering_id, weeks } = req.body;
    const { data, error } = await supabase.rpc('fn_generate_offering_sessions', {
      p_school_id: req.schoolId, p_offering_id: offering_id, p_weeks: weeks || 2,
    });
    if (error) throw error;
    res.json({ message: 'success', sessions: data });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.get('/extend-horizon', requireAuth, async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase.rpc('fn_extend_session_horizon', {
      p_school_id: req.schoolId, p_min_weeks: 2, p_target_weeks: 4,
    });
    if (error) throw error;
    res.json({ sessions_created: data });
  } catch (err: any) {
    req.log?.error({ err }, 'session-bookings unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Las rutas legacy de PT (GET /athlete/pt-availability, POST /athlete/book-pt-session, DELETE /athlete/cancel-pt-session) fueron eliminadas por ser código muerto. El frontend ahora llama a las rutas correspondientes en training.ts.

export default router;