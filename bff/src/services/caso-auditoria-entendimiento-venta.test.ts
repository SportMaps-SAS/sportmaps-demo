/**
 * Auditoría de conversaciones reales de producción (8–16 nov 2026): cómo ENTIENDE el bot lo que la gente escribe en
 * la venta de un servicio (clínica, vacacional). Cada prueba usa la frase real que falló. Sin base, sin Meta y con
 * el modelo mockeado.
 *
 *   1. No tomar por nombre lo que no lo es (un enlace quedó de asistente; «…Robles Ti» metió el documento).
 *   2. El bloque de pago MENCIONA «nombre completo de quien asiste»: no es una pregunta de datos.
 *   3. Más formas de decir el nombre («El nombre de mi hijo: …», «Jugador 1: … / Jugador 2: …», edad sin nombre).
 *   4. Elegir semanas o fechas del vacacional («3 semanas», «Del 23 al 27 nov / Del 30 al 04 dic»).
 *   5. «Ya pagué» en más formas («Pero, ya lo mandé», «Es que yo aboné antes del 10 de noviembre»).
 *   6. Saludos con vocativo, anuncios de pregunta y cierres que terminaban en «Ya le pasé tu pregunta».
 *   7. Desiste («Estoy en otra ciudad», «no puedo», «no me queda»).
 *   8. La llave / Bre-B con el bloque de pago recién enviado.
 *   9. La IA del servicio: respuesta parcial antes de derivar.
 *  10. «Hola buenas. Interesadísimas en la clínica.\nGabriela Covaleda García\n13 años».
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));
const llm = vi.hoisted(() => ({ chatWithTools: vi.fn() }));
vi.mock('./llm.service', () => llm);

import {
    atenderVentaDeServicio, datosDeAsistenteEnVenta, intencionEnVenta, opcionElegidaEnVenta, textoDeLlave, textoOpcionElegida,
    textoSeguimientoDeVenta, ultimoSalienteSobreAsistente,
    PASO_VENTA, TEXTO_A_LA_ESCUELA, TEXTO_DESISTE, TEXTO_DESISTE_CON_PAGO, TEXTO_DIME, TEXTO_HOLA_CUENTAME, TEXTO_LLAVE_SIN_DATO,
    TEXTO_LO_DEMAS_LA_ESCUELA, TEXTO_YA_PAGO, CIERRE_DE_PAGO,
    type CtxVentaServicio,
} from './whatsapp-venta-servicio';
import { MARCA_VENTA, type VentaActiva } from './whatsapp-venta-contexto';
import type { ItemConFicha } from './whatsapp-anuncio-destino';
import { promptDeServicio, responderPreguntaDeServicio, separarFalta, type PreguntaDeServicio, type RespuestaDeServicio } from './whatsapp-servicio-ia';
import type { CuentaDePagoEmbudo } from './whatsapp-embudo-prospecto';
import type { FilaReciente } from './whatsapp-reglas-turno';
import { nombreDeAsistente, nombreDeAsistenteEnTextos, resolverRespuestaDeAsistente } from './whatsapp-comprobante-de-ficha.service';
import {
    elegirEntreNombres, leerDatosDeRegistro, nombreYAcudienteEnLineas, nombresDeAsistentesEn, textoVariosAsistentes,
    type DatosDeRegistro,
} from './whatsapp-datos-de-registro';
import { leerRespuestaDeDatos } from './wa-registro-de-venta.service';

// ─── Datos ──────────────────────────────────────────────────────────────────

const VACACIONAL: ItemConFicha = {
    id: 'fff41827-cd2f-404a-b0ff-f42dc66c59a8', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional' as any,
    price: null as any, active: true, event_id: null,
    starts_at: '2026-11-17 08:00:00-05', ends_at: '2026-12-10 11:00:00-05',
    opciones: [
        { clave: '1_semana', etiqueta: '1 semana', precio: 80000 },
        { clave: '2_semanas', etiqueta: '2 semanas', precio: 140000 },
        { clave: '3_semanas', etiqueta: '3 semanas', precio: 200000 },
        { clave: '4_semanas', etiqueta: '4 semanas', precio: 250000 },
    ],
    description: 'Vacacional de voleibol en la sede Suba. Lunes a viernes de 8:00 a 11:00 a. m.',
};
const CLINICA: ItemConFicha = {
    id: '16766d2e-f8b0-4285-88e3-b1e67dda6d45', name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: 300000, active: true, event_id: null, starts_at: '2026-11-21 00:00:00-05', ends_at: '2026-11-22 23:59:00-05',
    allow_installments: true, precio_afiliado: null as any, precios_por_fecha: null as any, abono_minimo_pct: 50, opciones: null,
    description: '🏐 Clínica de armadores y atacantes. 📍 Lugar: Colegio Bilingüe La Enseñanza. 🕘 9:00 a. m. a 3:00 p. m.',
};
const NEQUI: CuentaDePagoEmbudo[] = [
    { tipo: 'Nequi', numero: '3194505150', titular: 'Iván Sossa' },
    { tipo: 'Daviplata', numero: '3194505150', titular: 'Iván Sossa' },
];
const CON_LLAVE: CuentaDePagoEmbudo[] = [...NEQUI, { tipo: 'Llave Bre-B', numero: '@monstervolley', titular: 'Iván Sossa' }];

// Lunes 16-nov-2026, 10:00 a. m. en Bogotá.
const AHORA = new Date('2026-11-16T15:00:00Z');
const HOY = '2026-11-16';
const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000).toISOString();
const ent = (min: number, texto: string | null, extra: Partial<FilaReciente> = {}): FilaReciente =>
    ({ direction: 'inbound', type: 'text', text_body: texto, created_at: hace(min), wa_timestamp: hace(min), ...extra });
const sal = (min: number, texto: string, item: ItemConFicha, payload: Record<string, unknown> = {}): FilaReciente => ({
    direction: 'outbound', type: 'text', text_body: texto, created_at: hace(min), wa_timestamp: hace(min), ai_generated: true,
    payload: { [MARCA_VENTA]: item.id, ...payload },
});
const BLOQUE_DE_PAGO = (item: ItemConFicha, min = 5) => sal(min, `Para separar tu cupo en el ${item.name}: … ${CIERRE_DE_PAGO}`, item, { step: PASO_VENTA.PAGO });
const FOTO = (min = 3) => ent(min, null, { type: 'image' });
const venta = (item: ItemConFicha): VentaActiva => ({ item, origen: 'marca', desde: hace(120) });

interface Registro {
    enviados: { texto: string; contexto: Record<string, unknown>; botones?: unknown[] }[];
    avisos: string[]; preguntas: PreguntaDeServicio[]; anotados: string[]; datos: DatosDeRegistro[]; opciones: any[]; pagos: number;
}
const SIN_FICHA: DatosDeRegistro = { nombre: null, fechaNacimiento: null, edad: null, soloEdad: false, acudiente: null, posicion: null };

function ctxDe(o: {
    recientes?: FilaReciente[]; cuentas?: CuentaDePagoEmbudo[]; ia?: RespuestaDeServicio; ficha?: DatosDeRegistro; conOpcion?: boolean;
} = {}): { ctx: CtxVentaServicio; reg: Registro } {
    const reg: Registro = { enviados: [], avisos: [], preguntas: [], anotados: [], datos: [], opciones: [], pagos: 0 };
    const ctx: CtxVentaServicio = {
        schoolId: 'school-monster', conversationId: 'conv-1', recientes: o.recientes ?? [],
        afiliado: async () => false,
        cuentas: async () => o.cuentas ?? NEQUI,
        guardarLead: async () => 'lead-1',
        registrarEsperado: async () => true,
        responderPregunta: async (p) => { reg.preguntas.push(p); return o.ia ?? { tipo: 'no_se', motivo: 'no_esta_en_los_datos' }; },
        enviar: async (texto, contexto, botones) => {
            reg.enviados.push({ texto, contexto, botones });
            if (contexto.step === PASO_VENTA.PAGO) reg.pagos++;
        },
        avisarEscuela: async (d) => { reg.avisos.push(d); },
        comprobanteEnCurso: async () => false,
        anotarAsistente: async (nombre, _item, datos) => { reg.anotados.push(nombre); if (datos) reg.datos.push(datos); return true; },
        ...(o.ficha ? {
            registro: async () => o.ficha as DatosDeRegistro,
            anotarDatos: async (d: DatosDeRegistro) => { reg.datos.push(d); return true; },
        } : {}),
        ...(o.conOpcion ? { anotarOpcion: async (op: any) => { reg.opciones.push(op); return true; } } : {}),
        ahora: () => AHORA,
    };
    return { ctx, reg };
}

/** Nada de lo que sale dice que se anotó o guardó algo (salvo donde la prueba lo espera). */
const NO_AFIRMA_GUARDAR = /anot[ée]|registr[ée]|guard[ée]/i;
/** Lo que terminaba mal: derivado a la escuela. */
const DERIVADO = /Ya le pasé tu pregunta|te lo confirma la escuela/i;

// ─── 1. No tomar por nombre lo que no lo es ─────────────────────────────────

describe('1 · lo que no es un nombre', () => {
    it('un enlace nunca es un nombre («Anoté a *Https Portaldepago Segurosdelestado Com Pago-agil*»)', async () => {
        const enlace = 'https://portaldepago.segurosdelestado.com/pago-agil';
        expect(nombreDeAsistente(enlace)).toBeNull();
        expect(nombreDeAsistente(enlace, { entero: true })).toBeNull();
        expect(leerDatosDeRegistro(enlace, { hoy: HOY, fuente: 'chat' }).nombre).toBeNull();
        expect(leerRespuestaDeDatos(enlace, { hoy: HOY }).nombre).toBeNull();
        for (const t of ['www.portaldepago.com pago agil', 'Portaldepago segurosdelestado.com', 'sara.torres@gmail.com', 'Sara Torres sara@correo.co']) {
            expect(nombreDeAsistente(t), t).toBeNull();
        }
        // …aunque el bot acabe de preguntar el nombre: no se anota a nadie.
        const pidio = sal(1, TEXTO_YA_PAGO, CLINICA, { step: PASO_VENTA.YA_PAGO });
        expect(datosDeAsistenteEnVenta(enlace, [pidio])).toBeNull();
        const { ctx, reg } = ctxDe({ recientes: [pidio] });
        await atenderVentaDeServicio(ctx, venta(CLINICA), enlace);
        expect(reg.anotados).toEqual([]);
        expect(reg.enviados.map((e) => e.texto).join(' ')).not.toMatch(/Https|Portaldepago/i);
    });

    it('lo que empieza por un interrogativo o un verbo de pedido no es un nombre', () => {
        for (const t of ['Que dias son', 'Cual sede', 'Cuanto vale', 'Como llego', 'Donde queda', 'Cuando empieza', 'Me regalas informacion',
            'Quiero informacion', 'Quisiera saber', 'Podrias ayudarme', 'Puedes confirmar', 'Tienen parqueadero', 'Manejan descuento']) {
            expect(nombreDeAsistente(t), t).toBeNull();
            expect(leerDatosDeRegistro(t, { hoy: HOY, fuente: 'chat' }).nombre, t).toBeNull();
        }
    });

    it('el tipo de documento y lo que le siga se cortan del nombre («a nombre de Mariana Isabel la Rotta Robles Ti»)', () => {
        const NOMBRE = 'Mariana Isabel la Rotta Robles';
        for (const t of [
            'a nombre de Mariana Isabel la Rotta Robles Ti',
            'a nombre de Mariana Isabel la Rotta Robles TI 1034567890',
            'a nombre de Mariana Isabel la Rotta Robles T.I. 1034567890',
            'a nombre de Mariana Isabel la Rotta Robles tarjeta de identidad 1034567890',
            'a nombre de Mariana Isabel la Rotta Robles NUIP 1034567890',
        ]) {
            expect(nombreDeAsistente(t), t).toBe(NOMBRE);
            expect(leerDatosDeRegistro(t, { hoy: HOY, fuente: 'chat' }).nombre, t).toBe(NOMBRE);
        }
        for (const [t, n] of [
            ['Sara Torres Díaz cc 1.012.345.678', 'Sara Torres Díaz'], ['Sara Torres Díaz cédula 1012345678', 'Sara Torres Díaz'],
            ['Juan Pablo Rojas CE 554433', 'Juan Pablo Rojas'], ['Tomás Ruiz Peña RC 1099887766', 'Tomás Ruiz Peña'],
            ['Laura Gómez Ruiz documento 1012345678', 'Laura Gómez Ruiz'], ['Laura Gómez Ruiz pasaporte AX12345', 'Laura Gómez Ruiz'],
        ]) expect(nombreDeAsistente(t), t).toBe(n);
        // El pie de la foto: el nombre con su documento sigue siendo SOLO el nombre.
        expect(nombreDeAsistenteEnTextos(['Mariana Isabel la Rotta Robles TI 1034567890'], 'Clínica de armadores')).toBe(NOMBRE);
        // Lo que sigue al documento y no es documento no convierte el texto en «solo un nombre».
        expect(nombreDeAsistente('Carlos Ruiz tarjeta de crédito', { entero: true })).toBeNull();
    });
});

// ─── 2. El bloque de pago no es una pregunta de datos ───────────────────────

describe('2 · «nombre completo de quien asiste» en el cierre del mensaje de pago', () => {
    const pago = BLOQUE_DE_PAGO(CLINICA, 2);

    it('el bloque de pago solo lo MENCIONA; las preguntas de verdad son las de la cola, «ya pagué» y el pedido de datos', () => {
        expect(ultimoSalienteSobreAsistente([pago])).toBe('mencion');
        expect(ultimoSalienteSobreAsistente([sal(1, '¿Cuál es el nombre completo de quien asiste a la *Clínica*?', CLINICA, { step: 'ask_asistente_servicio' })])).toBe('pregunta');
        expect(ultimoSalienteSobreAsistente([sal(1, '¿Es para *Sara Torres*, como la vez pasada?', CLINICA, { step: 'ask_asistente_confirmar' })])).toBe('pregunta');
        expect(ultimoSalienteSobreAsistente([sal(1, TEXTO_YA_PAGO, CLINICA, { step: PASO_VENTA.YA_PAGO })])).toBe('pregunta');
        expect(ultimoSalienteSobreAsistente([sal(1, 'Ya tengo tu comprobante 📄 Para completar…', CLINICA, { step: PASO_VENTA.YA_PAGO, faltan_datos: ['nombre', 'fecha_nacimiento'] })])).toBe('pregunta');
        // El bloque de pago también lleva `faltan_datos`: sigue sin ser una pregunta.
        expect(ultimoSalienteSobreAsistente([{ ...pago, payload: { ...pago.payload, faltan_datos: ['nombre', 'fecha_nacimiento'] } }])).toBe('mencion');
        // Pidió solo la persona responsable: un nombre suelto NO es el de quien asiste.
        expect(ultimoSalienteSobreAsistente([sal(1, 'Solo me falta el nombre de la persona responsable', CLINICA, { step: PASO_VENTA.ASISTENTE, faltan_datos: ['acudiente'] })])).toBeNull();
        expect(ultimoSalienteSobreAsistente([sal(1, 'La clínica es el 21 y 22.', CLINICA, { step: PASO_VENTA.RESPUESTA })])).toBeNull();
    });

    it('dos palabras después del bloque de pago NO son un nombre («Colegio Bilingüe», «Sebastian Suba»)', async () => {
        for (const t of ['Colegio Bilingüe', 'Sebastian Suba', 'Nicolás cubides']) {
            expect(datosDeAsistenteEnVenta(t, [pago]), t).toBeNull();
        }
        const { ctx, reg } = ctxDe({ recientes: [pago] });
        await atenderVentaDeServicio(ctx, venta(CLINICA), 'Colegio Bilingüe');
        expect(reg.anotados).toEqual([]);
        expect(reg.enviados[0].texto).not.toMatch(NO_AFIRMA_GUARDAR);
    });

    it('…salvo que traiga otro dato de registro o una marca', () => {
        expect(datosDeAsistenteEnVenta('Nicolás cubides 18/12/2006', [pago])).toEqual({ nombre: 'Nicolás Cubides' });
        expect(datosDeAsistenteEnVenta('Laura Gómez, 15 años', [pago])).toEqual({ nombre: 'Laura Gómez' });
    });

    it('una marca («la niña», «a nombre de», «mi hijo:») tras el bloque de pago SÍ anota el nombre', async () => {
        for (const [t, n] of [['La niña Laura Gómez', 'Laura Gómez'], ['a nombre de Laura Gómez', 'Laura Gómez'], ['mi hijo: Tomás Ruiz', 'Tomás Ruiz']]) {
            const { ctx, reg } = ctxDe({ recientes: [pago] });
            expect(await atenderVentaDeServicio(ctx, venta(CLINICA), t), t).toBe('venta_asistente');
            expect(reg.anotados, t).toEqual([n]);
        }
    });

    it('con una pregunta de datos de verdad, el nombre de dos palabras sí vale', () => {
        const pregunta = sal(1, TEXTO_YA_PAGO, CLINICA, { step: PASO_VENTA.YA_PAGO });
        expect(datosDeAsistenteEnVenta('Nicolás cubides', [pago, pregunta])).toEqual({ nombre: 'Nicolás Cubides' });
    });

    it('(decisión, ver informe) tras el bloque de pago un nombre FIRME —tres palabras— sigue valiendo: el bloque lo pide', () => {
        expect(datosDeAsistenteEnVenta('Gabriela Reina Fonseca', [pago])).toEqual({ nombre: 'Gabriela Reina Fonseca' });
        expect(datosDeAsistenteEnVenta('María de los Ángeles', [pago])).toBeNull(); // dos palabras: las partículas no cuentan
    });
});

// ─── 3. Más formas de decir el nombre ───────────────────────────────────────

describe('3 · más formas de decir el nombre', () => {
    it('«El nombre de mi hijo: Felipe …» (los dos puntos lo rompían)', async () => {
        const t = 'El nombre de mi hijo: Felipe Andrés Gómez Ruiz';
        expect(leerDatosDeRegistro(t, { hoy: HOY, fuente: 'chat' }).nombre).toBe('Felipe Andrés Gómez Ruiz');
        expect(nombreDeAsistente(t)).toBe('Felipe Andrés Gómez Ruiz');
        expect(nombreDeAsistenteEnTextos([], 'Clínica', [t])).toBe('Felipe Andrés Gómez Ruiz');
        for (const otra of ['Mi hija: Laura Gómez Ruiz', 'La niña: Laura Gómez Ruiz', 'A nombre de: Laura Gómez Ruiz', 'Nombre del niño: Laura Gómez Ruiz']) {
            expect(leerDatosDeRegistro(otra, { hoy: HOY, fuente: 'chat' }).nombre, otra).toBe('Laura Gómez Ruiz');
        }
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(CLINICA)] });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), t)).toBe('venta_asistente');
        expect(reg.anotados).toEqual(['Felipe Andrés Gómez Ruiz']);
    });

    const DOS = 'Jugador 1: VALENTINA RODRIGUEZ PEREZ TI 1034567890\nJugador 2: MARIA ALEJANDRA MORA DIAZ TI 1098765432';
    const NOMBRES = ['Valentina Rodriguez Perez', 'Maria Alejandra Mora Diaz'];

    it('«Jugador 1: … TI … / Jugador 2: … TI …» son DOS personas (y ningún documento en el nombre)', () => {
        expect(nombresDeAsistentesEn(DOS)).toEqual(NOMBRES);
        expect(nombresDeAsistentesEn(DOS.replace('\n', ' / '))).toEqual(NOMBRES);
        expect(leerDatosDeRegistro(DOS, { hoy: HOY, fuente: 'chat' }).nombre).toBeNull();
        // La respuesta a la pregunta de la cola ya no toma a la primera en silencio.
        expect(leerRespuestaDeDatos(DOS, { hoy: HOY }).nombre).toBeNull();
        expect(nombresDeAsistentesEn('Valentina Rodriguez Perez')).toEqual([]);
    });

    it('con el comprobante ya recibido: dice que recibió dos nombres y pregunta de quién es o si son dos cupos (no anota a nadie)', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(CLINICA, 10), FOTO(3)] });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), DOS)).toBe('venta_asistente');
        expect(reg.anotados).toEqual([]);
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toBe('Recibí dos nombres: *Valentina Rodriguez Perez* y *Maria Alejandra Mora Diaz* 🙌 El cupo se paga por persona. '
            + '¿Tu comprobante es de una sola persona (dime de quién) o de los dos cupos?');
        expect(reg.enviados[0].texto).not.toMatch(NO_AFIRMA_GUARDAR);
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.VARIOS_ASISTENTES, asistentes_dichos: NOMBRES });
        expect(reg.preguntas).toEqual([]);
    });

    it('sin comprobante todavía: pregunta si separa dos cupos o uno solo', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(CLINICA, 10)] });
        await atenderVentaDeServicio(ctx, venta(CLINICA), DOS);
        expect(reg.enviados[0].texto).toBe(textoVariosAsistentes(NOMBRES, { pagado: false }));
        expect(reg.enviados[0].texto).toContain('¿Vas a separar dos cupos, o uno solo (dime para quién)?');
    });

    it('la respuesta: «Valentina» → se anota a ESA; «son dos cupos» → a la escuela con los dos nombres', async () => {
        const pregunta = sal(1, textoVariosAsistentes(NOMBRES, { pagado: true }), CLINICA, { step: PASO_VENTA.VARIOS_ASISTENTES, asistentes_dichos: NOMBRES });
        const recientes = [BLOQUE_DE_PAGO(CLINICA, 10), FOTO(3), pregunta];
        expect(elegirEntreNombres('Valentina', NOMBRES)).toBe('Valentina Rodriguez Perez');
        expect(elegirEntreNombres('es para la segunda', NOMBRES)).toBe('Maria Alejandra Mora Diaz');
        expect(elegirEntreNombres('Son dos cupos', NOMBRES)).toBe('todos');
        expect(elegirEntreNombres('para las dos', NOMBRES)).toBe('todos');
        expect(elegirEntreNombres('gracias', NOMBRES)).toBeNull();

        const una = ctxDe({ recientes });
        expect(await atenderVentaDeServicio(una.ctx, venta(CLINICA), 'Valentina')).toBe('venta_asistente');
        expect(una.reg.anotados).toEqual(['Valentina Rodriguez Perez']);

        const dos = ctxDe({ recientes });
        expect(await atenderVentaDeServicio(dos.ctx, venta(CLINICA), 'Son dos cupos')).toBe('venta_a_la_escuela');
        expect(dos.reg.anotados).toEqual([]);
        expect(dos.reg.enviados[0].texto).toBe('Listo 🙌 Le paso a la escuela que son dos cupos: *Valentina Rodriguez Perez* y *Maria Alejandra Mora Diaz*. Te confirma por aquí.');
        expect(dos.reg.avisos[0]).toContain('Valentina Rodriguez Perez, Maria Alejandra Mora Diaz');
    });

    it('la cola (respuesta a «¿Cuál es el nombre completo…?») tampoco elige una en silencio: pregunta y guarda los dos nombres en la fila', async () => {
        const respuestas: any[] = [];
        const fila = { id: 'fila-1', school_id: 's', pregunta_ocr: { venta: { itemId: CLINICA.id, itemNombre: CLINICA.name } } };
        const actualizaciones: any[] = [];
        const { supabase } = await import('../config/supabase');
        (supabase as any).from = () => ({ update: (v: any) => { actualizaciones.push(v); return { eq: () => ({ eq: async () => ({}) }) }; } });
        const consumio = await resolverRespuestaDeAsistente(fila, DOS, async (texto, paso, _b, _l, payload) => { respuestas.push({ texto, paso, payload }); });
        expect(consumio).toBe(true);
        expect(respuestas).toHaveLength(1);
        expect(respuestas[0].texto).toBe(textoVariosAsistentes(NOMBRES, { pagado: true }));
        expect(respuestas[0].payload).toMatchObject({ asistentes_dichos: NOMBRES });
        expect(actualizaciones[0].pregunta_ocr.venta.variosNombres).toEqual(NOMBRES);
    });

    it('dos nombres sin marca en dos líneas, como respuesta al pedido de datos, son quien asiste y su persona responsable', () => {
        const t = 'Sara Torres Díaz\nBrady Luz Pérez';
        expect(nombreYAcudienteEnLineas(t)).toEqual({ nombre: 'Sara Torres Díaz', acudiente: 'Brady Luz Pérez' });
        expect(leerRespuestaDeDatos(t, { hoy: HOY })).toMatchObject({ nombre: 'Sara Torres Díaz', acudiente: 'Brady Luz Pérez' });
        expect(nombreYAcudienteEnLineas(DOS)).toBeNull();
    });

    it('«Me queda mejor en la sede suba, y tengo 14 años nací en 2012»: guarda la edad y pide el nombre', async () => {
        const t = 'Me queda mejor en la sede suba, y tengo 14 años nací en 2012';
        expect(leerDatosDeRegistro(t, { hoy: HOY, fuente: 'chat' })).toMatchObject({ nombre: null, edad: 14, soloEdad: true });
        const { ctx, reg } = ctxDe({ recientes: [sal(30, 'Te comparto la información del vacacional…', VACACIONAL, { step: PASO_VENTA.DETALLES })], ficha: SIN_FICHA });
        expect(await atenderVentaDeServicio(ctx, venta(VACACIONAL), t)).toBe('venta_asistente');
        expect(reg.datos).toEqual([expect.objectContaining({ nombre: null, edad: 14 })]);
        expect(reg.enviados[0].texto).toMatch(/^¡Gracias! 🙌 Guardé ese dato\./);
        expect(reg.enviados[0].texto).toContain('1. Nombre completo');
        expect(reg.enviados[0].contexto).toMatchObject({ faltan_datos: ['nombre', 'fecha_nacimiento', 'acudiente'] });
        expect(reg.preguntas).toEqual([]);
        expect(reg.avisos).toEqual([]);
    });

    it('…pero si la ficha NO se pudo guardar no dice «guardé», y una edad dicha como consulta sigue yendo a la IA', async () => {
        const t = 'Me queda mejor en la sede suba, y tengo 14 años nací en 2012';
        const sinGuardar = ctxDe({ ficha: SIN_FICHA });
        sinGuardar.ctx.anotarDatos = async () => false;
        await atenderVentaDeServicio(sinGuardar.ctx, venta(VACACIONAL), t);
        expect(sinGuardar.reg.enviados[0].texto).not.toMatch(NO_AFIRMA_GUARDAR);
        const consulta = ctxDe({ ficha: SIN_FICHA, ia: { tipo: 'respuesta', texto: 'Es desde los 14 años.' } });
        expect(await atenderVentaDeServicio(consulta.ctx, venta(CLINICA), 'mi hija tiene 12')).toBe('venta_respuesta');
        expect(consulta.reg.datos).toEqual([]);
    });
});

// ─── 4. Elegir semanas o fechas del vacacional ──────────────────────────────

describe('4 · elegir una opción del servicio (semanas o fechas)', () => {
    const FECHAS = '2 semanas: del 23al 27 de noviembre y del 30 de noviembre al 04 de diciembre';
    const RANGOS = 'Del 23 al 27 nov / Del 30 al 04 dic';

    it('las seis frases reales emparejan con la opción', () => {
        expect(opcionElegidaEnVenta('3 semanas', VACACIONAL)).toMatchObject({ clave: '3_semanas', etiqueta: '3 semanas', fechas: null });
        expect(opcionElegidaEnVenta('Pago 2 semanas', VACACIONAL)).toMatchObject({ clave: '2_semanas', fechas: null });
        expect(opcionElegidaEnVenta('Dos semanas la inscribiré', VACACIONAL)).toMatchObject({ clave: '2_semanas' });
        expect(opcionElegidaEnVenta(FECHAS, VACACIONAL)).toEqual({ clave: '2_semanas', etiqueta: '2 semanas', fechas: FECHAS });
        expect(opcionElegidaEnVenta(RANGOS, VACACIONAL)).toEqual({ clave: '2_semanas', etiqueta: '2 semanas', fechas: RANGOS });
        expect(opcionElegidaEnVenta('Una semana', VACACIONAL)).toMatchObject({ clave: '1_semana' });
    });

    it('lo que NO es elegir: una pregunta, un plazo, una opción que no existe, un servicio sin opciones', () => {
        expect(opcionElegidaEnVenta('¿Las 2 semanas pueden ser separadas?', VACACIONAL)).toBeNull();
        expect(opcionElegidaEnVenta('en 2 semanas les pago', VACACIONAL)).toBeNull();
        expect(opcionElegidaEnVenta('6 semanas', VACACIONAL)).toBeNull();
        expect(opcionElegidaEnVenta('2 semanas o 3 semanas', VACACIONAL)).toBeNull();
        expect(opcionElegidaEnVenta('3 semanas', CLINICA)).toBeNull();
        // La edad no estorba: «13 años 6 meses» no es una opción.
        expect(opcionElegidaEnVenta('Comparto soporte pago vacacional 2 semanas\nGabriela Covaleda García\n13 años 6 meses', VACACIONAL)).toMatchObject({ clave: '2_semanas' });
    });

    it('«3 semanas» sin pago todavía: confirma la opción y su valor y OFRECE los datos de pago (no los manda)', async () => {
        const { ctx, reg } = ctxDe({ recientes: [sal(30, 'Te comparto la información del vacacional…', VACACIONAL, { step: PASO_VENTA.DETALLES })], conOpcion: true });
        expect(await atenderVentaDeServicio(ctx, venta(VACACIONAL), '3 semanas')).toBe('venta_respuesta');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toBe('Listo 🙌 *3 semanas* del Vacacional de voleibol — Sede Suba: *$200.000*. ¿Te paso los datos de pago?');
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.OPCION, opcion_elegida: '3_semanas', opcion_etiqueta: '3 semanas', opcion_precio: 200000 });
        expect(reg.opciones).toEqual([{ clave: '3_semanas', etiqueta: '3 semanas', fechas: null, precio: 200000 }]);
        expect(reg.enviados[0].texto).not.toMatch(DERIVADO);
        expect(reg.enviados[0].texto).not.toMatch(NO_AFIRMA_GUARDAR);
        expect(reg.preguntas).toEqual([]);   // ni la IA
        expect(reg.avisos).toEqual([]);      // ni «ya le pasé tu pregunta»
        // «Sí» → ahí sí, el bloque de pago.
        const si = ctxDe({ recientes: [sal(1, reg.enviados[0].texto, VACACIONAL, reg.enviados[0].contexto)] });
        expect(await atenderVentaDeServicio(si.ctx, venta(VACACIONAL), 'Sí')).toBe('venta_pago');
    });

    it('«Dos semanas la inscribiré» con el bloque de pago ya enviado: no lo repite, recuerda el comprobante', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(VACACIONAL, 10)] });
        await atenderVentaDeServicio(ctx, venta(VACACIONAL), 'Dos semanas la inscribiré');
        expect(reg.enviados[0].texto).toBe('Listo 🙌 *2 semanas* del Vacacional de voleibol — Sede Suba: *$140.000*. Cuando hagas el pago, envíame aquí el comprobante.');
        expect(reg.pagos).toBe(0);
    });

    it('«Pago 2 semanas» con el comprobante YA recibido: confirma la opción y NO vuelve a mandar los datos de pago', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(VACACIONAL, 10), FOTO(3)] });
        expect(await atenderVentaDeServicio(ctx, venta(VACACIONAL), 'Pago 2 semanas')).toBe('venta_respuesta');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toBe('Listo 🙌 *2 semanas* del Vacacional de voleibol — Sede Suba: *$140.000*. '
            + 'Ya tengo tu comprobante 📄 La escuela lo valida y te confirma el cupo por aquí.');
        expect(reg.enviados[0].texto).not.toMatch(/Nequi|319|Transfiere|envía aquí la foto/i);
        expect(reg.pagos).toBe(0);
        expect(reg.enviados[0].botones).toBeUndefined();
        expect(reg.avisos[0]).toBe('Eligió «2 semanas» de «Vacacional de voleibol — Sede Suba» ($140.000). Ya envió un comprobante.');
    });

    it('las fechas dichas quedan como nota para la escuela (payload + aviso)', async () => {
        for (const t of [FECHAS, RANGOS]) {
            const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(VACACIONAL, 10), FOTO(3)] });
            expect(await atenderVentaDeServicio(ctx, venta(VACACIONAL), t), t).toBe('venta_respuesta');
            expect(reg.enviados[0].texto, t).toBe('Listo 🙌 *2 semanas* del Vacacional de voleibol — Sede Suba: *$140.000*. '
                + 'Le paso a la escuela las fechas que escribiste. Ya tengo tu comprobante 📄 La escuela lo valida y te confirma el cupo por aquí.');
            expect(reg.enviados[0].contexto).toMatchObject({ opcion_elegida: '2_semanas', fechas_dichas: t });
            expect(reg.avisos[0]).toContain(`Fechas que escribió: «${t}»`);
            expect(reg.enviados[0].texto).not.toBe(TEXTO_A_LA_ESCUELA);
            expect(reg.pagos).toBe(0);
        }
    });

    it('«Pago 2 semanas» y, enseguida, las fechas de esas 2 semanas: la segunda solo acusa las fechas; repetida, silencio', async () => {
        const primera = sal(2, 'Listo 🙌 *2 semanas*…', VACACIONAL, { step: PASO_VENTA.OPCION, opcion_elegida: '2_semanas' });
        const recientes = [BLOQUE_DE_PAGO(VACACIONAL, 10), FOTO(3), primera];
        const conFechas = ctxDe({ recientes });
        expect(await atenderVentaDeServicio(conFechas.ctx, venta(VACACIONAL), FECHAS)).toBe('venta_respuesta');
        expect(conFechas.reg.enviados[0].texto).toBe('Listo 🙌 Le paso a la escuela las fechas que escribiste.');
        expect(conFechas.reg.avisos).toHaveLength(1);
        const repetida = ctxDe({ recientes });
        expect(await atenderVentaDeServicio(repetida.ctx, venta(VACACIONAL), '2 semanas')).toBe('venta_silencio');
        expect(repetida.reg.enviados).toEqual([]);
    });

    it('«quiero pagar 2 semanas» sin comprobante: el bloque de pago de siempre, con la opción anotada en el payload', async () => {
        const { ctx, reg } = ctxDe();
        expect(await atenderVentaDeServicio(ctx, venta(VACACIONAL), 'quiero pagar 2 semanas')).toBe('venta_pago');
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.PAGO, opcion_elegida: '2_semanas' });
    });

    it('el texto: con valor, sin valor y sin prometer cupo', () => {
        const t = textoOpcionElegida(VACACIONAL, { etiqueta: '2 semanas', precio: null, conFechas: false, pagado: false, conDatosDePago: false });
        expect(t).toBe('Listo 🙌 *2 semanas* del Vacacional de voleibol — Sede Suba. ¿Te paso los datos de pago?');
        expect(t).not.toMatch(/cupo (confirmado|asegurado|reservado)/i);
    });
});

// ─── 5. «Ya pagué» en más formas ────────────────────────────────────────────

describe('5 · «ya pagué» en más formas', () => {
    it.each([
        'Pero, ya lo mandé', 'ya lo envié', 'ya la pasé', 'ya lo adjunté', 'ya lo subí', 'Es que yo aboné antes del 10 de noviembre',
        'ya consigné', 'ya transferí', 'ya hice el pago', 'Ya se lo envié', 'yo ya pagué',
    ])('«%s» → ya_pago', (t) => expect(intencionEnVenta(t)).toBe('ya_pago'));

    it('lo que NO es «ya pagué»', () => {
        for (const t of ['¿Quiere que yo abone primero?', 'para que yo pague necesito la cuenta', 'Pagué 2 semanas', 'ya lo pienso', 'ya la vi gracias']) {
            expect(intencionEnVenta(t), t).not.toBe('ya_pago');
        }
    });

    it('«Pero, ya lo mandé» con la foto ya recibida: no se le pide el comprobante otra vez', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(CLINICA, 10), FOTO(3)] });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), 'Pero, ya lo mandé')).toBe('venta_ya_pago');
        expect(reg.enviados[0].texto).toBe('Ya tenemos tu comprobante 📄 La escuela lo valida y te confirma el cupo por aquí.');
        expect(reg.preguntas).toEqual([]);
    });
});

// ─── 6. Saludos con vocativo, anuncios de pregunta y cierres ────────────────

describe('6 · saludos, anuncios de pregunta y cierres que terminaban en «Ya le pasé tu pregunta»', () => {
    it('intención de las frases reales', () => {
        expect(intencionEnVenta('Hola Felipe buenos días')).toBe('saludo');
        expect(intencionEnVenta('Profe una pregunta')).toBe('anuncio');
        expect(intencionEnVenta('Hueno')).toBe('cierre');
        expect(intencionEnVenta('Gracias de todas formas')).toBe('cierre');
        expect(intencionEnVenta('Listo profe yo les digo')).toBe('cierre');
        expect(intencionEnVenta('Seria?')).toBe('anuncio');
        expect(intencionEnVenta('Me puedes confirmar')).toBe('anuncio');
    });

    it('parecidas', () => {
        for (const t of ['Buenas tardes profe', 'Hola señora Milena', 'Hola profe', 'Buenos días Iván']) expect(intencionEnVenta(t), t).toBe('saludo');
        for (const t of ['Hola, una consulta', 'Disculpa', 'Tengo una duda', 'me puedes ayudar por favor', 'Profe']) expect(intencionEnVenta(t), t).toBe('anuncio');
        for (const t of ['Bueno', 'Listo, yo te aviso', 'Gracias de todos modos', 'Ok luego les escribo', 'Dale yo les cuento']) expect(intencionEnVenta(t), t).toBe('cierre');
    });

    it('un saludo con una PREGUNTA o un pedido adentro no se queda en saludo', () => {
        expect(intencionEnVenta('Hola precio')).toBe('pago');
        expect(intencionEnVenta('Buenas tardes horario')).toBe('detalle');
        expect(intencionEnVenta('Hola Felipe, ¿a qué hora es?')).toBe('detalle');
        expect(intencionEnVenta('Me puedes confirmar el horario')).toBe('detalle');
        expect(intencionEnVenta('Profe una pregunta, ¿hay parqueadero?')).toBe('detalle');
        expect(intencionEnVenta('Dale')).toBe('pago');
        expect(intencionEnVenta('porfa')).toBe('pago');
    });

    it('ninguna se deriva a la escuela: saludo → la línea del servicio; anuncio → «Claro, dime»; cierre → silencio', async () => {
        const casos: [string, string | null][] = [
            ['Hola Felipe buenos días', '¿Te ayudo con algo de la Clínica de armadores y atacantes? Si quieres separar tu cupo, te paso los datos.'],
            ['Profe una pregunta', TEXTO_DIME], ['Seria?', TEXTO_DIME], ['Me puedes confirmar', TEXTO_DIME],
            ['Hueno', null], ['Gracias de todas formas', null], ['Listo profe yo les digo', null],
        ];
        for (const [t, esperado] of casos) {
            const { ctx, reg } = ctxDe({ recientes: [sal(40, 'Te comparto la información de la clínica…', CLINICA, { step: PASO_VENTA.DETALLES })] });
            const r = await atenderVentaDeServicio(ctx, venta(CLINICA), t);
            expect(reg.enviados.map((e) => e.texto), t).toEqual(esperado ? [esperado] : []);
            expect(r, t).toBe(esperado ? 'venta_saludo' : 'venta_silencio');
            expect(reg.avisos, t).toEqual([]);       // ningún aviso a la escuela
            expect(reg.preguntas, t).toEqual([]);    // ni la IA
            for (const e of reg.enviados) expect(e.texto, t).not.toMatch(DERIVADO);
        }
        expect(TEXTO_DIME).toBe('Claro, dime 🙌');
    });

    it('con el comprobante ya enviado, el saludo es «¡Hola! 👋 Cuéntame.» (no se le ofrece separar el cupo otra vez)', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(CLINICA, 30), FOTO(20)] });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), 'Hola Felipe buenos días')).toBe('venta_saludo');
        expect(reg.enviados).toEqual([expect.objectContaining({ texto: TEXTO_HOLA_CUENTAME, botones: undefined })]);
        expect(TEXTO_HOLA_CUENTAME).toBe('¡Hola! 👋 Cuéntame.');
    });

    it('dos anuncios seguidos: un solo «Claro, dime»', async () => {
        const { ctx, reg } = ctxDe({ recientes: [sal(2, TEXTO_DIME, CLINICA, { step: PASO_VENTA.DIME })] });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), 'Profe una pregunta')).toBe('venta_silencio');
        expect(reg.enviados).toEqual([]);
    });
});

// ─── 7. Desiste ─────────────────────────────────────────────────────────────

describe('7 · desiste', () => {
    const FRASES = ['Estoy en otra ciudad', 'Lo siento es que yo estoy ubicada en cartagena', 'no puedo', 'no me queda'];

    it.each(FRASES)('«%s» → desiste: cierre amable, sin derivar ni insistir', async (t) => {
        expect(intencionEnVenta(t)).toBe('desiste');
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(CLINICA, 10)] });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), t)).toBe('venta_respuesta');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toBe('Entiendo, gracias por avisarme 🙌 Si más adelante te animas, aquí estamos.');
        expect(reg.enviados[0].texto).toBe(TEXTO_DESISTE);
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.DESISTE, desiste: true });
        expect(reg.enviados[0].botones).toBeUndefined();   // sin [Separar mi cupo]
        expect(reg.avisos).toEqual([]);
        expect(reg.preguntas).toEqual([]);
        expect(reg.pagos).toBe(0);
    });

    it('otras formas, y lo que NO es desistir', () => {
        for (const t of ['No me interesa', 'no gracias', 'Me queda muy lejos', 'Ya no puedo', 'vivo fuera de Bogotá', 'será en otra ocasión']) {
            expect(intencionEnVenta(t), t).toBe('desiste');
        }
        expect(intencionEnVenta('no puedo ese día')).toBe('otra_fecha');
        expect(intencionEnVenta('sí me interesa')).toBe('pago');
        expect(intencionEnVenta('no me queda claro el horario')).toBe('detalle');
        expect(intencionEnVenta('No puedo pagar todo, ¿puedo abonar?')).toBe('pago');
        expect(intencionEnVenta('Aún no tengo posición')).toBe('detalle');
    });

    it('dos veces seguidas: una sola respuesta; y el seguimiento de 20 h ya no le insiste', async () => {
        const dicho = sal(5, TEXTO_DESISTE, CLINICA, { step: PASO_VENTA.DESISTE, desiste: true });
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(CLINICA, 10), dicho] });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), 'no puedo')).toBe('venta_silencio');
        expect(reg.enviados).toEqual([]);
        expect(textoSeguimientoDeVenta(CLINICA, { recientes: [BLOQUE_DE_PAGO(CLINICA, 10), dicho], afiliado: false, hoy: HOY, ahora: AHORA.getTime() })).toBeNull();
        // Sin el desistimiento, el seguimiento sigue saliendo.
        expect(textoSeguimientoDeVenta(CLINICA, { recientes: [BLOQUE_DE_PAGO(CLINICA, 10)], afiliado: false, hoy: HOY, ahora: AHORA.getTime() })).toContain('¿Pudiste hacer el pago');
    });

    it('si ya había enviado un comprobante, eso sí lo resuelve la escuela', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(CLINICA, 30), FOTO(20)] });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), 'Estoy en otra ciudad')).toBe('venta_a_la_escuela');
        expect(reg.enviados[0].texto).toBe(TEXTO_DESISTE_CON_PAGO);
        expect(reg.avisos).toHaveLength(1);
    });
});

// ─── 8. La llave / Bre-B ────────────────────────────────────────────────────

describe('8 · pregunta por la llave / Bre-B con el bloque de pago recién enviado', () => {
    const FRASES = ['Es una llave? Puedo pagar por breb?', 'Disculpa ese tiene llave ?', 'Para transferir por bre b'];

    it.each(FRASES)('«%s» con una llave cargada: respuesta corta con la llave, sin repetir el bloque', async (t) => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(CLINICA, 4)], cuentas: CON_LLAVE });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), t)).toBe('venta_respuesta');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toBe('Sí 🙌 Puedes pagar por llave (Bre-B): *@monstervolley*, a nombre de Iván Sossa.');
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.LLAVE });
        expect(reg.pagos).toBe(0);
        expect(reg.avisos).toEqual([]);
    });

    it.each(FRASES)('«%s» sin llave cargada: dice lo que sí tiene (la cuenta) y deriva SOLO lo de la llave', async (t) => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(CLINICA, 4)], cuentas: NEQUI });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), t)).toBe('venta_respuesta');
        expect(reg.enviados[0].texto).toBe('Los datos de pago que tengo son los que te envié: por Nequi o Daviplata al 319 450 5150, a nombre de Iván Sossa. '
            + 'Si reciben por llave (Bre-B) te lo confirma la escuela por aquí 🙌');
        expect(reg.enviados[0].texto).not.toMatch(/Para separar tu cupo|Valor hoy|abono mínimo/);
        expect(reg.pagos).toBe(0);
        expect(reg.avisos).toHaveLength(1);
        expect(reg.avisos[0]).toContain('llave (Bre-B)');
    });

    it('sin ninguna cuenta cargada: lo dice y deriva', async () => {
        expect(textoDeLlave([])).toEqual({ texto: TEXTO_LLAVE_SIN_DATO, confirmaLaEscuela: true });
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(CLINICA, 4)], cuentas: [] });
        await atenderVentaDeServicio(ctx, venta(CLINICA), 'Disculpa ese tiene llave ?');
        expect(reg.enviados[0].texto).toBe('No tengo ese dato 🙌 Ya le pasé tu pregunta a la escuela y te responde por aquí.');
        expect(reg.avisos).toHaveLength(1);
    });

    it('si el bloque de pago NO ha salido (o salió hace horas), va el bloque completo como siempre', async () => {
        for (const recientes of [[], [BLOQUE_DE_PAGO(CLINICA, 300)]]) {
            const { ctx, reg } = ctxDe({ recientes, cuentas: NEQUI });
            expect(await atenderVentaDeServicio(ctx, venta(CLINICA), 'Para transferir por bre b')).toBe('venta_pago');
            expect(reg.pagos).toBe(1);
        }
    });

    it('si además pregunta el valor, va el bloque completo', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE_DE_PAGO(CLINICA, 4)], cuentas: NEQUI });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), '¿Cuánto es y es por llave?')).toBe('venta_pago');
        expect(reg.pagos).toBe(1);
    });
});

// ─── 9. La IA del servicio: respuesta parcial antes de derivar ──────────────

describe('9 · la IA del servicio contesta lo que SÍ está antes de derivar', () => {
    beforeEach(() => llm.chatWithTools.mockReset());
    const pregunta = (texto: string): PreguntaDeServicio => ({
        schoolId: 's', conversationId: 'c', item: CLINICA, pregunta: texto, recientes: [], afiliado: false, cuentas: NEQUI, hoy: HOY,
    });

    it('el prompt pide la respuesta parcial con «FALTA:» y NO_SE solo cuando no hay nada', () => {
        const s = promptDeServicio(pregunta('x'));
        expect(s).toContain('RESPUESTA PARCIAL');
        expect(s).toContain('contesta primero esa parte con lo que SÍ está escrito');
        expect(s).toContain('«FALTA:»');
        expect(s).toContain('No rellenes lo que falta con suposiciones');
        // Lo de siempre sigue ahí: no inventar.
        expect(s).toContain('responde únicamente: NO_SE');
        expect(s).toContain('PERMISOS Y EXCEPCIONES: no los concedes ni los niegas');
    });

    it('separarFalta', () => {
        expect(separarFalta('Es en el Colegio Bilingüe La Enseñanza.\nFALTA: si hay parqueadero'))
            .toEqual({ texto: 'Es en el Colegio Bilingüe La Enseñanza.', pendiente: 'si hay parqueadero' });
        expect(separarFalta('Es en el Colegio. FALTA: la dirección exacta.')).toEqual({ texto: 'Es en el Colegio.', pendiente: 'la dirección exacta' });
        expect(separarFalta('Es de 9:00 a. m. a 3:00 p. m.')).toEqual({ texto: 'Es de 9:00 a. m. a 3:00 p. m.', pendiente: null });
        expect(separarFalta('FALTA: todo')).toEqual({ texto: '', pendiente: 'todo' });
        // «falta» dentro de una frase normal no es la marca.
        expect(separarFalta('Solo falta: el comprobante.').pendiente).toBeNull();
    });

    it('«¿Dónde es y hay parqueadero?»: sale el lugar (que sí está) y queda pendiente el parqueadero', async () => {
        llm.chatWithTools.mockResolvedValueOnce({ text: 'Es en el *Colegio Bilingüe La Enseñanza*, de 9:00 a. m. a 3:00 p. m.\nFALTA: si hay parqueadero' });
        const r = await responderPreguntaDeServicio(pregunta('¿Dónde es y hay parqueadero?'));
        expect(r).toEqual({ tipo: 'respuesta', texto: 'Es en el *Colegio Bilingüe La Enseñanza*, de 9:00 a. m. a 3:00 p. m.', pendiente: 'si hay parqueadero' });
        expect(llm.chatWithTools.mock.calls[0][0].messages[0].content).toContain('Si solo está una parte, responde esa parte');
    });

    it('si no hay NADA (o solo viene la marca), sigue siendo no_se; un monto inventado en la parte parcial tampoco sale', async () => {
        llm.chatWithTools.mockResolvedValueOnce({ text: 'NO_SE' });
        expect(await responderPreguntaDeServicio(pregunta('¿Hay parqueadero?'))).toEqual({ tipo: 'no_se', motivo: 'no_esta_en_los_datos' });
        llm.chatWithTools.mockResolvedValueOnce({ text: 'FALTA: si hay parqueadero' });
        expect(await responderPreguntaDeServicio(pregunta('¿Hay parqueadero?'))).toEqual({ tipo: 'no_se', motivo: 'no_esta_en_los_datos' });
        llm.chatWithTools.mockResolvedValue({ text: 'El saldo de *$999.000* se paga después.\nFALTA: hasta cuándo' });
        expect((await responderPreguntaDeServicio(pregunta('¿Hasta cuándo pago el saldo?'))).tipo).toBe('no_se');
    });

    it('en la venta: manda la parte que sí está, dice que lo demás lo confirma la escuela y le avisa QUÉ falta', async () => {
        const { ctx, reg } = ctxDe({ ia: { tipo: 'respuesta', texto: 'Es en el *Colegio Bilingüe La Enseñanza*.', pendiente: 'si hay parqueadero' } });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), '¿Dónde es y hay parqueadero?')).toBe('venta_respuesta');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toBe(`Es en el *Colegio Bilingüe La Enseñanza*.\n\n${TEXTO_LO_DEMAS_LA_ESCUELA}`);
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.RESPUESTA, respuesta_parcial: true, falta_en_los_datos: 'si hay parqueadero' });
        expect(reg.avisos).toEqual(['Pregunta sobre «Clínica de armadores y atacantes» que el asistente contestó a medias. '
            + 'Falta en los datos: si hay parqueadero. Preguntó: «¿Dónde es y hay parqueadero?».']);
    });

    it('una respuesta completa sigue saliendo sola, sin aviso', async () => {
        const { ctx, reg } = ctxDe({ ia: { tipo: 'respuesta', texto: 'Es en el *Colegio Bilingüe La Enseñanza*.' } });
        await atenderVentaDeServicio(ctx, venta(CLINICA), '¿Dónde es?');
        expect(reg.enviados[0].texto).toBe('Es en el *Colegio Bilingüe La Enseñanza*.');
        expect(reg.avisos).toEqual([]);
    });
});

// ─── 10. «Hola buenas. Interesadísimas en la clínica.» ──────────────────────

describe('10 · «Hola buenas. Interesadísimas en la clínica.\\nGabriela Covaleda García\\n13 años»', () => {
    const MENSAJE = 'Hola buenas. Interesadísimas en la clínica.\nGabriela Covaleda García\n13 años';

    it('el módulo de datos ya lo resuelve: nombre y edad («Interesadísimas En» ya no es candidato)', () => {
        expect(leerDatosDeRegistro(MENSAJE, { hoy: HOY, fuente: 'chat' })).toEqual({
            nombre: 'Gabriela Covaleda García', fechaNacimiento: null, edad: 13, soloEdad: true, acudiente: null, posicion: null,
        });
        expect(nombreDeAsistente('Interesadísimas en la clínica.')).toBeNull();
        expect(nombreDeAsistente('Interesada en el vacacional')).toBeNull();
        expect(nombresDeAsistentesEn(MENSAJE)).toEqual([]);
    });

    it('en la venta: se anota a Gabriela con su edad', async () => {
        const { ctx, reg } = ctxDe({ recientes: [sal(30, 'Te comparto la información de la clínica…', CLINICA, { step: PASO_VENTA.DETALLES })] });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), MENSAJE)).toBe('venta_asistente');
        expect(reg.anotados).toEqual(['Gabriela Covaleda García']);
        expect(reg.datos[0]).toMatchObject({ nombre: 'Gabriela Covaleda García', edad: 13 });
    });
});
