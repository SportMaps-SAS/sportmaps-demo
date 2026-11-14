/**
 * Cómo llegar a una cancha (mig. embudo_y_agenda_clase_prueba: `facilities`
 * gana `address`, `maps_url` e `indicaciones`). El bot de WhatsApp lo manda al
 * agendar la clase de prueba: «📍 Parque Pinar de Suba 2 · enlace de Maps ·
 * entrada de deportistas por la puerta 2; si llueve, te avisamos por aquí».
 *
 * Sin la migración, el formulario de la instalación no muestra estos campos y
 * guarda exactamente lo de siempre.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface UbicacionCancha {
  address?: string | null;
  maps_url?: string | null;
  indicaciones?: string | null;
}

export const LIMITES_UBICACION = { address: 200, maps_url: 500, indicaciones: 600 } as const;

/** null si está bien. Vacío vale (el campo es opcional). */
export function errorEnlaceMaps(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  if (!/^https?:\/\/\S+$/i.test(t)) return 'Pega el enlace completo (empieza por https://).';
  if (t.length > LIMITES_UBICACION.maps_url) return 'El enlace es muy largo.';
  return null;
}

/**
 * Lo que va a la base: SOLO las claves que vienen (undefined = la base no tiene
 * las columnas o el formulario no las mostró → no se mandan), recortadas, y el
 * texto vacío como NULL.
 */
export function camposUbicacion(input: UbicacionCancha): UbicacionCancha {
  const out: UbicacionCancha = {};
  (Object.keys(LIMITES_UBICACION) as (keyof UbicacionCancha)[]).forEach((k) => {
    const v = input[k];
    if (v === undefined) return;
    const t = (v ?? '').trim().slice(0, LIMITES_UBICACION[k]);
    out[k] = t || null;
  });
  return out;
}

/** ¿La base ya tiene las columnas? Se pregunta una vez por sesión. */
export function useUbicacionCanchaDisponible(schoolId: string | null | undefined, enabled = true) {
  const q = useQuery({
    queryKey: ['facilities-ubicacion-disponible'],
    enabled: !!schoolId && enabled,
    staleTime: Infinity,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- columnas nuevas, todavía fuera de types.ts
      const { error } = await (supabase as any)
        .from('facilities').select('address, maps_url, indicaciones').eq('school_id', schoolId).limit(1);
      // Columna inexistente (42703) o cualquier otro error: los campos no se muestran.
      return !error;
    },
  });
  return q.data === true;
}
