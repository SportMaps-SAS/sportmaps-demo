// Piezas comunes para armar manuales PDF (academias + interno) con el sistema visual de
// tomar-asistencia (reusa su <head>). Extraído de _src/pagos-familias-registro/build.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, '../../../..');
export const MAN = path.join(repo, 'docs/manuales');
const { chromium } = createRequire(path.join(repo, 'frontend', 'package.json'))('playwright');
const sharp = createRequire(path.join(repo, 'bff', 'package.json'))('sharp');

/**
 * @param {string} dirShots carpeta de capturas
 * @param {Record<string, {left?:number, top?:number, width?:number, height?:number}>} recortes
 *        en píxeles de la captura; los lados que falten se completan con la imagen entera.
 */
export function crearPiezas(dirShots, recortes = {}) {
  async function img(id) {
    const file = path.join(dirShots, id + '.png');
    if (!fs.existsSync(file)) throw new Error(`Falta la captura ${id} — correr capture.mjs`);
    let buf = fs.readFileSync(file);
    const r = recortes[id];
    if (r) {
      const m = await sharp(buf).metadata();
      const left = r.left ?? 0, top = r.top ?? 0;
      buf = await sharp(buf).extract({ left, top, width: r.width ?? m.width - left, height: r.height ?? m.height - top }).png().toBuffer();
    }
    return `data:image/png;base64,${buf.toString('base64')}`;
  }
  const shot = async (id, caption, h = 300) =>
    `<div class="shot-wrap"><img class="shot" style="max-height:${h}px" src="${await img(id)}" /><div class="shot-caption">${caption}</div></div>`;
  const duo = async (a, ca, b, cb, h = 520) =>
    `<div class="duo"><div>${await shot(a, ca, h)}</div><div>${await shot(b, cb, h)}</div></div>`;
  return { img, shot, duo };
}

export const step = (n, title, body) =>
  `<div class="step"><div class="step-head"><div class="step-badge">${n}</div><div class="step-title">${title}</div></div>${body}</div>`;
export const chapter = (n, title, crumb) =>
  `<div class="chapter-head"><div class="chapter-badge">${n}</div><h2 class="chapter-title">${title}</h2></div>` +
  (crumb ? `<div class="breadcrumb">${crumb}</div>` : '') + '<hr class="chapter-rule" />';
export const callout = (kind, tag, body) => `<div class="callout ${kind}"><span class="tag">${tag}</span>${body}</div>`;
/** Bloque que solo sale en la versión interna. */
export const interno = (tag, body) => ({ interno: callout('internal', `INTERNO — ${tag}`, body) });
export const faq = (items) => `<h3 style="font-size:20px;margin:0 0 14px;color:#123416">Preguntas frecuentes</h3>` +
  items.map(([q, a]) => `<p><b>${q}</b><br/>${a}</p>`).join('\n');
export const lista = (items) => `<ul style="font-size:13.5px;line-height:1.55;color:#33413a;margin:0 0 10px 18px;padding:0">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

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
  const bloque = (b) => (typeof b === 'string' ? b : ver === 'interno' ? b.interno : '');
  const cuerpo = paginas.map((p, i) => `<div class="page">${p.map(bloque).join('\n')}${pie(i + 2)}</div>`).join('\n');
  return `${head}</head><body>\n${portada}\n${cuerpo}\n</body></html>`;
}

/** Escribe academias/ e interno/ <archivo>.html + .pdf y avisa si alguna página desborda. */
export async function construir(manual) {
  const browser = await chromium.launch();
  for (const ver of ['academias', 'interno']) {
    const html = path.join(MAN, ver, `${manual.archivo}.html`);
    fs.writeFileSync(html, documento(manual, ver));
    const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
    await page.goto(pathToFileURL(html).href, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const desborde = await page.evaluate(() => [...document.querySelectorAll('.page')]
      .map((el, i) => [i + 1, el.scrollHeight - el.clientHeight]).filter(([, d]) => d > 2));
    await page.pdf({ path: html.replace(/\.html$/, '.pdf'), width: '816px', height: '1056px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    console.log(`✅ ${ver}/${manual.archivo}.pdf`, desborde.length ? `⚠️ desborde en páginas ${JSON.stringify(desborde)}` : '');
    await page.close();
  }
  await browser.close();
}
