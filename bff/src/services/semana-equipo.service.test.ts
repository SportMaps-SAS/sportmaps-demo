/**
 * Semana real de un equipo: horario base + ajustes de «Mi semana»
 * (team_schedule_exceptions, migración M1). Los horarios imitan a Monster
 * (sábado 11–13 en un parque, domingo 9:30–11:30) y a Dynasty (subgrupos).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    respuesta: { data: [] as any, error: null as any },
    llamadas: 0,
    filtros: [] as [string, any[]][],
}));
vi.mock('../config/supabase', () => {
    const builder = (): any => {
        const b: any = {};
        for (const m of ['select', 'eq', 'gte', 'lte', 'limit']) {
            b[m] = (...args: any[]) => { h.filtros.push([m, args]); return b; };
        }
        b.then = (ok: any, ko: any) => { h.llamadas++; return Promise.resolve(h.respuesta).then(ok, ko); };
        return b;
    };
    return { supabase: { from: () => builder() } };
});

import {
    sesionesDelDia, ajusteDeSesion, excepcionesDeEscuela, limpiarCacheSemana, normalizarHora, diaDeLaSemana,
    TTL_EXCEPCIONES_MS, type ExcepcionSemana,
} from './semana-equipo.service';

// Sábado 31 de octubre y domingo 1 de noviembre de 2026.
const SAB = '2026-10-31';
const DOM = '2026-11-01';

const MONSTER = [
    { day: 6, time: '11:00', end: '13:00', place: 'Parque Pinar de Suba 2' },
    { day: 0, time: '9:30', end: '11:30', place: 'Liceo Fesan' },
];
const DYNASTY_SUBGRUPOS = [
    { day: 6, time: '07:00', end: '09:00', group: 'Origen', place: 'Coliseo Dynasty DC' },
    { day: 6, time: '09:00', end: '11:00', group: 'Evolución', place: 'Asoalsacia' },
];

const exc = (o: Partial<ExcepcionSemana>): ExcepcionSemana => ({ team_id: 't1', fecha: SAB, tipo: 'cancelada', ...o });

describe('sesionesDelDia', () => {
    it('sin ajustes: el horario base de ese día, tal cual y en su orden', () => {
        expect(sesionesDelDia(MONSTER, [], SAB)).toEqual([
            { inicio: '11:00', fin: '13:00', lugar: 'Parque Pinar de Suba 2', grupo: null, origen: 'horario', horaOriginal: null },
        ]);
        expect(sesionesDelDia(MONSTER, null, DOM)[0]).toMatchObject({ inicio: '09:30', fin: '11:30', lugar: 'Liceo Fesan' });
        expect(sesionesDelDia(DYNASTY_SUBGRUPOS, [], SAB).map((s) => s.grupo)).toEqual(['Origen', 'Evolución']);
        expect(sesionesDelDia(JSON.stringify(MONSTER), [], SAB)).toHaveLength(1);
        expect(sesionesDelDia(MONSTER, [], '2026-11-02')).toEqual([]); // lunes
    });

    it('cancelada todo el día: no queda ninguna sesión del horario', () => {
        expect(sesionesDelDia(DYNASTY_SUBGRUPOS, [exc({ hora_original: null })], SAB)).toEqual([]);
    });

    it('cancelada por hora: solo esa sesión (la hora de la base viene como HH:MM:SS)', () => {
        const r = sesionesDelDia(DYNASTY_SUBGRUPOS, [exc({ hora_original: '07:00:00' })], SAB);
        expect(r.map((s) => s.grupo)).toEqual(['Evolución']);
    });

    it('un ajuste de OTRA fecha no toca el día', () => {
        expect(sesionesDelDia(MONSTER, [exc({ fecha: DOM, hora_original: null })], SAB)).toHaveLength(1);
    });

    it('movida: pasa a la hora nueva, conserva la duración y el lugar si no vienen', () => {
        const [s] = sesionesDelDia(MONSTER, [exc({ tipo: 'movida', hora_original: '11:00:00', hora_inicio: '13:00:00' })], SAB);
        expect(s).toEqual({
            inicio: '13:00', fin: '15:00', lugar: 'Parque Pinar de Suba 2', grupo: null, origen: 'movida', horaOriginal: '11:00',
        });
        const [c] = sesionesDelDia(MONSTER, [exc({
            tipo: 'movida', hora_original: '11:00', hora_inicio: '11:00', hora_fin: '12:30', lugar: 'Colegio Lestonnac',
        })], SAB);
        expect(c).toMatchObject({ inicio: '11:00', fin: '12:30', lugar: 'Colegio Lestonnac', origen: 'movida' });
    });

    it('movida de una hora que no está en el horario base: se ignora (no se inventa un entreno)', () => {
        expect(sesionesDelDia(MONSTER, [exc({ tipo: 'movida', hora_original: '16:00', hora_inicio: '17:00' })], SAB))
            .toEqual(sesionesDelDia(MONSTER, [], SAB));
    });

    it('extra: se suma al final, por hora, sin subgrupo; a la hora de una sesión no la duplica, la confirma', () => {
        const r = sesionesDelDia(MONSTER, [
            exc({ tipo: 'extra', hora_inicio: '15:00', hora_fin: '17:00', lugar: 'Liceo Fesan' }),
            exc({ tipo: 'extra', hora_inicio: '11:00:00' }),
            exc({ tipo: 'extra', hora_inicio: '14:00' }),
        ], SAB);
        expect(r.map((s) => [s.inicio, s.origen])).toEqual([['11:00', 'extra'], ['14:00', 'extra'], ['15:00', 'extra']]);
        expect(r[0]).toMatchObject({ fin: '13:00', lugar: 'Parque Pinar de Suba 2' });
        expect(r[2]).toMatchObject({ fin: '17:00', lugar: 'Liceo Fesan', grupo: null });
    });

    it('día cancelado entero + extra: el extra queda (lo agregaron a propósito)', () => {
        const r = sesionesDelDia(MONSTER, [exc({ hora_original: null }), exc({ tipo: 'extra', hora_inicio: '15:00' })], SAB);
        expect(r.map((s) => s.inicio)).toEqual(['15:00']);
    });

    it('un equipo sin horario base con un extra tiene esa sesión', () => {
        expect(sesionesDelDia(null, [exc({ tipo: 'extra', hora_inicio: '08:00' })], SAB)).toHaveLength(1);
    });
});

describe('ajusteDeSesion (red de seguridad sobre una franja ya creada)', () => {
    it('cancelada, movida a otra hora, movida de lugar, extra en día cancelado y nada', () => {
        expect(ajusteDeSesion([exc({ hora_original: null })], SAB, '11:00:00')).toEqual({ tipo: 'cancelada' });
        expect(ajusteDeSesion([exc({ hora_original: '11:00' })], SAB, '11:00')).toEqual({ tipo: 'cancelada' });
        expect(ajusteDeSesion([exc({ hora_original: '11:00' })], SAB, '13:00')).toBeNull();
        expect(ajusteDeSesion([exc({ tipo: 'movida', hora_original: '11:00', hora_inicio: '13:00' })], SAB, '11:00:00'))
            .toEqual({ tipo: 'movida', inicio: '13:00', fin: null, lugar: null });
        expect(ajusteDeSesion([exc({ hora_original: null }), exc({ tipo: 'extra', hora_inicio: '15:00' })], SAB, '15:00'))
            .toBeNull();
        expect(ajusteDeSesion([], SAB, '11:00')).toBeNull();
        expect(ajusteDeSesion([exc({ hora_original: null })], DOM, '09:30')).toBeNull();
    });
});

describe('utilidades', () => {
    it('normalizarHora y diaDeLaSemana (0 = domingo, como teams.schedule)', () => {
        expect(normalizarHora('9:30')).toBe('09:30');
        expect(normalizarHora('13:00:00')).toBe('13:00');
        expect(normalizarHora('24:00')).toBeNull();
        expect(diaDeLaSemana(SAB)).toBe(6);
        expect(diaDeLaSemana(DOM)).toBe(0);
    });
});

describe('excepcionesDeEscuela (lectura cacheada, nunca lanza)', () => {
    beforeEach(() => {
        limpiarCacheSemana();
        h.llamadas = 0;
        h.filtros = [];
        h.respuesta = { data: [], error: null };
    });

    it('lee por escuela y rango y normaliza las filas; descarta tipos desconocidos', async () => {
        h.respuesta = { data: [
            { team_id: 't1', fecha: '2026-10-31', tipo: 'cancelada', hora_original: null, hora_inicio: null, hora_fin: null, lugar: null },
            { team_id: 't1', fecha: '2026-10-31', tipo: 'otra' },
        ], error: null };
        const r = await excepcionesDeEscuela('s1', SAB, DOM);
        expect(r).toEqual([{ team_id: 't1', fecha: SAB, tipo: 'cancelada', hora_original: null, hora_inicio: null, hora_fin: null, lugar: null }]);
        expect(h.filtros).toEqual(expect.arrayContaining([['eq', ['school_id', 's1']], ['gte', ['fecha', SAB]], ['lte', ['fecha', DOM]]]));
    });

    it('cacheada 10 min; `sinCache` (el generador) vuelve a leer', async () => {
        await excepcionesDeEscuela('s1', SAB, DOM, { ahora: 0 });
        await excepcionesDeEscuela('s1', SAB, DOM, { ahora: TTL_EXCEPCIONES_MS - 1 });
        expect(h.llamadas).toBe(1);
        await excepcionesDeEscuela('s1', SAB, DOM, { ahora: 1, sinCache: true });
        expect(h.llamadas).toBe(2);
        await excepcionesDeEscuela('s1', SAB, DOM, { ahora: TTL_EXCEPCIONES_MS + 5 });
        expect(h.llamadas).toBe(3);
    });

    it('sin la migración (tabla inexistente): [] y no se reintenta en cada turno', async () => {
        h.respuesta = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.team_schedule_exceptions'" } };
        expect(await excepcionesDeEscuela('s2', SAB, DOM, { ahora: 0 })).toEqual([]);
        expect(await excepcionesDeEscuela('s2', SAB, DOM, { ahora: 10 })).toEqual([]);
        expect(h.llamadas).toBe(1);
    });

    it('otro error: [] sin guardar en caché', async () => {
        h.respuesta = { data: null, error: { code: '57014', message: 'timeout' } };
        expect(await excepcionesDeEscuela('s3', SAB, DOM)).toEqual([]);
        expect(await excepcionesDeEscuela('s3', SAB, DOM)).toEqual([]);
        expect(h.llamadas).toBe(2);
    });
});
