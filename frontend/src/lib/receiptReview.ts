/**
 * receiptReview — la cola de comprobantes por validar y el rechazo con motivo.
 *
 * Puro (sin Supabase), para poder probarlo. Lo usa Gestión de pagos.
 *
 * Contexto (2026-10-08, Dynasty): de la foto a la aprobación pasaban p50 3,7 h
 * y p90 49 h, y los comprobantes en verde esperaban igual que los dudosos. La
 * cola se ordena para que lo que se aprueba en un clic quede arriba y lo que
 * lleva más tiempo esperando no se pierda.
 */

/**
 * Motivos de rechazo. Los MISMOS códigos que usa el rechazo automático y el
 * CHECK de `payments.receipt_rejection_code` (mig 20261008165728). La etiqueta
 * es para la escuela; el texto que lee la familia lo arma la RPC.
 */
export const REJECT_REASONS = [
  { code: 'NOT_A_RECEIPT', label: 'Subió el QR o los datos de pago, no el comprobante' },
  { code: 'MONTO_NO_COINCIDE', label: 'El valor no coincide con el cobro' },
  { code: 'DESTINO_NO_COINCIDE', label: 'La cuenta de destino no es de la escuela' },
  { code: 'ILEGIBLE', label: 'No se alcanza a leer' },
  { code: 'REFERENCIA_DUPLICADA', label: 'Ese comprobante ya se usó en otro pago' },
  { code: 'IS_TRANSACTION_LIST', label: 'Es una lista de movimientos, no un pago' },
  { code: 'FECHA_FUERA_DE_RANGO', label: 'La fecha no corresponde a este pago' },
  { code: 'OTRO', label: 'Otro motivo (escríbelo)' },
] as const;

export type RejectReasonCode = (typeof REJECT_REASONS)[number]['code'];

/** ¿Se puede enviar el rechazo? Motivo elegido y, si es «Otro», texto escrito. */
export function rejectReasonError(code: string | null | undefined, text: string | null | undefined): string | null {
  if (!code) return 'Elige un motivo.';
  if (!REJECT_REASONS.some((r) => r.code === code)) return 'Motivo no válido.';
  if (code === 'OTRO' && !String(text ?? '').trim()) return 'Escribe el motivo: la familia lo va a leer.';
  if (String(text ?? '').length > 300) return 'El detalle es muy largo (máx. 300 caracteres).';
  return null;
}

/** Traduce el error de `reject_payment_receipt` a algo que la escuela entienda. */
export function rejectErrorMessage(err: { code?: string; message?: string } | null | undefined): string {
  const msg = String(err?.message ?? '');
  const rpcMissing = /reject_payment_receipt/.test(msg) && /not find|does not exist|schema cache/i.test(msg);
  if (err?.code === 'PGRST202' || rpcMissing) {
    return 'Falta aplicar la migración del rechazo de comprobantes (20261008165728). Mientras tanto usa «Glosar».';
  }
  if (msg.includes('PAYMENT_NOT_IN_REVIEW')) return 'Este cobro ya no tiene un comprobante en revisión. Actualiza la lista.';
  if (msg.includes('PAYMENT_FORBIDDEN')) return 'Solo el dueño o un administrador de la escuela puede rechazar comprobantes.';
  if (msg.includes('REJECT_REASON')) return 'Elige un motivo y, si es «Otro», escríbelo.';
  return msg || 'No se pudo rechazar el comprobante.';
}

// ─── Cola ────────────────────────────────────────────────────────────────────

export interface QueueItem {
  id: string;
  status: string;
  amount: number;
  amount_paid?: number | null;
  /** Pronto pago congelado en el cobro: la familia transfiere amount − esto. */
  early_payment_discount_applied?: number | null;
  receipt_verdict?: string | null;
  ocr_amount?: number | null;
  receipt_url?: string | null;
  requires_review?: boolean | null;
  period_already_settled?: boolean | null;
  /** Cuándo entró el comprobante (ISO). */
  submitted_at?: string | null;
  created_at: string;
}

const VERDICT_RANK: Record<string, number> = { verde: 0, amarillo: 1, rojo: 3 };
const rankVerdict = (v?: string | null) => (v ? VERDICT_RANK[v] ?? 2 : 2);

/** Momento desde el que espera (ISO). Sin dato de entrada, la creación. */
export function waitingSince(p: Pick<QueueItem, 'submitted_at' | 'created_at'>): string {
  return p.submitted_at || p.created_at;
}

/**
 * Orden de la cola: verde → amarillo → sin veredicto → rojo; dentro de cada
 * grupo, el que más lleva esperando primero. No muta.
 */
export function sortReviewQueue<T extends QueueItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) =>
    rankVerdict(a.receipt_verdict) - rankVerdict(b.receipt_verdict) ||
    waitingSince(a).localeCompare(waitingSince(b)) ||
    a.id.localeCompare(b.id),
  );
}

export type WaitTone = 'ok' | 'warn' | 'late';

/** «12 min», «3 h», «2 d» y su tono (>2 h ámbar, >24 h rojo). */
export function waitingLabel(sinceIso: string, now: number = Date.now()): { label: string; tone: WaitTone; ms: number } {
  const ms = Math.max(0, now - Date.parse(sinceIso));
  const min = Math.floor(ms / 60_000);
  const label = min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / 1440)} d`;
  const tone: WaitTone = ms >= 24 * 3_600_000 ? 'late' : ms >= 2 * 3_600_000 ? 'warn' : 'ok';
  return { label, tone, ms };
}

/**
 * Lo que se debe del cobro en total: el valor menos el pronto pago. Es lo que
 * queda en `amount_paid` cuando se paga completo (igual que
 * `auto_approve_payment` y el registro en efectivo).
 */
export function dueOf(p: Pick<QueueItem, 'amount' | 'early_payment_discount_applied'>): number {
  return Math.max((Number(p.amount) || 0) - Math.max(Number(p.early_payment_discount_applied) || 0, 0), 0);
}

/**
 * Saldo por cubrir del cobro: amount − amount_paid − pronto pago (la regla de
 * lib/cobrosYPagos y bff/utils/saldo-cobro). Antes ignoraba el pronto pago: un
 * comprobante de $137.750 sobre un cobro de $145.000 con $7.250 de descuento
 * salía «no coincide» y la hoja proponía un ABONO con saldo $7.250.
 */
export function remainingOf(p: Pick<QueueItem, 'amount' | 'amount_paid' | 'early_payment_discount_applied'>): number {
  return Math.max(dueOf(p) - (Number(p.amount_paid) || 0), 0);
}

/**
 * ¿Entra en «Aprobar todos los verdes»? Solo lo que aprobaría una persona sin
 * dudar: comprobante por validar, veredicto verde, monto leído igual al saldo
 * (misma tolerancia de 0,5 % que la hoja de aprobación), sin abonos previos,
 * sin rechazo previo de pasarela y sin ser un mes que ya estaba pagado.
 * Devuelve el motivo de exclusión, o null si entra.
 */
export function greenExclusion(p: QueueItem): string | null {
  if (p.status !== 'awaiting_approval') return 'no está por validar';
  if (p.receipt_verdict !== 'verde') return 'no está en verde';
  if (!p.receipt_url) return 'sin comprobante';
  if ((Number(p.amount_paid) || 0) > 0) return 'tiene abonos previos';
  if (p.requires_review) return 'tiene un intento de pasarela en revisión';
  if (p.period_already_settled) return 'ese mes ya estaba pagado';
  const remaining = remainingOf(p);
  if (p.ocr_amount == null || remaining <= 0) return 'sin monto leído';
  if (Math.abs(Number(p.ocr_amount) - remaining) / remaining > 0.005) return 'el monto leído no coincide';
  return null;
}

export function bulkGreenSelection<T extends QueueItem>(items: readonly T[]): { eligible: T[]; excludedGreens: { item: T; reason: string }[]; total: number } {
  const eligible: T[] = [];
  const excludedGreens: { item: T; reason: string }[] = [];
  const groups = receiptGroups(items);
  for (const p of items) {
    // Un comprobante de varios meses se aprueba entero desde su fila: en lote
    // se aprobaría un mes y los demás quedarían sueltos en la cola.
    const reason = p.receipt_url && groups.has(p.receipt_url)
      ? 'el comprobante cubre varios cobros: apruébalo desde su fila'
      : greenExclusion(p);
    if (reason === null) eligible.push(p);
    else if (p.receipt_verdict === 'verde' && p.status === 'awaiting_approval') excludedGreens.push({ item: p, reason });
  }
  return { eligible, excludedGreens, total: eligible.reduce((s, p) => s + remainingOf(p), 0) };
}

// ─── Un comprobante, varios cobros ───────────────────────────────────────────
//
// Cuando la familia paga varios meses en una sola transferencia, el bot liga el
// MISMO archivo (receipt_url) a cada cobro que cubre (wa_cubrir_cobros_con_comprobante,
// mig 20261013165308). Caso origen (Dynasty, 2026-11-06): Juliana Martínez Yopasa,
// $450.000 con el motivo «Pago Dynasty Sept Oct y Nov»; la hoja de aprobación
// solo veía septiembre y ofrecía aprobar $150.000.

/** Cobros de la cola que comparten comprobante. Solo grupos de 2 o más. No muta. */
export function receiptGroups<T extends QueueItem>(items: readonly T[]): Map<string, T[]> {
  const byReceipt = new Map<string, T[]>();
  for (const p of items) {
    if (!p.receipt_url) continue;
    const list = byReceipt.get(p.receipt_url);
    if (list) list.push(p);
    else byReceipt.set(p.receipt_url, [p]);
  }
  for (const [k, list] of byReceipt) if (list.length < 2) byReceipt.delete(k);
  return byReceipt;
}

/**
 * Junta en la cola los cobros del mismo comprobante, en el lugar del primero
 * que aparece (el resto del orden no cambia). Sin esto, los meses sin monto
 * leído caían al fondo, lejos del que trae la foto. No muta.
 */
export function keepReceiptGroupsTogether<T extends QueueItem>(sorted: readonly T[]): T[] {
  const groups = receiptGroups(sorted);
  if (groups.size === 0) return [...sorted];
  const out: T[] = [];
  const placed = new Set<string>();
  for (const p of sorted) {
    if (placed.has(p.id)) continue;
    const group = p.receipt_url ? groups.get(p.receipt_url) : undefined;
    for (const g of group ?? [p]) {
      out.push(g);
      placed.add(g.id);
    }
  }
  return out;
}

export interface PeriodItem {
  id: string;
  ocr_amount?: number | null;
  period_year?: number | null;
  period_month?: number | null;
  created_at: string;
}

/**
 * Orden para aprobar un grupo: primero el cobro que trae el monto leído (el que
 * el bot estampó con la foto: ahí queda el valor confirmado), luego por mes.
 */
export function orderReceiptGroup<T extends PeriodItem>(items: readonly T[]): T[] {
  const period = (p: T) => (p.period_year && p.period_month ? p.period_year * 12 + p.period_month : Number.MAX_SAFE_INTEGER);
  return [...items].sort((a, b) =>
    Number(b.ocr_amount != null) - Number(a.ocr_amount != null) ||
    period(a) - period(b) ||
    a.created_at.localeCompare(b.created_at) ||
    a.id.localeCompare(b.id),
  );
}

/** «a», «a y b», «a, b y c». */
export function joinSpanish(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
}
