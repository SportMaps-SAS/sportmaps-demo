/**
 * Borradores del formulario de «Cobros y pagos» que no son de una sola línea de
 * cobro (esas están en lib/cobrosYPagos.ts): atleta nuevo (§16), bloque «Ya lo
 * pagaron» y destino del modo varios. Viven aparte de los componentes para que
 * Fast Refresh funcione (un archivo .tsx solo exporta componentes).
 */
import { buildReceiptOcrFields } from '@/lib/receiptOcrFields';
import { errorDeRecibido } from '@/lib/payments/constanciaDeRecibido';
import type { ReceiptValidationResult } from '@/hooks/useReceiptValidator';
import type { AthleteDuplicate, NewAthletePayload, PaymentPayload, TargetKind } from '@/lib/api/chargeBatches';

// ── Atleta nuevo (§16.2) ──────────────────────────────────────────────────────

export interface NewAthleteDraft {
    kind: 'menor' | 'adulto';
    full_name: string;
    doc_type: string;
    doc_number: string;
    guardian_name: string;
    guardian_phone: string;
    date_of_birth: string;
    allow_duplicate: boolean;
}

export const emptyNewAthlete = (): NewAthleteDraft => ({
    kind: 'menor', full_name: '', doc_type: 'TI', doc_number: '', guardian_name: '', guardian_phone: '', date_of_birth: '', allow_duplicate: false,
});

/** null si el registro mínimo está completo (§16.2); si no, qué falta. */
export function newAthleteError(d: NewAthleteDraft): string | null {
    if (d.full_name.trim().length < 3) return 'Escribe el nombre completo.';
    if (d.guardian_phone.replace(/\D/g, '').length < 7) return d.kind === 'menor' ? 'Escribe el teléfono del acudiente.' : 'Escribe el teléfono.';
    return null;
}

export function newAthletePayload(d: NewAthleteDraft): NewAthletePayload {
    return {
        kind: d.kind,
        full_name: d.full_name.trim(),
        ...(d.doc_number.trim() ? { doc_type: d.doc_type, doc_number: d.doc_number.trim() } : {}),
        ...(d.kind === 'menor' && d.guardian_name.trim() ? { guardian_name: d.guardian_name.trim() } : {}),
        guardian_phone: d.guardian_phone.trim(),
        ...(d.date_of_birth ? { date_of_birth: d.date_of_birth } : {}),
        allow_duplicate: d.allow_duplicate,
    };
}

/** ¿Hay coincidencias reales (no solo teléfono) sin decisión? Bloquea confirmar. */
export function hasUnresolvedDuplicates(d: NewAthleteDraft, dups: AthleteDuplicate[] | undefined): boolean {
    if (d.allow_duplicate) return false;
    return (dups ?? []).some((m) => {
        const by = Array.isArray(m.matched_by) ? m.matched_by : [m.matched_by];
        return !(by.length === 1 && /tel/i.test(by[0]));
    });
}

// ── «Ya lo pagaron» ───────────────────────────────────────────────────────────

export interface PaymentDraft {
    on: boolean;
    method: 'cash' | 'transfer';
    /** YYYY-MM-DD tal cual lo eligió la escuela (nunca toISOString: corre el día). */
    date: string;
    reference: string;
    receiptUrl: string | null;
    ocr: ReceiptValidationResult | null;
    wantsEInvoice: boolean;
    /** Quién del equipo recibió la plata. Obligatorio si no hay comprobante. */
    receivedBy: string;
}

export const emptyPaymentDraft = (today: string, on = false): PaymentDraft => ({
    on, method: 'cash', date: today, reference: '', receiptUrl: null, ocr: null, wantsEInvoice: false, receivedBy: '',
});

/** null si se puede registrar; si no, qué falta. */
export function paymentDraftError(p: PaymentDraft, today: string): string | null {
    if (!p.on) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return 'Elige la fecha del pago.';
    if (p.date > today) return 'La fecha del pago no puede ser futura.';
    return null;
}

/**
 * Sin comprobante (efectivo, o transferencia sin soporte) falta saber quién recibió la plata.
 * Va APARTE de paymentDraftError a propósito: no debe frenar la vista previa (el resumen se
 * sigue viendo mientras se escribe el nombre), solo el botón de confirmar.
 */
export function recibidoDraftError(p: PaymentDraft, today: string): string | null {
    if (!p.on || !sinComprobante(p)) return null;
    return errorDeRecibido({ metodo: p.method, fecha: p.date, por: p.receivedBy }, today);
}

/** ¿Este pago se registra SIN comprobante? (efectivo, o transferencia sin soporte adjunto) */
export const sinComprobante = (p: Pick<PaymentDraft, 'method' | 'receiptUrl'>): boolean =>
    !(p.method === 'transfer' && p.receiptUrl);

/**
 * `buildReceiptOcrFields` estampa `receipt_verdict_at: new Date()` en cada llamada. El cuerpo se
 * recalcula en cada render y su firma decide si la vista previa sigue vigente: con una hora que
 * cambia cada vez, la firma nunca coincidía y con un comprobante cargado la vista previa se pedía
 * en bucle (cada 1,5 s) y el botón no se habilitaba. La hora se fija UNA vez por lectura del OCR.
 */
const veredictoEn = new WeakMap<object, string>();
function ocrEstable(ocr: NonNullable<PaymentDraft['ocr']>): Record<string, unknown> {
    const campos = buildReceiptOcrFields(ocr) as Record<string, unknown>;
    if (!campos.receipt_verdict_at) return campos;
    let at = veredictoEn.get(ocr);
    if (!at) { at = String(campos.receipt_verdict_at); veredictoEn.set(ocr, at); }
    return { ...campos, receipt_verdict_at: at };
}

export function paymentPayload(p: PaymentDraft): PaymentPayload {
    const ref = p.reference.trim();
    const withReceipt = p.method === 'transfer' && p.receiptUrl;
    return {
        method: p.method,
        payment_date: p.date,
        ...(ref ? { reference: ref } : {}),
        ...(withReceipt ? { receipt_url: p.receiptUrl! } : {}),
        ...(!withReceipt && p.receivedBy.trim() ? { received_by: p.receivedBy.trim() } : {}),
        ...(withReceipt && p.ocr?.imageSha256 ? { receipt_sha256: p.ocr.imageSha256 } : {}),
        // Hash y referencia OCR quedan en UNA fila (la de mayor monto), lo decide la RPC (Q23).
        ...(withReceipt && p.ocr ? { ocr: ocrEstable(p.ocr) } : {}),
        ...(p.wantsEInvoice ? { wants_e_invoice: true } : {}),
    };
}

// ── Modo varios ───────────────────────────────────────────────────────────────

export interface MultiTargetValue {
    kind: Exclude<TargetKind, 'athlete'>;
    groupId: string | null;
    includePaused: boolean;
    /** Quitados a mano de la lista del grupo. */
    excluded: string[];
    /** Elegidos a mano (kind = 'list'). */
    manual: string[];
}

export const emptyMultiTarget = (teamId?: string | null): MultiTargetValue => ({
    kind: 'team', groupId: teamId ?? null, includePaused: false, excluded: [], manual: [],
});
