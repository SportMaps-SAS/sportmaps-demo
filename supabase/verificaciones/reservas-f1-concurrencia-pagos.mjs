#!/usr/bin/env node
/**
 * Concurrencia de PAGOS de reservas (F1). Apúntala al GEMELO local, nunca a la base viva.
 *
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres \
 *   FACILITY_ID=<cancha bookable_by=both con entitlement, horario abierto> \
 *   ACTOR_ID=<padre adulto miembro> ACTOR2_ID=<otro padre adulto miembro> \
 *   node supabase/verificaciones/reservas-f1-concurrencia-pagos.mjs
 *
 * Usa el camino service_role del BFF (auth.uid() NULL + p_actor_profile_id).
 *   P1: el MISMO evento de pago x10 en paralelo           -> amount_paid se suma UNA vez, 9 already_processed.
 *   P2: DOS eventos distintos en paralelo, cada uno el total -> sin errores ni deadlock; ambos quedan
 *       registrados (2 x total; el sobrepago queda visible para conciliar) y la reserva queda confirmed.
 *   P3: carrera pago tardío vs. otro reservante sobre la franja de un hold vencido -> NUNCA dos ocupaciones
 *       activas; el pago nunca se pierde (o confirmed, o pending_reconciliation con amount_paid).
 * Al final cancela lo que creó. Requiere el paquete `pg` (se resuelve desde bff/node_modules).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
// `pg` vive en bff/node_modules (la raíz no lo instala): se resuelve desde ahí.
const pg = createRequire(fileURLToPath(new URL('../../bff/package.json', import.meta.url)))('pg');

const { DATABASE_URL, FACILITY_ID, ACTOR_ID, ACTOR2_ID } = process.env;
if (!DATABASE_URL || !FACILITY_ID || !ACTOR_ID || !ACTOR2_ID) {
  console.error('Faltan DATABASE_URL, FACILITY_ID, ACTOR_ID o ACTOR2_ID');
  process.exit(2);
}
if (!/127\.0\.0\.1|localhost/.test(DATABASE_URL)) {
  console.error('Solo contra el gemelo local (127.0.0.1 / localhost).');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 40 });

const dia = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10);
const slot = (hhmm) => `${dia}T${hhmm}:00-05:00`;

const reservar = async (actor, key, a, b) => {
  const { rows } = await pool.query(
    `select public.reservar_cancha($1::uuid,$2::timestamptz,$3::timestamptz,'app',$4,'online',$5::uuid) as r`,
    [FACILITY_ID, a, b, key, actor],
  );
  return rows[0].r;
};
const pagar = async (ref, monto, evento) => {
  const { rows } = await pool.query(`select public.confirmar_pago_reserva($1,$2::numeric,null,'wompi',$3) as r`, [ref, monto, evento]);
  return rows[0].r;
};
// El tope anti-acaparamiento (3 activas por reservante) obliga a soltar lo creado entre fases.
const limpiar = async () => {
  for (const actor of [ACTOR_ID, ACTOR2_ID]) {
    await pool.query(
      `select public.cancelar_reserva(id, 'prueba concurrencia pagos', $2::uuid)
         from public.facility_reservations
        where facility_id=$1 and user_id=$2 and (idempotency_key like 'pg1-%' or idempotency_key like 'pg2-%' or idempotency_key like 'pg3%')
          and status in ('hold','pending_payment','pending','confirmed','pending_reconciliation')`,
      [FACILITY_ID, actor],
    ).catch(() => {});
  }
};
let fallos = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'OK   ' : 'FALLO'} ${msg}`);
  if (!ok) fallos++;
};
const fila = async (id) =>
  (await pool.query('select status, amount_paid::numeric as paid, price::numeric as price from public.facility_reservations where id=$1', [id])).rows[0];

try {
  await limpiar();
  // ── P1: mismo evento x10 ──────────────────────────────────────────────────
  const r1 = await reservar(ACTOR_ID, `pg1-${randomUUID()}`, slot('09:00'), slot('10:00'));
  check(r1.ok, `P1: reserva creada (${r1.ok ? 'ok' : r1.error})`);
  const id1 = r1.reservation.id, ref1 = r1.reservation.payment_reference, total1 = Number(r1.reservation.price);
  const ev1 = `evt-${randomUUID()}`;
  const res1 = await Promise.all(Array.from({ length: 10 }, () => pagar(ref1, total1, ev1)));
  const f1 = await fila(id1);
  check(res1.every((r) => r.ok), `P1: las 10 llamadas responden ok (${res1.map((r) => (r.ok ? 'ok' : r.error)).join(',')})`);
  check(res1.filter((r) => r.already_processed).length === 9, `P1: 9 ya procesadas (${res1.filter((r) => r.already_processed).length})`);
  check(Number(f1.paid) === total1, `P1: amount_paid = ${total1} una sola vez (es ${f1.paid})`);
  check(f1.status === 'confirmed', `P1: confirmed (es ${f1.status})`);

  await limpiar();
  // ── P2: dos eventos distintos a la vez ────────────────────────────────────
  const r2 = await reservar(ACTOR_ID, `pg2-${randomUUID()}`, slot('11:00'), slot('12:00'));
  const id2 = r2.reservation.id, ref2 = r2.reservation.payment_reference, total2 = Number(r2.reservation.price);
  const res2 = await Promise.all([pagar(ref2, total2, `evt-${randomUUID()}`), pagar(ref2, total2, `evt-${randomUUID()}`)]);
  const f2 = await fila(id2);
  check(res2.every((r) => r.ok), `P2: ambos eventos responden ok (${res2.map((r) => (r.ok ? 'ok' : r.error)).join(',')})`);
  check(Number(f2.paid) === 2 * total2, `P2: se registran los dos pagos (amount_paid=${f2.paid}, esperado ${2 * total2})`);
  check(f2.status === 'confirmed', `P2: confirmed (es ${f2.status})`);

  await limpiar();
  // ── P3: pago tardío vs. otro reservante, 8 rondas ────────────────────────
  let resultados = [];
  for (let i = 0; i < 8; i++) {
    const h = 13 + i; // franjas 13..20, una por ronda
    const a = slot(String(h).padStart(2, '0') + ':00'), b = slot(String(h + 1).padStart(2, '0') + ':00');
    const r = await reservar(ACTOR_ID, `pg3-${randomUUID()}`, a, b);
    if (!r.ok) { check(false, `P3 ronda ${i}: no se pudo crear la reserva (${r.error})`); continue; }
    const id = r.reservation.id, ref = r.reservation.payment_reference, total = Number(r.reservation.price);
    await pool.query(`update public.facility_reservations set hold_expires_at = now() - interval '1 minute' where id=$1`, [id]);
    const [pago, rival] = await Promise.all([pagar(ref, total, `evt-${randomUUID()}`), reservar(ACTOR2_ID, `pg3r-${randomUUID()}`, a, b)]);
    const f = await fila(id);
    const { rows: act } = await pool.query(
      `select count(*)::int n from public.facility_occupancy where facility_id=$1 and slot && tstzrange($2::timestamptz,$3::timestamptz) and status='active'`,
      [FACILITY_ID, a, b],
    );
    const pagoNoPerdido = Number(f.paid) === total;
    const consistente = (f.status === 'confirmed' && !rival.ok) || (f.status === 'pending_reconciliation' && rival.ok) || (f.status === 'confirmed' && rival.ok === false);
    await limpiar();
    resultados.push(`${f.status}/${rival.ok ? 'rival ok' : rival.error}`);
    check(act[0].n <= 1 && pagoNoPerdido && consistente,
      `P3 ronda ${i}: reserva=${f.status}, rival=${rival.ok ? 'ok' : rival.error}, ocupaciones activas=${act[0].n}, pago registrado=${pagoNoPerdido}`);
  }
  console.log(`P3 desenlaces: ${resultados.join(' | ')}`);
} finally {
  await limpiar();
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
