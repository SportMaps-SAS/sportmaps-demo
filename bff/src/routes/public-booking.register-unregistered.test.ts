/** SEG-31 F2 (H3): register-unregistered (menores, rollback) y copia al acudiente. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

const tableResult: Record<string, { data: any; error: any }> = {};
const order: string[] = [];
let profilesDeleteError: any = null;
const updates: { table: string; args: any[] }[] = [];

function builder(table: string) {
    const res = () => Promise.resolve(tableResult[table] ?? { data: null, error: null });
    const b: any = {};
    for (const op of ['select', 'eq', 'in', 'or', 'order', 'limit', 'gte', 'insert']) {
        b[op] = () => b;
    }
    b.update = (...args: any[]) => { updates.push({ table, args }); return b; };
    b.delete = () => {
        order.push(`delete:${table}`);
        return { eq: () => Promise.resolve({ data: null, error: table === 'profiles' ? profilesDeleteError : null }) };
    };
    b.maybeSingle = res;
    b.single = res;
    b.then = (ok: any, ko: any) => res().then(ok, ko);
    return b;
}

const rpcMock = vi.fn();
const createUserMock = vi.fn();
const deleteUserMock = vi.fn();
const generateLinkMock = vi.fn();
const sendMock = vi.fn();
const bookSessionMock = vi.fn();
const logError = vi.fn();

vi.mock('../config/supabase', () => ({
    supabase: {
        rpc: (...a: any[]) => rpcMock(...a),
        from: (t: string) => builder(t),
        auth: { admin: {
            createUser: (...a: any[]) => createUserMock(...a),
            deleteUser: (...a: any[]) => { order.push('deleteUser'); return deleteUserMock(...a); },
            generateLink: (...a: any[]) => generateLinkMock(...a),
        } },
    },
}));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: (...a: any[]) => sendMock(...a) } }));
vi.mock('./session-bookings', () => ({
    listAvailableSessions: vi.fn(),
    bookSession: (...a: any[]) => bookSessionMock(...a),
    cancelSessionBooking: vi.fn(),
}));

vi.setConfig({ testTimeout: 30000 });
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'tok-123';

async function app() {
    vi.resetModules();
    const router = (await import('./public-booking.routes')).default;
    const a = express();
    a.use(express.json());
    a.use((req: any, _res, next) => { req.log = { error: logError }; next(); });
    a.use('/b', router);
    const srv = await new Promise<import('http').Server>((ok) => { const s = a.listen(0, () => ok(s)); });
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/b`;
    const post = async (path: string, body: any) => {
        const r = await fetch(base + path, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { post, close: () => srv.close() };
}

function setup(ficha: Record<string, any> = {}) {
    tableResult.school_trial_class_settings = { data: { enabled: true, self_service_enabled: true }, error: null };
    tableResult.public_booking_verifications = {
        data: {
            id: 'v1', school_id: SCHOOL, verified_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            resolved_kind: 'enrolled_unregistered', resolved_unregistered_id: 'u1',
            resolved_email: 'atleta@b.co', full_name: 'Ana', booking_token_used_at: null,
        },
        error: null,
    };
    tableResult.unregistered_athletes = {
        data: {
            id: 'u1', full_name: 'Ana', email: 'atleta@b.co', linked_profile_id: null, is_active: true,
            date_of_birth: '1990-01-01', guardian_full_name: null, guardian_email: null, ...ficha,
        },
        error: null,
    };
}

beforeEach(() => {
    for (const k of Object.keys(tableResult)) delete tableResult[k];
    order.length = 0;
    updates.length = 0;
    profilesDeleteError = null;
    for (const m of [rpcMock, createUserMock, deleteUserMock, generateLinkMock, sendMock, bookSessionMock, logError]) m.mockReset();
    rpcMock.mockImplementation((fn: string) =>
        Promise.resolve(fn === '_invitacion_ficha_es_de_acudiente' ? { data: false, error: null } : { data: null, error: null }));
    createUserMock.mockResolvedValue({ data: { user: { id: 'new-user' } }, error: null });
    deleteUserMock.mockResolvedValue({ data: null, error: null });
    generateLinkMock.mockResolvedValue({ data: { properties: { action_link: 'https://magic' } }, error: null });
    sendMock.mockResolvedValue({ success: true });
});

async function register() {
    const t = await app();
    const r = await t.post('/register-unregistered', { booking_token: TOKEN });
    t.close();
    return r;
}

describe('POST /register-unregistered: chequeo de menor', () => {
    it('menor por fecha de nacimiento (RPC true) -> 409 sin createUser', async () => {
        setup({ date_of_birth: '2015-05-05' });
        rpcMock.mockResolvedValue({ data: true, error: null });
        const r = await register();
        expect(r.status).toBe(409);
        expect(r.body.reason).toBe('minor_requires_guardian_invite');
        expect(createUserMock).not.toHaveBeenCalled();
        expect(rpcMock).toHaveBeenCalledWith('_invitacion_ficha_es_de_acudiente',
            { p_unregistered_athlete_id: 'u1', p_email: 'atleta@b.co' });
    });
    it('sin fecha y con acudiente -> 409 sin createUser', async () => {
        setup({ date_of_birth: null, guardian_full_name: 'Mamá Pérez' });
        const r = await register();
        expect(r.status).toBe(409);
        expect(r.body.reason).toBe('minor_requires_guardian_invite');
        expect(createUserMock).not.toHaveBeenCalled();
    });
    it('sin fecha y sin acudiente -> 409 igual (sin fecha = menor), sin createUser', async () => {
        setup({ date_of_birth: null, guardian_full_name: '  ' });
        const r = await register();
        expect(r.status).toBe(409);
        expect(r.body.reason).toBe('minor_requires_guardian_invite');
        expect(createUserMock).not.toHaveBeenCalled();
    });
    it('con fecha de adulto y RPC false -> sigue adelante', async () => {
        setup({ date_of_birth: '1985-03-03' });
        const r = await register();
        expect(r.status).toBe(200);
        expect(createUserMock).toHaveBeenCalledTimes(1);
    });
    it('error de la RPC -> 500 register_failed sin createUser', async () => {
        setup();
        rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
        const r = await register();
        expect(r.status).toBe(500);
        expect(r.body.reason).toBe('register_failed');
        expect(createUserMock).not.toHaveBeenCalled();
    });
});

describe('POST /register-unregistered: estados de la ficha', () => {
    it('ficha inactiva -> 400 ficha_inactive', async () => {
        setup({ is_active: false });
        const r = await register();
        expect(r.status).toBe(400);
        expect(r.body.reason).toBe('ficha_inactive');
        expect(createUserMock).not.toHaveBeenCalled();
    });
    it('ficha vinculada -> 400 already_linked', async () => {
        setup({ linked_profile_id: 'p1' });
        const r = await register();
        expect(r.status).toBe(400);
        expect(r.body.reason).toBe('already_linked');
    });
    it('adulto con éxito -> 200 con magic_link', async () => {
        setup();
        const r = await register();
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ success: true, magic_link: 'https://magic' });
        expect(deleteUserMock).not.toHaveBeenCalled();
        const roleUpdate = updates.find((u) => u.table === 'profiles');
        expect(roleUpdate?.args[0]).toEqual({ role: 'athlete', needs_role_selection: false });
        const used = updates.find((u) => u.table === 'public_booking_verifications');
        expect(typeof used?.args[0].booking_token_used_at).toBe('string');
    });
    it('magic link falla -> 500 account_created_no_link y no marca el token como usado', async () => {
        setup();
        generateLinkMock.mockResolvedValue({ data: null, error: { message: 'no link' } });
        const r = await register();
        expect(r.status).toBe(500);
        expect(r.body.reason).toBe('account_created_no_link');
        expect(updates.some((u) => u.table === 'public_booking_verifications')).toBe(false);
    });
});

describe('POST /register-unregistered: rollback', () => {
    it('migración fallida -> 500 register_failed; delete de profiles y luego deleteUser', async () => {
        setup();
        rpcMock.mockImplementation((fn: string) => Promise.resolve(
            fn === 'migrate_unregistered_athlete_to_profile'
                ? { data: null, error: { message: 'migrate boom' } }
                : { data: false, error: null }));
        const r = await register();
        expect(r.status).toBe(500);
        expect(r.body.reason).toBe('register_failed');
        expect(order).toEqual(['delete:profiles', 'deleteUser']);
        expect(deleteUserMock).toHaveBeenCalledWith('new-user');
        expect(generateLinkMock).not.toHaveBeenCalled();
    });
    it('rollback que falla -> 500 y log del huérfano', async () => {
        setup();
        rpcMock.mockImplementation((fn: string) => Promise.resolve(
            fn === 'migrate_unregistered_athlete_to_profile'
                ? { data: null, error: { message: 'migrate boom' } }
                : { data: false, error: null }));
        deleteUserMock.mockResolvedValue({ data: null, error: { message: 'no se pudo' } });
        const r = await register();
        expect(r.status).toBe(500);
        expect(r.body.reason).toBe('register_failed');
        expect(order).toEqual(['delete:profiles', 'deleteUser']);
        const orphanLog = logError.mock.calls.find(([o]) => o?.user_id === 'new-user' && o?.unregistered_id === 'u1');
        expect(orphanLog).toBeTruthy();
    });
    it('falla el delete de profiles -> no llama deleteUser, loguea y responde 500', async () => {
        setup();
        profilesDeleteError = { message: 'fk' };
        rpcMock.mockImplementation((fn: string) => Promise.resolve(
            fn === 'migrate_unregistered_athlete_to_profile'
                ? { data: null, error: { message: 'migrate boom' } }
                : { data: false, error: null }));
        const r = await register();
        expect(r.status).toBe(500);
        expect(order).toEqual(['delete:profiles']);
        expect(deleteUserMock).not.toHaveBeenCalled();
        expect(logError.mock.calls.some(([o]) => o?.user_id === 'new-user')).toBe(true);
    });
    it('createUser falla -> 500 register_failed sin rollback (no hay usuario)', async () => {
        setup();
        createUserMock.mockResolvedValue({ data: null, error: { message: 'dup' } });
        const r = await register();
        expect(r.status).toBe(500);
        expect(r.body.reason).toBe('register_failed');
        expect(deleteUserMock).not.toHaveBeenCalled();
    });
    it('falla el UPDATE de profiles -> mismo rollback y 500', async () => {
        setup();
        // el mock de update devuelve el resultado de la tabla profiles
        tableResult.profiles = { data: null, error: { message: 'update boom' } };
        const r = await register();
        expect(r.status).toBe(500);
        expect(r.body.reason).toBe('register_failed');
        expect(order).toEqual(['delete:profiles', 'deleteUser']);
    });
});

describe('POST /book-for-enrollment: copia al acudiente', () => {
    const MINOR = { date_of_birth: '2015-05-05' };
    async function callBook() {
        const t = await app();
        const r = await t.post('/book-for-enrollment', { booking_token: TOKEN, session_id: 's1', enrollment_id: 'e1' });
        t.close();
        return r;
    }
    async function book(ficha: Record<string, any>, fullName = 'Ana') {
        setup(ficha);
        tableResult.public_booking_verifications.data.full_name = fullName;
        tableResult.attendance_sessions = { data: { session_date: '2026-11-10', start_time: '10:00:00' }, error: null };
        rpcMock.mockResolvedValue({ data: ficha.date_of_birth === MINOR.date_of_birth, error: null });
        bookSessionMock.mockImplementation(async (_req: any, res: any, _id: any, _body: any, _n: any, post: any) => {
            await post({ session_id: 's1' });
            res.json({ ok: true });
        });
        return callBook();
    }
    const recipients = () => sendMock.mock.calls.map(([m]) => m.to);

    it('menor: envía al acudiente cuando difiere, con el nombre escapado', async () => {
        const r = await book({ ...MINOR, guardian_email: ' Mama@Mail.co ' }, '<b>Ana</b> & "Co"');
        expect(r.status).toBe(200);
        expect(recipients()).toEqual(['atleta@b.co', 'mama@mail.co']);
        const copy = sendMock.mock.calls[1][0];
        expect(copy.html).toContain('&lt;b&gt;Ana&lt;/b&gt; &amp; &quot;Co&quot;');
        expect(copy.html).not.toContain('<b>Ana</b>');
        expect(sendMock.mock.calls[0][0].html).not.toContain('<b>Ana</b>');
    });
    it('adulto con guardian_email (contacto de emergencia) -> no se envía', async () => {
        await book({ date_of_birth: '1985-03-03', guardian_email: 'emergencia@mail.co' });
        expect(recipients()).toEqual(['atleta@b.co']);
    });
    it('no envía si es igual al del token (sin mayúsculas ni espacios)', async () => {
        await book({ ...MINOR, guardian_email: '  ATLETA@b.co ' });
        expect(recipients()).toEqual(['atleta@b.co']);
    });
    it('no envía si falta guardian_email', async () => {
        await book({ ...MINOR, guardian_email: null });
        expect(recipients()).toEqual(['atleta@b.co']);
    });
    it('un fallo de envío al acudiente no tumba la reserva', async () => {
        sendMock.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('smtp'));
        const r = await book({ ...MINOR, guardian_email: 'mama@mail.co' });
        expect(r.status).toBe(200);
        expect(logError).toHaveBeenCalled();
    });
    it('error leyendo la ficha -> log con unregistered_id (sin correo), sin copia, reserva ok', async () => {
        await book({ ...MINOR, guardian_email: 'mama@mail.co' });
        sendMock.mockClear();
        logError.mockClear();
        tableResult.unregistered_athletes = { data: null, error: { message: 'read boom' } };
        const r = await callBook();
        expect(r.status).toBe(200);
        expect(recipients()).toEqual(['atleta@b.co']);
        const log = logError.mock.calls.find(([o]) => o?.unregistered_id === 'u1');
        expect(log).toBeTruthy();
        expect(JSON.stringify(log![0].unregistered_id)).not.toContain('@');
    });
    it('el correo al titular falla (success:false) -> se loguea y la copia igual se intenta', async () => {
        sendMock.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true });
        await book({ ...MINOR, guardian_email: 'mama@mail.co' });
        expect(recipients()).toEqual(['atleta@b.co', 'mama@mail.co']);
        expect(logError).toHaveBeenCalled();
    });
});
