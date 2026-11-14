/**
 * Conversación v2 del bot de WhatsApp (Dynasty, 2026-10-24; spec
 * docs/specs/whatsapp-conversacion-v2-dynasty.md §3.1, §3.2 y §3.4).
 *
 * Casos REALES del informe:
 *  - «papá de Sofía Gómez Uribe para información», «mi hija se quiere meter en la
 *    academia de voleibol» y «Noo mi hija no es de la escuela» recibían «No
 *    reconozco este número entre las familias… tus cobros son datos privados».
 *  - «¿El plan pro cuántas clases son?» no tenía regla: salió 72 min tarde y vacío.
 *  - «no puedo leer ese formato» ×2 en 5 min; «Todavía nadie…» ×2 en el mismo segundo.
 *  - «Hola Milena buenos días», «Mile querida…», «Hola Milena… me podrías facilitar
 *    el correo» recibían «escríbeme tu correo».
 *  - 28 de 75 escalamientos sin un mensaje humano después.
 *
 * Primera parte: reglas puras y el motor de la puerta con un contexto falso.
 * Segunda parte: los caminos del bot con el mismo andamiaje que
 * whatsapp-retoma-y-pago-publico.test.ts (Supabase con builder, nada de Meta).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        resolve: (table: string, ops: Ops) => any;
        rpc: (fn: string, args: any) => any;
        inserts: { table: string; row: any }[];
    } = { resolve: () => ({ data: null, error: null }), rpc: () => ({ data: null, error: null }), inserts: [] };
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'limit', 'is', 'not', 'neq', 'filter', 'contains', 'ilike']) b[m] = chain(m);
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.update = (row: any) => { ops.push(['update', [row]]); return b; };
        b.upsert = (row: any) => {
            // notifications entra por upsert+ignoreDuplicates: se registra como insert y devuelve la fila.
            if (table === 'notifications') { state.inserts.push({ table, row }); b.__fila = row; }
            ops.push(['upsert', [row]]); return b;
        };
        b.maybeSingle = () => { ops.push(['maybeSingle', []]); return Promise.resolve(state.resolve(table, ops)); };
        b.single = () => { ops.push(['maybeSingle', []]); return Promise.resolve(state.resolve(table, ops)); };
        b.then = (res: any, rej: any) => Promise.resolve(b.__fila ? { data: [{ id: b.__fila.id }], error: null } : state.resolve(table, ops)).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: {
            from: (t: string) => makeBuilder(t),
            rpc: (fn: string, args: any) => Promise.resolve(state.rpc(fn, args)),
        },
        debeAtender: vi.fn(),
        botEncendido: vi.fn(),
        chatWithTools: vi.fn(),
        sendToUser: vi.fn(),
        correo: vi.fn(async () => {}),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp-atencion.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-atencion.service')>('./whatsapp-atencion.service');
    return { ...real, debeAtender: h.debeAtender, botEncendido: h.botEncendido };
});
vi.mock('./llm.service', () => ({ chatWithTools: h.chatWithTools }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.txt' })),
    sendInteractiveButtons: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.btn' })),
    aFormatoWhatsApp: (t: string) => t,
    verifyWebhookSignature: vi.fn(),
    resolveIntegration: vi.fn(),
    parseInboundMessages: vi.fn(() => []),
    parseStatuses: vi.fn(() => []),
    markAsRead: vi.fn(),
}));
vi.mock('./whatsapp-optin.service', () => ({ estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '' }));
vi.mock('./whatsapp-horario.service', () => ({
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: false, proximaAtencion: null })),
    mensajeDeEscalamiento: vi.fn(() => 'Voy a pasar tu caso con una persona del equipo. En breve te contactan.'),
}));
vi.mock('./push.service', () => ({ sendToUser: h.sendToUser }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({ mediosDePago: vi.fn(async () => null) }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({
    avisarEscalamientoPorCorreo: h.correo,
    destinatariosDeEscuela: vi.fn(async () => ({ escuela: 'Dynasty', correos: [] })),
    enviarConReserva: vi.fn(async () => 'enviado'),
    etiquetaDeContacto: vi.fn(() => 'Contacto de prueba'),
    uuidDeClave: (k: string) => `uuid:${k}`,
}));
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: vi.fn() }));
vi.mock('./whatsapp-coexistence.service', () => ({
    procesarEchos: vi.fn(), procesarHistorial: vi.fn(), registrarAppState: vi.fn(),
}));
vi.mock('./whatsapp-prospecto-lead.service', () => ({ registrarLeadDeProspecto: vi.fn(async () => ({ leadId: 'lead-1', creado: true })) }));

import {
    atenderDesconocido, revisarRetomas, runBotTurn, deliver, yaSalioElMismoTexto, revisarSlaDeEscalaciones,
    _olvidarReservasDePaso, _limpiarCacheVocativos, TEXTO_MIME_RECHAZADO,
} from './whatsapp-bot.service';
import { registrarLeadDeProspecto } from './whatsapp-prospecto-lead.service';
import { estadoDeHorario } from './whatsapp-horario.service';
import { intencionDeProspecto, temaEscolar } from './whatsapp-atencion.service';
import { llamaAPersonaSinPedir } from './whatsapp-desconocido-reglas';
import {
    esRepeticionReciente, exentoDeAntirrepeticion, minutosHabiles, slaVencido, type HorarioDeAtencion,
} from './whatsapp-reglas-turno';
import {
    textoDePrecios, preguntaPorClasesDePlan, respuestaClasesDePlan, textoDeClases,
} from './whatsapp-precios.service';
import { textoSinRespuesta, textoDelAvisoAlEquipo } from './whatsapp-escalaciones.service';
import {
    leerOpcionDePuerta, leerQueQuiere, leerNombreDeDeportista, leerVariosDeportistas, mensajeDePuerta, iniciarPuerta, atenderTurnoPuerta,
    BOTON_PUERTA, PASO_PUERTA_MENU, FLUJO_PUERTA, type CtxPuerta, type EstadoPuerta, type LeadCompleto,
} from './whatsapp-puerta-desconocido';

// ─── 1. Lecturas puras de la puerta ──────────────────────────────────────────

describe('puerta única: lectura de respuestas', () => {
    it('el mensaje de la puerta es UNA pregunta con los tres botones (títulos ≤ 20)', () => {
        const m = mensajeDePuerta('Hola 👋 Soy el *asistente automático* de *Dynasty*. 🤖');
        expect(m.texto).toContain('¿Qué necesitas?');
        expect(m.botones.map((b) => b.title)).toEqual(['Ya soy del club', 'Quiero información', 'Otro tema']);
        for (const b of m.botones) expect(b.title.length).toBeLessThanOrEqual(20);
        // Ya se presentó en las últimas 24 h: solo la pregunta.
        expect(mensajeDePuerta('').texto).toBe('¿Qué necesitas?');
    });

    it('el botón o el título escrito tal cual (modo asistido) eligen la opción', () => {
        expect(leerOpcionDePuerta('', BOTON_PUERTA.CLUB)).toBe('club');
        expect(leerOpcionDePuerta('Ya soy del club')).toBe('club');
        expect(leerOpcionDePuerta('quiero información')).toBe('info');
        expect(leerOpcionDePuerta('Info')).toBe('info');
        expect(leerOpcionDePuerta('Otro tema')).toBe('otro');
    });

    it('una frase con otra cosa NO es el botón («quiero información sobre el torneo»)', () => {
        expect(leerOpcionDePuerta('quiero información sobre el torneo de mayo')).toBeNull();
        expect(leerOpcionDePuerta('no soy del club todavía')).toBeNull();
    });

    it('qué quiere: por botón o por palabra', () => {
        expect(leerQueQuiere('', BOTON_PUERTA.CORTESIA)).toBe('cortesia');
        expect(leerQueQuiere('quiero una clase de prueba')).toBe('cortesia');
        expect(leerQueQuiere('Inscribirme')).toBe('inscribirme');
        expect(leerQueQuiere('solo precios')).toBe('precios');
        expect(leerQueQuiere('cuánto vale')).toBe('precios');
        expect(leerQueQuiere('mmm no sé')).toBeNull();
    });

    it('varios deportistas en un mensaje: cada uno con nombre y apellido (Monster 2026-11-09)', () => {
        expect(leerVariosDeportistas('Valeria Pardo Rojas y Camila Pardo Rojas'))
            .toEqual(['Valeria Pardo Rojas', 'Camila Pardo Rojas']);
        expect(leerVariosDeportistas('Ana Ruiz e Isabel Gómez')).toEqual(['Ana Ruiz', 'Isabel Gómez']);
        expect(leerVariosDeportistas('Ana Ruiz & Isabel Gómez & Luz Mora')).toEqual(['Ana Ruiz', 'Isabel Gómez', 'Luz Mora']);
        // Uno solo, con un solo nombre, con datos o frases: no son varios.
        for (const t of ['Valeria Pardo Rojas', 'Juan y Pedro Gómez', 'Ana Ruiz y 14 años', 'Valeria y Camila', 'hola y gracias', 'Ana Ruiz y otro@correo.com', '', null])
            expect(leerVariosDeportistas(t as any)).toBeNull();
    });

    it('nombre del deportista: solo el nombre, o con la edad / fecha en el mismo mensaje', () => {
        const ahora = new Date('2026-10-24T12:00:00-05:00');
        expect(leerNombreDeDeportista('Sofía Gómez Uribe', ahora)).toEqual({ nombre: 'Sofía Gómez Uribe' });
        expect(leerNombreDeDeportista('mi hija se llama Sofía Gómez, tiene 9 años', ahora))
            .toMatchObject({ nombre: 'Sofía Gómez', edad: 9 });
        expect(leerNombreDeDeportista('Sofía Gómez 15/03/2017', ahora))
            .toMatchObject({ nombre: 'Sofía Gómez', edad: 9, fechaNacimiento: '2017-03-15' });
    });

    it('lo que no es un nombre se rechaza (correo, pregunta, frase larga, número)', () => {
        expect(leerNombreDeDeportista('mama@correo.com')).toBeNull();
        expect(leerNombreDeDeportista('¿cuánto vale la mensualidad?')).toBeNull();
        expect(leerNombreDeDeportista('quisiera saber si tienen cupo para el grupo de las tardes')).toBeNull();
        expect(leerNombreDeDeportista('3001234567')).toBeNull();
        expect(leerNombreDeDeportista('hola')).toBeNull();
    });
});

// ─── 2. El motor de la puerta, con un contexto falso ─────────────────────────

describe('puerta única: motor', () => {
    interface Salida { texto: string; step: string; estado: EstadoPuerta | null; botones: string[]; titulos: string[]; contexto?: any }
    function falso(op: { perfil?: string | null; edadPrevia?: number | null; enlace?: string | null; precios?: string | null } = {}) {
        const salidas: Salida[] = [];
        const avisos: { motivo: string; detalle: string | null }[] = [];
        const leads: LeadCompleto[] = [];
        const cortesias: { datos: any; encabezado: string }[] = [];
        let estado: EstadoPuerta | null = null;
        const ctx: CtxPuerta = {
            conversationId: 'c1', schoolId: 's1', contactWaId: '573000000001',
            enviar: async (texto, step, st, botones, _enTexto, contexto) => {
                salidas.push({ texto, step, estado: st, botones: (botones ?? []).map((b) => b.id),
                    titulos: (botones ?? []).map((b) => b.title), contexto });
                estado = st;
            },
            avisarEscuela: async (motivo, detalle) => { avisos.push({ motivo, detalle }); },
            nombrePerfil: async () => (op.perfil === undefined ? 'Laura Gómez' : op.perfil),
            edadPrevia: async () => op.edadPrevia ?? null,
            guardarLead: async (l) => { leads.push(l); },
            grupoPara: async (edad) => ({ linea: `Para ${edad} años le corresponde *Infantil Femenino*.`, nombre: 'Infantil Femenino' }),
            precios: async () => (op.precios === undefined ? '💰 Estos son los valores:\n• Plan pro: *$150.000* · 8 clases al mes' : op.precios),
            enlace: async () => (op.enlace === undefined ? 'https://app.example/join/dynasty' : op.enlace),
            cortesia: async (datos, encabezado) => { cortesias.push({ datos, encabezado }); },
            leerEstado: async () => estado,
            ahora: () => new Date('2026-10-24T12:00:00-05:00'),
        };
        const turno = (texto: string, botonId: string | null = null) => atenderTurnoPuerta(ctx, texto, botonId);
        return { ctx, salidas, avisos, leads, cortesias, turno, ultimo: () => salidas[salidas.length - 1] };
    }

    it('iniciarPuerta deja el estado en «menu» con el step histórico del comodín', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, 'Hola 👋 Soy el asistente.');
        expect(f.ultimo()).toMatchObject({ step: PASO_PUERTA_MENU, estado: { paso: 'menu' } });
        expect(PASO_PUERTA_MENU).toBe('ask_email');
        expect(f.ultimo().botones).toEqual([BOTON_PUERTA.CLUB, BOTON_PUERTA.INFO, BOTON_PUERTA.OTRO]);
    });

    it('texto libre en la pregunta de los botones NO lo toma la puerta (siguen las reglas de siempre)', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, '');
        expect(await f.turno('quisiera saber cuándo es el torneo')).toBe(false);
    });

    it('sin flujo abierto un texto cualquiera no es de la puerta', async () => {
        const f = falso();
        expect(await f.turno('Sofía Gómez')).toBe(false);
    });

    it('«Ya soy del club» → pide el NOMBRE del deportista (no el correo) y lo deja en el buzón con ese dato', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, '');
        expect(await f.turno('', BOTON_PUERTA.CLUB)).toBe(true);
        expect(f.ultimo().texto).toContain('nombre completo del deportista');
        expect(f.ultimo().estado).toMatchObject({ paso: 'club_nombre' });

        expect(await f.turno('Sofía Gómez Uribe')).toBe(true);
        expect(f.ultimo().step).toBe('puerta_club_recibido');
        expect(f.ultimo().estado).toBeNull();                       // terminal: cierra el flujo
        expect(f.ultimo().contexto).toMatchObject({ deportista_declarado: 'Sofía Gómez Uribe' });
        expect(f.avisos).toEqual([{ motivo: 'club', detalle: 'Dice ser del club. Deportista: Sofía Gómez Uribe.' }]);
        // Nunca muestra datos antes de verificar y ofrece el OTP como camino alterno.
        expect(f.ultimo().texto).toMatch(/no te muestro datos hasta verificar/);
        expect(f.ultimo().texto).toContain('correo');
    });

    it('«Ya soy del club»: un correo en el paso del nombre lo deja al camino del OTP', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.CLUB);
        expect(await f.turno('mama.prueba@correo.com')).toBe(false);
    });

    it('«Ya soy del club»: dos respuestas sin nombre → queda en el buzón igual', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.CLUB);
        await f.turno('no sé');
        expect(f.ultimo().estado).toMatchObject({ paso: 'club_nombre', datos: { intentos: 1 } });
        await f.turno('mmm');
        expect(f.ultimo().step).toBe('puerta_club_recibido');
        expect(f.avisos).toEqual([{ motivo: 'club', detalle: null }]);
    });

    it('«Otro tema» → buzón + aviso, sin más preguntas', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, '');
        expect(await f.turno('', BOTON_PUERTA.OTRO)).toBe(true);
        expect(f.ultimo().step).toBe('puerta_otro_tema');
        expect(f.ultimo().estado).toBeNull();
        expect(f.ultimo().texto).not.toContain('?');
        expect(f.avisos).toEqual([{ motivo: 'otro', detalle: null }]);
    });

    it('«Quiero información»: máximo 4 respuestas, una por mensaje, y el lead queda COMPLETO', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.INFO);                          // pregunta 1: nombre
        expect(f.ultimo().estado).toMatchObject({ paso: 'info_nombre' });
        await f.turno('Sofía Gómez Uribe');                             // respuesta 1
        expect(f.ultimo()).toMatchObject({ estado: { paso: 'info_edad' } });
        expect(f.ultimo().texto).toContain('Sofía');
        await f.turno('9');                                             // respuesta 2
        expect(f.ultimo().estado).toMatchObject({ paso: 'info_acudiente', datos: { edad: 9, grupoSugerido: 'Infantil Femenino' } });
        expect(f.ultimo().botones).toEqual([BOTON_PUERTA.SOY, BOTON_PUERTA.OTRO_NOMBRE]);
        await f.turno('', BOTON_PUERTA.SOY);                            // respuesta 3: «Soy Laura»
        expect(f.ultimo().estado).toMatchObject({ paso: 'info_quiere', datos: { acudiente: 'Laura Gómez' } });
        expect(f.ultimo().botones).toEqual([BOTON_PUERTA.CORTESIA, BOTON_PUERTA.INSCRIBIRME, BOTON_PUERTA.PRECIOS]);
        await f.turno('', BOTON_PUERTA.PRECIOS);                        // respuesta 4

        expect(f.leads).toEqual([{
            deportista: 'Sofía Gómez Uribe', fechaNacimiento: null, edad: 9, acudiente: 'Laura Gómez',
            grupoSugerido: 'Infantil Femenino', quiere: 'precios',
        }]);
        const cierre = f.ultimo();
        expect(cierre.step).toBe('puerta_info_listo');
        expect(cierre.estado).toBeNull();
        expect(cierre.texto).toContain('Para 9 años le corresponde *Infantil Femenino*');   // el grupo
        expect(cierre.texto).toContain('Plan pro: *$150.000* · 8 clases al mes');            // los valores
        expect(cierre.texto).toContain('https://app.example/join/dynasty');                  // el enlace
        // 4 respuestas de la persona = 4 preguntas del bot después de elegir la opción.
        expect(f.salidas.filter((s) => s.estado).length).toBe(5);   // menú + 4 preguntas
    });

    it('si ya dijo la edad en el mismo mensaje del nombre, NO se vuelve a preguntar', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.INFO);
        await f.turno('mi hija se llama Sofía Gómez, tiene 9 años');
        expect(f.ultimo().estado).toMatchObject({ paso: 'info_acudiente', datos: { deportista: 'Sofía Gómez', edad: 9 } });
    });

    it('si dijo la edad en un mensaje anterior (7 días), tampoco se pregunta', async () => {
        const f = falso({ edadPrevia: 11 });
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.INFO);
        await f.turno('Valentina Ríos');
        expect(f.ultimo().estado).toMatchObject({ paso: 'info_acudiente', datos: { edad: 11 } });
    });

    it('con la fecha de nacimiento el lead lleva birth_date', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.INFO);
        await f.turno('Sofía Gómez');
        await f.turno('15/03/2017');
        expect(f.ultimo().estado).toMatchObject({ datos: { edad: 9, fechaNacimiento: '2017-03-15' } });
        await f.turno('', BOTON_PUERTA.SOY);
        await f.turno('', BOTON_PUERTA.INSCRIBIRME);
        expect(f.leads[0]).toMatchObject({ fechaNacimiento: '2017-03-15', edad: 9, quiere: 'inscribirme' });
        expect(f.ultimo().texto).toContain('hacer la inscripción');
    });

    it('«Otro nombre» de acudiente: lo escribe y sigue', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.INFO);
        await f.turno('Sofía Gómez, 9 años');
        await f.turno('', BOTON_PUERTA.OTRO_NOMBRE);
        expect(f.ultimo().texto).toContain('nombre del acudiente');
        await f.turno('Carlos Gómez');
        expect(f.ultimo().estado).toMatchObject({ paso: 'info_quiere', datos: { acudiente: 'Carlos Gómez' } });
    });

    it('sin nombre de perfil de WhatsApp no hay botón «Soy…»: pregunta el nombre', async () => {
        const f = falso({ perfil: null });
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.INFO);
        await f.turno('Sofía Gómez, 9 años');
        expect(f.ultimo().botones).toEqual([]);
        expect(f.ultimo().texto).toContain('nombre del acudiente');
    });

    it('el título del botón «Soy …» cabe en los 20 caracteres de Meta', async () => {
        const f = falso({ perfil: 'Maximiliano Alejandro Pérez' });
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.INFO);
        await f.turno('Sofía Gómez, 9 años');
        expect(f.ultimo().botones[0]).toBe(BOTON_PUERTA.SOY);
        expect(f.ultimo().titulos[0]).toBe('Soy Maximiliano');
        for (const t of f.ultimo().titulos) expect(t.length).toBeLessThanOrEqual(20);
    });

    it('«Clase de cortesía» sigue el flujo existente con nombre, edad y acudiente ya sabidos', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.INFO);
        await f.turno('Sofía Gómez, 9 años');
        await f.turno('', BOTON_PUERTA.SOY);
        await f.turno('', BOTON_PUERTA.CORTESIA);
        expect(f.leads).toHaveLength(1);
        expect(f.cortesias).toHaveLength(1);
        expect(f.cortesias[0].datos).toMatchObject({ deportista: 'Sofía Gómez', edad: 9, acudiente: 'Laura Gómez' });
        expect(f.cortesias[0].encabezado).toContain('registré a *Sofía Gómez*');
        expect(f.cortesias[0].encabezado).toContain('https://app.example/join/dynasty');
    });

    it('sin enlace de inscripción: lo dice, avisa a la escuela y deja el lead igual', async () => {
        const f = falso({ enlace: null });
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.INFO);
        await f.turno('Sofía Gómez, 9 años');
        await f.turno('', BOTON_PUERTA.SOY);
        await f.turno('', BOTON_PUERTA.PRECIOS);
        expect(f.leads).toHaveLength(1);
        expect(f.ultimo().texto).toContain('Ya le avisé a la escuela');
        expect(f.avisos).toEqual([{ motivo: 'prospecto_sin_enlace', detalle: null }]);
    });

    it('no entiende la edad dos veces: lo que haya queda en el buzón, sin interrogatorio infinito', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.INFO);
        await f.turno('Sofía Gómez');
        await f.turno('no sé');
        expect(f.ultimo().estado).toMatchObject({ paso: 'info_edad', datos: { intentos: 1 } });
        await f.turno('ya le digo');
        expect(f.ultimo().step).toBe('puerta_info_listo');
        expect(f.leads[0]).toMatchObject({ deportista: 'Sofía Gómez', edad: null });
        expect(f.avisos[0].motivo).toBe('prospecto_sin_enlace');
    });

    it('con flujo abierto, un botón de OTRA cosa suelta el flujo; pedir un asesor también', async () => {
        const f = falso();
        await iniciarPuerta(f.ctx, '');
        await f.turno('', BOTON_PUERTA.INFO);
        expect(await f.turno('Ver mis pagos', 'sm_ver_pagos')).toBe(false);
        expect(await f.turno('necesito hablar con una persona')).toBe(false);
    });
});

// ─── 3. Prospecto: frases reales que caían en «No reconozco este número» ─────

describe('reconocer al prospecto (casos reales de Dynasty, 2026-10-24)', () => {
    it.each([
        'papá de Sofía Gómez Uribe para información',
        'Mi hija se quiere meter en la academia de voleibol',
        'Noo mi hija no es de la escuela',
        'Hola, somos nuevos y queremos conocer el club',
        'quiero meter a mi hija en la academia',
    ])('«%s» → prospecto', (frase) => {
        expect(intencionDeProspecto(frase)).toBe(true);
    });

    it('«mi hija» + escuela ya NO es «pagos» para el desconocido (regla 4 eliminada)', () => {
        expect(temaEscolar('Mi hija se quiere meter en la academia de voleibol', { sinFamiliaImplicita: true })).toBeNull();
        expect(temaEscolar('Mi hija no va a ir al entrenamiento hoy', { sinFamiliaImplicita: true })).toBeNull();
        // Con una señal propia de cliente SÍ sigue siendo pagos.
        expect(temaEscolar('Envío el comprobante de la mensualidad de mi hija', { sinFamiliaImplicita: true })).toBe('pagos');
        // Sin la opción, la regla vieja sigue para quien la usa a propósito.
        expect(temaEscolar('Mi hija no va a ir al entrenamiento hoy')).toBe('pagos');
    });

    it('lo que NO es prospecto sigue sin serlo (no se abre la puerta de más)', () => {
        expect(intencionDeProspecto('Mi hija ya se durmió')).toBe(false);
        expect(intencionDeProspecto('Soy nuevo en el barrio')).toBe(false);
        expect(intencionDeProspecto('mi hijo no está en el equipo de natación')).toBe(false);
    });
});

// ─── 4. Planes: «¿cuántas clases tiene el plan pro?» ─────────────────────────

describe('clases por plan (offering_plans.max_sessions)', () => {
    const planes = [
        { nombre: 'START', precio: 90000, clases: 4 },
        { nombre: 'PRO', precio: 150000, clases: 8 },
        { nombre: 'ELITE', precio: 180000, clases: 12 },
        { nombre: 'PLAN SELECCION', precio: 200000, clases: null },
    ];

    it('la lista de precios dice las clases; sin dato no inventa', () => {
        const t = textoDePrecios(planes)!;
        expect(t).toContain('• Pro: *$150.000* · 8 clases al mes');
        expect(t).toContain('• Start: *$90.000* · 4 clases al mes');
        expect(t).toMatch(/• Plan seleccion: \*\$200\.000\*$/m);
        expect(textoDeClases(1)).toBe('1 clase al mes');
        expect(textoDeClases(0)).toBeNull();
        expect(textoDeClases(null)).toBeNull();
    });

    it.each([
        '¿El plan pro cuántas clases son?',
        'cuántas clases tiene el plan pro',
        '¿Cuántas veces a la semana es el plan elite?',
        'cuantas clases incluye la mensualidad',
    ])('«%s» es esta pregunta', (frase) => {
        expect(preguntaPorClasesDePlan(frase)).toBe(true);
    });

    it.each([
        '¿Cuántas clases hay hoy?',
        'hay clase hoy?',
        'cuántas clases me faltan del mes de octubre',
        'Cuánto vale el plan pro',
    ])('«%s» NO es esta pregunta', (frase) => {
        expect(preguntaPorClasesDePlan(frase)).toBe(false);
    });

    it('«plan pro» responde 8 clases; «PLAN SELECCION» (sin max_sessions) no inventa y queda para la escuela', () => {
        const pro = respuestaClasesDePlan(planes, '¿El plan pro cuántas clases son?')!;
        expect(pro.sinDato).toBe(false);
        expect(pro.texto).toContain('El plan *Pro* incluye *8 clases al mes*');
        expect(pro.texto).toContain('$150.000');
        const seleccion = respuestaClasesDePlan(planes, 'cuántas clases tiene el plan seleccion')!;
        expect(seleccion.sinDato).toBe(true);
        expect(seleccion.texto).not.toMatch(/\d+ clases/);
        expect(seleccion.texto).toContain('la escuela te confirma');
    });

    it('sin nombrar un plan que exista: la lista de planes con sus clases', () => {
        const r = respuestaClasesDePlan(planes, 'cuántas clases tienen los planes')!;
        expect(r.texto).toContain('8 clases al mes');
        expect(r.texto).toContain('12 clases al mes');
        expect(respuestaClasesDePlan([], 'cuántas clases tiene el plan pro')).toBeNull();
    });
});

// ─── 5. Anti-repetición, horas hábiles y textos de la retoma ─────────────────

describe('anti-repetición (30 min por conversación)', () => {
    const ahora = Date.parse('2026-10-24T15:00:00Z');
    const hace = (min: number) => ahora - min * 60_000;

    it('«no puedo leer ese formato» dos veces en 5 min → la segunda no sale', () => {
        const previos = [{ texto: 'Hola 👋 soy el asistente automático de Dynasty.\n\n' + TEXTO_MIME_RECHAZADO, momento: hace(5) }];
        expect(esRepeticionReciente(TEXTO_MIME_RECHAZADO, previos, ahora)).toBe(true);
    });

    it('el mismo «Todavía nadie…» en el mismo segundo → no sale', () => {
        const t = 'Todavía nadie de la escuela ha podido contestarte 🙏 Ya les volví a avisar.';
        expect(esRepeticionReciente(t, [{ texto: t, momento: ahora }], ahora)).toBe(true);
    });

    it('pasados 30 min sí vuelve a salir, y un texto distinto nunca se frena', () => {
        const t = TEXTO_MIME_RECHAZADO;
        expect(esRepeticionReciente(t, [{ texto: t, momento: hace(31) }], ahora)).toBe(false);
        expect(esRepeticionReciente(t, [{ texto: 'Otra cosa que dijo el bot hace un momento', momento: hace(2) }], ahora)).toBe(false);
    });

    it('los textos cortos («Listo», «Gracias») pueden repetirse', () => {
        expect(esRepeticionReciente('Listo, gracias', [{ texto: 'Listo, gracias', momento: ahora }], ahora)).toBe(false);
    });

    it('lo que contesta una pregunta directa y los flujos con estado están exentos', () => {
        expect(exentoDeAntirrepeticion({ step: 'get_payment_status' })).toBe(true);
        expect(exentoDeAntirrepeticion({ step: 'cortesia_ofrecer' })).toBe(true);
        expect(exentoDeAntirrepeticion({ step: 'puerta_info_nombre', flujo: FLUJO_PUERTA })).toBe(true);
        expect(exentoDeAntirrepeticion({ step: 'payment_fallback' })).toBe(true);
        expect(exentoDeAntirrepeticion({ step: 'adjunto_formato_no_soportado' })).toBe(false);
        expect(exentoDeAntirrepeticion({ step: 'escalacion_sin_respuesta' })).toBe(false);
        expect(exentoDeAntirrepeticion({ step: 'escalated' })).toBe(false);
    });
});

describe('horas hábiles (SLA de 2 h) con el horario de Dynasty (lunes a viernes, 4–9 p. m.)', () => {
    const dynasty: HorarioDeAtencion = {
        tz: 'America/Bogota',
        dias: { 1: ['16:00', '21:00'], 2: ['16:00', '21:00'], 3: ['16:00', '21:00'], 4: ['16:00', '21:00'], 5: ['16:00', '21:00'] } as any,
    };
    // Martes 20-oct-2026 20:00 en Bogotá (UTC-5) = 21-oct 01:00Z.
    const creada = Date.parse('2026-10-21T01:00:00Z');
    const bogota = (iso: string) => Date.parse(`${iso}-05:00`);

    it('solo cuentan las horas dentro del horario de atención', () => {
        // Mar 20:00–21:00 (60) + mié 16:00–16:30 (30)
        expect(minutosHabiles(creada, bogota('2026-10-21T16:30:00'), dynasty)).toBe(90);
        expect(minutosHabiles(creada, bogota('2026-10-21T22:00:00'), dynasty)).toBe(60 + 300);
    });

    it('a las 2 h hábiles vence: el miércoles a las 5:00 p. m., no antes', () => {
        expect(slaVencido(creada, bogota('2026-10-21T16:59:00'), dynasty)).toBe(false);
        expect(slaVencido(creada, bogota('2026-10-21T17:00:00'), dynasty)).toBe(true);
    });

    it('fines de semana y madrugadas no cuentan; un escalamiento del viernes en la noche vence el lunes', () => {
        const viernes = bogota('2026-10-23T20:30:00');
        expect(minutosHabiles(viernes, bogota('2026-10-26T15:00:00'), dynasty)).toBe(30);
        expect(slaVencido(viernes, bogota('2026-10-26T17:30:00'), dynasty)).toBe(true);
        expect(slaVencido(viernes, bogota('2026-10-26T17:29:00'), dynasty)).toBe(false);
    });

    it('sin horario configurado cuenta el reloj corrido (no se inventa un horario)', () => {
        expect(minutosHabiles(creada, creada + 125 * 60_000, null)).toBe(125);
        expect(minutosHabiles(creada, creada + 125 * 60_000, {})).toBe(125);
        expect(slaVencido(creada, creada + 119 * 60_000, null)).toBe(false);
        expect(slaVencido(creada, creada + 120 * 60_000, null)).toBe(true);
    });

    it('el aviso al equipo del SLA dice «2 h», no los 30 min del primer re-aviso', () => {
        const t = textoDelAvisoAlEquipo({ etapa: 'reaviso', urgencia: 'normal', categoria: null, tema: null, minSinRespuesta: 120 }, 'Ana');
        expect(t.cuerpo).toContain('Pasaron 2 h');
        const normal = textoDelAvisoAlEquipo({ etapa: 'reaviso', urgencia: 'normal', categoria: null, tema: null }, 'Ana');
        expect(normal.cuerpo).toContain('Pasaron 30 min');
    });
});

describe('«Todavía nadie…» ya no es un no-respuesta', () => {
    it('dentro de horario y sin hora que decir → se calla (la escuela se re-avisa igual)', () => {
        expect(textoSinRespuesta({ urgencia: 'normal', categoria: null, fueraDeHorario: false })).toBeNull();
        expect(textoSinRespuesta({ urgencia: 'normal', categoria: null, fueraDeHorario: true, proximaAtencion: null })).toBeNull();
    });

    it('fuera de horario dice la hora concreta', () => {
        const t = textoSinRespuesta({ urgencia: 'normal', categoria: null, fueraDeHorario: true, proximaAtencion: 'mañana a las 16:00' })!;
        expect(t).toContain('mañana a las 16:00');
        expect(t).not.toContain('Todavía nadie');
    });

    it('lo urgente siempre se dice (con el 123 si hay riesgo)', () => {
        expect(textoSinRespuesta({ urgencia: 'urgente', categoria: 'lesion', fueraDeHorario: false })).toContain('123');
    });
});

// ─── 6. Contactos personales de la dueña ─────────────────────────────────────

describe('llamar a la dueña por su nombre sin pedir nada → silencio', () => {
    const equipo = new Map([['milena', 'Milena'], ['mile', 'Milena'], ['milenita', 'Milena']]);
    const escolar = (t: string) => /\b(horarios?|clases?|precios?|inscrib\w*|mensualidad|torneos?)\b/i.test(t);

    it.each([
        'Hola Milena buenos días',
        'Mile querida, cómo has estado? hace tiempo no hablamos',
        'Hola Milena… me podrías facilitar el correo',
    ])('«%s» (con el equipo cargado)', (frase) => {
        expect(llamaAPersonaSinPedir(frase, equipo, escolar)).toBe(true);
    });

    it('aunque el nombre no esté en el equipo: «Hola Milena…» con nombre propio tras el saludo', () => {
        expect(llamaAPersonaSinPedir('Hola Milena… me podrías facilitar el correo', new Map(), escolar)).toBe(true);
        expect(llamaAPersonaSinPedir('Buenas tardes Marcela, quedé de escribirte', new Map(), escolar)).toBe(true);
    });

    it('un pedido real de la escuela NUNCA se calla', () => {
        expect(llamaAPersonaSinPedir('Hola Milena, cuánto vale la mensualidad', equipo, escolar)).toBe(false);
        expect(llamaAPersonaSinPedir('Mile, ¿a qué hora son las clases?', equipo, escolar)).toBe(false);
        expect(llamaAPersonaSinPedir('Hola, quiero inscribir a mi hija', equipo, escolar)).toBe(false);
    });

    it('pedir hablar con una persona se escala, no se calla', () => {
        expect(llamaAPersonaSinPedir('Hola Milena necesito hablar con alguien', equipo, escolar)).toBe(false);
        expect(llamaAPersonaSinPedir('Milena estás por acá?', equipo, escolar)).toBe(false);
    });

    it('saludos genéricos sin nombre no son «personal» (no se les quita la puerta)', () => {
        expect(llamaAPersonaSinPedir('Buenas, una consulta sobre lo del fin de semana', new Map(), escolar)).toBe(false);
        expect(llamaAPersonaSinPedir('Hola buenas tardes', new Map(), escolar)).toBe(false);
        expect(llamaAPersonaSinPedir('Hola quisiera saber algo', new Map(), escolar)).toBe(false);
    });
});

// ─── 7. Los caminos del bot (andamiaje con Supabase de mentira) ──────────────

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-v2';
const TEL = '573000000042';

type Fila = { wa_message_id: string | null; direction: 'inbound' | 'outbound'; type?: string; text_body: string | null;
    payload?: any; ai_generated: boolean; created_at: string };
const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

interface OpBase {
    filas?: Fila[];
    ultimoSaliente?: any;
    contactName?: string | null;
    planes?: any[];
    responderPrecios?: boolean;
    businessHours?: any;
    escalaciones?: any[];
    humanoRespondio?: boolean;
    salientesBot?: { text_body: string; created_at: string }[];
    equipo?: string[];
    identificada?: boolean;
}

function base(op: OpBase = {}) {
    const filas = op.filas ?? [];
    h.state.resolve = (table, ops) => {
        const eqs = ops.filter(([m]) => m === 'eq').map(([, a]) => a);
        const direccion = eqs.find((a) => a[0] === 'direction')?.[1];
        const esUpdate = ops.some(([m]) => m === 'update');
        const presentacion = ops.some(([m, a]) => m === 'ilike' && String(a[1]).includes('asistente'));
        const paso = eqs.find((a) => String(a[0]).endsWith('>>step'))?.[1];
        if (table === 'whatsapp_messages' || table === 'whatsapp_message_drafts') {
            if (presentacion) return { count: 0, error: null };
            if (paso) return { count: 0, data: [], error: null };
        }
        if (table === 'whatsapp_messages') {
            if (esUpdate) return { data: [{ id: 'm-reservada' }], error: null };
            // SLA: los escalamientos candidatos.
            if (ops.some(([m, a]) => m === 'in' && String(a[0]).includes('step'))) return { data: op.escalaciones ?? [], error: null };
            // Antirrepetición: lo que el bot ya mandó.
            if (direccion === 'outbound' && eqs.some((a) => a[0] === 'ai_generated' && a[1] === true)) {
                return { data: op.salientesBot ?? [], error: null };
            }
            // ¿Escribió una persona de la escuela?
            if (direccion === 'outbound' && eqs.some((a) => a[0] === 'ai_generated' && a[1] === false)) {
                return { data: op.humanoRespondio ? [{ type: 'text', text_body: 'Hola, ya te contesto' }] : [], error: null };
            }
            // Estado del flujo: el payload del último saliente.
            if (direccion === 'outbound' && ops.some(([m]) => m === 'order')) {
                return { data: op.ultimoSaliente ? { payload: op.ultimoSaliente, created_at: new Date().toISOString() } : null, error: null };
            }
            if (direccion === 'inbound' && ops.some(([m]) => m === 'order') && ops.some(([m, a]) => m === 'select' && String(a[0]).startsWith('conversation_id'))) {
                return { data: [{ conversation_id: CONV, integration_id: 'int-1' }], error: null };
            }
            if (direccion === 'inbound') return { data: filas.filter((f) => f.direction === 'inbound'), error: null };
            if (!direccion) return { data: filas, error: null };
            return { data: null, count: 0, error: null };
        }
        if (table === 'whatsapp_message_drafts') return { data: null, count: 0, error: null };
        if (table === 'whatsapp_conversations') {
            return { data: { id: CONV, contact_wa_id: TEL, parent_id: null, identified: op.identificada ?? false, status: 'open',
                contact_name: op.contactName === undefined ? null : op.contactName, tomada_por: null, tomada_hasta: null }, error: null };
        }
        if (table === 'school_whatsapp_integrations') return { data: INTEGRATION, error: null };
        if (table === 'whatsapp_settings') {
            return { data: { ai_enabled: true, mode: 'assisted', responder_desconocidos: false, responder_prospectos: true,
                business_hours: op.businessHours ?? null }, error: null };
        }
        if (table === 'school_settings') {
            return { data: { wa_responder_precios: op.responderPrecios ?? false, business_hours: null }, error: null };
        }
        if (table === 'offering_plans') return { data: op.planes ?? [], error: null };
        if (table === 'profiles') return { data: (op.equipo ?? []).map((n) => ({ full_name: n })), error: null };
        if (table === 'school_join_qr_codes') return { data: [{ slug: 'dynasty-inscripcion', target_type: 'open', signup_count: 121 }], error: null };
        if (table === 'schools') return { data: { name: 'DYNASTY VOLLEY CLUB', owner_id: 'owner-1', slug: 'dynasty', address: 'Cl. 12 Bis #71g-09, Bogotá' }, error: null };
        if (table === 'school_trial_slots' || table === 'teams' || table === 'school_branches') return { data: [], error: null };
        if (table === 'school_members') return { data: [], error: null };
        return { data: null, error: null };
    };
    h.state.rpc = (fn) => {
        if (fn === 'wa_identify_by_phone') return { data: { estado: 'desconocido' }, error: null };
        return { data: null, error: null };
    };
    h.botEncendido.mockResolvedValue(true);
    h.debeAtender.mockResolvedValue({ atender: false, tipo: 'desconocido', botEncendido: true, tomada: false });
}

const borradores = () => h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts').map((i) => i.row);
const avisos = () => h.state.inserts.filter((i) => i.table === 'notifications').map((i) => i.row);

beforeEach(() => {
    vi.clearAllMocks();
    h.state.inserts = [];
    _olvidarReservasDePaso();
    _limpiarCacheVocativos();
});

describe('«No reconozco este número entre las familias» ya no sale a quien pregunta como prospecto', () => {
    const casos = [
        'papá de Sofía Gómez Uribe para información',
        'Mi hija se quiere meter en la academia de voleibol',
        'Noo mi hija no es de la escuela',
    ];
    for (const frase of casos) {
        it(`«${frase}» → información de inscripción, sin «No reconozco…» ni «datos privados»`, async () => {
            base();
            const r = await atenderDesconocido(INTEGRATION, CONV, TEL, frase);
            expect(r).toBe('inscripcion');
            const [b] = borradores();
            expect(b.tool_context).toMatchObject({ step: 'desconocido_tema_escolar', intencion: 'inscripcion' });
            expect(b.proposed_text).toContain('/join/dynasty-inscripcion');
            expect(b.proposed_text).not.toMatch(/No reconozco|datos privados|familias de la escuela/);
        });
    }

    it('con una señal propia de cliente («comprobante de la mensualidad») el pedido de verificación sigue', async () => {
        base();
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola, ¿cuánto debo de la mensualidad de mi hija?');
        expect(r).toBe('pagos');
        expect(borradores()[0].proposed_text).toContain('datos privados');
    });
});

describe('la puerta única reemplaza al comodín «Si eres familia…»', () => {
    it('una consulta sin tema claro → UNA pregunta con tres botones (step histórico ask_email), sin pedir el correo', async () => {
        base();
        await runBotTurn(INTEGRATION, CONV, TEL, 'Buenas, una consulta sobre lo del fin de semana', 'wamid.1');
        expect(borradores()).toHaveLength(1);
        const b = borradores()[0];
        expect(b.tool_context).toMatchObject({ step: 'ask_email', flujo: FLUJO_PUERTA, paso_puerta: 'menu' });
        expect(b.tool_context.botones.map((x: any) => x.id)).toEqual(['sm_pd_club', 'sm_pd_info', 'sm_pd_otro']);
        expect(b.proposed_text).toContain('¿Qué necesitas?');
        expect(b.proposed_text).not.toMatch(/Si eres familia|correo electrónico/);
        // Texto del modo asistido (sin botones): las tres opciones escritas.
        expect(b.proposed_text).toContain('*Ya soy del club*');
    });

    it('«Ya soy del club» → pide el nombre del deportista; el nombre deja aviso con el dato (push + correo)', async () => {
        base({ ultimoSaliente: { step: 'ask_email', flujo: FLUJO_PUERTA, paso_puerta: 'menu', datos_puerta: {} } });
        let r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Ya soy del club', BOTON_PUERTA.CLUB);
        expect(r).toBe('puerta');
        const pregunta = borradores()[0];
        expect(pregunta.tool_context).toMatchObject({ flujo: FLUJO_PUERTA, paso_puerta: 'club_nombre' });
        expect(pregunta.proposed_text).toContain('nombre completo del deportista');
        expect(pregunta.proposed_text).not.toMatch(/Cuánto debe|saldo/);

        base({ ultimoSaliente: pregunta.tool_context });
        r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Sofía Gómez Uribe');
        expect(r).toBe('puerta');
        const cierre = borradores()[1];
        expect(cierre.tool_context).toMatchObject({ step: 'puerta_club_recibido', deportista_declarado: 'Sofía Gómez Uribe' });
        expect(cierre.tool_context.flujo).toBeUndefined();               // terminal
        expect(h.sendToUser).toHaveBeenCalledWith('owner-1', expect.objectContaining({ title: expect.stringContaining('dice ser del club') }));
        expect(h.correo).toHaveBeenCalledWith(expect.objectContaining({ motivo: expect.stringContaining('Sofía Gómez Uribe') }));
    });

    it('«Otro tema» → buzón y aviso a la escuela, sin más preguntas', async () => {
        base({ ultimoSaliente: { step: 'ask_email', flujo: FLUJO_PUERTA, paso_puerta: 'menu', datos_puerta: {} } });
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Otro tema', BOTON_PUERTA.OTRO);
        expect(r).toBe('puerta');
        expect(borradores()[0].tool_context).toMatchObject({ step: 'puerta_otro_tema' });
        expect(borradores()[0].proposed_text).not.toContain('?');
        expect(h.sendToUser).toHaveBeenCalledWith('owner-1', expect.objectContaining({ title: expect.stringContaining('otro tema') }));
    });

    it('«Quiero información» → mini-registro completo hasta el lead (4 respuestas)', async () => {
        base({ contactName: 'Laura Gómez', responderPrecios: true,
            planes: [{ name: 'PRO', price: 150000, is_active: true, max_sessions: 8 }],
            ultimoSaliente: { step: 'ask_email', flujo: FLUJO_PUERTA, paso_puerta: 'menu', datos_puerta: {} } });

        const paso = async (texto: string, botonId: string | null = null) => {
            const antes = borradores().length;
            const r = await atenderDesconocido(INTEGRATION, CONV, TEL, texto, botonId);
            const nuevo = borradores()[antes];
            // El siguiente turno ve como estado el payload del último saliente.
            base({ contactName: 'Laura Gómez', responderPrecios: true,
                planes: [{ name: 'PRO', price: 150000, is_active: true, max_sessions: 8 }], ultimoSaliente: nuevo?.tool_context });
            return { r, nuevo };
        };

        let s = await paso('Quiero información', BOTON_PUERTA.INFO);
        expect(s.nuevo.proposed_text).toContain('¿Cómo se llama el deportista?');
        s = await paso('Sofía Gómez Uribe');
        expect(s.nuevo.proposed_text).toContain('edad');
        s = await paso('9');
        expect(s.nuevo.tool_context).toMatchObject({ paso_puerta: 'info_acudiente' });
        expect(s.nuevo.tool_context.botones.map((b: any) => b.title)).toEqual(['Soy Laura', 'Otro nombre']);
        s = await paso('Soy Laura', BOTON_PUERTA.SOY);
        expect(s.nuevo.tool_context).toMatchObject({ paso_puerta: 'info_quiere' });
        expect(s.nuevo.tool_context.botones.map((b: any) => b.title)).toEqual(['Clase de cortesía', 'Inscribirme', 'Solo precios']);
        s = await paso('Solo precios', BOTON_PUERTA.PRECIOS);

        expect(s.nuevo.tool_context).toMatchObject({ step: 'desconocido_tema_escolar', intencion: 'puerta_info' });
        expect(s.nuevo.proposed_text).toContain('registré a *Sofía Gómez Uribe* (9 años)');
        expect(s.nuevo.proposed_text).toContain('Pro: *$150.000* · 8 clases al mes');
        expect(s.nuevo.proposed_text).toContain('/join/dynasty-inscripcion');
        expect(registrarLeadDeProspecto).toHaveBeenCalledWith(expect.objectContaining({
            schoolId: 'school-1', contactWaId: TEL, nombre: 'Laura Gómez', estado: 'respondido',
            completo: expect.objectContaining({ deportista: 'Sofía Gómez Uribe', edad: 9, acudiente: 'Laura Gómez', quiere: 'precios' }),
        }));
    });

    it('un correo a mitad de «Ya soy del club» arranca el OTP (camino alterno), no se toma como nombre', async () => {
        base({ ultimoSaliente: { step: 'puerta_club_pregunta', flujo: FLUJO_PUERTA, paso_puerta: 'club_nombre', datos_puerta: {} } });
        await atenderDesconocido(INTEGRATION, CONV, TEL, 'mama.prueba@correo.com');
        expect(borradores().some((b) => b.tool_context?.paso_puerta === 'club_nombre')).toBe(false);
    });
});

describe('contacto personal de la dueña: no recibe la puerta ni «escríbeme tu correo»', () => {
    it.each([
        'Hola Milena buenos días',
        'Mile querida, cómo has estado? hace tiempo no hablamos',
        'Hola Milena… me podrías facilitar el correo',
    ])('«%s» → silencio', async (frase) => {
        base({ equipo: ['Milena Pérez'] });
        await runBotTurn(INTEGRATION, CONV, TEL, frase, 'wamid.p');
        expect(borradores()).toHaveLength(0);
    });

    it('sin el equipo cargado igual calla a «Hola Milena… me podrías facilitar el correo»', async () => {
        base();
        await runBotTurn(INTEGRATION, CONV, TEL, 'Hola Milena… me podrías facilitar el correo', 'wamid.p2');
        expect(borradores()).toHaveLength(0);
    });

    it('con un pedido real y el nombre de la dueña sí se atiende (puerta)', async () => {
        base({ equipo: ['Milena Pérez'] });
        await runBotTurn(INTEGRATION, CONV, TEL, 'mile voy tenemos entreno?', 'wamid.p3');
        expect(borradores().map((b) => b.tool_context?.step)).toEqual(['ask_email']);
    });
});

describe('«¿El plan pro cuántas clases son?» se contesta sin escalar', () => {
    const planes = [
        { name: 'PRO', price: 150000, is_active: true, max_sessions: 8 },
        { name: 'PLAN SELECCION', price: 200000, is_active: true, max_sessions: null },
    ];

    it('desconocido → 8 clases desde offering_plans', async () => {
        base({ responderPrecios: true, planes });
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, '¿El plan pro cuántas clases son?');
        expect(r).toBe('plan_clases');
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].proposed_text).toContain('El plan *Pro* incluye *8 clases al mes*');
        expect(borradores()[0].tool_context).toMatchObject({ step: 'plan_clases', sin_dato: false });
    });

    it('«plan seleccion» sin max_sessions → no inventa; queda en el buzón para la escuela', async () => {
        base({ responderPrecios: true, planes });
        await atenderDesconocido(INTEGRATION, CONV, TEL, 'cuántas clases tiene el plan seleccion');
        expect(borradores()[0].proposed_text).not.toMatch(/\d+ clases/);
        expect(borradores()[0].proposed_text).toContain('la escuela te confirma');
        expect(borradores()[0].tool_context).toMatchObject({ sin_dato: true });
    });

    it('con los valores apagados (wa_responder_precios=false) no se publica nada', async () => {
        base({ responderPrecios: false, planes });
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, '¿El plan pro cuántas clases son?');
        expect(r).not.toBe('plan_clases');
        expect(borradores().some((b) => /8 clases/.test(b.proposed_text))).toBe(false);
    });

    it('la retoma de media hora después lo contesta en vez del «Todavía nadie…» (…el caso de los 72 min)', async () => {
        base({ responderPrecios: true, planes, filas: [
            { wa_message_id: 'in-0', direction: 'inbound', type: 'text', text_body: 'Quiero inscribir a mi hija en voleibol', ai_generated: false, created_at: hace(60) },
            { wa_message_id: 'bot-1', direction: 'outbound', type: 'text', text_body: '¡Gracias! 🙌 Ya pasé tu mensaje a la escuela…', payload: { step: 'prospecto_seguimiento' }, ai_generated: true, created_at: hace(50) },
            { wa_message_id: 'in-1', direction: 'inbound', type: 'text', text_body: '¿El plan pro cuántas clases son?', ai_generated: false, created_at: hace(40) },
        ] });
        await revisarRetomas(Date.now());
        const [b] = borradores();
        expect(b.tool_context).toMatchObject({ step: 'retoma_respuesta' });
        expect(b.proposed_text).toContain('8 clases al mes');
        expect(b.proposed_text).not.toContain('Todavía nadie');
    });
});

describe('retoma sin respuesta: una hora concreta o nada', () => {
    const filas: Fila[] = [
        { wa_message_id: 'in-0', direction: 'inbound', type: 'text', text_body: 'Quiero inscribir a mi hija en voleibol', ai_generated: false, created_at: hace(50) },
        { wa_message_id: 'bot-1', direction: 'outbound', type: 'text', text_body: '¡Gracias! 🙌 Ya pasé tu mensaje a la escuela…', payload: { step: 'prospecto_seguimiento' }, ai_generated: true, created_at: hace(40) },
        { wa_message_id: 'in-1', direction: 'inbound', type: 'text', text_body: '¿Llevan uniforme a las clases?', ai_generated: false, created_at: hace(35) },
    ];

    it('fuera de horario: «te responden mañana a las 16:00» (no «Todavía nadie…»)', async () => {
        base({ filas });
        vi.mocked(estadoDeHorario).mockResolvedValueOnce({ fueraDeHorario: true, proximaAtencion: 'mañana a las 16:00' } as any);
        await revisarRetomas(Date.now());
        const [b] = borradores();
        expect(b.tool_context).toMatchObject({ step: 'retoma_sin_respuesta' });
        expect(b.proposed_text).toContain('te responden mañana a las 16:00');
        expect(b.proposed_text).not.toContain('Todavía nadie');
    });

    it('dentro de horario: se calla, pero la escuela se re-avisa', async () => {
        base({ filas });
        await revisarRetomas(Date.now());
        expect(borradores()).toHaveLength(0);
        expect(avisos().length).toBeGreaterThan(0);
    });
});

describe('anti-repetición dentro de deliver', () => {
    const previo = (min: number) => ({
        text_body: 'Hola 👋 soy el asistente automático de Dynasty.\n\n' + TEXTO_MIME_RECHAZADO, created_at: hace(min),
    });

    it('el mismo texto de un aviso no sale dos veces en 30 min', async () => {
        base({ salientesBot: [previo(5)] });
        expect(await yaSalioElMismoTexto(CONV, TEXTO_MIME_RECHAZADO)).toBe(true);
        await deliver(INTEGRATION, CONV, TEL, TEXTO_MIME_RECHAZADO, { step: 'adjunto_formato_no_soportado' });
        expect(borradores()).toHaveLength(0);
    });

    it('a los 31 min sí sale', async () => {
        base({ salientesBot: [previo(31)] });
        await deliver(INTEGRATION, CONV, TEL, TEXTO_MIME_RECHAZADO, { step: 'adjunto_formato_no_soportado' });
        expect(borradores()).toHaveLength(1);
    });

    it('una respuesta a una pregunta directa se repite aunque sea idéntica («¿cuánto debo?» dos veces)', async () => {
        base({ salientesBot: [previo(5)] });
        await deliver(INTEGRATION, CONV, TEL, TEXTO_MIME_RECHAZADO, { step: 'get_payment_status' });
        expect(borradores()).toHaveLength(1);
    });

    it('si no se puede leer lo anterior, se habla (callar es peor que repetir)', async () => {
        base();
        h.state.resolve = () => ({ data: null, error: { message: 'boom' } });
        expect(await yaSalioElMismoTexto(CONV, TEXTO_MIME_RECHAZADO)).toBe(false);
    });
});

describe('SLA: 2 h hábiles sin respuesta humana → correo + push a la escuela', () => {
    const escalada = (creadaIso: string, extra: Record<string, any> = {}) => ({
        id: 'esc-1', conversation_id: CONV, integration_id: 'int-1', created_at: creadaIso,
        payload: { step: 'escalated', urgencia: 'normal', plazo_min: 30, ...extra },
    });
    const dynasty = { tz: 'America/Bogota', dias: { 1: ['16:00', '21:00'], 2: ['16:00', '21:00'], 3: ['16:00', '21:00'], 4: ['16:00', '21:00'], 5: ['16:00', '21:00'] } };
    // Creada el martes 20:00 (Bogotá).
    const creada = '2026-10-21T01:00:00Z';

    it('a las 2 h hábiles: aviso in-app + push y correo con el motivo del SLA (una sola vez)', async () => {
        base({ businessHours: dynasty, escalaciones: [escalada(creada)], contactName: 'Laura Gómez' });
        const r = await revisarSlaDeEscalaciones(Date.parse('2026-10-21T22:30:00Z'));      // miércoles 5:30 p. m.
        expect(r).toMatchObject({ revisadas: 1, avisadas: 1 });
        expect(avisos()).toHaveLength(1);
        expect(avisos()[0].message).toContain('Pasaron 2 h');
        expect(avisos()[0].data).toMatchObject({ etapa: 'reaviso', conversation_id: CONV });
        expect(h.sendToUser).toHaveBeenCalled();
        expect(h.correo).toHaveBeenCalledTimes(1);
        expect(h.correo).toHaveBeenCalledWith(expect.objectContaining({
            schoolId: 'school-1', conversationId: CONV, motivo: expect.stringContaining('2 h hábiles'),
        }));
        // La familia no recibe nada.
        expect(borradores()).toHaveLength(0);
    });

    it('antes de las 2 h hábiles no avisa (la noche no cuenta)', async () => {
        base({ businessHours: dynasty, escalaciones: [escalada(creada)] });
        const r = await revisarSlaDeEscalaciones(Date.parse('2026-10-21T21:30:00Z'));      // miércoles 4:30 p. m. = 90 min hábiles
        expect(r.avisadas).toBe(0);
        expect(avisos()).toHaveLength(0);
        expect(h.correo).not.toHaveBeenCalled();
    });

    it('si una persona de la escuela ya escribió, se marca atendida y no se avisa', async () => {
        base({ businessHours: dynasty, escalaciones: [escalada(creada)], humanoRespondio: true });
        const r = await revisarSlaDeEscalaciones(Date.parse('2026-10-21T22:30:00Z'));
        expect(r).toMatchObject({ avisadas: 0, atendidas: 1 });
        expect(h.correo).not.toHaveBeenCalled();
        expect(avisos()).toHaveLength(0);
    });

    it('dos escalamientos de la misma conversación → un solo aviso', async () => {
        base({ businessHours: dynasty, escalaciones: [escalada(creada), { ...escalada('2026-10-21T01:10:00Z'), id: 'esc-2' }] });
        const r = await revisarSlaDeEscalaciones(Date.parse('2026-10-21T22:30:00Z'));
        expect(r.avisadas).toBe(1);
        expect(h.correo).toHaveBeenCalledTimes(1);
    });

    it('sin horario configurado cuenta el reloj corrido', async () => {
        base({ escalaciones: [escalada(creada)] });
        const r = await revisarSlaDeEscalaciones(Date.parse('2026-10-21T03:30:00Z'));      // +2 h 30 min
        expect(r.avisadas).toBe(1);
    });

    it('nunca lanza: sin poder leer la base devuelve ceros', async () => {
        base();
        h.state.resolve = () => ({ data: null, error: { message: 'boom' } });
        expect(await revisarSlaDeEscalaciones(Date.now())).toEqual({ revisadas: 0, avisadas: 0, atendidas: 0 });
    });
});
