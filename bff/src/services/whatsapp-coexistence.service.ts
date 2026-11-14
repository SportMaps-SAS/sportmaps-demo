/**
 * Coexistence: el número vive a la vez en el celular de la escuela y en la API.
 *
 * Tres webhooks alimentan esto, y los tres llegan solo si están suscritos:
 *
 *  - `smb_message_echoes` — lo que la escuela escribe DESDE su celular. Sin
 *    esto el buzón mostraría conversaciones a medias: se vería la pregunta de
 *    la familia y la respuesta del bot, pero no lo que contestó la dueña desde
 *    su teléfono. Peor: el bot creería que nadie respondió.
 *  - `history` — hasta 6 meses de conversaciones anteriores, en trozos.
 *  - `smb_app_state_sync` — los contactos. Ver el comentario al final.
 *
 * Formas verificadas contra la documentación de Meta el 2026-09-14:
 *   entry[].changes[].value.message_echoes[]
 *   entry[].changes[].value.history[].threads[].messages[]
 * y el 2026-10-30 (rechazo de la escuela):
 *   entry[].changes[].value.history[].errors[]   (code 2593109)
 *
 * El historial NO llega solo: hay que pedirlo al terminar el alta
 * (`pedirHistorialDeCoexistencia`, whatsapp-onboarding.service).
 */

import type { Logger } from 'pino';
import { supabase } from '../config/supabase';
import { esContactoSinContenido, leerConMarca } from './whatsapp-tipo-contacto';
import { resolveIntegration, type WhatsAppIntegration } from './whatsapp.service';
import {
    ECHO_AUTOMATICO_MIN_LARGO, ECHO_AUTOMATICO_VENTANA_MS,
    echosAutomaticos, esSalienteAutomatico, esTextoAutomatico, normalizarTextoEcho,
} from './whatsapp-buzon';
import { aLetrasNormales } from './whatsapp-letras-decorativas';
import { aliasDeBsuid } from './whatsapp-usuario-meta';
import { correosDeSoporte, enviarConReserva, horaColombia } from './avisos-correo.service';

/**
 * `whatsapp_account_events.field` propios del historial (no los manda Meta):
 *  - 'history_sync_request': el pedido a `smb_app_data` al terminar el alta
 *    (nuevo_estado pedido|fallido; payload.sync_type, request_id, plazo_hasta).
 *  - 'history_sync': lo que contestó el webhook `history`
 *    (nuevo_estado completo|rechazado|error).
 *
 * «¿Ya sincronizó?»:
 *   select field, nuevo_estado, motivo, created_at from whatsapp_account_events
 *    where integration_id = '…' and field in ('history_sync_request','history_sync')
 *    order by created_at;
 */
export const CAMPO_PEDIDO_HISTORIAL = 'history_sync_request';
export const CAMPO_HISTORIAL = 'history_sync';

/** Meta: «History sync is turned off by the business from the WhatsApp Business App». */
export const ERROR_HISTORIAL_RECHAZADO = 2593109;

/** Texto legible de un mensaje, sea del tipo que sea. */
function textoDe(m: any): string | null {
    if (m?.text?.body) return String(m.text.body);
    if (m?.caption) return String(m.caption);
    for (const t of ['image', 'video', 'document', 'audio', 'sticker']) {
        if (m?.[t]?.caption) return String(m[t].caption);
    }
    return null;
}

// ─── Privacidad: contactos marcados 'personal' ───────────────────────────────
//
// Auditoría 2026-10-06 (P0-3): el bot ya no les habla, pero el texto completo
// de las conversaciones personales de la dueña (entrantes y ecos, con
// adjuntos) quedaba guardado en whatsapp_messages. De un contacto 'personal'
// ahora se guardan SOLO metadatos: dirección, tipo y hora. `text_body` va null
// y el payload pierde texto, caption y media. Lo ya guardado NO se borra acá
// (lo decide el usuario: docs/migraciones-para-aplicar-2026-10-07/).

/**
 * El payload de Meta sin contenido: id, tipo, hora y los números (que ya están
 * en la conversación). Pura.
 */
export function payloadSinContenido(m: any): Record<string, unknown> {
    const out: Record<string, unknown> = { privacidad: 'personal_sin_contenido' };
    for (const k of ['id', 'type', 'timestamp', 'from', 'to']) {
        if (m?.[k] !== undefined && m?.[k] !== null) out[k] = m[k];
    }
    return out;
}

/**
 * ¿De este contacto se guardan solo metadatos? Marcado a mano como no-familia
 * (personal, negocio, otro club, plataforma) y SIN «también es familia»: con la
 * bandera sí se guarda, porque sus comprobantes se aplican a los cobros de sus
 * hijos. Ante un error, no. Nunca lanza.
 */
export async function esContactoPersonal(integrationId: string, contactWaId: string): Promise<boolean> {
    const { data, error } = await leerConMarca((cols) => supabase
        .from('whatsapp_conversations')
        .select(cols)
        .eq('integration_id', integrationId)
        .eq('contact_wa_id', contactWaId)
        .maybeSingle(), 'id');
    if (error) return false;
    return esContactoSinContenido((data as any)?.contact_kind, (data as any)?.tambien_familia);
}

/** La conversación de ese contacto (creándola si no existía) y si está marcada 'personal'. */
async function conversacionConTipo(
    integration: WhatsAppIntegration,
    contactWaId: string,
): Promise<{ id: string; personal: boolean } | null> {
    const { data: existente } = await leerConMarca((cols) => supabase
        .from('whatsapp_conversations')
        .select(cols)
        .eq('integration_id', integration.id)
        .eq('contact_wa_id', contactWaId)
        .maybeSingle(), 'id');
    if (existente) {
        return { id: (existente as any).id,
                 personal: esContactoSinContenido((existente as any).contact_kind, (existente as any).tambien_familia) };
    }

    // `uq_wa_conversation` cubre (integration_id, contact_wa_id): si dos trozos
    // del historial llegan a la vez, el segundo choca en vez de duplicar.
    //
    // status 'closed', no 'active': el CHECK de la tabla solo admite
    // open|snoozed|closed (verificado en la base el 2026-10-03). Con 'active'
    // el upsert fallaba y el echo o el trozo de historial de un contacto NUEVO
    // se perdía en silencio. 'closed' porque lo que crea esta función no espera
    // respuesta: o lo escribió la escuela (echo) o es historia. Si la familia
    // escribe, wa_ingest_inbound_message la reabre a 'open'.
    const { data: creada, error } = await supabase
        .from('whatsapp_conversations')
        .upsert({
            integration_id: integration.id,
            school_id: integration.school_id,
            contact_wa_id: contactWaId,
            status: 'closed',
        }, { onConflict: 'integration_id,contact_wa_id' })
        .select('id')
        .maybeSingle();
    if (error) console.warn('[wa-coexistence] no se pudo crear la conversación', { err: error.message });
    const id = (creada as any)?.id ?? null;
    // Recién creada: nadie la marcó todavía como personal.
    return id ? { id, personal: false } : null;
}

/**
 * Guarda un mensaje sin duplicarlo.
 *
 * Se apoya en el índice único `uq_wa_message_wamid`: Meta reenvía trozos del
 * historial y repite echos, así que la idempotencia no es un lujo.
 */
async function guardarMensaje(params: {
    conversationId: string;
    integrationId: string;
    waMessageId: string;
    direction: 'inbound' | 'outbound';
    type: string;
    textBody: string | null;
    payload: any;
    waTimestamp: string | null;
    status?: string | null;
}): Promise<void> {
    await supabase.from('whatsapp_messages').upsert({
        conversation_id: params.conversationId,
        integration_id: params.integrationId,
        wa_message_id: params.waMessageId,
        direction: params.direction,
        type: params.type,
        text_body: params.textBody,
        payload: params.payload,
        wa_timestamp: params.waTimestamp,
        status: params.status ?? null,
        // Lo escribió una persona desde el celular, no el modelo. Que el hilo
        // lo distinga es lo que permite saber qué prometió quién.
        ai_generated: false,
    }, { onConflict: 'wa_message_id', ignoreDuplicates: true });
}

const tsDe = (t: any): string | null =>
    t ? new Date(Number(t) * 1000).toISOString() : null;

type EchoGuardado = {
    id: string; wa_message_id: string | null; conversation_id: string;
    text_body: string | null; payload: any;
};

/**
 * ¿Este echo lo mandó sola la app WhatsApp Business (saludo, ausencia)?
 *
 * La regla vive en whatsapp-buzon.ts (`esTextoAutomatico`); acá se buscan los
 * echos de la misma integración en los 7 días anteriores con el mismo texto
 * normalizado. Devuelve también los echos IGUALES que todavía no tienen la
 * marca: el 1.º y el 2.º saludo se guardaron como humanos porque aún no se
 * llegaba al umbral, y hay que corregirlos cuando llega el 3.º.
 *
 * Si la consulta falla se responde "humano": es el comportamiento de antes y
 * no marca de golpe todo como automático por un error de red.
 */
export async function esEchoAutomatico(params: {
    integrationId: string;
    conversationId: string;
    waMessageId: string;
    texto: string | null;
    waTimestamp: string | null;
}, log?: Logger): Promise<{ automatico: boolean; previosSinMarca: EchoGuardado[] }> {
    const normalizado = normalizarTextoEcho(params.texto);
    if (normalizado.length < ECHO_AUTOMATICO_MIN_LARGO) return { automatico: false, previosSinMarca: [] };

    const hasta = params.waTimestamp ? new Date(params.waTimestamp).getTime() : Date.now();
    // Echo = saliente con ai_generated=false y `to` en el payload. Los del bot
    // no traen `to` (64 filas el 2026-10-03, ninguna con él).
    const { data, error } = await supabase
        .from('whatsapp_messages')
        .select('id, wa_message_id, conversation_id, text_body, payload')
        .eq('integration_id', params.integrationId)
        .eq('direction', 'outbound')
        .eq('ai_generated', false)
        .not('payload->to', 'is', null)
        .not('text_body', 'is', null)
        .gte('wa_timestamp', new Date(hasta - ECHO_AUTOMATICO_VENTANA_MS).toISOString())
        .lte('wa_timestamp', new Date(hasta).toISOString())
        .limit(5000);
    if (error) {
        log?.warn({ err: error.message }, 'WhatsApp: no se pudo evaluar si el echo es automático');
        return { automatico: false, previosSinMarca: [] };
    }

    // Meta repite echos: el mismo wa_message_id no es otro contacto.
    const iguales = ((data ?? []) as EchoGuardado[]).filter((r) =>
        r.wa_message_id !== params.waMessageId && normalizarTextoEcho(r.text_body) === normalizado);
    const contactos = new Set([params.conversationId, ...iguales.map((r) => r.conversation_id)]);
    const automatico = esTextoAutomatico(normalizado, contactos.size);
    return { automatico, previosSinMarca: automatico ? iguales.filter((r) => !esSalienteAutomatico(r)) : [] };
}

/** Agrega `automatico: true` al payload de echos ya guardados. */
export async function marcarEchosAutomaticos(echos: { id: string; payload: any }[]): Promise<number> {
    let marcados = 0;
    for (const e of echos) {
        const { error } = await supabase.from('whatsapp_messages')
            .update({ payload: { ...(e.payload ?? {}), automatico: true } })
            .eq('id', e.id);
        if (!error) marcados++;
    }
    return marcados;
}

/**
 * Regla de `reabrirSiSoloRespondioLaApp` sobre los mensajes del hilo: lo
 * ÚLTIMO es un saliente automático y hay un entrante posterior a la última
 * respuesta de una persona (o ninguna persona respondió nunca).
 *
 * Una conversación cerrada a mano tras un "ok, gracias" no se reabre: ahí lo
 * último es el entrante, no el automático.
 */
export function necesitaReabrir(
    msgs: { direction: string; wa_timestamp?: string | null; created_at?: string | null; payload?: any }[],
): boolean {
    const t = (m: { wa_timestamp?: string | null; created_at?: string | null }) =>
        new Date(m.wa_timestamp ?? m.created_at ?? 0).getTime();
    const orden = [...msgs].sort((a, b) => t(b) - t(a));
    const ultimo = orden[0];
    if (!ultimo || ultimo.direction !== 'outbound' || !esSalienteAutomatico(ultimo)) return false;
    const entrante = orden.find((m) => m.direction === 'inbound');
    if (!entrante) return false;
    const humano = orden.find((m) => m.direction === 'outbound' && !esSalienteAutomatico(m));
    return !humano || t(entrante) > t(humano);
}

/**
 * Reabre las conversaciones 'closed' que cerró un echo automático tomado por
 * humano (los dos primeros saludos, antes de llegar al umbral). Devuelve las
 * que reabrió.
 */
export async function reabrirSiSoloRespondioLaApp(conversationIds: string[]): Promise<string[]> {
    const reabiertas: string[] = [];
    for (const id of [...new Set(conversationIds)]) {
        const { data: conv } = await supabase.from('whatsapp_conversations')
            .select('id, status').eq('id', id).maybeSingle();
        if ((conv as any)?.status !== 'closed') continue;

        // wa_timestamp está en las 682 filas (2026-10-03), bot incluido.
        const { data: msgs } = await supabase.from('whatsapp_messages')
            .select('direction, wa_timestamp, created_at, payload')
            .eq('conversation_id', id)
            .order('wa_timestamp', { ascending: false, nullsFirst: false })
            .limit(50);
        if (!necesitaReabrir((msgs ?? []) as any[])) continue;

        const { error } = await supabase.from('whatsapp_conversations')
            .update({ status: 'open', updated_at: new Date().toISOString() })
            .eq('id', id).eq('status', 'closed');
        if (!error) reabiertas.push(id);
    }
    return reabiertas;
}

/**
 * `smb_message_echoes`: la escuela escribió desde su celular.
 */
export async function procesarEchos(body: any, log?: Logger): Promise<void> {
    for (const entry of body?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
            if (change?.field !== 'smb_message_echoes') continue;
            const v = change.value ?? {};
            const echos = Array.isArray(v.message_echoes) ? v.message_echoes : [];
            if (!echos.length) continue;

            const integration = await resolveIntegration(v?.metadata?.phone_number_id);
            if (!integration) continue;

            for (const e of echos) {
                // `to` es la familia; `from` es el número de la escuela. A quien usa nombre
                // de usuario Meta lo manda en `to_user_id` (sin `to`): va con su alias, que es
                // la llave de su conversación (ver whatsapp-usuario-meta).
                const contacto = String(e?.to ?? '') || aliasDeBsuid(e?.to_user_id) || '';
                if (!contacto || !e?.id) continue;

                const conv = await conversacionConTipo(integration, contacto);
                if (!conv) continue;
                const convId = conv.id;

                // Contacto personal: solo metadatos (ver arriba). Sin texto no
                // hay saludo automático que detectar.
                const texto = conv.personal ? null : textoDe(e);
                const waTimestamp = tsDe(e?.timestamp);
                // Saludo / ausencia de la app del negocio: se guarda igual (es
                // parte del hilo) pero marcado, y NO cierra la conversación.
                const { automatico, previosSinMarca } = conv.personal
                    ? { automatico: false, previosSinMarca: [] as EchoGuardado[] }
                    : await esEchoAutomatico({
                        integrationId: integration.id, conversationId: convId,
                        waMessageId: String(e.id), texto, waTimestamp,
                    }, log);

                await guardarMensaje({
                    conversationId: convId,
                    integrationId: integration.id,
                    waMessageId: String(e.id),
                    direction: 'outbound',
                    type: String(e?.type ?? 'text'),
                    textBody: texto,
                    // `to` se conserva: es lo que distingue un eco de un saliente del bot.
                    payload: conv.personal ? payloadSinContenido(e) : (automatico ? { ...e, automatico: true } : e),
                    waTimestamp,
                    status: 'sent',
                });

                if (automatico) {
                    // El 3.er contacto destapa que el texto era plantilla: los
                    // anteriores se guardaron como humanos y cerraron su hilo.
                    if (previosSinMarca.length) {
                        await marcarEchosAutomaticos(previosSinMarca);
                        const reabiertas = await reabrirSiSoloRespondioLaApp(
                            previosSinMarca.map((p) => p.conversation_id));
                        log?.info({ integrationId: integration.id, marcados: previosSinMarca.length,
                                    reabiertas: reabiertas.length },
                                  'WhatsApp: echos anteriores marcados como automáticos');
                    }
                    continue;
                }

                // Una persona ya respondió desde el celular: la conversación
                // queda atendida. Sin esto, el buzón seguiría marcándola como
                // pendiente aunque la dueña la haya atendido, y le llegarían
                // avisos por algo que ya resolvió.
                //
                // Antes se escribía status='active', que el CHECK de la tabla no
                // admite (open|snoozed|closed): el UPDATE fallaba en silencio y
                // por eso el 2026-10-03 las 55 conversaciones de Dynasty
                // seguían 'open' con 193 echos guardados. Ahora 'closed'; si la
                // familia vuelve a escribir, wa_ingest_inbound_message la reabre.
                const { error: errCierre } = await supabase.from('whatsapp_conversations')
                    .update({ status: 'closed', unread_count: 0, updated_at: new Date().toISOString() })
                    .eq('id', convId)
                    .eq('status', 'open');
                if (errCierre) {
                    log?.warn({ convId, err: errCierre.message }, 'WhatsApp: no se pudo cerrar tras el echo');
                }
            }

            log?.info({ integrationId: integration.id, echos: echos.length },
                      'WhatsApp: echos de la app del negocio');
        }
    }
}

// ─── Historial ──────────────────────────────────────────────────────────────
//
// Lo importado es PASADO y tiene que quedar como pasado. `created_at` es lo que
// leen las ventanas del bot (`entrantesDeTexto` 7 d, `escuelaLeEscribioEnDias`
// 30 d, `escuelaActiva` 12 h, la retoma, el aviso de pendientes de 72 h); con
// la fecha de importación, cientos de conversaciones de hace meses parecerían
// «la escuela escribió hoy», y las consultas globales con `limit` (pendientes,
// retoma) se llenarían de historia y dejarían afuera lo vivo de las demás
// escuelas. Por eso `created_at = wa_timestamp`. Además:
//  - el payload lleva `historial: true` (y el `history_context` crudo de Meta),
//    para distinguirlo sin adivinar;
//  - las conversaciones que crea nacen 'closed', con `unread_count` 0, y nada de
//    lo importado cambia `status` ni `unread_count`: no entran al buzón abierto,
//    al resumen diario ni a «sin responder» (todos excluyen 'closed');
//  - no pasa por la cola ni por el turno del bot: nada se contesta.
//
// `last_inbound_at` / `last_message_at` SÍ se llenan (2026-11-04, audiencia de
// campañas de Monster en 0: la audiencia y su lectura incremental van por
// `last_inbound_at`, y 2774 de 2778 conversaciones lo tenían NULL), con dos
// reglas (`actividadDeHistorial`):
//  - GREATEST: nunca baja un valor más nuevo que ya exista (lo vivo manda);
//  - `last_inbound_at` topado en (momento de importar − 24 h): Meta no abre la
//    ventana de 24 h de la API con lo importado (solo un mensaje NUEVO después
//    del alta la abre). Sin el tope, lo que la familia escribió en el celular
//    una hora antes del alta se leería como «ventana abierta» en
//    `ventanaAbierta`, `estadoDeVentana`, `wa_window_is_open` y el buzón, y el
//    texto libre rebotaría con 131047. Con el tope, ningún lector la ve abierta.

/**
 * Meta no abre la ventana de 24 h con el historial importado: el
 * `last_inbound_at` que viene de él se topa en (momento de importar − esto).
 */
export const VENTANA_META_MS = 24 * 3600_000;

/** Los tipos que admite el CHECK `whatsapp_messages_type_check` (verificado en la base el 2026-10-30). */
const TIPOS_GUARDABLES = new Set([
    'text', 'image', 'audio', 'video', 'document', 'sticker', 'location',
    'interactive', 'button', 'template', 'system', 'unsupported',
]);

/** Filas por upsert: un trozo de historial puede traer miles de mensajes. */
const LOTE_MENSAJES = 500;
/** Contactos por consulta `.in(...)` (largo de la URL de PostgREST). */
const LOTE_CONTACTOS = 150;

const soloDigitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/**
 * `history_context.status` de Meta (delivered|error|pending|played|read|sent)
 * al CHECK `whatsapp_messages_status_check` (received|queued|sent|delivered|
 * read|failed). Pura. Antes iba crudo o null: 'played', 'pending' y 'error'
 * violaban el CHECK, null el NOT NULL, y la fila se perdía en silencio. Los
 * entrantes van 'received', como los del webhook en vivo; el estado original
 * queda en `payload.history_context`.
 */
export function estadoDeHistorial(direccion: 'inbound' | 'outbound', estado: unknown): string {
    if (direccion === 'inbound') return 'received';
    switch (String(estado ?? '').toLowerCase()) {
        case 'delivered': return 'delivered';
        case 'read':
        case 'played': return 'read';
        case 'pending': return 'queued';
        case 'error': return 'failed';
        default: return 'sent';
    }
}

/** Epoch en segundos de Meta → ISO, o null si no es una fecha. Pura (no lanza con basura). */
export function fechaDeHistorial(t: unknown): string | null {
    const n = Number(t);
    if (t === null || t === undefined || t === '' || !Number.isFinite(n) || n <= 0) return null;
    return new Date(n * 1000).toISOString();
}

export interface FilaDeHistorial {
    conversation_id: string;
    integration_id: string;
    wa_message_id: string;
    direction: 'inbound' | 'outbound';
    type: string;
    text_body: string | null;
    payload: Record<string, unknown>;
    wa_timestamp: string;
    created_at: string;
    status: string;
    ai_generated: false;
}

/**
 * Un mensaje del historial → fila de `whatsapp_messages`. Pura. null si no se
 * guarda: sin id, sin fecha (sin fecha no hay `created_at` honesto) o reacción
 * (como en vivo: un 👍 no es un mensaje nuevo).
 *
 * Todas las filas tienen las mismas claves: el upsert en lote de PostgREST
 * rellena con NULL lo que falte en alguna, y eso rompería el NOT NULL.
 */
export function filaDeHistorial(m: any, ctx: {
    conversationId: string;
    integrationId: string;
    /** El `id` del hilo: el número de la familia. */
    contacto: string;
    /** Número de la escuela, solo dígitos ('' si el webhook no lo trajo). */
    propio: string;
    personal: boolean;
}): FilaDeHistorial | null {
    if (!m?.id || m?.type === 'reaction') return null;
    const fecha = fechaDeHistorial(m?.timestamp);
    if (!fecha) return null;

    // La documentación lo dice así: si `from` es el número del negocio, lo
    // mandó el negocio; si no, la familia. Sin el número propio, todo lo que no
    // viene del contacto del hilo es de la escuela.
    const de = soloDigitos(m?.from);
    const saliente = ctx.propio !== '' ? de === ctx.propio : (de !== '' && de !== soloDigitos(ctx.contacto));
    const direction = saliente ? 'outbound' : 'inbound';

    // Lo que el CHECK no conoce (media_placeholder, contacts, edit…) entra como
    // 'unsupported'; el tipo original queda en el payload.
    const tipo = String(m?.type ?? 'text');
    const type = TIPOS_GUARDABLES.has(tipo) ? tipo : 'unsupported';

    const crudo = ctx.personal ? null : textoDe(m);
    // Versalitas y letras matemáticas a normales, como en vivo: si no, ninguna
    // regla las lee. El original queda en el payload.
    const texto = crudo !== null && direction === 'inbound' ? aLetrasNormales(crudo) : crudo;

    return {
        conversation_id: ctx.conversationId,
        integration_id: ctx.integrationId,
        wa_message_id: String(m.id),
        direction,
        type,
        text_body: texto,
        payload: { ...(ctx.personal ? payloadSinContenido(m) : m), historial: true },
        wa_timestamp: fecha,
        created_at: fecha,
        status: estadoDeHistorial(direction, m?.history_context?.status),
        ai_generated: false,
    };
}

/**
 * Marca `automatico: true` en los salientes del historial que son el saludo o
 * la ausencia de la app WhatsApp Business: la misma regla que los echos
 * (`echosAutomaticos`: mismo texto a ≥ 3 contactos en 7 días), aplicada al
 * trozo. Sin la marca, el saludo cuenta como «la escuela le escribió» y
 * `escuelaLeEscribioEnDias` (30 d) callaría al bot con un prospecto que solo
 * recibió la bienvenida automática. Muta y devuelve cuántas marcó.
 */
export function marcarSaludosDeLaApp(filas: FilaDeHistorial[]): number {
    const salientes = filas.filter((f) => f.direction === 'outbound' && f.text_body);
    if (!salientes.length) return 0;
    const auto = echosAutomaticos(salientes.map((f) => ({
        id: f.wa_message_id, conversation_id: f.conversation_id,
        text_body: f.text_body, wa_timestamp: f.wa_timestamp,
    })));
    let marcadas = 0;
    for (const f of salientes) {
        if (!auto.has(f.wa_message_id)) continue;
        f.payload = { ...f.payload, automatico: true };
        marcadas++;
    }
    return marcadas;
}

/** Lo que el historial deja en la conversación. ISO; null = el trozo no trae nada para esa columna. */
export interface ActividadDeHistorial { lastInboundAt: string | null; lastMessageAt: string | null }

/**
 * Por conversación: el último entrante (topado en `ahora − VENTANA_META_MS`,
 * ver arriba) y el último mensaje de cualquier dirección del trozo. Pura.
 */
export function actividadDeHistorial(filas: FilaDeHistorial[], ahora: number = Date.now()): Map<string, ActividadDeHistorial> {
    const tope = ahora - VENTANA_META_MS;
    const max = new Map<string, { entrante: number; mensaje: number }>();
    for (const f of filas) {
        const t = Date.parse(f.wa_timestamp);
        if (!Number.isFinite(t)) continue;
        const a = max.get(f.conversation_id) ?? { entrante: 0, mensaje: 0 };
        if (f.direction === 'inbound') a.entrante = Math.max(a.entrante, t);
        a.mensaje = Math.max(a.mensaje, t);
        max.set(f.conversation_id, a);
    }
    const salida = new Map<string, ActividadDeHistorial>();
    for (const [id, a] of max) {
        salida.set(id, {
            lastInboundAt: a.entrante ? new Date(Math.min(a.entrante, tope)).toISOString() : null,
            lastMessageAt: a.mensaje ? new Date(a.mensaje).toISOString() : null,
        });
    }
    return salida;
}

/** Valores actuales de la conversación (los lee `conversacionesDeContactos`). */
interface FechasDeConversacion { lastInboundAt: string | null; lastMessageAt: string | null }

const masNuevo = (propuesto: string | null, actual: string | null | undefined): boolean =>
    !!propuesto && (!actual || Date.parse(propuesto) > Date.parse(actual));

/**
 * RPC en lote de `marcarActividadDeHistorial` (propuesta, sin migración todavía:
 * `wa_historial_actividad(p_integration_id uuid, p_filas jsonb)` → un UPDATE …
 * FROM jsonb_to_recordset con GREATEST). Mientras no exista, se cae a la vía
 * por conversación y no se vuelve a intentar en este proceso.
 */
const RPC_ACTIVIDAD = 'wa_historial_actividad';
let rpcActividadDisponible = true;

/** Solo para pruebas. */
export function _reiniciarRpcActividad(): void { rpcActividadDisponible = true; }

/**
 * Deja `last_inbound_at` / `last_message_at` con lo del trozo sin bajar nunca
 * un valor más nuevo (lo vivo manda). No toca `status`, `unread_count` ni
 * `updated_at`. Devuelve cuántas conversaciones movió. Nunca lanza.
 *
 * En lote con la RPC; sin ella, UNA actualización condicional por
 * conversación que cambia (solo en la importación del historial, una vez por
 * escuela): la condición va en el UPDATE (`is null` / `lt`), así un mensaje en
 * vivo que entre en el medio no se pisa con uno viejo.
 */
async function marcarActividadDeHistorial(
    integrationId: string,
    actividad: Map<string, ActividadDeHistorial>,
    actuales: Map<string, FechasDeConversacion>,
    log?: Logger,
): Promise<number> {
    const cambios = [...actividad].filter(([id, a]) => {
        const c = actuales.get(id);
        return masNuevo(a.lastInboundAt, c?.lastInboundAt) || masNuevo(a.lastMessageAt, c?.lastMessageAt);
    });
    if (!cambios.length) return 0;

    if (rpcActividadDisponible) {
        const { data, error } = await supabase.rpc(RPC_ACTIVIDAD, {
            p_integration_id: integrationId,
            p_filas: cambios.map(([id, a]) => ({ id, last_inbound_at: a.lastInboundAt, last_message_at: a.lastMessageAt })),
        });
        if (!error) return Number(data ?? cambios.length);
        rpcActividadDisponible = false;
        log?.info({ err: error.message }, 'WhatsApp: sin la RPC de actividad del historial; se actualiza por conversación');
    }

    let movidas = 0;
    for (const [id, a] of cambios) {
        const c = actuales.get(id);
        const quiereEntrante = masNuevo(a.lastInboundAt, c?.lastInboundAt);
        const quiereMensaje = masNuevo(a.lastMessageAt, c?.lastMessageAt);
        try {
            // Lo común (conversación del historial, las dos en NULL): una sola escritura,
            // condicionada a que SIGAN en NULL.
            if (quiereEntrante && quiereMensaje && !c?.lastInboundAt && !c?.lastMessageAt) {
                const { data } = await supabase.from('whatsapp_conversations')
                    .update({ last_inbound_at: a.lastInboundAt, last_message_at: a.lastMessageAt })
                    .eq('id', id).eq('integration_id', integrationId)
                    .is('last_inbound_at', null).is('last_message_at', null)
                    .select('id');
                if (Array.isArray(data) && data.length) { movidas++; continue; }
            }
            let movida = false;
            if (quiereEntrante) {
                const { data } = await supabase.from('whatsapp_conversations')
                    .update({ last_inbound_at: a.lastInboundAt })
                    .eq('id', id).eq('integration_id', integrationId)
                    .or(`last_inbound_at.is.null,last_inbound_at.lt.${a.lastInboundAt}`)
                    .select('id');
                movida = Array.isArray(data) && data.length > 0;
            }
            if (quiereMensaje) {
                const { data } = await supabase.from('whatsapp_conversations')
                    .update({ last_message_at: a.lastMessageAt })
                    .eq('id', id).eq('integration_id', integrationId)
                    .or(`last_message_at.is.null,last_message_at.lt.${a.lastMessageAt}`)
                    .select('id');
                movida = movida || (Array.isArray(data) && data.length > 0);
            }
            if (movida) movidas++;
        } catch (err: any) {
            log?.warn({ err: err?.message || String(err), conversationId: id }, 'WhatsApp: no se pudo fechar la conversación del historial');
        }
    }
    return movidas;
}

/**
 * Las conversaciones de varios contactos de una vez, creando las que falten.
 * Una o dos consultas por trozo de webhook en vez de dos por hilo (Disk IO de
 * la base compartida). `ignoreDuplicates`: si un mensaje en vivo la creó en el
 * medio, no se le pisa el estado. `fechas` (si se pasa) recibe last_inbound_at /
 * last_message_at actuales, para no escribir lo que no cambia.
 */
async function conversacionesDeContactos(
    integration: WhatsAppIntegration,
    contactos: string[],
    fechas?: Map<string, FechasDeConversacion>,
): Promise<Map<string, { id: string; personal: boolean }>> {
    const salida = new Map<string, { id: string; personal: boolean }>();
    const leer = async (lista: string[]) => {
        for (let i = 0; i < lista.length; i += LOTE_CONTACTOS) {
            const trozo = lista.slice(i, i + LOTE_CONTACTOS);
            const { data, error } = await leerConMarca((cols) => supabase
                .from('whatsapp_conversations')
                .select(cols)
                .eq('integration_id', integration.id)
                .in('contact_wa_id', trozo), 'id, contact_wa_id, last_inbound_at, last_message_at');
            if (error) console.warn('[wa-coexistence] no se pudieron leer las conversaciones del historial', { err: error?.message });
            for (const c of (Array.isArray(data) ? data : []) as any[]) {
                salida.set(String(c.contact_wa_id), {
                    id: c.id, personal: esContactoSinContenido(c.contact_kind, c.tambien_familia),
                });
                fechas?.set(String(c.id), {
                    lastInboundAt: c.last_inbound_at ?? null, lastMessageAt: c.last_message_at ?? null,
                });
            }
        }
    };

    await leer(contactos);
    const faltan = contactos.filter((c) => !salida.has(c));
    for (let i = 0; i < faltan.length; i += LOTE_CONTACTOS) {
        const trozo = faltan.slice(i, i + LOTE_CONTACTOS);
        // 'closed': historia, no espera respuesta (ver conversacionConTipo).
        const { data, error } = await supabase
            .from('whatsapp_conversations')
            .upsert(trozo.map((contacto) => ({
                integration_id: integration.id,
                school_id: integration.school_id,
                contact_wa_id: contacto,
                status: 'closed',
            })), { onConflict: 'integration_id,contact_wa_id', ignoreDuplicates: true })
            .select('id, contact_wa_id');
        if (error) console.warn('[wa-coexistence] no se pudieron crear las conversaciones del historial', { err: error.message });
        // Recién creadas: nadie las marcó todavía como personales.
        for (const c of (Array.isArray(data) ? data : []) as any[]) {
            salida.set(String(c.contact_wa_id), { id: c.id, personal: false });
        }
    }
    // Las que otro proceso creó entre la lectura y el upsert (ignoradas arriba).
    const siguen = faltan.filter((c) => !salida.has(c));
    if (siguen.length) await leer(siguen);
    return salida;
}

/**
 * Guarda el lote de a LOTE_MENSAJES, idempotente por `wa_message_id` (Meta
 * reenvía trozos). Si un lote falla se reintenta fila por fila: el historial
 * se pide una sola vez y no se puede volver a traer. Devuelve las filas
 * escritas sin error (incluye las que ya estaban).
 */
async function guardarHistorial(filas: FilaDeHistorial[], log?: Logger): Promise<number> {
    let ok = 0;
    for (let i = 0; i < filas.length; i += LOTE_MENSAJES) {
        const lote = filas.slice(i, i + LOTE_MENSAJES);
        const { error } = await supabase.from('whatsapp_messages')
            .upsert(lote, { onConflict: 'wa_message_id', ignoreDuplicates: true });
        if (!error) { ok += lote.length; continue; }

        log?.error({ err: error.message, filas: lote.length }, 'WhatsApp: falló un lote del historial, se reintenta de a uno');
        for (const f of lote) {
            const { error: e1 } = await supabase.from('whatsapp_messages')
                .upsert(f, { onConflict: 'wa_message_id', ignoreDuplicates: true });
            if (e1) log?.error({ err: e1.message, waMessageId: f.wa_message_id }, 'WhatsApp: mensaje del historial perdido');
            else ok++;
        }
    }
    return ok;
}

/**
 * Deja un evento de historial en whatsapp_account_events, una sola vez por
 * integración y estado (Meta reintenta webhooks). Devuelve si lo escribió.
 * Nunca lanza.
 */
async function registrarEventoDeHistorial(
    integration: WhatsAppIntegration,
    e: { estado: string; motivo: string | null; wabaId: string | null; phoneNumberId: string | null; payload: unknown },
    log?: Logger,
): Promise<boolean> {
    try {
        const { data: ya } = await supabase.from('whatsapp_account_events')
            .select('id')
            .eq('integration_id', integration.id)
            .eq('field', CAMPO_HISTORIAL)
            .eq('nuevo_estado', e.estado)
            .limit(1);
        if (Array.isArray(ya) && ya.length > 0) return false;
        const { error } = await supabase.from('whatsapp_account_events').insert({
            integration_id: integration.id,
            school_id: integration.school_id,
            field: CAMPO_HISTORIAL,
            waba_id: e.wabaId,
            phone_number_id: e.phoneNumberId,
            nuevo_estado: e.estado,
            motivo: e.motivo,
            payload: e.payload,
        });
        if (error) {
            log?.error({ err: error.message, estado: e.estado }, 'WhatsApp: no se pudo registrar el estado del historial');
            return false;
        }
        return true;
    } catch (err: any) {
        log?.error({ err: err?.message || String(err) }, 'WhatsApp: no se pudo registrar el estado del historial');
        return false;
    }
}

/**
 * `history`: hasta 6 meses de conversaciones anteriores, en trozos.
 *
 * Meta da **24 horas** desde el alta para sincronizarlo; pasadas, hay que
 * desconectar a la escuela y repetir. Por eso esto entra por el webhook y se
 * procesa al vuelo, sin diferirlo a un cron.
 *
 * Por webhook: las conversaciones de todos los hilos en 1-2 consultas, los
 * mensajes en upserts de a LOTE_MENSAJES. Registra en whatsapp_account_events
 * (`field = 'history_sync'`) el `progress: 100` ('completo') y el rechazo de la
 * escuela, error 2593109 ('rechazado'); el rechazo y cualquier otro error de
 * Meta avisan además a la plataforma.
 */
export async function procesarHistorial(body: any, log?: Logger): Promise<void> {
    for (const entry of body?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
            if (change?.field !== 'history') continue;
            const v = change.value ?? {};
            const bloques = Array.isArray(v.history) ? v.history : [];
            if (!bloques.length) continue;

            const phoneNumberId: string | null = v?.metadata?.phone_number_id ?? null;
            const integration = await resolveIntegration(v?.metadata?.phone_number_id);
            if (!integration) continue;
            const wabaId: string | null = entry?.id ? String(entry.id) : null;

            // ── Errores: la escuela no compartió el historial (2593109) u otro.
            const errores = [
                ...(Array.isArray(v.errors) ? v.errors : []),
                ...bloques.flatMap((b: any) => (Array.isArray(b?.errors) ? b.errors : [])),
            ];
            for (const err of errores) {
                const code = Number(err?.code);
                const rechazado = code === ERROR_HISTORIAL_RECHAZADO;
                const motivo = `${Number.isFinite(code) ? code : 'sin código'}: ${String(
                    err?.error_data?.details ?? err?.message ?? err?.title ?? 'error de Meta')}`.slice(0, 500);
                log?.warn({ integrationId: integration.id, code, motivo }, 'WhatsApp: Meta no mandó el historial');
                const nuevo = await registrarEventoDeHistorial(integration, {
                    estado: rechazado ? 'rechazado' : 'error', motivo, wabaId, phoneNumberId,
                    payload: { field: 'history', errors: [err] },
                }, log);
                if (nuevo) {
                    await avisarPlataformaSobreHistorial({
                        motivo: rechazado ? 'rechazado' : 'error_meta', integrationId: integration.id,
                        schoolId: integration.school_id, phoneNumberId, tipo: 'history', detalle: motivo,
                    });
                }
            }

            // ── Mensajes. El número de la escuela, para saber quién escribió.
            const propio = soloDigitos(v?.metadata?.display_phone_number);
            const contactos = [...new Set<string>(bloques.flatMap((b: any) =>
                (Array.isArray(b?.threads) ? b.threads : []).map((h: any) => String(h?.id ?? '')))
                .filter(Boolean))];
            const fechas = new Map<string, FechasDeConversacion>();
            const convs = contactos.length ? await conversacionesDeContactos(integration, contactos, fechas) : new Map();

            const filas: FilaDeHistorial[] = [];
            const vistos = new Set<string>();
            let descartados = 0;
            for (const bloque of bloques) {
                for (const hilo of (Array.isArray(bloque?.threads) ? bloque.threads : [])) {
                    const contacto = String(hilo?.id ?? '');
                    const conv = convs.get(contacto);
                    for (const m of (Array.isArray(hilo?.messages) ? hilo.messages : [])) {
                        const f = conv ? filaDeHistorial(m, {
                            conversationId: conv.id, integrationId: integration.id,
                            contacto, propio, personal: conv.personal,
                        }) : null;
                        if (!f || vistos.has(f.wa_message_id)) { descartados++; continue; }
                        vistos.add(f.wa_message_id);
                        filas.push(f);
                    }
                }
            }
            const automaticos = marcarSaludosDeLaApp(filas);
            const guardados = await guardarHistorial(filas, log);
            // Fechas de la conversación (audiencia de campañas), con GREATEST y el
            // tope de la ventana: ver «Historial» arriba. Van después de los
            // mensajes: si esto falla, los mensajes ya quedaron.
            const fechadas = filas.length
                ? await marcarActividadDeHistorial(integration.id, actividadDeHistorial(filas), fechas, log)
                : 0;

            // ── Avance. `progress: 100` es la señal de que terminó.
            for (const bloque of bloques) {
                const meta = bloque?.metadata;
                if (!meta) continue;
                log?.info({
                    integrationId: integration.id,
                    fase: meta.phase, trozo: meta.chunk_order, avance: meta.progress,
                }, 'WhatsApp: trozo de historial');
                if (Number(meta.progress) === 100) {
                    await registrarEventoDeHistorial(integration, {
                        estado: 'completo', motivo: 'Historial sincronizado por completo (progress 100)',
                        wabaId, phoneNumberId,
                        // Solo los metadatos: el trozo entero trae el contenido de los mensajes.
                        payload: { field: 'history', metadata: meta },
                    }, log);
                    log?.info({ integrationId: integration.id }, 'WhatsApp: historial sincronizado por completo');
                }
            }

            log?.info({ integrationId: integration.id, mensajes: guardados, descartados, automaticos, fechadas },
                      'WhatsApp: historial procesado');
        }
    }
}

// ─── Aviso a la plataforma ──────────────────────────────────────────────────

export type MotivoAvisoHistorial = 'pedido_fallido' | 'rechazado' | 'error_meta';

/**
 * Correo a SportMaps (`SUPPORT_ALERT_EMAIL`) cuando el historial no va a
 * llegar: hay 24 h para reaccionar y nadie mira los logs. Uno por integración
 * y motivo (la reserva en `email_sends` hace de candado entre los 3 BFF).
 * Nunca lanza.
 */
export async function avisarPlataformaSobreHistorial(p: {
    motivo: MotivoAvisoHistorial;
    integrationId: string;
    schoolId: string | null;
    phoneNumberId: string | null;
    tipo: string;
    detalle: string;
    plazoHasta?: string | null;
}): Promise<void> {
    try {
        const destinos = correosDeSoporte();
        if (!destinos.length) return;
        let escuela = 'Escuela sin nombre';
        if (p.schoolId) {
            const { data } = await supabase.from('schools').select('name').eq('id', p.schoolId).maybeSingle();
            if ((data as any)?.name) escuela = String((data as any).name);
        }
        const que = p.tipo === 'history' ? 'el historial' : 'los contactos';
        const subject = p.motivo === 'pedido_fallido'
            ? `[WhatsApp] No se pudo pedir ${que} de ${escuela}`
            : p.motivo === 'rechazado'
                ? `[WhatsApp] ${escuela} no compartió su historial`
                : `[WhatsApp] Meta no mandó el historial de ${escuela}`;
        const lineas = p.motivo === 'pedido_fallido'
            ? [
                `Meta respondió: ${p.detalle}`,
                `Meta da 24 h desde el alta y deja pedirlo UNA sola vez${p.plazoHasta ? ` (plazo: ${horaColombia(p.plazoHasta)})` : ''}. `
                    + 'Pasado el plazo, la única salida es desconectar el número y repetir el alta.',
                'Reintento dentro del plazo: pedirHistorialDeCoexistencia (bff/src/services/whatsapp-onboarding.service.ts) '
                    + 'con el token de la integración; es idempotente y no repite lo que ya quedó pedido.',
            ]
            : p.motivo === 'rechazado'
                ? [
                    'Meta avisó (error 2593109) que la escuela tiene apagado «compartir historial» en la app WhatsApp Business.',
                    'Sin historial no hay conversaciones anteriores al alta (audiencias de campañas, contexto del bot). '
                        + 'Para traerlo hay que desconectar y repetir el alta con el historial compartido.',
                ]
                : [`Meta mandó un error en el webhook del historial: ${p.detalle}`];
        lineas.push(`Integración ${p.integrationId}${p.phoneNumberId ? ` · número ${p.phoneNumberId}` : ''}.`);

        await enviarConReserva({
            clave: `wa_historial:${p.motivo}:${p.tipo}:${p.integrationId}`,
            tipo: 'wa_historial_aviso',
            plantilla: null,
            schoolId: p.schoolId,
            refId: p.integrationId,
            destinos,
            data: {},
            respaldo: { subject, titulo: subject.replace(/^\[WhatsApp\] /, ''), lineas },
        });
    } catch (err: any) {
        console.error('[wa-coexistence] no se pudo avisar a la plataforma', { err: err?.message || String(err) });
    }
}

/**
 * `smb_app_state_sync`: los contactos de la agenda del negocio.
 *
 * NO se procesa todavia, a proposito. Serviria para mostrar "Carolina" en vez
 * del telefono en el buzon, pero no verifique la forma del payload contra la
 * documentacion y no voy a adivinarla: un parseo equivocado guarda basura en
 * silencio, que es peor que no guardar nada.
 *
 * Se registra que llego, para saber si Meta los esta mandando.
 */
export function registrarAppState(body: any, log?: Logger): void {
    for (const entry of body?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
            if (change?.field !== 'smb_app_state_sync') continue;
            log?.info({ claves: Object.keys(change?.value ?? {}) },
                      'WhatsApp: smb_app_state_sync recibido (sin procesar todavia)');
        }
    }
}
