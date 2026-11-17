/**
 * Auditoría de conversaciones reales de producción (8–16 nov 2026, dos escuelas): las reglas PURAS.
 * Cada prueba usa la frase real que falló.
 *
 *  6. El bot repitió 20 veces el mismo texto en 14 conversaciones (una, 6 veces en 4 minutos).
 *  7. «Crea tu cuenta» y «Dejo tu mensaje para…» como respuesta a cosas que no eran de la cuenta.
 *  8. Interesados que preguntan después de la bienvenida y nadie les responde.
 * 10. El menú automático de otro negocio y un bot en bucle.
 * 11. Preguntas y avisos de pago sin dueño dentro de un silencio por diseño.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    repiteElUltimoSaliente, VENTANA_MISMO_TEXTO_MS, PASOS_QUE_SE_REPITEN_A_PROPOSITO,
    trataDeLaCuenta, pideALaPersona, vocativosDelEquipo, pideInformacionDeLaEscuela,
    esMenuDeOtroNegocio, esBucleDeOtraMaquina, esDeOtraMaquina, type FilaReciente,
} from './whatsapp-reglas-turno';
import {
    entrantesSinDuenoEnSilencio, esPreguntaQueEsperaRespuesta, esAvisoDePago,
} from './whatsapp-silencio-conversacion';

const AHORA = Date.parse('2026-11-16T15:00:00Z');
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();

describe('6. el bot no repite su último mensaje en menos de 2 minutos', () => {
    const LISTA = 'Elige uno de los horarios de la lista 👇\n\nEstos son los próximos horarios 👇';
    const botones = ['sm_em_f:s1', 'sm_em_f:s2'];

    it('«Elige uno de los horarios de la lista 👇» otra vez a los 30 s: no sale', () => {
        expect(repiteElUltimoSaliente({ texto: LISTA, botones, paso: 'embudo_horarios' },
            { texto: LISTA, momento: AHORA - 30_000, botones }, AHORA)).toBe(true);
    });

    it('pasados los 2 minutos sí puede repetirse', () => {
        expect(repiteElUltimoSaliente({ texto: LISTA, botones, paso: 'embudo_horarios' },
            { texto: LISTA, momento: AHORA - VENTANA_MISMO_TEXTO_MS - 1000, botones }, AHORA)).toBe(false);
    });

    it('con los mismos primeros 60 caracteres también es el mismo mensaje', () => {
        const a = 'Eso te lo confirma la escuela por aquí 🙌 Ya le pasé tu pregunta. Mientras tanto, puedes separar tu cupo.';
        const b = 'Eso te lo confirma la escuela por aquí 🙌 Ya le pasé tu pregunta. Mientras tanto, te cuento que quedan cupos.';
        expect(repiteElUltimoSaliente({ texto: a, paso: 'venta_servicio_a_la_escuela' }, { texto: b, momento: AHORA - 10_000 }, AHORA)).toBe(true);
    });

    it('la misma lista con OTRAS opciones («Ver más horarios») no es una repetición', () => {
        expect(repiteElUltimoSaliente({ texto: LISTA, botones: ['sm_em_f:s3', 'sm_em_f:s4'], paso: 'embudo_horarios' },
            { texto: LISTA, momento: AHORA - 10_000, botones }, AHORA)).toBe(false);
    });

    it('un texto distinto, o uno muy corto («Listo 🙌»), no se frena', () => {
        expect(repiteElUltimoSaliente({ texto: '¿Cuál es el nombre completo del deportista?' },
            { texto: LISTA, momento: AHORA - 10_000 }, AHORA)).toBe(false);
        expect(repiteElUltimoSaliente({ texto: 'Listo 🙌' }, { texto: 'Listo 🙌', momento: AHORA - 10_000 }, AHORA)).toBe(false);
    });

    it('los pasos que se repiten a propósito: el código de verificación y la confirmación de la baja', () => {
        const otp = 'Te envié un código de 6 dígitos al correo j***@gmail.com. Escríbelo aquí.';
        for (const paso of ['otp_sent', 'otp_failed', 'opt_out_confirmado', 'confirmar_baja']) {
            expect(PASOS_QUE_SE_REPITEN_A_PROPOSITO.has(paso), paso).toBe(true);
            expect(repiteElUltimoSaliente({ texto: otp, paso }, { texto: otp, momento: AHORA - 10_000 }, AHORA), paso).toBe(false);
        }
        // Los de la auditoría NO están exentos.
        for (const paso of ['embudo_horarios', 'asistencia_staff', 'venta_servicio_pago', 'escalated', 'venta_servicio_a_la_escuela']) {
            expect(repiteElUltimoSaliente({ texto: otp, paso }, { texto: otp, momento: AHORA - 10_000 }, AHORA), paso).toBe(true);
        }
    });

    it('el estado de pagos abre igual pero cambia después: solo se frena si es IGUAL entero', () => {
        const a = 'Estos son los pagos pendientes de tu familia a la fecha de hoy, 16 de noviembre:\n• Mensualidad noviembre: $150.000';
        const b = 'Estos son los pagos pendientes de tu familia a la fecha de hoy, 16 de noviembre:\n• Uniforme: $80.000';
        expect(repiteElUltimoSaliente({ texto: b, paso: 'get_payment_status' }, { texto: a, momento: AHORA - 10_000 }, AHORA)).toBe(false);
        expect(repiteElUltimoSaliente({ texto: a, paso: 'get_payment_status' }, { texto: a, momento: AHORA - 10_000 }, AHORA)).toBe(true);
    });

    it('sin un saliente anterior no hay nada que repetir', () => {
        expect(repiteElUltimoSaliente({ texto: LISTA }, null, AHORA)).toBe(false);
    });
});

describe('7. el aviso de la cuenta solo cuando el mensaje trata de la cuenta', () => {
    it('las frases reales que recibieron «todavía no tienes tu cuenta creada» NO son de la cuenta', () => {
        for (const t of [
            'A qué hora es el entrenamiento?',
            'Para salir antes y agarrar el bus',
            'Las fechas ya están confirmadas o hay alguna opción de que las cambien ??',
            'envío soporte de pago de este mes',
            'Buenas tardes necesito a Felipe por favor',
            '¿A qué cuenta consigno la mensualidad?',
            'me regalas el número de cuenta de ahorros',
        ]) expect(trataDeLaCuenta(t), t).toBe(false);
    });

    it('lo que sí es de la cuenta, la app o el ingreso', () => {
        for (const t of [
            'No puedo entrar a la app',
            'cómo creo mi cuenta?',
            'olvidé la contraseña',
            'no me llegó la invitación para registrarme',
            'Cómo ingreso a la plataforma',
            'ya me registré y no me deja iniciar sesión',
        ]) expect(trataDeLaCuenta(t), t).toBe(true);
    });

    it('«…necesito a Felipe por favor»: pide a una persona del equipo por su nombre', () => {
        const equipo = vocativosDelEquipo(['Iván Felipe Sossa', 'Milena Rojas']);
        expect(pideALaPersona('Buenas tardes necesito a Felipe por favor', equipo)).toEqual({ tipo: 'escalar' });
        expect(pideALaPersona('me comunicas con Milena', equipo)).toEqual({ tipo: 'escalar' });
        // Un nombre que no es del equipo no escala por esta regla.
        expect(pideALaPersona('necesito a Carolina para el sábado', equipo)).toBeNull();
    });

    it('«Profe, las fechas ya están confirmadas…?» es una consulta, no un recado para la profe', () => {
        const equipo = vocativosDelEquipo(['Milena Rojas']);
        expect(pideALaPersona('Profe las fechas ya están confirmadas o hay alguna opción de que las cambien ??', equipo)).toBeNull();
        expect(pideALaPersona('Mile cuánto es el valor del torneo', equipo)).toBeNull();
        // El recado de siempre sigue siéndolo.
        expect(pideALaPersona('Mile, puedes ir a comunicación', equipo)).toEqual({ tipo: 'vocativo', nombre: 'Milena' });
    });
});

describe('8. el interesado que pregunta después de la bienvenida', () => {
    it('las frases reales que quedaron sin respuesta piden información', () => {
        for (const t of [
            'Dame información',
            'Horarios, costos',
            'si me puedes ayudar con horarios, valores y pagos.',
            'Entre semana, como manejas los horarios?',
            'Quiero saber si tienes cursos de vacaciones niña de 10 años por favor',
            'Hola buenas tardes hoy tienen juego?',
        ]) expect(pideInformacionDeLaEscuela(t), t).toBe(true);
    });

    it('un saludo, un cierre o «gracias por la información» no', () => {
        for (const t of ['Hola', 'Hola buenas tardes', 'Hola, cómo estás?', 'Ok gracias', 'Muchas gracias por la información', 'O el sábado', '👍']) {
            expect(pideInformacionDeLaEscuela(t), t).toBe(false);
        }
    });
});

describe('10. otros bots y spam', () => {
    const MENU = 'Bienvenid@ a Plusgami.store 🎮\nSomos tu tienda de videojuegos.\n\nElige una opción:\n1. Cotizar juego\n2. Estado de mi pedido\n3. Hablar con un asesor';

    it('«Bienvenid@ a Plusgami.store… 1. Cotizar juego» es el menú de otro negocio', () => {
        expect(esMenuDeOtroNegocio(MENU)).toBe(true);
        expect(esDeOtraMaquina([], MENU)).toBe(true);
        expect(esMenuDeOtroNegocio('Hola! Gracias por escribirnos.\n\n1️⃣ Ventas\n2️⃣ Soporte\n\nResponde con el número de la opción')).toBe(true);
    });

    it('una persona que enumera, o que responde un dato, no es un menú', () => {
        for (const t of [
            'Hola, tengo dos hijas:\n1. Mariana 12 años\n2. Sofía 9 años\nquiero inscribirlas a las dos',
            'Puedo el sábado o el domingo, cualquiera de las 2 opciones me sirve',
            'Mariana Gómez, 14/03/2011, punta',
            '2',
        ]) expect(esMenuDeOtroNegocio(t), t).toBe(false);
    });

    it('el mismo texto largo tres veces en 10 minutos es un bot en bucle', () => {
        const T = 'Hola, soy el asistente virtual de la tienda. ¿En qué te puedo ayudar hoy?';
        const fila = (id: string, min: number, text = T): FilaReciente =>
            ({ wa_message_id: id, direction: 'inbound', text_body: text, created_at: hace(min) });
        const dos = [fila('a', 4), fila('b', 2)];
        expect(esBucleDeOtraMaquina(dos, T, 'c', AHORA)).toBe(true);
        expect(esBucleDeOtraMaquina([fila('a', 4)], T, 'c', AHORA)).toBe(false);
        // Con las filas ya trayendo el actual (sin su id): tres en total.
        expect(esBucleDeOtraMaquina([...dos, fila('c', 0)], T, null, AHORA)).toBe(true);
        // Repartidos en una hora no es un bucle.
        expect(esBucleDeOtraMaquina([fila('a', 50), fila('b', 30)], T, 'c', AHORA)).toBe(false);
        // Una persona impaciente repite cosas CORTAS.
        const corto = [fila('a', 3, 'Hola??'), fila('b', 2, 'Hola??')];
        expect(esBucleDeOtraMaquina(corto, 'Hola??', 'c', AHORA)).toBe(false);
    });
});

describe('11. lo que quedó sin dueño dentro de un silencio por diseño', () => {
    const escuela = (min: number, text = 'Hola, con gusto te cuento'): FilaReciente =>
        ({ direction: 'outbound', ai_generated: false, type: 'text', text_body: text, payload: {}, created_at: hace(min) });
    const cliente = (min: number, text: string | null, type = 'text'): FilaReciente =>
        ({ direction: 'inbound', type, text_body: text, created_at: hace(min) });
    const bot = (min: number): FilaReciente =>
        ({ direction: 'outbound', ai_generated: true, type: 'text', text_body: 'Respuesta del asistente', payload: { step: 'llm_text' }, created_at: hace(min) });

    it('las preguntas reales de venta son preguntas que esperan respuesta', () => {
        for (const t of [
            'Por favor confirmar que los dos cupos quedan reservados',
            'Tienes las tarifas de séniors a la mano',
            'No me han enviado la info de menores',
            'Me puedes ayudar por fa?',
        ]) expect(esPreguntaQueEsperaRespuesta(t), t).toBe(true);
        for (const t of ['Gracias', 'Ok muchas gracias', 'Listo', '👍', 'Vale profe']) {
            expect(esPreguntaQueEsperaRespuesta(t), t).toBe(false);
        }
    });

    it('un aviso de pago: el texto o la foto sola', () => {
        expect(esAvisoDePago({ type: 'text', text_body: 'envío soporte de pago de este mes' })).toBe(true);
        expect(esAvisoDePago({ type: 'text', text_body: 'Ya pagué la clínica' })).toBe(true);
        expect(esAvisoDePago({ type: 'image', text_body: null })).toBe(true);
        expect(esAvisoDePago({ type: 'text', text_body: 'a qué hora es el entreno' })).toBe(false);
    });

    it('la escuela escribió hace 3 h, la familia preguntó hace 2 h y nadie contestó: se reporta', () => {
        const filas = [
            cliente(200, 'Hola buenas'),
            escuela(180),
            cliente(120, 'Por favor confirmar que los dos cupos quedan reservados'),
            cliente(119, 'Gracias'),
        ];
        const r = entrantesSinDuenoEnSilencio(filas, AHORA);
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ motivo: 'pregunta', minutosEsperando: 120 });
        expect(r[0].fila.text_body).toBe('Por favor confirmar que los dos cupos quedan reservados');
        expect(r[0].silencioDesde).toBe(AHORA - 180 * 60_000);
    });

    it('la ráfaga real: «No me han enviado la info de menores» + «Me puedes ayudar por fa?» + el comprobante', () => {
        const filas = [
            escuela(300),
            cliente(240, 'No me han enviado la info de menores'),
            cliente(239, 'Me puedes ayudar por fa?'),
            cliente(60, null, 'image'),
        ];
        const r = entrantesSinDuenoEnSilencio(filas, AHORA);
        expect(r.map((x) => x.motivo)).toEqual(['pregunta', 'pregunta', 'aviso_de_pago']);
    });

    it('si alguien contestó después (la escuela o el bot), ya tiene dueño', () => {
        const pregunta = cliente(120, 'Tienes las tarifas de séniors a la mano');
        expect(entrantesSinDuenoEnSilencio([escuela(180), pregunta, escuela(100, 'Claro, ya te las paso')], AHORA)).toEqual([]);
        expect(entrantesSinDuenoEnSilencio([escuela(180), pregunta, bot(100)], AHORA)).toEqual([]);
    });

    it('fuera de la ventana de silencio no es de este vigilante: 12 h con familias, 72 h con desconocidos', () => {
        const filas = [escuela(20 * 60), cliente(60, 'Tienes las tarifas de séniors a la mano')];
        expect(entrantesSinDuenoEnSilencio(filas, AHORA)).toEqual([]);
        expect(entrantesSinDuenoEnSilencio(filas, AHORA, { desconocido: true })).toHaveLength(1);
        const viejas = [escuela(80 * 60), cliente(60, 'Tienes las tarifas de séniors a la mano')];
        expect(entrantesSinDuenoEnSilencio(viejas, AHORA, { desconocido: true })).toEqual([]);
    });

    it('sin un mensaje de una PERSONA de la escuela no hay silencio (el bot no cuenta), y hay 30 min de gracia', () => {
        expect(entrantesSinDuenoEnSilencio([bot(180), cliente(120, 'Me puedes ayudar por fa?')], AHORA)).toEqual([]);
        // La escuela puede estar contestando: a los 10 minutos todavía no se reporta.
        expect(entrantesSinDuenoEnSilencio([escuela(40), cliente(10, 'Me puedes ayudar por fa?')], AHORA)).toEqual([]);
        expect(entrantesSinDuenoEnSilencio([escuela(40), cliente(10, 'Me puedes ayudar por fa?')], AHORA, { minutosDeGracia: 5 })).toHaveLength(1);
    });

    it('un «gracias» o un sticker no se reportan', () => {
        expect(entrantesSinDuenoEnSilencio([escuela(180), cliente(120, 'Muchas gracias'), cliente(119, null, 'sticker')], AHORA)).toEqual([]);
    });
});
