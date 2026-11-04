/**
 * whatsapp-payment-outcome.job — devolver el desenlace al chat donde entró.
 *
 * El bot le prometió al acudiente «la escuela lo está revisando y te confirma en
 * poco tiempo». Cuando la escuela aprueba, hoy sale un correo y una notificación
 * in-app; **por WhatsApp no salía nada**. El papá se quedaba esperando en el
 * canal donde había empezado la conversación.
 *
 * Medido el 2026-09-11: el pago se aprobó a las 18:33:58 y a las 18:36 el
 * acudiente seguía preguntando «¿aún no ha sido aprobado?». El sistema sabía y
 * no lo contaba por donde él estaba mirando.
 *
 * Va como job y no enganchado al botón de aprobar porque hay MÁS DE UN camino de
 * aprobación en la app (uno estampa `reconciliation_status`, el otro no, y las
 * notificaciones que emiten tienen títulos distintos). Enganchar uno dejaría el
 * otro mudo. Acá se observa el RESULTADO, que es lo único común a todos.
 *
 * La fila de la cola es el registro de «este pago entró por WhatsApp»: enlaza el
 * comprobante con el pago y con el teléfono. `outcome_notified_at` evita repetir.
 *
 * Fuera de la ventana de 24 h (2026-10-07). El 06-oct se avisaron a las 08:48
 * dos pagos aprobados el 05-oct de comprobantes del 03-oct: Meta rechazó los 6
 * textos con 131047 «Re-engagement message» —llega ASÍNCRONO, por el webhook de
 * estados— y el job ya los había dado por avisados. Ahora:
 *   - Ventana cerrada (último entrante > 24 h) → plantilla UTILITY aprobada
 *     (`pago_confirmado` / `comprobante_rechazado`), sin intentar el texto.
 *   - Texto rechazado por ventana, en el acto o después por el webhook (barrido
 *     `reintentarAvisosFueraDeVentana`) → la misma plantilla, UNA vez.
 *   - Sin plantilla (o sin opt-in, o glosa, o un cobro que no es mensualidad) →
 *     no se reintenta: queda «aviso_no_entregado» con el motivo.
 *   - Un fallo transitorio de Graph reintenta con espera (5, 20, 60 min) hasta
 *     MAX_INTENTOS; después, «aviso_no_entregado».
 * El estado va como sufijo de `error_message` (« | aviso_…»): las filas
 * `done` no lo usan y las de la recuperación conservan su texto.
 */

import crypto from 'node:crypto';
import { supabase } from '../config/supabase';
import {
    sendTextMessage, sendInteractiveButtons, aFormatoWhatsApp, type WhatsAppIntegration,
} from '../services/whatsapp.service';
import { estaDadoDeBaja, AVISO_DADO_DE_BAJA } from '../services/whatsapp-optin.service';
import { conversacionTomada } from '../services/whatsapp-tomada.service';
import { modoDiscreto, escuelaActiva } from '../services/whatsapp-modo-discreto';
import { modoDiscretoEfectivo } from '../services/whatsapp-ajustes-escuela.service';
import {
    enviarCobroPorPlantilla, ventanaAbierta, esErrorDeVentana, type ConceptoCobro,
} from '../services/whatsapp-plantillas.service';
import { emitirTokenCobro } from '../services/cobro-enlace-publico.service';
import { conceptoDelCobro } from '../services/whatsapp-otro-concepto.service';
import { esPagoUnico, type CobroClasificable } from '../services/tipo-de-cobro';
import type { Logger } from 'pino';

const LOTE = 100;
/** Días que un link de pago entregado espera a que lo paguen antes de dejar de mirarlo. */
export const DIAS_VIDA_LINK = 15;
export const MAX_INTENTOS = 3;
/** Minutos de espera tras el intento N (1-based). */
export const ESPERA_MIN = [5, 20, 60];
/** Hasta cuántos días atrás se buscan textos rechazados por ventana. */
const DIAS_BARRIDO = 7;

const cop = (n: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

/** Estados que son un DESENLACE: hay algo que contarle al acudiente. */
const RESUELTOS = ['paid', 'rejected', 'glosado'];

/** Estados en que queda un cobro cuyo comprobante se rechazó (la deuda sigue). */
const VIVOS_TRAS_RECHAZO = ['pending', 'overdue', 'partial'];

export type Desenlace = 'paid' | 'rejected' | 'glosado';

/**
 * Qué hay que contarle al acudiente sobre el comprobante de ESTA fila, o null si
 * sigue en revisión. Pura.
 *
 * Desde 2026-10-08 rechazar un comprobante NO pone el cobro en 'rejected' (eso
 * borraba la deuda): `reject_payment_receipt` lo devuelve a pending/overdue y
 * estampa `receipt_rejected_at`. El rechazo se reconoce por esa marca, y solo si
 * es POSTERIOR a la llegada de la fila: un rechazo viejo no es el desenlace de
 * un comprobante nuevo. 'rejected' sigue valiendo para los rechazos de antes.
 */
export function desenlaceDelPago(
    pago: { status: string; receipt_rejected_at?: string | null },
    filaCreadaEn: string | null | undefined,
): Desenlace | null {
    if (RESUELTOS.includes(pago.status)) return pago.status as Desenlace;
    if (!VIVOS_TRAS_RECHAZO.includes(pago.status) || !pago.receipt_rejected_at) return null;
    const rechazo = Date.parse(pago.receipt_rejected_at);
    const llegada = Date.parse(String(filaCreadaEn ?? ''));
    // Sin fecha de la fila no se puede afirmar que el rechazo sea de este
    // comprobante: mejor callar que contar un rechazo ajeno.
    if (!Number.isFinite(rechazo) || !Number.isFinite(llegada)) return null;
    return rechazo >= llegada ? 'rejected' : null;
}

// ─── Estado del aviso (puro) ────────────────────────────────────────────────

const SEPARADOR = ' | ';

export type EstadoAviso =
    | { tipo: 'nuevo' }
    | { tipo: 'reintento'; intentos: number; proximo: number }
    | { tipo: 'en_curso' }
    | { tipo: 'por_plantilla'; plantilla: string }
    | { tipo: 'no_entregado'; motivo: string };

/** Separa lo que ya tenía `error_message` del estado del aviso. */
export function separarAviso(em: string | null | undefined): { base: string | null; aviso: EstadoAviso } {
    const s = em ?? '';
    // La marca va al principio o detrás del separador; un «aviso_» suelto en
    // medio de otro motivo no es un estado.
    const conSep = s.lastIndexOf(`${SEPARADOR}aviso_`);
    const i = conSep >= 0 ? conSep + SEPARADOR.length : (s.startsWith('aviso_') ? 0 : -1);
    if (i < 0) return { base: em ?? null, aviso: { tipo: 'nuevo' } };
    const marca = s.slice(i);
    const baseFinal = conSep >= 0 ? s.slice(0, conSep) : null;
    let m: RegExpMatchArray | null;
    if ((m = marca.match(/^aviso_reintento:(\d+):(.+)$/))) {
        return { base: baseFinal, aviso: { tipo: 'reintento', intentos: Number(m[1]), proximo: Date.parse(m[2]) || 0 } };
    }
    if (marca.startsWith('aviso_en_curso')) return { base: baseFinal, aviso: { tipo: 'en_curso' } };
    if ((m = marca.match(/^aviso_por_plantilla:(.*)$/))) return { base: baseFinal, aviso: { tipo: 'por_plantilla', plantilla: m[1] } };
    if ((m = marca.match(/^aviso_no_entregado:\s*(.*)$/))) return { base: baseFinal, aviso: { tipo: 'no_entregado', motivo: m[1] } };
    return { base: em ?? null, aviso: { tipo: 'nuevo' } };
}

export function conAviso(base: string | null, aviso: EstadoAviso): string | null {
    let marca: string | null;
    switch (aviso.tipo) {
        case 'nuevo': marca = null; break;
        case 'reintento': marca = `aviso_reintento:${aviso.intentos}:${new Date(aviso.proximo).toISOString()}`; break;
        case 'en_curso': marca = 'aviso_en_curso'; break;
        case 'por_plantilla': marca = `aviso_por_plantilla:${aviso.plantilla}`; break;
        case 'no_entregado': marca = `aviso_no_entregado: ${aviso.motivo}`; break;
    }
    if (!marca) return base;
    return (base ? `${base}${SEPARADOR}${marca}` : marca).slice(-500);
}

/** Tras un fallo transitorio en el intento `intentos` (1-based): reintentar o rendirse. */
export function siguienteTrasFallo(intentos: number, motivo: string, ahora: number): EstadoAviso {
    if (intentos >= MAX_INTENTOS) return { tipo: 'no_entregado', motivo: `${intentos} intentos fallidos (${motivo})`.slice(0, 200) };
    const espera = ESPERA_MIN[Math.min(intentos - 1, ESPERA_MIN.length - 1)];
    return { tipo: 'reintento', intentos, proximo: ahora + espera * 60_000 };
}

/**
 * La plantilla que cuenta este desenlace, o por qué no hay. Pura.
 * `pago_confirmado` dice «por la mensualidad de {{2}}»: no se usa para un
 * uniforme o un torneo, sería mentirle a la familia. Para esos va
 * `pago_recibido_otro_concepto` (2026-10-07), que nombra lo pagado; mientras
 * no esté APPROVED en la WABA de la escuela el envío devuelve
 * `plantilla_no_aprobada` y el aviso queda «no entregado», como antes.
 */
export function plantillaDelDesenlace(
    estado: string,
    concept: string | null,
    /**
     * La categoría del cobro, cuando se leyó (2026-10-10). Con ella manda:
     * «Inscripción — PLAN RM MENSUAL — …» dice «mensual» en el nombre del plan
     * y por el texto salía «por la mensualidad de …» para una inscripción.
     */
    cobro?: Pick<CobroClasificable, 'payment_category' | 'payment_type'> | null,
): { concepto: ConceptoCobro } | { motivo: string } {
    if (estado === 'paid') {
        const otro = cobro?.payment_category
            ? esPagoUnico({ ...cobro, concept })
            : conceptoDelCobro(concept) !== null;
        return otro ? { concepto: 'pago_recibido_otro_concepto' } : { concepto: 'pago_confirmado' };
    }
    if (estado === 'rejected') return { concepto: 'comprobante_rechazado' };
    return { motivo: `sin plantilla para el estado ${estado}` };
}

/**
 * Lo pagado, como lo escribió la escuela en el cobro («Uniforme talla M»), para
 * {{2}} de `pago_recibido_otro_concepto`. Sin texto, null (dato_faltante: no sale).
 * Pura.
 */
export function textoDelConcepto(concept: string | null | undefined): string | null {
    const t = String(concept ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t;
}

/** «ISABELLA RODRIGUEZ HERNANDEZ» → «Isabella Rodriguez». */
export function nombreCorto(nombre: string | null | undefined): string | null {
    const partes = String(nombre ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (!partes.length) return null;
    return partes.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

// ─── Link de pago (Wompi con monto) ─────────────────────────────────────────

export const MESSAGE_TYPE_LINK = 'payment_link';

/**
 * Filas cuyo desenlace se le avisa a la familia: comprobantes aplicados y links
 * de pago entregados. `message_type` cubre los links guardados antes de la
 * migración 20261006233034 (con result_type 'none').
 */
export const FILTRO_FILAS_CON_DESENLACE =
    `result_type.eq.payment_receipt,result_type.eq.${MESSAGE_TYPE_LINK},message_type.eq.${MESSAGE_TYPE_LINK}`;

export interface AvisoDePagoPorLink {
    integrationId: string;
    schoolId: string;
    /** wa_id del contacto (573…), el mismo de la conversación. */
    waPhone: string;
    paymentId: string;
}

/** Idempotencia: un link de un cobro a un número deja UNA fila (wa_message_id es UNIQUE). */
export function idDeFilaLink(a: Pick<AvisoDePagoPorLink, 'paymentId' | 'waPhone'>): string {
    return `${MESSAGE_TYPE_LINK}:${a.paymentId}:${a.waPhone}`;
}

/**
 * Deja rastro de que a esta familia se le entregó por WhatsApp un link de pago
 * con monto (crearLinkWompiConMonto). Cuando el webhook de Wompi marque el
 * cobro `paid`, este job le avisa por el chat —texto en ventana, plantilla
 * `pago_confirmado` fuera—, con la misma reserva atómica que los comprobantes
 * (un solo aviso por cobro aunque también haya un comprobante).
 *
 * La fila nace `done` (el worker de comprobantes no la toma). No lanza.
 * Llamarla dos veces con el mismo cobro y número no duplica nada.
 */
export async function registrarAvisoDePagoPorLink(
    a: AvisoDePagoPorLink,
): Promise<{ ok: true; yaExistia: boolean } | { ok: false; error: string }> {
    const fila = {
        integration_id: a.integrationId,
        school_id: a.schoolId,
        wa_phone_number: a.waPhone,
        wa_message_id: idDeFilaLink(a),
        message_type: MESSAGE_TYPE_LINK,
        status: 'done',
        result_type: MESSAGE_TYPE_LINK,
        result_ref_id: a.paymentId,
        processed_at: new Date().toISOString(),
    };
    try {
        let { error } = await supabase.from('whatsapp_inbound_queue').insert(fila);
        // Sin la migración 20261006233034 el CHECK no admite 'payment_link':
        // se guarda como 'none' y el job la reconoce por message_type.
        if (error?.code === '23514') {
            ({ error } = await supabase.from('whatsapp_inbound_queue').insert({ ...fila, result_type: 'none' }));
        }
        if (error?.code === '23505') return { ok: true, yaExistia: true };
        if (error) return { ok: false, error: error.message };
        return { ok: true, yaExistia: false };
    } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
    }
}

/**
 * ¿Va la pregunta del consentimiento al pie del «pago confirmado»? Solo con el
 * pago aprobado, sin baja, y si la conversación es del PAGADOR: su `parent_id`
 * es el del cobro. Un número sin vincular (null) o de otra persona no recibe
 * el botón (auditoría 2026-10-10: se le ofreció a un número que no pagaba). Pura.
 */
export function puedeOfrecerConsentimiento(
    desenlace: Desenlace,
    dadoDeBaja: boolean,
    conv: { id?: string | null; parent_id?: string | null } | null | undefined,
    pagadorId: string | null | undefined,
): boolean {
    return desenlace === 'paid' && !dadoDeBaja && !!conv?.id
        && !!conv.parent_id && !!pagadorId && conv.parent_id === pagadorId;
}

/**
 * El aviso de comprobante rechazado, con el motivo que escribió la escuela.
 * Sin motivo (rechazos viejos) igual dice que el cobro sigue pendiente. Pura.
 */
/**
 * Cómo cierra el aviso de pago confirmado. «Queda al día» SOLO si la familia
 * no tiene otro cobro vivo: con pagos únicos (2026-10-10) pagar la inscripción
 * deja la mensualidad y el seguro pendientes, y decirle «al día» es mentirle.
 * `otros` null = no se pudo saber → no se promete nada. Pura.
 */
export function cierreDelAvisoDePago(otros: number | null): string {
    if (otros === null) return '';
    if (otros === 0) return ' Queda al día.';
    return otros === 1
        ? ' Te queda 1 cobro pendiente.'
        : ` Te quedan ${otros} cobros pendientes.`;
}

/** Cobros vivos de la misma familia en la escuela, sin contar este. null = no se pudo leer. */
async function otrosPendientesDeLaFamilia(pago: PagoDesenlace): Promise<number | null> {
    const filtro = pago.parent_id ? ['parent_id', pago.parent_id]
        : pago.child_id ? ['child_id', pago.child_id]
            : pago.unregistered_athlete_id ? ['unregistered_athlete_id', pago.unregistered_athlete_id] : null;
    if (!filtro) return null;
    try {
        const { data, error } = await supabase.from('payments')
            .select('id')
            .eq('school_id', pago.school_id)
            .eq(filtro[0], filtro[1])
            .in('status', ['pending', 'partial', 'overdue'])
            .neq('id', pago.id)
            .limit(50);
        if (error || !Array.isArray(data)) return null;
        return data.length;
    } catch {
        return null;
    }
}

export function textoComprobanteRechazado(monto: string, concepto: string | null, motivo: string | null | undefined): string {
    const m = String(motivo ?? '').trim();
    return `La escuela revisó tu comprobante de *${monto}* por *${concepto ?? 'tu cobro'}* y no lo pudo aprobar.` +
        (m ? `\n\n*Motivo:* ${m}` : '') +
        '\n\nEl cobro sigue pendiente. Si tienes el comprobante correcto, mándalo por acá y lo reviso enseguida.';
}

// ─── Envíos ─────────────────────────────────────────────────────────────────

interface PagoDesenlace {
    id: string; status: string; amount: number | string; concept: string | null; rejection_reason: string | null;
    school_id: string; parent_id: string | null; child_id: string | null; unregistered_athlete_id: string | null;
    receipt_rejected_at?: string | null;
    payment_category?: string | null;
    payment_type?: string | null;
    payment_channel?: string | null;
}

/**
 * ¿El cobro se pagó EN LÍNEA (webhook de Wompi / Mercado Pago, que estampan
 * `payment_channel = 'online'`)? Que el bot haya mandado un link no basta: en
 * Dynasty (2026-10-11/12) los tres cobros con link que terminaron pagados los
 * registró la escuela en efectivo o por transferencia, y la familia leyó
 * «Recibimos tu pago en línea». Pura.
 */
export function pagadoEnLinea(pago: { payment_channel?: string | null }): boolean {
    return String(pago.payment_channel ?? '').toLowerCase() === 'online';
}

const COLUMNAS_PAGO = 'id, status, amount, concept, payment_category, payment_type, payment_channel, rejection_reason, school_id, parent_id, child_id, unregistered_athlete_id';
/** Con la migración 20261008165728: la marca del rechazo del comprobante. */
const COLUMNAS_PAGO_CON_RECHAZO = `${COLUMNAS_PAGO}, receipt_rejected_at`;
let sinMarcaDeRechazo = false;

/**
 * Lee el pago con la marca de rechazo; sin la migración (42703, columna
 * inexistente) cae a las columnas de siempre y no lo vuelve a intentar. Sin
 * esto, un SELECT con una columna que no existe dejaba al job sin avisar nada,
 * tampoco los pagos confirmados.
 */
async function leerPago(id: string): Promise<PagoDesenlace | null> {
    if (!sinMarcaDeRechazo) {
        const { data, error } = await supabase.from('payments').select(COLUMNAS_PAGO_CON_RECHAZO).eq('id', id).maybeSingle();
        if (!error) return (data as PagoDesenlace | null) ?? null;
        if ((error as { code?: string }).code !== '42703') return null;
        sinMarcaDeRechazo = true;
    }
    const { data } = await supabase.from('payments').select(COLUMNAS_PAGO).eq('id', id).maybeSingle();
    return (data as PagoDesenlace | null) ?? null;
}

/**
 * Los pagos de todo el lote en UNA consulta. Antes era `leerPago` por fila en
 * cada vuelta (cada minuto, en cada BFF): con una docena de comprobantes
 * esperando revisión, cada pago se leía ~90 veces en 3 h (caída por Disk IO,
 * 2026-10-14). Si la consulta falla devuelve null y la vuelta entera se salta:
 * un mapa vacío haría que los links se dieran por «no pagados».
 */
async function leerPagos(ids: string[]): Promise<Map<string, PagoDesenlace> | null> {
    const unicos = [...new Set(ids.filter(Boolean))];
    const porId = new Map<string, PagoDesenlace>();
    if (unicos.length === 0) return porId;
    const columnas: string = sinMarcaDeRechazo ? COLUMNAS_PAGO : COLUMNAS_PAGO_CON_RECHAZO;
    let { data, error }: { data: unknown; error: unknown } = await supabase.from('payments').select(columnas).in('id', unicos);
    if (error && (error as { code?: string }).code === '42703' && !sinMarcaDeRechazo) {
        sinMarcaDeRechazo = true;
        ({ data, error } = await supabase.from('payments').select(COLUMNAS_PAGO).in('id', unicos));
    }
    if (error || !Array.isArray(data)) return null;
    for (const p of data as unknown as PagoDesenlace[]) porId.set(p.id, p);
    return porId;
}

/**
 * El barrido de textos rechazados por ventana (webhook de estados) recorre
 * `whatsapp_messages` sin índice que le sirva (~150 ms por vuelta). Esos
 * rechazos son raros (6 en total al 2026-10-14) y la plantilla no tiene apuro
 * de minutos: basta cada 10 min por proceso.
 */
const BARRIDO_VENTANA_CADA_MS = 10 * 60_000;
let ultimoBarridoVentana = 0;

/** Manda el desenlace por plantilla. Devuelve el estado final del aviso. */
async function avisarPorPlantilla(pago: PagoDesenlace, telefono: string, desenlace: Desenlace): Promise<EstadoAviso> {
    const cual = plantillaDelDesenlace(desenlace, pago.concept, pago);
    if ('motivo' in cual) return { tipo: 'no_entregado', motivo: `ventana cerrada; ${cual.motivo}` };

    const [perfil, hijo, sinRegistrar, escuela] = await Promise.all([
        pago.parent_id ? supabase.from('profiles').select('full_name').eq('id', pago.parent_id).maybeSingle() : Promise.resolve({ data: null }),
        pago.child_id ? supabase.from('children').select('full_name').eq('id', pago.child_id).maybeSingle() : Promise.resolve({ data: null }),
        pago.unregistered_athlete_id
            ? supabase.from('unregistered_athletes').select('full_name').eq('id', pago.unregistered_athlete_id).maybeSingle()
            : Promise.resolve({ data: null }),
        supabase.from('schools').select('name').eq('id', pago.school_id).maybeSingle(),
    ]);
    const atleta = nombreCorto((hijo as any)?.data?.full_name ?? (sinRegistrar as any)?.data?.full_name);
    const contacto = nombreCorto((perfil as any)?.data?.full_name)?.split(' ')[0] ?? 'familia';

    const r = await enviarCobroPorPlantilla({
        schoolId: pago.school_id,
        concepto: cual.concepto,
        telefono,
        tokenBoton: await emitirTokenCobro(pago.id),
        paymentId: pago.id,
        parentId: pago.parent_id,
        datos: {
            nombreContacto: contacto,
            nombreAtleta: atleta ?? '',
            nombreEscuela: (escuela as any)?.data?.name ?? '',
            monto: cop(Number(pago.amount)),
            motivo: pago.rejection_reason || 'la escuela no lo pudo validar',
            conceptoPago: textoDelConcepto(pago.concept),
        },
    });
    if (r.enviado) return { tipo: 'por_plantilla', plantilla: r.plantilla };
    return { tipo: 'no_entregado', motivo: `ventana cerrada; plantilla: ${r.motivo}${r.detalle ? ` (${r.detalle})` : ''}`.slice(0, 200) };
}

/**
 * La pregunta del consentimiento para el pie del «pago confirmado», o null.
 * Import perezoso (el bot arrastra el modelo y media app, como en la cola) y
 * nunca lanza: sin pregunta, el aviso sale solo.
 */
async function anexoDeConsentimientoAlPie(
    integration: WhatsAppIntegration, conversationId: string, waPhone: string, parentId: string | null,
): Promise<{ texto: string; botones: any[] | null } | null> {
    if (!parentId) return null;
    try {
        const bot = await import('../services/whatsapp-bot.service');
        const anexo = await bot.anexoDeConsentimiento(integration, conversationId, waPhone, parentId);
        return anexo?.texto ? { texto: anexo.texto, botones: (bot.BOTONES_CONSENTIMIENTO as any[]) ?? null } : null;
    } catch {
        return null;
    }
}

async function guardarAviso(
    ids: string[], base: string | null, aviso: EstadoAviso, extra: Record<string, unknown> = {},
): Promise<void> {
    await supabase.from('whatsapp_inbound_queue')
        .update({ error_message: conAviso(base, aviso), ...extra })
        .in('id', ids);
}

export async function runWhatsAppPaymentOutcome(log?: Logger): Promise<{ avisados: number }> {
    // Primero lo que Meta rechazó DESPUÉS de aceptarlo (webhook de estados).
    if (Date.now() - ultimoBarridoVentana >= BARRIDO_VENTANA_CADA_MS) {
        ultimoBarridoVentana = Date.now();
        await reintentarAvisosFueraDeVentana(log).catch((err) =>
            log?.warn?.({ err: err?.message ?? err }, '[wa-outcome] barrido de ventana cerrada falló'));
    }

    // Comprobantes que entraron por WhatsApp, se aplicaron a un pago, y ese pago
    // ya se resolvió sin que nadie se lo haya contado al acudiente.
    // Filtro por result_type (no el .or con message_type) para que aplique el
    // índice parcial idx_wa_queue_sin_avisar: con el .or tenía 0 usos y cada
    // vuelta era seq scan (caída por Disk IO 2026-10-14). Las filas de link
    // guardadas con result_type 'none' no existen: el CHECK vivo admite
    // 'payment_link' y en la base hay 0 (verificado 2026-10-14).
    const { data: filas, error } = await supabase
        .from('whatsapp_inbound_queue')
        .select('id, integration_id, school_id, wa_phone_number, result_ref_id, error_message, message_type, created_at')
        .in('result_type', ['payment_receipt', MESSAGE_TYPE_LINK])
        .is('outcome_notified_at', null)
        .not('result_ref_id', 'is', null)
        .limit(LOTE);

    if (error) {
        log?.error?.({ err: error.message }, '[wa-outcome] no se pudo listar');
        return { avisados: 0 };
    }
    if (!filas || filas.length === 0) return { avisados: 0 };

    let avisados = 0;
    const ahora = Date.now();
    const pagos = await leerPagos(filas.map((f) => f.result_ref_id as string));
    if (!pagos) {
        log?.warn?.('[wa-outcome] no se pudieron leer los pagos del lote');
        return { avisados: 0 };
    }

    for (const fila of filas) {
        const previo = separarAviso(fila.error_message as string | null);
        // Esperando el backoff de un fallo anterior.
        if (previo.aviso.tipo === 'reintento' && previo.aviso.proximo > ahora) continue;
        const intentosPrevios = previo.aviso.tipo === 'reintento' ? previo.aviso.intentos : 0;

        const pago = pagos.get(fila.result_ref_id as string) ?? null;

        const porLink = (fila as any).message_type === MESSAGE_TYPE_LINK;
        // Link de pago: solo el pago confirmado es desenlace (un intento
        // rechazado en Wompi deja el cobro pendiente). Pasados DIAS_VIDA_LINK
        // sin pagarse, se deja de mirar.
        if (porLink && pago?.status !== 'paid') {
            const creada = Date.parse(String((fila as any).created_at ?? ''));
            if (!pago || (creada && ahora - creada > DIAS_VIDA_LINK * 86_400_000)) {
                await supabase.from('whatsapp_inbound_queue')
                    .update({
                        outcome_notified_at: new Date().toISOString(),
                        error_message: conAviso(previo.base, { tipo: 'no_entregado', motivo: 'el link de pago no se pagó' }),
                    })
                    .eq('id', fila.id)
                    .is('outcome_notified_at', null);
            }
            continue;
        }

        // Todavía en revisión: no hay nada que contar. Se vuelve a mirar en la
        // siguiente vuelta.
        const desenlace = pago ? desenlaceDelPago(pago, (fila as any).created_at) : null;
        if (!pago || !desenlace) continue;

        const { data: integration } = await supabase
            .from('school_whatsapp_integrations')
            .select('*')
            .eq('id', fila.integration_id as string)
            .maybeSingle();

        if (!integration) {
            // Sin integración no hay por dónde avisar. Se marca para no volver a
            // intentarlo en cada vuelta, para siempre.
            await supabase.from('whatsapp_inbound_queue')
                .update({
                    outcome_notified_at: new Date().toISOString(),
                    error_message: conAviso(previo.base, { tipo: 'no_entregado', motivo: 'sin integración de WhatsApp' }),
                })
                .eq('id', fila.id);
            continue;
        }

        const monto = cop(Number(pago.amount));
        let texto: string;
        if (desenlace === 'paid' && porLink && pagadoEnLinea(pago)) {
            texto = `¡Listo! ✅ Recibimos tu pago en línea de *${monto}* por *${pago.concept}*.`
                + cierreDelAvisoDePago(await otrosPendientesDeLaFamilia(pago));
        } else if (desenlace === 'paid') {
            texto = `¡Listo! ✅ La escuela confirmó tu pago de *${monto}* por *${pago.concept}*.`
                + cierreDelAvisoDePago(await otrosPendientesDeLaFamilia(pago));
        } else if (desenlace === 'rejected') {
            // El motivo importa: un rechazo sin explicación deja al acudiente sin
            // saber qué corregir, que es justo el caso que originó todo esto.
            texto = textoComprobanteRechazado(monto, pago.concept, pago.rejection_reason);
        } else {
            texto =
                `La escuela necesita una aclaración sobre tu pago de *${monto}* por *${pago.concept}*. ` +
                'Te van a escribir para resolverlo.';
        }

        // Mejora 9: una persona tomó la conversación en el buzón → no se le
        // escribe. NO se marca como avisado: sale en la primera vuelta después
        // de que la suelten o venza la toma.
        const { data: conv } = await supabase
            .from('whatsapp_conversations')
            .select('id, last_inbound_at, parent_id')
            .eq('integration_id', fila.integration_id as string)
            .eq('contact_wa_id', fila.wa_phone_number as string)
            .maybeSingle();
        if (conv?.id && await conversacionTomada(conv.id as string)) {
            log?.info?.({ queueId: fila.id }, '[wa-outcome] conversación tomada: el aviso espera');
            continue;
        }

        // Reserva ANTES de enviar. Los tres BFF (dev/stg/prod) comparten la base
        // y corren este job al mismo tiempo: sin esto, cada uno leía la fila
        // pendiente y enviaba («La escuela confirmó tu pago» ×3 en el mismo
        // segundo, 2026-10-06). Se reservan todas las filas del MISMO pago (dos
        // comprobantes de un pago salían ×6); solo quien las toma avisa.
        const reservadaEn = new Date().toISOString();
        const { data: reservadas } = await supabase.from('whatsapp_inbound_queue')
            .update({ outcome_notified_at: reservadaEn })
            .or(FILTRO_FILAS_CON_DESENLACE)
            .eq('result_ref_id', fila.result_ref_id as string)
            .is('outcome_notified_at', null)
            .select('id');
        if (!reservadas?.length) continue;
        const idsReservados = (reservadas as any[]).map((r) => r.id);

        // Modo discreto (2026-10-29): si una persona de la escuela escribió en este
        // chat en las últimas 12 h, ella le confirma a su modo; el aviso queda
        // reservado sin enviarse (y no se reintenta). El modo de ESA escuela (B6), no
        // solo la variable global: Monster lo tiene en «no».
        if ((conv as any)?.id && await modoDiscretoEfectivo(fila.school_id as string, modoDiscreto())
            && await escuelaActiva((conv as any).id as string)) {
            await guardarAviso(idsReservados, previo.base,
                { tipo: 'no_entregado', motivo: 'la escuela estaba en la conversación (modo discreto)' });
            log?.info?.({ queueId: fila.id, paymentId: pago.id }, '[wa-outcome] la escuela está en el chat: no se avisa');
            continue;
        }

        // Fuera de la ventana de 24 h el texto libre no llega (131047): directo
        // a la plantilla, sin gastar un intento que Meta va a rechazar.
        if (!ventanaAbierta((conv as any)?.last_inbound_at ?? null, ahora)) {
            const final = await avisarPorPlantilla(pago, fila.wa_phone_number as string, desenlace);
            await guardarAviso(idsReservados, previo.base, final);
            if (final.tipo === 'por_plantilla') avisados++;
            log?.info?.({ queueId: fila.id, paymentId: pago.id, aviso: final }, '[wa-outcome] ventana cerrada');
            continue;
        }

        const dadoDeBaja = await estaDadoDeBaja(fila.integration_id as string, fila.wa_phone_number as string);
        // «Pago confirmado» con la ventana abierta es el mejor momento para
        // pedir el consentimiento: la familia acaba de ver que el canal le
        // sirve. Va al pie del mismo mensaje (no como uno aparte), con las
        // mismas reglas que en el bot (con cuenta, sin opt-in, sin baja, sin
        // haber dicho que no, una vez cada DIAS_PARA_REPREGUNTAR).
        // Solo si ESTE número es el del pagador (auditoría 2026-10-10): el
        // comprobante lo puede mandar un tío o un número sin ficha, y a ese
        // número no se le ofrece activar los avisos de otra persona.
        const consentimiento = puedeOfrecerConsentimiento(desenlace, dadoDeBaja, conv as any, (pago as any).parent_id)
            ? await anexoDeConsentimientoAlPie(integration as WhatsAppIntegration, (conv as any).id as string,
                fila.wa_phone_number as string, (pago as any).parent_id ?? null)
            : null;
        const final = aFormatoWhatsApp((dadoDeBaja ? texto + AVISO_DADO_DE_BAJA : texto)
            + (consentimiento ? `\n\n${consentimiento.texto}` : ''));

        let tipo = 'text';
        let enviado = consentimiento?.botones?.length
            ? await sendInteractiveButtons(integration as WhatsAppIntegration, fila.wa_phone_number as string,
                final, consentimiento.botones)
            : null;
        if (enviado?.ok) {
            tipo = 'interactive';
        } else {
            // Sin botones, o Meta los rechazó: el texto plano sale igual (la
            // pregunta dice «Responde *SÍ*»).
            enviado = await sendTextMessage(
                integration as WhatsAppIntegration, fila.wa_phone_number as string, final,
            );
        }

        if (!enviado.ok) {
            // Ventana cerrada en el acto (el último entrante estaba al borde):
            // la plantilla, una vez.
            if (esErrorDeVentana(enviado.error)) {
                const r = await avisarPorPlantilla(pago, fila.wa_phone_number as string, desenlace);
                await guardarAviso(idsReservados, previo.base, r);
                if (r.tipo === 'por_plantilla') avisados++;
                log?.info?.({ queueId: fila.id, paymentId: pago.id, aviso: r }, '[wa-outcome] texto rechazado por ventana');
                continue;
            }
            // Transitorio: se libera la reserva con espera, hasta MAX_INTENTOS.
            // Perder el aviso de que su plata quedó confirmada es peor que
            // repetirlo, pero reintentar para siempre cada minuto tampoco sirve.
            const sig = siguienteTrasFallo(intentosPrevios + 1, String(enviado.error ?? 'error'), ahora);
            if (sig.tipo === 'no_entregado') {
                await guardarAviso(idsReservados, previo.base, sig);
            } else {
                await supabase.from('whatsapp_inbound_queue')
                    .update({ outcome_notified_at: null, error_message: conAviso(previo.base, sig) })
                    .in('id', idsReservados)
                    .eq('outcome_notified_at', reservadaEn);
            }
            log?.warn?.({ queueId: fila.id, err: enviado.error, aviso: sig }, '[wa-outcome] no salió');
            continue;
        }

        if (conv?.id) {
            await supabase.rpc('wa_record_outbound_message', {
                p_conversation_id: conv.id,
                p_integration_id: fila.integration_id,
                p_wa_message_id: enviado.waMessageId || `local-${crypto.randomUUID()}`,
                p_type: tipo,
                p_text_body: final,
                p_payload: {
                    step: `resultado_${desenlace}`, queue_id: fila.id, payment_id: pago.id,
                    // `pregunta` es lo que miran preguntaAbierta y yaSePreguntoConsentimiento.
                    ...(consentimiento ? { pregunta: 'ask_consent' } : {}),
                    ...(tipo === 'interactive' ? { botones: consentimiento?.botones } : {}),
                },
                p_ai_generated: true,
                p_to_wa_id: fila.wa_phone_number,
            });
        }
        // Limpia un «reintento» anterior: ya salió.
        if (previo.aviso.tipo !== 'nuevo') await guardarAviso(idsReservados, previo.base, { tipo: 'nuevo' });

        avisados++;
        log?.info?.({ queueId: fila.id, paymentId: pago.id, estado: pago.status, desenlace }, '[wa-outcome] avisado');
    }

    return { avisados };
}

/**
 * El texto salió (Graph dijo 200) pero Meta lo rechazó después por ventana
 * cerrada (131047, por el webhook de estados: `whatsapp_messages.status =
 * 'failed'`). Se reintenta UNA vez por plantilla; si no hay, queda
 * «aviso_no_entregado». La toma es un UPDATE condicionado al `error_message`
 * leído: con los 3 BFF, solo uno manda.
 */
export async function reintentarAvisosFueraDeVentana(log?: Logger, ahora = Date.now()): Promise<number> {
    const desde = new Date(ahora - DIAS_BARRIDO * 86_400_000).toISOString();
    const { data: fallidos } = await supabase.from('whatsapp_messages')
        .select('payload, error_detail')
        .eq('direction', 'outbound')
        .eq('status', 'failed')
        .like('payload->>step', 'resultado_%')
        .gte('created_at', desde)
        .limit(200);
    const porPago = new Map<string, string>(); // payment_id → queue_id
    for (const m of (fallidos ?? []) as any[]) {
        if (!esErrorDeVentana(typeof m.error_detail === 'string' ? m.error_detail : JSON.stringify(m.error_detail ?? ''))) continue;
        const q = m.payload?.queue_id;
        const p = m.payload?.payment_id;
        if (q && p && !porPago.has(p)) porPago.set(p, q);
    }
    if (porPago.size === 0) return 0;

    let mandados = 0;
    for (const [paymentId, queueId] of porPago) {
        const { data: fila } = await supabase.from('whatsapp_inbound_queue')
            .select('id, wa_phone_number, error_message, created_at')
            .eq('id', queueId).maybeSingle();
        if (!fila) continue;
        const previo = separarAviso((fila as any).error_message);
        if (previo.aviso.tipo !== 'nuevo') continue; // ya se intentó (o se está intentando)

        const em = (fila as any).error_message as string | null;
        let toma = supabase.from('whatsapp_inbound_queue')
            .update({ error_message: conAviso(previo.base, { tipo: 'en_curso' }) })
            .eq('id', queueId);
        toma = em === null ? toma.is('error_message', null) : toma.eq('error_message', em);
        const { data: tomadas } = await toma.select('id');
        if (!tomadas?.length) continue;

        const pago = await leerPago(paymentId);
        const desenlace = pago ? desenlaceDelPago(pago, (fila as any).created_at) : null;
        const final: EstadoAviso = pago && desenlace
            ? await avisarPorPlantilla(pago, (fila as any).wa_phone_number, desenlace)
            : { tipo: 'no_entregado', motivo: 'ventana cerrada; el pago ya no está resuelto' };
        await guardarAviso([queueId], previo.base, final);
        if (final.tipo === 'por_plantilla') mandados++;
        log?.info?.({ queueId, paymentId, aviso: final }, '[wa-outcome] texto rechazado por ventana (webhook)');
    }
    return mandados;
}
