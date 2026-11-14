/**
 * POST /api/v1/students/create-one
 *
 * Tres tipos:
 *
 *   "child"          → Menor: INSERT children (child_id) + enrollment(s) + pago + invitación acudiente
 *   "adult_existing" → Adulto ya en profiles: INSERT school_members (si no existe) + enrollment (user_id) + pago
 *   "adult_invite"   → Adulto sin cuenta: solo INSERT invitations (no enrollment posible sin auth)
 *
 * Reglas de enrollments:
 *   - team_id       → INSERT enrollment separado  (enrollments.team_id, sin offering_*)
 *   - offering_plan_id + offering_id → INSERT enrollment separado (sin team_id)
 *   - Ambos         → dos enrollments independientes
 *   - Ninguno       → no se crea enrollment (solo el registro del atleta)
 *
 * Columnas usadas en enrollments:
 *   child_id | user_id  → quién es el atleta (solo uno aplica según tipo)
 *   team_id             → equipo (solo cuando type=team)
 *   offering_plan_id    → plan específico (offering_plans.id)
 *   offering_id         → offering padre  (offerings.id)
 *   school_id, status, start_date → siempre
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import {
  prepareZkPinForSignup, assignZkPin, ZkPinError, type ZkSubject,
} from '../services/zkPinAssignment';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { calcFirstPayment, BillingCycleType } from '../utils/prorationUtils';
import {
  calcRemainingClassesPayment,
  remainingClassesEligibility,
  validateClassesRemaining,
  RemainingClassesError,
  classesPerPeriod as classesPerPeriodOf,
  PartialDue,
} from '../utils/remainingClasses';
import { normalizeSchoolName } from '../utils/brandingUtils';
// Una sola regla de duplicados (spec cobros-multiples §16.3): la misma que el modal «Cobros y pagos».
import { buscarDuplicadoParaAlta } from '../services/athlete-duplicates.service';
import { addDaysToDateString, todayInZone } from '../utils/businessDate';
import {
  enrollmentFeeDueDate,
  EnrollmentFeeWaivers,
  waivedFeeCategories,
  cancelWaivedFeeRows,
  auditEnrollmentFeeWaiver,
  findActiveInsurance,
  conceptoDePlan,
} from '../services/enrollmentBilling';
import {
  resolverAtleta, verCobrosUnicos, cobrarUnicosDespues, CobroUnicoError, type AthleteType,
} from '../services/enrollment-fees-edit.service';


const router = Router();

// ─── Auditoría — alta/edición de atleta por un coach ────────────────────────
// Excepción a la decisión de negocio de docs/coach-athlete-scoping.md, habilitada
// por escuela vía school_settings.coach_can_create_athletes (mig 20260828174117).
// Se deja rastro explícito de quién (coach) creó a quién, porque reabre un
// permiso que el resto de las escuelas tiene cerrado.
async function auditCoachAthleteAction(
  req: AuthenticatedRequest,
  tableName: string,
  recordId: string,
  action: string,
  newData: Record<string, any>,
): Promise<void> {
  if (req.role !== 'coach') return;
  const { error } = await supabase.from('audit_logs').insert({
    school_id:  req.schoolId,
    profile_id: req.user?.id || null,
    table_name: tableName,
    record_id:  recordId,
    action,
    new_data:   newData,
  });
  if (error) req.log?.error({ err: error }, 'Error registrando auditoría de alta por coach');
}

// ─── Helpers de schema ─────────────────────────────────────────────────────
// Convierte string vacío o "none" a null antes de validar el UUID
const uuid_or_null = z
  .union([z.string().uuid(), z.literal(''), z.literal('none')])
  .nullable()
  .optional()
  .transform(v => (!v || v === '' || v === 'none') ? null : v);

// ─── Schemas ──────────────────────────────────────────────────────────────────

const EnrollmentBase = z.object({
  branch_id:        uuid_or_null,
  team_id:          uuid_or_null,
  offering_plan_id: uuid_or_null,
  offering_id:      uuid_or_null,
  start_date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monthly_fee:      z.number().min(10000).nullable().optional(),
  discount_pct:     z.number().min(0).max(100).optional(),
  // Alta a mitad de mes (F7 — D12/D14b). Ausente = exactamente el cobro de hoy.
  first_payment_mode: z.enum(['full_month', 'remaining_classes']).optional(),
  classes_remaining:  z.number().int().optional(),
  partial_due:        z.enum(['today', 'next_month_first']).optional(),
  // Exoneración por alta: la escuela no cobra la inscripción y/o el seguro del
  // plan en ESTA alta (la mensualidad sí se cobra). Ausente = como hoy.
  waive_registration_fee: z.boolean().optional(),
  waive_insurance_fee:    z.boolean().optional(),
});

const feeWaiversOf = (d: { waive_registration_fee?: boolean; waive_insurance_fee?: boolean }): EnrollmentFeeWaivers => ({
  registration: d.waive_registration_fee === true,
  insurance:    d.waive_insurance_fee === true,
});

const ChildSchema = EnrollmentBase.extend({
  type:          z.literal('child'),
  doc_type:      z.enum(['RC', 'TI', 'CC', 'CE', 'PP']).default('TI'),
  doc_number:    z.string().trim().min(1).nullable().optional(),   // documento opcional
  full_name:     z.string().min(2).max(150).trim(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  gender:        z.string().nullable().optional(),
  grade:         z.string().max(20).nullable().optional(),
  dorsal:        z.string().trim().max(10).nullable().optional(),
  /** ID del lector ZKTeco (solo escuelas con registration_zk_pin_enabled). */
  zk_pin:        z.number().int().nullable().optional(),
  medical_info:  z.string().optional(),   // JSON con has_allergies
  parent_name:   z.string().min(2),
  // Obligatorio salvo que la escuela active school_settings.parent_email_optional
  // (Carmel Club) — validado a mano después del parse, no acá, porque Zod no
  // conoce settings de la escuela en este punto.
  parent_email:  z.string().email().nullable().optional(),
  parent_phone:  z.string().regex(/^\d{10,}$/),
  send_invite:   z.boolean().default(true),
  /** Confirmación explícita del staff: "ya vi el duplicado, son personas distintas". */
  allow_duplicate: z.boolean().default(false),
  /** Escape para el mayor de edad que la escuela igual quiere bajo un acudiente
   *  (caso real: atleta con discapacidad, o deportista de 18 que sigue con el
   *  papá como responsable de pago). Explícito, nunca por defecto. */
  allow_adult_as_child: z.boolean().default(false),
});

const AdultExistingSchema = EnrollmentBase.extend({
  type:    z.literal('adult_existing'),
  user_id: z.string().uuid(),   // profiles.id
  dorsal:  z.string().trim().max(10).nullable().optional(),
  zk_pin:  z.number().int().nullable().optional(),
});

const ChildExistingSchema = EnrollmentBase.extend({
  type:     z.literal('child_existing'),
  child_id: z.string().uuid(),
});

const AdultInviteSchema = z.object({
  type:  z.literal('adult_invite'),
  email: z.string().email(),
});

const UnregisteredAdultSchema = EnrollmentBase.extend({
  type:          z.literal('unregistered_adult'),
  doc_type:      z.string().optional(),
  doc_number:    z.string().nullable().optional(),
  full_name:     z.string().min(2).max(150).trim(),
  email:         z.string().email().nullable().optional(),
  phone:         z.string().nullable().optional(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  gender:        z.string().nullable().optional(),
  dorsal:        z.string().trim().max(10).nullable().optional(),
  zk_pin:        z.number().int().nullable().optional(),
  send_invite:   z.boolean().default(false),
  /** Ver ChildSchema.allow_duplicate. */
  allow_duplicate: z.boolean().default(false),
});

const CreateOneSchema = z.discriminatedUnion('type', [
  ChildSchema,
  AdultExistingSchema,
  ChildExistingSchema,
  AdultInviteSchema,
  UnregisteredAdultSchema,
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcProratedFee(startDate: string, monthlyFee: number): number {
  const [year, month, day] = startDate.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day === 1) return monthlyFee;
  const remainingDays = daysInMonth - day + 1;
  return Math.round((remainingDays / daysInMonth) * monthlyFee);
}

function endOfMonth(startDate: string): string {
  const [year, month] = startDate.split('-').map(Number);
  return new Date(year, month, 0).toISOString().split('T')[0];
}

// ─── Detección de atleta duplicado ────────────────────────────────────────────
//
// BLOQUEAR Y SUGERIR, nunca adoptar en automático. Un merge equivocado fusiona a
// dos personas distintas y eso es mucho más difícil de deshacer que un duplicado.
// Caso real en Dynasty: las hermanas Mariana y Sofia Ariza Sánchez comparten fecha
// de nacimiento (2011-11-16) y el teléfono del acudiente, así que cualquier
// adopción por teléfono+fecha habría hecho desaparecer a una de las dos.
//
// Por eso acá NO se cruza por teléfono ni por fecha de nacimiento: esas dos
// señales son las que tienen falsos positivos entre hermanos. Se cruza por:
//
//   1. doc_number exacto — señal fuerte, pero en la práctica atrapa poco: en los
//      cuatro duplicados medidos el 2026-08-04 el documento se re-tecleó distinto
//      cada vez (1018475529 vs 1016020710 para la misma Gabriela), así que el
//      match exacto nunca disparó.
//   2. NOMBRE NORMALIZADO — sin acentos, sin mayúsculas, espacios colapsados. Es
//      la que sí atrapa lo observado (Josue Cortes Saenz, Gabriela Buitrago,
//      Julieta Mayorga: nombre idéntico al normalizar) y NO toca a las hermanas
//      Ariza, que se llaman distinto.
//
// Se comparan las tres tablas de identidad de atleta, porque un menor puede estar
// duplicado contra un `unregistered_athletes` y viceversa. (Que existan tres
// tablas de identidad es la causa raíz de fondo; mientras siga así, cada flujo
// nuevo tiene que acordarse de consultar las tres.)

/**
 * Años cumplidos a la fecha de negocio. `null` si no hay fecha de nacimiento.
 *
 * Se usa para decidir QUÉ es cada quien, no solo para mostrarlo: un mayor de
 * edad registrado como `children` con acudiente arrastra una identidad falsa.
 * En Dynasty hay 52 así, y en 28 de ellos el "acudiente" es el propio atleta —
 * se auto-registró como su propio padre porque no había otra forma.
 */
function edadCumplida(dob?: string | null): number | null {
  if (!dob) return null;
  const hoy = todayInZone();
  let años = Number(hoy.slice(0, 4)) - Number(dob.slice(0, 4));
  if (hoy.slice(5) < dob.slice(5)) años -= 1;   // todavía no cumplió este año
  return años;
}

/** minúsculas, sin acentos, espacios colapsados. Para comparar nombres escritos a mano. */
function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quita diacriticos (JERONIMO == Jeronimo)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface AthleteDuplicate {
  table: 'children' | 'unregistered_athletes';
  id: string;
  full_name: string;
  doc_number: string | null;
  date_of_birth: string | null;
  matched_by: 'doc_number' | 'nombre';
}

/**
 * Busca un atleta ya registrado en la escuela que sea probablemente la misma
 * persona. Devuelve el primer match, priorizando documento sobre nombre.
 *
 * Trae el padrón de la escuela y compara en memoria a propósito: la comparación
 * de nombres necesita quitar acentos y PostgREST no expone `unaccent`. Con ~400
 * atletas por escuela el costo es irrelevante frente a un alta.
 */
async function findExistingAthlete(
  schoolId: string,
  opts: { docNumber?: string | null; fullName?: string | null },
): Promise<AthleteDuplicate | null> {
  const doc = opts.docNumber?.trim() || null;
  const name = opts.fullName ? normalizeName(opts.fullName) : null;
  if (!doc && !name) return null;

  const [kids, unreg] = await Promise.all([
    supabase.from('children')
      .select('id, full_name, doc_number, date_of_birth')
      .eq('school_id', schoolId),
    supabase.from('unregistered_athletes')
      .select('id, full_name, doc_number, date_of_birth')
      .eq('school_id', schoolId),
  ]);

  const pool: Array<AthleteDuplicate> = [
    ...((kids.data ?? []) as any[]).map(r => ({ ...r, table: 'children' as const, matched_by: 'nombre' as const })),
    ...((unreg.data ?? []) as any[]).map(r => ({ ...r, table: 'unregistered_athletes' as const, matched_by: 'nombre' as const })),
  ];

  // Documento primero: es la señal más fuerte cuando existe.
  if (doc) {
    const hit = pool.find(r => (r.doc_number ?? '').trim() === doc);
    if (hit) return { ...hit, matched_by: 'doc_number' };
  }

  if (name) {
    const hit = pool.find(r => normalizeName(r.full_name ?? '') === name);
    if (hit) return { ...hit, matched_by: 'nombre' };
  }

  return null;
}

/** Cuerpo del 409. La ruta es staff-only, así que devolver el registro hallado no
 *  expone datos de otra familia a un tercero — el caller ya administra ese padrón.
 *  OJO: si algún día esto se expone al flujo del acudiente (QR público), la
 *  respuesta debe degradarse a un mensaje sin nombres. */
function duplicateResponse(dup: AthleteDuplicate) {
  const como = dup.matched_by === 'doc_number'
    ? `el documento ${dup.doc_number}`
    : 'el mismo nombre';
  return {
    error: `Ya existe un atleta con ${como} en esta escuela: "${dup.full_name}". `
         + 'Si es la misma persona, editá ese registro en vez de crear uno nuevo. '
         + 'Si son personas distintas, reenviá con allow_duplicate = true.',
    duplicate: dup,
    existing_id: dup.id,   // se conserva por compatibilidad con el cliente actual
  };
}

type AthleteCol = 'child_id' | 'user_id' | 'unregistered_athlete_id';

/** Contexto de «clases restantes» ya validado (ver resolveRemainingClasses). */
export interface RemainingCtx {
  classesRemaining: number;
  classesPerPeriod: number;
  partialDue: PartialDue;
}

/** Error del alta con su status HTTP (409 período ocupado, 400 plan ajeno…). */
export class AltaError extends Error {
  constructor(public status: number, message: string, public code: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/**
 * ¿Ya hay una inscripción activa/pendiente igual? Mismo criterio que el viejo
 * createEnrollment: si existe, el alta NO crea otra ni cobra inscripción/seguro
 * (no es un alta nueva — D18), pero los cobros del período se intentan igual,
 * como antes.
 */
async function hasActiveEnrollment(params: {
  schoolId: string;
  athleteCol: AthleteCol;
  athleteId: string;
  teamId?: string | null;
  offeringPlanId?: string | null;
}): Promise<boolean> {
  let q = supabase
    .from('enrollments')
    .select('id')
    .eq('school_id', params.schoolId)
    .in('status', ['active', 'pending'])
    .eq(params.athleteCol, params.athleteId);
  if (params.teamId) q = q.eq('team_id', params.teamId);
  if (params.offeringPlanId) q = q.eq('offering_plan_id', params.offeringPlanId);
  const { data } = await q.maybeSingle();
  return !!data;
}

/**
 * Filas de cobro del período para el alta. Fuente única para los 4 ramales.
 *
 * Sin `remaining` (first_payment_mode ausente o 'full_month'): EXACTAMENTE la
 * fila de siempre — calcFirstPayment según el ciclo de la escuela, descuento
 * del primer mes, período explícito. Con `remaining`: las dos filas de D14
 * (parcial del mes del alta + mes siguiente completo), fórmula en
 * utils/remainingClasses.ts.
 */
export function buildAltaPayments(p: {
  schoolId: string;
  athleteCol: AthleteCol;
  athleteId: string;
  branchId: string | null;
  teamId: string | null;
  offeringPlanId: string | null;
  baseFee: number | null;
  discountPct?: number;
  startDate: string;
  cycleType: BillingCycleType;
  cutoffDay: number;
  conceptName: string;
  personName: string;
  remaining: RemainingCtx | null;
  today: string;
  /**
   * Acudiente CON cuenta del menor (children.parent_id). Sin esto el cobro nacía
   * con parent_id NULL: la familia lo ve por child_id, pero el bot de WhatsApp y
   * el pago en línea buscan por parent_id (B5). Solo se escribe si viene.
   */
  parentId?: string | null;
}): Record<string, any>[] {
  if (!p.baseFee || p.baseFee < 10000) return [];
  const common = {
    [p.athleteCol]:   p.athleteId,
    ...(p.parentId ? { parent_id: p.parentId } : {}),
    school_id:        p.schoolId,
    branch_id:        p.branchId,
    team_id:          p.teamId,
    offering_plan_id: p.offeringPlanId,
    status:           'pending',
    payment_type:     'subscription',
  };

  if (p.remaining) {
    const rows = calcRemainingClassesPayment({
      startDate: p.startDate,
      monthlyFee: p.baseFee,
      classesRemaining: p.remaining.classesRemaining,
      classesPerPeriod: p.remaining.classesPerPeriod,
      cutoffDay: p.cutoffDay,
      partialDue: p.remaining.partialDue,
      discountPct: p.discountPct,
      today: p.today,
    });
    return rows.map(r => ({
      ...common,
      amount:           r.amount,
      concept:          `${p.conceptName} — ${r.description} — ${p.personName}`,
      due_date:         r.dueDate,
      period_year:      r.periodYear,
      period_month:     r.periodMonth,
      payment_category: 'mensualidad',
      // El descuento viaja con el cobro (el precio de lista de cada fila parcial
      // no es la cuota completa, así que solo se guarda el %).
      ...(p.discountPct ? { discount_pct: p.discountPct } : {}),
    }));
  }

  const effectiveFee = p.discountPct
    ? Math.round(p.baseFee * (1 - p.discountPct / 100))
    : p.baseFee;
  const payCalc = calcFirstPayment(p.startDate, effectiveFee, p.cycleType, p.cutoffDay);
  return [{
    ...common,
    amount:       payCalc.amount,
    concept:      `${p.conceptName} — ${payCalc.description} — ${p.personName}${p.discountPct ? ` (Desc. ${p.discountPct}%)` : ''}`,
    due_date:     payCalc.dueDate,
    // Explícito, NO derivado del due_date por trg_payments_fill_period:
    // ese camino mandaba el cobro al mes siguiente y dejaba el mes de
    // entrada sin facturar. Además, sin periodo el cobro se escapa de
    // uniq_payment_active_period_* y se puede duplicar el mes.
    period_year:  payCalc.periodYear,
    period_month: payCalc.periodMonth,
    // El descuento viaja con el cobro: lo leen el pago manual y cualquier recálculo
    // posterior (cambio de cuota, reversa). `amount` ya viene descontado.
    ...(p.discountPct
      ? {
          discount_pct: p.discountPct,
          // Precio de lista del mismo período (con el mismo prorrateo, sin descuento).
          list_amount: calcFirstPayment(p.startDate, p.baseFee, p.cycleType, p.cutoffDay).amount,
        }
      : {}),
  }];
}

/**
 * El primer cobro de un alta no vence el MISMO día en que nace (B5).
 *
 * calcFirstPayment acota el vencimiento al día del alta cuando el corte ya
 * pasó («un cobro no nace vencido»), pero eso deja un cobro que vence hoy: la
 * familia se entera por el aviso cuando ya está en el límite. Se aplica la
 * regla de la escuela que ya usa el flujo por QR y billingDue()
 * (`GREATEST(corte, hoy + payment_grace_days)`): si vence hoy o antes, pasa a
 * hoy + días de gracia. El PERIODO no se toca. Con gracia 0 queda como estaba.
 * Solo filas de mensualidad sin clases restantes (esas traen su propia fecha).
 */
export function vencimientoPrimerCobroAlta(
  rows: Record<string, any>[],
  today: string,
  graceDays: number,
): Record<string, any>[] {
  if (!graceDays || graceDays <= 0) return rows;
  const piso = addDaysToDateString(today, graceDays);
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const textoPiso = `vence el ${Number(piso.slice(8, 10))} de ${MESES[Number(piso.slice(5, 7)) - 1]}`;
  return rows.map((r) => {
    if (r.payment_category != null && r.payment_category !== 'mensualidad') return r;
    if (typeof r.due_date !== 'string' || r.due_date > today) return r;
    // El concepto dice «vence día N» (calcFirstPayment): que diga la fecha real.
    const concept = typeof r.concept === 'string'
      ? r.concept.replace(/vence día \d+/, textoPiso)
      : r.concept;
    return { ...r, due_date: piso, concept };
  });
}

/**
 * Alta atómica (B6): inscripción + cobros del período + inscripción/seguro en
 * UNA transacción (RPC create_enrollment_with_payments). Antes eran inserts
 * sueltos: si el cobro fallaba, la inscripción quedaba sin cobro, y el error
 * del cobro se tragaba en silencio.
 */
async function altaConCobros(req: AuthenticatedRequest, p: {
  schoolId: string;
  athleteCol: AthleteCol;
  athleteId: string;
  branchId: string | null;
  teamId: string | null;
  offeringPlanId: string | null;
  offeringId: string | null;
  startDate: string;
  enrollmentMonthlyFee: number | null;
  firstPaymentMode: 'full_month' | 'remaining_classes' | null;
  payments: Record<string, any>[];
  personName: string;
  /** La escuela no cobra inscripción / seguro en esta alta. */
  feeWaivers?: EnrollmentFeeWaivers;
}): Promise<{ enrollmentsCreated: number; paymentCreated: boolean; paymentIds: string[] }> {
  const hasPlan = !!(p.offeringPlanId && p.offeringId);
  const shouldEnroll = !!(p.teamId || hasPlan);
  const exists = shouldEnroll
    ? await hasActiveEnrollment({
        schoolId: p.schoolId, athleteCol: p.athleteCol, athleteId: p.athleteId,
        teamId: p.teamId, offeringPlanId: hasPlan ? p.offeringPlanId : null,
      })
    : false;

  let enrollment: Record<string, any> | null = null;
  if (shouldEnroll && !exists) {
    enrollment = { status: 'active', start_date: p.startDate, [p.athleteCol]: p.athleteId };
    if (p.teamId) enrollment.team_id = p.teamId;
    if (hasPlan) { enrollment.offering_plan_id = p.offeringPlanId; enrollment.offering_id = p.offeringId; }
    if (p.enrollmentMonthlyFee != null && p.enrollmentMonthlyFee > 0) enrollment.monthly_fee = p.enrollmentMonthlyFee;
    if (p.firstPaymentMode) enrollment.first_payment_mode = p.firstPaymentMode;
  }

  // Inscripción + seguro (F-B): solo en un alta NUEVA con plan (D18).
  // Exonerados los dos = ni se manda el elemento (no depende de la migración
  // 20261010124934). Uno solo = waive_* en el elemento; sin exoneración, el
  // elemento es byte a byte el de siempre.
  const waived = waivedFeeCategories(p.feeWaivers);
  const emitsFees = !!(enrollment && hasPlan);
  const fees = emitsFees && waived.length < 2
    ? [{
        kind: 'enrollment_fees',
        plan_id: p.offeringPlanId,
        [p.athleteCol]: p.athleteId,
        branch_id: p.branchId,
        due_date: enrollmentFeeDueDate(p.startDate),
        person_name: p.personName,
        ...(p.feeWaivers?.registration ? { waive_registration_fee: true } : {}),
        ...(p.feeWaivers?.insurance ? { waive_insurance_fee: true } : {}),
      }]
    : [];

  if (!enrollment && p.payments.length === 0) {
    return { enrollmentsCreated: 0, paymentCreated: false, paymentIds: [] };
  }

  const { data, error } = await supabase.rpc('create_enrollment_with_payments', {
    p_school_id: p.schoolId,
    p_enrollment: enrollment,
    p_payments: [...p.payments, ...fees],
  });

  if (error) {
    const msg = String((error as any).message || '');
    const ocupado = /periodo_ocupado:(\d{4}-\d{2})/.exec(msg);
    if (ocupado) {
      throw new AltaError(409,
        `El atleta ya tiene un cobro activo del período ${ocupado[1]}. No se creó la inscripción ni sus cobros: revisa su ficha antes de inscribirlo de nuevo.`,
        'PERIODO_OCUPADO', { period: ocupado[1] });
    }
    if (/plan_no_encontrado/.test(msg)) {
      throw new AltaError(400, 'El plan elegido no pertenece a esta escuela.', 'PLAN_NO_ENCONTRADO');
    }
    req.log?.error({ err: error }, 'Error en create_enrollment_with_payments');
    throw new AltaError(500, 'No se pudo crear la inscripción y sus cobros. No se guardó nada de la inscripción.', 'ALTA_FALLIDA');
  }

  const result = (data ?? {}) as { enrollment_id?: string | null; payment_ids?: string[] };
  let paymentIds = result.payment_ids ?? [];
  if (emitsFees && waived.length) {
    // Red de seguridad si la base aún no tiene 20261010124934 (la RPC vieja
    // ignora waive_* y cobra igual): anula la fila exonerada. Luego, rastro.
    paymentIds = await cancelWaivedFeeRows({
      schoolId: p.schoolId, paymentIds, waivers: p.feeWaivers, log: req.log,
    });
    await auditEnrollmentFeeWaiver({
      schoolId: p.schoolId, profileId: req.user?.id, enrollmentId: result.enrollment_id,
      planId: p.offeringPlanId, athleteCol: p.athleteCol, athleteId: p.athleteId,
      waivers: p.feeWaivers, log: req.log,
    });
  }
  return {
    enrollmentsCreated: result.enrollment_id ? 1 : 0,
    paymentCreated: p.payments.length > 0,
    paymentIds,
  };
}

/**
 * Valida y resuelve «clases restantes» ANTES de crear nada (el ramal de menor
 * inserta `children` antes de la inscripción). Solo lee settings/plan cuando
 * el alta pide remaining_classes: sin el campo, las consultas son las de hoy.
 */
async function resolveRemainingClasses(
  schoolId: string,
  data: { first_payment_mode?: string | null; classes_remaining?: number | null; partial_due?: PartialDue | null;
          offering_plan_id?: string | null; offering_id?: string | null },
  cycleType: BillingCycleType,
): Promise<RemainingCtx | null> {
  if (data.first_payment_mode !== 'remaining_classes') return null;

  const hasPlan = !!(data.offering_plan_id && data.offering_id);
  const [{ data: flags }, planRes] = await Promise.all([
    supabase.from('school_settings')
      .select('remaining_classes_billing_enabled, hours_session_block_minutes')
      .eq('school_id', schoolId)
      .maybeSingle(),
    hasPlan
      ? supabase.from('offering_plans')
          .select('duration_days, max_sessions, included_minutes_per_period, session_block_minutes')
          .eq('id', data.offering_plan_id as string)
          .eq('school_id', schoolId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const elig = remainingClassesEligibility({
    flagEnabled: !!(flags as any)?.remaining_classes_billing_enabled,
    cycleType,
    plan: (planRes as any).data ?? null,
    schoolBlockMinutes: (flags as any)?.hours_session_block_minutes ?? null,
  });
  if (!elig.eligible) {
    throw new AltaError(400, elig.reason, 'REMAINING_CLASSES_NOT_AVAILABLE');
  }
  if (data.classes_remaining == null) {
    throw new AltaError(400, 'Indica cuántas clases le quedan del mes.', 'REMAINING_CLASSES_REQUIRED');
  }
  try {
    validateClassesRemaining(data.classes_remaining, elig.classes);
  } catch (e: any) {
    if (e instanceof RemainingClassesError) throw new AltaError(400, e.message, 'REMAINING_CLASSES_INVALID');
    throw e;
  }
  return {
    classesRemaining: data.classes_remaining,
    classesPerPeriod: elig.classes,
    partialDue: data.partial_due ?? 'today',
  };
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.post(
  '/create-one',
  requireAuth,
  // Alta de atletas: admin/owner de la escuela, o coach si la escuela lo activó
  // (school_settings.coach_can_create_athletes — excepción de Carmel Club, ver
  // mig 20260828174117). Por default el coach sigue sin poder: se rechaza más
  // abajo, después de leer settings, no en esta lista estática.
  requireRole('owner', 'admin', 'super_admin', 'school_admin', 'school', 'coach'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req;

    const parsed = CreateOneSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Datos inválidos.', details: parsed.error.issues });
    }

    const data = parsed.data;

    try {
      // ── Obtener nombre y configuración de la escuela ───────────────────────
      const [{ data: school }, { data: settings }] = await Promise.all([
        supabase.from('schools').select('name').eq('id', schoolId).single(),
        supabase.from('school_settings')
          .select('billing_cycle_type, payment_cutoff_day, payment_grace_days, require_payment_proof, coach_can_create_athletes, parent_email_optional')
          .eq('school_id', schoolId)
          .maybeSingle(),
      ]);
      const schoolName     = normalizeSchoolName(school?.name || 'la Academia');
      const cycleType      = (settings?.billing_cycle_type || 'prorated') as BillingCycleType;
      const cutoffDay      = settings?.payment_cutoff_day || 10;
      // 0 explícito es válido (misma lectura que getBillingConfig).
      const graceDays      = Number((settings as any)?.payment_grace_days ?? 5);
      const requireProof   = settings?.require_payment_proof ?? true;

      // Sin fila de settings se aplica el default de la columna (false): un
      // coach solo pasa si la escuela lo activó explícitamente.
      if (req.role === 'coach' && !settings?.coach_can_create_athletes) {
        return res.status(403).json({
          error: 'Esta escuela no permite que un entrenador dé de alta atletas. Pídelo a la escuela.',
        });
      }

      // Exonerar inscripción / seguro es decisión de la administración, no del
      // coach (spec cobros-multiples: exonerar = canManageCharges).
      const askedWaiver = (data as any).waive_registration_fee === true || (data as any).waive_insurance_fee === true;
      if (req.role === 'coach' && askedWaiver) {
        return res.status(403).json({
          error: 'Un entrenador no puede dejar sin cobrar la inscripción ni el seguro. Pídelo a la escuela.',
          code: 'WAIVER_FORBIDDEN',
        });
      }

      // parent_email es opcional en el schema (para que la escuela con el
      // flag pueda omitirlo), pero para el resto sigue siendo obligatorio —
      // se valida acá porque Zod no conoce settings de la escuela.
      if (data.type === 'child' && !data.parent_email && !settings?.parent_email_optional) {
        return res.status(400).json({ error: 'El email del acudiente es obligatorio.' });
      }

      // ID del torniquete (Dreamers): asociar el deportista al lector desde el alta.
      // Se valida ANTES de crear nada (formato, escuela habilitada, ID libre).
      // Control de acceso es de administración: el entrenador no lo configura.
      const rawZkPin = (data as any).zk_pin as number | null | undefined;
      if (rawZkPin != null && req.role === 'coach') {
        return res.status(403).json({
          error: 'El ID del torniquete lo asigna la administración de la escuela.',
          code: 'ZK_PIN_FORBIDDEN',
        });
      }
      const zkPin = await prepareZkPinForSignup(
        schoolId!, rawZkPin,
        data.type === 'adult_existing' ? { user_id: data.user_id } : undefined,
      );
      // Tras crear al deportista: si el vínculo falla (carrera por el mismo ID) el alta
      // NO se revierte; se avisa para asignarlo desde Control de acceso.
      const linkZkPin = async (subject: ZkSubject): Promise<{ zk_pin?: number; zk_pin_warning?: string }> => {
        if (zkPin === null) return {};
        try {
          await assignZkPin(schoolId!, zkPin, subject);
          return { zk_pin: zkPin };
        } catch (e: any) {
          req.log?.error({ err: e?.message ?? e, zkPin }, 'No se pudo asociar el ID del torniquete tras el alta');
          return {
            zk_pin_warning: `Se registró, pero no se pudo asociar el ID ${zkPin} al torniquete. `
              + 'Asígnalo desde Control de acceso.',
          };
        }
      };

      // Alta por clases restantes (F7): se valida ANTES de crear al atleta.
      const remaining = data.type === 'adult_invite'
        ? null
        : await resolveRemainingClasses(schoolId!, data, cycleType);
      const firstPaymentMode = data.type === 'adult_invite' ? null : (data.first_payment_mode ?? null);
      const today = todayInZone();

      // Fuente del link de invitacion, en orden de preferencia:
      //   1. Origin del request (dominio desde donde se invita: stg / dev / app).
      //   2. FRONTEND_URL del entorno como failsafe.
      //   3. Fallback a app.sportmaps.co (TLD corregido; antes decia .com).
      // El CORS middleware ya valida que Origin sea *.sportmaps.co / vercel.app,
      // asi que no hay riesgo de spoof de un dominio arbitrario.
      const requestOrigin =
        (req.headers.origin as string | undefined) ||
        (req.headers.referer as string | undefined)?.replace(/\/$/, '');
      const origin = requestOrigin || process.env.FRONTEND_URL || 'https://app.sportmaps.co';

      // ══════════════════════════════════════════════════════════════════════
      // FLUJO A — Menor de edad
      // ══════════════════════════════════════════════════════════════════════
      if (data.type === 'child') {
        // 0. ¿De verdad es un menor?
        //
        // El tipo lo elige quien llama, y hasta acá nadie lo contrastaba contra
        // la fecha de nacimiento. Por eso hay 52 adultos en Dynasty modelados
        // como menores con acudiente ficticio. Un mayor de edad es un ATLETA:
        // entra con su cuenta, paga y recibe los avisos él mismo.
        const edad = edadCumplida(data.date_of_birth);
        if (edad !== null && edad >= 18 && !data.allow_adult_as_child) {
          return res.status(409).json({
            error: `${data.full_name} tiene ${edad} años: es mayor de edad y va como atleta, no como menor con acudiente.`,
            reason: 'mayor_de_edad',
            edad,
            sugerencia: 'Usa el alta de atleta adulto (type "adult_invite" si no tiene cuenta, '
                      + '"adult_existing" si ya se registró). Así entra con su propia cuenta y recibe los avisos.',
            forzar_con: 'allow_adult_as_child',
          });
        }

        // 1. Duplicado ya registrado en la escuela.
        //
        // Antes esto solo miraba `children` y solo por `doc_number` exacto. Con eso
        // pasaron los cuatro duplicados del 2026-08-04: el documento se re-tecleó
        // distinto cada vez, así que el match nunca disparó. Ahora cruza también por
        // nombre normalizado y contra `unregistered_athletes` — un menor puede estar
        // duplicado contra un registro que la escuela creó sin cuenta.
        if (!data.allow_duplicate) {
          const dup = await buscarDuplicadoParaAlta(schoolId, {
            docNumber: data.doc_number,
            fullName: data.full_name,
          });
          if (dup) return res.status(409).json(duplicateResponse(dup));
        }

        // 2. INSERT children
        const { data: child, error: childErr } = await supabase
          .from('children')
          .insert({
            full_name:         data.full_name,
            doc_type:          data.doc_type,
            doc_number:        data.doc_number || null,
            date_of_birth:     data.date_of_birth     || null,
            gender:            data.gender             || null,
            grade:             data.grade              || null,
            dorsal:            data.dorsal             || null,
            medical_info:      data.medical_info       || JSON.stringify({ has_allergies: false }),
            school_id:         schoolId,
            branch_id:         data.branch_id          || null,
            // Guardamos team_id en children solo como referencia rápida
            // El enrollment es la fuente de verdad
            team_id:           data.team_id            || null,
            monthly_fee:       data.monthly_fee        || null,
            parent_name_temp:  data.parent_name,
            parent_email_temp: data.parent_email,
            parent_phone_temp: data.parent_phone,
            is_active:         true,
            is_demo:           false,
          })
          .select('id')
          .single();

        if (childErr || !child) {
          return res.status(500).json({ error: childErr?.message || 'Error al crear el menor.' });
        }

        const childId = child.id;
        // ── UN atleta = UNA inscripción = UN cobro ─────────────────────────────
        // El equipo es roster; el plan es lo que se cobra. Cuota efectiva:
        // monthly_fee editado > precio del plan > precio del equipo.
        const hasPlan = !!(data.offering_plan_id && data.offering_id);

        let teamName = 'Equipo'; let teamPrice: number | null = null;
        if (data.team_id) {
          const { data: team } = await supabase.from('teams').select('name, price_monthly').eq('id', data.team_id).single();
          if (team) { teamName = team.name; teamPrice = team.price_monthly != null ? Number(team.price_monthly) : null; }
        }
        let planName: string | null = null; let planPrice: number | null = null;
        if (hasPlan) {
          const { data: plan } = await supabase.from('offering_plans').select('price, name').eq('id', data.offering_plan_id).single();
          if (plan) { planName = plan.name; planPrice = plan.price != null ? Number(plan.price) : null; }
        }

        // plan manda si hay plan; si no, equipo. monthly_fee editado tiene prioridad.
        const baseFee: number | null =
          (data.monthly_fee && data.monthly_fee > 0) ? data.monthly_fee
          : hasPlan ? planPrice
          : teamPrice;

        // UNA sola inscripción con equipo (roster) y/o plan (cobro) + UN cobro
        // (dos con clases restantes) + inscripción/seguro, en una transacción.
        const alta = await altaConCobros(req, {
          feeWaivers: feeWaiversOf(data),
          schoolId: schoolId!, athleteCol: 'child_id', athleteId: childId,
          branchId: data.branch_id || null, teamId: data.team_id || null,
          offeringPlanId: hasPlan ? data.offering_plan_id : null,
          offeringId: hasPlan ? data.offering_id : null,
          startDate: data.start_date, enrollmentMonthlyFee: baseFee,
          firstPaymentMode, personName: data.full_name,
          payments: buildAltaPayments({
            schoolId: schoolId!, athleteCol: 'child_id', athleteId: childId,
            branchId: data.branch_id || null, teamId: data.team_id || null,
            offeringPlanId: hasPlan ? data.offering_plan_id : null,
            baseFee, discountPct: data.discount_pct, startDate: data.start_date,
            cycleType, cutoffDay, conceptName: planName ? conceptoDePlan(planName) : `Equipo ${teamName}`,
            personName: data.full_name, remaining, today,
          }),
        });
        const enrollmentsCreated = alta.enrollmentsCreated;
        const paymentCreated = alta.paymentCreated;


        // 5. Invitación al acudiente
        // Sin parent_email (escuela con parent_email_optional) no hay a quién
        // invitar: el menor queda registrado sin acudiente con acceso a la cuenta.
        let invitationSent = false;
        let invite: any = null;
        const existingInvite = data.parent_email
          ? (await supabase
              .from('invitations')
              .select('id')
              .eq('school_id', schoolId)
              .eq('email', data.parent_email)
              .in('status', ['pending', 'accepted'])
              .maybeSingle()).data
          : null;

        if (data.parent_email && !existingInvite) {
          const { data: inviteData, error: invErr } = await supabase
            .from('invitations')
            .insert({
              email:            data.parent_email,
              school_id:        schoolId,
              role_to_assign:   'parent',
              invited_by:       req.user?.id || null,
              status:           'pending',
              child_name:       data.full_name,
              team_id:          data.team_id          || null,
              offering_plan_id: data.offering_plan_id || null,
              monthly_fee:      data.monthly_fee      || null,
            })
            .select('id')
            .single();

          if (!invErr && inviteData) {
            invite = inviteData;
            invitationSent = true;
            if (data.send_invite !== false) {
              const { emailClient } = await import('../utils/emailClient');
              const { BrandedEmailTemplates } = await import('../utils/emailTemplates');
              const link = `${origin}/register?email=${encodeURIComponent(data.parent_email)}&role=parent&invite=${invite.id}`;
              try {
                const tpl = await BrandedEmailTemplates.invitation({
                  parentName: data.parent_name,
                  childName: data.full_name,
                  schoolId,
                  inviteLink: link,
                });
                emailClient.send({
                  to: data.parent_email,
                  subject: tpl.subject,
                  html: tpl.html,
                }).catch((e: any) => req.log?.error({ email: data.parent_email, err: e }, 'Fallo email'));
              } catch (e: any) {
                req.log?.error({ email: data.parent_email, err: e }, 'Fallo template branded');
              }
            }
          }
        }

        const registrationLink = invitationSent && data.parent_email
          ? `${origin}/register?email=${encodeURIComponent(data.parent_email)}&role=parent&invite=${invite?.id ?? ''}`
          : null;

        await auditCoachAthleteAction(req, 'children', childId, 'COACH_CREATE_ATHLETE', {
          full_name: data.full_name, type: 'child',
        });

        const zkLink = await linkZkPin({ child_id: childId });

        return res.status(201).json({
          success: true,
          child_id: childId,
          ...zkLink,
          enrollments_created: enrollmentsCreated,
          payment_created: paymentCreated,
          invitation_sent: invitationSent,
          registration_link: registrationLink,
          parent_phone: data.parent_phone ?? null,
          message: `Menor registrado. ${enrollmentsCreated} inscripción(es) creada(s).${invitationSent ? ` Invitación enviada a ${data.parent_email}.` : ''}`,
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      // FLUJO B — Atleta adulto existente en profiles
      // ══════════════════════════════════════════════════════════════════════
      if (data.type === 'adult_existing') {
        const userId = data.user_id; // profiles.id

        // 1. Verificar que el perfil exista
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, full_name, email')
          .eq('id', userId)
          .maybeSingle();

        if (!profile) {
          return res.status(404).json({ error: 'No se encontró el perfil del atleta.' });
        }

        // 2. INSERT school_members si no es miembro activo de esta escuela
        const { data: existingMember } = await supabase
          .from('school_members')
          .select('id')
          .eq('profile_id', userId)
          .eq('school_id', schoolId)
          .eq('status', 'active')
          .maybeSingle();

        if (!existingMember) {
          const { error: memberErr } = await supabase.from('school_members').insert({
            profile_id: userId,
            school_id:  schoolId,
            role:       'athlete',
            status:     'active',
            branch_id:  data.branch_id || null,
            dorsal:     data.dorsal || null,
            joined_at:  new Date().toISOString(),
          });
          if (memberErr) {
            req.log?.error({ err: memberErr }, 'Error creando school_member');
            // No bloqueamos — igual creamos el enrollment
          }
        } else if (data.dorsal) {
          const { error: dorsalErr } = await supabase
            .from('school_members')
            .update({ dorsal: data.dorsal })
            .eq('id', existingMember.id);
          if (dorsalErr) {
            req.log?.error({ err: dorsalErr }, 'Error actualizando dorsal de school_member');
          }
        }

        // ── UN atleta = UNA inscripción = UN cobro (plan manda; equipo = roster) ─
        const hasPlan = !!(data.offering_plan_id && data.offering_id);

        let teamName = 'Equipo'; let teamPrice: number | null = null;
        if (data.team_id) {
          const { data: team } = await supabase.from('teams').select('name, price_monthly').eq('id', data.team_id).single();
          if (team) { teamName = team.name; teamPrice = team.price_monthly != null ? Number(team.price_monthly) : null; }
        }
        let planName: string | null = null; let planPrice: number | null = null;
        if (hasPlan) {
          const { data: plan } = await supabase.from('offering_plans').select('price, name').eq('id', data.offering_plan_id).single();
          if (plan) { planName = plan.name; planPrice = plan.price != null ? Number(plan.price) : null; }
        }

        const baseFee: number | null =
          (data.monthly_fee && data.monthly_fee > 0) ? data.monthly_fee
          : hasPlan ? planPrice
          : teamPrice;

        const alta = await altaConCobros(req, {
          feeWaivers: feeWaiversOf(data),
          schoolId: schoolId!, athleteCol: 'user_id', athleteId: userId,
          branchId: data.branch_id || null, teamId: data.team_id || null,
          offeringPlanId: hasPlan ? data.offering_plan_id : null,
          offeringId: hasPlan ? data.offering_id : null,
          startDate: data.start_date, enrollmentMonthlyFee: baseFee,
          firstPaymentMode, personName: profile.full_name,
          payments: buildAltaPayments({
            schoolId: schoolId!, athleteCol: 'user_id', athleteId: userId,
            branchId: data.branch_id || null, teamId: data.team_id || null,
            offeringPlanId: hasPlan ? data.offering_plan_id : null,
            baseFee, discountPct: data.discount_pct, startDate: data.start_date,
            cycleType, cutoffDay, conceptName: planName ? conceptoDePlan(planName) : `Equipo ${teamName}`,
            personName: profile.full_name, remaining, today,
          }),
        });
        const enrollmentsCreated = alta.enrollmentsCreated;
        const paymentCreated = alta.paymentCreated;


        await auditCoachAthleteAction(req, 'profiles', userId, 'COACH_CREATE_ATHLETE', {
          full_name: profile.full_name, type: 'adult_existing',
        });

        const zkLink = await linkZkPin({ user_id: userId });

        return res.status(201).json({
          success: true,
          user_id: userId,
          ...zkLink,
          enrollments_created: enrollmentsCreated,
          payment_created: paymentCreated,
          message: `${profile.full_name} inscrito correctamente. ${enrollmentsCreated} inscripción(es) creada(s).`,
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      // FLUJO E — Menor ya registrado en children
      // ══════════════════════════════════════════════════════════════════════
      if (data.type === 'child_existing') {
        const { child_id } = data;

        // 1. Verificar que el menor exista
        const { data: child } = await supabase
          .from('children')
          .select('id, full_name, school_id, parent_id')
          .eq('id', child_id)
          .maybeSingle();

        if (!child) {
          return res.status(404).json({ error: 'No se encontró el registro del menor.' });
        }

        // UNA sola inscripción con equipo (roster) y/o plan (cobro).
        const hasPlan = !!(data.offering_plan_id && data.offering_id);
        let planPrice: number | null = null;
        if (hasPlan) {
          const { data: plan } = await supabase.from('offering_plans').select('price').eq('id', data.offering_plan_id).single();
          if (plan) { planPrice = plan.price != null ? Number(plan.price) : null; }
        }

        // UN solo cobro proporcional (ya era único aquí): solo con monthly_fee
        // explícito, como siempre. Con clases restantes, sin monto explícito se
        // usa el precio del plan (la fórmula necesita una cuota).
        const feeForPayments: number | null =
          (data.monthly_fee && data.monthly_fee > 0) ? data.monthly_fee
          : remaining ? planPrice
          : null;

        const alta = await altaConCobros(req, {
          feeWaivers: feeWaiversOf(data),
          schoolId: schoolId!, athleteCol: 'child_id', athleteId: child_id,
          branchId: data.branch_id || null, teamId: data.team_id || null,
          offeringPlanId: hasPlan ? data.offering_plan_id : null,
          offeringId: hasPlan ? data.offering_id : null,
          startDate: data.start_date,
          enrollmentMonthlyFee: (data.monthly_fee && data.monthly_fee > 0) ? data.monthly_fee : null,
          firstPaymentMode, personName: child.full_name,
          // B5 (alta por código de escuela, y toda asignación de un menor que ya
          // tiene ficha): el pagador es el acudiente con cuenta y el primer cobro
          // no vence el mismo día del alta.
          payments: (() => {
            const rows = buildAltaPayments({
              schoolId: schoolId!, athleteCol: 'child_id', athleteId: child_id,
              branchId: data.branch_id || null, teamId: data.team_id || null,
              offeringPlanId: data.offering_plan_id || null,
              baseFee: feeForPayments, discountPct: data.discount_pct, startDate: data.start_date,
              cycleType, cutoffDay, conceptName: 'Suscripción',
              personName: child.full_name, remaining, today,
              parentId: (child as any).parent_id ?? null,
            });
            return remaining ? rows : vencimientoPrimerCobroAlta(rows, today, graceDays);
          })(),
        });
        const enrollmentsCreated = alta.enrollmentsCreated;
        const paymentCreated = alta.paymentCreated;

        await auditCoachAthleteAction(req, 'children', child_id, 'COACH_CREATE_ATHLETE', {
          full_name: child.full_name, type: 'child_existing',
        });

        return res.status(201).json({
          success: true,
          child_id: child_id,
          enrollments_created: enrollmentsCreated,
          payment_created: paymentCreated,
          message: `${child.full_name} inscrito correctamente. ${enrollmentsCreated} inscripción(es) creada(s).`,
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      // FLUJO C — Atleta sin cuenta → solo invitación
      // ══════════════════════════════════════════════════════════════════════
      if (data.type === 'adult_invite') {
        // Verificar si ya hay invitación pendiente/aceptada
        const { data: existingInvite } = await supabase
          .from('invitations')
          .select('id')
          .eq('school_id', schoolId)
          .eq('email', data.email)
          .in('status', ['pending', 'accepted'])
          .maybeSingle();

        if (existingInvite) {
          return res.status(409).json({
            error: `Ya existe una invitación activa para ${data.email}.`,
          });
        }

        const { data: invite, error: invErr } = await supabase
          .from('invitations')
          .insert({
            email:          data.email,
            school_id:      schoolId,
            role_to_assign: 'athlete',
            invited_by:     req.user?.id || null,
            status:         'pending',
          })
          .select('id')
          .single();

        if (invErr || !invite) {
          return res.status(500).json({ error: invErr?.message || 'Error creando invitación.' });
        }

        // Fire-and-forget email branded por escuela
        const { emailClient } = await import('../utils/emailClient');
        const { BrandedEmailTemplates } = await import('../utils/emailTemplates');
        const link = `${origin}/register?email=${encodeURIComponent(data.email)}&role=athlete&invite=${invite.id}`;
        try {
          const tpl = await BrandedEmailTemplates.invitation({
            parentName: data.email.split('@')[0],
            childName: '',
            schoolId,
            inviteLink: link,
          });
          emailClient.send({
            to: data.email,
            subject: tpl.subject,
            html: tpl.html,
          }).catch((e: any) => req.log?.error({ email: data.email, err: e }, 'Fallo email invitación'));
        } catch (e: any) {
          req.log?.error({ email: data.email, err: e }, 'Fallo template branded');
        }

        await auditCoachAthleteAction(req, 'invitations', invite.id, 'COACH_CREATE_ATHLETE', {
          email: data.email, type: 'adult_invite',
        });

        return res.status(201).json({
          success: true,
          invitation_id: invite.id,
          registration_link: link,
          message: `Invitación enviada a ${data.email}. Una vez se registre podrás inscribirlo.`,
        });
      }

      // ── FLUJO D: Atleta adulto sin cuenta ──────────────────────────────────────────
      if (data.type === 'unregistered_adult') {
        // Esta rama NO tenía ningún chequeo: insertaba directo. Es la que creó
        // DAIMARIS VASQUEZ PEREZ tres minutos antes de que la misma persona
        // apareciera como atleta adulta con su propia cuenta.
        if (!data.allow_duplicate) {
          const dup = await buscarDuplicadoParaAlta(schoolId, {
            docNumber: data.doc_number,
            fullName: data.full_name,
          });
          if (dup) return res.status(409).json(duplicateResponse(dup));
        }

        const { data: ua, error: uaErr } = await supabase
          .from('unregistered_athletes')
          .insert({
            school_id:     schoolId,
            doc_type:      data.doc_type      || null,
            doc_number:    data.doc_number    || null,
            full_name:     data.full_name,
            email:         data.email         || null,
            phone:         data.phone         || null,
            date_of_birth: data.date_of_birth || null,
            gender:        data.gender        || null,
            dorsal:        data.dorsal        || null,
            branch_id:     data.branch_id     || null,
            is_active:     true,
          })
          .select('id')
          .single();

        if (uaErr || !ua) {
          return res.status(500).json({ error: uaErr?.message || 'Error al registrar atleta.' });
        }

        const uaId = ua.id;

        // ── UN atleta = UNA inscripción = UN cobro (plan manda; equipo = roster) ─
        const hasPlan = !!(data.offering_plan_id && data.offering_id);

        let teamName = 'Equipo'; let teamPrice: number | null = null;
        if (data.team_id) {
          const { data: team } = await supabase.from('teams').select('name, price_monthly').eq('id', data.team_id).single();
          if (team) { teamName = team.name; teamPrice = team.price_monthly != null ? Number(team.price_monthly) : null; }
        }
        let planName: string | null = null; let planPrice: number | null = null;
        if (hasPlan) {
          const { data: plan } = await supabase.from('offering_plans').select('price, name').eq('id', data.offering_plan_id).single();
          if (plan) { planName = plan.name; planPrice = plan.price != null ? Number(plan.price) : null; }
        }

        const baseFee: number | null =
          (data.monthly_fee && data.monthly_fee > 0) ? data.monthly_fee
          : hasPlan ? planPrice
          : teamPrice;

        const alta = await altaConCobros(req, {
          feeWaivers: feeWaiversOf(data),
          schoolId: schoolId!, athleteCol: 'unregistered_athlete_id', athleteId: uaId,
          branchId: data.branch_id || null, teamId: data.team_id || null,
          offeringPlanId: hasPlan ? data.offering_plan_id : null,
          offeringId: hasPlan ? data.offering_id : null,
          startDate: data.start_date, enrollmentMonthlyFee: baseFee,
          firstPaymentMode, personName: data.full_name,
          payments: buildAltaPayments({
            schoolId: schoolId!, athleteCol: 'unregistered_athlete_id', athleteId: uaId,
            branchId: data.branch_id || null, teamId: data.team_id || null,
            offeringPlanId: hasPlan ? data.offering_plan_id : null,
            baseFee, discountPct: data.discount_pct, startDate: data.start_date,
            cycleType, cutoffDay, conceptName: planName ? conceptoDePlan(planName) : `Equipo ${teamName}`,
            personName: data.full_name, remaining, today,
          }),
        });
        const enrollmentsCreated = alta.enrollmentsCreated;


        let invitationSent = false;
        let invite: any = null;
        if (data.send_invite && data.email) {
          const { data: existingInv } = await supabase.from('invitations').select('id')
            .eq('school_id', schoolId).eq('email', data.email)
            .in('status', ['pending', 'accepted']).maybeSingle();

          if (!existingInv) {
            // Calcular el monto efectivo descontado para guardarlo en la invitación
            let invMonthlyFee: number | null = null;
            if (data.offering_plan_id && data.offering_id) {
              const { data: plan } = await supabase
                .from('offering_plans').select('price').eq('id', data.offering_plan_id).single();
              if (plan) {
                invMonthlyFee = data.discount_pct
                  ? Math.round(Number(plan.price) * (1 - data.discount_pct / 100))
                  : Number(plan.price);
              }
            } else if (data.monthly_fee) {
              invMonthlyFee = data.discount_pct
                ? Math.round(data.monthly_fee * (1 - data.discount_pct / 100))
                : data.monthly_fee;
            }

            const { data: inviteData } = await supabase.from('invitations')
              .insert({
                email: data.email, school_id: schoolId,
                role_to_assign: 'athlete', invited_by: req.user?.id || null, status: 'pending',
                offering_plan_id: data.offering_plan_id || null,
                team_id: data.team_id || null,
                monthly_fee: invMonthlyFee,
                parent_phone: data.phone || null,
              })
              .select('id').single();

            if (inviteData) {
              invite = inviteData;
              // Vincular invitación al registro
              await supabase.from('unregistered_athletes')
                .update({ invitation_id: invite.id }).eq('id', uaId);

              invitationSent = true;
              const { emailClient }          = await import('../utils/emailClient');
              const { BrandedEmailTemplates } = await import('../utils/emailTemplates');
              const link = `${origin}/register?email=${encodeURIComponent(data.email)}&role=athlete&invite=${invite.id}`;
              try {
                const tpl = await BrandedEmailTemplates.invitation({
                  parentName: data.full_name,
                  childName: '',
                  schoolId,
                  inviteLink: link,
                });
                emailClient.send({
                  to: data.email,
                  subject: tpl.subject,
                  html: tpl.html,
                }).catch((e: any) => req.log?.error({ err: e }, 'Fallo email'));
              } catch (e: any) {
                req.log?.error({ err: e }, 'Fallo template branded');
              }
            }
          }
        }

        await auditCoachAthleteAction(req, 'unregistered_athletes', uaId, 'COACH_CREATE_ATHLETE', {
          full_name: data.full_name, type: 'unregistered_adult',
        });

        const zkLink = await linkZkPin({ unregistered_athlete_id: uaId });

        return res.status(201).json({
          success: true,
          unregistered_athlete_id: uaId,
          ...zkLink,
          enrollments_created: enrollmentsCreated,
          invitation_sent: invitationSent,
          registration_link: invitationSent && data.email
            ? `${origin}/register?email=${encodeURIComponent(data.email)}&role=athlete&invite=${invite?.id ?? ''}`
            : null,
          phone: data.phone ?? null,
          message: `${data.full_name} registrado.${invitationSent ? ` Invitación enviada a ${data.email}.` : ''}`,
        });
      }

    } catch (err: any) {
      if (err instanceof AltaError) {
        return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
      }
      if (err instanceof ZkPinError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      req.log?.error({ err: err.message || err }, 'Error inesperado en create-one');
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
);

// ─── Preview del primer cobro (F7) ───────────────────────────────────────────
//
// POST /api/v1/students/first-payment-preview
//
// El modal de alta NO calcula «clases restantes»: pregunta acá, que usa las
// mismas funciones que el alta real (utils/remainingClasses.ts). Así la pantalla
// no puede mostrar un monto distinto del que se va a cobrar.

const PreviewSchema = z.object({
  offering_plan_id:  z.string().uuid(),
  start_date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  classes_remaining: z.number().int().optional(),
  partial_due:       z.enum(['today', 'next_month_first']).optional(),
  monthly_fee:       z.number().positive().nullable().optional(),
  discount_pct:      z.number().min(0).max(100).optional(),
  waive_registration_fee: z.boolean().optional(),
  waive_insurance_fee:    z.boolean().optional(),
  // Atleta que ya existe (a lo sumo uno): para saber si ya tiene seguro vigente.
  user_id:                 z.string().uuid().optional(),
  child_id:                z.string().uuid().optional(),
  unregistered_athlete_id: z.string().uuid().optional(),
});

router.post(
  '/first-payment-preview',
  requireAuth,
  requireRole('owner', 'admin', 'super_admin', 'school_admin', 'school'),
  async (req: AuthenticatedRequest, res: Response) => {
    const parsed = PreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Datos inválidos.', details: parsed.error.issues });
    }
    const body = parsed.data;
    const { schoolId } = req;

    try {
      const [{ data: settings }, { data: plan }] = await Promise.all([
        supabase.from('school_settings')
          .select('billing_cycle_type, payment_cutoff_day, remaining_classes_billing_enabled, hours_session_block_minutes')
          .eq('school_id', schoolId)
          .maybeSingle(),
        supabase.from('offering_plans')
          .select('price, duration_days, max_sessions, included_minutes_per_period, session_block_minutes, registration_fee, insurance_fee')
          .eq('id', body.offering_plan_id)
          .eq('school_id', schoolId)
          .maybeSingle(),
      ]);
      if (!plan) return res.status(404).json({ error: 'Plan no encontrado en esta escuela.' });

      const cycleType = ((settings as any)?.billing_cycle_type || 'prorated') as BillingCycleType;
      const cutoffDay = (settings as any)?.payment_cutoff_day || 10;
      const schoolBlock = (settings as any)?.hours_session_block_minutes ?? null;
      const elig = remainingClassesEligibility({
        flagEnabled: !!(settings as any)?.remaining_classes_billing_enabled,
        cycleType,
        plan: plan as any,
        schoolBlockMinutes: schoolBlock,
      });
      const cpp = classesPerPeriodOf(plan as any, schoolBlock);
      const fees = {
        registration_fee: Number((plan as any).registration_fee) > 0 ? Number((plan as any).registration_fee) : 0,
        insurance_fee: Number((plan as any).insurance_fee) > 0 ? Number((plan as any).insurance_fee) : 0,
      };
      const today = todayInZone();
      // Vencimiento de inscripción y seguro (el mismo que usa el alta).
      const altaDue = enrollmentFeeDueDate(body.start_date, today);

      // Seguro vigente (12 meses) del atleta que ya existe: emit_enrollment_fees
      // no lo repite, así que tampoco se suma aquí.
      const athleteRef: { col: 'user_id' | 'child_id' | 'unregistered_athlete_id'; id: string } | null =
        body.child_id ? { col: 'child_id', id: body.child_id }
        : body.user_id ? { col: 'user_id', id: body.user_id }
        : body.unregistered_athlete_id ? { col: 'unregistered_athlete_id', id: body.unregistered_athlete_id }
        : null;
      const insuranceActiveSince = athleteRef && fees.insurance_fee > 0
        ? await findActiveInsurance({ schoolId: schoolId!, athleteCol: athleteRef.col, athleteId: athleteRef.id, dueDate: altaDue })
        : null;

      // Lo que de verdad se cobra en el alta (exoneración por alta + seguro vigente).
      const chargedFees = (body.waive_registration_fee ? 0 : fees.registration_fee)
        + (body.waive_insurance_fee || insuranceActiveSince ? 0 : fees.insurance_fee);

      const base = {
        eligible: elig.eligible,
        reason: elig.eligible ? null : elig.reason,
        classes_per_period: cpp?.classes ?? null,
        source: cpp?.source ?? null,
        fees,
        fees_due_date: altaDue,
        insurance_active_since: insuranceActiveSince,
      };

      if (!elig.eligible || body.classes_remaining == null) {
        return res.json({ ...base, rows: [], total_today: null });
      }
      try {
        validateClassesRemaining(body.classes_remaining, elig.classes);
      } catch (e: any) {
        if (e instanceof RemainingClassesError) return res.status(400).json({ ...base, error: e.message });
        throw e;
      }

      const monthlyFee = body.monthly_fee && body.monthly_fee > 0 ? body.monthly_fee : Number((plan as any).price);
      const rows = calcRemainingClassesPayment({
        startDate: body.start_date,
        monthlyFee,
        classesRemaining: body.classes_remaining,
        classesPerPeriod: elig.classes,
        cutoffDay,
        partialDue: body.partial_due ?? 'today',
        discountPct: body.discount_pct,
        today,
      });
      // Lo que se paga en el alta: las filas que vencen ese día + inscripción y
      // seguro que sí se cobran.
      const totalToday = rows.filter(r => r.dueDate <= altaDue).reduce((acc, r) => acc + r.amount, 0)
        + chargedFees;

      return res.json({
        ...base,
        rows: rows.map(r => ({
          kind: r.kind,
          amount: r.amount,
          due_date: r.dueDate,
          period_year: r.periodYear,
          period_month: r.periodMonth,
          description: r.description,
        })),
        total_today: totalToday,
      });
    } catch (err: any) {
      req.log?.error({ err: err.message || err }, 'Error en first-payment-preview');
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
);

// ─── Inscripción y seguro DESPUÉS del alta (ficha de edición) ────────────────
// GET  /:id/enrollment-fees?athlete_type=child|adult|unregistered
//      → plan activo y, por concepto, si se puede cobrar, ya está cobrado o pagado.
// POST /:id/enrollment-fees { athlete_type, inscripcion?, seguro? }
//      → crea el cobro único con el valor del plan (una inscripción por atleta).
// Solo administración (el coach no cobra ni exonera). El plan define el valor.
const FeesAthleteType = z.enum(['child', 'adult', 'unregistered']);

router.get(
  '/:id/enrollment-fees',
  requireAuth,
  requireRole('owner', 'admin', 'super_admin', 'school_admin', 'school'),
  async (req: AuthenticatedRequest, res: Response) => {
    const id = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
    const type = FeesAthleteType.safeParse(req.query.athlete_type);
    const { schoolId } = req;
    if (!type.success || !z.string().uuid().safeParse(id).success || !schoolId) {
      return res.status(400).json({ error: 'Datos inválidos.' });
    }
    try {
      const athlete = await resolverAtleta(schoolId, id, type.data as AthleteType);
      if (!athlete) return res.status(403).json({ error: 'Acceso denegado.' });
      return res.json(await verCobrosUnicos(schoolId, athlete));
    } catch (err: any) {
      req.log?.error({ err: err.message || err }, 'Error leyendo inscripción/seguro del atleta');
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
);

const ChargeFeesSchema = z.object({
  athlete_type: FeesAthleteType,
  inscripcion: z.boolean().optional(),
  seguro: z.boolean().optional(),
});

router.post(
  '/:id/enrollment-fees',
  requireAuth,
  requireRole('owner', 'admin', 'super_admin', 'school_admin', 'school'),
  async (req: AuthenticatedRequest, res: Response) => {
    const id = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
    const parsed = ChargeFeesSchema.safeParse(req.body);
    const { schoolId } = req;
    if (!parsed.success || !z.string().uuid().safeParse(id).success || !schoolId) {
      return res.status(400).json({ error: 'Datos inválidos.' });
    }
    try {
      const athlete = await resolverAtleta(schoolId, id, parsed.data.athlete_type as AthleteType);
      if (!athlete) return res.status(403).json({ error: 'Acceso denegado.' });
      const out = await cobrarUnicosDespues({
        schoolId,
        profileId: req.user?.id ?? null,
        athlete,
        inscripcion: parsed.data.inscripcion === true,
        seguro: parsed.data.seguro === true,
        log: req.log,
      });
      return res.status(201).json({ ...out, ...(await verCobrosUnicos(schoolId, athlete)) });
    } catch (err: any) {
      if (err instanceof CobroUnicoError) return res.status(err.status).json({ error: err.message });
      req.log?.error({ err: err.message || err }, 'Error cobrando inscripción/seguro después del alta');
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
);

export default router;
