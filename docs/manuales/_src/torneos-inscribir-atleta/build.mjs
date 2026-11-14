// Manual «Torneos internos: inscribir atletas desde la escuela» en dos versiones
// (interno / academias), HTML + PDF, con capturas reales de ./shots/.
//   node docs/manuales/_src/torneos-inscribir-atleta/build.mjs
// Antes: capture.mjs, capture2.mjs, capture3.mjs y capture-vinculo.mjs (mismo directorio).
// Patrón: memoria feedback_pdf_manual_template.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const require = createRequire(path.join(repo, 'frontend', 'package.json'));
const { chromium } = require('playwright');
const SHOTS = path.join(here, 'shots');
const CROPS = path.join(SHOTS, 'crops');
const NAME = 'torneos-inscribir-atleta';
const OUT = { academias: path.join(repo, `docs/manuales/academias/${NAME}`), interno: path.join(repo, `docs/manuales/interno/${NAME}`) };
const SCALE = 2;

// Coordenadas en CSS px (viewport 1400×1000; las de «v-05» son de una tarjeta, no de página).
const CROP_DEFS = {
  'inscritos-vacio.png':  { src: 'a-05-inscritos-vacio.png',  x: 385, y: 100, w: 890, h: 340 },
  'inscritos-gratis.png': { src: 'a-10-inscritos-lista.png',  x: 385, y: 100, w: 890, h: 480 },
  'inscritos-costo.png':  { src: 'b-07-inscritos-lista.png',  x: 385, y: 100, w: 890, h: 480 },
  // Estas dos salen de capture4.mjs (viewport 1600×1000, 2026-10-27).
  'categorias-gratis.png':{ src: 'a-04-categorias.png',       x: 490, y: 108, w: 876, h: 720 },
  'categorias-costo.png': { src: 'c-07-categorias-fases.png', x: 490, y: 108, w: 876, h: 750 },
  'aviso-costo.png':      { src: 'b-06-inscrito-con-cobro.png', x: 998, y: 873, w: 384, h: 109 },
  'aviso-gratis.png':     { src: 'a-07-inscrito-aviso.png',   x: 998, y: 873, w: 384, h: 109 },
  'aviso-ya.png':         { src: 'a-08-ya-inscrito.png',      x: 998, y: 900, w: 384, h: 82 },
  'aviso-adulto.png':     { src: 'n-02-adulto-inscrito.png',  x: 998, y: 873, w: 384, h: 109 },
  'catalogo-items.png':   { src: 'v-05-catalogo-ajustado.png', x: 25, y: 230, w: 490, h: 400 },
  'catalogo-vinculado.png': { src: 'v-04-catalogo-vinculado.png', x: 300, y: 528, w: 495, h: 108 },
  'form-prellenado.png':  { src: 'v-02-crear-desde-cobro.png', x: 455, y: 68, w: 745, h: 560 },
};

async function makeCrops(browser) {
  fs.mkdirSync(CROPS, { recursive: true });
  const page = await browser.newPage();
  for (const [out, def] of Object.entries(CROP_DEFS)) {
    const src = path.join(SHOTS, def.src);
    if (!fs.existsSync(src)) throw new Error(`Falta la captura ${def.src}`);
    const b64 = fs.readFileSync(src).toString('base64');
    const cropped = await page.evaluate(async ([b64, d, s]) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = d.w * s; c.height = d.h * s;
      c.getContext('2d').drawImage(img, d.x * s, d.y * s, d.w * s, d.h * s, 0, 0, d.w * s, d.h * s);
      return c.toDataURL('image/png').split(',')[1];
    }, [b64, def, SCALE]);
    fs.writeFileSync(path.join(CROPS, out), Buffer.from(cropped, 'base64'));
  }
  await page.close();
}

function img(file, caption, width) {
  const fp = fs.existsSync(path.join(CROPS, file)) ? path.join(CROPS, file) : path.join(SHOTS, file);
  if (!fs.existsSync(fp)) throw new Error(`Falta ${file}`);
  const b64 = fs.readFileSync(fp).toString('base64');
  return `<div class="shot-wrap"><img class="shot" style="width:${width}px;max-height:none" src="data:image/png;base64,${b64}" alt="${caption}"/>` +
    (caption ? `<div class="shot-caption">${caption}</div>` : '') + `</div>`;
}
const step = (n, title, body, pic = '') => `<div class="step"><div class="step-head"><div class="step-badge">${n}</div><div class="step-title">${title}</div></div>${body}${pic}</div>`;
const p = (html, cls = '') => `<p${cls ? ` class="${cls}"` : ''}>${html}</p>`;
const warn = (tag, html) => `<div class="callout warn"><span class="tag">${tag}</span>${html}</div>`;
const tip = (tag, html) => `<div class="callout tip"><span class="tag">${tag}</span>${html}</div>`;
const internal = (html) => `<div class="callout internal"><span class="tag">🔒 Interno</span>${html}</div>`;
const chapter = (n, title, crumb, intro) =>
  `<div class="chapter-head"><div class="chapter-badge">${n}</div><h2 class="chapter-title">${title}</h2></div>` +
  `<div class="breadcrumb">${crumb}</div><hr class="chapter-rule" />${intro ? p(intro) : ''}`;

function pages(isInternal) {
  const I = (html) => (isInternal ? internal(html) : '');
  const pgs = [];

  // ── Cap. 1 ──
  pgs.push(
    chapter(1, 'Qué es y qué necesitas', 'Menú lateral → Gestión deportiva → Mis Torneos',
      'En un <b>torneo interno</b> compiten solo los equipos de tu escuela. Con <b>Inscribir atleta</b> tú mismo anotas a un deportista —un <b>hijo</b> o un <b>atleta adulto</b>— sin esperar a que lo haga desde la app. La inscripción queda <b>confirmada al instante</b> y se le avisa a la familia (o al propio atleta adulto).') +
    `<table class="tbl"><tr><th>Requisito</th><th>Detalle</th></tr>
      <tr><td><b>Módulo de Torneos activo</b></td><td>Sin él, «Crear torneo» muestra «Módulo de Torneos no activo». Se activa desde Mi Plan.</td></tr>
      <tr><td><b>Ser owner o administrador</b></td><td>El entrenador no puede inscribir: es una decisión de la administración.</td></tr>
      <tr><td><b>Torneo interno y publicado</b></td><td>El botón está apagado mientras el torneo es borrador. En torneos externos (contra otras academias) se usa otro flujo, por delegaciones.</td></tr>
      <tr><td><b>Al menos una categoría</b></td><td>El deportista se inscribe <b>en una categoría</b> del torneo.</td></tr>
      <tr><td><b>Deportistas activos de tu escuela</b></td><td>Aparecen los hijos y los atletas adultos activos registrados en tu escuela.</td></tr></table>` +
    tip('Gratis o con costo', 'Cuando creas el torneo eliges si <b>tiene costo o es gratis</b>. Si es gratis, inscribir no genera ningún cobro. Si tiene costo, cada inscripción crea un cobro pendiente: al acudiente en el caso de un hijo, o a nombre del propio atleta si es adulto.') +
    I('El gate de la RPC es <code>user_admin_school_ids()</code> (sin coaches). Hijo = <code>children</code> (<code>p_child_id</code>); adulto = <code>school_members</code> con <code>role = athlete</code> y <code>status = active</code> (<code>p_athlete_user_id</code>, firma de 4 args desde la mig. <code>20261020113208</code>). Besser: addon <code>tournaments</code> de cortesía desde el 2026-10-20 (<code>metadata.via = cortesia_besser_2026_10_20</code>, precio 0); sin él, <code>has_tournaments</code> es false y el BFF devuelve 403.')
  );

  // ── Cap. 2 ──
  pgs.push(
    chapter(2, 'Preparar el torneo', 'Mis Torneos → Crear torneo', 'El modal solo funciona si el torneo ya está publicado. Estos son los pasos previos. (Si ya tienes el cobro creado en el catálogo, salta al capítulo 3.)') +
    step(1, 'Crear el torneo y elegir «Interno»',
      p('En <b>Alcance</b> elige <b>Interno (mis propios equipos)</b>. La visibilidad pasa sola a <b>Solo mi escuela</b>. Aparece el bloque <b>Cobro de la inscripción</b>.'),
      img('c-02-tipo-interno.png', 'Tipo de torneo: alcance Interno, visibilidad «Solo mi escuela».', 430)) +
    step(2, 'Decidir si tiene costo',
      p('El interruptor <b>El torneo tiene costo</b> viene encendido. Si lo dejas así, marca los <b>medios de pago</b> que aceptas (solo aparecen los que ya configuraste en los datos de pago; <b>Efectivo</b> siempre está) y escribe el <b>valor de la inscripción</b>.'),
      img('c-04-cobro-con-costo.png', 'Torneo con costo: medios de pago y valor de la inscripción.', 460))
  );
  pgs.push(
    step(3, 'Si es gratis, apaga el interruptor',
      p('Al apagarlo desaparecen los medios de pago y el valor: no se pide nada de eso y la inscripción nunca generará cobro.'),
      img('c-05-cobro-gratis.png', 'Torneo gratis: sin medios de pago ni valor.', 460)) +
    step(4, 'Completar la información y crear',
      p('Título, deporte, fecha, <b>cierre de inscripciones</b> (opcional), <b>cupo</b> (opcional), hora de inicio, dirección y ciudad son lo mínimo. Se crea como <b>borrador</b>.', 'no-shot')) +
    warn('Cupo y tarifa', 'Si pones <b>cupo</b>, no se podrá inscribir a más deportistas que ese número (ni tú ni las familias): sube el cupo en la pestaña <b>Info</b> si hace falta. La <b>tarifa</b> vale hasta el cierre de inscripciones (o la fecha del torneo): pasada esa fecha <b>las familias ya no pueden inscribirse solas</b>, pero <b>tú sí puedes seguir inscribiendo</b> (se usa la última tarifa configurada).')
  );
  pgs.push(
    step(5, 'Agregar la categoría y publicar',
      p('En <b>Categorías y Precios</b> pulsa <b>Agregar</b>. Cada campo dice qué va: <b>Grupo</b> (deja «General»), <b>Categoría</b> (por ejemplo «Sub 12»), <b>Rama</b> y, si quieres, la <b>edad mínima y máxima</b>. Pulsa <b>Guardar categorías y precios</b> y después <b>Publicar</b>. Si el torneo es gratis, la pestaña te lo recuerda: no necesita precio.'),
      img('categorias-gratis.png', 'Torneo gratis en borrador: una categoría con sus campos y el botón Publicar arriba. La franja amarilla avisa qué falta.', 405)) +
    p('Con costo, la pestaña muestra además la <b>fase de precio</b>: nombre, <b>válida hasta</b> y <b>valor por atleta</b> (al escribirlo ves el valor en pesos). Guarda antes de publicar.', 'no-shot') +
    img('categorias-costo.png', 'Torneo con costo: categoría Sub 12 y fase «Inscripción» de $50.000 vigente hasta el 14 de noviembre.', 405)
  );

  // ── Cap. 3 (catálogo) ──
  pgs.push(
    chapter(3, 'Si el cobro ya está en el catálogo', 'Pagos → Config → Cobros sueltos', 'Si tu escuela ya cargó un cobro de torneo en el catálogo («Torneo Interclubes — $50.000»), no lo crees dos veces: <b>conviértelo en un torneo real</b> y de ahí en adelante solo inscribes.') +
    step(1, 'Ubicar el cobro en «Cobros sueltos»',
      p('Cada cobro de tipo <b>Torneo</b> muestra dos acciones: <b>Crear en Torneos</b> y <b>Vincular…</b>.'),
      img('catalogo-items.png', 'Catálogo «Cobros sueltos»: cada cobro de torneo ofrece «Crear en Torneos» o «Vincular…».', 300)) +
    step(2, 'Crear el torneo desde el cobro',
      p('<b>Crear en Torneos</b> abre «Crear torneo» ya <b>prellenado</b> con el nombre, el valor, el cupo y la fecha del cobro, como torneo <b>interno</b>. Completa lo que falta (deporte, dirección, ciudad, medios de pago) y guarda: el torneo queda como borrador y <b>vinculado al cobro</b>.'),
      img('form-prellenado.png', 'Formulario prellenado desde el cobro: valor y título vienen del catálogo.', 290))
  );
  pgs.push(
    step(3, 'O vincularlo a un torneo que ya existe',
      p('Si el torneo ya está creado, abre <b>Vincular…</b> en el cobro y elige el torneo. Solo aparecen torneos <b>internos</b> de tu escuela que todavía no tengan un cobro vinculado: <b>un torneo = un cobro</b>.')) +
    step(4, 'Qué significa «vinculado»',
      p('El cobro muestra la etiqueta <b>Torneo vinculado</b> y el botón <b>Ver torneo</b>. Desde ese momento <b>ya no se vende como cobro suelto</b>: sale de la lista de pago del padre y de lo que ofrece el asistente por WhatsApp. El cobro de ese torneo nace <b>cuando inscribes</b> al deportista (tú con «Inscribir atleta» o su familia desde la página del torneo), una sola vez. Así nadie paga dos veces.'),
      img('catalogo-vinculado.png', 'Cobro vinculado: etiqueta «Torneo vinculado», «Ver torneo» y el botón para desvincular.', 480)) +
    tip('Desvincular', 'El ícono de cadena rota devuelve el cobro a su estado anterior (cobro suelto). No borra el torneo.') +
    warn('Antes de vincular un cobro que ya vendiste', 'Si una familia ya pagó ese cobro como cobro suelto, ese pago <b>no se convierte en inscripción</b>: queda como pago suelto. Para esa familia, inscribe al deportista en el torneo y revisa que no se le cobre dos veces.') +
    warn('El valor se copia una vez', 'Al crear el torneo desde el cobro, el valor pasa al torneo. Si después cambias el valor en el catálogo, <b>no</b> cambia en el torneo (y viceversa): la tarifa del torneo se edita en «Categorías y Precios».')
  );

  // ── Cap. 4 (modal) ──
  pgs.push(
    chapter(4, 'El modal «Inscribir atleta», paso a paso', 'Mis Torneos → (tu torneo) → pestaña Inscritos → Inscribir atleta', '') +
    step(1, 'Abrir el modal',
      p('Entra al torneo y abre la pestaña <b>Inscritos</b>. Arriba a la derecha está el botón verde <b>Inscribir atleta</b>. Si el torneo sigue en borrador el botón está apagado y la pantalla dice «Publica el torneo para poder inscribir atletas».'),
      img('inscritos-vacio.png', 'Pestaña Inscritos de un torneo publicado, todavía sin inscritos.', 400)) +
    step(2, 'Leer el encabezado del modal',
      p('Te recuerda lo que va a pasar. En un torneo <b>gratis</b> dice «El torneo es gratis: no se cobra». En uno <b>con costo</b> dice «Se crea el cobro al acudiente». Si el único medio del torneo es efectivo, añade: «Solo se acepta efectivo: cuando paguen en la escuela, regístralo en Pagos».'),
      img('n-04-modal-solo-efectivo.png', 'Torneo con costo y solo efectivo: el encabezado recuerda registrar el pago en Pagos.', 290))
  );
  pgs.push(
    step(3, 'Elegir la categoría',
      p('Por defecto viene la primera categoría del torneo. Si hay varias, cámbiala antes de inscribir: <b>cada clic en «Inscribir» usa la categoría que esté elegida en ese momento</b>.', 'no-shot')) +
    step(4, 'Buscar al deportista',
      p('La lista mezcla <b>hijos</b> y <b>atletas adultos</b> (estos llevan la etiqueta <b>Adulto</b>). Escribe parte del nombre en <b>Buscar atleta</b>; no importan las tildes ni las mayúsculas. Se muestran hasta 50 coincidencias. Si no hay ninguna, el modal dice «No hay atletas que coincidan».'),
      img('n-01-modal-ya-inscrito-adultos.png', 'Lista del modal: «Ya inscrito en esta categoría» (botón apagado) y la etiqueta «Adulto».', 290)) +
    I('Se leen los primeros 500 hijos activos y los adultos activos de la escuela (<code>school_members</code> + <code>profiles</code>, sin JOIN directo porque <code>profile_id</code> apunta a <code>auth.users</code>) y se filtra en el navegador. Con 500 hijos o más la lista queda «truncada»: el modal pide al menos 2 letras y la búsqueda de hijos va al servidor (<code>ilike</code>, 50 filas).')
  );
  pgs.push(
    step(5, 'Pulsar «Inscribir»',
      p('El botón de esa fila dice «Inscribiendo…» unos instantes y aparece un aviso abajo a la derecha. El modal <b>se queda abierto</b> para que inscribas a varios seguidos; ciérralo con la <b>X</b> cuando termines.'),
      img('aviso-gratis.png', 'Hijo en torneo gratis: «quedó inscrito. Se le avisó a la familia».', 360) +
      img('aviso-costo.png', 'Hijo en torneo con costo: además «se creó el cobro al acudiente».', 360) +
      img('aviso-adulto.png', 'Atleta adulto: el aviso y el cobro van al propio atleta.', 360)) +
    step(6, 'Quien ya está inscrito queda marcado',
      p('Tras inscribir, el deportista pasa a mostrar <b>«Ya inscrito en esta categoría»</b> y su botón se apaga (dice «Inscrito»). Si lo intentas de nuevo desde otra pantalla, no se duplica nada: aparece «Ya estaba inscrito» y no se vuelve a avisar ni a cobrar.'),
      img('aviso-ya.png', 'Aviso al repetir una inscripción ya hecha.', 360))
  );
  pgs.push(
    step(7, 'Cuando el deportista no tiene a quién cobrarle',
      p('Un cobro necesita pagador. Si es un <b>hijo sin acudiente</b> asignado y el torneo tiene costo, su botón queda <b>apagado</b> con la etiqueta ámbar <b>«Sin acudiente: asígnalo primero»</b>: asígnale el acudiente desde su ficha en Deportistas y vuelve a abrir el modal. En un torneo <b>gratis</b> no hace falta acudiente. Un <b>atleta adulto</b> siempre puede inscribirse: él mismo es el pagador.', 'no-shot')) +
    step(8, 'Si el torneo llegó a su cupo',
      p('Cuando el número de inscritos iguala el cupo, el modal responde «El torneo llegó a su cupo (N). Sube el cupo en la pestaña Info para inscribir a más». Sube el cupo en <b>Info</b> y guarda. Repetir una inscripción ya hecha no cuenta contra el cupo.', 'no-shot')) +
    step(9, 'Revisar el resultado en la pestaña Inscritos',
      p('Cada inscrito aparece bajo su categoría, en «Sin equipo», con una etiqueta de pago: <b>Sin cobro</b> (torneo gratis), <b>Pendiente</b> (cobro creado, sin pagar) o <b>Pagado</b>.'),
      img('inscritos-gratis.png', 'Torneo gratis: el inscrito queda «Sin cobro».', 440) +
      img('inscritos-costo.png', 'Torneo con costo: el inscrito queda «Pendiente» de pago.', 440))
  );

  // ── Cap. 5 ──
  pgs.push(
    chapter(5, 'Qué pasa después', 'Inscritos · Pagos · Familia', '') +
    `<table class="tbl"><tr><th>Quién</th><th>Qué ocurre</th></tr>
      <tr><td><b>La inscripción</b></td><td>Queda <b>aprobada</b> de inmediato. No necesita que nadie la revise.</td></tr>
      <tr><td><b>La familia / el atleta adulto</b></td><td>Recibe el aviso «🏆 Inscribieron a tu deportista en un torneo» con el nombre del torneo. En un torneo con costo, el aviso añade «Tienes un cobro pendiente en Mis pagos» y el mensaje lleva a la pantalla del torneo.</td></tr>
      <tr><td><b>El cobro</b></td><td>Solo si el torneo tiene costo: «Inscripción torneo — (nombre) — (categoría)» por el valor vigente, <b>pendiente</b>, a nombre del acudiente (hijo) o del propio atleta (adulto). Cuenta como ingreso de <b>Torneo</b> en Finanzas. Vence unos días después de inscribir.</td></tr>
      <tr><td><b>Pago en efectivo</b></td><td>Si el único medio del torneo es «Efectivo», la app no registra el pago sola: cuando la familia pague en la escuela, regístralo en <b>Pagos</b>.</td></tr>
      <tr><td><b>Armar equipos</b></td><td>En «Sin equipo», marca a los inscritos, escribe el nombre del equipo y pulsa <b>Crear equipo</b>. Con los equipos armados se genera el calendario en la pestaña Resultados.</td></tr></table>` +
    tip('Plazo cerrado', 'La escuela <b>sí puede inscribir con el plazo de inscripciones vencido</b> y también con la tarifa vencida (se usa la última fase configurada). Las familias, en cambio, solo pueden inscribirse mientras el torneo esté abierto y la tarifa vigente.') +
    I('Aviso por <code>notifyProfiles([parent_id])</code> solo cuando <code>already_registered = false</code>; para un adulto <code>parent_id</code> es el propio atleta. El cobro se inserta en <code>payments</code> con <code>payment_type = one_time</code>, <code>payment_category = torneo</code> (desde la mig. <code>20261020113208</code>; los 2 cobros viejos de QA/demo quedaron con NULL a propósito), <code>period_uniqueness_exempt = true</code> y vencimiento <code>qr_first_charge_due_date(school, hoy)</code>. Adulto: <code>user_id</code> = atleta, <code>child_id</code> y <code>parent_id</code> NULL. La inscripción nace con <code>payment_status = pending</code> (con costo) o <code>not_required</code> (gratis).')
  );

  // ── Cap. 6 ──
  pgs.push(
    chapter(6, 'Si algo falla', 'Mensajes del modal y qué hacer', '') +
    `<table class="tbl"><tr><th>Lo que ves</th><th>Por qué</th><th>Qué hacer</th></tr>
      <tr><td>El botón <b>Inscribir atleta</b> está apagado</td><td>El torneo sigue en borrador</td><td>Agrega una categoría y pulsa <b>Publicar</b>.</td></tr>
      <tr><td>«Sin acudiente: asígnalo primero»</td><td>Hijo en un torneo con costo, sin pagador</td><td>Asigna el acudiente en su ficha, o inscríbelo en un torneo gratis.</td></tr>
      <tr><td>«El torneo llegó a su cupo (N)…»</td><td>Ya hay N inscritos y el cupo es N</td><td>Sube el cupo en la pestaña <b>Info</b> y guarda.</td></tr>
      <tr><td>«El torneo todavía no está publicado»</td><td>Se despublicó o sigue en borrador</td><td>Publícalo.</td></tr>
      <tr><td>«El atleta está inactivo» / «Ese atleta no pertenece a esta escuela o está inactivo»</td><td>El deportista fue dado de baja o es de otra escuela</td><td>Reactívalo en Deportistas si debe competir.</td></tr>
      <tr><td>«No autorizado: este torneo no es de tu escuela»</td><td>Tu usuario no es administración de la escuela dueña del torneo</td><td>Entra con la cuenta del owner o de un administrador.</td></tr>
      <tr><td>«Módulo de Torneos no activo»</td><td>La escuela no tiene el módulo</td><td>Solicítalo desde Mi Plan.</td></tr>
      <tr><td>Un deportista no aparece en la lista</td><td>Está inactivo o es de otra escuela</td><td>Revisa su estado y su escuela en Deportistas.</td></tr>
      <tr><td>«Ese torneo ya está vinculado a otro cobro»</td><td>Un torneo solo puede tener un cobro del catálogo</td><td>Desvincula el otro cobro o elige otro torneo.</td></tr>
      <tr><td>«Ese cobro ya tiene torneo»</td><td>El cobro ya se vinculó antes</td><td>Ábrelo con <b>Ver torneo</b>.</td></tr></table>` +
    I('Mensajes tal cual salen de <code>school_register_athlete_for_tournament</code>; el BFF devuelve 403 si el código es 42501 y 400 para el resto. Orden de validación: torneo → admin de la escuela → interno → publicado/cerrado → un solo deportista (hijo XOR adulto) → categoría activa → deportista de la escuela y activo → ya inscrito (<code>already_registered</code>, antes del cupo) → cupo (<code>capacity</code>, inscripciones no canceladas de TODAS las categorías) → pagador → tarifa (la vigente; si ninguna, la de <code>valid_until</code> más reciente) → monto &gt; 0. La RPC de la familia (<code>register_for_internal_tournament</code>) valida el mismo cupo y sigue exigiendo tarifa vigente.')
  );

  if (isInternal) {
    pgs.push(
      chapter(7, 'Estado de la prueba y puntos a vigilar', 'Solo equipo SportMaps — no prometer a la escuela', '') +
      `<table class="tbl"><tr><th>Tema</th><th>Estado</th></tr>
        <tr><td>Despliegue</td><td>develop <code>95720c3e</code> y main <code>f372868b</code> (2026-10-20). Migraciones <code>20261020113208</code>, <code>20261020120608</code> y <code>20261020122827</code> aplicadas a mano por el usuario (la base es única: ya valen en dev, staging y prod).</td></tr>
        <tr><td>Prueba en navegador (dev, Club Campestre Demo)</td><td>Crear torneo gratis y con costo → categoría → publicar → modal → inscribir hijo → repetir → <b>inscribir adulto</b> → «Ya inscrito» y «Adulto» → aviso de solo efectivo → catálogo: «Crear en Torneos» prellenado, vínculo guardado, «Torneo vinculado / Ver torneo». Scripts y capturas: <code>docs/manuales/_src/torneos-inscribir-atleta/</code>.</td></tr>
        <tr><td>Prueba en base con rollback</td><td>Tarifa vencida (la escuela inscribe con la última fase; la familia sigue bloqueada), cupo en las dos RPC, adulto gratis y con costo (pagador = el atleta, <code>payment_category = torneo</code>), hijo sin acudiente (gratis pasa, con costo se rechaza), hijo y adulto a la vez / ninguno, acudiente que intenta inscribir por la escuela (42501), guard del vínculo (otra escuela, torneo externo), índice único (un torneo, un cobro), catálogo y creación de cobro de WhatsApp con ítem vinculado.</td></tr>
        <tr><td>Bug hallado y arreglado</td><td>Adulto en torneo con costo fallaba con «record v_child is not assigned yet» → <code>20261020120608</code>.</td></tr>
        <tr><td>Besser</td><td>Addon <code>tournaments</code> de cortesía. 60 atletas activos (1 hijo sin acudiente, 0 adultos). Medios configurados: transferencia y efectivo (sin Wompi ni Nequi). Sus 5 cobros del catálogo (de $130.000 a $400.000) existen y nunca se han usado: 0 cobros de categoría torneo.</td></tr>
        <tr><td>No probado en navegador</td><td>La insignia «Sin acudiente» (el demo no tiene hijos sin acudiente), el modal en celular y la pantalla de la familia tras el aviso.</td></tr>
        <tr><td>Texto del modal</td><td>El encabezado dice «la familia recibe un aviso / cobro al acudiente» aun con un adulto (que se avisa y paga él mismo). Es solo copy; el aviso al terminar sí distingue al adulto.</td></tr>
        <tr><td>Vínculo catálogo ↔ torneo</td><td>Solo en el panel de la escuela (Pagos → Config → Cobros sueltos), no en el panel de soporte (ahí el torneo se crearía en la escuela del soporte). Copia el valor una sola vez. No convierte pagos sueltos ya hechos en inscripciones. Las filas del catálogo con <code>kind</code> vacío se tratan como «torneo» y también ofrecen «Crear en Torneos» (p. ej. «Inscripción», «Horas extras» del demo).</td></tr>
        <tr><td>Pendiente menor</td><td>2 cobros viejos de QA/demo sin <code>payment_category</code>; se dejaron (la tabla <code>payments</code> tiene muchos triggers). Con «solo efectivo» la app no registra el pago: se hace en Pagos.</td></tr></table>`
    );
  }
  return pgs;
}

function cover(isInternal) {
  return `<div class="page cover"><div class="cover-inner">
    <div><div class="logo"><span class="pin"></span>SportMaps</div></div>
    <div>
      <div class="cover-eyebrow"><span class="dot" style="background:${isInternal ? '#ff8833' : '#4fd17a'}"></span>${isInternal ? '🔒 Uso interno — no enviar a escuelas' : 'Guía de uso · Academias'}</div>
      <h1 class="cover-title">Inscribir atletas en un torneo interno</h1>
      <p class="cover-sub">Cómo crear un torneo de tu escuela (o convertir un cobro del catálogo en torneo), gratis o con costo, y usar el modal «Inscribir atleta» para anotar a hijos y atletas adultos sin esperar a las familias.</p>
      <div class="pills">
        <span class="pill">Rol: Owner / Administración</span>
        <span class="pill">${isInternal ? '7' : '6'} capítulos</span>
        <span class="pill">Capturas reales del producto</span>
        ${isInternal ? '<span class="pill" style="border-color:#ff8833;color:#ffcf9e">Uso interno</span>' : ''}
      </div>
    </div>
    <div class="cover-footer">SportMaps © 2026 · octubre</div>
  </div></div>`;
}
const css = () => fs.readFileSync(path.join(here, 'manual.css'), 'utf8');
function html(isInternal) {
  const body = pages(isInternal);
  const total = body.length + 1;
  const foot = (n) => `<div class="footer${isInternal ? ' internal-mark' : ''}"><span>SportMaps · ${isInternal ? 'Uso interno' : 'Guía de uso'}</span><span>Página ${n} de ${total}</span></div>`;
  return `<!doctype html><html><head><meta charset="utf-8" /><title>SportMaps — Inscribir atletas en un torneo interno (${isInternal ? 'Interno' : 'Academias'})</title><style>${css()}</style></head><body>` +
    cover(isInternal) + body.map((pg, i) => `<div class="page">${pg}${foot(i + 2)}</div>`).join('\n') + `</body></html>`;
}

async function render() {
  const browser = await chromium.launch();
  try {
    await makeCrops(browser);
    for (const [ver, base] of Object.entries(OUT)) {
      const isInternal = ver === 'interno';
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.writeFileSync(`${base}.html`, html(isInternal), 'utf8');
      const page = await browser.newPage();
      await page.goto('file:///' + `${base}.html`.replace(/\\/g, '/'));
      await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalHeight > 0));
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => [...document.querySelectorAll('.page')].map((el, i) => ({ n: i + 1, h: el.scrollHeight })).filter((x) => x.h > 1056));
      if (overflow.length) console.warn(`⚠️  ${ver}: páginas que desbordan 1056px →`, JSON.stringify(overflow));
      await page.pdf({ path: `${base}.pdf`, width: '816px', height: '1056px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
      const n = await page.evaluate(() => document.querySelectorAll('.page').length);
      await page.close();
      console.log(`✅ ${ver}: ${base}.pdf (${n} páginas esperadas)`);
    }
  } finally { await browser.close(); }
}
render().catch((e) => { console.error(e); process.exit(1); });
