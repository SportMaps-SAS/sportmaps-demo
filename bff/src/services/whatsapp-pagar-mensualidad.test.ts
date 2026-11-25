/**
 * «Quiero pagar una mensualidad» de quien el teléfono no reconoce (Monster 2026-11-05).
 * Reglas puras: datos de ejemplo.
 */
import { describe, it, expect } from 'vitest';
import {
    quierePagarMensualidad, leerRespuestaAclaracion, textoInscribirmeTrasPago, textoAclaracionDePago,
    BOTONES_PAGO_MENSUALIDAD, BOTON_PAGO_MENSUALIDAD, preguntaPorAfiliacionHipotetica, precioGeneralMostrado,
    textoAfiliadoSinReconocer, TEXTO_SIN_OFERTAS_PARA_NUEVOS,
} from './whatsapp-pagar-mensualidad';
import { armarEstado, type FilasCrudas } from './bot-ofertas.service';

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

describe('«quiero inscribirme» cuando HOY no hay clase de prueba (Monster 2026-11-25: dic–ene, convocatorias)', () => {
    const ESC = 'esc-1';
    const AHORA = new Date('2026-12-02T15:00:00Z').getTime(); // 2-dic, 10:00 en Bogotá
    const filas = (extra: Partial<FilasCrudas> = {}): FilasCrudas => ({
        ofertas: [], sesiones: [], bloqueos: [], ajustesClasePrueba: null, mensajeSinOfertas: null, ...extra,
    });
    const BLOQUEO = { tipo: 'clase_prueba', desde: '2026-12-01', hasta: '2027-01-31', motivo: 'vacaciones' };
    const CONVOCATORIA = {
        id: 'of-1', tipo: 'convocatoria', titulo: 'Convocatoria femenina', estado: 'activa', prioridad: 1,
        requiere_inscripcion: true, requiere_pago: false, cta: 'Para inscribirte, escríbenos el nombre y el año de nacimiento.',
    };
    const SESION = { id: 's-1', oferta_id: 'of-1', fecha: '2026-12-05', hora_inicio: '09:00:00', hora_fin: '11:00:00', lugar: 'Coliseo Inventado', genero: 'femenino' };
    const SIN_CLASE = /clase de prueba|primero se hace|\$15\.000|valores de la escuela|mensualidad/i;

    it('con la clase disponible: el texto de siempre', () => {
        const ofertas = armarEstado(ESC, filas(), AHORA);
        expect(ofertas.claseDePrueba.disponible).toBe(true);
        expect(textoInscribirmeTrasPago({ valores: null, nombreClase: 'clase de prueba', ofertas }))
            .toBe(textoInscribirmeTrasPago({ valores: null, nombreClase: 'clase de prueba' }));
    });

    it('bloqueada y con una convocatoria vigente: la convocatoria (fechas, lugar y cómo inscribirse), sin nombrar la clase ni la lista de precios', () => {
        const ofertas = armarEstado(ESC, filas({ bloqueos: [BLOQUEO], ofertas: [CONVOCATORIA], sesiones: [SESION] }), AHORA);
        const t = textoInscribirmeTrasPago({ valores: '• Clase de prueba: *$15.000*\n• Mensualidad: *$120.000*', nombreClase: 'clase de prueba', ofertas });
        expect(t).toContain('*Convocatoria femenina*');
        expect(t).toContain('sábado 5 de diciembre');
        expect(t).toContain('Coliseo Inventado');
        expect(t).toContain(CONVOCATORIA.cta);
        expect(t).not.toMatch(SIN_CLASE);
    });

    it('apagada y sin ofertas: el mensaje que dejó la escuela; sin él, el neutro', () => {
        const apagada = { ajustesClasePrueba: { enabled: true, whatsapp_enabled: false } };
        const conMensaje = armarEstado(ESC, filas({ ...apagada, mensajeSinOfertas: 'En enero abrimos convocatorias nuevas.' }), AHORA);
        expect(textoInscribirmeTrasPago({ valores: null, nombreClase: 'clase de prueba', ofertas: conMensaje }))
            .toContain('En enero abrimos convocatorias nuevas.');
        const sinNada = armarEstado(ESC, filas(apagada), AHORA);
        const t = textoInscribirmeTrasPago({ valores: '• Mensualidad: *$120.000*', nombreClase: 'clase de prueba', ofertas: sinNada });
        expect(t).toContain(TEXTO_SIN_OFERTAS_PARA_NUEVOS);
        expect(t).not.toMatch(SIN_CLASE);
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
