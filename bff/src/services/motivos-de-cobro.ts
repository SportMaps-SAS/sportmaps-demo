/**
 * motivos-de-cobro — EL catálogo de motivos de cobro (`payments.payment_category`).
 *
 * Por qué existe (plan B4, docs/specs/whatsapp-monster-plan-B4.md §1, 2026-10-30):
 * había 12 listas de motivos que no coincidían. `categoriaDeCobro('clase_prueba')`
 * daba null (las llaves restringidas y el contexto del veredicto no la conocían),
 * el zod de /extract-receipt rechazaba con 400 un `clase_prueba` que mandaba la
 * app y el rótulo corto de la clase de prueba salía «Clase», igual que el de la
 * clase extra. Ahora las listas del BFF (tipo-de-cobro, payment-accounts,
 * whatsapp-otro-concepto, ventas-servicios, el zod de payments.routes) DERIVAN de
 * acá, con los mismos nombres de export y las mismas salidas de hoy (pruebas de
 * caracterización). El frontend tiene su espejo (`frontend/src/lib/motivosDeCobro.ts`)
 * y la prueba de contrato fija: claves = último CHECK de `payments` = espejo.
 *
 * Decisión (plan B4 §1): NO hay motivo `evento`. Una clínica es `clase_extra`
 * con su nombre en el concepto («Clínica de armadores — Mariana»).
 *
 * Puro: sin base, sin red.
 */

/** Las claves del CHECK `payments_payment_category_check`, en su orden (20261029215003). */
export const CLAVES_MOTIVO = [
    'mensualidad', 'inscripcion', 'articulos', 'torneo', 'otro', 'seguro',
    'excedente', 'clase_extra', 'vacacional', 'viaje', 'reserva', 'clase_prueba',
] as const;

export type Motivo = (typeof CLAVES_MOTIVO)[number];

export interface DefinicionMotivo {
    clave: Motivo;
    /** Nombre singular para la familia («Seguro de accidentes»). Igual que CHARGE_CATEGORY_LABEL del frontend. */
    etiqueta: string;
    /** ≤ 9 caracteres y única: rótulo de un botón de WhatsApp (el título se corta en 20). */
    corta: string;
    /** Plural en minúscula para mensajes («inscripciones y torneos»). */
    plural: string;
    /**
     * Cómo lo nombra la familia, sobre texto ya normalizado (`normalizarFrase`:
     * sin tildes, minúsculas, solo letras y números). null = sin palabra propia.
     */
    palabrasClave: RegExp | null;
    /** Se vende como ítem del catálogo de servicios (`school_tournament_items.kind`). */
    seCobraPorItem: boolean;
}

export const MOTIVOS: readonly DefinicionMotivo[] = [
    {
        clave: 'mensualidad', etiqueta: 'Mensualidad', corta: 'Mensual.', plural: 'mensualidades',
        palabrasClave: /\b(mensualidad(es)?|mensual|cuota del mes|pension|plan pro|plan basico)\b/,
        seCobraPorItem: false,
    },
    {
        clave: 'inscripcion', etiqueta: 'Inscripción', corta: 'Inscrip.', plural: 'inscripciones',
        palabrasClave: /\b(inscripcion|matricula)\b/,
        seCobraPorItem: false,
    },
    {
        clave: 'articulos', etiqueta: 'Artículos', corta: 'Artículos', plural: 'artículos',
        palabrasClave: /\b(uniformes?|camiseta(s)?|sudadera(s)?|pantaloneta(s)?|licra(s)?|chaqueta(s)?|dotacion|kit)\b/,
        seCobraPorItem: false,
    },
    {
        clave: 'torneo', etiqueta: 'Torneo', corta: 'Torneo', plural: 'torneos',
        palabrasClave: /\b(torneos?|campeonatos?|copa|festival|inscripcion (al|del|de la) (torneo|copa|campeonato))\b/,
        seCobraPorItem: true,
    },
    { clave: 'otro', etiqueta: 'Otro cobro', corta: 'Otro', plural: 'otros cobros', palabrasClave: null, seCobraPorItem: true },
    {
        clave: 'seguro', etiqueta: 'Seguro de accidentes', corta: 'Seguro', plural: 'seguros',
        // «Seguro» suelto es también «seguro que ya pagué»: cuenta solo como el pie
        // entero, o con lo que lo hace un cobro (de accidentes, póliza, «el seguro»).
        palabrasClave: /(^seguro$|\bseguro (de |del |contra )?(accidente|accidentes|deportivo|estudiantil|medico)\b|\bpolizas?\b|\b(pago|pague|abono|valor|cuota|el|del) seguro\b)/,
        seCobraPorItem: false,
    },
    { clave: 'excedente', etiqueta: 'Horas adicionales', corta: 'Horas', plural: 'horas adicionales', palabrasClave: null, seCobraPorItem: false },
    {
        clave: 'clase_extra', etiqueta: 'Clase extra', corta: 'Clase', plural: 'clases extra',
        // La clínica es clase_extra (Monster 2026-10-30: «Clínica de armadores y atacantes»).
        palabrasClave: /\b(perfeccionamiento|refuerzo|clinicas?|clases? (extra|adicional(es)?|suelta|sueltas|particular(es)?|personalizada(s)?|privada(s)?)|clases? de (hoy|manana|ayer))\b/,
        seCobraPorItem: true,
    },
    {
        clave: 'vacacional', etiqueta: 'Vacacional', corta: 'Vacac.', plural: 'vacacionales',
        palabrasClave: /\b(vacacional(es)?|curso de vacaciones|plan vacaciones)\b/,
        seCobraPorItem: true,
    },
    {
        clave: 'viaje', etiqueta: 'Viaje', corta: 'Viaje', plural: 'viajes',
        palabrasClave: /\b(viajes?|tiquetes?|pasajes?|transporte|hotel|hospedaje|excursion)\b/,
        seCobraPorItem: true,
    },
    { clave: 'reserva', etiqueta: 'Reserva', corta: 'Reserva', plural: 'reservas', palabrasClave: null, seCobraPorItem: false },
    {
        clave: 'clase_prueba', etiqueta: 'Clase de prueba', corta: 'Prueba', plural: 'clases de prueba',
        palabrasClave: /\bclases? de (prueba|cortesia)\b/,
        seCobraPorItem: false,
    },
];

/** El motivo por su clave. */
export const MOTIVO = Object.fromEntries(MOTIVOS.map((m) => [m.clave, m])) as Record<Motivo, DefinicionMotivo>;

export function esMotivo(v: unknown): v is Motivo {
    return typeof v === 'string' && (CLAVES_MOTIVO as readonly string[]).includes(v);
}

/** `{clave: valor}` de una propiedad de cada motivo, en el orden del catálogo. */
export function mapaDeMotivos<K extends keyof DefinicionMotivo>(prop: K): Record<Motivo, DefinicionMotivo[K]> {
    return Object.fromEntries(MOTIVOS.map((m) => [m.clave, m[prop]])) as Record<Motivo, DefinicionMotivo[K]>;
}

/** Solo acepta claves del catálogo y conserva los literales. */
const soloMotivos = <T extends readonly Motivo[]>(t: T): T => t;

/** Lo que se vende como ítem del catálogo de servicios = CHECK `school_tournament_items_kind_chk`. */
export const MOTIVOS_DE_SERVICIO = soloMotivos(['torneo', 'viaje', 'clase_extra', 'vacacional', 'otro'] as const);
