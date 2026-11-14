// Video narrado: "Cómo pagan los padres" (acompaña a pagos-de-padres.pdf).
// Gemelo local, Club Campestre Demo, acudiente Laura Gómez / hijo Mateo Gómez.
//
//   node docs/manuales/_src/pagos-familias-registro/video-padres.mjs
//   VOZ=es-CO-SalomeNeural node …/video-padres.mjs       (voz femenina)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grabar, sql } from '../_video/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPROBANTE = path.resolve(here, '../dreamers/comprobante-ejemplo.png');

// Estado de partida: los dos cobros de Mateo (sep y oct) pendientes y sin comprobante.
sql(`update payments set status='pending', receipt_url=null, receipt_submitted_at=null, receipt_image_sha256=null,
       receipt_image_sha256_source=null, receipt_reference_norm=null, receipt_verdict=null, receipt_verdict_at=null,
       receipt_verdict_reasons=null, receipt_number=null, payment_method=null, amount_paid=null
     where child_id='00000000-0000-4000-8c00-000000000101' and status in ('pending','awaiting_approval');`);

const dlg = (page) => page.locator('[role="dialog"]').last();

await grabar({
  nombre: 'pagos-de-padres',
  usuario: 'padre.campestre',
  inicio: '/dashboard',
  esperar: 'pagos pendientes',
  trabajo: path.join(here, 'video-raw'),
  pasos: [
    {
      dice: 'Así pagas la mensualidad en SportMaps. Cuando tienes cobros pendientes, el inicio te avisa con este banner verde.',
      hace: (ui) => ui.mover(ui.page.getByText(/pagos? pendientes?/).first()),
    },
    {
      dice: 'Tócalo y llegas directo a Mis Pagos.',
      hace: async (ui) => { await ui.clic(ui.page.getByText('Toca para pagar ahora')); },
    },
    {
      dice: 'Arriba ves cuánto tienes pendiente. Abajo, cada mes es un cobro aparte, con su estado y su propio botón Pagar.',
      hace: async (ui) => {
        await ui.page.getByText('Monto pendiente').waitFor();
        await ui.mover(ui.page.getByText('Monto pendiente'));
        await ui.sleep(1200);
        await ui.rueda(420);
        await ui.mover(ui.page.getByRole('button', { name: /^PAGAR$/ }).first());
      },
    },
    {
      dice: 'Toca Pagar en el mes que vas a pagar.',
      hace: (ui) => ui.clic(ui.page.getByRole('button', { name: /^PAGAR$/ }).first()),
    },
    {
      dice: 'El valor ya viene listo. Si pagas en línea con Wompi, con tarjeta, PSE o Nequi, ves el recargo y el total antes de continuar.',
      hace: async (ui) => {
        await dlg(ui.page).getByText('Pagar online (Wompi)').waitFor();
        await ui.mover(dlg(ui.page).getByText('Pagar online (Wompi)'));
        await ui.sleep(1500);
        await ui.mover(dlg(ui.page).getByText('Total a pagar'));
      },
    },
    {
      dice: 'Si prefieres transferir, elige Transferencia, Nequi o Daviplata. Aparecen los datos de la cuenta de la escuela, con un botón para copiarlos.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByText('Transferencia / Nequi / Daviplata'));
        await ui.sleep(600);
        await ui.mover(dlg(ui.page).getByText('Número:', { exact: false }).first());
      },
    },
    {
      dice: 'Después de transferir, sube la foto o el PDF del comprobante.',
      hace: async (ui) => {
        const boton = dlg(ui.page).getByText('Seleccionar archivo').first();
        await ui.mover(boton);
        await dlg(ui.page).locator('input[type="file"]').setInputFiles(COMPROBANTE);
        await ui.sleep(1500);
        await ui.mover(dlg(ui.page).getByText(/Comprobante cargado/).first());
      },
    },
    {
      dice: 'Y toca Pagar para enviarlo a la escuela.',
      hace: (ui) => ui.clic(dlg(ui.page).getByRole('button', { name: /^Pagar \$/ })),
    },
    {
      dice: 'Listo. El cobro queda por validar hasta que la escuela revise tu comprobante. Cuando lo apruebe, te llega una notificación y un correo.',
      pausa: 700,
      hace: async (ui) => {
        const entendido = ui.page.getByRole('button', { name: 'Entendido' });
        await entendido.waitFor({ timeout: 15000 });
        await ui.sleep(1800);
        // El aviso se cierra solo a los pocos segundos: el clic es por si sigue abierto.
        await ui.mover(entendido).catch(() => {});
        await entendido.click({ timeout: 2500 }).catch(() => {});
        await ui.sleep(800);
        await ui.mover(ui.page.getByText(/por validar/i).first());
      },
    },
    {
      dice: 'Y en Estado de cuenta ves todo el historial de tu hijo: lo facturado, lo pagado y lo que queda pendiente.',
      hace: async (ui) => {
        await ui.rueda(-600);
        await ui.clic(ui.page.getByText(/Estado de cuenta —/).first());
        await ui.page.getByText('Saldo pendiente').waitFor();
        await ui.mover(ui.page.getByText('Saldo pendiente'));
      },
    },
    { dice: 'Así de fácil. Si tienes dudas sobre un cobro, escríbele a tu escuela.' },
  ],
});
