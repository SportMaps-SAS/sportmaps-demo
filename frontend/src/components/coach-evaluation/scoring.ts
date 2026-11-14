/**
 * Cuentas de la evaluación de entrenadores con «No aplica» (plan
 * docs/plan-evaluaciones-na-f1.md §2). Mismas reglas que save_coach_evaluation:
 * N/A queda fuera del numerador y del denominador; sin aplicables el promedio
 * es null; publicar exige al menos un ítem con nota.
 */

export interface ScoreItem {
  score?: number | null;
  na?: boolean;
}

export interface ScoreSummary {
  /** Ítems con nota (aplican). */
  applicable: number;
  /** Ítems marcados «No aplica». */
  na: number;
  /** Respondidos: con nota o N/A. */
  answered: number;
  /** Ítems en total (respondidos o no). */
  total: number;
  /** Promedio de los aplicables; null si no hay ninguno. */
  average: number | null;
}

const hasScore = (i: ScoreItem | undefined) => !!i && !i.na && !!i.score;

export function summarizeScores(items: (ScoreItem | undefined)[]): ScoreSummary {
  const applicableItems = items.filter(hasScore);
  const na = items.filter((i) => !!i?.na).length;
  const applicable = applicableItems.length;
  const sum = applicableItems.reduce((n, i) => n + (i!.score as number), 0);
  return {
    applicable,
    na,
    answered: applicable + na,
    total: items.length,
    average: applicable > 0 ? sum / applicable : null,
  };
}

/** Igual que round(x, 2) de SQL (para mostrar/comparar con overall_score). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Publicar exige al menos un ítem con nota (el borrador sí puede ser todo N/A). */
export const canPublish = (s: ScoreSummary) => s.applicable >= 1;

/** Aviso suave: más de la mitad de los ítems en N/A. */
export const naMajority = (s: ScoreSummary) => s.total > 0 && s.na * 2 > s.total;

/** «5 de 6 ítems». */
export function formatCount(applicable: number, total: number): string {
  return `${applicable} de ${total} ${total === 1 ? 'ítem' : 'ítems'}`;
}

export interface ScorePayloadItem {
  criterion_id: string;
  score: number | null;
  not_applicable?: boolean;
  comment: string | null;
}

/**
 * Arma p_scores. Con el flag apagado el payload es IDÉNTICO al de antes (sin la
 * clave not_applicable); con el flag encendido los N/A van {score:null, not_applicable:true}.
 */
export function buildScoresPayload(
  items: { id: string; state?: { score?: number; na?: boolean; comment: string } }[],
  opts: { allowNa: boolean },
): ScorePayloadItem[] {
  const out: ScorePayloadItem[] = [];
  for (const { id, state } of items) {
    if (!state) continue;
    const comment = state.comment || null;
    if (opts.allowNa && state.na) {
      out.push({ criterion_id: id, score: null, not_applicable: true, comment });
    } else if (state.score) {
      out.push({ criterion_id: id, score: state.score, comment });
    }
  }
  return out;
}
