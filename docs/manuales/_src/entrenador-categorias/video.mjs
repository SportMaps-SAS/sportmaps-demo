// Video narrado: «Asignar deportistas a tus categorías» (acompaña a
// guia-entrenadores-asignar-categoria.pdf). Gemelo local, Club Campestre Demo:
//   entrenador (Andrés Vélez) inscribe a Juan Pablo Henao en Fútbol Sub-12 y ve que
//   no puede sacarlo → escuela (Carolina Méndez) prende «Coaches pueden remover
//   deportistas de sus equipos» → entrenador lo remueve.
// Cada corrida deja el interruptor apagado y a Juan Pablo sin categoría (comun.mjs).
//
//   BASE_URL=http://localhost:3102 node docs/manuales/_src/entrenador-categorias/video.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grabar } from '../_video/lib.mjs';
import { reiniciar } from './comun.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
reiniciar();

const dlg = (page) => page.getByRole('dialog').last();
/** Fila de un deportista dentro de la ventana «Inscribir Deportistas». */
const fila = (page, nombre) => dlg(page).locator('div.rounded-lg, [class*="card"]').filter({ hasText: nombre }).last();
const filaPermiso = (page) => page.locator('div.flex.items-center.justify-between').filter({ hasText: 'Coaches pueden remover deportistas de sus equipos' }).last();

async function abrirVentana(ui) {
  await ui.clic(ui.page.locator('[title="Gestionar Deportistas"]').first());
  await dlg(ui.page).getByText('Juan Pablo Henao').first().waitFor({ timeout: 20000 });
  await ui.sleep(800);
}
async function buscar(ui, texto) {
  const caja = dlg(ui.page).getByPlaceholder(/Buscar/i);
  await ui.clic(caja);
  await ui.page.keyboard.type(texto, { delay: 90 });
  await ui.sleep(600);
}

await grabar({
  nombre: 'asignar-categoria',
  usuario: 'coach.campestre',
  inicio: '/teams',
  esperar: 'Fútbol Sub-12',
  trabajo: path.join(here, 'video-raw'),
  pasos: [
    {
      dice: 'Como entrenador, en Mis Equipos ves solo las categorías que tienes a cargo, con cuántos deportistas lleva cada una.',
      hace: (ui) => ui.mover(ui.page.getByText('Fútbol Sub-12').first()),
    },
    {
      dice: 'Para sumar deportistas, toca el botón Gestionar Deportistas de la categoría.',
      hace: (ui) => abrirVentana(ui),
    },
    {
      dice: 'Arriba están los inscritos, luego los pendientes de pago, y abajo los deportistas que puedes inscribir.',
      hace: async (ui) => {
        await ui.mover(dlg(ui.page).getByText('Inscrito', { exact: true }).first());
        await ui.rueda(500);
        await ui.sleep(800);
        await ui.rueda(-500);
      },
    },
    {
      dice: 'Con el buscador encuentras a cualquiera por su nombre o su apellido.',
      hace: (ui) => buscar(ui, 'Juan Pablo'),
    },
    {
      dice: 'Toca Inscribir. Queda registrado de una vez: no hay que guardar nada al final.',
      hace: async (ui) => {
        await ui.clic(fila(ui.page, 'Juan Pablo Henao').getByRole('button', { name: /Inscribir/ }));
        await dlg(ui.page).getByText('Inscrito', { exact: true }).first().waitFor({ timeout: 15000 });
      },
    },
    {
      dice: 'Fíjate que a la derecha dice Inscrito, sin botón. De entrada, sacar a un deportista lo hace la administración, porque cancelar su inscripción anula sus cobros pendientes.',
      hace: (ui) => ui.mover(fila(ui.page, 'Juan Pablo Henao').getByText('Inscrito', { exact: true }).last()),
    },
    {
      dice: 'Pero la escuela te puede dar ese permiso. Así lo prende un administrador.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByRole('button', { name: 'Cerrar' }).last());
        await ui.entrarComo('admin.campestre', '/payments-automation?tab=config', 'Coaches pueden remover deportistas de sus equipos');
      },
    },
    {
      dice: 'En Pagos, pestaña Config, la tarjeta Permisos tiene el interruptor: Coaches pueden remover deportistas de sus equipos.',
      hace: async (ui) => {
        await ui.mover(filaPermiso(ui.page).getByText('Coaches pueden remover deportistas de sus equipos'));
        await ui.sleep(1200);
      },
    },
    {
      dice: 'Lo prende, y guarda con Guardar Cambios. Vale para todos los entrenadores de la escuela.',
      hace: async (ui) => {
        await ui.clic(filaPermiso(ui.page).getByRole('switch'));
        await ui.sleep(700);
        await ui.clic(ui.page.getByRole('button', { name: 'Guardar Cambios' }));
        await ui.sleep(1500);
      },
    },
    {
      dice: 'De vuelta como entrenador, la misma ventana ahora trae el botón Remover en cada inscrito.',
      hace: async (ui) => {
        await ui.entrarComo('coach.campestre', '/teams', 'Fútbol Sub-12');
        await ui.sleep(600);
        await abrirVentana(ui);
        await buscar(ui, 'Juan Pablo');
        await ui.mover(fila(ui.page, 'Juan Pablo Henao').getByRole('button', { name: /Remover/ }));
      },
    },
    {
      dice: 'Al tocarlo, la inscripción se cancela al instante, sin pedir confirmación, y el deportista vuelve a los disponibles. Por eso, revisa bien el nombre antes.',
      hace: async (ui) => {
        await ui.clic(fila(ui.page, 'Juan Pablo Henao').getByRole('button', { name: /Remover/ }));
        await ui.page.getByText('Deportista removido').first().waitFor({ timeout: 15000 });
      },
    },
    {
      dice: 'El permiso cubre solo las categorías que entrenas. Las inscripciones a planes de pago siguen siendo de la administración.',
      pausa: 1200,
      hace: (ui) => ui.mover(fila(ui.page, 'Juan Pablo Henao').getByRole('button', { name: /Inscribir/ })),
    },
  ],
});

reiniciar();
