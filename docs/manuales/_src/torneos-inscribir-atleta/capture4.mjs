// Recaptura de la pestaña «Categorías y Precios» tras ponerle nombre visible a cada campo (2026-10-27).
//
//   node docs/manuales/_src/torneos-inscribir-atleta/capture4.mjs
//
// Contra https://dev.sportmaps.co, tenant «Club Campestre Demo». ESCRIBE en el demo: un torneo
// interno gratis que queda en BORRADOR (sin categorías guardadas). El torneo con costo solo se lee.
import path from 'node:path';
import { chromium, newSession, here, BASE_URL, rest, SCHOOL_ID } from './lib.mjs';

const SHOTS = path.join(here, 'shots');
const settle = (p, ms = 1200) => p.waitForTimeout(ms);
const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '');

// PW_EXE: ruta a un Chromium ya instalado, por si el de la versión actual de Playwright no está.
const browser = await chromium.launch({ executablePath: process.env.PW_EXE || undefined });
try {
  const { page } = await newSession(browser);

  // 1) Torneo gratis en borrador, con una categoría agregada sin guardar (SOLO_COSTO=1 lo salta)
  const titulo = `Copa Interna Demo ${stamp}`;
  let ev = null;
  if (!process.env.SOLO_COSTO) {
  await page.goto(`${BASE_URL}/school/tournaments/new`);
  await page.getByRole('heading', { name: 'Crear Torneo' }).waitFor({ timeout: 40_000 });
  await page.locator('select').first().selectOption('internal');
  await settle(page, 500);
  await page.locator('#is_paid').click();
  await page.locator('#title').fill(titulo);
  await page.locator('#sport').fill('Fútbol');
  await page.locator('#event_date').fill('2026-11-21');
  await page.locator('#registration_deadline').fill('2026-11-14');
  await page.locator('#address').fill('Cancha principal del club');
  await page.locator('#city').fill('Bogotá');
  await page.getByRole('button', { name: 'Crear torneo' }).click();
  await page.getByRole('heading', { name: 'Mis Torneos' }).waitFor({ timeout: 30_000 });
  ev = (await rest(`events?select=id,title&school_id=eq.${SCHOOL_ID}&title=eq.${encodeURIComponent(titulo)}`))[0];
  await page.goto(`${BASE_URL}/school/tournaments/${ev.id}`);
  await page.getByRole('heading', { name: titulo }).waitFor({ timeout: 40_000 });
  await settle(page, 1500);
  await page.getByRole('tab', { name: /Categorías/ }).click();
  await settle(page, 600);
  await page.getByRole('button', { name: /Agregar/ }).first().click();
  await page.getByPlaceholder('Sub 12').first().fill('Sub 12');
  await settle(page, 500);
  await page.screenshot({ path: path.join(SHOTS, 'a-04-categorias.png') });
  }

  // 2) Torneo con costo ya publicado (solo lectura)
  const cc = (await rest(`events?select=id,title&school_id=eq.${SCHOOL_ID}&title=like.Copa%20Con%20Costo*&order=created_at.desc&limit=1`))[0];
  await page.goto(`${BASE_URL}/school/tournaments/${cc.id}`);
  await page.getByRole('heading', { name: cc.title }).waitFor({ timeout: 40_000 });
  await settle(page, 1200);
  await page.getByRole('tab', { name: /Categorías/ }).click();
  await settle(page, 800);
  await page.screenshot({ path: path.join(SHOTS, 'c-07-categorias-fases.png') });
  console.log(JSON.stringify({ ok: true, borrador: ev ? titulo : null, id: ev?.id ?? null }));
} catch (e) { console.log('ERROR', e.message); } finally { await browser.close(); }
