/**
 * Prueba guardián: el navegador NO escribe directo en las tablas de reservas.
 * Toda mutación va por el BFF (reservations / reservations-admin), que valida y audita.
 * Habilita revocar INSERT/UPDATE/DELETE de `authenticated` sobre esas tablas.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const TABLAS = ['facility_reservations', 'reservation_payments', 'facility_occupancy', 'guest_bookers'];
const ESCRITURA = /\.(insert|update|upsert|delete)\s*\(/;
const VENTANA = 300;

function archivos(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n === 'node_modules' || n === 'e2e' || n === 'test' || n === '__tests__') continue;
      archivos(p, out);
    } else if (/\.(ts|tsx)$/.test(n) && !/\.(test|spec)\.tsx?$/.test(n) && n !== 'types.ts') {
      out.push(p);
    }
  }
  return out;
}

export function escriturasDirectas(src: string): string[] {
  const hallazgos: string[] = [];
  for (const t of TABLAS) {
    const re = new RegExp('\\.from\\(\\s*[\'"`]' + t + '[\'"`]\\s*\\)', 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const ventana = src.slice(m.index + m[0].length, m.index + m[0].length + VENTANA);
      if (ESCRITURA.test(ventana)) hallazgos.push(t);
    }
  }
  return hallazgos;
}

describe('reservas: sin escritura directa desde el frontend', () => {
  it('el detector encuentra una escritura y deja pasar un select', () => {
    expect(escriturasDirectas("supabase.from('facility_reservations').insert({a:1})")).toEqual(['facility_reservations']);
    expect(escriturasDirectas('db.from("reservation_payments")\n  .update({a:1})')).toEqual(['reservation_payments']);
    expect(escriturasDirectas("db.from('guest_bookers').upsert({})")).toEqual(['guest_bookers']);
    expect(escriturasDirectas("db.from('facility_occupancy').delete().eq('id', 1)")).toEqual(['facility_occupancy']);
    expect(escriturasDirectas("supabase.from('facility_reservations').select('*').eq('id', 1)")).toEqual([]);
  });

  it('ningún archivo de frontend/src escribe en facility_reservations / reservation_payments / facility_occupancy / guest_bookers', () => {
    const malos: string[] = [];
    for (const f of archivos(SRC)) {
      const hall = escriturasDirectas(readFileSync(f, 'utf8'));
      if (hall.length) malos.push(relative(SRC, f) + ' -> ' + [...new Set(hall)].join(', '));
    }
    expect(malos).toEqual([]);
  });
});
