/**
 * Contexto de pantalla para Mapi (docs/specs/mapi-agente-plan.md §3.3):
 * «dame el reporte de ESTA niña» con la ficha abierta.
 *
 * Una pantalla que muestra UN deportista o UN equipo lo anuncia con
 * `useEntidadParaMapi(...)`; el chat lo manda con cada mensaje junto a la ruta.
 * El BFF valida que la entidad sea de la escuela (y de los equipos del coach)
 * antes de dársela al modelo: aquí no se confía en nada.
 */
import { useEffect } from 'react';

export type EntidadMapi =
    /** id con el formato del agente: «child:<uuid>», «adult:<uuid>», «unregistered:<uuid>». */
    | { tipo: 'deportista'; id: string }
    | { tipo: 'equipo'; id: string };

/** Pila: la ficha abierta encima del equipo manda mientras está; al cerrarla vuelve el equipo. */
const pila: EntidadMapi[] = [];

export function entidadParaMapi(): EntidadMapi | null {
    return pila[pila.length - 1] ?? null;
}

/** Mientras el componente esté montado, Mapi sabe qué entidad hay en pantalla. */
export function useEntidadParaMapi(entidad: EntidadMapi | null | undefined): void {
    const clave = entidad ? `${entidad.tipo}|${entidad.id}` : '';
    useEffect(() => {
        if (!entidad) return;
        const propia = entidad;
        pila.push(propia);
        return () => {
            const i = pila.lastIndexOf(propia);
            if (i >= 0) pila.splice(i, 1);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clave]);
}

/** Lo que el chat manda al BFF en cada mensaje. */
export function pantallaParaMapi(ruta: string = typeof window !== 'undefined' ? window.location.pathname : ''): { ruta: string; entidad?: EntidadMapi } {
    const entidad = entidadParaMapi();
    return entidad ? { ruta, entidad } : { ruta };
}
