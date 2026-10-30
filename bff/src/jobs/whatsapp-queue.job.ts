/**
 * whatsapp-queue.job — procesa los comprobantes que llegan por el chat.
 *
 * El webhook solo encola (ver whatsapp-queue.service). Acá se hace el trabajo
 * lento: bajar el archivo de Graph, guardarlo, leerlo y aplicarlo al pago que
 * corresponde.
 *
 * Dos reglas que mandan sobre todo lo demás:
 *
 *  1. **El archivo se guarda ANTES del OCR.** La URL de media de Meta expira en
 *     minutos; si se baja, se pasa al OCR y el OCR falla, un reintento veinte
 *     minutos después ya no puede bajar nada y el comprobante del padre se
 *     pierde sin dejar rastro.
 *
 *  2. **Un OCR caído nunca rechaza.** Si no se pudo leer, la fila espera y
 *     reintenta; jamás produce un veredicto. Confundir «no pude leer» con «no es
 *     válido» rechazaría pagos buenos en masa.
 *
 * Plan: docs/specs/whatsapp-cola-de-comprobantes-plan.md §4.3 y §4.4
 */

import { APP_PUBLICA_PROD } from '../utils/url-publica-familias';
import crypto from 'node:crypto';
import { supabase } from '../config/supabase';
import {
    downloadMedia, sendTextMessage, sendInteractiveButtons, aFormatoWhatsApp, type WhatsAppIntegration,
} from '../services/whatsapp.service';
import { estaDadoDeBaja, AVISO_DADO_DE_BAJA } from '../services/whatsapp-optin.service';
import { extractReceipt } from '../services/ocr.service';
import { conContextoLlm } from '../services/llm-usage.service';
import { extractEnrollmentForm, type EnrollmentFormResult } from '../services/enrollment-ocr.service';
import { buildVerdictContext } from '../services/receipt-context.service';
import { normalizeDestination, normalizeReference, evaluateVerdict, destinationMatchesRegistered } from '../services/receipt-verdict';
import { evaluatePaymentReceipt, redRejectionMessage } from '../services/receipt-approval.service';
import { frenarSiExcedeLimite } from '../services/wa-limite-comprobantes.service';
import { revinculacionPendiente } from '../services/wa-revinculacion.service';
import { debeAtender, type TipoDeContacto } from '../services/whatsapp-atencion.service';
import { esMarcaNoFamilia } from '../services/whatsapp-tipo-contacto';
import {
    anunciaComprobante, normalizarFrase, PASOS_SIN_CUENTA, humanoReciente, type ComprobanteAnunciado, type FilaReciente,
} from '../services/whatsapp-reglas-turno';
import {
    pagosPendientesDe, resolverPago, describirPago, mensajeElegirPago,
    type PagoPendiente,
} from '../services/whatsapp-receipt-matching.service';
import { invitacionPendienteVigente } from '../services/whatsapp-invitacion-vigente.service';
import { identificarStaffPorTelefono, recibirPlanillaDeStaff } from '../services/whatsapp-asistencia-staff.service';
import { esErrorDeVentana } from '../services/whatsapp-plantillas.service';

// El mismo Logger que usa receipt-approval.service, para poder pasárselo tal cual
// a evaluatePaymentReceipt sin castear.
import type { Logger } from 'pino';
import {
    detectarOtroConcepto, decidirOtroConcepto, mensajeOtroConcepto, motivoOtroConcepto, textosAlrededor,
    type SenalOtroConcepto,
} from '../services/whatsapp-otro-concepto.service';
import { ventaAbiertaDeContacto, decidirComprobanteDeVenta } from '../services/whatsapp-venta-servicios.service';
import {
    fichasPorTelefono, deportistaPorNombre, pendientesPorLlaves, pagoYaRegistrado, botonesDeCobros,
    PREGUNTA_DEPORTISTA, PASO_PREGUNTA_DEPORTISTA, TEXTO_YA_REGISTRADO, type LlavesDeFicha,
} from '../services/whatsapp-comprobante-de-ficha.service';
import type { BotonInteractivo } from '../services/whatsapp.service';
import {
    leerTextosDelComprobante, decidirCobroPorTexto, type CobroParcial,
} from '../services/whatsapp-cobro-por-texto.service';
import {
    cargarRecargos, montoEsperado, textoExcedente, huellasDelComprobante, referenciasDelComprobante,
    ordenarDelMasAntiguo, cubrirCobrosConComprobante,
} from '../services/whatsapp-excedente.service';
import {
    calcularCandidatosDePago, textoPropuesta, motivoConPropuesta, type PropuestaDePago,
} from '../services/whatsapp-pago-esperado.service';
import { cargarItemsDeTorneo, cruzarTorneo, motivoTorneo } from '../services/whatsapp-torneos-pago.service';
import {
    candidatosParaPreguntar, botonesDeDeportistas, opcionesDeDeportistas, textoPreguntaDeportista,
    deportistasParaPreguntar, fichasDesdeDeportistas, guardarPreguntaGuiada, opcionesDeMeses, ultimosMeses,
    botonesDeOpciones, textoPreguntaMes, textoPreguntaConcepto, OPCIONES_CONCEPTO, PASO_PREGUNTA_MES,
    PASO_PREGUNTA_CONCEPTO, PASO_PREGUNTA_DEPORTISTA_BOTONES, textoCierreEnRevision, mesDeCobroEnTexto,
    PASO_RESUMEN_MOTIVOS, BOTON_MOTIVOS_OK, BOTON_MOTIVOS_CAMBIAR,
    type GuiaGuardada,
} from '../services/whatsapp-comprobante-guiado.service';
import { categoriaDelCobro, etiquetaDelCobro } from '../services/tipo-de-cobro';
import { modoDiscreto, escuelaActiva } from '../services/whatsapp-modo-discreto';
import type { Verdict } from '../services/receipt-verdict';
import type { Motivo } from '../services/motivos-de-cobro';
import { MOTIVO_DE_OTRO_CONCEPTO } from '../services/whatsapp-otro-concepto.service';
import {
    cobroDesdeComprobanteActivo, preciosDeMotivos, motivoPorMonto, decidirConEsperado, opcionesDeMotivo,
    crearCobroDesdeComprobante, anularCobroCreado, pendientesDelLead, leadPorTelefono, destinoExactoDelComprobante,
    conceptoDelCobroCreado, valorDePrecio, yaTieneCobroDelMotivo, hoyBogota,
    type PrecioDeMotivo, type ValorMotivoElegido, type DuenoDelCobro, type DestinoExacto, type MotivoPorMonto,
} from '../services/wa-cobro-desde-comprobante.service';
import {
    conceptosEsperadosDe, elegirEsperado, consumirEsperado, type ConceptoEsperado,
} from '../services/wa-concepto-esperado.service';
import type { FichaConNombre, OpcionGuiada } from '../services/whatsapp-comprobante-guiado.service';

const BUCKET = 'payment-receipts';
const LOTE = 10;
const LEASE_MIN = 5;
const MAX_REINTENTOS = 5;
/** Minutos en los que NO se repite un mensaje idéntico al mismo contacto. */
const VENTANA_ANTI_REPETICION_MIN = 10;

export interface FilaCola {
    id: string;
    integration_id: string;
    school_id: string;
    wa_phone_number: string;
    wa_message_id: string;
    media_id: string | null;
    media_mime_type: string | null;
    storage_path: string | null;
    retries: number;
    /** Vienen en el `q.*` del claim; opcionales para no romper llamadores viejos. */
    media_caption?: string | null;
    created_at?: string | null;
}

// ─── Pista del cobro anunciado (P3, análisis 2026-10-06) ────────────────────
//
// La familia suele ANUNCIAR el comprobante con texto antes o después de la
// foto («Hola, envío el comprobante de pago de Mensualidad 10/2026 - X (octubre
// 2026) de X. (ref. ABCD1234)», el texto precargado de /p/:token). Cuando el
// monto no desempata entre varios pendientes, esa pista decide en vez de
// preguntarle «¿a cuál de estos?».

export interface PistaDeCobro { ref: string | null; concepto: string | null }

/**
 * El cobro que la pista señala, o null. Por ref (prefijo del id) primero —es
 * exacta—; por concepto, solo si coincide con UNO.
 */
export function elegirPorPista(pendientes: PagoPendiente[], pista: PistaDeCobro | null): PagoPendiente | null {
    if (!pista) return null;
    if (pista.ref) {
        const ref = pista.ref.toLowerCase();
        const porRef = pendientes.filter((p) => String(p.id).replace(/-/g, '').toLowerCase().startsWith(ref));
        if (porRef.length === 1) return porRef[0];
    }
    if (pista.concepto) {
        const c = normalizarFrase(pista.concepto);
        const porConcepto = pendientes.filter((p) => normalizarFrase(p.concept) === c);
        if (porConcepto.length === 1) return porConcepto[0];
    }
    return null;
}

/** Junta la pista del pie de la foto y de los textos de la familia cerca de ella. */
export function pistaDesdeTextos(textos: (string | null | undefined)[]): PistaDeCobro | null {
    let mejor: ComprobanteAnunciado | null = null;
    for (const t of textos) {
        const a = anunciaComprobante(t);
        if (!a) continue;
        if (a.ref) return { ref: a.ref, concepto: a.concepto ?? null };
        if (a.concepto && !mejor?.concepto) mejor = a;
    }
    return mejor?.concepto ? { ref: null, concepto: mejor.concepto } : null;
}

// ─── Adjunto que NO es un comprobante (análisis 2026-10-06, Dynasty) ────────
//
// Caso real: una mamá SIN cuenta escribió «acabo de ver un correo», mandó la
// captura del correo de estado de cuenta y siguió con «llevo varios meses sin
// asistir» y «no entiendo porque me estan cobrando?». El camino de familia sin
// cuenta no leía la imagen ni el texto: respondió «Recibí tu comprobante 📄 …
// se lo paso a la escuela para que lo aplique» y dejó la fila en el buzón de
// comprobantes (`escalated`) como si fuera un pago. Era un reclamo.

/**
 * ¿Lo que la familia escribe alrededor del adjunto es un reclamo o una
 * pregunta sobre un cobro? Entonces el adjunto acompaña una CONSULTA, no un
 * pago: lo atiende una persona, y no se le dice «Recibí tu comprobante».
 */
const SENALES_DE_CONSULTA: RegExp[] = [
    /\b(por ?que|porq|xq|pq)\b.*\bcobr/,                                   // ¿por qué me cobran?
    /\bno entiendo\b/,
    /\bcobr\w* (de mas|doble|dos veces|equivocad\w*|indebid\w*|errad\w*|mal)\b/,
    /\bsin asistir\b/,
    /\bno (he|ha|hemos|han) (ido|asistido|venido|vuelto)\b/,
    /\bno (asiste|asisto|asistio|asistimos|asisten)\b/,
    /\bno (le )?(debo|debemos)\b/,
    /\b(reclamo|queja)\b/,
    /\baclar\w*/,                                                          // «me puedes aclarar»
    /\bestado de cuenta\b/,
    /\b(vi|ver|veo|llego|llega|recibi|mandaron|enviaron|enviaste|mandaste) (un|el|este|ese|su|tu) correo\b/,
];

export function esConsultaSobreCobro(textos: (string | null | undefined)[]): boolean {
    return textos.some((t) => {
        const n = normalizarFrase(t);
        return !!n && SENALES_DE_CONSULTA.some((re) => re.test(n));
    });
}

/**
 * ¿La lectura muestra un comprobante de pago de verdad? Monto, y una prueba de
 * la transacción: la referencia, o la fecha con el banco. Un correo de cobro o
 * un estado de cuenta trae monto y fecha, pero ni referencia ni banco.
 */
export function pareceComprobanteDePago(ocr: Partial<Awaited<ReturnType<typeof extractReceipt>>> | null | undefined): boolean {
    if (!ocr || ocr.isReceipt === false || ocr.isTransactionList === true) return false;
    if (!(typeof ocr.amount === 'number' && ocr.amount > 0)) return false;
    if (ocr.reference && String(ocr.reference).trim()) return true;
    return !!ocr.date && !!ocr.bank && ocr.bank !== 'Otro';
}

/** Los textos de la familia alrededor del adjunto: el pie y lo que escribió cerca. */
async function textosCercanos(fila: FilaCola): Promise<(string | null | undefined)[]> {
    const textos: (string | null | undefined)[] = [fila.media_caption];
    try {
        const { data: conv } = await supabase.from('whatsapp_conversations')
            .select('id').eq('integration_id', fila.integration_id).eq('contact_wa_id', fila.wa_phone_number)
            .maybeSingle();
        if ((conv as any)?.id) {
            const base = fila.created_at ? new Date(fila.created_at).getTime() : Date.now();
            const { data } = await supabase.from('whatsapp_messages')
                .select('text_body, created_at')
                .eq('conversation_id', (conv as any).id)
                .eq('direction', 'inbound')
                .gte('created_at', new Date(base - 15 * 60_000).toISOString())
                .lte('created_at', new Date(base + 5 * 60_000).toISOString())
                .limit(30);
            for (const m of (Array.isArray(data) ? data : []) as any[]) textos.push(m?.text_body);
        }
    } catch {
        // Sin textos se decide solo con el pie y la lectura.
    }
    return textos;
}

/** ¿Escribió una persona de la escuela en este chat en los últimos 15 min? Nunca lanza; ante el error, false. */
async function escuelaAtendiendoElChat(fila: FilaCola): Promise<boolean> {
    try {
        const { data: conv } = await supabase.from('whatsapp_conversations')
            .select('id').eq('integration_id', fila.integration_id).eq('contact_wa_id', fila.wa_phone_number)
            .maybeSingle();
        if (!(conv as any)?.id) return false;
        const { data } = await supabase.from('whatsapp_messages')
            .select('direction, type, text_body, payload, ai_generated, wa_timestamp, created_at')
            .eq('conversation_id', (conv as any).id)
            .gte('created_at', new Date(Date.now() - 15 * 60_000).toISOString())
            .limit(60);
        return humanoReciente((Array.isArray(data) ? data : []) as FilaReciente[], 15);
    } catch {
        return false;
    }
}

async function pistaDeCobro(fila: FilaCola): Promise<PistaDeCobro | null> {
    try {
        return pistaDesdeTextos(await textosCercanos(fila));
    } catch {
        return null;
    }
}

/**
 * Cobros abonados (`partial`) de la familia, con lo pagado: «envío el saldo»
 * se compara contra lo que les falta. Nunca lanza.
 */
async function cobrosParcialesDe(
    schoolId: string, parentId: string | null, llaves?: LlavesDeFicha,
): Promise<CobroParcial[]> {
    try {
        const r = await import('../services/whatsapp-recuperacion.service');
        const registrados = parentId && !llaves
            ? await r.pagosRegistradosDeLaFamilia(parentId, schoolId)
            : await r.pagosRegistradosDe(schoolId, { parentId, ...(llaves ?? {}) });
        return registrados.filter((p) => p.status === 'partial')
            .map((p) => ({ id: p.id, amount: p.amount, amount_paid: p.amount_paid, concept: p.concept }));
    } catch {
        return [];
    }
}

/**
 * ¿La escuela recibe abonos (`school_settings.allow_installments`)? Ante la
 * duda, no: el default de la columna es false y equivocarse diciendo «sí»
 * estampa en silencio un monto que no cuadra.
 */
async function escuelaRecibeAbonos(schoolId: string): Promise<boolean> {
    try {
        const { data } = await supabase.from('school_settings')
            .select('allow_installments').eq('school_id', schoolId).maybeSingle();
        return (data as any)?.allow_installments === true;
    } catch {
        return false;
    }
}

// ─── Mensajes al acudiente ───────────────────────────────────────────────────
// Todos siguen la misma forma: qué revisamos → qué encontró → qué necesitamos →
// cómo seguir. Nunca «contáctanos».

const M = {
    // Antes había acá un `noIdentificado` que pedía el correo para mandar un
    // código. Se eliminó el 2026-10-03: con el bot APAGADO le salió de verdad a
    // 17 familias de Dynasty, y a todas se las podía reconocer por el teléfono
    // (`wa_identify_by_phone`), que este worker no consultaba. Un comprobante
    // no es momento de pedir un trámite: o se sabe quién es, o lo ve la escuela.

    sinCuenta:
        'Recibí tu comprobante 📄 Como todavía no tienes tu cuenta creada, ' +
        'se lo paso a la escuela para que lo aplique.',

    numeroAmbiguo:
        'Recibí tu comprobante 📄 Tu número está en más de una cuenta de la escuela, ' +
        'así que se lo paso a la escuela para que lo aplique a la que corresponde.',

    // Familia reconocida (por OTP) cuya conversación ya no tiene acudiente: no
    // debería pasar, pero si pasa no se le pide nada — lo resuelve un humano.
    escaladoSinAcudiente:
        'Recibí tu comprobante 📄 Se lo paso a la escuela para que lo aplique.',

    sinPendientes:
        'Recibí tu comprobante, pero ahora mismo no tienes cobros pendientes ✅ ' +
        'Si crees que falta alguno, la escuela lo revisa y te confirma.',

    noEsComprobante:
        'Revisé el archivo que enviaste y *no es un comprobante de pago*.\n\n' +
        'Si es el código QR o la llave para pagar: eso es lo que usas para *hacer* ' +
        'la transferencia. Lo que necesito es la pantalla que te muestra el banco ' +
        '*después* de enviar el dinero, la que dice "Transferencia exitosa" con el ' +
        'valor, la fecha y el número de aprobación.\n\n' +
        'Cuando la tengas, mándala por acá y la valido en un minuto.',

    esListado:
        'Revisé el archivo y es un *listado de movimientos*, no el comprobante de ' +
        'un pago puntual. Mándame el comprobante de esa transferencia sola y lo ' +
        'valido enseguida.',

    noSePudoLeer:
        'Recibí tu comprobante pero no logré leerlo bien 😕 La escuela lo va a ' +
        'revisar a mano y te confirma.',

    // El adjunto acompaña una pregunta o un reclamo sobre un cobro (o no es un
    // comprobante y la familia no tiene cuenta): no se dice «comprobante», no se
    // promete aplicar nada y no se ofrece el registro — lo atiende una persona.
    consulta:
        'Recibí tu mensaje 🙏 Se lo paso a la escuela para que lo revise contigo ' +
        'y te responda por aquí.',
} as const;

const cop = (n: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
/** «$310.000», sin el espacio del formato de moneda: el de los textos nuevos (plan B4), igual que el cierre guiado. */
const pesos = (n: number) => `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n))}`;

/**
 * ¿Vale la pena reintentar este fallo de `downloadMedia`?
 *
 * Se decide por LISTA BLANCA de lo transitorio, no por lista negra de lo
 * permanente: los códigos llevan sufijo (`mime_no_soportado:image/gif`,
 * `archivo_muy_grande:9400000`), así que compararlos por igualdad falla en
 * silencio y termina reintentando cinco veces algo irrecuperable, contra un
 * proveedor que cobra.
 *
 * Transitorio: la red, el 429 y los 5xx. Todo lo demás —mime rechazado, archivo
 * muy grande, media que ya expiró (4xx)— no mejora reintentando.
 *
 * El token que no desencripta SÍ se reintenta: no depende del archivo sino de
 * QUÉ proceso tomó la fila. La cola es una sola para todos los BFF (una
 * Supabase compartida), y un consumidor con otra WHATSAPP_TOKEN_ENC_KEY —o sin
 * ella— la cerraba en `failed` sin bajar el archivo, aunque prod sí podía
 * (Dynasty 10-10/11: 4 comprobantes perdidos intercalados con éxitos). Falla
 * antes de llamar a Meta, así que reintentar no cuesta nada.
 */
export function esTransitorio(error: string): boolean {
    if (error === 'network_error' || error === '' || error === 'token_decrypt_failed') return true;
    const m = error.match(/_(\d{3})(?::|$)/);
    if (m) {
        const codigo = Number(m[1]);
        return codigo === 408 || codigo === 429 || codigo >= 500;
    }
    return false;
}

// ─── Cierres de fila ─────────────────────────────────────────────────────────

async function cerrar(
    id: string,
    status: 'done' | 'ignored' | 'failed',
    extra: Record<string, unknown> = {},
) {
    const { error } = await supabase.from('whatsapp_inbound_queue')
        .update({ status, processed_at: new Date().toISOString(), locked_until: null, ...extra })
        .eq('id', id);
    // Un cierre que falla deja la fila en 'processing' y se reprocesa cuando
    // vence el lease. Que al menos quede en el log (así pasó con el
    // result_type 'enrollment_form', que el CHECK rechaza).
    if (error) console.error('[wa-queue] no se pudo cerrar la fila', { id, status, err: error.message });
}

/**
 * Deja la fila esperando la respuesta del acudiente, CON todo lo necesario
 * para aplicarla despues.
 *
 * Hasta el 2026-09-15 esto solo ponia el estado y nadie volvia a mirar la fila:
 * el bot preguntaba «respondeme con el numero», el padre contestaba, y ese
 * mensaje se iba al LLM —que no sabia que hubo una pregunta—. El comprobante
 * quedaba colgado y el padre creyendo que lo habiamos aplicado.
 */
async function esperarAlUsuario(id: string, pregunta: {
    opciones: PagoPendiente[];
    ocr: Awaited<ReturnType<typeof extractReceipt>>;
    sha: string;
    storagePath: string | null;
    /** null: familia sin cuenta (cobros por ficha) o número sin ficha. */
    parentId: string | null;
    /** 'deportista': se preguntó de qué deportista es (número sin ficha). */
    tipo?: 'cobro' | 'deportista';
    /** Opciones de los botones de deportista (2026-10-24): el «1», «2» de la respuesta apunta a ellas. */
    guia?: GuiaGuardada;
    /**
     * (Plan B4, 2026-10-30) La pregunta NO salió porque el contacto ya tiene otra
     * abierta: queda en fila (`pregunta_at` null) y sale cuando se resuelva la
     * anterior (`promoverSiguientePregunta`).
     */
    enFila?: PreguntaEnFila | null;
}) {
    await supabase.from('whatsapp_inbound_queue')
        .update({
            status: 'waiting_user',
            locked_until: null,
            updated_at: new Date().toISOString(),
            pregunta_opciones: pregunta.opciones,
            pregunta_ocr: {
                ocr: pregunta.ocr,
                sha: pregunta.sha,
                storagePath: pregunta.storagePath,
                parentId: pregunta.parentId,
                // Para que la bandeja la cierre sola si la escuela decide el
                // pago por otro lado (referencia alternativa del comprobante).
                referencias: referenciasDelComprobante(pregunta.ocr),
                ...(pregunta.tipo === 'deportista' ? { tipo: 'deportista' } : {}),
                ...(pregunta.guia ? { guia: pregunta.guia } : {}),
                ...(pregunta.enFila ? { en_fila: { ...pregunta.enFila, monto: pregunta.enFila.monto ?? pregunta.ocr?.amount ?? null } } : {}),
            },
            pregunta_at: pregunta.enFila ? null : new Date().toISOString(),
        })
        .eq('id', id);
}

/**
 * Fallo TRANSITORIO: vuelve a 'pending' con backoff. Esto es lo que separa «no
 * pude leer» de «no es válido»: acá no hay veredicto, hay otra oportunidad.
 */
async function reintentar(fila: FilaCola, motivo: string, log?: Logger) {
    const intentos = fila.retries + 1;
    const esperaMin = Math.min(2 ** intentos, 60); // 2, 4, 8, 16, 32, tope 60
    log?.warn?.({ queueId: fila.id, intentos, motivo }, '[wa-queue] transitorio, reintenta');
    await supabase.from('whatsapp_inbound_queue')
        .update({
            status: 'pending',
            retries: intentos,
            error_message: motivo,
            locked_until: null,
            next_retry_at: new Date(Date.now() + esperaMin * 60_000).toISOString(),
        })
        .eq('id', fila.id);
}

// ─── El procesamiento de una fila ────────────────────────────────────────────

/**
 * Contexto para estampar un comprobante, sin depender de la fila de la cola.
 *
 * Existe porque el estampado tiene DOS entradas: el worker cuando el monto
 * desempata solo, y la respuesta del acudiente cuando hubo que preguntarle a
 * cuál cobro aplicarlo. Antes solo existía la primera y la pregunta quedaba en
 * 'waiting_user' para siempre — nadie leía la respuesta.
 */
export interface ContextoAplicacion {
    queueId: string;
    schoolId: string;
    /** null: familia sin cuenta, el cobro se encontró por la ficha. */
    parentId: string | null;
    storagePath: string | null;
    /** sha256 de la imagen. Es la llave del dedup: no se recalcula, se pasa. */
    sha: string;
    ocr: Awaited<ReturnType<typeof extractReceipt>>;
    /** `linea` (plan B4): lo que el asistente decidió de este comprobante, para el resumen de la ráfaga. */
    responder: (texto: string, paso: string, botones?: BotonInteractivo[], linea?: LineaDeMotivo) => Promise<unknown>;
    /** Qué hacer ante un fallo transitorio. El worker reintenta; la respuesta no. */
    alFallar: (motivo: string) => Promise<void>;
    log?: Logger;
}

/** Lo que pasó al aplicar (los llamadores de siempre lo ignoran; B4 lo usa para anular o agendar). */
export type ResultadoAplicacion =
    | { ok: true; action: string; veredicto: Verdict }
    | { ok: false; duplicado: boolean };

/** Reemplaza la respuesta a la familia después de aplicar (B3: «Tu clase quedó el sábado…»). */
export type AlAplicar = (r: { action: string; veredicto: Verdict; pago: PagoPendiente }) =>
    Promise<{ texto: string; botones?: BotonInteractivo[]; paso?: string } | null>;

/**
 * Estampa el comprobante en UN pago, con su veredicto, y le cuenta al acudiente.
 *
 * `restantes` son los cobros que quedan vivos después de este. No es cosmético:
 * es la mitad de la regla de la escuela y lo único que evita que el padre crea
 * que quedó al día cuando solo pagó el atrasado.
 */
/** Resultado de estampar un comprobante en un cobro, sin hablar con nadie. */
export type ResultadoEstampado =
    | { ok: true; veredicto: ReturnType<typeof evaluateVerdict>; actualizado: boolean }
    /** 23505: esa referencia de banco ya está en otro pago de la escuela. */
    | { ok: false; duplicado: true; yaAplicado: { id: string; concept: string | null; amount: number; status: string } | null }
    | { ok: false; duplicado: false; error: string };

/**
 * Deja el comprobante en el cobro: archivo, lectura, veredicto y
 * `awaiting_approval`. NADA más — ni aprueba, ni responde, ni cierra la fila.
 *
 * Se separó de `aplicarComprobante` el 2026-10-05 para la recuperación en lote
 * (scripts/wa-recuperar-comprobantes.ts y el importador de chats exportados):
 * esos caminos tienen que dejar el comprobante EXACTAMENTE como lo deja el
 * worker —mismas columnas, mismo veredicto, misma defensa antiduplicado— pero
 * sin `evaluatePaymentReceipt` (que con auto-aprobación prendida aprobaría
 * solo) y sin escribirle al acudiente. Un solo estampado para los tres caminos
 * evita que diverjan en qué columnas llenan.
 */
export async function estamparComprobante(
    ctx: Pick<ContextoAplicacion, 'schoolId' | 'storagePath' | 'sha' | 'ocr' | 'log' | 'queueId'>,
    pago: PagoPendiente,
    /**
     * Lo que el comprobante DEBE decir, si no es el valor del cobro: el monto
     * con el recargo del enlace de pago, o la suma de los cobros que cubre
     * (2026-10-13). Sin esto el veredicto marcaría MONTO_DIFIERE a un pago
     * completo.
     */
    esperado?: number,
    /**
     * Estados desde los que se estampa. Por defecto pending/overdue (el bot);
     * el enlace público /p/:token también acepta 'partial' (abono: el
     * comprobante es del saldo, que llega en `esperado`).
     */
    opciones: { estados?: string[] } = {},
): Promise<ResultadoEstampado> {
    /**
     * El veredicto se calcula ACÁ y se persiste. No es opcional.
     *
     * `evaluatePaymentReceipt` no lo computa cuando la escuela tiene el
     * auto-approve apagado: su comentario lo dice — «se decide con el veredicto
     * ya persistido, que lo computó el BFF en /extract-receipt». En la app ese
     * endpoint lo calcula al subir; el worker no pasa por ahí.
     *
     * Sin este bloque el comprobante quedaba en `awaiting_approval` con
     * `receipt_verdict` en null y la escuela lo revisaba a ciegas — exactamente
     * los 45 pagos sin veredicto que encontramos el 2026-09-11, reproducidos
     * por este código. Y `REFERENCIA_DUPLICADA` nunca se disparaba, que es la
     * defensa contra que el mismo comprobante se aplique dos veces.
     *
     * Se reconstruye el contexto porque el de §6 se armó sin referencia ni hash
     * —no se conocían todavía—, y son justo los que alimentan el dedup.
     */
    const ctxPago = await buildVerdictContext(ctx.schoolId, {
        referenceNorm: normalizeReference(ctx.ocr.reference),
        imageSha256: ctx.sha,
        expectedAmount: esperado ?? pago.amount,
        paymentId: pago.id,
    });
    const veredicto = evaluateVerdict(ctx.ocr, ctxPago);
    ctx.log?.info?.(
        { queueId: ctx.queueId, paymentId: pago.id, veredicto: veredicto.verdict, motivos: veredicto.reasons.map((r) => r.code) },
        '[wa-queue] veredicto',
    );

    const { data: estampados, error: stampErr } = await supabase.from('payments').update({
        receipt_url: ctx.storagePath,
        receipt_storage_bucket: BUCKET,
        receipt_image_sha256: ctx.sha,
        receipt_image_sha256_source: 'server_verified',
        ocr_amount: ctx.ocr.amount, ocr_date: ctx.ocr.date, ocr_bank: ctx.ocr.bank,
        ocr_reference: ctx.ocr.reference, ocr_destination: ctx.ocr.destination,
        ocr_provider: ctx.ocr.provider,
        // Quién hizo la transferencia (reporte «Torneos: quién pagó qué», 2026-10-24).
        ocr_origin_name: ctx.ocr.originName ?? null,
        receipt_verdict: veredicto.verdict,
        receipt_verdict_reasons: veredicto.reasons,
        receipt_verdict_at: new Date().toISOString(),
        status: 'awaiting_approval',
    }).eq('id', pago.id).in('status', opciones.estados ?? ['pending', 'overdue']).select('id');

    if (stampErr) {
        // 23505 sobre `uq_payments_school_ocr_reference` NO es un fallo: es la
        // base diciendo que esa referencia de banco ya se usó en esta escuela.
        // Es la última defensa contra aplicar el mismo comprobante dos veces, y
        // hay que leerla como tal.
        //
        // Tratarla como transitorio —que es lo que hacía— dejaba al acudiente sin
        // ninguna respuesta y ponía la fila a reintentar cinco veces contra una
        // restricción que nunca va a ceder, pagando OCR en cada vuelta.
        if (stampErr.code === '23505') {
            const { data: yaAplicado } = await supabase
                .from('payments')
                .select('id, concept, amount, status')
                .eq('school_id', ctx.schoolId)
                .eq('ocr_reference', ctx.ocr.reference)
                .maybeSingle();
            return {
                ok: false,
                duplicado: true,
                yaAplicado: yaAplicado
                    ? { id: yaAplicado.id as string, concept: (yaAplicado.concept as string) ?? null,
                        amount: Number(yaAplicado.amount), status: yaAplicado.status as string }
                    : null,
            };
        }
        return { ok: false, duplicado: false, error: `no se pudo estampar el pago: ${stampErr.message}` };
    }
    // `actualizado` = false si el cobro dejó de estar pendiente entre la
    // búsqueda y el estampado (la escuela lo registró en el medio). El worker
    // no lo mira —conserva su comportamiento—; la recuperación sí, para no
    // reportar «en revisión» un comprobante que no quedó en ningún cobro.
    return { ok: true, veredicto, actualizado: Array.isArray(estampados) ? estampados.length > 0 : true };
}

export async function aplicarComprobante(
    ctx: ContextoAplicacion,
    pago: PagoPendiente,
    restantes: PagoPendiente[],
    /**
     * (2026-10-13) `esperado`: ver `estamparComprobante`. `cubre`: otros cobros
     * que paga el MISMO comprobante (suma exacta); quedan en revisión con el
     * mismo archivo ANTES de evaluar, para que la base no tome la suma como
     * saldo a favor. `nota`: una línea más para la familia (excedente).
     */
    extra: {
        esperado?: number; cubre?: PagoPendiente[]; nota?: string;
        /**
         * (2026-10-24) Abono: el comprobante es MENOR a la cuota. Queda en revisión y
         * NO pasa por `evaluatePaymentReceipt` (que con la auto-aprobación de la
         * escuela prendida podría aprobarlo): un abono lo aprueba una persona.
         * `motivo` queda en `error_message` de la fila (la propuesta armada).
         */
        soloRevision?: boolean; motivo?: string;
        /**
         * (Plan B4, 2026-10-30) `linea`: va con la respuesta al resumen de la
         * ráfaga. `para`: cómo se nombra el cobro en el cierre (el nombre del
         * servicio creado). `alAplicar`: reemplaza la respuesta (la agenda de la
         * clase de prueba).
         */
        linea?: LineaDeMotivo; para?: string; alAplicar?: AlAplicar;
    } = {},
): Promise<ResultadoAplicacion> {
    const estampado = await estamparComprobante(ctx, pago, extra.esperado);

    if (!estampado.ok) {
        // 23505 sobre `uq_payments_school_ocr_reference` NO es un fallo: ver
        // el comentario en `estamparComprobante`.
        if (estampado.duplicado) {
            const yaAplicado = estampado.yaAplicado;
            const donde = yaAplicado
                ? ` Ya está aplicado a *${yaAplicado.concept}* por ${cop(Number(yaAplicado.amount))}.`
                : '';
            await ctx.responder(
                `Ese comprobante ya lo había recibido, así que no lo apliqué de nuevo.${donde}\n\n` +
                'Si hiciste otra transferencia, mándame el comprobante de esa — el número de ' +
                'aprobación tiene que ser distinto.',
                'comprobante_repetido',
            );
            await cerrar(ctx.queueId, 'ignored', {
                result_type: 'none',
                // El pago que YA tiene esa referencia: la Bandeja cierra la fila
                // sola con él. `result_type` sigue 'none': el aviso de desenlace
                // (whatsapp-payment-outcome) no la toma.
                ...(yaAplicado?.id ? { result_ref_id: yaAplicado.id } : {}),
                error_message: `referencia ya usada: ${ctx.ocr.reference}`,
            });
            ctx.log?.info?.({ queueId: ctx.queueId, referencia: ctx.ocr.reference }, '[wa-queue] comprobante repetido');
            return { ok: false, duplicado: true };
        }
        await ctx.alFallar(estampado.error);
        return { ok: false, duplicado: false };
    }

    const cubre = extra.cubre ?? [];
    if (cubre.length) {
        const r = await cubrirCobrosConComprobante(ctx.schoolId, pago.id, cubre.map((c) => c.id));
        // Si falla, el principal queda con el comprobante entero: al aprobarlo,
        // lo de más se vuelve saldo a favor y se descuenta de esos mismos
        // cobros pendientes. No se pierde plata; queda en el log.
        if (!r.ok) ctx.log?.warn?.({ queueId: ctx.queueId, paymentId: pago.id, err: r.error }, '[wa-queue] no se pudieron cubrir los otros cobros');
    }

    const resultado: { action: string; reason?: string | null } = extra.soloRevision
        ? { action: 'manual_review' }
        : await evaluatePaymentReceipt(pago.id, ctx.log);

    // 8. Contarle al acudiente qué pasó, nombrando el pago para que pueda corregir.
    let respuesta: string;
    const destino = cubre.length
        ? [pago, ...cubre].map((c) => `*${describirPago(c)}*`).join(' y ')
        : `*${describirPago(pago)}*`;
    if (resultado.action === 'approved') {
        respuesta = `¡Listo! ✅ Apliqué tu pago a ${destino}.`
            + (restantes.length ? '' : ' Queda al día.');
    } else if (resultado.action === 'rejected') {
        respuesta =
            `Revisé tu comprobante para ${destino} y no lo pude validar.\n\n` +
            `${resultado.reason ?? ''}\n\nSi crees que hay un error, mándame el comprobante correcto por acá.`;
    } else {
        // Cierre de UNA línea (spec 3.3): «Listo: comprobante de $150.000 de Sofía
        // para octubre. La escuela lo confirma.» El cobro se nombra por su mes
        // (mensualidad) o por su tipo (inscripción, seguro, torneo…).
        respuesta = cubre.length
            ? `Recibí tu comprobante y lo apliqué a ${destino} 📄\n\nLa escuela lo está revisando y te confirma en poco tiempo.`
            : textoCierreEnRevision({
                monto: ctx.ocr?.amount ?? null,
                atleta: pago.atleta,
                para: extra.para ?? paraDelCobro(pago),
                abono: extra.soloRevision === true,
            });
    }
    if (extra.nota && resultado.action !== 'rejected') respuesta += `\n\n${extra.nota}`;

    // (Plan B4) Otra respuesta para la familia: la agenda de la clase de prueba.
    let paso = 'resultado_comprobante';
    let botones: BotonInteractivo[] | undefined;
    if (extra.alAplicar) {
        try {
            const otra = await extra.alAplicar({ action: resultado.action, veredicto: estampado.veredicto.verdict, pago });
            if (otra?.texto) {
                respuesta = otra.texto;
                paso = otra.paso ?? paso;
                botones = otra.botones?.length ? otra.botones : undefined;
            }
        } catch (e: any) {
            ctx.log?.warn?.({ queueId: ctx.queueId, err: e?.message }, '[wa-queue] alAplicar falló: sale la respuesta de siempre');
        }
    }

    // Lo que SIGUE debiendo. Sin esto, el acudiente que paga «lo pendiente»
    // se va convencido de que quedó al día y la escuela se entera cuando le
    // vence el mes corriente. La regla la fijó la escuela el 2026-09-15: se
    // aplica al más antiguo y el del mes en curso queda vivo — y se dice.
    if (restantes.length) {
        respuesta += `\n\nTe queda${restantes.length > 1 ? 'n' : ''} pendiente${restantes.length > 1 ? 's' : ''}:\n`
            + restantes.map((r) => `• ${describirPago(r)}`).join('\n');
    }

    const salida = await ctx.responder(respuesta, paso, botones, extra.linea) as { ok?: boolean; error?: string } | undefined;
    // En revisión y Meta rechazó el texto por ventana cerrada (cola atrasada
    // más de 24 h): `comprobante_en_revision` si está aprobada; si no, como antes.
    if (resultado.action !== 'approved' && resultado.action !== 'rejected'
        && salida?.ok === false && esErrorDeVentana(salida.error)) {
        await avisarRevisionTrasVentana(ctx, pago).catch(() => undefined);
    }

    await cerrar(ctx.queueId, 'done', {
        result_type: 'payment_receipt',
        result_ref_id: pago.id,
        matched_parent_id: ctx.parentId,
        matched_child_id: pago.child_id,
        error_message: extra.motivo ? extra.motivo.slice(0, 500) : null,
    });
    ctx.log?.info?.({ queueId: ctx.queueId, paymentId: pago.id, accion: resultado.action }, '[wa-queue] aplicado');
    return { ok: true, action: resultado.action, veredicto: estampado.veredicto.verdict };
}

/** A qué se refiere un cobro en el cierre de una línea: el mes (mensualidad) o su tipo (inscripción, seguro, torneo…). */
function paraDelCobro(p: PagoPendiente): string {
    const cat = categoriaDelCobro({ payment_category: p.categoria ?? null, concept: p.concept, due_date: p.due_date });
    if (cat === 'mensualidad') return mesDeCobroEnTexto({ due_date: p.due_date, concept: p.concept }) ?? 'la mensualidad';
    return etiquetaDelCobro({ payment_category: cat, concept: p.concept }).toLowerCase();
}

// ─── Pago esperado y preguntas guiadas (spec whatsapp-conversacion-v2-dynasty §3.3, §3.5, §3.6) ──

/**
 * El pago esperado de la familia contra el monto del comprobante, para el motivo
 * de la bandeja y para decidir el abono. `pagoAbono` es el ÚNICO cobro de
 * mensualidad del deportista al que se le puede abonar. Solo lectura; nunca lanza.
 */
async function pagoEsperadoDeLaFila(
    schoolId: string, parentId: string | null, llaves: LlavesDeFicha | undefined,
    monto: number | null, pendientes: PagoPendiente[],
): Promise<{ propuesta: PropuestaDePago; texto: string; pagoAbono: PagoPendiente | null } | null> {
    try {
        const r = await calcularCandidatosDePago({
            schoolId, monto,
            llaves: { parentId, childIds: llaves?.childIds, unregisteredIds: llaves?.unregisteredIds },
        });
        if (!r.deportistas.length) return null;
        let pagoAbono: PagoPendiente | null = null;
        if (r.propuesta.accion === 'abono_en_revision' && r.propuesta.candidato && monto !== null) {
            const dep = r.deportistas.find((d) => d.id === r.propuesta.candidato!.deportistaIds[0]);
            const delDeportista = pendientes.filter((p) => (p.child_id === dep?.id || (!!dep?.nombre && p.atleta === dep.nombre))
                && categoriaDelCobro({ payment_category: p.categoria ?? null, concept: p.concept }) === 'mensualidad'
                && p.amount > monto);
            pagoAbono = delDeportista.length === 1 ? delDeportista[0] : null;
        }
        return { propuesta: r.propuesta, texto: textoPropuesta(r.propuesta), pagoAbono };
    } catch {
        return null;
    }
}

/** El motivo de «otro concepto» con quién pagó, el deportista y —si es torneo— el cruce con el catálogo. */
async function motivoDeOtroConcepto(a: {
    senal: SenalOtroConcepto; fila: FilaCola; parentId: string | null; llaves?: LlavesDeFicha;
    ocr: Awaited<ReturnType<typeof extractReceipt>>;
}): Promise<string> {
    const base = motivoOtroConcepto(a.senal);
    try {
        const monto = a.ocr.amount ?? null;
        const ds = await deportistasParaPreguntar(a.fila.school_id, {
            parentId: a.parentId, childIds: a.llaves?.childIds, unregisteredIds: a.llaves?.unregisteredIds,
        });
        const nombres = ds.map((d) => d.nombre).filter(Boolean) as string[];
        const deportista = nombres.length === 1 ? nombres[0] : nombres.length > 1 ? `${nombres.join(' / ')} (¿cuál?)` : null;
        if (a.senal.concepto === 'torneo') {
            const items = await cargarItemsDeTorneo(a.fila.school_id);
            const cruce = cruzarTorneo({ textos: [a.fila.media_caption, a.ocr.description, a.senal.evidencia], monto, items });
            return motivoTorneo({ quienPago: a.ocr.originName, deportista, monto, cruce, evidencia: a.senal.evidencia });
        }
        return motivoConPropuesta(base,
            `Propuesta → pagó: ${a.ocr.originName ?? 'no se leyó'} · deportista: ${deportista ?? 'sin identificar'}`
            + `${monto ? ` · ${cop(monto)}` : ''} · registrar a mano como ${a.senal.concepto.replace('_', ' ')}`);
    } catch {
        return base;
    }
}

/**
 * Pregunta con botones lo que falta cuando la familia no tiene cobros pendientes:
 * UN deportista → el mes (últimos 3 + «Otro mes»); 2-3 → de cuál. Devuelve true si
 * la pregunta salió y la fila quedó esperando; false si no se pudo (conversación
 * tomada, sin deportistas, más de 3…): quien llama sigue como antes.
 */
async function preguntarMesOQuien(a: {
    fila: FilaCola; parentId: string | null; llaves?: LlavesDeFicha;
    ocr: Awaited<ReturnType<typeof extractReceipt>>; sha: string; storagePath: string | null;
    responder: Responder;
}): Promise<boolean> {
    try {
        const ds = await deportistasParaPreguntar(a.fila.school_id, {
            parentId: a.parentId, childIds: a.llaves?.childIds, unregisteredIds: a.llaves?.unregisteredIds,
        });
        const monto = a.ocr.amount ?? null;
        const quienPago = a.ocr.originName ?? null;
        const base = { ocr: a.ocr, sha: a.sha, storagePath: a.storagePath, parentId: a.parentId, referencias: referenciasDelComprobante(a.ocr) };
        if (ds.length === 1) {
            const d = ds[0];
            const opciones = opcionesDeMeses(ultimosMeses(new Date()));
            const r = await a.responder(textoPreguntaMes({ monto, atleta: d.nombre }), PASO_PREGUNTA_MES, botonesDeOpciones(opciones)) as SalidaDePregunta;
            if (r?.silenciado) return false;
            await guardarPreguntaGuiada(a.fila.id, base, 'mes', {
                opciones, monto, quienPago, parentId: a.parentId,
                deportista: { id: d.id, tipo: d.tipo, nombre: d.nombre, cuota: d.cuota },
            }, { enFila: r?.enFila });
            return true;
        }
        if (ds.length > 1 && ds.length <= 3) {
            const fichas = fichasDesdeDeportistas(ds);
            const r = await a.responder(textoPreguntaDeportista(), PASO_PREGUNTA_DEPORTISTA_BOTONES, botonesDeDeportistas(fichas)) as SalidaDePregunta;
            if (r?.silenciado) return false;
            await esperarAlUsuario(a.fila.id, {
                opciones: [], ocr: a.ocr, sha: a.sha, storagePath: a.storagePath, parentId: a.parentId, tipo: 'deportista',
                guia: { opciones: opcionesDeDeportistas(fichas), monto, quienPago, parentId: a.parentId },
                enFila: r?.enFila,
            });
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * «Ese valor no coincide con una mensualidad: ¿es de…?» [Mensualidad][Inscripción][Otro].
 * Con el interruptor de B4, `opciones` trae los 2 motivos con precio más
 * cercanos + «Otro» (`opcionesDeMotivo`). true si salió.
 */
async function preguntarConcepto(a: {
    fila: FilaCola; parentId: string | null; llaves?: LlavesDeFicha;
    ocr: Awaited<ReturnType<typeof extractReceipt>>; sha: string; storagePath: string | null;
    responder: Responder; propuesta: string | null; opciones?: OpcionGuiada[];
}): Promise<boolean> {
    try {
        const monto = a.ocr.amount ?? null;
        const opciones = a.opciones?.length ? a.opciones : OPCIONES_CONCEPTO;
        const ds = await deportistasParaPreguntar(a.fila.school_id, {
            parentId: a.parentId, childIds: a.llaves?.childIds, unregisteredIds: a.llaves?.unregisteredIds,
        });
        const r = await a.responder(textoPreguntaConcepto({ monto }), PASO_PREGUNTA_CONCEPTO, botonesDeOpciones(opciones)) as SalidaDePregunta;
        if (r?.silenciado) return false;
        await guardarPreguntaGuiada(a.fila.id,
            { ocr: a.ocr, sha: a.sha, storagePath: a.storagePath, parentId: a.parentId, referencias: referenciasDelComprobante(a.ocr) },
            'concepto', {
                opciones, monto, quienPago: a.ocr.originName ?? null, parentId: a.parentId,
                propuesta: a.propuesta,
                deportista: ds.length === 1 ? { id: ds[0].id, tipo: ds[0].tipo, nombre: ds[0].nombre, cuota: ds[0].cuota } : null,
            }, { enFila: r?.enFila });
        return true;
    } catch {
        return false;
    }
}
/** Ver `aplicarComprobante`: la plantilla de «en revisión» cuando el texto no pudo salir por ventana. */
async function avisarRevisionTrasVentana(ctx: ContextoAplicacion, pago: PagoPendiente): Promise<void> {
    const { data: fila } = await supabase.from('whatsapp_inbound_queue')
        .select('wa_phone_number').eq('id', ctx.queueId).maybeSingle();
    const telefono = (fila as any)?.wa_phone_number as string | undefined;
    if (!telefono) return;
    const { avisarRevisionPorPlantilla } = await import('../services/whatsapp-aviso-revision.service');
    const r = await avisarRevisionPorPlantilla({
        schoolId: ctx.schoolId, telefono, paymentId: pago.id, parentId: ctx.parentId,
        monto: ctx.ocr?.amount ?? null, atleta: pago.atleta, paso: 'resultado_comprobante_plantilla',
    });
    ctx.log?.info?.({ queueId: ctx.queueId, paymentId: pago.id, enviado: r.enviado, motivo: (r as any).motivo },
        '[wa-queue] ventana cerrada: aviso de revisión por plantilla');
}
/** Resultado de bajar y guardar el archivo — el llamador solo revisa `ok`; en `false` la fila ya quedó cerrada/reintentando y hay que retornar sin hacer nada más. */
type ArchivoBajado =
    | { ok: true; base64: string; mime: string; storagePath: string }
    | { ok: false };

/** Lo que devuelve `obtenerArchivoDeFila`, SIN haber tocado el estado de la fila. */
export type ArchivoObtenido =
    | { ok: true; base64: string; mime: string; storagePath: string | null }
    | { ok: false; error: string; transitorio: boolean };

/**
 * Baja (o relee) el archivo de una fila y, si `guardar`, lo sube al bucket y
 * estampa `storage_path` en la fila. NO cierra ni reintenta la fila: decide el
 * llamador.
 *
 * Existe aparte de `bajarYGuardarArchivo` para la recuperación en lote
 * (scripts/wa-recuperar-comprobantes.ts): esa ruta procesa filas `ignored`, y
 * el `reintentar` del worker las devolvería a `pending` — donde el cron las
 * tomaría y le respondería al acudiente. Y en simulación necesita el archivo
 * en memoria para el OCR sin subir nada (`guardar: false`).
 *
 * Misma ruta en el bucket que siempre: `{school}/whatsapp/{fila}.{ext}`.
 */
export async function obtenerArchivoDeFila(
    fila: FilaCola,
    wa: WhatsAppIntegration,
    opciones: { guardar: boolean },
): Promise<ArchivoObtenido> {
    let mime = fila.media_mime_type ?? 'image/jpeg';

    if (fila.storage_path) {
        const { data: blob, error } = await supabase.storage.from(BUCKET).download(fila.storage_path);
        if (error || !blob) return { ok: false, error: `no se pudo releer del bucket: ${error?.message}`, transitorio: true };
        const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
        return { ok: true, base64, mime, storagePath: fila.storage_path };
    }

    if (!fila.media_id) return { ok: false, error: 'fila sin media_id', transitorio: false };

    const bajada = await downloadMedia(wa, fila.media_id);
    if (!bajada.ok || !bajada.base64) {
        const error = bajada.error ?? '';
        return { ok: false, error: error || 'fallo al bajar', transitorio: esTransitorio(error) };
    }
    const base64 = bajada.base64;
    mime = bajada.mimeType ?? mime;
    if (!opciones.guardar) return { ok: true, base64, mime, storagePath: null };

    const ext = mime === 'application/pdf' ? 'pdf' : (mime.split('/')[1] ?? 'jpg');
    const storagePath = `${fila.school_id}/whatsapp/${fila.id}.${ext}`;
    const { error: upErr } = await supabase.storage.from(BUCKET)
        .upload(storagePath, Buffer.from(base64, 'base64'), { contentType: mime, upsert: true });
    if (upErr) {
        const detalle = [upErr.message, (upErr as { statusCode?: string }).statusCode, upErr.name]
            .filter(Boolean).join(' · ') || JSON.stringify(upErr).slice(0, 200);
        return { ok: false, error: `no se pudo guardar en el bucket: ${detalle}`, transitorio: true };
    }

    // Se estampa YA, antes del OCR: si el OCR falla, el reintento (o la rama
    // que sigue en el mismo procesamiento) parte del bucket, no de una URL de
    // Meta que para entonces ya expiró.
    await supabase.from('whatsapp_inbound_queue')
        .update({ storage_path: storagePath, media_mime_type: mime })
        .eq('id', fila.id);
    // Mutar la fila en memoria: si esta misma invocación sigue a
    // continuarComoComprobante o a otra rama, esas lecturas de fila.storage_path
    // ya ven el valor estampado.
    fila.storage_path = storagePath;
    fila.media_mime_type = mime;

    return { ok: true, base64, mime, storagePath };
}

/**
 * Bajar y GUARDAR antes de leer. La URL de media de Meta expira en minutos;
 * si se baja, se pasa al OCR y el OCR falla, un reintento veinte minutos
 * después ya no puede bajar nada y el archivo se pierde sin dejar rastro.
 *
 * Idempotente por FILA: si `fila.storage_path` ya está estampado (reintento,
 * o una rama anterior del mismo procesamiento ya lo bajó), relee del bucket
 * en vez de volver a pedirle el archivo a Meta y volver a subirlo. Esto
 * importa para la rama de staff-admin (§3 de
 * alta-atleta-por-foto-hoja-matricula.md): si termina resolviendo que
 * también es acudiente y sigue por `continuarComoComprobante`, NO vuelve a
 * bajar el mismo archivo.
 *
 * Lo transitorio (red, 429, 5xx, bucket) reintenta; lo permanente (mime,
 * tamaño, media vencida, sin media_id) cierra la fila en `failed`.
 */
async function bajarYGuardarArchivo(fila: FilaCola, wa: WhatsAppIntegration, log?: Logger): Promise<ArchivoBajado> {
    const r = await obtenerArchivoDeFila(fila, wa, { guardar: true });
    if (!r.ok) {
        if (r.transitorio) await reintentar(fila, r.error, log);
        else await cerrar(fila.id, 'failed', { error_message: r.error });
        return { ok: false };
    }
    return { ok: true, base64: r.base64, mime: r.mime, storagePath: r.storagePath as string };
}

/**
 * ¿El dinero fue a una cuenta de la escuela?
 *
 * Aquí todavía no se sabe a qué cobro va, así que valen TODAS las llaves de
 * la escuela, también las restringidas a un concepto (el Nequi de
 * inscripciones de Dynasty): el dinero sí llegó a la escuela. Si el cobro
 * resulta ser de otro concepto, lo marca el veredicto de aplicarComprobante
 * (amarillo → revisión), no este portero. Antes comparaba con igualdad
 * exacta y sin las restringidas: rechazaba inscripciones legítimas
 * (2026-10-03) y los destinos enmascarados ("**** 6942") que el check 4 ya
 * aceptaba.
 *
 * Sin destino leído o sin cuentas registradas → true: no hay con qué cruzar.
 * Exportada para que la recuperación en lote decida con la misma regla.
 */
export async function destinoEsDeLaEscuela(
    schoolId: string,
    ocr: Awaited<ReturnType<typeof extractReceipt>>,
): Promise<boolean> {
    const ctx = await buildVerdictContext(schoolId, { referenceNorm: null, imageSha256: null });
    const cuentas = [
        ...(ctx.registeredAccounts ?? []),
        ...(ctx.restrictedAccounts ?? []).map((r) => r.value),
    ];
    const destino = normalizeDestination(ocr.destination);
    return !(destino && cuentas.length > 0 && !destinationMatchesRegistered(destino, cuentas));
}

/** `error_message` de un comprobante a una cuenta «por fuera de SportMaps». La bandeja lo muestra como informativo. */
export const MOTIVO_FUERA_DE_SPORTMAPS = 'pago por fuera de SportMaps';

/** Lo que se le dice a la familia cuando el pago fue a una cuenta «por fuera de SportMaps». */
export const TEXTO_FUERA_DE_SPORTMAPS =
    'Recibí tu comprobante 📄 Ese pago se maneja directamente con la escuela, por fuera de la app, ' +
    'así que no lo registro aquí.';

/**
 * ¿El dinero fue a una cuenta que la escuela acepta «por fuera de SportMaps»
 * (`payment_accounts[].fuera_de_sportmaps`, 2026-10-13: el Nequi de un
 * entrenador para los torneos)? Si el destino coincide también con una cuenta
 * de la escuela, gana la de la escuela. Sin destino o sin esas cuentas: false.
 */
export async function destinoFueraDeSportmaps(
    schoolId: string,
    ocr: Awaited<ReturnType<typeof extractReceipt>>,
): Promise<boolean> {
    const destino = normalizeDestination(ocr.destination);
    if (!destino) return false;
    const ctx = await buildVerdictContext(schoolId, { referenceNorm: null, imageSha256: null });
    const fuera = ctx.cuentasFueraDeSportmaps ?? [];
    if (!fuera.length) return false;
    const deLaEscuela = [
        ...(ctx.registeredAccounts ?? []),
        ...(ctx.restrictedAccounts ?? []).map((r) => r.value),
    ];
    if (deLaEscuela.length && destinationMatchesRegistered(destino, deLaEscuela)) return false;
    return destinationMatchesRegistered(destino, fuera);
}

// ─── Comprobantes con motivo (plan B4, 2026-10-30) ──────────────────────────
//
// docs/specs/whatsapp-monster-plan-B4.md §3. Todo detrás de
// `school_settings.wa_cobro_desde_comprobante` (nace false): con el interruptor
// apagado no se lee ningún esperado, no se crea ningún cobro y no sale ningún
// botón nuevo — la cola responde exactamente como hoy (whatsapp-queue-motivo.test).
//
//  · Motivo esperado: el bot pidió un pago («La clase de prueba vale $15.000…»)
//    y registró qué espera (wa-concepto-esperado). El comprobante toma ese motivo.
//  · Cobro desde el comprobante: si el motivo tiene precio en la escuela y no
//    hay cobro, la base lo crea (RPC, el precio es SUYO) y se le aplica.
//  · Motivo por monto: $310.000 = matrícula, $60.000 = uniformes, $370.000 = las dos.
//  · Prospecto (sin ficha): el cobro va al lead (`payments.signup_lead_id`) y,
//    si es la clase de prueba y todo coincide, B3 la agenda.

/** Lo que el asistente decidió de un comprobante, para el resumen de la ráfaga. */
export interface LineaDeMotivo {
    monto: number | null;
    /** «Inscripción», «Uniformes», «Clase de prueba», «Inscripción + Uniformes». */
    motivo: string;
    atleta: string | null;
    paymentId: string;
    /** true = el cobro lo creó el asistente desde el comprobante. */
    nuevo: boolean;
}

/** Un motivo ya decidido (lo eligió la familia, o venía esperado) que entra a `continuarComoComprobante`. */
export interface MotivoForzado extends ValorMotivoElegido {
    esperadoId?: string | null;
}

/** La pregunta que no salió porque el contacto ya tenía otra abierta (plan B4 §3 T4.6). */
export interface PreguntaEnFila {
    texto: string;
    paso: string;
    botones: BotonInteractivo[] | null;
    monto: number | null;
}

/** Lo que devuelve `responder` a una pregunta. */
type SalidaDePregunta = { silenciado?: boolean; enFila?: PreguntaEnFila } | undefined;

interface ContextoB4 { activo: boolean; esperados: ConceptoEsperado[] }

const APAGADO_B4: ContextoB4 = { activo: false, esperados: [] };

/** El interruptor y, si está prendido, los esperados vivos del contacto. Dos lecturas como mucho; nunca lanza. */
async function contextoB4(schoolId: string, telefono: string): Promise<ContextoB4> {
    try {
        if (!(await cobroDesdeComprobanteActivo(schoolId))) return APAGADO_B4;
        return { activo: true, esperados: await conceptosEsperadosDe(schoolId, telefono) };
    } catch {
        return APAGADO_B4;
    }
}

const montoDelOcr = (ocr: { amount?: number | null } | null | undefined): number | null =>
    typeof ocr?.amount === 'number' && ocr.amount > 0 ? ocr.amount : null;
const mismoMonto = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= 1;
const shaDe = (base64: string) => crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
const primerNombre = (n: string | null | undefined) => (n ? n.trim().split(/\s+/)[0] : null);

/** El motivo forzado como precio (lo que la RPC necesita). Pura. */
function precioDelForzado(f: MotivoForzado): PrecioDeMotivo {
    return {
        motivo: f.motivo, monto: f.monto, fuente: f.fuente, fuenteId: f.fuenteId, etiqueta: f.etiqueta,
        ...(f.opcion ? { opcion: f.opcion } : {}), ...(f.esAbono ? { esAbono: true } : {}),
    };
}

/** ¿Esa referencia de banco ya está en un pago de la escuela? Antes de crear: el estampado daría 23505. Nunca lanza. */
async function referenciaYaUsada(schoolId: string, ocr: { reference?: string | null }): Promise<boolean> {
    const ref = ocr?.reference ? String(ocr.reference).trim() : '';
    if (!ref) return false;
    try {
        const { data } = await supabase.from('payments').select('id')
            .eq('school_id', schoolId).eq('ocr_reference', ref).limit(1);
        return Array.isArray(data) && data.length > 0;
    } catch {
        return false;
    }
}

/** De quién es el cobro en una familia: uno (se crea), 2–3 (se pregunta) o no se sabe. */
type DuenoFamilia =
    | { tipo: 'uno'; dueno: DuenoDelCobro; nombre: string | null; cuotas: number[] }
    | { tipo: 'varios'; fichas: FichaConNombre[]; cuotas: number[] }
    | { tipo: 'ninguno'; cuotas: number[] };

/**
 * Los deportistas de la familia. Con `llaves` (familia sin cuenta, o el
 * deportista que eligió en la pregunta de hermanos) solo esas fichas; si no,
 * los hijos del acudiente. Nunca lanza.
 */
async function duenoDeLaFamilia(schoolId: string, parentId: string | null, llaves?: LlavesDeFicha): Promise<DuenoFamilia> {
    try {
        const conLlaves = !!llaves && (llaves.childIds.length + llaves.unregisteredIds.length) > 0;
        const ds = await deportistasParaPreguntar(schoolId, conLlaves
            ? { childIds: llaves!.childIds, unregisteredIds: llaves!.unregisteredIds }
            : { parentId });
        const cuotas = ds.map((d) => d.cuota).filter((c): c is number => typeof c === 'number' && c > 0);
        if (ds.length === 1) {
            const d = ds[0];
            return { tipo: 'uno', dueno: d.tipo === 'child' ? { childId: d.id } : { unregisteredId: d.id }, nombre: d.nombre, cuotas };
        }
        if (ds.length >= 2 && ds.length <= 3) return { tipo: 'varios', fichas: fichasDesdeDeportistas(ds), cuotas };
        return { tipo: 'ninguno', cuotas };
    } catch {
        return { tipo: 'ninguno', cuotas: [] };
    }
}

/** Lo que necesita B4 para crear y aplicar sin depender de la fila de la cola. */
interface ArgsB4 {
    fila: FilaCola;
    parentId: string | null;
    llaves?: LlavesDeFicha;
    pendientes: PagoPendiente[];
    ocr: Awaited<ReturnType<typeof extractReceipt>>;
    sha: string;
    storagePath: string;
    responder: Responder;
    alFallar: (motivo: string) => Promise<void>;
    log?: Logger;
}

const contextoDe = (a: ArgsB4): ContextoAplicacion => ({
    queueId: a.fila.id, schoolId: a.fila.school_id, parentId: a.parentId, storagePath: a.storagePath,
    sha: a.sha, ocr: a.ocr, responder: a.responder, alFallar: a.alFallar, log: a.log,
});

/**
 * Crea los cobros (RPC; el precio lo pone la base) y les aplica el comprobante:
 * uno, o el principal con los demás cubiertos (`cubre`, la RPC de siempre). Un
 * abono (clínica: 50 % para separar cupo) queda en revisión y nunca se aprueba
 * solo. Devuelve false si NO hizo nada (referencia ya usada, la base no lo
 * creó): quien llama sigue su camino. Si el estampado choca con una referencia
 * repetida, los cobros creados se anulan.
 */
async function crearYAplicar(
    a: ArgsB4, precios: PrecioDeMotivo[], dueno: DuenoDelCobro, nombre: string | null,
    o: { esperadoId?: string | null; alAplicar?: AlAplicar } = {},
): Promise<boolean> {
    if (!precios.length || await referenciaYaUsada(a.fila.school_id, a.ocr)) return false;
    const creados: PagoPendiente[] = [];
    let abono = false;
    for (const p of precios) {
        // Sin el nombre (prospecto del esperado), el concepto lo arma la base con el del lead.
        const concepto = nombre ? conceptoDelCobroCreado(p, nombre) : null;
        const r = await crearCobroDesdeComprobante({
            schoolId: a.fila.school_id, queueId: a.fila.id, categoria: p.motivo, monto: p.monto,
            fuente: p.fuente, fuenteId: p.fuenteId, ...dueno, concepto,
            conceptoEsperadoId: o.esperadoId ?? null, opcion: p.opcion ?? null, telefono: a.fila.wa_phone_number,
        });
        if (!r.ok) {
            a.log?.warn?.({ queueId: a.fila.id, codigo: r.codigo, motivo: p.motivo }, '[wa-queue] B4: la base no creó el cobro');
            for (const c of creados) await anularCobroCreado(c.id);
            return false;
        }
        abono = abono || r.esAbono;
        creados.push({
            id: r.paymentId, amount: r.precio, concept: r.concepto ?? concepto ?? conceptoDelCobroCreado(p, null), due_date: hoyBogota(),
            child_id: dueno.childId ?? null, atleta: nombre, categoria: p.motivo,
        });
    }
    const [principal, ...cubre] = creados;
    const monto = montoDelOcr(a.ocr);
    const etiqueta = precios.map((p) => p.etiqueta).join(' + ');
    const r = await aplicarComprobante(contextoDe(a), principal, a.pendientes, {
        ...(cubre.length ? { esperado: creados.reduce((s, c) => s + Number(c.amount), 0), cubre } : {}),
        ...(abono && monto !== null ? {
            soloRevision: true,
            motivo: `abono_en_revision: ${etiqueta} — abono para separar el cupo (cobro creado por el asistente)`,
            nota: `Quedan *${cop(Math.max(0, principal.amount - monto))}* para completar ${cop(principal.amount)}.`,
        } : {}),
        linea: { monto, motivo: etiqueta, atleta: nombre, paymentId: principal.id, nuevo: true },
        ...(cubre.length ? {} : { para: precios[0].etiqueta.toLowerCase() }),
        alAplicar: o.alAplicar,
    });
    if (!r.ok && r.duplicado) for (const c of creados) await anularCobroCreado(c.id);
    if (r.ok && o.esperadoId) await consumirEsperado(o.esperadoId, principal.id, a.fila.id);
    a.log?.info?.({ queueId: a.fila.id, cobros: creados.map((c) => c.id), abono }, '[wa-queue] B4: cobro creado desde el comprobante');
    return true;
}

/** Aplica el comprobante a un cobro que YA existía del motivo esperado. */
async function aplicarAlEsperado(a: ArgsB4, pago: PagoPendiente, esperadoId: string | null, alAplicar?: AlAplicar): Promise<void> {
    const r = await aplicarComprobante(contextoDe(a), pago, a.pendientes.filter((x) => x.id !== pago.id), {
        linea: {
            monto: montoDelOcr(a.ocr), motivo: etiquetaDelCobro({ payment_category: pago.categoria ?? null, concept: pago.concept }),
            atleta: pago.atleta, paymentId: pago.id, nuevo: false,
        },
        alAplicar,
    });
    if (r.ok && esperadoId) await consumirEsperado(esperadoId, pago.id, a.fila.id);
}

/** Hermanos: el motivo está claro y el deportista no. Botones con sus nombres; la guía lleva el motivo. */
async function preguntarDeQuienEs(a: ArgsB4, fichas: FichaConNombre[], motivo: MotivoForzado): Promise<boolean> {
    const r = await a.responder(
        `Recibí tu comprobante de *${motivo.etiqueta.toLowerCase()}* 📄 ¿De cuál deportista es? Toca el nombre.`,
        PASO_PREGUNTA_DEPORTISTA_BOTONES, botonesDeDeportistas(fichas)) as SalidaDePregunta;
    if (r?.silenciado) return false;
    await esperarAlUsuario(a.fila.id, {
        opciones: [], ocr: a.ocr, sha: a.sha, storagePath: a.storagePath, parentId: a.parentId, tipo: 'deportista',
        guia: { opciones: opcionesDeDeportistas(fichas), monto: montoDelOcr(a.ocr), quienPago: a.ocr.originName ?? null, parentId: a.parentId, motivo },
        enFila: r?.enFila,
    });
    return true;
}

/** El motivo forzado no se pudo cobrar: a la escuela con lo que se sabe (la familia ya contestó). */
async function motivoForzadoALaEscuela(a: ArgsB4, f: MotivoForzado, por: string): Promise<void> {
    const monto = montoDelOcr(a.ocr);
    await a.responder('Gracias 🙏 Le paso tu comprobante a la escuela para que lo aplique y te confirme.', 'guiado_a_la_escuela');
    await cerrar(a.fila.id, 'ignored', {
        result_type: 'escalated', matched_parent_id: a.parentId,
        error_message: motivoConPropuesta(
            `otro_concepto: ${f.etiqueta.toLowerCase()} (la familia lo eligió) · ${por}`,
            `Propuesta → pagó: ${a.ocr.originName ?? 'no se leyó'}${monto ? ` · ${pesos(monto)}` : ''} · crear el cobro de ${f.etiqueta} (${pesos(f.monto)}) y aplicar este comprobante`),
        pregunta_ocr: huellasDelComprobante({ sha: a.sha, ocr: a.ocr, storagePath: a.storagePath, parentId: a.parentId }),
    });
}

/**
 * B4 para una familia (con cuenta, o por la ficha): primero el motivo que eligió
 * la familia (`forzado`), si no, el motivo esperado. true = la fila quedó atendida.
 */
async function atenderMotivoDeFamilia(a: ArgsB4, b4: ContextoB4, forzado: MotivoForzado | null): Promise<boolean> {
    const monto = montoDelOcr(a.ocr);
    const schoolId = a.fila.school_id;

    if (forzado) {
        const existente = monto === null ? undefined : a.pendientes.find((p) =>
            categoriaDelCobro({ payment_category: p.categoria ?? null, concept: p.concept }) === forzado.motivo
            && mismoMonto(Number(p.amount), monto));
        if (existente) {
            await aplicarAlEsperado(a, existente, forzado.esperadoId ?? null);
            return true;
        }
        if (!mismoMonto(forzado.monto, monto)) {
            await motivoForzadoALaEscuela(a, forzado, `el comprobante (${monto ? pesos(monto) : 'sin monto'}) no es el precio`);
            return true;
        }
        const dueno = await duenoDeLaFamilia(schoolId, a.parentId, a.llaves);
        if (dueno.tipo === 'varios') {
            if (await preguntarDeQuienEs(a, dueno.fichas, forzado)) return true;
            await motivoForzadoALaEscuela(a, forzado, 'no se sabe de qué deportista es');
            return true;
        }
        if (dueno.tipo !== 'uno') {
            await motivoForzadoALaEscuela(a, forzado, 'no se sabe de qué deportista es');
            return true;
        }
        if (forzado.motivo === 'inscripcion' && await yaTieneCobroDelMotivo(schoolId, dueno.dueno, 'inscripcion')) {
            await motivoForzadoALaEscuela(a, forzado, 'el deportista ya tiene una inscripción');
            return true;
        }
        if (await crearYAplicar(a, [precioDelForzado(forzado)], dueno.dueno, dueno.nombre, { esperadoId: forzado.esperadoId })) return true;
        await motivoForzadoALaEscuela(a, forzado, 'no se pudo crear el cobro');
        return true;
    }

    const esperado = elegirEsperado(b4.esperados.filter((e) => !e.leadId), monto);
    if (!esperado) return false;
    const dec = decidirConEsperado(esperado, monto, null, a.pendientes);
    if (dec.tipo === 'aplicar_existente') {
        await aplicarAlEsperado(a, dec.pago, esperado.id);
        return true;
    }
    if (dec.tipo !== 'crear') return false;

    const dueno: DuenoFamilia = esperado.childId
        ? await duenoDeLaFamilia(schoolId, null, { childIds: [esperado.childId], unregisteredIds: [] })
        : await duenoDeLaFamilia(schoolId, a.parentId, a.llaves);
    if (dueno.tipo === 'ninguno') return false;
    const precios = await preciosDeMotivos(schoolId, dueno.tipo === 'uno' ? dueno.dueno : {}, {
        motivos: [esperado.motivo], telefono: a.fila.wa_phone_number,
    });
    const precio = precios.find((p) => mismoMonto(p.monto, monto));
    if (!precio) return false;
    if (dueno.tipo === 'varios') return preguntarDeQuienEs(a, dueno.fichas, { ...valorDePrecio(precio), esperadoId: esperado.id });
    if (precio.motivo === 'inscripcion' && await yaTieneCobroDelMotivo(schoolId, dueno.dueno, 'inscripcion')) return false;
    return crearYAplicar(a, [precio], dueno.dueno, dueno.nombre, { esperadoId: esperado.id });
}

/** Resultado de buscar el motivo por el monto (familia). */
interface MotivoDeFamilia { atendida: boolean; precios: PrecioDeMotivo[]; tipo: MotivoPorMonto['tipo'] }

/**
 * Motivo por monto para una familia (interruptor prendido, sin esperado): `uno`
 * o `varios` crean y aplican (o preguntan de cuál hermano, si es un solo
 * motivo); lo demás devuelve los precios para armar la pregunta. Nunca cuando
 * el monto es una cuota de la familia.
 */
async function motivoPorMontoDeFamilia(a: ArgsB4, o: { motivos?: Motivo[] } = {}): Promise<MotivoDeFamilia> {
    const monto = montoDelOcr(a.ocr);
    const dueno = await duenoDeLaFamilia(a.fila.school_id, a.parentId, a.llaves);
    if (dueno.tipo === 'ninguno' || monto === null) return { atendida: false, precios: [], tipo: 'ninguno' };
    const precios = await preciosDeMotivos(a.fila.school_id, dueno.tipo === 'uno' ? dueno.dueno : {}, {
        motivos: o.motivos, telefono: a.fila.wa_phone_number,
    });
    const m = motivoPorMonto(monto, precios, { cuotas: dueno.cuotas });
    if (m.tipo !== 'uno' && m.tipo !== 'varios') return { atendida: false, precios, tipo: m.tipo };
    const elegidos = m.tipo === 'uno' ? [m.precio] : m.precios;
    if (dueno.tipo === 'varios') {
        const atendida = elegidos.length === 1 && await preguntarDeQuienEs(a, dueno.fichas, valorDePrecio(elegidos[0]));
        return { atendida, precios, tipo: m.tipo };
    }
    if (elegidos.some((p) => p.motivo === 'inscripcion')
        && await yaTieneCobroDelMotivo(a.fila.school_id, dueno.dueno, 'inscripcion')) {
        return { atendida: false, precios, tipo: 'ninguno' };
    }
    return { atendida: await crearYAplicar(a, elegidos, dueno.dueno, dueno.nombre), precios, tipo: m.tipo };
}

// ─── Prospecto y agenda de la clase de prueba ────────────────────────────────

/** Contrato con B3 (plan maestro §3). B4 la carga con import dinámico; si falta, no agenda y pasa a una persona. */
export interface AgendaClasePrueba {
    confirmarClasePruebaPagada(a: { schoolId: string; leadId: string; paymentId: string; telefono: string }):
        Promise<{ texto: string; botones?: { id: string; title: string }[]; step?: string }>;
}

/** Ruta en variable: el módulo de B3 puede no existir todavía (se compila y se prueba sin él). */
const RUTA_AGENDA_CLASE_PRUEBA = '../services/clase-prueba-agenda.service';

const cargadorDeAgendaPorDefecto = async (): Promise<AgendaClasePrueba | null> => {
    try {
        const m: any = await import(RUTA_AGENDA_CLASE_PRUEBA);
        return typeof m?.confirmarClasePruebaPagada === 'function' ? m as AgendaClasePrueba : null;
    } catch {
        return null;
    }
};
let cargarAgendaClasePrueba = cargadorDeAgendaPorDefecto;

/** Solo para pruebas (null = el import dinámico de siempre). */
export function _fijarCargadorAgenda(f: (() => Promise<AgendaClasePrueba | null>) | null): void {
    cargarAgendaClasePrueba = f ?? cargadorDeAgendaPorDefecto;
}

export const TEXTO_CLASE_PRUEBA_A_PERSONA = (monto: number | null) =>
    `Recibí tu comprobante${monto ? ` de *${pesos(monto)}*` : ''} para la clase de prueba 📄 ` +
    'Una persona de la escuela te confirma el horario por aquí.';

interface ArgsProspecto {
    fila: FilaCola;
    wa: WhatsAppIntegration;
    conversationId: string | null;
    responder: Responder;
    ocr: Awaited<ReturnType<typeof extractReceipt>>;
    base64: string;
    storagePath: string;
    log?: Logger;
}

/** La conversación pasa a una persona de la escuela (buzón + aviso), sin otro mensaje a la familia. Nunca lanza. */
async function pasarAPersona(p: ArgsProspecto, motivo: string): Promise<void> {
    if (!p.conversationId) return;
    try {
        const { abrirConsultaParaLaEscuela } = await import('../services/whatsapp-bot.service');
        await abrirConsultaParaLaEscuela(p.wa, p.conversationId, p.fila.wa_phone_number, motivo);
    } catch (e: any) {
        p.log?.warn?.({ queueId: p.fila.id, err: e?.message }, '[wa-queue] B4: no se pudo avisar a la escuela; se abre la conversación');
        await supabase.from('whatsapp_conversations')
            .update({ status: 'open', updated_at: new Date().toISOString() })
            .eq('id', p.conversationId);
    }
}

/**
 * La agenda de la clase de prueba al aplicar el comprobante (D9, plan B4 §4):
 * se agenda SOLO si el monto es el esperado (±$1), el dinero llegó a una cuenta
 * general de la escuela con coincidencia exacta y el veredicto no es rojo. Si
 * algo no coincide, o B3 no está, o falla: no se agenda y pasa a una persona.
 * El cobro queda «En revisión» (awaiting_approval) en todos los casos.
 */
function agendaDeClasePrueba(p: ArgsProspecto, leadId: string, destino: DestinoExacto, montoEsperado: number | null): AlAplicar {
    return async ({ action, veredicto, pago }) => {
        const monto = montoDelOcr(p.ocr);
        if (action === 'rejected') {
            await pasarAPersona(p, 'clase_prueba_comprobante_rechazado');
            return null;
        }
        const coincide = destino === 'exacta' && mismoMonto(monto, montoEsperado) && veredicto !== 'rojo';
        if (coincide) {
            const agenda = await cargarAgendaClasePrueba();
            if (agenda) {
                try {
                    const r = await agenda.confirmarClasePruebaPagada({
                        schoolId: p.fila.school_id, leadId, paymentId: pago.id, telefono: p.fila.wa_phone_number,
                    });
                    if (r?.texto) {
                        return {
                            texto: r.texto,
                            botones: r.botones?.map((b) => ({ id: b.id, title: b.title })),
                            paso: r.step ?? 'clase_prueba_agendada',
                        };
                    }
                } catch (e: any) {
                    p.log?.warn?.({ queueId: p.fila.id, err: e?.message }, '[wa-queue] B4: la agenda de la clase de prueba falló');
                }
            }
        }
        await pasarAPersona(p, coincide ? 'clase_prueba_sin_agenda' : 'clase_prueba_no_coincide');
        return { texto: TEXTO_CLASE_PRUEBA_A_PERSONA(monto), paso: 'clase_prueba_a_persona' };
    };
}

/** El esperado del prospecto no coincide: no se crea nada; a la bandeja con la propuesta y a una persona. */
async function prospectoALaEscuela(p: ArgsProspecto, a: ArgsB4, codigo: string, esperado: Pick<ConceptoEsperado, 'motivo' | 'monto'>): Promise<void> {
    const monto = montoDelOcr(p.ocr);
    await p.responder(
        `Recibí tu comprobante${monto ? ` de *${pesos(monto)}*` : ''} 📄 Se lo paso a la escuela para que lo revise y te confirme por aquí.`,
        'comprobante_a_la_escuela');
    await cerrar(p.fila.id, 'ignored', {
        result_type: 'escalated',
        error_message: motivoConPropuesta(
            `${codigo}: se esperaba ${etiquetaDelCobro({ payment_category: esperado.motivo }).toLowerCase()}`
            + `${esperado.monto ? ` por ${pesos(esperado.monto)}` : ''} y llegó ${monto ? pesos(monto) : 'un comprobante sin monto'}`
            + ` a ${p.ocr.destination ?? 'un destino sin leer'} (prospecto)`,
            `Propuesta → pagó: ${p.ocr.originName ?? 'no se leyó'} · revisar el destino y el valor; si está bien, registrar el cobro del prospecto y aplicar este comprobante`),
        pregunta_ocr: huellasDelComprobante({ sha: a.sha, ocr: p.ocr, storagePath: p.storagePath, parentId: null }),
    });
    await pasarAPersona(p, 'comprobante_prospecto_no_coincide');
}

/**
 * B4 para un número sin ficha (prospecto). Con motivo esperado manda la regla
 * de `decidirConEsperado` (monto y destino exacto, o a una persona); sin
 * esperado, el lead por teléfono y el motivo por el monto, solo con destino
 * exacto. true = la fila quedó atendida; false = sigue el camino de hoy.
 */
async function atenderProspecto(p: ArgsProspecto, b4: ContextoB4): Promise<boolean> {
    const { fila, ocr } = p;
    const monto = montoDelOcr(ocr);
    let esperado = elegirEsperado(b4.esperados.filter((e) => !e.childId), monto);
    const lead = esperado?.leadId
        ? { id: esperado.leadId, nombre: null as string | null }
        : await leadPorTelefono(fila.school_id, fila.wa_phone_number);
    if (!lead) return false;
    if (esperado && !esperado.leadId) esperado = { ...esperado, leadId: lead.id };

    const a: ArgsB4 = {
        fila, parentId: null, pendientes: await pendientesDelLead(fila.school_id, lead.id),
        ocr, sha: shaDe(p.base64), storagePath: p.storagePath, responder: p.responder,
        alFallar: (motivo) => reintentar(fila, motivo, p.log), log: p.log,
    };
    const destino = await destinoExactoDelComprobante(fila.school_id, ocr);
    const precios = await preciosDeMotivos(fila.school_id, { leadId: lead.id }, {
        telefono: fila.wa_phone_number, ...(esperado ? { motivos: [esperado.motivo] } : {}),
    });

    if (esperado) {
        if (esperado.monto === null) {
            const delMotivo = precios.filter((x) => x.motivo === esperado!.motivo && !x.esAbono);
            if (delMotivo.length === 1) esperado = { ...esperado, monto: delMotivo[0].monto };
        }
        const dec = decidirConEsperado(esperado, monto, destino, a.pendientes);
        if (dec.tipo === 'seguir') return false;
        if (dec.tipo === 'a_la_escuela') {
            await prospectoALaEscuela(p, a, `motivo_esperado_no_coincide (${dec.razon})`, esperado);
            return true;
        }
        const agenda = esperado.motivo === 'clase_prueba' ? agendaDeClasePrueba(p, lead.id, destino, esperado.monto) : undefined;
        if (dec.tipo === 'aplicar_existente') {
            await aplicarAlEsperado(a, dec.pago, esperado.id, agenda);
            return true;
        }
        const precio = precios.find((x) => x.motivo === esperado!.motivo && mismoMonto(x.monto, monto));
        if (precio && await crearYAplicar(a, [precio], { leadId: lead.id }, lead.nombre, { esperadoId: esperado.id, alAplicar: agenda })) {
            return true;
        }
        await prospectoALaEscuela(p, a, precio ? 'cobro_no_creado' : 'motivo_esperado_sin_precio', esperado);
        return true;
    }

    // Sin esperado: solo con el dinero en una cuenta general de la escuela (exacta).
    if (destino !== 'exacta') return false;
    const m = motivoPorMonto(monto, precios);
    if (m.tipo !== 'uno' && m.tipo !== 'varios') return false;
    const elegidos = m.tipo === 'uno' ? [m.precio] : m.precios;
    const conPrueba = elegidos.some((x) => x.motivo === 'clase_prueba');
    // Una combinación con la clase de prueba no agenda sola: la confirma una persona.
    const agenda: AlAplicar | undefined = !conPrueba ? undefined
        : elegidos.length === 1 ? agendaDeClasePrueba(p, lead.id, destino, elegidos[0].monto)
            : async () => { await pasarAPersona(p, 'clase_prueba_en_combinacion'); return null; };
    return crearYAplicar(a, elegidos, { leadId: lead.id }, lead.nombre, { alAplicar: agenda });
}

/**
 * Todo lo que pasa una vez que sabemos QUIÉN paga (`parentId`) y que el
 * archivo YA se leyó como comprobante (`ocr`). Compartida por el camino de
 * siempre (acudiente identificado por OTP/teléfono) y por el camino nuevo
 * (admin-que-también-es-acudiente, ver `procesarComoStaffAdmin`) — para que
 * un admin con hijos en la escuela no pierda el camino de pagos de hoy, y
 * para no volver a bajar el archivo una segunda vez.
 */
async function continuarComoComprobante(
    fila: FilaCola,
    parentId: string | null,
    responder: Responder,
    base64: string,
    mime: string,
    storagePath: string,
    ocr: Awaited<ReturnType<typeof extractReceipt>>,
    log?: Logger,
    /**
     * `llaves`: familia sin cuenta (o número sin ficha resuelto por nombre):
     * los cobros se buscan por la ficha. `alFallar`: quién maneja un fallo
     * transitorio (el worker reintenta; la respuesta de la familia no).
     * `motivo` (plan B4): el motivo ya decidido (la familia lo eligió en la
     * pregunta de concepto o de hermanos).
     */
    opts: { llaves?: LlavesDeFicha; alFallar?: (motivo: string) => Promise<void>; motivo?: MotivoForzado | null } = {},
): Promise<void> {
    const alFallar = opts.alFallar ?? ((motivo: string) => reintentar(fila, motivo, log));
    // ¿La MISMA imagen ya se recibió de esta familia? (…0340, 07-oct: la foto
    // enviada dos veces recibió «lo apliqué…» y 40 s después «no tienes cobros
    // pendientes».) Va antes que todo: la respuesta nunca contradice a la primera.
    const shaArchivo = crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
    if (await atenderComprobanteRepetido(fila, parentId, shaArchivo, responder, log, opts.llaves)) return;

    if (ocr.isTransactionList === true) {
        await responder(M.esListado, 'es_listado');
        await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: 'listado de movimientos' });
        return;
    }

    // ¿El dinero fue siquiera a la escuela? Va ANTES de mirar los pendientes
    // (decirle "no tienes pendientes" a quien mandó el comprobante de otra
    // cuenta es cierto pero inútil). La regla vive en `destinoEsDeLaEscuela`.
    // Antes: ¿fue a una cuenta que la escuela acepta «por fuera de SportMaps»?
    // Eso no es plata perdida ni un error de la familia: informativo.
    if (await destinoFueraDeSportmaps(fila.school_id, ocr)) {
        await responder(TEXTO_FUERA_DE_SPORTMAPS, 'fuera_de_sportmaps');
        await cerrar(fila.id, 'ignored', {
            result_type: 'none', matched_parent_id: parentId, error_message: MOTIVO_FUERA_DE_SPORTMAPS,
        });
        return;
    }
    if (!(await destinoEsDeLaEscuela(fila.school_id, ocr))) {
        // Si una persona de la escuela está escribiendo en este chat, el comprobante
        // puede ser parte de lo que ella pidió (Dynasty 10-20: Milena le pedía a un
        // contacto reenviar una transferencia y el bot le dijo «cuenta ajena»). Se
        // deja a la escuela, sin respuesta, pero queda en la bandeja.
        if (await escuelaAtendiendoElChat(fila)) {
            await cerrar(fila.id, 'ignored', {
                result_type: 'escalated', matched_parent_id: parentId, error_message: 'destino no es de la escuela',
            });
            return;
        }
        // Modo discreto: «cuenta ajena» alarmaba a familias que le habían pagado al
        // Nequi de la dueña o a la cuenta del entrenador para el torneo (3 de 3
        // falsos en un lote del análisis 2026-10-29). Lo revisa la escuela.
        if (modoDiscreto()) {
            await responder(M.escaladoSinAcudiente.replace('para que lo aplique', 'para que lo revise contigo'), 'destino_ajeno');
            await cerrar(fila.id, 'ignored', {
                result_type: 'escalated', matched_parent_id: parentId, error_message: 'destino no es de la escuela',
            });
            return;
        }
        await responder(
            `Revisé tu comprobante y el dinero se envió a la cuenta *${ocr.destination}*, ` +
            'que no es ninguna de las cuentas registradas por la escuela.\n\n' +
            'Verifica la llave o el número antes de volver a transferir, y si ya lo hiciste ' +
            'escríbele a la escuela para que lo revisen contigo.',
            'destino_ajeno',
        );
        await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: 'destino no es de la escuela' });
        return;
    }

    // ¿A qué pago va? Sin cuenta: por la ficha (child_id / unregistered_athlete_id).
    const pendientes = opts.llaves
        ? await pendientesPorLlaves(fila.school_id, { parentId, ...opts.llaves })
        : await pagosPendientesDe(parentId as string, fila.school_id);

    // ¿Hay una venta por WhatsApp esperando el pago (servicio, carril B)? La
    // foto es de ESE cobro suelto, nunca de la mensualidad
    // (docs/specs/ventas-por-whatsapp.md §5.3). Va antes que todo lo demás:
    // el cobro de la venta es la mejor pista que existe.
    const venta = decidirComprobanteDeVenta(
        await ventaAbiertaDeContacto(fila.integration_id, fila.wa_phone_number), pendientes);
    if (venta.tipo === 'aplicar') {
        log?.info?.({ queueId: fila.id, paymentId: venta.pago.id }, '[wa-queue] comprobante de la venta abierta');
        await aplicarComprobante({
            queueId: fila.id, schoolId: fila.school_id, parentId, storagePath,
            sha: crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'),
            ocr, responder,
            alFallar,
            log,
        }, venta.pago, pendientes.filter((x) => x.id !== venta.pago.id));
        return;
    }
    if (venta.tipo === 'a_la_escuela') {
        await responder(venta.mensaje, 'otro_concepto');
        await cerrar(fila.id, 'ignored', {
            result_type: 'escalated', matched_parent_id: parentId, error_message: venta.motivo,
        });
        return;
    }

    // (Plan B4) Motivo elegido por la familia o motivo esperado. Con el
    // interruptor apagado no se lee nada más que el interruptor.
    const b4 = await contextoB4(fila.school_id, fila.wa_phone_number);
    const argsB4: ArgsB4 = {
        fila, parentId, llaves: opts.llaves, pendientes, ocr, sha: shaArchivo, storagePath, responder, alFallar, log,
    };
    if (b4.activo && await atenderMotivoDeFamilia(argsB4, b4, opts.motivo ?? null)) return;

    // ¿Dice que es OTRA cosa? (P0, 2026-10-07: «Clase perfeccionamiento» y «lo
    // de los uniformes» se aplicaron a la mensualidad y la escuela los rechazó
    // tres veces.) Si hay un cobro pendiente de ese concepto por ese monto, va
    // a ese; si no, NO se aplica a la mensualidad: lo registra la escuela.
    const otro = decidirOtroConcepto(
        detectarOtroConcepto({
            pie: fila.media_caption,
            descripcion: ocr.description,
            chat: await textosAlrededor(fila),
        }),
        pendientes,
        ocr.amount ?? null,
    );
    if (otro.tipo === 'aplicar') {
        log?.info?.({ queueId: fila.id, paymentId: otro.pago.id, concepto: otro.senal.concepto }, '[wa-queue] cobro del concepto que nombra la familia');
        await aplicarComprobante({
            queueId: fila.id, schoolId: fila.school_id, parentId, storagePath,
            sha: crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'),
            ocr, responder,
            alFallar,
            log,
        }, otro.pago, pendientes.filter((x) => x.id !== otro.pago.id));
        return;
    }
    if (otro.tipo === 'a_la_escuela') {
        // (Plan B4) El pie dice «uniformes» y $60.000 es su precio: se crea el
        // cobro de ese motivo y se aplica. Si el monto no calza, como siempre.
        const motivoNombrado = MOTIVO_DE_OTRO_CONCEPTO[otro.senal.concepto];
        if (b4.activo && motivoNombrado
            && (await motivoPorMontoDeFamilia(argsB4, { motivos: [motivoNombrado] })).atendida) return;
        await responder(mensajeOtroConcepto(otro.senal), 'otro_concepto');
        await cerrar(fila.id, 'ignored', {
            result_type: 'escalated',
            matched_parent_id: parentId,
            error_message: await motivoDeOtroConcepto({ senal: otro.senal, fila, parentId, llaves: opts.llaves, ocr }),
        });
        log?.info?.({ queueId: fila.id, concepto: otro.senal.concepto, fuente: otro.senal.fuente }, '[wa-queue] otro concepto: a la escuela');
        return;
    }

    // Lo que la familia ESCRIBIÓ con la foto (pie y textos cercanos) y si el
    // monto cuadra (Dynasty 2026-10-09: «envío saldo sept 15 - oct 15 $80.000»
    // se estampó como pago nuevo en la mensualidad de $150.000). Ver
    // whatsapp-cobro-por-texto.service.
    const montoLeido = typeof ocr.amount === 'number' && ocr.amount > 0 ? ocr.amount : null;
    // Montos con el recargo del enlace de pago de cada cobro (2026-10-13).
    const recargos = await cargarRecargos(fila.school_id, pendientes);
    // Huellas para que la bandeja cierre sola la fila cuando se decida el pago.
    const huellas = huellasDelComprobante({ sha: shaArchivo, ocr, storagePath, parentId });
    const lectura = leerTextosDelComprobante(fila.media_caption, await textosCercanos(fila), pendientes);
    const porTexto = decidirCobroPorTexto({
        pendientes,
        parciales: await cobrosParcialesDe(fila.school_id, parentId, opts.llaves),
        monto: montoLeido,
        lectura,
        permiteAbonos: await escuelaRecibeAbonos(fila.school_id),
        recargos,
    });
    if (porTexto?.tipo === 'a_la_escuela') {
        // (Plan B4) El monto es exactamente un precio de la escuela (matrícula,
        // uniformes, clínica): eso pesa más que «abono de la mensualidad». Se
        // crea el cobro y se aplica. Si no calza, quedan los precios para la
        // pregunta de concepto.
        let porMontoB4: MotivoDeFamilia | null = null;
        if (b4.activo && porTexto.codigo === 'monto_no_cuadra' && !lectura.saldo) {
            porMontoB4 = await motivoPorMontoDeFamilia(argsB4);
            if (porMontoB4.atendida) return;
        }
        // Pago esperado (spec 3.5): un monto MENOR a la cuota es un ABONO, no un
        // cambio de plan (esa regla se descartó). Queda EN REVISIÓN con la
        // propuesta armada y nunca se aprueba solo.
        const esperado = porTexto.codigo === 'monto_no_cuadra'
            ? await pagoEsperadoDeLaFila(fila.school_id, parentId, opts.llaves, montoLeido, pendientes)
            : null;
        if (esperado?.pagoAbono) {
            const destino = esperado.pagoAbono;
            log?.info?.({ queueId: fila.id, paymentId: destino.id }, '[wa-queue] monto menor a la cuota: abono en revisión');
            await aplicarComprobante({
                queueId: fila.id, schoolId: fila.school_id, parentId, storagePath, sha: shaArchivo, ocr,
                responder, alFallar, log,
            }, destino, pendientes.filter((x) => x.id !== destino.id), {
                soloRevision: true,
                motivo: `abono_en_revision: ${esperado.texto}`,
                nota: `Quedan *${cop(destino.amount - (montoLeido as number))}* para completar ${cop(destino.amount)}.`,
            });
            return;
        }
        // Concepto solo si el monto no calza con una mensualidad (spec 3.3).
        const cobroDelMonto = pendientes.find((p) => p.id === porTexto.pagoId);
        if (porTexto.codigo === 'monto_no_cuadra' && montoLeido !== null && cobroDelMonto && esperado && !lectura.saldo
            && categoriaDelCobro({ payment_category: cobroDelMonto.categoria ?? null, concept: cobroDelMonto.concept }) === 'mensualidad') {
            if (await preguntarConcepto({
                fila, parentId, llaves: opts.llaves, ocr, sha: shaArchivo, storagePath, responder,
                propuesta: esperado?.texto ?? null,
                opciones: porMontoB4 && porMontoB4.tipo !== 'es_cuota' ? opcionesDeMotivo(porMontoB4.precios, montoLeido) : undefined,
            })) return;
        }
        await responder(porTexto.mensaje, 'comprobante_a_la_escuela');
        await cerrar(fila.id, 'ignored', {
            result_type: 'escalated',
            matched_parent_id: parentId,
            error_message: motivoConPropuesta(`${porTexto.codigo}: ${porTexto.resumen}`, esperado?.texto),
            ...(huellas ? { pregunta_ocr: huellas } : {}),
        });
        log?.info?.({ queueId: fila.id, codigo: porTexto.codigo, paymentId: porTexto.pagoId }, '[wa-queue] a la escuela por monto/texto');
        return;
    }

    let match = porTexto?.tipo === 'aplicar'
        ? { tipo: 'unico' as const, pago: porTexto.pago }
        : porTexto?.tipo === 'preguntar'
            ? { tipo: 'preguntar' as const, opciones: porTexto.opciones }
            : resolverPago(pendientes, ocr.amount ?? null);
    if (porTexto?.tipo === 'aplicar') {
        log?.info?.({ queueId: fila.id, paymentId: porTexto.pago.id, motivo: porTexto.motivo }, '[wa-queue] cobro elegido por el texto/antigüedad');
    }
    // Pagó de más: se toma igual; lo de más queda como saldo a favor al aprobar.
    const notaExcedente = porTexto?.tipo === 'aplicar' && porTexto.motivo === 'excedente' && porTexto.excedente
        ? textoExcedente(porTexto.excedente)
        : undefined;

    // El monto no desempata: ¿la familia dijo a cuál iba? (P3)
    // (Si la pregunta la pidió el monto que no cuadra, la pista no la salta.)
    if (match.tipo === 'preguntar' && porTexto?.tipo !== 'preguntar') {
        const elegido = elegirPorPista(pendientes, await pistaDeCobro(fila));
        if (elegido) {
            log?.info?.({ queueId: fila.id, paymentId: elegido.id }, '[wa-queue] cobro elegido por la pista del texto');
            match = { tipo: 'unico', pago: elegido };
        }
    }

    if (match.tipo === 'sin_pendientes') {
        // (d) ¿Ya estaba registrado? Un pago aprobado con la misma referencia, o
        // por el mismo monto en esos días: se dice, no se escala.
        const ya = await pagoYaRegistrado(fila.school_id, { parentId, ...(opts.llaves ?? {}) }, ocr,
            fila.created_at ?? new Date().toISOString());
        if (ya) {
            await responder(TEXTO_YA_REGISTRADO, 'ya_registrado');
            await cerrar(fila.id, 'ignored', {
                result_type: 'none', result_ref_id: ya.id, matched_parent_id: parentId,
                error_message: `ya registrado: ${ya.concept ?? ya.id}`,
            });
            return;
        }
        // (Plan B4) Sin cobros pero el monto es un precio de la escuela: se crea
        // el cobro y se aplica. Si no calza con nada (y no es una cuota), se
        // pregunta de qué es con los motivos que tienen precio.
        if (b4.activo) {
            const r = await motivoPorMontoDeFamilia(argsB4);
            if (r.atendida) return;
            const opciones = r.tipo === 'ninguno' || r.tipo === 'ambiguo' ? opcionesDeMotivo(r.precios, montoLeido) : [];
            if (opciones.length && await preguntarConcepto({
                fila, parentId, llaves: opts.llaves, ocr, sha: shaArchivo, storagePath, responder, propuesta: null, opciones,
            })) return;
        }
        // Spec 3.3: sin cobros → se pregunta el mes (o de cuál deportista, si son
        // varios) con botones. Elegirlo NO crea ni aplica nada: va a la bandeja
        // con la propuesta «crear el cobro de ese mes y aplicar».
        if (await preguntarMesOQuien({
            fila, parentId, llaves: opts.llaves, ocr, sha: shaArchivo, storagePath, responder,
        })) return;
        if (!parentId) {
            // Sin cuenta y sin cobros por la ficha: lo aplica la escuela, como antes.
            await responder(M.escaladoSinAcudiente, 'familia_sin_cuenta');
            await cerrar(fila.id, 'ignored', { result_type: 'escalated', error_message: 'familia_sin_cuenta: la ficha no tiene cobros pendientes' });
            return;
        }
        await responder(M.sinPendientes, 'sin_pendientes');
        await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: 'sin pagos pendientes' });
        return;
    }

    // UNA transferencia que suma exacto varios cobros (dos hijos; o mensualidad +
    // inscripción + seguro del alta, 2026-10-10). Un comprobante se estampa en
    // UN cobro (`uq_payments_school_ocr_reference`). Desde el 2026-10-13 se
    // aplica a TODOS, empezando por el más antiguo: ese lleva la referencia, el
    // sha y el veredicto (contra la suma), y los demás quedan en revisión con
    // el mismo archivo y una nota (RPC wa_cubrir_cobros_con_comprobante, una
    // transacción). La escuela los aprueba como siempre.
    if (match.tipo === 'combinacion') {
        const [principal, ...cubre] = ordenarDelMasAntiguo(match.pagos);
        log?.info?.({ queueId: fila.id, cobros: match.pagos.map((p) => p.id) }, '[wa-queue] un comprobante, varios cobros: a todos');
        await aplicarComprobante({
            queueId: fila.id, schoolId: fila.school_id, parentId, storagePath, sha: shaArchivo, ocr,
            responder,
            alFallar,
            log,
        }, principal, pendientes.filter((x) => !match.pagos.some((m) => m.id === x.id)), {
            esperado: match.pagos.reduce((s, p) => s + Number(p.amount), 0),
            cubre,
        });
        return;
    }

    if (match.tipo === 'preguntar') {
        const texto = mensajeElegirPago(match.opciones);
        // (c) Con botones (concepto + monto): tocar es más fácil que escribir «2».
        const salida = await responder(texto, 'ask_cual_pago', botonesDeCobros(match.opciones)) as SalidaDePregunta;
        await esperarAlUsuario(fila.id, {
            opciones: match.opciones,
            ocr,
            sha: crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'),
            storagePath,
            parentId,
            enFila: salida?.enFila,
        });
        return;
    }

    // Un solo destino: se estampa el comprobante Y SU VEREDICTO.
    const pago: PagoPendiente = match.pago;
    const sha = crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');

    await aplicarComprobante({
        queueId: fila.id, schoolId: fila.school_id, parentId, storagePath, sha, ocr,
        responder,
        alFallar,
        log,
    }, pago, pendientes.filter((x) => x.id !== pago.id), {
        esperado: montoEsperado(pago, montoLeido, recargos),
        nota: notaExcedente,
    });
}

/**
 * Lo que se le dice a la familia cuando UN comprobante cubre varios cobros.
 * Nombra cada cobro (el pago único con su concepto: «Inscripción — …») y no
 * promete aplicarlo: lo reparte la escuela. Pura.
 */
export function textoVariosCobros(monto: number, pagos: PagoPendiente[]): string {
    return `Recibí tu comprobante por ${cop(monto)} 📄 Cubre estos cobros:\n\n` +
        `${pagos.map((p) => `• ${describirPago(p)}`).join('\n')}\n\n` +
        'Como es un solo pago para varios cobros, se lo paso a la escuela para que lo reparta ' +
        'entre ellos y te confirme por aquí.';
}

/** `error_message` de la fila (la pantalla «Comprobantes sin resolver» lo muestra). Pura. */
export function motivoVariosCobros(pagos: PagoPendiente[]): string {
    return `varios_cobros: un comprobante cubre ${pagos.length} cobros (${pagos.map((p) => describirPago(p)).join(' | ')}): repartirlo a mano`
        .slice(0, 500);
}

// ─── La misma foto otra vez (auditoría 2026-10-07, …0340) ────────────────────

/** Días en los que la misma imagen (sha256) de la familia cuenta como repetida. */
export const DIAS_COMPROBANTE_REPETIDO = 7;
/** Si ya se dijo «ya lo había recibido» hace menos de esto, se calla. */
export const VENTANA_SILENCIO_REPETIDO_MS = 10 * 60_000;
/** error_message de la fila cerrada por repetida: marca el aviso para el freno. */
export const MOTIVO_COMPROBANTE_REPETIDO = 'comprobante ya recibido (misma imagen)';
export const TEXTO_COMPROBANTE_REPETIDO = 'Este comprobante ya lo había recibido 👍';

/** El cobro de la familia que ya tiene esta imagen (≤ 7 días), o null. Nunca lanza. */
export async function cobroConLaMismaImagen(
    schoolId: string, parentId: string | null, sha: string, ahora = Date.now(),
    /** Familia sin cuenta: la misma imagen en un cobro de sus fichas. */
    llaves?: LlavesDeFicha,
): Promise<{ id: string; concept: string | null; status: string } | null> {
    try {
        const porFicha = [
            ...(llaves?.childIds.length ? [`child_id.in.(${llaves.childIds.join(',')})`] : []),
            ...(llaves?.unregisteredIds.length ? [`unregistered_athlete_id.in.(${llaves.unregisteredIds.join(',')})`] : []),
        ];
        if (!parentId && !porFicha.length) return null;
        let q = supabase.from('payments')
            .select('id, concept, status')
            .eq('school_id', schoolId);
        q = porFicha.length
            ? q.or([...(parentId ? [`parent_id.eq.${parentId}`] : []), ...porFicha].join(','))
            : q.eq('parent_id', parentId as string);
        const { data, error } = await q
            .eq('receipt_image_sha256', sha)
            .gte('receipt_verdict_at', new Date(ahora - DIAS_COMPROBANTE_REPETIDO * 24 * 3600_000).toISOString())
            .limit(1);
        if (error || !Array.isArray(data) || !data.length) return null;
        const p = data[0] as any;
        return { id: p.id, concept: p.concept ?? null, status: p.status };
    } catch {
        return null;
    }
}

/** ¿Este contacto ya recibió «ya lo había recibido» hace < 10 min? Nunca lanza. */
async function repetidoAvisadoHacePoco(fila: FilaCola, ahora = Date.now()): Promise<boolean> {
    try {
        const { data } = await supabase.from('whatsapp_inbound_queue')
            .select('id')
            .eq('integration_id', fila.integration_id)
            .eq('wa_phone_number', fila.wa_phone_number)
            .eq('error_message', MOTIVO_COMPROBANTE_REPETIDO)
            .neq('id', fila.id)
            .gte('processed_at', new Date(ahora - VENTANA_SILENCIO_REPETIDO_MS).toISOString())
            .limit(1);
        return Array.isArray(data) && data.length > 0;
    } catch {
        return false;
    }
}

/**
 * Si la imagen (sha256) ya está en un cobro de esta familia de los últimos 7
 * días: «Este comprobante ya lo había recibido 👍» una vez —o nada si ya se
 * dijo hace < 10 min— y la fila se cierra apuntando a ese cobro. Nunca
 * contradice la primera respuesta. Devuelve true si la atendió.
 */
async function atenderComprobanteRepetido(
    fila: FilaCola,
    parentId: string | null,
    sha: string,
    responder: (texto: string, paso: string) => Promise<unknown>,
    log?: Logger,
    llaves?: LlavesDeFicha,
): Promise<boolean> {
    const previo = await cobroConLaMismaImagen(fila.school_id, parentId, sha, Date.now(), llaves);
    if (!previo) return false;
    const callar = await repetidoAvisadoHacePoco(fila);
    if (!callar) await responder(TEXTO_COMPROBANTE_REPETIDO, 'comprobante_repetido');
    await cerrar(fila.id, 'ignored', {
        result_type: 'none',
        result_ref_id: previo.id,
        matched_parent_id: parentId,
        error_message: MOTIVO_COMPROBANTE_REPETIDO,
    });
    log?.info?.({ queueId: fila.id, paymentId: previo.id, callar }, '[wa-queue] misma imagen ya recibida');
    return true;
}

/**
 * Busca si el documento del deportista ya existe en `children` de esta
 * escuela, o en otra fila de `enrollment_form_intake` todavía sin aprobar —
 * ver §6.1 de alta-atleta-por-foto-hoja-matricula.md. Solo corre si el OCR
 * pudo leer el documento; sin documento no hay llave confiable y se deja la
 * decisión al admin en el inbox (fase 4).
 */
async function buscarDuplicadoDeMatricula(
    schoolId: string,
    docNumber: string | null,
): Promise<{ duplicateOfChildId: string | null; duplicateOfIntakeId: string | null }> {
    if (!docNumber) return { duplicateOfChildId: null, duplicateOfIntakeId: null };
    const docNorm = docNumber.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    if (!docNorm) return { duplicateOfChildId: null, duplicateOfIntakeId: null };

    const { data: existingChild } = await supabase
        .from('children')
        .select('id')
        .eq('school_id', schoolId)
        .eq('doc_number', docNorm)
        .maybeSingle();
    if (existingChild) return { duplicateOfChildId: existingChild.id as string, duplicateOfIntakeId: null };

    // Sin filtro JSONB en el query (evitar depender de sintaxis ->> del
    // cliente): son pocas filas abiertas por escuela, se filtra en memoria.
    const { data: abiertas } = await supabase
        .from('enrollment_form_intake')
        .select('id, extracted')
        .eq('school_id', schoolId)
        .in('status', ['pending', 'processing', 'waiting_review']);

    const otra = (abiertas ?? []).find((row: any) => {
        const otroDoc = (row.extracted as EnrollmentFormResult | null)?.docNumber;
        return otroDoc && otroDoc.replace(/[^0-9A-Za-z]/g, '').toUpperCase() === docNorm;
    });

    return { duplicateOfChildId: null, duplicateOfIntakeId: (otra?.id as string) ?? null };
}

/** Encola la matrícula extraída en `enrollment_form_intake`, con su chequeo de duplicados, y cierra la fila de WhatsApp. */
async function encolarMatricula(
    fila: FilaCola,
    storagePath: string,
    enrollment: EnrollmentFormResult,
    responder: (texto: string, paso: string) => Promise<unknown>,
    log?: Logger,
): Promise<void> {
    const { duplicateOfChildId, duplicateOfIntakeId } = await buscarDuplicadoDeMatricula(fila.school_id, enrollment.docNumber);

    const { data: intake, error: intakeErr } = await supabase
        .from('enrollment_form_intake')
        .insert({
            school_id: fila.school_id,
            integration_id: fila.integration_id,
            wa_message_id: fila.wa_message_id,
            wa_phone_number: fila.wa_phone_number,
            media_id: fila.media_id,
            storage_path: storagePath,
            status: 'waiting_review',
            extracted: enrollment,
            duplicate_of_child_id: duplicateOfChildId,
            duplicate_of_intake_id: duplicateOfIntakeId,
        })
        .select('id')
        .single();

    if (intakeErr || !intake) {
        log?.error?.({ err: intakeErr?.message, queueId: fila.id }, '[wa-queue] no se pudo encolar la matrícula');
        await reintentar(fila, `no se pudo encolar la matrícula: ${intakeErr?.message}`, log);
        return;
    }

    const aviso = duplicateOfChildId
        ? 'Recibí la hoja de matrícula 📋 El documento ya existe para un atleta activo de la escuela — ' +
          'la dejé en revisión para que decidas si vinculas los datos nuevos o la descartas, no crea un atleta duplicado.'
        : duplicateOfIntakeId
        ? 'Recibí la hoja de matrícula 📋 Ya había otra foto con el mismo documento esperando revisión — las agrupé.'
        : 'Recibí la hoja de matrícula 📋 La dejé lista para que la revises y confirmes los datos antes de crear al atleta.';

    await responder(aviso, 'matricula_encolada');
    // `result_type` NO puede ser 'enrollment_form': el CHECK `chk_wa_queue_result`
    // (verificado en la base viva el 2026-10-03) solo admite payment_receipt,
    // glosa, escalated y none. Con 'enrollment_form' el UPDATE fallaba en
    // silencio, la fila quedaba en 'processing', el lease vencía y se volvía a
    // procesar: otra fila en enrollment_form_intake por vuelta, hasta agotar
    // los reintentos y terminar 'failed'. La matrícula se ubica por `result_ref_id`.
    await cerrar(fila.id, 'done', { result_type: 'none', result_ref_id: intake.id });
    log?.info?.({ queueId: fila.id, intakeId: intake.id, duplicateOfChildId, duplicateOfIntakeId }, '[wa-queue] matrícula encolada');
}

/** Lo que una rama anterior ya leyó del archivo (evita bajarlo y leerlo dos veces). */
interface LecturaPrevia {
    base64: string;
    mime: string;
    storagePath: string;
    ocr: Awaited<ReturnType<typeof extractReceipt>>;
}

/**
 * Foto de PLANILLA DE ASISTENCIA de un entrenador o de la dueña (spec
 * whatsapp-conversacion-v2-dynasty §3.8, camino 1). Va ANTES de la decisión de
 * `decidirAdjunto` porque al coach (rol que `wa_identify_staff_admin_by_phone` no
 * ve) se le clasifica como «desconocido» o «familia», y no depende del asistente:
 * la asistencia del equipo no es una respuesta del bot a una familia, así que
 * corre con `ai_enabled=false` y con la conversación tomada (el resumen sale
 * igual: quien escribió acaba de hacerlo y la ventana de 24 h está abierta).
 *
 * Orden de lectura (§4.1 de alta-atleta-por-foto-hoja-matricula.md, se respeta):
 *   1. ¿Es staff? (una RPC, sin OCR). Si no, no se hace nada: el flujo sigue igual.
 *   2. Si el texto cercano habla de pago, es un comprobante: no se gasta OCR.
 *   3. `extractReceipt` primero. Comprobante o listado → el flujo de pagos de
 *      siempre (un admin que también es acudiente NO pierde ese camino).
 *   4. Recién entonces el OCR de planillas. `no_aplica` → sigue el flujo normal
 *      (matrícula, etc.) reusando la lectura ya hecha (`previo`).
 * Costo: una lectura extra de planillas solo en las fotos de staff que no son
 * comprobante.
 *
 * La fila se cierra `done` / `result_type='none'` (el CHECK `chk_wa_queue_result`
 * no admite valores nuevos) con `result_ref_id` = la fila de
 * `attendance_sheet_intake`, igual que la matrícula con `enrollment_form_intake`.
 */
async function intentarPlanillaDeStaff(
    fila: FilaCola,
    wa: WhatsAppIntegration,
    conversationId: string | null,
    log?: Logger,
): Promise<{ atendida: true } | { atendida: false; previo?: LecturaPrevia }> {
    const staff = await identificarStaffPorTelefono(fila.integration_id, fila.wa_phone_number);
    if (staff.resultado !== 'staff' || (staff.schoolId && staff.schoolId !== fila.school_id)) return { atendida: false };
    if (textosHablanDePago(await textosCercanos(fila))) return { atendida: false };

    const bajada = await bajarYGuardarArchivo(fila, wa, log);
    if (!bajada.ok) return { atendida: true }; // ya reintentó o cerró la fila
    const { base64, mime, storagePath } = bajada;

    let ocr: LecturaPrevia['ocr'];
    try {
        ocr = await extractReceipt(base64, mime);
    } catch (err: any) {
        await reintentar(fila, `OCR (comprobantes) no disponible: ${err?.message ?? err}`, log);
        return { atendida: true };
    }
    const previo: LecturaPrevia = { base64, mime, storagePath, ocr };
    if (ocr.isReceipt === true || ocr.isTransactionList === true) return { atendida: false, previo };

    const r = await recibirPlanillaDeStaff({
        integration: wa, waId: fila.wa_phone_number, staff, base64, mime, queueId: fila.id, source: 'whatsapp',
    });
    if (r.estado === 'no_aplica') return { atendida: false, previo };

    const bot = await import('../services/whatsapp-bot.service');
    await bot.enviarRespuestaStaff(wa, conversationId, fila.wa_phone_number,
        { texto: r.texto, botones: r.botones },
        { step: 'asistencia_staff', estado: r.estado, queue_id: fila.id, intake_id: r.intakeId ?? null });
    await cerrar(fila.id, 'done', {
        result_type: 'none',
        ...(r.intakeId ? { result_ref_id: r.intakeId } : {}),
        ...(r.estado === 'resumen' || r.estado === 'pregunta_equipo' ? {} : { error_message: `planilla_asistencia: ${r.estado}` }),
    });
    log?.info?.({ queueId: fila.id, estado: r.estado, intakeId: r.intakeId }, '[wa-queue] planilla de asistencia del equipo');
    return { atendida: true };
}

/**
 * Camino nuevo para quien resulta ser owner/admin/school_admin de la
 * escuela (§4.1/§4.2 de alta-atleta-por-foto-hoja-matricula.md). Corre ANTES
 * del gate de acudiente porque un admin no tiene por qué estar identificado
 * como acudiente para poder mandar la foto de una hoja de matrícula.
 *
 * Primero se descarta que sea un comprobante (mismo extractor que ya existe,
 * cero clasificador nuevo): si lo es, y el admin TAMBIÉN es acudiente
 * (escuela chica, el dueño tiene hijos entrenando ahí), sigue el camino de
 * pagos de siempre sin perder esa función. Si no es acudiente, no se aplica
 * —los pagos de terceros/efectivo se registran desde el panel, no por acá—.
 * Si no es comprobante, se prueba como hoja de matrícula.
 */
async function procesarComoStaffAdmin(
    fila: FilaCola,
    wa: WhatsAppIntegration,
    conv: { id?: string; parent_id?: string | null; identified?: boolean } | null | undefined,
    responder: (texto: string, paso: string) => Promise<unknown>,
    log?: Logger,
    previo?: LecturaPrevia,
): Promise<void> {
    let base64: string, mime: string, storagePath: string, ocr: LecturaPrevia['ocr'];
    if (previo) {
        // La rama de planillas ya bajó y leyó el archivo: no se repite.
        ({ base64, mime, storagePath, ocr } = previo);
    } else {
        const bajada = await bajarYGuardarArchivo(fila, wa, log);
        if (!bajada.ok) return;
        ({ base64, mime, storagePath } = bajada);
        try {
            ocr = await extractReceipt(base64, mime);
        } catch (err: any) {
            await reintentar(fila, `OCR (comprobantes) no disponible: ${err?.message ?? err}`, log);
            return;
        }
    }

    if (ocr.isReceipt === true) {
        let parentId: string | null = (conv?.identified && conv.parent_id) ? conv.parent_id : null;
        if (!parentId) {
            const { data: identificacion } = await supabase.rpc('wa_identify_by_phone', {
                p_integration_id: fila.integration_id,
                p_contact_wa_id: fila.wa_phone_number,
            });
            if ((identificacion as any)?.estado === 'identificado' && (identificacion as any)?.parent_id) {
                parentId = (identificacion as any).parent_id as string;
            }
        }

        if (parentId) {
            await continuarComoComprobante(fila, parentId, responder, base64, mime, storagePath, ocr, log);
            return;
        }

        await responder(
            'Este archivo parece un comprobante de pago. Los pagos de terceros o en efectivo se ' +
            'registran desde el panel de administración, no por este canal.',
            'admin_comprobante_no_acudiente',
        );
        await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: 'admin no acudiente, comprobante no aplicado' });
        return;
    }

    let enrollment: EnrollmentFormResult;
    try {
        enrollment = await extractEnrollmentForm(base64, mime);
    } catch (err: any) {
        await reintentar(fila, `OCR (matrícula) no disponible: ${err?.message ?? err}`, log);
        return;
    }

    if (!enrollment.isEnrollmentForm) {
        await responder(
            'No reconocí este archivo ni como comprobante de pago ni como hoja de matrícula. ' +
            'Si querías registrar un atleta nuevo, envía la foto completa de la hoja.',
            'no_reconocido_admin',
        );
        await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: 'ni comprobante ni matrícula' });
        return;
    }

    await encolarMatricula(fila, storagePath, enrollment, responder, log);
}

/**
 * Qué hace el worker con un adjunto, según quién lo manda y si el bot está
 * prendido. Función pura a propósito: es LA regla, y se prueba sin mocks.
 *
 * Medido el 2026-10-03 en Dynasty (Coexistence: el número de la escuela es
 * también el WhatsApp personal de la dueña), con el bot APAGADO: el worker no
 * miraba `ai_enabled` y le escribió de verdad a 17 familias pidiéndoles el
 * correo. La decisión de producto que sale de ahí:
 *
 *  - Apagado es apagado. Ni comprobantes, ni la rama de staff-admin (alta por
 *    foto de matrícula): con el bot apagado el worker no habla con nadie. La
 *    dueña ve y contesta todo desde su celular.
 *  - El asistente solo atiende familias. Desconocidos y contactos marcados
 *    como personales → silencio, aunque la escuela haya pedido
 *    `responder_desconocidos`: eso es para el texto del bot; a un comprobante
 *    de alguien que no se sabe quién es no hay nada útil que contestarle sin
 *    pedirle un trámite.
 *  - Quien administra la escuela sigue por su rama (`procesarComoStaffAdmin`)
 *    AUNQUE también sea familia: en una escuela chica el dueño suele tener
 *    hijos entrenando, y `debeAtender` lo clasifica como 'familia' antes que
 *    como 'staff'. Sin esto perdería el alta por foto de matrícula. Su rama ya
 *    aplica el comprobante como acudiente cuando corresponde.
 */
export type DecisionDeAdjunto =
    | 'bot_apagado'       // cerrar ignored, sin responder, sin bajar nada
    | 'staff_admin'       // procesarComoStaffAdmin
    | 'comprobante'       // camino de siempre, con el parent_id por teléfono u OTP
    | 'escalar_sin_cuenta'
    | 'escalar_ambiguo'
    | 'silencio';         // cerrar ignored, sin responder

export function decidirAdjunto(a: {
    botEncendido: boolean;
    tipo: TipoDeContacto;
    /** Solo se consulta si el tipo lo amerita; para 'staff' es true por definición. */
    esStaffAdmin: boolean;
}): DecisionDeAdjunto {
    if (!a.botEncendido) return 'bot_apagado';
    // Lo marcado a mano como no-familia (personal, negocio, otro club,
    // plataforma) manda sobre todo, incluso sobre staff.
    if (esMarcaNoFamilia(a.tipo) || a.tipo === 'desconocido') return 'silencio';
    if (a.tipo === 'staff' || a.esStaffAdmin) return 'staff_admin';
    if (a.tipo === 'familia') return 'comprobante';
    if (a.tipo === 'familia_sin_cuenta') return 'escalar_sin_cuenta';
    if (a.tipo === 'ambiguo') return 'escalar_ambiguo';
    return 'silencio';
}

// Los enlaces salen a familias reales por el número de la escuela: siempre la
// app de producción. Con FRONTEND_URL, el BFF de dev mandaba dev.sportmaps.co
// (la base es una sola y dev también procesa la cola; 2026-10-06).
const FRONTEND_URL = APP_PUBLICA_PROD;

/**
 * Familia conocida por la escuela pero sin cuenta. El enlace es el de SU
 * invitación (mismo criterio que whatsapp-bot.service): el registro normal no
 * vincula `children`, solo `accept_invitation_pro` lo hace.
 */
async function mensajeSinCuenta(fila: FilaCola): Promise<string> {
    // Solo la invitación de un atleta ACTIVO (whatsapp-invitacion-vigente): a la
    // familia de un atleta dado de baja no se le ofrece crear la cuenta.
    const { invitacion } = await invitacionPendienteVigente(
        fila.integration_id, fila.wa_phone_number, fila.school_id);
    if (!invitacion?.invite_id) return M.sinCuenta;
    const enlace = `${FRONTEND_URL}/register?invite=${invitacion.invite_id}` +
        (invitacion.email ? `&email=${encodeURIComponent(invitacion.email)}` : '');
    return `${M.sinCuenta}\n\nSi creas tu cuenta aquí, la próxima vez tu comprobante se aplica solo: ${enlace}`;
}

/**
 * El adjunto acompaña una consulta, no un pago: se le dice a la familia que lo
 * atiende una persona y la CONVERSACIÓN pasa a la escuela (abierta en el buzón,
 * con push al staff), igual que el escalamiento del bot. La fila NO queda como
 * comprobante a aplicar (`result_type='none'`, no `escalated`): no es un pago.
 * El paso es 'escalated' para que cuente como escalamiento y para que el bot
 * no le conteste encima a la persona que lo va a atender.
 */
async function derivarConsulta(
    fila: FilaCola,
    wa: WhatsAppIntegration,
    conversationId: string | null,
    responder: (texto: string, paso: string) => Promise<unknown>,
    origen: string,
    log?: Logger,
): Promise<void> {
    await responder(M.consulta, 'escalated');
    if (conversationId) {
        try {
            // Import perezoso, como `ofrecerConsentimientoSiFalta`: el bot arrastra media app.
            const { abrirConsultaParaLaEscuela } = await import('../services/whatsapp-bot.service');
            await abrirConsultaParaLaEscuela(wa, conversationId, fila.wa_phone_number, 'consulta_con_adjunto');
        } catch (e: any) {
            log?.warn?.({ queueId: fila.id, err: e?.message }, '[wa-queue] no se pudo avisar a la escuela; se abre la conversación');
            await supabase.from('whatsapp_conversations')
                .update({ status: 'open', updated_at: new Date().toISOString() })
                .eq('id', conversationId);
        }
    }
    await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: `consulta_no_comprobante:${origen}` });
    log?.info?.({ queueId: fila.id, origen }, '[wa-queue] adjunto con consulta: a la escuela como conversación');
}

/**
 * Familia que la escuela conoce pero a la que no se le puede aplicar el
 * comprobante sola (sin cuenta, o número en dos cuentas). Se guarda el
 * archivo —la URL de Meta expira en minutos y la escuela tiene que poder
 * verlo para aplicarlo a mano—, se le avisa UNA vez y la fila queda en el
 * buzón (`ignored` + `result_type='escalated'`; el buzón lista
 * failed/ignored/waiting_user). Sin OCR: lo va a leer una persona.
 *
 * No va a `waiting_user`: ese estado significa «el bot preguntó a cuál cobro
 * aplicar» y lo consume whatsapp-respuesta-de-cobro.service.
 */
async function escalarALaEscuela(
    fila: FilaCola,
    wa: WhatsAppIntegration,
    conversationId: string | null,
    responder: (texto: string, paso: string) => Promise<unknown>,
    mensaje: string | (() => Promise<string>),
    paso: string,
    motivo: string,
    log?: Logger,
): Promise<void> {
    const bajada = await bajarYGuardarArchivo(fila, wa, log);
    if (!bajada.ok) return;

    // ¿Es siquiera un comprobante? (2026-10-06, ver `esConsultaSobreCobro`.)
    // Primero lo que escribió —no cuesta nada—; si no lo dice, la lectura. Antes
    // este camino no leía nada y a una captura de un correo de cobro con un
    // reclamo le contestaba «Recibí tu comprobante».
    let consulta = esConsultaSobreCobro(await textosCercanos(fila));
    if (!consulta) {
        try {
            const ocr = await extractReceipt(bajada.base64, bajada.mime);
            // Ni comprobante ni consulta ni nada que hable de pagar (la foto del
            // entrenamiento): sin responder, el archivo ya quedó en el buzón.
            if (ocr.isReceipt === false && !(await hayContextoDePago(fila, conversationId, ocr))) {
                await cerrarNoEsComprobanteSinContexto(fila, log);
                return;
            }
            consulta = !pareceComprobanteDePago(ocr);
        } catch (err: any) {
            // Sin lectura no hay veredicto: sigue como antes —lo mira una persona igual—.
            log?.warn?.({ queueId: fila.id, err: err?.message ?? err }, '[wa-queue] OCR no disponible al escalar');
        }
    }
    if (consulta) {
        await derivarConsulta(fila, wa, conversationId, responder, motivo, log);
        return;
    }

    await responder(typeof mensaje === 'function' ? await mensaje() : mensaje, paso);
    await cerrar(fila.id, 'ignored', { result_type: 'escalated', error_message: motivo });
    log?.info?.({ queueId: fila.id, motivo }, '[wa-queue] escalado a la escuela');
}

// ─── Una respuesta por comprobante (2026-10-07) ─────────────────────────────
//
// Medido en Dynasty (6-7 oct, 81 ráfagas de adjuntos en 48 h): de las 38 que
// recibieron respuesta, la mediana fue 2 mensajes del bot y el máximo 8; 18
// tuvieron 3 o más. El acuse inmediato del webhook («Recibí tu comprobante 📄
// Lo reviso…») + el resultado de la cola ~50 s después + la pregunta del
// consentimiento pegada + el párrafo de «no tienes cuenta» repetido.
//
// Ahora: el resultado sale en UN mensaje (con la presentación delante si es el
// primer contacto y la pregunta del consentimiento al pie, con sus botones). El
// acuse solo sale si a los ACUSE_DIFERIDO_MS de llegado el archivo todavía no
// hay resultado. Lo manda el worker que tiene la fila (lease de
// `wa_queue_claim`): uno solo entre los 3 BFF, sin reserva extra en la base.

/** A partir de cuánto (desde que llegó el archivo) se acusa sin resultado. La cola tarda ~40–60 s. */
export const ACUSE_DIFERIDO_MS = 90_000;
let esperaAcuseMs = ACUSE_DIFERIDO_MS;
/** Solo para pruebas. */
export function _fijarEsperaAcuse(ms: number): void { esperaAcuseMs = ms; }

/** Pasos que son PREGUNTAS: salen en el acto (llevan su `queue_id` y esperan respuesta). */
const PASOS_PREGUNTA = new Set([
    'ask_cual_pago', 'confirmar_combinacion', PASO_PREGUNTA_DEPORTISTA,
    PASO_PREGUNTA_MES, PASO_PREGUNTA_CONCEPTO, PASO_PREGUNTA_DEPORTISTA_BOTONES,
]);

/** Respuestas de una ráfaga de archivos del mismo contacto, para mandarlas en UN mensaje. */
export interface RespuestaEnRafaga {
    texto: string; paso: string; queueId: string;
    /** (Plan B4) El motivo que asignó el asistente a este comprobante. */
    linea?: LineaDeMotivo;
}
export interface Rafaga {
    respuestas: RespuestaEnRafaga[];
    /** El envío de la última fila (con su conversación, baja, acudiente). */
    enviar?: (texto: string, payload: Record<string, unknown>, conConsentimiento: boolean,
        botones?: BotonInteractivo[]) => Promise<unknown>;
}

/**
 * Pura: el resumen de una ráfaga en la que el asistente asignó al menos un
 * motivo. «¡Recibí 2 comprobantes! ✅ 1. $310.000 → Inscripción · Mariana …»
 * con [Sí, está bien][Cambiar un motivo]. Callar = está bien.
 */
export function resumirRafagaConMotivos(respuestas: RespuestaEnRafaga[]): {
    texto: string; paso: string; botones: BotonInteractivo[]; lineas: LineaDeMotivo[];
} {
    const filas = respuestas.map((r, i) => {
        if (!r.linea) return `*${i + 1}.* ${r.texto}`;
        const quien = primerNombre(r.linea.atleta);
        return `*${i + 1}.* ${r.linea.monto ? pesos(r.linea.monto) : 'Sin monto'} → ${r.linea.motivo}${quien ? ` · ${quien}` : ''}`;
    });
    return {
        texto: `¡Recibí ${respuestas.length} comprobantes! ✅\n\n${filas.join('\n')}\n\n` +
            'La escuela los revisa y te confirma. ¿Está bien así?',
        paso: PASO_RESUMEN_MOTIVOS,
        botones: [{ ...BOTON_MOTIVOS_OK }, { ...BOTON_MOTIVOS_CAMBIAR }],
        lineas: respuestas.map((r) => r.linea).filter((l): l is LineaDeMotivo => !!l),
    };
}

/**
 * Pura: las respuestas de varias fotos en un mensaje. Textos iguales van una
 * vez («Recibí tus 2 comprobantes 📄 Como todavía…»); distintos, numerados.
 */
export function resumirRafaga(respuestas: RespuestaEnRafaga[]): { texto: string; paso: string } {
    const n = respuestas.length;
    const unicos: RespuestaEnRafaga[] = [];
    for (const r of respuestas) if (!unicos.some((u) => u.texto === r.texto)) unicos.push(r);
    if (n <= 1 || unicos.length === 1) {
        const r = unicos[0];
        const texto = n > 1 && r.texto.startsWith('Recibí tu comprobante')
            ? `Recibí tus ${n} comprobantes${r.texto.slice('Recibí tu comprobante'.length)}`
            : r.texto;
        return { texto, paso: r.paso };
    }
    return {
        texto: `Recibí tus ${n} comprobantes:\n\n` + unicos.map((r, i) => `*${i + 1}.* ${r.texto}`).join('\n\n'),
        paso: 'resultado_rafaga',
    };
}

/** ¿Ya se le dijo «todavía no tienes tu cuenta» en las últimas 24 h? */
async function yaSeDijoSinCuenta(conversationId: string | null): Promise<boolean> {
    if (!conversationId) return false;
    try {
        const { data } = await supabase.from('whatsapp_messages')
            .select('id')
            .eq('conversation_id', conversationId)
            .eq('direction', 'outbound')
            .in('payload->>step', PASOS_SIN_CUENTA)
            .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
            .limit(1);
        return Array.isArray(data) && data.length > 0;
    } catch {
        return false;
    }
}

// ─── Para la Bandeja de comprobantes (2026-10-07) ───────────────────────────

/** Palabras con las que alguien anuncia un pago («mi pago de este mes», «Mes octubre»). */
const PISTA_DE_PAGO_DESCONOCIDO = new RegExp(
    '\\b(pagos?|pague|comprobantes?|soportes?|transferencias?|consignacion|consigno|mensualidad|recibo|abono|cuota|nequi|daviplata)\\b'
    + '|\\bmes (de )?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\\b');

/** Pura: ¿el pie o los textos alrededor del archivo hablan de un pago? Sin OCR. */
export function textosHablanDePago(textos: (string | null | undefined)[]): boolean {
    return textos.some((t) => {
        const n = normalizarFrase(t);
        return !!n && PISTA_DE_PAGO_DESCONOCIDO.test(n);
    });
}

/** El pie del archivo y lo que el contacto escribió `antesMin` antes / `despuesMin` después (15/5 por defecto). */
async function textosDelContacto(
    fila: FilaCola, conversationId: string | null, antesMin = 15, despuesMin = 5,
): Promise<(string | null | undefined)[]> {
    const textos: (string | null | undefined)[] = [fila.media_caption];
    if (!conversationId) return textos;
    try {
        const base = fila.created_at ? new Date(fila.created_at).getTime() : Date.now();
        const { data } = await supabase.from('whatsapp_messages')
            .select('text_body')
            .eq('conversation_id', conversationId)
            .eq('direction', 'inbound')
            .gte('created_at', new Date(base - antesMin * 60_000).toISOString())
            .lte('created_at', new Date(base + despuesMin * 60_000).toISOString())
            .limit(30);
        for (const m of (Array.isArray(data) ? data : []) as any[]) textos.push(m?.text_body);
    } catch { /* solo el pie */ }
    return textos;
}

// ─── «No es un comprobante» solo con contexto de pago (2026-10-09) ──────────
//
// Decisión: el bot responde a una imagen o un documento SOLO si es un pago. En
// 7 días «Revisé el archivo… *no es un comprobante de pago*» salió 11 veces y
// ninguna venía con texto de pago: eran fotos del entrenamiento y similares.
// Ahora ese aviso sale solo si (a) el pie o un texto de la misma persona en
// ±10 min habla de un pago, o (b) la lectura que YA se hizo muestra una
// pantalla bancaria, un QR o una llave de pago (sin llamadas extra). Si no,
// la fila se cierra en silencio y queda en el buzón.

/** Lo que alguien escribe cuando lo que manda tiene que ver con pagar. Sobre texto normalizado. */
const PISTA_DE_CONTEXTO_DE_PAGO = new RegExp(
    '\\b(pag(o|os|ue|ar|ado|ada|ando|amos|aste|aron)|comprobantes?|soportes?|transferencias?|transferi(do)?|transfiero'
    + '|consigne|consigno|consignacion|consignado|mensualidad(es)?|cuotas?|abono|recibo'
    + '|nequi|daviplata|bancolombia|davivienda|bre ?b|llaves?|qr)\\b'
    + '|\\bmes (de )?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\\b');

/** Lo que se ve escrito en una pantalla bancaria, un QR o una llave para pagar. */
const PISTA_DE_PANTALLA_DE_PAGO = new RegExp(
    '\\b(llaves?|bre ?b|codigo qr|qr|escanea|nequi|daviplata|bancolombia|davivienda|transferencias?|transferir'
    + '|cuenta de ahorros|cuenta corriente|numero de cuenta|pagar|pago)\\b');

/** Pura: ¿el pie o los textos cercanos de la persona hablan de un pago? */
export function textosConContextoDePago(textos: (string | null | undefined)[]): boolean {
    return textos.some((t) => {
        const n = normalizarFrase(t);
        return !!n && PISTA_DE_CONTEXTO_DE_PAGO.test(n);
    });
}

/**
 * Pura: ¿la lectura (la misma que ya se hizo) muestra una pantalla bancaria,
 * un QR o una llave de pago? Banco reconocido, destino (cuenta/celular/llave)
 * o texto visible de pago. Una foto del entrenamiento no trae nada de eso.
 */
export function lecturaSugierePantallaDePago(
    ocr: Partial<Awaited<ReturnType<typeof extractReceipt>>> | null | undefined,
): boolean {
    if (!ocr) return false;
    if (ocr.bank && ocr.bank !== 'Otro') return true;
    if (ocr.destination && String(ocr.destination).trim()) return true;
    const n = normalizarFrase(ocr.rawText);
    return !!n && PISTA_DE_PANTALLA_DE_PAGO.test(n);
}

/** ¿Hay contexto de pago para decirle «no es un comprobante»? Nunca lanza. */
async function hayContextoDePago(
    fila: FilaCola, conversationId: string | null,
    ocr: Partial<Awaited<ReturnType<typeof extractReceipt>>> | null | undefined,
): Promise<boolean> {
    if (lecturaSugierePantallaDePago(ocr)) return true;
    return textosConContextoDePago(await textosDelContacto(fila, conversationId, 10, 10));
}

export const MOTIVO_NO_ES_COMPROBANTE_SIN_CONTEXTO = 'no_es_comprobante_sin_contexto';

/** El archivo no es un pago y nada habla de pagar: sin responder, queda en el buzón. */
async function cerrarNoEsComprobanteSinContexto(fila: FilaCola, log?: Logger): Promise<void> {
    await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: MOTIVO_NO_ES_COMPROBANTE_SIN_CONTEXTO });
    log?.info?.({ queueId: fila.id }, '[wa-queue] no es comprobante y no habla de pago: sin respuesta');
}

/**
 * Familia sin cuenta: el atleta de la ficha con ese celular (`parent_phone_temp`),
 * si es UNO solo, en `matched_child_id` de la fila escalada. La Bandeja lo
 * muestra y la escuela lo aplica sin buscarlo. Nunca lanza.
 */
async function anotarAtletaDeLaFicha(fila: FilaCola): Promise<void> {
    try {
        const tel = String(fila.wa_phone_number ?? '').replace(/\D/g, '').slice(-10);
        if (!/^3\d{9}$/.test(tel)) return;
        const { data } = await supabase.from('children')
            .select('id')
            .eq('school_id', fila.school_id)
            .eq('is_active', true)
            .ilike('parent_phone_temp', `%${tel}`)
            .limit(2);
        if (!Array.isArray(data) || data.length !== 1) return;
        await supabase.from('whatsapp_inbound_queue')
            .update({ matched_child_id: (data[0] as any).id })
            .eq('id', fila.id)
            .eq('result_type', 'escalated');
    } catch { /* sin atleta: la escuela lo busca */ }
}

// ─── Comprobantes por ficha (Dynasty 28-sep → 08-oct, 43 escalados) ────────
//
// (a) Familia sin cuenta con ficha por teléfono → el cobro se busca por la
//     ficha y se aplica igual que a una familia con cuenta.
// (b) Número sin ficha → el deportista por nombre (pie, chat, concepto y quien
//     paga en el comprobante); si no hay uno solo, se pregunta UNA vez.
// Ver whatsapp-comprobante-de-ficha.service.

/**
 * ¿A qué cuenta fue el dinero? 'general' (una cuenta de la escuela para
 * cualquier cobro), 'restringida' (p. ej. el Nequi personal de la dueña, solo
 * para inscripciones: un amigo que le devuelve plata también llega ahí),
 * 'ajena', o null si no se pudo cruzar (sin destino leído o sin cuentas).
 */
export async function destinoDelComprobante(
    schoolId: string,
    ocr: Awaited<ReturnType<typeof extractReceipt>>,
): Promise<'general' | 'restringida' | 'fuera_de_sportmaps' | 'ajena' | null> {
    const destino = normalizeDestination(ocr.destination);
    if (!destino) return null;
    const ctx = await buildVerdictContext(schoolId, { referenceNorm: null, imageSha256: null });
    const generales = ctx.registeredAccounts ?? [];
    const restringidas = (ctx.restrictedAccounts ?? []).map((r) => r.value);
    const fuera = ctx.cuentasFueraDeSportmaps ?? [];
    if (!generales.length && !restringidas.length && !fuera.length) return null;
    if (generales.length && destinationMatchesRegistered(destino, generales)) return 'general';
    if (restringidas.length && destinationMatchesRegistered(destino, restringidas)) return 'restringida';
    if (fuera.length && destinationMatchesRegistered(destino, fuera)) return 'fuera_de_sportmaps';
    return 'ajena';
}

/**
 * ¿El contacto ya tiene OTRA pregunta de comprobante abierta (salió hace < 24 h
 * y sigue esperando)? Entonces la nueva queda en fila (plan B4 §3 T4.6). Una
 * lectura, solo cuando hay una pregunta que mandar. Nunca lanza (ante el error, no).
 */
async function otraPreguntaAbierta(fila: FilaCola): Promise<boolean> {
    try {
        const { data } = await supabase.from('whatsapp_inbound_queue')
            .select('id')
            .eq('integration_id', fila.integration_id)
            .eq('wa_phone_number', fila.wa_phone_number)
            .eq('status', 'waiting_user')
            .neq('id', fila.id)
            .gte('pregunta_at', new Date(Date.now() - 24 * 3600_000).toISOString())
            .limit(1);
        return Array.isArray(data) && data.length > 0;
    } catch {
        return false;
    }
}

/** ¿Este paso ya salió a la conversación en las últimas 24 h? Nunca lanza. */
async function yaSalioElPaso(conversationId: string | null, paso: string): Promise<boolean> {
    if (!conversationId) return false;
    try {
        const { data } = await supabase.from('whatsapp_messages')
            .select('id')
            .eq('conversation_id', conversationId)
            .eq('direction', 'outbound')
            .eq('payload->>step', paso)
            .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
            .limit(1);
        return Array.isArray(data) && data.length > 0;
    } catch {
        return false;
    }
}

type Responder = (texto: string, paso: string, botones?: BotonInteractivo[], linea?: LineaDeMotivo) => Promise<unknown>;

/**
 * (a) Familia sin cuenta con fichas por teléfono: se lee y se aplica por la
 * ficha. Una consulta (reclamo + algo que no es un comprobante) va a una
 * persona, como en `escalarALaEscuela`.
 */
async function comprobanteDeFamiliaSinCuenta(
    fila: FilaCola, wa: WhatsAppIntegration, conversationId: string | null,
    responder: Responder, llaves: LlavesDeFicha, log?: Logger,
): Promise<void> {
    const bajada = await bajarYGuardarArchivo(fila, wa, log);
    if (!bajada.ok) return;
    let ocr;
    try {
        ocr = await extractReceipt(bajada.base64, bajada.mime);
    } catch (err: any) {
        await reintentar(fila, `OCR no disponible: ${err?.message ?? err}`, log);
        return;
    }
    if (!pareceComprobanteDePago(ocr)) {
        if (ocr.isReceipt === false && !esConsultaSobreCobro(await textosCercanos(fila))) {
            if (!(await hayContextoDePago(fila, conversationId, ocr))) {
                await cerrarNoEsComprobanteSinContexto(fila, log);
                return;
            }
            await responder(M.noEsComprobante, 'no_es_comprobante');
            await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: 'no es un comprobante' });
            return;
        }
        await derivarConsulta(fila, wa, conversationId, responder, 'familia_sin_cuenta', log);
        return;
    }
    log?.info?.({ queueId: fila.id, fichas: llaves.childIds.length + llaves.unregisteredIds.length }, '[wa-queue] sin cuenta: por la ficha');
    await continuarComoComprobante(fila, null, responder, bajada.base64, bajada.mime, bajada.storagePath, ocr, log, { llaves });
}

/** Imágenes de un contacto sin ficha (que no habla de pagos) que se pasan por el OCR en la ventana. */
export const MAX_OCR_SIN_FICHA = 2;
/** Ventana del tope anterior, en minutos. */
export const VENTANA_OCR_SIN_FICHA_MIN = 10;
/** `error_message` de la fila que se cerró sin OCR por la ráfaga. */
export const MOTIVO_OCR_OMITIDO_RAFAGA = 'ocr_omitido: ráfaga de imágenes de un contacto sin ficha';

/**
 * ¿Ya hay MAX_OCR_SIN_FICHA adjuntos ANTERIORES de este contacto en la ventana?
 * Se cuentan por llegada (created_at), no por cuáles se leyeron: así dos filas
 * de la misma ráfaga procesadas a la vez deciden igual, y una ráfaga larga no
 * vuelve a abrir el OCR a los 10 min mientras siga llegando. Pura.
 */
export function excedeTopeOcr(previasEnVentana: number, max = MAX_OCR_SIN_FICHA): boolean {
    return previasEnVentana >= max;
}

/** Cuenta los adjuntos anteriores del contacto en la ventana. Nunca lanza (ante la duda, se lee). */
async function excedeOcrSinFicha(fila: FilaCola): Promise<boolean> {
    try {
        const base = fila.created_at ? new Date(fila.created_at).getTime() : Date.now();
        if (!Number.isFinite(base)) return false;
        const { count, error } = await supabase.from('whatsapp_inbound_queue')
            .select('id', { count: 'exact', head: true })
            .eq('integration_id', fila.integration_id)
            .eq('wa_phone_number', fila.wa_phone_number)
            .neq('id', fila.id)
            .gte('created_at', new Date(base - VENTANA_OCR_SIN_FICHA_MIN * 60_000).toISOString())
            .lt('created_at', new Date(base).toISOString());
        if (error || typeof count !== 'number') return false;
        return excedeTopeOcr(count);
    } catch {
        return false;
    }
}

/**
 * (b) Número sin ficha. Solo se le escribe si el archivo ES un comprobante
 * hacia una cuenta de la escuela (o el contacto habla de un pago y el destino
 * no es ajeno): a la vida privada de la dueña no se le contesta. Lo que no es
 * un comprobante no se guarda (salvo que hable de un pago: la Bandeja lo
 * muestra, como antes). Siempre cierra o deja esperando la fila.
 */
async function comprobanteDeNumeroSinFicha(
    fila: FilaCola, wa: WhatsAppIntegration, conversationId: string | null,
    responder: Responder, log?: Logger,
): Promise<void> {
    const silencio = () => cerrar(fila.id, 'ignored', { result_type: 'none', error_message: 'contacto_no_atendido' });
    const textos = await textosDelContacto(fila, conversationId);
    // (Plan B4) Un motivo esperado vivo (el bot le pidió el pago) cuenta como
    // «habla de pago»: se lee sin el tope de ráfaga y se guarda el archivo.
    const b4 = await contextoB4(fila.school_id, fila.wa_phone_number);
    const hablaDePago = textosHablanDePago(textos) || b4.esperados.length > 0;
    let archivo: { base64: string; mime: string };
    if (hablaDePago) {
        const bajada = await bajarYGuardarArchivo(fila, wa, log);
        if (!bajada.ok) return;
        archivo = bajada;
    } else {
        // Ráfaga de imágenes de alguien sin ficha que no habla de pagos
        // (auditoría 2026-10-10: un número desconocido mandó decenas de fotos y
        // cada una se bajaba y pasaba por el OCR). Se leen como mucho
        // MAX_OCR_SIN_FICHA por ventana; las demás se cierran en silencio, sin
        // bajarlas ni contestar, y quedan marcadas para no reintentarse.
        if (await excedeOcrSinFicha(fila)) {
            await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: MOTIVO_OCR_OMITIDO_RAFAGA });
            log?.info?.({ queueId: fila.id }, '[wa-queue] ráfaga de imágenes sin ficha: sin OCR');
            return;
        }
        const r = await obtenerArchivoDeFila(fila, wa, { guardar: false });
        if (!r.ok) { await silencio(); return; }
        archivo = r;
    }
    let ocr;
    try {
        ocr = await extractReceipt(archivo.base64, archivo.mime);
    } catch (err: any) {
        // Un OCR caído nunca decide (regla 2 del worker): antes esto cerraba como
        // `contacto_no_atendido` y un pago real se perdía. Se reintenta.
        await reintentar(fila, `OCR no disponible: ${err?.message ?? err}`, log);
        return;
    }
    // Se le escribe solo si el dinero fue a una cuenta general de la escuela, o
    // si habla de un pago y el destino no es ajeno.
    const destino = pareceComprobanteDePago(ocr) ? await destinoDelComprobante(fila.school_id, ocr) : 'ajena';
    if (destino === 'fuera_de_sportmaps') {
        // Pago a una cuenta que la escuela acepta por fuera de la app: no se le
        // contesta a un número sin ficha; queda informativo en la bandeja.
        await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: MOTIVO_FUERA_DE_SPORTMAPS });
        return;
    }
    if (destino === 'ajena' && pareceComprobanteDePago(ocr)) {
        // Spec 3.5: un comprobante NUNCA se ignora por el tipo de contacto. A una
        // cuenta que no es de la escuela: sin responderle (es un número sin ficha),
        // pero se guarda y queda en la bandeja como `destino_ajeno`.
        const guardada = await bajarYGuardarArchivo(fila, wa, log);
        if (!guardada.ok) return;
        await cerrar(fila.id, 'ignored', {
            result_type: 'escalated',
            error_message: motivoConPropuesta(
                `recuperado: destino_ajeno — el dinero fue a ${ocr.destination ?? '?'}, que no es una cuenta de la escuela (número sin ficha)`,
                `Propuesta → pagó: ${ocr.originName ?? 'no se leyó'}${ocr.amount ? ` · ${cop(ocr.amount)}` : ''} · confirmar con quien lo mandó si era para la escuela`),
            pregunta_ocr: huellasDelComprobante({
                sha: crypto.createHash('sha256').update(Buffer.from(guardada.base64, 'base64')).digest('hex'),
                ocr, storagePath: guardada.storagePath, parentId: null,
            }),
        });
        return;
    }
    if (destino === 'ajena' || (destino !== 'general' && !hablaDePago)) { await silencio(); return; }

    const bajada = await bajarYGuardarArchivo(fila, wa, log);
    if (!bajada.ok) return;
    // (Plan B4) Prospecto: el motivo esperado (o el lead por teléfono y el
    // monto) ANTES de buscar un deportista por nombre — un prospecto no lo tiene.
    if (b4.activo && await atenderProspecto({
        fila, wa, conversationId, responder, ocr, base64: bajada.base64, storagePath: bajada.storagePath, log,
    }, b4)) return;
    const llaves = await deportistaPorNombre(fila.school_id, [...textos, ocr.description, ocr.originName]);
    if (llaves) {
        log?.info?.({ queueId: fila.id }, '[wa-queue] número sin ficha: deportista por nombre');
        await continuarComoComprobante(fila, null, responder, bajada.base64, bajada.mime, bajada.storagePath, ocr, log, { llaves });
        return;
    }
    // Spec 3.3: el nombre no señala a UN deportista. Si 2-3 se le parecen →
    // botones con sus nombres; si ninguno →  «escribe nombre y apellido».
    const posibles = await candidatosParaPreguntar(fila.school_id, [...textos, ocr.description, ocr.originName]);
    const paso = posibles.length ? PASO_PREGUNTA_DEPORTISTA_BOTONES : PASO_PREGUNTA_DEPORTISTA;
    // UNA vez: si ya se le preguntó (otra foto de la ráfaga), esta queda esperando la misma respuesta.
    let salida: SalidaDePregunta;
    if (!(await yaSalioElPaso(conversationId, paso))) {
        salida = (posibles.length
            ? await responder(textoPreguntaDeportista(), paso, botonesDeDeportistas(posibles))
            : await responder(PREGUNTA_DEPORTISTA, paso)) as SalidaDePregunta;
    }
    await esperarAlUsuario(fila.id, {
        opciones: [], ocr,
        sha: crypto.createHash('sha256').update(Buffer.from(bajada.base64, 'base64')).digest('hex'),
        storagePath: bajada.storagePath, parentId: null, tipo: 'deportista',
        ...(posibles.length
            ? { guia: { opciones: opcionesDeDeportistas(posibles), monto: ocr.amount ?? null, quienPago: ocr.originName ?? null, parentId: null } }
            : {}),
        enFila: salida?.enFila,
    });
}

/**
 * Contacto que el bot NO atiende (personal, negocio, otro club, conversación
 * tomada por una persona…) manda un archivo. Antes se cerraba SIEMPRE como
 * `contacto_no_atendido`, aunque fuera un pago real (Dynasty: 117 archivos; 3
 * eran pagos por $610.000). Regla de 2026-10-24: un comprobante NUNCA se ignora
 * por el tipo de contacto. Se lee (con el mismo tope de ráfaga del contacto sin
 * ficha); si trae monto y el destino es una cuenta de la escuela, se GUARDA y
 * queda en la bandeja (`sin_familia`, con quién pagó). Sin responderle a nadie:
 * es un contacto que el bot no atiende. Lo que no es un pago sigue en silencio.
 */
async function comprobanteDeContactoNoAtendido(
    fila: FilaCola, wa: WhatsAppIntegration, conversationId: string | null, log: Logger | undefined,
    tipoDeContacto: string, anunciaPago: boolean,
): Promise<void> {
    const silencio = () => cerrar(fila.id, 'ignored', { result_type: 'none', error_message: 'contacto_no_atendido' });
    let archivo: { base64: string; mime: string; storagePath: string | null };
    if (anunciaPago) {
        // Lo de siempre: quien anuncia un pago por texto deja el archivo guardado.
        const bajada = await bajarYGuardarArchivo(fila, wa, log);
        if (!bajada.ok) return;
        archivo = bajada;
    } else {
        if (await excedeOcrSinFicha(fila)) { await silencio(); return; }
        const r = await obtenerArchivoDeFila(fila, wa, { guardar: false });
        if (!r.ok) { await silencio(); return; }
        archivo = r;
    }
    let ocr;
    try {
        ocr = await extractReceipt(archivo.base64, archivo.mime);
    } catch (err: any) {
        await reintentar(fila, `OCR no disponible: ${err?.message ?? err}`, log);
        return;
    }
    if (!pareceComprobanteDePago(ocr)) { await silencio(); return; }
    const destino = await destinoDelComprobante(fila.school_id, ocr);
    if (destino === 'fuera_de_sportmaps') {
        await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: MOTIVO_FUERA_DE_SPORTMAPS });
        return;
    }
    // Solo una cuenta GENERAL de la escuela cuenta: a una cuenta ajena o al Nequi
    // personal restringido de la dueña, un contacto personal manda plata por otras razones.
    if (destino !== 'general') { await silencio(); return; }

    const guardada = archivo.storagePath
        ? { ok: true as const, base64: archivo.base64, storagePath: archivo.storagePath }
        : await bajarYGuardarArchivo(fila, wa, log);
    if (!guardada.ok) return;
    const sha = crypto.createHash('sha256').update(Buffer.from(archivo.base64, 'base64')).digest('hex');
    await cerrar(fila.id, 'ignored', {
        result_type: 'escalated',
        error_message: motivoConPropuesta(
            `sin_familia: contacto_no_atendido (${tipoDeContacto}): comprobante${ocr.amount ? ` de ${cop(ocr.amount)}` : ''} a una cuenta de la escuela`,
            `Propuesta → pagó: ${ocr.originName ?? 'no se leyó'} · deportista: sin identificar (el número no está en ninguna ficha) · ${ocr.date ?? 'sin fecha'}`),
        pregunta_ocr: huellasDelComprobante({ sha, ocr, storagePath: guardada.storagePath, parentId: null }),
    });
    log?.info?.({ queueId: fila.id, tipo: tipoDeContacto }, '[wa-queue] contacto no atendido con un comprobante: a la bandeja');
}

/**
 * La familia contestó «¿De qué deportista es este pago?» y el nombre señala UNA
 * ficha: se aplica el comprobante guardado como el de una familia sin cuenta.
 * Lo llama whatsapp-respuesta-de-cobro (vía whatsapp-comprobante-de-ficha).
 * Nunca reintenta solo: un fallo deja la fila en el buzón.
 */
export async function aplicarComprobanteDeFicha(
    queueId: string,
    llaves: LlavesDeFicha,
    responder: (texto: string, paso: string) => Promise<unknown>,
    log?: Logger,
): Promise<void> {
    await retomarFilaGuardada(queueId, responder, log, (guardado) => (guardado?.guia?.motivo
        // (Plan B4) Hermanos: la pregunta llevaba el motivo ya resuelto; con el
        // deportista elegido se crea el cobro de ESE deportista.
        ? { parentId: guardado.parentId ?? null, llaves, motivo: guardado.guia.motivo as MotivoForzado }
        : { parentId: null, llaves }));
}

/**
 * (Plan B4) La familia eligió en la pregunta de concepto un motivo con precio y
 * el monto es ese precio: se crea el cobro y se aplica. El deportista es el de
 * la guía (si había uno solo); si no, se pregunta de cuál. Lo llama
 * whatsapp-respuesta-de-cobro. Nunca reintenta solo: un fallo deja la fila en
 * el buzón.
 */
export async function aplicarComprobanteConMotivo(
    queueId: string,
    motivo: MotivoForzado,
    responder: (texto: string, paso: string, botones?: BotonInteractivo[]) => Promise<unknown>,
    log?: Logger,
): Promise<void> {
    await retomarFilaGuardada(queueId, responder, log, (guardado) => {
        const dep = guardado?.guia?.deportista as { id?: string; tipo?: string } | null | undefined;
        const llaves: LlavesDeFicha | undefined = dep?.id
            ? (dep.tipo === 'unregistered' ? { childIds: [], unregisteredIds: [dep.id] } : { childIds: [dep.id], unregisteredIds: [] })
            : undefined;
        return { parentId: guardado?.parentId ?? null, llaves, motivo };
    });
}

/**
 * Toma una fila `waiting_user` (la respuesta de la familia), relee su archivo y
 * la pasa por `continuarComoComprobante` con lo que diga `como`. Sin fila, sin
 * lectura guardada o sin archivo → al buzón.
 */
async function retomarFilaGuardada(
    queueId: string,
    responder: Responder,
    log: Logger | undefined,
    como: (guardado: any) => { parentId: string | null; llaves?: LlavesDeFicha; motivo?: MotivoForzado | null },
): Promise<void> {
    const { data: tomadas } = await supabase.from('whatsapp_inbound_queue')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', queueId).eq('status', 'waiting_user')
        .select('*');
    const fila = (Array.isArray(tomadas) ? tomadas[0] : null) as (FilaCola & { pregunta_ocr?: any }) | null;
    const guardado = fila?.pregunta_ocr;
    if (!fila || !guardado?.ocr) return;
    const aLaEscuela = async (motivo: string) => {
        await responder(M.escaladoSinAcudiente, 'familia_sin_cuenta');
        await cerrar(fila.id, 'ignored', { result_type: 'escalated', error_message: `sin_familia: ${motivo}` });
    };
    const { data: integ } = await supabase.from('school_whatsapp_integrations')
        .select('*').eq('id', fila.integration_id).maybeSingle();
    if (!integ) { await aLaEscuela('la integración ya no existe'); return; }
    const archivo = await obtenerArchivoDeFila(fila, integ as WhatsAppIntegration, { guardar: false });
    if (!archivo.ok || !archivo.storagePath) {
        await aLaEscuela(archivo.ok ? 'sin archivo guardado' : archivo.error);
        return;
    }
    const { parentId, llaves, motivo } = como(guardado);
    await continuarComoComprobante(fila, parentId, responder, archivo.base64, archivo.mime, archivo.storagePath,
        guardado.ocr, log, { llaves, alFallar: aLaEscuela, motivo: motivo ?? null });
}

async function procesarFila(fila: FilaCola, log?: Logger, rafaga?: Rafaga): Promise<void> {
    // Acuse diferido: se arma cuando se sabe que a esta familia se le va a
    // contestar, y se desarma al salir.
    let acuseTimer: ReturnType<typeof setTimeout> | null = null;
    try {
        // La escuela de la fila queda en el contexto para el registro de consumo (llm_usage).
        await conContextoLlm({ schoolId: fila.school_id, feature: 'ocr' },
            () => procesarFilaInterna(fila, log, rafaga, (t) => { acuseTimer = t; }));
    } finally {
        if (acuseTimer) clearTimeout(acuseTimer);
    }
}

async function procesarFilaInterna(
    fila: FilaCola,
    log: Logger | undefined,
    rafaga: Rafaga | undefined,
    armarTimer: (t: ReturnType<typeof setTimeout>) => void,
): Promise<void> {
    // 1. La integración, que trae el token para bajar el archivo.
    const { data: integration } = await supabase
        .from('school_whatsapp_integrations')
        .select('*')
        .eq('id', fila.integration_id)
        .single();

    if (!integration) {
        await cerrar(fila.id, 'failed', { error_message: 'la integración ya no existe' });
        return;
    }
    const wa = integration as WhatsAppIntegration;

    // Se consulta el ESTADO de baja, no el evento. La ingesta solo marca
    // `opted_out` cuando el mensaje trae la palabra STOP, y una imagen no trae
    // texto: por eso un contacto dado de baja en un mensaje anterior recibía
    // respuesta igual. Medido el 2026-09-11.
    //
    // Se le responde —él inició el contacto mandando un comprobante—, pero con
    // la coletilla que le recuerda que tiene las notificaciones apagadas.
    const dadoDeBaja = await estaDadoDeBaja(fila.integration_id, fila.wa_phone_number);
    let conversationId: string | null = null;
    /** Pasos que salieron en este procesamiento: decide si se ofrece el consentimiento. */
    const pasosEnviados = new Set<string>();

    /**
     * Envía Y REGISTRA. Lo segundo no es un detalle: el worker mandaba con
     * `sendTextMessage` pelado, que no pasa por `wa_record_outbound_message`, así
     * que sus respuestas no aparecían en `whatsapp_messages`. La escuela veía la
     * foto que mandó el papá y ninguna de las respuestas del bot sobre su plata,
     * y no quedaba rastro auditable de lo que se le dijo.
     *
     * `conversationId` llega null solo si el contacto no tiene conversación, que
     * no puede pasar: la ingesta la crea antes de encolar.
     */
    // Mejora 9: si una persona tomó la conversación en el buzón, el comprobante
    // se procesa y se APLICA igual, pero no se le escribe a la familia: lo que
    // se le habría dicho queda en el log y el resultado se ve en el panel de
    // comprobantes. Se fija después de `debeAtender` (abajo).
    let tomada = false;
    /** ¿Ya se le contestó (o quedó en la ráfaga)? Desarma el acuse diferido. */
    let respondio = false;
    /** El acudiente, cuando se conoce: decide si la pregunta del consentimiento va al pie. */
    let parentIdConocido: string | null = null;

    /**
     * El envío en sí: presentación (primer contacto) y consentimiento al pie
     * (resultado de un comprobante) EN EL MISMO MENSAJE, anti-repetición, y
     * registro en whatsapp_messages.
     */
    const enviar = async (texto: string, payload: Record<string, unknown>, conConsentimiento: boolean,
        botonesPropios?: BotonInteractivo[]) => {
        let cuerpo = texto;
        let botones: any[] | null = botonesPropios?.length ? botonesPropios : null;
        let extra: Record<string, unknown> = {};
        // Import perezoso: el bot arrastra el modelo y media app. Cada pieza
        // por separado y sin poder tumbar el envío: la respuesta sale igual.
        let bot: any = null;
        try { bot = await import('../services/whatsapp-bot.service'); } catch { bot = null; }
        if (conversationId && bot) {
            try {
                cuerpo = await bot.conPresentacionSiEsPrimera(wa, conversationId, cuerpo);
            } catch { /* sin presentación */ }
            if (conConsentimiento && parentIdConocido) {
                try {
                    const anexo = await bot.anexoDeConsentimiento(wa, conversationId, fila.wa_phone_number, parentIdConocido);
                    if (anexo?.texto) {
                        cuerpo = `${cuerpo}\n\n${anexo.texto}`;
                        botones = bot.BOTONES_CONSENTIMIENTO ?? null;
                        extra = { pregunta: 'ask_consent' };
                    }
                } catch { /* sin consentimiento: sale la respuesta sola */ }
            }
        }
        const final = aFormatoWhatsApp(dadoDeBaja ? cuerpo + AVISO_DADO_DE_BAJA : cuerpo);

        // Si ese MISMO texto ya salió hace poco a este contacto, no se repite.
        // Medido el 2026-09-11: 8 imágenes de golpe produjeron 7 mensajes
        // idénticos seguidos, uno cada 5 segundos. Desde el lado del acudiente
        // eso es spam, y en un canal donde Meta mide la calidad del número,
        // repetir lo mismo siete veces es justo lo que penaliza.
        if (conversationId) {
            const desde = new Date(Date.now() - VENTANA_ANTI_REPETICION_MIN * 60_000).toISOString();
            const { data: repetido } = await supabase
                .from('whatsapp_messages')
                .select('id')
                .eq('conversation_id', conversationId)
                .eq('direction', 'outbound')
                .eq('text_body', final)
                .gte('created_at', desde)
                .limit(1);
            if (repetido && repetido.length > 0) {
                log?.info?.({ queueId: fila.id, paso: payload.step }, '[wa-queue] mismo mensaje reciente, no se repite');
                return { ok: true };
            }
        }

        let tipo = 'text';
        let enviado = botones?.length
            ? await sendInteractiveButtons(wa, fila.wa_phone_number, final, botones)
            : null;
        if (enviado?.ok) {
            tipo = 'interactive';
        } else {
            // Sin botones, o Meta los rechazó: el texto plano SIEMPRE sale (la
            // pregunta dice «Responde *SÍ*», que se lee igual que el botón).
            enviado = await sendTextMessage(wa, fila.wa_phone_number, final);
        }
        if (conversationId) {
            await supabase.rpc('wa_record_outbound_message', {
                p_conversation_id: conversationId,
                p_integration_id: fila.integration_id,
                p_wa_message_id: enviado.waMessageId || `local-${crypto.randomUUID()}`,
                p_type: tipo,
                p_text_body: final,
                p_payload: { ...payload, ...extra, ...(tipo === 'interactive' ? { botones } : {}) },
                p_ai_generated: true,
                p_to_wa_id: fila.wa_phone_number,
            });
        }
        return enviado;
    };

    const responder = async (texto: string, paso: string, botones?: BotonInteractivo[], linea?: LineaDeMotivo) => {
        if (tomada) {
            log?.info?.({ queueId: fila.id, paso }, '[wa-queue] conversación tomada: no se le escribe a la familia');
            return { ok: true, silenciado: true };
        }
        // Fila de preguntas (plan B4, todas las escuelas): si el contacto ya
        // tiene otra pregunta abierta, ésta NO sale: queda en fila y sale cuando
        // conteste la anterior. Antes salían las dos y la vieja se perdía.
        if (PASOS_PREGUNTA.has(paso) && await otraPreguntaAbierta(fila)) {
            respondio = true;
            const enFila: PreguntaEnFila = { texto, paso, botones: botones?.length ? botones : null, monto: null };
            log?.info?.({ queueId: fila.id, paso }, '[wa-queue] otra pregunta abierta: ésta queda en fila');
            return { ok: true, enFila };
        }
        respondio = true;
        pasosEnviados.add(paso);
        // Ráfaga: la respuesta se junta con las de las otras fotos y sale UNA
        // vez al final (`runWhatsAppQueue`). Las preguntas salen ya.
        if (rafaga && !PASOS_PREGUNTA.has(paso)) {
            rafaga.respuestas.push({ texto, paso, queueId: fila.id, ...(linea ? { linea } : {}) });
            rafaga.enviar = enviar;
            return { ok: true, enRafaga: true };
        }
        return enviar(texto, { step: paso, queue_id: fila.id }, paso === 'resultado_comprobante', botones);
    };

    /**
     * Acuse diferido: si a los ACUSE_DIFERIDO_MS de llegado el archivo esta
     * fila todavía no contestó, «Recibí tu comprobante 📄 Lo reviso…» por
     * `acusarAdjunto` (respeta modo, baja, persona escribiendo y ráfaga; se
     * calla si el bot ya dijo algo después del archivo). Solo en el primer
     * intento: un reintento ya tuvo el suyo.
     */
    const armarAcuseDiferido = () => {
        if (fila.retries > 0 || !conversationId || tomada) return;
        const llegada = fila.created_at ? Date.parse(fila.created_at) : NaN;
        const espera = Math.max(0, (Number.isFinite(llegada) ? llegada : Date.now()) + esperaAcuseMs - Date.now());
        const conv = conversationId;
        armarTimer(setTimeout(() => {
            if (respondio) return;
            respondio = true;
            void (async () => {
                try {
                    const { acusarAdjunto } = await import('../services/whatsapp-bot.service');
                    const r = await acusarAdjunto(wa, conv, fila.wa_phone_number, fila.wa_message_id, fila.media_caption ?? null);
                    log?.info?.({ queueId: fila.id, acuse: r }, '[wa-queue] acuse diferido');
                } catch (e: any) {
                    log?.warn?.({ queueId: fila.id, err: e?.message }, '[wa-queue] no se pudo acusar');
                }
            })();
        }, espera));
    };

    // 2. ¿Quién es? Se busca la conversación PRIMERO —tanto el camino de
    // siempre como la rama nueva de staff-admin la necesitan (esta última
    // para poder registrar sus mensajes salientes y para saber, sin una
    // segunda consulta, si el admin también es acudiente).
    const { data: conv } = await supabase
        .from('whatsapp_conversations')
        .select('id, parent_id, identified')
        .eq('integration_id', fila.integration_id)
        .eq('contact_wa_id', fila.wa_phone_number)
        .maybeSingle();

    conversationId = (conv?.id as string) ?? null;

    // 2.5. ¿Lo atiende el asistente? Va ANTES de bajar el archivo y del OCR:
    // con el bot apagado no se gasta nada ni se le escribe a nadie. Medido el
    // 2026-10-03 en Dynasty: sin esta puerta el worker le pidió el correo a 17
    // familias con `ai_enabled=false`.
    //
    // `debeAtender` también deja `contact_kind` en la conversación (el buzón
    // filtra por eso aunque el bot esté apagado) y, si reconoce al acudiente
    // por teléfono, vincula la conversación (`wa_identify_by_phone`).
    const atencion = await debeAtender(wa, conversationId, fila.wa_phone_number);
    // «También es familia» (marcado personal/negocio… pero acudiente): sus
    // comprobantes se aplican igual que los de una conversación tomada, sin
    // escribirle — es el WhatsApp personal de quien dirige la escuela.
    tomada = atencion.tomada === true || atencion.tambienFamilia === true;
    // Modo discreto (2026-10-29): si una persona de la escuela escribió en este
    // chat en las últimas 12 h, el comprobante se procesa y se aplica igual, pero
    // no se le escribe a la familia: ella está en la charla y confirma a su modo
    // (Dynasty 10-06: «Quedo septiembre al día» y el bot, encima, «octubre al día» ×3).
    if (!tomada && conversationId && modoDiscreto() && await escuelaActiva(conversationId)) tomada = true;

    // Solo se pregunta si administra la escuela cuando la respuesta puede
    // cambiar algo: familias que también son dueñas (ver `decidirAdjunto`).
    let esStaffAdmin = atencion.tipo === 'staff';
    if (atencion.botEncendido && ['familia', 'familia_sin_cuenta', 'ambiguo'].includes(atencion.tipo)) {
        const { data: staffCheck } = await supabase.rpc('wa_identify_staff_admin_by_phone', {
            p_school_id: fila.school_id,
            p_wa_phone_number: fila.wa_phone_number,
        });
        esStaffAdmin = (staffCheck as any)?.estado === 'identificado';
    }

    // 2.6. ¿Planilla de asistencia de un entrenador o de la dueña? Va antes de la
    // decisión y no depende del asistente (ver `intentarPlanillaDeStaff`). Lo
    // marcado como personal/negocio/otro club/plataforma no entra.
    let lecturaPrevia: LecturaPrevia | undefined;
    if (!esMarcaNoFamilia(atencion.tipo)) {
        const planilla = await intentarPlanillaDeStaff(fila, wa, conversationId, log);
        if (planilla.atendida) return;
        lecturaPrevia = planilla.previo;
    }

    const decision = decidirAdjunto({ botEncendido: atencion.botEncendido, tipo: atencion.tipo, esStaffAdmin });
    log?.info?.({ queueId: fila.id, tipo: atencion.tipo, decision }, '[wa-queue] atención');

    if (decision === 'bot_apagado') {
        await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: 'bot_apagado' });
        return;
    }
    if (decision === 'silencio') {
        // (b) Número sin ficha que manda un comprobante a la escuela: se busca
        // al deportista por nombre o se le pregunta una vez.
        if (atencion.tipo === 'desconocido' && !tomada) {
            await comprobanteDeNumeroSinFicha(fila, wa, conversationId, responder, log);
            return;
        }
        // Número desconocido que ANUNCIA un pago («Mira mile mi pago de este
        // mes», 06-oct: Helen, Andrés Vargas, Mauricio…): no se le responde,
        // pero el archivo se guarda (`storage_path`) para que la escuela lo vea
        // en la Bandeja — antes se perdía con la URL de Meta. Solo por el texto
        // (sin OCR) y nunca a contactos marcados como personales.
        // Un comprobante NUNCA se ignora por el tipo de contacto (2026-10-24): ver
        // `comprobanteDeContactoNoAtendido`.
        const anunciaPago = atencion.tipo === 'desconocido'
            && textosHablanDePago(await textosDelContacto(fila, conversationId));
        await comprobanteDeContactoNoAtendido(fila, wa, conversationId, log, atencion.tipo, anunciaPago);
        return;
    }
    armarAcuseDiferido();
    if (decision === 'staff_admin') {
        // §4.1/§4.2 de alta-atleta-por-foto-hoja-matricula.md.
        await procesarComoStaffAdmin(fila, wa, conv, responder, log, lecturaPrevia);
        return;
    }
    // Tope de comprobantes por número y por escuela ANTES de cualquier OCR (wa-limite-comprobantes.service).
    if (await frenarSiExcedeLimite(fila.id, { guardarArchivo: () => bajarYGuardarArchivo(fila, wa, log), responder,
        cerrar: (extra) => cerrar(fila.id, 'ignored', extra) }, log)) return;
    if (decision === 'escalar_sin_cuenta') {
        // (a) Con ficha por teléfono: se aplica por la ficha, sin pedir cuenta.
        const fichas = await fichasPorTelefono(fila.school_id, fila.wa_phone_number);
        if (fichas.childIds.length || fichas.unregisteredIds.length) {
            await comprobanteDeFamiliaSinCuenta(fila, wa, conversationId, responder, fichas, log);
            return;
        }
        // El mensaje (con el enlace de registro) se arma solo si de verdad es un
        // comprobante: a una consulta no se le ofrece registrarse.
        //
        // «No tienes cuenta» UNA vez cada 24 h por conversación: si el bot (o
        // la cola) ya lo dijo, el comprobante se acusa corto, sin el párrafo
        // (…8804c0, 07-oct: tres veces el mismo aviso en 14 min).
        await escalarALaEscuela(fila, wa, conversationId, responder,
            async () => (await yaSeDijoSinCuenta(conversationId)) ? M.escaladoSinAcudiente : mensajeSinCuenta(fila),
            'familia_sin_cuenta', 'familia_sin_cuenta', log);
        await anotarAtletaDeLaFicha(fila);
        return;
    }
    if (decision === 'escalar_ambiguo') {
        await escalarALaEscuela(fila, wa, conversationId, responder, M.numeroAmbiguo,
            'numero_ambiguo', 'numero_ambiguo', log);
        return;
    }

    // decision === 'comprobante'. ¿De qué acudiente? Primero el TELÉFONO, que es
    // lo que usó `debeAtender` para decir «familia» (y la RPC ya dejó la
    // conversación vinculada); si no, el OTP. Se pregunta de nuevo en vez de
    // fiarse de `conv`, que se leyó ANTES de que la RPC la vinculara.
    //
    // Antes esto solo miraba `conv.identified`, que lo estampa el bot: en
    // Dynasty, del 2 al 3 de octubre de 2026, 18 de 29 comprobantes se cerraron
    // «contacto sin identificar»; contra `wa_identify_by_phone` 7 eran
    // familias identificables que perdieron su comprobante por pedirles correo.
    const { data: identificacion } = await supabase.rpc('wa_identify_by_phone', {
        p_integration_id: fila.integration_id,
        p_contact_wa_id: fila.wa_phone_number,
    });
    let parentId: string | null =
        ((identificacion as any)?.estado === 'identificado' && (identificacion as any)?.parent_id)
            ? (identificacion as any).parent_id as string
            : null;
    // `conv` se leyó antes de la RPC: con una revinculación pendiente (número que ahora es de OTRO acudiente) el vínculo viejo no vale.
    if (!parentId && !revinculacionPendiente(identificacion) && conv?.identified && conv.parent_id) parentId = conv.parent_id as string;
    parentIdConocido = parentId;

    if (!parentId) {
        // 'familia' sin acudiente resoluble: no debería pasar. NO se pide el
        // correo (ver `M`); lo resuelve la escuela.
        await escalarALaEscuela(fila, wa, conversationId, responder, M.escaladoSinAcudiente,
            'familia_sin_acudiente', 'familia sin parent_id resoluble', log);
        return;
    }

    // 3. Bajar y GUARDAR antes de leer.
    const bajada = await bajarYGuardarArchivo(fila, wa, log);
    if (!bajada.ok) return;
    const { base64, mime, storagePath } = bajada;

    // 4. Leer. Si el OCR no responde, NO hay veredicto: se reintenta.
    let ocr;
    try {
        ocr = await extractReceipt(base64, mime);
    } catch (err: any) {
        await reintentar(fila, `OCR no disponible: ${err?.message ?? err}`, log);
        return;
    }

    // 4.5. ¿Acompaña un reclamo o una pregunta sobre un cobro, y la lectura no
    //      muestra un pago? (captura del correo de estado de cuenta + «¿por qué
    //      me cobran?», 2026-10-06). Va a una persona como consulta. Un
    //      comprobante real con un reclamo al lado SÍ se aplica: lo que la
    //      escuela revisa es el pago, y un falso positivo del texto no puede
    //      dejar sin aplicar un comprobante bueno.
    if (!pareceComprobanteDePago(ocr) && esConsultaSobreCobro(await textosCercanos(fila))) {
        await derivarConsulta(fila, wa, conversationId, responder, 'familia', log);
        return;
    }

    // 5. ¿Es siquiera un comprobante? Este es el caso del papá que sube el QR de
    //    pago en vez de la transferencia — el error más probable del flujo.
    //    Solo con contexto de pago (pie/texto de ±10 min, o la lectura muestra
    //    una pantalla bancaria/QR/llave): a una foto del entrenamiento no se le
    //    contesta (2026-10-09).
    if (ocr.isReceipt === false) {
        if (!(await hayContextoDePago(fila, conversationId, ocr))) {
            await cerrarNoEsComprobanteSinContexto(fila, log);
            return;
        }
        await responder(M.noEsComprobante, 'no_es_comprobante');
        await cerrar(fila.id, 'ignored', { result_type: 'none', error_message: 'no es un comprobante' });
        return;
    }

    await continuarComoComprobante(fila, parentId, responder, base64, mime, storagePath, ocr, log);

    // La pregunta del consentimiento ya NO sale como mensaje aparte después
    // del resultado (…b62e3f, 06-oct: resultado y 2 s después la pregunta): va
    // al pie del resultado, con sus botones (`enviar`).
}

// ─── Preguntas que nadie va a contestar ──────────────────────────────────────
//
// Una fila `waiting_user` espera que la familia diga a qué cobro va. Si la
// pregunta nunca le llegó —quedó en un BORRADOR del modo asistido que nadie
// aprobó, o la conversación estaba tomada y el worker no le escribió—, o si la
// familia no contestó, la fila esperaba para siempre con el comprobante sin
// aplicar. Caso real: …9366, 06-oct 09:31, 13 h y contando; la familia SÍ
// contestó («De sep y oct») pero la repregunta quedó en borrador.
//
// A las HORAS_VIDA_PREGUNTA horas pasa al buzón de la escuela (ignored +
// escalated, que es lo que lista «Comprobantes sin resolver») con el motivo.
// No se le escribe a la familia: la ventana de 24 h ya cerró.

export const HORAS_VIDA_PREGUNTA = 24;

export type PorQueVencio = 'pregunta_en_borrador' | 'pregunta_no_enviada' | 'sin_respuesta' | 'pregunta_en_fila';

/** Pura: el motivo que ve la escuela. */
export function motivoPreguntaVencida(e: { enviada: boolean; enBorrador: boolean; enFila?: boolean }): { codigo: PorQueVencio; texto: string } {
    if (e.enFila) {
        return { codigo: 'pregunta_en_fila', texto: `pregunta_vencida: la pregunta quedó en fila detrás de otra y no salió en ${HORAS_VIDA_PREGUNTA} h; aplicarlo a mano` };
    }
    if (e.enBorrador) {
        return { codigo: 'pregunta_en_borrador', texto: `pregunta_vencida: la pregunta de a qué cobro va quedó en un borrador sin enviar (${HORAS_VIDA_PREGUNTA} h); aplicarlo a mano` };
    }
    if (!e.enviada) {
        return { codigo: 'pregunta_no_enviada', texto: `pregunta_vencida: la pregunta de a qué cobro va nunca salió (conversación tomada); aplicarlo a mano` };
    }
    return { codigo: 'sin_respuesta', texto: `pregunta_vencida: la familia no dijo a qué cobro va en ${HORAS_VIDA_PREGUNTA} h; aplicarlo a mano` };
}

/** Vence las preguntas viejas. Idempotente y seguro con los 3 BFF: el UPDATE exige `waiting_user`. */
export async function vencerPreguntasSinRespuesta(log?: Logger, ahora = Date.now()): Promise<number> {
    const corte = new Date(ahora - HORAS_VIDA_PREGUNTA * 3600_000).toISOString();
    const { data: filas, error } = await supabase.from('whatsapp_inbound_queue')
        .select('id, integration_id, wa_phone_number, pregunta_at, updated_at, en_fila:pregunta_ocr->en_fila')
        .eq('status', 'waiting_user')
        .lt('updated_at', corte)
        .limit(50);
    if (error || !filas?.length) return 0;

    let vencidas = 0;
    for (const f of filas as any[]) {
        const desde = (f.pregunta_at ?? f.updated_at) as string;
        if (new Date(desde).getTime() > ahora - HORAS_VIDA_PREGUNTA * 3600_000) continue;

        let enviada = false;
        let enBorrador = false;
        try {
            const { data: conv } = await supabase.from('whatsapp_conversations')
                .select('id').eq('integration_id', f.integration_id).eq('contact_wa_id', f.wa_phone_number)
                .maybeSingle();
            const convId = (conv as any)?.id;
            if (convId) {
                const [{ data: salientes }, { data: borradores }] = await Promise.all([
                    supabase.from('whatsapp_messages').select('id')
                        .eq('conversation_id', convId).eq('direction', 'outbound')
                        .eq('payload->>queue_id', f.id).limit(1),
                    supabase.from('whatsapp_message_drafts').select('id, tool_context')
                        .eq('conversation_id', convId)
                        .in('status', ['pending', 'expired'])
                        .gte('created_at', desde)
                        .limit(20),
                ]);
                enviada = (salientes?.length ?? 0) > 0;
                enBorrador = ((borradores ?? []) as any[])
                    .some((b) => String(b?.tool_context?.step ?? '').startsWith('ask_cual_pago')
                        || String(b?.tool_context?.step ?? '').startsWith('confirmar_combinacion'));
            }
        } catch { /* sin detalle: vence igual con el motivo genérico */ }

        const motivo = motivoPreguntaVencida({ enviada, enBorrador, enFila: !f.pregunta_at && !!f.en_fila });
        const { data: cerradas } = await supabase.from('whatsapp_inbound_queue')
            .update({
                status: 'ignored',
                result_type: 'escalated',
                error_message: motivo.texto,
                processed_at: new Date(ahora).toISOString(),
                locked_until: null,
            })
            .eq('id', f.id)
            .eq('status', 'waiting_user')
            .select('id');
        if (cerradas?.length) {
            vencidas++;
            log?.info?.({ queueId: f.id, motivo: motivo.codigo }, '[wa-queue] pregunta vencida: al buzón de la escuela');
        }
    }
    return vencidas;
}

// ─── Entrada del job ─────────────────────────────────────────────────────────

export async function runWhatsAppQueue(log?: Logger): Promise<{ tomadas: number; errores: number }> {
    // Antes del claim y sin poder tumbarlo: una pregunta vieja no frena la cola.
    await vencerPreguntasSinRespuesta(log).catch((err) =>
        log?.warn?.({ err: err?.message ?? err }, '[wa-queue] no se pudieron vencer las preguntas'));

    const { data: filas, error } = await supabase.rpc('wa_queue_claim', {
        p_limit: LOTE, p_lease_minutes: LEASE_MIN, p_max_retries: MAX_REINTENTOS,
    });

    if (error) {
        log?.error?.({ err: error.message }, '[wa-queue] el claim falló');
        return { tomadas: 0, errores: 1 };
    }
    const lote = (filas ?? []) as FilaCola[];
    if (lote.length === 0) return { tomadas: 0, errores: 0 };

    // Ráfaga: varias fotos del MISMO contacto en el lote se procesan una por
    // una (cada comprobante se aplica a su cobro, como siempre), pero la
    // respuesta sale UNA vez al final: «Recibí tus 2 comprobantes: …».
    const grupos = new Map<string, FilaCola[]>();
    for (const fila of lote) {
        const k = `${fila.integration_id}|${fila.wa_phone_number}`;
        grupos.set(k, [...(grupos.get(k) ?? []), fila]);
    }

    let errores = 0;
    for (const filas of grupos.values()) {
        const rafaga: Rafaga | undefined = filas.length > 1 ? { respuestas: [] } : undefined;
        for (const fila of filas) {
            try {
                await procesarFila(fila, log, rafaga);
            } catch (err: any) {
                errores++;
                // Una excepción inesperada no puede dejar la fila colgada en
                // 'processing': se devuelve a la rueda con su motivo.
                await reintentar(fila, `excepción: ${err?.message ?? err}`, log).catch(() => {});
                log?.error?.({ err: err?.message ?? err, queueId: fila.id }, '[wa-queue] fila explotó');
            }
        }
        if (rafaga?.respuestas.length && rafaga.enviar) {
            // (Plan B4) Si el asistente asignó algún motivo, el resumen lleva las
            // líneas y [Sí, está bien][Cambiar un motivo]; si no, como siempre.
            const conMotivos = rafaga.respuestas.length > 1 && rafaga.respuestas.some((r) => r.linea);
            const resumen = conMotivos ? resumirRafagaConMotivos(rafaga.respuestas) : null;
            const { texto, paso } = resumen ?? resumirRafaga(rafaga.respuestas);
            const pasos = rafaga.respuestas.map((r) => r.paso);
            const ids = rafaga.respuestas.map((r) => r.queueId);
            try {
                await rafaga.enviar(texto,
                    {
                        step: paso, queue_id: ids[0], ...(ids.length > 1 ? { queue_ids: ids, pasos } : {}),
                        ...(resumen ? { lineas: resumen.lineas } : {}),
                    },
                    // Con los botones del resumen no va el consentimiento al pie (le quitaría los botones).
                    !resumen && pasos.includes('resultado_comprobante'),
                    resumen?.botones);
            } catch (err: any) {
                errores++;
                log?.error?.({ err: err?.message ?? err, queueIds: ids }, '[wa-queue] no salió la respuesta de la ráfaga');
            }
        }
    }
    return { tomadas: lote.length, errores };
}
