import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { todayInZone } from '../utils/businessDate';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middlewares/authMiddleware';
import {
    AthleteType,
    athleteColFor,
    createPendingPayment,
    cancelPendingPlanPayments,
    cancelUnpaidPeriodCharges,
    emitPlanCharge,
    emitEnrollmentFees,
    enrollmentFeeDueDate,
    auditEnrollmentFeeWaiver,
    isAthleteActive,
    INACTIVE_ATHLETE_ERROR,
    conceptoDePlan,
} from '../services/enrollmentBilling';
import { previewPlanChange, applyPlanChangeEffects } from '../services/planChange.service';

const router = Router();

// ── Schemas ──────────────────────────────────────────────────────────────────

const CreateEnrollmentSchema = z.object({
    user_id: z.string().uuid().optional(),
    child_id: z.string().uuid().optional(),
    unregistered_athlete_id: z.string().uuid().optional(),
    team_id: z.string().uuid().optional(),

    offering_plan_id: z.string().uuid().optional(),
    status: z.enum(['active', 'cancelled', 'pending']).default('active'),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    // true = agregar al atleta a un SEGUNDO equipo sin sacarlo del actual
    // (grupo de trabajo: arqueros, preparación física, selección). Solo vale
    // con team_id y sin plan, y solo si la escuela prendió
    // school_settings.allow_secondary_team_enrollment. Ver el bloque
    // "Equipo secundario" más abajo.
    secondary: z.boolean().optional(),
    // Cambio de plan en escuelas con banco de horas: si el atleta ya pagó el
    // período, el admin elige parcial (diferencia) o completo. Ver
    // POST /plan-change-preview. Sin valor y con pago previo = 'full'.
    plan_change_charge: z.enum(['partial', 'full']).optional(),
    // Exoneración por alta: la escuela no cobra la inscripción y/o el seguro
    // del plan en ESTA alta (la mensualidad sí). Ausente = se cobran como hoy.
    // Solo tiene efecto con plan, y el coach no puede asignar planes (403).
    waive_registration_fee: z.boolean().optional(),
    waive_insurance_fee: z.boolean().optional(),
}).refine(
    (data) => data.user_id || data.child_id || data.unregistered_athlete_id,
    { message: 'Se requiere user_id, child_id o unregistered_athlete_id', path: ['user_id'] }
).refine(
    (data) => data.team_id || data.offering_plan_id,
    { message: 'Debe proporcionar team_id u offering_plan_id' }
);

// ── POST /api/v1/enrollments/plan-change-preview ─────────────────────────────
// Vista previa (no escribe) de un cambio de plan en escuelas con banco de horas:
// lo pagado del período, horas usadas y recomendación de cobro parcial/completo.
// `applies: false` = el frontend sigue el flujo de siempre, sin diálogo.
const PlanChangePreviewSchema = z.object({
    user_id: z.string().uuid().optional(),
    child_id: z.string().uuid().optional(),
    unregistered_athlete_id: z.string().uuid().optional(),
    new_plan_id: z.string().uuid(),
}).refine(
    (d) => d.user_id || d.child_id || d.unregistered_athlete_id,
    { message: 'Se requiere user_id, child_id o unregistered_athlete_id', path: ['user_id'] }
);

router.post('/plan-change-preview', requireAuth, requireRole('owner', 'admin', 'school_admin', 'staff'), async (req: AuthenticatedRequest, res: Response) => {
    try {
        const parsed = PlanChangePreviewSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
        }
        const { schoolId } = req;
        const d = parsed.data;
        const athleteCol = d.user_id ? 'user_id' : d.child_id ? 'child_id' : 'unregistered_athlete_id';
        const athleteId = (d.user_id || d.child_id || d.unregistered_athlete_id) as string;
        const preview = await previewPlanChange({
            schoolId: schoolId!, athleteCol, athleteId, newPlanId: d.new_plan_id,
        });
        return res.json({ data: preview });
    } catch (err: any) {
        return res.status(500).json({ error: 'No se pudo calcular la vista previa del cambio de plan' });
    }
});

// ── POST /api/v1/enrollments ─────────────────────────────────────────────────
// ✅ Crear inscripción (equipo, plan o ambos)
router.post('/', requireAuth, requireRole('owner', 'admin', 'school_admin', 'coach', 'staff'), async (req: AuthenticatedRequest, res: Response) => {
    try {
        const parsed = CreateEnrollmentSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: 'Datos inválidos',
                details: parsed.error.issues
            });
        }

        const { schoolId } = req;
        const data = parsed.data;

        // ── El entrenador arma el roster, no el cobro ────────────────────────
        // `offering_plan_id` emite la mensualidad (emitPlanCharge más abajo) y,
        // si el atleta ya tenía otro plan activo, anula sus cobros pendientes
        // para emitir los del nuevo. Es la misma plata que motivó sacar al coach
        // de PUT /students/:id — solo que por otra puerta. Se le deja `team_id`
        // (el roster es su trabajo) y se le niega el plan. `staff` (secretaría)
        // sí lo maneja, igual que en el editor de atletas.
        if (req.role === 'coach' && data.offering_plan_id) {
            return res.status(403).json({
                error: 'Un entrenador no puede asignar planes de pago. Pídelo a la escuela.',
            });
        }

        // ✅ Validar que user_id o child_id o unregistered_athlete_id existe
        const studentId = data.user_id || data.child_id || data.unregistered_athlete_id;
        const studentField = data.user_id ? 'user_id' : data.child_id ? 'child_id' : 'unregistered_athlete_id';

        // El atleta tiene que ser de ESTA escuela. Antes solo se validaba que la
        // fila existiera, así que con un UUID conocido se podía inscribir al
        // atleta de otra escuela y emitirle un cobro acá (el insert estampa
        // school_id = req.schoolId). `profiles` no tiene school_id: para el
        // adulto el scope lo pone isAthleteActive() vía school_members.
        const targetTable = data.user_id ? 'profiles' : data.child_id ? 'children' : 'unregistered_athletes';
        // `monthly_fee` solo existe en `children` y es la última fuente de precio
        // de open_month, así que hace falta para saber si esta inscripción cobra.
        const studentColumns = targetTable === 'children' ? 'id, monthly_fee' : 'id';
        let studentQuery = supabase
            .from(targetTable)
            .select(studentColumns)
            .eq('id', studentId);
        if (targetTable !== 'profiles') {
            studentQuery = studentQuery.eq('school_id', schoolId);
        }
        const { data: student, error: studentError } = await studentQuery.maybeSingle();

        if (studentError || !student) {
            return res.status(404).json({
                error: 'Deportista no encontrado'
            });
        }

        // Mismo razonamiento para equipo y plan: sin esto la inscripción podía
        // quedar colgada de un team_id o un offering_plan_id de otra escuela.
        let teamRow: { id: string; price_monthly: number | null } | null = null;
        if (data.team_id) {
            const { data: team } = await supabase
                .from('teams')
                .select('id, price_monthly')
                .eq('id', data.team_id)
                .eq('school_id', schoolId)
                .maybeSingle();

            if (!team) {
                return res.status(404).json({ error: 'Equipo no encontrado en esta escuela' });
            }
            teamRow = team as any;
        }

        // ── Inscribir a un equipo con precio TAMBIÉN cobra ───────────────────
        // No al instante como el plan: open_month resuelve el monto con
        //   COALESCE(e.monthly_fee, offering_plans.price, teams.price_monthly,
        //            children.monthly_fee)
        // y toma cualquier inscripción activa con monto > 0, sin exigir plan. Así
        // que el cobro nace en la apertura del mes — diferido, y por eso pasaba
        // inadvertido. Quién puede hacerlo lo decide la ESCUELA, no el código:
        // el default del flag es `true`, o sea el comportamiento de siempre.
        if (req.role === 'coach') {
            const effectiveFee =
                Number(teamRow?.price_monthly) ||
                Number((student as any)?.monthly_fee) ||
                0;

            if (effectiveFee > 0) {
                const { data: settings } = await supabase
                    .from('school_settings')
                    .select('coach_can_enroll_paid_teams')
                    .eq('school_id', schoolId)
                    .maybeSingle();

                // Sin fila de settings se aplica el default de la columna (true):
                // negar aquí dejaría sin inscribir a escuelas que nunca abrieron
                // la configuración de pagos.
                if ((settings as any)?.coach_can_enroll_paid_teams === false) {
                    return res.status(403).json({
                        error: 'Esta escuela no permite que un entrenador inscriba en equipos con cobro. '
                             + 'Pídelo a la escuela.',
                        effective_fee: effectiveFee,
                    });
                }
            }
        }

        // El plan se valida y se lee la duración en una sola consulta: antes la
        // duración se leía después, sin filtro de escuela.
        let planDurationDays: number | null = null;
        if (data.offering_plan_id) {
            const { data: plan } = await supabase
                .from('offering_plans')
                .select('duration_days')
                .eq('id', data.offering_plan_id)
                .eq('school_id', schoolId)
                .maybeSingle();

            if (!plan) {
                return res.status(404).json({ error: 'Plan no encontrado en esta escuela' });
            }
            planDurationDays = (plan as any).duration_days ?? null;
        }

        // ── Atleta inactivo: no se inscribe ──────────────────────────────────
        // El plan es lo que genera cobros; inscribir a un inactivo lo devuelve a
        // la facturación (open_month solo mira enrollments.status, no el estado
        // del atleta). Vale para los tres tipos.
        const athleteType: AthleteType = data.user_id ? 'adult' : data.child_id ? 'child' : 'unregistered';
        if (!(await isAthleteActive(schoolId!, athleteType, studentId!))) {
            return res.status(409).json({ error: INACTIVE_ATHLETE_ERROR });
        }

        // ✅ Si es inscripción a equipo, validar que no exista ya activa
        if (data.team_id) {
            const { data: existingTeamEnroll } = await supabase
                .from('enrollments')
                .select('id')
                .eq('team_id', data.team_id)
                .eq(studentField, studentId)
                .eq('status', 'active')
                .eq('school_id', schoolId)
                .maybeSingle();

            if (existingTeamEnroll) {
                return res.status(400).json({
                    error: 'Ya está inscrito en este equipo'
                });
            }
        }

        // ✅ Si es inscripción a plan, validar que no exista ya activo
        if (data.offering_plan_id) {
            const { data: existingPlanEnroll } = await supabase
                .from('enrollments')
                .select('id')
                .eq('offering_plan_id', data.offering_plan_id)
                .eq(studentField, studentId)
                .eq('status', 'active')
                .eq('school_id', schoolId)
                .maybeSingle();

            if (existingPlanEnroll) {
                return res.status(400).json({
                    error: 'Ya está inscrito en este plan'
                });
            }
        }

        // ✅ Calcular fecha de expiración si hay plan (duración ya validada arriba)
        let expiresAt = null;
        if (planDurationDays) {
            const date = new Date();
            date.setDate(date.getDate() + planDurationDays);
            expiresAt = date.toISOString().split('T')[0];
        }

        // ✅ Anti-duplicado: el atleta lleva UNA inscripción abierta por escuela —
        //    el plan manda el cobro y el equipo es el roster. Si ya existe una fila
        //    a la que solo le falta el dato que llega (equipo sin plan, o plan sin
        //    equipo), se completa esa fila en vez de abrir una segunda.
        //
        //    OJO — 'pending' cuenta como abierta. Antes esta consulta filtraba
        //    `status='active'` y ahí se escapaba el duplicado: submit_qr_signup crea
        //    la inscripción como 'pending' cuando el QR tiene require_first_payment,
        //    así que al asignarle el plan desde la app no se encontraba candidato a
        //    merge y se insertaba una segunda fila. Medido en Dynasty el 2026-08-04:
        //    6 atletas de 418, TODOS con forma 1 active + 1 pending, ninguno con dos
        //    activas. La misma ceguera la tenían los índices únicos parciales
        //    (WHERE status='active') y la RPC de limpieza merge_split_enrollments,
        //    así que el problema no era detectable con las herramientas de entonces.
        const { data: openEnrollments, error: openError } = await supabase
            .from('enrollments')
            .select('id, team_id, offering_plan_id, monthly_fee, status')
            .eq(studentField, studentId)
            .eq('school_id', schoolId)
            .in('status', ['active', 'pending'])
            .order('created_at', { ascending: true });

        if (openError) throw openError;

        const athleteCol = athleteColFor(athleteType);
        const startDate = data.start_date || todayInZone();

        const mergeTarget = (openEnrollments || []).find((row: any) =>
            (!data.team_id || !row.team_id || row.team_id === data.team_id) &&
            (!data.offering_plan_id || !row.offering_plan_id || row.offering_plan_id === data.offering_plan_id) &&
            ((data.team_id && !row.team_id) || (data.offering_plan_id && !row.offering_plan_id))
        );

        // ── Cambio de plan ───────────────────────────────────────────────────
        // Si el atleta YA tiene un plan activo distinto, el merge de arriba no
        // aplica (esa fila no "le falta" el plan, tiene otro) y antes se
        // insertaba una SEGUNDA inscripción activa: la vista mostraba uno de los
        // dos planes al azar (LIMIT 1 sin ORDER BY) y el editor de atletas
        // quedaba roto con 23505. Ahora se reemplaza sobre la misma fila, igual
        // que hace el editor: se anula el cobro del plan viejo y se emite el del
        // nuevo. Una sola inscripción activa por atleta, siempre.
        //
        // El reemplazo se queda SOLO sobre filas activas, a propósito: anula los
        // cobros del plan viejo y emite el del nuevo, y esa contabilidad está pensada
        // para una inscripción ya activa. Sobre una 'pending' el cobro vivo es el
        // primer pago que emitió el QR, y decidir por código si se anula es plata de
        // una familia. Ese caso cae al 409 de más abajo y lo resuelve un humano desde
        // la ficha del atleta.
        const planHolders = (openEnrollments || []).filter(
            (row: any) => row.status === 'active'
                && row.offering_plan_id && row.offering_plan_id !== data.offering_plan_id,
        );
        const replaceTarget = data.offering_plan_id && data.status === 'active' && !mergeTarget && planHolders.length
            ? planHolders[0]
            : null;

        if (replaceTarget) {
            const { data: planInfo } = await supabase
                .from('offering_plans')
                .select('name, price')
                .eq('id', data.offering_plan_id!)
                .maybeSingle();

            // Las filas sobrantes (drift histórico) se cancelan ANTES de mover el
            // plan: los índices únicos son parciales WHERE status='active'.
            const extras = planHolders.slice(1).map((r: any) => r.id);
            if (extras.length) {
                await supabase
                    .from('enrollments')
                    .update({ status: 'cancelled', end_date: startDate })
                    .in('id', extras)
                    .eq('school_id', schoolId);
            }

            // Vista previa ANTES de mover el plan: lee la inscripción activa con el plan
            // viejo y lo pagado del período (escuelas con banco de horas).
            const planChangePreview = await previewPlanChange({
                schoolId: schoolId!,
                athleteCol,
                athleteId: studentId!,
                newPlanId: data.offering_plan_id!,
            });

            await cancelPendingPlanPayments({
                schoolId: schoolId!,
                athleteCol,
                athleteId: studentId!,
                planIds: planHolders.map((r: any) => r.offering_plan_id),
            });
            // También el cobro del período sin plata que no era `pending` del plan viejo
            // (vencido, o del cierre de mes sin plan ligado): si sobrevive, el cobro del
            // plan nuevo choca con el índice único del período y no nace.
            const periodCleanup = await cancelUnpaidPeriodCharges({
                schoolId: schoolId!,
                athleteCol,
                athleteId: studentId!,
                startDate,
            });

            const { data: replaced, error: replaceError } = await supabase
                .from('enrollments')
                .update({
                    offering_plan_id: data.offering_plan_id,
                    team_id: replaceTarget.team_id || data.team_id || null,
                    // La cuota del atleta pasa a ser la del plan nuevo: si se
                    // dejara el override viejo seguiría cobrando el monto anterior.
                    monthly_fee: planInfo?.price ?? null,
                    sessions_used: 0,
                    secondary_sessions_used: 0,
                    ...(expiresAt ? { expires_at: expiresAt } : {}),
                })
                .eq('id', replaceTarget.id)
                .eq('school_id', schoolId)
                .select()
                .single();

            if (replaceError) throw replaceError;

            // Banco de horas: las horas ya usadas pasan al plan nuevo y, si el atleta
            // ya pagó el período, se emite el cobro que eligió el admin (parcial o
            // completo). Sin banco de horas o sin pago previo, sigue el cobro habitual.
            const planChange = await applyPlanChangeEffects({
                schoolId: schoolId!,
                athleteCol,
                athleteId: studentId!,
                enrollmentId: replaceTarget.id,
                newPlanId: data.offering_plan_id!,
                chargeMode: data.plan_change_charge,
                preview: planChangePreview,
            });

            const planWarnings: string[] = [];
            if (periodCleanup.withPayments > 0) {
                planWarnings.push('El cobro de este mes ya tiene pagos o abonos y NO se anuló: revisa su saldo antes de cobrar el plan nuevo.');
            }
            if (!planChange.handledCharge) {
                const created = await createPendingPayment({
                    schoolId: schoolId!,
                    athleteCol,
                    athleteId: studentId!,
                    planId: data.offering_plan_id!,
                    amount: Number(planInfo?.price ?? 0),
                    concept: conceptoDePlan(planInfo?.name),
                    startDate,
                });
                if (!created && Number(planInfo?.price ?? 0) > 0) {
                    planWarnings.push('No se emitió el cobro del plan nuevo porque el atleta ya tiene un cobro activo en este período. Revísalo en Pagos.');
                }
            }

            return res.status(200).json({
                message: 'Plan reemplazado exitosamente',
                data: replaced,
                replaced: true,
                ...(planWarnings.length ? { warnings: planWarnings } : {}),
                plan_change: planChange.applies
                    ? { charge: planChange.charge, hours: planChange.hours }
                    : undefined,
            });
        }

        if (mergeTarget) {
            const { data: merged, error: mergeError } = await supabase
                .from('enrollments')
                .update({
                    team_id: mergeTarget.team_id || data.team_id || null,
                    offering_plan_id: mergeTarget.offering_plan_id || data.offering_plan_id || null,
                    ...(expiresAt ? { expires_at: expiresAt } : {})
                })
                .eq('id', mergeTarget.id)
                .select()
                .single();

            if (mergeError) throw mergeError;

            // El plan recién asignado tiene que traer su mensualidad: antes esta
            // rama dejaba al atleta con plan y sin cobro (se leía como "el plan
            // no se agregó").
            //
            // Pero NO si la fila fusionada está 'pending': ese atleta entró por QR y
            // ya tiene emitido su primer pago. Emitir acá le cobraría el mes dos
            // veces, que es peor que la fila duplicada que este fix vino a evitar.
            // La inscripción tampoco se activa (decisión de producto 2026-08-04): la
            // escuela completa el plan, la activación sigue esperando el pago, así
            // que se ignora el `status: 'active'` que trae el request por default.
            if (
                data.offering_plan_id
                && !mergeTarget.offering_plan_id
                && data.status === 'active'
                && mergeTarget.status === 'active'
            ) {
                await emitPlanCharge(schoolId!, athleteCol, studentId!, data.offering_plan_id, startDate);
            }

            return res.status(200).json({
                message: mergeTarget.status === 'pending'
                    ? 'Inscripción actualizada. Sigue pendiente de pago.'
                    : 'Inscripción actualizada exitosamente',
                data: merged,
                merged: true,
                still_pending: mergeTarget.status === 'pending',
            });
        }

        // ── Guard: una sola inscripción activa por atleta y escuela ──────────
        //
        // Llegar acá con una inscripción activa significa que no fue merge ni replace,
        // o sea que es un intento de abrir una SEGUNDA. El caso que se colaba: atleta
        // con {equipo A, plan P} y llega {team_id: B}. El merge exige que a la fila le
        // FALTE el dato que llega (y no le falta el equipo, tiene otro), el replace
        // exige `offering_plan_id` en el request, y el índice uq_enrollment_child_team
        // es por (child_id, team_id) así que un equipo distinto no colisiona. Resultado:
        // INSERT, roster inflado y —hasta la mig 20260803114540— riesgo de doble cobro.
        //
        // Se responde 409 en vez de mover el equipo en silencio: cambiar de equipo tiene
        // efectos de cobro (anular los pendientes del equipo viejo, emitir los del
        // nuevo) que el editor de atletas sí implementa y este endpoint no. Hacerlo a
        // medias acá dejaría cobros del equipo anterior vivos.
        //
        // Se devuelve el `enrollment_id` para que la UI pueda ofrecer "editar la
        // inscripción" en lugar de dejar al admin sin salida. Verificado que los dos
        // llamadores que pueden caer acá (EnrollTeamStudentModal y classes.enrollStudent)
        // muestran `error.message` en un toast.
        //
        // Cuando llegue la multi-categoría (MOD-3), este 409 se relaja: el segundo
        // team_id pasará a crear una fila en enrollment_categories.
        // Ref: docs/plan-f0-generacion-de-mes-y-cobros-duplicados.md §3.2 vía A, §5 B1.
        if (!mergeTarget && !replaceTarget && (openEnrollments?.length ?? 0) > 0) {
            // Si hay una activa, esa es la que manda el mensaje; si solo hay una
            // 'pending' (alta por QR sin pagar), se nombra como tal para que el admin
            // no crea que el atleta ya está adentro.
            const current = openEnrollments!.find((r: any) => r.status === 'active') ?? openEnrollments![0];

            // ── Equipo secundario (grupo de trabajo) ──────────────────────────
            // El atleta se queda en su categoría Y entra a un segundo equipo
            // (arqueros de todas las categorías, preparación física, selección).
            // Caso Carmel Club, 2026-09-24: "EQUIPO ARQUERO" con arqueros que ya
            // están en su categoría por edad.
            //
            // Es una SEGUNDA fila en enrollments, no enrollment_categories (esa
            // exige catálogo de categorías, "arquero" no es una categoría y hoy
            // ningún lector la mira). Los índices únicos parciales solo chocan
            // por el MISMO equipo, el editor de atletas (readActiveEnrollments)
            // solo cancela duplicados exactos, y 14 menores de 6 escuelas ya
            // viven así. Lo que SÍ se cuida es la plata: la fila nace con
            // monthly_fee = 0 y fee_is_manual = true, así open_month resuelve
            // COALESCE(e.monthly_fee, …) = 0 y nunca la cobra, aunque el equipo
            // tenga precio o children.monthly_fee esté cargado. Un equipo
            // secundario NO cobra, por definición.
            //
            // Tres condiciones, todas explícitas: el cliente lo pide
            // (`secondary: true`, el modal lo ofrece solo cuando el atleta ya
            // tiene otro equipo), la escuela lo permite (flag, default false)
            // y hay una inscripción ACTIVA con equipo de la cual colgarse. Una
            // 'pending' (QR sin pagar) no califica y cae al 409 de siempre.
            if (
                data.secondary === true &&
                data.team_id && !data.offering_plan_id &&
                current.status === 'active' && current.team_id && current.team_id !== data.team_id
            ) {
                const { data: secondarySettings } = await supabase
                    .from('school_settings')
                    .select('allow_secondary_team_enrollment')
                    .eq('school_id', schoolId)
                    .maybeSingle();

                if (!(secondarySettings as any)?.allow_secondary_team_enrollment) {
                    return res.status(403).json({
                        error: 'Esta escuela no permite que un deportista esté en dos equipos a la vez.',
                        details: 'Para moverlo de equipo, edítalo desde la ficha del atleta. Si la escuela necesita grupos transversales (arqueros, preparación física), pídelo a SportMaps.',
                        code: 'SECONDARY_TEAM_NOT_ENABLED',
                        enrollment_id: current.id,
                    });
                }

                const { data: primaryTeam } = await supabase
                    .from('teams').select('name').eq('id', current.team_id).maybeSingle();

                const { data: secondaryRow, error: secondaryError } = await supabase
                    .from('enrollments')
                    .insert({
                        [studentField]: studentId,
                        team_id: data.team_id,
                        school_id: schoolId,
                        status: 'active',
                        start_date: startDate,
                        sessions_used: 0,
                        secondary_sessions_used: 0,
                        monthly_fee: 0,
                        fee_is_manual: true,
                        fee_reason: 'Equipo secundario (grupo de trabajo): sin cobro',
                        fee_set_by: req.user?.id ?? null,
                        fee_set_at: new Date().toISOString(),
                    })
                    .select()
                    .single();

                if (secondaryError) throw secondaryError;

                return res.status(201).json({
                    message: 'Agregado al equipo secundario. Sigue en su equipo principal.',
                    data: secondaryRow,
                    secondary: true,
                    primary_enrollment_id: current.id,
                    primary_team_name: (primaryTeam as any)?.name ?? null,
                });
            }

            // ── MOD-3 F3: multi-categoría ─────────────────────────────────────
            // Si lo que llega es SOLO un team_id (sin offering_plan_id) y ese
            // equipo pertenece a una categoría DISTINTA a la de la inscripción
            // actual, no es "cambiar de equipo": es agregar una segunda
            // categoría. Se resuelve con una fila en enrollment_categories,
            // nunca con una segunda enrollments (ver docs/specs/
            // sport-categories-and-multi-category.md D3).
            //
            // Guard estricto: las dos categorías tienen que ser NOT NULL y
            // distintas. Si cualquiera de los dos equipos no adoptó el
            // catálogo (category_id NULL — el caso de las otras 364 escuelas
            // hoy), este bloque no hace nada y cae al 409 de siempre. No
            // relajar esta condición: es lo que evita que el cambio afecte a
            // escuelas que nunca tocaron categorías.
            if (data.team_id && !data.offering_plan_id && current.status === 'active' && current.team_id && current.team_id !== data.team_id) {
                const { data: teamsInfo } = await supabase
                    .from('teams')
                    .select('id, category_id')
                    .in('id', [current.team_id, data.team_id]);

                const currentTeam = (teamsInfo || []).find((t: any) => t.id === current.team_id);
                const newTeam = (teamsInfo || []).find((t: any) => t.id === data.team_id);

                if (currentTeam?.category_id && newTeam?.category_id && currentTeam.category_id !== newTeam.category_id) {
                    const { data: already } = await supabase
                        .from('enrollment_categories')
                        .select('id')
                        .eq('enrollment_id', current.id)
                        .eq('category_id', newTeam.category_id)
                        .eq('status', 'active')
                        .maybeSingle();

                    if (already) {
                        return res.status(200).json({
                            message: 'El atleta ya está en esa categoría.',
                            enrollment_id: current.id,
                            category_added: false,
                        });
                    }

                    const { data: newCategoryRow, error: catError } = await supabase
                        .from('enrollment_categories')
                        .insert({
                            enrollment_id: current.id,
                            school_id: schoolId,
                            category_id: newTeam.category_id,
                            team_id: data.team_id,
                            is_primary: false,
                            billable: true,
                            status: 'active',
                            start_date: startDate,
                        })
                        .select()
                        .single();

                    if (catError) throw catError;

                    return res.status(200).json({
                        message: 'Categoría agregada a la inscripción existente.',
                        data: newCategoryRow,
                        category_added: true,
                    });
                }
            }

            const isPending = current.status === 'pending';
            let currentTeamName: string | null = null;
            if (current.team_id) {
                const { data: t } = await supabase
                    .from('teams').select('name').eq('id', current.team_id).maybeSingle();
                currentTeamName = (t as any)?.name ?? null;
            }
            return res.status(409).json({
                error: isPending
                    ? 'El atleta ya tiene una inscripción pendiente de pago en esta escuela.'
                    : 'El atleta ya tiene una inscripción activa en esta escuela.',
                details: isPending
                    ? 'Se inscribió por QR y su primer pago está sin saldar. Complétala desde la ficha del atleta en vez de crear otra: abrir una segunda deja al atleta con dos inscripciones y rompe la renovación del plan.'
                    : currentTeamName
                        ? `Hoy está en "${currentTeamName}". Para moverlo de equipo, edítalo desde la ficha del atleta: así se anulan los cobros pendientes del equipo anterior.`
                        : 'Para cambiar su equipo o su plan, edítalo desde la ficha del atleta.',
                enrollment_id: current.id,
                code: isPending ? 'ATHLETE_ENROLLMENT_PENDING' : 'ATHLETE_ALREADY_ENROLLED',
            });
        }

        // ✅ Crear inscripción
        const { data: enrollment, error: enrollError } = await supabase
            .from('enrollments')
            .insert({
                user_id: data.user_id || null,
                child_id: data.child_id || null,
                unregistered_athlete_id: data.unregistered_athlete_id || null,
                team_id: data.team_id || null,

                offering_plan_id: data.offering_plan_id || null,
                school_id: schoolId,
                status: data.status,
                start_date: startDate,
                end_date: data.end_date || null,
                expires_at: expiresAt,
                sessions_used: 0,
                secondary_sessions_used: 0
            })
            .select()
            .single();

        if (enrollError) throw enrollError;

        // Mensualidad del plan nuevo. Solo para planes: la inscripción a equipo
        // se sigue cobrando por su propia vía (open_month / editor de atletas) y
        // emitirla aquí cambiaría el comportamiento del modal de equipos.
        if (data.offering_plan_id && data.status === 'active') {
            await emitPlanCharge(schoolId!, athleteCol, studentId!, data.offering_plan_id, startDate);
            // Inscripción + seguro del plan (F-B). Alta nueva = fila nueva de
            // enrollments → cobra; el cambio de plan (PUT) no pasa por acá (D18).
            const feeWaivers = {
                registration: data.waive_registration_fee === true,
                insurance: data.waive_insurance_fee === true,
            };
            await emitEnrollmentFees({
                schoolId: schoolId!,
                planId: data.offering_plan_id,
                athleteCol,
                athleteId: studentId!,
                dueDate: enrollmentFeeDueDate(startDate),
                waivers: feeWaivers,
                log: req.log,
            });
            await auditEnrollmentFeeWaiver({
                schoolId: schoolId!,
                profileId: req.user?.id,
                enrollmentId: (enrollment as any)?.id,
                planId: data.offering_plan_id,
                athleteCol,
                athleteId: studentId!,
                waivers: feeWaivers,
                log: req.log,
            });
        }

        res.status(201).json({
            message: 'Inscripción creada exitosamente',
            data: enrollment
        });
    } catch (err: any) {
        req.log?.error({ err }, 'Error creating enrollment');
        res.status(500).json({
            error: 'Error al crear inscripción',
            details: err.message
        });
    }
});

// ── GET /api/v1/enrollments ──────────────────────────────────────────────────
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { schoolId } = req;
        const { team_id, offering_plan_id, status } = req.query;

        let query = supabase
            .from('enrollments')
            .select(`
                id, child_id, user_id, team_id,
                status, offering_plan_id, sessions_used,
                secondary_sessions_used, expires_at, start_date, created_at
            `)
            .eq('school_id', schoolId);

        if (team_id) {
            query = query.eq('team_id', team_id as string);
        }
        if (offering_plan_id) {
            query = query.eq('offering_plan_id', offering_plan_id as string);
        }
        if (status) {
            query = query.eq('status', status as string);
        }

        const { data, error } = await query.order('created_at', { ascending: false });
        if (error) throw error;

        res.json({ enrollments: data });
    } catch (err: any) {
        req.log?.error({ err }, 'Error listing enrollments');
        res.status(500).json({ error: 'Error al listar inscripciones' });
    }
});

// ── GET /api/v1/enrollments/my-plan ─────────────────────────────────────────
router.get('/my-plan', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const userId = req.user.id;
        const { child_id } = req.query;
        const { schoolId } = req;

        let query = supabase
            .from('enrollments')
            .select(`
                id, status, sessions_used, secondary_sessions_used,
                expires_at, start_date, team_id, offering_plan_id, school_id, monthly_fee
            `)
            .eq('status', 'active');

        if (child_id && typeof child_id === 'string') {
            // IDOR: este endpoint corre con service role (bypassa RLS), así que sin
            // este chequeo cualquier autenticado podía pasar el child_id de OTRO y
            // recibir su mensualidad/plan completos. Solo el padre del menor, o
            // staff/admin de la MISMA escuela del menor, puede consultarlo.
            const { data: child } = await supabase
                .from('children')
                .select('id, parent_id, school_id')
                .eq('id', child_id)
                .maybeSingle();

            if (!child) {
                return res.status(404).json({ error: 'Atleta no encontrado.' });
            }

            const isParent = child.parent_id === userId;
            const staffRoles = ['owner', 'admin', 'super_admin', 'school_admin', 'coach', 'staff', 'school'];
            const isStaffOfSchool = !!schoolId && schoolId === child.school_id && staffRoles.includes(req.role || '');

            if (!isParent && !isStaffOfSchool) {
                return res.status(403).json({ error: 'No autorizado para consultar el plan de este atleta.' });
            }

            query = query.eq('child_id', child_id);
        } else {
            query = query.eq('user_id', userId);
        }

        const { data: enrollments, error } = await query;
        if (error) throw error;

        const planIds = [...new Set((enrollments || []).map((e: any) => e.offering_plan_id).filter(Boolean))];
        const teamIds = [...new Set((enrollments || []).map((e: any) => e.team_id).filter(Boolean))];

        const schoolIds = [...new Set((enrollments || []).map((e: any) => e.school_id).filter(Boolean))];

        const [plansRes, teamsRes, schoolsRes] = await Promise.all([
            planIds.length
                ? supabase
                    .from('offering_plans')
                    .select('id, name, max_sessions, max_secondary_sessions, duration_days, price, offering_id, metadata, offering:offerings(id, name, offering_type, sport)')
                    .in('id', planIds)
                : Promise.resolve({ data: [], error: null }),
            teamIds.length
                ? supabase
                    .from('teams')
                    .select('id, name, sport, price_monthly')
                    .in('id', teamIds)
                : Promise.resolve({ data: [], error: null }),
            schoolIds.length
                ? supabase
                    .from('schools')
                    .select('id, name, city, school_type')
                    .in('id', schoolIds)
                : Promise.resolve({ data: [], error: null }),
        ]);

        const planMap = Object.fromEntries((plansRes.data || []).map((p: any) => [p.id, p]));
        const teamMap = Object.fromEntries((teamsRes.data || []).map((t: any) => [t.id, t]));
        const schoolMap = Object.fromEntries((schoolsRes.data || []).map((s: any) => [s.id, s]));

        const enriched = (enrollments || []).map((enrollment: any) => {
            const offeringPlan = enrollment.offering_plan_id ? planMap[enrollment.offering_plan_id] : null;
            const team = enrollment.team_id ? teamMap[enrollment.team_id] : null;

            const maxSessions = offeringPlan?.max_sessions ?? null;
            const used = enrollment.sessions_used || 0;
            const expiresAt = enrollment.expires_at;
            const now = new Date();

            let planStatus = 'active';
            let daysLeft: number | null = null;
            let percentUsed: number | null = null;

            if (!offeringPlan) {
                planStatus = 'no_plan';
            } else if (expiresAt && new Date(expiresAt) < now) {
                planStatus = 'expired';
            } else if (maxSessions !== null && used >= maxSessions) {
                planStatus = 'exhausted';
            } else {
                if (expiresAt) {
                    daysLeft = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / 86400000));
                    if (daysLeft <= 5) planStatus = 'expiring_soon';
                }
                if (maxSessions !== null) {
                    percentUsed = Math.round((used / maxSessions) * 100);
                    if (percentUsed > 85 && planStatus === 'active') planStatus = 'expiring_soon';
                }
            }

            return {
                ...enrollment,
                offering_plan: offeringPlan,
                offering: offeringPlan?.offering ?? null,
                team,
                school: enrollment.school_id ? schoolMap[enrollment.school_id] : null,
                offering_id: (offeringPlan?.offering as any)?.id ?? null,
                // Precio unificado: la cuota individual del atleta (enrollments.monthly_fee,
                // editable por la escuela) manda sobre el precio de catálogo del plan/equipo.
                price_monthly: enrollment.monthly_fee ?? offeringPlan?.price ?? team?.price_monthly ?? null,
                currency: offeringPlan?.currency ?? 'COP',
                computed: {
                    plan_status: planStatus,
                    percent_used: percentUsed,
                    days_left: daysLeft,
                    sessions_remaining: maxSessions !== null ? Math.max(0, maxSessions - used) : null,
                },
            };
        });

        res.json({ enrollments: enriched });
    } catch (err: any) {
        req.log?.error({ err }, 'Error fetching my plan');
        res.status(500).json({ error: 'Error al consultar plan' });
    }
});

// ── POST /api/v1/enrollments/assign-plan (Legacy/Team-based) ────────────────
router.post('/assign-plan', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { enrollment_id, offering_plan_id } = req.body;
        const { schoolId } = req;

        const { data: plan } = await supabase
            .from('offering_plans')
            .select('duration_days')
            .eq('id', offering_plan_id)
            .eq('school_id', schoolId)
            .single();

        if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + plan.duration_days);

        const { data, error } = await supabase
            .from('enrollments')
            .update({
                offering_plan_id,
                sessions_used: 0,
                secondary_sessions_used: 0,
                expires_at: expiresAt.toISOString().split('T')[0],
                status: 'active'
            })
            .eq('id', enrollment_id)
            .eq('school_id', schoolId)
            .select()
            .single();

        if (error) throw error;
        res.json({ enrollment: data });
    } catch (err: any) {
        req.log?.error({ err }, 'Error assigning plan');
        res.status(500).json({ error: 'Error al asignar plan' });
    }
});

// ── PATCH /api/v1/enrollments/:id ────────────────────────────────────────────
router.patch('/:id', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { schoolId } = req;
        const { status, end_date, offering_plan_id, scheduling_team_id } = req.body;

        const updateData: any = {};
        if (status) updateData.status = status;
        if (end_date) updateData.end_date = end_date;
        if (offering_plan_id) updateData.offering_plan_id = offering_plan_id;

        // scheduling_team_id: piloto "agendar por equipo" (Dreamers / Academia
        // Superior Bogotá) — a diferencia de los campos de arriba, sí acepta
        // null explícito para poder QUITAR la asignación, no solo ponerla.
        if (scheduling_team_id !== undefined) {
            if (scheduling_team_id !== null) {
                const { data: team } = await supabase
                    .from('teams')
                    .select('id')
                    .eq('id', scheduling_team_id)
                    .eq('school_id', schoolId)
                    .maybeSingle();
                if (!team) {
                    return res.status(400).json({ error: 'El equipo no pertenece a esta escuela.' });
                }
            }
            updateData.scheduling_team_id = scheduling_team_id;
        }

        const { data, error } = await supabase
            .from('enrollments')
            .update(updateData)
            .eq('id', id)
            .eq('school_id', schoolId)
            .select()
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Inscripción no encontrada' });

        res.json({ message: 'Inscripción actualizada', data });
    } catch (err: any) {
        req.log?.error({ err }, 'Error updating enrollment');
        res.status(500).json({ error: 'Error al actualizar inscripción' });
    }
});

// ── DELETE /api/v1/enrollments/:id ───────────────────────────────────────────
router.delete('/:id', requireAuth, requireRole('owner', 'admin', 'school_admin', 'coach'), async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { schoolId } = req;

        // Cancelar anula los cobros pendientes del atleta: el coach solo puede si
        // la ESCUELA lo habilitó (school_settings.coach_can_remove_enrollments,
        // default false) y solo en equipos que él entrena. Las inscripciones de
        // plan (sin equipo) siguen siendo de administración.
        if (req.role === 'coach') {
            const { data: cfg } = await supabase
                .from('school_settings')
                .select('coach_can_remove_enrollments')
                .eq('school_id', schoolId)
                .maybeSingle();
            if ((cfg as any)?.coach_can_remove_enrollments !== true) {
                return res.status(403).json({ error: 'La escuela no permite que el entrenador remueva deportistas.' });
            }

            const { data: enr } = await supabase
                .from('enrollments')
                .select('team_id')
                .eq('id', id)
                .eq('school_id', schoolId)
                .maybeSingle();
            if (!enr) return res.status(404).json({ error: 'Inscripción no encontrada' });
            if (!enr.team_id) {
                return res.status(403).json({ error: 'El entrenador solo puede remover deportistas de sus equipos.' });
            }

            const { data: staff } = await supabase
                .from('school_staff')
                .select('id')
                .eq('coach_auth_id', req.user?.id)
                .eq('school_id', schoolId)
                .maybeSingle();
            let esSuyo = false;
            if (staff?.id) {
                const { data: team } = await supabase
                    .from('teams')
                    .select('coach_id')
                    .eq('id', enr.team_id)
                    .eq('school_id', schoolId)
                    .maybeSingle();
                esSuyo = team?.coach_id === staff.id;
                if (!esSuyo) {
                    const { data: tc } = await supabase
                        .from('team_coaches')
                        .select('id')
                        .eq('team_id', enr.team_id)
                        .eq('coach_id', staff.id)
                        .maybeSingle();
                    esSuyo = !!tc;
                }
            }
            if (!esSuyo) {
                return res.status(403).json({ error: 'El entrenador solo puede remover deportistas de sus equipos.' });
            }
        }

        const { data, error } = await supabase
            .from('enrollments')
            .update({ status: 'cancelled' })
            .eq('id', id)
            .eq('school_id', schoolId)
            .select()
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Inscripción no encontrada' });

        res.json({ message: 'Inscripción desactivada', data });
    } catch (err: any) {
        req.log?.error({ err }, 'Error deleting enrollment');
        res.status(500).json({ error: 'Error al eliminar inscripción' });
    }
});

export default router;
