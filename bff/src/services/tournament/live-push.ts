/**
 * Torneos en vivo — tiempo real (F4). Tras cada acción aplicada por `apply_tournament_match_action`
 * el BFF emite UN mensaje Broadcast al canal privado `tlive:<slug>` de Supabase Realtime con el
 * estado mínimo del partido. Los espectadores no consultan la base por punto: aplican el mensaje.
 *
 *   · Canal PRIVADO: el cliente solo puede leer (policy `tlive_broadcast_lectura`, migración
 *     20261027180907). Nadie desde el navegador puede inyectar un marcador falso.
 *   · Sin tormentas: por partido se manda como mucho un mensaje cada `minIntervalMs` (el último
 *     estado gana) y por canal como mucho `maxPerWindow` por segundo. Lo demás se agrupa.
 *   · Best-effort: si Realtime falla, la página sigue con el polling de respaldo.
 *   · Interruptor: TOURNAMENT_LIVE_PUSH_DISABLED=true apaga el envío sin desplegar.
 */
// Lee el env directo (no importa config/supabase): así las pruebas que simulan la base no lo arrastran.

export const LIVE_TOPIC_PREFIX = 'tlive:';
export const LIVE_EVENT = 'match';

export const topicFor = (slug: string) => `${LIVE_TOPIC_PREFIX}${slug}`;

export interface LiveSet { home: number; away: number; closed: boolean; deciding?: boolean }

/** Payload mínimo: lo justo para pintar la tarjeta del partido (sin nombres de nadie). */
export interface LivePushPayload {
  match_id: string;
  version: number;
  status: string;
  home_score: number | null;
  away_score: number | null;
  sets: LiveSet[];
  started_at: string | null;
  finished_at: string | null;
  /** Hora del servidor al armar el mensaje: el cliente la compara con `server_time` del polling. */
  sent_at: string;
  /**
   * true cuando la acción cambia la tabla o la llave (terminar, reabrir, corregir un partido terminado).
   * El BFF ya descartó su caché pública de ese torneo: el cliente puede pedir el payload completo enseguida.
   */
  standings?: boolean;
}

export interface MatchLike {
  id: string; version?: number | null; status: string;
  home_score: number | null; away_score: number | null;
  sets?: LiveSet[] | null; started_at?: string | null; finished_at?: string | null;
}

export function buildLivePayload(m: MatchLike, now: Date = new Date(), extra: { standings?: boolean } = {}): LivePushPayload {
  return {
    match_id: m.id,
    version: Number(m.version ?? 0),
    status: m.status,
    home_score: m.home_score ?? null,
    away_score: m.away_score ?? null,
    sets: (m.sets ?? []).map((s) => ({ home: s.home, away: s.away, closed: !!s.closed, ...(s.deciding ? { deciding: true } : {}) })),
    started_at: m.started_at ?? null,
    finished_at: m.finished_at ?? null,
    sent_at: now.toISOString(),
    ...(extra.standings ? { standings: true } : {}),
  };
}

export interface BroadcastMessage { topic: string; event: string; payload: LivePushPayload }
export type BroadcastSender = (messages: BroadcastMessage[]) => Promise<void>;

/** Envío por la API REST de Realtime (no abre sockets desde el BFF). */
export function httpBroadcastSender(
  url = process.env.SUPABASE_URL || '', key = process.env.SUPABASE_SERVICE_ROLE_KEY || '', timeoutMs = 3000,
): BroadcastSender {
  return async (messages) => {
    if (messages.length === 0 || !url || !key) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${url.replace(/\/$/, '')}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
        body: JSON.stringify({ messages: messages.map((m) => ({ ...m, private: true })) }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`realtime ${r.status}`);
    } finally { clearTimeout(t); }
  };
}

export interface BroadcasterOptions {
  send: BroadcastSender;
  /** Mínimo entre dos mensajes del mismo partido (ms). */
  minIntervalMs?: number;
  /** Tope de mensajes por canal en una ventana de `windowMs`. */
  maxPerWindow?: number;
  windowMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  onError?: (e: unknown) => void;
}

export interface BroadcasterStats { published: number; sent: number; coalesced: number; failed: number }

/**
 * Agrupador por partido / canal. `publish` nunca lanza ni espera la red.
 * Garantías (probadas en live-push.test.ts):
 *   - una acción aislada = un mensaje, inmediato;
 *   - N acciones seguidas del mismo partido dentro de `minIntervalMs` = 1 inmediato + 1 diferido con el ÚLTIMO estado;
 *   - nunca se manda una versión menor que la última enviada de ese partido;
 *   - por canal nunca más de `maxPerWindow` mensajes por ventana.
 */
export class LiveBroadcaster {
  private readonly o: Required<Omit<BroadcasterOptions, 'onError'>> & { onError?: (e: unknown) => void };
  private lastSentAt = new Map<string, number>();
  private lastVersion = new Map<string, number>();
  private pending = new Map<string, BroadcastMessage>();
  private timers = new Set<string>();
  private windows = new Map<string, { start: number; count: number }>();
  readonly stats: BroadcasterStats = { published: 0, sent: 0, coalesced: 0, failed: 0 };

  constructor(opts: BroadcasterOptions) {
    this.o = {
      minIntervalMs: 300, maxPerWindow: 10, windowMs: 1000,
      now: () => Date.now(), setTimer: (fn, ms) => { const t = setTimeout(fn, ms); (t as any).unref?.(); return t; },
      ...opts,
    };
  }

  publish(topic: string, payload: LivePushPayload): void {
    this.stats.published++;
    const key = `${topic}|${payload.match_id}`;
    const last = this.lastVersion.get(key);
    if (last != null && payload.version < last) { this.stats.coalesced++; return; }
    const msg: BroadcastMessage = { topic, event: LIVE_EVENT, payload };
    if (this.pending.has(key)) { this.stats.coalesced++; this.pending.set(key, msg); return; }
    const wait = this.waitFor(key, topic);
    if (wait <= 0) { this.emit(key, msg); return; }
    this.pending.set(key, msg);
    this.schedule(key, topic, wait);
  }

  private waitFor(key: string, topic: string): number {
    const now = this.o.now();
    const since = now - (this.lastSentAt.get(key) ?? -Infinity);
    const byMatch = since >= this.o.minIntervalMs ? 0 : this.o.minIntervalMs - since;
    const w = this.windows.get(topic);
    const byTopic = w && now - w.start < this.o.windowMs && w.count >= this.o.maxPerWindow ? this.o.windowMs - (now - w.start) : 0;
    return Math.max(byMatch, byTopic);
  }

  private schedule(key: string, topic: string, ms: number) {
    if (this.timers.has(key)) return;
    this.timers.add(key);
    this.o.setTimer(() => {
      this.timers.delete(key);
      const msg = this.pending.get(key);
      if (!msg) return;
      const wait = this.waitFor(key, topic);
      if (wait > 0) { this.schedule(key, topic, wait); return; }
      this.pending.delete(key);
      this.emit(key, msg);
    }, ms);
  }

  private emit(key: string, msg: BroadcastMessage) {
    const now = this.o.now();
    this.lastSentAt.set(key, now);
    this.lastVersion.set(key, msg.payload.version);
    const w = this.windows.get(msg.topic);
    if (!w || now - w.start >= this.o.windowMs) this.windows.set(msg.topic, { start: now, count: 1 });
    else w.count++;
    this.stats.sent++;
    // Memoria acotada: un torneo tiene cientos de partidos, no millones.
    if (this.lastSentAt.size > 5000) { this.lastSentAt.clear(); this.lastVersion.clear(); this.windows.clear(); }
    this.o.send([msg]).catch((e) => { this.stats.failed++; this.o.onError?.(e); });
  }
}

export const livePushDisabled = () => process.env.TOURNAMENT_LIVE_PUSH_DISABLED === 'true';

let shared: LiveBroadcaster | null = null;
export function liveBroadcaster(): LiveBroadcaster {
  if (!shared) {
    shared = new LiveBroadcaster({
      send: httpBroadcastSender(),
      onError: (e) => console.warn('[tournament-live] broadcast falló (queda el polling):', (e as Error)?.message),
    });
  }
  return shared;
}

/** Punto único que llama el servicio tras aplicar una acción (no duplicada). */
export function pushMatchUpdate(
  slug: string | null | undefined, match: MatchLike, b: Pick<LiveBroadcaster, 'publish'> = liveBroadcaster(), extra: { standings?: boolean } = {},
): boolean {
  if (!slug || livePushDisabled()) return false;
  b.publish(topicFor(slug), buildLivePayload(match, new Date(), extra));
  return true;
}
