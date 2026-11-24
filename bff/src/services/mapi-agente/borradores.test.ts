/**
 * Borrador → Confirmar (plan §10): dos clics ejecutan una vez, vista previa
 * vieja se reemplaza, permisos perdidos no ejecutan, otra escuela no toca nada.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    responder: (_c: any): any => undefined,
    preparar: vi.fn(),
    ejecutar: vi.fn(),
    segundoPlano: false,
}));

vi.mock('../../config/supabase', async () => {
    const { crearSupabaseFalso } = await import('./supabase-falso.test-helper');
    const falso = crearSupabaseFalso((c) => h.responder(c));
    (globalThis as any).__consultas = falso.consultas;
    return { supabase: falso.supabase, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba' };
});
vi.mock('./registro', () => {
    const accion = {
        tipo: 'accion', nombre: 'excusar_ausencia', roles: ['admin', 'coach'],
        habilitada: (a: any) => a.rol === 'admin' || a.ajustes.coachMapiAttendance,
        validar: (x: any) => x, preparar: h.preparar, ejecutar: h.ejecutar,
        mensajeResultado: () => 'Quedó registrada la excusa.',
        get segundoPlano() { return h.segundoPlano; },
    };
    return { buscarHerramienta: (n: string, a: any) => (n === accion.nombre && accion.roles.includes(a.rol) && accion.habilitada(a) ? accion : null) };
});

import { canonico, hashDe, confirmarBorrador, cancelarBorrador } from './borradores';
import type { Alcance, VistaPrevia } from './tipos';

const ESCUELA = '11111111-1111-1111-1111-111111111111';
const admin: Alcance = {
    schoolId: ESCUELA, userId: 'u1', rol: 'admin', teamIds: [],
    ajustes: { coachMapiAttendance: true, coachMapiNotices: true, coachHideFinancialInfo: false }, hoy: '2026-11-23',
};
const vista: VistaPrevia = { titulo: 'Excusar a Mariana', lineas: ['Del lunes 24…'], botonConfirmar: 'Confirmar' };
const huella = { deportista: 'child:x', nuevos: ['2026-11-24'] };
const borrador = (cambios: Record<string, unknown> = {}) => ({
    id: 'd1', school_id: ESCUELA, user_id: 'u1', ticket_id: 'tk', message_id: 'm1', tool: 'excusar_ausencia', target_key: 'deportista:child:x',
    args: { deportista: 'child:x' }, preview: vista, content_hash: hashDe('excusar_ausencia', huella, vista), status: 'draft',
    replaced_by: null, result: null, failure_reason: null, created_at: '2026-11-23T10:00:00Z', expires_at: '2099-01-01T00:00:00Z', executed_at: null,
    ...cambios,
});

/** Simula la fila en la base: lectura, reclamo atómico y cierres. */
function base(inicial = borrador()) {
    let fila: any = { ...inicial };
    const nuevas: any[] = [];
    h.responder = (c) => {
        if (c.tabla !== 'mapi_action_drafts') return undefined;
        if (c.op === 'select') return { data: fila.user_id === c.filtros.find((f: any) => f[1] === 'user_id')?.[2] ? [fila] : [] };
        if (c.op === 'insert') { const n = { ...borrador(), ...(c.datos as any), id: `d${2 + nuevas.length}`, status: 'draft' }; nuevas.push(n); return { data: [n] }; }
        if (c.op === 'update') {
            const reclamo = c.filtros.some((f: any) => f[0] === 'eq' && f[1] === 'status' && f[2] === 'draft');
            const esEste = c.filtros.some((f: any) => f[0] === 'eq' && f[1] === 'id' && f[2] === fila.id);
            if (!esEste) return { data: [] };
            if (reclamo && fila.status !== 'draft') return { data: [] }; // ya lo reclamó otro clic
            fila = { ...fila, ...(c.datos as any) };
            return { data: [fila] };
        }
        return undefined;
    };
    return { fila: () => fila, nuevas };
}

beforeEach(() => {
    h.preparar.mockReset();
    h.ejecutar.mockReset();
    h.segundoPlano = false;
});

describe('hash', () => {
    it('el orden de las llaves no cambia el hash; el contenido sí', () => {
        expect(canonico({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe(canonico({ a: [2, { c: 0, d: 1 }], b: 1 }));
        expect(hashDe('x', { a: 1 }, vista)).not.toBe(hashDe('x', { a: 2 }, vista));
    });
});

describe('confirmarBorrador', () => {
    it('ejecuta una vez; el segundo clic responde el estado sin ejecutar', async () => {
        const db = base();
        h.preparar.mockResolvedValue({ ok: true, args: {}, vista, targetKey: 'deportista:child:x', huella });
        h.ejecutar.mockResolvedValue({ estado: 'executed', resultado: { dias: 1 } });

        const [uno, dos] = await Promise.all([
            confirmarBorrador({ userId: 'u1', id: 'd1', alcance: admin }),
            confirmarBorrador({ userId: 'u1', id: 'd1', alcance: admin }),
        ]);
        expect(h.ejecutar).toHaveBeenCalledTimes(1);
        expect([uno.tipo, dos.tipo].sort()).toEqual(['final', 'sin_cambio']);
        expect(db.fila().status).toBe('executed');
    });

    it('si cambió la realidad, reemplaza la tarjeta y pide confirmar otra vez', async () => {
        const db = base();
        h.preparar.mockResolvedValue({ ok: true, args: {}, vista: { ...vista, lineas: ['ahora son 2 días'] }, targetKey: 'deportista:child:x', huella: { ...huella, nuevos: ['a', 'b'] } });
        const r = await confirmarBorrador({ userId: 'u1', id: 'd1', alcance: admin });
        expect(r.tipo).toBe('cambio');
        expect(h.ejecutar).not.toHaveBeenCalled();
        expect(db.fila()).toMatchObject({ status: 'superseded', replaced_by: 'd2' });
        expect(db.nuevas[0]).toMatchObject({ ticket_id: 'tk', message_id: 'm1' });
    });

    it('sin permiso actual (coach sin el flag) no ejecuta y queda failed', async () => {
        const db = base();
        const coachSinFlag: Alcance = { ...admin, rol: 'coach', ajustes: { ...admin.ajustes, coachMapiAttendance: false } };
        const r = await confirmarBorrador({ userId: 'u1', id: 'd1', alcance: coachSinFlag });
        expect(r.tipo).toBe('final');
        expect(h.ejecutar).not.toHaveBeenCalled();
        expect(db.fila().status).toBe('failed');
    });

    it('agente apagado (alcance null) no ejecuta', async () => {
        base();
        const r = await confirmarBorrador({ userId: 'u1', id: 'd1', alcance: null });
        expect(r.tipo).toBe('final');
        expect(h.ejecutar).not.toHaveBeenCalled();
    });

    it('desde otra escuela no reclama ni ejecuta', async () => {
        const db = base();
        const r = await confirmarBorrador({ userId: 'u1', id: 'd1', alcance: { ...admin, schoolId: '22222222-2222-2222-2222-222222222222' } });
        expect(r.tipo).toBe('otra_escuela');
        expect(db.fila().status).toBe('draft');
    });

    it('un borrador de otro usuario no existe para mí', async () => {
        base();
        expect(await confirmarBorrador({ userId: 'otro', id: 'd1', alcance: admin })).toEqual({ tipo: 'no_encontrado' });
    });

    it('segundo plano: responde «en curso» ya y el resultado llega por alTerminar', async () => {
        const db = base();
        h.segundoPlano = true;
        h.preparar.mockResolvedValue({ ok: true, args: {}, vista, targetKey: 'deportista:child:x', huella });
        let soltar!: (v: any) => void;
        h.ejecutar.mockReturnValue(new Promise((r) => { soltar = r; }));
        const alTerminar = vi.fn(async () => {});

        const r = await confirmarBorrador({ userId: 'u1', id: 'd1', alcance: admin, alTerminar });
        expect(r).toMatchObject({ tipo: 'en_curso', ticketId: 'tk', tarjeta: { estado: 'executing' } });
        expect(alTerminar).not.toHaveBeenCalled();

        soltar({ estado: 'partial', resultado: { enviadas: 3 } });
        await vi.waitFor(() => expect(alTerminar).toHaveBeenCalledTimes(1));
        expect(alTerminar).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'final', ticketId: 'tk', mensaje: 'Quedó registrada la excusa.' }));
        expect(db.fila().status).toBe('partial');
    });

    it('segundo plano: si ejecutar lanza, queda failed y avisa igual', async () => {
        const db = base();
        h.segundoPlano = true;
        h.preparar.mockResolvedValue({ ok: true, args: {}, vista, targetKey: null, huella });
        h.ejecutar.mockRejectedValue(new Error('se cayó'));
        const alTerminar = vi.fn(async () => {});
        expect((await confirmarBorrador({ userId: 'u1', id: 'd1', alcance: admin, alTerminar })).tipo).toBe('en_curso');
        await vi.waitFor(() => expect(alTerminar).toHaveBeenCalledTimes(1));
        expect(db.fila().status).toBe('failed');
    });

    it('si ejecutar lanza, queda failed y no se reintenta', async () => {
        const db = base();
        h.preparar.mockResolvedValue({ ok: true, args: {}, vista, targetKey: null, huella });
        h.ejecutar.mockRejectedValue(new Error('se cayó'));
        const r = await confirmarBorrador({ userId: 'u1', id: 'd1', alcance: admin });
        expect(r.tipo).toBe('final');
        expect(db.fila().status).toBe('failed');
    });
});

describe('cancelarBorrador', () => {
    it('cancela un pendiente', async () => {
        const db = base();
        expect((await cancelarBorrador('u1', 'd1'))?.estado).toBe('cancelled');
        expect(db.fila().status).toBe('cancelled');
    });
});
