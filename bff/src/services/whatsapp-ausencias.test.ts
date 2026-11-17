/**
 * Mejora 5 — «Mi hija no puede ir hoy». Reglas puras + el turno con Supabase
 * mockeado (builder encadenable, mismo andamiaje que whatsapp-clase-cortesia-bot).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        resolve: (table: string, ops: Ops) => any;
        inserts: { table: string; row: any }[];
    } = { resolve: () => ({ data: null, error: null }), inserts: [] };
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'in', 'or', 'order', 'limit', 'is', 'not']) b[m] = chain(m);
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.maybeSingle = () => Promise.resolve(state.resolve(table, ops));
        b.single = () => Promise.resolve(state.resolve(table, ops));
        b.then = (res: any, rej: any) => Promise.resolve(state.resolve(table, ops)).then(res, rej);
        return b;
    }
    return { state, supabase: { from: (t: string) => makeBuilder(t) }, sendToUser: vi.fn() };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./push.service', () => ({ sendToUser: h.sendToUser }));

import {
    detectaAusencia, atletasNombrados, textoConfirmacion, leerBotonAusencia, botonesDeAusencia,
    ausenciaPendiente, atenderAusenciaEnBot, type CandidatoAusencia,
} from './whatsapp-ausencias.service';

// 2026-10-06 es martes.
const HOY = '2026-10-06';

describe('detectaAusencia', () => {
    it.each([
        ['mi hija no puede ir hoy', 'hoy', HOY, undefined],
        ['Juan no va a entrenar mañana, está enfermo', 'manana', '2026-10-07', 'enfermedad'],
        ['Buenas tardes, Sofía no podrá asistir hoy porque tiene cita médica', 'hoy', HOY, 'cita_medica'],
        ['hoy no lo puedo llevar', 'hoy', HOY, undefined],
        ['Milena, Sara no va a la clase, tiene fiebre', 'hoy', HOY, 'enfermedad'],
        ['El jueves no vamos, estamos de viaje', 'fecha', '2026-10-08', 'viaje'],
        ['pasado mañana no va a poder ir', 'fecha', '2026-10-08', undefined],
        ['no alcanza a llegar al entreno de hoy', 'hoy', HOY, undefined],
        ['Lo voy a excusar hoy, se lesionó el tobillo', 'hoy', HOY, 'lesion'],
    ])('«%s» → %s', (texto, dia, fecha, motivo) => {
        const a = detectaAusencia(texto, HOY);
        expect(a).not.toBeNull();
        expect(a!.dia).toBe(dia);
        expect(a!.fecha).toBe(fecha);
        expect(a!.motivo).toBe(motivo);
    });

    it('«esta mañana» es hoy, no mañana', () => {
        expect(detectaAusencia('Sofía no puede ir esta mañana', HOY)).toMatchObject({ dia: 'hoy', fecha: HOY });
    });

    it.each([
        'Hola, ¿hoy hay clase?',
        'En septiembre mi hija no asistió',
        'no sé si pueda ir hoy',
        'si no puede ir me avisa',
        'el pago no va a llegar hoy',
        'no puedo pagar hoy, mañana transfiero',
        'Te envío el comprobante, hoy no va',
        'gracias',
        'no va',
        '',
        // Dynasty 10-20: horario fijo y torneo con fecha no son la ausencia de hoy
        'Mile con respecto al comunicado Paula no puede ir yo le había comentado a Ricardo que la niña estudia inglés los sábados de 9am a 1pm, y no puede faltar, porque pierde el curso solo nos aceptan excusas medicas',
        'Mile es con respecto al torneo del 7 de noviembre, Paula no puede asistir',
        'ellas no pueden asistir el sábado 7 de noviembre',
        'Nury siguió mal de su mano, este mes no va a entrenar, no puede',
        'Te comento que durante dos meses Isabella no asiste a entreno por compromisos del colegio',
        // Monster 2026-11-17 (Raúl): salir de un grupo no es la ausencia de hoy.
        'Amigo buenos días. Cómo vamos? Amigo para avisarte que vamos a salir oa del grupo de  capacitaciones porque no alcanzamos a ir. Muchos éxitos con eso.',
        'Profe, nos retiramos del club porque no podemos ir',
    ])('NO dispara con «%s»', (texto) => {
        expect(detectaAusencia(texto, HOY)).toBeNull();
    });
});

const SOFIA: CandidatoAusencia = { clave: 'c:11111111-1111-1111-1111-111111111111', childId: '11111111-1111-1111-1111-111111111111', userId: null, nombre: 'SOFIA PEREZ', teamIds: ['t1'] };
const JUAN: CandidatoAusencia = { clave: 'c:22222222-2222-2222-2222-222222222222', childId: '22222222-2222-2222-2222-222222222222', userId: null, nombre: 'Juan Pérez', teamIds: ['t2'] };

describe('atletasNombrados', () => {
    it('por primer nombre, sin tildes ni mayúsculas', () => {
        expect(atletasNombrados('sofía no va hoy', [SOFIA, JUAN])).toEqual([SOFIA]);
    });
    it('«los dos» → todos', () => {
        expect(atletasNombrados('los dos', [SOFIA, JUAN])).toEqual([SOFIA, JUAN]);
    });
    it('número de la opción', () => {
        expect(atletasNombrados('2', [SOFIA, JUAN])).toEqual([JUAN]);
    });
    it('nadie nombrado', () => {
        expect(atletasNombrados('no puede ir hoy', [SOFIA, JUAN])).toEqual([]);
    });
    it('segundo nombre: «Paula» es «María Paula» (Dynasty 10-20)', () => {
        const MARIA_PAULA: CandidatoAusencia = { ...SOFIA, clave: 'c:3', nombre: 'MARIA PAULA GOMEZ' };
        expect(atletasNombrados('Paula no puede ir hoy', [MARIA_PAULA, JUAN])).toEqual([MARIA_PAULA]);
    });
    it('un apellido compartido no elige a nadie: se pregunta', () => {
        expect(atletasNombrados('los Pérez no van hoy', [SOFIA, JUAN])).toEqual([]);
    });
});

describe('mensajes y botones', () => {
    it('confirmación con deseo de mejoría', () => {
        expect(textoConfirmacion(['Sofia'], { dia: 'hoy', fecha: HOY, motivo: 'enfermedad' }, true))
            .toBe('Listo, le aviso al entrenador que Sofia no va hoy. ¡Que se mejore!');
    });
    it('plural y fecha explícita', () => {
        expect(textoConfirmacion(['Sofia', 'Juan'], { dia: 'fecha', fecha: '2026-10-08' }, true))
            .toBe('Listo, le aviso al entrenador que Sofia y Juan no van el jueves 8 de octubre.');
    });
    it('sin entrenador asignado', () => {
        expect(textoConfirmacion(['Sofia'], { dia: 'manana', fecha: '2026-10-07' }, false))
            .toContain('quedó registrado');
    });
    it('el id del botón ida y vuelta', () => {
        const [b] = botonesDeAusencia([SOFIA, JUAN], HOY)!;
        expect(b.title).toBe('Sofia');
        expect(leerBotonAusencia(b.id)).toEqual({ clave: SOFIA.clave, fecha: HOY });
        expect(leerBotonAusencia('sm_ver_pagos')).toBeNull();
    });
    it('más de 3 deportistas: sin botones (va en texto)', () => {
        expect(botonesDeAusencia([SOFIA, JUAN, SOFIA, JUAN], HOY)).toBeNull();
    });
});

describe('ausenciaPendiente', () => {
    const ahora = Date.parse('2026-10-06T15:00:00Z');
    it('encuentra el aviso de hace 5 min, no el mensaje actual', () => {
        const filas = [
            { wa_message_id: 'w2', direction: 'inbound', text_body: 'Sofía', wa_timestamp: '2026-10-06T15:00:00Z' },
            { wa_message_id: 'w1', direction: 'inbound', text_body: 'no puede ir hoy', wa_timestamp: '2026-10-06T14:55:00Z' },
        ];
        expect(ausenciaPendiente(filas, 'w2', HOY, ahora)).toMatchObject({ fecha: HOY });
    });
    it('vencido a los 30 min', () => {
        const filas = [{ wa_message_id: 'w1', direction: 'inbound', text_body: 'no puede ir hoy', wa_timestamp: '2026-10-06T14:00:00Z' }];
        expect(ausenciaPendiente(filas, 'w2', HOY, ahora)).toBeNull();
    });
});

// ─── El turno ────────────────────────────────────────────────────────────────

function datosFamilia(hijos: any[], inscripciones: any[], yaHay = false) {
    h.state.resolve = (table, ops) => {
        if (table === 'children') return { data: hijos, error: null };
        if (table === 'enrollments') return { data: inscripciones, error: null };
        if (table === 'athlete_absence_notices') {
            if (ops.some(([op]) => op === 'insert')) return { data: null, error: null };
            return { data: yaHay ? { id: 'x' } : null, error: null };
        }
        if (table === 'teams') return { data: [{ id: 't1', coach_id: 'staff1' }], error: null };
        if (table === 'team_coaches') return { data: [], error: null };
        if (table === 'school_staff') return { data: [{ coach_auth_id: 'coach-profile' }], error: null };
        if (table === 'school_members') return { data: [{ profile_id: 'milena' }], error: null };
        if (table === 'notifications') return { data: null, error: null };
        return { data: null, error: null };
    };
}

const turno = (texto: string, extra: Partial<Parameters<typeof atenderAusenciaEnBot>[0]> = {}) => ({
    schoolId: 'school', parentId: 'parent', conversationId: 'conv', waMessageId: 'w-actual',
    texto, rafaga: texto, botonId: null, recientes: [], ...extra,
});

describe('atenderAusenciaEnBot', () => {
    beforeEach(() => {
        h.state.inserts = [];
        h.sendToUser.mockReset();
        h.sendToUser.mockResolvedValue({ enabled: true, sent: 1, failed: 0, revoked: 0 });
    });

    it('un solo hijo: registra, avisa al coach (in-app + push) y a Milena (in-app), y confirma', async () => {
        datosFamilia([{ id: SOFIA.childId, full_name: 'SOFIA PEREZ', is_active: true }],
            [{ child_id: SOFIA.childId, user_id: null, team_id: 't1' }]);
        const enviar = vi.fn(async () => {});
        const ok = await atenderAusenciaEnBot(turno('mi hija no puede ir hoy, está con gripa'), enviar, HOY);
        expect(ok).toBe(true);
        const aviso = h.state.inserts.find((i) => i.table === 'athlete_absence_notices')!.row;
        expect(aviso).toMatchObject({ school_id: 'school', child_id: SOFIA.childId, absence_date: HOY, reason: 'enfermedad', source: 'whatsapp' });
        const notifs = h.state.inserts.find((i) => i.table === 'notifications')!.row as any[];
        expect(notifs.map((n) => n.user_id).sort()).toEqual(['coach-profile', 'milena']);
        expect(h.sendToUser).toHaveBeenCalledTimes(1);
        expect(h.sendToUser.mock.calls[0][0]).toBe('coach-profile');
        expect(enviar).toHaveBeenCalledWith('Listo, le aviso al entrenador que Sofia no va hoy. ¡Que se mejore!', 'ausencia_registrada');
        // Nada de créditos: no se escribe en enrollments ni en attendance_records.
        expect(h.state.inserts.some((i) => i.table === 'enrollments' || i.table === 'attendance_records')).toBe(false);
    });

    it('varios hijos sin nombrar: pregunta con botones y no registra', async () => {
        datosFamilia(
            [{ id: SOFIA.childId, full_name: 'SOFIA PEREZ', is_active: true }, { id: JUAN.childId, full_name: 'Juan Pérez', is_active: true }],
            [{ child_id: SOFIA.childId, team_id: 't1' }, { child_id: JUAN.childId, team_id: 't2' }]);
        const enviar = vi.fn(async () => {});
        expect(await atenderAusenciaEnBot(turno('no puede ir hoy'), enviar, HOY)).toBe(true);
        expect(h.state.inserts).toHaveLength(0);
        const [texto, paso, botones] = (enviar.mock.calls[0] as unknown) as [string, string, any[]];
        expect(paso).toBe('ausencia_quien');
        expect(texto).toContain('¿Quién no va hoy?');
        expect(botones.map((b) => b.title)).toEqual(['Juan', 'Sofia']);
    });

    it('varios hijos y nombra a uno: registra solo a ese', async () => {
        datosFamilia(
            [{ id: SOFIA.childId, full_name: 'SOFIA PEREZ', is_active: true }, { id: JUAN.childId, full_name: 'Juan Pérez', is_active: true }],
            [{ child_id: SOFIA.childId, team_id: 't1' }, { child_id: JUAN.childId, team_id: 't2' }]);
        const enviar = vi.fn(async () => {});
        await atenderAusenciaEnBot(turno('Juan no va a entrenar mañana, está enfermo'), enviar, HOY);
        const avisos = h.state.inserts.filter((i) => i.table === 'athlete_absence_notices');
        expect(avisos).toHaveLength(1);
        expect(avisos[0].row).toMatchObject({ child_id: JUAN.childId, absence_date: '2026-10-07' });
    });

    it('responde «Sofía» a la pregunta: usa el aviso pendiente del chat', async () => {
        datosFamilia(
            [{ id: SOFIA.childId, full_name: 'SOFIA PEREZ', is_active: true }, { id: JUAN.childId, full_name: 'Juan Pérez', is_active: true }],
            [{ child_id: SOFIA.childId, team_id: 't1' }, { child_id: JUAN.childId, team_id: 't2' }]);
        const enviar = vi.fn(async () => {});
        const recientes = [{ wa_message_id: 'w-antes', direction: 'inbound', text_body: 'mañana no puede ir',
            wa_timestamp: new Date(Date.now() - 5 * 60_000).toISOString() }];
        expect(await atenderAusenciaEnBot(turno('Sofía', { recientes }), enviar, HOY)).toBe(true);
        expect(h.state.inserts.find((i) => i.table === 'athlete_absence_notices')!.row)
            .toMatchObject({ child_id: SOFIA.childId, absence_date: '2026-10-07' });
    });

    it('botón tocado', async () => {
        datosFamilia(
            [{ id: SOFIA.childId, full_name: 'SOFIA PEREZ', is_active: true }, { id: JUAN.childId, full_name: 'Juan Pérez', is_active: true }],
            [{ child_id: SOFIA.childId, team_id: 't1' }, { child_id: JUAN.childId, team_id: 't2' }]);
        const enviar = vi.fn(async () => {});
        const botonId = `sm_ausencia:${JUAN.clave}:${HOY}`;
        expect(await atenderAusenciaEnBot(turno('Juan', { botonId }), enviar, HOY)).toBe(true);
        expect(h.state.inserts.find((i) => i.table === 'athlete_absence_notices')!.row).toMatchObject({ child_id: JUAN.childId });
    });

    it('segundo aviso del mismo día: confirma pero no repite el push', async () => {
        datosFamilia([{ id: SOFIA.childId, full_name: 'SOFIA PEREZ', is_active: true }],
            [{ child_id: SOFIA.childId, team_id: 't1' }], true);
        const enviar = vi.fn(async () => {});
        expect(await atenderAusenciaEnBot(turno('hoy no puede ir'), enviar, HOY)).toBe(true);
        expect(h.state.inserts).toHaveLength(0);
        expect(h.sendToUser).not.toHaveBeenCalled();
        expect(enviar).toHaveBeenCalledTimes(1);
    });

    it('sin deportista activo, sin familia identificada o sin aviso: suelta el turno', async () => {
        datosFamilia([], []);
        const enviar = vi.fn(async () => {});
        expect(await atenderAusenciaEnBot(turno('no puede ir hoy'), enviar, HOY)).toBe(false);
        expect(await atenderAusenciaEnBot(turno('no puede ir hoy', { parentId: null }), enviar, HOY)).toBe(false);
        expect(await atenderAusenciaEnBot(turno('¿cuánto debo?'), enviar, HOY)).toBe(false);
        expect(enviar).not.toHaveBeenCalled();
    });
});
