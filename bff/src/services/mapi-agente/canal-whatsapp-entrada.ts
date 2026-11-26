/**
 * canal-whatsapp-entrada — lo LIVIANO del adaptador de Mapi por WhatsApp: lo que
 * `plataforma-wa-entrante` necesita para decidir si un mensaje va al agente, sin
 * cargar el motor (agente → registro → 38 herramientas). El motor se carga con
 * `import()` solo cuando hace falta (canal-whatsapp.ts).
 */

import { supabase } from '../../config/supabase';
import type { ParsedInboundMessage } from '../whatsapp.service';
import type { Suscripcion } from '../plataforma-wa.service';

const soloDigitos = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

/** Interruptor del canal (default apagado). MAPI_AGENT_ENABLED=false también lo apaga. */
export function mapiWhatsAppActivo(): boolean {
    return process.env.MAPI_WHATSAPP === 'true' && process.env.MAPI_AGENT_ENABLED !== 'false';
}

/**
 * ¿Es la RESPUESTA a un botón nuestro? Solo un mensaje interactivo (button_reply
 * o list_reply) cuenta: un texto «mapi:c:…» pegado es texto (§12.7). Pura.
 */
export function esRespuestaBotonMapi(msg: Pick<ParsedInboundMessage, 'type' | 'botonId' | 'raw'>): boolean {
    if (msg.type !== 'interactive' || !msg.botonId?.startsWith('mapi:')) return false;
    const i = msg.raw?.interactive;
    return (i?.type === 'button_reply' && i?.button_reply?.id === msg.botonId)
        || (i?.type === 'list_reply' && i?.list_reply?.id === msg.botonId);
}

export interface Identidad { schoolId: string; profileId: string }

/** Escuelas (de las suscripciones ACTIVAS de este número) con el agente prendido. */
export async function escuelasConMapi(numero: string, suscripciones: Suscripcion[]): Promise<Identidad[]> {
    const activas = suscripciones.filter((s) => s.estado === 'activa' && soloDigitos(s.contact_wa_id) === soloDigitos(numero));
    if (!activas.length) return [];
    const { data, error } = await supabase.from('school_settings').select('school_id, mapi_agent_enabled')
        .in('school_id', [...new Set(activas.map((s) => s.school_id))]);
    if (error) return [];
    const prendidas = new Set(((data ?? []) as any[]).filter((r) => r.mapi_agent_enabled === true).map((r) => String(r.school_id)));
    return activas.filter((s) => prendidas.has(s.school_id)).map((s) => ({ schoolId: s.school_id, profileId: s.profile_id }));
}
