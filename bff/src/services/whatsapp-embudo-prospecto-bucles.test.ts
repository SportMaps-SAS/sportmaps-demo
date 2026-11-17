/**
 * Auditoría Monster 14–17 nov 2026: el embudo convertía todo texto libre en «Elige uno de los horarios de la lista 👇».
 *  - ✝️ …9598: «Ya te confirmo», «El día», «Que cuesta», «El mes», «Una pregunta», «Escuela de futbol», «???» → 6 listas, 4 dobles en el mismo segundo.
 *  - Mariana Rodríguez: «En horario solo en la mañana» y «Gracias» → la lista otra vez.
 *  - Laura: «21 y 22» (cupos de la clínica) → el embudo de clase de prueba.
 * El motor con un contexto falso, como whatsapp-auditoria-2026-11-16-embudo.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    iniciarEmbudo, atenderTurnoEmbudo, BOTON_EMBUDO, leerPreferenciaHoraria, esCortesiaSimple, pideEventoOServicio, leerDiasDelMes,
    type CtxEmbudo, type EstadoEmbudo, type FranjaEmbudo, type RangoEmbudo,
} from './whatsapp-embudo-prospecto';
import { ajustesDesdeFila, ajustesClasePruebaDesdeFila, type AjustesWhatsAppEscuela } from './whatsapp-ajustes-escuela.service';

const SUBA = '22222222-2222-4222-8222-222222222222';
const PREGUNTAS = [
    { clave: 'nombre', texto: '¿Cuál es el nombre completo del deportista?', tipo: 'texto' },
    { clave: 'fecha_nacimiento', texto: '¿Cuál es su fecha de nacimiento? (día/mes/año)', tipo: 'fecha' },
    { clave: 'sexo', texto: '¿Es hombre o mujer?', tipo: 'botones', opciones: ['Mujer', 'Hombre'] },
];
const aj = (): AjustesWhatsAppEscuela => ajustesDesdeFila({
    wa_modo_cortesia: 'clase', wa_bienvenida: '¡Hola! 👋', wa_botones_sede: [{ branch_id: SUBA, titulo: '⚫ Sede Suba' }],
    wa_preguntas_prospecto: PREGUNTAS, wa_modo_discreto: 'no', wa_temas_a_persona: null,
});
const CLASE = ajustesClasePruebaDesdeFila({ nombre_clase: 'prueba', trial_price: 15000, separar_horas: 24, dias_semana: [0, 6], avisar_entrenador: true });
// Domingo 15 de noviembre de 2026, 12:36 p. m. en Bogotá.
const AHORA = new Date('2026-11-15T17:36:00.000Z');
const FRANJAS_MIXTAS: FranjaEmbudo[] = [
    { id: 'sab21-m', fecha: '2026-11-21', horaInicio: '09:00', horaFin: '11:00', lugar: 'Pinar', cupos: 9 },
    { id: 'sab21-t', fecha: '2026-11-21', horaInicio: '15:00', horaFin: '17:00', lugar: 'Pinar', cupos: 9 },
    { id: 'dom22-m', fecha: '2026-11-22', horaInicio: '07:30', horaFin: '09:30', lugar: 'Fesan', cupos: 9 },
    { id: 'dom29-m', fecha: '2026-11-29', horaInicio: '07:30', horaFin: '09:30', lugar: 'Fesan', cupos: 9 },
];
const SOLO_MANANA = FRANJAS_MIXTAS.filter((f) => f.horaInicio < '12');
const GRUPO: RangoEmbudo = { teamId: 't-1', nombre: 'MIXTO MAYORES', branchId: SUBA, coachNombres: ['Tatiana Díaz'] };

interface Enviado { texto: string; step: string; estado: EstadoEmbudo | null }

function crear(franjas: FranjaEmbudo[] = FRANJAS_MIXTAS) {
    const s = { enviados: [] as Enviado[], estado: null as EstadoEmbudo | null, soltados: [] as EstadoEmbudo[] };
    const reloj = { t: AHORA.getTime() };
    const avisarEscuela = vi.fn(async () => {});
    const ctx: CtxEmbudo = {
        conversationId: 'conv-1', schoolId: 'monster', contactWaId: '573001112233',
        enviar: async (texto, step, estado) => { s.enviados.push({ texto, step, estado }); s.estado = estado; },
        ajustes: async () => aj(), clase: async () => CLASE,
        sedes: async () => [{ branchId: SUBA, nombre: 'Sede Suba', direccion: 'Calle 152' }],
        elegirGrupo: async () => ({ principal: GRUPO, candidatos: [], otraSede: null, motivo: null }),
        franjas: async () => franjas,
        guardarLead: vi.fn(async () => 'lead-1'),
        tomarCupo: vi.fn(async () => ({ estado: 'separada' as const, hasta: '2026-11-16T17:00:00.000Z' })),
        soltarCupo: vi.fn(async () => {}),
        cuentasDePago: async () => [{ tipo: 'Nequi', numero: '3194505150', titular: null }],
        registrarConceptoEsperado: vi.fn(async () => {}), registrarOptIn: vi.fn(async () => {}),
        confirmarAgenda: vi.fn(async () => ({ texto: 'Agendada 🎉', consentimientoPendiente: true })),
        avisarEscuela, leadDelContacto: async () => null,
        leerEstado: async () => s.estado,
        alSoltar: (e) => { s.soltados.push(e); },
        ahora: () => new Date(reloj.t),
    };
    return { ctx, s, reloj, avisarEscuela, turno: (t: string, b: string | null = null) => atenderTurnoEmbudo(ctx, t, b), ultimo: () => s.enviados[s.enviados.length - 1] };
}

async function hastaHorarios(c: ReturnType<typeof crear>) {
    await iniciarEmbudo(c.ctx);
    await c.turno('', `${BOTON_EMBUDO.SEDE}${SUBA}`);
    await c.turno('Sara Dayanna Gonzales Salazar');
    await c.turno('21 de junio 2009');
    await c.turno('Mujer');
    expect(c.s.estado?.paso).toBe('elegir_franja');
    c.reloj.t += 60_000; // el cliente tarda un minuto en escribir
}
const listas = (c: ReturnType<typeof crear>) => c.s.enviados.filter((e) => e.texto.includes('Estos son los próximos horarios')).length;

describe('lectores puros', () => {
    it('preferencia horaria: «solo en la mañana» sí; «mañana» (el día) no', () => {
        expect(leerPreferenciaHoraria('En horario solo en la mañana')).toBe('manana');
        expect(leerPreferenciaHoraria('por la tarde')).toBe('tarde');
        expect(leerPreferenciaHoraria('puede ser mañana')).toBeNull();
        expect(leerPreferenciaHoraria('El mes')).toBeNull();
    });
    it('cortesías', () => {
        for (const t of ['Gracias', 'ok', 'Ya te confirmo', 'Listo', '👍', 'Muchas gracias']) expect(esCortesiaSimple(t), t).toBe(true);
        for (const t of ['El día', 'Que cuesta', 'Mariana Rodríguez', 'Dom 22 nov']) expect(esCortesiaSimple(t), t).toBe(false);
    });
    it('eventos y servicios; días del mes', () => {
        expect(pideEventoOServicio('Quería saber si había cupos para la clínica')).toBe(true);
        expect(pideEventoOServicio('el vacacional')).toBe(true);
        expect(pideEventoOServicio('Sara Gómez')).toBe(false);
        expect(leerDiasDelMes('21 y 22')).toEqual([21, 22]);
        expect(leerDiasDelMes('el 22')).toEqual([22]);
        expect(leerDiasDelMes('Dom 22 de noviembre')).toEqual([22]);
        expect(leerDiasDelMes('tiene 13 años')).toEqual([]);
        expect(leerDiasDelMes('3')).toEqual([3]);
    });
});

describe('✝️ …9598: las frases reales no producen seis listas', () => {
    it('«Ya te confirmo» → una cortesía, sin lista; «El día» → recordatorio en texto; «El mes» → persona; en total ninguna lista repetida', async () => {
        const c = crear();
        await hastaHorarios(c);
        expect(listas(c)).toBe(1);
        await c.turno('Ya te confirmo');
        expect(listas(c)).toBe(1);
        expect(c.ultimo().texto).toContain('Con gusto');
        c.reloj.t += 20_000;
        await c.turno('El día'); // no es cortesía: primer intento → recordatorio en texto
        expect(listas(c)).toBe(1);
        expect(c.ultimo().texto).toContain('elige tu horario en la lista de arriba');
        c.reloj.t += 5_000;
        await c.turno('El mes'); // segundo intento → persona + aviso a la escuela
        expect(listas(c)).toBe(1);
        expect(c.ultimo().step).toBe('embudo_a_persona');
        expect(c.avisarEscuela).toHaveBeenCalledTimes(1);
    });

    it('«Que cuesta», «Una pregunta», «Escuela de futbol» y «???» se sueltan al bot (no mandan lista) y el paso sigue donde iba', async () => {
        for (const t of ['Que cuesta', 'Una pregunta', 'Escuela de futbol', '???']) {
            const c = crear();
            await hastaHorarios(c);
            const n = c.s.enviados.length;
            expect(await c.turno(t), t).toBe(false);
            expect(c.s.enviados, t).toHaveLength(n);
            expect(c.s.soltados.map((e) => e.paso), t).toEqual(['elegir_franja']);
        }
    });

    it('doble procesamiento del mismo turno: dos textos sin elección en el mismo segundo producen UNA sola respuesta', async () => {
        const c = crear();
        await hastaHorarios(c);
        c.reloj.t += 5_000;
        await c.turno('El día');
        const n = c.s.enviados.length;
        c.reloj.t += 300; // el mismo turno, 300 ms después
        expect(await c.turno('El día')).toBe(true);
        expect(c.s.enviados).toHaveLength(n);
        expect(c.avisarEscuela).not.toHaveBeenCalled();
    });

    it('justo después de mandar la lista, un texto libre no la repite ni cuenta intento', async () => {
        const c = crear();
        await iniciarEmbudo(c.ctx);
        await c.turno('', `${BOTON_EMBUDO.SEDE}${SUBA}`);
        await c.turno('Sara Dayanna Gonzales Salazar');
        await c.turno('21 de junio 2009');
        await c.turno('Mujer');
        const n = c.s.enviados.length;
        await c.turno('El día'); // mismo instante que la lista
        expect(c.s.enviados).toHaveLength(n);
        expect(listas(c)).toBe(1);
    });
});

describe('Mariana Rodríguez: preferencia y «Gracias»', () => {
    it('«En horario solo en la mañana» filtra la lista a los horarios de la mañana', async () => {
        const c = crear();
        await hastaHorarios(c);
        expect(await c.turno('En horario solo en la mañana')).toBe(true);
        expect(c.s.estado?.datos.preferencia).toBe('manana');
        expect(c.s.estado?.datos.lista).toEqual(SOLO_MANANA.map((f) => f.id));
        expect(c.ultimo().texto).toContain('Estos son los próximos horarios');
    });

    it('si no hay horarios de la tarde lo dice y muestra los que hay (una vez)', async () => {
        const c = crear(SOLO_MANANA);
        await hastaHorarios(c);
        await c.turno('Solo por la tarde');
        expect(c.ultimo().texto).toMatch(/Para la tarde no tengo horarios abiertos/);
        expect(c.s.estado?.datos.lista).toEqual(SOLO_MANANA.map((f) => f.id));
        expect(c.s.estado?.datos.preferencia).toBeNull();
    });

    it('«Gracias» después de la lista: se agradece una vez, sin lista; la segunda cortesía no manda nada', async () => {
        const c = crear();
        await hastaHorarios(c);
        await c.turno('En horario solo en la mañana');
        const antes = listas(c);
        c.reloj.t += 30_000;
        await c.turno('Gracias');
        expect(listas(c)).toBe(antes);
        expect(c.ultimo().texto).toContain('Con gusto');
        const n = c.s.enviados.length;
        c.reloj.t += 30_000;
        expect(await c.turno('Gracias')).toBe(true);
        expect(c.s.enviados).toHaveLength(n);
        // Y elegir sigue funcionando después de las cortesías.
        await c.turno('1');
        expect(c.s.estado?.datos.slotId).toBe('sab21-m');
    });
});

describe('Laura: cupos del 21 y 22 / clínica', () => {
    it('«21 y 22» en la lista muestra solo los horarios de esos días, sin empujar el resto', async () => {
        const c = crear();
        await hastaHorarios(c);
        await c.turno('21 y 22');
        expect(c.s.estado?.datos.lista).toEqual(['sab21-m', 'sab21-t', 'dom22-m']);
        expect(c.ultimo().texto).toContain('Para esos días tengo estos horarios');
    });

    it('«el 22» con un solo horario ese día lo toma', async () => {
        const c = crear();
        await hastaHorarios(c);
        await c.turno('el 22');
        expect(c.ctx.tomarCupo).toHaveBeenCalledWith('lead-1', 'dom22-m', expect.anything());
    });

    it('«Quería saber si había cupos para la clínica» no es del embudo: se suelta, en la lista y en la sede', async () => {
        const c = crear();
        await hastaHorarios(c);
        const n = c.s.enviados.length;
        expect(await c.turno('Quería saber si había cupos para la clínica')).toBe(false);
        expect(c.s.enviados).toHaveLength(n);
        const d = crear();
        await iniciarEmbudo(d.ctx);
        const m = d.s.enviados.length;
        expect(await d.turno('Hola quiero info del vacacional')).toBe(false);
        expect(d.s.enviados).toHaveLength(m);
    });
});
