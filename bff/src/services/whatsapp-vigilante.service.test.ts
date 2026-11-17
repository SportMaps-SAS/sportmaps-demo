/**
 * whatsapp-vigilante.service — el vigilante de confiabilidad del bot: las
 * decisiones puras (qué es un comprobante sin desenlace, qué es una pregunta,
 * qué es una afirmación), las cinco secciones, el correo, el texto para la
 * escuela y la corrida (deduplicación, una escuela que falla, cuántas consultas
 * hace). Base y correo fingidos: no sale nada.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    t: {} as Record<string, any[]>,
    /** Tablas cuya lectura devuelve error. Con `soloSi`, solo cuando alguna condición `eq` coincide. */
    fallan: [] as { tabla: string; soloSi?: [string, any] }[],
    llamadas: [] as { tabla: string; cols: string }[],
}));
const correo = vi.hoisted(() => ({ enviados: [] as any[], reservadas: new Set<string>() }));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        const filtros: ((r: any) => boolean)[] = [];
        const eqs: [string, any][] = [];
        let cols = '';
        let single = false;
        let lim = Infinity;
        let rango: [number, number] | null = null;
        const resolver = () => {
            db.llamadas.push({ tabla, cols });
            const falla = db.fallan.find((f) => f.tabla === tabla && (!f.soloSi || eqs.some(([c, v]) => c === f.soloSi![0] && v === f.soloSi![1])));
            if (falla) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
            const sel = (db.t[tabla] ?? []).filter((r) => filtros.every((f) => f(r)));
            const pagina = rango ? sel.slice(rango[0], rango[1] + 1) : sel.slice(0, lim);
            return { data: single ? (pagina[0] ?? null) : pagina, error: null };
        };
        const api: any = {
            select: (c: string) => { cols = c; return api; },
            eq: (c: string, v: any) => { eqs.push([c, v]); filtros.push((r) => r[c] === v); return api; },
            in: (c: string, vs: any[]) => { filtros.push((r) => vs.includes(r[c])); return api; },
            gte: (c: string, v: any) => { filtros.push((r) => r[c] != null && r[c] >= v); return api; },
            is: (c: string, v: any) => { filtros.push((r) => (r[c] ?? null) === v); return api; },
            order: () => api,
            limit: (n: number) => { lim = n; return api; },
            range: (a: number, b: number) => { rango = [a, b]; return api; },
            maybeSingle: () => { single = true; return api; },
            then: (ok: any, ko: any) => Promise.resolve(resolver()).then(ok, ko),
        };
        return api;
    }
    return { supabase: { from: (t: string) => builder(t) } };
});
vi.mock('./avisos-correo.service', () => ({
    correosDeSoporte: () => ['soporte@sportmaps.co'],
    escaparHtml: (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    uuidDeClave: (clave: string) => `uuid:${clave}`,
    // Igual que la real: la primera reserva de una clave envía; las demás son 'duplicado'.
    enviarConReserva: vi.fn(async (p: any) => {
        if (correo.reservadas.has(p.clave)) return 'duplicado';
        correo.reservadas.add(p.clave);
        correo.enviados.push(p);
        return 'enviado';
    }),
}));

import {
    afirmacionPorVerificar, afirmacionesPorVerificar, armarInformeEscuela, armarInformeVigilante, asuntoDelCorreo,
    clasificarEntrante, claveDelVigilante, clientesSinRespuesta, comprobantesSinDesenlace, contactoCorto,
    derivacionesSinRespuesta, desenlaceDeComprobante, esCortesia, esPasoDeDerivacion, esSalienteHumano, fraseQueAfirma,
    horaCot, horasHabilesEntre, htmlDelCorreo, indexar, informeFallido, instanteDeLaCorrida, lineasDelCorreo,
    entrantesSinDuenoDelSilencio, MAX_CONSULTAS_DE_MENSAJES, montoDe, normalizar, pesos, repeticionesDelBot, resumenParaEscuela, runWhatsAppVigilante,
    sinNovedades, tieneHallazgos, totales, ventanaDelInforme, vigilarFecha,
    type ConversacionV, type FilaDeCola, type InformeVigilante, type MensajeV,
} from './whatsapp-vigilante.service';

// ─── Datos de prueba ─────────────────────────────────────────────────────────

/** 2026-11-18 es miércoles; 7:15 COT = 12:15Z. (El 16 es lunes festivo.) */
const AHORA = Date.parse('2026-11-18T12:15:00Z');
const H = 3600_000;
const hace = (horas: number) => new Date(AHORA - horas * H).toISOString();

const ESC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ESC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INT_A = 'integ-a';
const INT_B = 'integ-b';

let sec = 0;
const fila = (x: Partial<FilaDeCola> & { integration_id?: string; school_id?: string } = {}): FilaDeCola & { integration_id: string; school_id: string } => ({
    id: `q${++sec}`, integration_id: INT_A, school_id: ESC_A, wa_phone_number: '573001112233', message_type: 'image', status: 'done',
    result_type: 'payment_receipt', error_message: null, storage_path: 'wa/a.jpg', media_caption: null,
    created_at: hace(5), updated_at: hace(5), processed_at: hace(5), pregunta_at: null, monto: null, tipo: null, ...x,
});
const msg = (x: Partial<MensajeV> & { horas: number }): MensajeV => {
    const { horas, ...resto } = x;
    return {
        id: `m${++sec}`, conversation_id: 'c1', direction: 'inbound', type: 'text', text_body: '', ai_generated: false,
        wa_timestamp: hace(horas), created_at: hace(horas), step: null, ...resto,
    };
};
const entrante = (horas: number, texto: string, x: Partial<MensajeV> = {}) => msg({ horas, text_body: texto, ...x });
const bot = (horas: number, texto: string, step: string, x: Partial<MensajeV> = {}) =>
    msg({ horas, direction: 'outbound', ai_generated: true, text_body: texto, step, ...x });
const humano = (horas: number, texto: string, x: Partial<MensajeV> = {}) =>
    msg({ horas, direction: 'outbound', ai_generated: false, text_body: texto, step: null, ...x });
const conv = (x: Partial<ConversacionV> & { integration_id?: string; last_message_at?: string } = {}) => ({
    id: 'c1', integration_id: INT_A, contact_wa_id: '573001112233', contact_name: 'Laura Gómez', status: 'open',
    tomada_hasta: null, last_message_at: hace(1), ...x,
});
const SIN_SENALES = { conceptoEsperado: false, textoDePago: false };

beforeEach(() => {
    db.t = {};
    db.fallan = [];
    db.llamadas = [];
    correo.enviados = [];
    correo.reservadas = new Set();
    delete process.env.DISABLE_WHATSAPP_VIGILANTE;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

// ─── Utilidades ──────────────────────────────────────────────────────────────

describe('utilidades', () => {
    it('el contacto solo muestra los últimos 4 dígitos', () => {
        expect(contactoCorto('Laura Gómez', '573001112233')).toBe('Laura Gómez (…2233)');
        expect(contactoCorto(null, '573001112233')).toBe('…2233');
        expect(contactoCorto('Ana', null)).toBe('Ana (número oculto)');
        expect(contactoCorto('Laura', '573001112233')).not.toContain('300111');
    });
    it('hora de Colombia, pesos y monto', () => {
        expect(horaCot('2026-11-17T20:42:00Z')).toBe('17 nov, 3:42 p. m.');
        expect(horaCot('2026-11-18T05:05:00Z')).toBe('18 nov, 12:05 a. m.');
        expect(pesos(1250000)).toBe('$1.250.000');
        expect(montoDe('180000')).toBe(180000);
        expect(montoDe(95000.4)).toBe(95000.4);
        expect(montoDe('0')).toBeNull();
        expect(montoDe(null)).toBeNull();
        expect(montoDe('sin leer')).toBeNull();
    });
    it('normalizar quita tildes, signos y emojis', () => {
        expect(normalizar('¿Cuánto   VALE la inscripción? 🙏')).toBe('cuanto vale la inscripcion');
    });
    it('horas hábiles: L–V 7–19, sábado 8–15, sin domingos ni festivos', () => {
        // martes 17 nov 16:00 COT → miércoles 18 nov 7:15 COT = 3 h del martes + 0,25 h del miércoles
        expect(horasHabilesEntre(Date.parse('2026-11-17T21:00:00Z'), AHORA)).toBeCloseTo(3.25, 5);
        // sábado 14 nov 14:00 COT → martes 17 nov 8:00 COT: 1 h sábado + domingo 0 + lunes festivo 0 + 1 h martes
        expect(horasHabilesEntre(Date.parse('2026-11-14T19:00:00Z'), Date.parse('2026-11-17T13:00:00Z'))).toBeCloseTo(2, 5);
        // de noche no corre
        expect(horasHabilesEntre(Date.parse('2026-11-18T01:00:00Z'), Date.parse('2026-11-18T09:00:00Z'))).toBe(0);
        expect(horasHabilesEntre(AHORA, AHORA - H)).toBe(0);
    });
    it('la ventana es de 24 h, y de 48 h los lunes', () => {
        expect(AHORA - ventanaDelInforme(AHORA).desde).toBe(24 * H);
        const lunes = Date.parse('2026-11-23T12:15:00Z');
        expect(lunes - ventanaDelInforme(lunes).desde).toBe(48 * H);
    });
    it('el instante de la corrida de una fecha son las 7:15 de Colombia', () => {
        expect(instanteDeLaCorrida('2026-11-18')).toBe(AHORA);
        expect(instanteDeLaCorrida('18/11/2026')).toBeNull();
    });
});

// ─── ¿Pregunta, aviso de pago o cortesía? ────────────────────────────────────

describe('clasificarEntrante', () => {
    it.each([
        '¿Cuánto vale la mensualidad?',
        'cuanto cuesta la inscripcion',
        'Hola buenas tardes, qué horarios tienen para niños de 8 años',
        'Me pueden confirmar si hay clase mañana',
        'quisiera saber si tienen cupo en sub 10',
        'Buenas, información por favor',
        'Info',
        'donde queda la sede',
        'A qué hora es el partido del sábado',
        'ya pagué este mes?',
        'como hago para inscribir a mi hijo',
    ])('pregunta: %s', (t) => expect(clasificarEntrante(t)).toBe('pregunta'));

    it.each([
        'Ya pagué',
        'ya pague la mensualidad de noviembre',
        'Buenas tardes, hice la transferencia hace un rato',
        'Le envío el comprobante de pago',
        'ahí va el soporte',
        'Adjunto comprobante',
        'Ya realicé la consignación',
        'pago realizado',
        'ya quedó pago lo de la clínica',
        'listo ya transferí, gracias',
    ])('aviso de pago: %s', (t) => expect(clasificarEntrante(t)).toBe('aviso_pago'));

    it.each([
        'Hola',
        'Buenas tardes',
        'ok gracias',
        'Listo, muchas gracias 🙏',
        '👍',
        'Dale perfecto',
        'Dios le pague',
        'Muchas gracias, Dios les pague',
        'Sí señora',
        'jajaja',
        'El niño llegó bien a la casa',
        'Mañana no puede ir porque tiene cita médica',
        'cuando pague le aviso',
        'no he pagado todavía',
        '',
        null,
    ])('no espera respuesta: %s', (t) => expect(clasificarEntrante(t as any)).toBeNull());

    it('esCortesia sobre texto normalizado', () => {
        expect(esCortesia(normalizar('Hola, buenos días'))).toBe(true);
        expect(esCortesia(normalizar('hola necesito el horario'))).toBe(false);
        expect(esCortesia('')).toBe(true);
    });
});

// ─── Quién escribió y qué es una derivación ──────────────────────────────────

describe('salientes y derivaciones', () => {
    it('humano = saliente sin IA, sin paso y que no es el saludo automático', () => {
        expect(esSalienteHumano(humano(1, 'ya te ayudo'))).toBe(true);
        expect(esSalienteHumano(bot(1, 'hola', 'llm_text'))).toBe(false);
        expect(esSalienteHumano(msg({ horas: 1, direction: 'outbound', step: 'campana' }))).toBe(false);
        expect(esSalienteHumano(humano(1, 'Gracias por escribirnos', { automatico: true }))).toBe(false);
        expect(esSalienteHumano(entrante(1, 'hola'))).toBe(false);
    });
    it.each([
        'venta_servicio_a_la_escuela', 'venta_servicio_humano', 'escalated', 'mensaje_para_persona',
        'venta_comprobante_a_la_escuela', 'comprobante_a_la_escuela', 'cupo_separado_a_la_escuela', 'prospecto_persona',
        'embudo_a_persona', 'escalacion_sin_respuesta', 'referidos_a_la_escuela', 'venta_humano',
    ])('es derivación: %s', (s) => expect(esPasoDeDerivacion(s)).toBe(true));
    it.each(['llm_text', 'prospecto_ia', 'venta_servicio_respuesta', 'contacto_personal', 'silencio_persona', 'silencio_humano', 'campana', '', null])(
        'no es derivación: %s', (s) => expect(esPasoDeDerivacion(s as any)).toBe(false));
});

// ─── Afirmaciones ────────────────────────────────────────────────────────────

describe('afirmaciones del bot', () => {
    it.each([
        ['¡Listo! Ya te anoté para la clase del sábado.', 'ya te anoté'],
        ['Registré a Samuel en la clínica.', 'registré'],
        ['Guardé tus datos, nos vemos el martes', 'guardé'],
        ['Tu clase quedó reservada para el jueves 4 p. m.', 'quedó reservada'],
        ['Perfecto, tu cupo está confirmado 🎉', 'está confirmado'],
        ['Ya quedaste inscrito en el torneo', 'quedaste inscrito'],
        ['Hemos registrado tu pago', 'hemos registrado'],
    ])('afirma: %s', (texto, frase) => expect(fraseQueAfirma(texto)).toBe(frase));

    it.each([
        'Para que te anote necesito el nombre del niño',
        'Cuando pagues queda reservado tu cupo',
        'Aún no quedó registrado tu pago, la escuela lo revisa',
        'Tu cupo no está confirmado todavía',
        'Si quieres te reservo un cupo',
        'La escuela te confirma en un momento',
        '',
    ])('no afirma: %s', (texto) => expect(fraseQueAfirma(texto)).toBeNull());

    it('solo cuenta en IA y en pasos de texto libre (o sin paso)', () => {
        const texto = 'Listo, ya te anoté.';
        expect(afirmacionPorVerificar(bot(1, texto, 'prospecto_ia'))).toBe('ya te anoté');
        expect(afirmacionPorVerificar(bot(1, texto, 'llm_text'))).toBe('ya te anoté');
        expect(afirmacionPorVerificar(bot(1, texto, 'venta_servicio_respuesta'))).toBe('ya te anoté');
        expect(afirmacionPorVerificar(msg({ horas: 1, direction: 'outbound', ai_generated: true, text_body: texto, step: null }))).toBe('ya te anoté');
        // El paso que SÍ ejecuta la acción no se reporta.
        expect(afirmacionPorVerificar(bot(1, texto, 'clase_prueba_agendada'))).toBeNull();
        // Lo que escribe una persona no es del bot.
        expect(afirmacionPorVerificar(humano(1, texto))).toBeNull();
        expect(afirmacionPorVerificar(entrante(1, 'ya te anoté'))).toBeNull();
    });
});

// ─── El desenlace de un comprobante ──────────────────────────────────────────

describe('desenlaceDeComprobante', () => {
    it('terminó en cobro', () => {
        expect(desenlaceDeComprobante(fila(), SIN_SENALES, AHORA).tipo).toBe('cobro');
        expect(desenlaceDeComprobante(fila({ result_type: 'payment_link' }), SIN_SENALES, AHORA).tipo).toBe('cobro');
    });
    it('lo que la escuela cerró en la bandeja está resuelto, tenga el estado que tenga', () => {
        const f = fila({ status: 'ignored', result_type: 'escalated', processed_at: hace(60), error_message: 'cerrado_escuela: resuelto — ya lo registré | sin_familia: x' });
        expect(desenlaceDeComprobante(f, SIN_SENALES, AHORA).tipo).toBe('resuelto');
    });
    it('esperando al cliente: en curso antes de 2 h, sin desenlace después', () => {
        const reciente = fila({ status: 'waiting_user', result_type: null, pregunta_at: hace(1) });
        const vieja = fila({ status: 'waiting_user', result_type: null, pregunta_at: hace(9) });
        expect(desenlaceDeComprobante(reciente, SIN_SENALES, AHORA).tipo).toBe('en_curso');
        const d = desenlaceDeComprobante(vieja, SIN_SENALES, AHORA);
        expect(d.tipo).toBe('sin_desenlace');
        expect((d as any).motivo).toContain('hace 9 h');
    });
    it('una pregunta que quedó en fila (sin pregunta_at) cuenta desde updated_at', () => {
        const f = fila({ status: 'waiting_user', result_type: null, pregunta_at: null, updated_at: hace(3) });
        expect(desenlaceDeComprobante(f, SIN_SENALES, AHORA).tipo).toBe('sin_desenlace');
    });
    it('en la bandeja: en curso el primer día, sin desenlace después de 24 h', () => {
        const hoy = fila({ status: 'ignored', result_type: 'escalated', processed_at: hace(6), error_message: 'sin_familia: no hay ficha' });
        const ayer = fila({ status: 'ignored', result_type: 'escalated', processed_at: hace(30), error_message: 'sin_familia: no hay ficha' });
        expect(desenlaceDeComprobante(hoy, SIN_SENALES, AHORA).tipo).toBe('en_curso');
        expect(desenlaceDeComprobante(ayer, SIN_SENALES, AHORA).tipo).toBe('sin_desenlace');
    });
    it('cerrado en silencio con monto leído = sin desenlace', () => {
        const f = fila({ status: 'ignored', result_type: 'none', error_message: 'sin pagos pendientes', monto: '180000' });
        const d = desenlaceDeComprobante(f, SIN_SENALES, AHORA);
        expect(d.tipo).toBe('sin_desenlace');
        expect((d as any).motivo).toContain('sin pagos pendientes');
    });
    it('cerrado en silencio sin monto: solo si hay archivo guardado y una señal de pago', () => {
        const f = fila({ status: 'ignored', result_type: 'none', error_message: 'no es un comprobante' });
        expect(desenlaceDeComprobante(f, SIN_SENALES, AHORA).tipo).toBe('ruido');
        expect(desenlaceDeComprobante(f, { conceptoEsperado: true, textoDePago: false }, AHORA).tipo).toBe('sin_desenlace');
        expect(desenlaceDeComprobante(f, { conceptoEsperado: false, textoDePago: true }, AHORA).tipo).toBe('sin_desenlace');
        const sinArchivo = fila({ status: 'ignored', result_type: 'none', error_message: 'bot_apagado', storage_path: null });
        expect(desenlaceDeComprobante(sinArchivo, { conceptoEsperado: true, textoDePago: true }, AHORA).tipo).toBe('ruido');
    });
    it.each([
        'ya registrado: Mensualidad noviembre',
        'comprobante ya recibido (misma imagen)',
        'venta_comprobante_repetido: misma referencia que el cobro abc',
        'numero_sin_verificar: comprobante repetido (misma referencia)',
        'referencia ya usada: 123456',
    ])('un repetido no es «sin desenlace» aunque tenga monto: %s', (motivo) => {
        const f = fila({ status: 'ignored', result_type: 'none', error_message: motivo, monto: '90000' });
        expect(desenlaceDeComprobante(f, { conceptoEsperado: true, textoDePago: true }, AHORA).tipo).toBe('resuelto');
    });
    it('fallido siempre; sin procesar solo después de 1 h', () => {
        expect(desenlaceDeComprobante(fila({ status: 'failed', result_type: null }), SIN_SENALES, AHORA).tipo).toBe('sin_desenlace');
        expect(desenlaceDeComprobante(fila({ status: 'pending', result_type: null, created_at: hace(0.2) }), SIN_SENALES, AHORA).tipo).toBe('en_curso');
        expect(desenlaceDeComprobante(fila({ status: 'processing', result_type: null, created_at: hace(3) }), SIN_SENALES, AHORA).tipo).toBe('sin_desenlace');
    });
});

// ─── Las secciones ───────────────────────────────────────────────────────────

describe('1. comprobantes sin desenlace', () => {
    it('lista, suma en pesos y trae lo que dijo el cliente', () => {
        const mensajes = [entrante(9.1, 'Buenas, ya hice la transferencia de la clínica')];
        const indices = indexar(mensajes, [conv()]);
        const cola = [
            fila({ status: 'waiting_user', result_type: null, created_at: hace(9), pregunta_at: hace(9), monto: '350000' }),
            fila({ status: 'ignored', result_type: 'none', error_message: 'sin pagos pendientes', monto: '120000', wa_phone_number: '573009998877', media_caption: 'pago de noviembre' }),
            fila(), // terminó en cobro
            fila({ status: 'ignored', result_type: 'none', error_message: 'no es un comprobante', wa_phone_number: '573004445566' }), // ruido
            fila({ message_type: 'text', status: 'failed', result_type: null }), // no es archivo
        ];
        const s = comprobantesSinDesenlace({ cola, conceptos: [], indices, ahora: AHORA });
        expect(s.total).toBe(2);
        expect(s.pesos).toBe(470000);
        expect(s.items[0]).toMatchObject({ contacto: 'Laura Gómez (…2233)', monto: 350000, dijo: 'Buenas, ya hice la transferencia de la clínica' });
        expect(s.items[1]).toMatchObject({ contacto: '…8877', monto: 120000, dijo: 'pago de noviembre' });
        expect(s.items[0].queHacer).toMatch(/aplicar el pago a mano/);
    });
    it('un concepto esperado vivo del mismo número es señal de pago y presta su monto', () => {
        const cola = [fila({ status: 'ignored', result_type: 'none', error_message: 'no_es_comprobante_sin_contexto', wa_phone_number: '573205550101' })];
        const vivo = [{ telefono: '3205550101', motivo: 'Clínica de diciembre', monto: 250000, vence_en: hace(-24) }];
        const vencido = [{ telefono: '3205550101', motivo: 'Clínica de diciembre', monto: 250000, vence_en: hace(2) }];
        const indices = indexar([], []);
        const s = comprobantesSinDesenlace({ cola, conceptos: vivo, indices, ahora: AHORA });
        expect(s.total).toBe(1);
        expect(s.pesos).toBe(250000);
        expect(s.items[0].motivo).toContain('se esperaba: Clínica de diciembre');
        expect(comprobantesSinDesenlace({ cola, conceptos: vencido, indices, ahora: AHORA }).total).toBe(0);
        // Sin poder leer los conceptos (null) no se inventa la señal.
        expect(comprobantesSinDesenlace({ cola, conceptos: null, indices, ahora: AHORA }).total).toBe(0);
    });
    it('el texto de pago del cliente cerca del archivo es señal de pago', () => {
        const cola = [fila({ status: 'ignored', result_type: 'none', error_message: 'contacto_no_atendido', created_at: hace(5) })];
        const cerca = indexar([entrante(5.2, 'ya pagué la mensualidad')], [conv()]);
        const lejos = indexar([entrante(20, 'ya pagué la mensualidad')], [conv()]);
        expect(comprobantesSinDesenlace({ cola, conceptos: [], indices: cerca, ahora: AHORA }).total).toBe(1);
        expect(comprobantesSinDesenlace({ cola, conceptos: [], indices: lejos, ahora: AHORA }).total).toBe(0);
    });
});

describe('2. preguntas pasadas a la escuela sin respuesta', () => {
    const desde = AHORA - 48 * H;
    it('lista la derivación sin respuesta humana tras 4 h hábiles, con lo que preguntó el cliente', () => {
        // martes 17 nov 10:00 COT → miércoles 7:15: 9 h + 0,25 h hábiles
        const mensajes = [
            entrante(21.5, '¿Tienen descuento por hermanos?'),
            bot(21.25, 'Esa pregunta te la responde la escuela. Ya les avisé.', 'venta_servicio_a_la_escuela'),
            bot(21.2, 'Mientras tanto, aquí tienes los horarios.', 'llm_text'),
        ];
        const s = derivacionesSinRespuesta({ indices: indexar(mensajes, [conv()]), desde, ahora: AHORA });
        expect(s.total).toBe(1);
        expect(s.items[0]).toMatchObject({ contacto: 'Laura Gómez (…2233)', dijo: '¿Tienen descuento por hermanos?' });
        expect(s.items[0].motivo).toContain('venta_servicio_a_la_escuela');
        expect(s.items[0].motivo).toContain('9 h hábiles');
    });
    it('una respuesta de una persona después la resuelve; un saliente del bot o el saludo automático no', () => {
        const base = [entrante(21.5, 'necesito hablar con alguien'), bot(21.25, 'Te contesta la escuela', 'escalated')];
        const con = (extra: MensajeV) => derivacionesSinRespuesta({ indices: indexar([...base, extra], [conv()]), desde, ahora: AHORA }).total;
        expect(con(humano(20, 'Hola Laura, con gusto'))).toBe(0);
        expect(con(bot(20, 'Sigo aquí', 'llm_text'))).toBe(1);
        expect(con(humano(20, 'Gracias por comunicarte', { automatico: true }))).toBe(1);
        expect(con(msg({ horas: 20, direction: 'outbound', ai_generated: false, step: 'campana', text_body: 'Promo' }))).toBe(1);
    });
    it('todavía dentro de las horas hábiles no se reporta (derivada anoche)', () => {
        // martes 17 nov 20:00 COT → miércoles 7:15: 0,25 h hábiles
        const mensajes = [entrante(11.5, 'quiero hablar con el profe'), bot(11.25, 'Le aviso a la escuela', 'mensaje_para_persona')];
        expect(derivacionesSinRespuesta({ indices: indexar(mensajes, [conv()]), desde, ahora: AHORA }).total).toBe(0);
        expect(derivacionesSinRespuesta({ indices: indexar(mensajes, [conv()]), desde, ahora: AHORA, horasHabiles: 0.2 }).total).toBe(1);
    });
    it('una conversación cerrada a mano no se reporta, y cuenta la derivación posterior a la última respuesta humana', () => {
        const base = [entrante(21.5, 'una duda'), bot(21.25, 'Te contesta la escuela', 'venta_servicio_humano')];
        expect(derivacionesSinRespuesta({ indices: indexar(base, [conv({ status: 'closed' })]), desde, ahora: AHORA }).total).toBe(0);
        const dos = [
            ...base, humano(21, 'Hola, dime'),
            entrante(20.9, '¿y el uniforme?'), bot(20.8, 'Eso te lo dice la escuela', 'venta_servicio_a_la_escuela'),
        ];
        const s = derivacionesSinRespuesta({ indices: indexar(dos, [conv()]), desde, ahora: AHORA });
        expect(s.total).toBe(1);
        expect(s.items[0].dijo).toBe('¿y el uniforme?');
    });
});

describe('3. clientes sin respuesta', () => {
    const desde = AHORA - 24 * H;
    it('pregunta sin ningún saliente en 30 min; la que sí tuvo respuesta no', () => {
        const mensajes = [
            entrante(10, '¿A qué hora es la clase de mañana?'),
            entrante(6, '¿Cuánto vale la inscripción?', { conversation_id: 'c2' }),
            bot(5.9, 'La inscripción vale $80.000', 'get_school_info', { conversation_id: 'c2' }),
        ];
        const convs = [conv(), conv({ id: 'c2', contact_wa_id: '573009998877', contact_name: 'Pedro' })];
        const s = clientesSinRespuesta({ indices: indexar(mensajes, convs), desde, ahora: AHORA });
        expect(s.total).toBe(1);
        expect(s.items[0]).toMatchObject({ contacto: 'Laura Gómez (…2233)', dijo: '¿A qué hora es la clase de mañana?' });
        expect(s.items[0].motivo).toBe('Hizo una pregunta y sigue sin respuesta');
    });
    it('excluye cortesías, saludos sueltos y charla; un botón cuenta como texto', () => {
        const mensajes = [
            entrante(10, 'Hola'), entrante(9.9, 'ok gracias'), entrante(9.8, 'El niño va con la abuela hoy'),
            entrante(8, 'Información', { conversation_id: 'c2', type: 'button' }),
            entrante(7, '¿me confirman?', { conversation_id: 'c3', type: 'image' }), // un archivo no es de esta sección
        ];
        const convs = [conv(), conv({ id: 'c2', contact_wa_id: '573009998877', contact_name: null }), conv({ id: 'c3', contact_wa_id: '573004445566' })];
        const s = clientesSinRespuesta({ indices: indexar(mensajes, convs), desde, ahora: AHORA });
        expect(s.items.map((i) => i.contacto)).toEqual(['…8877']);
    });
    it('el que escribió hace menos de 30 min todavía no cuenta; el saludo automático no es respuesta', () => {
        const reciente = [entrante(0.3, '¿Hay clase hoy?')];
        expect(clientesSinRespuesta({ indices: indexar(reciente, [conv()]), desde, ahora: AHORA }).total).toBe(0);
        const conSaludo = [entrante(5, '¿Hay clase hoy?'), humano(4.99, 'Gracias por escribirnos, ya te atendemos', { automatico: true })];
        expect(clientesSinRespuesta({ indices: indexar(conSaludo, [conv()]), desde, ahora: AHORA }).total).toBe(1);
    });
    it('una ráfaga contestada a tiempo no se reporta; un aviso de pago manda sobre la pregunta', () => {
        const rafaga = [entrante(5, '¿Hay clase hoy?'), entrante(4.95, '¿y mañana?'), bot(4.9, 'Sí, hoy a las 4', 'llm_text')];
        expect(clientesSinRespuesta({ indices: indexar(rafaga, [conv()]), desde, ahora: AHORA }).total).toBe(0);
        const dos = [entrante(6, '¿Me confirman el valor?'), entrante(5, 'Ya pagué la mensualidad')];
        const s = clientesSinRespuesta({ indices: indexar(dos, [conv()]), desde, ahora: AHORA });
        expect(s.total).toBe(1);
        expect(s.items[0].dijo).toBe('Ya pagué la mensualidad');
        expect(s.items[0].motivo).toContain('Avisó de un pago y sigue sin respuesta (2 mensajes así)');
        expect(s.items[0].queHacer).toMatch(/registrar el pago/);
    });
    it('marca la ventana de silencio (una persona venía atendiendo) y la respuesta tardía', () => {
        const silencio = [humano(8, 'Hola Laura, ya reviso'), entrante(6, '¿Entonces sí puedo llevarlo el sábado?')];
        const s1 = clientesSinRespuesta({ indices: indexar(silencio, [conv()]), desde, ahora: AHORA });
        expect(s1.items[0].motivo).toContain('una persona de la escuela venía atendiendo');
        expect(s1.items[0].queHacer).toContain('la persona que atendía no volvió');

        const tomada = [entrante(6, '¿Entonces sí puedo llevarlo el sábado?')];
        const s2 = clientesSinRespuesta({ indices: indexar(tomada, [conv({ tomada_hasta: hace(4) })]), desde, ahora: AHORA });
        expect(s2.items[0].motivo).toContain('venía atendiendo');

        const tardia = [entrante(6, '¿Cuánto debo?'), humano(3, 'Debes $90.000')];
        const s3 = clientesSinRespuesta({ indices: indexar(tardia, [conv()]), desde, ahora: AHORA });
        expect(s3.items[0].motivo).toContain('le contestaron 180 min después');
    });
    it('lo de antes de la ventana no entra', () => {
        const viejo = [entrante(30, '¿Cuánto vale?')];
        expect(clientesSinRespuesta({ indices: indexar(viejo, [conv()]), desde, ahora: AHORA }).total).toBe(0);
    });
});

describe('4 y 5. afirmaciones y repeticiones', () => {
    const desde = AHORA - 24 * H;
    it('afirmaciones: solo IA en pasos sin garantía, dentro de la ventana', () => {
        const mensajes = [
            bot(5, 'Listo, ya te anoté para el sábado.', 'prospecto_ia'),
            bot(4, 'Tu clase de prueba quedó agendada.', 'clase_prueba_agendada'),
            bot(30, 'Ya te anoté.', 'llm_text'),
        ];
        const s = afirmacionesPorVerificar({ indices: indexar(mensajes, [conv()]), desde });
        expect(s.total).toBe(1);
        expect(s.items[0].motivo).toContain('«ya te anoté»');
        expect(s.items[0].motivo).toContain('prospecto_ia');
    });
    it('repeticiones: 3 veces el mismo texto en 10 min; 3 veces repartidas en una hora no', () => {
        const texto = 'No logré entender tu mensaje, ¿me lo repites?';
        const seguidas = [bot(5, texto, 'llm_error_menu'), bot(4.95, texto, 'llm_error_menu'), bot(4.9, `${texto} `, 'llm_error_menu')];
        const s = repeticionesDelBot({ indices: indexar(seguidas, [conv()]), desde });
        expect(s.total).toBe(1);
        expect(s.items[0].motivo).toContain('3 veces');
        const repartidas = [bot(5, texto, 'x'), bot(4.5, texto, 'x'), bot(4, texto, 'x')];
        expect(repeticionesDelBot({ indices: indexar(repartidas, [conv()]), desde }).total).toBe(0);
        // Lo que repite una persona no es del bot; dos veces no alcanza.
        const persona = [humano(5, texto), humano(4.99, texto), humano(4.98, texto)];
        expect(repeticionesDelBot({ indices: indexar(persona, [conv()]), desde }).total).toBe(0);
        expect(repeticionesDelBot({ indices: indexar(seguidas.slice(0, 2), [conv()]), desde }).total).toBe(0);
    });
});

// ─── El informe, el correo y el texto de la escuela ──────────────────────────

function datosDeEjemplo() {
    const cola = [
        fila({ created_at: hace(3) }), fila({ created_at: hace(4) }), fila({ created_at: hace(6) }),
        fila({ status: 'waiting_user', result_type: null, created_at: hace(9), pregunta_at: hace(9), monto: '350000' }),
        fila({ status: 'ignored', result_type: 'none', error_message: 'sin pagos pendientes', monto: '120000', wa_phone_number: '573009998877', media_caption: 'pago de noviembre', created_at: hace(40) }),
    ];
    const conversaciones = [
        conv(), conv({ id: 'c2', contact_wa_id: '573009998877', contact_name: 'Pedro Ruiz' }),
        conv({ id: 'c3', contact_wa_id: '573004445566', contact_name: 'Ana <b>Mora</b>' }),
    ];
    const mensajes = [
        entrante(9.1, 'Buenas, ya hice la transferencia de la clínica'),
        bot(9.05, 'Recibí tu comprobante. ¿De qué deportista es?', 'ask_deportista'),
        entrante(21.5, '¿Tienen descuento por hermanos?', { conversation_id: 'c2' }),
        bot(21.25, 'Esa pregunta te la responde la escuela.', 'venta_servicio_a_la_escuela', { conversation_id: 'c2' }),
        entrante(6, '¿A qué hora es la clase de mañana?', { conversation_id: 'c3' }),
        bot(12, 'Listo, ya te anoté para el sábado.', 'prospecto_ia', { conversation_id: 'c3' }),
    ];
    return { cola, conceptos: [], conversaciones, mensajes, recortado: false, consultas: 4 };
}
const QUIEN = { integrationId: INT_A, schoolId: ESC_A, escuela: 'Monster´s Volley Club' };

describe('armarInformeEscuela', () => {
    it('encabezado con los números del día y las cinco secciones', () => {
        const e = armarInformeEscuela(QUIEN, datosDeEjemplo(), ventanaDelInforme(AHORA));
        // Del día (24 h): 3 en cobro + 1 esperando al cliente = 4 archivos; el de hace 40 h no es «del día».
        expect(e.numeros).toMatchObject({
            archivosRecibidos: 4, terminaronEnCobro: 3, pctCobro: 75,
            comprobantesSinDesenlace: 2, pesosSinDesenlace: 470000, preguntasSinRespuesta: 1, clientesSinRespuesta: 1,
        });
        expect(e.comprobantes.total).toBe(2);
        expect(e.derivaciones.total).toBe(1);
        expect(e.clientes.total).toBe(1);
        expect(e.afirmaciones.total).toBe(1);
        expect(e.repeticiones.total).toBe(0);
        expect(e.error).toBeNull();
    });
    it('sin archivos el porcentaje es null, no 0', () => {
        const e = armarInformeEscuela(QUIEN, { cola: [], conceptos: [], conversaciones: [], mensajes: [], recortado: false, consultas: 3 }, ventanaDelInforme(AHORA));
        expect(e.numeros.pctCobro).toBeNull();
    });
});

describe('resumenParaEscuela', () => {
    it('corto, tuteando, sin jerga y sin las secciones internas', () => {
        const e = armarInformeEscuela(QUIEN, datosDeEjemplo(), ventanaDelInforme(AHORA));
        const texto = resumenParaEscuela(e)!;
        expect(texto).toContain('tienes 2 comprobantes por revisar y 2 personas esperando respuesta');
        expect(texto).toContain('$470.000');
        expect(texto).toContain('https://app.sportmaps.co/whatsapp');
        expect(texto).not.toMatch(/bot|derivaci|waiting|escal|anoté|localhost/i);
        expect(texto).not.toContain('3001112233');
    });
    it('singular, y null cuando no hay nada o no se pudo revisar', () => {
        const datos = datosDeEjemplo();
        const uno = armarInformeEscuela(QUIEN, { ...datos, cola: [datos.cola[3]], mensajes: [] }, ventanaDelInforme(AHORA));
        expect(resumenParaEscuela(uno)).toContain('tienes 1 comprobante por revisar.');
        const nada = armarInformeEscuela(QUIEN, { ...datos, cola: [], mensajes: [] }, ventanaDelInforme(AHORA));
        expect(resumenParaEscuela(nada)).toBeNull();
        expect(resumenParaEscuela(informeFallido(QUIEN, 'timeout'))).toBeNull();
        // Solo afirmaciones del bot (interno): a la escuela no se le dice nada.
        const soloInterno = armarInformeEscuela(QUIEN, { ...datos, cola: [], mensajes: [datos.mensajes[5]] }, ventanaDelInforme(AHORA));
        expect(soloInterno.afirmaciones.total).toBe(1);
        expect(resumenParaEscuela(soloInterno)).toBeNull();
    });
});

describe('el correo', () => {
    const informe = (): InformeVigilante => ({
        fecha: '2026-11-18', desde: hace(24), hasta: hace(0), consultas: 10,
        escuelas: [
            armarInformeEscuela(QUIEN, datosDeEjemplo(), ventanaDelInforme(AHORA)),
            informeFallido({ integrationId: INT_B, schoolId: ESC_B, escuela: 'Dynasty' }, 'mensajes: statement timeout'),
        ],
    });
    it('asunto con los totales', () => {
        expect(asuntoDelCorreo(informe())).toBe(
            '[Revisar] Vigilante WhatsApp 2026-11-18: 2 comprobantes sin desenlace ($470.000) · 1 pregunta sin respuesta de la escuela'
            + ' · 1 cliente sin respuesta · 1 afirmación por verificar · 1 escuela sin revisar');
    });
    it('texto: números por escuela, la que no se pudo revisar y el detalle', () => {
        const l = lineasDelCorreo(informe()).join('\n');
        expect(l).toContain('Monster´s Volley Club: 4 archivos recibidos · 75 % terminó en cobro · 2 comprobantes sin desenlace ($470.000) · 1 preguntas sin respuesta · 1 clientes sin respuesta');
        expect(l).toContain('Dynasty: NO SE PUDO REVISAR (mensajes: statement timeout)');
        expect(l).toContain('1. Comprobantes sin desenlace: 2 · $470.000');
        expect(l).toContain('Laura Gómez (…2233)');
    });
    it('HTML: escapa lo que escribe la gente, sin teléfonos completos, sin medios, solo enlaces de producción', () => {
        const html = htmlDelCorreo(informe());
        expect(html).toContain('Ana &lt;b&gt;Mora&lt;/b&gt;');
        expect(html).not.toContain('<b>Mora</b>');
        expect(html).not.toMatch(/57300\d{7}/);
        expect(html).not.toContain('wa/a.jpg');
        expect(html).not.toMatch(/localhost|supabase\.co|storage/);
        const enlaces = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
        expect(enlaces.length).toBeGreaterThan(0);
        expect(enlaces.every((u) => u.startsWith('https://app.sportmaps.co/'))).toBe(true);
        expect(html).toContain('No se pudo revisar: mensajes: statement timeout');
    });
    it('sin novedades: un correo corto que dice que corrió', () => {
        const limpio: InformeVigilante = {
            fecha: '2026-11-18', desde: hace(24), hasta: hace(0), consultas: 6,
            escuelas: [armarInformeEscuela(QUIEN, { cola: [fila()], conceptos: [], conversaciones: [], mensajes: [], recortado: false, consultas: 3 }, ventanaDelInforme(AHORA))],
        };
        expect(sinNovedades(limpio)).toBe(true);
        expect(asuntoDelCorreo(limpio)).toBe('[Vigilante WhatsApp] 2026-11-18: sin novedades (1 escuela(s) revisadas)');
        expect(lineasDelCorreo(limpio)[0]).toContain('no quedó nada sin desenlace');
        expect(htmlDelCorreo(limpio)).toContain('Sin novedades.');
        expect(htmlDelCorreo(limpio)).toContain('100 %');
    });
    it('recorta la lista a 12 filas por sección y dice cuántas quedan', () => {
        const cola = Array.from({ length: 15 }, (_, i) => fila({
            status: 'failed', result_type: null, wa_phone_number: `57300000${String(1000 + i)}`,
        }));
        const e = armarInformeEscuela(QUIEN, { cola, conceptos: [], conversaciones: [], mensajes: [], recortado: true, consultas: 3 }, ventanaDelInforme(AHORA));
        const inf: InformeVigilante = { fecha: '2026-11-18', desde: hace(24), hasta: hace(0), consultas: 3, escuelas: [e] };
        expect(lineasDelCorreo(inf).join('\n')).toContain('… y 3 más');
        expect(htmlDelCorreo(inf)).toContain('… y 3 más.');
        expect(htmlDelCorreo(inf)).toContain('los números son un piso');
    });
});

// ─── La corrida (base y correo fingidos) ─────────────────────────────────────

function sembrar() {
    const d = datosDeEjemplo();
    db.t.school_whatsapp_integrations = [
        { id: INT_A, school_id: ESC_A, nombre: 'Principal', status: 'active' },
        { id: INT_B, school_id: ESC_B, nombre: 'Principal', status: 'active' },
        { id: 'integ-x', school_id: 'x', nombre: 'Vieja', status: 'suspended' },
    ];
    db.t.schools = [{ id: ESC_A, name: 'Monster´s Volley Club' }, { id: ESC_B, name: 'Dynasty' }];
    db.t.whatsapp_inbound_queue = [
        ...d.cola,
        fila({ integration_id: INT_B, school_id: ESC_B, created_at: hace(2), wa_phone_number: '573150000001' }),
        fila({ integration_id: INT_A, created_at: hace(24 * 9), status: 'failed', result_type: null }), // más de 7 días: no se lee
    ];
    db.t.whatsapp_conceptos_esperados = [];
    db.t.whatsapp_conversations = [
        ...d.conversaciones,
        conv({ id: 'b1', integration_id: INT_B, contact_wa_id: '573150000001', contact_name: 'Familia Rojas' }),
        conv({ id: 'vieja', integration_id: INT_A, last_message_at: hace(100) }),
    ];
    db.t.whatsapp_messages = [...d.mensajes, entrante(3, 'ok gracias', { conversation_id: 'b1' })];
    db.t.email_sends = [];
}

describe('armarInformeVigilante y runWhatsAppVigilante', () => {
    it('arma todas las escuelas con un número pequeño y fijo de consultas, sin payloads completos', async () => {
        sembrar();
        const inf = await armarInformeVigilante(AHORA);
        expect(inf.escuelas.map((e) => e.escuela)).toEqual(['Monster´s Volley Club', 'Dynasty']);
        expect(inf.escuelas[0].numeros).toMatchObject({ archivosRecibidos: 4, pctCobro: 75, comprobantesSinDesenlace: 2 });
        expect(inf.escuelas[1].numeros).toMatchObject({ archivosRecibidos: 1, pctCobro: 100, comprobantesSinDesenlace: 0 });
        // 2 de la corrida (integraciones, nombres) + por escuela 3 fijas + 1 de mensajes.
        expect(db.llamadas.map((l) => l.tabla)).toEqual([
            'school_whatsapp_integrations', 'schools',
            'whatsapp_inbound_queue', 'whatsapp_conceptos_esperados', 'whatsapp_conversations', 'whatsapp_messages',
            'whatsapp_inbound_queue', 'whatsapp_conceptos_esperados', 'whatsapp_conversations', 'whatsapp_messages',
        ]);
        expect(inf.consultas).toBe(10);
        expect(inf.escuelas[0].consultas).toBe(4);
        for (const l of db.llamadas) {
            expect(l.cols).not.toMatch(/\*|ocr_raw|pregunta_opciones|access_token/);
            expect(l.cols).not.toMatch(/(^|,\s*)payload(\s*,|$)/);
            expect(l.cols).not.toMatch(/(^|,\s*)pregunta_ocr(\s*,|$)/);
        }
    });
    it('el número de consultas no crece con las conversaciones: una por lote de 60, con tope', async () => {
        sembrar();
        db.t.whatsapp_conversations = Array.from({ length: 130 }, (_, i) => conv({ id: `c${i}`, contact_wa_id: `57300${String(1000000 + i)}` }));
        db.t.whatsapp_messages = Array.from({ length: 130 }, (_, i) => entrante(5, 'ok', { conversation_id: `c${i}` }));
        db.t.school_whatsapp_integrations = [db.t.school_whatsapp_integrations[0]];
        const inf = await armarInformeVigilante(AHORA);
        const deMensajes = db.llamadas.filter((l) => l.tabla === 'whatsapp_messages').length;
        expect(deMensajes).toBe(3); // 130 conversaciones → 3 lotes
        expect(deMensajes).toBeLessThanOrEqual(MAX_CONSULTAS_DE_MENSAJES);
        expect(inf.escuelas[0].consultas).toBe(6);
    });
    it('una escuela que falla no tumba a las demás y queda como «no se pudo revisar»', async () => {
        sembrar();
        db.fallan = [{ tabla: 'whatsapp_conversations', soloSi: ['integration_id', INT_B] }];
        const inf = await armarInformeVigilante(AHORA);
        const dynasty = inf.escuelas.find((e) => e.escuela === 'Dynasty')!;
        const monster = inf.escuelas.find((e) => e.escuela === 'Monster´s Volley Club')!;
        expect(dynasty.error).toContain('conversaciones');
        expect(monster.error).toBeNull();
        expect(monster.comprobantes.total).toBe(2);
        expect(inf.escuelas[0]).toBe(dynasty); // la que no se pudo revisar va arriba
    });
    it('si no se pueden leer los números activos, no lanza y lo dice', async () => {
        sembrar();
        db.fallan = [{ tabla: 'school_whatsapp_integrations' }];
        const inf = await armarInformeVigilante(AHORA);
        expect(inf.escuelas).toHaveLength(1);
        expect(inf.escuelas[0].error).toContain('no se pudieron leer los números activos');
    });
    it('sin la tabla de conceptos esperados la escuela igual se revisa', async () => {
        sembrar();
        db.fallan = [{ tabla: 'whatsapp_conceptos_esperados' }];
        const inf = await armarInformeVigilante(AHORA);
        expect(inf.escuelas.every((e) => e.error === null)).toBe(true);
    });
    it('manda UN correo al equipo de SportMaps, con clave por fecha', async () => {
        sembrar();
        expect(await runWhatsAppVigilante(AHORA)).toBe('enviado');
        expect(correo.enviados).toHaveLength(1);
        const c = correo.enviados[0];
        expect(c).toMatchObject({ clave: 'wa_vigilante:2026-11-18', tipo: 'wa_vigilante', schoolId: null, plantilla: null, destinos: ['soporte@sportmaps.co'] });
        expect(c.respaldo.subject).toContain('[Revisar] Vigilante WhatsApp 2026-11-18');
        expect(c.respaldo.html).toContain('Monster´s Volley Club');
        expect(claveDelVigilante('2026-11-18')).toBe(c.clave);
    });
    it('si el correo de hoy ya está reservado, gasta UNA consulta y no lee nada más', async () => {
        sembrar();
        db.t.email_sends = [{ id: 'uuid:wa_vigilante:2026-11-18' }];
        expect(await runWhatsAppVigilante(AHORA)).toBe('duplicado');
        expect(db.llamadas.map((l) => l.tabla)).toEqual(['email_sends']);
        expect(correo.enviados).toHaveLength(0);
    });
    it('dos BFF a la vez: solo sale uno (la reserva de enviarConReserva)', async () => {
        sembrar();
        const r = await Promise.all([runWhatsAppVigilante(AHORA), runWhatsAppVigilante(AHORA)]);
        expect(r.sort()).toEqual(['duplicado', 'enviado']);
        expect(correo.enviados).toHaveLength(1);
    });
    it('sin nada que reportar igual sale el correo corto', async () => {
        sembrar();
        db.t.whatsapp_inbound_queue = [];
        db.t.whatsapp_messages = [];
        expect(await runWhatsAppVigilante(AHORA)).toBe('enviado');
        expect(correo.enviados[0].respaldo.subject).toBe('[Vigilante WhatsApp] 2026-11-18: sin novedades (2 escuela(s) revisadas)');
    });
    it('kill-switch, y el domingo no corre (salvo forzado)', async () => {
        sembrar();
        const domingo = Date.parse('2026-11-22T12:15:00Z');
        expect(await runWhatsAppVigilante(domingo)).toBe('no_toca');
        expect(db.llamadas).toHaveLength(0);
        expect(await runWhatsAppVigilante(domingo, { forzar: true })).toBe('enviado');
        process.env.DISABLE_WHATSAPP_VIGILANTE = 'true';
        expect(await runWhatsAppVigilante(AHORA)).toBe('apagado');
    });
    it('a mano con una fecha: devuelve el informe, el correo y el texto de cada escuela SIN enviar nada', async () => {
        sembrar();
        const v = (await vigilarFecha('2026-11-18'))!;
        expect(v.informe.fecha).toBe('2026-11-18');
        expect(v.asunto).toContain('[Revisar]');
        expect(v.paraEscuelas).toHaveLength(1);
        expect(v.paraEscuelas[0]).toMatchObject({ schoolId: ESC_A, escuela: 'Monster´s Volley Club' });
        expect(v.paraEscuelas[0].texto).toContain('tienes 2 comprobantes por revisar');
        expect(correo.enviados).toHaveLength(0);
        expect(db.llamadas.some((l) => l.tabla === 'email_sends')).toBe(false);
        expect(await vigilarFecha('ayer')).toBeNull();
    });
});

// ─── 6. Preguntas y avisos de pago sin dueño durante un silencio ─────────────

describe('6. sin dueño durante un silencio', () => {
    const desde = AHORA - 24 * H;
    const sec6 = (mensajes: MensajeV[], c: Partial<ConversacionV> = {}) =>
        entrantesSinDuenoDelSilencio({ indices: indexar(mensajes, [conv(c)]), desde, ahora: AHORA });

    it('la escuela escribió, el cliente preguntó y nadie contestó: un caso, con los últimos 4 dígitos', () => {
        const s = sec6([
            humano(5, 'Hola, claro, te cuento del cupo'),
            entrante(3, 'Por favor confirmar que los dos cupos quedan reservados'),
        ]);
        expect(s.total).toBe(1);
        expect(s.items[0].contacto).toBe('Laura Gómez (…2233)');
        expect(s.items[0].motivo).toContain('Hizo una pregunta');
        expect(JSON.stringify(s)).not.toContain('573001112233');
    });

    it('si alguien contestó después (la escuela o el bot), no cuenta', () => {
        expect(sec6([humano(5, 'Hola'), entrante(3, '¿Tienen cupo para sábados?'), humano(2, 'Sí, quedan dos')]).total).toBe(0);
        expect(sec6([humano(5, 'Hola'), entrante(3, '¿Tienen cupo para sábados?'), bot(2.9, 'La escuela te confirma', 'venta_servicio_a_la_escuela')]).total).toBe(0);
    });

    it('dentro de la gracia de 30 minutos no se reporta todavía', () => {
        expect(sec6([humano(5, 'Hola'), entrante(0.2, '¿Tienen cupo para sábados?')]).total).toBe(0);
    });

    it('el silencio del desconocido dura 72 h; el de la familia identificada, 12 h', () => {
        const mensajes = [humano(40, 'Hola, te cuento'), entrante(20, '¿Cuánto cuesta el vacacional?')];
        expect(sec6(mensajes, { parent_id: null }).total).toBe(1);
        expect(sec6(mensajes, { parent_id: 'p-1' }).total).toBe(0);
    });

    it('un caso por conversación: el aviso de pago manda sobre la pregunta', () => {
        const s = sec6([
            humano(6, 'Hola'),
            entrante(4, '¿A qué hora es la clase?'),
            entrante(3, 'Ya pagué, te envío el comprobante'),
        ]);
        expect(s.total).toBe(1);
        expect(s.items[0].motivo).toContain('Avisó de un pago');
    });

    it('lo anterior a la ventana del informe no entra', () => {
        expect(sec6([humano(60, 'Hola'), entrante(50, '¿Tienen cupo para sábados?')]).total).toBe(0);
    });

    it('una campaña o un paso del bot NO es una persona escribiendo: sin silencio, sin caso', () => {
        expect(sec6([bot(5, 'Hola, te cuento de la clínica', 'venta_servicio_respuesta'), entrante(3, '¿Tienen cupo para sábados?')]).total).toBe(0);
        expect(sec6([humano(5, 'Promo de diciembre', { campana: 'camp-1' }), entrante(3, '¿Tienen cupo para sábados?')]).total).toBe(0);
    });

    it('entra al informe: hallazgo, asunto y correo en texto y HTML', () => {
        const mensajes = [humano(5, 'Hola, claro'), entrante(3, 'Por favor confirmar que los dos cupos quedan reservados')];
        const e = armarInformeEscuela(QUIEN, { cola: [], conceptos: [], conversaciones: [conv()], mensajes, recortado: false, consultas: 4 }, ventanaDelInforme(AHORA));
        expect(e.sinDueno.total).toBe(1);
        expect(tieneHallazgos(e)).toBe(true);
        const inf: InformeVigilante = { fecha: '2026-11-18', desde: hace(24), hasta: hace(0), consultas: 4, escuelas: [e] };
        expect(asuntoDelCorreo(inf)).toBe('[Revisar] Vigilante WhatsApp 2026-11-18: 1 cliente sin respuesta · 1 pregunta o aviso de pago sin dueño en un silencio');
        // (la misma conversación también la ve la sección 3, que mira los 30 min sin ningún saliente; la 6 dice que fue por un silencio)
        expect(lineasDelCorreo(inf).join('\n')).toContain('6. Preguntas y avisos de pago que quedaron sin dueño durante un silencio: 1');
        expect(htmlDelCorreo(inf)).toContain('sin dueño durante un silencio');
        expect(totales(inf).sinDueno).toBe(1);
        expect(informeFallido(QUIEN, 'x').sinDueno.total).toBe(0);
    });
});
