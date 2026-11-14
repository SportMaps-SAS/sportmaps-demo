// Tienda — productos e inventario del lado de la tienda (stock POR variante).
// Corre SOLO contra el gemelo local (docs/qa-gemelo-local.md):
//
//   npm run qa:twin:up                                    (raíz; migración 20261008163938 aplicada)
//   BFF local con las variables del gemelo en 3199 (sin bff/.env)
//   cd frontend && QA_TWIN_BFF_URL=http://127.0.0.1:3199 \
//     npx playwright test -c playwright.gemelo.config.ts tienda/tienda-inventario-variantes.spec.ts --project=desktop-chrome
//
// owner.a (dueño de la tienda escolar de QA Academia Andes) crea una licra con
// 3 tallas y stock DISTINTO por talla, la edita (el paso de variantes muestra el
// stock real, no 0, y guardar mueve el stock por inventory_adjust con kardex) y
// la ve en /inventory con la suma de variantes; ajuste rápido con motivo y
// historial. Escribe en el gemelo: un producto "QA E2E Licra …" por corrida
// (se borran los de corridas anteriores al empezar).
import { test, expect, type Page } from '@playwright/test';
import { TIENDA, assertBffEsGemelo, contextoComo, prepararTiendaGemelo, sqlGemelo, COMPROBANTE_PNG } from './gemelo';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const NOMBRE = `QA E2E Licra ${Date.now().toString(36)}`;

test.beforeAll(async () => {
    prepararTiendaGemelo();
    await assertBffEsGemelo();
    // Solo artefactos de este spec (gemelo local).
    sqlGemelo(`delete from public.products where name like 'QA E2E Licra %'
                 and vendor_profile_id = '${TIENDA.vendorProfileId}';`);
});

// eslint-disable-next-line no-empty-pattern -- Playwright exige desestructurar el 1.er argumento
test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop-chrome', 'escenario de escritorio');
});

function q(sql: string): string {
    return sqlGemelo(sql).trim();
}

function productoId(): string {
    return q(`select id from public.products where name = '${NOMBRE}' limit 1;`);
}

/** stock por talla (S,M,L) | products.stock | Σ variantes activas | filas de kardex */
function estado(id: string) {
    const tallas = q(`select string_agg(attributes->>'talla' || '=' || stock, ',' order by sort_order)
                        from public.product_variants where product_id = '${id}';`);
    const [prod, suma, kardex] = q(`select p.stock,
                (select coalesce(sum(stock) filter (where is_active is not false), 0) from public.product_variants where product_id = p.id),
                (select count(*) from public.inventory_logs where product_id = p.id)
           from public.products p where p.id = '${id}';`).split('|').map(Number);
    return { tallas, prod, suma, kardex };
}

async function siguiente(page: Page) {
    await page.getByRole('button', { name: 'Siguiente' }).click();
}

test('crear producto con 3 tallas y stock distinto → editarlo → verlo en /inventory con kardex', async ({ browser }) => {
    const ctx = await contextoComo(browser, 'owner.a');
    const page = await ctx.newPage();

    // ── 1. Crear ────────────────────────────────────────────────────────────
    await page.goto('/vendor/products/new');
    await page.getByRole('button', { name: /Ropa Deportiva/ }).click();
    await siguiente(page);

    await page.getByPlaceholder(/Tenis Nike/).fill(NOMBRE);
    await page.getByPlaceholder(/Qué hace especial/).fill('Licra de compresión para entrenamiento de fuerza y cardio, tela respirable.');
    await page.getByPlaceholder('120000').fill('89000');
    await page.locator('input[type="file"]').setInputFiles({ name: 'licra.png', mimeType: 'image/png', buffer: COMPROBANTE_PNG });
    await expect(page.locator('img[alt]').first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('combobox').filter({ hasText: /Selecciona género/i }).click();
    await page.getByRole('option', { name: 'mujer' }).click();
    // "voleibol" ya está en Deporte de Ropa Deportiva (migración 20261008163938).
    await page.getByRole('combobox').filter({ hasText: /Selecciona deporte/i }).click();
    await expect(page.getByRole('option', { name: 'voleibol' })).toBeVisible();
    await page.getByRole('option', { name: 'gym' }).click();
    await siguiente(page);

    await page.getByRole('switch', { name: 'Este producto tiene variantes' }).click();
    for (const t of ['S', 'M', 'L']) await page.getByRole('button', { name: t, exact: true }).click();
    await page.getByRole('textbox', { name: 'Agregar color' }).fill('Negro');
    await page.getByRole('textbox', { name: 'Agregar color' }).press('Enter');
    const filas = page.getByTestId('variant-stock-row');
    await expect(filas).toHaveCount(3);
    await page.getByLabel('Stock S / Negro').fill('12');
    await page.getByLabel('Stock M / Negro').fill('7');
    await page.getByLabel('Stock L / Negro').fill('3');
    await expect(page.getByTestId('variants-total-units')).toHaveText('22 unidades');
    await siguiente(page);

    await expect(page.getByText('3 combinaciones · 22 unidades')).toBeVisible();
    await page.getByRole('button', { name: 'Publicar ahora' }).click();
    await expect(page).toHaveURL(/\/vendor\/products$/, { timeout: 30_000 });

    const card = page.locator(`[data-testid="vendor-product-card"][data-product-name="${NOMBRE}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('product-status')).toHaveText('Activo');
    await expect(card.getByTestId('product-stock')).toContainText('22');

    const id = productoId();
    let e = estado(id);
    expect(e.tallas).toBe('S=12,M=7,L=3');
    expect(e.prod).toBe(22);            // caché = Σ variantes (trigger diferido)
    expect(e.suma).toBe(22);
    expect(e.kardex).toBe(3);           // "Stock inicial" por talla
    expect(q(`select string_agg(distinct note, ',') from public.inventory_logs where product_id = '${id}';`)).toBe('Stock inicial');

    // ── 2. Editar: el paso de variantes muestra el stock real y guardar lo mueve ──
    await card.getByRole('button', { name: `Editar ${NOMBRE}` }).click();
    await expect(page.getByRole('heading', { name: 'Editar producto' })).toBeVisible();
    await siguiente(page);              // paso 1 → 2 (categoría ya elegida)
    await expect(page.getByPlaceholder(/Tenis Nike/)).toHaveValue(NOMBRE);
    await siguiente(page);              // paso 2 → 3
    await expect(page.getByLabel('Stock S / Negro')).toHaveValue('12');
    await expect(page.getByLabel('Stock M / Negro')).toHaveValue('7');
    await expect(page.getByLabel('Stock L / Negro')).toHaveValue('3');
    await page.getByLabel('Stock M / Negro').fill('9');
    await page.getByLabel('Stock L / Negro').fill('1');
    await siguiente(page);
    // Producto activo: se guarda sin despublicar (no hay "Publicar ahora").
    await expect(page.getByRole('button', { name: 'Publicar ahora' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page).toHaveURL(/\/vendor\/products$/, { timeout: 30_000 });

    e = estado(id);
    expect(e.tallas).toBe('S=12,M=9,L=1');
    expect(e.prod).toBe(22);
    expect(e.kardex).toBe(5);           // +2 ajustes "Edición del producto"
    expect(q(`select status from public.products where id = '${id}';`)).toBe('active');

    // ── 3. /inventory: stock por producto (Σ) y por variante, ajuste con motivo, historial ──
    await page.goto('/inventory');
    const fila = page.locator(`[data-testid="inventory-row"][data-product-name="${NOMBRE}"]`);
    await expect(fila).toBeVisible({ timeout: 20_000 });
    await expect(fila.getByTestId('inventory-stock')).toHaveText('22');
    await expect(page.getByTestId('stock-por-categoria')).toContainText('Ropa Deportiva');
    await expect(page.getByTestId('stock-por-categoria')).not.toContainText('Fútbol');

    await fila.getByRole('button', { name: `Ver variantes de ${NOMBRE}` }).click();
    const variante = (n: string) => page.locator(`[data-testid="inventory-variant-row"][data-variant-name="${n}"]`);
    await expect(variante('S / Negro').getByTestId('variant-stock')).toHaveText('12');
    await expect(variante('M / Negro').getByTestId('variant-stock')).toHaveText('9');
    await expect(variante('L / Negro').getByTestId('variant-stock')).toHaveText('1');

    // L (1 unidad) cae en "stock bajo" con el mínimo del producto (5), no con < 20 fijo.
    await expect(variante('L / Negro')).toContainText('Stock bajo');
    await expect(variante('S / Negro')).toContainText('Con stock');

    // Ajuste rápido: llegaron 5 de la L.
    await variante('L / Negro').getByRole('button', { name: 'Ajustar L / Negro' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('adjust-current')).toHaveText('1');
    await dialog.getByLabel(/Unidades/).fill('5');
    await dialog.getByLabel('Detalle (opcional)').fill('factura 77 del proveedor');
    await dialog.getByRole('button', { name: 'Guardar ajuste' }).click();
    await expect(dialog).toBeHidden();
    await expect(fila.getByTestId('inventory-stock')).toHaveText('27', { timeout: 15_000 });

    e = estado(id);
    expect(e.tallas).toBe('S=12,M=9,L=6');
    expect(e.prod).toBe(27);
    expect(e.kardex).toBe(6);
    expect(q(`select reason || '|' || note || '|' || delta from public.inventory_logs
               where product_id = '${id}' order by created_at desc limit 1;`))
        .toBe('manual_restock|Llegó mercancía: factura 77 del proveedor|5');

    // Historial (kardex) del producto.
    await fila.getByRole('button', { name: `Historial de ${NOMBRE}` }).click();
    const kardex = page.getByTestId('kardex-row');
    await expect(kardex).toHaveCount(6, { timeout: 15_000 });
    await expect(kardex.first()).toContainText('Llegó mercancía: factura 77 del proveedor');
    await expect(page.getByTestId('kardex-table')).toContainText('Edición del producto');
    await expect(page.getByTestId('kardex-table')).toContainText('Stock inicial');

    await ctx.close();
});

test('producto viejo sin "Género" se puede editar (no traba el paso 2)', async ({ browser }) => {
    // La camiseta del seed (d…001) está en Ropa Deportiva sin el atributo "genero".
    const camiseta = '00000000-0000-4000-d000-000000000001';
    expect(q(`select coalesce(attributes->>'genero', '') from public.products where id = '${camiseta}';`)).toBe('');
    expect(q(`select c.slug from public.products p join public.product_categories c on c.id = p.category_id where p.id = '${camiseta}';`))
        .toBe('ropa-deportiva');
    const antes = q(`select string_agg(id || '=' || stock, ',' order by id) from public.product_variants where product_id = '${camiseta}';`);

    const ctx = await contextoComo(browser, 'owner.a');
    const page = await ctx.newPage();
    await page.goto(`/vendor/products/${camiseta}/edit`);
    await expect(page.getByRole('heading', { name: 'Editar producto' })).toBeVisible({ timeout: 20_000 });
    await siguiente(page);
    await expect(page.getByTestId('legacy-attrs-alert')).toContainText('Género');
    await expect(page.getByRole('button', { name: 'Siguiente' })).toBeEnabled();
    await siguiente(page);
    // Stock real por talla (no 0).
    await expect(page.getByTestId('variant-stock-row')).toHaveCount(3);
    await siguiente(page);
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page).toHaveURL(/\/vendor\/products$/, { timeout: 30_000 });
    // Guardar sin tocar el stock no mueve inventario.
    expect(q(`select string_agg(id || '=' || stock, ',' order by id) from public.product_variants where product_id = '${camiseta}';`)).toBe(antes);
    await ctx.close();
});
