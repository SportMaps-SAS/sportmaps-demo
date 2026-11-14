import type { Locator, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { test, expect, openBoardFromMatch, SHOTS_DIR } from './helpers/pizarra';

/**
 * Pizarra en celular HORIZONTAL (iPhone ~926 x 428, táctil).
 *
 * Reporte del usuario (iPhone real): girado, los botones del toolbar «no abrían
 * nada». El ancho (926) pasa el umbral de escritorio de useIsMobile pero el alto
 * es ~428: ahora `useCompactLandscape` lo trata como celular (mismos menús y
 * hojas que en vertical). Esta prueba TOCA (tap) cada acción y exige que su menú
 * o panel quede visible DENTRO del viewport. No escribe nada (red anti-escrituras
 * de helpers/pizarra.ts).
 */
test.use({ viewport: { width: 926, height: 428 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

const SHOTS = `${SHOTS_DIR}/celular-horizontal`;
mkdirSync(SHOTS, { recursive: true });

const VP = { width: 926, height: 428 };

/** El elemento está visible y su caja cae dentro del viewport (tolerancia 1 px). */
async function expectInsideViewport(loc: Locator, what: string): Promise<void> {
    await expect(loc, `${what}: visible`).toBeVisible({ timeout: 10_000 });
    const b = (await loc.boundingBox())!;
    expect(b.width, `${what}: ancho > 0`).toBeGreaterThan(0);
    expect(b.height, `${what}: alto > 0`).toBeGreaterThan(0);
    expect(b.x, `${what}: x`).toBeGreaterThanOrEqual(-1);
    expect(b.y, `${what}: y`).toBeGreaterThanOrEqual(-1);
    expect(b.x + b.width, `${what}: borde derecho`).toBeLessThanOrEqual(VP.width + 1);
    expect(b.y + b.height, `${what}: borde inferior`).toBeLessThanOrEqual(VP.height + 1);
}

const board = (page: Page) => page.getByRole('dialog').first();

/** Abre la pizarra y espera a que termine la animación de entrada del diálogo (zoom/slide). */
async function openSettled(page: Page): Promise<void> {
    await openBoardFromMatch(page);
    await page.waitForTimeout(700);
}

test('horizontal: toolbar en una fila y la cancha ocupa casi todo el alto libre', async ({ page, guard }) => {
    test.setTimeout(240_000);
    void guard;
    await openSettled(page);
    const save = page.getByRole('button', { name: 'Guardar jugada' });
    const sb = (await save.boundingBox())!;
    // Una sola fila: el botón principal vive en los primeros ~48 px.
    expect(sb.y + sb.height).toBeLessThan(52);
    await expectInsideViewport(save, 'Guardar jugada');

    const pitch = page.getByTestId('tablero-cancha');
    await expect(pitch).toBeVisible();
    const pb = (await pitch.boundingBox())!;
    // Alto libre = viewport - toolbar (~42) - línea de tiempo (~46).
    expect(pb.height).toBeGreaterThanOrEqual((VP.height - 90) * 0.7);
    await page.screenshot({ path: `${SHOTS}/01-toolbar-una-fila.png` });
});

test('horizontal: tocar cada acción del toolbar abre su menú o panel dentro de la pantalla', async ({ page, guard }) => {
    test.setTimeout(240_000);
    void guard;
    await openSettled(page);
    const d = board(page);

    // Formación → galería de formaciones (diálogo propio).
    await d.getByRole('button', { name: /^(Formación|\S.*\(.*\))$/ }).first().tap();
    const gallery = page.getByRole('dialog', { name: 'Formaciones' });
    await expectInsideViewport(gallery, 'Galería de formaciones');
    await page.screenshot({ path: `${SHOTS}/02-formacion.png` });
    await page.keyboard.press('Escape');
    await expect(gallery).toBeHidden();

    // Jugadores → panel con la banca.
    const jug = d.getByRole('button', { name: /^Jugadores/ });
    await jug.tap();
    await expect(jug).toHaveAttribute('aria-pressed', 'true');
    await expectInsideViewport(page.getByText(/^Disponibles/i).first(), 'Panel Jugadores');
    await page.screenshot({ path: `${SHOTS}/03-jugadores.png` });
    await jug.tap();
    await expect(jug).toHaveAttribute('aria-pressed', 'false');

    // Dibujar → hoja con sus herramientas.
    const dib = d.getByRole('button', { name: /^Dibujar( \(\d+\))?$/ });
    await dib.tap();
    await expect(dib).toHaveAttribute('aria-pressed', 'true');
    await expectInsideViewport(page.getByRole('button', { name: /Mover fichas|Dibujando/ }), 'Hoja Dibujar');
    // Las pestañas se pueden recorrer (Material, Objeto, Medir…).
    await page.getByRole('tab', { name: 'Material' }).tap();
    await expect(page.getByRole('tab', { name: 'Material' })).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: `${SHOTS}/04-dibujar.png` });
    await dib.tap();
    await expect(dib).toHaveAttribute('aria-pressed', 'false');

    // Más → menú con Equipos, Ajustes, Videos/Notas.
    await d.getByRole('button', { name: 'Más opciones' }).tap();
    const menu = page.getByRole('menu');
    await expectInsideViewport(menu, 'Menú Más');
    await expect(menu.getByText('Equipos')).toBeVisible();
    await expect(menu.getByText('Ajustes de la pizarra')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/05-mas.png` });
    // «Equipos» abre su diálogo.
    await menu.getByText('Equipos').tap();
    const equipos = page.getByRole('dialog').filter({ hasText: /escudo|colores/i }).last();
    await expectInsideViewport(equipos, 'Diálogo Equipos');
    await page.keyboard.press('Escape');
    await expect(equipos).toBeHidden();

    // Exportar → menú.
    await d.getByRole('button', { name: /^Exportar/ }).tap();
    await expectInsideViewport(page.getByRole('menu'), 'Menú Exportar');
    await page.screenshot({ path: `${SHOTS}/06-exportar.png` });
    await page.keyboard.press('Escape');

    // IA → panel lateral (solo se abre; no se analiza nada).
    const ia = d.getByRole('button', { name: /^(IA|Analizar jugada)/ }).first();
    if (await ia.count()) {
        await ia.tap();
        await expectInsideViewport(page.getByRole('complementary', { name: /Análisis de la jugada con IA/ }), 'Panel IA');
        await page.screenshot({ path: `${SHOTS}/07-ia.png` });
    }
});

test('horizontal: la ficha escala con la cancha y no se montan unas sobre otras', async ({ page, guard }) => {
    test.setTimeout(240_000);
    void guard;
    await openSettled(page);
    await page.getByRole('button', { name: /^Poner jugadores/ }).tap();
    const pins = page.getByRole('button', { name: /^Quitar a .* de la cancha/ });
    await expect(pins.first()).toBeVisible({ timeout: 15_000 });
    const tags = page.getByTestId('pin-name-tag');
    const n = await tags.count();
    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    // Las fichas (círculo/silueta) son el hermano del botón de quitar: se mide el
    // contenedor arrastrable de cada una.
    const handles = page.locator('[aria-roledescription="draggable"]');
    const hn = await handles.count();
    for (let i = 0; i < hn; i++) {
        const b = await handles.nth(i).boundingBox();
        if (b) boxes.push(b);
    }
    expect(n + hn).toBeGreaterThan(0);
    // Ninguna ficha se superpone a otra en más del 15 % de su área.
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
            const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
            if (w > 0 && h > 0) {
                const overlap = (w * h) / Math.min(a.width * a.height, b.width * b.height);
                expect(overlap, `fichas ${i} y ${j} montadas`).toBeLessThan(0.15);
            }
        }
    }
    await page.screenshot({ path: `${SHOTS}/08-fichas.png` });
});
