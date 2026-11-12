/**
 * Quién organiza un torneo: una escuela (creator_role 'school') o una organización de torneos
 * (school_type 'event_organizer' → creator_role 'organizer'). Spec organizador-torneos-modulo-aparte §3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/supabase', async () => {
  const kit = await import('./fakeDb.testkit');
  return { supabase: kit.fakeSupabase };
});

import { db, resetDb, seedEvent } from './fakeDb.testkit';
import {
  assertTournamentOrganizer, schoolOrganizesTournament, creatorRoleForSchoolType, isTournamentOwnerRole, TOURNAMENT_OWNER_ROLES,
} from './tournament-access';

beforeEach(() => resetDb());

describe('creatorRoleForSchoolType', () => {
  it('event_organizer guarda organizer; todo lo demás guarda school', () => {
    expect(creatorRoleForSchoolType('event_organizer')).toBe('organizer');
    for (const t of ['academy', 'club', 'hybrid', 'escuela', 'gimnasio', 'venue', 'personal_trainer', null, undefined]) {
      expect(creatorRoleForSchoolType(t as any)).toBe('school');
    }
  });

  it('los valores que produce son exactamente los que acepta el helper de propiedad', () => {
    expect([...TOURNAMENT_OWNER_ROLES].sort()).toEqual(['organizer', 'school']);
    expect(isTournamentOwnerRole(creatorRoleForSchoolType('event_organizer'))).toBe(true);
    expect(isTournamentOwnerRole(creatorRoleForSchoolType('academy'))).toBe(true);
    expect(isTournamentOwnerRole('admin')).toBe(false);
    expect(isTournamentOwnerRole(undefined)).toBe(false);
  });
});

describe('schoolOrganizesTournament / assertTournamentOrganizer con una organización de torneos', () => {
  it('el organizador (school_id propio) administra su torneo y no el de otra entidad', async () => {
    const ev = seedEvent({ school_id: 'org-1', creator_role: 'organizer' });
    expect(await schoolOrganizesTournament(ev.id, 'org-1')).toBe(true);
    expect(await schoolOrganizesTournament(ev.id, 'org-2')).toBe(false);
    expect(await schoolOrganizesTournament(ev.id, null)).toBe(false);
    await expect(assertTournamentOrganizer({ schoolId: 'org-1' } as any, ev.id)).resolves.toMatchObject({ id: ev.id });
    await expect(assertTournamentOrganizer({ schoolId: 'org-2' } as any, ev.id)).rejects.toMatchObject({ status: 404 });
    await expect(assertTournamentOrganizer({ schoolId: undefined } as any, ev.id)).rejects.toMatchObject({ status: 403 });
  });

  it('una escuela sigue administrando su torneo igual que antes', async () => {
    const ev = seedEvent({ school_id: 'school-1', creator_role: 'school' });
    expect(await schoolOrganizesTournament(ev.id, 'school-1')).toBe(true);
    await expect(assertTournamentOrganizer({ schoolId: 'school-1' } as any, ev.id)).resolves.toMatchObject({ id: ev.id });
  });

  it('un evento con otro creador (sin escuela dueña) no es administrable aunque coincida el school_id', async () => {
    const ev = seedEvent({ school_id: 'school-1', creator_role: 'store_owner' });
    expect(await schoolOrganizesTournament(ev.id, 'school-1')).toBe(false);
    await expect(assertTournamentOrganizer({ schoolId: 'school-1' } as any, ev.id)).rejects.toMatchObject({ status: 404 });
    expect(db.tables.events.length).toBeGreaterThan(0);
  });
});
