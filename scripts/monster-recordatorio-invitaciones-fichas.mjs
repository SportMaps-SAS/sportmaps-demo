// ============================================================================
// Reenvía el correo de invitación a los acudientes/atletas de Monster´s Volley
// Club cuya invitación sigue 'pending' (no crea invitaciones nuevas: reutiliza
// el id de cada una, así el enlace de registro sigue ligado a la misma fila —
// mismo patrón que scripts/monster-reenviar-invitaciones-entrenadores.mjs).
//
// Pensado como recordatorio del lote masivo del 2026-11-05 (118 invitaciones:
// 83 parent + 35 athlete). Se salta automáticamente a quien ya aceptó o a
// quien se le venció la invitación (expires_at pasado) — no hace falta tocar
// la lista a mano entre corridas.
//
// Mismo payload que routes/invitations.routes.ts (bulk-send) y mismo registro en
// email_sends, pero con service role porque no hay una sesión de admin.
//
// Uso:
//   node scripts/monster-recordatorio-invitaciones-fichas.mjs            (simulacro)
//   node scripts/monster-recordatorio-invitaciones-fichas.mjs --confirmar
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
const FRONTEND_URL = 'https://app.sportmaps.co';
const RESEND_BATCH_LIMIT = 100;
const DELAY_MS = 1500;

async function rest(pathAndQuery, init = {}) {
  const res = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, { headers: HEADERS, ...init });
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathAndQuery} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enviarLoteConReintento(batch, maxAttempts = 3) {
  let lastError = '', lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${BASE}/functions/v1/send-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ batch }),
    });
    const text = await res.text();
    lastStatus = res.status;
    if (res.ok) return { ok: true, results: JSON.parse(text).results || [] };
    lastError = text;
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt === maxAttempts) return { ok: false, error: text, status: res.status };
    await sleep(2000 * Math.pow(2, attempt - 1));
  }
  return { ok: false, error: lastError, status: lastStatus };
}

async function main() {
  console.log(`Modo: ${CONFIRMAR ? 'CONFIRMAR (envía correos)' : 'SIMULACRO (no envía nada)'}\n`);

  const [school] = await rest(`schools?id=eq.${SCHOOL_ID}&select=name`);
  const ahora = new Date().toISOString();
  const invs = await rest(
    `invitations?school_id=eq.${SCHOOL_ID}&role_to_assign=in.(parent,athlete)&status=eq.pending` +
    `&email=not.is.null&expires_at=gt.${ahora}&select=id,email,child_name,role_to_assign,opened_at,expires_at&order=created_at.asc`,
  );
  console.log(`Escuela: ${school.name} · invitaciones parent/athlete pendientes (no vencidas): ${invs.length}\n`);

  const abiertas = invs.filter((i) => i.opened_at).length;
  console.log(`  de las cuales ya abrieron el enlace al menos una vez: ${abiertas}\n`);

  const batchId = randomUUID();
  const logRows = [];
  let enviados = 0, fallidos = 0;

  for (let i = 0; i < invs.length; i += RESEND_BATCH_LIMIT) {
    const slice = invs.slice(i, i + RESEND_BATCH_LIMIT);
    for (const inv of slice) {
      console.log(`- [${inv.role_to_assign}] ${inv.child_name || '(sin nombre)'} <${inv.email}> · invitación ${inv.id}${inv.opened_at ? ' (ya abrió)' : ''}`);
    }
    if (!CONFIRMAR) continue;

    const batch = slice.map((inv) => {
      const registrationUrl = `${FRONTEND_URL}/register?email=${encodeURIComponent(inv.email)}&role=${inv.role_to_assign}&invite=${inv.id}`;
      return inv.role_to_assign === 'athlete'
        ? { type: 'athlete_invitation', to: inv.email, data: { schoolName: school.name, athleteName: inv.child_name || '', registrationUrl } }
        : { type: 'parent_invitation', to: inv.email, data: { schoolName: school.name, childName: inv.child_name || '', registrationUrl } };
    });

    const result = await enviarLoteConReintento(batch);
    if (result.ok) {
      enviados += slice.length;
      console.log(`  Lote ${i / RESEND_BATCH_LIMIT + 1}: ${slice.length} enviados`);
      for (let j = 0; j < slice.length; j++) {
        const inv = slice[j];
        const providerId = result.results[j]?.id ?? null;
        logRows.push({
          school_id: SCHOOL_ID, invitation_id: inv.id, to_email: inv.email,
          email_type: inv.role_to_assign === 'athlete' ? 'athlete_invitation' : 'parent_invitation',
          provider: 'resend', provider_message_id: providerId, status: 'sent',
          error: null, attempts: 1, batch_id: batchId,
        });
      }
    } else {
      fallidos += slice.length;
      console.error(`  Lote ${i / RESEND_BATCH_LIMIT + 1} FALLÓ (${result.status}): ${(result.error || '').slice(0, 200)}`);
      for (const inv of slice) {
        logRows.push({
          school_id: SCHOOL_ID, invitation_id: inv.id, to_email: inv.email,
          email_type: inv.role_to_assign === 'athlete' ? 'athlete_invitation' : 'parent_invitation',
          provider: 'resend', provider_message_id: null, status: 'failed',
          error: (result.error || '').slice(0, 1000), attempts: 1, batch_id: batchId,
        });
      }
      if (result.status && result.status !== 429 && result.status < 500) {
        console.error('  Se detiene: Resend rechazó el lote (no es rate-limit).');
        break;
      }
    }
    if (i + RESEND_BATCH_LIMIT < invs.length) await sleep(DELAY_MS);
  }

  if (CONFIRMAR && logRows.length) {
    await rest('email_sends', { method: 'POST', body: JSON.stringify(logRows) });
    console.log(`\nRegistrados ${logRows.length} envíos en email_sends (lote ${batchId}).`);
  }
  if (CONFIRMAR) console.log(`\nTotal: ${enviados} enviados · ${fallidos} fallidos`);
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
