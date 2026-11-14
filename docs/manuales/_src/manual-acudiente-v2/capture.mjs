// Pruebas reales + capturas del manual del Acudiente V2 (docs/manuales/v2/).
//
//   node docs/manuales/_src/manual-acudiente-v2/capture.mjs            # contra https://dev.sportmaps.co
//   BASE_URL=http://localhost:3001 node .../capture.mjs
//
// Celular 390×844 @3x (regla 08 de la V2). Login programático (sesión de
// supabase-js plantada en localStorage, igual que frontend/e2e/helpers/auth.ts).
// Tenant: SOLO Club Campestre Demo (is_demo=true). Cuentas en lib.mjs.
//
// Escribe en el tenant demo (todo queda anotado en docs/manuales/v2/pruebas-acudiente-v2.md):
//   - un documento «Otro documento» de prueba en la ficha de Sofía (bucket identity-documents);
//   - un comprobante de transferencia de prueba para el primer cobro marcado de Mauricio;
//   - (desde 2026-10-28) la respuesta «Va» de Tomás a la convocatoria vs Halcones FC
//     (lineup 537b7aaa…), tocada en el detalle del partido del Calendario.
// NUNCA paga: el botón de la pasarela se captura y se cierra el diálogo.
// Es reanudable: si ya existe shots/<captura>.png de un paso que escribe, ese paso no se repite.
//
// El flujo del código de escuela (registro de la cuenta sin escuela, /unirse,
// asignación en «Por asignar») se corrió una sola vez con codigo-escuela/*.mjs:
// no se puede repetir con la misma cuenta. Sus capturas ya están en shots/.
// Los dos partidos del demo (vs Halcones FC y vs Deportivo Arrayanes, con convocatoria,
// resultado, evaluación y reporte) se crearon como owner con partidos-demo/*.mjs.
import fs from 'node:fs';
import path from 'node:path';
import * as lib from './lib.mjs';

const SHOTS = path.join(lib.here, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const RESULTS = path.join(SHOTS, 'resultados.json');
const results = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, 'utf8')) : {};

const PARENT = 'mherrera@demo.sportmaps.co';         // Mauricio Herrera · Sofía (Natación) y Tomás (Fútbol Sub-15, Tenis)
const TOMAS = '7167931e-0798-43e8-a286-d4985b0965b6';
const SOFIA = 'fcf4d2d1-eb3c-4b09-8f08-a7777f11768e';
const has = (f) => fs.existsSync(path.join(SHOTS, f));

let page, errors;
const snap = (name) => page.screenshot({ path: path.join(SHOTS, name) });
const full = (name) => lib.fullShot(page, path.join(SHOTS, name));
const el = (locator, name, pad) => lib.clipShot(page, locator, path.join(SHOTS, name), pad);
const text = () => page.evaluate(() => (document.querySelector('[role=dialog]') || document.querySelector('main') || document.body).innerText);

const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
async function test(id, nombre, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  errors.length = 0;
  const t0 = Date.now();
  try {
    const nota = await fn();
    results[id] = { nombre, estado: 'PASA', nota: nota || '', errores: [...new Set(errors)], ms: Date.now() - t0 };
  } catch (e) {
    results[id] = { nombre, estado: 'FALLA', nota: String(e.message || e).split('\n')[0].slice(0, 300), errores: [...new Set(errors)], ms: Date.now() - t0 };
    await snap(`zz-falla-${id}.png`).catch(() => {});
  }
  console.log(`${results[id].estado.padEnd(5)} ${id} ${nombre}${results[id].nota ? ' — ' + results[id].nota : ''}`);
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
}
const expectText = async (re, msg) => { const t = await text(); if (!re.test(t)) throw new Error(msg || `No aparece ${re}`); };

// Imagen de prueba (documento / comprobante) generada con el mismo Chromium.
async function makeImage(browser, file, html) {
  if (fs.existsSync(file)) return file;
  const p = await browser.newPage({ viewport: { width: 600, height: 800 } });
  await p.setContent(`<body style="margin:0;font-family:Arial;background:#fff">${html}</body>`);
  await p.screenshot({ path: file });
  await p.close();
  return file;
}

async function run() {
  const browser = await lib.launch();
  const tmp = path.join(lib.here, 'shots', 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const docPrueba = await makeImage(browser, path.join(tmp, 'documento-prueba.png'),
    '<div style="margin:40px;border:3px dashed #999;padding:40px;text-align:center"><h1>DOCUMENTO DE PRUEBA</h1><p>Generado por el manual del Acudiente V2 (tenant demo).</p><p>No es un documento real.</p></div>');
  const comprobante = await makeImage(browser, path.join(tmp, 'comprobante-prueba.png'),
    '<div style="margin:30px;padding:30px;border:1px solid #ccc;border-radius:16px"><h2 style="color:#5b2b82">Transferencia exitosa</h2><p>Fecha: 26/10/2026 10:15 a. m.</p><p>Valor: <b>$ 280.000</b></p><p>Para: Club Campestre Demo</p><p>Referencia: M1234567 (PRUEBA DEMO)</p><p>Estado: Aprobada</p></div>');

  try {
    ({ page, errors } = await lib.newSession(browser, PARENT));

    // ── 1. Inicio ──────────────────────────────────────────────────────────
    await test('inicio', 'Inicio: saldo, próximo entreno, tarjetas de hijos, torneos', async () => {
      await lib.go(page, '/dashboard', 4000);
      await expectText(/cobros? pendientes?|Todo al día/);
      await snap('01-inicio.png');
      await full('01-inicio-completo.png');
      const t = await text();
      const conv = page.locator('[data-testid="convocatoria-hijo"]').first();
      if (await conv.count()) {
        // La tarjeta del hijo convocado entera (la convocatoria vive dentro de ella).
        const tarjeta = conv.locator('xpath=ancestor::*[contains(@class,"rounded")][1]');
        if (!has('01c-inicio-convocatoria.png')) await el(tarjeta, '01c-inicio-convocatoria.png', 8);
      }
      const torneos = page.getByText(/Torneos\/ligas abiertos/).first().locator('xpath=ancestor::section[1]');
      if (await torneos.count()) await el(torneos, '01e-inicio-torneos.png', 8).catch(() => {});
      const obs = [];
      if (/p\. m\.\./.test(t)) obs.push('Frase del entreno termina en «p. m..» (doble punto)');
      if (!/El más antiguo/.test(t) && /cobros pendientes/.test(t)) obs.push('Sin la frase del cobro más antiguo (#26)');
      if (!(await conv.count())) obs.push('Sin tarjeta de convocatoria en Inicio');
      return obs.join('; ');
    });
    await test('inicio-ver-como-va', 'Inicio → «Ver cómo va» abre la ficha del hijo', async () => {
      await lib.go(page, '/dashboard', 3500);
      await page.getByText('Ver cómo va').nth(1).click();
      await lib.settle(page, 2500);
      if (!/\/children/.test(page.url())) throw new Error('No navegó a Hijos: ' + page.url());
      return page.url().replace(lib.BASE_URL, '');
    });
    await test('inicio-pagar', 'Inicio → «Pagar $…» lleva a Pagos', async () => {
      await lib.go(page, '/dashboard', 3500);
      await page.getByRole('button', { name: /^Pagar \$/ }).or(page.getByRole('link', { name: /^Pagar \$/ })).first().click();
      await lib.settle(page, 2500);
      const u = page.url().replace(lib.BASE_URL, '');
      if (!/my-payments|estado-cuenta|pagos/i.test(u) && !(await page.getByRole('dialog').count())) throw new Error('No llevó a pagos: ' + u);
      await page.keyboard.press('Escape').catch(() => {});
      return u;
    });

    // ── 2. Calendario ──────────────────────────────────────────────────────
    await test('cal-proximos', 'Calendario › Próximos: entrenos y partido de los hijos', async () => {
      await lib.go(page, '/calendar', 3500);
      await snap('02-cal-proximos.png');
      await expectText(/Halcones FC/, 'El partido programado (vs Halcones FC) no aparece en Próximos');
      const card = page.getByText('Partido vs Halcones FC').first().locator('xpath=ancestor::*[contains(@class,"rounded")][1]');
      await el(card, '02b-cal-partido.png', 12);
    });
    await test('cal-detalle', 'Calendario: tocar un evento abre su detalle (lugar con mapa, nota, convocatoria)', async () => {
      await lib.go(page, '/calendar', 3500);
      await page.getByText('Partido vs Halcones FC').first().click();
      await lib.settle(page, 2500);
      const dlg = page.getByRole('dialog');
      if (!(await dlg.count())) throw new Error('Tocar la tarjeta del partido en «Próximos» no abre ningún detalle');
      const t = await dlg.innerText();
      if (!/Ver mapa/.test(t)) throw new Error('El detalle no trae «Ver mapa»');
      const href = await dlg.getByRole('link', { name: /Ver mapa/ }).getAttribute('href');
      await snap('02c-cal-detalle.png');
      return `mapa: ${href?.slice(0, 60)}`;
    });
    await test('convocatoria-responder', 'Convocatoria: el acudiente responde «Va» desde el detalle del partido', async () => {
      if (has('02d-cal-detalle-va.png')) return 'Ya respondida en una corrida anterior';
      await lib.go(page, '/calendar', 3500);
      await page.getByText('Partido vs Halcones FC').first().click();
      await lib.settle(page, 2500);
      const dlg = page.getByRole('dialog');
      const va = dlg.getByRole('button', { name: /^Va$/ });
      if (!(await va.count())) throw new Error('El detalle del partido no muestra «Va / No va»');
      await va.click();
      await lib.settle(page, 1200);
      const toast = await page.evaluate(() => [...document.querySelectorAll('[data-sonner-toast]')].map((e) => e.innerText).join(' | '));
      await snap('02d-cal-detalle-va.png');
      if (!/va al partido/.test(await dlg.innerText())) throw new Error('Tras tocar «Va» no aparece «… va al partido»');
      return `toast: ${toast.replace(/\n+/g, ' ')}`;
    });
    await test('cal-torneos', 'Calendario › Torneos: inscritos y abiertos', async () => {
      await lib.go(page, '/calendar', 3000);
      await page.getByText('Torneos', { exact: true }).first().click();
      await lib.settle(page, 2500);
      await expectText(/Copa|torneo/i);
      await snap('03-cal-torneos.png');
    });
    await test('cal-mes', 'Calendario › Mes: cuadrícula + Próximos eventos, sin «Nuevo evento»', async () => {
      await lib.go(page, '/calendar', 3000);
      await page.getByText('Mes', { exact: true }).first().click();
      await lib.settle(page, 2500);
      await snap('04-cal-mes.png');
      await full('04-cal-mes-completo.png');
      if (await page.getByRole('button', { name: /Nuevo Evento/i }).count()) throw new Error('El acudiente ve «Nuevo Evento» (regla: no crea eventos)');
      const dia = page.locator('button').filter({ hasText: /^31$/ }).last();
      await dia.click().catch(() => {});
      await lib.settle(page, 1200);
      await full('04b-cal-mes-dia.png');
    });

    // ── 3. Hijos ───────────────────────────────────────────────────────────
    const hijo = async (who, tab) => {
      await lib.go(page, `/children?hijo=${who}&tab=${tab}`, 3500);
    };
    await test('hijos-progreso', 'Hijos › Progreso (Tomás)', async () => {
      await hijo(TOMAS, 'progreso');
      await expectText(/Tomás Herrera/);
      await snap('05-hijos-progreso.png');
      await full('05-hijos-progreso-completo.png');
    });
    await test('hijos-selector', 'Hijos: cambiar de hijo con el selector', async () => {
      await hijo(TOMAS, 'progreso');
      await page.getByRole('radio', { name: /Sofía/ }).first().click();
      await lib.settle(page, 2000);
      await expectText(/Sofía Herrera/);
    });
    await test('hijos-asistencia', 'Hijos › Asistencia + historial completo', async () => {
      await hijo(TOMAS, 'asistencia');
      await expectText(/Últimos entrenos|asistencia/i);
      await snap('06-hijos-asistencia.png');
      await lib.go(page, `/children/${TOMAS}/attendance`, 3500);
      await expectText(/Asistencia de Tomás/);
      await snap('06b-asistencia-historial.png');
    });
    await test('hijos-informes', 'Hijos › Informes (informe mensual, del entreno, de partidos)', async () => {
      await hijo(TOMAS, 'informes');
      await page.getByText(/Informe de septiembre/).first().waitFor({ timeout: 20000 });
      await lib.settle(page, 800);
      await snap('07-hijos-informes.png');
    });
    await test('informe-mensual', 'Informe mensual: detalle + Descargar PDF', async () => {
      await lib.go(page, `/children/${TOMAS}/reports`, 3000);
      await page.getByText(/Informe de septiembre 2026/).first().click();
      await lib.settle(page, 3500);
      await expectText(/Lo mejor del mes|Del equipo/);
      await snap('10-informe-mensual.png');
      await full('10-informe-mensual-completo.png');
      const pdf = page.getByRole('button', { name: /Descargar PDF/ }).or(page.getByRole('link', { name: /Descargar PDF/ })).first();
      const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      const pop = page.context().waitForEvent('page', { timeout: 20000 }).catch(() => null);
      await pdf.click();
      const r = await Promise.race([dl, pop, new Promise((res) => setTimeout(() => res('nada'), 20000))]);
      if (r === 'nada' || r == null) throw new Error('«Descargar PDF» no descargó ni abrió nada en 20 s');
      return r.suggestedFilename ? `Descarga: ${r.suggestedFilename()}` : 'Abrió pestaña nueva';
    });
    await test('post-entreno-informe', 'Informe del entreno (grupal) /children/:id/post-entreno-informe', async () => {
      await lib.go(page, `/children/${TOMAS}/post-entreno-informe`, 3500);
      await snap('11-post-entreno-informe.png');
      const t = await text();
      return /todavía no publica/.test(t) ? 'Estado vacío: la escuela demo no tiene informe publicado este mes (BFF 404 esperado)' : '';
    });
    await test('autoevaluacion', 'Autoevaluación post-entreno desde la notificación (/post-entreno/:sesión)', async () => {
      await lib.go(page, `/post-entreno/0bdb549f-6481-4677-8ed7-51622a7d6d7f?child_id=${TOMAS}`, 3500);
      await snap('11b-autoevaluacion.png');
      return (await text()).replace(/\n+/g, ' | ').slice(0, 160);
    });
    await test('partidos-reporte', 'Partidos: reporte del profe y respuesta de la familia', async () => {
      await lib.go(page, `/children/${TOMAS}/partidos`, 3500);
      await expectText(/Deportivo Arrayanes/, 'No aparece el reporte publicado del partido vs Deportivo Arrayanes');
      await expectText(/Editar mi respuesta|Tu respuesta/);
      await snap('12-partidos.png');
      await full('12-partidos-completo.png');
    });
    await test('evaluacion-partido', 'Evaluación del partido publicada visible para la familia (Progreso)', async () => {
      await lib.go(page, `/children/${TOMAS}/progress`, 3500);
      await expectText(/Actitud|Técnica/);
      await full('13-progreso-con-partido.png');
      const tGraf = await text();
      if (/Comentario\s*\n?\s*0/.test(tGraf)) throw new Error('Gráficas: el «Comentario del coach» sale como «Comentario 0»');
      // B6: «Lo que dijo el profe» vive en la pestaña Progreso de Hijos.
      await hijo(TOMAS, 'progreso');
      await full('13c-hijos-progreso-completo.png');
      const dijo = page.getByText('Lo que dijo el profe').first().locator('xpath=ancestor::*[self::section or contains(@class,"rounded")][1]');
      if (await dijo.count()) await el(dijo, '13b-lo-que-dijo-el-profe.png', 8).catch(() => {});
      const t = await text();
      if (/Comentario\s*\n?\s*0/.test(t)) throw new Error('El «Comentario del coach» (texto) se muestra como «Comentario 0»');
      if (!/Lo que dijo el profe/.test(t)) throw new Error('No aparece «Lo que dijo el profe»');
    });
    await test('convocatoria-va-no-va', 'Convocatoria: el aviso lleva a responder y la respuesta queda en Inicio', async () => {
      await lib.go(page, '/notifications', 3500);
      await expectText(/Convocatoria: vs Halcones FC/);
      await snap('15-notif-convocatoria.png');
      await page.getByText(/Convocatoria: vs Halcones FC/).first().click();
      await lib.settle(page, 3500);
      const u = page.url().replace(lib.BASE_URL, '');
      await snap('15b-convocatoria-destino.png');
      await lib.go(page, '/dashboard', 4000);
      const conv = page.locator('[data-testid="convocatoria-hijo"]').first();
      if (!(await conv.count())) throw new Error('Inicio no muestra la convocatoria de Tomás');
      const t = await conv.innerText();
      await el(conv.locator('xpath=ancestor::*[contains(@class,"rounded")][1]'), '01d-inicio-va.png', 8);
      if (!/va al partido|no puede ir/.test(t)) throw new Error('Inicio no refleja la respuesta: ' + t.replace(/\n+/g, ' | '));
      return `aviso → ${u}; Inicio: ${t.replace(/\n+/g, ' | ').slice(0, 120)}`;
    });
    await test('ficha-salud', 'Hijos › Ficha y salud: datos, 10 documentos, carnet, corregir', async () => {
      await hijo(SOFIA, 'ficha');
      await expectText(/Documentos/);
      await expectText(/Firma del deportista/);
      await snap('08-hijos-ficha.png');
      await full('08-hijos-ficha-completo.png');
    });
    await test('ficha-corregir', 'Ficha: «Corregir un dato» abre el formulario', async () => {
      await hijo(SOFIA, 'ficha');
      await page.getByRole('button', { name: 'Corregir un dato' }).click();
      await lib.settle(page, 1500);
      if (!(await page.getByRole('dialog').count())) throw new Error('No abrió diálogo');
      await snap('08c-corregir-dato.png');
      await page.keyboard.press('Escape');
    });
    await test('documento-subir', 'Documentos: subir «Otro documento» de prueba (Sofía) y verlo', async () => {
      await hijo(SOFIA, 'ficha');
      const fila = page.locator('div').filter({ has: page.getByText('Otro documento', { exact: true }) }).filter({ has: page.getByRole('button') }).last();
      if (!has('09-documento-subido.png')) {
        const chooser = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
        await fila.getByRole('button', { name: /Subir|Cambiar/ }).first().click();
        const fc = await chooser;
        if (fc) await fc.setFiles(docPrueba);
        else await page.locator('input[type=file]').setInputFiles(docPrueba);
        await lib.settle(page, 5000);
        await expectText(/cargado|Listo/i).catch(() => {});
      }
      await hijo(SOFIA, 'ficha');
      await fila.scrollIntoViewIfNeeded();
      if (!(await fila.getByRole('button', { name: 'Ver' }).count())) throw new Error('Tras subir, la fila no muestra «Ver»');
      await el(fila, '09-documento-subido.png', 10);
    });
    await test('carnet', 'Carnet digital: lista, abrir en grande, reverso', async () => {
      await lib.go(page, '/my-cards', 3000);
      await expectText(/Vigente|vigentes/);
      await snap('14-carnets.png');
      await page.getByText('Tomás Herrera').first().click();
      await lib.settle(page, 2000);
      await snap('14b-carnet-grande.png');
      const rev = page.getByRole('button', { name: /reverso/i });
      if (await rev.count()) { await rev.click(); await lib.settle(page, 1200); await snap('14c-carnet-reverso.png'); }
      await page.keyboard.press('Escape');
    });
    await test('agregar-hijo', 'Hijos › «Agregar hijo» abre el formulario', async () => {
      await lib.go(page, '/children', 3000);
      await page.getByRole('button', { name: /Agregar hijo/ }).first().click();
      await lib.settle(page, 1500);
      if (!(await page.getByRole('dialog').count())) throw new Error('No abrió');
      await snap('08d-agregar-hijo.png');
      await page.keyboard.press('Escape');
    });

    // ── 4. Pagos ───────────────────────────────────────────────────────────
    await test('pagos-por-pagar', 'Pagos › Por pagar: total, cobros marcados, barra de pago', async () => {
      await lib.go(page, '/my-payments', 3500);
      await expectText(/Debes/);
      await snap('16-pagos-por-pagar.png');
      await full('16-pagos-completo.png');
      const t = await text();
      if (/Tú \(como atleta\)/.test(t)) throw new Error('Cobros de Tomás salen como «Tú (como atleta)» (B8)');
    });
    await test('pagos-desmarcar', 'Pagos: desmarcar un cobro recalcula el total', async () => {
      await lib.go(page, '/my-payments', 3500);
      const barra = page.getByRole('button', { name: /^Pagar \d+ cobros/ });
      const antes = await barra.textContent();
      await page.getByRole('checkbox').first().click();
      await lib.settle(page, 800);
      const despues = await page.getByRole('button', { name: /^Pagar/ }).last().textContent();
      if (antes === despues) throw new Error('El total no cambió al desmarcar');
      return `${antes} → ${despues}`;
    });
    await test('pagos-online', 'Pagar en línea: llega hasta el botón de la pasarela (sin pagar)', async () => {
      await lib.go(page, '/my-payments', 3500);
      await page.getByRole('button', { name: /^Pagar \d+ cobros/ }).click();
      await lib.settle(page, 2500);
      await expectText(/Pagar online|Método de pago/);
      await snap('17-pagar-online.png');
      await page.keyboard.press('Escape');
      return 'Se detuvo antes de «Pagar online»; no se abrió la pasarela';
    });
    await test('pagos-comprobante', 'Ya transferí: subir comprobante de prueba', async () => {
      await lib.go(page, '/my-payments', 3500);
      await page.getByRole('button', { name: /Ya transferí/ }).click();
      await lib.settle(page, 2500);
      const dlg = page.getByRole('dialog');
      const preOnline = !/Información de Transferencia/.test(await dlg.innerText());
      await lib.settle(page, 1500);
      await snap('18-transferencia.png');
      await full('18-transferencia-completo.png');
      if (!has('19-comprobante-enviado.png')) {
        await dlg.locator('input[type=file]').first().setInputFiles(comprobante);
        await lib.settle(page, 9000);
        await snap('18b-comprobante-cargado.png');
        const enviar = dlg.getByRole('button', { name: /Enviar|Confirmar|Registrar|Pagar/ }).last();
        const etiqueta = await enviar.textContent();
        if (await enviar.isDisabled()) throw new Error(`El botón «${etiqueta}» quedó deshabilitado tras cargar el comprobante: ${(await dlg.innerText()).replace(/\n+/g, ' | ').slice(-300)}`);
        await enviar.click();
        await lib.settle(page, 5000);
        await snap('19-comprobante-enviado.png');
      }
      if (preOnline) throw new Error('«Ya transferí» abre el pago sin Transferencia marcada (B7)');
      const titulo = (await dlg.innerText()).split('\n').slice(0, 3).join(' | ');
      return `Abre con Transferencia marcada. Encabezado: ${titulo}`;
    });
    await test('pagos-en-revision', 'Pagos: el cobro con comprobante queda «En revisión»', async () => {
      await lib.go(page, '/my-payments', 3500);
      await expectText(/En revisión/);
      await full('19b-en-revision.png');
    });
    await test('pagos-pagados', 'Pagos › Pagados: historial y recibo', async () => {
      await lib.go(page, '/my-payments', 3000);
      await page.getByText('Pagados', { exact: true }).first().click();
      await lib.settle(page, 2000);
      await snap('20-pagados.png');
      const rec = page.getByRole('button', { name: 'Recibo' }).first();
      if (await rec.count()) { await rec.click(); await lib.settle(page, 2500); await snap('20b-recibo.png'); await page.keyboard.press('Escape'); }
      else return 'Ningún pago con botón Recibo';
    });
    await test('estado-cuenta', 'Estado de cuenta por hijo (mes a mes, imprimir)', async () => {
      await lib.go(page, '/estado-cuenta', 3000);
      await snap('21-estado-elegir.png');
      await page.getByText('Tomás Herrera').first().click();
      await lib.settle(page, 3500);
      await expectText(/MES A MES|Mes a mes/i);
      await snap('21b-estado-cuenta.png');
      await full('21c-estado-completo.png');
    });

    // ── 5. Más ─────────────────────────────────────────────────────────────
    await test('mas', 'Más: lista completa de módulos', async () => {
      await lib.go(page, '/mas', 3000);
      await snap('22-mas.png');
      await full('22-mas-completo.png');
      const t = await text();
      const faltan = ['Inscripciones y planes', 'Mis eventos y torneos', 'Carnets', 'Constancias', 'Salud de mis hijos', 'Mis citas', 'Mensajes', 'Centro de ayuda', 'Notificaciones', 'Mi cuenta', 'Cerrar sesión'].filter((x) => !t.includes(x));
      if (faltan.length) throw new Error('Faltan: ' + faltan.join(', '));
      return t.includes('Explorar') ? 'Explorar aparece (VITE_SHOW_EXPLORE=true en dev)' : '';
    });
    const masLink = (label, id, nombre, shot, check) => test(id, nombre, async () => {
      await lib.go(page, '/mas', 2500);
      await page.getByRole('link', { name: new RegExp('^' + label) }).first().click();
      await lib.settle(page, 3500);
      if (check) await expectText(check);
      if (await page.getByText(/^Volver a Más$/).count() === 0 && !/ayuda|explorar/.test(page.url())) return 'Sin «Volver a Más» en ' + page.url().replace(lib.BASE_URL, '');
      await snap(shot);
      return page.url().replace(lib.BASE_URL, '');
    });
    await masLink('Inscripciones y planes', 'mas-inscripciones', 'Más › Inscripciones y planes', '27-inscripciones.png', /Inscripciones y planes/);
    await masLink('Mis eventos y torneos', 'mas-eventos', 'Más › Mis eventos y torneos', '28-eventos.png', /Eventos y torneos/);
    await masLink('Constancias', 'mas-constancias', 'Más › Constancias', '28b-constancias.png', /Constancias/);
    await masLink('Mis compras', 'mas-compras', 'Más › Mis compras', '28c-compras.png', /Mis compras/);
    await masLink('Salud de mis hijos', 'mas-salud', 'Más › Salud de mis hijos', '28d-salud.png', /Salud de mis hijos/);
    await masLink('Mis citas', 'mas-citas', 'Más › Mis citas', '28e-citas.png', null);
    await masLink('Mensajes', 'mas-mensajes', 'Más › Mensajes', '29-mensajes.png', /Mensajes/);
    await masLink('Centro de ayuda', 'mas-ayuda', 'Más › Centro de ayuda', '25-ayuda.png', /Centro de Ayuda/);
    await masLink('Notificaciones', 'mas-notificaciones', 'Más › Notificaciones', '24-notificaciones.png', /Notificaciones/);
    await masLink('Mi cuenta', 'mas-mi-cuenta', 'Más › Mi cuenta (perfil + configuración)', '23-mi-cuenta.png', /Mi cuenta/);
    await test('mi-cuenta-secciones', 'Mi cuenta: Perfil, Notificaciones, Privacidad, Seguridad abren', async () => {
      const malas = [];
      errors.length = 0;
      for (const s of ['Perfil', 'Notificaciones', 'Privacidad', 'Seguridad']) {
        await lib.go(page, '/settings', 2500);
        await page.getByText(s, { exact: true }).first().click();
        await lib.settle(page, 2000);
        await snap(`23-${s.toLowerCase()}.png`);
        const t = await text();
        if (t.length < 80) malas.push(s);
      }
      if (malas.length) throw new Error('Sin contenido: ' + malas.join(', '));
      const e500 = errors.filter((e) => /http 5\d\d/.test(e));
      if (e500.length) throw new Error('Errores 5xx: ' + e500.join(' ; '));
    });
    await test('mas-whatsapp', 'Más › Escribirle al club (WhatsApp)', async () => {
      await lib.go(page, '/mas', 2500);
      const a = page.getByRole('link', { name: /Escribirle al club/ });
      if (!(await a.count())) throw new Error('No aparece «Escribirle al club»');
      const href = await a.getAttribute('href');
      if (!/wa\.me|whatsapp/.test(href || '')) throw new Error('href raro: ' + href);
      return href.replace(/\d{6}(\d{4})/, '******$1');
    });
    await test('mapi', 'Mapi (asistente) responde una pregunta', async () => {
      await lib.go(page, '/dashboard', 3500);
      const fab = page.getByRole('button', { name: /Mapi|asistente|ayuda|soporte|Sportbot/i }).last();
      await fab.click();
      await lib.settle(page, 2500);
      await snap('26-mapi.png');
      const box = page.getByPlaceholder(/Escribe tu mensaje/).last();
      await box.fill('¿Cómo subo el comprobante de una transferencia?');
      await box.press('Enter');
      await lib.settle(page, 20000);
      await snap('26b-mapi-respuesta.png');
      return (await page.evaluate(() => document.body.innerText)).split('¿Cómo subo el comprobante de una transferencia?').pop().replace(/\n+/g, ' ').slice(0, 220);
    });
    await test('rutas-staff', 'Rutas de staff por URL (/announcements, /dashboard/polls) no deben ofrecer crear al acudiente', async () => {
      await lib.go(page, '/announcements', 3000);
      const a = /Nuevo Anuncio/.test(await text());
      await snap('zz-announcements.png');
      await lib.go(page, '/dashboard/polls', 3000);
      const b = /Crea la encuesta/.test(await text());
      await snap('zz-polls.png');
      if (a || b) throw new Error(`Por URL el acudiente ve ${a ? '«Nuevo Anuncio»' : ''}${a && b ? ' y ' : ''}${b ? '«Crea la encuesta del día» (BFF 403)' : ''}`);
    });
    await test('volver', 'Pantallas internas muestran «Volver a <pestaña>»', async () => {
      const casos = [[`/children/${TOMAS}/partidos`, 'Hijos'], ['/estado-cuenta', 'Pagos'], ['/my-cards', 'Más'], ['/my-event-registrations', 'Calendario']];
      const malas = [];
      for (const [u, tab] of casos) {
        await lib.go(page, u, 2500);
        if (!(await page.getByText(`Volver a ${tab}`).count())) malas.push(u);
      }
      if (malas.length) throw new Error('Sin «Volver»: ' + malas.join(', '));
    });
  } finally {
    await browser.close();
  }
  const n = Object.values(results).reduce((a, r) => ({ ...a, [r.estado]: (a[r.estado] || 0) + 1 }), {});
  console.log('\nResumen:', n);
}

run().catch((e) => { console.error(e); process.exit(1); });
