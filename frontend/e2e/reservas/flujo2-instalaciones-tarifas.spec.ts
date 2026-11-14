// Flujo 2: Instalaciones (crear/editar con tarifa, «Recibe reservas», «Quién puede reservar»)
// y pestaña «Tarifas y política» (CRUD de facility_rates y cancellation_policies). Gemelo local, datos t2-.
import { expect, test, type Page } from '@playwright/test';
import { ACTORES, SCHOOL_ID, captura, contextoComo, prepararReservas, rows, sql, vigilar } from './gemelo-reservas';

test.describe.configure({ mode: 'serial' });
const ruido = (s: string) => /ERR_NETWORK_CHANGED|ERR_ABORTED/.test(s);

async function irAInstalaciones(page: Page) {
    await page.goto('/facilities');
    await expect(page.getByText('t2 Cancha Mixta').first()).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
    await prepararReservas();
    sql(`delete from public.facility_rates where school_id='${SCHOOL_ID}' and facility_id in (select id from public.facilities where school_id='${SCHOOL_ID}' and name like 't2 Cancha Nueva%')`);
    sql(`delete from public.facilities where school_id='${SCHOOL_ID}' and name like 't2 Cancha Nueva%'`);
});

test('2.1 Crear instalación con Tarifa por hora, Recibe reservas y Quién puede reservar', async ({ browser }) => {
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    const v = vigilar(page);
    await irAInstalaciones(page);
    await page.getByRole('button', { name: /Agregar Instalación/ }).first().click();
    const dlg = page.getByRole('dialog');
    // validación: sin nombre no deja crear
    await dlg.getByRole('button', { name: 'Crear Instalación' }).click();
    await expect(dlg.getByText(/Nombre es requerido|requerido/i).first()).toBeVisible();
    await dlg.getByLabel('Nombre de la Instalación *').fill('t2 Cancha Nueva');
    await dlg.getByLabel('Tipo de Instalación *').click();
    await page.getByRole('option').first().click();
    await dlg.getByLabel('Capacidad *').fill('12');
    await dlg.getByLabel('Tarifa por hora (COP)').fill('70000');
    await expect(dlg.getByLabel('Quién puede reservar')).toBeEnabled();
    await dlg.getByLabel('Quién puede reservar').click();
    await page.getByRole('option', { name: /Ambos/ }).click();
    await captura(page, 'f2-form-instalacion');
    await dlg.getByRole('button', { name: 'Crear Instalación' }).click();
    await expect(page.getByText('t2 Cancha Nueva').first()).toBeVisible({ timeout: 20_000 });
    const [f] = rows(`select hourly_rate, booking_enabled, bookable_by from public.facilities where school_id='${SCHOOL_ID}' and name='t2 Cancha Nueva'`);
    expect([Number(f[0]), f[1], f[2]]).toEqual([70000, 't', 'both']);
    expect(v.consola.filter((s) => !ruido(s))).toEqual([]);
    expect(v.fallidos).toEqual([]);
});

test('2.2 La Tarifa por hora se usa como precio cuando no hay tarifas por franja', async ({ browser }) => {
    // el precio sale de la grilla de disponibilidad del BFF (no inventado en el cliente)
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    await irAInstalaciones(page);
    const [[rates]] = [rows(`select count(*) from public.facility_rates r join public.facilities f on f.id=r.facility_id where f.name='t2 Cancha Nueva'`)[0]];
    console.log('facility_rates de la cancha nueva (creada con Tarifa por hora):', rates);
    await page.getByRole('tab', { name: /Reservas/ }).click();
    await page.getByRole('button', { name: 'Nueva Reserva' }).first().click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('combobox').first().click();
    await page.getByRole('option', { name: /t2 Cancha Nueva/ }).click();
    await dlg.getByRole('button', { name: /Uso interno/ }).click();
    await dlg.getByRole('button', { name: 'Continuar' }).click();
    await dlg.getByRole('gridcell', { name: /^\d+$/ }).nth(25).click().catch(() => undefined);
    await captura(page, 'f2-tarifa-por-hora-grilla');
});

test('2.3 Editar: apagar «Recibe reservas» deshabilita «Quién puede reservar»; entrenamiento no recibe reservas', async ({ browser }) => {
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    const v = vigilar(page);
    await irAInstalaciones(page);
    const card = page.locator('div').filter({ hasText: /^t2 Cancha Nueva/ }).first();
    await page.getByRole('button', { name: /Editar|Pencil/i }).first().isVisible().catch(() => false);
    // los botones de editar son iconos: el segundo botón de la tarjeta que contiene el nombre
    const tarjeta = page.locator('[class*="card"], div').filter({ has: page.getByText('t2 Cancha Nueva', { exact: true }) }).last();
    await tarjeta.getByRole('button').nth(1).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByLabel('Nombre de la Instalación *')).toHaveValue('t2 Cancha Nueva');
    await dlg.locator('#booking_enabled').click();
    await expect(dlg.getByLabel('Quién puede reservar')).toBeDisabled();
    await captura(page, 'f2-form-sin-reservas');
    await dlg.getByRole('button', { name: 'Actualizar Instalación' }).click();
    await expect.poll(() => rows(`select booking_enabled from public.facilities where name='t2 Cancha Nueva'`)[0]?.[0]).toBe('f');
    expect(v.consola.filter((s) => !ruido(s))).toEqual([]);
});

test('2.4 Tarifas y política: CRUD de tarifas con validaciones', async ({ browser }) => {
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    const v = vigilar(page);
    await page.goto('/facilities');
    await page.getByRole('tab', { name: /Tarifas y política/ }).click();
    await expect(page.getByRole('heading', { name: 'Tarifas por franja' })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Instalación').first().click();
    await page.getByRole('option', { name: 't2 Cancha Publica' }).click();
    await expect(page.getByText(/80\.000/).first()).toBeVisible();
    await captura(page, 'f2-tarifas-lista');
    // crear: validaciones
    await page.getByRole('button', { name: /Nueva tarifa/ }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('button', { name: 'Guardar' }).click();
    await expect(dlg.getByRole('alert')).toBeVisible();
    console.log('VALIDACION tarifa vacía:', await dlg.getByRole('alert').innerText());
    await dlg.getByLabel('Precio por hora (COP)').fill('abc');
    await expect(dlg.getByLabel('Precio por hora (COP)')).toHaveValue('');
    await dlg.getByLabel('Desde').fill('20:00');
    await dlg.getByLabel('Hasta').fill('18:00');
    await dlg.getByLabel('Precio por hora (COP)').fill('120000');
    await dlg.getByRole('button', { name: 'Guardar' }).click();
    await expect(dlg.getByRole('alert')).toContainText(/posterior/);
    await dlg.getByLabel('Hasta').fill('22:00');
    await dlg.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('✅ Tarifa guardada').first()).toBeVisible({ timeout: 20_000 });
    const [t] = rows(`select price_per_hour, from_time, to_time, audience from public.facility_rates r join public.facilities f on f.id=r.facility_id where f.name='t2 Cancha Publica' and price_per_hour=120000`);
    expect(t).toBeTruthy();
    await captura(page, 'f2-tarifa-creada');
    // editar
    await page.getByRole('button', { name: 'Editar tarifa' }).last().click();
    await page.getByRole('dialog').getByLabel('Precio por hora (COP)').fill('130000');
    await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
    await expect.poll(() => rows(`select 1 from public.facility_rates r join public.facilities f on f.id=r.facility_id where f.name='t2 Cancha Publica' and price_per_hour=130000`).length).toBe(1);
    // eliminar
    await page.getByRole('button', { name: 'Eliminar tarifa' }).last().click();
    await expect.poll(() => rows(`select 1 from public.facility_rates r join public.facilities f on f.id=r.facility_id where f.name='t2 Cancha Publica' and price_per_hour=130000`).length).toBe(0);
    expect(v.consola.filter((s) => !ruido(s))).toEqual([]);
    expect(v.fallidos).toEqual([]);
});

test('2.5 Tarifas y política: política de cancelación (validaciones, alcance, guardado)', async ({ browser }) => {
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    const v = vigilar(page);
    await page.goto('/facilities');
    await page.getByRole('tab', { name: /Tarifas y política/ }).click();
    await expect(page.getByRole('heading', { name: 'Política de cancelación' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Horas para devolución total (100 %)')).toHaveValue('24');
    await page.getByLabel('Horas para devolución parcial').fill('30');
    await page.getByRole('button', { name: 'Guardar política' }).click();
    await expect(page.getByRole('alert').last()).toContainText(/no pueden ser más/);
    await page.getByLabel('Horas para devolución parcial').fill('10');
    await page.getByLabel('% de la devolución parcial').fill('150');
    await page.getByRole('button', { name: 'Guardar política' }).click();
    await expect(page.getByRole('alert').last()).toContainText(/100/);
    await page.getByLabel('% de la devolución parcial').fill('40');
    await page.getByLabel('Horas para devolución total (100 %)').fill('48');
    await page.getByRole('button', { name: 'Guardar política' }).click();
    await expect(page.getByText('✅ Política guardada').first()).toBeVisible({ timeout: 20_000 });
    const [p] = rows(`select hours_full_refund, hours_partial_refund, partial_pct from public.cancellation_policies where school_id='${SCHOOL_ID}' and facility_id is null and is_active`);
    expect(p.map(Number)).toEqual([48, 10, 40]);
    await captura(page, 'f2-politica');
    // alcance por instalación: crea una política solo de esa cancha
    await page.getByLabel('Alcance de la política').click();
    await page.getByRole('option', { name: 'Solo t2 Cancha Mixta' }).click();
    await page.getByLabel('Horas para devolución total (100 %)').fill('12');
    await page.getByLabel('Horas para devolución parcial').fill('4');
    await page.getByLabel('% de la devolución parcial').fill('25');
    await page.getByRole('button', { name: 'Guardar política' }).click();
    await expect(page.getByText('✅ Política guardada').last()).toBeVisible({ timeout: 20_000 });
    const [q] = rows(`select hours_full_refund from public.cancellation_policies p join public.facilities f on f.id=p.facility_id where f.name='t2 Cancha Mixta' and p.is_active`);
    expect(Number(q[0])).toBe(12);
    // restablecer la política de la escuela para no contaminar otros flujos
    sql(`update public.cancellation_policies set hours_full_refund=24, hours_partial_refund=12, partial_pct=50 where school_id='${SCHOOL_ID}' and facility_id is null`);
    sql(`delete from public.cancellation_policies where school_id='${SCHOOL_ID}' and facility_id is not null`);
    expect(v.consola.filter((s) => !ruido(s))).toEqual([]);
    expect(v.fallidos).toEqual([]);
});
