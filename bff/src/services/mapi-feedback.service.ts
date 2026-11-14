/**
 * mapi-feedback.service — «¿Te sirvió?» bajo cada respuesta de Mapi (2026-10-27).
 *
 * Sin migración: la calificación queda como NOTA INTERNA del bot en el mismo
 * hilo (`support_messages.internal_note = true`), con una marca al inicio que
 * la liga a la respuesta calificada:
 *
 *     [mapi-feedback:<id de la respuesta>:no] El usuario marcó que …
 *
 * El usuario no ve las notas internas (RLS `messages_select_own` filtra
 * internal_note = false) y el agente de soporte sí las ve en la bandeja, que
 * es justo lo que hace falta para revisar el caso.
 *
 * «No» usa el flujo de casos que ya existe: el ticket pasa a `waiting_human`
 * («Esperando soporte» en la bandeja), Mapi le dice al usuario que una persona
 * lo revisa, y sale el correo «[Revisar] …» a SUPPORT_ALERT_EMAIL.
 */

import { supabase } from '../config/supabase';
import { avisarTicketSoportePorCorreo } from './avisos-correo.service';

export type Calificacion = 'si' | 'no';

const MARCA = /^\[mapi-feedback:([0-9a-f-]{36}):(si|no)\]/i;

export function notaDeFeedback(messageId: string, valor: Calificacion): string {
    return valor === 'si'
        ? `[mapi-feedback:${messageId}:si] El usuario marcó que esta respuesta de Mapi le sirvió.`
        : `[mapi-feedback:${messageId}:no] El usuario marcó que esta respuesta de Mapi NO le sirvió. Revisar el caso.`;
}

/** Lee las calificaciones de las notas internas de un hilo: { idRespuesta: 'si' | 'no' }. */
export function leerFeedback(notas: { body: string }[]): Record<string, Calificacion> {
    const out: Record<string, Calificacion> = {};
    for (const n of notas) {
        const m = MARCA.exec(String(n.body ?? ''));
        if (m) out[m[1].toLowerCase()] = m[2].toLowerCase() as Calificacion;
    }
    return out;
}

/** Calificaciones de un ticket. Con service role: las notas internas no las ve el usuario. */
export async function feedbackDelTicket(ticketId: string): Promise<Record<string, Calificacion>> {
    const { data } = await supabase
        .from('support_messages')
        .select('body')
        .eq('ticket_id', ticketId)
        .eq('author_type', 'bot')
        .eq('internal_note', true);
    return leerFeedback((data as any[]) || []);
}

export const MENSAJE_NO_SIRVIO =
    'Gracias por contarme. Le pasé tu caso a una persona del equipo de SportMaps para que lo revise; te responde por aquí mismo. 🙌';

export type ResultadoFeedback = 'guardado' | 'ya_calificado' | 'no_es_respuesta_de_mapi';

/**
 * Guarda la calificación de UNA respuesta del bot. Quien llama ya verificó que
 * el ticket es del usuario (con su propio cliente, bajo RLS). Idempotente por
 * respuesta: la segunda calificación de la misma respuesta no hace nada.
 */
export async function calificarRespuesta(p: {
    ticketId: string; messageId: string; valor: Calificacion;
}): Promise<ResultadoFeedback> {
    const { data: msg } = await supabase
        .from('support_messages')
        .select('id, author_type, internal_note')
        .eq('id', p.messageId)
        .eq('ticket_id', p.ticketId)
        .maybeSingle();
    const m = msg as any;
    if (!m || m.author_type !== 'bot' || m.internal_note) return 'no_es_respuesta_de_mapi';

    const previas = await feedbackDelTicket(p.ticketId);
    if (previas[p.messageId.toLowerCase()]) return 'ya_calificado';

    await supabase.from('support_messages').insert({
        ticket_id: p.ticketId,
        author_type: 'bot',
        author_id: null,
        body: notaDeFeedback(p.messageId, p.valor),
        internal_note: true,
    });

    if (p.valor === 'no') {
        await supabase.from('support_messages').insert({
            ticket_id: p.ticketId,
            author_type: 'bot',
            author_id: null,
            body: MENSAJE_NO_SIRVIO,
        });
        await supabase
            .from('support_tickets')
            .update({ status: 'waiting_human', updated_at: new Date().toISOString() })
            .eq('id', p.ticketId);
        // Sin await: el usuario está esperando la respuesta del chat.
        void avisarTicketSoportePorCorreo({ ticketId: p.ticketId, origen: 'no_sirvio', respuestaId: p.messageId }).catch(() => {});
    }
    return 'guardado';
}
