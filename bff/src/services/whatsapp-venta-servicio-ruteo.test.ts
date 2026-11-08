/**
 * Ruteo de la VENTA de un servicio en el bot (frente A): `atenderDesconocido` con
 * los mensajes reales de la Clínica de Monster (3–8 nov 2026). Base en memoria y
 * `simularEnvios` (nada sale): lo que el bot habría mandado queda en `salidas`.
 *
 * Lo que se vigila: con la venta activa, «Hola», «.», «ese día tenemos torneo»,
 * «Como así disculpa» y las dudas de antes de pagar los atiende la venta, ANTES
 * del embudo, la bienvenida con sedes y la clase de prueba; pedir el club saca de
 * la venta; un servicio vencido no sostiene una venta.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state = {
        filas: [] as any[],
        items: [] as any[],
    };
    const momento = (f: any) => new Date(f.wa_timestamp || f.created_at || 0).getTime();
    const plano = (f: any) => {
        const p = f.payload ?? {};
        return {
            direction: f.direction, type: f.type, text_body: f.text_body, ai_generated: f.ai_generated,
            wa_timestamp: f.wa_timestamp, created_at: f.created_at,
            venta_servicio_id: p.venta_servicio_id ?? null, servicio_id: p.servicio_id ?? null, step: p.step ?? null,
            campana_id: p.campana_id ?? null, destino_anuncio: p.destino_anuncio ?? null, caption: null,
        };
    };
    function resolver(table: string, ops: Ops, single: boolean): any {
        const eqs = ops.filter(([m]) => m === 'eq').map(([, a]) => a);
        if (table === 'whatsapp_messages' || table === 'whatsapp_message_drafts') {
            if (table === 'whatsapp_message_drafts') return { data: single ? null : [], count: 0, error: null };
            const sel = String(ops.find(([m]) => m === 'select')?.[1]?.[0] ?? '');
            let filas = [...state.filas].sort((a, b) => momento(b) - momento(a));
            for (const [c, v] of eqs) {
                if (c === 'direction') filas = filas.filter((f) => f.direction === v);
                else if (c === 'payload->>step') filas = filas.filter((f) => f.payload?.step === v);
                else if (c === 'ai_generated') filas = filas.filter((f) => f.ai_generated === v);
            }
            if (ops.some(([m]) => m === 'ilike' || m === 'or')) return { data: [], count: 0, error: null };
            if (ops.some(([m]) => m === 'update')) return { data: [], error: null };
            const data = sel.includes('payload->>') ? filas.map(plano) : filas;
            return { data: single ? (data[0] ?? null) : data, count: data.length, error: null };
        }
        if (table === 'school_tournament_items') return { data: state.items, error: null };
        if (table === 'whatsapp_conversations') {
            return { data: { id: 'conv-1', contact_wa_id: '573165395912', parent_id: null, identified: false, status: 'open', contact_name: 'Jorge', tomada_por: null, tomada_hasta: null }, error: null };
        }
        if (table === 'whatsapp_settings') {
            return { data: { ai_enabled: true, mode: 'auto', responder_desconocidos: false, responder_prospectos: true }, error: null };
        }
        if (table === 'schools') return { data: { name: 'Monster´s Volley Club', slug: 'monsters-volley-club' }, error: null };
        if (table === 'whatsapp_inbound_queue' || table === 'school_signup_leads') return { data: single ? null : [], error: null };
        return { data: single ? null : [], error: null };
    }
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lt', 'lte', 'or', 'order', 'limit', 'is', 'not', 'neq', 'filter', 'contains', 'ilike', 'insert', 'update', 'upsert', 'delete']) b[m] = chain(m);
        b.maybeSingle = () => Promise.resolve(resolver(table, ops, true));
        b.single = () => Promise.resolve(resolver(table, ops, true));
        b.then = (res: any, rej: any) => Promise.resolve(resolver(table, ops, false)).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: { from: (t: string) => makeBuilder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        botEncendido: vi.fn(async () => true),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp-atencion.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-atencion.service')>('./whatsapp-atencion.service');
    return { ...real, botEncendido: h.botEncendido };
});
vi.mock('./whatsapp-ajustes-escuela.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-ajustes-escuela.service')>('./whatsapp-ajustes-escuela.service');
    // Monster: con embudo del interesado (sedes + 5 preguntas) y sin modo discreto.
    const ajustes = { ...real.AJUSTES_POR_DEFECTO, preguntasProspecto: [{ clave: 'nombre', texto: '¿Nombre?' }] as any, modoDiscreto: 'no' as const };
    return { ...real, ajustesWhatsAppDeEscuela: vi.fn(async () => ajustes), modoDiscretoEfectivo: vi.fn(async () => false) };
});
vi.mock('./llm.service', () => ({ chatWithTools: vi.fn() }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.txt' })),
    sendInteractiveButtons: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.btn' })),
    aFormatoWhatsApp: (t: string) => t,
    resolveIntegration: vi.fn(),
    markAsRead: vi.fn(),
}));
vi.mock('./whatsapp-optin.service', () => ({ estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '' }));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({
    mediosDePago: vi.fn(async () => ({ cuentas: [
        { tipo: 'Nequi', titular: 'Iván Sossa', numero: '3194505150' },
        { tipo: 'Daviplata', titular: 'Iván Sossa', numero: '3194505150' },
    ] })),
}));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({
    avisarEscalamientoPorCorreo: vi.fn(async () => {}),
    etiquetaDeContacto: vi.fn(() => 'Contacto'),
}));
vi.mock('./whatsapp-prospecto-lead.service', () => ({
    registrarLeadDeProspecto: vi.fn(async () => null),
    variantesTelefonoLead: (t: string) => [t],
}));
vi.mock('./wa-concepto-esperado.service', () => ({ registrarConceptoEsperado: vi.fn(async () => true) }));

import { atenderDesconocido, deliver, simularEnvios, sinPuntuacionHuerfana, _olvidarPresentaciones } from './whatsapp-bot.service';
import { sinEmojisDeDeporte } from './whatsapp-salida-segura';
import { MARCA_VENTA } from './whatsapp-venta-contexto';
import { PASO_VENTA, TEXTO_A_LA_ESCUELA, TEXTO_OTRA_FECHA, lineaDeSaludoDeVenta } from './whatsapp-venta-servicio';

const INTEG = { id: 'int-monster', school_id: 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c' } as any;
const TEL = '573165395912';
const CLINICA = {
    id: '16766d2e-f8b0-4285-88e3-b1e67dda6d45', name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: '300000.00', active: true, event_id: null, starts_at: '2099-11-21T05:00:00Z', ends_at: '2099-11-23T04:59:00Z',
    allow_installments: true, precio_afiliado: '250000', precios_por_fecha: null, abono_minimo_pct: 50, opciones: null,
    description: '🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES MONSTER’S VOLLEY! 🔥',
};
const FICHA = '🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES MONSTER’S VOLLEY! 🔥 ¿Quieres llevar tu juego al siguiente nivel? Esta es una oportunidad para aprender de referentes del voleibol.';

const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ent = (min: number, texto: string, extra: any = {}) =>
    ({ wa_message_id: `in-${min}`, direction: 'inbound', type: 'text', text_body: texto, payload: {}, ai_generated: false, created_at: hace(min), wa_timestamp: hace(min), ...extra });
const sal = (min: number, texto: string, extra: any = {}) =>
    ({ wa_message_id: `out-${min}`, direction: 'outbound', type: 'text', text_body: texto, payload: {}, ai_generated: true, created_at: hace(min), wa_timestamp: hace(min), ...extra });

/** La respuesta al «Sí» de la campaña (texto de la escuela, con la marca de la venta). */
const respuestaCampana = (min: number) => sal(min, FICHA + ' Responde este mensaje y te enviamos los datos de pago.',
    { ai_generated: false, payload: { step: 'campana_respuesta_si', campana_id: 'camp-1', automatico: 'true', [MARCA_VENTA]: CLINICA.id } });

const PROHIBIDO = /elige la sede|sede que te queda|clase de prueba|5 preguntas|9 de noviembre|\$15\.000/i;

async function turno(texto: string) {
    h.state.filas.unshift(ent(0, texto));
    return simularEnvios(() => atenderDesconocido(INTEG, 'conv-1', TEL, texto));
}

beforeEach(() => {
    vi.clearAllMocks();
    _olvidarPresentaciones();
    h.state.items = [CLINICA];
    h.state.filas = [];
});

describe('ruteo de la venta de un servicio (atenderDesconocido)', () => {
    it('caso 1: «Hola» tras la campaña de la clínica → la línea del servicio, sin bienvenida con sedes', async () => {
        h.state.filas = [respuestaCampana(24 * 60), ent(24 * 60 + 1, 'Sí, envíame la info', { type: 'button' })];
        const { resultado, salidas } = await turno('Hola');
        expect(resultado).toBe('venta_saludo');
        expect(salidas.map((s) => s.texto).join('\n')).toContain(lineaDeSaludoDeVenta(CLINICA as any));
        expect(salidas[0].payload).toMatchObject({ [MARCA_VENTA]: CLINICA.id, step: PASO_VENTA.SALUDO });
        for (const s of salidas) expect(s.texto).not.toMatch(PROHIBIDO);
    });

    it('caso 1: «ese día tenemos torneo, ¿hay otra fecha?» → acuse y a la escuela (nunca las 5 preguntas)', async () => {
        h.state.filas = [respuestaCampana(60)];
        const { resultado, salidas } = await turno('ese día tenemos torneo, ¿hay otra fecha?');
        expect(resultado).toBe('venta_otra_fecha');
        expect(salidas[0].texto).toContain(TEXTO_OTRA_FECHA);
        expect(salidas.some((s) => s.texto.includes('se abre en el buzón'))).toBe(true);
        for (const s of salidas) expect(s.texto).not.toMatch(PROHIBIDO);
    });

    it('caso 2 (Nicolás): ficha pegada por la escuela hace 4 días, «No encontré», «Como así disculpa» → NO arranca el embudo', async () => {
        h.state.filas = [
            sal(1, 'Gracias 🙏 No encontré a ese deportista, así que le paso tu comprobante a la escuela para que lo aplique.',
                { payload: { step: 'deportista_a_la_escuela' } }),
            ent(2, 'Nicolás Cubides Ávila\n18 de Diciembre del 2006\nOpuesto'),
            sal(3, 'Recibí tu comprobante 📄 ¿De qué deportista es este pago?', { payload: { step: 'ask_deportista' } }),
            ent(4, '', { type: 'image' }),
            sal(4 * 24 * 60, FICHA, { ai_generated: false, payload: { automatico: 'true' } }),
        ];
        const { resultado, salidas } = await turno('Como asi disculpa');
        expect(resultado).toBe('venta_a_la_escuela');
        expect(salidas[0].texto).toContain(TEXTO_A_LA_ESCUELA);
        expect(salidas[0].payload).toMatchObject({ pendiente_escuela: 'Como asi disculpa', [MARCA_VENTA]: CLINICA.id });
        for (const s of salidas) {
            expect(s.texto).not.toMatch(PROHIBIDO);
            expect(String(s.step ?? '')).not.toMatch(/^embudo_|desconocido_tema_escolar/);
        }
    });

    it('caso 6 (932fcd83): tras los datos de pago, las dos dudas seguidas reciben respuesta (antes: silencio total)', async () => {
        h.state.filas = [
            sal(1, 'Para separar tu cupo en la clínica, paga *$150.000*…', { payload: { step: 'prospecto_ia' } }),
            ent(2, 'Si me interesa reservar'),
            sal(4, FICHA, { ai_generated: false, payload: { step: 'campana_respuesta_si', campana_id: 'camp-1', automatico: 'true' } }),
            ent(5, 'Sí, envíame la info', { type: 'button' }),
        ];
        const a = await turno('Solo una confirmacion antes de pagar incluye grupo femenino ??');
        expect(a.resultado).toBe('venta_a_la_escuela');
        expect(a.salidas.find((s) => s.payload?.step === PASO_VENTA.A_LA_ESCUELA)?.payload)
            .toMatchObject({ pendiente_escuela: 'Solo una confirmacion antes de pagar incluye grupo femenino ??' });

        const b = await turno('Me confima los datos del titular de la cuenta y la cc');
        expect(b.resultado).toBe('venta_pago');
        const pago = b.salidas.find((s) => s.payload?.step === PASO_VENTA.PAGO)!;
        expect(pago.texto).toContain('Nequi o Daviplata al número 3194505150 (a nombre de Iván Sossa)');
        expect(pago.texto).toContain('nombre completo de quien asiste');
        expect(pago.payload).toMatchObject({ [MARCA_VENTA]: CLINICA.id, datos_de_pago: true });
        for (const s of [...a.salidas, ...b.salidas]) expect(s.texto).not.toMatch(PROHIBIDO);
    });

    it('fe695949: tras la PLANTILLA de la campaña, «ya envié el comprobante» nunca recibe «No reconozco este número»', async () => {
        h.state.filas = [sal(60, '¡Hola familia! 🏐 Te recordamos la *Clínica de Armadores y Atacantes* de Monster´s Volley con ⭐ Jorge Mesa: 21 y 22 de noviembre. ¿Te enviamos toda la información y cómo reservar tu cupo?',
            { type: 'template', ai_generated: false, payload: { step: 'campana', campana_id: 'camp-1', automatico: 'true' } })];
        const a = await turno('Hola buena tarde, ya tengo el cupo de mi hijo');
        expect(String(a.resultado)).toMatch(/^venta_/);
        const b = await turno('Ya envié el comprobante tambien');
        expect(b.resultado).toBe('venta_ya_pago');
        for (const s of [...a.salidas, ...b.salidas]) {
            expect(s.texto).not.toMatch(/no reconozco este n[uú]mero|correo electr[oó]nico/i);
            expect(s.texto).not.toMatch(PROHIBIDO);
        }
        expect(b.salidas.map((s) => s.texto).join('\n')).toContain('nombre completo de quien asiste');
    });

    it('venta + «Es posible agendar una clase de prueba?» → sale de la venta (flujo normal)', async () => {
        h.state.filas = [respuestaCampana(60)];
        const { resultado, salidas } = await turno('Es posible agendar una clase de prueba?');
        expect(String(resultado)).not.toMatch(/^venta_/);
        for (const s of salidas) expect(s.payload?.[MARCA_VENTA]).toBeUndefined();
    });

    it('servicio vencido (fuera del catálogo vigente) → no hay venta', async () => {
        h.state.items = [{ ...CLINICA, ends_at: hace(60), starts_at: hace(2 * 24 * 60) }];
        h.state.filas = [respuestaCampana(3 * 24 * 60)];
        const { resultado, salidas } = await turno('Hola');
        expect(String(resultado)).not.toMatch(/^venta_/);
        for (const s of salidas) expect(s.payload?.[MARCA_VENTA]).toBeUndefined();
    });

    it('932fcd83 (11-07 15:41): sin el emoji (o el nombre) la frase no queda «¡Qué emoción, !»', async () => {
        // Puro: lo que deja el filtro de emojis de deporte.
        const filtrado = sinEmojisDeDeporte('¡Qué emoción, 🏐! Para separar tu cupo en la clínica, paga *$150.000*.');
        expect(filtrado).toBe('¡Qué emoción, ! Para separar tu cupo en la clínica, paga *$150.000*.');
        expect(sinPuntuacionHuerfana(filtrado)).toBe('¡Qué emoción! Para separar tu cupo en la clínica, paga *$150.000*.');
        expect(sinPuntuacionHuerfana('¡Mucho gusto, ! 😊')).toBe('¡Mucho gusto! 😊');
        expect(sinPuntuacionHuerfana('Hola, , ¿cómo vas ?')).toBe('Hola, ¿cómo vas?');
        expect(sinPuntuacionHuerfana('Listo ( ) ¡ ! gracias')).toBe('Listo gracias');
        // Lo que no se toca: montos, enlaces, comas normales.
        const normal = 'Valor: *$1.250.000*, abono de $625.000. Paga en https://checkout.wompi.co/l/abc?x=1, y listo.';
        expect(sinPuntuacionHuerfana(normal)).toBe(normal);

        // Y cableado en `deliver`: lo que sale a Meta ya va limpio.
        const { sendTextMessage } = await import('./whatsapp.service');
        await deliver(INTEG, 'conv-1', TEL, '¡Qué emoción, 🏐! Para separar tu cupo, envía el comprobante por este chat.', { step: 'prospecto_ia' });
        const enviado = (sendTextMessage as any).mock.calls.at(-1)?.[2] as string;
        expect(enviado).toContain('¡Qué emoción! Para separar tu cupo, envía el comprobante por este chat.');
        expect(enviado).not.toMatch(/, !/);
    });

    it('la escuela escribió hace 5 minutos: el bot no habla en la venta', async () => {
        h.state.filas = [sal(5, 'Hola Jorge, ya te confirmo', { ai_generated: false }), respuestaCampana(60)];
        const { resultado, salidas } = await turno('¿incluye grupo femenino?');
        expect(resultado).toBe('escuela_atendiendo');
        expect(salidas.filter((s) => !s.texto.startsWith('['))).toEqual([]);
    });
});
