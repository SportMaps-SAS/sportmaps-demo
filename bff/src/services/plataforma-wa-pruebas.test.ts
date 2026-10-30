/**
 * Modo pruebas (spec canal-whatsapp-plataforma §3.4, D13): el turno simulado
 * corre con el cliente de Supabase ENVUELTO por el cortafuegos. Un bot de
 * mentira intenta escribir en tablas reales y avisar; nada llega al cliente
 * real, la conversación queda en la memoria de la sesión y lo que «salió» se
 * devuelve para mandárselo al tester.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
    const reales: string[] = [];
    const builder = (tabla: string) => {
        const b: any = {};
        let esEscritura = false;
        for (const m of ['select', 'eq', 'neq', 'in', 'ilike', 'order', 'limit']) b[m] = () => b;
        for (const m of ['insert', 'update', 'upsert', 'delete']) b[m] = () => { esEscritura = true; reales.push(`${m} ${tabla}`); return b; };
        const res = () => {
            if (tabla === 'school_whatsapp_integrations') return { data: [{ id: 'integ-real', school_id: 'esc', phone_number_id: '111', status: 'active' }], error: null };
            if (tabla === 'whatsapp_settings') return { data: { integration_id: 'integ-real', ai_enabled: false, mode: 'assisted', responder_prospectos: true }, error: null };
            return { data: esEscritura ? null : [], error: null };
        };
        b.maybeSingle = () => Promise.resolve(res());
        b.single = () => Promise.resolve(res());
        b.then = (ok: any, ko: any) => Promise.resolve(res()).then(ok, ko);
        return b;
    };
    const real = { from: (t: string) => builder(t), rpc: (fn: string) => { reales.push(`rpc ${fn}`); return Promise.resolve({ data: null, error: null }); } };
    return { reales, real, salidas: null as any[] | null };
});

vi.mock('../config/supabase', async () => {
    const { envolverCliente } = await import('../config/cortafuegos-simulacion');
    return { supabase: envolverCliente(h.real) };
});
vi.mock('./whatsapp-atencion.service', () => ({
    debeAtender: vi.fn(async () => ({ atender: true, tipo: 'familia', botEncendido: true, tomada: false })),
}));
vi.mock('./whatsapp-bot.service', async () => {
    const { supabase } = await import('../config/supabase');
    return {
        simularEnvios: async (fn: () => Promise<unknown>) => {
            const salidas: any[] = [];
            h.salidas = salidas;
            const resultado = await fn();
            return { resultado, salidas };
        },
        // El «bot»: lee la conversación, se identifica, intenta tocar datos reales y responde.
        runBotTurn: vi.fn(async (_i: any, conversationId: string, contacto: string, texto: string) => {
            const { data: conv } = await (supabase as any).from('whatsapp_conversations').select('id, parent_id, identified').eq('id', conversationId).maybeSingle();
            const { data: ident } = await (supabase as any).rpc('wa_identify_by_phone', { p_contact_wa_id: contacto });
            await (supabase as any).from('payments').update({ status: 'paid' }).eq('id', 'p1');
            await (supabase as any).from('notifications').insert({ title: 'escalación' });
            await (supabase as any).rpc('wa_register_optin', {});
            await (supabase as any).from('whatsapp_conversation_flows').upsert({ conversation_id: conversationId, flow: 'cortesia', step: 'elegir', data: {} }, { onConflict: 'conversation_id,flow' });
            h.salidas!.push({ texto: `eco: ${texto} · ${conv?.parent_id ?? 'sin'} · ${ident?.estado}`, step: 'prueba', botones: ['Ver horarios'], opciones: [{ id: 'sm_horarios', title: 'Ver horarios' }] });
        }),
        atenderDesconocido: vi.fn(async () => 'ok'),
    };
});

import { turnoSimulado, parsearComandoPrueba, contactoSintetico, type SesionPrueba } from './plataforma-wa-pruebas.service';
import { runBotTurn } from './whatsapp-bot.service';

beforeEach(() => { h.reales.length = 0; });

describe('parsearComandoPrueba', () => {
    it('reconoce los comandos', () => {
        expect(parsearComandoPrueba('/escuela dynasty-volley-club')).toEqual({ cmd: 'escuela', arg: 'dynasty-volley-club' });
        expect(parsearComandoPrueba('/como papá Juanita Prueba')).toEqual({ cmd: 'como_papa', arg: 'Juanita Prueba' });
        expect(parsearComandoPrueba('/como prospecto')).toEqual({ cmd: 'como_prospecto' });
        expect(parsearComandoPrueba('/estado')).toEqual({ cmd: 'estado' });
        expect(parsearComandoPrueba('/salir')).toEqual({ cmd: 'salir' });
        expect(parsearComandoPrueba('/escuela')).toEqual({ cmd: 'ayuda' });
        expect(parsearComandoPrueba('/loquesea')).toEqual({ cmd: 'desconocido', texto: '/loquesea' });
        expect(parsearComandoPrueba('hola')).toBeNull();
    });
    it('el contacto sintético no es el número del tester', () => {
        expect(contactoSintetico('573128463555')).toBe('573998463555');
        expect(contactoSintetico('573128463555')).not.toBe('573128463555');
    });
});

describe('turnoSimulado', () => {
    it('nada llega al cliente real; la conversación y los flujos quedan en la memoria de la sesión', async () => {
        const sesion: SesionPrueba = {
            contact_wa_id: '573128463555', school_id: 'esc', rol: 'papa', child_id: 'h1', parent_id: 'padre-prueba', estado: {},
        };
        const r = await turnoSimulado(sesion, { waMessageId: 'wamid.t1', textBody: 'cuánto debo', botonId: null });

        expect(h.reales).toEqual([]);
        expect(r.bloqueadas).toEqual(expect.arrayContaining(['update payments', 'insert notifications', 'rpc wa_register_optin']));
        expect(r.salidas).toHaveLength(1);
        expect(r.salidas[0].texto).toBe('eco: cuánto debo · padre-prueba · identificado');
        expect(r.salidas[0].opciones).toEqual([{ id: 'sm_horarios', title: 'Ver horarios' }]);

        // El bot vio la integración REAL de la escuela, sin token, y con el contacto sintético.
        const [integ, conversationId, contacto] = (runBotTurn as any).mock.calls[0];
        expect(integ).toMatchObject({ id: 'integ-real', school_id: 'esc', access_token_encrypted: null });
        expect(contacto).toBe('573998463555');

        const tablas = sesion.estado.tablas!;
        expect(sesion.estado.conversationId).toBe(conversationId);
        expect(tablas.whatsapp_messages.map((m) => m.direction)).toEqual(['inbound', 'outbound']);
        expect(tablas.whatsapp_conversation_flows).toHaveLength(1);
        expect(tablas.whatsapp_settings).toBeUndefined();
        expect(sesion.estado.bloqueadas).toEqual(r.bloqueadas);
    });

    it('el saliente en memoria guarda el payload de deliver: los flujos de varios pasos siguen al turno siguiente', async () => {
        (runBotTurn as any).mockImplementationOnce(async () => {
            h.salidas!.push({
                texto: '¿Qué día te queda mejor?', step: 'cortesia_elegir_dia', botones: ['Sábado'],
                opciones: [{ id: 'sm_cort_dia_1', title: 'Sábado' }],
                payload: { step: 'cortesia_elegir_dia', flujo: 'cortesia', paso_cortesia: 'elegir_dia', datos_cortesia: { anio: 2011 } },
            });
        });
        const sesion: SesionPrueba = { contact_wa_id: '573128463555', school_id: 'esc', rol: 'papa', child_id: 'h1', parent_id: 'padre-prueba', estado: {} };
        await turnoSimulado(sesion, { waMessageId: 'wamid.t3', textBody: 'clase de prueba', botonId: null });

        const saliente = sesion.estado.tablas!.whatsapp_messages.find((m) => m.direction === 'outbound');
        expect(saliente.payload).toEqual({
            step: 'cortesia_elegir_dia', flujo: 'cortesia', paso_cortesia: 'elegir_dia', datos_cortesia: { anio: 2011 },
            botones: ['sm_cort_dia_1'],
        });
    });

    it('como prospecto el teléfono no identifica a nadie', async () => {
        const sesion: SesionPrueba = { contact_wa_id: '573128463555', school_id: 'esc', rol: 'prospecto', child_id: null, parent_id: null, estado: {} };
        const r = await turnoSimulado(sesion, { waMessageId: 'wamid.t2', textBody: 'hola', botonId: null });
        expect(r.salidas[0].texto).toBe('eco: hola · sin · desconocido');
        expect(h.reales).toEqual([]);
    });
});
