/**
 * Destino por anuncio (Monster 2026-11-04, spec whatsapp-anuncios-atribucion §2).
 *
 * El interesado que toca el anuncio de la *Clínica de armadores y atacantes* y
 * escribe «quiero información» recibe la ficha de la clínica con el precio de
 * HOY, el abono, las cuentas y el motivo esperado — nunca el embudo de la clase
 * de prueba. Sin base y sin Meta: el contexto es un doble.
 *
 * Lo que se vigila:
 *   · el mapeo de la escuela manda; sin mapeo se infiere del anuncio y del texto;
 *   · palabra de evento sin servicio activo → una persona (nunca el embudo equivocado);
 *   · sin anuncio solo cuenta la intención escrita con un servicio ACTIVO que calce;
 *   · el precio de hoy sale de `precios_por_fecha` (y el de afiliado si lo es);
 *   · nunca silencio, nunca «gratis», nunca un cobro ni un link.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    resultado: { data: null as any, error: null as any },
    tablas: [] as string[],
}));

vi.mock('../config/supabase', () => {
    const builder: any = {};
    for (const m of ['select', 'eq', 'is', 'in', 'limit', 'order']) builder[m] = () => builder;
    builder.then = (ok: any, ko: any) => Promise.resolve(h.resultado).then(ok, ko);
    return { supabase: { from: (t: string) => { h.tablas.push(t); return builder; }, rpc: async () => ({ data: null, error: null }) } };
});

import {
    atenderDestinoDeAnuncio, decidirDestino, diaLegible, eleccionPendiente, eventosNombrados, fichaReciente,
    inferirServicio, mapeoDeAnuncio, mapeoDesdeFila, necesitaCatalogo, precioDelServicio, referralDeLaRafaga,
    referralDePayload, textoFichaDeServicio, textoAPersona, motivoDeServicio, MARCA_DESTINO, CTA_FICHA_DE_SERVICIO,
    type CtxAnuncio, type ItemConFicha, type MapeoAnuncio, type ReferralAnuncio,
} from './whatsapp-anuncio-destino';
import { MARCA_VENTA } from './whatsapp-venta-contexto';
import { EVENTO_DE_SERVICIO, normalizarFrase, type FilaReciente } from './whatsapp-reglas-turno';
import { detalleDeAnuncio } from './whatsapp-prospecto-lead.service';

// ─── Datos (la clínica de Monster tal como está en la base) ─────────────────

const CLINICA: ItemConFicha = {
    id: 'srv-clinica', name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000, active: true,
    event_id: null, starts_at: '2026-11-21T05:00:00Z', ends_at: '2026-11-23T04:59:00Z',
    allow_installments: true, precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    abono_minimo_pct: 50, opciones: null,
    description: 'Clínica de armadores y atacantes con Jorge Mesa. 21 y 22 de noviembre, 9:00 a. m. a 3:00 p. m. ' +
        'Preventa $300.000 hasta el 10 de noviembre; desde el 11, $350.000. Afiliados $250.000.',
    image_url: null,
};
const PERFECCIONAMIENTO: ItemConFicha = {
    id: 'srv-perf', name: 'Clase de perfeccionamiento', kind: 'clase_extra', price: 25000, active: true, event_id: null,
    starts_at: null, ends_at: null, description: 'Técnica individual.',
};
const VACACIONAL: ItemConFicha = {
    id: 'srv-vac', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional', price: 100000, active: true, event_id: null,
    starts_at: null, ends_at: null, description: null,
    opciones: [
        { clave: '1', etiqueta: '1 semana', precio: 100000, precio_afiliado: 80000 },
        { clave: '2', etiqueta: '2 semanas', precio: 140000, precio_afiliado: 120000 },
    ],
};

const ANUNCIO_CLINICA = {
    source_id: '120210000000001', source_type: 'ad', source_url: 'https://fb.me/abc',
    headline: 'Clínica de armadores y atacantes', body: 'Con Jorge Mesa, 21 y 22 de noviembre. ¡Separa tu cupo!',
    media_type: 'image', ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ',
};
const ANUNCIO_CLASE = {
    source_id: '120210000000002', source_type: 'ad', headline: 'Ven a tu clase de prueba de voleibol',
    body: 'Entrena con Monster´s Volley Club en la sede Norte o Suba.', ctwa_clid: 'ARAkzz',
};
const ANUNCIO_GENERICO = { source_id: '120210000000003', source_type: 'ad', headline: '¡Inscríbete ya!', body: 'Cupos limitados.' };

const ref = (r: Record<string, unknown>) => referralDePayload({ referral: r })!;
const hace = (seg: number) => new Date(Date.now() - seg * 1000).toISOString();
const entrante = (texto: string, payload: any = {}, seg = 2): FilaReciente =>
    ({ direction: 'inbound', text_body: texto, payload, created_at: hace(seg), wa_timestamp: hace(seg) });
const saliente = (payload: any, seg = 30): FilaReciente =>
    ({ direction: 'outbound', text_body: '…', payload, ai_generated: true, created_at: hace(seg), wa_timestamp: hace(seg) });

// ─── El anuncio ──────────────────────────────────────────────────────────────

describe('referral de Meta', () => {
    it('lee el mensaje crudo del webhook (payload con `referral`) y el referral suelto', () => {
        const crudo = { from: '573001112233', id: 'wamid.1', type: 'text', text: { body: 'Hola' }, referral: ANUNCIO_CLINICA };
        expect(referralDePayload(crudo)).toEqual({
            sourceId: '120210000000001', sourceType: 'ad', sourceUrl: 'https://fb.me/abc',
            headline: 'Clínica de armadores y atacantes', body: 'Con Jorge Mesa, 21 y 22 de noviembre. ¡Separa tu cupo!',
            mediaType: 'image', ctwaClid: 'ARAkLkA8rmlFeiCktEJQ',
        });
        expect(referralDePayload(ANUNCIO_CLINICA)?.sourceId).toBe('120210000000001');
        expect(referralDePayload({ from: '57300', text: { body: 'Hola' } })).toBeNull();
        expect(referralDePayload(null)).toBeNull();
        expect(referralDePayload({ referral: {} })).toBeNull();
    });

    it('solo cuenta el anuncio de la ráfaga SIN contestar (el turno corre con el último mensaje)', () => {
        // Anuncio en el primero, el turno corre con el segundo.
        expect(referralDeLaRafaga([entrante('¿cuánto vale?', {}, 1), entrante('Hola', { referral: ANUNCIO_CLINICA }, 5)])?.headline)
            .toBe('Clínica de armadores y atacantes');
        // Ese anuncio ya se contestó: no vuelve a decidir.
        expect(referralDeLaRafaga([entrante('gracias', {}, 1), saliente({ step: 'x' }, 3), entrante('Hola', { referral: ANUNCIO_CLINICA }, 5)]))
            .toBeNull();
    });
});

// ─── Inferencia ─────────────────────────────────────────────────────────────

describe('inferencia del servicio', () => {
    it('lo que la campaña cuenta como evento (EVENTO_DE_SERVICIO), el destino también', () => {
        for (const t of ['la clínica', 'clinicas', 'el campamento', 'vacacionales', 'vacaciones recreativas']) {
            expect(EVENTO_DE_SERVICIO.test(normalizarFrase(t))).toBe(true);
            expect(eventosNombrados([t]).length).toBeGreaterThan(0);
        }
        expect(eventosNombrados(['torneo de voleibol'])).toEqual(['torneo']);
        expect(eventosNombrados(['quiero información'])).toEqual([]);
    });

    it('el anuncio de la clínica → la clínica (por nombre, aunque haya otra clase_extra activa)', () => {
        const r = inferirServicio(['Clínica de armadores y atacantes', 'Hola, quiero más información'], [PERFECCIONAMIENTO, CLINICA]);
        expect(r).toEqual({ tipo: 'uno', item: CLINICA });
    });

    it('sin el nombre en el ítem, calza por su kind (clínica = clase_extra)', () => {
        expect(inferirServicio(['info de la clínica'], [PERFECCIONAMIENTO])).toEqual({ tipo: 'uno', item: PERFECCIONAMIENTO });
    });

    it('evento sin servicio activo que calce, o sin palabra de evento', () => {
        expect(inferirServicio(['vacacional de diciembre'], [CLINICA])).toEqual({ tipo: 'evento_sin_servicio', evento: 'vacacional' });
        expect(inferirServicio(['Entrena con nosotros'], [CLINICA])).toEqual({ tipo: 'sin_evento' });
    });

    it('dos clínicas: gana la que nombra el anuncio; empate = varios', () => {
        const otra: ItemConFicha = { ...CLINICA, id: 'srv-clinica-2', name: 'Clínica de líberos' };
        expect(inferirServicio(['Clínica de armadores'], [CLINICA, otra])).toEqual({ tipo: 'uno', item: CLINICA });
        const r = inferirServicio(['info de la clínica'], [CLINICA, otra]);
        expect(r.tipo).toBe('varios');
    });

    it('el motivo de cobro es el kind (la clínica es clase_extra)', () => {
        expect(motivoDeServicio(CLINICA)).toBe('clase_extra');
        expect(motivoDeServicio({ kind: 'raro' })).toBe('otro');
    });
});

describe('decidirDestino', () => {
    const items = [CLINICA];
    const decidir = (p: { referral?: ReferralAnuncio | null; mapeo?: MapeoAnuncio | null; texto: string; items?: ItemConFicha[]; eleccion?: string[] | null }) =>
        decidirDestino({ referral: p.referral ?? null, mapeo: p.mapeo ?? null, texto: p.texto, items: p.items ?? items, eleccion: p.eleccion ?? null });

    it('el mapeo manda: persona, clase de prueba, servicio (y el servicio ya inactivo → persona)', () => {
        const r = ref(ANUNCIO_GENERICO);
        expect(decidir({ referral: r, mapeo: { destino: 'persona', servicioId: null }, texto: 'Hola' }))
            .toEqual({ destino: 'persona', motivo: 'mapeo' });
        expect(decidir({ referral: ref(ANUNCIO_CLINICA), mapeo: { destino: 'clase_prueba', servicioId: null }, texto: 'Hola' }))
            .toEqual({ destino: 'clase_prueba', origen: 'mapeo' });
        expect(decidir({ referral: r, mapeo: { destino: 'servicio', servicioId: CLINICA.id }, texto: 'Hola' }))
            .toEqual({ destino: 'servicio', item: CLINICA, origen: 'mapeo' });
        expect(decidir({ referral: r, mapeo: { destino: 'servicio', servicioId: 'otro-id' }, texto: 'Hola' }))
            .toEqual({ destino: 'persona', motivo: 'servicio_no_disponible' });
    });

    it('sin mapeo: el anuncio de la clínica → la clínica; el de la clase de prueba o uno sin evento → el embudo de siempre', () => {
        expect(decide(ANUNCIO_CLINICA, 'Hola, quiero más información')).toMatchObject({ destino: 'servicio', item: CLINICA, origen: 'anuncio' });
        expect(decide(ANUNCIO_CLASE, 'Hola, quiero más información')).toEqual({ destino: 'clase_prueba', origen: 'anuncio' });
        expect(decide(ANUNCIO_GENERICO, 'Hola')).toEqual({ destino: 'clase_prueba', origen: 'anuncio' });
        function decide(a: Record<string, unknown>, texto: string) { return decidir({ referral: ref(a), texto }); }
    });

    it('anuncio de un evento que ya no está activo → una persona, nunca la clase de prueba', () => {
        expect(decidir({ referral: ref({ source_id: 'x', headline: 'Vacacional de diciembre' }), texto: 'Info' }))
            .toEqual({ destino: 'persona', motivo: 'evento_sin_servicio', evento: 'vacacional' });
    });

    it('mapeado a «servicio» sin decir cuál: el único activo; con varios, una persona', () => {
        const m: MapeoAnuncio = { destino: 'servicio', servicioId: null };
        expect(decidir({ referral: ref(ANUNCIO_GENERICO), mapeo: m, texto: 'Hola' })).toMatchObject({ destino: 'servicio', item: CLINICA });
        expect(decidir({ referral: ref(ANUNCIO_GENERICO), mapeo: m, texto: 'Hola', items: [CLINICA, PERFECCIONAMIENTO] }))
            .toEqual({ destino: 'persona', motivo: 'servicio_no_disponible' });
    });

    it('sin anuncio: «info / precio de la clínica», «quiero inscribirme a la clínica» → la clínica', () => {
        for (const t of ['info de la clínica', 'precio de la clínica', 'quiero inscribirme a la clínica', 'Cuánto vale la clinica?']) {
            expect(decidir({ texto: t })).toMatchObject({ destino: 'servicio', item: CLINICA, origen: 'texto' });
        }
    });

    it('sin anuncio NO: saludo, clase de prueba, «ya pagué la clínica», un evento sin servicio activo', () => {
        for (const t of ['Hola', 'quiero información', 'quiero una clase de prueba', 'ya pagué la clínica', 'te envío el comprobante de la clínica', 'info del vacacional']) {
            expect(decide(t)).toBeNull();
        }
        function decide(t: string) { return decidir({ texto: t }); }
    });

    it('la lista de «varios»: «2» o el nombre eligen; otra cosa no', () => {
        const eleccion = [PERFECCIONAMIENTO.id, CLINICA.id];
        const its = [CLINICA, PERFECCIONAMIENTO];
        expect(decidir({ texto: '2', eleccion, items: its })).toMatchObject({ destino: 'servicio', item: CLINICA, origen: 'eleccion' });
        expect(decidir({ texto: 'la de armadores', eleccion, items: its })).toMatchObject({ destino: 'servicio', item: CLINICA });
        expect(decidir({ texto: 'gracias', eleccion, items: its })).toBeNull();
    });

    it('barato primero: solo lee el catálogo si hace falta', () => {
        expect(necesitaCatalogo({ referral: null, mapeo: null, texto: 'Hola', eleccion: null })).toBe(false);
        expect(necesitaCatalogo({ referral: null, mapeo: null, texto: 'info de la clínica', eleccion: null })).toBe(true);
        expect(necesitaCatalogo({ referral: ref(ANUNCIO_CLASE), mapeo: null, texto: 'Hola', eleccion: null })).toBe(false);
        expect(necesitaCatalogo({ referral: ref(ANUNCIO_CLINICA), mapeo: null, texto: 'Hola', eleccion: null })).toBe(true);
        expect(necesitaCatalogo({ referral: ref(ANUNCIO_CLINICA), mapeo: { destino: 'persona', servicioId: null }, texto: 'Hola', eleccion: null })).toBe(false);
    });
});

// ─── Precio de hoy ───────────────────────────────────────────────────────────

describe('precio de hoy de la clínica', () => {
    it('preventa: $300.000 hasta el 10-nov, con el tramo que sigue y el abono del 50 %', () => {
        expect(precioDelServicio(CLINICA, { afiliado: false, hoy: '2026-11-04' })).toEqual({
            hoy: 300000, deAfiliado: false, siguiente: { desde: '2026-11-11', precio: 350000 }, abono: 150000, abonoPct: 50, opciones: [],
        });
    });
    it('desde el 11-nov: $350.000, sin tramo siguiente; abono $175.000', () => {
        expect(precioDelServicio(CLINICA, { afiliado: false, hoy: '2026-11-11' })).toMatchObject({ hoy: 350000, siguiente: null, abono: 175000 });
    });
    it('afiliado: $250.000 antes y después de la preventa; abono $125.000', () => {
        for (const hoy of ['2026-11-04', '2026-11-15']) {
            expect(precioDelServicio(CLINICA, { afiliado: true, hoy })).toMatchObject({ hoy: 250000, deAfiliado: true, siguiente: null, abono: 125000 });
        }
    });
    it('opciones (vacacional por semanas): una línea por opción, sin abono', () => {
        expect(precioDelServicio(VACACIONAL, { afiliado: false, hoy: '2026-11-04' }).opciones)
            .toEqual([{ etiqueta: '1 semana', precio: 100000 }, { etiqueta: '2 semanas', precio: 140000 }]);
        expect(precioDelServicio(VACACIONAL, { afiliado: true, hoy: '2026-11-04' })).toMatchObject({ deAfiliado: true, abono: null });
    });
    it('«10 de noviembre» = el día antes del tramo', () => {
        expect(diaLegible('2026-11-11', 1)).toBe('10 de noviembre');
        expect(diaLegible('2026-12-01', 1)).toBe('30 de noviembre');
    });
});

describe('la ficha', () => {
    const CUENTAS = [{ tipo: 'Nequi', numero: '3194505150', titular: 'Monster Volley' }];

    // Frente A (2026-11-08): la ficha ya NO trae el bloque de pago pegado (Monster: con
    // 2.581 caracteres la cuenta quedaba al final y nadie la veía). Las cuentas van en
    // un mensaje aparte y solo si las pide (`textoDePagoDeServicio`); la ficha cierra
    // con el próximo paso.
    it('descripción de la escuela, cuándo, valor de hoy y abono, SIN la cuenta pegada; nunca «gratis»', () => {
        const t = textoFichaDeServicio(CLINICA, precioDelServicio(CLINICA, { afiliado: false, hoy: '2026-11-04' }), CUENTAS);
        expect(t).toContain('*Clínica de armadores y atacantes*');
        expect(t).toContain(CLINICA.description!);
        expect(t).toContain('Cuándo: del 21 al 22 de noviembre');
        expect(t).toContain('Valor hoy: *$300.000* (hasta el 10 de noviembre; desde el 11 de noviembre, *$350.000*)');
        expect(t).toContain('Separas el cupo con un abono mínimo de *$150.000* (50 %).');
        expect(t).not.toContain('3194505150');
        expect(t).toContain(CTA_FICHA_DE_SERVICIO);
        expect(t).not.toMatch(/gratis|undefined|null|NaN/i);
        // Si pidió el pago, el pago sale después: la ficha no lleva ni la cuenta ni el «respóndeme».
        const conPago = textoFichaDeServicio(CLINICA, precioDelServicio(CLINICA, { afiliado: false, hoy: '2026-11-04' }), CUENTAS, { pidePago: true });
        expect(conPago).not.toContain(CTA_FICHA_DE_SERVICIO);
        expect(conPago).not.toContain('3194505150');
    });

    it('si la descripción es el texto completo del anuncio, se manda tal cual, sin la cuenta pegada', () => {
        const largo = `🏐 ¡CLÍNICA!
${'Texto de la escuela. '.repeat(50)}
💰 Inversión: *$300.000*`;
        const item = { ...CLINICA, description: largo };
        const t = textoFichaDeServicio(item, precioDelServicio(item, { afiliado: false, hoy: '2026-11-04' }), CUENTAS);
        expect(t.startsWith(largo)).toBe(true);
        expect(t).not.toContain('Valor hoy');
        expect(t).not.toContain('*Clínica de armadores y atacantes*');
        expect(t).not.toContain('3194505150');
        expect(t.endsWith(CTA_FICHA_DE_SERVICIO)).toBe(true);
    });

    it('texto completo: el afiliado ve además su valor; quien no es afiliado, no', () => {
        const largo = `🏐 ¡CLÍNICA!\n${'Texto de la escuela. '.repeat(50)}`;
        const item = { ...CLINICA, description: largo };
        const af = textoFichaDeServicio(item, precioDelServicio(item, { afiliado: true, hoy: '2026-11-04' }), CUENTAS);
        const no = textoFichaDeServicio(item, precioDelServicio(item, { afiliado: false, hoy: '2026-11-04' }), CUENTAS);
        expect(af).toContain('Como afiliado del club, tu valor es *$250.000*.');
        expect(no).not.toContain('afiliado');
    });

    it('afiliado y sin cuentas cargadas', () => {
        const t = textoFichaDeServicio(CLINICA, precioDelServicio(CLINICA, { afiliado: true, hoy: '2026-11-04' }), []);
        expect(t).toContain('Tu valor como afiliado: *$250.000*');
        expect(t).toContain('abono mínimo de *$125.000*');
        expect(t).toContain('La escuela te escribe por aquí con los datos de pago');
        expect(t).not.toContain('Valor hoy');
    });

    it('a una persona: siempre con una frase que confirma que alguien responde', () => {
        expect(textoAPersona({ destino: 'persona', motivo: 'mapeo' })).toContain('alguien te responde por aquí');
        expect(textoAPersona({ destino: 'persona', motivo: 'evento_sin_servicio', evento: 'vacacional' })).toContain('los datos del vacacional');
        expect(textoAPersona({ destino: 'persona', motivo: 'evento_sin_servicio', evento: 'clinica' })).toContain('los datos de la clínica');
    });
});

// ─── Motor ───────────────────────────────────────────────────────────────────

interface Registro {
    enviados: { texto: string; contexto: Record<string, unknown> }[];
    leads: any[];
    esperados: any[];
    avisos: string[];
    embudo: number;
    lecturas: { servicios: number; mapeo: number; afiliado: number };
}

function ctxDe(o: {
    recientes: FilaReciente[]; items?: ItemConFicha[]; mapeo?: MapeoAnuncio | null; afiliado?: boolean;
    cuentas?: { tipo: string; numero: string }[]; yaContestado?: boolean; embudo?: boolean; ahora?: string;
}): { ctx: CtxAnuncio; reg: Registro } {
    const reg: Registro = { enviados: [], leads: [], esperados: [], avisos: [], embudo: 0, lecturas: { servicios: 0, mapeo: 0, afiliado: 0 } };
    const ctx: CtxAnuncio = {
        schoolId: 'school-monster',
        recientes: async () => o.recientes,
        mapeo: async () => { reg.lecturas.mapeo++; return o.mapeo ?? null; },
        servicios: async () => { reg.lecturas.servicios++; return o.items ?? [CLINICA]; },
        afiliado: async () => { reg.lecturas.afiliado++; return o.afiliado ?? false; },
        cuentas: async () => o.cuentas ?? [{ tipo: 'Nequi', numero: '3194505150' }],
        saludo: async () => '',
        yaContestado: async () => o.yaContestado ?? false,
        guardarLead: async (l) => { reg.leads.push(l); return 'lead-1'; },
        registrarEsperado: async (e) => { reg.esperados.push(e); return true; },
        enviar: async (texto, contexto) => { reg.enviados.push({ texto, contexto }); },
        avisarEscuela: async (d) => { reg.avisos.push(d); },
        iniciarEmbudo: async () => { reg.embudo++; return o.embudo ?? true; },
        ahora: () => new Date(o.ahora ?? '2026-11-04T15:00:00Z'),
    };
    return { ctx, reg };
}

describe('atenderDestinoDeAnuncio', () => {
    beforeEach(() => { h.tablas = []; });

    it('anuncio de la clínica + «quiero información»: UNA ficha, lead con servicio y anuncio, motivo esperado clase_extra', async () => {
        const { ctx, reg } = ctxDe({ recientes: [entrante('Hola, quiero más información', { referral: ANUNCIO_CLINICA })] });
        expect(await atenderDestinoDeAnuncio(ctx, 'Hola, quiero más información')).toBe('anuncio_servicio');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toContain('*Clínica de armadores y atacantes*');
        expect(reg.enviados[0].texto).toContain('Valor hoy: *$300.000*');
        expect(reg.enviados[0].texto).not.toMatch(/sede|nombre completo|clase de prueba|gratis/i);
        expect(reg.enviados[0].contexto).toMatchObject({
            [MARCA_DESTINO]: 'servicio', servicio_id: CLINICA.id, precio_hoy: 300000, abono: 150000, origen_destino: 'anuncio',
            motivo_esperado: { motivo: 'clase_extra', monto: null, registrado: true },
            anuncio: { source_id: '120210000000001', headline: 'Clínica de armadores y atacantes', ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ' },
        });
        expect(reg.leads).toEqual([{
            estado: 'respondido', servicio: { id: CLINICA.id, nombre: CLINICA.name, tipo: 'clase_extra' },
            anuncio: expect.objectContaining({ source_id: '120210000000001' }),
        }]);
        // El esperado queda a nombre del lead (la cola lo encuentra por él).
        expect(reg.esperados).toEqual([{ motivo: 'clase_extra', leadId: 'lead-1' }]);
        expect(reg.embudo).toBe(0);
        expect(reg.avisos).toEqual([]);
        // El precio de afiliado se pregunta porque la clínica lo tiene.
        expect(reg.lecturas.afiliado).toBe(1);
    });

    it('caso 4 (Monster 11-08): el prellenado «¿Cuánto cuesta la clínica? ¿Cómo aparto mi cupo?» → la ficha y DESPUÉS el pago aparte', async () => {
        const PRELLENADO = '¿Cuánto cuesta la clínica? ¿Cómo aparto mi cupo?';
        const largo = `🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES MONSTER’S VOLLEY! 🔥\n${'Texto de la escuela. '.repeat(100)}`;
        const item = { ...CLINICA, description: largo };
        const { ctx, reg } = ctxDe({
            recientes: [entrante(PRELLENADO, { referral: ANUNCIO_CLINICA })], items: [item],
            cuentas: [{ tipo: 'Nequi', numero: '3194505150', titular: 'Iván Sossa' } as any],
        });
        expect(await atenderDestinoDeAnuncio(ctx, PRELLENADO)).toBe('anuncio_servicio');
        expect(reg.enviados).toHaveLength(2);
        const [ficha, pago] = reg.enviados;
        // La ficha: el texto de la escuela, sin la cuenta ni el «respóndeme» (el pago va enseguida).
        expect(ficha.texto.startsWith(largo.trim())).toBe(true);
        expect(ficha.texto).not.toContain('3194505150');
        expect(ficha.contexto).toMatchObject({ [MARCA_DESTINO]: 'servicio', servicio_id: CLINICA.id, [MARCA_VENTA]: CLINICA.id });
        // El pago: corto, aparte, con el precio de hoy, el tramo con la fecha correcta, abono, cuenta con titular y el cierre.
        expect(pago.texto.length).toBeLessThan(600);
        expect(pago.texto).toContain('Valor hoy: *$300.000* (hasta el martes 10 de noviembre; desde el 11, *$350.000*)');
        expect(pago.texto).toContain('abono mínimo de *$150.000* (50 %)');
        expect(pago.texto).toContain('Nequi al número 3194505150 (a nombre de Iván Sossa)');
        expect(pago.texto).toContain('nombre completo de quien asiste');
        expect(pago.texto).not.toMatch(/9 de noviembre|clase de prueba|sede/i);
        expect(pago.contexto).toMatchObject({ [MARCA_VENTA]: CLINICA.id, step: 'venta_servicio_pago', datos_de_pago: true });
        expect(pago.contexto).not.toHaveProperty(MARCA_DESTINO);
    });

    it('sin pedir el pago («quiero más información»): UNA ficha con el próximo paso, sin la cuenta', async () => {
        const { ctx, reg } = ctxDe({ recientes: [entrante('Hola, quiero más información', { referral: ANUNCIO_CLINICA })] });
        await atenderDestinoDeAnuncio(ctx, 'Hola, quiero más información');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toContain(CTA_FICHA_DE_SERVICIO);
        expect(reg.enviados[0].texto).not.toContain('3194505150');
        expect(reg.enviados[0].contexto).toMatchObject({ [MARCA_VENTA]: CLINICA.id });
    });

    it('afiliado: la ficha dice su valor ($250.000)', async () => {
        const { ctx, reg } = ctxDe({ recientes: [entrante('Hola', { referral: ANUNCIO_CLINICA })], afiliado: true });
        await atenderDestinoDeAnuncio(ctx, 'Hola');
        expect(reg.enviados[0].texto).toContain('Tu valor como afiliado: *$250.000*');
        expect(reg.enviados[0].contexto).toMatchObject({ precio_hoy: 250000, afiliado: true });
    });

    it('el 11-nov el precio de hoy ya es $350.000', async () => {
        const { ctx, reg } = ctxDe({ recientes: [entrante('Hola', { referral: ANUNCIO_CLINICA })], ahora: '2026-11-11T15:00:00Z' });
        await atenderDestinoDeAnuncio(ctx, 'Hola');
        expect(reg.enviados[0].texto).toContain('Valor hoy: *$350.000*');
        expect(reg.enviados[0].texto).not.toContain('$300.000*');
    });

    it('con mapeo: un anuncio genérico mapeado a la clínica → la ficha (la inferencia sola no la habría encontrado)', async () => {
        const { ctx, reg } = ctxDe({
            recientes: [entrante('Hola', { referral: ANUNCIO_GENERICO })], mapeo: { destino: 'servicio', servicioId: CLINICA.id },
            items: [CLINICA, PERFECCIONAMIENTO],
        });
        expect(await atenderDestinoDeAnuncio(ctx, 'Hola')).toBe('anuncio_servicio');
        expect(reg.enviados[0].contexto).toMatchObject({ servicio_id: CLINICA.id, origen_destino: 'mapeo' });
    });

    it('mapeo «persona»: le confirma que le responde alguien y avisa a la escuela (nunca silencio)', async () => {
        const { ctx, reg } = ctxDe({ recientes: [entrante('Hola', { referral: ANUNCIO_CLINICA })], mapeo: { destino: 'persona', servicioId: null } });
        expect(await atenderDestinoDeAnuncio(ctx, 'Hola')).toBe('anuncio_persona');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toContain('alguien te responde por aquí');
        expect(reg.avisos[0]).toContain('Llegó por el anuncio «Clínica de armadores y atacantes» (id 120210000000001)');
        expect(reg.lecturas.servicios).toBe(0);
        expect(reg.esperados).toEqual([]);
    });

    it('anuncio de la clase de prueba (o sin evento): arranca el embudo de siempre, sin ficha', async () => {
        for (const a of [ANUNCIO_CLASE, ANUNCIO_GENERICO]) {
            const { ctx, reg } = ctxDe({ recientes: [entrante('Hola', { referral: a })] });
            expect(await atenderDestinoDeAnuncio(ctx, 'Hola, quiero información')).toBe('anuncio_embudo');
            expect(reg.embudo).toBe(1);
            expect(reg.enviados).toEqual([]);
            expect(reg.leads[0]).toMatchObject({ estado: 'nuevo', servicio: null });
        }
    });

    it('anuncio de la clase de prueba a quien ya se le contestó (o sin embudo): lo atiende el bot de siempre', async () => {
        const ya = ctxDe({ recientes: [entrante('Hola', { referral: ANUNCIO_CLASE })], yaContestado: true });
        expect(await atenderDestinoDeAnuncio(ya.ctx, 'Hola')).toBeNull();
        expect(ya.reg.embudo).toBe(0);
        const sin = ctxDe({ recientes: [entrante('Hola', { referral: ANUNCIO_CLASE })], embudo: false });
        expect(await atenderDestinoDeAnuncio(sin.ctx, 'Hola')).toBeNull();
        expect(sin.reg.leads).toEqual([]);
    });

    it('«info de la clínica» sin anuncio → la ficha; «Hola» sin anuncio no lee nada', async () => {
        const a = ctxDe({ recientes: [entrante('info de la clínica')] });
        expect(await atenderDestinoDeAnuncio(a.ctx, 'info de la clínica')).toBe('anuncio_servicio');
        expect(a.reg.enviados[0].contexto).toMatchObject({ origen_destino: 'texto' });
        expect(a.reg.enviados[0].contexto).not.toHaveProperty('anuncio');

        const b = ctxDe({ recientes: [entrante('Hola')] });
        expect(await atenderDestinoDeAnuncio(b.ctx, 'Hola')).toBeNull();
        expect(b.reg.lecturas).toEqual({ servicios: 0, mapeo: 0, afiliado: 0 });
    });

    it('las fases: «anuncio» solo con anuncio, «texto» solo sin anuncio', async () => {
        const conAnuncio = ctxDe({ recientes: [entrante('Hola', { referral: ANUNCIO_CLINICA })] });
        expect(await atenderDestinoDeAnuncio(conAnuncio.ctx, 'Hola', 'texto')).toBeNull();
        const sinAnuncio = ctxDe({ recientes: [entrante('info de la clínica')] });
        expect(await atenderDestinoDeAnuncio(sinAnuncio.ctx, 'info de la clínica', 'anuncio')).toBeNull();
        expect(await atenderDestinoDeAnuncio(sinAnuncio.ctx, 'info de la clínica', 'texto')).toBe('anuncio_servicio');
    });

    it('la misma ficha no se repite en 24 h: lo que pregunte después lo atiende el seguimiento', async () => {
        const previa = saliente({ [MARCA_DESTINO]: 'servicio', servicio_id: CLINICA.id });
        expect(fichaReciente([previa], CLINICA.id)).toBe(true);
        const { ctx, reg } = ctxDe({ recientes: [entrante('precio de la clínica?'), previa] });
        expect(await atenderDestinoDeAnuncio(ctx, 'precio de la clínica?')).toBeNull();
        expect(reg.enviados).toEqual([]);
    });

    it('sin cuentas de pago: la ficha dice que la escuela le escribe y la escuela recibe el aviso', async () => {
        const { ctx, reg } = ctxDe({ recientes: [entrante('Hola', { referral: ANUNCIO_CLINICA })], cuentas: [] });
        expect(await atenderDestinoDeAnuncio(ctx, 'Hola')).toBe('anuncio_servicio');
        expect(reg.enviados[0].texto).toContain('La escuela te escribe por aquí con los datos de pago');
        expect(reg.enviados[0].contexto).toMatchObject({ sin_cuentas: true });
        expect(reg.avisos[0]).toContain('no tiene cuentas de pago cargadas');
    });

    it('servicio sin precio: a una persona, sin inventar un valor', async () => {
        const sinPrecio: ItemConFicha = { ...CLINICA, price: null, precio_afiliado: null, precios_por_fecha: null };
        const { ctx, reg } = ctxDe({ recientes: [entrante('Hola', { referral: ANUNCIO_CLINICA })], items: [sinPrecio] });
        expect(await atenderDestinoDeAnuncio(ctx, 'Hola')).toBe('anuncio_persona');
        expect(reg.enviados[0].texto).toContain('te lo confirma la escuela');
        expect(reg.enviados[0].texto).not.toMatch(/\$\d/);
        expect(reg.esperados).toEqual([]);
    });

    it('anuncio de un vacacional que no está activo → una persona', async () => {
        const { ctx, reg } = ctxDe({ recientes: [entrante('Info', { referral: { source_id: 'v1', headline: 'Vacacional de diciembre' } })] });
        expect(await atenderDestinoDeAnuncio(ctx, 'Info')).toBe('anuncio_persona');
        expect(reg.enviados[0].texto).toContain('los datos del vacacional');
        expect(reg.embudo).toBe(0);
    });

    it('varios que calzan: la lista; el siguiente «2» elige', async () => {
        const otra: ItemConFicha = { ...CLINICA, id: 'srv-clinica-2', name: 'Clínica de líberos', precio_afiliado: null };
        const a = ctxDe({ recientes: [entrante('info de la clínica')], items: [CLINICA, otra] });
        expect(await atenderDestinoDeAnuncio(a.ctx, 'info de la clínica')).toBe('anuncio_varios');
        expect(a.reg.enviados[0].texto).toContain('1. *Clínica de armadores y atacantes* — $300.000');
        const lista = saliente(a.reg.enviados[0].contexto, 10);
        expect(eleccionPendiente([lista])).toEqual([CLINICA.id, otra.id]);

        const b = ctxDe({ recientes: [entrante('2', {}, 1), lista], items: [CLINICA, otra] });
        expect(await atenderDestinoDeAnuncio(b.ctx, '2')).toBe('anuncio_servicio');
        expect(b.reg.enviados[0].contexto).toMatchObject({ servicio_id: otra.id, origen_destino: 'eleccion' });
    });
});

// ─── Lecturas de la base ─────────────────────────────────────────────────────

describe('mapeo (whatsapp_anuncio_destino)', () => {
    it('la tabla todavía no existe (42P01 / PGRST205) o falla: sin mapeo, nunca rompe', async () => {
        for (const error of [
            { code: 'PGRST205', message: "Could not find the table 'public.whatsapp_anuncio_destino' in the schema cache" },
            { code: '42P01', message: 'relation "public.whatsapp_anuncio_destino" does not exist' },
            { code: 'XX000', message: 'otra cosa' },
        ]) {
            h.resultado = { data: null, error };
            expect(await mapeoDeAnuncio('school-1', 'ad-1')).toBeNull();
        }
    });

    it('con fila: el destino; un destino inválido no cuenta', async () => {
        h.resultado = { data: [{ destino: 'servicio', servicio_id: 'srv-1' }], error: null };
        expect(await mapeoDeAnuncio('school-1', 'ad-1')).toEqual({ destino: 'servicio', servicioId: 'srv-1' });
        expect(mapeoDesdeFila({ destino: 'raro' })).toBeNull();
        expect(mapeoDesdeFila({ destino: 'persona', servicio_id: null })).toEqual({ destino: 'persona', servicioId: null });
        expect(await mapeoDeAnuncio('school-1', null)).toBeNull();
    });
});

describe('el lead del anuncio', () => {
    it('servicio de interés (el último manda) y anuncio por PRIMER toque (no se pisa)', () => {
        const ahora = '2026-11-04T15:00:00.000Z';
        const p = { servicio: { id: 's1', nombre: 'Clínica', tipo: 'clase_extra' }, anuncio: { source_id: 'ad-2' } };
        expect(detalleDeAnuncio(p, null, ahora)).toEqual({
            servicio_interes: { id: 's1', nombre: 'Clínica', tipo: 'clase_extra', at: ahora },
            anuncio: { source_id: 'ad-2', at: ahora },
        });
        expect(detalleDeAnuncio(p, { anuncio: { source_id: 'ad-1' } }, ahora)).not.toHaveProperty('anuncio');
        expect(detalleDeAnuncio({}, null, ahora)).toEqual({});
    });
});
