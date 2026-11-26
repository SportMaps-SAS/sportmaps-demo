/**
 * Mapi por WhatsApp (plan mapi-admin-por-whatsapp §12.8.1): supabase en memoria
 * (el ConsultaVirtual del cortafuegos) + Graph simulado. El modelo va simulado:
 * el turno falso deja borradores con el `crearBorrador` real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    db: { memoria: {} as Record<string, any[]>, rpc: {}, bloqueadas: [] as string[] },
    enviados: [] as { tipo: string; to: string; texto: string; botones?: { id: string; title: string }[]; url?: string }[],
    turno: vi.fn(),
    transcribir: vi.fn(),
    bajar: vi.fn(),
    preparar: vi.fn(),
    ejecutar: vi.fn(),
    segundoPlano: false,
}));

vi.mock('../../config/supabase', async () => {
    const { ConsultaVirtual, envolverCliente } = await import('../../config/cortafuegos-simulacion');
    const base = { from: (t: string) => new ConsultaVirtual(h.db as any, t), rpc: async () => ({ data: null, error: null }) };
    return { supabase: envolverCliente(base), supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba' };
});
vi.mock('../whatsapp.service', () => {
    const enviar = (tipo: string) => vi.fn(async (_i: any, to: string, texto: string, b?: any, url?: string) => {
        h.enviados.push({ tipo, to, texto, ...(tipo === 'botones' ? { botones: b } : {}), ...(tipo === 'enlace' ? { url } : {}) });
        return { ok: true, waMessageId: `wamid.out${h.enviados.length}` };
    });
    return {
        sendTextMessage: enviar('texto'),
        sendInteractiveButtons: enviar('botones'),
        sendCtaUrl: vi.fn(async (_i: any, to: string, texto: string, _boton: string, url: string) => {
            h.enviados.push({ tipo: 'enlace', to, texto, url });
            return { ok: true, waMessageId: `wamid.out${h.enviados.length}` };
        }),
        sendRawPayload: vi.fn(async () => ({ ok: true })),
        downloadMedia: (...a: any[]) => h.bajar(...a),
        AUDIO_MIME_PERMITIDOS: new Set(['audio/ogg']),
        AUDIO_MAX_BYTES: 16 * 1024 * 1024,
        MAX_CUERPO_INTERACTIVO: 1024,
        MAX_TITULO_BOTON: 20,
    };
});
vi.mock('../transcripcion.service', () => ({ transcribirAudio: (...a: any[]) => h.transcribir(...a) }));
vi.mock('./agente', () => ({ turnoAgente: (...a: any[]) => h.turno(...a) }));
vi.mock('./registro', () => {
    const accion = (nombre: string, plata = false) => ({
        tipo: 'accion', nombre, plata, roles: ['admin'], validar: (x: any) => x,
        preparar: (...a: any[]) => h.preparar(...a), ejecutar: (...a: any[]) => h.ejecutar(...a),
        mensajeResultado: () => 'Quedó **registrada**.',
        get segundoPlano() { return h.segundoPlano; },
    });
    const tools = [accion('excusar_ausencia'), accion('crear_cobro_unico', true)];
    return {
        CATALOGO: tools,
        buscarHerramienta: (n: string, a: any) => tools.find((t) => t.nombre === n && t.roles.includes(a.rol)) ?? null,
        herramientasPara: () => tools,
        definicionesApi: () => [],
    };
});

import {
    aFormatoWhatsApp, partirMensaje, cuerpoDeTarjeta, botonesDeTarjeta, parsearBotonMapi, esRespuestaBotonMapi,
    esAsentimientoSuelto, atenderMapiPorWhatsApp, atenderMapiPrueba, _reiniciarEstadoCanal, TEXTOS, confirmablePorWhatsApp,
    hashCodigo,
} from './canal-whatsapp';
import { crearBorrador, hashDe } from './borradores';
import { supabase } from '../../config/supabase';
import type { Suscripcion } from '../plataforma-wa.service';
import type { VistaPrevia } from './tipos';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const NUM = '573001112233';
const OTRO = '573009998877';
const CANAL = { phone_number_id: '999', waba_id: '888', display_phone_number: '573202683539', access_token_encrypted: 'gcm:x', status: 'activo' };

const vista: VistaPrevia = { titulo: 'Excusar a Mariana López', lineas: ['Del lunes 24 al viernes 28'], botonConfirmar: 'Excusar' };
const vistaCobro: VistaPrevia = { titulo: 'Cobro único: uniforme', lineas: ['23 deportistas · $80.000 c/u'], botonConfirmar: 'Crear cobros' };

const sub = (p: Partial<Suscripcion> = {}): Suscripcion => ({
    id: `sub-${p.school_id ?? A}-${p.profile_id ?? 'duena'}`, school_id: A, profile_id: 'duena', contact_wa_id: NUM, estado: 'activa', origen: 'whatsapp',
    codigo: null, codigo_expira_at: null, activada_at: null, avisar_comprobantes: true, avisar_escalaciones: true, avisar_retiros: true,
    avisar_cortesias: true, avisar_resumen_diario: true, avisar_informe_cartera: true, silencio_desde: 22, silencio_hasta: 7, urgentes_en_silencio: true,
    ...p,
});

let AHORA = Date.now();
let ultimo = 0;
const txt = (t: string, de = NUM) => ({
    phoneNumberId: '999', contactWaId: de, contactName: null, waMessageId: `wamid.in${++ultimo}`, type: 'text', textBody: t,
    waTimestamp: new Date(AHORA).toISOString(), mediaId: null, mediaMimeType: null, mediaCaption: null, botonId: null, raw: {},
});
const clic = (botonId: string, de = NUM, titulo = 'Confirmar') => ({
    ...txt(titulo, de), type: 'interactive', botonId,
    raw: { interactive: { type: 'button_reply', button_reply: { id: botonId, title: titulo } } },
});
const audio = () => ({ ...txt('', NUM), type: 'audio', textBody: null, mediaId: 'media-1', mediaMimeType: 'audio/ogg' });

/** El turno falso: deja un borrador con la herramienta pedida (como lo haría el modelo). */
function turnoQueProponer(tool = 'excusar_ausencia', v: VistaPrevia = vista, args: any = { deportista: 'child:x' }) {
    h.turno.mockImplementation(async (p: any) => {
        const herramienta: any = { nombre: tool };
        const fila = await crearBorrador({
            alcance: p.alcance, ticketId: null, herramienta,
            preparado: { ok: true, args, vista: v, targetKey: null, huella: { x: 1 } },
        });
        return { tipo: 'texto', texto: 'Te dejé la propuesta **abajo**.', borradores: [fila.id], herramientas: [tool], rondas: 2 };
    });
    // Al confirmar, preparar devuelve lo mismo: el hash coincide.
    h.preparar.mockResolvedValue({ ok: true, args, vista: v, targetKey: null, huella: { x: 1 } });
}

const atender = (msg: any, subs: Suscripcion[] = [sub()], ahora = AHORA) =>
    atenderMapiPorWhatsApp({ canal: CANAL as any, numero: msg.contactWaId, msg, suscripciones: subs, ahora });

const botones = () => h.enviados.filter((e) => e.tipo === 'botones').at(-1)?.botones ?? [];
const idDe = (accion: 'c' | 'x' | 'l') => botones().find((b) => b.id.startsWith(`mapi:${accion}:`))!.id;
const borradores = () => h.db.memoria.mapi_action_drafts ?? [];
const textos = () => h.enviados.map((e) => e.texto);

beforeEach(() => {
    AHORA = Date.now();
    _reiniciarEstadoCanal();
    h.enviados.length = 0;
    h.db.bloqueadas.length = 0;
    h.segundoPlano = false;
    for (const f of [h.turno, h.transcribir, h.bajar, h.preparar, h.ejecutar]) f.mockReset();
    h.ejecutar.mockResolvedValue({ estado: 'executed', resultado: { ok: true } });
    h.db.memoria = {
        school_settings: [
            { school_id: A, mapi_agent_enabled: true, coach_mapi_attendance: true, coach_mapi_notices: true, coach_hide_financial_info: false },
            { school_id: B, mapi_agent_enabled: true },
        ],
        schools: [{ id: A, name: 'Dynasty', owner_id: 'duena' }, { id: B, name: 'Monster', owner_id: 'ivan' }],
        school_members: [
            { school_id: A, profile_id: 'duena', role: 'owner', status: 'active' },
            { school_id: A, profile_id: 'admin2', role: 'admin', status: 'active' },
            { school_id: B, profile_id: 'duena', role: 'admin', status: 'active' },
            { school_id: A, profile_id: 'coach1', role: 'coach', status: 'active' },
        ],
        profiles: [
            { id: 'duena', role: 'school', full_name: 'Milena' },
            { id: 'admin2', role: 'school', full_name: 'Otra admin' },
            { id: 'coach1', role: 'coach', full_name: 'Profe' },
        ],
        platform_wa_mensajes: [],
    };
});
afterEach(() => {
    delete process.env.MAPI_WA_PLATA_POR_HORA;
    delete process.env.MAPI_AGENT_ENABLED;
});

// ─── Formato ─────────────────────────────────────────────────────────────────

describe('formato y partición', () => {
    it('markdown de la app → WhatsApp', () => {
        const t = aFormatoWhatsApp('## Pagos\n**Mariana** debe $80.000\n- uno\n* dos\nVe a [Finanzas](/finances) o [la web](https://sportmaps.co)');
        expect(t).toContain('*Pagos*');
        expect(t).toContain('*Mariana* debe');
        expect(t).not.toContain('**');
        expect(t).toContain('• uno\n• dos');
        expect(t).toContain('Ve a Finanzas o la web: https://sportmaps.co');
        expect(t).not.toContain('/finances');
    });
    it('una tabla queda en líneas', () => {
        expect(aFormatoWhatsApp('| Nombre | Debe |\n|---|---|\n| Ana | $10 |')).toBe('Nombre · Debe\nAna · $10');
    });
    it('parte en mensajes de ≤ 4.000 sin perder texto', () => {
        const largo = Array.from({ length: 300 }, (_, i) => `Línea ${i} con algo de texto para llenar el mensaje.`).join('\n');
        const partes = partirMensaje(largo);
        expect(partes.length).toBeGreaterThan(1);
        for (const p of partes) expect(p.length).toBeLessThanOrEqual(4000);
        expect(partes.join('\n').replace(/\s+/g, ' ')).toBe(largo.replace(/\s+/g, ' '));
    });
});

describe('tarjeta y botones', () => {
    it('cuerpo ≤ 1.024 aunque las líneas sean enormes; título y nota se conservan', () => {
        const v: VistaPrevia = { titulo: 'Recordatorio a 300 familias', lineas: Array.from({ length: 200 }, (_, i) => `Familia ${i}`), aviso: 'No se puede deshacer', botonConfirmar: 'Enviar' };
        const c = cuerpoDeTarjeta(v, { venceMin: 30, confirmable: true });
        expect(c.length).toBeLessThanOrEqual(1024);
        expect(c.startsWith('*Recordatorio a 300 familias*')).toBe(true);
        expect(c).toContain('⚠️ No se puede deshacer');
        expect(c).toContain('vence en 30 min');
    });
    it('Confirmar / Cancelar / Ver lista, títulos ≤ 20, id con borrador y código', () => {
        const v: VistaPrevia = { ...vista, detalle: { etiqueta: 'Familias', items: ['a', 'b'] } };
        const b = botonesDeTarjeta('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ABCDEFGH', v, true);
        expect(b.map((x) => x.title)).toEqual(['Confirmar', 'Cancelar', 'Ver lista']);
        for (const x of b) expect(Array.from(x.title).length).toBeLessThanOrEqual(20);
        expect(b[0].id).toBe('mapi:c:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:ABCDEFGH');
        expect(parsearBotonMapi(b[2].id)).toEqual({ tipo: 'accion', accion: 'l', borrador: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', codigo: 'ABCDEFGH' });
    });
    it('plata por encima del tope o de nivel 3: sin Confirmar', () => {
        expect(confirmablePorWhatsApp({ tool: 'crear_cobro_unico', args: { monto: 80_000 } })).toBe(true);
        expect(confirmablePorWhatsApp({ tool: 'crear_cobro_unico', args: { monto: 450_000 } })).toBe(false);
        expect(confirmablePorWhatsApp({ tool: 'aprobar_comprobante', args: { nivel: 3, monto: 10 } })).toBe(false);
        expect(confirmablePorWhatsApp({ tool: 'excusar_ausencia', args: { monto: 9_000_000 } })).toBe(true);
        expect(botonesDeTarjeta('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ABCDEFGH', vista, false).map((x) => x.title)).toEqual(['Cancelar']);
    });
    it('solo una respuesta interactiva cuenta como botón', () => {
        const id = 'mapi:c:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:ABCDEFGH';
        expect(esRespuestaBotonMapi(clic(id) as any)).toBe(true);
        expect(esRespuestaBotonMapi({ ...txt(id), botonId: id } as any)).toBe(false);
        expect(esRespuestaBotonMapi({ ...clic(id), raw: { interactive: { type: 'button_reply', button_reply: { id: 'otro' } } } } as any)).toBe(false);
    });
    it('asentimientos sueltos', () => {
        for (const t of ['si', 'Sí', 'ok', '👍', 'dale!', 'listo', 'confirmo']) expect(esAsentimientoSuelto(t)).toBe(true);
        for (const t of ['si, excusa a Mariana', 'ok cuánto debe Ana', '']) expect(esAsentimientoSuelto(t)).toBe(false);
    });
});

// ─── Turno ───────────────────────────────────────────────────────────────────

describe('turno por WhatsApp', () => {
    it('llama el motor con canal whatsapp y sin hilo, responde en formato WhatsApp y manda la tarjeta', async () => {
        turnoQueProponer();
        h.db.memoria.platform_wa_mensajes.push(
            { direccion: 'entrante', tipo: 'text', texto: '¿cómo vamos?', paso: null, contact_wa_id: NUM, created_at: new Date(AHORA - 60_000).toISOString(), wa_message_id: 'x1' },
            { direccion: 'saliente', tipo: 'text', texto: 'Van 12 pagos.', paso: 'mapi', contact_wa_id: NUM, created_at: new Date(AHORA - 50_000).toISOString(), wa_message_id: 'x2' },
            { direccion: 'saliente', tipo: 'text', texto: 'aviso viejo', paso: 'aviso_comprobantes', contact_wa_id: NUM, created_at: new Date(AHORA - 40_000).toISOString(), wa_message_id: 'x3' },
        );
        expect(await atender(txt('excusa a Mariana esta semana'))).toBe('mapi_turno');
        const p = h.turno.mock.calls[0][0];
        expect(p).toMatchObject({ canal: 'whatsapp', ticketId: null, nombreUsuario: 'Milena' });
        expect(p.alcance).toMatchObject({ schoolId: A, userId: 'duena', rol: 'admin' });
        expect(p.alcance.authorization).toBeNull();
        expect(p.historial.map((m: any) => m.content)).toEqual(['¿cómo vamos?', 'Van 12 pagos.', 'excusa a Mariana esta semana']);
        expect(p.conversacionLlm).toMatch(/^[0-9a-f-]{36}$/);
        expect(textos()[0]).toBe('Te dejé la propuesta *abajo*.');
        expect(botones().map((b) => b.title)).toEqual(['Confirmar', 'Cancelar']);
        // El código no queda en claro: solo su hash, ligado a este número.
        const w = borradores()[0].result.whatsapp;
        expect(w).toMatchObject({ canal: 'whatsapp', wa_id: NUM, plata: false });
        expect(JSON.stringify(borradores()[0])).not.toContain(idDe('c').split(':')[3]);
        expect(w.codigo_sha256).toBe(hashCodigo(idDe('c').split(':')[3]));
        // Lo que salió queda en el historial del canal con paso mapi…
        expect(h.db.memoria.platform_wa_mensajes.filter((m) => m.direccion === 'saliente' && String(m.paso).startsWith('mapi'))).toHaveLength(3);
    });

    it('confirmar ejecuta UNA vez, el «Listo» lo pone el servidor y queda la auditoría del canal', async () => {
        turnoQueProponer();
        await atender(txt('excusa a Mariana'));
        const boton = clic(idDe('c'));
        expect(await atender(boton)).toBe('mapi_boton');
        expect(h.ejecutar).toHaveBeenCalledTimes(1);
        expect(textos().at(-1)).toBe('Quedó *registrada*.');
        const f = borradores()[0];
        expect(f.status).toBe('executed');
        expect(f.result).toMatchObject({ ok: true, whatsapp: { canal: 'whatsapp', wa_message_id_clic: boton.waMessageId, actor: 'duena' } });
        // El mismo código otra vez (Meta reintenta con otro id, o un doble toque).
        await atender(clic(idDe('c')));
        expect(h.ejecutar).toHaveBeenCalledTimes(1);
        expect(textos().at(-1)).toBe(TEXTOS.yaUsado);
    });

    it('cancelar no ejecuta nada', async () => {
        turnoQueProponer();
        await atender(txt('excusa a Mariana'));
        await atender(clic(idDe('x'), NUM, 'Cancelar'));
        expect(borradores()[0].status).toBe('cancelled');
        expect(textos().at(-1)).toBe(TEXTOS.cancelada);
        await atender(clic(idDe('c')));
        expect(h.ejecutar).not.toHaveBeenCalled();
    });

    it('Ver lista manda el detalle sin gastar el código', async () => {
        turnoQueProponer('excusar_ausencia', { ...vista, detalle: { etiqueta: 'Familias', items: ['Ana', 'Beto'] } });
        await atender(txt('recordatorio'));
        await atender(clic(idDe('l'), NUM, 'Ver lista'));
        expect(textos().at(-1)).toBe('*Familias* (2)\n• Ana\n• Beto');
        await atender(clic(idDe('c')));
        expect(h.ejecutar).toHaveBeenCalledTimes(1);
    });
});

// ─── Identidad y botones ajenos ──────────────────────────────────────────────

describe('identidad (D4, D5)', () => {
    it('número sin suscripción o con la suscripción revocada: nada', async () => {
        turnoQueProponer();
        expect(await atender(txt('hola'), [])).toBe('mapi_sin_permiso');
        expect(await atender(txt('hola'), [sub({ estado: 'revocada' })])).toBe('mapi_sin_permiso');
        expect(h.turno).not.toHaveBeenCalled();
        expect(h.enviados).toHaveLength(0);
    });
    it('escuela con el agente apagado: nada', async () => {
        h.db.memoria.school_settings[0].mapi_agent_enabled = false;
        expect(await atender(txt('hola'))).toBe('mapi_sin_permiso');
        expect(h.enviados).toHaveLength(0);
    });
    it('rol quitado: ni turno ni respuesta; y si se quita entre la tarjeta y el clic, no ejecuta', async () => {
        turnoQueProponer();
        await atender(txt('excusa a Mariana'));
        h.db.memoria.school_members = h.db.memoria.school_members.filter((m) => m.profile_id !== 'duena');
        h.db.memoria.schools[0].owner_id = 'otra';
        await atender(clic(idDe('c')));
        expect(h.ejecutar).not.toHaveBeenCalled();
        expect(textos().at(-1)).toBe(TEXTOS.sinPermiso);
        h.turno.mockClear();
        h.enviados.length = 0;
        expect(await atender(txt('hola'))).toBe('mapi_sin_permiso');
        expect(h.turno).not.toHaveBeenCalled();
        expect(h.enviados).toHaveLength(0);
    });
    it('un coach suscrito no entra en esta fase', async () => {
        expect(await atender(txt('hola'), [sub({ profile_id: 'coach1' })])).toBe('mapi_sin_permiso');
    });
    it('suscripción revocada entre la tarjeta y el clic: no ejecuta', async () => {
        turnoQueProponer();
        await atender(txt('excusa a Mariana'));
        await atender(clic(idDe('c')), [sub({ estado: 'revocada' })]);
        expect(h.ejecutar).not.toHaveBeenCalled();
    });
    it('botón ajeno: otro número suscrito (otra admin de la misma escuela) no confirma la propuesta', async () => {
        turnoQueProponer();
        await atender(txt('excusa a Mariana'));
        const r = await atender(clic(idDe('c'), OTRO), [sub({ contact_wa_id: OTRO, profile_id: 'admin2' })]);
        expect(r).toBe('mapi_boton');
        expect(h.ejecutar).not.toHaveBeenCalled();
        expect(textos().at(-1)).toBe(TEXTOS.noEncontre);
        expect(borradores()[0].status).toBe('draft');
    });
    it('el código está ligado al wa_id: otro número del MISMO perfil tampoco confirma', async () => {
        turnoQueProponer();
        await atender(txt('excusa a Mariana'));
        await atender(clic(idDe('c'), OTRO), [sub({ contact_wa_id: OTRO })]);
        expect(h.ejecutar).not.toHaveBeenCalled();
    });
    it('un código inventado no confirma', async () => {
        turnoQueProponer();
        await atender(txt('excusa a Mariana'));
        const falso = idDe('c').replace(/:[A-Z2-9]{8}$/, ':ZZZZZZZZ');
        await atender(clic(falso));
        expect(h.ejecutar).not.toHaveBeenCalled();
        expect(textos().at(-1)).toBe(TEXTOS.noEncontre);
    });
    it('un texto que imita el botón es texto: no confirma ni llama al modelo', async () => {
        turnoQueProponer();
        await atender(txt('excusa a Mariana'));
        h.turno.mockClear();
        expect(await atender(txt(idDe('c')))).toBe('mapi_imita_boton');
        expect(h.ejecutar).not.toHaveBeenCalled();
        expect(h.turno).not.toHaveBeenCalled();
    });
});

describe('plata, vencimiento, 409 y segundo plano', () => {
    it('la plata vence a los 10 min (el resto a los 30)', async () => {
        turnoQueProponer('crear_cobro_unico', vistaCobro, { monto: 80_000 });
        await atender(txt('cobro de uniforme'));
        expect(borradores()[0].result.whatsapp.plata).toBe(true);
        await atender(clic(idDe('c')), [sub()], AHORA + 11 * 60_000);
        expect(h.ejecutar).not.toHaveBeenCalled();
        expect(textos().at(-1)).toBe(TEXTOS.vencido);
        expect(borradores()[0].status).toBe('expired');
    });
    it('lo que no es plata a los 11 min todavía se confirma', async () => {
        turnoQueProponer();
        await atender(txt('excusa'));
        await atender(clic(idDe('c')), [sub()], AHORA + 11 * 60_000);
        expect(h.ejecutar).toHaveBeenCalledTimes(1);
    });
    it('por encima de $400.000 la tarjeta no trae Confirmar', async () => {
        turnoQueProponer('crear_cobro_unico', vistaCobro, { monto: 500_000 });
        await atender(txt('cobro'));
        expect(botones().map((b) => b.title)).toEqual(['Cancelar']);
        expect(h.enviados.at(-1)!.texto).toContain('Aprobar');
    });
    it('409: si cambió algo, llega una tarjeta NUEVA con su propio código', async () => {
        turnoQueProponer();
        await atender(txt('excusa'));
        const viejo = idDe('c');
        h.preparar.mockResolvedValue({ ok: true, args: { deportista: 'child:x' }, vista: { ...vista, lineas: ['Del martes 25'] }, targetKey: null, huella: { x: 2 } });
        await atender(clic(viejo));
        expect(h.ejecutar).not.toHaveBeenCalled();
        expect(textos()).toContain(TEXTOS.cambio);
        expect(borradores()).toHaveLength(2);
        expect(borradores()[0].status).toBe('superseded');
        const nuevo = idDe('c');
        expect(nuevo).not.toBe(viejo);
        expect(nuevo).toContain(borradores()[1].id);
        expect(borradores()[1].content_hash).toBe(hashDe('excusar_ausencia', { x: 2 }, { ...vista, lineas: ['Del martes 25'] }));
        await atender(clic(nuevo));
        expect(h.ejecutar).toHaveBeenCalledTimes(1);
    });
    it('segundo plano: «Enviando…» y el resultado llega por alTerminar', async () => {
        h.segundoPlano = true;
        let soltar!: () => void;
        h.ejecutar.mockImplementation(() => new Promise((r) => { soltar = () => r({ estado: 'executed', resultado: { enviados: 23 } }); }));
        turnoQueProponer();
        await atender(txt('recordatorio'));
        const boton = clic(idDe('c'));
        await atender(boton);
        expect(textos().at(-1)).toBe(TEXTOS.enviando);
        soltar();
        await vi.waitFor(() => expect(textos().at(-1)).toBe('Quedó *registrada*.'));
        await vi.waitFor(() => expect(borradores()[0].result).toMatchObject({ enviados: 23, whatsapp: { wa_message_id_clic: boton.waMessageId } }));
    });
    it('tope de acciones de plata por hora y número', async () => {
        process.env.MAPI_WA_PLATA_POR_HORA = '2';
        for (let i = 0; i < 3; i++) {
            turnoQueProponer('crear_cobro_unico', vistaCobro, { monto: 1000 + i });
            await atender(txt(`cobro ${i}`));
            await atender(clic(idDe('c')));
        }
        expect(h.ejecutar).toHaveBeenCalledTimes(2);
        expect(textos().at(-1)).toBe(TEXTOS.topePlata(2));
        expect(borradores()[2].status).toBe('draft');
    });
});

describe('audio, «si» suelto y mensajes raros', () => {
    it('audio: transcribe, dice «Entendí» y sigue con ese texto', async () => {
        turnoQueProponer();
        h.bajar.mockResolvedValue({ ok: true, buffer: Buffer.from('ogg'), mimeType: 'audio/ogg' });
        h.transcribir.mockResolvedValue({ ok: true, texto: 'Excusa a Mariana esta semana' });
        const m = audio();
        h.db.memoria.platform_wa_mensajes.push({ direccion: 'entrante', tipo: 'audio', texto: null, contact_wa_id: NUM, wa_message_id: m.waMessageId, created_at: new Date(AHORA).toISOString() });
        expect(await atender(m)).toBe('mapi_turno');
        expect(textos()[0]).toBe('Entendí: «Excusa a Mariana esta semana»');
        expect(h.turno.mock.calls[0][0].historial.at(-1).content).toContain('Excusa a Mariana esta semana');
        expect(h.db.memoria.platform_wa_mensajes.find((x) => x.wa_message_id === m.waMessageId).texto).toBe('🎤 Excusa a Mariana esta semana');
    });
    it('audio que no se pudo transcribir: lo pide escrito', async () => {
        h.bajar.mockResolvedValue({ ok: true, buffer: Buffer.from('ogg'), mimeType: 'audio/ogg' });
        h.transcribir.mockResolvedValue({ ok: false, motivo: 'x' });
        expect(await atender(audio())).toBe('mapi_audio_fallido');
        expect(textos()).toEqual([TEXTOS.noEscuche]);
        expect(h.turno).not.toHaveBeenCalled();
    });
    it('imagen: los comprobantes van por la app, con botón', async () => {
        expect(await atender({ ...txt(''), type: 'image', mediaId: 'm' })).toBe('mapi_media');
        expect(h.enviados[0]).toMatchObject({ tipo: 'enlace', texto: TEXTOS.comprobantes });
    });
    it('«si» sin tarjeta pendiente pregunta qué necesita; con tarjeta, pide el botón; nunca confirma', async () => {
        expect(await atender(txt('si'))).toBe('mapi_asentimiento');
        expect(textos().at(-1)).toBe(TEXTOS.queNecesitas);
        turnoQueProponer();
        await atender(txt('excusa'));
        h.turno.mockClear();
        await atender(txt('👍'));
        expect(textos().at(-1)).toBe(TEXTOS.usaElBoton);
        expect(h.ejecutar).not.toHaveBeenCalled();
        expect(h.turno).not.toHaveBeenCalled();
    });
});

describe('multiescuela', () => {
    const dos = () => [sub(), sub({ school_id: B })];
    it('pregunta con botones, sigue con el mensaje pendiente y la recuerda', async () => {
        turnoQueProponer();
        expect(await atender(txt('¿cómo vamos?'), dos())).toBe('mapi_elegir_escuela');
        expect(h.turno).not.toHaveBeenCalled();
        expect(botones().map((b) => b.id)).toEqual([`mapi:e:${A}`, `mapi:e:${B}`]);
        expect(await atender(clic(`mapi:e:${B}`, NUM, 'Monster'), dos())).toBe('mapi_escuela_elegida');
        expect(textos()).toContain('Hablamos de *Monster*.');
        expect(h.turno.mock.calls[0][0].alcance.schoolId).toBe(B);
        await atender(txt('¿y los pagos?'), dos());
        expect(h.turno).toHaveBeenCalledTimes(2);
        expect(h.turno.mock.calls[1][0].alcance.schoolId).toBe(B);
        // Tras un reinicio (sin memoria) la elección sale del registro del canal.
        _reiniciarEstadoCanal();
        await atender(txt('¿y hoy?'), dos());
        expect(h.turno.mock.calls[2][0].alcance.schoolId).toBe(B);
    });
    it('una escuela que no es suya no se puede elegir', async () => {
        expect(await atender(clic(`mapi:e:${B}`, NUM, 'Monster'), [sub()])).toBe('mapi_sin_permiso');
    });
    it('un borrador de la escuela A no se confirma con el alcance de B', async () => {
        turnoQueProponer();
        await atender(txt('excusa'), [sub()]);
        // Mismo número, ahora solo suscrito a B: la propuesta de A ya no es «de este número».
        await atender(clic(idDe('c')), [sub({ school_id: B })]);
        expect(h.ejecutar).not.toHaveBeenCalled();
    });
});

describe('candado por número', () => {
    it('dos mensajes seguidos no corren turnos cruzados', async () => {
        let activos = 0;
        let maximo = 0;
        h.turno.mockImplementation(async () => {
            activos++; maximo = Math.max(maximo, activos);
            await new Promise((r) => setTimeout(r, 20));
            activos--;
            return { tipo: 'texto', texto: 'ok', borradores: [], herramientas: [], rondas: 1 };
        });
        await Promise.all([atender(txt('uno')), atender(txt('dos')), atender(txt('tres'))]);
        expect(h.turno).toHaveBeenCalledTimes(3);
        expect(maximo).toBe(1);
    });
});

describe('modo pruebas (/como admin, cortafuegos D13)', () => {
    it('el borrador vive en la memoria de la sesión y al confirmar ninguna escritura llega a la base', async () => {
        turnoQueProponer();
        h.ejecutar.mockImplementation(async () => {
            const { error } = await supabase.from('athlete_absence_notices').insert({ x: 1 });
            return error ? { estado: 'failed', resultado: { motivo: error.message } } : { estado: 'executed', resultado: {} };
        });
        let memoria: Record<string, any[]> = {};
        const como = { userId: 'duena', desde: AHORA - 1000 };
        const r1 = await atenderMapiPrueba({ canal: CANAL as any, numero: NUM, msg: txt('excusa a Mariana') as any, schoolId: A, comoAdmin: como, memoria, ahora: AHORA });
        expect(r1.resultado).toBe('mapi_turno');
        memoria = r1.memoria;
        expect(memoria.mapi_action_drafts).toHaveLength(1);
        expect(h.db.memoria.mapi_action_drafts ?? []).toHaveLength(0);
        expect(h.enviados.every((e) => e.texto.startsWith('🧪 '))).toBe(true);

        const r2 = await atenderMapiPrueba({ canal: CANAL as any, numero: NUM, msg: clic(idDe('c')) as any, schoolId: A, comoAdmin: como, memoria, ahora: AHORA });
        expect(h.ejecutar).toHaveBeenCalledTimes(1);
        expect(r2.bloqueadas).toContain('insert athlete_absence_notices');
        expect(h.db.memoria.athlete_absence_notices ?? []).toHaveLength(0);
        expect(r2.memoria.mapi_action_drafts[0].status).toBe('failed');
        // Lo que se le dice al tester sí sale (fuera del cortafuegos) y queda registrado.
        expect(textos().at(-1)).toBe('🧪 Quedó *registrada*.');
        expect(h.db.memoria.platform_wa_mensajes.at(-1)).toMatchObject({ clase: 'tester', direccion: 'saliente', paso: 'mapi_resultado' });
    });
});
