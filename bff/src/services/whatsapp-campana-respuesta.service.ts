/**
 * whatsapp-campana-respuesta.service — lo que pasa cuando la persona toca un
 * botón de la campaña o contesta «no me interesa» (plan B5 T4).
 *
 * Los tres botones de la plantilla traen `smc:<campana_id>:si|luego|baja` en
 * `button.payload` (whatsapp.service lo deja en `msg.botonId`). El webhook
 * (`handleBotTurn`, routes/whatsapp.ts) llama acá ANTES de `debeAtender`, solo
 * si `esPosibleRespuestaDeCampana` (gratis: el prefijo `smc:` o la frase). Lo
 * demás sigue por el camino de siempre.
 *
 *  - «No recibir más» → opt-out (`wa_register_optin`, p_opt_out), fuera de la
 *    audiencia, envío 'baja' y confirmación. La confirmación sale SIEMPRE, aun
 *    con la escuela escribiendo (es una instrucción al sistema, no una charla).
 *  - «Más adelante» → 'respondio_luego' y un texto corto.
 *  - «Sí» → 'respondio_si'; el texto que la escuela aprobó (`respuesta_si`)
 *    sale directo por la ventana recién abierta aunque el bot esté en asistido
 *    (respeta conversación tomada y modo discreto); queda el lead en
 *    Deportistas (`registrarLeadDeProspecto`), la conversación abierta en el
 *    buzón y el aviso «X respondió Sí» a la administración.
 *  - Texto libre «no me interesa / no más / no me escriban» con la plantilla de
 *    la campaña como último saliente (< 72 h) → `excluido='no_interesa'` (A-06
 *    de la auditoría 10-28: la baja de la ingesta reconoce 6 palabras exactas).
 *
 * Los textos salen por `sendTextMessage` y no por `deliver`: en modo asistido
 * `deliver` deja borrador, y una baja o la respuesta que la escuela ya aprobó
 * no pueden esperar a que alguien apruebe. Nunca lanza.
 */

import { supabase } from '../config/supabase';
import { sendTextMessage, type ParsedInboundMessage, type WhatsAppIntegration } from './whatsapp.service';
import { conversacionTomada } from './whatsapp-tomada.service';
import { escuelaActiva, modoDiscreto } from './whatsapp-modo-discreto';
import { registrarLeadDeProspecto } from './whatsapp-prospecto-lead.service';
import { etiquetaDeContacto } from './avisos-correo.service';
import { nombreDeEscuela } from './plataforma-wa.service';
import {
    ACCIONES_CAMPANA, PREFIJO_BOTON_CAMPANA, avisarAdministracion, type AccionCampana,
} from './whatsapp-campanas.service';
import { entranteConIntencion } from './whatsapp-audiencias.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Horas en que un «no me interesa» se lee como respuesta a la campaña. */
export const HORAS_RESPUESTA_TEXTO = 72;

/** Pasos de los salientes de este archivo (los lee el bot para el seguimiento, T7). */
export const PASO_CAMPANA = 'campana';
export const PASO_RESPUESTA_SI = 'campana_respuesta_si';
export const PASO_RESPUESTA_LUEGO = 'campana_respuesta_luego';
export const PASO_BAJA = 'opt_out_confirmado';
export const PASO_NO_INTERESA = 'campana_no_interesa';

export const TEXTO_LUEGO = '¡Entendido! 🙌 Cuando quieras, escríbenos por aquí y te contamos.';
export const TEXTO_NO_INTERESA = 'Entendido, no te escribiremos más sobre esto. ¡Gracias por avisarnos! 🙏';
export const textoBaja = (escuela: string) =>
    `Listo, no volverás a recibir mensajes automáticos de ${escuela} por este medio. `
    + 'Si cambias de opinión, escríbenos *ACTIVAR*. 👋';

/** `smc:<uuid>:si|luego|baja` → partes; lo demás null. Pura. */
export function parsearBotonDeCampana(botonId: string | null | undefined): { campanaId: string; accion: AccionCampana } | null {
    if (typeof botonId !== 'string' || !botonId.startsWith(PREFIJO_BOTON_CAMPANA)) return null;
    const [campanaId, accion, ...resto] = botonId.slice(PREFIJO_BOTON_CAMPANA.length).split(':');
    if (resto.length || !UUID.test(campanaId ?? '') || !(ACCIONES_CAMPANA as readonly string[]).includes(accion)) return null;
    return { campanaId, accion: accion as AccionCampana };
}

const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const NO_INTERESA = [
    /\bno (me|nos) interesa\b/,
    /\bno (estoy|estamos) interesad[oa]s?\b/,
    /\bno me (escriban|escribas|escriba|manden|mandes|envien|envies)\b/,
    /\bno (quiero|queremos) (recibir|mas|que me escriban)\b/,
    /\bdejen de (escribir|enviar|mandar)/,
    /^no mas\b/,
    /^no,? gracias$/,
];

/**
 * ¿Es un «no me interesa» corto? Hasta 8 palabras: «No me interesa la clínica
 * pero sí las clases para mi hija» NO lo es (sigue el bot). Pura.
 */
export function esNoMeInteresa(texto: string | null | undefined): boolean {
    const t = plano(String(texto ?? ''));
    if (!t || t.split(' ').length > 8) return false;
    return NO_INTERESA.some((re) => re.test(t));
}

/** Filtro gratis del webhook: ¿vale la pena preguntarle a la base? Pura. */
export function esPosibleRespuestaDeCampana(msg: Pick<ParsedInboundMessage, 'type' | 'textBody' | 'botonId'>): boolean {
    if (typeof msg.botonId === 'string' && msg.botonId.startsWith(PREFIJO_BOTON_CAMPANA)) return true;
    return msg.type === 'text' && esNoMeInteresa(msg.textBody);
}

export type ResultadoRespuesta = 'no_aplica' | 'baja' | 'luego' | 'si' | 'no_interesa' | 'repetido';

interface CampanaMin { id: string; school_id: string; integration_id: string; nombre: string; respuesta_si: string | null }

/**
 * Manda un texto fuera de `deliver` y lo deja en el buzón. Respeta la
 * conversación tomada y (salvo la baja) el modo discreto. Nunca lanza.
 */
async function enviarDirecto(a: {
    integration: WhatsAppIntegration; conversationId: string; contactWaId: string; texto: string;
    step: string; campanaId: string | null; aunConLaEscuela?: boolean;
}): Promise<boolean> {
    try {
        if (!a.aunConLaEscuela && await conversacionTomada(a.conversationId)) return false;
        if (!a.aunConLaEscuela && modoDiscreto() && await escuelaActiva(a.conversationId)) return false;
        const sent = await sendTextMessage(a.integration, a.contactWaId, a.texto);
        const id = sent.waMessageId || `local-${crypto.randomUUID()}`;
        await supabase.rpc('wa_record_outbound_message', {
            p_conversation_id: a.conversationId,
            p_integration_id: a.integration.id,
            p_wa_message_id: id,
            p_type: 'text',
            p_text_body: a.texto,
            // `step` + `automatico`: no es una persona de la escuela (modo discreto).
            p_payload: { step: a.step, campana_id: a.campanaId, automatico: true },
            p_ai_generated: false,
            p_to_wa_id: a.contactWaId,
        });
        if (!sent.ok) {
            await supabase.from('whatsapp_messages')
                .update({ status: 'failed', error_detail: String(sent.error ?? 'envío rechazado').slice(0, 500) })
                .eq('wa_message_id', id);
        }
        return sent.ok;
    } catch {
        return false;
    }
}

async function campanaPorId(id: string): Promise<CampanaMin | null> {
    const { data, error } = await supabase.from('whatsapp_campanas')
        .select('id, school_id, integration_id, nombre, respuesta_si').eq('id', id).maybeSingle();
    return error ? null : ((data as CampanaMin) ?? null);
}

async function envioDe(campanaId: string, contactWaId: string): Promise<{ id: string; estado: string } | null> {
    const { data, error } = await supabase.from('whatsapp_campana_envios')
        .select('id, estado').eq('campana_id', campanaId).eq('contact_wa_id', contactWaId).maybeSingle();
    return error ? null : ((data as any) ?? null);
}

async function marcarEnvio(envioId: string | null | undefined, estado: string, motivo?: string): Promise<void> {
    if (!envioId) return;
    const ahora = new Date().toISOString();
    await supabase.from('whatsapp_campana_envios')
        .update({ estado, respondido_at: ahora, updated_at: ahora, ...(motivo ? { motivo } : {}) })
        .eq('id', envioId);
}

async function excluirDeAudiencia(integrationId: string, contactWaId: string, motivo: 'baja' | 'no_interesa'): Promise<void> {
    await supabase.from('whatsapp_audiencia').update({ excluido: motivo })
        .eq('integration_id', integrationId).eq('contact_wa_id', contactWaId);
}

/** Respuesta a una campaña: botón `smc:` o «no me interesa» tras la plantilla. Nunca lanza. */
export async function atenderRespuestaDeCampana(p: {
    integration: WhatsAppIntegration;
    conversationId: string;
    msg: ParsedInboundMessage;
}): Promise<ResultadoRespuesta> {
    try {
        const boton = parsearBotonDeCampana(p.msg.botonId);
        if (boton) return await atenderBoton(p, boton);
        if (p.msg.type === 'text' && esNoMeInteresa(p.msg.textBody)) return await atenderNoMeInteresa(p);
        return 'no_aplica';
    } catch (err: any) {
        console.error('[campana-respuesta] falló', { conversationId: p.conversationId, err: err?.message || err });
        return 'no_aplica';
    }
}

async function atenderBoton(
    p: { integration: WhatsAppIntegration; conversationId: string; msg: ParsedInboundMessage },
    boton: { campanaId: string; accion: AccionCampana },
): Promise<ResultadoRespuesta> {
    const { integration, conversationId, msg } = p;
    const campana = await campanaPorId(boton.campanaId);
    // Un payload `smc:` que no es de esta escuela no se atiende como campaña.
    if (campana && campana.integration_id !== integration.id) return 'no_aplica';

    if (boton.accion === 'baja') {
        // La baja vale aunque la campaña no se encuentre: pedir que no le
        // escriban se respeta siempre.
        await supabase.rpc('wa_register_optin', {
            p_integration_id: integration.id,
            p_school_id: integration.school_id,
            p_contact_wa_id: msg.contactWaId,
            p_source: 'baja_directa',
            p_source_ref: msg.waMessageId,
            p_parent_id: null,
            p_opt_out: true,
        });
        await excluirDeAudiencia(integration.id, msg.contactWaId, 'baja');
        const envio = campana ? await envioDe(campana.id, msg.contactWaId) : null;
        if (envio?.estado === 'baja') return 'repetido';
        await marcarEnvio(envio?.id, 'baja');
        await enviarDirecto({
            integration, conversationId, contactWaId: msg.contactWaId,
            texto: textoBaja(await nombreDeEscuela(integration.school_id)),
            step: PASO_BAJA, campanaId: campana?.id ?? null, aunConLaEscuela: true,
        });
        return 'baja';
    }

    if (!campana) return 'no_aplica';
    const envio = await envioDe(campana.id, msg.contactWaId);

    if (boton.accion === 'luego') {
        if (envio?.estado === 'respondio_luego') return 'repetido';
        await marcarEnvio(envio?.id, 'respondio_luego');
        await enviarDirecto({
            integration, conversationId, contactWaId: msg.contactWaId, texto: TEXTO_LUEGO,
            step: PASO_RESPUESTA_LUEGO, campanaId: campana.id,
        });
        return 'luego';
    }

    // «Sí».
    if (envio?.estado === 'respondio_si') return 'repetido';
    await marcarEnvio(envio?.id, 'respondio_si');
    if (campana.respuesta_si?.trim()) {
        await enviarDirecto({
            integration, conversationId, contactWaId: msg.contactWaId, texto: campana.respuesta_si.trim(),
            step: PASO_RESPUESTA_SI, campanaId: campana.id,
        });
    }

    // Lead en Deportistas con los mensajes que dieron la intención.
    const { data: entrantes } = await supabase.from('whatsapp_messages')
        .select('text_body, created_at')
        .eq('conversation_id', conversationId).eq('direction', 'inbound')
        .order('created_at', { ascending: false }).limit(30);
    const conIntencion = ((entrantes as any[]) ?? []).reverse()
        .map((m) => String(m.text_body ?? '')).filter((t) => entranteConIntencion(t));
    await registrarLeadDeProspecto({
        schoolId: integration.school_id,
        conversationId,
        contactWaId: msg.contactWaId,
        nombre: msg.contactName,
        textos: conIntencion.length ? conIntencion : [`Respondió «Sí» a la campaña «${campana.nombre}»`],
        estado: 'nuevo',
    });

    // Buzón + aviso a la administración (id determinístico: un toque, un aviso).
    await supabase.from('whatsapp_conversations')
        .update({ status: 'open', updated_at: new Date().toISOString() }).eq('id', conversationId);
    const quien = etiquetaDeContacto(msg.contactName, msg.contactWaId);
    await avisarAdministracion({
        schoolId: integration.school_id,
        clave: `wa_campana_si:${campana.id}:${msg.contactWaId}`,
        titulo: `${quien} respondió «Sí»`,
        mensaje: `A la campaña «${campana.nombre}». Escríbele ahora: tienes 24 horas para responderle por WhatsApp.`,
        link: `/whatsapp?conversacion=${conversationId}`,
        data: { tipo: 'whatsapp_campana_si', campana_id: campana.id, conversation_id: conversationId },
    });
    return 'si';
}

async function atenderNoMeInteresa(
    p: { integration: WhatsAppIntegration; conversationId: string; msg: ParsedInboundMessage },
): Promise<ResultadoRespuesta> {
    // ¿Lo último que salió fue la plantilla de una campaña, hace < 72 h?
    const { data } = await supabase.from('whatsapp_messages')
        .select('payload, created_at')
        .eq('conversation_id', p.conversationId).eq('direction', 'outbound')
        .order('created_at', { ascending: false }).limit(1);
    const ultimo = (data as any[] | null)?.[0];
    if (!ultimo || ultimo.payload?.step !== PASO_CAMPANA) return 'no_aplica';
    if (Date.now() - new Date(ultimo.created_at).getTime() > HORAS_RESPUESTA_TEXTO * 3600_000) return 'no_aplica';
    const campanaId = typeof ultimo.payload?.campana_id === 'string' ? ultimo.payload.campana_id : null;

    await excluirDeAudiencia(p.integration.id, p.msg.contactWaId, 'no_interesa');
    if (campanaId) {
        const envio = await envioDe(campanaId, p.msg.contactWaId);
        if (envio) {
            const ahora = new Date().toISOString();
            await supabase.from('whatsapp_campana_envios')
                .update({ motivo: 'no_interesa', respondido_at: ahora, updated_at: ahora }).eq('id', envio.id);
        }
    }
    await enviarDirecto({
        integration: p.integration, conversationId: p.conversationId, contactWaId: p.msg.contactWaId,
        texto: TEXTO_NO_INTERESA, step: PASO_NO_INTERESA, campanaId,
    });
    return 'no_interesa';
}
