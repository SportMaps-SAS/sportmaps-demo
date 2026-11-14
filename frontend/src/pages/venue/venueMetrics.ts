// Cálculos puros del panel del dueño de espacios (facility_manager). Sin red:
// la página lee las filas con consultas que ya existen y acá solo se suman.

export interface VenueFacility {
  id: string;
  name: string;
  available_hours?: unknown;
}

export interface VenueReservationRow {
  id: string;
  facility_id: string;
  reservation_date: string; // yyyy-MM-dd
  start_time: string; // HH:mm[:ss]
  end_time: string;
  status: string;
  price: number | null;
  amount_paid?: number | null;
}

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** Estados que ocupan la cancha (los demás no cuentan en la ocupación). */
const ESTADOS_QUE_OCUPAN = new Set(['confirmed', 'completed', 'pending', 'pending_payment', 'hold']);
/** Estados «por confirmar»: el dueño tiene algo que decidir o esperar. */
export const ESTADOS_POR_CONFIRMAR = new Set(['pending', 'pending_payment', 'pending_reconciliation']);
/** Estados cuyo valor cuenta como ingreso del mes. */
const ESTADOS_QUE_COBRAN = new Set(['confirmed', 'completed']);

export function horaAMinutos(t: string): number {
  const [h, m] = (t || '0:0').split(':');
  return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
}

/** Minutos que la cancha abre en un día de la semana según `available_hours`. */
export function minutosAbiertosDelDia(available: unknown, dayIndex: number): number {
  const raw = (available as Record<string, unknown> | null | undefined)?.[DAY_KEYS[dayIndex]];
  if (!Array.isArray(raw)) return 0;
  let total = 0;
  for (const franja of raw) {
    if (typeof franja !== 'string') continue;
    const [ini, fin] = franja.split('-');
    if (!ini || !fin) continue;
    const dur = horaAMinutos(fin) - horaAMinutos(ini);
    if (dur > 0) total += dur;
  }
  return total;
}

export function minutosAbiertosDeLaSemana(available: unknown): number {
  let total = 0;
  for (let d = 0; d < 7; d++) total += minutosAbiertosDelDia(available, d);
  return total;
}

export function duracionMinutos(r: Pick<VenueReservationRow, 'start_time' | 'end_time'>): number {
  return Math.max(0, horaAMinutos(r.end_time) - horaAMinutos(r.start_time));
}

/**
 * Ocupación de la semana: minutos reservados / minutos abiertos de todas las
 * canchas. null si no hay horario cargado (no se inventa un porcentaje).
 */
export function ocupacionSemanal(
  facilities: VenueFacility[],
  reservasDeLaSemana: VenueReservationRow[],
): number | null {
  const abiertos = facilities.reduce((acc, f) => acc + minutosAbiertosDeLaSemana(f.available_hours), 0);
  if (abiertos <= 0) return null;
  const reservados = reservasDeLaSemana
    .filter((r) => ESTADOS_QUE_OCUPAN.has(r.status))
    .reduce((acc, r) => acc + duracionMinutos(r), 0);
  return Math.min(100, Math.round((reservados / abiertos) * 100));
}

export function contarPorConfirmar(reservas: VenueReservationRow[]): number {
  return reservas.filter((r) => ESTADOS_POR_CONFIRMAR.has(r.status)).length;
}

/** Valor de las reservas confirmadas/completadas del mes. */
export function ingresosDelMes(reservasDelMes: VenueReservationRow[]): number {
  return reservasDelMes
    .filter((r) => ESTADOS_QUE_COBRAN.has(r.status))
    .reduce((acc, r) => acc + Number(r.price ?? 0), 0);
}

/** Arma el JSON `available_hours` con el mismo horario todos los días (o sábado/domingo distintos). */
export function construirHorario(
  semana: { desde: string; hasta: string },
  finDeSemana?: { desde: string; hasta: string },
): Record<string, string[]> {
  const sem = [`${semana.desde}-${semana.hasta}`];
  const fin = [`${(finDeSemana ?? semana).desde}-${(finDeSemana ?? semana).hasta}`];
  return {
    monday: sem, tuesday: sem, wednesday: sem, thursday: sem, friday: sem,
    saturday: fin, sunday: fin,
  };
}
