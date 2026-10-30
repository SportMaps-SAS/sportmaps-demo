/**
 * Llaves de pago de una escuela — fuente unica para el panel y para el acudiente.
 *
 * Viven en school_settings.payment_accounts (jsonb, migracion 20260809095613).
 * Antes cada canal era una columna suelta y solo cabia un valor por tipo; hoy la
 * escuela registra las que necesite y ESA lista es la que ve el acudiente en su
 * modal de pago y contra la que el OCR compara el destino del comprobante
 * (bff/services/receipt-verdict, check 4 DESTINO_NO_COINCIDE).
 *
 * Las columnas viejas (nequi_number, daviplata_number, breb_number, breb_key,
 * transfer_key) siguen existiendo como respaldo de lectura: `resolvePaymentAccounts`
 * las convierte al vuelo cuando la lista todavia no fue guardada, para que ninguna
 * escuela quede sin datos de pago entre el deploy y el primer guardado.
 */
import { CLAVES_MOTIVO, ETIQUETA_MOTIVO, esMotivoDeCobro, type MotivoDeCobro } from '@/lib/motivosDeCobro';

/**
 * `payment_link` NO es una llave para transferir: es un link de pago reutilizable
 * (p.ej. https://checkout.wompi.co/l/Hj5s7R de Dynasty, 2026-10-06) donde el
 * acudiente escribe el valor. Vive en la misma lista porque la escuela lo
 * administra en el mismo panel, pero el acudiente lo ve como botón, no como
 * llave para copiar, y el BFF no lo usa para verificar el destino del comprobante.
 */
export type PaymentAccountType = 'breb' | 'nequi' | 'daviplata' | 'transfer_key' | 'payment_link';

export const PAYMENT_LINK_TYPE = 'payment_link' as const;

/** Texto del botón y aviso que acompañan al link (iguales en BFF: payment-accounts.ts). */
export const PAYMENT_LINK_BUTTON_TEXT = 'Pagar con tarjeta, PSE o Nequi (Wompi)';
export const PAYMENT_LINK_NOTICE =
    'Escribe el valor de tu cobro y, al terminar, manda el comprobante por WhatsApp o súbelo en la app para que la escuela lo aplique.';

/**
 * ¿Sirve como link de pago? Solo https y sin caracteres raros. El esperado es
 * https://checkout.wompi.co/l/<id>; se acepta otro https por si la escuela usa
 * otra pasarela con links reutilizables. Misma regla que esUrlDeLinkDePago del BFF.
 */
export function isValidPaymentLinkUrl(value: string): boolean {
    const v = value.trim();
    if (!/^https:\/\/[^\s"'<>`]+$/i.test(v)) return false;
    try {
        return new URL(v).protocol === 'https:';
    } catch {
        return false;
    }
}

export const isPaymentLink = (a: Pick<PaymentAccount, 'type'>): boolean => a.type === PAYMENT_LINK_TYPE;

/**
 * Categorías de cobro: las 12 del CHECK payments_payment_category_check, desde
 * el catálogo único de motivos (lib/motivosDeCobro.ts, espejo de MOTIVOS del
 * BFF). Si se agrega una categoría, va allá, no aquí.
 */
export const CHARGE_CATEGORIES = CLAVES_MOTIVO;
export type PaymentChargeCategory = MotivoDeCobro;
export const isChargeCategory = (v: unknown): v is PaymentChargeCategory => esMotivoDeCobro(v);

export interface PaymentAccount {
    id: string;
    type: PaymentAccountType;
    /** Etiqueta libre para distinguir dos llaves del mismo tipo ("Bre-B Davivienda"). */
    label: string;
    value: string;
    /** false = la escuela la conserva pero deja de mostrarla al acudiente. */
    active: boolean;
    /**
     * Si trae categorías, la llave SOLO vale para esos cobros: se muestra al
     * acudiente únicamente al pagar uno de ellos, el bot de WhatsApp no la
     * ofrece, y el verificador la acepta solo para ese concepto (para otro, el
     * comprobante queda en revisión). Caso Dynasty 2026-10-05: Nequi personal de
     * la dueña, solo para inscripciones. Ausente/vacía = vale para todo.
     */
    only_for?: PaymentChargeCategory[];
    /**
     * Cuenta que la escuela ACEPTA pero que va «por fuera de SportMaps» (p. ej.
     * el Nequi de un entrenador para los torneos, 2026-10-13). Nunca se le
     * muestra al acudiente ni se espeja a las columnas viejas; un comprobante a
     * esta cuenta queda como informativo en la bandeja del bot, no como
     * «destino ajeno».
     */
    fuera_de_sportmaps?: boolean;
}

/** ¿Se le puede mostrar al acudiente como medio de pago? */
export function isVisibleToFamilies(account: Pick<PaymentAccount, 'fuera_de_sportmaps'>): boolean {
    return account.fuera_de_sportmaps !== true;
}

/** ¿La llave sirve para pagar un cobro de esta categoría? Desconocida = solo las generales. */
export function accountAppliesTo(account: Pick<PaymentAccount, 'only_for'>, category: PaymentChargeCategory | null | undefined): boolean {
    if (!account.only_for || account.only_for.length === 0) return true;
    return !!category && account.only_for.includes(category);
}

/**
 * Categoría de un cobro: `payment_category` si es específica; si falta o es
 * 'otro', el texto del concepto (`payment_type` NO distingue matrícula de
 * mensualidad). Misma regla que `categoriaDeCobro` del BFF.
 */
export function chargeCategoryOf(
    paymentCategory: string | null | undefined,
    concept: string | null | undefined,
): PaymentChargeCategory | null {
    if (isChargeCategory(paymentCategory) && paymentCategory !== 'otro') return paymentCategory;
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

/** Nombre del cobro para la escuela, por categoría (etiqueta del catálogo de motivos). */
export const CHARGE_CATEGORY_LABEL: Record<PaymentChargeCategory, string> = ETIQUETA_MOTIVO;

/**
 * ¿Es un cobro ÚNICO (no la mensualidad del período)? Solo por la categoría
 * EXPLÍCITA de la fila: NULL = fila vieja u open_month, que es mensualidad. No
 * mira el concepto ni `payment_type` (hay ~2.200 'one_time' que son
 * mensualidades). Misma regla que `esCobroUnico` del BFF y que el trigger de
 * vigencia (migración 20261010130450): pagar uno de estos no extiende la
 * inscripción, no lleva descuento por pronto pago y no compite por el período.
 * F0 (migración 20261010143132): tampoco se vence, no lleva recargo, no bloquea
 * el acceso y aprobarlo no activa una inscripción pendiente (approvePayment).
 * Es LA regla del frontend para dinero y acceso; no hay otra lista.
 */
export const isOneTimeCategory = (paymentCategory: string | null | undefined): boolean =>
    !!paymentCategory && paymentCategory !== 'mensualidad';

/**
 * Etiqueta del cobro si, por su CONCEPTO, no es la mensualidad («Inscripción»,
 * «Seguro de accidentes»…). Solo para mostrar cuando la fila llega sin
 * payment_category (p.ej. get_athlete_payments); no decide reglas de dinero.
 * null = mensualidad o no se sabe.
 */
export function oneTimeLabelFromConcept(concept: string | null | undefined): string | null {
    const cat = chargeCategoryOf(null, concept);
    return cat && cat !== 'mensualidad' ? CHARGE_CATEGORY_LABEL[cat] : null;
}

/**
 * Lo que el modal de pago necesita saber del cobro EXISTENTE que se paga
 * (mode='update'): si es único, su etiqueta, y la categoría para elegir llaves
 * (only_for). `category` = payments.payment_category (prop o leída de la fila).
 * En mode='create' no hay cobro existente: lo decide el selector de concepto.
 */
export function existingChargeInfo(
    mode: 'create' | 'update',
    category: string | null | undefined,
    concept: string | null | undefined,
): { isOneTime: boolean; label: string | null; accountsCategory: PaymentChargeCategory | null } {
    if (mode !== 'update') return { isOneTime: false, label: null, accountsCategory: null };
    const isOneTime = isOneTimeCategory(category);
    return {
        isOneTime,
        label: isOneTime ? chargeLabel({ payment_category: category, concept }) : null,
        accountsCategory: chargeCategoryOf(isChargeCategory(category) ? category : null, concept),
    };
}

/**
 * Etiqueta corta de un cobro («Inscripción», «Seguro de accidentes»…). Sin
 * categoría reconocible se asume la mensualidad SOLO si el cobro es de período
 * (`payment_type = 'subscription'`); si no, «Cobro».
 */
export function chargeLabel(p: {
    payment_category?: string | null;
    concept?: string | null;
    payment_type?: string | null;
}): string {
    const cat = chargeCategoryOf(p.payment_category, p.concept);
    if (cat) return CHARGE_CATEGORY_LABEL[cat];
    return p.payment_type === 'subscription' ? CHARGE_CATEGORY_LABEL.mensualidad : 'Cobro';
}

/**
 * Categoría de una fila para FILTRAR la lista de pagos. A diferencia de
 * `chargeCategoryOf` nunca devuelve null: sin categoría ni concepto reconocible
 * es la mensualidad (las del cron nacen con NULL), y una categoría que el front
 * todavía no conoce (una futura del CHECK) se respeta tal cual en vez de
 * esconderse dentro de «Mensualidad».
 */
export function chargeFilterKey(
    paymentCategory: string | null | undefined,
    concept: string | null | undefined,
): string {
    if (paymentCategory && !isChargeCategory(paymentCategory)) return paymentCategory;
    return chargeCategoryOf(paymentCategory, concept) ?? 'mensualidad';
}

/** Etiqueta de una clave de `chargeFilterKey`. */
export function chargeFilterLabel(key: string): string {
    return isChargeCategory(key) ? CHARGE_CATEGORY_LABEL[key] : key;
}

/**
 * SOLO PARA MOSTRAR (qué fila de la lista es «el cobro del mes»). Con categoría
 * explícita manda la regla única `isOneTimeCategory` (F0, migración
 * 20261010143132): un torneo, un viaje o cualquier categoría futura es único,
 * no solo inscripción/seguro/excedente como antes. Sin categoría (filas viejas)
 * se mira el concepto, igual que `oneTimeLabelFromConcept`.
 * Las REGLAS de dinero (activar inscripción, mora, descuentos) usan
 * `isOneTimeCategory` directo, nunca esto.
 * @deprecated en código nuevo: usar `isOneTimeCategory`.
 */
export const isOneOffCharge = (p: { payment_category?: string | null; concept?: string | null }): boolean =>
    p.payment_category
        ? isOneTimeCategory(p.payment_category)
        : oneTimeLabelFromConcept(p.concept) !== null;

export const PAYMENT_ACCOUNT_TYPES: { value: PaymentAccountType; label: string; placeholder: string }[] = [
    { value: 'breb',         label: 'Bre-B',                  placeholder: 'Celular, correo, cédula o @alias' },
    { value: 'nequi',        label: 'Nequi',                  placeholder: 'Celular' },
    { value: 'daviplata',    label: 'Daviplata',              placeholder: 'Celular' },
    { value: 'transfer_key', label: 'Llave de transferencia', placeholder: 'Celular, correo o alias' },
    { value: 'payment_link', label: 'Link de pago (Wompi)',   placeholder: 'https://checkout.wompi.co/l/…' },
];

export function accountTypeLabel(type: string): string {
    return PAYMENT_ACCOUNT_TYPES.find(t => t.value === type)?.label ?? type;
}

export function accountPlaceholder(type: string): string {
    return PAYMENT_ACCOUNT_TYPES.find(t => t.value === type)?.placeholder ?? 'Valor de la llave';
}

/** Lo que se muestra al acudiente: la etiqueta si la escuela la escribió, si no el tipo. */
export function accountDisplayLabel(account: PaymentAccount): string {
    const label = account.label?.trim();
    if (!label) return accountTypeLabel(account.type);
    // Evita "Nequi · Nequi" cuando la etiqueta ya es el nombre del canal.
    // Ni "Bre-B Bancolombia · Bre-B" cuando la etiqueta ya nombra el canal.
    const plano = (t: string) => t.normalize('NFD').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (plano(label).includes(plano(accountTypeLabel(account.type)))) return label;
    return `${label} · ${accountTypeLabel(account.type)}`;
}

const VALID_TYPES = new Set<string>(PAYMENT_ACCOUNT_TYPES.map(t => t.value));

/** Ids estables para el editor: crypto.randomUUID no existe en contextos no seguros. */
export function newAccountId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `acc_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Normaliza lo que venga de la BD (jsonb sin esquema garantizado) a PaymentAccount[].
 * Descarta elementos sin valor o de tipo desconocido en vez de romper el render.
 */
export function parsePaymentAccounts(raw: unknown): PaymentAccount[] {
    if (!Array.isArray(raw)) return [];
    const out: PaymentAccount[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const type = String(row.type ?? '');
        const value = typeof row.value === 'string' ? row.value.trim() : '';
        if (!VALID_TYPES.has(type) || !value) continue;
        // Se conserva `only_for`: si este parseo la descartara, guardar el panel
        // borraría la restricción y la llave volvería a valer para todo.
        const onlyFor = Array.isArray(row.only_for)
            ? (row.only_for as unknown[]).filter(isChargeCategory)
            : [];
        out.push({
            id: typeof row.id === 'string' && row.id ? row.id : newAccountId(),
            type: type as PaymentAccountType,
            label: typeof row.label === 'string' ? row.label : '',
            value,
            // Solo `false` explícito oculta: un registro viejo sin la clave se muestra.
            active: row.active !== false,
            ...(onlyFor.length > 0 ? { only_for: onlyFor } : {}),
            // Se conserva: si el parseo la descartara, guardar el panel la
            // volvería una cuenta para pagar cualquier cobro.
            ...(row.fuera_de_sportmaps === true ? { fuera_de_sportmaps: true } : {}),
        });
    }
    return out;
}

/** Columnas legacy de school_settings, en el orden en que se mostraban antes. */
export interface LegacyAccountColumns {
    nequi_number?: string | null;
    daviplata_number?: string | null;
    breb_number?: string | null;
    breb_key?: string | null;
    transfer_key?: string | null;
}

const LEGACY_MAP: { column: keyof LegacyAccountColumns; type: PaymentAccountType }[] = [
    { column: 'transfer_key',     type: 'transfer_key' },
    { column: 'nequi_number',     type: 'nequi' },
    { column: 'daviplata_number', type: 'daviplata' },
    { column: 'breb_number',      type: 'breb' },
    { column: 'breb_key',         type: 'breb' },
];

/** Misma normalización que normalizeDestination() en el BFF, para deduplicar. */
function normalizeValue(value: string): string {
    return value.toUpperCase().replace(/[\s.-]/g, '');
}

export function legacyColumnsToAccounts(source: LegacyAccountColumns | null | undefined): PaymentAccount[] {
    if (!source) return [];
    const seen = new Set<string>();
    const out: PaymentAccount[] = [];
    for (const { column, type } of LEGACY_MAP) {
        const value = (source[column] ?? '').toString().trim();
        if (!value) continue;
        const key = `${type}:${normalizeValue(value)}`;
        if (seen.has(key)) continue;   // breb_key y breb_number suelen ser la misma llave
        seen.add(key);
        out.push({ id: `legacy_${column}`, type, label: accountTypeLabel(type), value, active: true });
    }
    return out;
}

/**
 * Llaves a mostrar al acudiente: la lista si existe, si no las columnas viejas.
 * `onlyActive` por defecto — el panel del admin pasa false para editar también
 * las que estan apagadas (y entonces ve también las restringidas).
 * `category`: el cobro que se va a pagar. Al acudiente solo se le muestran las
 * llaves generales y las restringidas a esa categoría (`only_for`).
 */
export function resolvePaymentAccounts(
    source: (LegacyAccountColumns & { payment_accounts?: unknown }) | null | undefined,
    { onlyActive = true, category = null }: { onlyActive?: boolean; category?: PaymentChargeCategory | null } = {},
): PaymentAccount[] {
    if (!source) return [];
    const parsed = parsePaymentAccounts(source.payment_accounts);
    // Un link de pago no cuenta como "la escuela ya migró sus llaves": si la
    // lista solo tuviera el link, se perderían las columnas viejas.
    const keys = parsed.filter(a => !isPaymentLink(a));
    const accounts = keys.length > 0 ? parsed : [...legacyColumnsToAccounts(source), ...parsed];
    // Al acudiente solo se le muestran llaves para transferir; el link sale por
    // resolvePaymentLink como botón. El panel (onlyActive=false) ve todo.
    return onlyActive
        ? accounts.filter(a => a.active && !isPaymentLink(a) && isVisibleToFamilies(a) && accountAppliesTo(a, category))
        : accounts;
}

/**
 * Link de pago a mostrar al acudiente para un cobro de esta categoría: el
 * primero activo, aplicable (`only_for`) y con URL https válida. null = no hay.
 */
export function resolvePaymentLink(
    source: { payment_accounts?: unknown } | null | undefined,
    { category = null }: { category?: PaymentChargeCategory | null } = {},
): string | null {
    if (!source) return null;
    const link = parsePaymentAccounts(source.payment_accounts)
        .find(a => isPaymentLink(a) && a.active && isVisibleToFamilies(a) && accountAppliesTo(a, category) && isValidPaymentLinkUrl(a.value));
    return link?.value ?? null;
}

/**
 * Espejo de la lista hacia las columnas viejas: la PRIMERA llave activa de cada
 * tipo. Se sigue guardando porque hay lectores fuera de este flujo (clientes ya
 * desplegados, el select de respaldo del BFF) que aun apuntan ahi.
 */
export function accountsToLegacyColumns(accounts: PaymentAccount[]): Required<Omit<LegacyAccountColumns, 'breb_key'>> {
    // Las restringidas (`only_for`) NO se espejan: las columnas sueltas las leen
    // caminos que no conocen la restricción (bot, RPCs de pago) y la volverían
    // una llave para todo.
    const firstOf = (type: PaymentAccountType) =>
        accounts.find(a => a.active && isVisibleToFamilies(a) && !(a.only_for && a.only_for.length > 0) && a.type === type && a.value.trim())?.value.trim() ?? null;
    // `payment_link` no tiene columna vieja y no se espeja: los lectores de las
    // columnas (bot viejo, RPCs) tratarían la URL como número de cuenta.
    return {
        nequi_number:     firstOf('nequi'),
        daviplata_number: firstOf('daviplata'),
        breb_number:      firstOf('breb'),
        transfer_key:     firstOf('transfer_key'),
    };
}

/** Payload listo para jsonb: sin espacios sobrantes y sin filas a medio llenar. */
export function serializePaymentAccounts(accounts: PaymentAccount[]): PaymentAccount[] {
    return accounts
        .map(a => ({ ...a, label: a.label.trim(), value: a.value.trim() }))
        .filter(a => a.value.length > 0);
}
