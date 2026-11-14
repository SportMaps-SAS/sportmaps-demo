/**
 * Qué semana del mesociclo se marca y cuál arranca abierta (MesocycleSection).
 * Lógica pura para poder probarla sin React.
 */
export interface SemanaRango {
  id: string;
  starts_on: string; // YYYY-MM-DD
  ends_on: string;   // YYYY-MM-DD
}

/** La semana que contiene `fecha`, o null. */
export function semanaQueContiene(semanas: SemanaRango[], fecha: string | null | undefined): string | null {
  if (!fecha) return null;
  return semanas.find((s) => s.starts_on <= fecha && fecha <= s.ends_on)?.id ?? null;
}

/**
 * Insignia «Esta semana»: SOLO si la semana contiene hoy. B7: antes, un
 * mesociclo ya terminado marcaba su última semana como «Esta semana».
 */
export function semanaDeHoy(semanas: SemanaRango[], hoy: string): string | null {
  return semanaQueContiene(semanas, hoy);
}

/**
 * Semana que arranca abierta: la del día pedido (`?fecha=` desde Sesiones), si
 * no la de hoy; si el mesociclo es futuro, la primera; si ya pasó, la última.
 */
export function semanaInicialAbierta(semanas: SemanaRango[], hoy: string, foco?: string | null): string | null {
  if (semanas.length === 0) return null;
  const pedida = semanaQueContiene(semanas, foco);
  if (pedida) return pedida;
  const actual = semanaQueContiene(semanas, hoy);
  if (actual) return actual;
  return hoy < semanas[0].starts_on ? semanas[0].id : semanas[semanas.length - 1].id;
}
