// Video 3/4 del manual del deportista: pagos, mayores de edad (capítulo 6). Nunca paga.
import path from 'node:path';
import { video, here, reiniciarPagos, DEPORTISTA, texto, dialogo } from './comun.mjs';

const COMPROBANTE = path.resolve(here, '../dreamers/comprobante-ejemplo.png');
reiniciarPagos();

const pagar = (ui) => ui.page.getByRole('button', { name: /^Pagar \d+ cobro/ });
const yaTransferi = (ui) => ui.page.getByRole('button', { name: /Ya transferí/ }).or(texto(ui.page, /Ya transferí/));

await video({
  nombre: 'deportista-3-pagos',
  usuario: DEPORTISTA,
  inicio: '/athlete-payments',
  esperar: 'Por pagar',
  pasos: [
    {
      dice: 'Si eres mayor de edad, en Más, Pagos, pagas lo tuyo. Si eres menor, esta pantalla solo te dice que tus pagos los maneja tu acudiente.',
      hace: (ui) => ui.mover(texto(ui.page, /Debes \$/)),
    },
    {
      dice: 'Cada cobro trae su concepto, desde cuándo está vencido, y si incluye recargo por mora. Los cobros ya vienen marcados: desmarca el que no quieras pagar ahora, y el total se recalcula.',
      hace: async (ui) => {
        await ui.mover(texto(ui.page, /Incluye recargo/));
        await ui.sleep(1500);
        await ui.clic(ui.page.getByRole('checkbox').first());
        await ui.sleep(1000);
        await ui.clic(ui.page.getByRole('checkbox').first());
      },
    },
    {
      dice: 'Toca Pagar y elige Pagar online: tarjeta, PSE o Nequi. Si la escuela cobra un recargo por pago en línea, lo ves antes de pagar, con el total final.',
      hace: async (ui) => {
        await ui.clic(pagar(ui));
        await ui.sleep(1500);
        await ui.clic(dialogo(ui.page).getByText(/online|en línea/i).first());
        await ui.sleep(1200);
      },
    },
    {
      dice: 'Si pagaste por transferencia, toca Ya transferí: subir el comprobante.',
      hace: async (ui) => {
        await ui.page.keyboard.press('Escape');
        await ui.sleep(700);
        await ui.page.keyboard.press('Escape');
        await ui.sleep(3800); // que se vaya el aviso «Quedan N cobros»
        await ui.mover(yaTransferi(ui));
      },
    },
    {
      dice: 'Ahí ves los datos de la cuenta de la escuela, con botón para copiarlos. Elige la foto o el PDF del comprobante, de máximo cinco megas, y confirma.',
      hace: async (ui) => {
        await ui.mover(yaTransferi(ui));
        await yaTransferi(ui).first().evaluate((e) => e.click()); // un aviso puede estar encima
        await ui.sleep(1200);
        const transfer = dialogo(ui.page).getByText(/Transferencia/).first();
        if (await transfer.isVisible()) await ui.clic(transfer);
        await ui.sleep(1300);
        await dialogo(ui.page).locator('input[type="file"]').first().setInputFiles(COMPROBANTE);
        await ui.sleep(2500);
        await ui.clic(dialogo(ui.page).getByRole('button', { name: /Pagar|Confirmar|Enviar|Registrar/ }).last());
        await ui.sleep(1500);
      },
    },
    {
      dice: 'El cobro queda En revisión. Cuando la escuela lo aprueba, pasa a Pagados.',
      hace: async (ui) => {
        await ui.ir('/athlete-payments', 'Por pagar');
        await ui.rueda(900);
        await ui.sleep(600);
        await ui.mover(texto(ui.page, 'En revisión'));
      },
    },
    {
      dice: '¿Quieres adelantar un pago? Pagar otro concepto te deja pagar por adelantado la mensualidad de tus inscripciones.',
      hace: (ui) => ui.mover(texto(ui.page, /Pagar otro concepto/)),
    },
    {
      dice: 'En Pagados ves cada pago con su valor, el medio y la fecha. Abajo está tu estado de cuenta, tu historial en Excel, y la factura electrónica, si la escuela la emite.',
      pausa: 900,
      hace: async (ui) => {
        await ui.clic(ui.page.getByRole('tab', { name: 'Pagados' }).or(ui.page.getByRole('button', { name: 'Pagados', exact: true })));
        await ui.sleep(1200);
        await ui.mover(texto(ui.page, /Mi estado de cuenta/));
      },
    },
  ],
});
