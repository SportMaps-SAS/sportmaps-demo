/**
 * Períodos de la evaluación de entrenadores (spec evaluacion-de-entrenadores).
 * Puro, en 'YYYY-MM-DD'. Las mismas reglas de alineación que la base
 * (_coach_eval_period_end): lunes · día 1 · ene/abr/jul/oct · ene/jul · 1-ene.
 */
export type PeriodType = 'semanal' | 'mensual' | 'trimestral' | 'semestral' | 'anual';

export const PERIOD_TYPES: { value: PeriodType; label: string }[] = [
  { value: 'semanal', label: 'Semanal' },
  { value: 'mensual', label: 'Mensual' },
  { value: 'trimestral', label: 'Trimestral' },
  { value: 'semestral', label: 'Semestral' },
  { value: 'anual', label: 'Anual' },
];

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_PER: Record<Exclude<PeriodType, 'semanal'>, number> = { mensual: 1, trimestral: 3, semestral: 6, anual: 12 };

const parts = (ymd: string) => ({ y: +ymd.slice(0, 4), m: +ymd.slice(5, 7), d: +ymd.slice(8, 10) });
const ymdUtc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => { const { y, m, d } = parts(ymd); return ymdUtc(y, m, d + n); };
const addMonths = (ymd: string, n: number) => { const { y, m } = parts(ymd); return ymdUtc(y, m + n, 1); };

/** Inicio del período que contiene la fecha. */
export function periodStartOf(type: PeriodType, ymd: string): string {
  const { y, m, d } = parts(ymd);
  if (type === 'semanal') {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
    return addDays(ymd, dow === 0 ? -6 : 1 - dow);
  }
  const span = MONTHS_PER[type];
  const firstMonth = Math.floor((m - 1) / span) * span + 1;
  return ymdUtc(y, firstMonth, 1);
}

export function periodEnd(type: PeriodType, start: string): string {
  if (type === 'semanal') return addDays(start, 6);
  return addDays(addMonths(start, MONTHS_PER[type]), -1);
}

/** Inicio del período anterior / siguiente. */
export function shiftPeriod(type: PeriodType, start: string, n: number): string {
  if (type === 'semanal') return addDays(start, 7 * n);
  return addMonths(start, MONTHS_PER[type] * n);
}

/** Último período YA cerrado a la fecha de hoy (el que se suele calificar). */
export function lastClosedPeriod(type: PeriodType, today: string): string {
  return shiftPeriod(type, periodStartOf(type, today), -1);
}

/** «Semana del 6 al 12 oct 2026» · «Octubre 2026» · «T4 2026» · «Semestre 2 2026» · «2026». */
export function periodLabel(type: PeriodType, start: string): string {
  const { y, m, d } = parts(start);
  switch (type) {
    case 'semanal': {
      const e = parts(periodEnd(type, start));
      const sameMonth = e.m === m;
      return `Semana del ${d}${sameMonth ? '' : ` ${MONTHS_SHORT[m - 1]}`} al ${e.d} ${MONTHS_SHORT[e.m - 1]} ${e.y}`;
    }
    case 'mensual': return `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${y}`;
    case 'trimestral': return `T${Math.floor((m - 1) / 3) + 1} ${y}`;
    case 'semestral': return `Semestre ${m <= 6 ? 1 : 2} ${y}`;
    case 'anual': return String(y);
  }
}

/** Escala 1-5 en palabras (D6). */
export const SCORE_LABELS: Record<number, string> = {
  1: 'Deficiente', 2: 'Por mejorar', 3: 'Cumple', 4: 'Bueno', 5: 'Excelente',
};

export function scoreWord(score: number | null | undefined): string {
  if (score == null) return 'Sin nota';
  return SCORE_LABELS[Math.min(5, Math.max(1, Math.round(score)))];
}
