// Video narrado 2/2 de la pizarra táctica: «Animar, ver en 3D y compartir» (acompaña a
// pizarra-tactica.pdf v2). Capítulos 7, 9 y 10–13 del manual: cuadros, notas y videos,
// 3D, análisis con IA (solo el panel: analizar gasta cupo), exportar y biblioteca.
// La preparación (abrir el tablero del bloque «Juego final» con 4-3-3 contra 4-4-2)
// queda fuera del video: arranca con la jugada ya armada, como termina el 1/2.
//
// No muestra «Usar en esta sesión» desde la biblioteca: hoy los puestos del ejercicio
// no se dibujan en el 2D (hallazgo 2026-10-22, ver README).
//
//   BASE_URL=http://localhost:3102 node docs/manuales/_src/pizarra-tactica/video-animar.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grabar } from '../_video/lib.mjs';
import { reiniciar, abrirTablero, tablero, barra, cancha, en, ficha, arrastrar } from './video-comun.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
reiniciar();

const t = (ui) => tablero(ui.page);
const dlg = (ui) => ui.page.getByRole('dialog').last();
/** Mueve la ficha de un jugador a (px, py) % de la cancha. */
async function mover(ui, iniciales, px, py) {
  const r = await cancha(ui.page);
  await arrastrar(ui.page, await ficha(ui.page, iniciales), en(r, px, py), 30);
}
const nuevoCuadro = (ui) => ui.clic(t(ui).getByRole('button', { name: /^Cuadro$/ }));

await grabar({
  nombre: 'pizarra-tactica-animar-y-compartir',
  usuario: 'coach.campestre',
  inicio: '/training-plans',
  esperar: 'Métricas y Rendimiento',
  webgl: true,
  trabajo: path.join(here, 'animar', 'video-raw'),
  preparar: async (ui) => {
    await abrirTablero(ui, 2);
    await ui.page.getByRole('button', { name: /Tablero táctico/ }).nth(2).click();
    await barra(ui.page, 'Guardar jugada').waitFor({ timeout: 30000 });
    await ui.sleep(1500);
    await barra(ui.page, 'Formación').click();
    await ui.page.getByRole('button', { name: /^4-3-3/ }).first().click(); await ui.sleep(800);
    await barra(ui.page, '4-3-3').click();
    await ui.page.getByRole('tab', { name: 'Rival' }).click();
    await ui.page.getByRole('button', { name: /^4-4-2/ }).first().click(); await ui.sleep(5500); // que se vaya el aviso
  },
  pasos: [
    {
      dice: 'Partimos de una jugada armada. Para animarla, se usa la línea de tiempo de abajo.',
      hace: (ui) => ui.mover(t(ui).getByRole('button', { name: /^Cuadro$/ })),
    },
    {
      dice: 'Más Cuadro copia el cuadro actual. Ahí mueves a los jugadores para marcar el siguiente momento: el lateral pasa al ataque, el medio y el extremo se adelantan.',
      hace: async (ui) => {
        await nuevoCuadro(ui);
        await mover(ui, 'ET', 12, 46);
        await mover(ui, 'MG', 30, 30);
        await mover(ui, 'SC', 34, 14);
      },
    },
    {
      dice: 'Agrega los cuadros que necesites, hasta treinta. Tocando la miniatura de un cuadro vuelves a él para editarlo.',
      hace: async (ui) => {
        await nuevoCuadro(ui);
        await mover(ui, 'ET', 12, 26);
        await mover(ui, 'SM', 44, 8);
      },
    },
    {
      dice: 'Cada cuadro tiene su tiempo. Al reproducir, todo se mueve con suavidad de un cuadro al siguiente.',
      hace: async (ui) => {
        await ui.mover(t(ui).locator('select').last());
        await ui.clic(t(ui).getByRole('button', { name: 'Reproducir cuadros' }));
        await ui.sleep(4500);
      },
    },
    {
      dice: 'En Notas escribes la consigna, y le pones etiquetas para encontrarla después.',
      hace: async (ui) => {
        await ui.clic(barra(ui.page, 'Notas'));
        await ui.clic(ui.page.getByLabel('Nota de la jugada'));
        await ui.page.keyboard.type('Salida por la banda izquierda: el lateral se proyecta y el medio da apoyo por dentro.', { delay: 18 });
        await ui.clic(ui.page.getByRole('button', { name: 'salida de balón' }));
        await ui.clic(ui.page.getByRole('button', { name: 'ataque organizado' }));
        await ui.clic(dlg(ui).getByRole('button', { name: 'Listo' }));
      },
    },
    {
      dice: 'En Videos pegas un enlace de YouTube, Vimeo, o de cámaras como Veo y Hudl. También puedes subir el video del celular.',
      hace: async (ui) => {
        await ui.clic(barra(ui.page, 'Videos'));
        await ui.clic(ui.page.getByLabel('Enlace del video'));
        await ui.page.getByLabel('Enlace del video').fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
        await ui.clic(ui.page.getByLabel('Título del video'));
        await ui.page.keyboard.type('Salida contra presión alta', { delay: 35 });
        await ui.sleep(1500);
        await ui.mover(dlg(ui).getByRole('tab', { name: 'Subir' }));
        await ui.clic(dlg(ui).getByRole('button', { name: /Agregar a la jugada/ }));
        await ui.clic(dlg(ui).getByRole('button', { name: 'Listo' }));
      },
    },
    {
      dice: 'Ver en 3D muestra la misma jugada con jugadores en volumen. Se edita en 2D; el 3D es para mirarla y mostrarla.',
      hace: async (ui) => {
        await ui.clic(barra(ui.page, 'Ver en 3D'));
        await ui.page.getByRole('button', { name: /Volver a 2D/ }).waitFor({ timeout: 60000 });
        await ui.sleep(1500);
        await ui.clic(ui.page.getByRole('button', { name: 'Reproducir', exact: true }), { pasos: 4 });
      },
    },
    {
      // El 3D se dibuja por software al grabar: cada movimiento del cursor espera un
      // cuadro, así que acá el cursor va en pocos pasos y con una sola cámara intermedia.
      dice: 'Cambias de cámara: transmisión de TV, cenital, spider-cam, dron, o la automática, que elige sola la mejor toma.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('button', { name: 'Cenital', exact: true }), { pasos: 4 });
        await ui.sleep(2500);
        await ui.clic(ui.page.getByRole('button', { name: 'Cámara automática', exact: true }), { pasos: 4 });
      },
    },
    {
      dice: 'Volver a 2D te devuelve al tablero, con la jugada intacta.',
      hace: (ui) => ui.clic(ui.page.getByRole('button', { name: /Volver a 2D/ }), { pasos: 4 }),
    },
    {
      dice: 'Analizar jugada le pide a la IA una lectura: riesgos, contraataques del rival y variantes. Son sugerencias, y no se envían nombres ni fotos. Cada entrenador tiene un cupo al mes.',
      hace: async (ui) => {
        await ui.clic(barra(ui.page, 'Analizar jugada'));
        await ui.sleep(1200);
        await ui.mover(ui.page.getByText(/Te queda/).first());
        await ui.sleep(3500);
        await ui.clic(barra(ui.page, 'Analizar jugada'));
      },
    },
    {
      dice: 'Exportar la saca como imagen, ficha en PDF, video, o directo a WhatsApp. De entrada no muestra nombres: son menores de edad.',
      hace: async (ui) => {
        await ui.clic(barra(ui.page, 'Exportar'));
        for (const item of ['Ficha del ejercicio', 'Video de la jugada', 'Compartir por WhatsApp']) {
          await ui.mover(ui.page.getByRole('menuitem', { name: new RegExp(item) }));
          await ui.sleep(500);
        }
        await ui.clic(ui.page.getByRole('menuitem', { name: /Imagen \(PNG\)/ }));
      },
    },
    {
      dice: 'En Más, Guardar en biblioteca la convierte en un ejercicio de la escuela: se guarda con los puestos, sin nombres, para usarla con cualquier equipo.',
      hace: async (ui) => {
        await ui.clic(barra(ui.page, 'Más'));
        await ui.clic(ui.page.getByRole('menuitem', { name: /Guardar en biblioteca/ }));
        await ui.clic(ui.page.getByLabel('Nombre').first());
        await ui.page.keyboard.type('Salida 4-3-3 por banda', { delay: 45 });
        await ui.clic(ui.page.getByLabel('Objetivo'));
        await ui.page.keyboard.type('Salir jugando por la banda izquierda.', { delay: 25 });
        await ui.clic(ui.page.getByRole('button', { name: /^Guardar en biblioteca$/ }).last());
      },
    },
    {
      dice: 'Y Guardar jugada la deja en el bloque de la sesión.',
      hace: async (ui) => {
        await ui.sleep(800);
        await ui.clic(barra(ui.page, 'Guardar jugada'));
        await ui.sleep(1500);
      },
    },
    {
      dice: 'Al editar una sesión, Desde la biblioteca te muestra tus ejercicios, las plantillas de SportMaps y los paquetes por deporte.',
      pausa: 1500,
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('button', { name: 'Editar' }).first());
        await ui.clic(ui.page.getByRole('button', { name: /Desde la biblioteca/ }).nth(2));
        await ui.sleep(800);
        await ui.clic(ui.page.getByRole('tab', { name: 'De mi escuela' }));
        await ui.sleep(1200);
        await ui.clic(ui.page.getByRole('tab', { name: 'Plantillas SportMaps' }));
      },
    },
  ],
});
