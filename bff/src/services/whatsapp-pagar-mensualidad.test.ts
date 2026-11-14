/**
 * «Quiero pagar una mensualidad» de quien el teléfono no reconoce (Monster 2026-11-05).
 * Reglas puras: datos de ejemplo.
 */
import { describe, it, expect } from 'vitest';
import {
    quierePagarMensualidad, leerRespuestaAclaracion, textoInscribirmeTrasPago, textoAclaracionDePago,
    BOTONES_PAGO_MENSUALIDAD, BOTON_PAGO_MENSUALIDAD, preguntaPorAfiliacionHipotetica, precioGeneralMostrado,
    textoAfiliadoSinReconocer,
} from './whatsapp-pagar-mensualidad';

describe('quierePagarMensualidad', () => {
    it.each([
        'Para pagar una mensualidad',
        'Quiero pagar la mensualidad',
        'voy a pagar la mensualidad',
        'Quiero cancelar la mensualidad',
        'necesito pagar la cuota de este mes, la mensualidad',
        'Hola, voy a pagar mensualidad de mi hija',
    ])('«%s» = quiere pagar', (t) => expect(quierePagarMensualidad(t)).toBe(true));

    it.each([
        '¿Cuánto es la mensualidad?',
        'cuánto vale la mensualidad',
        'precio de la mensualidad para pagar',
        'Ya pagué la mensualidad',
        '¿Cómo pago la mensualidad?',
        'En qué horario se puede ir a cancelar la mensualidad',
        '¿Dónde puedo pagar la mensualidad?',
        'no quiero pagar la mensualidad',
        'quiero pausar la mensualidad',
        'Y si soy afiliado?',
        'mama.prueba@correo.com pagar mensualidad',
        'Hola',
        '',
    ])('«%s» NO es «quiero pagar»', (t) => expect(quierePagarMensualidad(t)).toBe(false));
});

describe('la aclaración', () => {
    it('dos botones con título ≤ 20 caracteres y ids propios', () => {
        expect(BOTONES_PAGO_MENSUALIDAD.map((b) => b.id)).toEqual([BOTON_PAGO_MENSUALIDAD.CLUB, BOTON_PAGO_MENSUALIDAD.INSCRIBIRME]);
        for (const b of BOTONES_PAGO_MENSUALIDAD) expect(b.title.length).toBeLessThanOrEqual(20);
        expect(textoAclaracionDePago()).not.toMatch(/bienvenid/i);
    });

    it('lee el botón o su título escrito, no una frase suelta', () => {
        expect(leerRespuestaAclaracion('x', BOTON_PAGO_MENSUALIDAD.CLUB)).toBe('club');
        expect(leerRespuestaAclaracion('x', BOTON_PAGO_MENSUALIDAD.INSCRIBIRME)).toBe('inscribirme');
        expect(leerRespuestaAclaracion('Soy del club y pago')).toBe('club');
        expect(leerRespuestaAclaracion('Quiero inscribirme')).toBe('inscribirme');
        expect(leerRespuestaAclaracion('quiero inscribirme a la clínica de noviembre')).toBeNull();
        expect(leerRespuestaAclaracion('Para pagar una mensualidad')).toBeNull();
    });

    it('«quiero inscribirme»: la clase primero, la mensualidad después, nunca «gratis»', () => {
        const t = textoInscribirmeTrasPago({ valores: '• Mensualidad: *$120.000*', nombreClase: 'clase de prueba' });
        expect(t).toMatch(/primero se hace la \*clase de prueba\*/);
        expect(t).toMatch(/pagas la mensualidad/);
        expect(t).toContain('$120.000');
        expect(t).not.toMatch(/gratis/i);
        expect(textoInscribirmeTrasPago({ valores: null, nombreClase: 'clase de prueba' })).not.toContain('valores de la escuela');
    });
});

describe('«¿y si soy afiliado?» de quien no está reconocido', () => {
    it.each(['Y si soy afiliado?', 'y si ya soy del club cuánto sería', 'soy afiliado, ¿tiene descuento?', 'precio para afiliados?'])(
        '«%s» es hipótesis', (t) => expect(preguntaPorAfiliacionHipotetica(t)).toBe(true));
    it.each(['Hola', '¿Cuánto vale la clínica?', 'quiero inscribirme', 'Para pagar una mensualidad'])(
        '«%s» no lo es', (t) => expect(preguntaPorAfiliacionHipotetica(t)).toBe(false));

    it('la respuesta no trae la cifra de afiliado y sí el valor general mostrado', () => {
        const general = precioGeneralMostrado([
            { direction: 'inbound' },
            { direction: 'outbound', payload: { afiliado: true, precio_hoy: 250000 } },
            { direction: 'outbound', payload: { precio_hoy: 300000 } },
        ]);
        expect(general).toBe(300000);
        const t = textoAfiliadoSinReconocer({ general });
        expect(t).toContain('$300.000');
        expect(t).not.toContain('250.000');
        expect(t).toMatch(/la escuela verifica/);
        expect(textoAfiliadoSinReconocer({ general: null })).not.toMatch(/\$/);
    });
});
