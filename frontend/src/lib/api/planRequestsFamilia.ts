/**
 * Pausa, retiro y reactivación del plan (lado familia) — BFF /api/v1/plan-requests.
 * Contrato: docs/contratos-api-oleada-1-2026-11-06.md §3. El canal de origen es `channel`, no `source`.
 */
import { bffClient, BFFError } from '@/lib/api/bffClient';

export type TipoSolicitud = 'pausa' | 'retiro' | 'reactivacion';
export type EstadoSolicitud = 'solicitado' | 'aprobado' | 'rechazado' | 'cancelado';
export type MotivoPausa = 'injury' | 'vacation' | 'other';

export interface SolicitudPlan {
    id: string;
    tipo: TipoSolicitud;
    enrollment_id: string;
    school_id: string;
    estado: EstadoSolicitud;
    atleta_nombre: string | null;
    desde: string | null;
    hasta: string | null;
    motivo: string | null;
    detalle_motivo: string | null;
    canal: string | null;
    solicitante_rol: string | null;
    auto_aprobada: boolean | null;
    fuera_de_tope: boolean | null;
    nota_administracion: string | null;
    creada_at: string;
    resuelta_at: string | null;
}

export interface RespuestaPausa {
    request_id: string;
    status: 'approved' | 'pending';
    auto_aprobada: boolean;
    fuera_de_tope: boolean;
    meses?: number;
    tope?: number;
    usados?: number;
}

export const pedirPausa = (c: {
    enrollment_id: string; reason: MotivoPausa; month_from: string; month_to: string; note?: string;
}) => bffClient.post<RespuestaPausa>('/api/v1/plan-requests/pausa', c);

export const pedirRetiro = (c: { enrollment_id: string; exit_date: string; reason?: string }) =>
    bffClient.post<{ request_id: string; status: string; kind: string; effective_date: string }>(
        '/api/v1/plan-requests/retiro', c);

export const pedirReactivacion = (c: { enrollment_id: string; from_month: string; reason?: string }) =>
    bffClient.post<{ request_id?: string; status?: string }>('/api/v1/plan-requests/reactivacion', c);

export const misSolicitudes = () =>
    bffClient.get<{ solicitudes: SolicitudPlan[] }>('/api/v1/plan-requests/mias');

export const cancelarSolicitud = (tipo: TipoSolicitud, id: string) =>
    bffClient.delete<{ status: string }>(`/api/v1/plan-requests/${tipo}/${id}`);

/** Los 422 traen el texto en español listo para mostrar. */
export function mensajeErrorPlan(e: unknown): string {
    if (e instanceof BFFError) {
        if (e.status === 422 && e.message) return e.message;
        if (e.status === 409) return 'Ya hay una solicitud abierta o resuelta para esas fechas.';
        if (e.status === 403) return 'Solo puede pedirlo la familia titular de esta inscripción.';
        if (e.status === 503) return 'Esta función todavía no está disponible. Inténtalo más tarde.';
        if (e.status === 400) return 'Revisa las fechas e inténtalo otra vez.';
    }
    return 'No pudimos enviar la solicitud. Inténtalo de nuevo en un momento.';
}

/** `true` si el error es «migración pendiente»: la función aún no existe y no se debe mostrar nada. */
export function esFuncionNoDisponible(e: unknown): boolean {
    return e instanceof BFFError && e.status === 503;
}
