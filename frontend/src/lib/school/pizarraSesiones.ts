/**
 * Pizarra libre (/pizarra) → «Agregar a una sesión»: a qué bloques de las
 * próximas sesiones del equipo se puede llevar la jugada. Lógica pura
 * (src/test/pizarraSesiones.test.ts).
 *
 * La pizarra de una sesión vive por BLOQUE (football_lineups con
 * source_type 'training_session' y source_id = id del bloque), igual que
 * cuando se abre desde la sesión. Un bloque sin id se lo asigna quien lo
 * elige (blockIdPatch), como hace Sesiones V2.
 */
import { bloquesDeSesion } from '@/components/coach/v2/sesionesModel';

export interface SesionParaPizarra {
  id: string;
  session_date: string;
  session_blocks?: unknown;
  warmup?: string | null;
  drills?: unknown;
}

export interface DestinoBloque {
  sessionId: string;
  date: string;
  /** null = bloque nuevo «Pizarra» al final de la sesión. */
  blockIndex: number | null;
  blockId: string | null;
  name: string;
}

export interface DestinoSesion {
  sessionId: string;
  date: string;
  blocks: DestinoBloque[];
  /** Se puede agregar un bloque nuevo (la sesión usa bloques o está vacía). */
  canAppend: boolean;
  /** Sesión vieja con calentamiento/ejercicios sueltos: se edita en Sesiones. */
  legacyOnly: boolean;
}

const hasText = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

export function destinosDeSesiones(sesiones: SesionParaPizarra[]): DestinoSesion[] {
  return [...sesiones]
    .sort((a, b) => a.session_date.localeCompare(b.session_date))
    .map((s) => {
      const usesBlocks = Array.isArray(s.session_blocks) && s.session_blocks.length > 0;
      const legacy = !usesBlocks && (hasText(s.warmup) || (Array.isArray(s.drills) && s.drills.length > 0));
      const blocks: DestinoBloque[] = usesBlocks
        ? bloquesDeSesion(s).map((b) => ({
          sessionId: s.id, date: s.session_date, blockIndex: b.index, blockId: b.id ?? null, name: b.nombre,
        }))
        : [];
      return { sessionId: s.id, date: s.session_date, blocks, canAppend: !legacy, legacyOnly: legacy };
    });
}

/**
 * session_blocks con el id asegurado en el bloque `index` (o un bloque nuevo
 * «Pizarra» al final si index es null). Devuelve el arreglo a guardar y el id.
 */
export function blockIdPatch(sessionBlocks: unknown, index: number | null, newId: string): { blocks: unknown[]; blockId: string } {
  const list = Array.isArray(sessionBlocks) ? sessionBlocks.slice() : [];
  if (index === null) {
    list.push({ id: newId, name: 'Pizarra', minutes: null, activity: '' });
    return { blocks: list, blockId: newId };
  }
  const cur = (list[index] ?? {}) as Record<string, unknown>;
  if (typeof cur.id === 'string' && cur.id) return { blocks: list, blockId: cur.id };
  list[index] = { ...cur, id: newId };
  return { blocks: list, blockId: newId };
}
