// Helpers T2 (QA del frontend de reservas) contra el GEMELO LOCAL. Datos con prefijo t2-.
//  - Vite propio en 5174 + BFF propio en 3102 arrancados con entorno explicito (ver docs/qa-gemelo-local.md).
//  - assertNotProduction() + assertLocal(): aborta si algo apunta a produccion.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { assertNotProduction, PROD_SUPABASE_REF } from '../helpers/guard-no-prod';

export const SUPA = process.env.QA_TWIN_SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const ANON = process.env.QA_TWIN_ANON_KEY
    ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
// Llave service_role de DEMO de la CLI de Supabase (igual en toda maquina, no es secreta).
export const SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
export const BFF = process.env.QA_T2_BFF_URL ?? 'http://127.0.0.1:3102';
export const BASE_URL = process.env.QA_T2_BASE_URL ?? 'http://localhost:5174';
export const PASSWORD = 'T2Reservas2026!';
export const SHOTS = process.env.QA_T2_SHOTS ?? resolve(process.cwd(), 'e2e', 'reservas', '.capturas');
const DB = 'supabase_db_sportmaps-qa-twin';

export const SCHOOL_ID = '00000000-0000-4000-b000-0000000000a2';
export const SLUG = 't2-escuela-canchas';
export const ACTORES = {
    owner: 't2-owner@qa.sportmaps.test',
    padre: 't2-padre@qa.sportmaps.test',
    menor: 't2-menor@qa.sportmaps.test',
    atleta: 't2-atleta@qa.sportmaps.test',
    externo: 't2-externo@qa.sportmaps.test',
} as const;
export type Actor = keyof typeof ACTORES;
export const NUEVO_VENUE_EMAIL = 't2-venue-nuevo@qa.sportmaps.test';

export function assertLocal(url: string, what: string) {
    const u = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) || url.includes(PROD_SUPABASE_REF) || url.includes('supabase.co')) {
        throw new Error(`ABORTADO: ${what} no es local (${url}).`);
    }
}

export function sql(q: string): string {
    assertNotProduction(); assertLocal(SUPA, 'SUPABASE');
    return execFileSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], {
        input: q, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}
export const rows = (q: string) => sql(q).split('\n').filter(Boolean).map((l) => l.split('|'));

async function adminCreate(email: string, meta: Record<string, unknown>): Promise<string> {
    const h = { 'Content-Type': 'application/json', apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
    const list = await (await fetch(`${SUPA}/auth/v1/admin/users?per_page=200`, { headers: h })).json() as { users: { id: string; email: string }[] };
    const ex = list.users.find((u) => u.email === email);
    if (ex) return ex.id;
    const r = await fetch(`${SUPA}/auth/v1/admin/users`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: meta }),
    });
    if (!r.ok) throw new Error(`crear ${email}: ${r.status} ${await r.text()}`);
    return (await r.json()).id;
}

/** Crea actores + escuela A (addon reservations, 4 canchas con tarifas, politica). Idempotente. */
export async function prepararReservas(): Promise<Record<Actor, string>> {
    assertLocal(SUPA, 'SUPABASE'); assertLocal(BFF, 'BFF');
    const ids = {} as Record<Actor, string>;
    ids.owner = await adminCreate(ACTORES.owner, { full_name: 't2 Dueno Canchas', role: 'school_admin' });
    ids.padre = await adminCreate(ACTORES.padre, { full_name: 't2 Padre Prueba', role: 'parent', phone: '3001110001' });
    ids.menor = await adminCreate(ACTORES.menor, { full_name: 't2 Menor Prueba', role: 'athlete', date_of_birth: '2014-03-01' });
    ids.atleta = await adminCreate(ACTORES.atleta, { full_name: 't2 Atleta Adulto', role: 'athlete', date_of_birth: '1995-05-05' });
    ids.externo = await adminCreate(ACTORES.externo, { full_name: 't2 Externo Cuenta', role: 'athlete', date_of_birth: '1990-01-01' });
    sql(`
      update public.profiles set date_of_birth='2014-03-01' where id='${ids.menor}';
      update public.profiles set date_of_birth='1995-05-05' where id='${ids.atleta}';
      update public.profiles set date_of_birth='1990-01-01' where id='${ids.externo}';
      update public.profiles set role='parent' where id='${ids.padre}';
      update public.profiles set onboarding_completed=true, needs_role_selection=false where id in ('${ids.padre}','${ids.menor}','${ids.atleta}','${ids.externo}','${ids.owner}');
      insert into public.schools (id, name, slug, owner_id, city, school_type, onboarding_status, onboarding_step, accepts_reservations, is_demo, sports, description)
        values ('${SCHOOL_ID}','t2 Escuela Canchas','${SLUG}','${ids.owner}','Bogota','academy','completed',5,true,false,array['futbol','padel'],'Escuela de prueba t2 con canchas')
        on conflict (id) do update set accepts_reservations=true, onboarding_status='completed', slug='${SLUG}';
      insert into public.school_members (profile_id, school_id, role, status) select '${ids.owner}','${SCHOOL_ID}','owner','active'
        where not exists (select 1 from public.school_members where profile_id='${ids.owner}' and school_id='${SCHOOL_ID}');
      update public.school_members set status='active', role='owner' where profile_id='${ids.owner}' and school_id='${SCHOOL_ID}';
      insert into public.school_members (profile_id, school_id, role, status)
        select x.p, '${SCHOOL_ID}', x.r, 'active' from (values ('${ids.padre}'::uuid,'parent'),('${ids.menor}'::uuid,'athlete'),('${ids.atleta}'::uuid,'athlete')) x(p,r)
        where not exists (select 1 from public.school_members m where m.profile_id=x.p and m.school_id='${SCHOOL_ID}');
      insert into public.school_addons (school_id, addon_key, enabled, enabled_at)
        select '${SCHOOL_ID}','reservations',true,now() where not exists (select 1 from public.school_addons where school_id='${SCHOOL_ID}' and addon_key='reservations');
      update public.school_addons set enabled=true where school_id='${SCHOOL_ID}' and addon_key='reservations';
    `);
    const mk = (name: string, type: string, by: string, enabled: boolean) => `
      insert into public.facilities (school_id,name,type,status,booking_enabled,bookable_by,capacity,slot_step_min,min_duration_min,max_duration_min,min_booking_advance_hours,available_hours)
      select '${SCHOOL_ID}','${name}','${type}','available',${enabled},'${by}',10,60,60,180,0,
        '{"monday":["06:00-22:00"],"tuesday":["06:00-22:00"],"wednesday":["06:00-22:00"],"thursday":["06:00-22:00"],"friday":["06:00-22:00"],"saturday":["06:00-22:00"],"sunday":["06:00-22:00"]}'::jsonb
      where not exists (select 1 from public.facilities where school_id='${SCHOOL_ID}' and name='${name}');`;
    sql(mk('t2 Cancha Socios', 'futbol', 'members', true) + mk('t2 Cancha Publica', 'futbol', 'public', true)
        + mk('t2 Cancha Mixta', 'padel', 'both', true) + mk('t2 Cancha Entrenamiento', 'entrenamiento', 'members', false));
    sql(`
      insert into public.facility_rates (school_id,facility_id,audience,weekdays,from_time,to_time,price_per_hour,priority,label)
      select '${SCHOOL_ID}', f.id, r.aud, array[0,1,2,3,4,5,6]::smallint[], '06:00','22:00', r.price, 0, 't2 base'
        from public.facilities f join (values
          ('t2 Cancha Socios','member',50000),('t2 Cancha Publica','public',80000),
          ('t2 Cancha Mixta','public',90000),('t2 Cancha Mixta','member',60000)) r(n,aud,price) on r.n=f.name
       where f.school_id='${SCHOOL_ID}'
         and not exists (select 1 from public.facility_rates x where x.facility_id=f.id and x.audience=r.aud and x.label='t2 base');
      insert into public.cancellation_policies (school_id, facility_id, hours_full_refund, hours_partial_refund, partial_pct, no_show_penalty_pct, is_active)
      select '${SCHOOL_ID}', null, 24, 12, 50, 100, true where not exists (select 1 from public.cancellation_policies where school_id='${SCHOOL_ID}' and facility_id is null);
    `);
    sql(`update public.facilities set status='available' where school_id='${SCHOOL_ID}' and status='active'`);
    return ids;
}

export function facilityId(name: string): string {
    return sql(`select id from public.facilities where school_id='${SCHOOL_ID}' and name='${name}'`);
}

async function token(email: string) {
    const res = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
        body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (!res.ok) throw new Error(`Login ${email}: ${res.status} ${await res.text()}`);
    return res.json();
}
export const storageKey = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;

export async function contextoComo(browser: Browser, email: string | null, opts: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
    assertLocal(BASE_URL, 'frontend');
    const ctx = await browser.newContext({ baseURL: BASE_URL, locale: 'es-CO', timezoneId: 'America/Bogota', ...opts });
    if (email) {
        const t = await token(email);
        await ctx.addInitScript(([key, value, school]) => {
            if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, value);
            if (school && !window.localStorage.getItem('sportmaps_active_school_id')) window.localStorage.setItem('sportmaps_active_school_id', school);
        }, [storageKey, JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in, expires_at: t.expires_at, token_type: 'bearer', user: t.user }), email === ACTORES.owner ? SCHOOL_ID : ''] as const);
    }
    return ctx;
}

/** Recolecta errores de consola y requests fallidos (4xx/5xx) de una pagina. */
export function vigilar(page: Page) {
    const consola: string[] = []; const fallidos: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consola.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => consola.push(`PAGEERROR ${e.message.slice(0, 300)}`));
    page.on('response', (r) => { if (r.status() >= 400 && /127\.0\.0\.1:(3102|54321)/.test(r.url())) fallidos.push(`${r.status()} ${r.request().method()} ${r.url().replace(/\?.*/, '').slice(0, 140)}`); });
    return { consola, fallidos };
}

export async function captura(page: Page, nombre: string, fullPage = false) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(SHOTS, `${nombre}.png`), fullPage });
}

/** Fecha (YYYY-MM-DD, hora Bogota) a `dias` dias de hoy. */
export function diaIso(dias: number): string {
    const d = new Date(Date.now() - 5 * 3600_000 + dias * 86400_000);
    return d.toISOString().slice(0, 10);
}
