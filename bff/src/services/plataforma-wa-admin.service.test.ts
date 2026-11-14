/**
 * Canal de WhatsApp de SportMaps desde /admin/whatsapp (2026-10-29).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    canal: null as any,
    inserts: [] as { table: string; row: any }[],
    updates: [] as { table: string; row: any }[],
}));

vi.mock('../config/supabase', () => {
    const builder = (table: string) => {
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'order', 'limit', 'ilike']) b[m] = () => b;
        b.maybeSingle = async () => ({ data: table === 'platform_wa_canal' ? h.canal : null, error: null });
        b.insert = async (row: any) => { h.inserts.push({ table, row }); return { error: null }; };
        b.update = (row: any) => { h.updates.push({ table, row }); return b; };
        b.upsert = async (row: any) => { h.updates.push({ table, row }); return { error: null }; };
        b.then = (res: any) => Promise.resolve({ data: [], error: null }).then(res);
        return b;
    };
    return { supabase: { from: builder } };
});
vi.mock('./plataforma-wa.service', async (orig) => {
    const real: any = await orig();
    return { ...real, leerCanal: async () => h.canal, invalidarCanal: () => undefined };
});
const envio = vi.hoisted(() => ({ sendTextMessage: vi.fn() }));
vi.mock('./whatsapp.service', async (orig) => {
    const real: any = await orig();
    return { ...real, sendTextMessage: envio.sendTextMessage, decryptToken: () => 'TOKEN' };
});

import {
    enmascarar, plantillasDelRepo, cambiarInterruptor, enviarPrueba,
} from './plataforma-wa-admin.service';

beforeEach(() => {
    h.canal = null;
    h.inserts.length = 0;
    h.updates.length = 0;
    envio.sendTextMessage.mockReset();
});

describe('piezas puras', () => {
    it('enmascara los teléfonos', () => {
        expect(enmascarar('573001234567')).toBe('…4567');
        expect(enmascarar(null)).toBe('—');
    });

    it('lee las 5 plantillas sm_* del repo', () => {
        const p = plantillasDelRepo();
        expect(p.map((x) => x.nombre)).toEqual(expect.arrayContaining(['sm_caso_por_atender', 'sm_resumen_diario']));
        expect(p.every((x) => x.categoria === 'UTILITY')).toBe(true);
    });
});

describe('interruptor', () => {
    it('no deja prender un canal sin número conectado', async () => {
        const r = await cambiarInterruptor(true, 'admin-1');
        expect(r.ok).toBe(false);
        expect(h.updates).toHaveLength(0);
    });

    it('con el canal conectado lo prende y deja auditoría', async () => {
        h.canal = { status: 'activo', access_token_encrypted: 'x', phone_number_id: 'p', waba_id: 'w' };
        const r = await cambiarInterruptor(true, 'admin-1');
        expect(r.ok).toBe(true);
        expect(h.updates[0].row).toMatchObject({ habilitado: true });
        expect(h.inserts[0]).toMatchObject({ table: 'platform_wa_auditoria', row: { actor_id: 'admin-1', accion: 'habilitar_canal' } });
    });

    it('apagar siempre se puede', async () => {
        expect((await cambiarInterruptor(false, 'admin-1')).ok).toBe(true);
    });
});

describe('prueba', () => {
    it('rechaza un número que no es celular colombiano', async () => {
        expect((await enviarPrueba('12345', 'a')).ok).toBe(false);
    });

    it('ventana cerrada: explica que primero hay que escribirle al número', async () => {
        h.canal = { status: 'activo', access_token_encrypted: 'x', phone_number_id: 'p', waba_id: 'w' };
        envio.sendTextMessage.mockResolvedValue({ ok: false, error: '(#131047) Re-engagement message' });
        const r = await enviarPrueba('3001234567', 'a');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/24 h/);
        expect(envio.sendTextMessage.mock.calls[0][1]).toBe('573001234567');
    });

    it('enviada: queda auditada con el número enmascarado', async () => {
        h.canal = { status: 'activo', access_token_encrypted: 'x', phone_number_id: 'p', waba_id: 'w' };
        envio.sendTextMessage.mockResolvedValue({ ok: true });
        expect((await enviarPrueba('300 123 4567', 'a')).ok).toBe(true);
        expect(h.inserts[0].row).toMatchObject({ accion: 'enviar_prueba', detalle: { numero: '…4567', ok: true } });
    });
});
