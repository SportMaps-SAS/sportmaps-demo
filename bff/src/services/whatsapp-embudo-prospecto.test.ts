/**
 * Embudo del interesado por escuela (plan B2/B3 §5.1): el motor puro con un
 * contexto falso. Monster 2026-10-30: bienvenida con sus dos sedes, cinco
 * preguntas (nombre, fecha, sexo, posición, trayectoria con detalle), grupo,
 * horarios de sábado y domingo, cupo separado con consentimiento primero y
 * después las cuentas. Textos de ejemplo inventados.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    iniciarEmbudo, atenderTurnoEmbudo, BOTON_EMBUDO, leerFechaNacimiento, opcionDeTexto, leerSede, leerVarias,
    filaDeFranja, textosPorDefecto, botonDePlantilla, franjasOfrecibles, comoPagar, mensajeDeBienvenida,
    estadoParaRecordatorio, leadCompletoDeEmbudo, leadDeDatos, lineasDeSedes, cupoSimulado,
    tituloDeGrupo, grupoDeRango, pideMatricula, textoDeMatricula, detalleDeMatricula, preguntaDonde, textoDonde,
    estadoDeSalientes, pideCambioDeHorario, convocatoriaDeEmbudo,
    type CtxEmbudo, type EstadoEmbudo, type FranjaEmbudo, type RangoEmbudo, type CuentaDePagoEmbudo, type LugarDeClase,
} from './whatsapp-embudo-prospecto';
import { BOTON_PUERTA } from './whatsapp-puerta-desconocido';
import { armarEstado, textoOfertasParaPersona, type EstadoOfertas, type FilasCrudas } from './bot-ofertas.service';
import { recordatorioDePasoEmbudo, textoSinClaseDePrueba, textoDeMatriculaSinClase } from './whatsapp-embudo-prospecto';
import {
    MAX_TEXTO_OFERTAS, datosDePersonaDeEmbudo, trayectoriaDeTexto, ofertasConCriterios, prefillDeOfertas,
} from './whatsapp-embudo-prospecto';
import {
    ajustesDesdeFila, ajustesClasePruebaDesdeFila, type AjustesWhatsAppEscuela, type AjustesClasePrueba,
} from './whatsapp-ajustes-escuela.service';
import type { ResultadoCupo } from './clase-prueba-agenda.service';

const NORTE = '11111111-1111-4111-8111-111111111111';
const SUBA = '22222222-2222-4222-8222-222222222222';

export const PREGUNTAS_MONSTER = [
    { clave: 'nombre', texto: '¿Cuál es el nombre completo del deportista?', tipo: 'texto' },
    { clave: 'fecha_nacimiento', texto: '¿Cuál es su fecha de nacimiento? (día/mes/año)', tipo: 'fecha' },
    { clave: 'sexo', texto: '¿Es hombre o mujer?', tipo: 'botones', opciones: ['Mujer', 'Hombre'] },
    {
        clave: 'posicion', texto: '¿En qué posición juega?', tipo: 'lista', boton: 'Elegir posición',
        opciones: ['Armador(a)', 'Opuesto', 'Punta', 'Central', 'Líbero', 'Aún no tengo posición'],
    },
    {
        clave: 'trayectoria', texto: '¿Cuál es su trayectoria en el voleibol?', tipo: 'botones',
        opciones: ['Estoy empezando', 'Colegio o escuela', 'Club y torneos'],
        detalle: { si: ['Club y torneos'], clave: 'trayectoria_detalle', texto: '¡Qué bien! 🏆 Cuéntame en un mensaje en qué clubes ha entrenado y qué torneos ha jugado.' },
    },
];

const BIENVENIDA = '¡Hola! 👋 Bienvenid@ a Club Monsters Volley 🏐⚡\n' +
    'Nos alegra que estés aquí: estás a un paso de unirte a una de las mejores comunidades de voleibol de Bogotá.\n' +
    'Para enviarte la información exacta que necesitas, cuéntanos: ¿cuál sede te queda más cerca?';

const AJ_MONSTER: AjustesWhatsAppEscuela = ajustesDesdeFila({
    wa_modo_cortesia: 'clase', wa_bienvenida: BIENVENIDA,
    wa_botones_sede: [{ branch_id: NORTE, titulo: '🟡 Sede Norte' }, { branch_id: SUBA, titulo: '⚫ Sede Suba' }],
    wa_preguntas_prospecto: PREGUNTAS_MONSTER, wa_modo_discreto: 'no', wa_temas_a_persona: null,
});
const CLASE_MONSTER: AjustesClasePrueba = ajustesClasePruebaDesdeFila({
    nombre_clase: 'prueba', trial_price: 15000, separar_horas: 24, dias_semana: [0, 6], avisar_entrenador: true,
});
const SEDES = [
    { branchId: NORTE, nombre: 'Sede Norte', direccion: 'Calle 201 #67-12' },
    { branchId: SUBA, nombre: 'Sede Suba', direccion: 'Calle 152 #94A-67' },
];
// Jueves 29 de octubre de 2026, 6:40 p. m. en Bogotá.
const AHORA = new Date('2026-10-29T23:40:00.000Z');
const FRANJAS: FranjaEmbudo[] = [
    { id: 's-sab31', fecha: '2026-10-31', horaInicio: '08:00', horaFin: '10:00', lugar: 'La Enseñanza', cupos: 5 },
    { id: 's-dom01', fecha: '2026-11-01', horaInicio: '08:00', horaFin: '10:00', lugar: 'La Enseñanza', cupos: 999 },
    { id: 's-lun02', fecha: '2026-11-02', horaInicio: '16:00', horaFin: '18:00', lugar: 'Pinar 2', cupos: 6 },
    { id: 's-sab07', fecha: '2026-11-07', horaInicio: '08:00', horaFin: '10:00', lugar: 'La Enseñanza', cupos: 6 },
    { id: 's-lleno', fecha: '2026-11-08', horaInicio: '08:00', horaFin: '10:00', lugar: 'La Enseñanza', cupos: 0 },
];
// Como lo devuelve B3 (RangoGrupo): nombre crudo del equipo y nombres de sus profes.
const GRUPO_NORTE: RangoEmbudo = { teamId: 't-infantil-fem', nombre: 'INFANTIL FEMENINO', branchId: NORTE, coachNombres: ['Iván Sossa'] };

interface Enviado { texto: string; step: string; estado: EstadoEmbudo | null; botones?: any[]; enTexto?: string; contexto?: any }

function crear(op: {
    aj?: AjustesWhatsAppEscuela; clase?: AjustesClasePrueba;
    /** Grupo por sede (lo que elegiría B3); la otra sede sale de aquí también. */
    grupos?: Record<string, RangoEmbudo | null>;
    franjas?: FranjaEmbudo[]; cupo?: ResultadoCupo; cuentas?: CuentaDePagoEmbudo[]; consentimientoPendiente?: boolean;
    yaSoyDelClub?: boolean; estado?: EstadoEmbudo | null; lead?: any;
    /** Dónde es la clase (`lugarDeLaClase`); sin la clave, el contexto no lo trae. */
    lugar?: LugarDeClase | null;
    /** Qué se puede ofrecer hoy (bot-ofertas); sin la clave, el contexto no lo trae (como antes). */
    ofertas?: EstadoOfertas;
    /** La conversación compartida de ofertas; sin la clave, el contexto no la trae. */
    iniciarOfertas?: (prefill: any) => Promise<boolean>;
    /** ¿Pidió una convocatoria en la conversación? Sin la clave, el contexto no lo trae. */
    pidioConvocatoria?: boolean;
} = {}) {
    const s = { enviados: [] as Enviado[], estado: op.estado ?? null as EstadoEmbudo | null };
    const ctx: CtxEmbudo = {
        conversationId: 'conv-1', schoolId: 'monster', contactWaId: '573001112233',
        enviar: async (texto, step, estado, botones, enTexto, contexto) => {
            s.enviados.push({ texto, step, estado, botones, enTexto, contexto });
            s.estado = estado;
        },
        ajustes: vi.fn(async () => op.aj ?? AJ_MONSTER),
        clase: vi.fn(async () => op.clase ?? CLASE_MONSTER),
        sedes: async (ids) => SEDES.filter((x) => ids.includes(x.branchId)),
        elegirGrupo: vi.fn(async (q) => {
            const grupos = op.grupos ?? { [NORTE]: GRUPO_NORTE, [SUBA]: null };
            const principal = grupos[q.branchId ?? ''] ?? null;
            const otraSede = principal ? null : Object.entries(grupos).find(([b, g]) => b !== q.branchId && g)?.[1] ?? null;
            return { principal, candidatos: principal ? [principal] : [], otraSede, motivo: principal ? null : 'sin_grupo' as const };
        }),
        franjas: vi.fn(async () => op.franjas ?? FRANJAS),
        guardarLead: vi.fn(async () => 'lead-1'),
        marcarLead: vi.fn(async () => {}),
        tomarCupo: vi.fn(async () => op.cupo ?? { estado: 'separada' as const, hasta: '2026-10-30T23:45:00.000Z' }),
        soltarCupo: vi.fn(async () => {}),
        cuentasDePago: vi.fn(async () => op.cuentas ?? [
            { tipo: 'Nequi', numero: '319 450 5150', titular: null }, { tipo: 'Daviplata', numero: '3194505150', titular: null },
        ]),
        registrarConceptoEsperado: vi.fn(async () => {}),
        registrarOptIn: vi.fn(async () => {}),
        confirmarAgenda: vi.fn(async (p) => ({
            texto: p.evento === 'cambiada' ? 'Listo, cambié el horario 🙌' : 'La clase de prueba de *Mariana* quedó agendada 🎉',
            consentimientoPendiente: op.consentimientoPendiente ?? true,
        })),
        avisarEscuela: vi.fn(async () => {}),
        ...(op.yaSoyDelClub ? { yaSoyDelClub: vi.fn(async () => {}) } : {}),
        ...(op.lugar !== undefined ? { lugarDeLaClase: vi.fn(async () => op.lugar ?? null) } : {}),
        ...(op.ofertas ? { ofertas: vi.fn(async () => op.ofertas!) } : {}),
        ...(op.iniciarOfertas ? { iniciarOfertas: vi.fn(op.iniciarOfertas) } : {}),
        ...(op.pidioConvocatoria !== undefined ? { pidioConvocatoria: vi.fn(async () => op.pidioConvocatoria!) } : {}),
        leadDelContacto: vi.fn(async () => op.lead ?? null),
        leerEstado: async () => s.estado,
        ahora: () => AHORA,
    };
    const turno = (texto: string, boton: string | null = null) => atenderTurnoEmbudo(ctx, texto, boton);
    const ultimo = () => s.enviados[s.enviados.length - 1];
    return { ctx, s, turno, ultimo };
}

/** Recorre el embudo de Monster hasta la lista de horarios (Mariana, Norte). */
async function hastaHorarios(c: ReturnType<typeof crear>) {
    await iniciarEmbudo(c.ctx);
    await c.turno('🟡 Sede Norte', `${BOTON_EMBUDO.SEDE}${NORTE}`);
    await c.turno('Mariana Gómez Rojas');
    await c.turno('14/03/2011');
    await c.turno('Mujer', `${BOTON_EMBUDO.OPCION}sexo:0`);
    await c.turno('Punta');
    await c.turno('Club y torneos', `${BOTON_EMBUDO.OPCION}trayectoria:2`);
    await c.turno('Dos años en Club Titanes, jugó el Distrital 2025 y el Festival Nacional sub-15');
}

describe('bienvenida y sede', () => {
    it('Monster ve SU bienvenida con las dos sedes y «Ya soy del club» (id de la puerta)', async () => {
        const c = crear();
        expect(await iniciarEmbudo(c.ctx)).toBe(true);
        const m = c.ultimo();
        expect(m.texto).toContain('Bienvenid@ a Club Monsters Volley');
        expect(m.texto).toContain('🟡 Sede Norte · Calle 201 #67-12');
        expect(m.texto).toContain('⚫ Sede Suba · Calle 152 #94A-67');
        expect(m.botones!.map((b) => b.id)).toEqual([`${BOTON_EMBUDO.SEDE}${NORTE}`, `${BOTON_EMBUDO.SEDE}${SUBA}`, BOTON_PUERTA.CLUB]);
        expect(m.botones!.map((b) => b.title)).toEqual(['🟡 Sede Norte', '⚫ Sede Suba', 'Ya soy del club']);
        expect(m.estado).toEqual({ paso: 'sede', datos: {} });
        // La bienvenida es texto de la escuela: el bot no le recorta los emojis de sus sedes.
        expect(m.contexto).toEqual({ texto_de_la_escuela: true });
    });

    it('sin preguntas (Dynasty) el embudo no arranca ni atiende nada', async () => {
        const c = crear({ aj: ajustesDesdeFila({ wa_modo_cortesia: 'clase' }) });
        expect(await iniciarEmbudo(c.ctx)).toBe(false);
        expect(await c.turno('Hola, quiero información')).toBe(false);
        expect(await c.turno('x', `${BOTON_EMBUDO.SEDE}${NORTE}`)).toBe(false);
        expect(c.s.enviados).toHaveLength(0);
    });

    it('sede por botón → primera pregunta con el número', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        expect(await c.turno('🟡 Sede Norte', `${BOTON_EMBUDO.SEDE}${NORTE}`)).toBe(true);
        expect(c.ultimo().texto).toBe('¡Genial, 🟡 Sede Norte! 🙌\nPara ubicarte en la categoría correcta te hago 5 preguntas rápidas 🙌\n\n' +
            '1️⃣ ¿Cuál es el nombre completo del deportista?');
        expect(c.ultimo().estado).toMatchObject({ paso: 'pregunta', datos: { branchId: NORTE, i: 0 } });
    });

    it.each([
        ['Suba', SUBA], ['la del norte', NORTE], ['calle 152', SUBA], ['Me queda mejor la de Suba', SUBA], ['cll 201', NORTE],
    ])('sede por texto: «%s»', async (t, esperado) => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        expect(await c.turno(t)).toBe(true);
        expect(c.ultimo().estado?.datos.branchId).toBe(esperado);
    });

    it('«Ya soy del club» tocado lo deja a la puerta; escrito, va a la puerta por el contexto', async () => {
        const c = crear({ yaSoyDelClub: true });
        await iniciarEmbudo(c.ctx);
        expect(await c.turno('Ya soy del club', BOTON_PUERTA.CLUB)).toBe(false);
        expect(await c.turno('ya soy del club')).toBe(true);
        expect(c.ctx.yaSoyDelClub).toHaveBeenCalledTimes(1);
    });

    it('pedir una persona por escrito = el botón «Hablar con alguien» (el bot general calla con un desconocido)', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        expect(await c.turno('quiero hablar con un asesor')).toBe(true);
        expect(c.ultimo().step).toBe('embudo_a_persona');
        expect(c.ultimo().texto).toBe('Listo, ya pasé tus datos a la escuela y alguien te responde por aquí 🙌');
        expect(c.ctx.avisarEscuela).toHaveBeenCalledWith('pide_persona', null);
    });
});

describe('preguntas', () => {
    it('en orden, con «¡Mucho gusto!», botones de sexo y lista de posición', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        await c.turno('🟡 Sede Norte', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Mariana Gómez Rojas');
        expect(c.ultimo().texto).toBe('¡Mucho gusto, Mariana! 😊\n\n2️⃣ ¿Cuál es su fecha de nacimiento? (día/mes/año)');
        await c.turno('14/03/2011');
        expect(c.ultimo().texto).toBe('3️⃣ ¿Es hombre o mujer?');
        expect(c.ultimo().botones!.map((b) => b.title)).toEqual(['Mujer', 'Hombre']);
        await c.turno('Mujer', `${BOTON_EMBUDO.OPCION}sexo:0`);
        expect(c.ultimo().texto).toBe('4️⃣ ¿En qué posición juega?');
        expect(c.ultimo().botones).toHaveLength(6);
        expect(c.ultimo().botones!.every((b) => b.seccion === 'Elegir posición')).toBe(true);
        await c.turno('Punta');
        expect(c.ultimo().texto).toBe('5️⃣ ¿Cuál es su trayectoria en el voleibol?');
        expect(c.ultimo().estado?.datos).toMatchObject({
            nombre: 'Mariana Gómez Rojas', fechaNacimiento: '2011-03-14', anio: 2011, genero: 'f',
            respuestas: { nombre: 'Mariana Gómez Rojas', fecha_nacimiento: '2011-03-14', sexo: 'Mujer', posicion: 'Punta' },
        });
    });

    // Monster 2026-11-09: «Valeria Pardo Rojas y Camila Pardo Rojas» → «no alcancé a leer el nombre»,
    // y la segunda, escrita aparte, recibía «necesito la fecha». Ahora se sigue con la primera y la otra se anota.
    it('dos deportistas en un mensaje: sigue con la primera, avisa y anota a la otra', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        await c.turno('x', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Valeria Pardo Rojas y Camila Pardo Rojas');
        const texto = c.ultimo().texto;
        expect(texto).toContain('¡Mucho gusto, Valeria! 😊');
        expect(texto).toContain('Camila Pardo Rojas');
        expect(texto).toContain('2️⃣ ¿Cuál es su fecha de nacimiento?');
        expect(c.ultimo().estado?.datos).toMatchObject({
            nombre: 'Valeria Pardo Rojas',
            respuestas: { nombre: 'Valeria Pardo Rojas', otros_deportistas: 'Camila Pardo Rojas' },
        });
    });

    it('el segundo nombre escrito aparte, pidiendo la fecha: se anota y se sigue con el primero (sin gastar un intento)', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        await c.turno('x', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Valeria Pardo Rojas');
        await c.turno('Camila Pardo Rojas');
        const u = c.ultimo();
        expect(u.texto).toContain('Anoté a *Camila Pardo Rojas* para después');
        expect(u.texto).toContain('Valeria Pardo Rojas');
        expect(u.texto).toContain('fecha de nacimiento');
        expect(u.estado?.datos.respuestas?.otros_deportistas).toBe('Camila Pardo Rojas');
        expect(u.estado?.datos.intentos ?? 0).toBe(0);
        // La fecha de la primera sigue funcionando.
        await c.turno('18/06/2012');
        expect(c.ultimo().texto).toBe('3️⃣ ¿Es hombre o mujer?');
        expect(c.ultimo().estado?.datos.respuestas?.otros_deportistas).toBe('Camila Pardo Rojas');
    });

    it('en la pregunta de la fecha, un texto que no es un nombre completo sigue pidiendo la fecha', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        await c.turno('x', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Valeria Pardo Rojas');
        await c.turno('Camila');
        expect(c.ultimo().texto).toContain('Necesito la *fecha de nacimiento*');
        expect(c.ultimo().estado?.datos.respuestas?.otros_deportistas).toBeUndefined();
    });

    it('«Mariana, 14/03/2011, punta» llena tres de una vez y pregunta lo que falta', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        await c.turno('x', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Mariana, 14/03/2011, punta');
        expect(c.ultimo().texto).toBe('¡Mucho gusto, Mariana! 😊\n\n3️⃣ ¿Es hombre o mujer?');
        expect(c.ultimo().estado?.datos.respuestas).toEqual({ nombre: 'Mariana', fecha_nacimiento: '2011-03-14', posicion: 'Punta' });
        await c.turno('mujer');
        // Posición ya estaba: salta a la trayectoria.
        expect(c.ultimo().texto).toBe('5️⃣ ¿Cuál es su trayectoria en el voleibol?');
    });

    it('solo el año alcanza', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        await c.turno('x', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Sofía Pérez');
        await c.turno('nació en el 2012');
        expect(c.ultimo().estado?.datos).toMatchObject({ anio: 2012, fechaNacimiento: null, respuestas: { fecha_nacimiento: '2012' } });
    });

    it('el detalle solo sale con «Club y torneos»', async () => {
        const c = crear();
        await hastaHorarios(c);
        const textos = c.s.enviados.map((e) => e.texto);
        expect(textos).toContain('¡Qué bien! 🏆 Cuéntame en un mensaje en qué clubes ha entrenado y qué torneos ha jugado.');
        expect(c.ctx.guardarLead).toHaveBeenCalledWith(expect.objectContaining({
            deportista: 'Mariana Gómez Rojas', anio: 2011, genero: 'f', branchId: NORTE, teamId: 't-infantil-fem',
            respuestas: {
                posicion: 'Punta', trayectoria: 'Club y torneos',
                trayectoria_detalle: 'Dos años en Club Titanes, jugó el Distrital 2025 y el Festival Nacional sub-15',
            },
        }));

        const d = crear();
        await iniciarEmbudo(d.ctx);
        await d.turno('x', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await d.turno('Sofía, 2011, mujer, líbero');
        await d.turno('Estoy empezando', `${BOTON_EMBUDO.OPCION}trayectoria:0`);
        expect(d.s.enviados.map((e) => e.texto).join('\n')).not.toContain('clubes ha entrenado');
        expect(d.ultimo().step).toBe('embudo_horarios');
    });

    it('dos fallos → una persona con lo que haya', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        await c.turno('x', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Mariana Gómez');
        await c.turno('no sé');
        expect(c.ultimo().texto).toContain('*fecha de nacimiento*');
        expect(c.ultimo().estado?.datos.intentos).toBe(1);
        await c.turno('tiene 15 años');
        expect(c.ultimo().estado).toBeNull();
        expect(c.ultimo().step).toBe('embudo_a_persona');
        expect(c.ctx.avisarEscuela).toHaveBeenCalledWith('no_entendio', expect.stringContaining('Mariana Gómez'));
        expect(c.ctx.guardarLead).toHaveBeenCalledWith(expect.objectContaining({ deportista: 'Mariana Gómez', teamId: null }));
    });

    it('una pregunta de otro tema a mitad no gasta intento: la contesta el bot', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        await c.turno('x', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Mariana Gómez');
        expect(await c.turno('¿y cuánto vale la mensualidad?')).toBe(false);
    });
});

describe('grupo y horarios', () => {
    it('grupo, valor y solo los horarios de sábado y domingo con cupo', async () => {
        const c = crear();
        await hastaHorarios(c);
        const m = c.ultimo();
        expect(m.texto).toBe(
            '¡Listo! ✨ Por su año (2011) a Mariana le corresponde *Infantil Femenino* en la Sede Norte. Su profe es Iván Sossa.\n' +
            'Para empezar en el club se agenda una clase de prueba, que cuesta $15.000. En ella el entrenador la evalúa y confirma su grupo y nivel.\n\n' +
            'Estos son los próximos horarios 👇');
        expect(c.ctx.elegirGrupo).toHaveBeenCalledWith({ branchId: NORTE, anio: 2011, genero: 'f' });
        expect(m.botones!.map((b) => b.id)).toEqual([`${BOTON_EMBUDO.FRANJA}s-sab31`, `${BOTON_EMBUDO.FRANJA}s-dom01`, `${BOTON_EMBUDO.FRANJA}s-sab07`]);
        expect(m.botones![0]).toEqual({
            id: `${BOTON_EMBUDO.FRANJA}s-sab31`, title: 'Sáb 31 oct · 8:00–10:00',
            descripcion: 'La Enseñanza · Profe Iván · 5 cupos', seccion: 'Infantil Femenino',
        });
        // Sin tope (999): sin cifra.
        expect(m.botones![1].descripcion).toBe('La Enseñanza · Profe Iván');
        expect(m.estado).toMatchObject({ paso: 'elegir_franja', datos: { leadId: 'lead-1', teamId: 't-infantil-fem', lista: ['s-sab31', 's-dom01', 's-sab07'] } });
    });

    it('sin grupo en su sede → botón para ver la otra sede que sí tiene', async () => {
        const c = crear({ grupos: { [NORTE]: null, [SUBA]: { teamId: 't-u15', nombre: 'U15 Fem Proyección', branchId: SUBA, coachNombres: ['Sebastián Hurtado'] } } });
        await hastaHorarios(c);
        const m = c.ultimo();
        expect(m.texto).toBe('En la Sede Norte no tengo un grupo para Mariana (2011). En la Sede Suba sí 👇');
        expect(m.botones!.map((b) => b.id)).toEqual([`${BOTON_EMBUDO.OTRA_SEDE}${SUBA}`, BOTON_EMBUDO.PERSONA]);
        expect(m.botones![0].title).toBe('Ver Sede Suba');
        await c.turno('Ver Sede Suba', `${BOTON_EMBUDO.OTRA_SEDE}${SUBA}`);
        expect(c.ultimo().texto).toContain('le corresponde *U15 Fem Proyección* en la Sede Suba. Su profe es Sebastián Hurtado');
        expect(c.ultimo().estado?.datos.branchId).toBe(SUBA);
    });

    it('sin grupo en ninguna sede → una persona, nunca se inventa', async () => {
        const c = crear({ grupos: { [NORTE]: null, [SUBA]: null } });
        await hastaHorarios(c);
        expect(c.ultimo().estado).toBeNull();
        expect(c.ultimo().texto).toContain('No encontré un grupo para Mariana (2011) en la Sede Norte');
        expect(c.ctx.avisarEscuela).toHaveBeenCalledWith('sin_grupo', expect.any(String));
    });

    it('un horario que se llenó vuelve a la lista', async () => {
        const c = crear({ cupo: { estado: 'lleno', hasta: null } });
        await hastaHorarios(c);
        await c.turno('x', `${BOTON_EMBUDO.FRANJA}s-sab31`);
        expect(c.ultimo().texto).toContain('se acaba de llenar');
        expect(c.ultimo().estado?.paso).toBe('elegir_franja');
    });

    it('«la 2» elige la segunda de la lista', async () => {
        const c = crear();
        await hastaHorarios(c);
        await c.turno('la 2');
        expect(c.ctx.tomarCupo).toHaveBeenCalledWith('lead-1', 's-dom01', { pagada: false });
    });
});

describe('cupo con valor: consentimiento primero, después las cuentas', () => {
    it('separa, deja el motivo esperado, pregunta el consentimiento y da las cuentas', async () => {
        const c = crear();
        await hastaHorarios(c);
        await c.turno('Sáb 31 oct · 8:00–10:00', `${BOTON_EMBUDO.FRANJA}s-sab31`);
        expect(c.ctx.registrarConceptoEsperado).toHaveBeenCalledWith({
            motivo: 'clase_prueba', monto: 15000, leadId: 'lead-1', venceEn: '2026-10-30T23:45:00.000Z',
        });
        const consentimiento = c.ultimo();
        expect(consentimiento.texto).toBe('¡Perfecto! Te separo el cupo del sábado 31 de octubre a las 8:00 a. m. durante 24 horas ⏳\n\n' +
            '¿Te puedo escribir por aquí el recordatorio de la clase y las novedades del club? Enseguida te paso los datos de pago.');
        expect(consentimiento.botones).toEqual([
            { id: BOTON_EMBUDO.OPTIN_SI, title: 'Sí, claro' }, { id: BOTON_EMBUDO.OPTIN_NO, title: 'No, gracias' },
        ]);
        await c.turno('Sí, claro', BOTON_EMBUDO.OPTIN_SI);
        expect(c.ctx.registrarOptIn).toHaveBeenCalledTimes(1);
        expect(c.ctx.marcarLead).toHaveBeenCalledWith('lead-1', expect.objectContaining({ consentimiento: 'si' }));
        expect(c.ultimo().texto).toBe('¡Listo! 🙌 Para confirmarlo, paga la clase de prueba ($15.000) por Nequi o Daviplata al 319 450 5150 ' +
            'y envíame aquí mismo la foto o el PDF del comprobante 📸');
        expect(c.ultimo().estado).toMatchObject({ paso: 'esperando_pago', datos: { slotId: 's-sab31', consentimiento: 'si' } });
    });

    it('«No, gracias» no registra el consentimiento y da las cuentas igual', async () => {
        const c = crear();
        await hastaHorarios(c);
        await c.turno('x', `${BOTON_EMBUDO.FRANJA}s-sab31`);
        await c.turno('no gracias');
        expect(c.ctx.registrarOptIn).not.toHaveBeenCalled();
        expect(c.ultimo().texto).toMatch(/^Entendido\. Para confirmarlo, paga la clase de prueba/);
    });

    it('sin cuentas de pago → se suelta el cupo y pasa a una persona', async () => {
        const c = crear({ cuentas: [] });
        await hastaHorarios(c);
        await c.turno('x', `${BOTON_EMBUDO.FRANJA}s-sab31`);
        expect(c.ctx.soltarCupo).toHaveBeenCalledWith('lead-1');
        expect(c.ctx.registrarConceptoEsperado).not.toHaveBeenCalled();
        expect(c.ultimo().estado).toBeNull();
        expect(c.ctx.avisarEscuela).toHaveBeenCalledWith('sin_cuentas_de_pago', expect.any(String));
    });

    it('ningún saliente de Monster dice «gratis» ni «cortesía»; botones ≤ 20, filas ≤ 24', async () => {
        const c = crear();
        await hastaHorarios(c);
        await c.turno('x', `${BOTON_EMBUDO.FRANJA}s-sab31`);
        await c.turno('Sí, claro', BOTON_EMBUDO.OPTIN_SI);
        for (const e of c.s.enviados) {
            expect(`${e.texto}\n${e.enTexto ?? ''}\n${(e.botones ?? []).map((b) => `${b.title} ${b.descripcion ?? ''}`).join('\n')}`)
                .not.toMatch(/gratis|cortes[ií]a/i);
            for (const b of e.botones ?? []) {
                const lista = (e.botones ?? []).length > 3 || (e.botones ?? []).some((x) => x.seccion);
                expect(Array.from(b.title).length).toBeLessThanOrEqual(lista ? 24 : 20);
                if (b.descripcion) expect(Array.from(b.descripcion).length).toBeLessThanOrEqual(72);
            }
        }
    });
});

describe('cupo sin valor o ya pagado', () => {
    it('gratis → agendada + consentimiento (sin cobro ni motivo esperado)', async () => {
        const c = crear({ clase: ajustesClasePruebaDesdeFila({ nombre_clase: null, trial_price: null }), cupo: { estado: 'agendada', hasta: null } });
        await hastaHorarios(c);
        expect(c.s.enviados.find((e) => e.step === 'embudo_horarios')!.texto).toContain('se agenda una clase de cortesía, sin costo.');
        await c.turno('x', `${BOTON_EMBUDO.FRANJA}s-sab31`);
        expect(c.ctx.confirmarAgenda).toHaveBeenCalledWith({ leadId: 'lead-1', slotId: 's-sab31', evento: 'agendada' });
        expect(c.ctx.registrarConceptoEsperado).not.toHaveBeenCalled();
        const [confirmacion, pregunta] = c.s.enviados.slice(-2);
        expect(confirmacion.texto).toContain('quedó agendada');
        expect(confirmacion.estado?.paso).toBe('agendada');
        expect(pregunta.estado).toMatchObject({ paso: 'consentimiento', datos: { siguiente: 'fin' } });
        await c.turno('si');
        expect(c.ctx.registrarOptIn).toHaveBeenCalledTimes(1);
        expect(c.ultimo().texto).toBe('¡Listo! 🙌 Te escribo antes de la clase para recordártela.');
    });

    it('«Cambiar horario» de la plantilla: otra lista sin la franja actual y agenda sin volver a cobrar', async () => {
        const c = crear({
            cupo: { estado: 'agendada', hasta: null }, consentimientoPendiente: false,
            // `pagada`: la confirmó B4 (el saliente de la confirmación trae el estado del embudo).
            estado: { paso: 'agendada', datos: { leadId: 'lead-1', teamId: 't-infantil-fem', slotId: 's-sab31', pagada: true } },
        });
        expect(await c.turno('Cambiar horario', 'Cambiar horario')).toBe(true);
        expect(c.ultimo().texto).toContain('No tienes que pagar de nuevo');
        expect(c.ctx.tomarCupo).not.toHaveBeenCalled();
        expect(c.ultimo().botones!.map((b) => b.id)).not.toContain(`${BOTON_EMBUDO.FRANJA}s-sab31`);
        await c.turno('x', `${BOTON_EMBUDO.FRANJA}s-dom01`);
        // La simulación agenda sin cobrar porque ya pagó (`cupoSimulado` con `pagada`).
        expect(c.ctx.tomarCupo).toHaveBeenCalledWith('lead-1', 's-dom01', { pagada: true });
        expect(c.ctx.confirmarAgenda).toHaveBeenCalledWith({ leadId: 'lead-1', slotId: 's-dom01', evento: 'cambiada' });
        expect(c.ctx.registrarConceptoEsperado).not.toHaveBeenCalled();
        expect(c.ultimo().estado?.paso).toBe('agendada');
        expect(c.ultimo().estado?.datos.pagada).toBe(true);
    });

    it('«Elegir otro horario» (clase reprogramada) sin estado: recupera el lead por teléfono', async () => {
        const c = crear({
            cupo: { estado: 'agendada', hasta: null }, consentimientoPendiente: false,
            lead: { leadId: 'lead-9', nombre: 'Sofía', teamId: 't-infantil-fem', branchId: NORTE, slotId: 's-sab31', separadoSlotId: null, consentimiento: 'si' },
        });
        expect(await c.turno('Elegir otro horario', 'Elegir otro horario')).toBe(true);
        expect(c.ultimo().estado).toMatchObject({ paso: 'elegir_franja', datos: { leadId: 'lead-9', cambio: true } });
    });

    it('el consentimiento que manda B4 en la confirmación vale sin estado', async () => {
        const c = crear({ lead: { leadId: 'lead-9', nombre: 'Sofía', teamId: 't', branchId: null, slotId: 's-sab31', separadoSlotId: null } });
        expect(await c.turno('Sí, claro', BOTON_EMBUDO.OPTIN_SI)).toBe(true);
        expect(c.ctx.registrarOptIn).toHaveBeenCalledTimes(1);
        expect(c.ctx.marcarLead).toHaveBeenCalledWith('lead-9', expect.objectContaining({ consentimiento: 'si' }));
    });
});

/** Hasta «paga la clase de prueba… envíame el comprobante» (esperando_pago). */
async function hastaElPago(c: ReturnType<typeof crear>) {
    await hastaHorarios(c);
    await c.turno('x', `${BOTON_EMBUDO.FRANJA}s-sab31`);
    await c.turno('Sí, claro', BOTON_EMBUDO.OPTIN_SI);
    expect(c.ultimo().estado?.paso).toBe('esperando_pago');
}

const MATRICULA_MARIANA = 'La matrícula se hace después de la clase de prueba: el profe evalúa a Mariana, ' +
    'la escuela te confirma el grupo y te escribe por aquí para matricularla 🙌';

describe('después del embudo: matrícula y «¿dónde queda?» (Monster 2026-11-03)', () => {
    it('esperando el pago, «¿y para matricularla?» se contesta, la escuela recibe el aviso y el flujo sigue en el pago', async () => {
        const c = crear();
        await hastaElPago(c);
        expect(await c.turno('Y para matricularla después de la clase qué tengo que hacer?')).toBe(true);
        expect(c.ultimo().texto).toBe(MATRICULA_MARIANA);
        expect(c.ultimo().step).toBe('embudo_matricula');
        expect(c.ultimo().estado).toMatchObject({ paso: 'esperando_pago', datos: { slotId: 's-sab31', matriculaAvisada: true } });
        expect(c.ctx.avisarEscuela).toHaveBeenCalledTimes(1);
        const [motivo, detalle] = (c.ctx.avisarEscuela as any).mock.calls[0];
        expect(motivo).toBe('pide_matricula');
        expect(detalle).toBe('Pide la matrícula: «Y para matricularla después de la clase qué tengo que hacer?». ' +
            'Deportista: Mariana Gómez Rojas (2011). Grupo: Infantil Femenino. Sede: Sede Norte. Clase de prueba: cupo separado, falta el pago.');
        // Otra vez en el mismo flujo: se contesta, sin repetir el aviso.
        expect(await c.turno('quiero matricularla en el club')).toBe(true);
        expect(c.ultimo().texto).toBe(MATRICULA_MARIANA);
        expect(c.ctx.avisarEscuela).toHaveBeenCalledTimes(1);
        // El «cambiar horario» escrito sigue funcionando después; todavía no pagó: sin «no tienes que pagar».
        expect(await c.turno('necesito cambiar el horario')).toBe(true);
        expect(c.ultimo().texto).toMatch(/^Claro 🙌 Elige el nuevo horario\./);
        expect(c.ultimo().texto).not.toContain('pagar de nuevo');
    });

    it('con el estado que deja un job (sin nombre): el nombre sale del lead y el género del verbo', async () => {
        const c = crear({
            estado: { paso: 'agendada', datos: { leadId: 'lead-9', teamId: 't-infantil-fem', slotId: 's-sab31' } },
            lead: { leadId: 'lead-9', nombre: 'Tomás Herrera', teamId: 't-infantil-fem', branchId: NORTE, slotId: 's-sab31', separadoSlotId: null },
        });
        expect(await c.turno('¿Cómo hago para matricularlo?')).toBe(true);
        expect(c.ultimo().texto).toBe('La matrícula se hace después de la clase de prueba: el profe evalúa a Tomás, ' +
            'la escuela te confirma el grupo y te escribe por aquí para matricularlo 🙌');
        expect(c.ultimo().estado).toMatchObject({ paso: 'agendada', datos: { leadId: 'lead-9', nombre: 'Tomás Herrera' } });
        expect(c.ctx.avisarEscuela).toHaveBeenCalledWith('pide_matricula', expect.stringContaining('Clase de prueba: agendada.'));
    });

    it('en el consentimiento: contesta y vuelve a preguntar con los mismos botones', async () => {
        const c = crear();
        await hastaHorarios(c);
        await c.turno('x', `${BOTON_EMBUDO.FRANJA}s-sab31`);
        expect(await c.turno('y la matrícula cómo es?')).toBe(true);
        expect(c.ultimo().texto).toBe(`${MATRICULA_MARIANA}\n\n¿Te puedo escribir por aquí el recordatorio de la clase y las novedades del club?`);
        expect(c.ultimo().botones!.map((b) => b.id)).toEqual([BOTON_EMBUDO.OPTIN_SI, BOTON_EMBUDO.OPTIN_NO]);
        expect(c.ultimo().estado).toMatchObject({ paso: 'consentimiento', datos: { siguiente: 'pago' } });
        await c.turno('Sí, claro', BOTON_EMBUDO.OPTIN_SI);
        expect(c.ultimo().texto).toMatch(/^¡Listo! 🙌 Para confirmarlo, paga la clase de prueba/);
    });

    it('en medio del registro: contesta y repite la pregunta que tocaba', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        await c.turno('x', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Mariana Gómez');
        expect(await c.turno('¿Y la inscripción cómo es?')).toBe(true);
        expect(c.ultimo().texto).toBe('La matrícula se hace después de la clase de prueba: el profe evalúa a Mariana, ' +
            'la escuela te confirma el grupo y te escribe por aquí para hacer la matrícula 🙌\n\n' +
            '2️⃣ ¿Cuál es su fecha de nacimiento? (día/mes/año)');
        expect(c.ultimo().estado).toMatchObject({ paso: 'pregunta', datos: { i: 1 } });
        expect(c.ultimo().estado?.datos.intentos ?? 0).toBe(0);
        await c.turno('14/03/2011');
        expect(c.ultimo().texto).toContain('¿Es hombre o mujer?');
    });

    it('el precio de la matrícula o cualquier otra pregunta siguen siendo del bot general', async () => {
        const c = crear();
        await hastaElPago(c);
        const antes = c.s.enviados.length;
        expect(await c.turno('¿cuánto vale la matrícula?')).toBe(false);
        expect(await c.turno('qué debo llevar a la clase?')).toBe(false);
        expect(await c.turno('ya te mandé el comprobante')).toBe(false);
        expect(c.s.enviados.length).toBe(antes);
        expect(c.ctx.avisarEscuela).not.toHaveBeenCalled();
    });

    it('«¿dónde queda?» con la clase elegida: la cancha de esa franja; sin el dato, el bot general', async () => {
        const lugar: LugarDeClase = {
            fecha: '2026-10-31', horaInicio: '08:00', lugar: 'Colegio La Enseñanza', direccion: 'Av. El Polo, Cl. 201 #67-12',
            mapsUrl: 'https://maps.app.goo.gl/xyz', indicaciones: null,
        };
        const c = crear({ lugar });
        await hastaElPago(c);
        expect(await c.turno('dónde queda?')).toBe(true);
        expect(c.ultimo().texto).toBe('La clase de prueba de *Mariana* es el sábado 31 de octubre a las 8:00 a. m. en:\n' +
            '📍 Colegio La Enseñanza · Av. El Polo, Cl. 201 #67-12\nCómo llegar: https://maps.app.goo.gl/xyz');
        expect(c.ctx.lugarDeLaClase).toHaveBeenCalledWith('s-sab31');
        expect(c.ultimo().estado?.paso).toBe('esperando_pago');

        const sinDato = crear({ lugar: { ...lugar, lugar: null, direccion: null } });
        await hastaElPago(sinDato);
        expect(await sinDato.turno('cuál es la dirección?')).toBe(false);
        const sinContexto = crear();
        await hastaElPago(sinContexto);
        expect(await sinContexto.turno('dónde queda?')).toBe(false);
    });

    it('lecturas: pideMatricula, preguntaDonde y los textos', () => {
        for (const t of ['Y para matricularla después de la clase qué tengo que hacer?', 'quiero matricularla en el club',
            '¿Cómo es el proceso de inscripción?', 'queremos inscribirlo', 'qué hay que hacer para la matrícula']) {
            expect(pideMatricula(t)).toBe(true);
        }
        for (const t of ['¿cuánto vale la matrícula?', 'Estuvo matriculada en el club Titanes dos años', 'la matrícula',
            'Mariana Gómez', 'qué debo llevar?']) {
            expect(pideMatricula(t)).toBe(false);
        }
        expect(preguntaDonde('Dónde queda?')).toBe(true);
        expect(preguntaDonde('me pasas la dirección')).toBe(true);
        expect(preguntaDonde('cómo llego?')).toBe(true);
        expect(preguntaDonde('qué debo llevar')).toBe(false);
        // Escuela con clase de cortesía, sin nombre ni género: nunca inventa.
        expect(textoDeMatricula({ nombre: 'clase de cortesía' }, null, null)).toBe(
            'La matrícula se hace después de la clase de cortesía: el profe evalúa a tu deportista, ' +
            'la escuela te confirma el grupo y te escribe por aquí para hacer la matrícula 🙌');
        expect(detalleDeMatricula('elegir_franja', {}, 'quiero matricularlo'))
            .toBe('Pide la matrícula: «quiero matricularlo». Clase de prueba: todavía sin agendar (está en el registro).');
        expect(textoDonde({ fecha: '2026-10-31', horaInicio: '08:00', lugar: null, direccion: null, mapsUrl: 'x', indicaciones: null },
            { nombre: 'clase de prueba' }, 'Mariana')).toBeNull();
    });

    it('sin flujo abierto (vencido o tras otro saliente): «cambiar el horario», la matrícula y «¿dónde queda?» van con el lead', async () => {
        const lead = { leadId: 'lead-9', nombre: 'Sofía Rojas', teamId: 't-infantil-fem', branchId: NORTE, slotId: 's-sab31', separadoSlotId: null };
        const lugar: LugarDeClase = {
            fecha: '2026-10-31', horaInicio: '08:00', lugar: 'Colegio La Enseñanza', direccion: 'Calle 201 #67-12', mapsUrl: null, indicaciones: null,
        };
        const c = crear({ lead, lugar, cupo: { estado: 'agendada', hasta: null } });
        // Las franjas del MISMO grupo, sin la que ya tiene (antes: las de cortesía de todos los grupos).
        expect(await c.turno('Necesito cambiar el horario de la clase')).toBe(true);
        expect(c.ctx.franjas).toHaveBeenCalledWith('t-infantil-fem');
        expect(c.ultimo().botones!.map((b) => b.id)).not.toContain(`${BOTON_EMBUDO.FRANJA}s-sab31`);
        expect(c.ultimo().estado).toMatchObject({ paso: 'elegir_franja', datos: { leadId: 'lead-9', cambio: true } });
        expect(c.ultimo().texto).not.toContain('pagar de nuevo');
        // Con la clase pagada (B4 dejó `agendado_por: 'pago'` en el lead): sin volver a cobrar.
        const p = crear({ lead: { ...lead, pagada: true }, cupo: { estado: 'agendada', hasta: null } });
        expect(await p.turno('no puedo ir el sábado')).toBe(true);
        expect(p.ultimo().texto).toContain('No tienes que pagar de nuevo');
        await p.turno('x', `${BOTON_EMBUDO.FRANJA}s-dom01`);
        expect(p.ctx.tomarCupo).toHaveBeenCalledWith('lead-9', 's-dom01', { pagada: true });

        const m = crear({ lead });
        expect(await m.turno('quiero matricularla')).toBe(true);
        expect(m.ultimo().texto).toContain('el profe evalúa a Sofía');
        expect(m.ultimo().estado).toMatchObject({ paso: 'agendada', datos: { leadId: 'lead-9', slotId: 's-sab31' } });

        const d = crear({ lead, lugar });
        expect(await d.turno('dónde queda?')).toBe(true);
        expect(d.ultimo().texto).toContain('📍 Colegio La Enseñanza · Calle 201 #67-12');

        // Cualquier otra cosa sigue siendo del bot general; sin lead, nada.
        expect(await crear({ lead }).turno('qué debo llevar?')).toBe(false);
        expect(await crear().turno('quiero cambiar el horario')).toBe(false);
    });

    it('Dynasty (sin embudo): un «quiero cambiar el horario» sin flujo no lo toca el embudo (ni lee el lead)', async () => {
        const c = crear({ aj: ajustesDesdeFila({ wa_modo_cortesia: 'clase' }), lead: { leadId: 'l', nombre: 'X', teamId: 't', branchId: null, slotId: 's', separadoSlotId: null } });
        expect(await c.turno('quiero cambiar el horario')).toBe(false);
        expect(c.ctx.leadDelContacto).not.toHaveBeenCalled();
        expect(c.s.enviados).toHaveLength(0);
    });

    it('pideCambioDeHorario: con artículo, «no puedo ir» y reprogramar; no cualquier «otra clase»', () => {
        for (const t of ['quiero cambiar de horario', 'necesito cambiar el horario', 'Hola, ¿puedo cambiar la fecha?', 'cambio de día por favor',
            'mejor otro día', 'no puedo ir el sábado', 'Buenas, ya no vamos a poder ir', 'hay que reprogramarla', 'cambiar mi horario']) {
            expect(pideCambioDeHorario(t)).toBe(true);
        }
        for (const t of ['¿qué horarios tienen?', 'puedo ir con la hermana?', 'quiero otra clase de prueba', 'gracias']) {
            expect(pideCambioDeHorario(t)).toBe(false);
        }
    });

    it('en la pregunta del nombre, «cuanto vale la mensualidad» no es un nombre: la contesta el bot y el paso queda', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        await c.turno('x', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        const antes = c.s.enviados.length;
        expect(await c.turno('cuanto vale la mensualidad')).toBe(false);
        expect(c.s.enviados).toHaveLength(antes);
        expect(c.s.estado).toMatchObject({ paso: 'pregunta', datos: { i: 0, intentos: 0 } });
        await c.turno('Mariana Gómez');
        expect(c.ultimo().texto).toContain('¡Mucho gusto, Mariana!');
        // En la de la fecha tampoco gasta un intento.
        expect(await c.turno('donde queda la sede')).toBe(false);
        expect(c.s.estado?.datos.intentos ?? 0).toBe(0);
    });

    it('eligiendo horario, «cuanto vale la mensualidad» (sin «?») es otra conversación: no gasta intento', async () => {
        const c = crear();
        await hastaHorarios(c);
        const antes = c.s.enviados.length;
        expect(await c.turno('cuanto vale la mensualidad')).toBe(false);
        expect(c.s.enviados).toHaveLength(antes);
        expect(c.s.estado).toMatchObject({ paso: 'elegir_franja', datos: { intentos: 0 } });
        expect(await c.turno('la 2')).toBe(true);
        expect(c.ctx.tomarCupo).toHaveBeenCalledWith('lead-1', 's-dom01', { pagada: false });
    });

    it('una sola sede en los botones: queda fijada y se va directo a las preguntas («Ya soy del club» se conserva)', async () => {
        const aj = ajustesDesdeFila({
            wa_modo_cortesia: 'clase', wa_bienvenida: '¡Hola! 👋 Bienvenid@ a Club Monsters Volley 🏐⚡',
            wa_botones_sede: [{ branch_id: NORTE, titulo: '🟡 Sede Norte' }],
            wa_preguntas_prospecto: PREGUNTAS_MONSTER, wa_modo_discreto: 'no', wa_temas_a_persona: null,
        });
        const c = crear({ aj });
        expect(await iniciarEmbudo(c.ctx)).toBe(true);
        expect(c.ultimo().texto).toBe('¡Hola! 👋 Bienvenid@ a Club Monsters Volley 🏐⚡\n\n🟡 Sede Norte · Calle 201 #67-12\n\n' +
            'Para ubicarte en la categoría correcta te hago 5 preguntas rápidas 🙌\n\n1️⃣ ¿Cuál es el nombre completo del deportista?');
        expect(c.ultimo().botones!.map((b) => b.id)).toEqual([BOTON_PUERTA.CLUB]);
        expect(c.ultimo().estado).toEqual({ paso: 'pregunta', datos: { i: 0, respuestas: {}, branchId: NORTE, sedeTitulo: '🟡 Sede Norte' } });
        await c.turno('Mariana Gómez Rojas');
        await c.turno('14/03/2011');
        await c.turno('Mujer', `${BOTON_EMBUDO.OPCION}sexo:0`);
        await c.turno('Punta');
        await c.turno('Estoy empezando', `${BOTON_EMBUDO.OPCION}trayectoria:0`);
        expect(c.ctx.elegirGrupo).toHaveBeenCalledWith({ branchId: NORTE, anio: 2011, genero: 'f' });
        expect(c.ultimo().texto).toContain('en la Sede Norte');
    });

    it('estadoDeSalientes: una respuesta suelta del bot no cierra el flujo; otro flujo, un cierre o una persona sí', () => {
        const embudo = { payload: { step: 'embudo_esperando_pago', flujo: 'embudo', paso_embudo: 'esperando_pago', datos_embudo: { slotId: 's-1' } } };
        const suelta = (step: string) => ({ payload: { step } });
        expect(estadoDeSalientes([suelta('prospecto_ia'), suelta('prospecto_seguimiento_info'), embudo]))
            .toEqual({ paso: 'esperando_pago', datos: { slotId: 's-1' } });
        expect(estadoDeSalientes([suelta('embudo_pregunta_a_la_escuela'), embudo])).toBeNull();
        expect(estadoDeSalientes([{ payload: { step: 'x', flujo: 'clase_cortesia' } }, embudo])).toBeNull();
        expect(estadoDeSalientes([suelta('embudo_a_persona'), embudo])).toBeNull();
        expect(estadoDeSalientes([suelta('escalated'), embudo])).toBeNull();
        expect(estadoDeSalientes([{ payload: null, humano: true }, embudo])).toBeNull();
        // La respuesta de la cola a un comprobante sin estado (el «esperando el pago» ya no vale)…
        expect(estadoDeSalientes([suelta('clase_prueba_agendada'), embudo])).toBeNull();
        expect(estadoDeSalientes([suelta('resultado_comprobante'), embudo])).toBeNull();
        // …y con el estado que ahora deja B4, ese manda.
        expect(estadoDeSalientes([{ payload: { step: 'clase_prueba_agendada', flujo: 'embudo', paso_embudo: 'agendada', datos_embudo: { pagada: true } } }, embudo]))
            .toEqual({ paso: 'agendada', datos: { pagada: true } });
        expect(estadoDeSalientes([suelta('prospecto_ia')])).toBeNull();
        expect(estadoDeSalientes([])).toBeNull();
    });
});

describe('lecturas puras', () => {
    it.each([
        ['14/03/2011', { fecha: '2011-03-14', anio: 2011 }],
        ['2011-03-14', { fecha: '2011-03-14', anio: 2011 }],
        ['14 de marzo de 2011', { fecha: '2011-03-14', anio: 2011 }],
        ['2011', { fecha: null, anio: 2011 }],
        ['nació en el 2012', { fecha: null, anio: 2012 }],
        // Fecha imposible: se queda con el año (el grupo va por año; la escuela corrige la ficha).
        ['31/02/2011', { fecha: null, anio: 2011 }],
    ])('leerFechaNacimiento(%s)', (t, esperado) => {
        expect(leerFechaNacimiento(t, AHORA)).toMatchObject(esperado);
    });
    it.each(['15 años', '2026', '1890', 'no sé'])('leerFechaNacimiento(%s) = null', (t) => {
        expect(leerFechaNacimiento(t, AHORA)).toBeNull();
    });

    it('opcionDeTexto: igualdad, sin espacios, palabra dentro y género', () => {
        const posicion = AJ_MONSTER.preguntasProspecto![3];
        const sexo = AJ_MONSTER.preguntasProspecto![2];
        expect(opcionDeTexto('armadora', posicion)?.titulo).toBe('Armador(a)');
        expect(opcionDeTexto('juega de punta', posicion)?.titulo).toBe('Punta');
        expect(opcionDeTexto('libero', posicion)?.titulo).toBe('Líbero');
        expect(opcionDeTexto('es niña', sexo)?.titulo).toBe('Mujer');
        expect(opcionDeTexto('masculino', sexo)?.titulo).toBe('Hombre');
        expect(opcionDeTexto('no sé', posicion)).toBeNull();
    });

    it('leerVarias no confunde la posición con el nombre', () => {
        const r = leerVarias('Mariana, 14/03/2011, punta', AJ_MONSTER.preguntasProspecto!, AHORA);
        expect(r).toEqual({
            respuestas: { nombre: 'Mariana', fecha_nacimiento: '2011-03-14', posicion: 'Punta' },
            nombre: 'Mariana', fechaNacimiento: '2011-03-14', anio: 2011,
        });
    });

    it('leerSede: una sola sede o nada', () => {
        const b = AJ_MONSTER.botonesSede!;
        expect(leerSede('la del norte', b, SEDES)).toBe(NORTE);
        expect(leerSede('calle 152', b, SEDES)).toBe(SUBA);
        expect(leerSede('cualquiera', b, SEDES)).toBeNull();
        expect(leerSede('norte o suba', b, SEDES)).toBeNull();
    });

    it('franjasOfrecibles: días de la escuela, con cupo, 2 h de anticipación', () => {
        const hoy = [{ id: 'hoy', fecha: '2026-10-29', horaInicio: '19:30', horaFin: null, lugar: null, cupos: 3 }];
        expect(franjasOfrecibles([...FRANJAS, ...hoy], { ahora: AHORA, diasSemana: [0, 6] }).map((f) => f.id))
            .toEqual(['s-sab31', 's-dom01', 's-sab07']);
        expect(franjasOfrecibles([...FRANJAS, ...hoy], { ahora: AHORA, diasSemana: null }).map((f) => f.id))
            .toEqual(['s-sab31', 's-dom01', 's-lun02', 's-sab07']);
    });

    it('filaDeFranja cabe en los límites de Meta', () => {
        const f = filaDeFranja({ id: 'x', fecha: '2026-10-31', horaInicio: '11:00:00', horaFin: '13:00:00', lugar: 'Colegio Bilingüe La Enseñanza sede Norte', cupos: 12, profe: 'Sebastián Hurtado Gómez' }, 'U19-U21 Femenino Proyección');
        expect(Array.from(f.title).length).toBeLessThanOrEqual(24);
        expect(Array.from(f.descripcion!).length).toBeLessThanOrEqual(72);
        expect(Array.from(f.seccion!).length).toBeLessThanOrEqual(24);
    });

    it('textosPorDefecto: con valor nunca es gratis', () => {
        expect(textosPorDefecto({ nombre_clase: 'prueba', trial_price: 15000 })).toEqual({ nombre: 'clase de prueba', gratis: false, precio: '$15.000' });
        expect(textosPorDefecto({ nombre_clase: null, trial_price: 0 })).toEqual({ nombre: 'clase de cortesía', gratis: true, precio: null });
    });

    it('botones de plantilla (payload = texto) se traducen', () => {
        expect(botonDePlantilla('Elegir otro horario')).toBe(BOTON_EMBUDO.REPROGRAMAR);
        expect(botonDePlantilla('Cambiar horario')).toBe(BOTON_EMBUDO.CAMBIAR);
        expect(botonDePlantilla('No puedo ir')).toBe(BOTON_EMBUDO.CAMBIAR);
        expect(botonDePlantilla('Ahí estaremos')).toBe(BOTON_EMBUDO.AHI_ESTAREMOS);
        expect(botonDePlantilla('sm_pd_club')).toBeNull();
        expect(botonDePlantilla('Pagar ahora')).toBeNull();
    });

    it('comoPagar: un número para varias billeteras, o la lista', () => {
        expect(comoPagar([{ tipo: 'Nequi', numero: '319 450 5150' }, { tipo: 'Daviplata', numero: '3194505150' }]))
            .toBe('por Nequi o Daviplata al 319 450 5150');
        // Monster 2026-11-08: Nequi y Daviplata al MISMO número, con titular → los dos medios y «a nombre de».
        expect(comoPagar([{ tipo: 'Nequi', numero: '3194505150', titular: 'Iván Sossa' }, { tipo: 'Daviplata', numero: '3194505150', titular: 'Iván Sossa' }]))
            .toBe('por Nequi o Daviplata al 319 450 5150, a nombre de Iván Sossa');
        expect(comoPagar([{ tipo: 'Nequi', numero: '3001112233', titular: 'Club' }, { tipo: 'Bancolombia', numero: '123-456' }]))
            .toBe('a una de estas cuentas:\n• Nequi: 300 111 2233 (a nombre de Club)\n• Bancolombia: 123-456\n');
    });

    it('bienvenida propia que ya trae cada sede con su dirección: no se repite con la de la base', () => {
        const botones = [{ branchId: NORTE, titulo: '🟡 Sede Norte' }, { branchId: SUBA, titulo: '⚫ Sede Suba' }];
        const sedes = [
            { branchId: NORTE, nombre: 'Norte', direccion: 'AV. El Polo, Cl. 201 #67-12' },
            { branchId: SUBA, nombre: 'Suba', direccion: 'Cl. 152 #No. 94A 67' },
        ];
        const propia = '¡Hola! ¿Cuál sede te queda más cerca?\n🟡 *Sede Norte* · Calle 201 #67-12\n⚫ *Sede Suba* · Calle 152 #94A-67';
        expect(lineasDeSedes(propia, botones, sedes)).toEqual([]);
        expect(mensajeDeBienvenida(propia, botones, sedes).texto).toBe(propia);
        // Nombra la sede pero sin dirección: la de la base sí sirve.
        expect(lineasDeSedes('¿Norte o Suba? Cuéntanos cuál sede te queda más cerca', botones, sedes))
            .toEqual(['🟡 Sede Norte · AV. El Polo, Cl. 201 #67-12', '⚫ Sede Suba · Cl. 152 #No. 94A 67']);
        // Solo una trae dirección: se agrega la otra.
        expect(lineasDeSedes('🟡 Sede Norte: Calle 201 #67-12\n¿Y en Suba?', botones, sedes))
            .toEqual(['⚫ Sede Suba · Cl. 152 #No. 94A 67']);
    });

    it('cupoSimulado: lo que respondería la RPC en el número de pruebas', () => {
        const ahora = Date.parse('2026-10-31T16:00:00Z');
        expect(cupoSimulado({ precio: 15000, separarHoras: 24 }, ahora))
            .toEqual({ estado: 'separada', hasta: '2026-11-01T16:00:00.000Z' });
        // Como la RPC: sin horas para separar, o si ya pagó (cambio de horario), agenda.
        expect(cupoSimulado({ precio: 15000, separarHoras: null }, ahora)).toEqual({ estado: 'agendada', hasta: null });
        expect(cupoSimulado({ precio: 15000, separarHoras: 24 }, ahora, { pagada: true })).toEqual({ estado: 'agendada', hasta: null });
        expect(cupoSimulado({ precio: 15000, separarHoras: 2 }, ahora).hasta).toBe('2026-10-31T18:00:00.000Z');
        expect(cupoSimulado({ precio: 0, separarHoras: 24 }, ahora)).toEqual({ estado: 'agendada', hasta: null });
        expect(cupoSimulado(null, ahora)).toEqual({ estado: 'agendada', hasta: null });
    });

    it('con más de dos sedes, la bienvenida sale como lista', () => {
        const tres = [{ branchId: NORTE, titulo: 'Norte' }, { branchId: SUBA, titulo: 'Suba' }, { branchId: '33333333-3333-4333-8333-333333333333', titulo: 'Chía' }];
        const m = mensajeDeBienvenida(null, tres, []);
        expect(m.botones).toHaveLength(4);
        expect(m.botones.every((b) => b.seccion === 'Sedes')).toBe(true);
        expect(m.texto).toBe('¡Hola! 👋 Gracias por escribirnos.\n\n¿Cuál sede te queda más cerca?');
    });

    it('estado para el recordatorio y lead completo', () => {
        expect(estadoParaRecordatorio('lead-1', 't-1', 's-1')).toEqual({
            flujo: 'embudo', paso_embudo: 'agendada', datos_embudo: { leadId: 'lead-1', teamId: 't-1', slotId: 's-1' },
        });
        const l = leadDeDatos({
            nombre: 'Mariana', anio: 2011, fechaNacimiento: null, genero: 'f', branchId: NORTE,
            respuestas: { nombre: 'Mariana', fecha_nacimiento: '2011', sexo: 'Mujer', posicion: 'Punta' },
        }, grupoDeRango(GRUPO_NORTE));
        expect(l.respuestas).toEqual({ posicion: 'Punta' });
        expect(leadCompletoDeEmbudo(l)).toMatchObject({
            deportista: 'Mariana', branchId: NORTE, teamId: 't-infantil-fem', genero: 'f', categoriaSugerida: 'Infantil Femenino', via: 'embudo',
        });
    });
});

describe('el JSON de Monster tal cual lo deja el SQL de datos (B1, después de la migración)', () => {
    // Copia de monster-b1-despues-de-migracion-v2.sql §6: textos ya numerados y con la
    // introducción; claves extra (`titulo_lista`, `detalle.tipo`) que el motor ignora.
    const PREGUNTAS_SQL = [
        { clave: 'nombre', tipo: 'texto',
            texto: 'Para ubicarte en la categoría correcta te hago 5 preguntas rápidas 🙌\n\n1️⃣ ¿Cuál es el *nombre completo* del deportista?' },
        { clave: 'fecha_nacimiento', tipo: 'fecha', texto: '2️⃣ ¿Cuál es su *fecha de nacimiento*? (día/mes/año)' },
        { clave: 'sexo', tipo: 'botones', texto: '3️⃣ ¿Es *hombre o mujer*?', opciones: ['Mujer', 'Hombre'] },
        { clave: 'posicion', tipo: 'lista', texto: '4️⃣ ¿En qué *posición* juega?', boton: 'Elegir posición', titulo_lista: 'Posición de juego',
            opciones: ['Armador(a)', 'Opuesto', 'Punta', 'Central', 'Líbero', 'Aún no tengo posición'] },
        { clave: 'trayectoria', tipo: 'botones', texto: '5️⃣ ¿Cuál es su *trayectoria* en el voleibol?',
            opciones: ['Estoy empezando', 'Colegio o escuela', 'Club y torneos'],
            detalle: { si: ['Club y torneos'], clave: 'trayectoria_detalle', tipo: 'texto',
                texto: '¡Qué bien! 🏆 Cuéntame en un mensaje *en qué clubes ha entrenado y qué torneos ha jugado*.' } },
    ];
    const BIENVENIDA_SQL = '¡Hola! 👋 Bienvenid@ a *Club Monsters Volley* 🏐⚡\n\n'
        + 'Nos alegra que estés aquí: estás a un paso de unirte a una de las mejores comunidades de voleibol de Bogotá.\n\n'
        + 'Para enviarte la información exacta que necesitas, cuéntanos: ¿cuál sede te queda más cerca?\n'
        + '🟡 *Sede Norte* · Calle 201 #67-12\n'
        + '⚫ *Sede Suba* · Calle 152 #94A-67';
    const aj = ajustesDesdeFila({
        wa_bienvenida: BIENVENIDA_SQL,
        wa_botones_sede: [{ branch_id: NORTE, titulo: '🟡 Sede Norte' }, { branch_id: SUBA, titulo: '⚫ Sede Suba' }],
        wa_preguntas_prospecto: PREGUNTAS_SQL, wa_modo_discreto: 'global', wa_temas_a_persona: null,
    });

    it('se acepta (embudo encendido) con sus opciones y el detalle', () => {
        expect(aj.preguntasProspecto).toHaveLength(5);
        expect(aj.preguntasProspecto![3]).toMatchObject({ boton: 'Elegir posición', opciones: expect.arrayContaining([{ titulo: 'Líbero' }]) });
        expect(aj.preguntasProspecto![4].detalle).toEqual({
            si: ['Club y torneos'], clave: 'trayectoria_detalle',
            texto: '¡Qué bien! 🏆 Cuéntame en un mensaje *en qué clubes ha entrenado y qué torneos ha jugado*.',
        });
    });

    it('la bienvenida no repite las direcciones ni la pregunta; las preguntas no repiten número ni introducción', async () => {
        const c = crear({ aj });
        await iniciarEmbudo(c.ctx);
        expect(c.ultimo().texto).toBe(BIENVENIDA_SQL);
        await c.turno('x', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        expect(c.ultimo().texto).toBe('¡Genial, 🟡 Sede Norte! 🙌\n\n' +
            'Para ubicarte en la categoría correcta te hago 5 preguntas rápidas 🙌\n\n1️⃣ ¿Cuál es el *nombre completo* del deportista?');
        await c.turno('Mariana Gómez Rojas');
        expect(c.ultimo().texto).toBe('¡Mucho gusto, Mariana! 😊\n\n2️⃣ ¿Cuál es su *fecha de nacimiento*? (día/mes/año)');
    });

    it('tituloDeGrupo como el de grupos-por-edad', () => {
        expect(tituloDeGrupo('MIXTO MAYORES PROFUNDIZACION')).toBe('Mixto Mayores Profundizacion');
        expect(tituloDeGrupo('U15 Fem Proyección')).toBe('U15 Fem Proyección');
        expect(grupoDeRango({ teamId: 't', nombre: 'U9 Y U11 MIXTO', coachNombres: ['', 'Sebastián Hurtado'] }))
            .toEqual({ teamId: 't', nombre: 'U9 Y U11 Mixto', profe: 'Sebastián Hurtado' });
    });
});

// ─── Sin clase de prueba hoy: las ofertas vigentes (bot-ofertas, Monster 2026-11-25) ──
//
// En diciembre y enero Monster no tiene clases de prueba: al terminar las preguntas no
// se dice «se agenda una clase de prueba» ni salen horarios; van las convocatorias.
// Datos de ejemplo.

describe('embudo sin clase de prueba (bot-ofertas)', () => {
    const FILAS: FilasCrudas = {
        ofertas: [
            { id: 'o-mayores', tipo: 'convocatoria', titulo: 'Convocatorias Superliga', sede: 'Sede Norte', publico: null, genero: null,
                estado: 'activa', vigente_desde: '2026-11-25', vigente_hasta: '2026-12-11', prioridad: 20, requiere_inscripcion: true,
                requiere_pago: false, valor: null, cta: 'Escríbenos el nombre, la fecha de nacimiento y la convocatoria (día y hora).' },
        ],
        sesiones: [
            { id: 'f', oferta_id: 'o-mayores', fecha: '2026-12-09', hora_inicio: '19:00:00', hora_fin: '21:00:00', lugar: 'ECCI', genero: 'femenino', publico: null, notas: null },
            { id: 'm', oferta_id: 'o-mayores', fecha: '2026-12-09', hora_inicio: '20:00:00', hora_fin: '22:00:00', lugar: 'ECCI', genero: 'masculino', publico: null, notas: null },
        ],
        bloqueos: [{ tipo: 'clase_prueba', desde: '2026-12-01', hasta: '2027-01-31', motivo: null }],
        ajustesClasePrueba: null, mensajeSinOfertas: null,
    };
    const DIC_3 = Date.parse('2026-12-03T15:00:00Z');
    const NOV_28 = Date.parse('2026-11-28T15:00:00Z');
    const SIN_CLASE = armarEstado('monster', FILAS, DIC_3);

    it('al terminar las preguntas: el grupo, «no estamos agendando», las convocatorias de SU género y «¿a cuál fecha?»', async () => {
        const c = crear({ ofertas: SIN_CLASE });
        await hastaHorarios(c);
        const m = c.ultimo();
        expect(m.step).toBe('embudo_ofertas');
        expect(m.estado).toMatchObject({ paso: 'elegir_oferta', datos: { leadId: 'lead-1', teamId: 't-infantil-fem' } });
        expect(m.texto).toContain('le corresponde *Infantil Femenino* en la Sede Norte.');
        expect(m.texto).toContain('Por ahora no estamos agendando clases de prueba (vuelven el lunes 1 de febrero de 2027).');
        expect(m.texto).toContain('*Convocatorias Superliga*');
        expect(m.texto).toContain('7:00 a 9:00 p. m. · ECCI · femenino');
        expect(m.texto).not.toContain('masculino');
        expect(m.texto).toContain('¿Inscribo a *Mariana* a la convocatoria? Es a *todas sus fechas*, en orden. Respóndeme *sí* y se lo paso a la escuela 🙌');
        expect(m.texto).not.toMatch(/se agenda una|próximos horarios|\$15\.000/);
        expect(m.botones).toBeUndefined();
        expect(c.ctx.franjas).not.toHaveBeenCalled();
        expect(c.ctx.tomarCupo).not.toHaveBeenCalled();
        expect(c.ctx.guardarLead).toHaveBeenLastCalledWith(expect.objectContaining({ deportista: 'Mariana Gómez Rojas', quiere: 'convocatoria' }));

        // La fecha que elige: lead con la elección, aviso a la escuela, pendiente de ella y flujo cerrado.
        expect(await c.turno('La del miércoles 9 a las 7')).toBe(true);
        const cierre = c.ultimo();
        expect(cierre.step).toBe('embudo_inscripcion_oferta');
        expect(cierre.estado).toBeNull();
        expect(cierre.texto).toContain('«La del miércoles 9 a las 7»');
        expect(cierre.texto).toContain('La escuela te confirma el cupo por aquí.');
        expect(cierre.contexto).toEqual({ pendiente_escuela: 'inscripción: La del miércoles 9 a las 7' });
        expect(c.ctx.guardarLead).toHaveBeenLastCalledWith(expect.objectContaining({
            quiere: 'convocatoria', respuestas: expect.objectContaining({ oferta_elegida: 'La del miércoles 9 a las 7' }),
        }));
        expect(c.ctx.avisarEscuela).toHaveBeenLastCalledWith('inscripcion_oferta',
            'Interesado: Mariana Gómez Rojas (2011). Quiere inscribirse (convocatoria): «La del miércoles 9 a las 7». Sede: Sede Norte.');
        expect(c.ctx.tomarCupo).not.toHaveBeenCalled();
    });

    it('en la pregunta de la fecha: otra pregunta la contesta el bot (y se recuerda); un «gracias», una vez', async () => {
        const c = crear({ ofertas: SIN_CLASE });
        await hastaHorarios(c);
        expect(await c.turno('¿Y cuánto cuesta?')).toBe(false);
        expect(await c.turno('Gracias')).toBe(true);
        expect(c.ultimo().texto).toContain('respóndeme *sí* y le paso tu inscripción');
        const n = c.s.enviados.length;
        expect(await c.turno('ok')).toBe(true);
        expect(c.s.enviados).toHaveLength(n);
        expect(recordatorioDePasoEmbudo(AJ_MONSTER, { paso: 'elegir_oferta', datos: {} })?.texto)
            .toBe('Cuando quieras seguimos con tu registro 🙌 Respóndeme *sí* y le paso tu inscripción a la escuela (es a todas las fechas de la convocatoria).');
    });

    it('sin clase y sin ofertas: el lead y la escuela le escribe (sin horarios ni clase)', async () => {
        const c = crear({ ofertas: armarEstado('monster', { ...FILAS, ofertas: [], sesiones: [] }, DIC_3) });
        await hastaHorarios(c);
        const m = c.ultimo();
        expect(m.step).toBe('embudo_a_persona');
        expect(m.estado).toBeNull();
        expect(m.texto).toContain('Por ahora no estamos agendando clases de prueba');
        expect(m.texto).toContain('Ya le pasé tus datos a la escuela y te escriben por aquí cuando haya fechas');
        expect(c.ctx.franjas).not.toHaveBeenCalled();
        expect(c.ctx.avisarEscuela).toHaveBeenCalledWith('sin_horarios', expect.stringContaining('Sin clase de prueba hoy ni ofertas vigentes.'));
    });

    it('un horario de una lista vieja un día sin clase no toma el cupo; «Cambiar horario» tampoco muestra horarios', async () => {
        const estado = { paso: 'elegir_franja' as const, datos: { leadId: 'lead-1', teamId: 't', grupo: 'Infantil', nombre: 'Mariana', lista: ['s-sab31'] } };
        const c = crear({ ofertas: SIN_CLASE, estado });
        expect(await c.turno('', `${BOTON_EMBUDO.FRANJA}s-sab31`)).toBe(true);
        expect(c.ctx.tomarCupo).not.toHaveBeenCalled();
        expect(c.ultimo().step).toBe('embudo_ofertas');
        const d = crear({ ofertas: SIN_CLASE, estado: { paso: 'agendada', datos: { leadId: 'lead-1', teamId: 't', slotId: 's-sab31' } } });
        await d.turno('', BOTON_EMBUDO.CAMBIAR);
        expect(d.ultimo().step).toBe('embudo_ofertas');
        expect(d.ultimo().texto).not.toContain('Elige el nuevo horario');
    });

    it('la matrícula un día sin clase no promete «después de la clase de prueba»', async () => {
        const estado = { paso: 'elegir_franja' as const, datos: { leadId: 'lead-1', teamId: 't', grupo: 'Infantil', nombre: 'Mariana', genero: 'f' as const, lista: ['s-sab31'] } };
        const c = crear({ ofertas: SIN_CLASE, estado });
        await c.turno('¿Y para matricularla qué hago?');
        expect(c.ultimo().texto).toContain('Le pasé a la escuela que quieres matricularla: te escriben por aquí con los pasos 🙌');
        expect(c.ultimo().texto).not.toContain('después de la clase');
        expect(textoDeMatriculaSinClase('Mariana Gómez', null)).toBe('Le pasé a la escuela que quieres hacer la matrícula de Mariana: te escriben por aquí con los pasos 🙌');
    });

    it('antes del bloqueo (28-nov): la clase de siempre, pero una franja de un día bloqueado no se agenda', async () => {
        const nov = armarEstado('monster', FILAS, NOV_28);
        const c = crear({ ofertas: nov });
        await hastaHorarios(c);
        expect(c.ultimo().texto).toContain('Para empezar en el club se agenda una clase de prueba, que cuesta $15.000');
        const DIC_05: FranjaEmbudo = { id: 's-dic05', fecha: '2026-12-05', horaInicio: '08:00', horaFin: '10:00', lugar: 'La Enseñanza', cupos: 6 };
        const d = crear({
            ofertas: nov, franjas: [...FRANJAS, DIC_05],
            estado: { paso: 'elegir_franja', datos: { leadId: 'lead-1', teamId: 't', grupo: 'Infantil', lista: ['s-dic05'] } },
        });
        await d.turno('', `${BOTON_EMBUDO.FRANJA}s-dic05`);
        expect(d.ctx.tomarCupo).not.toHaveBeenCalled();
        expect(d.ultimo().texto).toContain('Ese horario ya no está disponible');
        expect(textoSinClaseDePrueba(armarEstado('x', { ...FILAS, bloqueos: [] , ajustesClasePrueba: { whatsapp_enabled: false } }, NOV_28)))
            .toBe('Por ahora no estamos agendando clases de prueba.');
    });

    it('regresión: clase disponible, sin ofertas ni bloqueos → el embudo de siempre, letra por letra', async () => {
        const nada = armarEstado('dynasty', { ofertas: [], sesiones: [], bloqueos: [], ajustesClasePrueba: null, mensajeSinOfertas: null }, NOV_28);
        const con = crear({ ofertas: nada });
        const sin = crear();
        await hastaHorarios(con);
        await hastaHorarios(sin);
        expect(con.s.enviados).toEqual(sin.s.enviados);
        expect(con.ultimo().step).toBe('embudo_horarios');
        await con.turno('1');
        await sin.turno('1');
        expect(con.s.enviados).toEqual(sin.s.enviados);
        expect(con.ctx.tomarCupo).toHaveBeenCalledTimes(1);
        expect(leadCompletoDeEmbudo(leadDeDatos({ nombre: 'X' }, null)).quiere).toBe('clase_prueba');
    });
});

// (2026-11-26) Inscripción a convocatoria: lo que el embudo sabe va a `source_detail.convocatoria`.
describe('convocatoriaDeEmbudo', () => {
    it('título solo si se le mostró UNA; sede sin emojis, género y año', () => {
        const d = { nombre: 'Juan', sedeTitulo: '📍 Sede Suba', genero: 'm' as const, anio: 2005 };
        expect(convocatoriaDeEmbudo(d, ['Superliga'])).toEqual({ titulo: 'Superliga', sede: 'Sede Suba', genero: 'masculino', anio: 2005 });
        expect(convocatoriaDeEmbudo(d, ['A', 'B']).titulo).toBeNull();
        expect(convocatoriaDeEmbudo({ nombre: 'X' })).toEqual({ titulo: null, sede: null, genero: null, anio: null });
    });

    it('leadCompletoDeEmbudo la pasa tal cual (y sin ella no agrega la clave)', () => {
        const conv = { titulo: 'Superliga', sede: null, genero: 'femenino', anio: 2010 };
        expect(leadCompletoDeEmbudo({ ...leadDeDatos({ nombre: 'X' }, null), quiere: 'convocatoria', convocatoria: conv }))
            .toMatchObject({ quiere: 'convocatoria', convocatoria: conv });
        expect(leadCompletoDeEmbudo(leadDeDatos({ nombre: 'X' }, null))).not.toHaveProperty('convocatoria');
    });
});

// ─── Sin clase de prueba: SOLO la convocatoria que le aplica (Monster 2026-11-25, 2.ª vuelta) ──
//
// Las tres convocatorias de Monster con sus criterios reales (20261125134852): mayores =
// nacidos hasta 2008 y con trayectoria; Suba = 2009–2022; Norte = todas. Textos de la
// escuela (descripción + cierre) y su nota común. Hoy: jueves 3-dic-2026, 10:00 a. m.

describe('embudo sin clase de prueba: la convocatoria que le aplica (criterios de la oferta)', () => {
    const T_NORTE = 'Convocatorias Sede Norte — grupos de formación';
    const T_MAYORES = 'Convocatorias equipos mayores de competencia — Superliga';
    const T_SUBA = 'Convocatorias Sede Suba (Parque Pinar de Suba)';
    const DESC_MAYORES = '¡Tu experiencia en el voleibol puede llevarte a un nuevo nivel!\n\n'
        + 'Por tu trayectoria y perfil deportivo, te invitamos a participar en las *convocatorias de los equipos mayores de competencia de Monster’s Volley*, '
        + 'orientadas a conformar nuestros equipos para el proyecto Superliga 2027.\n\n'
        + 'Buscamos deportistas comprometidos, con experiencia, mentalidad competitiva y disposición para asumir nuevos retos deportivos.';
    const CTA_MAYORES = 'Esta es una oportunidad para demostrar tu nivel, integrarte a un proceso competitivo y proyectarte hacia nuevos desafíos.\n\n'
        + '¡Queremos conocer tu talento y contar contigo en este nuevo proyecto!';
    const DESC_SUBA = '¡Queremos descubrir tu talento y ayudarte a dar el siguiente paso en el voleibol!\n\n'
        + 'Por tu año de nacimiento, te invitamos a participar en las *convocatorias de los grupos de proyección de nuestra sede Suba*.\n\n'
        + 'Estas jornadas nos permitirán conocer tus habilidades, evaluar tu nivel deportivo e identificar el grupo más adecuado para continuar tu proceso de formación y proyección.';
    const CTA_SUBA = 'Queremos que cada deportista tenga la oportunidad de demostrar sus capacidades y encontrar un espacio donde pueda seguir creciendo.\n\n'
        + '*¡Tu próximo paso en el voleibol puede comenzar aquí!* Te esperamos en las convocatorias de Monster’s Volley.';
    const DESC_NORTE = '¡Tenemos una oportunidad para que sigas creciendo en el voleibol!\n\n'
        + 'Por tu edad y perfil, te invitamos a participar en las *convocatorias de los grupos de formación de nuestra sede norte*.\n\n'
        + 'Buscamos identificar tus habilidades, conocer tu nivel de juego y orientarte hacia el grupo que mejor acompañe tu desarrollo deportivo.';
    const CTA_NORTE = 'Queremos brindarte un espacio donde puedas aprender, mejorar tus habilidades y disfrutar del voleibol mientras avanzas en tu proceso deportivo.\n\n'
        + '¡Anímate a participar y comienza a construir tu camino en Monster’s Volley!';
    const NOTA = '¡Queremos conocer tu potencial y ayudarte a encontrar el grupo ideal para tu desarrollo deportivo!\n\n'
        + 'Durante las convocatorias realizaremos una evaluación objetiva de tus habilidades técnicas, capacidades físicas y fundamentos de juego.\n\n'
        + 'Nuestro propósito es identificar tus fortalezas y oportunidades de mejora para que, al finalizar enero, podamos asignarte al grupo de proyección o '
        + 'competencia que mejor se ajuste a tu nivel y proceso deportivo.\n\n'
        + 'No se trata solamente de seleccionar jugadores, sino de encontrar el espacio donde puedas crecer, mejorar y alcanzar tus objetivos en el voleibol.';
    const PREGUNTAS_OFERTAS = '¡Queremos conocerte y conocer tu experiencia en el voleibol!\n\n- *Año de nacimiento:*\n- *Trayectoria deportiva:*';

    function filasMonster(conCriterios = true): FilasCrudas {
        const oferta = (o: Record<string, any>) => ({
            tipo: 'convocatoria', sede: null, publico: null, genero: null, estado: 'activa', vigente_desde: '2026-11-25',
            requiere_inscripcion: true, requiere_pago: false, valor: null, mensaje_sin_cupos: null,
            ...o,
            ...(conCriterios ? {} : { anio_nacimiento_desde: null, anio_nacimiento_hasta: null, requiere_trayectoria: false }),
        });
        let n = 0;
        const ses = (oferta_id: string, fecha: string, ini: string, fin: string | null, lugar: string, extra: Record<string, any> = {}) => ({
            id: `ses-${++n}`, oferta_id, fecha, hora_inicio: `${ini}:00`, hora_fin: fin ? `${fin}:00` : null, lugar,
            genero: null, publico: null, notas: null, ...extra,
        });
        const sesiones: any[] = [
            ses('of-norte', '2026-12-05', '07:00', '09:00', 'Locos por Pádel'),
            ses('of-norte', '2026-12-06', '07:00', '09:00', 'Locos por Pádel'),
            ses('of-norte', '2026-12-12', '08:00', '10:00', 'Universidad ECCI'),
            ...(['femenino', 'masculino'] as const).flatMap((g) => [
                ses('of-mayores', '2026-12-01', '19:00', '21:00', 'Universidad ECCI', { genero: g }),
                ses('of-mayores', '2026-12-03', '19:00', '21:00', 'Universidad ECCI', { genero: g }),
                ses('of-mayores', '2026-12-09', g === 'femenino' ? '19:00' : '20:00', g === 'femenino' ? '21:00' : '22:00', 'Universidad ECCI', { genero: g }),
                ses('of-mayores', '2026-12-11', '19:00', '21:00', 'Universidad ECCI', { genero: g, notas: 'Una cancha femenino y otra masculino' }),
            ]),
        ];
        const GRUPOS = ['Nacidos entre 2017 y 2022', 'Nacidos en 2015 y 2016', 'Nacidos en 2013 y 2014', 'Nacidos en 2011 y 2012', 'Nacidos en 2009 y 2010'];
        for (const f of ['2026-12-04', '2026-12-11']) {
            GRUPOS.forEach((publico, i) => sesiones.push(ses('of-suba', f, ['14:00', '14:00', '16:00', '18:00', '20:00'][i], null,
                'Parque Pinar de Suba', { genero: 'mixto', publico })));
        }
        for (const f of ['2026-12-05', '2026-12-12', '2026-12-06', '2026-12-13']) {
            GRUPOS.forEach((publico, i) => sesiones.push(ses('of-suba', f, ['07:00', '07:00', '09:00', '11:00', '13:00'][i], null,
                'Parque Pinar de Suba', { genero: 'mixto', publico })));
        }
        return {
            ofertas: [
                oferta({ id: 'of-norte', titulo: T_NORTE, sede: 'Sede Norte', publico: 'Grupos de formación, todas las categorías',
                    vigente_hasta: '2026-12-12', prioridad: 30, descripcion: DESC_NORTE, cta: CTA_NORTE }),
                oferta({ id: 'of-mayores', titulo: T_MAYORES, sede: 'Sede Norte', vigente_hasta: '2026-12-11', prioridad: 20,
                    descripcion: DESC_MAYORES, cta: CTA_MAYORES, anio_nacimiento_hasta: 2008, requiere_trayectoria: true }),
                oferta({ id: 'of-suba', titulo: T_SUBA, sede: 'Sede Suba', genero: 'mixto', vigente_hasta: '2026-12-13', prioridad: 10,
                    publico: 'Grupos de proyección, nacidas y nacidos de 2009 a 2022', descripcion: DESC_SUBA, cta: CTA_SUBA,
                    anio_nacimiento_desde: 2009, anio_nacimiento_hasta: 2022 }),
            ],
            sesiones,
            bloqueos: [{ tipo: 'clase_prueba', desde: '2026-12-01', hasta: '2027-01-31', motivo: null }],
            ajustesClasePrueba: null, mensajeSinOfertas: null, preguntasOfertas: PREGUNTAS_OFERTAS, notaOfertas: NOTA,
        };
    }
    const DIC_3 = Date.parse('2026-12-03T10:00:00-05:00');
    const MONSTER = armarEstado('monster', filasMonster(), DIC_3);
    /** Monster sin la pregunta de trayectoria (nombre, fecha, sexo, posición): la trayectoria no se sabe. */
    const AJ_SIN_TRAYECTORIA: AjustesWhatsAppEscuela = ajustesDesdeFila({
        wa_modo_cortesia: 'clase', wa_bienvenida: BIENVENIDA,
        wa_botones_sede: [{ branch_id: NORTE, titulo: '🟡 Sede Norte' }, { branch_id: SUBA, titulo: '⚫ Sede Suba' }],
        wa_preguntas_prospecto: PREGUNTAS_MONSTER.slice(0, 4), wa_modo_discreto: 'no', wa_temas_a_persona: null,
    });
    const SIN_GRUPO = { [NORTE]: null, [SUBA]: null };
    const lineas = (t: string) => t.split('\n').filter((l) => l.startsWith('•'));

    async function nina2014(c: ReturnType<typeof crear>) {
        await iniciarEmbudo(c.ctx);
        await c.turno('🟡 Sede Norte', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Sofía Ramírez Peña');
        await c.turno('22/05/2014');
        await c.turno('Mujer', `${BOTON_EMBUDO.OPCION}sexo:0`);
        await c.turno('Punta');
        await c.turno('Estoy empezando', `${BOTON_EMBUDO.OPCION}trayectoria:0`);
    }

    async function hombre1998ConClubes(c: ReturnType<typeof crear>) {
        await iniciarEmbudo(c.ctx);
        await c.turno('🟡 Sede Norte', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Andrés Felipe Torres');
        await c.turno('07/08/1998');
        await c.turno('Hombre', `${BOTON_EMBUDO.OPCION}sexo:1`);
        await c.turno('Opuesto');
        await c.turno('Club y torneos', `${BOTON_EMBUDO.OPCION}trayectoria:2`);
        await c.turno('Jugué en Titanes y la liga distrital');
    }

    async function hombre1998(c: ReturnType<typeof crear>) {
        await iniciarEmbudo(c.ctx);
        await c.turno('🟡 Sede Norte', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Andrés Felipe Torres');
        await c.turno('07/08/1998');
        await c.turno('Hombre', `${BOTON_EMBUDO.OPCION}sexo:1`);
        await c.turno('Opuesto');
    }

    it('niña de 2014 sin clubes: Suba (solo 2013–2014) y Norte, sin sesiones masculinas, con la nota y sin mayores', async () => {
        const c = crear({ ofertas: MONSTER });
        await nina2014(c);
        const m = c.ultimo();
        expect(m.step).toBe('embudo_ofertas');
        expect(m.estado).toMatchObject({ paso: 'elegir_oferta', datos: { leadId: 'lead-1', teamId: 't-infantil-fem' } });
        // La de su año (Suba) primero, después la de todas las categorías (Norte).
        expect(m.estado!.datos.ofertasMostradas).toEqual([
            { titulo: T_SUBA, tipo: 'convocatoria' }, { titulo: T_NORTE, tipo: 'convocatoria' },
        ]);
        const t = m.texto;
        expect(t.startsWith('¡Listo! ✨ Por su año (2014) a Sofía le corresponde *Infantil Femenino* en la Sede Norte.\n'
            + 'Por ahora no estamos agendando clases de prueba (vuelven el lunes 1 de febrero de 2027).\n\n' + DESC_SUBA)).toBe(true);
        expect(t).toContain(CTA_SUBA);
        expect(t).toContain(DESC_NORTE);
        expect(t).toContain(CTA_NORTE);
        expect(t).toContain('*Lugar:* Parque Pinar de Suba.');
        expect(lineas(t)).toEqual([
            '• viernes 4 y viernes 11 de diciembre, 4:00 p. m. · Nacidos en 2013 y 2014',
            '• sábado 5, domingo 6, sábado 12 y domingo 13 de diciembre, 9:00 a. m. · Nacidos en 2013 y 2014',
            '• sábado 5 y domingo 6 de diciembre, 7:00 a 9:00 a. m. · Locos por Pádel',
            '• sábado 12 de diciembre, 8:00 a 10:00 a. m. · Universidad ECCI',
        ]);
        expect(t).not.toMatch(/masculino|Superliga|equipos mayores|2015|2017|2011|2009/);
        expect(t).toContain(`${NOTA}\n\n¿Inscribo a *Sofía* a la convocatoria? Es a *todas sus fechas*, en orden. Respóndeme *sí* y se lo paso a la escuela 🙌`);
        expect(t.length).toBeLessThanOrEqual(MAX_TEXTO_OFERTAS);
        expect(c.ctx.franjas).not.toHaveBeenCalled();
        expect(c.ctx.guardarLead).toHaveBeenLastCalledWith(expect.objectContaining({ deportista: 'Sofía Ramírez Peña', quiere: 'convocatoria' }));

        // El aviso a la escuela nombra las convocatorias que se le mostraron.
        expect(await c.turno('La del sábado 5 a las 9')).toBe(true);
        expect(c.ultimo().step).toBe('embudo_inscripcion_oferta');
        expect(c.ctx.avisarEscuela).toHaveBeenLastCalledWith('inscripcion_oferta',
            'Interesado: Sofía Ramírez Peña (2014). Quiere inscribirse (convocatoria): «La del sábado 5 a las 9». '
            + `Le ofrecí: «${T_SUBA}» y «${T_NORTE}». Sede: Sede Norte.`);
        expect(c.ctx.guardarLead).toHaveBeenLastCalledWith(expect.objectContaining({
            quiere: 'convocatoria', respuestas: expect.objectContaining({ oferta_elegida: 'La del sábado 5 a las 9' }),
            // Se le mostraron dos: sin título (la escuela lo ve en «oferta_elegida»); sede, género y año sí.
            convocatoria: { titulo: null, sede: 'Sede Norte', genero: 'femenino', anio: 2014 },
        }));
    });

    it('reserva: hombre de 1998 con «Club y torneos» → solo mayores, sesiones masculinas', async () => {
        const c = crear({ ofertas: MONSTER, grupos: SIN_GRUPO });
        await hombre1998ConClubes(c);
        const m = c.ultimo();
        expect(m.step).toBe('embudo_ofertas');
        expect(m.estado?.datos.ofertasMostradas).toEqual([{ titulo: T_MAYORES, tipo: 'convocatoria' }]);
        expect(m.texto).toContain(DESC_MAYORES);
        expect(m.texto).toContain(CTA_MAYORES);
        expect(m.texto).toContain('*Lugar:* Universidad ECCI.');
        expect(lineas(m.texto)).toEqual([
            '• jueves 3 de diciembre, 7:00 a 9:00 p. m. · masculino',
            '• miércoles 9 de diciembre, 8:00 a 10:00 p. m. · masculino',
            '• viernes 11 de diciembre, 7:00 a 9:00 p. m. · masculino · Una cancha femenino y otra masculino',
        ]);
        expect(m.texto).not.toContain(DESC_NORTE);
        expect(m.texto).not.toContain(DESC_SUBA);
        expect(m.texto).toContain(`${NOTA}\n\n¿Inscribo a *Andrés* a la convocatoria? Es a *todas sus fechas*, en orden. Respóndeme *sí* y se lo paso a la escuela 🙌`);
    });

    it('reserva: hombre de 1998 sin saberse su trayectoria → sin pregunta extra, solo Norte', async () => {
        const c = crear({ aj: AJ_SIN_TRAYECTORIA, ofertas: MONSTER, grupos: SIN_GRUPO });
        await hombre1998(c);
        const m = c.ultimo();
        expect(m.step).toBe('embudo_ofertas');
        expect(m.estado?.datos.ofertasMostradas).toEqual([{ titulo: T_NORTE, tipo: 'convocatoria' }]);
        expect(m.texto).toContain(DESC_NORTE);
        expect(m.texto).not.toContain(DESC_MAYORES);
        expect(m.texto).not.toContain(DESC_SUBA);
        expect(m.texto).not.toContain('¿Has entrenado');
        expect(lineas(m.texto)).toHaveLength(2);
        expect(m.texto).toContain(NOTA);
    });

    it('con la conversación compartida (iniciarOfertas): se guarda el lead y se le entrega lo que ya contó; el embudo no manda ofertas', async () => {
        const c = crear({ ofertas: MONSTER, iniciarOfertas: async () => true });
        await iniciarEmbudo(c.ctx);
        await c.turno('🟡 Sede Norte', `${BOTON_EMBUDO.SEDE}${NORTE}`);
        await c.turno('Sofía Ramírez Peña');
        await c.turno('22/05/2014');
        await c.turno('Mujer', `${BOTON_EMBUDO.OPCION}sexo:0`);
        await c.turno('Punta');
        const n = c.s.enviados.length;
        expect(await c.turno('Estoy empezando', `${BOTON_EMBUDO.OPCION}trayectoria:0`)).toBe(true);
        expect(c.s.enviados).toHaveLength(n);
        expect(c.ctx.iniciarOfertas).toHaveBeenCalledTimes(1);
        expect(c.ctx.iniciarOfertas).toHaveBeenCalledWith({
            genero: 'femenino', anio: 2014, trayectoria: false, nombre: 'Sofía Ramírez Peña', sede: 'Sede Norte',
        });
        expect(c.ctx.guardarLead).toHaveBeenLastCalledWith(expect.objectContaining({ deportista: 'Sofía Ramírez Peña', quiere: 'convocatoria' }));
        expect(c.ctx.franjas).not.toHaveBeenCalled();
    });

    it('(Monster 2026-11-26) hoy SÍ hay clase de prueba, pero pidió una convocatoria → termina en la convocatoria, sin franjas ni cobro', async () => {
        const abierta = { ...MONSTER, claseDePrueba: { ...MONSTER.claseDePrueba, disponible: true } };
        const recorrer = async (c: ReturnType<typeof crear>) => {
            await iniciarEmbudo(c.ctx);
            await c.turno('⚫ Sede Suba', `${BOTON_EMBUDO.SEDE}${NORTE}`);
            await c.turno('Gabriela Medina');
            await c.turno('22/05/2016');
            await c.turno('Mujer', `${BOTON_EMBUDO.OPCION}sexo:0`);
            await c.turno('Aún no tengo posición');
            await c.turno('Estoy empezando', `${BOTON_EMBUDO.OPCION}trayectoria:0`);
        };
        const conv = crear({ ofertas: abierta, iniciarOfertas: async () => true, pidioConvocatoria: true });
        await recorrer(conv);
        expect(conv.ctx.iniciarOfertas).toHaveBeenCalledTimes(1);
        expect(conv.ctx.franjas).not.toHaveBeenCalled();
        expect(conv.s.enviados.map((e) => e.texto).join(' ')).not.toMatch(/clase de prueba|\$15\.000|se agenda/i);

        // Quien NO pidió convocatoria sigue con la clase de prueba de ese día (este fin de semana sí hay).
        const clase = crear({ ofertas: abierta, iniciarOfertas: async () => true, pidioConvocatoria: false });
        await recorrer(clase);
        expect(clase.ctx.iniciarOfertas).not.toHaveBeenCalled();
        expect(clase.ctx.franjas).toHaveBeenCalled();
    });

    it('prefill: con clubes va la trayectoria y lo que contó; sin respuesta clara, la trayectoria no va', async () => {
        const con = crear({ ofertas: MONSTER, grupos: SIN_GRUPO, iniciarOfertas: async () => true });
        await hombre1998ConClubes(con);
        expect(con.ctx.iniciarOfertas).toHaveBeenCalledWith({
            genero: 'masculino', anio: 1998, trayectoria: true,
            detalle: 'Club y torneos · Jugué en Titanes y la liga distrital', nombre: 'Andrés Felipe Torres', sede: 'Sede Norte',
        });
        const sin = crear({ aj: AJ_SIN_TRAYECTORIA, ofertas: MONSTER, grupos: SIN_GRUPO, iniciarOfertas: async () => true });
        await hombre1998(sin);
        expect(sin.ctx.iniciarOfertas).toHaveBeenCalledWith({ genero: 'masculino', anio: 1998, nombre: 'Andrés Felipe Torres', sede: 'Sede Norte' });
        // Una sede que ninguna oferta nombra no va.
        expect(prefillDeOfertas({ sedeTitulo: '⚫ Sede Chía', respuestas: {} }, [], MONSTER, AHORA)).toEqual({});
        expect(prefillDeOfertas({ sedeTitulo: '⚫ Sede Suba', respuestas: {} }, [], MONSTER, AHORA)).toEqual({ sede: 'Sede Suba' });
    });

    it('iniciarOfertas que no la toma (false) → el mensaje de reserva, igual que sin ella; sin preguntasOfertas no se llama', async () => {
        const nolatoma = crear({ ofertas: MONSTER, iniciarOfertas: async () => false });
        const sin = crear({ ofertas: MONSTER });
        await nina2014(nolatoma);
        await nina2014(sin);
        expect(nolatoma.ctx.iniciarOfertas).toHaveBeenCalledTimes(1);
        expect(nolatoma.s.enviados).toEqual(sin.s.enviados);
        const sinPreguntas = armarEstado('monster', { ...filasMonster(), preguntasOfertas: null }, DIC_3);
        const c = crear({ ofertas: sinPreguntas, iniciarOfertas: async () => true });
        await nina2014(c);
        expect(c.ctx.iniciarOfertas).not.toHaveBeenCalled();
        expect(c.ultimo().step).toBe('embudo_ofertas');
    });

    it('regresión: una escuela sin criterios en sus ofertas ve el mensaje de siempre, letra por letra (todas las de su género, sin la nota)', async () => {
        const sinCriterios = armarEstado('otra', filasMonster(false), DIC_3);
        expect(ofertasConCriterios(sinCriterios)).toBe(false);
        expect(ofertasConCriterios(MONSTER)).toBe(true);
        const c = crear({ ofertas: sinCriterios });
        await nina2014(c);
        const m = c.ultimo();
        expect(m.step).toBe('embudo_ofertas');
        expect(m.texto).toBe([
            '¡Listo! ✨ Por su año (2014) a Sofía le corresponde *Infantil Femenino* en la Sede Norte.\n'
                + 'Por ahora no estamos agendando clases de prueba (vuelven el lunes 1 de febrero de 2027).',
            textoOfertasParaPersona(sinCriterios, { genero: 'femenino' }),
            '¿Inscribo a *Sofía* a la convocatoria? Es a *todas sus fechas*, en orden. Respóndeme *sí* y se lo paso a la escuela 🙌',
        ].join('\n\n'));
        expect(m.texto).toContain(DESC_MAYORES); // todas las de su género, como antes
        expect(m.texto).not.toContain(NOTA);
        expect(m.estado!.datos.ofertasMostradas).toBeUndefined();
        await c.turno('La del sábado 5 a las 9');
        expect(c.ctx.avisarEscuela).toHaveBeenLastCalledWith('inscripcion_oferta',
            'Interesado: Sofía Ramírez Peña (2014). Quiere inscribirse (convocatoria): «La del sábado 5 a las 9». Sede: Sede Norte.');
    });

    it('si el mensaje pasaría el tope de WhatsApp, la nota va aparte con la pregunta', async () => {
        const filas = filasMonster();
        filas.ofertas = filas.ofertas.map((o: any) => o.id === 'of-norte' ? { ...o, descripcion: `${DESC_NORTE}\n\n${'Texto largo de la escuela. '.repeat(60)}` } : o);
        const largo = armarEstado('monster', filas, DIC_3);
        const c = crear({ ofertas: largo });
        await nina2014(c);
        const [ofertas, nota] = c.s.enviados.slice(-2);
        expect(ofertas.step).toBe('embudo_ofertas');
        expect(ofertas.texto).toContain(DESC_SUBA);
        expect(ofertas.texto).not.toContain(NOTA);
        expect(ofertas.texto.length).toBeLessThanOrEqual(4096);
        expect(nota.texto).toBe(`${NOTA}\n\n¿Inscribo a *Sofía* a la convocatoria? Es a *todas sus fechas*, en orden. Respóndeme *sí* y se lo paso a la escuela 🙌`);
        expect(nota.estado).toMatchObject({ paso: 'elegir_oferta' });
    });

    it('los datos de la persona salen de lo que contó en el embudo', () => {
        const hoy = '2026-12-03';
        const opciones = [{ titulo: 'Estoy empezando' }, { titulo: 'Colegio o escuela' }, { titulo: 'Club y torneos' }];
        expect(trayectoriaDeTexto('Club y torneos', hoy, opciones)).toBe(true);
        expect(trayectoriaDeTexto('Estoy empezando', hoy, opciones)).toBe(false);
        expect(trayectoriaDeTexto('Colegio o escuela', hoy, opciones)).toBe(false);
        expect(trayectoriaDeTexto('Sí, claro', hoy)).toBe(true);
        expect(trayectoriaDeTexto('Nop', hoy)).toBe(false);
        expect(trayectoriaDeTexto('Titanes', hoy)).toBeNull();
        const preguntas = AJ_MONSTER.preguntasProspecto!;
        expect(datosDePersonaDeEmbudo({
            anio: 2011, genero: 'f', respuestas: { trayectoria: 'Club y torneos', trayectoria_detalle: 'Dos años en Titanes' },
        }, preguntas, AHORA)).toEqual({ anio: 2011, genero: 'femenino', trayectoria: true });
        // La fecha y el sexo en otras claves: se leen de su respuesta.
        const otras = [
            { clave: 'nacimiento', texto: '¿Fecha de nacimiento?', tipo: 'fecha' as const },
            { clave: 'genero_deportista', texto: '¿Género?', tipo: 'botones' as const, opciones: [{ titulo: 'Mujer' }, { titulo: 'Hombre' }] },
        ];
        expect(datosDePersonaDeEmbudo({ respuestas: { nacimiento: '1998-08-07', genero_deportista: 'Hombre' } }, otras, AHORA))
            .toEqual({ anio: 1998, genero: 'masculino', trayectoria: null });
    });
});
