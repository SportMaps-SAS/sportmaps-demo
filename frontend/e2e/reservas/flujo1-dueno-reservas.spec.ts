// Flujo 1: dueño de escuela en /facilities → pestaña Reservas (gemelo local, datos t2-).
import { expect, test, type Page } from '@playwright/test';
import { ACTORES, SCHOOL_ID, captura, contextoComo, diaIso, facilityId, prepararReservas, rows, sql, vigilar } from './gemelo-reservas';

test.describe.configure({ mode: 'serial' });

let ids: Awaited<ReturnType<typeof prepararReservas>>;
const ruido = (s: string) => /ERR_NETWORK_CHANGED|ERR_ABORTED/.test(s);
const NO_IGNORADO = (a: string[]) => a.filter((s) => !ruido(s));

async function irAReservas(page: Page) {
    await page.goto('/facilities');
    await page.getByRole('tab', { name: /Reservas/ }).click();
    await expect(page.getByRole('heading', { name: 'Gestión de Reservas' })).toBeVisible({ timeout: 30_000 });
}

async function kpis(page: Page) {
    const out: Record<string, number> = {};
    for (const [k, label] of [['total', 'Total Historial'], ['confirmed', 'Confirmadas'], ['pending', 'Pendientes'], ['cancelled', 'Canceladas'], ['completed', 'Completadas']] as const) {
        const card = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
        out[k] = Number((await card.locator('p').first().innerText()).trim());
    }
    return out;
}

async function elegirDia(page: Page, iso: string) {
    const d = new Date(`${iso}T12:00:00`);
    const hoy = new Date();
    if (d.getMonth() !== hoy.getMonth()) await page.getByRole('button', { name: /next month|siguiente|mes siguiente/i }).first().click();
    const celda = page.getByRole('gridcell', { name: String(d.getDate()), exact: true }).first();
    // react-day-picker alterna: si el dia ya esta elegido (tras «Atras»), un clic lo deselecciona.
    if ((await celda.getAttribute('aria-selected')) !== 'true') await celda.click();
}

async function elegirInstalacion(page: Page, nombre: string) {
    await page.getByRole('dialog').getByRole('combobox').first().click();
    await page.getByRole('option', { name: new RegExp(nombre) }).click();
}

interface Opts { cancha: string; dia: number; who: 'user' | 'guest' | 'internal'; guest?: { nombre: string; tel: string }; usuario?: string; tarifa?: 'Socio' | 'Público'; slot?: number; cobrar?: boolean; finalizar?: boolean }

/** Recorre el modal «Nueva Reserva» hasta el resumen (o hasta Finalizar); devuelve el texto de la franja elegida. */
async function nuevaReserva(page: Page, o: Opts) {
    await page.getByRole('button', { name: 'Nueva Reserva' }).first().click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText('Tipo de reserva')).toBeVisible();
    await elegirInstalacion(page, o.cancha);
    await dlg.getByRole('button', { name: { user: /Usuario de SportMaps/, guest: /Invitado/, internal: /Uso interno/ }[o.who] }).click();
    if (o.who === 'user') {
        await dlg.getByPlaceholder(/Busca por nombre/).fill(o.usuario ?? 't2 Padre');
        await dlg.getByRole('button', { name: new RegExp(o.usuario ?? 't2 Padre') }).first().click();
    }
    if (o.who === 'guest') {
        await dlg.getByPlaceholder('Nombre completo *').fill(o.guest!.nombre);
        await dlg.getByPlaceholder('Teléfono *').fill(o.guest!.tel);
    }
    if (o.tarifa && o.who !== 'internal') {
        await dlg.getByLabel('Tarifa').click();
        await page.getByRole('option', { name: new RegExp(o.tarifa) }).click();
    }
    await dlg.getByRole('button', { name: 'Continuar' }).click();
    await elegirDia(page, diaIso(o.dia));
    await expect(dlg.getByTestId('slot-grid')).toBeVisible({ timeout: 20_000 });
    const slot = dlg.getByTestId('slot-grid').getByRole('button').nth(o.slot ?? 0);
    const texto = (await slot.innerText()).replace(/\n/g, ' · ');
    await slot.click();
    await dlg.getByRole('button', { name: 'Confirmar Horario' }).click();
    if (o.cobrar) await dlg.getByRole('button', { name: 'Cobrar total' }).click();
    if (o.finalizar !== false) await dlg.getByRole('button', { name: 'Finalizar Registro' }).click();
    return texto;
}

const fila = (page: Page, texto: string | RegExp) => page.getByRole('row').filter({ hasText: texto });

test.beforeAll(async () => {
    ids = await prepararReservas();
    sql(`delete from public.facility_reservations where school_id='${SCHOOL_ID}'`);
    // Reserva 'pending' del flujo VIEJO (la pedía el padre desde la ficha): insert directo.
    sql(`insert into public.facility_reservations (facility_id, user_id, reservation_date, start_time, end_time, status, school_id, notes, participants, price, booker_type, resv_type)
         values ('${facilityId('t2 Cancha Publica')}', '${ids.padre}', '${diaIso(9)}', '08:00', '09:00', 'pending', '${SCHOOL_ID}', 't2 practica libre vieja', 4, 0, 'parent', 'rental')`);
});

test('1.1 KPIs cuadran con la base; sin errores de consola ni requests fallidos', async ({ browser }) => {
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    const v = vigilar(page);
    await irAReservas(page);
    await expect(fila(page, 't2 Cancha Publica').first()).toBeVisible();
    const ui = await kpis(page);
    const [[total, conf, pend, canc, comp]] = rows(`select count(*), count(*) filter (where status='confirmed'), count(*) filter (where status='pending'), count(*) filter (where status='cancelled'), count(*) filter (where status='completed') from public.facility_reservations where school_id='${SCHOOL_ID}'`);
    expect(ui).toEqual({ total: +total, confirmed: +conf, pending: +pend, cancelled: +canc, completed: +comp });
    await captura(page, 'f1-kpis-desktop');
    expect(NO_IGNORADO(v.consola)).toEqual([]);
    expect(v.fallidos).toEqual([]);
});

test('1.2 Grilla con precio real; tarifa Público/Socio; invitado + efectivo cobrado', async ({ browser }) => {
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    const v = vigilar(page);
    await irAReservas(page);
    await page.getByRole('button', { name: 'Nueva Reserva' }).first().click();
    const dlg = page.getByRole('dialog');
    await elegirInstalacion(page, 't2 Cancha Mixta');
    await dlg.getByRole('button', { name: /Invitado/ }).click();
    await dlg.getByPlaceholder('Nombre completo *').fill('t2 Invitado Efectivo');
    await dlg.getByPlaceholder('Teléfono *').fill('3105550101');
    await captura(page, 'f1-modal-paso1');
    await dlg.getByRole('button', { name: 'Continuar' }).click();
    await elegirDia(page, diaIso(3));
    const grid = dlg.getByTestId('slot-grid');
    await expect(grid).toBeVisible({ timeout: 20_000 });
    await expect(grid.getByRole('button').first()).toContainText(/\$\s?90\.000/);
    await captura(page, 'f1-grilla-publico');
    // volver y cambiar a tarifa Socio: la grilla debe repricear a 60.000
    await dlg.getByRole('button', { name: 'Atrás' }).click();
    await dlg.getByLabel('Tarifa').click();
    await page.getByRole('option', { name: /Socio/ }).click();
    await dlg.getByRole('button', { name: 'Continuar' }).click();
    await elegirDia(page, diaIso(3));
    await expect(grid.getByRole('button').first()).toContainText(/\$\s?60\.000/, { timeout: 20_000 });
    await captura(page, 'f1-grilla-socio');
    // volver a Público y reservar el primer cupo cobrando todo en efectivo
    await dlg.getByRole('button', { name: 'Atrás' }).click();
    await dlg.getByLabel('Tarifa').click();
    await page.getByRole('option', { name: /Público/ }).click();
    await dlg.getByRole('button', { name: 'Continuar' }).click();
    await elegirDia(page, diaIso(3));
    await expect(grid.getByRole('button').first()).toContainText(/\$\s?90\.000/, { timeout: 20_000 });
    await grid.getByRole('button').first().click();
    await dlg.getByRole('button', { name: 'Confirmar Horario' }).click();
    await expect(dlg.getByText(/Total \(tarifa Público\)/)).toBeVisible();
    await dlg.getByRole('button', { name: 'Cobrar total' }).click();
    await expect(dlg.locator('#amount_paid')).toHaveValue('90000');
    await captura(page, 'f1-resumen-efectivo');
    await dlg.getByRole('button', { name: 'Finalizar Registro' }).click();
    await expect(page.getByText('✅ Reserva creada').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Total: \$\s?90\.000/).first()).toBeVisible();
    const [r] = rows(`select r.status, r.price, r.amount_paid, r.payment_status, g.full_name, g.phone from public.facility_reservations r join public.guest_bookers g on g.id=r.guest_booker_id where r.school_id='${SCHOOL_ID}' and g.full_name='t2 Invitado Efectivo'`);
    expect([r[0], Number(r[1]), Number(r[2]), r[3], r[4], r[5]]).toEqual(['confirmed', 90000, 90000, 'paid', 't2 Invitado Efectivo', '3105550101']);
    await expect(fila(page, 't2 Cancha Mixta').first()).toBeVisible();
    expect(NO_IGNORADO(v.consola)).toEqual([]);
    expect(v.fallidos).toEqual([]);
});

test('1.3 Uso interno (sin costo) y a nombre de un usuario con tarifa Socio', async ({ browser }) => {
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    const v = vigilar(page);
    await irAReservas(page);
    await nuevaReserva(page, { cancha: 't2 Cancha Socios', dia: 4, who: 'internal' });
    await expect(page.getByText('✅ Reserva creada').first()).toBeVisible({ timeout: 20_000 });
    const [i] = rows(`select status, price, payment_status, user_id is null, guest_booker_id is null from public.facility_reservations where school_id='${SCHOOL_ID}' and reservation_date='${diaIso(4)}'`);
    expect(i[0]).toBe('confirmed'); expect(Number(i[1])).toBe(0);
    await page.waitForTimeout(500);
    await nuevaReserva(page, { cancha: 't2 Cancha Socios', dia: 5, who: 'user', usuario: 't2 Padre', tarifa: 'Socio', slot: 1 });
    await expect(page.getByText('✅ Reserva creada').last()).toBeVisible({ timeout: 20_000 });
    const [u] = rows(`select status, price, user_id='${ids.padre}', price_snapshot->>'audience' from public.facility_reservations where school_id='${SCHOOL_ID}' and reservation_date='${diaIso(5)}'`);
    expect([u[0], Number(u[1]), u[2]]).toEqual(['confirmed', 50000, 't']);
    expect(NO_IGNORADO(v.consola)).toEqual([]);
    expect(v.fallidos).toEqual([]);
});

test('1.4 Misma franja dos veces: 409 SLOT_TAKEN con alternativas y se aplican', async ({ browser }) => {
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    const v = vigilar(page);
    await irAReservas(page);
    // Elegimos la franja y, antes de Finalizar, otra persona la toma (carrera real).
    await nuevaReserva(page, { cancha: 't2 Cancha Publica', dia: 6, who: 'guest', guest: { nombre: 't2 Invitado Carrera', tel: '3105550102' }, slot: 2, finalizar: false });
    sql(`insert into public.facility_reservations (facility_id, user_id, school_id, reservation_date, start_time, end_time, starts_at, ends_at, status, price, booker_type, resv_type, notes)
         values ('${facilityId('t2 Cancha Publica')}','${ids.owner}','${SCHOOL_ID}','${diaIso(6)}','08:00','09:00','${diaIso(6)} 08:00-05','${diaIso(6)} 09:00-05','confirmed',0,'school','internal','t2 carrera')`);
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('button', { name: 'Finalizar Registro' }).click();
    await expect(dlg.getByRole('alert')).toBeVisible({ timeout: 20_000 });
    await expect(dlg.getByTestId('slot-alternatives')).toBeVisible();
    await captura(page, 'f1-slot-taken');
    const mensaje = await dlg.getByRole('alert').innerText();
    console.log('MENSAJE 409:', mensaje.replace(/\n/g, ' | '));
    expect(mensaje).toMatch(/ocupad|tomad|ya no está|disponible/i);
    const alt = dlg.getByTestId('slot-alternatives').getByRole('button').first();
    await alt.click();
    await dlg.getByRole('button', { name: 'Finalizar Registro' }).click();
    await expect(page.getByText('✅ Reserva creada').first()).toBeVisible({ timeout: 20_000 });
    const [[n]] = [rows(`select count(*) from public.facility_reservations where school_id='${SCHOOL_ID}' and reservation_date='${diaIso(6)}' and status in ('confirmed','pending')`)[0]];
    expect(Number(n)).toBe(2);
});

test('1.5 Reprogramar (misma duración) y cancelar con motivo (toast con devolución)', async ({ browser }) => {
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    const v = vigilar(page);
    await irAReservas(page);
    const objetivo = fila(page, 't2 Invitado Efectivo').or(fila(page, 't2 Cancha Mixta')).first();
    await expect(objetivo).toBeVisible();
    const antes = rows(`select starts_at, ends_at, id from public.facility_reservations where school_id='${SCHOOL_ID}' and guest_booker_id is not null and reservation_date='${diaIso(3)}'`)[0];
    await objetivo.getByRole('button').last().click();
    await page.getByRole('menuitem', { name: 'Reprogramar' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText('Reprogramar Reserva')).toBeVisible();
    await elegirDia(page, diaIso(7));
    await expect(dlg.getByTestId('slot-grid')).toBeVisible({ timeout: 20_000 });
    await dlg.getByTestId('slot-grid').getByRole('button').nth(3).click();
    await dlg.getByRole('button', { name: 'Confirmar Horario' }).click();
    await captura(page, 'f1-reprogramar-resumen');
    await dlg.getByRole('button', { name: 'Reprogramar' }).last().click();
    await expect(page.getByText(/Reserva reprogramada/).first()).toBeVisible({ timeout: 20_000 });
    const despues = rows(`select starts_at, ends_at, reservation_date from public.facility_reservations where id='${antes[2]}'`)[0];
    expect(despues[2]).toBe(diaIso(7));
    const dur = (a: string, b: string) => (Date.parse(b.replace(' ', 'T') + ':00') - Date.parse(a.replace(' ', 'T') + ':00'));
    expect(dur(despues[0], despues[1])).toBe(dur(antes[0], antes[1]));

    // Cancelar con motivo
    await page.reload();
    await page.getByRole('tab', { name: /Reservas/ }).click();
    const f2 = fila(page, 't2 Cancha Mixta').first();
    await f2.getByRole('button').last().click();
    await page.getByRole('menuitem', { name: 'Cancelar' }).click();
    await page.getByPlaceholder('Motivo de la cancelación (opcional)').fill('t2 motivo: lluvia fuerte');
    await captura(page, 'f1-cancelar-dialogo');
    await page.getByRole('button', { name: 'Sí, cancelar reserva' }).click();
    await expect(page.getByText('✅ Reserva cancelada').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Devolución:/).first()).toBeVisible();
    console.log('TOAST cancelar:', await page.locator('[role="status"], li[data-state="open"]').first().innerText().catch(() => '?'));
    const [c] = rows(`select status, cancellation_reason, refund_status from public.facility_reservations where id='${antes[2]}'`);
    expect(c[0]).toBe('cancelled'); expect(c[1]).toContain('lluvia');
    await captura(page, 'f1-cancelada');
    expect(NO_IGNORADO(v.consola)).toEqual([]);
    expect(v.fallidos).toEqual([]);
});

test('1.6 Aprobar una pendiente del flujo viejo y completarla', async ({ browser }) => {
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    const v = vigilar(page);
    await irAReservas(page);
    const f = fila(page, 't2 Cancha Publica').filter({ hasText: 'Pendiente' }).first();
    await expect(f).toBeVisible();
    await f.getByRole('button').last().click();
    await page.getByRole('menuitem', { name: 'Aprobar' }).click();
    await expect(page.getByText('✅ Reserva aprobada').first()).toBeVisible({ timeout: 20_000 });
    const [a] = rows(`select status, approved_by is not null from public.facility_reservations where notes='t2 practica libre vieja'`);
    expect(a).toEqual(['confirmed', 't']);
    // Completar
    await page.waitForTimeout(800);
    const f2 = fila(page, 't2 Cancha Publica').filter({ hasText: 'Confirmada' }).first();
    await f2.getByRole('button').last().click();
    await expect(page.getByRole('menuitem', { name: /Completar|completada/i })).toBeVisible();
    await page.getByRole('menuitem', { name: /Completar|completada/i }).click();
    await expect(page.getByText('✅ Reserva completada').first()).toBeVisible({ timeout: 20_000 });
    expect(NO_IGNORADO(v.consola)).toEqual([]);
});

test('1.7 Paginación «Ver más» (200 por página)', async ({ browser }) => {
    sql(`insert into public.facility_reservations (facility_id, user_id, school_id, reservation_date, start_time, end_time, starts_at, ends_at, status, price, booker_type, resv_type, notes)
         select '${facilityId('t2 Cancha Entrenamiento')}','${ids.owner}','${SCHOOL_ID}', (current_date - 400 - g)::date, '10:00','11:00', ((current_date - 400 - g)::text||' 10:00-05')::timestamptz, ((current_date - 400 - g)::text||' 11:00-05')::timestamptz, 'completed',0,'school','internal','t2 relleno'
           from generate_series(1,210) g`);
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    await irAReservas(page);
    await expect(page.getByRole('button', { name: 'Ver más' })).toBeVisible({ timeout: 20_000 });
    const antes = (await kpis(page)).total;
    expect(antes).toBe(200);
    await captura(page, 'f1-ver-mas');
    await page.getByRole('button', { name: 'Ver más' }).click();
    await expect.poll(async () => (await kpis(page)).total, { timeout: 20_000 }).toBeGreaterThan(200);
    sql(`delete from public.facility_reservations where notes='t2 relleno'`);
});

test('1.8 Clases de cortesía: la pestaña carga', async ({ browser }) => {
    const ctx = await contextoComo(browser, ACTORES.owner);
    const page = await ctx.newPage();
    const v = vigilar(page);
    await page.goto('/facilities');
    await page.getByRole('tab', { name: /Clases de Prueba/ }).click();
    await expect(page.getByRole('button', { name: /Nueva|Agendar|Ajustes|Configurar/i }).first()).toBeVisible({ timeout: 20_000 });
    await captura(page, 'f1-clases-cortesia');
    expect(NO_IGNORADO(v.consola)).toEqual([]);
});
