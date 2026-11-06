import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGuestReservation, guestCheckout, publicUrl, RESERVATIONS_BASE } from './reservasApi';

const ok = (body: unknown, status = 200) => ({ ok: true, status, headers: new Headers(), json: async () => body }) as unknown as Response;

describe('cabeceras de invitado (contrato BFF)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('POST / envía X-Guest-Token + Idempotency-Key y NUNCA Authorization', async () => {
    fetchMock.mockResolvedValue(ok({ reservation: { id: 'r1' }, status_token: 'st', status_path: '/r/st' }, 201));
    const r = await createGuestReservation('GT', 'idem-1', { facility_id: 'f', starts_at: 'a', ends_at: 'b', payment_method: 'online', participants: 2 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(publicUrl(''));
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h['X-Guest-Token']).toBe('GT');
    expect(h['Idempotency-Key']).toBe('idem-1');
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(h['X-Reservation-Token']).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ facility_id: 'f', starts_at: 'a', ends_at: 'b', payment_method: 'online', participants: 2 });
    expect(r.status_token).toBe('st');
  });

  it('checkout envía X-Reservation-Token (token de estado) y NUNCA Authorization', async () => {
    fetchMock.mockResolvedValue(ok({ checkout_url: 'https://pay' }));
    await guestCheckout('res-1', 'ST');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RESERVATIONS_BASE}/res-1/checkout`);
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h['X-Reservation-Token']).toBe('ST');
    expect(h['X-Guest-Token']).toBeUndefined();
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('authorization');
  });
});
