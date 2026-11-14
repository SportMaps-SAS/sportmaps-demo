/**
 * whatsapp-otro-concepto — el comprobante dice que NO es la mensualidad.
 *
 * Caso real (Dynasty, 2026-10-06, `bd8bd4d3` y `0a55af2d`): una foto con el pie
 * «Clase perfeccionamiento …» y otra anunciada con «mira aquí lo de los
 * uniformes», pagadas al Nequi de la profe, se aplicaron a «Mensualidad
 * $180.000». La escuela las rechazó (3 rechazos por familia) y la familia
 * recibió «no se pudo validar tu pago» por plata que sí había mandado.
 *
 * La regla: si el pie, la descripción del comprobante o lo que la familia
 * escribió alrededor de la foto nombra OTRO concepto (perfeccionamiento,
 * uniforme, torneo, viaje, rifa, inscripción, vacacional…), no se aplica a la
 * mensualidad. Si la familia tiene un cobro pendiente de ESE concepto y el
 * monto cuadra, va a ese; si no, lo registra la escuela («otro_concepto»).
 *
 * Todo lo de acá es puro (se prueba sin base) salvo `textosAlrededor`.
 */

import { supabase } from '../config/supabase';
import { normalizarFrase } from './whatsapp-reglas-turno';
import { resolverPago, type PagoPendiente } from './whatsapp-receipt-matching.service';
import { MOTIVO, type Motivo } from './motivos-de-cobro';

export type OtroConcepto =
    | 'clase_extra'
    | 'uniforme'
    | 'torneo'
    | 'viaje'
    | 'rifa'
    | 'inscripcion'
    | 'seguro'
    | 'vacacional'
    | 'clase_prueba';

/** Cómo se nombra cada concepto en el mensaje a la familia y en el motivo. */
export const NOMBRE_OTRO_CONCEPTO: Record<OtroConcepto, string> = {
    clase_extra: 'clase de perfeccionamiento',
    uniforme: 'uniforme',
    torneo: 'torneo',
    viaje: 'viaje',
    rifa: 'rifa',
    inscripcion: 'inscripción',
    seguro: 'seguro de accidentes',
    vacacional: 'vacacionales',
    clase_prueba: 'clase de prueba',
};

/** El motivo de cobro (`payment_category`) de cada concepto. La rifa no tiene categoría propia. */
export const MOTIVO_DE_OTRO_CONCEPTO: Record<OtroConcepto, Motivo | null> = {
    clase_extra: 'clase_extra',
    uniforme: 'articulos',
    torneo: 'torneo',
    viaje: 'viaje',
    rifa: null,
    inscripcion: 'inscripcion',
    seguro: 'seguro',
    vacacional: 'vacacional',
    clase_prueba: 'clase_prueba',
};

const palabras = (m: Motivo): RegExp => MOTIVO[m].palabrasClave as RegExp;

/**
 * Sobre texto ya normalizado (`normalizarFrase`: sin tildes, minúsculas, solo
 * letras y números). El orden importa: el primero que coincide gana. Las
 * palabras viven en el catálogo único (motivos-de-cobro.ts); desde 2026-10-30
 * se reconocen «clase de prueba / de cortesía» y «clínica» (clase_extra) en
 * todas las escuelas (decisión del plan B4).
 */
const PATRONES: [OtroConcepto, RegExp][] = [
    ['clase_prueba', palabras('clase_prueba')],
    ['vacacional', palabras('vacacional')],
    ['clase_extra', palabras('clase_extra')],
    ['uniforme', palabras('articulos')],
    ['torneo', palabras('torneo')],
    ['viaje', palabras('viaje')],
    ['rifa', /\b(rifas?|boletas?|bono(s)? (de la )?rifa)\b/],
    ['seguro', palabras('seguro')],
    ['inscripcion', palabras('inscripcion')],
];

/** Palabras que dicen «esto ES la mensualidad». */
const MENSUALIDAD = palabras('mensualidad');

/** El concepto (distinto de la mensualidad) que nombra un texto, o null. */
export function conceptoNombrado(texto: string | null | undefined): OtroConcepto | null {
    const t = normalizarFrase(texto);
    if (!t) return null;
    for (const [c, re] of PATRONES) if (re.test(t)) return c;
    return null;
}

/** ¿El texto nombra la mensualidad? */
export function nombraMensualidad(texto: string | null | undefined): boolean {
    return MENSUALIDAD.test(normalizarFrase(texto));
}

/** De qué concepto es un cobro, por su texto. null = mensualidad u otro sin clasificar. */
export function conceptoDelCobro(concept: string | null | undefined): OtroConcepto | null {
    if (nombraMensualidad(concept)) return null;
    return conceptoNombrado(concept);
}

/** `payments.payment_category` → el concepto que la familia nombra. Las demás categorías no tienen palabra propia. */
const CONCEPTO_DE_CATEGORIA: Record<string, OtroConcepto | null> = {
    mensualidad: null,
    inscripcion: 'inscripcion',
    seguro: 'seguro',
    articulos: 'uniforme',
    torneo: 'torneo',
    clase_extra: 'clase_extra',
    viaje: 'viaje',
    vacacional: 'vacacional',
    clase_prueba: 'clase_prueba',
};

/**
 * De qué concepto es un cobro pendiente. La categoría manda cuando se conoce
 * (2026-10-10): «Inscripción — PLAN RM MENSUAL — …» dice «mensual» en el
 * nombre del plan, y por el texto se leía como mensualidad. Sin categoría (o
 * 'otro', o una nueva sin palabra propia), por el texto como siempre.
 */
export function conceptoDePago(p: Pick<PagoPendiente, 'concept'> & { categoria?: string | null }): OtroConcepto | null {
    const cat = p.categoria ?? null;
    if (cat && cat !== 'otro' && cat in CONCEPTO_DE_CATEGORIA) return CONCEPTO_DE_CATEGORIA[cat];
    return conceptoDelCobro(p.concept);
}

export interface SenalOtroConcepto {
    concepto: OtroConcepto;
    /** De dónde salió: el pie y la descripción del comprobante son fuertes; el chat, débil. */
    fuente: 'pie' | 'descripcion' | 'chat';
    /** El texto que lo nombró, recortado (va al motivo que ve la escuela). */
    evidencia: string;
}

/**
 * ¿El comprobante es de otro concepto? Pura.
 *
 *  1. El pie de la foto y la descripción que escribió quien pagó (OCR) mandan:
 *     si nombran la mensualidad, es la mensualidad; si nombran otro concepto
 *     (y no la mensualidad), es ese.
 *  2. Si ninguno dice nada, cuenta lo que la familia escribió alrededor —sin
 *     las preguntas: «¿cuánto valen los uniformes?» junto al comprobante de la
 *     mensualidad no lo convierte en uniforme— y solo si ningún texto nombra
 *     la mensualidad.
 */
export function detectarOtroConcepto(e: {
    pie?: string | null;
    descripcion?: string | null;
    chat?: (string | null | undefined)[];
}): SenalOtroConcepto | null {
    const recorte = (s: string) => s.trim().replace(/\s+/g, ' ').slice(0, 80);

    for (const [fuente, texto] of [['pie', e.pie], ['descripcion', e.descripcion]] as const) {
        if (!texto || !texto.trim()) continue;
        if (nombraMensualidad(texto)) return null;
        const c = conceptoNombrado(texto);
        if (c) return { concepto: c, fuente, evidencia: recorte(texto) };
    }

    const chat = (e.chat ?? []).filter((t): t is string => !!t && !!t.trim() && !t.includes('?'));
    if (chat.some(nombraMensualidad)) return null;
    for (const t of chat) {
        const c = conceptoNombrado(t);
        // «Seguro» solo, en el chat, es «claro que sí»; en el pie de la foto sí cuenta.
        if (c === 'seguro' && normalizarFrase(t) === 'seguro') continue;
        if (c) return { concepto: c, fuente: 'chat', evidencia: recorte(t) };
    }
    return null;
}

export type DecisionOtroConcepto =
    /** No hay señal de otro concepto (o es débil y el monto cuadra con un cobro): flujo normal. */
    | { tipo: 'seguir' }
    /** Hay un cobro pendiente de ESE concepto por ese monto: se aplica a ese. */
    | { tipo: 'aplicar'; pago: PagoPendiente; senal: SenalOtroConcepto }
    /** No hay a qué aplicarlo: lo registra la escuela. */
    | { tipo: 'a_la_escuela'; senal: SenalOtroConcepto };

/**
 * Qué hacer con un comprobante según el concepto que nombra. Pura.
 *
 * Una señal SOLO del chat (no del pie ni del comprobante) cede ante un monto
 * que coincide exacto con un cobro pendiente: en una ráfaga de dos fotos
 * («la mensualidad» y «lo de los uniformes») el texto puede ser de la otra
 * foto, y el monto exacto es mejor prueba que la cercanía de un mensaje.
 */
export function decidirOtroConcepto(
    senal: SenalOtroConcepto | null,
    pendientes: PagoPendiente[],
    monto: number | null,
): DecisionOtroConcepto {
    if (!senal) return { tipo: 'seguir' };
    const delConcepto = pendientes.filter((p) => conceptoDePago(p) === senal.concepto);
    if (monto !== null) {
        const exactos = delConcepto.filter((p) => p.amount === monto);
        if (exactos.length === 1) return { tipo: 'aplicar', pago: exactos[0], senal };
        // Una transferencia por varios cobros que INCLUYE el nombrado (pie
        // «inscripción» y $515.000 = mensualidad + inscripción + seguro): no es
        // «otro concepto» sin cobro, es el pago de varios. Sigue el flujo normal,
        // que con una única combinación lo pasa a la escuela para repartirlo.
        if (delConcepto.length) {
            const m = resolverPago(pendientes, monto);
            if (m.tipo === 'combinacion' && m.pagos.some((p) => conceptoDePago(p) === senal.concepto)) {
                return { tipo: 'seguir' };
            }
        }
    }
    if (senal.fuente === 'chat' && monto !== null) {
        const cualquiera = pendientes.filter((p) => p.amount === monto);
        if (cualquiera.length > 0 && delConcepto.length === 0) return { tipo: 'seguir' };
    }
    return { tipo: 'a_la_escuela', senal };
}

/**
 * El nombre de la señal: la clínica es `clase_extra`, pero a la familia que
 * escribió «clínica» no se le dice «clase de perfeccionamiento». Pura.
 */
export function nombreDeSenal(s: Pick<SenalOtroConcepto, 'concepto' | 'evidencia'>): string {
    if (s.concepto === 'clase_extra' && /\bclinicas?\b/.test(normalizarFrase(s.evidencia))) return 'clínica';
    return NOMBRE_OTRO_CONCEPTO[s.concepto];
}

/** Motivo que queda en `error_message` (la pantalla «Comprobantes sin resolver» lo muestra). */
export function motivoOtroConcepto(s: SenalOtroConcepto): string {
    return `otro_concepto: ${nombreDeSenal(s)} (${s.fuente}: «${s.evidencia}»)`.slice(0, 500);
}

/** Lo que se le dice a la familia: honesto, sin prometer aplicarlo a nada. */
export function mensajeOtroConcepto(s: SenalOtroConcepto): string {
    return `Recibí tu comprobante de *${nombreDeSenal(s)}* 📄 ` +
        'Se lo paso a la escuela para que lo registre; no lo apliqué a la mensualidad.';
}

/**
 * Lo que la familia escribió alrededor de la foto (entrantes de −15 a +5 min,
 * la misma ventana que la pista del cobro del worker). Sin el pie: ese va
 * aparte porque pesa más. Si falla, lista vacía.
 */
export async function textosAlrededor(fila: {
    integration_id: string; wa_phone_number: string; created_at?: string | null;
}): Promise<string[]> {
    try {
        const { data: conv } = await supabase.from('whatsapp_conversations')
            .select('id').eq('integration_id', fila.integration_id).eq('contact_wa_id', fila.wa_phone_number)
            .maybeSingle();
        const convId = (conv as any)?.id;
        if (!convId) return [];
        const base = fila.created_at ? new Date(fila.created_at).getTime() : Date.now();
        const { data } = await supabase.from('whatsapp_messages')
            .select('text_body, created_at')
            .eq('conversation_id', convId)
            .eq('direction', 'inbound')
            .gte('created_at', new Date(base - 15 * 60_000).toISOString())
            .lte('created_at', new Date(base + 5 * 60_000).toISOString())
            .limit(30);
        return ((Array.isArray(data) ? data : []) as any[])
            .map((m) => m?.text_body).filter((t): t is string => typeof t === 'string' && !!t.trim());
    } catch {
        return [];
    }
}
