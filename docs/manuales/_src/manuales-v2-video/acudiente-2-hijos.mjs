// Video 2/5 del manual del acudiente: la ficha de cada hijo (capítulo 4).
import { video, ACUDIENTE, TOMAS, texto, pestana } from './comun.mjs';

const pestanaHijo = (ui, n) => ui.page.getByText(n, { exact: true }).first();

await video({
  nombre: 'acudiente-2-hijos',
  usuario: ACUDIENTE,
  inicio: `/children?hijo=${TOMAS}`,
  esperar: 'Tomás Herrera',
  pasos: [
    {
      dice: 'En Hijos ves la ficha de cada uno. Si tienes varios, arriba eliges a cuál ver. La ficha tiene cuatro pestañas: Progreso, Asistencia, Informes y Ficha.',
      hace: async (ui) => {
        await ui.mover(ui.page.getByText('Sofía', { exact: true }).first());
        await ui.sleep(700);
        await ui.mover(ui.page.getByText('Tomás', { exact: true }).first());
        await ui.sleep(700);
        for (const n of ['Progreso', 'Asistencia', 'Informes', 'Ficha']) { await ui.mover(pestanaHijo(ui, n), { pasos: 12 }); await ui.sleep(350); }
      },
    },
    {
      dice: 'Progreso muestra en qué va mejorando: cada habilidad que el profe mide, con la flecha de si subió o bajó. Tu hijo solo se compara con su propio avance, nunca con otros niños.',
      hace: async (ui) => {
        await ui.clic(pestanaHijo(ui, 'Progreso'));
        await ui.sleep(1200);
        await ui.mover(texto(ui.page, /En qué va mejorando/));
      },
    },
    {
      dice: 'Abajo está qué trabajar en casa, y lo que dijo el profe, con la fecha.',
      hace: async (ui) => { await ui.rueda(450); await ui.sleep(900); },
    },
    {
      dice: 'En Asistencia está el porcentaje de cada mes y los últimos entrenos: Vino, Llegó tarde, No vino o Con excusa. Llegar tarde cuenta como haber venido.',
      hace: async (ui) => { await ui.clic(pestanaHijo(ui, 'Asistencia')); await ui.sleep(1200); },
    },
    {
      dice: 'En Informes está lo que publica la escuela: el informe del mes, lo que trabajó el equipo, y los informes de los partidos.',
      hace: async (ui) => { await ui.clic(pestanaHijo(ui, 'Informes')); await ui.sleep(1200); },
    },
    {
      dice: 'El informe del mes trae la asistencia, la frase del equipo, lo mejor del mes, lo que hay que trabajar, y se descarga en PDF.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Informe de septiembre/));
        await texto(ui.page, /Descargar/).waitFor({ timeout: 15000 });
        await ui.mover(texto(ui.page, /Descargar/));
      },
    },
    {
      dice: 'En Ficha están el documento, la EPS, el tipo de sangre, las alergias y el contacto de emergencia. Si algo está mal, toca Corregir un dato.',
      hace: async (ui) => {
        await ui.ir(`/children?hijo=${TOMAS}`, 'Tomás Herrera');
        await ui.clic(pestanaHijo(ui, 'Ficha'));
        await ui.sleep(5500);
        await ui.mover(texto(ui.page, /Corregir un dato/));
      },
    },
    {
      dice: 'También están los documentos. Hay diez tipos y ninguno es obligatorio: súbelos si la escuela te los pide. Solo los ve la escuela.',
      hace: async (ui) => { await ui.mover(ui.page.getByText(/Documento del deportista/).first()); await ui.sleep(1500); await ui.rueda(350); await ui.sleep(800); },
    },
    {
      dice: 'Y el carnet digital: en Más, Carnets, están los de tus hijos con su vigencia.',
      hace: async (ui) => {
        await ui.clic(pestana(ui.page, 'Más'));
        await ui.clic(texto(ui.page, 'Carnets', true));
        await texto(ui.page, /vigentes|Vigente/).waitFor({ timeout: 15000 });
        await ui.sleep(600);
      },
    },
    {
      dice: 'Al tocar uno se abre en grande, con el código Q R para la entrada de la escuela. Abajo puedes ver el reverso, descargarlo o compartirlo.',
      pausa: 900,
      hace: async (ui) => {
        await ui.clic(texto(ui.page, 'Tomás Herrera', true));
        await ui.sleep(2000);
      },
    },
  ],
});
