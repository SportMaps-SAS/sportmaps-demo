import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../config/supabase', () => ({ supabase: { rpc: (...a: any[]) => rpc(...a) } }));

import { requireEntitlement, resolveGatingMode } from './requireEntitlement';

function run(schoolId: string | undefined = 'school-1') {
    const headers: Record<string, string> = {};
    const req: any = { schoolId, originalUrl: '/x', log: { warn: vi.fn(), error: vi.fn() } };
    const res: any = {
        statusCode: 200, body: null,
        status(c: number) { this.statusCode = c; return this; },
        json(b: any) { this.body = b; return this; },
        setHeader(k: string, v: string) { headers[k] = v; },
    };
    const next = vi.fn();
    return { req, res, next, headers, go: () => requireEntitlement('reservas')(req, res, next) };
}

beforeEach(() => { rpc.mockReset(); delete process.env.GATING_MODE; });

describe('resolveGatingMode', () => {
    it('default audit, reconoce soft/enforce', () => {
        expect(resolveGatingMode(undefined)).toBe('audit');
        expect(resolveGatingMode('basura')).toBe('audit');
        expect(resolveGatingMode('SOFT')).toBe('soft');
        expect(resolveGatingMode('enforce')).toBe('enforce');
    });
});

describe('requireEntitlement', () => {
    it('llama has_entitlement con school y key', async () => {
        rpc.mockResolvedValue({ data: true, error: null });
        const t = run(); await t.go();
        expect(rpc).toHaveBeenCalledWith('has_entitlement', { p_school_id: 'school-1', p_key: 'reservas' });
        expect(t.next).toHaveBeenCalled();
    });
    it('audit: sin entitlement deja pasar y loguea', async () => {
        rpc.mockResolvedValue({ data: false, error: null });
        const t = run(); await t.go();
        expect(t.next).toHaveBeenCalled();
        expect(t.req.log.warn).toHaveBeenCalled();
    });
    it('soft: deja pasar con header', async () => {
        process.env.GATING_MODE = 'soft';
        rpc.mockResolvedValue({ data: false, error: null });
        const t = run(); await t.go();
        expect(t.next).toHaveBeenCalled();
        expect(t.headers['X-Entitlement-Missing']).toBe('reservas');
    });
    it('enforce: 403 sin entitlement, 503 si la RPC falla, 400 sin escuela', async () => {
        process.env.GATING_MODE = 'enforce';
        rpc.mockResolvedValue({ data: false, error: null });
        const a = run(); await a.go();
        expect(a.res.statusCode).toBe(403);
        expect(a.next).not.toHaveBeenCalled();
        rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
        const b = run(); await b.go();
        expect(b.res.statusCode).toBe(503);
        const c = run(''); await c.go();
        expect(c.res.statusCode).toBe(400);
    });
});
