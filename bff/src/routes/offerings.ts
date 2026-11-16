import { Router, Request, Response } from 'express';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { supabase } from '../config/supabase';
import { todayInZone } from '../utils/businessDate';
import { z } from 'zod';
import { bloquearNombreDePlan, esNombreDePagoUnico, pagoUnicoNoEsPlanBody } from '../utils/pagosUnicos';

const router = Router();

// Nombre actual de una fila (offerings / offering_plans) de la escuela, para dejar
// editar los planes viejos llamados «Inscripción»/«Seguro» sin obligar a renombrarlos.
async function nombreActual(tabla: 'offerings' | 'offering_plans', id: string, schoolId: string): Promise<string | null> {
    const { data } = await supabase
        .from(tabla)
        .select('name')
        .eq('id', id)
        .eq('school_id', schoolId)
        .maybeSingle();
    return (data as { name?: string } | null)?.name ?? null;
}

// true = respondió 400 (crear o renombrar a «Inscripción»/«Seguro»/«Matrícula»/«Póliza»).
async function rechazarNombreDePagoUnico(
    res: Response,
    nombreNuevo: string | undefined,
    actual?: { tabla: 'offerings' | 'offering_plans'; id: string; schoolId: string },
): Promise<boolean> {
    if (!nombreNuevo || !esNombreDePagoUnico(nombreNuevo)) return false;
    const previo = actual ? await nombreActual(actual.tabla, actual.id, actual.schoolId) : null;
    if (!bloquearNombreDePlan(nombreNuevo, previo)) return false;
    res.status(400).json(pagoUnicoNoEsPlanBody());
    return true;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

// Modo de agendamiento del plan (docs/specs — toggle instalación/entrenador/ambas):
// coach = solo coach_availability (default, comportamiento histórico); facility = solo
// facility_availability de facility_id; both = ofrece las dos superficies al atleta.
const BookingModeSchema = z.enum(['coach', 'facility', 'both']);

const CreateOfferingSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    offering_type: z.enum(['membership', 'session_pack', 'court_booking', 'tournament', 'single_session']),
    sport: z.string().optional(),
    branch_id: z.string().uuid().optional(),
    booking_mode: BookingModeSchema.optional().default('coach'),
    facility_id: z.string().uuid().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
    sort_order: z.number().int().min(0).optional().default(0),
}).refine(
    (data) => data.booking_mode === 'coach' || !!data.facility_id,
    { message: 'facility_id es requerido cuando booking_mode es "facility" o "both"', path: ['facility_id'] }
);

const UpdateOfferingSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().optional(),
    sport: z.string().optional(),
    branch_id: z.string().uuid().nullable().optional(),
    is_active: z.boolean().optional(),
    booking_mode: BookingModeSchema.optional(),
    facility_id: z.string().uuid().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    sort_order: z.number().int().min(0).optional(),
}).refine(
    (data) => data.booking_mode !== 'coach' || data.facility_id === undefined || data.facility_id === null,
    { message: 'facility_id debe quedar vacío cuando booking_mode es "coach"', path: ['facility_id'] }
).refine(
    (data) => !(data.booking_mode && data.booking_mode !== 'coach') || data.facility_id !== null,
    { message: 'facility_id es requerido cuando booking_mode es "facility" o "both"', path: ['facility_id'] }
);

const CreatePlanSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    // 0 = sin tope (∞): se acepta y se guarda como NULL.
    max_sessions: z.preprocess((v) => (v === 0 ? null : v), z.number().int().positive().nullable().optional()),
    max_secondary_sessions: z.number().int().min(0).optional().default(0),
    duration_days: z.number().int().positive().default(30),
    price: z.number().min(0),
    currency: z.string().default('COP'),
    slot_duration_minutes: z.number().int().positive().optional(),
    auto_renew: z.boolean().default(false),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
    sort_order: z.number().int().min(0).optional().default(0),
    // Banco de horas (docs/specs/dreamers-banco-de-horas-torniquete.md, D-1): si no es null,
    // el plan se mide en minutos por período en vez de max_sessions. No son excluyentes a
    // nivel de esquema — la UI decide cuál de los dos mostrar/editar por vez.
    included_minutes_per_period: z.number().int().positive().nullable().optional(),
    // Niveles por horas (docs/specs/dreamers-niveles-por-horas-y-progresion.md, D1/D2/D17):
    // bloque de sesión y días/semana propios del plan, y cobro de inscripción único aparte
    // de la mensualidad. Los tres nullable — NULL mantiene el comportamiento actual.
    session_block_minutes: z.number().int().positive().nullable().optional(),
    included_sessions_per_week: z.number().int().positive().nullable().optional(),
    registration_fee: z.number().min(0).nullable().optional(),
    // Seguro de accidentes cobrado en el alta (F-B, dedupe 365 días). NULL = sin cobro.
    insurance_fee: z.number().min(0).nullable().optional(),
});

const UpdatePlanSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().optional(),
    // 0 = sin tope (∞): se acepta y se guarda como NULL.
    max_sessions: z.preprocess((v) => (v === 0 ? null : v), z.number().int().positive().nullable().optional()),
    max_secondary_sessions: z.number().int().min(0).optional(),
    duration_days: z.number().int().positive().optional(),
    price: z.number().min(0).optional(),
    currency: z.string().default('COP').optional(),
    slot_duration_minutes: z.number().int().positive().nullable().optional(),
    auto_renew: z.boolean().optional(),
    is_active: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    sort_order: z.number().int().min(0).optional(),
    included_minutes_per_period: z.number().int().positive().nullable().optional(),
    session_block_minutes: z.number().int().positive().nullable().optional(),
    included_sessions_per_week: z.number().int().positive().nullable().optional(),
    registration_fee: z.number().min(0).nullable().optional(),
    // Seguro de accidentes cobrado en el alta (F-B, dedupe 365 días). NULL = sin cobro.
    insurance_fee: z.number().min(0).nullable().optional(),
});

// Piloto (docs — booking_mode toggle): antes de aceptar un booking_mode distinto
// de 'coach', revalidar en servidor que la escuela tenga el flag habilitado.
// El formulario ya oculta el selector si no lo tiene, pero eso no es autoritativo
// — sin este chequeo, cualquiera podía llamar el endpoint directo y activar
// facility/both en una escuela fuera del piloto.
async function assertBookingModeEnabled(schoolId: string, bookingMode: string | undefined): Promise<boolean> {
    if (!bookingMode || bookingMode === 'coach') return true;
    const { data } = await supabase
        .from('school_settings')
        .select('booking_mode_toggle_enabled')
        .eq('school_id', schoolId)
        .maybeSingle();
    return !!data?.booking_mode_toggle_enabled;
}

// ── GET /api/v1/offerings ────────────────────────────────────────────────────

router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const { type, active_only } = req.query;

        // ✅ QUERY 1: Offerings + Plans
        let query = supabase
            .from('offerings')
            .select('*, offering_plans(*)')
            .eq('school_id', schoolId)
            .order('sort_order', { ascending: true });

        if (type) {
            query = query.eq('offering_type', type as string);
        }
        if (active_only !== 'false') {
            query = query.eq('is_active', true);
        }

        const { data: offerings, error: offeringError } = await query;
        if (offeringError) throw offeringError;

        // ✅ QUERY 2: Solo enrollments SIN join
        const { data: allEnrollments, error: enrollmentError } = await supabase
            .from('enrollments')
            .select('id, user_id, offering_plan_id, status, sessions_used, secondary_sessions_used, expires_at')
            .eq('school_id', schoolId)
            .eq('status', 'active');

        if (enrollmentError) throw enrollmentError;

        // ✅ QUERY 3: Perfiles de los usuarios enrollados
        const userIds = allEnrollments?.map(e => e.user_id).filter(Boolean) || [];
        const uniqueUserIds = [...new Set(userIds)];

        let profiles: any[] = [];
        if (uniqueUserIds.length > 0) {
            const { data: profileData, error: profileError } = await supabase
                .from('profiles')
                .select('id, full_name, email')
                .in('id', uniqueUserIds);

            if (profileError) throw profileError;
            profiles = profileData || [];
        }

        // ✅ COMBINAR en código (no en Supabase)
        const profileMap = new Map(profiles.map(p => [p.id, p]));

        const enrollmentsWithProfiles = (allEnrollments || []).map(e => ({
            ...e,
            profile: profileMap.get(e.user_id) || null
        }));

        const result = (offerings || []).map(offering => ({
            ...offering,
            offering_plans: (offering.offering_plans || []).map((plan: any) => ({
                ...plan,
                enrollments: enrollmentsWithProfiles.filter(e => e.offering_plan_id === plan.id)
            }))
        }));

        res.json({ offerings: result });
    } catch (err) {
        console.error('Error listing offerings:', err);
        (req as any).log?.error({ err }, 'Error listing offerings');
        res.status(500).json({ error: 'Error al listar offerings', details: (err as any).message });
    }
});

// ── GET /api/v1/offerings/:id ────────────────────────────────────────────────

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const { id } = req.params;

        const { data: offering, error: offeringError } = await supabase
            .from('offerings')
            .select('*, offering_plans(*)')
            .eq('id', id)
            .eq('school_id', schoolId)
            .single();

        if (offeringError || !offering) {
            return res.status(404).json({ error: 'Offering no encontrado' });
        }

        // Sin join de Supabase
        const planIds = offering.offering_plans?.map((p: any) => p.id) || [];
        const { data: enrollments } = await supabase
            .from('enrollments')
            .select('id, user_id, offering_plan_id, status, sessions_used, secondary_sessions_used, expires_at')
            .in('offering_plan_id', planIds)
            .eq('school_id', schoolId)
            .eq('status', 'active');

        const userIds = enrollments?.map(e => e.user_id).filter(Boolean) || [];
        const uniqueUserIds = [...new Set(userIds)];

        let profiles: any[] = [];
        if (uniqueUserIds.length > 0) {
            const { data: profileData } = await supabase
                .from('profiles')
                .select('id, full_name, email')
                .in('id', uniqueUserIds);
            profiles = profileData || [];
        }

        const profileMap = new Map(profiles.map(p => [p.id, p]));
        const enrollmentsWithProfiles = (enrollments || []).map(e => ({
            ...e,
            profile: profileMap.get(e.user_id) || null
        }));

        const result = {
            ...offering,
            offering_plans: offering.offering_plans?.map((plan: any) => ({
                ...plan,
                enrollments: enrollmentsWithProfiles.filter(e => e.offering_plan_id === plan.id)
            })) || []
        };

        res.json({ offering: result });
    } catch (err) {
        console.error('Error fetching offering:', err);
        (req as any).log?.error({ err }, 'Error fetching offering');
        res.status(500).json({ error: 'Error al obtener offering', details: (err as any).message });
    }
});

// ── POST /api/v1/offerings ───────────────────────────────────────────────────

router.post('/',
    requireAuth,
    requireRole('owner', 'admin', 'school_admin'),
    async (req: Request, res: Response) => {
        try {
            const parsed = CreateOfferingSchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
            }

            const { schoolId } = req;

            if (await rechazarNombreDePagoUnico(res, parsed.data.name)) return;

            if (!(await assertBookingModeEnabled(schoolId!, parsed.data.booking_mode))) {
                return res.status(403).json({
                    error: 'Esta escuela no tiene habilitado el agendamiento por instalación.',
                    reason: 'booking_mode_not_enabled',
                });
            }

            const { data, error } = await supabase
                .from('offerings')
                .insert({ ...parsed.data, school_id: schoolId })
                .select()
                .single();

            if (error) throw error;
            res.status(201).json({ offering: data });
        } catch (err) {
            (req as any).log?.error({ err }, 'Error creating offering');
            res.status(500).json({ error: 'Error al crear offering' });
        }
    }
);

// ── PATCH /api/v1/offerings/:id ──────────────────────────────────────────────

router.patch('/:id',
    requireAuth,
    requireRole('owner', 'admin', 'school_admin'),
    async (req: Request, res: Response) => {
        try {
            const parsed = UpdateOfferingSchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
            }

            const { schoolId } = req;
            const { id } = req.params;

            if (await rechazarNombreDePagoUnico(res, parsed.data.name, { tabla: 'offerings', id: String(id), schoolId: schoolId! })) return;

            if (!(await assertBookingModeEnabled(schoolId!, parsed.data.booking_mode))) {
                return res.status(403).json({
                    error: 'Esta escuela no tiene habilitado el agendamiento por instalación.',
                    reason: 'booking_mode_not_enabled',
                });
            }

            const { data, error } = await supabase
                .from('offerings')
                .update(parsed.data)
                .eq('id', id)
                .eq('school_id', schoolId)
                .select()
                .single();

            if (error) throw error;
            if (!data) return res.status(404).json({ error: 'Offering no encontrado' });

            res.json({ offering: data });
        } catch (err) {
            (req as any).log?.error({ err }, 'Error updating offering');
            res.status(500).json({ error: 'Error al actualizar offering' });
        }
    }
);

// ── DELETE /api/v1/offerings/:id ─────────────────────────────────────────────

router.delete('/:id',
    requireAuth,
    requireRole('owner', 'admin', 'school_admin'),
    async (req: Request, res: Response) => {
        try {
            const { schoolId } = req;
            const { id } = req.params;

            // Antes del DELETE — verificar que no haya enrollments activos
            const { data: plans } = await supabase
                .from('offering_plans')
                .select('id')
                .eq('offering_id', id);

            const planIds = plans?.map(p => p.id) || [];
            if (planIds.length > 0) {
                const { count } = await supabase
                    .from('enrollments')
                    .select('id', { count: 'exact', head: true })
                    .in('offering_plan_id', planIds)
                    .eq('status', 'active');

                if (count && count > 0) {
                    return res.status(409).json({
                        error: 'No se puede eliminar un offering con inscripciones activas',
                        code: 'OFFERING_HAS_ACTIVE_ENROLLMENTS'
                    });
                }
            }

            const { error } = await supabase
                .from('offerings')
                .delete()
                .eq('id', id)
                .eq('school_id', schoolId);

            if (error) throw error;
            res.json({ success: true });
        } catch (err) {
            (req as any).log?.error({ err }, 'Error deleting offering');
            res.status(500).json({ error: 'Error al eliminar offering' });
        }
    }
);

// ── GET /api/v1/offerings/:id/plans ──────────────────────────────────────────

router.get('/:id/plans', requireAuth, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const { id } = req.params;

        const { data, error } = await supabase
            .from('offering_plans')
            .select('*')
            .eq('offering_id', id)
            .eq('school_id', schoolId)
            .eq('is_active', true)
            .order('sort_order', { ascending: true });

        if (error) throw error;
        res.json({ plans: data });
    } catch (err) {
        (req as any).log?.error({ err }, 'Error listing plans');
        res.status(500).json({ error: 'Error al listar planes' });
    }
});

// ── Ascenso y días (F-F, docs/specs/dreamers-niveles-por-horas-y-progresion.md) ──
// Campos pasivos del plan, todos nullable (NULL = comportamiento de hoy):
//   · allowed_days_of_week: días en que el plan permite reservar (0=dom … 6=sáb), D9.
//   · promotion_threshold_points / promotion_min_competition_level: umbral para
//     ENTRAR a este plan (plan destino), D15. Solo sugiere (D4).
// Se mezclan con Create/UpdatePlanSchema en los handlers (bloque aparte a propósito).
const PlanLevelRulesSchema = z.object({
    allowed_days_of_week: z.array(z.number().int().min(0).max(6)).min(1).max(7)
        .transform((days) => [...new Set(days)].sort((a, b) => a - b))
        .nullable().optional(),
    promotion_threshold_points: z.number().min(0).nullable().optional(),
    promotion_min_competition_level: z.enum(['club', 'regional', 'nacional', 'federacion']).nullable().optional(),
});

// ── POST /api/v1/offerings/:id/plans ─────────────────────────────────────────

router.post('/:id/plans',
    requireAuth,
    requireRole('owner', 'admin', 'school_admin'),
    async (req: Request, res: Response) => {
        try {
            const parsed = CreatePlanSchema.merge(PlanLevelRulesSchema).safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
            }

            const { schoolId } = req;
            const { id: offeringId } = req.params;

            if (await rechazarNombreDePagoUnico(res, parsed.data.name)) return;

            // Verificar que el offering pertenece a la escuela
            const { data: offering, error: offErr } = await supabase
                .from('offerings')
                .select('id')
                .eq('id', offeringId)
                .eq('school_id', schoolId)
                .single();

            if (offErr || !offering) {
                return res.status(404).json({ error: 'Offering no encontrado' });
            }

            // Banco de horas (docs/specs/dreamers-banco-de-horas-torniquete.md): un plan
            // con included_minutes_per_period solo funciona si la escuela lo tiene
            // prendido (school_settings.hours_plan_enabled) — si no, get_or_open_hour_bank_period
            // nunca abre período igual, pero mejor no dejar crear un plan que en la
            // práctica no va a hacer nada, confunde a quien lo configuró.
            if (parsed.data.included_minutes_per_period != null) {
                const { data: ss } = await supabase
                    .from('school_settings')
                    .select('hours_plan_enabled')
                    .eq('school_id', schoolId)
                    .maybeSingle();
                if (!ss?.hours_plan_enabled) {
                    return res.status(403).json({ error: 'El banco de horas no está habilitado para esta escuela' });
                }
            }

            const { data, error } = await supabase
                .from('offering_plans')
                .insert({
                    ...parsed.data,
                    offering_id: offeringId,
                    school_id: schoolId,
                })
                .select()
                .single();

            if (error) throw error;

            if ((parsed.data.metadata as any)?.schedule_type === 'specific' && 
                Array.isArray((parsed.data.metadata as any)?.schedule) && 
                (parsed.data.metadata as any).schedule.length > 0) {
              
              // Llamar la función genérica — genera sesiones para las próximas 8 semanas
              await supabase.rpc('fn_generate_sessions_from_offering_schedule', {
                p_offering_id: offeringId,
                p_weeks: 8,
              });
            }

            res.status(201).json({ plan: data });
        } catch (err) {
            (req as any).log?.error({ err }, 'Error creating plan');
            res.status(500).json({ error: 'Error al crear plan' });
        }
    }
);

// ── PATCH /api/v1/offerings/:offeringId/plans/:planId ────────────────────────

router.patch('/:offeringId/plans/:planId',
    requireAuth,
    requireRole('owner', 'admin', 'school_admin'),
    async (req: Request, res: Response) => {
        try {
            const parsed = UpdatePlanSchema.merge(PlanLevelRulesSchema).safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
            }

            const { schoolId } = req;
            const { planId, offeringId } = req.params;

            if (await rechazarNombreDePagoUnico(res, parsed.data.name, { tabla: 'offering_plans', id: String(planId), schoolId: schoolId! })) return;

            // Banco de horas: mismo gate que al crear el plan (ver POST /plans).
            if (parsed.data.included_minutes_per_period != null) {
                const { data: ss } = await supabase
                    .from('school_settings')
                    .select('hours_plan_enabled')
                    .eq('school_id', schoolId)
                    .maybeSingle();
                if (!ss?.hours_plan_enabled) {
                    return res.status(403).json({ error: 'El banco de horas no está habilitado para esta escuela' });
                }
            }

            const { data, error } = await supabase
                .from('offering_plans')
                .update(parsed.data)
                .eq('id', planId)
                .eq('school_id', schoolId)
                .select()
                .single();

            if (error) throw error;
            if (!data) return res.status(404).json({ error: 'Plan no encontrado' });

            if ((parsed.data.metadata as any)?.schedule_type === 'specific' && 
                Array.isArray((parsed.data.metadata as any)?.schedule) && 
                (parsed.data.metadata as any).schedule.length > 0) {
              
              // ── 1. Borrar sesiones futuras sin reservas del horario anterior ──────────
              // Solo eliminamos las que no tienen bookings confirmados y no están finalizadas
              // para no afectar clases ya agendadas por atletas
              await supabase
                .from('attendance_sessions')
                .delete()
                .eq('offering_id', offeringId)
                .gte('session_date', todayInZone())
                .eq('current_bookings', 0)
                .eq('finalized', false);

              // ── 2. Regenerar con el nuevo schedule ───────────────────────────────────
              await supabase.rpc('fn_generate_sessions_from_offering_schedule', {
                p_offering_id: offeringId,
                p_weeks: 8,
              });
            }

            res.json({ plan: data });
        } catch (err) {
            (req as any).log?.error({ err }, 'Error updating plan');
            res.status(500).json({ error: 'Error al actualizar plan' });
        }
    }
);

// ── POST /api/v1/offerings/one-time-fees/apply ───────────────────────────────
// «Aplicar a todos los planes»: fija la misma Inscripción y el mismo Seguro en
// varias tarifas de la escuela con UN solo UPDATE (atómico: o quedan todas o
// ninguna). null = deja de cobrarse. Solo toca registration_fee / insurance_fee;
// un campo ausente del body no se modifica. No crea ni cobra nada: el cobro sigue
// siendo emit_enrollment_fees en el alta.
const ApplyOneTimeFeesSchema = z.object({
    plan_ids: z.array(z.string().uuid()).min(1).max(500),
    registration_fee: z.number().min(0).nullable().optional(),
    insurance_fee: z.number().min(0).nullable().optional(),
}).refine(
    (d) => d.registration_fee !== undefined || d.insurance_fee !== undefined,
    { message: 'Indica la inscripción, el seguro o ambos', path: ['registration_fee'] }
);

/**
 * La regla única de «aplicar a varios planes» (la usan esta ruta y WhatsApp ›
 * Precios): UN solo UPDATE acotado a la escuela; un campo `undefined` no se toca.
 * Devuelve cuántos planes quedaron actualizados. Lanza si la base falla.
 */
export async function aplicarPagosUnicosAPlanes(
    schoolId: string,
    planIds: string[],
    fees: { registration_fee?: number | null; insurance_fee?: number | null },
): Promise<number> {
    // 0 y NULL significan lo mismo para emit_enrollment_fees (COALESCE(x,0) > 0);
    // se guarda NULL para que «vacío = no se cobra» se lea igual en la base.
    const patch: Record<string, number | null> = {};
    if (fees.registration_fee !== undefined) patch.registration_fee = fees.registration_fee || null;
    if (fees.insurance_fee !== undefined) patch.insurance_fee = fees.insurance_fee || null;

    const { data, error } = await supabase
        .from('offering_plans')
        .update(patch)
        .in('id', [...new Set(planIds)])
        .eq('school_id', schoolId)
        .select('id');

    if (error) throw error;
    return (data ?? []).length;
}

router.post('/one-time-fees/apply',
    requireAuth,
    requireRole('owner', 'admin', 'school_admin'),
    async (req: Request, res: Response) => {
        try {
            const parsed = ApplyOneTimeFeesSchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
            }
            const { schoolId } = req;
            const { plan_ids, registration_fee, insurance_fee } = parsed.data;
            const updated = await aplicarPagosUnicosAPlanes(schoolId as string, plan_ids, { registration_fee, insurance_fee });
            res.json({ updated });
        } catch (err) {
            (req as any).log?.error({ err }, 'Error applying one-time fees');
            res.status(500).json({ error: 'Error al aplicar inscripción y seguro' });
        }
    }
);

// ── DELETE /api/v1/offerings/:offeringId/plans/:planId ───────────────

router.delete('/:offeringId/plans/:planId',
    requireAuth,
    requireRole('owner', 'admin', 'school_admin'),
    async (req: Request, res: Response) => {
        try {
            const { schoolId } = req;
            const { planId } = req.params;

            // Verificar si hay enrollments activos para este plan
            const { count } = await supabase
                .from('enrollments')
                .select('id', { count: 'exact', head: true })
                .eq('offering_plan_id', planId)
                .eq('status', 'active');

            if (count && count > 0) {
                return res.status(409).json({
                    error: 'No se puede eliminar un plan con inscripciones activas',
                    code: 'PLAN_HAS_ACTIVE_ENROLLMENTS'
                });
            }

            const { error } = await supabase
                .from('offering_plans')
                .delete()
                .eq('id', planId)
                .eq('school_id', schoolId);

            if (error) throw error;
            res.json({ success: true });
        } catch (err) {
            (req as any).log?.error({ err }, 'Error deleting plan');
            res.status(500).json({ error: 'Error al eliminar plan' });
        }
    }
);

// ── COACHES PER OFFERING ─────────────────────────────────────────────────────

// GET /api/v1/offerings/:offeringId/coaches
// Devuelve los coaches asignados al plan + los disponibles de la escuela
router.get(
  '/:offeringId/coaches',
  requireAuth,
  requireRole('owner', 'super_admin', 'admin', 'school_admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { offeringId } = req.params;
      const { schoolId } = req;

      // Coaches ya asignados al offering
      const { data: assigned, error: assignedErr } = await supabase
        .from('offering_coaches')
        .select('id, coach_id, school_staff!inner(id, full_name)')
        .eq('offering_id', offeringId);
      if (assignedErr) throw assignedErr;

      // Todos los coaches activos de la escuela
      const { data: all, error: allErr } = await supabase
        .from('school_staff')
        .select('id, full_name')
        .eq('school_id', schoolId)
        .eq('status', 'active')
        .order('full_name');
      if (allErr) throw allErr;

      const assignedIds = new Set((assigned || []).map((a: any) => a.coach_id));

      return res.json({
        assigned: (assigned || []).map((a: any) => ({
          id:        a.id,           // offering_coaches.id (para el DELETE)
          coach_id:  a.coach_id,
          full_name: (a.school_staff as any).full_name,
        })),
        available: (all || []).filter((s: any) => !assignedIds.has(s.id)),
      });
    } catch (err: any) {
      req.log?.error({ err }, 'offerings unhandled error');
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
);

// POST /api/v1/offerings/:offeringId/coaches
router.post(
  '/:offeringId/coaches',
  requireAuth,
  requireRole('owner', 'super_admin', 'admin', 'school_admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { offeringId } = req.params;
      const { schoolId } = req;
      const { coachId } = req.body as { coachId: string };

      if (!coachId) return res.status(400).json({ error: 'coachId requerido' });

      const { data, error } = await supabase
        .from('offering_coaches')
        .insert({ offering_id: offeringId, coach_id: coachId, school_id: schoolId })
        .select()
        .single();
      if (error) throw error;

      return res.status(201).json(data);
    } catch (err: any) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'El entrenador ya está asignado a este plan.' });
      }
      req.log?.error({ err }, 'offerings unhandled error');
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
);

// DELETE /api/v1/offerings/:offeringId/coaches/:assignmentId
router.delete(
  '/:offeringId/coaches/:assignmentId',
  requireAuth,
  requireRole('owner', 'super_admin', 'admin', 'school_admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { assignmentId } = req.params;
      const { error } = await supabase
        .from('offering_coaches')
        .delete()
        .eq('id', assignmentId);
      if (error) throw error;
      return res.status(204).send();
    } catch (err: any) {
      req.log?.error({ err }, 'offerings unhandled error');
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
);

export default router;
