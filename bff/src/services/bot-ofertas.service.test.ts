/**
 * bot-ofertas.service — qué puede ofrecer hoy el bot de WhatsApp de una escuela.
 *
 * Fixture = datos REALES de Monster's Volley (migración
 * 20261125105034_monster_convocatorias_dic_2026.sql), en la forma en que los
 * devuelve PostgREST (snake_case, `hora_inicio` '19:00:00'):
 *   · bloqueo de clase de prueba 2026-12-01 … 2027-01-31;
 *   · A Norte formación (prioridad 30), B Superliga (20), C Suba (10, mixto);
 *   · D: un BORRADOR tipo Suba que nunca debe aparecer.
 * Fechas en America/Bogota (UTC-5, sin horario de verano).
 *
 * La sección «regresiones» cubre tres defectos que tuvo el servicio (género sin
 * sesiones, error de columna que no debe abrir la clase, bloqueos encadenados).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
    const st = {
        tablas: {} as Record<string, any[]>,
        /** Error que devuelve la consulta a esa tabla (null = sin error). */
        errores: {} as Record<string, any>,
        /** Una entrada por cada `supabase.from(tabla)`. */
        consultas: [] as string[],
        filtros: [] as { tabla: string; col: string; val: any }[],
    };
    function builder(tabla: string) {
        st.consultas.push(tabla);
        const filtros: ((f: any) => boolean)[] = [];
        const resultado = () => {
            const error = st.errores[tabla];
            if (error) return { data: null, error };
            return { data: (st.tablas[tabla] ?? []).filter((f) => filtros.every((p) => p(f))), error: null };
        };
        const api: any = {
            select: () => api,
            eq: (col: string, val: any) => {
                st.filtros.push({ tabla, col, val });
                filtros.push((f) => f[col] === val);
                return api;
            },
            maybeSingle: async () => {
                const r = resultado();
                return r.error ? r : { data: r.data![0] ?? null, error: null };
            },
            then: (ok: any, err: any) => Promise.resolve(resultado()).then(ok, err),
        };
        return api;
    }
    return { st, supabase: { from: (t: string) => builder(t) } };
});
vi.mock('../config/supabase', () => ({ supabase: h.supabase }));

import {
    armarEstado, hoyBogota, horaBogota, sumarDias, fechaLegible, fechasLegibles, horaLegible, rangoLegible,
    bloqueoEn, claseDePruebaPermitidaEn, detectarGenero, filtrarPorGenero, lineasDeSesiones, textoDeOferta,
    textoOfertasParaPersona, textoOfertasParaIa, reglasDeOfertasParaIa, estadoCerrado,
    estadoDeOfertas, claseDePruebaDisponible, invalidarCacheOfertas,
    type FilasCrudas, type EstadoOfertas, type OfertaBot,
} from './bot-ofertas.service';

// ─── Fixture: Monster's Volley, diciembre 2026 ──────────────────────────────

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const OTRA_ESCUELA = '00000000-0000-4000-8000-0000000000aa';
const CTA = 'Para inscribirte escríbenos el nombre completo del deportista, su fecha de nacimiento '
    + 'y la convocatoria (día y hora) a la que quiere ir. La escuela te confirma el cupo.';

const T_NORTE = 'Convocatorias Sede Norte — grupos de formación';
const T_MAYORES = 'Convocatorias equipos mayores de competencia — Superliga';
const T_SUBA = 'Convocatorias Sede Suba (Parque Pinar de Suba)';
const T_BORRADOR = 'Convocatorias Sede Suba — BORRADOR sin publicar';

const GRUPOS_SUBA = [
    'Nacidos 2017, 2018, 2019, 2020, 2021 y 2022',
    'Nacidos 2015 y 2016',
    'Nacidos 2013 y 2014',
    'Nacidos 2011 y 2012',
    'Nacidos 2009 y 2010',
];
const HORAS_VIERNES = ['14:00', '14:00', '16:00', '18:00', '20:00'];
const HORAS_FINDE = ['07:00', '07:00', '09:00', '11:00', '13:00'];

function filaOferta(o: Record<string, any>) {
    return {
        school_id: ESCUELA, tipo: 'convocatoria', descripcion: null, sede: null, publico: null, genero: null,
        estado: 'activa', vigente_desde: '2026-11-25', vigente_hasta: null, prioridad: 0, cupos: null,
        requiere_inscripcion: true, requiere_pago: false, valor: null, cta: CTA, mensaje_sin_cupos: null,
        ...o,
    };
}

function filasMonster(over: Partial<FilasCrudas> = {}): FilasCrudas {
    let n = 0;
    const ses = (oferta_id: string, fecha: string, ini: string, fin: string | null, lugar: string, extra: Record<string, any> = {}) => ({
        id: `ses-${++n}`, oferta_id, school_id: ESCUELA, fecha,
        hora_inicio: `${ini}:00`, hora_fin: fin ? `${fin}:00` : null, lugar,
        genero: null, publico: null, notas: null, ...extra,
    });

    const ofertas = [
        filaOferta({
            id: 'of-norte', titulo: T_NORTE, sede: 'Sede Norte', publico: 'Grupos de formación',
            vigente_hasta: '2026-12-12', prioridad: 30,
        }),
        filaOferta({
            id: 'of-mayores', titulo: T_MAYORES, sede: 'Sede Norte',
            publico: 'Equipos mayores de competencia (Superliga), femenino y masculino',
            vigente_hasta: '2026-12-11', prioridad: 20,
        }),
        filaOferta({
            id: 'of-suba', titulo: T_SUBA, sede: 'Sede Suba',
            publico: 'Nacidas y nacidos de 2009 a 2022, por año de nacimiento', genero: 'mixto',
            vigente_hasta: '2026-12-13', prioridad: 10,
        }),
        // D: borrador con vigencia larga y prioridad máxima: si se colara, saldría primero.
        filaOferta({
            id: 'of-borrador', titulo: T_BORRADOR, sede: 'Sede Suba', genero: 'mixto', estado: 'borrador',
            vigente_hasta: '2027-03-31', prioridad: 99,
        }),
    ];

    const NOTA = 'Una cancha femenino y otra masculino';
    const sesiones: any[] = [
        ses('of-norte', '2026-12-05', '07:00', '09:00', 'Locos por Pádel'),
        ses('of-norte', '2026-12-06', '07:00', '09:00', 'Locos por Pádel'),
        ses('of-norte', '2026-12-12', '08:00', '10:00', 'ECCI'),

        ses('of-mayores', '2026-12-01', '19:00', '21:00', 'ECCI', { genero: 'femenino' }),
        ses('of-mayores', '2026-12-01', '19:00', '21:00', 'ECCI', { genero: 'masculino' }),
        ses('of-mayores', '2026-12-03', '19:00', '21:00', 'ECCI', { genero: 'femenino' }),
        ses('of-mayores', '2026-12-03', '19:00', '21:00', 'ECCI', { genero: 'masculino' }),
        ses('of-mayores', '2026-12-09', '19:00', '21:00', 'ECCI', { genero: 'femenino' }),
        ses('of-mayores', '2026-12-09', '20:00', '22:00', 'ECCI', { genero: 'masculino' }),
        ses('of-mayores', '2026-12-11', '19:00', '21:00', 'ECCI', { genero: 'femenino', notas: NOTA }),
        ses('of-mayores', '2026-12-11', '19:00', '21:00', 'ECCI', { genero: 'masculino', notas: NOTA }),
    ];
    for (const f of ['2026-12-04', '2026-12-11']) {
        GRUPOS_SUBA.forEach((publico, i) => sesiones.push(
            ses('of-suba', f, HORAS_VIERNES[i], null, 'Parque Pinar de Suba', { genero: 'mixto', publico })));
    }
    for (const f of ['2026-12-05', '2026-12-12', '2026-12-06', '2026-12-13']) {
        GRUPOS_SUBA.forEach((publico, i) => sesiones.push(
            ses('of-suba', f, HORAS_FINDE[i], null, 'Parque Pinar de Suba', { genero: 'mixto', publico })));
    }
    sesiones.push(
        ses('of-borrador', '2026-12-05', '07:00', null, 'Parque Pinar de Suba', { genero: 'mixto' }),
        ses('of-borrador', '2026-12-20', '09:00', null, 'Parque Pinar de Suba', { genero: 'mixto' }),
        ses('of-borrador', '2027-02-06', '09:00', null, 'Parque Pinar de Suba', { genero: 'mixto' }),
    );

    return {
        ofertas,
        sesiones,
        bloqueos: [{
            school_id: ESCUELA, tipo: 'clase_prueba', desde: '2026-12-01', hasta: '2027-01-31',
            motivo: 'En diciembre y enero no hay clases de prueba: se ofrecen las convocatorias (pedido de la escuela, 2026-11-25).',
        }],
        ajustesClasePrueba: null,
        mensajeSinOfertas: null,
        ...over,
    };
}

/** '2026-11-26T10:00' en hora de Bogotá → epoch ms. */
const bogota = (local: string) => Date.parse(`${local}:00-05:00`);
const estadoEn = (local: string, over: Partial<FilasCrudas> = {}) => armarEstado(ESCUELA, filasMonster(over), bogota(local));
const ids = (e: EstadoOfertas) => e.ofertas.map((o) => o.id);
const oferta = (e: EstadoOfertas, id: string) => e.ofertas.find((o) => o.id === id)!;
const lineasSesion = (txt: string) => txt.split('\n').filter((l) => l.startsWith('•'));

// ─── Escenarios con datos reales ────────────────────────────────────────────

describe('Monster — 26-nov 10:00: clase de prueba disponible con bloqueo en camino', () => {
    const e = estadoEn('2026-11-26T10:00');

    it('hoy está disponible y avisa el próximo bloqueo desde el 1-dic', () => {
        expect(e.hoy).toBe('2026-11-26');
        expect(e.claseDePrueba).toEqual({
            disponible: true, motivo: null, bloqueadaHasta: null,
            proximoBloqueo: { tipo: 'clase_prueba', desde: '2026-12-01', hasta: '2027-01-31', motivo: expect.stringContaining('diciembre y enero') },
        });
    });

    it('una fecha antes del bloqueo se puede agendar; una dentro (5-dic) no — bordes incluidos', () => {
        expect(claseDePruebaPermitidaEn(e, '2026-11-28')).toBe(true);
        expect(claseDePruebaPermitidaEn(e, '2026-11-30')).toBe(true);
        expect(claseDePruebaPermitidaEn(e, '2026-12-01')).toBe(false);
        expect(claseDePruebaPermitidaEn(e, '2026-12-05')).toBe(false);
        expect(claseDePruebaPermitidaEn(e, '2027-01-31')).toBe(false);
        expect(claseDePruebaPermitidaEn(e, '2027-02-01')).toBe(true);
    });

    it('las tres convocatorias activas están, ordenadas por prioridad, con todas sus sesiones', () => {
        expect(ids(e)).toEqual(['of-norte', 'of-mayores', 'of-suba']);
        expect(oferta(e, 'of-norte').sesiones).toHaveLength(3);
        expect(oferta(e, 'of-mayores').sesiones).toHaveLength(8);
        expect(oferta(e, 'of-suba').sesiones).toHaveLength(30);
        expect(oferta(e, 'of-suba').sesiones[0]).toEqual({
            id: expect.any(String), fecha: '2026-12-04', horaInicio: '14:00', horaFin: null,
            lugar: 'Parque Pinar de Suba', genero: 'mixto', publico: GRUPOS_SUBA[0], notas: null,
        });
    });

    it('las reglas dicen «solo se pueden agendar hasta el lunes 30 de noviembre» y no prohíben la clase hoy', () => {
        const reglas = reglasDeOfertasParaIa(e);
        expect(reglas).toHaveLength(2);
        expect(reglas[0]).toBe('- Las clases de prueba solo se pueden agendar hasta el lunes 30 de noviembre; '
            + 'del martes 1 de diciembre al domingo 31 de enero de 2027 no hay. Nunca propongas una fecha dentro de ese rango.');
        expect(reglas[1]).toMatch(/^- Si preguntan por convocatorias/);
        expect(reglas[1]).toContain('A quien pregunte por una convocatoria NO le ofrezcas clase de prueba.');
        expect(reglas.join('\n')).not.toContain('HOY NO HAY CLASES DE PRUEBA');
    });
});

describe('Monster — 2-dic: diciembre bloqueado, se ofrecen las convocatorias', () => {
    const e = estadoEn('2026-12-02T10:00');

    it('clase de prueba no disponible por bloqueo hasta el 31-ene-2027', () => {
        expect(e.claseDePrueba).toEqual({ disponible: false, motivo: 'bloqueo', bloqueadaHasta: '2027-01-31', proximoBloqueo: null });
        expect(claseDePruebaPermitidaEn(e, '2026-12-05')).toBe(false);
    });

    it('las reglas prohíben la clase de prueba, dicen «Vuelven el lunes 1 de febrero de 2027» y mandan a las ofertas', () => {
        const reglas = reglasDeOfertasParaIa(e);
        expect(reglas).toHaveLength(2);
        expect(reglas[0]).toMatch(/^- HOY NO HAY CLASES DE PRUEBA\. Vuelven el lunes 1 de febrero de 2027\. No las ofrezcas/);
        expect(reglas[0]).toMatch(/ofrécele lo de <ofertas_vigentes>\.$/);
        expect(reglas[1]).toMatch(/^- Si preguntan por convocatorias/);
    });

    it('las convocatorias A, B y C siguen; la sesión del 1-dic de B ya no', () => {
        expect(ids(e)).toEqual(['of-norte', 'of-mayores', 'of-suba']);
        const b = oferta(e, 'of-mayores');
        expect(b.sesiones).toHaveLength(6);
        expect(b.sesiones.some((s) => s.fecha === '2026-12-01')).toBe(false);
    });
});

describe('Monster — 2-dic: «convocatoria femenina de mayores»', () => {
    const e = estadoEn('2026-12-02T10:00');
    const genero = detectarGenero('convocatoria femenina de mayores');
    const txt = textoOfertasParaPersona(e, { tipo: 'convocatoria', genero })!;

    it('detecta género femenino', () => {
        expect(genero).toBe('femenino');
    });

    it('de B solo salen las sesiones femeninas (ninguna con etiqueta masculino, ni la de 8:00 a 10:00 p. m.)', () => {
        expect(txt).toContain([
            `*${T_MAYORES}*`,
            'Sede Norte · Equipos mayores de competencia (Superliga), femenino y masculino',
            '• jueves 3 y miércoles 9 de diciembre, 7:00 a 9:00 p. m. · ECCI · femenino',
            '• viernes 11 de diciembre, 7:00 a 9:00 p. m. · ECCI · femenino · Una cancha femenino y otra masculino',
        ].join('\n'));
        // Lo único que dice «masculino» es contenido de la escuela (público de B y la nota del 11-dic),
        // nunca la etiqueta de género de una sesión.
        expect(lineasSesion(txt).filter((l) => /· masculino( ·|$)/.test(l))).toEqual([]);
        expect(txt).not.toContain('8:00 a 10:00 p. m.');
    });

    it('A (sin género) y C (mixto) se mantienen completas; la CTA va una sola vez', () => {
        expect(txt).toContain([
            `*${T_NORTE}*`,
            'Sede Norte · Grupos de formación',
            '• sábado 5 y domingo 6 de diciembre, 7:00 a 9:00 a. m. · Locos por Pádel',
            '• sábado 12 de diciembre, 8:00 a 10:00 a. m. · ECCI',
        ].join('\n'));
        expect(txt).toContain(`*${T_SUBA}*`);
        expect(lineasSesion(txt).filter((l) => l.includes('Parque Pinar de Suba'))).toHaveLength(10);
        expect(txt.split(CTA)).toHaveLength(2);
        expect(txt.endsWith(`\n\n${CTA}`)).toBe(true);
        expect(txt.indexOf(T_NORTE)).toBeLessThan(txt.indexOf(T_MAYORES));
        expect(txt.indexOf(T_MAYORES)).toBeLessThan(txt.indexOf(T_SUBA));
    });

    it('filtrarPorGenero masculino deja las tres masculinas de B y ninguna femenina', () => {
        const b = filtrarPorGenero(e.ofertas, 'masculino').find((o) => o.id === 'of-mayores')!;
        expect(b.sesiones.map((s) => `${s.fecha} ${s.horaInicio} ${s.genero}`)).toEqual([
            '2026-12-03 19:00 masculino', '2026-12-09 20:00 masculino', '2026-12-11 19:00 masculino',
        ]);
    });

    it('filtrarPorGenero sin género no toca nada', () => {
        expect(filtrarPorGenero(e.ofertas, null)).toBe(e.ofertas);
    });
});

describe('Monster — 10/11-dic: las sesiones pasadas desaparecen solas', () => {
    it('el 10-dic no aparece ninguna sesión anterior (1, 3, 4, 5, 6 ni 9 de diciembre)', () => {
        const e = estadoEn('2026-12-10T10:00');
        expect(ids(e)).toEqual(['of-norte', 'of-mayores', 'of-suba']);
        for (const o of e.ofertas) for (const s of o.sesiones) expect(s.fecha >= '2026-12-10').toBe(true);

        const txt = `${textoOfertasParaPersona(e)}\n${textoOfertasParaIa(e)}`;
        expect(txt).toContain('<ofertas_vigentes hoy="jueves 10 de diciembre">');
        for (const pasada of [/\b1 de diciembre/, /\b3 de diciembre/, /\b9 de diciembre/,
            /\bmartes 1\b/, /\bjueves 3\b/, /\bviernes 4\b/, /\bsábado 5\b/, /\bdomingo 6\b/, /\bmiércoles 9\b/]) {
            expect(txt).not.toMatch(pasada);
        }
        expect(txt).toContain('• sábado 12 de diciembre, 8:00 a 10:00 a. m. · ECCI');
        expect(txt).toContain('• sábado 12 y domingo 13 de diciembre, 7:00 a. m. · Parque Pinar de Suba');
    });

    it('mismo día: a las 19:30 la sesión 19:00–21:00 sigue; a las 21:00 ya no (y B se va entera)', () => {
        const a = estadoEn('2026-12-11T19:30');
        expect(oferta(a, 'of-mayores').sesiones.map((s) => `${s.fecha} ${s.horaInicio}-${s.horaFin} ${s.genero}`)).toEqual([
            '2026-12-11 19:00-21:00 femenino', '2026-12-11 19:00-21:00 masculino',
        ]);
        expect(textoOfertasParaPersona(a)).toContain('• viernes 11 de diciembre, 7:00 a 9:00 p. m. · ECCI · femenino');

        const b = estadoEn('2026-12-11T21:00');
        expect(ids(b)).toEqual(['of-norte', 'of-suba']);
        expect(textoOfertasParaPersona(b)).not.toContain(T_MAYORES);
    });

    it('sesión sin hora_fin: se va en cuanto empieza (Suba 20:00 del 11-dic)', () => {
        const antes = oferta(estadoEn('2026-12-11T19:59'), 'of-suba').sesiones;
        expect(antes[0]).toMatchObject({ fecha: '2026-12-11', horaInicio: '20:00', horaFin: null });
        expect(antes).toHaveLength(11);

        const justo = oferta(estadoEn('2026-12-11T20:00'), 'of-suba').sesiones;
        expect(justo[0]).toMatchObject({ fecha: '2026-12-12', horaInicio: '07:00' });
        expect(justo).toHaveLength(10);
    });

    it('el 13-dic a las 14:00 ya pasó la última sesión de Suba: no queda ninguna convocatoria', () => {
        expect(ids(estadoEn('2026-12-13T12:59'))).toEqual(['of-suba']);
        expect(ids(estadoEn('2026-12-13T14:00'))).toEqual([]);
    });
});

describe('Monster — 1-feb-2027: vuelve la clase de prueba y no hay ofertas', () => {
    const e = estadoEn('2027-02-01T10:00');

    it('clase de prueba disponible sin bloqueos pendientes', () => {
        expect(e.bloqueos).toEqual([]);
        expect(e.claseDePrueba).toEqual({ disponible: true, motivo: null, bloqueadaHasta: null, proximoBloqueo: null });
        expect(claseDePruebaPermitidaEn(e, '2027-02-06')).toBe(true);
    });

    it('todas las ofertas vencieron → reglas vacías (no se agrega nada cuando no hay nada que decir)', () => {
        expect(e.ofertas).toEqual([]);
        expect(reglasDeOfertasParaIa(e)).toEqual([]);
        expect(textoOfertasParaIa(e)).toBe('');
        expect(textoOfertasParaPersona(e)).toBeNull();
    });
});

describe('El borrador nunca aparece', () => {
    it.each(['2026-11-26T10:00', '2026-12-02T10:00', '2026-12-10T10:00', '2026-12-20T10:00', '2027-02-01T10:00'])(
        'en %s', (cuando) => {
            const e = estadoEn(cuando);
            expect(ids(e)).not.toContain('of-borrador');
            expect(textoOfertasParaIa(e)).not.toContain('BORRADOR');
            expect(textoOfertasParaPersona(e) ?? '').not.toContain('BORRADOR');
        });

    it('archivada tampoco, aunque esté en vigencia', () => {
        const f = filasMonster();
        f.ofertas = f.ofertas.map((o) => (o.id === 'of-suba' ? { ...o, estado: 'archivada' } : o));
        expect(ids(armarEstado(ESCUELA, f, bogota('2026-11-26T10:00')))).toEqual(['of-norte', 'of-mayores']);
    });
});

describe('Interruptor school_trial_class_settings', () => {
    const fechas = ['2026-11-26T10:00', '2026-12-02T10:00', '2027-02-01T10:00'];
    const apagados = [
        { enabled: true, whatsapp_enabled: false },
        { enabled: false, whatsapp_enabled: true },
        { enabled: false, whatsapp_enabled: false },
    ];

    for (const aj of apagados) {
        it.each(fechas)(`apagada (enabled=${aj.enabled}, whatsapp_enabled=${aj.whatsapp_enabled}) → nunca disponible: %s`, (cuando) => {
            const e = estadoEn(cuando, { ajustesClasePrueba: aj });
            expect(e.claseDePrueba).toEqual({ disponible: false, motivo: 'apagada', bloqueadaHasta: null, proximoBloqueo: null });
        });
    }

    it('apagada con ofertas: prohíbe la clase sin inventar fecha de regreso', () => {
        const reglas = reglasDeOfertasParaIa(estadoEn('2026-11-26T10:00', { ajustesClasePrueba: { enabled: true, whatsapp_enabled: false } }));
        expect(reglas[0]).toMatch(/^- HOY NO HAY CLASES DE PRUEBA\. No las ofrezcas/);
        expect(reglas.join('\n')).not.toContain('Vuelven');
        expect(reglas.join('\n')).not.toContain('solo se pueden agendar');
    });

    it('sin fila = prendida (y el bloqueo sigue mandando)', () => {
        expect(estadoEn('2026-11-26T10:00', { ajustesClasePrueba: null }).claseDePrueba.disponible).toBe(true);
        expect(estadoEn('2027-02-01T10:00', { ajustesClasePrueba: null }).claseDePrueba.disponible).toBe(true);
        expect(estadoEn('2026-12-02T10:00', { ajustesClasePrueba: null }).claseDePrueba.motivo).toBe('bloqueo');
    });

    it('fila con ambos en true (o null) = prendida', () => {
        expect(estadoEn('2026-11-26T10:00', { ajustesClasePrueba: { enabled: true, whatsapp_enabled: true } }).claseDePrueba.disponible).toBe(true);
        expect(estadoEn('2026-11-26T10:00', { ajustesClasePrueba: { enabled: null, whatsapp_enabled: null } }).claseDePrueba.disponible).toBe(true);
    });
});

describe('Sin ofertas y clase de prueba bloqueada', () => {
    const sinOfertas = (msg: string | null) => estadoEn('2026-12-02T10:00', { ofertas: [], sesiones: [], mensajeSinOfertas: msg });

    it('con mensajeSinOfertas de la escuela, la regla lo cita', () => {
        const reglas = reglasDeOfertasParaIa(sinOfertas('Las convocatorias de enero se publican el 15 de diciembre'));
        expect(reglas).toEqual([
            '- HOY NO HAY CLASES DE PRUEBA. Vuelven el lunes 1 de febrero de 2027. No las ofrezcas, no las agendes, '
            + 'no des sus horarios ni su valor, aunque la ficha, el catálogo o la conversación anterior las mencionen. '
            + 'Si alguien la pide, dile que por ahora no hay y que la escuela le escribe.',
            '- No hay ofertas para nuevos deportistas en este momento. Di: «Las convocatorias de enero se publican el 15 de diciembre».',
        ]);
    });

    it('sin mensaje (null o solo espacios) usa el texto neutro', () => {
        for (const msg of [null, '   ']) {
            const e = sinOfertas(msg);
            expect(e.mensajeSinOfertas).toBeNull();
            expect(reglasDeOfertasParaIa(e)[1]).toBe(
                '- No hay ofertas para nuevos deportistas en este momento. Di que la escuela le escribe para contarle las próximas fechas.');
        }
    });

    it('textoOfertasParaPersona es null y textoOfertasParaIa vacío', () => {
        const e = sinOfertas('x');
        expect(textoOfertasParaPersona(e)).toBeNull();
        expect(textoOfertasParaPersona(e, { tipo: 'convocatoria', genero: 'femenino' })).toBeNull();
        expect(textoOfertasParaIa(e)).toBe('');
    });

    it('con los datos reales: el 14-dic ya vencieron las tres y diciembre sigue bloqueado', () => {
        const e = estadoEn('2026-12-14T10:00', { mensajeSinOfertas: 'En enero publicamos nuevas convocatorias' });
        expect(e.ofertas).toEqual([]);
        expect(reglasDeOfertasParaIa(e)).toHaveLength(2);
        expect(reglasDeOfertasParaIa(e)[1]).toContain('Di: «En enero publicamos nuevas convocatorias»');
    });
});

// ─── Zona horaria y fechas ──────────────────────────────────────────────────

describe('Zona horaria America/Bogota', () => {
    it('2026-12-01T03:30Z todavía es 30-nov 22:30 en Bogotá → clase de prueba disponible', () => {
        const ahora = Date.parse('2026-12-01T03:30:00Z');
        expect(hoyBogota(ahora)).toBe('2026-11-30');
        expect(horaBogota(ahora)).toBe('22:30');
        const e = armarEstado(ESCUELA, filasMonster(), ahora);
        expect(e.claseDePrueba.disponible).toBe(true);
        expect(e.claseDePrueba.proximoBloqueo?.desde).toBe('2026-12-01');
        expect(claseDePruebaPermitidaEn(e, '2026-11-30')).toBe(true);
    });

    it('2026-12-01T05:00Z ya es 1-dic 00:00 en Bogotá → bloqueada', () => {
        const ahora = Date.parse('2026-12-01T05:00:00Z');
        expect(hoyBogota(ahora)).toBe('2026-12-01');
        expect(horaBogota(ahora)).toBe('00:00');
        expect(armarEstado(ESCUELA, filasMonster(), ahora).claseDePrueba.motivo).toBe('bloqueo');
    });

    it('la hora de Bogotá decide el «mismo día»: 2026-12-12T02:30Z = 11-dic 21:30 → B ya no está', () => {
        const e = armarEstado(ESCUELA, filasMonster(), Date.parse('2026-12-12T02:30:00Z'));
        expect(e.hoy).toBe('2026-12-11');
        expect(ids(e)).toEqual(['of-norte', 'of-suba']);
    });
});

describe('Fechas y horas legibles', () => {
    it('sumarDias cruza mes y año', () => {
        expect(sumarDias('2026-11-30', 1)).toBe('2026-12-01');
        expect(sumarDias('2026-12-01', -1)).toBe('2026-11-30');
        expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
        expect(sumarDias('2027-01-31', 1)).toBe('2027-02-01');
    });

    it('fechaLegible con año solo si no es el de hoy', () => {
        expect(fechaLegible('2026-12-05')).toBe('sábado 5 de diciembre');
        expect(fechaLegible('2026-12-05', '2026-11-26')).toBe('sábado 5 de diciembre');
        expect(fechaLegible('2027-02-01', '2026-12-02')).toBe('lunes 1 de febrero de 2027');
    });

    it('fechasLegibles agrupa por mes', () => {
        expect(fechasLegibles(['2026-12-05', '2026-12-06', '2026-12-12', '2026-12-13']))
            .toBe('sábado 5, domingo 6, sábado 12 y domingo 13 de diciembre');
        expect(fechasLegibles(['2026-12-06', '2026-12-05', '2026-12-05'])).toBe('sábado 5 y domingo 6 de diciembre');
        expect(fechasLegibles(['2026-12-05'])).toBe('sábado 5 de diciembre');
        expect(fechasLegibles([])).toBe('');
    });

    it('fechasLegibles entre meses y entre años (año solo en el tramo de otro año)', () => {
        expect(fechasLegibles(['2026-11-30', '2026-12-01'], '2026-11-26'))
            .toBe('lunes 30 de noviembre y martes 1 de diciembre');
        expect(fechasLegibles(['2026-12-31', '2027-01-02'], '2026-12-20'))
            .toBe('jueves 31 de diciembre y sábado 2 de enero de 2027');
        expect(fechasLegibles(['2026-12-30', '2026-12-31', '2027-01-02'], '2027-01-01'))
            .toBe('miércoles 30 y jueves 31 de diciembre de 2026 y sábado 2 de enero');
    });

    it('horaLegible', () => {
        expect(horaLegible('19:00')).toBe('7:00 p. m.');
        expect(horaLegible('07:05')).toBe('7:05 a. m.');
        expect(horaLegible('00:00')).toBe('12:00 a. m.');
        expect(horaLegible('12:00')).toBe('12:00 p. m.');
    });

    it('rangoLegible: un solo sufijo si coinciden, los dos si no; solo inicio sin fin', () => {
        expect(rangoLegible('07:00', '09:00')).toBe('7:00 a 9:00 a. m.');
        expect(rangoLegible('19:00', '21:00')).toBe('7:00 a 9:00 p. m.');
        expect(rangoLegible('11:00', '13:00')).toBe('11:00 a. m. a 1:00 p. m.');
        expect(rangoLegible('14:00', null)).toBe('2:00 p. m.');
    });

    it('bloqueoEn: bordes incluidos y por tipo', () => {
        const e = estadoEn('2026-11-26T10:00');
        expect(bloqueoEn(e.bloqueos, 'clase_prueba', '2026-12-01')).not.toBeNull();
        expect(bloqueoEn(e.bloqueos, 'clase_prueba', '2027-01-31')).not.toBeNull();
        expect(bloqueoEn(e.bloqueos, 'clase_prueba', '2026-11-30')).toBeNull();
        expect(bloqueoEn(e.bloqueos, 'convocatoria', '2026-12-05')).toBeNull();
    });

    it('un bloqueo de convocatoria esconde las convocatorias ese día', () => {
        const f = filasMonster();
        f.bloqueos.push({ school_id: ESCUELA, tipo: 'convocatoria', desde: '2026-12-02', hasta: '2026-12-03', motivo: null });
        expect(armarEstado(ESCUELA, f, bogota('2026-12-02T10:00')).ofertas).toEqual([]);
        expect(ids(armarEstado(ESCUELA, f, bogota('2026-12-04T10:00')))).toEqual(['of-norte', 'of-mayores', 'of-suba']);
    });
});

// ─── Textos ─────────────────────────────────────────────────────────────────

describe('lineasDeSesiones y textos', () => {
    const e = estadoEn('2026-11-26T10:00');

    it('Suba: una línea por grupo, juntando viernes 4 y viernes 11 y el fin de semana', () => {
        const lugar = 'Parque Pinar de Suba';
        expect(lineasDeSesiones(oferta(e, 'of-suba').sesiones, e.hoy)).toEqual([
            `• viernes 4 y viernes 11 de diciembre, 2:00 p. m. · ${lugar} · ${GRUPOS_SUBA[0]}`,
            `• viernes 4 y viernes 11 de diciembre, 2:00 p. m. · ${lugar} · ${GRUPOS_SUBA[1]}`,
            `• viernes 4 y viernes 11 de diciembre, 4:00 p. m. · ${lugar} · ${GRUPOS_SUBA[2]}`,
            `• viernes 4 y viernes 11 de diciembre, 6:00 p. m. · ${lugar} · ${GRUPOS_SUBA[3]}`,
            `• viernes 4 y viernes 11 de diciembre, 8:00 p. m. · ${lugar} · ${GRUPOS_SUBA[4]}`,
            `• sábado 5, domingo 6, sábado 12 y domingo 13 de diciembre, 7:00 a. m. · ${lugar} · ${GRUPOS_SUBA[0]}`,
            `• sábado 5, domingo 6, sábado 12 y domingo 13 de diciembre, 7:00 a. m. · ${lugar} · ${GRUPOS_SUBA[1]}`,
            `• sábado 5, domingo 6, sábado 12 y domingo 13 de diciembre, 9:00 a. m. · ${lugar} · ${GRUPOS_SUBA[2]}`,
            `• sábado 5, domingo 6, sábado 12 y domingo 13 de diciembre, 11:00 a. m. · ${lugar} · ${GRUPOS_SUBA[3]}`,
            `• sábado 5, domingo 6, sábado 12 y domingo 13 de diciembre, 1:00 p. m. · ${lugar} · ${GRUPOS_SUBA[4]}`,
        ]);
    });

    it('Superliga: no junta géneros, horas ni notas distintas', () => {
        expect(lineasDeSesiones(oferta(e, 'of-mayores').sesiones, e.hoy)).toEqual([
            '• martes 1, jueves 3 y miércoles 9 de diciembre, 7:00 a 9:00 p. m. · ECCI · femenino',
            '• martes 1 y jueves 3 de diciembre, 7:00 a 9:00 p. m. · ECCI · masculino',
            '• miércoles 9 de diciembre, 8:00 a 10:00 p. m. · ECCI · masculino',
            '• viernes 11 de diciembre, 7:00 a 9:00 p. m. · ECCI · femenino · Una cancha femenino y otra masculino',
            '• viernes 11 de diciembre, 7:00 a 9:00 p. m. · ECCI · masculino · Una cancha femenino y otra masculino',
        ]);
    });

    it('textoOfertasParaIa envuelve en <ofertas_vigentes> con cabecera, sesiones y cómo inscribirse', () => {
        const ia = textoOfertasParaIa(e);
        expect(ia.startsWith('<ofertas_vigentes hoy="jueves 26 de noviembre">\n')).toBe(true);
        expect(ia.endsWith('\n</ofertas_vigentes>')).toBe(true);
        expect(ia).toContain(`[convocatoria] ${T_NORTE} · Sede Norte · Público: Grupos de formación\n`
            + '  • sábado 5 y domingo 6 de diciembre, 7:00 a 9:00 a. m. · Locos por Pádel\n'
            + '  • sábado 12 de diciembre, 8:00 a 10:00 a. m. · ECCI\n'
            + '  Sin costo indicado por la escuela\n'
            + `  Cómo inscribirse: ${CTA}`);
        // C es mixto: no lleva «Género:».
        expect(ia).toContain(`[convocatoria] ${T_SUBA} · Sede Suba · Público: Nacidas y nacidos de 2009 a 2022, por año de nacimiento\n`);
        expect(ia).not.toContain('Género:');
        expect(ia.split('Cómo inscribirse:')).toHaveLength(4);
    });

    it('textoOfertasParaIa es "" sin ofertas', () => {
        expect(textoOfertasParaIa({ ...e, ofertas: [] })).toBe('');
    });

    it('textoDeOferta con pago muestra el valor en pesos; género no mixto va en la cabecera para la IA', () => {
        const o: OfertaBot = {
            ...oferta(e, 'of-norte'), tipo: 'clinica', titulo: 'Clínica de vóley', genero: 'femenino',
            requierePago: true, valor: 50000, sesiones: [],
        };
        expect(textoDeOferta(o)).toBe('*Clínica de vóley*\nSede Norte · Grupos de formación\nValor: $50.000');
        const ia = textoOfertasParaIa({ ...e, ofertas: [o] });
        expect(ia).toContain('[clinica] Clínica de vóley · Sede Norte · Público: Grupos de formación · Género: femenino');
        expect(ia).toContain('  Valor: $50.000');
        expect(ia).not.toContain('Sin costo');
    });

    it('textoOfertasParaPersona filtra por tipo', () => {
        expect(textoOfertasParaPersona(e, { tipo: 'clinica' })).toBeNull();
        expect(textoOfertasParaPersona(e, { tipo: 'convocatoria' })).toBe(textoOfertasParaPersona(e));
    });

    it('el mensaje de WhatsApp con las tres convocatorias cabe en 4096 caracteres', () => {
        const msg = textoOfertasParaPersona(e)!;
        console.log(`[bot-ofertas] mensaje de WhatsApp con las tres convocatorias (26-nov): ${msg.length} caracteres`);
        expect(msg.length).toBeLessThan(4096);
        expect(msg.startsWith(`*${T_NORTE}*\n`)).toBe(true);
    });
});

describe('detectarGenero', () => {
    it.each([
        ['convocatoria femenina de mayores', 'femenino'],
        ['¿Hay para niñas?', 'femenino'],
        ['equipo de MUJERES', 'femenino'],
        ['para mi hijo, rama masculina', 'masculino'],
        ['niños de 10 años', 'masculino'],
        ['VARONES', 'masculino'],
        ['mujeres y hombres', null],
        ['convocatoria de mayores', null],
        ['', null],
    ])('«%s» → %s', (texto, esperado) => {
        expect(detectarGenero(texto)).toBe(esperado);
    });
});

describe('estadoCerrado', () => {
    it('cerrado para la clase de prueba, sin ofertas', () => {
        const e = estadoCerrado(ESCUELA, bogota('2026-11-26T10:00'));
        expect(e).toEqual({
            schoolId: ESCUELA, hoy: '2026-11-26', ofertas: [], bloqueos: [],
            claseDePrueba: { disponible: false, motivo: 'error', bloqueadaHasta: null, proximoBloqueo: null },
            mensajeSinOfertas: null,
        });
    });
});

// ─── Regresiones de defectos ya corregidos ─────────────────────────────────

describe('regresiones', () => {
    /**
     * filtrarPorGenero descarta las ofertas SIN sesiones (o.sesiones = [])
     * cuando la persona pide un género, aunque la oferta sea sin género o mixta.
     * El último `.filter((o) => o.sesiones.length > 0 || o.genero === genero)`
     * no distingue «se quedó sin sesiones por el filtro» de «nunca tuvo».
     * Arreglo mínimo (filtrarPorGenero): decidir ANTES del map, cuando aún se sabe
     * si la oferta tenía sesiones:
     *   return ofertas
     *       .filter((o) => sirve(o.genero) && (o.sesiones.length === 0 || o.genero === genero || o.sesiones.some((s) => sirve(s.genero))))
     *       .map((o) => ({ ...o, sesiones: o.sesiones.filter((s) => sirve(s.genero)) }));
     */
    it('una oferta sin sesiones y sin género (o mixta) no debe desaparecer al pedir «femenino»', () => {
        const f = filasMonster();
        f.ofertas.push(
            filaOferta({ id: 'of-clinica', tipo: 'clinica', titulo: 'Clínica de vacaciones', vigente_hasta: '2026-12-20' }),
            filaOferta({ id: 'of-torneo', tipo: 'torneo', titulo: 'Torneo relámpago mixto', genero: 'mixto', vigente_hasta: '2026-12-20' }),
        );
        const e = armarEstado(ESCUELA, f, bogota('2026-12-02T10:00'));
        expect(ids(e)).toEqual(expect.arrayContaining(['of-clinica', 'of-torneo']));

        expect(filtrarPorGenero(e.ofertas, 'femenino').map((o) => o.id)).toEqual(expect.arrayContaining(['of-clinica', 'of-torneo']));
        expect(textoOfertasParaPersona(e, { tipo: 'clinica', genero: 'femenino' })).toContain('Clínica de vacaciones');
    });

    /**
     * Con dos bloqueos seguidos (dic y ene cargados como filas separadas)
     * `bloqueadaHasta` es el fin del PRIMERO: el modelo dice «Vuelven el viernes
     * 1 de enero de 2027» cuando enero también está bloqueado. Lo mismo pasa con
     * `proximoBloqueo.hasta` en la regla «del … al … no hay».
     * Arreglo mínimo (armarEstado, tras calcular bloqueoHoy): extender por la cadena
     * de bloqueos contiguos (ya vienen ordenados por `desde`):
     *   let hasta = bloqueoHoy?.hasta ?? null;
     *   if (hasta) for (const b of bloqueos)
     *       if (b.tipo === 'clase_prueba' && b.desde <= sumarDias(hasta, 1) && b.hasta > hasta) hasta = b.hasta;
     *   … y usar `hasta` como bloqueadaHasta.
     */
    it('bloqueos contiguos de clase_prueba: «Vuelven» debe ser el día después del ÚLTIMO', () => {
        const e = estadoEn('2026-12-02T10:00', {
            bloqueos: [
                { school_id: ESCUELA, tipo: 'clase_prueba', desde: '2026-12-01', hasta: '2026-12-31', motivo: 'diciembre' },
                { school_id: ESCUELA, tipo: 'clase_prueba', desde: '2027-01-01', hasta: '2027-01-31', motivo: 'enero' },
            ],
        });
        expect(claseDePruebaPermitidaEn(e, '2027-01-05')).toBe(false); // esto sí lo hace bien
        expect(e.claseDePrueba.bloqueadaHasta).toBe('2027-01-31');
        expect(reglasDeOfertasParaIa(e)[0]).toContain('Vuelven el lunes 1 de febrero de 2027.');
    });
});

// ─── Lectura con caché (supabase moqueado) ──────────────────────────────────

describe('estadoDeOfertas (lectura, caché de 60 s y falla cerrado)', () => {
    const AHORA = bogota('2026-11-26T10:00');
    let warn: ReturnType<typeof vi.spyOn>;

    function cargarTablas(over: { trial?: any[]; ajustes?: any[] } = {}) {
        const f = filasMonster();
        h.st.tablas = {
            bot_ofertas: [...f.ofertas, filaOferta({ id: 'of-ajena', school_id: OTRA_ESCUELA, titulo: 'Oferta de otra escuela', prioridad: 50 })],
            bot_oferta_sesiones: f.sesiones,
            bot_oferta_bloqueos: [...f.bloqueos, { school_id: OTRA_ESCUELA, tipo: 'clase_prueba', desde: '2026-11-01', hasta: '2026-11-30', motivo: null }],
            school_trial_class_settings: over.trial ?? [],
            bot_ofertas_ajustes: over.ajustes ?? [{ school_id: ESCUELA, mensaje_sin_ofertas: 'Pronto publicamos fechas nuevas' }],
        };
    }

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'], now: AHORA });
        invalidarCacheOfertas();
        h.st.errores = {};
        h.st.consultas = [];
        h.st.filtros = [];
        cargarTablas();
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
        warn.mockRestore();
    });

    it('camino feliz: arma el estado con las filas de la escuela (solo activas y solo de ESA escuela)', async () => {
        const e = await estadoDeOfertas(ESCUELA);
        expect(e.hoy).toBe('2026-11-26');
        expect(ids(e)).toEqual(['of-norte', 'of-mayores', 'of-suba']);
        expect(e.claseDePrueba).toMatchObject({ disponible: true, proximoBloqueo: { desde: '2026-12-01', hasta: '2027-01-31' } });
        expect(e.bloqueos).toHaveLength(1);
        expect(e.mensajeSinOfertas).toBe('Pronto publicamos fechas nuevas');
        expect(h.st.consultas.sort()).toEqual(
            ['bot_oferta_bloqueos', 'bot_oferta_sesiones', 'bot_ofertas', 'bot_ofertas_ajustes', 'school_trial_class_settings']);
        expect(h.st.filtros).toEqual(expect.arrayContaining([
            { tabla: 'bot_ofertas', col: 'school_id', val: ESCUELA },
            { tabla: 'bot_ofertas', col: 'estado', val: 'activa' },
        ]));
        for (const t of ['bot_oferta_sesiones', 'bot_oferta_bloqueos', 'school_trial_class_settings', 'bot_ofertas_ajustes']) {
            expect(h.st.filtros).toContainEqual({ tabla: t, col: 'school_id', val: ESCUELA });
        }
        expect(warn).not.toHaveBeenCalled();
    });

    it('lee el interruptor de school_trial_class_settings', async () => {
        cargarTablas({ trial: [{ school_id: ESCUELA, enabled: true, whatsapp_enabled: false }] });
        expect(await claseDePruebaDisponible(ESCUELA)).toBe(false);
        expect((await estadoDeOfertas(ESCUELA)).claseDePrueba.motivo).toBe('apagada');
    });

    it('caché: dentro de 60 s no vuelve a consultar; tras invalidarCacheOfertas sí', async () => {
        await estadoDeOfertas(ESCUELA);
        expect(h.st.consultas).toHaveLength(5);

        vi.setSystemTime(AHORA + 59_000);
        await estadoDeOfertas(ESCUELA);
        await claseDePruebaDisponible(ESCUELA);
        expect(h.st.consultas).toHaveLength(5);

        invalidarCacheOfertas(OTRA_ESCUELA);
        await estadoDeOfertas(ESCUELA);
        expect(h.st.consultas).toHaveLength(5);

        invalidarCacheOfertas(ESCUELA);
        await estadoDeOfertas(ESCUELA);
        expect(h.st.consultas).toHaveLength(10);

        invalidarCacheOfertas();
        await estadoDeOfertas(ESCUELA);
        expect(h.st.consultas).toHaveLength(15);
    });

    it('caché: vence a los 60 s', async () => {
        await estadoDeOfertas(ESCUELA);
        vi.setSystemTime(AHORA + 60_001);
        await estadoDeOfertas(ESCUELA);
        expect(h.st.consultas).toHaveLength(10);
    });

    it('caché: guarda filas, no el resultado — el filtrado por fecha se rehace con el `ahora` de cada llamada', async () => {
        await estadoDeOfertas(ESCUELA, AHORA);
        const e = await estadoDeOfertas(ESCUELA, bogota('2026-12-02T10:00'));
        expect(h.st.consultas).toHaveLength(5);
        expect(e.hoy).toBe('2026-12-02');
        expect(e.claseDePrueba).toMatchObject({ disponible: false, motivo: 'bloqueo' });
        expect(oferta(e, 'of-mayores').sesiones).toHaveLength(6);
    });

    it.each([
        ['PGRST205', "Could not find the table 'public.bot_ofertas' in the schema cache"],
        ['42P01', 'relation "public.bot_ofertas" does not exist'],
    ])('tabla bot_ofertas inexistente (%s) = sin ofertas, no error', async (code, message) => {
        h.st.errores.bot_ofertas = { code, message };
        const e = await estadoDeOfertas(ESCUELA);
        expect(e.ofertas).toEqual([]);
        expect(e.claseDePrueba).toMatchObject({ disponible: true, motivo: null, proximoBloqueo: { desde: '2026-12-01' } });
        expect(warn).not.toHaveBeenCalled();
        // Sin ofertas pero con el bloqueo vivo: el 2-dic falla bien (bloqueo, no error).
        const dic = await estadoDeOfertas(ESCUELA, bogota('2026-12-02T10:00'));
        expect(dic.claseDePrueba.motivo).toBe('bloqueo');
        expect(reglasDeOfertasParaIa(dic)[1]).toContain('Pronto publicamos fechas nuevas');
    });

    it('tabla bot_ofertas_ajustes inexistente = sin mensaje de respaldo, no error', async () => {
        h.st.errores.bot_ofertas_ajustes = { code: 'PGRST205', message: "Could not find the table 'public.bot_ofertas_ajustes' in the schema cache" };
        const e = await estadoDeOfertas(ESCUELA);
        expect(e.mensajeSinOfertas).toBeNull();
        expect(ids(e)).toEqual(['of-norte', 'of-mayores', 'of-suba']);
    });

    it('error real sin caché → falla cerrado (claseDePrueba no disponible, motivo error)', async () => {
        h.st.errores.bot_oferta_sesiones = { code: '57014', message: 'canceling statement due to statement timeout' };
        const e = await estadoDeOfertas(ESCUELA);
        expect(e).toEqual(estadoCerrado(ESCUELA, AHORA));
        expect(await claseDePruebaDisponible(ESCUELA)).toBe(false);
        expect(warn).toHaveBeenCalled();
    });

    it('error en school_trial_class_settings (aunque sea de tabla) → falla cerrado', async () => {
        h.st.errores.school_trial_class_settings = { code: 'PGRST205', message: 'schema cache' };
        const e = await estadoDeOfertas(ESCUELA);
        expect(e.claseDePrueba).toEqual({ disponible: false, motivo: 'error', bloqueadaHasta: null, proximoBloqueo: null });
    });

    it('error real CON caché previa (vencida) → usa las filas en caché y sigue reintentando', async () => {
        await estadoDeOfertas(ESCUELA);
        vi.setSystemTime(AHORA + 61_000);
        h.st.errores.bot_ofertas = { code: '08006', message: 'connection failure' };

        const e = await estadoDeOfertas(ESCUELA, bogota('2026-12-02T10:00'));
        expect(h.st.consultas).toHaveLength(10); // sí intentó leer
        expect(e.claseDePrueba).toMatchObject({ disponible: false, motivo: 'bloqueo', bloqueadaHasta: '2027-01-31' });
        expect(ids(e)).toEqual(['of-norte', 'of-mayores', 'of-suba']);
        expect(warn).toHaveBeenCalledTimes(1);

        // El error no renovó la caché: la próxima llamada vuelve a leer.
        h.st.errores = {};
        await estadoDeOfertas(ESCUELA);
        expect(h.st.consultas).toHaveLength(15);
    });

    /**
     * `faltaTabla` también acepta cualquier mensaje con «does not exist» o
     * «schema cache»: un error de COLUMNA (42703 «column … does not exist», típico
     * de BFF nuevo con base vieja) en bot_oferta_bloqueos se toma como «no hay
     * bloqueos» y la clase de prueba se ofrece en plena pausa (falla ABIERTO).
     * Arreglo mínimo (leerFilas):
     *   const faltaTabla = (e: any) => e && (e.code === '42P01' || e.code === 'PGRST205');
     */
    it('error de columna en bot_oferta_bloqueos (42703) debe fallar CERRADO, no ignorar el bloqueo', async () => {
        h.st.errores.bot_oferta_bloqueos = { code: '42703', message: 'column bot_oferta_bloqueos.motivo does not exist' };
        const e = await estadoDeOfertas(ESCUELA, bogota('2026-12-02T10:00'));
        expect(e.claseDePrueba.disponible).toBe(false);
        expect(e.claseDePrueba.motivo).toBe('error');
    });
});
