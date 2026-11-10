/**
 * whatsapp.service — Capa de integración con la WhatsApp Cloud API (Meta).
 *
 * Modelo Tech Provider multi-tenant (Bloque 6, decisión #1):
 *  - UN webhook (`POST /api/v1/webhooks/whatsapp`) recibe los mensajes de
 *    TODAS las escuelas.
 *  - El routing se resuelve por `phone_number_id` -> integración -> school_id.
 *  - Cada escuela conecta SU número vía Embedded Signup; su access token
 *    queda cifrado en `school_whatsapp_integrations.access_token_encrypted`.
 *
 * Seguridad:
 *  - Verificación HMAC-SHA256 del webhook sobre el RAW body (decisión arq. #2).
 *  - Token Meta cifrado en reposo con AES-256-GCM, clave en env
 *    WHATSAPP_TOKEN_ENC_KEY (32 bytes hex/base64). Rotación soportada
 *    (token_rotated_at). Honra decisión #9 (clave en env + rotación);
 *    se usa AES-GCM en Node en vez de pgcrypto porque el BFF necesita la
 *    clave en env de todos modos para llamar a Graph API.
 *
 * NUNCA exponer WHATSAPP_TOKEN_ENC_KEY ni WHATSAPP_APP_SECRET al cliente.
 */

import crypto from 'crypto';
import { supabase } from '../config/supabase';
import { enCortafuegos } from '../config/cortafuegos-simulacion';
import { aLetrasNormales } from './whatsapp-letras-decorativas';
import { aliasDeBsuid, conDestinatarioDeMeta } from './whatsapp-usuario-meta';

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ─── Tipos ──────────────────────────────────────────────────────────────────

export interface WhatsAppIntegration {
    id: string;
    school_id: string;
    phone_number_id: string;
    waba_id: string | null;
    display_phone_number: string | null;
    access_token_encrypted: string | null;
    verify_token: string | null;
    status: string;
}

// ─── Cifrado del access token (AES-256-GCM) ───────────────────────────────────

/**
 * Deriva la clave de 32 bytes desde WHATSAPP_TOKEN_ENC_KEY.
 * Acepta la clave en hex (64 chars) o base64. Si no parsea a 32 bytes,
 * la deriva con SHA-256 (permite passphrase arbitraria en dev).
 */
function getEncKey(): Buffer {
    const raw = process.env.WHATSAPP_TOKEN_ENC_KEY;
    if (!raw) {
        throw new Error('WHATSAPP_TOKEN_ENC_KEY no configurado en el BFF.');
    }
    // hex de 32 bytes
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    // base64 de 32 bytes
    try {
        const b = Buffer.from(raw, 'base64');
        if (b.length === 32) return b;
    } catch { /* sigue */ }
    // fallback: derivar de passphrase
    return crypto.createHash('sha256').update(raw).digest();
}

/** Cifra un token Meta. Formato de salida: gcm:<iv_hex>:<tag_hex>:<ciphertext_hex> */
export function encryptToken(plaintext: string): string {
    const key = getEncKey();
    const iv = crypto.randomBytes(12); // 96-bit nonce recomendado para GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `gcm:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/** Descifra un token Meta producido por encryptToken. */
export function decryptToken(encrypted: string): string {
    const key = getEncKey();
    const parts = encrypted.split(':');
    if (parts.length !== 4 || parts[0] !== 'gcm') {
        throw new Error('Formato de token cifrado inválido.');
    }
    const [, ivHex, tagHex, ctHex] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]);
    return pt.toString('utf8');
}

// ─── Verificación HMAC del webhook ────────────────────────────────────────────

/**
 * Valida la firma X-Hub-Signature-256 que Meta envía sobre el RAW body.
 * Protocolo: 'sha256=' + HMAC_SHA256(rawBody, APP_SECRET).
 * Usa comparación en tiempo constante para evitar timing attacks.
 *
 * @param rawBody  Buffer/string EXACTO recibido (no el JSON re-serializado).
 * @param signatureHeader  valor del header 'x-hub-signature-256'.
 */
export function verifyWebhookSignature(
    rawBody: Buffer | string,
    signatureHeader: string | undefined,
): boolean {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
        // Sin secret no podemos verificar — fail closed.
        return false;
    }
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
        return false;
    }
    const expected = crypto
        .createHmac('sha256', appSecret)
        .update(rawBody)
        .digest('hex');
    const received = signatureHeader.slice('sha256='.length);

    // timingSafeEqual exige buffers del mismo largo.
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(received, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// ─── Resolución de tenant (cache LRU simple) ─────────────────────────────────

interface CacheEntry { value: WhatsAppIntegration | null; expires: number; }
const TENANT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const TENANT_CACHE_MAX = 500;
const tenantCache = new Map<string, CacheEntry>();

/**
 * Resuelve la integración (escuela) por phone_number_id. Cachea 5 min.
 * Devuelve null si no existe o no está activa.
 */
export async function resolveIntegration(
    phoneNumberId: string,
): Promise<WhatsAppIntegration | null> {
    const now = Date.now();
    const cached = tenantCache.get(phoneNumberId);
    if (cached && cached.expires > now) {
        return cached.value;
    }

    const { data, error } = await supabase
        .from('school_whatsapp_integrations')
        .select('id, school_id, phone_number_id, waba_id, display_phone_number, access_token_encrypted, verify_token, status')
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle();

    const value: WhatsAppIntegration | null =
        error || !data || data.status !== 'active' ? null : (data as WhatsAppIntegration);

    // Evicción simple por tamaño (LRU aproximado: borra el primero insertado).
    if (tenantCache.size >= TENANT_CACHE_MAX) {
        const firstKey = tenantCache.keys().next().value;
        if (firstKey !== undefined) tenantCache.delete(firstKey);
    }
    tenantCache.set(phoneNumberId, { value, expires: now + TENANT_CACHE_TTL_MS });
    return value;
}

/** Invalida el cache de un número (llamar al conectar/desconectar/suspender). */
export function invalidateTenantCache(phoneNumberId?: string): void {
    if (phoneNumberId) tenantCache.delete(phoneNumberId);
    else tenantCache.clear();
}

// ─── Envío de mensajes (Graph API) ────────────────────────────────────────────

export interface SendTextResult {
    ok: boolean;
    waMessageId?: string;
    error?: string;
}

/**
 * Envía un mensaje de texto al contacto vía Cloud API.
 * Requiere que la integración tenga access_token_encrypted válido.
 *
 * Nota Meta: fuera de la ventana de servicio de 24h solo se permiten
 * plantillas aprobadas (sendTemplate). Para respuestas dentro de la ventana
 * (el contacto escribió en <24h) el texto libre está permitido.
 */
export async function sendTextMessage(
    integration: WhatsAppIntegration,
    toWaId: string,
    text: string,
): Promise<SendTextResult> {
    return postearMensaje(integration, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toWaId,
        type: 'text',
        text: { preview_url: false, body: text },
    });
}

/**
 * El POST a /messages que comparten el texto y los botones: descifrar el
 * token, mandar, y traducir la respuesta de Graph a `SendTextResult`. No lanza.
 */
async function postearMensaje(
    integration: WhatsAppIntegration,
    payload: Record<string, unknown>,
): Promise<SendTextResult> {
    // Turno simulado (modo pruebas del canal de plataforma): nada sale por
    // Graph, tampoco por el número de la escuela. La guardia de fetch ya lo
    // corta; esto lo dice explícito y sin red.
    if (enCortafuegos()) return { ok: false, error: 'simulacion' };
    if (!integration.access_token_encrypted) {
        return { ok: false, error: 'integration_without_token' };
    }
    let token: string;
    try {
        token = decryptToken(integration.access_token_encrypted);
    } catch {
        return { ok: false, error: 'token_decrypt_failed' };
    }

    try {
        const res = await fetch(`${GRAPH_BASE_URL}/${integration.phone_number_id}/messages`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            // Contacto sin teléfono (alias del BSUID): Meta pide `recipient` en vez de `to`.
            body: JSON.stringify(conDestinatarioDeMeta(payload)),
        });

        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) {
            return { ok: false, error: json?.error?.message || `graph_${res.status}` };
        }
        return { ok: true, waMessageId: json?.messages?.[0]?.id };
    } catch (err: any) {
        return { ok: false, error: err?.message || 'network_error' };
    }
}

/**
 * Manda un payload ya armado (plantilla, texto) por la integración dada. Lo usa
 * el canal de plataforma (plataforma-wa.service) para las plantillas: el mismo
 * POST, el mismo descifrado, la misma traducción de errores. No lanza.
 */
export async function sendRawPayload(
    integration: WhatsAppIntegration,
    payload: Record<string, unknown>,
): Promise<SendTextResult> {
    return postearMensaje(integration, payload);
}

// ─── Botones de respuesta rápida (interactive / button) ─────────────────────

/**
 * Un botón de respuesta rápida. Cuando el contacto lo toca, el webhook trae
 * `interactive.button_reply.id` con este mismo `id`: es lo que el bot usa para
 * decidir SIN modelo (ver `accionDeBoton` en whatsapp-bot.service).
 */
export interface BotonInteractivo {
    id: string;
    title: string;
    /**
     * Solo listas (`interactive.type='list'`): línea gris debajo del título
     * (≤ 72) y la sección donde va la fila (≤ 24, p. ej. el día). Un mensaje
     * con más de 3 opciones, o con alguna que traiga `seccion`, sale como lista.
     */
    descripcion?: string;
    seccion?: string;
}

/** Límites de Meta para `interactive.type='button'`. Pasarlos es un 400. */
export const MAX_BOTONES = 3;
export const MAX_TITULO_BOTON = 20;
export const MAX_ID_BOTON = 256;
export const MAX_CUERPO_INTERACTIVO = 1024;

/**
 * Arma el payload de Graph para un mensaje con botones. Pura, para poder
 * probar la forma exacta sin red.
 *
 * Devuelve null si no se puede mandar como botones (sin botones o cuerpo de
 * más de 1024 caracteres): quien llama cae al texto plano, que siempre sale.
 * Lo que pasa de los límites se RECORTA en vez de fallar: un título de 21
 * caracteres es un 400 de Meta y el acudiente se queda sin respuesta, y un
 * título recortado se sigue entendiendo.
 */
export function payloadDeBotones(
    toWaId: string,
    body: string,
    botones: BotonInteractivo[],
    opts: { imagenUrl?: string | null } = {},
): Record<string, unknown> | null {
    const validos = botones
        .filter((b) => b && b.id && b.title)
        .slice(0, MAX_BOTONES)
        .map((b) => ({
            type: 'reply',
            reply: {
                id: b.id.slice(0, MAX_ID_BOTON),
                title: Array.from(b.title.trim()).slice(0, MAX_TITULO_BOTON).join(''),
            },
        }));
    if (!validos.length || !body || body.length > MAX_CUERPO_INTERACTIVO) return null;

    return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toWaId,
        type: 'interactive',
        interactive: {
            type: 'button',
            // Encabezado con foto (ficha de un servicio en venta): la foto, el
            // texto y los botones salen en UN mensaje. Solo URLs https.
            ...(esUrlDeImagen(opts.imagenUrl) ? { header: { type: 'image', image: { link: opts.imagenUrl } } } : {}),
            body: { text: body },
            action: { buttons: validos },
        },
    };
}

/** ¿Sirve como `link` de una imagen para Meta? Solo https. */
function esUrlDeImagen(url: string | null | undefined): url is string {
    return typeof url === 'string' && /^https:\/\/\S+$/i.test(url.trim());
}

/**
 * Envía un mensaje con hasta 3 botones de respuesta rápida.
 *
 * Con MÁS de 3 opciones (o alguna con `seccion`) sale como LISTA interactiva
 * (hasta 10 filas): así quien llama no cambia y el embudo `deliver` del bot
 * no necesita otro camino. Antes lo que pasaba de 3 se recortaba en silencio.
 *
 * Igual que el texto libre, solo vale dentro de la ventana de 24 h. No lanza:
 * si el mensaje no cabe devuelve `{ ok: false }` y el que llama manda el texto
 * plano (que debe traer las opciones numeradas).
 */
export async function sendInteractiveButtons(
    integration: WhatsAppIntegration,
    toWaId: string,
    body: string,
    botones: BotonInteractivo[],
    opts: { imagenUrl?: string | null } = {},
): Promise<SendTextResult> {
    // La lista no admite foto en el encabezado: sale sin ella.
    if (debeIrComoLista(botones)) return sendList(integration, toWaId, body, botones);
    const payload = payloadDeBotones(toWaId, body, botones, opts);
    if (!payload) return { ok: false, error: 'no_cabe_como_botones' };
    return postearMensaje(integration, payload);
}

// ─── Lista interactiva (interactive / list) ─────────────────────────────────

/** Límites de Meta para `interactive.type='list'`. Pasarlos es un 400. */
export const MAX_FILAS_LISTA = 10;
export const MAX_SECCIONES_LISTA = 10;
export const MAX_TITULO_FILA = 24;
export const MAX_DESCRIPCION_FILA = 72;
export const MAX_TITULO_SECCION = 24;
export const MAX_ID_FILA = 200;
export const MAX_CUERPO_LISTA = 4096;
export const TEXTO_BOTON_LISTA = 'Ver opciones';

/** ¿Estas opciones van como lista y no como botones? */
export function debeIrComoLista(opciones: BotonInteractivo[]): boolean {
    const validas = (opciones ?? []).filter((b) => b && b.id && b.title);
    return validas.length > MAX_BOTONES || validas.some((b) => !!b.seccion);
}

const recortar = (t: string, max: number) => Array.from(String(t ?? '').trim()).slice(0, max).join('');

/**
 * Payload de Graph para una lista (`interactive.type='list'`). Pura. Agrupa
 * las filas por `seccion` en el orden en que aparecen (sin sección → una sola
 * sección «Opciones»). Recorta a los límites de Meta en vez de fallar. null si
 * no hay filas o el cuerpo no cabe: quien llama manda el texto plano.
 * El webhook devuelve `interactive.list_reply.id` = el `id` de la fila.
 */
export function payloadDeLista(
    toWaId: string,
    body: string,
    filas: BotonInteractivo[],
    textoBoton: string = TEXTO_BOTON_LISTA,
): Record<string, unknown> | null {
    const validas = (filas ?? []).filter((b) => b && b.id && b.title).slice(0, MAX_FILAS_LISTA);
    if (!validas.length || !body || body.length > MAX_CUERPO_LISTA) return null;
    const secciones: { title: string; rows: any[] }[] = [];
    for (const f of validas) {
        const titulo = recortar(f.seccion || 'Opciones', MAX_TITULO_SECCION);
        let sec = secciones.find((s) => s.title === titulo);
        if (!sec) {
            if (secciones.length >= MAX_SECCIONES_LISTA) sec = secciones[secciones.length - 1];
            else { sec = { title: titulo, rows: [] }; secciones.push(sec); }
        }
        const fila: Record<string, string> = { id: f.id.slice(0, MAX_ID_FILA), title: recortar(f.title, MAX_TITULO_FILA) };
        if (f.descripcion) fila.description = recortar(f.descripcion, MAX_DESCRIPCION_FILA);
        sec.rows.push(fila);
    }
    return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toWaId,
        type: 'interactive',
        interactive: {
            type: 'list',
            body: { text: body },
            action: { button: recortar(textoBoton || TEXTO_BOTON_LISTA, MAX_TITULO_BOTON), sections: secciones },
        },
    };
}

/** Envía una lista interactiva (≤ 10 filas). Solo dentro de la ventana de 24 h. No lanza. */
export async function sendList(
    integration: WhatsAppIntegration,
    toWaId: string,
    body: string,
    filas: BotonInteractivo[],
    textoBoton: string = TEXTO_BOTON_LISTA,
): Promise<SendTextResult> {
    const payload = payloadDeLista(toWaId, body, filas, textoBoton);
    if (!payload) return { ok: false, error: 'no_cabe_como_lista' };
    return postearMensaje(integration, payload);
}

// ─── Botón con enlace (interactive / cta_url) ───────────────────────────────

/**
 * Payload de Graph para un mensaje con UN botón que abre una URL
 * (`interactive.type='cta_url'`). Pura. null si no cabe (cuerpo > 1024, URL
 * que no es https, texto vacío): quien llama manda el texto plano.
 */
export function payloadDeCtaUrl(
    toWaId: string,
    body: string,
    textoBoton: string,
    url: string,
): Record<string, unknown> | null {
    const display = Array.from(String(textoBoton || '').trim()).slice(0, MAX_TITULO_BOTON).join('');
    if (!body || body.length > MAX_CUERPO_INTERACTIVO || !display || !/^https:\/\/\S+$/i.test(url || '')) return null;
    return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toWaId,
        type: 'interactive',
        interactive: {
            type: 'cta_url',
            body: { text: body },
            action: { name: 'cta_url', parameters: { display_text: display, url } },
        },
    };
}

/** Envía un mensaje con un botón URL. Solo dentro de la ventana de 24 h. No lanza. */
export async function sendCtaUrl(
    integration: WhatsAppIntegration,
    toWaId: string,
    body: string,
    textoBoton: string,
    url: string,
): Promise<SendTextResult> {
    const payload = payloadDeCtaUrl(toWaId, body, textoBoton, url);
    if (!payload) return { ok: false, error: 'no_cabe_como_cta_url' };
    return postearMensaje(integration, payload);
}

// ─── Imagen (type: image) ────────────────────────────────────────────────────

/** Límite de Meta para el pie de una imagen. */
export const MAX_PIE_IMAGEN = 1024;

/**
 * Payload de Graph para una imagen por URL con pie (`type: 'image'`). Pura.
 * null si no cabe (URL que no es https o pie de más de 1024 caracteres): quien
 * llama manda el texto plano, que siempre sale. Se usa para la ficha de un
 * servicio en venta (docs/specs/ventas-por-whatsapp.md §4.2): la foto con el
 * texto de la ficha como pie, en UN mensaje.
 */
export function payloadDeImagen(
    toWaId: string,
    url: string,
    caption?: string | null,
): Record<string, unknown> | null {
    if (!esUrlDeImagen(url)) return null;
    const pie = (caption ?? '').trim();
    if (pie.length > MAX_PIE_IMAGEN) return null;
    return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toWaId,
        type: 'image',
        image: pie ? { link: url.trim(), caption: pie } : { link: url.trim() },
    };
}

/**
 * Envía una imagen (por URL pública) con su pie. Solo dentro de la ventana de
 * 24 h. No lanza: si no cabe o Meta la rechaza devuelve `{ ok: false }` y
 * quien llama manda el pie como texto plano.
 */
export async function sendImage(
    integration: WhatsAppIntegration,
    toWaId: string,
    url: string,
    caption?: string | null,
): Promise<SendTextResult> {
    const payload = payloadDeImagen(toWaId, url, caption);
    if (!payload) return { ok: false, error: 'no_cabe_como_imagen' };
    return postearMensaje(integration, payload);
}

/**
 * Traduce Markdown estandar al formato de WhatsApp.
 *
 * WhatsApp usa UN asterisco para negrita (*asi*), no dos. Un LLM entrenado en
 * Markdown escribe `**Concepto:**` por defecto y al acudiente le llegan los
 * asteriscos literales. Visto el 2026-09-11 en una respuesta real.
 *
 * Se hace por conversion y no solo pidiendoselo al prompt: una instruccion es
 * una sugerencia, esto es una garantia. El prompt igual lo pide, para que el
 * modelo no gaste tokens en algo que despues hay que deshacer.
 */
export function aFormatoWhatsApp(texto: string): string {
    return texto
        // **negrita** y __negrita__ -> *negrita*
        .replace(/\*\*(.+?)\*\*/gs, '*$1*')
        .replace(/__(.+?)__/gs, '*$1*')
        // Encabezados de Markdown: WhatsApp no los tiene.
        //
        // Se limpia el texto ANTES de envolverlo. Sin esto, `### **Titulo**`
        // pasaba por la regla de negrita, quedaba `### *Titulo*`, y esta lo
        // envolvia otra vez: `**Titulo**`. Y el doble asterisco en WhatsApp no
        // es negrita — se ve literal, que es el bug que ya habiamos corregido
        // una vez y volvio por el orden de las reglas.
        .replace(/^#{1,6}\s*(.+)$/gm, (_m, t) => `*${String(t).replace(/^\*+|\*+$/g, '').trim()}*`)
        // Separadores horizontales: el modelo los usa para dar estructura y
        // WhatsApp los muestra tal cual, como tres guiones sueltos.
        .replace(/^\s*([-*_]){2,}\s*$/gm, '')
        // [texto](url) -> texto (url), que es lo unico que WhatsApp puede mostrar
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')
        // Vinetas de Markdown a un caracter que WhatsApp no interpreta
        .replace(/^\s*[-*]\s+/gm, '• ');
}

// ─── Estados de entrega (y lo que Meta cobra) ────────────────────────────────

/**
 * Un evento `statuses` del webhook: lo que le paso a un mensaje que enviamos.
 *
 * Llega por el MISMO campo suscrito que los mensajes entrantes (`messages`), asi
 * que no hay nada que configurar en Meta: ya estaba entrando y se descartaba.
 */
export interface ParsedStatus {
    phoneNumberId: string;
    /** El wa_message_id del SALIENTE al que se refiere. */
    waMessageId: string;
    /** sent | delivered | read | failed */
    status: string;
    recipientWaId: string | null;
    timestamp: string;
    /** Lo dice Meta, que es quien cobra. null si el evento no trae `pricing`. */
    billable: boolean | null;
    pricingCategory: string | null;
    /** El bloque `pricing` crudo: su forma ya cambio una vez y volvera a cambiar. */
    pricingRaw: any | null;
    errorDetail: string | null;
    /** Código de Meta del primer error (131026 = no se pudo entregar; el formulario sigue por chat). */
    errorCode: number | null;
}

export function parseStatuses(body: any): ParsedStatus[] {
    const out: ParsedStatus[] = [];
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
            const value = change?.value;
            if (!value || change?.field !== 'messages') continue;
            const phoneNumberId: string = value?.metadata?.phone_number_id || '';
            const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
            for (const st of statuses) {
                const pricing = st?.pricing ?? null;
                const epoch = Number(st?.timestamp || 0);
                const errores = Array.isArray(st?.errors) ? st.errors : [];
                out.push({
                    phoneNumberId,
                    waMessageId: st?.id || '',
                    // `played` (escucharon la nota de voz) no está en el CHECK de
                    // whatsapp_messages.status: para el medidor es una lectura.
                    status: st?.status === 'played' ? 'read' : (st?.status || 'unknown'),
                    recipientWaId: st?.recipient_id ?? aliasDeBsuid(st?.recipient_user_id) ?? null,
                    timestamp: epoch ? new Date(epoch * 1000).toISOString() : new Date().toISOString(),
                    // `billable` puede venir ausente; no se asume false, que
                    // reportaria de menos lo que se le paga a Meta.
                    billable: typeof pricing?.billable === 'boolean' ? pricing.billable : null,
                    pricingCategory: pricing?.category ?? null,
                    pricingRaw: pricing,
                    errorDetail: errores.length
                        ? String(errores[0]?.title ?? errores[0]?.message ?? errores[0]?.code ?? '').slice(0, 300)
                        : null,
                    errorCode: errores.length && Number.isFinite(Number(errores[0]?.code)) ? Number(errores[0].code) : null,
                });
            }
        }
    }
    return out;
}

// ─── Bajada de archivos (comprobantes) ───────────────────────────────────────

export interface MediaDownloadResult {
    ok: boolean;
    /** contenido en base64, listo para extractReceipt() */
    base64?: string;
    /** el binario tal cual (audio para transcribir: no tiene sentido pasarlo a base64) */
    buffer?: Buffer;
    mimeType?: string;
    /** sha256 que reporta Meta; sirve para detectar el mismo comprobante repetido */
    sha256?: string;
    sizeBytes?: number;
    error?: string;
}

/**
 * Lo que se acepta como comprobante. Todo lo demás se rechaza ANTES de bajarlo:
 * un video de 50 MB no tiene por qué pasar por la red ni por el OCR.
 */
const MEDIA_MIME_PERMITIDOS = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
]);
const MEDIA_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Notas de voz y audios reenviados (spec whatsapp-notas-de-voz §3.5). WhatsApp
 * limita el audio a 16 MB. Se bajan a memoria para transcribir y se descartan:
 * nunca van a Storage.
 */
export const AUDIO_MIME_PERMITIDOS: ReadonlySet<string> = new Set([
    'audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/webm', 'audio/amr',
]);
export const AUDIO_MAX_BYTES = 16 * 1024 * 1024;

export interface OpcionesDescarga {
    /** mimes aceptados (por defecto, los de comprobante) */
    mimes?: ReadonlySet<string>;
    /** tope en bytes (por defecto 8 MB) */
    maxBytes?: number;
}

/**
 * Baja un archivo que el padre mandó por WhatsApp. Son DOS saltos:
 *
 *   1. GET /{media_id}  → devuelve { url, mime_type, sha256, file_size }
 *   2. GET esa url      → el binario
 *
 * La trampa está en el paso 2: esa URL es temporal y **exige el header de
 * autorización igual que el paso 1**. Sin él responde 401, y como la URL
 * "parece" pública es el error natural al implementarlo.
 *
 * No lanza: devuelve `{ ok: false, error }`, igual que sendTextMessage.
 */
export async function downloadMedia(
    integration: WhatsAppIntegration,
    mediaId: string,
    opciones: OpcionesDescarga = {},
): Promise<MediaDownloadResult> {
    const mimesPermitidos = opciones.mimes ?? MEDIA_MIME_PERMITIDOS;
    const maxBytes = opciones.maxBytes ?? MEDIA_MAX_BYTES;
    if (!integration.access_token_encrypted) {
        return { ok: false, error: 'integration_without_token' };
    }
    let token: string;
    try {
        token = decryptToken(integration.access_token_encrypted);
    } catch {
        return { ok: false, error: 'token_decrypt_failed' };
    }

    try {
        // 1. Metadatos
        const metaRes = await fetch(`${GRAPH_BASE_URL}/${mediaId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const meta: any = await metaRes.json().catch(() => ({}));
        if (!metaRes.ok) {
            return { ok: false, error: meta?.error?.message || `graph_media_${metaRes.status}` };
        }

        const mimeType: string = String(meta?.mime_type || '').split(';')[0].trim();
        const declarado = Number(meta?.file_size || 0);

        if (!mimesPermitidos.has(mimeType)) {
            return { ok: false, error: `mime_no_soportado:${mimeType || 'desconocido'}` };
        }
        if (declarado > maxBytes) {
            return { ok: false, error: `archivo_muy_grande:${declarado}` };
        }
        if (!meta?.url) {
            return { ok: false, error: 'media_sin_url' };
        }

        // 2. El binario. El header de autorización es obligatorio también aquí.
        const binRes = await fetch(String(meta.url), {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!binRes.ok) {
            return { ok: false, error: `descarga_${binRes.status}` };
        }
        const buf = Buffer.from(await binRes.arrayBuffer());

        // Se vuelve a medir: el file_size declarado no es de fiar.
        if (buf.byteLength > maxBytes) {
            return { ok: false, error: `archivo_muy_grande:${buf.byteLength}` };
        }

        return {
            ok: true,
            base64: buf.toString('base64'),
            buffer: buf,
            mimeType,
            sha256: meta?.sha256 ? String(meta.sha256) : undefined,
            sizeBytes: buf.byteLength,
        };
    } catch (err: any) {
        return { ok: false, error: err?.message || 'network_error' };
    }
}

/**
 * Marca un mensaje entrante como leído (check azul). Best-effort, no bloquea.
 */
export async function markAsRead(
    integration: WhatsAppIntegration,
    waMessageId: string,
): Promise<void> {
    if (enCortafuegos()) return;
    if (!integration.access_token_encrypted) return;
    let token: string;
    try {
        token = decryptToken(integration.access_token_encrypted);
    } catch {
        return;
    }
    try {
        await fetch(`${GRAPH_BASE_URL}/${integration.phone_number_id}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: waMessageId,
            }),
        });
    } catch {
        /* best-effort */
    }
}

// ─── Helpers de parsing del payload entrante ─────────────────────────────────

export interface ParsedInboundMessage {
    phoneNumberId: string;
    contactWaId: string;
    contactName: string | null;
    /**
     * Nombre de usuario de WhatsApp (`contacts[].profile.username`), sin arroba.
     * Solo viene si la persona adoptó uno. Si además `contactWaId` es un alias
     * (ver whatsapp-usuario-meta), el contacto no tiene teléfono visible.
     */
    contactUsername?: string | null;
    waMessageId: string;
    type: string;
    textBody: string | null;
    waTimestamp: string;       // ISO
    /** id del archivo en Meta (image/document/audio/video). Hay que bajarlo aparte. */
    mediaId: string | null;
    /** mime que reporta Meta en el webhook (el definitivo viene al bajar el archivo). */
    mediaMimeType: string | null;
    /** texto que el usuario escribió junto a la imagen, si lo hubo. */
    mediaCaption: string | null;
    /**
     * id del botón que tocó (`interactive.button_reply.id`, `list_reply.id`, o
     * `button.payload` de una plantilla). `textBody` sigue siendo el TÍTULO
     * —es lo que el buzón muestra—, pero la decisión se toma con el id: el
     * título es texto para personas y puede cambiar; el id no.
     */
    botonId?: string | null;
    raw: any;
}

/** Los tipos que admite el CHECK `whatsapp_messages_type_check`. */
const TIPOS_GUARDABLES = new Set([
    'text', 'image', 'audio', 'video', 'document', 'sticker', 'location',
    'interactive', 'button', 'template', 'system', 'unsupported',
]);

/**
 * Extrae los mensajes entrantes de un payload de webhook de WhatsApp.
 * Un payload puede traer varias entries/changes/messages.
 */
export function parseInboundMessages(body: any): ParsedInboundMessage[] {
    const out: ParsedInboundMessage[] = [];
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
            const value = change?.value;
            if (!value || change?.field !== 'messages') continue;
            const phoneNumberId: string = value?.metadata?.phone_number_id || '';
            const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
            const nameByWaId: Record<string, string> = {};
            // Quien usa nombre de usuario y no comparte teléfono llega sin `wa_id`:
            // su contacto viene llaveado por `user_id` (ver whatsapp-usuario-meta).
            const nameByUserId: Record<string, string> = {};
            const usuarioByUserId: Record<string, string> = {};
            for (const c of contacts) {
                if (c?.wa_id) nameByWaId[c.wa_id] = c?.profile?.name || '';
                if (c?.user_id) {
                    nameByUserId[c.user_id] = c?.profile?.name || '';
                    if (c?.profile?.username) usuarioByUserId[c.user_id] = String(c.profile.username);
                }
            }
            const messages = Array.isArray(value?.messages) ? value.messages : [];
            for (const m of messages) {
                // Una reacción (👍 a un mensaje) no es un mensaje nuevo: no se guarda ni se contesta.
                if (m?.type === 'reaction') continue;
                // Lo que no está en el CHECK de whatsapp_messages.type (contacts, order…)
                // entra como 'unsupported': antes reventaba la ingesta y el mensaje
                // no existía para nadie (17 en 24 h, auditoría 2026-10-28, C-01).
                // El tipo original queda en `raw.type`.
                const type: string = TIPOS_GUARDABLES.has(m?.type) ? m.type : 'unsupported';
                let textBody: string | null = null;
                let botonId: string | null = null;
                // Versalitas («ᴍɪʟᴇ») y letras matemáticas a letras normales: si no, ninguna
                // regla del bot las lee. El original queda en `raw`.
                if (type === 'text') textBody = aLetrasNormales(m?.text?.body ?? null);
                else if (type === 'button') {
                    textBody = m?.button?.text ?? null;
                    botonId = m?.button?.payload ?? null;
                } else if (type === 'interactive') {
                    // Formulario terminado (WhatsApp Flows, `nfm_reply`): no trae título; el
                    // buzón muestra esto y el contenido va en `raw.interactive.nfm_reply`.
                    textBody = m?.interactive?.button_reply?.title
                        || m?.interactive?.list_reply?.title
                        || (m?.interactive?.type === 'nfm_reply' ? 'Formulario enviado' : null)
                        || null;
                    botonId = m?.interactive?.button_reply?.id
                        || m?.interactive?.list_reply?.id
                        || null;
                }
                // Los tipos con archivo traen el id del media en su propio nodo
                // (m.image.id, m.document.id…), no en un campo común.
                const mediaNode = m?.[type];
                const conArchivo = ['image', 'document', 'audio', 'video', 'sticker'].includes(type);
                const mediaId: string | null = conArchivo ? (mediaNode?.id ?? null) : null;
                const mediaMimeType: string | null = conArchivo ? (mediaNode?.mime_type ?? null) : null;
                const mediaCaption: string | null = conArchivo ? aLetrasNormales(mediaNode?.caption ?? null) : null;

                const epoch = Number(m?.timestamp || 0);
                // Sin `from` pero con `from_user_id`: contacto con nombre de usuario. Entra
                // con el alias del BSUID; antes se descartaba y nadie le contestaba.
                const sinTelefono = !m?.from && !!m?.from_user_id;
                const userId: string | null = m?.from_user_id ? String(m.from_user_id) : null;
                out.push({
                    phoneNumberId,
                    contactWaId: m?.from || (sinTelefono ? aliasDeBsuid(userId) : null) || '',
                    contactName: (sinTelefono ? nameByUserId[userId!] : nameByWaId[m?.from]) || null,
                    contactUsername: (userId && usuarioByUserId[userId]) || null,
                    waMessageId: m?.id || '',
                    type,
                    textBody,
                    waTimestamp: epoch ? new Date(epoch * 1000).toISOString() : new Date().toISOString(),
                    mediaId,
                    mediaMimeType,
                    mediaCaption,
                    botonId,
                    raw: m,
                });
            }
        }
    }
    return out;
}
