// Video 3/5 del manual del acudiente: partidos y convocatorias (capítulo 5).
import { video, compartirPartidos, reiniciarConvocatoria, ACUDIENTE, TOMAS, texto } from './comun.mjs';

reiniciarConvocatoria();
compartirPartidos();

await video({
  nombre: 'acudiente-3-partidos-y-convocatorias',
  usuario: ACUDIENTE,
  inicio: '/notifications',
  esperar: 'Notificaciones',
  pasos: [
    {
      dice: 'Cuando el profe arma la convocatoria, te llega un aviso: tu hijo está convocado, con el día, la hora y el lugar.',
      hace: (ui) => ui.mover(texto(ui.page, /Convocatoria: vs Halcones/)),
    },
    {
      dice: 'El profe necesita saber con quién cuenta. Respondes en dos lugares. Uno es Inicio, en la tarjeta de tu hijo.',
      hace: async (ui) => {
        await ui.ir('/dashboard', 'cobros pendientes');
        await ui.mover(texto(ui.page, /Va Tomás al partido/));
      },
    },
    {
      dice: 'Toca Va o No va, y sale el mensaje de que le avisaste al profe. Si cambian los planes, toca Cambiar y el profe ve la respuesta nueva. Si tienes varios hijos convocados, respondes por cada uno.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('button', { name: 'Va', exact: true }).first());
        await texto(ui.page, /Le avisaste al profe/).waitFor({ timeout: 15000 });
        await ui.sleep(900);
        await ui.mover(ui.page.getByRole('button', { name: 'Cambiar', exact: true }).first());
      },
    },
    {
      dice: 'El otro lugar es el Calendario: tocas el partido, y la convocatoria sale al final del detalle.',
      hace: async (ui) => {
        await ui.ir('/calendar', 'Próximos');
        await ui.clic(texto(ui.page, /Halcones FC/));
        await ui.sleep(1000);
      },
    },
    {
      dice: 'Después del partido, en Hijos, Informes, Informes de partidos, ves cada uno con su resultado: ganó, empató o perdió.',
      hace: async (ui) => {
        await ui.ir(`/children/${TOMAS}/partidos`, 'Partidos de Tomás');
        await ui.sleep(900);
        await ui.mover(texto(ui.page, /Arrayanes/));
      },
    },
    {
      dice: 'El reporte del profe cuenta el resumen, cómo fue el partido y qué van a mejorar. Si la administración dejó un comentario, también sale.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Arrayanes/));
        await ui.sleep(1200);
        await ui.rueda(250);
      },
    },
    {
      dice: 'Debajo está Tu respuesta: escríbele al profe lo que quieras sobre el partido y toca Enviar. Puedes editarla después.',
      hace: async (ui) => { await ui.mover(texto(ui.page, /Tu respuesta/)); await ui.sleep(800); },
    },
    {
      dice: 'Y si la escuela comparte las evaluaciones, la calificación de tu hijo aparece en Progreso, junto con lo que el profe mide en los entrenos. Cada familia ve solo la de su hijo.',
      pausa: 900,
      hace: async (ui) => {
        await ui.ir(`/children?hijo=${TOMAS}`, 'Tomás Herrera');
        await ui.sleep(900);
        await ui.rueda(350);
      },
    },
  ],
});
