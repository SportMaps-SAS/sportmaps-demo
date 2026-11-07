/**
 * Acuerdos de pago (pago por plazos) — cliente del BFF y cuentas puras.
 * Contrato: docs/contratos-api-oleada-1-2026-11-06.md §2 · Spec §5.
 *
 * Rutas: /api/v1/payment-agreements/*. Montos en pesos enteros.
 * Los ajustes por escuela se LEEN por el BFF (GET /settings/:schoolId) y se
 * ESCRIBEN en `school_settings` con el mismo patrón de PaymentsAutomationPage
 * (el BFF no trae endpoint de escritura).
 */
import { bffClient } from './bffClient';

const BASE = '/api/v1/payment-agreements';

export type EstadoAcuerdo = 'solicitado' | 'activo' | 'cumplido' | 'incumplido' | 'rechazado' | 'cancelado';
export type EstadoCuota = 'pendiente' | 'pagado' | 'vencido';
export type CanalAcuerdo = 'whatsapp' | 'app' | 'admin';

export const ESTADOS_ACUERDO: EstadoAcuerdo[] = ['solicitado', 'activo', 'cumplido', 'incumplido', 'rechazado', 'cancelado'];

export interface CuotaAcuerdo {
    id?: string;
    seq: number;
    due_date: string;
    amount: number;
    status: EstadoCuota;
    paid_at?: string | null;
}

export interface Acuerdo {
    id: string;
    school_id: string;
    payer_profile_id: string | null;
    requested_by: string | null;
    status: EstadoAcuerdo;
    source: CanalAcuerdo | null;
    installments: number | null;
    total_amount: number | null;
    first_due_date: string | null;
    last_due_date: string | null;
    auto_approved: boolean | null;
    approved_at: string | null;
    resolution_note: string | null;
    created_at: string;
    items: CuotaAcuerdo[];
    cobros?: Array<{ payment_id: string; balance_at_request: number | null }>;
}

export interface AcuerdosDeEscuela { acuerdos: Acuerdo[]; puede_resolver: boolean }

export interface AjustesAcuerdos {
    habilitado: boolean;
    max_cuotas: number;
    max_dias: number;
    auto_aprobar: boolean;
}

export interface VistaPreviaAcuerdo {
    saldo_total: number;
    cuotas: Array<{ seq: number; fecha: string; monto: number }>;
    primera_fecha: string;
    ultima_fecha: string;
    dias: number;
    requiere_aprobacion: boolean;
    motivos: string[];
    topes: { max_cuotas?: number; max_dias?: number };
    cobros: Array<Record<string, unknown>>;
}

export interface CuotaEntrada { due_date: string; amount: number }

// ── Llamadas ───────────────────────────────────────────────────────────────

export const fetchAjustesAcuerdos = (schoolId: string) =>
    bffClient.get<AjustesAcuerdos>(`${BASE}/settings/${schoolId}`);

export function fetchAcuerdosDeEscuela(schoolId: string, estados?: EstadoAcuerdo[]) {
    const q = estados?.length ? `?estado=${estados.join(',')}` : '';
    return bffClient.get<AcuerdosDeEscuela>(`${BASE}/school/${schoolId}${q}`);
}

export const resolverAcuerdo = (id: string, decision: 'aprobar' | 'rechazar', nota?: string) =>
    bffClient.post<{ agreement_id: string; status: EstadoAcuerdo }>(`${BASE}/${id}/resolve`, { decision, ...(nota?.trim() ? { nota: nota.trim() } : {}) });

export const cancelarAcuerdo = (id: string, nota?: string) =>
    bffClient.post<{ agreement_id: string; status: EstadoAcuerdo }>(`${BASE}/${id}/cancel`, nota?.trim() ? { nota: nota.trim() } : {});

export const vistaPreviaAcuerdo = (body: { school_id: string; payment_ids: string[]; cuotas?: number; fechas?: string[]; montos?: number[] }) =>
    bffClient.post<VistaPreviaAcuerdo>(`${BASE}/preview`, body);

export const crearAcuerdo = (body: { school_id: string; payment_ids: string[]; items: CuotaEntrada[]; payer_profile_id?: string }) =>
    bffClient.post<{ agreement_id: string; status: EstadoAcuerdo; auto_aprobado: boolean; total: number; cuotas: number }>(BASE, body);

/** Guarda los ajustes por el BFF (`PUT /settings/:schoolId`, solo administración de esa escuela). */
export async function guardarAjustesAcuerdos(schoolId: string, a: AjustesAcuerdos): Promise<void> {
    await bffClient.put<AjustesAcuerdos>(`${BASE}/settings/${schoolId}`, {
        habilitado: a.habilitado,
        max_cuotas: a.max_cuotas,
        max_dias: a.max_dias,
        auto_aprobar: a.auto_aprobar,
    });
}

// ── Cuentas puras ──────────────────────────────────────────────────────────

export const ETIQUETA_ESTADO: Record<EstadoAcuerdo, string> = {
    solicitado: 'Por resolver',
    activo: 'Activo',
    cumplido: 'Cumplido',
    incumplido: 'Con cuota sin pagar',
    rechazado: 'Rechazado',
    cancelado: 'Cancelado',
};

export const ETIQUETA_CUOTA: Record<EstadoCuota, string> = { pendiente: 'Pendiente', pagado: 'Pagada', vencido: 'Sin pagar a tiempo' };

export const ETIQUETA_CANAL: Record<CanalAcuerdo, string> = { whatsapp: 'WhatsApp', app: 'App', admin: 'Administración' };

export const ETIQUETA_MOTIVO: Record<string, string> = {
    mas_cuotas_del_tope: 'Pide más cuotas que el tope de la escuela',
    mas_dias_del_tope: 'Se extiende más días que el tope de la escuela',
    sin_autoaprobacion: 'La escuela aprueba cada acuerdo a mano',
    incumplio_antes: 'La familia no cumplió un acuerdo anterior',
};

/** Las solicitudes primero (la más antigua arriba, para atender en orden); el resto, de la más reciente a la más antigua. */
export function ordenarAcuerdos(lista: Acuerdo[]): Acuerdo[] {
    const t = (a: Acuerdo) => new Date(a.created_at).getTime() || 0;
    return [...lista].sort((a, b) => {
        const sa = a.status === 'solicitado' ? 0 : 1;
        const sb = b.status === 'solicitado' ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return sa === 0 ? t(a) - t(b) : t(b) - t(a);
    });
}

export const contarSolicitados = (lista: Acuerdo[]) => lista.filter((a) => a.status === 'solicitado').length;

export function filtrarAcuerdos(lista: Acuerdo[], estado: EstadoAcuerdo | 'todos'): Acuerdo[] {
    return estado === 'todos' ? lista : lista.filter((a) => a.status === estado);
}

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «15 nov 2026» desde AAAA-MM-DD, sin pasar por zona horaria. */
export function fechaCorta(iso: string | null | undefined): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
    if (!m) return '—';
    return `${Number(m[3])} ${MESES_CORTOS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export interface FilaCalendario { seq: number; fecha: string; monto: number; estado?: EstadoCuota }

/** Calendario para pintar: de las cuotas guardadas. */
export function calendarioDeAcuerdo(a: Pick<Acuerdo, 'items'>): FilaCalendario[] {
    return [...(a.items ?? [])].sort((x, y) => x.seq - y.seq).map((i) => ({ seq: i.seq, fecha: fechaCorta(i.due_date), monto: i.amount, estado: i.status }));
}

/** Calendario para pintar: de la vista previa. */
export function calendarioDeVistaPrevia(v: Pick<VistaPreviaAcuerdo, 'cuotas'>): FilaCalendario[] {
    return v.cuotas.map((c) => ({ seq: c.seq, fecha: fechaCorta(c.fecha), monto: c.monto }));
}

/** Texto de resumen: «3 cuotas · del 15 nov 2026 al 15 ene 2027». */
export function resumenCalendario(filas: Array<{ fecha: string }>): string {
    if (!filas.length) return 'Sin cuotas';
    const n = filas.length;
    const cuotas = `${n} ${n === 1 ? 'cuota' : 'cuotas'}`;
    return n === 1 ? `${cuotas} · ${filas[0].fecha}` : `${cuotas} · del ${filas[0].fecha} al ${filas[n - 1].fecha}`;
}

export function textoMotivos(motivos: string[] | undefined): string[] {
    return (motivos ?? []).map((m) => ETIQUETA_MOTIVO[m] ?? m);
}

/** Valida los ajustes antes de guardar; devuelve el mensaje o null. */
export function validarAjustes(a: AjustesAcuerdos): string | null {
    if (!Number.isInteger(a.max_cuotas) || a.max_cuotas < 1 || a.max_cuotas > 24) return 'El tope de cuotas debe ser un número entero entre 1 y 24.';
    if (!Number.isInteger(a.max_dias) || a.max_dias < 1 || a.max_dias > 365) return 'El tope de días debe ser un número entero entre 1 y 365.';
    return null;
}
