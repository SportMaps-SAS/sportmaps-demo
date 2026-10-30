/**
 * Ajustes por escuela del embudo del interesado y de la agenda de la clase de
 * prueba (plan B2/B3 §5.8): un JSON inválido o una columna que no existe dejan
 * el embudo APAGADO (= el bot de hoy). Nunca lanza.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    /** Respuesta por lista de columnas pedida. */
    responder: (_tabla: string, _cols: string): any => ({ data: null, error: null }),
    pedidas: [] as { tabla: string; cols: string }[],
}));
vi.mock('../config/supabase', () => ({
    supabase: {
        from: (tabla: string) => {
            let cols = '';
            const api: any = {
                select: (c: string) => { cols = c; h.pedidas.push({ tabla, cols: c }); return api; },
                eq: () => api,
                maybeSingle: async () => h.responder(tabla, cols),
            };
            return api;
        },
    },
}));

import {
    ajustesDesdeFila, ajustesWhatsAppDeEscuela, preguntasDesdeJson, botonesSedeDesdeJson, temasDesdeJson, embudoActivo,
    modoDiscretoDeEscuela, temasAPersonaDeEscuela, ajustesClasePrueba, ajustesClasePruebaDesdeFila, cobraClaseEnElBot,
    textoMultilinea, AJUSTES_POR_DEFECTO, AJUSTES_CLASE_PRUEBA_POR_DEFECTO,
} from './whatsapp-ajustes-escuela.service';

const NORTE = '11111111-1111-4111-8111-111111111111';
const SUBA = '22222222-2222-4222-8222-222222222222';
const PREGUNTAS = [
    { clave: 'nombre', texto: '¿Cuál es el nombre completo del deportista?', tipo: 'texto' },
    { clave: 'fecha_nacimiento', texto: '¿Fecha de nacimiento?', tipo: 'fecha' },
    { clave: 'sexo', texto: '¿Es hombre o mujer?', tipo: 'botones', opciones: ['Mujer', 'Hombre'] },
    {
        clave: 'trayectoria', texto: '¿Trayectoria?', tipo: 'botones', opciones: ['Estoy empezando', 'Club y torneos'],
        detalle: { si: ['Club y torneos'], clave: 'trayectoria_detalle', texto: '¿En qué clubes?' },
    },
];
const FILA_BASE = {
    wa_modo_cortesia: 'clase', wa_cortesia_qr_id: null, wa_cortesia_dias: 7, wa_ayuda_app: false,
    wa_reclamos_de_valor: false, wa_responder_precios: true, wa_ventas_habilitadas: false,
};

beforeEach(() => {
    h.pedidas = [];
    h.responder = () => ({ data: null, error: null });
});

describe('preguntasDesdeJson', () => {
    it('Monster: válidas, con opciones normalizadas y el detalle condicional', () => {
        const p = preguntasDesdeJson(PREGUNTAS)!;
        expect(p).toHaveLength(4);
        expect(p[2]).toEqual({ clave: 'sexo', texto: '¿Es hombre o mujer?', tipo: 'botones', opciones: [{ titulo: 'Mujer' }, { titulo: 'Hombre' }] });
        expect(p[3].detalle).toEqual({ si: ['Club y torneos'], clave: 'trayectoria_detalle', texto: '¿En qué clubes?' });
    });

    it.each([
        ['null', null],
        ['vacío', []],
        ['no es array', { clave: 'nombre' }],
        ['clave repetida', [PREGUNTAS[0], PREGUNTAS[0]]],
        ['clave con espacios', [{ clave: 'mi nombre', texto: 'x', tipo: 'texto' }]],
        ['tipo desconocido', [{ clave: 'x', texto: 'x', tipo: 'casillas' }]],
        ['botones sin opciones', [{ clave: 'x', texto: 'x', tipo: 'botones' }]],
        ['4 botones', [{ clave: 'x', texto: 'x', tipo: 'botones', opciones: ['a', 'b', 'c', 'd'] }]],
        ['botón de 21 caracteres', [{ clave: 'x', texto: 'x', tipo: 'botones', opciones: ['123456789012345678901'] }]],
        ['detalle sin opciones', [{ clave: 'x', texto: 'x', tipo: 'texto', detalle: { si: ['a'], clave: 'y', texto: 'y' } }]],
        ['detalle que repite clave', [{ clave: 'x', texto: 'x', tipo: 'botones', opciones: ['a'], detalle: { si: ['a'], clave: 'x', texto: 'y' } }]],
        ['texto vacío', [{ clave: 'x', texto: '   ', tipo: 'texto' }]],
    ])('inválido (%s) → null = embudo apagado', (_n, v) => {
        expect(preguntasDesdeJson(v)).toBeNull();
    });
});

describe('botones de sede, temas y modo discreto', () => {
    it('botones de sede con su emoji (≤ 20); uno malo apaga la pregunta de sede', () => {
        expect(botonesSedeDesdeJson([{ branch_id: NORTE, titulo: '🟡 Sede Norte' }, { branch_id: SUBA, titulo: '⚫ Sede Suba' }]))
            .toEqual([{ branchId: NORTE, titulo: '🟡 Sede Norte' }, { branchId: SUBA, titulo: '⚫ Sede Suba' }]);
        expect(botonesSedeDesdeJson([{ branch_id: 'norte', titulo: 'Norte' }])).toBeNull();
        expect(botonesSedeDesdeJson([{ branch_id: NORTE, titulo: 'Una sede con un nombre larguísimo' }])).toBeNull();
        expect(botonesSedeDesdeJson([{ branch_id: NORTE, titulo: 'A' }, { branch_id: NORTE, titulo: 'B' }])).toBeNull();
        expect(botonesSedeDesdeJson(null)).toBeNull();
    });

    it('temas a persona: lista de textos o null (= la global)', () => {
        expect(temasDesdeJson(['becas', 'quejas', 'becas'])).toEqual(['becas', 'quejas']);
        expect(temasDesdeJson(['becas', 3])).toBeNull();
        expect(temasDesdeJson(null)).toBeNull();
        expect(temasAPersonaDeEscuela({ temasAPersona: null }, ['global'])).toEqual(['global']);
        expect(temasAPersonaDeEscuela({ temasAPersona: ['salud'] }, ['global'])).toEqual(['salud']);
        expect(temasAPersonaDeEscuela(AJUSTES_POR_DEFECTO, ['global'])).toEqual(['global']);
    });

    it('modo discreto: «si»/«no» de la escuela mandan; «global» o sin columna = la variable de siempre', () => {
        expect(modoDiscretoDeEscuela({ modoDiscreto: 'no' }, true)).toBe(false);
        expect(modoDiscretoDeEscuela({ modoDiscreto: 'si' }, false)).toBe(true);
        expect(modoDiscretoDeEscuela({ modoDiscreto: 'global' }, true)).toBe(true);
        expect(modoDiscretoDeEscuela(AJUSTES_POR_DEFECTO, false)).toBe(false);
    });

    it('la bienvenida conserva los renglones', () => {
        expect(textoMultilinea('¡Hola! 👋\r\n\r\n\r\n  Sede Norte   ·  Calle 201 ', 1000)).toBe('¡Hola! 👋\n\nSede Norte · Calle 201');
        expect(textoMultilinea('x'.repeat(1001), 1000)).toBeNull();
    });
});

describe('ajustesDesdeFila', () => {
    it('sin las columnas nuevas: las claves NO aparecen y el embudo queda apagado (Dynasty igual)', () => {
        const a = ajustesDesdeFila(FILA_BASE);
        expect(a).toEqual({ ...AJUSTES_POR_DEFECTO, responderPrecios: true });
        expect('preguntasProspecto' in a).toBe(false);
        expect(embudoActivo(a)).toBe(false);
    });

    it('columnas en NULL: claves presentes en null/«global» y embudo apagado', () => {
        const a = ajustesDesdeFila({
            ...FILA_BASE, wa_bienvenida: null, wa_botones_sede: null, wa_preguntas_prospecto: null, wa_modo_discreto: 'global', wa_temas_a_persona: null,
        });
        expect(a).toMatchObject({ bienvenida: null, botonesSede: null, preguntasProspecto: null, modoDiscreto: 'global', temasAPersona: null });
        expect(embudoActivo(a)).toBe(false);
    });

    it('JSON de preguntas inválido → embudo apagado aunque haya bienvenida', () => {
        const a = ajustesDesdeFila({ ...FILA_BASE, wa_bienvenida: 'Hola', wa_preguntas_prospecto: [{ clave: 'x', tipo: 'otro' }] });
        expect(a.bienvenida).toBe('Hola');
        expect(embudoActivo(a)).toBe(false);
    });

    it('Monster: embudo encendido', () => {
        const a = ajustesDesdeFila({
            ...FILA_BASE, wa_bienvenida: '¡Hola! 👋', wa_botones_sede: [{ branch_id: NORTE, titulo: '🟡 Sede Norte' }],
            wa_preguntas_prospecto: PREGUNTAS, wa_modo_discreto: 'no', wa_temas_a_persona: ['becas'],
        });
        expect(embudoActivo(a)).toBe(true);
        expect(a.modoDiscreto).toBe('no');
    });
});

describe('ajustesWhatsAppDeEscuela (lectura que nunca lanza)', () => {
    it('sin la migración (columna inexistente) cae a la consulta de antes: embudo apagado', async () => {
        h.responder = (_t, cols) => (cols.includes('wa_preguntas_prospecto')
            ? { data: null, error: { code: '42703', message: 'column school_settings.wa_bienvenida does not exist' } }
            : { data: FILA_BASE, error: null });
        const a = await ajustesWhatsAppDeEscuela('dynasty');
        expect(h.pedidas).toHaveLength(2);
        expect(a.responderPrecios).toBe(true);
        expect(embudoActivo(a)).toBe(false);
    });

    it('con la migración lee todo en UNA consulta', async () => {
        h.responder = () => ({ data: { ...FILA_BASE, wa_preguntas_prospecto: PREGUNTAS, wa_modo_discreto: 'si' }, error: null });
        const a = await ajustesWhatsAppDeEscuela('monster');
        expect(h.pedidas).toHaveLength(1);
        expect(embudoActivo(a)).toBe(true);
    });

    it('si todo falla, los defaults', async () => {
        h.responder = () => { throw new Error('red'); };
        expect(await ajustesWhatsAppDeEscuela('x')).toEqual(AJUSTES_POR_DEFECTO);
    });
});

describe('ajustes de la clase de prueba', () => {
    it('por defecto = hoy: cortesía, sin cobro en el bot, sin tope, todos los días', () => {
        expect(ajustesClasePruebaDesdeFila(null)).toEqual(AJUSTES_CLASE_PRUEBA_POR_DEFECTO);
        expect(cobraClaseEnElBot(AJUSTES_CLASE_PRUEBA_POR_DEFECTO)).toBe(false);
    });

    it('Monster: prueba, $15.000, 24 h, sábados y domingos, avisa al profe', () => {
        const a = ajustesClasePruebaDesdeFila({
            nombre_clase: 'prueba', trial_price: '15000.00', separar_horas: 24, cupos_por_sesion: 6,
            agendar_al_recibir: true, avisar_entrenador: true, dias_semana: [6, 0, 6, 9],
        });
        expect(a).toEqual({
            nombreClase: 'prueba', precio: 15000, separarHoras: 24, cuposPorSesion: 6,
            agendarAlRecibir: true, avisarEntrenador: true, diasSemana: [0, 6],
        });
        expect(cobraClaseEnElBot(a)).toBe(true);
        // Un precio en la app sin horas para separar no prende el cobro por chat (Dreamers).
        expect(cobraClaseEnElBot({ precio: 15000, separarHoras: null })).toBe(false);
    });

    it('sin la migración lee solo trial_price', async () => {
        h.responder = (_t, cols) => (cols.includes('nombre_clase')
            ? { data: null, error: { code: '42703', message: 'column does not exist' } }
            : { data: { trial_price: 20000 }, error: null });
        expect(await ajustesClasePrueba('dreamers')).toEqual({ ...AJUSTES_CLASE_PRUEBA_POR_DEFECTO, precio: 20000 });
        expect(h.pedidas.map((p) => p.tabla)).toEqual(['school_trial_class_settings', 'school_trial_class_settings']);
    });
});
