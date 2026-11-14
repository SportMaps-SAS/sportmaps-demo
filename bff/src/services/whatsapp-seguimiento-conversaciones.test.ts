/**
 * Lista de seguimiento de conversaciones (spec ventas de servicio §4.E): quién
 * escribió, si respondió la escuela o el bot, quién quedó esperando, pendientes de
 * la escuela, datos de pago, comprobante y cobro. Casos recreados de la clínica de
 * Monster (3–8 nov 2026). Puro: sin base.
 */
import { describe, expect, it } from 'vitest';
import {
    armarSeguimiento, autorDe, esAcuse, esPaseALaEscuela, filtrarSeguimiento, leerRangoSeguimiento, resumirSeguimiento,
    seguimientoCsv, traeDatosDePago, enmascararTelefono,
    type ComprobanteSeg, type ConversacionSeg, type EntradaSeguimiento, type LeadSeg, type MensajeSeg, type PagoSeg,
} from './whatsapp-seguimiento-conversaciones.service';
import type { ItemConFicha } from './whatsapp-anuncio-destino';

const CLINICA: ItemConFicha = {
    id: '16766d2e-f8b0-4285-88e3-b1e67dda6d45', name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: 300000, active: true, event_id: null, starts_at: '2026-11-21T05:00:00Z', ends_at: '2026-11-23T04:59:00Z',
};
const VACACIONAL: ItemConFicha = {
    id: 'fff41827-cd2f-404a-b0ff-f42dc66c59a8', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional',
    price: 100000, active: true, event_id: null, starts_at: '2026-11-17T13:00:00Z', ends_at: '2026-12-10T16:00:00Z',
};
const ITEMS = [CLINICA, VACACIONAL];

const AHORA = Date.parse('2026-11-08T18:00:00Z');
const DESDE = AHORA - 7 * 86_400_000;
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();

let n = 0;
const conv = (x: Partial<ConversacionSeg> = {}): ConversacionSeg => ({
    id: `c-${++n}`, contact_wa_id: `57300000${String(1000 + n)}`, contact_name: `Contacto ${n}`, contact_kind: 'desconocido',
    parent_id: null, ...x,
});
const ent = (c: ConversacionSeg, min: number, text: string, x: Partial<MensajeSeg> = {}): MensajeSeg =>
    ({ conversation_id: c.id, direction: 'inbound', type: 'text', text_body: text, created_at: hace(min), ai_generated: false, payload: {}, ...x });
const bot = (c: ConversacionSeg, min: number, text: string, payload: Record<string, unknown> = {}): MensajeSeg =>
    ({ conversation_id: c.id, direction: 'outbound', type: 'text', text_body: text, created_at: hace(min), ai_generated: true, status: 'read', payload });
/** Iván desde el celular (echo de Coexistence): sin automatico, sin step. */
const escuela = (c: ConversacionSeg, min: number, text: string, x: Partial<MensajeSeg> = {}): MensajeSeg =>
    ({ conversation_id: c.id, direction: 'outbound', type: 'text', text_body: text, created_at: hace(min), ai_generated: false, status: 'read', payload: {}, ...x });

const entrada = (x: Partial<EntradaSeguimiento>): EntradaSeguimiento => ({
    conversaciones: [], mensajes: [], pagos: [], cola: [], leads: [], items: ITEMS, desde: DESDE, hasta: AHORA, ahora: AHORA, ...x,
});

const FICHA = '🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES MONSTER’S VOLLEY! 🔥 ¿Quieres llevar tu juego al siguiente nivel? '
    + '21 y 22 de noviembre. Preventa $300.000 hasta el martes 10 de noviembre. Nequi o Daviplata 319 450 5150 (Iván Sossa).';

describe('autorDe', () => {
    it('separa persona, escuela (celular o buzón), bot, campaña y automático', () => {
        const c = conv();
        expect(autorDe(ent(c, 1, 'hola'))).toBe('persona');
        expect(autorDe(escuela(c, 1, 'Hola, ¿cómo estás?'))).toBe('escuela');
        expect(autorDe(escuela(c, 1, 'Te mando la plantilla', { type: 'template', payload: { manual: 'true' } }))).toBe('escuela');
        expect(autorDe(bot(c, 1, 'Soy Mapi'))).toBe('bot');
        expect(autorDe(escuela(c, 1, null as any, { type: 'template', payload: { step: 'campana', campana_id: 'k', automatico: 'true' } }))).toBe('campana');
        // La respuesta automática al «Sí» de la campaña le contesta a la persona: Bot.
        expect(autorDe(escuela(c, 1, FICHA, { payload: { step: 'campana_respuesta_si', campana_id: 'k', automatico: 'true' } }))).toBe('bot');
        // Saludo automático de WhatsApp Business (echo marcado automatico): no es Iván.
        expect(autorDe(escuela(c, 1, 'Hola! 👋 Bienvenid@ a Club Monsters Volley', { payload: { automatico: 'true' } }))).toBe('automatico');
        expect(autorDe(escuela(c, 1, 'Recordatorio de tu clase', { payload: { step: 'recordatorio_cortesia_vispera' } }))).toBe('automatico');
    });
});

describe('armarSeguimiento — casos de la clínica de Monster', () => {
    it('(a) escribió un interesado, el bot mandó la ficha y nadie más: respondió el bot, no la escuela', () => {
        const c = conv();
        const [f] = armarSeguimiento(entrada({
            conversaciones: [c],
            mensajes: [
                ent(c, 300, '¡Hola! Quiero más información sobre la clínica de armadores'),
                bot(c, 299, FICHA, { step: 'prospecto_ia' }),
            ],
        }));
        expect(f.respondioBot).toBe(true);
        expect(f.respondioEscuela).toBe(false);
        expect(f.esperandoDesde).toBeNull();
        expect(f.ultimoMensaje.de).toBe('bot');
        expect(f.datosDePagoEnviados).toBe(true);
        expect(f.tema).toEqual({ tipo: 'servicio', servicioId: CLINICA.id, nombre: CLINICA.name });
        expect(f.primerMensaje.texto).toBe('¡Hola! Quiero más información sobre la clínica de armadores');
    });

    it('(b) la persona escribió y la escuela respondió desde el celular: respondió la escuela', () => {
        const c = conv();
        const [f] = armarSeguimiento(entrada({
            conversaciones: [c],
            mensajes: [
                ent(c, 120, 'Buenas tardes, ¿la clínica incluye grupo femenino?'),
                escuela(c, 90, 'Hola! Sí, es mixta, hay cupos para ellas 🙌'),
            ],
        }));
        expect(f.respondioEscuela).toBe(true);
        expect(f.respondioBot).toBe(false);
        expect(f.ultimoMensaje.de).toBe('escuela');
        expect(f.esperandoDesde).toBeNull();
        expect(f.alerta).toBe(false);
    });

    it('(c) el último mensaje es de la persona hace 5 h: esperando 5 h y en rojo', () => {
        const c = conv();
        const [f] = armarSeguimiento(entrada({
            conversaciones: [c],
            mensajes: [
                ent(c, 400, 'info de la clínica'),
                bot(c, 399, FICHA, { venta_servicio_id: CLINICA.id }),
                ent(c, 300, '¿Con el pago ya tengo el cupo?'),
            ],
        }));
        expect(f.esperandoDesde).toBe(hace(300));
        expect(f.esperandoMin).toBe(300);
        expect(f.alerta).toBe(true);
        expect(f.ultimoMensaje.de).toBe('persona');
    });

    it('el saludo automático de WhatsApp Business no cuenta como respuesta; un «Gracias» no deja a nadie esperando', () => {
        const c1 = conv();
        const c2 = conv();
        const filas = armarSeguimiento(entrada({
            conversaciones: [c1, c2],
            mensajes: [
                ent(c1, 200, '¿Cuánto vale la clínica?'),
                escuela(c1, 199, 'Hola! 👋 Bienvenid@ a Club Monsters Volley', { payload: { automatico: 'true' } }),
                ent(c2, 100, '¿Hasta cuándo es la preventa?'),
                bot(c2, 99, 'La preventa va hasta el martes 10 de noviembre.'),
                ent(c2, 98, 'Muchas gracias'),
            ],
        }));
        const f1 = filas.find((f) => f.conversacionId === c1.id)!;
        const f2 = filas.find((f) => f.conversacionId === c2.id)!;
        expect(f1.respondioBot).toBe(false);
        expect(f1.respondioEscuela).toBe(false);
        expect(f1.esperandoMin).toBe(200);
        expect(f1.ultimoMensaje.de).toBe('automatico');
        expect(f2.esperandoDesde).toBeNull();
    });

    it('(d) el bot dijo «te lo confirma la escuela» y la escuela nunca escribió: pendiente con la pregunta', () => {
        const c = conv();
        const [f] = armarSeguimiento(entrada({
            conversaciones: [c],
            mensajes: [
                ent(c, 600, 'Hola, ¿puedo ir solo el 22? ¿Cuánto sería por un día?'),
                bot(c, 599, 'Por ahora no tengo confirmado si se puede asistir solo el 22 ni si hay un valor por un día. '
                    + 'Eso lo confirma la escuela por aquí, así que quedas pendiente.', { step: 'prospecto_ia' }),
            ],
        }));
        expect(f.esperandoDesde).toBeNull();          // el bot sí contestó…
        expect(f.pendientesEscuela).toEqual([{ texto: 'Hola, ¿puedo ir solo el 22? ¿Cuánto sería por un día?', desde: hace(599) }]);
        expect(f.alerta).toBe(true);                  // …pero la escuela debe una respuesta
    });

    it('(d bis) con la marca `pendiente_escuela` usa esa pregunta; si la escuela escribe después, ya no está pendiente', () => {
        const c1 = conv();
        const c2 = conv();
        const marca = { step: 'venta_pregunta', venta_servicio_id: CLINICA.id, pendiente_escuela: '¿A nombre de quién está la cuenta?' };
        const filas = armarSeguimiento(entrada({
            conversaciones: [c1, c2],
            mensajes: [
                ent(c1, 50, 'titular?'),
                bot(c1, 49, 'Eso te lo confirma la escuela por aquí 🙌', marca),
                ent(c2, 50, 'titular?'),
                bot(c2, 49, 'Eso te lo confirma la escuela por aquí 🙌', marca),
                escuela(c2, 20, 'A nombre de Iván Sossa'),
            ],
        }));
        expect(filas.find((f) => f.conversacionId === c1.id)!.pendientesEscuela)
            .toEqual([{ texto: '¿A nombre de quién está la cuenta?', desde: hace(49) }]);
        expect(filas.find((f) => f.conversacionId === c2.id)!.pendientesEscuela).toEqual([]);
    });

    it('(e) comprobante por la cola + cobro por validar ligado por el comprobante', () => {
        const c = conv({ contact_wa_id: '573124567890' });
        const pago: PagoSeg = {
            id: '9a0c8f8e-1111-4222-8333-444455556666', amount: '300000', status: 'awaiting_approval',
            payment_category: 'clase_extra', concept: 'Clínica de armadores y atacantes', signup_lead_id: null, created_at: hace(30),
        };
        const cola: ComprobanteSeg[] = [
            { wa_phone_number: '573124567890', message_type: 'image', status: 'done', result_type: 'payment_receipt', result_ref_id: pago.id, created_at: hace(31) },
            // Una foto que no era comprobante no cuenta.
            { wa_phone_number: '573124567890', message_type: 'image', status: 'ignored', result_type: 'none', created_at: hace(40) },
        ];
        const [f] = armarSeguimiento(entrada({
            conversaciones: [c],
            mensajes: [
                ent(c, 32, '', { type: 'image' }),
                bot(c, 31, 'Recibí tu comprobante de $300.000 para la clínica. La escuela lo valida y te confirma el cupo por aquí.',
                    { step: 'resultado_comprobante', venta_servicio_id: CLINICA.id }),
            ],
            cola,
            pagos: [pago],
        }));
        expect(f.comprobanteRecibido).toBe(true);
        expect(f.comprobantes).toBe(1);
        expect(f.comprobanteEstado).toBe('Aplicado a un cobro');
        expect(f.cobro).toMatchObject({ monto: 300000, estado: 'awaiting_approval', tipo: 'clase_extra', cuantos: 1 });
        expect(f.primerMensaje.texto).toBe('[imagen]');
        // «la escuela lo valida» por un comprobante no es una pregunta pendiente (va por la Bandeja).
        expect(f.pendientesEscuela).toEqual([]);
    });

    it('el cobro también se liga por el lead del teléfono (prospecto que pagó la clase de prueba)', () => {
        const c = conv({ contact_wa_id: '573001112233' });
        const lead: LeadSeg = { id: 'L-1', phone: '3001112233', full_name: 'Sara Gómez', trial_slot_id: 'T-1' };
        const pago: PagoSeg = { id: 'P-2', amount: 15000, status: 'paid', payment_category: 'clase_prueba', concept: 'Clase de prueba', signup_lead_id: 'L-1', created_at: hace(60) };
        const [f] = armarSeguimiento(entrada({
            conversaciones: [{ ...c, contact_name: null }],
            mensajes: [ent(c, 100, 'Quiero agendar una clase'), bot(c, 99, 'Listo, elige el día', { step: 'embudo_horarios' })],
            leads: [lead], pagos: [pago],
        }));
        expect(f.tema.tipo).toBe('clase_prueba');
        expect(f.contacto.nombre).toBe('Sara Gómez');
        expect(f.cobro).toMatchObject({ monto: 15000, estado: 'paid', tipo: 'clase_prueba' });
    });

    it('(f) el tema es el servicio cuando un saliente lleva `venta_servicio_id`', () => {
        const c = conv();
        const [f] = armarSeguimiento(entrada({
            conversaciones: [c],
            mensajes: [
                ent(c, 80, 'Hola, buenas'),
                bot(c, 79, 'Para separar tu cupo te paso los datos.', { step: 'venta_pago', venta_servicio_id: VACACIONAL.id }),
            ],
        }));
        expect(f.tema).toEqual({ tipo: 'servicio', servicioId: VACACIONAL.id, nombre: VACACIONAL.name });
        expect(f.datosDePagoEnviados).toBe(true);
    });

    it('familia, otro, contactos marcados fuera y conversaciones sin mensajes de la persona fuera', () => {
        const fam = conv({ contact_kind: 'familia', parent_id: 'P1' });
        const otro = conv();
        const personal = conv({ contact_kind: 'personal' });
        const soloCampana = conv();
        const filas = armarSeguimiento(entrada({
            conversaciones: [fam, otro, personal, soloCampana],
            mensajes: [
                ent(fam, 30, '¿Mañana hay entreno?'),
                ent(otro, 30, 'Buenas, ¿con quién hablo para patrocinios?'),
                ent(personal, 30, 'Mijo, ¿vienes a almorzar?'),
                escuela(soloCampana, 30, null as any, { type: 'template', payload: { step: 'campana', campana_id: 'k' } }),
            ],
        }));
        expect(filas.map((f) => [f.conversacionId, f.tema.tipo])).toEqual(expect.arrayContaining([[fam.id, 'familia'], [otro.id, 'otro']]));
        expect(filas).toHaveLength(2);
    });

    it('ignora reacciones y salientes fallidos; un entrante fuera del rango no hace aparecer la conversación', () => {
        const c = conv();
        const viejo = conv();
        const filas = armarSeguimiento(entrada({
            conversaciones: [c, viejo],
            mensajes: [
                ent(c, 60, '¿Qué edad mínima?'),
                bot(c, 59, 'Desde los 12 años.', {}),
                { ...bot(c, 58, 'reintento'), status: 'failed' },
                ent(c, 57, '', { type: 'reaction' }),
                ent(viejo, 8 * 24 * 60, 'Hola'),
            ],
        }));
        expect(filas).toHaveLength(1);
        expect(filas[0].ultimoMensaje.texto).toBe('Desde los 12 años.');
        expect(filas[0].esperandoDesde).toBeNull();
    });

    it('«unsupported»: una edición o un borrado son ruido; un mensaje que Meta no deja leer sí cuenta', () => {
        const c = conv();
        const otra = conv();
        const filas = armarSeguimiento(entrada({
            conversaciones: [c, otra],
            mensajes: [
                ent(c, 60, '¿El pago incluye el almuerzo?'),
                escuela(c, 50, 'Sí señora, incluye refrigerio'),
                ent(c, 40, '', { type: 'unsupported', payload: { tipo_meta: 'edit' } }),
                ent(c, 39, '', { type: 'unsupported', payload: { tipo_meta: 'revoke' } }),
                ent(otra, 30, '', { type: 'unsupported', payload: { tipo_meta: 'unsupported' } }),
            ],
        }));
        const f = filas.find((x) => x.conversacionId === c.id)!;
        expect(f.esperandoDesde).toBeNull();
        expect(f.ultimoMensaje.de).toBe('escuela');
        const g = filas.find((x) => x.conversacionId === otra.id)!;
        expect(g.primerMensaje.texto).toBe('[mensaje no disponible]');
        expect(g.esperandoMin).toBe(30);
    });

    it('ordena primero las rojas y, en cada grupo, lo más reciente primero', () => {
        const a = conv();
        const b = conv();
        const ok = conv();
        const filas = armarSeguimiento(entrada({
            conversaciones: [ok, b, a],
            mensajes: [ent(ok, 5, 'hola'), escuela(ok, 4, 'hola!'), ent(a, 200, '¿precio?'), ent(b, 500, '¿horario?')],
        }));
        expect(filas.map((f) => f.conversacionId)).toEqual([a.id, b.id, ok.id]);
    });
});

describe('resumen, filtros y CSV', () => {
    const c1 = conv();
    const c2 = conv();
    const c3 = conv();
    const filas = armarSeguimiento(entrada({
        conversaciones: [c1, c2, c3],
        mensajes: [
            ent(c1, 300, 'info de la clínica'), bot(c1, 299, FICHA, { venta_servicio_id: CLINICA.id }),
            ent(c2, 300, '=HYPERLINK("x") ¿precio?'),
            ent(c3, 30, 'Hola'), escuela(c3, 20, 'Hola, cuéntame'),
        ],
    }));

    it('cuenta escribieron / respondió la escuela / el bot / sin responder', () => {
        expect(resumirSeguimiento(filas)).toMatchObject({
            escribieron: 3, respondioEscuela: 1, respondioBot: 1, nadieRespondio: 1, sinResponder: 1, esperandoMas2h: 1,
            conDatosDePago: 1, conComprobante: 0, conCobro: 0,
        });
    });

    it('filtra por servicio (id o tema) y por «solo sin responder»', () => {
        expect(filtrarSeguimiento(filas, { servicio: CLINICA.id }).map((f) => f.conversacionId)).toEqual([c1.id]);
        expect(filtrarSeguimiento(filas, { servicio: 'otro' })).toHaveLength(2);
        expect(filtrarSeguimiento(filas, { soloSinResponder: true }).map((f) => f.conversacionId)).toEqual([c2.id]);
    });

    it('CSV para Excel es-CO: BOM, «;», CRLF y sin fórmulas inyectadas', () => {
        const csv = seguimientoCsv(filas);
        expect(csv.startsWith('﻿Contacto;Teléfono;')).toBe(true);
        expect(csv.split('\r\n')).toHaveLength(filas.length + 2);
        expect(csv).toContain(`"'=HYPERLINK(""x"") ¿precio?"`);
        expect(csv).toContain(';Persona;');
    });
});

describe('reglas sueltas', () => {
    const c = conv();
    it('esAcuse: gracias/ok/sticker/cierre sí; una pregunta o un «Sí» no', () => {
        expect(esAcuse(ent(c, 1, 'Gracias!'))).toBe(true);
        expect(esAcuse(ent(c, 1, 'ok'))).toBe(true);
        expect(esAcuse(ent(c, 1, '', { type: 'sticker' }))).toBe(true);
        expect(esAcuse(ent(c, 1, 'Quedo atenta, gracias por la información'))).toBe(true);
        expect(esAcuse(ent(c, 1, 'Vale profe, está bien'))).toBe(true);
        expect(esAcuse(ent(c, 1, 'Ah listo mi profe gracias por tu información'))).toBe(true);
        expect(esAcuse(ent(c, 1, 'Sí'))).toBe(false);
        expect(esAcuse(ent(c, 1, 'Buenas tardes'))).toBe(false);
        expect(esAcuse(ent(c, 1, 'Listo, ya pagué'))).toBe(false);
        expect(esAcuse(ent(c, 1, 'ok, ¿y a qué cuenta?'))).toBe(false);
        expect(esAcuse(ent(c, 1, '', { type: 'image' }))).toBe(false);
    });
    it('esPaseALaEscuela: frases reales del bot; los de comprobante no', () => {
        expect(esPaseALaEscuela(bot(c, 1, 'Voy a pasar tu caso con una persona del equipo de la escuela para ayudarte mejor.'))).toBe(true);
        expect(esPaseALaEscuela(bot(c, 1, '¡Gracias por escribir! 🙌 Ya le pasé tu mensaje a la escuela y te responde por aquí.'))).toBe(true);
        expect(esPaseALaEscuela(bot(c, 1, 'Recibí tu comprobante de $15.000 📄 Se lo paso a la escuela para que lo revise.', { step: 'comprobante_a_la_escuela' }))).toBe(false);
        expect(esPaseALaEscuela(bot(c, 1, 'La preventa va hasta el martes 10.'))).toBe(false);
    });
    it('traeDatosDePago: Nequi / cuenta / llave o el paso de medios de pago', () => {
        expect(traeDatosDePago(bot(c, 1, 'Puedes pagar así: • *Nequi*: 3194505150 (Iván Sossa)'))).toBe(true);
        expect(traeDatosDePago(bot(c, 1, 'x', { step: 'medios_de_pago_publicos' }))).toBe(true);
        expect(traeDatosDePago(bot(c, 1, 'La clínica es el 21 y 22 de noviembre.'))).toBe(false);
    });
    it('enmascara a los últimos 4', () => {
        expect(enmascararTelefono('573124567890')).toBe('••7890');
    });
});

describe('leerRangoSeguimiento', () => {
    const ahora = Date.parse('2026-11-08T03:00:00Z'); // 7 nov 22:00 en Bogotá
    it('por defecto: los últimos 14 días hasta hoy en Bogotá', () => {
        const r = leerRangoSeguimiento(undefined, undefined, ahora);
        expect(r).toMatchObject({ ok: true, desde: '2026-10-25', hasta: '2026-11-07' });
        if (r.ok) {
            expect(new Date(r.desdeMs).toISOString()).toBe('2026-10-25T05:00:00.000Z');
            expect(new Date(r.hastaMs).toISOString()).toBe('2026-11-08T04:59:59.999Z');
        }
    });
    it('máximo 31 días; fechas inválidas o al revés: error', () => {
        expect(leerRangoSeguimiento('2026-10-08', '2026-11-07', ahora).ok).toBe(true);
        expect(leerRangoSeguimiento('2026-10-07', '2026-11-07', ahora)).toEqual({ ok: false, error: 'rango_demasiado_largo' });
        expect(leerRangoSeguimiento('2026-13-01', undefined, ahora)).toEqual({ ok: false, error: 'fecha_invalida' });
        expect(leerRangoSeguimiento('2026-11-07', '2026-11-01', ahora)).toEqual({ ok: false, error: 'rango_invalido' });
    });
});
