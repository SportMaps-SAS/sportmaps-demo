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
