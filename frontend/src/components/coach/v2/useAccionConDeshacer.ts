/**
 * «Guardar con Deshacer» de la V2: la escritura se programa y corre a los 8 s.
 * Si el profe toca «Deshacer» antes, no se escribe nada (no hay que revertir
 * en la base cosas que ya avisaron a las familias).
 *
 * Lo pendiente NUNCA se pierde:
 *  - si la pantalla se desmonta (navegar dentro de la app), se ejecuta ya;
 *  - si la app se va a segundo plano, se cierra o se recarga (`visibilitychange`
 *    a `hidden` o `pagehide`), también se ejecuta ya (B8: antes solo se
 *    ejecutaba al desmontar y una recarga en los 8 s perdía la convocatoria,
 *    la evaluación o la felicitación). `visibilitychange` llega antes de que
 *    el sistema congele la pestaña en el celular, así que la petición alcanza
 *    a salir.
 */
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

export const DESHACER_MS = 8000;

interface Pendiente {
  timer: ReturnType<typeof setTimeout>;
  run: () => Promise<void>;
}

/**
 * Cola de acciones con Deshacer, sin React (se prueba con timers falsos).
 * Cada acción tiene un id: programar el mismo id reemplaza la anterior.
 */
export class ColaDeshacer {
  private pendientes = new Map<string, Pendiente>();

  constructor(private readonly ms: number = DESHACER_MS) {}

  programar(id: string, run: () => Promise<void>): void {
    const previo = this.pendientes.get(id);
    if (previo) clearTimeout(previo.timer);
    const timer = setTimeout(() => { void this.ejecutar(id); }, this.ms);
    this.pendientes.set(id, { timer, run });
  }

  /** Cancela sin ejecutar. Devuelve false si ya se había ejecutado. */
  deshacer(id: string): boolean {
    const p = this.pendientes.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pendientes.delete(id);
    return true;
  }

  async ejecutar(id: string): Promise<void> {
    const p = this.pendientes.get(id);
    if (!p) return;
    this.pendientes.delete(id);
    clearTimeout(p.timer);
    await p.run();
  }

  /** Ejecuta ya todo lo pendiente (salir de la pantalla o de la app). */
  vaciar(): void {
    for (const id of [...this.pendientes.keys()]) void this.ejecutar(id);
  }

  tiene(id: string): boolean {
    return this.pendientes.has(id);
  }

  get tamano(): number {
    return this.pendientes.size;
  }
}

export interface OpcionesProgramar {
  /** Cómo se ve el aviso. `info` cuando el éxito real se avisa después de escribir. */
  tono?: 'exito' | 'info';
}

export function useAccionConDeshacer() {
  const cola = useRef<ColaDeshacer>();
  if (!cola.current) cola.current = new ColaDeshacer();

  const ejecutar = useCallback((id: string) => cola.current!.ejecutar(id), []);

  /**
   * Programa `run` y muestra el aviso con «Deshacer».
   * `onDeshacer` restaura lo que la pantalla ya mostró como hecho.
   */
  const programar = useCallback(
    (id: string, mensaje: string, run: () => Promise<void>, onDeshacer?: () => void, opciones?: OpcionesProgramar) => {
      cola.current!.programar(id, run);
      const mostrar = opciones?.tono === 'info' ? toast : toast.success;
      mostrar(mensaje, {
        id: `deshacer-${id}`,
        duration: DESHACER_MS,
        action: {
          label: 'Deshacer',
          onClick: () => {
            if (cola.current!.deshacer(id)) onDeshacer?.();
          },
        },
      });
    },
    [],
  );

  const hayPendiente = useCallback((id: string) => cola.current!.tiene(id), []);

  useEffect(() => {
    const c = cola.current!;
    const alOcultar = () => {
      if (document.visibilityState === 'hidden') c.vaciar();
    };
    const alSalir = () => c.vaciar();
    document.addEventListener('visibilitychange', alOcultar);
    window.addEventListener('pagehide', alSalir);
    return () => {
      document.removeEventListener('visibilitychange', alOcultar);
      window.removeEventListener('pagehide', alSalir);
      // Salir de la pantalla no cancela: lo que se guardó, se guarda.
      c.vaciar();
    };
  }, []);

  return { programar, hayPendiente, ejecutarYa: ejecutar };
}
