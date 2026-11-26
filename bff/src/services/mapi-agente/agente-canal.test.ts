/**
 * `turnoAgente` con `canal` (plan mapi-admin-por-whatsapp §12.2.5): la app sigue
 * exactamente igual y WhatsApp cambia solo el contexto del turno (después del
 * corte de caché), las propuestas pendientes (por usuario y escuela) y el hilo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ responder: (_c: any): any => undefined }));

vi.mock('../../config/supabase', async () => {
    const { crearSupabaseFalso } = await import('./supabase-falso.test-helper');
    const falso = crearSupabaseFalso((c) => h.responder(c));
    (globalThis as any).__consultas = falso.consultas;
    return { supabase: falso.supabase, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba' };
});
vi.mock('../../data/app-map', () => ({ appMapParaRol: () => 'Menú › Deportistas' }));

import { turnoAgente, conLineasDeContexto, LINEAS_CANAL_WHATSAPP, DESCARTAR } from './agente';
import { eqDe, type Consulta } from './supabase-falso.test-helper';
import type { Alcance } from './tipos';

const ESCUELA = '11111111-1111-1111-1111-111111111111';
const admin: Alcance = {
    schoolId: ESCUELA, userId: 'u-admin', rol: 'admin', teamIds: [],
    ajustes: { coachMapiAttendance: true, coachMapiNotices: true, coachHideFinancialInfo: false }, hoy: '2026-11-26',
};
const consultas = () => (globalThis as any).__consultas as Consulta[];
const pendiente = { id: 'b-1', tool: 'excusar_ausencia', status: 'draft', preview: { titulo: 'Excusar a Mariana', lineas: ['Del 24 al 28'] }, expires_at: '2099-01-01T00:00:00Z', created_at: '2026-11-26T10:00:00Z' };

async function correr(p: Partial<Parameters<typeof turnoAgente>[0]>) {
    const cuerpos: any[] = [];
    const r = await turnoAgente({
        alcance: admin, ticketId: null, historial: [{ role: 'user', content: 'hola' }],
        crearMensaje: async (body) => { cuerpos.push(JSON.parse(JSON.stringify(body))); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hola **Milena**' }], usage: {} }; },
        ...p,
    } as any);
    return { r, body: cuerpos[0] };
}
const contextoDe = (body: any) => body.messages.at(-1).content[0].text as string;
const nombresDe = (body: any) => body.tools.map((t: any) => t.name) as string[];

beforeEach(() => {
    consultas().length = 0;
    h.responder = (c) => (c.tabla === 'mapi_action_drafts' && c.op === 'select' ? { data: [pendiente] } : undefined);
});

describe('la app sigue igual', () => {
    it('con hilo: descartar, pendientes del ticket, sin reglas de WhatsApp', async () => {
        const { body } = await correr({ ticketId: 'tk-1' });
        expect(nombresDe(body)).toContain(DESCARTAR);
        expect(contextoDe(body)).not.toContain('Canal: WhatsApp');
        expect(contextoDe(body)).toContain('p1: Excusar a Mariana');
        const lectura = consultas().find((c) => c.tabla === 'mapi_action_drafts' && c.op === 'select')!;
        expect(eqDe(lectura, 'ticket_id')).toBe('tk-1');
    });
    it('sin hilo (como antes): ni descartar ni pendientes', async () => {
        const { body } = await correr({ ticketId: null });
        expect(nombresDe(body)).not.toContain(DESCARTAR);
        expect(contextoDe(body)).not.toContain('PENDIENTES');
        expect(consultas().some((c) => c.tabla === 'mapi_action_drafts')).toBe(false);
    });
});

describe('canal whatsapp', () => {
    it('reglas de formato DENTRO del contexto; las pendientes por usuario y escuela, sin hilo', async () => {
        const { r, body } = await correr({ canal: 'whatsapp', pantalla: { ruta: '/finances', entidad: null } });
        const ctx = contextoDe(body);
        expect(ctx.indexOf('Canal: WhatsApp')).toBeGreaterThan(-1);
        expect(ctx.indexOf('Canal: WhatsApp')).toBeLessThan(ctx.indexOf('</contexto_del_turno>'));
        expect(ctx).not.toContain('Pantalla abierta');
        expect(ctx).toContain('p1: Excusar a Mariana');
        expect(nombresDe(body)).toContain(DESCARTAR);
        const lectura = consultas().find((c) => c.tabla === 'mapi_action_drafts' && c.op === 'select')!;
        expect(eqDe(lectura, 'user_id')).toBe('u-admin');
        expect(eqDe(lectura, 'school_id')).toBe(ESCUELA);
        expect(lectura.filtros).toContainEqual(['is', 'ticket_id', null]);
        // El texto vuelve tal cual: el formato de WhatsApp lo aplica el adaptador.
        expect(r).toMatchObject({ tipo: 'texto', texto: 'Hola **Milena**' });
    });
    it('la caché: el sistema y las herramientas son los mismos que en la app con hilo', async () => {
        const app = (await correr({ ticketId: 'tk-1' })).body;
        consultas().length = 0;
        const wa = (await correr({ canal: 'whatsapp' })).body;
        expect(JSON.stringify(wa.system)).toBe(JSON.stringify(app.system));
        expect(JSON.stringify(wa.tools)).toBe(JSON.stringify(app.tools));
    });
    it('conLineasDeContexto mete las líneas antes del cierre', () => {
        const c = conLineasDeContexto('<contexto_del_turno>\nHoy: x\n</contexto_del_turno>', ['a', 'b']);
        expect(c).toBe('<contexto_del_turno>\nHoy: x\na\nb\n</contexto_del_turno>');
        expect(conLineasDeContexto('x', [])).toBe('x');
        expect(LINEAS_CANAL_WHATSAPP.join(' ')).toMatch(/UN solo asterisco/);
    });
});
