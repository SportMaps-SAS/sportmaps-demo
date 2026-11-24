/**
 * Tenant primero (plan §7, paso 0): la escuela sale de la sesión, sin header
 * no hay agente, el rol se lee en ESA escuela y el apagado global manda.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ responder: (_c: any): any => undefined }));
vi.mock('../../config/supabase', async () => {
    const { crearSupabaseFalso } = await import('./supabase-falso.test-helper');
    const falso = crearSupabaseFalso((c) => h.responder(c));
    (globalThis as any).__consultas = falso.consultas;
    return { supabase: falso.supabase, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba' };
});
vi.mock('../mapi-contexto.service', () => ({ idsDeCoach: async (u: string) => [u, 'staff-1'] }));

import { alcanceDelTurno, rolDeMembresias } from './alcance';
import { eqDe } from './supabase-falso.test-helper';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function escuela(p: { roles: Record<string, string[]>; prendido: Record<string, boolean> }) {
    h.responder = (c) => {
        const id = eqDe(c, 'school_id') as string;
        if (c.tabla === 'school_members') return { data: (p.roles[id] ?? []).map((role) => ({ role })) };
        if (c.tabla === 'school_settings') return { data: [{ mapi_agent_enabled: p.prendido[id] ?? false, coach_mapi_attendance: true, coach_mapi_notices: true, coach_hide_financial_info: false }] };
        if (c.tabla === 'teams') return { data: id === A ? [{ id: 'equipo-a' }] : [{ id: 'equipo-b' }] };
        if (c.tabla === 'team_coaches') return { data: [] };
        return undefined;
    };
}

beforeEach(() => { (globalThis as any).__consultas.length = 0; });
afterEach(() => { delete process.env.MAPI_AGENT_ENABLED; });

describe('rolDeMembresias', () => {
    it('admin gana a coach; acudiente y deportista no tienen agente', () => {
        expect(rolDeMembresias(['coach', 'school_admin'])).toBe('admin');
        expect(rolDeMembresias(['owner'])).toBe('admin');
        expect(rolDeMembresias(['coach', 'parent'])).toBe('coach');
        expect(rolDeMembresias(['parent', 'athlete'])).toBeNull();
    });
});

describe('alcanceDelTurno', () => {
    it('sin x-school-id no hay agente (no se adivina la escuela)', async () => {
        escuela({ roles: { [A]: ['owner'] }, prendido: { [A]: true } });
        expect(await alcanceDelTurno({ userId: 'u', schoolId: A, headerSchoolId: undefined })).toBeNull();
        expect(await alcanceDelTurno({ userId: 'u', schoolId: A, headerSchoolId: B })).toBeNull();
    });

    it('mismo usuario en dos escuelas: cada turno con la activa; el rol y los equipos son los de ESA escuela', async () => {
        escuela({ roles: { [A]: ['owner'], [B]: ['coach'] }, prendido: { [A]: true, [B]: true } });
        const enA = await alcanceDelTurno({ userId: 'u', schoolId: A, headerSchoolId: A });
        const enB = await alcanceDelTurno({ userId: 'u', schoolId: B, headerSchoolId: B });
        expect(enA).toMatchObject({ schoolId: A, rol: 'admin', teamIds: [] });
        expect(enB).toMatchObject({ schoolId: B, rol: 'coach', teamIds: ['equipo-b'] });
    });

    it('escuela sin el agente prendido → modo soporte', async () => {
        escuela({ roles: { [A]: ['owner'] }, prendido: { [A]: false } });
        expect(await alcanceDelTurno({ userId: 'u', schoolId: A, headerSchoolId: A })).toBeNull();
    });

    it('acudiente en una escuela con agente → modo soporte', async () => {
        escuela({ roles: { [A]: ['parent'] }, prendido: { [A]: true } });
        expect(await alcanceDelTurno({ userId: 'u', schoolId: A, headerSchoolId: A })).toBeNull();
    });

    it('MAPI_AGENT_ENABLED=false apaga todo sin consultar la base', async () => {
        process.env.MAPI_AGENT_ENABLED = 'false';
        escuela({ roles: { [A]: ['owner'] }, prendido: { [A]: true } });
        expect(await alcanceDelTurno({ userId: 'u', schoolId: A, headerSchoolId: A })).toBeNull();
        expect((globalThis as any).__consultas).toHaveLength(0);
    });

    it('sin la migración (columna inexistente) → modo soporte', async () => {
        h.responder = (c) => (c.tabla === 'school_settings' ? { error: { message: 'column does not exist' } } : { data: [{ role: 'owner' }] });
        expect(await alcanceDelTurno({ userId: 'u', schoolId: A, headerSchoolId: A })).toBeNull();
    });

    it('la fecha es la de Colombia', async () => {
        escuela({ roles: { [A]: ['owner'] }, prendido: { [A]: true } });
        const a = await alcanceDelTurno({ userId: 'u', schoolId: A, headerSchoolId: A, ahora: new Date('2026-11-24T03:00:00Z') });
        expect(a?.hoy).toBe('2026-11-23');
    });
});
