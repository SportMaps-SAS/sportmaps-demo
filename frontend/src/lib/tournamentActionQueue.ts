/**
 * Cola local de acciones del anotador — PURA (sin React, sin red propia).
 *
 * Cada acción se aplica al instante en pantalla con el motor local y se encola aquí con un
 * `client_action_id` (uuid). El sincronizador las envía EN ORDEN:
 *  - 200 (o `duplicate`)        → éxito, se quita de la cola y se adopta la versión del servidor.
 *  - 409 `version_conflict`     → el servidor manda: se adopta su partido y se descartan las acciones
 *                                  pendientes de ese partido (evita contar un punto dos veces).
 *  - 422 / 400 (regla)          → esa acción se descarta y se avisa.
 *  - 401/403 de token           → se detiene sin perder nada (token vencido/revocado).
 *  - sin señal / 5xx / 429      → se queda en la cola y se reintenta con espera creciente.
 * Persiste en localStorage (con try/catch) para sobrevivir a una recarga o a quedarse sin señal.
 */
import type { Action } from '@/lib/tournamentScoring';
import type { MatchDto } from '@/lib/tournamentTypes';

export interface QueuedAction {
  client_action_id: string;
  matchId: string;
  action: Action;
  created_at: number;
  attempts: number;
  /** No reintentar antes de este instante (ms epoch). */
  nextAttemptAt: number;
}

export type SendResult =
  | { kind: 'ok'; duplicate?: boolean; warning?: string; match: MatchDto }
  /** 409 otro_anotador: otra persona anota este partido; hay que «tomarlo» para seguir. */
  | { kind: 'other_scorer'; match: MatchDto | null; message: string }
  | { kind: 'conflict'; match: MatchDto | null; message?: string }
  | { kind: 'rule'; code: string; message: string }
  | { kind: 'auth'; code: string; message: string }
  | { kind: 'retry'; message: string; retryAfterMs?: number };

export type FlushEvent =
  | { type: 'sent'; item: QueuedAction; match: MatchDto; duplicate: boolean; warning?: string }
  | { type: 'other_scorer'; matchId: string; match: MatchDto | null; message: string }
  | { type: 'conflict'; matchId: string; match: MatchDto | null; dropped: number }
  | { type: 'rule_error'; item: QueuedAction; code: string; message: string }
  | { type: 'retry'; item: QueuedAction; delayMs: number; message: string }
  | { type: 'auth_error'; code: string; message: string };

export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SendFn = (item: QueuedAction, expectedVersion: number) => Promise<SendResult>;

export interface ActionQueueOptions {
  key: string;
  send: SendFn;
  storage?: QueueStorage | null;
  now?: () => number;
  newId?: () => string;
  onChange?: () => void;
  /** Azar del jitter de reintentos (tests: `() => 1`). */
  random?: () => number;
}

interface Persisted { items: QueuedAction[]; versions: Record<string, number> }

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30000;

export function backoffDelay(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * «Equal jitter»: una espera al azar entre la mitad y el total de `ms`.
 *
 * Sin esto, cuando la base o el BFF responden 5xx (p. ej. la caída de Disk IO
 * del 2026-10-14) TODAS las colas de los teléfonos —marcadores en vivo, listas
 * de asistencia V2, bandeja offline— reintentan en el mismo instante (1 s, 2 s,
 * 4 s…) y cada ola le pega junta a un servidor que ya está en problemas. Lo
 * mismo al volver la señal en una cancha con varios profes. El azar las reparte.
 * `random` se inyecta en los tests (`() => 1` = espera completa, determinista).
 */
export function conJitter(ms: number, random: () => number = Math.random): number {
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(ms / 2 + (ms / 2) * r);
}

export function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* sin crypto */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function safeStorage(): QueueStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch { return null; }
}

/** Traduce el error de bffClient (BFFError con status/body) al resultado que entiende la cola. */
export function classifyError(err: unknown): SendResult {
  const e = err as { status?: number; body?: { error?: string; code?: string; match?: MatchDto } | null; message?: string; retryAfterSeconds?: number };
  const status = typeof e?.status === 'number' ? e.status : 0;
  const body = e?.body ?? null;
  const code = body?.code ?? '';
  const message = body?.error ?? e?.message ?? 'Error de red';
  if (status === 409 && code === 'otro_anotador') return { kind: 'other_scorer', match: body?.match ?? null, message };
  if (status === 409 && code === 'version_conflict') return { kind: 'conflict', match: body?.match ?? null, message };
  if ((status === 401 || status === 403) && code.startsWith('token_')) return { kind: 'auth', code, message };
  if (status === 401) return { kind: 'auth', code: code || 'sesion', message };
  if (status === 403 && code === 'live_disabled') return { kind: 'rule', code, message: message || 'Este torneo no tiene el marcador en vivo encendido' };
  if (status === 400 || status === 403 || status === 404 || status === 409 || status === 422) return { kind: 'rule', code: code || 'regla', message };
  return { kind: 'retry', message, retryAfterMs: e?.retryAfterSeconds != null ? e.retryAfterSeconds * 1000 : undefined };
}

export class ActionQueue {
  private items: QueuedAction[] = [];
  private versions: Record<string, number> = {};
  private flushing: Promise<FlushEvent[]> | null = null;
  private again = false;
  private againForce = false;
  private readonly opts: ActionQueueOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly newId: () => string;

  constructor(opts: ActionQueueOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.newId = opts.newId ?? uuid;
    this.load();
  }

  private load() {
    try {
      const raw = this.opts.storage?.getItem(this.opts.key);
      if (!raw) return;
      const p = JSON.parse(raw) as Persisted;
      if (Array.isArray(p.items)) this.items = p.items;
      if (p.versions && typeof p.versions === 'object') this.versions = p.versions;
    } catch { /* almacenamiento ilegible: se empieza vacío */ }
  }

  private save() {
    try { this.opts.storage?.setItem(this.opts.key, JSON.stringify({ items: this.items, versions: this.versions } satisfies Persisted)); } catch { /* lleno o bloqueado */ }
    this.opts.onChange?.();
  }

  /** Versión del partido que el servidor reconoció por última vez. */
  setVersion(matchId: string, version: number) {
    if (this.versions[matchId] === version) return;
    this.versions[matchId] = version;
    this.save();
  }
  getVersion(matchId: string): number | undefined { return this.versions[matchId]; }

  enqueue(matchId: string, action: Action): QueuedAction {
    const item: QueuedAction = { client_action_id: this.newId(), matchId, action, created_at: this.now(), attempts: 0, nextAttemptAt: 0 };
    this.items.push(item);
    this.save();
    return item;
  }

  pending(matchId?: string): QueuedAction[] {
    return matchId ? this.items.filter((i) => i.matchId === matchId) : this.items.slice();
  }
  get size(): number { return this.items.length; }

  /** Milisegundos hasta el próximo intento posible (0 si ya se puede o no hay nada). */
  nextDelayMs(): number {
    if (this.items.length === 0) return 0;
    return Math.max(0, this.items[0].nextAttemptAt - this.now());
  }

  /** Envía en orden lo pendiente. Una sola corrida a la vez. `force` ignora la espera de reintento. */
  flush(force = false): Promise<FlushEvent[]> {
    if (this.flushing) {
      // Algo se encoló mientras corría una pasada: se repite al terminar para no esperar al siguiente turno.
      this.again = true;
      this.againForce = this.againForce || force;
      return this.flushing;
    }
    this.flushing = (async () => {
      const all: FlushEvent[] = [];
      let f = force;
      do {
        this.again = false;
        all.push(...(await this.run(f)));
        f = this.againForce;
        this.againForce = false;
      } while (this.again);
      return all;
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async run(force: boolean): Promise<FlushEvent[]> {
    const events: FlushEvent[] = [];
    while (this.items.length > 0) {
      const item = this.items[0];
      if (!force && item.nextAttemptAt > this.now()) break;
      const expected = this.versions[item.matchId] ?? 0;
      let res: SendResult;
      try { res = await this.opts.send(item, expected); } catch (err) { res = classifyError(err); }

      if (res.kind === 'ok') {
        this.items.shift();
        this.versions[item.matchId] = res.match.version;
        events.push({ type: 'sent', item, match: res.match, duplicate: !!res.duplicate, warning: res.warning });
        this.save();
        continue;
      }
      if (res.kind === 'conflict') {
        const before = this.items.length;
        this.items = this.items.filter((i) => i.matchId !== item.matchId);
        if (res.match) this.versions[item.matchId] = res.match.version;
        events.push({ type: 'conflict', matchId: item.matchId, match: res.match, dropped: before - this.items.length });
        this.save();
        continue;
      }
      if (res.kind === 'rule') {
        this.items.shift();
        events.push({ type: 'rule_error', item, code: res.code, message: res.message });
        this.save();
        continue;
      }
      if (res.kind === 'other_scorer') {
        events.push({ type: 'other_scorer', matchId: item.matchId, match: res.match, message: res.message });
        break;
      }
      if (res.kind === 'auth') {
        events.push({ type: 'auth_error', code: res.code, message: res.message });
        break;
      }
      // retry: se queda al frente de la cola
      item.attempts += 1;
      const delay = Math.max(conJitter(backoffDelay(item.attempts), this.random), res.retryAfterMs ?? 0);
      item.nextAttemptAt = this.now() + delay;
      events.push({ type: 'retry', item, delayMs: delay, message: res.message });
      this.save();
      break;
    }
    return events;
  }
}
