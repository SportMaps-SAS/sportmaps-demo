/**
 * El seguimiento de 20 h no toca a quien ya tiene un cupo separado/agendado (Monster 2026-11-13, Astolfo Tique).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));
import { tocaSeguimiento, tieneCupoDelEmbudo } from './whatsapp-prospecto-seguimiento.service';

describe('cupo ya separado por el embudo', () => {
    const ahora = new Date('2026-11-13T18:37:00Z'); // 13:37 Bogotá
    const conv = { lastInboundAt: new Date(ahora.getTime() - 19 * 3600_000).toISOString() };
    it('con un saliente «esperando pago» no se hace el seguimiento de 20 h', () => {
        const r = tocaSeguimiento(conv, [{ direction: 'outbound', ai_generated: true, payload: { step: 'embudo_esperando_pago' } } as any], ahora);
        expect(r).toEqual({ toca: false, motivo: 'cupo_separado' });
    });
    it('tampoco con la marca del estado del embudo en el payload', () => {
        expect(tieneCupoDelEmbudo([{ direction: 'outbound', payload: { paso_embudo: 'agendada' } } as any])).toBe(true);
    });
    it('sin cupo separado sigue tocando', () => {
        expect(tocaSeguimiento(conv, [], ahora).toca).toBe(true);
        expect(tieneCupoDelEmbudo([{ direction: 'outbound', payload: { step: 'embudo_pregunta' } } as any])).toBe(false);
    });
});
