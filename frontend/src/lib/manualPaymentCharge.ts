/**
 * Qué estampa «Registrar pago» cuando la escuela crea un cobro NUEVO a mano
 * (efectivo/transferencia sin cobro pendiente al cual aplicarlo).
 *
 * Antes el INSERT no llevaba `payment_category` ni `period_uniqueness_exempt`,
 * y eso rompía los cobros únicos (inscripción, seguro, artículos…) por tres
 * lados:
 *   1. `trg_payments_fill_period` les ponía el período del día (due_date = hoy)
 *      y chocaban con `uniq_payment_active_period_*` contra la mensualidad del
 *      mes → 23505.
 *   2. El rescate del 23505 buscaba "el último cobro del deportista" SIN filtrar
 *      período y lo marcaba pagado con el concepto escrito: podía saldar la
 *      mensualidad pendiente con la plata del seguro.
 *   3. Con `offering_plan_id` puesto y sin categoría, el trigger
 *      `fn_extend_enrollment_on_payment_paid` lo tomaba por mensualidad y le
 *      regalaba un período de vigencia a la inscripción.
 *
 * Regla: la categoría la elige la escuela (por defecto, la que se deduce del
 * concepto). Cualquier categoría que NO sea mensualidad es un cobro único:
 * va exento del índice de período y sin `offering_plan_id`, así que pagarlo no
 * extiende vigencia sea cual sea la categoría (el trigger solo excluye por
 * nombre a inscripción/seguro/excedente). Sin categoría reconocible, se
 * conserva el comportamiento anterior.
 */
import { chargeCategoryOf, type PaymentChargeCategory } from '@/lib/payment-accounts';
import { exentoDeUnicidadDePeriodo, motivosEnPantalla } from '@/lib/motivosDeCobro';

/**
 * Opciones del selector «Tipo de cobro», en el orden en que se muestran: los
 * motivos del catálogo único con `enRegistroManual` (reserva y clase de prueba
 * tienen su propio flujo y no salen aquí).
 */
export const MANUAL_CHARGE_CATEGORY_OPTIONS: readonly { value: PaymentChargeCategory; label: string }[] =
    motivosEnPantalla()
        .filter((m) => m.enRegistroManual)
        .map((m) => ({ value: m.clave, label: m.etiquetaManual ?? m.etiqueta }));

/** Categoría efectiva: la que eligió la escuela o, si no eligió, la del concepto. */
export function effectiveManualCategory(
    chosen: PaymentChargeCategory | null | undefined,
    concept: string | null | undefined,
): PaymentChargeCategory | null {
    if (chosen) return chosen;
    // El concepto "Mensualidad…" es el default del modal; isMonthlyConcept
    // (/mensual/) era la regla anterior para pedir período, y chargeCategoryOf
    // la respeta.
    return chargeCategoryOf(null, concept);
}

export interface ManualChargeInsertFields {
    payment_category: PaymentChargeCategory | null;
    period_uniqueness_exempt: boolean;
    offering_plan_id: string | null;
}

/** Columnas de categoría/período/plan para el INSERT del cobro nuevo. */
export function manualChargeInsertFields(
    category: PaymentChargeCategory | null,
    offeringPlanId: string | null | undefined,
): ManualChargeInsertFields {
    const oneOff = category !== null && exentoDeUnicidadDePeriodo(category);
    return {
        payment_category: category,
        period_uniqueness_exempt: oneOff,
        // Sin plan, el trigger de vigencia no tiene inscripción que extender.
        offering_plan_id: oneOff ? null : (offeringPlanId ?? null),
    };
}

/** ¿El cobro nuevo es de período (pide «Mes que cubre»)? */
export function manualChargeIsPeriodic(category: PaymentChargeCategory | null): boolean {
    return category === 'mensualidad';
}

/**
 * Ante un 23505 al crear el cobro, ¿se puede reutilizar el cobro existente del
 * mismo período? Solo si el choque es del índice de período Y el cobro nuevo
 * tiene período elegido: sin período no hay forma de saber cuál es "el mismo"
 * cobro, y marcar el último del deportista saldaba uno ajeno.
 */
export function canReuseOnPeriodConflict(
    err: { code?: string; message?: string } | null | undefined,
    hasPeriod: boolean,
): boolean {
    if (!hasPeriod || err?.code !== '23505') return false;
    return /uniq_payment_active_period_per_(child|adult|unreg)/i.test(err.message ?? '');
}
