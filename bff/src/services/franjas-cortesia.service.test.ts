/**
 * Generador de franjas de cortesía desde teams.schedule: la parte pura (plan y
 * comparación con lo existente), sin base. Los horarios de prueba son los de
 * Dynasty medidos el 2026-10-06.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    planificarFranjas, compararConExistentes, filaParaInsertar, esSinLimite, normalizarHora,
    CUPOS_SIN_LIMITE, type EquipoParaFranjas, type FranjaExistente,
} from './franjas-cortesia.service';
import { textoCupos, intercalarPorGrupo, type FranjaCortesia } from './whatsapp-clase-cortesia.service';

vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./avisos-correo.service', () => ({ destinatariosDeEscuela: vi.fn(), enviarConReserva: vi.fn() }));

// Martes 2026-10-06. El lunes 2026-10-12 es festivo (Día de la Raza, trasladado).
const HOY = '2026-10-06';

const SENIORS: EquipoParaFranjas = {
    id: 't-seniors', name: 'SENIORS', active: true, admite_nuevos: true,
    schedule: [
        { day: 1, time: '20:00', end: '22:00', place: 'Coliseo Dynasty DC' },
        { day: 4, time: '20:00', end: '22:00', place: 'Coliseo Dynasty DC' },
    ],
};
const INTERMEDIO: EquipoParaFranjas = {
    id: 't-inter', name: 'INTERMEDIO', active: true, admite_nuevos: true,
    schedule: [
        { day: 2, time: '16:00', end: '18:00', group: 'Evolución', place: 'Cancha externa Nido del Colibrí' },
        { day: 6, time: '07:00', end: '09:00', group: 'Origen', place: 'Coliseo Dynasty DC' },
    ],
};

describe('planificarFranjas', () => {
    it('una franja por sesión semanal durante N semanas (default 3)', () => {
        const p = planificarFranjas([SENIORS], HOY);
        // 3 semanas desde el martes 06: jue 08, lun 12 (festivo), jue 15, lun 19, jue 22, lun 26.
        expect(p.franjas.map((f) => f.slot_date)).toEqual(['2026-10-08', '2026-10-15', '2026-10-19', '2026-10-22', '2026-10-26']);
        expect(p.franjas[0]).toMatchObject({
            team_id: 't-seniors', label: 'SENIORS', start_time: '20:00', end_time: '22:00', location: 'Coliseo Dynasty DC',
        });
        expect(planificarFranjas([SENIORS], HOY, 1).franjas.map((f) => f.slot_date)).toEqual(['2026-10-08']);
    });

    it('day sigue la convención JS: 0 = domingo', () => {
        const dom: EquipoParaFranjas = { id: 't', name: 'X', schedule: [{ day: 0, time: '8:00' }] };
        const p = planificarFranjas([dom], HOY, 1);
        expect(p.franjas).toHaveLength(1);
        expect(p.franjas[0].slot_date).toBe('2026-10-11'); // domingo
        expect(p.franjas[0].start_time).toBe('08:00');
    });

    it('no crea en festivos de Colombia (salvo que se pida) y lo reporta', () => {
        const p = planificarFranjas([SENIORS], HOY);
        expect(p.franjas.some((f) => f.slot_date === '2026-10-12')).toBe(false);
        expect(p.festivosOmitidos).toEqual([{ fecha: '2026-10-12', label: 'SENIORS' }]);
        const con = planificarFranjas([SENIORS], HOY, 3, { incluirFestivos: true });
        expect(con.franjas.some((f) => f.slot_date === '2026-10-12')).toBe(true);
    });

    it('subgrupo en el label', () => {
        const p = planificarFranjas([INTERMEDIO], HOY, 1);
        expect(p.franjas.map((f) => f.label)).toEqual(['INTERMEDIO · Evolución', 'INTERMEDIO · Origen']);
    });

    it('excluye NO USAR, inactivos, cerrados a nuevos y sin horario', () => {
        const p = planificarFranjas([
            { ...SENIORS, id: 'a', name: 'MINIVOLLEY -BENJAMINES (DUPLICADO - NO USAR)' },
            { ...SENIORS, id: 'b', name: 'VIEJO', active: false },
            { ...SENIORS, id: 'c', name: 'JUVENIL MAYORES FEMENINO', admite_nuevos: false },
            { id: 'd', name: 'SIN HORARIO', schedule: null },
            { id: 'e', name: 'BASURA', schedule: '[{"day":9,"time":"x"}]' },
        ], HOY);
        expect(p.franjas).toHaveLength(0);
        expect(p.excluidos.map((e) => e.motivo)).toEqual([
            'marcado NO USAR', 'inactivo', 'no admite nuevos', 'sin horario cargado', 'sin horario cargado',
        ]);
    });

    it('dos subgrupos a la misma hora el mismo día: una sola franja y se reporta el choque', () => {
        const t: EquipoParaFranjas = { id: 't', name: 'MENORES', schedule: [
            { day: 3, time: '17:00', group: 'White' }, { day: 3, time: '17:00', group: 'Selección' },
        ] };
        const p = planificarFranjas([t], HOY, 1);
        expect(p.franjas).toHaveLength(1);
        expect(p.choques).toHaveLength(1);
    });

    it('acepta schedule como string JSON', () => {
        const p = planificarFranjas([{ ...SENIORS, schedule: JSON.stringify(SENIORS.schedule) }], HOY, 1);
        expect(p.franjas).toHaveLength(1);
    });
});

describe('compararConExistentes (idempotencia)', () => {
    const ventana = { desde: HOY, hasta: '2026-10-27' };
    const plan = planificarFranjas([SENIORS], HOY).franjas;
    const existente = (o: Partial<FranjaExistente>): FranjaExistente => ({
        id: 'x', team_id: 't-seniors', slot_date: '2026-10-08', start_time: '20:00:00',
        reserved_count: 0, is_open: true, generated_from_schedule: true, ...o,
    });

    it('correr dos veces no duplica: lo que ya está (con hora HH:MM:SS de la base) no se crea', () => {
        const ya = plan.map((f, i) => existente({ id: `e${i}`, slot_date: f.slot_date, start_time: `${f.start_time}:00` }));
        const r = compararConExistentes(plan, ya, ventana);
        expect(r.crear).toHaveLength(0);
        expect(r.yaExistian).toBe(plan.length);
        expect(r.cerrar).toHaveLength(0);
    });

    it('una cerrada a mano por la escuela no se reabre ni se duplica', () => {
        const r = compararConExistentes(plan, [existente({ is_open: false })], ventana);
        expect(r.crear.some((f) => f.slot_date === '2026-10-08')).toBe(false);
    });

    it('horario cambiado: cierra la generada obsoleta sin reservas; la que tiene reserva se conserva', () => {
        const r = compararConExistentes(plan, [
            existente({ id: 'vieja', slot_date: '2026-10-09', start_time: '19:00:00' }),
            existente({ id: 'reservada', slot_date: '2026-10-10', start_time: '19:00:00', reserved_count: 1 }),
            // Manual (no generada): nunca se toca aunque no esté en el plan.
            existente({ id: 'manual', slot_date: '2026-10-11', generated_from_schedule: false }),
        ], ventana);
        expect(r.cerrar.map((e) => e.id)).toEqual(['vieja']);
        expect(r.conservadasConReserva.map((e) => e.id)).toEqual(['reservada']);
    });
});

describe('sin límite de cupos', () => {
    it('la fila va con CUPOS_SIN_LIMITE, owner como created_by y marcada como generada', () => {
        const f = planificarFranjas([SENIORS], HOY).franjas[0];
        const fila = filaParaInsertar(f, 'school-1', 'owner-1', HOY);
        expect(fila).toMatchObject({ max_capacity: CUPOS_SIN_LIMITE, created_by: 'owner-1', generated_from_schedule: true, is_open: true });
    });

    it('repite la validación de create_school_trial_slot: fecha pasada o label vacío no', () => {
        const f = planificarFranjas([SENIORS], HOY).franjas[0];
        expect(() => filaParaInsertar({ ...f, slot_date: '2026-10-01' }, 's', null, HOY)).toThrow(/futura/);
        expect(() => filaParaInsertar({ ...f, label: '  ' }, 's', null, HOY)).toThrow(/Label/);
    });

    it('el bot no dice «998 cupos»: dice «cupos disponibles»; las manuales siguen con número', () => {
        expect(esSinLimite(CUPOS_SIN_LIMITE - 1)).toBe(true);
        expect(textoCupos(CUPOS_SIN_LIMITE - 1)).toBe('cupos disponibles');
        expect(textoCupos(Math.ceil(CUPOS_SIN_LIMITE / 2))).toBe('cupos disponibles');
        expect(textoCupos(5)).toBe('5 cupos');
        expect(textoCupos(1)).toBe('1 cupo');
    });
});

describe('oferta del bot intercalada por grupo', () => {
    const F = (id: string, grupo: string, fecha: string): FranjaCortesia => ({
        id, grupo, fecha, horaInicio: '16:00', horaFin: null, sede: null, cupos: 998,
    });
    it('la primera página muestra grupos distintos, en orden de su próxima franja', () => {
        const r = intercalarPorGrupo([
            F('a1', 'A', '2026-10-06'), F('a2', 'A', '2026-10-07'), F('b1', 'B', '2026-10-07'),
            F('a3', 'A', '2026-10-08'), F('c1', 'C', '2026-10-09'), F('b2', 'B', '2026-10-09'),
        ]);
        expect(r.map((f) => f.id)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
    });
    it('normalizarHora', () => {
        expect(normalizarHora('7:05')).toBe('07:05');
        expect(normalizarHora('20:00:00')).toBe('20:00');
        expect(normalizarHora('25:00')).toBeNull();
    });
});

// ─── Ajustes por escuela (migración M1, Monster 2026-10-30) ────────────────

import { diasSemanaValidos, type FranjaPlaneada, type PlanDeFranjas } from './franjas-cortesia.service';
import { esFestivoColombia } from '../utils/festivos-colombia';
import type { ExcepcionSemana } from './semana-equipo.service';

/**
 * El algoritmo de `planificarFranjas` del 2026-10-29, congelado: la referencia
 * para probar que sin ajustes el plan nuevo es idéntico al de hoy.
 */
function planDeHoy(equipos: EquipoParaFranjas[], desde: string, semanas = 3, incluirFestivos = false): PlanDeFranjas {
    const norm = (h: unknown) => {
        const m = String(h ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
        if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
        return `${m[1].padStart(2, '0')}:${m[2]}`;
    };
    const leer = (raw: unknown): any[] => {
        try { const v = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(v) ? v : []; } catch { return []; }
    };
    const plan: PlanDeFranjas = { franjas: [], festivosOmitidos: [], excluidos: [], choques: [] };
    const inicio = Date.UTC(+desde.slice(0, 4), +desde.slice(5, 7) - 1, +desde.slice(8, 10));
    for (const t of equipos) {
        const nombre = String(t.name ?? '').trim();
        if (!nombre) continue;
        if (t.active === false) { plan.excluidos.push({ equipo: nombre, motivo: 'inactivo' }); continue; }
        if (/\bno\s+usar\b/i.test(nombre)) { plan.excluidos.push({ equipo: nombre, motivo: 'marcado NO USAR' }); continue; }
        if (t.admite_nuevos === false) { plan.excluidos.push({ equipo: nombre, motivo: 'no admite nuevos' }); continue; }
        const sesiones = leer(t.schedule).filter((f) => f && Number.isInteger(f.day) && f.day >= 0 && f.day <= 6 && norm(f.time));
        if (!sesiones.length) { plan.excluidos.push({ equipo: nombre, motivo: 'sin horario cargado' }); continue; }
        const vistas = new Map<string, FranjaPlaneada>();
        for (let i = 0; i < semanas * 7; i++) {
            const fecha = new Date(inicio + i * 86_400_000).toISOString().slice(0, 10);
            const dow = new Date(inicio + i * 86_400_000).getUTCDay();
            for (const s of sesiones.filter((x) => x.day === dow)) {
                const grupo = String(s.group ?? '').trim();
                const label = grupo ? `${nombre} · ${grupo}` : nombre;
                const hora = norm(s.time)!;
                if (!incluirFestivos && esFestivoColombia(fecha)) { plan.festivosOmitidos.push({ fecha, label }); continue; }
                const clave = `${t.id}|${fecha}|${hora}`;
                const previa = vistas.get(clave);
                if (previa) { plan.choques.push({ fecha, hora, labels: [previa.label, label] }); continue; }
                const franja: FranjaPlaneada = {
                    team_id: t.id, equipo: nombre, label, slot_date: fecha, start_time: hora,
                    end_time: norm(s.end), location: String(s.place ?? '').trim() || null,
                };
                vistas.set(clave, franja);
                plan.franjas.push(franja);
            }
        }
    }
    plan.franjas.sort((a, b) => (a.slot_date + a.start_time + a.label).localeCompare(b.slot_date + b.start_time + b.label));
    return plan;
}

/** Dynasty completo (formas reales: subgrupos, choques, «NO USAR», hora sin cero, schedule como string, domingo). */
const DYNASTY: EquipoParaFranjas[] = [
    SENIORS,
    INTERMEDIO,
    { id: 't-menores', name: 'MENORES', schedule: [{ day: 3, time: '17:00', group: 'White' }, { day: 3, time: '17:00', group: 'Selección' }] },
    { id: 't-mini', name: 'MINIVOLLEY BENJAMINES', schedule: JSON.stringify([{ day: 1, time: '7:00', end: '9:00', place: ' Coliseo ' }]) },
    { id: 't-dom', name: 'INFANTIL FEMENINO', schedule: [{ day: 0, time: '11:00', end: '13:00', place: 'Asoalsacia' }, { day: 6, time: '11:00:00' }] },
    { id: 't-dup', name: 'MINIVOLLEY -BENJAMINES (DUPLICADO - NO USAR)', schedule: SENIORS.schedule },
    { id: 't-viejo', name: 'VIEJO', active: false, schedule: SENIORS.schedule },
    { id: 't-cerrado', name: 'JUVENIL MAYORES FEMENINO', admite_nuevos: false, schedule: SENIORS.schedule },
    { id: 't-sin', name: 'SIN HORARIO', schedule: null },
];

describe('sin ajustes, el plan es idéntico al de hoy (Dynasty)', () => {
    it('misma lista de franjas, festivos, excluidos y choques', () => {
        const hoy = planDeHoy(DYNASTY, HOY);
        expect(hoy.franjas.length).toBeGreaterThan(20);
        expect(hoy.festivosOmitidos.length).toBeGreaterThan(0);
        expect(planificarFranjas(DYNASTY, HOY)).toEqual(hoy);
        expect(planificarFranjas(DYNASTY, HOY, 3, { excepciones: [], diasSemana: null })).toEqual(hoy);
        expect(planificarFranjas(DYNASTY, HOY, 3, { diasSemana: [] })).toEqual(hoy);
        expect(planificarFranjas(DYNASTY, HOY, 2, { incluirFestivos: true })).toEqual(planDeHoy(DYNASTY, HOY, 2, true));
    });

    it('los ajustes de OTRO equipo no tocan a Dynasty', () => {
        const otros: ExcepcionSemana[] = [{ team_id: 'otro', fecha: '2026-10-08', tipo: 'cancelada', hora_original: null }];
        expect(planificarFranjas(DYNASTY, HOY, 3, { excepciones: otros })).toEqual(planDeHoy(DYNASTY, HOY));
    });
});

describe('planificarFranjas con la semana del profe', () => {
    const fechas = (p: PlanDeFranjas) => p.franjas.map((f) => `${f.slot_date} ${f.start_time}`);
    const X = (o: Partial<ExcepcionSemana>): ExcepcionSemana => ({ team_id: 't-seniors', fecha: '2026-10-08', tipo: 'cancelada', ...o });

    it('cancelada: ese día no tiene franja; los demás siguen', () => {
        const p = planificarFranjas([SENIORS], HOY, 3, { excepciones: [X({ hora_original: null })] });
        expect(fechas(p)).toEqual(['2026-10-15 20:00', '2026-10-19 20:00', '2026-10-22 20:00', '2026-10-26 20:00']);
        const porHora = planificarFranjas([SENIORS], HOY, 1, { excepciones: [X({ hora_original: '20:00:00' })] });
        expect(porHora.franjas).toHaveLength(0);
    });

    it('movida: la franja va a la hora nueva, con su lugar y la misma duración', () => {
        const p = planificarFranjas([SENIORS], HOY, 1, {
            excepciones: [X({ tipo: 'movida', hora_original: '20:00:00', hora_inicio: '18:00:00', lugar: 'Coliseo El Salitre' })],
        });
        expect(p.franjas).toEqual([{
            team_id: 't-seniors', equipo: 'SENIORS', label: 'SENIORS', slot_date: '2026-10-08',
            start_time: '18:00', end_time: '20:00', location: 'Coliseo El Salitre',
        }]);
    });

    it('extra: una franja más ese día', () => {
        const p = planificarFranjas([SENIORS], HOY, 1, {
            excepciones: [X({ tipo: 'extra', fecha: '2026-10-10', hora_inicio: '10:00', hora_fin: '12:00', lugar: 'Coliseo Dynasty DC' })],
        });
        expect(fechas(p)).toEqual(['2026-10-08 20:00', '2026-10-10 10:00']);
        expect(p.franjas[1]).toMatchObject({ label: 'SENIORS', end_time: '12:00', location: 'Coliseo Dynasty DC' });
    });

    it('festivo + extra: el horario del festivo se omite, el extra sí tiene franja (también a la misma hora)', () => {
        const otraHora = planificarFranjas([SENIORS], HOY, 2, {
            excepciones: [X({ tipo: 'extra', fecha: '2026-10-12', hora_inicio: '18:00', hora_fin: '20:00' })],
        });
        expect(fechas(otraHora)).toContain('2026-10-12 18:00');
        expect(fechas(otraHora)).not.toContain('2026-10-12 20:00');
        expect(otraHora.festivosOmitidos).toEqual([{ fecha: '2026-10-12', label: 'SENIORS' }]);
        const mismaHora = planificarFranjas([SENIORS], HOY, 2, {
            excepciones: [X({ tipo: 'extra', fecha: '2026-10-12', hora_inicio: '20:00' })],
        });
        expect(fechas(mismaHora)).toContain('2026-10-12 20:00');
        expect(mismaHora.festivosOmitidos).toEqual([]);
    });

    it('un equipo sin horario base pero con un extra tiene esa franja (no queda «sin horario»)', () => {
        const p = planificarFranjas([{ id: 't-nuevo', name: 'NUEVO', schedule: null }], HOY, 1, {
            excepciones: [{ team_id: 't-nuevo', fecha: '2026-10-10', tipo: 'extra', hora_inicio: '09:00' }],
        });
        expect(fechas(p)).toEqual(['2026-10-10 09:00']);
        expect(p.excluidos).toEqual([]);
    });
});

describe('planificarFranjas: días de la clase de prueba y equipos que no la reciben', () => {
    it('dias_semana {0,6} (Monster): solo sábados y domingos', () => {
        const p = planificarFranjas(DYNASTY, HOY, 3, { diasSemana: [0, 6] });
        expect(p.franjas.length).toBeGreaterThan(0);
        expect(p.franjas.every((f) => [0, 6].includes(new Date(`${f.slot_date}T12:00:00Z`).getUTCDay()))).toBe(true);
        expect(p.franjas.map((f) => f.team_id)).not.toContain('t-seniors');
    });

    it('diasSemanaValidos: enteros 0–6 sin repetir; vacío o basura = todos (null)', () => {
        expect(diasSemanaValidos([6, 0, 6, 7, -1, '5'])).toEqual([6, 0, 5]);
        expect(diasSemanaValidos([])).toBeNull();
        expect(diasSemanaValidos(null)).toBeNull();
        expect(diasSemanaValidos('{0,6}')).toBeNull();
    });

    it('recibe_clase_prueba = false: sin franjas y se reporta', () => {
        const p = planificarFranjas([{ ...SENIORS, recibe_clase_prueba: false }, INTERMEDIO], HOY, 1);
        expect(p.franjas.every((f) => f.team_id === 't-inter')).toBe(true);
        expect(p.excluidos).toEqual([{ equipo: 'SENIORS', motivo: 'no recibe clase de prueba' }]);
        expect(planificarFranjas([{ ...SENIORS, recibe_clase_prueba: null }], HOY, 1).franjas).toHaveLength(1);
    });
});

describe('compararConExistentes: cupos y reabrir', () => {
    const ventana = { desde: HOY, hasta: '2026-10-27' };
    const plan = planificarFranjas([SENIORS], HOY).franjas;   // jue 08, jue 15, lun 19, …
    const E = (o: Partial<FranjaExistente>): FranjaExistente => ({
        id: 'x', team_id: 't-seniors', slot_date: '2026-10-08', start_time: '20:00:00',
        reserved_count: 0, is_open: true, generated_from_schedule: true, max_capacity: CUPOS_SIN_LIMITE, cerrada_por: null, ...o,
    });

    it('sin cupos_por_sesion no se ajusta ninguna (como antes)', () => {
        const r = compararConExistentes(plan, [E({ max_capacity: 5 })], ventana);
        expect(r.ajustarCupo).toEqual([]);
        expect(r.reabrir).toEqual([]);
    });

    it('cupos 10: ajusta las generadas abiertas y planeadas cuyas reservas caben (CHECK reserved ≤ max)', () => {
        const r = compararConExistentes(plan, [
            E({ id: 'ajusta' }),
            E({ id: 'igual', slot_date: '2026-10-15', max_capacity: 10 }),
            E({ id: 'llena', slot_date: '2026-10-19', reserved_count: 11 }),
            E({ id: 'manual', slot_date: '2026-10-22', generated_from_schedule: false }),
            E({ id: 'cerrada', slot_date: '2026-10-26', is_open: false, cerrada_por: 'escuela' }),
            E({ id: 'borde', slot_date: '2026-10-26', start_time: '20:00', reserved_count: 10 }),
        ], ventana, { cupos: 10 });
        expect(r.ajustarCupo.map((e) => e.id)).toEqual(['ajusta', 'borde']);
    });

    it('cupos inválidos (0, decimales) = sin ajuste', () => {
        expect(compararConExistentes(plan, [E({})], ventana, { cupos: 0 }).ajustarCupo).toEqual([]);
        expect(compararConExistentes(plan, [E({})], ventana, { cupos: 2.5 }).ajustarCupo).toEqual([]);
    });

    it('reabrir: solo las que cerró el horario y vuelven a estar en el plan', () => {
        const r = compararConExistentes(plan, [
            E({ id: 'horario', is_open: false, cerrada_por: 'horario' }),
            E({ id: 'escuela', slot_date: '2026-10-15', is_open: false, cerrada_por: 'escuela' }),
            E({ id: 'antes-de-m1', slot_date: '2026-10-19', is_open: false, cerrada_por: null }),
            E({ id: 'fuera-del-plan', slot_date: '2026-10-20', is_open: false, cerrada_por: 'horario' }),
            E({ id: 'manual', slot_date: '2026-10-22', is_open: false, cerrada_por: 'horario', generated_from_schedule: false }),
        ], ventana, { cupos: 10 });
        expect(r.reabrir.map((e) => e.id)).toEqual(['horario']);
        // La reabierta también toma el cupo de la escuela.
        expect(r.ajustarCupo.map((e) => e.id)).toEqual(['horario']);
        // Ninguna cerrada se vuelve a crear.
        expect(r.crear.map((f) => f.slot_date)).toEqual(['2026-10-26']);
    });

    it('filaParaInsertar con cupos_por_sesion; sin él (o inválido) sin límite', () => {
        const f = plan[0];
        expect(filaParaInsertar(f, 's', 'o', HOY, 12).max_capacity).toBe(12);
        expect(filaParaInsertar(f, 's', 'o', HOY, null).max_capacity).toBe(CUPOS_SIN_LIMITE);
        expect(filaParaInsertar(f, 's', 'o', HOY, 0).max_capacity).toBe(CUPOS_SIN_LIMITE);
    });
});
