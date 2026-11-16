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

// ─── Novedades y promociones para prospectos (2026-11-15) ───────────────────
import {
    consentNovedadesEncendido, esBotonConsentNovedades, textoConsentNovedades, textoRespuestaConsentNovedades,
    turnoPermiteConsentNovedades, yaDecidioNovedades, respuestaEscritaDeNovedades, preguntaDeNovedadesAbierta,
    hayFlujoAbiertoEn, BOTONES_CONSENT_NOVEDADES, BOTON_CONSENT_NOVEDADES, PASO_CONSENT_NOVEDADES,
    PASOS_QUE_YA_PREGUNTARON_NOVEDADES, PASO_CONSENT_SEGUIMIENTO,
} from './whatsapp-consentimiento-seguimiento';
import { PASO_EMBUDO } from './whatsapp-embudo-prospecto';

describe('consentimiento de novedades: interruptor', () => {
    it('encendido por defecto; se apaga con false / 0 / off / no', () => {
        expect(consentNovedadesEncendido(undefined)).toBe(true);
        expect(consentNovedadesEncendido('')).toBe(true);
        expect(consentNovedadesEncendido('true')).toBe(true);
        for (const v of ['false', 'FALSE', ' 0 ', 'off', 'no']) expect(consentNovedadesEncendido(v)).toBe(false);
    });
});

describe('consentimiento de novedades: textos y botones', () => {
    it('la pregunta nombra a la escuela, dice que puede decir que no y no lleva precios', () => {
        const t = textoConsentNovedades('Monster´s Volley Club');
        expect(t).toBe('¿Quieres que te contemos por aquí las novedades y promociones de *Monster´s Volley Club*? '
            + 'Puedes decir que no y te seguimos atendiendo igual.');
        expect(t).not.toMatch(/\$|nequi|daviplata|precio/i);
        expect(textoConsentNovedades(' ')).toContain('la escuela');
    });
    it('dos botones propios, de hasta 20 caracteres', () => {
        expect(BOTONES_CONSENT_NOVEDADES.map((b) => b.title)).toEqual(['Sí, cuéntenme', 'No, gracias']);
        for (const b of BOTONES_CONSENT_NOVEDADES) expect(b.title.length).toBeLessThanOrEqual(20);
        expect(esBotonConsentNovedades(BOTON_CONSENT_NOVEDADES.SI)).toBe(true);
        expect(esBotonConsentNovedades(BOTON_CONSENT_NOVEDADES.NO)).toBe(true);
        // No se confunden con los del seguimiento ni con otros.
        expect(esBotonConsentNovedades('cs_si')).toBe(false);
        expect(esBotonConsentSeguimiento(BOTON_CONSENT_NOVEDADES.SI)).toBe(false);
        expect(esBotonConsentNovedades(null)).toBe(false);
    });
    it('el «no» no promete silencio: se le sigue atendiendo', () => {
        expect(textoRespuestaConsentNovedades(false)).toContain('te seguimos atendiendo');
        expect(textoRespuestaConsentNovedades(false)).not.toMatch(/baja|no volver/i);
        expect(textoRespuestaConsentNovedades(true)).toContain('novedades y promociones');
    });
    it('«ya se preguntó» cuenta también la pregunta de seguimiento y la del embudo', () => {
        expect(PASOS_QUE_YA_PREGUNTARON_NOVEDADES).toEqual(
            expect.arrayContaining([PASO_CONSENT_NOVEDADES, PASO_CONSENT_SEGUIMIENTO, PASO_EMBUDO.CONSENTIMIENTO]));
    });
});

describe('consentimiento de novedades: cuándo se puede preguntar', () => {
    it('solo tras una consulta contestada', () => {
        for (const r of ['precios', 'plan_clases', 'inscripcion', 'prospecto_precios', 'prospecto_info', 'prospecto_ia']) {
            expect(turnoPermiteConsentNovedades(r)).toBe(true);
        }
    });
    it('nunca en una venta, un pago, un comprobante, una agenda, la bienvenida ni un silencio', () => {
        for (const r of ['venta_respuesta', 'venta_pago', 'embudo', 'clase_cortesia', 'clase_cortesia_en_curso',
            'prospecto_horarios', 'pagos', 'medios_de_pago', 'pregunta_de_comprobante', 'disputa_de_pago', 'otp_correo',
            'bienvenida', 'puerta', 'prospecto_persona', 'escuela_atendiendo', 'frenado', 'silencio', '', null, undefined]) {
            expect(turnoPermiteConsentNovedades(r)).toBe(false);
        }
    });
    it('quien ya decidió no se pregunta: consentimiento, baja total o baja de promociones', () => {
        expect(yaDecidioNovedades(null)).toBe(false);
        expect(yaDecidioNovedades(undefined)).toBe(false);
        expect(yaDecidioNovedades({})).toBe(false);
        expect(yaDecidioNovedades({ opted_in_at: null, opted_out_at: null, promos_out_at: null })).toBe(false);
        expect(yaDecidioNovedades({ opted_in_at: '2026-11-01T00:00:00Z' })).toBe(true);
        expect(yaDecidioNovedades({ opted_out_at: '2026-11-01T00:00:00Z' })).toBe(true);
        expect(yaDecidioNovedades({ promos_out_at: '2026-11-01T00:00:00Z' })).toBe(true);
    });
    it('un flujo o una pregunta abiertos en lo último del bot frenan la pregunta', () => {
        const bot = (payload: any, t: string) => ({ direction: 'outbound', ai_generated: true, payload, created_at: t });
        expect(hayFlujoAbiertoEn([])).toBe(false);
        expect(hayFlujoAbiertoEn([bot({ step: 'prospecto_precios' }, '2026-11-15T10:00:00Z')])).toBe(false);
        expect(hayFlujoAbiertoEn([bot({ step: 'embudo_pregunta', flujo: 'embudo' }, '2026-11-15T10:00:00Z')])).toBe(true);
        expect(hayFlujoAbiertoEn([bot({ step: 'estado', pregunta: 'ask_consent' }, '2026-11-15T10:00:00Z')])).toBe(true);
        // Manda el más reciente.
        expect(hayFlujoAbiertoEn([
            bot({ step: 'embudo_pregunta', flujo: 'embudo' }, '2026-11-15T09:00:00Z'),
            bot({ step: 'prospecto_ia' }, '2026-11-15T10:00:00Z'),
        ])).toBe(false);
    });
});

describe('consentimiento de novedades: respuesta escrita', () => {
    it('lee «sí» y «no» solo como mensaje completo', () => {
        for (const t of ['Sí', 'si', 'SÍ.', 'Sí, cuéntenme', 'si claro', 'Claro que sí!']) expect(respuestaEscritaDeNovedades(t)).toBe('si');
        for (const t of ['No', 'no.', 'No, gracias', 'prefiero que no']) expect(respuestaEscritaDeNovedades(t)).toBe('no');
        for (const t of ['no sé si puedo ir', 'sí, quiero inscribir a mi hija', 'ok', 'gracias', '', null, undefined]) {
            expect(respuestaEscritaDeNovedades(t)).toBeNull();
        }
    });
    it('la pregunta está abierta solo si es lo último del bot y nadie la contestó', () => {
        const bot = (payload: any, t: string) => ({ direction: 'outbound', ai_generated: true, payload, created_at: t });
        const pregunta = bot({ step: PASO_CONSENT_NOVEDADES }, '2026-11-15T10:00:00Z');
        expect(preguntaDeNovedadesAbierta([pregunta])).toBe(true);
        expect(preguntaDeNovedadesAbierta([pregunta, { direction: 'inbound', payload: null, created_at: '2026-11-15T10:01:00Z' }])).toBe(true);
        expect(preguntaDeNovedadesAbierta([pregunta, bot({ step: 'prospecto_ia' }, '2026-11-15T10:02:00Z')])).toBe(false);
        expect(preguntaDeNovedadesAbierta([bot({ step: PASO_CONSENT_NOVEDADES, respuesta: 'si' }, '2026-11-15T10:03:00Z'), pregunta])).toBe(false);
        // Lo que escribió una persona de la escuela no es del bot.
        expect(preguntaDeNovedadesAbierta([{ direction: 'outbound', ai_generated: false, payload: { step: PASO_CONSENT_NOVEDADES }, created_at: '2026-11-15T10:00:00Z' }])).toBe(false);
        expect(preguntaDeNovedadesAbierta([])).toBe(false);
    });
});
