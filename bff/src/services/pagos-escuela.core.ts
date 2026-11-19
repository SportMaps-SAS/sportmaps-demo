/**
 * Núcleo común de «una pasarela avisó el resultado de un cobro de escuela (SCH-*)».
 *
 * Antes cada pasarela tenía su copia de `handleSchoolPayment` (routes/wompi.ts y
 * routes/mercadopago.ts). Esta función es ESA lógica, una sola vez; lo que difiere
 * entre pasarelas entra por `PoliticaCobroEscuela`.
 *
 * REGLA DE LA F1 (docs/specs/pasarela-bold-y-adaptador-de-proveedores.md §2.2): cero
 * cambio de conducta. Las diferencias que Wompi y Mercado Pago tenían entre sí se
 * conservaron como política, NO se «arreglaron» al unificar; están congeladas por
 * routes/pagos-escuela.caracterizacion.test.ts. Si algún día Mercado Pago debe
 * adoptar las protecciones de Wompi (doble pago, 500 si falla el UPDATE, autopay),
 * se cambia su política en un commit aparte, con decisión explícita.
 *
 * Pasarela nueva (Bold, etc.) = una política nueva, no otra copia de esto.
 */

import { supabase } from '../config/supabase';
import { todayInZone } from '../utils/businessDate';
import { sendPaymentAttemptFailedEmails } from './paymentFailureEmail.service';

// ─── Helpers compartidos (vivían en routes/wompi.ts; wompi.ts los re-exporta) ───

/**
 * Lo que dijo el banco, pelado, para meterlo en una notificacion.
 *
 * Distinto de `buildFailureReason`: ese arma la cadena tecnica que se guarda en
 * last_failure_reason (con el codigo del proveedor y el tx). Esto es lo que
 * lee un padre en su celular, asi que va sin prefijos ni ids.
 */
export function bankMessageFrom(rawTransaction?: any): string | null {
    const mensaje = rawTransaction?.status_message ?? rawTransaction?.status_detail ?? null;
    if (!mensaje) return null;
    return String(mensaje).slice(0, 160);
}

/**
 * Motivo del intento fallido, en formato legible por `parsePaymentFailure` del
 * frontend: `<proveedor>_<estado> · <medio> · <mensaje del banco> (tx=…)`.
 *
 * El mensaje del banco es lo unico que hace util el chip: sin el, la escuela
 * lee "rechazado" y sigue sin saber si la familia tiene que llamar al banco o
 * cambiar de medio. Wompi lo manda en `status_message` (p.ej. "La transaccion
 * fue rechazada (Rechazo General)" o el texto del reto 3DS).
 */
export function buildFailureReason(
    provider: 'wompi' | 'mp',
    internalStatus: string,
    paymentMethodType?: string | null,
    rawTransaction?: any,
    txId?: string,
): string {
    const partes = [`${provider}_${internalStatus}`];

    if (paymentMethodType) partes.push(String(paymentMethodType));

    // Se recorta: last_failure_reason no es un log, es el texto de un chip.
    const mensaje = rawTransaction?.status_message ?? rawTransaction?.status_detail ?? null;
    if (mensaje) partes.push(String(mensaje).slice(0, 160));

    return `${partes.join(' · ')}${txId ? ` (tx=${txId})` : ''}`;
}

/**
 * Concilia lo que entró por la pasarela contra lo que el cobro pide HOY.
 *
 * El enlace congela `base_amount` al crearse (y vive días: el de WhatsApp se
 * paga cuando la familia puede). Entre la firma y el pago el cobro puede:
 *   - BAJAR (un descuento) → sobrepago (I35): queda `paid` y a revisión.
 *   - SUBIR (el recargo por mora de `apply_late_fees`, decisión 2026-10-14:
 *     la mora nunca se condona en silencio y todo canal cobra el monto CON
 *     recargo) → faltante: NO puede quedar `paid`. Queda `partial` con lo
 *     recibido en `amount_paid`, con rastro visible SIN bloqueo
 *     (record_payment_failure), y el saldo se cobra aparte.
 *
 * Se compara `base_amount` (lo cobrado sin el recargo online, que es de la
 * escuela) contra el saldo vigente: amount − amount_paid − pronto pago (misma
 * regla que frontend/src/lib/cobrosYPagos.ts). Tolerancia de 1 COP, la misma
 * del chequeo de monto del webhook.
 *
 * Si el cobro no se pudo leer o no tiene monto, no se concilia (0/0): se
 * conserva el comportamiento de siempre antes que inventar una diferencia.
 */
export interface ConciliacionMonto {
    /** Monto vigente del cobro (`payments.amount`). */
    montoVigente: number;
    /** Lo recibido sin el recargo online (`payment_links.base_amount`). */
    recibidoBase: number;
    /** Saldo que el cobro pedía antes de este pago. */
    saldo: number;
    /** > 0 → pagó de más. */
    sobrepago: number;
    /** > 0 → pagó de menos; el cobro queda `partial`. */
    faltante: number;
    /** `amount_paid` a escribir, o null si no hay que tocarlo. */
    amountPaidNuevo: number | null;
}

export function conciliarMontoRecibido(
    cobro: { amount?: unknown; amount_paid?: unknown; early_payment_discount_applied?: unknown } | null | undefined,
    baseAmountLink: unknown,
): ConciliacionMonto {
    const montoVigente = Number(cobro?.amount);
    const recibidoBase = Number(baseAmountLink);
    const pagadoAntes = Math.max(0, Number(cobro?.amount_paid) || 0);
    const pronto = Math.max(0, Number(cobro?.early_payment_discount_applied) || 0);

    if (!Number.isFinite(montoVigente) || montoVigente <= 0 || !Number.isFinite(recibidoBase)) {
        return { montoVigente, recibidoBase, saldo: NaN, sobrepago: 0, faltante: 0, amountPaidNuevo: null };
    }

    const saldo = montoVigente - pagadoAntes - pronto;
    // El sobrepago se mide como siempre (contra amount, descontando solo los
    // abonos previos): el pronto pago no entra para no marcar de más cobros
    // que el enlace siempre cobró completos.
    const sobrepago = recibidoBase > montoVigente - pagadoAntes + 1
        ? Math.round(recibidoBase - (montoVigente - pagadoAntes))
        : 0;
    const faltante = recibidoBase < saldo - 1 ? Math.round(saldo - recibidoBase) : 0;

    // amount_paid solo se escribe cuando aporta: si hubo diferencia o ya había
    // abonos (el total pagado es la suma). Un pago exacto sin abonos lo deja
    // como estaba, igual que antes.
    const amountPaidNuevo = sobrepago > 0 || faltante > 0 || pagadoAntes > 0
        ? Math.round(pagadoAntes + recibidoBase)
        : null;

    return { montoVigente, recibidoBase, saldo, sobrepago, faltante, amountPaidNuevo };
}

/**
 * Motivo legible del pago parcial, para last_failure_reason (lo lee la escuela
 * en el chip de revisión). Si el cobro tiene recargo por mora se dice; si no,
 * se dice solo que el cobro subió.
 */
export function motivoPagoParcial(
    base: string,
    c: ConciliacionMonto,
    lateFeeAmount: unknown,
): string {
    const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
    const causa = Number(lateFeeAmount) > 0
        ? 'recargo por mora aplicado después de generar el enlace'
        : 'el cobro subió después de generar el enlace';
    return `${base} · Pagó ${cop(c.recibidoBase)}; faltan ${cop(c.faltante)} (${causa}; cobro ${cop(c.montoVigente)})`;
}

// ─── Núcleo ─────────────────────────────────────────────────────────────────

type Fila = Record<string, any>;

export interface ResultadoCobro {
    status: number;
    body: Record<string, unknown>;
}

/** El aviso de la pasarela, ya normalizado. */
export interface EventoCobroEscuela {
    /** Logger del request (`req.log`); puede no haber. */
    log?: any;
    /** Id de la transacción en la pasarela. */
    txId: string;
    /** Referencia propia del cobro (`SCH-…`). */
    referencia: string;
    internalStatus: 'paid' | 'rejected' | 'refunded' | 'failed' | 'pending';
    /** Monto recibido, en pesos. */
    monto: number;
    /** Medio (CARD/PSE/NEQUI en Wompi; payment_type_id en MP). */
    tipoMedio?: string | null;
    /** Transacción cruda de la pasarela (mensaje del banco, estado). */
    crudo: any;
}

/** Ganchos del débito automático (solo Wompi los usa hoy). */
export interface GanchosAutopay {
    alResultado(a: { attemptId: string; paymentId: string; txId: string; reference: string; linkId: string; internalStatus: string }): Promise<unknown>;
    cobroDoble(a: { paymentId: string; schoolId: string; txId: string; amount: number; attemptId: string | null; reference: string; linkId: string }): Promise<unknown>;
}

/**
 * Lo que cambia de una pasarela a otra. Cada campo documenta la diferencia que
 * HOY existe entre Wompi y Mercado Pago (ver el spec, §2.2).
 */
export interface PoliticaCobroEscuela {
    /** Prefijo de los mensajes de log: 'School payment' | 'MP school payment'. */
    prefijoLog: string;
    /** Texto del log cuando no hay enlace ('payment_link not found' | 'link not found'). */
    textoLinkNoEncontrado: string;
    /** Primer argumento de `buildFailureReason`. */
    claveMotivo: 'wompi' | 'mp';
    /** Columna de `payment_links` donde vive la referencia. */
    columnaReferenciaLink: 'wompi_reference' | 'provider_reference';
    /** Columna de `payment_splits` donde vive el id de la transacción (idempotencia). */
    columnaTxSplit: 'wompi_transaction_id' | 'provider_transaction_id';
    /** Columnas que se leen de `payment_links`. */
    columnasLink: string;
    /** Columnas que se leen de `payments` antes de conciliar. */
    columnasPagoActual: string;
    /** Cuerpo del 400 cuando el monto no coincide. */
    errorMontoDistinto: string;
    /**
     * Doble pago: si hay valor, un cobro ya `paid` con OTRA transacción no se pisa
     * (va a revisión). `columnaTxPago` es la columna de `payments` que guarda la tx.
     * Mercado Pago NO lo tiene: hoy su segundo pago pisa el primero.
     */
    doblePago: { columnaTxPago: 'wompi_transaction_id' } | null;
    /** Si el UPDATE de `payments` falla: Wompi devuelve 500 (reintentable); MP solo lo registra. */
    fallaUpdatePagoDevuelve500: boolean;
    /** Texto del log cuando falla ese UPDATE. */
    textoFallaUpdatePago: string;
    /** Formato de los montos dentro del motivo del sobrepago. */
    formatoMontoSobrepago(n: number): string;
    /** Valor de `payments.payment_method` (debe cumplir payments_payment_method_check). */
    metodoDePago(tipoMedio?: string | null): string;
    /** Columnas propias de la pasarela en el UPDATE de `payments`. */
    columnasProveedorPago(ev: EventoCobroEscuela): Fila;
    /** Fila completa de `payment_splits`. */
    filaSplit(ev: EventoCobroEscuela, link: Fila): Fila;
    /** Débito automático (Wompi). null = la pasarela lo ignora. */
    autopay: GanchosAutopay | null;
}

const ahora = () => new Date().toISOString();

/**
 * Aplica el resultado de un cobro de escuela. Devuelve la respuesta HTTP que el
 * webhook debe dar (status + body). No hace dedup de webhooks ni valida firmas: eso
 * es de quien la llama.
 */
export async function aplicarPagoDeEscuela(pol: PoliticaCobroEscuela, ev: EventoCobroEscuela): Promise<ResultadoCobro> {
    const { log, txId, referencia, internalStatus, monto, tipoMedio, crudo } = ev;

    // 1. Buscar payment_link por referencia
    const { data: link, error: linkErr } = await supabase
        .from('payment_links')
        .select(pol.columnasLink)
        .eq(pol.columnaReferenciaLink, referencia)
        .maybeSingle() as { data: Fila | null; error: any };

    if (linkErr || !link) {
        log?.warn({ txReference: referencia, externalRef: referencia }, `${pol.prefijoLog}: ${pol.textoLinkNoEncontrado}`);
        return { status: 200, body: { status: 'ignored', reason: 'link_not_found' } };
    }

    // 2. Idempotencia
    const { data: existingSplit } = await supabase
        .from('payment_splits')
        .select('id')
        .eq(pol.columnaTxSplit, txId)
        .maybeSingle();

    if (existingSplit) {
        return { status: 200, body: { status: 'already_processed' } };
    }

    // Débito automático: el enlace lo creó el motor (autopay.service) para un intento.
    const autopayAttemptId: string | null = pol.autopay && link.origin === 'autopay' ? link.recurring_attempt_id ?? null : null;

    if (internalStatus === 'paid') {
        // 3. Verificar monto
        if (Math.abs(monto - Number(link.gross_amount)) > 1) {
            log?.error(
                { expected: link.gross_amount, received: monto, txReference: referencia, externalRef: referencia },
                `${pol.prefijoLog}: amount mismatch`,
            );
            return { status: 400, body: { error: pol.errorMontoDistinto } };
        }

        const today = todayInZone();

        const { data: actual } = await supabase
            .from('payments')
            .select(pol.columnasPagoActual)
            .eq('id', link.payment_id)
            .maybeSingle() as { data: Fila | null };

        // 3.b Doble pago (solo Wompi). Desde 2026-10-06 el link con monto sale por
        //     WhatsApp: una familia puede pagar con él DESPUÉS de haber transferido
        //     (y la escuela aprobado el comprobante) o con un link viejo de otra
        //     referencia del mismo cobro. Antes el UPDATE pisaba el pago ya
        //     registrado. Ahora: el dinero entró, así que se deja el link 'paid' y el
        //     split (registro de la plata), NO se toca el cobro y se marca para
        //     revisión con el motivo — la escuela decide si devuelve.
        if (pol.doblePago && actual?.status === 'paid' && actual?.[pol.doblePago.columnaTxPago] !== txId) {
            await supabase
                .from('payment_links')
                .update({ status: 'paid', paid_at: ahora(), updated_at: ahora() })
                .eq('id', link.id);
            await supabase.from('payment_splits').insert(pol.filaSplit(ev, link));
            const { error: flagErr } = await supabase.rpc('flag_payment_for_review', {
                p_kind: 'payment',
                p_id: link.payment_id,
                p_reason: buildFailureReason(pol.claveMotivo, 'doble_pago', tipoMedio, null, txId),
            });
            if (flagErr) {
                log?.error({ err: flagErr, paymentId: link.payment_id }, 'No se pudo marcar el doble pago para revisión');
            }
            // §8.3 del débito: si el cobro es del débito automático, incidente + suspensión.
            if (pol.autopay) {
                try {
                    await pol.autopay.cobroDoble({
                        paymentId: link.payment_id, schoolId: link.school_id, txId, amount: monto,
                        attemptId: autopayAttemptId, reference: referencia, linkId: link.id,
                    });
                } catch (e: any) {
                    log?.error({ err: e?.message, paymentId: link.payment_id }, 'autopay: no se pudo registrar el cobro doble');
                }
            }
            log?.warn({ paymentId: link.payment_id, txReference: referencia, txId }, `${pol.prefijoLog}: el cobro ya estaba pagado — doble pago a revisión`);
            return { status: 200, body: { status: 'ok', kind: 'school_payment', duplicate_payment: true } };
        }

        // 4. Marcar payment como pagado.
        const payMethod = pol.metodoDePago(tipoMedio);

        // 3.c Sobrepago (spec cobros-multiples I35, §13.10c) y 3.d Faltante (mora,
        //     decisión 2026-10-14): ver `conciliarMontoRecibido`. La plata ya entró;
        //     el cobro queda paid (con revisión) o partial (sin bloqueo), nunca se
        //     reabre ni se condona la mora en silencio.
        const conc = conciliarMontoRecibido(actual as any, link.base_amount);
        const { montoVigente, recibidoBase, sobrepago, faltante } = conc;
        const { error: payUpdErr } = await supabase
            .from('payments')
            .update({
                status: faltante > 0 ? 'partial' : 'paid',
                payment_channel: 'online',
                payment_method: payMethod,
                payment_date: today,
                approved_at: ahora(),
                // payment_provider se sella SIEMPRE explícito (DIN-3): sin él, un pago
                // confirmado por webhook queda con payment_provider = NULL.
                ...pol.columnasProveedorPago(ev),
                gross_amount: monto,
                sportmaps_fee: link.sportmaps_fee,
                ...(conc.amountPaidNuevo !== null ? { amount_paid: conc.amountPaidNuevo } : {}),
                updated_at: ahora(),
            })
            .eq('id', link.payment_id);

        // Si el UPDATE del pago falla, en Wompi NO seguimos marcando link/split como
        // si todo hubiera ido bien: 500 → el webhook se marca 'failed' (reintentable)
        // en vez de un falso 'processed'. Mercado Pago solo lo registra (cambiarlo
        // cambiaría sus reintentos: es otro alcance).
        if (payUpdErr) {
            log?.error(
                { err: payUpdErr, paymentId: link.payment_id, txReference: referencia, externalRef: referencia },
                pol.textoFallaUpdatePago,
            );
            if (pol.fallaUpdatePagoDevuelve500) {
                return { status: 500, body: { error: 'payment_update_failed', detail: payUpdErr.message } };
            }
        }

        // La marca va DESPUÉS del UPDATE: el trigger trg_clear_payment_review_on_settle
        // baja requires_review al entrar a 'paid'.
        if (!payUpdErr && sobrepago > 0) {
            const { error: flagErr } = await supabase.rpc('flag_payment_for_review', {
                p_kind: 'payment',
                p_id: link.payment_id,
                p_reason: `${buildFailureReason(pol.claveMotivo, 'sobrepago', tipoMedio, null, txId)} · pagó de más ${pol.formatoMontoSobrepago(sobrepago)} (cobro ${pol.formatoMontoSobrepago(montoVigente)}, recibido ${pol.formatoMontoSobrepago(recibidoBase)})`,
            });
            if (flagErr) {
                log?.error({ err: flagErr, paymentId: link.payment_id }, 'No se pudo marcar el sobrepago para revisión');
            }
            log?.warn({ paymentId: link.payment_id, txReference: referencia, sobrepago }, `${pol.prefijoLog}: recibido mayor que el cobro vigente — a revisión`);
        }

        // Rastro SIN bloqueo (record_payment_failure: last_failure_reason, sin
        // requires_review). NO flag_payment_for_review: ese lock frena todo checkout
        // nuevo del pagador y la familia no podría pagar el saldo en línea.
        if (!payUpdErr && faltante > 0) {
            const { error: flagErr } = await supabase.rpc('record_payment_failure', {
                p_kind: 'payment',
                p_id: link.payment_id,
                p_reason: motivoPagoParcial(
                    buildFailureReason(pol.claveMotivo, 'pago_parcial', tipoMedio, null, txId),
                    conc,
                    (actual as any)?.late_fee_amount,
                ),
            });
            if (flagErr) {
                log?.error({ err: flagErr, paymentId: link.payment_id }, 'No se pudo dejar el rastro del pago parcial');
            }
            log?.warn({ paymentId: link.payment_id, txReference: referencia, faltante }, `${pol.prefijoLog}: recibido menor que el cobro vigente (mora posterior al enlace) — partial, saldo pendiente`);
        }

        // 5. Marcar payment_link
        await supabase
            .from('payment_links')
            .update({ status: 'paid', paid_at: ahora(), updated_at: ahora() })
            .eq('id', link.id);

        // 6. Crear split. MODELO VIGENTE: el recargo por pago online es de la ESCUELA
        //    (cubre la comisión que la pasarela le descuenta) y el dinero entra
        //    completo a su cuenta; SportMaps no participa de la transacción.
        await supabase.from('payment_splits').insert(pol.filaSplit(ev, link));

        // 7. Notificar al staff de la escuela (dispara Modo Recepción + outbox).
        //    No-bloqueante: si falla, el pago ya quedó paid igual.
        const { error: notifErr } = await supabase.rpc('notify_school_payment_paid', {
            p_payment_id: link.payment_id,
        });
        if (notifErr) {
            log?.warn({ err: notifErr, paymentId: link.payment_id }, 'notify_school_payment_paid falló (no-bloqueante)');
        }

        // 7.b Y al PADRE: la función de arriba avisa solo a la escuela.
        const { error: padreErr } = await supabase.rpc('notify_parent_payment_paid', {
            p_payment_id: link.payment_id,
        });
        if (padreErr) {
            log?.warn({ err: padreErr, paymentId: link.payment_id }, 'notify_parent_payment_paid falló (no-bloqueante)');
        }

        if (autopayAttemptId && pol.autopay) {
            try {
                await pol.autopay.alResultado({
                    attemptId: autopayAttemptId, paymentId: link.payment_id, txId, reference: referencia,
                    linkId: link.id, internalStatus,
                });
            } catch (e: any) {
                // El pago ya quedó paid; el intento lo cierra el barrido al reconsultar.
                log?.error({ err: e?.message, attemptId: autopayAttemptId }, 'autopay: no se pudo cerrar el intento aprobado');
            }
        }

        log?.info({ paymentId: link.payment_id, txReference: referencia }, `${pol.prefijoLog} confirmed`);
        return {
            status: 200,
            body: {
                status: 'ok', kind: 'school_payment',
                ...(sobrepago > 0 ? { overpayment: sobrepago } : {}),
                ...(faltante > 0 ? { underpayment: faltante, partial: true } : {}),
            },
        };
    }

    // No-paid (declined/voided/error) → dejar rastro del intento.
    //
    // El error de este UPDATE se lee. Durante meses no se leyó: el CHECK de
    // payment_links no admitía 'declined'/'failed'/'refunded', Postgres tiraba
    // 23514 y los rechazos quedaron con el link en 'pending' y failed_attempts en 0.
    const { error: linkUpdErr } = await supabase
        .from('payment_links')
        .update({
            status: internalStatus === 'rejected' ? 'declined' : internalStatus,
            // Contador, no bandera: tres intentos tienen que leerse como tres.
            failed_attempts: (link.failed_attempts ?? 0) + 1,
            updated_at: ahora(),
        })
        .eq('id', link.id);

    if (linkUpdErr) {
        log?.error(
            { err: linkUpdErr, linkId: link.id, internalStatus },
            'No se pudo marcar el payment_link como fallido — el intento queda sin rastro',
        );
    }

    // Débito automático rechazado: NO es un pago fallido de la familia (no lo intentó
    // ella, no se bloquea ni se le manda el aviso genérico). Se cierra el intento y el
    // motor avisa con la fecha del reintento o que se agotó (§10.1).
    if (autopayAttemptId && pol.autopay) {
        try {
            await pol.autopay.alResultado({
                attemptId: autopayAttemptId, paymentId: link.payment_id, txId, reference: referencia,
                linkId: link.id, internalStatus,
            });
        } catch (e: any) {
            log?.error({ err: e?.message, attemptId: autopayAttemptId }, 'autopay: no se pudo cerrar el intento rechazado');
            return { status: 500, body: { error: 'autopay_finish_failed' } };
        }
        return { status: 200, body: { status: 'ok', kind: 'school_payment', autopay: true, internalStatus } };
    }

    // Solo lo AMBIGUO bloquea. Una declinación ordinaria (el banco dijo que no, o el
    // padre abandonó el PSE) no deja plata en el aire: hay que reintentar. ERROR y
    // VOIDED sí: ahí no sabemos si el dinero se movió, y la fila para hasta que
    // alguien mire.
    const isAmbiguous = internalStatus === 'failed' || internalStatus === 'refunded';
    const reason = buildFailureReason(pol.claveMotivo, internalStatus, tipoMedio, crudo, txId);

    const { error: trailErr } = await supabase.rpc(
        isAmbiguous ? 'flag_payment_for_review' : 'record_payment_failure',
        { p_kind: 'payment', p_id: link.payment_id, p_reason: reason },
    );
    if (trailErr) {
        log?.error({ err: trailErr, paymentId: link.payment_id }, 'No se pudo registrar el fallo del cobro');
    }

    // Avisar a la familia y al staff. No-bloqueante.
    const { error: notifErr } = await supabase.rpc('notify_payment_attempt_failed', {
        p_payment_id: link.payment_id,
        p_reason: bankMessageFrom(crudo),
        p_ambiguous: isAmbiguous,
    });
    if (notifErr) {
        log?.warn({ err: notifErr, paymentId: link.payment_id }, 'notify_payment_attempt_failed falló (no-bloqueante)');
    }

    // Correo, además del in-app: no todo padre vive pendiente de la app.
    void sendPaymentAttemptFailedEmails(link.payment_id, bankMessageFrom(crudo), isAmbiguous, log);

    log?.warn(
        { paymentId: link.payment_id, internalStatus, blocked: isAmbiguous },
        isAmbiguous ? `${pol.prefijoLog} flagged for review` : `${pol.prefijoLog} declined (reintento habilitado)`,
    );
    return {
        status: 200,
        body: { status: 'ok', kind: 'school_payment', internalStatus, flagged_for_review: isAmbiguous },
    };
}
