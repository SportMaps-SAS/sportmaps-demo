/**
 * Qué es cada cobro en Gestión de Pagos (blindaje de ventas de servicio §4.D,
 * 2026-11-08). Pedido del dueño: «separar e identificar cuando son pagos por
 * torneos, clínicas, clases de cortesía, mensualidades, inscripción en ese
 * panel, así no hay enredo».
 *
 * Fuentes, en este orden:
 *  1. `payments.payment_category` (catálogo único: `motivosDeCobro.ts`). Manda
 *     cuando viene: un cobro marcado 'torneo' es torneo aunque el concepto diga
 *     otra cosa.
 *  2. El concepto, para lo que la categoría no distingue: la clínica viaja como
 *     'clase_extra' (es el tipo «Clase extra / clínica» del catálogo de
 *     servicios), y las filas viejas llegan con categoría NULL.
 *  3. El formato de los cobros de servicio creados por el bot y por «Clase de
 *     prueba»: «<Nombre del servicio> — <Nombre de quien asiste>» (raya larga
 *     con espacios). De ahí salen el nombre del servicio y el de quien asiste.
 *
 * SOLO PARA MOSTRAR Y FILTRAR. No decide reglas de dinero (para eso está
 * `isOneTimeCategory` en payment-accounts) ni toca totales.
 */
import { chargeCategoryOf } from '@/lib/payment-accounts';
import { ETIQUETA_MOTIVO, esMotivoDeCobro } from '@/lib/motivosDeCobro';

export type ClaveTipoDeCobro =
    | 'mensualidad'
    | 'inscripcion'
    | 'clase_prueba'
    | 'clinica'
    | 'clase_extra'
    | 'torneo'
    | 'vacacional'
    | 'articulos'
    | 'seguro'
    | 'viaje'
    | 'excedente'
    | 'reserva'
    | 'otro';

export interface TipoDeCobro {
    clave: ClaveTipoDeCobro;
    /** Lo que dice la insignia: «Clínica», «Inscripción / Matrícula»… */
    etiqueta: string;
    /** Clases de Tailwind de la insignia (fondo, texto y borde, claro y oscuro). */
    color: string;
    /**
     * Nombre del servicio sacado del concepto («Clínica de armadores y
     * atacantes»), o null si el concepto no lo trae o solo repite la etiqueta.
     */
    servicio: string | null;
}

/** Lo mínimo que se necesita de una fila de `payments` para clasificarla. */
export interface CobroParaTipo {
    payment_category?: string | null;
    concept?: string | null;
}

/** Lo mínimo para saber a nombre de quién va el cobro. */
export interface CobroParaNombre extends CobroParaTipo {
    child_id?: string | null;
    user_id?: string | null;
    parent_id?: string | null;
    unregistered_athlete_id?: string | null;
    signup_lead_id?: string | null;
    /** Nombre ya resuelto por la pantalla (deportista, cuenta o sin cuenta). */
    athlete_name?: string | null;
}

/** Orden en el filtro: lo de todos los meses primero, «Otro» al final. */
export const ORDEN_TIPOS_DE_COBRO: readonly ClaveTipoDeCobro[] = [
    'mensualidad', 'inscripcion', 'clase_prueba', 'clinica', 'clase_extra', 'torneo',
    'vacacional', 'articulos', 'seguro', 'viaje', 'excedente', 'reserva', 'otro',
];

/** Etiqueta de cada tipo (la del filtro; la insignia puede afinarla, p. ej. «Clase de cortesía»). */
export const ETIQUETA_TIPO_DE_COBRO: Record<ClaveTipoDeCobro, string> = {
    mensualidad: 'Mensualidad',
    inscripcion: 'Inscripción / Matrícula',
    clase_prueba: 'Clase de prueba',
    clinica: 'Clínica',
    clase_extra: 'Clase extra',
    torneo: 'Torneo',
    vacacional: 'Vacacional',
    articulos: 'Uniformes / Artículos',
    seguro: 'Seguro',
    viaje: 'Viaje',
    excedente: 'Horas adicionales',
    reserva: 'Reserva',
    otro: 'Otro',
};

/**
 * La mensualidad va neutra a propósito: es la gran mayoría de las filas, y así
 * lo que no es de todos los meses (clínica, torneo, clase de prueba) salta a la vista.
 */
export const COLOR_TIPO_DE_COBRO: Record<ClaveTipoDeCobro, string> = {
    mensualidad: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700',
    inscripcion: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800',
    clase_prueba: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-800',
    clinica: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-950/40 dark:text-fuchsia-300 dark:border-fuchsia-800',
    clase_extra: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-800',
    torneo: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
    vacacional: 'bg-lime-50 text-lime-800 border-lime-200 dark:bg-lime-950/40 dark:text-lime-300 dark:border-lime-800',
    articulos: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-800',
    seguro: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800',
    viaje: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800',
    excedente: 'bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-300 dark:border-yellow-800',
    reserva: 'bg-stone-50 text-stone-700 border-stone-200 dark:bg-stone-900/40 dark:text-stone-300 dark:border-stone-700',
    otro: 'bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-900/40 dark:text-gray-300 dark:border-gray-700',
};

/** Separador de los conceptos de servicio: raya larga con espacios. */
const SEPARADOR = ' — ';

const normalizar = (s: string): string =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** «Clínica de armadores — Nicolás» → { antes: 'Clínica de armadores', despues: 'Nicolás' }. */
function partirConcepto(concept: string | null | undefined): { antes: string; despues: string | null } {
    const c = String(concept ?? '').trim();
    const i = c.indexOf(SEPARADOR);
    if (i < 0) return { antes: c, despues: null };
    const despues = c.slice(i + SEPARADOR.length).trim();
    return { antes: c.slice(0, i).trim(), despues: despues || null };
}

const nombraClinica = (texto: string) => /clinica/.test(texto);
const nombraCortesia = (texto: string) => /cortesia/.test(texto);

/** Categoría por concepto, para filas sin categoría (o 'otro'). */
function claveDesdeConcepto(texto: string): ClaveTipoDeCobro | null {
    if (/clase de (prueba|cortesia)/.test(texto)) return 'clase_prueba';
    if (nombraClinica(texto)) return 'clinica';
    // Antes que la inscripción: «Inscripción torneo» es plata del torneo.
    if (/torneo/.test(texto)) return 'torneo';
    if (/vacacional/.test(texto)) return 'vacacional';
    if (/\bviaje\b/.test(texto)) return 'viaje';
    if (/horas? adicional/.test(texto)) return 'excedente';
    return null;
}

function claveDeCobro(p: CobroParaTipo): ClaveTipoDeCobro {
    const cat = p.payment_category ?? null;
    const texto = normalizar(String(p.concept ?? ''));

    if (cat && cat !== 'otro') {
        if (cat === 'clase_extra') return nombraClinica(texto) ? 'clinica' : 'clase_extra';
        // Una categoría que el front aún no conoce (futura del CHECK) no se
        // disfraza de mensualidad: cae en «Otro» con su concepto a la vista.
        return esMotivoDeCobro(cat) ? cat : 'otro';
    }
    // Sin categoría o 'otro': el concepto puede decir qué es.
    const porConcepto = claveDesdeConcepto(texto);
    if (porConcepto) return porConcepto;
    const vieja = chargeCategoryOf(cat, p.concept);
    if (vieja) return vieja;
    // NULL sin pistas = mensualidad (las del cron nacen así); 'otro' sin pistas = otro.
    return cat === 'otro' ? 'otro' : 'mensualidad';
}

/** Etiquetas genéricas que, como «servicio», no dicen nada nuevo («Inscripción — Ana»). */
const GENERICOS = new Set(
    [...Object.values(ETIQUETA_MOTIVO), ...Object.values(ETIQUETA_TIPO_DE_COBRO), 'Matrícula', 'Clase de cortesía', 'Cobro', 'Pago']
        .map(normalizar),
);

/**
 * Nombre del servicio para la insignia. Quita el prefijo que repite la
 * etiqueta seguido de un separador («Torneo · Mayores» → «Mayores») para no
 * pintar «Torneo · Torneo · Mayores»; «Clínica de armadores…» se deja entero
 * porque ahí la palabra es parte del nombre.
 */
function servicioDe(clave: ClaveTipoDeCobro, etiqueta: string, concept: string | null | undefined): string | null {
    if (clave === 'mensualidad') return null;
    const { antes, despues } = partirConcepto(concept);
    if (despues === null || !antes) return null;
    let nombre = antes;
    const conPrefijo = /^([^·:]+?)\s*[·:]\s*(.+)$/.exec(antes);
    if (conPrefijo) {
        const prefijo = normalizar(conPrefijo[1]);
        const raices = etiqueta.split(' / ').map(normalizar);
        if (raices.some((r) => prefijo === r || prefijo === `${r}s`)) nombre = conPrefijo[2].trim();
    }
    if (!nombre || GENERICOS.has(normalizar(nombre))) return null;
    return nombre;
}

/** Qué es el cobro: clave para filtrar, etiqueta y color de la insignia, y el servicio si lo hay. */
export function tipoDeCobro(p: CobroParaTipo): TipoDeCobro {
    const clave = claveDeCobro(p);
    let etiqueta = ETIQUETA_TIPO_DE_COBRO[clave];
    if (clave === 'clase_prueba' && nombraCortesia(normalizar(String(p.concept ?? '')))) etiqueta = 'Clase de cortesía';
    return { clave, etiqueta, color: COLOR_TIPO_DE_COBRO[clave], servicio: servicioDe(clave, etiqueta, p.concept) };
}

/** «Clínica · Clínica de armadores y atacantes», o solo la etiqueta. */
export const textoDeTipo = (t: TipoDeCobro): string => (t.servicio ? `${t.etiqueta} · ${t.servicio}` : t.etiqueta);

/** Etiqueta de una clave en el filtro (incluye «cortesía», que comparte clave con la clase de prueba). */
export const etiquetaDeFiltro = (clave: string): string =>
    clave === 'clase_prueba'
        ? 'Clase de prueba / cortesía'
        : ETIQUETA_TIPO_DE_COBRO[clave as ClaveTipoDeCobro] ?? clave;

/**
 * A nombre de quién va el cobro.
 *  - `nombre`: el que ya resolvió la pantalla (deportista, cuenta o sin
 *    cuenta); si el cobro no tiene a nadie del club (prospecto), lo que va
 *    después de « — » en el concepto. Así la clínica de un externo dice
 *    «Nicolás Cubides» y no «Sin nombre». null si no hay forma de saberlo.
 *  - `externo`: viene de un prospecto (`signup_lead_id`) y no es deportista
 *    del club (sin `child_id` ni `unregistered_athlete_id`).
 */
export function nombreDeQuienAsiste(p: CobroParaNombre): { nombre: string | null; externo: boolean } {
    const esDelClub = !!(p.child_id || p.unregistered_athlete_id);
    const externo = !!p.signup_lead_id && !esDelClub;
    const yaResuelto = String(p.athlete_name ?? '').trim();
    if (yaResuelto) return { nombre: yaResuelto, externo };
    const tieneCuenta = esDelClub || !!(p.user_id || p.parent_id);
    if (tieneCuenta) return { nombre: null, externo };
    return { nombre: partirConcepto(p.concept).despues, externo };
}

/** Conteo por clave, en el orden del filtro, sin las que no aparecen. */
export function contarPorTipo<T extends CobroParaTipo>(cobros: readonly T[]): Partial<Record<ClaveTipoDeCobro, number>> {
    const acc: Partial<Record<ClaveTipoDeCobro, number>> = {};
    for (const c of cobros) {
        const k = tipoDeCobro(c).clave;
        acc[k] = (acc[k] ?? 0) + 1;
    }
    return acc;
}
