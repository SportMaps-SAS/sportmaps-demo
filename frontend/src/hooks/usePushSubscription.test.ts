import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────
const upsert = vi.fn();
const deleteEqEndpoint = vi.fn();
const deleteEqUser = vi.fn(() => ({ eq: deleteEqEndpoint }));
const del = vi.fn(() => ({ eq: deleteEqUser }));
const from = vi.fn(() => ({ upsert, delete: del }));

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (...a: unknown[]) => from(...(a as [])) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, profile: null }) }));
vi.mock('@/hooks/useDeviceContext', () => ({ syncDeviceRegistration: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  sincronizarSuscripcionSilenciosa,
  __resetSincronizacionPush,
} from './usePushSubscription';
import { toast } from 'sonner';

// 'AQID' = bytes [1,2,3] · 'BAUG' = bytes [4,5,6]
const LLAVE_ACTUAL = 'AQID';
const LLAVE_VIEJA_BYTES = new Uint8Array([4, 5, 6]).buffer;
const LLAVE_ACTUAL_BYTES = new Uint8Array([1, 2, 3]).buffer;

function fakeSub(endpoint: string, key: ArrayBuffer) {
  return {
    endpoint,
    options: { applicationServerKey: key },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p' + endpoint, auth: 'a' + endpoint } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

let getSubscription: ReturnType<typeof vi.fn>;
let pmSubscribe: ReturnType<typeof vi.fn>;
let requestPermission: ReturnType<typeof vi.fn>;

function prepararNavegador(permission: NotificationPermission, existente: ReturnType<typeof fakeSub> | null) {
  requestPermission = vi.fn();
  vi.stubGlobal('Notification', { permission, requestPermission });
  getSubscription = vi.fn().mockResolvedValue(existente);
  pmSubscribe = vi.fn().mockResolvedValue(fakeSub('https://push/nuevo', LLAVE_ACTUAL_BYTES));
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: { getSubscription, subscribe: pmSubscribe } }) },
  });
}

beforeEach(() => {
  __resetSincronizacionPush();
  try { sessionStorage.clear(); } catch { /* */ }
  vi.clearAllMocks();
  upsert.mockResolvedValue({ error: null });
  deleteEqEndpoint.mockResolvedValue({ error: null });
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sincronizarSuscripcionSilenciosa', () => {
  it('misma llave: solo refresca (upsert), no rota', async () => {
    const sub = fakeSub('https://push/igual', LLAVE_ACTUAL_BYTES);
    prepararNavegador('granted', sub);

    const r = await sincronizarSuscripcionSilenciosa({ userId: 'u1', vapidKey: LLAVE_ACTUAL });

    expect(r).toBe('refrescada');
    expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(pmSubscribe).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', endpoint: 'https://push/igual' }),
      { onConflict: 'endpoint', ignoreDuplicates: true },
    );
    expect(del).not.toHaveBeenCalled();
  });

  it('llave distinta: unsubscribe + subscribe con la actual + guarda + borra la fila vieja', async () => {
    const vieja = fakeSub('https://push/viejo', LLAVE_VIEJA_BYTES);
    prepararNavegador('granted', vieja);

    const r = await sincronizarSuscripcionSilenciosa({ userId: 'u1', vapidKey: LLAVE_ACTUAL });

    expect(r).toBe('rotada');
    expect(vieja.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pmSubscribe).toHaveBeenCalledTimes(1);
    const arg = pmSubscribe.mock.calls[0][0];
    expect(arg.userVisibleOnly).toBe(true);
    expect(Array.from(arg.applicationServerKey)).toEqual([1, 2, 3]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', endpoint: 'https://push/nuevo' }),
      { onConflict: 'endpoint', ignoreDuplicates: true },
    );
    expect(deleteEqUser).toHaveBeenCalledWith('user_id', 'u1');
    expect(deleteEqEndpoint).toHaveBeenCalledWith('endpoint', 'https://push/viejo');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('si borrar la fila vieja falla, solo avisa por consola y la rotación vale', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deleteEqEndpoint.mockResolvedValue({ error: { message: 'rls' } });
    prepararNavegador('granted', fakeSub('https://push/viejo', LLAVE_VIEJA_BYTES));

    const r = await sincronizarSuscripcionSilenciosa({ userId: 'u1', vapidKey: LLAVE_ACTUAL });

    expect(r).toBe('rotada');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('permiso concedido sin suscripción: crea y guarda', async () => {
    prepararNavegador('granted', null);

    const r = await sincronizarSuscripcionSilenciosa({ userId: 'u1', vapidKey: LLAVE_ACTUAL });

    expect(r).toBe('creada');
    expect(pmSubscribe).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
  });

  it.each(['default', 'denied'] as const)('permiso %s: no hace nada ni pide permiso', async (perm) => {
    prepararNavegador(perm, fakeSub('https://push/viejo', LLAVE_VIEJA_BYTES));

    const r = await sincronizarSuscripcionSilenciosa({ userId: 'u1', vapidKey: LLAVE_ACTUAL });

    expect(r).toBe('omitido');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(getSubscription).not.toHaveBeenCalled();
    expect(pmSubscribe).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('nativo (Capacitor): no hace nada', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    prepararNavegador('granted', fakeSub('https://push/viejo', LLAVE_VIEJA_BYTES));

    const r = await sincronizarSuscripcionSilenciosa({ userId: 'u1', vapidKey: LLAVE_ACTUAL });

    expect(r).toBe('omitido');
    expect(getSubscription).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('sin sesión o sin llave VAPID: no hace nada', async () => {
    prepararNavegador('granted', null);

    expect(await sincronizarSuscripcionSilenciosa({ userId: null, vapidKey: LLAVE_ACTUAL })).toBe('omitido');
    expect(await sincronizarSuscripcionSilenciosa({ userId: 'u1', vapidKey: '' })).toBe('omitido');
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it('push desactivado en preferencias: no re-suscribe', async () => {
    prepararNavegador('granted', fakeSub('https://push/viejo', LLAVE_VIEJA_BYTES));

    const r = await sincronizarSuscripcionSilenciosa({
      userId: 'u1',
      vapidKey: LLAVE_ACTUAL,
      preferences: { push_notifications: false },
    });

    expect(r).toBe('omitido');
    expect(pmSubscribe).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('corre una sola vez por sesión (memoria y sessionStorage)', async () => {
    prepararNavegador('granted', fakeSub('https://push/igual', LLAVE_ACTUAL_BYTES));

    expect(await sincronizarSuscripcionSilenciosa({ userId: 'u1', vapidKey: LLAVE_ACTUAL })).toBe('refrescada');
    expect(await sincronizarSuscripcionSilenciosa({ userId: 'u1', vapidKey: LLAVE_ACTUAL })).toBe('omitido');
    expect(upsert).toHaveBeenCalledTimes(1);

    // Recarga de la página: se pierde la memoria, pero sessionStorage recuerda.
    __resetSincronizacionPush();
    expect(await sincronizarSuscripcionSilenciosa({ userId: 'u1', vapidKey: LLAVE_ACTUAL })).toBe('omitido');
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('nunca muestra toasts, ni siquiera si falla', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    upsert.mockResolvedValue({ error: { message: 'boom' } });
    prepararNavegador('granted', fakeSub('https://push/igual', LLAVE_ACTUAL_BYTES));

    const r = await sincronizarSuscripcionSilenciosa({ userId: 'u1', vapidKey: LLAVE_ACTUAL });

    expect(r).toBe('error');
    expect(warn).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
