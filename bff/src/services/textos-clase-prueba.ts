/**
 * textos-clase-prueba — cómo se llama la clase de prueba de cada escuela y si
 * se cobra, para que el bot nunca diga «gratis» cuando no lo es.
 *
 * POR QUÉ EXISTE (Monster, 2026-10-30)
 * El bot nació con Dynasty, donde la clase es una «clase de cortesía» gratis,
 * y esas dos palabras quedaron escritas en todos los mensajes (la oferta, la
 * confirmación, «La clase es *gratis*» después de las indicaciones, el prompt
 * del modelo). Monster cobra la clase de prueba ($15.000) y la llama así.
 * Decisión del plan (spec §8, punto 4): si la escuela cobra la clase
 * (`school_trial_class_settings.trial_price > 0`), el bot NUNCA dice «gratis»
 * ni «cortesía», en ninguna escuela.
 *
 * CÓMO QUEDA PARA LAS DEMÁS
 *   nombre_clase NULL o 'cortesia' y trial_price NULL/0 → los literales de
 *   siempre, letra por letra (prueba «golden» en textos-clase-prueba.test.ts).
 *   nombre_clase = 'prueba' → «clase de prueba» (gratis si no hay valor).
 *   trial_price > 0 → «clase de prueba» con su valor, aunque diga 'cortesia'.
 *
 * Lo de arriba es PURO. Abajo, la lectura por escuela (cacheada 10 min) que
 * usan la clase de cortesía y el prompt del prospecto cuando quien llama no
 * les pasa los textos ya resueltos.
 */

import { supabase } from '../config/supabase';

export type TipoClase = 'cortesia' | 'prueba';

/** Las dos columnas de `school_trial_class_settings` que deciden el texto. */
export interface AjustesTextosClase {
    nombre_clase?: string | null;
    trial_price?: number | string | null;
}

export interface TextosClase {
    tipo: TipoClase;
    /** «clase de cortesía» | «clase de prueba» (para el medio de una frase). */
    nombre: string;
    /** «Clase de cortesía» | «Clase de prueba» (para empezar una línea). */
    nombreInicial: string;
    /** false si la escuela cobra la clase: entonces jamás «gratis» ni «cortesía». */
    gratis: boolean;
    /** «$15.000»; null si es gratis. */
    precio: string | null;
}

/** 15000 → «$15.000». */
export function formatoPesos(v: number): string {
    return `$${Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

export function textosDeClase(a: AjustesTextosClase | null | undefined = {}): TextosClase {
    const valor = Number(a?.trial_price ?? 0);
    const cobra = Number.isFinite(valor) && valor > 0;
    const tipo: TipoClase = cobra || String(a?.nombre_clase ?? '').trim() === 'prueba' ? 'prueba' : 'cortesia';
    const nombre = tipo === 'prueba' ? 'clase de prueba' : 'clase de cortesía';
    return {
        tipo,
        nombre,
        nombreInicial: nombre[0].toUpperCase() + nombre.slice(1),
        gratis: !cobra,
        precio: cobra ? formatoPesos(valor) : null,
    };
}

/** Los textos de siempre (Dynasty): clase de cortesía, gratis. */
export const TEXTOS_POR_DEFECTO: TextosClase = Object.freeze(textosDeClase({})) as TextosClase;

// ─── Frases (puras). Con los textos por defecto dan los literales de siempre. ──

/** «¡Claro! 🙌 La *clase de cortesía* es *gratis* y sirve para conocer la escuela.» */
export function presentacionDeClase(t: TextosClase = TEXTOS_POR_DEFECTO): string {
    return t.gratis
        ? `¡Claro! 🙌 La *${t.nombre}* es *gratis* y sirve para conocer la escuela.`
        : `¡Claro! 🙌 La *${t.nombre}* tiene un valor de *${t.precio}* y sirve para conocer la escuela.`;
}

/** «¿Te reservo una *clase de cortesía* gratis?» */
export function ofertaDeReserva(t: TextosClase = TEXTOS_POR_DEFECTO): string {
    return t.gratis ? `¿Te reservo una *${t.nombre}* gratis?` : `¿Te reservo una *${t.nombre}* (*${t.precio}*)?`;
}

/**
 * El valor al final de las indicaciones de llegada:
 *   'la_clase' → «La clase es *gratis*.» | «La clase tiene un valor de *$15.000*.»
 *   'es'       → «Es *gratis*.»          | «Tiene un valor de *$15.000*.»
 */
export function fraseDeValor(t: TextosClase = TEXTOS_POR_DEFECTO, forma: 'la_clase' | 'es' = 'la_clase'): string {
    if (t.gratis) return forma === 'la_clase' ? 'La clase es *gratis*.' : 'Es *gratis*.';
    return forma === 'la_clase' ? `La clase tiene un valor de *${t.precio}*.` : `Tiene un valor de *${t.precio}*.`;
}

/**
 * Línea para un prompt del modelo cuando la clase NO es la cortesía gratis de
 * siempre. Vacía con los textos por defecto (el prompt queda igual).
 */
export function reglaDeClaseParaPrompt(t: TextosClase = TEXTOS_POR_DEFECTO): string {
    if (t.tipo === 'cortesia' && t.gratis) return '';
    if (!t.gratis) {
        return `La ${t.nombre} tiene un valor de *${t.precio}*: nunca digas que es gratis ni la llames «clase de cortesía».`;
    }
    return `Llámala siempre «${t.nombre}», nunca «clase de cortesía».`;
}

// ─── Supabase (cacheado) ───────────────────────────────────────────────────

export const TTL_TEXTOS_MS = 10 * 60 * 1000;
const cache = new Map<string, { en: number; textos: TextosClase }>();

export function limpiarCacheTextosClase(): void {
    cache.clear();
}

/**
 * Los textos de la escuela, leídos de `school_trial_class_settings`.
 * `nombre_clase` llega con la migración M1: sin ella se lee solo `trial_price`
 * (que ya existe). Sin fila, con error o sin base → los de siempre. Nunca lanza.
 */
export async function textosClaseDeEscuela(schoolId: string, ahora = Date.now()): Promise<TextosClase> {
    const c = cache.get(schoolId);
    if (c && ahora - c.en < TTL_TEXTOS_MS) return c.textos;
    try {
        let r: any = await supabase.from('school_trial_class_settings')
            .select('nombre_clase, trial_price').eq('school_id', schoolId).maybeSingle();
        if (r?.error && (r.error.code === '42703' || /nombre_clase/.test(String(r.error.message ?? '')))) {
            r = await supabase.from('school_trial_class_settings')
                .select('trial_price').eq('school_id', schoolId).maybeSingle();
        }
        if (!r || r.error) return TEXTOS_POR_DEFECTO;
        const textos = textosDeClase(r.data ?? {});
        if (cache.size > 1000) cache.clear();
        cache.set(schoolId, { en: ahora, textos });
        return textos;
    } catch {
        return TEXTOS_POR_DEFECTO;
    }
}
