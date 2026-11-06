// Video 1/4 del manual del deportista: la app, Hoy y Entrenos (capítulos 1 a 3). Valentina Cruz, adulta.
import { video, sql, DEPORTISTA, pestana, texto } from './comun.mjs';

// Partido de golf contra Los Arrayanes sin responder.
sql(`delete from match_callup_responses where athlete_user_id = (select id from profiles where email = '${DEPORTISTA}');`);

await video({
  nombre: 'deportista-1-hoy-y-entrenos',
  usuario: DEPORTISTA,
  inicio: '/dashboard',
  esperar: 'cobros pendientes',
  pasos: [
    {
      dice: 'La app para deportistas está pensada para el celular. Lo del día a día está en estas cinco pestañas: Hoy, Entrenos, Progreso, Carnet y Más.',
      hace: async (ui) => {
        for (const p of ['Hoy', 'Entrenos', 'Progreso', 'Carnet', 'Más']) { await ui.mover(pestana(ui.page, p), { pasos: 14 }); await ui.sleep(450); }
      },
    },
    {
      dice: 'Hoy te dice en una mirada qué tienes que hacer. Si debes algo, lo primero es la frase y el botón verde para pagar. Si eres menor de edad, la app no te muestra plata: los pagos los maneja tu acudiente.',
      hace: async (ui) => {
        await ui.mover(texto(ui.page, /cobros pendientes/));
        await ui.sleep(1500);
        await ui.mover(ui.page.getByRole('button', { name: /^Pagar/ }).or(ui.page.getByRole('link', { name: /^Pagar/ })));
      },
    },
    {
      dice: 'Si el profe te convocó, sale la tarjeta Convocatoria, con el rival, la fecha, la hora, el lugar y la nota del profe.',
      hace: (ui) => ui.mover(texto(ui.page, /Estás en la convocatoria|Convocatoria/)),
    },
    {
      dice: 'Toca Voy o No puedo ir. Durante unos segundos aparece Deshacer, por si te equivocaste. Después puedes tocar Cambiar. Tu profe ve tu respuesta al instante.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('button', { name: 'Voy', exact: true }));
        await ui.sleep(1200);
        await ui.mover(texto(ui.page, /Deshacer|Vas al partido/));
      },
    },
    {
      dice: 'Cuando tu profe te felicita, su mensaje sale aquí. Debajo, cuántos entrenos del mes viniste, y tu racha de entrenos seguidos sin faltar.',
      hace: async (ui) => {
        await ui.mover(texto(ui.page, /te felicitó/));
        await ui.sleep(1200);
        await ui.mover(texto(ui.page, /entrenos? seguidos?/));
      },
    },
    {
      dice: 'En Entrenos ves cuándo y dónde entrenas. Arriba, los partidos a los que te convocaron, con tu respuesta. Debajo, tus entrenos día por día.',
      hace: async (ui) => {
        await ui.clic(pestana(ui.page, 'Entrenos'));
        await texto(ui.page, /Arrayanes/).waitFor();
        await ui.sleep(600);
        await ui.mover(texto(ui.page, /Arrayanes/));
      },
    },
    {
      dice: 'Para la casa son las rutinas que tu profe dejó para que hagas por tu cuenta, con duración y nivel. Agrégalas a tu día, y tu profe lo ve.',
      hace: async (ui) => { await ui.clic(texto(ui.page, 'Para la casa', true)); await ui.sleep(1300); },
    },
    {
      dice: 'Ver todos mis entrenamientos abre la pantalla completa: sesiones con entrenador personal, actividad libre, rutinas e historial.',
      hace: async (ui) => {
        await ui.mover(texto(ui.page, /Ver todos mis entrenamientos/));
        await ui.sleep(700);
        await ui.clic(texto(ui.page, /Ver todos mis entrenamientos/));
        await ui.sleep(1500);
      },
    },
    {
      dice: 'Y Ver el mes completo abre el calendario: la cuadrícula del mes y los próximos eventos que publica tu escuela.',
      pausa: 900,
      hace: async (ui) => {
        await ui.ir('/calendar', 'Próximos');
        await ui.sleep(1200);
        await ui.mover(texto(ui.page, /Próximos/));
      },
    },
  ],
});
