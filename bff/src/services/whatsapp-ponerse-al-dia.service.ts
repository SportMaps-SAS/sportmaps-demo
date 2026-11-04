/**
 * whatsapp-ponerse-al-dia — lo que quedó SIN RESPUESTA en el WhatsApp de una
 * escuela, clasificado con una acción explícita.
 *
 * Origen (Dynasty, 2026-10-05/06):
 *   - el 5-oct el bot estuvo apagado: los comprobantes se recuperaron después
 *     en silencio (scripts/wa-recuperar-comprobantes.ts deja el pago EN
 *     REVISIÓN sin escribirle a nadie), así que la familia nunca supo nada;
 *   - el 6-oct, de 08:51 a 09:43, el bot estuvo en modo ASISTIDO mientras
 *     Gemini/Groq fallaban y dejó 38 borradores que nadie aprobó; al volver a
 *     auto quedaron huérfanos;
 *   - la bandeja «Por responder» mezclaba eso con cierres («Ok gracias»,
 *     «Vale», 👍) que no piden nada.
 *
 * Una conversación ENTRA si: su último mensaje real es ENTRANTE (ningún
 * saliente del bot, del buzón ni echo del celular después; el saludo
 * automático de la app del negocio no cuenta), la ventana de 24 h de Meta
 * sigue abierta, no está cerrada a mano ni tomada desde el buzón.
 *
 * ACCIONES (`accionDeConversacion`, pura):
 *   a) cierre       — todo lo que quedó sin responder es «gracias / ok / vale /
 *                     👍» (o stickers/reacciones): se da por atendida (el mismo
 *                     UPDATE que «Dar por atendida» del buzón). No se envía nada.
 *   b) comprobante  — una FAMILIA mandó imagen/PDF. Si el archivo no está en
 *                     `whatsapp_inbound_queue` se encola (el worker lo lee,
 *                     aplica y contesta como a cualquiera). Si está en curso
 *                     (pending/processing/waiting_user) no se toca. Si ya se
 *                     procesó sin que nadie le contestara (la recuperación del
 *                     5-oct, o el worker con el bot apagado) se le manda el
 *                     estado de sus comprobantes y cobros (`responderEstadoDeComprobantes`,
 *                     el mismo texto de «ya pagué»). Re-encolar eso duplicaría
 *                     el pago: la fila ya dejó el cobro en revisión.
 *   c) turno        — pregunta o pedido de una familia, o desconocido con
 *                     intención de prospecto/tema escolar: el turno REAL del
 *                     bot (familia → `runBotTurn`, audio transcrito primero si
 *                     hoy se puede; desconocido → `atenderDesconocido`).
 *   d) revisar      — personal, staff, desconocido con solo un saludo o algo
 *                     dudoso: NO se envía; queda listado para la escuela.
 *   e) borradores   — en a/b/c los borradores `pending` de la conversación se
 *                     pasan a 'expired' (el CHECK de whatsapp_message_drafts solo
 *                     admite pending|approved|rejected|sent|expired; 'rejected'
 *                     es «una persona dijo que no»). En d se dejan para la escuela.
 *                     No se reenvía el texto del borrador: se escribió con el
 *                     estado de hace horas y con el modelo fallando.
 *
 * Idempotente entre los 3 BFF: si hay borradores, el BFF que gana el UPDATE
 * condicional (`status='pending'` → 'expired') es el único que actúa; el turno
 * pasa además por el candado de conversación (`correrTurnoAgrupado`) y, ya con
 * el candado, se vuelve a mirar que siga sin respuesta. Si el turno revienta,
 * los borradores vuelven a 'pending'.
 */

import { supabase } from '../config/supabase';
import type { WhatsAppIntegration, ParsedInboundMessage } from './whatsapp.service';
import { esSalienteAutomatico, TIPOS_FAMILIA } from './whatsapp-buzon';
import { tomadaVigente } from './whatsapp-tomada.service';
import { esCierreSuelto, esAutoRespuesta } from './whatsapp-reglas-turno';
import { intencionDeProspecto, interesesDeProspecto, puertaDeProspecto, temaEscolar } from './whatsapp-atencion.service';
import { esMarcaNoFamilia } from './whatsapp-tipo-contacto';

export const VENTANA_MS = 24 * 3600_000;
/** Un borrador más viejo que esto, en modo auto, ya es un olvido (aviso y resumen diario). */
export const HUERFANO_MIN_MS = 30 * 60_000;

const TIPOS_SIN_CONTENIDO = new Set(['sticker', 'reaction', 'unsupported', 'unknown', 'system']);
const TIPOS_TEXTO = new Set(['text', 'interactive', 'button']);
const TIPOS_ADJUNTO = new Set(['image', 'document']);
const COLA_EN_CURSO = new Set(['pending', 'processing', 'waiting_user']);

export interface BorradorViejo { id: string; texto: string; creado: string; step: string | null }
export interface EntranteSinResponder {
    waMessageId: string; tipo: string; texto: string | null; creado: string;
    transcripcion: any; mediaId: string | null; payload: any;
}
export interface ConversacionPorResponder {
    conversationId: string;
    contactWaId: string;
    contactName: string | null;
    contactKind: string | null;
    parentId: string | null;
    borradores: BorradorViejo[];
    entrantes: EntranteSinResponder[];
    /** Textos entrantes de los últimos días (para la regla de prospecto en seguimiento). */
    textosPrevios: string[];
    /** ¿La escuela/bot ya le había escrito alguna vez antes? */
    huboSaliente: boolean;
    ultimoEntranteMs: number;
    restanteMs: number;
}

export type Accion = 'cierre' | 'comprobante' | 'turno' | 'revisar';
export type SubComprobante = 'encolar' | 'en_cola' | 'estado';
export interface DecisionDeAccion { accion: Accion; motivo: string; comprobante?: SubComprobante }

/** Fila de `whatsapp_inbound_queue` por wa_message_id. */
export type EstadoDeCola = Map<string, { status: string; result_type: string | null }>;

const tiempo = (f: { wa_timestamp?: string | null; created_at?: string | null }) =>
    new Date(f.wa_timestamp || f.created_at || 0).getTime();

/**
 * La acción para una conversación sin respuesta. Pura: todo lo que necesita
 * viene en `c` y en el estado de la cola.
 */
export function accionDeConversacion(
    c: Pick<ConversacionPorResponder, 'contactKind' | 'entrantes' | 'textosPrevios' | 'parentId'>,
    cola: EstadoDeCola = new Map(),
    equipo: ReadonlyMap<string, string> = new Map(),
): DecisionDeAccion {
    const tipo = c.contactKind ?? 'desconocido';
    const conContenido = c.entrantes.filter((e) => !TIPOS_SIN_CONTENIDO.has(e.tipo));
    const textos = conContenido.filter((e) => TIPOS_TEXTO.has(e.tipo)).map((e) => (e.texto ?? '').trim()).filter(Boolean);
    const adjuntos = conContenido.filter((e) => TIPOS_ADJUNTO.has(e.tipo));
    const audios = conContenido.filter((e) => e.tipo === 'audio');
    const otros = conContenido.filter((e) => !TIPOS_TEXTO.has(e.tipo) && !TIPOS_ADJUNTO.has(e.tipo) && e.tipo !== 'audio');

    if (esMarcaNoFamilia(tipo)) return { accion: 'revisar', motivo: 'contacto personal' };
    if (tipo === 'staff') return { accion: 'revisar', motivo: 'alguien del equipo' };

    // a) Cierre: nada con contenido, o solo «gracias / ok / 👍» (con o sin el
    //    nombre de quien atiende), o la auto-respuesta de otro negocio.
    if (!adjuntos.length && !audios.length && !otros.length
        && conContenido.filter((e) => TIPOS_TEXTO.has(e.tipo))
            .every((e) => esCierreSuelto(e.texto, equipo) || esAutoRespuesta(e.texto))) {
        return { accion: 'cierre', motivo: textos.length ? `cierre: «${textos[textos.length - 1]}»` : 'sin contenido' };
    }

    const esFamilia = (TIPOS_FAMILIA as readonly string[]).includes(tipo);

    // b) Comprobante de familia.
    if (adjuntos.length && esFamilia) {
        if (adjuntos.some((a) => !cola.has(a.waMessageId))) {
            return { accion: 'comprobante', comprobante: 'encolar', motivo: 'el archivo nunca entró a la cola' };
        }
        if (adjuntos.some((a) => COLA_EN_CURSO.has(cola.get(a.waMessageId)!.status))) {
            return { accion: 'comprobante', comprobante: 'en_cola', motivo: 'la cola lo está procesando o espera a la familia' };
        }
        if (!c.parentId) return { accion: 'revisar', motivo: 'comprobante procesado de familia sin cuenta vinculada' };
        return { accion: 'comprobante', comprobante: 'estado', motivo: 'procesado sin respuesta a la familia' };
    }

    // c) Familia que pregunta (texto o audio).
    if (esFamilia) {
        if (!textos.length && !audios.length) return { accion: 'revisar', motivo: 'solo video u otro adjunto' };
        return { accion: 'turno', motivo: audios.length && !textos.length ? 'nota de voz' : 'pregunta o pedido' };
    }

    // Desconocido / prospecto.
    if (adjuntos.length) return { accion: 'revisar', motivo: 'adjunto de un número que no es familia' };
    const ultimo = textos[textos.length - 1] ?? null;
    if (ultimo && (tipo === 'prospecto' || textos.some((t) => intencionDeProspecto(t))
        || puertaDeProspecto(ultimo, c.textosPrevios) || textos.some((t) => temaEscolar(t))
        || textos.some((t) => interesesDeProspecto(t).some((i) => i !== 'informacion')))) {
        return { accion: 'turno', motivo: 'prospecto o tema escolar' };
    }
    return { accion: 'revisar', motivo: ultimo ? 'saludo suelto o dudoso de un número desconocido' : 'audio de un número desconocido' };
}

/**
 * Las conversaciones de una integración que esperan respuesta, ordenadas por
 * la ventana que vence antes. `soloConBorradores` + `minEdadMs`: el conteo de
 * borradores huérfanos (aviso del PATCH de ajustes y resumen diario). Solo lee.
 */
export async function listarPorResponder(
    integration: Pick<WhatsAppIntegration, 'id' | 'school_id'>,
    opciones: { ahora?: number; soloConBorradores?: boolean; minEdadMs?: number } = {},
): Promise<ConversacionPorResponder[]> {
    const ahora = opciones.ahora ?? Date.now();
    const desdeVentana = new Date(ahora - VENTANA_MS).toISOString();

    const { data: drafts, error } = await supabase.from('whatsapp_message_drafts')
        .select('id, conversation_id, proposed_text, tool_context, created_at')
        .eq('integration_id', integration.id)
        .eq('status', 'pending')
        .gte('created_at', new Date(ahora - VENTANA_MS - 6 * 3600_000).toISOString())
        .order('created_at', { ascending: true })
        .limit(1000);
    if (error) throw new Error(`listar borradores pending: ${error.message}`);
    const porConv = new Map<string, BorradorViejo[]>();
    for (const d of (drafts ?? []) as any[]) {
        if (opciones.minEdadMs && new Date(d.created_at).getTime() > ahora - opciones.minEdadMs) continue;
        const lista = porConv.get(d.conversation_id) ?? [];
        lista.push({ id: d.id, texto: d.proposed_text, creado: d.created_at, step: d.tool_context?.step ?? null });
        porConv.set(d.conversation_id, lista);
    }
    if (opciones.soloConBorradores && !porConv.size) return [];

    let q = supabase.from('whatsapp_conversations')
        .select('id, contact_wa_id, contact_name, contact_kind, parent_id, status, last_inbound_at, tomada_por, tomada_hasta')
        .eq('school_id', integration.school_id)
        .gte('last_inbound_at', desdeVentana)
        .limit(500);
    if (opciones.soloConBorradores) q = q.in('id', [...porConv.keys()]);
    const { data: convs, error: errC } = await q;
    if (errC) throw new Error(`leer conversaciones: ${errC.message}`);

    const salida: ConversacionPorResponder[] = [];
    for (const c of (convs ?? []) as any[]) {
        if (c.status === 'closed') continue;
        if (tomadaVigente(c, ahora)) continue;
        const { data: msgs } = await supabase.from('whatsapp_messages')
            .select('wa_message_id, direction, type, text_body, payload, ai_generated, created_at, wa_timestamp')
            .eq('conversation_id', c.id)
            .gte('created_at', new Date(ahora - 7 * VENTANA_MS).toISOString())
            .order('created_at', { ascending: false })
            .limit(300);
        const lista = ((msgs ?? []) as any[]).sort((a, b) => tiempo(a) - tiempo(b));
        // Lo importado del historial de Coexistence (`payload.historial`) es de
        // ANTES del alta: nunca es «sin responder» (Meta no abre la ventana con
        // eso y el bot no contesta mensajes viejos). Solo cuenta lo que entró en vivo.
        const entrantes = lista.filter((m) => m.direction === 'inbound' && m.payload?.historial !== true);
        if (!entrantes.length) continue;
        const ultimoEntranteMs = tiempo(entrantes[entrantes.length - 1]);
        const restanteMs = ultimoEntranteMs + VENTANA_MS - ahora;
        if (restanteMs <= 0) continue;
        const reales = lista.filter((m) => m.direction === 'outbound' && !esSalienteAutomatico(m));
        const ultimoSaliente = Math.max(0, ...reales.map(tiempo));
        if (ultimoSaliente >= ultimoEntranteMs) continue;
        const sinResponder = entrantes.filter((m) => tiempo(m) > ultimoSaliente);
        salida.push({
            conversationId: c.id,
            contactWaId: c.contact_wa_id,
            contactName: c.contact_name ?? null,
            contactKind: c.contact_kind ?? null,
            parentId: c.parent_id ?? null,
            borradores: porConv.get(c.id) ?? [],
            entrantes: sinResponder.map((m) => ({
                waMessageId: m.wa_message_id,
                tipo: m.type,
                texto: m.text_body ?? null,
                creado: m.wa_timestamp || m.created_at,
                transcripcion: m.payload?.transcripcion ?? null,
                mediaId: m.payload?.[m.type]?.id ?? null,
                payload: m.payload ?? null,
            })),
            textosPrevios: entrantes.filter((m) => tiempo(m) <= ultimoSaliente)
                .map((m) => (m.text_body ?? '').trim()).filter(Boolean),
            huboSaliente: reales.length > 0,
            ultimoEntranteMs,
            restanteMs,
        });
    }
    return salida.sort((a, b) => a.restanteMs - b.restanteMs);
}

/** Estado en la cola de los adjuntos de estas conversaciones. */
export async function estadoDeCola(convs: ConversacionPorResponder[]): Promise<EstadoDeCola> {
    const ids = convs.flatMap((c) => c.entrantes.filter((e) => TIPOS_ADJUNTO.has(e.tipo)).map((e) => e.waMessageId));
    const mapa: EstadoDeCola = new Map();
    for (let i = 0; i < ids.length; i += 100) {
        const { data } = await supabase.from('whatsapp_inbound_queue')
            .select('wa_message_id, status, result_type')
            .in('wa_message_id', ids.slice(i, i + 100));
        for (const f of (data ?? []) as any[]) mapa.set(f.wa_message_id, { status: f.status, result_type: f.result_type });
    }
    return mapa;
}

/** Cuántos borradores huérfanos (pending > `minEdadMs`, sin respuesta, ventana abierta). Nunca lanza. */
export async function contarBorradoresHuerfanos(
    integration: Pick<WhatsAppIntegration, 'id' | 'school_id'>,
    opciones: { ahora?: number; minEdadMs?: number } = {},
): Promise<{ conversaciones: number; borradores: number }> {
    try {
        const l = await listarPorResponder(integration, { ...opciones, soloConBorradores: true });
        return { conversaciones: l.length, borradores: l.reduce((n, c) => n + c.borradores.length, 0) };
    } catch {
        return { conversaciones: 0, borradores: 0 };
    }
}

/** id del botón que tocó, desde el payload crudo guardado (mismo orden que el parser). */
export function botonDelPayload(p: any): string | null {
    return p?.interactive?.button_reply?.id ?? p?.interactive?.list_reply?.id ?? p?.button?.payload ?? null;
}

/** ¿Sigue sin respuesta? Se mira de nuevo ya con el candado (otro BFF pudo contestar). */
async function sigueSinRespuesta(conversationId: string, ultimoEntranteMs: number): Promise<boolean> {
    const { data } = await supabase.from('whatsapp_messages')
        .select('direction, payload, wa_timestamp, created_at')
        .eq('conversation_id', conversationId)
        .eq('direction', 'outbound')
        .gte('created_at', new Date(ultimoEntranteMs - 60_000).toISOString())
        .limit(50);
    return !((data ?? []) as any[]).some((m) => tiempo(m) >= ultimoEntranteMs && !esSalienteAutomatico(m));
}

export interface ResultadoAccion { hecho: string; detalle?: string }

/**
 * Ejecuta la acción. Con `simular`, quien llama ya está dentro de
 * `simularEnvios` y bloqueó las escrituras: no se descartan borradores ni se
 * toma el candado, y la clasificación usa `contact_kind` guardado (la de
 * `debeAtender` vincula la conversación por teléfono: escribe).
 */
export async function ejecutarAccion(
    integration: WhatsAppIntegration,
    c: ConversacionPorResponder,
    decision: DecisionDeAccion,
    opciones: { simular?: boolean; log?: { info?: (...a: any[]) => void; warn?: (...a: any[]) => void } } = {},
): Promise<ResultadoAccion> {
    if (decision.accion === 'revisar') return { hecho: 'nada (para la escuela)' };
    if (decision.accion === 'comprobante' && decision.comprobante === 'en_cola') {
        // Los borradores sí se descartan: el worker contesta.
        if (!opciones.simular) await reclamarBorradores(c);
        return { hecho: 'nada (la cola lo atiende)' };
    }

    // e) Reclamar los borradores: el que gana el UPDATE actúa.
    let reclamados: string[] = [];
    if (!opciones.simular && c.borradores.length) {
        reclamados = await reclamarBorradores(c);
        if (!reclamados.length) return { hecho: 'ya lo atendió otro proceso' };
    }
    const devolver = async () => {
        if (!reclamados.length) return;
        await supabase.from('whatsapp_message_drafts')
            .update({ status: 'pending', updated_at: new Date().toISOString() })
            .in('id', reclamados).eq('status', 'expired');
    };

    try {
        if (decision.accion === 'cierre') {
            if (!opciones.simular) {
                const { error } = await supabase.from('whatsapp_conversations')
                    .update({ status: 'closed', unread_count: 0, updated_at: new Date().toISOString() })
                    .eq('id', c.conversationId);
                if (error) throw new Error(error.message);
            }
            return { hecho: 'dada por atendida' };
        }

        const ultimo = c.entrantes[c.entrantes.length - 1];
        const bot = await import('./whatsapp-bot.service');

        if (decision.accion === 'comprobante' && decision.comprobante === 'encolar') {
            const { encolarAdjunto } = await import('./whatsapp-queue.service');
            const resultados: string[] = [];
            for (const a of c.entrantes.filter((e) => TIPOS_ADJUNTO.has(e.tipo))) {
                if (opciones.simular) { resultados.push('se encolaría'); continue; }
                const r = await encolarAdjunto(integration, mensajeDesde(integration, c, a));
                resultados.push(r);
            }
            return { hecho: 'encolado', detalle: resultados.join(', ') };
        }

        const conCandado = async (correr: () => Promise<void>): Promise<'corrido' | 'ocupado' | 'respondida'> => {
            if (opciones.simular) { await correr(); return 'corrido'; }
            const { correrTurnoAgrupado } = await import('./whatsapp-turno-agrupado.service');
            let respondida = false;
            const r = await correrTurnoAgrupado({
                conversationId: c.conversationId, waMessageId: ultimo.waMessageId, inmediato: true,
                log: opciones.log as any,
                correr: async () => {
                    if (!(await sigueSinRespuesta(c.conversationId, c.ultimoEntranteMs))) { respondida = true; return; }
                    await correr();
                },
            });
            return respondida ? 'respondida' : r === 'corrido' ? 'corrido' : 'ocupado';
        };
        const cerrarCon = async (r: 'corrido' | 'ocupado' | 'respondida', hecho: string, detalle?: string) => {
            if (r === 'corrido') return { hecho, detalle };
            await devolver();
            return { hecho: r === 'ocupado' ? 'candado ocupado; reintentar' : 'ya tenía respuesta' };
        };

        if (decision.accion === 'comprobante') {
            const r = await conCandado(() => bot.responderEstadoDeComprobantes(
                integration, c.conversationId, c.contactWaId, c.parentId));
            return cerrarCon(r, 'estado de comprobantes');
        }

        // c) Turno real.
        const { debeAtender, ajustesDeAtencion, TIPOS_QUE_SE_ATIENDEN } = await import('./whatsapp-atencion.service');
        let d: { atender: boolean; tipo: string; botEncendido: boolean };
        if (opciones.simular) {
            const aj = await ajustesDeAtencion(integration.id);
            const tipo = c.contactKind ?? 'desconocido';
            d = { tipo, botEncendido: aj.botEncendido,
                atender: aj.botEncendido && (TIPOS_QUE_SE_ATIENDEN.has(tipo as any)
                    || (tipo === 'desconocido' && aj.responderDesconocidos)) };
        } else {
            d = await debeAtender(integration, c.conversationId, c.contactWaId);
        }
        if (!d.botEncendido) { await devolver(); return { hecho: 'nada (bot apagado)' }; }

        // El último con texto (un sticker al final no es la pregunta).
        const conTexto = [...c.entrantes].reverse().find((e) => TIPOS_TEXTO.has(e.tipo) || e.tipo === 'audio') ?? ultimo;
        const texto = (conTexto.texto ?? '').trim() || null;
        const botonId = botonDelPayload(conTexto.payload);

        if (!d.atender) {
            if (d.tipo !== 'desconocido' || conTexto.tipo === 'audio') {
                await devolver();
                return { hecho: `nada (no se atiende: ${d.tipo})` };
            }
            let res = '';
            const r = await conCandado(async () => {
                res = await bot.atenderDesconocido(integration, c.conversationId, c.contactWaId, texto, botonId);
            });
            return cerrarCon(r, 'desconocido', res);
        }

        if (conTexto.tipo === 'audio') {
            if (conTexto.transcripcion?.al_bot === true && texto) {
                const r = await conCandado(() => bot.runBotTurn(integration, c.conversationId, c.contactWaId,
                    texto, conTexto.waMessageId, false, null, { origen: 'audio' }));
                return cerrarCon(r, 'turno (audio ya transcrito)');
            }
            const { atenderNotaDeVoz } = await import('./whatsapp-notas-de-voz.service');
            let r: 'corrido' | 'ocupado' | 'respondida' = 'corrido';
            const nota = await atenderNotaDeVoz({
                integration, conversationId: c.conversationId, msg: mensajeDesde(integration, c, conTexto),
                tipo: d.tipo as any,
                turno: async (t) => {
                    r = await conCandado(() => bot.runBotTurn(integration, c.conversationId, c.contactWaId,
                        t, conTexto.waMessageId, false, null, { origen: 'audio' }));
                },
            });
            return cerrarCon(r, 'nota de voz', nota);
        }

        const r = await conCandado(() => bot.runBotTurn(integration, c.conversationId, c.contactWaId,
            texto, conTexto.waMessageId, false, botonId));
        return cerrarCon(r, 'turno');
    } catch (err: any) {
        await devolver().catch(() => undefined);
        return { hecho: 'error', detalle: err?.message ?? String(err) };
    }
}

async function reclamarBorradores(c: ConversacionPorResponder): Promise<string[]> {
    if (!c.borradores.length) return [];
    const { data, error } = await supabase.from('whatsapp_message_drafts')
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .in('id', c.borradores.map((b) => b.id))
        .eq('status', 'pending')
        .select('id');
    if (error) throw new Error(`descartar borradores: ${error.message}`);
    return ((data ?? []) as any[]).map((d) => d.id);
}

function mensajeDesde(
    integration: WhatsAppIntegration, c: ConversacionPorResponder, e: EntranteSinResponder,
): ParsedInboundMessage {
    const media = e.payload?.[e.tipo] ?? {};
    return {
        phoneNumberId: integration.phone_number_id,
        contactWaId: c.contactWaId,
        contactName: c.contactName,
        waMessageId: e.waMessageId,
        type: e.tipo,
        textBody: e.texto,
        waTimestamp: e.creado,
        mediaId: e.mediaId,
        mediaMimeType: media.mime_type ?? null,
        mediaCaption: media.caption ?? null,
        botonId: null,
        raw: e.payload ?? {},
    };
}

/**
 * Ponerse al día con TODA la escuela, en serie y por la ventana que vence
 * antes. Lo usa el botón «Responder ahora» de Configuración.
 * `soloConBorradores`: solo las conversaciones con borradores huérfanos.
 */
export async function ponerseAlDia(
    integration: WhatsAppIntegration,
    opciones: { soloConBorradores?: boolean; log?: { info?: (...a: any[]) => void; warn?: (...a: any[]) => void } } = {},
): Promise<Record<string, number>> {
    const conteo: Record<string, number> = {};
    const lista = await listarPorResponder(integration, { soloConBorradores: opciones.soloConBorradores });
    const cola = await estadoDeCola(lista);
    const { vocativosDeEscuela } = await import('./whatsapp-bot.service');
    const equipo = await vocativosDeEscuela(integration.school_id);
    for (const c of lista) {
        const decision = accionDeConversacion(c, cola, equipo);
        const r = await ejecutarAccion(integration, c, decision, { log: opciones.log });
        const clave = `${decision.accion}:${r.hecho}`;
        conteo[clave] = (conteo[clave] ?? 0) + 1;
        if (r.hecho === 'error') opciones.log?.warn?.({ conversationId: c.conversationId, err: r.detalle }, '[wa-al-dia] falló');
    }
    opciones.log?.info?.({ integrationId: integration.id, conteo }, '[wa-al-dia] terminado');
    return conteo;
}

/**
 * Webhook en vivo: un cierre suelto («gracias», «ok», 👍) que llega DESPUÉS
 * de una respuesta, sin nada previo pendiente, deja la conversación atendida
 * (cerrada, como «Dar por atendida»). Si la familia vuelve a escribir,
 * `wa_ingest_inbound_message` la reabre. Nunca lanza.
 */
export async function cerrarSiEsCierre(
    conversationId: string, waMessageId: string, texto: string | null,
    equipo: ReadonlyMap<string, string> = new Map(),
): Promise<boolean> {
    try {
        if (!esCierreSuelto(texto, equipo)) return false;
        const { data } = await supabase.from('whatsapp_messages')
            .select('wa_message_id, direction, type, text_body, payload, wa_timestamp, created_at')
            .eq('conversation_id', conversationId)
            .gte('created_at', new Date(Date.now() - 7 * VENTANA_MS).toISOString())
            .order('created_at', { ascending: false })
            .limit(100);
        const lista = ((data ?? []) as any[]).sort((a, b) => tiempo(a) - tiempo(b));
        const ultimoSaliente = Math.max(0, ...lista
            .filter((m) => m.direction === 'outbound' && !esSalienteAutomatico(m)).map(tiempo));
        if (!ultimoSaliente) return false;
        // Todo lo que entró después de la respuesta tiene que ser cierre (o ruido).
        const despues = lista.filter((m) => m.direction === 'inbound' && tiempo(m) > ultimoSaliente
            && m.wa_message_id !== waMessageId && !TIPOS_SIN_CONTENIDO.has(m.type));
        if (despues.some((m) => !TIPOS_TEXTO.has(m.type) || !esCierreSuelto(m.text_body, equipo))) return false;
        const { error } = await supabase.from('whatsapp_conversations')
            .update({ status: 'closed', unread_count: 0, updated_at: new Date().toISOString() })
            .eq('id', conversationId);
        return !error;
    } catch {
        return false;
    }
}
