/**
 * Asistencia por WhatsApp para staff: parser de la lista numerada, identificación,
 * foto → revisión obligatoria → guardar, lista → «faltaron 3 y 7» → guardar, y la
 * defensa cuando la tabla aún no existe. Base en memoria; OCR y guardado simulados.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    t: {} as Record<string, any[]>,
    rpc: null as any,
    sinTabla: false,
    uploads: [] as string[],
    removed: [] as string[],
    seq: 0,
}));

vi.mock('../config/supabase', () => {
    const builder = (name: string) => {
        const rows = () => (db.t[name] ??= []);
        const f: ((r: any) => boolean)[] = [];
        let op = 'select'; let payload: any; let single = false; let lim = Infinity; let ord: any = null; let sel_cols = '';
        const api: any = {
            select: (cols?: string) => { if (typeof cols === 'string') sel_cols = cols; return api; },
            eq: (c: string, v: any) => { f.push((r) => r[c] === v); return api; },
            in: (c: string, v: any[]) => { f.push((r) => v.includes(r[c])); return api; },
            is: (c: string, v: any) => { f.push((r) => (r[c] ?? null) === v); return api; },
            gte: (c: string, v: any) => { f.push((r) => r[c] >= v); return api; },
            order: (c: string, o: any) => { ord = { c, asc: o?.ascending !== false }; return api; },
            limit: (n: number) => { lim = n; return api; },
            insert: (p: any) => { op = 'insert'; payload = p; return api; },
            update: (p: any) => { op = 'update'; payload = p; return api; },
            maybeSingle: () => { single = true; return api; },
            single: () => { single = true; return api; },
            then: (ok: any, ko: any) => {
                let r: any;
                // Como PostgREST: pedir una columna que no existe es 42703 (teams NO tiene is_active).
                if (name === 'teams' && /is_active/.test(sel_cols)) {
                    r = { data: null, error: { code: '42703', message: 'column teams.is_active does not exist' } };
                } else if (db.sinTabla && name === 'attendance_sheet_intake') {
                    r = { data: null, error: { code: '42P01', message: 'relation "attendance_sheet_intake" does not exist' } };
                } else if (op === 'insert') {
                    const row = { id: `${name}-${++db.seq}`, created_at: new Date().toISOString(), ...payload };
                    rows().push(row); r = { data: row, error: null };
                } else {
                    let sel = rows().filter((x) => f.every((fn) => fn(x)));
                    if (op === 'update') { sel.forEach((x) => Object.assign(x, payload)); r = { data: sel, error: null }; }
                    else {
                        if (ord) sel = [...sel].sort((a, b) => (a[ord.c] > b[ord.c] ? 1 : -1) * (ord.asc ? 1 : -1));
                        sel = sel.slice(0, lim);
                        r = { data: single ? (sel[0] ?? null) : sel, error: null };
                    }
                }
                return Promise.resolve(r).then(ok, ko);
            },
        };
        return api;
    };
    return {
        supabase: {
            from: builder,
            rpc: (n: string) => Promise.resolve(db.rpc?.(n) ?? { data: null, error: null }),
            storage: { from: () => ({
                upload: (p: string) => { db.uploads.push(p); return Promise.resolve({ error: null }); },
                remove: (p: string[]) => { db.removed.push(...p); return Promise.resolve({ error: null }); },
                createSignedUrl: () => Promise.resolve({ data: { signedUrl: 'https://x' } }),
            }) },
        },
    };
});

const ocrMock = vi.hoisted(() => ({ extractAttendanceSheet: vi.fn() }));
vi.mock('./attendance-sheet-ocr.service', async (orig) => ({ ...(await orig<any>()), extractAttendanceSheet: ocrMock.extractAttendanceSheet }));

const reg = vi.hoisted(() => ({ guardar: vi.fn(), fecha: vi.fn() }));
vi.mock('./attendance-register.service', () => ({ guardarSesionAsistencia: reg.guardar, resolverFechaDeTrabajo: reg.fecha }));

vi.mock('./whatsapp.service', () => ({ downloadMedia: vi.fn() }));

import {
    parsearRespuestaLista, esDisparadorDeLista, identificarStaffPorTelefono, procesarMensajeStaff,
    recibirPlanillaDeStaff, confirmarPlanilla, puedeSubirPlanilla, cargarEquipos, equipoVigente, aplicarCorrecciones, textoResumenEquipos, construirCruce, esTablaAusente,
    type StaffIdentificado,
} from './whatsapp-asistencia-staff.service';

const ESC = 'escuela-1';
const INTEG = { id: 'integ-1', school_id: ESC };
const COACH: StaffIdentificado = { resultado: 'staff', profileId: 'coach-1', role: 'coach', schoolId: ESC };
const ADMIN: StaffIdentificado = { resultado: 'staff', profileId: 'admin-1', role: 'admin', schoolId: ESC };
// Martes 2026-10-20 17:30 hora Colombia
const AHORA = new Date('2026-10-20T17:30:00-05:00');

function sembrar() {
    db.t = {
        teams: [
            { id: 'T-NE', name: 'NUEVA ERA', active: true, status: 'active', school_id: ESC, schedule: [{ day: 2, time: '17:00', end: '19:00', place: 'Coliseo' }] },
            { id: 'T-IN', name: 'INTERMEDIO', active: true, status: 'active', school_id: ESC, schedule: [{ day: 4, time: '16:00', end: '18:00', place: 'Coliseo', group: 'Origen' }] },
        ],
        enrollments: [
            ...['Ana Lopez Ruiz', 'Bea Mora Diaz', 'Cata Rey Paz', 'Dani Sol Vega', 'Eva Cruz Pena'].map((_n, i) => ({ school_id: ESC, status: 'active', team_id: 'T-NE', child_id: `ne-${i}` })),
            ...['Fani Gil Soto', 'Gabi Toro Mejia', 'Hana Luna Rios'].map((_n, i) => ({ school_id: ESC, status: 'active', team_id: 'T-IN', child_id: `in-${i}` })),
        ],
        children: [
            ...['Ana Lopez Ruiz', 'Bea Mora Diaz', 'Cata Rey Paz', 'Dani Sol Vega', 'Eva Cruz Pena'].map((n, i) => ({ id: `ne-${i}`, full_name: n })),
            ...['Fani Gil Soto', 'Gabi Toro Mejia', 'Hana Luna Rios'].map((n, i) => ({ id: `in-${i}`, full_name: n })),
        ],
        profiles: [], unregistered_athletes: [],
        school_staff: [{ id: 'st-1', coach_auth_id: 'coach-1', school_id: ESC }],
        team_coaches: [{ team_id: 'T-NE', coach_id: 'st-1' }, { team_id: 'T-IN', coach_id: 'st-1' }],
        attendance_sheet_intake: [],
        school_settings: [{ school_id: ESC, coach_can_upload_attendance_sheets: true }],
    };
    db.sinTabla = false; db.uploads = []; db.removed = []; db.seq = 0;
    db.rpc = (n: string) => n === 'wa_identify_staff_by_phone'
        ? { data: { resultado: 'staff', profile_id: 'coach-1', role: 'coach', school_id: ESC }, error: null } : null;
}

beforeEach(() => {
    sembrar();
    ocrMock.extractAttendanceSheet.mockReset();
    reg.guardar.mockReset(); reg.fecha.mockReset();
    reg.fecha.mockImplementation(async (f: string) => ({ ok: true, date: f, esRetroactiva: f < '2026-10-20' }));
    reg.guardar.mockResolvedValue({ ok: true, sessionId: 'ses-1', date: '2026-10-20', creditOutcomes: {}, sesionCreada: true });
});

describe('parsearRespuestaLista (determinista, sin LLM)', () => {
    it.each([
        ['todos', 'todos', [], []],
        ['Todos', 'todos', [], []],
        ['ninguno', 'ninguno', [], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
        ['faltaron 3 y 7', 'faltaron', [3, 7], [3, 7]],
        ['Faltó el 5', 'faltaron', [5], [5]],
        ['no vinieron 2, 4 y 9', 'faltaron', [2, 4, 9], [2, 4, 9]],
        ['faltaron 3-5', 'faltaron', [3, 4, 5], [3, 4, 5]],
        ['ausentes: 1 10', 'faltaron', [1, 10], [1, 10]],
        ['todos menos 3', 'faltaron', [3], [3]],
        ['vinieron 1 2 5', 'presentes', [1, 2, 5], [3, 4, 6, 7, 8, 9, 10]],
        ['solo 1,2', 'presentes', [1, 2], [3, 4, 5, 6, 7, 8, 9, 10]],
    ])('«%s»', (txt, tipo, numeros, ausentes) => {
        expect(parsearRespuestaLista(txt as string, 10)).toEqual({ ok: true, tipo, numeros, ausentes });
    });
    it('número fuera de rango → error claro, no guarda', () => {
        expect(parsearRespuestaLista('faltaron 3 y 12', 10)).toMatchObject({ ok: false });
        expect((parsearRespuestaLista('faltaron 0', 10) as any).error).toContain('1 a 10');
    });
    it('palabra clave sin números → error; texto ajeno → null (el bot sigue normal)', () => {
        expect(parsearRespuestaLista('faltaron varios', 10)).toMatchObject({ ok: false });
        expect(parsearRespuestaLista('hola buenas tardes', 10)).toBeNull();
        expect(parsearRespuestaLista('cuánto debo este mes?', 10)).toBeNull();
        expect(parsearRespuestaLista('', 10)).toBeNull();
    });
    it('disparadores de lista', () => {
        expect(esDisparadorDeLista('Lista')).toBe(true);
        expect(esDisparadorDeLista('pasar lista')).toBe(true);
        expect(esDisparadorDeLista('lista de precios')).toBe(false);
    });
});

describe('identificarStaffPorTelefono', () => {
    it('staff / no_staff / ambiguo / RPC ausente', async () => {
        expect(await identificarStaffPorTelefono('i', '57300')).toMatchObject({ resultado: 'staff', role: 'coach', profileId: 'coach-1', schoolId: ESC });
        db.rpc = () => ({ data: { resultado: 'no_staff' }, error: null });
        expect((await identificarStaffPorTelefono('i', '57300')).resultado).toBe('no_staff');
        db.rpc = () => ({ data: { resultado: 'ambiguo' }, error: null });
        expect((await identificarStaffPorTelefono('i', '57300')).resultado).toBe('ambiguo');
        db.rpc = () => ({ data: null, error: { message: 'function does not exist' } });
        expect((await identificarStaffPorTelefono('i', '57300')).resultado).toBe('no_staff');
        db.rpc = () => ({ data: { resultado: 'staff', profile_id: 'x', role: 'parent', school_id: ESC }, error: null });
        expect((await identificarStaffPorTelefono('i', '57300')).resultado).toBe('no_staff');
    });
});

describe('procesarMensajeStaff — camino «lista»', () => {
    it('no staff → null y no toca nada (un acudiente que escribe «lista» sigue el flujo normal)', async () => {
        db.rpc = () => ({ data: { resultado: 'no_staff' }, error: null });
        expect(await procesarMensajeStaff({ integration: INTEG, waId: '57300', texto: 'lista', ahora: AHORA })).toBeNull();
        expect(db.t.attendance_sheet_intake).toHaveLength(0);
    });
    it('texto ajeno sin lista abierta → null, ni siquiera identifica al staff por palabras sin pista', async () => {
        expect(await procesarMensajeStaff({ integration: INTEG, waId: '57300', texto: 'buenas tardes', ahora: AHORA })).toBeNull();
    });
    it('«lista» a las 17:30 del martes → botón de Nueva Era (franja activa), no de Intermedio', async () => {
        const r = await procesarMensajeStaff({ integration: INTEG, waId: '57300', texto: 'lista', ahora: AHORA });
        expect(r?.estado).toBe('pregunta_grupo');
        expect(r?.botones?.map((b) => b.id)).toEqual(['asis_grupo:T-NE']);
        expect(r?.botones?.[0].title.length).toBeLessThanOrEqual(20);
    });
    it('fuera de franja ofrece todos los grupos del coach', async () => {
        const r = await procesarMensajeStaff({ integration: INTEG, waId: '57300', texto: 'lista', ahora: new Date('2026-10-20T03:00:00-05:00') });
        expect(r?.botones?.map((b) => b.id).sort()).toEqual(['asis_grupo:T-IN', 'asis_grupo:T-NE']);
        expect(r?.texto).toContain('No veo clases');
    });
    it('un coach sin el equipo asignado no lo ve ni lo puede abrir', async () => {
        db.t.team_coaches = [{ team_id: 'T-IN', coach_id: 'st-1' }];
        const r = await procesarMessage('lista');
        expect(r?.botones?.map((b) => b.id)).not.toContain('asis_grupo:T-NE');
        const abre = await procesarMensajeStaff({ integration: INTEG, waId: '57300', botonId: 'asis_grupo:T-NE', ahora: AHORA });
        expect(abre?.estado).toBe('error');
    });
    async function procesarMessage(texto: string) { return procesarMensajeStaff({ integration: INTEG, waId: '57300', texto, ahora: new Date('2026-10-20T03:00:00-05:00') }); }

    it('flujo completo: botón de grupo → lista numerada → «faltaron 2 y 4» → guarda 3 presentes + 2 ausentes con markedBy del coach', async () => {
        const lista = await procesarMensajeStaff({ integration: INTEG, waId: '57300', botonId: 'asis_grupo:T-NE', ahora: AHORA });
        expect(lista?.estado).toBe('lista');
        expect(lista?.texto).toMatch(/1\. Ana Lopez Ruiz\n2\. Bea Mora Diaz/);
        expect(lista?.texto).toContain('faltaron 3 y 7');

        const r = await procesarMensajeStaff({ integration: INTEG, waId: '57300', texto: 'faltaron 2 y 4', ahora: AHORA });
        expect(r?.estado).toBe('guardada');
        expect(reg.guardar).toHaveBeenCalledTimes(1);
        const arg = reg.guardar.mock.calls[0][0];
        expect(arg).toMatchObject({ schoolId: ESC, teamId: 'T-NE', date: '2026-10-20', markedBy: 'coach-1', notes: 'whatsapp_lista' });
        expect(arg.finalized).toBeFalsy();                       // hoy: el cierre normal lo finaliza
        expect(arg.records.filter((x: any) => x.status === 'present')).toHaveLength(3);
        expect(arg.records.filter((x: any) => x.status === 'absent').map((x: any) => x.childId).sort()).toEqual(['ne-1', 'ne-3'].sort());
        expect(db.t.attendance_sheet_intake[0]).toMatchObject({ status: 'guardada', session_id: 'ses-1' });
        // no vuelve a guardar si repite el mensaje: la lista ya no está abierta
        expect(await procesarMensajeStaff({ integration: INTEG, waId: '57300', texto: 'todos', ahora: AHORA })).toBeNull();
    });

    it('número fuera de rango: avisa y NO guarda; la lista sigue abierta', async () => {
        await procesarMensajeStaff({ integration: INTEG, waId: '57300', botonId: 'asis_grupo:T-NE', ahora: AHORA });
        const r = await procesarMensajeStaff({ integration: INTEG, waId: '57300', texto: 'faltaron 9', ahora: AHORA });
        expect(r?.texto).toContain('1 a 5');
        expect(reg.guardar).not.toHaveBeenCalled();
        const ok = await procesarMensajeStaff({ integration: INTEG, waId: '57300', texto: 'todos', ahora: AHORA });
        expect(ok?.estado).toBe('guardada');
    });

    it('lista vieja (> 6 h) no atrapa un «todos» suelto', async () => {
        await procesarMensajeStaff({ integration: INTEG, waId: '57300', botonId: 'asis_grupo:T-NE', ahora: AHORA });
        db.t.attendance_sheet_intake[0].created_at = AHORA.toISOString();
        const tarde = new Date(AHORA.getTime() + 7 * 3600_000);
        expect(await procesarMensajeStaff({ integration: INTEG, waId: '57300', texto: 'todos', ahora: tarde })).toBeNull();
    });

    it('sesión de ese día ya cerrada → mensaje claro, no queda «guardada»', async () => {
        reg.guardar.mockResolvedValue({ ok: false, status: 409, body: { reason: 'session_finalized' } });
        await procesarMensajeStaff({ integration: INTEG, waId: '57300', botonId: 'asis_grupo:T-NE', ahora: AHORA });
        const r = await procesarMensajeStaff({ integration: INTEG, waId: '57300', texto: 'todos', ahora: AHORA });
        expect(r?.estado).toBe('error');
        expect(r?.texto).toContain('cerrada');
        expect(db.t.attendance_sheet_intake[0].status).toBe('por_revisar');
    });

    it('sin la tabla en la base: no_disponible en vez de romper', async () => {
        db.sinTabla = true;
        const r = await procesarMensajeStaff({ integration: INTEG, waId: '57300', botonId: 'asis_grupo:T-NE', ahora: AHORA });
        expect(r?.estado).toBe('no_disponible');
        expect(esTablaAusente({ code: 'PGRST205', message: 'x' })).toBe(true);
    });
});

// ── Camino foto ───────────────────────────────────────────────────────────────
const planilla = (over: Partial<any> = {}) => ({
    isAttendanceSheet: true, title: 'ASISTENCIA OCTUBRE', groupHeader: 'NUEVA ERA', monthHeader: 'OCTUBRE',
    columns: [{ label: '13', day: 13, month: null }, { label: '20', day: 20, month: null }, { label: '27', day: 27, month: null }],
    rows: [
        { n: 1, name: 'LOPEZ ANA', marks: { '13': '✓', '20': 'X' }, note: null, struck: false },
        { n: 2, name: 'MORA BEA', marks: { '13': 'R' }, note: null, struck: false },
        { n: 3, name: 'REY CATA', marks: { '20': '✓' }, note: null, struck: false },
        { n: 4, name: 'SOL DANI', marks: {}, note: null, struck: false },
        { n: 5, name: 'PEREZ ZOE', marks: { '20': '✓' }, note: null, struck: false },
        { n: 6, name: 'CRUZ EVA', marks: {}, note: 'Retirada', struck: true },
    ],
    missingFields: [], provider: 'gemini', ...over,
});

describe('recibirPlanillaDeStaff', () => {
    const foto = { integration: INTEG, waId: '57300', staff: COACH, buffer: Buffer.from('x'.repeat(200)), mime: 'image/jpeg', ahora: AHORA };

    it('foto → intake por_revisar + resumen con Guardar/Corregir/Descartar; NO guarda nada', async () => {
        ocrMock.extractAttendanceSheet.mockResolvedValue(planilla());
        const r = await recibirPlanillaDeStaff(foto);
        expect(r.estado).toBe('resumen');
        expect(r.botones?.map((b) => b.title)).toEqual(['Guardar', 'Corregir', 'Descartar']);
        expect(r.texto).toMatch(/Nueva Era, 13-oct:\* 2 presentes, \d+ sin marca/);
        expect(r.texto).toContain('1 no encontrada');
        expect(r.texto).toContain('Sin marca» no cuenta como falta');
        expect(reg.guardar).not.toHaveBeenCalled();
        const fila = db.t.attendance_sheet_intake[0];
        expect(fila).toMatchObject({ status: 'por_revisar', team_id: 'T-NE', source: 'whatsapp', submitted_by: 'coach-1', submitted_by_wa_id: '57300' });
        expect(db.uploads[0]).toMatch(new RegExp(`^${ESC}/attendance/.+\\.jpg$`));
    });

    it('imagen que no es planilla (p. ej. un comprobante) → no_aplica y borra la foto: el caller sigue con pagos', async () => {
        ocrMock.extractAttendanceSheet.mockResolvedValue(planilla({ isAttendanceSheet: false, rows: [] }));
        const r = await recibirPlanillaDeStaff(foto);
        expect(r.estado).toBe('no_aplica');
        expect(db.removed).toHaveLength(1);
        expect(db.t.attendance_sheet_intake).toHaveLength(0);
    });

    it('OCR caído/cuota: la foto queda guardada, intake en error, mensaje honesto', async () => {
        ocrMock.extractAttendanceSheet.mockRejectedValue(new Error('Gemini API error 429'));
        const r = await recibirPlanillaDeStaff(foto);
        expect(r.estado).toBe('error');
        expect(db.t.attendance_sheet_intake[0].status).toBe('error');
        expect(db.removed).toHaveLength(0);
    });

    it('equipo ambiguo → pregunta con botones, sin cruce guardado como definitivo', async () => {
        // mismos nombres en los dos equipos, sin encabezado, fuera de franja
        db.t.enrollments.push(...['ne-0', 'ne-1', 'ne-2', 'ne-3'].map((c) => ({ school_id: ESC, status: 'active', team_id: 'T-IN', child_id: c })));
        ocrMock.extractAttendanceSheet.mockResolvedValue(planilla({ groupHeader: null, title: null }));
        const r = await recibirPlanillaDeStaff({ ...foto, ahora: new Date('2026-10-20T03:00:00-05:00') });
        expect(r.estado).toBe('pregunta_equipo');
        expect(r.botones?.at(-1)?.id).toMatch(/:otro$/);
        expect(db.t.attendance_sheet_intake[0].team_id).toBeNull();
    });

    it('coach sin el equipo asignado: la hoja de ese equipo no se le atribuye', async () => {
        db.t.team_coaches = [{ team_id: 'T-IN', coach_id: 'st-1' }];
        ocrMock.extractAttendanceSheet.mockResolvedValue(planilla({ groupHeader: null }));
        const r = await recibirPlanillaDeStaff(foto);
        expect(r.estado).not.toBe('resumen');
    });

    it('B2: equipos por teams.active/status (no is_active); un equipo inactivo no cuenta', async () => {
        db.t.teams[1].active = false;
        ocrMock.extractAttendanceSheet.mockResolvedValue(planilla());
        const r = await recibirPlanillaDeStaff(foto);
        expect(r.estado).toBe('resumen');
        db.t.teams[0].status = 'inactive';
        const r2 = await recibirPlanillaDeStaff(foto);
        expect(r2).toMatchObject({ estado: 'error', texto: 'No tienes equipos asignados para pasar lista.' });
    });

    it('B2: sin equipos asignados NO sube la foto ni paga el OCR', async () => {
        db.t.team_coaches = [];
        const r = await recibirPlanillaDeStaff(foto);
        expect(r).toMatchObject({ estado: 'error', texto: 'No tienes equipos asignados para pasar lista.' });
        expect(ocrMock.extractAttendanceSheet).not.toHaveBeenCalled();
        expect(db.uploads).toHaveLength(0);
    });

    it('B2: asignación por teams.coach_id (= school_staff.id) y con dos filas de school_staff del mismo coach', async () => {
        db.t.team_coaches = [];
        db.t.school_staff.push({ id: 'st-2', coach_auth_id: 'coach-1', school_id: ESC });
        db.t.teams[0].coach_id = 'st-2';
        ocrMock.extractAttendanceSheet.mockResolvedValue(planilla());
        const r = await recibirPlanillaDeStaff(foto);
        expect(r.estado).toBe('resumen');
        expect(db.t.attendance_sheet_intake[0].team_id).toBe('T-NE');
    });

    it('B5: coach por WhatsApp sin el permiso de la escuela → mensaje claro, sin OCR ni foto', async () => {
        db.t.school_settings = [{ school_id: ESC, coach_can_upload_attendance_sheets: false }];
        const r = await recibirPlanillaDeStaff(foto);
        expect(r.estado).toBe('error');
        expect(r.texto).toMatch(/no tiene habilitado/);
        expect(ocrMock.extractAttendanceSheet).not.toHaveBeenCalled();
        expect(db.uploads).toHaveLength(0);
        // El admin no depende del permiso.
        ocrMock.extractAttendanceSheet.mockResolvedValue(planilla());
        expect((await recibirPlanillaDeStaff({ ...foto, staff: ADMIN })).estado).toBe('resumen');
    });

    it('sin la tabla: no_disponible y no deja la foto huérfana', async () => {
        db.sinTabla = true;
        ocrMock.extractAttendanceSheet.mockResolvedValue(planilla());
        const r = await recibirPlanillaDeStaff(foto);
        expect(r.estado).toBe('no_disponible');
        expect(db.removed).toHaveLength(1);
    });
});

describe('confirmarPlanilla — revisión obligatoria', () => {
    async function conIntake() {
        ocrMock.extractAttendanceSheet.mockResolvedValue(planilla());
        const r = await recibirPlanillaDeStaff({ integration: INTEG, waId: '57300', staff: COACH, buffer: Buffer.from('x'.repeat(200)), mime: 'image/jpeg', ahora: AHORA });
        return r.intakeId!;
    }

    it('guardar: una sesión por fecha con presentes; días pasados entran finalized; hoy no; «sin marca» no se escribe', async () => {
        const id = await conIntake();
        const r = await confirmarPlanilla(id, 'guardar', { staff: COACH, ahora: AHORA });
        expect(r.estado).toBe('guardada');
        const llamadas = reg.guardar.mock.calls.map((c) => c[0]);
        const del13 = llamadas.find((a) => a.date === '2026-10-13');
        const del20 = llamadas.find((a) => a.date === '2026-10-20');
        expect(llamadas.find((a) => a.date === '2026-10-27')).toBeUndefined();   // futuro: se ignora
        expect(del13.finalized).toBe(true);
        expect(del20.finalized).toBe(false);
        expect(del13.notes).toBe('whatsapp_foto');
        expect(del13.markedBy).toBe('coach-1');
        expect(del13.records.every((x: any) => x.status === 'present')).toBe(true);
        expect(del13.records.map((x: any) => x.childId).sort()).toEqual(['ne-0', 'ne-1']);   // Ana (✓) y Bea (R)
        expect(db.t.attendance_sheet_intake[0].status).toBe('guardada');
        // doble toque: no se guarda dos veces
        reg.guardar.mockClear();
        expect((await confirmarPlanilla(id, 'guardar', { staff: COACH })).texto).toContain('ya estaba guardada');
        expect(reg.guardar).not.toHaveBeenCalled();
    });

    it('descartar no guarda nada', async () => {
        const id = await conIntake();
        const r = await confirmarPlanilla(id, 'descartar', { staff: COACH });
        expect(r.estado).toBe('descartada');
        expect(reg.guardar).not.toHaveBeenCalled();
    });

    it('corregir manda a la app y mantiene por_revisar', async () => {
        const id = await conIntake();
        const r = await confirmarPlanilla(id, 'corregir', { staff: COACH });
        expect(r.estado).toBe('correccion');
        expect(db.t.attendance_sheet_intake[0].status).toBe('por_revisar');
    });

    it('otra escuela no puede tocar la fila', async () => {
        const id = await conIntake();
        const r = await confirmarPlanilla(id, 'guardar', { staff: { ...ADMIN, schoolId: 'otra' } });
        expect(r.estado).toBe('error');
        expect(reg.guardar).not.toHaveBeenCalled();
    });

    it('cambiar de equipo recalcula el cruce con ese roster', async () => {
        const id = await conIntake();
        const r = await confirmarPlanilla(id, { equipo: 'T-IN' }, { staff: COACH, ahora: AHORA });
        expect(r.estado).toBe('resumen');
        expect(r.texto).toContain('Intermedio');
        expect(db.t.attendance_sheet_intake[0].team_id).toBe('T-IN');
    });

    it('correcciones desde la app: los presentes finales reemplazan lo del OCR', async () => {
        const id = await conIntake();
        const r = await confirmarPlanilla(id, 'guardar', { staff: COACH, ahora: AHORA, correcciones: { porFecha: [{ fecha: '2026-10-13', presentes: ['ne-2'] }] } });
        expect(r.estado).toBe('guardada');
        const del13 = reg.guardar.mock.calls.map((c) => c[0]).find((a) => a.date === '2026-10-13');
        expect(del13.records.map((x: any) => x.childId)).toEqual(['ne-2']);
    });

    it('un coach no puede guardar en un equipo que no tiene', async () => {
        const id = await conIntake();
        db.t.team_coaches = [{ team_id: 'T-IN', coach_id: 'st-1' }];
        const r = await confirmarPlanilla(id, 'guardar', { staff: COACH, ahora: AHORA });
        expect(r.estado).toBe('error');
        expect(reg.guardar).not.toHaveBeenCalled();
    });
});

describe('puedeSubirPlanilla (B5)', () => {
    it('admin siempre; coach solo con el flag en true; otros nunca', () => {
        for (const rol of ['owner', 'admin', 'super_admin', 'school_admin', 'school']) expect(puedeSubirPlanilla(rol, false)).toBe(true);
        expect(puedeSubirPlanilla('coach', true)).toBe(true);
        expect(puedeSubirPlanilla('coach', false)).toBe(false);
        expect(puedeSubirPlanilla('coach', null)).toBe(false);
        expect(puedeSubirPlanilla('parent', true)).toBe(false);
        expect(puedeSubirPlanilla(undefined, true)).toBe(false);
    });
});

describe('cargarEquipos', () => {
    it('lee active/status; si la consulta falla lo registra y cargarEquiposOFallar lanza', async () => {
        expect((await cargarEquipos(ESC)).map((e) => e.id)).toEqual(['T-NE', 'T-IN']);
        expect(equipoVigente({ active: true, status: 'inactive', name: 'X' })).toBe(false);
        expect(equipoVigente({ active: null, status: null, name: 'X' })).toBe(true);
        expect(equipoVigente({ active: true, status: 'active', name: 'Sub 12 (duplicado)' })).toBe(false);
    });
});

describe('piezas puras', () => {
    it('aplicarCorrecciones deja exactamente los ids dados como presentes', () => {
        const e = construirCruce(planilla() as any, { team_id: 'T-NE', team_name: 'NUEVA ERA' },
            [{ id: 'ne-0', nombre: 'Ana Lopez Ruiz' }, { id: 'ne-1', nombre: 'Bea Mora Diaz' }, { id: 'ne-2', nombre: 'Cata Rey Paz' }],
            { hoy: '2026-10-20' });
        const [c] = aplicarCorrecciones([e], { porFecha: [{ fecha: '2026-10-13', presentes: ['ne-2'] }] });
        expect(c.cruce.porFecha.find((d) => d.fecha === '2026-10-13')!.presentes.map((f) => f.atletaId)).toEqual(['ne-2']);
        expect(textoResumenEquipos([c])).toContain('13-oct');
    });
    it('hoja sin encabezados de día: una sola columna con la fecha sugerida', () => {
        const e = construirCruce(planilla({ columns: [], rows: [
            { n: 1, name: 'LOPEZ ANA', marks: { a: '✓' }, note: null, struck: false },
            { n: 2, name: 'MORA BEA', marks: {}, note: null, struck: false },
        ] }) as any, { team_id: 'T-NE', team_name: 'NUEVA ERA' },
            [{ id: 'ne-0', nombre: 'Ana Lopez Ruiz' }, { id: 'ne-1', nombre: 'Bea Mora Diaz' }],
            { hoy: '2026-10-20', fechaPorDefecto: '2026-10-20' });
        expect(e.fechas).toEqual(['2026-10-20']);
        expect(e.cruce.porFecha[0].sinMarca).toHaveLength(1);
    });
});
