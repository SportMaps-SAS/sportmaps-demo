// Datos y ayudas compartidas por los dos videos narrados de la pizarra (2026-10-22).
// Gemelo local, Club Campestre Demo, entrenador Andrés Vélez, equipo «Fútbol Sub-12».
//
// El volcado del gemelo trae solo el esquema, así que acá se siembra lo que la
// pizarra necesita y es idempotente: la sesión de hoy con tres bloques, un plantel
// de 11 (9 deportistas más, sin acudiente para no tocar los videos de pagos) y las
// 28 plantillas SportMaps con sus 7 paquetes (solo los INSERT de las migraciones de
// datos, nunca sus funciones: re-crearlas podría pisar versiones más nuevas).
import fs from 'node:fs';
import path from 'node:path';
import { repo, sql } from '../_video/lib.mjs';

export const ESCUELA = '25a123f0-6d57-48a4-9800-7b1531d61cd2';
export const EQUIPO = '00000000-0000-4000-9e00-000000000201';
export const SESION = '00000000-0000-4000-9f00-000000000301';
const COACH = '00000000-0000-4000-a000-0000000000c3';
const BLOQUE = (n) => `00000000-0000-4000-9f10-00000000000${n}`;

function plantillas() {
  const M = path.join(repo, 'supabase/migrations');
  const leer = (f) => fs.readFileSync(path.join(M, f), 'utf8');
  const insert = (f) => {
    const s = leer(f);
    const i = s.lastIndexOf('INSERT INTO public.training_exercises');
    const fin = 'ON CONFLICT (id) DO NOTHING;';
    return s.slice(i, s.indexOf(fin, i) + fin.length);
  };
  const p = leer('20261015171126_pizarra_paquetes_biblioteca.sql');
  return [
    insert('20261008183744_biblioteca_ejercicios_v2.sql'),
    insert('20261015171123_plantillas_ejercicios_otros_deportes.sql'),
    p.slice(p.indexOf('INSERT INTO public.exercise_packs (id'), p.indexOf('-- Ninguna plantilla del sistema')),
  ].join('\n');
}

const bloques = JSON.stringify([
  { id: BLOQUE(1), name: 'Calentamiento', minutes: '15', activity: 'Rondo 4v2', objective: 'Activación con balón', description: '', component: 'tecnico' },
  { id: BLOQUE(2), name: 'Parte situacional', minutes: '30', activity: 'Salida 4-3-3 contra 4-4-2', objective: 'Salir jugando por banda', description: '', component: 'tactico' },
  { id: BLOQUE(3), name: 'Juego final', minutes: '20', activity: 'Partido condicionado', objective: 'Aplicar la salida', description: '', component: 'mixto' },
]);

/** Deja el gemelo listo: sesión de hoy sin jugadas, plantel de 11, biblioteca sin
 *  los ejercicios que guardan los videos. */
export function reiniciar() {
  sql(`begin;
    ${plantillas()}
    insert into training_sessions (id, team_id, school_id, created_by, session_date, objectives, session_blocks)
    values ('${SESION}', '${EQUIPO}', '${ESCUELA}', '${COACH}', current_date, 'Salida de balón contra presión alta', '${bloques}'::jsonb)
    on conflict (id) do update set session_date = excluded.session_date, session_blocks = excluded.session_blocks;
    with nuevos(n, nombre) as (values
      (1,'Samuel Castro'),(2,'Emiliano Torres'),(3,'Jerónimo Díaz'),(4,'Santiago Mejía'),(5,'Martín Ospina'),
      (6,'Lucas Cárdenas'),(7,'Simón Arango'),(8,'Matías Rojas'),(9,'Nicolás Vargas'))
    insert into children
    select (jsonb_populate_record(null::children, to_jsonb(c) || jsonb_build_object(
      'id', ('00000000-0000-4000-8c00-0000000002' || lpad(n::text, 2, '0'))::uuid, 'full_name', nombre, 'parent_id', null))).*
    from children c, nuevos where c.id = '00000000-0000-4000-8c00-000000000101'
    on conflict (id) do nothing;
    insert into enrollments
    select (jsonb_populate_record(null::enrollments, to_jsonb(e) || jsonb_build_object(
      'id', ('00000000-0000-4000-9e00-0000000004' || lpad(n::text, 2, '0'))::uuid,
      'child_id', ('00000000-0000-4000-8c00-0000000002' || lpad(n::text, 2, '0'))::uuid))).*
    from enrollments e, generate_series(1, 9) n where e.id = '00000000-0000-4000-9e00-000000000301'
    on conflict (id) do nothing;
    delete from match_lineups where source_id in ('${BLOQUE(1)}', '${BLOQUE(2)}', '${BLOQUE(3)}');
    delete from training_exercises where school_id = '${ESCUELA}';
    delete from tactical_saved_videos where school_id = '${ESCUELA}';
    commit;`);
}

// ── Ayudas sobre la cancha ───────────────────────────────────────────────────
export const tablero = (page) => page.getByRole('dialog').first();
/** Botón de la barra superior por el comienzo de su nombre. */
export const barra = (page, nombre) => tablero(page).getByRole('button', { name: new RegExp('^' + nombre) }).first();

/** Elige el equipo y abre el tablero del bloque `idx` (0 = el primero). */
export async function abrirTablero(ui, idx) {
  await ui.clic(ui.page.getByRole('combobox').first());
  await ui.clic(ui.page.getByRole('option', { name: /Fútbol Sub-12/ }));
  await ui.page.getByRole('button', { name: /Tablero táctico/ }).nth(idx).waitFor();
  await ui.sleep(1200);
}

/** Caja de la cancha: el svg más grande del tablero (una sola consulta: el tablero
 *  tiene decenas de íconos svg y medirlos uno por uno alarga cada paso). */
export async function cancha(page) {
  return tablero(page).locator('svg').evaluateAll((els) => els
    .map((e) => e.getBoundingClientRect())
    .reduce((m, r) => (!m || r.width * r.height > m.width * m.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : m), null));
}
export const en = (r, px, py) => ({ x: r.x + (px / 100) * r.width, y: r.y + (py / 100) * r.height });

/** Centro de la ficha de un jugador por sus iniciales (MG, ET…). */
export async function ficha(page, iniciales) {
  const b = await tablero(page).getByText(iniciales, { exact: true }).first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
/** Punto a `px` pixeles de `a` en dirección a `b` (para no arrancar encima de la ficha). */
export function hacia(a, b, px) {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: a.x + ((b.x - a.x) / d) * px, y: a.y + ((b.y - a.y) / d) * px };
}

export async function arrastrar(page, a, b, pasos = 30) {
  await page.mouse.move(a.x, a.y, { steps: 12 });
  await page.mouse.down(); await page.waitForTimeout(120);
  await page.mouse.move(b.x, b.y, { steps: pasos }); await page.waitForTimeout(120);
  await page.mouse.up(); await page.waitForTimeout(250);
}
export async function tocar(page, p) {
  await page.mouse.move(p.x, p.y, { steps: 12 });
  await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(350);
}
