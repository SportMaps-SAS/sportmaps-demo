// Video 2/4 del manual del deportista: Progreso y Carnet (capítulos 4 y 5).
import { video, DEPORTISTA, pestana, texto } from './comun.mjs';

const sub = (ui, n) => texto(ui.page, n, true);

await video({
  nombre: 'deportista-2-progreso-y-carnet',
  usuario: DEPORTISTA,
  inicio: '/stats',
  esperar: 'Cómo me fue',
  pasos: [
    {
      dice: 'Progreso es todo lo que tu profe dice de ti, en un solo lugar. Solo te comparas con tu propio avance, nunca con otros deportistas.',
      hace: (ui) => ui.mover(sub(ui, 'Cómo me fue')),
    },
    {
      dice: 'Cómo me fue trae la frase del mes, la gráfica de qué tan duro fue, y lo que dijo el profe de tus últimos entrenos.',
      hace: async (ui) => { await ui.clic(sub(ui, 'Cómo me fue')); await ui.sleep(1200); },
    },
    {
      dice: 'En qué mejoro muestra las habilidades que mide tu profe, con tu nivel y cuánto subiste. Mientras no haya medido nada, la pestaña te lo dice.',
      hace: async (ui) => { await ui.clic(sub(ui, 'En qué mejoro')); await ui.sleep(1200); },
    },
    {
      dice: 'En Informes está lo que trabajó tu equipo en el mes, y tus informes mensuales, que se descargan en PDF.',
      hace: async (ui) => { await ui.clic(sub(ui, 'Informes')); await ui.sleep(1200); },
    },
    {
      dice: 'Y Felicitaciones guarda todas las que te ha dejado tu profe, con quién y cuándo.',
      hace: async (ui) => {
        await ui.clic(sub(ui, 'Felicitaciones'));
        await ui.sleep(900);
        await ui.mover(texto(ui.page, /Gran constancia/));
      },
    },
    {
      dice: 'Carnet es tu carnet digital: lo muestras en la entrada del club, en los torneos y donde te lo pidan. Ves tu foto, tu equipo, el código Q R y hasta cuándo es válido.',
      hace: async (ui) => {
        await ui.clic(pestana(ui.page, 'Carnet'));
        await texto(ui.page, /Vence el/).waitFor();
        await ui.sleep(600);
        await ui.mover(texto(ui.page, /Vence el/));
      },
    },
    {
      dice: 'Toca el código para agrandarlo a pantalla completa, y acércalo al lector. Si no lo toma, sube el brillo de la pantalla.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Toca el código/));
        await ui.sleep(2200);
        await ui.page.keyboard.press('Escape');
        await ui.sleep(500);
      },
    },
    {
      dice: 'Guardar imagen descarga el carnet a tu celular, para tenerlo aunque no haya internet. Compartir lo envía por WhatsApp o por donde quieras.',
      pausa: 900,
      hace: async (ui) => {
        await ui.mover(texto(ui.page, 'Guardar imagen'));
        await ui.sleep(1300);
        await ui.mover(texto(ui.page, 'Compartir', true));
      },
    },
  ],
});
