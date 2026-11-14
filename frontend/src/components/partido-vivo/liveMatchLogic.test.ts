import { describe, expect, it } from 'vitest';
import {
  buildPeriodEnd, buildPeriodStart, buildSlotEvent, buildSub, clockView, formatClock, lastVoidable, logItems, minuteLabel,
  projectState, type LiveState, type LivePlayer, type WireEvent,
} from './liveMatchLogic';

const P = (n: number, role: 'starter' | 'bench', j = n): LivePlayer => ({ subject_type: 'child', subject_id: `p${n}`, name: `J${n}`, jersey_number: j, role });
const ref = (n: number) => ({ subject_type: 'child' as const, subject_id: `p${n}` });

const base = (over: Partial<LiveState> = {}): LiveState => ({
  match_id: 'm1', status: 'not_started', current_period: 0, periods_planned: 2, director_id: 'u1',
  periods: [
    { period_no: 1, planned_seconds: 2700, actual_seconds: null, stoppage_seconds: null, started_at: null, ended_at: null },
    { period_no: 2, planned_seconds: 2700, actual_seconds: null, stoppage_seconds: null, started_at: null, ended_at: null },
  ],
  lineup: [P(1, 'starter'), P(2, 'starter'), P(3, 'bench'), P(4, 'bench')],
  on_field: [], sent_off: [], events: [], warnings: [], ...over,
});

const T0 = Date.parse('2026-11-05T15:00:00.000Z');
const ctx = (nowMs: number, n = 1) => ({ nowMs, id: () => `id-${n}` });

describe('formatClock / minuteLabel', () => {
  it('formatea mm:ss', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(65)).toBe('01:05');
    expect(formatClock(2750)).toBe('45:50');
  });
  it('minuto = ceil(s/60) y «45+3′» pasado lo planificado', () => {
    expect(minuteLabel(361, 2700)).toBe('7′');
    expect(minuteLabel(360, 2700)).toBe('6′');
    expect(minuteLabel(2700 + 150, 2700)).toBe('45+3′');
    expect(minuteLabel(0, 2700, true)).toBe('Descanso');
  });
});

describe('proyección con eventos pendientes', () => {
  it('period_start pendiente (sin red) arranca el reloj con el ancla del celular y pone a los titulares', () => {
    const s = base();
    const start = buildPeriodStart(projectState(s, []), ctx(T0));
    expect(start.client_at).toBe(new Date(T0).toISOString()); // client_at obligatorio
    expect(start.period_no).toBe(1);
    const proj = projectState(s, [start], { '1': T0 });
    expect(proj.status).toBe('in_period');
    expect([...proj.onField].sort()).toEqual(['child:p1', 'child:p2']);
    const c = clockView(s, proj, T0 + 125_000);
    expect(c.label).toBe('02:05');
    expect(c.running).toBe(true);
  });

  it('no duplica un evento pendiente que el servidor ya tiene (mismo client_event_id)', () => {
    const goal: WireEvent = { client_event_id: 'g1', type: 'goal_against', period_no: 1, period_second: 10, client_at: new Date(T0).toISOString() };
    const s = base({
      status: 'in_period', current_period: 1, on_field: [ref(1), ref(2)],
      events: [{ id: 'e1', client_event_id: 'g1', type: 'goal_against', period_no: 1, period_second: 10, in_break: false, subject_type: null, subject_id: null, related_type: null, related_id: null, reason: null, voided: false }],
    });
    const proj = projectState(s, [goal], { '1': T0 });
    expect(proj.scoreAgainst).toBe(1);
    expect(proj.pending).toHaveLength(0);
  });

  it('sustitución: sale uno de cancha, entra uno de banca; roja saca y bloquea', () => {
    const s = base({ status: 'in_period', current_period: 1, on_field: [ref(1), ref(2)], periods: [{ ...base().periods[0], started_at: new Date(T0).toISOString() }, base().periods[1]] });
    const p0 = projectState(s, [], { '1': T0 });
    const c = clockView(s, p0, T0 + 600_000);
    const sub = buildSub(p0, c, ctx(T0 + 600_000, 2), ref(1), ref(3))!;
    expect(sub).toMatchObject({ type: 'sub', period_second: 600, subject: { id: 'p3' }, related: { id: 'p1' } });
    const red = buildSlotEvent('red', p0, c, ctx(T0 + 600_000, 3), { subject: ref(2) })!;
    const p1 = projectState(s, [sub, red], { '1': T0 });
    expect([...p1.onField]).toEqual(['child:p3']);
    expect(p1.sentOff.has('child:p2')).toBe(true);
    expect(buildSub(p1, c, ctx(T0, 4), ref(3), ref(2))).toBeNull(); // el expulsado no reingresa
    expect(buildSub(p0, c, ctx(T0, 5), ref(3), ref(4))).toBeNull(); // sale alguien que no está en cancha
  });

  it('reingresos permitidos sin tope: el que salió puede volver a entrar', () => {
    const s = base({ status: 'in_period', current_period: 1, on_field: [ref(1), ref(2)] });
    let proj = projectState(s, [], { '1': T0 });
    const c = clockView(s, proj, T0 + 60_000);
    const e1 = buildSub(proj, c, ctx(T0 + 60_000, 1), ref(1), ref(3))!;
    proj = projectState(s, [e1], { '1': T0 });
    const e2 = buildSub(proj, c, ctx(T0 + 120_000, 2), ref(3), ref(1));
    expect(e2).not.toBeNull();
    expect([...projectState(s, [e1, e2!], { '1': T0 }).onField].sort()).toEqual(['child:p1', 'child:p2']);
  });

  it('en el descanso los eventos van al tiempo siguiente con in_break y segundo 0', () => {
    const s = base({ status: 'on_break', current_period: 1, on_field: [ref(1), ref(2)] });
    const proj = projectState(s, []);
    const e = buildSlotEvent('sub', proj, clockView(s, proj, T0), ctx(T0), { subject: ref(3), related: ref(1) })!;
    expect(e).toMatchObject({ period_no: 2, period_second: 0, in_break: true });
  });

  it('antes del pitazo no se puede registrar nada en cancha', () => {
    const proj = projectState(base(), []);
    expect(buildSlotEvent('goal_against', proj, clockView(base(), proj, T0), ctx(T0))).toBeNull();
  });
});

describe('reloj con tiempo añadido', () => {
  it('pasado lo planificado sigue contando y muestra +mm:ss', () => {
    const s = base({ status: 'in_period', current_period: 1, on_field: [ref(1)] });
    const proj = projectState(s, [], { '1': T0 });
    const c = clockView(s, proj, T0 + (2700 + 133) * 1000);
    expect(c.label).toBe('47:13');
    expect(c.addedSeconds).toBe(133);
    expect(c.addedLabel).toBe('+02:13');
  });

  it('el formato por partido manda: tiempo de 25 min planificados', () => {
    const s = base({ status: 'in_period', current_period: 1, periods: [{ ...base().periods[0], planned_seconds: 1500 }, base().periods[1]] });
    const c = clockView(s, projectState(s, [], { '1': T0 }), T0 + 1560_000);
    expect(c.planned).toBe(1500);
    expect(c.addedLabel).toBe('+01:00');
  });

  it('al terminar el tiempo (pendiente) el reloj se congela en los segundos del pitazo final', () => {
    const s = base({ status: 'in_period', current_period: 1, on_field: [ref(1)] });
    const p0 = projectState(s, [], { '1': T0 });
    const end = buildPeriodEnd(p0, clockView(s, p0, T0 + 2850_000), ctx(T0 + 2850_000));
    const p1 = projectState(s, [end], { '1': T0 });
    expect(p1.status).toBe('on_break');
    const c = clockView(s, p1, T0 + 9_999_000);
    expect(c.running).toBe(false);
    expect(c.elapsed).toBe(2850);
    expect(c.addedLabel).toBe('+02:30');
  });

  it('sin ancla local usa started_at del servidor (otro celular / recarga sin storage)', () => {
    const s = base({ status: 'in_period', current_period: 1, periods: [{ ...base().periods[0], started_at: new Date(T0).toISOString() }, base().periods[1]] });
    const c = clockView(s, projectState(s, []), T0 + 30_000);
    expect(c.label).toBe('00:30');
  });
});

describe('registro y deshacer', () => {
  it('lastVoidable toma el último evento anulable, pendientes incluidos', () => {
    const s = base({
      status: 'in_period', current_period: 1,
      events: [{ id: 'e1', client_event_id: 'a', type: 'period_start', period_no: 1, period_second: 0, in_break: false, subject_type: null, subject_id: null, related_type: null, related_id: null, reason: null, voided: false },
        { id: 'e2', client_event_id: 'b', type: 'callup', period_no: 1, period_second: 0, in_break: false, subject_type: 'child', subject_id: 'p9', related_type: null, related_id: null, reason: null, voided: false }],
    });
    expect(lastVoidable(logItems(s, []))!.clientEventId).toBe('a'); // callup no se anula
    const pend: WireEvent = { client_event_id: 'c', type: 'goal_against', period_no: 1, period_second: 5, client_at: new Date(T0).toISOString() };
    const last = lastVoidable(logItems(s, [pend]))!;
    expect(last.clientEventId).toBe('c');
    expect(last.pending).toBe(true);
  });
});
