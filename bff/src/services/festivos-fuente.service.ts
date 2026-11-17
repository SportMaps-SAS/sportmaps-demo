/**
 * festivos-fuente — lee los festivos de la tabla `co_holidays` (la fuente única)
 * y los deja en `utils/festivos-colombia`, que es lo que consultan la cobranza,
 * las campañas y los estados de cuenta.
 *
 * Una lectura al arrancar y otra cada 24 h (una sola consulta, ~60 filas). Si la
 * base no contesta, queda el cálculo local como red de seguridad: nunca lanza.
 */

import { supabase } from '../config/supabase';
import { fijarFestivosDeLaBase } from '../utils/festivos-colombia';

const CADA_MS = 24 * 3600_000;

/** Lee `co_holidays` desde el año pasado en adelante y lo deja en memoria. Nunca lanza. */
export async function cargarFestivosDeLaBase(ahora = new Date()): Promise<{ anios: number[]; diferencias: string[] } | null> {
    try {
        const desde = `${ahora.getUTCFullYear() - 1}-01-01`;
        const { data, error } = await supabase.from('co_holidays')
            .select('holiday_date').gte('holiday_date', desde).order('holiday_date').limit(400);
        if (error || !Array.isArray(data)) {
            console.warn(`[festivos] no se pudo leer co_holidays (${error?.message ?? 'sin datos'}): se usa el cálculo local.`);
            return null;
        }
        const r = fijarFestivosDeLaBase((data as { holiday_date: string }[]).map((f) => f.holiday_date));
        if (r.diferencias.length) {
            console.warn(`[festivos] la tabla co_holidays y el cálculo no coinciden: ${r.diferencias.join(', ')}. Manda la tabla.`);
        }
        return r;
    } catch (err: any) {
        console.warn(`[festivos] no se pudo leer co_holidays (${err?.message ?? 'error'}): se usa el cálculo local.`);
        return null;
    }
}

/** Arranque: primera lectura y refresco diario (no retiene el proceso). */
export function iniciarFestivosDeLaBase(): void {
    void cargarFestivosDeLaBase();
    const t = setInterval(() => { void cargarFestivosDeLaBase(); }, CADA_MS);
    t.unref?.();
}
