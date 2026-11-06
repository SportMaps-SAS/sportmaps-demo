// Video narrado: "Cobros y pagos" (acompaña a guia-registro-pagos-manual.pdf, 2026-10-17).
// Gemelo local, Club Campestre Demo, admin Carolina Méndez; atleta Mariana López con
// sus cobros de septiembre y octubre pendientes. Caso de todos los días: registrar lo
// que la familia ya pagó por fuera (modo «Un atleta»).
//
// «Cobros y pagos» está detrás de VITE_COBROS_Y_PAGOS; en el gemelo se enciende con
// localStorage['sportmaps:cobros-y-pagos']='on' (en producción ya lo usan GYM RM,
// Dynasty y Dreamers). Cada corrida deja los cobros de Mariana como recién generados.
//
//   node docs/manuales/_src/cobros-y-pagos/video.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grabar, sql } from '../_video/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MARIANA = '00000000-0000-4000-8c00-000000000109';
const ESCUELA = '25a123f0-6d57-48a4-9800-7b1531d61cd2';

sql(`delete from payment_adjustments where payment_id in (select id from payments where child_id='${MARIANA}');
     update payments set status='pending', payment_method=null, payment_channel=null, payment_date=null,
            approved_by=null, approved_at=null, reference=null, amount_paid=null, receipt_url=null,
            charge_batch_id=null
      where child_id='${MARIANA}';
     delete from charge_batches cb where cb.school_id='${ESCUELA}'
       and not exists (select 1 from payments p where p.charge_batch_id=cb.id)
       and not exists (select 1 from payment_adjustments a where a.charge_batch_id=cb.id);`);

const dlg = (page) => page.locator('[role="dialog"]').last();

await grabar({
  nombre: 'cobros-y-pagos',
  usuario: 'admin.campestre',
  inicio: '/payments-automation',
  esperar: 'Cobros por Aprobar',
  almacenamiento: { 'sportmaps:cobros-y-pagos': 'on' },
  trabajo: path.join(here, 'video-raw'),
  pasos: [
    {
      dice: 'Cuando una familia te paga por fuera de la app, en efectivo o por transferencia, lo registras en Cobros y pagos.',
      hace: (ui) => ui.mover(ui.page.getByRole('button', { name: 'Cobros y pagos' })),
    },
    {
      dice: 'Ábrelo desde Gestión de Pagos.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('button', { name: 'Cobros y pagos' }));
        await dlg(ui.page).getByText('Elige el atleta').first().waitFor();
      },
    },
    {
      dice: 'Elige al atleta. Lo puedes buscar por su nombre, el del acudiente o el teléfono.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByRole('combobox').first());
        await ui.page.keyboard.type('Mariana', { delay: 110 });
        await ui.sleep(900);
        await ui.clic(ui.page.getByRole('option', { name: /Mariana López/ }).or(ui.page.getByText('Mariana López').last()));
      },
    },
    {
      dice: 'Abajo aparecen sus cobros pendientes. Marca los que cubre este pago.',
      hace: async (ui) => {
        await ui.mover(dlg(ui.page).getByText(/Cobros pendientes/i));
        await ui.sleep(700);
        await ui.clic(dlg(ui.page).getByText('Mensualidad 09/2026 - Mariana López'));
        await ui.sleep(500);
        await ui.clic(dlg(ui.page).getByText('Mensualidad 10/2026 - Mariana López'));
      },
    },
    {
      dice: 'En cada cobro marcado ves cuánto se paga. Si fue un abono, escribe un valor menor. Y con Descuento, aplicas un descuento con su motivo.',
      hace: async (ui) => {
        await ui.mover(dlg(ui.page).getByLabel('Pagar').first());
        await ui.sleep(1500);
        await ui.mover(dlg(ui.page).getByRole('button', { name: 'Descuento' }).first());
      },
    },
    {
      dice: 'A la derecha, en Ya lo pagaron, elige efectivo o transferencia, y la fecha en que te pagaron.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByText('Transferencia', { exact: true }));
        await ui.sleep(600);
        await ui.mover(dlg(ui.page).getByLabel('Fecha del pago'));
      },
    },
    {
      dice: 'La vista previa te dice exactamente qué va a pasar, antes de confirmar.',
      hace: (ui) => ui.mover(dlg(ui.page).getByText(/Se registra el pago de/)),
    },
    {
      dice: 'Si todo está bien, confirma con Registrar pago.',
      hace: (ui) => ui.clic(dlg(ui.page).getByRole('button', { name: /^Registrar pago/ })),
    },
    {
      dice: 'Listo. Te muestra el resumen de la operación. Los cobros quedan pagados, y la familia recibe la confirmación.',
      pausa: 800,
      hace: async (ui) => {
        const listo = ui.page.getByText(/Listo/).first();
        await listo.waitFor({ timeout: 20000 });
        await ui.mover(listo);
      },
    },
    {
      dice: 'Y si necesitas cobrarle lo mismo a todo un equipo, usa el modo Varios atletas.',
      pausa: 1800,
      hace: async (ui) => {
        const otra = ui.page.getByRole('button', { name: /Otra operación/ });
        if (await otra.count()) await ui.clic(otra);
        await ui.sleep(600); await ui.mover(dlg(ui.page).locator('button', { hasText: 'Varios atletas' }));
      },
    },
  ],
});
