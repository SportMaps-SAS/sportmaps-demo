/**
 * Pago por plazos (lado familia) — wrappers del BFF /api/v1/payment-agreements.
 * Contrato: docs/contratos-api-oleada-1-2026-11-06.md §2.
 * Montos en pesos enteros; la última cuota absorbe el redondeo.
 */
import { bffClient, BFFError } from '@/lib/api/bffClient';

export interface AjustesPlazos {
    habilitado: boolean;
    max_cuotas: number;
    max_dias: number;
    auto_aprobar: boolean;
}

export interface CuotaCalendario {
    seq: number;
    fecha: string;
    monto: number;
}

export type MotivoAprobacion =
    | 'mas_cuotas_del_tope'
    | 'mas_dias_del_tope'
    | 'sin_autoaprobacion'
    | 'incumplio_antes';

export interface VistaPreviaPlazos {
    saldo_total: number;
    cuotas: CuotaCalendario[];
    primera_fecha: string;
    ultima_fecha: string;
    dias: number;
    requiere_aprobacion: boolean;
    motivos: MotivoAprobacion[];
    topes?: { max_cuotas?: number; max_dias?: number };
    cobros?: unknown[];
}

export interface CuerpoVistaPrevia {
    school_id: string;
    payment_ids: string[];
    cuotas?: number;
    fechas?: string[];
    montos?: number[];
}

export interface AcuerdoCreado {
    agreement_id: string;
    status: string;
    auto_aprobado: boolean;
    total: number;
    cuotas: number;
}

export type EstadoAcuerdo = 'solicitado' | 'activo' | 'cumplido' | 'incumplido' | 'rechazado' | 'cancelado';
export type EstadoCuota = 'pendiente' | 'pagado' | 'vencido';

export interface CuotaDeAcuerdo {
    id?: string;
    due_date: string;
    amount: number;
    status: EstadoCuota | string;
}

/** La forma exacta de /mine no está cerrada en el contrato: todo lo que no es id/status es opcional. */
export interface AcuerdoPropio {
    id: string;
    status: EstadoAcuerdo | string;
    school_id?: string;
    created_at?: string;
    items?: CuotaDeAcuerdo[];
    cobros?: Array<{ concept?: string | null; payment_id?: string }>;
}

export const settings = (schoolId: string) =>
    bffClient.get<AjustesPlazos>(`/api/v1/payment-agreements/settings/${schoolId}`);

export const vistaPrevia = (cuerpo: CuerpoVistaPrevia) =>
    bffClient.post<VistaPreviaPlazos>('/api/v1/payment-agreements/preview', cuerpo);

export const crear = (cuerpo: { school_id: string; payment_ids: string[]; items: { due_date: string; amount: number }[] }) =>
    bffClient.post<AcuerdoCreado>('/api/v1/payment-agreements', cuerpo);

export const misAcuerdos = () =>
    bffClient.get<{ acuerdos: AcuerdoPropio[] }>('/api/v1/payment-agreements/mine');

export const cancelar = (id: string) =>
    bffClient.post<{ agreement_id: string; status: string }>(`/api/v1/payment-agreements/${id}/cancel`, {});

/** Mensaje en español para mostrarle a la familia a partir del error del BFF. */
export function mensajeErrorPlazos(e: unknown): string {
    if (e instanceof BFFError) {
        const cuerpo = (e.body ?? {}) as { error?: string; code?: string };
        const clave = cuerpo.error ?? cuerpo.code ?? '';
        const mapa: Record<string, string> = {
            fecha_pasada: 'Una de las fechas ya pasó. Elige fechas desde hoy en adelante.',
            fechas_desordenadas: 'Las fechas deben ir una después de la otra.',
            suma_distinta_del_saldo: 'Las cuotas no suman el valor de tus cobros. Vuelve a ver el calendario.',
            datos_invalidos: 'Revisa las cuotas y las fechas e inténtalo otra vez.',
            acuerdos_apagados: 'Esta escuela no tiene activo el pago por plazos.',
            cobro_ya_en_acuerdo: 'Uno de esos cobros ya está en otro acuerdo.',
            cobro_no_elegible: 'Alguno de esos cobros no se puede pagar por plazos.',
            acuerdo_no_encontrado: 'No encontramos ese acuerdo.',
            estado_invalido: 'Ese acuerdo ya no se puede cambiar.',
        };
        if (mapa[clave]) return mapa[clave];
        if (e.status === 503) return 'Esta función todavía no está disponible. Inténtalo más tarde.';
        if (e.status === 403) return 'No tienes permiso para hacer esto.';
    }
    return 'No pudimos completar la acción. Inténtalo de nuevo en un momento.';
}
