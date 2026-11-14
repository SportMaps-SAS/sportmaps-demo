/**
 * Catálogo ÚNICO de motivos de cobro del frontend (plan B4 §3, T5).
 *
 * Espejo de `MOTIVOS` del BFF (bff/src/services/motivos-de-cobro.ts) y de las
 * 12 claves del CHECK vivo `payments_payment_category_check` (migración
 * 20261029215003_cobro_clase_prueba). Antes había listas sueltas que no
 * coincidían (L8 PaymentCheckoutModal, L9 payment-accounts, L10 «Registrar
 * pago»): un cobro 'clase_prueba' salía con su clave cruda en el filtro de
 * Pagos y el modal del acudiente cobraba toda clínica o viaje como 'torneo'.
 * Ahora todas derivan de aquí.
 *
 * Si se agrega una categoría al CHECK, va aquí y en el BFF: la prueba
 * `motivosDeCobro.test.ts` compara estas claves con la última migración que
 * redefine el CHECK.
 */

/** Las 12 claves, en el orden del CHECK (el orden de `CHARGE_CATEGORIES`). */
export const CLAVES_MOTIVO = [
    'mensualidad', 'inscripcion', 'articulos', 'torneo', 'otro', 'seguro',
    'excedente', 'clase_extra', 'vacacional', 'viaje', 'reserva', 'clase_prueba',
] as const;
export type MotivoDeCobro = (typeof CLAVES_MOTIVO)[number];

export interface DefinicionMotivo {
    clave: MotivoDeCobro;
    /** Nombre del cobro («Seguro de accidentes»). = ETIQUETA_CATEGORIA del BFF. */
    etiqueta: string;
    /** ≤ 9 caracteres y única: rótulo de un botón de WhatsApp («Inscrip.», «Prueba»). = CORTA del BFF. */
    corta: string;
    /** Plural en minúscula para mensajes («inscripciones y torneos»). = NOMBRE_CATEGORIA del BFF. */
    plural: string;
    /**
     * true solo para la mensualidad: ocupa el cupo de su mes
     * (`uniq_payment_active_period_*`). Todo lo demás es un cobro único y va
     * con `period_uniqueness_exempt = true`, igual que lo fuerza el servidor
     * para los cobros que crea la familia (S4, 20261010145241).
     */
    ocupaPeriodo: boolean;
    /**
     * ¿El acudiente lo puede elegir al crear un pago en la app
     * (PaymentCheckoutModal)? Seguro, horas adicionales, reserva y clase de
     * prueba no: los crea la escuela (o el prospecto, atado a su
     * `signup_lead_id`) y la familia los paga como cobro existente.
     */
    enSubidaAcudiente: boolean;
    /** ¿Se ofrece en «Registrar pago» / «+ Nuevo cobro» de la escuela? */
    enRegistroManual: boolean;
    /** Texto en «Registrar pago» cuando no es la etiqueta («Seguro», «Artículos / uniformes»). */
    etiquetaManual?: string;
    /**
     * Si es un tipo del catálogo de servicios (`school_tournament_items.kind`,
     * CHECK de 20261007095911): cómo se llama en el editor (`tipo`) y como grupo
     * en el modal del acudiente (`grupo`). null = no se vende como servicio.
     */
    servicio: { tipo: string; grupo: string } | null;
}

/** El catálogo, en el orden del CHECK. */
export const MOTIVOS: readonly DefinicionMotivo[] = [
    { clave: 'mensualidad', etiqueta: 'Mensualidad', corta: 'Mensual.', plural: 'mensualidades', ocupaPeriodo: true, enSubidaAcudiente: true, enRegistroManual: true, servicio: null },
    { clave: 'inscripcion', etiqueta: 'Inscripción', corta: 'Inscrip.', plural: 'inscripciones', ocupaPeriodo: false, enSubidaAcudiente: true, enRegistroManual: true, servicio: null },
    { clave: 'articulos', etiqueta: 'Artículos', corta: 'Artículos', plural: 'artículos', ocupaPeriodo: false, enSubidaAcudiente: true, enRegistroManual: true, etiquetaManual: 'Artículos / uniformes', servicio: null },
    { clave: 'torneo', etiqueta: 'Torneo', corta: 'Torneo', plural: 'torneos', ocupaPeriodo: false, enSubidaAcudiente: true, enRegistroManual: true, servicio: { tipo: 'Torneo', grupo: 'Torneos' } },
    { clave: 'otro', etiqueta: 'Otro cobro', corta: 'Otro', plural: 'otros cobros', ocupaPeriodo: false, enSubidaAcudiente: true, enRegistroManual: true, servicio: { tipo: 'Otro', grupo: 'Otros servicios' } },
    { clave: 'seguro', etiqueta: 'Seguro de accidentes', corta: 'Seguro', plural: 'seguros', ocupaPeriodo: false, enSubidaAcudiente: false, enRegistroManual: true, etiquetaManual: 'Seguro', servicio: null },
    { clave: 'excedente', etiqueta: 'Horas adicionales', corta: 'Horas', plural: 'horas adicionales', ocupaPeriodo: false, enSubidaAcudiente: false, enRegistroManual: true, servicio: null },
    { clave: 'clase_extra', etiqueta: 'Clase extra', corta: 'Clase', plural: 'clases extra', ocupaPeriodo: false, enSubidaAcudiente: true, enRegistroManual: true, servicio: { tipo: 'Clase extra / clínica', grupo: 'Clases extra y clínicas' } },
    { clave: 'vacacional', etiqueta: 'Vacacional', corta: 'Vacac.', plural: 'vacacionales', ocupaPeriodo: false, enSubidaAcudiente: true, enRegistroManual: true, servicio: { tipo: 'Vacacional', grupo: 'Vacacionales' } },
    { clave: 'viaje', etiqueta: 'Viaje', corta: 'Viaje', plural: 'viajes', ocupaPeriodo: false, enSubidaAcudiente: true, enRegistroManual: true, servicio: { tipo: 'Viaje', grupo: 'Viajes' } },
    // Reservas de instalaciones: las crea su módulo, nunca «Registrar pago».
    { clave: 'reserva', etiqueta: 'Reserva', corta: 'Reserva', plural: 'reservas', ocupaPeriodo: false, enSubidaAcudiente: false, enRegistroManual: false, servicio: null },
    // Clase de prueba: va atada al prospecto (`payments.signup_lead_id`) y la
    // cobra «Clase de prueba» (registrar_pago_clase_prueba) o el bot. Creada
    // desde «Registrar pago» o desde el modal del acudiente quedaría suelta y la
    // escuela vería la clase sin pagar.
    { clave: 'clase_prueba', etiqueta: 'Clase de prueba', corta: 'Prueba', plural: 'clases de prueba', ocupaPeriodo: false, enSubidaAcudiente: false, enRegistroManual: false, servicio: null },
];

const POR_CLAVE: Record<MotivoDeCobro, DefinicionMotivo> =
    Object.fromEntries(MOTIVOS.map((m) => [m.clave, m])) as Record<MotivoDeCobro, DefinicionMotivo>;

export const esMotivoDeCobro = (v: unknown): v is MotivoDeCobro =>
    typeof v === 'string' && (CLAVES_MOTIVO as readonly string[]).includes(v);

export const definicionDeMotivo = (clave: MotivoDeCobro): DefinicionMotivo => POR_CLAVE[clave];

/** Nombre de cada motivo. Es `CHARGE_CATEGORY_LABEL`. */
export const ETIQUETA_MOTIVO: Record<MotivoDeCobro, string> =
    Object.fromEntries(MOTIVOS.map((m) => [m.clave, m.etiqueta])) as Record<MotivoDeCobro, string>;

/**
 * Orden en los selectores (el del CHECK es histórico): el de «Registrar pago»
 * de siempre, con lo nuevo antes de «Otro cobro», que va al final.
 */
const ORDEN_EN_PANTALLA: readonly MotivoDeCobro[] = [
    'mensualidad', 'inscripcion', 'seguro', 'articulos', 'torneo', 'clase_extra',
    'vacacional', 'viaje', 'excedente', 'clase_prueba', 'reserva', 'otro',
];

export const motivosEnPantalla = (): DefinicionMotivo[] => ORDEN_EN_PANTALLA.map((c) => POR_CLAVE[c]);

/** Tipos del catálogo de servicios (`school_tournament_items.kind`), en el orden del editor. */
export type TipoDeServicio = 'torneo' | 'clase_extra' | 'vacacional' | 'viaje' | 'otro';
export const TIPOS_DE_SERVICIO: readonly TipoDeServicio[] =
    motivosEnPantalla().filter((m) => m.servicio).map((m) => m.clave as TipoDeServicio);

export const esTipoDeServicio = (v: unknown): v is TipoDeServicio =>
    typeof v === 'string' && (TIPOS_DE_SERVICIO as readonly string[]).includes(v);

/** `period_uniqueness_exempt` de un cobro nuevo de este motivo: todo menos la mensualidad. */
export const exentoDeUnicidadDePeriodo = (clave: MotivoDeCobro): boolean => !POR_CLAVE[clave].ocupaPeriodo;
