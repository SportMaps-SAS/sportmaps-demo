/**
 * Llaves de pago de una escuela vistas desde el BFF: lectura de
 * `school_settings.payment_accounts` y la regla de "cuenta restringida a un
 * concepto".
 *
 * Por qué existe (Dynasty, 2026-10-05): la dueña cobra las INSCRIPCIONES en su
 * Nequi personal (320 429 8969) y las mensualidades en las cuentas del club.
 * Sin registrar ese Nequi, el verificador marcaba DESTINO_NO_COINCIDE y el bot
 * respondía "destino ajeno" a una inscripción legítima (caso real 2026-10-03).
 * Registrarlo sin más lo convertía en cuenta válida para TODO, y el bot lo
 * ofrecía para pagar la mensualidad. Por eso cada llave puede llevar
 * `only_for`: la lista de categorías de cobro para las que vale. Sin
 * `only_for` (o vacía) la llave vale para todo, que es lo de siempre.
 *
 * La categoría de un cobro sale de `payments.payment_category` y, si no está o
 * es 'otro', del texto del concepto: `payment_type` NO sirve para separar
 * matrícula de mensualidad (ver memoria project_payment_type_not_reliable).
 */

import { CLAVES_MOTIVO, esMotivo, mapaDeMotivos, type Motivo } from './motivos-de-cobro';

/**
 * Las categorías del CHECK de `payments`, del catálogo único (motivos-de-cobro.ts).
 * Desde 2026-10-30 incluye `reserva` y `clase_prueba`: antes
 * `categoriaDeCobro('clase_prueba')` daba null y ni `only_for` ni el contexto del
 * veredicto la conocían.
 */
export const CATEGORIAS_COBRO = CLAVES_MOTIVO;
export type CategoriaCobro = Motivo;

export interface CuentaDePago {
    id: string | null;
    type: string;
    label: string;
    value: string;
    /** false = la escuela la oculta al acudiente; sigue siendo de la escuela. */
    active: boolean;
    /** null = vale para cualquier cobro. Si trae categorías, solo para esas. */
    onlyFor: CategoriaCobro[] | null;
    /**
     * `fuera_de_sportmaps: true` en el jsonb (2026-10-13). La escuela ACEPTA
     * pagos a esta cuenta (p. ej. el Nequi de un entrenador para los torneos)
     * pero van «por fuera de SportMaps»: no se le ofrece a la familia como
     * medio de pago, no valida un comprobante como plata de la escuela y un
     * comprobante a ella queda INFORMATIVO en la bandeja, no «destino ajeno».
     */
    fueraDeSportmaps: boolean;
}

const esCategoria = (v: unknown): v is CategoriaCobro => esMotivo(v);

/**
 * Tipo de entrada que NO es una cuenta: un link de pago (p.ej. el link de Wompi
 * de Dynasty, https://checkout.wompi.co/l/Hj5s7R, 2026-10-06). Vive en la misma
 * lista porque la escuela lo administra en el mismo panel, pero no es un destino
 * de transferencia: si entrara como "cuenta", el verificador compararía la URL
 * contra el destino del comprobante y el bot la dictaría como número.
 */
export const TIPO_LINK_DE_PAGO = 'payment_link';

/**
 * ¿La URL sirve como link de pago? Solo https y sin caracteres que permitan
 * romper el HTML del correo o de la página. El esperado es
 * https://checkout.wompi.co/l/<id>, pero se acepta otro https por si la escuela
 * usa otra pasarela con links reutilizables.
 */
export function esUrlDeLinkDePago(valor: string): boolean {
    if (!/^https:\/\/[^\s"'<>`]+$/i.test(valor)) return false;
    try {
        return new URL(valor).protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Lo que se le dice al acudiente junto al link de pago genérico. El link
 * (p.ej. el de Wompi de Dynasty) no sabe a qué cobro corresponde: el acudiente
 * escribe el valor y la escuela concilia con el comprobante. Sin este aviso el
 * pago llega a la cuenta de la escuela sin decir de quién es.
 */
export const AVISO_LINK_DE_PAGO =
    'Escribe el valor de tu cobro y, al terminar, manda el comprobante por WhatsApp o súbelo en la app para que la escuela lo aplique';

export const TEXTO_BOTON_LINK_DE_PAGO = 'Pagar con tarjeta, PSE o Nequi (Wompi)';

/** Filas crudas del jsonb (sin esquema garantizado), con su valor ya recortado. */
function filasCrudas(raw: unknown): { row: Record<string, unknown>; value: string }[] {
    if (!Array.isArray(raw)) return [];
    const out: { row: Record<string, unknown>; value: string }[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        // `value` es la clave real (mig 20260809095613); `number`/`numero` se
        // aceptan por si algún dato viejo o cargado a mano los usó.
        const valorCrudo = row.value ?? row.number ?? row.numero;
        const value = typeof valorCrudo === 'string' ? valorCrudo.trim() : '';
        if (value) out.push({ row, value });
    }
    return out;
}

const onlyForDe = (row: Record<string, unknown>): CategoriaCobro[] | null => {
    const lista = Array.isArray(row.only_for) ? row.only_for.filter(esCategoria) : [];
    return lista.length > 0 ? lista : null;
};

/**
 * Link de pago de la escuela para un cobro de esta categoría: el primero activo,
 * aplicable (`only_for`) y con URL https válida. null = no tiene.
 *
 * El link es GENÉRICO (Wompi no sabe a qué cobro corresponde: el acudiente
 * escribe el valor), así que quien lo muestre debe pedir el comprobante para
 * que la escuela concilie.
 */
export function linkDePago(raw: unknown, categoria: CategoriaCobro | null): string | null {
    for (const { row, value } of filasCrudas(raw)) {
        if (String(row.type ?? '') !== TIPO_LINK_DE_PAGO) continue;
        if (row.active === false) continue;
        if (row.fuera_de_sportmaps === true) continue;
        if (!cuentaAplicaA({ onlyFor: onlyForDe(row) }, categoria)) continue;
        if (!esUrlDeLinkDePago(value)) continue;
        return value;
    }
    return null;
}

/**
 * jsonb sin esquema garantizado → lista limpia de CUENTAS. Descarta filas sin
 * valor y los links de pago (ver TIPO_LINK_DE_PAGO): todo lo que consume esta
 * lista (verificación de destino del comprobante, cuentas del bot y de la
 * página pública) habla de cuentas para transferir.
 */
export function parseCuentasDePago(raw: unknown): CuentaDePago[] {
    const out: CuentaDePago[] = [];
    for (const { row, value } of filasCrudas(raw)) {
        if (String(row.type ?? '') === TIPO_LINK_DE_PAGO) continue;
        out.push({
            id: typeof row.id === 'string' ? row.id : null,
            type: String(row.type ?? ''),
            label: typeof row.label === 'string' ? row.label : '',
            value,
            active: row.active !== false,
            onlyFor: onlyForDe(row),
            fueraDeSportmaps: row.fuera_de_sportmaps === true,
        });
    }
    return out;
}

/**
 * Categoría de un cobro. `payment_category` manda cuando es específica; si
 * falta o es 'otro', se mira el concepto. null = no se pudo saber.
 */
export function categoriaDeCobro(
    paymentCategory: string | null | undefined,
    concept: string | null | undefined,
): CategoriaCobro | null {
    if (esCategoria(paymentCategory) && paymentCategory !== 'otro') return paymentCategory;
    const c = (concept ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (c) {
        if (/matricul|inscrip/.test(c)) return 'inscripcion';
        if (/seguro/.test(c)) return 'seguro';
        if (/mensualidad|mensual/.test(c)) return 'mensualidad';
        if (/torneo/.test(c)) return 'torneo';
        if (/uniforme|articulo|kit\b|dotacion/.test(c)) return 'articulos';
    }
    return paymentCategory === 'otro' ? 'otro' : null;
}

/** ¿Esta llave sirve para un cobro de esta categoría? Sin categoría conocida, solo las generales. */
export function cuentaAplicaA(cuenta: Pick<CuentaDePago, 'onlyFor'>, categoria: CategoriaCobro | null): boolean {
    if (!cuenta.onlyFor || cuenta.onlyFor.length === 0) return true;
    return categoria !== null && cuenta.onlyFor.includes(categoria);
}

const NOMBRE_CATEGORIA: Record<CategoriaCobro, string> = mapaDeMotivos('plural');

/** "inscripciones", "inscripciones y torneos" — para mensajes. */
export function describirCategorias(cats: readonly string[]): string {
    const nombres = cats.map((c) => (esCategoria(c) ? NOMBRE_CATEGORIA[c] : c));
    if (nombres.length <= 1) return nombres[0] ?? '';
    return `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
}

/** Nombre singular del cobro para la familia («Seguro de accidentes»). Igual que CHARGE_CATEGORY_LABEL del frontend. */
export const ETIQUETA_COBRO: Record<CategoriaCobro, string> = mapaDeMotivos('etiqueta');

/**
 * ¿Es un cobro ÚNICO (no la mensualidad del período)? Solo por la categoría
 * EXPLÍCITA: NULL = fila vieja u open_month, que es mensualidad. No se mira el
 * concepto ni `payment_type` (2.220 'one_time' con categoría NULL son
 * mensualidades, medido 2026-10-10). Misma regla que el trigger
 * fn_extend_enrollment_on_payment_paid (migración 20261010130450): lo que esto
 * da por único no extiende la vigencia al pagarse.
 */
export function esCobroUnico(paymentCategory: string | null | undefined): boolean {
    return !!paymentCategory && paymentCategory !== 'mensualidad';
}

/*
 * REGLA ÚNICA de cobro único (F0, migración 20261010143132, 2026-10-10):
 * mensualidad ⇔ COALESCE(payment_category,'mensualidad') = 'mensualidad'.
 * Un cobro único (inscripción, seguro, torneo, artículos, viaje… y cualquier
 * categoría futura) NUNCA se vence, no lleva recargo, no bloquea el acceso y
 * pagarlo no activa ni extiende la inscripción. Las decisiones de dinero y de
 * acceso usan SOLO esto (o el filtro de abajo), nunca el concepto:
 * `tipo-de-cobro.ts` deduce del concepto para NOMBRAR el cobro, no para decidir.
 */

/** ¿Es la mensualidad del período? El complemento exacto de `esCobroUnico`. */
export function esMensualidadPorCategoria(paymentCategory: string | null | undefined): boolean {
    return !esCobroUnico(paymentCategory);
}

/**
 * La misma regla como filtro PostgREST, para `.or(FILTRO_SOLO_MENSUALIDAD)`:
 * categoría NULL o 'mensualidad'. (payments_payment_category_check impide la
 * cadena vacía, así que coincide con el COALESCE de la SQL.)
 */
export const FILTRO_SOLO_MENSUALIDAD = 'payment_category.is.null,payment_category.eq.mensualidad';

/**
 * Etiqueta corta del cobro: la categoría (explícita o deducida del concepto);
 * sin categoría, «Mensualidad» si es de período y si no «Cobro».
 */
export function etiquetaDeCobro(p: {
    payment_category?: string | null;
    concept?: string | null;
    payment_type?: string | null;
}): string {
    const cat = categoriaDeCobro(p.payment_category, p.concept);
    if (cat) return ETIQUETA_COBRO[cat];
    return p.payment_type === 'subscription' ? ETIQUETA_COBRO.mensualidad : 'Cobro';
}
