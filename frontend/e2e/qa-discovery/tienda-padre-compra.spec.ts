import { test, expect, Page, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// QA BASE de la tienda escolar (2026-10-03), ANTES de rehacerla (tienda v2).
// Corre contra lo DESPLEGADO en dev: https://dev.sportmaps.co + bffdev.
// La base es la única Supabase (producción): solo se escribe en la escuela demo
// "Club Campestre Demo" (25a123f0-6d57-48a4-9800-7b1531d61cd2, is_demo=true).
//
// Reglas duras del spec:
//  - NUNCA Mercado Pago. Wompi solo si la llave pública es pub_test_.
//  - Ninguna orden puede quedar 'paid' (dispara factura DIAN real por cron).
//  - Los ataques REST solo tocan órdenes del padre demo.
//
// Correr: npx playwright test -c playwright.qa-discovery.config.ts tienda-padre-compra

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BASE = process.env.QA_BASE_URL || 'https://dev.sportmaps.co';
const PASS = 'Demo2026!';
const OWNER = 'gerencia@demo.sportmaps.co';
const PADRE = 'mherrera@demo.sportmaps.co';
const PADRE2 = 'familia.rojas@demo.sportmaps.co';
export const SCHOOL_ID = '25a123f0-6d57-48a4-9800-7b1531d61cd2';

const SHOT_DIR = path.resolve(__dirname, '..', '..', '..', 'docs', 'capturas', 'tienda-baseline');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const LOG = path.join(SHOT_DIR, '_log.jsonl');

function log(step: string, data: unknown) {
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), step, data }) + '\n');
  console.log(`[${step}]`, typeof data === 'string' ? data : JSON.stringify(data).slice(0, 1500));
}

async function shot(page: Page, name: string, fullPage = false) {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage });
}

async function settle(page: Page, ms = 1500) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function login(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await settle(page, 500);
  await shot(page, '_login-' + email.split('@')[0]);
  await page.locator('input[type=email]').first().fill(email);
  await page.locator('input[type=password]').first().fill(PASS);
  await page.locator('input[type=password]').first().press('Enter');
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  await settle(page);
}

/** Captura todas las llamadas a BFF/Supabase que tocan tienda, para evidencia. */
function sniff(page: Page, tag: string) {
  page.on('response', async (r) => {
    const u = r.url();
    if (r.request().method() !== 'GET' && !/google|sentry|posthog|vercel|wompi\.co/.test(u)) { let b=''; try { b=(await r.text()).slice(0,400);} catch { /* sin cuerpo: solo diagnóstico */ } log(`${tag}:write`, { m: r.request().method(), s: r.status(), u, b }); return; }
    if (!/(bffdev|supabase\.co)/.test(u)) return;
    if (!/enable_vendor|marketplace|orders|order_items|products|vendor_profiles|wompi|checkout|shipping|notify_user|shipments/i.test(u)) return;
    let body = '';
    try { body = (await r.text()).slice(0, 600); } catch { /* */ }
    log(`${tag}:net`, { m: r.request().method(), s: r.status(), u: u.replace(/apikey=[^&]+/, ''), body });
  });
  page.on('console', (m) => { if (m.type() === 'error') log(`${tag}:console`, m.text().slice(0, 400)); });
}

async function dumpText(page: Page, tag: string) {
  const t = (await page.locator('main').first().innerText().catch(() => page.locator('body').innerText())).slice(0, 2500);
  log(tag, t);
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

// ─── 1. Escuela: preparar la tienda por la UI ────────────────────────────────
test('1a owner: menú y onboarding de tienda', async ({ page }) => {
  sniff(page, '1a');
  await login(page, OWNER);
  await shot(page, '1a-01-owner-dashboard');
  const nav = await page.locator('nav, aside').first().innerText().catch(() => '');
  log('1a-menu', nav);
  await page.goto(`${BASE}/vendor/onboarding`);
  await settle(page);
  await shot(page, '1a-02-vendor-onboarding', true);
  await dumpText(page, '1a-onboarding-text');
});

test('1b owner: activar Mi Tienda por el onboarding', async ({ page }) => {
  sniff(page, '1b');
  await login(page, OWNER);
  await page.goto(`${BASE}/vendor/onboarding`);
  await settle(page);
  await page.getByText('Productos', { exact: true }).first().click();
  await page.locator('input').filter({ hasNot: page.locator('[type=tel]') }).first().fill('Tienda Club Campestre Demo');
  // Ciudad (combobox)
  await page.getByText('Selecciona tu ciudad...').click();
  await page.keyboard.type('Bogot');
  await page.waitForTimeout(800);
  await page.getByRole('option').first().click().catch(async () => { await page.keyboard.press('Enter'); });
  await page.locator('textarea').first().fill('Uniformes y artículos oficiales del club (DEMO QA).');
  await shot(page, '1b-01-onboarding-paso1', true);
  await page.getByRole('button', { name: /^Siguiente$/ }).click();
  await settle(page, 800);
  await page.getByText('Transferencia Bancaria', { exact: true }).click();
  await page.getByText('Efectivo / Presencial', { exact: true }).click();
  await shot(page, '1b-02-onboarding-paso2', true);
  await dumpText(page, '1b-paso2-text');
  // Banco (combobox)
  const bancoBtn = page.locator('button[role=combobox]').first();
  await bancoBtn.click();
  await page.keyboard.type('Bancolombia');
  await page.waitForTimeout(600);
  await page.getByRole('option').first().click().catch(async () => { await page.keyboard.press('Enter'); });
  await page.locator('button[role=combobox]').nth(1).click();
  await page.getByRole('option', { name: 'Ahorros' }).click();
  await page.getByPlaceholder('123-456789-00').fill('000-000000-00');
  await page.getByPlaceholder('Nombre completo').fill('DEMO QA NO REAL');
  await page.getByPlaceholder('900.123.456-7').last().fill('900000000-0');
  await shot(page, '1b-03-onboarding-paso2-lleno', true);
  await page.getByRole('button', { name: /Activar y continuar/ }).click();
  await settle(page, 2500);
  await shot(page, '1b-04-onboarding-paso3', true);
  await dumpText(page, '1b-paso3-text');
  const fin = page.getByRole('button', { name: /Ir al panel|Omitir|Finalizar|Terminar|Más tarde|Saltar/i }).first();
  if (await fin.count()) await fin.click();
  await settle(page, 2500);
  await shot(page, '1b-05-vendor-dashboard', true);
  await dumpText(page, '1b-dashboard-text');
  log('1b-url', page.url());
});

test('1c owner: panel vendedor y menú', async ({ page }) => {
  sniff(page, '1c');
  await login(page, OWNER);
  await page.goto(`${BASE}/vendor/dashboard`);
  await settle(page, 2500);
  log('1c-url', page.url());
  await shot(page, '1c-01-vendor-dashboard', true);
  await dumpText(page, '1c-dashboard');
  const side = await page.locator('[data-sidebar="sidebar"], aside').first().innerText().catch(() => '');
  log('1c-sidebar', side);
  await page.goto(`${BASE}/vendor/products/new`);
  await settle(page, 2500);
  await shot(page, '1c-02-wizard-paso1', true);
  await dumpText(page, '1c-wizard');
});

// ─── 1d. Productos por el wizard ─────────────────────────────────────────────
interface ProdSpec {
  key: string; cat: string; name: string; desc: string; price: number;
  attrs: Array<[string, string]>;           // [label del select, opción]
  stock?: number;                           // sin variantes
  variants?: Array<{ label: string; values: string[]; custom?: boolean }>;
  variantStock?: number;
  visibility: 'Público' | 'Solo mi escuela';
}

const PRODUCTS: ProdSpec[] = [
  { key: 'P1', cat: 'Ropa Deportiva', name: 'Camiseta oficial Club Campestre (DEMO QA)',
    desc: 'Camiseta oficial de entrenamiento del club, tela respirable. Producto de prueba QA.',
    price: 85000, attrs: [['Género', 'unisex']],
    variants: [{ label: 'Talla', values: ['S', 'M', 'L'] }, { label: 'Color', values: ['Verde'], custom: true }],
    variantStock: 5, visibility: 'Público' },
  { key: 'P2', cat: 'Accesorios', name: 'Gorra bordada Club Campestre (DEMO QA)',
    desc: 'Gorra con logo bordado del club, talla única ajustable. Producto de prueba QA.',
    price: 45000, attrs: [], stock: 1, visibility: 'Público' },
  { key: 'P3', cat: 'Accesorios', name: 'Termo del club solo socios (DEMO QA)',
    desc: 'Termo metálico de 750 ml con el escudo del club, exclusivo socios. Producto de prueba QA.',
    price: 60000, attrs: [], stock: 10, visibility: 'Solo mi escuela' },
];

async function makePng(page: Page, label: string, color: string): Promise<Buffer> {
  const p2 = await page.context().newPage();
  await p2.setViewportSize({ width: 600, height: 600 });
  await p2.setContent(`<body style="margin:0;background:${color};display:flex;align-items:center;justify-content:center;height:600px;font:bold 48px sans-serif;color:#fff">${label}</body>`);
  const buf = await p2.screenshot({ type: 'png' });
  await p2.close();
  return buf;
}

for (const P of PRODUCTS) {
  test(`1d owner: wizard crea ${P.key}`, async ({ page }) => {
    sniff(page, `1d-${P.key}`);
    await login(page, OWNER);
    await page.goto(`${BASE}/vendor/products/new`);
    await settle(page, 2000);
    await page.getByText(P.cat, { exact: true }).click();
    await page.getByRole('button', { name: /^Siguiente$/ }).click();
    await settle(page, 800);
    await page.getByPlaceholder(/Tenis Nike Air/).fill(P.name);
    await page.getByPlaceholder(/especial este producto/).fill(P.desc);
    await page.getByPlaceholder('120000').fill(String(P.price));
    const img = await makePng(page, P.key + ' DEMO', P.key === 'P1' ? '#1f7a3a' : P.key === 'P2' ? '#2b4bf2' : '#b45309');
    await page.locator('input[type=file]').first().setInputFiles({ name: `${P.key}.png`, mimeType: 'image/png', buffer: img });
    await page.waitForTimeout(4000);
    for (const [label, opt] of P.attrs) {
      await page.getByRole('combobox').filter({ hasText: new RegExp(`Selecciona ${label.toLowerCase()}`) }).click();
      await page.getByRole('option', { name: opt, exact: true }).click();
    }
    await shot(page, `1d-${P.key}-01-info`, true);
    await page.getByRole('button', { name: /^Siguiente$/ }).click();
    await settle(page, 800);
    if (P.variants) {
      await page.getByRole('switch').first().click();
      for (const v of P.variants) {
        const block = page.locator('div').filter({ has: page.locator('label', { hasText: new RegExp(`^${v.label}`) }) }).last();
        for (const val of v.values) {
          if (v.custom) {
            await block.getByPlaceholder(new RegExp(`Agregar ${v.label.toLowerCase()}`)).fill(val);
            await block.getByPlaceholder(new RegExp(`Agregar ${v.label.toLowerCase()}`)).press('Enter');
          } else {
            await block.getByRole('button', { name: val, exact: true }).click();
          }
        }
      }
      const stockInput = page.locator('label', { hasText: 'Stock por variante' }).locator('..').locator('input');
      await stockInput.fill(String(P.variantStock ?? 5));
    } else {
      await page.locator('label', { hasText: 'Stock disponible' }).locator('..').locator('input').fill(String(P.stock ?? 1));
    }
    await shot(page, `1d-${P.key}-02-variantes-stock`, true);
    await page.getByRole('button', { name: /^Siguiente$/ }).click();
    await settle(page, 800);
    await page.getByRole('combobox').filter({ hasText: /Público/ }).click();
    await page.getByRole('option', { name: new RegExp(P.visibility) }).click();
    await shot(page, `1d-${P.key}-03-publicar`, true);
    await dumpText(page, `1d-${P.key}-publicar-text`);
    await page.getByRole('button', { name: /Publicar ahora/ }).click();
    await page.waitForURL(/\/vendor\/products$/, { timeout: 60_000 }).catch(() => log(`1d-${P.key}-nonav`, 'no navegó a /vendor/products en 60s'));
    await page.waitForTimeout(1000);
    await shot(page, `1d-${P.key}-04-tras-publicar`, true);
    const toasts = await page.locator('[data-sonner-toast], [role=status], li[role=status]').allInnerTexts().catch(() => []);
    log(`1d-${P.key}-toast`, toasts);
    log(`1d-${P.key}-url`, page.url());
  });
}

test('1e owner: lista de productos (estado tras publicar)', async ({ page }) => {
  sniff(page, '1e');
  await login(page, OWNER);
  await page.goto(`${BASE}/vendor/products`);
  await settle(page, 2500);
  await shot(page, '1e-01-vendor-products', true);
  await dumpText(page, '1e-products-text');
});

// ─── 2. Padre: encontrar la tienda, carrito, checkout ───────────────────────
const GORRA = 'Gorra bordada Club Campestre (DEMO QA)';
const CAMISETA = 'Camiseta oficial Club Campestre (DEMO QA)';

async function abrirTiendaDesdeMenu(page: Page, tag: string) {
  const link = page.locator('a[href="/mi-tienda"]').first();
  if (!(await link.isVisible().catch(() => false))) {
    const grupo = page.getByText(/^seguimiento$/i).first();
    if (await grupo.isVisible().catch(() => false)) { await grupo.click(); await page.waitForTimeout(600); }
  }
  if (await link.isVisible().catch(() => false)) {
    await shot(page, `${tag}-01b-menu-tienda`);
    await link.click();
    log(`${tag}-menu`, 'ítem Tienda encontrado en el menú');
  } else {
    // móvil: menú hamburguesa / barra inferior
    const burger = page.locator('[data-sidebar="trigger"]').first();
    if (await burger.isVisible().catch(() => false)) {
      await burger.click(); await page.waitForTimeout(800);
      const g = page.getByText(/^seguimiento$/i).first();
      if (await g.isVisible().catch(() => false)) { await g.click(); await page.waitForTimeout(500); }
    }
    if (await link.isVisible().catch(() => false)) { await shot(page, `${tag}-01b-menu-tienda`); await link.click(); log(`${tag}-menu`, 'ítem Tienda encontrado (menú móvil)'); }
    else { log(`${tag}-menu`, 'ítem Tienda NO visible: entro por URL /mi-tienda'); await page.goto(`${BASE}/mi-tienda`); }
  }
  await page.waitForURL(/\/tienda\//, { timeout: 25_000 }).catch(() => {});
  await page.getByText('Contactar al vendedor').waitFor({ timeout: 25_000 }).catch(() => {});
  await settle(page, 1000);
  log(`${tag}-url-tienda`, page.url());
  await shot(page, `${tag}-02-vitrina`, true);
  await dumpText(page, `${tag}-vitrina-text`);
}

async function armarCarrito(page: Page, tag: string, gorraClicks: number) {
  await page.evaluate(() => localStorage.removeItem('sportmaps_cart'));
  await page.reload(); await page.getByText('Contactar al vendedor').waitFor({ timeout: 25_000 });
  const body = await page.locator('body').innerText();
  log(`${tag}-visibilidad`, { camiseta: body.includes(CAMISETA), gorra: body.includes(GORRA), termo_school_only: body.includes('Termo del club') });
  log(`${tag}-boton-agregar-camiseta`, await page.getByRole('button', { name: `Agregar ${CAMISETA}` }).count());
  // ¿la tarjeta abre una ficha?
  await page.getByText(GORRA).first().click();
  await page.waitForTimeout(1200);
  log(`${tag}-ficha`, { url: page.url(), dialogs: await page.locator('[role=dialog]').count() });
  for (let i = 0; i < gorraClicks; i++) {
    await page.getByRole('button', { name: `Agregar ${GORRA}` }).click();
    await page.waitForTimeout(500);
  }
  await page.keyboard.press('Escape');
  await shot(page, `${tag}-03-vitrina-con-carrito`, true);
  const ver = page.getByRole('button', { name: /Ver carrito/ });
  await ver.click();
  await page.waitForTimeout(1200);
  await shot(page, `${tag}-04-carrito`, true);
  log(`${tag}-carrito`, (await page.locator('[role=dialog]').allInnerTexts()).join('\n').slice(0, 900));
}

async function llenarEnvio(page: Page) {
  await page.locator('#ship-line').fill('Calle 100 # 10-20 (DEMO QA)');
  await page.locator('#ship-city').fill('Bogotá');
  await page.locator('#ship-dept').fill('Cundinamarca');
  await page.locator('#ship-phone').fill('3000000000');
  await page.waitForTimeout(4000);
}

test('2a padre (mherrera): menú → vitrina → carrito → checkout → Wompi (solo abrir) → transferencia', async ({ page }) => {
  sniff(page, '2a');
  const wompiUrls: string[] = [];
  page.on('request', (r) => { if (/wompi\.co/.test(r.url())) wompiUrls.push(r.url()); });
  page.on('frameattached', () => { /* noop */ });
  await login(page, PADRE);
  await shot(page, '2a-01-dashboard');
  await abrirTiendaDesdeMenu(page, '2a');
  await armarCarrito(page, '2a', 1);
  // cantidad: +3 sobre stock 1
  const dlg = page.locator('[role=dialog]');
  for (let i = 0; i < 3; i++) {
    await dlg.getByRole('button').filter({ has: page.locator('svg.lucide-plus') }).last().click();
    await page.waitForTimeout(300);
  }
  await shot(page, '2a-05-carrito-cantidad-4-stock-1', true);
  log('2a-carrito-qty4', (await dlg.allInnerTexts()).join('\n').slice(0, 600));
  await dlg.getByRole('button', { name: /^Pagar$/ }).click();
  await page.waitForURL(/\/checkout/, { timeout: 20_000 });
  await settle(page, 2000);
  await shot(page, '2a-06-checkout-vacio', true);
  await llenarEnvio(page);
  await shot(page, '2a-07-checkout-envio', true);
  await dumpText(page, '2a-checkout-con-envio');
  // Wompi: SOLO abrir el widget para ver la llave pública; NO pagar.
  const payBtn = page.getByRole('button', { name: /^Pagar/ });
  log('2a-pay-enabled-wompi', await payBtn.isEnabled());
  if (await payBtn.isEnabled()) {
    await payBtn.click();
    await page.waitForTimeout(6000);
    await shot(page, '2a-08-wompi-widget-abierto', false);
    const frames = page.frames().map((f) => f.url()).filter((u) => /wompi/.test(u));
    log('2a-wompi-frames', frames);
    log('2a-wompi-requests', wompiUrls.filter((u) => /public-key|pub_|merchants|widget/.test(u)).slice(0, 10));
    // cerrar el widget sin pagar
    await page.keyboard.press('Escape');
    const close = page.frameLocator('iframe[src*="wompi"]').getByRole('button', { name: /cerrar|close|×/i }).first();
    await close.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.goto(`${BASE}/checkout`); await settle(page, 1500);
    await llenarEnvio(page);
  }
  // Transferencia / Consignación
  await page.getByText('Transferencia / Consignación').click();
  await page.waitForTimeout(500);
  await shot(page, '2a-09-transferencia', true);
  await dumpText(page, '2a-transferencia-text');
  log('2a-hay-input-comprobante', await page.locator('input[type=file]').count());
  const pay2 = page.getByRole('button', { name: /^Pagar/ });
  log('2a-pay-enabled-manual', await pay2.isEnabled());
  await pay2.click();
  await page.waitForTimeout(6000);
  await shot(page, '2a-10-tras-pagar-transferencia', true);
  await dumpText(page, '2a-resultado-text');
});

test('2b padre (mherrera): camino alterno /shop → CartCheckoutModal (BFF /checkout/cart) — solo hasta abrir Wompi', async ({ page }) => {
  sniff(page, '2b');
  const wompiUrls: string[] = [];
  page.on('request', (r) => { if (/wompi\.co/.test(r.url())) wompiUrls.push(r.url()); });
  await login(page, PADRE);
  await page.goto(`${BASE}/shop`);
  await settle(page, 2500);
  await shot(page, '2b-01-shop', true);
  const txt = await page.locator('body').innerText();
  log('2b-shop-ve', { gorra: txt.includes(GORRA), camiseta: txt.includes(CAMISETA), termo: txt.includes('Termo del club'), otrosVendedores: txt.slice(0, 1200) });
  const card = page.locator('div').filter({ hasText: GORRA }).filter({ has: page.getByRole('button') }).last();
  const addBtn = card.getByRole('button').last();
  if (!(await addBtn.count())) { log('2b', 'no hay botón para agregar la gorra en /shop'); return; }
  await addBtn.click();
  await page.waitForTimeout(1000);
  await shot(page, '2b-02-shop-tras-agregar', true);
  const pagar = page.getByRole('button', { name: /pagar|checkout|comprar|finalizar/i }).first();
  log('2b-boton-pagar', await pagar.count());
  if (!(await pagar.count())) return;
  await pagar.click();
  await page.waitForTimeout(1500);
  await shot(page, '2b-03-modal-checkout', true);
  const dlg = page.locator('[role=dialog]').last();
  log('2b-modal-text', (await dlg.innerText().catch(() => '')).slice(0, 1500));
  const inputs = dlg.locator('input');
  log('2b-modal-inputs', await inputs.evaluateAll((els) => els.map((e: any) => ({ id: e.id, ph: e.placeholder, v: e.value }))));
});

test('2c segunda familia (Rojas): menú → vitrina → checkout', async ({ page }) => {
  sniff(page, '2c');
  await login(page, PADRE2);
  await shot(page, '2c-01-dashboard');
  await abrirTiendaDesdeMenu(page, '2c');
  await armarCarrito(page, '2c', 1);
  await page.locator('[role=dialog]').getByRole('button', { name: /^Pagar$/ }).click();
  await page.waitForURL(/\/checkout/, { timeout: 20_000 });
  await settle(page, 1500);
  await llenarEnvio(page);
  await page.getByText('Transferencia / Consignación').click();
  await page.waitForTimeout(800);
  await shot(page, '2c-05-checkout-bloqueado', true);
  log('2c-pay-enabled', await page.getByRole('button', { name: /^Pagar/ }).isEnabled());
  log('2c-msg', await page.getByText(/Selecciona una opción de envío|Completa la dirección/).allInnerTexts());
});

// ─── 4. Ataques baratos con el token del padre (REST directo) ───────────────
// Solo sobre órdenes del padre demo. NUNCA status 'paid' por REST (el cron
// autoEmitPendingOrders emitiría factura DIAN real); 'paid' se prueba aparte
// con BEGIN/ROLLBACK en SQL.
function readEnv(): { url: string; key: string } {
  const txt = fs.readFileSync(path.resolve(__dirname, '..', '..', '.env'), 'utf8');
  const get = (k: string) => (txt.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^"|"$/g, '') || '';
  return { url: get('VITE_SUPABASE_URL'), key: get('VITE_SUPABASE_PUBLISHABLE_KEY') };
}
const BFF = process.env.QA_BFF_URL || 'https://sportmaps-bff-dev.onrender.com';
const GORRA_ID = '7067038d-38b5-45e7-bd47-11e62ddc633d';
const CAMISETA_ID = '880a85ba-f002-45c9-a69f-038560872c99';
const CAMISETA_M = '15175978-f57e-4d2c-bd30-f5fa0278e8c7';

test('4 seguridad: el padre manipula órdenes, ítems y stock por REST', async ({ request }) => {
  const { url, key } = readEnv();
  expect(url).toContain('luebjarufsiadojhvxgi');
  const tok = await (await request.post(`${url}/auth/v1/token?grant_type=password`, {
    headers: { apikey: key, 'Content-Type': 'application/json' }, data: { email: PADRE, password: PASS },
  })).json();
  const uid = tok.user.id as string;
  const H = { apikey: key, Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const rest = async (m: 'GET' | 'POST' | 'PATCH', p: string, data?: unknown) => {
    const r = await request.fetch(`${url}/rest/v1/${p}`, { method: m, headers: H, data });
    let b: any; try { b = await r.json(); } catch { b = await r.text(); }
    return { s: r.status(), b };
  };

  // S0 — la orden EXACTA que crearía CheckoutPage → transactions.createProductOrder
  //      con 4 gorras (stock 1) por transferencia, si el envío no estuviera roto.
  const o1 = await rest('POST', 'orders', {
    user_id: uid, vendor_id: null, total_amount: 180000, shipping_cost: 0, tax_total: 0, status: 'pending',
    shipping_address: { line1: 'Calle 100 # 10-20 (DEMO QA)', city: 'Bogotá', department: 'Cundinamarca', country: 'CO' },
    contact_email: PADRE, contact_phone: '3000000000', customer_name: 'Mauricio Herrera',
    payment_method: 'Transferencia manual', payment_provider: null, provider_reference: 'QA-TIENDA-BASE-O1',
    notes: 'QA tienda baseline 2026-10-03 (réplica del insert del CheckoutPage)',
  });
  log('4-S0-order', o1);
  const O1 = o1.b?.[0]?.id;
  const it1 = await rest('POST', 'order_items', [{ order_id: O1, product_id: GORRA_ID, quantity: 4, unit_price: 45000, subtotal: 180000, vendor_id: null }]);
  log('4-S0-items', it1);

  // T3a — el comprador baja el total de su orden
  const t3a = await rest('PATCH', `orders?id=eq.${O1}`, { total_amount: 1000 });
  log('4-T3a-total-1000', { s: t3a.s, total: t3a.b?.[0]?.total_amount });
  // T3b — el comprador cambia el estado a uno que solo pone el vendedor (no 'paid')
  const t3b = await rest('PATCH', `orders?id=eq.${O1}`, { status: 'processing' });
  log('4-T3b-status-processing', { s: t3b.s, status: t3b.b?.[0]?.status });
  // T3c — estado inventado (status sin CHECK)
  const t3c = await rest('PATCH', `orders?id=eq.${O1}`, { status: 'qa_estado_inventado' });
  log('4-T3c-status-inventado', { s: t3c.s, status: t3c.b?.[0]?.status });
  // dejar O1 como la crearía la UI, para que la escuela la vea "normal"
  const back = await rest('PATCH', `orders?id=eq.${O1}`, { total_amount: 180000, status: 'pending' });
  log('4-O1-restaurada', { s: back.s, total: back.b?.[0]?.total_amount, status: back.b?.[0]?.status });

  // T4 — orden nueva con ítem a precio libre ($1) de la camiseta talla M
  const o2 = await rest('POST', 'orders', {
    user_id: uid, total_amount: 1, status: 'pending', payment_method: 'Transferencia manual',
    provider_reference: 'QA-TIENDA-BASE-O2-T4', notes: 'QA T4: precio libre desde el cliente',
  });
  const O2 = o2.b?.[0]?.id;
  const t4 = await rest('POST', 'order_items', [{ order_id: O2, product_id: CAMISETA_ID, variant_id: CAMISETA_M, quantity: 1, unit_price: 1, subtotal: 1, vendor_id: uid }]);
  log('4-T4-item-precio-1-vendor-yo', { order: { s: o2.s, id: O2 }, item: { s: t4.s, b: t4.b } });

  // T6 — stock y precio del producto (RLS products_update_own → debería dar 0 filas)
  const t6a = await rest('PATCH', `products?id=eq.${GORRA_ID}`, { stock: 999, price: 1 });
  log('4-T6-products-update', t6a);
  const t6b = await rest('PATCH', `product_variants?id=eq.${CAMISETA_M}`, { stock: 999 });
  log('4-T6-variants-update', t6b);
  const t6c = await rest('POST', 'products', { vendor_id: uid, name: 'QA T5 producto colgado', price: 1, stock: 1, visibility: 'public', status: 'active' });
  log('4-T5-insert-producto-propio', t6c);

  // Visibilidad: ¿el padre ve el termo school_only por REST?
  const sv = await rest('GET', `products?select=id,name,visibility,school_id&id=eq.dacef39a-9eaa-4389-94c9-6e7d1557bdd5`);
  log('4-school_only-visible-padre', sv);

  // BFF /checkout/cart (el camino "bueno"): ¿respeta stock 1? ¿qué total arma?
  const bff1 = await request.post(`${BFF}/api/v1/marketplace/checkout/cart`, {
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
    data: { items: [{ productId: GORRA_ID, quantity: 4 }], shippingAddress: { line1: 'Calle 100 # 10-20', city: 'Bogotá', department: 'Bogota DC' },
            contactPhone: '3000000000', contactEmail: PADRE, customerName: 'Mauricio Herrera', preferredProvider: 'wompi' },
  });
  log('4-BFF-cart-qty4-stock1', { s: bff1.status(), b: (await bff1.text()).slice(0, 800) });
  const bff2 = await request.post(`${BFF}/api/v1/marketplace/checkout/cart`, {
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
    data: { items: [{ productId: GORRA_ID, quantity: 1 }], shippingAddress: { line1: 'Retiro en sede (no hay opción)', city: 'Bogotá', department: 'Bogota DC' },
            contactPhone: '3000000000', contactEmail: PADRE, customerName: 'Mauricio Herrera', notes: 'QA tienda baseline O3', preferredProvider: 'wompi' },
  });
  log('4-BFF-cart-qty1', { s: bff2.status(), b: (await bff2.text()).slice(0, 1200) });
});

// ─── 3. Escuela: ¿ve y gestiona el pedido? ───────────────────────────────────
test('3 escuela (gerencia): pedidos, gestión, notificación, contabilidad', async ({ page }) => {
  sniff(page, '3');
  await login(page, OWNER);
  await page.goto(`${BASE}/orders`);
  await settle(page, 3000);
  await shot(page, '3-01-pedidos', true);
  await dumpText(page, '3-pedidos-text');
  // ¿hay acciones para preparar/entregar?
  const ver = page.getByRole('button', { name: /Ver/i }).first();
  if (await ver.count()) { await ver.click(); await page.waitForTimeout(1500); await shot(page, '3-02-pedido-detalle', true); await dumpText(page, '3-pedido-detalle-text'); await page.keyboard.press('Escape'); }
  log('3-botones-estado', await page.getByRole('button', { name: /preparar|enviado|entregar|despachar|marcar|procesar/i }).count());
  // Notificaciones
  await page.goto(`${BASE}/notifications`);
  await settle(page, 2500);
  await shot(page, '3-03-notificaciones', true);
  const n = await page.locator('main').innerText().catch(() => '');
  log('3-notif-venta', { nuevaVenta: /Nueva Venta|Vendiste|pedido/i.test(n), head: n.slice(0, 600) });
  // Contabilidad
  await page.goto(`${BASE}/accounting`);
  await settle(page, 3000);
  await shot(page, '3-04-accounting', true);
  await dumpText(page, '3-accounting-text');
  // Panel vendedor
  await page.goto(`${BASE}/vendor/dashboard`);
  await settle(page, 3000);
  await shot(page, '3-05-vendor-dashboard', true);
  await dumpText(page, '3-vendor-dashboard-text');
});

// ─── 5. Móvil (Pixel 7) ──────────────────────────────────────────────────────
test.describe('5 móvil Pixel 7', () => {
  const { defaultBrowserType: _b, ...pixel7 } = devices['Pixel 7'];
  test.use(pixel7);
  test('5 padre en celular: menú → vitrina → carrito → checkout', async ({ page }) => {
    sniff(page, '5');
    await login(page, PADRE);
    await shot(page, '5-01-dashboard-movil');
    await abrirTiendaDesdeMenu(page, '5');
    await shot(page, '5-02-vitrina-movil', true);
    await armarCarrito(page, '5', 1);
    await shot(page, '5-03-carrito-movil');
    await page.locator('[role=dialog]').getByRole('button', { name: /^Pagar$/ }).click();
    await page.waitForURL(/\/checkout/, { timeout: 20_000 });
    await settle(page, 1500);
    await shot(page, '5-04-checkout-movil', true);
    await llenarEnvio(page);
    await page.getByText('Transferencia / Consignación').click();
    await page.waitForTimeout(800);
    await shot(page, '5-05-checkout-movil-transferencia', true);
    log('5-pay-enabled', await page.getByRole('button', { name: /^Pagar/ }).isEnabled());
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    log('5-overflow-horizontal-px', overflow);
  });
});
