/**
 * whatsapp — Webhook único multi-tenant de la WhatsApp Cloud API (Bloque 6).
 *
 * Endpoints:
 *   GET  /api/v1/webhooks/whatsapp  → verificación del webhook (challenge de Meta)
 *   POST /api/v1/webhooks/whatsapp  → recepción de mensajes/estados de TODAS las escuelas
 *
 * Seguridad (decisión de arquitectura #2):
 *  - GET: valida hub.verify_token contra WHATSAPP_VERIFY_TOKEN.
 *  - POST: valida HMAC-SHA256 (X-Hub-Signature-256) sobre el RAW body con
 *    WHATSAPP_APP_SECRET. Rechaza requests no firmados (401).
 *  - Routing multi-tenant por phone_number_id -> integración -> school_id.
 *  - Idempotencia por wa_message_id (UNIQUE en BD).
 *  - Bloqueo por número (kill-switch, riesgo R14) antes de procesar.
 *
 * IMPORTANTE: este router necesita el RAW body para el HMAC. En index.ts,
 * express.json se monta con un `verify` que guarda req.rawBody (Buffer).
 *
 * La respuesta al webhook SIEMPRE es rápida (200) — el procesamiento del bot
 * (DeepSeek, intents, OTP) se hace fuera del ciclo de respuesta. En WA2 esto
 * se encola con pg-boss; aquí dejamos el punto de entrada (handleInbound).
 */

import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import {
    verifyWebhookSignature,
    resolveIntegration,
    parseInboundMessages,
    parseStatuses,
    type WhatsAppIntegration,
    type ParsedInboundMessage,
} from '../services/whatsapp.service';
import {
    runBotTurn, deliver, atenderDesconocido, mensajesRecientes, SILENCIO_HUMANO_MIN,
    TEXTO_MIME_RECHAZADO, vocativosDeEscuela, revisarEscalacionesVencidas, revisarRetomas,
    reservarPasoUnaVez, enviarRespuestaStaff, abrirEnBuzon,
} from '../services/whatsapp-bot.service';
import { debeAtender } from '../services/whatsapp-atencion.service';
import { encolarAdjunto } from '../services/whatsapp-queue.service';
import { correrTurnoAgrupado, ESPERA_RAFAGA_MS } from '../services/whatsapp-turno-agrupado.service';
import { anotarTurno, soltarTurno, seguirTarea } from '../services/whatsapp-turnos-pendientes.service';
import {
    humanoReciente, esCierreSuelto, respuestaATipoNoSoportado, PASO_TIPO_NO_SOPORTADO,
} from '../services/whatsapp-reglas-turno';
import { cerrarSiEsCierre } from '../services/whatsapp-ponerse-al-dia.service';
import { atenderNotaDeVoz, atenderNotaDeVozDeProspecto } from '../services/whatsapp-notas-de-voz.service';
import { conContextoLlm } from '../services/llm-usage.service';
import { esNumeroDePlataforma, guardarEstadoPlataforma } from '../services/plataforma-wa.service';
import { atenderEntrantePlataforma } from '../services/plataforma-wa-entrante.service';
import {
    identificarStaffPorTelefono, procesarMensajeStaff, esDisparadorDeLista, type StaffIdentificado,
} from '../services/whatsapp-asistencia-staff.service';
import { atenderRespuestaDeCampana, esPosibleRespuestaDeCampana } from '../services/whatsapp-campana-respuesta.service';

/**
 * Corre en segundo plano lo que espera (la ráfaga, el acuse): el webhook
 * procesa los mensajes de un POST en serie, y los echos de Coexistence —que
 * son los que callan al bot cuando la escuela escribe— van DESPUÉS en el mismo
 * POST. En las pruebas (espera 0) se espera, para poder afirmar sobre el
 * resultado.
 */
function enSegundoPlano(espera: number, tarea: () => Promise<unknown>, log: Request['log'], que: string): Promise<void> {
    // `seguirTarea`: el apagado ordenado (index.ts) la espera antes de salir.
    const p = seguirTarea(tarea().then(() => undefined).catch((err: any) => {
        log?.error({ err: err?.message || err }, `WhatsApp: ${que} falló`);
    }));
    return espera > 0 ? Promise.resolve() : p;
}
import { procesarEchos, procesarHistorial, registrarAppState, esContactoPersonal, payloadSinContenido }
    from '../services/whatsapp-coexistence.service';

/**
 * Plazo de las escalaciones (re-aviso a los 10/30 min sin respuesta humana,
 * whatsapp-bot.service `revisarEscalacionesVencidas`). Lo dispara el webhook,
 * como mucho una vez por minuto por proceso: los webhooks de Meta llegan solo
 * al BFF de producción, así que dev y stg no le escriben a familias reales por
 * acá. Con Dynasty en vivo entran estados de entrega cada pocos segundos; si
 * no entra nada, tampoco hay a quién re-avisar con prisa. La reserva en la
 * base lo hace idempotente igual.
 */
const CADA_REVISION_MS = 60_000;
let ultimaRevisionDePlazos = 0;
function revisarPlazosDeEscalacion(log: Request['log']): void {
    if (process.env.VITEST || process.env.DISABLE_WHATSAPP_PLAZO_ESCALACION === 'true') return;
    const ahora = Date.now();
    if (ahora - ultimaRevisionDePlazos < CADA_REVISION_MS) return;
    ultimaRevisionDePlazos = ahora;
    void revisarEscalacionesVencidas(ahora)
        .then((r) => { if (r.reavisadas > 0) log?.warn?.(r, 'WhatsApp: escalaciones sin respuesta re-avisadas'); })
        .catch((err: any) => log?.error?.({ err: err?.message || err }, 'WhatsApp: revisión de plazos falló'));
    // Retoma (auditoría 2026-10-07): la escuela cedió y nadie contestó. Cada
    // 5 min: mira las conversaciones con entrantes de las últimas 6 h.
    if (ahora - ultimaRevisionDeRetomas >= CADA_RETOMA_MS) {
        ultimaRevisionDeRetomas = ahora;
        void revisarRetomas(ahora)
            .then((r) => { if (r.respondidas + r.reavisadas > 0) log?.warn?.(r, 'WhatsApp: retomas tras ceder a la escuela'); })
            .catch((err: any) => log?.error?.({ err: err?.message || err }, 'WhatsApp: revisión de retomas falló'));
    }
}
const CADA_RETOMA_MS = 5 * 60_000;
let ultimaRevisionDeRetomas = 0;

const router = Router();

// ─── GET: verificación del webhook (Meta challenge) ──────────────────────────
router.get('/', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const expected = process.env.WHATSAPP_VERIFY_TOKEN;

    if (mode === 'subscribe' && expected && token === expected) {
        req.log?.info('WhatsApp webhook verified');
        // Meta espera el challenge crudo, status 200.
        return res.status(200).send(String(challenge ?? ''));
    }
    req.log?.warn({ mode }, 'WhatsApp webhook verification failed');
    return res.sendStatus(403);
});

// ─── POST: recepción de eventos ──────────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
    // 1. Validar firma HMAC sobre el RAW body.
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const signature = req.header('x-hub-signature-256');

    if (!rawBody || !verifyWebhookSignature(rawBody, signature)) {
        req.log?.warn('WhatsApp webhook: invalid or missing signature');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    const body = req.body;

    // 2. Responder 200 de inmediato (Meta reintenta si tardamos / fallamos).
    //    El procesamiento sigue async tras enviar la respuesta.
    res.status(200).json({ received: true });

    // 3. Procesar fuera del ciclo de respuesta.
    try {
        const messages = parseInboundMessages(body);
        for (const msg of messages) {
            await processInboundMessage(req, msg).catch((err) => {
                req.log?.error({ err: err?.message || err, waMessageId: msg.waMessageId }, 'WhatsApp message processing failed');
            });
        }
        // Estados de entrega. Llegan por el MISMO campo suscrito que los
        // mensajes, asi que ya estaban entrando: hasta hoy se descartaban.
        //
        // Importan por dos razones. Meta cobra por mensaje ENTREGADO, no
        // enviado, y el evento trae el bloque `pricing` que dice si fue
        // facturable y en que categoria — o sea, la misma senal con la que
        // Meta arma la factura. Es lo que alimenta el medidor de consumo.
        await procesarEstados(req, body).catch((err) => {
            req.log?.error({ err: err?.message || err }, 'WhatsApp: fallo el procesamiento de estados');
        });

        // Eventos de cuenta: plantillas desactivadas o recategorizadas, calidad
        // del numero, restricciones, cambios de limite de envio. Rompen el canal
        // sin hacer ruido, asi que se guardan todos.
        await procesarEventosDeCuenta(req, body).catch((err) => {
            req.log?.error({ err: err?.message || err }, 'WhatsApp: fallo el procesamiento de eventos de cuenta');
        });

        // Coexistence: el numero vive a la vez en el celular de la escuela y
        // en la API. Los echos son lo que la escuela escribe desde su
        // telefono — sin ellos el buzon mostraria conversaciones a medias y el
        // bot creeria que nadie respondio.
        await procesarEchos(body, req.log).catch((err) => {
            req.log?.error({ err: err?.message || err }, 'WhatsApp: fallo el procesamiento de echos');
        });

        // El historial llega en trozos y Meta da 24 h desde el alta para
        // sincronizarlo: pasadas, hay que desconectar y repetir. Por eso se
        // procesa al vuelo y no se difiere a un cron.
        await procesarHistorial(body, req.log).catch((err) => {
            req.log?.error({ err: err?.message || err }, 'WhatsApp: fallo el procesamiento del historial');
        });

        registrarAppState(body, req.log);

        revisarPlazosDeEscalacion(req.log);
    } catch (err: any) {
        req.log?.error({ err: err?.message || err }, 'WhatsApp webhook processing error');
    }
});

/** Los valores del CHECK `whatsapp_messages_status_check`. */
const ESTADOS_GUARDABLES = new Set(['received', 'queued', 'sent', 'delivered', 'read', 'failed']);

/**
 * Guarda el estado de entrega de los salientes y, sobre todo, lo que Meta cobro.
 *
 * No falla la peticion si algo sale mal: un estado perdido descuadra el medidor,
 * pero tumbar el webhook perderia mensajes de padres, que es peor.
 */
async function procesarEstados(req: Request, body: any): Promise<void> {
    const estados = parseStatuses(body);
    if (estados.length === 0) return;

    for (const e of estados) {
        if (!e.waMessageId) continue;
        // Salientes del canal de plataforma (número de SportMaps): no son de
        // ninguna escuela; su estado va a platform_wa_mensajes.
        if (await esNumeroDePlataforma(e.phoneNumberId)) {
            await guardarEstadoPlataforma(e.waMessageId, e.status, e.timestamp, e.errorDetail);
            continue;
        }

        // Un estado que el CHECK no conoce tumbaría el UPDATE entero y con él
        // el cobro de Meta: se guarda lo demás.
        const parche: Record<string, unknown> = ESTADOS_GUARDABLES.has(e.status)
            ? { status: e.status, status_at: e.timestamp }
            : {};
        // Solo se pisa lo de cobro si el evento lo trae. Meta manda varios
        // estados por mensaje (sent, delivered, read) y no todos incluyen
        // `pricing`: sobrescribir con null borraria el dato del medidor.
        if (e.pricingRaw !== null && e.pricingRaw !== undefined) {
            parche.billable = e.billable;
            parche.pricing_category = e.pricingCategory;
            parche.pricing_raw = e.pricingRaw;
        }
        if (e.errorDetail) parche.error_detail = e.errorDetail;
        if (Object.keys(parche).length === 0) continue;

        const { error } = await supabase
            .from('whatsapp_messages')
            .update(parche)
            .eq('wa_message_id', e.waMessageId);

        if (error) {
            req.log?.warn({ err: error.message, waMessageId: e.waMessageId }, 'WhatsApp: no se pudo guardar el estado');
        }
    }

    const facturables = estados.filter((e) => e.billable === true).length;
    if (facturables > 0) {
        req.log?.info({ estados: estados.length, facturables }, 'WhatsApp: estados procesados');
    }
}

/** Campos del webhook que NO son mensajes y que ahora escuchamos. */
const CAMPOS_DE_CUENTA = new Set([
    'message_template_status_update',
    'message_template_quality_update',
    'template_category_update',
    'phone_number_quality_update',
    'account_update',
    'business_capability_update',
]);

/**
 * Guarda los eventos de cuenta de Meta.
 *
 * Son los avisos que rompen el canal en silencio: una plantilla que Meta
 * desactiva deja de enviar cobranza y el primer sintoma seria que nadie paga;
 * una recategorizacion a MARKETING cambia el costo Y el consentimiento exigido;
 * la calidad en rojo restringe el numero.
 *
 * Se guarda el payload CRUDO ademas de los campos extraidos: son estructuras de
 * Meta que cambian sin aviso, y perder el evento por no haber previsto un campo
 * seria repetir el error de haber descartado los `statuses`.
 */
async function procesarEventosDeCuenta(req: Request, body: any): Promise<void> {
    const entries = Array.isArray(body?.entry) ? body.entry : [];

    for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
            const field: string = change?.field ?? '';
            if (!CAMPOS_DE_CUENTA.has(field)) continue;

            const v = change?.value ?? {};
            const phoneNumberId: string | null = v?.phone_number_id ?? v?.metadata?.phone_number_id ?? null;

            // Se intenta atribuir a una escuela, pero varios de estos eventos son
            // de nivel WABA y no traen numero: se guardan igual, sin escuela.
            let integrationId: string | null = null;
            let schoolId: string | null = null;
            if (phoneNumberId) {
                const integration = await resolveIntegration(phoneNumberId);
                if (integration) {
                    integrationId = integration.id;
                    schoolId = integration.school_id;
                }
            }
            // Los eventos de PLANTILLA son de nivel WABA y no traen numero. Sin
            // este fallback quedaban sin escuela, y la escuela no veria que su
            // propia plantilla de cobranza fue desactivada — que es justo lo que
            // hay que avisarle.
            if (!schoolId && entry?.id) {
                const { data: porWaba } = await supabase
                    .from('school_whatsapp_integrations')
                    .select('id, school_id')
                    .eq('waba_id', String(entry.id))
                    .maybeSingle();
                if (porWaba) {
                    integrationId = porWaba.id as string;
                    schoolId = porWaba.school_id as string;
                }
            }

            // El orden importa: `event` es el TIPO de evento ("FLAGGED"), no el
            // valor nuevo. Ponerlo primero producia "paso de GREEN a FLAGGED",
            // que mezcla dos cosas distintas y no es una transicion de puntaje.
            const nuevoEstado = v?.new_quality_score
                ?? v?.new_category
                ?? v?.max_daily_conversation_per_phone   // business_capability_update
                ?? v?.current_limit
                ?? v?.decision
                ?? v?.event
                ?? null;
            const estadoPrevio = v?.previous_quality_score ?? v?.previous_category
                ?? v?.old_category ?? null;

            const { error } = await supabase.from('whatsapp_account_events').insert({
                integration_id: integrationId,
                school_id: schoolId,
                field,
                waba_id: entry?.id ?? null,
                phone_number_id: phoneNumberId,
                template_name: v?.message_template_name ?? null,
                nuevo_estado: nuevoEstado !== null ? String(nuevoEstado) : null,
                estado_previo: estadoPrevio !== null ? String(estadoPrevio) : null,
                motivo: v?.reason ?? v?.rejected_reason ?? v?.disable_info?.disable_date ?? v?.event ?? null,
                payload: change,
            });

            if (error) {
                req.log?.error({ err: error.message, field }, 'WhatsApp: no se pudo guardar el evento de cuenta');
                continue;
            }

            // A nivel log va como warn: son cosas que alguien tiene que mirar,
            // no ruido informativo.
            req.log?.warn(
                { field, plantilla: v?.message_template_name, de: estadoPrevio, a: nuevoEstado, schoolId },
                'WhatsApp: evento de cuenta de Meta',
            );
        }
    }
}

// ─── Procesamiento de un mensaje entrante ────────────────────────────────────
async function processInboundMessage(req: Request, msg: ParsedInboundMessage): Promise<void> {
    if (!msg.phoneNumberId || !msg.contactWaId || !msg.waMessageId) {
        // Con `{ msg }` pino pisaba el objeto con el texto del aviso y no se veía
        // qué llegaba (~10 al día, 2026-10-29). Solo la forma, sin texto ni teléfono.
        const raw = (msg.raw ?? {}) as Record<string, unknown>;
        req.log?.warn({
            faltan: [!msg.phoneNumberId && 'phone_number_id', !msg.contactWaId && 'from', !msg.waMessageId && 'id'].filter(Boolean),
            tipo: msg.type,
            tipoOriginal: raw.type ?? null,
            claves: Object.keys(raw),
            errores: Array.isArray(raw.errors) ? (raw.errors as any[]).map((e) => e?.code ?? e?.title ?? null) : null,
        }, 'WhatsApp: inbound message missing required fields');
        return;
    }

    // 0. Canal de PLATAFORMA (número comercial de SportMaps, spec
    //    canal-whatsapp-plataforma): no pertenece a ninguna escuela y nunca
    //    pasa por `resolveIntegration` ni por las tablas whatsapp_* de una
    //    escuela. Avisos a dueñas con opt-in y el modo pruebas del desarrollador.
    if (await esNumeroDePlataforma(msg.phoneNumberId)) {
        const resultado = await atenderEntrantePlataforma(msg).catch((err) => {
            req.log?.error({ err: err?.message || err }, 'WhatsApp: canal de plataforma falló');
            return 'error' as const;
        });
        req.log?.info({ resultado }, 'WhatsApp: canal de plataforma');
        return;
    }

    // 1. Routing multi-tenant: phone_number_id -> integración activa.
    const integration = await resolveIntegration(msg.phoneNumberId);
    if (!integration) {
        req.log?.warn({ phoneNumberId: msg.phoneNumberId }, 'WhatsApp: no active integration for phone_number_id');
        return;
    }

    // 2. Kill-switch: número bloqueado (global o por integración) → ignorar.
    const { data: blocked } = await supabase.rpc('wa_is_blocked', {
        p_integration_id: integration.id,
        p_contact_wa_id: msg.contactWaId,
    });
    if (blocked === true) {
        req.log?.info({ contactWaId: msg.contactWaId }, 'WhatsApp: blocked number, ignoring');
        return;
    }

    // 3. Ingesta idempotente (upsert conversación + insert mensaje).
    //
    // Contacto marcado 'personal' (P0-3, auditoría 2026-10-06): solo
    // metadatos. Ni texto ni payload con contenido o media; y más abajo no se
    // encola el adjunto ni se procesa el audio. La conversación nueva nunca es
    // personal (la marca es manual), así que el primer mensaje se guarda normal.
    const personal = await esContactoPersonal(integration.id, msg.contactWaId);
    const { data: ingest, error: ingestErr } = await supabase.rpc('wa_ingest_inbound_message', {
        p_integration_id: integration.id,
        p_school_id: integration.school_id,
        p_contact_wa_id: msg.contactWaId,
        p_contact_name: msg.contactName,
        p_wa_message_id: msg.waMessageId,
        p_type: msg.type,
        p_text_body: personal ? null : msg.textBody,
        p_payload: personal ? payloadSinContenido(msg.raw) : msg.raw,
        p_wa_timestamp: msg.waTimestamp,
    });

    if (ingestErr) {
        req.log?.error({ err: ingestErr, waMessageId: msg.waMessageId }, 'WhatsApp: ingest RPC failed');
        return;
    }

    // Reintento de Meta sobre un mensaje ya procesado → no re-disparar el bot.
    if ((ingest as any)?.duplicate === true) {
        req.log?.info({ waMessageId: msg.waMessageId }, 'WhatsApp: duplicate message, skipping');
        return;
    }

    const conversationId = (ingest as any)?.conversation_id as string;

    // Personal: el asistente nunca le habla (`debeAtender`), y su contenido no
    // se procesa — ni la cola de adjuntos ni la transcripción.
    if (personal) {
        req.log?.info({ conversationId }, 'WhatsApp: contacto personal; solo metadatos');
        return;
    }

    // La ingesta detecta las palabras de baja (STOP, baja, no molestar…) y ya
    // registró el opt-out. El bot tiene que confirmarlo y NO seguir su flujo
    // normal: a quien pide que no le escriban no se le pregunta el email.
    const optedOut = (ingest as any)?.opted_out === true;
    if (optedOut) {
        req.log?.info({ conversationId, contactWaId: msg.contactWaId }, 'WhatsApp: opt-out registrado');
    }

    // 4. NO se marca como leído acá.
    //
    // Antes cada entrante recibía el doble check azul al llegar, aunque nadie
    // lo hubiera leído: con el bot apagado y en los chats personales que entran
    // por Coexistence. Milena (Dynasty, 2026-10-05): «los mensajes quedan en
    // visto» — las familias veían el visto y ninguna respuesta. Ahora el visto
    // lo pone `deliver` cuando el asistente de verdad envía algo, o la propia
    // escuela al abrir el chat en su celular.

    // 5. Disparar el bot. En WA2 esto encola en pg-boss y corre DeepSeek +
    //    intents + identificación OTP. Por ahora dejamos el punto de entrada.
    //    Con escuela y conversación en el contexto: cada llamada a un modelo
    //    (bot, audio, prospecto) queda en llm_usage para el informe de costo.
    await conContextoLlm({ schoolId: integration.school_id, conversationId, feature: 'bot' },
        () => handleBotTurn(req, integration, conversationId, msg, optedOut));
}

/**
 * Punto de entrada del bot (WA2):
 *  - identificación OTP por email si el contacto no está identificado
 *  - Gemini (fallback DeepSeek) con function-calling sobre los intents
 *  - modo asistido (draft para aprobación) vs auto (envía directo)
 *
 * Los adjuntos (imagen, PDF) NO los atiende el bot: se encolan y los procesa el
 * worker (que hace su propio filtro de atención). Las notas de voz se transcriben
 * si la escuela lo prendió (ver `atenderNotaDeVoz`); el video recibe un aviso
 * de que no se procesan; stickers y reacciones se ignoran.
 *
 * Todo lo que no es adjunto pasa antes por `debeAtender`: el asistente solo le
 * contesta a familias, y con el bot apagado no le contesta a nadie. El
 * desconocido con correo, código vigente o tema escolar va por
 * `atenderDesconocido`, que no usa el modelo.
 */
async function handleBotTurn(
    req: Request,
    integration: WhatsAppIntegration,
    conversationId: string,
    msg: ParsedInboundMessage,
    optedOut = false,
): Promise<void> {
    // Un adjunto es, casi siempre, un comprobante. Se encola y el webhook
    // termina: procesarlo acá no es una opción porque el OCR tarda segundos y
    // Meta reintenta si no respondemos rápido.
    //
    // Va ANTES del filtro de tipo textual — si no, cae en el `return` de abajo y
    // el archivo se pierde.
    if (msg.type === 'image' || msg.type === 'document') {
        // El adjunto se encola aunque el contacto esté dado de baja: mandar un
        // comprobante es una gestión sobre su propia plata que él inició, y
        // perderla en silencio es peor que responderle. El worker le agrega la
        // coletilla que le recuerda que tiene las notificaciones apagadas.
        const resultado = await encolarAdjunto(integration, msg, req.log).catch((err) => {
            req.log?.error({ err: err?.message || err, conversationId }, 'WhatsApp: encolarAdjunto explotó');
            return 'error' as const;
        });
        req.log?.info({ conversationId, resultado }, 'WhatsApp: adjunto entrante');

        // El webhook NO acusa el adjunto (2026-10-07). Antes salía «Recibí tu
        // comprobante 📄 Lo reviso…» a los 3 s y el resultado de la cola ~50 s
        // después: dos o más mensajes por comprobante (Dynasty, 6-7 oct). Ahora
        // la cola responde UNA vez con el resultado, y el acuse solo sale si el
        // resultado no llegó en ~90 s (`acusarAdjunto`, diferido, desde el
        // worker que tiene la fila: idempotente entre los 3 BFF por el lease).
        if (resultado === 'mime_rechazado') {
            const d = await debeAtender(integration, conversationId, msg.contactWaId).catch(() => null);
            if (d?.atender) {
                await deliver(integration, conversationId, msg.contactWaId, TEXTO_MIME_RECHAZADO,
                    { step: 'adjunto_formato_no_soportado' })
                    .catch((err) => req.log?.error({ err: err?.message || err, conversationId }, 'WhatsApp: no se pudo avisar el formato'));
            }
        }
        return;
    }

    // Lo que WhatsApp no deja leer (error 131051: encuestas, «ver una vez»,
    // mensajes de una versión vieja). Antes se ignoraba igual que un sticker y
    // 15 conversaciones quedaron sin respuesta ni buzón (auditoría 2026-10-28,
    // X-05). A quien el asistente atiende se le pide escribirlo, UNA vez al día,
    // y la conversación queda abierta en el buzón para que alguien la mire.
    if (msg.type === 'unsupported') {
        const d = await debeAtender(integration, conversationId, msg.contactWaId).catch(() => null);
        if (!d?.atender || optedOut) return;
        await abrirEnBuzon(integration, conversationId, msg.contactWaId)
            .catch((err) => req.log?.error({ err: err?.message || err, conversationId }, 'WhatsApp: no se pudo abrir en el buzón'));
        if (!(await reservarPasoUnaVez(conversationId, `${PASO_TIPO_NO_SOPORTADO}_unsupported`, 24))) return;
        await deliver(integration, conversationId, msg.contactWaId,
            'No pude abrir tu último mensaje: WhatsApp no me deja verlo. 🙏 ¿Me lo escribes, por favor? ' +
            'Si era un comprobante, mándame la *foto* o el *PDF*.',
            { step: `${PASO_TIPO_NO_SOPORTADO}_unsupported` })
            .catch((err) => req.log?.error({ err: err?.message || err, conversationId }, 'WhatsApp: no se pudo responder al mensaje ilegible'));
        return;
    }

    // Los stickers, las reacciones y demás tipos no conversacionales se ignoran
    // como siempre (ya quedaron guardados por la ingesta).
    const esConversacional = msg.type === 'text' || msg.type === 'interactive'
        || msg.type === 'button' || msg.type === 'audio' || msg.type === 'video';
    if (!esConversacional) {
        req.log?.info({ conversationId, type: msg.type }, 'WhatsApp: tipo no textual, bot no responde');
        return;
    }

    // Asistencia del EQUIPO por WhatsApp (spec conversación v2 §3.8): «lista»,
    // la respuesta a la lista numerada o un botón `asis_*` de un coach/dueña.
    // Va ANTES de `debeAtender` y NO depende del asistente: no es una respuesta
    // del bot a una familia, así que corre aunque `ai_enabled=false` (el coach
    // acaba de escribir: la ventana de 24 h está abierta). Con la baja pedida
    // (optedOut) no se sigue. Si no es de asistencia, el flujo normal sigue igual.
    if (!optedOut && await atenderAsistenciaDeStaff(req, integration, conversationId, msg)) return;

    // Respuesta a una campaña de marketing de la escuela (plan B5 T4): los
    // botones de su plantilla (`smc:<campaña>:si|luego|baja`) o un «no me
    // interesa» corto justo después de ella. El filtro es gratis (prefijo o
    // frase) y no depende del asistente: la campaña la aprobó la escuela. Sin
    // campaña detrás, el mensaje sigue el camino de siempre. Un STOP que la
    // ingesta ya registró (optedOut) lo confirma el bot como siempre.
    if (esPosibleRespuestaDeCampana(msg) && !(optedOut && !msg.botonId)) {
        const r = await atenderRespuestaDeCampana({ integration, conversationId, msg })
            .catch(() => 'no_aplica' as const);
        if (r !== 'no_aplica') {
            req.log?.info({ conversationId, campana: r }, 'WhatsApp: respuesta a una campaña');
            return;
        }
    }

    // ¿A este contacto el asistente le contesta? Se pregunta ANTES de cualquier
    // respuesta, del modelo y de cualquier borrador.
    //
    // Medido en Dynasty el 2026-10-03, primer día por Coexistence: el número de
    // la escuela es también el WhatsApp personal de la dueña, y de 55
    // conversaciones solo 30 eran familias (21 desconocidos, 4 del equipo). Con
    // el bot APAGADO igual se corrió el modelo en cada mensaje y quedaron 316
    // borradores, 238 de ellos «escríbeme tu correo» a contactos personales. El
    // asistente atiende familias; con el resto se calla, y la dueña los sigue
    // viendo y contestando en su celular.
    //
    // Se llama aunque el bot esté apagado: `debeAtender` clasifica el contacto y
    // lo guarda en la conversación, y eso es lo que deja al buzón separar las
    // familias del resto. Lo que no se hace con el bot apagado es responder.
    //
    // Si la clasificación revienta, silencio: equivocarse callando le cuesta a
    // la escuela una respuesta tardía; equivocarse hablando le escribe a la vida
    // privada de la dueña.
    const decision = await debeAtender(integration, conversationId, msg.contactWaId).catch((err) => {
        req.log?.error({ err: err?.message || err, conversationId }, 'WhatsApp: debeAtender falló; el bot se calla');
        return null;
    });
    // «Gracias», «Ok», 👍 de una familia DESPUÉS de una respuesta: la
    // conversación queda atendida (como «Dar por atendida» del buzón) y no
    // ensucia «Por responder». El bot tampoco lo contesta (P13). Si vuelve a
    // escribir, la ingesta la reabre.
    if (msg.type === 'text' && decision && ['familia', 'familia_sin_cuenta', 'ambiguo'].includes(decision.tipo)
        && esCierreSuelto(msg.textBody, await vocativosDeEscuela(integration.school_id).catch(() => new Map()))) {
        const cerrada = await cerrarSiEsCierre(conversationId, msg.waMessageId, msg.textBody,
            await vocativosDeEscuela(integration.school_id).catch(() => new Map()));
        if (cerrada) req.log?.info({ conversationId }, 'WhatsApp: cierre suelto; conversación atendida');
    }
    if (!decision?.atender) {
        // El desconocido tiene una puerta angosta (opción «1C»): correo, código
        // con OTP vigente, o tema escolar una vez cada 30 días. Sin modelo.
        //
        // Con «solo familias» se perdían la familia que escribe desde otro
        // celular y el prospecto: en Dynasty, el 2026-10-02, «Quiero inscribir a
        // mi hija a volleyball» desde un número que no estaba en ninguna ficha.
        //
        // Staff y personal NO pasan por acá, digan lo que digan («mensualidad»
        // incluida): es el equipo o la vida privada de la dueña. Tampoco el que
        // pidió la baja, ni un audio o video (no hay texto que leer).
        // Tomada desde el buzón (mejora 9): tampoco la puerta del desconocido.
        const puertaDelDesconocido = decision?.botEncendido === true
            && decision.tomada !== true
            && decision.tipo === 'desconocido'
            && !optedOut
            && msg.type !== 'audio' && msg.type !== 'video';
        // Nota de voz de un PROSPECTO (ya escribió con intención clara) con el
        // ajuste `wa_transcribir_sin_consentimiento`: se transcribe y pasa por
        // la misma puerta. Cualquier otro desconocido: su audio no se toca.
        if (decision?.botEncendido === true && decision.tomada !== true && decision.tipo === 'desconocido'
            && !optedOut && msg.type === 'audio') {
            const resultado = await atenderNotaDeVozDeProspecto({
                integration, conversationId, msg,
                turno: async (texto) => {
                    await atenderDesconocido(integration, conversationId, msg.contactWaId, texto, null, null, 'audio');
                },
            }).catch((err) => {
                req.log?.error({ err: err?.message || err, conversationId }, 'WhatsApp: audio de prospecto falló');
                return 'error' as const;
            });
            req.log?.info({ conversationId, resultado }, 'WhatsApp: audio de desconocido');
            return;
        }
        if (puertaDelDesconocido) {
            // `botonId`: los botones de la clase de cortesía (sm_cc_*) se deciden por id.
            const resultado = await atenderDesconocido(integration, conversationId, msg.contactWaId, msg.textBody,
                msg.botonId ?? null)
                .catch((err) => {
                    req.log?.error({ err: err?.message || err, conversationId }, 'WhatsApp: atenderDesconocido falló');
                    return 'error' as const;
                });
            req.log?.info({ conversationId, resultado }, 'WhatsApp: desconocido');
            return;
        }
        req.log?.info(
            { conversationId, tipo: decision?.tipo ?? null, botEncendido: decision?.botEncendido ?? null, optedOut },
            'WhatsApp: el asistente no atiende este contacto',
        );
        return;
    }

    // Notas de voz (spec whatsapp-notas-de-voz, F1). Con el flag de la escuela
    // y una familia con consentimiento se transcriben y pasan al turno normal
    // (ráfaga incluida); si no, el aviso de siempre («No puedo escuchar…»),
    // respetando P4 y P9. Desconocidos, staff y personal nunca llegan acá
    // transcritos: `atenderNotaDeVoz` vuelve a exigir tipo de familia.
    if (msg.type === 'audio') {
        const resultado = await atenderNotaDeVoz({
            integration, conversationId, msg, tipo: decision.tipo,
            turno: (texto) => lanzarTurno(req, integration, conversationId, msg, texto, optedOut, 'audio'),
        }).catch((err) => {
            req.log?.error({ err: err?.message || err, conversationId }, 'WhatsApp: atenderNotaDeVoz falló');
            return 'error' as const;
        });
        req.log?.info({ conversationId, resultado }, 'WhatsApp: nota de voz');
        return;
    }

    // Video NO se puede procesar. Dynasty 2026-10-07: 13 videos seguidos del
    // entrenamiento → 13 «No puedo ver videos…». Un video de una familia casi
    // nunca es un comprobante: se contesta SOLO si el texto cercano (o el pie)
    // habla de pago, y como mucho UNA vez cada 24 h por conversación; la ráfaga
    // la frena la reserva en memoria (los webhooks llegan a un solo BFF).
    //
    // Los stickers y las reacciones sí se ignoran: son ruido social, no una
    // pregunta, y responderles sería molesto.
    if (msg.type === 'video') {
        const recientes = await mensajesRecientes(conversationId);
        // P4: si la escuela está escribiendo en el chat, el video es para ella.
        if (humanoReciente(recientes, SILENCIO_HUMANO_MIN)) {
            req.log?.info({ conversationId }, 'WhatsApp: video con la escuela atendiendo; el bot se calla');
            return;
        }
        if (!respuestaATipoNoSoportado(msg.textBody, recientes)
            || !(await reservarPasoUnaVez(conversationId, `${PASO_TIPO_NO_SOPORTADO}_${msg.type}`, 24))) {
            req.log?.info({ conversationId }, 'WhatsApp: video sin texto de pago (o ya respondido); el bot se calla');
            return;
        }
        const texto = 'No puedo ver videos. Si es un comprobante de pago, mándame la *foto* o el *PDF* ' +
            'que te da el banco y lo valido enseguida.';
        await deliver(integration, conversationId, msg.contactWaId, texto, { step: `${PASO_TIPO_NO_SOPORTADO}_${msg.type}` })
            .catch((err) => req.log?.error({ err: err?.message || err, conversationId }, 'WhatsApp: no se pudo responder al tipo no soportado'));
        return;
    }

    // La confirmación de baja (optedOut) entra por acá, ya pasada por el filtro
    // de arriba: con el bot apagado o ante un contacto que no se atiende no se
    // confirma nada —la ingesta ya registró el STOP, que es lo que importa—; con
    // una familia y el bot prendido, `runBotTurn` la confirma como siempre.
    //
    // Un audio o un video que llegue marcado como baja no puede pasar: la
    // ingesta solo detecta las palabras de baja en texto.
    // `botonId`: si tocó un botón, el id viaja aparte del título. El bot decide
    // con el id, sin modelo (ver `accionDeBoton`).
    //
    // P5 (análisis 2026-10-06): un turno por RÁFAGA y nunca dos a la vez en la
    // misma conversación (`correrTurnoAgrupado`). Un botón o un STOP no esperan
    // la ráfaga: son una elección explícita.
    await lanzarTurno(req, integration, conversationId, msg, msg.textBody, optedOut, 'texto');
}

// ─── Asistencia del equipo (staff) ───────────────────────────────────────────

const TTL_STAFF_MS = 5 * 60_000;
const cacheStaff = new Map<string, { staff: StaffIdentificado; hasta: number }>();

/** Vacía el cache de identificación de staff (pruebas). */
export function limpiarCacheStaff(): void { cacheStaff.clear(); }

/** Identifica al staff por teléfono con cache corto (5 min): una consulta por contacto, no por mensaje. */
async function staffDe(integrationId: string, waId: string): Promise<StaffIdentificado> {
    const k = `${integrationId}:${waId}`;
    const c = cacheStaff.get(k);
    if (c && c.hasta > Date.now()) return c.staff;
    const staff = await identificarStaffPorTelefono(integrationId, waId);
    if (cacheStaff.size > 2000) cacheStaff.clear();
    cacheStaff.set(k, { staff, hasta: Date.now() + TTL_STAFF_MS });
    return staff;
}

/**
 * ¿El mensaje PUEDE ser de asistencia? Filtro gratis para no preguntarle a la
 * base «¿es staff?» por cada mensaje de cada familia: un botón `asis_*`, la
 * palabra «lista» y afines, o un texto corto con la forma de la respuesta a la
 * lista («faltaron 3 y 7», «todos», «solo 1,2»). El servicio vuelve a decidir
 * (y exige además una lista abierta ≤ 6 h para esa última).
 */
export function esCandidatoDeAsistencia(msg: Pick<ParsedInboundMessage, 'type' | 'textBody' | 'botonId'>): boolean {
    if (typeof msg.botonId === 'string' && msg.botonId.startsWith('asis_')) return true;
    if (msg.type !== 'text') return false;
    const t = (msg.textBody ?? '').trim();
    if (!t) return false;
    if (esDisparadorDeLista(t)) return true;
    return t.length <= 60 && /\d|todos|todas|ninguno|ninguna|nadie|falt|vini|solo/i.test(t);
}

/** true = el mensaje era de asistencia y ya se respondió (el bot no sigue). */
async function atenderAsistenciaDeStaff(
    req: Request,
    integration: WhatsAppIntegration,
    conversationId: string,
    msg: ParsedInboundMessage,
): Promise<boolean> {
    if (!esCandidatoDeAsistencia(msg)) return false;
    try {
        const staff = await staffDe(integration.id, msg.contactWaId);
        if (staff.resultado !== 'staff') return false;
        const r = await procesarMensajeStaff({
            integration, waId: msg.contactWaId, texto: msg.textBody, botonId: msg.botonId ?? null, staff,
        });
        if (!r) return false;
        await enviarRespuestaStaff(integration, conversationId, msg.contactWaId,
            { texto: r.texto, botones: r.botones },
            { step: 'asistencia_staff', estado: r.estado, intake_id: r.intakeId ?? null });
        req.log?.info({ conversationId, estado: r.estado }, 'WhatsApp: asistencia del equipo');
        return true;
    } catch (err: any) {
        req.log?.error({ err: err?.message || err, conversationId }, 'WhatsApp: asistencia del equipo falló; sigue el flujo normal');
        return false;
    }
}

/**
 * El turno del bot para un mensaje: agrupado por ráfaga y con candado por
 * conversación. `texto` es el del mensaje, o la transcripción de una nota de voz
 * (`origen: 'audio'`).
 */
function lanzarTurno(
    req: Request,
    integration: WhatsAppIntegration,
    conversationId: string,
    msg: ParsedInboundMessage,
    texto: string | null,
    optedOut: boolean,
    origen: 'texto' | 'audio',
): Promise<void> {
    return enSegundoPlano(ESPERA_RAFAGA_MS, async () => {
        // Anotado en la base mientras corre: si el proceso muere a mitad
        // (despliegue, reinicio), el barrido lo relanza (whatsapp-turnos-pendientes).
        await anotarTurno({
            waMessageId: msg.waMessageId, conversationId, integrationId: integration.id,
            contactWaId: msg.contactWaId, texto, optedOut, botonId: msg.botonId ?? null, origen,
        });
        try {
            const r = await correrTurnoAgrupado({
                conversationId,
                waMessageId: msg.waMessageId,
                inmediato: optedOut || Boolean(msg.botonId),
                log: req.log as any,
                correr: () => runBotTurn(integration, conversationId, msg.contactWaId, texto, msg.waMessageId,
                    optedOut, msg.botonId ?? null, { origen }),
            });
            if (r !== 'corrido') req.log?.info({ conversationId, turno: r }, 'WhatsApp: turno agrupado');
        } finally {
            await soltarTurno(msg.waMessageId);
        }
    }, req.log, 'runBotTurn');
}

// Exportada solo para la prueba del filtro de atención
// (services/whatsapp-atencion-bot.test.ts): levantar el router entero exige
// firmar el HMAC del webhook, y lo que se prueba es la decisión, no la firma.
export { handleBotTurn };

export default router;
