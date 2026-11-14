// Tienda v2 — el padre compra en la tienda escolar y la escuela gestiona el pedido.
// Corre SOLO contra el gemelo local (docs/qa-gemelo-local.md):
//
//   npm run qa:twin:up                                    (raíz)
//   BFF local con las variables del gemelo en un puerto propio (p. ej. 3199)
//   cd frontend && QA_TWIN_BFF_URL=http://127.0.0.1:3199 \
//     npx playwright test -c playwright.gemelo.config.ts tienda/ --workers=1
//
// Escribe en el gemelo (órdenes, comprobantes); cada prueba resetea stock y
// reservas con gemelo-tienda.sql. Capturas: docs/capturas/tienda-v2-checkout/.
import { test, expect, type Page } from '@playwright/test';
import {
    TIENDA, BASE_URL, assertBffEsGemelo, captura, contextoComo, prepararTiendaGemelo, tiendaEncendida, COMPROBANTE_PNG,
} from './gemelo';

test.describe.configure({ mode: 'serial' });
test.setTimeout(150_000);

const soloDesktop = (name: string) => test.skip(name !== 'desktop-chrome', 'escenario de escritorio');

test.beforeAll(async () => {
    prepararTiendaGemelo();
    await assertBffEsGemelo();
});

// El BFF limita las operaciones de pago a 20 por minuto por IP (paymentLimiter):
// cada escenario completo hace ~15. Entre escenarios se espera a que la
// ventana se vacíe para no medir el limitador en vez de la tienda.
let ultimoFin = 0;
const esMovil = (titulo: string) => titulo.startsWith('móvil');
// eslint-disable-next-line no-empty-pattern -- Playwright exige desestructurar el 1.er argumento
test.beforeEach(async ({}, info) => {
    // Escritorio en desktop-chrome; el escenario móvil solo en pixel-7.
    test.skip((info.project.name === 'pixel-7') !== esMovil(info.title), 'escenario de otro dispositivo');
    const espera = ultimoFin ? 61_000 - (Date.now() - ultimoFin) : 0;
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    prepararTiendaGemelo();
});
// eslint-disable-next-line no-empty-pattern -- Playwright exige desestructurar el 1.er argumento
test.afterEach(({}, info) => { if (info.status !== 'skipped') ultimoFin = Date.now(); });

function card(page: Page, nombre: string) {
    return page.locator(`[data-testid="store-product-card"][data-product-name="${nombre}"]`);
}

async function abrirCarritoYPagar(page: Page) {
    await page.getByRole('button', { name: /Carrito \(|Ver carrito/ }).first().click();
    const pagar = page.getByRole('button', { name: `Pagar en ${TIENDA.nombre}` });
    await expect(pagar).toBeEnabled({ timeout: 20_000 });
    return pagar;
}

test('padre compra camiseta school_only con talla por transferencia → comprobante → la escuela aprueba → pagado → entregado con código', async ({ browser }, info) => {
    soloDesktop(info.project.name);
    const padreCtx = await contextoComo(browser, 'padre.a');
    const padre = await padreCtx.newPage();

    // Vitrina: la camiseta school_only se ve (miembro) y NO sale "Agotado" aunque products.stock no mande (B3/B4).
    await padre.goto(`/tienda/${TIENDA.slug}`);
    const camiseta = card(padre, TIENDA.camiseta);
    await expect(camiseta).toBeVisible({ timeout: 30_000 });
    await expect(camiseta.getByText('Solo para miembros')).toBeVisible();
    await expect(camiseta.getByText('Agotado')).toHaveCount(0);
    await captura(padre, '01-vitrina-padre-miembro', true);

    // Ficha: L agotada (visible, deshabilitada); se elige M.
    await camiseta.getByRole('link', { name: `Ver ${TIENDA.camiseta}` }).click();
    await expect(padre.getByRole('heading', { name: TIENDA.camiseta })).toBeVisible();
    await expect(padre.getByRole('button', { name: 'Talla L (agotada)' })).toBeDisabled();
    await padre.getByRole('button', { name: 'Talla M', exact: true }).click();
    await expect(padre.getByTestId('product-availability')).toContainText('Últimas 3 disponibles');
    await captura(padre, '02-ficha-tallas', true);
    await padre.getByRole('button', { name: 'Agregar al carrito' }).click();

    // Carrito agrupado por tienda, revalidado con quote_cart.
    const pagar = await abrirCarritoYPagar(padre);
    await expect(padre.getByTestId('cart-group-total')).toHaveText(/65\.000/);
    await captura(padre, '03-carrito');
    await pagar.click();

    // Checkout de una pantalla: retiro en sede por defecto + transferencia.
    await expect(padre).toHaveURL(new RegExp(`/checkout/tienda/${TIENDA.vendorProfileId}`));
    await expect(padre.getByRole('radio', { name: /Retiro en sede/ })).toHaveAttribute('aria-checked', 'true');
    await padre.getByRole('radio', { name: /Transferencia bancaria/ }).click();
    await expect(padre.getByTestId('checkout-total')).toHaveText(/65\.000/);
    await expect(padre.getByText(/Incluye IVA/).first()).toBeVisible();
    await expect(padre.locator('#b-name')).toHaveValue('Padre QA Miembro');
    await captura(padre, '04-checkout-una-pantalla', true);
    await padre.locator('[data-testid="pay-button"]:visible').click();

    // Detalle: cuentas REALES de la tienda (no la inventada), código de retiro, subir comprobante.
    await expect(padre).toHaveURL(/\/mis-compras\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(padre.getByTestId('transfer-account')).toContainText(TIENDA.cuenta);
    await expect(padre.getByText('123-456789-00')).toHaveCount(0);
    const codigo = (await padre.getByTestId('pickup-code').innerText()).trim();
    expect(codigo).toMatch(/^\d{6}$/);
    const referencia = (await padre.getByRole('heading', { level: 1 }).innerText()).trim();
    expect(referencia).toMatch(/^CART-/);
    await captura(padre, '05-pedido-transferencia-cuentas', true);

    await padre.getByTestId('receipt-input').setInputFiles({ name: 'comprobante.png', mimeType: 'image/png', buffer: COMPROBANTE_PNG });
    await expect(padre.getByTestId('order-status').first()).toHaveText('Esperando aprobación', { timeout: 20_000 });
    await expect(padre.getByTestId('awaiting-approval')).toBeVisible();
    await captura(padre, '06-esperando-aprobacion', true);

    // La escuela (admin) ve el pedido con cliente e ítems y aprueba.
    const adminCtx = await contextoComo(browser, 'admin.a');
    const admin = await adminCtx.newPage();
    await admin.goto('/orders');
    const fila = admin.locator(`[data-testid="seller-order-row"][data-ref="${referencia}"]`);
    await expect(fila).toBeVisible({ timeout: 30_000 });
    await expect(fila).toContainText('Padre QA Miembro');
    await expect(fila).toContainText('1 producto');
    await captura(admin, '07-escuela-lista-pedidos', true);
    await fila.getByRole('button', { name: `Ver pedido ${referencia}` }).click();
    const detalle = admin.getByTestId('seller-order-detail');
    await expect(detalle.getByTestId('detail-customer')).toHaveText('Padre QA Miembro');
    await expect(detalle.getByTestId('detail-items')).toContainText(TIENDA.camiseta);
    await expect(detalle.getByTestId('detail-items')).toContainText('M / Azul');
    await expect(detalle.getByRole('button', { name: 'Ver comprobante' })).toBeVisible();
    await captura(admin, '08-escuela-detalle-comprobante');
    await detalle.getByRole('button', { name: 'Aprobar pago' }).click();
    await expect(detalle.getByTestId('order-status')).toHaveText('Pagado', { timeout: 20_000 });

    // El padre ve "Pagado".
    await padre.reload();
    await expect(padre.getByTestId('order-status').first()).toHaveText('Pagado', { timeout: 20_000 });
    await expect(padre.getByTestId('buyer-status-message')).toContainText('Pago confirmado');
    await captura(padre, '09-padre-ve-pagado', true);

    // La escuela prepara, deja listo y entrega con el código de retiro (uno errado primero).
    await detalle.getByRole('button', { name: 'Preparar pedido' }).click();
    await expect(detalle.getByTestId('order-status')).toHaveText('En preparación', { timeout: 20_000 });
    await detalle.getByRole('button', { name: 'Listo para retirar' }).click();
    await expect(detalle.getByTestId('order-status')).toHaveText('Listo para retirar', { timeout: 20_000 });
    await detalle.getByRole('button', { name: 'Entregar con código' }).click();
    const malo = codigo === '000000' ? '111111' : '000000';
    await admin.locator('#pcode').fill(malo);
    await admin.getByRole('button', { name: 'Confirmar' }).click();
    await expect(admin.getByText('Código de retiro incorrecto').first()).toBeVisible({ timeout: 15_000 });
    await admin.locator('#pcode').fill(codigo);
    await admin.getByRole('button', { name: 'Confirmar' }).click();
    await expect(detalle.getByTestId('order-status')).toHaveText('Entregado', { timeout: 20_000 });
    await expect(detalle.getByTestId('order-history')).toContainText('Entregado');
    await captura(admin, '10-escuela-entregado-historial');

    await padre.reload();
    await expect(padre.getByTestId('order-status').first()).toHaveText('Entregado', { timeout: 20_000 });
    await captura(padre, '11-padre-entregado-linea-de-tiempo', true);

    await padreCtx.close();
    await adminCtx.close();
});

test('último ítem: el padre lo reserva en efectivo, otro padre lo ve agotado y el carrito no sobrevende; la escuela cobra con el código', async ({ browser }, info) => {
    soloDesktop(info.project.name);
    const padreCtx = await contextoComo(browser, 'padre.a');
    const padre = await padreCtx.newPage();
    await padre.goto(`/tienda/${TIENDA.slug}`);
    const gorra = card(padre, TIENDA.gorra);
    await expect(gorra).toBeVisible({ timeout: 30_000 });
    await expect(gorra.getByText('¡Última unidad!')).toBeVisible();
    await gorra.getByRole('button', { name: `Agregar ${TIENDA.gorra}` }).click();

    // B6: con stock 1 el + del carrito queda apagado.
    await padre.getByTestId('cart-bar').click();
    const linea = padre.getByTestId('cart-line').filter({ hasText: TIENDA.gorra });
    await expect(linea.getByRole('button', { name: `Agregar una unidad de ${TIENDA.gorra}` })).toBeDisabled({ timeout: 20_000 });
    await expect(linea.getByTestId('qty-value')).toHaveText('1');
    await captura(padre, '12-carrito-ultimo-item-sin-sobreventa');
    await padre.getByRole('button', { name: `Pagar en ${TIENDA.nombre}` }).click();

    await padre.getByRole('radio', { name: /Efectivo al retirar/ }).click();
    await expect(padre.getByTestId('checkout-total')).toHaveText(/45\.000/);
    await padre.locator('[data-testid="pay-button"]:visible').click();
    await expect(padre).toHaveURL(/\/mis-compras\/[0-9a-f-]{36}/, { timeout: 30_000 });
    const codigo = (await padre.getByTestId('pickup-code').innerText()).trim();
    const referencia = (await padre.getByRole('heading', { level: 1 }).innerText()).trim();
    await expect(padre.getByTestId('buyer-status-message')).toContainText('efectivo');
    await captura(padre, '13-efectivo-codigo-retiro', true);

    // Otro padre (ajeno a la escuela) ve la gorra reservada como agotada.
    const otroCtx = await contextoComo(browser, 'padre.b');
    const otro = await otroCtx.newPage();
    await otro.goto(`/tienda/${TIENDA.slug}`);
    await expect(card(otro, TIENDA.gorra).getByText('Agotado')).toBeVisible({ timeout: 30_000 });
    await expect(card(otro, TIENDA.gorra).getByRole('button', { name: `Agregar ${TIENDA.gorra}` })).toHaveCount(0);
    await captura(otro, '14-otro-padre-ve-agotado', true);

    // La escuela cobra en efectivo con el código: paid + delivered.
    const adminCtx = await contextoComo(browser, 'admin.a');
    const admin = await adminCtx.newPage();
    await admin.goto('/orders');
    const fila = admin.locator(`[data-testid="seller-order-row"][data-ref="${referencia}"]`);
    await expect(fila).toBeVisible({ timeout: 30_000 });
    await fila.getByRole('button', { name: 'Cobrar y entregar' }).click();
    await admin.locator('#pcode').fill(codigo);
    await captura(admin, '15-escuela-cobra-efectivo');
    await admin.getByRole('button', { name: 'Confirmar' }).click();
    await expect(fila.getByTestId('order-status')).toHaveText('Entregado', { timeout: 20_000 });

    await Promise.all([padreCtx.close(), otroCtx.close(), adminCtx.close()]);
});

test('school_only: un padre ajeno y un anónimo no ven la camiseta ni entrando por el enlace directo', async ({ browser }, info) => {
    soloDesktop(info.project.name);
    const ajenoCtx = await contextoComo(browser, 'padre.b');
    const ajeno = await ajenoCtx.newPage();
    await ajeno.goto(`/tienda/${TIENDA.slug}`);
    await expect(card(ajeno, TIENDA.termo)).toBeVisible({ timeout: 30_000 });
    await expect(card(ajeno, TIENDA.camiseta)).toHaveCount(0);
    await ajeno.goto(`/tienda/${TIENDA.slug}/p/00000000-0000-4000-d000-000000000001`);
    await expect(ajeno.getByRole('heading', { name: 'Producto no disponible' })).toBeVisible({ timeout: 30_000 });
    await captura(ajeno, '16-school-only-ajeno-no-lo-ve');

    const anonCtx = await browser.newContext({ baseURL: BASE_URL });
    const anon = await anonCtx.newPage();
    await anon.goto(`/tienda/${TIENDA.slug}`);
    await expect(card(anon, TIENDA.termo)).toBeVisible({ timeout: 30_000 });
    await expect(card(anon, TIENDA.camiseta)).toHaveCount(0);

    // Invitado: el carrito persiste al recargar; pagar pide sesión.
    await card(anon, TIENDA.termo).getByRole('button', { name: `Agregar ${TIENDA.termo}` }).click();
    await anon.reload();
    await expect(anon.getByTestId('cart-bar')).toContainText('1', { timeout: 20_000 });
    await Promise.all([ajenoCtx.close(), anonCtx.close()]);
});

test('tienda apagada: vitrina y checkout muestran un mensaje claro', async ({ browser }, info) => {
    soloDesktop(info.project.name);
    const ctx = await contextoComo(browser, 'padre.a');
    const page = await ctx.newPage();
    try {
        tiendaEncendida(false);
        await page.goto(`/tienda/${TIENDA.slug}`);
        await expect(page.getByRole('heading', { name: 'Tienda no disponible' })).toBeVisible({ timeout: 30_000 });
        await page.goto(`/checkout/tienda/${TIENDA.vendorProfileId}`);
        await expect(page.getByRole('heading', { name: 'Tienda no disponible' })).toBeVisible({ timeout: 30_000 });
        await captura(page, '17-tienda-apagada');
    } finally {
        tiendaEncendida(true);
        await ctx.close();
    }
});

test('móvil (Pixel 7): ficha → carrito → checkout de una pantalla → pedido, sin scroll horizontal', async ({ browser }, info) => {
    test.skip(info.project.name !== 'pixel-7', 'escenario móvil');
    const ctx = await contextoComo(browser, 'padre.a', { ...info.project.use });
    const page = await ctx.newPage();

    const sinScrollHorizontal = async () => {
        const w = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(w).toBeLessThanOrEqual(0);
    };

    await page.goto(`/tienda/${TIENDA.slug}`);
    await expect(card(page, TIENDA.camiseta)).toBeVisible({ timeout: 30_000 });
    await sinScrollHorizontal();
    await captura(page, 'm01-vitrina-movil', true);

    await card(page, TIENDA.camiseta).getByRole('link', { name: `Ver ${TIENDA.camiseta}` }).click();
    await page.getByRole('button', { name: 'Talla S', exact: true }).click();
    await sinScrollHorizontal();
    await captura(page, 'm02-ficha-movil');
    await page.getByRole('button', { name: 'Comprar ahora' }).click();

    await expect(page).toHaveURL(new RegExp(`/checkout/tienda/${TIENDA.vendorProfileId}`));
    const pay = page.locator('[data-testid="pay-button"]:visible');
    await expect(pay).toBeEnabled({ timeout: 20_000 });
    await expect(pay).toBeInViewport();
    await sinScrollHorizontal();
    await captura(page, 'm03-checkout-movil');
    await captura(page, 'm03b-checkout-movil-completo', true);
    await pay.click();

    await expect(page).toHaveURL(/\/mis-compras\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByTestId('transfer-box').or(page.getByTestId('pickup-code-box')).first()).toBeVisible();
    await sinScrollHorizontal();
    await captura(page, 'm04-pedido-movil', true);

    await page.goto('/mis-compras');
    await expect(page.getByTestId('my-order-row').first()).toBeVisible({ timeout: 20_000 });
    await sinScrollHorizontal();
    await captura(page, 'm05-mis-compras-movil', true);
    await ctx.close();
});
