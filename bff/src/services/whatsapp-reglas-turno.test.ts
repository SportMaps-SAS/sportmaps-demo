/**
 * Reglas deterministas del turno del bot, con los textos REALES de Dynasty del
 * 2026-10-06 (anonimizados): docs/analisis/whatsapp-conversaciones-dynasty-2026-10-06.md.
 * Puras: sin mocks.
 */
import { describe, it, expect } from 'vitest';
import {
    anunciaComprobante, nombreDelCobroAnunciado, yaPagoYReclama, textoYaPague, pideALaPersona,
    vocativosDelEquipo, esCierreSuelto, esAutoRespuesta, rutaSinModelo, humanoReciente,
    preguntaAbierta, pasoEnVentana, type FilaReciente,
} from './whatsapp-reglas-turno';

const EQUIPO = vocativosDelEquipo(['Milena Ríos', 'Sandra Gómez']);

describe('P3 anunciaComprobante', () => {
    it('texto precargado de /p/:token (como llegó el 06-oct, sin ref)', () => {
        const a = anunciaComprobante('Hola, envío el comprobante de pago de Mensualidad 10/2026 - LAURA P (octubre 2026) de Laura.');
        expect(a).toMatchObject({
            tipo: 'precargado', concepto: 'Mensualidad 10/2026 - LAURA P', periodo: 'octubre 2026', deportista: 'Laura',
        });
        expect(nombreDelCobroAnunciado(a)).toBe('Mensualidad 10/2026 - LAURA P (octubre 2026)');
    });

    it('texto precargado nuevo, con la referencia corta del cobro', () => {
        const a = anunciaComprobante('Hola, envío el comprobante de pago de Mensualidad 10/2026 - LAURA P (octubre 2026) de Laura. (ref. 3FA2B91C)');
        expect(a).toMatchObject({ tipo: 'precargado', ref: '3fa2b91c', deportista: 'Laura', periodo: 'octubre 2026' });
    });

    it.each([
        'Buen día envío pago de Sara y también envío los 100000 del torneo',
        'te envío el comprobante',
        'ahí va el pago',
        'Buenas noches.. envío soporte de pago mes octubre Sara',
        'Pago Sara',
        'Soportes Sara mensualidad y vacacionales',
        'pagué la mensualidad de octubre',
        'Mensualidad octubre voleibol viki',
    ])('variante genérica «%s»', (t) => {
        expect(anunciaComprobante(t)?.tipo).toBe('generico');
    });

    it('«voy a enviar el pago mañana» es un anuncio a futuro', () => {
        expect(anunciaComprobante('voy a enviar el pago mañana')?.tipo).toBe('futuro');
    });

    it.each([
        '¿te envío el comprobante por acá?',
        'Hola Milena buenos días',
        '¿cuánto debo?',
        'ya pagué y me sigue llegando el cobro',
        'Le puedes prestar un cargador tipo c a santi',
    ])('no es anuncio: «%s»', (t) => {
        expect(anunciaComprobante(t)).toBeNull();
    });
});

describe('P7 yaPagoYReclama', () => {
    it.each([
        'Es q me aparece el pago pendiente y yo ya pagué, me llegaron mensajes recordando el pago',
        'me está llegando cuenta de cobro pero yo ya te envié el desprendible',
        'Aún no aparece el pago en la plataforma me ayudas',
        'Pague el Jueves ☹️',
        'me llegó este correito, me ayudas a reflejar el pago',
        'La transferencia se realizó el 4 de septiembre 👇',
        'ya transferí',
    ])('«%s»', (t) => expect(yaPagoYReclama(t)).toBe(true));

    it.each(['¿cuánto debo?', 'envío pago de Sara', 'hola'])('no: «%s»', (t) => expect(yaPagoYReclama(t)).toBe(false));

    it('dice primero el comprobante y su estado, y después lo pendiente', () => {
        const { texto, hayAlgo } = textoYaPague(
            [
                { concept: 'Mensualidad Septiembre', status: 'awaiting_approval', debe_pagarse: false, saldo: 180000 },
                { concept: 'Mensualidad Octubre', status: 'pending', debe_pagarse: true, saldo: 180000, vencido: true },
            ],
            [{ status: 'pending', created_at: '2026-10-06T13:35:00Z' }],
        );
        expect(hayAlgo).toBe(true);
        const iRevision = texto.indexOf('pendiente de revisión');
        const iSeptiembre = texto.indexOf('Mensualidad Septiembre');
        const iPendiente = texto.indexOf('Mensualidad Octubre');
        expect(iRevision).toBeGreaterThanOrEqual(0);
        expect(iSeptiembre).toBeGreaterThan(iRevision);
        expect(iPendiente).toBeGreaterThan(iSeptiembre);
        expect(texto).not.toMatch(/voy a revisar|te confirmo en un momento|vencid/i);
    });

    it('lo pendiente con mora trae su desglose (la mora ya va dentro del saldo)', () => {
        const { texto } = textoYaPague(
            [{ concept: 'Mensualidad Octubre', status: 'overdue', debe_pagarse: true, saldo: 165000, late_fee_amount: 15000 }], []);
        expect(texto).toContain('• Mensualidad Octubre: $165.000\n   Mensualidad $150.000 · Recargo por mora $15.000 · Total $165.000');
        const sin = textoYaPague([{ concept: 'Mensualidad Octubre', status: 'pending', debe_pagarse: true, saldo: 180000 }], []);
        expect(sin.texto).not.toContain('Recargo por mora');
    });

    it('sin comprobante en ningún lado: lo dice y pide el archivo', () => {
        const { texto, hayAlgo } = textoYaPague(
            [{ concept: 'Mensualidad Octubre', status: 'pending', debe_pagarse: true, saldo: 180000 }], []);
        expect(hayAlgo).toBe(false);
        expect(texto).toContain('No encuentro ningún comprobante');
        expect(texto).toContain('*foto*');
    });
});

describe('P9 pideALaPersona', () => {
    it('«Milena estás por acá?» → escalar', () => {
        expect(pideALaPersona('Milena estás por acá?', EQUIPO)).toEqual({ tipo: 'escalar' });
    });
    it.each(['quiero hablar con alguien', 'me comunicas con la escuela', 'necesito hablar con una persona'])(
        '«%s» → escalar', (t) => expect(pideALaPersona(t, EQUIPO)?.tipo).toBe('escalar'));

    it('«Mile, puedes ir a comunicación … marcar como personal» → vocativo a Milena', () => {
        expect(pideALaPersona('Mile, puedes ir a comunicación WhatsApp Conversaciones y marcar como personal', EQUIPO))
            .toEqual({ tipo: 'vocativo', nombre: 'Milena' });
    });
    it.each(['Hola Milena buenos días', 'Buen día Milena', 'Mi querida Mile', 'Sandrita te cuento una cosa'])(
        '«%s» → vocativo', (t) => expect(pideALaPersona(t, EQUIPO)?.tipo).toBe('vocativo'));

    it.each([
        'Hola Milena, ¿cuánto debo?',
        'Mile buen día, envío pago mes de octubre',
        '¿quién es el entrenador?',
        'le dije a Milena que iba tarde y no pudo',
    ])('con trámite o sin vocativo → null: «%s»', (t) => expect(pideALaPersona(t, EQUIPO)).toBeNull());

    it('«profe» sin nombres cargados', () => {
        expect(pideALaPersona('profe la niña hoy no va', new Map())).toEqual({ tipo: 'vocativo', nombre: 'la profe' });
    });
});

describe('P13/P14 cierres y auto-respuestas', () => {
    it.each(['Gracias', 'ok', 'Vale', '👍', '🙏🏻', 'Listo, muchas gracias', 'Ok gracias'])('cierre suelto «%s»', (t) =>
        expect(esCierreSuelto(t)).toBe(true));
    it.each(['gracias, ¿y cuánto debo?', '?', 'Si ??', 'hola'])('no es cierre «%s»', (t) =>
        expect(esCierreSuelto(t)).toBe(false));
    it('auto-respuesta de otro negocio', () => {
        expect(esAutoRespuesta('¡Hola! 👋 Gracias por escribir a Play Kids. En este momento estamos fuera de horario.')).toBe(true);
        expect(esAutoRespuesta('gracias por todo profe')).toBe(false);
    });
});

describe('P10 rutaSinModelo', () => {
    it('elige el camino determinista', () => {
        expect(rutaSinModelo('¿cuánto debo?')).toBe('pagos');
        expect(rutaSinModelo('me pasas el nequi')).toBe('medios');
        expect(rutaSinModelo('Cuál caso')).toBe('menu');
    });
});

describe('estado reciente', () => {
    const AHORA = new Date('2026-10-06T13:34:33Z').getTime();
    const hace = (s: number) => new Date(AHORA - s * 1000).toISOString();

    it('P4: un echo de la escuela en los últimos 15 min calla al bot; un automático de la app no', () => {
        const echo: FilaReciente = { direction: 'outbound', ai_generated: false, text_body: 'Siii', wa_timestamp: hace(120) };
        const auto: FilaReciente = { direction: 'outbound', ai_generated: false, payload: { automatico: true }, wa_timestamp: hace(60) };
        const viejo: FilaReciente = { direction: 'outbound', ai_generated: false, wa_timestamp: hace(16 * 60) };
        expect(humanoReciente([echo], 15, AHORA)).toBe(true);
        expect(humanoReciente([auto, viejo], 15, AHORA)).toBe(false);
    });

    it('P2: la pregunta de consentimiento solo está abierta si fue lo ÚLTIMO que dijo el bot', () => {
        const pregunta: FilaReciente = { direction: 'outbound', ai_generated: true, payload: { step: 'ask_consent' }, created_at: hace(30) };
        const otra: FilaReciente = { direction: 'outbound', ai_generated: true, payload: { step: 'llm_text' }, created_at: hace(10) };
        expect(preguntaAbierta([pregunta], 'ask_consent')).toBe(true);
        expect(preguntaAbierta([pregunta, otra], 'ask_consent')).toBe(false);
    });

    it('pasoEnVentana', () => {
        const si: FilaReciente = { direction: 'outbound', payload: { step: 'opt_in_registrado' }, created_at: hace(15) };
        expect(pasoEnVentana([si], 'opt_in_registrado', 60_000, AHORA)).toBe(si);
        expect(pasoEnVentana([si], 'opt_in_registrado', 10_000, AHORA)).toBeNull();
    });
});

describe('humanoReciente: eco de la escuela marcado automático por repetirse (Monster 2026-11-26, …8431)', () => {
    const AHORA = Date.parse('2026-11-26T17:52:10Z');
    const at = (s: number) => new Date(AHORA - s * 1000).toISOString();
    const eco = (hace: number, extra: Record<string, unknown> = {}): FilaReciente => ({
        direction: 'outbound', type: 'text', text_body: '¡Queremos conocerte y conocer tu experiencia en el voleibol!',
        ai_generated: false, wa_timestamp: at(hace), payload: { to: '573142608431', automatico: true, ...extra },
    });
    const entrante = (hace: number): FilaReciente => ({ direction: 'inbound', type: 'text', text_body: 'hola', ai_generated: false, wa_timestamp: at(hace) });

    it('lo que la escuela pega a mano (eco automático 6 min después del entrante) calla al bot', () => {
        expect(humanoReciente([entrante(400), eco(13), entrante(7)], 15, AHORA)).toBe(true);
    });
    it('el saludo / ausencia de la app (eco automático segundos después del entrante) no calla', () => {
        expect(humanoReciente([entrante(16), eco(13), entrante(7)], 15, AHORA)).toBe(false);
    });
    it('un job (step / campaña / plantilla, sin destinatario de Meta) no calla', () => {
        expect(humanoReciente([entrante(400), eco(13, { step: 'clase_prueba_cupo_por_vencer' })], 15, AHORA)).toBe(false);
        expect(humanoReciente([entrante(400), { ...eco(13), payload: { automatico: true, campana_id: 'c1' } }], 15, AHORA)).toBe(false);
        expect(humanoReciente([entrante(400), { ...eco(13), payload: { automatico: true } }], 15, AHORA)).toBe(false);
    });
});
