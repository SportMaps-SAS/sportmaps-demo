import { supabase } from '../config/supabase';
import { addDaysToDateString, todayInZone } from '../utils/businessDate';

/**
 * Reglas compartidas de inscripción + cobro.
 *
 * Antes vivían duplicadas dentro de PUT /students/:id (closures del handler), así
 * que POST /enrollments asignaba planes SIN generar cobro y con otro criterio de
 * vencimiento. Resultado visible: el admin asignaba un plan desde el modal de
 * planes, la vista lo mostraba y no existía mensualidad. Una sola fuente.
 */

export type AthleteType = 'child' | 'adult' | 'unregistered';

/**
 * Categorías de cobro ÚNICO (no son la mensualidad de un período aunque el
 * trigger trg_payments_fill_period les estampe period_year/period_month).
 * Un cambio o baja de plan NO las anula ni las re-precia: la inscripción y el
 * seguro ya se cobraron por el alta, el excedente por horas consumidas.
 * Misma lista que fn_extend_enrollment_on_payment_paid y open_month
 * (migración 20261005214245).
 */
export const ONE_OFF_PAYMENT_CATEGORIES = ['inscripcion', 'seguro', 'excedente'] as const;

/** Filtro PostgREST (`.or(...)`) que deja solo cobros de mensualidad / sin categoría. */
export const PLAN_PERIOD_CHARGE_FILTER =
    `payment_category.is.null,payment_category.not.in.(${ONE_OFF_PAYMENT_CATEGORIES.join(',')})`;
export type AthleteCol = 'child_id' | 'user_id' | 'unregistered_athlete_id';

export const athleteColFor = (t: AthleteType): AthleteCol =>
    t === 'child' ? 'child_id' : t === 'adult' ? 'user_id' : 'unregistered_athlete_id';

/**
 * Corte y días de gracia de la escuela: la MISMA fuente que usa open_month() y
 * que el helper SQL `qr_first_charge_due_date` del flujo por QR.
 */
export async function getBillingConfig(schoolId: string): Promise<{ cutoff: number; grace: number }> {
    const { data } = await supabase
        .from('school_settings')
        .select('payment_cutoff_day, payment_grace_days')
        .eq('school_id', schoolId)
        .maybeSingle();
    return {
        cutoff: Number((data as any)?.payment_cutoff_day) || 10,
        // 0 explícito es válido: solo se cae al default cuando no hay fila/valor.
        grace: Number((data as any)?.payment_grace_days ?? 5),
    };
}


/**
 * Vencimiento canónico del cobro: día de corte de la escuela DENTRO DEL MES DE
 * ENTRADA, acotado al último día de ese mes y nunca antes del día del alta.
 *
 * Antes cada rama inventaba su propia fecha (start_date + 1 mes para equipo,
 * plan_start + 30 días para plan): cobros del MISMO mes con vencimientos
 * distintos y cada edición corriéndole la fecha al alumno.
 *
 * EL PERIODO ES EL MES DE ENTRADA. Antes esta función devolvía `mes + 1` a
 * propósito ("el alta no cobra el mes en curso") y eso resultó ser el error:
 * quien se inscribía y pagaba en agosto quedaba con un cobro de SEPTIEMBRE, su
 * agosto no se facturaba nunca y salía "al día" sin tener cobro. Medido en
 * Dynasty el 2026-08-04: 12 atletas y $1.730.000 aparcados en septiembre. El
 * desfase tampoco se autocorregía — `next_unpaid_period` seguía avanzando.
 *
 * `due_date` NO define el mes cubierto: el periodo se devuelve aparte y los
 * callers lo persisten, sin depender de `trg_payments_fill_period`.
 *
 * UN COBRO NUEVO NUNCA NACE VENCIDO. Acotar al día del alta no alcanzaba: solo
 * protege dentro del mes de entrada. Si el plan se asigna un mes DESPUÉS del
 * alta, el vencimiento calculado ya pasó y el cobro entra al mundo en mora, con
 * recargo y recordatorio de deuda por un cobro que ayer no existía. Medido en
 * Dynasty el 2026-08-12: 5 cobros nacidos con 9 a 31 días de atraso — Salomé
 * Montenegro nació con 27 (alta 6-jul, corte 10, cobro emitido el 6-ago).
 *
 * La deuda puede ser legítima (cursó el mes), así que el PERIODO no se toca:
 * sigue siendo el mes de entrada. Lo que se corrige es la fecha de pago: como
 * muy tarde pasa a ser hoy + los días de gracia de la escuela, la MISMA regla
 * que ya aplica el flujo por QR (`qr_first_charge_due_date` usa
 * `GREATEST(corte, hoy + payment_grace_days)`). Antes había dos criterios
 * distintos para la misma situación según la vía de alta.
 *
 * Esto NO aplica al registro manual de pagos viejos: esa vía escribe en
 * `payments` directamente y debe poder fechar hacia atrás a propósito.
 */
export async function billingDue(schoolId: string, startDate: string): Promise<{
    due_date: string;
    period_year: number;
    period_month: number;
}> {
    const { cutoff, grace } = await getBillingConfig(schoolId);
    const [y, m, d] = startDate.split('-').map(Number);
    // Día 0 del mes siguiente = último día del mes de entrada.
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    // Nunca antes del día del alta: con alta el 20 y corte 10, un vencimiento el
    // 10 nace en mora y el motor de recargos le cobra un atraso que no existió.
    const day = Math.max(Math.min(cutoff, lastDay), d);
    const pad = (n: number) => String(n).padStart(2, '0');
    const calculado = `${y}-${pad(m)}-${pad(day)}`;
    // Solo se reemplaza si la fecha calculada YA PASÓ. Aplicar el piso siempre
    // correría también los vencimientos que ya eran correctos (un alta el 20 con
    // corte 10 vencía el 20 y pasaría al 25), y esto no viene a mover lo que
    // funciona: viene a que nada nazca vencido.
    //
    // Comparación lexicográfica: ambas son 'YYYY-MM-DD' en la zona del negocio,
    // no UTC (un alta de las 19:00 en Bogotá ya es del día siguiente en UTC, y
    // por ahí se colaba un corrimiento de un día).
    const hoy = todayInZone();
    return {
        due_date: calculado < hoy ? addDaysToDateString(hoy, grace) : calculado,
        period_year: y,
        period_month: m,
    };
}

/**
 * Concepto del cobro de un plan. Muchos planes ya se llaman «Plan …» (p. ej. «Plan Mayores mixto»):
 * anteponer «Plan » otra vez dejaba «Plan Plan Mayores mixto» en todas las pantallas.
 */
export function conceptoDePlan(planName?: string | null): string {
    const n = (planName ?? '').trim() || 'Plan';
    return /^plan\b/i.test(n) ? n : `Plan ${n}`;
}

/**
 * Sede del cobro de plan. Sin `branch_id` el cobro sale «Sin sede» y solo se ve en «Todas las sedes»
 * (caso María Paula, Monster's, nov-2026). Sale del equipo del atleta: el que llegó en `teamId` o el de su
 * inscripción activa. Es de mejor esfuerzo: si no se puede deducir, el cobro nace como antes (sin sede).
 */
async function sedeDelCobro(opts: {
    schoolId: string;
    athleteCol: AthleteCol;
    athleteId: string;
    teamId?: string | null;
}): Promise<string | null> {
    try {
        let teamId = opts.teamId ?? null;
        if (!teamId) {
            const { data: enr } = await supabase
                .from('enrollments')
                .select('team_id')
                .eq('school_id', opts.schoolId)
                .eq(opts.athleteCol, opts.athleteId)
                .eq('status', 'active')
                .not('team_id', 'is', null)
                .limit(1)
                .maybeSingle();
            teamId = (enr as any)?.team_id ?? null;
        }
        if (!teamId) return null;
        const { data: team } = await supabase.from('teams').select('branch_id').eq('id', teamId).maybeSingle();
        return (team as any)?.branch_id ?? null;
    } catch {
        return null;
    }
}

export async function createPendingPayment(opts: {
    schoolId: string;
    athleteCol: AthleteCol;
    athleteId: string;
    teamId?: string | null;
    planId?: string | null;
    amount: number;
    concept: string;
    startDate: string;
    /**
     * true = cobro ADICIONAL dentro de un período que ya tiene cobro (parcial o
     * completo de un cambio de plan con pago previo — ver planChange.service.ts).
     * Sin esto el índice uniq_payment_active_period_per_* lo rechaza (23505) y
     * abajo se absorbe en silencio, o sea, el cobro no se emitía.
     */
    periodUniquenessExempt?: boolean;
}): Promise<boolean> {
    // El constraint payments_amount_positive exige amount > 0: si no hay cuota
    // configurada no se genera cobro (evita INSERT fallido silencioso).
    // Devuelve false cuando NO se creó cobro nuevo (monto 0 o ya existía uno del
    // período): el caller puede avisarle al admin en vez de callar.
    if (!opts.amount || opts.amount <= 0) return false;

    const due = await billingDue(opts.schoolId, opts.startDate);
    const row: any = {
        school_id: opts.schoolId,
        amount: opts.amount,
        concept: opts.concept,
        // Vencimiento + período poblados: sin period_year/period_month los
        // índices uniq_payment_active_period_* son parciales y no aplican, así
        // que el cobro se escapaba del dedup y duplicaba el mes.
        due_date: due.due_date,
        period_year: due.period_year,
        period_month: due.period_month,
        status: 'pending',
        // payment_type solo admite 'one_time' | 'subscription' (constraint
        // payments_payment_type_check). 'monthly' rompía el INSERT.
        payment_type: 'one_time',
        // Todo caller de este helper (emitPlanCharge, POST /enrollments,
        // students.ts al cambiar equipo/plan) arma un cobro de mensualidad —
        // la inscripción/matrícula la cobra chargeRegistrationFeeIfApplicable
        // aparte (students-create-one.route.ts), no este helper.
        payment_category: 'mensualidad',
    };
    if (opts.periodUniquenessExempt) row.period_uniqueness_exempt = true;
    if (opts.teamId) row.team_id = opts.teamId;
    if (opts.planId) row.offering_plan_id = opts.planId;
    row[opts.athleteCol] = opts.athleteId;
    const sede = await sedeDelCobro(opts);
    if (sede) row.branch_id = sede;

    // QUIÉN PAGA. Sin esto el cobro nace sin pagador y el guard anti-IDOR de
    // create-session (payments.routes.ts) lo vuelve IMPAGABLE online: responde 403
    // "No tienes permiso para pagar este registro" al propio acudiente, porque compara
    // el caller contra [parent_id, user_id] y ambos están en NULL.
    //
    // Solo afectaba a menores: para un adulto, athleteCol ES 'user_id' y el pagador
    // queda seteado de paso. Para 'child_id' hay que resolver el acudiente del menor.
    if (opts.athleteCol === 'child_id') {
        const { data: child } = await supabase
            .from('children')
            .select('parent_id')
            .eq('id', opts.athleteId)
            .maybeSingle();
        const parentId = (child as any)?.parent_id;
        if (parentId) {
            row.parent_id = parentId;
        } else {
            // Menor sin acudiente vinculado: se registra, porque el cobro nacerá
            // impagable online y alguien tiene que enterarse.
            console.warn(
                `[enrollmentBilling] child ${opts.athleteId} sin parent_id: el cobro `
                + 'quedará sin pagador y no se podrá pagar online.',
            );
        }
    }

    const { error } = await supabase.from('payments').insert(row);
    if (error) {
        // 23505: ya existe un cobro activo para este atleta+período
        // (uniq_payment_active_period_*). NO es un error: el cobro ya está
        // creado, así que la operación continúa sin duplicar ni abortar.
        if ((error as any).code === '23505') return false;
        throw new Error(`Error creando cobro pendiente: ${error.message}`);
    }
    return true;
}

/**
 * Emite la mensualidad de un plan recién asignado (lee nombre y precio del
 * catálogo). Idempotente por período gracias al 23505 que absorbe
 * createPendingPayment.
 */
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export async function emitPlanCharge(
    schoolId: string,
    athleteCol: AthleteCol,
    athleteId: string,
    planId: string,
    startDate: string,
): Promise<void> {
    const { data: plan } = await supabase
        .from('offering_plans')
        .select('name, price')
        .eq('id', planId)
        .maybeSingle();

    // Sin el mes en el texto, dos cobros del mismo atleta y plan (uno de agosto sin
    // pagar, otro de septiembre recién generado) se ven idénticos en cualquier
    // pantalla que muestre `concept` crudo (cartera de FinancesPage, WhatsApp
    // manual) — MyPaymentsPage no lo sufre porque ya arma su propio label desde
    // period_year/period_month, pero el resto de la app lee `concept` tal cual.
    const [y, m] = startDate.split('-').map(Number);
    const periodo = y && m ? `${MESES[m - 1]}/${y}` : null;
    const planName = (plan as any)?.name || 'Plan';

    await createPendingPayment({
        schoolId,
        athleteCol,
        athleteId,
        planId,
        amount: Number((plan as any)?.price ?? 0),
        concept: periodo ? `${conceptoDePlan(planName)} - ${periodo}` : conceptoDePlan(planName),
        startDate,
    });
}

/**
 * Qué hacer con los cobros al guardar el PLAN de una inscripción desde el editor
 * de atletas (PUT /students/:id).
 *
 *   - 'cambio': el plan es otro que el que había —incluido pasar de NINGUNO a
 *     uno, el caso de las 125 inscripciones solo-de-equipo de Monster—. Se anulan
 *     los pendientes del plan anterior (si había) y se emite la mensualidad del
 *     plan nuevo.
 *   - 'sin_cobro': mismo plan con cuota 0 → se anulan los pendientes.
 *   - 'mismo_plan': mismo plan → solo se actualiza el monto de los pendientes.
 *
 * Antes la condición era `oldPlanId && oldPlanId !== nuevo`: con oldPlanId NULL
 * (inscripción de solo equipo) caía en 'mismo_plan' y el plan quedaba asignado
 * SIN cobro (H-08 de docs/qa/monster-prelanzamiento-2026-10-05.md).
 */
export function accionCobroDePlan(
    oldPlanId: string | null,
    newPlanId: string | null,
    planFee: number | null,
): 'cambio' | 'sin_cobro' | 'mismo_plan' {
    if ((oldPlanId || null) !== (newPlanId || null)) return 'cambio';
    if (planFee !== null && planFee <= 0) return 'sin_cobro';
    return 'mismo_plan';
}

/**
 * Vencimiento de los cobros únicos del alta (inscripción / seguro): el día del
 * alta, o hoy si el alta se registró con fecha pasada — un cobro nuevo nunca
 * nace vencido (misma regla que billingDue). NUNCA el 1 del mes siguiente: el
 * trigger trg_payments_fill_period estamparía ese período.
 */
export function enrollmentFeeDueDate(startDate: string, today: string = todayInZone()): string {
    return startDate > today ? startDate : today;
}

/**
 * Exoneración por alta (2026-10-10): la escuela decide NO cobrar la inscripción
 * y/o el seguro de UN alta concreta. La mensualidad no se toca.
 */
export interface EnrollmentFeeWaivers {
    registration?: boolean;
    insurance?: boolean;
}

/** Categorías de payments que la exoneración deja sin cobrar. */
export function waivedFeeCategories(w?: EnrollmentFeeWaivers | null): ('inscripcion' | 'seguro')[] {
    const out: ('inscripcion' | 'seguro')[] = [];
    if (w?.registration) out.push('inscripcion');
    if (w?.insurance) out.push('seguro');
    return out;
}

/**
 * Red de seguridad mientras la migración 20261010124934 (parámetros
 * p_waive_* de emit_enrollment_fees) no esté aplicada: la RPC vieja ignora la
 * exoneración e inserta igual la fila. Se anula aquí lo que haya salido de una
 * categoría exonerada. Con la migración viva no encuentra nada (0 filas).
 * Devuelve los ids que quedan vigentes.
 */
export async function cancelWaivedFeeRows(opts: {
    schoolId: string;
    paymentIds: string[];
    waivers?: EnrollmentFeeWaivers | null;
    log?: { error: (...a: any[]) => void };
}): Promise<string[]> {
    const cats = waivedFeeCategories(opts.waivers);
    if (!cats.length || !opts.paymentIds.length) return opts.paymentIds;
    const { data, error } = await supabase
        .from('payments')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('school_id', opts.schoolId)
        .in('id', opts.paymentIds)
        .in('payment_category', cats)
        .eq('status', 'pending')
        .select('id');
    if (error) {
        opts.log?.error({ err: error }, 'No se pudo anular el cobro exonerado del alta');
        return opts.paymentIds;
    }
    const cancelled = new Set(((data as { id: string }[] | null) ?? []).map(r => r.id));
    return opts.paymentIds.filter(id => !cancelled.has(id));
}

/**
 * Rastro de la exoneración en audit_logs (quién, a qué inscripción, qué
 * concepto). Nunca rompe el alta: un error solo se registra.
 */
export async function auditEnrollmentFeeWaiver(opts: {
    schoolId: string;
    profileId: string | null | undefined;
    enrollmentId: string | null | undefined;
    planId: string | null | undefined;
    athleteCol: AthleteCol;
    athleteId: string;
    waivers?: EnrollmentFeeWaivers | null;
    log?: { error: (...a: any[]) => void };
}): Promise<void> {
    if (!waivedFeeCategories(opts.waivers).length || !opts.enrollmentId) return;
    const { error } = await supabase.from('audit_logs').insert({
        school_id: opts.schoolId,
        profile_id: opts.profileId ?? null,
        table_name: 'enrollments',
        record_id: opts.enrollmentId,
        action: 'enrollment_fees_waived',
        new_data: {
            offering_plan_id: opts.planId ?? null,
            [opts.athleteCol]: opts.athleteId,
            waive_registration_fee: !!opts.waivers?.registration,
            waive_insurance_fee: !!opts.waivers?.insurance,
        },
    });
    if (error) opts.log?.error({ err: error }, 'Error registrando la exoneración de inscripción/seguro');
}

/**
 * ¿El atleta ya tiene un seguro de los últimos 12 meses en la escuela? Mismo
 * predicado que el dedupe de emit_enrollment_fees (categoría 'seguro', no
 * anulado, due_date > dueDate − 365; el adulto sin child_id). Devuelve el
 * due_date del más reciente o null. Solo para la vista previa del alta: la
 * decisión real la toma la RPC dentro de la transacción.
 */
export async function findActiveInsurance(opts: {
    schoolId: string;
    athleteCol: AthleteCol;
    athleteId: string;
    dueDate: string;
}): Promise<string | null> {
    let q = supabase
        .from('payments')
        .select('due_date')
        .eq('school_id', opts.schoolId)
        .eq('payment_category', 'seguro')
        .neq('status', 'cancelled')
        .gt('due_date', addDaysToDateString(opts.dueDate, -365))
        .eq(opts.athleteCol, opts.athleteId);
    if (opts.athleteCol === 'user_id') q = q.is('child_id', null);
    const { data, error } = await q.order('due_date', { ascending: false }).limit(1);
    if (error || !data?.length) return null;
    return (data[0] as { due_date: string }).due_date ?? null;
}

/** PostgREST no encontró la firma pedida (RPC sin la migración nueva). */
const isMissingSignature = (error: any): boolean =>
    error?.code === 'PGRST202' || /could not find the function/i.test(String(error?.message ?? ''));

/**
 * Cobros únicos del alta — inscripción y seguro (F-B, D17-D19). Delegado a la
 * RPC emit_enrollment_fees (solo service_role): filas 'one_time' exentas de la
 * unicidad por período, con parent_id del menor, seguro con dedupe de 365 días.
 * Plan sin registration_fee / insurance_fee = 0 filas (hoy, todas las escuelas).
 *
 * `waivers`: la escuela no cobra ese concepto en esta alta. Los dos exonerados
 * = ni se llama a la RPC. Uno solo = p_waive_* (migración 20261010124934); si
 * la base aún no la tiene, se llama con la firma vieja y se anula la fila
 * exonerada (cancelWaivedFeeRows). Sin waivers, la llamada es la de siempre.
 *
 * NO se llama en cambio de plan (D18: solo un alta nueva cobra inscripción).
 * Nunca rompe el alta: un error se registra y devuelve [].
 */
export async function emitEnrollmentFees(opts: {
    schoolId: string;
    planId: string | null | undefined;
    athleteCol: AthleteCol;
    athleteId: string;
    parentId?: string | null;
    branchId?: string | null;
    dueDate: string;
    personName?: string | null;
    waivers?: EnrollmentFeeWaivers | null;
    log?: { error: (...a: any[]) => void };
}): Promise<string[]> {
    if (!opts.planId) return [];
    const waived = waivedFeeCategories(opts.waivers);
    if (waived.length === 2) return [];

    const baseArgs = {
        p_school_id: opts.schoolId,
        p_plan_id: opts.planId,
        p_child_id: opts.athleteCol === 'child_id' ? opts.athleteId : null,
        p_user_id: opts.athleteCol === 'user_id' ? opts.athleteId : null,
        p_unreg_id: opts.athleteCol === 'unregistered_athlete_id' ? opts.athleteId : null,
        p_parent_id: opts.parentId ?? null,
        p_branch_id: opts.branchId ?? null,
        p_due_date: opts.dueDate,
        p_person_name: opts.personName ?? null,
    };
    const args = waived.length
        ? {
            ...baseArgs,
            ...(opts.waivers?.registration ? { p_waive_registration: true } : {}),
            ...(opts.waivers?.insurance ? { p_waive_insurance: true } : {}),
        }
        : baseArgs;

    let { data, error } = await supabase.rpc('emit_enrollment_fees', args);
    if (error && waived.length && isMissingSignature(error)) {
        ({ data, error } = await supabase.rpc('emit_enrollment_fees', baseArgs));
    }
    if (error) {
        if (opts.log) opts.log.error({ err: error }, 'Error emitiendo cobros de inscripción/seguro');
        else console.error('[enrollmentBilling] emit_enrollment_fees', error);
        return [];
    }
    const ids = ((data as string[] | null) ?? []).filter(Boolean);
    return cancelWaivedFeeRows({ schoolId: opts.schoolId, paymentIds: ids, waivers: opts.waivers, log: opts.log });
}

/**
 * Monto de un cobro cuando la cuota cambia, RESPETANDO el descuento que ese cobro
 * ya trae (payments.discount_pct, puesto al registrar al estudiante). Sin
 * descuento, el monto es la cuota tal cual.
 */
export function amountWithDiscount(fee: number, discountPct: number | string | null | undefined): number {
    const pct = Number(discountPct) || 0;
    return pct > 0 && pct < 100 ? Math.round(fee * (1 - pct / 100)) : fee;
}

/**
 * % de descuento que un cobro ya trae: el guardado al registrar al estudiante
 * (`discount_pct`) o, si no hay, el implícito del descuento por hermanos
 * (`sibling_discount_applied` es un VALOR, no un porcentaje: se deduce de
 * descuento / (monto + descuento), el mismo cálculo que hizo open_month).
 */
export function impliedDiscountPct(row: {
    discount_pct?: number | string | null;
    sibling_discount_applied?: number | string | null;
    amount?: number | string | null;
}): number {
    const explicit = Number(row.discount_pct) || 0;
    if (explicit > 0) return explicit;
    const sib = Number(row.sibling_discount_applied) || 0;
    const amount = Number(row.amount) || 0;
    return sib > 0 && amount > 0 ? (sib / (amount + sib)) * 100 : 0;
}

/**
 * Reescribe el monto de los cobros pendientes a la cuota nueva sin perder el
 * descuento de cada uno. `rows` es la consulta ya filtrada (atleta, plan/equipo,
 * estado pendiente) que devuelve `id, discount_pct`.
 *
 * Antes la rama «mismo plan/equipo» de PUT /students/:id hacía un UPDATE masivo
 * `amount = cuota` y el descuento horneado en el monto se perdía en silencio
 * (caso Zoe Barrera, Dreamers, 2026-10-10: $232.750 → $245.000 dos minutos
 * después de registrarla, antes del pago manual).
 */
export async function repricePendingCharges(
    rows: PromiseLike<{ data: any[] | null }>,
    fee: number,
): Promise<void> {
    const { data } = await rows;
    for (const row of data ?? []) {
        const pct = impliedDiscountPct(row);
        await supabase
            .from('payments')
            .update({
                amount: amountWithDiscount(fee, pct),
                ...(Number(row.discount_pct) > 0 ? { list_amount: fee } : {}),
                updated_at: new Date().toISOString(),
            })
            .eq('id', row.id);
    }
}

/** Anula los cobros pendientes de un plan concreto (cambio o baja de plan). */
export async function cancelPendingPlanPayments(opts: {
    schoolId: string;
    athleteCol: AthleteCol;
    athleteId: string;
    planIds: string[];
}): Promise<void> {
    const planIds = opts.planIds.filter(Boolean);
    if (!planIds.length) return;
    await supabase
        .from('payments')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('school_id', opts.schoolId)
        .eq(opts.athleteCol, opts.athleteId)
        .in('offering_plan_id', planIds)
        .eq('status', 'pending')
        // Inscripción / seguro / excedente sobreviven al cambio de plan (B4).
        .or(PLAN_PERIOD_CHARGE_FILTER);
}

/**
 * Cambio de plan: anula los cobros de mensualidad del PERÍODO del cambio que siguen
 * sin plata (pendientes o vencidos, con o sin plan ligado) para que el cobro del plan
 * nuevo pueda nacer. `cancelPendingPlanPayments` solo anula `pending` del plan viejo:
 * un cobro vencido, o uno del cierre de mes sin plan ligado, sobrevivía, chocaba con
 * uniq_payment_active_period_per_child (23505) y el cobro nuevo se absorbía en
 * silencio (Dynasty, 2026-10-21: cobro de $180.000 del plan viejo, ninguno de $90.000).
 *
 * NO toca: meses anteriores (la deuda causada no cambia sola), cobros con algún pago
 * o abono (`amount_paid` > 0) ni inscripción/seguro/excedente. Devuelve cuántos
 * anuló y cuántos dejó por tener pagos, para que el caller avise.
 */
export async function cancelUnpaidPeriodCharges(opts: {
    schoolId: string;
    athleteCol: AthleteCol;
    athleteId: string;
    /** Fecha que define el período del cobro nuevo (la misma que usa billingDue). */
    startDate: string;
}): Promise<{ cancelled: number; withPayments: number }> {
    const [y, m] = opts.startDate.split('-').map(Number);
    const { data, error } = await supabase
        .from('payments')
        .select('id, amount_paid, payment_category')
        .eq('school_id', opts.schoolId)
        .eq(opts.athleteCol, opts.athleteId)
        .eq('period_year', y)
        .eq('period_month', m)
        .in('status', ['pending', 'overdue']);
    if (error) {
        console.error('[enrollmentBilling] cancelUnpaidPeriodCharges lectura falló:', error.message);
        return { cancelled: 0, withPayments: 0 };
    }
    const oneOff: readonly string[] = ONE_OFF_PAYMENT_CATEGORIES;
    const rows = (data ?? []).filter((r: any) => !oneOff.includes(r.payment_category));
    const unpaid = rows.filter((r: any) => !(Number(r.amount_paid) > 0)).map((r: any) => r.id);
    if (unpaid.length) {
        const { error: upErr } = await supabase
            .from('payments')
            .update({ status: 'cancelled', updated_at: new Date().toISOString() })
            .in('id', unpaid)
            .in('status', ['pending', 'overdue']);
        if (upErr) {
            console.error('[enrollmentBilling] cancelUnpaidPeriodCharges anulación falló:', upErr.message);
            return { cancelled: 0, withPayments: rows.length };
        }
    }
    return { cancelled: unpaid.length, withPayments: rows.length - unpaid.length };
}

/**
 * ¿El atleta está activo en la escuela? Un inactivo no puede recibir equipo ni
 * plan: el plan es lo que genera cobros, así que asignárselo lo devuelve a la
 * facturación por la puerta de atrás.
 */
export async function isAthleteActive(
    schoolId: string,
    athleteType: AthleteType,
    athleteId: string,
): Promise<boolean> {
    if (athleteType === 'adult') {
        const { data } = await supabase
            .from('school_members')
            .select('status')
            .eq('profile_id', athleteId)
            .eq('school_id', schoolId)
            .eq('role', 'athlete')
            .maybeSingle();
        return (data as any)?.status === 'active';
    }

    const table = athleteType === 'child' ? 'children' : 'unregistered_athletes';
    const { data } = await supabase
        .from(table)
        .select('is_active')
        .eq('id', athleteId)
        .maybeSingle();
    // Sin fila no se bloquea: el ownership lo resuelve quien llama.
    return data ? (data as any).is_active !== false : true;
}

export const INACTIVE_ATHLETE_ERROR =
    'El atleta está inactivo. Reactívalo antes de asignarle equipo o plan.';
