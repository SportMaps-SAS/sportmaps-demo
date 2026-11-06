// Video 6/6 del manual del entrenador: planillas en papel, hojas de matrícula y Más (capítulos 9 y 10).
// Prende el permiso por la pantalla de la escuela; no sube fotos (el OCR necesita llave de IA).
import { video, sql, ENTRENADOR, DUENO, ESCUELA, pestana, texto } from './comun.mjs';

sql(`update school_settings set coach_can_upload_attendance_sheets = false, coach_can_upload_enrollment_forms = false where school_id = '${ESCUELA}';`);

const permiso = (ui, t) => ui.page.locator('div.flex.items-center.justify-between').filter({ hasText: t }).last();

await video({
  nombre: 'entrenador-6-planillas-y-mas',
  usuario: ENTRENADOR,
  inicio: '/coach-attendance',
  esperar: 'Tomar lista',
  pasos: [
    {
      dice: 'Si en tu escuela la asistencia a veces se llena en papel, puedes tomarle una foto a la hoja. En Asistencia, Historial, toca Subir planilla en papel.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, 'Historial', true));
        await ui.sleep(1300);
        await ui.mover(texto(ui.page, /Subir planilla en papel/));
      },
    },
    {
      dice: 'Para subirlas, tu escuela tiene que darte el permiso. Si no lo tiene activo, al tocar Subir planilla te lo avisa.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Subir planilla en papel/));
        await ui.sleep(1500);
      },
    },
    {
      dice: 'La administración lo prende en Pagos, Config, Permisos: Coaches pueden subir planillas de asistencia, y toca Guardar Cambios.',
      hace: async (ui) => {
        await ui.entrarComo(DUENO, '/payments-automation?tab=config', 'Coaches pueden subir planillas de asistencia');
        await ui.mover(permiso(ui, 'Coaches pueden subir planillas de asistencia').getByRole('switch'));
        await ui.clic(permiso(ui, 'Coaches pueden subir planillas de asistencia').getByRole('switch'));
        await ui.sleep(700);
        await ui.clic(ui.page.getByRole('button', { name: 'Guardar Cambios' }));
        await ui.sleep(1500);
      },
    },
    {
      dice: 'Con el permiso, tomas la foto de la hoja completa, de frente y con buena luz. El sistema lee los nombres y los cruza con la lista del grupo. Nada se guarda solo: alguien revisa y confirma.',
      hace: async (ui) => {
        await ui.entrarComo(ENTRENADOR, '/coach-attendance', 'Tomar lista');
        await ui.clic(texto(ui.page, 'Historial', true));
        await ui.sleep(1000);
        await ui.clic(texto(ui.page, /Subir planilla en papel/));
        await ui.sleep(1500);
      },
    },
    {
      dice: 'En la hoja, marca solo a los que vinieron, y deja en blanco a los que faltaron. Una casilla vacía no cuenta como falta. Lo que el sistema no distingue sale como dudosa, para que lo confirmes con la foto.',
      hace: async (ui) => { await ui.sleep(1500); },
    },
    {
      dice: 'Las hojas de matrícula funcionan igual, si tu escuela lo permite: tú solo tomas la foto, y la escuela revisa los datos y crea al deportista.',
      hace: async (ui) => { await ui.sleep(1000); },
    },
    {
      dice: 'Lo que usas de vez en cuando está en Más: agenda y citas, calendario, informe mensual, informes del entreno, pizarra y rutinas.',
      hace: async (ui) => {
        await ui.clic(pestana(ui.page, 'Más'));
        await texto(ui.page, 'Informe mensual', true).waitFor();
        await ui.sleep(600);
        await ui.mover(texto(ui.page, 'Informe mensual', true));
      },
    },
    {
      dice: 'También tu dotación, la salud del equipo, mensajes, anuncios y encuestas, y la ayuda. Preguntarle a Mapi te responde al momento, o te pasa con una persona del equipo de SportMaps.',
      pausa: 900,
      hace: async (ui) => {
        await ui.mover(texto(ui.page, 'Mi dotación', true));
        await ui.sleep(1200);
        await ui.mover(texto(ui.page, 'Preguntarle a Mapi', true));
      },
    },
  ],
});
