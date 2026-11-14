/**
 * avisos-correo.service — Avisos por correo del bot (WhatsApp y Mapi).
 *
 * CONTRATO (lo fija la integración; el cuerpo lo completa el agente de correo):
 * quien escala llama `avisarEscalamientoPorCorreo` SIN await bloqueante sobre
 * el flujo del bot (`void …catch(() => {})`). Nunca lanza.
 *
 * Por qué correo además del push: el push al celular de la dueña no se ve. Es
 * una notificación más entre las del día y, si la app no está instalada o el
 * permiso está apagado, ni llega. El usuario lo dijo tal cual el 2026-10-04:
 * "no me entero". El correo queda en la bandeja hasta que alguien lo abre.
 *
 * ─── Idempotencia y frenos: TODO en la base ────────────────────────────────
 * Los tres BFF (dev, stg, prod) comparten UNA sola Supabase y los tres corren
 * los mismos cron. Un freno en memoria no sirve: cada proceso tiene el suyo y
 * además se pierde en cada redeploy de Render. Se usa `email_sends` (el log de
 * correos que ya existe) sin migración nueva:
 *
 *   - Cada envío RESERVA primero una fila con un `id` DETERMINÍSTICO (UUID
 *     derivado de una clave: tipo + escuela + fecha, o tipo + conversación +
 *     minuto). El PK de `email_sends` hace de candado: el segundo INSERT con
 *     el mismo id falla con 23505 y ese proceso no manda nada. Mismo patrón que
 *     la referencia `SUB-<sub>-<YYYY-MM>` del auto-cobro en maintenance.job.
 *   - `batch_id` (uuid sin FK) guarda la referencia: la conversación de
 *     WhatsApp o el ticket de soporte. Con eso se consulta el freno de 6 h.
 *   - La reserva entra como status='failed' + error='reservado: enviando' y
 *     pasa a 'sent' al confirmar Resend. Si el proceso muere entre medio, el
 *     log dice la verdad (no salió confirmado) en vez de un 'sent' falso. El
 *     CHECK de status solo admite 'sent'/'failed'.
 *
 * `email_sends` no tiene columna de metadata: la clave vive en el id y en
 * batch_id, y el detalle legible en `to_email` (todos los destinatarios de esa
 * corrida, separados por coma). Es UNA fila por envío, no por destinatario:
 * el reenvío por destinatario que motivó la tabla es de invitaciones, acá no
 * aplica.
 */

import crypto from 'crypto';
import { supabase } from '../config/supabase';

export interface AvisoEscalamiento {
    schoolId: string;
    conversationId: string;
    contactName: string | null;
    contactWaId: string;
    /** Motivo del escalamiento ('user_request', 'tool_error', 'prospecto', …). */
    motivo: string;
}

// ─── Configuración ──────────────────────────────────────────────────────────

const frontendUrl = () => (process.env.FRONTEND_URL || 'https://app.sportmaps.co').replace(/\/$/, '');

/** Buzón de SportMaps que recibe tickets nuevos y el resumen semanal. Admite varios separados por coma. */
export function correosDeSoporte(): string[] {
    const crudo = process.env.SUPPORT_ALERT_EMAIL || 'contacto@sportmaps.co';
    return [...new Set(crudo.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@')))];
}

/** Ventana del freno: un correo por conversación (o por ticket escalado) cada 6 h. */
export const FRENO_ESCALAMIENTO_MS = 6 * 3600_000;

/** Lo que el asistente atiende. Misma lista que TIPOS_FAMILIA de whatsapp-buzon. */
const TIPOS_FAMILIA = ['familia', 'familia_sin_cuenta', 'ambiguo'];

export const RESERVADO = 'reservado: enviando';

/** Una reserva que lleva más de esto sin cerrarse se da por muerta (el proceso cayó). */
const RESERVA_VIVA_MS = 10 * 60_000;

// ─── Utilidades puras ───────────────────────────────────────────────────────

/**
 * UUID determinístico (formato v5: SHA-1 sobre namespace + clave). No se usa
 * el paquete `uuid`: la v13 es solo ESM y el BFF compila a CommonJS.
 */
const NAMESPACE = Buffer.from('6f1c2a7e4b3d4e8fa1c09d2b7e5f3a10', 'hex');
export function uuidDeClave(clave: string): string {
    const h = crypto.createHash('sha1').update(NAMESPACE).update(clave, 'utf8').digest();
    h[6] = (h[6] & 0x0f) | 0x50;
    h[8] = (h[8] & 0x3f) | 0x80;
    const x = h.subarray(0, 16).toString('hex');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** '573001112233' → '+57 ••• ••• 2233'. Lo justo para reconocerlo sin regalar el número. */
export function enmascararNumero(waId: string | null | undefined): string {
    const d = String(waId ?? '').replace(/\D/g, '');
    if (d.length < 6) return 'Número oculto';
    return `+${d.slice(0, 2)} ••• ••• ${d.slice(-4)}`;
}

export function etiquetaDeContacto(nombre: string | null | undefined, waId: string | null | undefined): string {
    const n = (nombre ?? '').trim();
    return n ? `${n} (${enmascararNumero(waId)})` : enmascararNumero(waId);
}

const MOTIVOS: Record<string, string> = {
    user_request: 'La persona pidió hablar con alguien de la escuela.',
    boton_hablar_con_la_escuela: 'La persona tocó el botón «Hablar con la escuela».',
    tool_error: 'El asistente no pudo consultar la información que le pidieron.',
    llm_error: 'El asistente tuvo una falla técnica y no pudo responder.',
    prospecto: 'Pregunta por inscripciones y la escuela no tiene un enlace de inscripción activo para mandarle.',
};

/** Los motivos llegan como código ('tool_error') o como frase del bot. */
export function motivoLegible(motivo: string | null | undefined): string {
    const m = (motivo ?? '').trim();
    if (!m) return 'El asistente no pudo resolverlo.';
    if (MOTIVOS[m]) return MOTIVOS[m];
    if (/^[a-z0-9_]+$/.test(m)) return `El asistente no pudo resolverlo (${m.replace(/_/g, ' ')}).`;
    return m.length > 200 ? `${m.slice(0, 197)}…` : m;
}

/** Fecha y hora en Colombia. Bogotá no tiene horario de verano: siempre UTC-5. */
export function horaColombia(iso: string | number | Date | null | undefined): string {
    if (!iso) return '';
    return new Date(iso).toLocaleString('es-CO', {
        timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
}

/** 'YYYY-MM-DD' del día en Colombia. */
export function fechaColombia(ahora: Date | number = Date.now()): string {
    return new Date(new Date(ahora).getTime() - 5 * 3600_000).toISOString().slice(0, 10);
}

export function escaparHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const recortar = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ─── Destinatarios ──────────────────────────────────────────────────────────

/**
 * Owner + admins activos de la escuela, con correo. MISMO criterio que
 * `avisarQueEsperan` (whatsapp-bot.service): school_members activos con rol
 * owner/admin/school_admin, más schools.owner_id aparte porque el dueño puede
 * no tener fila en school_members. Se deduplica por perfil y por correo: un
 * dueño que además es admin, o dos perfiles con el mismo correo, reciben UN
 * correo, no dos.
 */
export async function destinatariosDeEscuela(schoolId: string): Promise<{ escuela: string; correos: string[] }> {
    const [{ data: escuela }, { data: miembros }] = await Promise.all([
        supabase.from('schools').select('name, owner_id').eq('id', schoolId).maybeSingle(),
        supabase.from('school_members').select('profile_id')
            .eq('school_id', schoolId).eq('status', 'active')
            .in('role', ['owner', 'admin', 'school_admin']),
    ]);

    const ids = new Set<string>();
    for (const m of (miembros ?? []) as any[]) if (m.profile_id) ids.add(m.profile_id);
    if ((escuela as any)?.owner_id) ids.add((escuela as any).owner_id);

    const nombre = (escuela as any)?.name || 'tu escuela';
    if (!ids.size) return { escuela: nombre, correos: [] };

    const { data: perfiles } = await supabase.from('profiles').select('id, email').in('id', [...ids]);
    const correos = new Set<string>();
    for (const p of (perfiles ?? []) as any[]) {
        const e = String(p.email ?? '').trim().toLowerCase();
        if (e.includes('@')) correos.add(e);
    }
    return { escuela: nombre, correos: [...correos] };
}

// ─── Reserva en email_sends (idempotencia en la base) ───────────────────────

export interface Reserva { id: string }

/**
 * Reserva el envío. Devuelve null si otra corrida ya lo reservó (23505) o si
 * no se pudo escribir: sin candado no se manda, porque el costo de un correo
 * duplicado a la dueña (tres BFF = tres correos) es mayor que el de uno que
 * no sale y que igual tiene el push y el buzón detrás.
 */
export async function reservarEnvio(p: {
    clave: string; tipo: string; schoolId: string | null; refId: string | null; destinos: string[];
}): Promise<Reserva | null> {
    const id = uuidDeClave(p.clave);
    const { error } = await supabase.from('email_sends').insert({
        id,
        school_id: p.schoolId,
        to_email: recortar(p.destinos.join(', '), 1000),
        email_type: p.tipo,
        provider: 'resend',
        status: 'failed',
        error: RESERVADO,
        batch_id: p.refId,
        attempts: 1,
    });
    if (!error) return { id };
    if ((error as any).code !== '23505') {
        console.error('[avisos-correo] no se pudo reservar el envío', { tipo: p.tipo, clave: p.clave, error: error.message });
    }
    return null;
}

export async function cerrarEnvio(reserva: Reserva, r: { ok: boolean; error?: string; messageId?: string | null }): Promise<void> {
    const { error } = await supabase.from('email_sends').update({
        status: r.ok ? 'sent' : 'failed',
        error: r.ok ? null : recortar(r.error || 'error desconocido', 1000),
        provider_message_id: r.messageId ?? null,
    }).eq('id', reserva.id);
    if (error) console.error('[avisos-correo] no se pudo cerrar la reserva', { id: reserva.id, error: error.message });
}

/**
 * ¿Ya salió (o está saliendo) un correo de este tipo para esta referencia
 * dentro de la ventana? Cuenta los 'sent' y las reservas vivas; un 'failed'
 * real no frena: si Resend falló, la escuela no se enteró y hay que reintentar
 * en la próxima escalación.
 */
export async function hayEnvioReciente(tipo: string, refId: string, ventanaMs: number, ahora = Date.now()): Promise<boolean> {
    const { data, error } = await supabase.from('email_sends')
        .select('status, error, created_at')
        .eq('email_type', tipo)
        .eq('batch_id', refId)
        .gte('created_at', new Date(ahora - ventanaMs).toISOString())
        .limit(20);
    if (error) {
        // Sin poder leer el freno, se frena: mejor un aviso menos que una ráfaga.
        console.error('[avisos-correo] no se pudo leer el freno', { tipo, refId, error: error.message });
        return true;
    }
    return ((data ?? []) as any[]).some((f) => f.status === 'sent'
        || (f.error === RESERVADO && ahora - new Date(f.created_at).getTime() < RESERVA_VIVA_MS));
}

// ─── Envío por la edge function send-email ──────────────────────────────────

export interface Respaldo {
    subject: string; titulo: string; lineas: string[]; enlace?: { url: string; texto: string };
    /** HTML ya armado (y escapado) por quien llama: reemplaza al de `lineas`. Lo usa el informe de cartera (tablas). */
    html?: string;
}

/**
 * HTML sencillo para cuando la edge function desplegada todavía no conoce la
 * plantilla (`type` desconocido → THROW → 400 y el correo no sale). Así el
 * aviso llega aunque el deploy de send-email vaya detrás del del BFF.
 */
export function htmlDeRespaldo(r: Respaldo): string {
    if (r.html) return r.html;
    const lineas = r.lineas.map((l) => `<p style="color:#4a4a4a;line-height:1.6;margin:0 0 10px;">${escaparHtml(l)}</p>`).join('');
    const boton = r.enlace
        ? `<p style="margin-top:20px;"><a href="${escaparHtml(r.enlace.url)}" style="display:inline-block;padding:12px 24px;background:#FB9F1E;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">${escaparHtml(r.enlace.texto)}</a></p>`
        : '';
    return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border-top:3px solid #248223;">`
        + `<h2 style="color:#248223;margin-top:0;">${escaparHtml(r.titulo)}</h2>${lineas}${boton}</div>`;
}

async function llamarSendEmail(body: unknown): Promise<{ ok: boolean; status: number; texto: string }> {
    const url = `${process.env.SUPABASE_URL || ''}/functions/v1/send-email`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY || ''}` },
            body: JSON.stringify(body),
        });
        return { ok: res.ok, status: res.status, texto: await res.text() };
    } catch (err: any) {
        return { ok: false, status: 0, texto: err?.message || String(err) };
    }
}

/**
 * Manda la plantilla `tipo` a todos los destinos en UNA llamada (batch de
 * Resend, hasta 100). Si la edge function viva no conoce el tipo, reintenta
 * una vez con el HTML de respaldo.
 */
export async function enviarPlantilla(
    tipo: string | null, destinos: string[], data: Record<string, string>, respaldo: Respaldo,
    opciones: { replyTo?: string } = {},
): Promise<{ ok: boolean; error?: string; messageId?: string | null }> {
    if (!destinos.length) return { ok: false, error: 'sin destinatarios' };
    const lote = destinos.slice(0, 100);
    // send-email solo acepta respuestas hacia @sportmaps.co; sin esto, contestar cae en noreply.
    const extra = opciones.replyTo ? { reply_to: opciones.replyTo } : {};

    // tipo null = sin plantilla en send-email: va directo el HTML del respaldo.
    if (tipo === null) {
        const html = htmlDeRespaldo(respaldo);
        const d = await llamarSendEmail({ batch: lote.map((to) => ({ to, subject: respaldo.subject, html, ...extra })) });
        if (!d.ok) return { ok: false, error: `send-email ${d.status}: ${d.texto}` };
        let id: string | null = null;
        try { id = JSON.parse(d.texto)?.results?.[0]?.id ?? null; } catch { /* sin id, no importa */ }
        return { ok: true, messageId: id };
    }

    let r = await llamarSendEmail({ batch: lote.map((to) => ({ type: tipo, to, data, ...extra })) });
    if (!r.ok && /no soportado/i.test(r.texto)) {
        console.warn(`[avisos-correo] send-email no conoce '${tipo}' (¿falta desplegarla?): se manda el respaldo.`);
        const html = htmlDeRespaldo(respaldo);
        r = await llamarSendEmail({ batch: lote.map((to) => ({ to, subject: respaldo.subject, html, ...extra })) });
    }
    if (!r.ok) return { ok: false, error: `send-email ${r.status}: ${r.texto}` };

    let messageId: string | null = null;
    try { messageId = JSON.parse(r.texto)?.results?.[0]?.id ?? null; } catch { /* sin id, no importa */ }
    return { ok: true, messageId };
}

/** Reserva → envía → cierra. Devuelve si salió. Nunca lanza. */
export async function enviarConReserva(p: {
    clave: string; tipo: string; schoolId: string | null; refId: string | null;
    destinos: string[]; data: Record<string, string>; respaldo: Respaldo;
    /** Plantilla de send-email, si difiere del tipo que se registra en el log. null = sin plantilla (HTML del respaldo). */
    plantilla?: string | null;
    /** A dónde llegan las respuestas. Solo @sportmaps.co (lo filtra send-email). */
    replyTo?: string;
}): Promise<'enviado' | 'duplicado' | 'fallo'> {
    const reserva = await reservarEnvio(p);
    if (!reserva) return 'duplicado';
    const r = await enviarPlantilla(p.plantilla === null ? null : (p.plantilla ?? p.tipo), p.destinos, p.data, p.respaldo, { replyTo: p.replyTo });
    await cerrarEnvio(reserva, r);
    if (!r.ok) console.error('[avisos-correo] envío fallido', { tipo: p.tipo, clave: p.clave, error: r.error });
    return r.ok ? 'enviado' : 'fallo';
}

// ─── 1. Escalamiento de WhatsApp a la escuela ───────────────────────────────

type MensajeCorto = { quien: string; texto: string; hora: string };

function textoDeMensaje(m: any): string {
    const t = String(m.text_body ?? '').trim();
    if (t) return recortar(t, 300);
    const tipos: Record<string, string> = { image: 'imagen', document: 'documento', audio: 'audio', video: 'video', sticker: 'sticker' };
    return `[${tipos[m.type] ?? m.type ?? 'mensaje'}]`;
}

async function ultimosMensajes(conversationId: string, quienEscribe: string, n = 3): Promise<MensajeCorto[]> {
    const { data } = await supabase.from('whatsapp_messages')
        .select('direction, ai_generated, text_body, type, created_at, wa_timestamp')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(n);
    return ((data ?? []) as any[]).reverse().map((m) => ({
        quien: m.direction === 'inbound' ? quienEscribe : (m.ai_generated ? 'Asistente' : 'Escuela'),
        texto: textoDeMensaje(m),
        hora: horaColombia(m.wa_timestamp ?? m.created_at),
    }));
}

/**
 * Correo a owner + admins cuando el bot pasa una conversación a una persona.
 *
 * Freno: máximo uno por conversación cada 6 h. Una familia que insiste —el
 * bot se atasca dos veces seguidas, o la conversación se cierra y se reabre
 * en la tarde— no le llena la bandeja a la dueña: el primer correo ya la
 * llevó al buzón.
 *
 * Mismo filtro que el push: si la conversación ya está clasificada y NO es
 * una familia (amigos, proveedores, el propio equipo), no se avisa. La única
 * excepción es el prospecto, que es un desconocido por definición.
 */
export async function avisarEscalamientoPorCorreo(aviso: AvisoEscalamiento): Promise<void> {
    try {
        const ahora = Date.now();
        const esProspecto = aviso.motivo === 'prospecto';

        if (!esProspecto) {
            const { data: conv } = await supabase.from('whatsapp_conversations')
                .select('contact_kind').eq('id', aviso.conversationId).maybeSingle();
            const kind = (conv as any)?.contact_kind;
            if (kind && !TIPOS_FAMILIA.includes(kind)) {
                console.info('[avisos-correo] escalado sin correo: contacto que no se atiende', { conversationId: aviso.conversationId, kind });
                return;
            }
        }

        if (await hayEnvioReciente('wa_escalamiento', aviso.conversationId, FRENO_ESCALAMIENTO_MS, ahora)) {
            console.info('[avisos-correo] escalado sin correo: ya se avisó en las últimas 6 h', { conversationId: aviso.conversationId });
            return;
        }

        const { escuela, correos } = await destinatariosDeEscuela(aviso.schoolId);
        if (!correos.length) {
            console.warn('[avisos-correo] escalado sin correo: la escuela no tiene admins con correo', { schoolId: aviso.schoolId });
            return;
        }

        const contacto = etiquetaDeContacto(aviso.contactName, aviso.contactWaId);
        const quienEscribe = aviso.contactName?.trim() || (esProspecto ? 'Prospecto' : 'Familia');
        const mensajes = await ultimosMensajes(aviso.conversationId, quienEscribe);
        const motivo = motivoLegible(aviso.motivo);
        // El buzón vive en /whatsapp (pestaña "Conversaciones"). Los parámetros
        // dejan listo el enlace directo a la conversación; mientras la página
        // no los lea, igual abre el canal correcto.
        const url = `${frontendUrl()}/whatsapp?tab=conversaciones&conversacion=${encodeURIComponent(aviso.conversationId)}`;
        const titulo = esProspecto ? `${quienEscribe} pregunta por inscripciones` : `${quienEscribe} espera respuesta`;

        await enviarConReserva({
            // Candado por minuto: dos escalaciones simultáneas de la misma
            // conversación (o dos BFF) chocan en el PK. La ventana de 6 h la
            // pone `hayEnvioReciente`.
            clave: `wa_escalamiento:${aviso.conversationId}:${Math.floor(ahora / 60_000)}`,
            tipo: 'wa_escalamiento',
            schoolId: aviso.schoolId,
            refId: aviso.conversationId,
            destinos: correos,
            data: {
                schoolName: escuela,
                contactLabel: contacto,
                titulo,
                motivo,
                esProspecto: esProspecto ? 'true' : 'false',
                mensajesJson: JSON.stringify(mensajes),
                conversationUrl: url,
            },
            respaldo: {
                subject: `${titulo} por WhatsApp — ${escuela}`,
                titulo,
                lineas: [
                    `Contacto: ${contacto}`,
                    `Motivo: ${motivo}`,
                    ...mensajes.map((m) => `${m.quien} (${m.hora}): ${m.texto}`),
                ],
                enlace: { url, texto: 'Responder en SportMaps' },
            },
        });
    } catch (err: any) {
        console.error('[avisos-correo] avisarEscalamientoPorCorreo falló', { conversationId: aviso?.conversationId, error: err?.message || String(err) });
    }
}

// ─── 3. Ticket de Mapi a SportMaps ──────────────────────────────────────

const ESTADOS_TICKET: Record<string, string> = {
    open: 'Abierto',
    bot_handled: 'Respondido por Mapi',
    waiting_human: 'Esperando a una persona',
    waiting_user: 'Esperando al usuario',
    resolved: 'Resuelto',
    closed: 'Cerrado',
};

export type OrigenTicket = 'nuevo' | 'escalado' | 'no_sirvio';

/**
 * Prefijo del asunto para filtrar en Gmail lo que necesita a una persona
 * (2026-10-27). Va en todo caso escalado, en el que el usuario marcó «No me
 * sirvió», y en el 'nuevo' que ya llegó esperando a una persona.
 */
export const PREFIJO_REVISAR = '[Revisar] ';

export function asuntoTicket(p: { origen: OrigenTicket; status?: string | null; nombre: string }): string {
    const titulo = p.origen === 'nuevo' ? 'Nuevo caso en Mapi'
        : p.origen === 'escalado' ? 'Mapi pasó un caso a una persona'
            : 'A alguien no le sirvió la respuesta de Mapi';
    const revisar = p.origen !== 'nuevo' || p.status === 'waiting_human';
    return `${revisar ? PREFIJO_REVISAR : ''}${titulo}: ${p.nombre}`;
}

/**
 * Markdown de Mapi → HTML seguro para el correo. Mapi escribe **negritas**,
 * listas numeradas y con guion, y saltos de línea; el correo los mostraba
 * crudos («**Asistencia**»). Primero se ESCAPA todo y solo después se dibujan
 * las marcas, así nada que venga del usuario o del modelo llega como HTML.
 */
export function markdownAHtml(texto: string): string {
    const linea = (s: string) => s
        .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    const bloques: string[] = [];
    let lista: { tipo: 'ul' | 'ol'; items: string[] } | null = null;
    let parrafo: string[] = [];
    const cerrarParrafo = () => {
        if (parrafo.length) bloques.push(`<p style="margin:0 0 8px;">${parrafo.map(linea).join('<br>')}</p>`);
        parrafo = [];
    };
    const cerrarLista = () => {
        if (lista) bloques.push(`<${lista.tipo} style="margin:0 0 8px;padding-left:20px;">${lista.items.map((i) => `<li>${linea(i)}</li>`).join('')}</${lista.tipo}>`);
        lista = null;
    };
    for (const cruda of escaparHtml(texto.replace(/\r\n?/g, '\n')).split('\n')) {
        const l = cruda.trim();
        const ul = /^[-*•]\s+(.+)$/.exec(l);
        const ol = /^\d+[.)]\s+(.+)$/.exec(l);
        if (ul || ol) {
            const tipo = ul ? 'ul' : 'ol';
            cerrarParrafo();
            if (lista && lista.tipo !== tipo) cerrarLista();
            if (!lista) lista = { tipo, items: [] };
            lista.items.push((ul ?? ol)![1]);
        } else if (!l) {
            cerrarParrafo();
            cerrarLista();
        } else {
            cerrarLista();
            parrafo.push(l);
        }
    }
    cerrarParrafo();
    cerrarLista();
    return bloques.join('');
}

/** HTML del correo de un ticket de Mapi (todo lo variable pasa por escaparHtml o markdownAHtml). */
export function htmlTicketSoporte(d: {
    titulo: string; nombre: string; correo: string; rol: string; escuela: string; estado: string; motivo: string;
    mensajes: MensajeCorto[]; url: string;
}): string {
    const fila = (k: string, v: string) => (v
        ? `<tr><td style="padding:8px 10px;color:#888;border-bottom:1px solid #eee;">${escaparHtml(k)}</td><td style="padding:8px 10px;font-weight:600;text-align:right;border-bottom:1px solid #eee;">${escaparHtml(v)}</td></tr>`
        : '');
    const mensajes = d.mensajes.map((m) => `<div style="background:#f6f7f6;border-left:3px solid #248223;border-radius:6px;padding:10px 12px;margin-bottom:8px;">`
        + `<div style="color:#888;font-size:12px;margin-bottom:4px;">${escaparHtml(m.quien)} · ${escaparHtml(m.hora)}</div>`
        + `<div style="color:#4a4a4a;line-height:1.5;">${markdownAHtml(m.texto)}</div></div>`).join('');
    return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border-top:3px solid #248223;">`
        + `<h2 style="color:#248223;margin-top:0;">${escaparHtml(d.titulo)}</h2>`
        + `<table style="width:100%;border-collapse:collapse;margin:16px 0;text-align:left;">`
        + fila('Usuario', d.nombre) + fila('Correo', d.correo) + fila('Rol', d.rol) + fila('Escuela', d.escuela)
        + fila('Motivo', d.motivo) + fila('Estado', d.estado)
        + `</table>${mensajes}`
        + `<p style="margin-top:20px;"><a href="${escaparHtml(d.url)}" style="display:inline-block;padding:12px 24px;background:#FB9F1E;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Abrir la bandeja de soporte</a></p></div>`;
}

/**
 * Correo a SportMaps (`SUPPORT_ALERT_EMAIL`) por un ticket de Mapi.
 *
 *  - 'nuevo': primer mensaje del ticket. Lo dispara support.routes DESPUÉS del
 *    turno del bot, así el correo ya dice si Mapi lo resolvió o lo pasó a
 *    una persona. Uno por ticket, nunca más (id determinístico por ticket).
 *  - 'escalado': Mapi lo pasó a waiting_human en un mensaje POSTERIOR. Si
 *    es el primer mensaje no se manda: el 'nuevo' sale enseguida y ya trae el
 *    estado "Esperando a una persona" (si no, serían dos correos en un segundo
 *    por el mismo caso). Freno de 6 h por ticket.
 *
 *  - 'no_sirvio': el usuario tocó «No» en «¿Te sirvió?» y el caso pasó a
 *    waiting_human. Uno por respuesta de Mapi (id determinístico por
 *    `respuestaId`), sin freno por ticket: el 'nuevo' ya salió y este es otro
 *    aviso, el que pide revisar.
 *
 * Tipo de log distinto por origen ('soporte_ticket_nuevo' /
 * 'soporte_ticket_escalado' / 'soporte_ticket_no_sirvio') para que el freno
 * del escalado no lo bloquee el correo de bienvenida de la mañana.
 *
 * El HTML se arma acá (htmlTicketSoporte) y no en la plantilla de send-email:
 * la plantilla escapaba el cuerpo y el markdown de Mapi llegaba crudo, y así
 * el arreglo sale con el deploy del BFF sin redesplegar la edge function.
 * Asunto con «[Revisar] » cuando hace falta una persona (asuntoTicket).
 */
export async function avisarTicketSoportePorCorreo(p: {
    ticketId: string; origen: OrigenTicket; motivo?: string; respuestaId?: string;
}): Promise<void> {
    try {
        const ahora = Date.now();
        const tipoLog = `soporte_ticket_${p.origen}`;

        if (p.origen === 'escalado') {
            const { count } = await supabase.from('support_messages')
                .select('id', { count: 'exact', head: true })
                .eq('ticket_id', p.ticketId).eq('author_type', 'user');
            if ((count ?? 0) <= 1) return; // lo cubre el correo de 'nuevo'
            if (await hayEnvioReciente(tipoLog, p.ticketId, FRENO_ESCALAMIENTO_MS, ahora)) return;
        }

        const destinos = correosDeSoporte();
        if (!destinos.length) return;

        const { data: ticket } = await supabase.from('support_tickets')
            .select('id, requester_id, school_id, status, category, subject, created_at')
            .eq('id', p.ticketId).maybeSingle();
        if (!ticket) return;
        const t = ticket as any;

        const [{ data: perfil }, escuelaRes, { data: msgs }] = await Promise.all([
            supabase.from('profiles').select('full_name, email, role').eq('id', t.requester_id).maybeSingle(),
            t.school_id
                ? supabase.from('schools').select('name').eq('id', t.school_id).maybeSingle()
                : Promise.resolve({ data: null as any }),
            supabase.from('support_messages')
                .select('author_type, body, created_at, internal_note')
                .eq('ticket_id', p.ticketId)
                .order('created_at', { ascending: false })
                .limit(6),
        ]);

        const per = (perfil ?? {}) as any;
        const nombre = per.full_name || per.email || 'Un usuario';
        const mensajes: MensajeCorto[] = ((msgs ?? []) as any[])
            .filter((m) => !m.internal_note)
            .slice(0, 3)
            .reverse()
            .map((m) => ({
                quien: m.author_type === 'user' ? nombre : m.author_type === 'bot' ? 'Mapi' : 'Soporte',
                texto: recortar(String(m.body ?? ''), 500),
                hora: horaColombia(m.created_at),
            }));

        const estado = ESTADOS_TICKET[t.status] ?? t.status;
        const escuela = (escuelaRes as any)?.data?.name || 'Sin escuela';
        const url = `${frontendUrl()}/admin/support`;
        const subject = asuntoTicket({ origen: p.origen, status: t.status, nombre });
        const titulo = subject.slice(0, subject.lastIndexOf(': '));
        const motivo = p.origen === 'no_sirvio'
            ? 'El usuario marcó que la respuesta de Mapi NO le sirvió.'
            : p.motivo ? motivoLegible(p.motivo) : '';

        const clave = p.origen === 'nuevo' ? `soporte_ticket_nuevo:${p.ticketId}`
            : p.origen === 'no_sirvio' ? `soporte_ticket_no_sirvio:${p.ticketId}:${p.respuestaId ?? Math.floor(ahora / 60_000)}`
                : `soporte_ticket_escalado:${p.ticketId}:${Math.floor(ahora / 60_000)}`;

        const r = await enviarConReserva({
            clave,
            tipo: tipoLog,
            plantilla: null,
            schoolId: t.school_id ?? null,
            refId: p.ticketId,
            destinos,
            data: {},
            respaldo: {
                subject,
                titulo,
                lineas: [],
                html: htmlTicketSoporte({
                    titulo, nombre, correo: per.email || '', rol: per.role || '', escuela, estado, motivo, mensajes, url,
                }),
            },
        });
        if (r === 'enviado') console.info('[avisos-correo] ticket avisado', { ticketId: p.ticketId, origen: p.origen });
    } catch (err: any) {
        console.error('[avisos-correo] avisarTicketSoportePorCorreo falló', { ticketId: p?.ticketId, error: err?.message || String(err) });
    }
}
