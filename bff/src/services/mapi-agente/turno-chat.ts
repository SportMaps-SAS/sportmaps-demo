/**
 * turno-chat — el modo agente dentro del chat de Mapi que ya existe
 * (support_tickets / support_messages, un hilo por usuario).
 *
 * La ruta /support/messages decide por turno: si hay alcance de agente
 * (escuela con mapi_agent_enabled, rol admin o coach, x-school-id presente y
 * sin apagado global) corre este turno; si no, o si Claude falla, responde el
 * Mapi de soporte de siempre.
 */

import { supabase } from '../../config/supabase';
import { postBotMessageAndEscalate, setStatus } from '../inapp-support-bot.service';
import { turnoAgente, type MensajeHistorial, type CrearMensaje } from './agente';
import { asociarMensaje } from './borradores';
import { validarPantalla } from './pantalla';
import { responderSinModelo, textoParaApp, registrarCapa } from './directo/enrutador';
import { topeMensualAlcanzado, TEXTO_TOPE } from './directo/tope';
import type { Alcance } from './tipos';

const MAX_HISTORIAL = 12;
/** Tope de turnos del agente por usuario y hora (plan §13.2). Pasado el tope, modo soporte. */
export const TURNOS_POR_HORA = Number(process.env.MAPI_AGENT_TURNOS_HORA) || 30;

/** ¿Superó el tope de turnos de la última hora? Cuenta los mensajes del usuario en su hilo. */
export async function superoTope(ticketId: string): Promise<boolean> {
    const desde = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await supabase.from('support_messages').select('id', { count: 'exact', head: true })
        .eq('ticket_id', ticketId).eq('author_type', 'user').gte('created_at', desde);
    return (count ?? 0) > TURNOS_POR_HORA;
}

/**
 * Corre el turno del agente y deja la respuesta en el hilo. Devuelve false si
 * el agente no respondió (sin Claude, negativa, nada que responder) para que la
 * ruta caiga al modo soporte.
 */
export async function runTurnoAgenteEnChat(p: {
    ticketId: string;
    alcance: Alcance;
    pantallaCruda?: unknown;
    crearMensaje?: CrearMensaje;
}): Promise<boolean> {
    // Una persona de soporte ya tomó el hilo: Mapi no le habla encima.
    const { count: agentes } = await supabase.from('support_messages').select('id', { count: 'exact', head: true })
        .eq('ticket_id', p.ticketId).eq('author_type', 'agent');
    if ((agentes ?? 0) > 0) return true;

    const { data: filas } = await supabase.from('support_messages').select('author_type, body')
        .eq('ticket_id', p.ticketId).eq('internal_note', false)
        .order('created_at', { ascending: false }).limit(MAX_HISTORIAL);

    // Capa 2 (docs/specs/mapi-consultas-sin-ia.md): la consulta frecuente se
    // responde sin modelo, con la MISMA herramienta y el MISMO alcance. Queda en
    // el hilo como cualquier respuesta, así el modelo la ve si el próximo mensaje va a él.
    const ultimo = ((filas as any[]) ?? []).find((m) => m.author_type === 'user');
    if (ultimo && String(ultimo.body ?? '').trim()) {
        const directa = await responderSinModelo(p.alcance, { texto: String(ultimo.body) }, 'app');
        if (directa.tipo !== 'al_modelo') {
            await dejarRespuesta(p.ticketId, textoParaApp(directa));
            return true;
        }
    }
    // Tope mensual de turnos con modelo por escuela: texto fijo, sin modelo (las capas 1 y 2 siguen).
    if (await topeMensualAlcanzado(p.alcance)) {
        registrarCapa({ canal: 'app', capa: 'tope', resultado: 'texto_fijo' });
        await dejarRespuesta(p.ticketId, TEXTO_TOPE);
        return true;
    }

    const [{ data: perfil }, pantalla] = await Promise.all([
        supabase.from('profiles').select('full_name').eq('id', p.alcance.userId).maybeSingle(),
        validarPantalla(p.alcance, p.pantallaCruda).catch(() => null),
    ]);
    const historial: MensajeHistorial[] = [...((filas as any[]) ?? [])].reverse()
        .map((m) => ({ role: m.author_type === 'user' ? 'user' as const : 'assistant' as const, content: String(m.body ?? '') }));

    const r = await turnoAgente({
        alcance: p.alcance,
        ticketId: p.ticketId,
        historial,
        pantalla,
        nombreUsuario: (perfil as any)?.full_name ?? null,
        crearMensaje: p.crearMensaje,
    });

    if (r.tipo === 'sin_agente') {
        console.info('[mapi-agente] sin agente en este turno, sigue modo soporte', { motivo: r.motivo });
        return false;
    }
    console.info('[mapi-agente] turno', { herramientas: r.herramientas, borradores: r.borradores.length, rondas: r.rondas, tipo: r.tipo });

    if (r.tipo === 'escalar') {
        await postBotMessageAndEscalate(p.ticketId, r.motivo);
        return true;
    }

    await dejarRespuesta(p.ticketId, r.texto, r.borradores);
    return true;
}

/** Deja la respuesta de Mapi en el hilo (y le asocia las tarjetas), como cualquier turno. */
async function dejarRespuesta(ticketId: string, texto: string, borradores: string[] = []): Promise<void> {
    const { data: msg } = await supabase.from('support_messages')
        .insert({ ticket_id: ticketId, author_type: 'bot', author_id: null, body: texto })
        .select('id').single();
    if (borradores.length && (msg as any)?.id) await asociarMensaje(borradores, (msg as any).id);

    const { data: actual } = await supabase.from('support_tickets').select('status').eq('id', ticketId).maybeSingle();
    if ((actual as any)?.status !== 'waiting_human') await setStatus(ticketId, 'bot_handled');
}
