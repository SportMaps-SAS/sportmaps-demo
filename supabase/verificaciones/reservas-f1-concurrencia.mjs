#!/usr/bin/env node
/**
 * Pruebas de CONCURRENCIA de reservar_cancha (F1). NO se corre sola: apúntala al GEMELO local
 * (npm run qa:twin:up), nunca a la base viva compartida.
 *
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres \
 *   FACILITY_ID=<uuid cancha con bookable_by=both en una escuela con entitlement> \
 *   ACTOR_ID=<uuid de un perfil miembro (padre adulto) de esa escuela> \
 *   node supabase/verificaciones/reservas-f1-concurrencia.mjs
 *
 * Usa el camino service_role del BFF (auth.uid() NULL + p_actor_profile_id), igual que producción.
 *   Prueba A: 50 reservas simultáneas, MISMA franja, llaves distintas -> 1 ok, 49 SLOT_TAKEN, 1 fila.
 *   Prueba B: misma idempotency_key x10 en otra franja               -> 10 ok (1 original + 9 replay), 1 fila.
 * Al final cancela las reservas que creó. Requiere el paquete `pg`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// `pg` vive en bff/node_modules (la raíz no lo instala): se resuelve desde ahí.
const pg = createRequire(fileURLToPath(new URL('../../bff/package.json', import.meta.url)))('pg');
import { randomUUID } from 'node:crypto';

const { DATABASE_URL, FACILITY_ID, ACTOR_ID } = process.env;
if (!DATABASE_URL || !FACILITY_ID || !ACTOR_ID) {
  console.error('Faltan DATABASE_URL, FACILITY_ID o ACTOR_ID');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 60 });

const dia = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
const slot = (hhmm) => `${dia}T${hhmm}:00-05:00`; // Bogotá = UTC-5, sin horario de verano

const call = async (key, start, end) => {
  const { rows } = await pool.query(
    `select public.reservar_cancha($1::uuid,$2::timestamptz,$3::timestamptz,'app',$4,'online',$5::uuid) as r`,
    [FACILITY_ID, start, end, key, ACTOR_ID],
  );
  return rows[0].r;
};
let fallos = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'OK   ' : 'FALLO'} ${msg}`);
  if (!ok) fallos++;
};

// A. 50 simultáneas, misma franja
const keysA = Array.from({ length: 50 }, () => `conc-${randomUUID()}`);
const resA = await Promise.all(keysA.map((k) => call(k, slot('10:00'), slot('11:00'))));
const okA = resA.filter((r) => r.ok);
const tomadas = resA.filter((r) => !r.ok && r.error === 'SLOT_TAKEN');
const otros = [...new Set(resA.filter((r) => !r.ok && r.error !== 'SLOT_TAKEN').map((r) => r.error))];
check(okA.length === 1, `A: exactamente 1 gana (ganaron ${okA.length})`);
check(tomadas.length === 49, `A: 49 reciben SLOT_TAKEN (recibieron ${tomadas.length}; otros errores: ${otros.join(',') || 'ninguno'})`);
check(tomadas.every((r) => Array.isArray(r.alternatives)), 'A: todos los SLOT_TAKEN traen alternatives[]');
const { rows: fa } = await pool.query(
  `select count(*)::int n from public.facility_reservations
    where facility_id=$1 and starts_at=$2::timestamptz and status not in ('cancelled','expired')`,
  [FACILITY_ID, slot('10:00')],
);
check(fa[0].n === 1, `A: 1 sola fila vigente en la franja (hay ${fa[0].n})`);

// B. misma llave x10
const keyB = `idem-${randomUUID()}`;
const resB = await Promise.all(Array.from({ length: 10 }, () => call(keyB, slot('12:00'), slot('13:00'))));
const idsB = new Set(resB.filter((r) => r.ok).map((r) => r.reservation.id));
check(resB.every((r) => r.ok), `B: las 10 llamadas responden ok (${resB.map((r) => (r.ok ? 'ok' : r.error)).join(',')})`);
check(idsB.size === 1, `B: las 10 devuelven la MISMA reserva (${idsB.size} ids)`);
check(resB.filter((r) => r.idempotent_replay).length === 9, 'B: 9 son replay');
const { rows: fb } = await pool.query('select count(*)::int n from public.facility_reservations where idempotency_key=$1', [keyB]);
check(fb[0].n === 1, `B: 1 sola fila con esa llave (hay ${fb[0].n})`);

// limpieza
await pool.query(
  `select public.cancelar_reserva(id, 'prueba concurrencia', $2::uuid)
     from public.facility_reservations
    where facility_id=$1 and (idempotency_key like 'conc-%' or idempotency_key like 'idem-%')
      and status not in ('cancelled','expired')`,
  [FACILITY_ID, ACTOR_ID],
);
await pool.end();
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
