// Utilidades compartidas por capture.mjs (manual del Acudiente V2) y las
// pruebas exploratorias: login programático, sesión móvil y registro de errores.
//
// Tenant: SOLO Club Campestre Demo (is_demo=true). Contraseña única Demo2026!
// (scripts/demo-club-campestre/README.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, '../../../..');
const require = createRequire(path.join(repo, 'frontend', 'package.json'));
export const { chromium } = require('playwright');

// El bump de dependencias del 2026-10-26 subió playwright a un build de Chromium
// que no está descargado; se usa el headless shell más nuevo que haya en caché.
export function launch() {
  try {
    const dir = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    const shells = fs.readdirSync(dir).filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const s of shells) {
      const exe = path.join(dir, s, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
      if (fs.existsSync(exe)) return chromium.launch({ executablePath: exe });
    }
  } catch {}
  return chromium.launch();
}

export const BASE_URL = process.env.BASE_URL || 'https://dev.sportmaps.co';
export const PASSWORD = 'Demo2026!';
// Viewport del celular (regla 08 de la V2: se dibuja a 390 px).
export const VIEWPORT = { width: 390, height: 844 };
export const DSF = 3;

function readEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"#]*)"?\s*$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const FE = { ...readEnv(path.join(repo, 'frontend/.env')), ...readEnv(path.join(repo, 'frontend/.env.local')) };
export const SUPABASE_URL = FE.VITE_SUPABASE_URL;
export const SUPABASE_KEY = FE.VITE_SUPABASE_PUBLISHABLE_KEY || FE.VITE_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Faltan VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY en frontend/.env');

export async function token(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login ${email}: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function newSession(browser, email, { desktop = false } = {}) {
  const context = await browser.newContext({
    viewport: desktop ? { width: 1440, height: 900 } : VIEWPORT,
    deviceScaleFactor: desktop ? 2 : DSF,
    isMobile: !desktop, hasTouch: !desktop, locale: 'es-CO', timezoneId: 'America/Bogota',
  });
  if (email) {
    const session = await token(email);
    const ref = new URL(SUPABASE_URL).host.split('.')[0];
    await context.addInitScript(([key, value]) => {
      try { window.localStorage.setItem(key, value); } catch {}
    }, [`sb-${ref}-auth-token`, JSON.stringify(session)]);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 300)}`); });
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400 && (u.includes('supabase.co') || u.includes('bff'))) errors.push(`[http ${r.status()}] ${r.request().method()} ${u.split('?')[0].slice(0, 160)}`);
  });
  return { context, page, errors };
}

export const settle = (page, ms = 1200) => page.waitForTimeout(ms);

export async function go(page, url, ms = 2500) {
  await page.goto(BASE_URL + url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await settle(page, ms);
}

/** Coordenadas de DOCUMENTO (CSS px) de un locator: sirven para recortar la captura fullPage. */
export async function docBox(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  });
}

/**
 * La app V2 no hace scroll en el documento: el que se desplaza es <main>. Para
 * una captura "de página completa" se agranda el viewport hasta que <main> ya no
 * desborde; así las coordenadas de getBoundingClientRect() son de documento.
 * Devuelve la altura usada. Llamar restoreViewport() después.
 */
export async function expandViewport(page, extra = 0) {
  for (let i = 0; i < 3; i++) {
    const { sh, ch } = await page.evaluate(() => {
      const m = document.querySelector('main');
      return m ? { sh: m.scrollHeight, ch: m.clientHeight } : { sh: 0, ch: 0 };
    });
    if (sh <= ch + 2) break;
    const cur = page.viewportSize();
    await page.setViewportSize({ width: cur.width, height: Math.min(cur.height + (sh - ch) + extra, 9000) });
    await page.waitForTimeout(500);
  }
  return page.viewportSize().height;
}
export const restoreViewport = (page) => page.setViewportSize(VIEWPORT);

export async function fullShot(page, file) {
  await expandViewport(page);
  await page.screenshot({ path: file });
  const h = page.viewportSize().height;
  await restoreViewport(page);
  return h;
}

/** Recorta un elemento (con margen) sobre el viewport agrandado: coordenadas de documento, sin scroll. */
export async function clipShot(page, locator, file, pad = 8) {
  await expandViewport(page);
  const b = await locator.boundingBox();
  if (!b) { await restoreViewport(page); throw new Error('Elemento sin caja para recortar'); }
  const vs = page.viewportSize();
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
  await page.screenshot({ path: file, clip: { x, y, width: Math.min(vs.width - x, b.width + pad * 2), height: Math.min(vs.height - y, b.height + pad * 2) } });
  await restoreViewport(page);
}
