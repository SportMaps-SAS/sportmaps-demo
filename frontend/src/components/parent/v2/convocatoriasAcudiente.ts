/**
 * Convocatorias de los hijos del acudiente (B1) — lógica pura.
 *
 * `my_callups()` (lib/api/v2Contratos → MiConvocatoria) devuelve las
 * convocatorias de partidos que no han pasado: de los hijos del acudiente
 * (subject_type 'child', sale de children.parent_id = auth.uid()), de él como
 * deportista adulto y de su ficha. Aquí solo interesan las de los HIJOS: las
 * propias las responde en su app de deportista.
 *
 * `respond_callup` acepta al acudiente: `_callup_subject_account('child', id)`
 * es `children.parent_id` (verificado en pg_proc el 2026-10-27).
 */
import { localDayKey } from './parentCalendarModel';
import { horaColombia, primerNombre } from './parentHomeLogic';

export type Respuesta = 'va' | 'no_va';

export interface ConvocatoriaHijo {
  lineupId: string;
  matchId: string | null;
  teamId: string | null;
  childId: string;
  /** Primer nombre del hijo. */
  nombre: string;
  rival: string | null;
  /** 'YYYY-MM-DD' del partido. */
  fecha: string | null;
  /** «10:00 a. m.» */
  hora: string | null;
  lugar: string | null;
  nota: string | null;
  titular: boolean;
  respuesta: Respuesta | null;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function horaDe(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return horaColombia(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
}

/** Filas de `my_callups()` → convocatorias de los hijos, del partido más cercano al más lejano. */
export function convocatoriasDeHijos(rows: unknown, nombres: Record<string, string> = {}): ConvocatoriaHijo[] {
  if (!Array.isArray(rows)) return [];
  const out: ConvocatoriaHijo[] = [];
  for (const raw of rows as Raw[]) {
    if (!raw || typeof raw !== 'object') continue;
    if (str(raw.subject_type) !== 'child') continue;
    const childId = str(raw.subject_id);
    const lineupId = str(raw.lineup_id);
    if (!childId || !lineupId) continue;
    const resp = str(raw.response);
    const kickoff = str(raw.kickoff_at);
    out.push({
      lineupId,
      matchId: str(raw.match_id),
      teamId: str(raw.team_id),
      childId,
      nombre: primerNombre(nombres[childId] ?? str(raw.athlete_name)) || 'Tu hijo',
      rival: str(raw.opponent),
      fecha: str(raw.match_date) ?? (kickoff ? localDayKey(new Date(kickoff)) : null),
      hora: horaDe(kickoff),
      lugar: str(raw.location),
      nota: str(raw.notes),
      titular: str(raw.role) === 'starter',
      respuesta: resp === 'va' || resp === 'no_va' ? resp : null,
    });
  }
  return out.sort((a, b) => `${a.fecha ?? ''}${a.hora ?? ''}`.localeCompare(`${b.fecha ?? ''}${b.hora ?? ''}`));
}

/** Las convocatorias de un hijo (para su tarjeta en Inicio): solo la del partido más próximo. */
export function proximaConvocatoriaDe(convs: ConvocatoriaHijo[], childId: string): ConvocatoriaHijo | null {
  return convs.find((c) => c.childId === childId) ?? null;
}

/**
 * Las convocatorias que corresponden a un partido del Calendario: mismo equipo y
 * mismo día. `calendar_events` no guarda el id del partido (create_match crea el
 * evento con el equipo y la fecha), así que se cruza por (equipo, día).
 */
export function convocatoriasDelEvento(
  convs: ConvocatoriaHijo[],
  evento: { teamId?: string | null; start: Date; kind: string },
): ConvocatoriaHijo[] {
  if (evento.kind !== 'match' || !evento.teamId) return [];
  const dia = localDayKey(evento.start);
  return convs.filter((c) => c.teamId === evento.teamId && c.fecha === dia);
}

/** «¿Va Tomás al partido contra Halcones FC?» */
export function preguntaConvocatoria(c: ConvocatoriaHijo): string {
  return c.rival ? `¿Va ${c.nombre} al partido contra ${c.rival}?` : `¿Va ${c.nombre} al próximo partido?`;
}

/** «Va» / «No va» ya respondido, en una frase para el acudiente. */
export function fraseRespuesta(c: Pick<ConvocatoriaHijo, 'nombre'>, r: Respuesta): string {
  return r === 'va' ? `Le avisaste al profe que ${c.nombre} va.` : `Le avisaste al profe que ${c.nombre} no puede ir.`;
}
