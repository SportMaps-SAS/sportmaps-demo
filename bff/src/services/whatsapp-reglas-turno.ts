/**
 * whatsapp-reglas-turno — reglas DETERMINISTAS del turno del bot (sin modelo).
 *
 * Salen del análisis de las conversaciones de Dynasty del 2026-10-06
 * (docs/analisis/whatsapp-conversaciones-dynasty-2026-10-06.md, §2 y §3): en la
 * primera hora con el bot en automático, de 9 familias no resolvió del todo
 * ninguna. Casi todos los errores eran de ORDEN y de LECTURA, no de redacción:
 * el consentimiento antes del comprobante, el texto precargado de /p/:token que
 * nadie reconocía, «Mile, …» contestado con «solo puedo ayudar con…», el bot
 * hablando encima de Milena, y «ya pagué» respondido con la deuda.
 *
 * Todo lo de acá es PURO: recibe texto o filas y devuelve una decisión. Se
 * prueba sin mocks (whatsapp-reglas-turno.test.ts) y se puede explicar por qué
 * disparó. Las consultas a la base viven en whatsapp-bot.service.
 *
 * Normalización: la ortografía de las familias es informal («q», «xfa», «ha
 * cer», «Dinasty», sin tildes, mayúsculas al azar); se compara sin tildes, en
 * minúsculas y con la puntuación vuelta espacio.
 */

import { desgloseMora, textoDesgloseMora } from '../utils/desglose-mora';

/**
 * Clínicas, campamentos y vacacionales, sobre texto ya normalizado
 * (`normalizarFrase`). UNA regla para la campaña (whatsapp-audiencias: quién
 * pidió una clínica) y para el destino por anuncio (whatsapp-anuncio-destino).
 */
export const EVENTO_DE_SERVICIO = /\b(clinicas?|campamentos?|vacacional(es)?|vacaciones recreativas)\b/;

export function normalizarFrase(t: string | null | undefined): string {
    return (t || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ─── P3. «Te envío el comprobante» ───────────────────────────────────────────
//
// 29 de 49 familias (59 %) escriben para mandar un comprobante, y casi siempre
// lo ANUNCIAN con texto antes o después de la foto. Dos de las del 06-oct usaron
// el texto precargado del botón «Enviar comprobante por WhatsApp» de /p/:token:
//   «Hola, envío el comprobante de pago de Mensualidad 10/2026 - [ATLETA]
//    (octubre 2026) de [atleta].»
// y recibieron la pregunta de consentimiento en vez de «mándame la foto».

export interface ComprobanteAnunciado {
    tipo: 'precargado' | 'generico' | 'futuro';
    /** Concepto tal cual lo escribió /p/:token (precargado). */
    concepto?: string | null;
    periodo?: string | null;
    deportista?: string | null;
    /** Referencia corta del cobro (8 hex del id del pago), si el texto la trae. */
    ref?: string | null;
}

/** Texto de /p/:token: «… comprobante de pago de <concepto> (<periodo>) de <deportista>. (ref. ABCD1234)» */
const PRECARGADO = /env[ií]o el comprobante de pago de (.+?)(?:\s+\(([^()]+)\))?(?:\s+de\s+([^()]+?))?\s*\.*\s*(?:\(\s*ref\.?\s*:?\s*([0-9a-f]{8})\s*\))?\s*\.?\s*$/i;
const REF = /\bref\.?\s*:?\s*([0-9a-f]{8})\b/i;

/** Verbo de envío + objeto de pago, en cualquier orden razonable. */
const VERBO_ENVIO = /\b(envio|envie|envia|adjunto|comparto|te comparto|te mando|le mando|te paso|le paso|ahi va|ahi te va|aqui va|aca va|aqui te|ahi te|mando|remito)\b/;
const OBJETO_PAGO = /\b(pagos?|comprobantes?|soportes?|transferencias?|consignacion(es)?|mensualidad(es)?|recibos?|desprendibles?)\b/;
/** «Voy a enviar el pago mañana»: anuncia algo que todavía no existe. */
const FUTURO = /\b(voy a|vamos a|ahorita te|mas tarde te|manana te|luego te|en un rato te|despues te|ya te)\s*(enviar|mandar|pasar|envio|mando|paso|hacer)\b/;
/** «Pagué la mensualidad», «hice la transferencia» (sin reclamo: eso es P7). */
const ACABO_DE_PAGAR = /\b(pague|cancele|consigne|transferi|hice (el pago|la transferencia|la consignacion))\b.*\b(mensualidad|mes|pago|cuota|matricula|inscripcion|octubre|noviembre|diciembre|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre)\b/;
/** «Pago Sofía», «Soporte mensualidad octubre»: el pie típico, ahora como texto suelto. */
const ROTULO = /^(pagos?|soportes?|comprobantes?|mensualidad(es)?)\b/;

export function anunciaComprobante(texto: string | null | undefined): ComprobanteAnunciado | null {
    const crudo = (texto || '').trim();
    if (!crudo) return null;

    const pre = crudo.match(PRECARGADO);
    if (pre) {
        return {
            tipo: 'precargado',
            concepto: pre[1]?.trim() || null,
            periodo: pre[2]?.trim() || null,
            deportista: pre[3]?.trim() || null,
            ref: (pre[4] || crudo.match(REF)?.[1] || '').toLowerCase() || null,
        };
    }

    const t = normalizarFrase(crudo);
    if (!t) return null;
    // Una pregunta («¿te envío el comprobante por acá?», «¿a dónde mando el
    // soporte?») no es un anuncio: es la pregunta de cómo pagar, y la contesta
    // el modelo con los medios de pago.
    if (crudo.includes('?')) return null;
    if (yaPagoYReclama(crudo)) return null;

    if (FUTURO.test(t) && OBJETO_PAGO.test(t)) return { tipo: 'futuro' };
    if (VERBO_ENVIO.test(t) && OBJETO_PAGO.test(t)) return { tipo: 'generico', ref: crudo.match(REF)?.[1]?.toLowerCase() ?? null };
    if (ACABO_DE_PAGAR.test(t) && !/\bya\b/.test(t)) return { tipo: 'generico' };
    if (ROTULO.test(t) && t.split(' ').length <= 7) return { tipo: 'generico' };
    return null;
}

/** Nombre del cobro para decirlo de vuelta: «Mensualidad 10/2026 - X (octubre 2026)». */
export function nombreDelCobroAnunciado(a: ComprobanteAnunciado | null | undefined): string | null {
    if (!a?.concepto) return null;
    return a.concepto + (a.periodo ? ` (${a.periodo})` : '');
}

// ─── P7. «Ya pagué y me sigue llegando el cobro» ────────────────────────────
//
// 10 de 49 familias (20 %): «me aparece el pago pendiente y yo ya pagué», «aún
// no aparece el pago en la plataforma», «la transferencia se realizó el 4 de
// septiembre». El bot les listaba la deuda como vencida.

const YA_PAGUE: RegExp[] = [
    /\bya (pague|cancele|consigne|transferi|envie|mande|hice el pago|hice la transferencia|te envie|te mande|le envie|le mande|realice el pago)\b/,
    /\b(yo )?ya (te|le) (envie|mande|pase)\b/,
    /\bno (me )?aparece (el|mi) pago\b/,
    /\b(aun|todavia) no aparece\b/,
    /\bsigue apareciendo\b/,
    /\bme (sigue|siguen|esta|estan) llegando\b.*\b(cobro|cobros|cuenta|correo|mensajes?|estado de cuenta|recordatorio)/,
    /\bme (llego|aparece)\b.*\b(cobro|pendiente|cuenta de cobro)\b.*\b(pague|pagado|cancele)\b/,
    /\breflejar el pago\b/,
    /\bla transferencia (se )?(realizo|hizo|fue)\b/,
    /\bpague el (lunes|martes|miercoles|jueves|viernes|sabado|domingo|\d)/,
];

export function yaPagoYReclama(texto: string | null | undefined): boolean {
    const t = normalizarFrase(texto);
    if (!t) return false;
    return YA_PAGUE.some((re) => re.test(t));
}

export interface PagoDeEstado {
    concept?: string | null;
    saldo?: number | string | null;
    amount?: number | string | null;
    status?: string | null;
    estado_legible?: string | null;
    debe_pagarse?: boolean | null;
    due_date?: string | null;
    vencido?: boolean | null;
    /** /p/:token del cobro (whatsapp-enlaces-de-pago), si se pudo emitir. */
    enlace_pago?: string | null;
    /** Recargo por mora que ya va DENTRO del saldo (payments.late_fee_amount), si la consulta lo trae. */
    late_fee_amount?: number | string | null;
}

export interface FilaDeColaFamilia {
    status: string;
    result_type?: string | null;
    created_at: string;
}

const copFmt = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

function horaCorta(iso: string): string {
    try {
        return new Intl.DateTimeFormat('es-CO', {
            timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
        }).format(new Date(iso));
    } catch {
        return iso.slice(0, 16).replace('T', ' ');
    }
}

/**
 * La respuesta a «ya pagué»: PRIMERO qué comprobante tenemos y en qué está;
 * DESPUÉS, si queda, lo que figura pendiente. Nunca promete revisar nada que el
 * bot no revisa: describe estados que existen en la base.
 *
 * `hayAlgo` = encontró al menos un comprobante (en la cola o en revisión). Si no
 * hay nada, quien llama abre el caso en el buzón: la familia dice que pagó y el
 * sistema no lo ve, eso lo tiene que mirar una persona.
 */
export function textoYaPague(
    pagos: PagoDeEstado[] | null | undefined,
    cola: FilaDeColaFamilia[] | null | undefined,
): { texto: string; hayAlgo: boolean } {
    const lista = Array.isArray(pagos) ? pagos : [];
    const filas = Array.isArray(cola) ? cola : [];
    const lineas: string[] = [];

    // 1. Lo que llegó por este chat y todavía no tiene desenlace.
    const enCola = filas.filter((f) => ['pending', 'processing', 'waiting_user'].includes(f.status));
    const aManoEscuela = filas.filter((f) => f.status === 'ignored' && f.result_type === 'escalated');
    if (enCola.length) {
        const ultimo = enCola.map((f) => f.created_at).sort().slice(-1)[0];
        lineas.push(enCola.length === 1
            ? `Tengo el comprobante que enviaste por aquí el ${horaCorta(ultimo)}; está pendiente de revisión. 📄`
            : `Tengo ${enCola.length} archivos que enviaste por aquí (el último, el ${horaCorta(ultimo)}); están pendientes de revisión. 📄`);
    } else if (aManoEscuela.length) {
        lineas.push('Tengo el comprobante que enviaste por aquí; la escuela lo tiene para aplicarlo. 📄');
    }

    // 2. Lo que la base ya sabe de cada cobro.
    const enRevision = lista.filter((p) => p.status === 'awaiting_approval');
    const pagados = lista.filter((p) => p.status === 'paid');
    const rechazados = lista.filter((p) => p.status === 'rejected');
    const glosados = lista.filter((p) => p.status === 'glosado');
    for (const p of enRevision.slice(0, 3)) lineas.push(`• *${p.concept}*: comprobante recibido, la escuela lo está revisando.`);
    for (const p of rechazados.slice(0, 3)) lineas.push(`• *${p.concept}*: el comprobante fue rechazado.`);
    for (const p of glosados.slice(0, 3)) lineas.push(`• *${p.concept}*: la escuela pidió una aclaración sobre este pago.`);
    for (const p of pagados.slice(0, 3)) lineas.push(`• *${p.concept}*: pagado y confirmado ✅`);

    const hayAlgo = enCola.length > 0 || aManoEscuela.length > 0 || enRevision.length > 0
        || rechazados.length > 0 || glosados.length > 0 || pagados.length > 0;

    // 3. Lo pendiente, recién al final y sin la palabra «vencida» como reproche.
    const pendientes = lista.filter((p) => p.debe_pagarse === true);
    if (!hayAlgo) {
        lineas.push('No encuentro ningún comprobante tuyo reciente por este medio. 🤔');
        lineas.push('Si ya pagaste, mándame la *foto* o el *PDF* del comprobante por aquí. ' +
            'Y dejo el caso en manos de la escuela para que lo revise contigo.');
    }
    if (pendientes.length) {
        lineas.push('');
        lineas.push(hayAlgo
            ? 'Esto todavía figura pendiente en el sistema:'
            : 'Por ahora el sistema muestra pendiente:');
        for (const p of pendientes.slice(0, 5)) {
            const saldo = Number(p.saldo ?? p.amount ?? 0);
            lineas.push(`• ${p.concept}: ${copFmt(saldo)}`);
            const mora = desgloseMora(saldo, p.late_fee_amount);
            if (mora) lineas.push(`   ${textoDesgloseMora(mora, copFmt)}`);
            if (p.enlace_pago) lineas.push(`   Pagar: ${p.enlace_pago}`);
        }
        if (hayAlgo && (enCola.length || enRevision.length)) {
            lineas.push('Si alguno de esos es el que ya pagaste, queda al día apenas se apruebe el comprobante.');
        }
    }
    return { texto: lineas.join('\n').trim(), hayAlgo };
}

// ─── P9. «Mile, …» y «¿Milena estás por acá?» ───────────────────────────────
//
// 50 de 200 textos (25 %) nombran a alguien. «¿Milena estás por acá?» → el
// modelo PREGUNTÓ si escalar (el prompt decía escalar de una); «Mile, puedes ir
// a comunicación…» → «Lo siento, solo puedo ayudar con…».

/** Vocativos que no son de nadie en particular pero son de la escuela. */
export const VOCATIVOS_GENERICOS = ['profe', 'profesora', 'profesor', 'entrenador', 'entrenadora', 'coach', 'sra', 'senora', 'senor'];

const PIDE_PERSONA: RegExp[] = [
    /\b(estas|esta|estan) (por )?(aca|aqui|ahi|alli|disponible)\b/,
    /\b(hablar|comunicarme|comunicar|charlar) con (alguien|una persona|un humano|un asesor|una asesora|la escuela|el profe|la profe|la duena|la administradora|el administrador|la directora|el director)\b/,
    /\b(me (comunicas|pasas|comunica|pasa) con)\b/,
    /\b(una persona|un humano|persona real|asesor humano)\b/,
    /\bnecesito (hablar|que me llame|una llamada)\b/,
    /\b(me puede|me puedes|pueden) llamar\b/,
];

/** Señales de trámite concreto: con alguna de estas, el vocativo es solo un saludo y el bot sí atiende. */
const TRAMITE: RegExp[] = [
    /\b(pagos?|pague|pagar|debo|deuda|mensualidad(es)?|saldo|cobros?|comprobantes?|soportes?|transferencias?|consignacion|nequi|daviplata|llave|cuenta|link|enlace|factura)\b/,
    /\b(horarios?|clases?|entrenamientos?|entreno|sede|cortesia|prueba|inscrip\w*|matricul\w*|cupos?|categorias?)\b/,
    /\b(cuanto|cuando|donde|a que hora)\b/,
];

const NO_VOCATIVO_ANTES = new Set([
    'el', 'la', 'los', 'las', 'al', 'del', 'un', 'una', 'de', 'a', 'con', 'para', 'por', 'tu', 'su', 'sus', 'que',
]);

export type PedidoDePersona =
    | { tipo: 'escalar' }
    | { tipo: 'vocativo'; nombre: string };

/**
 * Nombres del equipo con los que escriben las familias: nombre de pila, el
 * diminutivo de cuatro letras («Milena» → «mile») y el -ita («milenita»).
 */
export function vocativosDelEquipo(nombresCompletos: (string | null | undefined)[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const completo of nombresCompletos) {
        const pila = normalizarFrase(completo).split(' ')[0];
        if (!pila || pila.length < 3) continue;
        const visible = (completo || '').trim().split(/\s+/)[0];
        m.set(pila, visible);
        if (pila.length >= 5) m.set(pila.slice(0, 4), visible);
        if (/[ao]$/.test(pila)) m.set(pila.slice(0, -1) + (pila.endsWith('a') ? 'ita' : 'ito'), visible);
    }
    return m;
}

/**
 * ¿Le está hablando a una persona del equipo, sin un trámite que el bot pueda
 * atender? (`vocativo`) ¿O pide una persona? (`escalar`)
 *
 * El vocativo se busca al PRINCIPIO o al FINAL del mensaje («Mile, …», «…,
 * Milena»): en el medio casi siempre es un relato («le dije a Milena que…»).
 */
export function pideALaPersona(
    texto: string | null | undefined,
    equipo: Map<string, string> = new Map(),
): PedidoDePersona | null {
    const t = normalizarFrase(texto);
    if (!t) return null;
    if (PIDE_PERSONA.some((re) => re.test(t))) return { tipo: 'escalar' };

    const palabras = t.split(' ');
    // La última palabra cuenta como vocativo solo si no va con artículo o
    // preposición: «¿quién es el entrenador?» habla DE alguien, no LE habla.
    const penultima = palabras[palabras.length - 2];
    const ultimaEsVocativo = palabras.length === 1 || !NO_VOCATIVO_ANTES.has(penultima);
    const extremos = [palabras[0], ultimaEsVocativo ? palabras[palabras.length - 1] : '']
        .filter(Boolean) as string[];
    // «Hola Milena», «Buen día Mile», «Mi querida Mile»: el saludo empuja el
    // nombre a la segunda o tercera palabra.
    const sinSaludo = t.replace(/^(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|mi querida|querida|mi|sra|senora)\s+/, '')
        .replace(/^(hola|buen dia|buenos dias|buenas tardes|buenas noches)\s+/, '');
    const primeraTrasSaludo = sinSaludo.split(' ')[0];

    let nombre: string | null = null;
    for (const w of [...extremos, primeraTrasSaludo]) {
        if (equipo.has(w)) { nombre = equipo.get(w)!; break; }
        if (VOCATIVOS_GENERICOS.includes(w)) { nombre = w === 'profe' || w.startsWith('profes') ? 'la profe' : 'la escuela'; break; }
    }
    if (!nombre) return null;
    if (TRAMITE.some((re) => re.test(t))) return null;
    return { tipo: 'vocativo', nombre };
}

// ─── P13. «Gracias», «Ok», «👍» ─────────────────────────────────────────────
//
// 91 de 200 textos tienen ≤ 20 caracteres («Vale», «Ok», «?», «Si ??», «👆»).
// Responder «¡De nada! 😊 Si necesitas consultar algún pago…» a cada cierre es
// ruido, y en un canal donde Meta mide la calidad del número, ruido caro.

const CIERRES = new Set([
    'gracias', 'muchas gracias', 'mil gracias', 'gracias mil', 'ok', 'okey', 'okay', 'oki', 'vale', 'listo',
    'perfecto', 'super', 'genial', 'dale', 'bueno', 'buenisimo', 'entendido', 'de acuerdo', 'ok gracias',
    'listo gracias', 'vale gracias', 'perfecto gracias', 'gracias igualmente', 'igualmente', 'bendiciones',
    'que dios te bendiga', 'feliz dia', 'feliz tarde', 'feliz noche', 'chao', 'bye', 'gracias profe',
    'ok muchas gracias', 'listo muchas gracias', 'super gracias', 'gracias a ti', 'a ti',
]);

/** Apelativos de cariño que acompañan un cierre («Vale querida», «Gracias linda»). */
const CARINOS = new Set(['querida', 'querido', 'linda', 'lindo', 'hermosa', 'bella', 'reina', 'mija', 'amiga', 'amigo']);

/**
 * `equipo`: los vocativos de la escuela (`vocativosDeEscuela`, claves
 * normalizadas: «mile», «milena»). «Gracias Mile» y «Listo mile gracias»
 * son cierres con el nombre de quien atiende (Dynasty, 2026-10-06); sin el
 * nombre, el P9 los leía como recado para Milena.
 */
export function esCierreSuelto(
    texto: string | null | undefined,
    equipo: ReadonlyMap<string, string> | ReadonlySet<string> = new Map(),
): boolean {
    const crudo = (texto || '').trim();
    if (!crudo) return false;
    // Solo emojis o signos («👍», «🙏🏻», «👆», «!!»): no hay nada que contestar.
    if (!/[\p{L}\p{N}]/u.test(crudo)) return !crudo.includes('?');
    if (crudo.includes('?')) return false;
    const t = normalizarFrase(crudo);
    if (CIERRES.has(t)) return true;
    const resto = t.split(' ')
        .filter((w) => !equipo.has(w) && !VOCATIVOS_GENERICOS.includes(w) && !CARINOS.has(w))
        .join(' ');
    return resto !== t && CIERRES.has(resto);
}

// ─── P14. Auto-respuestas de otros negocios ─────────────────────────────────
//
// `c59de2` (una familia con negocio): «¡Hola! 👋 Gracias por escribir a Play
// Kids… fuera de horario». Si el bot le contesta, la otra auto-respuesta le
// contesta al bot y quedan dos máquinas hablándose.

const AUTO_RESPUESTA: RegExp[] = [
    /\bgracias por (comunicarte|comunicarse|escribir|escribirnos|contactar|contactarnos|tu mensaje|su mensaje)\b/,
    /\b(respuesta|mensaje) automatic[oa]\b/,
    /\bfuera (de|del) (nuestro )?horario\b/,
    /\bnuestro horario de atencion\b/,
    /\b(te|le) (responderemos|contestaremos|atenderemos) (lo antes posible|a la brevedad|pronto|en breve)\b/,
    /\ben este momento no (podemos|estamos|me encuentro)\b/,
    /\bno estoy disponible en este momento\b/,
];

export function esAutoRespuesta(texto: string | null | undefined): boolean {
    const t = normalizarFrase(texto);
    if (!t || t.split(' ').length < 4) return false;
    return AUTO_RESPUESTA.some((re) => re.test(t));
}

// ─── P10. Respuesta sin modelo cuando el modelo falla ───────────────────────

export type RutaSinModelo = 'pagos' | 'medios' | 'menu';

/** Si el modelo no responde, ¿por cuál camino determinista va el mensaje? */
export function rutaSinModelo(texto: string | null | undefined): RutaSinModelo {
    const t = normalizarFrase(texto);
    if (/\b(como (pago|pagar|le pago|te pago)|a que cuenta|numero de cuenta|cuenta para|nequi|daviplata|llave|bre b|qr|link (de|para) pag\w*|medios de pago|donde (pago|consigno|transfiero))\b/.test(t)) return 'medios';
    if (/\b(cuanto (debo|es|vale|cuesta)|debo|deuda|saldo|pendiente|mensualidad|mis pagos|estado de cuenta|cobro|valor)\b/.test(t)) return 'pagos';
    return 'menu';
}

// ─── Estado reciente de la conversación ─────────────────────────────────────

export interface FilaReciente {
    wa_message_id?: string | null;
    direction: string;
    type?: string | null;
    text_body?: string | null;
    payload?: any;
    ai_generated?: boolean | null;
    wa_timestamp?: string | null;
    created_at?: string | null;
}

const momento = (f: FilaReciente) => new Date(f.wa_timestamp || f.created_at || 0).getTime();
const esAutomaticoDeApp = (f: FilaReciente) =>
    f.payload?.automatico === true || f.payload?.automatico === 'true';
const pasoDe = (f: FilaReciente) => (f.payload?.step ?? null) as string | null;

/**
 * P4: ¿escribió una PERSONA de la escuela en los últimos `minutos`? Saliente con
 * `ai_generated=false` que no sea un automático de WhatsApp Business: echo de
 * Coexistence (Milena desde su celular) o respuesta del buzón.
 *
 * Medido el 06-oct: en 6 de 10 conversaciones Milena escribía mientras el bot
 * respondía (20 salientes humanos contra 49 del bot); en `8f9e500b` el bot
 * mandó 5 estados de pago encima de ella y contradijo lo que acordaron.
 */
export function humanoReciente(filas: FilaReciente[], minutos: number, ahora = Date.now()): boolean {
    const desde = ahora - minutos * 60_000;
    // Solo imagen / ubicación / sticker (sin texto): la escuela mandó la foto
    // del horario o el pin del coliseo y siguió con lo suyo. Cuenta como
    // «atendiendo» unos minutos, no los 15 completos (…1042 y …6297, 07-oct:
    // el bot cedió por una imagen y nadie volvió a escribir).
    const desdeAdjunto = ahora - Math.min(minutos, SILENCIO_SOLO_ADJUNTO_MIN) * 60_000;
    return filas.some((f) => esHumanoDeLaEscuela(f)
        && momento(f) >= (esSoloAdjunto(f) ? desdeAdjunto : desde));
}

/** Minutos que «calla» al bot un mensaje de la escuela que es solo imagen, ubicación o sticker. */
export const SILENCIO_SOLO_ADJUNTO_MIN = 3;
const TIPOS_SOLO_ADJUNTO = new Set(['image', 'location', 'sticker', 'reaction']);

/** ¿Imagen, ubicación, sticker o reacción sin texto (sin pie de foto)? */
export function esSoloAdjunto(f: FilaReciente): boolean {
    return TIPOS_SOLO_ADJUNTO.has(String(f.type ?? '')) && !(f.text_body || '').trim();
}

/** Saliente escrito por una PERSONA de la escuela (echo de Coexistence o buzón). */
export function esHumanoDeLaEscuela(f: FilaReciente): boolean {
    return f.direction === 'outbound' && f.ai_generated === false && !esAutomaticoDeApp(f);
}

// ─── Retoma: la escuela cedió y nadie contestó ──────────────────────────────
//
// Dynasty 2026-10-07: …4445 recibió «Ya pasé tu mensaje a la escuela» a las
// 12:19 y escribió «Hola» a las 12:56, 15:08 y 17:38 sin respuesta; …1042
// preguntó «Cuánto es la mensualidad y qué dirección es» después de que la
// escuela mandó solo una imagen, y …6297 «edad máxima / precios» después del pin
// del coliseo. El bot había cedido y nadie volvió.
//
// `decidirRetoma` es la regla, pura: si tras ceder nadie de la escuela escribió
// TEXTO en RETOMA_MIN, el bot vuelve a lo que sabe contestar; y si la familia
// vuelve a escribir más de REAVISO_TRAS_PASE_MIN después de «ya pasé tu
// mensaje», se re-avisa a la escuela.

/** Minutos sin TEXTO de la escuela tras ceder antes de que el bot retome. */
export const RETOMA_MIN = Number(process.env.WHATSAPP_RETOMA_MIN) || 30;
/** Minutos tras «ya pasé tu mensaje» a partir de los cuales un mensaje nuevo re-avisa a la escuela. */
export const REAVISO_TRAS_PASE_MIN = 60;
/** Solo se miran conversaciones con un pendiente de estas últimas horas. */
export const RETOMA_VENTANA_HORAS = 6;

/** step de lo que dice el bot al retomar sin tener la respuesta. */
export const PASO_RETOMA_SIN_RESPUESTA = 'retoma_sin_respuesta';
/** Pasos con los que el bot le pasó la conversación a la escuela («ya pasé tu mensaje»). */
export const PASOS_PASE_A_LA_ESCUELA = new Set([
    'prospecto_seguimiento', 'escalated', 'ask_email', 'mensaje_para_persona',
    'escalacion_sin_respuesta', 'comprobante_a_revision_manual', 'correo_no_encontrado',
    // Puerta única del desconocido (conversación v2): «Ya soy del club» y «Otro tema» dejan a la persona esperando a la escuela.
    'puerta_club_recibido', 'puerta_otro_tema',
    PASO_RETOMA_SIN_RESPUESTA,
]);

export type DecisionRetoma = {
    /** ¿Responder ya lo pendiente (esperó RETOMA_MIN sin texto de la escuela)? */
    responder: boolean;
    /** ¿Re-avisar a la escuela (volvió a escribir > 1 h después de «ya pasé tu mensaje»)? */
    reavisar: boolean;
    /** Entrantes de texto sin respuesta, del más viejo al más nuevo. */
    pendientes: FilaReciente[];
    /** El «ya pasé tu mensaje» que se re-avisa (su id/wa_message_id arma la clave). */
    pase: FilaReciente | null;
    motivo: string;
};

const tieneTexto = (f: FilaReciente) => !!(f.text_body || '').trim();

/**
 * La regla de la retoma. Pura. `filas` en cualquier orden (las de 24 h).
 *
 *  - Pendientes = entrantes con texto DESPUÉS de la última respuesta real: del
 *    bot, o de una persona de la escuela CON TEXTO. Una imagen suelta de la
 *    escuela no responde «¿cuánto es la mensualidad?».
 *  - Solo si el bot habló en estas 24 h (un contacto personal de la dueña, al
 *    que el bot nunca le habla, no entra) y CEDIÓ: una persona de la escuela
 *    escribió (cualquier tipo) o el bot dijo «ya pasé tu mensaje».
 *  - `responder`: el primer pendiente lleva ≥ RETOMA_MIN y la escuela no escribió
 *    texto en ese lapso.
 *  - `reavisar`: hay un pendiente posterior a un «ya pasé tu mensaje» de hace
 *    ≥ REAVISO_TRAS_PASE_MIN.
 */
export function decidirRetoma(filas: FilaReciente[], ahora = Date.now()): DecisionRetoma {
    const orden = filas.slice().sort((a, b) => momento(a) - momento(b));
    const nada = (motivo: string): DecisionRetoma => ({ responder: false, reavisar: false, pendientes: [], pase: null, motivo });

    const esBot = (f: FilaReciente) => f.direction === 'outbound' && f.ai_generated !== false && !esAutomaticoDeApp(f);
    const respuestas = orden.filter((f) => esBot(f) || (esHumanoDeLaEscuela(f) && tieneTexto(f)));
    const ultimaRespuesta = respuestas.length ? momento(respuestas[respuestas.length - 1]) : 0;
    const pendientes = orden.filter((f) => f.direction === 'inbound' && tieneTexto(f) && momento(f) > ultimaRespuesta);
    if (!pendientes.length) return nada('sin_pendientes');
    if (ahora - momento(pendientes[pendientes.length - 1]) > RETOMA_VENTANA_HORAS * 3600_000) return nada('viejo');

    if (!orden.some((f) => esBot(f) && momento(f) >= ahora - 24 * 3600_000)) return nada('bot_no_hablo');

    const pases = orden.filter((f) => esBot(f) && PASOS_PASE_A_LA_ESCUELA.has(String(pasoDe(f) ?? '')));
    const pase = pases.length ? pases[pases.length - 1] : null;
    const primero = momento(pendientes[0]);
    const humanoAntes = orden.some((f) => esHumanoDeLaEscuela(f) && momento(f) <= primero
        && momento(f) >= primero - RETOMA_VENTANA_HORAS * 3600_000);
    if (!pase && !humanoAntes) return nada('no_cedio');

    // Texto de la escuela en los últimos RETOMA_MIN: está atendiendo.
    const textoEscuelaReciente = orden.some((f) => esHumanoDeLaEscuela(f) && tieneTexto(f)
        && momento(f) >= ahora - RETOMA_MIN * 60_000);

    const responder = !textoEscuelaReciente && ahora - primero >= RETOMA_MIN * 60_000;
    const reavisar = !!pase && ahora - momento(pase) >= REAVISO_TRAS_PASE_MIN * 60_000
        && pendientes.some((f) => momento(f) - momento(pase) >= REAVISO_TRAS_PASE_MIN * 60_000)
        && !textoEscuelaReciente;
    return {
        responder, reavisar, pendientes, pase,
        motivo: responder ? 'retomar' : reavisar ? 'reavisar' : textoEscuelaReciente ? 'escuela_atendiendo' : 'esperando',
    };
}

const PASOS_DE_CONSENTIMIENTO = new Set([
    'ask_consent', 'opt_in_registrado', 'consent_rechazado', 'opt_in_reactivado', 'opt_out_confirmado',
    'confirmar_baja', 'baja_mantenida',
]);

/**
 * P2: ¿la última pregunta del bot fue la del consentimiento y sigue sin
 * respuesta? Solo entonces un «sí» se lee como «acepto los recordatorios».
 *
 * Se cierra con la respuesta (sí/no) y TAMBIÉN con cualquier otro saliente
 * del bot posterior: si después de preguntar el bot contestó otra cosa, un «sí»
 * que llegue es respuesta a eso otro, no al consentimiento.
 */
export function preguntaAbierta(filas: FilaReciente[], paso: string): boolean {
    const salientesBot = filas
        .filter((f) => f.direction === 'outbound' && f.ai_generated !== false && !esAutomaticoDeApp(f) && pasoDe(f))
        .sort((a, b) => momento(b) - momento(a));
    const ultimo = salientesBot[0];
    // `payload.pregunta`: la pregunta viaja DENTRO de otra respuesta (el
    // consentimiento al pie del estado de pagos o del resultado de un
    // comprobante, 2026-10-07) y el paso del mensaje es el de la respuesta.
    return !!ultimo && (pasoDe(ultimo) === paso || ultimo.payload?.pregunta === paso);
}

/**
 * Pasos que ya le dijeron a la familia «todavía no tienes tu cuenta»: el aviso
 * del bot (`debe_registrarse`) y la respuesta de la cola a un comprobante
 * (`familia_sin_cuenta`). Uno solo cada 24 h por conversación, venga de donde
 * venga (…8804c0, 07-oct: los dos en 17 s).
 */
export const PASOS_SIN_CUENTA = ['debe_registrarse', 'familia_sin_cuenta'];

/** ¿Salió (o quedó registrado) este paso en los últimos `ms`? */
export function pasoEnVentana(filas: FilaReciente[], paso: string, ms: number, ahora = Date.now()): FilaReciente | null {
    const desde = ahora - ms;
    const encontrados = filas
        .filter((f) => f.direction === 'outbound' && pasoDe(f) === paso && momento(f) >= desde)
        .sort((a, b) => momento(b) - momento(a));
    return encontrados[0] ?? null;
}

export { PASOS_DE_CONSENTIMIENTO };

// ─── Tipos no soportados (video, sticker, contacto, ubicación…) ─────────────
//
// Dynasty 2026-10-07 18:32–18:37: una familia mandó 13 videos seguidos (del
// entrenamiento, junto con fotos) y el bot contestó 13 veces «No puedo ver
// videos. Si es un comprobante…». Un video de una familia casi nunca es un
// comprobante: se contesta SOLO si el texto cercano habla de pago, y como mucho
// una vez cada 24 h por conversación (cualquier `tipo_no_soportado_*`).

/** Prefijo del step de la respuesta a un tipo no soportado. */
export const PASO_TIPO_NO_SOPORTADO = 'tipo_no_soportado';
/** Cuánto hacia atrás se mira el texto que acompaña al video. */
export const VENTANA_TEXTO_DEL_VIDEO_MS = 15 * 60_000;
const HABLA_DE_PAGO = /\b(pagos?|pague|pagar|comprobantes?|soportes?|transferencias?|transferi|consignacion|consigne|mensualidad|recibos?|abono|cuota|nequi|daviplata|bre b)\b/;

// ─── Un archivo de la familia en la ráfaga (Dynasty 2026-10-09) ─────────────
//
// Imagen + «Buen día»: el modelo contestó con el estado de cuenta y la cola,
// en el mismo minuto, preguntó a cuál cobro aplicar el comprobante. Dos
// respuestas al mismo gesto. El archivo lo contesta la cola, y el turno del bot
// calla lo que sea saludo o tema de pagos.

/** Cuánto hacia atrás cuenta un archivo como parte de la ráfaga del turno. */
export const VENTANA_ADJUNTO_DEL_TURNO_MS = 5 * 60_000;

/**
 * ¿Llegó una imagen o un PDF de la familia en esta ráfaga (después de la
 * última respuesta y dentro de los últimos 5 min)? Pura.
 */
export function adjuntoEnLaRafaga(filas: FilaReciente[], _waMessageIdActual?: string | null, ahora = Date.now()): boolean {
    // La respuesta de la COLA a ese archivo no corta la ráfaga: si ya contestó,
    // con más razón el turno no tiene nada que agregar.
    const ultimaRespuesta = Math.max(0, ...filas
        .filter((f) => f.direction === 'outbound' && !esAutomaticoDeApp(f) && !f.payload?.queue_id).map(momento));
    const desde = Math.max(ultimaRespuesta, ahora - VENTANA_ADJUNTO_DEL_TURNO_MS);
    return filas.some((f) => f.direction === 'inbound'
        && (f.type === 'image' || f.type === 'document') && momento(f) > desde);
}

/** Saldo, deuda, cobros o pagos: lo que la respuesta al comprobante ya cubre. Pura. */
export function hablaDePagoOEstado(texto: string | null | undefined): boolean {
    const t = normalizarFrase(texto);
    if (!t) return false;
    return HABLA_DE_PAGO.test(t)
        || /\b(debo|deuda|debe|pendientes?|cobros?|saldo|estado de cuenta|factura|cuanto (es|debo|tengo|sale|vale))\b/.test(t);
}

/**
 * ¿Merece respuesta un video (u otro tipo que el bot no lee)? Pura.
 *  - `textoPropio`: el pie del video, si trae.
 *  - `filas`: las recientes de la conversación.
 * Sí solo si el pie o un entrante de texto de los últimos 15 min habla de pago,
 * y no salió ningún `tipo_no_soportado_*` en 24 h.
 */
export function respuestaATipoNoSoportado(
    textoPropio: string | null | undefined,
    filas: FilaReciente[],
    ahora = Date.now(),
): boolean {
    const yaDicho = filas.some((f) => f.direction === 'outbound'
        && String(pasoDe(f) ?? '').startsWith(PASO_TIPO_NO_SOPORTADO)
        && momento(f) >= ahora - 24 * 3600_000);
    if (yaDicho) return false;
    const habla = (t: string | null | undefined) => HABLA_DE_PAGO.test(normalizarFrase(t)) || !!anunciaComprobante(t);
    if (habla(textoPropio)) return true;
    return filas.some((f) => f.direction === 'inbound' && tieneTexto(f)
        && momento(f) >= ahora - VENTANA_TEXTO_DEL_VIDEO_MS && habla(f.text_body));
}

// ─── Notas de voz (spec docs/specs/whatsapp-notas-de-voz.md, F1) ─────────────

/** Más de esto no se le pasa al bot: va al buzón con la transcripción (D3). */
export const AUDIO_MAX_SEGUNDOS_BOT = 120;
const ECO_MAX_CARACTERES = 120;
const VENTANA_ECO_MS = 3 * 60_000;

/**
 * Frases que Whisper «oye» en audios vacíos o de puro ruido (alucinaciones
 * conocidas en español: vienen de los subtítulos con los que se entrenó).
 */
const ALUCINACIONES_WHISPER = [
    /subtitulos? (realizados|hechos|creados) por/,
    /amara org/,
    /gracias por ver( el video)?$/,
    /suscribete/,
    /^(musica|aplausos|risas)$/,
];

/**
 * ¿La transcripción es ruido o nada? Vacía, alucinación conocida, o el modelo
 * dice que no hubo voz (`no_speech_prob` alto). Una sola palabra NO es ruido
 * por sí sola («Sí», «Gracias»): solo si además la probabilidad de no-voz es
 * dudosa.
 */
export function esRuidoDeTranscripcion(texto: string | null | undefined, noSpeechProb: number | null | undefined): boolean {
    const norm = normalizarFrase(texto);
    if (!norm || !/[a-z]/.test(norm)) return true;
    if (ALUCINACIONES_WHISPER.some((re) => re.test(norm))) return true;
    const p = typeof noSpeechProb === 'number' ? noSpeechProb : 0;
    if (p > 0.6) return true;
    return norm.split(' ').length < 2 && p > 0.3;
}

/** La transcripción de esta fila se le pasó al bot (no fue larga, ni ruido, ni error). */
export function esAudioTranscritoParaBot(f: FilaReciente): boolean {
    return f.direction === 'inbound' && f.type === 'audio'
        && f.payload?.transcripcion?.al_bot === true && !!(f.text_body || '').trim();
}

/**
 * El eco «🎤 Entendí: «…»» del turno: las notas de voz transcritas de la ráfaga
 * (la actual, más las que llegaron desde la última respuesta, ≤ 3 min). Le
 * muestra a la familia qué entendió el bot y la deja corregir (D2). `null` si
 * en la ráfaga no hay audio transcrito.
 */
export function ecoDeAudios(filas: FilaReciente[], waMessageIdActual: string | null, ahora = Date.now()): string | null {
    const ultimoSaliente = Math.max(0, ...filas.filter((f) => f.direction === 'outbound').map(momento));
    const desde = Math.max(ultimoSaliente, ahora - VENTANA_ECO_MS);
    const audios = filas
        .filter(esAudioTranscritoParaBot)
        .filter((f) => (waMessageIdActual && f.wa_message_id === waMessageIdActual) || momento(f) > desde)
        .sort((a, b) => momento(a) - momento(b))
        .map((f) => (f.text_body || '').trim().replace(/\s+/g, ' '));
    if (!audios.length) return null;
    let texto = audios.join(' … ');
    if (texto.length > ECO_MAX_CARACTERES) texto = texto.slice(0, ECO_MAX_CARACTERES).trimEnd() + '…';
    return `🎤 Entendí: «${texto}»`;
}

// ─── Largo y emojis (auditoría 2026-10-07) ──────────────────────────────────
//
// Saludo de 1394 caracteres con 12 emojis; listas de cortesía de 860–1026. En
// WhatsApp un mensaje largo y cargado de íconos se lee como publicidad. Tope:
// 3 emojis por mensaje (los primeros se quedan, el resto se quita).

export const MAX_EMOJIS_MENSAJE = 3;
const EMOJI_RE = /\s?\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;

/** Cuántos emojis trae el texto. Pura. */
export function contarEmojis(texto: string | null | undefined): number {
    return ((texto || '').match(EMOJI_RE) ?? []).length;
}

/** El texto con como mucho `max` emojis (se quedan los primeros). Pura. */
export function recortarEmojis(texto: string, max = MAX_EMOJIS_MENSAJE): string {
    let vistos = 0;
    return texto.replace(EMOJI_RE, (m) => (++vistos <= max ? m : ''));
}

// ─── Anti-repetición (conversación v2, 2026-10-24) ──────────────────────────
//
// Casos reales de Dynasty: «no puedo leer ese formato» DOS veces en 5 min y
// «Todavía nadie…» dos veces en el mismo segundo. El mismo texto del bot no sale
// dos veces en 30 min por conversación. Se compara por CONTENIDO: el primer
// mensaje pudo salir con la presentación delante («Hola 👋 soy el asistente…») y el
// segundo sin ella, y es el mismo mensaje.

/** Minutos en los que el mismo texto del bot no se repite en una conversación. */
export const VENTANA_ANTIREPETICION_MIN = 30;

/** Menos que esto (normalizado) no cuenta: «Listo», «Gracias» pueden repetirse. */
const MIN_CARACTERES_ANTIREPETICION = 25;

export interface SalienteReciente { texto?: string | null; momento: number }

/**
 * ¿Este texto ya salió en los últimos `ventanaMin` minutos? `previos`: lo que el
 * bot ya mandó en la conversación (texto + momento en ms). El texto nuevo cuenta
 * como repetido si está CONTENIDO en alguno de los previos (o al revés), ya
 * normalizado. Pura.
 */
export function esRepeticionReciente(
    texto: string | null | undefined,
    previos: SalienteReciente[],
    ahora = Date.now(),
    ventanaMin = VENTANA_ANTIREPETICION_MIN,
): boolean {
    const nuevo = normalizarFrase(texto);
    if (nuevo.length < MIN_CARACTERES_ANTIREPETICION) return false;
    const desde = ahora - ventanaMin * 60_000;
    return previos.some((p) => {
        if (!Number.isFinite(p.momento) || p.momento < desde) return false;
        const antes = normalizarFrase(p.texto);
        if (antes.length < MIN_CARACTERES_ANTIREPETICION) return false;
        return antes === nuevo || antes.includes(nuevo) || nuevo.includes(antes);
    });
}

/**
 * Pasos que contestan una pregunta directa: aunque el texto sea idéntico al de
 * hace 10 min, la persona volvió a preguntar y callarse sería peor que repetir
 * («¿cuánto debo?» → el mismo estado de pagos). El resto de mensajes del bot
 * (avisos, plantillas, acuses, escalaciones) sí se frena.
 */
export const PASOS_QUE_CONTESTAN_UNA_PREGUNTA = new Set([
    'get_payment_status', 'get_payment_methods', 'medios_de_pago_publicos', 'llm_text', 'llm_error_menu',
    'payment_fallback', 'medios_fallback', 'info_escuela_fallback', 'get_school_info', 'estado_comprobantes',
    'otp_sent', 'otp_failed', 'otp_verificado', 'ask_consent', 'opt_in_confirmado', 'opt_in_registrado',
    'opt_out_confirmado', 'opt_in_reactivado', 'consent_rechazado', 'confirmar_baja', 'baja_mantenida',
    'revinculado_por_telefono',
]);

/**
 * ¿Este saliente está exento del freno de repetición? Los pasos de un flujo con
 * estado (clase de cortesía, puerta del desconocido: `contexto.flujo`) repiten la
 * pregunta a propósito cuando no entendieron la respuesta, y los que contestan
 * una pregunta directa se repiten si la persona vuelve a preguntar. Pura.
 */
export function exentoDeAntirrepeticion(contexto: Record<string, unknown> | null | undefined): boolean {
    const c = contexto ?? {};
    const paso = String(c.step ?? '');
    return Boolean(c.flujo) || c.repetible === true
        || PASOS_QUE_CONTESTAN_UNA_PREGUNTA.has(paso) || paso.startsWith('cortesia_') || paso.endsWith('_fallback');
}

// ─── Horas hábiles (SLA de escalamientos, conversación v2) ───────────────────

/** `whatsapp_settings.business_hours`: `{ tz, dias: { "1": ["16:00","21:00"], … } }` (0 = domingo). */
export interface HorarioDeAtencion { tz?: string; dias?: Record<string, [string, string]> }

/** Horas hábiles que tiene la escuela para contestar un escalamiento antes del aviso por correo/push. */
export const SLA_ESCALAMIENTO_MIN_HABILES = Number(process.env.WHATSAPP_SLA_ESCALAMIENTO_MIN) || 120;

const aMin = (hhmm: string): number => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
};

/** Minutos de diferencia entre la hora local de `tz` y UTC en el instante `ms` (Bogotá: -300). */
function desfaseDeZona(tz: string, ms: number): number {
    try {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
        const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
        return Math.round((local - Math.floor(ms / 1000) * 1000) / 60_000);
    } catch {
        return -300;
    }
}

/**
 * Minutos HÁBILES entre `desde` y `hasta` (ms) según el horario de atención.
 * Sin horario configurado cuenta el reloj corrido (no se asume que la escuela
 * está cerrada: prometer menos es mejor que inventar un horario). El desfase de
 * la zona se toma una vez (Bogotá no tiene horario de verano). Pura.
 */
export function minutosHabiles(desde: number, hasta: number, cfg: HorarioDeAtencion | null | undefined): number {
    if (!Number.isFinite(desde) || !Number.isFinite(hasta) || hasta <= desde) return 0;
    const dias = cfg?.dias;
    if (!dias || !Object.keys(dias).length) return Math.floor((hasta - desde) / 60_000);
    const desfase = desfaseDeZona(cfg?.tz || 'America/Bogota', desde);
    let total = 0;
    let cursor = desde;
    while (cursor < hasta) {
        const local = new Date(cursor + desfase * 60_000);
        const dow = local.getUTCDay();
        const minDelDia = local.getUTCHours() * 60 + local.getUTCMinutes() + local.getUTCSeconds() / 60;
        const finDelDia = Math.min(hasta, cursor + (1440 - minDelDia) * 60_000);
        const rango = dias[String(dow)];
        if (rango) {
            const a = Math.max(minDelDia, aMin(rango[0]));
            const b = Math.min(minDelDia + (finDelDia - cursor) / 60_000, aMin(rango[1]));
            if (b > a) total += b - a;
        }
        cursor = finDelDia;
    }
    return Math.floor(total);
}

/** ¿Pasaron `minHabiles` minutos hábiles desde que se creó la escalación? Pura. */
export function slaVencido(
    creadaAt: string | number | Date,
    ahora: number,
    cfg: HorarioDeAtencion | null | undefined,
    minHabiles = SLA_ESCALAMIENTO_MIN_HABILES,
): boolean {
    const t = new Date(creadaAt).getTime();
    return Number.isFinite(t) && minutosHabiles(t, ahora, cfg) >= minHabiles;
}
