// Capturas de la experiencia pública del torneo con datos de ejemplo (sin base ni BFF).
// Intercepta el endpoint público y responde con el fixture local del frontend.
//
// Uso (desde la raíz del repo):
//   1) cd frontend && VITE_SUPABASE_URL=https://demo.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=demo \
//        VITE_BFF_URL=http://bff.local npx vite --port 5199 --strictPort
//   2) node docs/manuales/_src/torneos-publico-1027/capture.mjs
import { chromium } from '../../../../frontend/node_modules/playwright/index.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'capturas');
mkdirSync(out, { recursive: true });
const fixture = readFileSync(join(here, '../../../../frontend/src/components/tournaments/public/__fixtures__/torneo-demo.json'), 'utf8');
const BASE = process.env.BASE_URL ?? 'http://localhost:5199';

const browser = await chromium.launch();
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'es-CO', timezoneId: 'America/Bogota', isMobile: true, hasTouch: true });
const route = async (ctx) => {
  await ctx.route('**/api/v1/tournament-live/public/**', (r) => {
    const u = r.request().url();
    if (u.endsWith('/social')) {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        comments: [{ id: 'k1', author_name: 'Familia Rojas', body: '¡Qué partidazo, vamos Cóndores!', created_at: '2026-10-31T15:05:00Z', verified: true }],
        media: [], mvp: { available: false, reason: 'sin_planilla', voting_open: false, candidates: [], votes: {}, total: 0, winner: null }, player_stats: [],
      }) });
    }
    if (u.endsWith('/player-stats')) {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ player_stats: [
        { member_id: 'p1', name: 'Jugadora N.º 7', team_id: 't1', ace: 4, attack: 11, block: 2, points: 17 },
        { member_id: 'p2', name: 'Jugadora N.º 3', team_id: 't5', ace: 2, attack: 9, block: 3, points: 14 },
        { member_id: 'p3', name: 'Jugadora N.º 10', team_id: 't3', ace: 5, attack: 6, block: 1, points: 12 },
      ] }) });
    }
    if (!u.endsWith('/live')) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no"}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: fixture });
  });
  await ctx.route('**/maps?q=**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<body style="margin:0;background:#e5e7eb;font:14px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;color:#6b7280">Mapa de la sede</body>' }));
};
await route(mobile);
const page = await mobile.newPage();
const shot = async (name, opts = {}) => { await page.waitForTimeout(400); await page.screenshot({ path: join(out, `${name}.png`), ...opts }); console.log('ok', name); };
const tab = (n) => page.getByRole('tab', { name: n, exact: true }).click();

await page.goto(`${BASE}/torneo/copa-campestre/en-vivo`, { waitUntil: 'commit', timeout: 180_000 });
await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 180_000 });
await shot('01-encabezado-en-vivo');
await page.getByRole('radio', { name: /Todos/ }).first().click();
await shot('02-partidos-todos', { fullPage: true });
await tab('Posiciones');
await shot('03-posiciones-voleibol', { fullPage: true });
await page.locator('[aria-label="Desliza para ver todas las columnas"]').first().evaluate((el) => { el.scrollLeft = 400; });
await shot('04-posiciones-scroll-horizontal');
await tab('Programación');
await shot('05-programacion-dia-cancha', { fullPage: true });
await page.getByRole('radio', { name: 'Ahora en cada cancha' }).click();
await shot('06-programacion-ahora');
await tab('Copas');
await shot('07-copas-sub16-referencias', { fullPage: true });
await page.getByRole('radio', { name: 'Mayores · Masculino' }).click();
await shot('08-copas-mayores-campeon', { fullPage: true });
await tab('Todos los partidos');
await shot('09-todos-los-partidos');
await tab('Posiciones');
await page.getByRole('button', { name: /Campestre Titanes/ }).first().click();
await page.getByRole('dialog').waitFor();
await shot('10-ficha-equipo');
await page.keyboard.press('Escape');
await page.getByRole('button', { name: /^Compartir/ }).click();
await page.getByRole('dialog').waitFor();
await shot('11-compartir-qr');
await page.keyboard.press('Escape');
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await shot('12-patrocinadores-sede-pie');

await tab('Ranking');
await shot('12b-ranking');
await page.getByRole('button', { name: /^Compartir/ }).click();
await page.getByRole('button', { name: /Insertar en tu web/ }).click();
await page.getByRole('radio', { name: 'Copas' }).click();
await shot('12c-compartir-insertar');
await page.keyboard.press('Escape');

await page.goto(`${BASE}/torneo/copa-campestre/partido/m11`, { waitUntil: 'commit' });
await page.getByTestId('match-detail').waitFor();
await shot('13-partido-en-vivo');
await page.getByRole('tab', { name: /Comentarios/ }).click();
await shot('14-partido-comentarios');

// Vista insertada dentro de la «web de un club» (página de ejemplo servida por el interceptor en el mismo host).
const host = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'es-CO', timezoneId: 'America/Bogota' });
await route(host);
await host.route(`${BASE}/__club-demo.html`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body:
  `<!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width"><body style="margin:0;font:15px sans-serif;background:#f4f1ea">
   <header style="background:#2d2a26;color:#fff;padding:14px 16px;font-weight:700">Club Campestre Demo · Vóley</header>
   <p style="padding:0 16px">Así va nuestro torneo:</p>
   <iframe src="${BASE}/torneo/copa-campestre/embed?vista=posiciones&categoria=c1&fondo=transparente" style="border:0;width:100%;height:1100px"></iframe></body>` }));
const hp = await host.newPage();
await hp.goto(`${BASE}/__club-demo.html`, { waitUntil: 'commit' }); // mismo host: Chrome bloquea iframes de red pública a localhost
await hp.frameLocator('iframe').getByTestId('embed').waitFor({ timeout: 120_000 });
await hp.waitForTimeout(600);
await hp.screenshot({ path: join(out, '17-insertado-en-web-del-club.png') }); console.log('ok 17');

const tv = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'es-CO', timezoneId: 'America/Bogota' });
await route(tv);
const tvPage = await tv.newPage();
await tvPage.goto(`${BASE}/torneo/copa-campestre/tv`, { waitUntil: 'commit' });
await tvPage.getByTestId('tv').waitFor();
await tvPage.waitForTimeout(600);
await tvPage.screenshot({ path: join(out, '15-tv-en-vivo.png') }); console.log('ok 15');
await tvPage.waitForTimeout(10_300);
await tvPage.screenshot({ path: join(out, '16-tv-posiciones.png') }); console.log('ok 16');

await browser.close();
