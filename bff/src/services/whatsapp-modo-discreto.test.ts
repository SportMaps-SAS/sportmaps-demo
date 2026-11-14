/**
 * Modo discreto (análisis de las 604 conversaciones de Dynasty, 2026-10-29):
 * quién cuenta como «la escuela está en la charla», la ventana de 12 h y el aviso
 * único de lo que quedó sin contestar. Las reglas son puras.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));
vi.mock('./whatsapp-escalaciones.service', () => ({ avisarEscalacionAlEquipo: vi.fn(async () => 1) }));

import {
    escritoPorLaEscuela, escuelaActivaEn, decidirPendientes, entrantePideAlgo, modoDiscreto,
    type ConversacionParaPendiente, type SalienteParaPendiente, type EntranteParaPendiente,
} from './whatsapp-modo-discreto';
import type { FilaReciente } from './whatsapp-reglas-turno';
import { aLetrasNormales, tieneLetrasDecorativas } from './whatsapp-letras-decorativas';

const AHORA = Date.parse('2026-10-29T22:00:00Z'); // 17:00 en Bogotá
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();

const entrante = (min: number, texto = 'Hola'): FilaReciente => ({ direction: 'inbound', type: 'text', text_body: texto, created_at: hace(min) });
const eco = (min: number, payload: Record<string, unknown> = { from: '57300', text: { body: 'x' } }): FilaReciente =>
    ({ direction: 'outbound', type: 'text', text_body: 'x', ai_generated: false, payload, created_at: hace(min) });
const delBot = (min: number, step = 'llm_text'): FilaReciente =>
    ({ direction: 'outbound', type: 'text', text_body: 'bot', ai_generated: true, payload: { step }, created_at: hace(min) });

describe('modoDiscreto()', () => {
    it('está prendido salvo WHATSAPP_MODO_DISCRETO=false', () => {
        const antes = process.env.WHATSAPP_MODO_DISCRETO;
        try {
            delete process.env.WHATSAPP_MODO_DISCRETO;
            expect(modoDiscreto()).toBe(true);
            process.env.WHATSAPP_MODO_DISCRETO = 'false';
            expect(modoDiscreto()).toBe(false);
        } finally {
            process.env.WHATSAPP_MODO_DISCRETO = antes;
        }
    });
});

describe('escritoPorLaEscuela', () => {
    it('el eco del celular de Milena es la escuela', () => {
        const f = eco(5);
        expect(escritoPorLaEscuela(f, [f])).toBe(true);
    });

    it('lo del buzón (manual) es la escuela', () => {
        const f = eco(5, { manual: true, por: 'u1' });
        expect(escritoPorLaEscuela(f, [f])).toBe(true);
    });

    it('el bot y las plantillas de los jobs no', () => {
        const job = eco(5, { step: 'recordatorio_cortesia', automatico: true });
        expect(escritoPorLaEscuela(delBot(5), [])).toBe(false);
        expect(escritoPorLaEscuela(job, [job])).toBe(false);
    });

    it('el saludo automático de WhatsApp Business (2 s después del entrante) no es Milena', () => {
        const filas = [entrante(10), { ...eco(10, { from: '57300', automatico: true }), created_at: new Date(AHORA - 10 * 60_000 + 2_000).toISOString() }];
        expect(escritoPorLaEscuela(filas[1], filas)).toBe(false);
    });

    it('una respuesta rápida suya («Bienvenidos a Dynasty»), minutos después, SÍ es Milena', () => {
        const filas = [entrante(80), eco(3, { from: '57300', automatico: true })];
        expect(escritoPorLaEscuela(filas[1], filas)).toBe(true);
    });
});

describe('escuelaActivaEn: 12 h', () => {
    it('Milena escribió hace 2 h → activa (antes la ventana era de 15 min)', () => {
        expect(escuelaActivaEn([entrante(1), eco(120)], AHORA)).toBe(true);
    });

    it('hace 13 h → ya no', () => {
        expect(escuelaActivaEn([entrante(1), eco(13 * 60)], AHORA)).toBe(false);
    });

    it('solo el bot habló → no', () => {
        expect(escuelaActivaEn([entrante(1), delBot(5)], AHORA)).toBe(false);
    });
});

describe('decidirPendientes: un aviso por lo que de verdad quedó sin contestar', () => {
    const conv = (o: Partial<ConversacionParaPendiente> = {}): ConversacionParaPendiente => ({
        id: 'c1', integration_id: 'i1', contact_wa_id: '573001112233', contact_name: 'Marcela',
        contact_kind: 'familia', status: 'open', tomada_por: null, tomada_hasta: null, ...o,
    });
    const ent = (min: number, texto = '¿Mañana hay entreno en el coliseo?', o: Partial<EntranteParaPendiente> = {}): EntranteParaPendiente =>
        ({ conversation_id: 'c1', type: 'text', text_body: texto, created_at: hace(min), ...o });
    const sal = (min: number, o: Partial<SalienteParaPendiente> = {}): SalienteParaPendiente =>
        ({ conversation_id: 'c1', direction: 'outbound', ai_generated: false, payload: {}, created_at: hace(min), ...o });
    const decidir = (e: EntranteParaPendiente[], s: SalienteParaPendiente[], c = conv()) =>
        decidirPendientes(e, s, new Map([[c.id, c]]), new Map([['i1', null]]), AHORA);

    it('familia sin respuesta hace 3 h → un pendiente', () => {
        expect(decidir([ent(180)], [])).toHaveLength(1);
    });

    it('con menos de 2 h todavía no', () => {
        expect(decidir([ent(60)], [])).toHaveLength(0);
    });

    it('Milena contestó → nada', () => {
        expect(decidir([ent(180)], [sal(150)])).toHaveLength(0);
    });

    it('el bot contestó algo útil → nada; si solo dijo «te paso con la escuela» → pendiente', () => {
        expect(decidir([ent(180)], [sal(179, { ai_generated: true, payload: { step: 'horarios_de_hoy' } })])).toHaveLength(0);
        expect(decidir([ent(180)], [sal(179, { ai_generated: true, payload: { step: 'escalated' } })])).toHaveLength(1);
    });

    it('un «gracias» o un sticker no esperan respuesta', () => {
        expect(decidir([ent(180, 'Muchas gracias')], [])).toHaveLength(0);
        expect(decidir([ent(180, '', { type: 'sticker' })], [])).toHaveLength(0);
    });

    it('la vida personal de quien atiende no se recuerda; un interesado sin ficha sí', () => {
        expect(decidir([ent(180)], [], conv({ contact_kind: 'personal' }))).toHaveLength(0);
        expect(decidir([ent(180, 'Hola amor, ¿vamos a almorzar?')], [], conv({ contact_kind: 'desconocido' }))).toHaveLength(0);
        expect(decidir([ent(180, 'Quiero inscribir a mi hija, ¿qué horarios tienen?')], [], conv({ contact_kind: 'desconocido' })))
            .toHaveLength(1);
    });

    it('conversación tomada o cerrada → nada', () => {
        expect(decidir([ent(180)], [], conv({ tomada_por: 'u1', tomada_hasta: hace(-60) }))).toHaveLength(0);
        expect(decidir([ent(180)], [], conv({ status: 'closed' }))).toHaveLength(0);
    });

    it('cuenta el último entrante que pide algo (un «ok» al final no lo tapa)', () => {
        const p = decidir([ent(200, '¿Me confirmas la talla de la camiseta?'), ent(190, 'ok')], []);
        expect(p).toHaveLength(1);
        expect(p[0].desde).toBe(hace(200));
    });

    it('entrantePideAlgo: una foto sin texto sí (puede ser el comprobante)', () => {
        expect(entrantePideAlgo({ conversation_id: 'c1', type: 'image', text_body: null })).toBe(true);
    });
});

describe('letras decorativas', () => {
    it('versalitas → letras normales', () => {
        expect(aLetrasNormales('ʜᴏʟᴀ ᴍɪʟᴇ')).toBe('hola mile');
        expect(aLetrasNormales('sᴇʀᴀ ǫ ᴍᴇ ᴘᴜᴇᴅᴇs ᴄᴀᴍʙɪᴀʀ ʟᴀ ᴛᴀʟʟᴀ ᴅᴇ ʟᴀ ᴄᴀᴍɪsᴀ ᴘᴏʀ ᴍ ᴘᴏʀ ғɪss'))
            .toBe('sera q me puedes cambiar la talla de la camisa por m por fiss');
    });

    it('letras matemáticas (𝗦𝗼𝘆 𝗩𝗶𝗮𝗻𝗰𝗮) → normales', () => {
        expect(aLetrasNormales('¡Hola! 𝗦𝗼𝘆 𝗩𝗶𝗮𝗻𝗰𝗮 🌥️')).toBe('¡Hola! Soy Vianca 🌥️');
    });

    it('un texto normal no cambia, ni sus «½» o «²»', () => {
        const t = 'Mile, pagué ½ mes y 2² cuotas ✅';
        expect(tieneLetrasDecorativas(t)).toBe(false);
        expect(aLetrasNormales(t)).toBe(t);
        expect(aLetrasNormales(null)).toBeNull();
    });
});
