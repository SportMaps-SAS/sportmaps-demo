// Video 5/5 del manual del acudiente: unirse con el código y Más (capítulos 7 y 8).
// Cuenta nueva de Paula Mejía, sin escuela: el video reinicia su estado cada vez.
import { video, reiniciarCuentaNueva, NUEVA, DUENO, ACUDIENTE, texto } from './comun.mjs';

reiniciarCuentaNueva();
const CODIGO = 'CAM-ABUP';

await video({
  nombre: 'acudiente-5-unirse-con-el-codigo',
  usuario: NUEVA,
  inicio: '/dashboard',
  esperar: 'Ya tienes escuela',
  pasos: [
    {
      dice: 'Si creaste tu cuenta y todavía no ves a tu hijo, pídele a la escuela su código: tres letras y cuatro caracteres. En Inicio aparece el aviso: ¿Ya tienes escuela?',
      hace: (ui) => ui.mover(texto(ui.page, /Ya tienes escuela/)),
    },
    {
      dice: 'Escribe el código y busca tu escuela. También puedes llegar por el enlace o el Q R que te mande la escuela.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Ya tienes escuela/));
        await ui.sleep(900);
        await ui.clic(ui.page.getByRole('textbox').first());
        await ui.page.keyboard.type(CODIGO, { delay: 110 });
        await ui.sleep(500);
        await ui.clic(ui.page.getByRole('button', { name: /Buscar mi escuela/ }));
        await ui.sleep(1200);
      },
    },
    {
      dice: 'Aparece el nombre, el logo y la ciudad. Si es la tuya, toca Sí, es mi escuela.',
      hace: async (ui) => {
        await ui.mover(ui.page.getByRole('button', { name: /Sí, es mi escuela/ }));
        await ui.sleep(3400);
        await ui.clic(ui.page.getByRole('button', { name: /Sí, es mi escuela/ }));
      },
    },
    {
      dice: 'Elige para quién es: para tu hijo, o para ti si tú entrenas. Escribe el nombre completo y la fecha de nacimiento. La categoría es solo una sugerencia: la escuela decide.',
      hace: async (ui) => {
        await ui.clic(texto(ui.page, /Para mi hijo/));
        await ui.sleep(600);
        await ui.clic(ui.page.getByRole('textbox').first());
        await ui.page.keyboard.type('Lucía Mejía', { delay: 70 });
        await ui.page.locator('input[type="date"]').first().fill('2015-03-12');
        await ui.sleep(700);
      },
    },
    {
      dice: 'Toca Enviar solicitud. Listo: la escuela te asignará la categoría. Todavía no se crea ningún cobro.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('button', { name: /Enviar solicitud/ }));
        await texto(ui.page, /Solicitud enviada/).waitFor({ timeout: 15000 });
        await ui.sleep(800);
      },
    },
    {
      dice: 'Mientras tanto, Inicio y Hijos muestran tu solicitud en amarillo, con la opción de cancelarla.',
      hace: async (ui) => {
        await ui.ir('/dashboard', 'Solicitud enviada');
        await ui.mover(texto(ui.page, /Cancelar solicitud/));
      },
    },
    {
      dice: 'Del otro lado, en Por asignar, la escuela ve la solicitud y elige el equipo. Te llega el aviso de bienvenida y, si la escuela cobra, el primer cobro, con unos días para pagarlo.',
      hace: async (ui) => {
        await ui.entrarComo(DUENO, '/students', 'Por asignar');
        await ui.sleep(1200);
        await ui.mover(texto(ui.page, /Lucía Mejía/));
      },
    },
    {
      dice: 'Lo demás está en Más: inscripciones, torneos, carnets, constancias, compras, salud, y ayuda. Escribirle al club abre el WhatsApp de la escuela.',
      hace: async (ui) => {
        await ui.entrarComo(ACUDIENTE, '/mas', 'Mi cuenta');
        await ui.sleep(700);
        await ui.mover(texto(ui.page, 'Escribirle al club', true));
      },
    },
    {
      dice: 'Y Mapi, el botón redondo de abajo a la derecha, responde cualquier duda con los pasos. Tu perfil, tus avisos y tu contraseña están en Mi cuenta.',
      pausa: 900,
      hace: (ui) => ui.mover(texto(ui.page, 'Mi cuenta', true)),
    },
  ],
});
