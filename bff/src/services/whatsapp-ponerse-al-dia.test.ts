/**
 * Ponerse al día: la acción por conversación (pura) y el cierre en vivo.
 * Casos reales de Dynasty, 2026-10-05/06.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const estado = vi.hoisted(() => ({
    mensajes: [] as any[],
    conversaciones: [] as any[],
    updates: [] as { tabla: string; valores: any }[],
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        const api: any = {
            select: () => api, eq: () => api, in: () => api, gte: () => api, lt: () => api, or: () => api,
            order: () => api, limit: () => api,
            update: (valores: any) => { estado.updates.push({ tabla, valores }); return api; },
            maybeSingle: async () => ({ data: null, error: null }),
            then: (ok: any, err: any) => Promise.resolve(
                tabla === 'whatsapp_messages' ? { data: estado.mensajes, error: null }
                    : tabla === 'whatsapp_conversations' ? { data: estado.conversaciones, error: null }
                    : { data: [], error: null },
            ).then(ok, err),
        };
        return api;
    }
    return { supabase: { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) } };
});

import { accionDeConversacion, cerrarSiEsCierre, listarPorResponder, type EntranteSinResponder } from './whatsapp-ponerse-al-dia.service';
import { esCierreSuelto } from './whatsapp-reglas-turno';

let n = 0;
const e = (tipo: string, texto: string | null = null): EntranteSinResponder => ({
    waMessageId: `wamid.${++n}`, tipo, texto, creado: new Date().toISOString(),
    transcripcion: null, mediaId: tipo === 'image' ? `m${n}` : null, payload: null,
});
const conv = (contactKind: string | null, entrantes: EntranteSinResponder[], extra: Record<string, any> = {}) =>
    ({ contactKind, entrantes, textosPrevios: [] as string[], parentId: 'p1', ...extra });

describe('esCierreSuelto — los cierres que ensucian «Por responder»', () => {
    it.each(['Ok gracias', 'Muchas gracias', 'Vale', 'Vale!', 'Mil gracias!', 'Muchas Gracias', '👍', '🙏🏻', 'Okey', 'Gracias'])(
        '«%s» es cierre', (t) => expect(esCierreSuelto(t)).toBe(true));
    it.each(['Gracias Mile', 'Listo mile gracias', 'Vale querida'])(
        '«%s» es cierre con el nombre de quien atiende', (t) =>
            expect(esCierreSuelto(t, new Map([['mile', 'Milena'], ['milena', 'Milena']]))).toBe(true));
    it.each(['No me deja aún subir el pago de octubre', 'Hola buen día', 'Miércoles está bien', '?', 'ok?',
        'Gracias Mile, cuánto debo'])(
        '«%s» no es cierre', (t) => expect(esCierreSuelto(t)).toBe(false));
});

describe('accionDeConversacion', () => {
    it('a) cierres de familia → cierre', () => {
        expect(accionDeConversacion(conv('familia', [e('text', 'Okey'), e('text', 'Gracias')])).accion).toBe('cierre');
        expect(accionDeConversacion(conv('familia', [e('text', '👍'), e('sticker')])).accion).toBe('cierre');
    });

    it('a) «Gracias Mile» y la auto-respuesta de otro negocio → cierre', () => {
        const equipo = new Map([['mile', 'Milena']]);
        expect(accionDeConversacion(conv('familia', [e('text', 'Gracias Mile')]), new Map(), equipo).accion).toBe('cierre');
        expect(accionDeConversacion(conv('familia', [e('text',
            '¡Hola! 👋 Gracias por escribir a Play Kids 🌈. En este momento nos encontramos fuera de horario')])).accion)
            .toBe('cierre');
    });

    it('b) imagen de familia que nunca entró a la cola → encolar', () => {
        const d = accionDeConversacion(conv('familia', [e('text', 'Buenas tardes cómo estás?'), e('image'),
            e('text', 'Luciana Alvarez Arévalo Mini Volley')]));
        expect(d).toMatchObject({ accion: 'comprobante', comprobante: 'encolar' });
    });

    it('b) imagen ya procesada en silencio (recuperación) → estado', () => {
        const img = e('image');
        const cola = new Map([[img.waMessageId, { status: 'done', result_type: 'payment_receipt' }]]);
        expect(accionDeConversacion(conv('familia', [img]), cola)).toMatchObject({ accion: 'comprobante', comprobante: 'estado' });
    });

    it('b) imagen esperando a la familia → en_cola (no se toca)', () => {
        const img = e('image');
        const cola = new Map([[img.waMessageId, { status: 'waiting_user', result_type: null }]]);
        expect(accionDeConversacion(conv('familia', [img]), cola)).toMatchObject({ comprobante: 'en_cola' });
    });

    it('b) procesada pero familia sin cuenta vinculada → revisar', () => {
        const img = e('image');
        const cola = new Map([[img.waMessageId, { status: 'ignored', result_type: 'none' }]]);
        expect(accionDeConversacion(conv('familia_sin_cuenta', [img], { parentId: null }), cola).accion).toBe('revisar');
    });

    it('c) pregunta real de familia → turno', () => {
        expect(accionDeConversacion(conv('familia', [e('text', 'No me deja aún subir el pago de octubre')])).accion).toBe('turno');
        expect(accionDeConversacion(conv('familia', [e('audio')])).accion).toBe('turno');
    });

    it('c) desconocido que pide información para inscribirse → turno', () => {
        expect(accionDeConversacion(conv('desconocido', [e('text', 'Hola, quiero inscribir a mi hija a voleibol, qué precio tiene?')])).accion)
            .toBe('turno');
        expect(accionDeConversacion(conv('desconocido', [e('text', 'Buenos días'), e('text', 'Me gustaría saber la edad permitida')])).accion)
            .toBe('turno');
    });

    it('d) saludo suelto o seguimiento de desconocido → revisar', () => {
        expect(accionDeConversacion(conv('desconocido', [e('text', 'Hola buen día')])).accion).toBe('revisar');
        expect(accionDeConversacion(conv('desconocido', [e('text', 'Miércoles está bien')])).accion).toBe('revisar');
        expect(accionDeConversacion(conv(null, [e('audio')])).accion).toBe('revisar');
    });

    it('d) personal y staff nunca se contestan, aunque pregunten', () => {
        expect(accionDeConversacion(conv('personal', [e('text', '¿cuánto vale la mensualidad?')])).accion).toBe('revisar');
        expect(accionDeConversacion(conv('staff', [e('image')])).accion).toBe('revisar');
    });
});

describe('cerrarSiEsCierre (webhook en vivo)', () => {
    beforeEach(() => { estado.mensajes = []; estado.updates = []; });
    const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

    it('«Perfecto, gracias» después de la respuesta → atendida', async () => {
        estado.mensajes = [
            { wa_message_id: 'a', direction: 'inbound', type: 'text', text_body: '¿cuánto debo?', wa_timestamp: t(10) },
            { wa_message_id: 'b', direction: 'outbound', type: 'text', text_body: 'Estás al día', wa_timestamp: t(9) },
            { wa_message_id: 'c', direction: 'inbound', type: 'text', text_body: 'Muchas gracias', wa_timestamp: t(1) },
        ];
        expect(await cerrarSiEsCierre('conv', 'c', 'Muchas gracias')).toBe(true);
        expect(estado.updates[0]).toMatchObject({ tabla: 'whatsapp_conversations', valores: { status: 'closed' } });
    });

    it('sin respuesta previa → no se cierra (la pregunta sigue pendiente)', async () => {
        estado.mensajes = [
            { wa_message_id: 'a', direction: 'inbound', type: 'text', text_body: '¿cuánto debo?', wa_timestamp: t(10) },
            { wa_message_id: 'c', direction: 'inbound', type: 'text', text_body: 'gracias', wa_timestamp: t(1) },
        ];
        expect(await cerrarSiEsCierre('conv', 'c', 'gracias')).toBe(false);
    });

    it('una pregunta entre la respuesta y el «gracias» → no se cierra', async () => {
        estado.mensajes = [
            { wa_message_id: 'b', direction: 'outbound', type: 'text', text_body: 'Estás al día', wa_timestamp: t(9) },
            { wa_message_id: 'x', direction: 'inbound', type: 'text', text_body: '¿y el uniforme?', wa_timestamp: t(5) },
            { wa_message_id: 'c', direction: 'inbound', type: 'text', text_body: 'gracias', wa_timestamp: t(1) },
        ];
        expect(await cerrarSiEsCierre('conv', 'c', 'gracias')).toBe(false);
    });

    it('el saludo automático de la app no cuenta como respuesta', async () => {
        estado.mensajes = [
            { wa_message_id: 'b', direction: 'outbound', type: 'text', payload: { automatico: true }, wa_timestamp: t(9) },
            { wa_message_id: 'c', direction: 'inbound', type: 'text', text_body: 'ok', wa_timestamp: t(1) },
        ];
        expect(await cerrarSiEsCierre('conv', 'c', 'ok')).toBe(false);
    });

    it('lo que no es cierre no consulta nada', async () => {
        expect(await cerrarSiEsCierre('conv', 'c', 'No me deja subir el pago')).toBe(false);
        expect(estado.updates).toHaveLength(0);
    });
});

describe('listarPorResponder — lo importado del historial nunca es «sin responder»', () => {
    beforeEach(() => { estado.mensajes = []; estado.conversaciones = []; estado.updates = []; });

    it('una conversación con solo entrantes del historial (de antes del alta) no entra; uno en vivo sí', async () => {
        const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
        estado.conversaciones = [{
            id: 'c-hist', contact_wa_id: '573001110001', contact_name: null, contact_kind: 'desconocido', parent_id: null,
            status: 'open', last_inbound_at: hace(60), tomada_por: null, tomada_hasta: null,
        }];
        // «¿Tienen clase de prueba?» de hace 1 h, pero importado: Meta no abre la
        // ventana con eso y el bot no contesta mensajes viejos.
        estado.mensajes = [{
            wa_message_id: 'wamid.h1', direction: 'inbound', type: 'text', text_body: '¿Tienen clase de prueba?',
            payload: { historial: true }, ai_generated: false, created_at: hace(60), wa_timestamp: hace(60),
        }];
        expect(await listarPorResponder({ id: 'int-1', school_id: 's1' })).toEqual([]);

        // El mismo número escribe en vivo: ese sí espera respuesta (y solo ese).
        estado.mensajes.push({
            wa_message_id: 'wamid.v1', direction: 'inbound', type: 'text', text_body: '¿Y el precio?',
            payload: {}, ai_generated: false, created_at: hace(5), wa_timestamp: hace(5),
        });
        const lista = await listarPorResponder({ id: 'int-1', school_id: 's1' });
        expect(lista).toHaveLength(1);
        expect(lista[0].entrantes.map((m) => m.waMessageId)).toEqual(['wamid.v1']);
    });
});
