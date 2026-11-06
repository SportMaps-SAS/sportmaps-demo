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
  constructor(status: number, body: Record<string, unknown>) {
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
    this.view = mapApiError({ status, code, message: message || undefined });
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
    throw new ReservaApiError(res.status || 400, body);
  }
  return body as T;
}

export const publicUrl = (path: string) => `${PUBLIC_BASE}${path}`;
