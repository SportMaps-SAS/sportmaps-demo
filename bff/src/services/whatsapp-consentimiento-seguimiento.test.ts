/**
 * Consentimiento de seguimiento desde la primera respuesta del bot (Monster 2026-11-12, aprobado por Iván).
 */
import { describe, it, expect } from 'vitest';
import {
    consentSeguimientoHabilitado, esBotonConsentSeguimiento, textoConsentSeguimiento, textoRespuestaConsentSeguimiento,
    BOTONES_CONSENT_SEGUIMIENTO, BOTON_CONSENT_SEGUIMIENTO,
} from './whatsapp-consentimiento-seguimiento';

describe('consentSeguimientoHabilitado', () => {
    it('apagado por defecto y solo para las escuelas listadas', () => {
        expect(consentSeguimientoHabilitado('s1', undefined)).toBe(false);
        expect(consentSeguimientoHabilitado('s1', '')).toBe(false);
        expect(consentSeguimientoHabilitado('s1', 'a, s1')).toBe(true);
        expect(consentSeguimientoHabilitado('s2', 'a, s1')).toBe(false);
        expect(consentSeguimientoHabilitado('', 's1')).toBe(false);
    });
});

describe('botones y textos', () => {
    it('dos botones con título de hasta 20 caracteres (límite de Meta)', () => {
        expect(BOTONES_CONSENT_SEGUIMIENTO).toHaveLength(2);
        for (const b of BOTONES_CONSENT_SEGUIMIENTO) expect(b.title.length).toBeLessThanOrEqual(20);
        expect(BOTONES_CONSENT_SEGUIMIENTO.map((b) => b.id)).toEqual([BOTON_CONSENT_SEGUIMIENTO.SI, BOTON_CONSENT_SEGUIMIENTO.NO]);
    });
    it('reconoce solo sus botones', () => {
        expect(esBotonConsentSeguimiento('cs_si')).toBe(true);
        expect(esBotonConsentSeguimiento('cs_no')).toBe(true);
        expect(esBotonConsentSeguimiento('sm_cc_1')).toBe(false);
        expect(esBotonConsentSeguimiento(null)).toBe(false);
        expect(esBotonConsentSeguimiento(undefined)).toBe(false);
    });
    it('la pregunta nombra a la escuela, ofrece dejar de recibir y no lleva precios ni datos de pago', () => {
        const t = textoConsentSeguimiento('Monster´s Volley Club');
        expect(t).toContain('Monster´s Volley Club');
        expect(t).toContain('dejar de recibir');
        expect(t).not.toMatch(/\$|nequi|daviplata|cuenta|precio/i);
        expect(t.length).toBeLessThan(400);
    });
    it('sin nombre de escuela usa «la escuela»', () => {
        expect(textoConsentSeguimiento(null)).toContain('la escuela');
        expect(textoConsentSeguimiento('  ')).toContain('la escuela');
    });
    it('la respuesta distingue sí de no y no promete lo que no hará', () => {
        expect(textoRespuestaConsentSeguimiento(true)).toContain('Gracias');
        expect(textoRespuestaConsentSeguimiento(false)).toContain('no te escribiremos');
    });
});
