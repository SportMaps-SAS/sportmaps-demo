/**
 * whatsapp-vigilante.service — el vigilante de confiabilidad del bot de
 * WhatsApp: que SportMaps se entere, antes que la escuela, de lo que quedó sin
 * desenlace.
 *
 * POR QUÉ EXISTE
 *
 * La auditoría de producción del 1 al 16 de noviembre de 2026 encontró
 * comprobantes reales cerrados en silencio o esperando una respuesta que nunca
 * se procesó (~$16 M sin registrar entre dos escuelas), 29 de 77 preguntas que
 * el bot «pasó a la escuela» sin respuesta humana en 24 h, 271 mensajes de
 * clientes sin respuesta y mensajes del bot que afirmaban algo que no pasó.
 * Nada le avisó a nadie.
 *
 * QUÉ REVISA (por cada número de WhatsApp activo)
 *
 *   1. Comprobantes sin desenlace  (whatsapp_inbound_queue, 7 días)
 *   2. Preguntas pasadas a la escuela sin respuesta humana (48 h)
 *   3. Clientes sin respuesta en 30 min: preguntas y avisos de pago
 *   4. Afirmaciones del bot que el código no garantiza («ya te anoté»)
 *   5. El mismo texto del bot 3 o más veces en 10 minutos
 *
 * Las DECISIONES son funciones puras (arriba); las LECTURAS van aparte (abajo).
 *
 * DISK IO (una sola base para todos los ambientes)
 *
 * Por corrida: 1 consulta a `email_sends` (¿ya salió el de hoy? — si sí, no se
 * lee nada más), 1 a las integraciones y 1 a los nombres de las escuelas. Por
 * número: 3 fijas (cola, conceptos esperados, conversaciones) más los mensajes,
 * que se leen por lotes de CONVS_POR_LOTE conversaciones con el índice
 * (conversation_id, created_at): 1 consulta en una escuela normal, tope duro de
 * MAX_CONSULTAS_DE_MENSAJES. Nunca una consulta por fila ni por conversación.
 * No se trae `payload` ni `pregunta_ocr` completos: solo `payload->>step`,
 * `payload->automatico`, `pregunta_ocr->ocr->>amount` y `pregunta_ocr->>tipo`.
 *
 * A QUIÉN LE LLEGA
 *
 * Un correo al día al equipo de SportMaps (`correosDeSoporte()`), con reserva en
 * `email_sends` (clave por fecha: uno solo entre los tres BFF). A las escuelas
 * NO se les envía nada: `resumenParaEscuela` deja listo el texto y el envío es
 * una decisión de producto pendiente.
 *
 * Nada de aquí lanza. Kill-switch: DISABLE_WHATSAPP_VIGILANTE=true.
 */

import { supabase } from '../config/supabase';
import { esFestivoColombia } from '../utils/festivos-colombia';
import { entrantesSinDuenoEnSilencio } from './whatsapp-silencio-conversacion';
import type { FilaReciente } from './whatsapp-reglas-turno';
import { correosDeSoporte, enviarConReserva, escaparHtml, uuidDeClave } from './avisos-correo.service';

// ─── Parámetros ──────────────────────────────────────────────────────────────

const HORA_MS = 3600_000;
const COT_MS = 5 * HORA_MS;

/** El origen de producción. A propósito NO se usa FRONTEND_URL: en un BFF local apunta a localhost. */
export const ORIGEN_APP = 'https://app.sportmaps.co';

export const PARAMETROS = {
    /** Cuánto hacia atrás se mira la cola de comprobantes (lo sin resolver se repite hasta que se resuelva). */
    diasDeCola: 7,
    /** Cuánto hacia atrás se leen los mensajes. */
    horasDeMensajes: 48,
    /** Una pregunta al cliente (`waiting_user`) se da por colgada después de esto. */
    horasEsperandoAlCliente: 2,
    /** Un comprobante en la bandeja se da por olvidado después de esto. */
    horasEnBandeja: 24,
    /** Una fila sin procesar (`pending`/`processing`) se da por colgada después de esto. */
    horasSinProcesar: 1,
    /** Horas HÁBILES que tiene la escuela para contestar lo que el bot le pasó. */
    horasHabilesParaResponder: 4,
    /** Un cliente está «sin respuesta» si no sale nada en estos minutos. */
    minutosSinRespuesta: 30,
    /** Repetición: el mismo texto estas veces… */
    vecesRepetido: 3,
    /** …dentro de estos minutos. */
    minutosDeRepeticion: 10,
} as const;

const MAX_FILAS_DE_COLA = 1000;
const MAX_CONCEPTOS = 500;
const MAX_CONVERSACIONES = 480;
const CONVS_POR_LOTE = 60;
const PAGINA = 1000;
const MAX_PAGINAS_POR_LOTE = 3;
/** Tope duro de consultas de mensajes por número, pase lo que pase. */
export const MAX_CONSULTAS_DE_MENSAJES = 12;
/** Filas por sección y escuela que entran al correo; el resto se cuenta. */
const MAX_FILAS_EN_CORREO = 12;

// ─── Formas ──────────────────────────────────────────────────────────────────

export interface FilaDeCola {
    id: string;
    wa_phone_number: string;
    message_type: string | null;
    status: string;
    result_type: string | null;
    error_message: string | null;
    storage_path: string | null;
    media_caption: string | null;
    created_at: string;
    updated_at: string | null;
    processed_at: string | null;
    pregunta_at: string | null;
    /** `pregunta_ocr->ocr->>amount` */
    monto: string | number | null;
    /** `pregunta_ocr->>tipo` */
    tipo: string | null;
}

export interface MensajeV {
    id: string;
    conversation_id: string;
    direction: string;
    type: string | null;
    text_body: string | null;
    ai_generated: boolean | null;
    wa_timestamp: string | null;
    created_at: string | null;
    /** `payload->>step` */
    step: string | null;
    /** `payload->automatico` (saludo o ausencia de la app del negocio) */
    automatico?: unknown;
    /** `payload->manual`: escrito a mano por una persona de la escuela (buzón / plantilla manual). */
    manual?: unknown;
    /** `payload->>campana_id`: salió de una campaña (no es una persona escribiendo). */
    campana?: string | null;
}

export interface ConversacionV {
    id: string;
    contact_wa_id: string | null;
    contact_name: string | null;
    status: string | null;
    tomada_hasta: string | null;
    /** Sin ficha de familia (null) = contacto desconocido: su silencio dura 72 h en vez de 12 h. */
    parent_id?: string | null;
}

export interface ConceptoVivo { telefono: string | null; motivo: string | null; monto: number | string | null; vence_en: string | null }

export interface Item {
    /** «Nombre del perfil (…1234)». Nunca el número completo. */
    contacto: string;
    /** Hora de Colombia, en palabras. */
    hora: string;
    /** Instante del hecho (ms), para ordenar. */
    t: number;
    monto: number | null;
    /** Lo que dijo el cliente (o el bot, en las secciones 4 y 5), recortado. */
    dijo: string;
    /** Qué pasó, en una frase. */
    motivo: string;
    queHacer: string;
}

export interface Seccion { total: number; items: Item[] }

export interface InformeEscuela {
    integrationId: string;
    schoolId: string;
    escuela: string;
    /** Si no se pudo revisar: por qué. Las secciones vienen vacías. */
    error: string | null;
    /** Algún tope de lectura se alcanzó: los números son un piso. */
    recortado: boolean;
    consultas: number;
    numeros: {
        archivosRecibidos: number;
        terminaronEnCobro: number;
        /** null = no llegó ningún archivo. */
        pctCobro: number | null;
        comprobantesSinDesenlace: number;
        pesosSinDesenlace: number;
        preguntasSinRespuesta: number;
        clientesSinRespuesta: number;
    };
    comprobantes: Seccion & { pesos: number };
    derivaciones: Seccion;
    clientes: Seccion;
    afirmaciones: Seccion;
    repeticiones: Seccion;
    /** 6. Preguntas y avisos de pago que quedaron sin dueño durante un silencio (la escuela escribió y nadie retomó). */
    sinDueno: Seccion;
}

export interface InformeVigilante {
    /** 'YYYY-MM-DD' del día (Colombia) en que se arma. */
    fecha: string;
    desde: string;
    hasta: string;
    escuelas: InformeEscuela[];
    consultas: number;
}

// ─── Utilidades puras ────────────────────────────────────────────────────────

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «15 nov, 3:42 p. m.» en hora de Colombia. Pura (no depende del ICU del servidor). */
export function horaCot(t: number | string | null | undefined): string {
    const ms = typeof t === 'number' ? t : t ? Date.parse(t) : NaN;
    if (!Number.isFinite(ms)) return '';
    const c = new Date(ms - COT_MS);
    const h = c.getUTCHours();
    return `${c.getUTCDate()} ${MESES[c.getUTCMonth()]}, ${h % 12 === 0 ? 12 : h % 12}:${String(c.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** 'YYYY-MM-DD' del día en Colombia. */
export const fechaCot = (ms: number): string => new Date(ms - COT_MS).toISOString().slice(0, 10);

/** «$1.250.000». Pura. */
export function pesos(n: number): string {
    return `$${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

export function recortar(s: string | null | undefined, n = 140): string {
    const limpio = String(s ?? '').replace(/\s+/g, ' ').trim();
    return limpio.length > n ? `${limpio.slice(0, n - 1)}…` : limpio;
}

/** «Nombre (…1234)»: solo los últimos 4 dígitos. Pura. */
export function contactoCorto(nombre: string | null | undefined, waId: string | null | undefined): string {
    const d = String(waId ?? '').replace(/\D/g, '');
    const cola = d.length >= 4 ? `…${d.slice(-4)}` : 'número oculto';
    const n = recortar(nombre, 40);
    return n ? `${n} (${cola})` : cola;
}

/** Minúsculas, sin tildes, sin signos ni emojis, espacios simples. Pura. */
export function normalizar(texto: string | null | undefined): string {
    return String(texto ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9ñ$%\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** El monto que leyó el OCR, si es un número positivo. Pura. */
export function montoDe(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    let n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isFinite(n)) n = Number(String(v).replace(/[^\d]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Momento real del mensaje: el de Meta si vino; si no, el de la base. */
export const momento = (m: Pick<MensajeV, 'wa_timestamp' | 'created_at'>): number =>
    Date.parse(m.wa_timestamp ?? m.created_at ?? '') || 0;

const ultimos10 = (tel: string | null | undefined) => String(tel ?? '').replace(/\D/g, '').slice(-10);

/**
 * Horas HÁBILES entre dos instantes: lunes a viernes 7:00–19:00, sábados
 * 8:00–15:00 (hora de Colombia), sin domingos ni festivos. Es el mismo horario
 * en que el sistema le escribe a la gente. Pura.
 */
export function horasHabilesEntre(desdeMs: number, hastaMs: number): number {
    if (!(hastaMs > desdeMs)) return 0;
    let total = 0;
    const primerDia = Date.parse(`${fechaCot(desdeMs)}T00:00:00Z`);
    for (let i = 0; i < 40; i++) {
        const dia = primerDia + i * 24 * HORA_MS; // medianoche del día, como si fuera UTC
        const semana = new Date(dia).getUTCDay();
        const abre = dia + (semana === 6 ? 8 : 7) * HORA_MS + COT_MS;
        if (abre >= hastaMs) break;
        if (semana === 0 || esFestivoColombia(new Date(dia).toISOString().slice(0, 10))) continue;
        const cierra = dia + (semana === 6 ? 15 : 19) * HORA_MS + COT_MS;
        const a = Math.max(abre, desdeMs);
        const b = Math.min(cierra, hastaMs);
        if (b > a) total += b - a;
    }
    return total / HORA_MS;
}

// ─── Decisión: ¿qué es una pregunta, qué es un aviso de pago? ────────────────

const PALABRAS_DE_CORTESIA = new Set([
    'hola', 'holi', 'buenas', 'buenos', 'buen', 'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches', 'gracias', 'muchas',
    'mil', 'muchisimas', 'ok', 'okay', 'oki', 'okey', 'vale', 'listo', 'lista', 'dale', 'si', 'no', 'claro', 'perfecto',
    'bueno', 'bien', 'de', 'acuerdo', 'entendido', 'entiendo', 'super', 'genial', 'excelente', 'bendiciones', 'feliz',
    'igualmente', 'senora', 'senor', 'señora', 'señor', 'profe', 'con', 'gusto', 'mucho', 'muy', 'amable', 'hasta',
    'luego', 'pronto', 'chao', 'saludos', 'bn', 'ya', 'a', 'usted', 'ustedes', 'ti', 'tambien', 'que', 'pena', 'la',
    'el', 'los', 'las', 'por', 'todo', 'favor', 'tenga', 'tengan', 'un', 'una', 'abrazo', 'dios', 'les', 'le', 'te',
    'pague', 'bendiga', 'quedo', 'atenta', 'atento', 'pendiente', 'y', 'como', 'estas', 'esta', 'estan', 'va', 'van',
    'jaja', 'jajaja', 'jeje', 'ah', 'oh', 'uy', 'ay', 'ahh', 'ohh', 'mmm', 'sisas', 'vale', 'tranquilo', 'tranquila',
]);

/** Saludo suelto, agradecimiento o acuse («ok, gracias», «buenas tardes», un emoji). Recibe texto ya normalizado. Pura. */
export function esCortesia(normalizado: string): boolean {
    if (!normalizado) return true; // solo emojis, stickers o signos
    const palabras = normalizado.split(' ');
    return palabras.length <= 9 && palabras.every((p) => PALABRAS_DE_CORTESIA.has(p));
}

const NEGADO_O_CONDICIONAL = '(?<!\\b(?:que|cuando|si|no|aun no|todavia no|apenas|para|como|donde)\\s)(?<!\\b(?:que|cuando|si|no)\\s(?:yo|le|les|te|lo|la)\\s)';

/** «ya pagué», «hice la transferencia», «te envío el comprobante»… (sobre texto normalizado). */
const AVISO_DE_PAGO = new RegExp([
    `${NEGADO_O_CONDICIONAL}\\b(?:pague|cancele|consigne|transferi|abone)\\b`,
    '\\b(?:hice|realice|hicimos|realizamos|acabo de hacer|acabo de realizar|envie|mande|envio|mando|adjunto|anexo|comparto|remito)\\s+(?:ya\\s+)?(?:el|la|un|una|mi|los|las)?\\s*(?:pago|pagos|transferencia|consignacion|abono|comprobante|comprobantes|soporte|soportes|recibo)\\b',
    '\\b(?:comprobante|soporte|recibo)s?\\s+(?:de|del)\\s+(?:el\\s+)?(?:pago|transferencia|consignacion|abono)\\b',
    '\\b(?:ahi|aqui|alli)\\s+(?:va|esta|envio|mando|le envio|te envio|les envio)\\s+(?:el|la|mi)?\\s*(?:pago|comprobante|soporte|transferencia|consignacion|recibo)\\b',
    '\\bya\\s+(?:quedo|esta|estan)\\s+(?:pago|paga|pagado|pagada|cancelado|cancelada|consignado|transferido)\\b',
    '\\bpago\\s+(?:realizado|hecho|listo|efectuado|enviado)\\b',
    '\\bya\\s+(?:hice|realice|envie|mande)\\b.*\\b(?:pago|transferencia|consignacion|abono)\\b',
].join('|'));

const EMPIEZA_COMO_PREGUNTA = new RegExp(
    '^(?:(?:hola|holi|buenas|buen[oa]s? (?:dias|dia|tardes|noches)|disculpa|disculpe|perdon|una pregunta|una consulta|profe|senor[a]?)[ ]*)*'
    + '(?:cuanto|cuanta|cuantos|cuantas|cual|cuales|quien|quienes|por que|porque no|para cuando|a que hora|hasta cuando|desde cuando'
    // «cuando pague le aviso» no es una pregunta: cuándo/dónde solo con un verbo de pregunta detrás.
    + '|(?:cuando|donde|adonde) (?:es|son|seria|sera|queda|quedan|estan|esta|empieza|empiezan|inicia|inician|termina|terminan|vence|toca|hay|abren|puedo|puede|pueden|podemos|debo|tengo|se|van|va|pago|consigno|entrenan|juegan|tienen)'
    + '|puedo|puedes|puede|pueden|podria|podrian|podemos|tienen|tiene|tendran|hay|habra|sera que|es posible|se puede'
    + '|como (?:hago|puedo|es|seria|funciona|me|se|van|va|quedo|quedamos|pago|hacemos|inscribo|registro)'
    + '|que (?:dias|dia|horario|horarios|hora|valor|precio|precios|costo|costos|necesito|debo|hay|tengo|se|incluye|paso|pasa|documentos|categoria|categorias|edad|edades|plan|planes|metodos|medios|sede|sedes|cupos)'
    + '|informacion|info|precio|precios|horario|horarios|valor|costo|costos|me interesa|estoy interesad[oa]|quiero inscribir|quisiera inscribir)\\b',
);

const PIDE_ALGO = /\b(?:me (?:pueden|puede|podrian|podria|puedes|ayudan|ayuda|colaboran|colabora|regalan|regala|confirman|confirma|indican|indica|envian|envia|dicen|dice|cuentan|cuenta) |quisiera saber|quiero saber|necesito saber|me gustaria saber|necesito informacion|quiero informacion|quisiera informacion|mas informacion|tienen cupo|hay cupo|quedo atent[oa] a|cuanto (?:vale|cuesta|es|seria|sale|queda|debo)|que (?:valor|precio|costo) |por favor (?:me |nos )?(?:confirman|confirma|indican|indica|informan|informa|ayudan|ayuda))/;

export type TipoDeEntrante = 'pregunta' | 'aviso_pago';

/**
 * ¿Este mensaje del cliente espera una respuesta? Devuelve 'pregunta',
 * 'aviso_pago' o null (cortesía, saludo suelto, charla). Pura.
 *
 * Es una heurística a propósito conservadora: prefiere no listar una charla
 * antes que llenar el correo de «ok, gracias».
 */
export function clasificarEntrante(texto: string | null | undefined): TipoDeEntrante | null {
    const crudo = String(texto ?? '');
    const n = normalizar(crudo);
    if (!n) return null;
    const pregunta = /[?¿]/.test(crudo);
    // «Dios le pague» es un agradecimiento, no un pago.
    const sinGracias = n.replace(/\bdios (?:se lo |le |les |te |los |lo )?pague\b/g, ' ').trim();
    if (AVISO_DE_PAGO.test(sinGracias)) return pregunta ? 'pregunta' : 'aviso_pago';
    if (esCortesia(n)) return null;
    if (pregunta) return 'pregunta';
    if (n.split(' ').length < 2 && !/^(?:informacion|info|precio|precios|horario|horarios|valor|costo|costos)$/.test(n)) return null;
    if (EMPIEZA_COMO_PREGUNTA.test(n) || PIDE_ALGO.test(n)) return 'pregunta';
    return null;
}

// ─── Decisión: ¿quién escribió, y fue una derivación? ────────────────────────

/** Saliente escrito por una PERSONA de la escuela (buzón o su celular): ni IA, ni paso del bot, ni saludo automático. Pura. */
export function esSalienteHumano(m: Pick<MensajeV, 'direction' | 'ai_generated' | 'step' | 'automatico'>): boolean {
    return m.direction === 'outbound' && m.ai_generated !== true && !m.step
        && m.automatico !== true && m.automatico !== 'true';
}

/** Saliente del bot (IA o un paso programado). Pura. */
export function esSalienteDelBot(m: Pick<MensajeV, 'direction' | 'ai_generated' | 'step'>): boolean {
    return m.direction === 'outbound' && (m.ai_generated === true || Boolean(m.step));
}

const esAutomatico = (m: Pick<MensajeV, 'automatico'>) => m.automatico === true || m.automatico === 'true';

const PASOS_DE_DERIVACION = new Set([
    'escalated', 'mensaje_para_persona', 'venta_servicio_a_la_escuela', 'venta_servicio_humano',
    'venta_comprobante_a_la_escuela', 'comprobante_a_la_escuela', 'comprobante_a_revision_manual',
    'escalacion_abierta_detalle', 'escalacion_sin_respuesta', 'pide_persona', 'pidio_una_persona',
]);

/**
 * ¿Con este paso el bot le dijo al cliente «te contesta la escuela»? La lista
 * de arriba más la familia de nombres (`…_a_la_escuela`, `…_humano`,
 * `…_a_persona`, `…_persona`, `escalacion_…`), para que un paso nuevo con el
 * mismo patrón entre solo. Pura.
 */
export function esPasoDeDerivacion(step: string | null | undefined): boolean {
    const s = String(step ?? '');
    if (!s) return false;
    if (PASOS_DE_DERIVACION.has(s)) return true;
    if (s.startsWith('silencio_')) return false; // decisión de callar, no un mensaje al cliente
    return /(?:_a_la_escuela|_humano|_a_persona|_persona)$/.test(s) || /^escalacion_/.test(s);
}

// ─── Decisión: ¿el bot afirmó algo que el código no garantiza? ───────────────

/** Pasos de texto libre del modelo: lo que diga no viene de una acción ejecutada. */
export const PASOS_SIN_GARANTIA: readonly string[] = ['venta_servicio_respuesta', 'prospecto_ia', 'llm_text'];

const AFIRMACIONES = [
    /(?:^|[^\p{L}])(?:ya\s+)?(?:(?:te|lo|la|los|las|le|les|me)\s+)*(?:anoté|registré|guardé|agendé|reservé|inscribí|separé|aparté|apunté)(?![\p{L}])/u,
    /(?:^|[^\p{L}])(?:quedó|queda|quedaste|quedaron|quedan|quedas|está|están)\s+(?:[\p{L}]+\s+){0,3}?(?:reservad[oa]s?|agendad[oa]s?|registrad[oa]s?|inscrit[oa]s?|anotad[oa]s?|confirmad[oa]s?|separad[oa]s?|guardad[oa]s?|apartad[oa]s?)(?![\p{L}])/u,
    /(?:^|[^\p{L}])(?:he|hemos)\s+(?:anotado|registrado|guardado|agendado|reservado|inscrito|separado|apartado)(?![\p{L}])/u,
    /(?:^|[^\p{L}])(?:listo|hecho|perfecto)[,.!:]?\s+(?:anotad[oa]|registrad[oa]|agendad[oa]|reservad[oa]|inscrit[oa]|guardad[oa])(?![\p{L}])/u,
];
const ANTES_NIEGA = /(?:^|[^\p{L}])(?:no|aún no|aun no|todavía no|cuando|si|hasta que|una vez|apenas|para que)\s+(?:[\p{L}]+\s+)?$/u;

/**
 * La frase con que el texto afirma una acción ya hecha («ya te anoté»,
 * «quedó reservada», «tu cupo está confirmado»), o null. No cuenta lo negado ni
 * lo condicional («aún no quedó registrado», «cuando pagues queda reservado»).
 * Mira el texto CON tildes: «anoté» afirma, «para que te anote» no. Pura.
 */
export function fraseQueAfirma(texto: string | null | undefined): string | null {
    const t = String(texto ?? '').toLowerCase().replace(/\s+/g, ' ');
    for (const re of AFIRMACIONES) {
        const global = new RegExp(re.source, `${re.flags}g`);
        for (const m of t.matchAll(global)) {
            const inicio = m.index ?? 0;
            const frase = m[0].replace(/^[^\p{L}]+/u, '');
            const antes = t.slice(Math.max(0, inicio - 40), inicio + (m[0].length - frase.length));
            if (ANTES_NIEGA.test(antes)) continue;
            return frase.trim();
        }
    }
    return null;
}

/** ¿Este saliente es una afirmación por verificar? IA + paso sin garantía (o sin paso) + frase afirmativa. Pura. */
export function afirmacionPorVerificar(
    m: Pick<MensajeV, 'direction' | 'ai_generated' | 'step' | 'text_body'>,
    pasos: readonly string[] = PASOS_SIN_GARANTIA,
): string | null {
    if (m.direction !== 'outbound' || m.ai_generated !== true) return null;
    if (m.step && !pasos.includes(m.step)) return null;
    return fraseQueAfirma(m.text_body);
}

// ─── Decisión: el desenlace de un comprobante ────────────────────────────────

/** Copia de PREFIJO_CERRADA (whatsapp-bandeja.service): lo que la escuela ya resolvió o descartó. No se importa: ese archivo arrastra medio bot. */
const PREFIJO_CERRADA = 'cerrado_escuela:';

/** Cierres en silencio que SÍ son un desenlace: el comprobante ya estaba registrado. */
const YA_ESTABA = /ya registrado|ya_registrado|comprobante repetido|comprobante ya recibido|referencia ya usada|venta_comprobante_repetido/i;

/** Cierres de «esto no es un pago» (la lectura dijo que no es comprobante). Sin señal de pago, ni se cuentan ni se listan. */
const NO_ES_UN_PAGO = /^(no es un comprobante|no_es_comprobante_sin_contexto|consulta_no_comprobante|listado de movimientos|ni comprobante ni matr)/i;
/** Cierres que no bajaron el archivo (ráfaga sin OCR, contacto no atendido): sin `storage_path`. */
const SIN_ARCHIVO_GUARDADO = /^(ocr_omitido|contacto_no_atendido)/i;

export type Desenlace =
    | { tipo: 'cobro' }
    | { tipo: 'resuelto' }
    | { tipo: 'en_curso' }
    | { tipo: 'ruido' }
    | { tipo: 'sin_desenlace'; motivo: string; queHacer: string };

/**
 * En qué terminó un archivo que llegó por WhatsApp. Pura.
 *
 *   cobro          → quedó en un pago (done + payment_receipt / payment_link)
 *   resuelto       → otra salida legítima: la escuela lo cerró en la bandeja, era repetido, era una matrícula…
 *   en_curso       → todavía dentro de su plazo (pregunta reciente, bandeja de hoy)
 *   ruido          → no era un comprobante y nada indica que fuera un pago
 *   sin_desenlace  → lo que hay que mirar
 */
export function desenlaceDeComprobante(
    f: Pick<FilaDeCola, 'status' | 'result_type' | 'error_message' | 'storage_path' | 'created_at' | 'updated_at' | 'processed_at' | 'pregunta_at' | 'monto'>,
    senales: { conceptoEsperado: boolean; textoDePago: boolean },
    ahora: number,
): Desenlace {
    const horasDesde = (iso: string | null | undefined) => (ahora - (Date.parse(iso ?? '') || Date.parse(f.created_at) || ahora)) / HORA_MS;
    const motivo = f.error_message ?? '';
    if (motivo.startsWith(PREFIJO_CERRADA)) return { tipo: 'resuelto' };

    if (f.status === 'done') {
        return f.result_type === 'payment_receipt' || f.result_type === 'payment_link' ? { tipo: 'cobro' } : { tipo: 'resuelto' };
    }
    if (f.status === 'failed') {
        return { tipo: 'sin_desenlace', motivo: 'No se pudo procesar', queHacer: 'Abrir el archivo en la bandeja y registrar el pago a mano; revisar por qué falló.' };
    }
    if (f.status === 'pending' || f.status === 'processing') {
        const h = horasDesde(f.created_at);
        if (h < PARAMETROS.horasSinProcesar) return { tipo: 'en_curso' };
        return { tipo: 'sin_desenlace', motivo: `Lleva ${Math.floor(h)} h sin procesarse`, queHacer: 'Revisar la cola de WhatsApp (worker u OCR caídos) y procesarlo.' };
    }
    if (f.status === 'waiting_user') {
        const h = horasDesde(f.pregunta_at ?? f.updated_at ?? f.created_at);
        if (h < PARAMETROS.horasEsperandoAlCliente) return { tipo: 'en_curso' };
        return {
            tipo: 'sin_desenlace',
            motivo: `Se le hizo una pregunta al cliente hace ${Math.floor(h)} h y el comprobante sigue sin aplicar`,
            queHacer: 'Mirar si el cliente ya contestó (la respuesta pudo no procesarse) y aplicar el pago a mano.',
        };
    }
    if (f.status === 'ignored') {
        if (f.result_type === 'escalated') {
            const h = horasDesde(f.processed_at ?? f.created_at);
            if (h < PARAMETROS.horasEnBandeja) return { tipo: 'en_curso' };
            return {
                tipo: 'sin_desenlace',
                motivo: `Está en la bandeja de la escuela sin resolver hace ${Math.floor(h)} h`,
                queHacer: 'Avisarle a la escuela que lo resuelva en la bandeja, o resolverlo con ella.',
            };
        }
        if (YA_ESTABA.test(motivo)) return { tipo: 'resuelto' };
        const porque = motivo ? ` (motivo interno: ${recortar(motivo, 60)})` : '';
        // Una imagen que la propia cola descartó como «no es un pago» (afiche, foto, captura de chat, listado) no es ruido
        // para la escuela ni debe contarse aunque el OCR haya leído un número, salvo que algo diga que era un pago.
        if (NO_ES_UN_PAGO.test(motivo) && !senales.conceptoEsperado && !senales.textoDePago) return { tipo: 'ruido' };
        if (montoDe(f.monto) !== null) {
            return {
                tipo: 'sin_desenlace',
                motivo: `Se cerró sin avisarle a nadie aunque se leyó un monto${porque}`,
                queHacer: 'Abrir la conversación, confirmar si es un pago real y registrarlo.',
            };
        }
        // `ocr_omitido` y `contacto_no_atendido` cierran SIN bajar el archivo (no hay `storage_path`): con la señal de
        // que se esperaba un pago también cuentan; eran justo los comprobantes de la ráfaga que nadie vio.
        if ((f.storage_path || SIN_ARCHIVO_GUARDADO.test(motivo)) && (senales.conceptoEsperado || senales.textoDePago)) {
            const senal = senales.conceptoEsperado ? 'se esperaba un pago de este número' : 'el cliente dijo que pagó';
            return {
                tipo: 'sin_desenlace',
                motivo: `Se cerró sin avisarle a nadie y ${senal}${porque}`,
                queHacer: 'Abrir la conversación, mirar el archivo y registrar el pago si corresponde.',
            };
        }
        return { tipo: 'ruido' };
    }
    return { tipo: 'ruido' };
}

// ─── Secciones (puras) ───────────────────────────────────────────────────────

const ES_ARCHIVO = new Set(['image', 'document']);
const ES_TEXTO_O_BOTON = new Set(['text', 'interactive', 'button']);

interface Indices {
    porConversacion: Map<string, MensajeV[]>;
    convPorId: Map<string, ConversacionV>;
    convPorTelefono: Map<string, ConversacionV>;
}

/** Ordena los mensajes por conversación y momento. Pura. */
export function indexar(mensajes: readonly MensajeV[], conversaciones: readonly ConversacionV[]): Indices {
    const porConversacion = new Map<string, MensajeV[]>();
    for (const m of mensajes) {
        const l = porConversacion.get(m.conversation_id);
        if (l) l.push(m); else porConversacion.set(m.conversation_id, [m]);
    }
    for (const l of porConversacion.values()) l.sort((a, b) => momento(a) - momento(b));
    const convPorId = new Map(conversaciones.map((c) => [c.id, c]));
    const convPorTelefono = new Map<string, ConversacionV>();
    for (const c of conversaciones) {
        const t = ultimos10(c.contact_wa_id);
        if (t && !convPorTelefono.has(t)) convPorTelefono.set(t, c);
    }
    return { porConversacion, convPorId, convPorTelefono };
}

const seccion = (items: Item[]): Seccion => ({ total: items.length, items });

/** 1. Comprobantes sin desenlace. Pura. */
export function comprobantesSinDesenlace(p: {
    cola: readonly FilaDeCola[]; conceptos: readonly ConceptoVivo[] | null; indices: Indices; ahora: number;
}): Seccion & { pesos: number } {
    const esperan = new Map<string, ConceptoVivo>();
    for (const c of p.conceptos ?? []) {
        if (c.vence_en && Date.parse(c.vence_en) < p.ahora) continue;
        const t = ultimos10(c.telefono);
        if (t && !esperan.has(t)) esperan.set(t, c);
    }
    const items: Item[] = [];
    let total = 0;
    for (const f of p.cola) {
        if (!ES_ARCHIVO.has(String(f.message_type))) continue;
        const tel = ultimos10(f.wa_phone_number);
        const conv = p.indices.convPorTelefono.get(tel) ?? null;
        const t = Date.parse(f.created_at) || 0;
        const entrantes = conv ? (p.indices.porConversacion.get(conv.id) ?? []).filter((m) => m.direction === 'inbound') : [];
        // «Texto de pago»: el pie del archivo, o un mensaje del cliente a menos de 2 h del archivo.
        const cerca = entrantes.filter((m) => Math.abs(momento(m) - t) <= 2 * HORA_MS && ES_TEXTO_O_BOTON.has(String(m.type)));
        const aviso = cerca.find((m) => clasificarEntrante(m.text_body) === 'aviso_pago');
        const textoDePago = Boolean(aviso) || clasificarEntrante(f.media_caption) === 'aviso_pago';
        const esperado = esperan.get(tel) ?? null;
        const d = desenlaceDeComprobante(f, { conceptoEsperado: Boolean(esperado), textoDePago }, p.ahora);
        if (d.tipo !== 'sin_desenlace') continue;
        const monto = montoDe(f.monto) ?? montoDe(esperado?.monto);
        if (monto !== null) total += monto;
        const dicho = f.media_caption || aviso?.text_body || cerca[cerca.length - 1]?.text_body || '';
        items.push({
            contacto: contactoCorto(conv?.contact_name, f.wa_phone_number),
            hora: horaCot(t), t, monto,
            dijo: recortar(dicho) || '(envió el archivo sin texto)',
            motivo: d.motivo + (esperado?.motivo ? ` · se esperaba: ${recortar(esperado.motivo, 40)}` : ''),
            queHacer: d.queHacer,
        });
    }
    items.sort((a, b) => (b.monto ?? 0) - (a.monto ?? 0) || a.t - b.t);
    return { total: items.length, items, pesos: total };
}

/** 2. Lo que el bot le pasó a la escuela y ninguna persona contestó en N horas hábiles. Pura. */
export function derivacionesSinRespuesta(p: {
    indices: Indices; desde: number; ahora: number; horasHabiles?: number;
}): Seccion {
    const limite = p.horasHabiles ?? PARAMETROS.horasHabilesParaResponder;
    const items: Item[] = [];
    for (const [convId, lista] of p.indices.porConversacion) {
        const conv = p.indices.convPorId.get(convId);
        if (conv?.status === 'closed') continue; // la escuela la cerró a mano: caso atendido
        // La primera derivación que quedó después de la última respuesta de una persona.
        let primera: MensajeV | null = null;
        for (const m of lista) {
            if (esSalienteHumano(m)) primera = null;
            else if (!primera && esSalienteDelBot(m) && esPasoDeDerivacion(m.step) && momento(m) >= p.desde) primera = m;
        }
        if (!primera) continue;
        const t = momento(primera);
        const habiles = horasHabilesEntre(t, p.ahora);
        if (habiles < limite) continue;
        const antes = [...lista].reverse().find((m) => m.direction === 'inbound' && momento(m) <= t && String(m.text_body ?? '').trim());
        const despues = lista.find((m) => m.direction === 'inbound' && momento(m) > t && String(m.text_body ?? '').trim());
        const dicho = antes ?? despues;
        items.push({
            contacto: contactoCorto(conv?.contact_name, conv?.contact_wa_id),
            hora: horaCot(t), t, monto: null,
            dijo: recortar(dicho?.text_body) || '(sin texto del cliente en el rango)',
            motivo: `El bot le dijo que la escuela le contestaba (${primera.step}) y nadie le ha escrito en ${Math.floor(habiles)} h hábiles`,
            queHacer: 'Pedirle a la escuela que le conteste hoy, o contestarle con ella.',
        });
    }
    return seccion(items.sort((a, b) => a.t - b.t));
}

/** 3. Preguntas y avisos de pago sin NINGÚN saliente en 30 minutos. Una fila por conversación. Pura. */
export function clientesSinRespuesta(p: {
    indices: Indices; desde: number; ahora: number; minutos?: number;
}): Seccion {
    const espera = (p.minutos ?? PARAMETROS.minutosSinRespuesta) * 60_000;
    const items: Item[] = [];
    for (const [convId, lista] of p.indices.porConversacion) {
        const conv = p.indices.convPorId.get(convId);
        const salientes = lista.filter((m) => m.direction === 'outbound' && !esAutomatico(m));
        const sueltos: { m: MensajeV; tipo: TipoDeEntrante }[] = [];
        for (const m of lista) {
            if (m.direction !== 'inbound' || !ES_TEXTO_O_BOTON.has(String(m.type))) continue;
            const t = momento(m);
            if (t < p.desde || t > p.ahora - espera) continue; // todavía está dentro de su media hora
            if (salientes.some((s) => momento(s) > t && momento(s) <= t + espera)) continue;
            const tipo = clasificarEntrante(m.text_body);
            if (tipo) sueltos.push({ m, tipo });
        }
        if (!sueltos.length) continue;
        // El aviso de pago manda sobre la pregunta; dentro del mismo tipo, el primero.
        const elegido = sueltos.find((s) => s.tipo === 'aviso_pago') ?? sueltos[0];
        const t = momento(elegido.m);
        const respuesta = salientes.find((s) => momento(s) > t);
        const humanoAntes = lista.some((s) => esSalienteHumano(s) && momento(s) < t && momento(s) >= t - 12 * HORA_MS);
        const tomada = conv?.tomada_hasta ? Date.parse(conv.tomada_hasta) > t : false;
        const silencio = humanoAntes || tomada;
        const estado = respuesta
            ? `le contestaron ${Math.round((momento(respuesta) - t) / 60_000)} min después`
            : 'sigue sin respuesta';
        items.push({
            contacto: contactoCorto(conv?.contact_name, conv?.contact_wa_id),
            hora: horaCot(t), t, monto: null,
            dijo: recortar(elegido.m.text_body),
            motivo: `${elegido.tipo === 'aviso_pago' ? 'Avisó de un pago' : 'Hizo una pregunta'} y ${estado}`
                + (sueltos.length > 1 ? ` (${sueltos.length} mensajes así)` : '')
                + (silencio ? ' · el bot calló porque una persona de la escuela venía atendiendo' : ''),
            queHacer: respuesta
                ? 'Revisar que la respuesta tardía sí resolvió lo que pidió.'
                : (elegido.tipo === 'aviso_pago'
                    ? 'Buscar el comprobante, registrar el pago y confirmarle.'
                    : (silencio ? 'Avisarle a la escuela: la persona que atendía no volvió.' : 'Contestarle hoy; revisar por qué el bot no respondió.')),
        });
    }
    // Primero los que siguen sin respuesta; dentro de cada grupo, el más viejo.
    const sinResp = (i: Item) => (i.motivo.includes('sigue sin respuesta') ? 0 : 1);
    return seccion(items.sort((a, b) => sinResp(a) - sinResp(b) || a.t - b.t));
}

/** 4. Afirmaciones del bot por verificar. Pura. */
export function afirmacionesPorVerificar(p: { indices: Indices; desde: number; pasos?: readonly string[] }): Seccion {
    const items: Item[] = [];
    for (const [convId, lista] of p.indices.porConversacion) {
        const conv = p.indices.convPorId.get(convId);
        for (const m of lista) {
            const t = momento(m);
            if (t < p.desde) continue;
            const frase = afirmacionPorVerificar(m, p.pasos);
            if (!frase) continue;
            items.push({
                contacto: contactoCorto(conv?.contact_name, conv?.contact_wa_id),
                hora: horaCot(t), t, monto: null,
                dijo: recortar(m.text_body),
                motivo: `El bot afirmó «${frase}» en un paso de texto libre (${m.step ?? 'sin paso'}): el código no garantiza que haya pasado`,
                queHacer: 'Comprobar en la app que lo que dijo existe (reserva, registro, cupo). Si no, hacerlo y avisarle al cliente.',
            });
        }
    }
    return seccion(items.sort((a, b) => a.t - b.t));
}

/** 5. El mismo texto del bot N o más veces a la misma conversación en M minutos. Pura. */
export function repeticionesDelBot(p: { indices: Indices; desde: number; veces?: number; minutos?: number }): Seccion {
    const veces = p.veces ?? PARAMETROS.vecesRepetido;
    const ventana = (p.minutos ?? PARAMETROS.minutosDeRepeticion) * 60_000;
    const items: Item[] = [];
    for (const [convId, lista] of p.indices.porConversacion) {
        const conv = p.indices.convPorId.get(convId);
        const porTexto = new Map<string, MensajeV[]>();
        for (const m of lista) {
            if (!esSalienteDelBot(m) || momento(m) < p.desde) continue;
            const clave = normalizar(m.text_body);
            if (clave.length < 12) continue;
            const l = porTexto.get(clave);
            if (l) l.push(m); else porTexto.set(clave, [m]);
        }
        for (const iguales of porTexto.values()) {
            if (iguales.length < veces) continue;
            let mejor = 0;
            let inicio = 0;
            for (let i = 0, j = 0; i < iguales.length; i++) {
                while (momento(iguales[i]) - momento(iguales[j]) > ventana) j++;
                if (i - j + 1 > mejor) { mejor = i - j + 1; inicio = j; }
            }
            if (mejor < veces) continue;
            const primero = iguales[inicio];
            const t = momento(primero);
            items.push({
                contacto: contactoCorto(conv?.contact_name, conv?.contact_wa_id),
                hora: horaCot(t), t, monto: null,
                dijo: recortar(primero.text_body),
                motivo: `El bot le envió ${mejor} veces el mismo mensaje en menos de ${p.minutos ?? PARAMETROS.minutosDeRepeticion} min (${primero.step ?? 'sin paso'})`,
                queHacer: 'Revisar el bucle en ese paso y disculparse con el cliente si hace falta.',
            });
        }
    }
    return seccion(items.sort((a, b) => a.t - b.t));
}

/** El mensaje del vigilante con la forma que lee la regla del silencio (`FilaReciente`). Pura. */
function comoFilaReciente(m: MensajeV): FilaReciente {
    return {
        direction: m.direction, type: m.type, text_body: m.text_body, ai_generated: m.ai_generated,
        wa_timestamp: m.wa_timestamp, created_at: m.created_at,
        payload: {
            ...(m.step ? { step: m.step } : {}),
            ...(m.automatico !== undefined && m.automatico !== null ? { automatico: m.automatico } : {}),
            ...(m.manual === true || m.manual === 'true' ? { manual: true } : {}),
            ...(m.campana ? { campana_id: m.campana } : {}),
        },
    };
}

/**
 * 6. Preguntas y avisos de pago que quedaron SIN DUEÑO durante un silencio: una persona de la escuela escribió
 * (12 h; 72 h si el contacto es un desconocido) y por eso el bot calló, pero después nadie contestó. Un caso por
 * conversación (el aviso de pago manda sobre la pregunta; dentro del mismo tipo, el más viejo). Solo lo que llegó
 * desde `desde`, como las secciones 3 a 5. Sin lecturas nuevas: usa los mensajes que el vigilante ya leyó. Pura.
 */
export function entrantesSinDuenoDelSilencio(p: { indices: Indices; desde: number; ahora: number }): Seccion {
    const items: Item[] = [];
    for (const [convId, lista] of p.indices.porConversacion) {
        const conv = p.indices.convPorId.get(convId);
        const sueltos = entrantesSinDuenoEnSilencio(lista.map(comoFilaReciente), p.ahora, { desconocido: !conv?.parent_id })
            .filter((e) => momento(e.fila as any) >= p.desde);
        if (!sueltos.length) continue;
        const elegido = sueltos.find((e) => e.motivo === 'aviso_de_pago') ?? sueltos[0];
        const t = momento(elegido.fila as any);
        const horas = Math.max(1, Math.round(elegido.minutosEsperando / 60));
        items.push({
            contacto: contactoCorto(conv?.contact_name, conv?.contact_wa_id),
            hora: horaCot(t), t, monto: null,
            dijo: recortar(elegido.fila.text_body) || `(${elegido.fila.type ?? 'archivo'} sin texto)`,
            motivo: `${elegido.motivo === 'aviso_de_pago' ? 'Avisó de un pago' : 'Hizo una pregunta'} después de que la escuela escribió y nadie le ha contestado en ${horas} h`
                + (sueltos.length > 1 ? ` (${sueltos.length} mensajes así)` : ''),
            queHacer: elegido.motivo === 'aviso_de_pago'
                ? 'Avisarle a la escuela: buscar el comprobante, registrar el pago y confirmarle.'
                : 'Avisarle a la escuela: la persona que atendía no volvió; contestarle hoy.',
        });
    }
    return seccion(items.sort((a, b) => a.t - b.t));
}

export interface DatosDeEscuela {
    cola: readonly FilaDeCola[];
    conceptos: readonly ConceptoVivo[] | null;
    conversaciones: readonly ConversacionV[];
    mensajes: readonly MensajeV[];
    recortado: boolean;
    consultas: number;
}

export interface Ventana {
    /** Instante en que se arma el informe (ms). */
    ahora: number;
    /** Desde cuándo cuentan «los números del día» y las secciones 3, 4 y 5 (ms). */
    desde: number;
}

/**
 * La ventana del informe de un día: las últimas 24 h, o 48 h si es lunes (el
 * domingo no hay informe). Pura.
 */
export function ventanaDelInforme(ahora: number): Ventana {
    const lunes = new Date(ahora - COT_MS).getUTCDay() === 1;
    return { ahora, desde: ahora - (lunes ? 48 : 24) * HORA_MS };
}

/** Arma el informe de un número con todo ya leído. Pura. */
export function armarInformeEscuela(
    quien: { integrationId: string; schoolId: string; escuela: string },
    datos: DatosDeEscuela,
    v: Ventana,
): InformeEscuela {
    const indices = indexar(datos.mensajes, datos.conversaciones);
    const desdeMensajes = v.ahora - PARAMETROS.horasDeMensajes * HORA_MS;
    const comprobantes = comprobantesSinDesenlace({ cola: datos.cola, conceptos: datos.conceptos, indices, ahora: v.ahora });
    const derivaciones = derivacionesSinRespuesta({ indices, desde: desdeMensajes, ahora: v.ahora });
    const clientes = clientesSinRespuesta({ indices, desde: v.desde, ahora: v.ahora });
    const afirmaciones = afirmacionesPorVerificar({ indices, desde: v.desde });
    const repeticiones = repeticionesDelBot({ indices, desde: v.desde });
    const sinDueno = entrantesSinDuenoDelSilencio({ indices, desde: v.desde, ahora: v.ahora });

    const delDia = datos.cola.filter((f) => ES_ARCHIVO.has(String(f.message_type)) && (Date.parse(f.created_at) || 0) >= v.desde);
    const enCobro = delDia.filter((f) => desenlaceDeComprobante(f, { conceptoEsperado: false, textoDePago: false }, v.ahora).tipo === 'cobro').length;
    return {
        ...quien, error: null, recortado: datos.recortado, consultas: datos.consultas,
        numeros: {
            archivosRecibidos: delDia.length,
            terminaronEnCobro: enCobro,
            pctCobro: delDia.length ? Math.round((enCobro / delDia.length) * 100) : null,
            comprobantesSinDesenlace: comprobantes.total,
            pesosSinDesenlace: comprobantes.pesos,
            preguntasSinRespuesta: derivaciones.total,
            clientesSinRespuesta: clientes.total,
        },
        comprobantes, derivaciones, clientes, afirmaciones, repeticiones, sinDueno,
    };
}

/** El informe de una escuela que no se pudo revisar. Pura. */
export function informeFallido(quien: { integrationId: string; schoolId: string; escuela: string }, error: string, consultas = 0): InformeEscuela {
    const vacia = (): Seccion => ({ total: 0, items: [] });
    return {
        ...quien, error: recortar(error, 200) || 'error desconocido', recortado: false, consultas,
        numeros: {
            archivosRecibidos: 0, terminaronEnCobro: 0, pctCobro: null, comprobantesSinDesenlace: 0,
            pesosSinDesenlace: 0, preguntasSinRespuesta: 0, clientesSinRespuesta: 0,
        },
        comprobantes: { ...vacia(), pesos: 0 }, derivaciones: vacia(), clientes: vacia(), afirmaciones: vacia(), repeticiones: vacia(), sinDueno: vacia(),
    };
}

/** ¿La escuela tiene algo que reportar? Pura. */
export function tieneHallazgos(e: InformeEscuela): boolean {
    return Boolean(e.error) || e.comprobantes.total + e.derivaciones.total + e.clientes.total + e.afirmaciones.total + e.repeticiones.total + e.sinDueno.total > 0;
}

// ─── El texto para la escuela (NO se envía todavía) ──────────────────────────

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/**
 * El resumen de SU escuela, corto y sin jerga. Devuelve null si no hay nada que
 * contarle. Solo lo que ella puede resolver: las secciones 4 y 5 (afirmaciones
 * y repeticiones del bot) son internas de SportMaps y no entran. Pura.
 *
 * NO se envía desde ningún lado: el envío a escuelas es una decisión de
 * producto pendiente.
 */
export function resumenParaEscuela(e: InformeEscuela): string | null {
    if (e.error) return null;
    const esperando = e.derivaciones.total + e.clientes.items.filter((i) => i.motivo.includes('sigue sin respuesta')).length;
    const comprobantes = e.comprobantes.total;
    if (!comprobantes && !esperando) return null;
    const partes: string[] = [];
    if (comprobantes) partes.push(plural(comprobantes, 'comprobante por revisar', 'comprobantes por revisar'));
    if (esperando) partes.push(plural(esperando, 'persona esperando respuesta', 'personas esperando respuesta'));
    const lineas = [`Hola. En el WhatsApp de ${e.escuela} tienes ${partes.join(' y ')}.`];
    if (comprobantes && e.comprobantes.pesos > 0) {
        lineas.push(`Los comprobantes suman ${pesos(e.comprobantes.pesos)} que todavía no están registrados.`);
    }
    const nombres = [...new Set([...e.derivaciones.items, ...e.clientes.items.filter((i) => i.motivo.includes('sigue sin respuesta'))]
        .map((i) => i.contacto))].slice(0, 5);
    if (nombres.length) lineas.push(`Te esperan: ${nombres.join(', ')}${esperando > nombres.length ? ' y otros' : ''}.`);
    lineas.push(`Los encuentras en SportMaps, en WhatsApp: ${ORIGEN_APP}/whatsapp`);
    return lineas.join('\n');
}

// ─── El correo al equipo de SportMaps (puro) ─────────────────────────────────

const SECCIONES: { clave: 'comprobantes' | 'derivaciones' | 'clientes' | 'afirmaciones' | 'repeticiones' | 'sinDueno'; titulo: string }[] = [
    { clave: 'comprobantes', titulo: '1. Comprobantes sin desenlace' },
    { clave: 'derivaciones', titulo: '2. Preguntas pasadas a la escuela sin respuesta' },
    { clave: 'clientes', titulo: '3. Clientes sin respuesta (30 min)' },
    { clave: 'afirmaciones', titulo: '4. Afirmaciones del bot por verificar' },
    { clave: 'repeticiones', titulo: '5. Repeticiones' },
    { clave: 'sinDueno', titulo: '6. Preguntas y avisos de pago que quedaron sin dueño durante un silencio' },
];

export function totales(inf: InformeVigilante) {
    const t = { comprobantes: 0, pesos: 0, derivaciones: 0, clientes: 0, afirmaciones: 0, repeticiones: 0, sinDueno: 0, sinRevisar: 0, conHallazgos: 0 };
    for (const e of inf.escuelas) {
        if (e.error) t.sinRevisar++;
        if (tieneHallazgos(e)) t.conHallazgos++;
        t.comprobantes += e.comprobantes.total;
        t.pesos += e.comprobantes.pesos;
        t.derivaciones += e.derivaciones.total;
        t.clientes += e.clientes.total;
        t.afirmaciones += e.afirmaciones.total;
        t.repeticiones += e.repeticiones.total;
        t.sinDueno += e.sinDueno.total;
    }
    return t;
}

/** ¿No hay nada que reportar en ninguna escuela? Pura. */
export const sinNovedades = (inf: InformeVigilante): boolean => !inf.escuelas.some(tieneHallazgos);

export function asuntoDelCorreo(inf: InformeVigilante): string {
    if (sinNovedades(inf)) return `[Vigilante WhatsApp] ${inf.fecha}: sin novedades (${inf.escuelas.length} escuela(s) revisadas)`;
    const t = totales(inf);
    const partes = [
        t.comprobantes ? `${plural(t.comprobantes, 'comprobante', 'comprobantes')} sin desenlace${t.pesos ? ` (${pesos(t.pesos)})` : ''}` : '',
        t.derivaciones ? `${plural(t.derivaciones, 'pregunta', 'preguntas')} sin respuesta de la escuela` : '',
        t.clientes ? `${plural(t.clientes, 'cliente', 'clientes')} sin respuesta` : '',
        t.afirmaciones ? `${plural(t.afirmaciones, 'afirmación', 'afirmaciones')} por verificar` : '',
        t.repeticiones ? `${plural(t.repeticiones, 'repetición', 'repeticiones')}` : '',
        t.sinDueno ? `${plural(t.sinDueno, 'pregunta o aviso de pago', 'preguntas o avisos de pago')} sin dueño en un silencio` : '',
        t.sinRevisar ? `${plural(t.sinRevisar, 'escuela', 'escuelas')} sin revisar` : '',
    ].filter(Boolean);
    return `[Revisar] Vigilante WhatsApp ${inf.fecha}: ${partes.join(' · ')}`;
}

const lineaDeNumeros = (e: InformeEscuela): string => e.error
    ? `${e.escuela}: NO SE PUDO REVISAR (${e.error})`
    : `${e.escuela}: ${e.numeros.archivosRecibidos} archivos recibidos · ${e.numeros.pctCobro === null ? 'sin archivos' : `${e.numeros.pctCobro} % terminó en cobro`}`
        + ` · ${e.numeros.comprobantesSinDesenlace} comprobantes sin desenlace${e.numeros.pesosSinDesenlace ? ` (${pesos(e.numeros.pesosSinDesenlace)})` : ''}`
        + ` · ${e.numeros.preguntasSinRespuesta} preguntas sin respuesta · ${e.numeros.clientesSinRespuesta} clientes sin respuesta`
        + (e.recortado ? ' · datos recortados: los números son un piso' : '');

const lineaDeItem = (i: Item): string =>
    `${i.contacto} · ${i.hora}${i.monto !== null ? ` · ${pesos(i.monto)}` : ''} · «${i.dijo}» · ${i.motivo} → ${i.queHacer}`;

/** El correo en texto plano (respaldo del HTML y salida del script manual). Pura. */
export function lineasDelCorreo(inf: InformeVigilante): string[] {
    const l: string[] = [];
    if (!inf.escuelas.length) return ['El vigilante corrió y no encontró ningún número de WhatsApp activo.'];
    if (sinNovedades(inf)) {
        l.push(`El vigilante corrió y revisó ${inf.escuelas.length} escuela(s): no quedó nada sin desenlace.`);
    }
    l.push('— Números del día por escuela —');
    for (const e of inf.escuelas) l.push(lineaDeNumeros(e));
    for (const e of inf.escuelas) {
        if (!tieneHallazgos(e) || e.error) continue;
        l.push(`== ${e.escuela}`);
        for (const s of SECCIONES) {
            const sec = e[s.clave];
            if (!sec.total) continue;
            const pesosSec = s.clave === 'comprobantes' && e.comprobantes.pesos ? ` · ${pesos(e.comprobantes.pesos)}` : '';
            l.push(`${s.titulo}: ${sec.total}${pesosSec}`);
            for (const i of sec.items.slice(0, MAX_FILAS_EN_CORREO)) l.push(`   ${lineaDeItem(i)}`);
            if (sec.total > MAX_FILAS_EN_CORREO) l.push(`   … y ${sec.total - MAX_FILAS_EN_CORREO} más`);
        }
    }
    return l;
}

const td = (s: string | number, extra = '') =>
    `<td style="padding:4px 8px;border-bottom:1px solid #eee;vertical-align:top;${extra}">${escaparHtml(String(s))}</td>`;
const th = (s: string) => `<th style="padding:4px 8px;text-align:left;background:#f6f6f6;">${escaparHtml(s)}</th>`;

/** El correo en HTML. Todo lo que viene de un cliente o del bot va escapado. Sin enlaces a medios. Pura. */
export function htmlDelCorreo(inf: InformeVigilante): string {
    const cabecera = `<h2 style="color:#1a1a1a;margin-top:0;">Vigilante del bot de WhatsApp — ${escaparHtml(inf.fecha)}</h2>`
        + `<p style="color:#666;font-size:12px;">Uso interno de SportMaps. Revisado de ${escaparHtml(horaCot(inf.desde))} a ${escaparHtml(horaCot(inf.hasta))} (hora de Colombia). Los teléfonos van con sus últimos 4 dígitos.</p>`;
    if (!inf.escuelas.length) {
        return `<div style="font-family:Arial,sans-serif;max-width:900px;">${cabecera}<p>El vigilante corrió y no encontró ningún número de WhatsApp activo.</p></div>`;
    }
    const filas = inf.escuelas.map((e) => e.error
        ? `<tr>${td(e.escuela, 'font-weight:bold;')}<td colspan="5" style="padding:4px 8px;border-bottom:1px solid #eee;color:#b00020;">No se pudo revisar: ${escaparHtml(e.error)}</td></tr>`
        : `<tr>${[
            td(e.escuela + (e.recortado ? ' *' : ''), 'font-weight:bold;'),
            td(e.numeros.archivosRecibidos),
            td(e.numeros.pctCobro === null ? '—' : `${e.numeros.pctCobro} %`),
            td(`${e.numeros.comprobantesSinDesenlace}${e.numeros.pesosSinDesenlace ? ` (${pesos(e.numeros.pesosSinDesenlace)})` : ''}`),
            td(e.numeros.preguntasSinRespuesta),
            td(e.numeros.clientesSinRespuesta),
        ].join('')}</tr>`).join('');
    const tabla = `<table style="border-collapse:collapse;font-size:13px;width:100%;"><tr>${[
        'Escuela', 'Archivos recibidos', '% que terminó en cobro', 'Comprobantes sin desenlace', 'Preguntas sin respuesta', 'Clientes sin respuesta',
    ].map(th).join('')}</tr>${filas}</table>`
        + (inf.escuelas.some((e) => e.recortado) ? '<p style="font-size:11px;color:#888;">* Se alcanzó un tope de lectura: los números son un piso.</p>' : '');

    const detalle = inf.escuelas.filter((e) => !e.error && tieneHallazgos(e)).map((e) => {
        const secciones = SECCIONES.map((s) => {
            const sec = e[s.clave];
            if (!sec.total) return '';
            const pesosSec = s.clave === 'comprobantes' && e.comprobantes.pesos ? ` · ${pesos(e.comprobantes.pesos)}` : '';
            const items = sec.items.slice(0, MAX_FILAS_EN_CORREO).map((i) => `<tr>${[
                td(i.contacto), td(i.hora, 'white-space:nowrap;'), td(i.monto !== null ? pesos(i.monto) : ''),
                td(i.dijo, 'color:#4a4a4a;'), td(i.motivo), td(i.queHacer, 'font-weight:bold;'),
            ].join('')}</tr>`).join('');
            const resto = sec.total > MAX_FILAS_EN_CORREO
                ? `<p style="font-size:12px;color:#888;margin:4px 0 0;">… y ${sec.total - MAX_FILAS_EN_CORREO} más.</p>` : '';
            return `<h4 style="margin:14px 0 4px;">${escaparHtml(s.titulo)}: ${sec.total}${escaparHtml(pesosSec)}</h4>`
                + `<table style="border-collapse:collapse;font-size:12px;width:100%;"><tr>${['Contacto', 'Hora', 'Monto', 'Qué dijo', 'Qué pasó', 'Qué hacer'].map(th).join('')}</tr>${items}</table>${resto}`;
        }).join('');
        return `<h3 style="margin-top:24px;border-top:2px solid #248223;padding-top:10px;">${escaparHtml(e.escuela)}</h3>${secciones}`;
    }).join('');

    const nada = sinNovedades(inf)
        ? `<p style="font-size:14px;"><strong>Sin novedades.</strong> El vigilante corrió y revisó ${inf.escuelas.length} escuela(s): no quedó nada sin desenlace.</p>` : '';
    const boton = `<p style="margin-top:20px;"><a href="${ORIGEN_APP}/whatsapp?tab=conversaciones" style="display:inline-block;padding:10px 20px;background:#FB9F1E;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Abrir WhatsApp en SportMaps</a></p>`;
    return `<div style="font-family:Arial,sans-serif;max-width:900px;">${cabecera}${nada}<h3>Números del día por escuela</h3>${tabla}${detalle}${boton}</div>`;
}

// ─── Lecturas ────────────────────────────────────────────────────────────────

interface Integracion { id: string; school_id: string; nombre: string | null }

const COLS_COLA = 'id, wa_phone_number, message_type, status, result_type, error_message, storage_path, media_caption, '
    + 'created_at, updated_at, processed_at, pregunta_at, monto:pregunta_ocr->ocr->>amount, tipo:pregunta_ocr->>tipo';
const COLS_MENSAJE = 'id, conversation_id, direction, type, text_body, ai_generated, wa_timestamp, created_at, '
    + 'step:payload->>step, automatico:payload->automatico, manual:payload->manual, campana:payload->>campana_id';

/**
 * Lee lo de UN número. Lanza si falla una lectura necesaria (quien llama lo
 * convierte en «no se pudo revisar»); la de conceptos esperados es opcional.
 *
 * Consultas: 3 fijas + los lotes de mensajes (1 en una escuela normal; tope
 * MAX_CONSULTAS_DE_MENSAJES).
 */
export async function leerDatosDeEscuela(integ: Integracion, ahora: number): Promise<DatosDeEscuela> {
    let consultas = 0;
    let recortado = false;
    const desdeCola = new Date(ahora - PARAMETROS.diasDeCola * 24 * HORA_MS).toISOString();
    const desdeMensajes = new Date(ahora - PARAMETROS.horasDeMensajes * HORA_MS).toISOString();

    consultas += 3;
    const [cola, conceptos, convs] = await Promise.all([
        supabase.from('whatsapp_inbound_queue').select(COLS_COLA)
            .eq('school_id', integ.school_id) // la cola tiene índice por escuela, no por integración
            .eq('integration_id', integ.id)
            .in('message_type', ['image', 'document'])
            .gte('created_at', desdeCola)
            .order('created_at', { ascending: false })
            .limit(MAX_FILAS_DE_COLA),
        supabase.from('whatsapp_conceptos_esperados').select('telefono, motivo, monto, vence_en')
            .eq('school_id', integ.school_id)
            .is('consumido_at', null)
            .limit(MAX_CONCEPTOS),
        supabase.from('whatsapp_conversations').select('id, contact_wa_id, contact_name, status, tomada_hasta, parent_id')
            .eq('integration_id', integ.id)
            .gte('last_message_at', desdeMensajes)
            .order('last_message_at', { ascending: false })
            .limit(MAX_CONVERSACIONES),
    ]);
    if (cola.error) throw new Error(`cola: ${cola.error.message}`);
    if (convs.error) throw new Error(`conversaciones: ${convs.error.message}`);
    const filasDeCola = (cola.data ?? []) as unknown as FilaDeCola[];
    const conversaciones = (convs.data ?? []) as unknown as ConversacionV[];
    if (filasDeCola.length >= MAX_FILAS_DE_COLA || conversaciones.length >= MAX_CONVERSACIONES) recortado = true;

    const mensajes: MensajeV[] = [];
    const ids = conversaciones.map((c) => c.id);
    let consultasDeMensajes = 0;
    lotes: for (let i = 0; i < ids.length; i += CONVS_POR_LOTE) {
        const lote = ids.slice(i, i + CONVS_POR_LOTE);
        for (let pagina = 0; pagina < MAX_PAGINAS_POR_LOTE; pagina++) {
            if (consultasDeMensajes >= MAX_CONSULTAS_DE_MENSAJES) { recortado = true; break lotes; }
            consultasDeMensajes++;
            const { data, error } = await supabase.from('whatsapp_messages').select(COLS_MENSAJE)
                .in('conversation_id', lote)
                .gte('created_at', desdeMensajes)
                .order('created_at', { ascending: true })
                .range(pagina * PAGINA, pagina * PAGINA + PAGINA - 1);
            if (error) throw new Error(`mensajes: ${error.message}`);
            const filas = (data ?? []) as unknown as MensajeV[];
            mensajes.push(...filas);
            if (filas.length < PAGINA) break;
            if (pagina === MAX_PAGINAS_POR_LOTE - 1) recortado = true;
        }
    }
    consultas += consultasDeMensajes;

    return {
        cola: filasDeCola,
        conceptos: conceptos.error ? null : ((conceptos.data ?? []) as unknown as ConceptoVivo[]),
        conversaciones, mensajes, recortado, consultas,
    };
}

/**
 * Arma el informe de todas las escuelas con WhatsApp activo, como si fuera el
 * instante `ahora`. Nunca lanza: una escuela que falla queda como «no se pudo
 * revisar» y las demás siguen. Las escuelas van una tras otra, no en paralelo,
 * para no cargar la base.
 */
export async function armarInformeVigilante(ahora: number = Date.now()): Promise<InformeVigilante> {
    const v = ventanaDelInforme(ahora);
    const inf: InformeVigilante = {
        fecha: fechaCot(ahora), desde: new Date(v.desde).toISOString(), hasta: new Date(ahora).toISOString(), escuelas: [], consultas: 0,
    };
    try {
        inf.consultas++;
        const { data: integraciones, error } = await supabase.from('school_whatsapp_integrations')
            .select('id, school_id, nombre').eq('status', 'active').limit(500);
        if (error) throw new Error(error.message);
        const lista = (integraciones ?? []) as unknown as Integracion[];
        if (!lista.length) return inf;

        const nombres = new Map<string, string>();
        try {
            inf.consultas++;
            const { data } = await supabase.from('schools').select('id, name')
                .in('id', [...new Set(lista.map((i) => i.school_id))]).limit(500);
            for (const s of (data ?? []) as any[]) nombres.set(s.id, String(s.name ?? ''));
        } catch { /* sin nombres: sale el id */ }
        const porEscuela = new Map<string, number>();
        for (const i of lista) porEscuela.set(i.school_id, (porEscuela.get(i.school_id) ?? 0) + 1);

        for (const integ of lista) {
            const base = nombres.get(integ.school_id) || `Escuela ${integ.school_id.slice(0, 8)}`;
            // Una escuela con dos números activos: se distinguen por el nombre del número.
            const escuela = (porEscuela.get(integ.school_id) ?? 0) > 1 && integ.nombre ? `${base} — ${integ.nombre}` : base;
            const quien = { integrationId: integ.id, schoolId: integ.school_id, escuela };
            try {
                const datos = await leerDatosDeEscuela(integ, ahora);
                const e = armarInformeEscuela(quien, datos, v);
                inf.consultas += e.consultas;
                inf.escuelas.push(e);
            } catch (err: any) {
                console.error('[vigilante-wa] no se pudo revisar la escuela', { schoolId: integ.school_id, error: err?.message || String(err) });
                inf.escuelas.push(informeFallido(quien, err?.message || String(err)));
            }
        }
        // Arriba, lo que más pesa: las que no se pudieron revisar y las de más plata sin registrar.
        inf.escuelas.sort((a, b) => Number(Boolean(b.error)) - Number(Boolean(a.error))
            || b.comprobantes.pesos - a.comprobantes.pesos
            || (b.comprobantes.total + b.derivaciones.total + b.clientes.total) - (a.comprobantes.total + a.derivaciones.total + a.clientes.total));
    } catch (err: any) {
        console.error('[vigilante-wa] no se pudieron leer las integraciones', { error: err?.message || String(err) });
        inf.escuelas.push(informeFallido({ integrationId: '', schoolId: '', escuela: 'Todas las escuelas' }, `no se pudieron leer los números activos: ${err?.message || String(err)}`));
    }
    return inf;
}

// ─── A mano, con una fecha ───────────────────────────────────────────────────

/** El instante en que corre el vigilante el día `fecha` ('YYYY-MM-DD', Colombia): las 7:15 a. m. Pura. */
export function instanteDeLaCorrida(fecha: string): number | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
    const t = Date.parse(`${fecha}T07:15:00Z`);
    return Number.isFinite(t) ? t + COT_MS : null;
}

export interface Vigilancia {
    informe: InformeVigilante;
    asunto: string;
    lineas: string[];
    html: string;
    /** El texto que le llegaría a cada escuela (por integración), si hubiera algo que decirle. NO se envía. */
    paraEscuelas: { integrationId: string; schoolId: string; escuela: string; texto: string }[];
}

/**
 * Para llamar a mano: el informe como habría salido la mañana de `fecha`
 * ('YYYY-MM-DD'). NO envía nada. Nunca lanza.
 *
 * Ojo con fechas pasadas: los mensajes sí se leen «como eran», pero el estado
 * de la cola es el de HOY (un comprobante que ya se resolvió no aparece).
 */
export async function vigilarFecha(fecha: string): Promise<Vigilancia | null> {
    const ahora = instanteDeLaCorrida(fecha);
    if (ahora === null) return null;
    return vigilar(ahora);
}

/** Igual que `vigilarFecha`, con el instante exacto. NO envía nada. Nunca lanza. */
export async function vigilar(ahora: number = Date.now()): Promise<Vigilancia> {
    const informe = await armarInformeVigilante(ahora);
    const paraEscuelas: Vigilancia['paraEscuelas'] = [];
    for (const e of informe.escuelas) {
        const texto = resumenParaEscuela(e);
        if (texto) paraEscuelas.push({ integrationId: e.integrationId, schoolId: e.schoolId, escuela: e.escuela, texto });
    }
    return { informe, asunto: asuntoDelCorreo(informe), lineas: lineasDelCorreo(informe), html: htmlDelCorreo(informe), paraEscuelas };
}

// ─── La corrida diaria ───────────────────────────────────────────────────────

/** La clave de deduplicación: un correo por día (Colombia) entre los tres BFF. Pura. */
export const claveDelVigilante = (fecha: string) => `wa_vigilante:${fecha}`;

export type ResultadoVigilante = 'enviado' | 'duplicado' | 'fallo' | 'apagado' | 'no_toca';

/**
 * La corrida de la mañana. Lunes a sábado; el domingo no corre (lo recoge el
 * lunes, que mira 48 h). Un correo al día al equipo de SportMaps, haya o no
 * novedades (así se sabe que corrió).
 *
 * Antes de leer nada pregunta si el correo de hoy ya está reservado en
 * `email_sends`: los ticks de respaldo y los otros BFF gastan UNA consulta.
 * Nunca lanza.
 */
export async function runWhatsAppVigilante(ahora: number = Date.now(), opts: { forzar?: boolean } = {}): Promise<ResultadoVigilante> {
    if (process.env.DISABLE_WHATSAPP_VIGILANTE === 'true') return 'apagado';
    try {
        if (!opts.forzar && new Date(ahora - COT_MS).getUTCDay() === 0) return 'no_toca';
        const fecha = fechaCot(ahora);
        const clave = claveDelVigilante(fecha);
        const { data: ya } = await supabase.from('email_sends').select('id').eq('id', uuidDeClave(clave)).maybeSingle();
        if (ya) return 'duplicado';

        const v = await vigilar(ahora);
        return await enviarConReserva({
            clave, tipo: 'wa_vigilante', schoolId: null, refId: null,
            destinos: correosDeSoporte(), data: {}, plantilla: null,
            respaldo: { subject: v.asunto, titulo: `Vigilante del bot de WhatsApp — ${fecha}`, lineas: v.lineas, html: v.html },
        });
    } catch (err: any) {
        console.error('[vigilante-wa] falló la corrida:', err?.message || String(err));
        return 'fallo';
    }
}
