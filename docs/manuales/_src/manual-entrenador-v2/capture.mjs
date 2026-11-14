// Capturas REALES + pruebas del Entrenador V2 (manual docs/manuales/v2/).
// Patrón: memoria feedback_pdf_manual_template (nunca mockups).
//
//   node docs/manuales/_src/manual-entrenador-v2/capture.mjs <seccion> [<seccion>…]
//   node docs/manuales/_src/manual-entrenador-v2/capture.mjs todo
//
// Secciones: perfil hoy equipos partidoA criterios partidoB partidoC calendario
//            sesiones asistencia planillas matricula mas
//
// Ambiente: BASE_URL (por defecto https://dev.sportmaps.co), que apunta a la Supabase
// compartida. Tenant: Club Campestre Demo (is_demo=true). Entrenador: Andrés Ríos
// (entrenador.futbol@demo.sportmaps.co, creado con scripts/demo-club-campestre/add-coach.mjs).
//
// Cada sección guarda:
//   shots/<nn>-<nombre>.png         captura (390×844 @3x, móvil; las de escritorio 1600×1000 @2x)
//   shots/_texto/<nn>-<nombre>.txt  texto visible de la pantalla (para revisar y para el reporte)
//   shots/_datos.json               ids de lo creado (partidos, eventos, listas…)
// Las secciones que CREAN datos miran primero si ya existen (por rival/fecha/título) y no duplican.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const require = createRequire(path.join(repo, 'frontend', 'package.json'));
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'https://dev.sportmaps.co';
const SHOTS = path.join(here, 'shots');
const TXT = path.join(SHOTS, '_texto');
fs.mkdirSync(TXT, { recursive: true });
const DATOS_F = path.join(SHOTS, '_datos.json');
const datos = fs.existsSync(DATOS_F) ? JSON.parse(fs.readFileSync(DATOS_F, 'utf8')) : {};
const guardarDatos = () => fs.writeFileSync(DATOS_F, JSON.stringify(datos, null, 2));

function readEnv(dir, files) {
  const env = {};
  for (const f of files) {
    const fp = path.join(repo, dir, f);
    if (!fs.existsSync(fp)) continue;
    for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"#]*)"?\s*$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return env;
}
const FE = readEnv('frontend', ['.env', '.env.local']);
const SUPABASE_URL = FE.VITE_SUPABASE_URL;
const SUPABASE_KEY = FE.VITE_SUPABASE_PUBLISHABLE_KEY || FE.VITE_SUPABASE_ANON_KEY;
// Solo LECTURA con la service key (verificar qué existe antes de crear). Toda escritura
// pasa por la interfaz, con la sesión del entrenador o del owner.
const BFF = readEnv('bff', ['.env']);
const SR = BFF.SUPABASE_SERVICE_ROLE_KEY;

const PASSWORD = 'Demo2026!';
const COACH = 'entrenador.futbol@demo.sportmaps.co';
const OWNER = 'gerencia@demo.sportmaps.co';
const SCHOOL = '25a123f0-6d57-48a4-9800-7b1531d61cd2';
const SUB15 = '658d014e-26b9-44dd-bfde-8eed0a3a14ac';
const SUB12 = '92ee5e2a-5bcb-4850-974f-e3a2d52b74c2';

const hoyCO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const masDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function leer(q) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
  if (!r.ok) throw new Error(`leer ${q}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function loginAs(context, email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login ${email}: ${res.status} ${await res.text()}`);
  const session = await res.json();
  const ref = new URL(SUPABASE_URL).host.split('.')[0];
  await context.addInitScript(([key, value]) => {
    try {
      window.localStorage.setItem(key, value);
      window.localStorage.setItem('sm_push_banner_dismissed', '1'); // banner «Activa las notificaciones»
    } catch {}
  }, [`sb-${ref}-auth-token`, JSON.stringify(session)]);
}

// El Playwright del repo puede pedir una versión de Chromium que no está descargada:
// se usa la más nueva que haya en la caché local.
function launch() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]);
    for (const d of dirs) {
      const exe = path.join(base, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return chromium.launch({ executablePath: exe });
    }
  }
  return chromium.launch();
}

const httpErrores = [];
async function sesion(browser, email, { desk = false } = {}) {
  const context = await browser.newContext(desk
    ? { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, locale: 'es-CO', timezoneId: 'America/Bogota' }
    : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'es-CO', timezoneId: 'America/Bogota' });
  await loginAs(context, email);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  page.on('response', (r) => {
    if (r.status() >= 400 && /supabase\.co|bff|onrender/.test(r.url())) {
      const linea = `${r.status()} ${r.request().method()} ${r.url().replace(/\?.*/, '')}`;
      httpErrores.push(linea);
      console.log('  [http]', linea);
    }
  });
  return { context, page };
}

async function ir(page, ruta, ms = 3500) {
  // Un redirect de la página anterior a veces aborta la navegación: un reintento.
  await page.goto(BASE_URL + ruta).catch(async (e) => {
    if (!/ERR_ABORTED/.test(e.message)) throw e;
    await page.waitForTimeout(1500);
    await page.goto(BASE_URL + ruta);
  });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function shot(page, nombre, { full = false } = {}) {
  await page.screenshot({ path: path.join(SHOTS, `${nombre}.png`), fullPage: full });
  const texto = await page.evaluate(() => document.querySelector('main')?.innerText || document.body.innerText);
  fs.writeFileSync(path.join(TXT, `${nombre}.txt`), `${page.url()}\n\n${texto}`);
  console.log(`  📸 ${nombre}`);
}
const espera = (page, ms = 1200) => page.waitForTimeout(ms);

// ─────────────────────────────────────────────────────────────────────────────
const SECCIONES = {};

// 1 · Primer ingreso: perfil profesional (se abre solo la primera vez en Hoy)
SECCIONES.perfil = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/dashboard', 5000);
  const dlg = page.getByRole('dialog').filter({ hasText: 'Perfil Profesional' });
  if (!(await dlg.count())) { console.log('  · el perfil profesional ya estaba completo'); await context.close(); return; }
  await shot(page, '01-perfil-vacio');
  const campo = (label) => dlg.locator(`xpath=.//label[contains(., "${label}")]/following::input[1]`);
  await campo('Nombre Completo').fill('Andrés Ríos');
  await campo('Número de Documento').fill('1020304050');
  await campo('WhatsApp').fill('3115550203');
  await dlg.locator('xpath=.//label[contains(., "Deporte Principal")]/following::button[@role="combobox"][1]').click();
  await page.getByRole('option', { name: /^Fútbol$/ }).first().click();
  await espera(page, 600);
  await shot(page, '02-perfil-lleno');
  await dlg.getByRole('button', { name: 'Siguiente' }).click();
  await espera(page, 1000);
  await shot(page, '03-perfil-certificados');
  await dlg.getByRole('button', { name: /Guardar Perfil/ }).last().click();
  await espera(page, 4000);
  await shot(page, '04-hoy-tras-perfil');
  await context.close();
};

// 2 · Hoy
SECCIONES.hoy = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/dashboard', 5000);
  await shot(page, '05-hoy');
  await shot(page, '05-hoy-full', { full: true });
  await context.close();
};

// 3 · Equipos: lista, deportistas, ficha, felicitar
SECCIONES.equipos = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/teams', 4000);
  await shot(page, '10-equipos');
  await ir(page, `/teams?equipo=${SUB15}&tab=deportistas`, 6000);
  await shot(page, '11-deportistas');
  await page.getByText('Tomás Herrera', { exact: true }).click();
  await espera(page, 1200);
  await shot(page, '12-deportista-acciones');
  await page.getByRole('button', { name: 'Felicitar' }).first().click().catch(() => page.getByText('Felicitar').first().click());
  await espera(page, 1500);
  await shot(page, '13-felicitar');
  await page.keyboard.press('Escape');
  await espera(page, 800);
  await page.getByText('Ver ficha').first().click();
  await espera(page, 5000);
  await shot(page, '14-ficha');
  await shot(page, '14-ficha-full', { full: true });
  await ir(page, `/teams?equipo=${SUB15}&tab=evaluar`, 6000);
  await shot(page, '15-equipo-evaluar');
  await context.close();
};

// ── Partidos ────────────────────────────────────────────────────────────────
async function partidoExistente(teamId, rival, fecha) {
  const r = await leer(`match_results?team_id=eq.${teamId}&opponent=eq.${encodeURIComponent(rival)}&match_date=eq.${fecha}&select=id,status,home_score,away_score`);
  return r[0] ?? null;
}

/** Programar un partido desde Equipos → Partidos → «+ Partido». Devuelve el id. */
async function programar(page, { teamId, rival, fecha, hora, lugar, tipo, nota, yaSeJugo, prefijo }) {
  await ir(page, `/teams?equipo=${teamId}&tab=partidos`, 5000);
  if (prefijo) await shot(page, `${prefijo}-tab-antes`);
  await page.getByRole('link', { name: /Partido$/ }).first().click();
  await espera(page, 3000);
  await page.locator('#pf-rival').fill(rival);
  await page.locator('#pf-fecha').fill(fecha);
  if (hora) await page.locator('#pf-hora').fill(hora);
  if (lugar) await page.locator('#pf-lugar').fill(lugar);
  if (tipo) await page.getByRole('button', { name: tipo, exact: true }).first().click().catch(() => page.getByText(tipo, { exact: true }).first().click());
  if (nota) await page.locator('#pf-notas').fill(nota);
  await espera(page, 500);
  if (prefijo) { await shot(page, `${prefijo}-programar`); await shot(page, `${prefijo}-programar-full`, { full: true }); }
  const boton = yaSeJugo ? /registrar el resultado/ : /Programar y convocar/;
  await page.getByRole('button', { name: boton }).first().click();
  await page.waitForURL(/\/partidos\/[0-9a-f-]{36}/, { timeout: 20000 });
  await espera(page, 3000);
  return page.url().match(/\/partidos\/([0-9a-f-]{36})/)[1];
}

const FUTURO = () => masDias(hoyCO(), 5);

// Partido A: por jugar (programar, convocar y avisar, calendario, pizarra) — Sub-12
SECCIONES.partidoA = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  const fecha = masDias(hoyCO(), 12);
  const rival = 'Deportivo Suba';
  let id = (await partidoExistente(SUB12, rival, fecha))?.id;
  if (!id) {
    id = await programar(page, { teamId: SUB12, rival, fecha, hora: '09:00', lugar: 'Cancha mini fútbol, Club Campestre', tipo: 'Liga', nota: 'Llegar 8:15 a.m. con uniforme blanco.', prefijo: '20' });
    console.log('  ✓ partido A creado', id);
  } else { await ir(page, `/partidos/${id}?paso=convocar`, 5000); }
  datos.partidoA = { id, rival, fecha, equipo: 'Fútbol — Sub-12' };
  await shot(page, '21-convocar');
  const conv = page.getByRole('button', { name: /^Convocar/ });
  if (await conv.count()) {
    fs.writeFileSync(path.join(TXT, '21-boton.txt'), await conv.first().innerText());
    await conv.first().click();
    await espera(page, 3500);
    await shot(page, '22-convocados');
  }
  await ir(page, `/teams?equipo=${SUB12}&tab=partidos`, 6000);
  await shot(page, '23-tab-proximo');
  await shotEn(page, '23b-tab-proximo-abajo', 'Armar la alineación', { bloque: 'center' });
  await page.getByRole('button', { name: /alineación en la pizarra/ }).click();
  await espera(page, 5000);
  await shot(page, '24-pizarra');
  await context.close();
  datos.partidoA.eventos = await leer(`calendar_events?school_id=eq.${SCHOOL}&title=ilike.*Suba*&select=id,title,event_type,start_time,team_id`);
  console.log('  · eventos ligados:', JSON.stringify(datos.partidoA.eventos));
};

// Partido B: se jugó hoy → convocar, resultado con gol/asistencia/tarjeta, evaluar, reporte
SECCIONES.partidoB1 = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  const fecha = hoyCO();
  const rival = 'Atlético Sabana';
  let id = (await partidoExistente(SUB15, rival, fecha))?.id;
  if (!id) {
    id = await programar(page, { teamId: SUB15, rival, fecha, hora: '08:00', lugar: 'Cancha fútbol 11', tipo: 'Amistoso', yaSeJugo: true, prefijo: '30' });
    console.log('  ✓ partido B creado', id);
  }
  datos.partidoB = { id, rival, fecha, equipo: 'Fútbol — Sub-15' };
  // Convocar a 3 de 4 (Julieta no fue)
  await ir(page, `/partidos/${id}?paso=convocar`, 5000);
  const julieta = page.getByRole('checkbox', { name: /Julieta/ }).or(page.locator('[aria-checked]').filter({ hasText: 'Julieta' }));
  if (await page.getByRole('button', { name: /^Convocar/ }).count()) {
    if ((await julieta.first().getAttribute('aria-checked')) === 'true') await julieta.first().click();
    await espera(page, 500);
    await shot(page, '31-convocar-3');
    await page.getByRole('button', { name: /^Convocar/ }).first().click();
    await espera(page, 3500);
  }
  await shot(page, '32-convocados');
  await page.getByRole('button', { name: /Siguiente: resultado/ }).click();
  await espera(page, 3000);
  await shot(page, '33-resultado-vacio');
  const yaHay = await leer(`match_results?id=eq.${id}&select=status`);
  if (yaHay[0]?.status !== 'played') {
    const anotar = async (nombre, accion) => {
      const [n1, n2] = nombre.split(' ');
      const fila = page.locator('button[aria-expanded]').filter({ hasText: `${n1} ${n2[0]}.` }).first();
      if ((await fila.getAttribute('aria-expanded')) !== 'true') await fila.click();
      await espera(page, 500);
      await page.getByRole('button', { name: new RegExp(`Sumar ${accion} a ${nombre}`) }).click();
      await espera(page, 2500);
    };
    await anotar('Tomás Herrera', 'gol');
    await shot(page, '34-gol-anotado');
    await anotar('Renata Cárdenas', 'asistencia');
    await anotar('Tomás Duarte', 'amarilla');
    await page.getByRole('button', { name: `Sumar un gol a ${rival}` }).click().catch(() => {});
    await espera(page, 800);
    await page.getByRole('button', { name: `Restar un gol a ${rival}` }).click().catch(() => {});
    await espera(page, 800);
    await shot(page, '35-resultado-lleno');
    await shot(page, '35-resultado-lleno-full', { full: true });
    await page.getByRole('button', { name: /Guardar resultado/ }).click();
    await espera(page, 4000);
  }
  await ir(page, `/partidos/${id}?paso=evaluar`, 5000);
  await shot(page, '36-evaluar-sin-criterios');
  await context.close();
};

/**
 * BUG (ver pruebas-entrenador-v2.md): en el celular la barra fija de «Guardar resultado» /
 * «Guardar evaluación» (PartidoFlujo.tsx:622 y :850, z-20) queda DEBAJO de la barra inferior
 * de la app (MobileBottomNav, z-30). Un usuario no la puede tocar. Para seguir probando el
 * resto del flujo, se dispara el clic por código y se deja anotado.
 */
async function clicTapado(page, nombre) {
  const b = page.getByRole('button', { name: nombre }).first();
  const tapado = await b.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(top === el || el.contains(top));
  });
  if (tapado) console.log(`  ⚠ «${nombre}» está tapado por otra capa: clic forzado por código`);
  datos.tapados = [...new Set([...(datos.tapados ?? []), String(nombre)])];
  await b.dispatchEvent('click');
}

SECCIONES.partidoB2 = async (browser) => {
  const id = datos.partidoB.id;
  const { context, page } = await sesion(browser, COACH);
  const st = (await leer(`match_results?id=eq.${id}&select=status`))[0]?.status;
  if (st !== 'played') {
    await ir(page, `/partidos/${id}?paso=cerrar`, 5000);
    await shot(page, '35b-resultado-boton-tapado');
    await clicTapado(page, /Guardar resultado/);
    await espera(page, 4000);
  }
  await ir(page, `/partidos/${id}?paso=evaluar`, 5000);
  await shot(page, '40-evaluar-lista');
  const ev = await leer(`performance_entries?source_id=eq.${id}&select=id&limit=1`).catch(() => []);
  await page.getByRole('button', { name: /Tomás H\./ }).first().click();
  await espera(page, 1200);
  if (!ev.length) {
    const notas = [4, 5, 4, 3, 4, 5];
    const radios = page.locator('main button[role="radio"]');
    for (let i = 0; i < notas.length; i++) { await radios.nth(i * 5 + notas[i] - 1).click(); await espera(page, 150); }
    await page.locator('main textarea').first().fill('Gran partido: abrió el marcador y presionó la salida rival. A mejorar: el perfil para recibir.');
    await espera(page, 500);
  }
  await shot(page, '41-evaluar-tomas');
  await shot(page, '41-evaluar-tomas-full', { full: true });
  if (!ev.length) { await clicTapado(page, /^Guardar evaluación$/); await espera(page, 4000); }
  await shot(page, '42-evaluacion-guardada');
  await shot(page, '42-evaluacion-guardada-full', { full: true });
  await ir(page, `/partidos/${id}?paso=reporte`, 5000);
  await shot(page, '43-reporte');
  await page.getByRole('button', { name: /Escribir el reporte|Ver o editar el reporte/ }).click();
  await espera(page, 1500);
  const dlg = page.getByRole('dialog').last();
  if (!(await dlg.locator('textarea').first().inputValue())) {
    const t = dlg.locator('textarea');
    await t.nth(0).fill('Ganamos 1–0 un partido parejo. Buen orden defensivo.');
    await t.nth(1).fill('Arrancamos presionando alto; el gol llegó al minuto 18 tras una recuperación de Renata. En el segundo tiempo cuidamos la pelota.');
    await t.nth(2).fill('Salida desde el fondo bajo presión y finalización.');
    await dlg.locator('#mr-publish').click().catch(() => {});
  }
  await espera(page, 600);
  await shot(page, '44-reporte-dialogo');
  await dlg.getByRole('button', { name: /Guardar|Publicar/ }).last().click();
  await espera(page, 3500);
  await shot(page, '45-reporte-guardado');
  // La lista de partidos del equipo con el resultado nuevo
  await ir(page, `/teams?equipo=${SUB15}&tab=partidos`, 6000);
  await shot(page, '46-tab-resultados-full', { full: true });
  await context.close();
  // En escritorio la misma pantalla sí muestra el botón (md:static)
  const d = await sesion(browser, COACH, { desk: true });
  await ir(d.page, `/partidos/${id}?paso=cerrar`, 5000);
  await shot(d.page, '47-escritorio-resultado');
  await d.context.close();
};

/** Hace scroll hasta un texto y toma la pantalla (la app hace scroll en un contenedor interno). */
async function shotEn(page, nombre, texto, { bloque = 'start' } = {}) {
  const el = typeof texto === 'string' ? page.getByText(texto, { exact: false }).first() : texto;
  await el.evaluate((e, b) => e.scrollIntoView({ block: b }), bloque).catch(() => {});
  await espera(page, 700);
  await shot(page, nombre);
}

// Partido C: ya se jugó y nadie registró el marcador → «Falta el resultado»
SECCIONES.partidoC = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  const fecha = masDias(hoyCO(), -3);
  const rival = 'Deportivo Chía';
  let id = (await partidoExistente(SUB15, rival, fecha))?.id;
  if (!id) {
    id = await programar(page, { teamId: SUB15, rival, fecha, tipo: 'Liga', yaSeJugo: true, prefijo: '50' });
    console.log('  ✓ partido C creado (sin resultado)', id);
    await shot(page, '51-ya-se-jugo-resultado');
  }
  datos.partidoC = { id, rival, fecha, equipo: 'Fútbol — Sub-15' };
  await ir(page, `/teams?equipo=${SUB15}&tab=partidos`, 6000);
  await shotEn(page, '52-falta-el-resultado', 'Falta el resultado');
  await shotEn(page, '53-resultados', 'Resultados', { bloque: 'center' });
  await context.close();
};

// Calendario: evento tipo Partido para un equipo → crea el partido (create_match) y ofrece «Abrir partido»
SECCIONES.calendario = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/calendar', 5000);
  await shot(page, '60-calendario');
  const titulo = 'Partido vs Club Los Andes';
  const ya = await leer(`calendar_events?school_id=eq.${SCHOOL}&title=eq.${encodeURIComponent(titulo)}&select=id,team_id,start_time`);
  {
    await page.getByRole('button', { name: /Nuevo Evento|Nuevo evento/ }).first().click();
    const dlg = page.getByRole('dialog');
    await dlg.waitFor();
    await espera(page, 800);
    await shot(page, '61-nuevo-evento');
    await dlg.getByPlaceholder(/Campeonato/).fill(titulo);
    const paraQuien = dlg.locator('div.space-y-2:has(label:has-text("Para quién")) [role="combobox"]');
    await paraQuien.click();
    await page.getByRole('option', { name: /Sub-12/ }).click();
    const tipo = dlg.locator('div.space-y-2:has(label:has-text("Tipo de Evento")) [role="combobox"]');
    await tipo.click();
    await page.getByRole('option', { name: /Partido/ }).first().click();
    await espera(page, 600);
    await dlg.getByRole('button', { name: /Seleccionar fecha/ }).first().click();
    const dia = String(Number(masDias(hoyCO(), 4).slice(8)));
    // Los días de relleno del mes anterior también dicen «30»: se excluyen por su clase.
    await page.locator('button[name="day"]:not(.day-outside)').filter({ hasText: new RegExp(`^${dia}$`) }).first().click();
    await espera(page, 600);
    await dlg.getByPlaceholder('Ej: Halcones FC').fill('Club Los Andes');
    await espera(page, 600);
    await shot(page, '62-evento-partido-lleno');
    fs.writeFileSync(path.join(TXT, '62-dialogo.txt'), await dlg.innerText());
    if (ya.length) { await dlg.getByRole('button', { name: 'Cancelar' }).click(); }
    else {
    await dlg.getByRole('button', { name: /Crear|Guardar/ }).last().click();
    await espera(page, 4000);
    await shot(page, '63-evento-creado');
    }
    fs.writeFileSync(path.join(TXT, '63-toast-y-dialogo.txt'), await page.evaluate(() => document.body.innerText));
  }
  const ev = await leer(`calendar_events?school_id=eq.${SCHOOL}&title=eq.${encodeURIComponent(titulo)}&select=id,team_id,start_time,event_type`);
  const mt = await leer(`match_results?team_id=eq.${SUB12}&select=id,opponent,match_date,status&order=created_at.desc&limit=3`);
  datos.calendario = { eventos: ev, partidosSub12: mt };
  console.log('  · evento:', JSON.stringify(ev), '\n  · partidos Sub-12:', JSON.stringify(mt));
  await ir(page, '/calendar', 5000);
  await shotEn(page, '64-calendario-con-partido', 'Los Andes', { bloque: 'center' });
  // El día en la cuadrícula: el primer «30» es el de relleno de septiembre.
  const dia30 = String(Number(masDias(hoyCO(), 4).slice(8)));
  const celdas = page.getByText(dia30, { exact: true });
  await celdas.nth((await celdas.count()) > 1 && Number(dia30) > 20 ? 1 : 0).click();
  await espera(page, 1500);
  await shotEn(page, '65-evento-detalle', 'Eventos del', { bloque: 'start' });
  fs.writeFileSync(path.join(TXT, '65-detalle.txt'), await page.evaluate(() => document.body.innerText));
  await ir(page, `/teams?equipo=${SUB12}&tab=partidos`, 6000);
  await shot(page, '66-sub12-partidos');
  await context.close();
};

// Sesiones: Hoy · Semana · Plan del mes (móvil) + planificación completa (escritorio)
SECCIONES.sesiones = async (browser) => {
  const manana = masDias(hoyCO(), 1);
  // 1. Lo que ve el coach antes de planear
  {
    const { context, page } = await sesion(browser, COACH);
    await ir(page, '/training-plans', 8000);
    await shot(page, '70-sesiones-hoy');
    await page.getByRole('tab', { name: 'Semana' }).click(); await espera(page, 2500);
    await shot(page, '71-sesiones-semana');
    await page.getByRole('tab', { name: 'Plan del mes' }).click(); await espera(page, 2500);
    await shot(page, '72-sesiones-plan');
    await context.close();
  }
  // 2. Planificación completa: plan del mes (mesociclo) + sesión de mañana
  {
    const { context, page } = await sesion(browser, COACH, { desk: true });
    await ir(page, '/training-plans/planificar', 3000);
    await page.getByRole('combobox').first().click(); await espera(page, 800);
    await page.getByRole('option', { name: /Sub-15/ }).first().click(); await espera(page, 4000);
    await shot(page, '73-planificar');
    const meso = await leer(`training_mesocycles?team_id=eq.${SUB15}&starts_on=eq.${hoyCO()}&select=id`);
    if (!meso.length) {
      await page.locator('button:right-of(:text("Exportar PDF"))').first().click(); await espera(page, 800);
      await page.getByRole('menuitem', { name: 'Nuevo mesociclo' }).click(); await espera(page, 1500);
      const d = page.getByRole('dialog').last();
      await d.locator('textarea').first().fill('Presión tras pérdida y transiciones rápidas a campo contrario.');
      await d.locator('textarea').nth(1).fill('Presionar en bloque alto; atacar el espacio a la espalda.').catch(() => {});
      await espera(page, 500);
      await shot(page, '74-nuevo-mesociclo');
      await d.getByRole('button', { name: 'Crear Mesociclo' }).click();
      await espera(page, 4000);
      datos.mesociclo = (await leer(`training_mesocycles?team_id=eq.${SUB15}&starts_on=eq.${hoyCO()}&select=id,starts_on,ends_on`))[0];
    }
    await ir(page, '/training-plans/planificar', 3000);
    await page.getByRole('combobox').first().click(); await espera(page, 800);
    await page.getByRole('option', { name: /Sub-15/ }).first().click(); await espera(page, 4000);
    await shot(page, '75-mesociclo-creado');
    const ses = await leer(`training_sessions?team_id=eq.${SUB15}&session_date=eq.${manana}&select=id`).catch(() => []);
    if (!ses.length) {
      await page.getByRole('button', { name: /Agregar sesión/ }).first().click(); await espera(page, 1200);
      const dd = new Date(`${manana}T12:00:00Z`);
      const etiqueta = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][dd.getUTCDay()] + ' ' + dd.getUTCDate();
      await page.getByRole('button', { name: new RegExp(`^${etiqueta}`) }).first().click(); await espera(page, 2500);
      const d = page.getByRole('dialog').last();
      await d.locator('#materials').fill('Conos, 10 balones, petos de dos colores, 4 miniarcos');
      await d.locator('#objectives').fill('Recuperar la pelota en menos de 6 segundos tras perderla.');
      await d.locator('#game_principles').fill('Presión tras pérdida, coberturas, salida rápida.');
      const bloques = [
        ['Calentamiento', '15', 'Rondo 5 contra 2 con transición'],
        ['Parte principal', '40', 'Juego de posición 6 contra 6 + 2 comodines'],
        ['Partido condicionado', '25', 'Gol vale doble si se recupera en campo rival'],
      ];
      for (let i = 0; i < bloques.length; i++) {
        await d.getByPlaceholder('Nombre del bloque (ej: Calentamiento)').nth(i).fill(bloques[i][0]);
        await d.getByPlaceholder('Min').nth(i).fill(bloques[i][1]);
        await d.getByPlaceholder('Actividad / ejercicio').nth(i).fill(bloques[i][2]);
      }
      await espera(page, 500);
      await shot(page, '76-form-sesion');
      await d.getByRole('button', { name: 'Crear Sesión' }).click();
      await espera(page, 4000);
      await shot(page, '77-sesion-creada');
    }
    datos.sesionManana = await leer(`training_sessions?team_id=eq.${SUB15}&session_date=eq.${manana}&select=id,session_date,objectives`).catch((e) => e.message);
    await context.close();
  }
  // 3. Ya planeada: Semana, Ver sesión, modo cancha, Plan del mes
  {
    const { context, page } = await sesion(browser, COACH);
    await ir(page, '/training-plans', 5000);
    await page.getByRole('tab', { name: 'Semana' }).click(); await espera(page, 2500);
    await shot(page, '78-semana-con-plan');
    const abrirDia = async () => { await page.getByText('Recuperar la pelota').first().click(); await espera(page, 1200); };
    await abrirDia();
    await shot(page, '78b-dia-abierto');
    await page.getByRole('button', { name: /Abrir en la cancha/ }).first().click(); await espera(page, 2500);
    await shot(page, '80-modo-cancha');
    fs.writeFileSync(path.join(TXT, '80-body.txt'), await page.evaluate(() => document.body.innerText));
    await page.getByRole('button', { name: /Salir|Cerrar/ }).first().click().catch(() => page.keyboard.press('Escape'));
    await espera(page, 1500);
    await ir(page, '/training-plans', 4000);
    await page.getByRole('tab', { name: 'Semana' }).click(); await espera(page, 2500);
    await abrirDia();
    await page.getByRole('button', { name: 'Ver sesión' }).first().click(); await espera(page, 2500);
    await shot(page, '79-ver-sesion');
    fs.writeFileSync(path.join(TXT, '79-body.txt'), await page.evaluate(() => document.body.innerText));
    await ir(page, '/training-plans', 4000);
    await page.getByRole('tab', { name: 'Plan del mes' }).click(); await espera(page, 2500);
    await page.getByText('Fútbol — Sub-15', { exact: true }).first().click(); await espera(page, 2500);
    await shot(page, '81-plan-del-mes');
    fs.writeFileSync(path.join(TXT, '81-body.txt'), await page.evaluate(() => document.querySelector('main')?.innerText || ''));
    await context.close();
  }
};

/** ¿El botón está tapado por otra capa en el punto donde se tocaría? */
async function estaTapado(loc) {
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(top === el || el.contains(top));
  }).catch(() => null);
}

// Asistencia: tomar lista (4 estados), guardar, evaluar al equipo, historial, escanear carnet
SECCIONES.asistencia = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/coach-attendance', 6000);
  await shot(page, '90-asistencia-elegir');
  await page.getByRole('button', { name: /Fútbol — Sub-15/ }).first().click();
  await espera(page, 4000);
  await shot(page, '91-lista-todos-vinieron');
  fs.writeFileSync(path.join(TXT, '91-body.txt'), await page.evaluate(() => document.body.innerText));
  {
    // Fija el estado leyendo el aria-label («Nombre: Vino. Toca para cambiar.») y tocando hasta llegar.
    const fijar = async (nombre, objetivo) => {
      for (let k = 0; k < 5; k++) {
        const b = page.getByRole('button', { name: new RegExp(`^${nombre}:`) });
        const lab = (await b.getAttribute('aria-label')) || '';
        if (lab.startsWith(`${nombre}: ${objetivo}.`)) return;
        await b.click(); await espera(page, 350);
      }
    };
    await fijar('Julieta Duarte', 'Faltó');
    await fijar('Renata Cárdenas', 'Excusa');
    await fijar('Tomás Duarte', 'Tarde');
    await fijar('Tomás Herrera', 'Vino');
    await espera(page, 600);
    await shot(page, '92-lista-marcada');
    await page.getByRole('button', { name: 'Más opciones' }).click().catch(() => {});
    await espera(page, 1000);
    await shot(page, '93-mas-opciones');
    fs.writeFileSync(path.join(TXT, '93-body.txt'), await page.evaluate(() => document.body.innerText));
    await page.getByRole('button', { name: 'Más opciones' }).click().catch(() => {});
    await espera(page, 600);
    const guardar = page.getByRole('button', { name: 'Guardar lista' });
    const tap = await estaTapado(guardar);
    console.log('  · «Guardar lista» tapado:', tap);
    datos.guardarListaTapado = tap;
    if (tap) await guardar.dispatchEvent('click'); else await guardar.click();
    await espera(page, 1500);
    await shot(page, '94-lista-guardada');
    fs.writeFileSync(path.join(TXT, '94-body.txt'), await page.evaluate(() => document.body.innerText));
    // «Deshacer · N»: la lista sube unos segundos después.
    await page.getByTestId('aviso-guardada').waitFor({ timeout: 45000 }).catch(() => console.log('  · la lista no terminó de subir en 45 s'));
    await espera(page, 800);
    await shot(page, '94b-lista-subida');
    fs.writeFileSync(path.join(TXT, '94b-body.txt'), await page.evaluate(() => document.body.innerText));
    datos.sesionAsistenciaHref = await page.getByRole('link', { name: 'Evaluar al equipo' }).getAttribute('href').catch(() => null);
    const cerrar = page.getByRole('button', { name: 'Cerrar la lista' });
    if (await cerrar.count()) {
      await cerrar.click(); await espera(page, 1000);
      await shot(page, '94c-cerrar-confirmar');
      await page.getByRole('button', { name: 'Sí, cerrar' }).click(); await espera(page, 4000);
      await shot(page, '94d-lista-cerrada');
      fs.writeFileSync(path.join(TXT, '94d-body.txt'), await page.evaluate(() => document.body.innerText));
    } else console.log('  · no apareció «Cerrar la lista»');
  }
  // Evaluar al equipo (post-entreno)
  if (datos.sesionAsistenciaHref) {
    await ir(page, datos.sesionAsistenciaHref, 6000);
    await shot(page, '95-evaluar-equipo');
    fs.writeFileSync(path.join(TXT, '95-body.txt'), await page.evaluate(() => document.body.innerText));
    const g = page.getByRole('radiogroup', { name: /Tomás Herrera/ });
    if (await g.count()) {
      await g.getByRole('button', { name: /Bien/ }).first().click().catch(() => g.locator('button').first().click());
      await page.locator('#nota-familias').fill('Buen entreno de presión tras pérdida. El jueves seguimos con salida desde el fondo.').catch(() => {});
      await espera(page, 600);
      await shot(page, '96-evaluar-equipo-lleno');
      const b = page.getByRole('button', { name: 'Guardar evaluación' });
      const tap = await estaTapado(b);
      datos.guardarEvalEntrenoTapado = tap;
      console.log('  · «Guardar evaluación» (entreno) tapado:', tap);
      if (tap) await b.dispatchEvent('click'); else await b.click();
      await espera(page, 4000);
      await shot(page, '97-evaluacion-entreno-guardada');
      datos.sesionAsistencia = page.url();
    }
  } else console.log('  · no apareció «Evaluar al equipo»');
  // Historial
  await ir(page, '/coach-attendance', 5000);
  await page.getByRole('tab', { name: 'Historial' }).or(page.getByRole('button', { name: 'Historial' })).first().click();
  await espera(page, 8000);
  await shot(page, '98-historial');
  fs.writeFileSync(path.join(TXT, '98-body.txt'), await page.evaluate(() => document.querySelector('main')?.innerText || ''));
  // Escanear carnets (sin cámara: el navegador de prueba no la tiene; no se captura la cámara)
  await ir(page, '/coach-attendance/scan', 5000);
  await shot(page, '99-escanear');
  fs.writeFileSync(path.join(TXT, '99-body.txt'), await page.evaluate(() => document.body.innerText));
  await context.close();
};

/** Foto de prueba de una planilla en papel (HTML renderizado → JPG), con los nombres reales del grupo. */
async function fotoPlanilla(browser, archivo, { titulo, fechas, filas }) {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 }, deviceScaleFactor: 2 });
  const celdas = (marcas) => marcas.map((m) => `<td>${m}</td>`).join('');
  await page.setContent(`<body style="margin:0;background:#e9e4d6;font-family:'Segoe Print','Comic Sans MS',cursive">
    <div style="margin:24px;background:#fffdf5;padding:22px 26px;box-shadow:0 2px 8px #0003;transform:rotate(-0.6deg)">
      <div style="font:700 22px Arial;margin-bottom:4px">PLANILLA DE ASISTENCIA</div>
      <div style="font:15px Arial;margin-bottom:14px">${titulo}</div>
      <table style="border-collapse:collapse;width:100%;font-size:20px">
        <tr><th style="border:1.5px solid #333;padding:6px;text-align:left;font:700 15px Arial">Nombre</th>${fechas.map((f) => `<th style="border:1.5px solid #333;padding:6px;font:700 15px Arial">${f}</th>`).join('')}</tr>
        ${filas.map(([n, ...m]) => `<tr><td style="border:1.5px solid #333;padding:8px 10px">${n}</td>${celdas(m).replace(/<td>/g, '<td style="border:1.5px solid #333;text-align:center;font-size:24px">')}</tr>`).join('')}
      </table>
      <div style="font:13px Arial;margin-top:12px;color:#555">✓ = vino · X = faltó · Firma del entrenador: A. Ríos</div>
    </div></body>`);
  await page.screenshot({ path: archivo, type: 'jpeg', quality: 85 });
  await page.close();
}

// Planillas por revisar (asistencia en papel por foto)
SECCIONES.planillas = async (browser) => {
  const foto = path.join(SHOTS, '_planilla-prueba.jpg');
  const f1 = masDias(hoyCO(), -4), f2 = masDias(hoyCO(), -6);
  const dm = (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}`;
  await fotoPlanilla(browser, foto, {
    titulo: 'Fútbol — Sub-15 · Club Campestre Demo · Octubre 2026',
    fechas: [dm(f2), dm(f1)],
    filas: [['Julieta Duarte', '✓', '✓'], ['Renata Cárdenas', '✓', 'X'], ['Tomás Duarte', 'X', '✓'], ['Tomás Herrera', '✓', '✓']],
  });
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/school/attendance-sheets', 6000);
  await shot(page, '100-planillas-vacia');
  const previas = await leer(`attendance_sheet_intake?school_id=eq.${SCHOOL}&select=id,status,submitted_by,created_at`).catch((e) => e.message);
  datos.planillasAntes = previas;
  const mias = Array.isArray(previas) ? previas.filter((r) => r.submitted_by === '16d36eb1-776f-4324-a0ea-fdf1fe5b4519') : [];
  if (!mias.length) {
    await page.locator('input[type="file"]').setInputFiles(foto);
    await page.getByText(/Planilla leída|No reconocí|No se pudo|no está habilitada|pesa más/).first().waitFor({ timeout: 120000 }).catch(() => {});
    await espera(page, 3000);
    await shot(page, '101-planilla-subida');
    fs.writeFileSync(path.join(TXT, '101-body.txt'), await page.evaluate(() => document.body.innerText));
  }
  await ir(page, '/school/attendance-sheets', 6000);
  await shot(page, '102-planillas-lista');
  fs.writeFileSync(path.join(TXT, '102-body.txt'), await page.evaluate(() => document.querySelector('main')?.innerText || ''));
  datos.planillas = await leer(`attendance_sheet_intake?school_id=eq.${SCHOOL}&select=id,status,team_id,session_date,submitted_by,created_at`).catch((e) => e.message);
  await context.close();
};

/** Prende o apaga «Coaches pueden subir hojas de matrícula» desde Pagos › Config (owner). */
async function permisoMatricula(browser, valor, nombre) {
  const { context, page } = await sesion(browser, OWNER, { desk: true });
  await ir(page, '/payments-automation', 6000);
  await page.getByRole('tab', { name: 'Config' }).click(); await espera(page, 2500);
  const fila = page.locator('div.flex.items-center.justify-between').filter({ has: page.getByText('Coaches pueden subir hojas de matrícula', { exact: true }) }).last();
  const sw = fila.getByRole('switch');
  await sw.scrollIntoViewIfNeeded();
  const actual = (await sw.getAttribute('aria-checked')) === 'true';
  if (actual !== valor) {
    await sw.click(); await espera(page, 500);
    if (nombre) { await fila.evaluate((e) => e.scrollIntoView({ block: 'center' })); await espera(page, 500); await shot(page, nombre); }
    await page.getByRole('button', { name: 'Guardar Cambios' }).first().click(); await espera(page, 3500);
  }
  const s = await leer(`school_settings?school_id=eq.${SCHOOL}&select=coach_can_upload_enrollment_forms`);
  console.log(`  · coach_can_upload_enrollment_forms = ${s[0]?.coach_can_upload_enrollment_forms}`);
  await context.close();
}

// Hojas de matrícula por foto: depende de un permiso de la escuela
SECCIONES.matricula = async (browser) => {
  // 1. Sin permiso
  {
    const { context, page } = await sesion(browser, COACH);
    await ir(page, '/school/enrollment-intake', 6000);
    await shot(page, '110-matricula-sin-permiso');
    await context.close();
  }
  // 2. La escuela lo activa
  await permisoMatricula(browser, true, '111-owner-permiso-matricula');
  // 3. El coach sube la foto
  const foto = path.join(SHOTS, '_matricula-prueba.jpg');
  {
    const page = await browser.newPage({ viewport: { width: 820, height: 1000 }, deviceScaleFactor: 2 });
    const campo = (l, v) => `<div style="display:flex;gap:10px;margin:12px 0;font-size:19px"><b style="font:700 15px Arial;width:230px">${l}</b><span style="flex:1;border-bottom:1.5px solid #333;font-family:'Segoe Print','Comic Sans MS',cursive">${v}</span></div>`;
    await page.setContent(`<body style="margin:0;background:#ddd"><div style="margin:20px;background:#fffef8;padding:30px 36px;box-shadow:0 2px 8px #0003">
      <div style="font:800 24px Arial;text-align:center">CLUB CAMPESTRE DEMO</div>
      <div style="font:700 18px Arial;text-align:center;margin-bottom:18px">FICHA DE INSCRIPCIÓN 2026</div>
      ${campo('Nombre del deportista', 'Samuel Ortiz Ríos')}${campo('Fecha de nacimiento', '12/03/2012')}
      ${campo('Documento', 'TI 1012345678')}${campo('Disciplina / categoría', 'Fútbol Sub-15')}
      ${campo('EPS', 'Sanitas')}${campo('Nombre del acudiente', 'Paola Ríos Gómez')}
      ${campo('Cédula del acudiente', '52.123.456')}${campo('Celular', '310 555 0199')}
      ${campo('Correo', 'paola.rios.demo@demo.sportmaps.co')}${campo('Dirección', 'Calle 140 # 12-34, Bogotá')}
      <div style="margin-top:26px;font:14px Arial">Firma del acudiente: ____________________ &nbsp;&nbsp; Fecha: 26/10/2026</div></div></body>`);
    await page.screenshot({ path: foto, type: 'jpeg', quality: 85 });
    await page.close();
  }
  {
    const { context, page } = await sesion(browser, COACH);
    await ir(page, '/school/enrollment-intake', 6000);
    await shot(page, '112-matricula-con-permiso');
    const ya = await leer(`enrollment_form_intake?school_id=eq.${SCHOOL}&select=id,status,created_at&order=created_at.desc&limit=5`).catch((e) => e.message);
    datos.matriculasAntes = ya;
    await page.locator('input[type="file"]').first().setInputFiles(foto);
    await page.getByText(/recibida|leída|Listo|No se pudo|no reconoc|Error|revis/i).first().waitFor({ timeout: 120000 }).catch(() => {});
    await espera(page, 3000);
    await shot(page, '113-matricula-subida');
    fs.writeFileSync(path.join(TXT, '113-body.txt'), await page.evaluate(() => document.body.innerText));
    await context.close();
  }
  datos.matriculas = await leer(`enrollment_form_intake?school_id=eq.${SCHOOL}&select=id,status,submitted_by,created_at&order=created_at.desc&limit=5`).catch((e) => e.message);
  // 4. La escuela la ve en su bandeja
  {
    const { context, page } = await sesion(browser, OWNER, { desk: true });
    await ir(page, '/school/enrollment-intake', 7000);
    await shot(page, '114-owner-bandeja-matriculas');
    fs.writeFileSync(path.join(TXT, '114-body.txt'), await page.evaluate(() => document.querySelector('main')?.innerText || ''));
    await context.close();
  }
  // 5. Se deja el permiso como estaba (apagado)
  await permisoMatricula(browser, false, null);
};

// «Más»: cada entrada, con su pantalla y los errores HTTP que dispare
const RUTAS_MAS = [
  ['120-mas', '/mas'], ['121-agenda-citas', '/coach-plans'], ['122-informe-mensual', '/informe-mensual'],
  ['123-informes-entreno', '/coach-reports'], ['124-rutinas', '/school/routines'], ['125-dotacion', '/coach/dotacion'],
  ['126-salud-equipo', '/disponibilidad-medica'], ['127-mensajes', '/messages'], ['128-anuncios', '/announcements'],
  ['129-encuestas', '/dashboard/polls'], ['130-notificaciones', '/notifications'], ['131-configuracion', '/settings'],
  ['132-perfil', '/profile'], ['133-centro-ayuda', '/ayuda'], ['134-mis-deportistas', '/students'], ['135-resultados', '/results'],
];
SECCIONES.mas = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  datos.mas = datos.mas ?? {};
  for (const [nombre, ruta] of RUTAS_MAS) {
    if (process.env.SOLO_FALTANTES && fs.existsSync(path.join(SHOTS, `${nombre}.png`))) continue;
    const antes = httpErrores.length;
    await ir(page, ruta, 6000);
    await shot(page, nombre);
    datos.mas[ruta] = { url: page.url(), errores: httpErrores.slice(antes) };
  }
  await ir(page, '/mas', 4000);
  await page.getByText('Preguntarle a Mapi').click(); await espera(page, 2500);
  await shot(page, '136-mapi');
  await context.close();
};

/**
 * Las acciones con «Deshacer» (convocar, evaluar el entreno, felicitar) se escriben a los 8 s.
 * Salir por la navegación de la app las ejecuta; RECARGAR la página dentro de esos 8 s las pierde.
 * Esta sección repite las dos que la primera pasada perdió por recargar, y prueba la salida interna.
 */
SECCIONES.deshacer = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  // 1. Convocatoria de Suba: tocar Convocar y esperar la ventana completa en la pantalla
  if (!process.env.SALTAR_CONV) {
  await ir(page, `/partidos/${datos.partidoA.id}?paso=convocar`, 6000);
  const conv = page.getByRole('button', { name: /^Convocar/ });
  if (await conv.count()) { await conv.first().click(); await espera(page, 11000); }
  }
  const lu = await leer(`match_lineups?source_id=eq.${datos.partidoA.id}&select=id,match_lineup_players(count)`);
  console.log('  · convocatoria Suba en la base:', JSON.stringify(lu));
  datos.partidoA.convocatoria = lu;
  // 2. Evaluación del entreno: guardar y salir enseguida con «Volver» (sin recargar)
  await ir(page, datos.sesionAsistenciaHref, 6000);
  const g = page.getByRole('radiogroup', { name: /Tomás Herrera/ });
  await g.getByText('Bien', { exact: true }).click();
  await page.locator('#nota-familias').fill('Buen entreno de presión tras pérdida. El jueves seguimos con salida desde el fondo.');
  await page.getByRole('button', { name: /Guardar evaluación/ }).click();
  await espera(page, 800);
  await page.getByRole('button', { name: 'Volver' }).first().click().catch(() => page.getByText('Volver a Equipos').click());
  await espera(page, 5000);
  const sid = datos.sesionAsistenciaHref.split('/').pop();
  const pe = await leer(`performance_entries?context_id=eq.${sid}&select=metric_key,value`);
  console.log('  · evaluación del entreno en la base:', JSON.stringify(pe));
  datos.evaluacionEntreno = pe;
  await ir(page, '/dashboard', 10000);
  await shot(page, '05-hoy');
  await context.close();
};

// Retomas de pantallas que cargan lento en dev (render del BFF en frío)
SECCIONES.retomas = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/dashboard', 10000);
  await shot(page, '05-hoy');
  await shotEn(page, '05b-hoy-abajo', 'Pendientes', { bloque: 'start' }).catch(() => {});
  await ir(page, '/training-plans', 12000);
  await shot(page, '70-sesiones-hoy');
  await ir(page, '/profile', 12000);
  await shot(page, '132-perfil');
  await context.close();
};

// La administración siembra los criterios de partido (el coach no puede)
SECCIONES.criterios = async (browser) => {
  const ya = await leer(`school_metric_definitions?school_id=eq.${SCHOOL}&select=id&limit=1`);
  const { context, page } = await sesion(browser, OWNER);
  await ir(page, `/partidos/${datos.partidoB.id}?paso=evaluar`, 6000);
  await shot(page, '37-owner-evaluar');
  if (!ya.length) {
    await page.getByRole('button', { name: /criterios sugeridos para partidos/ }).click();
    await espera(page, 5000);
    await shot(page, '38-owner-criterios-creados');
  }
  await context.close();
};

// ═════════════════════════════════════════════════════════════════════════════
// Re-prueba 2026-10-28: arreglos del 10-27 (B1–B12, minutos, reporte, pizarra).
// Capturas nuevas con prefijo 2xx. Resultados en datos.rp (y en el reporte).
// ═════════════════════════════════════════════════════════════════════════════
const rp = (k, v) => { datos.rp = datos.rp ?? {}; datos.rp[k] = v; console.log(`  · ${k}:`, typeof v === 'string' ? v : JSON.stringify(v)); };

/** Prende/apaga un interruptor de Pagos › Config por su etiqueta (owner, escritorio). */
async function permisoConfig(browser, etiqueta, valor, nombre) {
  const { context, page } = await sesion(browser, OWNER, { desk: true });
  await ir(page, '/payments-automation', 6000);
  await page.getByRole('tab', { name: 'Config' }).click(); await espera(page, 2500);
  const fila = page.locator('div.flex.items-center.justify-between').filter({ has: page.getByText(etiqueta, { exact: true }) }).last();
  const sw = fila.getByRole('switch');
  await sw.scrollIntoViewIfNeeded();
  const actual = (await sw.getAttribute('aria-checked')) === 'true';
  if (actual !== valor) {
    await sw.click(); await espera(page, 500);
    if (nombre) { await fila.evaluate((e) => e.scrollIntoView({ block: 'center' })); await espera(page, 500); await shot(page, nombre); }
    await page.getByRole('button', { name: 'Guardar Cambios' }).first().click(); await espera(page, 3500);
  }
  await context.close();
}

// Hoy: botón Pizarra, «Tu semana» del día libre, Agregar horario
SECCIONES.rpHoy = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/dashboard', 10000);
  await shot(page, '200-hoy');
  await shot(page, '200-hoy-full', { full: true });
  rp('hoy.botonPizarra', await page.getByTestId('boton-pizarra').count());
  rp('hoy.diaLibre', await page.getByTestId('dia-libre').count());
  rp('hoy.sinHorario', await page.getByTestId('sin-horario').count());
  await shotEn(page, '201-hoy-abajo', page.getByTestId('dia-libre'), { bloque: 'start' }).catch(() => {});
  await ir(page, '/teams', 5000);
  await shot(page, '202-equipos');
  await context.close();
};

// Partido: B1 (barra sobre la navegación) con el resultado de Chía, minutos (d4b573d9) en Sabana
SECCIONES.rpPartido = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  const idC = datos.partidoC.id, idB = datos.partidoB.id;
  const stC = (await leer(`match_results?id=eq.${idC}&select=status,home_score,away_score`))[0];
  await ir(page, `/partidos/${idC}?paso=cerrar`, 6000);
  await shot(page, '210-resultado-chia');
  const g = page.getByRole('button', { name: /Guardar resultado/ }).first();
  rp('B1.guardarResultadoTapado', await estaTapado(g));
  if (stC?.status !== 'played') {
    await page.getByRole('button', { name: /Sumar un gol a Deportivo Chía/ }).click().catch(() => {});
    await espera(page, 600);
    await shot(page, '211-resultado-chia-lleno');
    await g.click({ timeout: 8000 }).then(() => rp('B1.clicRealResultado', 'ok')).catch((e) => rp('B1.clicRealResultado', 'FALLA ' + e.message.split('\n')[0]));
    await espera(page, 4000);
    await shot(page, '212-resultado-chia-guardado');
  }
  rp('B1.chiaEnBase', (await leer(`match_results?id=eq.${idC}&select=status,home_score,away_score`))[0]);
  // Minutos jugados + Guardar evaluación con un toque real
  await ir(page, `/partidos/${idB}?paso=evaluar`, 6000);
  await shot(page, '213-evaluar-lista');
  await page.getByRole('button', { name: /Tomás Herrera|Tomás H\./ }).first().click();
  await espera(page, 1200);
  const min = page.getByLabel('Minutos jugados').first();
  await min.fill('70'); await espera(page, 400);
  await min.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await espera(page, 600);
  await shot(page, '214-evaluar-minutos');
  const ge = page.getByRole('button', { name: /^Guardar evaluación$/ }).first();
  rp('B1.guardarEvaluacionTapado', await estaTapado(ge));
  await ge.click({ timeout: 8000 }).then(() => rp('B1.clicRealEvaluacion', 'ok')).catch((e) => rp('B1.clicRealEvaluacion', 'FALLA ' + e.message.split('\n')[0]));
  await espera(page, 3500);
  await shot(page, '215-evaluar-minutos-guardado');
  rp('minutos.enBase', await leer(`match_lineup_players?select=id,minutes_played,match_lineups!inner(source_id)&match_lineups.source_id=eq.${idB}`).catch((e) => e.message));
  // Reporte (vista del coach)
  await ir(page, `/partidos/${idB}?paso=reporte`, 5000);
  await page.getByRole('button', { name: /Escribir el reporte|Ver o editar el reporte/ }).click();
  await espera(page, 1500);
  await shot(page, '216-reporte-coach');
  fs.writeFileSync(path.join(TXT, '216-dialogo.txt'), await page.getByRole('dialog').last().innerText());
  await page.keyboard.press('Escape');
  await context.close();
  // Reporte (vista de la administración: interruptor de toda la escuela) — solo se mira
  const o = await sesion(browser, OWNER);
  await ir(o.page, `/partidos/${idB}?paso=reporte`, 6000);
  await o.page.getByRole('button', { name: /Escribir el reporte|Ver o editar el reporte/ }).click();
  await espera(o.page, 2000);
  const sw = o.page.locator('#mr-compartir');
  rp('reporte.interruptorAdmin', await sw.count());
  if (await sw.count()) { await sw.evaluate((e) => e.scrollIntoView({ block: 'center' })); await espera(o.page, 600); }
  await shot(o.page, '217-reporte-admin');
  fs.writeFileSync(path.join(TXT, '217-dialogo.txt'), await o.page.getByRole('dialog').last().innerText());
  await o.context.close();
};

// Asistencia: «Otro día» (3e8cdac6), texto con excusas (B11), cerrar → Evaluar (B10), evaluar guarda (B3), salir rápido (B8)
SECCIONES.rpAsistencia = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/coach-attendance', 6000);
  await page.getByRole('button', { name: /Fútbol — Sub-15/ }).first().click().catch(() => {});
  await espera(page, 4000);
  await shot(page, '220-lista-dias');
  fs.writeFileSync(path.join(TXT, '220-body.txt'), await page.evaluate(() => document.body.innerText));
  const otro = page.getByRole('tab', { name: 'Otro día' }).first();
  rp('asistencia.otroDia', await otro.count());
  if (await otro.count()) {
    await otro.click(); await espera(page, 2500);
    await page.getByTestId('lista-otro-dia').evaluate((e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
    await shot(page, '221-otro-dia');
    rp('asistencia.otroDiaRango', await page.getByTestId('lista-otro-dia').evaluate((e) => ({ min: e.min, max: e.max, value: e.value })).catch(() => null));
  }
  const ayer = masDias(hoyCO(), -1);
  await page.getByRole('tab', { name: 'Ayer' }).first().click();
  await espera(page, 4000);
  const yaLista = await leer(`attendance_sessions?team_id=eq.${SUB15}&session_date=eq.${ayer}&select=id,finalized`).catch(() => []);
  rp('asistencia.listaAyerPrevia', yaLista);
  if (!yaLista.length) {
    const fijar = async (nombre, objetivo) => {
      for (let k = 0; k < 5; k++) {
        const b = page.getByRole('button', { name: new RegExp(`^${nombre}:`) });
        const lab = (await b.getAttribute('aria-label')) || '';
        if (lab.startsWith(`${nombre}: ${objetivo}.`)) return;
        await b.click(); await espera(page, 350);
      }
    };
    await fijar('Julieta Duarte', 'Faltó');
    await fijar('Renata Cárdenas', 'Excusa');
    await espera(page, 500);
    await shot(page, '222-lista-ayer');
    await page.getByRole('button', { name: 'Guardar lista' }).click();
    await espera(page, 1500);
    await shot(page, '223-lista-deshacer');
    fs.writeFileSync(path.join(TXT, '223-body.txt'), await page.evaluate(() => document.body.innerText));
    await page.getByTestId('aviso-guardada').waitFor({ timeout: 45000 }).catch(() => console.log('  · la lista no subió en 45 s'));
    await espera(page, 800);
    await shot(page, '224-lista-guardada');
    rp('asistencia.cerrarEnAyer', await page.getByRole('button', { name: 'Cerrar la lista' }).count());
    await page.getByRole('link', { name: 'Evaluar al equipo' }).click(); await espera(page, 6000);
  } else {
    await ir(page, `/coach/evaluar/${yaLista[0].id}`, 6000);
  }
  await shot(page, '226-evaluar-equipo');
  const sid = page.url().split('/').pop().split('?')[0];
  rp('asistencia.sesionAyer', sid);
  const g = page.getByRole('radiogroup', { name: /Tomás Herrera/ });
  if (await g.count()) {
    await g.getByText('Bien', { exact: true }).click();
    await page.locator('#nota-familias').fill('Buen trabajo de presión tras pérdida. El jueves seguimos con salida desde el fondo.').catch(() => {});
    await espera(page, 500);
    await shot(page, '227-evaluar-lleno');
    await page.getByRole('button', { name: /Guardar evaluación/ }).click();
    await espera(page, 900);
    await shot(page, '228-evaluar-programado');
    fs.writeFileSync(path.join(TXT, '228-body.txt'), await page.evaluate(() => document.body.innerText));
    // B8: salir enseguida por la navegación de la app
    await page.getByRole('button', { name: 'Volver' }).first().click().catch(() => page.goto(BASE_URL + '/dashboard'));
    await espera(page, 12000);
  }
  rp('B3.performanceEntries', await leer(`performance_entries?context_id=eq.${sid}&select=metric_key,value,subject_id`).catch((e) => e.message));
  // El entreno del 26 (el que falló el 10-26 por B3): desde el pendiente de Hoy
  await ir(page, '/dashboard', 9000);
  const ev26 = page.getByRole('link', { name: 'Evaluar' }).or(page.getByRole('button', { name: 'Evaluar' })).first();
  if (await ev26.count()) {
    await ev26.click(); await espera(page, 6000);
    const s26 = page.url().split('/').pop().split('?')[0];
    const g26 = page.getByRole('button', { name: /A todos: Bien/ });
    if (await g26.count()) await g26.click(); await espera(page, 500);
    await page.getByRole('button', { name: /Guardar evaluación/ }).click().catch(() => {});
    await espera(page, 12000);
    rp('B3.entreno26', { sesion: s26, filas: await leer(`performance_entries?context_id=eq.${s26}&select=metric_key,value`).catch((e) => e.message) });
  }
  await ir(page, '/dashboard', 9000);
  await shot(page, '229-hoy-tras-evaluar');
  fs.writeFileSync(path.join(TXT, '229-body.txt'), await page.evaluate(() => document.querySelector('main')?.innerText || ''));
  await context.close();
};

// B10: «Cerrar la lista» (solo la de hoy) lleva a «Evaluar al equipo» sin el modal viejo — Sub-12, hoy
SECCIONES.rpCerrar = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/coach-attendance', 6000);
  await page.getByRole('button', { name: 'Cambiar', exact: true }).first().click().catch(() => {}); await espera(page, 1500);
  await page.getByRole('button', { name: /Fútbol — Sub-12/ }).first().click(); await espera(page, 4000);
  const guardar = page.getByTestId('guardar-lista');
  if (await guardar.count()) {
    await guardar.click();
    await page.getByTestId('aviso-guardada').waitFor({ timeout: 45000 }).catch(() => {});
    await espera(page, 800);
  }
  await page.getByRole('button', { name: 'Cerrar la lista' }).click(); await espera(page, 1000);
  await shot(page, '225-cerrar-confirmar');
  await page.getByRole('button', { name: 'Sí, cerrar' }).click();
  await page.waitForURL(/\/coach\/evaluar\//, { timeout: 15000 }).then(() => rp('B10.cerrarLlevaAEvaluar', page.url())).catch(() => rp('B10.cerrarLlevaAEvaluar', 'NO — ' + page.url()));
  await espera(page, 5000);
  rp('B10.modalViejo', await page.getByText('Califica el entreno de hoy').count());
  await shot(page, '225b-tras-cerrar');
  const sid = page.url().split('/').pop().split('?')[0];
  const todos = page.getByRole('button', { name: /A todos: Bien/ });
  if (await todos.count()) {
    await todos.click(); await espera(page, 500);
    await page.getByRole('button', { name: /Guardar evaluación/ }).click();
    await espera(page, 12000);
    await shot(page, '225c-evaluado');
  }
  rp('B3.sub12Hoy', { sesion: sid, filas: await leer(`performance_entries?context_id=eq.${sid}&select=metric_key,value`).catch((e) => e.message) });
  await context.close();
};

// B8 con recarga: felicitar y recargar dentro de los 8 s
SECCIONES.rpDeshacer = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  const desde = new Date(Date.now() - 60000).toISOString();
  await ir(page, `/teams?equipo=${SUB15}&tab=deportistas`, 6000);
  await page.getByText(process.env.QUIEN || 'Renata Cárdenas', { exact: true }).click(); await espera(page, 1000);
  await page.getByRole('button', { name: 'Felicitar' }).first().click(); await espera(page, 1500);
  await page.getByText(/Gran actitud/).first().click().catch(() => {});
  await espera(page, 400);
  await page.getByRole('button', { name: /Enviar a la familia/ }).click();
  await espera(page, 1500);
  await shot(page, '230-felicitar-deshacer');
  await page.reload(); await espera(page, 9000);
  rp('B8.kudosTrasRecarga', await leer(`athlete_kudos?school_id=eq.${SCHOOL}&created_at=gte.${encodeURIComponent(desde)}&select=id,message,created_at`).catch((e) => e.message));
  await context.close();
};

// B8 control: felicitar y (a) esperar la ventana completa, (b) salir por la barra de la app dentro de la ventana
SECCIONES.rpDeshacer2 = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  const kudos = async (desde) => leer(`athlete_kudos?school_id=eq.${SCHOOL}&created_at=gte.${encodeURIComponent(desde)}&select=id,message,created_at`).catch((e) => e.message);
  const felicitar = async (nombre) => {
    await ir(page, `/teams?equipo=${SUB15}&tab=deportistas`, 6000);
    await page.getByText(nombre, { exact: true }).click(); await espera(page, 1000);
    await page.getByRole('button', { name: 'Felicitar' }).first().click(); await espera(page, 1500);
    await page.getByText(/Gran actitud/).first().click().catch(() => {});
    await espera(page, 400);
    await page.getByRole('button', { name: /Enviar a la familia/ }).click();
  };
  let desde = new Date(Date.now() - 30000).toISOString();
  await felicitar('Julieta Duarte'); await espera(page, 13000);
  rp('B8.control.esperaCompleta', await kudos(desde));
  desde = new Date(Date.now() - 5000).toISOString();
  await felicitar('Tomás Duarte'); await espera(page, 1500);
  await page.getByRole('link', { name: 'Hoy' }).last().click().catch(() => {});
  await espera(page, 12000);
  rp('B8.salirPorLaBarra', await kudos(desde));
  await context.close();
};

// Planillas: botón fijo (B4), permiso (B5), subida sin «No tienes equipos» (B2)
SECCIONES.rpPlanillas = async (browser) => {
  const foto = path.join(SHOTS, '_planilla-prueba.jpg');
  {
    const { context, page } = await sesion(browser, COACH);
    await ir(page, '/coach-attendance', 5000);
    await page.getByRole('tab', { name: 'Historial' }).or(page.getByRole('button', { name: 'Historial' })).first().click();
    await espera(page, 8000);
    rp('B4.botonSubirPlanilla', await page.getByTestId('subir-planilla').count());
    await shot(page, '240-historial-subir-planilla');
    // Sin permiso de la escuela (estado del demo: apagado)
    await page.getByTestId('subir-planilla').click().catch(() => page.goto(BASE_URL + '/school/attendance-sheets'));
    await espera(page, 6000);
    await shot(page, '241-planillas');
    await page.locator('input[type="file"]').setInputFiles(foto).catch((e) => rp('B5.inputSinPermiso', e.message));
    await page.getByText(/Planilla leída|No reconocí|No se pudo|no está habilitada|no te permite|permiso|pesa más/i).first().waitFor({ timeout: 60000 }).catch(() => {});
    await espera(page, 2500);
    await shot(page, '242-planilla-sin-permiso');
    fs.writeFileSync(path.join(TXT, '242-body.txt'), await page.evaluate(() => document.body.innerText));
    await context.close();
  }
  rp('B5.filasTrasIntentoSinPermiso', await leer(`attendance_sheet_intake?school_id=eq.${SCHOOL}&select=id,status`).catch((e) => e.message));
  await permisoConfig(browser, 'Coaches pueden subir planillas de asistencia', true, '243-owner-permiso-planillas');
  try {
    const { context, page } = await sesion(browser, COACH);
    await ir(page, '/school/attendance-sheets', 6000);
    await page.locator('input[type="file"]').setInputFiles(foto);
    await page.getByText(/Planilla leída|No reconocí|No se pudo|no está habilitada|No tienes equipos|pesa más/i).first().waitFor({ timeout: 150000 }).catch(() => {});
    await espera(page, 3000);
    await shot(page, '244-planilla-subida');
    fs.writeFileSync(path.join(TXT, '244-body.txt'), await page.evaluate(() => document.body.innerText));
    await ir(page, '/school/attendance-sheets', 6000);
    await shot(page, '245-planillas-lista');
    const abrir = page.getByRole('button', { name: /Revisar|Abrir/ }).first();
    if (await abrir.count()) { await abrir.click(); await espera(page, 4000); }
    else { await page.locator('main li, main [role="listitem"], main button').filter({ hasText: /Sub-15|planilla/i }).first().click().catch(() => {}); await espera(page, 4000); }
    await shot(page, '246-planilla-revisar');
    await shot(page, '246-planilla-revisar-full', { full: true });
    fs.writeFileSync(path.join(TXT, '246-body.txt'), await page.evaluate(() => document.body.innerText));
    await ir(page, '/coach-attendance', 5000);
    await page.getByRole('tab', { name: 'Historial' }).or(page.getByRole('button', { name: 'Historial' })).first().click();
    await espera(page, 8000);
    await shot(page, '247-historial-con-pendiente');
    await context.close();
  } finally {
    await permisoConfig(browser, 'Coaches pueden subir planillas de asistencia', false, null);
  }
  rp('B2.planillas', await leer(`attendance_sheet_intake?school_id=eq.${SCHOOL}&select=id,status,team_id,submitted_by,created_at`).catch((e) => e.message));
  rp('permisoPlanillasFinal', await leer(`school_settings?school_id=eq.${SCHOOL}&select=coach_can_upload_attendance_sheets`));
};

// La grilla de la planilla subida (qué leyó el OCR por celda) — solo se mira, no se guarda
SECCIONES.rpPlanillaGrilla = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/school/attendance-sheets', 6000);
  await page.getByRole('button', { name: /Revisar/ }).first().click().catch(() => {});
  await espera(page, 4000);
  const tabla = page.locator('table').first();
  await tabla.evaluate((e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
  await espera(page, 800);
  await shot(page, '248-planilla-grilla');
  rp('B2.grillaOCR', await page.evaluate(() => [...document.querySelectorAll('table tr')].map((tr) => [...tr.querySelectorAll('th,td')].map((c) => (c.innerText || '').trim() || [...c.querySelectorAll('[aria-label],[title]')].map((x) => x.getAttribute('aria-label') || x.getAttribute('title')).join('|')))));
  await context.close();
};

// Sesiones: botón Pizarra, Planear con equipo y fecha (B6), insignia «Esta semana» (B7)
SECCIONES.rpSesiones = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/training-plans', 9000);
  await shot(page, '250-sesiones-hoy');
  rp('sesiones.botonPizarra', await page.getByTestId('sesiones-pizarra').count());
  await page.getByRole('tab', { name: 'Semana' }).first().click(); await espera(page, 3000);
  await shot(page, '251-sesiones-semana');
  const planear = page.getByRole('link', { name: 'Planear' }).first();
  rp('B6.hrefPlanear', await planear.getAttribute('href').catch(() => null));
  if (await planear.count()) {
    await planear.click(); await espera(page, 7000);
    await shot(page, '252-planear-desde-semana');
    rp('B6.urlTrasPlanear', page.url());
    fs.writeFileSync(path.join(TXT, '252-body.txt'), await page.evaluate(() => document.querySelector('main')?.innerText || ''));
  }
  await context.close();
};

// Pizarra libre /pizarra (ad829828, 7ad9df3d)
SECCIONES.rpPizarra = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/pizarra', 9000);
  await shot(page, '260-pizarra-libre');
  await page.getByRole('button', { name: /Fútbol — Sub-15/ }).first().click().catch(() => {});
  await espera(page, 7000);
  await shot(page, '260b-pizarra-empieza');
  fs.writeFileSync(path.join(TXT, '260-body.txt'), await page.evaluate(() => document.body.innerText));
  rp('pizarra.empiezaAqui', await page.getByRole('region', { name: 'Empieza aquí' }).count());
  rp('pizarra.botonIA', await page.getByTestId('hint-ask-ai').count());
  const poner = page.getByRole('button', { name: /Poner jugadores/ }).first();
  if (await poner.count()) { await poner.click(); await espera(page, 2500); }
  await shot(page, '261-pizarra-con-jugadores');
  fs.writeFileSync(path.join(TXT, '261-body.txt'), await page.evaluate(() => document.body.innerText));
  // Menú de exportar/compartir: solo se abre y se mira (no se crea enlace)
  const exp = page.getByRole('button', { name: /Exportar|Compartir/ }).first();
  if (await exp.count()) {
    await exp.click(); await espera(page, 1200);
    await shot(page, '262-pizarra-compartir');
    fs.writeFileSync(path.join(TXT, '262-body.txt'), await page.evaluate(() => document.body.innerText));
    rp('pizarra.compartirEnlace', await page.getByTestId('export-share-link').count());
    await page.keyboard.press('Escape');
  } else rp('pizarra.compartirEnlace', 'sin botón Exportar/Compartir');
  await context.close();
};

// Más (grupos nuevos: Pizarra en Entrenamiento, Comunicación, perfil unido)
SECCIONES.rpMas = async (browser) => {
  const { context, page } = await sesion(browser, COACH);
  await ir(page, '/mas', 5000);
  await shot(page, '270-mas');
  await shot(page, '270-mas-full', { full: true });
  fs.writeFileSync(path.join(TXT, '270-body.txt'), await page.evaluate(() => document.querySelector('main')?.innerText || ''));
  await context.close();
};

const SECC = process.argv.slice(2);
const orden = SECC.includes('todo') ? Object.keys(SECCIONES) : SECC;
if (!orden.length) { console.log('Uso: capture.mjs <seccion…>|todo. Secciones:', Object.keys(SECCIONES).join(' ')); process.exit(1); }

const browser = await launch();
try {
  for (const s of orden) {
    if (!SECCIONES[s]) throw new Error(`Sección desconocida: ${s}`);
    console.log(`▶ ${s}`);
    await SECCIONES[s](browser).catch(async (e) => {
      console.log(`  ✗ ${s}: ${e.message.split(/\r?\n/).slice(0, 3).join(' | ')}`);
      process.exitCode = 1;
      for (const c of browser.contexts()) {
        for (const pg of c.pages()) await pg.screenshot({ path: path.join(SHOTS, `_error-${s}.png`) }).catch(() => {});
        await c.close().catch(() => {});
      }
    });
  }
} finally {
  await browser.close();
  guardarDatos();
  if (httpErrores.length) fs.appendFileSync(path.join(TXT, '_http-errores.log'), httpErrores.map((l) => `${new Date().toISOString()} ${l}`).join('\n') + '\n');
}
export { leer, hoyCO, masDias };
