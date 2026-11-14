/**
 * Solicitudes de plan (pausa, retiro y reactivación) — cliente del BFF y cuentas puras.
 * Contrato: docs/contratos-api-oleada-1-2026-11-06.md §3. Rutas: /api/v1/plan-requests/*.
 */
import { bffClient } from './bffClient';

const BASE = '/api/v1/plan-requests';

export type TipoSolicitud = 'pausa' | 'retiro' | 'reactivacion';
export type EstadoSolicitud = 'solicitado' | 'aprobado' | 'rechazado' | 'cancelado';
export type CanalSolicitud = 'app' | 'whatsapp' | 'admin';

export interface Solicitud {
    id: string;
    tipo: TipoSolicitud;
    enrollment_id: string;
    school_id: string;
    estado: EstadoSolicitud;
    atleta_nombre: string | null;
    desde: string;
    hasta: string | null;
    motivo: string | null;
    detalle_motivo: string | null;
    canal: CanalSolicitud | null;
    solicitante_rol: 'parent' | 'athlete' | 'admin' | null;
    auto_aprobada: boolean;
    fuera_de_tope: boolean;
    nota_administracion: string | null;
    creada_at: string | null;
    resuelta_at: string | null;
}

/** Salida de la RPC al resolver; solo se lee lo que se muestra. */
export interface ResultadoResolver {
    payments_a_revisar?: number | null;
    [k: string]: unknown;
}

export function fetchSolicitudesDeEscuela(schoolId: string, f: { estado?: EstadoSolicitud; tipo?: TipoSolicitud } = {}) {
    const q = new URLSearchParams();
    if (f.estado) q.set('estado', f.estado);
    if (f.tipo) q.set('tipo', f.tipo);
    const s = q.toString();
    return bffClient.get<{ solicitudes: Solicitud[] }>(`${BASE}/escuela/${schoolId}${s ? `?${s}` : ''}`);
}

export interface DecisionSolicitud { decision: 'aprobar' | 'rechazar'; note?: string; dar_de_baja?: boolean }

/** `dar_de_baja` viaja SOLO al aprobar un retiro (el BFF responde 400 si llega en otro tipo). */
export function cuerpoDeResolver(tipo: TipoSolicitud, d: DecisionSolicitud): DecisionSolicitud {
    const body: DecisionSolicitud = { decision: d.decision };
    if (d.note?.trim()) body.note = d.note.trim();
    if (tipo === 'retiro' && d.decision === 'aprobar') body.dar_de_baja = d.dar_de_baja === true;
    return body;
}

export const resolverSolicitud = (tipo: TipoSolicitud, id: string, d: DecisionSolicitud) =>
    bffClient.post<ResultadoResolver>(`${BASE}/${tipo}/${id}/resolver`, cuerpoDeResolver(tipo, d));

// ── Cuentas puras ──────────────────────────────────────────────────────────

export const ETIQUETA_TIPO: Record<TipoSolicitud, string> = { pausa: 'Pausa', retiro: 'Retiro', reactivacion: 'Reactivación' };
export const ETIQUETA_ESTADO_SOLICITUD: Record<EstadoSolicitud, string> = {
    solicitado: 'Por resolver', aprobado: 'Aprobada', rechazado: 'Rechazada', cancelado: 'Cancelada',
};
export const ETIQUETA_CANAL_SOLICITUD: Record<CanalSolicitud, string> = { app: 'App', whatsapp: 'WhatsApp', admin: 'Administración' };
export const ETIQUETA_MOTIVO_PAUSA: Record<string, string> = { injury: 'Lesión', vacation: 'Vacaciones', other: 'Otro motivo' };

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function mesLargo(iso: string | null | undefined): string {
    const m = /^(\d{4})-(\d{2})/.exec(iso ?? '');
    return m ? `${MESES[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : '—';
}
function diaLargo(iso: string | null | undefined): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
    return m ? `${Number(m[3])} de ${MESES[Number(m[2]) - 1] ?? m[2]} de ${m[1]}` : '—';
}

/** «De febrero 2027 a abril 2027» (pausa), «Sale el 30 de noviembre de 2026» (retiro), «Vuelve en enero 2027». */
export function textoFechas(s: Pick<Solicitud, 'tipo' | 'desde' | 'hasta'>): string {
    if (s.tipo === 'pausa') {
        const a = mesLargo(s.desde);
        return !s.hasta || mesLargo(s.hasta) === a ? `En ${a}` : `De ${a} a ${mesLargo(s.hasta)}`;
    }
    if (s.tipo === 'retiro') return `Sale el ${diaLargo(s.desde)}`;
    return `Vuelve en ${mesLargo(s.desde)}`;
}

/** Las por resolver primero (la más antigua arriba); el resto, de la más reciente a la más antigua. */
export function ordenarSolicitudes(lista: Solicitud[]): Solicitud[] {
    const t = (s: Solicitud) => (s.creada_at ? new Date(s.creada_at).getTime() : 0) || 0;
    return [...lista].sort((a, b) => {
        const pa = a.estado === 'solicitado' ? 0 : 1;
        const pb = b.estado === 'solicitado' ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return pa === 0 ? t(a) - t(b) : t(b) - t(a);
    });
}

export function filtrarSolicitudes(lista: Solicitud[], f: { estado: EstadoSolicitud | 'todos'; tipo: TipoSolicitud | 'todos' }): Solicitud[] {
    return lista.filter((s) => (f.estado === 'todos' || s.estado === f.estado) && (f.tipo === 'todos' || s.tipo === f.tipo));
}

export const contarPorResolver = (lista: Solicitud[]) => lista.filter((s) => s.estado === 'solicitado').length;
