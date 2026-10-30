/**
 * Nombre y valor de la clase de prueba por escuela. Lo que se vigila:
 *   · GOLDEN: sin ajustes, los textos son los literales de siempre (Dynasty),
 *     letra por letra, copiados del código del 2026-10-29.
 *   · Con valor (Monster, $15.000): nunca «gratis» ni «cortesía».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    respuestas: [] as { data: any; error: any }[],
    selects: [] as string[],
}));
vi.mock('../config/supabase', () => ({
    supabase: {
        from: () => ({
            select: (cols: string) => {
                h.selects.push(cols);
                return { eq: () => ({ maybeSingle: async () => h.respuestas.shift() ?? { data: null, error: null } }) };
            },
        }),
    },
}));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./avisos-correo.service', () => ({ destinatariosDeEscuela: vi.fn(), enviarConReserva: vi.fn() }));

import {
    textosDeClase, textosClaseDeEscuela, limpiarCacheTextosClase, presentacionDeClase, ofertaDeReserva, fraseDeValor,
    reglaDeClaseParaPrompt, formatoPesos, TEXTOS_POR_DEFECTO, TTL_TEXTOS_MS,
} from './textos-clase-prueba';
import { lineasQueLlevar, QUE_LLEVAR } from './whatsapp-clase-cortesia.service';

const MONSTER = textosDeClase({ nombre_clase: 'prueba', trial_price: 15000 });
const NO_GRATIS = /gratis|cortes[ií]a/i;

describe('golden: sin ajustes, los literales de siempre', () => {
    it('textos por defecto', () => {
        expect(TEXTOS_POR_DEFECTO).toEqual({
            tipo: 'cortesia', nombre: 'clase de cortesía', nombreInicial: 'Clase de cortesía', gratis: true, precio: null,
        });
        expect(textosDeClase({ nombre_clase: null, trial_price: null })).toEqual(TEXTOS_POR_DEFECTO);
        expect(textosDeClase({ nombre_clase: 'cortesia', trial_price: 0 })).toEqual(TEXTOS_POR_DEFECTO);
        expect(textosDeClase(null)).toEqual(TEXTOS_POR_DEFECTO);
    });

    it('frases de whatsapp-clase-cortesia (:1001, :1106, :731, :733 del 2026-10-29)', () => {
        expect(presentacionDeClase()).toBe('¡Claro! 🙌 La *clase de cortesía* es *gratis* y sirve para conocer la escuela.');
        expect(ofertaDeReserva()).toBe('¿Te reservo una *clase de cortesía* gratis?');
        expect(lineasQueLlevar('Ropa de entrenamiento.'))
            .toBe('🎒 Ropa de entrenamiento.\n⏰ Llega 10 minutos antes. La clase es *gratis*.\n\n');
        expect(lineasQueLlevar(null)).toBe(`🎒 Qué llevar: ${QUE_LLEVAR}.\n` +
            '⏰ Llega 10 minutos antes y dile al entrenador que vienes a la clase de cortesía. Es *gratis*.\n\n');
        expect(lineasQueLlevar('  ', TEXTOS_POR_DEFECTO)).toBe(lineasQueLlevar(null));
        expect(reglaDeClaseParaPrompt()).toBe('');
    });
});

describe('Monster: clase de prueba de $15.000', () => {
    it('nombre, valor y nunca gratis', () => {
        expect(MONSTER).toEqual({ tipo: 'prueba', nombre: 'clase de prueba', nombreInicial: 'Clase de prueba', gratis: false, precio: '$15.000' });
        expect(presentacionDeClase(MONSTER)).toBe('¡Claro! 🙌 La *clase de prueba* tiene un valor de *$15.000* y sirve para conocer la escuela.');
        expect(ofertaDeReserva(MONSTER)).toBe('¿Te reservo una *clase de prueba* (*$15.000*)?');
        expect(fraseDeValor(MONSTER, 'la_clase')).toBe('La clase tiene un valor de *$15.000*.');
        expect(fraseDeValor(MONSTER, 'es')).toBe('Tiene un valor de *$15.000*.');
        for (const t of [presentacionDeClase(MONSTER), ofertaDeReserva(MONSTER), fraseDeValor(MONSTER), fraseDeValor(MONSTER, 'es'),
            lineasQueLlevar('Camiseta negra, pantaloneta, medias y tenis.', MONSTER), lineasQueLlevar(null, MONSTER)]) {
            expect(t, t).not.toMatch(NO_GRATIS);
        }
        expect(lineasQueLlevar(null, MONSTER)).toContain('que vienes a la clase de prueba. Tiene un valor de *$15.000*.');
    });

    it('con valor, aunque la escuela la llame «cortesía», se llama clase de prueba', () => {
        const t = textosDeClase({ nombre_clase: 'cortesia', trial_price: '20000' });
        expect(t).toMatchObject({ tipo: 'prueba', nombre: 'clase de prueba', gratis: false, precio: '$20.000' });
    });

    it('«prueba» sin valor: clase de prueba gratis', () => {
        const t = textosDeClase({ nombre_clase: 'prueba', trial_price: null });
        expect(t).toMatchObject({ nombre: 'clase de prueba', gratis: true, precio: null });
        expect(presentacionDeClase(t)).toBe('¡Claro! 🙌 La *clase de prueba* es *gratis* y sirve para conocer la escuela.');
        expect(reglaDeClaseParaPrompt(t)).toBe('Llámala siempre «clase de prueba», nunca «clase de cortesía».');
    });

    it('la regla del prompt prohíbe «gratis» y «cortesía» y dice el valor', () => {
        expect(reglaDeClaseParaPrompt(MONSTER)).toBe(
            'La clase de prueba tiene un valor de *$15.000*: nunca digas que es gratis ni la llames «clase de cortesía».');
    });

    it('formatoPesos', () => {
        expect(formatoPesos(15000)).toBe('$15.000');
        expect(formatoPesos(1250000)).toBe('$1.250.000');
        expect(formatoPesos(900)).toBe('$900');
    });
});

describe('textosClaseDeEscuela (lectura, cacheada, nunca lanza)', () => {
    beforeEach(() => {
        limpiarCacheTextosClase();
        h.respuestas = [];
        h.selects = [];
    });

    it('lee nombre_clase y trial_price', async () => {
        h.respuestas = [{ data: { nombre_clase: 'prueba', trial_price: 15000 }, error: null }];
        expect(await textosClaseDeEscuela('monster')).toEqual(MONSTER);
        expect(h.selects).toEqual(['nombre_clase, trial_price']);
    });

    it('sin la migración M1 (nombre_clase no existe): solo trial_price', async () => {
        h.respuestas = [
            { data: null, error: { code: '42703', message: 'column school_trial_class_settings.nombre_clase does not exist' } },
            { data: { trial_price: 15000 }, error: null },
        ];
        expect(await textosClaseDeEscuela('s1')).toMatchObject({ gratis: false, precio: '$15.000', nombre: 'clase de prueba' });
        expect(h.selects).toEqual(['nombre_clase, trial_price', 'trial_price']);
    });

    it('sin fila o con error: los de siempre; el error no se guarda en caché', async () => {
        expect(await textosClaseDeEscuela('sin-fila')).toEqual(TEXTOS_POR_DEFECTO);
        h.respuestas = [{ data: null, error: { code: '57014', message: 'timeout' } }];
        expect(await textosClaseDeEscuela('con-error')).toEqual(TEXTOS_POR_DEFECTO);
        h.respuestas = [{ data: { trial_price: 15000 }, error: null }];
        expect((await textosClaseDeEscuela('con-error')).gratis).toBe(false);
    });

    it('cacheada 10 min por escuela', async () => {
        h.respuestas = [{ data: { trial_price: 15000 }, error: null }];
        await textosClaseDeEscuela('s1', 0);
        expect((await textosClaseDeEscuela('s1', TTL_TEXTOS_MS - 1)).precio).toBe('$15.000');
        expect(h.selects).toHaveLength(1);
        expect(await textosClaseDeEscuela('s1', TTL_TEXTOS_MS + 1)).toEqual(TEXTOS_POR_DEFECTO);
        expect(h.selects).toHaveLength(2);
    });
});
