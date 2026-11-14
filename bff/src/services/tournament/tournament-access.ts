/**
 * ÚNICO lugar donde se decide quién organiza un torneo (pantallas de administración).
 * Organiza quien administra la entidad dueña del torneo (`events.school_id` = entidad del usuario):
 * una escuela (`creator_role = 'school'`) o una organización de torneos (`schools.school_type =
 * 'event_organizer'`, `creator_role = 'organizer'`). Spec: docs/specs/organizador-torneos-modulo-aparte.md §3.
 * NO comparar `creator_role === 'school'` a mano en rutas nuevas: usar este archivo.
 * Lo público y el anotador sin cuenta NO pasan por aquí (ni por school_members).
 */
import { supabase } from '../../config/supabase';
import type { AuthenticatedRequest } from '../../middlewares/authMiddleware';
import { LiveError, loadEvent, type LiveEvent } from './tournament-live.service';

/** Valores de events.creator_role que pueden ser dueños de un torneo con school_id (CHECK events_creator_role_check). */
export const TOURNAMENT_OWNER_ROLES = ['school', 'organizer'] as const;

/** creator_role que se guarda al crear un torneo, según el tipo de la entidad que lo crea. */
export function creatorRoleForSchoolType(schoolType: string | null | undefined): 'school' | 'organizer' {
  return schoolType === 'event_organizer' ? 'organizer' : 'school';
}

/** ¿Este creator_role puede ser dueño de un torneo? */
export function isTournamentOwnerRole(role: unknown): boolean {
  return (TOURNAMENT_OWNER_ROLES as readonly string[]).includes(String(role));
}

/** ¿Esta escuela organiza este torneo? (versión booleana para las rutas heredadas de events.route). */
export async function schoolOrganizesTournament(eventId: string, schoolId: string | null | undefined): Promise<boolean> {
  if (!schoolId) return false;
  const { data } = await supabase.from('events').select('id').eq('id', eventId).eq('school_id', schoolId).in('creator_role', [...TOURNAMENT_OWNER_ROLES]).maybeSingle();
  return !!data;
}

/**
 * Carga el torneo si el usuario lo organiza; si no, 403 (sin escuela) o 404 (no es suyo).
 * Una sola lectura: `loadEvent` ya trae school_id y creator_role (antes eran dos consultas seguidas en
 * CADA acción del anotador). La regla es la misma de `schoolOrganizesTournament`.
 */
export async function assertTournamentOrganizer(req: AuthenticatedRequest, eventId: string): Promise<LiveEvent> {
  const schoolId = req.schoolId;
  if (!schoolId) throw new LiveError(403, 'sin_escuela', 'No se pudo resolver la escuela del usuario.');
  const ev = await loadEvent(eventId);
  if (!ev || ev.school_id !== schoolId) throw new LiveError(404, 'torneo_no_encontrado', 'Torneo no encontrado');
  // Sin la columna en la respuesta (no debería pasar) se pregunta como antes, nunca se asume.
  const organizes = ev.creator_role !== undefined ? isTournamentOwnerRole(ev.creator_role) : await schoolOrganizesTournament(eventId, schoolId);
  if (!organizes) throw new LiveError(404, 'torneo_no_encontrado', 'Torneo no encontrado');
  return ev;
}
