// Video 4/4 del manual del deportista: Más y ayuda (capítulos 7 y 8). Mapi se muestra sin
// enviarle preguntas: el gemelo no tiene llave de IA.
import { video, DEPORTISTA, texto } from './comun.mjs';

const fila = (ui, t) => texto(ui.page, t, true);

await video({
  nombre: 'deportista-4-mas-y-ayuda',
  usuario: DEPORTISTA,
  inicio: '/mas',
  esperar: 'Mi actividad',
  pasos: [
    {
      dice: 'Más tiene todo lo que no está en la barra. Arriba, tu nombre, tu equipo y tu escuela. Después, Pagos, con lo que debes, solo si eres mayor de edad.',
      hace: (ui) => ui.mover(fila(ui, 'Pagos')),
    },
    {
      dice: 'En Inscripciones y planes están tus planes activos, para ver y agendar clases, y tus reservas.',
      hace: async (ui) => { await ui.clic(fila(ui, 'Inscripciones y planes')); await ui.sleep(1600); },
    },
    {
      dice: 'En Torneos y eventos, los torneos a los que te inscribiste, con su estado.',
      hace: async (ui) => {
        await ui.ir('/mas', 'Mi actividad');
        await ui.clic(fila(ui, 'Torneos y eventos'));
        await ui.sleep(1500);
      },
    },
    {
      dice: 'En Mis objetivos creas tus metas deportivas, y marcas tu avance.',
      hace: async (ui) => {
        await ui.ir('/mas', 'Mi actividad');
        await ui.clic(fila(ui, 'Mis objetivos'));
        await ui.sleep(1500);
      },
    },
    {
      dice: 'Bienestar tiene tu salud, tus citas, y tus medidas, como peso y talla, para ver su evolución.',
      hace: async (ui) => {
        await ui.ir('/mas', 'Mi actividad');
        await ui.mover(fila(ui, 'Mi salud'));
        await ui.sleep(800);
        await ui.mover(fila(ui, 'Mis medidas'));
      },
    },
    {
      dice: 'En Cuenta están tus notificaciones, tus datos, y la configuración de avisos y contraseña. El documento de identidad es de solo lectura: para cambiarlo, habla con la escuela.',
      hace: async (ui) => {
        await ui.mover(fila(ui, 'Notificaciones'));
        await ui.sleep(900);
        await ui.mover(fila(ui, 'Mis datos'));
        await ui.sleep(900);
        await ui.mover(fila(ui, 'Configuración'));
      },
    },
    {
      dice: 'Si no sabes cómo hacer algo, escríbele a Mapi, el botón redondo de abajo a la derecha, como le escribirías a una persona. Te responde paso a paso, y si no puede resolverlo, pasa tu pregunta a soporte.',
      hace: async (ui) => {
        const mapi = ui.page.locator('img[alt*="Mapi" i], button[aria-label*="Mapi" i]').first();
        await ui.clic(mapi);
        await ui.sleep(1500);
      },
    },
    {
      dice: 'También puedes tocar Escribirle al club, que abre WhatsApp con el número de tu escuela, o el Centro de ayuda, con guías paso a paso.',
      pausa: 900,
      hace: async (ui) => {
        await ui.ir('/mas', 'Mi actividad');
        await ui.mover(fila(ui, 'Escribirle al club'));
        await ui.sleep(1200);
        await ui.mover(fila(ui, 'Centro de ayuda'));
      },
    },
  ],
});
