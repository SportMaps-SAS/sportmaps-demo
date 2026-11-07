/**
 * Puntos de enganche de la oleada 1 en el bot de WhatsApp (silencio con el equipo, referidos, soportes).
 *
 * El bot (`whatsapp-bot.service.ts`) y el webhook (`routes/whatsapp.ts`) llaman UNA función de acá en cada punto;
 * todo lo demás vive en los módulos de cada pieza. Nada importa `whatsapp-bot.service` (sería circular): lo que
 * necesita del bot (`deliver`, `abrirEnBuzon`, el modo discreto) entra por parámetro.
 *
 *  - `atenderOleada1Desconocido`: contactos SIN ficha ni cuenta (`atenderDesconocido`). Orden: silencio del
 *    equipo → respuesta al «¿te refirió alguien?» → «¿hay descuento por referidos?».
 *  - `preguntarReferidoTrasTurno`: tras un turno del interesado, la pregunta opcional de referido.
 *  - `atenderOleada1Familia`: familia identificada o ficha sin cuenta (`runBotTurn`). Orden: respuesta del
 *    flujo de soportes → «¿hay descuento por referidos?».
 *  - `atenderAdjuntoEntrante`: el webhook, antes de encolar un adjunto como comprobante.
 */
import {
    atenderRespuestaDeReferido, preguntarPorReferido, responderPreguntaDeReferidos, type CtxReferidos,
} from './whatsapp-referidos-bot';
import { equipoEstaAtendiendo } from './whatsapp-silencio-conversacion';
import {
    atenderAdjuntoDeSoporte, atenderRespuestaDeSoporte, type AdjuntoEntrante, type CtxSoportes,
} from './whatsapp-soportes-bot';
import type { FilaReciente } from './whatsapp-reglas-turno';
import type { BotonInteractivo, WhatsAppIntegration } from './whatsapp.service';

/** Lo que el bot presta (sus funciones internas), para no importarlo. */
export interface IoDelBot {
    deliver: (
        integration: WhatsAppIntegration, conversationId: string, contactWaId: string, texto: string,
        context: Record<string, unknown>, conBotones?: { botones: BotonInteractivo[] },
    ) => Promise<void>;
    abrirEnBuzon: (
        integration: WhatsAppIntegration, conversationId: string, contactWaId: string,
        aviso?: { motivo: 'prospecto' | 'puerta_club' | 'puerta_otro' },
    ) => Promise<void>;
    /** Modo discreto efectivo de la escuela del turno. */
    discreto: boolean;
}

interface Turno {
    integration: WhatsAppIntegration;
    conversationId: string;
    contactWaId: string;
}

function ctxReferidos(t: Turno, io: IoDelBot): CtxReferidos {
    return {
        schoolId: t.integration.school_id, conversationId: t.conversationId, contactWaId: t.contactWaId,
        discreto: io.discreto,
        enviar: (texto, context) => io.deliver(t.integration, t.conversationId, t.contactWaId, texto, context),
        derivar: () => io.abrirEnBuzon(t.integration, t.conversationId, t.contactWaId, { motivo: 'prospecto' }),
    };
}

function ctxSoportes(t: Turno, io: IoDelBot): CtxSoportes {
    return {
        integration: t.integration, conversationId: t.conversationId, contactWaId: t.contactWaId,
        enviar: (texto, context, botones) => io.deliver(t.integration, t.conversationId, t.contactWaId, texto, context,
            botones ? { botones } : undefined),
    };
}

export type ResultadoOleada1Desconocido = 'escuela_atendiendo' | 'referido' | 'referidos_info';

/** Contactos desconocidos. null = ninguna de las tres piezas aplica (el turno sigue igual que antes). */
export async function atenderOleada1Desconocido(
    t: Turno & { text: string; botonId: string | null; recientes: () => Promise<FilaReciente[]> },
    io: IoDelBot,
): Promise<ResultadoOleada1Desconocido | null> {
    // 1. El equipo ya está en diálogo con esta persona (72 h): el bot no le habla.
    if (await equipoEstaAtendiendo(t.conversationId)) return 'escuela_atendiendo';
    const ctx = ctxReferidos(t, io);
    // 2. Respuesta a «¿Te refirió alguien del club?».
    if (await atenderRespuestaDeReferido(ctx, t.text, t.recientes, undefined, t.botonId)) return 'referido';
    // 3. «¿Tienen descuento por referidos?».
    if (!t.botonId && await responderPreguntaDeReferidos(ctx, t.text)) return 'referidos_info';
    return null;
}

/** Tras un turno del interesado (embudo / clase de prueba): ¿toca la pregunta de referido? */
export async function preguntarReferidoTrasTurno(t: Turno, io: IoDelBot): Promise<boolean> {
    return preguntarPorReferido(ctxReferidos(t, io));
}

/** Familia identificada o ficha sin cuenta. true = el turno terminó acá. */
export async function atenderOleada1Familia(
    t: Turno & { text: string; botonId: string | null; recientes: FilaReciente[] },
    io: IoDelBot,
): Promise<boolean> {
    if (await atenderRespuestaDeSoporte(ctxSoportes(t, io), t.text, t.botonId, t.recientes)) return true;
    if (!t.botonId && await responderPreguntaDeReferidos(ctxReferidos(t, io), t.text)) return true;
    return false;
}

/** El webhook, antes de encolar un adjunto como comprobante. true = no se encola. */
export async function atenderAdjuntoEntrante(
    t: Turno & { msg: AdjuntoEntrante; recientes: () => Promise<FilaReciente[]> },
    io: IoDelBot,
): Promise<boolean> {
    return atenderAdjuntoDeSoporte(ctxSoportes(t, io), t.msg, t.recientes);
}
