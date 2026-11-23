import { requestPwaReload } from './reloadGuard';
import { OFFLINE_ENABLED } from '@/lib/offline/offlineConfig';
import { leerSesionGuardada } from '@/lib/offline/arranqueSinRed';
import { convienePrecargar } from './precacheBuild';

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  // En desarrollo NO registramos el SW: el dev-SW se regenera con cada HMR y
  // dispara controllerchange en cada cambio → recargas en bucle mientras se
  // trabaja. El SW solo aporta valor en producción.
  if (import.meta.env.DEV) return;

  // Dentro del APK/IPA no aporta (no hay red offline que cachear ni una URL
  // pública que actualizar) y arrastra la misma lógica de recarga por
  // controllerchange que en la PWA no tiene sentido dentro de un WebView nativo.
  if ((window as any).Capacitor?.isNativePlatform?.()) return;

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      type: 'module'
    });
    console.log('[PWA] SW registrado:', reg.scope);

    // Auto-actualización: cuando el nuevo SW toma control (sw.js hace skipWaiting+
    // claim), recargamos UNA vez para servir el bundle nuevo. Así el usuario no ve
    // la versión vieja ni tiene que darle "Actualizar ahora" manual. Solo si ya
    // había un controller (es una ACTUALIZACIÓN, no la primera instalación) — así
    // no recargamos innecesariamente en la primera visita.
    //
    // GUARD PERSISTENTE (sessionStorage): el flag sobrevive al reload. Si tras
    // recargar el controller vuelve a cambiar (p.ej. instancias del servidor
    // sirviendo builds distintos, o un SW clásico vs módulo re-registrándose),
    // NO recargamos otra vez → corta el bucle de recargas. Máximo un reload por
    // sesión y por versión de SW.
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // Diferido si hay un flujo crítico activo (p.ej. modal de pago con un
        // comprobante ya subido): recarga cuando se libere, no en medio del pago.
        requestPwaReload();
      });
    }

    // Detectar actualización disponible
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker?.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // Hay nueva versión disponible → notificar al usuario
          window.dispatchEvent(new CustomEvent('pwa:update-available'));
          // Opcional: recargar automáticamente si registerType es autoUpdate
          // window.location.reload();
        }
      });
    });

    // ── Chequeo de versión ────────────────────────────────────────────────────
    //
    // El navegador vuelve a pedir /sw.js en cada NAVEGACIÓN real, pero esta es una
    // SPA: después de la primera carga el routing es client-side y no cuenta. El
    // único disparador era el setInterval de 60 min, así que con la app abierta se
    // podía correr código viejo hasta una hora y un fix desplegado no llegaba.
    //
    // El regreso a la app es el momento natural para mirar: el acudiente sale a la
    // app de su banco a hacer la transferencia y vuelve. Ahí se chequea.
    let lastCheck = Date.now();
    const checkForUpdate = () => {
      // Throttle: volver al foco dispara visibilitychange Y focus, y en móvil el
      // cambio de app los repite. Sin esto se llamaría a update() varias veces
      // por cada regreso.
      const now = Date.now();
      if (now - lastCheck < 60 * 1000) return;
      lastCheck = now;
      // Sin red update() rechaza; no es un error que valga romper nada — el
      // interval y la próxima visita reintentan.
      reg.update().catch(() => {});
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    });
    window.addEventListener('focus', checkForUpdate);

    // Respaldo para la pestaña que queda abierta y visible horas (p.ej. el panel
    // de la escuela en un escritorio), donde no hay foco ni visibilidad que cambie.
    setInterval(checkForUpdate, 60 * 60 * 1000);

    // ── Precarga para abrir sin señal ─────────────────────────────────────────
    // Con la página ociosa, con sesión guardada y con red buena, se le pide al SW que baje el
    // build que falta. Sin sesión (landing pública) no se gastan datos. Idempotente: el SW solo
    // pide lo que no tiene, así que repetirlo en cada visita cuesta casi nada.
    if (OFFLINE_ENABLED) {
      const pedirPrecarga = () => {
        const nav = navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } };
        if (!convienePrecargar({
          online: navigator.onLine !== false,
          saveData: nav.connection?.saveData,
          effectiveType: nav.connection?.effectiveType ?? null,
          haySesion: !!leerSesionGuardada(),
        })) return;
        navigator.serviceWorker.ready
          .then((r) => r.active?.postMessage({ type: 'PRECACHE_BUILD' }))
          .catch(() => {});
      };
      const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
      const cuandoOcioso = () => (idle ? idle(pedirPrecarga, { timeout: 15000 }) : setTimeout(pedirPrecarga, 8000));
      // Tras la carga + un respiro: no compite con el login ni con las primeras consultas.
      if (document.readyState === 'complete') setTimeout(cuandoOcioso, 5000);
      else window.addEventListener('load', () => setTimeout(cuandoOcioso, 5000), { once: true });
      // Si el usuario inicia sesión DESPUÉS de cargar la página, se intenta al volver a primer plano.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') cuandoOcioso();
      });
    }

  } catch (err) {
    console.error('[PWA] Error registrando SW:', err);
  }
}
