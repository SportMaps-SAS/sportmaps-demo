/**
 * «Cómo agenda el bot» la clase de prueba (lógica pura de
 * AjustesAgendaClasePrueba): borrador del formulario ↔ lo que se guarda.
 */
import type { AgendaClasePrueba } from '@/hooks/useClasePrueba';

/** Lunes primero, como se lee la semana en Colombia. `day` 0 = domingo (teams.schedule). */
export const DIAS_AGENDA: { day: number; corto: string; largo: string }[] = [
  { day: 1, corto: 'L', largo: 'Lunes' },
  { day: 2, corto: 'M', largo: 'Martes' },
  { day: 3, corto: 'X', largo: 'Miércoles' },
  { day: 4, corto: 'J', largo: 'Jueves' },
  { day: 5, corto: 'V', largo: 'Viernes' },
  { day: 6, corto: 'S', largo: 'Sábado' },
  { day: 0, corto: 'D', largo: 'Domingo' },
];

export interface BorradorAgenda {
  dias: number[];
  nombre: 'cortesia' | 'prueba';
  separar: string;
  cupos: string;
  avisar: boolean;
}

export function borradorDe(a: AgendaClasePrueba): BorradorAgenda {
  return {
    dias: a.dias_semana ?? DIAS_AGENDA.map((d) => d.day),
    nombre: a.nombre_clase ?? 'cortesia',
    separar: a.separar_horas != null ? String(a.separar_horas) : '',
    cupos: a.cupos_por_sesion != null ? String(a.cupos_por_sesion) : '',
    avisar: a.avisar_entrenador,
  };
}

/**
 * Borrador → lo que se guarda. Los siete días = NULL (todos, como hoy).
 * El nombre por defecto (cortesía) se guarda solo si ya estaba elegido: así una
 * escuela que nunca tocó esto sigue en NULL.
 */
export function agendaDe(b: BorradorAgenda, antes: AgendaClasePrueba): { agenda: AgendaClasePrueba } | { error: string } {
  const dias = [...new Set(b.dias)].filter((d) => d >= 0 && d <= 6).sort((x, y) => x - y);
  if (dias.length === 0) return { error: 'Elige al menos un día.' };
  const numero = (t: string, min: number, max: number) => {
    const s = t.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
  };
  const separar = numero(b.separar, 1, 72);
  if (Number.isNaN(separar)) return { error: 'Las horas para separar el cupo van de 1 a 72.' };
  const cupos = numero(b.cupos, 1, 500);
  if (Number.isNaN(cupos)) return { error: 'Los cupos por clase van de 1 a 500.' };
  return {
    agenda: {
      dias_semana: dias.length === 7 ? null : dias,
      nombre_clase: b.nombre === 'cortesia' && antes.nombre_clase == null ? null : b.nombre,
      separar_horas: separar,
      cupos_por_sesion: cupos,
      avisar_entrenador: b.avisar,
    },
  };
}

export function hayCambios(b: BorradorAgenda, a: AgendaClasePrueba): boolean {
  const o = borradorDe(a);
  const dias = (x: number[]) => [...x].sort((p, q) => p - q).join(',');
  return dias(b.dias) !== dias(o.dias) || b.nombre !== o.nombre || b.separar.trim() !== o.separar
    || b.cupos.trim() !== o.cupos || b.avisar !== o.avisar;
}
