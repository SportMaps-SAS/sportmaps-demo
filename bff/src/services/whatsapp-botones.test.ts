/**
 * Botones de respuesta rápida en la capa de Graph API (whatsapp.service):
 * forma exacta del payload, límites de Meta (3 botones, título de 20
 * caracteres) y que el id del botón tocado llegue desde el webhook.
 *
 * Sin red: `fetch` se reemplaza y se inspecciona lo que se habría mandado.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    payloadDeBotones, sendInteractiveButtons, parseInboundMessages, encryptToken,
    MAX_BOTONES, MAX_TITULO_BOTON, payloadDeLista, sendList, debeIrComoLista, MAX_FILAS_LISTA,
    parseStatuses,
} from './whatsapp.service';

const TEL = '573001112233';

describe('payloadDeBotones', () => {
    it('arma interactive/button con type reply por botón', () => {
        expect(payloadDeBotones(TEL, '¿Activamos los avisos?', [
            { id: 'sm_consentir_si', title: 'Sí, acepto' },
            { id: 'sm_consentir_no', title: 'No, gracias' },
        ])).toEqual({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: TEL,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: '¿Activamos los avisos?' },
                action: { buttons: [
                    { type: 'reply', reply: { id: 'sm_consentir_si', title: 'Sí, acepto' } },
                    { type: 'reply', reply: { id: 'sm_consentir_no', title: 'No, gracias' } },
                ] },
            },
        });
    });

    it(`nunca más de ${MAX_BOTONES} botones ni títulos de más de ${MAX_TITULO_BOTON} caracteres`, () => {
        const p: any = payloadDeBotones(TEL, 'cuerpo', [
            { id: 'a', title: 'Un título larguísimo que no cabe' },
            { id: 'b', title: 'Dos' }, { id: 'c', title: 'Tres' }, { id: 'd', title: 'Cuatro' },
        ]);
        const botones = p.interactive.action.buttons;
        expect(botones).toHaveLength(MAX_BOTONES);
        for (const b of botones) expect(Array.from(b.reply.title).length).toBeLessThanOrEqual(MAX_TITULO_BOTON);
        expect(botones.map((b: any) => b.reply.id)).toEqual(['a', 'b', 'c']);
    });

    it('«Hablar con la escuela» cabe justo (21 → no; 20 → sí)', () => {
        expect('Hablar con la escuela'.length).toBe(21);
        const p: any = payloadDeBotones(TEL, 'x', [{ id: 'h', title: 'Hablar con la escuela' }]);
        expect(p.interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(20);
    });

    it('sin botones o cuerpo de más de 1024 → null (el que llama manda texto)', () => {
        expect(payloadDeBotones(TEL, 'x', [])).toBeNull();
        expect(payloadDeBotones(TEL, 'x'.repeat(1025), [{ id: 'a', title: 'A' }])).toBeNull();
    });
});

describe('sendInteractiveButtons', () => {
    beforeAll(() => { process.env.WHATSAPP_TOKEN_ENC_KEY = 'clave-de-prueba'; });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('POST a /{phone_number_id}/messages con el payload de botones', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.btn' }] }) }));
        vi.stubGlobal('fetch', fetchMock);
        const integration = { phone_number_id: 'pn-1', access_token_encrypted: encryptToken('tok') } as any;

        const r = await sendInteractiveButtons(integration, TEL, 'cuerpo', [{ id: 'a', title: 'A' }]);

        expect(r).toEqual({ ok: true, waMessageId: 'wamid.btn' });
        const [url, init] = fetchMock.mock.calls[0] as any;
        expect(url).toMatch(/\/pn-1\/messages$/);
        expect(init.headers.Authorization).toBe('Bearer tok');
        expect(JSON.parse(init.body)).toMatchObject({ type: 'interactive', interactive: { type: 'button' } });
    });

    it('si no cabe como botones no llama a Meta', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const integration = { phone_number_id: 'pn-1', access_token_encrypted: encryptToken('tok') } as any;
        const r = await sendInteractiveButtons(integration, TEL, 'x', []);
        expect(r.ok).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('webhook: la respuesta a un botón trae su id', () => {
    const webhook = (m: any) => ({ entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'pn-1' }, contacts: [{ wa_id: TEL, profile: { name: 'A' } }],
        messages: [{ from: TEL, id: 'wamid.in', timestamp: '1759590000', ...m }],
    } }] }] });

    it('interactive/button_reply → textBody = título, botonId = id', () => {
        const [msg] = parseInboundMessages(webhook({
            type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: 'sm_ver_pagos', title: 'Ver mis pagos' } },
        }));
        expect(msg.textBody).toBe('Ver mis pagos');
        expect(msg.botonId).toBe('sm_ver_pagos');
    });

    it('button de plantilla → botonId = payload', () => {
        const [msg] = parseInboundMessages(webhook({ type: 'button', button: { text: 'Sí', payload: 'sm_consentir_si' } }));
        expect(msg.textBody).toBe('Sí');
        expect(msg.botonId).toBe('sm_consentir_si');
    });

    it('texto normal → botonId null', () => {
        const [msg] = parseInboundMessages(webhook({ type: 'text', text: { body: 'hola' } }));
        expect(msg.botonId).toBeNull();
    });
});

describe('lista interactiva (más de 3 opciones)', () => {
    beforeAll(() => { process.env.WHATSAPP_TOKEN_ENC_KEY = 'clave-de-prueba'; });
    afterEach(() => { vi.unstubAllGlobals(); });

    const filas = [
        { id: 'sm_cc_f:1', title: '1. INFANTIL FEMENINO', descripcion: '6:30 p. m. a 8:30 p. m.', seccion: 'Miércoles 7 oct' },
        { id: 'sm_cc_f:2', title: '2. MENORES FEMENINO', seccion: 'Sábado 10 oct' },
        { id: 'sm_cc_f:3', title: '3. INFANTIL FEMENINO', seccion: 'Sábado 10 oct' },
        { id: 'sm_cc_mas', title: 'Ver más horarios', seccion: 'Más' },
    ];

    it('agrupa por sección en el orden de llegada; type list', () => {
        const p: any = payloadDeLista(TEL, 'Elige un horario', filas, 'Ver horarios');
        expect(p.interactive.type).toBe('list');
        expect(p.interactive.action.button).toBe('Ver horarios');
        expect(p.interactive.action.sections.map((s: any) => [s.title, s.rows.map((r: any) => r.id)])).toEqual([
            ['Miércoles 7 oct', ['sm_cc_f:1']],
            ['Sábado 10 oct', ['sm_cc_f:2', 'sm_cc_f:3']],
            ['Más', ['sm_cc_mas']],
        ]);
        expect(p.interactive.action.sections[0].rows[0]).toEqual(
            { id: 'sm_cc_f:1', title: '1. INFANTIL FEMENINO', description: '6:30 p. m. a 8:30 p. m.' });
    });

    it(`recorta a ${MAX_FILAS_LISTA} filas, títulos de 24 y descripciones de 72; cuerpo > 4096 → null`, () => {
        const muchas = Array.from({ length: 14 }, (_, i) => ({ id: `f${i}`, title: `Título larguísimo número ${i} que no cabe`, descripcion: 'x'.repeat(100) }));
        const p: any = payloadDeLista(TEL, 'cuerpo', muchas);
        const rows = p.interactive.action.sections.flatMap((s: any) => s.rows);
        expect(rows).toHaveLength(MAX_FILAS_LISTA);
        for (const r of rows) {
            expect(Array.from(r.title).length).toBeLessThanOrEqual(24);
            expect(Array.from(r.description).length).toBeLessThanOrEqual(72);
        }
        expect(p.interactive.action.sections[0].title).toBe('Opciones');
        expect(payloadDeLista(TEL, 'x'.repeat(4097), filas)).toBeNull();
        expect(payloadDeLista(TEL, 'x', [])).toBeNull();
    });

    it('debeIrComoLista: más de 3, o con sección', () => {
        expect(debeIrComoLista([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }])).toBe(false);
        expect(debeIrComoLista(filas)).toBe(true);
        expect(debeIrComoLista([{ id: 'a', title: 'A', seccion: 'Hoy' }])).toBe(true);
    });

    it('sendInteractiveButtons con 4 opciones manda una LISTA (antes recortaba a 3)', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.list' }] }) }));
        vi.stubGlobal('fetch', fetchMock);
        const integration = { phone_number_id: 'pn-1', access_token_encrypted: encryptToken('tok') } as any;
        const r = await sendInteractiveButtons(integration, TEL, 'cuerpo', filas);
        expect(r).toEqual({ ok: true, waMessageId: 'wamid.list' });
        const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
        expect(body.interactive.type).toBe('list');
        expect(body.interactive.action.sections.flatMap((s: any) => s.rows)).toHaveLength(4);
    });

    it('sendList sin filas no llama a Meta (el que llama manda el texto numerado)', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const integration = { phone_number_id: 'pn-1', access_token_encrypted: encryptToken('tok') } as any;
        expect((await sendList(integration, TEL, 'x', [])).ok).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('webhook: list_reply → botonId = id de la fila', () => {
        const [msg] = parseInboundMessages({ entry: [{ changes: [{ field: 'messages', value: {
            metadata: { phone_number_id: 'pn-1' }, contacts: [{ wa_id: TEL, profile: { name: 'A' } }],
            messages: [{ from: TEL, id: 'wamid.in', timestamp: '1759590000', type: 'interactive',
                interactive: { type: 'list_reply', list_reply: { id: 'sm_cc_f:2', title: '2. MENORES FEMENINO' } } }],
        } }] }] });
        expect(msg.botonId).toBe('sm_cc_f:2');
        expect(msg.textBody).toBe('2. MENORES FEMENINO');
    });
});

describe('estados de entrega', () => {
    const conEstado = (status: string) => ({ entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'PN1' },
        statuses: [{ id: 'wamid.x', status, timestamp: '1793300000', recipient_id: TEL }],
    } }] }] });

    it('«played» (escucharon la nota de voz) se guarda como «read»: el CHECK no lo conoce', () => {
        expect(parseStatuses(conEstado('played'))[0].status).toBe('read');
    });

    it('los demás estados pasan tal cual', () => {
        expect(parseStatuses(conEstado('delivered'))[0].status).toBe('delivered');
    });
});
