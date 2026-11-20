#!/usr/bin/env node
// ============================================================================
// Aplica migraciones de supabase/migrations EN EL ORDEN DADO, una por una, y
// deja rastro en supabase_migrations.schema_migrations (versión = prefijo del
// archivo). Para cuando no hay psql ni `supabase db push` utilizable.
//
// SIMULA POR DEFECTO: solo lista lo que haría. Escribe con --aplicar.
//
// Uso (PowerShell):
//   $env:SUPABASE_DB_URL = "postgresql://postgres.<ref>:<clave>@<host>:5432/postgres"
//   node scripts/aplicar-migraciones.mjs 20261009115335 20261010143743 ...            # simula
//   node scripts/aplicar-migraciones.mjs 20261009115335 20261010143743 ... --aplicar  # aplica
//
// Acepta versiones (prefijo) o nombres de archivo. Se detiene en la primera que
// falle; cada archivo trae su BEGIN…COMMIT, así que esa no queda a medias.
//
// REINTENTO POR BLOQUEO: si una migración choca con un lock (55P03, por su
// lock_timeout) o con un deadlock (40P01), espera 2, 4, 8, 16 y 30 s y la vuelve a
// correr completa (5 reintentos; cámbialo con --reintentos=N, 0 lo apaga). Solo
// reintenta cuando es seguro repetir el archivo entero:
//   · tiene un solo COMMIT (lo que falló se deshizo completo), o
//   · tiene varias transacciones pero se declara idempotente en un comentario
//     («-- … Es idempotente …»), porque los bloques que ya entraron se repiten.
// Si no, se detiene y avisa: puede haber bloques ya aplicados sin registro.
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(raiz, 'bff', 'package.json'));
const { Client } = require('pg');

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const pedidos = args.filter((a) => !a.startsWith('--'));
// MIGRACIONES_DIR solo existe para probar el script contra una base desechable.
const dir = process.env.MIGRACIONES_DIR || join(raiz, 'supabase', 'migrations');

const REINTENTABLES = new Set(['55P03', '40P01']); // lock_not_available, deadlock_detected
const argReintentos = args.find((a) => a.startsWith('--reintentos='));
const REINTENTOS = argReintentos ? Number(argReintentos.split('=')[1]) : 5;
if (!Number.isInteger(REINTENTOS) || REINTENTOS < 0) {
  console.error('--reintentos debe ser un entero >= 0.');
  process.exit(1);
}

/** ¿Se puede repetir el archivo completo sin efectos dobles? */
function reintentoSeguro(sql) {
  const sinComentarios = sql.replace(/--[^\n]*/g, '');
  const commits = (sinComentarios.match(/^\s*COMMIT\s*;/gim) || []).length;
  if (commits <= 1) return { ok: true };
  const idempotente = /^\s*--[^\n]*(?<!no )\bes idempotente\b/im.test(sql);
  if (idempotente) return { ok: true };
  return { ok: false, motivo: `tiene ${commits} transacciones y no se declara idempotente` };
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const archivos = readdirSync(dir).filter((f) => f.endsWith('.sql'));

if (pedidos.length === 0) {
  console.error('Indica las versiones a aplicar, en orden.');
  process.exit(1);
}

const plan = pedidos.map((p) => {
  const f = archivos.find((a) => a === p || a.startsWith(`${p}_`));
  if (!f) { console.error(`No existe la migración ${p}`); process.exit(1); }
  return { archivo: f, version: f.split('_')[0], nombre: f.replace(/^\d+_/, '').replace(/\.sql$/, '') };
});

console.log(aplicar ? 'APLICANDO:' : 'SIMULACIÓN (agrega --aplicar para escribir):');
plan.forEach((m, i) => console.log(`  ${i + 1}. ${m.archivo}`));
if (!aplicar) process.exit(0);

const url = process.env.SUPABASE_DB_URL;
if (!url) { console.error('Falta SUPABASE_DB_URL.'); process.exit(1); }

const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();
try {
  for (const m of plan) {
    const ya = await db.query('select 1 from supabase_migrations.schema_migrations where version = $1', [m.version]);
    if (ya.rowCount > 0) { console.log(`= ${m.archivo}: ya registrada, se salta`); continue; }
    process.stdout.write(`> ${m.archivo} … `);
    const sql = readFileSync(join(dir, m.archivo), 'utf8');
    const seguro = reintentoSeguro(sql);
    let fallo = null;
    for (let intento = 0; ; intento++) {
      try {
        await db.query(sql);
        break;
      } catch (e) {
        try { await db.query('ROLLBACK'); } catch { /* sin transacción abierta */ }
        if (REINTENTABLES.has(e.code) && seguro.ok && intento < REINTENTOS) {
          const espera = Math.min(30, 2 ** (intento + 1)) * 1000;
          console.log(`bloqueada (${e.code}); reintento ${intento + 1}/${REINTENTOS} en ${espera / 1000} s`);
          await esperar(espera);
          process.stdout.write(`> ${m.archivo} … `);
          continue;
        }
        fallo = e;
        break;
      }
    }
    if (fallo) {
      console.log('FALLÓ');
      console.error(`  ${fallo.code ?? ''} ${fallo.message}`);
      if (fallo.detail) console.error(`  detalle: ${fallo.detail}`);
      if (REINTENTABLES.has(fallo.code)) {
        console.error(seguro.ok
          ? '  Se agotaron los reintentos: vuelve a correrlo más tarde, en hora valle.'
          : `  No se reintenta solo: ${seguro.motivo}. Puede haber bloques ya aplicados `
            + 'sin registro; revísalos antes de volver a correrlo.');
      }
      process.exitCode = 1;
      break;
    }
    await db.query(
      'insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3) on conflict (version) do nothing',
      [m.version, m.nombre, [sql]],
    );
    console.log('ok');
  }
} finally {
  await db.end();
}
