/**
 * Promedios de la rúbrica del mesociclo con «No aplica» (plan
 * docs/plan-evaluaciones-na-f1.md §2). Solo de visualización: nada se guarda.
 * N/A y pendientes quedan fuera del numerador y del denominador; sin notas el
 * promedio es null. Pendiente (sin fila) ≠ N/A (decidido).
 */

export interface RubricCell {
  score: number | null;
  na: boolean;
}

export interface RubricSummary {
  average: number | null;
  /** Celdas con nota. */
  applicable: number;
  na: number;
  pending: number;
  /** Celdas posibles (5 por indicador, 30 en total). */
  total: number;
}

export function summarizeCells(cells: (RubricCell | undefined)[]): RubricSummary {
  let sum = 0;
  let applicable = 0;
  let na = 0;
  let pending = 0;
  for (const c of cells) {
    if (!c) pending += 1;
    else if (c.na) na += 1;
    else if (c.score != null) {
      applicable += 1;
      sum += c.score;
    } else pending += 1;
  }
  return {
    average: applicable > 0 ? sum / applicable : null,
    applicable,
    na,
    pending,
    total: cells.length,
  };
}

/**
 * `cells` es la tabla de celdas guardadas, con llave `${indicator}__${checkpoint}`.
 * Devuelve el resumen por indicador y el global (indicadores x cortes).
 */
export function summarizeRubric(
  cells: Map<string, RubricCell>,
  indicators: readonly string[],
  checkpoints: readonly string[],
): { byIndicator: Record<string, RubricSummary>; overall: RubricSummary } {
  const byIndicator: Record<string, RubricSummary> = {};
  const all: (RubricCell | undefined)[] = [];
  for (const ind of indicators) {
    const row = checkpoints.map((cp) => cells.get(`${ind}__${cp}`));
    byIndicator[ind] = summarizeCells(row);
    all.push(...row);
  }
  return { byIndicator, overall: summarizeCells(all) };
}
