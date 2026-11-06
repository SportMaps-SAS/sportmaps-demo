/**
 * De punta a punta por el turno del bot (auditorías Dynasty 2026-10-06):
 *   - incidencia urgente → escalación urgente con plazo, sin modelo;
 *   - salida del modelo con «Llamando escalate_to_human» → no llega a la familia
 *     y la conversación se escala de verdad;
 *   - pedir una persona dentro de la cortesía → escala, no ofrece franjas;
 *   - fallas del modelo → quedan en el payload del saliente.
 * Supabase, Meta y el modelo mockeados; mismo andamiaje que whatsapp-clase-cortesia-bot.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state = {
        inserts: [] as { table: string; row: any }[],
        rpcCalls: [] as { fn: string; args: any }[],
    };
    function resolve(table: string, ops: Ops): any {
        const head = ops.some(([m, a]) => m === 'select' && a[1]?.head);
        if (head) return { count: 0, error: null };
        if (table === 'whatsapp_conversations') {
            return { data: { id: 'conv-1', parent_id: 'parent-1', identified: true, status: 'closed', contact_name: 'Mamá' }, error: null };
        }
        if (table === 'whatsapp_settings') return { data: { ai_enabled: true, mode: 'auto' }, error: null };
        if (table === 'schools') return { data: { name: 'Dynasty', owner_id: 'owner-1' }, error: null };
        if (table === 'school_members') return { data: [{ profile_id: 'admin-1' }], error: null };
        if (table === 'whatsapp_messages') return { data: [], error: null };
        return { data: null, error: null };
    }
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lt', 'lte', 'or', 'order', 'limit', 'update', 'is', 'not']) {
            b[m] = (...a: any[]) => { ops.push([m, a]); return b; };
        }
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.upsert = (row: any) => {
            // notifications entra por upsert+ignoreDuplicates: se registra como insert y devuelve la fila.
            if (table === 'notifications') { state.inserts.push({ table, row }); b.__fila = row; }
            ops.push(['upsert', [row]]); return b;
        };
        b.maybeSingle = () => Promise.resolve(resolve(table, ops));
        b.single = b.maybeSingle;
        b.then = (res: any, rej: any) => Promise.resolve(b.__fila ? { data: [{ id: b.__fila.id }], error: null } : resolve(table, ops)).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: {
            from: (t: string) => makeBuilder(t),
            rpc: (fn: string, args: any) => {
                state.rpcCalls.push({ fn, args });
                if (fn === 'wa_identify_by_phone') return Promise.resolve({ data: { estado: 'identificado', parent_id: 'parent-1' }, error: null });
                return Promise.resolve({ data: [], error: null });
            },
        },
        chatWithTools: vi.fn(),
        sendTextMessage: vi.fn(),
        sendToUser: vi.fn(async () => ({ enabled: true, sent: 1, failed: 0, revoked: 0 })),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp-atencion.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-atencion.service')>('./whatsapp-atencion.service');
    return {
        ...real,
        botEncendido: vi.fn(async () => true),
        debeAtender: vi.fn(async () => ({ atender: true, tipo: 'familia', botEncendido: true, tomada: false })),
    };
});
vi.mock('./whatsapp-tomada.service', () => ({ conversacionTomada: vi.fn(async () => false) }));
vi.mock('./llm.service', () => ({ chatWithTools: h.chatWithTools }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: h.sendTextMessage,
    sendInteractiveButtons: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.btn' })),
    sendCtaUrl: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.cta' })),
    aFormatoWhatsApp: (t: string) => t,
    markAsRead: vi.fn(),
}));
vi.mock('./whatsapp-optin.service', () => ({ estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '' }));
vi.mock('./whatsapp-horario.service', () => ({
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: false })),
    mensajeDeEscalamiento: vi.fn(() => 'Voy a pasar tu caso con una persona del equipo. En breve te contactan.'),
}));
vi.mock('./push.service', () => ({ sendToUser: h.sendToUser }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('./whatsapp-ausencias.service', () => ({ atenderAusenciaEnBot: vi.fn(async () => false) }));
vi.mock('./whatsapp-enlaces-de-pago.service', () => ({
    conEnlacesDePago: vi.fn(async (p: any) => p), lineaPagar: vi.fn(() => null), botonPagarUnico: vi.fn(() => null),
}));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));

import { runBotTurn, _olvidarPresentaciones, _olvidarReservasDePaso } from './whatsapp-bot.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;

const salientes = () => h.state.rpcCalls.filter((c) => c.fn === 'wa_record_outbound_message').map((c) => c.args);
const textos = () => h.sendTextMessage.mock.calls.map((c) => String(c[2]));
const notificaciones = () => h.state.inserts.filter((i) => i.table === 'notifications').map((i) => i.row);

let n = 0;
const turno = (texto: string) => runBotTurn(INTEGRATION, 'conv-1', '573001112233', texto, `wamid.${++n}`);

beforeEach(() => {
    vi.clearAllMocks();
    h.state.inserts = [];
    h.state.rpcCalls = [];
    _olvidarPresentaciones();
    _olvidarReservasDePaso();
    h.sendTextMessage.mockResolvedValue({ ok: true, waMessageId: 'wamid.out' });
});

describe('incidencia urgente', () => {
    it('`62db6756`: «no han llegado a dar la clase» → escalación urgente con plazo de 10 min, sin modelo', async () => {
        await turno('Estamos varios en Colibrí y no han llegado a dar la clase');
        expect(h.chatWithTools).not.toHaveBeenCalled();
        const esc = salientes().find((s) => s.p_payload?.step === 'escalated');
        expect(esc?.p_payload).toMatchObject({ urgencia: 'urgente', categoria: 'clase', plazo_min: 10 });
        expect(textos().join('\n')).toContain('*urgente*');
        await new Promise((r) => setTimeout(r, 0));
        // In-app al admin y push urgente (el push del buzón se salta para no duplicar).
        expect(notificaciones().some((r) => r.user_id === 'admin-1' && r.data?.urgencia === 'urgente')).toBe(true);
        expect(h.sendToUser.mock.calls.some((c: any[]) => String(c[1]?.title).startsWith('URGENTE'))).toBe(true);
        expect(h.sendToUser.mock.calls.filter((c: any[]) => /espera respuesta/.test(String(c[1]?.title)))).toHaveLength(0);
    });

    it('pedir una persona sin urgencia → escalación normal con plazo de 30 min', async () => {
        await turno('Quiero hablar con una persona');
        const esc = salientes().find((s) => s.p_payload?.step === 'escalated');
        expect(esc?.p_payload).toMatchObject({ urgencia: 'normal', plazo_min: 30 });
    });
});

describe('salida del modelo', () => {
    it('`1bee1bba`: texto + «Llamando escalate_to_human» → sale limpio y se escala de verdad', async () => {
        h.chatWithTools.mockResolvedValue({
            text: 'Revisé tu caso y ya lo pasé a la escuela para que lo revisen.\nLlamando escalate_to_human',
            provider: 'claude',
        });
        await turno('Nos aparecen dos meses, septiembre lo pagamos el 5');
        const todo = textos().join('\n');
        expect(todo).not.toMatch(/escalate_to_human|Llamando/);
        expect(todo).toContain('Revisé tu caso');
        const pasos = salientes().map((s) => s.p_payload?.step);
        expect(pasos).toContain('llm_text');
        expect(pasos).toContain('escalated');
        expect(salientes().find((s) => s.p_payload?.step === 'llm_text')?.p_payload?.salida_filtrada).toBeTruthy();
    });

    it('solo andamiaje → respuesta segura (escalar), nada del modelo', async () => {
        h.chatWithTools.mockResolvedValue({ text: '{"tool":"get_payment_status"}', provider: 'groq' });
        await turno('¿Me ayudas con algo?');
        expect(textos().join('\n')).not.toMatch(/tool|get_payment_status|\{/);
        expect(salientes().map((s) => s.p_payload?.step)).toEqual(['escalated']);
    });

    it('fallas del modelo quedan en el payload del saliente', async () => {
        h.chatWithTools.mockResolvedValue({
            text: 'Con gusto te ayudo.', provider: 'groq',
            fallas: [{ proveedor: 'claude', error: 'claude_529: overloaded', ms: 900 }],
        });
        await turno('¿Me ayudas con algo?');
        expect(salientes()[0].p_payload.llm_fallas).toEqual([{ proveedor: 'claude', error: 'claude_529: overloaded', ms: 900 }]);
    });

    it('fallan todos: el respaldo lleva las fallas', async () => {
        const err: any = new Error('todos');
        err.fallas = [{ proveedor: 'claude', error: 'x', ms: 1 }, { proveedor: 'gemini', error: 'y', ms: 2 }];
        h.chatWithTools.mockRejectedValue(err);
        await turno('¿Me ayudas con algo?');
        expect(salientes()[0].p_payload.llm_fallas).toHaveLength(2);
    });
});

describe('cortesía: pedir una persona', () => {
    it('«quiero que me atienda alguien» por la herramienta de cortesía → escala, sin franjas', async () => {
        h.chatWithTools.mockResolvedValue({ toolCalls: [{ name: 'get_trial_class_info', args: {} }], provider: 'claude' });
        await turno('Sobre la clase de cortesía, quiero que me atienda alguien');
        expect(h.state.rpcCalls.some((c) => c.fn === 'list_open_trial_slots_public')).toBe(false);
        expect(salientes().map((s) => s.p_payload?.step)).toEqual(['escalated']);
    });
});

describe('cortesía por el modelo: pedir una persona', () => {
    it('la herramienta de cortesía con «que me atienda alguien» → escala, sin franjas', async () => {
        h.chatWithTools.mockResolvedValue({ toolCalls: [{ name: 'get_trial_class_info', args: {} }], provider: 'claude' });
        await turno('Para mi hija quiero que me atienda alguien, no sabemos en qué categoría quedaría');
        expect(h.state.rpcCalls.some((c) => c.fn === 'list_open_trial_slots_public')).toBe(false);
        expect(salientes().map((s) => s.p_payload?.step)).toEqual(['escalated']);
    });
});
