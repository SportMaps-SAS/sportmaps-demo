/**
 * Días de evento sin descuento de horas y devolución de una visita: lo que el
 * BFF valida antes de llamar a la base y cómo ata al id de la escuela los ids
 * que llegan del cliente. La regla en sí (visita de un día de evento = 0) la
 * hace cumplir el trigger de la migración 20261123083815.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fila = Record<string, unknown>;
const h = vi.hoisted(() => ({
    tablas: {} as Record<string, Fila[]>,
    rpc: vi.fn(),
}));

vi.mock('../config/supabase', () => {
    const consulta = (tabla: string) => {
        const filtros: ((f: Fila) => boolean)[] = [];
        const filas = () => (h.tablas[tabla] ?? []).filter((f) => filtros.every((fn) => fn(f)));
        const b: any = {
            select: () => b,
            eq: (c: string, v: unknown) => { filtros.push((f) => f[c] === v); return b; },
            is: (c: string, v: unknown) => { filtros.push((f) => (f[c] ?? null) === v); return b; },
            gte: (c: string, v: string) => { filtros.push((f) => String(f[c]) >= v); return b; },
            order: () => b,
            limit: () => b,
            maybeSingle: () => Promise.resolve({ data: filas()[0] ?? null, error: null }),
            then: (ok: any, ko: any) => Promise.resolve({ data: filas(), error: null }).then(ok, ko),
        };
        return b;
    };
    return { supabase: { from: (t: string) => consulta(t), rpc: (...a: unknown[]) => h.rpc(...a) } };
});

import {
    HourBankExemptError, cancelarDiaDeEvento, crearDiaDeEvento, devolverHorasDeVisita, errorDeRpc,
    listarDiasDeEvento, validarDiaDeEvento,
} from './hour-bank-exempt-days.service';
import { todayInZone } from '../utils/businessDate';

const ESCUELA = 'e0000000-0000-4000-8000-000000000001';
const OTRA = 'e0000000-0000-4000-8000-000000000002';
const ACTOR = 'a0000000-0000-4000-8000-000000000001';
const HOY = '2026-11-23';

const estado = async (fn: () => unknown) => {
    try { await fn(); } catch (e) { return e instanceof HourBankExemptError ? e.status : -1; }
    return 0;
};

beforeEach(() => {
    h.tablas = {};
    h.rpc.mockReset();
});

describe('validarDiaDeEvento', () => {
    it('acepta el día completo: hoy, un día pasado reciente y uno futuro', () => {
        expect(validarDiaDeEvento({ date: HOY, reason: ' Competencia interna ' }, HOY))
            .toEqual({ date: HOY, reason: 'Competencia interna', time_from: null, time_to: null });
        expect(validarDiaDeEvento({ date: '2026-10-31', reason: 'Halloween' }, HOY).date).toBe('2026-10-31');
        expect(validarDiaDeEvento({ date: '2026-12-12', reason: 'Competencia' }, HOY).date).toBe('2026-12-12');
    });

    it('acepta una franja completa y rechaza la incompleta o invertida', async () => {
        expect(validarDiaDeEvento({ date: HOY, reason: 'Evento', time_from: '14:00', time_to: '18:00' }, HOY))
            .toMatchObject({ time_from: '14:00', time_to: '18:00' });
        expect(await estado(() => validarDiaDeEvento({ date: HOY, reason: 'Evento', time_from: '14:00' }, HOY))).toBe(400);
        expect(await estado(() => validarDiaDeEvento({ date: HOY, reason: 'Evento', time_from: '18:00', time_to: '14:00' }, HOY))).toBe(400);
        expect(await estado(() => validarDiaDeEvento({ date: HOY, reason: 'Evento', time_from: '25:00', time_to: '26:00' }, HOY))).toBe(400);
    });

    it('rechaza sin motivo, sin fecha, fecha imposible o fuera de la ventana', async () => {
        expect(await estado(() => validarDiaDeEvento({ date: HOY, reason: 'ab' }, HOY))).toBe(400);
        expect(await estado(() => validarDiaDeEvento({ reason: 'Evento' }, HOY))).toBe(400);
        expect(await estado(() => validarDiaDeEvento({ date: '2026-13-45', reason: 'Evento' }, HOY))).toBe(400);
        expect(await estado(() => validarDiaDeEvento({ date: '2026-09-01', reason: 'Evento' }, HOY))).toBe(400);
        expect(await estado(() => validarDiaDeEvento({ date: '2028-01-01', reason: 'Evento' }, HOY))).toBe(400);
        expect(await estado(() => validarDiaDeEvento({ date: HOY, reason: 'x'.repeat(121) }, HOY))).toBe(400);
    });
});

describe('errorDeRpc', () => {
    it('traduce los códigos de la RPC a estados HTTP con el mensaje para la persona', () => {
        expect(errorDeRpc({ code: '42501', message: 'FORBIDDEN: el usuario no administra esta escuela' }).status).toBe(403);
        const sin = errorDeRpc({ code: 'P0001', message: 'SIN_DESCUENTO: esta visita no descontó horas' });
        expect(sin.status).toBe(400);
        expect(sin.message).toBe('esta visita no descontó horas');
        expect(errorDeRpc({ code: 'P0001', message: 'NO_ENCONTRADA: la visita no existe' }).status).toBe(404);
    });

    it('si la migración no está aplicada responde 503, no un 500 mudo', () => {
        expect(errorDeRpc({ code: 'PGRST202', message: 'Could not find the function' }).status).toBe(503);
        expect(errorDeRpc({ code: 'PGRST205', message: 'Could not find the table' }).status).toBe(503);
    });
});

describe('crearDiaDeEvento', () => {
    it('llama a la RPC con la escuela y el actor de la sesión y devuelve lo que se ajustó', async () => {
        h.rpc.mockResolvedValue({
            data: { created: true, duplicated: false, id: 'dia-1', visits_waived: 2, minutes_returned: 120, athletes: ['Ana', 'Zoe'], overage_confirmed: 0 },
            error: null,
        });
        const hoy = todayInZone();
        const r = await crearDiaDeEvento(ESCUELA, ACTOR, { date: hoy, reason: 'Halloween' });
        expect(h.rpc).toHaveBeenCalledWith('create_hour_bank_exempt_day', {
            p_school_id: ESCUELA, p_actor: ACTOR, p_date: hoy, p_reason: 'Halloween', p_time_from: null, p_time_to: null,
        });
        expect(r).toEqual({ id: 'dia-1', duplicated: false, visits_waived: 2, minutes_returned: 120, athletes: ['Ana', 'Zoe'], overage_confirmed: 0 });
    });

    it('con datos inválidos no llega a la base', async () => {
        expect(await estado(() => crearDiaDeEvento(ESCUELA, ACTOR, { date: todayInZone(), reason: '' }))).toBe(400);
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('propaga el rechazo de la base como error legible', async () => {
        h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'FORBIDDEN: el usuario no administra esta escuela' } });
        expect(await estado(() => crearDiaDeEvento(ESCUELA, ACTOR, { date: todayInZone(), reason: 'Evento' }))).toBe(403);
    });
});

describe('listarDiasDeEvento', () => {
    it('solo los vigentes de ESTA escuela, con la hora recortada a HH:MM', async () => {
        const hoy = todayInZone();
        h.tablas.hour_bank_exempt_days = [
            { id: 'a', school_id: ESCUELA, exempt_date: hoy, time_from: '14:00:00', time_to: '18:00:00', reason: 'Evento', cancelled_at: null },
            { id: 'b', school_id: ESCUELA, exempt_date: hoy, time_from: null, time_to: null, reason: 'Quitado', cancelled_at: '2026-11-01T00:00:00Z' },
            { id: 'c', school_id: OTRA, exempt_date: hoy, time_from: null, time_to: null, reason: 'Ajeno', cancelled_at: null },
            { id: 'd', school_id: ESCUELA, exempt_date: '2025-01-01', time_from: null, time_to: null, reason: 'Viejo', cancelled_at: null },
        ];
        const dias = await listarDiasDeEvento(ESCUELA);
        expect(dias.map((d) => d.id)).toEqual(['a']);
        expect(dias[0]).toMatchObject({ time_from: '14:00', time_to: '18:00' });
    });
});

describe('cancelarDiaDeEvento', () => {
    it('no deja quitar el evento de otra escuela', async () => {
        h.tablas.hour_bank_exempt_days = [{ id: 'dia-ajeno', school_id: OTRA }];
        expect(await estado(() => cancelarDiaDeEvento(ESCUELA, ACTOR, 'dia-ajeno'))).toBe(404);
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('quita el de la propia escuela', async () => {
        h.tablas.hour_bank_exempt_days = [{ id: 'dia-1', school_id: ESCUELA }];
        h.rpc.mockResolvedValue({ data: { cancelled: true }, error: null });
        await cancelarDiaDeEvento(ESCUELA, ACTOR, 'dia-1');
        expect(h.rpc).toHaveBeenCalledWith('cancel_hour_bank_exempt_day', { p_day_id: 'dia-1', p_actor: ACTOR });
    });
});

describe('devolverHorasDeVisita', () => {
    it('no toca la visita de otra escuela ni acepta un motivo vacío', async () => {
        h.tablas.hour_bank_visits = [{ id: 'v-ajena', school_id: OTRA }];
        expect(await estado(() => devolverHorasDeVisita(ESCUELA, ACTOR, 'v-ajena', 'Halloween'))).toBe(404);
        expect(await estado(() => devolverHorasDeVisita(ESCUELA, ACTOR, 'v-ajena', '  '))).toBe(400);
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('devuelve las horas y avisa si ya había un cobro de horas de más confirmado', async () => {
        h.tablas.hour_bank_visits = [{ id: 'v1', school_id: ESCUELA }];
        h.rpc.mockResolvedValue({ data: { waived: true, duplicated: false, minutes: 60, available_minutes: 180, overage_confirmed: true }, error: null });
        const r = await devolverHorasDeVisita(ESCUELA, ACTOR, 'v1', ' Halloween ');
        expect(h.rpc).toHaveBeenCalledWith('waive_hour_bank_visit', { p_visit_id: 'v1', p_actor: ACTOR, p_reason: 'Halloween' });
        expect(r).toEqual({ duplicated: false, minutes: 60, available_minutes: 180, overage_confirmed: true });
    });

    it('una visita que no descontó nada llega como 400 con el texto de la base', async () => {
        h.tablas.hour_bank_visits = [{ id: 'v1', school_id: ESCUELA }];
        h.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'SIN_DESCUENTO: esta visita no descontó horas' } });
        expect(await estado(() => devolverHorasDeVisita(ESCUELA, ACTOR, 'v1', 'Halloween'))).toBe(400);
    });
});
