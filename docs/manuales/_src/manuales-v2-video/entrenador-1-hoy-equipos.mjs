// Video 1/6 del manual del entrenador: la app, Hoy, Equipos y deportistas (capítulos 1 a 4). Andrés Ríos.
import { video, ENTRENADOR, pestana, texto } from './comun.mjs';

await video({
  nombre: 'entrenador-1-hoy-y-equipos',
  usuario: ENTRENADOR,
  inicio: '/dashboard',
  esperar: 'Pizarra',
  pasos: [
    {
      dice: 'La app del entrenador está pensada para usarla en la cancha: botones grandes y una sola cosa por pantalla. Lo de cada día está en estas cinco pestañas: Hoy, Equipos, Sesiones, Asistencia y Más.',
      hace: async (ui) => {
        for (const p of ['Hoy', 'Equipos', 'Sesiones', 'Asistencia', 'Más']) { await ui.mover(pestana(ui.page, p), { pasos: 14 }); await ui.sleep(500); }
      },
    },
    {
      dice: 'La primera vez que entras te pide tu perfil profesional: se llena una sola vez y tarda un minuto. Luego, Hoy te dice si entrenas hoy, o qué entrenas mañana.',
      hace: (ui) => ui.mover(texto(ui.page, /Hoy no entrenas|Hoy entrenas/)),
    },
    {
      dice: 'Debajo está siempre el botón Pizarra, para dibujar una jugada ya, sin llenar nada.',
      hace: (ui) => ui.mover(texto(ui.page, 'Pizarra', true)),
    },
    {
      dice: 'Los días libres ves Tu semana: cuántos entrenos van y cuántos faltan por evaluar, y tu última jugada. Lo pendiente sale en amarillo, con un botón para resolverlo en un toque.',
      hace: async (ui) => {
        await ui.mover(texto(ui.page, 'Tu semana', true));
        await ui.sleep(1200);
        await ui.mover(texto(ui.page, /Tu última jugada/));
      },
    },
    {
      dice: 'En Equipos ves los tuyos, con cuántos deportistas tienen y cuándo es el próximo entreno.',
      hace: async (ui) => {
        await ui.clic(pestana(ui.page, 'Equipos'));
        await texto(ui.page, /Fútbol — Sub-15/).waitFor();
        await ui.sleep(700);
        await ui.mover(texto(ui.page, /Fútbol — Sub-15/));
      },
    },
    {
      dice: 'Al tocar uno se abre con tres pestañas: Deportistas, Partidos y convocatorias, y Evaluar. La lista trae a cada uno con su acudiente, y si está al día o vencido en pagos. Tú solo ves el estado: los valores los maneja la escuela.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Fútbol — Sub-15/));
        await texto(ui.page, /Tomás Herrera/).waitFor();
        await ui.sleep(900);
        await ui.mover(texto(ui.page, /Tomás Herrera/));
      },
    },
    {
      dice: 'Al tocar un deportista salen tres acciones: Escribir al acudiente, que abre WhatsApp; Felicitar; y Ver ficha.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Tomás Herrera/));
        await ui.sleep(900);
        await ui.mover(texto(ui.page, /Felicitar/));
      },
    },
    {
      dice: 'Felicitar trae frases listas, o escribes la tuya. Le llega a la familia y, si tiene cuenta, al deportista. Tienes unos segundos para deshacer.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Felicitar/));
        await ui.sleep(1500);
        await ui.page.keyboard.press('Escape');
        await ui.sleep(500);
      },
    },
    {
      dice: 'Ver ficha muestra acudiente, salud y pagos. Y la pestaña Evaluar trae el informe del mes, los entrenos recientes con lista, y el informe del entreno para todo el equipo.',
      pausa: 900,
      hace: async (ui) => {
        await ui.mover(texto(ui.page, /Ver ficha/));
        await ui.sleep(1200);
        await ui.clic(texto(ui.page, 'Evaluar', true));
        await ui.sleep(1200);
      },
    },
  ],
});
