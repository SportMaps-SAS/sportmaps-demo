// Video narrado: "Artículos deportivos y cobros sueltos" (acompaña a catalogo-articulos-y-torneos.pdf).
// Gemelo local, Club Campestre Demo. Tres tramos en una sola toma:
//   escuela (Carolina Méndez) carga el catálogo en Pagos → Config →
//   familia (Laura Gómez, hijo Mateo) compra una camiseta por transferencia →
//   escuela aprueba la compra en Cobros por Aprobar.
// Los catálogos los prende SportMaps (merchandise_enabled / tournament_charges_enabled,
// con trigger que solo deja a super admin): en el gemelo se prenden saltando triggers.
//
//   node docs/manuales/_src/catalogo/video.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grabar, sql } from '../_video/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPROBANTE = path.resolve(here, '../dreamers/comprobante-ejemplo.png');
const ESCUELA = '25a123f0-6d57-48a4-9800-7b1531d61cd2';
const MATEO = '00000000-0000-4000-8c00-000000000101';

sql(`begin;
     set local session_replication_role = replica;
     update school_settings set merchandise_enabled=true, tournament_charges_enabled=true where school_id='${ESCUELA}';
     commit;
     delete from payments where child_id='${MATEO}' and coalesce(payment_category,'') <> 'mensualidad';
     delete from school_merchandise_items where school_id='${ESCUELA}';
     delete from school_tournament_items where school_id='${ESCUELA}';`);

const dlg = (page) => page.locator('[role="dialog"]').last();
const escribir = async (ui, loc, texto) => {
  await ui.clic(loc);
  await loc.first().fill('');
  await ui.page.keyboard.type(texto, { delay: 60 });
};

await grabar({
  nombre: 'catalogo-articulos-y-cobros-sueltos',
  usuario: 'admin.campestre',
  inicio: '/payments-automation?tab=config',
  esperar: 'Catálogo de artículos deportivos',
  almacenamiento: { 'sportmaps:cobros-y-pagos': 'on' }, // como en producción
  trabajo: path.join(here, 'video-raw'),
  pasos: [
    {
      dice: 'Además de la mensualidad, la escuela puede venderles a las familias artículos deportivos, y cobros sueltos como torneos, clases extra o viajes.',
      hace: async (ui) => {
        await ui.page.getByText('Catálogo de artículos deportivos').first().scrollIntoViewIfNeeded();
        await ui.mover(ui.page.getByText('Catálogo de artículos deportivos'));
      },
    },
    {
      dice: 'Se configuran en Pagos, pestaña Config. SportMaps activa cada catálogo, y desde ahí el contenido lo manejas tú.',
      hace: (ui) => ui.mover(ui.page.getByRole('tab', { name: 'Config' }).or(ui.page.getByText('Config', { exact: true }))),
    },
    {
      dice: 'En el catálogo de artículos, agrega cada uno con su nombre, su precio y, si aplica, las tallas.',
      hace: async (ui) => {
        await escribir(ui, ui.page.getByPlaceholder('Nombre').nth(0), 'Camiseta oficial');
        await escribir(ui, ui.page.getByPlaceholder('Precio (COP)').nth(0), '60000');
        await escribir(ui, ui.page.getByPlaceholder('Tallas, ej. S, M, L (opcional)'), 'S, M, L');
        await ui.clic(ui.page.getByRole('button', { name: 'Agregar' }).nth(0));
      },
    },
    {
      dice: 'En Cobros sueltos registras torneos, clases extra, vacacionales o viajes, con su precio y, si quieres, cupos y fechas.',
      hace: async (ui) => {
        await ui.page.getByText('Cobros sueltos').first().scrollIntoViewIfNeeded();
        await escribir(ui, ui.page.getByPlaceholder('Nombre').nth(1), 'Torneo Interclubes');
        await escribir(ui, ui.page.getByPlaceholder('Precio (COP)').nth(1), '50000');
        await ui.mover(ui.page.locator('select').first());
        await ui.clic(ui.page.getByRole('button', { name: 'Agregar' }).nth(1));
      },
    },
    {
      dice: 'Ahora, del lado de la familia. En Mis Pagos toca Nuevo Pago, y elige al hijo.',
      hace: async (ui) => {
        await ui.entrarComo('padre.campestre', '/my-payments', 'Mis Pagos');
        await ui.clic(ui.page.getByRole('button', { name: 'Nuevo Pago' }));
        await ui.clic(ui.page.getByRole('button', { name: /Mateo Gómez Fútbol/ }));
      },
    },
    {
      dice: 'En Tipo de pago aparecen Artículos deportivos y Torneos, junto a la mensualidad.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByRole('combobox').first());
        await ui.sleep(500);
        await ui.mover(ui.page.getByRole('option', { name: 'Torneos' }));
        await ui.sleep(700);
        await ui.clic(ui.page.getByRole('option', { name: 'Artículos Deportivos' }));
      },
    },
    {
      dice: 'Elige el artículo, la talla y la cantidad. El subtotal se calcula solo.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByRole('button', { name: /Camiseta oficial/ }));
        await ui.sleep(500);
        await ui.clic(dlg(ui.page).getByRole('button', { name: '+' }));
        await ui.mover(dlg(ui.page).getByText(/Subtotal artículos/i));
      },
    },
    {
      dice: 'Y paga como siempre: en línea, o por transferencia, subiendo el comprobante.',
      hace: async (ui) => {
        await ui.clic(dlg(ui.page).getByText('Transferencia / Nequi / Daviplata'));
        await dlg(ui.page).locator('input[type="file"]').setInputFiles(COMPROBANTE);
        await ui.sleep(1500);
        await ui.clic(dlg(ui.page).getByRole('button', { name: /^Pagar \$/ }));
        await ui.sleep(2500);
      },
    },
    {
      dice: 'La compra le llega a la escuela, a Cobros por Aprobar, como un cobro aparte de la mensualidad.',
      hace: async (ui) => {
        await ui.entrarComo('admin.campestre', '/payments-automation', 'Cobros por Aprobar');
        // La fila de una compra no muestra el concepto (hallazgo 2026-10-21): se ubica por el monto.
        await ui.mover(ui.page.locator('tr', { hasText: /120\.000/ }).first());
      },
    },
    {
      dice: 'Al tocar Aprobar ves el detalle exacto de lo que se compró. Revisa el comprobante, confirma que el pago está completo, y aprueba.',
      hace: async (ui) => {
        const fila = ui.page.locator('tr', { hasText: /120\.000/ }).first();
        await ui.clic(fila.getByRole('button', { name: /Aprobar/ }));
        const d = ui.page.locator('[role="dialog"], [role="alertdialog"]').last();
        await ui.mover(d.getByText(/Artículos Deportivos: Camiseta/));
        await ui.sleep(1500);
        await ui.clic(d.getByText(/Verifiqué que el pago/));
        await ui.clic(d.getByRole('button', { name: /^Aprobar \$/ }));
      },
    },
    {
      dice: 'Cada compra es un cobro aparte: no se mezcla con la mensualidad, y la familia puede comprar las veces que quiera.',
      pausa: 1200,
    },
  ],
});
