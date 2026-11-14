/**
 * Transporte de la página pública en vivo: mensajes Broadcast del canal `tlive:<slug>` + polling de
 * respaldo. Lógica pura (probada en liveTransport.test.ts); el hook `usePublicLive` solo la conecta.
 *
 * Contrato del mensaje: bff/src/services/tournament/live-push.ts (`LivePushPayload`).
 */
import type { PublicLiveDto, PublicMatchDto, SetDto } from '@/lib/tournamentTypes';
import { refreshIntervalMs } from '@/lib/tournamentDisplay';

export const LIVE_TOPIC_PREFIX = 'tlive:';
export const LIVE_EVENT = 'match';
export const liveTopic = (slug: string) => `${LIVE_TOPIC_PREFIX}${slug}`;

export interface LivePushPayload {
  match_id: string;
  version: number;
  status: PublicMatchDto['status'];
  home_score: number | null;
  away_score: number | null;
  sets: SetDto[];
  started_at: string | null;
  finished_at: string | null;
  sent_at: string;
  /** El BFF lo marca al terminar / reabrir / corregir: la tabla cambió y su caché ya se descartó. */
  standings?: boolean;
}

export function isLivePushPayload(x: unknown): x is LivePushPayload {
  const p = x as LivePushPayload;
  return !!p && typeof p === 'object' && typeof p.match_id === 'string' && typeof p.version === 'number'
    && typeof p.status === 'string' && Array.isArray(p.sets) && typeof p.sent_at === 'string';
}

/** Último estado empujado de cada partido (version + hora del servidor). */
export type Overrides = Map<string, LivePushPayload>;

export type PushOutcome = 'applied' | 'stale' | 'unknown_match' | 'invalid';

/** Guarda el mensaje si es más nuevo que lo que ya teníamos de ese partido. */
export function acceptPush(overrides: Overrides, data: PublicLiveDto | null, raw: unknown): PushOutcome {
  if (!isLivePushPayload(raw)) return 'invalid';
  const prev = overrides.get(raw.match_id);
  if (prev && prev.version >= raw.version) return 'stale';
  overrides.set(raw.match_id, raw);
  if (data && !data.matches.some((m) => m.id === raw.match_id)) return 'unknown_match';
  return 'applied';
}

/**
 * Aplica los mensajes empujados sobre los datos del polling. Un mensaje gana solo si es POSTERIOR a
 * cuando el BFF armó ese payload (`server_time`); si el polling ya es más nuevo, se descarta el
 * mensaje (así una caché de 5 s nunca «devuelve» un marcador viejo, y lo viejo no pisa lo nuevo).
 */
export function mergeOverrides(data: PublicLiveDto, overrides: Overrides): PublicLiveDto {
  if (overrides.size === 0) return data;
  const polledAt = Date.parse(data.server_time);
  let changed = false;
  const matches = data.matches.map((m) => {
    const o = overrides.get(m.id);
    if (!o) return m;
    if (Number.isFinite(polledAt) && Date.parse(o.sent_at) <= polledAt) { overrides.delete(m.id); return m; }
    changed = true;
    return { ...m, status: o.status, home_score: o.home_score, away_score: o.away_score, sets: o.sets, started_at: o.started_at, finished_at: o.finished_at };
  });
  return changed ? { ...data, matches } : data;
}

/** Con push conectado el polling es solo red de seguridad: 3× más lento. */
export function pollIntervalMs(matches: Array<{ status: PublicMatchDto['status'] }>, pushConnected: boolean): number {
  const base = refreshIntervalMs(matches);
  return pushConnected ? Math.max(base * 3, 30_000) : base;
}

/** Refresco de la tabla cuando el BFF avisa (`standings`): entre 1,2 y 2,5 s después del mensaje. */
export const STANDINGS_REFETCH_MIN_MS = 1200;
export const STANDINGS_REFETCH_SPREAD_MS = 1300;

/**
 * Un partido que termina cambia la tabla y la llave (que no viajan en el mensaje): se pide el payload
 * completo con espera aleatoria, para que cien celulares no pidan en el mismo milisegundo (el BFF además
 * junta las lecturas simultáneas en una).
 *   · Mensaje con `standings` (BFF nuevo): su caché ya se descartó → 1,2–2,5 s (deja terminar el avance de
 *     llaves, que va justo después del mensaje).
 *   · Sin la marca (BFF anterior) o partido desconocido: esperar a que venza la caché de 5 s → 6–10 s.
 */
export function refetchDelayMs(outcome: PushOutcome, payload: LivePushPayload | null, rnd: () => number = Math.random): number | null {
  if (outcome === 'unknown_match') return 6000 + Math.floor(rnd() * 4000);
  if (outcome !== 'applied' || !payload) return null;
  if (payload.standings === true) return STANDINGS_REFETCH_MIN_MS + Math.floor(rnd() * STANDINGS_REFETCH_SPREAD_MS);
  if (payload.status === 'played' || payload.status === 'walkover') return 6000 + Math.floor(rnd() * 4000);
  return null;
}

/**
 * Ruta del payload público. Con `bust` se agrega `?v=` para saltar la caché HTTP del navegador
 * (`max-age=5`): sin eso el refresco pedido por el mensaje podría devolver la copia del último polling.
 * El BFF ignora el parámetro; su caché de 5 s + ETag sigue igual.
 */
export function publicLivePath(slug: string, bust?: string | number | null): string {
  const base = `/api/v1/tournament-live/public/${encodeURIComponent(slug)}/live`;
  return bust == null ? base : `${base}?v=${encodeURIComponent(String(bust))}`;
}
