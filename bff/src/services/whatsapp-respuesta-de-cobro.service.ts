/**
 * La respuesta del acudiente a «¿a cuál de tus cobros lo aplico?».
 *
 * Es el otro extremo de `esperarAlUsuario`: el worker dejó la fila en
 * 'waiting_user' con las opciones congeladas, y este módulo es el único que las
 * vuelve a mirar. Corre ANTES del LLM en cada mensaje entrante, porque «2» o
 * «los dos» solo significan algo contra una pregunta abierta — para el modelo
 * son ruido.
 *
 * La regla de producto y el porqué de cada desempate están en
 * `whatsapp-eleccion-de-pago.service`.
 */

import { supabase } from '../config/supabase';
import { aplicarComprobante, aplicarComprobanteConMotivo } from '../jobs/whatsapp-queue.job';
import {
    interpretarEleccion, loQueQueda, etiquetaDeCobro, resumenParaLaEscuela, TEXTO_REVISION_ESCUELA,
} from './whatsapp-eleccion-de-pago.service';
import { resolverRespuestaDeDeportista, botonesDeCobros } from './whatsapp-comprobante-de-ficha.service';
import {
    resolverRespuestaGuiada, interpretarOpcion, PASO_RESUMEN_MOTIVOS, BOTON_MOTIVOS_OK, BOTON_MOTIVOS_CAMBIAR,
    type OpcionGuiada,
} from './whatsapp-comprobante-guiado.service';
import { esValorMotivoElegido } from './wa-cobro-desde-comprobante.service';
import { describirPago, type PagoPendiente } from './whatsapp-receipt-matching.service';
import { soloSaludoOCortesia } from './whatsapp-atencion.service';
import { cargarRecargos, montoEsperado } from './whatsapp-excedente.service';
import { esHumanoDeLaEscuela, normalizarFrase, type FilaReciente } from './whatsapp-reglas-turno';
import type { BotonInteractivo, WhatsAppIntegration } from './whatsapp.service';

/** `error_message` de la pregunta que se cierra porque una persona de la escuela escribió. */
export const MOTIVO_ESCUELA_TOMO = 'la escuela tomó la conversación';

/** step de la respuesta cuando el monto del comprobante no cuadra con el cobro elegido. */
export const PASO_MONTO_NO_CUADRA = 'comprobante_a_la_escuela';

/**
 * Cuánto vale una pregunta abierta.
 *
 * Pasadas 24h la ventana de servicio de Meta está cerrada y ya no se le puede
 * contestar en texto libre, así que una respuesta más tardía no tiene a dónde
 * ir. Y a esa altura el padre ya no recuerda qué se le ofreció.
 */
const VIGENCIA_H = 24;

/** Cuántas veces se le vuelve a preguntar antes de pasarlo a la escuela. */
const MAX_REPREGUNTAS = 2;

/**
 * Un saludo suelto («Buen día») que llega pegado a la pregunta no es una
 * respuesta: es lo que escribió junto con el comprobante. No se le repregunta
 * (Dynasty 2026-10-09: imagen + «Buen día» → la lista salió dos veces).
 */
const SALUDO_PEGADO_MIN = 5;

/** Responde a la familia. `botones`: las opciones como botones (si el canal los soporta). */
export type ResponderCobro = (texto: string, paso: string, botones?: BotonInteractivo[]) => Promise<unknown>;

/**
 * Pasa el caso a la escuela con `resumen`. `mensajeFamilia`: lo que se le
 * dice a la familia (UNA vez, lo dice quien escala); null = solo la escuela.
 */
export type PasarALaEscuela = (p: { resumen: string; mensajeFamilia: string | null }) => Promise<unknown>;

interface FilaEsperando {
    id: string;
    pregunta_opciones: PagoPendiente[] | null;
    pregunta_ocr: {
        ocr: any;
        sha: string;
        storagePath: string | null;
        /** null: familia sin cuenta (cobros por ficha). */
        parentId: string | null;
        /** 'deportista': se preguntó de qué deportista es. 'mes' / 'concepto': preguntas guiadas (spec 3.3). */
        tipo?: 'deportista' | 'mes' | 'concepto';
        guia?: any;
        /** Meses que la familia dijo que YA pagó en respuestas anteriores («agosto»). */
        dice_pagado?: string[];
        /** (Plan B4) La pregunta no salió: espera en fila detrás de otra. */
        en_fila?: { texto: string; paso: string; botones?: BotonInteractivo[] | null; monto?: number | null } | null;
    } | null;
    pregunta_at: string | null;
    retries: number;
    school_id: string;
}

/**
 * ¿Este mensaje es la respuesta a una pregunta abierta? Si lo es, la resuelve.
 *
 * Devuelve `true` cuando consumió el turno: quien llama NO debe seguir al LLM.
 *
 * `responder` lo inyecta el llamador en vez de importarlo, para no cerrar el
 * ciclo bot → respuesta → bot entre módulos.
 */
export async function resolverRespuestaDeCobro(
    integration: WhatsAppIntegration,
    contactWaId: string,
    texto: string,
    responder: ResponderCobro,
    pasarALaEscuela?: PasarALaEscuela,
): Promise<boolean> {
    // (Plan B4) [Sí, está bien] / [Cambiar un motivo] del resumen de una ráfaga.
    // Solo se lee algo si el texto ES el título del botón.
    const boton = botonDeResumen(texto);
    if (boton && await atenderResumenDeMotivos(integration.id, contactWaId, boton, texto, responder, pasarALaEscuela)) return true;

    const consumio = await resolverFilaAbierta(integration, contactWaId, texto, responder, pasarALaEscuela);
    // (Plan B4, fila de preguntas) Resuelta una, sale la siguiente que esperaba.
    if (consumio) await promoverSiguientePregunta(integration.id, contactWaId, responder);
    return consumio;
}

async function resolverFilaAbierta(
    integration: WhatsAppIntegration,
    contactWaId: string,
    texto: string,
    responder: ResponderCobro,
    pasarALaEscuela?: PasarALaEscuela,
): Promise<boolean> {
    const { data } = await supabase
        .from('whatsapp_inbound_queue')
        .select('id, pregunta_opciones, pregunta_ocr, pregunta_at, retries, school_id')
        .eq('integration_id', integration.id)
        .eq('wa_phone_number', contactWaId)
        .eq('status', 'waiting_user')
        .order('pregunta_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();

    const fila = data as FilaEsperando | null;
    if (!fila) return false;
    // Una pregunta en fila (todavía no salió) no se contesta: sale cuando se
    // resuelva la anterior, o la vence el worker y va al buzón.
    if (!fila.pregunta_at && fila.pregunta_ocr?.en_fila) return false;

    // Una persona de la escuela escribió en el chat DESPUÉS de la pregunta
    // (Milena desde su celular o el buzón): la conversación es suya. La
    // pregunta se cierra y no se contesta nada — antes cada «ok» o «gracias»
    // de la familia volvía a sacar «¿a cuál cobro va?» encima de la escuela
    // (auditoría Dynasty 2026-10-10). El comprobante queda en la bandeja.
    if (await laEscuelaTomoLaConversacion(integration.id, contactWaId, fila.pregunta_at)) {
        await cerrarPregunta(fila.id, MOTIVO_ESCUELA_TOMO);
        return true;
    }

    // «¿De qué mes es?» / «¿Es de mensualidad, inscripción u otro?» (spec 3.3): la
    // respuesta es una opción de la guía. Nunca por audio: solo botón, número o texto.
    if (fila.pregunta_ocr?.tipo === 'mes' || fila.pregunta_ocr?.tipo === 'concepto') {
        const edad = fila.pregunta_at ? (Date.now() - new Date(fila.pregunta_at).getTime()) / 3_600_000 : Infinity;
        if (edad > VIGENCIA_H) return false;
        // (Plan B4) Eligió un motivo con precio y el comprobante es ese precio:
        // se crea el cobro y se aplica. Si no, la bandeja de siempre.
        if (fila.pregunta_ocr.tipo === 'concepto' && await aplicarMotivoElegido(fila, texto, responder)) return true;
        return resolverRespuestaGuiada(fila as any, texto, responder);
    }

    // «¿De qué deportista es este pago?» (número sin ficha): la respuesta es un
    // nombre, no una opción. Vencida, sigue su curso (la vence el worker).
    if (fila.pregunta_ocr?.tipo === 'deportista') {
        const edad = fila.pregunta_at ? (Date.now() - new Date(fila.pregunta_at).getTime()) / 3_600_000 : Infinity;
        if (edad > VIGENCIA_H) return false;
        return resolverRespuestaDeDeportista(fila, texto, responder);
    }

    // Filas de antes de esta función, sin contexto congelado: no hay con qué
    // aplicarlas. Se cierran para que dejen de interceptar mensajes, y la
    // escuela las sigue viendo en el inbox.
    const opciones = fila.pregunta_opciones ?? [];
    const guardado = fila.pregunta_ocr;
    if (!opciones.length || !guardado) {
        await cerrarPregunta(fila.id, 'pregunta sin contexto congelado');
        return false;
    }

    // Vencida: se cierra y el mensaje sigue su curso normal. No se le contesta
    // nada sobre el comprobante viejo — sería confundirlo más.
    const edadH = fila.pregunta_at
        ? (Date.now() - new Date(fila.pregunta_at).getTime()) / 3_600_000
        : Infinity;
    if (edadH > VIGENCIA_H) {
        await cerrarPregunta(fila.id, 'la pregunta venció sin respuesta');
        return false;
    }

    // «Buen día» pegado a la pregunta (llegó con el comprobante): ni se
    // repregunta ni pasa al modelo. Más tarde, un saludo sí sigue su curso.
    const minutos = fila.pregunta_at ? (Date.now() - new Date(fila.pregunta_at).getTime()) / 60_000 : Infinity;
    if (soloSaludoOCortesia(texto) && minutos <= SALUDO_PEGADO_MIN) return true;

    const eleccion = interpretarEleccion(texto, opciones);
    const yaDichos = Array.isArray(guardado.dice_pagado) ? guardado.dice_pagado : [];

    // Discute el VALOR, o dice que ya está al día: no se aplica por inferencia.
    // A la escuela con un resumen, y a la familia UNA respuesta.
    if (eleccion.tipo === 'revision_escuela') {
        const resumen = resumenParaLaEscuela(eleccion, yaDichos);
        if (pasarALaEscuela) {
            await pasarALaEscuela({ resumen, mensajeFamilia: TEXTO_REVISION_ESCUELA });
        } else {
            await responder(TEXTO_REVISION_ESCUELA, 'cobro_a_revision_escuela');
        }
        await cerrarPregunta(fila.id, `revision_escuela: ${resumen}`, 'failed');
        return true;
    }

    // Descartó algunos («agosto ya lo pagué») o el mes lo tienen varios: se
    // pregunta SOLO entre lo que queda, con botones nuevos. Las opciones
    // congeladas se reemplazan: «sm_cobro_1» ahora señala la primera de ESTAS.
    if (eleccion.tipo === 'acotar') {
        const dicePagado = [...new Set([...yaDichos, ...eleccion.dicePagado.map(etiquetaDeCobro)])];
        await supabase.from('whatsapp_inbound_queue')
            .update({
                pregunta_opciones: eleccion.opciones,
                pregunta_ocr: { ...guardado, dice_pagado: dicePagado },
            })
            .eq('id', fila.id);
        await responder(mensajeAcotado(eleccion.opciones, eleccion.dicePagado, opciones, eleccion.motivo),
            'ask_cual_pago_acotado', botonesDeCobros(eleccion.opciones));
        return true;
    }

    if (eleccion.tipo === 'cancelar') {
        await responder(
            'Listo, no lo apliqué a ninguno. Cuando sepas a cuál va, mándame el ' +
            'comprobante de nuevo y lo registro. 👍',
            'eleccion_cancelada',
        );
        await cerrarPregunta(fila.id, 'el acudiente pidió no aplicarlo');
        return true;
    }

    if (eleccion.tipo === 'no_entendi') {
        // Se repregunta un par de veces y se para. Insistir una tercera vez le
        // traba el chat: cualquier cosa que escriba vuelve a caer acá.
        if (fila.retries >= MAX_REPREGUNTAS) {
            await responder(
                'No logro entender a cuál de tus cobros va el comprobante, así que se lo ' +
                'paso a la escuela para que lo apliquen ellos. Lo tienen guardado. 📄',
                'eleccion_a_la_escuela',
            );
            await cerrarPregunta(fila.id, 'no se entendió la elección; va al inbox', 'failed');
            return true;
        }
        await supabase.from('whatsapp_inbound_queue')
            .update({ retries: fila.retries + 1 })
            .eq('id', fila.id);
        // Nunca la misma lista otra vez: otro texto, y los botones.
        await responder(mensajeReintento(opciones, fila.retries), 'ask_cual_pago_reintento',
            botonesDeCobros(opciones));
        return true;
    }

    // ── Eligió ───────────────────────────────────────────────────────────────
    //
    // Un comprobante se estampa en UN pago: `uq_payments_school_ocr_reference`
    // impide vincular la misma operación bancaria a dos cobros, y es la defensa
    // contra reusar el mismo soporte. Así que aunque diga «los dos», la plata se
    // aplica al MÁS ANTIGUO —la regla de la escuela— y el resto se le nombra.
    //
    // `pregunta_opciones` viene ordenada del más viejo al más nuevo.
    const orden = new Map(opciones.map((p, i) => [p.id, i]));
    const elegidos = [...eleccion.pagos].sort(
        (a, b) => (orden.get(a.id) ?? 0) - (orden.get(b.id) ?? 0),
    );
    const pago = elegidos[0];
    const restantes = loQueQueda(opciones, [pago]);

    // Eligió varios y la plata los cubre a TODOS (no solo al más antiguo):
    // estamparla en el más antiguo dejaría un comprobante de $515.000 en una
    // mensualidad de $180.000 y la inscripción y el seguro «pendientes» ya
    // pagados (pagos únicos, 2026-10-10). Eso lo reparte la escuela.
    if (cubreVariosNoSoloElMasAntiguo(elegidos, guardado.ocr?.amount)) {
        await responder(
            'Tu comprobante cubre varios cobros a la vez:\n\n' +
            `${elegidos.map((p) => `• ${describirPago(p)}`).join('\n')}\n\n` +
            'Se lo paso a la escuela para que lo reparta entre ellos y te confirme por aquí. 📄',
            'varios_cobros',
        );
        await supabase.from('whatsapp_inbound_queue')
            .update({
                status: 'ignored',
                result_type: 'escalated',
                processed_at: new Date().toISOString(),
                error_message: `varios_cobros: la familia eligió ${elegidos.length} cobros por un solo comprobante: repartirlo a mano`,
            })
            .eq('id', fila.id);
        return true;
    }

    // Sin abonos no se estampa lo que no cuadra (la misma regla del camino
    // principal del worker): elegir un cobro NO convierte un comprobante de
    // $150.000 en el pago de una mensualidad de $180.000. Cuadra el valor base
    // (transferencia a las llaves, sin recargo) o el monto del enlace de pago
    // que la familia recibió para ESE cobro (`payment_links`, con su recargo).
    // No se mira el % actual de la escuela ni el texto del medio: un link
    // pagado con Nequi dentro del checkout tiene su monto en el enlace.
    // Sin monto leído no se decide por monto, igual que en el worker.
    const monto = montoLeido(guardado.ocr?.amount);
    if (monto !== null) {
        const reglas = await reglasDeMontoDeLaEscuela(fila.school_id);
        const recargos = await cargarRecargos(fila.school_id, [pago]);
        if (!reglas.permiteAbonos && montoEsperado(pago, monto, recargos) !== monto) {
            await responder(textoMontoNoCuadra(monto, pago), PASO_MONTO_NO_CUADRA);
            await supabase.from('whatsapp_inbound_queue')
                .update({
                    status: 'ignored',
                    result_type: 'escalated',
                    matched_parent_id: guardado.parentId,
                    processed_at: new Date().toISOString(),
                    error_message: motivoMontoNoCuadra(monto, pago),
                })
                .eq('id', fila.id);
            return true;
        }
    }

    // Dijo «los dos» y solo se puede aplicar a uno: hay que decírselo ANTES de
    // aplicarlo, o va a leer «apliqué a X» creyendo que cubrimos los dos.
    if (elegidos.length > 1) {
        await responder(
            'Un comprobante solo lo puedo aplicar a un cobro, así que lo apliqué al más ' +
            `antiguo: *${describirPago(pago)}*.\n\n` +
            'Si tu transferencia cubría más de uno, escríbele a la escuela y ellos lo reparten.',
            'eleccion_multiple',
        );
    }

    await aplicarComprobante({
        queueId: fila.id,
        schoolId: fila.school_id,
        parentId: guardado.parentId,
        storagePath: guardado.storagePath,
        sha: guardado.sha,
        ocr: guardado.ocr,
        responder,
        // La respuesta del acudiente no se reintenta sola: no hay worker
        // mirándola. Si el estampado falla, se le dice y va al inbox.
        alFallar: async (motivo) => {
            await responder(
                'Tuve un problema al registrar tu pago. Ya le avisé a la escuela para que ' +
                'lo apliquen a mano — tu comprobante está guardado. 🙏',
                'aplicacion_fallo',
            );
            await cerrarPregunta(fila.id, motivo, 'failed');
        },
    }, pago, restantes);

    // Eligió, pero dijo que algo que figura pendiente ya lo pagó («agosto ya lo
    // pagué»): el comprobante se aplicó a lo que eligió, y la escuela tiene que
    // revisar ese otro cobro. Sin otro mensaje a la familia.
    const dichos = [...new Set([...yaDichos, ...(eleccion.dicePagado ?? []).map(etiquetaDeCobro)])];
    if (dichos.length && pasarALaEscuela) {
        const nota = `La familia dice que ${dichos.join(' y ')} ya ${dichos.length > 1 ? 'están pagados' : 'está pagado'}, ` +
            `pero figura pendiente. El comprobante se aplicó a ${describirPago(pago)}.`;
        await pasarALaEscuela({ resumen: nota, mensajeFamilia: null }).catch(() => undefined);
    }

    return true;
}

/**
 * La pregunta otra vez, solo con lo que sigue en pie. Pura.
 *
 * «Ya había pagado agosto» → «Entendido, agosto no. ¿Entonces a cuál…?» con
 * las dos que quedan; nunca la lista completa repetida.
 */
export function mensajeAcotado(
    quedan: PagoPendiente[],
    dicePagado: PagoPendiente[],
    antes: PagoPendiente[],
    motivo: 'descarte' | 'ambiguo',
): string {
    const fuera = antes.filter((p) => !quedan.includes(p));
    const lineas = quedan.map((p, i) => `${i + 1}. ${describirPago(p)}`).join('\n');
    const nombres = [...new Set(fuera.map(etiquetaDeCobro))].join(' y ');
    const cabeza = motivo === 'ambiguo'
        ? 'Hay más de un cobro de ese mes. ¿A cuál de estos aplico el comprobante?'
        : dicePagado.length
            ? `Entendido, *${nombres}* no. Le aviso a la escuela que ya lo pagaste para que lo revise. ` +
              '¿Entonces a cuál de estos aplico el comprobante?'
            : `Entendido, *${nombres}* no. ¿Entonces a cuál de estos aplico el comprobante?`;
    return `${cabeza}\n\n${lineas}\n\nToca el botón o respóndeme con el número.`;
}

/**
 * La repregunta cuando no se entendió. Distinta de la pregunta original y
 * distinta entre un intento y el siguiente: repetir el mismo texto le dice a
 * la familia que nadie la está leyendo. Pura.
 */
export function mensajeReintento(opciones: PagoPendiente[], intento: number): string {
    const lineas = opciones.map((p, i) => `${i + 1}. ${describirPago(p)}`).join('\n');
    const cabeza = intento <= 0
        ? 'Perdón, no te entendí a cuál cobro va el comprobante 🙏'
        : 'Sigo sin tener claro a cuál cobro va. Para no aplicarlo al que no es:';
    const pie = intento <= 0
        ? 'Toca el botón del cobro, o escríbeme el número o el mes (por ejemplo «el de ' +
          `${etiquetaDeCobro(opciones[opciones.length - 1])}»).`
        : 'Toca uno de los botones. Si no es ninguno, escribe *ninguno*.';
    return `${cabeza}\n\n${lineas}\n\n${pie}`;
}

/**
 * ¿La familia eligió varios cobros y el comprobante suma exacto TODOS ellos
 * (no solo el más antiguo)? Ahí no se estampa en uno: lo reparte la escuela.
 * Con un monto distinto (o sin leer) se sigue la regla de siempre: al más
 * antiguo y se nombra lo que queda. Pura.
 */
export function cubreVariosNoSoloElMasAntiguo(elegidos: PagoPendiente[], monto: unknown): boolean {
    if (elegidos.length < 2) return false;
    const m = Number(monto);
    if (!Number.isFinite(m) || m <= 0) return false;
    const suma = elegidos.reduce((s, p) => s + Number(p.amount || 0), 0);
    return Math.abs(m - suma) < 1 && Math.abs(m - Number(elegidos[0].amount || 0)) >= 1;
}

// ─── La escuela tomó la conversación (auditoría Dynasty 2026-10-10) ─────────

/**
 * ¿Una PERSONA de la escuela escribió en el chat después de `preguntaAt`?
 * Cuenta el echo de Coexistence y el buzón (`ai_generated=false`); no cuentan
 * el bot, los automáticos de WhatsApp Business ni las plantillas que manda la
 * app (recordatorios de cobro, también `ai_generated=false`). Pura.
 */
export function escuelaEscribioDespues(filas: FilaReciente[], preguntaAt: string | null): boolean {
    if (!preguntaAt) return false;
    const desde = new Date(preguntaAt).getTime();
    if (!Number.isFinite(desde)) return false;
    return filas.some((f) => esHumanoDeLaEscuela(f)
        && String(f.type ?? '') !== 'template'
        && new Date(f.wa_timestamp || f.created_at || 0).getTime() > desde);
}

/** Lee los salientes humanos de la conversación desde la pregunta. Nunca lanza (ante la duda, no). */
async function laEscuelaTomoLaConversacion(
    integrationId: string, contactWaId: string, preguntaAt: string | null,
): Promise<boolean> {
    if (!preguntaAt) return false;
    try {
        const { data: conv } = await supabase.from('whatsapp_conversations')
            .select('id')
            .eq('integration_id', integrationId)
            .eq('contact_wa_id', contactWaId)
            .maybeSingle();
        const convId = (conv as any)?.id as string | undefined;
        if (!convId) return false;
        const { data } = await supabase.from('whatsapp_messages')
            .select('direction, type, text_body, payload, ai_generated, wa_timestamp, created_at')
            .eq('conversation_id', convId)
            .eq('direction', 'outbound')
            .eq('ai_generated', false)
            .gte('created_at', preguntaAt)
            .limit(20);
        return escuelaEscribioDespues(Array.isArray(data) ? data as FilaReciente[] : [], preguntaAt);
    } catch {
        return false;
    }
}

// ─── El monto contra el cobro elegido ───────────────────────────────────────

const cop = (n: number) =>
    `$${Math.round(n).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;

/** El monto que leyó el OCR, o null si no hay uno usable. Pura. */
export function montoLeido(v: unknown): number | null {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Pasarelas y medios en línea: el comprobante lleva el recargo de la escuela. */
const PAGO_EN_LINEA = /\b(wompi|pse|mercado\s?pago|payu|epayco|pago\s+en\s+l[ií]nea|checkout)\b/i;

/**
 * ¿El comprobante es de un pago en línea (Wompi, PSE, Mercado Pago…)? Se mira
 * lo que leyó el OCR: banco/medio, destino, descripción, referencia y el texto
 * crudo. Pura.
 */
export function esPagoEnLinea(ocr: any): boolean {
    if (!ocr || typeof ocr !== 'object') return false;
    return [ocr.bank, ocr.destinationName, ocr.destination, ocr.description, ocr.reference, ocr.rawText]
        .some((t) => typeof t === 'string' && PAGO_EN_LINEA.test(t));
}

/**
 * ¿El monto del comprobante es el del cobro? Exacto (±$1), o —si es un pago
 * en línea— el cobro más el recargo de la escuela, con el mismo redondeo que
 * el checkout (`montosEnLinea` de cobro-enlace-publico). Pura.
 */
export function montoCuadraConElCobro(
    monto: number,
    pago: Pick<PagoPendiente, 'amount'>,
    o: { feePct: number; enLinea: boolean },
): boolean {
    const base = Number(pago.amount || 0);
    if (!(base > 0)) return false;
    if (Math.abs(monto - base) < 1) return true;
    if (!o.enLinea || !(o.feePct > 0)) return false;
    const conRecargo = base + Math.round(base * (o.feePct / 100));
    return Math.abs(monto - conRecargo) < 1;
}

/** Lo que se le dice a la familia: UNA respuesta, sin prometer que se aplicó. Pura. */
export function textoMontoNoCuadra(monto: number, pago: PagoPendiente): string {
    return `Recibí tu comprobante de *${cop(monto)}* 📄 No coincide con el valor de ` +
        `*${describirPago(pago)}*, así que se lo paso a la escuela para que lo revise y te confirme por aquí.`;
}

/** `error_message` de la fila (la Bandeja de comprobantes lo muestra). Pura. */
export function motivoMontoNoCuadra(monto: number, pago: PagoPendiente): string {
    return (`monto_no_cuadra: la familia eligió ${describirPago(pago)} con un comprobante de ${cop(monto)}; ` +
        'la escuela no recibe abonos: revisen a qué corresponde antes de aplicarlo').slice(0, 500);
}

/**
 * ¿La escuela recibe abonos, y cuál es su recargo en línea? Ante la duda, no
 * recibe abonos (default de la columna; decir «sí» por error estampa en
 * silencio un monto que no cuadra) y el recargo es el 3 % de siempre.
 */
async function reglasDeMontoDeLaEscuela(schoolId: string): Promise<{ permiteAbonos: boolean; feePct: number }> {
    try {
        const { data } = await supabase.from('school_settings')
            .select('allow_installments, online_fee_pct')
            .eq('school_id', schoolId)
            .maybeSingle();
        const fee = (data as any)?.online_fee_pct;
        return {
            permiteAbonos: (data as any)?.allow_installments === true,
            feePct: fee != null && Number.isFinite(Number(fee)) ? Number(fee) : 3,
        };
    } catch {
        return { permiteAbonos: false, feePct: 3 };
    }
}

// ─── Comprobantes con motivo (plan B4, 2026-10-30) ──────────────────────────

/**
 * La familia contestó «¿de qué es?» con un motivo que tiene precio en la
 * escuela (las opciones de `opcionesDeMotivo`, solo con el interruptor
 * prendido) y el comprobante es ese precio (±$1): la cola crea el cobro y le
 * aplica el comprobante. true = consumió el turno. Si no aplica, false y sigue
 * la bandeja de siempre (`resolverRespuestaGuiada`).
 */
async function aplicarMotivoElegido(fila: FilaEsperando, texto: string, responder: ResponderCobro): Promise<boolean> {
    const guia = fila.pregunta_ocr?.guia as { opciones?: OpcionGuiada[]; deportista?: { id?: string } | null } | undefined;
    const opcion = interpretarOpcion(texto, guia?.opciones ?? []);
    if (!opcion || !esValorMotivoElegido(opcion.valor)) return false;
    const monto = montoLeido(fila.pregunta_ocr?.ocr?.amount);
    if (monto === null || Math.abs(monto - opcion.valor.monto) > 1) return false;
    if (!fila.pregunta_ocr?.parentId && !guia?.deportista?.id) return false;
    await aplicarComprobanteConMotivo(fila.id, opcion.valor, responder);
    return true;
}

/** ¿El texto ES el título de un botón del resumen de motivos? Pura. */
export function botonDeResumen(texto: string | null | undefined): 'ok' | 'cambiar' | null {
    const t = normalizarFrase(texto);
    if (!t) return null;
    if (t === normalizarFrase(BOTON_MOTIVOS_OK.title)) return 'ok';
    if (t === normalizarFrase(BOTON_MOTIVOS_CAMBIAR.title)) return 'cambiar';
    return null;
}

interface LineaGuardada { monto?: number | null; motivo?: string; atleta?: string | null; paymentId?: string }

/** El último saliente (< 24 h) del contacto, si es el resumen de motivos. Nunca lanza. */
async function resumenDeMotivosAbierto(integrationId: string, contactWaId: string): Promise<{ lineas: LineaGuardada[] } | null> {
    try {
        const { data: conv } = await supabase.from('whatsapp_conversations')
            .select('id').eq('integration_id', integrationId).eq('contact_wa_id', contactWaId).maybeSingle();
        const convId = (conv as any)?.id as string | undefined;
        if (!convId) return null;
        const { data } = await supabase.from('whatsapp_messages')
            .select('payload, created_at')
            .eq('conversation_id', convId)
            .eq('direction', 'outbound')
            .gte('created_at', new Date(Date.now() - VIGENCIA_H * 3600_000).toISOString())
            .order('created_at', { ascending: false })
            .limit(1);
        const ultimo = Array.isArray(data) ? (data[0] as any) : null;
        if (ultimo?.payload?.step !== PASO_RESUMEN_MOTIVOS) return null;
        return { lineas: Array.isArray(ultimo.payload.lineas) ? ultimo.payload.lineas : [] };
    } catch {
        return null;
    }
}

/**
 * ¿El último mensaje del bot a este contacto (< 24 h) es el resumen de motivos?
 * Para la integración en whatsapp-bot.service: un prospecto (no identificado)
 * solo llega al resolver si hay una pregunta abierta; con esto también puede
 * tocar «Cambiar un motivo». Nunca lanza.
 */
export async function hayResumenDeMotivosAbierto(integrationId: string, contactWaId: string): Promise<boolean> {
    return (await resumenDeMotivosAbierto(integrationId, contactWaId)) !== null;
}

/** «Sí, está bien» → gracias. «Cambiar un motivo» → a la escuela con las líneas (v1: corrige la escuela). */
async function atenderResumenDeMotivos(
    integrationId: string, contactWaId: string, boton: 'ok' | 'cambiar', texto: string,
    responder: ResponderCobro, pasarALaEscuela?: PasarALaEscuela,
): Promise<boolean> {
    const abierto = await resumenDeMotivosAbierto(integrationId, contactWaId);
    if (!abierto) return false;
    if (boton === 'ok') {
        await responder('¡Gracias! 🙌 Quedan así; la escuela los revisa y te confirma.', 'resumen_motivos_ok');
        return true;
    }
    const lineas = abierto.lineas
        .map((l) => `${typeof l.monto === 'number' ? cop(l.monto) : 'sin monto'} → ${l.motivo ?? '?'}${l.atleta ? ` · ${l.atleta}` : ''}`)
        .join(' | ');
    const resumen = `cambiar_motivo: la familia pide cambiar un motivo del resumen (${lineas || 'sin líneas'}); escribió «${texto.slice(0, 80)}»`;
    const mensaje = 'Listo 🙏 Le aviso a la escuela para que lo corrija contigo por aquí. Si quieres, escríbeme cuál cambiarías.';
    if (pasarALaEscuela) await pasarALaEscuela({ resumen, mensajeFamilia: mensaje });
    else await responder(mensaje, 'resumen_motivos_cambiar');
    return true;
}

/** «Sigue el comprobante de $X: ¿De qué mes es?…» — la pregunta que esperaba en fila. Pura. */
export function textoSigueEnFila(e: { texto: string; monto?: number | null }): string {
    const pregunta = String(e.texto ?? '').replace(/^Recibí tu comprobante[^📄]*📄\s*/u, '').trim() || e.texto;
    return `Sigue el comprobante${typeof e.monto === 'number' && e.monto > 0 ? ` de *${cop(e.monto)}*` : ''}: ${pregunta}`;
}

/**
 * Resuelta una pregunta, sale la más vieja de las que esperaban en fila
 * (`pregunta_ocr.en_fila`, `pregunta_at` null): recibe `pregunta_at = now()` y
 * se envía con sus botones. No sale si queda otra pregunta abierta o si una
 * persona de la escuela escribió desde que llegó (la conversación es suya; la
 * fila la vence el worker y va al buzón). Nunca lanza.
 */
export async function promoverSiguientePregunta(
    integrationId: string, contactWaId: string, responder: ResponderCobro,
): Promise<boolean> {
    try {
        const { data } = await supabase.from('whatsapp_inbound_queue')
            .select('id, pregunta_at, pregunta_ocr, created_at')
            .eq('integration_id', integrationId)
            .eq('wa_phone_number', contactWaId)
            .eq('status', 'waiting_user')
            .order('created_at', { ascending: true })
            .limit(10);
        const filas = (Array.isArray(data) ? data : []) as any[];
        const corte = Date.now() - VIGENCIA_H * 3600_000;
        if (filas.some((f) => f.pregunta_at && new Date(f.pregunta_at).getTime() > corte)) return false;
        const siguiente = filas.find((f) => !f.pregunta_at && f.pregunta_ocr?.en_fila);
        if (!siguiente) return false;
        if (await laEscuelaTomoLaConversacion(integrationId, contactWaId, siguiente.created_at ?? null)) return false;

        const { en_fila: enFila, ...resto } = siguiente.pregunta_ocr;
        const ahora = new Date().toISOString();
        const { data: tomadas } = await supabase.from('whatsapp_inbound_queue')
            .update({ pregunta_at: ahora, updated_at: ahora, pregunta_ocr: resto })
            .eq('id', siguiente.id).eq('status', 'waiting_user').is('pregunta_at', null)
            .select('id');
        if (!Array.isArray(tomadas) || !tomadas.length) return false;
        await responder(textoSigueEnFila({ texto: enFila.texto, monto: enFila.monto ?? siguiente.pregunta_ocr?.ocr?.amount ?? null }),
            enFila.paso, Array.isArray(enFila.botones) && enFila.botones.length ? enFila.botones : undefined);
        return true;
    } catch {
        return false;
    }
}

async function cerrarPregunta(
    id: string,
    motivo: string,
    status: 'ignored' | 'failed' = 'ignored',
) {
    await supabase.from('whatsapp_inbound_queue')
        .update({
            status,
            processed_at: new Date().toISOString(),
            error_message: motivo,
        })
        .eq('id', id);
}
