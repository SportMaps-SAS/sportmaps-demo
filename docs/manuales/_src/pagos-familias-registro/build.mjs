// Arma los dos manuales de pagos (academias + interno, HTML + PDF) desde las capturas
// de capture.mjs. Mismo sistema visual que tomar-asistencia (reusa su <head>).
//
//   node docs/manuales/_src/pagos-familias-registro/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const MAN = path.join(repo, 'docs/manuales');
const { chromium } = createRequire(path.join(repo, 'frontend', 'package.json'))('playwright');
const sharp = createRequire(path.join(repo, 'bff', 'package.json'))('sharp');
const SHOTS = path.join(here, 'shots');
const FECHA = '2026-10-21';

// ── Imágenes ──────────────────────────────────────────────────────────────────
// Recortes en píxeles de la captura (dpr 2, ventana 1440 de ancho → 2880 px).
const RECORTES = {
  'pp01-dashboard-banner': { left: 540, top: 200, width: 2340, height: 800 },
  'pp02-mis-pagos': { left: 760, top: 170, width: 2120, height: 1700 },
  'pp07-por-validar': { left: 540, top: 1100, width: 2340, height: 760 },
  'pp08-estado-de-cuenta': { left: 820, top: 200, width: 1740, height: 1020 },
  'rp01-gestion-de-pagos': { left: 540, top: 160, width: 2340, height: 620 },
  'rp03-buscar-deportista': { left: 920, top: 50, width: 1060, height: 1110 },
  'rp07-confirmado': { left: 540, top: 760, width: 2340, height: 1230 },
};
async function img(id) {
  const file = path.join(SHOTS, id + '.png');
  if (!fs.existsSync(file)) throw new Error(`Falta la captura ${id} — correr capture.mjs`);
  let buf = fs.readFileSync(file);
  if (RECORTES[id]) buf = await sharp(buf).extract(RECORTES[id]).png().toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

// ── Piezas de HTML ───────────────────────────────────────────────────────────
const shot = async (id, caption, h = 300) =>
  `<div class="shot-wrap"><img class="shot" style="max-height:${h}px" src="${await img(id)}" /><div class="shot-caption">${caption}</div></div>`;
const duo = async (a, ca, b, cb, h = 560) =>
  `<div class="duo"><div>${await shot(a, ca, h)}</div><div>${await shot(b, cb, h)}</div></div>`;
const step = (n, title, body) =>
  `<div class="step"><div class="step-head"><div class="step-badge">${n}</div><div class="step-title">${title}</div></div>${body}</div>`;
const chapter = (n, title, crumb) =>
  `<div class="chapter-head"><div class="chapter-badge">${n}</div><h2 class="chapter-title">${title}</h2></div>` +
  (crumb ? `<div class="breadcrumb">${crumb}</div>` : '') + '<hr class="chapter-rule" />';
const callout = (kind, tag, body) => `<div class="callout ${kind}"><span class="tag">${tag}</span>${body}</div>`;
const interno = (tag, body) => ({ interno: callout('internal', `INTERNO — ${tag}`, body) });
const faq = (items) => `<h3 style="font-size:20px;margin:0 0 14px;color:#123416">Preguntas frecuentes</h3>` +
  items.map(([q, a]) => `<p><b>${q}</b><br/>${a}</p>`).join('\n');

// Una página es una lista de bloques: string (va en las dos versiones) o {interno} (solo interna).
function pagina(bloques, ver) {
  return bloques.map((b) => (typeof b === 'string' ? b : ver === 'interno' ? b.interno : '')).join('\n');
}

function documento({ titulo, sub, pills, paginas }, ver) {
  const head = fs.readFileSync(path.join(MAN, 'academias/tomar-asistencia.html'), 'utf8').split('</head>')[0]
    .replace(/<title>[^<]*<\/title>/, `<title>SportMaps — ${titulo} (${ver === 'interno' ? 'Interno' : 'Academias'})</title>`)
    .replace('</style>', `.duo{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}.duo .shot{max-width:100%}\n</style>`);
  const total = paginas.length + 1;
  const pie = (n) => ver === 'interno'
    ? `<div class="footer internal-mark"><span>SportMaps · Uso interno</span><span>Página ${n} de ${total}</span></div>`
    : `<div class="footer"><span>SportMaps · Guía de uso</span><span>Página ${n} de ${total}</span></div>`;
  const portada = `<div class="page cover"><div class="cover-inner"><div><div class="logo"><span class="pin"></span>SportMaps</div></div><div>
    <div class="cover-eyebrow">${ver === 'interno' ? '<span class="dot"></span>Uso interno — no enviar a escuelas' : '<span class="dot" style="background:#4fd17a"></span>Guía de uso · Academias'}</div>
    <h1 class="cover-title">${titulo}</h1><p class="cover-sub">${sub}</p>
    <div class="pills">${pills.map((p) => `<span class="pill">${p}</span>`).join('')}</div></div>
    <div class="cover-footer">SportMaps © 2026${ver === 'interno' ? ' · Documento interno' : ''}</div></div></div>`;
  const cuerpo = paginas.map((p, i) => `<div class="page">${pagina(p, ver)}${pie(i + 2)}</div>`).join('\n');
  return `${head}</head><body>\n${portada}\n${cuerpo}\n</body></html>`;
}

// ── Manual 1: Cómo pagan los padres ───────────────────────────────────────────
const padres = {
  archivo: 'pagos-de-padres',
  titulo: 'Cómo Pagan los Padres',
  sub: 'La mensualidad y los demás cobros, pagados online o por transferencia desde la cuenta del padre, con validación de la escuela antes de darlos por buenos.',
  pills: ['Rol: Padre / Atleta', 'Online o transferencia', `Actualizado ${FECHA}`],
  paginas: [
    [
      chapter(1, 'Encuentra lo que tienes pendiente', 'Dashboard → banner de pagos'),
      step(1, 'El banner del inicio te lleva directo', `<p>Si hay cobros por pagar, el inicio muestra arriba un banner verde: <b>"Tienes N pagos pendientes · Toca para pagar ahora"</b>. Un toque y quedas en <b>Mis Pagos</b>. También puedes entrar desde el menú <b>Seguimiento → Pagos</b>.</p>
        ${await shot('pp01-dashboard-banner', 'El inicio del padre: banner de pagos pendientes y el contador "Pagos Pendientes"', 330)}`),
      callout('tip', 'Cada mes es un cobro aparte', 'La escuela genera un cobro por hijo y por mes. Si tienes meses atrasados, cada uno aparece por separado con su propio botón para pagar.'),
    ],
    [
      chapter(2, 'Mis Pagos', 'Seguimiento → Pagos'),
      step(2, 'Cada cobro tiene su botón PAGAR', `<p>Arriba ves el resumen (<b>Pendientes</b>, <b>Monto pendiente</b>, <b>Pagos realizados</b>) y abajo la lista de cobros con su estado. Cada cobro pendiente trae su propio botón <b>PAGAR</b>: no hace falta elegir nada más.</p>
        ${await shot('pp02-mis-pagos', 'Mis Pagos: resumen, estado de cuenta y la lista de cobros con su botón PAGAR', 520)}
        <p class="no-shot">El botón <b>Nuevo Pago</b> sigue disponible arriba a la derecha si prefieres elegir primero al hijo y el concepto.</p>`),
    ],
    [
      chapter(3, 'Elige cómo pagar', 'Mis Pagos → PAGAR'),
      step(3, 'Online o transferencia', `<p>El valor y el concepto ya vienen resueltos. Elige el método:</p>
        <ul style="font-size:13.5px;line-height:1.55;color:#33413a;margin:0 0 10px 18px;padding:0">
        <li><b>Pagar online (Wompi):</b> tarjeta, PSE o Nequi, con confirmación inmediata. Tiene un pequeño recargo que se muestra <b>antes</b> de pagar (valor, recargo y total).</li>
        <li><b>Transferencia / Nequi / Daviplata:</b> sin recargo; subes el comprobante y la escuela lo revisa.</li></ul>
        ${await duo('pp03-modal-wompi', 'Pago online: el recargo y el total, antes de continuar', 'pp04-modal-transferencia', 'Transferencia: los datos de la cuenta de la escuela', 520)}`),
      interno('Título del modal', 'El encabezado del modal ("Mensualidad Octubre 2026") sale del mes actual, no del cobro: al pagar un mes atrasado el concepto dice 09/2026 y el título dice octubre. Visto en el gemelo el 2026-10-21; pendiente de corregir en <code>PaymentCheckoutModal</code>.'),
    ],
    [
      chapter(4, 'Pagar por transferencia', 'Elige "Transferencia / Nequi / Daviplata"'),
      step(4, 'Transfiere y sube el comprobante', `<p>Se muestran los datos de la escuela (banco, número, Nequi, titular) con botón para <b>copiar</b>. Después de transferir, sube la foto o el PDF del comprobante (máximo 5 MB) y pulsa <b>"Pagar $ …"</b> para enviarlo.</p>
        ${await shot('pp05-comprobante-cargado', 'Comprobante cargado: SportMaps intenta leer el monto y el número de operación', 560)}`),
      callout('warn', 'No queda aprobado al instante', 'El comprobante entra como <b>"Por validar"</b> hasta que la escuela lo revisa. Si SportMaps no alcanza a leer el monto o el número de operación del comprobante, igual se envía: la escuela lo valida a mano.'),
    ],
    [
      chapter(5, 'Pagar online con Wompi', 'Elige "Pagar online (Wompi)"'),
      step(5, 'Tarjeta, PSE o Nequi, sin comprobante', `<p>Al confirmar se abre el pago seguro de Wompi en la misma pantalla. Completas el pago con tu método preferido y, si sale bien, el cobro queda <b>aprobado de inmediato</b>: la escuela no tiene que revisarlo.</p>`),
      callout('tip', 'El recargo lo ves antes de pagar', 'El total con recargo siempre aparece antes de continuar a Wompi. El recargo es el costo de la pasarela: la escuela recibe la mensualidad completa.'),
      callout('tip', 'Descuento por pronto pago', 'Si tu escuela lo activó, pagar en los primeros días desde que se generó el cobro aplica un descuento automático: verás el precio de lista tachado junto al precio final.'),
      chapter(6, 'Después de pagar', 'Mis Pagos'),
      step(6, 'Así queda cada cobro', `<p>Cada cobro muestra su estado: <b>Pendiente</b> (todavía sin pagar), <b>Por validar</b> (comprobante enviado, en revisión) o <b>Aprobado</b>. Con el comprobante enviado aparece <b>RECIBO</b> para verlo. Recibes una notificación y un correo apenas la escuela confirma.</p>
        ${await shot('pp07-por-validar', 'Septiembre "Por validar" (comprobante enviado) y octubre todavía pendiente', 250)}`),
      interno('Fechas', 'En el registro manual de la escuela, la lista de cobros muestra el vencimiento un día antes ("Vence 25 sep" para un <code>due_date</code> 2026-09-26): corrimiento de zona horaria al formatear la fecha.'),
    ],
    [
      step(7, 'Estado de cuenta por hijo', `<p>Desde <b>Mis Pagos</b>, el botón <b>"Estado de cuenta — (nombre)"</b> abre el resumen del hijo: lo facturado, lo cobrado, el saldo pendiente, la mora aplicada y el estado de cada mes. Se puede imprimir.</p>
        ${await shot('pp08-estado-de-cuenta', 'Estado de cuenta: totales y el detalle de los últimos 12 meses', 400)}`),
      interno('Débito automático', 'Mis Pagos ya tiene la tarjeta de <b>débito automático</b> (F3, 2026-10-07), pero no se documenta en esta guía: solo aparece si la escuela lo configuró y el cron de cobro sigue apagado hasta configurarlo. Documentarlo cuando haya una escuela usándolo.'),
    ],
    [
      faq([
        ['¿Puedo pagar antes de que se genere el cobro del mes?', 'No: el cobro tiene que existir primero. Si tu escuela genera los cobros automáticamente, aparecen a inicios de mes; si no, pídele que te genere el cobro o que registre tu pago.'],
        ['¿Puedo pagar varios meses de una vez?', 'Cada mes es un cobro independiente con su propio botón PAGAR. Págalos uno por uno; si pagaste varios en una sola transferencia, la escuela puede registrarlos todos juntos.'],
        ['¿Qué pasa si me equivoco de comprobante?', 'Avísale a la escuela: puede rechazar el comprobante incorrecto y dejarte subir uno nuevo.'],
        ['¿El recargo online se lo queda SportMaps?', 'No: es el costo de la pasarela de pagos y siempre se muestra antes de pagar. La escuela recibe la mensualidad completa.'],
        ['¿Puedo pedir factura electrónica?', 'Si tu escuela factura electrónicamente, en Mis Pagos aparece la pregunta "¿Quieres factura electrónica a tu nombre?". Respóndela una vez y queda guardada.'],
      ]),
    ],
  ],
};

// ── Manual 2: Registro de pago manual ─────────────────────────────────────────
const registro = {
  archivo: 'guia-registro-pagos-manual',
  titulo: 'Registro de Pago Manual',
  sub: 'Cuando un padre te paga en efectivo o por transferencia fuera de la app, regístralo tú mismo en segundos, uno o varios cobros a la vez, sin que el padre tenga que hacer nada.',
  pills: ['Rol: Owner / Admin de escuela', 'Efectivo o transferencia', `Actualizado ${FECHA}`],
  paginas: [
    [
      chapter(1, 'Para cuando el dinero ya lo tienes', 'Finanzas → Pagos'),
      `<p>Si un padre te pagó en persona (efectivo) o hizo una transferencia y te avisó por fuera de la app (por WhatsApp, por ejemplo), registra el pago tú mismo: el cobro queda <b>pagado</b>, el deportista sale de la cartera morosa y el padre recibe notificación y correo de confirmación.</p>`,
      callout('warn', 'No reemplaza el pago del padre', 'Es para cuando el dinero llegó por fuera de la app. Si el padre pagó online o subió su comprobante desde Mis Pagos, eso se aprueba en <b>Cobros por Aprobar</b>, no aquí.'),
      step(1, 'Abre el formulario', `<p>En <b>Gestión de Pagos</b>, el botón <b>"Registrar pago"</b> está arriba a la derecha.</p>
        ${await shot('rp01-gestion-de-pagos', 'Gestión de Pagos: el botón "Registrar pago" junto a Actualizar y Exportar Reporte', 230)}`),
    ],
    [
      chapter(2, 'Elige el método y al deportista', 'Registrar pago'),
      step(2, 'Efectivo o transferencia', `<p>El formulario abre en <b>Efectivo</b>. Cámbialo a <b>Transferencia</b> si así te pagaron.</p>`),
      step(3, 'Busca al deportista', `<p>Toca el campo <b>Deportista / Atleta</b> y escribe el nombre. Debajo de cada resultado aparece el nombre del acudiente, que ayuda a distinguir homónimos.</p>
        ${await duo('rp02-formulario', 'El formulario recién abierto', 'rp03-buscar-deportista', 'El buscador, con el acudiente debajo del nombre', 470)}`),
    ],
    [
      chapter(3, 'Dile a qué cobro aplica', 'Aplicar a · Mes que cubre'),
      step(4, 'Un cobro: elige cuál te pagaron', `<p>Al elegir al deportista aparece <b>Aplicar a</b>. Si ya tiene cobros pendientes, ábrelo y elige el cobro exacto que te pagaron: ese cobro pasa a pagado. Deja <b>"Nuevo cobro (sin asociar)"</b> solo si no había ningún cobro generado.</p>
        <p>En una mensualidad nueva, <b>Mes que cubre</b> es el mes que se está pagando, no la fecha en que entró la plata. El sistema sugiere el primer mes sin pagar; cámbialo si estás poniendo al día un mes atrasado.</p>`),
      callout('warn', 'Ojo con "Nuevo cobro"', 'Es la opción que viene seleccionada, y con ella el cobro pendiente <b>no</b> se marca como pagado. Si el mes que cubre ya tiene su cobro, el sistema rechaza el registro; con otro mes u otro concepto se crea un cobro aparte y el pendiente <b>sigue abierto</b> en la cartera. Si el cobro ya existía, elígelo en Aplicar a.'),
      `<div class="duo"><div>${await shot('rp04-aplicar-a-y-mes', 'Con el deportista elegido: Aplicar a, tipo de cobro y mes que cubre', 560)}</div><div>${await shot('rp05-varios-cobros', 'Varios cobros a la vez: se marcan y se ve el total', 560)}</div></div>`,
      interno('Campo duplicado', 'El formulario muestra <b>"Tipo de cobro" dos veces</b>: el bloque está duplicado tal cual en <code>RegisterCashPaymentModal.tsx</code> (≈ líneas 1161–1220). Es cosmético —los dos controlan el mismo estado— pero confunde. Borrar uno.'),
    ],
    [
      step(5, 'Varios cobros del mismo deportista', `<p>Si el padre te pagó más de un mes junto, pulsa <b>"Pagar varios cobros a la vez"</b>, marca los cobros (o <b>Seleccionar todos</b>) y revisa el <b>Total a registrar</b>. Cada cobro se registra por su propio valor, ya con descuento y mora.</p>`),
      callout('tip', 'Todo o nada', 'Los cobros marcados se registran juntos: si alguno falla, no se registra ninguno. Así nunca queda un mes pagado y el otro a medias.'),
      chapter(4, 'Si fue transferencia, adjunta el soporte', 'Opcional — no bloquea el registro'),
      step(6, 'Sube la captura que te mandaron', `<p>Con <b>Transferencia</b> aparece <b>Soporte de la transferencia (opcional)</b>: adjunta la foto del comprobante que el padre te envió, como respaldo. También puedes conciliar solo contra tu extracto bancario, sin la imagen. Termina con <b>Monto</b> y <b>Fecha del pago</b> y pulsa <b>Confirmar registro</b>.</p>
        ${await shot('rp06-transferencia-soporte', 'Transferencia con dos cobros marcados: soporte opcional, total y Confirmar registro', 470)}`),
    ],
    [
      chapter(5, 'Qué pasa al confirmar'),
      step(7, 'Todo queda al día en un clic', `<p>Aparece el aviso <b>"Pagos registrados"</b> con cuántos cobros y por cuánto quedaron pagados. Si aplicaste a cobros existentes, esos cobros pasan a <b>Pagado</b>; si registraste uno nuevo, se crea directamente como pagado. El padre recibe notificación y correo, y el pago queda en el historial financiero de la escuela.</p>
        ${await shot('rp07-confirmado', 'El aviso "Pagos registrados" (abajo a la derecha). Arriba, Cobros por Aprobar sigue con los comprobantes que subieron los padres', 330)}`),
      interno('Columna superpuesta', 'En <b>Cobros por Aprobar</b> (1440 px de ancho), las etiquetas de equipo, concepto y mes de la columna "Deportista / Programa" se montan una sobre otra. Se ve en esta captura.'),
      faq([
        ['¿Puedo registrar un pago parcial (abono)?', 'Este formulario registra el valor completo de cada cobro. Para abonos parciales usa la validación de comprobantes en Cobros por Aprobar, si tu escuela tiene abonos habilitados.'],
        ['¿Qué pasa si me equivoco de deportista o de monto?', 'Contacta a soporte SportMaps: un pago ya confirmado no se edita desde esta pantalla.'],
        ['¿El padre tiene que hacer algo?', 'No. Es un registro que hace la escuela; el padre solo recibe la confirmación.'],
      ]),
    ],
  ],
};

// ── Salida ───────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
// `registro` quedó obsoleto (2026-10-17: «Registrar pago» → «Cobros y pagos», manual en
// _src/cobros-y-pagos/). No se genera para no pisar guia-registro-pagos-manual.
for (const m of [padres]) {
  for (const ver of ['academias', 'interno']) {
    const html = path.join(MAN, ver, `${m.archivo}.html`);
    fs.writeFileSync(html, documento(m, ver));
    const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
    await page.goto(pathToFileURL(html).href, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const desborde = await page.evaluate(() => [...document.querySelectorAll('.page')]
      .map((el, i) => [i + 1, el.scrollHeight - el.clientHeight]).filter(([, d]) => d > 2));
    await page.pdf({ path: html.replace(/\.html$/, '.pdf'), width: '816px', height: '1056px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    console.log(`✅ ${ver}/${m.archivo}.pdf`, desborde.length ? `⚠️ desborde en páginas ${JSON.stringify(desborde)}` : '');
    await page.close();
  }
}
await browser.close();
