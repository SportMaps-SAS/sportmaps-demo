/**
 * Adjuntos al número de SportMaps (B7): la foto o el PDF de un tester llega al
 * modo pruebas (que ahora lo lee como comprobante); la de cualquier otro número
 * sigue igual que antes: no se contesta, no se baja y no se guarda su texto.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
    const insertados: { table: string; fila: any }[] = [];
    function builder(table: string) {
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'like', 'order', 'limit', 'update', 'upsert']) b[m] = () => b;
        b.insert = (fila: any) => { insertados.push({ table, fila }); return b; };
        const res = () => (table === 'platform_wa_canal'
            ? { data: { phone_number_id: '999', waba_id: '888', display_phone_number: '573202683539', access_token_encrypted: 'gcm:x', status: 'activo' }, error: null }
            : { data: table === 'platform_wa_mensajes' ? [] : null, error: null });
        b.maybeSingle = () => Promise.resolve(res());
        b.single = () => Promise.resolve(res());
        b.then = (ok: any, ko: any) => Promise.resolve(res()).then(ok, ko);
        return b;
    }
    const enviados: string[] = [];
    return { insertados, enviados, supabase: { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) } };
});
vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: vi.fn(async (_i: any, _to: string, t: string) => { h.enviados.push(t); return { ok: true, waMessageId: 'wamid.out' }; }),
    sendCtaUrl: vi.fn(async (_i: any, _to: string, t: string) => { h.enviados.push(t); return { ok: true, waMessageId: 'wamid.out' }; }),
    sendRawPayload: vi.fn(async () => ({ ok: true })),
    downloadMedia: vi.fn(async () => ({ ok: true, base64: 'eA==', mimeType: 'image/jpeg' })),
    decryptToken: (x: string) => x,
}));
vi.mock('./plataforma-wa-pruebas.service', () => ({
    atenderPrueba: vi.fn(async () => undefined),
    haySesionDePrueba: vi.fn(async () => true),
}));

import { atenderEntrantePlataforma } from './plataforma-wa-entrante.service';
import { invalidarCanal } from './plataforma-wa.service';
import { atenderPrueba } from './plataforma-wa-pruebas.service';
import { downloadMedia } from './whatsapp.service';

const TESTER = '573128463555';
const AHORA = Date.parse('2026-10-29T15:00:00.000Z');

function foto(de: string, tipo = 'image') {
    return {
        phoneNumberId: '999', contactWaId: de, contactName: null, waMessageId: `wamid.${de}.${tipo}`, type: tipo, textBody: null,
        waTimestamp: new Date(AHORA).toISOString(), mediaId: 'media-1', mediaMimeType: tipo === 'document' ? 'application/pdf' : 'image/jpeg',
        mediaCaption: 'comprobante', raw: {},
    } as any;
}

beforeEach(() => {
    h.insertados.length = 0;
    h.enviados.length = 0;
    vi.mocked(atenderPrueba).mockClear();
    vi.mocked(downloadMedia).mockClear();
    invalidarCanal();
    process.env.PLATFORM_WA_ENABLED = 'true';
    process.env.PLATFORM_WA_TESTERS = TESTER;
});
afterEach(() => {
    delete process.env.PLATFORM_WA_ENABLED;
    delete process.env.PLATFORM_WA_TESTERS;
});

describe('adjuntos al número de SportMaps', () => {
    it('la foto y el PDF de un tester van al modo pruebas', async () => {
        expect(await atenderEntrantePlataforma(foto(TESTER), AHORA)).toBe('prueba');
        expect(await atenderEntrantePlataforma(foto(TESTER, 'document'), AHORA)).toBe('prueba');
        expect(atenderPrueba).toHaveBeenCalledTimes(2);
        expect(vi.mocked(atenderPrueba).mock.calls[0][1]).toMatchObject({ type: 'image', mediaId: 'media-1' });
    });

    it('la foto de un número que no es tester: igual que hoy (no_texto, sin respuesta, sin bajarla, sin su texto)', async () => {
        expect(await atenderEntrantePlataforma(foto('573005556677'), AHORA)).toBe('no_texto');
        expect(atenderPrueba).not.toHaveBeenCalled();
        expect(downloadMedia).not.toHaveBeenCalled();
        expect(h.enviados).toHaveLength(0);
        const ins = h.insertados.find((i) => i.table === 'platform_wa_mensajes')!;
        expect(ins.fila).toMatchObject({ clase: 'desconocido', tipo: 'image', texto: null });
    });
});
