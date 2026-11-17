/**
 * Caso real — Monster's Volley, 2026-11-15, contacto …5201 (cola 4ac2639a-…).
 *
 *  16:38  foto de un comprobante de Nequi por $200.000. En la nota del propio comprobante:
 *         «Jesús Giovanni Solarte Chala Posición: Armador Año de nacimiento: 22/06/2007 Pago: apartar el cupo
 *         con el 5% de descuento. Evento 21 y22 noviem» (así quedó en `pregunta_ocr.ocr.description`).
 *  16:39  bot: «Recibí tu comprobante de $200.000 📄 ¿Cuál es el nombre completo de quien asiste a la Clínica…?»
 *         (fila `waiting_user`, tipo `asistente_servicio`).
 *  17:19  una persona de la escuela, desde el celular del negocio: «Por favor los datos puestos en el
 *         comprobante deben ser escritos por acá muchas gracias».
 *  17:35  cliente: «Jesús Giovanni Solarte Chala / Posición: Armador / Año de nacimiento: 22/06/2007».
 *  17:35:47  la fila quedó `ignored`, `error_message = 'la escuela tomó la conversación'`, sin cobro, sin
 *         prospecto y sin respuesta al cliente.
 *
 * Estas pruebas reproducen el caso con los datos exactos. ARREGLADO el 2026-11-16: las que eran `it.fails`
 * (el comportamiento deseado) ya son `it`, y las que fijaban el defecto («ACTUAL (defecto)») quedaron con el
 * resultado nuevo (marcadas «ANTES … AHORA …»).
 *
 * Supabase mockeado (mismo builder de whatsapp-auditoria-2026-10-10.test.ts). No toca la base.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    filaEsperando: null as any,
    conv: null as any,
    salientes: [] as any[],
    updates: [] as { table: string; v: any }[],
}));

vi.mock('../config/supabase', () => {
    const builder = (table: string) => {
        const b: any = {};
        for (const m of ['select', 'eq', 'in', 'order', 'limit', 'neq', 'is', 'not', 'gte', 'lte', 'lt', 'or']) {
            b[m] = () => b;
        }
        b.update = (v: any) => { h.updates.push({ table, v }); return b; };
        b.maybeSingle = () => Promise.resolve(
            table === 'whatsapp_inbound_queue' ? { data: h.filaEsperando, error: null }
                : table === 'whatsapp_conversations' ? { data: h.conv, error: null }
                    : { data: null, error: null });
        b.then = (res: any, rej: any) => Promise.resolve(
            table === 'whatsapp_messages' ? { data: h.salientes, error: null } : { data: [], error: null },
        ).then(res, rej);
        return b;
    };
    return { supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) } };
});
vi.mock('./cobro-enlace-publico.service', () => ({ emitirTokenCobro: vi.fn(async () => null) }));
const aplicarComprobanteDeVentaMock = vi.fn(async (..._a: any[]) => undefined);
vi.mock('../jobs/whatsapp-queue.job', () => ({
    aplicarComprobante: vi.fn(async () => undefined),
    aplicarComprobanteConMotivo: vi.fn(async () => undefined),
    aplicarComprobanteDeVenta: (...a: any[]) => aplicarComprobanteDeVentaMock(...a),
}));

import {
    resolverRespuestaDeCobro, escuelaEscribioDespues, MOTIVO_ESCUELA_TOMO,
} from './whatsapp-respuesta-de-cobro.service';
import { nombreDeAsistente, nombreDeAsistenteEnTextos } from './whatsapp-comprobante-de-ficha.service';
import { datosDeAsistenteEnVenta } from './whatsapp-venta-servicio';
import { nombreYAcompanante } from './wa-nombre-tardio.service';
import { decidirMontoDeVenta, type ItemDeServicio } from './wa-cobro-desde-comprobante.service';
import { clasificarFila, motivoDeFila } from './whatsapp-bandeja.service';
import { faltantesDe, registroDeNota } from './wa-registro-de-venta.service';
import type { FilaReciente } from './whatsapp-reglas-turno';

// ─── Los datos exactos del caso ─────────────────────────────────────────────

const NOMBRE = 'Jesús Giovanni Solarte Chala';
/** `pregunta_ocr.ocr.description` de la fila de la cola (lo que el OCR leyó de la nota del Nequi). */
const NOTA_DEL_COMPROBANTE = 'Jesús Giovanni Solarte Chala Posición: Armador Año de nacimiento: 22/06/2007 '
    + 'Pago: apartar el cupo con el 5% de descuento. Evento 21 y22 noviem';
/** El entrante de las 17:35 (tal cual, con el espacio antes del salto de línea). */
const RESPUESTA_DEL_CLIENTE = 'Jesús Giovanni Solarte Chala \nPosición: Armador\nAño de nacimiento: 22/06/2007';
const PREGUNTA_DEL_BOT = 'Hola 👋 soy Mapi, el asistente virtual de Monster´s Volley Club.\n\n'
    + 'Recibí tu comprobante de *$200.000* 📄 ¿Cuál es el nombre completo de quien asiste a la *Clínica de armadores y atacantes*?';
const TEXTO_DE_LA_ESCUELA = 'Por favor los datos puestos en el comprobante deben ser escritos por acá muchas gracias';

/** La fila real de `school_tournament_items` (16766d2e-…), leída el 2026-11-16. */
const CLINICA: ItemDeServicio = {
    id: '16766d2e-f8b0-4285-88e3-b1e67dda6d45',
    name: 'Clínica de armadores y atacantes',
    kind: 'clase_extra',
    price: 300000,
    active: true,
    event_id: null,
    starts_at: '2026-11-21T00:00:00-05:00',
    ends_at: '2026-11-22T23:59:00-05:00',
    precio_afiliado: 250000,
    precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    precios_afiliado_por_fecha: [{ desde: '2026-11-16', precio: 300000 }],
    abono_minimo_pct: 50,
    allow_installments: true,
    opciones: null,
};

const T_COMPROBANTE = Date.parse('2026-11-15T16:38:33-05:00');
const T_PREGUNTA = '2026-11-15T16:39:18.338-05:00';
const T_ESCUELA = '2026-11-15T17:19:17.614-05:00';

/** El eco de Coexistence de las 17:19 tal como está en `whatsapp_messages` (sin `step`, sin `automatico`). */
const ECO_DE_LA_ESCUELA: FilaReciente = {
    direction: 'outbound', type: 'text', text_body: TEXTO_DE_LA_ESCUELA, ai_generated: false,
    payload: { from: '573188682241', to: '573023345201', type: 'text', text: { body: TEXTO_DE_LA_ESCUELA } } as any,
    wa_timestamp: null, created_at: T_ESCUELA,
} as any;

// ─── 1. La respuesta de tres líneas SÍ es un nombre ─────────────────────────

describe('caso clínica · la respuesta de 3 líneas («Nombre / Posición: … / Año de nacimiento: …»)', () => {
    it('nombreDeAsistente la reconoce: corta en «Posición» y deja el nombre completo', () => {
        expect(nombreDeAsistente(RESPUESTA_DEL_CLIENTE)).toBe(NOMBRE);
    });
    it('datosDeAsistenteEnVenta (el camino del bot de ventas) también', () => {
        expect(datosDeAsistenteEnVenta(RESPUESTA_DEL_CLIENTE, [
            { direction: 'outbound', text_body: PREGUNTA_DEL_BOT, ai_generated: true, created_at: T_PREGUNTA } as any,
        ])).toEqual({ nombre: NOMBRE });
    });
    it('nombreYAcompanante (nombre tardío) también — pero ese camino solo mira filas `done`/`payment_receipt`', () => {
        expect(nombreYAcompanante(RESPUESTA_DEL_CLIENTE)).toEqual({ nombre: NOMBRE, acompanante: null });
    });
});

// ─── 2. El nombre YA venía en la nota del comprobante y no se leyó ──────────

describe('caso clínica · el nombre en la nota del comprobante (ocr.description)', () => {
    it('ANTES null (y el bot preguntaba) · AHORA: nombreDeAsistenteEnTextos saca el nombre de la nota, con lo que escribió antes en el chat', () => {
        // Sin pie de foto (`media_caption` null), con la descripción que leyó el OCR y lo que escribió antes en el chat.
        expect(nombreDeAsistenteEnTextos([null, NOTA_DEL_COMPROBANTE], CLINICA.name, [
            'Ya envío el comprobante de pago para apartar el cupo. Este número de nequi me confirma 3194505150',
        ])).toBe(NOMBRE);
    });
    it('por qué: en un pie solo vale un texto que sea ENTERO el nombre (`entero: true`), y acá siguen «Posición…»', () => {
        expect(nombreDeAsistente(NOTA_DEL_COMPROBANTE)).toBe(NOMBRE);                    // el comienzo sí es el nombre
        expect(nombreDeAsistente(NOTA_DEL_COMPROBANTE, { entero: true })).toBeNull();    // pero no es «solo» el nombre
    });
    it('DESEADO (arreglado): la nota «Nombre + Posición + fecha de nacimiento» da el nombre sin preguntar', () => {
        expect(nombreDeAsistenteEnTextos([null, NOTA_DEL_COMPROBANTE], CLINICA.name, [])).toBe(NOMBRE);
    });
    it('la memoria de la venta lee de esa nota el nombre, la fecha de nacimiento y la posición: no falta nada (es mayor de edad)', () => {
        const d = registroDeNota([NOTA_DEL_COMPROBANTE, null], { hoy: '2026-11-15', titular: 'Ivan Felipe Sossa Benitez' });
        expect(d).toMatchObject({ nombre: NOMBRE, fechaNacimiento: '2007-06-22', edad: 19, posicion: 'armador' });
        expect(faltantesDe(d, '2026-11-15')).toEqual([]);
    });
    it('una nota que es SOLO el titular de la cuenta de la escuela no es quien asiste', () => {
        expect(registroDeNota(['Ivan Felipe Sossa Benitez'], { hoy: '2026-11-15', titular: 'Ivan Felipe Sossa Benitez' }).nombre).toBeNull();
        expect(registroDeNota(['Jesús Giovanni Solarte Chala'], { hoy: '2026-11-15', titular: 'Ivan Felipe Sossa Benitez' }).nombre).toBe(NOMBRE);
    });
});

// ─── 3. Los $200.000 SÍ cuadran: es un abono válido ─────────────────────────

describe('caso clínica · $200.000 contra la Clínica ($350.000 desde el 11-nov, abono mínimo 50 %)', () => {
    it('el día del pago (15-nov, no afiliado): abono de $350.000 con mínimo $175.000', () => {
        const d = decidirMontoDeVenta(200000, CLINICA, { ahora: T_COMPROBANTE, afiliado: false, fechaPago: '2026-11-15' });
        expect(d).toMatchObject({ tipo: 'abono', total: 350000, minimo: 175000 });
    });
    it('procesado hoy (16-nov) sigue siendo abono para un no afiliado (el precio de lista no cambió)', () => {
        const d = decidirMontoDeVenta(200000, CLINICA, {
            ahora: Date.parse('2026-11-16T18:00:00-05:00'), afiliado: false, fechaPago: '2026-11-15',
        });
        expect(d).toMatchObject({ tipo: 'abono', total: 350000, minimo: 175000 });
    });
    it('ojo: $200.000 NO es «$350.000 con el 5 % de descuento» ($332.500); el saldo que espera el cliente es $132.500, no $150.000', () => {
        // La escuela le dijo por el chat «$332.500» y «con $200.000 se puede apartar». El bot no conoce ese descuento:
        // el cobro que crearía es de $350.000 (saldo $150.000). No es la causa de que no se registrara.
        const d = decidirMontoDeVenta(200000, CLINICA, { ahora: T_COMPROBANTE, afiliado: false, fechaPago: '2026-11-15' });
        expect(d.tipo === 'abono' ? d.total - 200000 : null).toBe(150000);
    });
});

// ─── 4. La causa: el mensaje de la escuela de las 17:19 cierra la pregunta ──

describe('caso clínica · el mensaje de la escuela (17:19) entre la pregunta (16:39) y la respuesta (17:35)', () => {
    it('escuelaEscribioDespues: el eco del celular del negocio cuenta como «la escuela tomó la conversación»', () => {
        expect(escuelaEscribioDespues([ECO_DE_LA_ESCUELA], T_PREGUNTA)).toBe(true);
    });

    /** La fila `waiting_user` tal como estaba a las 17:35 (horas relativas a ahora para no vencer las 24 h). */
    const PREGUNTA_AT = new Date(Date.now() - 56 * 60_000).toISOString();
    const filaEsperando = () => ({
        id: '4ac2639a-3abd-42fd-8836-61f1361f0555',
        school_id: 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c',
        retries: 0,
        pregunta_at: PREGUNTA_AT,
        pregunta_opciones: [],
        pregunta_ocr: {
            tipo: 'asistente_servicio',
            ocr: { amount: 200000, bank: 'Nequi', date: '2026-11-15', reference: 'M15485762', destination: '319 450 5150',
                description: NOTA_DEL_COMPROBANTE },
            sha: 'de755b9e', storagePath: 'x', parentId: null,
            venta: { itemId: CLINICA.id, itemNombre: CLINICA.name, esperadoId: null, leadId: null, conversationId: '35ec808b' },
        },
    });
    const ecoRelativo = () => ({ ...ECO_DE_LA_ESCUELA, created_at: new Date(Date.parse(PREGUNTA_AT) + 40 * 60_000).toISOString() });

    beforeEach(() => {
        h.filaEsperando = filaEsperando();
        h.conv = { id: '35ec808b' };
        h.salientes = [];
        h.updates = [];
        aplicarComprobanteDeVentaMock.mockClear();
    });

    it('ANTES la respuesta se tragaba (fila `ignored`, sin cobro) · AHORA (R5): el cobro se crea y el bot NO le habla encima a la escuela', async () => {
        h.salientes = [ecoRelativo()];
        const responder = vi.fn(async (..._a: any[]) => undefined);
        const consumio = await resolverRespuestaDeCobro({ id: '090b0237', school_id: filaEsperando().school_id } as any,
            '573023345201', RESPUESTA_DEL_CLIENTE, responder);
        expect(consumio).toBe(true);
        expect(responder).not.toHaveBeenCalled();                      // el responder del chat no se usa: la escuela está escribiendo
        expect(aplicarComprobanteDeVentaMock).toHaveBeenCalledTimes(1);
        const [queueId, nombre, callado] = aplicarComprobanteDeVentaMock.mock.calls[0];
        expect([queueId, nombre]).toEqual(['4ac2639a-3abd-42fd-8836-61f1361f0555', NOMBRE]);
        expect(callado).not.toBe(responder);
        expect(await callado('Recibí tu comprobante…', 'venta_comprobante_recibido')).toMatchObject({ silenciado: true });
        // La fila NO se cierra como «la escuela tomó la conversación»; la fecha y la posición viajan en ella.
        expect(h.updates.some((u) => u.v?.error_message === MOTIVO_ESCUELA_TOMO)).toBe(false);
        expect(h.updates.at(-1)?.v?.pregunta_ocr?.venta?.registro).toMatchObject({ nombre: NOMBRE, fechaNacimiento: '2007-06-22', posicion: 'armador' });
    });

    it('(R5) la escuela escribe y el cliente contesta «gracias» (sin datos): la fila queda como ACCIÓN con monto, servicio y propuesta', async () => {
        h.salientes = [ecoRelativo()];
        const responder = vi.fn(async (..._a: any[]) => undefined);
        const consumio = await resolverRespuestaDeCobro({ id: '090b0237', school_id: filaEsperando().school_id } as any,
            '573023345201', 'Muchas gracias', responder);
        expect(consumio).toBe(true);
        expect(responder).not.toHaveBeenCalled();
        expect(aplicarComprobanteDeVentaMock).not.toHaveBeenCalled();
        const cierre = h.updates.at(-1)!;
        expect(cierre).toMatchObject({ table: 'whatsapp_inbound_queue', v: { status: 'ignored', result_type: 'escalated' } });
        expect(cierre.v.error_message).toMatch(/^venta_falta_nombre: comprobante de \$\s?200\.000 para Clínica de armadores y atacantes; la escuela escribió en el chat/);
        expect(cierre.v.error_message).toContain('Propuesta → pagó: no se leyó · asiste: sin nombre');
        expect(cierre.v.error_message).toContain('crear el cobro del servicio y aplicar este comprobante');
        expect(clasificarFila({ id: 'x', status: 'ignored', error_message: cierre.v.error_message }, 'desconocido', false))
            .toMatchObject({ grupo: 'accion', motivo: 'venta_faltan_datos', etiqueta: 'Pago de un servicio: faltan los datos de quien asiste' });
    });

    it('(R5) para una pregunta «¿de qué deportista?» (familias) NO cambia nada: se cierra como antes', async () => {
        h.filaEsperando = { ...filaEsperando(), pregunta_ocr: { ...filaEsperando().pregunta_ocr, tipo: 'deportista', venta: undefined } };
        h.salientes = [ecoRelativo()];
        const responder = vi.fn(async (..._a: any[]) => undefined);
        expect(await resolverRespuestaDeCobro({ id: '090b0237', school_id: filaEsperando().school_id } as any,
            '573023345201', RESPUESTA_DEL_CLIENTE, responder)).toBe(true);
        expect(aplicarComprobanteDeVentaMock).not.toHaveBeenCalled();
        expect(h.updates.at(-1)).toMatchObject({ v: { status: 'ignored', error_message: MOTIVO_ESCUELA_TOMO } });
    });

    it('contraprueba: SIN el mensaje de la escuela, la misma respuesta crea el cobro a nombre de Jesús', async () => {
        const responder = vi.fn(async (..._a: any[]) => undefined);
        const consumio = await resolverRespuestaDeCobro({ id: '090b0237', school_id: filaEsperando().school_id } as any,
            '573023345201', RESPUESTA_DEL_CLIENTE, responder);
        expect(consumio).toBe(true);
        expect(aplicarComprobanteDeVentaMock).toHaveBeenCalledWith('4ac2639a-3abd-42fd-8836-61f1361f0555', NOMBRE, responder);
    });

    it('DESEADO (arreglado): aunque la escuela haya escrito, si la respuesta ES el nombre que se pidió, el cobro se registra', async () => {
        h.salientes = [ecoRelativo()];
        const responder = vi.fn(async (..._a: any[]) => undefined);
        await resolverRespuestaDeCobro({ id: '090b0237', school_id: filaEsperando().school_id } as any,
            '573023345201', RESPUESTA_DEL_CLIENTE, responder);
        expect(aplicarComprobanteDeVentaMock).toHaveBeenCalledWith('4ac2639a-3abd-42fd-8836-61f1361f0555', NOMBRE, expect.anything());
    });
});

// ─── 5. Cómo queda en la Bandeja de comprobantes ────────────────────────────

describe('caso clínica · la fila cerrada en la Bandeja', () => {
    const fila = { id: '4ac2639a', status: 'ignored', error_message: MOTIVO_ESCUELA_TOMO, result_type: null, result_ref_id: null };
    it('ANTES caía en «Sin clasificar» (revisar) · AHORA: una fila vieja con ese motivo es ACCIÓN, con etiqueta clara', () => {
        expect(motivoDeFila(fila)).toEqual({ motivo: 'escuela_tomo', detalle: MOTIVO_ESCUELA_TOMO });
        expect(clasificarFila(fila, 'desconocido', false)).toMatchObject({
            grupo: 'accion', etiqueta: 'La escuela escribió en el chat: aplicarlo a mano',
        });
    });
    it('los códigos de la venta (`venta_*`) son ACCIÓN; el comprobante repetido es informativo', () => {
        const de = (em: string) => clasificarFila({ id: 'x', status: 'ignored', error_message: em, result_type: 'escalated' }, 'desconocido', false);
        expect(de('venta_monto_no_cuadra: comprobante de $15.000 para X | Propuesta → …')).toMatchObject({ grupo: 'accion', motivo: 'venta_servicio' });
        expect(de('venta_falta_nombre: no dijo el nombre de quien asiste a X en 24 h')).toMatchObject({ grupo: 'accion', motivo: 'venta_faltan_datos' });
        expect(de('venta_comprobante_incompleto: captura de $140.000 para X')).toMatchObject({
            grupo: 'accion', motivo: 'venta_incompleto', etiqueta: 'Pago de un servicio: captura sin fecha ni número',
        });
        expect(de('venta_comprobante_repetido: misma imagen que el cobro p1')).toMatchObject({ grupo: 'informativo', motivo: 'duplicado' });
        // Las comparaciones exactas de siempre no cambian.
        expect(de('contacto_no_atendido')).toMatchObject({ grupo: 'revisar', motivo: 'contacto_no_atendido' });
    });
});
