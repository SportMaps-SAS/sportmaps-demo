/**
 * Clínica, campamento y vacacional son cosas distintas (Monster, 2026-11-11: «vacacional y torneo son cosas
 * diferentes a la clínica»). Una palabra de evento sola es una consulta; «vacacional» explícito se respeta aunque
 * haya una fecha de la clínica; un torneo nombrado de pasada no desvía; y «campamento» solo es ambiguo.
 */
import { describe, expect, it } from 'vitest';
import { decidirDestino, inferirServicio, necesitaCatalogo, type ItemConFicha } from './whatsapp-anuncio-destino';
import { pideOQuiereServicio } from './whatsapp-venta-servicios.service';

const CLINICA: ItemConFicha = {
    id: 'srv-clinica', name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000, active: true,
    event_id: null, starts_at: '2026-11-21T13:00:00Z', ends_at: '2026-11-22T22:00:00Z', description: 'Clínica. 21 y 22 de noviembre.',
};
const VACACIONAL: ItemConFicha = {
    id: 'srv-vac', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional', price: 100000, active: true, event_id: null,
    starts_at: '2026-11-17T13:00:00Z', ends_at: '2026-12-10T22:00:00Z', description: 'Vacacional.',
};
const PERFECCIONAMIENTO: ItemConFicha = {
    id: 'srv-perf', name: 'Clase de perfeccionamiento', kind: 'clase_extra', price: 25000, active: true, event_id: null,
    starts_at: null, ends_at: null, description: 'Técnica individual.',
};
const CATALOGO = [PERFECCIONAMIENTO, VACACIONAL, CLINICA];

describe('A. el nombre del evento solo (o con registro) es una consulta de servicio', () => {
    it('pideOQuiereServicio', () => {
        for (const t of ['Vacacional', 'el vacacional', 'Clínica', 'campamento', 'Vacacionales',
            'registro para el vacacional del 17 de nov al 10 de dic', 'quiero la inscripción a la clínica', 'matrícula del campamento']) {
            expect(pideOQuiereServicio(t), t).toBe(true);
        }
    });

    it('no abre con frases que ya pagaron o mandan comprobante, ni con charla sin evento', () => {
        for (const t of ['ya pagué el vacacional', 'te envío el comprobante de la clínica', 'pagué la clínica',
            'hola', 'registro del niño', 'torneo', 'el torneo']) {
            expect(pideOQuiereServicio(t), t).toBe(false);
        }
    });

    it('«Vacacional» solo → el Vacacional (ficha), no el embudo de la clase de prueba', () => {
        expect(necesitaCatalogo({ referral: null, mapeo: null, texto: 'Vacacional', eleccion: null })).toBe(true);
        expect(decidirDestino({ referral: null, mapeo: null, texto: 'Vacacional', items: CATALOGO }))
            .toMatchObject({ destino: 'servicio', item: { id: 'srv-vac' } });
    });

    it('«Clínica» sola → la clínica', () => {
        expect(decidirDestino({ referral: null, mapeo: null, texto: 'Clínica', items: CATALOGO }))
            .toMatchObject({ destino: 'servicio', item: { id: 'srv-clinica' } });
    });

    it('«registro para el vacacional del 17 de nov al 10 de dic» → el Vacacional', () => {
        expect(decidirDestino({ referral: null, mapeo: null, texto: 'registro para el vacacional del 17 de nov al 10 de dic', items: CATALOGO }))
            .toMatchObject({ destino: 'servicio', item: { id: 'srv-vac' } });
    });

    it('«torneo» solo no es consulta (no hay ítem de torneo: no se pasa a una persona por una palabra)', () => {
        expect(decidirDestino({ referral: null, mapeo: null, texto: 'torneo', items: CATALOGO })).toBeNull();
    });
});

describe('B. inferirServicio', () => {
    it('1. «vacacional» explícito se respeta aunque la fecha sea la de la clínica', () => {
        expect(inferirServicio(['el vacacional del 21 de noviembre'], CATALOGO)).toEqual({ tipo: 'uno', item: VACACIONAL });
    });

    it('1. con «campamento» la fecha sigue mandando (la clínica)', () => {
        expect(inferirServicio(['el campamento del 21 de noviembre'], CATALOGO)).toEqual({ tipo: 'uno', item: CLINICA });
    });

    it('2. un torneo nombrado de pasada (sin servicio en el catálogo) no desvía: campamento del 21 y 22 → clínica', () => {
        const t = 'el campamento del 21 y 22, pero el 22 estará en un torneo';
        expect(inferirServicio([t], CATALOGO)).toEqual({ tipo: 'uno', item: CLINICA });
    });

    it('2. un torneo solo, sin servicio de torneo, sigue siendo evento sin servicio', () => {
        expect(inferirServicio(['info del torneo'], CATALOGO)).toEqual({ tipo: 'evento_sin_servicio', evento: 'torneo' });
    });

    it('3. «campamento» solo, sin fecha ni nombre → varios (clínica y vacacional)', () => {
        const r = inferirServicio(['info del campamento'], CATALOGO);
        expect(r.tipo).toBe('varios');
        if (r.tipo === 'varios') expect(r.items.map((i) => i.id).sort()).toEqual(['srv-clinica', 'srv-vac']);
    });

    it('3. «campamento» con un solo servicio que calza → ese; sin ninguno → evento sin servicio', () => {
        expect(inferirServicio(['info del campamento'], [PERFECCIONAMIENTO, VACACIONAL])).toEqual({ tipo: 'uno', item: VACACIONAL });
        expect(inferirServicio(['info del campamento'], [PERFECCIONAMIENTO])).toEqual({ tipo: 'evento_sin_servicio', evento: 'campamento' });
    });

    it('4. «evento para armadoras» sigue siendo la clínica (por nombre)', () => {
        expect(inferirServicio(['cuanto cuesta el evento para armadoras?'], CATALOGO)).toEqual({ tipo: 'uno', item: CLINICA });
    });
});
