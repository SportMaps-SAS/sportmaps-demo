/**
 * Enrutamiento a Mapi agente en el número de SportMaps (plan
 * mapi-admin-por-whatsapp §12.2): solo con MAPI_WHATSAPP=true, suscripción
 * activa y escuela con el agente prendido (o un botón `mapi:*`), ANTES de la
 * ayuda corta. Los comandos de suscripción siguen primero; sin la variable,
 * todo igual.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
    let respuesta: (table: string, ops: [string, any[]][]) => any = () => ({ data: null, error: null });
    function builder(table: string) {
        const ops: [string, any[]][] = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'like', 'order', 'limit', 'update', 'insert', 'upsert']) {
            b[m] = (...a: any[]) => { ops.push([m, a]); return b; };
        }
        b.maybeSingle = () => Promise.resolve(respuesta(table, ops));
        b.single = () => Promise.resolve(respuesta(table, ops));
        b.then = (res: any, rej: any) => Promise.resolve(respuesta(table, ops)).then(res, rej);
        return b;
    }
    return {
        enviados: [] as string[],
        escuelas: [] as any[],
        atenderMapi: vi.fn(async () => 'mapi_turno'),
        setRespuesta: (f: typeof respuesta) => { respuesta = f; },
        supabase: { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) },
    };
});
vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: vi.fn(async (_i: any, _to: string, t: string) => { h.enviados.push(t); return { ok: true, waMessageId: 'w' }; }),
    sendCtaUrl: vi.fn(async (_i: any, _to: string, t: string) => { h.enviados.push(t); return { ok: true, waMessageId: 'w' }; }),
    sendRawPayload: vi.fn(async () => ({ ok: true })),
}));
vi.mock('./plataforma-wa-pruebas.service', () => ({ atenderPrueba: vi.fn(), haySesionDePrueba: vi.fn(async () => false) }));
vi.mock('./mapi-agente/canal-whatsapp-entrada', async (orig) => ({
    ...(await orig<any>()),
    escuelasConMapi: vi.fn(async () => h.escuelas),
}));
vi.mock('./mapi-agente/canal-whatsapp', () => ({ atenderMapiPorWhatsApp: h.atenderMapi }));

import { atenderEntrantePlataforma } from './plataforma-wa-entrante.service';
import { invalidarCanal } from './plataforma-wa.service';

const CANAL = { phone_number_id: '999', waba_id: '888', display_phone_number: '573202683539', access_token_encrypted: 'gcm:x', status: 'activo' };
const NUM = '573001112233';
const AHORA = Date.parse('2026-11-26T15:00:00.000Z');
const activa = { id: 's1', school_id: 'esc-1', profile_id: 'duena', contact_wa_id: NUM, estado: 'activa' };
let subs: any[] = [activa];

const msg = (texto: string, extra: Record<string, unknown> = {}) => ({
    phoneNumberId: '999', contactWaId: NUM, contactName: null, waMessageId: `wamid.${Math.random()}`, type: 'text', textBody: texto,
    waTimestamp: new Date(AHORA).toISOString(), mediaId: null, mediaMimeType: null, mediaCaption: null, raw: {}, ...extra,
});

beforeEach(() => {
    h.enviados.length = 0;
    h.atenderMapi.mockClear();
    h.escuelas = [{ schoolId: 'esc-1', profileId: 'duena' }];
    subs = [activa];
    invalidarCanal();
    process.env.PLATFORM_WA_ENABLED = 'true';
    process.env.MAPI_WHATSAPP = 'true';
    h.setRespuesta((table) => {
        if (table === 'platform_wa_canal') return { data: CANAL, error: null };
        if (table === 'platform_wa_suscripciones') return { data: subs, error: null };
        if (table === 'platform_wa_mensajes') return { data: [], error: null };
        if (table === 'schools') return { data: { name: 'Dynasty' }, error: null };
        return { data: null, error: null };
    });
});
afterEach(() => {
    delete process.env.PLATFORM_WA_ENABLED;
    delete process.env.MAPI_WHATSAPP;
    delete process.env.MAPI_AGENT_ENABLED;
});

describe('enrutamiento a Mapi', () => {
    it('suscriptor activo + escuela con agente + MAPI_WHATSAPP → Mapi, sin la ayuda corta', async () => {
        expect(await atenderEntrantePlataforma(msg('¿cómo vamos con la clínica?') as any, AHORA)).toBe('mapi_turno');
        expect(h.atenderMapi).toHaveBeenCalledTimes(1);
        expect(h.enviados).toHaveLength(0);
    });
    it('sin MAPI_WHATSAPP todo sigue igual (ayuda corta)', async () => {
        delete process.env.MAPI_WHATSAPP;
        expect(await atenderEntrantePlataforma(msg('hola') as any, AHORA)).toBe('ayuda');
        expect(h.atenderMapi).not.toHaveBeenCalled();
    });
    it('MAPI_AGENT_ENABLED=false apaga también el canal', async () => {
        process.env.MAPI_AGENT_ENABLED = 'false';
        expect(await atenderEntrantePlataforma(msg('hola') as any, AHORA)).toBe('ayuda');
        expect(h.atenderMapi).not.toHaveBeenCalled();
    });
    it('escuela sin el agente prendido: ayuda corta', async () => {
        h.escuelas = [];
        expect(await atenderEntrantePlataforma(msg('hola') as any, AHORA)).toBe('ayuda');
        expect(h.atenderMapi).not.toHaveBeenCalled();
    });
    it('PAUSAR y AYUDA siguen siendo comandos de suscripción', async () => {
        expect(await atenderEntrantePlataforma(msg('PAUSAR') as any, AHORA)).toBe('desactivada');
        expect(await atenderEntrantePlataforma(msg('ayuda') as any, AHORA)).toBe('ayuda');
        expect(h.atenderMapi).not.toHaveBeenCalled();
    });
    it('un botón mapi:* va al adaptador aunque ninguna escuela tenga el agente (allí se rechaza)', async () => {
        h.escuelas = [];
        const id = 'mapi:c:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:ABCDEFGH';
        const boton = msg('Confirmar', { type: 'interactive', botonId: id, raw: { interactive: { type: 'button_reply', button_reply: { id, title: 'Confirmar' } } } });
        expect(await atenderEntrantePlataforma(boton as any, AHORA)).toBe('mapi_turno');
        expect(h.atenderMapi).toHaveBeenCalledTimes(1);
    });
    it('número sin suscripción activa: no entra a Mapi', async () => {
        subs = [{ ...activa, estado: 'revocada' }];
        await atenderEntrantePlataforma(msg('hola') as any, AHORA);
        expect(h.atenderMapi).not.toHaveBeenCalled();
    });
});
