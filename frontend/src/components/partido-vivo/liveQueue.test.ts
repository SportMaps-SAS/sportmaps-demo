import { describe, expect, it, vi } from 'vitest';
import { LiveQueue, classifyRpcError, queueKey, type StorageLike, type SendResult } from './liveQueue';
import type { WireEvent } from './liveMatchLogic';

const memStorage = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};

const ev = (n: number, type: WireEvent['type'] = 'goal_against', extra: Partial<WireEvent> = {}): WireEvent => ({
  client_event_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  type, period_no: 1, period_second: n * 10, client_at: '2026-11-05T15:00:00.000Z', ...extra,
});

const ok = (): SendResult => ({ data: { state: { status: 'in_period' } }, error: null });
const pgErr = (code: string, hint: string | null, message: string, details?: object): SendResult => ({
  error: { code, hint, message, details: details ? JSON.stringify(details) : null },
});

describe('LiveQueue', () => {
  it('encola en orden y un client_event_id repetido (doble toque) no entra dos veces', () => {
    const q = new LiveQueue('m1', null);
    expect(q.enqueue(ev(1), 'a')).toBe(true);
    expect(q.enqueue(ev(2), 'b')).toBe(true);
    expect(q.enqueue(ev(1), 'a otra vez')).toBe(false);
    expect(q.events.map((e) => e.period_second)).toEqual([10, 20]);
  });

  it('persiste en localStorage y se recupera al recargar', () => {
    const st = memStorage();
    const q = new LiveQueue('m1', st);
    q.enqueue(ev(1), 'a');
    q.enqueue(ev(2, 'period_start', { period_second: 0 }), 'Pitazo');
    expect(st.data.has(queueKey('m1'))).toBe(true);
    const q2 = new LiveQueue('m1', st);
    expect(q2.size).toBe(2);
    expect(q2.anchors['1']).toBe(Date.parse('2026-11-05T15:00:00.000Z'));
  });

  it('funciona sin storage y si el storage lanza', () => {
    const roto: StorageLike = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    const q = new LiveQueue('m1', roto);
    expect(() => q.enqueue(ev(1), 'a')).not.toThrow();
    expect(q.size).toBe(1);
  });

  it('envía todo en un lote y en orden; al aceptarse sale de la cola', async () => {
    const q = new LiveQueue('m1', null);
    [1, 2, 3].forEach((n) => q.enqueue(ev(n), `e${n}`));
    const send = vi.fn(async (_b: WireEvent[]) => ok());
    const r = await q.flush(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].map((e) => e.period_second)).toEqual([10, 20, 30]);
    expect(r).toMatchObject({ status: 'ok', sent: 3 });
    expect(q.size).toBe(0);
  });

  it('sin red conserva la cola y reintenta después sin duplicar', async () => {
    const q = new LiveQueue('m1', null);
    [1, 2].forEach((n) => q.enqueue(ev(n), `e${n}`));
    const caido = vi.fn(async () => ({ error: { message: 'TypeError: Failed to fetch', code: '' } }));
    const r1 = await q.flush(caido);
    expect(r1.status).toBe('network');
    expect(q.size).toBe(2);
    q.enqueue(ev(3), 'e3'); // llega otro mientras no hay red
    const vistos: string[] = [];
    const bien = vi.fn(async (b: WireEvent[]) => { b.forEach((e) => vistos.push(e.client_event_id)); return ok(); });
    const r2 = await q.flush(bien);
    expect(r2).toMatchObject({ status: 'ok', sent: 3 });
    expect(new Set(vistos).size).toBe(3); // cada uno viajó una sola vez con éxito
    expect(q.size).toBe(0);
  });

  it('si fetch lanza una excepción también cuenta como red caída', async () => {
    const q = new LiveQueue('m1', null);
    q.enqueue(ev(1), 'e1');
    const r = await q.flush(async () => { throw new TypeError('Failed to fetch'); });
    expect(r.status).toBe('network');
    expect(q.size).toBe(1);
  });

  it('la sesión vencida («Authentication required») se reintenta, no se rechaza', async () => {
    const q = new LiveQueue('m1', null);
    q.enqueue(ev(1), 'e1');
    const r = await q.flush(async () => pgErr('42501', null, 'Authentication required'));
    expect(r.status).toBe('network');
    expect(q.size).toBe(1);
    expect(q.rejected).toHaveLength(0);
  });

  it('un evento inválido se aísla con su motivo y el resto se reintenta', async () => {
    const q = new LiveQueue('m1', null);
    [1, 2, 3].forEach((n) => q.enqueue(ev(n), `e${n}`));
    const malo = ev(2).client_event_id;
    const send = vi.fn(async (b: WireEvent[]) =>
      b.some((e) => e.client_event_id === malo)
        ? pgErr('P0001', 'NOT_ON_FIELD', 'El jugador no está en la cancha', { code: 'NOT_ON_FIELD', client_event_id: malo })
        : ok());
    const r = await q.flush(send);
    expect(r).toMatchObject({ status: 'ok', sent: 2, rejected: 1 });
    expect(q.size).toBe(0);
    expect(q.rejected).toHaveLength(1);
    expect(q.rejected[0]).toMatchObject({ code: 'NOT_ON_FIELD', reason: 'El jugador no está en la cancha' });
    expect(q.rejected[0].event.client_event_id).toBe(malo);
  });

  it('error de forma «Evento N» identifica al culpable por índice', async () => {
    const q = new LiveQueue('m1', null);
    [1, 2, 3].forEach((n) => q.enqueue(ev(n), `e${n}`));
    const malo = ev(3).client_event_id;
    const send = async (b: WireEvent[]) =>
      b.some((e) => e.client_event_id === malo) ? pgErr('22023', null, `Evento ${b.findIndex((e) => e.client_event_id === malo) + 1} con campos inválidos`) : ok();
    const r = await q.flush(send);
    expect(r).toMatchObject({ sent: 2, rejected: 1 });
    expect(q.rejected[0].event.client_event_id).toBe(malo);
  });

  it('error sin culpable identificable: prueba de uno en uno y no pierde los buenos', async () => {
    const q = new LiveQueue('m1', null);
    [1, 2, 3].forEach((n) => q.enqueue(ev(n), `e${n}`));
    const malo = ev(1).client_event_id;
    const send = async (b: WireEvent[]) => (b.some((e) => e.client_event_id === malo) ? pgErr('P0001', null, 'raro') : ok());
    const r = await q.flush(send);
    expect(r).toMatchObject({ sent: 2, rejected: 1 });
    expect(q.rejected[0].event.client_event_id).toBe(malo);
  });

  it('NOT_DIRECTOR / LIVE_FINISHED frenan el envío y NO tocan los eventos', async () => {
    const q = new LiveQueue('m1', null);
    q.enqueue(ev(1), 'e1');
    const r = await q.flush(async () => pgErr('P0001', 'NOT_DIRECTOR', 'No eres el director de este partido', { code: 'NOT_DIRECTOR' }));
    expect(r.status).toBe('blocked');
    expect(q.size).toBe(1);
    expect(q.rejected).toHaveLength(0);
    expect(q.blockedReason).toMatch(/director/);
  });

  it('CLIENT_EVENT_ID_REUSED se rechaza visible, no se pierde en silencio', async () => {
    const q = new LiveQueue('m1', null);
    q.enqueue(ev(1), 'e1');
    const id = ev(1).client_event_id;
    await q.flush(async () => pgErr('P0001', 'CLIENT_EVENT_ID_REUSED', 'client_event_id reutilizado con otro contenido', { code: 'CLIENT_EVENT_ID_REUSED', client_event_id: id }));
    expect(q.rejected[0].code).toBe('CLIENT_EVENT_ID_REUSED');
  });

  it('flush es reentrante: la segunda llamada simultánea no reenvía (busy)', async () => {
    const q = new LiveQueue('m1', null);
    q.enqueue(ev(1), 'e1');
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => { soltar = r; });
    const send = vi.fn(async () => { await puerta; return ok(); });
    const p1 = q.flush(send);
    const p2 = await q.flush(send);
    expect(p2.status).toBe('busy');
    soltar();
    await p1;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('remove() saca un evento pendiente (deshacer antes de enviar) y su ancla', () => {
    const q = new LiveQueue('m1', null);
    q.enqueue(ev(1, 'period_start', { period_second: 0 }), 'Pitazo');
    expect(q.anchors['1']).toBeDefined();
    expect(q.remove(ev(1).client_event_id)).toBe(true);
    expect(q.size).toBe(0);
    expect(q.anchors['1']).toBeUndefined();
  });

  it('manda más de 50 eventos en varios lotes, siempre en orden', async () => {
    const q = new LiveQueue('m1', null);
    for (let n = 1; n <= 120; n++) q.enqueue(ev(n), `e${n}`);
    const orden: number[] = [];
    const send = vi.fn(async (b: WireEvent[]) => { b.forEach((e) => orden.push(e.period_second / 10)); return ok(); });
    await q.flush(send);
    expect(send).toHaveBeenCalledTimes(3);
    expect(orden).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
  });
});

describe('classifyRpcError', () => {
  it('lee código y client_event_id de DETAIL', () => {
    const c = classifyRpcError({ code: 'P0001', hint: 'FUTURE_EVENT', message: 'x', details: JSON.stringify({ code: 'FUTURE_EVENT', client_event_id: 'abc' }) });
    expect(c).toMatchObject({ kind: 'event', code: 'FUTURE_EVENT', clientEventId: 'abc' });
  });
  it('timeouts y bloqueos de Postgres se reintentan', () => {
    expect(classifyRpcError({ code: '57014', message: 'timeout' }).kind).toBe('network');
    expect(classifyRpcError({ code: '40001', message: 'serialization' }).kind).toBe('network');
  });
  it('LIVE_DISABLED bloquea', () => {
    expect(classifyRpcError({ code: 'P0001', hint: 'LIVE_DISABLED', message: 'x' }).kind).toBe('blocked');
  });
});
