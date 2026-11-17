/**
 * Constancia de «recibido» cuando el pago se registra SIN comprobante.
 *
 * Caso origen (Monster's Volley, 11-nov-2026): una mensualidad quedó pagada sin
 * comprobante y sin rastro de cómo, cuándo ni quién recibió la plata. En el modal
 * «Cobros y pagos» el medio (`method`) y la fecha (`payment_date`) ya son
 * obligatorios; esto exige además QUIÉN la recibió (`received_by`, persona del
 * equipo) y la deja escrita en `payments.notes` con un prefijo estable:
 *
 *   [Recibido: efectivo · 2026-11-11 · por Alejandra L.]
 *
 * Mismo formato que frontend/src/lib/payments/constanciaDeRecibido.ts.
 *
 * Alcance: SOLO este camino (BFF → create_charge_batch). No toca pagos con
 * comprobante, pasarelas, bot ni la carga masiva con service_role. La RPC no
 * recibe notas, así que se anotan después, con un UPDATE por cobro (lote de un
 * solo atleta: un puñado de filas).
 */
import { supabase } from '../config/supabase';
import { CobrosError } from './charge-batches.service';
import type { ChargeBatchRequest } from './charge-batches.schemas';

export const PREFIJO_RECIBIDO = '[Recibido:';
const ETIQUETA: Record<string, string> = { cash: 'efectivo', transfer: 'transferencia', other: 'otro medio' };
const MAX_POR = 80;

export const limpiarPor = (t?: string | null): string =>
    String(t ?? '').replace(/[\r\n[\]·]+/g, ' ').replace(/\s+/g, ' ').trim();

type Pago = NonNullable<ChargeBatchRequest['payment']>;

/** Sin comprobante y sin `received_by` → 422. Con comprobante, o sin pago: no hace nada. */
export function verificarConstanciaDeRecibido(b: Pick<ChargeBatchRequest, 'payment'>): void {
    const p = b.payment;
    if (!p || p.receipt_url) return;
    if (limpiarPor(p.received_by).length < 2) {
        throw new CobrosError(
            422,
            'RECIBIDO_POR_OBLIGATORIO',
            'Este pago no tiene comprobante: escribe quién del equipo recibió la plata.',
        );
    }
}

export function lineaRecibido(p: Pick<Pago, 'method' | 'payment_date' | 'received_by'>): string {
    return `${PREFIJO_RECIBIDO} ${ETIQUETA[p.method] ?? p.method} · ${p.payment_date} · por ${limpiarPor(p.received_by).slice(0, MAX_POR)}]`;
}

export function notasConRecibido(previas: string | null | undefined, linea: string): string {
    const resto = String(previas ?? '').split('\n').filter((l) => !l.trim().startsWith(PREFIJO_RECIBIDO)).join('\n').trim();
    return resto ? `${linea}\n${resto}` : linea;
}

/**
 * Anota la constancia en los cobros que ESTA operación dejó pagados o abonados.
 * Nunca lanza: el pago ya quedó hecho; si falla se devuelve false (y la ruta lo registra).
 */
export async function anotarRecibido(
    schoolId: string,
    batchId: string | undefined,
    data: Record<string, unknown>,
    payment: Pago | null | undefined,
): Promise<boolean> {
    if (!payment || payment.receipt_url || !batchId || data.duplicated === true) return true;
    const ids = [...((data.paid_ids as string[] | undefined) ?? []), ...((data.partial_ids as string[] | undefined) ?? [])];
    if (ids.length === 0) return true;
    try {
        const linea = lineaRecibido(payment);
        const { data: filas, error } = await supabase
            .from('payments')
            .select('id, notes')
            .in('id', ids)
            .eq('school_id', schoolId)
            .eq('charge_batch_id', batchId)
            .in('status', ['paid', 'partial']);
        if (error) return false;
        const resultados = await Promise.all((filas ?? []).map((f: { id: string; notes: string | null }) =>
            supabase.from('payments').update({ notes: notasConRecibido(f.notes, linea) }).eq('id', f.id).eq('school_id', schoolId)));
        return resultados.every((r) => !r.error);
    } catch {
        return false;
    }
}
