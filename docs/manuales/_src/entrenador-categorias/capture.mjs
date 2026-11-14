// Capturas REALES de la página «Remover a un deportista» de
// guia-entrenadores-asignar-categoria (2026-10-22): el entrenador sin el permiso
// (etiqueta «Inscrito»), el interruptor de la escuela en Pagos → Config → Permisos,
// y el entrenador con el permiso (botón «Remover»).
// Frontend en :3101 y BFF en :3000 con las variables del gemelo.
//
//   node docs/manuales/_src/entrenador-categorias/capture.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { reiniciar, permitirRemover } from './comun.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const { chromium } = createRequire(path.join(repo, 'frontend', 'package.json'))('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3101';
const SB = 'http://127.0.0.1:54321';
// Llave anon de DEMO de la CLI local (no es secreta, no sirve fuera de esta máquina).
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SHOTS = path.join(here, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

reiniciar();

async function sesion(browser, user) {
  const res = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email: `${user}@qa.sportmaps.test`, password: 'QaGemelo2026!' }),
  });
  if (!res.ok) throw new Error(`login ${user}: ${res.status}`);
  const s = await res.json();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, locale: 'es-CO' });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); localStorage.setItem('sm_push_banner_dismissed', '1'); } catch {} }, ['sb-127-auth-token', JSON.stringify(s)]);
  const page = await ctx.newPage();
  return { ctx, page };
}
async function limpiar(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      if (el.childElementCount === 0 && /AMBIENTE DE QA/i.test(el.textContent || '')) {
        (el.closest('div[class*="fixed"],div[class*="sticky"]') || el.parentElement || el).remove();
      }
    }
    for (const el of document.querySelectorAll('img[alt*="Mapi" i], button[aria-label*="Mapi" i]')) (el.closest('button') || el).style.display = 'none';
  }).catch(() => {});
  await sleep(300);
}
async function foto(page, id, target) {
  await limpiar(page);
  await target.screenshot({ path: path.join(SHOTS, id + '.png') });
  console.log('✓', id);
}
const dlg = (page) => page.getByRole('dialog').last();
/** Fila de un deportista dentro de la ventana «Inscribir Deportistas». */
const fila = (page, nombre) => dlg(page).locator('div.rounded-lg, [class*="card"]').filter({ hasText: nombre }).last();

async function abrirModal(page) {
  await page.goto(BASE + '/teams');
  await page.getByText('Fútbol Sub-12').first().waitFor({ timeout: 30000 });
  await sleep(1500);
  await page.locator('[title="Gestionar Deportistas"]').first().click();
  await dlg(page).getByText('Juan Pablo Henao').first().waitFor({ timeout: 20000 });
  await sleep(1500);
}

const browser = await chromium.launch();

// ── Entrenador SIN el permiso: inscribe y queda la etiqueta «Inscrito» ───────
{
  const { ctx, page } = await sesion(browser, 'coach.campestre');
  await abrirModal(page);
  await dlg(page).getByPlaceholder(/Buscar/i).fill('Juan Pablo'); await sleep(800);
  await fila(page, 'Juan Pablo Henao').getByRole('button', { name: /Inscribir/ }).click();
  await sleep(3000);
  await foto(page, 'e01-sin-permiso', fila(page, 'Juan Pablo Henao'));
  await ctx.close();
}

// ── Escuela: el interruptor en Pagos → Config → Permisos ─────────────────────
{
  permitirRemover(true);
  const { ctx, page } = await sesion(browser, 'admin.campestre');
  await page.goto(BASE + '/payments-automation?tab=config');
  const lbl = page.getByText('Coaches pueden remover deportistas de sus equipos');
  await lbl.waitFor({ timeout: 30000 });
  await sleep(2000);
  const card = page.locator('div.rounded-lg, [class*="card"]').filter({ has: page.getByText('Qué pueden hacer los coaches y el staff.') }).last();
  await card.scrollIntoViewIfNeeded();
  await foto(page, 'e02-interruptor', card);
  await ctx.close();
}

// ── Entrenador CON el permiso: aparece «Remover» ─────────────────────────────
{
  const { ctx, page } = await sesion(browser, 'coach.campestre');
  await abrirModal(page);
  await dlg(page).getByPlaceholder(/Buscar/i).fill('Juan Pablo'); await sleep(800);
  await foto(page, 'e03-con-permiso', fila(page, 'Juan Pablo Henao'));
  await ctx.close();
}

await browser.close();
reiniciar();
