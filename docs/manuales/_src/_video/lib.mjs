// Motor de videos narrados para los manuales (2026-10-21).
//
// Cada video es una lista de pasos { dice, hace }: `dice` es la narración (voz
// edge-tts + subtítulo en pantalla) y `hace(ui)` las acciones en la app. Cada paso
// dura lo que dure su frase: la acción corre mientras habla y el paso no termina
// hasta que la voz termina. Al final ffmpeg pone cada frase en su segundo exacto.
//
// SIEMPRE contra el gemelo local (http://localhost:3101 + Supabase en Docker).
// Requiere en PATH (o en %LOCALAPPDATA%): ffmpeg/ffprobe y python con edge-tts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, '../../../..');
const { chromium } = createRequire(path.join(repo, 'frontend', 'package.json'))('playwright');
export const BASE = process.env.BASE_URL || 'http://localhost:3101';
const SB = 'http://127.0.0.1:54321';
if (!/localhost|127\.0\.0\.1/.test(BASE)) throw new Error('Solo gemelo local');
// Llave anon de DEMO de la CLI local (no es secreta, no sirve fuera de esta máquina).
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const PASS = 'QaGemelo2026!';
export const VOZ = process.env.VOZ || 'es-CO-GonzaloNeural';
const VELOCIDAD = process.env.VELOCIDAD || '+5%';
const ENSAYO = process.env.ENSAYO === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOCAL = process.env.LOCALAPPDATA || '';
const bin = (n) => {
  const p = path.join(LOCAL, 'ffmpeg', 'bin', n + '.exe');
  return fs.existsSync(p) ? p : n;
};
const FFMPEG = bin('ffmpeg');
const FFPROBE = bin('ffprobe');

export function sql(query) {
  return execFileSync('docker', ['exec', '-i', 'supabase_db_sportmaps-qa-twin', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'],
    { input: query, encoding: 'utf8' });
}

// ── Voz ──────────────────────────────────────────────────────────────────────
function duracion(file) {
  return Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
}
function tts(texto, dir) {
  const h = crypto.createHash('sha1').update(`${VOZ}|${VELOCIDAD}|${texto}`).digest('hex').slice(0, 12);
  const file = path.join(dir, `${h}.mp3`);
  if (!fs.existsSync(file)) {
    execFileSync('python', ['-m', 'edge_tts', '--voice', VOZ, `--rate=${VELOCIDAD}`, '--text', texto, '--write-media', file], { stdio: 'pipe' });
  }
  return { file, seg: duracion(file) };
}

// ── Capa visual: subtítulo + cursor, y limpieza del ambiente de QA ───────────
const OVERLAY = `
(() => {
  const montar = () => {
    if (!document.body || document.getElementById('__cap')) return;
    const cap = document.createElement('div'); cap.id = '__cap'; if (window.__sinCap) cap.style.visibility = 'hidden';
    Object.assign(cap.style, { position: 'fixed', left: '24px', bottom: '24px',
      maxWidth: '58vw', padding: '12px 22px', borderRadius: '14px', background: 'rgba(10,20,14,0.88)', color: '#fff',
      font: '600 21px/1.4 Inter, system-ui, sans-serif', boxShadow: '0 8px 30px rgba(0,0,0,.45)',
      border: '1px solid rgba(79,209,122,.55)', zIndex: '2147483647', pointerEvents: 'none', display: 'none', textAlign: 'left' });
    document.body.appendChild(cap);
    const cur = document.createElement('div'); cur.id = '__cur';
    Object.assign(cur.style, { position: 'fixed', left: '-40px', top: '-40px', width: '22px', height: '22px', borderRadius: '50%',
      background: 'rgba(255,136,51,.85)', border: '3px solid #fff', boxShadow: '0 0 0 4px rgba(255,136,51,.35)',
      transform: 'translate(-50%,-50%)', transition: 'transform .12s', zIndex: '2147483647', pointerEvents: 'none' });
    document.body.appendChild(cur);
    const mv = (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; };
    window.addEventListener('mousemove', mv, true); window.addEventListener('pointermove', mv, true);
    window.addEventListener('pointerdown', () => { cur.style.transform = 'translate(-50%,-50%) scale(0.65)'; }, true);
    window.addEventListener('pointerup', () => { cur.style.transform = 'translate(-50%,-50%) scale(1)'; }, true);
    let t = window.__capText; try { t = t || sessionStorage.getItem('__capText'); } catch {} if (t) { cap.textContent = t; cap.style.display = 'block'; }
  };
  const limpiar = () => {
    for (const el of document.querySelectorAll('body *')) {
      if (el.childElementCount === 0 && /AMBIENTE DE QA/i.test(el.textContent || '')) {
        (el.closest('div[class*="fixed"],div[class*="sticky"]') || el.parentElement || el).remove();
      }
    }
    for (const b of document.querySelectorAll('button')) if (/soporte|ayuda/i.test(b.getAttribute('aria-label') || '')) b.style.display = 'none';
  };
  setInterval(() => { montar(); limpiar(); }, 150);
})();`;

async function login(usuario) {
  const res = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
    // Con correo completo es una cuenta de la escuela demo copiada de la viva (clonar-demo.mjs).
    body: JSON.stringify(usuario.includes('@') ? { email: usuario, password: 'Demo2026!' } : { email: `${usuario}@qa.sportmaps.test`, password: PASS }),
  });
  if (!res.ok) throw new Error(`login ${usuario}: ${res.status}`);
  return res.json();
}

// ── Grabación ────────────────────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {string} o.nombre    archivo de salida (docs/manuales/video/<nombre>.mp4)
 * @param {string} o.usuario   alias de la semilla (…@qa.sportmaps.test)
 * @param {string} o.inicio    ruta inicial
 * @param {string} [o.esperar] texto que confirma que la ruta inicial cargó
 * @param {{dice:string, hace?:(ui)=>Promise<void>, pausa?:number}[]} o.pasos
 * @param {string} o.trabajo   carpeta de trabajo (ignorada por git)
 * @param {(ui)=>Promise<void>} [o.preparar] acciones antes del primer paso (quedan fuera del video)
 * @param {boolean} [o.movil]  video vertical de celular: subtitulo en una franja debajo de la pantalla, sin tapar la barra de pestanas
 * @param {boolean} [o.webgl]  visor 3D de la pizarra: sin el piso de fps (el WebGL es por software)
 */
export async function grabar({ nombre, usuario, inicio, esperar, pasos, trabajo, viewport = { width: 1440, height: 810 }, almacenamiento = {}, preparar, webgl = false, movil = false }) {
  if (movil) viewport = { width: 390, height: 780 };
  const escala = movil ? 2 : 1;
  const dirTts = path.join(trabajo, 'tts'); fs.mkdirSync(dirTts, { recursive: true });
  const dirRaw = path.join(trabajo, 'raw'); fs.rmSync(dirRaw, { recursive: true, force: true }); fs.mkdirSync(dirRaw, { recursive: true });

  console.log(`Voz ${VOZ}: generando ${pasos.length} frases…`);
  const audios = pasos.map((p) => tts(p.dice, dirTts));

  const sesion = await login(usuario);

  // Chromium headless ya trae WebGL por software (SwiftShader); forzarlo con --use-angle
  // vuelve lento todo el navegador. Para el 3D basta con quitar el piso de fps.
  const browser = await chromium.launch(movil ? { args: ['--force-device-scale-factor=2'] } : {}); // sin esto el video de 2x sale con la app en un cuarto del cuadro
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: escala, locale: 'es-CO', timezoneId: 'America/Bogota', acceptDownloads: true, recordVideo: { dir: dirRaw, size: { width: viewport.width * escala, height: viewport.height * escala } } });
  if (movil) await ctx.addInitScript(() => { window.__sinCap = true; });
  if (webgl) await ctx.addInitScript(() => { window.__TACTICAL3D_MIN_FPS__ = 0; });
  await ctx.addInitScript(([k, v]) => {
    try { if (!sessionStorage.getItem('__sesionFija')) localStorage.setItem(k, v); localStorage.setItem('sm_push_banner_dismissed', '1'); } catch {}
  }, ['sb-127-auth-token', JSON.stringify(sesion)]);
  // Valores fijos de localStorage (p. ej. interruptores de QA como 'sportmaps:cobros-y-pagos').
  await ctx.addInitScript((kv) => { try { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); } catch {} }, almacenamiento);
  await ctx.addInitScript(OVERLAY);
  const page = await ctx.newPage();
  page.setDefaultTimeout(movil ? 12000 : 30000); // que un selector equivocado falle claro, no que se quede esperando
  const t0 = Date.now();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 160)));

  // ui: acciones con cursor visible
  const ui = {
    page,
    sleep,
    async ir(ruta, texto) {
      await page.goto(BASE + ruta);
      if (texto) await page.getByText(texto, { exact: false }).first().waitFor({ timeout: 30000 });
      await page.waitForLoadState('networkidle').catch(() => {});
    },
    async mover(loc, { pasos: steps = 28, dx = 0.5, dy = 0.5 } = {}) {
      loc = loc.first();
      // En el celular, desplazamiento suave y al centro: scrollIntoViewIfNeeded espera a que la
      // pagina quede estable y deja el cursor varios segundos atras de la voz.
      if (movil) {
        const fuera = await loc.evaluate((e) => { const r = e.getBoundingClientRect(); return r.top < 70 || r.bottom > innerHeight - 90; });
        if (fuera) { await loc.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'smooth' })); await sleep(650); }
      } else await loc.scrollIntoViewIfNeeded().catch(() => {});
      const b = await loc.boundingBox();
      if (!b) throw new Error('Elemento sin caja: ' + loc);
      await page.mouse.move(b.x + b.width * dx, b.y + b.height * dy, { steps });
      await sleep(250);
    },
    async clic(loc, opts = {}) { await ui.mover(loc, opts); await loc.first().click({ force: !!opts.forzar }); await sleep(500); },
    /** Cambia de usuario sin cortar la grabación (misma pestaña, otra sesión). */
    async entrarComo(otro, ruta, texto) {
      const ses = await login(otro);
      await page.evaluate((v) => { sessionStorage.setItem('__sesionFija', '1'); localStorage.setItem('sb-127-auth-token', v); }, JSON.stringify(ses));
      await ui.ir(ruta, texto);
    },
    async rueda(dy, n = 6) { for (let i = 0; i < n; i++) { await page.mouse.wheel(0, dy / n); await sleep(60); } },
  };

  await ui.ir(inicio, esperar);
  if (preparar) await preparar(ui);
  await sleep(800);
  const tInicio = (Date.now() - t0) / 1000; // se recorta todo lo anterior (pantalla en blanco, carga)

  const marcas = [];
  for (let i = 0; i < pasos.length; i++) {
    const p = pasos[i];
    await page.evaluate((t) => { window.__capText = t; try { sessionStorage.setItem('__capText', t); } catch {} const c = document.getElementById('__cap'); if (c) { c.textContent = t; c.style.display = 'block'; } }, p.dice);
    const t = (Date.now() - t0) / 1000;
    marcas.push(t);
    console.log(`  ${String(i + 1).padStart(2)} · t=${(t - tInicio).toFixed(1)} s · voz ${audios[i].seg.toFixed(1)} s · ${p.dice.slice(0, 60)}`);
    // ENSAYO=1: sin esperar la voz y con una captura por paso, para probar el guion rapido.
    if (ENSAYO) {
      if (p.hace) await p.hace(ui).catch(async (e) => { await page.screenshot({ path: path.join(trabajo, 'ensayo-fallo.png') }); throw e; });
      await sleep(300);
      await page.screenshot({ path: path.join(trabajo, `ensayo-${String(i + 1).padStart(2, '0')}.png`) });
    } else await Promise.all([p.hace ? p.hace(ui) : Promise.resolve(), sleep(audios[i].seg * 1000 + (p.pausa ?? 450))]);
  }
  if (ENSAYO) { await ctx.close(); await browser.close(); console.log(`Ensayo OK: ${pasos.length} pasos`); return null; }
  await sleep(900);
  const tFin = (Date.now() - t0) / 1000;
  const raw = await page.video().path();
  await ctx.close(); await browser.close();

  // ── Mezcla: video recortado + cada frase en su segundo ─────────────────────
  const outDir = path.join(repo, 'docs/manuales/video'); fs.mkdirSync(outDir, { recursive: true });
  const mp4 = path.join(outDir, `${nombre}.mp4`);
  // Subtitulos aparte (.srt), por si se sube a YouTube o se quieren sin quemar.
  const srt = marcas.map((m, i) => {
    const ini = m - tInicio, fin = movil && i + 1 < marcas.length ? marcas[i + 1] - tInicio : ini + audios[i].seg;
    const f = (s) => new Date(Math.max(0, s) * 1000).toISOString().slice(11, 23).replace('.', ',');
    return `${i + 1}\n${f(ini)} --> ${f(fin)}\n${pasos[i].dice}\n`;
  }).join('\n');
  const srtFile = mp4.replace(/\.mp4$/, '.srt');
  fs.writeFileSync(srtFile, srt);
  const args = ['-y', '-loglevel', 'error', '-ss', tInicio.toFixed(2), '-t', (tFin - tInicio).toFixed(2), '-i', raw];
  audios.forEach((a) => args.push('-i', a.file));
  const filtros = audios.map((a, i) => `[${i + 1}:a]adelay=${Math.max(0, Math.round((marcas[i] - tInicio) * 1000))}:all=1[a${i}]`);
  filtros.push(`${audios.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audios.length}:normalize=0,apad[aud]`);
  const FRANJA = 300;
  if (movil) filtros.push(`[0:v]pad=${viewport.width * escala}:${viewport.height * escala + FRANJA}:0:0:color=0x0f2614,subtitles='${path.basename(srtFile)}':original_size=${viewport.width * escala}x${viewport.height * escala + FRANJA}:force_style='FontName=Arial,FontSize=7,Bold=1,PrimaryColour=&H00FFFFFF,BorderStyle=1,Outline=0,Shadow=0,Alignment=2,MarginL=8,MarginR=8,MarginV=6'[vid]`);
  args.push('-filter_complex', filtros.join(';'), '-map', movil ? '[vid]' : '0:v', '-map', '[aud]', '-shortest',
    '-c:v', 'libx264', '-preset', movil ? 'veryfast' : 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', mp4);
  execFileSync(FFMPEG, args, { stdio: 'inherit', cwd: outDir });

  console.log(`✅ ${path.relative(repo, mp4)} (${(tFin - tInicio).toFixed(0)} s, voz ${VOZ})`);
  return mp4;
}
