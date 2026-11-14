/**
 * El turno de Mapi (análisis 2026-10-06): más de la mitad de las
 * respuestas eran la lista de links de respaldo o "dame un segundo" sin
 * respuesta detrás. Estas pruebas fijan que el bot redacta, sabe quién es el
 * usuario y nunca deja una promesa colgada.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
    const state = {
        historial: [] as { author_type: string; body: string }[],
        inserts: [] as { table: string; row: any }[],
        updates: [] as { table: string; row: any }[],
        orden: null as null | { ascending: boolean },
        statusTicket: null as null | string,
        filtros: [] as string[],
    };
    function builder(table: string) {
        const ops: string[] = [];
        const b: any = {};
        for (const m of ['select', 'is', 'limit', 'in']) b[m] = () => { ops.push(m); return b; };
        b.eq = (c: string, v: unknown) => { ops.push('eq'); state.filtros.push(`${table}.${c}=${v}`); return b; };
        b.order = (_c: string, o: any) => { ops.push('order'); state.orden = o; return b; };
        b.update = (row: any) => { state.updates.push({ table, row }); return b; };
        b.insert = (row: any) => { state.inserts.push({ table, row }); return b; };
        const resolver = () => {
            if (table === 'support_messages' && ops.includes('order')) return { data: state.historial, error: null };
            if (table === 'support_messages') return { count: 0, error: null };
            if (table === 'support_tickets' && state.statusTicket) return { data: { status: state.statusTicket }, error: null };
            return { data: null, error: null };
        };
        b.maybeSingle = async () => resolver();
        b.then = (ok: any, ko: any) => Promise.resolve(resolver()).then(ok, ko);
        return b;
    }
    return { state, supabase: { from: (t: string) => builder(t), rpc: async () => ({ data: [], error: null }) }, chat: vi.fn() };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./llm.service', () => ({ chatWithTools: h.chat }));
vi.mock('./support-diagnosis.service', () => ({ buildUserState: vi.fn(async () => ({})) }));
vi.mock('./avisos-correo.service', () => ({ avisarTicketSoportePorCorreo: vi.fn(async () => undefined) }));
vi.mock('./mapi-contexto.service', () => ({
    construirContextoMapi: vi.fn(async () => ({
        nombre: 'Carlos', roles: ['coach'], rolesVisibles: ['entrenador (coach)'],
        escuelaActiva: 'Carmel Club', otrasEscuelas: [], equiposQueEntrena: ['Sub 11'], modulosApagados: [],
    })),
    contextoComoTexto: (c: any) => `Nombre: ${c.nombre}\nEscuela activa: ${c.escuelaActiva}`,
}));
vi.mock('../data/app-map', () => ({ appMapParaRol: (roles: string[]) => `MAPA:${roles.join(',')}` }));

import { runSupportBotTurn, searchHelpArticles } from './inapp-support-bot.service';

const turno = () => runSupportBotTurn({ ticketId: 't-1', requesterId: 'u-1', schoolId: 's-1' });
const respuestasDelBot = () => h.state.inserts.filter((i) => i.table === 'support_messages').map((i) => i.row.body as string);
const estados = () => h.state.updates.filter((u) => u.table === 'support_tickets').map((u) => u.row.status);

beforeEach(() => {
    h.chat.mockReset();
    h.state.inserts = [];
    h.state.updates = [];
    h.state.historial = [{ author_type: 'user', body: 'quiero editar el nombre de mi equipo' }];
    h.state.statusTicket = null;
    h.state.filtros = [];
});

describe('Mapi: redacta en vez de mandar manuales', () => {
    it('busca, redacta con el resultado y agrega UN solo link como complemento', async () => {
        h.chat
            .mockResolvedValueOnce({ toolCalls: [{ name: 'search_help_articles', args: { query: 'editar equipo' } }], provider: 'test' })
            .mockResolvedValueOnce({ text: '1. Abre **Equipos**. 2. Toca el lápiz **Editar Equipo**.', provider: 'test' });
        await turno();
        const [body] = respuestasDelBot();
        expect(body).toContain('Editar Equipo');
        expect(body.match(/\/ayuda\//g)?.length ?? 0).toBeLessThanOrEqual(1);
        expect(body).not.toContain('Encontré esto que puede ayudarte');
        expect(estados()).toEqual(['bot_handled']);
    });

    it('si el modelo insiste en pedir tools, la última ronda va sin tools y obliga a redactar', async () => {
        const busca = { toolCalls: [{ name: 'search_help_articles', args: { query: 'equipo' } }], provider: 'test' };
        h.chat
            .mockResolvedValueOnce(busca)
            .mockResolvedValueOnce(busca)
            .mockResolvedValueOnce({ text: 'Ve a **Equipos** y toca el lápiz.', provider: 'test' });
        await turno();
        expect(h.chat).toHaveBeenCalledTimes(3);
        expect(h.chat.mock.calls[2][0].tools).toEqual([]);
        expect(respuestasDelBot()[0]).toContain('Equipos');
    });

    it('sin texto final nunca dice "dame un segundo": da el mejor artículo con su resumen', async () => {
        h.chat
            .mockResolvedValueOnce({ toolCalls: [{ name: 'search_help_articles', args: { query: 'tomar asistencia' } }], provider: 'test' })
            .mockResolvedValueOnce({ text: '', provider: 'test' });
        await turno();
        const [body] = respuestasDelBot();
        expect(body).not.toContain('dame un segundo');
        expect(body.match(/\/ayuda\//g)).toHaveLength(1);
    });

    it('sin texto y sin artículos pasa el caso a una persona', async () => {
        h.chat.mockResolvedValueOnce({ text: '', provider: 'test' });
        await turno();
        expect(estados()).toEqual(['waiting_human']);
    });

    it('si el LLM se cae en la primera llamada, escala', async () => {
        h.chat.mockRejectedValueOnce(new Error('todos los proveedores LLM fallaron'));
        await turno();
        expect(estados()).toEqual(['waiting_human']);
    });
});

describe('Mapi: sabe con quién habla', () => {
    it('el prompt lleva el usuario y el mapa de SUS roles', async () => {
        h.chat.mockResolvedValueOnce({ text: 'ok', provider: 'test' });
        await turno();
        const { system } = h.chat.mock.calls[0][0];
        expect(system).toContain('Carlos');
        expect(system).toContain('Carmel Club');
        expect(system).toContain('MAPA:coach');
    });

    it('lee los ÚLTIMOS mensajes del hilo y los entrega en orden cronológico', async () => {
        h.state.historial = [
            { author_type: 'user', body: 'el más reciente' },
            { author_type: 'bot', body: 'respuesta vieja' },
            { author_type: 'user', body: 'el más viejo' },
        ];
        h.chat.mockResolvedValueOnce({ text: 'ok', provider: 'test' });
        await turno();
        expect(h.state.orden).toEqual({ ascending: false });
        const { messages } = h.chat.mock.calls[0][0];
        expect(messages.map((m: any) => m.content)).toEqual(['el más viejo', 'respuesta vieja', 'el más reciente']);
    });
});

describe('searchHelpArticles', () => {
    it('"QR" a secas encuentra el artículo de QR (antes se descartaba por corto)', () => {
        expect(searchHelpArticles('QR').map((r) => r.slug)).toContain('qr-inscripcion-con-pago');
    });

    it('devuelve el contenido completo, no un recorte de 400 caracteres', () => {
        const [r] = searchHelpArticles('configurar sedes equipos staff');
        expect(r.contenido.length).toBeGreaterThan(400);
    });

    it('a un coach no le gana un artículo de organizador de eventos', () => {
        const slugs = searchHelpArticles('reportes', 3, ['coach']).map((r) => r.slug);
        expect(slugs[0]).not.toMatch(/^organizer-/);
    });
});

describe('quitarLinksInventados', () => {
    it('quita la línea con un /ayuda/ que no existe y deja los reales', async () => {
        const { quitarLinksInventados } = await import('./inapp-support-bot.service');
        const out = quitarLinksInventados('1. Abre **Equipos**.\n\nGuía completa: /ayuda/editar-equipo-coach\nVer también /ayuda/registrar-nuevo-atleta');
        expect(out).not.toContain('editar-equipo-coach');
        expect(out).toContain('/ayuda/registrar-nuevo-atleta');
        expect(out).toContain('Abre **Equipos**');
    });
});

describe('Mapi y los casos que esperan a una persona (2026-10-27)', () => {
    it('si el caso ya está en waiting_human (escaló o «No me sirvió»), responder no lo devuelve a bot_handled', async () => {
        h.state.statusTicket = 'waiting_human';
        h.chat.mockResolvedValueOnce({ text: 'Abre **Asistencia** > **Tomar lista**.', provider: 'test' });
        await turno();
        expect(respuestasDelBot()).toHaveLength(1);
        expect(estados()).toEqual([]);
    });

    it('el historial que va al modelo deja fuera las notas internas', async () => {
        h.chat.mockResolvedValueOnce({ text: 'Listo.', provider: 'test' });
        await turno();
        expect(h.state.filtros).toContain('support_messages.internal_note=false');
    });
});
