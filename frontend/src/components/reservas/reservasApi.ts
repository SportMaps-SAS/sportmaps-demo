/**
 * Reservas de canchas F1 — cliente del BFF y lógica pura (sin React).
 *
 * Contrato: docs/specs/reservas-canchas-f1-contrato.md (§2–§7).
 * El servidor calcula el precio y decide el estado: el cliente NUNCA manda `price`.
 */
import { bffClient } from '@/lib/api/bffClient';
import { safeRedirectUrl } from '@/lib/safeRedirect';

// ─── Tipos del contrato ───────────────────────────────────────────────────────

export type RateAudience = 'public' | 'member';
export type PaymentMethod = 'online' | 'transfer' | 'cash' | 'none';

export interface AvailabilitySlot {
  starts_at: string; // ISO UTC
  ends_at: string;
  start_local: string; // 'HH:mm' hora de Bogotá
  end_local: string;
  price: number;
  deposit_min: number;
}

export interface AvailabilityDay {
  date: string; // 'yyyy-MM-dd' (Bogotá)
  weekday: number;
  is_holiday: boolean;
  slots: AvailabilitySlot[];
}

export interface AvailabilityFacility {
  facility_id: string;
  name: string;
  type: string;
  capacity: number;
  audience: RateAudience;
  slot_step_min: number;
  min_duration_min: number;
  duration_min: number;
  min_deposit_pct: number;
  days: AvailabilityDay[];
}

export interface AvailabilityResponse {
  ok?: boolean;
  school_id: string;
  timezone?: string;
  from: string;
  to: string;
  facilities: AvailabilityFacility[];
}

export interface AvailabilityParams {
  school_id: string;
  from: string; // yyyy-MM-dd
  to: string;
  facility_id?: string;
  sport?: string;
  duration_min?: number | null;
  audience?: RateAudience | null; // solo lo respeta el staff
}

export interface BookingReservation {
  id: string;
  facility_id: string;
  facility_name?: string;
  school_id?: string;
  status: string;
  payment_status?: string;
  starts_at: string;
  ends_at: string;
  local_date?: string;
  local_start?: string;
  local_end?: string;
  hold_expires_at: string | null;
  channel?: string;
  payment_reference?: string;
  price: number;
  amount_paid?: number;
  min_deposit_pct?: number;
  deposit_min?: number;
  refund_status?: string | null;
}

export interface BookingPricing {
  audience: RateAudience;
  total: number;
  deposit_min: number;
  currency?: string;
  source?: string;
  breakdown?: Array<{ from: string; to: string; rate: number; source?: string }>;
}

export interface BookingAlternative {
  facility_id: string;
  starts_at: string;
  ends_at: string;
  start_local: string;
  end_local: string;
  price: number;
}

export interface BookingResult {
  ok: boolean;
  idempotent_replay?: boolean;
  requires_payment?: boolean;
  reservation: BookingReservation;
  pricing?: BookingPricing;
}

export interface CancelRefund {
  pct: number;
  amount: number;
  status: 'none' | 'manual' | string;
  hours_before?: number;
  policy?: {
    hours_full_refund: number;
    hours_partial_refund: number;
    partial_pct: number;
    source?: string;
  };
}

export interface CancelResult {
  ok: boolean;
  already_cancelled?: boolean;
  reservation: BookingReservation;
  refund?: CancelRefund;
}

export interface RescheduleResult {
  ok: boolean;
  unchanged?: boolean;
  reservation: BookingReservation;
  previous?: { starts_at: string; ends_at: string; facility_id: string };
}

export interface CreateBookingBody {
  facility_id: string;
  starts_at: string;
  ends_at: string;
  payment_method: PaymentMethod;
  booker_profile_id?: string;
  guest?: { phone: string; full_name: string; email?: string };
  rate_audience?: RateAudience;
  participants?: number;
  notes?: string;
  external_org_name?: string;
  amount_paid?: number;
}

// ─── Errores ──────────────────────────────────────────────────────────────────

export interface BookingErrorInfo {
  code: string | null;
  message: string;
  alternatives: BookingAlternative[];
  status?: number;
  /** Segundos de espera que pidió el servidor (Retry-After) en un 429. */
  retryAfterSeconds?: number;
}

export const MINOR_MESSAGE = 'Los menores no pueden reservar; pídele a tu acudiente.';

const ERROR_MESSAGES: Record<string, string> = {
  SLOT_TAKEN: 'Esa franja acaba de ser tomada por otra reserva. Elige una de las alternativas o busca otro horario.',
  IDEMPOTENCY_KEY_REUSED: 'Esta solicitud ya se había enviado con otros datos. Vuelve a abrir el resumen e inténtalo de nuevo.',
  INVALID_STATE: 'La reserva ya no está en un estado que permita este cambio.',
  ALREADY_STARTED: 'La reserva ya empezó; ya no se puede cambiar ni cancelar.',
  CANCELLATION_WINDOW_CLOSED: 'Ya pasó el plazo para cancelar esta reserva por tu cuenta. Comunícate con la escuela.',
  RESCHEDULE_WINDOW_CLOSED: 'Ya pasó el plazo para reprogramar sin costo. Comunícate con la escuela.',
  FACILITY_BLOCKED: 'La instalación está bloqueada en ese horario (mantenimiento u otro motivo).',
  FORBIDDEN: 'No tienes permiso para hacer esto.',
  STAFF_ONLY_FIELD: 'Esa opción solo está disponible para el equipo de la escuela.',
  CHANNEL_NOT_ALLOWED: 'Este canal de reserva no está permitido.',
  AUDIENCE_NOT_ALLOWED: 'Esta instalación no recibe reservas de tu tipo de usuario (por ejemplo, es solo para miembros de la escuela).',
  MINOR_CANNOT_BOOK: MINOR_MESSAGE,
  GUEST_NOT_VERIFIED: 'Falta verificar el teléfono del invitado.',
  ENTITLEMENT_REQUIRED: 'El plan de la escuela no incluye reservas de canchas.',
  PAYMENT_REQUIRED: 'Esta reserva requiere pago en línea o por transferencia.',
  FACILITY_NOT_FOUND: 'No encontramos esa instalación.',
  RESERVATION_NOT_FOUND: 'No encontramos esa reserva.',
  GUEST_NOT_FOUND: 'No encontramos al invitado.',
  FACILITY_NOT_BOOKABLE: 'Esta instalación no recibe reservas por ahora.',
  INVALID_ARGUMENT: 'Faltan datos o son inválidos. Revisa el formulario.',
  INVALID_AMOUNT: 'El monto no es válido.',
  INVALID_RANGE: 'El rango de horas no es válido.',
  INVALID_DURATION: 'La duración no es válida para esta instalación.',
  DURATION_TOO_SHORT: 'La duración es menor que el mínimo de esta instalación.',
  DURATION_MISMATCH: 'Para reprogramar debes conservar la misma duración.',
  CROSSES_MIDNIGHT: 'La reserva no puede cruzar la medianoche.',
  SLOT_NOT_ALIGNED: 'El horario no encaja con la grilla de la instalación.',
  OUTSIDE_HOURS: 'Ese horario está fuera del horario de atención de la instalación.',
  TOO_SOON: 'Esa franja ya no tiene la anticipación mínima para reservarse.',
  TOO_FAR: 'Todavía no se puede reservar tan adelante.',
  IN_THE_PAST: 'Ese horario ya pasó.',
  GUEST_REQUIRED: 'Indica el teléfono y el nombre de la persona.',
  PAYMENT_METHOD_NOT_ALLOWED: 'Esa forma de pago no está permitida para esta reserva.',
  RANGE_TOO_LARGE: 'El rango de fechas es demasiado grande.',
  IDEMPOTENCY_KEY_REQUIRED: 'Falta la llave de la solicitud. Vuelve a intentarlo.',
};

const GENERIC_ERROR = 'No se pudo completar la operación. Inténtalo de nuevo.';

/** Mensaje de espera para un 429; respeta Retry-After si el servidor lo mandó. */
export function rateLimitMessage(retryAfterSeconds?: number): string {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    const t = retryAfterSeconds < 60
      ? `${Math.ceil(retryAfterSeconds)} segundos`
      : `${Math.ceil(retryAfterSeconds / 60)} ${Math.ceil(retryAfterSeconds / 60) === 1 ? 'minuto' : 'minutos'}`;
    return `Hiciste muchos intentos seguidos. Espera ${t} e inténtalo de nuevo.`;
  }
  return 'Hiciste muchos intentos seguidos. Espera un momento e inténtalo de nuevo.';
}

/** Texto amable por estado HTTP para errores de seguridad, sin detalles técnicos del servidor. */
function statusMessage(status: number | undefined, retryAfterSeconds?: number): string | null {
  switch (status) {
    case 401: return 'Tu sesión expiró. Vuelve a iniciar sesión para continuar.';
    case 403: return 'No tienes permiso para hacer esto.';
    case 404: return 'No encontramos lo que buscas. Puede que ya no exista.';
    case 429: return rateLimitMessage(retryAfterSeconds);
    default: return null;
  }
}

/**
 * Normaliza el error del BFF ({error:<CODIGO>, message, alternatives?}).
 * bffClient pone `body.error` como `message` del Error, así que el código sale de
 * `body.error` o, si no hay cuerpo, de un `message` que ya sea un código.
 */
export function parseBookingError(err: any): BookingErrorInfo {
  const body = err?.body && typeof err.body === 'object' ? err.body : null;
  // Forma real del BFF (translateRpcError): { error: <texto>, code: 'SLOT_TAKEN', reason, alternatives }.
  // Se acepta también { error: <CODIGO> } por compatibilidad.
  const esCodigo = (v: unknown): v is string => typeof v === 'string' && /^[A-Z][A-Z0-9_]+$/.test(v);
  const rawCode = [body?.code, body?.error, err?.message].find(esCodigo);
  const code = rawCode ?? null;
  const alternatives: BookingAlternative[] = Array.isArray(body?.alternatives) ? body.alternatives : [];
  const ra = Number(err?.retryAfterSeconds);
  const retryAfterSeconds = Number.isFinite(ra) && ra > 0 ? ra : undefined;

  let message: string;
  if (code && ERROR_MESSAGES[code]) {
    message = ERROR_MESSAGES[code];
  } else if (code === 'RATE_LIMITED' || err?.status === 429) {
    message = rateLimitMessage(retryAfterSeconds);
  } else if (!code && statusMessage(err?.status)) {
    // 401/403/404 sin código conocido: texto fijo, nunca el detalle del servidor.
    message = statusMessage(err?.status)!;
  } else if (typeof body?.message === 'string' && body.message.trim()) {
    message = body.message;
  } else if (typeof body?.error === 'string' && body.error.trim() && !esCodigo(body.error)) {
    message = body.error;
  } else if (code) {
    message = GENERIC_ERROR;
  } else if (typeof err?.message === 'string' && err.message && !/^Error \d{3}$/.test(err.message)) {
    message = err.message;
  } else {
    message = GENERIC_ERROR;
  }
  return { code, message, alternatives, status: err?.status, retryAfterSeconds };
}

// ─── Llave de idempotencia ────────────────────────────────────────────────────

export function newIdempotencyKey(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  // Respaldo (navegadores viejos): 32 hex aleatorios, dentro del rango 8..128 del contrato.
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * Sostiene UNA llave por resumen. `forSummary(firma)` devuelve la misma llave mientras
 * la firma (instalación + rango + forma de pago + reservante…) no cambie; así el doble
 * tap y los reintentos tras un fallo de red reusan la llave y el servidor responde con
 * `idempotent_replay`. Si cambian los datos, nace otra llave (si no, el servidor
 * respondería IDEMPOTENCY_KEY_REUSED). `reset()` tras éxito.
 */
export function createIdempotencyHolder(generate: () => string = newIdempotencyKey) {
  let key: string | null = null;
  let signature: string | null = null;
  return {
    forSummary(sig: string): string {
      if (key === null || signature !== sig) {
        key = generate();
        signature = sig;
      }
      return key;
    },
    reset() {
      key = null;
      signature = null;
    },
    peek: () => key,
  };
}

export function bookingSignature(body: CreateBookingBody): string {
  return JSON.stringify([
    body.facility_id, body.starts_at, body.ends_at, body.payment_method,
    body.booker_profile_id ?? null, body.guest?.phone ?? null, body.guest?.full_name ?? null,
    body.rate_audience ?? null, body.amount_paid ?? 0, body.participants ?? 1,
    body.notes ?? '', body.external_org_name ?? '',
  ]);
}

// ─── Franjas ──────────────────────────────────────────────────────────────────

export function findFacilityAvailability(
  av: AvailabilityResponse | null | undefined,
  facilityId: string,
): AvailabilityFacility | null {
  return av?.facilities?.find((f) => f.facility_id === facilityId) ?? null;
}

/** Franjas libres de una instalación en un día ('yyyy-MM-dd' de Bogotá), ordenadas por hora. */
export function pickDaySlots(
  av: AvailabilityResponse | null | undefined,
  facilityId: string,
  date: string,
): AvailabilitySlot[] {
  const fac = findFacilityAvailability(av, facilityId);
  const day = fac?.days?.find((d) => d.date === date);
  if (!day) return [];
  return [...day.slots].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

/** Descarta franjas que ya empezaron (la disponibilidad se cachea unos minutos). */
export function dropStartedSlots(slots: AvailabilitySlot[], now: Date = new Date()): AvailabilitySlot[] {
  return slots.filter((s) => new Date(s.starts_at).getTime() > now.getTime());
}

/** Duraciones ofrecibles: múltiplos del paso, desde el mínimo hasta 4 h (máx. 8 opciones). */
export function durationOptions(fac: Pick<AvailabilityFacility, 'slot_step_min' | 'min_duration_min'> | null): number[] {
  if (!fac) return [];
  const step = Math.max(fac.slot_step_min || 30, 5);
  const min = Math.max(fac.min_duration_min || step, step);
  const inc = Math.max(step, 30);
  const out: number[] = [];
  for (let d = min; d <= 240 && out.length < 8; d += inc) {
    // debe ser múltiplo del paso
    if (d % step === 0) out.push(d);
  }
  return out.length ? out : [min];
}

export function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h} ${h === 1 ? 'hora' : 'horas'}`;
  return `${h} h ${m} min`;
}

export function formatCOP(n: number): string {
  return `$${Math.round(n).toLocaleString('es-CO')} COP`;
}

export function slotFromAlternative(a: BookingAlternative, deposit_min = 0): AvailabilitySlot {
  return {
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    start_local: a.start_local,
    end_local: a.end_local,
    price: a.price,
    deposit_min,
  };
}

// ─── Hold (cuenta regresiva) ──────────────────────────────────────────────────

export function secondsLeft(holdExpiresAt: string | null | undefined, now: number = Date.now()): number {
  if (!holdExpiresAt) return 0;
  const t = new Date(holdExpiresAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Política de cancelación ──────────────────────────────────────────────────

export interface CancellationPolicy {
  hours_full_refund: number;
  hours_partial_refund: number;
  partial_pct: number;
}

/** Sin fila: 24 h / 6 h / 50 % (decisión D10 del contrato). */
export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
  hours_full_refund: 24,
  hours_partial_refund: 6,
  partial_pct: 50,
};

export function describeCancellationPolicy(p: CancellationPolicy = DEFAULT_CANCELLATION_POLICY): string {
  return (
    `Cancelación: devolución del 100 % si cancelas con ${p.hours_full_refund} h o más de anticipación; ` +
    `${p.partial_pct} % si es con ${p.hours_partial_refund} h o más; ` +
    `después de eso no hay devolución.`
  );
}

/** Texto de la devolución calculada por el servidor tras cancelar. */
export function describeRefund(refund: CancelRefund | undefined | null): string {
  if (!refund) return '';
  if (!refund.amount || refund.amount <= 0 || refund.status === 'none') {
    return 'No hay devolución para esta cancelación.';
  }
  return `Devolución: ${refund.pct} % (${formatCOP(refund.amount)}). Queda pendiente de registrar por la escuela.`;
}

// ─── Llamadas al BFF ──────────────────────────────────────────────────────────

export function fetchAvailability(p: AvailabilityParams): Promise<AvailabilityResponse> {
  const q = new URLSearchParams({ school_id: p.school_id, from: p.from, to: p.to });
  if (p.facility_id) q.set('facility_id', p.facility_id);
  if (p.sport) q.set('sport', p.sport);
  if (p.duration_min) q.set('duration_min', String(p.duration_min));
  if (p.audience) q.set('audience', p.audience);
  return bffClient.get<AvailabilityResponse>(`/api/v1/reservations/availability?${q.toString()}`);
}

export function createBooking(body: CreateBookingBody, idempotencyKey: string): Promise<BookingResult> {
  return bffClient.post<BookingResult>('/api/v1/reservations', body, { 'Idempotency-Key': idempotencyKey });
}

export function cancelBooking(id: string, reason?: string): Promise<CancelResult> {
  return bffClient.post<CancelResult>(`/api/v1/reservations/${id}/cancel`, reason ? { reason } : {});
}

export function rescheduleBooking(
  id: string,
  body: { starts_at: string; ends_at: string; facility_id?: string },
): Promise<RescheduleResult> {
  return bffClient.post<RescheduleResult>(`/api/v1/reservations/${id}/reschedule`, body);
}

export interface CheckoutResult {
  checkout_url?: string;
  url?: string;
  payment_url?: string;
  message?: string;
  instructions?: string;
  [k: string]: unknown;
}

/** Ruta que construye otro agente: POST /api/v1/reservations/:id/checkout. */
export function startCheckout(id: string): Promise<CheckoutResult> {
  return bffClient.post<CheckoutResult>(`/api/v1/reservations/${id}/checkout`, {});
}

export function checkoutUrlOf(r: CheckoutResult | null | undefined): string | null {
  const u = r?.checkout_url ?? r?.url ?? r?.payment_url;
  return safeRedirectUrl(u);
}

/** Mensaje amable si el checkout todavía no responde (ruta en construcción o pasarela caída). */
export function checkoutErrorMessage(err: any): string {
  const info = parseBookingError(err);
  if (info.code) return info.message;
  if (info.status === 404 || info.status === 501 || info.status === 502 || info.status === 503) {
    return 'El pago en línea todavía no está disponible. Inténtalo en unos minutos o coordina el pago con la escuela.';
  }
  return info.message === GENERIC_ERROR
    ? 'No pudimos iniciar el pago. Inténtalo de nuevo en unos minutos.'
    : info.message;
}

// ─── Bloqueos de instalación (BFF: /api/v1/reservations-admin/blackouts) ─────

export type BlackoutKind = 'maintenance' | 'weather' | 'closed' | 'other';

export const BLACKOUT_KIND_LABEL: Record<BlackoutKind, string> = {
  maintenance: 'Mantenimiento',
  weather: 'Clima',
  closed: 'Cerrado',
  other: 'Otro',
};

export interface Blackout {
  id: string;
  facility_id: string;
  starts_at: string;
  ends_at: string;
  kind: BlackoutKind | string;
  reason?: string | null;
}

export interface CreateBlackoutBody {
  facility_id: string;
  starts_at: string;
  ends_at: string;
  kind: BlackoutKind;
  reason?: string;
}

const BLACKOUT_BASE = '/api/v1/reservations-admin/blackouts';

/** Arma el cuerpo del bloqueo: motivo recortado a 200 y sin saltos de línea. */
export function buildBlackoutBody(p: {
  facility_id: string; starts_at: string; ends_at: string; kind?: BlackoutKind; reason?: string;
}): CreateBlackoutBody {
  const reason = (p.reason ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  return {
    facility_id: p.facility_id,
    starts_at: p.starts_at,
    ends_at: p.ends_at,
    kind: p.kind ?? 'other',
    ...(reason ? { reason } : {}),
  };
}

/** Mensaje amable para un error de bloqueos (409 = choca con una reserva vigente). */
export function blackoutErrorMessage(err: unknown): string {
  const info = parseBookingError(err);
  if (info.status === 409 && (info.message === GENERIC_ERROR || !ERROR_MESSAGES[info.code ?? ''])) {
    return 'Ya hay una reserva vigente en ese horario. Cancélala o reprográmala antes de bloquear la cancha.';
  }
  return info.message;
}

export function createBlackout(body: CreateBlackoutBody): Promise<Blackout> {
  return bffClient
    .post<Blackout | { blackout: Blackout }>(BLACKOUT_BASE, body)
    .then((r) => ((r as { blackout?: Blackout }).blackout ?? (r as Blackout)));
}

export function listBlackouts(p: { facility_id: string; from: string; to: string }): Promise<Blackout[]> {
  const q = new URLSearchParams({ facility_id: p.facility_id, from: p.from, to: p.to });
  return bffClient
    .get<Blackout[] | { blackouts?: Blackout[]; data?: Blackout[] }>(`${BLACKOUT_BASE}?${q.toString()}`)
    .then((r) => (Array.isArray(r) ? r : r?.blackouts ?? r?.data ?? []));
}

export function deleteBlackout(id: string): Promise<unknown> {
  return bffClient.delete<unknown>(`${BLACKOUT_BASE}/${encodeURIComponent(id)}`);
}

/** ¿Una fila de facility_reservations se maneja por las rutas nuevas? (tiene starts_at y no es clase de cortesía). */
export function usesNewReservationRoutes(r: { isSessionBooking?: boolean; starts_at?: string | null }): boolean {
  return !r.isSessionBooking && !!r.starts_at;
}
