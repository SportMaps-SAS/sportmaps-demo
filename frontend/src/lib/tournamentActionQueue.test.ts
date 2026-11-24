import { describe, it, expect } from 'vitest';
import { ActionQueue, classifyError, backoffDelay, conJitter, type SendResult, type QueueStorage } from './tournamentActionQueue';
import type { MatchDto } from './tournamentTypes';

const match = (version: number): MatchDto => ({ id: 'm1', version } as MatchDto);

function memStorage(): QueueStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

function setup(results: Array<SendResult | Error>, storage = memStorage()) {
  let t = 1000;
  let n = 0;
  const calls: Array<{ id: string; expected: number }> = [];
  const q = new ActionQueue({ random: () => 1,
    key: 'k', storage, now: () => t, newId: () => `id${++n}`,
    send: async (item, expected) => {
      calls.push({ id: item.client_action_id, expected });
      const r = results.shift();
      if (r instanceof Error) throw r;
      return r ?? { kind: 'ok', match: match(expected + 1) };
    },
  });
  return { q, calls, storage, advance: (ms: number) => { t += ms; } };
}

describe('ActionQueue', () => {
  it('envía en orden y encadena la versión del servidor', async () => {
    const { q, calls } = setup([]);
    q.setVersion('m1', 3);
    q.enqueue('m1', { type: 'start' });
    q.enqueue('m1', { type: 'point', side: 'home' });
    q.enqueue('m1', { type: 'point', side: 'away' });
    const ev = await q.flush();
    expect(ev.map((e) => e.type)).toEqual(['sent', 'sent', 'sent']);
    expect(calls).toEqual([{ id: 'id1', expected: 3 }, { id: 'id2', expected: 4 }, { id: 'id3', expected: 5 }]);
    expect(q.size).toBe(0);
    expect(q.getVersion('m1')).toBe(6);
  });

  it('reintenta con espera creciente y conserva el orden', async () => {
    const { q, calls, advance } = setup([{ kind: 'retry', message: 'sin señal' }]);
    q.enqueue('m1', { type: 'point', side: 'home' });
    q.enqueue('m1', { type: 'point', side: 'away' });
    const e1 = await q.flush();
    expect(e1).toHaveLength(1);
    expect(e1[0]).toMatchObject({ type: 'retry', delayMs: 1000 });
    expect(q.size).toBe(2);
    expect(await q.flush()).toEqual([]); // aún en espera
    expect(calls).toHaveLength(1);
    advance(1000);
    const e2 = await q.flush();
    expect(e2.map((e) => e.type)).toEqual(['sent', 'sent']);
    // el reintento usa el MISMO client_action_id (idempotencia)
    expect(calls[0].id).toBe('id1');
    expect(calls[1].id).toBe('id1');
    expect(calls[2].id).toBe('id2');
  });

  it('un error lanzado por la red cuenta como reintento', async () => {
    const { q } = setup([Object.assign(new Error('Failed to fetch'), { status: 0 })]);
    q.enqueue('m1', { type: 'start' });
    const ev = await q.flush();
    expect(ev[0].type).toBe('retry');
    expect(q.size).toBe(1);
  });

  it('duplicate se trata como éxito', async () => {
    const { q } = setup([{ kind: 'ok', duplicate: true, match: match(9) }]);
    q.enqueue('m1', { type: 'start' });
    const ev = await q.flush();
    expect(ev[0]).toMatchObject({ type: 'sent', duplicate: true });
    expect(q.size).toBe(0);
    expect(q.getVersion('m1')).toBe(9);
  });

  it('409: adopta el partido del servidor y descarta lo pendiente de ese partido, no de otros', async () => {
    const { q } = setup([{ kind: 'conflict', match: match(12) }]);
    q.enqueue('m1', { type: 'point', side: 'home' });
    q.enqueue('m1', { type: 'point', side: 'home' });
    q.enqueue('m2', { type: 'point', side: 'away' });
    const ev = await q.flush();
    expect(ev[0]).toMatchObject({ type: 'conflict', matchId: 'm1', dropped: 2 });
    expect(q.getVersion('m1')).toBe(12);
    expect(ev[1].type).toBe('sent'); // m2 sigue su curso
    expect(q.size).toBe(0);
  });

  it('422: descarta esa acción, avisa y sigue con la siguiente', async () => {
    const { q } = setup([{ kind: 'rule', code: 'no_decidido', message: 'Aún no se define el ganador' }]);
    q.enqueue('m1', { type: 'finish' });
    q.enqueue('m1', { type: 'point', side: 'home' });
    const ev = await q.flush();
    expect(ev[0]).toMatchObject({ type: 'rule_error', code: 'no_decidido' });
    expect(ev[1].type).toBe('sent');
    expect(q.size).toBe(0);
  });

  it('token inválido detiene sin perder acciones', async () => {
    const { q } = setup([{ kind: 'auth', code: 'token_vencido', message: 'vencido' }]);
    q.enqueue('m1', { type: 'start' });
    const ev = await q.flush();
    expect(ev[0]).toMatchObject({ type: 'auth_error', code: 'token_vencido' });
    expect(q.size).toBe(1);
  });

  it('persiste y se recupera tras recargar', async () => {
    const storage = memStorage();
    const a = setup([], storage);
    a.q.setVersion('m1', 5);
    a.q.enqueue('m1', { type: 'point', side: 'home' });
    const b = setup([], storage);
    expect(b.q.size).toBe(1);
    expect(b.q.getVersion('m1')).toBe(5);
    await b.q.flush();
    expect(JSON.parse(storage.data.k).items).toHaveLength(0);
  });

  it('sin almacenamiento funciona en memoria', async () => {
    const q = new ActionQueue({ random: () => 1, key: 'x', storage: null, send: async () => ({ kind: 'ok', match: match(1) }) });
    q.enqueue('m1', { type: 'start' });
    expect((await q.flush())[0].type).toBe('sent');
  });

  it('flush concurrente comparte la misma corrida', async () => {
    const { q, calls } = setup([]);
    q.enqueue('m1', { type: 'start' });
    const [a, b] = await Promise.all([q.flush(), q.flush()]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });
});

describe('classifyError / backoffDelay', () => {
  it('clasifica por estado y código', () => {
    expect(classifyError({ status: 409, body: { code: 'version_conflict', match: match(2) } })).toMatchObject({ kind: 'conflict' });
    expect(classifyError({ status: 422, body: { code: 'no_decidido', error: 'x' } })).toMatchObject({ kind: 'rule', code: 'no_decidido' });
    expect(classifyError({ status: 403, body: { code: 'token_revocado', error: 'x' } })).toMatchObject({ kind: 'auth' });
    expect(classifyError({ status: 403, body: { code: 'live_disabled', error: 'x' } })).toMatchObject({ kind: 'rule' });
    expect(classifyError({ status: 503, message: 'x' })).toMatchObject({ kind: 'retry' });
    expect(classifyError(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'retry' });
    expect(classifyError({ status: 429, retryAfterSeconds: 5, message: 'x' })).toMatchObject({ kind: 'retry', retryAfterMs: 5000 });
  });
  it('backoff exponencial con tope', () => {
    expect([1, 2, 3, 4].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelay(20)).toBe(30000);
  });
});

describe('conJitter', () => {
  it('reparte la espera entre la mitad y el total (para que los teléfonos no reintenten a la vez)', () => {
    expect(conJitter(8000, () => 0)).toBe(4000);
    expect(conJitter(8000, () => 1)).toBe(8000);
    expect(conJitter(8000, () => 0.5)).toBe(6000);
    // valores fuera de [0,1] se recortan
    expect(conJitter(8000, () => 7)).toBe(8000);
    expect(conJitter(8000, () => -1)).toBe(4000);
  });

  it('con el azar real, 200 colas que fallan a la vez no reintentan en el mismo instante', () => {
    const esperas = new Set(Array.from({ length: 200 }, () => conJitter(backoffDelay(3))));
    expect(esperas.size).toBeGreaterThan(100);
    for (const e of esperas) {
      expect(e).toBeGreaterThanOrEqual(2000);
      expect(e).toBeLessThanOrEqual(4000);
    }
  });
});
