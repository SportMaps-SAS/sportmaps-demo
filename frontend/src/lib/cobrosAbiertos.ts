/**
 * Cobros abiertos de una inscripción: anular meses en que el atleta no vino y
 * llevar al valor nuevo los cobros que quedaron con el precio del plan anterior.
 * Spec: docs/specs/cambio-plan-y-cobros-abiertos.md
 *
 * Los números (cuota vigente, valor sugerido, asistencias) los calcula la base
 * en `cobros_abiertos_de_inscripcion`; acá solo se decide qué mostrar y qué se
 * manda a `resolver_cobros_abiertos`. Nada se anula solo: la asistencia es una
 * ayuda para el admin, no un criterio.
 */
import { supabase } from '@/integrations/supabase/client';

export interface CobroAbierto {
  payment_id: string;
  concepto: string | null;
  period_year: number;
  period_month: number;
  status: 'pending' | 'overdue' | 'partial' | 'awaiting_approval';
  amount: number;
  amount_paid: number;
  late_fee_amount: number;
  discount_pct: number | null;
  tiene_comprobante: boolean;
  ocr_amount: number | null;
  asistencias: number;
  clases_con_lista: number;
  monto_sugerido: number | null;
  puede_anular: boolean;
  puede_cambiar_valor: boolean;
}

export interface CobrosAbiertosResumen {
  enrollment_id: string;
  school_id: string;
  atleta: string;
  cuota_vigente: number;
  escuela_toma_lista: boolean;
  cobros: CobroAbierto[];
}

export type AccionCobro = 'dejar' | 'anular' | 'valor';

export interface DecisionCobro {
  accion: AccionCobro;
  /** Solo para 'valor'. */
  monto: number | null;
}

/** De dónde se abrió la ventana: cambia solo lo que viene preseleccionado. */
export type OrigenVentana = 'cambio_plan' | 'no_asistio';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function mesLegible(c: Pick<CobroAbierto, 'period_year' | 'period_month'>): string {
  const m = MESES[c.period_month - 1] ?? String(c.period_month);
  return `${m.charAt(0).toUpperCase()}${m.slice(1)} ${c.period_year}`;
}

export const ESTADO_LABEL: Record<CobroAbierto['status'], string> = {
  pending: 'Pendiente',
  overdue: 'Atrasado',
  partial: 'Con abono',
  awaiting_approval: 'En revisión',
};

export interface AyudaAsistencia {
  texto: string;
  tono: 'alerta' | 'normal' | 'sin_dato';
}

/**
 * Lo que se muestra en la columna de asistencia. `null` = la escuela no toma
 * lista y la columna ni aparece. Un mes sin ninguna lista del equipo dice «Sin
 * registro», nunca «0 asistencias»: en una escuela que no mide, cero no es dato.
 */
export function ayudaAsistencia(c: CobroAbierto, escuelaTomaLista: boolean): AyudaAsistencia | null {
  if (!escuelaTomaLista) return null;
  if (c.clases_con_lista <= 0) return { texto: 'Sin registro de asistencia', tono: 'sin_dato' };
  const clases = `${c.clases_con_lista} ${c.clases_con_lista === 1 ? 'clase' : 'clases'}`;
  if (c.asistencias <= 0) return { texto: `0 asistencias de ${clases}`, tono: 'alerta' };
  return { texto: `${c.asistencias} de ${clases}`, tono: 'normal' };
}

/**
 * Decisión inicial de cada fila. Nunca se preselecciona «anular»: perdonar un
 * mes lo decide una persona. Tras un cambio de plan sí se propone el valor nuevo
 * cuando el cobro quedó con otro monto.
 */
export function decisionInicial(c: CobroAbierto, origen: OrigenVentana): DecisionCobro {
  const sugerido = c.monto_sugerido != null && c.monto_sugerido > 0 ? c.monto_sugerido : null;
  if (origen === 'cambio_plan' && sugerido != null && sugerido !== c.amount && sugerido > c.amount_paid) {
    return { accion: 'valor', monto: sugerido };
  }
  return { accion: 'dejar', monto: sugerido ?? c.amount };
}

export function decisionesIniciales(r: CobrosAbiertosResumen, origen: OrigenVentana): Record<string, DecisionCobro> {
  return Object.fromEntries(r.cobros.map((c) => [c.payment_id, decisionInicial(c, origen)]));
}

/** Errores que impiden confirmar, en palabras para el admin. */
export function erroresDeDecisiones(
  cobros: CobroAbierto[],
  decisiones: Record<string, DecisionCobro>,
  motivo: string,
): string[] {
  const errores: string[] = [];
  let hayAnulacion = false;
  for (const c of cobros) {
    const d = decisiones[c.payment_id];
    if (!d || d.accion === 'dejar') continue;
    if (d.accion === 'anular') {
      hayAnulacion = true;
      if (!c.puede_anular) errores.push(`${mesLegible(c)} no se puede anular (${ESTADO_LABEL[c.status].toLowerCase()}).`);
    } else {
      const monto = Number(d.monto);
      if (!Number.isFinite(monto) || monto <= 0) errores.push(`Escribe el valor nuevo de ${mesLegible(c)}.`);
      else if (monto <= c.amount_paid) errores.push(`El valor de ${mesLegible(c)} debe ser mayor a lo ya abonado.`);
    }
  }
  if (hayAnulacion && !motivo.trim()) {
    errores.push('Escribe el motivo de la anulación (por ejemplo, quién avisó que no vino).');
  }
  return errores;
}

export interface DecisionRpc { payment_id: string; accion: 'anular' | 'valor'; monto?: number }

/** Lo que viaja a la RPC: sin «dejar» y sin cambios de valor que no cambian nada. */
export function decisionesParaEnviar(
  cobros: CobroAbierto[],
  decisiones: Record<string, DecisionCobro>,
): DecisionRpc[] {
  const out: DecisionRpc[] = [];
  for (const c of cobros) {
    const d = decisiones[c.payment_id];
    if (!d || d.accion === 'dejar') continue;
    if (d.accion === 'anular') out.push({ payment_id: c.payment_id, accion: 'anular' });
    else if (Math.round(Number(d.monto)) !== c.amount) {
      out.push({ payment_id: c.payment_id, accion: 'valor', monto: Math.round(Number(d.monto)) });
    }
  }
  return out;
}

/** ¿Vale la pena abrir la ventana tras guardar un cambio de plan? */
export function hayAlgoQueResolver(r: CobrosAbiertosResumen): boolean {
  return r.cobros.some((c) =>
    (c.monto_sugerido != null && c.monto_sugerido > 0 && c.monto_sugerido !== c.amount) || c.status === 'overdue');
}

export async function fetchCobrosAbiertos(enrollmentId: string): Promise<CobrosAbiertosResumen> {
  const { data, error } = await (supabase.rpc as any)('cobros_abiertos_de_inscripcion', {
    p_enrollment_id: enrollmentId,
  });
  if (error) throw error;
  const r = data as CobrosAbiertosResumen;
  return {
    ...r,
    cuota_vigente: Number(r.cuota_vigente) || 0,
    cobros: (r.cobros ?? []).map((c) => ({
      ...c,
      amount: Number(c.amount) || 0,
      amount_paid: Number(c.amount_paid) || 0,
      late_fee_amount: Number(c.late_fee_amount) || 0,
      ocr_amount: c.ocr_amount != null ? Number(c.ocr_amount) : null,
      monto_sugerido: c.monto_sugerido != null ? Number(c.monto_sugerido) : null,
      asistencias: Number(c.asistencias) || 0,
      clases_con_lista: Number(c.clases_con_lista) || 0,
    })),
  };
}

export interface ResultadoResolver { anulados: number; ajustados: number; lineas: string[] }

export async function resolverCobrosAbiertos(
  enrollmentId: string,
  decisiones: DecisionRpc[],
  motivo: string,
): Promise<ResultadoResolver> {
  const { data, error } = await (supabase.rpc as any)('resolver_cobros_abiertos', {
    p_enrollment_id: enrollmentId,
    p_decisiones: decisiones,
    p_motivo: motivo.trim() || null,
  });
  if (error) throw error;
  return data as ResultadoResolver;
}

// ── Lado familia ─────────────────────────────────────────────────────────────

export interface AjusteCobro {
  payment_id: string;
  kind: 'anulado_no_asistio' | 'valor_cambio_plan';
  amount_before: number;
  amount_after: number | null;
  motivo: string | null;
  created_at: string;
}

/** Leyenda corta que ve la familia junto al cobro. Toma el ajuste más reciente. */
export function leyendaAjuste(a: AjusteCobro | undefined, fmt: (n: number) => string): string | null {
  if (!a) return null;
  if (a.kind === 'anulado_no_asistio') return 'Anulado por la escuela: no asistió';
  return `Ajustado por cambio de plan (antes ${fmt(Number(a.amount_before))})`;
}

/** Ajustes de un lote de cobros, el más reciente por cobro. La RLS ya acota a lo visible. */
export async function fetchAjustesDeCobros(paymentIds: string[]): Promise<Map<string, AjusteCobro>> {
  const ids = [...new Set(paymentIds.filter(Boolean))];
  const out = new Map<string, AjusteCobro>();
  if (!ids.length) return out;
  const { data, error } = await (supabase.from as any)('payment_corrections')
    .select('payment_id, kind, amount_before, amount_after, motivo, created_at')
    .in('payment_id', ids)
    .order('created_at', { ascending: false });
  if (error) return out;   // la leyenda es un extra: sin ella el cobro se ve igual
  for (const a of (data ?? []) as AjusteCobro[]) {
    if (!out.has(a.payment_id)) out.set(a.payment_id, a);
  }
  return out;
}
