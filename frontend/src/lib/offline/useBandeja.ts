/**
 * Enganche de React para la bandeja de salida y la vista unificada de pendientes.
 *
 *  · `obtenerBandeja(userId)`: UNA instancia por usuario en esta pestaña (la pantalla que encola y el
 *    sincronizador global comparten la misma; entre pestañas manda el candado y el canal).
 *  · `useSincronizadorBandeja(userId)`: lo monta el layout del entrenador. Envía al abrir, al volver la
 *    red (`online`), al volver a primer plano (iOS no tiene Background Sync) y cuando se cumple la espera
 *    del próximo intento — un solo temporizador, sin sondeo.
 *  · `usePendientes(userId)`: lo que ve la banda y la pantalla «Pendientes».
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bandeja, type EventoBandeja } from './bandeja';
import { enviarEvaluacion, TIPO_EVALUAR } from './bandejaEvaluar';
import { enviarAutoeval, TIPO_AUTOEVAL } from './bandejaAutoeval';
import { armarPendientes, type PendienteVista } from './pendientesModel';
import { OFFLINE_ENABLED } from './offlineConfig';
import { obtenerCola, useEnLinea } from '@/components/coach/v2/useCoachV2Senal';

const bandejas = new Map<string, { bandeja: Bandeja; oyentes: Set<() => void> }>();

export function obtenerBandeja(userId: string) {
  let e = bandejas.get(userId);
  if (!e) {
    const oyentes = new Set<() => void>();
    const bandeja = new Bandeja({
      userId,
      manejadores: { [TIPO_EVALUAR]: enviarEvaluacion, [TIPO_AUTOEVAL]: enviarAutoeval },
      onChange: () => oyentes.forEach((f) => f()),
    });
    e = { bandeja, oyentes };
    bandejas.set(userId, e);
    void bandeja.cargar(true);
  }
  return e;
}

/** Solo para pruebas. */
export function __reiniciarBandejasParaPruebas() {
  bandejas.forEach((e) => e.bandeja.cerrar());
  bandejas.clear();
}

export function useSincronizadorBandeja(userId: string | null | undefined, onEventos?: (ev: EventoBandeja[]) => void) {
  const onEventosRef = useRef(onEventos);
  onEventosRef.current = onEventos;

  useEffect(() => {
    if (!userId || !OFFLINE_ENABLED) return;
    const { bandeja, oyentes } = obtenerBandeja(userId);
    let activo = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const programar = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      const proximo = bandeja.proximoIntento();
      if (!activo || proximo == null) return;
      timer = setTimeout(() => { void enviar(false); }, Math.max(1000, proximo - Date.now()));
    };
    const enviar = async (force: boolean) => {
      const ev = await bandeja.flush(force);
      if (activo && ev.length) onEventosRef.current?.(ev);
      programar();
    };

    void bandeja.cargar(true).then(() => { if (activo) void enviar(true); });
    const alCambiar = () => programar();
    oyentes.add(alCambiar);
    const online = () => { void enviar(true); };
    const vis = () => { if (document.visibilityState === 'visible') { void bandeja.cargar(true).then(() => enviar(false)); } };
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', vis);
    return () => {
      activo = false;
      if (timer) clearTimeout(timer);
      oyentes.delete(alCambiar);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [userId]);
}

export function usePendientes(userId: string | null | undefined) {
  const [, setTick] = useState(0);
  const enLinea = useEnLinea();
  const entradaCola = userId ? obtenerCola(userId) : null;
  const entradaBandeja = userId && OFFLINE_ENABLED ? obtenerBandeja(userId) : null;

  useEffect(() => {
    const f = () => setTick((t) => t + 1);
    entradaCola?.oyentes.add(f);
    entradaBandeja?.oyentes.add(f);
    return () => { entradaCola?.oyentes.delete(f); entradaBandeja?.oyentes.delete(f); };
  }, [entradaCola, entradaBandeja]);

  const vistas = armarPendientes(entradaCola?.cola.todas() ?? [], entradaBandeja?.bandeja.todas() ?? []);

  const reintentar = useCallback(async (p: PendienteVista) => {
    if (p.origen === 'asistencia') { if (entradaCola?.cola.reintentar(p.id)) void entradaCola.cola.flush(true); return; }
    if (entradaBandeja && await entradaBandeja.bandeja.reintentar(p.id)) void entradaBandeja.bandeja.flush(true);
  }, [entradaCola, entradaBandeja]);

  const descartar = useCallback(async (p: PendienteVista) => {
    if (p.origen === 'asistencia') { entradaCola?.cola.descartar(p.id); return; }
    await entradaBandeja?.bandeja.descartar(p.id);
  }, [entradaCola, entradaBandeja]);

  return useMemo(() => ({ vistas, enLinea, reintentar, descartar }), [vistas, enLinea, reintentar, descartar]);
}
