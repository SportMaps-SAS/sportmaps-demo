/**
 * Herramientas del módulo ESCUELA (oleada 3): permisos, alcance de escuela,
 * vista previa sin efectos y ejecución sobre el MISMO servicio o RPC de la pantalla.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    responder: (_c: any): any => undefined,
    rpc: vi.fn(),
    crear: vi.fn(),
    pvPlan: vi.fn(),
    nivel: vi.fn(),
    grupo: vi.fn(),
    preview: vi.fn(),
    create: vi.fn(),
    pertenencia: vi.fn(),
    recientes: vi.fn(),
}));

vi.mock('../../config/supabase', async () => {
    const { crearSupabaseFalso } = await import('./supabase-falso.test-helper');
    const falso = crearSupabaseFalso((c) => h.responder(c));
    // Las RPC van por su _por con service_role (rpc-por.ts): se ven en h.rpc.
    (falso.supabase as any).rpc = (nombre: string, params: unknown) => h.rpc(nombre, params);
    (globalThis as any).__consultas = falso.consultas;
    return { supabase: falso.supabase, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave', supabaseAnonKey: 'anon', SUPABASE_URL: 'http://supabase.local', SUPABASE_ANON_KEY: 'anon' };
});
vi.mock('../../routes/enrollments', () => ({ crearInscripcion: h.crear }));
vi.mock('../planChange.service', () => ({ previewPlanChange: h.pvPlan }));
vi.mock('../../middlewares/assertSchoolFinanceAdmin', () => ({ nivelFinanzasEnEscuela: h.nivel }));
vi.mock('../charge-batches.service', async (original) => ({
    ...(await original<typeof import('../charge-batches.service')>()),
    atletasDelGrupo: h.grupo, previewChargeBatch: h.preview, createChargeBatch: h.create, verificarPertenencia: h.pertenencia,
}));
vi.mock('../cobro-duplicado-reciente', async (original) => ({
    ...(await original<typeof import('../cobro-duplicado-reciente')>()),
    buscarCobroDuplicadoReciente: h.recientes,
}));

import {
    HERRAMIENTAS_ESCUELA, pausarInscripcion, reactivarInscripcion, darDeBaja, cambiarPlan, crearCobroUnico,
    errorDeMeses, idDeOperacion, resumenDeVistaPrevia,
} from './herramientas/escuela';
import { CobrosError } from '../charge-batches.service';
import type { Alcance, Herramienta } from './tipos';

// UUID v4 de verdad: el esquema del modal de cobros (zod .uuid()) rechaza los de relleno.
const ESCUELA = '11111111-1111-4111-8111-111111111111';
const OTRA = '99999999-9999-4999-8999-999999999999';
const NINA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NINO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EQUIPO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const P1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const P2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const admin: Alcance = {
    schoolId: ESCUELA, userId: 'u-admin', rol: 'admin', teamIds: [],
    ajustes: { coachMapiAttendance: true, coachMapiNotices: true, coachHideFinancialInfo: false },
    hoy: '2026-11-24', authorization: 'Bearer jwt-de-la-persona',
};
const coach: Alcance = { ...admin, rol: 'coach', userId: 'u-coach', teamIds: [EQUIPO] };
/** Por WhatsApp no hay JWT: el alcance llega sin authorization. */
const sinSesion: Alcance = { ...admin, authorization: null };

const fila = { id: NINA, full_name: 'Mariana López', athlete_type: 'child', team_id: EQUIPO, enrolled_team_id: EQUIPO, team_name: 'Tiburones', is_active: true, parent_id: 'p1', user_id: null };
const consultas = () => (globalThis as any).__consultas as any[];
const eq = (c: any, col: string) => c.filtros.find(([t, k]: any) => t === 'eq' && k === col)?.[2];
const escrituras = () => consultas().filter((c) => c.op !== 'select');

let est: {
    atleta: any; inscripciones: any[]; pausa: boolean; solicitud: any; cobros: any[]; planes: any[]; equipos: any[];
};

beforeEach(() => {
    consultas().length = 0;
    est = {
        atleta: fila,
        inscripciones: [{ id: 'e1', status: 'active', team_id: EQUIPO, offering_plan_id: P1, paused_reason: null, pause_request_id: null }],
        pausa: true,
        solicitud: null,
        cobros: [],
        planes: [{ id: P1, name: 'Básico', price: 100000 }, { id: P2, name: 'Pro', price: 150000 }],
        equipos: [{ id: EQUIPO, name: 'Tiburones' }],
    };
    h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
    h.crear.mockReset();
    h.pvPlan.mockReset().mockResolvedValue({ applies: false, needs_choice: false });
    h.nivel.mockReset().mockResolvedValue('admin');
    h.grupo.mockReset();
    h.preview.mockReset();
    h.create.mockReset();
    h.pertenencia.mockReset().mockResolvedValue(undefined);
    h.recientes.mockReset().mockResolvedValue([]);
    h.responder = (c) => {
        const deLaEscuela = eq(c, 'school_id') === ESCUELA;
        if (c.tabla === 'school_athletes') return { data: deLaEscuela && eq(c, 'id') === est.atleta.id ? [est.atleta] : [] };
        if (c.tabla === 'enrollments') return { data: deLaEscuela ? est.inscripciones : [] };
        if (c.tabla === 'school_settings') return { data: deLaEscuela ? [{ pause_enabled: est.pausa }] : [] };
        if (c.tabla === 'enrollment_pause_requests') return { data: est.solicitud ? [est.solicitud] : [] };
        if (c.tabla === 'payments') return { data: deLaEscuela ? est.cobros : [] };
        if (c.tabla === 'offering_plans') {
            const id = eq(c, 'id');
            const ids = c.filtros.find(([t, k]: any) => t === 'in' && k === 'id')?.[2] as string[] | undefined;
            return { data: est.planes.filter((p) => (!id || p.id === id) && (!ids || ids.includes(p.id))) };
        }
        if (c.tabla === 'teams') return { data: est.equipos.filter((t) => !eq(c, 'id') || t.id === eq(c, 'id')) };
        return undefined;
    };
});

afterEach(() => {
    delete process.env.MAPI_COBROS_UNICOS;
    delete process.env.MAPI_CAMBIAR_PLAN;
});

/** Lo mismo que registro.disponiblePara: rol + flag. */
const ofrecida = (t: Herramienta, a: Alcance) => t.roles.includes(a.rol) && (t.habilitada ? t.habilitada(a) : true);

describe('permisos y esquemas', () => {
    it('ninguna se le ofrece al entrenador y todas son de administración', () => {
        process.env.MAPI_COBROS_UNICOS = 'true';
        process.env.MAPI_CAMBIAR_PLAN = 'true';
        for (const t of HERRAMIENTAS_ESCUELA) {
            expect(t.roles).toEqual(['admin']);
            expect(ofrecida(t, coach)).toBe(false);
            expect(ofrecida(t, admin)).toBe(true);
        }
    });

    it('pausa, reactivación y baja se ofrecen también sin JWT (WhatsApp): van por su _por a nombre del actor', () => {
        for (const t of [pausarInscripcion, reactivarInscripcion, darDeBaja]) expect(ofrecida(t, sinSesion)).toBe(true);
    });

    it('cambiar_plan y crear_cobro_unico nacen apagadas', () => {
        expect(ofrecida(cambiarPlan, admin)).toBe(false);
        expect(ofrecida(crearCobroUnico, admin)).toBe(false);
        process.env.MAPI_CAMBIAR_PLAN = 'true';
        process.env.MAPI_COBROS_UNICOS = 'true';
        expect(ofrecida(cambiarPlan, admin)).toBe(true);
        expect(ofrecida(crearCobroUnico, admin)).toBe(true);
    });

    it('un coach que llega igual a preparar es rechazado adentro', async () => {
        const args: [Herramienta, unknown][] = [
            [pausarInscripcion, { deportista: `child:${NINA}`, desde: '2026-12', hasta: '2026-12', motivo: 'vacaciones', nota: null }],
            [reactivarInscripcion, { deportista: `child:${NINA}`, nota: null }],
            [darDeBaja, { deportista: `child:${NINA}`, motivo: 'se mudó' }],
            [cambiarPlan, { deportista: `child:${NINA}`, plan: P2, cobro: null }],
            [crearCobroUnico, { deportistas: null, equipo: EQUIPO, categoria: 'torneo', concepto: 'Copa', monto: 50000, vence: '2099-12-31', avisar_familias: false }],
        ];
        for (const [t, a] of args) {
            if (t.tipo !== 'accion') continue;
            await expect(t.preparar(coach, t.validar(a))).rejects.toThrow(/administración/);
        }
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('esquemas strict: todo en required y sin propiedades extra, sin parámetro de escuela', () => {
        for (const t of HERRAMIENTAS_ESCUELA) {
            expect(t.esquema.additionalProperties).toBe(false);
            expect([...t.esquema.required].sort()).toEqual(Object.keys(t.esquema.properties).sort());
            expect(Object.keys(t.esquema.properties).some((k) => /school|escuela/.test(k))).toBe(false);
        }
    });
});

describe('pausar_inscripcion', () => {
    const args = { deportista: `child:${NINA}`, desde: '2026-12', hasta: '2027-01', motivo: 'vacaciones' as const, nota: null };

    it('reglas de meses del diálogo', () => {
        expect(errorDeMeses('2026-11-24', '2026-11', '2026-11')).toBeNull();
        expect(errorDeMeses('2026-11-24', '2026-10', '2026-11')).toMatch(/ya pasó/);
        expect(errorDeMeses('2026-11-24', '2026-12', '2026-11')).toMatch(/anterior/);
        expect(errorDeMeses('2026-11-24', '2026-11', '2027-11')).toMatch(/12 meses/);
        expect(errorDeMeses('2026-11-24', '12/2026', '2026-12')).toMatch(/AAAA-MM/);
    });

    it('con la pausa apagada en la escuela, Mapi tampoco la ofrece', async () => {
        est.pausa = false;
        expect(await pausarInscripcion.preparar(admin, args)).toMatchObject({ ok: false, motivo: expect.stringMatching(/no está activa/) });
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('la vista previa sale de preview_enrollment_pause_por a nombre del actor y no escribe nada', async () => {
        h.rpc.mockResolvedValue({ data: { meses: ['12/2026', '01/2027'], payments_a_anular: 2, payments_ambiguos: 1 }, error: null });
        const p = await pausarInscripcion.preparar(admin, args);
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(h.rpc).toHaveBeenCalledWith('preview_enrollment_pause_por', { p_actor: 'u-admin', p_enrollment_id: 'e1', p_month_from: '2026-12-01', p_month_to: '2027-01-01' });
        expect(p.vista.titulo).toBe('Pausar a Mariana López');
        expect(p.vista.lineas[0]).toBe('Diciembre de 2026 a enero de 2027 · 2 meses sin cobro');
        expect(p.vista.lineas.join(' ')).toContain('Se anulan 2 cobros pendientes');
        expect(p.vista.lineas.join(' ')).toContain('1 cobro de esos meses sin categoría clara');
        expect(p.targetKey).toBe(`pausa:child:${NINA}`);
        expect(escrituras()).toEqual([]);
    });

    it('si ya está en pausa no hay nada que confirmar', async () => {
        est.inscripciones[0].paused_reason = 'vacation';
        expect(await pausarInscripcion.preparar(admin, args)).toMatchObject({ ok: false, motivo: expect.stringMatching(/ya está en pausa/) });
    });

    it('ejecutar llama pause_enrollment_directly_por a nombre del admin', async () => {
        h.rpc.mockResolvedValue({ data: { meses_pausados: 2, payments_cancelled: 2, payments_ambiguos: 0 }, error: null });
        const r = await pausarInscripcion.ejecutar(admin, { ...args, nota: 'viaje a la costa' });
        expect(h.rpc).toHaveBeenCalledWith('pause_enrollment_directly_por', {
            p_actor: 'u-admin', p_enrollment_id: 'e1', p_reason: 'vacation', p_month_from: '2026-12-01', p_month_to: '2027-01-01', p_note: 'viaje a la costa',
        });
        expect(r.estado).toBe('executed');
        expect(pausarInscripcion.mensajeResultado(r, args)).toBe(
            'Mariana López quedó en pausa (diciembre de 2026 a enero de 2027): no se cobran 2 meses. Se anularon 2 cobros pendientes.');
    });

    it('el error de la RPC vuelve en palabras de la persona', async () => {
        h.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'La pausa supera el máximo de meses de la escuela.' } });
        const r = await pausarInscripcion.ejecutar(admin, args);
        expect(r).toMatchObject({ estado: 'failed', resultado: { motivo: 'La pausa supera el máximo de meses de la escuela.' } });
    });
});

describe('reactivar_inscripcion', () => {
    const args = { deportista: `child:${NINA}`, nota: null };

    it('si no está en pausa, lo dice', async () => {
        expect(await reactivarInscripcion.preparar(admin, args)).toMatchObject({ ok: false, motivo: 'Mariana López no está en pausa.' });
    });

    it('la vista previa avisa que el mes en curso sigue sin cobro', async () => {
        est.inscripciones[0] = { ...est.inscripciones[0], paused_reason: 'vacation', pause_request_id: 'pr1' };
        est.solicitud = { month_from: '2026-11-01', month_to: '2026-12-01' };
        const p = await reactivarInscripcion.preparar(admin, args);
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.lineas.join(' ')).toContain('Estaba en pausa: noviembre de 2026 a diciembre de 2026.');
        expect(p.vista.lineas.join(' ')).toContain('Noviembre de 2026 sigue sin cobro');
        expect(escrituras()).toEqual([]);
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('ejecutar llama resume_enrollment_por', async () => {
        est.inscripciones[0] = { ...est.inscripciones[0], paused_reason: 'vacation', pause_request_id: 'pr1' };
        h.rpc.mockResolvedValue({ data: { days_extended: 5, mes_en_curso_sin_cobro: true }, error: null });
        const r = await reactivarInscripcion.ejecutar(admin, args);
        expect(h.rpc).toHaveBeenCalledWith('resume_enrollment_por', { p_actor: 'u-admin', p_enrollment_id: 'e1', p_note: null });
        expect(reactivarInscripcion.mensajeResultado(r, args)).toBe(
            'Mariana López volvió de la pausa: aparece en la lista de asistencia desde hoy. Se le corrió la vigencia 5 días. El mes en curso sigue sin cobro; si hay que cobrarlo, se registra a mano.');
    });
});

describe('dar_de_baja', () => {
    const args = { deportista: `child:${NINA}`, motivo: 'se mudó de ciudad' };

    it('la vista previa dice qué cobros pendientes se anulan, sin escribir', async () => {
        est.cobros = [
            { id: 'c2', concept: 'Mensualidad noviembre', amount: 120000, amount_paid: 0, status: 'overdue', period_year: 2026, period_month: 11 },
            { id: 'c1', concept: 'Torneo', amount: 50000, amount_paid: 10000, status: 'awaiting_approval', due_date: '2026-12-05' },
        ];
        const p = await darDeBaja.preparar(admin, args);
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.lineas[0]).toBe('Se cancela su inscripción en Tiburones y deja de generar mensualidades.');
        expect(p.vista.lineas[1]).toBe('Se anulan 2 cobros pendientes por $160.000.');
        expect(p.vista.aviso).toMatch(/No se borra/);
        expect(p.vista.detalle?.items).toEqual(['Torneo · diciembre de 2026 · $40.000', 'Mensualidad noviembre · noviembre de 2026 · $120.000']);
        // Los mismos estados que anula set_school_athlete_status, filtrado por la escuela de la sesión.
        const leida = consultas().find((c) => c.tabla === 'payments');
        expect(eq(leida, 'school_id')).toBe(ESCUELA);
        expect(leida.filtros).toContainEqual(['in', 'status', ['pending', 'awaiting_approval', 'overdue']]);
        expect(escrituras()).toEqual([]);
    });

    it('un deportista de otra escuela no se encuentra (la escuela es la de la sesión)', async () => {
        await expect(darDeBaja.preparar({ ...admin, schoolId: OTRA }, args)).rejects.toThrow(/No encontré/);
        await expect(darDeBaja.ejecutar({ ...admin, schoolId: OTRA }, args)).rejects.toThrow(/No encontré/);
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('un deportista ya inactivo no se da de baja otra vez', async () => {
        est.atleta = { ...fila, is_active: false };
        expect(await darDeBaja.preparar(admin, args)).toMatchObject({ ok: false, motivo: 'Mariana López ya está inactivo.' });
    });

    it('ejecutar llama set_school_athlete_status_por con la escuela de la sesión y el actor', async () => {
        h.rpc.mockResolvedValue({ data: { enrollments_cancelled: 1, payments_cancelled: 2, invitations_cancelled: 1 }, error: null });
        const r = await darDeBaja.ejecutar(admin, args);
        expect(h.rpc).toHaveBeenCalledWith('set_school_athlete_status_por', { p_actor: 'u-admin', p_school_id: ESCUELA, p_athlete_type: 'child', p_athlete_id: NINA, p_active: false });
        expect(darDeBaja.mensajeResultado(r, args)).toBe(
            'Mariana López quedó inactivo: se canceló su plan y se anularon 2 cobros pendientes. Se canceló la invitación pendiente al acudiente. Para volver a activarlo: Alumnos > Inactivos.');
    });

    it('sin JWT (WhatsApp) igual se llama la _por con el actor del alcance', async () => {
        h.rpc.mockResolvedValue({ data: { enrollments_cancelled: 1, payments_cancelled: 0, invitations_cancelled: 0 }, error: null });
        const r = await darDeBaja.ejecutar(sinSesion, args);
        expect(r.estado).toBe('executed');
        expect(h.rpc).toHaveBeenCalledWith('set_school_athlete_status_por', expect.objectContaining({ p_actor: 'u-admin', p_school_id: ESCUELA }));
    });

    it('la base dice que el actor no administra esa escuela: lo dice en palabras', async () => {
        h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'sin_permiso: no es de la administración activa de esta escuela' } });
        expect(await darDeBaja.ejecutar(admin, args)).toMatchObject({ estado: 'failed', resultado: { motivo: expect.stringMatching(/tu rol aquí no lo permite/) } });
    });

    it('sin la migración (PGRST202) dice que todavía no está disponible', async () => {
        h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.set_school_athlete_status_por' } });
        expect(await darDeBaja.ejecutar(admin, args)).toMatchObject({ estado: 'failed', resultado: { motivo: expect.stringMatching(/todavía no está disponible/) } });
    });

    it('la RPC dice «No autorizado» y no se hace nada', async () => {
        h.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'No autorizado.' } });
        expect(await darDeBaja.ejecutar(admin, args)).toMatchObject({ estado: 'failed', resultado: { motivo: 'No autorizado.' } });
    });
});

describe('cambiar_plan', () => {
    const args = { deportista: `child:${NINA}`, plan: 'pro', cobro: null };

    it('mismo plan, sin plan o inscripción partida: no se prepara', async () => {
        expect(await cambiarPlan.preparar(admin, { ...args, plan: P1 })).toMatchObject({ ok: false, motivo: expect.stringMatching(/ya tiene el plan Básico/) });
        est.inscripciones = [{ id: 'e1', status: 'active', team_id: EQUIPO, offering_plan_id: null, paused_reason: null, pause_request_id: null }];
        expect(await cambiarPlan.preparar(admin, args)).toMatchObject({ ok: false, motivo: expect.stringMatching(/no tiene un plan activo/) });
        est.inscripciones = [
            { id: 'e1', status: 'active', team_id: null, offering_plan_id: P1, paused_reason: null, pause_request_id: null },
            { id: 'e2', status: 'active', team_id: EQUIPO, offering_plan_id: null, paused_reason: null, pause_request_id: null },
        ];
        expect(await cambiarPlan.preparar(admin, args)).toMatchObject({ ok: false, motivo: expect.stringMatching(/partida/) });
    });

    it('la vista previa dice qué se anula y qué cobro nace (plan por nombre, sin escribir)', async () => {
        est.cobros = [
            { id: 'c1', concept: 'Mensualidad Básico', amount: 100000, amount_paid: 0, status: 'pending', offering_plan_id: P1, payment_category: 'mensualidad', period_year: 2026, period_month: 11 },
            { id: 'c2', concept: 'Seguro', amount: 30000, amount_paid: 0, status: 'pending', offering_plan_id: P1, payment_category: 'seguro', period_year: 2026, period_month: 11 },
            { id: 'c3', concept: 'Octubre', amount: 100000, amount_paid: 0, status: 'overdue', offering_plan_id: P1, payment_category: null, period_year: 2026, period_month: 10 },
        ];
        const p = await cambiarPlan.preparar(admin, args);
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.args).toEqual({ deportista: `child:${NINA}`, plan: P2, cobro: null });
        expect(p.vista.lineas[0]).toBe('De Básico ($100.000) a Pro ($150.000).');
        // El seguro no se toca y octubre (vencido, de otro mes) tampoco: mismo predicado que la ruta.
        expect(p.vista.lineas[1]).toBe('Se anula 1 cobro sin pagos del plan anterior o de noviembre de 2026 ($100.000).');
        expect(p.vista.lineas[2]).toBe('Se emite la mensualidad de Pro de noviembre de 2026: $150.000.');
        expect(h.pvPlan).toHaveBeenCalledWith({ schoolId: ESCUELA, athleteCol: 'child_id', athleteId: NINA, newPlanId: P2 });
        expect(escrituras()).toEqual([]);
        expect(h.crear).not.toHaveBeenCalled();
    });

    it('una cuota negociada (becado) se pierde con la ruta: la tarjeta lo advierte', async () => {
        est.inscripciones[0] = { ...est.inscripciones[0], fee_is_manual: true, monthly_fee: 60000 };
        const p = await cambiarPlan.preparar(admin, args);
        expect(p.ok && p.vista.aviso).toBe('Hoy tiene cuota negociada ($60.000): con el cambio queda en el precio del plan nuevo. Si debe conservar el descuento, ajústalo después en Alumnos > Editar deportista.');
    });

    it('banco de horas con el periodo pago: pide parcial o completo, como el diálogo', async () => {
        h.pvPlan.mockResolvedValue({ applies: true, needs_choice: true, paid_in_period: 100000, partial_amount: 50000, full_amount: 150000, recommended: 'partial' });
        expect(await cambiarPlan.preparar(admin, args)).toMatchObject({ ok: false, motivo: expect.stringMatching(/parcial \(\$50\.000.*completo \(\$150\.000/) });
        const p = await cambiarPlan.preparar(admin, { ...args, cobro: 'parcial' });
        expect(p.ok && p.vista.lineas.join(' ')).toContain('cobro parcial de $50.000');
    });

    it('ejecutar usa el cuerpo de POST /enrollments con la escuela de la sesión', async () => {
        h.crear.mockResolvedValue({ status: 200, body: { replaced: true, plan_change: undefined } });
        const r = await cambiarPlan.ejecutar(admin, { ...args, plan: P2 });
        expect(h.crear).toHaveBeenCalledWith(
            { schoolId: ESCUELA, role: 'admin', userId: 'u-admin' },
            { child_id: NINA, offering_plan_id: P2, status: 'active' },
        );
        expect(r.estado).toBe('executed');
        expect(cambiarPlan.mensajeResultado(r, args)).toBe('Mariana López pasó de Básico a Pro. Se emitió la mensualidad del plan nuevo.');
    });

    it('si la ruta responde error, queda fallido con su motivo', async () => {
        h.crear.mockResolvedValue({ status: 409, body: { error: 'El atleta está inactivo.' } });
        expect(await cambiarPlan.ejecutar(admin, { ...args, plan: P2 })).toMatchObject({ estado: 'failed', resultado: { motivo: 'El atleta está inactivo.' } });
    });
});

describe('crear_cobro_unico', () => {
    const base = { deportistas: null, equipo: 'tiburones', categoria: 'torneo' as const, concepto: 'Copa Navidad', monto: 50000, vence: '2099-12-31', avisar_familias: true };
    const grupo = {
        group: { id: EQUIPO, name: 'Tiburones' },
        athletes: [
            { type: 'child', id: NINO, name: 'Samuel Ruiz', has_guardian: false },
            { type: 'child', id: NINA, name: 'Mariana López', has_guardian: true },
        ],
        paused_excluded: 1,
    };

    it('a un equipo o a una lista, no a los dos ni a ninguno', async () => {
        expect(await crearCobroUnico.preparar(admin, { ...base, deportistas: [`child:${NINA}`] })).toMatchObject({ ok: false });
        expect(await crearCobroUnico.preparar(admin, { ...base, equipo: null })).toMatchObject({ ok: false });
    });

    it('quien no es admin financiero de ESTA escuela es rechazado', async () => {
        h.nivel.mockResolvedValue('lector');
        await expect(crearCobroUnico.preparar(admin, base)).rejects.toThrow(/administración/);
        expect(h.nivel).toHaveBeenCalledWith('u-admin', ESCUELA);
    });

    it('la vista previa sale de la RPC del modal, sin crear nada', async () => {
        h.grupo.mockResolvedValue(grupo);
        h.preview.mockResolvedValue({ preview_hash: 'hash-1', rows_to_create: 2, total_amount: 100000, skipped: [] });
        const p = await crearCobroUnico.preparar(admin, base);
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(h.grupo).toHaveBeenCalledWith(ESCUELA, 'team', EQUIPO, false);
        const [escuela, actor, body] = h.preview.mock.calls[0];
        expect([escuela, actor]).toEqual([ESCUELA, 'u-admin']);
        expect(body).toMatchObject({
            mode: 'multi', target: { kind: 'team', ids: [EQUIPO] },
            athletes: [{ type: 'child', id: NINA }, { type: 'child', id: NINO }],
            lines: [{ category: 'torneo', amount: 50000, due_date: '2099-12-31', concept: 'Copa Navidad' }],
        });
        expect(p.args.equipo).toBe(EQUIPO);
        expect(p.vista.lineas[0]).toBe('Torneo · $50.000 por deportista · vence el jueves 31 de diciembre de 2099');
        expect(p.vista.lineas[1]).toBe('2 cobros para Tiburones (2 deportistas) · total $100.000');
        expect(p.vista.lineas.join(' ')).toContain('1 deportista en pausa no se incluye.');
        expect(p.vista.lineas.join(' ')).toContain('1 menor sin acudiente vinculado: no podrá pagarlo en línea.');
        expect(p.vista.detalle?.items).toEqual(['Mariana López', 'Samuel Ruiz']);
        expect(p.vista.botonConfirmar).toBe('Crear 2 cobros');
        expect((p.huella as any).preview).toBe('hash-1');
        expect(h.create).not.toHaveBeenCalled();
    });

    it('un cobro igual de hace minutos sale como aviso en la tarjeta', async () => {
        h.grupo.mockResolvedValue(grupo);
        h.preview.mockResolvedValue({ preview_hash: 'hash-1', rows_to_create: 2, total_amount: 100000 });
        h.recientes.mockResolvedValue([{ batch_id: 'b0', created_at: '2026-11-24T15:00:00Z', minutes_ago: 3, created_by: 'x', created_by_name: 'Ana', total_amount: 100000 }]);
        const p = await crearCobroUnico.preparar(admin, base);
        expect(p.ok && p.vista.aviso).toMatch(/^Ojo: .*Si confirmas, se crea igual\.$/);
    });

    it('un vencimiento pasado lo frena el mismo esquema del modal', async () => {
        h.grupo.mockResolvedValue(grupo);
        expect(await crearCobroUnico.preparar(admin, { ...base, vence: '2020-01-01' })).toMatchObject({ ok: false, motivo: expect.stringMatching(/vencido/) });
        expect(h.preview).not.toHaveBeenCalled();
    });

    it('el error de la RPC vuelve como motivo', async () => {
        h.grupo.mockResolvedValue(grupo);
        h.preview.mockRejectedValue(new CobrosError(402, 'ESCUELA_NO_OPERATIVA', 'La escuela está inhabilitada: no se pueden registrar operaciones.'));
        expect(await crearCobroUnico.preparar(admin, base)).toMatchObject({ ok: false, motivo: expect.stringMatching(/inhabilitada/) });
    });

    it('ejecutar crea el lote con la vista previa confirmada y un id de operación estable', async () => {
        h.grupo.mockResolvedValue(grupo);
        h.preview.mockResolvedValue({ preview_hash: 'hash-1', rows_to_create: 2, total_amount: 100000 });
        h.create.mockResolvedValue({ batch_id: 'b1', rows_created: 2, total_amount: 100000, duplicated: false, skipped: [] });
        const r = await crearCobroUnico.ejecutar(admin, { ...base, equipo: EQUIPO });
        const [escuela, actor, body] = h.create.mock.calls[0];
        expect([escuela, actor]).toEqual([ESCUELA, 'u-admin']);
        expect(body).toMatchObject({
            preview_hash: 'hash-1', client_request_id: idDeOperacion(ESCUELA, 'u-admin', 'hash-1'),
            notify_families: true, overrides: [], target: { kind: 'team', ids: [EQUIPO] },
        });
        expect(body.pending).toEqual([]);
        expect(body.payment).toBeUndefined();
        expect(crearCobroUnico.mensajeResultado(r, base)).toBe(
            'Quedó creado el cobro «Copa Navidad»: 2 cobros por $100.000. Las familias reciben el aviso. Se puede anular desde Gestión de pagos > Operaciones.');
    });

    it('una lista de deportistas usa target list con los ids de la escuela', async () => {
        h.preview.mockResolvedValue({ preview_hash: 'h2', rows_to_create: 1, total_amount: 50000 });
        const p = await crearCobroUnico.preparar(admin, { ...base, equipo: null, deportistas: [`child:${NINA}`], avisar_familias: false });
        expect(p.ok).toBe(true);
        expect(h.preview.mock.calls[0][2]).toMatchObject({ target: { kind: 'list', ids: [NINA] }, athletes: [{ type: 'child', id: NINA }] });
        expect(p.ok && p.vista.lineas.join(' ')).toContain('No se avisa a las familias');
    });

    it('un deportista de otra escuela en la lista no entra', async () => {
        await expect(crearCobroUnico.preparar({ ...admin, schoolId: OTRA }, { ...base, equipo: null, deportistas: [`child:${NINA}`] }))
            .rejects.toThrow(/No encontré/);
        expect(h.preview).not.toHaveBeenCalled();
    });
});

describe('utilidades', () => {
    it('id de operación: mismo hash, mismo id; formato UUID', () => {
        const a = idDeOperacion(ESCUELA, 'u', 'h');
        expect(a).toBe(idDeOperacion(ESCUELA, 'u', 'h'));
        expect(a).not.toBe(idDeOperacion(ESCUELA, 'u', 'otro'));
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('resumen de la vista previa como el modal', () => {
        expect(resumenDeVistaPrevia({ preview_hash: 'x', to_create: { n: 3, total: 9 }, skipped: [{ reason: 'misma_linea_hoy' }, { reason: 'misma_linea_hoy' }] }))
            .toMatchObject({ hash: 'x', cobros: 3, total: 9, omitidos: 2, porMotivo: { misma_linea_hoy: 2 } });
    });
});
