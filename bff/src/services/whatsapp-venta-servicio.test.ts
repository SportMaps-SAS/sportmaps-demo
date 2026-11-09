/**
 * El bot en MODO VENTA de un servicio (frente A, plan
 * docs/specs/whatsapp-ventas-de-servicio-blindaje.md). Sin base y sin Meta: el
 * contexto es un doble.
 *
 * Los seis casos de la Clínica de Armadores y Atacantes de Monster (3–8 nov 2026,
 * ~130 interesados → 1 venta) son pruebas con el nombre del caso: nada de menú de
 * sedes, ni clase de prueba, ni «9 de noviembre», ni silencio ante una duda.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    atenderVentaDeServicio, intencionEnVenta, textoDePagoDeServicio, textoSeguimientoDeVenta, ventaDeFamilia,
    temaDeCuentaDeFamilia, diaConSemana, textoDelTramo, lineaDeSaludoDeVenta, fichaDeVentaEnviada, ventaEnCurso,
    pideDatosDePago, deLaDelServicio, enElServicio, posibleVentaEnRecientes,
    PASO_VENTA, TEXTO_A_LA_ESCUELA, TEXTO_A_LA_ESCUELA_REPETIDO, TEXTO_OTRA_FECHA, TEXTO_YA_PAGO,
    TEXTO_COMPROBANTE_YA_RECIBIDO, TEXTO_CUPO_CON_PAGO, SIN_CUENTAS_DE_PAGO,
    atenderBotonDelClubEnVenta, textoBotonDelClubEnVenta, textoClubAparteDeLaVenta, datosDeAsistenteEnVenta,
    type CtxVentaServicio, type IntencionVenta,
} from './whatsapp-venta-servicio';
import { MARCA_VENTA, ventaActiva, type VentaActiva } from './whatsapp-venta-contexto';
import { precioDelServicio, servicioVigente, type ItemConFicha } from './whatsapp-anuncio-destino';
import type { PreguntaDeServicio, RespuestaDeServicio } from './whatsapp-servicio-ia';
import type { CuentaDePagoEmbudo } from './whatsapp-embudo-prospecto';
import type { FilaReciente } from './whatsapp-reglas-turno';
import { pareceVentaDeServicio, runSeguimientoProspectos20h } from './whatsapp-prospecto-seguimiento.service';

// ─── Datos: la clínica tal como está en la base (precios en texto, como los da PostgREST) ──

const CLINICA: ItemConFicha = {
    id: '16766d2e-f8b0-4285-88e3-b1e67dda6d45', name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: '300000.00' as any, active: true, event_id: null,
    starts_at: '2026-11-21 00:00:00-05', ends_at: '2026-11-22 23:59:00-05',
    allow_installments: true, precio_afiliado: '250000' as any, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    abono_minimo_pct: 50, opciones: null,
    description: '🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES MONSTER’S VOLLEY! 🔥 Este 21 y 22 de noviembre…',
};
const TORNEO: ItemConFicha = {
    id: '22222222-3333-4444-5555-666666666666', name: 'Torneo Relámpago Sub-14', kind: 'torneo', price: 80000,
    active: true, event_id: null, starts_at: null, ends_at: null,
};
const CUENTAS: CuentaDePagoEmbudo[] = [
    { tipo: 'Nequi', numero: '3194505150', titular: 'Iván Sossa' },
    { tipo: 'Daviplata', numero: '3194505150', titular: 'Iván Sossa' },
];

// Domingo 8-nov-2026, 1:00 p. m. en Bogotá.
const AHORA = new Date('2026-11-08T18:00:00Z');
const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000).toISOString();
const ent = (min: number, texto: string, extra: Partial<FilaReciente> = {}): FilaReciente =>
    ({ direction: 'inbound', type: 'text', text_body: texto, created_at: hace(min), wa_timestamp: hace(min), ...extra });
const sal = (min: number, texto: string, extra: Partial<FilaReciente> = {}): FilaReciente =>
    ({ direction: 'outbound', type: 'text', text_body: texto, created_at: hace(min), wa_timestamp: hace(min), ai_generated: true, ...extra });

const FICHA_DE_LA_ESCUELA = '🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES MONSTER’S VOLLEY! 🔥 ¿Quieres llevar tu juego al siguiente nivel? Esta es una oportunidad para aprender de referentes del voleibol.';
const VENTA: VentaActiva = { item: CLINICA, origen: 'marca', desde: hace(60) };

const SALIDA_PROHIBIDA = /elige la sede|sede que te queda|clase de prueba|5 preguntas|9 de noviembre|\$15\.000/i;

interface Registro {
    enviados: { texto: string; contexto: Record<string, unknown> }[];
    avisos: string[];
    esperados: any[];
    leads: any[];
    preguntas: PreguntaDeServicio[];
}

function ctxDe(o: {
    recientes?: FilaReciente[]; afiliado?: boolean; cuentas?: CuentaDePagoEmbudo[];
    ia?: RespuestaDeServicio; enCola?: boolean; ahora?: Date;
} = {}): { ctx: CtxVentaServicio; reg: Registro } {
    const reg: Registro = { enviados: [], avisos: [], esperados: [], leads: [], preguntas: [] };
    const ctx: CtxVentaServicio = {
        schoolId: 'school-monster', conversationId: 'conv-1', recientes: o.recientes ?? [],
        afiliado: async () => o.afiliado ?? false,
        cuentas: async () => o.cuentas ?? CUENTAS,
        guardarLead: async (s) => { reg.leads.push(s); return 'lead-1'; },
        registrarEsperado: async (e) => { reg.esperados.push(e); return true; },
        responderPregunta: async (p) => { reg.preguntas.push(p); return o.ia ?? { tipo: 'no_se', motivo: 'sin_dato' }; },
        enviar: async (texto, contexto) => { reg.enviados.push({ texto, contexto }); },
        avisarEscuela: async (d) => { reg.avisos.push(d); },
        comprobanteEnCurso: async () => o.enCola ?? false,
        ahora: () => o.ahora ?? AHORA,
    };
    return { ctx, reg };
}

const sinProhibidas = (reg: Registro) => {
    for (const e of reg.enviados) {
        expect(e.texto).not.toMatch(SALIDA_PROHIBIDA);
        expect(e.contexto[MARCA_VENTA]).toBe(CLINICA.id);
    }
};

// ─── Intención (pura) ───────────────────────────────────────────────────────

describe('intencionEnVenta', () => {
    const casos: Record<IntencionVenta, string[]> = {
        pago: [
            '¿Cuánto cuesta la clínica? ¿Cómo aparto mi cupo?', 'Si me interesa reservar',
            'Me confima los datos del titular de la cuenta y la cc', '¿por llave?', 'Sí', 'sí me interesa', 'Siii',
            'quiero inscribirme', 'Valor?', 'cuál es el número de cuenta', 'Nequi?', 'quiero reservar', 'Dale',
            'a nombre de quién está la cuenta', 'como pago', 'se puede pagar por cuotas?',
        ],
        ya_pago: [
            'ya pagué', 'Ya consigné', 'te envío el comprobante', 'Hola esa también ya la pagué', 'aquí está el comprobante',
            'Me gustaría saber qué trayectoria llevar teniendo en cuenta que acabo de pagar la clínica', 'Esa ya está acabada de pagar',
        ],
        otra_fecha: ['ese día tenemos torneo, ¿hay otra fecha?', 'no puedo ese día', 'habrá otra fecha?', 'se me cruza con un partido'],
        saludo: ['Hola', 'Ok', '.', 'Buenas', '👍', 'Buenas tardes', 'holaaa', 'Buenas, tengo una pregunta', '?'],
        cierre: ['Gracias', 'Okey muchas gracias quedo atento', 'Quedo atento', 'listo', 'Perfecto, gracias', '🙏', 'Sí gracias'],
        detalle: [
            'Solo una confirmacion antes de pagar incluye grupo femenino ??', '¿Con el pago ya tengo el cupo?', 'mi hija tiene 12',
            'Como asi disculpa', '¿A qué hora es?', '¿el precio incluye almuerzo?', 'Requiero algún otro dato o algo adicional?',
            'Pero no afecta eso en nada a la inscripción a la clínica sin', '¿Cuánto dura cada jornada?',
        ],
        club: ['Es posible agendar una clase de prueba?', 'cuánto vale la mensualidad', 'quiero inscribirla en el club'],
    };
    for (const [intencion, textos] of Object.entries(casos)) {
        it.each(textos)(`«%s» → ${intencion}`, (t) => expect(intencionEnVenta(t)).toBe(intencion));
    }
    it('pideDatosDePago = intención pago', () => {
        expect(pideDatosDePago('¿Cuánto cuesta la clínica? ¿Cómo aparto mi cupo?')).toBe(true);
        expect(pideDatosDePago('Hola, quiero más información')).toBe(false);
    });
});

// ─── El mensaje de pago (puro, reloj fijo) ──────────────────────────────────

describe('textoDePagoDeServicio', () => {
    it('«10 de noviembre» con día de la semana; el tramo del mes siguiente nombra el mes', () => {
        expect(diaConSemana('2026-11-11', 1)).toBe('martes 10 de noviembre');
        expect(textoDelTramo({ desde: '2026-11-11', precio: 350000 })).toBe('hasta el martes 10 de noviembre; desde el 11, *$350.000*');
        expect(textoDelTramo({ desde: '2026-12-01', precio: 400000 })).toBe('hasta el lunes 30 de noviembre; desde el 1 de diciembre, *$400.000*');
    });

    it('el 10-nov (último día de preventa): $300.000 hasta el martes 10; desde el 11, $350.000; abono, cuenta con titular y cierre', () => {
        const t = textoDePagoDeServicio(CLINICA, null, CUENTAS, { hoy: '2026-11-10' });
        expect(t).toBe([
            'Para separar tu cupo en la Clínica de armadores y atacantes:',
            'Valor hoy: *$300.000* (hasta el martes 10 de noviembre; desde el 11, *$350.000*).\n' +
                'Puedes separar el cupo con un abono mínimo de *$150.000* (50 %).',
            'Transfiere por Nequi o Daviplata al 319 450 5150, a nombre de Iván Sossa.',
            'Envía aquí la foto del comprobante con el nombre completo de quien asiste y te confirmamos el cupo.',
        ].join('\n\n'));
        expect(t).not.toMatch(/9 de noviembre|undefined|null|NaN|gratis/);
    });

    it('el 11-nov ya es $350.000 (sin tramo siguiente) y el abono es la mitad de eso', () => {
        const t = textoDePagoDeServicio(CLINICA, null, CUENTAS, { hoy: '2026-11-11' });
        expect(t).toContain('Valor hoy: *$350.000*.');
        expect(t).not.toContain('$300.000');
        expect(t).toContain('abono mínimo de *$175.000*');
    });

    it('afiliado: $250.000 sin importar la fecha (y su abono)', () => {
        for (const hoy of ['2026-11-08', '2026-11-15']) {
            const t = textoDePagoDeServicio(CLINICA, null, CUENTAS, { afiliado: true, hoy });
            expect(t).toContain('Tu valor como afiliado del club: *$250.000*.');
            expect(t).toContain('abono mínimo de *$125.000*');
            expect(t).not.toMatch(/\$300\.000|\$350\.000/);
        }
    });

    it('sin cuentas: la escuela le escribe con los datos; con varias cuentas distintas, la lista', () => {
        const sin = textoDePagoDeServicio(CLINICA, null, [], { hoy: '2026-11-08' });
        expect(sin).toContain(SIN_CUENTAS_DE_PAGO);
        expect(sin).toContain('Cuando pagues, envía aquí la foto del comprobante con el nombre completo de quien asiste');
        const varias = textoDePagoDeServicio(CLINICA, null, [
            { tipo: 'Nequi', numero: '3194505150', titular: 'Iván Sossa' },
            { tipo: 'Bancolombia ahorros', numero: '123-456789-01', titular: 'Monster Volley SAS' },
        ], { hoy: '2026-11-08' });
        expect(varias).toContain('Transfiere a una de estas cuentas:\n• Nequi: 319 450 5150 (a nombre de Iván Sossa)\n• Bancolombia ahorros: 123-456789-01 (a nombre de Monster Volley SAS)');
    });

    it('cualquier servicio: el artículo sale del nombre («en el Torneo…»); sin negrita: «*nombre*» es el título de la ficha', () => {
        expect(enElServicio(TORNEO)).toBe('en el Torneo Relámpago Sub-14');
        expect(enElServicio(TORNEO, { negrita: true })).toBe('en el *Torneo Relámpago Sub-14*');
        expect(deLaDelServicio(CLINICA)).toBe('de la Clínica de armadores y atacantes');
        expect(deLaDelServicio(CLINICA, { negrita: true })).toBe('de la *Clínica de armadores y atacantes*');
        expect(deLaDelServicio({ name: 'Copa Relámpago' })).toBe('de la Copa Relámpago');
        expect(deLaDelServicio({ name: 'Monster Camp' })).toBe('de Monster Camp');
        expect(textoDePagoDeServicio(TORNEO, null, CUENTAS, { hoy: '2026-11-08' })).toContain('Valor hoy: *$80.000*.');
    });
});

// ─── Los seis casos reales (Monster, 3–8 nov) ───────────────────────────────

describe('caso 1: «Hola», «Ok», «.» y «ese día tenemos torneo» a mitad de la venta', () => {
    it('«Hola» → UNA línea del servicio, nunca el menú de sedes ni la clase de prueba', async () => {
        const { ctx, reg } = ctxDe({ recientes: [ent(1, 'Hola'), sal(60, 'ficha', { payload: { [MARCA_VENTA]: CLINICA.id } })] });
        expect(await atenderVentaDeServicio(ctx, VENTA, 'Hola')).toBe('venta_saludo');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toBe(lineaDeSaludoDeVenta(CLINICA));
        expect(reg.enviados[0].texto).toBe('¿Te ayudo con algo de la Clínica de armadores y atacantes? Si quieres separar tu cupo, te paso los datos.');
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.SALUDO });
        sinProhibidas(reg);
    });

    it('«Ok» y «.» justo después: no se repite la línea (30 min) ni hay bucle', async () => {
        const recientes = [ent(1, 'Ok'), sal(5, lineaDeSaludoDeVenta(CLINICA), { payload: { step: PASO_VENTA.SALUDO, [MARCA_VENTA]: CLINICA.id } })];
        for (const t of ['Ok', '.']) {
            const { ctx, reg } = ctxDe({ recientes });
            expect(await atenderVentaDeServicio(ctx, VENTA, t)).toBe('venta_silencio');
            expect(reg.enviados).toEqual([]);
        }
        // 40 min después sí puede volver a salir.
        const viejo = [sal(40, lineaDeSaludoDeVenta(CLINICA), { payload: { step: PASO_VENTA.SALUDO } })];
        const { ctx, reg } = ctxDe({ recientes: viejo });
        expect(await atenderVentaDeServicio(ctx, VENTA, '.')).toBe('venta_saludo');
        expect(reg.enviados).toHaveLength(1);
    });

    it('«ese día tenemos torneo, ¿hay otra fecha?» → acuse y la escuela recibe la pregunta (pendiente)', async () => {
        const { ctx, reg } = ctxDe();
        const t = 'ese día tenemos torneo, ¿hay otra fecha?';
        expect(await atenderVentaDeServicio(ctx, VENTA, t)).toBe('venta_otra_fecha');
        expect(reg.enviados).toEqual([{ texto: TEXTO_OTRA_FECHA, contexto: expect.objectContaining({ step: PASO_VENTA.OTRA_FECHA, pendiente_escuela: t }) }]);
        expect(reg.avisos[0]).toContain('otra fecha');
        expect(reg.avisos[0]).toContain(t);
        sinProhibidas(reg);
    });
});

describe('caso 2: Nicolás pagó la clínica; tras «No encontré» escribió «Como así disculpa»', () => {
    const recientes = [
        ent(1, 'Como asi disculpa'),
        sal(2, 'Gracias 🙏 No encontré a ese deportista, así que le paso tu comprobante a la escuela para que lo aplique.',
            { payload: { step: 'deportista_a_la_escuela' } }),
        ent(3, 'Nicolás Cubides Ávila\n18 de Diciembre del 2006\nOpuesto'),
        ent(4, '', { type: 'image' }),
        sal(4 * 24 * 60, FICHA_DE_LA_ESCUELA, { ai_generated: false, payload: { automatico: 'true' } }),
    ];

    it('la venta se sostiene con la ficha pegada a mano por la escuela 4 días antes', () => {
        expect(ventaActiva(recientes, [CLINICA], { ahora: AHORA.getTime() })?.item.id).toBe(CLINICA.id);
    });

    it('«Como así disculpa» NO arranca el embudo: se queda en la venta y la escuela recibe la duda', async () => {
        const { ctx, reg } = ctxDe({ recientes });
        expect(await atenderVentaDeServicio(ctx, VENTA, 'Como asi disculpa')).toBe('venta_a_la_escuela');
        expect(reg.enviados[0].texto).toBe(TEXTO_A_LA_ESCUELA);
        expect(reg.enviados[0].contexto).toMatchObject({ pendiente_escuela: 'Como asi disculpa' });
        expect(reg.avisos).toHaveLength(1);
        sinProhibidas(reg);
    });

    it('«acabo de pagar la clínica» con el comprobante ya recibido → «ya tenemos tu comprobante», sin cobrar nada más', async () => {
        const { ctx, reg } = ctxDe({ recientes });
        const t = 'Me gustaría saber qué trayectoria llevar teniendo en cuenta que acabo de pagar la clínica';
        expect(await atenderVentaDeServicio(ctx, VENTA, t)).toBe('venta_ya_pago');
        expect(reg.enviados[0].texto).toBe(TEXTO_COMPROBANTE_YA_RECIBIDO);
        expect(reg.esperados).toEqual([]);
        sinProhibidas(reg);
    });

    it('con un comprobante en la cola, «Hola» o «ya pagué» los contesta la cola (una sola respuesta)', async () => {
        for (const t of ['Hola', 'ya pagué', 'gracias']) {
            const { ctx, reg } = ctxDe({ recientes, enCola: true });
            expect(await atenderVentaDeServicio(ctx, VENTA, t)).toBe('venta_silencio');
            expect(reg.enviados).toEqual([]);
        }
    });

    it('«ya pagué» sin comprobante todavía → «envíalo aquí con el nombre completo de quien asiste»', async () => {
        const { ctx, reg } = ctxDe({ recientes: [ent(1, 'ya pagué')] });
        expect(await atenderVentaDeServicio(ctx, VENTA, 'ya pagué')).toBe('venta_ya_pago');
        expect(reg.enviados[0].texto).toBe(TEXTO_YA_PAGO);
        expect(reg.enviados[0].texto).toContain('nombre completo de quien asiste');
    });
});

describe('caso 3: el seguimiento de 20 h de un interesado de la clínica', () => {
    it('determinista, con la fecha correcta del tramo; sin IA, sin clase de prueba, sin «9 de noviembre»', () => {
        const t = textoSeguimientoDeVenta(CLINICA, { recientes: [], afiliado: false, hoy: '2026-11-08', ahora: AHORA.getTime() })!;
        expect(t).toContain('¿Pudiste revisar la información de la Clínica de armadores y atacantes?');
        expect(t).toContain('El valor hoy es *$300.000* hasta el martes 10 de noviembre; desde el 11, *$350.000*.');
        expect(t).toContain('te paso los datos de pago');
        expect(t).not.toMatch(SALIDA_PROHIBIDA);
    });

    it('si ya recibió los datos de pago, recuerda el comprobante; si ya lo mandó, no hay seguimiento', () => {
        const conDatos = [sal(20 * 60, 'Para separar tu cupo…', { payload: { step: PASO_VENTA.PAGO, [MARCA_VENTA]: CLINICA.id } })];
        expect(textoSeguimientoDeVenta(CLINICA, { recientes: conDatos, afiliado: false, hoy: '2026-11-08', ahora: AHORA.getTime() }))
            .toContain('¿Pudiste hacer el pago de la Clínica de armadores y atacantes?');
        const conComprobante = [...conDatos, ent(19 * 60, '', { type: 'image' })];
        expect(textoSeguimientoDeVenta(CLINICA, { recientes: conComprobante, afiliado: false, hoy: '2026-11-08', ahora: AHORA.getTime() })).toBeNull();
    });

    it('afiliado: su valor, sin tramos', () => {
        const t = textoSeguimientoDeVenta(CLINICA, { recientes: [], afiliado: true, hoy: '2026-11-08', ahora: AHORA.getTime() })!;
        expect(t).toContain('Tu valor como afiliado es *$250.000*.');
        expect(t).not.toContain('$350.000');
    });

    it('el job: con venta, sale el texto del servicio con la marca y NO se llama al modelo; una vez (marca del lead)', async () => {
        const enviados: { texto: string; extra?: Record<string, unknown> }[] = [];
        const redactar = vi.fn(async () => '¿O prefieres agendar tu clase de prueba ($15.000)?');
        const conv = { id: 'c1', integrationId: 'i1', contactWaId: '573001112233', lastInboundAt: new Date(AHORA.getTime() - 20 * 3600_000).toISOString() };
        const lead = { id: 'l1', schoolId: 's1', conversationId: 'c1', sourceDetail: { conversation_id: 'c1', servicio_interes: { id: CLINICA.id } } };
        const texto = textoSeguimientoDeVenta(CLINICA, { recientes: [], afiliado: false, hoy: '2026-11-08', ahora: AHORA.getTime() });
        const reclamar = vi.fn(async () => true);
        const r = await runSeguimientoProspectos20h({
            ahora: AHORA,
            deps: {
                candidatos: async () => [lead], conversacion: async () => conv,
                recientes: async () => [ent(20 * 60, '¿Cuánto cuesta la clínica?'), sal(20 * 60 - 1, 'ficha', { payload: { [MARCA_VENTA]: CLINICA.id } })],
                puedeHablar: async () => true, integracion: async () => ({ id: 'i1', school_id: 's1' } as any),
                reclamar, soltar: async () => undefined, redactar,
                enviar: async (_i, _c, _w, t, extra) => { enviados.push({ texto: t, extra }); },
                ventaDelLead: async () => ({ itemId: CLINICA.id, texto }),
            },
        });
        expect(r).toMatchObject({ enviados: 1, fallidos: 0 });
        expect(redactar).not.toHaveBeenCalled();
        expect(reclamar).toHaveBeenCalledTimes(1);
        expect(enviados).toEqual([{ texto, extra: { [MARCA_VENTA]: CLINICA.id, seguimiento_de_venta: true } }]);
        expect(enviados[0].texto).not.toMatch(SALIDA_PROHIBIDA);
    });

    it('el filtro gratis: sin señal de venta ni servicio en el lead, ni se lee el catálogo', () => {
        const sinVenta = [ent(60, 'Es únicamente ir y ya?'), sal(59, '¡Claro! Solo llegas…')];
        expect(pareceVentaDeServicio({ sourceDetail: {} }, sinVenta)).toBe(false);
        expect(pareceVentaDeServicio({ sourceDetail: { servicio_interes: { id: CLINICA.id } } }, sinVenta)).toBe(true);
        expect(pareceVentaDeServicio({ sourceDetail: {} }, [ent(60, 'info de la clínica')])).toBe(true);
        expect(pareceVentaDeServicio({ sourceDetail: {} }, [sal(60, 'x', { payload: { [MARCA_VENTA]: CLINICA.id } })])).toBe(true);
    });
});

describe('caso 4: «¿Cuánto cuesta la clínica? ¿Cómo aparto mi cupo?» → el valor en un mensaje aparte, corto', () => {
    it('pago: precio de hoy, tramo, abono, cuenta con titular y cierre; lead, esperado B4 hasta el fin del servicio', async () => {
        const { ctx, reg } = ctxDe({ recientes: [sal(5, 'ficha', { payload: { [MARCA_VENTA]: CLINICA.id } })] });
        expect(await atenderVentaDeServicio(ctx, VENTA, '¿Cuánto cuesta la clínica? ¿Cómo aparto mi cupo?')).toBe('venta_pago');
        expect(reg.enviados).toHaveLength(1);
        const { texto, contexto } = reg.enviados[0];
        expect(texto.length).toBeLessThan(600);
        expect(texto).toBe(textoDePagoDeServicio(CLINICA, null, CUENTAS, { hoy: '2026-11-08' }));
        expect(contexto).toMatchObject({
            [MARCA_VENTA]: CLINICA.id, step: PASO_VENTA.PAGO, datos_de_pago: true, precio_hoy: 300000, abono: 150000,
            motivo_esperado: { motivo: 'clase_extra', monto: null, registrado: true }, repetible: true,
        });
        expect(reg.leads).toEqual([{ id: CLINICA.id, nombre: CLINICA.name, tipo: 'clase_extra' }]);
        expect(reg.esperados).toEqual([{ motivo: 'clase_extra', leadId: 'lead-1', venceEn: CLINICA.ends_at }]);
        expect(reg.avisos).toEqual([]);
        sinProhibidas(reg);
    });

    it('afiliado → $250.000', async () => {
        const { ctx, reg } = ctxDe({ afiliado: true });
        await atenderVentaDeServicio(ctx, VENTA, '¿cuánto vale?');
        expect(reg.enviados[0].texto).toContain('Tu valor como afiliado del club: *$250.000*.');
        expect(reg.enviados[0].contexto).toMatchObject({ precio_hoy: 250000, afiliado: true });
    });

    it('tramo con reloj fijo: el 10-nov preventa ($300.000), el 11-nov $350.000', async () => {
        const a = ctxDe({ ahora: new Date('2026-11-10T22:00:00Z') });
        await atenderVentaDeServicio(a.ctx, VENTA, 'precio?');
        expect(a.reg.enviados[0].texto).toContain('Valor hoy: *$300.000* (hasta el martes 10 de noviembre; desde el 11, *$350.000*).');
        // 11-nov 00:30 en Bogotá (05:30 UTC): ya es el tramo nuevo.
        const b = ctxDe({ ahora: new Date('2026-11-11T05:30:00Z') });
        await atenderVentaDeServicio(b.ctx, VENTA, 'precio?');
        expect(b.reg.enviados[0].texto).toContain('Valor hoy: *$350.000*.');
        expect(b.reg.enviados[0].contexto).toMatchObject({ precio_hoy: 350000 });
    });

    it('sin cuentas cargadas: la escuela le escribe con los datos y recibe el aviso', async () => {
        const { ctx, reg } = ctxDe({ cuentas: [] });
        expect(await atenderVentaDeServicio(ctx, VENTA, 'cómo pago?')).toBe('venta_pago');
        expect(reg.enviados[0].texto).toContain(SIN_CUENTAS_DE_PAGO);
        expect(reg.enviados[0].contexto).toMatchObject({ sin_cuentas: true, datos_de_pago: false });
        expect(reg.avisos[0]).toContain('no tiene cuentas de pago cargadas');
    });

    it('servicio sin precio: no se inventa un valor; la escuela lo confirma', async () => {
        const sinPrecio = { ...CLINICA, price: null, precio_afiliado: null, precios_por_fecha: null };
        const { ctx, reg } = ctxDe();
        expect(await atenderVentaDeServicio(ctx, { ...VENTA, item: sinPrecio }, 'cuánto cuesta')).toBe('venta_sin_precio');
        expect(reg.enviados[0].texto).not.toMatch(/\$\d/);
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.SIN_PRECIO });
        expect(reg.avisos).toHaveLength(1);
        expect(reg.esperados).toEqual([]);
    });
});

describe('caso 5: el «Sí» de la campaña ya pide cómo reservar', () => {
    it('la respuesta al «Sí» (texto de la escuela con la marca) abre la venta y lo que sigue lo atiende la venta', async () => {
        const recientes = [
            ent(1, 'Ok'),
            sal(2, FICHA_DE_LA_ESCUELA + ' Responde este mensaje y te enviamos los datos de pago.',
                { ai_generated: false, payload: { step: 'campana_respuesta_si', campana_id: 'camp-1', automatico: 'true', [MARCA_VENTA]: CLINICA.id } }),
            ent(3, 'Sí, envíame la info', { type: 'button' }),
        ];
        const v = ventaActiva(recientes, [CLINICA], { ahora: AHORA.getTime() });
        expect(v).toMatchObject({ item: { id: CLINICA.id }, origen: 'marca' });
        expect(fichaDeVentaEnviada(recientes, CLINICA, AHORA.getTime())).toBe(true);
        const { ctx, reg } = ctxDe({ recientes });
        expect(await atenderVentaDeServicio(ctx, v!, 'Ok')).toBe('venta_saludo');
        sinProhibidas(reg);
    });
});

describe('caso 6: conversación 932fcd83 — dos dudas seguidas tras los datos de pago no recibieron NADA', () => {
    // Causa (2026-11-07): «Si me interesa reservar» lo contestó `responderAlSeguimiento` (lo último era
    // la respuesta de la campaña); el saliente quedó como `prospecto_ia`. Las dos preguntas siguientes ya
    // no contestaban la campaña, no nombraban la clínica, la conversación no tenía marca de embudo ni de
    // anuncio y el texto no era «tema escolar» → `!tema && !prospecto` → silencio, y el acuse del embudo
    // exige haber pasado por el embudo. Con la venta activa, cada duda tiene respuesta.
    const recientes = [
        ent(1, 'Solo una confirmacion antes de pagar incluye grupo femenino ??'),
        sal(2, 'Para separar tu cupo en la clínica, paga *$150.000* (el 50 % de la preventa) por Nequi o Daviplata…',
            { payload: { step: 'prospecto_ia' } }),
        ent(3, 'Si me interesa reservar'),
        sal(5, FICHA_DE_LA_ESCUELA, { ai_generated: false, payload: { step: 'campana_respuesta_si', campana_id: 'camp-1', automatico: 'true' } }),
    ];

    it('la venta se reconoce aunque el último saliente del bot no tenga marca', () => {
        expect(ventaActiva(recientes, [CLINICA], { ahora: AHORA.getTime() })?.origen).toBe('texto_saliente');
    });

    it('«…incluye grupo femenino ??» → la IA del servicio con el ítem, la pregunta, cuentas y fecha', async () => {
        const { ctx, reg } = ctxDe({ recientes, ia: { tipo: 'respuesta', texto: 'Sí 🙌 la clínica es para hombres y mujeres.' } });
        expect(await atenderVentaDeServicio(ctx, VENTA, 'Solo una confirmacion antes de pagar incluye grupo femenino ??')).toBe('venta_respuesta');
        expect(reg.preguntas[0]).toMatchObject({
            schoolId: 'school-monster', conversationId: 'conv-1', item: CLINICA, hoy: '2026-11-08', afiliado: false,
            pregunta: 'Solo una confirmacion antes de pagar incluye grupo femenino ??', cuentas: CUENTAS,
        });
        expect(reg.enviados).toEqual([{ texto: 'Sí 🙌 la clínica es para hombres y mujeres.', contexto: expect.objectContaining({ step: PASO_VENTA.RESPUESTA }) }]);
        sinProhibidas(reg);
    });

    it('si la IA no lo tiene en los datos: «te lo confirma la escuela», buzón con la pregunta PENDIENTE (nunca silencio)', async () => {
        const { ctx, reg } = ctxDe({ recientes });
        expect(await atenderVentaDeServicio(ctx, VENTA, 'Solo una confirmacion antes de pagar incluye grupo femenino ??')).toBe('venta_a_la_escuela');
        expect(reg.enviados[0].texto).toBe(TEXTO_A_LA_ESCUELA);
        // El motivo del «no sé» de la IA del servicio queda en el payload (auditable) junto a la pregunta pendiente.
        expect(reg.enviados[0].contexto).toMatchObject({
            pendiente_escuela: 'Solo una confirmacion antes de pagar incluye grupo femenino ??', servicio_ia_motivo: 'sin_dato',
        });
        expect(reg.avisos[0]).toContain('incluye grupo femenino');
        // Una segunda pregunta sin dato en los 30 min: otro texto (no se repite), también pendiente.
        const segunda = ctxDe({ recientes: [sal(1, TEXTO_A_LA_ESCUELA, { payload: { step: PASO_VENTA.A_LA_ESCUELA } }), ...recientes] });
        await atenderVentaDeServicio(segunda.ctx, VENTA, '¿y llevan hidratación?');
        expect(segunda.reg.enviados[0].texto).toBe(TEXTO_A_LA_ESCUELA_REPETIDO);
    });

    it('«Me confima los datos del titular de la cuenta y la cc» → los datos con el titular; la cédula queda pendiente para la escuela', async () => {
        const { ctx, reg } = ctxDe({ recientes });
        expect(await atenderVentaDeServicio(ctx, VENTA, 'Me confima los datos del titular de la cuenta y la cc')).toBe('venta_pago');
        const { texto, contexto } = reg.enviados[0];
        expect(texto).toContain('Nequi o Daviplata al 319 450 5150, a nombre de Iván Sossa');
        expect(texto).toContain('El documento del titular de la cuenta te lo confirma la escuela por aquí.');
        expect(contexto).toMatchObject({ pendiente_escuela: 'Me confima los datos del titular de la cuenta y la cc' });
        expect(reg.avisos[0]).toContain('documento del titular');
    });

    it('«¿Con el pago ya tengo el cupo?» sin dato de la IA: así funciona (la escuela valida el comprobante)', async () => {
        const { ctx, reg } = ctxDe({ recientes });
        expect(await atenderVentaDeServicio(ctx, VENTA, '¿Con el pago ya tengo el cupo?')).toBe('venta_respuesta');
        expect(reg.enviados[0].texto).toBe(TEXTO_CUPO_CON_PAGO);
        expect(reg.avisos).toEqual([]);
    });
});

// ─── Bordes ─────────────────────────────────────────────────────────────────

describe('bordes de la venta', () => {
    it('venta + «Es posible agendar una clase de prueba?» → sale de la venta (null, no envía nada)', async () => {
        const { ctx, reg } = ctxDe();
        expect(await atenderVentaDeServicio(ctx, VENTA, 'Es posible agendar una clase de prueba?')).toBeNull();
        expect(reg.enviados).toEqual([]);
        // Y la venta se cierra si el pedido del club es posterior a la última señal.
        const m = [ent(1, 'Es posible agendar una clase de prueba para la Sede Norte?'), sal(30, 'ficha', { payload: { [MARCA_VENTA]: CLINICA.id } })];
        expect(ventaActiva(m, [CLINICA], { ahora: AHORA.getTime() })).toBeNull();
    });

    it('cierre de cortesía («gracias», «quedo atento») → silencio', async () => {
        for (const t of ['Gracias', 'Okey muchas gracias quedo atento']) {
            const { ctx, reg } = ctxDe();
            expect(await atenderVentaDeServicio(ctx, VENTA, t)).toBe('venta_silencio');
            expect(reg.enviados).toEqual([]);
        }
    });

    it('servicio vencido → no hay venta', () => {
        const despues = new Date('2026-11-23T15:00:00Z').getTime();
        expect(servicioVigente(CLINICA, despues)).toBe(false);
        const m = [ent(1, 'Hola'), sal(60, 'ficha', { payload: { [MARCA_VENTA]: CLINICA.id } })]
            .map((f) => ({ ...f, created_at: new Date(despues - 60_000).toISOString(), wa_timestamp: null }));
        expect(ventaActiva(m, [CLINICA].filter((it) => servicioVigente(it, despues)), { ahora: despues })).toBeNull();
    });

    it('la IA falla (lanza): igual responde «te lo confirma la escuela»', async () => {
        const { ctx, reg } = ctxDe();
        ctx.responderPregunta = async () => { throw new Error('modelo caído'); };
        expect(await atenderVentaDeServicio(ctx, VENTA, '¿desde qué edad?')).toBe('venta_a_la_escuela');
        expect(reg.enviados[0].texto).toBe(TEXTO_A_LA_ESCUELA);
        expect(reg.enviados[0].contexto).toMatchObject({ servicio_ia_motivo: 'error' });
    });

    it('precioDelServicio con los precios en texto de PostgREST', () => {
        expect(precioDelServicio(CLINICA, { afiliado: false, hoy: '2026-11-08' })).toMatchObject({ hoy: 300000, abono: 150000, siguiente: { desde: '2026-11-11', precio: 350000 } });
    });
});

// ─── Familias del club (el afiliado que compra la clínica) ──────────────────

describe('ventaDeFamilia', () => {
    const campana = sal(10, FICHA_DE_LA_ESCUELA, { ai_generated: false, payload: { step: 'campana_respuesta_si', campana_id: 'c1', automatico: 'true' } });
    const ahora = AHORA.getTime();

    it('en la venta (lo último que salió es de ella): una duda sin nombrar la clínica es de la venta', () => {
        const r = [ent(1, '¿incluye grupo femenino?'), campana];
        expect(ventaEnCurso(r, CLINICA, ahora)).toBe(true);
        expect(ventaDeFamilia(r, [CLINICA], '¿incluye grupo femenino?', '¿incluye grupo femenino?', ahora)?.item.id).toBe(CLINICA.id);
    });

    it('su mensualidad, su saldo o «ya pagué» sin nombrar el servicio siguen como hoy', () => {
        const r = [ent(1, 'x'), campana];
        for (const t of ['¿cuánto debo de la mensualidad?', 'me pasan mi estado de cuenta', 'ya pagué']) {
            expect(ventaDeFamilia(r, [CLINICA], t, t, ahora)).toBeNull();
        }
        expect(temaDeCuentaDeFamilia('cuánto es el saldo')).toBe(true);
        expect(ventaDeFamilia(r, [CLINICA], 'ya pagué la clínica', 'ya pagué la clínica', ahora)?.item.id).toBe(CLINICA.id);
    });

    it('fuera de la venta (lo último fue otra cosa): solo si nombra el servicio', () => {
        const r = [ent(1, 'x'), sal(5, 'Tu saldo está al día ✅', { payload: { step: 'get_payment_status' } }), campana];
        expect(ventaEnCurso(r, CLINICA, ahora)).toBe(false);
        expect(ventaDeFamilia(r, [CLINICA], '¿a qué hora es el entreno?', '¿a qué hora es el entreno?', ahora)).toBeNull();
        expect(ventaDeFamilia(r, [CLINICA], '¿cuánto vale la clínica para afiliados?', '¿cuánto vale la clínica para afiliados?', ahora)?.item.id)
            .toBe(CLINICA.id);
    });

    it('sin servicios vigentes, nada', () => {
        expect(ventaDeFamilia([campana], [], 'hola', 'hola', ahora)).toBeNull();
    });

    it('filtro gratis antes de leer el catálogo (Disk IO): solo con señal de venta en 24 h o un evento nombrado', () => {
        const normal = [ent(2, '¿cuánto debo?'), sal(1, 'Tu saldo es $0 ✅', { payload: { step: 'get_payment_status' } })];
        expect(posibleVentaEnRecientes(normal, '¿a qué hora es el entreno?')).toBe(false);
        expect(posibleVentaEnRecientes(normal, '¿cuánto vale la clínica?')).toBe(true);
        expect(posibleVentaEnRecientes([campana], 'hola')).toBe(true);
        expect(posibleVentaEnRecientes([sal(1, 'x', { payload: { [MARCA_VENTA]: CLINICA.id } })], 'ok')).toBe(true);
    });
});

// ─── 2026-11-08 (tarde): botones viejos del club, el club aparte y los datos de quien asiste ──

describe('Nicolás (308de503, •••7726): botones viejos del club en plena venta', () => {
    it('el primer botón del club → UNA respuesta dentro de la venta (sin sedes, sin clase de prueba, sin $15.000)', async () => {
        const { ctx, reg } = ctxDe({ recientes: [sal(60, FICHA_DE_LA_ESCUELA, { ai_generated: false })] });
        expect(await atenderBotonDelClubEnVenta(ctx, VENTA)).toBe('venta_boton_club');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toBe(textoBotonDelClubEnVenta(CLINICA, { pagado: false }));
        expect(reg.enviados[0].texto).toContain('¿Te paso los datos para separar tu cupo?');
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.BOTON_CLUB, [MARCA_VENTA]: CLINICA.id });
        sinProhibidas(reg);
    });

    it('los toques siguientes (franja, «Hombre», «Sí, claro» del recordatorio) → silencio, sin repetir la respuesta', async () => {
        const yaRespondido = sal(2, textoBotonDelClubEnVenta(CLINICA, { pagado: false }), { payload: { step: PASO_VENTA.BOTON_CLUB, [MARCA_VENTA]: CLINICA.id } });
        const { ctx, reg } = ctxDe({ recientes: [yaRespondido] });
        for (let i = 0; i < 4; i++) expect(await atenderBotonDelClubEnVenta(ctx, VENTA)).toBe('venta_silencio');
        expect(reg.enviados).toHaveLength(0);
    });

    it('si ya mandó el comprobante, la respuesta lo dice (la escuela valida) y no ofrece el pago otra vez', async () => {
        const { ctx, reg } = ctxDe({ recientes: [ent(30, '', { type: 'image' })] });
        await atenderBotonDelClubEnVenta(ctx, VENTA);
        expect(reg.enviados[0].texto).toBe(textoBotonDelClubEnVenta(CLINICA, { pagado: true }));
        expect(reg.enviados[0].texto).toContain('la escuela valida tu comprobante');
        expect(reg.enviados[0].texto).not.toContain('¿Te paso los datos');
    });

    it('pedir el club por TEXTO en plena venta: va aparte del servicio y se dice cuánto cuesta ANTES de agendar', () => {
        expect(textoClubAparteDeLaVenta(CLINICA, { nombre: 'clase de prueba', precio: '$15.000', gratis: false }))
            .toBe('Claro 🙌 Lo del club va aparte de la Clínica de armadores y atacantes: para empezar se agenda una *clase de prueba*, que cuesta *$15.000*.');
        expect(textoClubAparteDeLaVenta(CLINICA, { nombre: 'clase de cortesía', precio: null, gratis: true })).toContain('que es gratis');
    });
});

describe('los datos de quien asiste en una venta («Nicolás Cubides Ávila / 18 de Diciembre del 2006 / Opuesto»)', () => {
    const DATOS = 'Nicolás Cubides Ávila\n18 de Diciembre del 2006\nOpuesto';

    it('se reconocen: nombre + fecha, año o posición', () => {
        expect(datosDeAsistenteEnVenta(DATOS)).toEqual({ nombre: 'Nicolás Cubides Ávila' });
        expect(datosDeAsistenteEnVenta('Laura Gómez Ruiz 2012')).toEqual({ nombre: 'Laura Gómez Ruiz' });
        expect(datosDeAsistenteEnVenta('Mariana Pérez, 15 años, armadora')).toEqual({ nombre: 'Mariana Pérez' });
        expect(datosDeAsistenteEnVenta('Nicolás cubides 18/12/2006')).toEqual({ nombre: 'Nicolás Cubides' });
    });

    it('falsos positivos que NO lo son: «Sede Suba», «Hombre», «Club y torneos», «Mucho gusto», preguntas', () => {
        for (const t of ['Sede Suba', '⚫ Sede Suba', 'Hombre', 'Club y torneos', 'Aún no tengo posición', 'Mucho gusto',
            'Requiero algún otro dato o algo adicional?', 'Esa ya está acabada de pagar', 'Okey muchas gracias quedo atento',
            'Como asi disculpa', 'Mixto Mayores Profundizacion', 'Buenas tardes', '18/12/2006', 'Opuesto']) {
            expect(datosDeAsistenteEnVenta(t), t).toBeNull();
        }
    });

    it('un nombre suelto cuenta SOLO si el bot acababa de pedir «el nombre completo de quien asiste»', () => {
        expect(datosDeAsistenteEnVenta('Nicolás cubides')).toBeNull();
        const pidio = sal(2, TEXTO_YA_PAGO);
        expect(datosDeAsistenteEnVenta('Nicolás cubides', [pidio])).toEqual({ nombre: 'Nicolás Cubides' });
        expect(datosDeAsistenteEnVenta('Mucho gusto', [pidio])).toBeNull();
    });

    it('sin pago todavía: «gracias, anoté a…» + el pago OFRECIDO con una pregunta (sin cuentas ni valores) y se anota', async () => {
        const anotados: string[] = [];
        const { ctx, reg } = ctxDe({ recientes: [sal(60, FICHA_DE_LA_ESCUELA, { ai_generated: false })] });
        ctx.anotarAsistente = async (nombre) => { anotados.push(nombre); };
        expect(await atenderVentaDeServicio(ctx, VENTA, DATOS)).toBe('venta_asistente');
        expect(anotados).toEqual(['Nicolás Cubides Ávila']);
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toBe('¡Gracias! 🙌 Anoté a *Nicolás Cubides Ávila* como asistente de la Clínica de armadores y atacantes. ¿Te paso los datos para separar el cupo?');
        expect(reg.enviados[0].texto).not.toMatch(/319|Nequi|\$/);
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.ASISTENTE, asistente: 'Nicolás Cubides Ávila' });
        expect(reg.avisos).toEqual([]);
        expect(reg.preguntas).toEqual([]); // ni la IA ni «te lo confirma la escuela»
        sinProhibidas(reg);
        // «Sí» → ahí sí, los datos de pago.
        const si = ctxDe({ recientes: [sal(1, reg.enviados[0].texto, { payload: reg.enviados[0].contexto })] });
        expect(await atenderVentaDeServicio(si.ctx, VENTA, 'Sí')).toBe('venta_pago');
    });

    it('con el comprobante ya enviado: se anota y se dice que la escuela valida (no se ofrece pagar otra vez)', async () => {
        const { ctx, reg } = ctxDe({ recientes: [ent(3, '', { type: 'image' })] });
        await atenderVentaDeServicio(ctx, VENTA, DATOS);
        expect(reg.enviados[0].texto).toBe('¡Gracias! 🙌 Anoté a *Nicolás Cubides Ávila* como asistente de la Clínica de armadores y atacantes. La escuela valida tu comprobante y te confirma el cupo por aquí.');
    });

    it('el mismo nombre otra vez en 30 min: no se repite', async () => {
        const previo = sal(5, 'Anoté…', { payload: { step: PASO_VENTA.ASISTENTE, asistente: 'Nicolás Cubides Ávila' } });
        const { ctx, reg } = ctxDe({ recientes: [previo] });
        expect(await atenderVentaDeServicio(ctx, VENTA, DATOS)).toBe('venta_silencio');
        expect(reg.enviados).toHaveLength(0);
    });
});
