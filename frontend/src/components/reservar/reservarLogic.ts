// Lógica pura de las páginas públicas de reserva de canchas (/reservar/:slug y /r/:token).
// Sin React ni red: todo lo que se puede probar con vitest vive aquí.

export const BOGOTA_TZ = 'America/Bogota';

// ── Tipos del contrato (docs/specs/reservas-canchas-f1-contrato.md) ──────────

export interface Slot {
  starts_at: string;
  ends_at: string;
  start_local: string;
  end_local: string;
  price: number;
  deposit_min: number;
}

export interface AvailDay {
  date: string; // YYYY-MM-DD (Bogotá)
  weekday: number;
  is_holiday: boolean;
  slots: Slot[];
}

export interface AvailFacility {
  facility_id: string;
  name: string;
  type: string;
  capacity?: number;
  audience?: string;
  slot_step_min: number;
  min_duration_min: number;
  duration_min: number;
  min_deposit_pct: number;
  days: AvailDay[];
}

export interface Alternative {
  facility_id: string;
  starts_at: string;
  ends_at: string;
  start_local: string;
  end_local: string;
  price: number;
}

export interface CancellationPolicy {
  hours_full_refund: number;
  hours_partial_refund: number;
  partial_pct: number;
  /** 'default' = texto por defecto del front (el BFF no la entregó). */
  source?: 'default' | 'school' | 'facility';
}

export const DEFAULT_POLICY: CancellationPolicy = {
  hours_full_refund: 24,
  hours_partial_refund: 6,
  partial_pct: 50,
  source: 'default',
};

// ── Dinero y fechas (siempre hora de Bogotá) ─────────────────────────────────

export function formatCOP(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(v);
}

function parts(iso: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('es-CO', { timeZone: BOGOTA_TZ, ...opts });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(iso))) out[p.type] = p.value;
  return out;
}

/** '17:00' -> '5:00 p. m.' */
export function formatHM(hhmm: string): string {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** Instante UTC -> 'HH:mm' en Bogotá. */
export function bogotaHHmm(iso: string): string {
  const p = parts(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${p.hour}:${p.minute}`;
}

/** Instante UTC -> 'YYYY-MM-DD' en Bogotá. */
export function bogotaDateKey(iso: string | Date): string {
  const d = typeof iso === 'string' ? iso : iso.toISOString();
  const p = parts(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

/** Rango legible: '5:00 p. m. – 6:00 p. m.' (Bogotá). */
export function formatRange(startIso: string, endIso: string): string {
  return `${formatHM(bogotaHHmm(startIso))} – ${formatHM(bogotaHHmm(endIso))}`;
}

/** 'YYYY-MM-DD' -> 'viernes 6 de noviembre' */
export function formatDayLong(dateKey: string): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

/** 'YYYY-MM-DD' -> { dow: 'vie', day: '6', month: 'nov' } */
export function dayChipParts(dateKey: string): { dow: string; day: string; month: string } {
  const p = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', ...o }).format(new Date(`${dateKey}T12:00:00Z`));
  return {
    dow: p({ weekday: 'short' }).replace('.', ''),
    day: p({ day: 'numeric' }),
    month: p({ month: 'short' }).replace('.', ''),
  };
}

/** Fecha y hora de un instante: 'mar 10 nov, 6:00 p. m.' (Bogotá). */
export function formatDateTimeBogota(iso: string): string {
  const d = new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
  return `${d.replace(/\./g, '')}, ${formatHM(bogotaHHmm(iso))}`;
}

/** Hoy y los siguientes (n-1) días en Bogotá, como YYYY-MM-DD. */
export function rangeFromToday(n: number, now: Date = new Date()): { from: string; to: string } {
  const from = bogotaDateKey(now);
  const base = new Date(`${from}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + Math.max(0, n - 1));
  return { from, to: base.toISOString().slice(0, 10) };
}

/** 'mm:ss' para la cuenta regresiva del apartado. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function msUntil(iso: string | null | undefined, now: number = Date.now()): number {
  if (!iso) return 0;
  return new Date(iso).getTime() - now;
}

// ── Duraciones ───────────────────────────────────────────────────────────────

/** Opciones de duración: múltiplos del paso, desde el mínimo, hasta 3 horas (máx. 4 opciones). */
export function durationOptions(minMin: number, stepMin: number, maxMin = 180): number[] {
  const min = Math.max(5, minMin || 60);
  const step = Math.max(5, stepMin || 30);
  const out: number[] = [];
  // Prioriza saltos de 30 min si el paso lo permite; si no, usa el paso.
  const inc = step <= 30 && 30 % step === 0 ? 30 : step;
  for (let d = min; d <= Math.max(maxMin, min) && out.length < 4; d += inc) {
    if (d % step === 0) out.push(d);
  }
  return out;
}

export function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ── Llave de idempotencia por resumen ────────────────────────────────────────

export interface IdemStore {
  signature: string | null;
  key: string | null;
}

export function newIdemStore(): IdemStore {
  return { signature: null, key: null };
}

export function genUuid(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function summarySignature(s: {
  facilityId: string;
  startsAt: string;
  endsAt: string;
  paymentMethod: string;
}): string {
  return [s.facilityId, s.startsAt, s.endsAt, s.paymentMethod].join('|');
}

/**
 * Devuelve la MISMA llave mientras el resumen (cancha + franja + método) no cambie;
 * si cambia, genera una nueva. Doble tap o reintento tras un error de red = misma reserva.
 */
export function idempotencyKeyFor(store: IdemStore, signature: string, gen: () => string = genUuid): string {
  if (store.key && store.signature === signature) return store.key;
  store.signature = signature;
  store.key = gen();
  return store.key;
}

// ── Política de cancelación ──────────────────────────────────────────────────

export function normalizePolicy(raw: unknown): CancellationPolicy {
  const r = (raw ?? null) as Partial<CancellationPolicy> | null;
  if (
    r &&
    Number.isFinite(Number(r.hours_full_refund)) &&
    Number.isFinite(Number(r.hours_partial_refund)) &&
    Number.isFinite(Number(r.partial_pct))
  ) {
    return {
      hours_full_refund: Number(r.hours_full_refund),
      hours_partial_refund: Number(r.hours_partial_refund),
      partial_pct: Number(r.partial_pct),
      source: r.source ?? 'school',
    };
  }
  return DEFAULT_POLICY;
}

export function policyLines(p: CancellationPolicy): string[] {
  return [
    `100 % de devolución hasta ${p.hours_full_refund} h antes.`,
    `${p.partial_pct} % de devolución hasta ${p.hours_partial_refund} h antes.`,
    '0 % después.',
  ];
}

/** Una línea con la hora exacta: 'Gratis hasta el mar 10 nov, 6:00 p. m.; ...'. */
export function policyOneLiner(p: CancellationPolicy, startsAtIso: string): string {
  const full = new Date(new Date(startsAtIso).getTime() - p.hours_full_refund * 3600_000).toISOString();
  const partial = new Date(new Date(startsAtIso).getTime() - p.hours_partial_refund * 3600_000).toISOString();
  return `Devolución total hasta el ${formatDateTimeBogota(full)}; ${p.partial_pct} % hasta el ${formatDateTimeBogota(partial)}; después no hay devolución.`;
}

export interface RefundEstimate {
  pct: number;
  amount: number;
  hoursBefore: number;
}

/** Misma regla que cancelar_reserva (contrato §4). Es una estimación: manda el servidor. */
export function computeRefund(
  policy: CancellationPolicy,
  amountPaid: number,
  startsAtIso: string,
  now: number = Date.now(),
): RefundEstimate {
  const hoursBefore = (new Date(startsAtIso).getTime() - now) / 3600_000;
  let pct = 0;
  if (hoursBefore >= policy.hours_full_refund) pct = 100;
  else if (hoursBefore >= policy.hours_partial_refund) pct = policy.partial_pct;
  return { pct, amount: Math.round((Math.max(0, amountPaid) * pct) / 100), hoursBefore };
}

// ── Errores ──────────────────────────────────────────────────────────────────

const ERROR_TEXT: Record<string, string> = {
  SLOT_TAKEN: 'Esa hora acaba de ocuparse. Mira las alternativas o elige otra franja.',
  IDEMPOTENCY_KEY_REUSED: 'Ya hay una reserva en curso con otros datos. Vuelve a abrir el resumen.',
  INVALID_STATE: 'Esta reserva ya no se puede modificar.',
  ALREADY_STARTED: 'La reserva ya empezó, así que no se puede cambiar.',
  CANCELLATION_WINDOW_CLOSED: 'Ya pasó el plazo para cancelar por este medio. Escríbele al club.',
  RESCHEDULE_WINDOW_CLOSED: 'Ya pasó el plazo para reprogramar. Escríbele al club.',
  FACILITY_BLOCKED: 'La cancha está cerrada en ese horario (mantenimiento o evento).',
  FORBIDDEN: 'No tienes permiso para hacer esto.',
  CHANNEL_NOT_ALLOWED: 'Este canal no permite esa acción.',
  AUDIENCE_NOT_ALLOWED: 'Esta cancha solo recibe reservas de socios del club.',
  MINOR_CANNOT_BOOK: 'Las reservas las debe hacer una persona mayor de edad o un acudiente.',
  GUEST_NOT_VERIFIED: 'Primero verifica tu número con el código.',
  ENTITLEMENT_REQUIRED: 'Este club aún no tiene activas las reservas en línea.',
  PAYMENT_REQUIRED: 'Esta reserva requiere pago en línea o por transferencia.',
  FACILITY_NOT_FOUND: 'No encontramos esa cancha.',
  RESERVATION_NOT_FOUND: 'No encontramos esa reserva. Revisa el enlace.',
  GUEST_NOT_FOUND: 'No encontramos tus datos. Vuelve a empezar.',
  FACILITY_NOT_BOOKABLE: 'Esta cancha no recibe reservas por ahora.',
  INVALID_DURATION: 'Esa duración no está disponible para esta cancha.',
  DURATION_MISMATCH: 'Para reprogramar la duración debe ser la misma de tu reserva.',
  DURATION_TOO_SHORT: 'La duración es menor a la mínima de esta cancha.',
  CROSSES_MIDNIGHT: 'La reserva no puede cruzar la medianoche.',
  SLOT_NOT_ALIGNED: 'Esa hora no está disponible. Elige una de la lista.',
  OUTSIDE_HOURS: 'Ese horario está fuera de la atención de la cancha.',
  TOO_SOON: 'Ese horario es muy próximo; se necesita más anticipación.',
  TOO_FAR: 'Todavía no se puede reservar con tanta anticipación.',
  IN_THE_PAST: 'Esa hora ya pasó.',
  INVALID_RANGE: 'El horario elegido no es válido.',
  INVALID_ARGUMENT: 'Faltan datos o alguno no es válido. Revísalos e intenta de nuevo.',
  RANGE_TOO_LARGE: 'El rango de fechas es muy grande.',
  RATE_LIMITED: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.',
  WRONG_CODE: 'El código no es correcto. Revísalo e intenta de nuevo.',
  CODE_EXPIRED: 'El código venció. Pide uno nuevo.',
  EXPIRED: 'El código venció. Pide uno nuevo.',
};

export interface ErrorView {
  code: string;
  message: string;
  /** El BFF/ruta aún no existe (404/501): mostrar 'Pronto'. */
  pending: boolean;
}

export function mapApiError(input: { status?: number; code?: string; message?: string; retryAfterSeconds?: number }, fallback = 'No pudimos completar la acción. Intenta de nuevo.'): ErrorView {
  const status = input.status ?? 0;
  const code = (input.code ?? '').toUpperCase();
  if (code && ERROR_TEXT[code]) return { code, message: ERROR_TEXT[code], pending: false };
  if (status === 501 || (status === 404 && !code)) {
    return { code: code || 'NOT_AVAILABLE', message: 'Esta función estará disponible pronto.', pending: true };
  }
  if (status === 429 || code === 'RATE_LIMITED') {
    const ra = input.retryAfterSeconds;
    const wait = ra && ra > 0
      ? ra < 60 ? `${Math.ceil(ra)} segundos` : `${Math.ceil(ra / 60)} ${Math.ceil(ra / 60) === 1 ? 'minuto' : 'minutos'}`
      : null;
    return {
      code: 'RATE_LIMITED',
      message: wait ? `Demasiados intentos. Espera ${wait} e intenta de nuevo.` : ERROR_TEXT.RATE_LIMITED,
      pending: false,
    };
  }
  // 401/403 sin código conocido: texto fijo, nunca el detalle técnico del servidor.
  if (status === 401) return { code: code || 'UNAUTHORIZED', message: 'Tu sesión expiró. Vuelve a iniciar sesión.', pending: false };
  if (status === 403) return { code: code || 'FORBIDDEN', message: ERROR_TEXT.FORBIDDEN, pending: false };
  if (status === 0) return { code: 'NETWORK', message: 'Sin conexión. Revisa tu internet e intenta de nuevo.', pending: false };
  return { code: code || 'ERROR', message: input.message || fallback, pending: false };
}

// ── Teléfono ─────────────────────────────────────────────────────────────────

/** Normaliza a E.164 para Colombia: '300 123 4567' -> '+573001234567'. null si no es válido. */
export function normalizeCoPhone(raw: string): string | null {
  const d = (raw || '').replace(/[^\d+]/g, '');
  if (/^\+\d{10,15}$/.test(d)) return d;
  const digits = d.replace(/\D/g, '');
  if (/^3\d{9}$/.test(digits)) return `+57${digits}`;
  if (/^573\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}

export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((s || '').trim());
}

// ── Estados de la reserva ────────────────────────────────────────────────────

export type StatusTone = 'ok' | 'wait' | 'bad' | 'info';

export function statusView(status: string, paymentStatus?: string | null): { label: string; tone: StatusTone; text: string } {
  switch (status) {
    case 'confirmed':
      return {
        label: paymentStatus === 'paid' ? 'Confirmada y pagada' : 'Confirmada',
        tone: 'ok',
        text: paymentStatus === 'paid' ? 'Tu reserva está confirmada y pagada.' : 'Tu reserva está confirmada. Si queda saldo, se paga en la sede.',
      };
    case 'hold':
    case 'pending_payment':
      return { label: 'Esperando el pago', tone: 'wait', text: 'Tu cancha está apartada por unos minutos mientras se confirma el pago.' };
    case 'pending':
      return { label: 'Pendiente de aprobación', tone: 'wait', text: 'El club debe aprobar tu solicitud. Te avisaremos por WhatsApp.' };
    case 'pending_reconciliation':
      return { label: 'En revisión', tone: 'info', text: 'Recibimos tu pago y el club lo está revisando. Te contactarán pronto.' };
    case 'cancelled':
      return { label: 'Cancelada', tone: 'bad', text: 'Esta reserva fue cancelada.' };
    case 'expired':
      return { label: 'Expirada', tone: 'bad', text: 'El tiempo para pagar terminó y la cancha se liberó. Puedes reservar de nuevo.' };
    case 'completed':
      return { label: 'Realizada', tone: 'info', text: 'Esta reserva ya se realizó.' };
    case 'no_show':
      return { label: 'No asististe', tone: 'bad', text: 'Esta reserva se marcó como no asistida.' };
    default:
      return { label: status || 'Desconocido', tone: 'info', text: '' };
  }
}

export const CANCELLABLE = ['hold', 'pending_payment', 'pending', 'confirmed', 'pending_reconciliation'];
export const RESCHEDULABLE = ['hold', 'pending_payment', 'pending', 'confirmed'];

// ── .ics (calendario) ────────────────────────────────────────────────────────

function icsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Texto libre (RFC 5545 §3.3.11): escapa \ ; , y convierte CR/LF/CRLF en \n; sin caracteres de control. */
export function icsEscape(s: string): string {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Campo de UNA línea (UID…): sin CR/LF, controles ni separadores, para no crear propiedades nuevas. */
export function icsToken(s: string): string {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029;:,"\\\s]/g, '');
}

export function buildIcs(e: {
  uid: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location?: string;
  description?: string;
}, now: Date = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SportMaps//Reservas//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsToken(e.uid) || 'reserva'}@sportmaps.co`,
    `DTSTAMP:${icsDate(now.toISOString())}`,
    `DTSTART:${icsDate(e.startsAt)}`,
    `DTEND:${icsDate(e.endsAt)}`,
    `SUMMARY:${icsEscape(e.title)}`,
  ];
  if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
  if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
  lines.push('BEGIN:VALARM', 'TRIGGER:-PT60M', 'ACTION:DISPLAY', 'DESCRIPTION:Tu reserva es en una hora', 'END:VALARM');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
