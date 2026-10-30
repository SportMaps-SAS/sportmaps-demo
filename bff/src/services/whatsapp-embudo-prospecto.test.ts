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
    estadoParaRecordatorio, leadCompletoDeEmbudo, leadDeDatos,
    tituloDeGrupo, grupoDeRango,
    type CtxEmbudo, type EstadoEmbudo, type FranjaEmbudo, type RangoEmbudo, type CuentaDePagoEmbudo,
} from './whatsapp-embudo-prospecto';
import { BOTON_PUERTA } from './whatsapp-puerta-desconocido';
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

    it('pedir una persona suelta el embudo (lo escala el bot general)', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        expect(await c.turno('quiero hablar con un asesor')).toBe(false);
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
            '¡Listo! ✨ Por su año (2011) a Mariana le corresponde *Infantil Femenino* en la Sede Norte, con el profe Iván Sossa.\n' +
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
        expect(c.ultimo().texto).toContain('le corresponde *U15 Fem Proyección* en la Sede Suba, con el profe Sebastián Hurtado');
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
        expect(c.ctx.tomarCupo).toHaveBeenCalledWith('lead-1', 's-dom01');
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
        expect(c.ultimo().texto).toBe('¡Listo! 🙌 Para confirmarlo, paga la clase de prueba ($15.000) por Nequi o Daviplata al número 319 450 5150 ' +
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
            estado: { paso: 'agendada', datos: { leadId: 'lead-1', teamId: 't-infantil-fem', slotId: 's-sab31' } },
        });
        expect(await c.turno('Cambiar horario', 'Cambiar horario')).toBe(true);
        expect(c.ultimo().texto).toContain('No tienes que pagar de nuevo');
        expect(c.ultimo().botones!.map((b) => b.id)).not.toContain(`${BOTON_EMBUDO.FRANJA}s-sab31`);
        await c.turno('x', `${BOTON_EMBUDO.FRANJA}s-dom01`);
        expect(c.ctx.confirmarAgenda).toHaveBeenCalledWith({ leadId: 'lead-1', slotId: 's-dom01', evento: 'cambiada' });
        expect(c.ctx.registrarConceptoEsperado).not.toHaveBeenCalled();
        expect(c.ultimo().estado?.paso).toBe('agendada');
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
            .toBe('por Nequi o Daviplata al número 319 450 5150');
        expect(comoPagar([{ tipo: 'Nequi', numero: '3001112233', titular: 'Club' }, { tipo: 'Bancolombia', numero: '123-456' }]))
            .toBe('a una de estas cuentas:\n• Nequi: 3001112233 (a nombre de Club)\n• Bancolombia: 123-456\n');
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
