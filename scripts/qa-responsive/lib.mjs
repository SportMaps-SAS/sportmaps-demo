// Clasificación de hallazgos + mapeo a archivos fuente. Separado de la captura
// para poder recalibrar umbrales y regenerar el informe sin volver a navegar.
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './extract-routes.mjs';

export const CATEGORIES = {
  overflow:        { label: 'Desborde horizontal', sev: 'fail' },
  navHidden:       { label: 'Contenido tapado por la barra inferior', sev: 'fail' },
  navOverlap:      { label: 'Fijo/sticky encima de la barra inferior', sev: 'fail' },
  tabsClipped:     { label: 'Pestañas cortadas sin forma de llegar', sev: 'fail' },
  doubleScroll:    { label: 'Doble scroll vertical', sev: 'fail' },
  dialogOff:       { label: 'Modal con botones fuera de pantalla', sev: 'fail' },
  fontFallback:    { label: 'Fuente Poppins no cargó (fallback)', sev: 'fail' },
  fontLate:        { label: 'Poppins llegó tarde (fallback visible >0 s)', sev: 'warn' },
  pixelated:       { label: 'Imagen pixelada (≥1.5× de ampliación)', sev: 'fail' },
  zoomMissing:     { label: 'Controles inalcanzables con zoom', sev: 'fail' },
  zoomVariant:     { label: 'Controles que no aparecen con zoom (variante de breakpoint)', sev: 'warn' },
  overlapText:     { label: 'Textos encimados', sev: 'warn' },
  pixelatedSoft:   { label: 'Imagen algo blanda (1.1–1.5×)', sev: 'warn' },
  touch:           { label: 'Objetivos táctiles < 44×44', sev: 'warn' },
  textSmall:       { label: 'Texto < 12px', sev: 'warn' },
  inputZoom:       { label: 'Inputs < 16px (iOS hace zoom)', sev: 'warn' },
  tabsNoIndicator: { label: 'Pestañas con scroll sin indicador', sev: 'warn' },
  tabsBar:         { label: 'Scrollbar visible en pestañas/filtros', sev: 'warn' },
  tabsSmall:       { label: 'Pestañas < 44px de alto/ancho (móvil)', sev: 'warn' },
  tabsTruncated:   { label: 'Texto de pestaña truncado', sev: 'warn' },
  unexpectedH:     { label: 'Scroll horizontal interno inesperado', sev: 'warn' },
  blur:            { label: 'Texto potencialmente borroso (transform/filter/zoom)', sev: 'warn' },
  sidebarClipped:  { label: 'Ítems del menú lateral recortados', sev: 'warn' },
  console:         { label: 'Errores de consola', sev: 'warn' },
  http5xx:         { label: 'Peticiones 5xx', sev: 'warn' },
  http4xx:         { label: 'Peticiones 4xx', sev: 'warn' },
  pageError:       { label: 'Excepción JS no capturada', sev: 'warn' },
  // Reglas de la V2 y accesibilidad (DESIGN.md §2, §9, §12)
  contrast:        { label: 'Contraste por debajo de WCAG AA', sev: 'warn' },
  unnamed:         { label: 'Control sin nombre accesible', sev: 'warn' },
  v2Seguro:        { label: 'V2: «¿Seguro?» en vez de Deshacer', sev: 'warn' },
  v2Voseo:         { label: 'V2: voseo en pantalla (va de «tú»)', sev: 'warn' },
};

// Lista de hallazgos de un registro (un route × config).
export function classify(rec) {
  const issues = [];
  const add = (cat, n, samples = [], extra = {}) => issues.push({ cat, sev: CATEGORIES[cat].sev, n, samples, ...extra });
  if (rec.error) return { status: 'error', issues: [{ cat: 'error', sev: 'error', n: 1, samples: [{ text: rec.error }] }] };
  if (rec.authLost) return { status: 'error', issues: [{ cat: 'error', sev: 'error', n: 1, samples: [{ text: `redirigida a ${rec.finalUrl} (ruta sin permiso o rota; la sesión sigue viva en las siguientes)` }] }] };
  const c = rec.checks;
  if (!c) return { status: 'error', issues: [] };
  if (c.overflow.overflowPx > 1) add('overflow', c.overflow.offenderCount || 1, c.overflow.offenders, { px: c.overflow.overflowPx });
  if (c.bottomNav.present) {
    if (c.bottomNav.hiddenAtEnd.length) add('navHidden', c.bottomNav.hiddenAtEnd.length, c.bottomNav.hiddenAtEnd);
    // modales y toasts son capas que deben tapar todo: no cuentan
    const ov = c.bottomNav.overlapFixed.filter((s) => s.region !== 'dialog' && !/toast|z-\[100\]|fixed inset-0/.test(s.cls || ''));
    if (ov.length) add('navOverlap', ov.length, ov);
  }
  const clipped = c.tabs.filter((t) => t.clipped);
  if (clipped.length) add('tabsClipped', clipped.length, clipped);
  const noInd = c.tabs.filter((t) => t.scrollNoIndicator);
  if (noInd.length) add('tabsNoIndicator', noInd.length, noInd);
  const bar = [...c.tabs.filter((t) => t.visibleBar), ...c.scroll.tabsOrFiltersVisibleBar.filter((x) => !x.isTabs)];
  if (bar.length && rec.width >= 768) add('tabsBar', bar.length, bar);
  const smallT = c.tabs.filter((t) => t.smallTabs > 0);
  if (smallT.length) add('tabsSmall', smallT.reduce((n, t) => n + t.smallTabs, 0), smallT);
  const trunc = c.tabs.filter((t) => t.truncated && t.truncated.length);
  if (trunc.length) add('tabsTruncated', trunc.length, trunc);
  if (c.scroll.doubleV.length) add('doubleScroll', c.scroll.doubleV.length, c.scroll.doubleV);
  if (c.scroll.unexpectedH.length) add('unexpectedH', c.scroll.unexpectedH.length, c.scroll.unexpectedH);
  const dOff = (c.dialogs || []).filter((d) => d.unreachableButtons.length);
  if (dOff.length) add('dialogOff', dOff.length, dOff);
  if (c.fonts && c.fonts.poppins !== 'loaded') add('fontFallback', 1, [{ text: `Poppins=${c.fonts.poppins}; body=${c.fonts.bodyFamily}` }]);
  else if (c.fonts && c.fonts.lateMs > 0) add('fontLate', 1, [{ text: `Poppins cargó ${c.fonts.lateMs} ms después de la carga de la página` }]);
  // SVG servido sin extensión (p. ej. api.dicebear.com/…/svg?seed=) es vectorial: no pixela
  const imgs = c.images.pixelated.filter((i) => !/\/svg(\?|$)|format=svg|\.svg/i.test(i.src || ''));
  const hard = imgs.filter((i) => i.upscale >= 1.5);
  const soft = imgs.filter((i) => i.upscale < 1.5);
  if (hard.length) add('pixelated', hard.length, hard);
  if (soft.length) add('pixelatedSoft', soft.length, soft);
  if (c.blur.count) add('blur', c.blur.count, c.blur.samples);
  if (c.overlapText.count) add('overlapText', c.overlapText.count, c.overlapText.samples.map((o) => ({ ...o.a, text: `«${o.a.text}» × «${o.b.text}» (${o.overlapPct}%)` })));
  if (c.touch.count) add('touch', c.touch.count, c.touch.samples);
  if (c.textSmall.count) add('textSmall', c.textSmall.count, c.textSmall.samples);
  if (c.inputZoom.count) add('inputZoom', c.inputZoom.count, c.inputZoom.samples);
  if ((c.sidebarClipped || []).length) add('sidebarClipped', c.sidebarClipped.length, c.sidebarClipped.map((s) => ({ text: `${s.key} (${s.status})` })));
  if (rec.consoleCount) add('console', rec.consoleCount, rec.console.map((t) => ({ text: t })));
  const f5 = rec.failed.filter((f) => f.status >= 500 || f.status === 0);
  const f4 = rec.failed.filter((f) => f.status >= 400 && f.status < 500);
  if (f5.length) add('http5xx', f5.length, f5.map((f) => ({ text: `${f.status} ${f.method} ${f.url}` })));
  if (f4.length) add('http4xx', f4.length, f4.map((f) => ({ text: `${f.status} ${f.method} ${f.url}` })));
  // Registros capturados antes de estos chequeos no los traen: se omiten.
  if (c.contrast?.count) add('contrast', c.contrast.count, c.contrast.samples.map((x) => ({ ...x, text: `${x.ratio}:1 (mín ${x.min}) ${x.fg} sobre ${x.bg} · ${x.px}px — «${x.text}»` })));
  if (c.unnamed?.count) add('unnamed', c.unnamed.count, c.unnamed.samples);
  if (c.v2?.seguro?.length) add('v2Seguro', c.v2.seguro.length, c.v2.seguro);
  if (c.v2?.voseo?.length) add('v2Voseo', c.v2.voseo.length, c.v2.voseo);
  if (rec.pageErrors.length) add('pageError', rec.pageErrors.length, rec.pageErrors.map((t) => ({ text: t })));
  const status = issues.some((i) => i.sev === 'fail') ? 'fail' : issues.some((i) => i.sev === 'warn') ? 'warn' : 'pass';
  return { status, issues };
}

// Zoom: controles alcanzables a 100 % (v1440) que no lo son a otro nivel.
export function zoomMissing(baseRec, zoomRec) {
  if (!baseRec?.checks || !zoomRec?.checks) return [];
  const a = baseRec.checks.inventory || {}, b = zoomRec.checks.inventory || {};
  const probs = zoomRec.checks.inventoryProblems || {};
  const hidden = zoomRec.checks.inventoryHidden || {};
  const out = [];
  for (const [k, n] of Object.entries(a)) {
    const m = b[k] || 0;
    // listas de datos (filas) cambian de tamaño con la paginación/virtualización:
    // solo cuenta la desaparición total del control, no una fila menos.
    if (m !== 0) continue;
    if (/Cargando|Loading|\.\.\.$/i.test(k)) continue; // texto de carga: el control existe, cambió su rótulo
    // presente pero inalcanzable (recortado / fuera de pantalla) = bug seguro;
    // oculto por CSS o ausente = probable variante de breakpoint (p. ej. a 200 %
    // la ventana mide 720 px CSS y entra el layout de celular) → advertencia.
    const unreachable = !!probs[k];
    out.push({ key: k, at100: n, atZoom: m, unreachable,
      why: probs[k] || (hidden[k] ? 'oculto por CSS (variante de breakpoint)' : 'no existe en el DOM a este zoom') });
  }
  return out;
}

// ── mapeo a archivo fuente ──────────────────────────────────────────────────
let INDEX = null;
function loadIndex() {
  if (INDEX) return INDEX;
  const root = path.join(REPO, 'frontend', 'src');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|__tests__|test$/.test(e.name)) walk(p); }
      else if (/\.(tsx|ts)$/.test(e.name) && !/\.test\.|\.spec\.|\.d\.ts$/.test(e.name)) files.push({ rel: path.relative(REPO, p).replace(/\\/g, '/'), src: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(root);
  INDEX = { files, df: new Map(), memo: new Map() };
  return INDEX;
}
const df = (tok) => {
  const I = loadIndex();
  if (!I.df.has(tok)) I.df.set(tok, I.files.reduce((n, f) => n + (f.src.includes(tok) ? 1 : 0), 0));
  return I.df.get(tok);
};
const GENERIC = /^(flex|grid|block|hidden|relative|absolute|items-center|justify-between|gap-\d|w-full|h-full|p-\d|px-\d|py-\d|text-sm|text-xs|font-medium|font-semibold|rounded-md|rounded-lg|border|truncate|inline-flex|space-y-\d|min-w-0|flex-1|shrink-0)$/;

// ¿qué archivo pinta este elemento? Devuelve [{file, score, why}]
export function mapSource(sample, pageFile) {
  if (!sample) return [];
  const I = loadIndex();
  const key = (sample.cls || '') + '|' + (sample.text || '') + '|' + (pageFile || '') + '|' + (sample.region || '');
  if (I.memo.has(key)) return I.memo.get(key);
  const cls = (sample.cls || '').trim();
  const res = new Map();
  const bump = (file, s, why) => { const r = res.get(file) || { file, score: 0, why: [] }; r.score += s; r.why.push(why); res.set(file, r); };
  // 1) className completo (o su prefijo largo) literal en el fuente
  if (cls.length > 20) {
    const probe = cls.slice(0, 70);
    for (const f of I.files) if (f.src.includes(probe)) bump(f.rel, 10, 'className literal');
  }
  // 2) los tokens más raros
  const toks = [...new Set(cls.split(/\s+/))].filter((t) => t && t.length > 3 && !GENERIC.test(t));
  const ranked = toks.map((t) => [t, df(t)]).filter(([, n]) => n > 0 && n < 120).sort((a, b) => a[1] - b[1]).slice(0, 4);
  if (ranked.length) {
    for (const f of I.files) {
      const hits = ranked.filter(([t]) => f.src.includes(t));
      if (hits.length >= Math.min(2, ranked.length)) bump(f.rel, hits.reduce((s, [, n]) => s + 6 / n, 0), `tokens ${hits.map(([t]) => t).join(' ')}`);
    }
  }
  // 3) texto estático visible (títulos, etiquetas)
  const txt = (sample.text || '').trim();
  if (txt && txt.length >= 4 && txt.length <= 40 && !/\d{3,}|\$|@/.test(txt)) {
    for (const f of I.files) if (f.src.includes(`>${txt}<`) || f.src.includes(`'${txt}'`) || f.src.includes(`"${txt}"`) || f.src.includes(`>\n${txt}`)) bump(f.rel, 4, `texto «${txt}»`);
  }
  // 4) contexto de la página: el archivo de la ruta y lo que importa pesan más
  //    (solo si el elemento está en <main>: sidebar/header/barra son layout global)
  if (pageFile && res.size && (!sample.region || sample.region === 'main' || sample.region === 'dialog')) {
    const page = I.files.find((f) => f.rel === pageFile);
    for (const r of res.values()) {
      if (r.file === pageFile) { r.score *= 2; r.why.push('es la página'); continue; }
      const base = path.basename(r.file).replace(/\.(tsx|ts)$/, '');
      if (page && new RegExp(`from ['"][^'"]*/${base}['"]`).test(page.src)) { r.score *= 1.6; r.why.push('importado por la página'); }
    }
  }
  // componentes base de shadcn (ui/) explican el estilo, no el uso: van al final
  for (const r of res.values()) if (/components\/ui\//.test(r.file)) r.score *= 0.5;
  const out = [...res.values()].sort((a, b) => b.score - a.score).slice(0, 3);
  I.memo.set(key, out);
  return out;
}

// ruta → archivo de la página (App.tsx: <Route path=…> + lazy(import(…)))
let PAGES = null;
export function pageFileFor(routePath) {
  if (!PAGES) {
    PAGES = new Map();
    const app = fs.readFileSync(path.join(REPO, 'frontend/src/App.tsx'), 'utf8');
    const imports = new Map();
    for (const m of app.matchAll(/const (\w+) = lazy\(\(\) => import\(["']([^"']+)["']\)/g)) imports.set(m[1], m[2]);
    for (const m of app.matchAll(/^import (\w+) from ["'](\.\/[^"']+|@\/[^"']+)["']/gm)) imports.set(m[1], m[2]);
    const re = /path="([^"]+)"[\s\S]{0,400}?<(\w+)[\s/>]/g;
    for (const m of app.matchAll(re)) {
      // primer componente del element que sea una PÁGINA importada (salta
      // ProtectedRoute, ModuleGate, Suspense y demás envoltorios)
      const chunk = app.slice(m.index + m[0].indexOf('path='), m.index + 700).split('<Route ')[0];
      let comp = null;
      for (const mm of chunk.matchAll(/<([A-Z]\w+)[\s/>]/g)) {
        const imp0 = imports.get(mm[1]);
        if (imp0 && /pages\//.test(imp0)) { comp = mm[1]; break; }
      }
      if (!comp) comp = m[2];
      const imp = imports.get(comp);
      if (!imp) continue;
      const p = '/' + m[1].replace(/^\//, '');
      let rel = imp.replace(/^@\//, 'frontend/src/').replace(/^\.\//, 'frontend/src/');
      for (const ext of ['.tsx', '.ts', '/index.tsx']) if (fs.existsSync(path.join(REPO, rel + ext))) { rel += ext; break; }
      if (!PAGES.has(p)) PAGES.set(p, { comp, file: rel });
    }
  }
  const clean = routePath.split('?')[0].split('#')[0];
  if (PAGES.has(clean)) return PAGES.get(clean);
  for (const [k, v] of PAGES) {
    if (!k.includes(':')) continue;
    const re = new RegExp('^' + k.replace(/:[^/]+/g, '[^/]+') + '$');
    if (re.test(clean)) return v;
  }
  return null;
}
