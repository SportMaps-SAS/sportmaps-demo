import { describe, it, expect } from 'vitest';
import { ventaActiva, itemNombradoEn, pideElClub, MARCA_VENTA } from './whatsapp-venta-contexto';
import type { ItemConFicha } from './whatsapp-anuncio-destino';
import type { FilaReciente } from './whatsapp-reglas-turno';

const CLINICA: ItemConFicha = {
    id: '16766d2e-f8b0-4285-88e3-b1e67dda6d45', name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: 300000, active: true, event_id: null, starts_at: '2026-11-21T05:00:00Z', ends_at: '2026-11-23T04:59:00Z',
    description: '🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES MONSTER’S VOLLEY! 🔥 ...',
};
const VACACIONAL: ItemConFicha = {
    id: 'fff41827-cd2f-404a-b0ff-f42dc66c59a8', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional',
    price: 100000, active: true, event_id: null, starts_at: '2026-11-17T13:00:00Z', ends_at: '2026-12-10T16:00:00Z',
};
const COPA: ItemConFicha = {
    id: '11111111-2222-3333-4444-555555555555', name: 'Copa Relámpago Indoor', kind: 'torneo',
    price: 80000, active: true, event_id: null,
};
const ITEMS = [CLINICA, VACACIONAL, COPA];
const AHORA = new Date('2026-11-08T18:00:00Z').getTime();
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();
const ent = (min: number, text: string, extra: Partial<FilaReciente> = {}): FilaReciente =>
    ({ direction: 'inbound', type: 'text', text_body: text, created_at: hace(min), ...extra });
const sal = (min: number, text: string, extra: Partial<FilaReciente> = {}): FilaReciente =>
    ({ direction: 'outbound', type: 'text', text_body: text, created_at: hace(min), ai_generated: true, ...extra });

const FICHA_ESCUELA = '🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES MONSTER’S VOLLEY! 🔥 ¿Quieres llevar tu juego al siguiente nivel? Esta es una oportunidad para aprender de referentes del voleibol.';

describe('itemNombradoEn', () => {
    it('reconoce la clínica por la palabra de evento y su nombre', () => {
        expect(itemNombradoEn('Quisiera info de la clínica de armadores', ITEMS)?.id).toBe(CLINICA.id);
        expect(itemNombradoEn('¿Cuánto cuesta la clínica? ¿Como aparto mi cupo?', ITEMS)?.id).toBe(CLINICA.id);
    });
    it('reconoce un ítem sin palabra de evento por todas sus palabras distintivas', () => {
        expect(itemNombradoEn('quiero inscribirme a la copa relampago indoor', ITEMS)?.id).toBe(COPA.id);
    });
    it('no inventa: un saludo o una pregunta del club no nombran servicio', () => {
        expect(itemNombradoEn('Hola', ITEMS)).toBeNull();
        expect(itemNombradoEn('cuánto vale la mensualidad', ITEMS)).toBeNull();
    });
});

describe('pideElClub', () => {
    it('clase de prueba, mensualidad o entrar al club son pedidos explícitos del club', () => {
        expect(pideElClub('Es posible agendar una clase de prueba para la Sede Norte?')).toBe(true);
        expect(pideElClub('cuánto vale la mensualidad')).toBe(true);
        expect(pideElClub('quiero inscribirla en el club')).toBe(true);
    });
    it('preguntas de la clínica que mencionan entreno o sede NO sacan de la venta', () => {
        expect(pideElClub('y cuánto duraría cada entreno?')).toBe(false);
        expect(pideElClub('en qué sede es?')).toBe(false);
        expect(pideElClub('Hola')).toBe(false);
        expect(pideElClub('ese día tenemos torneo, hay otra fecha?')).toBe(false);
    });
});

describe('ventaActiva', () => {
    it('«campamento» de la familia NO pasa por encima de la ficha de la clínica (Gabriela, 10-nov)', () => {
        const m = [
            sal(300, FICHA_ESCUELA, { ai_generated: false }),
            ent(200, 'Estoy interesada en inscribir a mi hija para el campamento, te envío el soporte'),
            ent(5, '', { type: 'image' }),
        ];
        const v = ventaActiva(m, ITEMS, { ahora: AHORA });
        expect(v?.item.id).toBe(CLINICA.id);
    });

    // Cambió el 2026-11-11: antes «campamento» solo señalaba el Vacacional (señal débil). Las familias llaman
    // «campamento» a la clínica Y al vacacional: ya no se asume ninguno; sin ficha ni marca no hay venta activa
    // (el bot pregunta cuál).
    it('«campamento» solo, sin ficha ni marca, es ambiguo (clínica o vacacional): no señala ninguno', () => {
        const v = ventaActiva([ent(10, 'info del campamento por favor')], ITEMS, { ahora: AHORA });
        expect(v).toBeNull();
    });

    it('la ficha del bot marcada abre la venta y un «Hola» o «Ok» posterior la mantiene', () => {
        const m = [
            ent(30, '¿Cuánto cuesta la clínica? ¿Como aparto mi cupo?'),
            sal(29, 'ficha...', { payload: { destino_anuncio: 'servicio', servicio_id: CLINICA.id } }),
            ent(5, 'Ok'),
        ];
        const v = ventaActiva(m, ITEMS, { ahora: AHORA });
        expect(v?.item.id).toBe(CLINICA.id);
        expect(['marca', 'nombrado']).toContain(v?.origen);
    });

    it('la ficha pegada a mano por la escuela (no IA) abre la venta (caso Nicolás, 4 días antes)', () => {
        const m = [
            ent(4 * 24 * 60 + 10, 'Suba'),
            sal(4 * 24 * 60, FICHA_ESCUELA, { ai_generated: false }),
            ent(3, '', { type: 'image' }),
        ];
        const v = ventaActiva(m, ITEMS, { ahora: AHORA });
        expect(v?.item.id).toBe(CLINICA.id);
        expect(v?.origen).toBe('texto_saliente');
    });

    it('la respuesta al «Sí» de la campaña (texto completo) abre la venta', () => {
        const m = [
            sal(60, 'plantilla', { type: 'template', ai_generated: false, payload: { step: 'campana', campana_id: 'c1' } }),
            ent(50, 'Sí, envíame la info', { type: 'button' }),
            sal(50, FICHA_ESCUELA, { ai_generated: false, payload: { step: 'campana_respuesta_si' } }),
            ent(2, 'Si me interesa reservar'),
        ];
        expect(ventaActiva(m, ITEMS, { ahora: AHORA })?.item.id).toBe(CLINICA.id);
    });

    it('la presentación del bot que solo NOMBRA la clínica no abre una venta', () => {
        const m = [
            ent(10, 'Hola'),
            sal(9, 'Por ahora tenemos la Clínica de Armadores y Atacantes y el Vacacional de Voleibol en la Sede Suba.'),
        ];
        expect(ventaActiva(m, ITEMS, { ahora: AHORA })).toBeNull();
    });

    it('si después de la venta pide la clase de prueba, sale de la venta', () => {
        const m = [
            sal(60, 'ficha', { payload: { [MARCA_VENTA]: CLINICA.id } }),
            ent(5, 'Es posible agendar una clase de prueba para la Sede Norte?'),
        ];
        expect(ventaActiva(m, ITEMS, { ahora: AHORA })).toBeNull();
    });

    it('si vuelve a nombrar la clínica después de preguntar por el club, vuelve a la venta', () => {
        const m = [
            ent(60, 'cuánto vale la mensualidad'),
            ent(5, 'y la clínica de armadores cuánto vale?'),
        ];
        expect(ventaActiva(m, ITEMS, { ahora: AHORA })?.item.id).toBe(CLINICA.id);
    });

    it('una señal de hace más de 7 días ya no cuenta; un servicio vencido tampoco', () => {
        const vieja = [sal(8 * 24 * 60, 'ficha', { payload: { [MARCA_VENTA]: CLINICA.id } }), ent(1, 'Hola')];
        expect(ventaActiva(vieja, ITEMS, { ahora: AHORA })).toBeNull();
        const reciente = [sal(60, 'ficha', { payload: { [MARCA_VENTA]: CLINICA.id } }), ent(1, 'Hola')];
        expect(ventaActiva(reciente, [VACACIONAL], { ahora: AHORA })).toBeNull();
    });

    it('sin señal en los mensajes, el servicio del lead sostiene la venta', () => {
        const v = ventaActiva([ent(1, 'Hola')], ITEMS, { ahora: AHORA, leadServicioId: CLINICA.id });
        expect(v?.item.id).toBe(CLINICA.id);
        expect(v?.origen).toBe('lead');
    });
});

// ─── Monster 2026-11-15, Marco: la venta de la clínica no dura para siempre ──────────────────────────────────
describe('ventaActiva — el arrastre de Marco', () => {
    const DIA = 24 * 60;
    const AHORA_M = new Date('2026-11-15T21:18:00Z').getTime(); // 16:18 hora Bogotá
    const haceM = (min: number) => new Date(AHORA_M - min * 60_000).toISOString();
    const ENTRANTE = (min: number, text: string): FilaReciente => ({ direction: 'inbound', type: 'text', text_body: text, created_at: haceM(min) });
    const ESCUELA = (min: number, text: string): FilaReciente => ({ direction: 'outbound', type: 'text', text_body: text, created_at: haceM(min), ai_generated: false });
    const PITCH = 'Pasamos a recordar que mañana cerramos la venta de entradas a nuestra clínica con valor de preventa y a partir del 11 de noviembre el valor cambia, puedes apartar tu cupo con valor de preventa abonando $150.000';
    const MENSUALIDAD = 'Buen día Marco. Pasamos a recordar e informar que el trámite debe quedar listo hoy. En septiembre pagaste $135.000 de mensualidad. NOTA La mensualidad del club es de $145.000';

    it('una derivación del bot («Eso te lo confirma la escuela») con marca NO sostiene la venta', () => {
        const mensajes = [
            ENTRANTE(6 * DIA - 10, 'Hola yo ya les respondí el mensaje por correo y solo debo 10mil de este mes'),
            { direction: 'outbound', type: 'text', text_body: 'Eso te lo confirma la escuela por aquí 🙌 Ya le pasé tu pregunta.', created_at: haceM(6 * DIA), ai_generated: true,
                payload: { [MARCA_VENTA]: CLINICA.id, step: 'venta_servicio_a_la_escuela' } } as FilaReciente,
        ];
        expect(ventaActiva(mensajes, ITEMS, { ahora: AHORA_M })).toBeNull();
    });

    it('la escuela ofreció la clínica el 9 y el 11 le escribió de su mensualidad: la venta está cerrada', () => {
        const mensajes = [ESCUELA(6 * DIA - 60, PITCH), ESCUELA(4 * DIA, MENSUALIDAD),
            ENTRANTE(6 * DIA - 10, 'Hola yo ya les respondí el mensaje por correo y solo debo 10mil de este mes')];
        expect(ventaActiva(mensajes, ITEMS, { ahora: AHORA_M })).toBeNull();
    });

    it('sin el mensaje de mensualidad, la oferta de la escuela sí sostiene la venta (no se rompe lo de siempre)', () => {
        expect(ventaActiva([ESCUELA(5 * DIA, PITCH)], ITEMS, { ahora: AHORA_M })?.item.id).toBe(CLINICA.id);
    });

    it('un mensaje de la escuela que nombra la clínica Y la mensualidad no cierra la venta', () => {
        const mixto = `${PITCH} Recuerda que la mensualidad del club va aparte.`;
        expect(ventaActiva([ESCUELA(2 * DIA, mixto)], ITEMS, { ahora: AHORA_M })?.item.id).toBe(CLINICA.id);
    });

    it('el bot que nombra el club en su presentación NO cierra la venta', () => {
        const bot = { direction: 'outbound', type: 'text', ai_generated: true, created_at: haceM(60),
            text_body: 'Soy Mapi. Te ayudo con la mensualidad, horarios y tu clase de prueba del club.' } as FilaReciente;
        expect(ventaActiva([ESCUELA(2 * DIA, PITCH), bot], ITEMS, { ahora: AHORA_M })?.item.id).toBe(CLINICA.id);
    });

    it('un paso real de la venta con marca (el pago) sí la sostiene', () => {
        const pago = { direction: 'outbound', type: 'text', ai_generated: true, created_at: haceM(3 * DIA),
            text_body: 'Para separar tu cupo en la Clínica…', payload: { [MARCA_VENTA]: CLINICA.id, step: 'venta_servicio_pago' } } as FilaReciente;
        expect(ventaActiva([pago], ITEMS, { ahora: AHORA_M })?.origen).toBe('marca');
    });
});
