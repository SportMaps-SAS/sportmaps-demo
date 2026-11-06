// Capturas REALES para catalogo-articulos-y-torneos.pdf (2026-10-22).
// Gemelo local, Club Campestre Demo: la escuela carga el catálogo (Pagos → Config),
// la familia compra una camiseta y la escuela aprueba la compra.
// Frontend en :3101 y BFF en :3000 con las variables del gemelo.
//
//   node docs/manuales/_src/catalogo/capture.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { sql } from '../_video/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const { chromium } = createRequire(path.join(repo, 'frontend', 'package.json'))('playwright');
const BASE = 'http://localhost:3101';
const SB = 'http://127.0.0.1:54321';
// Llave anon de DEMO de la CLI local (no es secreta, no sirve fuera de esta máquina).
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SHOTS = path.join(here, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const COMPROBANTE = path.resolve(here, '../dreamers/comprobante-ejemplo.png');
const ESCUELA = '25a123f0-6d57-48a4-9800-7b1531d61cd2';
const MATEO = '00000000-0000-4000-8c00-000000000101';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

sql(`begin;
     set local session_replication_role = replica;
     update school_settings set merchandise_enabled=true, tournament_charges_enabled=true where school_id='${ESCUELA}';
     commit;
     delete from payments where child_id='${MATEO}' and coalesce(payment_category,'') <> 'mensualidad';
     delete from school_merchandise_items where school_id='${ESCUELA}';
     delete from school_tournament_items where school_id='${ESCUELA}';`);

async function sesion(browser, user) {
  const res = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email: `${user}@qa.sportmaps.test`, password: 'QaGemelo2026!' }),
  });
  if (!res.ok) throw new Error(`login ${user}: ${res.status}`);
  const s = await res.json();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, locale: 'es-CO' });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); localStorage.setItem('sm_push_banner_dismissed', '1'); localStorage.setItem('sportmaps:cobros-y-pagos', 'on'); } catch {} }, ['sb-127-auth-token', JSON.stringify(s)]);
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
    for (const b of document.querySelectorAll('button')) if (/soporte|ayuda/i.test(b.getAttribute('aria-label') || '')) b.style.display = 'none';
    // El botón flotante de Mapi (abajo a la derecha) no aporta a la guía.
    for (const el of document.querySelectorAll('img[alt*="Mapi" i], button[aria-label*="Mapi" i]')) (el.closest('button') || el).style.display = 'none';
  }).catch(() => {});
  await sleep(300);
}
async function foto(page, id, target) {
  await limpiar(page);
  const file = path.join(SHOTS, id + '.png');
  if (!target) await page.screenshot({ path: file });
  else {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: 1800 }); await sleep(600);
    await target.screenshot({ path: file });
    await page.setViewportSize(vp); await sleep(300);
  }
  console.log('✓', id);
}
/** La tarjeta más interna que contiene el título y su botón «Agregar». */
const tarjeta = (page, titulo) => page.locator('div')
  .filter({ has: page.getByText(titulo, { exact: true }) })
  .filter({ has: page.getByRole('button', { name: 'Agregar' }) }).last();
const dlg = (page) => page.locator('[role="dialog"], [role="alertdialog"]').last();

const browser = await chromium.launch();

// ── Escuela: Config y carga del catálogo ─────────────────────────────────────
{
  const { ctx, page } = await sesion(browser, 'admin.campestre');
  await page.goto(BASE + '/payments-automation?tab=config');
  await page.getByText('Catálogo de artículos deportivos').first().waitFor();
  await sleep(2500);
  await foto(page, 'c01-config');

  const art = tarjeta(page, 'Catálogo de artículos deportivos');
  await art.getByPlaceholder('Nombre').fill('Camiseta oficial');
  await art.getByPlaceholder('Precio (COP)').fill('60000');
  await art.getByPlaceholder('Tallas, ej. S, M, L (opcional)').fill('S, M, L');
  await art.getByRole('button', { name: 'Agregar' }).click(); await sleep(2000);
  await art.getByPlaceholder('Nombre').fill('Balón #5');
  await art.getByPlaceholder('Precio (COP)').fill('85000');
  await art.getByRole('button', { name: 'Agregar' }).click(); await sleep(2500);
  await art.scrollIntoViewIfNeeded();
  await foto(page, 'c02-articulos', art);

  const sueltos = tarjeta(page, 'Cobros sueltos');
  await sueltos.getByPlaceholder('Nombre').fill('Torneo Interclubes');
  await sueltos.getByPlaceholder('Precio (COP)').fill('50000');
  await sueltos.getByRole('button', { name: 'Agregar' }).click(); await sleep(2500);
  await sueltos.scrollIntoViewIfNeeded();
  await foto(page, 'c03-cobros-sueltos', sueltos);
  await ctx.close();
}

// ── Familia: compra ──────────────────────────────────────────────────────────
{
  const { ctx, page } = await sesion(browser, 'padre.campestre');
  await page.goto(BASE + '/my-payments');
  await page.getByRole('button', { name: 'Nuevo Pago' }).waitFor(); await sleep(2000);
  await page.getByRole('button', { name: 'Nuevo Pago' }).click(); await sleep(1500);
  await page.getByRole('button', { name: /Mateo Gómez Fútbol/ }).click(); await sleep(2500);
  await dlg(page).getByRole('combobox').first().click(); await sleep(1000);
  await foto(page, 'c04-tipo-de-pago');
  await page.getByRole('option', { name: 'Artículos Deportivos' }).click(); await sleep(1500);
  await dlg(page).getByRole('button', { name: /Camiseta oficial/ }).click(); await sleep(800);
  await dlg(page).getByRole('button', { name: '+', exact: true }).click(); await sleep(1200);
  await foto(page, 'c05-articulos-elegidos', dlg(page));
  await dlg(page).getByText('Transferencia / Nequi / Daviplata').click(); await sleep(800);
  await dlg(page).locator('input[type="file"]').setInputFiles(COMPROBANTE); await sleep(2500);
  await dlg(page).getByRole('button', { name: /^Pagar \$/ }).click(); await sleep(4000);
  await ctx.close();
}

// ── Escuela: aprobación ──────────────────────────────────────────────────────
{
  const { ctx, page } = await sesion(browser, 'admin.campestre');
  await page.goto(BASE + '/payments-automation');
  await page.getByText('Cobros por Aprobar').first().waitFor(); await sleep(3000);
  await foto(page, 'c06-cobros-por-aprobar');
  await page.locator('tr', { hasText: /120\.000/ }).first().getByRole('button', { name: /Aprobar/ }).click(); await sleep(2000);
  await foto(page, 'c07-aprobar', dlg(page));
  await dlg(page).getByText(/Verifiqué que el pago/).click(); await sleep(500);
  await dlg(page).getByRole('button', { name: /^Aprobar \$/ }).click(); await sleep(3000);
  await ctx.close();
}

await browser.close();
