/**
 * directo/tope — interruptor de las capas sin modelo y tope mensual de turnos
 * CON modelo por escuela (docs/specs/mapi-consultas-sin-ia.md §Control de gasto).
 *
 *   · MAPI_SIN_MODELO (por defecto 'true'): 'false' apaga las capas 1 y 2 y el
 *     tope, y Mapi vuelve a como estaba (todo al modelo).
 *   · MAPI_TOPE_TURNOS_MES (por defecto 500; 0 = sin tope): llamadas al modelo
 *     de la escuela en el mes calendario de Colombia. Al llegar, el texto libre
 *     recibe un mensaje fijo y NO va al modelo; las capas 1 y 2 siguen.
 *
 * Qué se cuenta: las filas de `llm_usage` con feature 'mapi_agente' (la app y
 * WhatsApp usan la misma; los evals van con 'mapi_evals' y no cuentan). Cada
 * fila es UNA llamada al modelo: un turno con herramientas hace 2 o 3, así que
 * el tope corta antes que «turnos» (lado seguro). Sin migración: el índice
 * (school_id, created_at) ya existe (20261008164445).
 *
 * Disk IO (CLAUDE.md): una sola consulta `count` por turno que va al modelo,
 * con `head: true` (no trae filas), filtrada por escuela y fecha. Nunca por las
 * capas 1 y 2. Si la cuenta falla, NO se bloquea (la telemetría no apaga Mapi).
 */

import { supabase } from '../../../config/supabase';

export const FEATURES_CONTADAS = ['mapi_agente'] as const;
export const TOPE_POR_DEFECTO = 500;

/** ¿Están prendidas las capas sin modelo (y el tope)? */
export function sinModeloActivo(): boolean {
    return process.env.MAPI_SIN_MODELO !== 'false';
}

/** Tope mensual por escuela; 0 = sin tope. */
export function topeTurnosMes(): number {
    const v = process.env.MAPI_TOPE_TURNOS_MES;
    if (v === undefined || v.trim() === '') return TOPE_POR_DEFECTO;
    const k = Number(v);
    return Number.isFinite(k) && k >= 0 ? Math.floor(k) : TOPE_POR_DEFECTO;
}

/** 00:00 del primer día del mes en Bogotá (UTC-5, sin horario de verano) como instante UTC. Pura. */
export function inicioDelMesColombia(hoy: string): string {
    return `${hoy.slice(0, 7)}-01T05:00:00.000Z`;
}

/** Llamadas al modelo de la escuela en el mes; null si no se pudo contar. */
export async function turnosConModeloDelMes(schoolId: string, hoy: string): Promise<number | null> {
    try {
        const { count, error } = await supabase.from('llm_usage')
            .select('id', { count: 'exact', head: true })
            .eq('school_id', schoolId)
            .in('feature', [...FEATURES_CONTADAS])
            .gte('created_at', inicioDelMesColombia(hoy));
        if (error) {
            console.warn('[mapi-directo] no se pudo contar el uso del mes', { err: error.message });
            return null;
        }
        return count ?? 0;
    } catch (err: any) {
        console.warn('[mapi-directo] no se pudo contar el uso del mes', { err: err?.message || String(err) });
        return null;
    }
}

/** ¿La escuela ya llegó al tope de este mes? false si está apagado o no se pudo contar. */
export async function topeMensualAlcanzado(a: { schoolId: string; hoy: string }): Promise<boolean> {
    if (!sinModeloActivo()) return false;
    const tope = topeTurnosMes();
    if (!tope) return false;
    const usados = await turnosConModeloDelMes(a.schoolId, a.hoy);
    return usados !== null && usados >= tope;
}

export const TEXTO_TOPE = 'Este mes tu escuela ya usó todas las respuestas libres de Mapi. Sigo respondiendo al instante las consultas frecuentes: escribe «menú» para verlas, o pregunta, por ejemplo, «quién debe», «por validar» o «asistencia de hoy». Para lo demás, escríbele a soporte.';
