/**
 * Caso real — Monster's Volley, contacto 573108863902, domingo 15-nov-2026, 7:37–7:40 p. m. (Bogotá).
 * Venta del «Vacacional de voleibol — Sede Suba». Pagó $140.000 (2 semanas) y el pago NO quedó registrado.
 *
 * Lo que dice la base (whatsapp_messages / whatsapp_inbound_queue de la conversación b63f7b91-…):
 *   19:21:02  bot      «Perfecto. Envía aquí la foto o el PDF del comprobante con el nombre completo de quien asiste…»
 *   19:37:55  cliente  FOTO  → fila f5b9dbaa-… de la cola
 *   19:38:08  cliente  botón «Ya pagué»                 → el bot NO contesta nada (venta_silencio: «lo contesta la cola»)
 *   19:38:09  cola     cierra f5b9dbaa-… `ignored / none / contacto_no_atendido`, SIN escribirle y SIN guardar la lectura
 *   19:38:35  cliente  «La niña Gabriela Reina Fonseca» → la IA: «Gracias, anoté el nombre… Envía aquí la foto…» (no anotó nada)
 *   19:38:46  cliente  «Pago 2 semanas»                 → la IA: «Para 2 semanas el valor es $140.000… Luego envía aquí la foto…»
 *   19:39:32  cliente  la MISMA captura otra vez        → fila ffc6be7f-…, mismo cierre `contacto_no_atendido` (19:40:09)
 *   19:40:30  cliente  «2 semanas: del 23al 27 de noviembre y del 30 de noviembre al 04 de diciembre»
 *   19:40:39  bot      «Eso te lo confirma la escuela por aquí 🙌 Ya le pasé tu pregunta.» (IA: no_esta_en_los_datos)
 *
 * La captura (las dos, guardadas en el bucket) es la pantalla «¡Transferencia exitosa!» recortada: valor $140.000,
 * destino «Ivan Felipe Sossa Benitez · Nequi · 3194505150» (la cuenta de la escuela), origen «Cuenta de Ahorros *3326».
 * NO trae fecha, hora ni número de comprobante.
 *
 * Estas pruebas reproducen el caso con las funciones puras implicadas. ARREGLADO el 2026-11-16: las `it.fails`
 * ya son `it`, y las que fijaban el defecto («DEFECTO») quedaron con el resultado nuevo («ANTES … AHORA …»).
 * La parte de la cola (la captura incompleta) está probada en `jobs/whatsapp-queue-venta.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    atenderBotonDeVenta, atenderVentaDeServicio, accionesDeCierre, comprobanteRecibido, datosDeAsistenteEnVenta,
    intencionEnVenta, pagoRecibidoEnVenta, PASO_VENTA, TEXTO_A_LA_ESCUELA, limpiarRespuestaDeVenta,
    type CtxVentaServicio,
} from './whatsapp-venta-servicio';
import { promptDeServicio } from './whatsapp-servicio-ia';
import type { DatosDeRegistro } from './whatsapp-datos-de-registro';
import { MARCA_VENTA, type VentaActiva } from './whatsapp-venta-contexto';
import type { ItemConFicha } from './whatsapp-anuncio-destino';
import type { PreguntaDeServicio, RespuestaDeServicio } from './whatsapp-servicio-ia';
import { adjuntoEnLaRafaga, type FilaReciente } from './whatsapp-reglas-turno';
import { nombreDeAsistente } from './whatsapp-comprobante-de-ficha.service';
import { nombreYAcompanante } from './wa-nombre-tardio.service';

// ─── Los datos exactos del caso ──────────────────────────────────────────────

const VACACIONAL: ItemConFicha = {
    id: 'fff41827-cd2f-404a-b0ff-f42dc66c59a8', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional' as any,
    price: null as any, active: true, event_id: null,
    starts_at: '2026-11-17 08:00:00-05', ends_at: '2026-12-10 11:00:00-05',
};
const VENTA: VentaActiva = { item: VACACIONAL, origen: 'marca', desde: '2026-11-16T00:15:09Z' };

/** Hora de Bogotá del 15-nov → ISO (UTC−5). */
const bog = (hhmmss: string) => new Date(`2026-11-15T${hhmmss}-05:00`).toISOString();
const ent = (h: string, texto: string | null, extra: Partial<FilaReciente> = {}): FilaReciente =>
    ({ direction: 'inbound', type: 'text', text_body: texto, created_at: bog(h), wa_timestamp: bog(h), ...extra });
const sal = (h: string, texto: string, step: string, extra: Record<string, unknown> = {}): FilaReciente => ({
    direction: 'outbound', type: 'text', text_body: texto, created_at: bog(h), wa_timestamp: bog(h), ai_generated: true,
    payload: { step, [MARCA_VENTA]: VACACIONAL.id, ...extra },
});

const BOT_19_15 = sal('19:15:30', 'Para separar tu cupo en el Vacacional de voleibol — Sede Suba: … Envía aquí la foto del comprobante con el nombre completo de quien asiste y te confirmamos el cupo.', PASO_VENTA.PAGO);
const BOT_19_21 = sal('19:21:02', 'Perfecto. Envía aquí la foto o el PDF del comprobante con el nombre completo de quien asiste, y la escuela lo valida y te confirma el cupo por este chat. Puedes pagar por Nequi o Daviplata al *319 450 5150*, a nombre de *Iván Sossa*.', PASO_VENTA.RESPUESTA);
const FOTO_19_37 = ent('19:37:51', null, { type: 'image' });
const YA_PAGUE_19_38 = ent('19:38:07', 'Ya pagué', { type: 'interactive' });
const NOMBRE = 'La niña Gabriela Reina Fonseca';
const PAGO_2_SEMANAS = 'Pago 2 semanas';
const FECHAS = '2 semanas: del 23al 27 de noviembre y del 30 de noviembre al 04 de diciembre';

/** Lo que el bot tenía a la vista en cada turno. */
const AL_TOCAR_YA_PAGUE = [BOT_19_15, BOT_19_21, FOTO_19_37, YA_PAGUE_19_38];
const AL_ESCRIBIR_EL_NOMBRE = [...AL_TOCAR_YA_PAGUE, ent('19:38:33', NOMBRE)];

function ctxDe(recientes: FilaReciente[], ahora: string, ia: RespuestaDeServicio, enCola = false,
    o: { ficha?: DatosDeRegistro; guarda?: boolean } = {}) {
    const reg = {
        enviados: [] as { texto: string; contexto: Record<string, unknown> }[], anotados: [] as string[], preguntas: [] as PreguntaDeServicio[],
        avisos: [] as string[], datos: [] as DatosDeRegistro[],
    };
    const ctx: CtxVentaServicio = {
        schoolId: 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c', conversationId: 'b63f7b91-150a-4ccc-b4e4-0e1fb7da5934', recientes,
        afiliado: async () => false,
        cuentas: async () => [{ tipo: 'Nequi', numero: '3194505150', titular: 'Iván Sossa' }],
        guardarLead: async () => '5c3f11d9-7945-41cf-88e0-e66ceadad70f',
        registrarEsperado: async () => true,
        responderPregunta: async (p) => { reg.preguntas.push(p); return ia; },
        enviar: async (texto, contexto) => { reg.enviados.push({ texto, contexto }); },
        avisarEscuela: async (d) => { reg.avisos.push(d); },
        // Igual que en producción (whatsapp-bot.service.ts:3035): la ráfaga o la cola.
        comprobanteEnCurso: async () => adjuntoEnLaRafaga(recientes, null, new Date(ahora).getTime()) || enCola,
        anotarAsistente: async (nombre, _item, datos) => {
            if (o.guarda === false) return false;
            reg.anotados.push(nombre);
            if (datos) reg.datos.push(datos);
            return o.ficha ? true : undefined;
        },
        // Con `ficha`: como lo arma el bot para un prospecto (la memoria de quien asiste). Sin ella: como antes.
        ...(o.ficha ? {
            registro: async () => o.ficha as DatosDeRegistro,
            anotarDatos: async (d: DatosDeRegistro) => { if (o.guarda === false) return false; reg.datos.push(d); return true; },
        } : {}),
        ahora: () => new Date(ahora),
    } as CtxVentaServicio;
    return { ctx, reg };
}
const SIN_FICHA: DatosDeRegistro = { nombre: null, fechaNacimiento: null, edad: null, soloEdad: false, acudiente: null, posicion: null };

// ─── 1. La cola: la captura recortada no pasa por «comprobante» y se cierra en silencio ──────────────

describe('la captura «¡Transferencia exitosa!» sin fecha ni número de comprobante', () => {
    // Lo que se lee en la imagen. La lectura real del OCR no quedó guardada (la fila cerró sin `pregunta_ocr`):
    // estos son los campos que la captura trae a la vista; fecha y referencia no están en ella.
    const LECTURA = {
        isReceipt: true, isTransactionList: false, amount: 140000, date: null, time: null, bank: 'Bancolombia',
        reference: null, destination: '3194505150', destinationName: 'Ivan Felipe Sossa Benitez',
    };

    it('`pareceComprobanteDePago` la sigue rechazando (monto sí, pero ni referencia ni fecha): por eso NO se crea el cobro solo. ANTES la fila cerraba `contacto_no_atendido` en silencio · AHORA, con una venta viva, va a la bandeja como acción y al cliente se le pide la pantalla completa (ver whatsapp-queue-venta.test.ts)', async () => {
        const { pareceComprobanteDePago } = await import('../jobs/whatsapp-queue.job');
        expect(pareceComprobanteDePago(LECTURA as any)).toBe(false);
        // Con solo la fecha, o solo el número de comprobante, sí pasaría:
        expect(pareceComprobanteDePago({ ...LECTURA, date: '2026-11-15' } as any)).toBe(true);
        expect(pareceComprobanteDePago({ ...LECTURA, reference: '0000012345' } as any)).toBe(true);
    }, 60_000);
});

// ─── 2. «Ya pagué» justo después de la foto: el bot calla porque «lo contesta la cola» ────────────────

describe('7:38:08 — toca «Ya pagué» 13 s después de la foto', () => {
    it('el bot SÍ ve la foto en la ráfaga (`adjuntoEnLaRafaga`) y por eso no manda nada: deja la respuesta a la cola', async () => {
        const ahora = bog('19:38:09');
        expect(adjuntoEnLaRafaga(AL_TOCAR_YA_PAGUE, null, new Date(ahora).getTime())).toBe(true);
        const { ctx, reg } = ctxDe(AL_TOCAR_YA_PAGUE, ahora, { tipo: 'no_se', motivo: 'x' });
        expect(await atenderBotonDeVenta(ctx, VACACIONAL, 'ya_pague')).toBe('venta_silencio');
        // ANTES la cola cerraba esa foto en silencio un segundo después y NADIE contestaba. AHORA la cola SIEMPRE
        // contesta un archivo con monto de una venta viva (acá: «le faltan la fecha y el número…»), así que el
        // silencio del botón sigue siendo correcto: una sola respuesta.
        expect(reg.enviados).toHaveLength(0);
    });

    it('(R6) después de que la cola pidió la pantalla completa, [Ya pagué] no calla ni pide «el comprobante»: dice qué falta', async () => {
        const COLA = sal('19:38:09', 'Recibí tu captura de *$140.000* 📄 Le faltan la fecha y el número del comprobante…',
            'venta_comprobante_incompleto', { queue_id: 'f5b9dbaa', faltan_datos: ['nombre', 'fecha_nacimiento'] });
        const recientes = [BOT_19_15, BOT_19_21, FOTO_19_37, COLA, ent('19:38:20', 'Ya pagué', { type: 'interactive' })];
        const { ctx, reg } = ctxDe(recientes, bog('19:38:21'), { tipo: 'no_se', motivo: 'x' }, false, { ficha: SIN_FICHA });
        expect(await atenderBotonDeVenta(ctx, VACACIONAL, 'ya_pague')).toBe('venta_ya_pago');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toBe(
            'Ya tengo tu captura 📄 Le faltan la fecha y el número del comprobante: envíame la pantalla completa del pago, por favor.\n\n'
            + 'Para completar la inscripción a *Vacacional de voleibol — Sede Suba* necesito estos datos de quien asiste:\n'
            + '1. Nombre completo\n2. Fecha de nacimiento (día/mes/año)\nSi es menor de edad, también el nombre de la persona responsable.\n'
            + 'Puedes escribirlos en un solo mensaje.');
    });
});

// ─── 3. «La niña Gabriela Reina Fonseca»: no se reconoce como nombre, lo contesta la IA y no se anota ──

describe('7:38:35 — «La niña Gabriela Reina Fonseca»', () => {
    it('ANTES null (el «La» inicial cortaba el nombre) · AHORA «La niña …» se lee en los tres caminos', () => {
        expect(nombreDeAsistente(NOMBRE)).toBe('Gabriela Reina Fonseca');
        expect(datosDeAsistenteEnVenta(NOMBRE, AL_ESCRIBIR_EL_NOMBRE)).toEqual({ nombre: 'Gabriela Reina Fonseca' });
        expect(nombreYAcompanante(NOMBRE)).toEqual({ nombre: 'Gabriela Reina Fonseca', acompanante: null });
        for (const t of ['El niño Juan Pablo Rojas', 'la nena Sara Díaz Mora', 'El joven Andrés Peña', 'Mi hija Laura Gómez', 'mi hijo Tomás Ruiz']) {
            expect(nombreDeAsistente(t), t).not.toBeNull();
        }
        // Un solo nombre de pila no alcanza (se pidió el nombre completo): se sigue preguntando.
        expect(nombreDeAsistente('La niña Gabriela')).toBeNull();
    });

    it('sin «La niña» sí lo reconoce (el bot acababa de pedir «el nombre completo de quien asiste»)', () => {
        expect(nombreDeAsistente('Gabriela Reina Fonseca')).toBe('Gabriela Reina Fonseca');
        expect(datosDeAsistenteEnVenta('Gabriela Reina Fonseca', AL_ESCRIBIR_EL_NOMBRE)).toEqual({ nombre: 'Gabriela Reina Fonseca' });
    });

    it('DESEADO (arreglado): «La niña Gabriela Reina Fonseca» → «Gabriela Reina Fonseca»', () => {
        expect(nombreDeAsistente(NOMBRE)).toBe('Gabriela Reina Fonseca');
    });

    it('el bot tenía la foto a la vista (`comprobanteRecibido`, `pagoRecibidoEnVenta`), pero el camino «detalle» no lo usa', () => {
        const ahora = new Date(bog('19:38:36')).getTime();
        expect(intencionEnVenta(NOMBRE)).toBe('detalle');
        expect(comprobanteRecibido(AL_ESCRIBIR_EL_NOMBRE, 24 * 60, ahora)).toBe(true);
        expect(pagoRecibidoEnVenta(AL_ESCRIBIR_EL_NOMBRE, VENTA, ahora)).toBe(true);
        expect(accionesDeCierre(AL_ESCRIBIR_EL_NOMBRE, ahora)).toBeNull(); // «ya compró»: ni siquiera le pone botones
    });

    const LO_QUE_ESCRIBIO_LA_IA = 'Gracias, anoté el nombre: *Gabriela Reina Fonseca*. Envía aquí la foto o el PDF del comprobante con ese nombre completo, y la escuela lo validará y te confirmará el cupo por este chat. Por ahora no puedo confirmar si el pago ya llegó.';

    it('ANTES iba a la IA («anoté el nombre… Envía aquí la foto…», sin guardar nada) · AHORA es el nombre: se GUARDA y no se le pide el comprobante', async () => {
        const { ctx, reg } = ctxDe(AL_ESCRIBIR_EL_NOMBRE, bog('19:38:36'), { tipo: 'respuesta', texto: LO_QUE_ESCRIBIO_LA_IA });
        expect(await atenderVentaDeServicio(ctx, VENTA, NOMBRE)).toBe('venta_asistente');
        expect(reg.preguntas).toHaveLength(0);                      // no se le pregunta al modelo
        expect(reg.anotados).toEqual(['Gabriela Reina Fonseca']);   // «anoté» ahora es verdad
        expect(reg.enviados[0].contexto.step).toBe(PASO_VENTA.ASISTENTE);
        expect(reg.enviados[0].texto).not.toMatch(/env[ií]a aquí la foto/i);
    });

    it('(R2/R3) como lo arma el bot para un prospecto: guarda el nombre y, en el MISMO mensaje, pide solo lo que falta', async () => {
        const { ctx, reg } = ctxDe(AL_ESCRIBIR_EL_NOMBRE, bog('19:38:36'), { tipo: 'no_se', motivo: 'x' }, false, { ficha: SIN_FICHA });
        expect(await atenderVentaDeServicio(ctx, VENTA, NOMBRE)).toBe('venta_asistente');
        expect(reg.anotados).toEqual(['Gabriela Reina Fonseca']);
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toBe(
            '¡Gracias! 🙌 Anoté a *Gabriela Reina Fonseca* como asistente del Vacacional de voleibol — Sede Suba. '
            + 'La escuela valida tu comprobante y te confirma el cupo por aquí.\n\n'
            + 'Para completar la inscripción a *Vacacional de voleibol — Sede Suba* solo me falta la fecha de nacimiento (día/mes/año).\n'
            + 'Si es menor de edad, también el nombre de la persona responsable.');
        expect(reg.enviados[0].contexto).toMatchObject({ faltan_datos: ['fecha_nacimiento'] });
    });

    it('(R6) si la ficha NO se pudo guardar, el bot no dice «anoté»', async () => {
        const { ctx, reg } = ctxDe(AL_ESCRIBIR_EL_NOMBRE, bog('19:38:36'), { tipo: 'no_se', motivo: 'x' }, false, { ficha: SIN_FICHA, guarda: false });
        expect(await atenderVentaDeServicio(ctx, VENTA, NOMBRE)).toBe('venta_asistente');
        expect(reg.anotados).toEqual([]);
        expect(reg.enviados[0].texto).not.toMatch(/anot|registr|guard/i);
        expect(reg.enviados[0].texto).toMatch(/^¡Gracias! 🙌 La escuela ve en este chat que asiste \*Gabriela Reina Fonseca\*\./);
    });

    it('(R3) después llega la fecha de nacimiento suelta: se guarda en la ficha y se pide SOLO la persona responsable (es menor)', async () => {
        const PIDIO = sal('19:38:40', '¡Gracias! 🙌 Anoté a *Gabriela Reina Fonseca*… solo me falta la fecha de nacimiento', PASO_VENTA.ASISTENTE,
            { faltan_datos: ['fecha_nacimiento'] });
        const recientes = [...AL_ESCRIBIR_EL_NOMBRE, PIDIO, ent('19:39:10', '12/03/2013')];
        const ficha: DatosDeRegistro = { ...SIN_FICHA, nombre: 'Gabriela Reina Fonseca' };
        const { ctx, reg } = ctxDe(recientes, bog('19:39:12'), { tipo: 'no_se', motivo: 'x' }, false, { ficha });
        expect(await atenderVentaDeServicio(ctx, VENTA, '12/03/2013')).toBe('venta_asistente');
        expect(reg.preguntas).toHaveLength(0);
        expect(reg.datos).toEqual([expect.objectContaining({ nombre: 'Gabriela Reina Fonseca', fechaNacimiento: '2013-03-12', edad: 13 })]);
        expect(reg.enviados[0].texto).toBe(
            '¡Gracias! 🙌 Guardé ese dato de *Gabriela Reina Fonseca*. Para completar la inscripción a *Vacacional de voleibol — Sede Suba* '
            + 'solo me falta el nombre de la persona responsable (mamá, papá o acudiente), porque es menor de edad.');
        // …y el nombre de la mamá, suelto, se toma como la persona responsable (no como otra asistente).
        const PIDIO_2 = sal('19:39:14', 'Guardé ese dato… solo me falta el nombre de la persona responsable', PASO_VENTA.ASISTENTE,
            { faltan_datos: ['acudiente'] });
        const conFecha: DatosDeRegistro = { ...ficha, fechaNacimiento: '2013-03-12', edad: 13 };
        const r2 = ctxDe([...recientes, PIDIO_2, ent('19:40:00', 'Sandra Fonseca')], bog('19:40:02'), { tipo: 'no_se', motivo: 'x' }, false, { ficha: conFecha });
        expect(await atenderVentaDeServicio(r2.ctx, VENTA, 'Sandra Fonseca')).toBe('venta_asistente');
        expect(r2.reg.datos).toEqual([expect.objectContaining({ nombre: 'Gabriela Reina Fonseca', acudiente: 'Sandra Fonseca' })]);
        expect(r2.reg.enviados[0].texto).toBe(
            '¡Gracias! 🙌 Con eso quedan completos los datos de *Gabriela Reina Fonseca*. La escuela valida tu comprobante y te confirma el cupo por aquí.');
    });

    it('(R6) la red de la respuesta libre: fuera «anoté…» y, con el archivo ya recibido, fuera «envía aquí la foto…»', () => {
        expect(limpiarRespuestaDeVenta(LO_QUE_ESCRIBIO_LA_IA, { pagado: true })).toEqual({
            texto: 'Por ahora no puedo confirmar si el pago ya llegó.', quito: true,
        });
        // Sin archivo todavía, pedir el comprobante está bien; decir que anotó, nunca.
        expect(limpiarRespuestaDeVenta('Luego envía aquí la foto del comprobante.', { pagado: false })).toEqual({
            texto: 'Luego envía aquí la foto del comprobante.', quito: false,
        });
        expect(limpiarRespuestaDeVenta('Listo, quedó registrado el nombre.', { pagado: false })).toEqual({ texto: null, quito: true });
        expect(limpiarRespuestaDeVenta('La clínica es el 21 y 22 de noviembre.', { pagado: true }).quito).toBe(false);
    });

    it('(R6) el prompt de la IA del servicio le prohíbe «anoté/registré/guardé» y, con el archivo recibido, pedir el comprobante', () => {
        const base = { item: VACACIONAL, afiliado: false, cuentas: [], hoy: '2026-11-15' };
        expect(promptDeServicio(base)).toMatch(/Nunca digas «anoté», «registré», «guardé»/);
        expect(promptDeServicio(base)).not.toMatch(/YA ENVIÓ UN ARCHIVO/);
        expect(promptDeServicio({ ...base, comprobanteRecibido: true })).toMatch(/YA ENVIÓ UN ARCHIVO DE SU PAGO por este chat\. NO le pidas que envíe la foto/);
    });

    it('con el nombre reconocido, el MISMO turno habría anotado el nombre y dicho «la escuela valida tu comprobante»', async () => {
        const recientes = [...AL_TOCAR_YA_PAGUE, ent('19:38:33', 'Gabriela Reina Fonseca')];
        const { ctx, reg } = ctxDe(recientes, bog('19:38:36'), { tipo: 'no_se', motivo: 'x' });
        expect(await atenderVentaDeServicio(ctx, VENTA, 'Gabriela Reina Fonseca')).toBe('venta_asistente');
        expect(reg.anotados).toEqual(['Gabriela Reina Fonseca']);
        expect(reg.preguntas).toHaveLength(0);
        expect(reg.enviados[0].texto).toMatch(/La escuela valida tu comprobante/);
        expect(reg.enviados[0].texto).not.toMatch(/Envía aquí la foto/);
    });
});

// ─── 4. «Pago 2 semanas» y las fechas: los dos son «detalle» y van a la IA ────────────────────────────

describe('7:38:46 «Pago 2 semanas» y 7:40:30 «2 semanas: del 23al 27…»', () => {
    it('ninguno de los dos se lee como «ya pagué» ni como pedido de datos: los dos son «detalle» (IA)', () => {
        expect(intencionEnVenta(PAGO_2_SEMANAS)).toBe('detalle');
        expect(intencionEnVenta(FECHAS)).toBe('detalle');
        // «Pagué 2 semanas» tampoco es «ya pagué» sin el «ya»:
        expect(intencionEnVenta('Pagué 2 semanas')).toBe('detalle');
    });

    it('ANTES «Pago 2 semanas» con la foto ya recibida → la IA volvía a pedir el comprobante · AHORA la red lo quita y dice que ya lo tiene', async () => {
        const recientes = [...AL_ESCRIBIR_EL_NOMBRE, ent('19:38:43', PAGO_2_SEMANAS)];
        const ia = 'Para 2 semanas el valor es *$140.000*. Puedes pagar por Nequi o Daviplata al *319 450 5150*, a nombre de *Iván Sossa*. Luego envía aquí la foto o el PDF del comprobante con el nombre completo de quien asiste para que la escuela lo valide y te confirme el cupo.';
        const { ctx, reg } = ctxDe(recientes, bog('19:38:47'), { tipo: 'respuesta', texto: ia });
        expect(await atenderVentaDeServicio(ctx, VENTA, PAGO_2_SEMANAS)).toBe('venta_respuesta');
        expect(reg.preguntas[0].comprobanteRecibido).toBe(true);     // el modelo lo sabe por el prompt
        expect(reg.enviados[0].texto).not.toMatch(/envía aquí la foto/i);
        expect(reg.enviados[0].texto).toBe('Para 2 semanas el valor es *$140.000*. Puedes pagar por Nequi o Daviplata al *319 450 5150*, a nombre de *Iván Sossa*. '
            + 'Ya tenemos tu comprobante 📄 La escuela lo valida y te confirma el cupo por aquí.');
        expect(reg.enviados[0].contexto).toMatchObject({ red_de_respuesta: true });
    });

    it('las fechas que eligió (la IA contestó NO_SE) → «Eso te lo confirma la escuela… Ya le pasé tu pregunta» + aviso al buzón; la venta no se cierra', async () => {
        const recientes = [...AL_ESCRIBIR_EL_NOMBRE, ent('19:38:43', PAGO_2_SEMANAS), ent('19:39:28', null, { type: 'image' }), ent('19:40:28', FECHAS)];
        // Con la segunda foto 60 s antes y sin respuesta de la cola en medio... en producción hubo dos salientes
        // de la IA (19:38:44 y 19:38:53) ANTES de la segunda foto, así que la ráfaga la contaba: aquí se agregan.
        const conSalientes = [...recientes,
            sal('19:38:44', 'Gracias, anoté el nombre…', PASO_VENTA.RESPUESTA), sal('19:38:53', 'Para 2 semanas el valor es…', PASO_VENTA.RESPUESTA)];
        const { ctx, reg } = ctxDe(conSalientes, bog('19:40:31'), { tipo: 'no_se', motivo: 'no_esta_en_los_datos' });
        expect(await atenderVentaDeServicio(ctx, VENTA, FECHAS)).toBe('venta_a_la_escuela');
        expect(reg.enviados[0].texto).toBe(TEXTO_A_LA_ESCUELA);
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.A_LA_ESCUELA, servicio_ia_motivo: 'no_esta_en_los_datos' });
        expect(reg.avisos).toHaveLength(1); // esto SÍ llegó a la escuela (por eso escribió al día siguiente)
    });
});
