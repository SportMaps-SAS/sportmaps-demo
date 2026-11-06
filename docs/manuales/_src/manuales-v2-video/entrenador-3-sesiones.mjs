// Video 3/6 del manual del entrenador: sesiones, plan del mes y pizarra (capítulo 6).
import { video, sql, ENTRENADOR, ESCUELA, SUB15, texto } from './comun.mjs';

// Sesión planeada para el jueves de esta semana del Sub-15 (la demo trae las de octubre).
const BLOQUES = JSON.stringify([
  { id: 'b1', name: 'Calentamiento', minutes: '15', activity: 'Rondo 4 contra 2', objective: 'Activación con balón', description: '', component: 'tecnico' },
  { id: 'b2', name: 'Parte principal', minutes: '40', activity: 'Salida de balón contra presión', objective: 'Salir jugando por banda', description: '', component: 'tactico' },
  { id: 'b3', name: 'Juego final', minutes: '20', activity: 'Partido condicionado', objective: 'Aplicar la salida', description: '', component: 'mixto' },
]);
sql(`insert into training_sessions (id, team_id, school_id, created_by, session_date, objectives, session_blocks)
  values ('00000000-0000-4000-9f00-000000000501', '${SUB15}', '${ESCUELA}', (select id from profiles where email = '${ENTRENADOR}'), date '2026-11-05', 'Salida de balón contra presión alta', '${BLOQUES}'::jsonb)
  on conflict (id) do update set session_blocks = excluded.session_blocks;`);

await video({
  nombre: 'entrenador-3-sesiones',
  usuario: ENTRENADOR,
  inicio: '/training-plans',
  esperar: 'Plan del mes',
  pasos: [
    {
      dice: 'Sesiones tiene tres vistas: Hoy, con la sesión del día; Semana; y Plan del mes. Arriba a la derecha, el botón Pizarra.',
      hace: async (ui) => {
        for (const n of ['Hoy', 'Semana', 'Plan del mes']) { await ui.mover(ui.page.getByRole('tab', { name: n, exact: true }).or(ui.page.getByRole('button', { name: n, exact: true })).first(), { pasos: 12 }); await ui.sleep(500); }
      },
    },
    {
      dice: 'En Semana, cada día dice qué equipo entrena y si ya tiene sesión. Planear te lleva a la planificación completa, con el equipo y el día ya elegidos.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('tab', { name: 'Semana', exact: true }).or(ui.page.getByRole('button', { name: 'Semana', exact: true })).first());
        await ui.sleep(1300);
        await ui.mover(texto(ui.page, 'Planear', true));
      },
    },
    {
      dice: 'Al tocar un día con sesión ves sus bloques, y dos botones: Ver sesión, y Abrir en la cancha.',
      hace: async (ui) => {
        const dia = ui.page.getByText('Jue', { exact: true }).first();
        await ui.mover(dia);
        const b = await dia.boundingBox();
        await ui.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); // la fila se redibuja: el clic de Playwright nunca la ve estable
        await ui.sleep(1400);
        await ui.mover(texto(ui.page, /Ver sesión/));
      },
    },
    {
      dice: 'Abrir en la cancha la pone en letra grande, un bloque a la vez, con Anterior y Siguiente. La pantalla no se apaga mientras estás ahí.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Abrir en la cancha/));
        await ui.sleep(1400);
        // El modo cancha se redibuja seguido («Manteniendo la pantalla encendida…»): clic directo.
        await ui.mover(ui.page.getByRole('button', { name: /Siguiente/ }));
        await ui.page.getByRole('button', { name: /Siguiente/ }).evaluate((e) => e.click());
        await ui.sleep(2600);
        await ui.mover(ui.page.getByRole('button', { name: /Salir/ }));
        await ui.page.getByRole('button', { name: /Salir/ }).evaluate((e) => e.click());
      },
    },
    {
      dice: 'En Plan del mes eliges el equipo, y ves el objetivo del mes, las cuatro semanas con su carga, y el balance de entrenos hechos.',
      hace: async (ui) => {
        await ui.ir('/training-plans', 'Plan del mes');
        await ui.clic(ui.page.getByRole('tab', { name: 'Plan del mes', exact: true }).or(ui.page.getByRole('button', { name: 'Plan del mes', exact: true })).first());
        await ui.sleep(1500);
      },
    },
    {
      dice: 'Crear o editar sesiones y el plan se hace en la planificación completa, más cómoda en el computador: mesociclos, semanas, y los bloques de cada sesión, que también puedes traer de la biblioteca.',
      hace: async (ui) => { await ui.rueda(300); await ui.sleep(900); },
    },
    {
      dice: 'El botón Pizarra abre la pizarra libre. Eliges el equipo, y aparece la cancha con Empieza aquí: poner jugadores, dibujar un ejercicio, o pedirle una jugada a la inteligencia artificial.',
      hace: async (ui) => {
        await ui.page.evaluate(() => scrollTo(0, 0));
        await ui.clic(ui.page.getByRole('button', { name: /Pizarra/ }).or(ui.page.getByRole('link', { name: /Pizarra/ })));
        await ui.sleep(1500);
        const eq = texto(ui.page, /Fútbol — Sub-15/);
        if (await eq.isVisible().catch(() => false)) await ui.clic(eq);
        await ui.sleep(2500);
      },
    },
    {
      dice: 'Cuando termines, Guardar te deja dejarla en tus jugadas, o agregarla a una sesión. Y Exportar la saca como imagen, ficha en PDF, o enlace por WhatsApp, sin los nombres de tus deportistas.',
      pausa: 900,
      hace: async (ui) => { await ui.sleep(1500); },
    },
  ],
});
