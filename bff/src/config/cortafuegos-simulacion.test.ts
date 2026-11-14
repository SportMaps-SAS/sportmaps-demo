/**
 * Cortafuegos del modo pruebas (spec canal-whatsapp-plataforma, D13): dentro
 * del contexto NADA se escribe en tablas reales, la conversación vive en
 * memoria y no sale ninguna llamada con efecto. Fuera, el cliente es el real.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
    ConsultaVirtual, conCortafuegos, envolverCliente, enCortafuegos, instalarGuardiaFetch, urlConEfecto,
    valorDeColumna, aliasesDelSelect, type ContextoCortafuegos,
} from './cortafuegos-simulacion';

function ctx(memoria: Record<string, any[]> = {}, rpc: ContextoCortafuegos['rpc'] = {}): ContextoCortafuegos {
    return { memoria, rpc, bloqueadas: [] };
}

/** Un cliente "real" de mentira que anota lo que le llega. */
function clienteFalso() {
    const llamadas: string[] = [];
    const builder = (tabla: string) => {
        const b: any = {};
        for (const m of ['select', 'eq', 'limit', 'maybeSingle']) b[m] = () => { llamadas.push(`${m} ${tabla}`); return b; };
        for (const m of ['insert', 'update', 'upsert', 'delete']) b[m] = () => { llamadas.push(`${m} ${tabla}`); return b; };
        b.then = (ok: any) => Promise.resolve({ data: [{ id: 'real' }], error: null }).then(ok);
        return b;
    };
    const cliente = {
        from: (t: string) => builder(t),
        rpc: (fn: string) => { llamadas.push(`rpc ${fn}`); return Promise.resolve({ data: 'real', error: null }); },
        functions: { invoke: () => { llamadas.push('invoke'); return Promise.resolve({ data: 'real', error: null }); } },
        storage: { from: () => ({ upload: () => { llamadas.push('upload'); return Promise.resolve({ data: 'real', error: null }); } }) },
    };
    return { cliente, llamadas };
}

describe('ConsultaVirtual', () => {
    it('filtra, ordena y limita sobre la memoria; maybeSingle devuelve una fila o null', async () => {
        const c = ctx({ whatsapp_messages: [
            { id: '1', conversation_id: 'a', direction: 'inbound', created_at: '2026-10-09T10:00:00.000Z', payload: { step: 'x' } },
            { id: '2', conversation_id: 'a', direction: 'outbound', created_at: '2026-10-09T11:00:00.000Z', payload: { step: 'y' } },
            { id: '3', conversation_id: 'b', direction: 'outbound', created_at: '2026-10-09T12:00:00.000Z', payload: { step: 'y' } },
        ] });
        const r1: any = await new ConsultaVirtual(c, 'whatsapp_messages').select('*').eq('conversation_id', 'a')
            .order('created_at', { ascending: false }).limit(1);
        expect(r1.data.map((f: any) => f.id)).toEqual(['2']);
        const r2: any = await new ConsultaVirtual(c, 'whatsapp_messages').select('id').eq('payload->>step', 'y').in('conversation_id', ['b']).maybeSingle();
        expect(r2.data.id).toBe('3');
        const r3: any = await new ConsultaVirtual(c, 'whatsapp_messages').select('id').eq('conversation_id', 'zz').maybeSingle();
        expect(r3).toMatchObject({ data: null, error: null });
        const r4: any = await new ConsultaVirtual(c, 'whatsapp_messages').select('id').gte('created_at', '2026-10-09T11:00:00.000Z').not('direction', 'eq', 'inbound');
        expect(r4.data.map((f: any) => f.id)).toEqual(['2', '3']);
    });

    it('insert respeta la unicidad (23505) y upsert con onConflict reemplaza', async () => {
        const c = ctx({});
        await new ConsultaVirtual(c, 'whatsapp_conversation_flows').insert({ conversation_id: 'a', flow: 'cortesia', step: 'uno', data: {} });
        const dup: any = await new ConsultaVirtual(c, 'whatsapp_conversation_flows').insert({ conversation_id: 'a', flow: 'cortesia', step: 'dos', data: {} });
        expect(dup.error.code).toBe('23505');
        const up: any = await new ConsultaVirtual(c, 'whatsapp_conversation_flows')
            .upsert({ conversation_id: 'a', flow: 'cortesia', step: 'tres', data: { x: 1 } }, { onConflict: 'conversation_id,flow' }).select('*').single();
        expect(up.data.step).toBe('tres');
        expect(c.memoria.whatsapp_conversation_flows).toHaveLength(1);
    });

    it('update y delete tocan solo lo filtrado', async () => {
        const c = ctx({ whatsapp_conversations: [{ id: 'a', status: 'open' }, { id: 'b', status: 'open' }] });
        await new ConsultaVirtual(c, 'whatsapp_conversations').update({ status: 'closed' }).eq('id', 'a');
        expect(c.memoria.whatsapp_conversations.map((f) => f.status)).toEqual(['closed', 'open']);
        await new ConsultaVirtual(c, 'whatsapp_conversations').delete().eq('id', 'b');
        expect(c.memoria.whatsapp_conversations.map((f) => f.id)).toEqual(['a']);
    });

    it('valorDeColumna entiende -> y ->>', () => {
        expect(valorDeColumna({ payload: { a: { b: 3 } } }, 'payload->a->>b')).toBe('3');
        expect(valorDeColumna({ payload: { a: 1 } }, 'payload->a')).toBe(1);
    });

    it('los alias del select (`x:payload->>x`, `x:col->a->>b`, `col->>x`) salen como columnas, como en PostgREST', async () => {
        expect(aliasesDelSelect('direction, step:payload->>step, s:source_detail->servicio_interes->>id, payload->>caption, nombre:name, hijos(id, nombre)'))
            .toEqual([
                { alias: 'step', expr: 'payload->>step' },
                { alias: 's', expr: 'source_detail->servicio_interes->>id' },
                { alias: 'caption', expr: 'payload->>caption' },
                { alias: 'nombre', expr: 'name' },
            ]);
        expect(aliasesDelSelect('*')).toEqual([]);
        // Lo que lee `mensajesParaVenta` (whatsapp-venta-contexto.db): la marca de la venta en simulación.
        const c = ctx({ whatsapp_messages: [
            { id: '1', conversation_id: 'a', direction: 'outbound', created_at: '2026-11-08T10:00:00.000Z',
                payload: { venta_servicio_id: 'srv-1', step: 'venta_servicio_pago', n: 5, anidado: { id: 'x' } } },
        ] });
        const r: any = await new ConsultaVirtual(c, 'whatsapp_messages')
            .select('direction, venta_servicio_id:payload->>venta_servicio_id, step:payload->>step, n:payload->>n, campana_id:payload->>campana_id, id_anidado:payload->anidado->>id')
            .eq('conversation_id', 'a');
        expect(r.data[0]).toMatchObject({ direction: 'outbound', venta_servicio_id: 'srv-1', step: 'venta_servicio_pago', n: '5', campana_id: null, id_anidado: 'x' });
        // La memoria no se toca (el alias va solo en la copia que sale).
        expect(c.memoria.whatsapp_messages[0]).not.toHaveProperty('step');
    });
});

describe('envolverCliente', () => {
    it('fuera del cortafuegos no cambia nada', async () => {
        const { cliente, llamadas } = clienteFalso();
        const s: any = envolverCliente(cliente);
        expect(enCortafuegos()).toBe(false);
        await s.from('payments').update({ status: 'paid' }).eq('id', 'x');
        await s.rpc('auto_approve_payment');
        expect(llamadas).toEqual(['update payments', 'eq payments', 'rpc auto_approve_payment']);
    });

    it('dentro: escrituras reales bloqueadas con SIM00, lecturas reales pasan, la conversación va a memoria', async () => {
        const { cliente, llamadas } = clienteFalso();
        const s: any = envolverCliente(cliente);
        const c = ctx({ whatsapp_conversations: [{ id: 'conv', identified: true, parent_id: 'p1' }] });
        await conCortafuegos(c, async () => {
            const w: any = await s.from('payments').update({ status: 'paid' }).eq('id', 'x');
            expect(w.error.code).toBe('SIM00');
            const ins: any = await s.from('school_signup_leads').insert({ full_name: 'x' }).select('id').single();
            expect(ins).toMatchObject({ data: null, error: { code: 'SIM00' } });
            const r: any = await s.from('schools').select('id').eq('id', 's');
            expect(r.data).toEqual([{ id: 'real' }]);
            const conv: any = await s.from('whatsapp_conversations').select('id, parent_id').eq('id', 'conv').maybeSingle();
            expect(conv.data.parent_id).toBe('p1');
            await s.from('whatsapp_messages').insert({ conversation_id: 'conv', direction: 'outbound', text_body: 'hola' });
        });
        expect(llamadas).toEqual(['select schools', 'eq schools']);
        expect(c.bloqueadas).toEqual(['update payments', 'insert school_signup_leads']);
        expect(c.memoria.whatsapp_messages).toHaveLength(1);
    });

    it('dentro: rpc con override, allowlist STABLE pasa, el resto se bloquea; functions y storage también', async () => {
        const { cliente, llamadas } = clienteFalso();
        const s: any = envolverCliente(cliente);
        const c = ctx({}, { wa_identify_by_phone: () => ({ estado: 'identificado', parent_id: 'p1' }) });
        await conCortafuegos(c, async () => {
            expect((await s.rpc('wa_identify_by_phone', {})).data).toEqual({ estado: 'identificado', parent_id: 'p1' });
            expect((await s.rpc('wa_get_payment_status', {})).data).toBe('real');
            expect((await s.rpc('wa_register_optin', {})).error.code).toBe('SIM00');
            expect((await s.rpc('auto_approve_payment', {})).error.code).toBe('SIM00');
            expect((await s.functions.invoke('send-email', {})).error.code).toBe('SIM00');
            expect((await s.storage.from('x').upload('a', 'b')).error.code).toBe('SIM00');
        });
        expect(llamadas).toEqual(['rpc wa_get_payment_status']);
        expect(c.bloqueadas).toEqual(expect.arrayContaining(['rpc wa_register_optin', 'rpc auto_approve_payment']));
    });
});

describe('guardia de fetch', () => {
    const original = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    beforeAll(() => {
        (globalThis as any).__guardiaFetchSimulacion = false;
        (globalThis as any).fetch = original;
        instalarGuardiaFetch();
    });

    it('urlConEfecto: Graph, edge functions, Resend, pasarelas y FCM; no la REST de Supabase ni el LLM', () => {
        expect(urlConEfecto('https://graph.facebook.com/v21.0/123/messages')).toBe(true);
        expect(urlConEfecto('https://abc.supabase.co/functions/v1/send-email')).toBe(true);
        expect(urlConEfecto('https://api.resend.com/emails')).toBe(true);
        expect(urlConEfecto('https://production.wompi.co/v1/transactions')).toBe(true);
        expect(urlConEfecto('https://abc.supabase.co/rest/v1/payments')).toBe(false);
        expect(urlConEfecto('https://api.groq.com/openai/v1/chat/completions')).toBe(false);
    });

    it('dentro devuelve 503 sin llamar; fuera llama al fetch original', async () => {
        const c = ctx();
        const dentro = await conCortafuegos(c, () => fetch('https://graph.facebook.com/v21.0/1/messages', { method: 'POST' }));
        expect(dentro.status).toBe(503);
        expect(original).not.toHaveBeenCalled();
        expect(c.bloqueadas[0]).toMatch(/^fetch graph\.facebook\.com/);
        const fuera = await fetch('https://graph.facebook.com/v21.0/1/messages');
        expect(fuera.status).toBe(200);
        expect(original).toHaveBeenCalledTimes(1);
    });
});
