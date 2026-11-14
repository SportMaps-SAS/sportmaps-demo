/**
 * Hijos del acudiente (V2) — funciones puras de presentación.
 *
 * Sin React ni Supabase: se prueban solas y las pestañas solo pintan lo que
 * sale de aquí.
 */
import { resolveSport } from '@/lib/sports/sportCatalog';
import { parseAllergyInfo } from '@/components/common/MedicalAlertBadge';

// ─── Tipos de datos crudos (lo que devuelve la base / el BFF) ──────────────

export interface HijoTeam {
  name: string;
  sport?: string | null;
  level?: string | null;
  coach?: { full_name: string | null } | null;
}

export interface HijoEnrollment {
  id: string;
  status: string | null;
  team_id: string | null;
  teams?: HijoTeam | null;
  offering_plans?: { name: string | null; offerings?: { name: string | null } | null } | null;
}

export interface Hijo {
  id: string;
  full_name: string;
  avatar_url?: string | null;
  date_of_birth?: string | null;
  doc_type?: string | null;
  doc_number?: string | null;
  eps_name?: string | null;
  blood_type?: string | null;
  medical_info?: string | null;
  emergency_contact?: string | null;
  id_document_url?: string | null;
  team_id?: string | null;
  teams?: HijoTeam | null;
  enrollments?: HijoEnrollment[] | null;
  [key: string]: unknown;
}

// ─── Documentos (bucket identity-documents) ────────────────────────────────

/**
 * Carpeta donde la FAMILIA sube los documentos de un hijo. Es la única que el
 * bucket le deja escribir (policy identity_docs_authenticated_insert:
 * foldername[2] = auth.uid()) y la escuela la puede leer
 * (identity_docs_children_staff_read, rama de 4+ carpetas por children.id).
 */
export const carpetaDocsFamilia = (parentId: string, childId: string) => `children/${parentId}/${childId}/docs`;

/**
 * Carpetas que la escuela revisa para los documentos de un deportista (B2): la
 * vieja `children/{id}/docs` y, si tiene acudiente con cuenta, la de la familia.
 */
export function carpetasDocumentosDeportista(athleteId: string, parentId: string | null | undefined): string[] {
  const carpetas = [`children/${athleteId}/docs`];
  if (parentId) carpetas.push(carpetaDocsFamilia(parentId, athleteId));
  return carpetas;
}

// ─── Cabecera ──────────────────────────────────────────────────────────────

export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

export function ageFrom(dateOfBirth: string | null | undefined, today = new Date()): number | null {
  if (!dateOfBirth) return null;
  const dob = new Date(`${dateOfBirth.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(dob.getTime())) return null;
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age -= 1;
  return age >= 0 ? age : null;
}

const ACTIVE = ['active', 'activo'];

export function activeEnrollment(hijo: Hijo): HijoEnrollment | null {
  return (hijo.enrollments ?? []).find((e) => ACTIVE.includes((e.status ?? '').toLowerCase())) ?? null;
}

/** El equipo que se muestra: el de la inscripción activa o, si no, el del hijo. */
export function currentTeam(hijo: Hijo): HijoTeam | null {
  return activeEnrollment(hijo)?.teams ?? hijo.teams ?? null;
}

/** «Fútbol Sub 11 · 10 años · Profe Laura». Se omite lo que no exista. */
export function hijoSubtitle(hijo: Hijo, today = new Date()): string {
  const parts: string[] = [];
  const team = currentTeam(hijo);
  if (team) {
    const sport = team.sport ? resolveSport(team.sport).label : '';
    const sameSport = sport && team.name.toLowerCase().includes(sport.toLowerCase());
    parts.push(sport && !sameSport ? `${sport} ${team.name}` : team.name);
  } else {
    const plan = activeEnrollment(hijo)?.offering_plans;
    const name = plan?.offerings?.name ?? plan?.name;
    if (name) parts.push(name);
  }
  const age = ageFrom(hijo.date_of_birth, today);
  if (age !== null) parts.push(`${age} ${age === 1 ? 'año' : 'años'}`);
  const coach = team?.coach?.full_name?.trim();
  if (coach) parts.push(`Profe ${firstName(coach)}`);
  return parts.join(' · ');
}

// ─── Fechas ────────────────────────────────────────────────────────────────

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
export const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const MESES_CORTOS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/** «2026-10-06» o un ISO con hora → fecha local sin correrse de día. */
function toLocalDate(value: string): Date {
  return value.length <= 10 ? new Date(`${value}T00:00:00`) : new Date(value);
}

/** «Martes 6 de octubre». */
export function formatLongDate(value: string): string {
  const d = toLocalDate(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`;
}

function dayKey(value: string): string {
  const d = toLocalDate(value);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ─── Progreso: cómo le fue en los últimos entrenos ─────────────────────────

export type SessionRating = 'Bien' | 'Normal' | 'Le costó';

export interface RawEntry {
  metric_key: string;
  value: number | string;
  context_type?: string | null;
  recorded_at: string;
  notes?: string | null;
}

/**
 * Escala de 50 a 100 de la evaluación post-entreno (coach_effort_rating /
 * self_effort_pct): 80 «de buena manera» o más es Bien; 70 «moderado» es
 * Normal; 60 o menos («a la mitad») es Le costó.
 */
export function ratingFromEffort(value: number): SessionRating {
  if (value >= 80) return 'Bien';
  if (value >= 70) return 'Normal';
  return 'Le costó';
}

export interface SessionRow {
  date: string;
  rating: SessionRating;
}

export interface RecentSessions {
  rows: SessionRow[];
  /** coach = lo calificó el profe; self = solo hay la autoevaluación del deportista. */
  source: 'coach' | 'self' | null;
}

function sessionsFor(entries: RawEntry[], key: string, limit: number): SessionRow[] {
  const byDay = new Map<string, number[]>();
  for (const e of entries) {
    if (e.metric_key !== key) continue;
    if (e.context_type && e.context_type !== 'session') continue;
    const v = Number(e.value);
    if (!Number.isFinite(v)) continue;
    const k = dayKey(e.recorded_at);
    byDay.set(k, [...(byDay.get(k) ?? []), v]);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, limit)
    .map(([date, vals]) => ({
      date,
      rating: ratingFromEffort(vals.reduce((s, v) => s + v, 0) / vals.length),
    }));
}

export function recentSessions(entries: RawEntry[] | null | undefined, limit = 4): RecentSessions {
  const list = entries ?? [];
  const coach = sessionsFor(list, 'coach_effort_rating', limit);
  if (coach.length > 0) return { rows: coach, source: 'coach' };
  const self = sessionsFor(list, 'self_effort_pct', limit);
  if (self.length > 0) return { rows: self, source: 'self' };
  return { rows: [], source: null };
}

// ─── Progreso: en qué va mejorando ─────────────────────────────────────────

/** Preguntas del post-entreno: son de cada sesión, no habilidades que se miden. */
const SESSION_METRICS = new Set([
  'rpe_borg', 'task_comprehension', 'self_effort_pct', 'satisfaction', 'coach_effort_rating',
]);

export interface EvolutionMetricLike {
  metric_key: string;
  display_name: string;
  unit?: string | null;
  category?: string | null;
  min_value: number | null;
  max_value: number | null;
  higher_is_better: boolean;
}

export interface SkillRow {
  key: string;
  label: string;
  /** Valor en escala 0–5 para la barra; null si la métrica no tiene rango. */
  score: number | null;
  /** Texto principal: «4,2 de 5» o «12,3 s». */
  valueLabel: string;
  /** «+0,6», «−0,3» o null si es la primera medición. */
  deltaLabel: string | null;
  /** true si la variación es para bien (respeta «menos es mejor»). */
  improved: boolean | null;
  lastDate: string;
}

const fmt = (n: number) =>
  n.toLocaleString('es-CO', { maximumFractionDigits: 1, minimumFractionDigits: n % 1 === 0 ? 0 : 1 });

function signed(n: number): string {
  const r = Math.round(n * 10) / 10;
  if (r === 0) return '0';
  return `${r > 0 ? '+' : '−'}${fmt(Math.abs(r))}`;
}

/**
 * Criterios de TEXTO («Comentario del coach», scale = 'text' en
 * school_metric_definitions): se guardan con value = 0 y el texto en `notes`.
 * No son habilidades: pintarlos como barra daba «Comentario 0» y el comentario
 * no se veía nunca.
 */
export function isTextMetric(m: { metric_key: string; display_name?: string | null; label?: string | null; scale?: string | null }): boolean {
  if (m.scale === 'text') return true;
  if (/^comentario/i.test(m.metric_key)) return true;
  return /^comentario/i.test((m.display_name ?? m.label ?? '').trim());
}

export function isSkillMetric(m: { metric_key: string; category?: string | null; display_name?: string | null; label?: string | null; scale?: string | null }): boolean {
  if (SESSION_METRICS.has(m.metric_key)) return false;
  if (isTextMetric(m)) return false;
  if (m.metric_key.startsWith('focus_')) return false;
  if (m.category === 'attendance') return false;
  return true;
}

/** Pasa un valor a la escala 0–5 si la métrica tiene rango conocido. */
export function toFiveScale(value: number, m: EvolutionMetricLike): number | null {
  const { min_value: min, max_value: max } = m;
  if (min == null || max == null || max <= min) return null;
  let s = max === 5 && min >= 0 ? value : ((value - min) / (max - min)) * 5;
  if (!m.higher_is_better) s = 5 - s;
  return Math.max(0, Math.min(5, s));
}

/**
 * Nombre visible de una métrica. Algunas escuelas tienen métricas sin nombre
 * (display_name = la clave técnica «control_balon»): nunca se muestra la clave.
 */
// Palabras frecuentes en las claves de métricas que pierden la tilde («control_balon»).
const TILDES: Record<string, string> = {
  balon: 'balón', precision: 'precisión', tactico: 'táctico', tactica: 'táctica', tecnica: 'técnica',
  tecnico: 'técnico', recepcion: 'recepción', definicion: 'definición', conduccion: 'conducción',
  coordinacion: 'coordinación', resistencia: 'resistencia', agilidad: 'agilidad', saque: 'saque',
  posicion: 'posición', atencion: 'atención', concentracion: 'concentración', actitud: 'actitud',
  velocidad: 'velocidad', fisico: 'físico', fisica: 'física', tiro: 'tiro', bloqueo: 'bloqueo',
  colocacion: 'colocación', anticipacion: 'anticipación', comunicacion: 'comunicación', ataque: 'ataque',
  pase: 'pase', defensa: 'defensa', regate: 'regate', cabezazo: 'cabezazo', salto: 'salto',
};

export function etiquetaLegible(nombre: string | null | undefined, clave?: string | null): string {
  const base = (nombre ?? '').trim() || (clave ?? '').trim();
  if (!/^[a-z0-9_]+$/.test(base)) return base;
  const texto = base.replace(/_+/g, ' ').trim().split(' ').map((w) => TILDES[w] ?? w).join(' ');
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

export function skillRows(
  metrics: EvolutionMetricLike[] | null | undefined,
  evolution: Record<string, { date: string; value: number }[]> | null | undefined,
  limit = 6,
): SkillRow[] {
  const rows: SkillRow[] = [];
  for (const m of metrics ?? []) {
    if (!isSkillMetric(m)) continue;
    const series = [...(evolution?.[m.metric_key] ?? [])]
      .filter((p) => Number.isFinite(Number(p.value)))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    if (series.length === 0) continue;
    // Sin rango ni unidad y siempre 0: es un criterio de texto con otro nombre.
    if (m.min_value == null && m.max_value == null && !m.unit && series.every((p) => Number(p.value) === 0)) continue;
    const last = Number(series[series.length - 1].value);
    const prev = series.length > 1 ? Number(series[series.length - 2].value) : null;
    const score = toFiveScale(last, m);
    let deltaLabel: string | null = null;
    let improved: boolean | null = null;
    if (prev !== null) {
      if (score !== null) {
        const d = score - (toFiveScale(prev, m) ?? score);
        deltaLabel = signed(d);
        improved = d > 0 ? true : d < 0 ? false : null;
      } else {
        const d = last - prev;
        deltaLabel = `${signed(d)}${m.unit ? ` ${m.unit}` : ''}`;
        const better = m.higher_is_better ? d > 0 : d < 0;
        improved = d === 0 ? null : better;
      }
      if (deltaLabel === '0' || deltaLabel.startsWith('0 ')) deltaLabel = null;
    }
    rows.push({
      key: m.metric_key,
      label: etiquetaLegible(m.display_name, m.metric_key),
      score,
      valueLabel: score !== null ? `${fmt(Math.round(score * 10) / 10)} de 5` : `${fmt(last)}${m.unit ? ` ${m.unit}` : ''}`,
      deltaLabel,
      improved,
      lastDate: series[series.length - 1].date,
    });
  }
  return rows
    .sort((a, b) => new Date(b.lastDate).getTime() - new Date(a.lastDate).getTime())
    .slice(0, limit);
}

export interface ComentarioProfe {
  fecha: string;
  texto: string;
  /** 'competition' = partido; 'session' = entreno; otro/null = evaluación suelta. */
  contexto: string | null;
}

/**
 * «Lo que dijo el profe»: el texto de los criterios de texto (va en `notes`),
 * del más reciente al más viejo y sin repetir el mismo comentario.
 */
export function comentariosDelProfe(entries: RawEntry[] | null | undefined, limit = 2): ComentarioProfe[] {
  const vistos = new Set<string>();
  return [...(entries ?? [])]
    .filter((e) => isTextMetric(e) && (e.notes ?? '').trim())
    .sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime())
    .filter((e) => {
      const t = e.notes!.trim();
      if (vistos.has(t)) return false;
      vistos.add(t);
      return true;
    })
    .slice(0, limit)
    .map((e) => ({ fecha: e.recorded_at, texto: e.notes!.trim(), contexto: e.context_type ?? null }));
}

/** Respaldo: métricas del último informe mensual publicado (ya traen su variación). */
export function skillRowsFromSnapshot(
  metrics: { metric_key: string; label: string; unit: string | null; category: string | null; value: number; delta: number | null; higher_is_better: boolean; measured_at: string }[] | null | undefined,
  limit = 6,
): SkillRow[] {
  return (metrics ?? [])
    .filter(isSkillMetric)
    .slice(0, limit)
    .map((m) => {
      const d = m.delta;
      const has = d !== null && d !== undefined && Math.round(d * 10) !== 0;
      return {
        key: m.metric_key,
        label: etiquetaLegible(m.label, m.metric_key),
        score: null,
        valueLabel: `${fmt(Number(m.value))}${m.unit ? ` ${m.unit}` : ''}`,
        deltaLabel: has ? `${signed(d as number)}${m.unit ? ` ${m.unit}` : ''}` : null,
        improved: has ? (m.higher_is_better ? (d as number) > 0 : (d as number) < 0) : null,
        lastDate: m.measured_at,
      };
    });
}

// ─── Asistencia ────────────────────────────────────────────────────────────

export interface AttendanceRecord {
  attendance_date: string;
  status: string;
}

/** Llegar tarde es haber venido (igual que GET /attendance/rate del BFF). */
export const cameToTraining = (status: string) => status === 'present' || status === 'late';

export interface AttendanceSummary {
  thisMonth: { came: number; total: number };
  months: { key: string; label: string; pct: number; came: number; total: number }[];
  last: { date: string; label: 'Vino' | 'No vino' | 'Con excusa' }[];
}

export function attendanceSummary(
  records: AttendanceRecord[] | null | undefined,
  today = new Date(),
  monthsBack = 4,
  lastCount = 6,
): AttendanceSummary {
  const list = [...(records ?? [])].sort((a, b) => (a.attendance_date < b.attendance_date ? 1 : -1));
  const months: AttendanceSummary['months'] = [];
  for (let i = monthsBack - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const inMonth = list.filter((r) => r.attendance_date.slice(0, 7) === key);
    const came = inMonth.filter((r) => cameToTraining(r.status)).length;
    months.push({
      key,
      label: MESES_CORTOS[d.getMonth()],
      came,
      total: inMonth.length,
      pct: inMonth.length ? Math.round((came / inMonth.length) * 100) : 0,
    });
  }
  const current = months[months.length - 1];
  return {
    thisMonth: { came: current?.came ?? 0, total: current?.total ?? 0 },
    months,
    last: list.slice(0, lastCount).map((r) => ({
      date: r.attendance_date,
      label: cameToTraining(r.status) ? 'Vino' : r.status === 'excused' ? 'Con excusa' : 'No vino',
    })),
  };
}

// ─── Ficha y salud ─────────────────────────────────────────────────────────

/** «TI •••• 4521». Nunca se muestra el número completo. */
export function maskDocument(docType: string | null | undefined, docNumber: string | null | undefined): string | null {
  const digits = (docNumber ?? '').replace(/\s+/g, '');
  if (!digits) return null;
  const tail = digits.slice(-4);
  return `${docType ? `${docType} ` : ''}•••• ${tail}`;
}

/** El contacto se guarda como «Nombre - Teléfono» (EditChildDialog). */
export function emergencyContactLabel(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const [name, phone] = raw.split(' - ');
  return [name?.trim(), phone?.trim()].filter(Boolean).join(' · ') || null;
}

export function allergiesLabel(medicalInfo: string | null | undefined): string {
  const info = parseAllergyInfo(medicalInfo);
  if (!info) return 'Ninguna registrada';
  return info.allergy_type?.trim() || info.additional_notes?.trim() || 'Sí, sin detalle';
}
