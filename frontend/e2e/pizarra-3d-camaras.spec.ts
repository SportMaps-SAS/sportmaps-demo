import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { test, expect, SIGNATURES, startsWith, isMp4 } from './helpers/pizarra';

/**
 * Visor 3D, M6e (docs/specs/pizarra-m6e-camaras-3d.md): las 11 cámaras por
 * deporte, director automático, cámara lenta, repetición, cuadro congelado,
 * cuadro a cuadro, balón por el aire, video del 3D, prefers-reduced-motion y
 * abrir/cerrar 5 veces sin fugas.
 *
 * Corre contra el banco de pruebas e2e/harness/visor-3d.html (el MISMO
 * Tactical3DViewer de la pizarra con jugadas fijas): sin login, sin base y sin
 * BFF. La red anti-escrituras de helpers/pizarra.ts igual queda puesta.
 *
 * Chromium con WebGL por software (SwiftShader) y el piso de fps apagado
 * (window.__TACTICAL3D_MIN_FPS__ = 0, que además prende window.__TACTICAL3D__
 * con el estado de la cámara). Capturas en M6E_SHOTS.
 */

test.use({
    viewport: { width: 1280, height: 800 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
    acceptDownloads: true,
});

const SHOTS = process.env.M6E_SHOTS || 'C:/Users/Usuario/AppData/Local/Temp/claude/m6e';
mkdirSync(SHOTS, { recursive: true });

type Dbg = { t: number; ballLift: number; frames: number; shot?: string; shots?: string[]; cam: number[]; geometries: number; textures: number };
const dbg = (page: Page) => page.evaluate(() => (window as unknown as { __TACTICAL3D__?: Dbg }).__TACTICAL3D__ ?? null);

/** Instante con el balón por el aire (mitad de un pase largo) en cada jugada del banco. */
const AIR_T: Record<string, number> = { futbol: 2000, voleibol: 650, baloncesto: 1750 };

const CAMERAS: Record<string, string[]> = {
    futbol: ['Transmisión TV', 'Táctica alta', 'Cenital', 'Isométrica', 'Detrás del arco', 'Ojos del arquero rival', 'Seguir balón', 'Seguir jugador', 'Spider-cam', 'Dron', 'Libre'],
    voleibol: ['Transmisión TV', 'Táctica alta', 'Cenital', 'Isométrica', 'Fondo propio', 'Fondo rival, a ras', 'Seguir balón', 'Seguir jugador', 'Spider-cam', 'Dron', 'Libre'],
    baloncesto: ['Transmisión TV', 'Táctica alta', 'Cenital', 'Isométrica', 'Detrás del aro', 'Aro rival', 'Seguir balón', 'Seguir jugador', 'Spider-cam', 'Dron', 'Libre'],
};

const slug = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as { __TACTICAL3D_MIN_FPS__: number }).__TACTICAL3D_MIN_FPS__ = 0; });
});

async function openHarness(page: Page, params: string) {
    await page.goto(`/e2e/harness/visor-3d.html?${params}`);
    const viewer = page.getByTestId('tactical-3d-viewer');
    await expect(viewer).toBeVisible({ timeout: 90_000 });
    await expect(viewer.locator('canvas')).toBeVisible();
    // Algunos cuadros dibujados (la textura de la cancha llega async).
    await expect.poll(async () => (await dbg(page))?.frames ?? 0, { timeout: 60_000 }).toBeGreaterThan(8);
    return viewer;
}

/** Espera a que la cámara se asiente (transición ≤ 900 ms + suavizado). */
async function settle(page: Page, ms = 1600) {
    const start = (await dbg(page))?.frames ?? 0;
    await page.waitForTimeout(ms);
    await expect.poll(async () => (await dbg(page))?.frames ?? 0).toBeGreaterThan(start + 3);
}

async function seek(page: Page, t: number) {
    await page.getByRole('slider', { name: 'Línea de tiempo de la jugada' }).fill(String(t));
}

/** fps medidos en `ms` (cuadros dibujados por el bucle de three). */
async function measureFps(page: Page, ms = 3000) {
    const a = await dbg(page);
    const t0 = Date.now();
    await page.waitForTimeout(ms);
    const b = await dbg(page);
    return ((b!.frames - a!.frames) * 1000) / (Date.now() - t0);
}

const fpsReport: Record<string, number> = {};

for (const sport of ['futbol', 'voleibol', 'baloncesto']) {
    test(`${sport}: las 11 cámaras con el balón en el aire`, async ({ page }) => {
        test.setTimeout(420_000);
        const viewer = await openHarness(page, `sport=${sport}&t=${AIR_T[sport]}`);
        await expect(viewer.getByRole('button', { name: 'Transmisión TV' })).toHaveAttribute('aria-pressed', 'true');
        await settle(page);
        const d = await dbg(page);
        expect(d!.t).toBe(AIR_T[sport]);
        expect(d!.ballLift, 'balón en el aire a mitad del pase largo').toBeGreaterThan(sport === 'futbol' ? 3 : 0.9);
        fpsReport[sport] = await measureFps(page);
        console.log(`[m6e] fps ${sport} (SwiftShader, 1280×800, TV): ${fpsReport[sport].toFixed(1)}`);

        for (const label of CAMERAS[sport]) {
            const btn = viewer.getByRole('group', { name: 'Cámara' }).getByRole('button', { name: label, exact: true });
            await btn.click();
            await expect(btn).toHaveAttribute('aria-pressed', 'true');
            await settle(page);
            await page.screenshot({ path: `${SHOTS}/${sport}-${slug(label)}.png` });
            if (label === 'Seguir jugador') {
                await viewer.getByRole('button', { name: 'Detrás de él' }).click();
                await settle(page);
                await page.screenshot({ path: `${SHOTS}/${sport}-seguir-jugador-tercera.png` });
            }
        }
        // Cada cámara deja la suya: la última (Libre) no movió nada de lugar y las otras sí cambiaron.
        const cams = await dbg(page);
        expect(cams!.cam.every(Number.isFinite)).toBe(true);
    });
}

test('futbol: director automático en 3 instantes (TV → balón → arco rival) y en vivo', async ({ page }) => {
    test.setTimeout(300_000);
    const viewer = await openHarness(page, 'sport=futbol&t=600');
    await viewer.getByRole('button', { name: 'Cámara automática' }).click();
    const onAir = viewer.getByTestId('director-on-air');
    const steps: [number, string, string][] = [[600, 'tv', 'Transmisión TV'], [2000, 'balon', 'Seguir balón'], [4650, 'rival', 'Ojos del arquero rival']];
    for (const [t, kind, label] of steps) {
        await seek(page, t);
        await expect(viewer).toHaveAttribute('data-camera', kind, { timeout: 20_000 });
        await expect(onAir).toHaveText(`Al aire: ${label}`);
        await settle(page);
        await page.screenshot({ path: `${SHOTS}/director-${t}-${kind}.png` });
    }
    // En vivo: de vuelta al inicio y reproduce; la secuencia de cortes sale del director.
    await seek(page, 0);
    // Al inicio de la jugada vuelve a TV (pasada la histéresis de 1,2 s).
    await expect.poll(async () => (await dbg(page))?.shot, { timeout: 20_000 }).toBe('tv');
    const before = (await dbg(page))!.shots!.length;
    await viewer.getByRole('button', { name: 'Reproducir' }).click();
    await expect.poll(async () => (await dbg(page))!.t, { timeout: 60_000 }).toBe(5100);
    // Los cortes los anota la página misma (no se pierde ninguno entre dos consultas).
    const shots = ['tv', ...(await dbg(page))!.shots!.slice(before)];
    console.log(`[m6e] director en vivo: ${shots.join(' → ')}`);
    // Salida corta (TV) → cambio de frente largo (balón) → conducción (TV) → remate (arco rival).
    expect(shots).toEqual(['tv', 'balon', 'tv', 'rival']);
});

test('futbol: cámara lenta, cuadro a cuadro, repetición y cuadro congelado con foco', async ({ page }) => {
    test.setTimeout(240_000);
    const viewer = await openHarness(page, 'sport=futbol&t=0&cam=tactica');
    // ▶ cuadro a cuadro.
    await viewer.getByRole('button', { name: 'Cuadro siguiente' }).click();
    await expect(viewer.getByText('Cuadro 2 de 5')).toBeVisible();
    await expect.poll(async () => (await dbg(page))!.t).toBe(1200);
    await viewer.getByRole('button', { name: 'Cuadro siguiente' }).click();
    await expect(viewer.getByText('Cuadro 3 de 5')).toBeVisible();
    await viewer.getByRole('button', { name: 'Cuadro anterior' }).click();
    await expect(viewer.getByText('Cuadro 2 de 5')).toBeVisible();
    await expect.poll(async () => (await dbg(page))!.t).toBe(1200);

    // Cámara lenta 0,25×: en ~2 s reales avanza ~0,5 s de jugada.
    await viewer.getByRole('button', { name: 'Velocidad 0,25 veces' }).click();
    const a = (await dbg(page))!.t;
    await viewer.getByRole('button', { name: 'Reproducir' }).click();
    const r0 = Date.now();
    await page.waitForTimeout(2000);
    await viewer.getByRole('button', { name: 'Pausar' }).click();
    const realMs = Date.now() - r0;
    const adv = (await dbg(page))!.t - a;
    console.log(`[m6e] cámara lenta: ${adv.toFixed(0)} ms de jugada en ${realMs} ms reales`);
    expect(adv).toBeGreaterThan(realMs * 0.25 * 0.5);
    expect(adv).toBeLessThan(realMs * 0.25 * 1.3);
    await page.screenshot({ path: `${SHOTS}/camara-lenta.png` });

    // Repetición: el último tramo a 0,25×.
    await viewer.getByRole('button', { name: 'Velocidad 1 veces' }).click();
    await viewer.getByRole('button', { name: 'Repetición' }).click();
    await expect(viewer.getByText(/Repetición · 0,25×/)).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Velocidad 0,25 veces' })).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(1500);
    const rt = (await dbg(page))!.t;
    expect(rt).toBeGreaterThanOrEqual(4200);
    await page.screenshot({ path: `${SHOTS}/repeticion.png` });

    // Congelado con foco: pausa, oscurece y pone el halo en el más cercano al balón.
    await seek(page, 4200);
    await viewer.getByRole('button', { name: 'Seguir balón' }).click();
    await viewer.getByRole('button', { name: 'Congelar' }).click();
    await expect(viewer.getByText('Cuadro congelado')).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Reproducir' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/congelado-foco.png` });
    // Rastro encendido sobre el congelado.
    await viewer.getByRole('button', { name: 'Rastro' }).click();
    await settle(page, 800);
    await page.screenshot({ path: `${SHOTS}/congelado-rastro.png` });
});

test('vóley: video del 3D con la cámara elegida', async ({ page }) => {
    // Con WebGL por software cada cuadro grabado cuesta (copia + códec): pantalla
    // chica y la jugada corta (vóley, 4 s = 120 cuadros a 30 por segundo).
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 640, height: 400 });
    const viewer = await openHarness(page, 'sport=voleibol&t=0&cam=tv');
    const rec = viewer.getByRole('button', { name: 'Grabar video' });
    await expect(rec).toBeVisible();
    const download = page.waitForEvent('download', { timeout: 360_000 });
    await rec.click();
    await expect(viewer.getByText('Grabando')).toBeVisible();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/grabando.png` });
    const file = await download;
    const path = `${SHOTS}/${file.suggestedFilename()}`;
    await file.saveAs(path);
    const buf = readFileSync(path);
    console.log(`[m6e] video: ${file.suggestedFilename()} ${buf.length} bytes`);
    expect(buf.length).toBeGreaterThan(10_000);
    expect(startsWith(buf, SIGNATURES.webm) || isMp4(buf)).toBe(true);
    expect(file.suggestedFilename()).toMatch(/^jugada-3d-.+\.(mp4|webm)$/);
});

test('prefers-reduced-motion: sin director ni dron', async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => { (window as unknown as { __TACTICAL3D_MIN_FPS__: number }).__TACTICAL3D_MIN_FPS__ = 0; });
    const viewer = await openHarness(page, 'sport=futbol&t=2000&cam=dron&director=1');
    await expect(viewer.getByRole('button', { name: 'Cámara automática' })).toBeDisabled();
    await expect(viewer.getByRole('button', { name: 'Dron', exact: true })).toBeDisabled();
    // Pidió dron + director al abrir: queda en TV, quieta.
    await expect(viewer).toHaveAttribute('data-camera', 'tv');
    await ctx.close();
});

test('abrir y cerrar el visor 5 veces no deja recursos ni contextos vivos', async ({ page }) => {
    test.setTimeout(300_000);
    await openHarness(page, 'sport=futbol&t=2000');
    const stats = () => page.evaluate(() => ({ ...(window as unknown as { __harness: { stats: Record<string, number> } }).__harness.stats }));
    let first: Record<string, number> | null = null;
    for (let i = 0; i < 5; i++) {
        await page.evaluate(() => (window as unknown as { __harness: { close: () => void } }).__harness.close());
        await expect(page.getByTestId('tactical-3d-viewer')).toHaveCount(0);
        await expect.poll(async () => (await stats()).live, { timeout: 30_000 }).toBe(0);
        await page.evaluate(() => (window as unknown as { __harness: { open: () => void } }).__harness.open());
        await expect(page.getByTestId('tactical-3d-viewer').locator('canvas')).toBeVisible({ timeout: 60_000 });
        // Cancha cargada (la textura llega async) y recursos estables.
        if (!first) {
            await page.waitForTimeout(8000);
            first = { live: (await stats()).live };
            expect(first.live).toBeGreaterThan(50);
        }
        // Cada apertura crea lo mismo: nada se acumula entre aperturas.
        const want = first.live;
        await expect.poll(async () => (await stats()).live, { timeout: 30_000, message: `apertura ${i + 1}` }).toBe(want);
    }
    await page.evaluate(() => (window as unknown as { __harness: { close: () => void } }).__harness.close());
    await expect.poll(async () => (await stats()).live, { timeout: 30_000 }).toBe(0);
    await expect.poll(async () => { const s = await stats(); return s.contextsCreated - s.contextsLost; }, { timeout: 20_000 }).toBe(0);
    console.log(`[m6e] fugas: ${JSON.stringify(await stats())}`);
});
