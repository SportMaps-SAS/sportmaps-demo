/**
 * Silencio cuando el EQUIPO ya está atendiendo la conversación (corrección A, Monster 2026-11-06).
 *
 * Casos reales:
 *  - La interesada …3191 llevaba ~30 mensajes con el equipo. Hoy 12:17 escribió «Hola / Oye / el entreno
 *    es mixto?» y Mapi mandó el saludo del club con «Elige sede» 8 s antes de que el equipo contestara:
 *    la ventana de silencio normal (`humanoReciente`, `SILENCIO_HUMANO_MIN`) dura minutos.
 *  - Un contacto del equipo que le escribe a «Pipe» por el número del club recibió 4 veces «No soy Pipe…».
 *
 * La regla (pura, sin modelo): si en la conversación hay un DIÁLOGO HUMANO REAL —mensajes salientes de una
 * persona del equipo— y el último es de las últimas 72 h, el bot NO le habla a un contacto DESCONOCIDO
 * (ni saludo del club, ni ficha de entrada, ni embudo). Lo que no se toca: la baja (STOP, la atiende la
 * ruta antes), las respuestas a la pregunta de un comprobante (van antes en `atenderDesconocido`) y todo lo
 * de la familia ya identificada (no pasa por `atenderDesconocido`).
 *
 * Qué NO cuenta como diálogo humano (si contara, se silenciaría a todos los interesados nuevos):
 *  - mensajes del bot (`ai_generated=true`);
 *  - plantillas, campañas, recordatorios y demás de los jobs (llevan `payload.step`, `campana*`, tipo `template`);
 *  - lo que la app WhatsApp Business manda sola (saludo y ausencia): `payload.automatico` (la ingesta lo
 *    marca cuando el mismo texto sale a ≥ 3 contactos) y, para los dos o tres primeros que aún no tienen
 *    la marca, la forma: sale a ≤ 30 s de un entrante, es el PRIMER saliente de la conversación y
 *    parece un saludo/auto-respuesta (`esAutoRespuesta` o saludo + «gracias por escribir»);
 *  - stickers y reacciones.
 * Las respuestas rápidas a mano de la persona (`payload.manual`) sí cuentan.
 *
 * Apagado de emergencia: `WA_SILENCIO_DIALOGO_EQUIPO=false` vuelve al comportamiento anterior.
 */
import { supabase } from '../config/supabase';
import { esAutoRespuesta, normalizarFrase, type FilaReciente } from './whatsapp-reglas-turno';

/** Ventana del diálogo: el último mensaje humano real debe ser de las últimas 72 h. */
export const VENTANA_DIALOGO_HORAS = 72;
/** Un saliente a menos de esto de un entrante, y primero de la conversación, es el saludo de la app. */
export const SALUDO_DE_APP_MS = 30_000;

const momento = (f: FilaReciente) => new Date(f.wa_timestamp || f.created_at || 0).getTime();
const TIPOS_SIN_DIALOGO = new Set(['sticker', 'reaction']);

/** ¿La función está prendida? Por defecto sí. */
export function silencioDeDialogoActivo(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.WA_SILENCIO_DIALOGO_EQUIPO !== 'false';
}

function esAutomaticoMarcado(f: FilaReciente): boolean {
    const a = f.payload?.automatico;
    return a === true || a === 'true';
}

/** Marcas de plantillas, campañas y mensajes de jobs en el payload del saliente. */
function esDeJobOPlantilla(f: FilaReciente): boolean {
    const p = f.payload ?? {};
    if (p.step) return true;
    if (p.campana || p.campana_id || p.campaign_id || p.campaign) return true;
    if (p.template || p.template_name || p.plantilla) return true;
    return String(f.type ?? '') === 'template';
}

/** ¿El texto tiene la forma del saludo/ausencia de la app Business («Hola, gracias por escribir a …»)? */
export function pareceSaludoDeApp(texto: string | null | undefined, configurados: readonly string[] = []): boolean {
    const t = normalizarFrase(texto);
    if (!t) return false;
    if (configurados.some((c) => normalizarFrase(c) === t)) return true;
    if (esAutoRespuesta(texto)) return true;
    return /^(hola|buenas|buenos dias|buen dia|bienvenid[oa]s?)\b/.test(t)
        && /\b(gracias por (escribir|comunicarte|contactar|tu mensaje)|bienvenid[oa]s? a|en que (te|le) (podemos|puedo) ayudar|te (responderemos|atenderemos))\b/.test(t);
}

/**
 * ¿Este saliente lo escribió una PERSONA del equipo como parte de una charla? Pura.
 * `filas`: las de la misma conversación (para reconocer el saludo de la app por su demora y su lugar).
 */
export function esMensajeHumanoReal(
    f: FilaReciente,
    filas: readonly FilaReciente[],
    opts: { saludosConfigurados?: readonly string[] } = {},
): boolean {
    if (f.direction !== 'outbound' || f.ai_generated !== false) return false;
    if (TIPOS_SIN_DIALOGO.has(String(f.type ?? ''))) return false;
    const p = f.payload ?? {};
    if (p.manual === true) return true;          // buzón / plantilla manual de una persona
    if (esAutomaticoMarcado(f) || esDeJobOPlantilla(f)) return false;

    // Saludo de la app aún sin marca: primero de la conversación, a ≤ 30 s de un entrante, con forma de saludo.
    const t = momento(f);
    const esPrimerSaliente = !filas.some((x) => x !== f && x.direction === 'outbound' && momento(x) < t);
    const llegoAlRato = filas.some((x) => x.direction === 'inbound' && momento(x) <= t && t - momento(x) <= SALUDO_DE_APP_MS);
    if (esPrimerSaliente && llegoAlRato && pareceSaludoDeApp(f.text_body, opts.saludosConfigurados)) return false;
    return true;
}

export interface EstadoDeDialogo {
    activo: boolean;
    /** Mensajes humanos reales dentro de la ventana. */
    humanos: number;
    /** Momento (ms) del último mensaje humano real, o null. */
    ultimo: number | null;
}

/** La regla, pura. */
export function estadoDeDialogo(
    filas: readonly FilaReciente[],
    ahora = Date.now(),
    horas = VENTANA_DIALOGO_HORAS,
    opts: { saludosConfigurados?: readonly string[] } = {},
): EstadoDeDialogo {
    const desde = ahora - horas * 3600_000;
    let humanos = 0;
    let ultimo: number | null = null;
    for (const f of filas) {
        if (!esMensajeHumanoReal(f, filas, opts)) continue;
        const t = momento(f);
        if (t < desde || t > ahora + 60_000) continue;
        humanos++;
        if (ultimo === null || t > ultimo) ultimo = t;
    }
    return { activo: humanos > 0, humanos, ultimo };
}

/**
 * Filas de las últimas ~4 días (entrantes y salientes; los entrantes sirven para reconocer el saludo de la app).
 * Una sola consulta, solo para contactos DESCONOCIDOS. Devuelve null si falla (ante el error: como antes).
 */
export async function leerFilasDeDialogo(conversationId: string, ahora = Date.now()): Promise<FilaReciente[] | null> {
    try {
        const desde = new Date(ahora - (VENTANA_DIALOGO_HORAS + 24) * 3600_000).toISOString();
        const { data, error } = await supabase
            .from('whatsapp_messages')
            .select('wa_message_id, direction, type, text_body, payload, ai_generated, wa_timestamp, created_at')
            .eq('conversation_id', conversationId)
            .gte('created_at', desde)
            .order('created_at', { ascending: false })
            .limit(300);
        if (error || !Array.isArray(data)) return null;
        return data as FilaReciente[];
    } catch {
        return null;
    }
}

/**
 * ¿El equipo está en diálogo con este contacto (últimas 72 h)? Nunca lanza; la función apagada o un error
 * de lectura dan false (el bot sigue como antes).
 */
export async function equipoEstaAtendiendo(conversationId: string, ahora = Date.now()): Promise<boolean> {
    if (!silencioDeDialogoActivo()) return false;
    const filas = await leerFilasDeDialogo(conversationId, ahora);
    if (!filas) return false;
    return estadoDeDialogo(filas, ahora).activo;
}

// ─── Lo que quedó sin dueño dentro de un silencio (auditoría 8–16 nov 2026) ──
//
// Cuando una persona de la escuela escribió hace 1–12 h (hasta 72 h con un desconocido) el bot calla a
// propósito: la conversación es de ella. En esa semana hubo 165 mensajes así que nadie retomó, entre
// ellos preguntas de venta: «Por favor confirmar que los dos cupos quedan reservados», «Tienes las
// tarifas de séniors a la mano», «No me han enviado la info de menores / Me puedes ayudar por fa?».
// Las ventanas NO cambian (decisión de producto). Esto solo DICE cuáles quedaron sin respuesta, para
// que un vigilante se lo reporte a la escuela. No envía nada ni está conectado a ningún envío.

/** Horas de silencio tras un mensaje de la escuela: familias (modo discreto) y desconocidos (diálogo del equipo). */
export const HORAS_SILENCIO_FAMILIA = 12;
export const HORAS_SILENCIO_DESCONOCIDO = VENTANA_DIALOGO_HORAS;
/** Antes de esto no se reporta: la persona de la escuela puede estar contestando. */
export const MINUTOS_DE_GRACIA_SIN_DUENO = 30;

const EMPIEZA_PREGUNTANDO = /^(que|cual|cuales|cuanto|cuanta|cuantos|cuantas|como|donde|cuando|quien|quienes|por que|para que|a que|en que|tienes|tienen|tiene|hay|puedes|puede|pueden|podrias|podria|podrian|me puedes|me puede|me pueden|me podrias|sera que|es posible|se puede|ya (esta|estan|quedo|quedaron|llego)|manejas|manejan)\b/;
const PIDE_UNA_RESPUESTA = /\b(por favor|porfa|por fa|porfis|me (puedes|puede|pueden|podrias|podria|podrian) (ayudar|confirmar|enviar|mandar|decir|informar|colaborar|regalar|indicar|contar)|(confirmar|confirmame|confirmenme|confirmen|confirmas) (que|si|el|la|los|las)?|necesito (saber|que|la|el|los|las|info|informacion)|quisiera saber|quiero saber|no me han (enviado|respondido|contestado|llegado|mandado|dicho|confirmado)|nadie me (responde|contesta|ha respondido|ha contestado)|sigo (esperando|pendiente|atent[oa])|quedo (atent[oa]|pendiente) (a|de)|me (avisas|avisan|cuentas|cuentan|confirmas|confirman|dices|dicen)|a la mano)\b/;
const AVISA_UN_PAGO = /\b(ya (pague|pagamos|consigne|transferi|hice (el|la) (pago|transferencia|consignacion))|(envio|adjunto|mando|comparto|te envio|le envio|aqui esta|aqui va|va|este es) (el |la |mi )?(comprobante|soporte|pago|recibo|transferencia|consignacion)|comprobantes? de pago|soportes? de pago|pago (realizado|hecho|efectuado))\b/;
const ADJUNTOS_DE_PAGO = new Set(['image', 'document']);
const CIERRE_SIN_PEDIDO = /^(gracias|muchas gracias|mil gracias|ok|okey|okay|vale|listo|perfecto|super|genial|dale|bueno|entendido|de acuerdo|igualmente|bendiciones|feliz (dia|tarde|noche))( (gracias|muchas gracias|profe|mil))?$/;

/** ¿Este texto es una PREGUNTA o un pedido que espera respuesta? Pura. */
export function esPreguntaQueEsperaRespuesta(texto: string | null | undefined): boolean {
    const crudo = String(texto ?? '').trim();
    const t = normalizarFrase(crudo);
    if (!t || CIERRE_SIN_PEDIDO.test(t)) return false;
    if (crudo.includes('?')) return (t.match(/[a-z]{2,}/g) ?? []).length >= 1;
    const sinSaludo = t.replace(/^((hola|holi|buenas|buenos dias|buen dia|buenas tardes|buenas noches|profe|disculpa|disculpe|perdon|oye|y|pero) )+/, '');
    return EMPIEZA_PREGUNTANDO.test(sinSaludo) || PIDE_UNA_RESPUESTA.test(t);
}

/** ¿Avisa de un pago (texto, o una foto/PDF sin texto que casi siempre es el comprobante)? Pura. */
export function esAvisoDePago(f: Pick<FilaReciente, 'type' | 'text_body'>): boolean {
    const t = normalizarFrase(f.text_body);
    if (!t) return ADJUNTOS_DE_PAGO.has(String(f.type ?? ''));
    return AVISA_UN_PAGO.test(t);
}

export interface EntranteSinDueno {
    fila: FilaReciente;
    motivo: 'pregunta' | 'aviso_de_pago';
    /** Momento (ms) del mensaje de la escuela que abrió el silencio. */
    silencioDesde: number;
    /** Minutos que lleva sin que nadie (ni la escuela ni el bot) le conteste. */
    minutosEsperando: number;
}

/**
 * Los entrantes que quedaron SIN RESPUESTA dentro de una ventana de silencio: una pregunta o un
 * aviso de pago que llegó después de un mensaje de una persona de la escuela (dentro de las `horas`
 * de silencio), al que nadie —ni la escuela ni el bot— le contestó después, y que ya lleva más que
 * los minutos de gracia. Del más viejo al más nuevo. Pura: no lee la base ni envía nada.
 *
 * `filas`: los mensajes recientes de UNA conversación, en cualquier orden.
 * `desconocido`: la ventana es de 72 h (diálogo del equipo) en vez de 12 h (modo discreto).
 */
export function entrantesSinDuenoEnSilencio(
    filas: readonly FilaReciente[],
    ahora = Date.now(),
    opts: { desconocido?: boolean; horas?: number; minutosDeGracia?: number; saludosConfigurados?: readonly string[] } = {},
): EntranteSinDueno[] {
    const horas = opts.horas ?? (opts.desconocido ? HORAS_SILENCIO_DESCONOCIDO : HORAS_SILENCIO_FAMILIA);
    const gracia = (opts.minutosDeGracia ?? MINUTOS_DE_GRACIA_SIN_DUENO) * 60_000;
    const orden = filas.slice().sort((a, b) => momento(a) - momento(b));
    const humanos = orden.filter((f) => esMensajeHumanoReal(f, orden, { saludosConfigurados: opts.saludosConfigurados })).map(momento);
    if (!humanos.length) return [];
    // Cualquier saliente posterior cuenta como respuesta (de la escuela o del bot), menos lo que la app manda sola.
    const respuestas = orden
        .filter((f) => f.direction === 'outbound' && !(f.payload?.automatico === true || f.payload?.automatico === 'true')
            && !TIPOS_SIN_DIALOGO.has(String(f.type ?? '')))
        .map(momento);
    const salida: EntranteSinDueno[] = [];
    for (const f of orden) {
        if (f.direction !== 'inbound') continue;
        const t = momento(f);
        if (!t || t > ahora || ahora - t < gracia) continue;
        const previo = humanos.filter((h) => h <= t).pop();
        if (previo === undefined || t - previo > horas * 3600_000) continue;   // no llegó dentro de un silencio
        if (respuestas.some((r) => r > t)) continue;                             // alguien le contestó después
        const motivo = esAvisoDePago(f) ? 'aviso_de_pago' : esPreguntaQueEsperaRespuesta(f.text_body) ? 'pregunta' : null;
        if (!motivo) continue;
        salida.push({ fila: f, motivo, silencioDesde: previo, minutosEsperando: Math.floor((ahora - t) / 60_000) });
    }
    return salida;
}
