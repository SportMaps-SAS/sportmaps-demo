/**
 * Cola offline mínima del Partido en vivo (spec §8, decisión D-V3).
 *
 *  · Cada evento lleva su `client_event_id` (uuid) y su `period_second` ya calculados en el celular.
 *  · Vive en localStorage por partido (try/catch; sin storage funciona en memoria).
 *  · Envío por lote, EN ORDEN DE LLEGADA, a `apply_live_events` (idempotente por client_event_id: reenviar nunca duplica).
 *  · Un lote con un evento inválido se rechaza ENTERO en el servidor: se aísla al culpable, se muestra con su motivo
 *    (nunca se descarta en silencio) y el resto se reintenta.
 *  · Errores de red / sesión vencida: la cola se conserva y se reintenta. Errores «de bloqueo» (no eres director,
 *    partido terminado, flag apagado) frenan el envío SIN tocar los eventos.
 */
import type { WireEvent } from './liveMatchLogic';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface QueuedItem { event: WireEvent; label: string; queuedAt: number }
export interface RejectedItem extends QueuedItem { reason: string; code: string | null }

interface Snapshot { v: 1; items: QueuedItem[]; rejected: RejectedItem[]; anchors: Record<string, number> }

export const BATCH_SIZE = 50; // el servidor admite hasta 200

export const queueKey = (matchId: string) => `sportmaps:partido-vivo:cola:${matchId}`;

export type RpcErrorKind = 'network' | 'blocked' | 'event';

export interface ClassifiedError {
  kind: RpcErrorKind;
  /** Código de negocio (HINT de _live_raise) si lo hay: NOT_DIRECTOR, FUTURE_EVENT… */
  code: string | null;
  message: string;
  clientEventId: string | null;
  /** «Evento N» (1-based) en los errores de forma 22023 del lote. */
  index: number | null;
}

const BLOCKED_CODES = new Set(['NOT_DIRECTOR', 'LIVE_DISABLED', 'LIVE_FINISHED', 'LIVE_NOT_STARTED']);

interface RpcErrorLike { message?: string; code?: string; details?: string | null; hint?: string | null; status?: number }

export function classifyRpcError(err: unknown): ClassifiedError {
  const e = (err ?? {}) as RpcErrorLike;
  const message = String(e.message ?? 'Error desconocido');
  const sqlstate = String(e.code ?? '');
  let code: string | null = e.hint ? String(e.hint) : null;
  let clientEventId: string | null = null;
  if (e.details) {
    try {
      const d = JSON.parse(String(e.details)) as { code?: string; client_event_id?: string };
      if (d.code) code = d.code;
      if (d.client_event_id) clientEventId = d.client_event_id;
    } catch { /* details no era JSON */ }
  }
  const idx = /Evento (\d+)/.exec(message);
  const index = idx ? Number(idx[1]) : null;
  const base = { code, message, clientEventId, index };

  if (code && BLOCKED_CODES.has(code)) return { kind: 'blocked', ...base };
  if (sqlstate === '42501') {
    // «Authentication required» = sesión vencida: se reintenta tras refrescar el token. Lo demás es falta de permiso.
    return /authentication/i.test(message) ? { kind: 'network', ...base } : { kind: 'blocked', ...base };
  }
  if (code && !BLOCKED_CODES.has(code) && sqlstate === 'P0001') return { kind: 'event', ...base };
  if (['P0001', '22023', '22P02', '02000'].includes(sqlstate) || sqlstate.startsWith('23')) return { kind: 'event', ...base };
  // Sin código (fetch caído), PGRST3xx (JWT), 5xx, bloqueos/timeouts de Postgres (40/53/55/57/08): reintentar.
  return { kind: 'network', ...base };
}

export interface SendResult {
  data?: { state?: unknown; applied?: string[]; duplicates?: string[] } | null;
  error?: unknown;
}

export type FlushStatus = 'empty' | 'ok' | 'network' | 'blocked' | 'busy';

export interface FlushResult {
  status: FlushStatus;
  sent: number;
  rejected: number;
  /** Último `state` devuelto por el servidor (para refrescar la pantalla). */
  state: unknown;
  message: string | null;
}

export class LiveQueue {
  private snap: Snapshot = { v: 1, items: [], rejected: [], anchors: {} };
  private flushing = false;
  private listeners = new Set<() => void>();
  private version = 0;
  blockedReason: string | null = null;

  constructor(readonly matchId: string, private storage: StorageLike | null) {
    this.load();
  }

  // ── lectura ──
  get items(): readonly QueuedItem[] { return this.snap.items; }
  get rejected(): readonly RejectedItem[] { return this.snap.rejected; }
  get anchors(): Record<string, number> { return this.snap.anchors; }
  get events(): WireEvent[] { return this.snap.items.map((i) => i.event); }
  get size(): number { return this.snap.items.length; }
  get isFlushing(): boolean { return this.flushing; }
  getVersion(): number { return this.version; }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // ── escritura ──
  /** Encola. Un client_event_id repetido se ignora (doble toque). Devuelve true si entró. */
  enqueue(event: WireEvent, label: string, now = Date.now()): boolean {
    if (this.snap.items.some((i) => i.event.client_event_id === event.client_event_id)) return false;
    this.snap.items.push({ event, label, queuedAt: now });
    if (event.type === 'period_start') this.snap.anchors[String(event.period_no)] = Date.parse(event.client_at);
    this.persist();
    return true;
  }

  /** Quita un evento aún no enviado (deshacer de un evento pendiente). */
  remove(clientEventId: string): boolean {
    const i = this.snap.items.findIndex((x) => x.event.client_event_id === clientEventId);
    if (i < 0) return false;
    const [gone] = this.snap.items.splice(i, 1);
    if (gone.event.type === 'period_start') delete this.snap.anchors[String(gone.event.period_no)];
    this.persist();
    return true;
  }

  dismissRejected(clientEventId: string): void {
    this.snap.rejected = this.snap.rejected.filter((r) => r.event.client_event_id !== clientEventId);
    this.persist();
  }

  clear(): void {
    this.snap = { v: 1, items: [], rejected: [], anchors: {} };
    this.blockedReason = null;
    this.persist();
  }

  /**
   * Envía todo lo pendiente, en orden y por lotes. `send` es la llamada a la RPC (con el JWT del usuario).
   * Reentrante: una segunda llamada mientras hay un envío en curso devuelve 'busy'.
   */
  async flush(send: (batch: WireEvent[]) => Promise<SendResult>): Promise<FlushResult> {
    const res: FlushResult = { status: 'empty', sent: 0, rejected: 0, state: null, message: null };
    if (this.flushing) return { ...res, status: 'busy' };
    if (this.snap.items.length === 0) return res;
    this.flushing = true;
    this.blockedReason = null;
    try {
      while (this.snap.items.length > 0) {
        const batch = this.snap.items.slice(0, BATCH_SIZE);
        let out: SendResult;
        try {
          out = await send(batch.map((b) => b.event));
        } catch (err) {
          out = { error: err }; // fetch lanzó: red caída
        }
        if (!out.error) {
          this.dropIds(batch.map((b) => b.event.client_event_id));
          res.sent += batch.length;
          res.state = out.data?.state ?? res.state;
          res.status = 'ok';
          continue;
        }
        const c = classifyRpcError(out.error);
        if (c.kind === 'network') return this.finish({ ...res, status: 'network', message: c.message });
        if (c.kind === 'blocked') {
          this.blockedReason = c.message;
          return this.finish({ ...res, status: 'blocked', message: c.message });
        }
        // Evento inválido: aislar al culpable.
        let culprit = c.clientEventId ? batch.find((b) => b.event.client_event_id === c.clientEventId) : undefined;
        if (!culprit && c.index != null) culprit = batch[c.index - 1];
        if (!culprit) {
          // Sin culpable identificable: probar el primero solo (cada vuelta quita al menos uno o corta).
          culprit = batch[0];
          if (batch.length > 1) {
            let one: SendResult;
            try { one = await send([culprit.event]); } catch (err) { one = { error: err }; }
            if (!one.error) {
              this.dropIds([culprit.event.client_event_id]);
              res.sent += 1;
              res.state = one.data?.state ?? res.state;
              res.status = 'ok';
              continue;
            }
            const c1 = classifyRpcError(one.error);
            if (c1.kind === 'network') return this.finish({ ...res, status: 'network', message: c1.message });
            if (c1.kind === 'blocked') {
              this.blockedReason = c1.message;
              return this.finish({ ...res, status: 'blocked', message: c1.message });
            }
            this.reject(culprit, c1);
            res.rejected += 1;
            continue;
          }
        }
        this.reject(culprit, c);
        res.rejected += 1;
        if (res.status === 'empty') res.status = 'ok';
      }
      return this.finish(res);
    } finally {
      this.flushing = false;
    }
  }

  // ── internos ──
  private finish(r: FlushResult): FlushResult {
    this.persist();
    return r;
  }

  private dropIds(ids: string[]): void {
    const s = new Set(ids);
    this.snap.items = this.snap.items.filter((i) => !s.has(i.event.client_event_id));
    this.persist();
  }

  private reject(item: QueuedItem, c: ClassifiedError): void {
    this.snap.items = this.snap.items.filter((i) => i.event.client_event_id !== item.event.client_event_id);
    this.snap.rejected.push({ ...item, reason: c.message, code: c.code });
    this.persist();
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(queueKey(this.matchId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Snapshot>;
      if (parsed?.v !== 1) return;
      this.snap = {
        v: 1,
        items: Array.isArray(parsed.items) ? parsed.items.filter((i) => i?.event?.client_event_id) : [],
        rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
        anchors: parsed.anchors && typeof parsed.anchors === 'object' ? parsed.anchors : {},
      };
    } catch { /* storage ilegible: se arranca vacío */ }
  }

  private persist(): void {
    this.version += 1;
    if (this.storage) {
      try {
        if (this.snap.items.length === 0 && this.snap.rejected.length === 0 && Object.keys(this.snap.anchors).length === 0) {
          this.storage.removeItem(queueKey(this.matchId));
        } else {
          this.storage.setItem(queueKey(this.matchId), JSON.stringify(this.snap));
        }
      } catch { /* cuota llena o storage bloqueado: sigue en memoria */ }
    }
    this.listeners.forEach((fn) => fn());
  }
}

/** localStorage si existe y funciona; null si no (modo privado, bloqueado). */
export function safeLocalStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    const k = '__pv_probe__';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}
