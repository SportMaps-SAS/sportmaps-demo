// Video narrado: "Dotación e inventario" (acompaña a guia-uso-dotacion.pdf).
// Gemelo local, Club Campestre Demo. Un solo video con tres tramos:
//   escuela (Carolina Méndez) crea el ítem y lo asigna →
//   entrenador (Andrés Vélez) lo acepta y lo devuelve →
//   escuela aprueba la devolución.
// Cada corrida borra la dotación de la escuela en el gemelo y empieza de cero.
//
//   node docs/manuales/_src/dotacion/video.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grabar, sql } from '../_video/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ESCUELA = '25a123f0-6d57-48a4-9800-7b1531d61cd2';

sql(`delete from equipment_assignment_logs where assignment_id in (select id from equipment_assignments where school_id='${ESCUELA}');
     delete from equipment_returns where school_id='${ESCUELA}';
     delete from equipment_assignments where school_id='${ESCUELA}';
     delete from equipment_items where school_id='${ESCUELA}';`);

const dlg = (page) => page.locator('[role="dialog"]').last();
const escribir = async (ui, loc, texto) => {
  await ui.clic(loc);
  await loc.first().fill('');
  await ui.page.keyboard.type(texto, { delay: 70 });
};

await grabar({
  nombre: 'dotacion',
  usuario: 'admin.campestre',
  inicio: '/school/dotacion',
  esperar: 'Dotación e inventario',
  trabajo: path.join(here, 'video-raw'),
  pasos: [
    {
      dice: 'Con Dotación llevas el control de los balones, petos, conos, y todo lo que la escuela le presta a sus entrenadores.',
      hace: (ui) => ui.mover(ui.page.getByText('Dotación e inventario')),
    },
    {
      dice: 'Empieza registrando el ítem, con Nuevo ítem.',
      hace: (ui) => ui.clic(ui.page.getByRole('button', { name: 'Nuevo ítem' })),
    },
    {
      dice: 'Ponle un nombre y la cantidad total que tiene la escuela. Por ejemplo, diez balones número cinco.',
      hace: async (ui) => {
        await escribir(ui, dlg(ui.page).getByLabel('Nombre'), 'Balón fútbol #5');
        await escribir(ui, dlg(ui.page).getByLabel('Cantidad total'), '10');
        await ui.mover(dlg(ui.page).getByText('Condición'));
      },
    },
    {
      dice: 'Crea el ítem, y aparece en la tabla con su disponibilidad.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByRole('button', { name: 'Crear ítem' }));
        await ui.page.getByRole('button', { name: 'Asignar' }).first().waitFor({ timeout: 15000 });
        await ui.mover(ui.page.getByText('Balón fútbol #5').first());
      },
    },
    {
      dice: 'Para prestarlo, toca Asignar en su fila.',
      hace: (ui) => ui.clic(ui.page.getByRole('button', { name: 'Asignar' })),
    },
    {
      dice: 'Elige al entrenador, la cantidad y la fecha límite de devolución.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByText('Selecciona un entrenador'));
        await ui.clic(ui.page.getByRole('option', { name: 'Andrés Vélez' }));
        await escribir(ui, dlg(ui.page).getByLabel('Cantidad'), '2');
        await ui.mover(dlg(ui.page).getByLabel('Fecha límite de devolución'));
        await dlg(ui.page).getByLabel('Fecha límite de devolución').fill('2026-11-30');
      },
    },
    {
      dice: 'Al confirmar, queda registrado el préstamo con su acta de responsabilidad.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByRole('button', { name: 'Asignar' }));
        await ui.sleep(1500);
        await ui.mover(ui.page.getByText('Balón fútbol #5').first());
      },
    },
    {
      dice: 'Ahora, del lado del entrenador. En Mi Dotación le aparece lo que le asignaste, en Por aceptar.',
      hace: async (ui) => {
        await ui.entrarComo('coach.campestre', '/coach/dotacion', 'Por aceptar');
        await ui.mover(ui.page.getByText(/Por aceptar \(/));
      },
    },
    {
      dice: 'Si recibió lo mismo que dice la asignación, toca Acepto. Si la cantidad no coincide, toca Diferencia, y la escuela lo revisa.',
      hace: async (ui) => {
        await ui.mover(ui.page.getByRole('button', { name: 'Diferencia' }));
        await ui.sleep(1800);
        await ui.clic(ui.page.getByRole('button', { name: 'Acepto' }));
      },
    },
    {
      dice: 'El préstamo queda activo, con su fecha límite. Para devolverlo, toca Devolver.',
      hace: async (ui) => {
        const devolver = ui.page.getByRole('button', { name: 'Devolver' });
        await devolver.waitFor({ timeout: 15000 });
        await ui.mover(ui.page.getByText(/Activas \(/));
        await ui.sleep(1200);
        await ui.clic(devolver);
      },
    },
    {
      dice: 'Indica cuántos devuelve y en qué estado: bueno, dañado o perdido.',
      hace: async (ui) => {
        await ui.mover(dlg(ui.page).getByLabel('Cantidad a devolver'));
        await ui.sleep(900);
        await ui.mover(dlg(ui.page).getByText('Buen estado'));
      },
    },
    {
      dice: 'Y registra la devolución. Queda pendiente, hasta que la escuela la apruebe.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByRole('button', { name: 'Registrar devolución' }));
        await ui.sleep(1200);
      },
    },
    {
      dice: 'De vuelta en la escuela, todo lo que espera revisión está en Aprobaciones.',
      hace: async (ui) => {
        await ui.entrarComo('admin.campestre', '/school/dotacion', 'Dotación e inventario');
        await ui.clic(ui.page.getByRole('button', { name: 'Aprobaciones' }));
      },
    },
    {
      dice: 'Revisa la condición final y aprueba. Al aprobar, los balones vuelven a estar disponibles en el inventario.',
      hace: async (ui) => {
        await ui.mover(dlg(ui.page).getByText('Condición final'));
        await ui.sleep(1500);
        await ui.clic(dlg(ui.page).getByRole('button', { name: 'Aprobar' }));
      },
    },
    {
      dice: 'Así, cada préstamo queda registrado, con responsable y fecha, y nada se pierde de vista.',
      hace: async (ui) => {
        await ui.sleep(900);
        const cola = dlg(ui.page);
        const x = cola.locator('button:has(svg.lucide-x), button:has-text("Close")');
        if (await x.count()) await ui.clic(x, { forzar: true }); else await ui.page.keyboard.press('Escape');
        await cola.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
        await ui.mover(ui.page.getByText(/10 \/ 10/).first()).catch(() => ui.mover(ui.page.getByText('Balón fútbol #5').first()));
      },
    },
  ],
});
