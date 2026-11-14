/** Piezas puras del anotador en celular (probadas en live.test.ts). */
import type { SetDto } from '@/lib/tournamentTypes';
import type { ScorerScope } from './liveApi';

export const sideStorageKey = (matchId: string) => `sm_tlive_lado_${matchId}`;

/**
 * Del URL de acciones que ya recibe el anotador se saca a quién pertenece (organizador o enlace con
 * token), para no pedirle nada nuevo a las pantallas que lo montan.
 *   /api/v1/tournament-live/school/<eventId>/matches/<id>/actions
 *   /api/v1/tournament-live/scorer/<token>/matches/<id>/actions
 */
export function scorerScopeFromUrl(url: string): ScorerScope | null {
  const s = /\/tournament-live\/school\/([^/]+)\/matches\//.exec(url);
  if (s) return { kind: 'school', eventId: decodeURIComponent(s[1]) };
  const t = /\/tournament-live\/scorer\/([^/]+)\/matches\//.exec(url);
  if (t) return { kind: 'scorer', token: decodeURIComponent(t[1]) };
  return null;
}

/** «Set 2 para Monsters · 25-22» o «¡Partido para Monsters! 2-0». */
export function setEventText(sets: SetDto[], idx: number, homeName: string, awayName: string, decided: boolean): string {
  const s = sets[idx];
  if (!s) return '';
  const homeWon = s.home > s.away;
  const winner = homeWon ? homeName : awayName;
  const score = homeWon ? `${s.home}-${s.away}` : `${s.away}-${s.home}`;
  if (decided) {
    const closed = sets.filter((x) => x.closed);
    const hw = closed.filter((x) => x.home > x.away).length;
    const aw = closed.length - hw;
    return `¡Partido para ${winner}! ${Math.max(hw, aw)}-${Math.min(hw, aw)} · toca «Terminar partido»`;
  }
  return `Set ${idx + 1} para ${winner} · ${score}`;
}
