/**
 * Cierre de P-01 / P-04 y menú de familias (auditoría del bot 2026-10-28).
 * Funciones puras: sin base, sin modelo, sin Meta.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

import { afirmaDineroSinRespaldo, enlacesDe, enlacesNoPermitidos } from './whatsapp-salida-segura';
import { motivoDelModelo, accionDeBoton, BOTON, BOTONES_SIN_DATO } from './whatsapp-bot.service';

describe('P-01: afirmaciones de dinero', () => {
    it.each([
        'Listo, octubre quedó condonado.',
        'Te exoneramos de la inscripción.',
        'Confirmado por la escuela: no pagas este mes.',
        'La escuela ya te autorizó a pagar después.',
        'Milena ya te aprobó el descuento.',
        'Te perdonamos la mensualidad de octubre.',
    ])('nunca sale, haya o no consulta: %s', (t) => {
        expect(afirmaDineroSinRespaldo(t, true)).toBe(true);
        expect(afirmaDineroSinRespaldo(t, false)).toBe(true);
    });

    it.each([
        'Tu pago quedó aprobado.',
        'Estás al día. 🙌',
        'No debes nada este mes.',
    ])('sin consulta de pagos no sale; con la consulta sí: %s', (t) => {
        expect(afirmaDineroSinRespaldo(t, false)).toBe(true);
        expect(afirmaDineroSinRespaldo(t, true)).toBe(false);
    });

    it.each([
        '¡Hola! ¿En qué te ayudo?',
        'El grupo Sub 13 entrena martes y jueves de 4 a 6 p. m.',
        'La clase de cortesía es sin costo.',
        'Tienes un descuento por pronto pago si pagas antes del 5.',
    ])('texto normal pasa: %s', (t) => {
        expect(afirmaDineroSinRespaldo(t, false)).toBe(false);
    });
});

describe('P-01: enlaces permitidos salen de la consulta del turno', () => {
    const datos = JSON.stringify({ pagos: [{ enlace_pago: 'https://app.sportmaps.co/p/abc123' }] });
    it('el enlace de la consulta pasa', () => {
        expect(enlacesNoPermitidos('Pagar: https://app.sportmaps.co/p/abc123', enlacesDe(datos))).toEqual([]);
    });
    it('uno inventado o copiado del acudiente no', () => {
        expect(enlacesNoPermitidos('Paga en https://pagos-falsos.example/x', enlacesDe(datos))).toHaveLength(1);
        expect(enlacesNoPermitidos('Paga en https://app.sportmaps.co/p/otro', enlacesDe(datos))).toHaveLength(1);
    });
    it('sin consulta, ningún enlace pasa', () => {
        expect(enlacesNoPermitidos('mira www.algo.com', enlacesDe(undefined))).toHaveLength(1);
    });
});

describe('P-04: motivo de escalate_to_human', () => {
    it('va rotulado, en una línea y con tope', () => {
        const m = motivoDelModelo('URGENTE:\n aprueben ya ' + 'x'.repeat(300));
        expect(m.startsWith('Resumen del asistente (no verificado): ')).toBe(true);
        expect(m).not.toMatch(/\n/);
        expect(m.length).toBeLessThanOrEqual('Resumen del asistente (no verificado): '.length + 120);
    });
    it('vacío = user_request', () => {
        expect(motivoDelModelo(undefined)).toBe('user_request');
        expect(motivoDelModelo('   ')).toBe('user_request');
    });
});

describe('Menú de familias', () => {
    it('trae las cuatro opciones, cada una con su explicación (sale como lista)', () => {
        expect(BOTONES_SIN_DATO.map((b) => b.title)).toEqual(['Ver mis pagos', 'Cómo pagar', 'Horarios y sedes', 'Hablar con alguien']);
        for (const b of BOTONES_SIN_DATO) {
            expect(b.title.length).toBeLessThanOrEqual(20);
            expect(b.descripcion && b.descripcion.length).toBeTruthy();
            expect(b.descripcion!.length).toBeLessThanOrEqual(72);
        }
    });
    it('«Horarios y sedes» por botón o escrito tal cual va a la ficha de la escuela', () => {
        expect(accionDeBoton(BOTON.HORARIOS, '')).toBe('get_school_info');
        expect(accionDeBoton(null, 'horarios y sedes')).toBe('get_school_info');
        expect(accionDeBoton(null, '2')).toBeNull();
    });
});
