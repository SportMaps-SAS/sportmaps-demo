/**
 * ÚNICO lugar que decide si alguien puede crear/gestionar torneos.
 *
 * Hoy: Torneos es un COMPLEMENTO de la escuela (`has_tournaments` → addon 'tournaments'); el admin
 * lo gestiona con su misma cuenta. El ORGANIZADOR (ligas, federaciones, eventos) usa el mismo motor
 * con su propio panel. Si mañana el organizador paga el módulo aparte, se cambia aquí y en
 * el gate del BFF (POST /api/v1/events/school-tournament y POST /api/v1/events).
 */
import { useAuth } from '@/contexts/AuthContext';
import { useEntitlements } from '@/hooks/useEntitlements';

export type TournamentActor = 'school' | 'organizer';

export interface TournamentAccess {
  loading: boolean;
  allowed: boolean;
  actor: TournamentActor | null;
  /** Por qué no puede (copy listo para la pantalla). */
  reason: string | null;
  /** A dónde mandarlo para activarlo. */
  upgradeHref: string | null;
}

const SCHOOL_ROLES = new Set(['school', 'school_admin', 'admin']);

/** Regla pura (probada): rol + complemento → acceso. */
export function tournamentAccessFor(input: { role: string | null | undefined; hasTournamentsAddon: boolean; loading?: boolean }): TournamentAccess {
  const loading = !!input.loading;
  if (input.role === 'organizer') return { loading, allowed: true, actor: 'organizer', reason: null, upgradeHref: null };
  if (input.role && SCHOOL_ROLES.has(input.role)) {
    return input.hasTournamentsAddon
      ? { loading, allowed: true, actor: 'school', reason: null, upgradeHref: null }
      : { loading, allowed: false, actor: 'school', reason: 'Activa el complemento Torneos para crear y gestionar tus propios torneos.', upgradeHref: '/mi-plan' };
  }
  return { loading, allowed: false, actor: null, reason: 'Tu cuenta no puede crear torneos.', upgradeHref: null };
}

export function useTournamentAccess(): TournamentAccess {
  const { profile, loading: authLoading } = useAuth();
  const { hasAddon, isLoading } = useEntitlements();
  const role = profile?.role ?? null;
  // El organizador no tiene escuela: sus entitlements no aplican.
  const addon = role === 'organizer' ? false : hasAddon('tournaments');
  return tournamentAccessFor({ role, hasTournamentsAddon: addon, loading: authLoading || (role !== 'organizer' && isLoading) });
}
