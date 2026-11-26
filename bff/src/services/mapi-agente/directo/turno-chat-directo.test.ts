/**
 * Chat de la app (turno-chat): la consulta frecuente se responde sin modelo y
 * queda en el hilo; lo demás va a turnoAgente. Tope mensual por escuela:
 * llegado el tope, el texto libre recibe un mensaje fijo y las consultas siguen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    responder: (_c: any): any => undefined,
    turno: vi.fn(),
    estado: vi.fn(),
}));

vi.mock('../../../config/supabase', async () => {
    const { crearSupabaseFalso } = await import('../supabase-falso.test-helper');
    const falso = crearSupabaseFalso((c) => h.responder(c));
    (globalThis as any).__consultas = falso.consultas;
    return { supabase: falso.supabase, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave', supabaseAnonKey: 'anon', SUPABASE_URL: 'http://supabase.local', SUPABASE_ANON_KEY: 'anon' };
});
vi.mock('../agente', () => ({ turnoAgente: (...a: any[]) => h.turno(...a) }));
vi.mock('../../inapp-support-bot.service', () => ({ postBotMessageAndEscalate: vi.fn(), setStatus: (...a: any[]) => h.estado(...a) }));

import { runTurnoAgenteEnChat } from '../turno-chat';
import { TEXTO_TOPE, inicioDelMesColombia } from './tope';
import type { Alcance } from '../tipos';
import type { Consulta } from '../supabase-falso.test-helper';

const A = '11111111-1111-1111-1111-111111111111';
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const SAMUEL = 'cccccccc-0000-0000-0000-000000000001';
const TICKET = 'dddddddd-0000-0000-0000-000000000001';

let mensajeUsuario = '';
let usoDelMes = 0;
const consultas = (): Consulta[] => (globalThis as any).__consultas;
const insertados = () => consultas().filter((c) => c.tabla === 'support_messages' && c.op === 'insert').map((c) => (c.datos as any).body as string);
const conteosDeUso = () => consultas().filter((c) => c.tabla === 'llm_usage');

function alcance(): Alcance {
    const a: Alcance = {
        schoolId: A, userId: 'duena', rol: 'admin', teamIds: [],
        ajustes: { coachMapiAttendance: true, coachMapiNotices: true, coachHideFinancialInfo: false },
        hoy: '2026-11-26', canal: 'app',
    };
    Object.defineProperty(a, 'authorization', { value: null, enumerable: false });
    return a;
}

beforeEach(() => {
    consultas().length = 0;
    h.turno.mockReset();
    h.estado.mockReset();
    h.turno.mockResolvedValue({ tipo: 'texto', texto: 'Respuesta del modelo', borradores: [], herramientas: [], rondas: 1 });
    usoDelMes = 0;
    h.responder = (c: Consulta) => {
        if (c.tabla === 'support_messages' && c.op === 'select') {
            if (c.filtros.some(([t, k, v]) => t === 'eq' && k === 'author_type' && v === 'agent')) return { count: 0 };
            return { data: [{ author_type: 'user', body: mensajeUsuario }, { author_type: 'bot', body: 'Hola, ¿en qué te ayudo?' }] };
        }
        if (c.tabla === 'support_messages' && c.op === 'insert') return { data: [{ id: 'msg-1' }] };
        if (c.tabla === 'support_tickets') return { data: [{ status: 'bot_handled' }] };
        if (c.tabla === 'llm_usage') return { count: usoDelMes };
        if (c.tabla === 'school_athletes') {
            return { data: [{ id: SAMUEL, full_name: 'Samuel Ortiz', athlete_type: 'child', team_id: T1, enrolled_team_id: T1, team_name: 'Sub 12', is_active: true, parent_id: 'p', user_id: null, plan_name: null, enrollment_status: 'active' }] };
        }
        return { data: [] };
    };
});
afterEach(() => {
    delete process.env.MAPI_SIN_MODELO;
    delete process.env.MAPI_TOPE_TURNOS_MES;
});

describe('chat de la app: capa 2 antes del modelo', () => {
    it('una consulta frecuente se responde sin llamar a turnoAgente ni al modelo, y queda en el hilo', async () => {
        mensajeUsuario = 'cuánto debe Samuel?';
        const crear = vi.fn();
        expect(await runTurnoAgenteEnChat({ ticketId: TICKET, alcance: alcance(), crearMensaje: crear })).toBe(true);
        expect(h.turno).not.toHaveBeenCalled();
        expect(crear).not.toHaveBeenCalled();
        expect(insertados()).toHaveLength(1);
        expect(insertados()[0]).toContain('**Samuel Ortiz**');
        expect(h.estado).toHaveBeenCalledWith(TICKET, 'bot_handled');
        // La consulta directa no cuenta el uso del mes (eso es solo para ir al modelo).
        expect(conteosDeUso()).toHaveLength(0);
    });
    it('lo que no reconoce va al modelo con el historial completo', async () => {
        mensajeUsuario = 'excusa a Samuel el viernes';
        await runTurnoAgenteEnChat({ ticketId: TICKET, alcance: alcance() });
        expect(h.turno).toHaveBeenCalledTimes(1);
        const p = h.turno.mock.calls[0][0];
        expect(p.historial.at(-1)).toEqual({ role: 'user', content: 'excusa a Samuel el viernes' });
        expect(insertados()).toEqual(['Respuesta del modelo']);
    });
    it('MAPI_SIN_MODELO=false: vuelve a como estaba (todo al modelo, sin tope)', async () => {
        process.env.MAPI_SIN_MODELO = 'false';
        process.env.MAPI_TOPE_TURNOS_MES = '1';
        usoDelMes = 99;
        mensajeUsuario = 'cuánto debe Samuel?';
        await runTurnoAgenteEnChat({ ticketId: TICKET, alcance: alcance() });
        expect(h.turno).toHaveBeenCalledTimes(1);
        expect(conteosDeUso()).toHaveLength(0);
    });
});

describe('tope mensual de turnos con modelo', () => {
    it('al llegar al tope el texto libre recibe el mensaje fijo y NO llama al modelo', async () => {
        process.env.MAPI_TOPE_TURNOS_MES = '3';
        usoDelMes = 3;
        mensajeUsuario = 'ayúdame a redactar un mensaje para los papás';
        expect(await runTurnoAgenteEnChat({ ticketId: TICKET, alcance: alcance() })).toBe(true);
        expect(h.turno).not.toHaveBeenCalled();
        expect(insertados()).toEqual([TEXTO_TOPE]);
        // Una sola consulta liviana: count por escuela, feature y mes de Colombia.
        const [c] = conteosDeUso();
        expect(conteosDeUso()).toHaveLength(1);
        expect(c.filtros).toContainEqual(['eq', 'school_id', A]);
        expect(c.filtros).toContainEqual(['in', 'feature', ['mapi_agente']]);
        expect(c.filtros).toContainEqual(['gte', 'created_at', '2026-11-01T05:00:00.000Z']);
    });
    it('con el tope alcanzado, las consultas directas siguen', async () => {
        process.env.MAPI_TOPE_TURNOS_MES = '3';
        usoDelMes = 50;
        mensajeUsuario = 'cuánto debe Samuel?';
        await runTurnoAgenteEnChat({ ticketId: TICKET, alcance: alcance() });
        expect(h.turno).not.toHaveBeenCalled();
        expect(insertados()[0]).toContain('Samuel Ortiz');
    });
    it('por debajo del tope va al modelo; 0 = sin tope (ni siquiera cuenta)', async () => {
        process.env.MAPI_TOPE_TURNOS_MES = '3';
        usoDelMes = 2;
        mensajeUsuario = 'ayúdame con algo';
        await runTurnoAgenteEnChat({ ticketId: TICKET, alcance: alcance() });
        expect(h.turno).toHaveBeenCalledTimes(1);

        consultas().length = 0;
        process.env.MAPI_TOPE_TURNOS_MES = '0';
        usoDelMes = 10_000;
        await runTurnoAgenteEnChat({ ticketId: TICKET, alcance: alcance() });
        expect(h.turno).toHaveBeenCalledTimes(2);
        expect(conteosDeUso()).toHaveLength(0);
    });
    it('por defecto el tope es 500', async () => {
        usoDelMes = 500;
        mensajeUsuario = 'ayúdame con algo';
        await runTurnoAgenteEnChat({ ticketId: TICKET, alcance: alcance() });
        expect(h.turno).not.toHaveBeenCalled();
    });
    it('si no se puede contar, no se bloquea', async () => {
        const antes = h.responder;
        h.responder = (c: Consulta) => (c.tabla === 'llm_usage' ? { error: { message: 'caído' } } : antes(c));
        const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mensajeUsuario = 'ayúdame con algo';
        await runTurnoAgenteEnChat({ ticketId: TICKET, alcance: alcance() });
        expect(h.turno).toHaveBeenCalledTimes(1);
        aviso.mockRestore();
    });
    it('el mes empieza a medianoche de Colombia (05:00 UTC)', () => {
        expect(inicioDelMesColombia('2026-12-01')).toBe('2026-12-01T05:00:00.000Z');
    });
});
