/**
 * bot-ofertas.service — elegir la convocatoria que le aplica a cada persona y
 * mandarla con el texto de la escuela.
 *
 * Fixture = datos REALES de Monster's Volley después de DOS migraciones:
 *   · 20261125105034_monster_convocatorias_dic_2026.sql (ofertas, sesiones, bloqueo);
 *   · 20261125134852_bot_ofertas_criterios_y_textos.sql (descripción y cierre de
 *     cada oferta tal cual los mandó la escuela, criterios de año/trayectoria,
 *     lugar «ECCI» → «Universidad ECCI», públicos de Suba reescritos, y
 *     preguntas_ofertas / nota_ofertas de bot_ofertas_ajustes);
 *   · 20261125140432_monster_convocatoria_mayores_valor.sql (mayores: requiere_pago,
 *     valor 145000 y el texto de «Inversión» de la escuela al final del cierre).
 * En la forma en que los devuelve PostgREST (snake_case, '19:00:00').
 * Fechas en America/Bogota (UTC-5): 15:00Z = 10:00 en Bogotá.
 *
 * Los tests que empiezan con «BUG» fallan a propósito: documentan un defecto
 * real del servicio (ver el comentario de cada uno con el arreglo mínimo).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: () => { throw new Error('sin base en tests puros'); } } }));

import {
    armarEstado, datosDeRespuesta, aniosEnTexto, elegirOfertas, lineasDeSesiones, textoDeOferta, textoDeOfertas,
    textoOfertasParaPersona, textoOfertasParaIa, reglasDeOfertasParaIa,
    type FilasCrudas, type EstadoOfertas, type OfertaBot, type DatosDePersona,
} from './bot-ofertas.service';

// ─── Textos de la escuela (copiados de 20261125134852 y 20261125140432) ────

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';

const T_NORTE = 'Convocatorias Sede Norte — grupos de formación';
const T_MAYORES = 'Convocatorias equipos mayores de competencia — Superliga';
const T_SUBA = 'Convocatorias Sede Suba (Parque Pinar de Suba)';

const P = (...parrafos: string[]) => parrafos.join('\n\n');

const DESC_MAYORES = P(
    '¡Tu experiencia en el voleibol puede llevarte a un nuevo nivel!',
    'Por tu trayectoria y perfil deportivo, te invitamos a participar en las *convocatorias de los equipos mayores de competencia de Monster’s Volley*, orientadas a conformar nuestros equipos para el proyecto Superliga 2027.',
    'Buscamos deportistas comprometidos, con experiencia, mentalidad competitiva y disposición para asumir nuevos retos deportivos.',
);
/** Cierre de mayores DESPUÉS de 20261125140432: termina con la «Inversión» de la escuela. */
const INVERSION = P(
    '*Inversión convocatoria – Grupos de competencia, sede Norte*',
    'El valor de participación es de *$145.000*.',
    'Esta convocatoria está dirigida a deportistas que desean asumir nuevos retos, fortalecer su nivel de juego y proyectarse hacia procesos de mayor exigencia competitiva.',
    'Queremos conocer tu talento, compromiso y disposición para crecer dentro de nuestro proyecto deportivo 2027.',
    '¡Es momento de demostrar de qué estás hecho y dar el siguiente paso en tu carrera deportiva!',
);
const CTA_MAYORES = P(
    'Esta es una oportunidad para demostrar tu nivel, integrarte a un proceso competitivo y proyectarte hacia nuevos desafíos.',
    '¡Queremos conocer tu talento y contar contigo en este nuevo proyecto!',
    INVERSION,
);
const DESC_SUBA = P(
    '¡Queremos descubrir tu talento y ayudarte a dar el siguiente paso en el voleibol!',
    'Por tu año de nacimiento, te invitamos a participar en las *convocatorias de los grupos de proyección de nuestra sede Suba*.',
    'Estas jornadas nos permitirán conocer tus habilidades, evaluar tu nivel deportivo e identificar el grupo más adecuado para continuar tu proceso de formación y proyección.',
);
const CTA_SUBA = P(
    'Queremos que cada deportista tenga la oportunidad de demostrar sus capacidades y encontrar un espacio donde pueda seguir creciendo.',
    '*¡Tu próximo paso en el voleibol puede comenzar aquí!* Te esperamos en las convocatorias de Monster’s Volley.',
);
const DESC_NORTE = P(
    '¡Tenemos una oportunidad para que sigas creciendo en el voleibol!',
    'Por tu edad y perfil, te invitamos a participar en las *convocatorias de los grupos de formación de nuestra sede norte*.',
    'Buscamos identificar tus habilidades, conocer tu nivel de juego y orientarte hacia el grupo que mejor acompañe tu desarrollo deportivo.',
);
const CTA_NORTE = P(
    'Queremos brindarte un espacio donde puedas aprender, mejorar tus habilidades y disfrutar del voleibol mientras avanzas en tu proceso deportivo.',
    '¡Anímate a participar y comienza a construir tu camino en Monster’s Volley!',
);
const PREGUNTAS = P(
    '¡Queremos conocerte y conocer tu experiencia en el voleibol!',
    'Para orientarte hacia la convocatoria que mejor se adapte a tu perfil, cuéntanos:',
    [
        '- *Año de nacimiento:*',
        '- *Trayectoria deportiva:* ¿En qué clubes has entrenado y en qué torneos has participado?',
        '- *Posición de juego:* ¿En qué posición juegas habitualmente?',
        '- *Género:* ¿Masculino o femenino?',
    ].join('\n'),
    'Con esta información podremos identificar la convocatoria más adecuada para ti y orientarte sobre el proceso de ingreso a nuestro proyecto deportivo 2027.',
    '¡Queremos conocer tu talento y ayudarte a llevarlo al siguiente nivel!',
);
const NOTA = P(
    '¡Queremos conocer tu potencial y ayudarte a encontrar el grupo ideal para tu desarrollo deportivo!',
    'Durante las convocatorias realizaremos una evaluación objetiva de tus habilidades técnicas, capacidades físicas y fundamentos de juego.',
    'Nuestro propósito es identificar tus fortalezas y oportunidades de mejora para que, al finalizar enero, podamos asignarte al grupo de proyección o competencia que mejor se ajuste a tu nivel y proceso deportivo.',
    'No se trata solamente de seleccionar jugadores, sino de encontrar el espacio donde puedas crecer, mejorar y alcanzar tus objetivos en el voleibol.',
);

/** Públicos de Suba DESPUÉS de 20261125134852 (mismo orden que las horas). */
const GRUPOS_SUBA = [
    'Nacidos entre 2017 y 2022',
    'Nacidos en 2015 y 2016',
    'Nacidos en 2013 y 2014',
    'Nacidos en 2011 y 2012',
    'Nacidos en 2009 y 2010',
];
const HORAS_VIERNES = ['14:00', '14:00', '16:00', '18:00', '20:00'];
const HORAS_FINDE = ['07:00', '07:00', '09:00', '11:00', '13:00'];
const NOTA_CANCHA = 'Una cancha femenino y otra masculino';
const ECCI = 'Universidad ECCI';
const PINAR = 'Parque Pinar de Suba';

function filaOferta(o: Record<string, any>) {
    return {
        school_id: ESCUELA, tipo: 'convocatoria', sede: 'Sede Norte', genero: null, estado: 'activa',
        vigente_desde: '2026-11-25', cupos: null, requiere_inscripcion: true, requiere_pago: false, valor: null,
        mensaje_sin_cupos: null, anio_nacimiento_desde: null, anio_nacimiento_hasta: null, requiere_trayectoria: false,
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
            id: 'of-norte', titulo: T_NORTE, publico: 'Grupos de formación, todas las categorías',
            vigente_hasta: '2026-12-12', prioridad: 30, descripcion: DESC_NORTE, cta: CTA_NORTE,
        }),
        filaOferta({
            id: 'of-mayores', titulo: T_MAYORES,
            publico: 'Equipos mayores de competencia (Superliga), femenino y masculino',
            vigente_hasta: '2026-12-11', prioridad: 20, descripcion: DESC_MAYORES, cta: CTA_MAYORES,
            anio_nacimiento_hasta: 2008, requiere_trayectoria: true,
            requiere_pago: true, valor: 145000, // 20261125140432
        }),
        filaOferta({
            id: 'of-suba', titulo: T_SUBA, sede: 'Sede Suba', genero: 'mixto',
            publico: 'Grupos de proyección, nacidas y nacidos de 2009 a 2022',
            vigente_hasta: '2026-12-13', prioridad: 10, descripcion: DESC_SUBA, cta: CTA_SUBA,
            anio_nacimiento_desde: 2009, anio_nacimiento_hasta: 2022,
        }),
    ];
    const sesiones: any[] = [
        ses('of-norte', '2026-12-05', '07:00', '09:00', 'Locos por Pádel'),
        ses('of-norte', '2026-12-06', '07:00', '09:00', 'Locos por Pádel'),
        ses('of-norte', '2026-12-12', '08:00', '10:00', ECCI),

        ses('of-mayores', '2026-12-01', '19:00', '21:00', ECCI, { genero: 'femenino' }),
        ses('of-mayores', '2026-12-01', '19:00', '21:00', ECCI, { genero: 'masculino' }),
        ses('of-mayores', '2026-12-03', '19:00', '21:00', ECCI, { genero: 'femenino' }),
        ses('of-mayores', '2026-12-03', '19:00', '21:00', ECCI, { genero: 'masculino' }),
        ses('of-mayores', '2026-12-09', '19:00', '21:00', ECCI, { genero: 'femenino' }),
        ses('of-mayores', '2026-12-09', '20:00', '22:00', ECCI, { genero: 'masculino' }),
        ses('of-mayores', '2026-12-11', '19:00', '21:00', ECCI, { genero: 'femenino', notas: NOTA_CANCHA }),
        ses('of-mayores', '2026-12-11', '19:00', '21:00', ECCI, { genero: 'masculino', notas: NOTA_CANCHA }),
    ];
    for (const f of ['2026-12-04', '2026-12-11']) {
        GRUPOS_SUBA.forEach((publico, i) => sesiones.push(
            ses('of-suba', f, HORAS_VIERNES[i], null, PINAR, { genero: 'mixto', publico })));
    }
    for (const f of ['2026-12-05', '2026-12-12', '2026-12-06', '2026-12-13']) {
        GRUPOS_SUBA.forEach((publico, i) => sesiones.push(
            ses('of-suba', f, HORAS_FINDE[i], null, PINAR, { genero: 'mixto', publico })));
    }
    return {
        ofertas,
        sesiones,
        bloqueos: [{
            school_id: ESCUELA, tipo: 'clase_prueba', desde: '2026-12-01', hasta: '2027-01-31',
            motivo: 'En diciembre y enero no hay clases de prueba: se ofrecen las convocatorias (pedido de la escuela, 2026-11-25).',
        }],
        ajustesClasePrueba: null,
        mensajeSinOfertas: null,
        preguntasOfertas: PREGUNTAS,
        notaOfertas: NOTA,
        ...over,
    };
}

const NOV26 = Date.parse('2026-11-26T15:00:00Z'); // jueves 26-nov, 10:00 Bogotá
const DIC02 = Date.parse('2026-12-02T15:00:00Z');
const DIC10 = Date.parse('2026-12-10T15:00:00Z');
const DIC13 = Date.parse('2026-12-13T15:00:00Z'); // domingo 13-dic, 10:00 Bogotá

const estadoEn = (ahora: number, over: Partial<FilasCrudas> = {}) => armarEstado(ESCUELA, filasMonster(over), ahora);
const ids = (os: OfertaBot[]) => os.map((o) => o.id);
const de = (os: OfertaBot[], id: string) => os.find((o) => o.id === id)!;
const bullets = (txt: string) => txt.split('\n').filter((l) => l.startsWith('•'));
const veces = (txt: string, sub: string) => txt.split(sub).length - 1;
const datos = (anio: number | null, genero: DatosDePersona['genero'], trayectoria: boolean | null): DatosDePersona =>
    ({ anio, genero, trayectoria });

// Persona de cada escenario.
const NINA_2014 = datos(2014, 'femenino', false);
const HOMBRE_1998 = datos(1998, 'masculino', true);
const MUJER_2000 = datos(2000, 'femenino', false);
const NINO_2010 = datos(2010, 'masculino', true);

// ─── armarEstado: columnas nuevas ───────────────────────────────────────────

describe('armarEstado — criterios por oferta, preguntas y nota', () => {
    const e = estadoEn(NOV26);

    it('mapea anio_nacimiento_desde/hasta y requiere_trayectoria de cada oferta', () => {
        const crit = e.ofertas.map((o) => [o.id, o.anioDesde, o.anioHasta, o.requiereTrayectoria]);
        expect(crit).toEqual([
            ['of-norte', null, null, false],
            ['of-mayores', null, 2008, true],
            ['of-suba', 2009, 2022, false],
        ]);
    });

    it('trae la descripción y el cierre (cta) de la escuela', () => {
        expect(de(e.ofertas, 'of-suba').descripcion).toBe(DESC_SUBA);
        expect(de(e.ofertas, 'of-suba').cta).toBe(CTA_SUBA);
        expect(de(e.ofertas, 'of-mayores').publico).toBe('Equipos mayores de competencia (Superliga), femenino y masculino');
        expect(de(e.ofertas, 'of-mayores')).toMatchObject({ requierePago: true, valor: 145000, cta: CTA_MAYORES });
        expect(de(e.ofertas, 'of-suba')).toMatchObject({ requierePago: false, valor: null });
    });

    it('preguntasOfertas / notaOfertas pasan tal cual', () => {
        expect(e.preguntasOfertas).toBe(PREGUNTAS);
        expect(e.notaOfertas).toBe(NOTA);
    });

    it.each([
        ['', null],
        ['   \n\t ', null],
        [null, null],
        [undefined, null],
        ['  ¿Año de nacimiento?\n', '¿Año de nacimiento?'],
    ])('preguntas/nota %j → %j (recortadas; vacías = null)', (crudo, esperado) => {
        const x = estadoEn(NOV26, { preguntasOfertas: crudo as any, notaOfertas: crudo as any });
        expect(x.preguntasOfertas).toBe(esperado);
        expect(x.notaOfertas).toBe(esperado);
    });

    it('filas sin las columnas nuevas (base vieja) → sin rango y sin trayectoria; smallint como texto se convierte', () => {
        const f = filasMonster();
        for (const o of f.ofertas) {
            delete o.anio_nacimiento_desde; delete o.anio_nacimiento_hasta; delete o.requiere_trayectoria;
        }
        const viejo = armarEstado(ESCUELA, { ...f, preguntasOfertas: undefined, notaOfertas: undefined }, NOV26);
        expect(viejo.ofertas.every((o) => o.anioDesde === null && o.anioHasta === null && o.requiereTrayectoria === false)).toBe(true);
        expect(viejo.preguntasOfertas).toBeNull();
        expect(viejo.notaOfertas).toBeNull();

        const g = filasMonster();
        g.ofertas[2] = { ...g.ofertas[2], anio_nacimiento_desde: '2009', anio_nacimiento_hasta: '2022', requiere_trayectoria: 'true' };
        const s = de(armarEstado(ESCUELA, g, NOV26).ofertas, 'of-suba');
        expect([s.anioDesde, s.anioHasta]).toEqual([2009, 2022]);
        // Solo el booleano true cuenta (no la cadena 'true').
        expect(s.requiereTrayectoria).toBe(false);
    });
});

// ─── datosDeRespuesta / aniosEnTexto ─────────────────────────────────────────

describe('datosDeRespuesta', () => {
    const HOY = '2026-11-26';

    it('«2014, femenino, no he jugado en clubes, armadora» → 2014, femenino, sin trayectoria («no he jugado» gana a «clubes»)', () => {
        expect(datosDeRespuesta('2014, femenino, no he jugado en clubes, armadora', HOY))
            .toEqual({ anio: 2014, genero: 'femenino', trayectoria: false });
    });

    it('adulto con clubes y un año de torneo: el año de nacimiento es el más antiguo (2023 se ignora)', () => {
        const t = 'Nací en 1998. Masculino. Jugué en el club Bogotá Vóley y en la liga de Cundinamarca, torneo nacional 2023. Opuesto';
        expect(datosDeRespuesta(t, HOY)).toEqual({ anio: 1998, genero: 'masculino', trayectoria: true });
    });

    it('«tengo 15 años, mujer» el 26-nov-2026 → 2011 (año actual − edad), femenino, trayectoria sin decir', () => {
        expect(datosDeRespuesta('tengo 15 años, mujer', HOY)).toEqual({ anio: 2011, genero: 'femenino', trayectoria: null });
    });

    it('«12/05/2010 niño, he entrenado en el colegio» → 2010, masculino; «entrenado en el colegio» ya NO cuenta como trayectoria', () => {
        // «entrené en» se quitó de las señales: daba falsos positivos (el colegio).
        // La trayectoria se pregunta con botones Sí/No en la conversación guiada.
        expect(datosDeRespuesta('12/05/2010 niño, he entrenado en el colegio', HOY))
            .toEqual({ anio: 2010, genero: 'masculino', trayectoria: null });
    });

    it('sin datos → todo null', () => {
        expect(datosDeRespuesta('Hola, quiero información de las convocatorias', HOY))
            .toEqual({ anio: null, genero: null, trayectoria: null });
        expect(datosDeRespuesta('', HOY)).toEqual({ anio: null, genero: null, trayectoria: null });
    });

    // BUG (menor): datosDeRespuesta se protege con String(texto ?? '') pero le pasa a
    // detectarGenero el `texto` CRUDO → con null/undefined (mensaje sin texto: foto,
    // audio) lanza TypeError. El módulo promete «nunca lanza». Arreglo mínimo:
    //   return { anio, genero: detectarGenero(String(texto ?? '')), trayectoria };
    it('BUG: texto null/undefined (mensaje sin texto) no lanza', () => {
        expect(datosDeRespuesta(undefined as any, HOY)).toEqual({ anio: null, genero: null, trayectoria: null });
        expect(datosDeRespuesta(null as any, HOY)).toEqual({ anio: null, genero: null, trayectoria: null });
    });

    it('«ninguno» → trayectoria false', () => {
        expect(datosDeRespuesta('ninguno', HOY)).toEqual({ anio: null, genero: null, trayectoria: false });
        expect(datosDeRespuesta('Trayectoria: ninguna. Femenino. 2012', HOY))
            .toEqual({ anio: 2012, genero: 'femenino', trayectoria: false });
    });

    it('años imposibles para un deportista (2024+) no son año de nacimiento; un teléfono tampoco', () => {
        expect(datosDeRespuesta('quiero ir el 2026', HOY).anio).toBeNull();
        expect(datosDeRespuesta('mi cel 3012014567', HOY).anio).toBeNull();
        expect(datosDeRespuesta('nací en 2023', HOY).anio).toBe(2023);
    });

    it('la respuesta con la plantilla de la escuela llena', () => {
        const t = '- Año de nacimiento: 2009\n- Trayectoria deportiva: Club Gimnasio Moderno, intercolegiados 2024\n'
            + '- Posición de juego: líbero\n- Género: Femenino';
        expect(datosDeRespuesta(t, HOY)).toEqual({ anio: 2009, genero: 'femenino', trayectoria: true });
    });

    // BUG: «llevo 4 años jugando» / «juego hace 6 años» es DURACIÓN, no edad. Sin año
    // escrito, el regex de edad lo toma como «tiene 4 años» → anio 2022 y la manda al
    // grupo 2017–2022 de Suba (y nunca a mayores). Arreglo mínimo en datosDeRespuesta:
    //   const edad = t.match(/(?<!\b(?:hace|llev\w+|durante)\s+(?:mas de\s+)?)\b(\d{1,2})\s*anos?\b/);
    it('BUG: «llevo 4 años jugando» no es la edad (hoy da anio 2022)', () => {
        expect(datosDeRespuesta('Femenino, llevo 4 años jugando en el club Bogotá Vóley', HOY).anio).toBeNull();
        expect(datosDeRespuesta('juego hace 6 años en la liga, masculino', HOY).anio).toBeNull();
    });
});

describe('aniosEnTexto', () => {
    it.each([
        ['Nacidos entre 2017 y 2022', [2017, 2022]],
        ['Nacidos en 2013 y 2014', [2013, 2014]],
        ['Nacidos 2017, 2018, 2019, 2020, 2021 y 2022', [2017, 2022]],
        ['Grupos de formación, todas las categorías', null],
        [null, null],
        [undefined, null],
    ])('%j → %j', (texto, esperado) => {
        expect(aniosEnTexto(texto as any)).toEqual(esperado);
    });
});

// ─── elegirOfertas ───────────────────────────────────────────────────────────

describe('elegirOfertas — Monster, 26-nov', () => {
    const e = estadoEn(NOV26);

    it('niña 2014 sin trayectoria → Suba y Norte (nunca mayores), por datos', () => {
        const r = elegirOfertas(e, NINA_2014);
        expect(r.porDatos).toBe(true);
        expect([...ids(r.ofertas)].sort()).toEqual(['of-norte', 'of-suba']);
        // Norte no filtra por año: conserva sus 3 sesiones.
        expect(de(r.ofertas, 'of-norte').sesiones).toHaveLength(3);
    });

    it('niña 2014: de Suba solo «Nacidos en 2013 y 2014» — viernes 4:00 p. m. y fin de semana 9:00 a. m.', () => {
        const suba = de(elegirOfertas(e, NINA_2014).ofertas, 'of-suba');
        expect(suba.sesiones).toHaveLength(6);
        expect(new Set(suba.sesiones.map((s) => s.publico))).toEqual(new Set(['Nacidos en 2013 y 2014']));
        expect(lineasDeSesiones(suba.sesiones, e.hoy, { omitirLugar: true })).toEqual([
            '• viernes 4 y viernes 11 de diciembre, 4:00 p. m. · Nacidos en 2013 y 2014',
            '• sábado 5, domingo 6, sábado 12 y domingo 13 de diciembre, 9:00 a. m. · Nacidos en 2013 y 2014',
        ]);
    });

    // BUG (orden; lo pide el escenario): a quien dio su año, la oferta POR AÑO
    // (Suba: «Por tu año de nacimiento…») debería ir antes que la general (Norte,
    // «todas las categorías»). Hoy manda `prioridad` (Norte 30 > Suba 10, de
    // 20261125105034), así que el mensaje abre con Norte. Arreglo mínimo, en
    // elegirOfertas, cuando se sabe el año, antes de devolver `resto`:
    //   const conRango = (o: OfertaBot) => (o.anioDesde != null || o.anioHasta != null ? 1 : 0);
    //   resto.sort((a, b) => conRango(b) - conRango(a));   // sort estable: respeta prioridad dentro de cada grupo
    // (alternativa solo-datos: migración nueva con prioridad de Suba > 30).
    it('BUG: niña 2014 — Suba (por año) va antes que Norte y el mensaje abre con «¡Queremos descubrir tu talento…»', () => {
        const r = elegirOfertas(e, NINA_2014);
        expect(ids(r.ofertas)).toEqual(['of-suba', 'of-norte']);
        expect(textoDeOfertas(r.ofertas, e, { conNota: true })!
            .startsWith('¡Queremos descubrir tu talento y ayudarte a dar el siguiente paso en el voleibol!')).toBe(true);
    });

    it('hombre 1998 con trayectoria → SOLO mayores, solo sesiones masculinas', () => {
        const r = elegirOfertas(e, HOMBRE_1998);
        expect(r.porDatos).toBe(true);
        expect(ids(r.ofertas)).toEqual(['of-mayores']);
        expect(r.ofertas[0].sesiones).toHaveLength(4);
        expect(r.ofertas[0].sesiones.every((s) => s.genero === 'masculino')).toBe(true);
    });

    it('mujer 2000 sin trayectoria → solo Norte (mayores exige trayectoria; Suba es 2009–2022)', () => {
        const r = elegirOfertas(e, MUJER_2000);
        expect(r).toMatchObject({ porDatos: true });
        expect(ids(r.ofertas)).toEqual(['of-norte']);
    });

    it('niño 2010 con trayectoria → Suba (grupo 2009–2010) y Norte; mayores fuera por año', () => {
        const r = elegirOfertas(e, NINO_2010);
        expect(r.porDatos).toBe(true);
        expect([...ids(r.ofertas)].sort()).toEqual(['of-norte', 'of-suba']);
        const suba = de(r.ofertas, 'of-suba');
        expect(suba.sesiones).toHaveLength(6);
        expect(suba.sesiones.every((s) => s.publico === 'Nacidos en 2009 y 2010')).toBe(true);
        expect(lineasDeSesiones(suba.sesiones, e.hoy, { omitirLugar: true })).toEqual([
            '• viernes 4 y viernes 11 de diciembre, 8:00 p. m. · Nacidos en 2009 y 2010',
            '• sábado 5, domingo 6, sábado 12 y domingo 13 de diciembre, 1:00 p. m. · Nacidos en 2009 y 2010',
        ]);
    });

    it('año desconocido + femenino + trayectoria → SOLO mayores (comportamiento actual, documentado)', () => {
        // Sin año no se filtra por rango: si contó clubes/torneos, califica para mayores
        // y se le mandan SOLO esas — aunque sea una menor que no dijo su año. Por eso
        // la regla de <preguntas_de_la_escuela> pide el año ANTES de dar fechas.
        const r = elegirOfertas(e, datos(null, 'femenino', true));
        expect(r.porDatos).toBe(true);
        expect(ids(r.ofertas)).toEqual(['of-mayores']);
        expect(r.ofertas[0].sesiones.every((s) => s.genero === 'femenino')).toBe(true);
    });

    it('sin ningún dato → las que no exigen trayectoria (Norte y Suba completas), por datos', () => {
        const r = elegirOfertas(e, datos(null, null, null));
        expect(r.porDatos).toBe(true);
        expect(ids(r.ofertas)).toEqual(['of-norte', 'of-suba']);
        expect(de(r.ofertas, 'of-suba').sesiones).toHaveLength(30);
    });

    it('no muta el estado (las sesiones originales siguen completas)', () => {
        elegirOfertas(e, NINA_2014);
        elegirOfertas(e, HOMBRE_1998);
        expect(de(e.ofertas, 'of-suba').sesiones).toHaveLength(30);
        expect(de(e.ofertas, 'of-mayores').sesiones).toHaveLength(8);
    });
});

describe('elegirOfertas — nada aplica: todas las de su género, porDatos false', () => {
    it('26-nov sin Norte: mujer 2000 sin trayectoria → mayores (solo femenino) y Suba', () => {
        const e = estadoEn(NOV26);
        const sinNorte = { ofertas: e.ofertas.filter((o) => o.id !== 'of-norte') };
        const r = elegirOfertas(sinNorte, MUJER_2000);
        expect(r.porDatos).toBe(false);
        expect(ids(r.ofertas)).toEqual(['of-mayores', 'of-suba']);
        expect(de(r.ofertas, 'of-mayores').sesiones.every((s) => s.genero === 'femenino')).toBe(true);
        expect(de(r.ofertas, 'of-suba').sesiones).toHaveLength(30);
    });

    it('13-dic 10:00 (solo queda Suba 11:00 y 1:00 p. m.): hombre 1995 sin trayectoria → Suba completa', () => {
        const e = estadoEn(DIC13);
        expect(ids(e.ofertas)).toEqual(['of-suba']);
        const r = elegirOfertas(e, datos(1995, 'masculino', false));
        expect(r.porDatos).toBe(false);
        expect(ids(r.ofertas)).toEqual(['of-suba']);
        expect(r.ofertas[0].sesiones.map((s) => s.horaInicio)).toEqual(['11:00', '13:00']);
    });

    it('el género deja sin nada → lista vacía, porDatos false', () => {
        const e = estadoEn(NOV26);
        const mayores = de(e.ofertas, 'of-mayores');
        const soloFem = { ofertas: [{ ...mayores, sesiones: mayores.sesiones.filter((s) => s.genero === 'femenino') }] };
        expect(elegirOfertas(soloFem, HOMBRE_1998)).toEqual({ ofertas: [], porDatos: false });
    });
});

// ─── Textos para la persona ─────────────────────────────────────────────────

describe('textoDeOferta / textoDeOfertas — formato de la escuela', () => {
    const e = estadoEn(NOV26);

    const BLOQUE_SUBA_2014 = [
        DESC_SUBA,
        '*Fechas y horarios:*\n'
            + '• viernes 4 y viernes 11 de diciembre, 4:00 p. m. · Nacidos en 2013 y 2014\n'
            + '• sábado 5, domingo 6, sábado 12 y domingo 13 de diciembre, 9:00 a. m. · Nacidos en 2013 y 2014',
        `*Lugar:* ${PINAR}.`,
        CTA_SUBA,
    ].join('\n\n');
    const BLOQUE_NORTE = [
        DESC_NORTE,
        '*Fechas y horarios:*\n'
            + '• sábado 5 y domingo 6 de diciembre, 7:00 a 9:00 a. m. · Locos por Pádel\n'
            + `• sábado 12 de diciembre, 8:00 a 10:00 a. m. · ${ECCI}`,
        CTA_NORTE,
    ].join('\n\n');

    it('niña 2014: cada bloque exacto (descripción, fechas, lugar único, cierre) y la nota al final', () => {
        const r = elegirOfertas(e, NINA_2014);
        expect(textoDeOferta(de(r.ofertas, 'of-suba'), e.hoy)).toBe(BLOQUE_SUBA_2014);
        expect(textoDeOferta(de(r.ofertas, 'of-norte'), e.hoy)).toBe(BLOQUE_NORTE);

        const msg = textoDeOfertas(r.ofertas, e, { conNota: true })!;
        console.log(`[bot-ofertas] niña 2014 (Norte + Suba + nota), 26-nov: ${msg.length} caracteres`);
        // Mismo mensaje, en el orden que devuelve elegirOfertas (ver el test BUG de orden).
        const bloques = r.ofertas.map((o) => (o.id === 'of-suba' ? BLOQUE_SUBA_2014 : BLOQUE_NORTE));
        expect(msg).toBe([...bloques, NOTA].join('\n\n'));
        expect(msg.length).toBeLessThan(4096);
    });

    it('niña 2014: «*Lugar:* Parque Pinar de Suba.» una vez y nunca dentro de las viñetas; Norte (dos sitios) sin «*Lugar:*»', () => {
        const r = elegirOfertas(e, NINA_2014);
        const msg = textoDeOfertas(r.ofertas, e, { conNota: true })!;
        expect(msg).toContain('¡Queremos descubrir tu talento y ayudarte a dar el siguiente paso en el voleibol!');
        expect(veces(msg, '*Fechas y horarios:*')).toBe(2);
        expect(veces(msg, `*Lugar:* ${PINAR}.`)).toBe(1);
        expect(veces(msg, '*Lugar:*')).toBe(1);
        expect(bullets(msg).some((l) => l.includes(PINAR))).toBe(false);
        expect(bullets(msg).some((l) => l.includes('Locos por Pádel'))).toBe(true);
        expect(bullets(msg).some((l) => l.includes(ECCI))).toBe(true);
        // Sin títulos ni sede · público (eso es del formato corto).
        expect(msg).not.toContain(`*${T_SUBA}*`);
        expect(msg).not.toContain('Sede Suba');
        // Cada cierre una sola vez, dentro de su bloque; la nota al final.
        expect(veces(msg, CTA_NORTE)).toBe(1);
        expect(veces(msg, CTA_SUBA)).toBe(1);
        expect(msg.endsWith(NOTA)).toBe(true);
    });

    it('sin conNota (o sin nota en la escuela) no agrega la nota', () => {
        const r = elegirOfertas(e, NINA_2014);
        expect(textoDeOfertas(r.ofertas, e)).not.toContain(NOTA);
        expect(textoDeOfertas(r.ofertas, { ...e, notaOfertas: null }, { conNota: true })).not.toContain('evaluación objetiva');
        expect(textoDeOfertas([], e, { conNota: true })).toBeNull();
    });

    const BLOQUE_MAYORES_MASC = [
        DESC_MAYORES,
        '*Fechas y horarios:*\n'
            + '• martes 1 y jueves 3 de diciembre, 7:00 a 9:00 p. m. · masculino\n'
            + '• miércoles 9 de diciembre, 8:00 a 10:00 p. m. · masculino\n'
            + `• viernes 11 de diciembre, 7:00 a 9:00 p. m. · masculino · ${NOTA_CANCHA}`,
        `*Lugar:* ${ECCI}.`,
        CTA_MAYORES,
    ].join('\n\n');

    it('hombre 1998: mayores con solo líneas masculinas, «*Lugar:* Universidad ECCI.» y el cierre de la escuela', () => {
        const r = elegirOfertas(e, HOMBRE_1998);
        const msg = textoDeOfertas(r.ofertas, e)!;
        console.log(`[bot-ofertas] hombre 1998 (mayores), 26-nov: ${msg.length} caracteres; con nota: ${textoDeOfertas(r.ofertas, e, { conNota: true })!.length}`);
        expect(msg).toBe(BLOQUE_MAYORES_MASC);
        expect(bullets(msg)).toHaveLength(3);
        expect(bullets(msg).every((l) => l.includes(' · masculino'))).toBe(true);
        expect(bullets(msg).some((l) => / · femenino( ·|$)/.test(l))).toBe(false);
        expect(veces(msg, '¡Queremos conocer tu talento y contar contigo en este nuevo proyecto!')).toBe(1);
        // Desde 20261125140432 el cierre termina con la «Inversión» de la escuela.
        expect(msg.endsWith(INVERSION)).toBe(true);
        // Con la nota, el cierre queda justo antes de ella.
        expect(textoDeOfertas(r.ofertas, e, { conNota: true })).toBe(`${BLOQUE_MAYORES_MASC}\n\n${NOTA}`);
    });

    it('hombre 1998: la «Inversión» ($145.000) sale UNA vez y sin la línea genérica «Valor: $145.000»', () => {
        const msg = textoDeOfertas(elegirOfertas(e, HOMBRE_1998).ofertas, e, { conNota: true })!;
        expect(veces(msg, '*Inversión convocatoria – Grupos de competencia, sede Norte*')).toBe(1);
        expect(veces(msg, 'El valor de participación es de *$145.000*.')).toBe(1);
        expect(veces(msg, '145.000')).toBe(1);
        expect(msg).not.toContain('Valor: $');
    });

    it('con pago y un monto que los textos NO dicen → sí va «Valor: $…» (entre el lugar y el cierre)', () => {
        const mayores = de(elegirOfertas(e, HOMBRE_1998).ofertas, 'of-mayores');
        const txt = textoDeOferta({ ...mayores, valor: 200000 }, e.hoy);
        expect(txt).toContain(`*Lugar:* ${ECCI}.\n\nValor: $200.000\n\n${CTA_MAYORES}`);
        // El monto también se busca en la descripción.
        const enDesc = textoDeOferta({ ...mayores, descripcion: `${DESC_MAYORES}\n\nCosto: $200.000`, valor: 200000 }, e.hoy);
        expect(enDesc).not.toContain('Valor: $');
        // Sin requierePago o sin valor, nunca hay línea de valor.
        expect(textoDeOferta({ ...mayores, requierePago: false, valor: 200000 }, e.hoy)).not.toContain('Valor:');
        expect(textoDeOferta({ ...mayores, valor: null }, e.hoy)).not.toContain('Valor:');
    });

    it('formato corto: si el cta ya dice el monto, el bloque no repite «Valor:» y el cta va al final', () => {
        const mayores = de(elegirOfertas(e, HOMBRE_1998).ofertas, 'of-mayores');
        const corta = { ...mayores, descripcion: null, cta: 'Inscríbete aquí. Valor: $145.000.' };
        expect(textoDeOferta(corta, e.hoy)).not.toContain('Valor:');
        expect(textoDeOfertas([corta], e)!.endsWith('\n\nInscríbete aquí. Valor: $145.000.')).toBe(true);
        const sinMonto = { ...corta, cta: 'Inscríbete aquí.' };
        expect(bullets(textoDeOferta(sinMonto, e.hoy)).length).toBe(3);
        expect(textoDeOferta(sinMonto, e.hoy).endsWith('\nValor: $145.000')).toBe(true);
    });

    // BUG: el monto se busca como SUBCADENA. Con valor 45000 ('45.000') y un texto
    // que solo dice otro monto que lo contiene ('$145.000'), se omite la línea del
    // valor real y la persona solo ve un precio que no es. Arreglo mínimo en
    // textoDeOferta (montoEnTexto), con bordes numéricos:
    //   const re = new RegExp(`(?<![\\d.])${monto.replace(/\./g, '\\.')}(?![.,]?\\d)`);
    //   const montoEnTexto = monto != null && [o.descripcion, o.cta].some((t) => re.test(t ?? ''));
    it('BUG: un monto distinto que CONTIENE al valor ($145.000 vs 45.000) no esconde «Valor: $45.000»', () => {
        const mayores = de(elegirOfertas(e, HOMBRE_1998).ofertas, 'of-mayores');
        expect(textoDeOferta({ ...mayores, valor: 45000 }, e.hoy)).toContain('Valor: $45.000');
    });

    it('2-dic: las sesiones del martes 1 ya no salen', () => {
        const e2 = estadoEn(DIC02);
        const msg = textoDeOfertas(elegirOfertas(e2, HOMBRE_1998).ofertas, e2)!;
        expect(bullets(msg)[0]).toBe('• jueves 3 de diciembre, 7:00 a 9:00 p. m. · masculino');
        expect(msg).not.toContain('martes 1');
    });

    it('10-dic: el viernes 4 desapareció de la línea agrupada de Suba, el 11 sigue; Norte queda con un solo sitio', () => {
        const e10 = estadoEn(DIC10);
        const r = elegirOfertas(e10, NINA_2014);
        const msg = textoDeOfertas(r.ofertas, e10, { conNota: true })!;
        expect(msg).toContain('• viernes 11 de diciembre, 4:00 p. m. · Nacidos en 2013 y 2014');
        expect(msg).toContain('• sábado 12 y domingo 13 de diciembre, 9:00 a. m. · Nacidos en 2013 y 2014');
        expect(msg).not.toContain('viernes 4');
        // A Norte solo le queda el 12-dic en la ECCI: ahora el lugar va aparte.
        expect(textoDeOferta(de(r.ofertas, 'of-norte'), e10.hoy)).toBe([
            DESC_NORTE, '*Fechas y horarios:*\n• sábado 12 de diciembre, 8:00 a 10:00 a. m.', `*Lugar:* ${ECCI}.`, CTA_NORTE,
        ].join('\n\n'));
    });

    it('con pago: el valor va entre el lugar y el cierre; sin sesiones: descripción + cierre', () => {
        const suba = de(elegirOfertas(e, NINA_2014).ofertas, 'of-suba');
        const pago = textoDeOferta({ ...suba, requierePago: true, valor: 50000 }, e.hoy);
        expect(pago).toContain(`*Lugar:* ${PINAR}.\n\nValor: $50.000\n\n${CTA_SUBA}`);
        expect(textoDeOferta({ ...suba, sesiones: [] }, e.hoy)).toBe(`${DESC_SUBA}\n\n${CTA_SUBA}`);
        expect(textoDeOferta({ ...suba, sesiones: [], cta: null }, e.hoy)).toBe(DESC_SUBA);
    });

    it('lugar mixto (unas con lugar, otras sin) → sin «*Lugar:*» y cada línea con el suyo', () => {
        const norte = de(e.ofertas, 'of-norte');
        const o = { ...norte, sesiones: norte.sesiones.map((s, i) => (i === 2 ? { ...s, lugar: null } : s)) };
        const txt = textoDeOferta(o, e.hoy);
        expect(txt).not.toContain('*Lugar:*');
        expect(bullets(txt)).toEqual([
            '• sábado 5 y domingo 6 de diciembre, 7:00 a 9:00 a. m. · Locos por Pádel',
            '• sábado 12 de diciembre, 8:00 a 10:00 a. m.',
        ]);
    });

    it('textoOfertasParaPersona (sin nota, como lo llaman hoy los flujos) cabe en un mensaje de WhatsApp', () => {
        const sinNota = textoOfertasParaPersona(e)!;
        const todas = textoOfertasParaPersona(e, { conNota: true })!;
        // OJO (riesgo latente, hoy ningún flujo lo pide): las TRES con la nota pasan de 4096.
        console.log(`[bot-ofertas] las tres convocatorias con texto de la escuela, 26-nov: ${sinNota.length} caracteres; con nota: ${todas.length}`);
        expect(sinNota.length).toBeLessThan(4096);
        expect(textoOfertasParaPersona(e, { genero: 'femenino' })!.length).toBeLessThan(4096);
        expect(textoOfertasParaPersona(e, { genero: 'masculino' })!.length).toBeLessThan(4096);
    });

    it('todo lo que puede devolver elegirOfertas, CON la nota, cabe en un mensaje de WhatsApp (26-nov … 13-dic)', () => {
        const personas = [NINA_2014, HOMBRE_1998, MUJER_2000, NINO_2010, datos(null, null, null),
            datos(null, 'femenino', true), datos(null, 'masculino', null), datos(1995, 'masculino', false), datos(2020, null, null)];
        let max = 0;
        for (const ahora of [NOV26, DIC02, DIC10, DIC13]) {
            const ei = estadoEn(ahora);
            for (const p of personas) {
                const r = elegirOfertas(ei, p);
                const msg = textoDeOfertas(r.ofertas, ei, { conNota: true });
                max = Math.max(max, msg?.length ?? 0);
            }
        }
        console.log(`[bot-ofertas] mensaje elegido más largo (con nota), 26-nov … 13-dic: ${max} caracteres`);
        expect(max).toBeLessThan(4096);
    });
});

describe('lineasDeSesiones con omitirLugar', () => {
    const e = estadoEn(NOV26);

    it('mismas líneas que sin la opción, sin el lugar', () => {
        const ses = de(e.ofertas, 'of-suba').sesiones;
        const con = lineasDeSesiones(ses, e.hoy);
        const sin = lineasDeSesiones(ses, e.hoy, { omitirLugar: true });
        expect(sin).toEqual(con.map((l) => l.replace(` · ${PINAR}`, '')));
        expect(sin.some((l) => l.includes(PINAR))).toBe(false);
        expect(sin).toHaveLength(10);
    });

    it('sin opción: igual que antes (con el lugar)', () => {
        expect(lineasDeSesiones(de(e.ofertas, 'of-norte').sesiones, e.hoy)).toEqual([
            '• sábado 5 y domingo 6 de diciembre, 7:00 a 9:00 a. m. · Locos por Pádel',
            `• sábado 12 de diciembre, 8:00 a 10:00 a. m. · ${ECCI}`,
        ]);
    });
});

describe('regresión: ofertas SIN descripción siguen en el formato corto', () => {
    const e = estadoEn(NOV26);
    const CTA_CORTO = 'Para inscribirte escríbenos el nombre completo del deportista, su fecha de nacimiento '
        + 'y la convocatoria (día y hora) a la que quiere ir. La escuela te confirma el cupo.';
    const corta = (id: string, over: Partial<OfertaBot> = {}): OfertaBot =>
        ({ ...de(elegirOfertas(e, NINA_2014).ofertas, id), descripcion: null, cta: CTA_CORTO, ...over });

    it('título primero, sede · público, viñetas CON lugar; sin «Fechas y horarios» ni «Lugar» ni el cta en el bloque', () => {
        expect(textoDeOferta(corta('of-suba'), e.hoy)).toBe([
            `*${T_SUBA}*`,
            'Sede Suba · Grupos de proyección, nacidas y nacidos de 2009 a 2022',
            `• viernes 4 y viernes 11 de diciembre, 4:00 p. m. · ${PINAR} · Nacidos en 2013 y 2014`,
            `• sábado 5, domingo 6, sábado 12 y domingo 13 de diciembre, 9:00 a. m. · ${PINAR} · Nacidos en 2013 y 2014`,
        ].join('\n'));
    });

    it('descripción solo con espacios cuenta como sin descripción', () => {
        expect(textoDeOferta(corta('of-suba', { descripcion: '  \n ' }), e.hoy)).toBe(textoDeOferta(corta('of-suba'), e.hoy));
    });

    it('textoDeOfertas: el cta compartido de las cortas va UNA vez al final (y luego la nota)', () => {
        const msg = textoDeOfertas([corta('of-norte'), corta('of-suba')], e, { conNota: true })!;
        expect(msg.startsWith(`*${T_NORTE}*\n`)).toBe(true);
        expect(veces(msg, CTA_CORTO)).toBe(1);
        expect(msg.endsWith(`${CTA_CORTO}\n\n${NOTA}`)).toBe(true);
    });

    it('mezcla: la de texto propio trae su cierre en el bloque; solo el cta de la corta va al final', () => {
        const suba = de(elegirOfertas(e, NINA_2014).ofertas, 'of-suba');
        const msg = textoDeOfertas([suba, corta('of-norte')], e)!;
        expect(msg.startsWith(DESC_SUBA)).toBe(true);
        expect(veces(msg, CTA_SUBA)).toBe(1);
        expect(msg.endsWith(`\n\n${CTA_CORTO}`)).toBe(true);
    });
});

// ─── Para el modelo ─────────────────────────────────────────────────────────

describe('textoOfertasParaIa y reglasDeOfertasParaIa', () => {
    const e = estadoEn(NOV26);
    const sinPreguntas: EstadoOfertas = { ...e, preguntasOfertas: null };

    it('cabeceras con rango de años y «Solo con trayectoria»; «Cierre:» en vez de «Cómo inscribirse:»', () => {
        const ia = textoOfertasParaIa(e);
        expect(ia.startsWith('<ofertas_vigentes hoy="jueves 26 de noviembre">\n')).toBe(true);
        expect(ia).toContain(`[convocatoria] ${T_SUBA} · Sede Suba · Público: Grupos de proyección, nacidas y nacidos de 2009 a 2022`
            + ' · Nacidos de 2009 a 2022\n');
        expect(ia).toContain(`[convocatoria] ${T_MAYORES} · Sede Norte · Público: Equipos mayores de competencia (Superliga), femenino y masculino`
            + ' · Nacidos hasta 2008 · Solo con trayectoria (clubes, torneos)\n');
        expect(ia).toContain(`[convocatoria] ${T_NORTE} · Sede Norte · Público: Grupos de formación, todas las categorías\n`);
        expect(veces(ia, 'Solo con trayectoria (clubes, torneos)')).toBe(1);
        expect(veces(ia, 'Cierre: ')).toBe(3);
        expect(ia).not.toContain('Cómo inscribirse:');
        expect(ia).toContain(`  Cierre: ${CTA_SUBA}`);
        expect(ia).toContain(`  ${DESC_MAYORES}`);
    });

    it('valor: mayores dice «Valor: $145.000»; las que no tienen valor NUNCA dicen gratis', () => {
        const ia = textoOfertasParaIa(e);
        const NO_INDICO = 'Valor: la escuela no lo indicó; si preguntan, di que la escuela lo confirma (nunca digas que es gratis)';
        expect(veces(ia, '  Valor: $145.000\n')).toBe(1);
        expect(veces(ia, `  ${NO_INDICO}`)).toBe(2); // Norte y Suba
        expect(ia).not.toContain('Sin costo');
        // Exige pago pero sin valor cargado: tampoco es «gratis».
        const suba = de(e.ofertas, 'of-suba');
        const sinValor = textoOfertasParaIa({ ...e, ofertas: [{ ...suba, requierePago: true, valor: null }] });
        expect(sinValor).toContain(`  ${NO_INDICO}`);
        expect(sinValor).not.toContain('Valor: $');
    });

    it('rango abierto por abajo: «Nacidos desde X»', () => {
        const suba = de(e.ofertas, 'of-suba');
        const ia = textoOfertasParaIa({ ...e, ofertas: [{ ...suba, anioHasta: null }] });
        expect(ia).toContain(' · Nacidos desde 2009\n');
    });

    it('oferta sin descripción conserva «Cómo inscribirse:»', () => {
        const suba = de(e.ofertas, 'of-suba');
        const ia = textoOfertasParaIa({ ...e, ofertas: [{ ...suba, descripcion: null }] });
        expect(ia).toContain(`  Cómo inscribirse: ${CTA_SUBA}`);
        expect(ia).not.toContain('Cierre:');
    });

    it('<preguntas_de_la_escuela> solo cuando hay preguntasOfertas (al final, después de </ofertas_vigentes>)', () => {
        const ia = textoOfertasParaIa(e);
        expect(ia.endsWith(`</ofertas_vigentes>\n<preguntas_de_la_escuela>\n${PREGUNTAS}\n</preguntas_de_la_escuela>`)).toBe(true);
        const sin = textoOfertasParaIa(sinPreguntas);
        expect(sin).not.toContain('<preguntas_de_la_escuela>');
        expect(sin.endsWith('\n</ofertas_vigentes>')).toBe(true);
        // Sin ofertas no hay bloque, aunque haya preguntas.
        expect(textoOfertasParaIa({ ...e, ofertas: [] })).toBe('');
    });

    it('reglas: la de las preguntas aparece solo con preguntasOfertas y con ofertas', () => {
        const con = reglasDeOfertasParaIa(e);
        const sin = reglasDeOfertasParaIa(sinPreguntas);
        const esLaDePreguntas = (r: string) => r.includes('<preguntas_de_la_escuela>');
        expect(con.filter(esLaDePreguntas)).toHaveLength(1);
        expect(sin.some(esLaDePreguntas)).toBe(false);
        expect(con).toHaveLength(sin.length + 1);
        expect(con.every((r) => r.startsWith('- '))).toBe(true);
        expect(con.find(esLaDePreguntas)).toContain('dale SOLO la oferta que le aplica');
        expect(reglasDeOfertasParaIa({ ...e, ofertas: [] }).some(esLaDePreguntas)).toBe(false);
    });
});
