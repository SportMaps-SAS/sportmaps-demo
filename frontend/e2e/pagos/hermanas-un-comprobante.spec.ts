// frontend/e2e/pagos/hermanas-un-comprobante.spec.ts
//
// F3 de docs/specs/pago-hermanas-un-comprobante.md: el modal de «Registrar pago» con dos
// hermanas y un solo comprobante, contra el GEMELO local (nunca la viva).
//   npx playwright test -c playwright.gemelo.config.ts e2e/pagos
// Siembra y limpia sus propios datos con docker exec (contenedor del gemelo).

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { loginAs, setActiveSchool } from '../helpers/auth';

const DB = 'supabase_db_sportmaps-qa-twin';
const ESCUELA = '00000000-0000-4000-b000-000000000001';
const H1 = '00000000-0000-4000-c000-0000000000f1';
const H2 = '00000000-0000-4000-c000-0000000000f2';
const ADMIN = { email: 'owner.a@qa.sportmaps.test', password: 'QaGemelo2026!' };

function sql(q: string): string {
    return execFileSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-At', '-c', q], { encoding: 'utf8' }).trim();
}

function sembrar() {
    // La familia se arma con inscripciones activas (_sibling_family): sin ellas no hay hermanas.
    sql(`insert into enrollments(school_id, child_id, status, start_date, team_id)
         select '${ESCUELA}', c, 'active', current_date, '1076d0e9-6fae-4dd4-803d-d9c8cabf6394' from unnest(array['${H1}','${H2}']::uuid[]) c
          where not exists (select 1 from enrollments e where e.child_id = c and e.school_id = '${ESCUELA}' and e.status = 'active')`);
    sql(`delete from payment_adjustments where payment_id in (select id from payments where child_id in ('${H1}','${H2}'));
         delete from payments where child_id in ('${H1}','${H2}');`);
    sql(`insert into payments(id,amount,concept,due_date,status,school_id,child_id,payment_type) values
      ('f3000000-0000-4000-8000-000000000001',100000,'Mensualidad Uno F3',current_date,'pending','${ESCUELA}','${H1}','subscription'),
      ('f3000000-0000-4000-8000-000000000002',100000,'Mensualidad Dos F3',current_date,'pending','${ESCUELA}','${H2}','subscription'),
      ('f3000000-0000-4000-8000-000000000011',100000,'Siguiente Uno F3',current_date+31,'pending','${ESCUELA}','${H1}','subscription'),
      ('f3000000-0000-4000-8000-000000000012',100000,'Siguiente Dos F3',current_date+31,'pending','${ESCUELA}','${H2}','subscription');`);
}

async function abrirModal(page: Page) {
    await setActiveSchool(page, ESCUELA);
    // El Auth del gemelo da 504 si la máquina anda cargada: se reintenta el login.
    for (let intento = 1; ; intento++) {
        try { await loginAs(page, ADMIN); break; } catch (e) {
            if (intento >= 5) throw e;
            await page.waitForTimeout(5_000);
        }
    }
    await page.goto('/payments-automation', { waitUntil: 'domcontentloaded', timeout: 150_000 });
    await page.getByTestId('open-register-payment').click({ timeout: 90_000 });
}

test.use({ viewport: { width: 1400, height: 1300 } });

const P1 = 'f3000000-0000-4000-8000-000000000001';
const P2 = 'f3000000-0000-4000-8000-000000000002';

/** Abre el modal, elige a Hermana Uno y entra al modo «varios cobros» con las dos hermanas marcadas. */
async function marcarLasDos(page: Page) {
    await abrirModal(page);
    await page.getByText('Selecciona a quién aplica').click();
    await page.getByRole('button', { name: /^Hermana Uno F3/ }).click();
    await page.getByRole('button', { name: /Pagar varios cobros a la vez/ }).click();
    await expect(page.getByTestId('cyp-hermanas')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel(/Mensualidad Uno F3/).click();
    await page.getByTestId('cyp-hermana-cobro-' + P2).click();
    await page.getByLabel('¿Quién lo recibió?').fill('Alejandra F3');
}

const campoRecibido = (page: Page) => page.getByTestId('cyp-monto-recibido').getByRole('textbox');

test.describe('Hermanas con un comprobante (gemelo)', () => {
    test.setTimeout(240_000);
    test.beforeEach(() => sembrar());

    test('efectivo, recibido +$5.500: dos ajustes de $2.750 y las dos pagadas', async ({ page }) => {
        await marcarLasDos(page);
        await page.screenshot({ path: 'test-results/f3-01-marcadas.png', fullPage: true });
        await campoRecibido(page).fill('205500');
        await expect(page.getByTestId('cyp-aviso-reparto')).toContainText(/Sobran/);
        await expect(page.getByTestId('cyp-aviso-reparto')).toContainText('2.750');
        await page.screenshot({ path: 'test-results/f3-02-aviso.png', fullPage: true });
        await page.getByRole('button', { name: /Confirmar Registro/ }).click();
        await expect.poll(() => sql(`select count(*) from payments where id in ('${P1}','${P2}') and status='paid'`), { timeout: 30_000 }).toBe('2');
        expect(sql(`select string_agg(amount::int::text, ',' order by amount) from payment_adjustments where kind='saldo_a_favor' and payment_id in ('${P1}','${P2}')`)).toBe('2750,2750');
        expect(sql(`select count(distinct grupo_registro) from payment_adjustments where kind='saldo_a_favor' and payment_id in ('${P1}','${P2}')`)).toBe('1');
        await page.screenshot({ path: 'test-results/f3-03-guardado.png', fullPage: true });
    });

    test('excedente impar $5.501: el residuo va a la hermana con la que se abrió', async ({ page }) => {
        await marcarLasDos(page);
        await campoRecibido(page).fill('205501');
        await expect(page.getByTestId('cyp-aviso-reparto')).toContainText('2.751');
        await page.getByRole('button', { name: /Confirmar Registro/ }).click();
        await expect.poll(() => sql(`select count(*) from payments where id in ('${P1}','${P2}') and status='paid'`), { timeout: 30_000 }).toBe('2');
        expect(sql(`select a.amount::int from payment_adjustments a join payments p on p.id=a.payment_id where a.kind='saldo_a_favor' and p.child_id='${H1}'`)).toBe('2751');
        expect(sql(`select a.amount::int from payment_adjustments a join payments p on p.id=a.payment_id where a.kind='saldo_a_favor' and p.child_id='${H2}'`)).toBe('2750');
    });

    test('suma exacta: sin saldo a favor', async ({ page }) => {
        await marcarLasDos(page);
        await page.getByRole('button', { name: /Confirmar Registro/ }).click();
        await expect.poll(() => sql(`select count(*) from payments where id in ('${P1}','${P2}') and status='paid'`), { timeout: 30_000 }).toBe('2');
        expect(sql(`select count(*) from payment_adjustments where kind='saldo_a_favor' and payment_id in ('${P1}','${P2}')`)).toBe('0');
    });

    test('recibido menor que la suma: no deja guardar y no toca la base', async ({ page }) => {
        await marcarLasDos(page);
        await campoRecibido(page).fill('150000');
        await expect(page.getByTestId('cyp-recibido-menor')).toContainText('Registra cada cobro con su abono');
        await expect(page.getByRole('button', { name: /Confirmar Registro/ })).toBeDisabled();
        await page.screenshot({ path: 'test-results/f3-04-menor.png', fullPage: true });
        expect(sql(`select count(*) from payments where id in ('${P1}','${P2}') and status='paid'`)).toBe('0');
    });

    test('el siguiente cobro de cada hermana se descuenta con su parte del saldo', async ({ page }) => {
        await marcarLasDos(page);
        await campoRecibido(page).fill('205500');
        await page.getByRole('button', { name: /Confirmar Registro/ }).click();
        await expect.poll(() => sql(`select count(*) from payment_adjustments where kind='saldo_a_favor' and payment_id in ('${P1}','${P2}')`), { timeout: 30_000 }).toBe('2');
        // Cada hermana consume SU parte en su siguiente cobro (kind 'descuento' sobre ese cobro).
        const descuento = (pago: string) =>
            sql(`select coalesce(sum(amount),0)::int from payment_adjustments where payment_id='${pago}' and kind='descuento' and origin='saldo_a_favor'`);
        expect(descuento('f3000000-0000-4000-8000-000000000011')).toBe('2750');
        expect(descuento('f3000000-0000-4000-8000-000000000012')).toBe('2750');
        // Y no queda saldo suelto: lo consumieron los siguientes cobros.
        expect(sql(`select public._saldo_a_favor_disponible('${ESCUELA}'::uuid, 'c:${H1}')::int`)).toBe('0');
    });
});

// ── Transferencia con comprobante ────────────────────────────────────────────
// El gemelo no levanta el BFF: el OCR y la lista de menores se simulan en el navegador. Lo que se
// prueba es el camino del cliente + la base (huella, referencia, monto recibido, reparto).
const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);
const REF = 'F3-REF-0001';
const SHA = 'f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3';

async function simularBff(page: Page, ocrAmount: number) {
    await page.route('**/api/v1/payments/extract-receipt', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                amount: ocrAmount, date: new Date().toISOString().slice(0, 10), reference: REF,
                bank: 'Bancolombia', currency: 'COP', provider: 'simulado-f3',
                time: '10:00', destination: null, destinationName: null, originName: 'Mamá F3',
                verdict: 'verde', verdictReasons: [], referenceNorm: REF.toLowerCase(),
                imageSha256: SHA, imageSha256Source: 'client_original',
                rawResponse: '{}',
            }),
        }),
    );
    await page.route('**/api/v1/students/children-by-ids', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([
                { id: H1, full_name: 'Hermana Uno F3' },
                { id: H2, full_name: 'Hermana Dos F3' },
            ]),
        }),
    );
}

async function marcarLasDosPorTransferencia(page: Page, ocrAmount: number) {
    await simularBff(page, ocrAmount);
    await abrirModal(page);
    await page.getByRole('button', { name: /^Transferencia/ }).click();
    await page.getByText('Selecciona a quién aplica').click();
    await page.getByRole('button', { name: /^Hermana Uno F3/ }).click();
    await page.getByRole('button', { name: /Pagar varios cobros a la vez/ }).click();
    await expect(page.getByTestId('cyp-hermanas')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel(/Mensualidad Uno F3/).click();
    await page.getByTestId('cyp-hermana-cobro-' + P2).click();
    await page.locator('input[type=file]').first().setInputFiles({ name: 'comprobante-f3.png', mimeType: 'image/png', buffer: PNG_1X1 });
    // Sin esperar la subida y el OCR, «Confirmar» se pulsa sin soporte y no hace nada.
    await expect(page.getByText('Soporte adjunto')).toBeVisible({ timeout: 90_000 });
}

test.describe('Transferencia con comprobante (gemelo)', () => {
    test.setTimeout(240_000);
    test.beforeEach(() => {
        sembrar();
        sql(`delete from payments where receipt_image_sha256 = '${SHA}' or ocr_reference = '${REF}'`);
    });

    test('un comprobante para las dos: mismo soporte, huella solo en el primero y el sobrante repartido', async ({ page }) => {
        await marcarLasDosPorTransferencia(page, 205500);
        // El monto recibido se precarga con lo que leyó el OCR y avisa que no coincide con la suma.
        await expect(campoRecibido(page)).toHaveValue(/205\.?500/, { timeout: 30_000 });
        await expect(page.getByTestId('cyp-recibido-ocr')).toContainText('205.500');
        await expect(page.getByTestId('cyp-aviso-reparto')).toContainText('2.750');
        await page.screenshot({ path: 'test-results/f3-05-transferencia.png', fullPage: true });
        await page.getByRole('button', { name: /Confirmar Registro/ }).click();
        await expect.poll(() => sql(`select count(*) from payments where id in ('${P1}','${P2}') and status='paid'`), { timeout: 30_000 }).toBe('2');
        expect(sql(`select count(distinct receipt_url) from payments where id in ('${P1}','${P2}') and receipt_url is not null`)).toBe('1');
        expect(sql(`select count(*) from payments where id in ('${P1}','${P2}') and receipt_url is not null`)).toBe('2');
        // La huella y la referencia viajan en UNA sola fila (los índices únicos no dejan en dos).
        expect(sql(`select count(*) from payments where id in ('${P1}','${P2}') and receipt_image_sha256 = '${SHA}'`)).toBe('1');
        expect(sql(`select count(*) from payments where id in ('${P1}','${P2}') and ocr_reference = '${REF}'`)).toBe('1');
        expect(sql(`select string_agg(amount::int::text, ',' order by amount) from payment_adjustments where kind='saldo_a_favor' and payment_id in ('${P1}','${P2}')`)).toBe('2750,2750');
        expect(sql(`select string_agg(distinct payment_method, ',') from payments where id in ('${P1}','${P2}')`)).toBe('transfer');
    });

    test('el mismo comprobante otra vez se rechaza con mensaje claro y no paga nada', async ({ page }) => {
        // Otro cobro de la escuela ya tiene esa huella y esa referencia.
        sql(`insert into payments(id,amount,concept,due_date,status,school_id,child_id,payment_type,receipt_image_sha256,ocr_reference)
             values ('f3000000-0000-4000-8000-0000000000d1',50000,'Ya pagado con este soporte','2025-01-15','paid','${ESCUELA}','00000000-0000-4000-c000-000000000001','subscription','${SHA}','${REF}')`);
        try {
            await marcarLasDosPorTransferencia(page, 200000);
            await page.getByRole('button', { name: /Confirmar Registro/ }).click();
            await expect(page.getByText('Comprobante ya registrado').first()).toBeVisible({ timeout: 30_000 });
            expect(sql(`select count(*) from payments where id in ('${P1}','${P2}') and status='paid'`)).toBe('0');
            expect(sql(`select count(*) from payment_adjustments where payment_id in ('${P1}','${P2}')`)).toBe('0');
            await page.screenshot({ path: 'test-results/f3-06-duplicado.png', fullPage: true });
        } finally {
            sql(`delete from payments where id = 'f3000000-0000-4000-8000-0000000000d1'`);
        }
    });
});
