// Pruebas de CONCURRENCIA CT1-CT7 del Partido en vivo F1 (docs/plan-partido-en-vivo-f1.md §9.2),
// mas dos extras que salieron de la revision (docs/..._correcciones_revision): inicio simultaneo
// (advisory lock) y publicar-vs-terminar (orden de bloqueos, sin deadlock).
//
// SOLO contra el GEMELO LOCAL (o una base descartable declarada a mano). NUNCA contra produccion:
//   - se aborta al importar si cualquier URL del entorno apunta a luebjarufsiadojhvxgi (guard-no-prod)
//   - se aborta si el host de QA_TWIN_DB_URL no es localhost/127.0.0.1 (salvo PV_DISPOSABLE_DB_HOST=<host exacto>,
//     y aun asi nunca *.supabase.co / *.supabase.com / pooler)
//   - en beforeAll se exige la marca qa_twin.meta y que auth.users solo tenga cuentas @qa.sportmaps.test.
//
// Prerrequisito: el gemelo es un volcado de la base viva, que todavia NO tiene el Partido en vivo.
// Hay que aplicarle (solo al gemelo) las migraciones 20261105231554 -> 20261105235829. Ver
// docs/migraciones-para-aplicar-2026-11-06/pruebas-concurrencia.md ("Como levantar el gemelo").
//
//   cd bff
//   export SUPABASE_URL=http://127.0.0.1:54321
//   export QA_TWIN_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
//   npx vitest run -c vitest.integration.config.ts test/integration/partido-vivo-concurrencia.test.ts
//
// Cada llamada a una RPC va en SU PROPIA conexion y transaccion real (BEGIN; set_config claims local;
// SET LOCAL ROLE authenticated; RPC; COMMIT), igual que PostgREST. Los datos de prueba se crean con
// el rol postgres, con ids fijos de prefijo 8d00 y se borran al final (el flag del colegio se restaura).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { assertNotProduction, PROD_SUPABASE_REF } from '../guard-no-prod';

// ── Guardas anti-produccion (corren al importar, antes de abrir ninguna conexion) ──────────────
const DB_URL = process.env.QA_TWIN_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
assertNotProduction({ ...process.env, QA_TWIN_DB_URL: DB_URL }, null);

function assertDisposableTarget(url: string) {
    let host = '';
    try { host = new URL(url).hostname; } catch { throw new Error(`QA_TWIN_DB_URL no es una URL valida: ${url.replace(/:[^:@/]*@/, ':***@')}`); }
    const prohibido = url.includes(PROD_SUPABASE_REF) || /supabase\.(co|com)$/i.test(host) || /pooler/i.test(host);
    if (prohibido) {
        throw new Error(`ABORTADO: ${host} parece una base Supabase (la unica es la de PRODUCCION, ${PROD_SUPABASE_REF}). `
            + 'Estas pruebas solo corren contra el gemelo local (127.0.0.1:54322) o una base descartable.');
    }
    const local = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    if (!local && process.env.PV_DISPOSABLE_DB_HOST !== host) {
        throw new Error(`ABORTADO: el host ${host} no es localhost. Si de verdad es una base DESCARTABLE, exporta PV_DISPOSABLE_DB_HOST=${host}. `
            + 'Si no sabes que es eso, usa el gemelo: npm run qa:twin:up (docs/qa-gemelo-local.md).');
    }
    return { host, local };
}
const TARGET = assertDisposableTarget(DB_URL);

// ── Mundo de prueba (semilla del gemelo: escuela A) ────────────────────────────────────────────
const SCHOOL = '00000000-0000-4000-b000-000000000001';
const OWNER = '00000000-0000-4000-a000-000000000001';   // owner.a
const ADMIN = '00000000-0000-4000-a000-000000000002';   // admin.a (school_admin)
const COACH = '00000000-0000-4000-a000-000000000003';   // coach.a
const TEAM = '00000000-0000-4000-8d00-0000000000a1';
const CHILD = (n: number) => `00000000-0000-4000-8d00-0000000001${n.toString(16).padStart(2, '0')}`;   // n = 1..16
const N_CHILDREN = 16;

const pool = new Pool({ connectionString: DB_URL, max: 14 });
const pool2 = new Pool({ connectionString: DB_URL, max: 2 });   // CT2: "dos conexiones" (dos pestanas)
const adm = (sql: string, params: any[] = []) => pool.query(sql, params);

interface Res { ok: boolean; data?: any; code?: string; hint?: string; msg?: string }

/** Una RPC en su propia conexion y transaccion, con la sesion de `uid` (rol authenticated). */
async function callAs(uid: string, sql: string, params: any[] = [], p: Pool = pool): Promise<Res> {
    const c = await p.connect();
    try {
        await c.query('begin');
        await c.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
            [JSON.stringify({ sub: uid, role: 'authenticated' }), uid]);
        await c.query('set local role authenticated');
        const r = await c.query(sql, params);
        await c.query('commit');
        return { ok: true, data: r.rows[0] ? Object.values(r.rows[0])[0] : null };
    } catch (e: any) {
        try { await c.query('rollback'); } catch { /* la conexion ya cayo */ }
        return { ok: false, code: e.code, hint: e.hint, msg: e.message };
    } finally {
        c.release();
    }
}

const rpcApply = (m: string, events: any[], uid = COACH, p: Pool = pool) =>
    callAs(uid, 'select public.apply_live_events($1, $2::jsonb)', [m, JSON.stringify(events)], p);
const rpcStart = (m: string, uid = COACH) => callAs(uid, `select public.start_live_match($1, '{}'::jsonb)`, [m]);
const rpcFinish = (m: string, sf = 0, sa = 0, uid = COACH) => callAs(uid, 'select public.finish_live_match($1, $2, $3)', [m, sf, sa]);
const rpcVoid = (m: string, ev: string, uid = COACH) => callAs(uid, 'select public.void_live_event($1, $2)', [m, ev]);
const rpcPublish = (m: string, pub: boolean, uid = COACH) => callAs(uid, 'select public.publish_match_report($1, $2)', [m, pub]);
const rpcReport = (m: string, uid = COACH) => callAs(uid, 'select public.match_live_report($1)', [m]);

type EvOpts = { subj?: number; rel?: number; brk?: boolean; cid?: string; payload?: any; reason?: string };
/** Evento de apply_live_events. `client_at` = hace 2 h: ancla el reloj del tiempo y evita FUTURE_EVENT. */
function ev(type: string, period: number, sec: number, o: EvOpts = {}) {
    const kid = (n?: number) => (n ? { type: 'child', id: CHILD(n) } : undefined);
    const e: any = {
        client_event_id: o.cid ?? randomUUID(), type, period_no: period, period_second: sec,
        in_break: o.brk ?? false, client_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        payload: o.payload ?? {}, subject: kid(o.subj), related: kid(o.rel),
    };
    if (o.reason) e.reason = o.reason;
    return e;
}
const sub = (sec: number, entra: number, sale: number, cid?: string) => ev('sub', 1, sec, { subj: entra, rel: sale, cid });

const matches: string[] = [];

/** Partido de la escuela A con convocatoria c1..c14 (c1..c11 titulares, dorsal = n). c15 y c16 son de la escuela pero no estan convocados. */
async function newMatch(): Promise<string> {
    const m = randomUUID();
    matches.push(m);
    await adm(`insert into public.match_results (id, school_id, team_id, opponent, match_date, status, is_home, location, kickoff_at,
                                                 live_periods_count, live_period_minutes)
               values ($1, $2, $3, 'Rival QA concurrencia', current_date, 'scheduled', true, 'Cancha QA', now(), 2, 45)`, [m, SCHOOL, TEAM]);
    const l = (await adm(`insert into public.match_lineups (school_id, team_id, source_type, source_id, created_by)
                          values ($1, $2, 'team_match', $3, $4) returning id`, [SCHOOL, TEAM, m, ADMIN])).rows[0].id;
    for (let i = 1; i <= 14; i++) {
        await adm(`insert into public.match_lineup_players (lineup_id, school_id, subject_type, subject_id, role, jersey_number)
                   values ($1, $2, 'child', $3, $4, $5)`, [l, SCHOOL, CHILD(i), i <= 11 ? 'starter' : 'bench', i]);
    }
    return m;
}
const mustOk = (r: Res, what: string) => { if (!r.ok) throw new Error(`${what} fallo: [${r.code}/${r.hint}] ${r.msg}`); return r; };
/** start + pitazo inicial del 1.er tiempo. */
async function kickoff(m: string) {
    mustOk(await rpcStart(m), 'start_live_match');
    mustOk(await rpcApply(m, [ev('period_start', 1, 0)]), 'period_start');
}
const stints = async (m: string) =>
    (await adm(`select subject_id, period_no, in_second, out_second, ended_by from public.match_player_stints
                 where match_id = $1 order by subject_id, period_no, in_second`, [m])).rows;
const countRows = async (sql: string, params: any[]) => Number((await adm(sql, params)).rows[0].n);
const minutesByChild = (report: any) => {
    const o: Record<string, number> = {};
    for (const p of report.lineup) o[p.subject_id] = p.minutes;
    return o;
};

let flagBefore: boolean | null = null;

beforeAll(async () => {
    // 1. Es de verdad el gemelo y no una base real
    const meta = await adm(`select to_regclass('qa_twin.meta') as t`);
    if (!meta.rows[0].t) throw new Error('ABORTADO: no existe qa_twin.meta; esta base no es el gemelo (npm run qa:twin:up).');
    if (Number((await adm('select count(*) n from qa_twin.meta')).rows[0].n) === 0) throw new Error('ABORTADO: qa_twin.meta vacia.');
    const ajenos = Number((await adm(`select count(*) n from auth.users where email not like '%@qa.sportmaps.test'`)).rows[0].n);
    if (ajenos > 0) throw new Error(`ABORTADO: auth.users tiene ${ajenos} cuenta(s) que no son de la semilla QA. ¿Es la base viva?`);
    // 2. Tiene las migraciones del Partido en vivo
    const fn = await adm(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace
                           and proname in ('start_live_match','apply_live_events','finish_live_match','void_live_event','set_live_director',
                                           'publish_match_report','save_match_roster','match_live_report')`);
    const adv = await adm(`select pg_get_functiondef('public.start_live_match(uuid,jsonb)'::regprocedure) ilike '%pg_advisory_xact_lock%' as ok`).catch(() => ({ rows: [{ ok: false }] }));
    if (fn.rows[0].n < 8 || !adv.rows[0].ok) {
        throw new Error('El gemelo NO tiene el Partido en vivo (o le falta 20261105234602). Aplica a ESE gemelo 20261105231554..20261105235829 '
            + '(npm run qa:sql -- <archivo>) siguiendo docs/migraciones-para-aplicar-2026-11-06/pruebas-concurrencia.md.');
    }
    for (const u of [OWNER, ADMIN, COACH]) {
        if (!(await adm('select 1 from auth.users where id = $1', [u])).rowCount) throw new Error(`Falta el usuario semilla ${u}; corre npm run qa:twin:seed.`);
    }
    // 3. Datos: equipo + 16 fichas sin cuenta de acudiente + flag encendido (se restaura al final)
    await adm(`insert into public.teams (id, name, sport, school_id) values ($1, 'PV concurrencia QA', 'futbol', $2) on conflict (id) do nothing`, [TEAM, SCHOOL]);
    for (let i = 1; i <= N_CHILDREN; i++) {
        await adm(`insert into public.children (id, full_name, date_of_birth, school_id, is_active, doc_type, doc_number, parent_phone_temp, parent_name_temp)
                   values ($1, $2, '2014-01-01', $3, true, 'TI', $4, '3105559999', 'Acudiente QA PV')
                   on conflict (id) do nothing`, [CHILD(i), `Jugador PV ${String(i).padStart(2, '0')}`, SCHOOL, `97700000${String(i).padStart(2, '0')}`]);
    }
    const s = await adm('select live_match_enabled from public.school_settings where school_id = $1', [SCHOOL]);
    flagBefore = s.rowCount ? s.rows[0].live_match_enabled : null;
    if (s.rowCount) await adm('update public.school_settings set live_match_enabled = true where school_id = $1', [SCHOOL]);
    else await adm('insert into public.school_settings (school_id, live_match_enabled) values ($1, true)', [SCHOOL]);
    console.log(`[partido-vivo-concurrencia] base ${TARGET.host} (${TARGET.local ? 'gemelo local' : 'descartable'}) lista`);
}, 60_000);

afterAll(async () => {
    try {
        for (const m of matches) {
            await adm('delete from public.football_match_events where source_type = $1 and source_id = $2', ['team_match', m]).catch(() => {});
            await adm('delete from public.match_reports where match_id = $1', [m]).catch(() => {});
            await adm('delete from public.match_live where match_id = $1', [m]).catch(() => {});   // cascada: periodos, eventos, tramos
            await adm(`delete from public.match_lineup_players where lineup_id in (select id from public.match_lineups where source_type = 'team_match' and source_id = $1)`, [m]).catch(() => {});
            await adm(`delete from public.match_lineups where source_type = 'team_match' and source_id = $1`, [m]).catch(() => {});
            await adm('delete from public.match_results where id = $1', [m]).catch(() => {});
        }
        for (let i = 1; i <= N_CHILDREN; i++) await adm('delete from public.children where id = $1', [CHILD(i)]).catch(() => {});
        await adm('delete from public.teams where id = $1', [TEAM]).catch(() => {});
        // si la fila no existia, la dejamos con el flag apagado (el default de la migracion 02 es false)
        await adm('update public.school_settings set live_match_enabled = $2 where school_id = $1', [SCHOOL, flagBefore ?? false]).catch(() => {});
    } finally {
        await pool.end().catch(() => {});
        await pool2.end().catch(() => {});
    }
}, 60_000);

const T = 120_000;

describe('guarda anti-produccion', () => {
    it('rechaza las URL de produccion y los hosts remotos', () => {
        expect(() => assertDisposableTarget(`postgresql://postgres:x@db.${PROD_SUPABASE_REF}.supabase.co:5432/postgres`)).toThrow(/PRODUCCION/);
        expect(() => assertDisposableTarget('postgresql://postgres:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres')).toThrow(/ABORTADO/);
        expect(() => assertDisposableTarget('postgresql://postgres:x@10.0.0.5:5432/postgres')).toThrow(/no es localhost/);
        expect(() => assertDisposableTarget('postgresql://postgres:x@127.0.0.1:54322/postgres')).not.toThrow();
    });
});

describe('CT1 dos directores', () => {
    it('set_live_director del admin vs 20 apply_live_events del director: se serializan, un solo escritor, conteo = aceptados', async () => {
        const m = await newMatch();
        await kickoff(m);
        const calls: Promise<Res>[] = [];
        let reasign: Promise<Res> | null = null;
        for (let i = 0; i < 20; i++) {
            if (i === 8) reasign = callAs(ADMIN, 'select public.set_live_director($1, $2)', [m, OWNER]);
            calls.push(rpcApply(m, [ev('goal_against', 1, 100 + i * 10)], COACH));
        }
        const re = await reasign!;
        const res = await Promise.all(calls);
        expect(re.ok, `set_live_director: ${re.msg}`).toBe(true);
        for (const r of res) expect(r.ok || r.hint === 'NOT_DIRECTOR', `inesperado [${r.code}/${r.hint}] ${r.msg}`).toBe(true);
        const aceptados = res.filter((r) => r.ok).length;
        expect(await countRows(`select count(*) n from public.match_live_events where match_id = $1 and type = 'goal_against'`, [m])).toBe(aceptados);
        const escritores = (await adm(`select distinct created_by from public.match_live_events where match_id = $1 and type = 'goal_against'`, [m])).rows;
        expect(escritores.every((r: any) => r.created_by === COACH)).toBe(true);
        // tras la reasignacion, el director viejo ya no escribe y el nuevo si
        const tarde = await rpcApply(m, [ev('goal_against', 1, 500)], COACH);
        expect(tarde.hint).toBe('NOT_DIRECTOR');
        expect((await adm('select director_id from public.match_live where match_id = $1', [m])).rows[0].director_id).toBe(OWNER);
        expect((await rpcApply(m, [ev('goal_against', 1, 510)], OWNER)).ok).toBe(true);
        console.log(`CT1: ${aceptados} aceptados, ${20 - aceptados} NOT_DIRECTOR`);
    }, T);
});

describe('CT1b inicio simultaneo (advisory lock de start_live_match)', () => {
    it('4 inicios a la vez (2 usuarios): ningun 23505, una sola fila de match_live y de periodos', async () => {
        for (let it = 0; it < 5; it++) {
            const m = await newMatch();
            const res = await Promise.all([rpcStart(m, COACH), rpcStart(m, ADMIN), rpcStart(m, COACH), rpcStart(m, ADMIN)]);
            for (const r of res) {
                expect(r.code, `23505 filtrado al cliente: ${r.msg}`).not.toBe('23505');
                expect(r.ok, `[${r.code}/${r.hint}] ${r.msg}`).toBe(true);
            }
            expect(await countRows('select count(*) n from public.match_live where match_id = $1', [m])).toBe(1);
            expect(await countRows('select count(*) n from public.match_live_periods where match_id = $1', [m])).toBe(2);
            for (const r of res) expect(r.data.status).toBe('not_started');
        }
    }, T);
});

describe('CT2 doble evento', () => {
    it('50 llamadas simultaneas con el MISMO client_event_id por 2 conexiones: 1 fila, mismo estado, sin 23505', async () => {
        const m = await newMatch();
        await kickoff(m);
        const cid = randomUUID();
        const res = await Promise.all(Array.from({ length: 50 }, () => rpcApply(m, [ev('goal_against', 1, 300, { cid })], COACH, pool2)));
        for (const r of res) {
            expect(r.code, `23505 filtrado: ${r.msg}`).not.toBe('23505');
            expect(r.ok, `[${r.code}/${r.hint}] ${r.msg}`).toBe(true);
        }
        expect(await countRows('select count(*) n from public.match_live_events where match_id = $1 and client_event_id = $2', [m, cid])).toBe(1);
        expect(res.filter((r) => r.data.applied.length === 1).length).toBe(1);
        expect(res.filter((r) => r.data.duplicates.includes(cid)).length).toBe(49);
        for (const r of res) expect(r.data.state.events.filter((e: any) => e.client_event_id === cid).length).toBe(1);
    }, T);

    it('lo mismo con 10 conexiones y un lote de 3 eventos con ids repetidos entre llamadas', async () => {
        const m = await newMatch();
        await kickoff(m);
        const ids = [randomUUID(), randomUUID(), randomUUID()];
        const lote = () => ids.map((cid, i) => ev('goal_against', 1, 200 + i * 10, { cid }));
        const res = await Promise.all(Array.from({ length: 30 }, () => rpcApply(m, lote())));
        for (const r of res) expect(r.ok, `[${r.code}/${r.hint}] ${r.msg}`).toBe(true);
        expect(await countRows(`select count(*) n from public.match_live_events where match_id = $1 and type = 'goal_against'`, [m])).toBe(3);
    }, T);
});

describe('CT3 mismo cambio con llaves distintas / mismo id con otro contenido', () => {
    it('dos toques del mismo cambio con dos client_event_id: uno entra, el otro NOT_ON_FIELD; no hay doble minuto', async () => {
        for (let it = 0; it < 5; it++) {
            const m = await newMatch();
            await kickoff(m);
            const [a, b] = await Promise.all([rpcApply(m, [sub(600, 12, 1)]), rpcApply(m, [sub(600, 12, 1)])]);
            expect([a.ok, b.ok].filter(Boolean).length, `a=[${a.hint}] b=[${b.hint}]`).toBe(1);
            const perdedor = a.ok ? b : a;
            expect(['NOT_ON_FIELD', 'ALREADY_ON_FIELD']).toContain(perdedor.hint);
            expect(await countRows(`select count(*) n from public.match_live_events where match_id = $1 and type = 'sub'`, [m])).toBe(1);
            const st = await stints(m);
            const c1 = st.filter((s: any) => s.subject_id === CHILD(1));
            const c12 = st.filter((s: any) => s.subject_id === CHILD(12));
            expect(c1.map((s: any) => [s.in_second, s.out_second])).toEqual([[0, 600]]);
            expect(c12.map((s: any) => [s.in_second, s.out_second])).toEqual([[600, null]]);
        }
    }, T);

    it('mismo client_event_id con contenido distinto en paralelo: uno entra, el otro CLIENT_EVENT_ID_REUSED', async () => {
        const m = await newMatch();
        await kickoff(m);
        const cid = randomUUID();
        const [a, b] = await Promise.all([rpcApply(m, [sub(600, 12, 1, cid)]), rpcApply(m, [sub(700, 13, 2, cid)])]);
        expect([a.ok, b.ok].filter(Boolean).length, `a=[${a.hint}] b=[${b.hint}]`).toBe(1);
        expect((a.ok ? b : a).hint).toBe('CLIENT_EVENT_ID_REUSED');
        expect(await countRows('select count(*) n from public.match_live_events where match_id = $1 and client_event_id = $2', [m, cid])).toBe(1);
        // y en serie: el mismo id con otro minuto tambien se rechaza; el reenvio exacto es idempotente
        const ganador = (await adm('select period_second from public.match_live_events where match_id = $1 and client_event_id = $2', [m, cid])).rows[0].period_second;
        expect((await rpcApply(m, [sub(ganador + 5, ganador === 600 ? 12 : 13, ganador === 600 ? 1 : 2, cid)])).hint).toBe('CLIENT_EVENT_ID_REUSED');
        const igual = await rpcApply(m, [ganador === 600 ? sub(600, 12, 1, cid) : sub(700, 13, 2, cid)]);
        expect(igual.ok && igual.data.duplicates.includes(cid)).toBe(true);
    }, T);
});

describe('CT4 finish_live_match en paralelo', () => {
    async function partidoJugado() {
        const m = await newMatch();
        await kickoff(m);
        mustOk(await rpcApply(m, [sub(600, 12, 1), ev('goal', 1, 900, { subj: 2, rel: 3 }), ev('period_end', 1, 2700)]), 'lote base');
        return m;
    }

    it('finish x10: un solo informe, un solo espejo, mismos minutos', async () => {
        const m = await partidoJugado();
        const res = await Promise.all(Array.from({ length: 10 }, () => rpcFinish(m, 1, 0)));
        for (const r of res) expect(r.ok, `[${r.code}/${r.hint}] ${r.msg}`).toBe(true);
        expect(await countRows('select count(*) n from public.match_reports where match_id = $1', [m])).toBe(1);
        expect(await countRows(`select count(*) n from public.football_match_events where source_type = 'team_match' and source_id = $1 and live_event_id is not null`, [m])).toBe(2);   // gol + asistencia
        expect(await countRows(`select count(*) n from public.match_live_events where match_id = $1 and type = 'match_end'`, [m])).toBe(1);
        const r0 = (await adm('select status from public.match_live where match_id = $1', [m])).rows[0];
        expect(r0.status).toBe('finished');
        const ref = JSON.stringify(minutesByChild(res[0].data));
        for (const r of res) expect(JSON.stringify(minutesByChild(r.data))).toBe(ref);
        const mins = minutesByChild(res[0].data);
        expect(mins[CHILD(1)]).toBe(10);
        expect(mins[CHILD(12)]).toBe(35);
        expect(mins[CHILD(2)]).toBe(45);
        const mr = (await adm('select status, home_score, away_score from public.match_results where id = $1', [m])).rows[0];
        expect([mr.status, mr.home_score, mr.away_score]).toEqual(['played', 1, 0]);
    }, T);

    it('publicar el informe y terminar a la vez (x6): sin deadlock; los minutos publicados = los de los tramos', async () => {
        for (let it = 0; it < 6; it++) {
            const m = await partidoJugado();
            await adm(`insert into public.match_reports (match_id, school_id, summary, development, coach_id)
                       values ($1, $2, 'Borrador del entrenador', 'Desarrollo del entrenador', $3)`, [m, SCHOOL, COACH]);
            const res = await Promise.all([rpcFinish(m, 1, 0), rpcPublish(m, true), rpcPublish(m, true), rpcFinish(m, 1, 0)]);
            for (const r of res) {
                expect(['40P01', '40001'], `deadlock/serializacion: ${r.msg}`).not.toContain(r.code);
                expect(r.ok, `[${r.code}/${r.hint}] ${r.msg}`).toBe(true);
            }
            const rep = (await adm('select published_at, summary from public.match_reports where match_id = $1', [m])).rows[0];
            expect(rep.published_at).not.toBeNull();
            expect(rep.summary).toBe('Borrador del entrenador');   // el borrador automatico no pisa lo escrito
            const mp = (await adm(`select mlp.subject_id, mlp.minutes_played from public.match_lineup_players mlp
                                    join public.match_lineups ml on ml.id = mlp.lineup_id
                                   where ml.source_type = 'team_match' and ml.source_id = $1`, [m])).rows;
            const byId = Object.fromEntries(mp.map((r: any) => [r.subject_id, r.minutes_played]));
            expect([byId[CHILD(1)], byId[CHILD(12)], byId[CHILD(2)]]).toEqual([10, 35, 45]);
        }
    }, T);
});

describe('CT5 eventos fuera de orden', () => {
    it('lote A (seg 900) antes/despues/en paralelo con lote B (seg 300): mismos tramos y minutos', async () => {
        const A = () => [sub(900, 12, 1)];
        const B = () => [sub(300, 13, 2)];
        const cierre = () => [ev('period_end', 1, 2700)];
        const X = await newMatch(); const Y = await newMatch(); const Z = await newMatch(); const W = await newMatch();
        for (const m of [X, Y, Z, W]) await kickoff(m);
        mustOk(await rpcApply(X, A()), 'X.A'); mustOk(await rpcApply(X, B()), 'X.B');            // A llega primero
        mustOk(await rpcApply(Y, B()), 'Y.B'); mustOk(await rpcApply(Y, A()), 'Y.A');            // en orden
        const par = await Promise.all([rpcApply(Z, A()), rpcApply(Z, B())]);                      // a la vez
        par.forEach((r, i) => mustOk(r, `Z.${i}`));
        mustOk(await rpcApply(W, [...A(), ...B()]), 'W');                                         // mismo lote, desordenado
        for (const m of [X, Y, Z, W]) mustOk(await rpcApply(m, cierre()), 'period_end');
        const ref = JSON.stringify(await stints(X));
        const esperado = [[CHILD(1), 0, 900], [CHILD(12), 900, 2700], [CHILD(2), 0, 300], [CHILD(13), 300, 2700]];
        const filas = await stints(X);
        for (const [id, i, o] of esperado) {
            expect(filas.some((s: any) => s.subject_id === id && s.in_second === i && s.out_second === o), `falta tramo ${id} ${i}-${o}`).toBe(true);
        }
        for (const m of [Y, Z, W]) expect(JSON.stringify(await stints(m))).toBe(ref);
        const rx = minutesByChild((mustOk(await rpcReport(X), 'report X')).data);
        for (const m of [Y, Z, W]) expect(minutesByChild((mustOk(await rpcReport(m), 'report')).data)).toEqual(rx);
        expect(rx[CHILD(1)]).toBe(15); expect(rx[CHILD(12)]).toBe(30); expect(rx[CHILD(2)]).toBe(5); expect(rx[CHILD(13)]).toBe(40);
    }, T);
});

describe('CT6 save_match_roster vs primer period_start', () => {
    it('20 carreras: si gana el pitazo la reconvocatoria da LIVE_STARTED; si gana ella, el pitazo lee los titulares nuevos; sin tramos huerfanos', async () => {
        // reconvocatoria: c15 titular (dorsal 15) en lugar de c11, que pasa a banca
        const roster = [
            ...Array.from({ length: 10 }, (_, i) => ({ subject_type: 'child', subject_id: CHILD(i + 1), role: 'starter', jersey_number: i + 1 })),
            { subject_type: 'child', subject_id: CHILD(15), role: 'starter', jersey_number: 15 },
            ...[11, 12, 13, 14].map((n) => ({ subject_type: 'child', subject_id: CHILD(n), role: 'bench', jersey_number: n })),
        ];
        const resumen = { pitazo: 0, reconvocatoria: 0, ambos: 0 };
        for (let it = 0; it < 20; it++) {
            const m = await newMatch();
            mustOk(await rpcStart(m), 'start');
            const guardar = () => callAs(COACH, 'select public.save_match_roster($1, $2::jsonb)', [m, JSON.stringify(roster)]);
            const pitazo = () => rpcApply(m, [ev('period_start', 1, 0)]);
            const [r, p] = it % 2 ? await Promise.all([guardar(), pitazo()]) : (await Promise.all([pitazo(), guardar()])).reverse() as [Res, Res];
            expect(p.ok, `period_start [${p.code}/${p.hint}] ${p.msg}`).toBe(true);
            expect(r.ok || r.hint === 'LIVE_STARTED', `save_match_roster inesperado [${r.code}/${r.hint}] ${r.msg}`).toBe(true);
            const huerfanos = await countRows(`select count(*) n from public.match_player_stints s
                                                where s.match_id = $1 and not exists (
                                                  select 1 from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id
                                                   where ml.source_type = 'team_match' and ml.source_id = s.match_id and mlp.subject_id = s.subject_id)`, [m]);
            expect(huerfanos, `iteracion ${it}: tramos huerfanos`).toBe(0);
            const titulares = (await adm(`select mlp.subject_id from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id
                                           where ml.source_type = 'team_match' and ml.source_id = $1 and mlp.role = 'starter' order by 1`, [m])).rows.map((x: any) => x.subject_id);
            const enCancha = (await adm('select subject_id from public.match_player_stints where match_id = $1 and in_second = 0 order by 1', [m])).rows.map((x: any) => x.subject_id);
            expect(enCancha, `iteracion ${it}: el pitazo no leyo a los titulares finales`).toEqual(titulares);
            if (r.ok) resumen.reconvocatoria++; else resumen.pitazo++;
            resumen.ambos++;
        }
        console.log(`CT6: gano la reconvocatoria ${resumen.reconvocatoria}, gano el pitazo ${resumen.pitazo} de ${resumen.ambos}`);
    }, T);
});

describe('CT7 void_live_event vs apply_live_events', () => {
    it('eventos dependientes (x8): un orden serial valido (void ok + NOT_ON_FIELD, o apply ok + DEPENDENT_EVENTS); nunca ambos ok ni ambos fallan', async () => {
        const resumen = { voidPrimero: 0, applyPrimero: 0 };
        for (let it = 0; it < 8; it++) {
            const m = await newMatch();
            await kickoff(m);
            const s1 = mustOk(await rpcApply(m, [sub(600, 12, 1)]), 'S1').data.applied[0] as string;
            const [v, a] = await Promise.all([rpcVoid(m, s1), rpcApply(m, [sub(900, 13, 12)])]);   // S2 saca a c12, que solo esta en cancha por S1
            const estado = (await adm('select public._live_state_json($1) as s', [m])).rows[0].s;
            expect(estado.warnings.some((w: any) => w.code === 'REPLAY_ERROR'), `iteracion ${it}: estado intermedio (REPLAY_ERROR)`).toBe(false);
            const st = await stints(m);
            if (v.ok) {
                expect(a.ok, `void ok pero apply tambien [${a.hint}]`).toBe(false);
                expect(a.hint).toBe('NOT_ON_FIELD');
                expect(st.some((s: any) => s.subject_id === CHILD(12))).toBe(false);
                resumen.voidPrimero++;
            } else {
                expect(v.hint, `void fallo con [${v.code}/${v.hint}] ${v.msg}`).toBe('DEPENDENT_EVENTS');
                expect(a.ok, `apply fallo con [${a.hint}] ${a.msg}`).toBe(true);
                expect(st.filter((s: any) => s.subject_id === CHILD(13)).map((s: any) => s.in_second)).toEqual([900]);
                resumen.applyPrimero++;
            }
        }
        console.log(`CT7: void primero ${resumen.voidPrimero}, apply primero ${resumen.applyPrimero}`);
    }, T);

    it('eventos independientes (x8): ambos entran y no hay DEPENDENT_EVENTS espurio', async () => {
        for (let it = 0; it < 8; it++) {
            const m = await newMatch();
            await kickoff(m);
            const s1 = mustOk(await rpcApply(m, [sub(600, 12, 1)]), 'S1').data.applied[0] as string;
            const [v, a] = await Promise.all([rpcVoid(m, s1), rpcApply(m, [ev('goal_against', 1, 1000)])]);
            expect(v.ok, `void [${v.code}/${v.hint}] ${v.msg}`).toBe(true);
            expect(a.ok, `apply [${a.code}/${a.hint}] ${a.msg}`).toBe(true);
            expect(await countRows(`select count(*) n from public.match_live_events where match_id = $1 and type = 'goal_against' and voided_at is null`, [m])).toBe(1);
            expect((await stints(m)).some((s: any) => s.subject_id === CHILD(12))).toBe(false);
        }
    }, T);
});
