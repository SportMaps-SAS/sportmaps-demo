/**
 * Referidos (campaña de descuento) — cliente del BFF `/api/v1/referidos`.
 * Contratos: docs/contratos-api-oleada-1-2026-11-06.md §1. Solo esas rutas.
 * Escritura: owner/admin/school_admin. Lectura: esos + accountant.
 *
 * Todo lo de abajo que no es `referidosApi` es lógica pura (sin red), probada
 * en `src/test/referidos.test.ts`.
 */
import { bffClient } from '@/lib/api/bffClient';
import { supabase } from '@/integrations/supabase/client';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface Tramo {
  age_min: number;
  age_max: number | null;
  pct: number;
}

export interface Campana {
  id?: string;
  name: string;
  active: boolean;
  tiers: Tramo[];
  starts_on: string | null;
  ends_on: string | null;
  max_pending: number;
  require_referrer_current: boolean;
}

export type EstadoReferido =
  | 'sin_confirmar' | 'pendiente' | 'ganado' | 'aplicado' | 'anulado' | 'vencido';

export interface ReferidoRow {
  id: string;
  status: EstadoReferido;
  status_reason?: string | null;
  pct: number;
  age?: number | null;
  referred_age_at_enrollment?: number | null;
  apply_year: number | null;
  apply_month: number | null;
  qualified_at?: string | null;
  created_at?: string | null;
  referred_enrollment_id: string;
  referrer_enrollment_id: string | null;
  referrer_profile_id: string | null;
  referred_name?: string | null;
  referrer_name?: string | null;
  referrer_name_text?: string | null;
  applied_payment_id?: string | null;
  payment_amount?: number | null;
  discount_amount?: number | null;
}

export interface CampanaRespuesta {
  campaign: Campana | null;
  tramos_por_defecto: Tramo[];
}

export interface InformeReferidos {
  school_id: string;
  year: number | null;
  month: number | null;
  rows: ReferidoRow[];
  totals: {
    total: number;
    por_estado: Partial<Record<EstadoReferido, number>>;
    dejado_de_cobrar: number;
  };
  by_month: Array<{ year: number; month: number; aplicados: number; ganados_por_aplicar: number; dejado_de_cobrar: number }>;
}

export interface RegistrarReferidoInput {
  referred_enrollment_id: string;
  referrer_enrollment_id?: string;
  referrer_profile_id?: string;
  referrer_name_text?: string;
}

export type RegistrarReferidoResultado =
  | { ok: true; referral: ReferidoRow }
  | { ok: false; califica: false; motivo: string; edad: number };

export type AccionReferido = 'vincular' | 'cambiar_inscripcion' | 'anular';

export interface ReferenteElegido {
  /** Inscripción del referente (donde se aplica el descuento). */
  enrollmentId?: string;
  profileId?: string;
  /** Texto libre cuando no está en la escuela o todavía no se ubica. */
  texto?: string;
  /** Nombre para mostrar en el chip. */
  nombre: string;
}

// ─── Constantes y lógica pura ────────────────────────────────────────────────

export const TRAMOS_POR_DEFECTO: Tramo[] = [
  { age_min: 4, age_max: 15, pct: 50 },
  { age_min: 16, age_max: null, pct: 25 },
];

export const EDAD_MINIMA_REFERIDO = 4;

export const ESTADO_REFERIDO_LABEL: Record<EstadoReferido, string> = {
  sin_confirmar: 'Sin confirmar',
  pendiente: 'Pendiente',
  ganado: 'Ganado',
  aplicado: 'Aplicado',
  anulado: 'Anulado',
  vencido: 'Vencido',
};

export const ESTADO_REFERIDO_AYUDA: Record<EstadoReferido, string> = {
  sin_confirmar: 'Falta ubicar quién lo refirió.',
  pendiente: 'Se gana cuando pague su primera mensualidad.',
  ganado: 'Ya ganó el descuento; se aplica en la mensualidad del mes indicado.',
  aplicado: 'El descuento ya salió en una mensualidad.',
  anulado: 'La administración lo anuló.',
  vencido: 'Pasó el plazo de la campaña sin ganarse.',
};

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** «diciembre de 2026», o '' si falta el dato. */
export function mesDelDescuento(year: number | null | undefined, month: number | null | undefined): string {
  if (!year || !month || month < 1 || month > 12) return '';
  return `${MESES[month - 1]} de ${year}`;
}

/** Edad en años cumplidos a la fecha `hoy` (ambas AAAA-MM-DD). null si no hay fecha válida. */
export function edadEn(dob: string | null | undefined, hoy: string): number | null {
  if (!dob || !/^\d{4}-\d{2}-\d{2}/.test(dob)) return null;
  const [y, m, d] = dob.slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = hoy.slice(0, 10).split('-').map(Number);
  let edad = ty - y;
  if (tm < m || (tm === m && td < d)) edad -= 1;
  return edad >= 0 ? edad : null;
}

/** Tramo que le toca a esa edad, o null si queda fuera de todos (p. ej. menor de 4). */
export function tramoParaEdad(tiers: Tramo[], edad: number | null): Tramo | null {
  if (edad === null) return null;
  return tiers.find((t) => edad >= t.age_min && (t.age_max === null || edad <= t.age_max)) ?? null;
}

/** Texto corto del tramo: «4 a 15 años: 50 %», «16 años o más: 25 %». */
export function describirTramo(t: Tramo): string {
  const rango = t.age_max === null ? `${t.age_min} años o más` : `${t.age_min} a ${t.age_max} años`;
  return `${rango}: ${t.pct} %`;
}

/** null si los tramos sirven; si no, el mensaje en español para mostrar. */
export function validarTramos(tiers: Tramo[]): string | null {
  if (!tiers.length) return 'Agrega al menos un tramo por edad.';
  const orden = [...tiers].sort((a, b) => a.age_min - b.age_min);
  for (let i = 0; i < orden.length; i++) {
    const t = orden[i];
    if (!Number.isInteger(t.age_min) || t.age_min < 0) return 'La edad inicial de cada tramo debe ser un número entero desde 0.';
    if (t.age_max !== null && (!Number.isInteger(t.age_max) || t.age_max < t.age_min)) {
      return 'La edad final no puede ser menor que la inicial.';
    }
    if (!(t.pct > 0 && t.pct <= 100)) return 'El porcentaje de cada tramo debe estar entre 1 y 100.';
    const sig = orden[i + 1];
    if (sig) {
      if (t.age_max === null) return 'Solo el último tramo puede quedar sin edad final.';
      if (sig.age_min <= t.age_max) return 'Los tramos no pueden cruzarse: revisa las edades.';
    }
  }
  return null;
}

export function validarFechasCampana(starts: string | null, ends: string | null): string | null {
  if (starts && ends && ends < starts) return 'La fecha final no puede ser anterior a la inicial.';
  return null;
}

/** Une «{pct} %» para mostrar un porcentaje sin decimales sobrantes. */
export const fmtPct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1).replace('.', ',')} %`;

export const fmtCOP = (n: number | null | undefined) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(n) || 0);

/** Nombre a mostrar del referente de un renglón. */
export function nombreReferente(r: Pick<ReferidoRow, 'referrer_name' | 'referrer_name_text'>): string {
  return r.referrer_name?.trim() || r.referrer_name_text?.trim() || 'Sin nombre';
}

/** Arma el cuerpo de POST /referidos desde lo que eligió la persona. */
export function armarCuerpoReferido(enrollmentId: string, ref: ReferenteElegido): RegistrarReferidoInput {
  const cuerpo: RegistrarReferidoInput = { referred_enrollment_id: enrollmentId };
  if (ref.enrollmentId) cuerpo.referrer_enrollment_id = ref.enrollmentId;
  else if (ref.profileId) cuerpo.referrer_profile_id = ref.profileId;
  else if (ref.texto?.trim()) cuerpo.referrer_name_text = ref.texto.trim().slice(0, 120);
  return cuerpo;
}

interface ErrorConCodigo {
  status?: number;
  message?: string;
  body?: { code?: string; error?: string; message?: string } | null;
}

export function codigoDeError(e: unknown): string | undefined {
  return (e as ErrorConCodigo | null)?.body?.code;
}

const MENSAJES_REFERIDO: Record<string, string> = {
  REF_CAMPANA_INACTIVA: 'La campaña de referidos está apagada.',
  REF_NO_ES_NUEVO: 'Esta persona ya estaba inscrita antes: solo cuentan los deportistas nuevos.',
  REF_MISMA_FAMILIA: 'No puede referirse a alguien de la misma familia.',
  REF_AUTOREFERIDO: 'Una persona no puede referirse a sí misma.',
  REF_SIN_FECHA_NACIMIENTO: 'Falta la fecha de nacimiento del deportista referido.',
  REF_ESTADO_FINAL: 'Este referido ya quedó cerrado (aplicado, anulado o vencido) y no se puede cambiar.',
  YA_REGISTRADO: 'Este deportista ya tiene un referente registrado.',
  SIN_PERMISO: 'No tienes permiso para registrar referidos.',
  MIGRACION_PENDIENTE: 'Los referidos todavía no están activos en esta base de datos.',
};

/** Mensaje en español (tuteando) para cualquier error de las rutas de referidos. */
export function mensajeErrorReferido(e: unknown): string {
  const code = codigoDeError(e);
  if (code && MENSAJES_REFERIDO[code]) return MENSAJES_REFERIDO[code];
  const x = e as ErrorConCodigo | null;
  if (x?.status === 403) return MENSAJES_REFERIDO.SIN_PERMISO;
  if (x?.status === 503) return MENSAJES_REFERIDO.MIGRACION_PENDIENTE;
  return x?.body?.error || x?.message || 'No se pudo completar. Intenta de nuevo.';
}

// ─── Llamadas ────────────────────────────────────────────────────────────────

const base = '/api/v1/referidos';
const conEscuela = (schoolId: string) => ({ 'x-school-id': schoolId });

export const referidosApi = {
  campana: (schoolId: string) =>
    bffClient.get<CampanaRespuesta>(`${base}/campaign`, conEscuela(schoolId)),

  guardarCampana: (schoolId: string, c: Campana) =>
    bffClient.put<{ campaign: Campana }>(`${base}/campaign`, {
      name: c.name,
      active: c.active,
      tiers: c.tiers,
      starts_on: c.starts_on || undefined,
      ends_on: c.ends_on || undefined,
      max_pending: c.max_pending,
      require_referrer_current: c.require_referrer_current,
    }, conEscuela(schoolId)),

  registrar: (schoolId: string, cuerpo: RegistrarReferidoInput) =>
    bffClient.post<RegistrarReferidoResultado>(base, cuerpo, conEscuela(schoolId)),

  actualizar: (
    schoolId: string,
    id: string,
    cuerpo: {
      action: AccionReferido;
      referrer_enrollment_id?: string;
      referrer_profile_id?: string;
      referrer_name_text?: string;
      reason?: string;
    },
  ) => bffClient.patch<{ ok: true; referral: ReferidoRow }>(`${base}/${id}`, cuerpo, conEscuela(schoolId)),

  porInscripcion: (schoolId: string, enrollmentId: string) =>
    bffClient.get<{ rows: ReferidoRow[]; total: number }>(
      `${base}?referred_enrollment_id=${encodeURIComponent(enrollmentId)}`,
      conEscuela(schoolId),
    ),

  informe: (schoolId: string, year?: number, month?: number) => {
    const qs = new URLSearchParams();
    if (year) qs.set('year', String(year));
    if (year && month) qs.set('month', String(month));
    const s = qs.toString();
    return bffClient.get<InformeReferidos>(`${base}/report${s ? `?${s}` : ''}`, conEscuela(schoolId));
  },
};

// ─── Apoyos de la captura ────────────────────────────────────────────────────

export type TipoSujetoAlta = 'child' | 'profile' | 'unregistered';

const COLUMNA_SUJETO: Record<TipoSujetoAlta, 'child_id' | 'user_id' | 'unregistered_athlete_id'> = {
  child: 'child_id',
  profile: 'user_id',
  unregistered: 'unregistered_athlete_id',
};

/**
 * `create-one` no devuelve el id de la inscripción: se busca la más reciente
 * del deportista en esa escuela. No toca la ruta; solo lee.
 */
export async function buscarInscripcionReciente(
  schoolId: string,
  tipo: TipoSujetoAlta,
  sujetoId: string,
): Promise<string | null> {
  const { data, error } = await (supabase as any)
    .from('enrollments')
    .select('id')
    .eq('school_id', schoolId)
    .eq(COLUMNA_SUJETO[tipo], sujetoId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return null;
  return (data?.[0]?.id as string | undefined) ?? null;
}

const TABLA_SUJETO: Record<TipoSujetoAlta, string> = {
  child: 'children',
  profile: 'profiles',
  unregistered: 'unregistered_athletes',
};
const COLUMNA_NACIMIENTO: Record<TipoSujetoAlta, string> = {
  child: 'date_of_birth',
  profile: 'date_of_birth',
  unregistered: 'date_of_birth',
};

/** Fecha de nacimiento de la ficha (la RPC la exige para calcular el tramo). */
export async function guardarFechaNacimiento(tipo: TipoSujetoAlta, sujetoId: string, fecha: string): Promise<void> {
  const { error } = await (supabase as any)
    .from(TABLA_SUJETO[tipo])
    .update({ [COLUMNA_NACIMIENTO[tipo]]: fecha })
    .eq('id', sujetoId);
  if (error) throw new Error(error.message || 'No se pudo guardar la fecha de nacimiento.');
}

/** AAAA-MM-DD válida, no futura y con edad razonable. */
export function fechaNacimientoValida(fecha: string, hoy: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha > hoy) return false;
  const edad = edadEn(fecha, hoy);
  return edad !== null && edad <= 100;
}
