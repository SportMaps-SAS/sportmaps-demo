import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LiveBroadcaster, buildLivePayload, pushMatchUpdate, topicFor, httpBroadcastSender, type BroadcastMessage } from './live-push';

/** Reloj y temporizadores manuales: nada depende del tiempo real. */
function harness(opts: { minIntervalMs?: number; maxPerWindow?: number } = {}) {
  let t = 1_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const sent: BroadcastMessage[] = [];
  const b = new LiveBroadcaster({
    send: async (m) => { sent.push(...m); },
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ at: t + ms, fn }); return 0; },
    ...opts,
  });
  const advance = (ms: number) => {
    t += ms;
    for (;;) {
      timers.sort((a, z) => a.at - z.at);
      const next = timers[0];
      if (!next || next.at > t) break;
      timers.shift();
      next.fn();
    }
  };
  return { b, sent, advance };
}

const p = (match_id: string, version: number, home = 0) =>
  buildLivePayload({ id: match_id, version, status: 'live', home_score: 0, away_score: 0, sets: [{ home, away: 0, closed: false }] }, new Date(0));

describe('LiveBroadcaster — un mensaje por acción, sin tormentas', () => {
  it('una acción aislada sale de inmediato, una sola vez', () => {
    const { b, sent } = harness();
    b.publish('tlive:copa', p('m1', 1));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ topic: 'tlive:copa', event: 'match', payload: { match_id: 'm1', version: 1 } });
  });

  it('acciones separadas por más del intervalo = un mensaje cada una', () => {
    const { b, sent, advance } = harness({ minIntervalMs: 300 });
    for (let v = 1; v <= 5; v++) { b.publish('tlive:copa', p('m1', v)); advance(400); }
    expect(sent.map((s) => s.payload.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it('una ráfaga del mismo partido se agrupa: el primero ya, el ÚLTIMO estado después', () => {
    const { b, sent, advance } = harness({ minIntervalMs: 300 });
    for (let v = 1; v <= 20; v++) b.publish('tlive:copa', p('m1', v, v));
    expect(sent).toHaveLength(1);
    advance(300);
    expect(sent).toHaveLength(2);
    expect(sent[1].payload.version).toBe(20);
    expect(sent[1].payload.sets[0].home).toBe(20);
    expect(b.stats).toMatchObject({ published: 20, sent: 2, coalesced: 18 });
    advance(5000);
    expect(sent).toHaveLength(2); // nada más pendiente
  });

  it('nunca manda una versión menor que la última enviada', () => {
    const { b, sent, advance } = harness();
    b.publish('tlive:copa', p('m1', 7));
    advance(1000);
    b.publish('tlive:copa', p('m1', 6)); // llegó tarde (reintento)
    advance(1000);
    expect(sent.map((s) => s.payload.version)).toEqual([7]);
  });

  it('partidos distintos no se frenan entre sí', () => {
    const { b, sent } = harness();
    b.publish('tlive:copa', p('m1', 1));
    b.publish('tlive:copa', p('m2', 1));
    b.publish('tlive:copa', p('m3', 1));
    expect(sent.map((s) => s.payload.match_id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('tope por canal: con 30 canchas anotando a la vez, nunca más de N por segundo', () => {
    const { b, sent, advance } = harness({ maxPerWindow: 10 });
    for (let i = 0; i < 30; i++) b.publish('tlive:copa', p(`m${i}`, 1));
    expect(sent).toHaveLength(10);
    advance(1000);
    expect(sent).toHaveLength(20);
    advance(1000);
    expect(sent).toHaveLength(30);
    // y no se perdió ningún partido
    expect(new Set(sent.map((s) => s.payload.match_id)).size).toBe(30);
  });

  it('si el envío falla no lanza y lo cuenta', async () => {
    const b = new LiveBroadcaster({ send: async () => { throw new Error('caído'); } });
    expect(() => b.publish('tlive:x', p('m1', 1))).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.stats.failed).toBe(1);
  });
});

describe('payload y enchufe', () => {
  it('el payload es mínimo: sin nombres, con hora del servidor', () => {
    const out = buildLivePayload({ id: 'm1', version: 3, status: 'live', home_score: 1, away_score: 0, sets: [{ home: 25, away: 20, closed: true }, { home: 3, away: 1, closed: false }], started_at: 'x', finished_at: null, ...({ home_name: 'Monsters' } as any) }, new Date('2026-10-27T15:00:00Z'));
    expect(out).toEqual({
      match_id: 'm1', version: 3, status: 'live', home_score: 1, away_score: 0,
      sets: [{ home: 25, away: 20, closed: true }, { home: 3, away: 1, closed: false }],
      started_at: 'x', finished_at: null, sent_at: '2026-10-27T15:00:00.000Z',
    });
    expect(JSON.stringify(out)).not.toContain('Monsters');
  });

  describe('interruptor', () => {
    const prev = process.env.TOURNAMENT_LIVE_PUSH_DISABLED;
    beforeEach(() => { delete process.env.TOURNAMENT_LIVE_PUSH_DISABLED; });
    afterEach(() => { if (prev === undefined) delete process.env.TOURNAMENT_LIVE_PUSH_DISABLED; else process.env.TOURNAMENT_LIVE_PUSH_DISABLED = prev; });

    it('publica en el canal del torneo', () => {
      const calls: string[] = [];
      expect(pushMatchUpdate('copa-monster', { id: 'm1', version: 1, status: 'live', home_score: 0, away_score: 0 }, { publish: (t) => { calls.push(t); } })).toBe(true);
      expect(calls).toEqual([topicFor('copa-monster')]);
      expect(topicFor('copa-monster')).toBe('tlive:copa-monster');
    });

    it('TOURNAMENT_LIVE_PUSH_DISABLED=true o sin slug: no publica', () => {
      const calls: string[] = [];
      const fake = { publish: (t: string) => { calls.push(t); } };
      expect(pushMatchUpdate(null, { id: 'm1', status: 'live', home_score: 0, away_score: 0 }, fake)).toBe(false);
      process.env.TOURNAMENT_LIVE_PUSH_DISABLED = 'true';
      expect(pushMatchUpdate('x', { id: 'm1', status: 'live', home_score: 0, away_score: 0 }, fake)).toBe(false);
      expect(calls).toEqual([]);
    });
  });

  it('el envío HTTP usa canal privado y la llave de servicio', async () => {
    const realFetch = globalThis.fetch;
    let seen: any = null;
    globalThis.fetch = (async (url: string, init: any) => { seen = { url, init }; return { ok: true, status: 202 }; }) as any;
    try {
      await httpBroadcastSender('https://x.supabase.co/', 'srv')([{ topic: 'tlive:a', event: 'match', payload: p('m1', 1) }]);
    } finally { globalThis.fetch = realFetch; }
    expect(seen.url).toBe('https://x.supabase.co/realtime/v1/api/broadcast');
    expect(seen.init.headers.Authorization).toBe('Bearer srv');
    expect(JSON.parse(seen.init.body).messages[0]).toMatchObject({ topic: 'tlive:a', event: 'match', private: true });
  });
});
