/**
 * CASO REAL — Monster's Volley, 2026-11-15, contacto «Brady Luz» (@bradyluz), Vacacional de voleibol — Sede Suba.
 * Conversación 63687282-…, fila de la cola d91f1aaa-… (comprobante de $140.000 al Nequi de la escuela).
 *
 * Qué pasó (reconstruido de la base, solo lectura):
 *   18:55:33  «Hola buenas noches. Interesadísimas vacacional 2 semanas (…).\nGabriela Covaleda García\n13 años 6 meses»
 *   18:56:20  bot: datos de pago (step venta_servicio_pago, botón [Ya pagué])
 *   18:58:43  foto del comprobante
 *   18:59:33  bot: «Recibí tu comprobante de $140.000 📄 ¿Cuál es el nombre completo de quien asiste…?»
 *             (step ask_asistente_servicio; la fila queda waiting_user, tipo asistente_servicio)
 *   18:59:56  «Comparto soporte pago vacacional 2 semanas (…).\nGabriela Covaleda García\n13 años 6 meses»  → SILENCIO
 *   19:00:46  botón [Ya pagué]                                                                              → SILENCIO
 *   16-nov 17:01:19  una persona de la escuela escribe «Hola cómo estás»
 *   16-nov 17:01:41  «Buenas tardes» → la pregunta se cierra `ignored` con «la escuela tomó la conversación»
 *   Nunca hubo cobro (payments), ni fila en wa_cobros_desde_comprobante; el concepto esperado sigue sin consumir.
 *
 * OJO: el contacto NO es un alias `wau-…`. Aunque WhatsApp lo muestre como @bradyluz, el webhook trajo su
 * teléfono (`from`) además del `from_user_id`; la conversación, la cola, el prospecto y el concepto esperado
 * están llaveados por el celular. La rama de «contacto sin teléfono» no participó.
 *
 * Estas pruebas llaman a las funciones PURAS con los datos exactos. ARREGLADO el 2026-11-16: las que eran
 * `it.fails` (el comportamiento deseado) ya son `it`; las que fijaban el defecto quedaron con el resultado nuevo
 * (marcadas «ANTES … AHORA …»).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import { nombreDeAsistente, nombreDeAsistenteEnTextos } from './whatsapp-comprobante-de-ficha.service';
import { nombreYAcompanante } from './wa-nombre-tardio.service';
import {
    intencionEnVenta, datosDeAsistenteEnVenta, comprobanteRecibido, accionesDeCierre,
} from './whatsapp-venta-servicio';
import { adjuntoEnLaRafaga, esHumanoDeLaEscuela, type FilaReciente } from './whatsapp-reglas-turno';
import { decidirMontoDeVenta, esNombreDeRelleno, type ItemDeServicio } from './wa-cobro-desde-comprobante.service';
import { variantesTelefonoLead } from './whatsapp-prospecto-lead.service';
import { esAliasDeUsuario, aliasDeBsuid, claveDeContacto } from './whatsapp-usuario-meta';
import { soloSaludoOCortesia } from './whatsapp-atencion.service';
import { comprobanteEnCurso } from './whatsapp-bot.service';
import { faltantesDe, registroDeChatPrevio, registroDeMensajePrevio, leerRespuestaDeDatos } from './wa-registro-de-venta.service';
import { preguntaDeDatosDeServicio } from './whatsapp-comprobante-de-ficha.service';
import {
    atenderBotonDeVenta, atenderVentaDeServicio, cierreDePagoSegunRegistro, CIERRE_DE_PAGO, PASO_VENTA, type CtxVentaServicio,
} from './whatsapp-venta-servicio';
import { MARCA_VENTA } from './whatsapp-venta-contexto';
import type { DatosDeRegistro } from './whatsapp-datos-de-registro';

// ─── Los datos exactos del caso ─────────────────────────────────────────────

const TELEFONO = '573114579340';
const BSUID = 'CO.1425068409797852';
const ITEM_ID = 'fff41827-cd2f-404a-b0ff-f42dc66c59a8';
const QUEUE_ID = 'd91f1aaa-4783-4ba9-9c48-42ff14f25ef8';
const SERVICIO = 'Vacacional de voleibol — Sede Suba';

const PRIMER_MENSAJE = 'Hola buenas noches. Interesadísimas vacacional 2 semanas (semana 2 y semana 3 - 23 de noviembre al 4 de diciembre).\nGabriela Covaleda García\n13 años 6 meses';
const RESPUESTA = 'Comparto soporte pago vacacional 2 semanas (23 de noviembre al 4 de diembre).\nGabriela Covaleda García\n13 años 6 meses';
const PREGUNTA = `Recibí tu comprobante de *$140.000* 📄 ¿Cuál es el nombre completo de quien asiste al *${SERVICIO}*?`;

/** El vacacional tal como está en `school_tournament_items`. */
const VACACIONAL: ItemDeServicio = {
    id: ITEM_ID, name: SERVICIO, kind: 'vacacional', price: 100000, active: true, event_id: null,
    starts_at: '2026-11-17T08:00:00-05:00', ends_at: '2026-12-10T11:00:00-05:00',
    precio_afiliado: null, precios_por_fecha: null, precios_afiliado_por_fecha: null,
    abono_minimo_pct: null, allow_installments: false,
    opciones: [
        { clave: '1', etiqueta: '1 semana', precio: 100000, precio_afiliado: 80000 },
        { clave: '2', etiqueta: '2 semanas', precio: 140000, precio_afiliado: 120000 },
        { clave: '3', etiqueta: '3 semanas', precio: 170000, precio_afiliado: 150000 },
        { clave: '4', etiqueta: '4 semanas', precio: 200000, precio_afiliado: 170000 },
    ],
};

const at = (hms: string, dia = '2026-11-15') => `${dia}T${hms}-05:00`;
const ms = (hms: string, dia = '2026-11-15') => new Date(at(hms, dia)).getTime();

/** Los mensajes de la conversación el 15-nov, con sus `step` reales. */
const M_TEXTO_1: FilaReciente = { direction: 'inbound', type: 'text', text_body: PRIMER_MENSAJE, ai_generated: false, created_at: at('18:55:33') };
const M_FICHA: FilaReciente = { direction: 'outbound', type: 'text', ai_generated: true, created_at: at('18:55:42'), payload: { step: 'desconocido_tema_escolar', venta_servicio_id: ITEM_ID } };
const M_BOTONES: FilaReciente = { direction: 'outbound', type: 'interactive', ai_generated: true, created_at: at('18:55:44'), payload: { step: 'venta_servicio_detalles', venta_servicio_id: ITEM_ID } };
const M_SEPARAR: FilaReciente = { direction: 'inbound', type: 'interactive', text_body: 'Separar mi cupo', ai_generated: false, created_at: at('18:56:14') };
const M_PAGO: FilaReciente = { direction: 'outbound', type: 'interactive', ai_generated: true, created_at: at('18:56:20'), payload: { step: 'venta_servicio_pago', venta_servicio_id: ITEM_ID, datos_de_pago: true } };
const M_FOTO: FilaReciente = { direction: 'inbound', type: 'image', text_body: '', ai_generated: false, created_at: at('18:58:43') };
const M_PREGUNTA: FilaReciente = { direction: 'outbound', type: 'text', text_body: PREGUNTA, ai_generated: true, created_at: at('18:59:33'), payload: { step: 'ask_asistente_servicio', queue_id: QUEUE_ID, venta_servicio_id: ITEM_ID } };
const M_RESPUESTA: FilaReciente = { direction: 'inbound', type: 'text', text_body: RESPUESTA, ai_generated: false, created_at: at('18:59:56') };
const M_YA_PAGUE: FilaReciente = { direction: 'inbound', type: 'interactive', text_body: 'Ya pagué', ai_generated: false, created_at: at('19:00:46') };
const M_ESCUELA: FilaReciente = { direction: 'outbound', type: 'text', text_body: 'Hola cómo estás', ai_generated: false, created_at: at('17:01:19', '2026-11-16'), payload: { type: 'text' } };

const HASTA_LA_RESPUESTA = [M_TEXTO_1, M_FICHA, M_BOTONES, M_SEPARAR, M_PAGO, M_FOTO, M_PREGUNTA, M_RESPUESTA];
const HASTA_YA_PAGUE = [...HASTA_LA_RESPUESTA, M_YA_PAGUE];

/** Lo que se propone: buscar el nombre línea por línea (una línea que sea SOLO un nombre). */
const nombrePorLineas = (texto: string): string | null =>
    texto.split(/\r?\n/).map((l) => nombreDeAsistente(l.trim(), { entero: true })).find(Boolean) ?? null;

// ─── 0. La premisa: ¿es un contacto sin teléfono? ───────────────────────────

describe('0. el contacto @bradyluz NO es un alias wau- (trajo su celular)', () => {
    it('la llave de la conversación y de la cola es el celular, no un alias', () => {
        expect(esAliasDeUsuario(TELEFONO)).toBe(false);
        expect(claveDeContacto(TELEFONO)).toBe(TELEFONO);
    });

    it('el prospecto (phone «3114579340») se encuentra por las variantes del celular', () => {
        expect(variantesTelefonoLead(TELEFONO)).toContain('3114579340');
    });

    it('si SÍ hubiera llegado sin teléfono, su alias sería sin dígitos y el prospecto se llavearía por el alias', () => {
        const alias = aliasDeBsuid(BSUID) as string;
        expect(alias.startsWith('wau-CO.')).toBe(true);
        expect(alias.replace(/\D/g, '')).toBe('');
        expect(variantesTelefonoLead(alias)).toEqual([alias]);
        expect(claveDeContacto(alias)).toBe(alias);
    });
});

// ─── 1. El monto: $140.000 es la opción «2 semanas» ─────────────────────────

describe('1. decidirMontoDeVenta con $140.000 (no es la causa)', () => {
    it('lo resuelve `completo` con la opción «2 semanas» de lista (no afiliado, pago del mismo día)', () => {
        const d = decidirMontoDeVenta(140000, VACACIONAL, { ahora: ms('18:59:00'), afiliado: false, fechaPago: '2026-11-15', previo: null });
        expect(d.tipo).toBe('completo');
        if (d.tipo !== 'completo') return;
        expect(d.precio.monto).toBe(140000);
        expect(d.precio.opcion).toBe('2');
        expect(d.precio.fuenteId).toBe(ITEM_ID);
        expect(d.precio.esAbono ?? false).toBe(false);
    });

    it('como afiliado $140.000 no es ningún precio (80/120/150/170): `no_cuadra`', () => {
        expect(decidirMontoDeVenta(140000, VACACIONAL, { ahora: ms('18:59:00'), afiliado: true, fechaPago: '2026-11-15' }).tipo).toBe('no_cuadra');
    });
});

// ─── 2. Por qué se preguntó el nombre ───────────────────────────────────────

describe('2. el nombre ya venía en el primer mensaje y no se tomó', () => {
    it('el prospecto se llama como el perfil de WhatsApp («Brady Luz»): nombre de relleno', () => {
        expect(esNombreDeRelleno('Brady Luz', 'Brady Luz')).toBe(true);
    });

    it('ACTUAL: del chat solo se toma un nombre con marca («a nombre de…»); el primer mensaje no trae marca', () => {
        expect(nombreDeAsistenteEnTextos([null, null], SERVICIO, [PRIMER_MENSAJE, 'Separar mi cupo'])).toBeNull();
    });

    it('ANTES null · AHORA: la venta lo lee como «datos de quien asiste» (el nombre va en una línea propia, con la edad)', () => {
        expect(datosDeAsistenteEnVenta(PRIMER_MENSAJE, [])).toEqual({ nombre: 'Gabriela Covaleda García' });
    });

    it('(R3c) la memoria de la venta saca del PRIMER mensaje el nombre y la edad: ya no se pregunta el nombre', () => {
        const d = registroDeChatPrevio(['Separar mi cupo', PRIMER_MENSAJE], { hoy: '2026-11-15' });
        expect(d).toMatchObject({ nombre: 'Gabriela Covaleda García', edad: 13, soloEdad: true, fechaNacimiento: null });
        // Falta la fecha de nacimiento y, como es menor, la persona responsable. El nombre NO.
        expect(faltantesDe(d, '2026-11-15')).toEqual(['fecha_nacimiento', 'acudiente']);
        expect(preguntaDeDatosDeServicio(140000, SERVICIO, d, '2026-11-15')).toBe(
            'Recibí tu comprobante de *$140.000* 📄 Para completar la inscripción a *Vacacional de voleibol — Sede Suba* necesito estos datos de quien asiste:\n'
            + '1. Fecha de nacimiento (día/mes/año)\n2. Nombre de la persona responsable (mamá, papá o acudiente)\nPuedes escribirlos en un solo mensaje.');
    });

    it('de un mensaje ANTERIOR el nombre solo vale con otro dato o una marca: dos palabras sueltas no son una persona', () => {
        for (const t of ['Separar mi cupo', 'Brady Luz', 'Sede Suba', 'Muchas gracias', 'Ya pagué']) {
            expect(registroDeMensajePrevio(t, { hoy: '2026-11-15' }).nombre, t).toBeNull();
        }
        expect(registroDeMensajePrevio('La niña Gabriela Covaleda García', { hoy: '2026-11-15' }).nombre).toBe('Gabriela Covaleda García');
    });
});

// ─── 3. La respuesta a la pregunta del nombre ───────────────────────────────

describe('3. «Comparto soporte pago vacacional 2 semanas (…) / Gabriela Covaleda García / 13 años 6 meses»', () => {
    it('ANTES null (solo miraba el COMIENZO del texto) · AHORA: `nombreDeAsistente` encuentra el nombre en su línea', () => {
        // «Comparto» pasa como palabra de nombre, «soporte» está en NO_NOMBRE y corta: el comienzo no es un nombre.
        // La segunda línea es ENTERA un nombre de tres palabras: ese es.
        expect(nombreDeAsistente(RESPUESTA)).toBe('Gabriela Covaleda García');
        // Lo que NO se vuelve nombre por estar en otra línea:
        for (const t of ['Hola\nsede suba', 'Listo\nmuchas gracias', 'Quiero info\nvoleibol playa', 'Hola\nya pagué']) {
            expect(nombreDeAsistente(t), t).toBeNull();
        }
    });

    it('DESEADO (arreglado): de la respuesta a la pregunta sale «Gabriela Covaleda García»', () => {
        expect(nombreDeAsistente(RESPUESTA)).toBe('Gabriela Covaleda García');
    });

    it('la respuesta a la pregunta trae el nombre y la edad: el cobro se crea con el nombre y queda marcado lo que falta', () => {
        const d = leerRespuestaDeDatos(RESPUESTA, { hoy: '2026-11-15' });
        expect(d).toMatchObject({ nombre: 'Gabriela Covaleda García', edad: 13, soloEdad: true });
        expect(faltantesDe(d, '2026-11-15')).toEqual(['fecha_nacimiento', 'acudiente']);
    });

    it('ACTUAL: el camino del nombre tardío también mira solo la primera línea', () => {
        expect(nombreYAcompanante(RESPUESTA)).toBeNull();
    });

    it('PROPUESTA viable: línea por línea (una línea que sea SOLO un nombre) lo encuentra, sin falsos positivos en las otras', () => {
        expect(nombrePorLineas(RESPUESTA)).toBe('Gabriela Covaleda García');
        expect(nombrePorLineas(PRIMER_MENSAJE)).toBe('Gabriela Covaleda García');
        const [l1, , l3] = RESPUESTA.split('\n');
        expect(nombreDeAsistente(l1, { entero: true })).toBeNull();
        expect(nombreDeAsistente(l3, { entero: true })).toBeNull();
        // Lo que NO debe volverse nombre con esa regla:
        for (const t of ['Ya pagué', 'Buenas tardes', 'Muchas gracias', 'Sede Suba', 'Separar mi cupo', 'Hola cómo estás']) {
            expect(nombrePorLineas(t), t).toBeNull();
        }
    });

    it('ACTUAL (defecto): como no fue un nombre, cae a la venta, que lo lee como «ya pagué»…', () => {
        expect(soloSaludoOCortesia(RESPUESTA)).toBe(false);
        expect(intencionEnVenta(RESPUESTA)).toBe('ya_pago'); // «comparto soporte»
    });

    it('ANTES la venta CALLABA («hay un comprobante en la ráfaga») · AHORA: la PREGUNTA de la cola sí cuenta como respuesta', () => {
        // `adjuntoEnLaRafaga` ignora los salientes con `payload.queue_id`… salvo la pregunta de la venta
        // (`ask_asistente_servicio`): la cola ya contestó la foto de las 18:58:43 y quedó esperando al cliente.
        expect(adjuntoEnLaRafaga(HASTA_LA_RESPUESTA, null, ms('18:59:58'))).toBe(false);
        // Y en la cola no hay nada `pending`/`processing`: la fila está `waiting_user`.
        expect(comprobanteEnCurso([{ status: 'waiting_user', created_at: at('18:58:43') }], ms('18:59:58'))).toBe(false);
    });

    it('lo que NO cambia: ANTES de que la cola pregunte (o cuando contesta otra cosa) el archivo sigue «en la ráfaga»', () => {
        // Sin la pregunta todavía: la cola va a contestar.
        expect(adjuntoEnLaRafaga([M_TEXTO_1, M_PAGO, M_FOTO, M_RESPUESTA], null, ms('18:59:00'))).toBe(true);
        // La respuesta de la cola a una familia («¿a cuál cobro?», el resultado): no corta la ráfaga, como siempre.
        const deFamilia: FilaReciente = { ...M_PREGUNTA, payload: { step: 'ask_cual_pago', queue_id: QUEUE_ID } };
        expect(adjuntoEnLaRafaga([M_FOTO, deFamilia, M_RESPUESTA], null, ms('18:59:58'))).toBe(true);
        const resultado: FilaReciente = { ...M_PREGUNTA, payload: { step: 'venta_comprobante_recibido', queue_id: QUEUE_ID } };
        expect(adjuntoEnLaRafaga([M_FOTO, resultado, M_RESPUESTA], null, ms('18:59:58'))).toBe(true);
    });

    it('DESEADO (arreglado): con la pregunta de la cola ya enviada, el turno no calla esperando a la cola', () => {
        expect(adjuntoEnLaRafaga(HASTA_LA_RESPUESTA, null, ms('18:59:58'))).toBe(false);
    });
});

// ─── 4. El botón [Ya pagué] un minuto después ───────────────────────────────

describe('4. [Ya pagué] (19:00:46) no pisa ni cancela la espera del nombre: también se calla', () => {
    it('«Ya pagué» no es un nombre ni una cortesía: la pregunta sigue abierta (waiting_user)', () => {
        expect(nombreDeAsistente('Ya pagué')).toBeNull();
        expect(soloSaludoOCortesia('Ya pagué')).toBe(false);
    });

    it('ANTES el botón callaba por la ráfaga · AHORA no: la cola ya preguntó y espera al cliente', () => {
        expect(adjuntoEnLaRafaga(HASTA_YA_PAGUE, null, ms('19:00:48'))).toBe(false);
        expect(comprobanteRecibido(HASTA_YA_PAGUE, 24 * 60, ms('19:00:48'))).toBe(true);
        expect(accionesDeCierre(HASTA_YA_PAGUE, ms('19:00:48'))).toBeNull();
    });

    it('ANTES el silencio duraba 5 min desde la foto · AHORA la pregunta de la cola (18:59:33) lo corta', () => {
        expect(adjuntoEnLaRafaga(HASTA_YA_PAGUE, null, ms('19:03:40'))).toBe(false);
        expect(adjuntoEnLaRafaga(HASTA_YA_PAGUE, null, ms('19:03:50'))).toBe(false);
    });

    /** El contexto de la venta como lo arma el bot (whatsapp-bot.service), con la ficha del prospecto inyectada. */
    function ctxDe(recientes: FilaReciente[], ahora: number, ficha: DatosDeRegistro | null) {
        const enviados: { texto: string; contexto: Record<string, unknown> }[] = [];
        const ctx = {
            schoolId: 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c', conversationId: '63687282', recientes,
            afiliado: async () => false, cuentas: async () => [], guardarLead: async () => 'lead-1', registrarEsperado: async () => true,
            responderPregunta: async () => ({ tipo: 'no_se', motivo: 'x' }),
            enviar: async (texto: string, contexto: Record<string, unknown>) => { enviados.push({ texto, contexto }); },
            avisarEscuela: async () => undefined,
            comprobanteEnCurso: async () => adjuntoEnLaRafaga(recientes, null, ahora),
            registro: async () => ficha,
            ahora: () => new Date(ahora),
        } as unknown as CtxVentaServicio;
        return { ctx, enviados };
    }
    const SIN_FICHA: DatosDeRegistro = { nombre: null, fechaNacimiento: null, edad: null, soloEdad: false, acudiente: null, posicion: null };

    it('(R6) [Ya pagué] con la pregunta abierta: «Ya tengo tu comprobante 📄 …» con SOLO lo que falta (el nombre ya lo dijo en el chat)', async () => {
        const { ctx, enviados } = ctxDe(HASTA_YA_PAGUE, ms('19:00:48'), SIN_FICHA);
        expect(await atenderBotonDeVenta(ctx, VACACIONAL as any, 'ya_pague')).toBe('venta_ya_pago');
        expect(enviados).toHaveLength(1);
        expect(enviados[0].texto).toBe(
            'Ya tengo tu comprobante 📄 Para completar la inscripción a *Vacacional de voleibol — Sede Suba* necesito estos datos de quien asiste:\n'
            + '1. Fecha de nacimiento (día/mes/año)\n2. Nombre de la persona responsable (mamá, papá o acudiente)\nPuedes escribirlos en un solo mensaje.');
        expect(enviados[0].texto).not.toMatch(/env[ií]a/i);          // nunca pide un comprobante que ya recibió
        expect(enviados[0].contexto).toMatchObject({ step: PASO_VENTA.YA_PAGO, pide_datos: true, faltan_datos: ['fecha_nacimiento', 'acudiente'], [MARCA_VENTA]: ITEM_ID });
    });

    it('(R6) un segundo [Ya pagué] no repite: se repregunta UNA sola vez', async () => {
        const yaRepreguntado: FilaReciente = {
            direction: 'outbound', type: 'text', ai_generated: true, created_at: at('19:00:50'),
            payload: { step: PASO_VENTA.YA_PAGO, pide_datos: true, venta_servicio_id: ITEM_ID },
        };
        const otroToque: FilaReciente = { ...M_YA_PAGUE, created_at: at('19:01:30') };
        const { ctx, enviados } = ctxDe([...HASTA_YA_PAGUE, yaRepreguntado, otroToque], ms('19:01:32'), SIN_FICHA);
        expect(await atenderBotonDeVenta(ctx, VACACIONAL as any, 'ya_pague')).toBe('venta_silencio');
        expect(enviados).toHaveLength(0);
    });

    it('(R2/R3) el mensaje de datos de pago pide de una vez SOLO los datos de registro que faltan', async () => {
        const GABI = 'Gabriela Covaleda García';
        expect(cierreDePagoSegunRegistro(['nombre', 'fecha_nacimiento'], SIN_FICHA)).toBe(
            'Envía aquí la foto del comprobante con el nombre completo y la fecha de nacimiento de quien asiste '
            + '(si es menor de edad, también el nombre de la persona responsable) y te confirmamos el cupo.');
        expect(cierreDePagoSegunRegistro(['fecha_nacimiento', 'acudiente'], { ...SIN_FICHA, nombre: GABI, edad: 13 })).toBe(
            `Envía aquí la foto del comprobante con la fecha de nacimiento de *${GABI}* y el nombre de la persona responsable y te confirmamos el cupo.`);
        expect(cierreDePagoSegunRegistro(['acudiente'], { ...SIN_FICHA, nombre: GABI, edad: 13 })).toBe(
            `Envía aquí la foto del comprobante con el nombre de la persona responsable de *${GABI}* y te confirmamos el cupo.`);
        expect(cierreDePagoSegunRegistro([], { ...SIN_FICHA, nombre: GABI })).toBe(
            `Envía aquí la foto del comprobante y te confirmamos el cupo de *${GABI}*.`);

        // [Separar mi cupo] de un prospecto sin nada en la ficha, pero que ya dijo el nombre y la edad en el chat.
        const { ctx, enviados } = ctxDe([M_TEXTO_1, M_FICHA, M_BOTONES, M_SEPARAR], ms('18:56:18'), SIN_FICHA);
        (ctx as any).cuentas = async () => [{ tipo: 'Nequi', numero: '3194505150', titular: 'Iván Sossa' }];
        expect(await atenderBotonDeVenta(ctx, VACACIONAL as any, 'separar')).toBe('venta_pago');
        expect(enviados[0].texto).toMatch(new RegExp(`Envía aquí la foto del comprobante con la fecha de nacimiento de \\*${GABI}\\* y el nombre de la persona responsable y te confirmamos el cupo\\.$`));
        expect(enviados[0].contexto).toMatchObject({ step: PASO_VENTA.PAGO, faltan_datos: ['fecha_nacimiento', 'acudiente'] });
        // Sin la memoria (familia del club, simulación): el cierre de siempre.
        (ctx as any).registro = undefined;
        expect(await atenderBotonDeVenta(ctx, VACACIONAL as any, 'separar')).toBe('venta_pago');
        expect(enviados[1].texto.endsWith(CIERRE_DE_PAGO)).toBe(true);
    });

    it('(R6) «Ya pagué» escrito, con todos los datos ya en la ficha: la escuela lo valida (sin pedir nada)', async () => {
        const completa: DatosDeRegistro = { nombre: 'Gabriela Covaleda García', fechaNacimiento: '2013-05-10', edad: 13, soloEdad: false, acudiente: 'Brady Luz', posicion: null };
        const escrito: FilaReciente = { ...M_YA_PAGUE, type: 'text', text_body: 'Ya pagué' };
        const recientes = [...HASTA_LA_RESPUESTA, escrito];
        const { ctx, enviados } = ctxDe(recientes, ms('19:00:48'), completa);
        const venta = { item: VACACIONAL as any, origen: 'marca' as const, desde: at('18:55:42') };
        expect(await atenderVentaDeServicio(ctx, venta as any, 'Ya pagué')).toBe('venta_ya_pago');
        expect(enviados.map((e) => e.texto)).toEqual(['Ya tenemos tu comprobante 📄 La escuela lo valida y te confirma el cupo por aquí.']);
    });
});

// ─── 5. El cierre: la escuela escribe al día siguiente ──────────────────────

describe('5. «Hola cómo estás» de la escuela (16-nov 17:01) cierra la pregunta sin cobro ni propuesta', () => {
    it('ese saliente es de una persona de la escuela y es posterior a la pregunta', () => {
        expect(esHumanoDeLaEscuela(M_ESCUELA)).toBe(true);
        expect(new Date(M_ESCUELA.created_at as string).getTime()).toBeGreaterThan(ms('18:59:33'));
        // → `resolverFilaAbierta`: `laEscuelaTomoLaConversacion` = true → `cerrarPregunta(MOTIVO_ESCUELA_TOMO)`:
        //   status 'ignored', result_type NULL, error_message «la escuela tomó la conversación» (sin nombre,
        //   sin servicio, sin monto, sin propuesta). En la bandeja cae en «otro» → grupo `revisar`, no `accion`.
    });

    it('faltaban ~2 h para que venciera a las 24 h con el motivo útil (`venta_falta_nombre: … crear el cobro a mano`)', () => {
        const horas = (new Date(at('17:01:41', '2026-11-16')).getTime() - ms('18:59:33')) / 3_600_000;
        expect(horas).toBeGreaterThan(22);
        expect(horas).toBeLessThan(24);
    });
});
