import { useState, useCallback, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { isNativePlatform } from '@/lib/openExternalUrl';
import { syncDeviceRegistration } from '@/hooks/useDeviceContext';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

/**
 * Hook para solicitar permiso de notificaciones push.
 *
 * Dos caminos, y hay que respetarlos:
 * - NATIVO (Capacitor): permiso del SO + token FCM/APNS via
 *   @capacitor/push-notifications, y el token viaja al BFF en `user_devices`.
 * - WEB/PWA: VAPID + service worker + `pushManager`, y la suscripcion queda en
 *   `push_subscriptions` de Supabase. Requiere VITE_VAPID_PUBLIC_KEY.
 *
 * OJO: hasta 2026-08-17 este hook solo tenia el camino web, y el banner lo
 * llamaba sin mirar la plataforma. Dentro de la app Android el WebView no
 * implementa la Push API, asi que `pushManager` reventaba siempre y el usuario
 * veia "No se pudo activar notificaciones push" sin ninguna forma de activarlas.
 * Si alguien vuelve a quitar el guard de nativo, se repite.
 */
export function usePushSubscription() {
  const { user } = useAuth();
  const [status, setStatus] = useState<'idle' | 'loading' | 'granted' | 'denied' | 'unsupported'>('idle');

  const subscribe = useCallback(async () => {
    if (!user) {
      toast.error('Debes iniciar sesión para activar notificaciones push');
      return false;
    }

    // ── Camino NATIVO ────────────────────────────────────────────────────────
    if (isNativePlatform()) {
      setStatus('loading');
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications');

        let perm = await PushNotifications.checkPermissions();
        if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
          perm = await PushNotifications.requestPermissions();
        }
        if (perm.receive !== 'granted') {
          setStatus('denied');
          // En Android, negar dos veces lo deja bloqueado: la app ya no puede
          // volver a preguntar y hay que ir a los ajustes del sistema.
          toast.info('Permiso denegado. Actívalo en los ajustes del teléfono, en Notificaciones.');
          return false;
        }

        // Re-registrar el device para que el token recien concedido llegue al BFF:
        // el registro del login pudo haber viajado sin token.
        const { pushGranted } = await syncDeviceRegistration();
        if (!pushGranted) {
          setStatus('denied');
          toast.error('No se pudo obtener el token de notificaciones. Reintenta en un momento.');
          return false;
        }

        setStatus('granted');
        toast.success('Notificaciones activadas');
        return true;
      } catch (err) {
        console.error('[push] registro nativo fallo:', err);
        setStatus('denied');
        toast.error('No se pudo activar notificaciones');
        return false;
      }
    }

    // ── Camino WEB / PWA ─────────────────────────────────────────────────────
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      setStatus('unsupported');
      toast.error('Tu navegador no soporta notificaciones push');
      return false;
    }
    if (!VAPID_PUBLIC_KEY) {
      console.warn('VITE_VAPID_PUBLIC_KEY no configurada. Genera con: npx web-push generate-vapid-keys');
      toast.error('Notificaciones push no configuradas en el servidor');
      return false;
    }

    setStatus('loading');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus('denied');
        toast.info('Permiso de notificaciones denegado');
        return false;
      }

      const registration = await navigator.serviceWorker.ready;
      const appServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);

      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        // Si la suscripción del navegador fue creada con OTRA clave VAPID
        // (rotación de llaves), el envío falla con 403. Detectarlo comparando
        // la applicationServerKey y re-suscribir con la clave actual.
        if (mismaLlave(existing, appServerKey)) {
          await saveSubscription(existing);
          setStatus('granted');
          toast.success('Notificaciones push ya activadas');
          return true;
        }
        await existing.unsubscribe(); // clave distinta → rotar
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey,
      });

      await saveSubscription(subscription);
      setStatus('granted');
      toast.success('Notificaciones push activadas');
      return true;
    } catch (err) {
      console.error('Error subscribing to push:', err);
      toast.error('No se pudo activar notificaciones push');
      setStatus('denied');
      return false;
    }
  }, [user]);

  const saveSubscription = (subscription: PushSubscription) =>
    guardarSuscripcion(user!.id, subscription);

  const checkStatus = useCallback(async () => {
    if (!('Notification' in window)) {
      setStatus('unsupported');
      return;
    }
    const perm = Notification.permission;
    if (perm === 'granted') {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setStatus(sub ? 'granted' : 'idle');
    } else if (perm === 'denied') {
      setStatus('denied');
    } else {
      setStatus('idle');
    }
  }, []);

  return { subscribe, status, checkStatus };
}

async function guardarSuscripcion(userId: string, subscription: PushSubscription) {
  const json = subscription.toJSON();
  const key = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!key || !auth) throw new Error('Invalid subscription keys');

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: key,
      auth,
      user_agent: navigator.userAgent,
    },
    // ignoreDuplicates → ON CONFLICT DO NOTHING: push_subscriptions no tiene
    // policy de UPDATE, así que un upsert sobre un endpoint ya guardado
    // fallaría por RLS. Si la fila ya existe, no hay nada que refrescar.
    { onConflict: 'endpoint', ignoreDuplicates: true }
  );
  if (error) throw error;
}

/** ¿La suscripción del navegador se creó con esta misma llave VAPID? */
function mismaLlave(sub: PushSubscription, appServerKey: Uint8Array): boolean {
  const existingKey = sub.options?.applicationServerKey;
  const existingBytes = existingKey ? new Uint8Array(existingKey) : null;
  return !!existingBytes
    && existingBytes.length === appServerKey.length
    && existingBytes.every((b, i) => b === appServerKey[i]);
}

// ── Sincronización SILENCIOSA al iniciar sesión ──────────────────────────────
//
// Por qué existe (2026-10-27): se rotó la llave VAPID. El BFF firma con la
// nueva, y las suscripciones creadas con la vieja le devuelven 401; solo les
// llegaba push por la Edge Function legacy. `subscribe()` de arriba ya sabía
// rotar, pero solo corre cuando el usuario toca el banner, y el banner NUNCA
// aparece si el permiso ya está 'granted'. Así las suscripciones viejas no
// rotaban nunca y no se podía apagar el push legacy.
//
// Corre una vez por sesión (por usuario), sin pedir permiso, sin toasts y con
// errores solo a console.warn. NUNCA llama a Notification.requestPermission.

const SYNC_KEY_PREFIX = 'sm_push_sync_';
const yaSincronizados = new Set<string>();

/** Devuelve true si es la primera vez en esta sesión para ese usuario. */
function marcarSincronizado(userId: string): boolean {
  if (yaSincronizados.has(userId)) return false;
  try {
    if (sessionStorage.getItem(SYNC_KEY_PREFIX + userId) === '1') {
      yaSincronizados.add(userId);
      return false;
    }
  } catch { /* sessionStorage bloqueado: basta el guard en memoria */ }
  yaSincronizados.add(userId);
  try { sessionStorage.setItem(SYNC_KEY_PREFIX + userId, '1'); } catch { /* idem */ }
  return true;
}

/** Solo para tests: olvida qué usuarios ya se sincronizaron. */
export function __resetSincronizacionPush() {
  yaSincronizados.clear();
}

export type ResultadoSincronizacion =
  | 'omitido'      // no aplica: nativo, sin sesión, sin permiso, prefs off, ya corrió…
  | 'refrescada'   // misma llave: solo upsert
  | 'rotada'       // llave distinta: unsubscribe + subscribe + upsert (+ borrar la vieja)
  | 'creada'       // no había suscripción y el permiso estaba concedido
  | 'error';

export async function sincronizarSuscripcionSilenciosa(opts: {
  userId: string | null | undefined;
  preferences?: Record<string, unknown> | null;
  vapidKey?: string | null;
}): Promise<ResultadoSincronizacion> {
  const { userId, preferences } = opts;
  const vapidKey = 'vapidKey' in opts ? opts.vapidKey : VAPID_PUBLIC_KEY;

  if (!userId) return 'omitido';
  if (isNativePlatform()) return 'omitido'; // nativo va por FCM / user_devices
  if (typeof window === 'undefined' || !('Notification' in window)) return 'omitido';
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'omitido';
  if (!vapidKey) return 'omitido';
  if (Notification.permission !== 'granted') return 'omitido';
  // Mismo criterio que resolvePushAllowed del BFF: solo `false` explícito apaga.
  if (preferences?.push_notifications === false) return 'omitido';
  if (!marcarSincronizado(userId)) return 'omitido';

  try {
    const registration = await navigator.serviceWorker.ready;
    if (!registration?.pushManager) return 'omitido';
    const appServerKey = urlBase64ToUint8Array(vapidKey);
    const existing = await registration.pushManager.getSubscription();

    if (existing && mismaLlave(existing, appServerKey)) {
      await guardarSuscripcion(userId, existing);
      return 'refrescada';
    }

    const endpointViejo = existing?.endpoint ?? null;
    if (existing) await existing.unsubscribe();

    const nueva = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey,
    });
    await guardarSuscripcion(userId, nueva);

    if (endpointViejo && endpointViejo !== nueva.endpoint) {
      // La policy push_subscriptions_delete_own deja borrar la fila propia.
      // Si falla no es grave: el endpoint ya está muerto tras el unsubscribe
      // y el BFF borra la fila cuando el push service responde 404/410.
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId)
        .eq('endpoint', endpointViejo);
      if (error) console.warn('[push] no se pudo borrar la suscripción vieja:', error.message);
    }
    return existing ? 'rotada' : 'creada';
  } catch (err) {
    console.warn('[push] sincronización silenciosa falló:', err);
    return 'error';
  }
}

/**
 * Monta la sincronización silenciosa. Va en AuthLayout (solo rutas con sesión).
 * Espera al perfil para poder respetar `preferences.push_notifications`.
 */
export function useSincronizarPushSilencioso() {
  const { user, profile } = useAuth();
  const userId = user?.id ?? null;
  const perfilListo = !!profile && profile.id === userId;
  const preferences = (profile?.preferences ?? null) as Record<string, unknown> | null;

  useEffect(() => {
    if (!userId || !perfilListo) return;
    void sincronizarSuscripcionSilenciosa({ userId, preferences });
    // Solo al cambiar de usuario o cargar el perfil; el guard evita repetir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, perfilListo]);
}

// El retorno se declara sobre ArrayBuffer y no sobre el ArrayBufferLike que
// asume `Uint8Array` pelado: pushManager.subscribe pide un BufferSource, y un
// Uint8Array<ArrayBufferLike> podria estar respaldado por SharedArrayBuffer.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
