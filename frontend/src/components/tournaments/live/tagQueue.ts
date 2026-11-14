/**
 * Etiquetas de punto («¿quién hizo el punto?») que esperan a que su punto llegue al servidor.
 *
 * El anotador suma el punto en el celular al instante (cola offline) y el BFF valida la etiqueta
 * contra la secuencia CONFIRMADA (`live_state.points`): si se manda antes de que el POST del punto
 * termine, el servidor responde 422 `punto_invalido` (E2E 2026-10-28, B11). Por eso la etiqueta se
 * encola DETRÁS de la acción y se envía cuando el punto ya está en el servidor.
 */
export type TagStat = 'ace' | 'attack' | 'block';
export interface PendingTag { member_id: string; stat: TagStat; point_index: number; side: 'home' | 'away' }

/**
 * Reparte las etiquetas en espera según la secuencia confirmada y las acciones aún sin enviar:
 *   ready → el punto ya está en el servidor y lo ganó ese lado: enviar.
 *   keep  → el punto todavía no llega y hay acciones en cola: esperar.
 *   drop  → el punto no existe (se deshizo o se rechazó) o lo ganó el otro lado: descartar.
 */
export function sortTags(tags: PendingTag[], serverPoints: string, actionsPending: number): { ready: PendingTag[]; keep: PendingTag[]; drop: PendingTag[] } {
  const ready: PendingTag[] = []; const keep: PendingTag[] = []; const drop: PendingTag[] = [];
  for (const t of tags) {
    if (t.point_index < serverPoints.length) {
      (serverPoints.charAt(t.point_index) === (t.side === 'home' ? 'h' : 'a') ? ready : drop).push(t);
    } else if (actionsPending > 0) keep.push(t);
    else drop.push(t);
  }
  return { ready, keep, drop };
}
