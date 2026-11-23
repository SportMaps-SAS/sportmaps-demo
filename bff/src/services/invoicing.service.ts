/**
 * invoicing.service — orquesta la emisión de facturas electrónicas desde dos
 * orígenes, con el MISMO adaptador/PAC y modelo multi-owner:
 *
 *   1) payments (flujo escuela)        → emitInvoiceForPayment
 *   2) marketplace_transactions (tiendas/servicios/eventos) → emitInvoiceForMarketplaceTx
 *
 * Núcleo común en runEmission(). Idempotente por reference_code +
 * unique(owner, reference_code) y por el enlace (payment_id / mtx_id).
 *
 * Dos caminos para disparar la emisión de pagos, y no son intercambiables:
 *   - autoEmitPendingInvoices: cron, ventana CORTA (3 días), el día a día.
 *   - backfillInvoices:        a mano, rango de fechas explícito y tope, para
 *                              el rezago. Es el único camino para facturar un
 *                              mes cerrado.
 *
 * Y un solo camino de vuelta: voidInvoice, que emite la NOTA CRÉDITO. Una
 * factura emitida no se edita ni se borra —el número de la resolución DIAN
 * queda consumido—, así que deshacerla es emitir otro documento que la anule.
 * Anular es además lo que vuelve facturable el cobro, y por eso toca la
 * idempotencia de la emisión (ver referenciaDelProximoIntento).
 */

import { supabase } from '../config/supabase';
import { resolveInvoiceProvider, OwnerType } from './invoice-provider.resolver';
import { getAdapter } from './invoicing';
import {
    InvoiceRequest,
    InvoiceLine,
    InvoiceCustomer,
    CreditNoteRequest,
    CorrectionConceptCode,
    CORRECTION_CONCEPTS,
    CORRECTION_CONCEPT_ANULACION,
    CREDIT_NOTE_OBSERVATION_MAX,
    ProviderConfig,
    creditNoteNumberingRangeId,
    normalizeDaneMunicipality,
    resolveCustomerMunicipality,
    resolveCustomerEmail,
    cardTypeFromGatewayPayload,
    isRetryablePacError,
    TRANSPORT_ERROR_PREFIX,
    esRechazoPorBloqueoDelPac,
} from './invoicing/types';
import {
    duenoDelCobro, filaDe, decidirClienteDeFactura, consumidorFinalHabilitado,
    envioPorCorreoHabilitado, type FilaFactura,
} from './factura-pagador.service';

export interface EmitResult {
    ok: boolean;
    invoiceId?: string;
    status?: string;
    error?: string;
    /**
     * Avisos que no impiden emitir pero que alguien tiene que ver, p. ej. que
     * se usó el municipio del emisor porque el del cliente no está. Antes eso
     * pasaba en silencio y por eso nadie sabía que había facturas de familias
     * de Mosquera y de Madrid que decían Bogotá.
     */
    warnings?: string[];
}

// ─── Helpers compartidos ──────────────────────────────────────────────────────

/** Datos fiscales del comprador desde su perfil. null si le faltan. */
async function loadCustomer(userId: string): Promise<InvoiceCustomer | null> {
    const { data: p } = await supabase
        .from('profiles')
        .select('full_name, email, phone, document_type, document_number, billing_address, billing_state_dane, billing_city_dane')
        .eq('id', userId)
        .maybeSingle();
    // El número de documento se normaliza quitando TODO espacio en blanco: hay
    // cédulas guardadas como '1015418301 ' y '4736509 ' (cuatro en Dynasty).
    // Un documento con espacio o el PAC lo rechaza con 422, o —peor— emite la
    // factura a nombre de un identificador que no existe en el RUT. Solo se
    // toca el espacio: puntos y el guion del dígito de verificación del NIT sí
    // son significativos.
    const identification = String(p?.document_number ?? '').replace(/\s+/g, '');
    if (!identification) return null;

    // `billing_city_dane` guarda el CÓDIGO DANE del municipio desde que el
    // formulario usa el selector del catálogo. Los perfiles viejos tienen
    // texto libre ("Bogota", "medellin"), que no sirve como código: en ese
    // caso queda null y decide la política del dueño
    // (resolveCustomerMunicipality), que ya NO sustituye en silencio.
    //
    // El código viaja como STRING de 5 dígitos. La versión anterior hacía
    // `Number(cityRaw)` y `Number('05001')` = 5001, que no es ningún
    // municipio: se rompían los 148 de Antioquia (05xxx) y Atlántico (08xxx)
    // —Medellín, Envigado, Barranquilla, Soledad—. Es el mismo bug que el
    // selector del formulario vino a cerrar, reintroducido una capa más abajo.
    const cityRaw = (p?.billing_city_dane ?? '').trim();
    return {
        documentType: p?.document_type || 'CC',
        identification,
        name: p?.full_name || 'Consumidor final',
        email: p?.email,
        phone: p?.phone,
        address: p?.billing_address,
        department: p?.billing_state_dane,
        city: cityRaw || null,
        municipalityCode: normalizeDaneMunicipality(cityRaw),
    };
}

/** Columnas que enlazan una factura con su origen. */
type LinkColumn = 'payment_id' | 'marketplace_transaction_id' | 'order_id';

/**
 * reference_code del PRÓXIMO intento de facturar un origen (pago / venta /
 * orden). ESTA función es la que vuelve facturable un cobro cuya factura se
 * anuló, y su forma está atada a dos cosas que no se pueden romper.
 *
 * El problema: `reference_code` es la idempotencia del PAC, y es DETERMINISTA
 * (`SM-<paymentId>`). Reenviarlo devuelve el MISMO documento —eso es lo que
 * hace inofensivo que tres BFF corran el cron sobre la misma base—, pero
 * también significa que después de anular una factura, reemitir con la misma
 * referencia trae de vuelta el documento anulado: Factus lo repite y la DIAN
 * contesta regla 90, «Documento procesado anteriormente». Es exactamente el
 * muro contra el que quedó el pago de $90.000 con la factura DYTY1.
 *
 * La solución NO puede ser un sufijo aleatorio ni un timestamp. Con eso, dos
 * procesos que emiten el mismo pago a la vez generarían DOS referencias
 * distintas y por lo tanto DOS facturas reales, cada una quemando un número de
 * la resolución. La idempotencia de todo este módulo depende de que la
 * referencia sea función del ESTADO, no del reloj.
 *
 * Así que el sufijo es el número de intento, y el número de intento se DERIVA:
 * cuántas facturas de este origen quedaron cerradas (status 'void'). Dos
 * emisiones simultáneas leen el mismo estado, calculan la misma referencia,
 * colisionan en el índice único (owner, reference_code) sobre la MISMA fila y
 * el PAC les devuelve el MISMO documento. El contador solo avanza cuando una
 * persona anula, que es una acción manual y serializada.
 *
 * El primer intento conserva la referencia histórica sin sufijo: así las
 * facturas que ya existen y las ~147 que faltan por emitir mantienen la
 * referencia con la que se las buscaría en el PAC.
 */
async function referenciaDelProximoIntento(
    column: LinkColumn,
    id: string,
    base: string,
): Promise<string> {
    const { data, error } = await supabase
        .from('electronic_invoices')
        .select('id')
        .eq(column, id)
        // Filtro explícito aunque hoy las notas crédito no llevan enlace al
        // origen (ver voidInvoice): contar una nota crédito como «intento
        // cerrado» saltaría un número de intento y dejaría un hueco raro de
        // explicar en soporte.
        .eq('document_type', 'invoice')
        .eq('status', 'void');
    if (error) {
        // Si no se puede leer el estado, NO se adivina: seguir con la
        // referencia base es lo único seguro. Peor caso, el PAC devuelve el
        // documento anulado y la emisión falla con regla 90 — que es
        // recuperable. Inventar un sufijo acá sería quemar un número.
        console.error('[invoicing] referenciaDelProximoIntento', error.message);
        return base;
    }

    const intentosCerrados = (data ?? []).length;
    return intentosCerrados === 0 ? base : `${base}-R${intentosCerrados + 1}`;
}

/** Impuesto por defecto según la config del PAC del dueño. */
function taxDefaults(cfg: ProviderConfig): { isExcluded: boolean; taxRate: number } {
    return {
        isExcluded: cfg.config.tax_excluded !== false, // default excluido salvo config
        taxRate: Number(cfg.config.default_tax_rate ?? 0),
    };
}

/**
 * Traduce el resultado del PAC a columnas de electronic_invoices.
 *
 * Lo usan la emisión de facturas y la de notas crédito. Está extraído porque
 * son 18 columnas y el precio de que las dos copias se desincronicen ya se
 * conoce: el rechazo de la DIAN vivió un tiempo solo dentro de `dian_response`
 * —donde nadie lo miraba— porque un camino lo subía a `error_message` y el otro
 * no.
 */
function columnasDelResultado(result: {
    status: string;
    providerBillId?: string | null;
    prefix?: string | null;
    number?: string | null;
    dianCode?: string | null;
    cufe?: string | null;
    qrUrl?: string | null;
    qrImage?: string | null;
    publicUrl?: string | null;
    pdfUrl?: string | null;
    xmlUrl?: string | null;
    taxableAmount?: number | null;
    taxAmount?: number | null;
    total?: number | null;
    raw?: unknown;
    errorMessage?: string | null;
    validatedAt?: string | null;
}): Record<string, any> {
    return {
        status: result.status,
        provider_bill_id: result.providerBillId ?? null,
        prefix: result.prefix ?? null,
        number: result.number ?? null,
        dian_code: result.dianCode ?? null,
        cufe: result.cufe ?? null,
        qr_url: result.qrUrl ?? null,
        qr_image: result.qrImage ?? null,
        public_url: result.publicUrl ?? null,
        pdf_url: result.pdfUrl ?? null,
        xml_url: result.xmlUrl ?? null,
        taxable_amount: result.taxableAmount ?? null,
        tax_amount: result.taxAmount ?? null,
        total: result.total ?? null,
        dian_response: result.raw ?? null,
        error_message: result.errorMessage ?? null,
        validated_at: result.validatedAt ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
    };
}

/**
 * Núcleo: crea la fila draft (idempotente), llama al adaptador y persiste el
 * resultado + líneas. `link` conecta la factura con su origen.
 */
async function runEmission(params: {
    ownerType: OwnerType;
    ownerId: string;
    cfg: ProviderConfig;
    request: InvoiceRequest;
    link: { payment_id?: string; marketplace_transaction_id?: string; order_id?: string };
}): Promise<EmitResult> {
    const { ownerType, ownerId, cfg, request, link } = params;

    const adapter = getAdapter(cfg.provider);
    if (!adapter) return { ok: false, error: `adapter_not_found:${cfg.provider}` };
    if (!cfg.config?.numbering_range_id) return { ok: false, error: 'provider_missing_numbering_range' };

    // ── Municipio del adquirente ──────────────────────────────────────────────
    // Se resuelve ANTES de crear la fila: si la política del dueño es 'require'
    // y el dato falta, no queremos una fila en 'queued' que el barrido cuente
    // como facturada. Y el fallback al municipio del emisor, cuando aplica,
    // deja aviso — nunca más en silencio.
    const muni = resolveCustomerMunicipality(request.customer, cfg);
    if (muni.reject) return { ok: false, error: muni.reject };

    const warnings: string[] = [];
    if (muni.usedOwnerFallback) {
        warnings.push(`municipio_del_emisor_por_falta_del_cliente:${muni.code}`);
        console.warn(
            `[invoicing] ${request.referenceCode}: el cliente no tiene código DANE; se usa el del emisor (${muni.code}). ` +
            `Para cortar la emisión en estos casos, config.customer_municipality_policy='require'.`,
        );
    }
    // ── Correo del adquiriente ────────────────────────────────────────────────
    // Misma lógica que el municipio y por la misma razón va ANTES de la fila:
    // sin correo válido y con política 'require' (el default mientras el PAC
    // no declare que acepta sin correo) el pago vuelve como
    // 'customer_missing_email' —un SALTO, no un fallo— y queda en «Datos
    // fiscales faltantes». Un correo inválido nunca viaja al PAC. Regla
    // completa en resolveCustomerEmail (invoicing/types.ts).
    const correo = resolveCustomerEmail(request.customer, cfg, adapter);
    if (correo.reject) return { ok: false, error: correo.reject };
    if (correo.warning) warnings.push(correo.warning);

    const requestConMunicipio: InvoiceRequest = {
        ...request,
        customer: { ...request.customer, municipalityCode: muni.code, email: correo.email },
        // Sin correo no hay a quién mandarle la factura: no se le pide al PAC.
        ...(correo.email ? {} : { sendEmail: false }),
    };

    const { data: draft, error: draftErr } = await supabase
        .from('electronic_invoices')
        .upsert(
            {
                owner_type: ownerType,
                owner_id: ownerId,
                provider: cfg.provider,
                document_type: 'invoice',
                reference_code: request.referenceCode,
                status: 'queued',
                currency: 'COP',
                customer_snapshot: requestConMunicipio.customer,
                ...link,
            },
            { onConflict: 'owner_type,owner_id,reference_code' },
        )
        .select('id')
        .single();
    if (draftErr || !draft) return { ok: false, error: draftErr?.message || 'draft_failed' };
    const invoiceId = draft.id as string;

    let result;
    try {
        result = await adapter.emit(requestConMunicipio, cfg);
    } catch (e: any) {
        // UN FALLO DE TRANSPORTE NO ES UN RECHAZO. Si la petición no llegó, no
        // volvió o volvió ilegible (red, timeout, 5xx, 429, credenciales), el
        // documento PUDO quedar creado ante la DIAN con su número consumido.
        // Marcarlo 'rejected' era el peor final posible: la reconciliación
        // excluye 'rejected', así que el número quedaba quemado, el documento
        // vivo en la DIAN, y para nosotros «Rechazada» para siempre.
        //
        // Por eso la fila se queda en 'queued' —que reconcilePendingInvoices SÍ
        // barre, consultando al PAC por reference_code— con el motivo marcado
        // con TRANSPORT_ERROR_PREFIX para que el backfill sepa que se puede
        // reintentar (la idempotencia por reference_code está confirmada:
        // reenviar devuelve el MISMO documento, no crea otro).
        const retryable = isRetryablePacError(e);
        const mensaje = e?.message ?? String(e);
        await supabase.from('electronic_invoices').update({
            status: retryable ? 'queued' : 'rejected',
            error_message: retryable ? `${TRANSPORT_ERROR_PREFIX} ${mensaje}` : mensaje,
            updated_at: new Date().toISOString(),
        }).eq('id', invoiceId);
        return {
            ok: false,
            invoiceId,
            error: retryable ? 'pac_transport_error' : (mensaje || 'emit_threw'),
            warnings: [...warnings, mensaje],
        };
    }

    await supabase.from('electronic_invoices')
        .update(columnasDelResultado(result))
        .eq('id', invoiceId);

    await supabase.from('electronic_invoice_items').delete().eq('invoice_id', invoiceId);
    await supabase.from('electronic_invoice_items').insert(
        requestConMunicipio.items.map((it, idx) => ({
            invoice_id: invoiceId,
            line_no: idx + 1,
            code_reference: it.codeReference,
            name: it.name,
            quantity: it.quantity,
            unit_price: it.unitPrice,
            discount_rate: it.discountRate ?? 0,
            is_excluded: it.isExcluded ?? false,
            tax_rate: it.isExcluded ? 0 : it.taxRate,
            tax_code: '01',
            taxable_amount: result.taxableAmount ?? null,
            tax_amount: result.taxAmount ?? null,
            total: result.total ?? null,
        })),
    );

    // 'sent' cuenta como OK. Factus V2 en PRODUCCIÓN nunca responde 'accepted'
    // en la emisión: devuelve solo el acuse («Documento en proceso de
    // validación») y la DIAN valida minutos después, así que exigir 'accepted'
    // hacía que TODA emisión real se contara como fallida y que el barrido
    // reportara 0 emitidas con las facturas saliendo bien. Quien completa la
    // fila es reconcilePendingInvoices.
    const ok = result.status === 'accepted' || result.status === 'sent';
    return {
        ok,
        invoiceId,
        status: result.status,
        // Con este código el barrido sabe que es el PAC el que está bloqueado
        // (no este pago) y deja de insistir con el resto del dueño.
        ...(!ok && esRechazoPorBloqueoDelPac(result.errorMessage) ? { error: PAC_BLOQUEADO } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
    };
}

/** Código de EmitResult.error cuando el PAC frena la emisión por una factura sin validar. */
export const PAC_BLOQUEADO = 'pac_bloqueado_por_factura_pendiente';

// ─── Origen 1: pagos de escuela (tabla payments) ───────────────────────────────

/**
 * 'card' → 'card_credit' | 'card_debit' cuando la pasarela guardó el tipo de
 * tarjeta; si no, devuelve el medio tal cual. `payments` solo guarda 'card',
 * pero el webhook de Wompi trae `payment_method.extra.card_type` y queda en
 * `webhook_events.payload` (hoy 24 de 87 pagos con tarjeta lo tienen). Se
 * cruza por la referencia de la pasarela o por el id de la transacción.
 * Nunca rompe la emisión: ante cualquier error devuelve 'card' (→ 48).
 */
export async function refinarMedioDeTarjeta(
    paymentId: string,
    method: string | null | undefined,
): Promise<string | null | undefined> {
    if (String(method ?? '').trim().toLowerCase() !== 'card') return method;
    try {
        const { data: p } = await supabase
            .from('payments')
            .select('wompi_reference, provider_reference, wompi_transaction_id, provider_transaction_id')
            .eq('id', paymentId)
            .maybeSingle();
        const refs = [p?.wompi_reference, p?.provider_reference].filter((v): v is string => !!v);
        const txIds = [p?.wompi_transaction_id, p?.provider_transaction_id].filter((v): v is string => !!v);
        if (!refs.length && !txIds.length) return method;

        // Comillas dobles: una referencia con coma o paréntesis no rompe el or().
        const q = (v: string) => `"${v.replace(/"/g, '')}"`;
        const filtros = [
            ...refs.map((r) => `reference.eq.${q(r)}`),
            ...txIds.map((t) => `payload->data->transaction->>id.eq.${q(t)}`),
        ].join(',');
        const { data: eventos } = await supabase
            .from('webhook_events')
            .select('payload, created_at')
            .or(filtros)
            .order('created_at', { ascending: false })
            .limit(10);
        for (const ev of eventos ?? []) {
            const tipo = cardTypeFromGatewayPayload((ev as any).payload);
            if (tipo) return tipo === 'credit' ? 'card_credit' : 'card_debit';
        }
    } catch {
        /* sin dato: queda 'card' */
    }
    return method;
}

export async function emitInvoiceForPayment(paymentId: string): Promise<EmitResult> {
    // Un pago puede tener VARIAS filas desde que se pueden anular facturas
    // (intento anulado + intento nuevo), así que este atajo se acota a la
    // factura viva y se pide limit(1): `maybeSingle()` sobre dos filas no
    // devuelve la primera, revienta.
    //
    // Que 'void' NO esté en la lista es lo que rescata al pago: una factura
    // anulada deja de contar como emitida y el cobro se puede volver a
    // facturar (con una referencia nueva, ver referenciaDelProximoIntento).
    // Y como anular exige que la factura tenga número —una 'sent' sin número
    // no se puede anular—, nunca puede haber dos filas en accepted/sent para
    // el mismo pago.
    const { data: existing } = await supabase
        .from('electronic_invoices')
        .select('id, status')
        .eq('payment_id', paymentId)
        .eq('document_type', 'invoice')
        .in('status', ['accepted', 'sent'])
        .limit(1)
        .maybeSingle();
    if (existing) return { ok: true, invoiceId: existing.id, status: existing.status };

    const { data: payment } = await supabase
        .from('payments')
        .select('id, amount, amount_paid, gross_amount, payment_method, status, concept, school_id, parent_id, user_id, child_id, unregistered_athlete_id')
        .eq('id', paymentId)
        .maybeSingle();
    if (!payment) return { ok: false, error: 'payment_not_found' };
    // Solo se factura lo cobrado. Antes no se miraba el estado: se podía emitir
    // una factura fiscal (con número de la resolución DIAN, irrecuperable) por
    // un cobro pendiente o anulado.
    if (payment.status !== 'paid') return { ok: false, error: 'payment_not_paid' };
    // Exonerado ($0): una mensualidad «No cobrar» queda `paid` con amount = 0
    // (spec cobros-multiples §6.5, I29). No hubo venta: una factura de $0 quema
    // un número de la resolución DIAN que solo se recupera con nota crédito.
    // `amount_paid = 0` explícito (no NULL) es lo mismo: no entró plata. Hoy
    // hay 0 filas `paid` con amount_paid = 0 y amount > 0 (medido 2026-10-10).
    if (!(Number(payment.amount) > 0) || (payment.amount_paid !== null && payment.amount_paid !== undefined && Number(payment.amount_paid) === 0)) {
        return { ok: false, error: 'payment_zero_amount' };
    }
    if (!payment.school_id) return { ok: false, error: 'payment_without_school' };
    // El comprador es parent_id (menor con acudiente) o, si no hay, user_id
    // (atleta adulto que paga por sí mismo — school_athletes.parent_id sale
    // NULL para athlete_type='adult'; antes esto dejaba sus pagos sin
    // facturar en TODOS los canales, no solo efectivo).
    const payerId = payment.parent_id || payment.user_id;

    const ownerType: OwnerType = 'school';
    const ownerId: string = payment.school_id;

    // Preferencia de factura del pagador (payer_billing_profiles, spec
    // factura-electronica-preferencia-y-datos-del-pagador). Alcanza también al
    // acudiente SIN cuenta, por el celular de la ficha: antes ese pago se
    // descartaba siempre como 'payment_without_payer'. Sin fila (o sin la
    // migración aplicada) todo sigue exactamente como antes.
    const dueno = await duenoDelCobro(payment);
    const fila: FilaFactura | null = dueno ? await filaDe(dueno) : null;
    if (!payerId && fila?.preference !== 'quiere') return { ok: false, error: 'payment_without_payer' };

    // Los datos del cliente se revisan ANTES del facturador a propósito: con el
    // facturador apagado todos los pagos reportarían 'no_invoice_provider' y se
    // perdería el diagnóstico útil —quién no tiene pagador y quién no tiene
    // documento—, que es justamente la lista de trabajo que hay que resolver
    // antes de prenderlo. El facturador solo se consulta antes si hace falta
    // para decidir (consumidor final es un flag SUYO).
    const clientePerfil = payerId ? await loadCustomer(payerId) : null;
    let decision = decidirClienteDeFactura({ fila, clientePerfil, consumidorFinal: false });
    let cfgPrevio: Awaited<ReturnType<typeof resolveInvoiceProvider>> | undefined;
    if (fila?.preference === 'no_quiere' || !decision.customer) {
        cfgPrevio = await resolveInvoiceProvider(ownerType, ownerId);
        if (consumidorFinalHabilitado(cfgPrevio)) {
            decision = decidirClienteDeFactura({ fila, clientePerfil, consumidorFinal: true });
        }
    }
    const customer = decision.customer;
    if (!customer) return { ok: false, error: 'customer_missing_fiscal_data' };

    const cfg = cfgPrevio !== undefined ? cfgPrevio : await resolveInvoiceProvider(ownerType, ownerId);
    if (!cfg) return { ok: false, error: 'no_invoice_provider' };

    const { isExcluded, taxRate } = taxDefaults(cfg);

    // MONTO BRUTO: lo que el pagador pagó de verdad.
    //
    // En un pago online el padre paga `gross_amount` = amount + 5% de recargo, y
    // ese recargo le entra COMPLETO a la escuela (SportMaps no retiene por
    // transacción, monetiza por addon). Facturar `amount` dejaba una
    // mensualidad de 210.000 con extracto de tarjeta por 220.500: el
    // adquirente no puede soportar los 10.500 que pagó. El camino de
    // marketplace, en este mismo servicio, ya facturaba el bruto — esto lo
    // alinea, no es un criterio nuevo.
    //
    // `gross_amount` es NULL en todo pago que no pasó por pasarela (efectivo,
    // transferencia, manual: la mayoría). Contra la base de hoy nunca es menor
    // que `amount` (relación entre 1,00 y 1,05) — pero eso es una OBSERVACIÓN
    // de los datos actuales, no un invariante que nadie sostenga: `??` solo
    // atrapa null/undefined, así que un `gross_amount` en 0 (un bug de la
    // pasarela, una migración, una cortesía mal registrada) emitiría el
    // documento por CERO. Facturar por debajo de lo cobrado no se corrige: se
    // anula con nota crédito, y Dynasty hoy no tiene rango de nota crédito en
    // producción. Por eso el piso es explícito y no una confianza en los datos.
    const unitPrice = Math.max(
        Number(payment.amount) || 0,
        Number(payment.gross_amount) || 0,
    );

    const request: InvoiceRequest = {
        // `SM-<paymentId>` en el primer intento; `-R2`, `-R3`… si la factura
        // anterior se anuló. Sin esto, reemitir después de anular devuelve el
        // MISMO documento anulado (regla 90 de la DIAN).
        referenceCode: await referenciaDelProximoIntento('payment_id', paymentId, `SM-${paymentId}`),
        documentType: 'invoice',
        customer,
        items: [{
            codeReference: `PAY-${paymentId.slice(0, 8)}`,
            name: payment.concept || 'Servicio deportivo',
            quantity: 1,
            unitPrice,
            taxRate,
            isExcluded,
        }],
        observation: `Pago SportMaps: ${payment.concept ?? ''}`.trim(),
        // Medio de pago real ('transfer' | 'cash' | 'pse' | 'card' | 'other' |
        // null); el adaptador lo traduce al código de la DIAN. 'card' se
        // precisa a crédito/débito cuando la pasarela lo dijo (ver la tabla
        // de mapeo en resolvePaymentMethodCode).
        paymentMethod: await refinarMedioDeTarjeta(paymentId, payment.payment_method),
        // Que Factus le mande la factura por correo SOLO a quien la pidió y
        // dejó correo, y solo si la escuela lo activó en su facturador
        // (`enviar_factura_por_correo`). Apagado = como hoy (send_email false).
        ...(decision.origen === 'preferencia' && customer.email && envioPorCorreoHabilitado(cfg)
            ? { sendEmail: true } : {}),
    };

    return runEmission({ ownerType, ownerId, cfg, request, link: { payment_id: paymentId } });
}

// ─── Origen 2: ventas de marketplace (tiendas/servicios/eventos) ───────────────

export async function emitInvoiceForMarketplaceTx(txId: string): Promise<EmitResult> {
    // Ver el atajo equivalente en emitInvoiceForPayment: acotado a la factura
    // viva y con limit(1), porque un origen puede tener varias filas desde que
    // se pueden anular facturas.
    const { data: existing } = await supabase
        .from('electronic_invoices')
        .select('id, status')
        .eq('marketplace_transaction_id', txId)
        .eq('document_type', 'invoice')
        .in('status', ['accepted', 'sent'])
        .limit(1)
        .maybeSingle();
    if (existing) return { ok: true, invoiceId: existing.id, status: existing.status };

    const { data: tx } = await supabase
        .from('marketplace_transactions')
        .select('id, checkout_type, user_id, vendor_profile_id, order_id, gross_amount, description, status')
        .eq('id', txId)
        .maybeSingle();
    if (!tx) return { ok: false, error: 'tx_not_found' };
    if (tx.status !== 'paid') return { ok: false, error: 'tx_not_paid' };
    if (!tx.user_id) return { ok: false, error: 'tx_without_buyer' };

    // Líneas crudas + resolución de tienda escolar (por school_id del producto).
    type RawLine = { name: string; quantity: number; unitPrice: number };
    const rawLines: RawLine[] = [];
    let schoolIdFromProducts: string | null = null;

    if (tx.order_id) {
        const { data: oi } = await supabase
            .from('order_items')
            .select('quantity, unit_price, product:products(name, school_id)')
            .eq('order_id', tx.order_id);
        for (const row of oi ?? []) {
            const prod: any = Array.isArray((row as any).product) ? (row as any).product[0] : (row as any).product;
            if (prod?.school_id && !schoolIdFromProducts) schoolIdFromProducts = prod.school_id;
            rawLines.push({
                name: prod?.name || 'Producto',
                quantity: Number((row as any).quantity) || 1,
                unitPrice: Number((row as any).unit_price) || 0,
            });
        }
    }
    if (rawLines.length === 0) {
        rawLines.push({
            name: tx.description || `Venta ${tx.checkout_type}`,
            quantity: 1,
            unitPrice: Number(tx.gross_amount) || 0,
        });
    }

    // Emisor: vendor externo (vendor_profile_id) o tienda escolar (school_id del producto).
    let ownerType: OwnerType;
    let ownerId: string;
    if (tx.vendor_profile_id) {
        ownerType = 'vendor';
        ownerId = tx.vendor_profile_id;
    } else if (schoolIdFromProducts) {
        ownerType = 'school';
        ownerId = schoolIdFromProducts;
    } else {
        return { ok: false, error: 'cannot_resolve_owner' };
    }

    const cfg = await resolveInvoiceProvider(ownerType, ownerId);
    if (!cfg) return { ok: false, error: 'no_invoice_provider' };

    const customer = await loadCustomer(tx.user_id);
    if (!customer) return { ok: false, error: 'customer_missing_fiscal_data' };

    const { isExcluded, taxRate } = taxDefaults(cfg);
    const items: InvoiceLine[] = rawLines.map((l, idx) => ({
        codeReference: `MTX-${txId.slice(0, 8)}-${idx + 1}`,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxRate,
        isExcluded,
    }));

    const request: InvoiceRequest = {
        // Sufijo de intento por el mismo motivo que en los pagos: una venta
        // cuya factura se anuló tiene que poder volver a facturarse, y la
        // referencia vieja devuelve el documento anulado.
        referenceCode: await referenciaDelProximoIntento('marketplace_transaction_id', txId, `SM-MTX-${txId}`),
        documentType: 'invoice',
        customer,
        items,
        observation: `Venta SportMaps: ${tx.description ?? tx.checkout_type}`.trim(),
    };

    return runEmission({ ownerType, ownerId, cfg, request, link: { marketplace_transaction_id: txId } });
}

// ─── Origen 3: ventas de tienda (orders / order_items) ────────────────────────

export async function emitInvoiceForOrder(orderId: string): Promise<EmitResult> {
    // Ver el atajo equivalente en emitInvoiceForPayment.
    const { data: existing } = await supabase
        .from('electronic_invoices')
        .select('id, status')
        .eq('order_id', orderId)
        .eq('document_type', 'invoice')
        .in('status', ['accepted', 'sent'])
        .limit(1)
        .maybeSingle();
    if (existing) return { ok: true, invoiceId: existing.id, status: existing.status };

    // Tienda v2 F0 (M-F0-8): la base arma el documento. Solo factura una orden
    // cobrada CON prueba de pago (pasarela o aprobación del vendedor), con el
    // emisor = dueño de la venta (escuela por su tienda; externo por sí mismo,
    // nunca la escuela por un externo), líneas con el IVA de cada producto
    // (incluido, spec 6.3) y una línea de ENVÍO aparte. El trigger
    // trg_guard_factura_orden_pagada repite el control al insertar.
    const { data: payload, error: payloadErr } = await supabase.rpc('order_invoice_payload', { p_order_id: orderId });
    if (payloadErr || !payload) return { ok: false, error: 'order_payload_unavailable' };
    const pl = payload as any;
    if (!pl.invoiceable) return { ok: false, error: String(pl.reason ?? 'order_not_paid') };

    const ownerType = pl.owner_type as OwnerType;
    const ownerId = String(pl.owner_id);

    const cfg = await resolveInvoiceProvider(ownerType, ownerId);
    if (!cfg) return { ok: false, error: 'no_invoice_provider' };

    const customer = await loadCustomer(String(pl.buyer_id));
    if (!customer) return { ok: false, error: 'customer_missing_fiscal_data' };

    const items: InvoiceLine[] = (Array.isArray(pl.lines) ? pl.lines : []).map((l: any) => ({
        codeReference: String(l.code),
        name: String(l.name || 'Producto'),
        quantity: Number(l.quantity) || 1,
        unitPrice: Number(l.unit_price) || 0,          // IVA incluido
        taxRate: Number(l.tax_rate_pct) || 0,
        isExcluded: l.is_excluded === true,
    }));
    if (items.length === 0) return { ok: false, error: 'order_without_items' };

    const request: InvoiceRequest = {
        // Sufijo de intento: ver referenciaDelProximoIntento.
        referenceCode: await referenciaDelProximoIntento('order_id', orderId, `SM-ORD-${orderId}`),
        documentType: 'invoice',
        customer,
        items,
        observation: `Compra tienda SportMaps ${pl.reference ?? ''}`.trim(),
        // Canal de la orden (wompi / mercadopago / transfer / cash_pickup).
        paymentMethod: pl.payment_method,
    };

    return runEmission({ ownerType, ownerId, cfg, request, link: { order_id: orderId } });
}

// ─── Anulación: la nota crédito es lo único que deshace una factura ───────────

/** Código de PostgreSQL para «esa columna no existe» (undefined_column). */
const PG_UNDEFINED_COLUMN = '42703';

export interface VoidInvoiceResult {
    ok: boolean;
    /**
     * Qué se hizo de verdad, y hay que mirarlo antes de decirle a alguien que
     * su factura se anuló ante la DIAN:
     *   'credit_note' → salió una nota crédito real, con su número de la
     *                   resolución consumido. Irreversible.
     *   'discarded'   → NO se emitió nada: la factura nunca llegó a la DIAN
     *                   (rechazo terminal, sin número ni CUFE) y solo se cerró
     *                   el intento de nuestro lado para liberar el cobro.
     */
    mode?: 'credit_note' | 'discarded';
    creditNote?: {
        id: string;
        number: string | null;
        cufe: string | null;
        publicUrl: string | null;
        status: string;
    };
    /** Estado en el que quedó la FACTURA (no la nota crédito). */
    invoiceStatus?: string;
    error?: string;
    /** Explicación para la persona que aprieta el botón. */
    message?: string;
}

/**
 * Anula una factura electrónica emitiendo la nota crédito que la deshace ante
 * la DIAN, y deja el cobro facturable otra vez.
 *
 * POR QUÉ ESTO NO ES UN «BORRAR». Un documento con CUFE existe ante la DIAN
 * para siempre y su número de la resolución queda consumido: no hay
 * `DELETE`, no hay «reemitir corregido». Lo único que la ley contempla es
 * emitir OTRO documento —la nota crédito— que la referencia y la anula. Por eso
 * la fila NUNCA se borra: pasa a status 'void' y guarda con qué nota crédito se
 * anuló. Borrarla destruiría la única prueba de nuestro lado de que ese
 * documento existió.
 *
 * ── Las tres situaciones, que NO son la misma ──
 *
 * El discriminador NO es el `status` de la fila sino si tenemos NÚMERO, y eso
 * sale del contrato del API: `bill_number` (el número de la factura, 'DYTY1')
 * es OBLIGATORIO en la nota crédito. Sin número no hay nada que referenciar —
 * literalmente no se puede construir la petición.
 *
 *   1. CON número (aunque la fila diga 'rejected'): hay un documento fiscal.
 *      Se emite la nota crédito. Es el caso de la factura DYTY1: quedó
 *      'rejected' por regla 90 pero tiene CUFE real, así que el documento está
 *      ante la DIAN y descartarla de nuestro lado la dejaría viva allá y
 *      anulada solo acá.
 *   2. SIN número y 'rejected' o 'draft': el PAC rechazó el contenido o ni
 *      llegó a firmar (400/422, credenciales). NO existe documento, así que
 *      emitir una nota crédito sería quemar un número de la resolución de
 *      notas crédito para anular algo que no existe. Se cierra el intento de
 *      nuestro lado y listo (`mode: 'discarded'`). Es el caso de las 4 filas
 *      con «Client authentication failed» que llevan bloqueando sus pagos desde
 *      julio.
 *   3. SIN número y 'sent' o 'queued': NO SE SABE. El PAC acusó recibo y la
 *      DIAN puede estar validando; el documento pudo nacer con su número
 *      consumido. Acá no se elige: se corta y se pide reconciliar primero
 *      (reconcilePendingInvoices pregunta por reference_code). Descartar sería
 *      afirmar que no existe; anular es imposible porque no hay bill_number.
 *
 * ── Idempotencia ──
 *
 * La nota crédito usa la referencia determinista `NC-<invoiceId>`, sin sufijo
 * de intento (a diferencia de la factura, ver referenciaDelProximoIntento).
 * Es deliberado y es la salvaguarda principal: como el índice único es
 * (owner, reference_code), una factura no puede tener DOS notas crédito por
 * este camino ni aunque alguien apriete el botón diez veces o dos procesos
 * entren a la vez — todos escriben la misma fila y el PAC les devuelve el mismo
 * documento. Reintentar una nota crédito que falló por transporte es seguro por
 * lo mismo.
 */
export async function voidInvoice(params: {
    invoiceId: string;
    correctionConceptCode?: CorrectionConceptCode;
    reason?: string | null;
    actorId?: string | null;
}): Promise<VoidInvoiceResult> {
    const { invoiceId } = params;
    const conceptCode = params.correctionConceptCode ?? CORRECTION_CONCEPT_ANULACION;
    const actorId = params.actorId ?? null;
    const motivo = String(params.reason ?? '').trim().slice(0, CREDIT_NOTE_OBSERVATION_MAX) || null;

    const { data: inv, error: invErr } = await supabase
        .from('electronic_invoices')
        // Una sola cadena literal y sin concatenar: supabase-js DEDUCE el tipo
        // de la fila parseando este string en tiempo de compilación, y un
        // `'a' + 'b'` deja de ser literal para TypeScript — el tipo resultante
        // pasa a ser un error y cada `inv.<campo>` deja de compilar.
        //
        // Tampoco pide las columnas de la anulación (voided_at y compañía): no
        // se usan para decidir nada acá, y no pedirlas hace que TODOS los
        // guards de abajo funcionen aunque la migración 20260910092915 no esté
        // aplicada. Así lo único que falla sin migración es la escritura, que
        // sí avisa con un motivo claro.
        .select('id, owner_type, owner_id, provider, document_type, status, number, prefix, cufe, payment_id, total, taxable_amount, tax_amount, reference_code, customer_snapshot')
        .eq('id', invoiceId)
        .maybeSingle();
    if (invErr) return { ok: false, error: 'invoice_read_failed', message: invErr.message };
    if (!inv) return { ok: false, error: 'invoice_not_found' };

    // Una nota crédito no se anula con otra nota crédito por este camino: eso
    // sería una nota DÉBITO, que es otro documento y otro rango.
    if (inv.document_type !== 'invoice') {
        return {
            ok: false,
            error: 'not_an_invoice',
            message: `Este documento es ${inv.document_type}, no una factura.`,
        };
    }
    if (inv.status === 'void') {
        return {
            ok: false,
            error: 'invoice_already_void',
            invoiceStatus: 'void',
            message: 'La factura ya está anulada.',
        };
    }

    const anulacionLocal = async (mensaje: string): Promise<VoidInvoiceResult> => {
        // voided_by_invoice_id queda NULL A PROPÓSITO: es la marca de que no
        // hubo nota crédito porque no había nada que anular (ver el COMMENT de
        // la columna en la migración 20260910092915).
        const { error } = await supabase.from('electronic_invoices').update({
            status: 'void',
            voided_at: new Date().toISOString(),
            void_reason: motivo,
            voided_by: actorId,
            updated_at: new Date().toISOString(),
        }).eq('id', invoiceId);
        if (error) {
            if (error.code === PG_UNDEFINED_COLUMN) {
                return {
                    ok: false,
                    error: 'void_columns_missing',
                    message: 'Falta aplicar la migración 20260910092915 (columnas de anulación de electronic_invoices).',
                };
            }
            return { ok: false, error: 'void_update_failed', message: error.message };
        }
        return { ok: true, mode: 'discarded', invoiceStatus: 'void', message: mensaje };
    };

    if (!inv.number) {
        // ── Situación 3: no sabemos si el documento existe ────────────────────
        // Los estados descartables son una LISTA BLANCA, no «todo lo que no sea
        // sent/queued»: 'rejected' y 'draft' son los dos únicos en los que
        // podemos afirmar que el PAC no firmó nada. Cualquier otro —'sent',
        // 'queued', o un 'accepted' sin número, que no debería existir— significa
        // que el documento PUDO nacer con su número consumido, y ahí no se
        // elige: se reconcilia primero (reconcilePendingInvoices pregunta al PAC
        // por reference_code). Descartar sería afirmar que no existe.
        if (inv.status !== 'rejected' && inv.status !== 'draft') {
            return {
                ok: false,
                error: 'invoice_pending_reconciliation',
                invoiceStatus: inv.status,
                message:
                    `La factura está en '${inv.status}' y todavía sin número: el PAC pudo haberla creado. ` +
                    'Hay que reconciliarla antes de decidir (sin número no se puede anular, y sin saber no se puede descartar).',
            };
        }

        // Rechazada pero CON CUFE: algo existe del otro lado y no tenemos con
        // qué referenciarlo (`bill_number` es el NÚMERO). No se adivina —
        // reconciliar es lo que trae el número.
        if (inv.cufe) {
            return {
                ok: false,
                error: 'invoice_without_number',
                invoiceStatus: inv.status,
                message: 'La factura tiene CUFE pero no número; sin número no se puede referenciar en la nota crédito.',
            };
        }

        // ── Situación 2: nunca llegó a la DIAN ────────────────────────────────
        return anulacionLocal(
            'La factura nunca se emitió ante la DIAN (rechazo sin número ni CUFE): ' +
            'se cerró el intento y el cobro se puede volver a facturar. No se emitió nota crédito.',
        );
    }

    // ── Situación 1: hay documento fiscal → nota crédito ─────────────────────
    const ownerType = inv.owner_type as OwnerType;

    // includeDisabled: apagar el facturador detiene la EMISIÓN, no la
    // corrección de lo ya emitido. Dynasty está apagada a propósito y es
    // justamente quien tiene la factura que hay que anular; exigir el
    // facturador encendido obligaría a reactivar la emisión —y con ella el
    // riesgo de que el cron dispare las facturas pendientes— para poder
    // corregir un solo documento. Mismo criterio que reconcilePendingInvoices.
    const cfg = await resolveInvoiceProvider(ownerType, inv.owner_id, { includeDisabled: true });
    if (!cfg) return { ok: false, error: 'no_invoice_provider' };

    const adapter = getAdapter(cfg.provider);
    if (!adapter) return { ok: false, error: `adapter_not_found:${cfg.provider}` };
    if (!adapter.emitCreditNote) {
        return {
            ok: false,
            error: `credit_note_not_supported:${cfg.provider}`,
            message: `El facturador ${cfg.provider} no tiene notas crédito implementadas.`,
        };
    }

    // El rango de nota crédito se exige ACÁ, antes de crear la fila y antes de
    // hablar con el PAC. Es OTRO rango que el de facturas, con otro prefijo y
    // otra resolución DIAN, y hoy producción de Dynasty NO lo tiene: solo tiene
    // el de facturas (2697, DYTY). Omitirlo no haría que el PAC «eligiera» el
    // de notas crédito, haría que gastara un número de la resolución de
    // FACTURAS en una nota crédito. Eso no lo arregla el código.
    if (!creditNoteNumberingRangeId(cfg)) {
        return {
            ok: false,
            error: 'missing_credit_note_range',
            message:
                'El facturador no tiene rango de numeración de notas crédito. ' +
                'Hay que crearlo en el portal del PAC y anotar su id en la configuración ' +
                '(credit_note_numbering_range_id) antes de poder anular.',
        };
    }

    // Las líneas de la nota crédito tienen que ser LAS MISMAS de la factura: si
    // los totales no coinciden, la DIAN empareja mal los dos documentos y la
    // anulación queda a medias. Se leen de electronic_invoice_items, que es la
    // copia que guardamos al emitir.
    const { data: itemRows } = await supabase
        .from('electronic_invoice_items')
        .select('line_no, code_reference, name, quantity, unit_price, discount_rate, is_excluded, tax_rate')
        .eq('invoice_id', invoiceId)
        .order('line_no', { ascending: true });

    let items: InvoiceLine[] = (itemRows ?? []).map((it: any) => ({
        codeReference: it.code_reference || `INV-${invoiceId.slice(0, 8)}`,
        name: it.name,
        quantity: Number(it.quantity) || 1,
        unitPrice: Number(it.unit_price) || 0,
        discountRate: Number(it.discount_rate) || 0,
        taxRate: Number(it.tax_rate) || 0,
        isExcluded: it.is_excluded === true,
    }));

    if (items.length === 0) {
        // Puede pasar: la emisión escribe las líneas DESPUÉS de guardar el
        // resultado del PAC, así que un corte entre las dos escrituras deja una
        // factura con número y sin líneas. Se reconstruye una sola línea por el
        // total, que es el dato que la DIAN empareja.
        const total = Number(inv.total) || 0;
        if (total <= 0) {
            return {
                ok: false,
                error: 'invoice_without_items',
                message: 'La factura no tiene líneas ni total guardados: no se puede armar la nota crédito.',
            };
        }
        // El impuesto NO se asume excluido: se deduce de lo que el PAC devolvió
        // al emitir. Clavar «excluido» acá haría que la nota crédito de una
        // venta de tienda (gravada al 19% por defecto en este servicio) anulara
        // el mismo total con otro desglose de impuesto — dos documentos que la
        // DIAN no empareja.
        const taxAmount = Number(inv.tax_amount) || 0;
        const taxable = Number(inv.taxable_amount) || 0;
        const gravado = taxAmount > 0 && taxable > 0;
        items = [{
            codeReference: `INV-${invoiceId.slice(0, 8)}`,
            name: `Anulación factura ${inv.number}`,
            quantity: 1,
            unitPrice: total,                                            // IVA incluido, como el canónico
            taxRate: gravado ? Math.round((taxAmount / taxable) * 100) : 0,
            isExcluded: !gravado,
        }];
    }

    // Medio de pago: el de la factura anulada, no un genérico. Solo lo sabemos
    // cuando el origen es un pago; si no, va null y el adaptador lo traduce a
    // '1' = «no definido», que no afirma nada (a diferencia de '10' = efectivo,
    // que afirmaba en falso).
    let paymentMethod: string | null = null;
    if (inv.payment_id) {
        const { data: pay } = await supabase
            .from('payments').select('payment_method').eq('id', inv.payment_id).maybeSingle();
        paymentMethod = pay?.payment_method ?? null;
    }

    const referenceCode = `NC-${invoiceId}`;
    const observation = motivo
        ?? `${CORRECTION_CONCEPTS[conceptCode]} — factura ${inv.number} (SportMaps)`;

    // ¿Ya hay una nota crédito para esta factura? Se consulta ANTES de tocar
    // nada: el upsert de más abajo escribe status='queued', así que preguntarle
    // el estado a la fila que acaba de devolver el upsert diría siempre
    // 'queued' y este atajo nunca se tomaría — se volvería a llamar al PAC por
    // una nota que ya salió.
    const { data: ncPrevio } = await supabase
        .from('electronic_invoices')
        .select('id, status, number, cufe, public_url')
        .eq('owner_type', inv.owner_type)
        .eq('owner_id', inv.owner_id)
        .eq('reference_code', referenceCode)
        .maybeSingle();

    // Si esta nota crédito YA salió, no se emite otra: se termina de anular la
    // factura y se devuelve la que hay. Cubre el corte entre «el PAC aceptó la
    // nota» y «se marcó la factura anulada», y también a quien aprieta el botón
    // dos veces.
    if (ncPrevio && (ncPrevio.status === 'accepted' || ncPrevio.status === 'sent')) {
        const marcada = await marcarFacturaAnulada({
            invoiceId, ncId: ncPrevio.id as string, motivo, actorId,
        });
        if (!marcada.ok) return marcada;
        return {
            ok: true,
            mode: 'credit_note',
            invoiceStatus: 'void',
            creditNote: {
                id: ncPrevio.id as string,
                number: (ncPrevio.number as string) ?? null,
                cufe: (ncPrevio.cufe as string) ?? null,
                publicUrl: (ncPrevio.public_url as string) ?? null,
                status: ncPrevio.status as string,
            },
            message: 'La nota crédito ya estaba emitida; se completó la anulación de la factura.',
        };
    }

    // Fila de la nota crédito. SIN payment_id / order_id /
    // marketplace_transaction_id, y eso es una decisión, no un descuido: hay
    // tres consultas del frontend que arman «la factura de este pago» con
    // `.in('payment_id', ids).in('status', ['accepted','sent'])` y se quedan con
    // la última fila que llega. Si la nota crédito compartiera payment_id, al
    // padre le aparecería el número de la NOTA CRÉDITO como si fuera su
    // factura. El enlace con el pago se recupera por la factura anulada
    // (voided_by_invoice_id).
    //
    // El upsert reutiliza la fila cuando la hay: una nota crédito que quedó en
    // 'queued' (corte de transporte) o 'rejected' se reintenta con la MISMA
    // referencia, y el PAC devuelve el mismo documento en vez de crear otro.
    const { data: ncRow, error: ncErr } = await supabase
        .from('electronic_invoices')
        .upsert(
            {
                owner_type: inv.owner_type,
                owner_id: inv.owner_id,
                provider: cfg.provider,
                document_type: 'credit_note',
                reference_code: referenceCode,
                status: 'queued',
                currency: 'COP',
                // El adquirente de la nota crédito es el de la factura. No se
                // reconstruye desde `profiles` (que se edita) por lo mismo que
                // el adaptador no manda `customer`: tienen que coincidir.
                customer_snapshot: inv.customer_snapshot,
            },
            { onConflict: 'owner_type,owner_id,reference_code' },
        )
        .select('id')
        .single();
    if (ncErr || !ncRow) {
        return { ok: false, error: 'credit_note_draft_failed', message: ncErr?.message };
    }
    const ncId = ncRow.id as string;

    // El puntero se escribe ANTES de llamar al PAC. Si la petición se pierde en
    // el camino, la nota crédito pudo quedar creada allá con su número
    // consumido, y sin este enlace la fila quedaría huérfana: nadie sabría que
    // esa nota pertenece a esta factura. La factura NO se marca anulada acá —
    // eso solo pasa cuando el PAC confirma.
    const { error: linkErr } = await supabase.from('electronic_invoices')
        .update({ voided_by_invoice_id: ncId, updated_at: new Date().toISOString() })
        .eq('id', invoiceId);
    if (linkErr) {
        if (linkErr.code === PG_UNDEFINED_COLUMN) {
            return {
                ok: false,
                error: 'void_columns_missing',
                message: 'Falta aplicar la migración 20260910092915 (columnas de anulación de electronic_invoices).',
            };
        }
        return { ok: false, error: 'void_update_failed', message: linkErr.message };
    }

    // El adquirente de la nota crédito ES el de la factura original —nunca uno
    // reconstruido desde `profiles` hoy, que se edita— y el PAC lo exige pese
    // a que la doc lo declara opcional (ver el comentario largo de
    // emitCreditNote en factus-v2.adapter.ts: verificado contra el sandbox,
    // omitirlo responde 422). Sin snapshot no hay con qué armar la nota.
    const customer = inv.customer_snapshot as InvoiceCustomer | null;
    if (!customer || !customer.identification) {
        return {
            ok: false,
            error: 'invoice_without_customer_snapshot',
            message: 'La factura no tiene los datos del adquirente guardados: no se puede armar la nota crédito.',
        };
    }

    const request: CreditNoteRequest = {
        referenceCode,
        billNumber: inv.number as string,
        correctionConceptCode: conceptCode,
        customer,
        items,
        observation,
        paymentMethod,
    };

    let result;
    try {
        result = await adapter.emitCreditNote(request, cfg);
    } catch (e: any) {
        // UN FALLO DE TRANSPORTE NO ES UN RECHAZO (ver runEmission). En la nota
        // crédito importa incluso más: si la petición se perdió, la nota pudo
        // quedar creada y su número consumido, así que darla por rechazada
        // sería inventar que no existe y el siguiente intento pediría otra.
        // Queda 'queued' —que reconcilePendingInvoices barre— y la factura NO
        // se anula todavía: reintentar es seguro porque la referencia es la
        // misma y el PAC devuelve el mismo documento.
        const retryable = isRetryablePacError(e);
        const mensaje = e?.message ?? String(e);
        await supabase.from('electronic_invoices').update({
            status: retryable ? 'queued' : 'rejected',
            error_message: retryable ? `${TRANSPORT_ERROR_PREFIX} ${mensaje}` : mensaje,
            updated_at: new Date().toISOString(),
        }).eq('id', ncId);
        return {
            ok: false,
            error: retryable ? 'pac_transport_error' : 'credit_note_failed',
            invoiceStatus: inv.status,
            message: retryable
                ? `No hubo respuesta del facturador (${mensaje}). La factura NO se anuló; volver a intentarlo es seguro.`
                : mensaje,
        };
    }

    await supabase.from('electronic_invoices')
        .update(columnasDelResultado(result))
        .eq('id', ncId);

    // Un rechazo de la nota crédito deja la factura VÁLIDA. Marcarla anulada
    // acá sería el peor final: la factura seguiría viva ante la DIAN y nosotros
    // la contaríamos como anulada, así que el cobro nunca se volvería a
    // facturar y el documento nunca se anularía.
    if (result.status === 'rejected') {
        return {
            ok: false,
            error: 'credit_note_rejected',
            invoiceStatus: inv.status,
            creditNote: {
                id: ncId,
                number: result.number ?? null,
                cufe: result.cufe ?? null,
                publicUrl: result.publicUrl ?? null,
                status: result.status,
            },
            message: result.errorMessage
                ?? 'El facturador rechazó la nota crédito. La factura sigue vigente.',
        };
    }

    // 'sent' cuenta como anulada, igual que cuenta como emitida en la factura:
    // Factus V2 en PRODUCCIÓN responde solo el acuse («Documento en proceso de
    // validación») y valida minutos después. Exigir 'accepted' dejaría toda
    // anulación real sin efecto de nuestro lado, con la nota crédito ya en
    // camino. El número y el CUFE los completa reconcilePendingInvoices.
    const marcada = await marcarFacturaAnulada({ invoiceId, ncId, motivo, actorId });
    if (!marcada.ok) return marcada;

    return {
        ok: true,
        mode: 'credit_note',
        invoiceStatus: 'void',
        creditNote: {
            id: ncId,
            number: result.number ?? null,
            cufe: result.cufe ?? null,
            publicUrl: result.publicUrl ?? null,
            status: result.status,
        },
    };
}

/** Marca la factura anulada por una nota crédito concreta. */
async function marcarFacturaAnulada(params: {
    invoiceId: string;
    ncId: string;
    motivo: string | null;
    actorId: string | null;
}): Promise<VoidInvoiceResult> {
    const { error } = await supabase.from('electronic_invoices').update({
        status: 'void',
        voided_at: new Date().toISOString(),
        void_reason: params.motivo,
        voided_by: params.actorId,
        voided_by_invoice_id: params.ncId,
        updated_at: new Date().toISOString(),
    }).eq('id', params.invoiceId);

    if (error) {
        // La nota crédito YA salió y la factura no se pudo marcar. Se grita en
        // el log porque es el único estado inconsistente que este flujo puede
        // dejar: hay un documento de anulación ante la DIAN y nuestra tabla
        // dice que la factura sigue vigente. Reintentar la anulación lo
        // arregla (la rama de «nota crédito ya emitida» la completa).
        console.error(
            `[invoicing] NOTA CRÉDITO ${params.ncId} EMITIDA pero la factura ${params.invoiceId} ` +
            `no quedó marcada como anulada: ${error.message}`,
        );
        if (error.code === PG_UNDEFINED_COLUMN) {
            return {
                ok: false,
                error: 'void_columns_missing',
                message: 'La nota crédito se emitió, pero falta aplicar la migración 20260910092915 para marcar la factura.',
            };
        }
        return { ok: false, error: 'void_update_failed', message: error.message };
    }
    return { ok: true };
}

// ─── Triggers automáticos (barridos idempotentes) ──────────────────────────────

const AUTO_EMPTY: { scanned: number; emitted: number; failed: number; skipped: number; bloqueadas?: string[] } = { scanned: 0, emitted: 0, failed: 0, skipped: 0 };
/**
 * Motivos que NO son un fallo: el pago no se puede facturar todavía (o nunca) y
 * no hay nada que reintentar hasta que cambie el dato de fondo.
 */
const SKIP_ERRORS = new Set([
    'customer_missing_fiscal_data',
    'customer_missing_email',
    'customer_missing_municipality',
    'no_invoice_provider',
    'cannot_resolve_owner',
    'payment_not_paid',
    'payment_without_payer',
    'payment_without_school',
    'payment_not_found',
    'order_not_paid',
    'order_without_buyer',
    'order_not_found',
]);

/**
 * ¿Esta fila de electronic_invoices significa que el origen YA está facturado?
 *
 * No alcanza con «existe una fila»: el barrido anterior descartaba cualquier
 * fila en accepted/sent/queued/rejected, y con eso una fila que quedó en
 * 'queued' porque el proceso murió entre el upsert y la llamada al PAC contaba
 * como facturada para siempre, sin rescate posible.
 *
 *   accepted         → cerrada, no se toca.
 *   void             → ANULADA. Cuenta como facturada A PROPÓSITO, y esa es la
 *                      decisión de diseño de la anulación: la factura ya no
 *                      vale, pero reemitirla es una acción que quema un número
 *                      de la resolución DIAN y no puede dispararla un barrido.
 *                      Casi siempre se anula porque la factura estaba MAL (mal
 *                      monto, mal adquirente); si el cron reemitiera solo, en
 *                      minutos habría un segundo documento con exactamente el
 *                      mismo error y nadie pudo intervenir. Así que anular
 *                      libera el pago para el camino MANUAL
 *                      (POST /invoicing/emit/:paymentId, que sí acepta un
 *                      origen anulado porque su atajo solo mira accepted/sent)
 *                      y lo mantiene fuera del cron y del backfill.
 *   sent             → el PAC la acusó; le falta número, y de eso se encarga
 *                      reconcilePendingInvoices, no una emisión nueva.
 *   queued           → NO hubo acuse. Solo cuenta si la reconciliación ya le
 *                      puso número/CUFE; si no, se puede reintentar (la
 *                      idempotencia por reference_code está confirmada).
 *   rejected         → terminal, SALVO que el motivo sea un fallo nuestro de
 *                      transporte o que el PAC haya frenado la emisión por otra
 *                      factura sin validar (sin número ni CUFE: no se quemó
 *                      nada), que sí se reintentan.
 *   draft            → nunca salió.
 */
function esFacturaEfectiva(row: {
    status?: string | null;
    number?: string | null;
    cufe?: string | null;
    provider_bill_id?: string | null;
    error_message?: string | null;
}): boolean {
    const tieneDocumento = Boolean(row.number || row.cufe || row.provider_bill_id);
    switch (row.status) {
        case 'accepted':
        case 'void':
        case 'sent':
            return true;
        case 'queued':
            return tieneDocumento;
        case 'rejected':
            if (String(row.error_message ?? '').startsWith(TRANSPORT_ERROR_PREFIX)) return false;
            if (!tieneDocumento && esRechazoPorBloqueoDelPac(row.error_message)) return false;
            return true;
        default:
            return false;
    }
}

/** Ids de origen (payments/mtx/orders) que ya tienen factura efectiva. */
async function idsConFacturaEfectiva(
    column: 'payment_id' | 'marketplace_transaction_id' | 'order_id',
    ids: string[],
): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { data } = await supabase
        .from('electronic_invoices')
        .select(`${column}, status, number, cufe, provider_bill_id, error_message`)
        .in(column, ids);
    const set = new Set<string>();
    for (const row of (data ?? []) as any[]) {
        const id = row?.[column];
        if (id && esFacturaEfectiva(row)) set.add(id);
    }
    return set;
}

/** Tamaño de página al buscar candidatos. Acota la consulta, no el trabajo. */
const CANDIDATE_PAGE = 500;

/**
 * Recolecta pagos 'paid' pendientes de facturar, paginando los candidatos.
 *
 * El `.limit(100)` anterior estaba MAL PUESTO: se aplicaba antes de descartar
 * los ya facturados, así que el tope acotaba el universo y no el trabajo — con
 * 100 pagos ya facturados en la ventana, el barrido «no encontraba nada» aunque
 * hubiera pendientes justo detrás. Acá el tope se aplica sobre los pendientes.
 */
async function recolectarPagosPendientes(params: {
    aplicarFiltros: (q: any) => any;
    limit: number;
}): Promise<{ pending: string[]; yaFacturados: number; escaneados: number; truncado: boolean }> {
    const { aplicarFiltros, limit } = params;
    const pending: string[] = [];
    let yaFacturados = 0;
    let escaneados = 0;
    let truncado = false;

    for (let offset = 0; ; offset += CANDIDATE_PAGE) {
        const base = supabase.from('payments').select('id, payment_date').eq('status', 'paid');
        const { data, error } = await aplicarFiltros(base)
            // El desempate por id hace estable la paginación: sin él, dos
            // pagos con la misma payment_date pueden salir en las dos páginas
            // o en ninguna.
            .order('payment_date', { ascending: false, nullsFirst: false })
            .order('id', { ascending: true })
            .range(offset, offset + CANDIDATE_PAGE - 1);
        if (error) {
            console.error('[invoicing] recolectarPagosPendientes', error.message);
            break;
        }
        const ids = ((data ?? []) as any[]).map((p) => p.id as string);
        if (ids.length === 0) break;
        escaneados += ids.length;

        const ya = await idsConFacturaEfectiva('payment_id', ids);
        for (const id of ids) {
            if (ya.has(id)) { yaFacturados++; continue; }
            if (pending.length >= limit) { truncado = true; continue; }
            pending.push(id);
        }

        if (ids.length < CANDIDATE_PAGE) break;
        if (pending.length >= limit) { truncado = true; break; }
    }

    return { pending, yaFacturados, escaneados, truncado };
}

/** Barre pagos 'paid' recientes de escuelas con facturador activo sin factura. */
export async function autoEmitPendingInvoices(
    opts?: { sinceDays?: number; limit?: number },
): Promise<{ scanned: number; emitted: number; failed: number; skipped: number; bloqueadas?: string[] }> {
    const sinceDays = opts?.sinceDays ?? 3;
    const limit = opts?.limit ?? 100;
    const sinceDate = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
    // Sin milisegundos: el valor viaja crudo dentro del `or(...)` de PostgREST
    // y no hay razón para meterle más puntuación de la necesaria.
    const sinceTs = `${sinceDate}T00:00:00Z`;

    const { data: provs } = await supabase
        .from('electronic_invoice_providers')
        .select('owner_id')
        .eq('owner_type', 'school')
        .eq('enabled', true);
    const schoolIds = [...new Set((provs ?? []).map((p) => p.owner_id))];
    if (schoolIds.length === 0) return AUTO_EMPTY;

    // La ventana sigue siendo corta (3 días) A PROPÓSITO: el cron es para el
    // día a día y el rezago se factura con backfillInvoices, que recibe rango
    // explícito. Lo que sí se corrige es el EJE: filtrar solo por payment_date
    // dejaba fuera al pago de mora cargado a mano hoy con fecha de pago vieja,
    // que nacía fuera de la ventana y nadie volvía a mirar. Ahora entra por
    // cualquiera de las dos fechas: la del pago o la de la fila.
    const { pending, escaneados } = await recolectarPagosPendientes({
        limit,
        aplicarFiltros: (q) => q
            .in('school_id', schoolIds)
            .or(`payment_date.gte.${sinceDate},created_at.gte.${sinceTs}`),
    });
    // `scanned` sigue significando lo mismo que antes: pendientes procesados,
    // no candidatos leídos (eso es `escaneados`, que solo se registra en log).
    if (pending.length === 0) {
        if (escaneados > 0) console.log(`[invoicing] barrido: ${escaneados} candidatos, ninguno pendiente`);
        return AUTO_EMPTY;
    }

    // Escuela de cada pendiente, para frenar SOLO a la que el PAC bloquea: un
    // bloqueo es por dueño, y cortar todo el barrido atrasaría a las demás.
    const { data: dueños } = await supabase.from('payments').select('id, school_id').in('id', pending);
    const escuelaDe = new Map<string, string>((dueños ?? []).map((p: any) => [p.id, p.school_id]));
    const bloqueadas = new Set<string>();

    let emitted = 0, failed = 0, skipped = 0;
    for (const id of pending) {
        const escuela = escuelaDe.get(id);
        if (escuela && bloqueadas.has(escuela)) { failed++; continue; }
        try {
            const r = await emitInvoiceForPayment(id);
            if (r.ok) emitted++;
            else if (r.error && SKIP_ERRORS.has(r.error)) skipped++;
            else {
                failed++;
                if (r.error === PAC_BLOQUEADO && escuela) {
                    bloqueadas.add(escuela);
                    console.warn(`[invoicing] el PAC frenó la emisión de la escuela ${escuela} por una factura sin validar; se reintenta en el próximo barrido`);
                }
            }
        } catch { failed++; }
    }
    return { scanned: pending.length, emitted, failed, skipped, bloqueadas: [...bloqueadas] };
}

// ─── Backfill explícito (el camino para el rezago) ────────────────────────────

export interface BackfillDetail {
    paymentId: string;
    outcome: 'emitted' | 'skipped' | 'failed';
    /** Motivo del skip o del fallo. Vacío en una emisión limpia. */
    reason?: string;
    invoiceId?: string;
    status?: string;
    warnings?: string[];
}

export interface BackfillResult {
    /** emitted + skipped + failed: todo pago sobre el que se decidió algo. */
    attempted: number;
    emitted: number;
    skipped: number;
    failed: number;
    details: BackfillDetail[];
    /** Candidatos leídos en el rango (incluye los ya facturados). */
    scanned: number;
    /**
     * true = se alcanzó el tope, así que PUEDE haber más pendientes en el
     * rango: hay que volver a llamar hasta que salga false (la segunda pasada
     * es inofensiva, ya no hay nada que emitir).
     */
    truncated: boolean;
}

const BACKFILL_LIMIT_DEFAULT = 200;
const BACKFILL_LIMIT_MAX = 500;
/** Candidatos que se leen del rango (≤92 días). El tope del admin se aplica después, al emitir. */
const BACKFILL_SCAN_MAX = 5000;

/**
 * Factura el rezago de un dueño en un rango de fechas EXPLÍCITO.
 *
 * Existe porque el cron automático no puede alcanzarlo: su ventana es de 3 días
 * (y así debe quedarse), y de los 147 pagos de septiembre de Dynasty sin
 * factura, 110 caen fuera de esa ventana. Agrandar la ventana del cron habría
 * significado que cualquier despliegue disparara un barrido masivo sin que
 * nadie lo pidiera; esto se dispara a mano, con rango y tope.
 *
 * - `from`/`to` en 'YYYY-MM-DD', AMBOS INCLUSIVE, sobre `payment_date`. Un pago
 *   'paid' sin payment_date (66 en la base) entra por `created_at`, o si no
 *   sería invisible para los dos caminos.
 * - IDEMPOTENTE: descarta los que ya tienen factura efectiva
 *   (`esFacturaEfectiva`) y, por debajo, la idempotencia por reference_code del
 *   PAC garantiza que un reintento devuelva el MISMO documento en vez de
 *   quemar otro número. Llamarla dos veces no duplica nada.
 * - Cada pago que no se factura dice POR QUÉ: sin datos fiscales, sin pagador,
 *   ya facturado, no 'paid', sin facturador configurado, sin municipio.
 * - `dryRun` recorre y clasifica sin emitir nada: es la forma de ver la lista
 *   de trabajo antes de prender el facturador.
 *
 * Con el facturador APAGADO (enabled=false, como está Dynasty hoy) no emite
 * nada: cada pago sale como skipped 'no_invoice_provider'. Es deliberado —
 * prender el facturador es una decisión del dueño, no un efecto del backfill.
 */
export async function backfillInvoices(params: {
    ownerType: OwnerType;
    ownerId: string;
    from: string;
    to: string;
    limit?: number;
    dryRun?: boolean;
}): Promise<BackfillResult> {
    const { ownerType, ownerId, from, to } = params;
    const limit = Math.min(Math.max(1, Number(params.limit ?? BACKFILL_LIMIT_DEFAULT)), BACKFILL_LIMIT_MAX);
    const dryRun = params.dryRun === true;

    const vacio = (reason: string): BackfillResult => ({
        attempted: 0, emitted: 0, skipped: 0, failed: 0,
        details: [{ paymentId: '', outcome: 'skipped', reason }],
        scanned: 0, truncated: false,
    });

    const esFecha = (s: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));
    // El rango es obligatorio y se valida: sin él, una llamada sin parámetros
    // barrería toda la historia de la escuela y emitiría facturas de años
    // anteriores. La decisión de negocio es facturar SOLO septiembre 2026.
    if (!esFecha(from) || !esFecha(to)) return vacio('invalid_date_range');
    if (from > to) return vacio('invalid_date_range');
    if (!ownerId) return vacio('missing_owner');
    // Solo `payments` tiene este camino: un vendor externo no cobra por acá.
    if (ownerType !== 'school') return vacio('owner_type_not_supported');

    // `to` inclusive: para `created_at` (timestamp) hay que comparar contra el
    // día siguiente, si no se pierde todo lo cargado ese último día.
    const diaSiguiente = new Date(`${to}T00:00:00Z`);
    diaSiguiente.setUTCDate(diaSiguiente.getUTCDate() + 1);
    const fromTs = `${from}T00:00:00Z`;
    const toTs = `${diaSiguiente.toISOString().slice(0, 10)}T00:00:00Z`;

    // El tope es de documentos que llegan al PAC, NO de candidatos: se recoge
    // todo el rango y el presupuesto se gasta solo al emitir. Recortar los
    // candidatos al tope dejaba la pasada entera en pagos que se saltan (sin
    // datos fiscales, sin pagador): Dynasty, sept-2026, tope 26 con los 26
    // emitibles a partir del puesto 30 → "no se emitió ninguna" dos veces.
    const { pending, yaFacturados, escaneados, truncado: recoleccionTruncada } = await recolectarPagosPendientes({
        limit: BACKFILL_SCAN_MAX,
        aplicarFiltros: (q) => q
            .eq('school_id', ownerId)
            .or(
                `and(payment_date.gte.${from},payment_date.lte.${to}),` +
                `and(payment_date.is.null,created_at.gte.${fromTs},created_at.lt.${toTs})`,
            ),
    });

    const details: BackfillDetail[] = [];
    let emitted = 0, skipped = 0, failed = 0;

    // Los ya facturados se reportan agregados y no uno por uno: en un rango de
    // un mes son cientos de filas de ruido y el dato que importa es cuántos.
    if (yaFacturados > 0) {
        skipped += yaFacturados;
        details.push({
            paymentId: '',
            outcome: 'skipped',
            reason: `already_invoiced:${yaFacturados}`,
        });
    }

    let truncado = recoleccionTruncada;
    let consumidos = 0;
    for (const paymentId of pending) {
        if (consumidos >= limit) { truncado = true; break; }
        if (dryRun) {
            consumidos++;
            skipped++;
            details.push({ paymentId, outcome: 'skipped', reason: 'dry_run' });
            continue;
        }
        try {
            const r = await emitInvoiceForPayment(paymentId);
            if (r.ok) {
                consumidos++;
                emitted++;
                details.push({
                    paymentId, outcome: 'emitted',
                    invoiceId: r.invoiceId, status: r.status,
                    ...(r.warnings ? { warnings: r.warnings } : {}),
                });
            } else if (r.error && SKIP_ERRORS.has(r.error)) {
                // Saltado = no tocó al PAC: no gasta tope.
                skipped++;
                details.push({ paymentId, outcome: 'skipped', reason: r.error });
            } else {
                consumidos++;
                failed++;
                details.push({
                    paymentId, outcome: 'failed',
                    reason: r.error ?? 'unknown',
                    invoiceId: r.invoiceId,
                    ...(r.warnings ? { warnings: r.warnings } : {}),
                });
            }
        } catch (e: any) {
            consumidos++;
            failed++;
            details.push({ paymentId, outcome: 'failed', reason: e?.message ?? String(e) });
        }
    }

    return {
        attempted: emitted + skipped + failed,
        emitted, skipped, failed, details,
        scanned: escaneados,
        truncated: truncado,
    };
}

/**
 * Completa las facturas que quedaron a medias porque el PAC valida ASÍNCRONO.
 *
 * Factus V2 en producción responde a la emisión solo con un acuse
 * ("Documento en proceso de validación"), sin número ni CUFE: la fila nace en
 * 'sent' con casi todo en null y la DIAN valida minutos después. Sin este
 * barrido esa fila se queda así para siempre — el dueño ve "—" en su tabla y
 * el pagador no tiene factura que abrir, aunque el documento exista y esté
 * validado en el PAC.
 *
 * Pregunta por reference_code (que es nuestro, `SM-<paymentId>`) en vez de por
 * el número, justamente porque el número es lo que no tenemos. Idempotente:
 * volver a correrlo sobre una fila ya completa no cambia nada.
 */
export async function reconcilePendingInvoices(
    opts?: { sinceDays?: number; limit?: number },
): Promise<{ scanned: number; completed: number; stillPending: number; failed: number; stuck: number; stuckOwners: string[] }> {
    const sinceDays = opts?.sinceDays ?? 15;
    const limit = opts?.limit ?? 100;
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

    // 'sent' y 'queued' son los dos estados a medias: enviada sin confirmar, y
    // el upsert previo a llamar al PAC. 'accepted' ya está completa y
    // 'rejected' no tiene nada que reconciliar.
    const { data: rows } = await supabase
        .from('electronic_invoices')
        .select('id, owner_type, owner_id, reference_code, status, cufe, validated_at, document_type, created_at')
        .in('status', ['sent', 'queued'])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (!rows || rows.length === 0) return { scanned: 0, completed: 0, stillPending: 0, failed: 0, stuck: 0, stuckOwners: [] };

    let completed = 0, stillPending = 0, failed = 0;
    const confirmadas = new Set<string>();

    // Una config de facturador por dueño, no por fila: varias facturas de la
    // misma escuela comparten credenciales y token.
    const cfgCache = new Map<string, ProviderConfig | null>();

    for (const row of rows) {
        try {
            const key = `${row.owner_type}:${row.owner_id}`;
            if (!cfgCache.has(key)) {
                // includeDisabled: apagar el facturador detiene la emisión, pero
                // lo ya emitido igual hay que completarlo.
                cfgCache.set(key, await resolveInvoiceProvider(
                    row.owner_type as OwnerType, row.owner_id, { includeDisabled: true },
                ));
            }
            const cfg = cfgCache.get(key);
            if (!cfg) { failed++; continue; }

            const adapter = getAdapter(cfg.provider);
            if (!adapter) { failed++; continue; }

            // Una NOTA CRÉDITO no se busca en la misma colección que una
            // factura: en el PAC son endpoints distintos y preguntar por una
            // nota en el de facturas devuelve «no existe», que es
            // indistinguible de «todavía no validó». Sin esta bifurcación, en
            // producción toda anulación se quedaba con la nota crédito sin
            // número para siempre — y una anulación sin número es una
            // anulación que no se puede demostrar.
            const esNotaCredito = row.document_type === 'credit_note';
            // Un PAC síncrono no implementa estas consultas y no las necesita.
            if (esNotaCredito ? !adapter.fetchCreditNoteByReference : !adapter.fetchByReference) {
                stillPending++;
                continue;
            }

            const result = esNotaCredito
                ? await adapter.fetchCreditNoteByReference!(row.reference_code, cfg)
                : await adapter.fetchByReference!(row.reference_code, cfg);
            if (!result) { stillPending++; continue; }

            // Solo se escribe cuando hay algo nuevo que escribir: si la DIAN
            // sigue sin validar, la fila se queda como está. Un rechazo SÍ es
            // algo nuevo aunque no traiga número.
            if (!result.number && !result.cufe && !result.errorMessage) { stillPending++; continue; }

            await supabase.from('electronic_invoices').update({
                status: result.status,
                provider_bill_id: result.providerBillId ?? null,
                prefix: result.prefix ?? null,
                number: result.number ?? null,
                dian_code: result.dianCode ?? null,
                cufe: result.cufe ?? null,
                qr_url: result.qrUrl ?? null,
                public_url: result.publicUrl ?? null,
                taxable_amount: result.taxableAmount ?? null,
                tax_amount: result.taxAmount ?? null,
                total: result.total ?? null,
                dian_response: result.raw ?? null,
                // El rechazo de la DIAN se sube a error_message para que se vea
                // en la UI; enterrado solo en dian_response nadie lo miraba.
                error_message: result.errorMessage ?? null,
                validated_at: result.validatedAt ? new Date().toISOString() : null,
                updated_at: new Date().toISOString(),
            }).eq('id', row.id);

            // Si la que acabó de confirmarse es una NOTA CRÉDITO, la factura
            // que anula tiene que quedar anulada. Cierra el hueco del corte de
            // transporte: ahí la nota queda 'queued' y la factura sigue
            // 'accepted', así que sin esto habría un documento de anulación
            // vivo ante la DIAN y una factura que nuestra tabla considera
            // vigente — y por lo tanto un cobro que nunca se vuelve a
            // facturar. El filtro por status evita pisar una anulación ya
            // registrada (y su voided_at, que es la fecha real).
            if (esNotaCredito && (result.status === 'accepted' || result.status === 'sent')) {
                const { error: voidErr } = await supabase
                    .from('electronic_invoices')
                    .update({
                        status: 'void',
                        voided_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    })
                    .eq('voided_by_invoice_id', row.id)
                    .neq('status', 'void');
                if (voidErr) {
                    console.error(
                        `[invoicing] nota crédito ${row.id} confirmada pero no se pudo anular su factura: ${voidErr.message}`,
                    );
                }
            }

            if (result.status === 'accepted') { completed++; confirmadas.add(row.id); }
            else stillPending++;
        } catch {
            failed++;
        }
    }

    // Una factura que lleva horas en 'sent'/'queued' bloquea al PAC para TODO el
    // dueño (Factus no emite mientras haya una sin llegar a la DIAN). Se
    // reporta para que alguien la mire antes de que se acumulen rechazos.
    const limiteAtasco = Date.now() - FACTURA_ATASCADA_HORAS * 3_600_000;
    const atascadas = rows.filter((r: any) =>
        !confirmadas.has(r.id) && r.document_type !== 'credit_note' && new Date(r.created_at).getTime() < limiteAtasco);
    const stuckOwners = [...new Set(atascadas.map((r: any) => r.owner_id as string))];

    return { scanned: rows.length, completed, stillPending, failed, stuck: atascadas.length, stuckOwners };
}

/** Horas en 'sent'/'queued' a partir de las cuales una factura se considera atascada. */
export const FACTURA_ATASCADA_HORAS = 3;

/** Barre ventas de marketplace 'paid' recientes sin factura (tienda escolar y externa). */
export async function autoEmitPendingMarketplaceInvoices(
    opts?: { sinceDays?: number; limit?: number },
): Promise<{ scanned: number; emitted: number; failed: number; skipped: number }> {
    const sinceDays = opts?.sinceDays ?? 3;
    const limit = opts?.limit ?? 100;
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

    const { data: txs } = await supabase
        .from('marketplace_transactions')
        .select('id')
        .eq('status', 'paid')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(limit);
    const ids = (txs ?? []).map((t) => t.id);
    if (ids.length === 0) return AUTO_EMPTY;

    // Mismo criterio que el barrido de pagos: una fila 'queued' sin número no
    // es una factura, es una emisión que quedó a medias.
    const already = await idsConFacturaEfectiva('marketplace_transaction_id', ids);
    const pending = ids.filter((id) => !already.has(id));
    let emitted = 0, failed = 0, skipped = 0;
    for (const id of pending) {
        try {
            const r = await emitInvoiceForMarketplaceTx(id);
            if (r.ok) emitted++;
            else if (r.error && SKIP_ERRORS.has(r.error)) skipped++;
            else failed++;
        } catch { failed++; }
    }
    return { scanned: pending.length, emitted, failed, skipped };
}

/** Barre órdenes de tienda 'paid' recientes sin factura (escolar y externa). */
export async function autoEmitPendingOrders(
    opts?: { sinceDays?: number; limit?: number },
): Promise<{ scanned: number; emitted: number; failed: number; skipped: number }> {
    const sinceDays = opts?.sinceDays ?? 3;
    const limit = opts?.limit ?? 100;
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

    // Tienda v2 F0 (M-F0-8): candidatas = tienda prendida + cobradas con prueba
    // de pago (no solo status='paid', que antes un comprador podía escribir).
    const { data: orders } = await supabase.rpc('orders_pending_invoice', { p_since: since, p_limit: limit });
    const ids = ((orders ?? []) as any[]).map((o) => (typeof o === 'string' ? o : o?.orders_pending_invoice ?? o?.id)).filter(Boolean) as string[];
    if (ids.length === 0) return AUTO_EMPTY;

    // Mismo criterio que el barrido de pagos (ver esFacturaEfectiva).
    const already = await idsConFacturaEfectiva('order_id', ids);
    const pending = ids.filter((id) => !already.has(id));
    let emitted = 0, failed = 0, skipped = 0;
    for (const id of pending) {
        try {
            const r = await emitInvoiceForOrder(id);
            if (r.ok) emitted++;
            else if (r.error && SKIP_ERRORS.has(r.error)) skipped++;
            else failed++;
        } catch { failed++; }
    }
    return { scanned: pending.length, emitted, failed, skipped };
}
