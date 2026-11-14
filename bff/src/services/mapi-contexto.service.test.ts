/**
 * Equipos del coach en el contexto de Mapi (2026-10-27): Mapi le dijo a
 * Carlos Ramírez que no tenía equipos teniendo Lightning y Thunder, porque
 * buscaba `teams.coach_id = <perfil>` y ese campo guarda el id de school_staff.
 */
import { describe, expect, it, vi } from 'vitest';

const PERFIL = '4abdae3c-aa95-4e86-89ee-d870615ab665';
const STAFF = '66f3c7b5-e504-4221-a5a0-74ee53dd6077';
const ESCUELA = 'de300000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => {
    const filtros: { table: string; op: string; col: string; val: unknown }[] = [];
    // Datos como en la base: los equipos apuntan al school_staff, no al perfil.
    const tablas: Record<string, any[]> = {};
    function builder(table: string) {
        const conds: ((r: any) => boolean)[] = [];
        const b: any = {};
        b.select = () => b;
        b.eq = (col: string, val: unknown) => { filtros.push({ table, op: 'eq', col, val }); conds.push((r) => r[col] === val); return b; };
        b.in = (col: string, vals: unknown[]) => { filtros.push({ table, op: 'in', col, val: vals }); conds.push((r) => vals.includes(r[col])); return b; };
        const res = () => ({ data: (tablas[table] || []).filter((r) => conds.every((c) => c(r))), error: null });
        b.maybeSingle = async () => ({ data: res().data[0] ?? null, error: null });
        b.then = (ok: any, ko: any) => Promise.resolve(res()).then(ok, ko);
        return b;
    }
    return { filtros, tablas, supabase: { from: (t: string) => builder(t) } };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));

import { construirContextoMapi, contextoComoTexto, idsDeCoach } from './mapi-contexto.service';

h.tablas.profiles = [{ id: PERFIL, full_name: 'Carlos Ramírez', role: 'coach' }];
h.tablas.school_members = [{ profile_id: PERFIL, role: 'coach', school_id: ESCUELA, status: 'active', schools: { name: 'Escuela Demo SportMaps' } }];
h.tablas.school_staff = [{ id: STAFF, coach_auth_id: PERFIL }];
h.tablas.teams = [
    { name: 'Lightning', coach_id: STAFF, school_id: ESCUELA },
    { name: 'Thunder', coach_id: STAFF, school_id: ESCUELA },
    { name: 'De otro profe', coach_id: 'otro-staff', school_id: ESCUELA },
];
h.tablas.team_coaches = [];
h.tablas.school_module_overrides = [];

describe('mapi-contexto: equipos del coach', () => {
    it('encuentra los equipos asignados por school_staff (teams.coach_id = id del staff)', async () => {
        const ctx = await construirContextoMapi(PERFIL, ESCUELA);
        expect(ctx.roles).toContain('coach');
        expect(ctx.equiposQueEntrena.sort()).toEqual(['Lightning', 'Thunder']);
        expect(contextoComoTexto(ctx)).toContain('Equipos que entrena: Lightning, Thunder');
    });

    it('ninguna consulta de equipos filtra coach_id solo por el perfil', async () => {
        h.filtros.length = 0;
        await construirContextoMapi(PERFIL, ESCUELA);
        const porCoach = h.filtros.filter((f) => (f.table === 'teams' || f.table === 'team_coaches') && f.col === 'coach_id');
        expect(porCoach.length).toBe(2);
        for (const f of porCoach) {
            expect(f.op).toBe('in');
            expect(f.val).toEqual(expect.arrayContaining([PERFIL, STAFF]));
        }
    });

    it('idsDeCoach junta el perfil y sus filas de staff, sin repetir', async () => {
        expect(await idsDeCoach(PERFIL)).toEqual([PERFIL, STAFF]);
    });
});

// Tenant (2026-11-14): Mapi responde solo con la escuela ACTIVA de la sesión.
// Antes la escuela salía del ticket (la del último vínculo) o, sin ella, de
// «la primera fila»: a quien está en dos escuelas le llegaba la otra.
describe('mapi-contexto: solo la escuela activa', () => {
    const OTRA = 'de300000-0000-4000-8000-000000000002';
    const AJENA = 'de300000-0000-4000-8000-000000000099';
    const STAFF_OTRA = '77f3c7b5-e504-4221-a5a0-74ee53dd6077';

    const conDosEscuelas = () => {
        h.tablas.school_members = [
            { profile_id: PERFIL, role: 'coach', school_id: ESCUELA, status: 'active', schools: { name: 'Escuela Demo SportMaps' } },
            { profile_id: PERFIL, role: 'parent', school_id: OTRA, status: 'active', schools: { name: 'Club Vecino' } },
        ];
        h.tablas.school_staff = [{ id: STAFF, coach_auth_id: PERFIL }, { id: STAFF_OTRA, coach_auth_id: PERFIL }];
        h.tablas.teams = [
            { name: 'Lightning', coach_id: STAFF, school_id: ESCUELA },
            { name: 'Equipo del vecino', coach_id: STAFF_OTRA, school_id: OTRA },
        ];
        h.tablas.school_module_overrides = [
            { school_id: ESCUELA, module_key: 'modulo_de_la_activa', enabled: false },
            { school_id: OTRA, module_key: 'modulo_de_la_otra', enabled: false },
        ];
    };

    it('con la escuela activa, nada de la otra: ni rol, ni equipos, ni módulos', async () => {
        conDosEscuelas();
        const ctx = await construirContextoMapi(PERFIL, ESCUELA);
        expect(ctx.escuelaActiva).toBe('Escuela Demo SportMaps');
        expect(ctx.roles).toEqual(['coach']);
        expect(ctx.equiposQueEntrena).toEqual(['Lightning']);
        expect(ctx.modulosApagados).toEqual(['modulo_de_la_activa']);
        expect(ctx.otrasEscuelas).toEqual(['Club Vecino']);
    });

    it('al cambiar de escuela, cambia todo el contexto', async () => {
        conDosEscuelas();
        const ctx = await construirContextoMapi(PERFIL, OTRA);
        expect(ctx.escuelaActiva).toBe('Club Vecino');
        expect(ctx.roles).toEqual(['parent']);
        expect(ctx.equiposQueEntrena).toEqual([]);
        expect(ctx.modulosApagados).toEqual(['modulo_de_la_otra']);
    });

    it('sin escuela en la sesión no adivina ninguna', async () => {
        conDosEscuelas();
        h.filtros.length = 0;
        const ctx = await construirContextoMapi(PERFIL, null);
        expect(ctx.escuelaActiva).toBeNull();
        expect(ctx.equiposQueEntrena).toEqual([]);
        expect(ctx.modulosApagados).toEqual([]);
        expect(h.filtros.some((f) => f.table === 'teams' || f.table === 'school_module_overrides')).toBe(false);
    });

    it('una escuela de la que no es miembro no se acepta', async () => {
        conDosEscuelas();
        const ctx = await construirContextoMapi(PERFIL, AJENA);
        expect(ctx.escuelaActiva).toBeNull();
        expect(ctx.modulosApagados).toEqual([]);
    });
});
