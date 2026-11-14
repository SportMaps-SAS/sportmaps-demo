#!/usr/bin/env node
// ============================================================
// SportMaps — Agrega UN entrenador del catálogo al tenant demo
// "Club Campestre Demo" sin volver a correr el seed completo.
//
// Reproduce solo los pasos de seed.mjs que tocan a ese entrenador:
//   1. cuenta de auth (Demo2026!, correo confirmado) → el trigger crea el profile
//   2. profiles (rol coach legacy + role_id del catálogo, is_demo, onboarding hecho)
//   3. school_members (role coach, branch de su disciplina)
//   4. school_staff (UNIQUE email+school_id, coach_auth_id = profile)
//   5. teams.coach_id + team_coaches + offering_coaches para sus categorías
//
// Idempotente: ids deterministas (mismo duid() que seed.mjs) y UPSERT. Nunca borra.
//
// Uso:
//   node scripts/demo-club-campestre/add-coach.mjs                 # coach_futbol
//   node scripts/demo-club-campestre/add-coach.mjs coach_futbol --dry-run
// ============================================================

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COACHES, DISCIPLINAS } from './catalog.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'Demo2026!';
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const KEY = argv.find((a) => !a.startsWith('--')) || 'coach_futbol';

const env = Object.fromEntries(
    readFileSync(join(ROOT, 'bff', '.env'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);
const SB_URL = env.SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en bff/.env'); process.exit(1); }
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

// Mismo duid() que seed.mjs: sin esto los ids no coinciden con los del tenant.
const NS = 'sportmaps::demo::club-campestre::';
function duid(key) {
    const b = Buffer.from(createHash('sha1').update(NS + key).digest().subarray(0, 16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const SCHOOL_ID = duid('school');
const branchId = (d) => duid(`branch:${d}`);
const offeringId = (d) => duid(`offering:${d}`);
const teamId = (d, c) => duid(`team:${d}:${c}`);
const D = Object.fromEntries(DISCIPLINAS.map((d) => [d.key, d]));

async function rest(path, { method = 'GET', body, prefer } = {}) {
    const headers = { ...H };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 600)}`);
    try { return text ? JSON.parse(text) : null; } catch { return text; }
}
async function upsert(table, rows, onConflict = 'id') {
    if (DRY) { console.log(`  [dry] upsert ${table} × ${rows.length}`, JSON.stringify(rows).slice(0, 300)); return; }
    await rest(`${table}?on_conflict=${onConflict}`, { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal' });
}

async function ensureUser({ email, full_name, role, phone }) {
    const found = await rest(`profiles?select=id&email=eq.${encodeURIComponent(email)}&limit=1`);
    if (found.length) {
        if (!DRY) await fetch(`${SB_URL}/auth/v1/admin/users/${found[0].id}`, { method: 'PUT', headers: H, body: JSON.stringify({ password: PASSWORD, email_confirm: true }) });
        return { id: found[0].id, created: false };
    }
    if (DRY) return { id: duid(`user:${email}`), created: true };
    const res = await fetch(`${SB_URL}/auth/v1/admin/users`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name, role, phone } }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.id) return { id: json.id, created: true };
    throw new Error(`No se pudo crear ${email}: ${JSON.stringify(json).slice(0, 300)}`);
}

async function main() {
    const c = COACHES.find((x) => x.key === KEY);
    if (!c) throw new Error(`No hay entrenador "${KEY}" en catalog.mjs`);
    console.log(`Entrenador ${c.full_name} <${c.email}> → ${SCHOOL_ID}${DRY ? ' (dry-run)' : ''}`);

    // Guardas: la escuela debe ser la demo y las categorías deben existir.
    const school = await rest(`schools?id=eq.${SCHOOL_ID}&select=id,name,is_demo`);
    if (!school[0]?.is_demo) throw new Error('La escuela destino no es is_demo=true: abortado');
    for (const t of c.teams) {
        const row = await rest(`teams?id=eq.${teamId(t.disciplina, t.cat)}&school_id=eq.${SCHOOL_ID}&select=id,name,coach_id`);
        if (!row[0]) throw new Error(`No existe la categoría ${t.disciplina}/${t.cat} en el club`);
        console.log(`  · categoría ${row[0].name} (${row[0].id}) coach_id actual: ${row[0].coach_id ?? 'ninguno'}`);
    }

    // 1-2. Cuenta + perfil
    const u = await ensureUser({ email: c.email, full_name: c.full_name, role: c.signup_role, phone: c.phone });
    console.log(`  ✓ auth ${u.created ? 'creado' : 'existía'} · ${u.id}`);
    const roles = await rest('roles?select=id,name&name=eq.coach');
    await upsert('profiles', [{
        id: u.id, full_name: c.full_name, phone: c.phone, is_demo: true,
        role: 'coach', role_id: roles[0]?.id ?? null,
        onboarding_completed: true, needs_role_selection: false,
    }]);
    console.log('  ✓ profiles');

    // 3. Miembro de la escuela
    await upsert('school_members', [{
        id: duid(`member:${c.key}`), school_id: SCHOOL_ID, profile_id: u.id,
        role: c.member_role, status: 'active', branch_id: branchId(c.branch),
    }]);
    console.log('  ✓ school_members (coach)');

    // 4. Ficha de staff (teams.coach_id apunta a school_staff.id)
    await upsert('school_staff', [{
        school_id: SCHOOL_ID, branch_id: branchId(c.branch),
        full_name: c.full_name, email: c.email, phone: c.phone,
        specialty: c.specialty, status: 'active', coach_auth_id: u.id,
    }], 'email,school_id');
    const staff = DRY ? [{ id: duid(`staff:${c.key}`) }]
        : await rest(`school_staff?school_id=eq.${SCHOOL_ID}&email=eq.${encodeURIComponent(c.email)}&select=id`);
    const staffId = staff[0].id;
    console.log(`  ✓ school_staff · ${staffId}`);

    // 5. Categorías
    const teamPatch = []; const tCoaches = []; const oCoaches = [];
    for (const t of c.teams) {
        const cat = D[t.disciplina].categorias.find((x) => x.key === t.cat);
        teamPatch.push({ id: teamId(t.disciplina, t.cat), coach_id: staffId, school_id: SCHOOL_ID, name: `${D[t.disciplina].name} — ${cat.name}`, sport: D[t.disciplina].sport });
        tCoaches.push({ id: duid(`tcoach:${c.key}:${t.disciplina}:${t.cat}`), team_id: teamId(t.disciplina, t.cat), coach_id: staffId, school_id: SCHOOL_ID });
    }
    for (const dk of [...new Set(c.teams.map((t) => t.disciplina))]) {
        oCoaches.push({ id: duid(`ocoach:${c.key}:${dk}`), offering_id: offeringId(dk), coach_id: staffId, school_id: SCHOOL_ID });
    }
    await upsert('teams', teamPatch);
    await upsert('team_coaches', tCoaches);
    await upsert('offering_coaches', oCoaches);
    console.log(`  ✓ teams.coach_id + team_coaches (${tCoaches.length}) + offering_coaches (${oCoaches.length})`);
    console.log(`Listo. Login: ${c.email} / ${PASSWORD}`);
}

main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
