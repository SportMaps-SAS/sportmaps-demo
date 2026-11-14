// Video 1/5 del manual del acudiente: cómo está organizada la app, Inicio y Calendario (capítulos 1 a 3).
import { video, reiniciarConvocatoria, ACUDIENTE, pestana, texto, dialogo } from './comun.mjs';

reiniciarConvocatoria();

await video({
  nombre: 'acudiente-1-inicio-y-calendario',
  usuario: ACUDIENTE,
  inicio: '/dashboard',
  esperar: 'cobros pendientes',
  pasos: [
    {
      dice: 'La app para familias está pensada para el celular. Todo está en estas cinco pestañas de abajo: Inicio, Calendario, Hijos, Pagos y Más.',
      hace: async (ui) => {
        for (const p of ['Inicio', 'Calendario', 'Hijos', 'Pagos', 'Más']) { await ui.mover(pestana(ui.page, p), { pasos: 14 }); await ui.sleep(450); }
      },
    },
    {
      dice: 'Inicio te dice en una frase si estás al día. Aquí hay cobros pendientes, cuál es el más antiguo, y el botón verde te lleva directo a pagarlos.',
      hace: async (ui) => {
        await ui.mover(texto(ui.page, 'cobros pendientes'));
        await ui.sleep(1200);
        await ui.mover(ui.page.getByRole('button', { name: /^Pagar/ }).or(ui.page.getByRole('link', { name: /^Pagar/ })));
      },
    },
    {
      dice: 'Debajo, el próximo entreno de cualquiera de tus hijos, y la tarjeta de cada uno, con su equipo, su profe y si debe algo.',
      hace: async (ui) => {
        await ui.mover(texto(ui.page, /entrena hoy|entrena mañana/));
        await ui.sleep(900);
        await ui.mover(texto(ui.page, 'Natación — Infantil'));
      },
    },
    {
      dice: 'Cuando el profe publica el informe del mes, su frase aparece aquí, entre comillas.',
      hace: (ui) => ui.mover(texto(ui.page, /Septiembre fue un mes/)),
    },
    {
      dice: 'Y si convocaron a tu hijo a un partido, Inicio te pregunta si va, con el día, la hora, el lugar y la nota de llegada.',
      hace: (ui) => ui.mover(texto(ui.page, /Va Tomás al partido/)),
    },
    {
      dice: 'Toca Va o No va, y el profe recibe tu respuesta. Si cambian los planes, tocas Cambiar.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('button', { name: 'Va', exact: true }).first());
        await texto(ui.page, /Tomás va/).waitFor({ timeout: 15000 });
        await ui.mover(ui.page.getByRole('button', { name: 'Cambiar', exact: true }).first());
      },
    },
    {
      dice: 'En Calendario ves los entrenos, partidos y torneos de todos tus hijos juntos, día por día. El calendario lo arma la escuela: tú lo recibes.',
      hace: async (ui) => {
        await ui.clic(pestana(ui.page, 'Calendario'));
        await texto(ui.page, /Entreno · /).waitFor({ timeout: 20000 });
        await ui.sleep(800);
        await ui.mover(texto(ui.page, /Entreno · /));
      },
    },
    {
      dice: 'Los partidos traen la nota de la escuela. Al tocar uno ves el detalle: la hora, el lugar con el botón Ver mapa, y la convocatoria.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Halcones FC/));
        await ui.sleep(900);
        await ui.mover(dialogo(ui.page).getByText('Ver mapa').first());
      },
    },
    {
      dice: 'Para cerrar, toca la equis o desliza hacia abajo.',
      hace: async (ui) => {
        await ui.page.keyboard.press('Escape');
        await ui.sleep(500);
      },
    },
    {
      dice: 'En Torneos ves dónde ya está inscrito tu hijo y los que tienen inscripciones abiertas, con el precio y la fecha límite.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('tab', { name: 'Torneos' }).or(ui.page.getByRole('button', { name: 'Torneos', exact: true })));
        await ui.sleep(1500);
      },
    },
    {
      dice: 'Y Mes es la cuadrícula de siempre: los días con eventos tienen una marca, y al tocar uno ves sus eventos abajo.',
      pausa: 900,
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('tab', { name: 'Mes' }).or(ui.page.getByRole('button', { name: 'Mes', exact: true })));
        await ui.sleep(1000);
        await ui.clic(ui.page.getByRole('gridcell', { name: '14', exact: true }).or(ui.page.getByRole('button', { name: /^14$|14 de noviembre/ })));
      },
    },
  ],
});
