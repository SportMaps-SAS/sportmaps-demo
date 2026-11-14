/**
 * whatsapp-seguimiento-conversaciones — la lista de seguimiento: por conversación,
 * quién escribió, de qué, si respondió la escuela, si respondió el bot, quién quedó
 * esperando y desde cuándo, si se mandaron los datos de pago, si llegó comprobante,
 * el cobro y las preguntas que el bot le pasó a la escuela y nadie contestó.
 *
 * Por qué existe (Monster, clínica de armadores, 2026-11-08): el bot le pasó 12
 * preguntas a la escuela y 6 nunca tuvieron respuesta; nadie se enteró, porque no
 * había dónde verlo. Pedido del usuario: «una lista de quién escribió, Iván
 * respondió, el bot respondió» (docs/specs/whatsapp-ventas-de-servicio-blindaje.md
 * §4.E, falla F8, regla 7).
 *
 * Dos partes:
 *   · `armarSeguimiento` y compañía: PURAS (se prueban sin base).
 *   · `seguimientoDeConversaciones`: la lectura. Regla de Disk IO (CLAUDE.md): UNA
 *     consulta por cosa (conversaciones, mensajes, pagos, cola de comprobantes,
 *     leads) con columnas mínimas y tope; nada de N+1. Los mensajes se piden por
 *     `conversation_id` (índice `(conversation_id, created_at)`), partidos en trozos
 *     solo por el largo de la URL y paginados de a 1000 (el tope de PostgREST).
 *
 * Quién escribió cada saliente (mismo criterio que `esHumanoDeLaEscuela`):
 *   · Bot: `ai_generated=true`, y las respuestas automáticas a los botones de una
 *     campaña (`payload.step` que empieza por `campana_`): le contestan a la persona.
 *   · Campaña: la plantilla de la campaña (`type='template'`, `step='campana'`).
 *   · Escuela: una persona de la escuela, desde el celular (echo de Coexistence) o
 *     el buzón: `ai_generated=false`, no plantilla, sin `payload.automatico`; o
 *     cualquier envío con `payload.manual` (plantilla mandada a mano desde el buzón).
 *   · Automático: el resto de lo automático (saludo automático de WhatsApp Business,
 *     recordatorios de la app, plantillas de cobro). No cuenta como respuesta.
 */
import { supabase } from '../config/supabase';
import { normalizarFrase, VOCATIVOS_GENERICOS, type FilaReciente } from './whatsapp-reglas-turno';
import { esCierreDeCortesia } from './whatsapp-desconocido-reglas';
import { TIPOS_MARCADOS } from './whatsapp-tipo-contacto';
import { serviciosDeAnuncio, type ItemConFicha } from './whatsapp-anuncio-destino';
import { MARCA_VENTA, ventaActiva } from './whatsapp-venta-contexto';
import { esAliasDeUsuario } from './whatsapp-usuario-meta';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type Autor = 'persona' | 'escuela' | 'bot' | 'campana' | 'automatico';
export type TipoTema = 'servicio' | 'clase_prueba' | 'familia' | 'otro';

export interface ConversacionSeg {
    id: string;
    contact_wa_id: string;
    contact_name?: string | null;
    contact_kind?: string | null;
    parent_id?: string | null;
    tomada_por?: string | null;
}

/** Un mensaje con columnas mínimas: del payload solo las marcas (ver `CAMPOS_PAYLOAD`). */
export interface MensajeSeg extends FilaReciente {
    conversation_id: string;
    status?: string | null;
}

export interface PagoSeg {
    id: string;
    amount: number | string | null;
    status: string;
    payment_category?: string | null;
    concept?: string | null;
    signup_lead_id?: string | null;
    created_at: string;
}

export interface ComprobanteSeg {
    wa_phone_number: string;
    message_type: string;
    status: string;
    result_type?: string | null;
    result_ref_id?: string | null;
    created_at: string;
}

export interface LeadSeg {
    id: string;
    phone: string | null;
    full_name?: string | null;
    status?: string | null;
    trial_slot_id?: string | null;
    cupo_separado_slot_id?: string | null;
    /** `source_detail.servicio_interes.id` */
    servicio?: string | null;
    created_at?: string | null;
}

export interface FilaSeguimiento {
    conversacionId: string;
    contacto: { nombre: string | null; telefono: string };
    tipoContacto: string | null;
    tema: { tipo: TipoTema; servicioId: string | null; nombre: string };
    primerMensaje: { fecha: string; texto: string };
    ultimoMensaje: { fecha: string; de: Autor; texto: string };
    mensajes: { persona: number; escuela: number; bot: number };
    respondioEscuela: boolean;
    respondioBot: boolean;
    /** Si lo último que importa es de la persona: desde cuándo espera (ISO). */
    esperandoDesde: string | null;
    esperandoMin: number | null;
    datosDePagoEnviados: boolean;
    comprobanteRecibido: boolean;
    comprobantes: number;
    comprobanteEstado: string | null;
    cobro: { monto: number; estado: string; tipo: string | null; concepto: string; fecha: string; cuantos: number } | null;
    /** Preguntas que el bot le pasó a la escuela sin un mensaje de la escuela después. */
    pendientesEscuela: { texto: string; desde: string }[];
    /** Rojo en la pantalla: espera > 2 h o tiene pendientes de la escuela. */
    alerta: boolean;
    tomada: boolean;
}

export interface ResumenSeguimiento {
    escribieron: number;
    respondioEscuela: number;
    respondioBot: number;
    /** Nadie de la escuela ni el bot le contestó en el rango. */
    nadieRespondio: number;
    /** Esperando respuesta o con pendientes de la escuela. */
    sinResponder: number;
    esperandoMas2h: number;
    conPendientes: number;
    conDatosDePago: number;
    conComprobante: number;
    conCobro: number;
}

// ─── Reglas puras ────────────────────────────────────────────────────────────

/** Minutos de espera a partir de los cuales la fila sale en rojo. */
export const ALERTA_ESPERA_MIN = 120;
export const TEXTO_CORTO = 140;

const momento = (f: FilaReciente) => new Date(f.wa_timestamp || f.created_at || 0).getTime();
const verdadero = (v: unknown) => v === true || v === 'true';
const texto = (f: FilaReciente) => String(f.text_body ?? '').trim();

/** Tipos que no son un mensaje de nadie (reacciones, avisos del sistema). */
const TIPOS_RUIDO = new Set(['reaction', 'system', 'ephemeral']);
/**
 * `type='unsupported'` mezcla cosas (medido en Monster, 7 días): ediciones y
 * mensajes borrados (ruido) con mensajes reales que Meta no deja leer («This
 * message is unavailable», encuestas, fotos de una sola vista, multimedia mandada
 * desde el celular). Lo distingue `payload.type`.
 */
const TIPOS_META_RUIDO = new Set(['edit', 'revoke', 'reaction']);

/** ¿Este mensaje cuenta para el seguimiento? Fuera el ruido y los salientes que no llegaron. */
export function cuentaParaSeguimiento(f: MensajeSeg): boolean {
    if (TIPOS_RUIDO.has(String(f.type ?? ''))) return false;
    if (TIPOS_META_RUIDO.has(String(f.payload?.tipo_meta ?? ''))) return false;
    if (f.direction === 'outbound' && f.status === 'failed') return false;
    return f.direction === 'inbound' || f.direction === 'outbound';
}

/** Quién escribió el mensaje. Pura. */
export function autorDe(f: FilaReciente): Autor {
    if (f.direction === 'inbound') return 'persona';
    const p = f.payload ?? {};
    const paso = typeof p.step === 'string' ? p.step : '';
    if (verdadero(p.manual)) return 'escuela';
    if (f.type === 'template' && (paso === 'campana' || p.campana_id) && !paso.startsWith('campana_')) return 'campana';
    if (f.ai_generated === true) return 'bot';
    if (paso.startsWith('campana_')) return 'bot';
    if (paso === 'campana') return 'campana';
    if (f.type === 'template' || verdadero(p.automatico)) return 'automatico';
    // Una persona escribiendo desde el celular nunca deja `step`: si lo hay, lo mandó la app.
    if (paso) return 'automatico';
    return 'escuela';
}

const ETIQUETA_TIPO: Record<string, string> = {
    image: '[imagen]', audio: '[audio]', voice: '[nota de voz]', video: '[video]', document: '[documento]',
    sticker: '[sticker]', location: '[ubicación]', contacts: '[contacto]', template: '[plantilla]',
    interactive: '[botones]', button: '[botón]', unsupported: '[mensaje no disponible]',
};

/** Texto corto para la tabla (una línea, con tope). Pura. */
export function textoCorto(f: FilaReciente, max = TEXTO_CORTO): string {
    const t = texto(f).replace(/\s+/g, ' ');
    if (!t) return ETIQUETA_TIPO[String(f.type ?? '')] ?? '[mensaje]';
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Palabras que por sí solas cierran: «gracias», «ok», «listo», «vale», «no hay problema». */
const ACUSE_FUERTE = new Set([
    'ok', 'okey', 'okay', 'oki', 'okis', 'vale', 'listo', 'lista', 'gracias', 'perfecto', 'perfecta', 'entendido',
    'entendida', 'genial', 'excelente', 'super', 'chevere', 'dale', 'bueno', 'buenisimo', 'bien', 'problema',
]);
/** Relleno que puede acompañarlas sin pedir nada («vale profe, está bien», «ah listo mi profe, gracias por la info»). */
const ACUSE_RELLENO = new Set([
    ...VOCATIVOS_GENERICOS, 'profa', 'don', 'dona', 'mija', 'mijo', 'amigo', 'amiga', 'hermano', 'hermana', 'bro', 'parce',
    'muchas', 'mil', 'muchisimas', 'muy', 'amable', 'de', 'una', 'todo', 'esta', 'pues', 'entonces', 'que', 'y', 'a', 'ti',
    'tu', 'usted', 'su', 'por', 'la', 'el', 'lo', 'le', 'te', 'me', 'mi', 'ah', 'ahh', 'aja', 'ya', 'ahi', 'si', 'no', 'hay',
    'dios', 'bendiga', 'bendiciones', 'buena', 'buen', 'buenas', 'buenos', 'noche', 'noches', 'dia', 'dias', 'tarde', 'tardes',
    'feliz', 'igualmente', 'informacion', 'info', 'total', 'totalmente', 'va', 'quedo', 'atento', 'atenta', 'entiendo',
    'tranqui', 'tranquilo', 'tranquila',
]);

/**
 * ¿El mensaje de la persona NO pide respuesta? «Gracias», «Ok», «Vale profe, está
 * bien», un sticker, solo emojis o un cierre de cortesía («quedo atenta»). Un «Sí»
 * suelto o un «Buenas tardes» SÍ esperan respuesta. Conservador: ante la duda cuenta
 * como que espera (es peor esconder a alguien esperando). Pura.
 */
export function esAcuse(f: FilaReciente): boolean {
    if (f.type === 'sticker' || f.type === 'reaction') return true;
    const crudo = texto(f);
    if (!crudo) return f.type === 'text' || !f.type;
    if (/[?¿]/.test(crudo)) return false;
    const t = normalizarFrase(crudo);
    if (!t) return true;
    const palabras = t.split(' ');
    if (palabras.length <= 10 && palabras.some((w) => ACUSE_FUERTE.has(w))
        && palabras.every((w) => ACUSE_FUERTE.has(w) || ACUSE_RELLENO.has(w))) return true;
    return esCierreDeCortesia(crudo);
}

const RE_DATOS_DE_PAGO = /\b(nequi|daviplata|bancolombia|davivienda|bbva|banco de bogota|colpatria|nu ?bank|cuenta (de )?(ahorros|corriente)|numero de cuenta|llave|bre b|titular)\b/;
const PASOS_DATOS_DE_PAGO = new Set([
    'medios_de_pago_publicos', 'get_payment_methods', 'medios_fallback', 'medios_de_pago_confirma', 'embudo_esperando_pago',
]);

/** ¿Este saliente trae cómo pagar (cuenta, Nequi, Daviplata, llave, o un paso de pago)? Pura. */
export function traeDatosDePago(f: FilaReciente): boolean {
    if (f.direction !== 'outbound') return false;
    const paso = String(f.payload?.step ?? '');
    if (PASOS_DATOS_DE_PAGO.has(paso) || /^venta_.*pago|^pago_servicio|^datos_de_pago/.test(paso)) return true;
    return RE_DATOS_DE_PAGO.test(normalizarFrase(texto(f)));
}

/** Pasos con los que el bot le pasa una PREGUNTA a la escuela. Los de comprobante van por la Bandeja. */
const PASOS_PASE = new Set([
    'escalated', 'mensaje_para_persona', 'escalacion_sin_respuesta', 'embudo_pregunta_a_la_escuela', 'embudo_a_persona',
    'puerta_club_recibido', 'puerta_otro_tema', 'retoma_sin_respuesta', 'audio_no_entendido_buzon', 'prospecto_seguimiento',
]);
const PASOS_COMPROBANTE = /comprobante|deportista_a_la_escuela/;
const RE_PASE = new RegExp([
    '(te )?lo confirma la escuela', 'la escuela te (confirma|responde|escribe|contacta|cuenta)',
    'te (confirma|responde|escribe) la escuela', 'pendiente de la respuesta de la escuela',
    '(ya )?(le )?pase tu (mensaje|pregunta|caso|consulta|datos|inquietud)', 'le paso tu (mensaje|pregunta|caso|consulta|inquietud)',
    'voy a pasar tu (caso|mensaje|pregunta|consulta)', 'una persona del equipo', 'en breve te contactan',
    'alguien (de la escuela )?te (responde|contacta|escribe)',
].map((s) => `\\b${s}\\b`).join('|'));

/** ¿Este saliente le pasa una pregunta a la escuela («te lo confirma la escuela»)? Pura. */
export function esPaseALaEscuela(f: FilaReciente): boolean {
    if (f.direction !== 'outbound') return false;
    const p = f.payload ?? {};
    if (p.pendiente_escuela) return true;
    const paso = String(p.step ?? '');
    if (PASOS_COMPROBANTE.test(paso)) return false;
    if (PASOS_PASE.has(paso)) return true;
    const t = normalizarFrase(texto(f));
    return !/\bcomprobante\b/.test(t) && RE_PASE.test(t);
}

/** Un comprobante de la cola que de verdad llegó como comprobante (no fotos ignoradas). Pura. */
export function esComprobante(c: ComprobanteSeg): boolean {
    if (c.message_type !== 'image' && c.message_type !== 'document') return false;
    if (c.result_ref_id) return true;
    if (['payment_receipt', 'payment_link', 'escalated'].includes(String(c.result_type ?? ''))) return true;
    return ['pending', 'processing', 'waiting_user', 'retry'].includes(c.status);
}

/** Lo que le pasó al comprobante, en palabras de la escuela. Pura. */
export function estadoDeComprobante(c: ComprobanteSeg): string {
    if (c.status === 'waiting_user') return 'Esperando datos de la persona';
    if (c.status === 'pending' || c.status === 'processing' || c.status === 'retry') return 'En proceso';
    if (c.result_type === 'escalated') return 'Pasado a la escuela';
    if (c.result_type === 'payment_receipt' || c.result_ref_id) return 'Aplicado a un cobro';
    return 'Recibido';
}

/** Llave de teléfono para cruzar conversación, lead y cola: los últimos 10 dígitos. Pura. */
export function claveTelefono(tel: string | null | undefined): string {
    if (esAliasDeUsuario(tel)) return tel; // contacto sin teléfono: su alias, no la llave vacía
    const d = String(tel ?? '').replace(/\D/g, '');
    return d.length > 10 ? d.slice(-10) : d;
}

/** `••1234`: para scripts y logs. Pura. */
export function enmascararTelefono(tel: string | null | undefined): string {
    const d = String(tel ?? '').replace(/\D/g, '');
    return d.length > 4 ? `••${d.slice(-4)}` : d;
}

const FAMILIA = new Set(['familia', 'familia_sin_cuenta']);
const PASOS_CLUB = /^(embudo_|cortesia_|clase_prueba|recordatorio_cortesia|prospecto_|puerta_info)/;
const RE_CLASE_PRUEBA = /\b(clases? de (prueba|cortesia)|clase gratis)\b/;

/**
 * El tema: el servicio de la venta (`ventaActiva`, con la marca `venta_servicio_id`
 * o el texto), familia, clase de prueba (el embudo del club, un lead con cupo o una
 * mención) u otro. Pura.
 */
export function temaDe(
    conv: ConversacionSeg, mensajes: MensajeSeg[], items: ItemConFicha[],
    o: { ahora: number; dias: number; lead?: LeadSeg | null; pagos?: PagoSeg[] },
): FilaSeguimiento['tema'] {
    const venta = ventaActiva(mensajes, items, { ahora: o.ahora, dias: o.dias, leadServicioId: o.lead?.servicio ?? null });
    if (venta) return { tipo: 'servicio', servicioId: venta.item.id, nombre: venta.item.name };
    // Marca de un servicio que ya no está vigente (terminó o lo apagaron): sigue siendo una venta.
    const marcado = [...mensajes].reverse().find((m) => m.payload?.[MARCA_VENTA]);
    if (marcado) return { tipo: 'servicio', servicioId: String(marcado.payload[MARCA_VENTA]), nombre: 'Servicio' };
    if (FAMILIA.has(String(conv.contact_kind ?? '')) || conv.parent_id) {
        return { tipo: 'familia', servicioId: null, nombre: 'Familia' };
    }
    const club = !!o.lead?.trial_slot_id || !!o.lead?.cupo_separado_slot_id
        || (o.pagos ?? []).some((p) => p.payment_category === 'clase_prueba')
        || mensajes.some((m) => (m.direction === 'outbound' && PASOS_CLUB.test(String(m.payload?.step ?? '')))
            || (m.direction === 'inbound' && RE_CLASE_PRUEBA.test(normalizarFrase(texto(m)))));
    if (club || o.lead) return { tipo: 'clase_prueba', servicioId: null, nombre: 'Clase de prueba' };
    return { tipo: 'otro', servicioId: null, nombre: 'Otro' };
}

const iso = (ms: number) => new Date(ms).toISOString();
const numero = (v: unknown) => { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : 0; };

export interface EntradaSeguimiento {
    conversaciones: ConversacionSeg[];
    mensajes: MensajeSeg[];
    pagos: PagoSeg[];
    cola: ComprobanteSeg[];
    leads: LeadSeg[];
    items: ItemConFicha[];
    /** Inicio y fin del rango (ms). Solo cuentan las conversaciones con un entrante en el rango. */
    desde: number;
    hasta: number;
    /** «Ahora» para medir la espera (si el rango terminó antes, su fin). */
    ahora: number;
}

/**
 * Una fila por conversación con al menos un mensaje de la persona en el rango. Pura.
 * Orden: primero las que están en rojo, después el resto; en cada grupo, por el
 * último mensaje, más nuevo primero (lo reciente todavía se alcanza a contestar).
 */
export function armarSeguimiento(e: EntradaSeguimiento): FilaSeguimiento[] {
    const ahora = Math.min(e.ahora, e.hasta);
    const dias = Math.max(1, Math.ceil((e.hasta - e.desde) / 86_400_000) + 1);

    const porConv = new Map<string, MensajeSeg[]>();
    for (const m of e.mensajes) {
        if (!cuentaParaSeguimiento(m)) continue;
        const l = porConv.get(m.conversation_id);
        if (l) l.push(m); else porConv.set(m.conversation_id, [m]);
    }

    const leadPorTel = new Map<string, LeadSeg>();
    for (const l of e.leads) {
        const k = claveTelefono(l.phone);
        if (k && !leadPorTel.has(k)) leadPorTel.set(k, l); // vienen del más reciente al más viejo
    }
    const telDeLead = new Map(e.leads.map((l) => [l.id, claveTelefono(l.phone)]));
    const comprobantesPorTel = new Map<string, ComprobanteSeg[]>();
    const telDePago = new Map<string, string>();
    for (const c of e.cola) {
        if (!esComprobante(c)) continue;
        const k = claveTelefono(c.wa_phone_number);
        const l = comprobantesPorTel.get(k);
        if (l) l.push(c); else comprobantesPorTel.set(k, [c]);
        if (c.result_ref_id) telDePago.set(c.result_ref_id, k);
    }
    const pagosPorTel = new Map<string, PagoSeg[]>();
    for (const p of e.pagos) {
        const k = telDePago.get(p.id) ?? (p.signup_lead_id ? telDeLead.get(p.signup_lead_id) : undefined);
        if (!k) continue;
        const l = pagosPorTel.get(k);
        if (l) { if (!l.some((x) => x.id === p.id)) l.push(p); } else pagosPorTel.set(k, [p]);
    }

    const filas: FilaSeguimiento[] = [];
    for (const conv of e.conversaciones) {
        if ((TIPOS_MARCADOS as readonly string[]).includes(String(conv.contact_kind ?? ''))) continue;
        const msgs = (porConv.get(conv.id) ?? []).filter((m) => momento(m) <= ahora + 60_000)
            .sort((a, b) => momento(a) - momento(b));
        const entrantes = msgs.filter((m) => m.direction === 'inbound' && momento(m) >= e.desde && momento(m) <= e.hasta);
        if (!entrantes.length) continue;

        const autores = msgs.map((m) => autorDe(m));
        const primer = entrantes[0];
        const tPrimer = momento(primer);
        const ultimoIdx = msgs.length - 1;
        const cuenta = { persona: 0, escuela: 0, bot: 0 };
        let respondioEscuela = false;
        let respondioBot = false;
        let ultimaRespuesta = -Infinity;
        msgs.forEach((m, i) => {
            const a = autores[i];
            if (a === 'persona') cuenta.persona++;
            if (a === 'escuela') cuenta.escuela++;
            if (a === 'bot') cuenta.bot++;
            if (momento(m) < tPrimer) return;
            if (a === 'escuela') respondioEscuela = true;
            if (a === 'bot') respondioBot = true;
            if (a === 'escuela' || a === 'bot') ultimaRespuesta = Math.max(ultimaRespuesta, momento(m));
        });

        // Esperando: entrantes después de la última respuesta real (escuela o bot) que
        // piden algo. El saludo automático de WhatsApp Business no es respuesta.
        const sinRespuesta = msgs.filter((m) => m.direction === 'inbound' && momento(m) > ultimaRespuesta && !esAcuse(m));
        const esperandoMs = sinRespuesta.length ? momento(sinRespuesta[0]) : null;
        const esperandoMin = esperandoMs === null ? null : Math.max(0, Math.round((ahora - esperandoMs) / 60_000));

        // Pendientes de la escuela: cada pase sin un mensaje de la escuela después.
        const pendientes: FilaSeguimiento['pendientesEscuela'] = [];
        msgs.forEach((m, i) => {
            if (autores[i] !== 'bot') return;
            if (!esPaseALaEscuela(m)) return;
            const t = momento(m);
            const contestada = msgs.some((x, j) => j > i && autores[j] === 'escuela' && momento(x) >= t);
            if (contestada) return;
            const marca = m.payload?.pendiente_escuela;
            let pregunta = typeof marca === 'string' && marca.trim() && marca !== 'true' ? marca.trim() : '';
            if (!pregunta) {
                // La pregunta es lo último que escribió la persona antes del pase (sin contar un «dale» o un «gracias»).
                const previos = msgs.slice(0, i).reverse().filter((x) => x.direction === 'inbound' && texto(x));
                const antes = previos.find((x) => !esAcuse(x)) ?? previos[0];
                pregunta = antes ? textoCorto(antes) : textoCorto(m);
            } else if (pregunta.length > TEXTO_CORTO) {
                pregunta = `${pregunta.slice(0, TEXTO_CORTO - 1).trimEnd()}…`;
            }
            if (!pendientes.some((p) => p.texto === pregunta)) pendientes.push({ texto: pregunta, desde: iso(t) });
        });

        const tel = claveTelefono(conv.contact_wa_id);
        const lead = leadPorTel.get(tel) ?? null;
        const comprobantes = (comprobantesPorTel.get(tel) ?? []).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
        const pagos = (pagosPorTel.get(tel) ?? []).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        const pago = pagos[0] ?? null;
        const ultimo = msgs[ultimoIdx];
        const tema = temaDe(conv, msgs, e.items, { ahora, dias, lead, pagos });

        filas.push({
            conversacionId: conv.id,
            contacto: { nombre: conv.contact_name?.trim() || lead?.full_name?.trim() || null, telefono: conv.contact_wa_id },
            tipoContacto: conv.contact_kind ?? null,
            tema,
            primerMensaje: { fecha: iso(tPrimer), texto: textoCorto(primer) },
            ultimoMensaje: { fecha: iso(momento(ultimo)), de: autores[ultimoIdx], texto: textoCorto(ultimo) },
            mensajes: cuenta,
            respondioEscuela,
            respondioBot,
            esperandoDesde: esperandoMs === null ? null : iso(esperandoMs),
            esperandoMin,
            datosDePagoEnviados: msgs.some((m, i) => autores[i] !== 'persona' && traeDatosDePago(m)),
            comprobanteRecibido: comprobantes.length > 0,
            comprobantes: comprobantes.length,
            comprobanteEstado: comprobantes.length ? estadoDeComprobante(comprobantes[comprobantes.length - 1]) : null,
            cobro: pago ? {
                monto: numero(pago.amount), estado: pago.status, tipo: pago.payment_category ?? null,
                concepto: String(pago.concept ?? '').slice(0, TEXTO_CORTO), fecha: pago.created_at, cuantos: pagos.length,
            } : null,
            pendientesEscuela: pendientes,
            alerta: (esperandoMin ?? 0) > ALERTA_ESPERA_MIN || pendientes.length > 0,
            tomada: !!conv.tomada_por,
        });
    }

    return filas.sort((a, b) => {
        if (a.alerta !== b.alerta) return a.alerta ? -1 : 1;
        return Date.parse(b.ultimoMensaje.fecha) - Date.parse(a.ultimoMensaje.fecha);
    });
}

/** ¿Sigue sin respuesta? Espera una respuesta o tiene pendientes de la escuela. Pura. */
export const sinResponder = (f: FilaSeguimiento) => f.esperandoDesde !== null || f.pendientesEscuela.length > 0;

/** Los contadores de arriba. Pura. */
export function resumirSeguimiento(filas: FilaSeguimiento[]): ResumenSeguimiento {
    const n = (p: (f: FilaSeguimiento) => boolean) => filas.filter(p).length;
    return {
        escribieron: filas.length,
        respondioEscuela: n((f) => f.respondioEscuela),
        respondioBot: n((f) => f.respondioBot),
        nadieRespondio: n((f) => !f.respondioEscuela && !f.respondioBot),
        sinResponder: n(sinResponder),
        esperandoMas2h: n((f) => (f.esperandoMin ?? 0) > ALERTA_ESPERA_MIN),
        conPendientes: n((f) => f.pendientesEscuela.length > 0),
        conDatosDePago: n((f) => f.datosDePagoEnviados),
        conComprobante: n((f) => f.comprobanteRecibido),
        conCobro: n((f) => f.cobro !== null),
    };
}

export const TEMAS_FILTRO = ['servicio', 'clase_prueba', 'familia', 'otro'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ¿Valor válido para el filtro `servicio`? Un id del catálogo o un tema. Pura. */
export function filtroServicioValido(v: string): boolean {
    return UUID.test(v) || (TEMAS_FILTRO as readonly string[]).includes(v);
}

/** Filtro por servicio (id del ítem o tema) y «solo sin responder». Pura. */
export function filtrarSeguimiento(
    filas: FilaSeguimiento[], o: { servicio?: string | null; soloSinResponder?: boolean },
): FilaSeguimiento[] {
    return filas.filter((f) => {
        if (o.servicio) {
            if (UUID.test(o.servicio)) { if (f.tema.servicioId !== o.servicio) return false; }
            else if (f.tema.tipo !== o.servicio) return false;
        }
        return !o.soloSinResponder || sinResponder(f);
    });
}

// ─── Rango ───────────────────────────────────────────────────────────────────

export const DIAS_POR_DEFECTO = 14;
export const DIAS_MAXIMO = 31;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const hoyBogota = (ahora: number) => new Date(ahora - 5 * 3600_000).toISOString().slice(0, 10);
const sumarDias = (f: string, n: number) => {
    const d = new Date(`${f}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const fechaValida = (s: string) => {
    if (!FECHA.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
/** Inicio del día en Bogotá (UTC-5 fijo, sin horario de verano). */
const inicioBogota = (f: string) => Date.parse(`${f}T05:00:00.000Z`);

export type Rango = { desde: string; hasta: string; desdeMs: number; hastaMs: number };

/**
 * Rango del panel: fechas de Bogotá, ambas incluidas. Sin `hasta` → hoy; sin
 * `desde` → los últimos 14 días hasta `hasta`. Máximo 31 días. Pura.
 */
export function leerRangoSeguimiento(desdeQ: unknown, hastaQ: unknown, ahora: number = Date.now()):
    ({ ok: true } & Rango) | { ok: false; error: string } {
    const leer = (v: unknown): string | null | undefined => {
        if (v === undefined || v === null || v === '') return undefined;
        const s = String(v);
        return fechaValida(s) ? s : null;
    };
    const h = leer(hastaQ);
    const d = leer(desdeQ);
    if (h === null || d === null) return { ok: false, error: 'fecha_invalida' };
    const hasta = h ?? hoyBogota(ahora);
    const desde = d ?? sumarDias(hasta, -(DIAS_POR_DEFECTO - 1));
    if (desde > hasta) return { ok: false, error: 'rango_invalido' };
    const dias = (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000 + 1;
    if (dias > DIAS_MAXIMO) return { ok: false, error: 'rango_demasiado_largo' };
    return { ok: true, desde, hasta, desdeMs: inicioBogota(desde), hastaMs: inicioBogota(sumarDias(hasta, 1)) - 1 };
}

// ─── CSV (Excel en es-CO: BOM, «;», CRLF; ver frontend/src/lib/accounting/csv.ts) ──

const ETIQUETA_AUTOR: Record<Autor, string> = {
    persona: 'Persona', escuela: 'Escuela', bot: 'Bot', campana: 'Campaña', automatico: 'Automático',
};
export const etiquetaAutor = (a: Autor) => ETIQUETA_AUTOR[a];

function celda(v: string | number | null | undefined): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v).replace('.', ',') : '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[;"\r\n]/.test(s) || s !== s.trim()) s = `"${s.replace(/"/g, '""')}"`;
    return s;
}

/** «2026-11-08 13:05» en hora de Bogotá. Pura. */
export function fechaBogota(isoTxt: string | null | undefined): string {
    if (!isoTxt) return '';
    const ms = Date.parse(isoTxt);
    if (!Number.isFinite(ms)) return '';
    return new Date(ms - 5 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

const siNo = (b: boolean) => (b ? 'Sí' : 'No');

/** El CSV de la lista (con BOM). Pura. */
export function seguimientoCsv(filas: FilaSeguimiento[]): string {
    const cab = ['Contacto', 'Teléfono', 'Tipo de contacto', 'Tema', 'Primer mensaje (fecha)', 'Primer mensaje',
        'Último mensaje (fecha)', 'Último mensaje de', 'Último mensaje', 'Respondió la escuela', 'Respondió el bot',
        'Esperando desde', 'Horas esperando', 'Datos de pago enviados', 'Comprobante', 'Cobro (monto)', 'Cobro (estado)',
        'Cobro (tipo)', 'Cobro (concepto)', 'Pendientes de la escuela'];
    const filasCsv = filas.map((f) => [
        f.contacto.nombre ?? '', f.contacto.telefono, f.tipoContacto ?? '', f.tema.nombre,
        fechaBogota(f.primerMensaje.fecha), f.primerMensaje.texto,
        fechaBogota(f.ultimoMensaje.fecha), etiquetaAutor(f.ultimoMensaje.de), f.ultimoMensaje.texto,
        siNo(f.respondioEscuela), siNo(f.respondioBot),
        fechaBogota(f.esperandoDesde), f.esperandoMin === null ? null : Math.round(f.esperandoMin / 6) / 10,
        siNo(f.datosDePagoEnviados), f.comprobanteRecibido ? (f.comprobanteEstado ?? 'Sí') : 'No',
        f.cobro ? f.cobro.monto : null, f.cobro?.estado ?? '', f.cobro?.tipo ?? '', f.cobro?.concepto ?? '',
        f.pendientesEscuela.map((p) => p.texto).join(' | '),
    ]);
    return '﻿' + [cab, ...filasCsv].map((r) => r.map(celda).join(';')).join('\r\n') + '\r\n';
}

// ─── Lectura de la base ──────────────────────────────────────────────────────

const PAGINA = 1000;
export const TOPE_CONVERSACIONES = 1000;
export const TOPE_MENSAJES = 20_000;
const TOPE_COLA = 1000;
const TOPE_LEADS = 1000;
const TOPE_PAGOS = 1000;
/** Conversaciones por pedido de mensajes (el largo de la URL del `in`). */
const TROZO_CONVERSACIONES = 40;
const EN_PARALELO = 4;
/** Ids de pago de la cola que entran en un solo `in` (cada uno ~37 caracteres de URL). */
const TOPE_IDS_PAGO = 150;
/** Los cobros de un lead se buscan desde un poco antes del rango (el lead pudo pagar antes). */
const DIAS_PAGOS_ANTES = 30;

/**
 * Las marcas del payload que se leen (PostgREST: `alias:payload->>clave`); nunca el
 * crudo de Meta. `manual`: plantilla mandada a mano desde el buzón; `tipo_meta`
 * (`payload.type`): separa ediciones y borrados de los mensajes que Meta no deja leer.
 */
export const CAMPOS_PAYLOAD: readonly (readonly [alias: string, clave: string])[] = [
    ['step', 'step'], [MARCA_VENTA, MARCA_VENTA], ['servicio_id', 'servicio_id'], ['automatico', 'automatico'],
    ['pendiente_escuela', 'pendiente_escuela'], ['campana_id', 'campana_id'], ['manual', 'manual'], ['tipo_meta', 'type'],
];
export const SELECT_MENSAJES = ['conversation_id', 'direction', 'type', 'text_body', 'ai_generated', 'status', 'wa_timestamp',
    'created_at', ...CAMPOS_PAYLOAD.map(([alias, clave]) => `${alias}:payload->>${clave}`)].join(', ');

export interface ResultadoSeguimiento {
    filas: FilaSeguimiento[];
    servicios: { id: string; nombre: string }[];
    avisos: string[];
}

type Respuesta = { data: unknown; error: { message?: string } | null };

/** Todas las páginas de una consulta ordenada, hasta `tope`. */
async function paginar<T>(armar: (de: number, a: number) => PromiseLike<Respuesta>, tope: number):
    Promise<{ filas: T[]; truncado: boolean }> {
    const filas: T[] = [];
    for (let de = 0; de < tope; de += PAGINA) {
        const r = await armar(de, Math.min(de + PAGINA, tope) - 1);
        if (r.error) throw new Error(r.error.message ?? 'consulta fallida');
        const lote = (r.data as T[]) ?? [];
        filas.push(...lote);
        if (lote.length < PAGINA) return { filas, truncado: false };
    }
    return { filas, truncado: true };
}

function aMensaje(f: any): MensajeSeg {
    const payload: Record<string, unknown> = {};
    for (const [alias] of CAMPOS_PAYLOAD) if (f[alias] !== null && f[alias] !== undefined) payload[alias] = f[alias];
    return {
        conversation_id: f.conversation_id, direction: f.direction, type: f.type, text_body: f.text_body ?? null,
        ai_generated: f.ai_generated, status: f.status, wa_timestamp: f.wa_timestamp, created_at: f.created_at, payload,
    };
}

/** Los mensajes del rango de esas conversaciones: UNA consulta, partida por el largo de la URL. */
async function leerMensajes(ids: string[], desdeIso: string, hastaIso: string): Promise<{ filas: MensajeSeg[]; truncado: boolean }> {
    const trozos: string[][] = [];
    for (let i = 0; i < ids.length; i += TROZO_CONVERSACIONES) trozos.push(ids.slice(i, i + TROZO_CONVERSACIONES));
    const filas: MensajeSeg[] = [];
    let truncado = false;
    for (let i = 0; i < trozos.length && !truncado; i += EN_PARALELO) {
        const lotes = await Promise.all(trozos.slice(i, i + EN_PARALELO).map((trozo) => paginar<any>((de, a) =>
            supabase.from('whatsapp_messages').select(SELECT_MENSAJES)
                .in('conversation_id', trozo).gte('created_at', desdeIso).lte('created_at', hastaIso)
                .order('created_at').order('id').range(de, a), TOPE_MENSAJES)));
        for (const l of lotes) {
            for (const f of l.filas) filas.push(aMensaje(f));
            if (l.truncado) truncado = true;
        }
        if (filas.length >= TOPE_MENSAJES) truncado = true;
    }
    return { filas: filas.slice(0, TOPE_MENSAJES), truncado };
}

/**
 * La lista de seguimiento de una escuela en un rango. Lee: conversaciones con
 * actividad desde `desde`, la cola de comprobantes del rango, los leads de la
 * escuela y el catálogo vigente (en paralelo); después los mensajes del rango y los
 * cobros ligados (por el comprobante o por el lead). Lanza si una consulta falla
 * (la ruta responde 500).
 */
export async function seguimientoDeConversaciones(
    schoolId: string, rango: Rango, o: { ahora?: number } = {},
): Promise<ResultadoSeguimiento> {
    const ahora = o.ahora ?? Date.now();
    const desdeIso = new Date(rango.desdeMs).toISOString();
    const hastaIso = new Date(rango.hastaMs).toISOString();
    const avisos: string[] = [];

    const [convs, cola, leads, items] = await Promise.all([
        supabase.from('whatsapp_conversations')
            .select('id, contact_wa_id, contact_name, contact_kind, parent_id, tomada_por')
            .eq('school_id', schoolId).gte('last_message_at', desdeIso)
            .order('last_message_at', { ascending: false }).limit(TOPE_CONVERSACIONES),
        supabase.from('whatsapp_inbound_queue')
            .select('wa_phone_number, message_type, status, result_type, result_ref_id, created_at')
            .eq('school_id', schoolId).in('message_type', ['image', 'document'])
            .gte('created_at', desdeIso).lte('created_at', hastaIso)
            .order('created_at', { ascending: false }).limit(TOPE_COLA),
        supabase.from('school_signup_leads')
            .select('id, phone, full_name, status, trial_slot_id, cupo_separado_slot_id, servicio:source_detail->servicio_interes->>id, created_at')
            .eq('school_id', schoolId).neq('status', 'discarded')
            .order('updated_at', { ascending: false }).limit(TOPE_LEADS),
        serviciosDeAnuncio(schoolId, ahora),
    ]);
    if (convs.error) throw new Error(`conversaciones: ${convs.error.message}`);
    if (cola.error) throw new Error(`cola: ${cola.error.message}`);
    if (leads.error) throw new Error(`leads: ${leads.error.message}`);
    const conversaciones = (convs.data ?? []) as unknown as ConversacionSeg[];
    const filasCola = (cola.data ?? []) as unknown as ComprobanteSeg[];
    const filasLeads = (leads.data ?? []) as unknown as LeadSeg[];
    if (conversaciones.length >= TOPE_CONVERSACIONES) avisos.push(`Se muestran las ${TOPE_CONVERSACIONES} conversaciones más recientes: acorta el rango para ver todas.`);
    if (filasCola.length >= TOPE_COLA) avisos.push('Hay más comprobantes de los que se leyeron: acorta el rango.');

    const idsPago = [...new Set(filasCola.map((c) => c.result_ref_id).filter((x): x is string => !!x && UUID.test(x)))];
    if (idsPago.length > TOPE_IDS_PAGO) avisos.push('Algunos cobros de comprobantes no se cruzaron: acorta el rango.');
    const desdePagos = new Date(rango.desdeMs - DIAS_PAGOS_ANTES * 86_400_000).toISOString();
    const conLead = `and(signup_lead_id.not.is.null,created_at.gte."${desdePagos}")`;
    const filtroPagos = idsPago.length ? `id.in.(${idsPago.slice(0, TOPE_IDS_PAGO).join(',')}),${conLead}` : conLead;

    const [mensajes, pagos] = await Promise.all([
        conversaciones.length ? leerMensajes(conversaciones.map((c) => c.id), desdeIso, hastaIso)
            : Promise.resolve({ filas: [] as MensajeSeg[], truncado: false }),
        supabase.from('payments')
            .select('id, amount, status, payment_category, concept, signup_lead_id, created_at')
            .eq('school_id', schoolId).or(filtroPagos)
            .order('created_at', { ascending: false }).limit(TOPE_PAGOS),
    ]);
    if (pagos.error) throw new Error(`pagos: ${pagos.error.message}`);
    if (mensajes.truncado) avisos.push(`Se leyeron ${TOPE_MENSAJES.toLocaleString('es-CO')} mensajes (el tope): acorta el rango para ver todo.`);
    const filasPagos = (pagos.data ?? []) as unknown as PagoSeg[];
    if (filasPagos.length >= TOPE_PAGOS) avisos.push('Hay más cobros de los que se leyeron: acorta el rango.');

    const filas = armarSeguimiento({
        conversaciones, mensajes: mensajes.filas, pagos: filasPagos, cola: filasCola, leads: filasLeads, items,
        desde: rango.desdeMs, hasta: rango.hastaMs, ahora,
    });

    const servicios = new Map(items.map((it) => [it.id, it.name]));
    for (const f of filas) if (f.tema.servicioId && !servicios.has(f.tema.servicioId)) servicios.set(f.tema.servicioId, f.tema.nombre);
    return { filas, servicios: [...servicios].map(([id, nombre]) => ({ id, nombre })), avisos };
}
