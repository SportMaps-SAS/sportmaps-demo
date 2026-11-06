/**
 * Partido en vivo — lógica PURA (sin React, sin red): tipos del contrato de las RPC, proyección
 * del estado (servidor + eventos pendientes en la cola) y reloj. Spec: docs/specs/partido-en-vivo-sustituciones.md
 * §5–§8; contrato real en supabase/migrations/20261105231608_partido_vivo_rpcs.sql + 20261105234602_*.sql.
 *
 * Convenciones del contrato:
 *  · `period_second` = segundos transcurridos DENTRO del tiempo (no acumulados entre tiempos).
 *  · `sub`: `subject` = quien ENTRA, `related` = quien SALE.
 *  · `goal`: `subject` = goleador (en cancha), `related` = asistente opcional. `goal_against`: sin sujeto.
 *  · Eventos en el descanso: `in_break = true`, `period_no` = tiempo siguiente, `period_second = 0`.
 *  · `period_start` DEBE llevar `client_at` (ancla del reloj; sin él el cinturón anti-futuro rechaza lotes).
 */

export type SubjectType = 'profile' | 'child' | 'unregistered';
export type LiveStatus = 'not_started' | 'in_period' | 'on_break' | 'finished';
export type LiveEventType = 'period_start' | 'period_end' | 'sub' | 'goal' | 'goal_against' | 'yellow' | 'red' | 'clock_adjust';

export interface SubjectRef { subject_type: SubjectType; subject_id: string }

export interface LivePlayer extends SubjectRef {
  name: string;
  jersey_number: number | null;
  role: 'starter' | 'bench' | string;
}

export interface LivePeriod {
  period_no: number;
  planned_seconds: number;
  actual_seconds: number | null;
  stoppage_seconds: number | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface LiveEventRow {
  id: string;
  client_event_id: string;
  type: string;
  period_no: number;
  period_second: number;
  in_break: boolean;
  subject_type: SubjectType | null;
  subject_id: string | null;
  related_type: SubjectType | null;
  related_id: string | null;
  reason: string | null;
  voided: boolean;
}

export interface LiveState {
  match_id: string;
  status: LiveStatus;
  current_period: number;
  periods_planned: number;
  director_id: string | null;
  periods: LivePeriod[];
  lineup: LivePlayer[];
  on_field: SubjectRef[];
  sent_off: SubjectRef[];
  events: LiveEventRow[];
  warnings: Array<{ code: string; [k: string]: unknown }>;
}

/** Evento tal como lo recibe `apply_live_events`. */
export interface WireEvent {
  client_event_id: string;
  type: LiveEventType;
  period_no: number;
  period_second: number;
  in_break?: boolean;
  subject?: { type: SubjectType; id: string };
  related?: { type: SubjectType; id: string };
  reason?: string;
  payload?: Record<string, unknown>;
  client_at: string;
}

export const keyOf = (type: string, id: string) => `${type}:${id}`;
export const keyOfRef = (r: SubjectRef) => keyOf(r.subject_type, r.subject_id);

/** Eventos que `void_live_event` acepta anular (los demás: EVENT_NOT_VOIDABLE). */
export const VOIDABLE: ReadonlySet<string> = new Set(['period_start', 'period_end', 'sub', 'goal', 'goal_against', 'yellow', 'red']);

// ── Proyección: estado del servidor + eventos aún en la cola ─────────────────

export interface Projected {
  status: LiveStatus;
  currentPeriod: number;
  onField: Set<string>;
  sentOff: Set<string>;
  scoreFor: number;
  scoreAgainst: number;
  /** Eventos pendientes que aún no están en el servidor, en orden de cola. */
  pending: WireEvent[];
  /** Ancla (ms epoch, hora del celular) del tiempo en juego; null si no hay uno corriendo. */
  anchorMs: number | null;
  /** Segundos finales de cada tiempo ya cerrado (servidor o pitazo final pendiente). */
  closedSeconds: Record<number, number>;
}

const parseMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * @param anchors  ms de `client_at` de cada period_start que ESTE celular mandó (clave = nº de tiempo). Se prefiere sobre
 *                 `started_at` del servidor para que el reloj no salte por desfase entre relojes.
 */
export function projectState(server: LiveState | null, pending: WireEvent[], anchors: Record<string, number> = {}): Projected {
  let status: LiveStatus = server?.status ?? 'not_started';
  let current = server?.current_period ?? 0;
  const onField = new Set((server?.on_field ?? []).map(keyOfRef));
  const sentOff = new Set((server?.sent_off ?? []).map(keyOfRef));
  const known = new Set((server?.events ?? []).map((e) => e.client_event_id));
  let scoreFor = 0;
  let scoreAgainst = 0;
  for (const e of server?.events ?? []) {
    if (e.voided) continue;
    if (e.type === 'goal') scoreFor += 1;
    else if (e.type === 'goal_against') scoreAgainst += 1;
  }
  const closedSeconds: Record<number, number> = {};
  for (const p of server?.periods ?? []) if (p.actual_seconds != null) closedSeconds[p.period_no] = p.actual_seconds;

  const starters = (server?.lineup ?? []).filter((p) => p.role === 'starter').map(keyOfRef);
  const nuevos = pending.filter((e) => !known.has(e.client_event_id));

  for (const e of nuevos) {
    switch (e.type) {
      case 'period_start':
        status = 'in_period';
        current = e.period_no;
        if (e.period_no === 1 && onField.size === 0) starters.forEach((k) => onField.add(k));
        break;
      case 'period_end':
        status = 'on_break';
        closedSeconds[e.period_no] = e.period_second;
        break;
      case 'sub':
        if (e.related) onField.delete(keyOf(e.related.type, e.related.id));
        if (e.subject) onField.add(keyOf(e.subject.type, e.subject.id));
        break;
      case 'red':
        if (e.subject) {
          const k = keyOf(e.subject.type, e.subject.id);
          onField.delete(k);
          sentOff.add(k);
        }
        break;
      case 'goal': scoreFor += 1; break;
      case 'goal_against': scoreAgainst += 1; break;
      default: break;
    }
  }

  let anchorMs: number | null = null;
  if (status === 'in_period') {
    anchorMs = anchors[String(current)] ?? parseMs(server?.periods.find((p) => p.period_no === current)?.started_at);
  }
  return { status, currentPeriod: current, onField, sentOff, scoreFor, scoreAgainst, pending: nuevos, anchorMs, closedSeconds };
}

// ── Reloj ────────────────────────────────────────────────────────────────────

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export interface ClockView {
  running: boolean;
  elapsed: number;
  planned: number;
  /** «12:03» (segundos jugados dentro del tiempo; sigue contando pasado lo planificado). */
  label: string;
  /** Segundos pasados de lo planificado (tiempo añadido), 0 si no hay. */
  addedSeconds: number;
  addedLabel: string | null;
}

export function plannedSecondsOf(server: LiveState | null, periodNo: number, fallback = 45 * 60): number {
  return server?.periods.find((p) => p.period_no === periodNo)?.planned_seconds ?? fallback;
}

/** Reloj del tiempo en juego (o del último cerrado cuando está en descanso). */
export function clockView(server: LiveState | null, proj: Projected, nowMs: number): ClockView {
  const planned = plannedSecondsOf(server, proj.currentPeriod || 1);
  let elapsed = 0;
  let running = false;
  if (proj.status === 'in_period' && proj.anchorMs != null) {
    elapsed = Math.max(0, Math.floor((nowMs - proj.anchorMs) / 1000));
    running = true;
  } else if (proj.currentPeriod > 0) {
    elapsed = proj.closedSeconds[proj.currentPeriod] ?? 0;
  }
  const addedSeconds = Math.max(0, elapsed - planned);
  return {
    running,
    elapsed,
    planned,
    label: formatClock(elapsed),
    addedSeconds,
    addedLabel: addedSeconds > 0 ? `+${formatClock(addedSeconds)}` : null,
  };
}

/** Minuto mostrado de un evento: ceil(s/60) (convención del fútbol), y «45+3′» si pasa lo planificado. */
export function minuteLabel(periodSecond: number, plannedSeconds: number, inBreak = false): string {
  if (inBreak) return 'Descanso';
  const min = Math.max(1, Math.ceil(periodSecond / 60));
  if (periodSecond > plannedSeconds) {
    const base = Math.round(plannedSeconds / 60);
    return `${base}+${Math.max(1, Math.ceil((periodSecond - plannedSeconds) / 60))}′`;
  }
  return `${min}′`;
}

// ── Construcción de eventos ──────────────────────────────────────────────────

export type IdGen = () => string;

export function newClientEventId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Respaldo (navegadores sin randomUUID): UUID v4 con Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Dónde cae un evento ahora: dentro del tiempo en juego o en el descanso (tiempo siguiente). null = aún no se puede. */
export function eventSlot(proj: Projected, elapsedSeconds: number): { period_no: number; period_second: number; in_break: boolean } | null {
  if (proj.status === 'in_period') return { period_no: proj.currentPeriod, period_second: Math.max(0, Math.floor(elapsedSeconds)), in_break: false };
  if (proj.status === 'on_break') return { period_no: proj.currentPeriod + 1, period_second: 0, in_break: true };
  return null;
}

export interface BuildCtx { nowMs: number; id?: IdGen }

const clientAt = (ms: number) => new Date(ms).toISOString();

export function buildPeriodStart(proj: Projected, ctx: BuildCtx): WireEvent {
  return {
    client_event_id: (ctx.id ?? newClientEventId)(),
    type: 'period_start',
    period_no: proj.currentPeriod + 1,
    period_second: 0,
    client_at: clientAt(ctx.nowMs), // obligatorio: ancla del reloj
  };
}

export function buildPeriodEnd(proj: Projected, clock: ClockView, ctx: BuildCtx): WireEvent {
  return {
    client_event_id: (ctx.id ?? newClientEventId)(),
    type: 'period_end',
    period_no: proj.currentPeriod,
    period_second: Math.max(1, clock.elapsed),
    client_at: clientAt(ctx.nowMs),
  };
}

/** Evento con jugador(es) en el slot actual. null si el partido no está en juego ni en descanso. */
export function buildSlotEvent(
  type: 'sub' | 'goal' | 'goal_against' | 'yellow' | 'red',
  proj: Projected,
  clock: ClockView,
  ctx: BuildCtx,
  who: { subject?: SubjectRef; related?: SubjectRef; reason?: string } = {},
): WireEvent | null {
  const slot = eventSlot(proj, clock.elapsed);
  if (!slot) return null;
  const ev: WireEvent = {
    client_event_id: (ctx.id ?? newClientEventId)(),
    type,
    period_no: slot.period_no,
    period_second: slot.period_second,
    client_at: clientAt(ctx.nowMs),
  };
  if (slot.in_break) ev.in_break = true;
  if (who.subject) ev.subject = { type: who.subject.subject_type, id: who.subject.subject_id };
  if (who.related) ev.related = { type: who.related.subject_type, id: who.related.subject_id };
  if (who.reason) ev.reason = who.reason;
  return ev;
}

/** Sustitución: sale `out` (en cancha), entra `inn`. Devuelve null si no es válida localmente. */
export function buildSub(proj: Projected, clock: ClockView, ctx: BuildCtx, out: SubjectRef, inn: SubjectRef): WireEvent | null {
  if (!proj.onField.has(keyOfRef(out)) || proj.onField.has(keyOfRef(inn)) || proj.sentOff.has(keyOfRef(inn))) return null;
  return buildSlotEvent('sub', proj, clock, ctx, { subject: inn, related: out });
}

// ── Lista combinada para «anular último» y para el registro ──────────────────

export interface LogItem {
  clientEventId: string;
  serverId: string | null;
  type: string;
  periodNo: number;
  periodSecond: number;
  inBreak: boolean;
  subject: SubjectRef | null;
  related: SubjectRef | null;
  pending: boolean;
}

/** Eventos del partido en orden (servidor primero, luego cola), sin anulados. */
export function logItems(server: LiveState | null, pending: WireEvent[]): LogItem[] {
  const out: LogItem[] = [];
  const known = new Set<string>();
  for (const e of server?.events ?? []) {
    known.add(e.client_event_id);
    if (e.voided) continue;
    out.push({
      clientEventId: e.client_event_id, serverId: e.id, type: e.type, periodNo: e.period_no, periodSecond: e.period_second,
      inBreak: e.in_break,
      subject: e.subject_id && e.subject_type ? { subject_type: e.subject_type, subject_id: e.subject_id } : null,
      related: e.related_id && e.related_type ? { subject_type: e.related_type, subject_id: e.related_id } : null,
      pending: false,
    });
  }
  for (const e of pending) {
    if (known.has(e.client_event_id)) continue;
    out.push({
      clientEventId: e.client_event_id, serverId: null, type: e.type, periodNo: e.period_no, periodSecond: e.period_second,
      inBreak: !!e.in_break,
      subject: e.subject ? { subject_type: e.subject.type, subject_id: e.subject.id } : null,
      related: e.related ? { subject_type: e.related.type, subject_id: e.related.id } : null,
      pending: true,
    });
  }
  return out;
}

/** Último evento anulable (se salta clock_adjust/callup/match_end, que el servidor no anula). */
export function lastVoidable(items: LogItem[]): LogItem | null {
  for (let i = items.length - 1; i >= 0; i--) if (VOIDABLE.has(items[i].type)) return items[i];
  return null;
}
