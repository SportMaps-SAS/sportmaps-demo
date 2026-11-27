/**
 * WhatsApp (capa 1 y 2): menú con botones/lista, clic que consulta sin modelo,
 * ids del menú que nunca confirman, texto que imita un id = texto, y tope
 * mensual. Base en memoria (ConsultaVirtual del cortafuegos) + Graph simulado;
 * el registro trae una consulta de prueba y una acción.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    db: { memoria: {} as Record<string, any[]>, rpc: {}, bloqueadas: [] as string[] },
    enviados: [] as { tipo: string; texto: string; botones?: { id: string; title: string }[] }[],
    turno: vi.fn(),
    cartera: vi.fn(),
    preparar: vi.fn(),
    ejecutar: vi.fn(),
}));

vi.mock('../../../config/supabase', async () => {
    const { ConsultaVirtual, envolverCliente } = await import('../../../config/cortafuegos-simulacion');
    const base = { from: (t: string) => new ConsultaVirtual(h.db as any, t), rpc: async () => ({ data: null, error: null }) };
    return { supabase: envolverCliente(base), supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba' };
});
vi.mock('../../whatsapp.service', () => {
    const enviar = (tipo: string) => vi.fn(async (_i: any, _to: string, texto: string, b?: any) => {
        h.enviados.push({ tipo, texto, ...(tipo === 'botones' ? { botones: b } : {}) });
        return { ok: true, waMessageId: `wamid.out${h.enviados.length}` };
    });
    return {
        sendTextMessage: enviar('texto'),
        sendInteractiveButtons: enviar('botones'),
        sendCtaUrl: enviar('enlace'),
        sendRawPayload: vi.fn(async () => ({ ok: true })),
        downloadMedia: vi.fn(),
        AUDIO_MIME_PERMITIDOS: new Set(['audio/ogg']),
        AUDIO_MAX_BYTES: 16 * 1024 * 1024,
        MAX_CUERPO_INTERACTIVO: 1024,
        MAX_TITULO_BOTON: 20,
    };
});
vi.mock('../../transcripcion.service', () => ({ transcribirAudio: vi.fn() }));
vi.mock('../agente', () => ({ turnoAgente: (...a: any[]) => h.turno(...a) }));
vi.mock('../registro', () => {
    const tools: any[] = [
        { tipo: 'consulta', nombre: 'cartera', roles: ['admin'], validar: (x: any) => x, ejecutar: (...a: any[]) => h.cartera(...a) },
        { tipo: 'accion', nombre: 'excusar_ausencia', roles: ['admin'], validar: (x: any) => x, preparar: (...a: any[]) => h.preparar(...a), ejecutar: (...a: any[]) => h.ejecutar(...a), mensajeResultado: () => 'ok' },
    ];
    return {
        CATALOGO: tools,
        buscarHerramienta: (n: string, a: any) => tools.find((t) => t.nombre === n && t.roles.includes(a.rol)) ?? null,
        herramientasPara: () => tools,
        definicionesApi: () => [],
    };
});

import { atenderMapiPorWhatsApp, _reiniciarEstadoCanal, TEXTOS, parsearBotonMapi } from '../canal-whatsapp';
import { TEXTOS_DIRECTO } from './enrutador';
import { TEXTO_TOPE } from './tope';
import type { Suscripcion } from '../../plataforma-wa.service';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const NUM = '573001112233';
const CANAL = { phone_number_id: '999', waba_id: '888', display_phone_number: '573202683539', access_token_encrypted: 'gcm:x', status: 'activo' };

const sub = (p: Partial<Suscripcion> = {}): Suscripcion => ({
    id: 'sub-1', school_id: A, profile_id: 'duena', contact_wa_id: NUM, estado: 'activa', origen: 'whatsapp',
    codigo: null, codigo_expira_at: null, activada_at: null, avisar_comprobantes: true, avisar_escalaciones: true, avisar_retiros: true,
    avisar_cortesias: true, avisar_resumen_diario: true, avisar_informe_cartera: true, silencio_desde: 22, silencio_hasta: 7, urgentes_en_silencio: true,
    ...p,
});

let n = 0;
const AHORA = Date.parse('2026-11-26T15:00:00.000Z');
const txt = (t: string) => ({
    phoneNumberId: '999', contactWaId: NUM, contactName: null, waMessageId: `wamid.in${++n}`, type: 'text', textBody: t,
    waTimestamp: new Date(AHORA).toISOString(), mediaId: null, mediaMimeType: null, mediaCaption: null, botonId: null, raw: {},
});
const clic = (id: string, titulo = 'Quién debe', tipo: 'button_reply' | 'list_reply' = 'list_reply') => ({
    ...txt(titulo), type: 'interactive', botonId: id, raw: { interactive: { type: tipo, [tipo]: { id, title: titulo } } },
});
const atender = (msg: any) => atenderMapiPorWhatsApp({ canal: CANAL as any, numero: NUM, msg, suscripciones: [sub()], ahora: AHORA });
const ultimo = () => h.enviados.at(-1)!;

const CARTERA = {
    corte: '2026-11-26', vencido: { total: '$240.000', familias: 2, deportistas: 2, cobros: 2 },
    por_mes: [], por_antiguedad: [], familias_que_mas_deben: [{ familia: 'Familia Pérez', deportistas: 1, total: '$120.000', meses: ['noviembre'], dias_de_mora: 21 }],
    por_vencer: { total: '$0', familias: 0 }, comprobantes_en_revision: { cobros: 0, total: '$0' },
};

beforeEach(() => {
    _reiniciarEstadoCanal();
    h.enviados.length = 0;
    for (const f of [h.turno, h.cartera, h.preparar, h.ejecutar]) f.mockReset();
    h.turno.mockResolvedValue({ tipo: 'texto', texto: 'Respuesta del modelo', borradores: [], herramientas: [], rondas: 1 });
    h.cartera.mockResolvedValue(CARTERA);
    h.db.memoria = {
        school_settings: [{ school_id: A, mapi_agent_enabled: true, coach_mapi_attendance: true, coach_mapi_notices: true, coach_hide_financial_info: false }],
        schools: [{ id: A, name: 'Dynasty', owner_id: 'duena' }],
        school_members: [{ school_id: A, profile_id: 'duena', role: 'owner', status: 'active' }],
        profiles: [{ id: 'duena', role: 'school', full_name: 'Milena' }],
        platform_wa_mensajes: [],
        llm_usage: [],
    };
});
afterEach(() => {
    delete process.env.MAPI_SIN_MODELO;
    delete process.env.MAPI_TOPE_TURNOS_MES;
});

describe('capa 1: menú y clic sin modelo', () => {
    it('«hola» muestra el menú del rol (solo lo disponible) y no llama al modelo', async () => {
        expect(await atender(txt('hola'))).toBe('mapi_directo');
        expect(h.turno).not.toHaveBeenCalled();
        expect(ultimo().tipo).toBe('botones');
        expect(ultimo().botones!.map((b) => b.id)).toEqual(['mapi:m:cartera']);
        expect(ultimo().texto).toBe(TEXTOS_DIRECTO.menuWhatsApp);
    });
    it('el clic en el menú ejecuta la consulta con el alcance revalidado', async () => {
        expect(await atender(clic('mapi:m:cartera'))).toBe('mapi_directo');
        expect(h.turno).not.toHaveBeenCalled();
        expect(h.cartera).toHaveBeenCalledTimes(1);
        const alcance = h.cartera.mock.calls[0][0];
        expect(alcance).toMatchObject({ schoolId: A, userId: 'duena', rol: 'admin', canal: 'whatsapp' });
        expect(ultimo().texto).toContain('*Cartera*');
        expect(ultimo().texto).toContain('Familia Pérez');
        expect(ultimo().texto).not.toContain('**');
    });
    it('también con button_reply', async () => {
        await atender(clic('mapi:m:cartera', 'Quién debe', 'button_reply'));
        expect(h.cartera).toHaveBeenCalledTimes(1);
    });
    it('sin permiso hoy (ya no es admin): el clic no consulta nada', async () => {
        h.db.memoria.school_members = [];
        expect(await atender(clic('mapi:m:cartera'))).toBe('mapi_sin_permiso');
        expect(h.cartera).not.toHaveBeenCalled();
    });
    it('los ids del menú no confirman propuestas ni ejecutan acciones', async () => {
        expect(parsearBotonMapi('mapi:m:cartera')).toBeNull();
        expect(parsearBotonMapi('mapi:q:o')).toBeNull();
        await atender(clic('mapi:m:excusar_ausencia', 'Excusar'));
        expect(ultimo().texto).toBe(TEXTOS_DIRECTO.opcionVencida);
        expect(h.preparar).not.toHaveBeenCalled();
        expect(h.ejecutar).not.toHaveBeenCalled();
        expect(h.db.memoria.mapi_action_drafts ?? []).toHaveLength(0);
        expect(h.turno).not.toHaveBeenCalled();
    });
    it('un TEXTO que imita un id del menú es texto: no consulta nada', async () => {
        expect(await atender(txt('mapi:m:cartera'))).toBe('mapi_imita_boton');
        expect(ultimo().texto).toBe(TEXTOS.imitaBoton);
        expect(h.cartera).not.toHaveBeenCalled();
        // Un mensaje «interactive» cuyo raw no coincide con el id tampoco es un clic.
        await atender({ ...clic('mapi:m:cartera'), raw: { interactive: { type: 'list_reply', list_reply: { id: 'otro' } } } });
        expect(h.cartera).not.toHaveBeenCalled();
    });
});

describe('capa 2: palabras clave', () => {
    it('«quién debe» responde sin modelo y queda en el historial que verá el modelo', async () => {
        expect(await atender(txt('quien debe x fa'))).toBe('mapi_directo');
        expect(h.turno).not.toHaveBeenCalled();
        expect(h.cartera).toHaveBeenCalledTimes(1);
        const salientes = h.db.memoria.platform_wa_mensajes.filter((m) => m.direccion === 'saliente');
        expect(salientes.at(-1)).toMatchObject({ paso: 'mapi_directo' });

        await atender(txt('ayúdame a escribirle algo bonito a esas familias'));
        expect(h.turno).toHaveBeenCalledTimes(1);
        const historial = h.turno.mock.calls[0][0].historial as { role: string; content: string }[];
        expect(historial.some((m) => m.role === 'assistant' && m.content.includes('Cartera'))).toBe(true);
    });
    it('las acciones van al modelo', async () => {
        await atender(txt('excusa a Samuel el viernes'));
        expect(h.turno).toHaveBeenCalledTimes(1);
        expect(h.cartera).not.toHaveBeenCalled();
    });
    it('MAPI_SIN_MODELO=false: todo al modelo, como antes', async () => {
        process.env.MAPI_SIN_MODELO = 'false';
        await atender(txt('quién debe'));
        expect(h.turno).toHaveBeenCalledTimes(1);
        expect(h.cartera).not.toHaveBeenCalled();
    });
});

describe('tope mensual en WhatsApp', () => {
    const uso = (school: string, feature = 'mapi_agente', created_at = '2026-11-20T12:00:00.000Z') => ({ school_id: school, feature, created_at, model: 'x' });
    it('al tope: el texto libre no llama al modelo; las consultas siguen', async () => {
        process.env.MAPI_TOPE_TURNOS_MES = '2';
        h.db.memoria.llm_usage = [uso(A), uso(A)];
        expect(await atender(txt('redáctame un mensaje para los papás'))).toBe('mapi_tope');
        expect(h.turno).not.toHaveBeenCalled();
        expect(ultimo().texto).toBe(TEXTO_TOPE);

        expect(await atender(txt('quién debe'))).toBe('mapi_directo');
        expect(h.cartera).toHaveBeenCalledTimes(1);
        expect(await atender(clic('mapi:m:cartera'))).toBe('mapi_directo');
        expect(h.turno).not.toHaveBeenCalled();
    });
    it('no cuentan otras escuelas, los evals ni el mes anterior', async () => {
        process.env.MAPI_TOPE_TURNOS_MES = '2';
        h.db.memoria.llm_usage = [uso(B), uso(B), uso(A, 'mapi_evals'), uso(A, 'mapi_evals'), uso(A, 'mapi_agente', '2026-11-01T04:59:59.000Z'), uso(A)];
        await atender(txt('redáctame un mensaje para los papás'));
        expect(h.turno).toHaveBeenCalledTimes(1);
    });
});
