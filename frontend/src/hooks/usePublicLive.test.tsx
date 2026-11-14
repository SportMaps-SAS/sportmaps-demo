/**
 * B9 — al terminar un partido la tabla pública se pide sin esperar el polling.
 * El canal de Supabase y el BFF son dobles: se dispara el mensaje a mano y se mira qué se pide y cuándo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const get = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({ bffClient: { get: (...a: unknown[]) => get(...a) } }));

let onMessage: ((m: { payload: unknown }) => void) | null = null;
const channel: any = {
  on: vi.fn((_type: string, _filter: unknown, cb: (m: { payload: unknown }) => void) => { onMessage = cb; return channel; }),
  subscribe: vi.fn((cb: (s: string) => void) => { cb('SUBSCRIBED'); return channel; }),
};
vi.mock('@/integrations/supabase/client', () => ({ supabase: { channel: vi.fn(() => channel), removeChannel: vi.fn() } }));

import { usePublicLive } from './usePublicLive';
import { publicLivePath, refetchDelayMs, STANDINGS_REFETCH_MIN_MS, STANDINGS_REFETCH_SPREAD_MS, type LivePushPayload } from '@/components/tournaments/live/liveTransport';

const SERVER_TIME = '2026-10-28T15:00:00.000Z';
const payload = () => ({
  event: { live_enabled: true }, tournament: { live_enabled: true }, categories: [], teams: [], standings: {},
  matches: [{ id: 'm1', status: 'live', home_score: 1, away_score: 0, sets: [], started_at: null, finished_at: null }],
  server_time: SERVER_TIME,
});
const push = (p: Partial<LivePushPayload> = {}): LivePushPayload => ({
  match_id: 'm1', version: 9, status: 'played', home_score: 2, away_score: 0, sets: [], started_at: null, finished_at: null,
  sent_at: '2026-10-28T15:00:03.000Z', ...p,
});

async function mount() {
  const hook = renderHook(() => usePublicLive('copa-demo'));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  // el canal se abre cuando llega el primer payload con live_enabled (import diferido)
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(onMessage).not.toBeNull();
  return hook;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  get.mockReset(); get.mockImplementation(async () => payload());
  onMessage = null;
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('usePublicLive — refresco de la tabla (B9)', () => {
  it('mensaje con `standings`: pide el payload completo a los ~1,2 s, saltando la caché del navegador', async () => {
    await mount();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe('/api/v1/tournament-live/public/copa-demo/live');

    await act(async () => { onMessage!({ payload: push({ standings: true }) }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(STANDINGS_REFETCH_MIN_MS - 50); });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][0]).toBe('/api/v1/tournament-live/public/copa-demo/live?v=m1-9');
  });

  it('el marcador del mensaje se pinta al instante, antes del refresco', async () => {
    const { result } = await mount();
    await act(async () => { onMessage!({ payload: push({ standings: true }) }); });
    expect(result.current.data!.matches[0]).toMatchObject({ status: 'played', home_score: 2 });
  });

  it('sin la marca (BFF anterior): espera a que venza la caché de 5 s, como antes', async () => {
    await mount();
    await act(async () => { onMessage!({ payload: push() }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('un punto normal no pide nada (el mensaje basta)', async () => {
    await mount();
    await act(async () => { onMessage!({ payload: push({ status: 'live', version: 10 }) }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('liveTransport — reglas puras', () => {
  it('refetchDelayMs: con `standings` 1,2–2,5 s; sin la marca, 6–10 s; partido en juego, nada', () => {
    expect(refetchDelayMs('applied', push({ standings: true }), () => 0)).toBe(STANDINGS_REFETCH_MIN_MS);
    expect(refetchDelayMs('applied', push({ standings: true }), () => 0.999)).toBeLessThan(STANDINGS_REFETCH_MIN_MS + STANDINGS_REFETCH_SPREAD_MS);
    // reabrir: el partido vuelve a «en juego» pero la tabla cambió
    expect(refetchDelayMs('applied', push({ status: 'live', standings: true }), () => 0)).toBe(STANDINGS_REFETCH_MIN_MS);
    expect(refetchDelayMs('applied', push(), () => 0)).toBe(6000);
    expect(refetchDelayMs('applied', push({ status: 'live' }))).toBeNull();
    expect(refetchDelayMs('stale', push({ standings: true }))).toBeNull();
  });

  it('publicLivePath: sin `bust` la ruta de siempre; con `bust`, ?v= codificado', () => {
    expect(publicLivePath('copa x')).toBe('/api/v1/tournament-live/public/copa%20x/live');
    expect(publicLivePath('copa', 'm1-9')).toBe('/api/v1/tournament-live/public/copa/live?v=m1-9');
  });
});
