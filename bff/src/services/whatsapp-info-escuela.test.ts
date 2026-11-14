/**
 * Horarios de `get_school_info`: cargado > inferido de asistencias > nada.
 *
 * Lo que se vigila es que NO SE INVENTE: un patrón solo sale si se repite en
 * 3 de las últimas 4 semanas y explica ≥75 % de las fechas. Los casos usan
 * formas reales medidas el 2026-10-04 (Carmel sábado+domingo, Besser con
 * sesiones en todos los días, Dynasty con franjas por subgrupo y lugar).
 *
 * Cero red y cero base: Supabase está moqueado.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const estado = vi.hoisted(() => ({
    /** Respuesta por tabla para supabase.from(tabla)…await */
    tablas: {} as Record<string, { data: any; error: any }>,
    /** Filtros aplicados por tabla: [método, args]. */
    filtros: {} as Record<string, Array<[string, any[]]>>,
}));

vi.mock('../config/supabase', () => {
    const builder = (tabla: string): any => {
        const b: any = new Proxy({}, {
            get(_t, prop: string) {
                if (prop === 'then') {
                    const r = estado.tablas[tabla] ?? { data: null, error: null };
                    return (ok: any, ko: any) => Promise.resolve(r).then(ok, ko);
                }
                return (...args: any[]) => {
                    (estado.filtros[tabla] ??= []).push([prop, args]);
                    return b;
                };
            },
        });
        return b;
    };
    return { supabase: { from: (t: string) => builder(t) } };
});

import {
    describirEntrenamiento,
    fallbackInfoEscuela,
    inferirHorarioDeSesiones,
    infoDeEscuela,
    resolverSede,
    type SesionPasada,
} from './whatsapp-info-escuela.service';

const HOY = '2026-10-04'; // domingo

const ses = (fechas: string[], start: string | null = null, end: string | null = null): SesionPasada[] =>
    fechas.map((session_date) => ({ session_date, start_time: start, end_time: end }));

describe('inferirHorarioDeSesiones', () => {
    it('Carmel: sábado y domingo en 4 de 4 semanas → patrón, sin hora', () => {
        const s = ses(['2026-09-12', '2026-09-13', '2026-09-19', '2026-09-20',
            '2026-09-26', '2026-09-27', '2026-10-03']);
        expect(inferirHorarioDeSesiones(s, HOY))
            .toBe('según las últimas sesiones registradas: sábado · domingo (la hora no está registrada)');
    });

    it('3 de 4 semanas alcanza (un festivo no tumba el patrón)', () => {
        // Lunes 09-14, 09-21, 09-28; falta el 10-05 (fuera) y el 09-07 (fuera de ventana).
        const s = ses(['2026-09-14', '2026-09-21', '2026-09-28']);
        expect(inferirHorarioDeSesiones(s, HOY)).toContain('lunes');
    });

    it('2 de 4 semanas NO alcanza', () => {
        expect(inferirHorarioDeSesiones(ses(['2026-09-21', '2026-09-28']), HOY)).toBeNull();
    });

    it('Besser: días repetidos pero el patrón cubre <75 % de las fechas → null', () => {
        // Jueves en 3 bloques + sesiones en otros 4 días distintos: 3/7 = 43 %.
        const s = ses(['2026-09-10', '2026-09-17', '2026-10-01',
            '2026-09-09', '2026-09-18', '2026-09-26', '2026-10-02']);
        expect(inferirHorarioDeSesiones(s, HOY)).toBeNull();
    });

    it('agrega la hora solo si la misma hora se repite en ≥3 semanas', () => {
        const s = ses(['2026-09-15', '2026-09-22', '2026-09-29'], '16:00:00', '18:00:00');
        expect(inferirHorarioDeSesiones(s, HOY))
            .toBe('según las últimas sesiones registradas: martes 16:00 a 18:00');
    });

    it('hora distinta cada semana → día sin hora', () => {
        const s = [
            ...ses(['2026-09-15'], '16:00:00'),
            ...ses(['2026-09-22'], '17:00:00'),
            ...ses(['2026-09-29'], '18:00:00'),
        ];
        expect(inferirHorarioDeSesiones(s, HOY))
            .toBe('según las últimas sesiones registradas: martes (la hora no está registrada)');
    });

    it('ignora sesiones futuras y fuera de la ventana de 28 días', () => {
        const s = ses(['2026-10-10', '2026-10-17', '2026-10-24', '2026-08-01', '2026-08-08', '2026-08-15']);
        expect(inferirHorarioDeSesiones(s, HOY)).toBeNull();
    });

    it('la misma clase registrada dos veces cuenta una', () => {
        const s = ses(['2026-09-26', '2026-09-26', '2026-09-26', '2026-10-03']);
        expect(inferirHorarioDeSesiones(s, HOY)).toBeNull();
    });
});

describe('resolverSede', () => {
    it('lugares del horario cargado ganan a la sede del equipo (Dynasty rota)', () => {
        expect(resolverSede({
            schedule: [{ day: 6, time: '07:00', place: 'Coliseo' }, { day: 0, time: '08:00', place: 'Cancha externa' }],
            branch: { name: 'Coliseo Dynasty', address: 'Cl 1' },
        })).toBe('Coliseo / Cancha externa');
    });

    it('instalación > location > sede con dirección', () => {
        expect(resolverSede({ facility: { name: 'Piscina' }, location: 'X', branch: { name: 'B' } })).toBe('Piscina');
        expect(resolverSede({ location: ' Cancha 2 ', branch: { name: 'B' } })).toBe('Cancha 2');
        expect(resolverSede({ location: '', branch: { name: 'Coliseo', address: 'Cl 12' } })).toBe('Coliseo (Cl 12)');
        expect(resolverSede({ schedule: null, location: null })).toBeNull();
    });
});

describe('describirEntrenamiento (formato real de teams.schedule)', () => {
    it('agrupa subgrupos y dice el lugar', () => {
        const txt = describirEntrenamiento([
            { day: 1, time: '16:00', end: '18:00', group: 'Origen', place: 'Coliseo' },
            { day: 2, time: '16:00', end: '18:00', group: 'Evolución', place: 'Nido' },
        ]);
        expect(txt).toBe('Origen: lunes 16:00 a 18:00 (Coliseo) || Evolución: martes 16:00 a 18:00 (Nido)');
    });
});

describe('infoDeEscuela', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T15:00:00Z'));
        estado.filtros = {};
        estado.tablas = {
            schools: { data: { name: 'Escuela X', city: 'Bogotá', address: 'Cl 1' }, error: null },
            school_branches: { data: [{ name: 'Coliseo' }], error: null },
            school_categories: { data: [], error: null },
            whatsapp_settings: { data: null, error: null },
            teams: {
                data: [
                    { id: 't1', name: 'INTERMEDIO', active: true, location: '',
                        schedule: [{ day: 1, time: '16:00', end: '18:00', place: 'Coliseo' }],
                        branch: { name: 'Coliseo', address: 'Cl 1' } },
                    { id: 't2', name: 'CATEGORIA 2013', active: true, schedule: null,
                        branch: { name: 'Sede Norte', address: null } },
                    { id: 't3', name: 'JUVENIL', active: true, schedule: null, branch: null },
                    { id: 't4', name: 'MINI (DUPLICADO - NO USAR)', active: true, schedule: null },
                    { id: 't5', name: 'VIEJO', active: false, schedule: null },
                ],
                error: null,
            },
            attendance_sessions: {
                data: [
                    // t1 tiene horario cargado: estas sesiones NO lo pisan.
                    ...ses(['2026-09-15', '2026-09-22', '2026-09-29']).map((s) => ({ ...s, team_id: 't1' })),
                    ...ses(['2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03']).map((s) => ({ ...s, team_id: 't2' })),
                    ...ses(['2026-10-01']).map((s) => ({ ...s, team_id: 't3' })),
                ],
                error: null,
            },
        };
    });
    afterEach(() => vi.useRealTimers());

    it('cargado > inferido > null, con sede y fuente; oculta «NO USAR» e inactivos', async () => {
        const info = await infoDeEscuela('sch');
        expect(info.grupos.map((g) => g.nombre)).toEqual(['INTERMEDIO', 'CATEGORIA 2013', 'JUVENIL']);

        const [a, b, c] = info.grupos;
        expect(a).toMatchObject({ horario: 'lunes 16:00 a 18:00 (Coliseo)', horario_fuente: 'cargado', sede: 'Coliseo' });
        expect(b).toMatchObject({
            horario: 'según las últimas sesiones registradas: sábado (la hora no está registrada)',
            horario_fuente: 'inferido',
            sede: 'Sede Norte',
        });
        expect(c).toMatchObject({ horario: null, horario_fuente: null, sede: null });

        // Solo el que no tiene nada se declara faltante.
        expect(info.no_disponible).toContain('horario de estos grupos: JUVENIL');
    });

    it('la consulta de sesiones va acotada a la escuela y a la ventana ≤ hoy', async () => {
        await infoDeEscuela('sch');
        const f = estado.filtros.attendance_sessions;
        expect(f).toContainEqual(['eq', ['school_id', 'sch']]);
        expect(f).toContainEqual(['gte', ['session_date', '2026-09-07']]);
        expect(f).toContainEqual(['lte', ['session_date', '2026-10-04']]);
    });

    it('si falla la consulta de sesiones, sigue con lo cargado', async () => {
        estado.tablas.attendance_sessions = { data: null, error: { message: 'boom' } };
        const info = await infoDeEscuela('sch');
        expect(info.grupos[0].horario_fuente).toBe('cargado');
        expect(info.grupos[1].horario_fuente).toBeNull();
    });

    it('el fallback sin modelo incluye los horarios', async () => {
        const txt = fallbackInfoEscuela(await infoDeEscuela('sch'));
        expect(txt).toContain('lunes 16:00 a 18:00 (Coliseo)');
        expect(txt).toContain('según las últimas sesiones registradas: sábado');
        expect(txt).not.toContain('NO USAR');
    });
});

// ─── «¿Hay clase hoy?» con la semana del profe (migración M1, 2026-10-30) ───

import { horariosDelDia, textoHorarioDeHoy, franjasDelDia } from './whatsapp-info-escuela.service';
import type { ExcepcionSemana } from './semana-equipo.service';

describe('horariosDelDia con los ajustes de «Mi semana»', () => {
    const SAB = '2026-10-31';
    const EQUIPOS = [
        { id: 'u9', name: 'U9 Y U11 MIXTO', active: true, schedule: [{ day: 6, time: '11:00', end: '13:00', place: 'Parque Pinar de Suba 2' }] },
        { id: 'may', name: 'MIXTO MAYORES', active: true, schedule: [{ day: 6, time: '13:00', end: '15:00', place: 'Liceo Fesan' }] },
        { id: 'nor', name: 'NORTE', active: true, schedule: [{ day: 6, time: '8:00', end: '10:00' }, { day: 0, time: '8:00', end: '10:00' }] },
    ];
    const conAjustes = (filas: ExcepcionSemana[]) => ({ excepciones: async () => filas });

    beforeEach(() => {
        estado.filtros = {};
        estado.tablas = { teams: { data: EQUIPOS, error: null } };
    });

    it('sin ajustes: exactamente lo de siempre (franjasDelDia)', async () => {
        const h = await horariosDelDia('s1', SAB, conAjustes([]));
        expect(h).toEqual({
            dia: 'sábado', conHorario: 3,
            grupos: EQUIPOS.map((t) => ({ nombre: t.name, franjas: franjasDelDia(t.schedule, 6)! })),
        });
        expect(textoHorarioDeHoy(h!, false)).toBe('Según el horario de la escuela, hoy *sábado* entrenan:\n\n'
            + '• *U9 Y U11 MIXTO*: 11:00 a 13:00 (Parque Pinar de Suba 2)\n• *MIXTO MAYORES*: 13:00 a 15:00 (Liceo Fesan)\n'
            + '• *NORTE*: 8:00 a 10:00\n\nSi hay un cambio de última hora, la escuela lo avisa por aquí.');
    });

    it('un día cancelado no aparece en «hoy entrenan» y se dice que se canceló', async () => {
        const h = await horariosDelDia('s1', SAB, conAjustes([
            { team_id: 'u9', fecha: SAB, tipo: 'cancelada', hora_original: null },
        ]));
        expect(h!.grupos.map((g) => g.nombre)).toEqual(['MIXTO MAYORES', 'NORTE']);
        expect(h!.cancelados).toEqual(['U9 Y U11 MIXTO']);
        const t = textoHorarioDeHoy(h!, false)!;
        expect(t).not.toContain('• *U9 Y U11 MIXTO*');
        expect(t).toContain('Hoy se canceló el entreno de *U9 Y U11 MIXTO*.');
    });

    it('todos cancelados: «no hay entrenamientos» y por qué', async () => {
        const h = await horariosDelDia('s1', SAB, conAjustes(EQUIPOS.map((e) => ({ team_id: e.id, fecha: SAB, tipo: 'cancelada' as const }))));
        expect(textoHorarioDeHoy(h!, true)).toBe('Según el horario de la escuela, hoy *sábado* no hay entrenamientos: '
            + 'se canceló el de *U9 Y U11 MIXTO*, *MIXTO MAYORES* y *NORTE*.\n\n'
            + 'Si hay un cambio de última hora, la escuela lo avisa por aquí. Ya le pasé tu mensaje para que te lo confirme.');
    });

    it('movida y extra salen con su hora nueva y marcados', async () => {
        const h = await horariosDelDia('s1', SAB, conAjustes([
            { team_id: 'may', fecha: SAB, tipo: 'movida', hora_original: '13:00:00', hora_inicio: '15:00:00', lugar: 'Colegio Lestonnac' },
            { team_id: 'nor', fecha: SAB, tipo: 'extra', hora_inicio: '16:00:00', hora_fin: '18:00:00' },
            { team_id: 'u9', fecha: '2026-11-01', tipo: 'cancelada' },   // otro día: no cuenta
        ]));
        expect(h!.grupos).toEqual([
            { nombre: 'U9 Y U11 MIXTO', franjas: '11:00 a 13:00 (Parque Pinar de Suba 2)' },
            { nombre: 'MIXTO MAYORES', franjas: '15:00 a 17:00 (Colegio Lestonnac) (cambio de horario)' },
            { nombre: 'NORTE', franjas: '08:00 a 10:00 · 16:00 a 18:00 (entreno extra)' },
        ]);
        expect(h!.cancelados).toBeUndefined();
    });

    it('si la lectura de ajustes falla, lo de siempre', async () => {
        const h = await horariosDelDia('s1', SAB, { excepciones: async () => { throw new Error('caída'); } });
        expect(h!.grupos).toHaveLength(3);
    });
});
