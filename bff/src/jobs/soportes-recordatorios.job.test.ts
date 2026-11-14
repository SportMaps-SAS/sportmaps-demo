/**
 * soportes-recordatorios.job — un lote por escuela, tope de frecuencia en la base, un aviso por cuenta y sin
 * lenguaje de cobro. Cero red: supabase simulado.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    escuelas: { data: [] as any[], error: null as any },
    estado: {} as Record<string, any[]>,
    reclamo: { data: null as any, error: null as any },   // null => reclama todo lo pedido
    rpcCalls: [] as any[],
    inserts: [] as any[],
    insertError: null as any,
}));

vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('../config/supabase', () => ({
    SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a',
    supabase: {
        from: (tabla: string) => ({
            select: () => ({ eq: () => Promise.resolve(h.escuelas) }),
            insert: (v: any) => { h.inserts.push({ tabla, v }); return Promise.resolve({ error: h.insertError }); },
        }),
        rpc: (fn: string, args: any) => {
            h.rpcCalls.push({ fn, args });
            if (fn === 'soportes_estado_interno') return Promise.resolve({ data: h.estado[args.p_school_id] ?? [], error: null });
            if (fn === 'soportes_reclamar_avisos') {
                if (h.reclamo.data === null && !h.reclamo.error) return Promise.resolve({ data: args.p_sujetos, error: null });
                return Promise.resolve(h.reclamo);
            }
            return Promise.resolve({ data: null, error: null });
        },
    },
}));

const J = await import('./soportes-recordatorios.job');

const ESC = '11111111-1111-4111-8111-111111111111';
const ESC2 = '55555555-5555-4555-8555-555555555555';
const P1 = '33333333-3333-4333-8333-333333333333';
const P2 = '77777777-7777-4777-8777-777777777777';
const A = '22222222-2222-4222-8222-222222222222';
const B = '44444444-4444-4444-8444-444444444444';
const C = '66666666-6666-4666-8666-666666666666';

const fila = (o: Partial<any>) => ({
    subject_type: 'child', subject_id: A, full_name: 'Ana', notify_profile_id: P1, has_account: true,
    required_total: 7, present_total: 5, missing: ['athlete_photo'], complete: false, ...o,
});

beforeEach(() => {
    h.escuelas = { data: [], error: null };
    h.estado = {};
    h.reclamo = { data: null, error: null };
    h.rpcCalls = [];
    h.inserts = [];
    h.insertError = null;
});

describe('runSoportesRecordatorios', () => {
    it('sin escuelas con el flag prendido no hace nada (todas menos Monster)', async () => {
        const r = await J.runSoportesRecordatorios();
        expect(r).toMatchObject({ escuelas: 0, avisos: 0, errores: 0 });
        expect(h.rpcCalls).toHaveLength(0);
        expect(h.inserts).toHaveLength(0);
    });

    it('columna aún no migrada (42703) → no es un fallo', async () => {
        h.escuelas = { data: null as any, error: { code: '42703', message: 'no existe' } };
        expect(await J.runSoportesRecordatorios()).toMatchObject({ escuelas: 0, errores: 0 });
    });

    it('UNA lectura y UN reclamo por escuela (sin N+1) y un solo INSERT con todos los avisos', async () => {
        h.escuelas = { data: [{ school_id: ESC }], error: null };
        h.estado[ESC] = [
            fila({}),
            fila({ subject_id: B, full_name: 'Bruno', notify_profile_id: P1 }),                       // mismo acudiente
            fila({ subject_id: C, full_name: 'Carla', notify_profile_id: P2 }),
            fila({ subject_id: '88888888-8888-4888-8888-888888888888', notify_profile_id: null, has_account: false }),
            fila({ subject_id: '99999999-9999-4999-8999-999999999999', complete: true, missing: [] }),
        ];
        const r = await J.runSoportesRecordatorios();
        expect(h.rpcCalls.filter((c) => c.fn === 'soportes_estado_interno')).toHaveLength(1);
        const reclamos = h.rpcCalls.filter((c) => c.fn === 'soportes_reclamar_avisos');
        expect(reclamos).toHaveLength(1);
        // Solo se reclaman los que tienen a quién avisar (el sin cuenta no gasta cupo).
        expect(reclamos[0].args.p_sujetos).toHaveLength(3);
        expect(reclamos[0].args).toMatchObject({ p_school_id: ESC, p_cada_dias: 4, p_maximo: 6 });
        expect(h.inserts).toHaveLength(1);
        expect(h.inserts[0].v).toHaveLength(2);       // 2 cuentas, 3 deportistas
        expect(r).toMatchObject({ escuelas: 1, deportistasIncompletos: 4, sinCuenta: 1, reclamados: 3, avisos: 2 });
    });

    it('el aviso va por notifications con service role, a la cuenta, sin lenguaje de cobro', async () => {
        h.escuelas = { data: [{ school_id: ESC }], error: null };
        h.estado[ESC] = [fila({})];
        await J.runSoportesRecordatorios();
        const n = h.inserts[0].v[0];
        expect(n).toMatchObject({ user_id: P1, school_id: ESC, type: 'soportes_pendientes', category: 'enrollment', link: '/children' });
        expect(`${n.title} ${n.message}`).not.toMatch(/cobr|mora|pago|deuda|vencid|saldo/i);
        expect(n.link.startsWith('/')).toBe(true);
    });

    it('TOPE: si la base no reclama a nadie (ya se avisó hace menos de 4 días o llegó a 6), no se manda nada', async () => {
        h.escuelas = { data: [{ school_id: ESC }], error: null };
        h.estado[ESC] = [fila({})];
        h.reclamo = { data: [], error: null };
        const r = await J.runSoportesRecordatorios();
        expect(h.inserts).toHaveLength(0);
        expect(r).toMatchObject({ reclamados: 0, avisos: 0, deportistasIncompletos: 1 });
    });

    it('TOPE parcial: solo recibe aviso el que la base reclamó', async () => {
        h.escuelas = { data: [{ school_id: ESC }], error: null };
        h.estado[ESC] = [fila({}), fila({ subject_id: C, full_name: 'Carla', notify_profile_id: P2 })];
        h.reclamo = { data: [{ subject_type: 'child', subject_id: C, sent_count: 2 }], error: null };
        await J.runSoportesRecordatorios();
        expect(h.inserts[0].v).toHaveLength(1);
        expect(h.inserts[0].v[0].user_id).toBe(P2);
    });

    it('dryRun cuenta pero no reclama ni inserta', async () => {
        h.escuelas = { data: [{ school_id: ESC }], error: null };
        h.estado[ESC] = [fila({})];
        const r = await J.runSoportesRecordatorios({ dryRun: true });
        expect(r).toMatchObject({ avisos: 1 });
        expect(h.rpcCalls.filter((c) => c.fn === 'soportes_reclamar_avisos')).toHaveLength(0);
        expect(h.inserts).toHaveLength(0);
    });

    it('una escuela que falla no frena a las demás', async () => {
        h.escuelas = { data: [{ school_id: ESC }, { school_id: ESC2 }], error: null };
        h.estado[ESC] = [fila({})];
        h.estado[ESC2] = [fila({ subject_id: C, notify_profile_id: P2 })];
        h.insertError = { message: 'boom' };
        const r = await J.runSoportesRecordatorios();
        expect(r.errores).toBe(2);
        expect(r.escuelas).toBe(2);
    });

    it('una cuenta de adulto va a /dashboard', async () => {
        h.escuelas = { data: [{ school_id: ESC }], error: null };
        h.estado[ESC] = [fila({ subject_type: 'profile', subject_id: P1 })];
        await J.runSoportesRecordatorios();
        expect(h.inserts[0].v[0].link).toBe('/dashboard');
    });
});

describe('expresionCron', () => {
    it('por defecto 10:00 y respeta SOPORTES_CRON_HORA válida', () => {
        expect(J.expresionCron({} as any)).toBe('0 10 * * *');
        expect(J.expresionCron({ SOPORTES_CRON_HORA: '7' } as any)).toBe('0 7 * * *');
        expect(J.expresionCron({ SOPORTES_CRON_HORA: '99' } as any)).toBe('0 10 * * *');
    });
});
