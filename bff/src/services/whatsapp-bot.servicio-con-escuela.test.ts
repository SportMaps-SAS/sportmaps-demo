/**
 * Excepción a P4 (Monster, 2026-11-11): quien pide un servicio del catálogo recibe la ficha aunque la escuela haya
 * escrito hace poco. La regla de «cuándo» es pura y se prueba acá; que la consulta sea clara la decide el destino por
 * texto (whatsapp-anuncio-destino, con sus propias pruebas).
 */
import { describe, expect, it } from 'vitest';
import { puedeResponderServicioConEscuela } from './whatsapp-bot.service';
import { decidirDestino, type ItemConFicha } from './whatsapp-anuncio-destino';

const CLINICA = { id: 'srv-clinica', name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000, active: true, event_id: null, starts_at: '2026-11-21T05:00:00Z', ends_at: '2026-11-23T04:59:00Z', description: 'Clínica.' } as unknown as ItemConFicha;
const VAC = { id: 'srv-vac', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional', price: 100000, active: true, event_id: null, starts_at: '2026-11-17T05:00:00Z', ends_at: '2026-12-11T04:59:00Z', description: 'Vacacional.' } as unknown as ItemConFicha;

describe('puedeResponderServicioConEscuela', () => {
    it('con texto, sin botón y sin modo discreto: sí', () => {
        expect(puedeResponderServicioConEscuela({ discreto: false, texto: 'quiero inscribir a mi hijo para el vacacional', botonId: null })).toBe(true);
    });
    it('modo discreto: no (la escuela pidió que el bot calle)', () => {
        expect(puedeResponderServicioConEscuela({ discreto: true, texto: 'vacacional', botonId: null })).toBe(false);
    });
    it('con botón o sin texto: no', () => {
        expect(puedeResponderServicioConEscuela({ discreto: false, texto: 'hola', botonId: 'vs:abc:detalle' })).toBe(false);
        expect(puedeResponderServicioConEscuela({ discreto: false, texto: '   ', botonId: null })).toBe(false);
    });
    it('el interruptor WHATSAPP_RESPONDER_SERVICIO_CON_ESCUELA=0 lo apaga', () => {
        expect(puedeResponderServicioConEscuela({ discreto: false, texto: 'vacacional', botonId: null, interruptor: '0' })).toBe(false);
        expect(puedeResponderServicioConEscuela({ discreto: false, texto: 'vacacional', botonId: null, interruptor: '1' })).toBe(true);
    });
});

describe('el caso real de las 3:19 pm', () => {
    it('«Hola, quiero inscribir a mi hijo para el vacacional» es una consulta clara del Vacacional', () => {
        const d = decidirDestino({ referral: null, mapeo: null, texto: 'Hola, quiero inscribir a mi hijo para el vacacional', items: [CLINICA, VAC] });
        expect(d).toMatchObject({ destino: 'servicio', item: { id: 'srv-vac' } });
    });
    it('un saludo o «Holaaaa» NO es una consulta de servicio: el silencio de P4 sigue', () => {
        expect(decidirDestino({ referral: null, mapeo: null, texto: 'Holaaaa', items: [CLINICA, VAC] })).toBeNull();
        expect(decidirDestino({ referral: null, mapeo: null, texto: 'Hola cómo estás', items: [CLINICA, VAC] })).toBeNull();
    });
});
