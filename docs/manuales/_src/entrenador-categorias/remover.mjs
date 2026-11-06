// Actualiza guia-entrenadores-asignar-categoria (academias + interno) con el permiso
// «Coaches pueden remover deportistas de sus equipos» (2026-10-22, commits cc58ea88 y
// 121bc719). La guía no tiene fuente de build, así que se parchea su HTML: cada
// reemplazo exige encontrar su texto exacto, y después se regeneran los dos PDF.
// Requiere las capturas de capture.mjs.
//
//   node docs/manuales/_src/entrenador-categorias/remover.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { MAN, repo, crearPiezas, chapter, step, callout } from '../_pdf/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.join(repo, 'frontend', 'package.json'))('playwright');
const { shot } = crearPiezas(path.join(here, 'shots'), {
  // Solo la fila del interruptor nuevo, al pie de la tarjeta «Permisos».
  'e02-interruptor': { left: 30, top: 1062, width: 1060, height: 172 },
});

function reemplazar(html, viejo, nuevo) {
  if (!html.includes(viejo)) throw new Error('No encontré: ' + viejo.slice(0, 90));
  return html.replace(viejo, nuevo);
}

async function paginaRemover(ver) {
  const interno = ver === 'interno';
  return `<div class="page">${chapter(5, 'Remover a un deportista', 'Mis Equipos → Gestionar Deportistas → Remover')}`
    + `<p>Sacar a un deportista de una categoría <b>cancela su inscripción y anula sus cobros pendientes</b> en ella. Por eso lo decide la escuela: de entrada solo lo hace la administración, y tú puedes hacerlo <b>solo si tu escuela te da el permiso</b>.</p>`
    + step(1, 'Sin el permiso: la etiqueta "Inscrito"', `<p>En la ventana "Inscribir Deportistas", cada inscrito muestra a la derecha la etiqueta gris <b>"Inscrito"</b>, sin botón. Para sacar a alguien, pídeselo a la administración.</p>${await shot('e01-sin-permiso', 'Sin el permiso, el inscrito no trae botón para sacarlo', 46)}`)
    + step(2, 'La administración prende el permiso', `<p>Lo hace un administrador o el dueño de la escuela: menú <b>Pagos</b> → pestaña <b>Config</b> → tarjeta <b>Permisos</b> → interruptor <b>"Coaches pueden remover deportistas de sus equipos"</b>, y luego <b>"Guardar Cambios"</b> arriba de la pestaña. Vale para todos los entrenadores de la escuela.</p>${await shot('e02-interruptor', 'El interruptor en Pagos → Config → Permisos (apagado de entrada)', 80)}`)
    + step(3, 'Con el permiso: pulsa "Remover"', `<p>Al abrir de nuevo la ventana, cada inscrito trae el botón rojo <b>"Remover"</b>. Al pulsarlo aparece el aviso <b>"Deportista removido"</b> y el deportista baja al bloque de disponibles.</p>${await shot('e03-con-permiso', 'Con el permiso, cada inscrito trae su botón "Remover"', 46)}`)
    + callout('warn', 'Antes de pulsar', '"Remover" se aplica <b>al instante, sin pedir confirmación</b>, y anula los cobros pendientes del deportista en esa categoría. Revisa bien el nombre. Si te equivocas, vuelve a inscribirlo y avísale a la administración para que revise sus cobros.')
    + callout('tip', 'Qué cubre el permiso', 'Solo las categorías que <b>tú entrenas</b>. Las inscripciones a <b>planes de pago</b> siguen siendo de la administración, con o sin el permiso.')
    + (interno ? callout('internal', 'INTERNO — Cómo está armado (2026-10-21)', 'Flag <code>school_settings.coach_can_remove_enrollments</code> (mig <code>20261021112614</code>, default <code>false</code>), expuesto al frontend por <code>useEntitlements().coachCanRemoveEnrollments</code>. "Remover" llama a <code>DELETE /api/v1/enrollments/:id</code>; para un coach el BFF exige el flag en <code>true</code> y que el equipo sea suyo (<code>teams.coach_id</code> o <code>team_coaches</code>); sin equipo (planes) responde 403. Desde <code>cc58ea88</code> la RLS de <code>enrollments</code> solo deja escribir a owner/admin: se quitó la policy viva <code>Staff can manage enrollments</code>, que dejaba al coach escribir cualquier inscripción de la escuela. El modal no tiene diálogo de confirmación.') : '')
    + `<div class="footer${interno ? ' internal-mark' : ''}"><span>SportMaps · ${interno ? 'Uso interno' : 'Guía de uso'}</span><span>Página 9 de 10</span></div></div>\n`;
}

async function actualizar(ver) {
  const file = path.join(MAN, ver, 'guia-entrenadores-asignar-categoria.html');
  let html = fs.readFileSync(file, 'utf8');
  if (html.includes('Remover a un deportista')) throw new Error(`${ver}: ya tiene la página nueva`);

  html = reemplazar(html, '<span class="pill">4 capítulos</span>', '<span class="pill">5 capítulos</span>');
  html = html.replace(/Página (\d+) de 9/g, (_, n) => `Página ${n} de 10`).replace('Página 9 de 10', 'Página 10 de 10');

  html = reemplazar(html, 'Hay cuatro cosas que el perfil de entrenador no hace. Todas se piden a la administración de la escuela.',
    'Hay cuatro cosas que el perfil de entrenador no hace por su cuenta. Se piden a la administración de la escuela, que en una de ellas, sacar deportistas, te puede dar el permiso.');
  html = reemplazar(html, 'Quitar una inscripción está reservado a la administración, aunque en la ventana veas el botón "Remover" junto a los inscritos. Indica el nombre, la categoría equivocada y la correcta, para que se resuelva de una sola vez.',
    'De entrada lo hace la administración. Indica el nombre, la categoría equivocada y la correcta, para que se resuelva de una sola vez. Si tu escuela te dio el permiso, lo haces tú con "Remover" (capítulo 5).');
  html = reemplazar(html, 'Pídele a tu administrador que lo remueva, e inscríbelo tú en la correcta.',
    'Si tu escuela te dio el permiso, pulsa "Remover" en la categoría equivocada e inscríbelo en la correcta. Si no, pídele a tu administrador que lo remueva, e inscríbelo tú en la correcta.');

  if (ver === 'interno') {
    // Las dos notas de 2026-10-20 describían un estado que ya no existe.
    html = html.replace(/<div class="callout internal"><span class="tag">INTERNO — Bug conocido \(2026-10-20\)<\/span>.*?<\/div>/s, '');
    html = html.replace(/<div class="callout internal"><span class="tag">INTERNO — El botón "Remover" existe pero falla<\/span>.*?<\/div>/s, '');
    if (html.includes('Bug conocido (2026-10-20)') || html.includes('existe pero falla')) throw new Error('quedaron notas viejas');
    html = reemplazar(html, '<b>4.</b> ¿Está mirando',
      '<b>4.</b> ¿No le aparece "Remover", o le sale "La escuela no permite que el entrenador remueva deportistas"? <code>select coach_can_remove_enrollments from school_settings where school_id = \'&lt;id&gt;\';</code> — se prende en Pagos → Config → Permisos.<br/>\n<b>5.</b> ¿Está mirando');
  }

  // La página nueva va justo antes de la de preguntas frecuentes.
  const faq = '<div class="page"><h3 style="font-size:20px;margin:0 0 14px;color:#123416">Preguntas frecuentes</h3>';
  html = reemplazar(html, faq, (await paginaRemover(ver)) + faq);
  fs.writeFileSync(file, html);
  return file;
}

const browser = await chromium.launch();
for (const ver of ['academias', 'interno']) {
  const html = await actualizar(ver);
  const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
  await page.goto(pathToFileURL(html).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const desborde = await page.evaluate(() => [...document.querySelectorAll('.page')]
    .map((el, i) => [i + 1, el.scrollHeight - el.clientHeight]).filter(([, d]) => d > 2));
  await page.pdf({ path: html.replace(/\.html$/, '.pdf'), width: '816px', height: '1056px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  console.log(`✅ ${ver}`, desborde.length ? `⚠️ desborde ${JSON.stringify(desborde)}` : 'sin desbordes');
  await page.close();
}
await browser.close();
