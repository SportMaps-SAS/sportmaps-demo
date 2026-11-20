/**
 * whatsapp-excedente.service — lo que pasa cuando un comprobante por WhatsApp
 * NO es exactamente el valor del cobro (informe Dynasty 2026-10-13, §6).
 *
 * Decisión de la escuela: si pagan de más, se toma el pago igual. En orden:
 *   a. Recargo del enlace de pago (cobro + % online del ENLACE): pago completo.
 *      Lo detecta `montosConRecargo` (cobro-por-texto) con los enlaces que trae
 *      `cargarRecargos`; al aprobar, la base deja gross_amount = lo recibido.
 *   b. Suma exacta de varios cobros: el principal (el más antiguo) lleva el
 *      comprobante y los demás quedan en revisión con el mismo archivo
 *      (`cubrirCobrosConComprobante` → RPC wa_cubrir_cobros_con_comprobante).
 *   c. Lo demás: se aplica al cobro y lo de más queda como SALDO A FAVOR cuando
 *      la escuela aprueba (trigger trg_payments_saldo_a_favor_al_aprobar,
 *      migración 20261013165308). El bot no aprueba ni escribe amount_paid.
 *   d. Monto MENOR: sigue como antes (la escuela no recibe abonos).
 *
 * También: las «huellas» que se guardan en `pregunta_ocr` de la fila de la
 * cola (sha, lectura, referencias) para que la bandeja la cierre sola cuando
 * se decida el pago (filasParaAutocierrePorDecision y el trigger
 * trg_wa_bandeja_cerrar_por_pago).
 */

import { supabase } from '../config/supabase';
import { normalizeReference } from './receipt-verdict';
import { montosConRecargo } from './whatsapp-cobro-por-texto.service';
import type { PagoPendiente } from './whatsapp-receipt-matching.service';
import type { OcrResult } from './ocr.service';

const cop = (n: number) => `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n)}`;

/**
 * Montos con recargo de cada cobro (id → montos), leídos de sus enlaces de pago.
 * Cualquier estado del enlace: la familia pudo pagar con un link guardado. Un
 * error de lectura deja el mapa vacío (se decide como antes, sin recargo).
 *
 * Mora (2026-10-14): se relee `amount`/`amount_paid` del cobro para descartar
 * los enlaces cuya base quedó vieja (creados antes de que `apply_late_fees()`
 * sumara la mora). Ver `montosConRecargo`. Si esa lectura falla se usa el
 * monto que trae el pendiente.
 */
export async function cargarRecargos(schoolId: string, cobros: PagoPendiente[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (!cobros.length) return out;
    try {
        const ids = cobros.map((c) => c.id);
        const [enlacesRes, cobrosRes] = await Promise.all([
            supabase.from('payment_links')
                .select('payment_id, gross_amount, base_amount, fee_pct')
                .eq('school_id', schoolId)
                .in('payment_id', ids)
                .limit(200),
            supabase.from('payments')
                .select('id, amount, amount_paid, early_payment_discount_applied')
                .eq('school_id', schoolId)
                .in('id', ids)
                .limit(200),
        ]);
        const { data, error } = enlacesRes;
        if (error || !Array.isArray(data)) return out;
        const actuales = new Map<string, { amount: number; pagado: number }>();
        if (!cobrosRes.error && Array.isArray(cobrosRes.data)) {
            for (const r of cobrosRes.data as any[]) {
                const amount = Number(r?.amount);
                // Lo ya cubierto: abonos + descuento por pronto pago (saldoPorCobrar).
                const pagado = (Number(r.amount_paid ?? 0) || 0) + (Number(r.early_payment_discount_applied ?? 0) || 0);
                if (r?.id && Number.isFinite(amount)) actuales.set(r.id, { amount, pagado });
            }
        }
        for (const c of cobros) {
            const enlaces = (data as any[]).filter((l) => l?.payment_id === c.id);
            const actual = actuales.get(c.id);
            const montos = montosConRecargo(actual?.amount ?? Number(c.amount), enlaces, actual?.pagado ?? 0);
            if (montos.length) out.set(c.id, montos);
        }
    } catch { /* sin recargos */ }
    return out;
}

/**
 * Lo que espera el veredicto: el monto con recargo si es eso lo que llegó; si
 * no, el cobro. `recargos` ya viene sin los enlaces de base vieja (mora,
 * `cargarRecargos`): un comprobante por el valor de antes de la mora espera el
 * cobro actual y sale MONTO_DIFIERE / abono, no pago completo. Pura.
 */
export function montoEsperado(pago: PagoPendiente, monto: number | null, recargos: Map<string, number[]>): number {
    if (monto !== null && (recargos.get(pago.id) ?? []).includes(monto)) return monto;
    // Pronto pago congelado en el cobro: lo que debe decir el comprobante es amount − descuento (si no, sale MONTO_DIFIERE).
    if (monto !== null && Number(pago.descuento ?? 0) > 0 && Math.abs(Number(pago.amount) - Number(pago.descuento) - monto) <= 1) return monto;
    return Number(pago.amount);
}

/** Lo que se le dice a la familia cuando pagó de más. Pura. */
export function textoExcedente(excedente: number): string {
    return `Pagaste ${cop(excedente)} de más: cuando la escuela apruebe el pago quedan como *saldo a favor* ` +
        'y se descuentan de tu próximo cobro.';
}

// ─── Referencias del comprobante ─────────────────────────────────────────────

/**
 * Etiquetas de números que un comprobante puede traer ADEMÁS de la referencia
 * que eligió el OCR. Caso del informe: «Recibo 1234…» y «Aprob. 5678…» en el
 * mismo comprobante; el pago quedó con una y la fila con la otra.
 */
const ETIQUETA_REF = /\b(?:aprob(?:aci[oó]n)?|autorizaci[oó]n|recibo|comprobante|referencia|ref|cus|operaci[oó]n|transacci[oó]n|n[uú]mero de aprobaci[oó]n)\b\.?\s*(?:n[oº°]\.?|#|:)?\s*:?\s*([A-Z0-9][A-Z0-9-]{5,29})/gi;

/**
 * La referencia del OCR y las alternativas que aparecen ETIQUETADAS en el texto
 * del comprobante (cruda y normalizada, sin repetir). Solo valores de 6+
 * caracteres con al menos un dígito: «OK» o «Nequi» chocarían con cualquier
 * cosa. El texto del comprobante no es confiable para decidir; aquí solo sirve
 * para ENLAZAR por igualdad exacta con un pago que ya tiene esa referencia.
 * Pura.
 */
export function referenciasDelComprobante(ocr: Pick<OcrResult, 'reference' | 'rawText'> | null | undefined): string[] {
    const out = new Set<string>();
    const agregar = (v: string | null | undefined) => {
        const crudo = String(v ?? '').trim();
        if (crudo.length < 6 || !/\d/.test(crudo)) return;
        out.add(crudo);
        const norm = normalizeReference(crudo);
        if (norm && norm.length >= 6) out.add(norm);
    };
    agregar(ocr?.reference ?? null);
    const texto = String(ocr?.rawText ?? '');
    for (const m of texto.matchAll(ETIQUETA_REF)) agregar(m[1]);
    return [...out].slice(0, 10);
}

/**
 * `pregunta_ocr` de una fila que NO queda esperando a la familia: el mismo
 * formato que deja el worker en `esperarAlUsuario` (ocr, sha, storagePath,
 * parentId) + `referencias`. Sin el texto crudo del comprobante (no se usa
 * para enlazar y lleva datos de terceros). Pura.
 */
export function huellasDelComprobante(e: {
    sha: string | null | undefined;
    ocr: OcrResult | null | undefined;
    storagePath?: string | null;
    parentId?: string | null;
}): Record<string, unknown> | null {
    if (!e.sha && !e.ocr) return null;
    const ocr = e.ocr
        ? {
            amount: e.ocr.amount ?? null,
            reference: e.ocr.reference ?? null,
            destination: e.ocr.destination ?? null,
            date: e.ocr.date ?? null,
            bank: e.ocr.bank ?? null,
            // (2026-11-16) Quién pagó, la nota y el titular del destino: sin esto 247 filas quedaron imposibles de auditar.
            // La nota va recortada (puede traer datos de terceros; el texto crudo del comprobante NO se guarda).
            originName: e.ocr.originName ?? null,
            description: e.ocr.description ? String(e.ocr.description).replace(/\s+/g, ' ').trim().slice(0, 300) : null,
            destinationName: e.ocr.destinationName ?? null,
        }
        : null;
    return {
        sha: e.sha ?? null,
        ocr,
        storagePath: e.storagePath ?? null,
        parentId: e.parentId ?? null,
        referencias: referenciasDelComprobante(e.ocr ?? null),
    };
}

// ─── Un comprobante, varios cobros ───────────────────────────────────────────

/**
 * Los cobros de una suma exacta, del más antiguo al más nuevo: el primero es el
 * principal (lleva referencia, sha y veredicto). Pura.
 */
export function ordenarDelMasAntiguo(cobros: PagoPendiente[]): PagoPendiente[] {
    return [...cobros].sort((a, b) => String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')));
}

/**
 * Deja en revisión, con el MISMO comprobante, los cobros que cubre además del
 * principal (ya estampado). Una transacción en la base. Nunca lanza.
 */
export async function cubrirCobrosConComprobante(
    schoolId: string,
    principalId: string,
    otros: string[],
): Promise<{ ok: boolean; cubiertos: number; error?: string }> {
    if (!otros.length) return { ok: true, cubiertos: 0 };
    try {
        const { data, error } = await supabase.rpc('wa_cubrir_cobros_con_comprobante', {
            p_school_id: schoolId, p_principal_id: principalId, p_cobros: otros,
        });
        if (error) return { ok: false, cubiertos: 0, error: error.message };
        return { ok: true, cubiertos: Number(data ?? 0) };
    } catch (err: any) {
        return { ok: false, cubiertos: 0, error: String(err?.message ?? err) };
    }
}
