/**
 * Seguimiento de ~20 h al interesado que dejó de escribir (decisión 2026-10-29).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    tocaSeguimiento, runSeguimientoProspectos20h, horaBogota, PASO_SEGUIMIENTO_20H,
    type DepsSeguimiento20h, type LeadCandidato,
} from './whatsapp-prospecto-seguimiento.service';

// Jueves 29-oct-2026, 3:00 p. m. en Bogotá.
const AHORA = new Date('2026-10-29T20:00:00Z');
const hace = (h: number) => new Date(AHORA.getTime() - h * 3600_000).toISOString();

const LEAD: LeadCandidato = { id: 'l1', schoolId: 's1', conversationId: 'c1', sourceDetail: { conversation_id: 'c1' } };
const CONV = { id: 'c1', integrationId: 'i1', contactWaId: '573001112233', lastInboundAt: hace(20) };

function deps(p: Partial<DepsSeguimiento20h> = {}) {
    const enviados: string[] = [];
    const d: Partial<DepsSeguimiento20h> = {
        candidatos: async () => [LEAD],
        conversacion: async () => CONV,
        recientes: async () => [
            { direction: 'inbound', text_body: 'Es únicamente ir y ya?', created_at: hace(20) },
            { direction: 'outbound', ai_generated: true, text_body: '¡Claro! Solo llegas…', created_at: hace(19.9) },
        ],
        puedeHablar: async () => true, cupoSeparado: async () => false,
        integracion: async () => ({ id: 'i1', school_id: 's1' } as any),
        reclamar: async () => true,
        soltar: async () => undefined,
        redactar: async () => '¿Pudiste ver los horarios? Dime el día y te muestro los de ese día.',
        enviar: async (_i, _c, _w, t) => { enviados.push(t); },
        ...p,
    };
    return { d, enviados };
}

describe('tocaSeguimiento', () => {
    it('3 p. m. en Bogotá', () => expect(horaBogota(AHORA)).toBe(15));

    it('último mensaje hace 20 h, el bot le contestó: toca', () => {
        expect(tocaSeguimiento(CONV, [], AHORA).toca).toBe(true);
    });

    it('fuera del rango 18–22 h: no', () => {
        expect(tocaSeguimiento({ lastInboundAt: hace(10) }, [], AHORA).motivo).toBe('fuera_de_rango');
        expect(tocaSeguimiento({ lastInboundAt: hace(23) }, [], AHORA).motivo).toBe('fuera_de_rango');
    });

    it('una persona de la escuela le escribió después: no', () => {
        const r = tocaSeguimiento(CONV, [
            { direction: 'outbound', ai_generated: false, text_body: 'Hola, te espero mañana', created_at: hace(19) },
        ], AHORA);
        expect(r.motivo).toBe('escuela_atendiendo');
    });

    it('la escuela escribió ANTES del último mensaje del interesado: tampoco (…5543, 2026-10-29)', () => {
        const r = tocaSeguimiento(CONV, [
            { direction: 'outbound', ai_generated: false, text_body: 'Entonces no sé si mejor vienes el sábado a las 11 am', created_at: hace(20.1) },
            { direction: 'inbound', text_body: 'Ahh listo', created_at: hace(20) },
        ], AHORA);
        expect(r.motivo).toBe('escuela_atendiendo');
    });

    it('un recordatorio automático NO cuenta como persona', () => {
        const r = tocaSeguimiento(CONV, [
            { direction: 'outbound', ai_generated: false, payload: { automatico: true }, text_body: 'Recordatorio', created_at: hace(19) },
        ], AHORA);
        expect(r.toca).toBe(true);
    });

    it('ya se le mandó: no', () => {
        const r = tocaSeguimiento(CONV, [
            { direction: 'outbound', ai_generated: true, payload: { step: PASO_SEGUIMIENTO_20H }, created_at: hace(1) },
        ], AHORA);
        expect(r.motivo).toBe('ya_enviado');
    });

    it('de noche: no', () => {
        const noche = new Date('2026-10-30T03:00:00Z'); // 10 p. m. Bogotá
        expect(tocaSeguimiento({ lastInboundAt: new Date(noche.getTime() - 20 * 3600_000).toISOString() }, [], noche).motivo)
            .toBe('fuera_de_horario');
    });
});

describe('runSeguimientoProspectos20h', () => {
    it('manda UN mensaje redactado al interesado que dejó de escribir', async () => {
        const { d, enviados } = deps();
        const r = await runSeguimientoProspectos20h({ ahora: AHORA, deps: d });
        expect(r.enviados).toBe(1);
        expect(enviados).toHaveLength(1);
    });

    it('si otro BFF ya lo reclamó, no lo manda', async () => {
        const { d, enviados } = deps({ reclamar: async () => false });
        await runSeguimientoProspectos20h({ ahora: AHORA, deps: d });
        expect(enviados).toHaveLength(0);
    });

    it('sin texto del modelo (sin ficha o «NADA»): no manda nada', async () => {
        const { d, enviados } = deps({ redactar: async () => null });
        const r = await runSeguimientoProspectos20h({ ahora: AHORA, deps: d });
        expect(enviados).toHaveLength(0);
        expect(r.omitidos).toBe(1);
    });

    it('bot apagado, conversación tomada o baja: no', async () => {
        const { d, enviados } = deps({ puedeHablar: async () => false });
        await runSeguimientoProspectos20h({ ahora: AHORA, deps: d });
        expect(enviados).toHaveLength(0);
    });

    it('si el envío falla, suelta la marca para reintentar', async () => {
        const soltar = vi.fn(async () => undefined);
        const { d } = deps({ enviar: async () => { throw new Error('Meta caído'); }, soltar });
        const r = await runSeguimientoProspectos20h({ ahora: AHORA, deps: d });
        expect(r.fallidos).toBe(1);
        expect(soltar).toHaveBeenCalled();
    });
});
