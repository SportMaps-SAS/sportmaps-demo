/**
 * Lista del entrenador V2 — lógica PURA (sin React ni red).
 *
 * Decisión 2 del usuario (docs/specs/entrenador-deportista-v2.md §1): cuatro
 * estados en UN botón que rota Vino → Faltó → Excusa → Tarde → Vino, y todos
 * arrancan en «Vino». Quien avisó por WhatsApp que no viene arranca en
 * «Excusa» (no descuenta clase), igual que CoachAttendancePage.
 *
 * Los estados son los mismos de la base (attendance_records.status) y del BFF
 * (POST /api/v1/attendance/session): present / absent / excused / late.
 */

export type EstadoLista = 'present' | 'absent' | 'excused' | 'late';

/** Orden de la rotación: un toque pasa al siguiente. */
export const ROTACION: readonly EstadoLista[] = ['present', 'absent', 'excused', 'late'] as const;

export const ETIQUETA: Record<EstadoLista, string> = {
  present: 'Vino',
  absent: 'Faltó',
  excused: 'Excusa',
  late: 'Tarde',
};

export function siguienteEstado(actual: EstadoLista | undefined): EstadoLista {
  const i = ROTACION.indexOf(actual ?? 'present');
  return ROTACION[(i + 1) % ROTACION.length];
}

export function esEstadoValido(s: unknown): s is EstadoLista {
  return typeof s === 'string' && (ROTACION as readonly string[]).includes(s);
}

/** Lo mínimo del roster que necesita la lista (el BFF manda más campos). */
export interface DeportistaLista {
  id: string;
  full_name: string;
  athlete_type: 'child' | 'adult' | 'unregistered';
  enrollment_id?: string | null;
  aviso_ausencia?: { motivo: string | null; nota: string | null; fuente: string } | null;
}

export interface RegistroGuardado {
  child_id?: string | null;
  user_id?: string | null;
  unregistered_athlete_id?: string | null;
  status: string;
}

export function claveDeRegistro(r: { child_id?: string | null; user_id?: string | null; unregistered_athlete_id?: string | null }): string | null {
  return r.child_id ?? r.user_id ?? r.unregistered_athlete_id ?? null;
}

/**
 * Estado con el que abre la lista.
 *  1. Si hay una versión guardada en el teléfono (cola sin señal), manda esa: es la más nueva.
 *  2. Si la base ya tiene registros, se respetan.
 *  3. Si no, todos «Vino», y quien avisó, «Excusa».
 * A quien no tenga marca en 1 o 2 (llegó después al equipo) se le aplica la regla 3.
 */
export function estadoInicial(
  roster: DeportistaLista[],
  registros: RegistroGuardado[] | null | undefined,
  local?: Record<string, EstadoLista> | null,
): Record<string, EstadoLista> {
  const base: Record<string, EstadoLista> = {};
  for (const r of registros ?? []) {
    const k = claveDeRegistro(r);
    if (k && esEstadoValido(r.status)) base[k] = r.status;
  }
  const out: Record<string, EstadoLista> = {};
  for (const a of roster) {
    out[a.id] = local?.[a.id] ?? base[a.id] ?? (a.aviso_ausencia ? 'excused' : 'present');
  }
  return out;
}

export interface Resumen { vinieron: number; faltaron: number; excusas: number; tarde: number; total: number }

/** «Vinieron» cuenta a los que llegaron tarde: estuvieron en el entreno. */
export function resumir(estado: Record<string, EstadoLista>, ids: string[]): Resumen {
  let faltaron = 0, excusas = 0, tarde = 0;
  for (const id of ids) {
    const s = estado[id] ?? 'present';
    if (s === 'absent') faltaron++;
    else if (s === 'excused') excusas++;
    else if (s === 'late') tarde++;
  }
  return { vinieron: ids.length - faltaron - excusas, faltaron, excusas, tarde, total: ids.length };
}

/**
 * «Lista guardada: vinieron 2, faltaron 1, con excusa 1.» B11: antes sumaba las
 * excusas a las faltas («faltaron 2»).
 */
export function textoListaGuardada(r: Pick<Resumen, 'vinieron' | 'faltaron' | 'excusas'>): string {
  const partes = [`vinieron ${r.vinieron}`];
  if (r.faltaron > 0 || r.excusas === 0) partes.push(`faltaron ${r.faltaron}`);
  if (r.excusas > 0) partes.push(`con excusa ${r.excusas}`);
  return `Lista guardada: ${partes.join(', ')}.`;
}

export function textoAyuda(r: Resumen, primerConAviso?: string | null): string {
  const noVinieron = r.faltaron + r.excusas;
  if (r.total === 0) return '';
  if (noVinieron === 0) return 'Todos vinieron. Toca solo al que faltó.';
  if (r.faltaron === 0 && r.excusas === 1 && primerConAviso) {
    return `${primerConAviso} avisó que no viene. Los demás, presentes: toca solo al que faltó.`;
  }
  return `${noVinieron} ${noVinieron === 1 ? 'no vino' : 'no vinieron'}. Toca a otro si también faltó.`;
}

/** Registro tal como lo espera POST /api/v1/attendance/session. */
export interface RegistroLista {
  childId?: string;
  userId?: string;
  unregisteredAthleteId?: string;
  status: EstadoLista;
  enrollmentId?: string;
  isSecondary?: boolean;
}

export function construirRegistros(
  roster: DeportistaLista[],
  estado: Record<string, EstadoLista>,
  isSecondary = false,
): RegistroLista[] {
  return roster.map((a) => ({
    childId: a.athlete_type === 'child' ? a.id : undefined,
    userId: a.athlete_type === 'adult' ? a.id : undefined,
    unregisteredAthleteId: a.athlete_type === 'unregistered' ? a.id : undefined,
    status: estado[a.id] ?? 'present',
    // Que el BFF le cobre a la inscripción que el entrenador vio en pantalla.
    enrollmentId: a.enrollment_id ?? undefined,
    isSecondary,
  }));
}

export function claveDeRegistroLista(r: RegistroLista): string | null {
  return r.childId ?? r.userId ?? r.unregisteredAthleteId ?? null;
}

/** Estados por deportista de una lista guardada en la cola (para reabrirla tal cual). */
export function estadoDesdeRegistros(records: RegistroLista[]): Record<string, EstadoLista> {
  const out: Record<string, EstadoLista> = {};
  for (const r of records) {
    const k = claveDeRegistroLista(r);
    if (k) out[k] = r.status;
  }
  return out;
}

// ── Fechas (YYYY-MM-DD, día de negocio de Colombia) ──────────────────────────

export function sumarDias(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Ventana de corrección del entrenador = la de la escuela
 * (school_settings.coach_attendance_retro_days, default 7; el BFF valida lo
 * mismo en resolverFechaDeTrabajo). B9: antes la V2 ofrecía solo hoy y ayer
 * aunque la escuela dejara 7 días.
 */
const retroValido = (retroDias: number) => (Number.isFinite(retroDias) && retroDias > 0 ? Math.floor(retroDias) : 0);

/** Primer día que el entrenador todavía puede tomar o corregir. */
export function fechaMinimaCorregible(hoy: string, retroDias: number): string {
  return sumarDias(hoy, -retroValido(retroDias));
}

/** Todos los días corregibles, de hoy hacia atrás (hoy, ayer, …, hoy − retroDias). */
export function fechasCorregibles(hoy: string, retroDias: number): string[] {
  const n = retroValido(retroDias);
  return Array.from({ length: n + 1 }, (_, i) => sumarDias(hoy, -i));
}

export function sePuedeCorregir(fecha: string, hoy: string, retroDias: number): boolean {
  return fecha <= hoy && fecha >= fechaMinimaCorregible(hoy, retroDias);
}

/**
 * Botones del selector de día: «Hoy», «Ayer» y, si la ventana va más atrás,
 * «Otro día» (abre un calendario limitado a la ventana).
 */
export type OpcionDia = 'hoy' | 'ayer' | 'otro';

export function opcionesDeDia(retroDias: number): OpcionDia[] {
  const n = retroValido(retroDias);
  if (n === 0) return ['hoy'];
  if (n === 1) return ['hoy', 'ayer'];
  return ['hoy', 'ayer', 'otro'];
}

export function opcionDeFecha(fecha: string, hoy: string): OpcionDia {
  if (fecha === hoy) return 'hoy';
  if (fecha === sumarDias(hoy, -1)) return 'ayer';
  return 'otro';
}

/** Texto del historial sobre hasta cuándo se corrige. */
export function textoVentanaCorreccion(retroDias: number): string {
  const n = retroValido(retroDias);
  if (n === 0) return 'Solo se puede tomar la lista del día. Después, la corrige la escuela.';
  if (n === 1) return 'Se puede corregir hasta el día siguiente. Después, la corrige la escuela.';
  return `Se puede corregir hasta ${n} días después. Después, la corrige la escuela.`;
}

/** «jueves 8 de octubre» */
export function fechaHumana(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Primera letra en mayúscula (sin «Domingo, 25 De Octubre» de text-transform: capitalize). */
export function capitalizar(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** «4:00 p. m.» desde «16:00:00». */
export function horaHumana(t: string | null | undefined): string | null {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  if (!Number.isFinite(h)) return null;
  const sufijo = h >= 12 ? 'p. m.' : 'a. m.';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m ?? 0).padStart(2, '0')} ${sufijo}`;
}

export function iniciales(nombre: string): string {
  return nombre.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

// ── Historial ────────────────────────────────────────────────────────────────

export interface SesionHistorial {
  id: string;
  session_date: string;
  finalized: boolean | null;
  records: RegistroGuardado[];
}

/** Quién falta mucho: vino a menos del 70 % de al menos 3 entrenos con lista. */
export function faltanMucho(
  sesiones: SesionHistorial[],
  nombres: Map<string, string>,
  opts: { minEntrenos?: number; umbral?: number; max?: number } = {},
): { id: string; nombre: string; vino: number; de: number }[] {
  const minEntrenos = opts.minEntrenos ?? 3;
  const umbral = opts.umbral ?? 0.7;
  const conteo = new Map<string, { vino: number; de: number }>();
  for (const s of sesiones) {
    for (const r of s.records) {
      const k = claveDeRegistro(r);
      if (!k) continue;
      const c = conteo.get(k) ?? { vino: 0, de: 0 };
      c.de++;
      if (r.status === 'present' || r.status === 'late') c.vino++;
      conteo.set(k, c);
    }
  }
  return [...conteo.entries()]
    .filter(([, c]) => c.de >= minEntrenos && c.vino / c.de < umbral)
    .map(([id, c]) => ({ id, nombre: nombres.get(id) ?? 'Deportista', ...c }))
    .sort((a, b) => a.vino / a.de - b.vino / b.de || a.nombre.localeCompare(b.nombre))
    .slice(0, opts.max ?? 5);
}

/** % de asistencia (vino o tarde) sobre todas las marcas. null si no hay marcas. */
export function porcentajeAsistencia(sesiones: SesionHistorial[]): number | null {
  let vino = 0, total = 0;
  for (const s of sesiones) for (const r of s.records) {
    total++;
    if (r.status === 'present' || r.status === 'late') vino++;
  }
  return total === 0 ? null : Math.round((vino / total) * 100);
}
