// Video narrado: "Cómo tomar asistencia" (acompaña a tomar-asistencia.pdf).
// Gemelo local, Club Campestre Demo, entrenador Andrés Vélez con el equipo Fútbol Sub-12
// (perfil profesional marcado completo en coach_profiles para que no salte el asistente)
// (6 deportistas). Cada corrida borra la sesión de hoy de ese equipo y vuelve a empezar.
//
//   node docs/manuales/_src/tomar-asistencia/video.mjs
//
// Grabar contra un build de PRODUCCIÓN servido sobre el gemelo (BASE_URL=http://localhost:3102,
// `vite build` + `vite preview`). En `vite` dev la lista carga SIN marcar: StrictMode renderiza
// dos veces y la precarga en Presente (useMemo + presetAppliedKeyRef en CoachAttendancePage)
// se pierde. En producción arranca con todos en Presente, como dice el manual (2026-10-22).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grabar, sql } from '../_video/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EQUIPO = '00000000-0000-4000-9e00-000000000201';

sql(`delete from attendance_records where team_id='${EQUIPO}' and attendance_date=current_date;
     delete from attendance_sessions where team_id='${EQUIPO}' and session_date=current_date;
     update enrollments set sessions_used=0 where team_id='${EQUIPO}' and status='active';`);

const estado = (page, n, nombre) => page.locator(`main button[title="${nombre}"]`).nth(n);

await grabar({
  nombre: 'tomar-asistencia',
  usuario: 'coach.campestre',
  inicio: '/dashboard',
  esperar: 'Pasa lista de tu equipo de hoy',
  trabajo: path.join(here, 'video-raw'),
  pasos: [
    {
      dice: 'Así tomas asistencia en SportMaps. En tu panel principal tienes un acceso rápido: Tomar asistencia.',
      hace: (ui) => ui.mover(ui.page.getByText('Pasa lista de tu equipo de hoy en segundos')),
    },
    {
      dice: 'Tócalo, y la app abre directo la lista del equipo que tienes hoy. También llegas desde el menú, en Asistencias.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByText('Pasa lista de tu equipo de hoy en segundos'));
        const detectado = ui.page.getByText(/Detectamos tu equipo de hoy/);
        await detectado.waitFor({ timeout: 20000 });
        await ui.mover(detectado);
      },
    },
    {
      dice: 'Si no es el equipo correcto, toca: No es esta, cambiar.',
      hace: (ui) => ui.mover(ui.page.getByText('No es esta, cambiar')),
    },
    {
      dice: 'La lista arranca con todo el equipo marcado en Presente. Así solo cambias a quienes no vinieron.',
      hace: async (ui) => {
        await ui.mover(ui.page.locator('main button[title="Presente"]').first());
        await ui.sleep(1200);
        await ui.mover(ui.page.getByText(/TODOS PRESENTES/i));
      },
    },
    {
      dice: 'Cada deportista tiene cuatro estados: presente, ausente, tarde y excusado. Toca el que corresponda.',
      hace: async (ui) => {
        await ui.clic(estado(ui.page, 1, 'Ausente'));
        await ui.sleep(500);
        await ui.clic(estado(ui.page, 2, 'Tarde'));
        await ui.sleep(500);
        await ui.clic(estado(ui.page, 3, 'Excusado'));
      },
    },
    {
      dice: 'Marcar presente descuenta una clase del plan del deportista. Si después lo cambias a ausente, la clase se le devuelve.',
      hace: async (ui) => {
        await ui.mover(ui.page.getByText(/usadas/).first());
        await ui.sleep(1500);
        await ui.mover(estado(ui.page, 0, 'Presente'));
      },
    },
    {
      dice: 'Cuando termines, toca Guardar asistencia.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('button', { name: 'Guardar asistencia' }));
        await ui.page.getByRole('button', { name: /Finalizar sesión/ }).waitFor({ timeout: 15000 });
        // El aviso "Asistencia guardada · se descontó 1 clase a N atletas" queda a la vista.
        await ui.mover(ui.page.getByText('Asistencia guardada'));
      },
    },
    {
      dice: 'Al terminar el entrenamiento, toca Finalizar sesión, para cerrar la lista del día.',
      hace: async (ui) => {
        // El aviso de guardado tapa el botón (abajo a la derecha): se cierra con su X.
        const aviso = ui.page.locator('li[data-state="open"]');
        if (await aviso.count()) {
          await ui.mover(aviso);
          await aviso.first().locator('button').first().click({ force: true }).catch(() => {});
          await aviso.first().waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});
        }
        await ui.clic(ui.page.getByRole('button', { name: /Finalizar sesión/ }));
        await ui.page.getByRole('button', { name: 'Sí, finalizar' }).waitFor();
      },
    },
    {
      dice: 'Confírmalo. Quien haya quedado sin marcar pasa a ausente, y su familia recibe un aviso.',
      hace: async (ui) => {
        await ui.sleep(1500);
        await ui.clic(ui.page.getByRole('button', { name: 'Sí, finalizar' }));
      },
    },
    {
      dice: 'Al finalizar, la app te pide calificar el entreno de cada deportista. Puedes hacerlo ahora, o cerrar la ventana.',
      hace: async (ui) => {
        const califica = ui.page.getByText('Califica el entreno de hoy');
        await califica.waitFor({ timeout: 15000 });
        await ui.mover(califica);
        await ui.sleep(2500);
        const cerrar = ui.page.locator('[role="dialog"]').last().locator('button:has(svg.lucide-x), button[aria-label="Close"], button:has-text("Close")');
        if (await cerrar.count()) await ui.clic(cerrar, { forzar: true });
        else await ui.page.keyboard.press('Escape');
        await califica.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => ui.page.keyboard.press('Escape'));
      },
    },
    {
      dice: 'La lista queda cerrada con candado. Si te equivocaste, puedes reabrirla para corregir.',
      hace: async (ui) => {
        const reabrir = ui.page.getByText(/Reabrir para corregir/);
        await reabrir.waitFor({ timeout: 15000 });
        await ui.mover(reabrir);
      },
    },
    {
      dice: 'Y si se te pasó un día, en Día de la lista eliges una fecha anterior, y la completas.',
      hace: async (ui) => {
        await ui.rueda(-800);
        await ui.mover(ui.page.getByText(/día de la lista/i).first());
      },
    },
    {
      dice: 'También puedes marcar las llegadas escaneando el carnet digital de cada deportista. Así de fácil.',
      hace: async (ui) => { await ui.rueda(-1200); await ui.mover(ui.page.getByText('Escanear carnet')); },
    },
  ],
});
