/**
 * Auditoría de conversaciones reales de producción (8–16 nov 2026): el embudo del interesado.
 * El motor con un contexto falso, como whatsapp-embudo-prospecto.test.ts.
 *
 *  1. «Anoté a Zaudy… Sigamos con *Me Equivoqué De Sede*» / «¡Mucho gusto, Me!».
 *  2. «Me equivoqué de sede» / «otra sede» / «era Norte» es un cambio de sede, no un nombre.
 *  5. «Y son principiantes», «Que cuesta», «Oye una pregunta», «Tiene 13 años / Para la otra semana»
 *     → «Elige uno de los horarios de la lista 👇» seis veces en 4 minutos.
 *  8. «Dame información», «Horarios, costos» en la pregunta de la sede.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    iniciarEmbudo, atenderTurnoEmbudo, BOTON_EMBUDO, leerVarias, leerCambioDeSede, recordatorioDePasoEmbudo,
    type CtxEmbudo, type EstadoEmbudo, type FranjaEmbudo, type RangoEmbudo,
} from './whatsapp-embudo-prospecto';
import {
    ajustesDesdeFila, ajustesClasePruebaDesdeFila, type AjustesWhatsAppEscuela,
} from './whatsapp-ajustes-escuela.service';

const NORTE = '11111111-1111-4111-8111-111111111111';
const SUBA = '22222222-2222-4222-8222-222222222222';
const SUR = '33333333-3333-4333-8333-333333333333';

const PREGUNTAS = [
    { clave: 'nombre', texto: '¿Cuál es el nombre completo del deportista?', tipo: 'texto' },
    { clave: 'fecha_nacimiento', texto: '¿Cuál es su fecha de nacimiento? (día/mes/año)', tipo: 'fecha' },
    { clave: 'sexo', texto: '¿Es hombre o mujer?', tipo: 'botones', opciones: ['Mujer', 'Hombre'] },
];
const BOTONES_2 = [{ branch_id: NORTE, titulo: '🟡 Sede Norte' }, { branch_id: SUBA, titulo: '⚫ Sede Suba' }];
const aj = (botones: any[] = BOTONES_2): AjustesWhatsAppEscuela => ajustesDesdeFila({
    wa_modo_cortesia: 'clase', wa_bienvenida: '¡Hola! 👋 Bienvenid@ al club. ¿Cuál sede te queda más cerca?',
    wa_botones_sede: botones, wa_preguntas_prospecto: PREGUNTAS, wa_modo_discreto: 'no', wa_temas_a_persona: null,
});
const CLASE = ajustesClasePruebaDesdeFila({ nombre_clase: 'prueba', trial_price: 15000, separar_horas: 24, dias_semana: [0, 6], avisar_entrenador: true });
const SEDES = [
    { branchId: NORTE, nombre: 'Sede Norte', direccion: 'Calle 201 #67-12' },
    { branchId: SUBA, nombre: 'Sede Suba', direccion: 'Calle 152 #94A-67' },
    { branchId: SUR, nombre: 'Sede Sur', direccion: 'Carrera 30 #8-10' },
];
// Jueves 29 de octubre de 2026, 6:40 p. m. en Bogotá.
const AHORA = new Date('2026-10-29T23:40:00.000Z');
const FRANJAS: FranjaEmbudo[] = [
    { id: 's-sab31', fecha: '2026-10-31', horaInicio: '08:00', horaFin: '10:00', lugar: 'La Enseñanza', cupos: 5 },
    { id: 's-dom01', fecha: '2026-11-01', horaInicio: '08:00', horaFin: '10:00', lugar: 'La Enseñanza', cupos: 6 },
];
const GRUPO = (branchId: string): RangoEmbudo => ({ teamId: `t-${branchId.slice(0, 2)}`, nombre: 'INFANTIL FEMENINO', branchId, coachNombres: ['Iván Sossa'] });

interface Enviado { texto: string; step: string; estado: EstadoEmbudo | null; botones?: any[] }

function crear(op: { ajustes?: AjustesWhatsAppEscuela; estado?: EstadoEmbudo | null } = {}) {
    const s = { enviados: [] as Enviado[], estado: op.estado ?? null as EstadoEmbudo | null, soltados: [] as EstadoEmbudo[] };
    const reloj = { t: AHORA.getTime() };
    const avisarEscuela = vi.fn(async () => {});
    const ctx: CtxEmbudo = {
        conversationId: 'conv-1', schoolId: 'monster', contactWaId: '573001112233',
        enviar: async (texto, step, estado, botones) => { s.enviados.push({ texto, step, estado, botones }); s.estado = estado; },
        ajustes: async () => op.ajustes ?? aj(),
        clase: async () => CLASE,
        sedes: async (ids) => SEDES.filter((x) => ids.includes(x.branchId)),
        elegirGrupo: async (q) => ({ principal: GRUPO(q.branchId ?? NORTE), candidatos: [], otraSede: null, motivo: null }),
        franjas: async () => FRANJAS,
        guardarLead: vi.fn(async () => 'lead-1'),
        tomarCupo: vi.fn(async () => ({ estado: 'separada' as const, hasta: '2026-10-30T23:45:00.000Z' })),
        soltarCupo: vi.fn(async () => {}),
        cuentasDePago: async () => [{ tipo: 'Nequi', numero: '3194505150', titular: null }],
        registrarConceptoEsperado: vi.fn(async () => {}),
        registrarOptIn: vi.fn(async () => {}),
        confirmarAgenda: vi.fn(async () => ({ texto: 'Agendada 🎉', consentimientoPendiente: true })),
        avisarEscuela,
        leadDelContacto: async () => null,
        leerEstado: async () => s.estado,
        alSoltar: (e) => { s.soltados.push(e); },
        ahora: () => new Date(reloj.t),
    };
    return { ctx, s, avisarEscuela, reloj, turno: (t: string, b: string | null = null) => atenderTurnoEmbudo(ctx, t, b),
        ultimo: () => s.enviados[s.enviados.length - 1] };
}

async function hastaElNombre(c: ReturnType<typeof crear>, sede = NORTE) {
    await iniciarEmbudo(c.ctx);
    await c.turno('', `${BOTON_EMBUDO.SEDE}${sede}`);
    expect(c.s.estado).toMatchObject({ paso: 'pregunta', datos: { i: 0, branchId: sede } });
}
async function hastaHorarios(c: ReturnType<typeof crear>) {
    await hastaElNombre(c);
    await c.turno('Zaudy Martínez');
    await c.turno('14/03/2011');
    await c.turno('Mujer');
    expect(c.s.estado?.paso).toBe('elegir_franja');
}

describe('1 y 2. «Me equivoqué de sede» no es un nombre: es un cambio de sede', () => {
    it('el lector de respuestas no saca un nombre de una consulta', () => {
        const pendientes = aj().preguntasProspecto!;
        for (const t of ['Me equivoqué de sede', 'Que precios manejas', 'Cuánto vale la mensualidad', 'Quiero saber los horarios', 'Dame información']) {
            expect(leerVarias(t, pendientes, AHORA).nombre, t).toBeUndefined();
        }
        expect(leerVarias('Zaudy Martínez', pendientes, AHORA).nombre).toBe('Zaudy Martínez');
        expect(leerVarias('Mariana Gómez, 14/03/2011', pendientes, AHORA)).toMatchObject({ nombre: 'Mariana Gómez', anio: 2011 });
    });

    it('«Me equivoqué de sede» en la pregunta del nombre: cambia a la otra sede, sin «¡Mucho gusto, Me!»', async () => {
        const c = crear();
        await hastaElNombre(c);
        expect(await c.turno('Me equivoqué de sede')).toBe(true);
        expect(c.ultimo().texto).not.toMatch(/mucho gusto/i);
        expect(c.ultimo().texto).toBe('Listo, te cambio a la *Sede Suba* 🙌\n\n1️⃣ ¿Cuál es el nombre completo del deportista?');
        expect(c.s.estado).toMatchObject({ paso: 'pregunta', datos: { i: 0, branchId: SUBA, sedeTitulo: '⚫ Sede Suba' } });
        expect(c.s.estado?.datos.nombre).toBeUndefined();
    });

    it('la secuencia real: «Zaudy…» y después «Me equivoqué de sede» → conserva a Zaudy y no la toma como otro deportista', async () => {
        const c = crear();
        await hastaElNombre(c);
        await c.turno('Zaudy Martínez');
        expect(c.s.estado).toMatchObject({ paso: 'pregunta', datos: { i: 1, nombre: 'Zaudy Martínez' } });
        await c.turno('Me equivoqué de sede');
        expect(c.ultimo().texto).not.toMatch(/Anoté a|Sigamos con|Me Equivoqué/);
        expect(c.ultimo().texto).toContain('Listo, te cambio a la *Sede Suba* 🙌');
        // Conserva lo ya dado y sigue en la pregunta que tocaba (la fecha).
        expect(c.ultimo().texto).toContain('fecha de nacimiento');
        expect(c.s.estado).toMatchObject({ paso: 'pregunta', datos: { i: 1, nombre: 'Zaudy Martínez', branchId: SUBA } });
        expect(c.s.estado?.datos.respuestas?.otros_deportistas).toBeUndefined();
    });

    it('«era Norte» estando en Suba: vuelve a Norte conservando nombre y fecha', async () => {
        const c = crear();
        await hastaElNombre(c, SUBA);
        await c.turno('Zaudy Martínez');
        await c.turno('14/03/2011');
        await c.turno('era Norte');
        expect(c.ultimo().texto).toContain('Listo, te cambio a la *Sede Norte* 🙌');
        expect(c.s.estado).toMatchObject({ paso: 'pregunta', datos: { i: 2, nombre: 'Zaudy Martínez', anio: 2011, branchId: NORTE } });
    });

    it('con la lista de horarios en pantalla, «otra sede»: el grupo y los horarios se vuelven a calcular para la otra', async () => {
        const c = crear();
        await hastaHorarios(c);
        const antes = c.s.estado!.datos.teamId;
        await c.turno('mejor en la otra sede');
        expect(c.s.estado).toMatchObject({ paso: 'elegir_franja', datos: { branchId: SUBA, nombre: 'Zaudy Martínez' } });
        expect(c.s.estado!.datos.teamId).not.toBe(antes);
        expect(c.ultimo().texto).toContain('Listo, te cambio a la *Sede Suba* 🙌');
    });

    it('con tres sedes y sin decir cuál: pregunta la sede con las otras dos y conserva lo contestado', async () => {
        const c = crear({ ajustes: aj([...BOTONES_2, { branch_id: SUR, titulo: '🔵 Sede Sur' }]) });
        await hastaElNombre(c);
        await c.turno('Zaudy Martínez');
        await c.turno('me equivoqué de sede');
        expect(c.ultimo().texto).toBe('Sin problema 🙌 ¿Cuál sede prefieres?');
        expect((c.ultimo().botones ?? []).map((b: any) => b.id)).toEqual([`${BOTON_EMBUDO.SEDE}${SUBA}`, `${BOTON_EMBUDO.SEDE}${SUR}`]);
        expect(c.s.estado).toMatchObject({ paso: 'sede', datos: { nombre: 'Zaudy Martínez' } });
        await c.turno('', `${BOTON_EMBUDO.SEDE}${SUR}`);
        // Sigue con la fecha: el nombre no se vuelve a pedir.
        expect(c.ultimo().texto).toContain('fecha de nacimiento');
        expect(c.s.estado).toMatchObject({ paso: 'pregunta', datos: { i: 1, nombre: 'Zaudy Martínez', branchId: SUR } });
    });

    it('con el cupo ya separado, el cambio de sede lo hace una persona y el flujo no se toca', async () => {
        const c = crear();
        await hastaHorarios(c);
        await c.turno('', `${BOTON_EMBUDO.FRANJA}s-sab31`);
        const paso = c.s.estado!.paso;
        await c.turno('me equivoqué de sede');
        expect(c.ultimo().step).toBe('embudo_cambio_de_sede');
        expect(c.ultimo().texto).toContain('le pasé tu mensaje a la escuela para cambiarte de sede');
        expect(c.s.estado?.paso).toBe(paso);
        expect(c.avisarEscuela).toHaveBeenCalledWith('pide_persona', expect.stringContaining('Pide cambiar de sede'));
    });

    it('la regla: qué es y qué no es un cambio de sede', () => {
        const b = aj().botonesSede!;
        expect(leerCambioDeSede('Me equivoqué de sede', b, SEDES, NORTE)).toEqual({ branchId: SUBA });
        expect(leerCambioDeSede('otra sede', b, SEDES, NORTE)).toEqual({ branchId: SUBA });
        expect(leerCambioDeSede('era Norte', b, SEDES, SUBA)).toEqual({ branchId: NORTE });
        expect(leerCambioDeSede('no, mejor Suba', b, SEDES, NORTE)).toEqual({ branchId: SUBA });
        // Nombrar la sede en la que ya está, un nombre o una fecha no cambian nada.
        expect(leerCambioDeSede('era Norte', b, SEDES, NORTE)).toBeNull();
        expect(leerCambioDeSede('Zaudy Martínez', b, SEDES, NORTE)).toBeNull();
        expect(leerCambioDeSede('14/03/2011', b, SEDES, NORTE)).toBeNull();
        // En una pregunta de texto libre solo vale lo inequívoco.
        expect(leerCambioDeSede('entrenaba en otra sede del club', b, SEDES, NORTE, { estricto: true })).toBeNull();
        expect(leerCambioDeSede('me equivoqué de sede', b, SEDES, NORTE, { estricto: true })).toEqual({ branchId: SUBA });
    });
});

describe('5. lo que no es una elección no repite «Elige uno de los horarios de la lista 👇»', () => {
    it('las frases reales se sueltan para que las conteste el bot; el embudo no manda nada', async () => {
        for (const t of ['Y son principiantes', 'Que cuesta', 'Oye una pregunta', 'Tiene 13 años', 'Para la otra semana']) {
            const c = crear();
            await hastaHorarios(c);
            const n = c.s.enviados.length;
            expect(await c.turno(t), t).toBe(false);
            expect(c.s.enviados, t).toHaveLength(n);
            expect(c.s.soltados.map((e) => e.paso), t).toEqual(['elegir_franja']);
            // El paso queda donde iba: el número que elija después se toma.
            expect(await c.turno('1'), t).toBe(true);
            expect(c.s.estado?.datos.slotId, t).toBe('s-sab31');
        }
    });

    it('el recordatorio del paso: una vez, corto y sin volver a mandar la lista', async () => {
        const c = crear();
        await hastaHorarios(c);
        const rec = recordatorioDePasoEmbudo(aj(), c.s.estado!);
        expect(rec?.texto).toBe('Cuando quieras seguimos con tu registro 🙌 Elige tu horario en la lista de arriba 👆 o escríbeme su número.');
        expect(rec?.botones).toBeUndefined();
        expect(recordatorioDePasoEmbudo(aj(), { paso: 'elegir_franja', datos: { ...c.s.estado!.datos, recordado: rec!.clave } })).toBeNull();
    });

    it('en una pregunta, el recordatorio repite ESA pregunta con sus botones; en la siguiente vuelve a valer', () => {
        const estado: EstadoEmbudo = { paso: 'pregunta', datos: { i: 2, respuestas: { nombre: 'Zaudy', fecha_nacimiento: '2011-03-14' }, branchId: NORTE } };
        const rec = recordatorioDePasoEmbudo(aj(), estado)!;
        expect(rec.texto).toBe('Cuando quieras seguimos con tu registro 🙌\n\n3️⃣ ¿Es hombre o mujer?');
        expect((rec.botones ?? []).map((b) => b.title)).toEqual(['Mujer', 'Hombre']);
        expect(recordatorioDePasoEmbudo(aj(), { ...estado, datos: { ...estado.datos, recordado: rec.clave } })).toBeNull();
        expect(recordatorioDePasoEmbudo(aj(), { paso: 'pregunta', datos: { ...estado.datos, i: 1, recordado: rec.clave } })).not.toBeNull();
    });

    it('un texto suelto que no elige nada se recuerda en texto (sin repetir la lista); al segundo pasa a una persona', async () => {
        const c = crear();
        await hastaHorarios(c);
        c.reloj.t += 30_000;
        await c.turno('el día');
        expect(c.ultimo().texto).not.toContain('Estos son los próximos horarios');
        expect(c.ultimo().texto).toContain('elige tu horario en la lista de arriba');
        expect(c.s.estado).toMatchObject({ paso: 'elegir_franja', datos: { intentos: 1 } });
        c.reloj.t += 30_000;
        await c.turno('el mes');
        expect(c.ultimo().step).toBe('embudo_a_persona');
        expect(c.avisarEscuela).toHaveBeenCalledTimes(1);
        expect(c.s.enviados.filter((e) => e.texto.includes('Estos son los próximos horarios'))).toHaveLength(1);
    });
});

describe('8. una pregunta en la bienvenida (elegir sede) no recibe «Elige la sede…»', () => {
    it('«Dame información» y «Horarios, costos»: se sueltan para que las conteste el bot', async () => {
        for (const t of ['Dame información', 'Horarios, costos']) {
            const c = crear();
            await iniciarEmbudo(c.ctx);
            expect(c.s.estado?.paso).toBe('sede');
            const n = c.s.enviados.length;
            expect(await c.turno(t), t).toBe(false);
            expect(c.s.enviados, t).toHaveLength(n);
            expect(c.s.soltados.map((e) => e.paso), t).toEqual(['sede']);
        }
    });

    it('elegir la sede escribiéndola sigue funcionando', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        expect(await c.turno('la del norte')).toBe(true);
        expect(c.s.estado).toMatchObject({ paso: 'pregunta', datos: { branchId: NORTE } });
    });
});
