import { describe, it, expect, vi } from 'vitest';
import {
    acuseReciboHabilitado, acusarReciboDeComprobante, TEXTO_ACUSE_RECIBO, PASO_ACUSE_RECIBO,
} from './whatsapp-acuse-recibo';

const ESC = 'escuela-1';
const ahora = Date.parse('2026-11-15T20:00:00Z');
const llegoEn = (minAntes: number) => new Date(ahora - minAntes * 60_000).toISOString();
const deps = (o: { ya?: boolean; ok?: boolean } = {}) => ({
    yaAcuso: vi.fn(async () => o.ya === true),
    enviar: vi.fn(async () => ({ ok: o.ok !== false })),
});

describe('acuse de recibido que nunca se calla', () => {
    it('apagado por defecto; solo corre en las escuelas de la variable', () => {
        expect(acuseReciboHabilitado(ESC, undefined)).toBe(false);
        expect(acuseReciboHabilitado(ESC, '')).toBe(false);
        expect(acuseReciboHabilitado(ESC, 'otra, escuela-1')).toBe(true);
        expect(acuseReciboHabilitado(ESC, 'otra')).toBe(false);
    });

    it('el texto dice «recibí» y nunca aprobado/validado/cupo confirmado', () => {
        expect(TEXTO_ACUSE_RECIBO).toMatch(/Recibí tu comprobante/);
        expect(TEXTO_ACUSE_RECIBO).not.toMatch(/aprob|valid[oa]d|cupo confirmado|quedó registrado/i);
    });

    it('con la bandera apagada no escribe', async () => {
        const d = deps();
        const r = await acusarReciboDeComprobante({ schoolId: ESC, conversationId: 'c1', llegoEn: llegoEn(1), ahora }, d, '');
        expect(r).toBe('apagado');
        expect(d.enviar).not.toHaveBeenCalled();
    });

    it('caso Carlos: la escuela había contestado a mano y aun así recibe el acuse', async () => {
        const d = deps();
        const r = await acusarReciboDeComprobante({ schoolId: ESC, conversationId: 'c1', llegoEn: llegoEn(2), ahora }, d, ESC);
        expect(r).toBe('enviado');
        expect(d.enviar).toHaveBeenCalledWith(TEXTO_ACUSE_RECIBO, PASO_ACUSE_RECIBO);
    });

    it('uno por ráfaga: si ya salió un acuse reciente, no manda otro', async () => {
        const d = deps({ ya: true });
        const r = await acusarReciboDeComprobante({ schoolId: ESC, conversationId: 'c1', llegoEn: llegoEn(1), ahora }, d, ESC);
        expect(r).toBe('ya_acusado');
        expect(d.enviar).not.toHaveBeenCalled();
    });

    it('fuera de las 24 h de Meta no escribe (no hay texto libre posible)', async () => {
        const d = deps();
        const r = await acusarReciboDeComprobante({ schoolId: ESC, conversationId: 'c1', llegoEn: llegoEn(25 * 60), ahora }, d, ESC);
        expect(r).toBe('fuera_de_ventana');
        expect(d.enviar).not.toHaveBeenCalled();
    });

    it('sin conversación o sin fecha de llegada no escribe', async () => {
        const d = deps();
        expect(await acusarReciboDeComprobante({ schoolId: ESC, conversationId: null, llegoEn: llegoEn(1), ahora }, d, ESC)).toBe('sin_conversacion');
        expect(await acusarReciboDeComprobante({ schoolId: ESC, conversationId: 'c1', llegoEn: null, ahora }, d, ESC)).toBe('fuera_de_ventana');
        expect(d.enviar).not.toHaveBeenCalled();
    });

    it('nunca lanza: un envío que revienta devuelve no_salio', async () => {
        const d = { yaAcuso: async () => false, enviar: async () => { throw new Error('meta 500'); } };
        expect(await acusarReciboDeComprobante({ schoolId: ESC, conversationId: 'c1', llegoEn: llegoEn(1), ahora }, d, ESC)).toBe('no_salio');
    });
});
