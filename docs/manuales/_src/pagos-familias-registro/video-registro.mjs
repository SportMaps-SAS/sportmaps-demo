// Video narrado: "Registro de pago manual" (acompaña a guia-registro-pagos-manual.pdf).
// Gemelo local, Club Campestre Demo, admin Carolina Méndez; deportista Daniel Pérez
// (acudiente Diana Pérez) con sus cobros de septiembre y octubre pendientes.
//
//   node docs/manuales/_src/pagos-familias-registro/video-registro.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grabar, sql } from '../_video/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPROBANTE = path.resolve(here, '../dreamers/comprobante-ejemplo.png');
const DANIEL = '00000000-0000-4000-8c00-000000000108';

// Estado de partida: los dos cobros de Daniel pendientes, como recién generados.
sql(`update payments set status='pending', payment_method=null, payment_channel=null, payment_date=null,
       approved_by=null, approved_at=null, reference=null, amount_paid=null, receipt_url=null,
       receipt_image_sha256=null, receipt_image_sha256_source=null, receipt_reference_norm=null
     where child_id='${DANIEL}';`);

const dlg = (page) => page.locator('[role="dialog"]').last();

await grabar({
  nombre: 'registro-pago-manual',
  usuario: 'admin.campestre',
  inicio: '/payments-automation',
  esperar: 'Cobros por Aprobar',
  trabajo: path.join(here, 'video-raw'),
  pasos: [
    {
      dice: 'Cuando un padre te paga en efectivo, o por transferencia por fuera de la app, regístralo tú mismo desde Gestión de Pagos.',
      hace: (ui) => ui.mover(ui.page.getByRole('button', { name: 'Registrar pago' }).first()),
    },
    {
      dice: 'Toca Registrar pago.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('button', { name: 'Registrar pago' }).first());
        await dlg(ui.page).getByText('Registrar pago manual').waitFor();
      },
    },
    {
      dice: 'Primero, elige cómo te pagaron: en efectivo o por transferencia.',
      hace: async (ui) => {
        await ui.mover(dlg(ui.page).getByText(/^efectivo$/i));
        await ui.sleep(900);
        await ui.clic(dlg(ui.page).getByText(/^transferencia$/i));
      },
    },
    {
      dice: 'Con transferencia, puedes adjuntar la captura que te mandó el padre. Es opcional.',
      hace: async (ui) => {
        await ui.mover(dlg(ui.page).getByText('Seleccionar archivo').first());
        await dlg(ui.page).locator('input[type="file"]').first().setInputFiles(COMPROBANTE);
        await ui.sleep(1200);
      },
    },
    {
      dice: 'Ahora busca al deportista. Debajo de cada nombre ves el acudiente, para no confundirte con nombres parecidos.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByText('Selecciona a quién aplica'));
        await ui.page.keyboard.type('Daniel', { delay: 110 });
        await ui.sleep(900);
        await ui.mover(ui.page.getByText('Daniel Pérez').last());
      },
    },
    {
      dice: 'Elígelo.',
      hace: (ui) => ui.clic(ui.page.getByText('Daniel Pérez').last()),
    },
    {
      dice: 'En Aplicar a, escoge el cobro que te pagaron. Así ese mismo cobro queda pagado, y no se crea uno nuevo.',
      hace: async (ui) => {
        const selector = dlg(ui.page).getByText('Nuevo cobro (sin asociar)').first();
        await ui.clic(selector);
        await ui.sleep(600);
        await ui.mover(ui.page.getByRole('option').nth(1));
        await ui.sleep(1800);
        await ui.page.keyboard.press('Escape');
      },
    },
    {
      dice: 'Si te pagó varios meses juntos, toca Pagar varios cobros a la vez, y marca los que correspondan. Abajo ves el total.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByText('Pagar varios cobros a la vez'));
        await ui.clic(dlg(ui.page).getByText(/Seleccionar todos/));
        await ui.sleep(500);
        await ui.mover(dlg(ui.page).getByText(/Total a registrar/));
      },
    },
    {
      dice: 'Revisa la fecha del pago, y toca Confirmar registro.',
      hace: async (ui) => {
        await ui.mover(dlg(ui.page).getByText(/fecha del pago/i));
        await ui.sleep(900);
        await ui.clic(dlg(ui.page).getByRole('button', { name: /confirmar registro/i }));
      },
    },
    {
      dice: 'Listo. Los cobros quedan pagados, el deportista sale de la cartera, y el padre recibe una notificación y un correo.',
      hace: async (ui) => {
        const aviso = ui.page.getByText('Pagos registrados').first();
        await aviso.waitFor({ timeout: 15000 });
        await ui.mover(aviso);
      },
    },
    { dice: 'Así registras en segundos los pagos que llegan por fuera de la app.' },
  ],
});
