/**
 * Clase de prueba CERRADA por la escuela (bot-ofertas.service). Monster's Volley, 2026-11-25: en
 * diciembre y enero no hay clases de prueba, llega gente por las CONVOCATORIAS y el bot les ofrecía la
 * clase. El flujo de cortesía ya no la ofrece ni la agenda: contesta con las ofertas vigentes (filtradas
 * por el género que nombren), o con el mensaje de la escuela, o con uno neutro, y deja la conversación
 * para la escuela. Una franja en un día bloqueado no se ofrece aunque HOY la clase esté abierta.
 * Con la clase abierta y sin bloqueos ni ofertas: todo exactamente igual que antes.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./avisos-correo.service', () => ({ destinatariosDeEscuela: vi.fn(), enviarConReserva: vi.fn() }));

import {
    atenderTurnoCortesia, iniciarCortesia, ofrecerHorariosDeCortesia, BOTON_CC, PASO_SIN_CLASE_DE_PRUEBA,
    preguntaPorConvocatoria, franjasPermitidas, textoSinClaseDePrueba, textoParaConvocatoria,
    type CtxCortesia, type EstadoCortesia, type FranjaCortesia, type ReservaVigente,
} from './whatsapp-clase-cortesia.service';
import { armarEstado, type EstadoOfertas, type FilasCrudas } from './bot-ofertas.service';
import { textosDeClase, TEXTOS_POR_DEFECTO } from './textos-clase-prueba';
import { mensajeSemanaDeCortesia } from './whatsapp-cortesia-semana.service';

// 2 de diciembre de 2026, 10:00 a. m. en Bogotá: dentro del bloqueo.
const DIC = new Date('2026-12-02T15:00:00Z');
// 26 de noviembre de 2026, 10:00 a. m. en Bogotá: la clase está abierta, el bloqueo empieza el 1-dic.
const NOV = new Date('2026-11-26T15:00:00Z');

const MONSTER = textosDeClase({ nombre_clase: 'prueba', trial_price: 15000 });
const CTA = 'Para inscribirte escríbenos el nombre completo del deportista, su fecha de nacimiento y la convocatoria.';

const OFERTAS = [
    {
        id: 'o-mayores', tipo: 'convocatoria', titulo: 'Convocatorias equipos mayores — Superliga', sede: 'Sede Norte',
        publico: 'Equipos mayores de competencia', estado: 'activa', vigente_desde: '2026-11-25', vigente_hasta: '2026-12-11',
        prioridad: 20, requiere_inscripcion: true, cta: CTA,
    },
    {
        id: 'o-suba', tipo: 'convocatoria', titulo: 'Convocatorias Sede Suba', sede: 'Sede Suba', genero: 'mixto',
        estado: 'activa', vigente_desde: '2026-11-25', vigente_hasta: '2026-12-13', prioridad: 10, requiere_inscripcion: true, cta: CTA,
    },
];
const SESIONES = [
    { id: 's1', oferta_id: 'o-mayores', fecha: '2026-12-09', hora_inicio: '19:00:00', hora_fin: '21:00:00', lugar: 'ECCI', genero: 'femenino' },
    { id: 's2', oferta_id: 'o-mayores', fecha: '2026-12-09', hora_inicio: '20:00:00', hora_fin: '22:00:00', lugar: 'ECCI', genero: 'masculino' },
    { id: 's3', oferta_id: 'o-suba', fecha: '2026-12-05', hora_inicio: '07:00:00', hora_fin: null, lugar: 'Parque Pinar de Suba', genero: 'mixto', publico: 'Nacidos 2015 y 2016' },
];
const BLOQUEO = { tipo: 'clase_prueba', desde: '2026-12-01', hasta: '2027-01-31', motivo: 'Diciembre y enero sin clases de prueba' };

const filas = (over: Partial<FilasCrudas> = {}): FilasCrudas => ({
    ofertas: OFERTAS, sesiones: SESIONES, bloqueos: [BLOQUEO], ajustesClasePrueba: null, mensajeSinOfertas: null, ...over,
});
const estado = (f: FilasCrudas, ahora: Date): EstadoOfertas => armarEstado('monster', f, ahora.getTime());
/** Escuela de siempre: sin bloqueos, sin ofertas, sin ajustes. */
const ABIERTA = (ahora: Date) => estado({ ofertas: [], sesiones: [], bloqueos: [], ajustesClasePrueba: null, mensajeSinOfertas: null }, ahora);

const F = (id: string, fecha: string, hora = '09:00', grupo = 'Sub-15'): FranjaCortesia => ({
    id, grupo, fecha, horaInicio: hora, horaFin: '10:30', sede: 'Sede Norte', cupos: 5,
});

interface Enviado { texto: string; step: string; estado: EstadoCortesia | null; botones?: any[] }

function armar(op: {
    ahora: Date;
    ofertas: EstadoOfertas;
    franjas?: FranjaCortesia[];
    inicial?: EstadoCortesia | null;
    reserva?: ReservaVigente | null;
    textos?: typeof MONSTER;
}) {
    const enviados: Enviado[] = [];
    let flujo: EstadoCortesia | null = op.inicial ?? null;
    const franjas = vi.fn(async () => op.franjas ?? []);
    const reservar = vi.fn(async () => ({ ok: true as const, leadId: 'lead-1', duplicado: false, conCupo: true }));
    const cancelar = vi.fn(async () => ({ ok: true as const, franja: null }));
    const dejarPendiente = vi.fn(async () => {});
    const alSoltar = vi.fn();
    const ctx: CtxCortesia = {
        conversationId: 'conv-1', schoolId: 'monster', contactWaId: '573001112233',
        enviar: async (texto, step, est, botones) => { enviados.push({ texto, step, estado: est, botones }); flujo = est; },
        leerEstado: async () => flujo,
        franjas,
        reservaVigente: async () => op.reserva ?? null,
        reservar,
        cancelar,
        avisarEscuela: vi.fn(async () => {}),
        indicaciones: async () => null,
        rangos: async () => [],
        textos: async () => op.textos ?? MONSTER,
        ofertas: async () => op.ofertas,
        dejarPendiente,
        alSoltar,
        ahora: () => op.ahora,
    };
    return { ctx, enviados, franjas, reservar, cancelar, dejarPendiente, alSoltar };
}

describe('diciembre: la clase de prueba está bloqueada', () => {
    it('«Quiero una clase de prueba para mi niña» → no la ofrece: lo dice, da las convocatorias femeninas y queda para la escuela', async () => {
        const t = armar({ ahora: DIC, ofertas: estado(filas(), DIC), franjas: [F('dic', '2026-12-05')] });
        const atendido = await atenderTurnoCortesia(t.ctx, 'Quiero una clase de prueba para mi niña', null);

        expect(atendido).toBe(true);
        expect(t.enviados).toHaveLength(1);
        const m = t.enviados[0];
        expect(m.step).toBe(PASO_SIN_CLASE_DE_PRUEBA);
        expect(m.estado).toBeNull();
        expect(m.botones).toBeUndefined();
        expect(m.texto).toContain('Por ahora no tenemos clases de prueba (vuelven el lunes 1 de febrero de 2027)');
        expect(m.texto).toContain('*Convocatorias equipos mayores — Superliga*');
        expect(m.texto).toContain('miércoles 9 de diciembre, 7:00 a 9:00 p. m.');
        expect(m.texto).not.toContain('8:00 a 10:00 p. m.');          // la sesión masculina no
        expect(m.texto).toContain('*Convocatorias Sede Suba*');         // la mixta sí
        expect(m.texto).toContain(CTA);
        expect(m.texto).not.toMatch(/te reservo|dejar(me)? (mis|tus) datos|\$15\.000|gratis|horarios de/i);
        expect(t.franjas).not.toHaveBeenCalled();
        expect(t.reservar).not.toHaveBeenCalled();
        expect(t.dejarPendiente).toHaveBeenCalledTimes(1);
    });

    it('iniciarCortesia (tool get_trial_class_info, puerta «Clase de cortesía») con encabezado → mismo mensaje, sin agendar', async () => {
        const t = armar({ ahora: DIC, ofertas: estado(filas(), DIC), franjas: [F('dic', '2026-12-05')] });
        await iniciarCortesia(t.ctx, { encabezado: 'Hola 👋', step: 'desconocido_tema_escolar', texto: 'clase de prueba' });
        expect(t.enviados).toHaveLength(1);
        expect(t.enviados[0].texto.startsWith('Hola 👋\n\nPor ahora no tenemos clases de prueba')).toBe(true);
        expect(t.enviados[0].step).toBe('desconocido_tema_escolar');
        expect(t.enviados[0].estado).toBeNull();
    });

    it('la secuencia de la tool get_trial_class_info (turno sin iniciar → iniciarCortesia) no agenda', async () => {
        const t = armar({ ahora: DIC, ofertas: estado(filas(), DIC), franjas: [F('dic', '2026-12-05')] });
        expect(await atenderTurnoCortesia(t.ctx, 'Mi sobrino quiere probar', null, { iniciar: false })).toBe(false);
        await iniciarCortesia(t.ctx, { texto: 'Mi sobrino quiere probar' });
        expect(t.enviados).toHaveLength(1);
        expect(t.enviados[0].step).toBe(PASO_SIN_CLASE_DE_PRUEBA);
        expect(t.enviados[0].texto).toContain('Por ahora no tenemos clases de prueba (vuelven el lunes 1 de febrero de 2027)');
        expect(t.reservar).not.toHaveBeenCalled();
        expect(t.franjas).not.toHaveBeenCalled();
    });

    it('sin ofertas y con el mensaje de la escuela → ese mensaje, tal cual', async () => {
        const msg = 'En diciembre no tenemos clases de prueba. Te escribimos en enero con las fechas.';
        const t = armar({ ahora: DIC, ofertas: estado(filas({ ofertas: [], sesiones: [], mensajeSinOfertas: msg }), DIC) });
        await atenderTurnoCortesia(t.ctx, 'clase de prueba', null);
        expect(t.enviados[0].texto).toBe(msg);
    });

    it('sin ofertas ni mensaje → neutro con la fecha de regreso', async () => {
        const t = armar({ ahora: DIC, ofertas: estado(filas({ ofertas: [], sesiones: [] }), DIC) });
        await atenderTurnoCortesia(t.ctx, 'clase de prueba', null);
        expect(t.enviados[0].texto).toBe(
            'Por ahora no tenemos clases de prueba (vuelven el lunes 1 de febrero de 2027); la escuela te escribe con las próximas fechas.');
    });

    it('botón VIEJO de una franja (sm_cc_f:…) tocado en diciembre → no reserva ni pide datos', async () => {
        const t = armar({ ahora: DIC, ofertas: estado(filas(), DIC), franjas: [F('nov', '2026-12-05')] });
        await atenderTurnoCortesia(t.ctx, '1. Sub-15', `${BOTON_CC.FRANJA}nov`);
        expect(t.reservar).not.toHaveBeenCalled();
        expect(t.enviados).toHaveLength(1);
        expect(t.enviados[0].step).toBe(PASO_SIN_CLASE_DE_PRUEBA);
        expect(t.enviados[0].estado).toBeNull();
    });

    it('«Sí, dejar mis datos» de un mensaje viejo → tampoco sigue el agendamiento', async () => {
        const t = armar({ ahora: DIC, ofertas: estado(filas(), DIC) });
        await atenderTurnoCortesia(t.ctx, 'Sí, dejar mis datos', BOTON_CC.DATOS_SI);
        expect(t.enviados[0].step).toBe(PASO_SIN_CLASE_DE_PRUEBA);
        expect(t.enviados[0].estado).toBeNull();
        expect(t.enviados[0].texto).not.toContain('¿Cuál es el *nombre completo*');
    });

    it('agendamiento a medias cuando empieza el bloqueo: «Confirmar» NO reserva', async () => {
        const franja = F('nov', '2026-11-30');
        const t = armar({
            ahora: DIC, ofertas: estado(filas(), DIC),
            inicial: { paso: 'confirmar', datos: { franja, nombre: 'Sara Gómez', edad: 12, acudiente: 'Ana Gómez' } },
        });
        await atenderTurnoCortesia(t.ctx, 'Confirmar', BOTON_CC.CONFIRMAR);
        expect(t.reservar).not.toHaveBeenCalled();
        expect(t.enviados[0].step).toBe(PASO_SIN_CLASE_DE_PRUEBA);
        expect(t.enviados[0].estado).toBeNull();
    });

    it('agendamiento a medias + una pregunta de otra cosa → suelta el turno SIN recordar el paso después', async () => {
        const t = armar({
            ahora: DIC, ofertas: estado(filas(), DIC),
            inicial: { paso: 'nombre', datos: { franja: F('nov', '2026-11-30') } },
        });
        const atendido = await atenderTurnoCortesia(t.ctx, '¿Cuánto vale la mensualidad para el grupo de las niñas?', null);
        expect(atendido).toBe(false);
        expect(t.enviados).toHaveLength(0);
        expect(t.alSoltar).not.toHaveBeenCalled();
    });

    it('«Cancelar mi clase» con una reserva sigue funcionando en el bloqueo', async () => {
        const reserva: ReservaVigente = { leadId: 'l-1', nombre: 'Sara Gómez', franja: F('dic', '2026-12-05') };
        const t = armar({ ahora: DIC, ofertas: estado(filas(), DIC), reserva });
        await atenderTurnoCortesia(t.ctx, 'Cancelar mi clase', BOTON_CC.CANCELAR);
        expect(t.enviados[0].step).toBe('cortesia_confirmar_cancelacion');
        await atenderTurnoCortesia(t.ctx, 'Sí, cancelar', BOTON_CC.CANCELAR_SI);
        expect(t.cancelar).toHaveBeenCalledTimes(1);
        expect(t.enviados[1].step).toBe('cortesia_cancelada');
    });

    it('ofrecerHorariosDeCortesia → false (quien llama contesta otra cosa)', async () => {
        const t = armar({ ahora: DIC, ofertas: estado(filas(), DIC), franjas: [F('dic', '2026-12-05')] });
        expect(await ofrecerHorariosDeCortesia(t.ctx, { texto: 'horarios', intro: 'x', step: 'y' })).toBe(false);
        expect(t.enviados).toHaveLength(0);
    });

    it('interruptor de WhatsApp apagado (sin bloqueos) → tampoco se ofrece; neutro y sin fecha', async () => {
        const apagada = estado({ ofertas: [], sesiones: [], bloqueos: [], ajustesClasePrueba: { whatsapp_enabled: false }, mensajeSinOfertas: null }, NOV);
        const t = armar({ ahora: NOV, ofertas: apagada, franjas: [F('nov', '2026-11-28')], textos: TEXTOS_POR_DEFECTO });
        await atenderTurnoCortesia(t.ctx, 'Clase de cortesía tienen', null);
        expect(t.enviados[0].texto).toBe('Por ahora no tenemos clases de cortesía; la escuela te escribe con las próximas fechas.');
        expect(t.reservar).not.toHaveBeenCalled();
    });
});

describe('26 de noviembre: la clase está abierta pero diciembre no', () => {
    it('solo se ofrecen las franjas ANTES del 1-dic (la del 5-dic no sale)', async () => {
        const t = armar({
            ahora: NOV, ofertas: estado(filas(), NOV),
            franjas: [F('nov', '2026-11-28'), F('dic', '2026-12-05'), F('ene', '2027-01-09')],
        });
        await iniciarCortesia(t.ctx, { texto: 'clase de prueba' });
        expect(t.enviados).toHaveLength(1);
        expect(t.enviados[0].botones?.map((b: any) => b.id)).toEqual([`${BOTON_CC.FRANJA}nov`]);
        expect(t.enviados[0].estado?.datos.lista).toEqual(['nov']);
        expect(t.enviados[0].texto).not.toMatch(/diciembre|enero/);
    });

    it('elegir la franja del 5-dic con un botón viejo → «ya no está disponible» y se ofrece la de noviembre', async () => {
        const t = armar({ ahora: NOV, ofertas: estado(filas(), NOV), franjas: [F('nov', '2026-11-28'), F('dic', '2026-12-05')] });
        await atenderTurnoCortesia(t.ctx, '2. Sub-15', `${BOTON_CC.FRANJA}dic`);
        expect(t.enviados[0].texto).toContain('ya no está disponible');
        expect(t.enviados[0].botones?.map((b: any) => b.id)).toEqual([`${BOTON_CC.FRANJA}nov`]);
    });

    it('solo hay franjas en diciembre → no se ofrecen (sin franjas: lo de siempre, dejar datos)', async () => {
        const t = armar({ ahora: NOV, ofertas: estado(filas(), NOV), franjas: [F('dic', '2026-12-05')] });
        await iniciarCortesia(t.ctx, { texto: 'clase de prueba' });
        expect(t.enviados[0].step).toBe('cortesia_sin_franjas');
        expect(t.enviados[0].texto).not.toContain('5 de diciembre');
    });
});

describe('regresión: escuela sin bloqueos ni ofertas → igual que siempre', () => {
    it('con franjas: las ofrece con botones', async () => {
        const t = armar({ ahora: NOV, ofertas: ABIERTA(NOV), franjas: [F('a', '2026-11-28'), F('b', '2026-12-05')], textos: TEXTOS_POR_DEFECTO });
        await atenderTurnoCortesia(t.ctx, 'Clase de cortesía tienen', null);
        expect(t.enviados[0].texto).toContain('La *clase de cortesía* es *gratis*');
        expect(t.enviados[0].botones?.map((b: any) => b.id)).toEqual([`${BOTON_CC.FRANJA}a`, `${BOTON_CC.FRANJA}b`]);
        expect(t.dejarPendiente).not.toHaveBeenCalled();
    });

    it('sin franjas: «¿Quieres dejarme tus datos?» con sus botones', async () => {
        const t = armar({ ahora: NOV, ofertas: ABIERTA(NOV), franjas: [], textos: TEXTOS_POR_DEFECTO });
        await atenderTurnoCortesia(t.ctx, 'Clase de cortesía tienen', null);
        expect(t.enviados[0].texto).toBe(
            'Por ahora no tengo horarios de *clase de cortesía* publicados para agendarla por aquí. 🙏\n\n' +
            '¿Quieres dejarme tus datos para que la escuela te contacte y te agende una?');
        expect(t.enviados[0].botones?.map((b: any) => b.id)).toEqual([BOTON_CC.DATOS_SI, BOTON_CC.DATOS_NO]);
    });
});

describe('piezas puras', () => {
    it('preguntaPorConvocatoria', () => {
        for (const s of ['¿Cuándo son las convocatorias?', 'convocatoria femenina de mayores', 'hay tryouts?',
            'fechas de las pruebas para entrar al equipo', 'pruebas de ingreso', '¿cuándo son las pruebas?', 'Quiero ir a la visoria']) {
            expect(preguntaPorConvocatoria(s), s).toBe(true);
        }
        for (const s of ['clase de prueba', 'quiero una clase de prueba gratis', 'horarios', 'hola', 'puedo ir a probar?', null]) {
            expect(preguntaPorConvocatoria(s), String(s)).toBe(false);
        }
    });

    it('textoParaConvocatoria: filtra por género; sin ofertas → null', () => {
        const e = estado(filas(), DIC);
        const masc = textoParaConvocatoria(e, 'convocatoria masculina')!;
        expect(masc).toContain('8:00 a 10:00 p. m.');
        expect(masc).not.toContain('7:00 a 9:00 p. m.');
        expect(masc).not.toMatch(/clases? de prueba/);
        expect(textoParaConvocatoria(estado(filas({ ofertas: [], sesiones: [] }), DIC), 'convocatorias')).toBeNull();
    });

    it('textoSinClaseDePrueba: a quien pregunta por la convocatoria no se le habla de la clase', () => {
        const e = estado(filas(), DIC);
        expect(textoSinClaseDePrueba(e, '¿cuándo son las convocatorias?', MONSTER)).not.toMatch(/clases? de prueba/);
        expect(textoSinClaseDePrueba(e, 'quiero la clase de prueba', MONSTER)).toMatch(/^Por ahora no tenemos clases de prueba/);
    });

    it('franjasPermitidas: sin clase hoy → ninguna; con clase hoy → sin las de días bloqueados', () => {
        const fs = [F('nov', '2026-11-30'), F('dic', '2026-12-01'), F('ene', '2027-01-31'), F('feb', '2027-02-01')];
        expect(franjasPermitidas(fs, estado(filas(), DIC))).toEqual([]);
        expect(franjasPermitidas(fs, estado(filas(), NOV)).map((f) => f.id)).toEqual(['nov', 'feb']);
        expect(franjasPermitidas(fs, ABIERTA(NOV))).toEqual(fs);
    });

    it('semana de cortesía por la app: con la clase cerrada hoy → null (quien llama sigue sin ofrecerla)', async () => {
        const ajustes = { modoCortesia: 'semana_app', cortesiaQrId: 'qr-1', cortesiaDias: 7 } as const;
        expect(await mensajeSemanaDeCortesia('monster', ajustes, estado(filas(), DIC))).toBeNull();
    });
});
