/**
 * referidos.job — sin N+1: una consulta de campañas, UNA RPC por escuela con campaña, una lectura de
 * avisos previos y UN insert en lote. Cero red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    campanas: [] as Array<{ school_id: string }>,
    campanasError: null as any,
    rpc: {} as Record<string, (args: any) => any>,
    llamadasRpc: [] as Array<{ nombre: string; args: any }>,
    lecturasNotificaciones: 0,
    lecturasCampanas: 0,
    previos: [] as any[],
    inserts: [] as any[][],
}));

vi.mock('../config/supabase', () => ({
    supabase: {
        from: (tabla: string) => {
            const q: any = {};
            for (const m of ['select', 'eq', 'in', 'gte']) q[m] = () => q;
            q.insert = async (filas: any[]) => { db.inserts.push(filas); return { error: null }; };
            q.then = (ok: any, ko: any) => {
                if (tabla === 'school_discount_campaigns') {
                    db.lecturasCampanas++;
                    return Promise.resolve({ data: db.campanas, error: db.campanasError }).then(ok, ko);
                }
                db.lecturasNotificaciones++;
                return Promise.resolve({ data: db.previos, error: null }).then(ok, ko);
            };
            return q;
        },
        rpc: async (nombre: string, args: any) => {
            db.llamadasRpc.push({ nombre, args });
            try {
                const r = db.rpc[nombre]?.(args);
                return { data: r ?? null, error: null };
            } catch (e: any) {
                return { data: null, error: { code: 'XX000', message: e.message } };
            }
        },
    },
}));

const { runReferidosJob } = await import('./referidos.job');

const silencio = { info: () => { }, warn: () => { }, error: () => { } };
const ganado = (id: string, user: string | null) => ({
    referral_id: id, pct: 50, apply_year: 2026, apply_month: 12, referrer_user_id: user, referred_name: 'Sofía',
});

beforeEach(() => {
    db.campanas = [];
    db.campanasError = null;
    db.llamadasRpc = [];
    db.lecturasNotificaciones = 0;
    db.lecturasCampanas = 0;
    db.previos = [];
    db.inserts = [];
    db.rpc = {};
});

describe('runReferidosJob', () => {
    it('sin campañas activas: una consulta y nada más', async () => {
        const r = await runReferidosJob(silencio);
        expect(r).toMatchObject({ escuelas: 0, ganados: 0, avisados: 0 });
        expect(db.lecturasCampanas).toBe(1);
        expect(db.llamadasRpc).toHaveLength(0);
        expect(db.lecturasNotificaciones).toBe(0);
    });

    it('migración sin aplicar (42P01) → no hace nada y no falla', async () => {
        db.campanasError = { code: '42P01', message: 'relation does not exist' };
        const r = await runReferidosJob(silencio);
        expect(r.escuelas).toBe(0);
    });

    it('una RPC por escuela y UN insert en lote para todos los avisos (sin N+1)', async () => {
        db.campanas = [{ school_id: 'A' }, { school_id: 'B' }];
        db.rpc.qualify_enrollment_referrals = (a: any) => ({
            ok: true, campana_activa: true,
            ganados: a.p_school_id === 'A' ? 3 : 1, anulados: 0, vencidos: 0,
            detalle: a.p_school_id === 'A'
                ? [ganado('r1', 'u1'), ganado('r2', 'u2'), ganado('r3', null)]
                : [ganado('r4', 'u4')],
        });
        const r = await runReferidosJob(silencio);
        expect(db.llamadasRpc.map((c) => c.args.p_school_id)).toEqual(['A', 'B']);
        expect(db.llamadasRpc.every((c) => c.nombre === 'qualify_enrollment_referrals')).toBe(true);
        expect(db.lecturasCampanas).toBe(1);
        expect(db.lecturasNotificaciones).toBe(1);   // una lectura de claves, no una por aviso
        expect(db.inserts).toHaveLength(1);          // un insert, no uno por aviso
        expect(db.inserts[0]).toHaveLength(3);       // r3 no tiene cuenta a quien avisar
        expect(db.inserts[0][0]).toMatchObject({
            user_id: 'u1', school_id: 'A', type: 'referral_won',
            message: '¡Ganaste 50 % en tu mensualidad de diciembre por referir a Sofía!',
            data: { clave: 'referido-ganado:r1' },
        });
        expect(r).toMatchObject({ escuelas: 2, ganados: 4, avisados: 3, errores: 0 });
    });

    it('no repite avisos ya enviados (clave estable)', async () => {
        db.campanas = [{ school_id: 'A' }];
        db.previos = [{ data: { clave: 'referido-ganado:r1' } }];
        db.rpc.qualify_enrollment_referrals = () => ({
            ok: true, campana_activa: true, ganados: 2, anulados: 0, vencidos: 0,
            detalle: [ganado('r1', 'u1'), ganado('r2', 'u2')],
        });
        const r = await runReferidosJob(silencio);
        expect(db.inserts[0]).toHaveLength(1);
        expect(db.inserts[0][0].data.clave).toBe('referido-ganado:r2');
        expect(r.avisados).toBe(1);
    });

    it('si una escuela falla, las demás siguen', async () => {
        db.campanas = [{ school_id: 'A' }, { school_id: 'B' }];
        db.rpc.qualify_enrollment_referrals = (a: any) => {
            if (a.p_school_id === 'A') throw new Error('boom');
            return { ok: true, campana_activa: true, ganados: 0, anulados: 1, vencidos: 0, detalle: [] };
        };
        const r = await runReferidosJob(silencio);
        expect(db.llamadasRpc).toHaveLength(2);
        expect(r.errores).toBe(1);
        expect(r.anulados).toBe(1);
    });
});
