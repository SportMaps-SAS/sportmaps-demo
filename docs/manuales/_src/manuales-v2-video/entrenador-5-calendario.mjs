// Video 5/6 del manual del entrenador: calendario y eventos (capítulo 8). No guarda el evento.
import { video, ENTRENADOR, texto, dialogo } from './comun.mjs';

await video({
  nombre: 'entrenador-5-calendario',
  usuario: ENTRENADOR,
  inicio: '/calendar',
  esperar: 'Nuevo Evento',
  pasos: [
    {
      dice: 'En Más, Calendario, ves los eventos de tus equipos y de la escuela.',
      hace: (ui) => ui.mover(texto(ui.page, /noviembre 2026/i)),
    },
    {
      dice: 'Toca Nuevo Evento. Escribe el título, y elige para quién es: un equipo, toda la escuela, o solo para ti.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('button', { name: /Nuevo Evento/ }));
        await ui.sleep(1200);
        await ui.clic(dialogo(ui.page).getByRole('textbox').first());
        await ui.page.keyboard.type('Partido contra Real Sabana', { delay: 50 });
        await ui.sleep(500);
        await ui.mover(dialogo(ui.page).getByText(/Para quién/).first());
      },
    },
    {
      dice: 'Luego el tipo, la fecha y las horas, la ubicación, y una descripción.',
      hace: async (ui) => {
        await ui.mover(dialogo(ui.page).getByText(/Tipo/).first());
        await ui.sleep(1000);
        await ui.rueda(250);
      },
    },
    {
      dice: 'Si el tipo es Partido Oficial y es para un equipo, la app pide el rival y si juegan en casa o de visita, y crea el partido completo: aparece en Equipos, Partidos, donde convocas, registras el resultado y evalúas.',
      hace: async (ui) => { await ui.sleep(1500); await ui.page.keyboard.press('Escape'); await ui.sleep(600); },
    },
    {
      dice: 'Al crearlo, queda en el calendario y en Resultados. Toca el día en la cuadrícula: en el detalle aparece Abrir partido, que te lleva a su pantalla.',
      hace: async (ui) => {
        await ui.mover(ui.page.getByText('14', { exact: true }).first());
        await ui.sleep(900);
        await ui.clic(ui.page.getByText('14', { exact: true }).first());
        await ui.sleep(1400);
      },
    },
    {
      dice: 'Si el partido se aplaza, cambia la fecha en el paso Programar del partido: el evento del calendario se mueve solo.',
      pausa: 900,
      hace: async (ui) => { await ui.sleep(800); },
    },
  ],
});
