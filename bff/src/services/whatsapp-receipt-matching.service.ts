/**
 * A qué pago se aplica un comprobante que llegó por WhatsApp.
 *
 * Es el punto delicado de toda la fase: aplicar un comprobante al pago
 * equivocado es tocar dinero de un tercero. En Dynasty hay cientos de pendientes
 * y padres con varios hijos, así que la regla de oro es **no adivinar**: cuando
 * el monto no desempata, se pregunta.
 *
 * Plan: docs/specs/whatsapp-cola-de-comprobantes-plan.md §4.5 y §4.6
 */

import { supabase } from '../config/supabase';
import { categoriaDelCobro } from './tipo-de-cobro';

/** Pago pendiente del acudiente, con lo mínimo para nombrarlo en el chat. */
export interface PagoPendiente {
    id: string;
    amount: number;
    concept: string | null;
    due_date: string | null;
    child_id: string | null;
    atleta: string | null;
    /**
     * De qué es el cobro: 'mensualidad', 'inscripcion', 'seguro', 'torneo'… o
     * cualquier categoría nueva (`categoriaDelCobro`). Opcional: las opciones
     * congeladas en `pregunta_opciones` antes del 2026-10-10 no la traen.
     */
    categoria?: string | null;
    /**
     * Lo que la familia YA no debe por pronto pago (`payments.early_payment_discount_applied`, congelado en el cobro):
     * transfiere `amount − descuento`. Opcional: sin él, todo sigue como antes. (Monster 2026-11: $332.500 de un
     * cobro de $350.000 se leyó como abono y el bot dijo «quedan $17.500».)
     */
    descuento?: number | null;
}

/** Lo que de verdad debe transferir la familia por este cobro: `amount − descuento` (nunca negativo). Pura. */
export function montoAPagar(p: Pick<PagoPendiente, 'amount' | 'descuento'>): number {
    const d = Number(p.descuento ?? 0);
    return Math.max(Number(p.amount) - (Number.isFinite(d) && d > 0 ? d : 0), 0);
}

/** ¿`monto` es lo que debe transferir la familia por este cobro: el valor completo o con el pronto pago (±$1)? Pura. */
export function montoCubreElCobro(p: Pick<PagoPendiente, 'amount' | 'descuento'>, monto: number | null): boolean {
    if (monto === null) return false;
    return Number(p.amount) === monto || (Number(p.descuento ?? 0) > 0 && Math.abs(montoAPagar(p) - monto) <= 1);
}

export type Coincidencia =
    | { tipo: 'unico'; pago: PagoPendiente }
    | { tipo: 'por_monto'; pago: PagoPendiente }
    | { tipo: 'combinacion'; pagos: PagoPendiente[] }
    | { tipo: 'preguntar'; opciones: PagoPendiente[] }
    | { tipo: 'sin_pendientes' };

/**
 * Tope de pendientes para buscar combinaciones. Por encima, la búsqueda se
 * vuelve cara Y ambigua (con 20 pendientes casi cualquier monto suma de varias
 * formas), así que se pregunta en vez de proponer.
 */
const TOPE_COMBINACIONES = 8;

/** Cuántas opciones se ofrecen en el mensaje antes de que sea ilegible. */
export const TOPE_OPCIONES = 5;

/** Pendientes del acudiente en esa escuela, del más viejo al más nuevo. */
export async function pagosPendientesDe(
    parentId: string,
    schoolId: string,
): Promise<PagoPendiente[]> {
    const { data, error } = await supabase
        .from('payments')
        .select('id, amount, early_payment_discount_applied, concept, due_date, child_id, payment_category, payment_type, child:children(full_name)')
        // `user_id`: el atleta ADULTO identificado por su propio número llega
        // como `parentId` (wa_identify_by_phone, migración 20261013165308) y
        // sus cobros pueden tener user_id = él y parent_id vacío.
        .or(`parent_id.eq.${parentId},user_id.eq.${parentId}`)
        .eq('school_id', schoolId)
        .in('status', ['pending', 'overdue'])
        .order('due_date', { ascending: true })
        .limit(50);

    if (error || !data) return [];

    return data.map((p: any) => ({
        id: p.id,
        amount: Number(p.amount),
        concept: p.concept ?? null,
        due_date: p.due_date ?? null,
        child_id: p.child_id ?? null,
        atleta: p.child?.full_name ?? null,
        categoria: categoriaDelCobro(p),
        ...(Number(p.early_payment_discount_applied) > 0 ? { descuento: Number(p.early_payment_discount_applied) } : {}),
    }));
}

/**
 * Subconjuntos cuya suma da exactamente `objetivo`.
 *
 * Corta apenas encuentra dos, porque con dos ya sabemos que es ambiguo y no hay
 * que seguir gastando: la decisión es «preguntar», venga de dos combinaciones o
 * de doscientas.
 */
function subconjuntosQueSuman(pagos: PagoPendiente[], objetivo: number): PagoPendiente[][] {
    const encontrados: PagoPendiente[][] = [];

    const buscar = (desde: number, restante: number, acumulado: PagoPendiente[]) => {
        if (encontrados.length >= 2) return;
        if (restante === 0 && acumulado.length > 0) { encontrados.push([...acumulado]); return; }
        if (restante < 0) return;
        for (let i = desde; i < pagos.length; i++) {
            acumulado.push(pagos[i]);
            buscar(i + 1, restante - pagos[i].amount, acumulado);
            acumulado.pop();
            if (encontrados.length >= 2) return;
        }
    };

    buscar(0, objetivo, []);
    return encontrados;
}

/**
 * Decide a qué pago (o pagos) corresponde un comprobante de `monto`.
 *
 * `monto` null significa que el OCR no pudo leerlo: ahí no se aplica nada por
 * monto, solo vale el caso de un único pendiente.
 */
export function resolverPago(pendientes: PagoPendiente[], monto: number | null): Coincidencia {
    if (pendientes.length === 0) return { tipo: 'sin_pendientes' };

    // Un solo pendiente: no hay a qué otra cosa aplicarlo.
    if (pendientes.length === 1) return { tipo: 'unico', pago: pendientes[0] };

    if (monto !== null) {
        // El monto coincide con EXACTAMENTE uno → se aplica a ese, y la
        // respuesta dice a cuál para que el padre pueda corregir.
        const exactos = pendientes.filter((p) => montoCubreElCobro(p, monto));
        if (exactos.length === 1) return { tipo: 'por_monto', pago: exactos[0] };

        // Varios del MISMO monto: el monto no desempata. Preguntar.
        if (exactos.length > 1) {
            return { tipo: 'preguntar', opciones: exactos.slice(0, TOPE_OPCIONES) };
        }

        // Una transferencia que cubre varios pendientes. Caso real y frecuente:
        // dos hijos, un solo pago por la suma. Solo se propone si hay UNA
        // combinación posible; con dos ya es ambiguo.
        if (pendientes.length <= TOPE_COMBINACIONES) {
            const combos = subconjuntosQueSuman(pendientes, monto);
            if (combos.length === 1) return { tipo: 'combinacion', pagos: combos[0] };
        }
    }

    return { tipo: 'preguntar', opciones: pendientes.slice(0, TOPE_OPCIONES) };
}

const cop = (n: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

/** Normaliza para comparar nombres sin tildes ni mayúsculas. */
const plano = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/**
 * Cómo se nombra un pago en el chat, para que el acudiente lo reconozca.
 *
 * El nombre del atleta solo se agrega si el concepto no lo trae ya. En la base,
 * la mayoría de los conceptos son del estilo "Mensualidad 08/2026 - SARA ISABELLA
 * ROJAS MORENO", y agregarlo igual producía "… - SARA ISABELLA ROJAS MORENO de
 * SARA ISABELLA ROJAS MORENO".
 */
export function describirPago(p: PagoPendiente): string {
    const concepto = p.concept ?? 'Cobro';
    const partes = [concepto];
    if (p.atleta && !plano(concepto).includes(plano(p.atleta))) partes.push(`de ${p.atleta}`);
    partes.push(`por ${cop(p.amount)}`);
    if (p.due_date) partes.push(`(vence ${p.due_date})`);
    return partes.join(' ');
}

/** Lista numerada para que el acudiente elija, cuando el monto no desempata. */
export function mensajeElegirPago(opciones: PagoPendiente[]): string {
    const lineas = opciones.map((p, i) => `${i + 1}. ${describirPago(p)}`);
    return (
        'Recibí tu comprobante, pero tienes varios cobros pendientes y no quiero ' +
        'aplicarlo al que no es 🤔\n\n' +
        `${lineas.join('\n')}\n\n` +
        'Toca el botón o respóndeme con el número (o el mes) al que corresponde.'
    );
}
