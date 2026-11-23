/**
 * Reconexión escalonada de React Query (modo offline, Fase 1).
 *
 * Problema: al volver la red, `refetchOnReconnect: 'always'` hace que TODOS los celulares que
 * estaban sin señal refresquen sus consultas activas en el mismo segundo. La base es UNA sola
 * para dev, stg y prod, y una ráfaga así es el patrón que la tumbó el 2026-10-14 (ver CLAUDE.md,
 * «Disk IO»).
 *
 * Solución: React Query se entera de que volvió la red con un retraso aleatorio de 0–`maxJitterMs`.
 * Solo afecta a React Query (reanudar consultas pausadas y el refetch al reconectar): las colas de
 * envío (asistencia, partido en vivo) siguen reaccionando al evento `online` del navegador sin
 * esperar, porque lo que el entrenador guardó en la cancha debe subir cuanto antes.
 *
 * Además, React Query v5 arranca asumiendo que hay red. Si la app se abre SIN señal, las consultas
 * fallaban (y reintentaban) en vez de quedar en pausa mostrando lo guardado. Aquí se lee
 * `navigator.onLine` al arrancar.
 */
import { onlineManager } from '@tanstack/react-query';
import { OFFLINE_ENABLED, sinRedAhora } from './offlineConfig';

export const JITTER_RECONEXION_MS = 5000;

export function configurarReconexionEscalonada(maxJitterMs: number = JITTER_RECONEXION_MS): void {
  if (!OFFLINE_ENABLED || typeof window === 'undefined') return;
  onlineManager.setEventListener((setOnline) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const alVolver = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; setOnline(true); }, Math.floor(Math.random() * Math.max(0, maxJitterMs)));
    };
    const alIrse = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      setOnline(false);
    };
    window.addEventListener('online', alVolver);
    window.addEventListener('offline', alIrse);
    // Estado inicial real (RQ asume «con red» hasta el primer evento).
    setOnline(!sinRedAhora());
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', alVolver);
      window.removeEventListener('offline', alIrse);
    };
  });
}
