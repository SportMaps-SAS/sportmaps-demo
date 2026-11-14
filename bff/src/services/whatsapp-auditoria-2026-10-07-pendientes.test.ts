/**
 * Pendientes de la auditoría del bot de Dynasty, 2026-10-07 (integración
 * f50d6940…). Reglas PURAS con los casos reales (teléfonos y nombres de ejemplo):
 *
 *  1. La escuela cede y nadie vuelve: …4445 («ya pasé tu mensaje» 12:19 y
 *     «Hola» 12:56 / 15:08 / 17:38 sin respuesta), …1042 (la escuela mandó solo
 *     una imagen) y …6297 (el pin del coliseo + «Coliseo Dynasty»).
 *  4. Mensajes largos: máximo 3 emojis y ≤ 600 caracteres.
 *  6. «¿En qué horario se puede ir a cancelar la mensualidad?» (…5281):
 *     cancelar = pagar, y es información pública.
 */
import { describe, it, expect } from 'vitest';
import {
    humanoReciente, decidirRetoma, esSoloAdjunto, recortarEmojis, contarEmojis,
    RETOMA_MIN, type FilaReciente,
} from './whatsapp-reglas-turno';
import {
    preguntaComoPagar, textoComoPagar, textoHorarioPresencial, MAX_CARACTERES_MENSAJE,
} from './whatsapp-pago-publico';

const T0 = Date.parse('2026-10-07T12:00:00-05:00');
const min = (m: number) => new Date(T0 + m * 60_000).toISOString();

const entra = (m: number, texto: string, id = `in-${m}`): FilaReciente =>
    ({ wa_message_id: id, direction: 'inbound', type: 'text', text_body: texto, ai_generated: false, created_at: min(m) });
const bot = (m: number, step: string, texto = '…'): FilaReciente =>
    ({ wa_message_id: `bot-${m}`, direction: 'outbound', type: 'text', text_body: texto, ai_generated: true, payload: { step }, created_at: min(m) });
const escuela = (m: number, type: string, texto: string | null = null): FilaReciente =>
    ({ wa_message_id: `esc-${m}`, direction: 'outbound', type, text_body: texto, ai_generated: false, created_at: min(m) });

describe('1. «la escuela está atendiendo»: una imagen suelta no calla al bot 15 min', () => {
    it('imagen sin texto de la escuela hace 5 min → ya no cuenta (…1042)', () => {
        expect(humanoReciente([escuela(0, 'image')], 15, T0 + 5 * 60_000)).toBe(false);
    });
    it('imagen hace 2 min → sí cuenta (3 min)', () => {
        expect(humanoReciente([escuela(0, 'image')], 15, T0 + 2 * 60_000)).toBe(true);
    });
    it('ubicación y sticker igual que la imagen', () => {
        expect(humanoReciente([escuela(0, 'location')], 15, T0 + 4 * 60_000)).toBe(false);
        expect(humanoReciente([escuela(0, 'sticker')], 15, T0 + 4 * 60_000)).toBe(false);
    });
    it('TEXTO de la escuela hace 10 min → la escuela está atendiendo (15 min completos)', () => {
        expect(humanoReciente([escuela(0, 'text', 'Coliseo Dynasty')], 15, T0 + 10 * 60_000)).toBe(true);
    });
    it('imagen CON pie de foto cuenta como texto', () => {
        const f = escuela(0, 'image', 'Este es el horario');
        expect(esSoloAdjunto(f)).toBe(false);
        expect(humanoReciente([f], 15, T0 + 10 * 60_000)).toBe(true);
    });
});

describe('1. decidirRetoma — casos reales', () => {
    // …4445: el bot le pasó el mensaje a la escuela a las 12:19 y nadie volvió.
    const caso4445 = [
        entra(14, 'Buenas tardes, soy el papá de una alumna que dejó de ir hace unos meses'),
        bot(15, 'ask_email'),
        entra(17, 'No recuerdo el correo con el que se inscribió'),
        bot(17.5, 'desconocido_tema_escolar'),
        entra(19, 'Solo quiero saber cómo hacer para que pueda volver'),
        bot(19.5, 'prospecto_seguimiento', '¡Gracias! 🙌 Ya pasé tu mensaje a la escuela y alguien te responde por aquí.'),
        entra(20, 'Gracias'),
        entra(56, 'Hola', 'in-hola-1'),
    ];

    it('…4445 a las 12:56 + 30 min: nadie escribió → el bot retoma', () => {
        const d = decidirRetoma(caso4445, T0 + 51 * 60_000);
        expect(d.responder).toBe(true);
        expect(d.pendientes.map((f) => f.text_body)).toEqual(['Gracias', 'Hola']);
    });

    it('…4445 «Hola» a las 15:08 (> 1 h tras «ya pasé tu mensaje») → re-aviso a la escuela', () => {
        const filas = [...caso4445, entra(188, 'Hola', 'in-hola-2')];
        const d = decidirRetoma(filas, T0 + 189 * 60_000);
        expect(d.reavisar).toBe(true);
        expect(d.pase?.payload?.step).toBe('prospecto_seguimiento');
    });

    it('…4445 antes de los 30 min: todavía no', () => {
        expect(decidirRetoma(caso4445, T0 + 40 * 60_000).responder).toBe(false);
    });

    // …1042: la escuela mandó SOLO una imagen; la pregunta quedó sin respuesta.
    const caso1042 = [
        bot(-20, 'desconocido_tema_escolar'),
        escuela(32, 'image'),
        entra(42, 'Cuánto es la mensualidad y qué dirección es'),
    ];
    it('…1042: imagen de la escuela + pregunta, 30 min sin TEXTO de la escuela → retoma', () => {
        const d = decidirRetoma(caso1042, T0 + 73 * 60_000);
        expect(d.responder).toBe(true);
        expect(d.pendientes.map((f) => f.text_body)).toEqual(['Cuánto es la mensualidad y qué dirección es']);
    });
    it('…1042: si la escuela contesta con texto, no hay nada pendiente', () => {
        const d = decidirRetoma([...caso1042, escuela(50, 'text', 'Son $150.000, estamos en la Cl. 12')], T0 + 90 * 60_000);
        expect(d.responder).toBe(false);
        expect(d.motivo).toBe('sin_pendientes');
    });

    // …6297: el pin del coliseo y «Coliseo Dynasty»; después «edad máxima» y «precios».
    const caso6297 = [
        bot(-33, 'cortesia_ofrecer'),
        entra(-32, 'Y que lugar es ?'),
        escuela(-28, 'location'),
        escuela(-27.5, 'text', 'Coliseo Dynasty'),
        entra(-27, 'Cuál es la edad máxima como adulto ? Es que somos varios que estamos buscando'),
        entra(-26.9, 'Y los precios'),
    ];
    it('…6297: a los 10 min la escuela sigue atendiendo (escribió texto)', () => {
        const d = decidirRetoma(caso6297, T0 - 17 * 60_000);
        expect(d.responder).toBe(false);
    });
    it('…6297: a los 31 min sin texto de la escuela → retoma con las dos preguntas', () => {
        const d = decidirRetoma(caso6297, T0 + 4 * 60_000);
        expect(d.responder).toBe(true);
        expect(d.pendientes).toHaveLength(2);
    });

    it('contacto personal (el bot nunca le habló): nunca se retoma', () => {
        const filas = [escuela(0, 'text', 'Hola mamá'), entra(1, '¿Vienes a almorzar?')];
        expect(decidirRetoma(filas, T0 + 120 * 60_000).motivo).toBe('bot_no_hablo');
    });

    it('el bot respondió y nadie cedió (sin persona ni «ya pasé»): no es retoma', () => {
        const filas = [bot(0, 'get_payment_status'), entra(1, 'ok y la otra?')];
        expect(decidirRetoma(filas, T0 + 60 * 60_000).motivo).toBe('no_cedio');
    });

    it(`RETOMA_MIN es ${RETOMA_MIN} min`, () => expect(RETOMA_MIN).toBe(30));
});

describe('6. cancelar = PAGAR, y es público (…5281)', () => {
    it.each([
        ['En que horario se puede ir a cancelar la mensualidad', true, true],
        ['Hay atención presencial en el club mañana ?', false, true],
        ['Atención hoy hasta las siete', false, true],
        ['¿Cómo cancelo el mes de octubre?', true, false],
        ['Donde puedo pagar la cuota', true, false],
        ['me pasas el número de cuenta para consignar', true, false],
        ['medios de pago', true, false],
        // Monster 2026-11-04: después de la ficha de la clínica el bot mandaba esto al buzón.
        ['Listo, ¿a qué número te consigno?', true, false],
        ['¿A qué Nequi transfiero?', true, false],
        ['a cual llave te pago', true, false],
    ])('«%s» → pagar=%s, presencial=%s', (texto, pagar, presencial) => {
        expect(preguntaComoPagar(texto)).toEqual({ pagar, presencial });
    });

    it.each([
        'Cuánto debo',
        'quiero cancelar mi clase de cortesía',
        'Yo así no pago sin informar nada',
        'ya cancelé la mensualidad',
    ])('«%s» → NO es «cómo pagar» (o es de su cuenta)', (texto) => {
        expect(preguntaComoPagar(texto).pagar).toBe(false);
    });

    const DATOS = {
        cuentas: [
            { tipo: 'Bre-B Bancolombia', titular: 'Dynasty Volley Club', numero: '@dynasty1' },
            { tipo: 'Nequi', titular: null, numero: '3001234567' },
        ],
        linkDePago: 'https://checkout.wompi.co/l/EJEMPLO',
    };

    it('el texto trae las cuentas y el link, sin pedir el correo, ≤ 600 caracteres y ≤ 3 emojis', () => {
        const t = textoComoPagar({ pregunta: { pagar: true, presencial: false }, datos: DATOS, horario: null });
        expect(t).toContain('@dynasty1');
        expect(t).toContain('3001234567');
        expect(t).toContain('https://checkout.wompi.co/l/EJEMPLO');
        expect(t).not.toMatch(/correo/i);
        expect(t.length).toBeLessThanOrEqual(MAX_CARACTERES_MENSAJE);
        expect(contarEmojis(t)).toBeLessThanOrEqual(3);
    });

    it('pregunta presencial SIN horario configurado → no se inventa: «te confirma la escuela»', () => {
        const t = textoComoPagar({ pregunta: { pagar: true, presencial: true }, datos: DATOS, horario: null });
        expect(t).toContain('Sobre la atención presencial te confirma la escuela');
        expect(t).not.toMatch(/\d{1,2}:\d{2}\s*[ap]\. m\..*–/);
    });

    it('con horario configurado se dice tal cual', () => {
        const horario = textoHorarioPresencial([
            { day: 1, closed: false, open: '16:00', close: '21:00' },
            { day: 2, closed: false, open: '16:00', close: '21:00' },
            { day: 3, closed: false, open: '16:00', close: '21:00' },
            { day: 6, closed: false, open: '08:00', close: '12:00' },
            { day: 0, closed: true },
        ]);
        expect(horario).toBe('lun a mié 4:00 p. m. – 9:00 p. m.; sáb 8:00 a. m. – 12:00 p. m.');
        const t = textoComoPagar({ pregunta: { pagar: false, presencial: true }, datos: DATOS, horario });
        expect(t).toContain('Atención presencial: lun a mié 4:00 p. m. – 9:00 p. m.');
    });

    it('sin horario cargado (NULL) → null', () => {
        expect(textoHorarioPresencial(null)).toBeNull();
        expect(textoHorarioPresencial([{ day: 1, closed: true }])).toBeNull();
    });
});

describe('4. máximo 3 emojis por mensaje', () => {
    it('el saludo de 12 emojis queda en 3 (los primeros)', () => {
        const saludo = 'Hola 👋 Soy el asistente 🤖 ¡Claro! 🙌 📍 Coliseo 📍 Cancha 📍 Sede 🔒 nota ✅ 🎉 ⚽ 🏐 💪';
        expect(contarEmojis(saludo)).toBe(12);
        const r = recortarEmojis(saludo);
        expect(contarEmojis(r)).toBe(3);
        expect(r.startsWith('Hola 👋 Soy el asistente 🤖 ¡Claro! 🙌')).toBe(true);
        expect(r).toContain('Coliseo');
    });
    it('con 3 o menos no cambia nada', () => {
        expect(recortarEmojis('Listo ✅ quedó 👍')).toBe('Listo ✅ quedó 👍');
    });
});
