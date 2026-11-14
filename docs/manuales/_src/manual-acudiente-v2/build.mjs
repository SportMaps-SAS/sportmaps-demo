// Genera el manual del Acudiente V2 en sus dos versiones (academias / interno)
// como HTML + PDF, con las capturas reales de ./shots/ (capture.mjs).
//
//   node docs/manuales/_src/manual-acudiente-v2/build.mjs
//
// Salida: docs/manuales/v2/{academias,interno}/manual-acudiente-v2.{html,pdf}
// Sistema visual: el de todos los manuales (memoria feedback_pdf_manual_template).
import fs from 'node:fs';
import path from 'node:path';
import * as lib from './lib.mjs';

const here = lib.here;
const repo = lib.repo;
const SHOTS = path.join(here, 'shots');
const CROPS = path.join(SHOTS, 'crops');
const OUT = {
  academias: path.join(repo, 'docs/manuales/v2/academias/manual-acudiente-v2'),
  interno: path.join(repo, 'docs/manuales/v2/interno/manual-acudiente-v2'),
};

// Recortes en CSS px. Las capturas del celular son 390 px de ancho @3x; las del
// panel de la escuela, 1440 px @2x.
const CROP_DEFS = {
  'c-inicio-torneos.png':   { src: '01-inicio-completo.png', x: 0, y: 985, w: 390, h: 205, s: 3 },
  'c-partido-arrayanes.png':{ src: '12-partidos-completo.png', x: 0, y: 795, w: 390, h: 570, s: 3 },
  'c-partidos-cabecera.png':{ src: '12-partidos-completo.png', x: 0, y: 60, w: 390, h: 330, s: 3 },
  'c-progreso-partido.png': { src: '13-progreso-con-partido.png', x: 0, y: 300, w: 390, h: 530, s: 3 },
  'c-mas-lista.png':        { src: '22-mas-completo.png', x: 0, y: 70, w: 390, h: 880, s: 3 },
  'c-ficha-docs.png':       { src: '08-hijos-ficha-completo.png', x: 0, y: 600, w: 390, h: 900, s: 3 },
  'c-transferencia.png':    { src: '18-transferencia-completo.png', x: 0, y: 0, w: 390, h: 844, s: 3 },
  'c-estado.png':           { src: '21c-estado-completo.png', x: 0, y: 60, w: 390, h: 840, s: 3 },
  'c-revision.png':         { src: '19b-en-revision.png', x: 0, y: 1380, w: 390, h: 560, s: 3 },
  'c-cal-mes-dia.png':      { src: '04b-cal-mes-dia.png', x: 0, y: 760, w: 390, h: 640, s: 3 },
  'c-owner-bandeja.png':    { src: '37-owner-por-asignar.png', x: 250, y: 150, w: 1190, h: 650, s: 2 },
  'c-owner-asignar.png':    { src: '37b-owner-asignar.png', x: 470, y: 120, w: 500, h: 600, s: 2 },
  'c-registro.png':         { src: '30b-registro.png', x: 0, y: 0, w: 390, h: 1456, s: 3 },
};

async function makeCrops(browser) {
  fs.mkdirSync(CROPS, { recursive: true });
  const page = await browser.newPage();
  for (const [out, d] of Object.entries(CROP_DEFS)) {
    const src = path.join(SHOTS, d.src);
    if (!fs.existsSync(src)) throw new Error(`Falta la captura ${d.src}. Corre capture.mjs: este manual no lleva mockups.`);
    const b64 = fs.readFileSync(src).toString('base64');
    const cropped = await page.evaluate(async ([b64, d]) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const s = d.s;
      const h = Math.min(d.h * s, img.naturalHeight - d.y * s);
      const c = document.createElement('canvas');
      c.width = d.w * s; c.height = h;
      c.getContext('2d').drawImage(img, d.x * s, d.y * s, d.w * s, h, 0, 0, d.w * s, h);
      return c.toDataURL('image/png').split(',')[1];
    }, [b64, d]);
    fs.writeFileSync(path.join(CROPS, out), Buffer.from(cropped, 'base64'));
  }
  await page.close();
}

// ── Piezas ────────────────────────────────────────────────────────────────
const b64 = (file) => {
  const fp = fs.existsSync(path.join(CROPS, file)) ? path.join(CROPS, file) : path.join(SHOTS, file);
  if (!fs.existsSync(fp)) throw new Error(`Falta ${file}`);
  return fs.readFileSync(fp).toString('base64');
};
/** Captura del celular, de ancho fijo. */
const phone = (file, caption = '', w = 200, maxH = 0) =>
  `<figure class="ph" style="width:${w}px"><img class="shot" style="width:${w}px;${maxH ? `max-height:${maxH}px;object-fit:cover;object-position:top` : 'max-height:none'}" src="data:image/png;base64,${b64(file)}" alt="${caption}"/>` +
  (caption ? `<figcaption class="shot-caption">${caption}</figcaption>` : '') + `</figure>`;
const phones = (...items) => `<div class="phones">${items.join('')}</div>`;
const wide = (file, caption, w = 640) =>
  `<div class="shot-wrap"><img class="shot" style="width:${w}px;max-height:none" src="data:image/png;base64,${b64(file)}" alt="${caption}"/><div class="shot-caption">${caption}</div></div>`;

const p = (html, cls = '') => `<p${cls ? ` class="${cls}"` : ''}>${html}</p>`;
const ul = (...items) => `<ul class="lst">${items.map((i) => `<li><span>${i}</span></li>`).join('')}</ul>`;
const step = (n, title, body) =>
  `<div class="step"><div class="step-head"><div class="step-badge">${n}</div><div class="step-title">${title}</div></div>${body}</div>`;
/** Paso con el texto a la izquierda y la captura del celular a la derecha. */
const srow = (n, title, body, pic) =>
  `<div class="srow"><div class="stext">${step(n, title, body)}</div><div class="spic">${pic}</div></div>`;
const warn = (tag, html) => `<div class="callout warn"><span class="tag">${tag}</span>${html}</div>`;
const tip = (tag, html) => `<div class="callout tip"><span class="tag">${tag}</span>${html}</div>`;
const internal = (html) => `<div class="callout internal"><span class="tag">🔒 INTERNO —</span>${html}</div>`;
const chapter = (n, title, crumb, intro) =>
  `<div class="chap"><div class="chapter-head"><div class="chapter-badge">${n}</div><h2 class="chapter-title">${title}</h2></div>` +
  `<div class="breadcrumb">${crumb}</div><hr class="chapter-rule" />${intro ? p(intro) : ''}</div>`;
const tbl = (head, rows) => `<table class="tbl"><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;

// ── Contenido: cada entrada del array es UNA página ───────────────────────
function pages(I) {
  const pgs = [];

  // ── Cap. 1 — Cómo está organizada ──
  pgs.push(
    chapter(1, 'Cómo está organizada la app', 'Barra de abajo: Inicio · Calendario · Hijos · Pagos · Más',
      'La app de SportMaps para familias está pensada para el celular. Todo lo que necesitas está en <b>cinco pestañas</b> en la barra de abajo. Lo que no cabe en las primeras cuatro está en <b>Más</b>: no se perdió nada.') +
    tbl(['Pestaña', 'Para qué sirve', 'Lo más usado'], [
      ['<b>Inicio</b>', 'Lo importante de hoy en una sola pantalla', 'Saldo y botón Pagar, próximo entreno, tarjeta de cada hijo con la frase del profe'],
      ['<b>Calendario</b>', 'Entrenos, partidos y torneos de tus hijos', 'Próximos días, torneos para inscribirse, vista del mes'],
      ['<b>Hijos</b>', 'La ficha de cada hijo', 'Progreso, asistencia, informes, partidos, ficha de salud, documentos y carnet'],
      ['<b>Pagos</b>', 'Lo que debes y lo que ya pagaste', 'Pagar en línea, subir el comprobante de una transferencia, estado de cuenta'],
      ['<b>Más</b>', 'Todo lo demás', 'Inscripciones, torneos, carnets, constancias, compras, salud, ayuda, Mi cuenta'],
    ]) +
    tip('Para volver', 'Cuando entras a una pantalla interna (un informe, el estado de cuenta, un carnet), arriba aparece <b>«Volver a …»</b> con el nombre de la pestaña de donde saliste. Y el botón redondo de abajo a la derecha es <b>Mapi</b>, el asistente: le puedes preguntar cómo hacer cualquier cosa.') +
    phones(phone('01-inicio.png', 'Inicio', 118), phone('22-mas.png', 'Más', 118), phone('05-hijos-progreso.png', 'Hijos', 118), phone('16-pagos-por-pagar.png', 'Pagos', 118))
  );

  // ── Cap. 2 — Inicio ──
  pgs.push(
    chapter(2, 'Inicio', 'Pestaña Inicio',
      'Inicio te dice en una frase si estás al día y qué viene. No hace falta buscar nada.') +
    srow(1, 'La frase de arriba y el botón Pagar',
      p('Si tienes cobros pendientes, la primera línea lo dice (<b>«Tienes 7 cobros pendientes»</b>) y debajo te cuenta cuál es el más antiguo (<b>«El más antiguo, la mensualidad de agosto de Sofía, venció el 10 de agosto»</b>). El botón verde te lleva directo a pagarlos. Si estás al día, dice <b>«Todo al día»</b>.') +
      p('Debajo, en verde claro, el <b>próximo entreno</b> de cualquiera de tus hijos: quién, cuándo y dónde.'),
      phone('01-inicio.png', 'Inicio de una familia con dos hijos.', 168)) +
    srow(2, 'La tarjeta de cada hijo',
      p('Cada hijo tiene su tarjeta con el equipo, el profe y si debe algo. Cuando el profe publica el informe del mes, aparece aquí su <b>frase</b> entre comillas.') +
      p('Si el profe <b>convocó a tu hijo a un partido</b>, en su tarjeta aparece la pregunta <b>«¿Va Tomás al partido contra Halcones FC?»</b> con el día, la hora, el lugar y la nota de llegada. Toca <b>Va</b> o <b>No va</b>: el profe recibe tu respuesta (capítulo 5).') +
      p('<b>«Ver cómo va»</b> abre la ficha de ese hijo en la pestaña Hijos.'),
      phone('01c-inicio-convocatoria.png', 'La tarjeta de Tomás, con su convocatoria.', 168))
  );
  pgs.push(
    srow(3, 'Una pregunta a la vez',
      p('Si a la ficha de tu hijo le falta un dato importante (por ejemplo la <b>EPS</b>), Inicio te lo pregunta con botones: tocas la respuesta y listo. Solo lo ve la escuela, por si hay una emergencia.') +
      p('Al final de Inicio están los <b>torneos o ligas abiertos</b> de la escuela con el botón <b>Inscribirme</b>.'),
      phones(phone('38d-inicio-con-escuela.png', 'La pregunta de la EPS, en el Inicio de otra familia.', 150), phone('c-inicio-torneos.png', 'Torneos abiertos al final de Inicio.', 150))) +
    tip('Avisos', 'La campana de arriba muestra cuántos avisos sin leer tienes: cobros nuevos, recordatorios de pago, convocatorias a partidos, torneos abiertos. También los ves en <b>Más → Notificaciones</b>.') +
    I('Re-probado el 28-oct: ya no sale «p. m..» (B10, <code>conPuntoFinal</code>), la segunda línea nombra el cobro más antiguo (#26) y las fotos generadas se cambiaron por iniciales (#29). La tarjeta del hijo convocado trae «¿Va …?» (B1, <code>TarjetaConvocatoria.tsx</code> con <code>my_callups</code> / <code>respond_callup</code>); solo sale la convocatoria más próxima de cada hijo. La frase del profe sale del informe mensual publicado (<code>athlete_monthly_reports</code>); la pregunta de la EPS (spec §4.2 la daba como ✖) sí existe y funciona.')
  );

  // ── Cap. 3 — Calendario ──
  pgs.push(
    chapter(3, 'Calendario', 'Pestaña Calendario → Próximos · Torneos · Mes',
      'El calendario lo arma la escuela: tú lo recibes. Ves los entrenos, partidos y torneos de <b>todos tus hijos</b> juntos, con el nombre de cada uno.') +
    srow(1, 'Próximos: lo que viene, día por día',
      p('Cada fila dice la hora, si es <b>Entreno</b> o <b>Partido</b>, de qué hijo, el equipo, el lugar y el profe. Los partidos traen además la <b>nota de la escuela</b> (hora de llegada, uniforme).'),
      phone('02-cal-proximos.png', 'Próximos: entrenos de Sofía y Tomás.', 168)) +
    phones(phone('02b-cal-partido.png', 'Un partido programado, con la nota para la familia.', 320))
  );
  pgs.push(
    srow(2, 'Toca un evento para ver el detalle',
      p('Al tocar cualquier fila se abre su <b>detalle</b>: el día y la hora de inicio y fin, el lugar con el botón <b>«Ver mapa»</b> (abre el mapa del celular para llegar) y la nota completa de la escuela.') +
      p('Si es un partido y tu hijo está <b>convocado</b>, ahí mismo aparece <b>«¿Va Tomás al partido…?»</b> con <b>Va</b> y <b>No va</b>. Para cerrar, toca la <b>X</b> o desliza hacia abajo.'),
      phone('02c-cal-detalle.png', 'El detalle de un partido, con el mapa y la convocatoria.', 168)) +
    I('Re-probado el 28-oct: la fila abre una hoja inferior (<code>DetalleEvento</code> en <code>ParentCalendarV2.tsx</code>). «Ver mapa» abre <code>google.com/maps/search/?query=&lt;texto del lugar&gt;</code>: busca por el texto, no por coordenadas, así que un lugar escrito a medias («Cancha 2») puede caer en otro sitio. Sigue sin «agregar a mi calendario» del teléfono.')
  );
  pgs.push(
    srow(3, 'Torneos: inscribir a tu hijo',
      p('Aquí ves los torneos donde tu hijo <b>ya está inscrito</b> («Inscripción lista») y los que tienen <b>inscripciones abiertas</b>, con el precio y la fecha límite. El botón <b>«Inscribir a Sofía»</b> hace la inscripción; si tiene costo, te lleva a pagarla.') +
      p('Cuando es la escuela la que inscribe al equipo, el torneo aparece aquí solo.'),
      phone('03-cal-torneos.png', 'Torneos inscritos y abiertos.', 168)) +
    srow(4, 'Mes: la cuadrícula de siempre',
      p('La vista <b>Mes</b> muestra el mes completo. Los días con eventos tienen una marca; al tocar un día ves sus eventos abajo, con hora, lugar y equipo.'),
      phone('c-cal-mes-dia.png', 'Al tocar el sábado 31 aparece el partido.', 168)) +
    warn('Tú no creas eventos', 'Los eventos los publica la escuela o el profe. Si ves algo mal (una hora, un lugar), avísale a la escuela por WhatsApp desde <b>Más → Escribirle al club</b>.') +
    I('La vista Mes es el <code>CalendarPage</code> de siempre en modo lectura (<code>isParentView</code>): sin «Nuevo Evento», confirmado en vivo el 26 y el 28-oct.')
  );

  // ── Cap. 4 — Hijos ──
  pgs.push(
    chapter(4, 'Hijos: la ficha de cada uno', 'Pestaña Hijos → Progreso · Asistencia · Informes · Ficha',
      'Si tienes varios hijos, arriba eliges a cuál ver. La ficha tiene cuatro pestañas.') +
    srow(1, 'Progreso',
      p('<b>«En qué va mejorando»</b>: cada habilidad que el profe mide (de 1 a 5), con la flecha de si subió o bajó desde la medición anterior. Abajo, qué <b>trabajar en casa</b>.') +
      p('Si el profe dejó un comentario escrito (por ejemplo después de un partido), sale abajo como <b>«Lo que dijo el profe»</b>, con la fecha.') +
      p('Tu hijo <b>solo se compara con su propio avance</b>, nunca con otros niños. <b>«Ver todas las mediciones»</b> abre el detalle mes a mes y las rutinas que compartió el profe.'),
      phone('05-hijos-progreso.png', 'Progreso de Tomás.', 168)) +
    srow(2, 'Asistencia',
      p('El porcentaje de cada mes y la lista de los últimos entrenos: <b>Vino</b>, <b>Llegó tarde</b>, <b>No vino</b> o <b>Con excusa</b>. Llegar tarde cuenta como haber venido. <b>«Ver todo el historial»</b> muestra todos los meses.'),
      phone('06-hijos-asistencia.png', 'Asistencia por mes.', 168))
  );
  pgs.push(
    srow(3, 'Informes',
      p('Tres cosas que publica la escuela:') +
      ul('<b>Informe del mes</b>: cómo le fue, lo mejor del mes y qué trabajar. Se puede <b>descargar en PDF</b>.',
        '<b>Lo que trabajó el equipo</b>: el informe del entreno, con el dato de tu hijo frente al grupo (sin nombres de otros niños).',
        '<b>Informes de partidos</b>: el reporte del profe después de cada partido (capítulo 5).'),
      phone('07-hijos-informes.png', 'La pestaña Informes.', 168)) +
    srow(4, 'El informe del mes',
      p('Arriba, la asistencia del mes y el botón <b>Descargar PDF</b>. Luego la frase del equipo, lo mejor del mes, lo que hay que trabajar y cada habilidad por área (físico, técnico, táctico), con goles y asistencias si es fútbol.'),
      phone('10-informe-mensual.png', 'Informe de septiembre de Tomás.', 168))
  );
  pgs.push(
    srow(5, 'Ficha: los datos y la salud',
      p('Documento, EPS, tipo de sangre, alergias y contacto de emergencia. Si algo está mal o falta, toca <b>«Corregir un dato»</b>: se abre el formulario con los datos del hijo.') +
      p('Desde aquí también está <b>«Mostrar carnet»</b>.'),
      phone('08-hijos-ficha.png', 'La pestaña Ficha de Sofía.', 168)) +
    srow(6, 'Documentos: todos opcionales',
      p('Hay diez tipos: documento del deportista (frente y reverso), foto, certificado de la EPS, paz y salvo, documento del acudiente (frente y reverso), <b>firma del acudiente</b>, <b>firma del deportista</b> y otro documento.') +
      p('<b>Ninguno es obligatorio.</b> Súbelos si la escuela te los pide: toca <b>Subir</b>, elige una foto o un PDF y queda <b>«Cargado»</b>, con <b>Ver</b> y <b>Cambiar</b>. La escuela los ve en la ficha de tu hijo; nadie más.') +
      phones(phone('09-documento-subido.png', 'Un documento ya cargado.', 300)),
      phone('c-ficha-docs.png', 'La lista de documentos.', 168)) +
    I('<b>B2 cerrado (re-probado el 28-oct):</b> con el owner demo, Deportistas → Sofía Herrera → «Ver» → «Documentos cargados» muestra el documento de prueba que subió Mauricio el 26-oct (la ficha lee también <code>children/&lt;acudiente&gt;/&lt;hijo&gt;/docs</code>). Dos detalles: la sección se queda ~10 s en «Cargando documentos…» y el documento sale con el nombre crudo del archivo (<code>other-2026-10-27T01-48-21-616Z-documento-prueba.png</code>) en vez de su tipo («Otro documento»).')
  );
  pgs.push(
    srow(7, 'Carnet digital',
      p('En <b>Más → Carnets</b> (o «Mostrar carnet» en la ficha) están los carnets de tus hijos con su vigencia. Al tocar uno se abre en grande con el <b>código QR</b> para la entrada de la escuela, el equipo, la EPS y el contacto de emergencia.') +
      p('Abajo: <b>Ver el reverso</b>, <b>Descargar el carnet</b> y <b>Abrir el enlace para compartir</b>.'),
      phones(phone('14-carnets.png', 'Carnets vigentes.', 150), phone('14b-carnet-grande.png', 'El carnet en grande.', 150))) +
    srow(8, '¿Cómo te fue en el entreno?',
      p('Después de algunos entrenos te llega un aviso: <b>«¿Cómo estuvo el entreno de hoy?»</b>. Son 5 preguntas de un toque, menos de 30 segundos, y ayudan al profe a cuidar cuánto entrena tu hijo.') +
      p('Para <b>agregar otro hijo</b>, en la pestaña Hijos toca <b>«Agregar hijo»</b> arriba a la derecha.'),
      phone('11b-autoevaluacion.png', 'La autoevaluación después del entreno.', 168)) +
    I('La pestaña «Ficha y salud» ya no se corta: en el celular dice «Ficha» (B10). El carnet de Tomás muestra como «último pago» un torneo de $50.000 y la marca «Cuota vencida»: el dato es correcto, pero el pago destacado no es la mensualidad.')
  );

  // ── Cap. 5 — Partidos y convocatorias ──
  pgs.push(
    chapter(5, 'Partidos y convocatorias de mi hijo', 'Hijos → Informes → Informes de partidos',
      'Cuando el equipo de tu hijo juega, la escuela te avisa antes (convocatoria) y te cuenta después (reporte del partido).') +
    srow(1, 'Te avisan que tu hijo está convocado',
      p('Cuando el profe arma la convocatoria te llega un aviso: <b>«⚽ Convocatoria: vs Halcones FC — Tomás está convocado para el partido del 31/10 a las 10:00, en Cancha fútbol 11»</b>. El partido aparece también en tu <b>Calendario</b>, con la nota de llegada y uniforme.'),
      phone('15c-notif-convocatoria.png', 'El aviso de la convocatoria, en Notificaciones.', 200))
  );
  pgs.push(
    srow(2, 'Responde: ¿va o no va?',
      p('El profe necesita saber con quién cuenta. Responde en cualquiera de estos dos lugares:') +
      ul('En <b>Inicio</b>, en la tarjeta de tu hijo: <b>«¿Va Tomás al partido contra Halcones FC?»</b>.',
        'En <b>Calendario → Próximos</b>, tocando el partido: la convocatoria sale al final del detalle.') +
      p('Toca <b>Va</b> o <b>No va</b>. Sale el mensaje <b>«Le avisaste al profe que Tomás va»</b> y la tarjeta queda con la respuesta. Si cambian los planes, toca <b>Cambiar</b>: el profe ve la respuesta nueva.'),
      phone('02d-cal-detalle-va.png', 'Respuesta enviada: «Tomás va al partido».', 168)) +
    tip('Si tienes varios hijos convocados', 'Cada uno tiene su propia pregunta: respondes por cada hijo por separado.') +
    I('<b>B1 cerrado (re-probado el 28-oct):</b> Mauricio tocó «Va» en el detalle del partido y quedó la fila <code>match_callup_responses be46ba07…</code> (<code>response = va</code>, <code>responded_by</code> = Mauricio); Inicio pasó a «Tomás va al partido · Cambiar». El aviso de la convocatoria sigue enlazando a <code>/calendar</code> (Próximos), no al detalle del partido: hay que tocar el partido para responder, o hacerlo desde Inicio. Propuesta menor: que el enlace abra el detalle.')
  );
  pgs.push(
    srow(3, 'Después del partido: el reporte del profe',
      p('En <b>Hijos → Informes → Informes de partidos</b> ves cada partido con su resultado (<b>Ganó</b>, <b>Empató</b>, <b>Perdió</b>), el <b>resumen</b>, <b>cómo fue el partido</b> y <b>qué van a mejorar</b>. Si la administración dejó un comentario, también sale.') +
      p('Debajo está <b>«Tu respuesta»</b>: escríbele al profe lo que quieras sobre el partido y toca <b>Enviar</b>. Puedes editarla después.'),
      phone('c-partido-arrayanes.png', 'Reporte del partido y la respuesta de la familia.', 168)) +
    srow(4, 'La evaluación del partido',
      p('Si la escuela comparte las evaluaciones de partido con las familias, la calificación de tu hijo (actitud, técnica, decisiones, físico, comunicación, cumplimiento del rol) aparece en <b>Progreso</b>, junto con lo que el profe mide en los entrenos. Cada familia ve <b>solo la de su hijo</b>.') +
      p('El comentario escrito del profe sale aparte, debajo de las habilidades, como <b>«Lo que dijo el profe»</b>, con el partido y la fecha.') +
      phones(phone('13b-lo-que-dijo-el-profe.png', '«Lo que dijo el profe», en Progreso.', 300)),
      phone('c-progreso-partido.png', 'La evaluación del partido en Progreso.', 168)) +
    I('Dos interruptores de escuela deciden lo que ve la familia: <code>school_settings.share_match_reports</code> (reporte) y <code>share_match_evaluations</code> (evaluación). <b>B4 cerrado:</b> el diálogo del reporte del partido ya trae «Compartir los reportes de partido con las familias» (solo administración; verificado en vivo con el owner demo, encendido). <b>B6 cerrado:</b> el «Comentario del coach» ya no sale como «Comentario 0»; se muestra como «Lo que dijo el profe». Detalle: junto a cada comentario sale la fecha en que se guardó la evaluación, no la del partido (el comentario del partido vs Deportivo Arrayanes, jugado el 24-oct, sale como «Partido · Lunes 26 de octubre»). La evaluación sigue sin salir dentro de la tarjeta del partido en «Informes de partidos».')
  );

  // ── Cap. 6 — Pagos ──
  pgs.push(
    chapter(6, 'Pagos', 'Pestaña Pagos → Por pagar · Pagados',
      'Arriba ves cuánto debes en total. Cada cobro viene <b>ya marcado</b>: si los quieres pagar todos, no tienes que tocar nada más.') +
    srow(1, 'Por pagar',
      p('Cada cobro dice el concepto, de qué hijo es, desde cuándo está vencido (y si incluye recargo por mora) y el valor. Para dejar uno por fuera, <b>desmárcalo</b>: el botón de abajo se recalcula solo (por ejemplo de 7 a 6 cobros).') +
      p('Los cobros que ya tienen un comprobante enviado salen abajo como <b>«En revisión»</b>.'),
      phone('16-pagos-por-pagar.png', 'Pagos: los cobros vienen marcados.', 168)) +
    srow(2, 'Pagar en línea',
      p('Toca <b>«Pagar N cobros»</b>. Se pagan <b>uno por uno</b>, con el valor de cada cobro. Elige <b>Pagar en línea</b> (tarjeta, PSE o Nequi): el resumen muestra el valor, el recargo por pago en línea si la escuela lo cobra y el total. El último botón te lleva a la pasarela segura para pagar.'),
      phone('17-pagar-online.png', 'Antes de ir a la pasarela.', 168)) +
    I('La prueba se detuvo en este botón: no se abrió la pasarela ni se pagó nada. Con varios cobros marcados se pagan en serie (<code>MyPaymentsPage.tsx:512</code> <code>startPaying</code>), un checkout por cobro; el recargo del 3 % es de la escuela.')
  );
  pgs.push(
    srow(3, 'Ya transferí: subir el comprobante',
      p('Si pagaste por transferencia, Nequi o Daviplata, toca <b>«Ya transferí: subir el comprobante»</b>. La ventana abre con <b>Transferencia / Nequi / Daviplata</b> ya elegida: ves los datos de la cuenta de la escuela (con botón para copiar) y <b>«Sube tu comprobante»</b>.') +
      p('Elige la foto o el PDF del comprobante, espera el chulo de <b>«Comprobante cargado»</b> y confirma. Sale el mensaje <b>«Pago registrado. Validaremos tu comprobante pronto»</b>.'),
      phone('18-transferencia.png', 'Datos de la cuenta y subir comprobante.', 168)) +
    srow(4, 'En revisión',
      p('Ese cobro pasa a <b>«En revisión»</b> hasta que la escuela compare el comprobante con su cuenta. Cuando lo aprueba, pasa a <b>Pagados</b> y te llega un aviso <b>«Pago confirmado»</b>.') +
      tip('Un comprobante por cobro', 'Si hiciste una sola transferencia por varios cobros, súbela en uno y avísale a la escuela para que la reparta.'),
      phone('c-revision.png', 'Cobros con comprobante enviado.', 168)) +
    I('<b>B7 cerrado (re-probado el 28-oct):</b> «Ya transferí» abre con Transferencia marcada (<code>initialMethod</code>). <b>Hallazgo nuevo N1:</b> el encabezado de la ventana dice «Mensualidad Octubre 2026 · Pago para Sofía Herrera — Octubre 2026» aunque el cobro es la mensualidad de <b>agosto</b>: en un cobro existente el título usa el periodo siguiente calculado (<code>PaymentCheckoutModal.tsx:1100-1107</code>, <code>effectivePeriod</code> sale de <code>nextPeriod</code>), no el del cobro. El cobro no se reescribe (l.740 lo protege), pero la familia puede creer que paga otro mes. Comprobante de prueba del 26-oct («Mensualidad Julio 2026 — Tenis (Tomás)»): sigue en revisión.')
  );
  pgs.push(
    srow(5, 'Pagados y recibos',
      p('En <b>Pagados</b> está todo lo que ya pagaste, con el valor, el medio (en línea, tarjeta, transferencia) y la fecha. Los que tienen <b>Recibo</b> lo abren con un toque.'),
      phone('20-pagados.png', 'Historial de pagos.', 168)) +
    srow(6, 'Estado de cuenta de cada hijo',
      p('Desde <b>Pagos</b> (o el enlace del estado de cuenta) eliges al hijo y ves cuánto debe, cuántos cobros están vencidos y cuál está en revisión, <b>mes a mes</b>, con <b>«Pagar este cobro»</b> en cada uno. Al final, el resumen desde que entró y el botón <b>Imprimir</b> (últimos 12 meses).'),
      phone('c-estado.png', 'Estado de cuenta de Tomás.', 168)) +
    I('<b>B8 cerrado:</b> los cobros de Tenis de Tomás (sin <code>child_id</code>) ya no dicen «Tú (como atleta)»: toman el hijo que nombra el concepto («· Tomás»); «Tú» solo sale si el acudiente tiene inscripción propia y, si no, «Sin deportista asignado».')
  );

  // ── Cap. 7 — Más ──
  pgs.push(
    chapter(7, 'Más', 'Pestaña Más → Mi familia · Ayuda · Cuenta',
      'Todo lo que no está en las otras pestañas. Nada se quitó: lo que tenías antes está aquí.') +
    srow(1, 'Mi familia',
      ul('<b>Inscripciones y planes</b>: el plan activo de cada hijo, agendar clases y reservas.',
        '<b>Mis eventos y torneos</b>: las inscripciones a torneos, aprobadas y pagadas.',
        '<b>Carnets</b> de tus hijos (capítulo 4).',
        '<b>Constancias</b>: pide una constancia de estudio o de deportista y la escuela te la entrega aquí.',
        '<b>Tienda del club</b> y <b>Mis compras</b>: si la escuela tiene tienda, tus pedidos y en qué van.',
        '<b>Salud de mis hijos</b> y <b>Mis citas</b>: el plan y las citas con un profesional de salud, si lo hay.'),
      phone('c-mas-lista.png', 'Todo lo que hay en Más.', 168)) +
    srow(2, 'Ayuda',
      ul('<b>Escribirle al club</b>: abre el WhatsApp de la escuela.',
        '<b>Mensajes</b>: los avisos del club llegan a Notificaciones; para preguntar algo, el WhatsApp.',
        '<b>Centro de ayuda</b>: guías paso a paso.',
        '<b>Mapi</b>: el botón redondo de abajo a la derecha. Escríbele tu pregunta («¿Cómo subo el comprobante?») y te responde con los pasos.'),
      phone('26b-mapi-respuesta.png', 'Mapi responde.', 168)) +
    I('<b>B3 cerrado en lo principal (re-probado el 28-oct):</b> a «¿Cómo subo el comprobante de una transferencia?» Mapi ya responde con la V2 («Abre la pestaña Pagos… Ya transferí: subir el comprobante»), porque <code>bff/src/data/app-map.ts</code> (rol <code>parent</code>) se reescribió el 27-oct (<code>fc390ef3</code>). Le falta: la tarea «responder una convocatoria» del acudiente (solo existe la del deportista) y la tarea del comprobante todavía dice «revisa que no quede Pagar online» (ya no aplica, B7). En el Centro de ayuda, el artículo <code>inscripcion-padre-paso-a-paso</code> quedó con un paso de entrenador pegado («Crear Sesión…») y enlaces a artículos del coach: ver <code>sportbot/manual-acudiente-v2.help-articles.ts</code>.')
  );
  pgs.push(
    srow(3, 'Mi cuenta',
      p('<b>Mi cuenta</b> junta tu perfil y la configuración en un solo lugar:') +
      ul('<b>Perfil</b>: nombre, WhatsApp, fecha de nacimiento y foto.',
        '<b>Notificaciones</b>: qué avisos te llegan y por dónde.',
        '<b>Privacidad</b>: quién ve tu perfil.',
        '<b>Seguridad</b>: cambiar la contraseña y eliminar la cuenta.') +
      p('Al final de Más está <b>Cerrar sesión</b>.'),
      phones(phone('23-mi-cuenta.png', 'Mi cuenta.', 150), phone('23-perfil.png', 'Perfil.', 150))) +
    srow(4, 'Notificaciones',
      p('Todos los avisos de la escuela: cobros nuevos, recordatorios de pago, pagos confirmados, convocatorias, partidos nuevos, torneos abiertos y la pregunta de cómo estuvo el entreno. Al tocar uno te lleva a la pantalla que corresponde. <b>«Marcar todas como leídas»</b> limpia el contador.'),
      phone('24-notificaciones.png', 'Notificaciones.', 168)) +
    I('<b>B9 cerrado:</b> por URL, <code>/announcements</code> dice «Lo que la escuela y los profes les cuentan a las familias» sin «Nuevo Anuncio», y <code>/dashboard/polls</code> es de solo lectura («No hay encuestas por ahora»). <b>B12 cerrado:</b> Mi cuenta › Seguridad carga sin errores y la tabla <code>account_deletion_requests</code> ya existe en la base viva (migración <code>20261027111037</code>). Siguen: «Mis eventos y torneos» abierto desde Más dice «Volver a Calendario» (<code>acudienteTabs.ts</code>), y en dev aparece <b>Explorar</b> en Más (<code>VITE_SHOW_EXPLORE=true</code> en ese ambiente; revisar que en prod esté apagado).')
  );

  // ── Cap. 8 — Código de escuela ──
  pgs.push(
    chapter(8, 'Unirme a la escuela con el código', 'Inicio → «¿Ya tienes escuela?» · enlace /unirse?codigo=…',
      'Si creaste tu cuenta y todavía no ves a tu hijo, pídele a la escuela su <b>código</b> (3 letras y 4 caracteres, por ejemplo <b>CAM-ABUP</b>). Con él la escuela te encuentra y te asigna la categoría.') +
    srow(1, 'Dónde se ingresa el código',
      p('Hay tres caminos, y los tres llegan al mismo lugar:') +
      ul('En <b>Inicio</b> (y en <b>Hijos</b>) aparece el aviso <b>«¿Ya tienes escuela? Ingresa el código que te dio tu escuela»</b> mientras tu cuenta no tenga escuela.',
        'Al crear la cuenta, el segundo paso tiene el campo opcional <b>«¿Ya tienes escuela? Ingresa su código»</b>.',
        'Si la escuela te mandó el <b>enlace</b> o el <b>QR</b>, ábrelo: si no has entrado, te pide entrar o crear la cuenta y después usa el código solo.'),
      phone('36-banner-sin-escuela.png', 'El aviso en Inicio de una cuenta sin escuela.', 168)) +
    phones(phone('30-unirse-sin-sesion.png', 'El enlace, sin haber entrado.', 125), phone('31-onboarding-codigo.png', 'El código al crear la cuenta.', 125))
  );
  pgs.push(
    srow(2, '¿Es tu escuela?',
      p('Al buscar el código aparece el <b>nombre, el logo y la ciudad</b> de la escuela. Si es la tuya, toca <b>«Sí, es mi escuela»</b>; si no, <b>«No, cambiar el código»</b>.'),
      phone('32-unirse-confirmar.png', 'Confirmar la escuela.', 168)) +
    srow(3, '¿Para quién es?',
      p('Elige <b>«Para mi hijo(a)»</b> (eres acudiente) o <b>«Para mí»</b> (tú entrenas). Escribe el <b>nombre completo</b> y la <b>fecha de nacimiento</b>, y si quieres la <b>categoría</b> que crees que le toca (es solo una sugerencia: la escuela decide). Toca <b>Enviar solicitud</b>.'),
      phone('33-unirse-para-quien.png', 'Los datos del hijo.', 168))
  );
  pgs.push(
    srow(4, 'Solicitud enviada',
      p('Listo: <b>«La escuela te asignará la categoría»</b>. Puedes <b>unir a otro hijo</b> con el mismo código. Mientras tanto, Inicio y Hijos muestran la solicitud en amarillo, con la opción <b>Cancelar solicitud</b>.') +
      p('Todavía <b>no se crea ningún cobro</b>: eso pasa cuando la escuela asigna la categoría.'),
      phones(phone('34-unirse-enviada.png', 'Solicitud enviada.', 150), phone('35b-hijos-solicitud.png', 'La solicitud en Hijos.', 150))) +
    srow(5, 'La escuela asigna y tu hijo aparece',
      p('Cuando la escuela elige el equipo te llegan dos avisos: <b>«¡Bienvenido(a) a la escuela! Mateo ya quedó en Fútbol — Sub-12»</b> y, si la escuela cobra, el <b>primer cobro</b> según sus reglas. Desde ese momento tu hijo tiene su ficha en Hijos y su cobro en Pagos.'),
      phones(phone('38c-aviso-asignado.png', 'Los avisos al asignar.', 150), phone('38-hijo-asignado.png', 'Mateo ya en su equipo.', 150)))
  );
  pgs.push(
    srow(6, 'El primer cobro',
      p('Si la categoría tiene mensualidad, el primer cobro aparece en <b>Pagos</b> con el nombre de tu hijo y su <b>fecha límite</b>: la escuela te da unos días para pagarlo, no vence el mismo día. Se paga igual que cualquier otro (capítulo 6).'),
      phone('38e-cobro-nuevo-1028.png', 'El primer cobro de Lucía: vence el 2 de noviembre.', 150)) +
    p('<b>Lo que hace la escuela</b> (para que sepas qué pasa del otro lado): en <b>Deportistas → «Por asignar»</b> ve tu solicitud con la edad y la categoría que sugeriste, y elige el equipo. El entrenador es el del equipo; el primer cobro sigue la regla normal de la escuela.') +
    wide('c-owner-bandeja.png', 'Del lado de la escuela: el código y la bandeja «Por asignar».', 600) +
    I('<b>B5 cerrado (re-probado el 28-oct):</b> con la cuenta sin escuela <code>familia.sincodigo2@demo.sportmaps.co</code> (Andrea Ruiz Demo) → <code>/unirse?codigo=CAM-ABUP</code> → «Lucía Ruiz Demo» (solicitud <code>da94623c…</code>) → el owner la asignó a «Fútbol — Sub-12». El cobro <code>98b40f30…</code> ($180.000) nació <b>con <code>parent_id</code></b> = Andrea y <b>vence el 2-nov</b> (asignado el 28-oct + 5 días de gracia de la escuela); el concepto dice «vence el 2 de noviembre». Se cobra la mensualidad completa de octubre aunque se asignó el 28 (regla de la escuela, sin prorrateo). La prueba del 26-oct (Mateo, cobro <code>a02da539…</code> con <code>parent_id</code> NULL y vencido el mismo día) quedó como estaba: el arreglo no corrige cobros viejos. El pie del onboarding con código (B10) se apiló en código; no se re-probó en vivo porque exige otra cuenta nueva.')
  );

  // ── Cap. 9 — Preguntas frecuentes ──
  pgs.push(
    chapter(9, 'Preguntas frecuentes', 'Lo que más preguntan las familias', '') +
    tbl(['Pregunta', 'Respuesta'], [
      ['No veo a mi hijo en la app.', 'Si la escuela te invitó, acepta la invitación que te llegó al correo o al WhatsApp. Si no, pídele a la escuela su <b>código</b> e ingrésalo en Inicio (capítulo 8). También puedes registrarlo tú con <b>Agregar hijo</b>.'],
      ['Pagué y el cobro sigue apareciendo.', 'Si pagaste en línea, el cobro pasa a Pagados en unos minutos. Si pagaste por transferencia, sube el comprobante: queda <b>En revisión</b> hasta que la escuela lo apruebe.'],
      ['Pagué en efectivo en la escuela.', 'La escuela registra el pago y el cobro pasa a <b>Pagados</b>. No tienes que subir nada.'],
      ['¿Por qué hay un recargo?', 'Algunas escuelas cobran recargo por mora después de la fecha límite, o un recargo por pago en línea. Lo ves en el detalle de cada cobro antes de pagar.'],
      ['¿Hay descuento por pagar a tiempo?', 'Si tu escuela lo activó, al pagar dentro de los primeros días ves el precio de lista tachado junto al precio con descuento, antes de elegir cómo pagar.'],
      ['¿Puedo crear o cambiar un evento del calendario?', 'No. El calendario lo publica la escuela. Si algo está mal, escríbele al club.'],
      ['Convocaron a mi hijo y no puede ir.', 'Toca <b>No va</b> en la tarjeta de tu hijo en <b>Inicio</b> (o en el partido, en <b>Calendario</b>). Si después sí puede, toca <b>Cambiar</b>.'],
      ['¿Cómo llego a la cancha?', 'En <b>Calendario → Próximos</b> toca el entreno o el partido y luego <b>Ver mapa</b>.'],
      ['¿Tengo que subir todos los documentos?', 'No. Todos son opcionales. Súbelos solo si la escuela te los pide; la escuela los ve en la ficha de tu hijo.'],
      ['¿Quién ve las evaluaciones de mi hijo?', 'Tú, la escuela y el profe. Tu hijo solo se compara con su propio avance, nunca con otros niños.'],
      ['¿Dónde cambio mi correo, WhatsApp o contraseña?', 'En <b>Más → Mi cuenta</b>: Perfil para tus datos y Seguridad para la contraseña.'],
      ['Tengo una duda que no está aquí.', 'Pregúntale a <b>Mapi</b> (el botón redondo de abajo a la derecha) o escríbele al club por WhatsApp.'],
    ])
  );

  if (I('x')) {
    pgs.push(
      chapter(10, 'Hallazgos de la prueba y lo que no existe', 'Solo equipo SportMaps — no prometer a las escuelas',
        'Prueba del 26-oct y re-prueba del 28-oct en dev.sportmaps.co (después de <code>198611e5</code> y <code>1c3d9a74</code>). Detalle y evidencia en <code>docs/manuales/v2/pruebas-acudiente-v2.md</code>.') +
      tbl(['#', 'Hallazgo (26-oct)', 'Estado el 28-oct'], [
        ['B1', 'El acudiente no podía responder «Va / No va»', '<b>Cerrado</b>: Inicio y detalle del partido. El aviso aún lleva a Próximos, no al detalle'],
        ['B2', 'La escuela no veía los documentos de la familia', '<b>Cerrado</b>. Carga lenta (~10 s) y nombre crudo del archivo'],
        ['B3', 'Mapi respondía con el menú V1', '<b>Cerrado en lo principal</b>. Faltan en <code>app-map.ts</code> la convocatoria del acudiente y quitar «revisa que no quede Pagar online»'],
        ['B4', 'Sin pantalla para <code>share_match_reports</code>', '<b>Cerrado</b>: interruptor en el diálogo del reporte (solo admins)'],
        ['B5', 'Cobro del alta por código sin <code>parent_id</code> y vencido el mismo día', '<b>Cerrado</b> para altas nuevas (hoy + días de gracia). El cobro viejo de Mateo sigue igual'],
        ['B6', '«Comentario del coach» como «Comentario 0»', '<b>Cerrado</b>: «Lo que dijo el profe». La fecha es la de la evaluación'],
        ['B7', '«Ya transferí» con «Pagar online» marcado', '<b>Cerrado</b>'],
      ]) +
      tbl(['#', 'Hallazgo (26-oct)', 'Estado el 28-oct'], [
        ['B8', 'Cobros sin hijo como «Tú (como atleta)»', '<b>Cerrado</b>'],
        ['B9', '/announcements y /dashboard/polls ofrecían crear', '<b>Cerrado</b>: solo lectura para la familia'],
        ['B10', '«p. m..», «Ficha y salu…», pie del onboarding cortado', '<b>Cerrado</b> los dos primeros en vivo; el pie, solo en código (no re-probado)'],
        ['B11', 'Recordatorio post-entreno duplicado', '<b>No re-probado</b> (sin arreglo en los commits)'],
        ['B12', 'Mi cuenta › Seguridad con 500', '<b>Cerrado</b>: sin errores; la tabla existe'],
        ['B13', 'Mapi tapa botones a 390 px', '<b>Abierto</b> (sin cambios)'],
        ['N1', '<b>Nuevo:</b> la ventana de pago de un cobro viejo se titula con el mes en curso («Mensualidad Octubre 2026» para la de agosto)', '<b>Abierto</b> · <code>PaymentCheckoutModal.tsx:1100-1107</code> · Baja'],
        ['N2', '<b>Nuevo:</b> el aviso de convocatoria abre Próximos y no el detalle del partido', '<b>Abierto</b> · Baja'],
      ]) +
      tbl(['No existe todavía', 'Nota'], [
        ['Agregar un evento al calendario del teléfono', 'El detalle trae «Ver mapa», no «agregar a mi calendario».'],
        ['Pagar varios cobros en una sola transacción', 'Se pagan uno por uno.'],
        ['Informe del entreno publicado en el demo', 'La pantalla se probó en su estado vacío (BFF 404 «aún no publicado», esperado).'],
      ])
    );
  }
  return pgs;
}

// ── Documento ─────────────────────────────────────────────────────────────
function cover(isInternal, nChapters) {
  return `<div class="page cover"><div class="cover-inner">
    <div><div class="logo"><span class="pin"></span>SportMaps</div></div>
    <div>
      <div class="cover-eyebrow"><span class="dot" style="background:${isInternal ? '#ff8833' : '#4fd17a'}"></span>${isInternal ? '🔒 Uso interno — no enviar a escuelas' : 'Guía de uso · Familias'}</div>
      <h1 class="cover-title">Manual del acudiente</h1>
      <p class="cover-sub">Todo lo que hace una familia en SportMaps desde el celular: el inicio, el calendario de los hijos, su progreso, partidos y documentos, los pagos y cómo unirse a la escuela con su código.</p>
      <div class="pills">
        <span class="pill">App de familias · versión 2</span>
        <span class="pill">${nChapters} capítulos</span>
        <span class="pill">Capturas reales del celular</span>
        ${isInternal ? '<span class="pill" style="border-color:#ff8833;color:#ffcf9e">Uso interno</span>' : ''}
      </div>
    </div>
    <div class="cover-footer">SportMaps © 2026 · octubre${isInternal ? ' · probado en dev.sportmaps.co el 26-oct y re-probado el 28-oct-2026' : ''}</div>
  </div></div>`;
}

function html(isInternal) {
  const I = (h) => (isInternal ? internal(h) : '');
  const body = pages(I);
  const label = isInternal ? 'Uso interno' : 'Guía de uso';
  const css = fs.readFileSync(path.join(here, 'manual.css'), 'utf8');
  // Paginación automática: cada grupo que abre con un capítulo empieza página;
  // los bloques (hijos directos del grupo) se van acomodando y el que no cabe
  // pasa a la página siguiente. El título del capítulo viaja con su primer bloque.
  const layout = `<script>window.addEventListener('load', async () => { await document.fonts.ready;
    const MAX = 1056;
    const pages = []; let cur = null;
    const nueva = () => { cur = document.createElement('div'); cur.className = 'page'; document.body.appendChild(cur); pages.push(cur); };
    for (const g of [...document.querySelectorAll('#src > .grp')]) {
      const kids = [...g.children];
      if (g.dataset.chapter === '1' || !cur) nueva();
      for (let i = 0; i < kids.length; i++) {
        const unit = [kids[i]];
        if (kids[i].classList.contains('chap') && kids[i + 1]) unit.push(kids[++i]);
        unit.forEach((k) => cur.appendChild(k));
        if (cur.scrollHeight > MAX && cur.children.length > unit.length) {
          // Un aviso que no cabe se lleva consigo el bloque anterior (el paso al
          // que se refiere), para no dejar una página con un aviso suelto.
          const prev = unit[0].previousElementSibling;
          const conPrevio = unit[0].classList.contains('callout') && prev && !prev.classList.contains('chap') && cur.children.length > unit.length + 1;
          nueva();
          if (conPrevio) cur.appendChild(prev);
          unit.forEach((k) => cur.appendChild(k));
        }
      }
    }
    document.getElementById('src').remove();
    const total = pages.length + 1;
    pages.forEach((pg, i) => {
      const f = document.createElement('div');
      f.className = 'footer${isInternal ? ' internal-mark' : ''}';
      f.innerHTML = '<span>SportMaps · ${label}</span><span>Página ' + (i + 2) + ' de ' + total + '</span>';
      pg.appendChild(f);
    });
    window.__laidOut = true;
  });<\/script>`;
  return `<!doctype html><html><head><meta charset="utf-8" /><title>SportMaps — Manual del acudiente (${isInternal ? 'Interno' : 'Academias'})</title><style>${css}</style></head><body>` +
    cover(isInternal, isInternal ? 10 : 9) +
    `<div id="src" style="width:816px">` +
    body.map((pg) => `<div class="grp" data-chapter="${pg.startsWith('<div class="chap">') ? 1 : 0}">${pg}</div>`).join('') +
    `</div>` + layout + `</body></html>`;
}

async function render() {
  const browser = await lib.launch();
  try {
    await makeCrops(browser);
    for (const [ver, base] of Object.entries(OUT)) {
      const isInternal = ver === 'interno';
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.writeFileSync(`${base}.html`, html(isInternal), 'utf8');
      const page = await browser.newPage();
      await page.goto('file:///' + `${base}.html`.replace(/\\/g, '/'));
      await page.waitForFunction(() => window.__laidOut === true);
      await page.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalHeight > 0));
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() =>
        [...document.querySelectorAll('.page')].map((el, i) => ({ n: i + 1, h: el.scrollHeight })).filter((x) => x.h > 1056));
      if (overflow.length) console.warn(`⚠️  ${ver}: páginas que desbordan 1056px →`, JSON.stringify(overflow));
      await page.pdf({ path: `${base}.pdf`, width: '816px', height: '1056px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
      const n = await page.evaluate(() => document.querySelectorAll('.page').length);
      await page.close();
      console.log(`✅ ${ver}: ${base}.pdf (${n} páginas esperadas)`);
    }
  } finally {
    await browser.close();
  }
}

render().catch((e) => { console.error(e); process.exit(1); });
