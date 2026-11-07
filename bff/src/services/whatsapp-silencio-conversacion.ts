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
