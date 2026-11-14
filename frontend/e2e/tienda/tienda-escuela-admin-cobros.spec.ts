// Tienda escolar — lado ESCUELA: un school_admin que NO es dueño (admin.a)
// entra a «Tu tienda → Cobros y entrega», elige qué cuentas mostrar (la de
// «Solo para inscripciones» no es elegible), deja «solo retiro», guarda, y
// comparte la tienda (enlace + QR descargable). Bug N0: antes caía en bucle a
// /vendor/onboarding.
//
// Corre SOLO contra el gemelo local (docs/qa-gemelo-local.md), con la
// migración 20261008163336 aplicada encima:
//
//   npm run qa:twin:up                                    (raíz)
//   cd frontend && npx playwright test -c playwright.gemelo.config.ts tienda/tienda-escuela-admin-cobros --workers=1
//
// No necesita BFF: la pantalla llama a las RPC con el JWT (store_admin_settings,
// set_store_payment_settings, my_school_store). Escribe en el gemelo; al final
// restaura la tienda con gemelo-tienda.sql. Capturas: docs/capturas/tienda-v2-checkout/.
import { test, expect } from '@playwright/test';
import { TIENDA, captura, contextoComo, prepararTiendaGemelo, sqlGemelo } from './gemelo';

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const ACCOUNTS = JSON.stringify([
    { id: 'e2e-nequi', type: 'nequi', label: 'Nequi del club', value: '3001112233', active: true },
    { id: 'e2e-breb', type: 'breb', label: 'Bre-B del club', value: '@clubqa', active: true },
    { id: 'e2e-insc', type: 'nequi', label: 'Nequi personal (inscripciones)', value: '3009998877', active: true, only_for: ['inscripcion'] },
]);

function prepararEscuela(): string {
    prepararTiendaGemelo();
    // Cuentas con uso, la tienda con los medios por defecto y el slug de la escuela.
    return sqlGemelo(`
        update public.school_settings set payment_accounts = '${ACCOUNTS}'::jsonb, bank_account_number = null
         where school_id = '${TIENDA.escuelaA}';
        update public.store_payment_settings
           set accept_transfer = true, accept_cash_pickup = true, accept_wompi = false, accept_mercadopago = false,
               transfer_account_ids = null, allow_shipping = true, pickup_branch_ids = null
         where vendor_profile_id = '${TIENDA.vendorProfileId}';
        select public._store_sync_school_slug('${TIENDA.vendorProfileId}');
    `).trim().split('\n').pop() ?? '';
}

test.afterAll(() => {
    // Deja la tienda como la esperan los demás specs (slug tienda-qa-andes, cuenta ficticia).
    prepararTiendaGemelo();
});

test('admin no dueño configura cobros y entrega, y comparte la tienda', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop-chrome', 'escenario de escritorio');
    const slug = prepararEscuela();
    expect(slug).toBe('qa-academia-andes');

    const ctx = await contextoComo(browser, 'admin.a', { acceptDownloads: true });
    const page = await ctx.newPage();

    // N0: /vendor/products ya no lo manda al alta de vendedor externo.
    await page.goto('/vendor/products');
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/\/vendor\/onboarding/);

    await page.goto('/tienda-escuela/ajustes');
    await expect(page.getByRole('heading', { name: 'Ajustes de cobros y entrega' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('store-status')).toBeVisible();
    // Ningún término de vendedor / marketplace para la escuela.
    await expect(page.locator('body')).not.toContainText(/vendedor|marketplace/i);

    // Cuentas: las dos generales elegibles; la de inscripciones excluida con su motivo.
    const cuentas = page.getByTestId('store-accounts');
    await expect(cuentas.getByText('Nequi del club')).toBeVisible();
    await expect(cuentas.getByText('Bre-B del club')).toBeVisible();
    const excluida = page.getByTestId('store-account-excluded');
    await expect(excluida).toHaveCount(1);
    await expect(excluida).toContainText('Nequi personal (inscripciones)');
    await expect(excluida).toContainText('Solo para otro uso');
    await expect(page.locator('body')).not.toContainText('3009998877');

    // Elegir solo el Nequi; solo retiro en sede.
    await page.getByLabel('Elegir cuáles mostrar').check();
    await page.getByRole('checkbox', { name: 'Mostrar Bre-B del club' }).uncheck();
    await page.getByLabel(/Solo retiro en sede/).check();
    await captura(page, '20-escuela-ajustes-cobros', true);
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText('Cobros guardados').first()).toBeVisible({ timeout: 15_000 });

    const guardado = sqlGemelo(`
        select accept_transfer, accept_cash_pickup, allow_shipping, array_to_string(transfer_account_ids, ','),
               updated_by = (select user_id from qa_twin.actores where alias = 'admin.a')
          from public.store_payment_settings where vendor_profile_id = '${TIENDA.vendorProfileId}';`).trim();
    expect(guardado).toBe('t|t|f|e2e-nequi|t');

    // Lo que ve el comprador: solo la cuenta elegida.
    const visibles = sqlGemelo(`select string_agg(x->>'id', ',') from jsonb_array_elements(public._store_transfer_accounts('${TIENDA.vendorProfileId}')) x;`).trim();
    expect(visibles).toBe('e2e-nequi');

    // Compartir: enlace con el slug de la escuela + QR descargable.
    await page.getByRole('button', { name: 'Compartir tienda' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox')).toHaveValue(new RegExp(`/tienda/${slug}$`));
    await captura(page, '21-escuela-compartir-tienda');
    const [descarga] = await Promise.all([
        page.waitForEvent('download'),
        dialog.getByRole('button', { name: 'Descargar QR' }).click(),
    ]);
    expect(descarga.suggestedFilename()).toMatch(/^tienda-.*-qr\.png$/);

    await ctx.close();
});

// eslint-disable-next-line no-empty-pattern -- Playwright exige desestructurar el 1.er argumento
test('coach no ve los ajustes de la tienda', async ({}, info) => {
    test.skip(info.project.name !== 'desktop-chrome', 'escenario de escritorio');
    prepararEscuela();
    // coach.a no está en los alias de contextoComo: se prueba la lectura que usa la pantalla.
    const r = sqlGemelo(`
        begin;
        select set_config('request.jwt.claims', json_build_object('sub', (select user_id from qa_twin.actores where alias = 'coach.a'), 'role', 'authenticated')::text, true);
        set local role authenticated;
        select coalesce(public.my_school_store('${TIENDA.escuelaA}')::text, 'null');
        rollback;`).trim().split('\n').filter(l => l && !/^(BEGIN|SET|ROLLBACK)$/.test(l)).pop();
    expect(r).toBe('null');
});

test('móvil: la pantalla de cobros cabe en 360 px sin scroll horizontal', async ({ browser }, info) => {
    test.skip(info.project.name !== 'pixel-7', 'escenario móvil');
    prepararEscuela();
    const ctx = await contextoComo(browser, 'admin.a', { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto('/tienda-escuela/ajustes');
    await expect(page.getByRole('heading', { name: 'Ajustes de cobros y entrega' })).toBeVisible({ timeout: 30_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await captura(page, '22-escuela-ajustes-movil', true);
    await ctx.close();
});
