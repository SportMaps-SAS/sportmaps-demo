// ============================================================================
// Invita a TODAS las fichas activas sin cuenta (unregistered_athletes) de
// Monster´s Volley Club, replicando exactamente la decisión acudiente/atleta
// de frontend/src/lib/invitations/contactoFicha.ts (invitacionParaAtleta) y el
// mismo insert que haría create_invitation — pero por service role, porque no
// hay una sesión de auth.uid() real de un admin de Monster para llamar la RPC
// (mismo patrón que scripts/carmel-invitar-entrenadores.mjs y
// scripts/monster-reenviar-invitaciones-entrenadores.mjs).
//
// Por ficha:
//   1. invitations  (email, school_id, role_to_assign, invited_by, child_name,
//      branch_id, parent_phone, status='pending') — misma fila que create_invitation,
//      con el rol resuelto como lo haría _invitacion_ficha_es_de_acudiente:
//      MENOR (o sin fecha de nacimiento pero con acudiente cargado) -> 'parent'
//      + guardian_email; ADULTO -> 'athlete' + email propio.
//   2. unregistered_athletes.invitation_id = esa invitación (para que
//      accept_invitation_pro adopte la ficha en vez de crear un hijo duplicado).
//   3. correo real vía la Edge Function send-email, en lotes de 100 (límite de
//      Resend por llamada a /emails/batch — NO es cuota diaria, Resend está en
//      plan Pro: 50.000/mes sin tope diario).
//
// Se salta: fichas inactivas, ya vinculadas a un perfil (linked_profile_id),
// sin ningún contacto por correo válido (solo-teléfono queda fuera: esto es
// correo, no SMS/WhatsApp), y cualquiera que YA tenga una invitación pending o
// accepted con la misma clave (escuela, correo, rol, nombre del niño) — no se
// duplica.
//
// Uso:
//   node scripts/monster-invitar-fichas-sin-cuenta.mjs            (dry-run)
//   node scripts/monster-invitar-fichas-sin-cuenta.mjs --confirmar
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIRMAR = process.argv.includes('--confirmar');

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, 'bff/.env'), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
);
const BASE = (env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en bff/.env');
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const SCHOOL_ID = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const REGISTRATION_ORIGIN = 'https://app.sportmaps.co';
const RESEND_BATCH_LIMIT = 100;
const DELAY_MS = 1500;

// ── Réplica exacta de frontend/src/lib/invitations/contactoFicha.ts ─────────
const limpio = (s) => { const t = String(s ?? '').trim(); return t ? t : null; };
const correoValido = (s) => {
  const t = limpio(s)?.toLowerCase() ?? null;
  if (!t) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
};
const hoyLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

function esMenorDeEdad(fechaNacimiento, hoy) {
  const f = limpio(fechaNacimiento)?.slice(0, 10);
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  const [y, m, d] = hoy.split('-').map(Number);
  const mayoria = `${String(y - 18).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return f > mayoria;
}

function fichaVaAlAcudiente(ficha, hoy) {
  const menor = esMenorDeEdad(ficha.date_of_birth, hoy);
  if (menor !== null) return menor;
  return !!(limpio(ficha.guardian_email) || limpio(ficha.guardian_phone) || limpio(ficha.guardian_full_name));
}

/** { role, email, childName } o null si no hay a quién escribirle por correo. */
function planDeInvitacion(ficha, hoy) {
  if (fichaVaAlAcudiente(ficha, hoy)) {
    const email = correoValido(ficha.guardian_email);
    if (!email) return null; // nunca se invita al niño como "acudiente"
    return { role: 'parent', email, childName: limpio(ficha.full_name) };
  }
  const email = correoValido(ficha.email);
  if (!email) return null;
  return { role: 'athlete', email, childName: limpio(ficha.full_name) };
}

async function rest(pathAndQuery, init = {}) {
  const res = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, { headers: HEADERS, ...init });
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathAndQuery} -> ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enviarLoteConReintento(batch, maxAttempts = 3) {
  let lastError = '', lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${BASE}/functions/v1/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ batch }),
    });
    const text = await res.text();
    lastStatus = res.status;
    if (res.ok) {
      const parsed = JSON.parse(text);
      return { ok: true, results: parsed.results || [] };
    }
    lastError = text;
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt === maxAttempts) return { ok: false, error: text, status: res.status };
    await sleep(2000 * Math.pow(2, attempt - 1));
  }
  return { ok: false, error: lastError, status: lastStatus };
}

async function main() {
  console.log(`Modo: ${CONFIRMAR ? 'CONFIRMAR (crea invitaciones y envía correos)' : 'DRY-RUN (no se escribe nada)'}\n`);

  const [school] = await rest(`schools?id=eq.${SCHOOL_ID}&select=id,name,owner_id`);
  if (!school) throw new Error('No se encontró la escuela');
  const INVITED_BY = school.owner_id;
  console.log(`Escuela: ${school.name} (${SCHOOL_ID})`);

  const operational = await fetch(`${BASE}/rest/v1/rpc/school_is_operational`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify({ p_school_id: SCHOOL_ID }),
  }).then((r) => r.json());
  if (operational !== true) throw new Error(`school_is_operational() = ${operational} — escuela bloqueada, no se invita.`);

  const fichas = await rest(
    `unregistered_athletes?school_id=eq.${SCHOOL_ID}&is_active=eq.true&linked_profile_id=is.null` +
    `&select=id,full_name,email,phone,date_of_birth,guardian_full_name,guardian_email,guardian_phone,branch_id,invitation_id`,
  );
  console.log(`Fichas activas sin cuenta: ${fichas.length}\n`);

  const existentes = await rest(
    `invitations?school_id=eq.${SCHOOL_ID}&status=in.(pending,accepted)&select=email,role_to_assign,child_name`,
  );
  const clave = (email, role, childName) =>
    `${(email || '').trim().toLowerCase()}|${role}|${(childName || '').trim().toLowerCase()}`;
  const yaInvitadas = new Set(existentes.map((i) => clave(i.email, i.role_to_assign, i.child_name)));

  const hoy = hoyLocal();
  const porInvitar = [];
  let sinContacto = 0, yaTieneInvitacion = 0, yaVinculadaIdFicha = 0;

  for (const ficha of fichas) {
    if (ficha.invitation_id) { yaVinculadaIdFicha++; continue; }
    const plan = planDeInvitacion(ficha, hoy);
    if (!plan) { sinContacto++; continue; }
    if (yaInvitadas.has(clave(plan.email, plan.role, plan.childName))) { yaTieneInvitacion++; continue; }
    porInvitar.push({ ficha, ...plan });
  }

  const porRol = porInvitar.reduce((acc, p) => { acc[p.role] = (acc[p.role] || 0) + 1; return acc; }, {});
  console.log(`A invitar: ${porInvitar.length} (parent: ${porRol.parent || 0}, athlete: ${porRol.athlete || 0})`);
  console.log(`Saltadas — sin correo válido: ${sinContacto} · ya con invitation_id en la ficha: ${yaVinculadaIdFicha} · ya invitadas (pending/accepted): ${yaTieneInvitacion}\n`);

  console.log('Primeras 10:');
  for (const p of porInvitar.slice(0, 10)) {
    console.log(`  - [${p.role}] ${p.childName} <${p.email}>`);
  }
  console.log('');

  if (!CONFIRMAR) {
    console.log('(dry-run: no se creó ninguna invitación ni se envió ningún correo)');
    return;
  }

  // ── 1 y 2. Crear invitation + vincular la ficha ──────────────────────────
  const creadas = [];
  let fallosCreacion = 0;
  for (const p of porInvitar) {
    try {
      const [inv] = await rest('invitations', {
        method: 'POST',
        headers: { ...HEADERS, Prefer: 'return=representation' },
        body: JSON.stringify({
          email: p.email, school_id: SCHOOL_ID, role_to_assign: p.role,
          invited_by: INVITED_BY, child_name: p.childName,
          branch_id: p.ficha.branch_id || null,
          parent_phone: p.role === 'parent' ? (p.ficha.guardian_phone || null) : (p.ficha.phone || null),
          status: 'pending',
        }),
      });
      await rest(`unregistered_athletes?id=eq.${p.ficha.id}&linked_profile_id=is.null`, {
        method: 'PATCH', headers: HEADERS, body: JSON.stringify({ invitation_id: inv.id }),
      });
      creadas.push({ id: inv.id, email: p.email, role: p.role, childName: p.childName });
    } catch (err) {
      fallosCreacion++;
      console.error(`  ERROR creando invitación de ${p.childName} <${p.email}>: ${err.message}`);
    }
  }
  console.log(`\nInvitaciones creadas: ${creadas.length} (errores: ${fallosCreacion})\n`);

  // ── 3. Correos en lotes de 100 ───────────────────────────────────────────
  let enviados = 0, fallidos = 0;
  for (let i = 0; i < creadas.length; i += RESEND_BATCH_LIMIT) {
    const slice = creadas.slice(i, i + RESEND_BATCH_LIMIT);
    const batch = slice.map((inv) => {
      const registrationUrl = `${REGISTRATION_ORIGIN}/register?email=${encodeURIComponent(inv.email)}&role=${inv.role}&invite=${inv.id}`;
      return inv.role === 'athlete'
        ? { type: 'athlete_invitation', to: inv.email, data: { schoolName: school.name, athleteName: inv.childName || '', registrationUrl } }
        : { type: 'parent_invitation', to: inv.email, data: { schoolName: school.name, childName: inv.childName || '', registrationUrl } };
    });

    const result = await enviarLoteConReintento(batch);
    if (result.ok) {
      enviados += slice.length;
      console.log(`  Lote ${i / RESEND_BATCH_LIMIT + 1}: ${slice.length} enviados`);
    } else {
      fallidos += slice.length;
      console.error(`  Lote ${i / RESEND_BATCH_LIMIT + 1} FALLÓ (${result.status}): ${(result.error || '').slice(0, 200)}`);
      if (result.status && result.status !== 429 && result.status < 500) {
        console.error('  Se detiene: Resend rechazó el lote (no es rate-limit).');
        break;
      }
    }
    if (i + RESEND_BATCH_LIMIT < creadas.length) await sleep(DELAY_MS);
  }

  console.log(`\nTotal: ${creadas.length} invitaciones creadas · ${enviados} correos enviados · ${fallidos} fallidos`);
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
