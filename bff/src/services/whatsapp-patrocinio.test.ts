/**
 * Patrocinio y alianzas de marca (Monster, 2026-11-11): una empresa no es un participante.
 */
import { describe, expect, it } from 'vitest';
import { esConsultaDePatrocinio, textoDePatrocinio } from './whatsapp-patrocinio';
import { decidirDestino, type ItemConFicha } from './whatsapp-anuncio-destino';

const CLINICA = { id: 'srv-clinica', name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000, active: true, event_id: null, starts_at: '2026-11-21T05:00:00Z', ends_at: '2026-11-23T04:59:00Z', description: 'Clínica.' } as unknown as ItemConFicha;

describe('esConsultaDePatrocinio', () => {
    it.each([
        'MARCA',
        'marca',
        'Quiero patrocinar la clínica',
        'Me interesa que mi marca esté presente en la clínica',
        'Buenas, somos una empresa y queremos una alianza con ustedes',
        '¿Cuánto cuesta ser aliado?',
        'Tengo un emprendimiento y quiero hacer publicidad en el evento',
        'Cómo puede nuestra empresa ser parte del evento',
        'información de patrocinios, por favor',
    ])('sí: %s', (t) => expect(esConsultaDePatrocinio(t)).toBe(true));

    it.each([
        'Cuánto cuesta la clínica para mi hijo',
        'Hola, quiero inscribir a mi hijo para el vacacional',
        'evento para armadoras el 21 de noviembre, ¿cuánto cuesta?',
        'de qué marca es la camiseta del club?',
        'cuánto vale la mensualidad',
        'Hola',
        '',
    ])('no: %s', (t) => expect(esConsultaDePatrocinio(t)).toBe(false));

    it('null y undefined no lanzan', () => {
        expect(esConsultaDePatrocinio(null)).toBe(false);
        expect(esConsultaDePatrocinio(undefined)).toBe(false);
    });
});

describe('el destino por texto no le da la ficha de inscripción a una empresa', () => {
    it('«quiero patrocinar la clínica… ¿cuánto cuesta ser aliado?» → null (a una persona), no la ficha', () => {
        expect(decidirDestino({ referral: null, mapeo: null, texto: 'Hola, quiero patrocinar la clínica de armadores. ¿Cuánto cuesta ser aliado?', items: [CLINICA] })).toBeNull();
    });
    it('«me interesa que mi marca esté presente en la clínica» → null', () => {
        expect(decidirDestino({ referral: null, mapeo: null, texto: 'Me interesa que mi marca esté presente en la clínica', items: [CLINICA] })).toBeNull();
    });
    it('un participante que pregunta el precio sigue recibiendo la ficha', () => {
        expect(decidirDestino({ referral: null, mapeo: null, texto: 'Cuánto cuesta la clínica para mi hijo', items: [CLINICA] }))
            .toMatchObject({ destino: 'servicio', item: { id: 'srv-clinica' } });
    });
});

describe('textoDePatrocinio', () => {
    it('agradece, avisa que una persona escribe, y no trae precios ni datos de pago', () => {
        const t = textoDePatrocinio('Monster´s Volley Club');
        expect(t).toContain('Monster´s Volley Club');
        expect(t).toContain('persona encargada de alianzas');
        expect(t).not.toMatch(/\$|nequi|daviplata|cuenta|precio/i);
    });
    it('sin nombre de escuela usa «nuestro club»', () => {
        expect(textoDePatrocinio(null)).toContain('nuestro club');
    });
});
