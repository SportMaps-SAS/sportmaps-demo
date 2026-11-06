// Video narrado 1/2 de la pizarra táctica: «Armar una jugada» (acompaña a pizarra-tactica.pdf v2).
// Capítulos 1–6 del manual: abrir el tablero, formación propia y rival, jugadores,
// dibujo con tipos de línea y zona, material y Campo. Termina con «Guardar jugada».
// El 2/2 (video-animar.mjs) sigue con cuadros, 3D, IA, exportar y biblioteca.
//
// Gemelo local contra el BUILD de producción (como tomar-asistencia: en dev el
// StrictMode y la compilación al vuelo vuelven lentas las acciones sobre la cancha):
//   BASE_URL=http://localhost:3102 node docs/manuales/_src/pizarra-tactica/video-armar.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grabar } from '../_video/lib.mjs';
import { reiniciar, abrirTablero, tablero, barra, cancha, en, ficha, hacia, arrastrar, tocar } from './video-comun.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
reiniciar();

const t = (ui) => tablero(ui.page);
const tipoLinea = (ui, titulo) => ui.clic(t(ui).locator(`button[title^="${titulo}"]`));
/** Flecha entre dos puntos con el cursor visible. */
const flecha = (ui, a, b) => arrastrar(ui.page, a, b, 36);

await grabar({
  nombre: 'pizarra-tactica-armar-jugada',
  usuario: 'coach.campestre',
  inicio: '/training-plans',
  esperar: 'Métricas y Rendimiento',
  trabajo: path.join(here, 'video-raw'),
  pasos: [
    {
      dice: 'La pizarra táctica vive en cada sesión. En Métricas y Rendimiento eliges el equipo, y cada bloque de la sesión trae su botón Tablero táctico.',
      hace: async (ui) => {
        await abrirTablero(ui, 1);
        await ui.mover(ui.page.getByRole('button', { name: /Tablero táctico/ }).nth(1));
      },
    },
    {
      dice: 'El tablero abre a pantalla completa: arriba las herramientas, en el centro la cancha, y abajo la línea de tiempo.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('button', { name: /Tablero táctico/ }).nth(1));
        await barra(ui.page, 'Guardar jugada').waitFor({ timeout: 30000 });
        await ui.sleep(1500);
        await ui.mover(barra(ui.page, 'Formación'));
      },
    },
    {
      dice: 'En Formación eliges un sistema de la galería. En fútbol hay treinta y ocho, con buscador.',
      hace: async (ui) => {
        await ui.clic(barra(ui.page, 'Formación'));
        const buscar = ui.page.getByPlaceholder(/Buscar/i).first();
        await ui.clic(buscar);
        await ui.page.keyboard.type('433', { delay: 140 });
        await ui.sleep(600);
        await ui.mover(ui.page.getByRole('button', { name: /^4-3-3/ }).first());
      },
    },
    {
      dice: 'Al tocar la tarjeta, tus deportistas se acomodan solos en cada puesto.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('button', { name: /^4-3-3/ }).first());
        await ui.sleep(800);
        await ui.mover(t(ui).getByText('MR', { exact: true }));
      },
    },
    {
      dice: 'En la pestaña Rival, la misma galería pone al contrario en espejo, en la mitad de arriba, con fichas rojas. Elegir otra formación lo reemplaza.',
      hace: async (ui) => {
        await ui.clic(barra(ui.page, '4-3-3'));
        await ui.clic(ui.page.getByRole('tab', { name: 'Rival' }));
        const buscar = ui.page.getByPlaceholder(/Buscar/i).first();
        await buscar.fill('');
        await ui.clic(buscar);
        await ui.page.keyboard.type('442', { delay: 140 });
        await ui.sleep(500);
        await ui.clic(ui.page.getByRole('button', { name: /^4-4-2/ }).first());
      },
    },
    {
      dice: 'Con la equis devuelves a un jugador a la plantilla. El panel Jugadores separa disponibles y banca, y desde ahí lo arrastras a cualquier puesto.',
      hace: async (ui) => {
        // Con el panel abierto la cancha se corre: el puesto se guarda en % de la cancha
        // (quitar a un jugador no deja círculo punteado en su lugar).
        const r0 = await cancha(ui.page), sc = await ficha(ui.page, 'SC');
        const pct = { x: ((sc.x - r0.x) / r0.width) * 100, y: ((sc.y - r0.y) / r0.height) * 100 };
        await ui.clic(t(ui).getByRole('button', { name: /^Quitar a Samuel Castro/ }));
        await ui.clic(barra(ui.page, 'Jugadores'));
        await ui.sleep(500);
        const lugar = en(await cancha(ui.page), pct.x, pct.y);
        const item = t(ui).getByText('Samuel Castro').first();
        await ui.mover(item);
        const b = await item.boundingBox();
        await arrastrar(ui.page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, lugar, 40);
        await ui.sleep(400);
        await ui.clic(barra(ui.page, 'Jugadores'));
      },
    },
    {
      dice: 'En Dibujar están el lápiz, el texto, las líneas, el balón en juego y las zonas. Activas Modo dibujo y, con Numerar, cada flecha lleva el orden del movimiento.',
      hace: async (ui) => {
        await ui.clic(barra(ui.page, 'Dibujar'));
        await ui.clic(t(ui).getByRole('button', { name: 'Modo dibujo' }));
        await ui.clic(t(ui).getByRole('button', { name: 'Numerar' }));
        await ui.clic(t(ui).getByRole('button', { name: 'Flecha', exact: true }));
      },
    },
    {
      dice: 'El tipo de línea dice qué pasa: un pase, discontinuo. Una conducción, ondulada, con el balón en los pies.',
      hace: async (ui) => {
        const et = await ficha(ui.page, 'ET'), mg = await ficha(ui.page, 'MG');
        await tipoLinea(ui, 'Discontinua');
        await flecha(ui, hacia(et, mg, 30), hacia(mg, et, 30));
        const r = await cancha(ui.page);
        await tipoLinea(ui, 'Ondulada');
        await flecha(ui, hacia(mg, en(r, 31, 28), 30), en(r, 31, 28));
      },
    },
    {
      dice: 'Una carrera sin balón, continua. Y el disparo, doble y grueso. La leyenda aparece sola en la cancha, y cada figura se ajusta arrastrando sus puntos blancos.',
      hace: async (ui) => {
        const r = await cancha(ui.page);
        const sc = await ficha(ui.page, 'SC');
        await tipoLinea(ui, 'Continua');
        await flecha(ui, hacia(sc, en(r, 34, 7), 30), en(r, 34, 7));
        await tipoLinea(ui, 'Doble');
        // Arranca lejos de fichas y de las puntas de otras flechas (si no, las arrastra).
        await flecha(ui, en(r, 35, 23), en(r, 46, 2));
        await ui.mover(t(ui).getByText('Carrera sin balón').last());
      },
    },
    {
      dice: 'Con Zona marcas un espacio, por ejemplo, dónde presionar. Hay rectángulo, elipse y polígono, con relleno translúcido y nueve colores.',
      hace: async (ui) => {
        await ui.clic(t(ui).getByRole('button', { name: 'Zona', exact: true }));
        await ui.clic(t(ui).getByRole('button', { name: 'Elipse' }));
        const r = await cancha(ui.page);
        await arrastrar(ui.page, en(r, 54, 25), en(r, 80, 37), 30);
      },
    },
    {
      dice: 'Reproducir jugada mueve a cada jugador hasta la punta de su flecha, y el balón recorre su línea.',
      hace: async (ui) => {
        await t(ui).getByText('Reproducir jugada').first().scrollIntoViewIfNeeded();
        await ui.clic(t(ui).getByRole('button', { name: /Reproducir jugada/ }));
        await ui.sleep(3500);
      },
    },
    {
      dice: 'En Material pones conos, platos, arcos, vallas y más. Toca uno ya puesto para cambiarle el tamaño, girarlo o duplicarlo.',
      hace: async (ui) => {
        await ui.clic(barra(ui.page, 'Material'));
        await ui.clic(t(ui).locator('[title="Cono"]'));
        const r = await cancha(ui.page);
        await tocar(ui.page, en(r, 80, 86));
        await tocar(ui.page, en(r, 80, 86));
        await ui.clic(t(ui).getByRole('button', { name: /Duplicar/ }));
        await ui.clic(t(ui).getByRole('button', { name: /Duplicar/ }));
      },
    },
    {
      dice: 'En Más, Campo, eliges líneas de ayuda, como los cinco carriles o los tercios, la cámara y el piso de la cancha. Se guarda con la jugada, y sale igual al exportar.',
      hace: async (ui) => {
        await ui.clic(barra(ui.page, 'Dibujar'));
        await ui.clic(barra(ui.page, 'Más'));
        await ui.clic(ui.page.getByRole('menuitem', { name: /Campo/ }));
        await ui.clic(ui.page.getByRole('button', { name: '5 carriles' }).first());
        await ui.clic(ui.page.getByRole('button', { name: 'Césped liso' }));
        await ui.clic(ui.page.getByRole('button', { name: 'Listo' }));
      },
    },
    {
      dice: 'Cuando esté lista, Guardar jugada la deja en este bloque de la sesión. En el siguiente video: animarla, verla en 3D y compartirla.',
      pausa: 1200,
      hace: async (ui) => {
        await ui.sleep(1200);
        await ui.clic(barra(ui.page, 'Guardar jugada'));
      },
    },
  ],
});
