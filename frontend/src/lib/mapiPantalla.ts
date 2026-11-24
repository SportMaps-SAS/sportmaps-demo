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

let actual: EntidadMapi | null = null;

export function entidadParaMapi(): EntidadMapi | null {
    return actual;
}

/** Mientras el componente esté montado, Mapi sabe qué entidad hay en pantalla. */
export function useEntidadParaMapi(entidad: EntidadMapi | null | undefined): void {
    const clave = entidad ? `${entidad.tipo}|${entidad.id}` : '';
    useEffect(() => {
        if (!entidad) return;
        actual = entidad;
        return () => {
            if (actual && `${actual.tipo}|${actual.id}` === clave) actual = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clave]);
}

/** Lo que el chat manda al BFF en cada mensaje. */
export function pantallaParaMapi(ruta: string = typeof window !== 'undefined' ? window.location.pathname : ''): { ruta: string; entidad?: EntidadMapi } {
    return actual ? { ruta, entidad: actual } : { ruta };
}
