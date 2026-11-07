/**
 * Pago por plazos (familia) — funciones puras: reparto de cuotas, fechas y textos.
 * El valor que vale lo calcula el BFF (`/preview`); esto es solo para sugerir y validar en pantalla.
 * Ningún texto habla de mora, deuda ni atraso.
 */
import type { AcuerdoPropio, MotivoAprobacion } from '@/lib/api/acuerdosDePagoFamilia';

/** Reparte `saldo` (pesos enteros) en `n` cuotas; la última absorbe el redondeo. */
export function repartirCuotas(saldo: number, n: number): number[] {
    const total = Math.max(0, Math.round(saldo));
    const cuotas = Math.max(1, Math.floor(n));
    const base = Math.floor(total / cuotas);
    const lista = Array.from({ length: cuotas }, () => base);
    lista[cuotas - 1] = total - base * (cuotas - 1);
    return lista;
}

const dosDigitos = (n: number) => String(n).padStart(2, '0');

/** Suma `k` meses a una fecha `AAAA-MM-DD`; si el día no existe en el mes destino queda el último día. */
export function sumarMeses(iso: string, k: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    const destino = new Date(Date.UTC(y, m - 1 + k, 1));
    const ultimo = new Date(Date.UTC(destino.getUTCFullYear(), destino.getUTCMonth() + 1, 0)).getUTCDate();
    return `${destino.getUTCFullYear()}-${dosDigitos(destino.getUTCMonth() + 1)}-${dosDigitos(Math.min(d, ultimo))}`;
}

/** Fechas sugeridas: la primera cuota dentro de un mes y las demás cada mes. */
export function fechasSugeridas(n: number, hoy: string): string[] {
    return Array.from({ length: Math.max(1, n) }, (_, i) => sumarMeses(hoy, i + 1));
}

/** Devuelve el mensaje de error de las fechas elegidas, o null si están bien. */
export function validarFechas(fechas: string[], hoy: string): string | null {
    if (fechas.length === 0 || fechas.some((f) => !/^\d{4}-\d{2}-\d{2}$/.test(f))) {
        return 'Elige la fecha de cada cuota.';
    }
    if (fechas.some((f) => f < hoy)) return 'Las fechas deben ser de hoy en adelante.';
    for (let i = 1; i < fechas.length; i++) {
        if (fechas[i] <= fechas[i - 1]) return 'Cada cuota debe ser en una fecha posterior a la anterior.';
    }
    return null;
}

export const TEXTO_MOTIVO: Record<MotivoAprobacion, string> = {
    mas_cuotas_del_tope: 'Pediste más cuotas de las que la escuela aprueba directamente.',
    mas_dias_del_tope: 'La última cuota queda más lejos de lo que la escuela aprueba directamente.',
    sin_autoaprobacion: 'Esta escuela revisa cada solicitud de pago por plazos.',
    incumplio_antes: 'Antes tuviste un acuerdo que no se completó, así que esta vez lo revisa la escuela.',
};

export function textoMotivo(m: string): string {
    return TEXTO_MOTIVO[m as MotivoAprobacion] ?? 'La escuela necesita revisar esta solicitud.';
}

export const ETIQUETA_ESTADO_ACUERDO: Record<string, string> = {
    solicitado: 'En revisión de la escuela',
    activo: 'Activo',
    cumplido: 'Completado',
    incumplido: 'Cerrado sin completar',
    rechazado: 'No aprobado',
    cancelado: 'Cancelado',
};

export const ETIQUETA_ESTADO_CUOTA: Record<string, string> = {
    pendiente: 'Por pagar',
    pagado: 'Pagada',
    vencido: 'Por regularizar',
};

/** Estados en los que todavía se puede cancelar el acuerdo. */
export const ACUERDO_CANCELABLE = ['solicitado', 'activo'];

/** Próxima fecha de pago de un acuerdo (la cuota pendiente más cercana), o null. */
export function proximaFecha(a: Pick<AcuerdoPropio, 'items'>): string | null {
    const fechas = (a.items ?? [])
        .filter((i) => i.status !== 'pagado')
        .map((i) => i.due_date)
        .sort();
    return fechas[0] ?? null;
}

/** `2026-11-20` a `20/11/2026`. */
export function fechaLegible(iso: string): string {
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}

export interface CobroAbierto {
    id: string;
    school_id: string;
    concept: string;
    /** Saldo por pagar en pesos (solo para mostrar; el BFF recalcula). */
    saldo: number;
    due_date?: string | null;
}

/** Estados de cobro que se pueden dividir en cuotas (los demás ya están pagos, en revisión o anulados). */
export const ESTADOS_DIVISIBLES = ['pending', 'overdue', 'partial'];

/** Cobros abiertos de la pantalla de pagos a la forma que usa «Pagar por plazos». */
export function cobrosParaPlazos(
    ts: Array<{
        id: string; status: string; school_id?: string; concept?: string; amount: number;
        balance_pending?: number; amount_paid?: number; due_date?: string | null;
    }>,
): CobroAbierto[] {
    return ts
        .filter((t) => !!t.school_id && ESTADOS_DIVISIBLES.includes(t.status))
        .map((t) => ({
            id: t.id,
            school_id: t.school_id as string,
            concept: t.concept || 'Cobro',
            saldo: Math.max(0, Math.round(t.balance_pending ?? (Number(t.amount) - Number(t.amount_paid ?? 0)))),
            due_date: t.due_date ?? null,
        }))
        .filter((c) => c.saldo > 0);
}
