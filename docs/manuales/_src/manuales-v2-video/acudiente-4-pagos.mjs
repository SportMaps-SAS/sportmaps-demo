// Video 4/5 del manual del acudiente: pagos (capítulo 6). Nunca paga: la pasarela se muestra y se cierra.
import path from 'node:path';
import { video, here, reiniciarPagos, ACUDIENTE, texto, dialogo } from './comun.mjs';

reiniciarPagos();

const COMPROBANTE = path.resolve(here, '../dreamers/comprobante-ejemplo.png');
const pagar = (ui) => ui.page.getByRole('button', { name: /^Pagar \d+ cobro/ });
const yaTransferi = (ui) => ui.page.getByRole('button', { name: /Ya transferí/ }).or(texto(ui.page, /Ya transferí/));

await video({
  nombre: 'acudiente-4-pagos',
  usuario: ACUDIENTE,
  inicio: '/my-payments',
  esperar: 'Por pagar',
  pasos: [
    {
      dice: 'En Pagos ves cuánto debes en total. Cada cobro viene ya marcado: si los quieres pagar todos, no tienes que tocar nada más.',
      hace: (ui) => ui.mover(texto(ui.page, /Debes \$/)),
    },
    {
      dice: 'Cada cobro dice el concepto, de qué hijo es, desde cuándo está vencido, y si incluye recargo por mora.',
      hace: (ui) => ui.mover(texto(ui.page, /Incluye recargo por mora/)),
    },
    {
      dice: 'Para dejar uno por fuera, desmárcalo. El botón de abajo se recalcula solo.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('checkbox').first());
        await ui.sleep(900);
        await ui.mover(pagar(ui));
        await ui.clic(ui.page.getByRole('checkbox').first());
      },
    },
    {
      dice: 'Toca Pagar. Los cobros se pagan uno por uno. Con Pagar en línea eliges tarjeta, PSE o Nequi, y ves el valor y el total antes de ir a la pasarela segura.',
      hace: async (ui) => {
        await ui.clic(pagar(ui));
        await ui.sleep(1500);
        await ui.clic(dialogo(ui.page).getByText(/online|en línea/i).first());
        await ui.sleep(1200);
      },
    },
    {
      dice: 'Si pagaste por transferencia, Nequi o Daviplata, cierra esto y toca Ya transferí: subir el comprobante.',
      hace: async (ui) => {
        await ui.page.keyboard.press('Escape');
        await ui.sleep(700);
        await ui.page.keyboard.press('Escape');
        await ui.sleep(3800); // que se vaya el aviso «Quedan N cobros»
        await ui.mover(yaTransferi(ui));
      },
    },
    {
      dice: 'La ventana te muestra los datos de la cuenta de la escuela, con un botón para copiarlos, y el lugar para subir tu comprobante.',
      hace: async (ui) => {
        await ui.mover(yaTransferi(ui));
        await yaTransferi(ui).first().evaluate((e) => e.click()); // un aviso puede estar encima
        await ui.sleep(1500);
        await ui.mover(dialogo(ui.page).getByText(/Sube tu comprobante|comprobante/i).first());
      },
    },
    {
      dice: 'Elige la foto o el PDF, espera el chulo de comprobante cargado, y confirma.',
      hace: async (ui) => {
        await dialogo(ui.page).locator('input[type="file"]').first().setInputFiles(COMPROBANTE);
        await ui.sleep(2500);
        await ui.clic(dialogo(ui.page).getByRole('button', { name: /Pagar|Confirmar|Enviar|Registrar/ }).last());
        await ui.sleep(1500);
      },
    },
    {
      dice: 'Ese cobro pasa a En revisión hasta que la escuela compare el comprobante con su cuenta. Cuando lo aprueba, pasa a Pagados y te llega un aviso.',
      hace: async (ui) => {
        await ui.ir('/my-payments', 'Por pagar');
        await ui.rueda(900);
        await ui.sleep(600);
        await ui.mover(texto(ui.page, 'En revisión'));
      },
    },
    {
      dice: 'En Pagados está todo lo que ya pagaste, con el valor, el medio y la fecha. Los que tienen Recibo lo abren con un toque.',
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('tab', { name: 'Pagados' }).or(ui.page.getByRole('button', { name: 'Pagados', exact: true })));
        await ui.sleep(1200);
      },
    },
    {
      dice: 'Y el estado de cuenta de cada hijo muestra, mes a mes, cuánto debe, qué está vencido y qué está en revisión, con Pagar este cobro en cada uno, y el botón Imprimir.',
      pausa: 900,
      hace: async (ui) => {
        await ui.ir('/estado-cuenta', 'estado de cuenta');
        await ui.sleep(800);
        await ui.clic(ui.page.getByText('Tomás Herrera', { exact: true }).first());
        await ui.sleep(1500);
        await ui.rueda(300);
      },
    },
  ],
});
