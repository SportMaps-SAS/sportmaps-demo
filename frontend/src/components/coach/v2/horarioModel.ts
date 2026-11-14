/**
 * «Agregar horario» de un equipo sin horario fijo (lista del usuario, ítem 31).
 * teams.schedule es jsonb `[{ day, time, end?, place? }]` (day 0 = domingo), el
 * mismo formato que leen Hoy, Sesiones y el acudiente (leerFranjas).
 *
 * Permiso: la RLS deja al entrenador actualizar SUS equipos ("Teams: coach
 * update own" / "coach manage own (scoped)") y el trigger
 * teams_guard_coach_update solo le cierra estado, precio, sede y entrenador.
 * Si la base no deja (0 filas o 42501), la pantalla le dice que se lo pida a
 * la administración.
 */
import type { Franja } from '@/components/parent/v2/parentHomeLogic';

/** Orden de la semana colombiana: lunes primero. */
export const DIAS_SEMANA: { day: number; corto: string; largo: string }[] = [
  { day: 1, corto: 'L', largo: 'Lunes' },
  { day: 2, corto: 'M', largo: 'Martes' },
  { day: 3, corto: 'X', largo: 'Miércoles' },
  { day: 4, corto: 'J', largo: 'Jueves' },
  { day: 5, corto: 'V', largo: 'Viernes' },
  { day: 6, corto: 'S', largo: 'Sábado' },
  { day: 0, corto: 'D', largo: 'Domingo' },
];

export interface FormHorario {
  dias: number[];
  inicio: string; // HH:MM
  fin: string; // HH:MM ('' = sin hora de fin)
  lugar: string;
}

export const AVISO_SIN_PERMISO_HORARIO = 'Pídele al administrador que configure el horario.';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** null si está bien; si no, qué corregir (en palabras del profe). */
export function errorHorario(f: FormHorario): string | null {
  if (f.dias.length === 0) return 'Elige al menos un día.';
  if (!HHMM.test(f.inicio)) return 'Escribe la hora de inicio.';
  if (f.fin && !HHMM.test(f.fin)) return 'La hora de fin no es válida.';
  if (f.fin && f.fin <= f.inicio) return 'La hora de fin tiene que ser después de la de inicio.';
  return null;
}

/**
 * Suma las franjas nuevas a las que ya tenía el equipo, sin duplicar el mismo
 * día y hora de inicio (la nueva reemplaza a la vieja). Orden: lunes primero.
 */
export function agregarFranjas(existentes: Franja[], f: FormHorario): Franja[] {
  const lugar = f.lugar.trim().slice(0, 120);
  const nuevas: Franja[] = [...new Set(f.dias)].map((day) => ({
    day,
    time: f.inicio,
    ...(f.fin ? { end: f.fin } : {}),
    ...(lugar ? { place: lugar } : {}),
  }));
  const clave = (x: Franja) => `${x.day}|${x.time}`;
  const nuevasClaves = new Set(nuevas.map(clave));
  const orden = (x: Franja) => ((x.day + 6) % 7) * 1440 + Number(x.time.slice(0, 2)) * 60 + Number(x.time.slice(3, 5));
  return [...existentes.filter((x) => !nuevasClaves.has(clave(x))), ...nuevas].sort((a, b) => orden(a) - orden(b));
}

/** ¿La respuesta del UPDATE significa «no tienes permiso»? */
export function esSinPermiso(error: { code?: string | null } | null | undefined, filas: number): boolean {
  if (error) return error.code === '42501';
  return filas === 0;
}
