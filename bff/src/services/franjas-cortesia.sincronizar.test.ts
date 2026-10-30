/**
 * `sincronizarFranjasDeEscuela` contra una base simulada: lo que lee y lo que
 * escribe con y sin la migración M1 (Monster, 2026-10-30).
 *   · Sin M1: mismas lecturas de siempre (reintenta sin las columnas nuevas),
 *     cierra sin `cerrada_por` y no reabre nada.
 *   · Con M1: excepciones de la semana, `cupos_por_sesion`, `dias_semana`,
 *     cierre con `cerrada_por = 'horario'`, reabrir y ajustar cupos.
 *   · `soloEquipo`: lee y toca solo las franjas de ese equipo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Op = [string, any[]];
const h = vi.hoisted(() => ({
    resolver: (_tabla: string, _ops: [string, any[]][]): { data: any; error: any } => ({ data: null, error: null }),
    llamadas: [] as { tabla: string; ops: [string, any[]][] }[],
}));
vi.mock('../config/supabase', () => {
    const builder = (tabla: string): any => {
        const ops: Op[] = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'limit', 'order', 'update', 'insert']) {
            b[m] = (...args: any[]) => { ops.push([m, args]); return b; };
        }
        const fin = () => { h.llamadas.push({ tabla, ops }); return Promise.resolve(h.resolver(tabla, ops)); };
        b.maybeSingle = fin;
        b.then = (ok: any, ko: any) => fin().then(ok, ko);
        return b;
    };
    return { supabase: { from: (t: string) => builder(t) } };
});

import { sincronizarFranjasDeEscuela, CUPOS_SIN_LIMITE } from './franjas-cortesia.service';
import { limpiarCacheSemana } from './semana-equipo.service';

const HOY = '2026-10-06'; // martes
const SENIORS = { id: 't-seniors', name: 'SENIORS', active: true, admite_nuevos: true,
    schedule: [{ day: 4, time: '20:00', end: '22:00', place: 'Coliseo Dynasty DC' }, { day: 6, time: '10:00', end: '12:00' }] };
const MINI = { id: 't-mini', name: 'MINIVOLLEY', active: true, schedule: [{ day: 6, time: '08:00', end: '10:00' }] };

const sel = (ops: Op[]) => String(ops.find(([m]) => m === 'select')?.[1][0] ?? '');
const tiene = (ops: Op[], m: string, ...args: any[]) => ops.some(([x, a]) => x === m && JSON.stringify(a) === JSON.stringify(args));
const escrituras = (tabla: string, m: 'insert' | 'update') =>
    h.llamadas.filter((l) => l.tabla === tabla && l.ops.some(([x]) => x === m));

function base(o: {
    m1: boolean;
    equipos?: any[];
    existentes?: any[];
    ajustes?: any;
    excepciones?: any[];
}) {
    h.llamadas = [];
    h.resolver = (tabla, ops) => {
        const cols = sel(ops);
        const esEscritura = ops.some(([m]) => m === 'update' || m === 'insert');
        if (tabla === 'schools') return { data: { name: 'Escuela', owner_id: 'owner-1' }, error: null };
        if (tabla === 'teams') {
            if (!o.m1 && cols.includes('recibe_clase_prueba')) return { data: null, error: { code: '42703', message: 'column teams.recibe_clase_prueba does not exist' } };
            return { data: o.equipos ?? [SENIORS, MINI], error: null };
        }
        if (tabla === 'school_trial_class_settings') {
            if (!o.m1) return { data: null, error: { code: '42703', message: 'column school_trial_class_settings.cupos_por_sesion does not exist' } };
            return { data: o.ajustes ?? null, error: null };
        }
        if (tabla === 'team_schedule_exceptions') {
            if (!o.m1) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.team_schedule_exceptions'" } };
            return { data: o.excepciones ?? [], error: null };
        }
        if (tabla === 'school_trial_slots') {
            if (esEscritura) {
                const ids = ops.find(([m]) => m === 'in')?.[1][1] ?? [];
                return { data: ids.map((id: string) => ({ id })), error: null };
            }
            if (!o.m1 && cols.includes('cerrada_por')) return { data: null, error: { code: '42703', message: 'column school_trial_slots.cerrada_por does not exist' } };
            return { data: o.existentes ?? [], error: null };
        }
        return { data: null, error: null };
    };
}

const slot = (o: any) => ({
    id: 'x', team_id: 't-seniors', label: 'SENIORS', slot_date: '2026-10-08', start_time: '20:00:00',
    reserved_count: 0, is_open: true, generated_from_schedule: true, max_capacity: CUPOS_SIN_LIMITE, cerrada_por: null, ...o,
});

beforeEach(() => limpiarCacheSemana());

describe('sin la migración M1: lo de siempre', () => {
    it('reintenta sin las columnas nuevas, crea sin límite, cierra sin cerrada_por y no reabre', async () => {
        base({ m1: false, existentes: [
            slot({ id: 'obsoleta', slot_date: '2026-10-09', start_time: '19:00:00' }),
            slot({ id: 'cerrada', slot_date: '2026-10-08', is_open: false }),
        ] });
        const r = await sincronizarFranjasDeEscuela('s1', { aplicar: true, hoy: HOY, semanas: 1 });
        expect(r.errores).toEqual([]);
        const selectsSlots = h.llamadas.filter((l) => l.tabla === 'school_trial_slots' && !l.ops.some(([m]) => m === 'update' || m === 'insert')).map((l) => sel(l.ops));
        expect(selectsSlots).toEqual([
            'id, team_id, label, slot_date, start_time, reserved_count, is_open, generated_from_schedule, max_capacity, cerrada_por',
            'id, team_id, label, slot_date, start_time, reserved_count, is_open, generated_from_schedule, max_capacity',
        ]);
        const [insert] = escrituras('school_trial_slots', 'insert');
        const filas = insert.ops.find(([m]) => m === 'insert')![1][0];
        expect(filas.every((f: any) => f.max_capacity === CUPOS_SIN_LIMITE)).toBe(true);
        // jue 08 ya existe (cerrada a mano: no se reabre ni se duplica) → sáb 10 ×2.
        expect(filas.map((f: any) => `${f.team_id} ${f.slot_date} ${f.start_time}`)).toEqual([
            't-mini 2026-10-10 08:00', 't-seniors 2026-10-10 10:00',
        ]);
        const updates = escrituras('school_trial_slots', 'update');
        expect(updates).toHaveLength(1);
        expect(updates[0].ops.find(([m]) => m === 'update')![1][0]).toEqual({ is_open: false });
        expect(r).toMatchObject({ creadas: 2, cerradas: 1, reabiertas: 0, cuposAjustados: 0 });
    });
});

describe('con la migración M1', () => {
    it('día cancelado: no se crea, la abierta sin reservas se cierra con cerrada_por = horario; cupos y días', async () => {
        base({
            m1: true,
            ajustes: { cupos_por_sesion: 12, dias_semana: [4, 6] },
            excepciones: [{ team_id: 't-seniors', fecha: '2026-10-08', tipo: 'cancelada', hora_original: null }],
            existentes: [
                slot({ id: 'jueves', slot_date: '2026-10-08' }),
                slot({ id: 'vuelve', slot_date: '2026-10-10', start_time: '10:00:00', is_open: false, cerrada_por: 'horario' }),
                slot({ id: 'mini', team_id: 't-mini', slot_date: '2026-10-10', start_time: '08:00:00', reserved_count: 3 }),
            ],
        });
        const r = await sincronizarFranjasDeEscuela('s1', { aplicar: true, hoy: HOY, semanas: 1 });
        expect(r.errores).toEqual([]);
        expect(escrituras('school_trial_slots', 'insert')).toHaveLength(0);
        const updates = escrituras('school_trial_slots', 'update');
        const cerrar = updates.find((u) => tiene(u.ops, 'eq', 'reserved_count', 0))!;
        expect(cerrar.ops.find(([m]) => m === 'update')![1][0]).toEqual({ is_open: false, cerrada_por: 'horario' });
        expect(cerrar.ops.find(([m]) => m === 'in')![1][1]).toEqual(['jueves']);
        const reabrir = updates.find((u) => tiene(u.ops, 'eq', 'cerrada_por', 'horario'))!;
        expect(reabrir.ops.find(([m]) => m === 'update')![1][0]).toEqual({ is_open: true, cerrada_por: null });
        expect(reabrir.ops.find(([m]) => m === 'in')![1][1]).toEqual(['vuelve']);
        const cupos = updates.find((u) => tiene(u.ops, 'lte', 'reserved_count', 12))!;
        expect(cupos.ops.find(([m]) => m === 'update')![1][0]).toEqual({ max_capacity: 12 });
        expect(cupos.ops.find(([m]) => m === 'in')![1][1]).toEqual(['vuelve', 'mini']);
        expect(r).toMatchObject({ creadas: 0, cerradas: 1, reabiertas: 1, cuposAjustados: 2 });
        // La semana se lee sin caché (el profe acaba de cambiarla).
        const sem = h.llamadas.find((l) => l.tabla === 'team_schedule_exceptions')!;
        expect(tiene(sem.ops, 'gte', 'fecha', HOY)).toBe(true);
    });

    it('las nuevas nacen con cupos_por_sesion', async () => {
        base({ m1: true, ajustes: { cupos_por_sesion: 8, dias_semana: null } });
        await sincronizarFranjasDeEscuela('s1', { aplicar: true, hoy: HOY, semanas: 1 });
        const filas = escrituras('school_trial_slots', 'insert')[0].ops.find(([m]) => m === 'insert')![1][0];
        expect(filas.length).toBe(3);
        expect(filas.every((f: any) => f.max_capacity === 8)).toBe(true);
    });

    it('soloEquipo: lee y escribe solo ese equipo', async () => {
        base({ m1: true, equipos: [MINI] });
        const r = await sincronizarFranjasDeEscuela('s1', { aplicar: true, hoy: HOY, semanas: 1, soloEquipo: 't-mini' });
        const equipos = h.llamadas.find((l) => l.tabla === 'teams')!;
        expect(tiene(equipos.ops, 'eq', 'id', 't-mini')).toBe(true);
        const lectura = h.llamadas.find((l) => l.tabla === 'school_trial_slots' && !l.ops.some(([m]) => m === 'insert'))!;
        expect(tiene(lectura.ops, 'eq', 'team_id', 't-mini')).toBe(true);
        expect(r.creadas).toBe(1);
    });

    it('simulación: cuenta lo que haría sin escribir', async () => {
        base({
            m1: true, ajustes: { cupos_por_sesion: 12 },
            existentes: [slot({ id: 'vuelve', slot_date: '2026-10-08', is_open: false, cerrada_por: 'horario' })],
        });
        const r = await sincronizarFranjasDeEscuela('s1', { hoy: HOY, semanas: 1 });
        expect(escrituras('school_trial_slots', 'update')).toHaveLength(0);
        expect(escrituras('school_trial_slots', 'insert')).toHaveLength(0);
        expect(r).toMatchObject({ aplicado: false, reabiertas: 1, cuposAjustados: 1 });
    });
});
