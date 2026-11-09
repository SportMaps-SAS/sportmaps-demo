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
        optin: null as any,
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
        if (table === 'whatsapp_optins') return { data: single ? state.optin : [], error: null };
        if (table === 'whatsapp_conversations') {
            return { data: { id: 'conv-1', contact_wa_id: '573165395912', parent_id: null, identified: false, status: 'open', contact_name: 'Jorge', tomada_por: null, tomada_hasta: null }, error: null };
        }
        if (table === 'whatsapp_settings') {
            return { data: { ai_enabled: true, mode: 'auto', responder_desconocidos: false, responder_prospectos: true }, error: null };
        }
        if (table === 'schools') return { data: { name: 'Monster´s Volley Club', slug: 'monsters-volley-club' }, error: null };
        if (table === 'school_trial_class_settings') return { data: { nombre_clase: 'prueba', trial_price: 15000 }, error: null };
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
    // Monster: con embudo del interesado (preguntas) y sin modo discreto.
    const ajustes = {
        ...real.AJUSTES_POR_DEFECTO, modoDiscreto: 'no' as const,
        preguntasProspecto: [
            { clave: 'nombre', texto: '1️⃣ ¿Cuál es el *nombre completo* del deportista?', tipo: 'texto' },
            { clave: 'fecha_nacimiento', texto: '2️⃣ ¿Cuál es su *fecha de nacimiento*? (día/mes/año)', tipo: 'fecha' },
        ] as any,
    };
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
import {
    PASO_VENTA, TEXTO_A_LA_ESCUELA, TEXTO_OTRA_FECHA, embudoDelClubEnCurso, lineaDeSaludoDeVenta, ventaCedeAlEmbudo,
} from './whatsapp-venta-servicio';

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

async function turno(texto: string, botonId: string | null = null) {
    h.state.filas.unshift(ent(0, texto, botonId ? { type: 'interactive' } : {}));
    return simularEnvios(() => atenderDesconocido(INTEG, 'conv-1', TEL, texto, botonId));
}

beforeEach(() => {
    vi.clearAllMocks();
    _olvidarPresentaciones();
    h.state.items = [CLINICA];
    h.state.filas = [];
    h.state.optin = null;
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
        expect(pago.texto).toContain('Nequi o Daviplata al 319 450 5150, a nombre de Iván Sossa');
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

    // Los dos sentidos de la convivencia venta ↔ embudo del club (batería completa, 2026-11-08).
    const fichaMarcada = (min: number) => sal(min, FICHA, { payload: { destino_anuncio: 'servicio', servicio_id: CLINICA.id, [MARCA_VENTA]: CLINICA.id } });
    const pagoMarcado = (min: number) => sal(min, 'Para separar tu cupo en la Clínica de armadores y atacantes: …',
        { payload: { step: PASO_VENTA.PAGO, [MARCA_VENTA]: CLINICA.id } });

    it('venta pura: «Mariana Gómez Ruiz» después de la ficha de la clínica NO abre el embudo (lo atiende la venta)', async () => {
        h.state.filas = [pagoMarcado(1), fichaMarcada(1), ent(2, '¿Cuánto cuesta la clínica? ¿Cómo aparto mi cupo?')];
        const { resultado, salidas } = await turno('Mariana Gómez Ruiz');
        expect(String(resultado)).toMatch(/^venta_/);
        for (const s of salidas) {
            expect(String(s.step ?? '')).not.toMatch(/^embudo_|desconocido_tema_escolar/);
            expect(s.texto).not.toMatch(PROHIBIDO);
        }
    });

    it('embudo del club EN CURSO: la clínica se contesta, y «Mariana Gómez Ruiz» lo atiende el embudo (no la venta)', async () => {
        const preguntaNombre = sal(5, '¡Genial, ⚫ Sede Suba! 🙌\n\n1️⃣ ¿Cuál es el *nombre completo* del deportista?', {
            payload: { step: 'embudo_pregunta', flujo: 'embudo', paso_embudo: 'pregunta', datos_embudo: { i: 0, respuestas: {}, branchId: 'b-suba', sedeTitulo: '⚫ Sede Suba' } },
        });
        h.state.filas = [ent(6, '⚫ Sede Suba', { type: 'interactive' }), preguntaNombre];
        // 1) Pregunta por la clínica a mitad del embudo: la venta la contesta (ficha y pago aparte).
        const a = await turno('¿cuánto vale la clínica?');
        expect(String(a.resultado)).toMatch(/^anuncio_servicio|^venta_/);
        expect(a.salidas.some((s) => s.payload?.[MARCA_VENTA] === CLINICA.id)).toBe(true);
        // La simulación no guarda lo que salió: se siembra (la ficha y el pago, sin estado del embudo).
        h.state.filas.unshift(pagoMarcado(0.5), fichaMarcada(0.5));
        // 2) Contesta la pregunta del embudo: va al embudo, que sigue con la siguiente pregunta.
        const b = await turno('Mariana Gómez Ruiz');
        expect(String(b.resultado)).not.toMatch(/^venta_/);
        for (const s of b.salidas) expect(s.payload?.[MARCA_VENTA]).toBeUndefined();
        expect(b.salidas.some((s) => String(s.step ?? '').startsWith('embudo_'))).toBe(true);
    });

    it('embudo en curso: «¿cómo pago?» justo después del pago de la clínica sigue siendo de la venta', () => {
        const preguntaNombre = sal(5, '1️⃣ ¿nombre?', { payload: { flujo: 'embudo', paso_embudo: 'pregunta', datos_embudo: { i: 0 }, step: 'embudo_pregunta' } });
        const r = [pagoMarcado(1), fichaMarcada(1), preguntaNombre] as any[];
        expect(embudoDelClubEnCurso(r)).toBe(true);
        expect(ventaCedeAlEmbudo(r, CLINICA as any, 'Mariana Gómez Ruiz')).toBe(true);
        expect(ventaCedeAlEmbudo(r, CLINICA as any, '¿y la clínica es para niñas?')).toBe(false);
        expect(ventaCedeAlEmbudo(r, CLINICA as any, '¿cómo pago?')).toBe(false);
        // Tras un mensaje de la venta, «Ok» / «Buenos días» / «gracias» / «Armadores» siguen en la venta.
        for (const t of ['Ok', 'Buenos días', 'gracias', 'Armadores']) expect(ventaCedeAlEmbudo(r, CLINICA as any, t)).toBe(false);
        // El embudo que el bot abrió a un saludo y nadie contestó (sedes, o la 1.ª pregunta con una sola sede) no cuenta.
        const sedes = sal(5, 'Elige la sede', { payload: { flujo: 'embudo', paso_embudo: 'sede', datos_embudo: {}, step: 'desconocido_tema_escolar' } });
        const unaSede = sal(5, '1️⃣ ¿nombre?', { payload: { flujo: 'embudo', paso_embudo: 'pregunta', datos_embudo: { i: 0 }, step: 'desconocido_tema_escolar' } });
        expect(embudoDelClubEnCurso([fichaMarcada(1), sedes] as any[])).toBe(false);
        expect(embudoDelClubEnCurso([fichaMarcada(1), unaSede] as any[])).toBe(false);
        expect(ventaCedeAlEmbudo([fichaMarcada(1), sedes] as any[], CLINICA as any, 'Mariana Gómez Ruiz')).toBe(false);
        // Sin embudo (o con la clase ya agendada), la venta no cede.
        expect(ventaCedeAlEmbudo([pagoMarcado(1), fichaMarcada(1)] as any[], CLINICA as any, 'Mariana Gómez Ruiz')).toBe(false);
        const agendada = sal(5, 'Agendada', { payload: { flujo: 'embudo', paso_embudo: 'agendada', datos_embudo: {}, step: 'embudo_agendada' } });
        expect(embudoDelClubEnCurso([pagoMarcado(1), agendada] as any[])).toBe(false);
    });

    it('venta + «Es posible agendar una clase de prueba?» → sale de la venta (flujo normal)', async () => {
        h.state.filas = [respuestaCampana(60)];
        const { resultado, salidas } = await turno('Es posible agendar una clase de prueba?');
        expect(String(resultado)).not.toMatch(/^venta_/);
        for (const s of salidas) expect(s.payload?.[MARCA_VENTA]).toBeUndefined();
    });

    it('Nicolás (308de503): con la venta activa, los botones VIEJOS del embudo no avanzan nada (sede → 1 respuesta; franja, opciones, recordatorio → nada)', async () => {
        h.state.filas = [sal(4 * 24 * 60, FICHA, { ai_generated: false, payload: { automatico: 'true' } })];
        const sede = await turno('⚫ Sede Suba', 'sm_em_sede:531a2df9-dab4-47bb-a1cf-5a904b276c46');
        expect(sede.resultado).toBe('venta_boton_club');
        const textos = sede.salidas.filter((s) => !s.texto.startsWith('['));
        expect(textos).toHaveLength(1);
        expect(textos[0].texto).toContain('Ese botón era de un mensaje anterior');
        expect(textos[0].payload).toMatchObject({ step: PASO_VENTA.BOTON_CLUB, [MARCA_VENTA]: CLINICA.id });
        // La respuesta quedó en la conversación: los toques siguientes no la repiten.
        h.state.filas.unshift(sal(0.5, textos[0].texto, { payload: textos[0].payload }));
        for (const [t, id] of [['Hombre', 'sm_em_o:sexo:1'], ['Sáb 14 nov · 7:00–9:00', 'sm_em_f:9ff7110c-389c-4fe1-a823-a40696ea6b25'],
            ['Sí, claro', 'sm_em_optin_si'], ['Ver más horarios', 'sm_cc_mas'], ['Quiero información', 'sm_pd_info']] as const) {
            const r = await turno(t, id);
            expect(r.resultado, id).toBe('venta_silencio');
            expect(r.salidas.filter((s) => !s.texto.startsWith('[')), id).toEqual([]);
        }
        for (const s of sede.salidas) {
            expect(s.texto).not.toMatch(PROHIBIDO);
            expect(String(s.step ?? '')).not.toMatch(/^embudo_|^clase_prueba|desconocido_tema_escolar/);
        }
    });

    it('sin venta activa, el mismo botón del embudo sigue al embudo (no lo toma la venta)', async () => {
        h.state.filas = [sal(60, 'Elige la sede', { payload: { flujo: 'embudo', paso_embudo: 'sede', datos_embudo: {}, step: 'embudo_bienvenida' } })];
        const r = await turno('⚫ Sede Suba', 'sm_em_sede:531a2df9-dab4-47bb-a1cf-5a904b276c46');
        expect(String(r.resultado)).not.toMatch(/^venta_/);
        for (const s of r.salidas) expect(s.payload?.step).not.toBe(PASO_VENTA.BOTON_CLUB);
    });

    it('«Hablar con una persona» del embudo (sm_em_persona) en plena venta no se queda quieto', async () => {
        h.state.filas = [respuestaCampana(60)];
        const r = await turno('Hablar con una persona', 'sm_em_persona');
        expect(r.resultado).not.toBe('venta_boton_club');
        expect(r.resultado).not.toBe('venta_silencio');
    });

    it('en plena venta pide la clase de prueba POR TEXTO: antes del embudo se le dice que va aparte de la clínica y cuánto cuesta (una vez)', async () => {
        h.state.filas = [respuestaCampana(60)];
        const r = await turno('Quiero agendar una clase de prueba para entrar al club');
        const aparte = r.salidas.find((s) => s.payload?.step === PASO_VENTA.CLUB_APARTE);
        expect(aparte?.texto).toBe('Claro 🙌 Lo del club va aparte de la Clínica de armadores y atacantes: para empezar se agenda una *clase de prueba*, que cuesta *$15.000*.');
        expect(r.salidas.indexOf(aparte!)).toBe(0);
        expect(aparte?.payload?.[MARCA_VENTA]).toBeUndefined();
        // Ya dicho: no se repite.
        h.state.filas.unshift(sal(0.5, aparte!.texto, { payload: aparte!.payload }));
        const otra = await turno('¿qué horarios hay para la clase de prueba?');
        expect(otra.salidas.some((s) => s.payload?.step === PASO_VENTA.CLUB_APARTE)).toBe(false);
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

describe('botones de la venta y ACTIVAR de un número sin ficha (Monster 2026-11-09)', () => {
    it('toca [Separar mi cupo] de la campaña → los datos de pago de hoy con [Ya pagué]', async () => {
        h.state.filas = [respuestaCampana(5), ent(6, 'Sí, envíame la info', { type: 'button' })];
        const r = await turno('Separar mi cupo', `vs:${CLINICA.id}:separar`);
        expect(r.resultado).toBe('venta_pago');
        const pago = r.salidas.find((x) => x.payload?.step === PASO_VENTA.PAGO)!;
        expect(pago.texto).toContain('abono mínimo de *$150.000*');
        expect(pago.botones).toEqual(['Ya pagué']);
    });
    it('«*ACTIVAR*» de quien se dio de baja → se reactiva (no «eso te lo confirma la escuela»)', async () => {
        h.state.optin = { opted_out_at: '2026-11-09T23:31:00Z' };
        h.state.filas = [respuestaCampana(30)];
        const r = await turno('*ACTIVAR*');
        expect(r.resultado).toBe('avisos_reactivados');
        expect(r.salidas.map((x) => x.texto).join(' ')).toContain('reactivé los mensajes');
        expect(r.salidas.map((x) => x.texto).join(' ')).not.toContain('te lo confirma la escuela');
    });
    it('«activar» de quien NO se dio de baja sigue su camino (la venta), sin reactivar nada', async () => {
        h.state.optin = null;
        h.state.filas = [respuestaCampana(30)];
        const r = await turno('activar');
        expect(r.resultado).not.toBe('avisos_reactivados');
    });
});
