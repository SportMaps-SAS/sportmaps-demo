/**
 * Oleada 2 — el entrenador en la cancha: equipos_y_horarios, asistencia_de_sesion,
 * semana_del_equipo, registrar_asistencia, evaluar_entreno y felicitar.
 *
 * Corre la lógica REAL de la pantalla donde se puede (resolverFechaDeTrabajo,
 * findTeamSessionOfDay, pausedEnrollmentIds, semana-equipo.service, writeAudit)
 * sobre el supabase falso. Solo se simulan el guardado de la lista
 * (guardarSesionAsistencia, ya probado en attendance-register.service.test.ts)
 * y el cliente COMO LA PERSONA de las RPC (give_kudos y la evaluación).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const h = vi.hoisted(() => ({
    responder: (_c: any): any => undefined,
    guardar: vi.fn(),
    rpcUsuario: vi.fn(),
}));

vi.mock('../../config/supabase', async () => {
    const { crearSupabaseFalso } = await import('./supabase-falso.test-helper');
    const falso = crearSupabaseFalso((c) => h.responder(c));
    // Las RPC «como la persona» van por su _por con service_role (rpc-por.ts).
    (falso.supabase as any).rpc = (nombre: string, params: unknown) => h.rpcUsuario(nombre, params);
    (globalThis as any).__consultas = falso.consultas;
    return {
        supabase: falso.supabase, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba',
        SUPABASE_URL: 'http://supabase.local', SUPABASE_ANON_KEY: 'anon-de-prueba',
    };
});
vi.mock('../attendance-register.service', async (orig) => ({ ...(await orig() as any), guardarSesionAsistencia: h.guardar }));

import {
    HERRAMIENTAS_ENTRENADOR, equiposYHorarios, asistenciaDeSesion, semanaDelEquipo, registrarAsistencia, evaluarEntreno, felicitar,
    horarioBase, comoDesdeEffort,
} from './herramientas/entrenador';
import { limpiarCacheSemana } from '../semana-equipo.service';
import { RechazoHerramienta, type Alcance } from './tipos';

// ─── Escenario ──────────────────────────────────────────────────────────────

const ESCUELA = '11111111-1111-1111-1111-111111111111';
const SUB12 = '22222222-2222-2222-2222-222222222222';
const SUB14 = '33333333-3333-3333-3333-333333333333';
const MARIANA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const JUAN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SOFIA = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PEDRO = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const OTRO = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SESION = '44444444-4444-4444-4444-444444444444';
const TOKEN = 'Bearer token-de-la-persona';

const ajustes = { coachMapiAttendance: true, coachMapiNotices: true, coachHideFinancialInfo: false };
const admin: Alcance = { schoolId: ESCUELA, userId: 'u-admin', rol: 'admin', teamIds: [], ajustes, hoy: '2026-11-24' };
const coach: Alcance = { ...admin, rol: 'coach', userId: 'u-coach', teamIds: [SUB12] };
const conSesion = <T extends Alcance>(a: T) => ({ ...a, authorization: TOKEN });

const HORARIO = [
    { day: 2, time: '16:00', end: '17:30', place: 'Cancha 1' },
    { day: 4, time: '16:00', end: '17:30', place: 'Cancha 1' },
];

let db: Record<string, any[]>;

function base() {
    db = {
        teams: [
            { id: SUB12, school_id: ESCUELA, name: 'Sub-12', sport: 'Fútbol', age_group: 'Sub 12', schedule: HORARIO, active: true, status: 'active' },
            { id: SUB14, school_id: ESCUELA, name: 'Sub-14', sport: 'Fútbol', age_group: null, schedule: HORARIO, active: true, status: 'active' },
        ],
        enrollments: [
            enr('e1', { child_id: MARIANA }),
            enr('e2', { child_id: JUAN }),
            enr('e3', { user_id: SOFIA }),
            enr('e4', { unregistered_athlete_id: PEDRO }),
            enr('e9', { child_id: OTRO, team_id: SUB14 }),
        ],
        v_enrollment_pauses_effective: [],
        children: [{ id: MARIANA, full_name: 'Mariana López' }, { id: JUAN, full_name: 'Juan Pérez' }, { id: OTRO, full_name: 'Otro Niño' }],
        profiles: [{ id: SOFIA, full_name: 'Sofía Gómez' }],
        unregistered_athletes: [{ id: PEDRO, full_name: 'Pedro Ruiz' }],
        attendance_sessions: [],
        attendance_records: [],
        athlete_absence_notices: [],
        school_settings: [{ school_id: ESCUELA, coach_attendance_retro_days: 7 }],
        team_schedule_exceptions: [],
        training_sessions: [],
        school_staff: [{ id: 'staff-coach', coach_auth_id: 'u-coach', school_id: ESCUELA, status: 'active' }],
        team_coaches: [{ id: 'tc1', team_id: SUB12, coach_id: 'staff-coach' }],
        performance_entries: [],
        athlete_reports: [],
        athlete_kudos: [],
        school_athletes: [
            { id: MARIANA, school_id: ESCUELA, full_name: 'Mariana López', athlete_type: 'child', team_id: SUB12, enrolled_team_id: SUB12, team_name: 'Sub-12', is_active: true },
            { id: OTRO, school_id: ESCUELA, full_name: 'Otro Niño', athlete_type: 'child', team_id: SUB14, enrolled_team_id: SUB14, team_name: 'Sub-14', is_active: true },
        ],
    };
}

function enr(id: string, x: Record<string, unknown>) {
    return {
        id, school_id: ESCUELA, team_id: SUB12, status: 'active', child_id: null, user_id: null, unregistered_athlete_id: null,
        sessions_used: 0, secondary_sessions_used: 0, expires_at: null, offering_plans: null, ...x,
    };
}

/** Aplica eq / in / gte / lte / gt / lt sobre las columnas que la fila tiene. */
function filtrar(filas: any[], c: any): any[] {
    return filas.filter((f) => c.filtros.every(([tipo, col, val]: [string, string, any]) => {
        if (!(col in f)) return true;
        const v = f[col];
        if (tipo === 'eq') return String(v) === String(val);
        if (tipo === 'in') return (val as any[]).map(String).includes(String(v));
        if (tipo === 'gte') return String(v) >= String(val);
        if (tipo === 'lte') return String(v) <= String(val);
        if (tipo === 'gt') return String(v) > String(val);
        if (tipo === 'lt') return String(v) < String(val);
        return true;
    }));
}

const consultas = () => (globalThis as any).__consultas as any[];
const escrituras = () => consultas().filter((c) => c.op !== 'select');
const de = (tabla: string) => consultas().filter((c) => c.tabla === tabla);

beforeEach(() => {
    consultas().length = 0;
    limpiarCacheSemana();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T15:00:00Z')); // martes 24 de noviembre, 10:00 de Bogotá
    base();
    h.guardar.mockReset().mockResolvedValue({ ok: true, sessionId: SESION, date: '2026-11-24', creditOutcomes: {}, sesionCreada: true });
    h.rpcUsuario.mockReset().mockResolvedValue({ data: null, error: null });
    h.responder = (c) => {
        if (c.op === 'insert' || c.op === 'update') return { data: null };
        return { data: filtrar(db[c.tabla] ?? [], c) };
    };
});
afterAll(() => vi.useRealTimers());

// ─── Esquemas ───────────────────────────────────────────────────────────────

describe('esquemas (strict)', () => {
    it('todas las propiedades en required, sin propiedades extra, sin parámetro de escuela y descripciones cortas', () => {
        expect(HERRAMIENTAS_ENTRENADOR.map((x) => x.nombre)).toEqual([
            'equipos_y_horarios', 'asistencia_de_sesion', 'semana_del_equipo', 'registrar_asistencia', 'evaluar_entreno', 'felicitar',
        ]);
        for (const x of HERRAMIENTAS_ENTRENADOR) {
            expect(x.esquema.additionalProperties).toBe(false);
            expect([...x.esquema.required].sort()).toEqual(Object.keys(x.esquema.properties).sort());
            expect(Object.keys(x.esquema.properties).some((k) => /school|escuela/i.test(k))).toBe(false);
            expect(x.descripcion.length).toBeLessThan(360);
            expect(x.roles).toEqual(['admin', 'coach']);
        }
    });
});

// ─── equipos_y_horarios ─────────────────────────────────────────────────────

describe('equipos_y_horarios', () => {
    it('el coach solo ve sus equipos y nunca se lee el precio del equipo', async () => {
        const r: any = await equiposYHorarios.ejecutar(coach, {});
        expect(r.equipos.map((e: any) => e.nombre)).toEqual(['Sub-12']);
        const q = de('teams')[0];
        expect(q.filtros).toContainEqual(['in', 'id', [SUB12]]);
        expect(q.filtros).toContainEqual(['eq', 'school_id', ESCUELA]);
        expect(q.columnas).not.toMatch(/price/);
        expect(r.equipos[0]).toMatchObject({
            id: SUB12, horario: ['mar, jue 16:00–17:30 · Cancha 1'], sesiones_hoy: ['16:00–17:30 · Cancha 1'],
            sesiones_manana: [], lista_de_hoy: 'sin tomar', inscritos_activos: 4,
        });
    });

    it('admin: toda la escuela, con la cancelación de hoy, la lista cerrada y el plan del entreno', async () => {
        db.team_schedule_exceptions = [{ school_id: ESCUELA, team_id: SUB14, fecha: '2026-11-24', tipo: 'cancelada', hora_original: null }];
        db.attendance_sessions = [{ id: SESION, school_id: ESCUELA, team_id: SUB12, session_date: '2026-11-24', finalized: true, start_time: null }];
        db.training_sessions = [{ school_id: ESCUELA, team_id: SUB12, session_date: '2026-11-24', objectives: 'Pases cortos y presión', session_blocks: [{}, {}] }];
        const r: any = await equiposYHorarios.ejecutar(admin, {});
        const [sub12, sub14] = r.equipos;
        expect(sub12).toMatchObject({ lista_de_hoy: 'cerrada', plan_de_hoy: { objetivos: 'Pases cortos y presión', bloques: 2 } });
        expect(sub14).toMatchObject({ sesiones_hoy: [], canceladas_hoy: ['16:00'], lista_de_hoy: 'sin entreno hoy' });
        expect(escrituras()).toHaveLength(0);
    });

    it('coach sin equipos: lo dice sin consultar', async () => {
        const r: any = await equiposYHorarios.ejecutar({ ...coach, teamIds: [] }, {});
        expect(r).toEqual({ equipos: [], nota: 'No tienes equipos asignados en esta escuela.' });
    });
});

// ─── asistencia_de_sesion ───────────────────────────────────────────────────

describe('asistencia_de_sesion', () => {
    it('el coach no puede ver la lista de un equipo que no entrena (ni por id ni por nombre)', async () => {
        await expect(asistenciaDeSesion.ejecutar(coach, { equipo: SUB14 })).rejects.toThrow(/no está entre los que entrenas/);
        await expect(asistenciaDeSesion.ejecutar(coach, { equipo: 'sub 14' })).rejects.toThrow(/entre tus equipos/);
    });

    it('quién vino, quién faltó, quién avisó y quién quedó sin marca', async () => {
        db.attendance_sessions = [{ id: SESION, school_id: ESCUELA, team_id: SUB12, session_date: '2026-11-24', finalized: false, start_time: null }];
        db.attendance_records = [
            { session_id: SESION, school_id: ESCUELA, child_id: MARIANA, user_id: null, unregistered_athlete_id: null, status: 'present' },
            { session_id: SESION, school_id: ESCUELA, child_id: JUAN, user_id: null, unregistered_athlete_id: null, status: 'absent' },
            { session_id: SESION, school_id: ESCUELA, child_id: OTRO, user_id: null, unregistered_athlete_id: null, status: 'present' },
        ];
        db.athlete_absence_notices = [{ school_id: ESCUELA, absence_date: '2026-11-24', status: 'active', child_id: null, user_id: SOFIA, reason: 'cita_medica', source: 'whatsapp', note: 'dato privado' }];
        const r: any = await asistenciaDeSesion.ejecutar(coach, { equipo: 'sub12' });
        expect(r.lista).toBe('abierta');
        expect(r.resumen).toEqual({ vinieron: 1, tarde: 0, faltaron: 1, con_excusa: 0, sin_marca: 2, en_la_lista: 4 });
        expect(r.deportistas).toEqual([
            { id: `child:${JUAN}`, nombre: 'Juan Pérez', estado: 'Faltó' },
            { id: `child:${MARIANA}`, nombre: 'Mariana López', estado: 'Vino' },
            { id: `unregistered:${PEDRO}`, nombre: 'Pedro Ruiz', estado: 'sin marca' },
            { id: `adult:${SOFIA}`, nombre: 'Sofía Gómez', estado: 'sin marca', aviso: 'avisó la familia: cita medica' },
        ]);
        expect(r.marcados_que_ya_no_estan_en_el_equipo).toEqual([{ id: `child:${OTRO}`, nombre: 'Otro Niño', estado: 'Vino' }]);
        expect(JSON.stringify(r)).not.toContain('dato privado');
        // La nota de la familia ni se pide.
        expect(de('athlete_absence_notices')[0].columnas).not.toMatch(/note/);
    });
});

// ─── semana_del_equipo ──────────────────────────────────────────────────────

describe('semana_del_equipo', () => {
    it('siete días desde hoy con la sesión movida y el entreno extra', async () => {
        db.team_schedule_exceptions = [
            { school_id: ESCUELA, team_id: SUB12, fecha: '2026-11-26', tipo: 'movida', hora_original: '16:00:00', hora_inicio: '18:00:00' },
            { school_id: ESCUELA, team_id: SUB12, fecha: '2026-11-28', tipo: 'extra', hora_inicio: '09:00:00', hora_fin: '10:30:00', lugar: 'Parque' },
        ];
        const r: any = await semanaDelEquipo.ejecutar(coach, { equipo: SUB12 });
        expect(r.dias).toHaveLength(7);
        expect(r.dias[0]).toEqual({ fecha: 'martes 24 de noviembre de 2026', sesiones: ['16:00–17:30 · Cancha 1'] });
        expect(r.dias[2].sesiones).toEqual(['18:00–19:30 · Cancha 1 [movida, era a las 16:00]']);
        expect(r.dias[4].sesiones).toEqual(['09:00–10:30 · Parque [extra]']);
        expect(r.dias[6]).toEqual({ fecha: 'lunes 30 de noviembre de 2026', sesiones: [] });
    });

    it('el coach no ve la semana de otro equipo', async () => {
        await expect(semanaDelEquipo.ejecutar(coach, { equipo: SUB14 })).rejects.toThrow(RechazoHerramienta);
    });
});

// ─── registrar_asistencia ───────────────────────────────────────────────────

describe('registrar_asistencia', () => {
    const args = (x: Record<string, unknown> = {}) => registrarAsistencia.validar({
        equipo: 'Sub-12', fecha: null, presentes: [], ausentes: ['juan'], excusados: [], los_demas: 'presentes', ...x,
    });

    it('el coach sin «pasar lista por Mapi» no la tiene', async () => {
        const sinPermiso = { ...coach, ajustes: { ...ajustes, coachMapiAttendance: false } };
        expect(registrarAsistencia.habilitada!(sinPermiso)).toBe(false);
        expect(registrarAsistencia.habilitada!(coach)).toBe(true);
        expect(registrarAsistencia.habilitada!({ ...admin, ajustes: { ...ajustes, coachMapiAttendance: false } })).toBe(true);
        await expect(registrarAsistencia.preparar(sinPermiso, args())).rejects.toThrow(/no tiene habilitado/);
    });

    it('el coach no puede pasar lista de otro equipo', async () => {
        await expect(registrarAsistencia.preparar(coach, args({ equipo: SUB14 }))).rejects.toThrow(/no está entre los que entrenas/);
    });

    it('vista previa: «todos menos Juan», quien avisó queda con excusa, y no escribe nada', async () => {
        db.athlete_absence_notices = [{ school_id: ESCUELA, absence_date: '2026-11-24', status: 'active', child_id: null, user_id: SOFIA, reason: 'viaje', source: 'whatsapp' }];
        const p = await registrarAsistencia.preparar(coach, args());
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.titulo).toBe('Lista de Sub-12');
        expect(p.vista.lineas[0]).toBe('Martes 24 de noviembre de 2026');
        expect(p.vista.lineas[1]).toBe('Vinieron 2 · faltaron 1 · con excusa 1');
        expect(p.vista.lineas).toContain('Con excusa porque avisaron que no venían: Sofía Gómez.');
        expect(p.vista.detalle?.items).toEqual(['Juan Pérez · Faltó', 'Mariana López · Vino', 'Pedro Ruiz · Vino', 'Sofía Gómez · Excusa']);
        expect(p.args).toEqual({ equipo: SUB12, fecha: '2026-11-24', presentes: [], ausentes: [`child:${JUAN}`], excusados: [], los_demas: 'presentes' });
        expect(p.targetKey).toBe(`asistencia:${SUB12}:2026-11-24`);
        expect(escrituras()).toHaveLength(0);
        expect(h.guardar).not.toHaveBeenCalled();
    });

    it('lo ya marcado se respeta y la vista previa cuenta los créditos con la inscripción de la lista', async () => {
        db.attendance_sessions = [{ id: SESION, school_id: ESCUELA, team_id: SUB12, session_date: '2026-11-24', finalized: false, start_time: null }];
        db.attendance_records = [{ session_id: SESION, school_id: ESCUELA, child_id: JUAN, user_id: null, unregistered_athlete_id: null, status: 'present' }];
        db.enrollments[0].offering_plans = { name: 'Plan 8', max_sessions: 8, max_secondary_sessions: null };
        db.enrollments[0].sessions_used = 8; // Mariana sin clases
        db.enrollments[3].offering_plans = { name: 'Plan 8', max_sessions: 8, max_secondary_sessions: null };
        db.enrollments[3].sessions_used = 2; // Pedro con saldo
        const p = await registrarAsistencia.preparar(coach, args({ ausentes: [], presentes: ['Mariana', `unregistered:${PEDRO}`], los_demas: 'sin_cambios' }));
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.lineas).toContain('1 deportista ya tenía marca y no cambia.');
        expect(p.vista.lineas).toContain('1 deportista descuenta una clase de su plan (si tenía reserva ese día, se usa la reserva).');
        expect(p.vista.lineas).toContain('1 deportista no tiene clases disponibles o tiene el plan vencido: la asistencia queda igual y se le avisa a la familia.');
        expect(p.vista.lineas).toContain('Quien quede sin marca pasa a «Faltó» cuando se cierre la lista.');
        expect((p.huella as any).sesion).toBe(SESION);
        expect((p.huella as any).cambios.map((c: any[]) => c[0])).toEqual([`child:${MARIANA}`, `unregistered:${PEDRO}`]);
    });

    it('la ventana de la pantalla: ni futuro, ni más atrás de lo que dejó la escuela al coach', async () => {
        expect(await registrarAsistencia.preparar(coach, args({ fecha: '2026-11-25' }))).toMatchObject({ ok: false, motivo: expect.stringMatching(/todavía no llegó/) });
        expect(await registrarAsistencia.preparar(coach, args({ fecha: '2026-11-10' }))).toMatchObject({ ok: false, motivo: expect.stringMatching(/hasta 7 días atrás/) });
        const r = await registrarAsistencia.preparar(admin, args({ fecha: '2026-11-10' }));
        expect(r.ok && r.vista.lineas[0]).toBe('Martes 10 de noviembre de 2026 (día pasado)');
    });

    it('lista cerrada o con varios bloques: a la app', async () => {
        db.attendance_sessions = [{ id: SESION, school_id: ESCUELA, team_id: SUB12, session_date: '2026-11-24', finalized: true, start_time: null }];
        expect(await registrarAsistencia.preparar(coach, args())).toMatchObject({ ok: false, motivo: expect.stringMatching(/ya está cerrada/) });
        db.attendance_sessions = [
            { id: 's-a', school_id: ESCUELA, team_id: SUB12, session_date: '2026-11-24', finalized: false, start_time: '16:00' },
            { id: 's-b', school_id: ESCUELA, team_id: SUB12, session_date: '2026-11-24', finalized: false, start_time: '18:00' },
        ];
        expect(await registrarAsistencia.preparar(coach, args())).toMatchObject({ ok: false, motivo: expect.stringMatching(/varios bloques/) });
    });

    it('nombres que no están, repetidos o sin cambios: no adivina', async () => {
        await expect(registrarAsistencia.preparar(coach, args({ ausentes: ['Otro Niño'] }))).rejects.toThrow(/no está en la lista de Sub-12/);
        await expect(registrarAsistencia.preparar(coach, args({ presentes: ['juan'], ausentes: ['juan'] }))).rejects.toThrow(/dos listas/);
        db.attendance_sessions = [{ id: SESION, school_id: ESCUELA, team_id: SUB12, session_date: '2026-11-24', finalized: false, start_time: null }];
        db.attendance_records = [{ session_id: SESION, school_id: ESCUELA, child_id: JUAN, user_id: null, unregistered_athlete_id: null, status: 'absent' }];
        expect(await registrarAsistencia.preparar(coach, args({ los_demas: 'sin_cambios' }))).toMatchObject({ ok: false, motivo: expect.stringMatching(/ya está así/) });
    });

    it('ejecutar: el MISMO guardado de la pantalla, solo con los cambios y la inscripción de cada uno', async () => {
        const p = await registrarAsistencia.preparar(coach, args());
        if (!p.ok) throw new Error('debía preparar');
        h.guardar.mockResolvedValueOnce({ ok: true, sessionId: SESION, date: '2026-11-24', creditOutcomes: { [MARIANA]: 'no_credits' }, sesionCreada: true });
        const r = await registrarAsistencia.ejecutar(coach, p.args);
        expect(r.estado).toBe('executed');
        const llamada = h.guardar.mock.calls[0][0];
        expect(llamada).toMatchObject({ schoolId: ESCUELA, teamId: SUB12, date: '2026-11-24', esRetroactiva: false, markedBy: 'u-coach' });
        expect(llamada.records).toEqual(expect.arrayContaining([
            { childId: JUAN, userId: undefined, unregisteredAthleteId: undefined, status: 'absent', enrollmentId: 'e2', isSecondary: false },
            { childId: undefined, userId: SOFIA, unregisteredAthleteId: undefined, status: 'present', enrollmentId: 'e3', isSecondary: false },
            { childId: undefined, userId: undefined, unregisteredAthleteId: PEDRO, status: 'present', enrollmentId: 'e4', isSecondary: false },
        ]));
        expect(llamada.records).toHaveLength(4);
        expect(de('security_audit_log')).toHaveLength(0); // hoy no se audita
        expect(registrarAsistencia.mensajeResultado(r, p.args)).toBe(
            'Quedó guardada la lista de Sub-12 del martes 24 de noviembre de 2026: vinieron 3, faltaron 1. ' +
            '1 deportista no tenía clases disponibles en su plan: la asistencia quedó y se le avisó a la familia.');
    });

    it('un día pasado deja attendance_backdated, como el handler HTTP', async () => {
        const p = await registrarAsistencia.preparar(admin, args({ fecha: '2026-11-20' }));
        if (!p.ok) throw new Error('debía preparar');
        await registrarAsistencia.ejecutar(admin, p.args);
        expect(h.guardar.mock.calls[0][0]).toMatchObject({ date: '2026-11-20', esRetroactiva: true, markedBy: 'u-admin' });
        const audit = de('security_audit_log')[0];
        expect(audit.op).toBe('insert');
        expect(audit.datos).toMatchObject({ user_id: 'u-admin', action: 'attendance_backdated', target_table: 'attendance_sessions', target_id: SESION });
        expect(audit.datos.new_value).toMatchObject({ fecha_registrada: '2026-11-20', team_id: SUB12, registros: 4 });
    });

    it('si el servicio rechaza (p. ej. la cerraron en el instante), queda failed con su motivo', async () => {
        const p = await registrarAsistencia.preparar(coach, args());
        if (!p.ok) throw new Error('debía preparar');
        h.guardar.mockResolvedValueOnce({ ok: false, status: 409, body: { error: 'La sesión de hoy ya fue finalizada.' } });
        const r = await registrarAsistencia.ejecutar(coach, p.args);
        expect(r).toEqual({ estado: 'failed', resultado: { motivo: 'La sesión de hoy ya fue finalizada.' } });
        expect(registrarAsistencia.mensajeResultado(r, p.args)).toBe('No se guardó la lista. La sesión de hoy ya fue finalizada.');
    });
});

// ─── evaluar_entreno ────────────────────────────────────────────────────────

describe('evaluar_entreno', () => {
    const cerrada = () => {
        db.attendance_sessions = [{ id: SESION, school_id: ESCUELA, team_id: SUB12, session_date: '2026-11-24', finalized: true, start_time: null }];
        db.attendance_records = [
            { session_id: SESION, school_id: ESCUELA, child_id: MARIANA, user_id: null, unregistered_athlete_id: null, status: 'present' },
            { session_id: SESION, school_id: ESCUELA, child_id: JUAN, user_id: null, unregistered_athlete_id: null, status: 'late' },
            { session_id: SESION, school_id: ESCUELA, child_id: null, user_id: null, unregistered_athlete_id: PEDRO, status: 'present' },
            { session_id: SESION, school_id: ESCUELA, child_id: null, user_id: SOFIA, unregistered_athlete_id: null, status: 'absent' },
        ];
        db.performance_entries = [{ school_id: ESCUELA, context_type: 'session', context_id: SESION, metric_key: 'coach_effort_rating', subject_type: 'child', subject_id: JUAN, value: 90 }];
    };
    const args = (x: Record<string, unknown> = {}) => evaluarEntreno.validar({
        equipo: SUB12, fecha: null, bien: ['mariana'], le_costo: [], los_demas: 'normal', nota: null, ...x,
    });

    it('se ofrece con o sin JWT (WhatsApp): va por su _por a nombre del actor', () => {
        expect(evaluarEntreno.habilitada).toBeUndefined();
    });

    it('solo el entrenador asignado al equipo (team_coaches), igual que la RPC', async () => {
        cerrada();
        expect(await evaluarEntreno.preparar(conSesion(admin), args())).toMatchObject({ ok: false, motivo: expect.stringMatching(/Solo el entrenador asignado/) });
        await expect(evaluarEntreno.preparar(conSesion(coach), args({ equipo: SUB14 }))).rejects.toThrow(/no está entre los que entrenas/);
    });

    it('con la lista abierta no se evalúa', async () => {
        cerrada();
        db.attendance_sessions[0].finalized = false;
        expect(await evaluarEntreno.preparar(conSesion(coach), args())).toMatchObject({ ok: false, motivo: expect.stringMatching(/sigue abierta/) });
    });

    it('vista previa: solo los que vinieron y con cuenta; lo ya evaluado se respeta', async () => {
        cerrada();
        const p = await evaluarEntreno.preparar(conSesion(coach), args());
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.lineas[1]).toBe('Bien 2 · Normal 0 · Le costó 0');
        expect(p.vista.lineas).toContain('1 ficha sin cuenta no se evalúa (igual que en la app).');
        expect(p.vista.detalle?.items).toEqual(['Mariana López · Bien']);
        expect((p.huella as any).envios).toEqual([[`child:${MARIANA}`, 'bien', null]]);
        expect(escrituras()).toHaveLength(0);
        await expect(evaluarEntreno.preparar(conSesion(coach), args({ le_costo: ['Sofía'] }))).rejects.toThrow(/no figura entre los que vinieron/);
    });

    it('un informe del mes ya publicado no se toca', async () => {
        cerrada();
        db.athlete_reports = [{ school_id: ESCUELA, status: 'publicado', period_year: 2026, period_month: 11, subject_type: 'child', subject_id: JUAN }];
        expect(await evaluarEntreno.preparar(conSesion(coach), args({ bien: [], le_costo: ['juan'] })))
            .toMatchObject({ ok: false, motivo: expect.stringMatching(/Juan Pérez ya tiene publicado el informe de noviembre de 2026/) });
    });

    it('ejecutar: la _por de la RPC de la pantalla, a nombre del coach, solo con los cambios', async () => {
        cerrada();
        const p = await evaluarEntreno.preparar(conSesion(coach), args({ nota: 'Buen entreno' }));
        if (!p.ok) throw new Error('debía preparar');
        h.rpcUsuario.mockResolvedValueOnce({ data: { saved: 1, pending: 0 }, error: null });
        const r = await evaluarEntreno.ejecutar(conSesion(coach), p.args);
        expect(h.rpcUsuario).toHaveBeenCalledWith('submit_post_training_coach_rating_por', {
            p_actor: 'u-coach', p_session_id: SESION, p_ratings: [{ child_id: MARIANA, effort_pct: 90 }], p_coach_notes: 'Buen entreno',
        });
        expect(evaluarEntreno.mensajeResultado(r, p.args)).toBe(
            'Quedó guardada la evaluación del entreno de Sub-12 del martes 24 de noviembre de 2026 (1 deportista, con la nota para las familias).');
        expect(JSON.stringify(r)).not.toContain('token');
        expect(JSON.stringify(p.args)).not.toContain('token');
    });

    it('si la RPC rechaza, queda failed con el mensaje de la pantalla', async () => {
        cerrada();
        const p = await evaluarEntreno.preparar(conSesion(coach), args());
        if (!p.ok) throw new Error('debía preparar');
        h.rpcUsuario.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'No autorizado' } });
        const r = await evaluarEntreno.ejecutar(conSesion(coach), p.args);
        expect(r.estado).toBe('failed');
        expect(evaluarEntreno.mensajeResultado(r, p.args)).toMatch(/no figuras como entrenador de este equipo/);
    });

    it('comoDesdeEffort: la misma lectura que la V2', () => {
        expect([comoDesdeEffort(90), comoDesdeEffort(70), comoDesdeEffort(60), comoDesdeEffort(null)]).toEqual(['bien', 'normal', 'le_costo', null]);
    });
});

// ─── felicitar ──────────────────────────────────────────────────────────────

describe('felicitar', () => {
    const args = (x: Record<string, unknown> = {}) => felicitar.validar({ deportista: `child:${MARIANA}`, mensaje: 'Gran actitud hoy en el entreno.', ...x });

    it('se ofrece con o sin JWT; el mensaje tiene tope de 200', () => {
        expect(felicitar.habilitada).toBeUndefined();
        expect(() => felicitar.validar({ deportista: `child:${MARIANA}`, mensaje: 'x'.repeat(201) })).toThrow(RechazoHerramienta);
        expect(() => felicitar.validar({ deportista: `child:${MARIANA}`, mensaje: '   ' })).toThrow(RechazoHerramienta);
    });

    it('el coach no felicita a un deportista de otro equipo', async () => {
        await expect(felicitar.preparar(conSesion(coach), args({ deportista: `child:${OTRO}` }))).rejects.toThrow(/no está en los equipos que entrenas/);
    });

    it('vista previa sin escribir, y una sola por día', async () => {
        const p = await felicitar.preparar(conSesion(coach), args());
        expect(p).toMatchObject({ ok: true, targetKey: `felicitar:child:${MARIANA}` });
        if (p.ok) expect(p.vista.lineas).toEqual(['«Gran actitud hoy en el entreno.»', 'Le llega a su familia como notificación en la app.', 'Sale a tu nombre.']);
        expect(escrituras()).toHaveLength(0);
        db.athlete_kudos = [{ id: 'k1', school_id: ESCUELA, child_id: MARIANA, kudos_date: '2026-11-24' }];
        expect(await felicitar.preparar(conSesion(coach), args())).toMatchObject({ ok: false, motivo: expect.stringMatching(/ya recibió una felicitación hoy/) });
    });

    it('ejecutar: give_kudos_por a nombre del coach; el tope diario se explica', async () => {
        h.rpcUsuario.mockResolvedValueOnce({ data: 'k-nuevo', error: null });
        const r = await felicitar.ejecutar(conSesion(coach), args());
        expect(h.rpcUsuario).toHaveBeenCalledWith('give_kudos_por', {
            p_actor: 'u-coach', p_school_id: ESCUELA, p_child_id: MARIANA, p_athlete_user_id: null, p_unregistered_athlete_id: null, p_message: 'Gran actitud hoy en el entreno.',
        });
        expect(felicitar.mensajeResultado(r, args())).toBe('Se envió la felicitación a Mariana López.');

        h.rpcUsuario.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'KUDOS_DAILY_LIMIT' } });
        const r2 = await felicitar.ejecutar(conSesion(coach), args());
        expect(r2.estado).toBe('failed');
        expect(felicitar.mensajeResultado(r2, args())).toBe('No se envió la felicitación. Mariana López ya recibió una felicitación hoy. Mañana se puede otra vez.');
    });

    it('sin JWT (WhatsApp) igual llama la _por con el actor del alcance', async () => {
        h.rpcUsuario.mockResolvedValueOnce({ data: 'k-2', error: null });
        const r = await felicitar.ejecutar(coach, args());
        expect(r.estado).toBe('executed');
        expect(h.rpcUsuario).toHaveBeenCalledWith('give_kudos_por', expect.objectContaining({ p_actor: 'u-coach' }));
    });

    it('un actor sin rol en la escuela: lo dice la _por, en palabras', async () => {
        h.rpcUsuario.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'sin_permiso: no trabaja en esta escuela' } });
        const r = await felicitar.ejecutar(coach, args());
        expect(felicitar.mensajeResultado(r, args())).toMatch(/tu rol aquí no lo permite/);
    });
});

describe('horarioBase', () => {
    it('agrupa los días con la misma hora y lugar, semana de lunes a domingo', () => {
        expect(horarioBase([{ day: 0, time: '8:00', place: 'Parque' }, { day: 6, time: '08:00:00', place: 'Parque' }, { day: 9, time: '10:00' }]))
            .toEqual(['sáb, dom 08:00 · Parque']);
    });
});
