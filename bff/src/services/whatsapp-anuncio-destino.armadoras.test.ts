/**
 * La clínica sin decir «clínica» (Monster, 2026-11-11): una mamá escribió «estoy interesada en que mi hija
 * participe en el evento para armadoras, pero solo podría asistir el 21 de noviembre… ¿cuánto cuesta?» y el bot
 * le contestó la bienvenida genérica con la pregunta de la sede, sin precio. El reconocimiento exigía las
 * palabras «clínica / campamento / vacacional / torneo». Ahora también reconoce el servicio por las palabras
 * distintivas de su NOMBRE («armadoras» = «armadores»).
 */
import { describe, expect, it } from 'vitest';
import {
    decidirDestino, inferirServicio, necesitaCatalogo, suenaAServicio, type ItemConFicha,
} from './whatsapp-anuncio-destino';

const CLINICA: ItemConFicha = {
    id: 'srv-clinica', name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000, active: true,
    event_id: null, starts_at: '2026-11-21T05:00:00Z', ends_at: '2026-11-23T04:59:00Z',
    allow_installments: true, precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    abono_minimo_pct: 50, opciones: null, description: 'Clínica con Jorge Mesa. 21 y 22 de noviembre.', image_url: null,
};
const PERFECCIONAMIENTO: ItemConFicha = {
    id: 'srv-perf', name: 'Clase de perfeccionamiento', kind: 'clase_extra', price: 25000, active: true, event_id: null,
    starts_at: null, ends_at: null, description: 'Técnica individual.',
};
const VACACIONAL: ItemConFicha = {
    id: 'srv-vac', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional', price: 100000, active: true, event_id: null,
    starts_at: null, ends_at: null, description: null,
};

const MAMA = 'Buen día, estoy interesada en que me hija participe en el evento para armadoras, pero sólo podría asistir '
    + 'el 21 de noviembre, debido a que el 22 estará en un torneo. Por favor me indican si fuera posible su participación '
    + 'solo un día? Y cuánto cuesta ?';

describe('la clínica sin decir «clínica»', () => {
    it('el mensaje de la mamá («evento para armadoras») es la clínica', () => {
        expect(inferirServicio([MAMA], [PERFECCIONAMIENTO, VACACIONAL, CLINICA])).toEqual({ tipo: 'uno', item: CLINICA });
    });

    it('«armadores», «armadora» y «armador» valen igual', () => {
        for (const t of ['info del evento de armadores', 'cuanto cuesta para una armadora?', 'hay cupo para armador?']) {
            expect(inferirServicio([t], [CLINICA])).toEqual({ tipo: 'uno', item: CLINICA });
        }
    });

    it('la palabra «atacantes» sola no basta (la tienen muchas clases)', () => {
        expect(inferirServicio(['quiero entrenar como atacante'], [CLINICA])).toEqual({ tipo: 'sin_evento' });
    });

    it('sin nombre del servicio sigue sin inferir nada (no inventa)', () => {
        expect(inferirServicio(['Entrena con nosotros'], [CLINICA])).toEqual({ tipo: 'sin_evento' });
        expect(inferirServicio(['cuanto cuesta el evento del 21 de noviembre?'], [PERFECCIONAMIENTO, VACACIONAL])).toEqual({ tipo: 'sin_evento' });
    });

    it('con la palabra «clínica» todo sigue igual que antes', () => {
        expect(inferirServicio(['info de la clínica'], [PERFECCIONAMIENTO, CLINICA])).toEqual({ tipo: 'uno', item: CLINICA });
        expect(inferirServicio(['vacacional de diciembre'], [CLINICA])).toEqual({ tipo: 'evento_sin_servicio', evento: 'vacacional' });
    });

    it('suenaAServicio: «evento» o una fecha abren la lectura del catálogo; una frase cualquiera no', () => {
        expect(suenaAServicio(MAMA)).toBe(true);
        expect(suenaAServicio('hola, cuanto cuesta el 21 de noviembre?')).toBe(true);
        expect(suenaAServicio('hola, ¿qué horarios tienen?')).toBe(false);
    });

    it('necesitaCatalogo: sin anuncio, el mensaje de la mamá sí lee el catálogo; un saludo no', () => {
        expect(necesitaCatalogo({ referral: null, mapeo: null, texto: MAMA, eleccion: null })).toBe(true);
        expect(necesitaCatalogo({ referral: null, mapeo: null, texto: 'hola, ¿qué horarios tienen?', eleccion: null })).toBe(false);
    });

    it('decidirDestino: el mensaje de la mamá va al servicio (ficha con precio), no a la bienvenida', () => {
        const d = decidirDestino({ referral: null, mapeo: null, texto: MAMA, items: [PERFECCIONAMIENTO, VACACIONAL, CLINICA] });
        expect(d).toMatchObject({ destino: 'servicio', origen: 'texto', item: { id: 'srv-clinica' } });
    });

    it('decidirDestino: un mensaje sin servicio sigue su camino de siempre (null)', () => {
        expect(decidirDestino({ referral: null, mapeo: null, texto: 'hola, ¿qué horarios tienen?', items: [CLINICA] })).toBeNull();
    });
});
