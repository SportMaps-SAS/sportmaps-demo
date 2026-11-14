import type { CancellationPolicy, RateAudience } from './reservasApi';

export interface RateForm {
  audience: RateAudience;
  weekdays: number[]; // 0 = domingo … 6 = sábado
  from_time: string; // 'HH:mm'
  to_time: string;
  price_per_hour: string; // texto del input (COP, entero)
}

export const WEEKDAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export const EMPTY_RATE_FORM: RateForm = {
  audience: 'public',
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  from_time: '06:00',
  to_time: '22:00',
  price_per_hour: '',
};

export function toHHmm(t: string | null | undefined): string {
  return (t ?? '').slice(0, 5);
}

export function describeWeekdays(days: number[] | null | undefined): string {
  const d = [...(days ?? [])].sort((a, b) => a - b);
  if (d.length === 7) return 'Todos los días';
  if (d.length === 0) return 'Ningún día';
  return d.map((n) => WEEKDAY_LABELS[n] ?? '?').join(', ');
}

/** null si está bien; si no, el mensaje para la escuela. */
export function validateRate(f: RateForm): string | null {
  if (f.weekdays.length === 0) return 'Elige al menos un día.';
  if (!/^\d{2}:\d{2}$/.test(f.from_time) || !/^\d{2}:\d{2}$/.test(f.to_time)) return 'Indica la hora de inicio y de fin.';
  if (f.to_time <= f.from_time) return 'La hora de fin debe ser posterior a la de inicio.';
  const price = f.price_per_hour.trim();
  if (!/^\d+$/.test(price)) return 'El precio por hora debe ser un número entero (COP), sin puntos ni signos.';
  return null;
}

export function validatePolicy(p: { hours_full_refund: string; hours_partial_refund: string; partial_pct: string }): string | null {
  if ([p.hours_full_refund, p.hours_partial_refund, p.partial_pct].some((v) => String(v).trim() === '')) {
    return 'Completa los tres valores con números positivos.';
  }
  const full = Number(p.hours_full_refund);
  const partial = Number(p.hours_partial_refund);
  const pct = Number(p.partial_pct);
  if ([full, partial, pct].some((n) => !Number.isFinite(n) || n < 0)) return 'Completa los tres valores con números positivos.';
  if (partial > full) return 'Las horas de devolución parcial no pueden ser más que las de devolución total.';
  if (pct > 100) return 'El porcentaje parcial no puede pasar de 100.';
  return null;
}

export function policyToForm(p: CancellationPolicy) {
  return {
    hours_full_refund: String(p.hours_full_refund),
    hours_partial_refund: String(p.hours_partial_refund),
    partial_pct: String(p.partial_pct),
  };
}
