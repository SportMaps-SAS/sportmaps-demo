/**
 * Estado de opt-in del contacto — el ESTADO, no el evento.
 *
 * Por qué existe. La ingesta devuelve `opted_out: true` solo cuando **el mensaje
 * actual** trae una palabra de baja (STOP, baja, no molestar…). Eso alcanza para
 * confirmar la baja en el momento, pero no para saber si alguien que se dio de
 * baja *antes* sigue dado de baja.
 *
 * El bug que esto arregla, medido el 2026-09-11 en la conversación de prueba:
 *
 *   11:36:07  «Stop»  → opt-out registrado, se le responde «no volverás a
 *                       recibir mensajes automáticos»
 *   17:38:47  imagen  → como una imagen no trae texto, la ingesta devolvió
 *                       opted_out=false y el bot la proceso y le respondio
 *
 * Nadie consultaba `whatsapp_optins`. Se miraba el evento y nunca el estado.
 */

import { supabase } from '../config/supabase';

/**
 * ¿Este contacto pidió que no le escriban?
 *
 * `opted_out_at` no null y posterior al `opted_in_at` (si lo hay). Ante la duda
 * —error de consulta— devuelve `false`: dejar de responderle a alguien que SÍ
 * dio consentimiento es peor que el caso contrario, porque queda hablando solo.
 */
export async function estaDadoDeBaja(
    integrationId: string,
    contactWaId: string,
): Promise<boolean> {
    const { data, error } = await supabase
        .from('whatsapp_optins')
        .select('opted_in_at, opted_out_at')
        .eq('integration_id', integrationId)
        .eq('contact_wa_id', contactWaId)
        .maybeSingle();

    if (error || !data?.opted_out_at) return false;
    if (!data.opted_in_at) return true;
    return new Date(data.opted_out_at) >= new Date(data.opted_in_at);
}

/**
 * Coletilla para quien está dado de baja pero nos escribió.
 *
 * Decisión de producto: se le responde igual. La baja silencia los mensajes
 * *automáticos proactivos* —que es lo que se le prometió—, pero si él inicia el
 * contacto, dejarlo hablando solo es peor. Lo que no puede pasar es que reciba
 * respuesta sin enterarse de que sigue con las notificaciones apagadas.
 */
export const AVISO_DADO_DE_BAJA =
    '\n\n_Tienes las notificaciones de la escuela apagadas. Escríbeme *ACTIVAR* si quieres volver a recibirlas._';

// ─── Baja de PROMOCIONES (2026-11-15, migración 20261115143758) ─────────────
// Distinta de la baja total (`opted_out_at`): quien toca «No recibir más» en una
// campaña deja de recibir promociones, pero sigue recibiendo sus avisos de pago.

/** Registra la baja de promociones (botón de campaña). Nunca toca la baja total. Nunca lanza. */
export async function registrarBajaDePromos(
    integration: { id: string; school_id: string }, contactWaId: string, ref: string | null,
): Promise<boolean> {
    try {
        const { error } = await supabase.rpc('wa_registrar_baja_promos', {
            p_integration_id: integration.id, p_school_id: integration.school_id,
            p_contact_wa_id: contactWaId, p_ref: ref,
        });
        if (error) console.error('[whatsapp-optin] wa_registrar_baja_promos', { err: error.message });
        return !error;
    } catch {
        return false;
    }
}

/**
 * Levanta la baja de promociones porque la PERSONA lo pidió (escribió ACTIVAR o
 * aceptó recibir novedades). Una inscripción o una invitación no llaman acá.
 * true = había una baja y se levantó. Nunca lanza.
 */
export async function levantarBajaDePromos(integrationId: string, contactWaId: string): Promise<boolean> {
    try {
        const { data, error } = await supabase.rpc('wa_reactivar_promos', {
            p_integration_id: integrationId, p_contact_wa_id: contactWaId,
        });
        if (error) console.error('[whatsapp-optin] wa_reactivar_promos', { err: error.message });
        return !error && data === true;
    } catch {
        return false;
    }
}

/**
 * ¿Esta fila de `whatsapp_optins` saca a la persona de las promociones? Baja total
 * vigente o baja de promociones. Pura.
 */
export function sinPromociones(o: { opted_in_at?: string | null; opted_out_at?: string | null; promos_out_at?: string | null } | null | undefined): boolean {
    if (!o) return false;
    if (o.promos_out_at) return true;
    return Boolean(o.opted_out_at) && (!o.opted_in_at || new Date(o.opted_out_at!) >= new Date(o.opted_in_at));
}

export interface FilaOptin { contact_wa_id: string; opted_in_at: string | null; opted_out_at: string | null; promos_out_at?: string | null }

/**
 * Las filas de `whatsapp_optins` de un lote de contactos, con la baja de
 * promociones. Si `promos_out_at` todavía no existe (BFF desplegado antes que la
 * migración 20261115143758, error 42703) lee lo de siempre: las bajas totales
 * NUNCA se pierden por la columna nueva. Lanza si la lectura falla por otra cosa.
 */
export async function leerOptinsDeContactos(integrationId: string, contactos: string[]): Promise<FilaOptin[]> {
    if (!contactos.length) return [];
    const leer = (cols: string) => supabase.from('whatsapp_optins').select(cols)
        .eq('integration_id', integrationId).in('contact_wa_id', contactos);
    let { data, error } = await leer('contact_wa_id, opted_in_at, opted_out_at, promos_out_at');
    if (error && (error as any).code === '42703') ({ data, error } = await leer('contact_wa_id, opted_in_at, opted_out_at'));
    if (error) throw new Error(error.message ?? 'no se pudo leer whatsapp_optins');
    return ((data as unknown) as FilaOptin[]) ?? [];
}
