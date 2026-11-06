// Ayudas para las pruebas de integracion HTTP de reservas de canchas (T1):
// SOLO contra el GEMELO LOCAL (Postgres 127.0.0.1:54322, API 127.0.0.1:54321) y un BFF
// levantado con helpers/levantar-bff-gemelo.mjs (puerto 3101).
//
//   cd bff && node test/integration/helpers/levantar-bff-gemelo.mjs --gating=enforce   (otra terminal)
//   cd bff && npx vitest run -c vitest.integration.config.ts test/integration/reservas-*.test.ts
import { Client } from 'pg';
import { createHmac, createHash } from 'node:crypto';
import { assertNotProduction } from '../../guard-no-prod';

export const DB_URL = process.env.QA_TWIN_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const API = 'http://127.0.0.1:54321';
export const BFF = process.env.T1_BFF_URL ?? 'http://127.0.0.1:3101';
export const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
export const SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
export const PASSWORD = 'QaGemelo2026!';
export const RESERVATIONS_TOKEN_SECRET = 'secreto-local-t1-no-es-de-nadie';
export const PAYMENT_TOKENS_ENC_KEY = 'clave-local-t1-para-cifrar-llaves-falsas';
export const WOMPI_MOCK_FILE = process.env.WOMPI_MOCK_FILE ?? require('node:path').join(require('node:os').tmpdir(), 'wompi-mock-t1.json');

assertNotProduction({ ...process.env, QA_TWIN_DB_URL: DB_URL, SUPABASE_URL: API }, null);
if (!/@(127\.0\.0\.1|localhost):/.test(DB_URL)) throw new Error('QA_TWIN_DB_URL debe ser localhost');

// ── Base ─────────────────────────────────────────────────────────────────────
let _db: Client | null = null;
export async function db(): Promise<Client> {
    if (!_db) { _db = new Client({ connectionString: DB_URL }); await _db.connect(); }
    return _db;
}
export async function closeDb() { if (_db) { await _db.end(); _db = null; } }
export async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return (await (await db()).query(sql, params)).rows as T[];
}
export async function q1<T = any>(sql: string, params: any[] = []): Promise<T> {
    return (await q<T>(sql, params))[0];
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
export interface Resp { status: number; body: any; headers: Headers }
export async function http(method: string, path: string, opts: { token?: string; body?: any; headers?: Record<string, string>; base?: string } = {}): Promise<Resp> {
    const h: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) h.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(`${opts.base ?? BFF}${path}`, { method, headers: h, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const text = await r.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* texto */ }
    return { status: r.status, body, headers: r.headers };
}
export const get = (p: string, token?: string, headers?: Record<string, string>) => http('GET', p, { token, headers });
export const post = (p: string, body: any, token?: string, headers?: Record<string, string>) => http('POST', p, { token, body, headers });
export const patch = (p: string, body: any, token?: string, headers?: Record<string, string>) => http('PATCH', p, { token, body, headers });
export const del = (p: string, token?: string, headers?: Record<string, string>) => http('DELETE', p, { token, headers });

let seq = 0;
export const idem = (tag = 'k') => `t1-${tag}-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ── Auth del gemelo ──────────────────────────────────────────────────────────
async function adminCreateUser(email: string, fullName: string, role: string, extraMeta: Record<string, any> = {}): Promise<string> {
    const r = await fetch(`${API}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: fullName, role, ...extraMeta } }),
    });
    const j: any = await r.json();
    if (r.ok) return j.id;
    // ya existe: buscarlo
    const rows = await q('select id from auth.users where email = $1', [email]);
    if (rows[0]) return rows[0].id;
    throw new Error(`no se pudo crear ${email}: ${JSON.stringify(j)}`);
}
export async function login(email: string): Promise<string> {
    const r = await fetch(`${API}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }),
    });
    const j: any = await r.json();
    if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
    return j.access_token;
}

// ── Fechas (America/Bogota = UTC-5 fijo) ─────────────────────────────────────
/** Proximo `weekday` (0=dom..6=sab) a >= `minDaysAhead` dias, en fecha de Bogota 'YYYY-MM-DD'. */
export function fechaDia(weekday: number, minDaysAhead = 3, extraWeeks = 0): string {
    const bogotaNow = new Date(Date.now() - 5 * 3600_000);
    const d = new Date(Date.UTC(bogotaNow.getUTCFullYear(), bogotaNow.getUTCMonth(), bogotaNow.getUTCDate() + minDaysAhead));
    while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCDate(d.getUTCDate() + 7 * extraWeeks);
    return d.toISOString().slice(0, 10);
}
export const at = (fecha: string, hhmm: string) => `${fecha}T${hhmm}:00-05:00`;
export const utc = (iso: string) => new Date(iso).toISOString();

// ── El mundo de prueba (idempotente) ─────────────────────────────────────────
export interface Mundo {
    A: string; B: string; V: string;                       // school ids
    fac: { members: string; public: string; both: string; training: string; b: string; v: string };
    u: Record<string, string>;                              // alias -> profile id
    jwt: Record<string, string>;                            // alias -> JWT real del login
    guardian: string;                                       // padre del menor
}
const EMAIL = (a: string) => `t1-${a.toLowerCase()}@qa.sportmaps.test`;
const ALIASES: [string, string, string][] = [
    ['ownerA', 'T1 Owner A', 'school'], ['staffA', 'T1 Staff A', 'school_admin'], ['padre', 'T1 Padre Miembro', 'parent'],
    ['atleta', 'T1 Atleta Adulto', 'athlete'], ['menor', 'T1 Atleta Menor', 'athlete'], ['externo', 'T1 Externo', 'athlete'],
    ['ownerB', 'T1 Owner B', 'school'], ['staffB', 'T1 Staff B', 'school_admin'], ['ownerV', 'T1 Owner Venue', 'school'],
    ['externo2', 'T1 Externo Dos', 'athlete'], ['coachA', 'T1 Coach A', 'coach'],
];

export async function levantarMundo(): Promise<Mundo> {
    const u: Record<string, string> = {};
    for (const [a, n, r] of ALIASES) u[a] = await adminCreateUser(EMAIL(a), n, r);
    // fechas de nacimiento / telefonos
    await q(`update profiles set date_of_birth = '1995-05-05', phone='+573001110001' where id = $1`, [u.atleta]);
    await q(`update profiles set date_of_birth = '2012-04-04' where id = $1`, [u.menor]);

    const sch = async (name: string, owner: string, type: string) => {
        const ex = await q1('select id from schools where name = $1', [name]);
        if (ex) return ex.id as string;
        return (await q1(`insert into schools (owner_id, name, city, email, phone, onboarding_status, onboarding_step, account_type, business_model, sports, school_type, slug)
                          values ($1,$2,'Bogotá',$3,'+573000000999','completed',5,'test','both',array['futbol'],$4,$5) returning id`,
            [owner, name, `${name.toLowerCase().replace(/\W+/g, '-')}@qa.sportmaps.test`, type, name.toLowerCase().replace(/\W+/g, '-')])).id as string;
    };
    const A = await sch('t1-Escuela A', u.ownerA, 'academy');
    const B = await sch('t1-Escuela B', u.ownerB, 'academy');
    const V = await sch('t1-Venue', u.ownerV, 'venue');
    for (const s of [A, B]) {
        await q(`insert into school_addons (school_id, addon_key, enabled, monthly_price_cents) values ($1,'reservations',true,0)
                 on conflict (school_id, addon_key) do update set enabled = true, disabled_at = null`, [s]);
    }
    // payment_mode para el cobro (A queda 'direct' mas adelante; por defecto unset)
    const mem = async (school: string, prof: string, role: string) =>
        q(`insert into school_members (school_id, profile_id, role, status) values ($1,$2,$3,'active')
           on conflict (profile_id, school_id) do update set role = excluded.role, status = 'active'`, [school, prof, role]);
    await mem(A, u.staffA, 'school_admin'); await mem(A, u.coachA, 'coach'); await mem(A, u.padre, 'parent'); await mem(A, u.atleta, 'athlete'); await mem(A, u.menor, 'athlete');
    await mem(B, u.staffB, 'school_admin');

    // Instalaciones
    const fac = async (school: string, name: string, bookableBy: string, bookingEnabled: boolean, extra = '') => {
        const ex = await q1('select id from facilities where school_id = $1 and name = $2', [school, name]);
        if (ex) {
            await q(`update facilities set bookable_by=$2, booking_enabled=$3, status='available', min_booking_advance_hours=0, min_cancellation_hours=0, min_deposit_pct=30 where id=$1`, [ex.id, bookableBy, bookingEnabled]);
            return ex.id as string;
        }
        const hours = JSON.stringify(Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, ['06:00-22:00']])));
        return (await q1(`insert into facilities (school_id, name, type, capacity, status, hourly_rate, available_hours, booking_enabled, bookable_by, min_deposit_pct, rental_enabled)
                          values ($1,$2,'futbol_5',10,'available',0,$3::jsonb,$4,$5,30,true) returning id`, [school, name, hours, bookingEnabled, bookableBy])).id as string;
    };
    const F = {
        members: await fac(A, 't1-Cancha Socios', 'members', true),
        public: await fac(A, 't1-Cancha Publica', 'public', true),
        both: await fac(A, 't1-Cancha Ambas', 'both', true),
        training: await fac(A, 't1-Entrenamiento', 'both', false),
        b: await fac(B, 't1-Cancha B', 'both', true),
        v: await fac(V, 't1-Cancha Venue', 'public', true),
    };
    // Tarifas
    await q('delete from facility_rates where facility_id = any($1::uuid[])', [Object.values(F)]);
    const rate = (school: string, fid: string, aud: string, days: number[], from: string, to: string, price: number, prio = 0, label = '') =>
        q(`insert into facility_rates (school_id, facility_id, audience, weekdays, from_time, to_time, price_per_hour, priority, label)
           values ($1,$2,$3,$4::smallint[],$5,$6,$7,$8,$9)`, [school, fid, aud, days, from, to, price, prio, label]);
    // Publica: valle L-V 06-18 = 80.000, pico L-V 18-22 = 120.000, fin de semana (y festivo = domingo) 100.000
    await rate(A, F.public, 'public', [1, 2, 3, 4, 5], '06:00', '18:00', 80000, 0, 'valle');
    await rate(A, F.public, 'public', [1, 2, 3, 4, 5], '18:00', '22:00', 120000, 0, 'pico');
    await rate(A, F.public, 'public', [0, 6], '06:00', '22:00', 100000, 0, 'finde');
    // Ambas: publica 100.000 todo el dia / socio 60.000
    await rate(A, F.both, 'public', [0, 1, 2, 3, 4, 5, 6], '06:00', '22:00', 100000);
    await rate(A, F.both, 'member', [0, 1, 2, 3, 4, 5, 6], '06:00', '22:00', 60000);
    // Socios: solo tarifa member 50.000
    await rate(A, F.members, 'member', [0, 1, 2, 3, 4, 5, 6], '06:00', '22:00', 50000);
    await rate(A, F.training, 'public', [0, 1, 2, 3, 4, 5, 6], '06:00', '22:00', 70000);
    await rate(B, F.b, 'public', [0, 1, 2, 3, 4, 5, 6], '06:00', '22:00', 90000);
    await rate(V, F.v, 'public', [0, 1, 2, 3, 4, 5, 6], '06:00', '22:00', 110000);

    // Acudiente del menor: el padre (children / unregistered_athletes se vinculan por date_of_birth del menor)
    const jwt: Record<string, string> = {};
    for (const [a] of ALIASES) jwt[a] = await login(EMAIL(a));
    return { A, B, V, fac: F, u, jwt, guardian: u.padre };
}

/** Borra TODAS las reservas/ocupacion de las escuelas t1 (reinicia el tablero entre corridas). */
export async function limpiarReservas(m: Mundo) {
    await q(`delete from facility_reservations where school_id = any($1::uuid[])`, [[m.A, m.B, m.V]]);
    await q(`delete from facility_occupancy where facility_id = any($1::uuid[])`, [Object.values(m.fac)]);
    await q(`delete from notifications where school_id = any($1::uuid[])`, [[m.A, m.B, m.V]]);
}

// ── Wompi simulado ───────────────────────────────────────────────────────────
import { writeFileSync, readFileSync } from 'node:fs';
export function mockWompiTx(id: string, tx: { status: string; reference: string; amount_in_cents: number; currency?: string }) {
    let cur: any = {};
    try { cur = JSON.parse(readFileSync(WOMPI_MOCK_FILE, 'utf8')); } catch { /* */ }
    cur[id] = { currency: 'COP', ...tx };
    writeFileSync(WOMPI_MOCK_FILE, JSON.stringify(cur));
}
/** Evento transaction.updated con checksum valido para `eventsSecret`. */
export function wompiEvent(tx: { id: string; status: string; reference: string; amount_in_cents: number; currency?: string }, eventsSecret: string, tsOverride?: number) {
    const timestamp = tsOverride ?? Math.floor(Date.now() / 1000);
    const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
    const raw = `${tx.id}${tx.status}${tx.amount_in_cents}${timestamp}${eventsSecret}`;
    return {
        event: 'transaction.updated',
        data: { transaction: { currency: 'COP', ...tx } },
        timestamp,
        signature: { properties, checksum: createHash('sha256').update(raw).digest('hex') },
        sent_at: new Date().toISOString(),
    };
}

// ── Cifrado de llaves FALSAS de pasarela (mismo formato que payment-crypto del BFF) ──
import { createCipheriv, randomBytes } from 'node:crypto';
export function encryptSecret(plain: string): string {
    const raw = PAYMENT_TOKENS_ENC_KEY;
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : createHash('sha256').update(raw).digest();
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `gcm:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${ct.toString('hex')}`;
}

// ── Token firmado de reservas (mismo algoritmo que reservations.shared.ts) ───
export function signReservationToken(p: { typ: 'g' | 'r'; gid: string; rid?: string; exp: number }, secret = RESERVATIONS_TOKEN_SECRET): string {
    const body = Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

// ── PostgREST directo ────────────────────────────────────────────────────────
export function rest(token: string | null, method: string, path: string, body?: any, extra: Record<string, string> = {}) {
    return http(method, path, { base: `${API}/rest/v1`, headers: { apikey: token ? ANON : ANON, Authorization: `Bearer ${token ?? ANON}`, Prefer: 'return=representation', ...extra }, body });
}
export const rpc = (token: string | null, fn: string, args: any) => rest(token, 'POST', `/rpc/${fn}`, args);
