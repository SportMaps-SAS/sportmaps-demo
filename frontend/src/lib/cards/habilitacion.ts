/**
 * Habilitación al escanear (carnet 3D F5) — lógica pura, sin React.
 * Spec: docs/specs/carnet-3d-club.md §8. RPC: estado_habilitacion(p_qr_token, p_event_id)
 * (migración 20261126103934). Tabla: school_eligibility_rules.
 *
 * Reglas firmes (D7): el semáforo se consulta en vivo y NUNCA se pinta en el carnet ni en
 * sus exportaciones. El coach ve semáforo + motivo (sin montos); la administración, el
 * acudiente y el deportista adulto ven además cada criterio con su fecha.
 */

export type Semaforo = 'verde' | 'amarillo' | 'rojo';
export type EstadoCriterio = Semaforo | 'no_aplica';
export type NivelHabilitacion = 'coach' | 'admin' | 'acudiente' | 'deportista';
export type ClaveCriterio = 'pagos' | 'seguro' | 'certificado_medico' | 'autorizacion_evento' | 'inscripcion';

export interface CriterioHabilitacion {
  clave: ClaveCriterio | string;
  etiqueta: string;
  estado: EstadoCriterio;
  detalle: string | null;
  fecha: string | null;
}

export interface EventoHabilitacion {
  id: string;
  titulo: string;
  fecha: string | null;
}

export interface EmergenciaHabilitacion {
  blood_type?: string | null;
  eps_name?: string | null;
  emergency_contact?: string | null;
}

export interface ReglasParaEntrar {
  pagos: boolean;
  seguro: boolean;
  certificado_medico: boolean;
  autorizacion_evento: boolean;
  inscripcion: boolean;
  dias_aviso: number;
}

/** Respuesta cruda de la RPC. */
export interface EstadoHabilitacionRpc {
  found: boolean;
  error?: 'evento_no_valido' | string;
  nivel?: NivelHabilitacion;
  semaforo?: Semaforo;
  motivo?: string;
  evento?: EventoHabilitacion | null;
  eventos?: EventoHabilitacion[];
  emergencia?: EmergenciaHabilitacion | null;
  criterios?: CriterioHabilitacion[] | null;
  reglas?: ReglasParaEntrar | null;
  sujeto?: { school_id: string; tipo: 'child' | 'profile' | 'unregistered'; id: string } | null;
}

/** Lo que pinta el panel. */
export type VistaHabilitacion =
  | { tipo: 'sin_acceso' }
  | { tipo: 'evento_no_valido' }
  | {
      tipo: 'ok';
      nivel: NivelHabilitacion;
      semaforo: Semaforo;
      titulo: string;
      motivo: string;
      conDetalle: boolean;
      criterios: CriterioHabilitacion[];
      emergencia: { etiqueta: string; valor: string }[];
      evento: EventoHabilitacion | null;
      eventos: EventoHabilitacion[];
      sujeto: EstadoHabilitacionRpc['sujeto'];
    };

export const REGLAS_POR_DEFECTO: ReglasParaEntrar = {
  pagos: true,
  seguro: false,
  certificado_medico: false,
  autorizacion_evento: false,
  inscripcion: true,
  dias_aviso: 7,
};

export const TITULO_SEMAFORO: Record<Semaforo, string> = {
  verde: 'Habilitado',
  amarillo: 'Habilitado, revisar pronto',
  rojo: 'No habilitado',
};

const SEMAFOROS: Semaforo[] = ['verde', 'amarillo', 'rojo'];
const esSemaforo = (s: unknown): s is Semaforo => typeof s === 'string' && (SEMAFOROS as string[]).includes(s);

const ETIQUETAS_EMERGENCIA: [keyof EmergenciaHabilitacion, string][] = [
  ['blood_type', 'RH'],
  ['eps_name', 'EPS'],
  ['emergency_contact', 'Contacto de emergencia'],
];

/** Filas de emergencia con valor (lo apagado por la escuela ni siquiera viaja). */
export function filasEmergencia(e: EmergenciaHabilitacion | null | undefined): { etiqueta: string; valor: string }[] {
  if (!e) return [];
  return ETIQUETAS_EMERGENCIA
    .map(([k, etiqueta]) => ({ etiqueta, valor: String(e[k] ?? '').trim() }))
    .filter((f) => f.valor !== '');
}

/** El peor estado gana; 'no_aplica' no pesa. */
export function peorEstado(estados: EstadoCriterio[]): Semaforo {
  if (estados.includes('rojo')) return 'rojo';
  if (estados.includes('amarillo')) return 'amarillo';
  return 'verde';
}

/**
 * Normaliza la respuesta de la RPC. Defensa en el cliente: si por cualquier razón el nivel
 * es coach, el detalle (criterios, reglas, sujeto) se descarta aunque viniera.
 */
export function vistaDeEstado(raw: EstadoHabilitacionRpc | null | undefined): VistaHabilitacion {
  if (!raw || !raw.found || !raw.nivel) return { tipo: 'sin_acceso' };
  if (raw.error === 'evento_no_valido') return { tipo: 'evento_no_valido' };
  const conDetalle = raw.nivel !== 'coach';
  const criterios = conDetalle && Array.isArray(raw.criterios) ? raw.criterios : [];
  const semaforo = esSemaforo(raw.semaforo)
    ? raw.semaforo
    : peorEstado(criterios.map((c) => c.estado));
  return {
    tipo: 'ok',
    nivel: raw.nivel,
    semaforo,
    titulo: TITULO_SEMAFORO[semaforo],
    motivo: (raw.motivo ?? '').trim() || TITULO_SEMAFORO[semaforo],
    conDetalle,
    criterios,
    emergencia: filasEmergencia(raw.emergencia),
    evento: raw.evento ?? null,
    eventos: Array.isArray(raw.eventos) ? raw.eventos : [],
    sujeto: conDetalle ? raw.sujeto ?? null : null,
  };
}

/** Fila de school_eligibility_rules (o null = sin fila) → reglas efectivas. */
export function reglasDeFila(fila: Partial<ReglasParaEntrar> | null | undefined): ReglasParaEntrar {
  if (!fila) return { ...REGLAS_POR_DEFECTO };
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    pagos: b(fila.pagos, REGLAS_POR_DEFECTO.pagos),
    seguro: b(fila.seguro, REGLAS_POR_DEFECTO.seguro),
    certificado_medico: b(fila.certificado_medico, REGLAS_POR_DEFECTO.certificado_medico),
    autorizacion_evento: b(fila.autorizacion_evento, REGLAS_POR_DEFECTO.autorizacion_evento),
    inscripcion: b(fila.inscripcion, REGLAS_POR_DEFECTO.inscripcion),
    dias_aviso: normalizarDiasAviso(fila.dias_aviso),
  };
}

/** Días de aviso entre 0 y 60 (CHECK de la tabla); cualquier otra cosa → 7. */
export function normalizarDiasAviso(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return REGLAS_POR_DEFECTO.dias_aviso;
  return Math.min(60, Math.max(0, Math.round(n)));
}

// ─── Documentos con vigencia ────────────────────────────────────────────────

export type TipoDocumentoVigencia = 'sports_insurance' | 'medical_certificate' | 'event_authorization';

export const DOCUMENTOS_VIGENCIA: { tipo: TipoDocumentoVigencia; etiqueta: string; criterio: ClaveCriterio }[] = [
  { tipo: 'sports_insurance', etiqueta: 'Seguro deportivo', criterio: 'seguro' },
  { tipo: 'medical_certificate', etiqueta: 'Certificado médico', criterio: 'certificado_medico' },
  { tipo: 'event_authorization', etiqueta: 'Autorización para el evento', criterio: 'autorizacion_evento' },
];

/** Hoy en Bogotá (UTC-5) como 'YYYY-MM-DD'. */
export function hoyBogota(ahora: Date = new Date()): string {
  return new Date(ahora.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Mismo criterio que el BFF: null si sirve; si no, el mensaje para mostrar. */
export function validarVigencia(
  tipo: TipoDocumentoVigencia,
  venceEl: string | null | undefined,
  eventId: string | null | undefined,
  hoy: string,
): string | null {
  const v = (venceEl ?? '').trim();
  if (v !== '') {
    const d = new Date(`${v}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
      return 'La fecha de vencimiento no es válida.';
    }
    if (v < hoy) return 'Esa fecha ya pasó: el documento está vencido.';
  }
  if (tipo !== 'event_authorization' && v === '') return 'Pon la fecha en que vence.';
  if (tipo === 'event_authorization' && !eventId) return 'Elige el evento.';
  return null;
}

/** '2026-11-29' → '29/11/2026'. */
export function fechaCorta(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
