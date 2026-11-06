// Capturas REALES para dos manuales de pagos (2026-10-21):
//   - pagos-de-padres            (rol Padre: banner, Mis Pagos, PAGAR por cobro, Wompi/transferencia, estado de cuenta)
//   - guia-registro-pagos-manual (rol Admin: Registrar pago, Aplicar a, varios cobros a la vez)
//
// SIEMPRE contra el gemelo Docker local (Club Campestre Demo, semilla
// supabase/seed/qa_twin_campestre_seed.sql), nunca contra la viva. Requiere el
// frontend en :3101 y el BFF en :3000, ambos con las variables del gemelo.
// Preparación de datos (cobros de sep/oct, nombres ficticios, datos bancarios):
// ver README del manual en docs/manuales/README.md.
//
//   node docs/manuales/_src/pagos-familias-registro/capture.mjs            (todo)
//   ONLY=padre node …/capture.mjs  |  ONLY=admin node …/capture.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const { chromium } = createRequire(path.join(repo, 'frontend', 'package.json'))('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3101';
const SB = 'http://127.0.0.1:54321';
if (!/localhost|127\.0\.0\.1/.test(BASE)) throw new Error('Solo gemelo local');
// Llave anon de DEMO de la CLI local (no es secreta, no sirve fuera de esta máquina).
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const PASS = 'QaGemelo2026!'; // contraseña de la semilla del gemelo
const SHOTS = path.join(here, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const ONLY = process.env.ONLY || '';
const COMPROBANTE = path.join(repo, 'docs/manuales/_src/dreamers/comprobante-ejemplo.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sesion(browser, user) {
  const res = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email: `${user}@qa.sportmaps.test`, password: PASS }),
  });
  if (!res.ok) throw new Error(`login ${user}: ${res.status}`);
  const s = await res.json();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: Number(process.env.ALTO || 1000) }, deviceScaleFactor: 2, locale: 'es-CO' });
  await ctx.addInitScript(([k, v]) => {
    try {
      localStorage.setItem(k, v);
      // Sin el aviso de notificaciones push (no aporta a la guía).
      localStorage.setItem('sm_push_banner_dismissed', '1');
    } catch {}
  }, ['sb-127-auth-token', JSON.stringify(s)]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 160)));
  return { ctx, page };
}

// Quita la franja "AMBIENTE DE QA-GEMELO", el botón flotante de soporte y el aviso de push.
async function limpiar(page) {
  await page.getByText('Ahora no', { exact: true }).first().click({ timeout: 800 }).catch(() => {});
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      if (el.childElementCount === 0 && /AMBIENTE DE QA/i.test(el.textContent || '')) {
        (el.closest('div[class*="fixed"],div[class*="sticky"]') || el.parentElement || el).remove();
      }
    }
    const fab = [...document.querySelectorAll('button')].find((b) => /soporte|ayuda/i.test(b.getAttribute('aria-label') || ''));
    if (fab) fab.style.display = 'none';
  }).catch(() => {});
  await sleep(300);
}
async function ir(page, url, esperar) {
  await page.goto(BASE + url);
  if (esperar) await page.getByText(esperar, { exact: false }).first().waitFor({ timeout: 30000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(1500); await limpiar(page);
}
async function foto(page, id, target) {
  const file = path.join(SHOTS, id + '.png');
  await limpiar(page);
  if (!target) await page.screenshot({ path: file });
  else {
    // Los diálogos altos hacen scroll interno: se agranda la ventana solo para la foto.
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: 1800 }); await sleep(600);
    await target.screenshot({ path: file });
    await page.setViewportSize(vp); await sleep(300);
  }
  console.log('✓', id);
}
const dialogo = (page) => page.locator('[role="dialog"]').last();

const browser = await chromium.launch();

// ── Padre ────────────────────────────────────────────────────────────────────
if (!ONLY || ONLY === 'padre') {
  const { ctx, page } = await sesion(browser, 'padre.campestre');
  await ir(page, '/dashboard', 'pagos pendientes');
  await foto(page, 'pp01-dashboard-banner');

  await ir(page, '/my-payments', 'Mis Pagos');
  await foto(page, 'pp02-mis-pagos');

  await page.getByRole('button', { name: /^PAGAR$/ }).first().click();
  await dialogo(page).getByText('Método de pago:', { exact: true }).waitFor();
  await sleep(1200);
  await foto(page, 'pp03-modal-wompi', dialogo(page));

  await dialogo(page).getByText('Transferencia / Nequi / Daviplata').click();
  await sleep(1200);
  await foto(page, 'pp04-modal-transferencia', dialogo(page));

  await dialogo(page).locator('input[type="file"]').setInputFiles(COMPROBANTE);
  await sleep(2500);
  await foto(page, 'pp05-comprobante-cargado', dialogo(page));

  await dialogo(page).getByRole('button', { name: /^Pagar \$/ }).click();
  await sleep(4000);
  await foto(page, 'pp06-despues-de-enviar');
  await ir(page, '/my-payments', 'Mis Pagos');
  await foto(page, 'pp07-por-validar');

  await page.getByText(/Estado de cuenta —/).first().click();
  await sleep(2500);
  await foto(page, 'pp08-estado-de-cuenta');
  await ctx.close();
}

// ── Admin: registro manual ────────────────────────────────────────────────────
if (!ONLY || ONLY === 'admin') {
  const { ctx, page } = await sesion(browser, 'admin.campestre');
  await ir(page, '/payments-automation', 'Cobros por Aprobar');
  await foto(page, 'rp01-gestion-de-pagos');

  await page.getByRole('button', { name: 'Registrar pago' }).first().click();
  await dialogo(page).getByText('Registrar pago manual').waitFor();
  await sleep(1000);
  await foto(page, 'rp02-formulario', dialogo(page));

  await dialogo(page).getByText('Selecciona a quién aplica').click();
  await sleep(800);
  await page.keyboard.type('Isabella', { delay: 60 });
  await sleep(1500);
  await foto(page, 'rp03-buscar-deportista');

  await page.getByText('Isabella Castro', { exact: false }).last().click();
  await sleep(2500);
  await foto(page, 'rp04-aplicar-a-y-mes', dialogo(page));

  await dialogo(page).getByText('Pagar varios cobros a la vez').click();
  await sleep(1200);
  await dialogo(page).getByText(/Seleccionar todos/).click();
  await sleep(1200);
  await foto(page, 'rp05-varios-cobros', dialogo(page));

  await dialogo(page).getByText(/^transferencia$/i).click();
  await sleep(1200);
  await foto(page, 'rp06-transferencia-soporte', dialogo(page));

  await dialogo(page).getByRole('button', { name: /confirmar registro/i }).click();
  await sleep(4000);
  await foto(page, 'rp07-confirmado');
  await ctx.close();
}

await browser.close();
