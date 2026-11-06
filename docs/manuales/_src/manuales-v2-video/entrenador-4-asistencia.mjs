// Video 4/6 del manual del entrenador: tomar lista y evaluar el entreno (capítulo 7).
// Lista de ayer del Sub-15 (martes no: se toma con «Otro día» si hace falta); el video limpia la lista antes.
import { video, sql, ENTRENADOR, ESCUELA, SUB15, texto } from './comun.mjs';

const boton = (ui, n) => ui.page.getByRole('button', { name: n }).first();

// Sin lista de hoy para el Sub-15.
sql(`begin; set local session_replication_role = replica;
  delete from attendance_records where session_id in (select id from attendance_sessions where team_id = '${SUB15}' and session_date = (now() at time zone 'America/Bogota')::date);
  delete from attendance_sessions where team_id = '${SUB15}' and session_date = (now() at time zone 'America/Bogota')::date;
  commit;`);

await video({
  nombre: 'entrenador-4-asistencia',
  usuario: ENTRENADOR,
  inicio: '/coach-attendance',
  esperar: 'Tomar lista',
  pasos: [
    {
      dice: 'Asistencia tiene dos pestañas: Tomar lista e Historial. Elige el equipo. Si tienes uno solo, entra directo.',
      hace: async (ui) => {
        await ui.mover(texto(ui.page, /Fútbol — Sub-15/));
        await ui.sleep(800);
        await ui.clic(texto(ui.page, /Fútbol — Sub-15/));
        await ui.sleep(1300);
      },
    },
    {
      dice: 'Elige el día: Hoy, Ayer, u Otro día. La lista arranca con todos en Vino: solo tocas al que no vino.',
      hace: async (ui) => { await ui.mover(texto(ui.page, 'Hoy', true)); await ui.sleep(1200); },
    },
    {
      dice: 'Cada toque cambia el estado: Vino, Faltó, Excusa, Tarde. Arriba se va contando cuántos vinieron.',
      hace: async (ui) => {
        const fila = texto(ui.page, /Tomás Herrera/);
        await ui.clic(fila);
        await ui.sleep(800);
        await ui.clic(fila);
        await ui.sleep(800);
      },
    },
    {
      dice: 'Toca Guardar lista. Durante unos segundos puedes deshacer. Si no hay internet, la lista se guarda en el teléfono y sube sola cuando vuelva la señal.',
      hace: async (ui) => {
        await ui.clic(boton(ui, /Guardar lista/));
        await ui.sleep(1500);
        await ui.mover(texto(ui.page, /Deshacer|Lista guardada/));
      },
    },
    {
      dice: 'Cerrar y evaluar deja la lista fija, y te lleva directo a evaluar al equipo. Para evaluar el entreno, ciérrala el mismo día.',
      hace: async (ui) => {
        await ui.sleep(5500);
        await ui.clic(boton(ui, /Cerrar y evaluar/));
        await ui.sleep(1000);
        const si = ui.page.getByRole('button', { name: /Sí, cerrar/ }).first();
        if (await si.isVisible()) await ui.clic(si);
        await ui.sleep(1800);
      },
    },
    {
      dice: 'Solo salen los que vinieron, y todos arrancan en Normal: toca al que le fue Bien o al que Le costó, o usa A todos: Bien.',
      hace: async (ui) => {
        await ui.mover(texto(ui.page, /A todos/));
        await ui.sleep(900);
        await ui.clic(ui.page.getByText('Bien', { exact: true }).first());
      },
    },
    {
      dice: 'Escribe una nota opcional para las familias, y toca Guardar evaluación. Cuando dice Guardado, las familias reciben: Así le fue hoy.',
      hace: async (ui) => {
        await ui.clic(boton(ui, /Guardar evaluación/));
        await ui.sleep(1500);
      },
    },
    {
      dice: 'En Historial está el porcentaje del mes, y cada entreno con cuántos vinieron. Los que todavía puedes cambiar tienen Corregir; los más viejos, un candado.',
      hace: async (ui) => {
        await ui.ir('/coach-attendance', 'Tomar lista');
        await ui.clic(texto(ui.page, 'Historial', true));
        await ui.sleep(1500);
        await ui.rueda(250);
      },
    },
    {
      dice: 'Y Escanear carnets en la entrada abre la cámara: cada deportista muestra el código de su carnet, y queda presente al toque. Escanear dos veces no duplica.',
      pausa: 900,
      hace: async (ui) => {
        await ui.clic(texto(ui.page, 'Tomar lista', true));
        await ui.sleep(1200);
        await ui.mover(texto(ui.page, /Escanear carnets/));
      },
    },
  ],
});
