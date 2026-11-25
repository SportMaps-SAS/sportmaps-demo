/**
 * Propuestas pendientes del chat (evals de punta a punta 2026-11-25): el modelo
 * las ve en el contexto con referencias cortas y puede descartarlas; nunca
 * ejecuta ni toca una que no sea de esta persona y este chat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ cancelar: vi.fn() }));

vi.mock('../../config/supabase', () => ({ supabase: {}, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba' }));
vi.mock('./borradores', async (orig) => ({ ...(await orig<any>()), cancelarBorrador: h.cancelar }));

import { bloquePendientes, descartarPendientes, type PendienteDelTurno } from './agente';

const pendientes: PendienteDelTurno[] = [
    { ref: 'p1', id: 'b-1', titulo: 'Dar de baja a Samuel Ortiz', linea: 'Queda inactivo y se anulan 2 cobros' },
    { ref: 'p2', id: 'b-2', titulo: 'Excusar a Mariana López', linea: null },
];

beforeEach(() => h.cancelar.mockReset());

describe('bloquePendientes', () => {
    it('lista las propuestas con su referencia, sin ids', () => {
        const b = bloquePendientes(pendientes);
        expect(b).toContain('p1: Dar de baja a Samuel Ortiz — Queda inactivo');
        expect(b).toContain('p2: Excusar a Mariana López');
        expect(b).not.toContain('b-1');
    });
    it('sin pendientes no agrega nada', () => {
        expect(bloquePendientes([])).toBe('');
    });
});

describe('descartarPendientes', () => {
    it('cancela solo las referencias pedidas, con el usuario del turno', async () => {
        h.cancelar.mockResolvedValue({ estado: 'cancelled' });
        const r = await descartarPendientes('u1', pendientes, { propuestas: ['P1'] });
        expect(h.cancelar).toHaveBeenCalledTimes(1);
        expect(h.cancelar).toHaveBeenCalledWith('u1', 'b-1');
        expect(r).toContain('Dar de baja a Samuel Ortiz');
    });
    it('una referencia que no está en la lista del turno no toca nada (ni un id pegado)', async () => {
        expect(await descartarPendientes('u1', pendientes, { propuestas: ['p9', 'b-2'] })).toMatch(/No hay propuestas/);
        expect(h.cancelar).not.toHaveBeenCalled();
    });
    it('si ya se confirmó (cancelar no la cambia), lo dice', async () => {
        h.cancelar.mockResolvedValue({ estado: 'executed' });
        expect(await descartarPendientes('u1', pendientes, { propuestas: ['p2'] })).toMatch(/No se pudo descartar/);
    });
});
