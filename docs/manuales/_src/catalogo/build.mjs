// Arma catalogo-articulos-y-torneos (academias + interno, HTML + PDF) desde las capturas
// de capture.mjs. Reemplaza la versión del 2026-09-08 (catálogo «Torneos» → «Cobros sueltos»,
// vínculo con torneos reales, verificación al aprobar).
//
//   node docs/manuales/_src/catalogo/build.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearPiezas, construir, step, chapter, callout, interno, faq, lista } from '../_pdf/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { shot, duo } = crearPiezas(path.join(here, 'shots'), {
  'c01-config': { left: 560, top: 660, width: 2270, height: 820 },
  'c02-articulos': { height: 830 },
  'c04-tipo-de-pago': { left: 992, top: 90, width: 896, height: 720 },
  'c06-cobros-por-aprobar': { left: 560, top: 789, width: 2270, height: 940 },
});

await construir({
  archivo: 'catalogo-articulos-y-torneos',
  titulo: 'Artículos Deportivos y Cobros Sueltos',
  sub: 'Dos catálogos para venderles a las familias lo que no es mensualidad: uniformes y balones, o torneos, clases extra, vacacionales y viajes. Cada compra es un cobro nuevo e independiente, nunca una suscripción.',
  pills: ['Rol: Dueño / Administrador', 'La familia paga desde Mis Pagos', 'Actualizado 2026-10-22'],
  paginas: [
    [
      chapter(1, 'Qué es', 'Pagos → Config'),
      `<p style="font-size:13.5px;line-height:1.55">Cada catálogo es una lista de ítems con nombre y precio que la familia compra desde el mismo formulario con el que paga la mensualidad. Cada compra genera <b>su propio cobro</b>: nunca se mezcla con la cuota mensual.</p>`,
      `<table class="tbl"><tr><th>Catálogo</th><th>Qué vende</th><th>La familia lo ve como</th></tr>
        <tr><td><b>Artículos deportivos</b></td><td>Uniformes, balones, guayos, accesorios. Admite tallas e imagen.</td><td>«Artículos Deportivos»</td></tr>
        <tr><td><b>Cobros sueltos</b></td><td>Torneos, clases extra o de perfeccionamiento, vacacionales y viajes. Admite cupos, fechas y foto.</td><td>«Torneos»</td></tr></table>`,
      callout('tip', 'Quién lo activa', 'Los dos catálogos nacen apagados y los enciende el equipo de SportMaps: escríbele a tu contacto pidiendo «Artículos deportivos» y/o «Cobros sueltos». Una vez activos, el contenido (ítems, precios, tallas) lo manejas tú, sin pasar por soporte. Si no están activos, la tarjeta dice «SportMaps todavía no habilitó este catálogo para tu escuela».'),
      interno('Interruptores', '<code>school_settings.merchandise_enabled</code> y <code>tournament_charges_enabled</code>. Un trigger solo deja cambiarlos a super admin. La escuela ve «Cobros sueltos» y la familia ve «Torneos» para el mismo catálogo: diferencia de nombres pendiente de unificar.'),
    ],
    [
      chapter(2, 'Dónde se configuran', 'Pagos → pestaña Config'),
      step(1, 'Abre Config en Gestión de Pagos', `<p>En el menú <b>Finanzas → Pagos</b>, entra a la pestaña <b>Config</b>, la última. Ahí, junto a <b>Reglas de Cobro</b>, están las tarjetas de los dos catálogos.</p>
        ${await shot('c01-config', 'Pagos → Config: Reglas de Cobro a la izquierda y el catálogo de artículos a la derecha', 300)}`),
      step(2, 'Carga tus artículos', `<p>Completa <b>nombre</b>, <b>precio</b> y, si aplica, las <b>tallas</b> separadas por coma y una <b>imagen</b> (enlace https://). <b>+ Agregar</b> lo suma de inmediato a lo que ven las familias.</p>
        ${await shot('c02-articulos', 'Catálogo de artículos: cada ítem con su precio, sus tallas y su estado', 330)}`),
    ],
    [
      chapter(3, 'Cobros sueltos', 'Pagos → Config → Cobros sueltos'),
      step(3, 'Agrega torneos, clases extra, vacacionales o viajes', `<p>Nombre, precio y <b>tipo</b> son lo único obligatorio. Si quieres, agrega <b>cupos</b>, una <b>descripción corta</b>, <b>fechas</b> de inicio y fin, una <b>foto</b>, y si <b>se cobra por deportista</b> (encendido por defecto).</p>
        ${await shot('c03-cobros-sueltos', 'Cobros sueltos: el ítem creado y el formulario con todos sus campos', 520)}`),
      callout('tip', 'Vender por WhatsApp', 'Con este interruptor, Mapi (el asistente de WhatsApp de la escuela) responde precio, fecha y cupos de estos servicios y, a las familias identificadas, les manda el link de pago con una hora para pagar.'),
    ],
    [
      step(4, 'Si es un torneo de la plataforma: vincúlalo', `<p>Cuando la escuela ya tiene el torneo creado en SportMaps, el cobro suelto se puede <b>vincular</b> a ese torneo («Vincular…», o «Crear en Torneos» para crearlo desde aquí). Un cobro vinculado se paga <b>al inscribirse al torneo</b>: deja de aparecer en el formulario de pago de la familia y en el catálogo de WhatsApp, así nunca se cobra dos veces. «Ver torneo» lo abre y se puede desvincular.</p>`),
      callout('warn', 'Inactivo no es borrado', 'El ícono junto al lápiz desactiva un ítem sin borrar su historial: deja de ofrecerse a las familias, pero las compras ya hechas siguen en tus reportes. Con el lápiz cambias precio o datos; el cambio aplica a las compras siguientes.'),
      interno('Vínculo con torneo', 'Migración <code>20261020122827</code>: <code>school_tournament_items.event_id</code> (1 ítem por torneo, misma escuela, con guard e índice único). Las capturas no muestran «Vincular…» porque la escuela del gemelo no tiene torneos creados.'),
      chapter(4, 'Así compra la familia', 'Mis Pagos → Nuevo Pago'),
      step(5, 'Elige el tipo de pago', `<p>En <b>Mis Pagos → Nuevo Pago</b>, la familia elige al hijo y despliega <b>Tipo de pago</b>: ahí aparecen <b>Artículos Deportivos</b> y <b>Torneos</b> junto a la mensualidad, solo si el catálogo tiene al menos un ítem activo.</p>
        ${await shot('c04-tipo-de-pago', 'Tipo de pago: Mensualidad, Inscripción, Artículos Deportivos y Torneos', 250)}`),
    ],
    [
      step(6, 'Marca los ítems y paga', `<p>Marca uno o varios ítems, elige la <b>talla</b> y la <b>cantidad</b>, y ve el <b>subtotal</b> en tiempo real. Paga como siempre: en línea con Wompi, o por transferencia subiendo el comprobante.</p>
        ${await shot('c05-articulos-elegidos', 'Dos camisetas talla S: el subtotal se calcula solo', 560)}`),
      callout('tip', '¿Se puede volver a comprar?', 'Sí, sin límite. Cada compra genera un cobro nuevo e independiente, aunque la mensualidad esté pendiente o haya otro comprobante en revisión.'),
      interno('Texto', 'El formulario dice «Elegí los artículos» (voseo); el resto de la app tutea.'),
    ],
    [
      chapter(5, 'Aprueba la compra', 'Pagos → Cobros → Cobros por Aprobar'),
      step(7, 'Llega a Cobros por Aprobar', `<p>Si la familia pagó por transferencia, la compra entra a <b>Cobros por Aprobar</b> como un cobro aparte de la mensualidad. Si pagó en línea, se aprueba sola.</p>
        ${await shot('c06-cobros-por-aprobar', 'La compra (abajo, $120.000) junto a una mensualidad por validar', 260)}`),
      interno('Lista sin concepto', 'En Cobros por Aprobar la fila de una compra no muestra qué se compró (la de la mensualidad sí: «Mensualidad Fútbol · Septiembre 2026»). El detalle solo aparece al abrir «Aprobar». Además las etiquetas de la columna Deportista/Programa se montan a 1440 px.'),
      step(8, 'Revisa y aprueba', `<p>Al tocar <b>Aprobar</b> ves el concepto exacto (por ejemplo «Artículos Deportivos: Camiseta oficial talla S x2») y el valor esperado. Si SportMaps no alcanzó a leer el comprobante, ábrelo con <b>Ver comprobante</b>, verifica el valor y marca <b>«Verifiqué que el pago está completo»</b>: solo entonces se habilita el botón. Si el pago fue menor, no lo apruebes: usa <b>Glosar</b> para pedirle el resto a la familia.</p>`),
    ],
    [
      `${await shot('c07-aprobar', 'Aprobar cobro: concepto, valor esperado y la verificación del comprobante', 470)}`,
      faq([
        ['¿Puedo cambiar un precio después de crearlo?', 'Sí, con el lápiz junto al ítem. Aplica a las próximas compras; no toca los cobros ya generados.'],
        ['¿Se mezcla con la mensualidad en mis reportes?', 'No. Cada venta queda como una fila separada, aparte de mensualidad e inscripción.'],
        ['¿Puedo tener un catálogo activo y el otro apagado?', 'Sí, cada uno se activa por separado.'],
        ['¿Cómo cobro un torneo sin que lo paguen dos veces?', 'Vincula el cobro suelto al torneo: se paga al inscribirse y desaparece del formulario de pago de la familia.'],
      ]),
    ],
  ],
});
