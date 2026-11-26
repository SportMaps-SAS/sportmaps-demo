/**
 * rpc-por — las RPC «como la persona» llamadas por el BFF a nombre de un actor
 * (docs/specs/mapi-rpc-por-actor-plan.md, migraciones 20261126101055 y 20261126101150).
 *
 * Por WhatsApp no hay JWT: quien habla es el número suscrito. Cada RPC de pantalla
 * que autoriza con auth.uid() tiene una `<rpc>_por(p_actor, …)` que solo ejecuta
 * service_role. La base valida el rol del actor en la escuela del objeto, fija el
 * actor en la transacción (auditoría incluida) y llama a la RPC original. El actor
 * es SIEMPRE `alcance.userId` (la sesión o la suscripción), nunca algo del modelo.
 *
 * DESPLIEGUE: este código necesita las dos migraciones aplicadas. Sin ellas, cada
 * llamada responde PGRST202 y la herramienta dice «todavía no está disponible».
 */

import { supabase } from '../../config/supabase';
import type { Alcance } from './tipos';

/** Las RPC que tienen `_por` (lista cerrada: el nombre nunca sale del modelo). */
export const RPC_POR = [
    'preview_enrollment_pause',
    'pause_enrollment_directly',
    'resume_enrollment',
    'set_school_athlete_status',
    'submit_post_training_coach_rating',
    'give_kudos',
    'clases_prueba_semana',
    'listar_clase_prueba',
    'agendar_clase_prueba_desde_chat',
    'aprobar_comprobante',
    'register_manual_payments',
] as const;
export type RpcPor = (typeof RPC_POR)[number];

export interface ErrorRpc { code?: string; message?: string; details?: string; hint?: string }

/** Llama `<nombre>_por` con service_role y `p_actor = alcance.userId`. */
export async function rpcPor<T = any>(a: Alcance, nombre: RpcPor, args: Record<string, unknown>):
    Promise<{ data: T | null; error: ErrorRpc | null }> {
    const { data, error } = await supabase.rpc(`${nombre}_por`, { p_actor: a.userId, ...args });
    return { data: (data ?? null) as T | null, error: (error as ErrorRpc | null) ?? null };
}

const DE_CONFIGURACION = /^(solo_servidor|actor_requerido|actor_distinto|rol_invalido|canal_invalido|faltan_datos|tope_invalido)\b/;

/**
 * Los errores propios de la `_por` (gate y configuración), en palabras para la
 * persona. null = el error es de la RPC original: lo traduce su mapeador de siempre.
 */
export function motivoDeLaPor(error: ErrorRpc | null | undefined, nombre?: string): string | null {
    if (!error) return null;
    const msg = String(error.message ?? '');
    if (error.code === 'PGRST202' || /Could not find the function/i.test(msg)) {
        return 'Esta acción todavía no está disponible: falta actualizar la base. Hazla desde la pantalla.';
    }
    if (/^sin_permiso\b/.test(msg)) return 'Esto no lo puedes hacer en esta escuela: tu rol aquí no lo permite.';
    if (/^no_encontrado\b/.test(msg)) return 'No encontré eso en esta escuela.';
    if (DE_CONFIGURACION.test(msg)) {
        console.error('[mapi-agente] _por mal llamada', { nombre, code: error.code, msg });
        return 'No pude hacerlo por un problema de configuración. Ya quedó registrado; inténtalo desde la pantalla.';
    }
    return null;
}
