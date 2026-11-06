import { mapApiError, type Alternative, type ErrorView } from './reservarLogic';

const BFF_URL = import.meta.env.VITE_BFF_URL ?? '';
export const PUBLIC_BASE = `${BFF_URL}/api/v1/public/reservations`;
export const RESERVATIONS_BASE = `${BFF_URL}/api/v1/reservations`;

export class ReservaApiError extends Error {
  status: number;
  code: string;
  alternatives: Alternative[];
  view: ErrorView;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>, retryAfterSeconds?: number) {
    // Forma real del BFF: { error: <texto>, code: 'SLOT_TAKEN', ... } (también se acepta error=CODIGO).
    const esCodigo = (v: unknown): v is string => typeof v === 'string' && /^[A-Z][A-Z0-9_]+$/.test(v);
    const code = [body.code, body.error].find(esCodigo) ?? '';
    const message = typeof body.message === 'string'
      ? body.message
      : (typeof body.error === 'string' && !esCodigo(body.error) ? body.error : '');
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.body = body;
    this.alternatives = Array.isArray(body.alternatives) ? (body.alternatives as Alternative[]) : [];
    this.view = mapApiError({ status, code, message: message || undefined, retryAfterSeconds });
  }
}

export async function apiRequest<T = Record<string, unknown>>(
  url: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers ?? {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ReservaApiError(0, { error: 'NETWORK' });
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok === false) {
    const ra = Number(res.headers?.get?.('Retry-After'));
    throw new ReservaApiError(res.status || 400, body, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  return body as T;
}

export const publicUrl = (path: string) => `${PUBLIC_BASE}${path}`;

// ── Cabeceras de invitado (contrato del BFF) ───────────────────────────────────
// Nunca se usa Authorization con tokens de invitado: ese header es de la sesión de usuario.
//  · POST /public/reservations ........ X-Guest-Token = guest_token (de /guests/verify)
//  · POST /reservations/:id/checkout .. X-Reservation-Token = status_token (de la respuesta de POST /)
//  · /public/reservations/r/:token ... el token va en la ruta, sin cabecera de token.
export const guestHeaders = (guestToken: string): Record<string, string> => ({ 'X-Guest-Token': guestToken });
export const reservationHeaders = (statusToken: string): Record<string, string> => ({ 'X-Reservation-Token': statusToken });

export interface CreateReservationBody {
  facility_id: string;
  starts_at: string;
  ends_at: string;
  payment_method: string;
  participants?: number;
}

/** POST /api/v1/public/reservations → { reservation, requires_payment, status_token, status_path }. */
export function createGuestReservation<R = Record<string, unknown>>(guestToken: string, idemKey: string, body: CreateReservationBody) {
  return apiRequest<{ reservation: R; requires_payment?: boolean; status_token?: string; status_path?: string }>(publicUrl(''), {
    method: 'POST',
    headers: { 'Idempotency-Key': idemKey, ...guestHeaders(guestToken) },
    body,
  });
}

/** POST /api/v1/reservations/:id/checkout con el token de estado de ESA reserva. */
export function guestCheckout(reservationId: string, statusToken: string) {
  return apiRequest<{ checkout_url: string }>(`${RESERVATIONS_BASE}/${reservationId}/checkout`, {
    method: 'POST',
    headers: reservationHeaders(statusToken),
    body: {},
  });
}
