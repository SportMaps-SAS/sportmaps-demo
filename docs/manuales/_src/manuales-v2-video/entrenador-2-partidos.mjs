// Video 2/6 del manual del entrenador: partidos, de la convocatoria al reporte (capítulo 5).
// Muestra los pasos sin guardar resultados: el partido contra Halcones sigue por jugar.
import { video, reiniciarConvocatoria, compartirPartidos, ENTRENADOR, HALCONES, texto, dialogo } from './comun.mjs';

reiniciarConvocatoria();
compartirPartidos();
const ARRAYANES = '03f916e1-5950-4da2-a5b5-c368ddb94407';
const paso = (ui, n) => ui.page.getByRole('button', { name: new RegExp(n + '$') }).first();

await video({
  nombre: 'entrenador-2-partidos',
  usuario: ENTRENADOR,
  inicio: '/teams',
  esperar: 'Fútbol — Sub-15',
  pasos: [
    {
      dice: 'Todo el partido vive en una sola pantalla. En Equipos, abre tu equipo y toca Partidos y convocatorias. Arriba está el botón verde más Partido.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Fútbol — Sub-15/));
        await ui.sleep(900);
        await ui.clic(ui.page.getByRole('tab', { name: /Partidos/ }));
        await ui.sleep(1200);
        await ui.mover(texto(ui.page, /Partido$/));
      },
    },
    {
      dice: 'Para programar: contra quién, la fecha, si juegan en casa o de visita, la cancha, el tipo, y una nota para las familias, como el uniforme o la hora de llegada.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Partido$/));
        await ui.sleep(1300);
        await ui.clic(ui.page.getByRole('textbox').first());
        await ui.page.keyboard.type('Atlético Sabana', { delay: 60 });
        await ui.sleep(600);
      },
    },
    {
      dice: 'Si la fecha es futura, toca Programar y convocar. El partido queda también en el calendario, y las familias lo ven.',
      hace: async (ui) => {
        await ui.mover(texto(ui.page, /Programar y convocar|Ya se jugó/));
        await ui.sleep(1000);
        await ui.page.keyboard.press('Escape');
        await ui.sleep(500);
      },
    },
    {
      dice: 'Al abrir un partido ves arriba los cinco pasos: Programar, Convocar, Resultado, Evaluar y Reporte. Los que ya hiciste quedan con un chulo, y puedes volver a cualquiera.',
      hace: async (ui) => {
        await ui.ir(`/partidos/${HALCONES}`, 'Contra Halcones FC');
        await ui.sleep(800);
        for (const n of ['Programar', 'Convocar', 'Resultado', 'Evaluar', 'Reporte']) { await ui.mover(paso(ui, n), { pasos: 10 }); await ui.sleep(300); }
      },
    },
    {
      dice: 'En Convocar arrancas con todos los del equipo: toca a quien no va para quitarlo. Las familias reciben el aviso, y aquí ves cuántos van, cuántos no van y cuántos faltan por responder.',
      hace: async (ui) => {
        await ui.clic(paso(ui, 'Convocar'));
        await ui.sleep(1000);
        await ui.mover(texto(ui.page, /sin responder/));
      },
    },
    {
      dice: 'En Resultado, el marcador tiene más y menos para cada lado. Toca a un deportista para anotarle gol, asistencia, amarilla o roja: queda guardado al instante.',
      hace: async (ui) => {
        await ui.ir(`/partidos/${ARRAYANES}`, 'Arrayanes');
        await ui.sleep(700);
        await ui.clic(paso(ui, 'Resultado'));
        await ui.sleep(1200);
        await ui.rueda(300);
      },
    },
    {
      dice: 'En Evaluar solo salen los convocados. Pon sus minutos, titular o suplente, califica de uno a cinco los criterios de tu escuela, y deja un comentario corto.',
      hace: async (ui) => {
        await ui.page.evaluate(() => scrollTo(0, 0));
        await ui.clic(paso(ui, 'Evaluar'));
        await ui.sleep(1400);
      },
    },
    {
      dice: 'En Reporte cuentas cómo fue: resumen, desarrollo y aspectos a mejorar. Con Publicar a las familias se lo mandas a las del equipo. Para que les llegue, la administración tiene que compartir los reportes de partido con las familias.',
      hace: async (ui) => {
        await ui.clic(paso(ui, 'Reporte'));
        await ui.sleep(1500);
      },
    },
    {
      dice: 'Si un partido ya pasó y nadie anotó el marcador, sale en la lista Falta el resultado: tócalo para cerrarlo. Y la pizarra te deja armar la alineación con los convocados.',
      pausa: 900,
      hace: async (ui) => {
        await ui.ir('/teams', 'Fútbol — Sub-15');
        await ui.clic(texto(ui.page, /Fútbol — Sub-15/));
        await ui.sleep(900);
        await ui.clic(ui.page.getByRole('tab', { name: /Partidos/ }));
        await ui.sleep(1300);
        await ui.mover(texto(ui.page, /alineación/i));
      },
    },
  ],
});
