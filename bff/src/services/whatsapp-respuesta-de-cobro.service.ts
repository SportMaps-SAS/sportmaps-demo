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
import { esCerradaPorEscuela } from './whatsapp-bandeja.service';
import { aplicarComprobante, aplicarComprobanteConMotivo } from '../jobs/whatsapp-queue.job';
import {
    interpretarEleccion, loQueQueda, etiquetaDeCobro, resumenParaLaEscuela, TEXTO_REVISION_ESCUELA,
} from './whatsapp-eleccion-de-pago.service';
import { resolverRespuestaDeDeportista, resolverRespuestaDeAsistente, botonesDeCobros } from './whatsapp-comprobante-de-ficha.service';
import {
    resolverRespuestaGuiada, interpretarOpcion, PASO_RESUMEN_MOTIVOS, BOTON_MOTIVOS_OK, BOTON_MOTIVOS_CAMBIAR,
    type OpcionGuiada,
} from './whatsapp-comprobante-guiado.service';
import { esValorMotivoElegido, hoyBogota } from './wa-cobro-desde-comprobante.service';
import { motivoConPropuesta } from './whatsapp-pago-esperado.service';
import { registroGuardado, resumenDeAsistente } from './wa-registro-de-venta.service';
import { registrarNombreTardio, textoNombreTardioGuardado } from './wa-nombre-tardio.service';
import { describirPago, type PagoPendiente } from './whatsapp-receipt-matching.service';
import { soloSaludoOCortesia } from './whatsapp-atencion.service';
import { cargarRecargos, montoEsperado } from './whatsapp-excedente.service';
import { esHumanoDeLaEscuela, normalizarFrase, type FilaReciente } from './whatsapp-reglas-turno';
import type { BotonInteractivo, WhatsAppIntegration } from './whatsapp.service';
import { MARCA_VENTA } from './whatsapp-venta-contexto';
import {
    cuentaComoRespuesta, esCorreccionDeResultado, puedeSerCorreccion, motivoReclamo, TEXTO_RECLAMO_RECIBIDO,
    MINUTOS_CORRECCION, CODIGO_RECLAMO,
} from './wa-cola-reglas';

// La regla pura del reclamo vive en wa-cola-reglas; se reexporta para quien atienda textos fuera de este módulo
// (el bot general con un contacto NO identificado: ver `resolverReclamoDeResultado`).
export { esCorreccionDeResultado } from './wa-cola-reglas';

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

/**
 * Responde a la familia. `botones`: las opciones como botones (si el canal los
 * soporta). `payload` (2026-11-08): se mezcla en el del saliente — la venta de un
 * servicio lo marca con `venta_servicio_id` (MARCA_VENTA). `linea` no se usa acá.
 */
export type ResponderCobro = (texto: string, paso: string, botones?: BotonInteractivo[],
    linea?: unknown, payload?: Record<string, unknown>) => Promise<unknown>;

/**
 * Pasa el caso a la escuela con `resumen`. `mensajeFamilia`: lo que se le
 * dice a la familia (UNA vez, lo dice quien escala); null = solo la escuela.
 */
export type PasarALaEscuela = (p: { resumen: string; mensajeFamilia: string | null }) => Promise<unknown>;

interface FilaEsperando {
    id: string;
    /** Cuándo llegó el comprobante que originó la pregunta. */
    created_at?: string | null;
    pregunta_opciones: PagoPendiente[] | null;
    pregunta_ocr: {
        ocr: any;
        sha: string;
        storagePath: string | null;
        /** null: familia sin cuenta (cobros por ficha). */
        parentId: string | null;
        /**
         * 'deportista': se preguntó de qué deportista es. 'mes' / 'concepto': preguntas guiadas (spec 3.3).
         * 'asistente_servicio' (2026-11-08): venta de un servicio, se preguntó el nombre de quien asiste.
         */
        tipo?: 'deportista' | 'mes' | 'concepto' | 'asistente_servicio';
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

/**
 * El nombre llegó tarde: se guarda (prospecto + concepto del cobro + acompañante) y SOLO después se responde.
 * false = no corresponde; el texto sigue al bot general.
 */
async function resolverNombreTardio(
    integration: WhatsAppIntegration, contactWaId: string, texto: string, responder: ResponderCobro,
): Promise<boolean> {
    try {
        const g = await registrarNombreTardio({
            integrationId: integration.id, schoolId: integration.school_id, contactWaId, texto,
        });
        if (!g) return false;
        await responder(textoNombreTardioGuardado(g), 'nombre_tardio_registrado');
        return true;
    } catch {
        return false;
    }
}

// ─── Reclamo o corrección tras el resultado (R11, auditoría 1–16 nov 2026) ───
//
// «Este fue octubre», «El 3 de octubre hicimos pago de octubre. Ahora estoy pagando noviembre» (tras «Listo:
// comprobante… para octubre»); «Ahí dice estado exitoso / compra exitosa» (tras «no es un comprobante de pago»);
// «No has revisado este pago del domingo». Cinco conversaciones en las que el cliente corrigió al asistente y
// nadie se enteró: la fila seguía «resuelta». Ahora, si en los 30 minutos siguientes al resultado el cliente lo
// contradice, la fila pasa a ACCIÓN con su texto y a él se le dice que la escuela lo revisa.

/** Pasos del saliente que NO son un resultado (preguntas y acuses): un texto tras ellos no es una corrección. */
const esPasoDeResultado = (paso: string) => !!paso && !paso.startsWith('ask_') && !paso.startsWith('embudo_')
    && !['acuse', 'acuse_diferido', 'reclamo_de_resultado', 'nombre_tardio_registrado'].includes(paso);

/**
 * ¿El texto corrige o reclama el último resultado que la cola le dio a este contacto (< 30 min)? Si sí, la fila de
 * ese comprobante queda en la bandeja como ACCIÓN con el texto del cliente (sin tocar el cobro) y se le responde.
 * Solo lee la base si el texto tiene forma de corrección (`puedeSerCorreccion`). Nunca lanza; true = consumió el turno.
 *
 * Lo llama `resolverFilaAbierta` cuando no hay ninguna pregunta abierta, es decir, para todo texto que el bot le
 * pasa a `resolverRespuestaDeCobro`. Exportada para el caso que NO pasa por acá (contacto no identificado sin
 * pregunta abierta: el bot general no llama al resolver).
 */
export async function resolverReclamoDeResultado(
    integration: WhatsAppIntegration, contactWaId: string, texto: string,
    responder: ResponderCobro, pasarALaEscuela?: PasarALaEscuela,
): Promise<boolean> {
    try {
        if (!puedeSerCorreccion(texto)) return false;
        const { data: conv } = await supabase.from('whatsapp_conversations')
            .select('id').eq('integration_id', integration.id).eq('contact_wa_id', contactWaId).maybeSingle();
        const convId = (conv as any)?.id as string | undefined;
        if (!convId) return false;
        const { data } = await supabase.from('whatsapp_messages')
            .select('payload, text_body, created_at')
            .eq('conversation_id', convId).eq('direction', 'outbound')
            .gte('created_at', new Date(Date.now() - MINUTOS_CORRECCION * 60_000).toISOString())
            .order('created_at', { ascending: false })
            .limit(10);
        const ultimo = ((Array.isArray(data) ? data : []) as any[])
            .find((m) => typeof m?.payload?.queue_id === 'string' && esPasoDeResultado(String(m.payload.step ?? '')));
        if (!ultimo) return false;
        const paso = String(ultimo.payload.step);
        const minutos = (Date.now() - new Date(ultimo.created_at).getTime()) / 60_000;
        const correccion = esCorreccionDeResultado(texto, { paso, texto: ultimo.text_body ?? null, minutos });
        if (!correccion) return false;

        const ids: string[] = [...new Set([ultimo.payload.queue_id,
            ...(Array.isArray(ultimo.payload.queue_ids) ? ultimo.payload.queue_ids : [])].filter((x) => typeof x === 'string'))];
        const { data: filas } = await supabase.from('whatsapp_inbound_queue')
            .select('id, status, result_type, error_message')
            .eq('integration_id', integration.id).in('id', ids).limit(20);
        const tocables = ((Array.isArray(filas) ? filas : []) as any[]).filter((f) =>
            ['done', 'ignored', 'failed'].includes(String(f.status))
            && !String(f.error_message ?? '').startsWith(CODIGO_RECLAMO)
            && !String(f.error_message ?? '').startsWith('cerrado_escuela:'));
        if (!tocables.length) return false;
        // Una actualización por grupo (aplicadas a un cobro / el resto), no una por fila.
        const unica = tocables.length === 1 ? tocables[0] : null;
        for (const aplicada of [true, false]) {
            const grupo = tocables.filter((f) => (f.result_type === 'payment_receipt') === aplicada);
            if (!grupo.length) continue;
            await supabase.from('whatsapp_inbound_queue')
                .update({
                    // `ignored` es lo que lista la bandeja; el cobro (si lo hay) no se toca y sigue enlazado.
                    status: 'ignored',
                    ...(aplicada ? {} : { result_type: 'escalated' }),
                    error_message: motivoReclamo({ texto, correccion, paso, previo: unica?.error_message ?? null }).slice(0, 500),
                })
                .in('id', grupo.map((f) => f.id));
        }
        const resumen = motivoReclamo({ texto, correccion, paso });
        if (pasarALaEscuela) await pasarALaEscuela({ resumen, mensajeFamilia: TEXTO_RECLAMO_RECIBIDO });
        else await responder(TEXTO_RECLAMO_RECIBIDO, 'reclamo_de_resultado');
        return true;
    } catch {
        return false;
    }
}

/**
 * ¿Después del comprobante de esta pregunta llegó otro archivo del mismo contacto? Nunca lanza: ante un error,
 * false (se comporta como antes). Una sola consulta acotada por integración + teléfono.
 */
export async function hayComprobanteMasNuevo(
    integrationId: string,
    contactWaId: string,
    fila: { id: string; created_at?: string | null },
): Promise<boolean> {
    if (!fila.created_at) return false;
    try {
        const { data } = await supabase
            .from('whatsapp_inbound_queue')
            .select('id')
            .eq('integration_id', integrationId)
            .eq('wa_phone_number', contactWaId)
            .in('message_type', ['image', 'document'])
            .neq('id', fila.id)
            .gt('created_at', fila.created_at)
            .limit(1);
        return Array.isArray(data) && data.length > 0;
    } catch {
        return false;
    }
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
        .select('id, created_at, pregunta_opciones, pregunta_ocr, pregunta_at, retries, school_id, error_message')
        .eq('integration_id', integration.id)
        .eq('wa_phone_number', contactWaId)
        .eq('status', 'waiting_user')
        .order('pregunta_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();

    // Una fila que ya pasó a «Por clasificar» (`cerrado_escuela:`) no espera a la familia: contestarle no aplica nada.
    const fila = (esCerradaPorEscuela((data as any)?.error_message) ? null : data) as FilaEsperando | null;
    // Sin ninguna pregunta abierta: ¿es el nombre de quien asiste que llegó DESPUÉS del comprobante (Aleja,
    // 2026-11-11)? Solo si el texto parece un nombre y hay un comprobante cerrado reciente con nombre de relleno.
    // Y si tampoco: ¿está corrigiendo o reclamando el resultado que la cola le acaba de dar? (R11)
    if (!fila) {
        return (await resolverNombreTardio(integration, contactWaId, texto, responder))
            || resolverReclamoDeResultado(integration, contactWaId, texto, responder, pasarALaEscuela);
    }
    // Una pregunta en fila (todavía no salió) no se contesta: sale cuando se
    // resuelva la anterior, o la vence el worker y va al buzón.
    if (!fila.pregunta_at && fila.pregunta_ocr?.en_fila) return false;

    // Una persona de la escuela escribió en el chat DESPUÉS de la pregunta
    // (Milena desde su celular o el buzón): la conversación es suya. La
    // pregunta se cierra y no se contesta nada — antes cada «ok» o «gracias»
    // de la familia volvía a sacar «¿a cuál cobro va?» encima de la escuela
    // (auditoría Dynasty 2026-10-10). El comprobante queda en la bandeja.
    if (await laEscuelaTomoLaConversacion(integration.id, contactWaId, fila.pregunta_at)) {
        // (R5, 2026-11-16) Venta de un servicio: el pago NO se pierde porque la escuela haya escrito (Monster
        // 2026-11-15: la clínica de $200.000 y el vacacional de $140.000 quedaron `ignored` sin cobro). Si la
        // respuesta trae los datos que se pidieron, el cobro se crea igual, SIN hablarle encima a la persona de la
        // escuela. Si no los trae, la fila queda en la bandeja como acción, con lo que se sabe y la propuesta.
        if (fila.pregunta_ocr?.tipo === 'asistente_servicio') {
            const edad = fila.pregunta_at ? (Date.now() - new Date(fila.pregunta_at).getTime()) / 3_600_000 : Infinity;
            if (edad <= VIGENCIA_H && await resolverRespuestaDeAsistente(fila, texto, RESPONDER_CALLADO)) return true;
            await cerrarVentaConLaEscuelaEnElChat(fila);
            return true;
        }
        await cerrarPregunta(fila.id, MOTIVO_ESCUELA_TOMO);
        return true;
    }

    // «¿De qué mes es?» / «¿Es de mensualidad, inscripción u otro?» (spec 3.3): la
    // respuesta es una opción de la guía. Nunca por audio: solo botón, número o texto.
    if (fila.pregunta_ocr?.tipo === 'mes' || fila.pregunta_ocr?.tipo === 'concepto') {
        const edad = fila.pregunta_at ? (Date.now() - new Date(fila.pregunta_at).getTime()) / 3_600_000 : Infinity;
        if (edad > VIGENCIA_H) return false;
        // (2026-11-17, Monster/Liliana) Llegó un comprobante MÁS NUEVO después del de esta pregunta: lo que la
        // persona escribe ahora habla del nuevo. Antes «envío comprobante vacacional» (18 h después) contestó la
        // pregunta vieja y el comprobante de $37.500 (reposición de balón) quedó como «vacacional». La pregunta
        // vieja la vence el worker y va a la bandeja con su motivo.
        if (await hayComprobanteMasNuevo(integration.id, contactWaId, fila)) return false;
        // Una cortesía («gracias», «ok») dentro de la hora no es una respuesta ni merece «No te entendí».
        if (edad <= 1 && soloSaludoOCortesia(texto)) return true;
        // (R10) Pasada una hora, solo cuenta lo que calza con una opción o habla de pago/mes/monto.
        if (!cuentaComoRespuesta({
            texto, minutos: edad * 60,
            calzaConOpcion: !!interpretarOpcion(texto, (fila.pregunta_ocr.guia?.opciones ?? []) as OpcionGuiada[]),
        })) return false;
        // (Plan B4) Eligió un motivo con precio y el comprobante es ese precio:
        // se crea el cobro y se aplica. Si no, la bandeja de siempre.
        if (fila.pregunta_ocr.tipo === 'concepto' && await aplicarMotivoElegido(fila, texto, responder)) return true;
        return resolverRespuestaGuiada(fila as any, texto, responder);
    }

    // Venta de un servicio: «¿Cuál es el nombre completo de quien asiste…?». Con
    // un nombre se crea el cobro del servicio; lo que no es un nombre (una
    // pregunta de la clínica, «ok») sigue al bot y la pregunta queda abierta.
    if (fila.pregunta_ocr?.tipo === 'asistente_servicio') {
        const edad = fila.pregunta_at ? (Date.now() - new Date(fila.pregunta_at).getTime()) / 3_600_000 : Infinity;
        if (edad > VIGENCIA_H) return false;
        const minutos = edad * 60;
        // «Sí» es la respuesta a «¿Es para X, como la vez pasada?», no una cortesía pegada al comprobante.
        const confirmando = typeof (fila.pregunta_ocr as any)?.venta?.confirmar?.nombre === 'string';
        if (!confirmando && soloSaludoOCortesia(texto) && minutos <= SALUDO_PEGADO_MIN) return true;
        return resolverRespuestaDeAsistente(fila, texto, responder);
    }

    // «¿De qué deportista es este pago?» (número sin ficha): la respuesta es un
    // nombre, no una opción. Vencida, sigue su curso (la vence el worker).
    if (fila.pregunta_ocr?.tipo === 'deportista') {
        const edad = fila.pregunta_at ? (Date.now() - new Date(fila.pregunta_at).getTime()) / 3_600_000 : Infinity;
        if (edad > VIGENCIA_H) return false;
        // (R10) Pasada una hora, solo cuenta un botón/número, un nombre o algo que hable del pago.
        if (!cuentaComoRespuesta({
            texto, minutos: edad * 60, calzaConOpcion: /^\s*\d\s*$/.test(String(texto ?? '')), esperaNombre: true,
        })) return false;
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

    // (R10, auditoría 1–16 nov 2026) 16 h después de la pregunta la clienta le hablaba a la dueña de otra cosa y
    // recibió dos veces «no te entendí a cuál cobro va». Pasada una hora, solo cuenta como respuesta lo que calza
    // con una opción ofrecida o habla de pago/mes/monto; lo demás no se consume ni dispara una repregunta (la
    // pregunta sigue abierta hasta que venza y la fila pase a la bandeja).
    if (!cuentaComoRespuesta({
        texto, minutos,
        calzaConOpcion: eleccion.tipo === 'elegido' || eleccion.tipo === 'acotar' || eleccion.tipo === 'revision_escuela',
    })) return false;

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

// ─── La escuela escribió mientras se esperaban los datos de una venta (2026-11-16) ──

/**
 * El `responder` de cuando la escuela está en el chat: no manda nada (misma forma que el de la cola con la
 * conversación tomada: `{ silenciado: true }`). El cobro se crea igual.
 */
const RESPONDER_CALLADO: ResponderCobro = async () => ({ ok: true, silenciado: true });

/** `error_message` de la venta que se cerró con la escuela en el chat y sin los datos de quien asiste. */
export const CODIGO_VENTA_ESCUELA_EN_EL_CHAT = 'venta_falta_nombre';

/**
 * El motivo que ve la escuela en la bandeja (acción): monto, servicio, lo que se sabe de quien asiste y la
 * propuesta. Pura.
 */
export function motivoVentaConLaEscuelaEnElChat(guardado: FilaEsperando['pregunta_ocr'], hoy: string): string {
    const venta = ((guardado as any)?.venta ?? {}) as Record<string, any>;
    const monto = montoLeido(guardado?.ocr?.amount);
    const servicio = typeof venta.itemNombre === 'string' && venta.itemNombre ? venta.itemNombre : 'el servicio';
    const registro = venta.registro ? registroGuardado(venta.registro) : null;
    const confirmar = typeof venta.confirmar?.nombre === 'string' ? venta.confirmar.nombre as string : null;
    return motivoConPropuesta(
        `${CODIGO_VENTA_ESCUELA_EN_EL_CHAT}: comprobante${monto ? ` de ${cop(monto)}` : ''} para ${servicio}; `
        + 'la escuela escribió en el chat y la persona no dio los datos de quien asiste',
        `Propuesta → pagó: ${guardado?.ocr?.originName ?? 'no se leyó'} · asiste: ${resumenDeAsistente(registro, hoy)}`
        + `${confirmar ? ` (¿es para ${confirmar}, como la vez pasada?)` : ''} · `
        + 'pedir los datos que faltan, crear el cobro del servicio y aplicar este comprobante');
}

/** Cierra la pregunta de una venta como ACCIÓN para la escuela (no «Sin clasificar»). */
async function cerrarVentaConLaEscuelaEnElChat(fila: FilaEsperando): Promise<void> {
    const ahora = new Date();
    await supabase.from('whatsapp_inbound_queue')
        .update({
            status: 'ignored',
            result_type: 'escalated',
            processed_at: ahora.toISOString(),
            error_message: motivoVentaConLaEscuelaEnElChat(fila.pregunta_ocr, hoyBogota(ahora.getTime())),
        })
        .eq('id', fila.id);
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
            .select('id, pregunta_at, pregunta_ocr, created_at, error_message')
            .eq('integration_id', integrationId)
            .eq('wa_phone_number', contactWaId)
            .eq('status', 'waiting_user')
            .order('created_at', { ascending: true })
            .limit(10);
        const filas = ((Array.isArray(data) ? data : []) as any[]).filter((f) => !esCerradaPorEscuela(f?.error_message));
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
        // La pregunta de una venta (el nombre de quien asiste) sale con la marca del servicio.
        const itemVenta = typeof resto?.venta?.itemId === 'string' ? resto.venta.itemId : null;
        await responder(textoSigueEnFila({ texto: enFila.texto, monto: enFila.monto ?? siguiente.pregunta_ocr?.ocr?.amount ?? null }),
            enFila.paso, Array.isArray(enFila.botones) && enFila.botones.length ? enFila.botones : undefined,
            undefined, itemVenta ? { [MARCA_VENTA]: itemVenta } : undefined);
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
