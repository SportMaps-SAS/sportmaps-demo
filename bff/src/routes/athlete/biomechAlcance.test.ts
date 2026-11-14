/**
 * Alcance de grants y capturas biomecánicas del atleta (cierre 2026-10-27).
 *
 * Antes, POST /api/v1/athlete/biomech/grants aceptaba coach_id y school_id tal
 * como venían: el atleta podía abrir sus datos biomecánicos a CUALQUIER perfil,
 * en cualquier escuela. Y POST /biomech/captures colgaba capturas de cualquier
 * escuela y de cualquier session_plan_id (lo que alimenta bc_coach_read de un
 * entrenador ajeno). Estas pruebas fijan la misma regla que las policies.
 */
import { describe, expect, it } from 'vitest';
import { validarCapturaBiomecanica, validarGrantBiomecanico, type ClienteAlcance } from './biomechAlcance';

type Fila = Record<string, unknown>;

function db(tablas: Record<string, Fila[]>): ClienteAlcance {
    return {
        from(tabla: string) {
            let filas = [...(tablas[tabla] ?? [])];
            const q: any = {
                select: () => q,
                eq: (col: string, val: unknown) => { filas = filas.filter(f => f[col] === val); return q; },
                not: (col: string, op: string, val: string) => {
                    expect(op).toBe('in');
                    const excluidos = val.replace(/[()]/g, '').split(',');
                    filas = filas.filter(f => !excluidos.includes(String(f[col])));
                    return q;
                },
                limit: (n: number) => { filas = filas.slice(0, n); return q; },
                maybeSingle: async () => ({ data: filas[0] ?? null, error: null }),
            };
            return q;
        },
    };
}

const ATLETA = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const TERCERO = '33333333-3333-4333-8333-333333333333';
const PADRE = '44444444-4444-4444-8444-444444444444';
const ESCUELA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTRA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESION_SUYA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SESION_AJENA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const base = () => db({
    enrollments: [{ id: 'e1', user_id: ATLETA, school_id: ESCUELA, status: 'active' }],
    school_members: [
        { id: 'm1', profile_id: PADRE, school_id: ESCUELA, status: 'active', role: 'parent' },
    ],
    school_staff: [{ id: 's1', coach_auth_id: COACH, school_id: ESCUELA, status: 'active' }],
    schools: [{ id: ESCUELA, owner_id: '99999999-9999-4999-8999-999999999999' }, { id: OTRA, owner_id: null }],
    trainer_session_plans: [
        { id: SESION_SUYA, school_id: ESCUELA, client_id: ATLETA },
        { id: SESION_AJENA, school_id: ESCUELA, client_id: TERCERO },
    ],
});

describe('validarGrantBiomecanico', () => {
    it('acepta al coach que trabaja en la escuela del atleta', async () => {
        expect(await validarGrantBiomecanico(base(), ATLETA, COACH, ESCUELA)).toBeNull();
    });

    it('rechaza a un perfil que no es staff de la escuela', async () => {
        expect(await validarGrantBiomecanico(base(), ATLETA, TERCERO, ESCUELA)).toMatchObject({ status: 403 });
    });

    it('rechaza a un miembro que NO trabaja ahí (acudiente)', async () => {
        expect(await validarGrantBiomecanico(base(), ATLETA, PADRE, ESCUELA)).toMatchObject({ status: 403 });
    });

    it('rechaza una escuela a la que el atleta no pertenece', async () => {
        expect(await validarGrantBiomecanico(base(), ATLETA, COACH, OTRA)).toMatchObject({ status: 403 });
    });

    it('rechaza ids que no son UUID y el auto-grant', async () => {
        expect(await validarGrantBiomecanico(base(), ATLETA, 'x', ESCUELA)).toMatchObject({ status: 400 });
        expect(await validarGrantBiomecanico(base(), ATLETA, ATLETA, ESCUELA)).toMatchObject({ status: 400 });
    });

    it('acepta al dueño de la escuela como destinatario', async () => {
        const dueño = '99999999-9999-4999-8999-999999999999';
        expect(await validarGrantBiomecanico(base(), ATLETA, dueño, ESCUELA)).toBeNull();
    });
});

describe('validarCapturaBiomecanica', () => {
    it('acepta captura en su escuela sin sesión', async () => {
        expect(await validarCapturaBiomecanica(base(), ATLETA, ESCUELA, null)).toBeNull();
    });

    it('acepta captura colgada de una sesión suya de esa escuela', async () => {
        expect(await validarCapturaBiomecanica(base(), ATLETA, ESCUELA, SESION_SUYA)).toBeNull();
    });

    it('rechaza una sesión de otro atleta', async () => {
        expect(await validarCapturaBiomecanica(base(), ATLETA, ESCUELA, SESION_AJENA)).toMatchObject({ status: 403 });
    });

    it('rechaza una escuela ajena', async () => {
        expect(await validarCapturaBiomecanica(base(), ATLETA, OTRA, null)).toMatchObject({ status: 403 });
    });
});
