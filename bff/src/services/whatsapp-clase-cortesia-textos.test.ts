/**
 * Clase de cortesía con los textos y las canchas de cada escuela (Monster,
 * 2026-10-30):
 *   · Monster cobra la clase de prueba ($15.000): ningún mensaje del flujo dice
 *     «gratis» ni «cortesía» (incluido «La clase es *gratis*» después de las
 *     indicaciones, que salía igual).
 *   · Sin ajustes, la confirmación es la de siempre, letra por letra.
 *   · Las franjas traen sede, profes, años, Maps e indicaciones de la cancha
 *     (coincidencia exacta: «Pinar» ≠ «Pinar 2») y no se ofrece la sesión que
 *     el profe canceló o movió, ni los días que no son de clase de prueba.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Op = [string, any[]];
const h = vi.hoisted(() => ({
    resolver: (_tabla: string, _ops: [string, any[]][]): { data: any; error: any } => ({ data: null, error: null }),
}));
vi.mock('../config/supabase', () => {
    const builder = (tabla: string): any => {
        const ops: Op[] = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'limit', 'order', 'not', 'is']) {
            b[m] = (...args: any[]) => { ops.push([m, args]); return b; };
        }
        const fin = () => Promise.resolve(h.resolver(tabla, ops));
        b.maybeSingle = fin;
        b.then = (ok: any, ko: any) => fin().then(ok, ko);
        return b;
    };
    return { supabase: { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) } };
});
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./avisos-correo.service', () => ({ destinatariosDeEscuela: vi.fn(), enviarConReserva: vi.fn() }));

import {
    atenderTurnoCortesia, iniciarCortesia, responderGrupoPorEdad, franjasDeSupabase, enriquecerFranja, lineasDeCancha,
    bloqueFranja, QUE_LLEVAR, BOTON_CC,
    type CtxCortesia, type EstadoCortesia, type FranjaCortesia, type ResultadoReserva, type ReservaVigente,
} from './whatsapp-clase-cortesia.service';
import { textosDeClase, limpiarCacheTextosClase } from './textos-clase-prueba';
import { limpiarCacheGrupos, construirRangos, type LugarDeEscuela } from './grupos-por-edad.service';
import { limpiarCacheSemana } from './semana-equipo.service';

const AHORA = new Date('2026-10-06T13:00:00Z');   // martes 8:00 a. m. en Bogotá
const MONSTER = textosDeClase({ nombre_clase: 'prueba', trial_price: 15000 });
const NO_GRATIS = /gratis|cortes[ií]a/i;

const F = (id: string, fecha: string, hora: string, extra: Partial<FranjaCortesia> = {}): FranjaCortesia => ({
    id, grupo: 'U9 Y U11 MIXTO', fecha, horaInicio: hora, horaFin: '13:00', sede: 'Parque Pinar de Suba 2', cupos: 10, ...extra,
});

interface Enviado { texto: string; step: string; estado: EstadoCortesia | null; botones?: any[]; enTexto?: string }

function armar(op: {
    franjas?: FranjaCortesia[];
    reserva?: ReservaVigente | null;
    textos?: CtxCortesia['textos'];
    indicaciones?: string | null;
} = {}) {
    const enviados: Enviado[] = [];
    let estado: EstadoCortesia | null = null;
    const ctx: CtxCortesia = {
        conversationId: 'conv-1',
        schoolId: 'monster',
        contactWaId: '573001112233',
        enviar: async (texto, step, est, botones, enTexto) => {
            enviados.push({ texto, step, estado: est, botones, enTexto });
            estado = est;
        },
        leerEstado: async () => estado,
        franjas: async () => op.franjas ?? [],
        reservaVigente: async () => op.reserva ?? null,
        reservar: async () => ({ ok: true, leadId: 'lead-1', duplicado: false, conCupo: true }) as ResultadoReserva,
        cancelar: async () => ({ ok: true, franja: null }),
        avisarEscuela: async () => {},
        indicaciones: async () => op.indicaciones ?? null,
        rangos: async () => [],
        ahora: () => AHORA,
        ...(op.textos ? { textos: op.textos } : {}),
    };
    const turno = (texto: string, botonId: string | null = null) => atenderTurnoCortesia(ctx, texto, botonId);
    return { ctx, enviados, turno };
}

/** Todo lo que vio la familia: texto, texto alterno y botones/filas. */
const visible = (e: Enviado) => [e.texto, e.enTexto ?? '',
    ...(e.botones ?? []).flatMap((b: any) => [b.title, b.descripcion ?? ''])].join('\n');

beforeEach(() => {
    h.resolver = () => ({ data: null, error: null });
    limpiarCacheTextosClase();
    limpiarCacheGrupos();
    limpiarCacheSemana();
});

describe('Monster ($15.000): ningún mensaje dice «gratis» ni «cortesía»', () => {
    const FRANJAS = [
        F('f1', '2026-10-10', '11:00', { mapsUrl: 'https://maps.app.goo.gl/p2', indicacionesLugar: 'Si llueve, te avisamos por aquí.' }),
        F('f2', '2026-10-11', '09:30', { grupo: 'MIXTO MAYORES', sede: 'Liceo Fesan' }),
    ];

    it('recorrido completo: oferta → datos → resumen con el valor → reserva con indicaciones y Maps', async () => {
        const { enviados, turno } = armar({
            franjas: FRANJAS, textos: async () => MONSTER,
            indicaciones: 'Camiseta negra, pantaloneta, medias y tenis. Agua abundante.',
        });
        expect(await turno('quiero una clase de prueba')).toBe(true);
        expect(enviados[0].texto).toContain('La *clase de prueba* tiene un valor de *$15.000*');
        await turno('', `${BOTON_CC.FRANJA}f1`);
        await turno('Mariana Pérez');
        await turno('12');
        await turno('Laura Gómez');
        expect(enviados[enviados.length - 1].texto).toContain('• Valor de la clase: *$15.000*');
        await turno('', BOTON_CC.CONFIRMAR);
        const reserva = enviados[enviados.length - 1];
        expect(reserva.step).toBe('cortesia_reservada');
        expect(reserva.texto).toContain('Quedó reservada la clase de prueba de *Mariana Pérez*');
        expect(reserva.texto).toContain('🗺️ Cómo llegar: https://maps.app.goo.gl/p2\nℹ️ Si llueve, te avisamos por aquí.');
        expect(reserva.texto).toContain('⏰ Llega 10 minutos antes. La clase tiene un valor de *$15.000*.');
        for (const e of enviados) expect(visible(e), e.step).not.toMatch(NO_GRATIS);
    });

    it('sin franjas, cancelar, abandonar y demasiados intentos', async () => {
        const sin = armar({ textos: async () => MONSTER });
        await iniciarCortesia(sin.ctx, { texto: 'clase de prueba' });
        expect(sin.enviados[0].texto).toContain('horarios de *clase de prueba*');

        const reservada = armar({ textos: async () => MONSTER, reserva: { leadId: 'l1', nombre: 'Mariana', franja: FRANJAS[0] } });
        await reservada.turno('', BOTON_CC.CANCELAR);
        await reservada.turno('', BOTON_CC.CANCELAR_SI);
        expect(reservada.enviados.map((e) => e.texto).join('\n')).toContain('cancelé tu clase de prueba');

        const nadie = armar({ textos: async () => MONSTER });
        await nadie.turno('', BOTON_CC.CANCELAR);
        expect(nadie.enviados[0].texto).toBe('No encuentro una clase de prueba reservada desde este número. 🤔');

        const abandona = armar({ franjas: FRANJAS, textos: async () => MONSTER });
        await abandona.turno('quiero una clase de prueba');
        await abandona.turno('mejor no');
        expect(abandona.enviados[1].texto).toBe('Listo, lo dejamos así. Si quieres agendar después, escríbeme *clase de prueba*. 🙌');

        const terco = armar({ franjas: FRANJAS, textos: async () => MONSTER });
        await terco.turno('quiero una clase de prueba');
        await terco.turno('', `${BOTON_CC.FRANJA}f1`);
        for (let i = 0; i < 3; i++) await terco.turno('123');
        expect(terco.enviados[terco.enviados.length - 1].texto).toContain('escríbeme *clase de prueba*');

        for (const x of [sin, reservada, nadie, abandona, terco]) {
            for (const e of x.enviados) expect(visible(e), e.step).not.toMatch(NO_GRATIS);
        }
    });

    it('«¿qué grupo le corresponde a mi hija de 12?» ofrece reservar con el valor', async () => {
        const rangos = construirRangos([{ id: 't-u9', name: 'U9 Y U11 MIXTO', age_min: 7, age_max: 13 }], [], AHORA);
        const { ctx, enviados } = armar({ franjas: [{ ...FRANJAS[0], teamId: 't-u9' }], textos: async () => MONSTER });
        ctx.rangos = async () => rangos;
        await responderGrupoPorEdad(ctx, '¿qué grupo le corresponde a mi hija de 12 años?', { step: 'grupo_por_edad' });
        expect(enviados[0].texto).toContain('¿Te reservo una *clase de prueba* (*$15.000*)?');
        expect(visible(enviados[0])).not.toMatch(NO_GRATIS);
    });
});

describe('sin ajustes: la confirmación de siempre (golden)', () => {
    it('Dynasty: «clase de cortesía», «Es *gratis*» y sin líneas de cancha', async () => {
        const f = F('f1', '2026-10-10', '11:00', { grupo: 'INTERMEDIO · Origen', sede: 'Coliseo Dynasty DC' });
        const { enviados, turno } = armar({ franjas: [f] });   // sin `textos`: lee la escuela (sin fila → los de siempre)
        await turno('clase de cortesía');
        expect(enviados[0].texto).toContain('¡Claro! 🙌 La *clase de cortesía* es *gratis* y sirve para conocer la escuela.');
        await turno('', `${BOTON_CC.FRANJA}f1`);
        await turno('Juan Pérez');
        await turno('25');
        await turno('', BOTON_CC.CONFIRMAR);
        expect(enviados[enviados.length - 1].texto).toBe(
            `✅ ¡Listo! Quedó reservada la clase de cortesía de *Juan Pérez*:\n\n${bloqueFranja(f)}\n\n` +
            `🎒 Qué llevar: ${QUE_LLEVAR}.\n` +
            '⏰ Llega 10 minutos antes y dile al entrenador que vienes a la clase de cortesía. Es *gratis*.\n\n' +
            'Si no puedes ir, escríbeme *cancelar mi clase* para liberar el cupo.');
    });

    it('lineasDeCancha vacía sin Maps ni indicaciones', () => {
        expect(lineasDeCancha(F('x', '2026-10-10', '11:00'))).toBe('');
        expect(lineasDeCancha(null)).toBe('');
        expect(lineasDeCancha(F('x', '2026-10-10', '11:00', { mapsUrl: ' https://m ' }))).toBe('🗺️ Cómo llegar: https://m\n\n');
    });
});

describe('enriquecerFranja (pura)', () => {
    const CANCHAS: LugarDeEscuela[] = [
        { id: 'p2', nombre: 'Parque Pinar de Suba 2', direccion: 'Cl. 145 #91-19', mapsUrl: 'https://maps.app.goo.gl/p2', indicaciones: 'Si llueve, te avisamos.' },
        { id: 'pinar', nombre: 'Pinar', direccion: null, mapsUrl: 'https://maps.app.goo.gl/pinar' },
        { id: 'les', nombre: 'Colegio Lestonnac', direccion: null, mapsUrl: 'https://maps.app.goo.gl/les', indicaciones: 'Entrada de deportistas' },
    ];
    const SEDES = [{ name: 'Pinar', address: 'Dirección de la sede Pinar' }];
    const [RANGO] = construirRangos([{
        id: 'u9', name: 'U9 Y U11 MIXTO', branch_id: 'suba', facility_id: 'les', coachIds: ['c1'], coachNombres: ['Iván'],
        categoria: { birth_year_min: 2013, birth_year_max: 2020, rama: 'Mixto' },
    }], [], AHORA);
    const base = F('x', '2026-10-10', '11:00');

    it('cancha por nombre exacto, con sede, profes y años del grupo', () => {
        expect(enriquecerFranja(base, { teamId: 'u9', rango: RANGO, lugares: CANCHAS, sedes: SEDES })).toMatchObject({
            sede: 'Parque Pinar de Suba 2', direccion: 'Cl. 145 #91-19', mapsUrl: 'https://maps.app.goo.gl/p2',
            indicacionesLugar: 'Si llueve, te avisamos.', branchId: 'suba', coachIds: ['c1'], coaches: ['Iván'],
            anioMin: 2013, anioMax: 2020, teamId: 'u9',
        });
    });

    it('«Pinar» es la cancha Pinar (sin dirección → la de la sede, como antes), no «Pinar de Suba 2»', () => {
        const r = enriquecerFranja({ ...base, sede: 'Pinar' }, { teamId: 'u9', rango: RANGO, lugares: CANCHAS, sedes: SEDES });
        expect(r).toMatchObject({ sede: 'Pinar', mapsUrl: 'https://maps.app.goo.gl/pinar', direccion: 'Dirección de la sede Pinar' });
    });

    it('la franja no dice lugar: la cancha del equipo si tiene Maps o dirección', () => {
        const r = enriquecerFranja({ ...base, sede: null }, { teamId: 'u9', rango: RANGO, lugares: CANCHAS, sedes: SEDES });
        expect(r).toMatchObject({ sede: 'Colegio Lestonnac', mapsUrl: 'https://maps.app.goo.gl/les', indicacionesLugar: 'Entrada de deportistas' });
    });

    it('la sesión se movió de cancha en «Mi semana»: el lugar nuevo', () => {
        const r = enriquecerFranja(base, { teamId: 'u9', rango: RANGO, lugares: CANCHAS, sedes: SEDES, lugarMovido: 'Colegio Lestonnac' });
        expect(r.sede).toBe('Colegio Lestonnac');
    });

    it('sin canchas ni rango (Dynasty hoy): la dirección de la sede, como antes', () => {
        const r = enriquecerFranja({ ...base, sede: 'Coliseo Dynasty DC' }, {
            teamId: null, rango: null, lugares: [], sedes: [{ name: 'Coliseo Dynasty', address: 'Cl. 12 Bis #71g-09' }],
        });
        expect(r).toMatchObject({ sede: 'Coliseo Dynasty DC', direccion: 'Cl. 12 Bis #71g-09', mapsUrl: null, coaches: [] });
    });
});

describe('franjasDeSupabase con la migración M1', () => {
    // 2030-01-12 sábado · 13 domingo · 15 martes · 19 sábado · 20 domingo.
    const SLOTS = [
        { id: 's-sab', team_id: 'u9', label: 'U9 Y U11 MIXTO', slot_date: '2030-01-12', start_time: '11:00:00', end_time: '13:00:00', location: 'Parque Pinar de Suba 2', max_capacity: 10, reserved_count: 2 },
        { id: 's-cancelada', team_id: 'u9', label: 'U9 Y U11 MIXTO', slot_date: '2030-01-19', start_time: '11:00:00', end_time: '13:00:00', location: 'Parque Pinar de Suba 2', max_capacity: 10, reserved_count: 0 },
        { id: 's-martes', team_id: 'u9', label: 'U9 Y U11 MIXTO', slot_date: '2030-01-15', start_time: '17:00:00', end_time: null, location: null, max_capacity: 10, reserved_count: 0 },
        { id: 's-comp', team_id: 'comp', label: 'U15 COMPETENCIA', slot_date: '2030-01-13', start_time: '08:00:00', end_time: null, location: null, max_capacity: 999, reserved_count: 0 },
        { id: 's-lugar', team_id: 'may', label: 'MIXTO MAYORES', slot_date: '2030-01-13', start_time: '09:30:00', end_time: '11:30:00', location: 'Liceo Fesan', max_capacity: 999, reserved_count: 0 },
        { id: 's-hora', team_id: 'may', label: 'MIXTO MAYORES', slot_date: '2030-01-20', start_time: '09:30:00', end_time: '11:30:00', location: 'Liceo Fesan', max_capacity: 999, reserved_count: 0 },
        { id: 's-llena', team_id: 'may', label: 'MIXTO MAYORES', slot_date: '2030-01-12', start_time: '13:00:00', end_time: null, location: null, max_capacity: 5, reserved_count: 5 },
    ];
    const TABLAS: Record<string, any> = {
        school_trial_slots: SLOTS,
        teams: [
            { id: 'u9', name: 'U9 Y U11 MIXTO', branch_id: 'suba', category_id: 'cat-u9', coach_id: 'c1', facility_id: null, active: true },
            { id: 'may', name: 'MIXTO MAYORES', branch_id: 'suba', category_id: null, coach_id: null, facility_id: 'les', active: true },
            { id: 'comp', name: 'U15 COMPETENCIA', branch_id: 'suba', recibe_clase_prueba: false, active: true },
        ],
        school_categories: [{ id: 'cat-u9', birth_year_min: 2013, birth_year_max: 2020, rama: 'Mixto', branch_id: 'suba' }],
        enrollments: [],
        team_coaches: [{ team_id: 'u9', coach_id: 'c2' }],
        // teams.coach_id y team_coaches.coach_id son ids de school_staff (Integración, 2026-10-30).
        school_staff: [{ id: 'c1', full_name: 'Iván Rojas', status: 'active' }, { id: 'c2', full_name: 'Laura Díaz', status: 'active' }],
        school_branches: [{ name: 'Sede Suba', address: 'Cl. 145' }],
        facilities: [
            { id: 'p2', name: 'Parque Pinar de Suba 2', branch_id: 'suba', address: 'Cl. 145 #91-19', maps_url: 'https://maps.app.goo.gl/p2', indicaciones: 'Si llueve, te avisamos.' },
            { id: 'les', name: 'Colegio Lestonnac', branch_id: 'suba', address: null, maps_url: 'https://maps.app.goo.gl/les', indicaciones: 'Entrada de deportistas' },
        ],
        team_schedule_exceptions: [
            { team_id: 'u9', fecha: '2030-01-19', tipo: 'cancelada', hora_original: null, hora_inicio: null, hora_fin: null, lugar: null },
            { team_id: 'may', fecha: '2030-01-13', tipo: 'movida', hora_original: '09:30:00', hora_inicio: '09:30:00', hora_fin: null, lugar: 'Colegio Lestonnac' },
            { team_id: 'may', fecha: '2030-01-20', tipo: 'movida', hora_original: '09:30:00', hora_inicio: '10:30:00', hora_fin: null, lugar: null },
        ],
    };

    function conBase(ajustes: (ops: Op[]) => { data: any; error: any }) {
        h.resolver = (tabla, ops) => {
            if (tabla === 'school_trial_class_settings') return ajustes(ops);
            return { data: TABLAS[tabla] ?? null, error: null };
        };
    }

    it('solo sábado y domingo, sin la sesión cancelada, la movida de hora ni el equipo sin clase de prueba; enriquecidas', async () => {
        conBase(() => ({ data: { enabled: true, whatsapp_enabled: true, dias_semana: [0, 6] }, error: null }));
        const r = await franjasDeSupabase('monster');
        expect(r.map((f) => f.id)).toEqual(['s-sab', 's-lugar']);
        expect(r[0]).toMatchObject({
            sede: 'Parque Pinar de Suba 2', direccion: 'Cl. 145 #91-19', mapsUrl: 'https://maps.app.goo.gl/p2',
            indicacionesLugar: 'Si llueve, te avisamos.', branchId: 'suba', coachIds: ['c1', 'c2'],
            coaches: ['Iván Rojas', 'Laura Díaz'], anioMin: 2013, anioMax: 2020, cupos: 8, teamId: 'u9',
        });
        // Se movió de cancha a la misma hora: el lugar nuevo, con su Maps.
        expect(r[1]).toMatchObject({ sede: 'Colegio Lestonnac', mapsUrl: 'https://maps.app.goo.gl/les', horaInicio: '09:30' });
    });

    it('sin la columna dias_semana (migración sin aplicar): se lee como antes y no filtra días', async () => {
        conBase((ops) => {
            const cols = String(ops.find(([m]) => m === 'select')?.[1][0]);
            return cols.includes('dias_semana')
                ? { data: null, error: { code: '42703', message: 'column school_trial_class_settings.dias_semana does not exist' } }
                : { data: { enabled: true, whatsapp_enabled: true }, error: null };
        });
        const r = await franjasDeSupabase('monster');
        expect(r.map((f) => f.id)).toEqual(['s-sab', 's-martes', 's-lugar']);
    });

    it('el interruptor de WhatsApp apagado sigue apagando todo', async () => {
        conBase(() => ({ data: { enabled: true, whatsapp_enabled: false, dias_semana: null }, error: null }));
        expect(await franjasDeSupabase('monster')).toEqual([]);
    });
});
