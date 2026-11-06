/**
 * Formato POR PARTIDO del Partido en vivo (D-V1, spec partido-en-vivo-sustituciones §13/§16.1).
 * Columnas de match_results (mig 20261105231554):
 *   live_periods_count 1..4 · live_period_minutes 5..60 · match_kind 'official'|'practice'
 *   (default 'official') · referee_name NULL o 1..120 caracteres.
 * Con el flag `live_match_enabled` apagado NO se manda ninguna columna nueva.
 */
export type MatchKind = 'official' | 'practice';

export interface FormatoVivoForm {
  periodos: number;
  minutos: number;
  clase: MatchKind;
  arbitro: string;
}

export const FORMATO_VIVO_DEFECTO: FormatoVivoForm = { periodos: 2, minutos: 45, clase: 'official', arbitro: '' };

export const PERIODOS_MIN = 1;
export const PERIODOS_MAX = 4;
export const MINUTOS_MIN = 5;
export const MINUTOS_MAX = 60;
export const ARBITRO_MAX = 120;

export function validarFormatoVivo(f: FormatoVivoForm): string | null {
  if (!Number.isInteger(f.periodos) || f.periodos < PERIODOS_MIN || f.periodos > PERIODOS_MAX) {
    return `Los tiempos deben ser entre ${PERIODOS_MIN} y ${PERIODOS_MAX}.`;
  }
  if (!Number.isInteger(f.minutos) || f.minutos < MINUTOS_MIN || f.minutos > MINUTOS_MAX) {
    return `Cada tiempo debe durar entre ${MINUTOS_MIN} y ${MINUTOS_MAX} minutos.`;
  }
  if (f.clase !== 'official' && f.clase !== 'practice') return 'Escoge si el partido es oficial o de práctica.';
  if (f.arbitro.trim().length > ARBITRO_MAX) return `El nombre del árbitro admite máximo ${ARBITRO_MAX} caracteres.`;
  return null;
}

/** Columnas nuevas para el payload; `{}` con el flag apagado (payload idéntico al de hoy). */
export function payloadFormatoVivo(enabled: boolean, f: FormatoVivoForm): Record<string, unknown> {
  if (!enabled) return {};
  const arbitro = f.arbitro.trim();
  return {
    live_periods_count: f.periodos,
    live_period_minutes: f.minutos,
    match_kind: f.clase,
    referee_name: arbitro === '' ? null : arbitro,
  };
}
