/**
 * «¿Te sirvió?» de Mapi (2026-10-27): «No» pasa el caso a una persona
 * (waiting_human), Mapi lo dice en el chat y sale el correo [Revisar]. La
 * calificación queda como nota interna, una sola por respuesta.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const T = '11111111-1111-4111-8111-111111111111';
const BOT = '22222222-2222-4222-8222-222222222222';
const USER_MSG = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => {
    const tablas: Record<string, any[]> = {};
    function builder(table: string) {
        const conds: ((r: any) => boolean)[] = [];
        let op: 'select' | 'insert' | 'update' = 'select';
        let payload: any = null;
        const b: any = {};
        b.select = () => b;
        b.eq = (c: string, v: unknown) => { conds.push((r) => r[c] === v); return b; };
        b.insert = (p: any) => { op = 'insert'; payload = p; return b; };
        b.update = (p: any) => { op = 'update'; payload = p; return b; };
        const run = () => {
            const filas = (tablas[table] ??= []);
            if (op === 'insert') { filas.push({ internal_note: false, ...payload }); return { data: null, error: null }; }
            const sel = filas.filter((r) => conds.every((c) => c(r)));
            if (op === 'update') { sel.forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
            return { data: sel, error: null };
        };
        b.maybeSingle = async () => ({ data: run().data?.[0] ?? null, error: null });
        b.then = (ok: any, ko: any) => Promise.resolve(run()).then(ok, ko);
        return b;
    }
    return { tablas, supabase: { from: (t: string) => builder(t) }, aviso: vi.fn(async () => undefined) };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./avisos-correo.service', () => ({ avisarTicketSoportePorCorreo: h.aviso }));

import { calificarRespuesta, feedbackDelTicket, leerFeedback, MENSAJE_NO_SIRVIO, notaDeFeedback } from './mapi-feedback.service';

beforeEach(() => {
    h.aviso.mockClear();
    h.tablas.support_tickets = [{ id: T, status: 'bot_handled' }];
    h.tablas.support_messages = [
        { id: USER_MSG, ticket_id: T, author_type: 'user', body: '¿Cómo tomo lista?', internal_note: false },
        { id: BOT, ticket_id: T, author_type: 'bot', body: '1. Abre **Asistencia**…', internal_note: false },
    ];
});

const visibles = () => h.tablas.support_messages.filter((m) => !m.internal_note);
const notas = () => h.tablas.support_messages.filter((m) => m.internal_note);

describe('calificarRespuesta', () => {
    it('«No»: nota interna, mensaje de Mapi, caso a waiting_human y correo no_sirvio', async () => {
        expect(await calificarRespuesta({ ticketId: T, messageId: BOT, valor: 'no' })).toBe('guardado');
        expect(notas()).toHaveLength(1);
        expect(notas()[0].body).toBe(notaDeFeedback(BOT, 'no'));
        expect(visibles().at(-1)).toMatchObject({ author_type: 'bot', body: MENSAJE_NO_SIRVIO });
        expect(h.tablas.support_tickets[0].status).toBe('waiting_human');
        expect(h.aviso).toHaveBeenCalledWith({ ticketId: T, origen: 'no_sirvio', respuestaId: BOT });
    });

    it('«Sí»: solo la nota; el caso sigue con Mapi y no hay correo', async () => {
        await calificarRespuesta({ ticketId: T, messageId: BOT, valor: 'si' });
        expect(notas()).toHaveLength(1);
        expect(visibles()).toHaveLength(2);
        expect(h.tablas.support_tickets[0].status).toBe('bot_handled');
        expect(h.aviso).not.toHaveBeenCalled();
        expect(await feedbackDelTicket(T)).toEqual({ [BOT]: 'si' });
    });

    it('una respuesta se califica una sola vez', async () => {
        await calificarRespuesta({ ticketId: T, messageId: BOT, valor: 'no' });
        expect(await calificarRespuesta({ ticketId: T, messageId: BOT, valor: 'no' })).toBe('ya_calificado');
        expect(notas()).toHaveLength(1);
        expect(h.aviso).toHaveBeenCalledTimes(1);
    });

    it('solo se califican respuestas de Mapi de ese ticket', async () => {
        expect(await calificarRespuesta({ ticketId: T, messageId: USER_MSG, valor: 'no' })).toBe('no_es_respuesta_de_mapi');
        expect(await calificarRespuesta({ ticketId: '44444444-4444-4444-8444-444444444444', messageId: BOT, valor: 'no' })).toBe('no_es_respuesta_de_mapi');
        expect(notas()).toHaveLength(0);
    });
});

describe('leerFeedback', () => {
    it('ignora notas internas que no son calificaciones', () => {
        expect(leerFeedback([
            { body: notaDeFeedback(BOT, 'no') },
            { body: 'Nota del agente: lo llamé por teléfono' },
            { body: `[mapi-feedback:${USER_MSG}:si] …` },
        ])).toEqual({ [BOT]: 'no', [USER_MSG]: 'si' });
    });
});
