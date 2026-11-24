#!/usr/bin/env node
/**
 * Prueba de carga en escalera: ¿hasta dónde aguanta y cómo falla?
 *
 * Sube la concurrencia por escalones (p. ej. 5 → 10 → 25 → 50 → 100) y en cada
 * uno mide req/s, latencia p50/p95/p99, % de error y códigos HTTP. Se detiene
 * en el primer escalón que rompe un umbral y dice POR QUÉ falló (429 del
 * limitador, 5xx, timeouts, latencia).
 *
 * Sin dependencias (Node ≥ 18, fetch nativo).
 *
 * ── CANDADOS (no negociables, ver CLAUDE.md «Disk IO de la base») ───────────
 *  - Nunca contra *.supabase.co / *.supabase.in: la base es UNA para dev, stg
 *    y prod, y el 2026-10-14 se cayó todo ~14 h por agotar el Disk IO.
 *  - Por defecto solo localhost. Para un host remoto hace falta
 *    --permitir-remoto, y aun así la concurrencia se limita a 20 y la duración
 *    total a 2 min. Un endpoint remoto que lee la base ES carga sobre la base.
 *
 * Uso:
 *   node scripts/carga/escalera.mjs --url http://localhost:4000/health
 *   node scripts/carga/escalera.mjs --url http://localhost:4000/api/v1/me \
 *        --escalones 5,10,25,50 --duracion 10 --clientes 300 --ip-borde 172.70.1.1
 *
 * Opciones:
 *   --url URL              Endpoint (GET por defecto).
 *   --metodo GET|POST      Método HTTP.
 *   --body JSON            Cuerpo para POST.
 *   --header "K: V"        Cabecera extra (repetible).
 *   --escalones 5,10,...   Concurrencias a probar (default 5,10,25,50,100,200).
 *   --duracion N           Segundos por escalón (default 10).
 *   --timeout N            ms por petición antes de contarla como timeout (default 10000).
 *   --max-error N          % de error que se considera falla (default 1).
 *   --max-p95 N            p95 en ms que se considera falla (default 1500).
 *   --clientes N           Simula N clientes distintos (CF-Connecting-IP aleatoria por cliente).
 *   --ip-borde IP          Simula que todos llegan por el mismo borde de Cloudflare
 *                          (X-Forwarded-For = esa IP), como en Render.
 *   --seguir               No detenerse en el primer escalón que falla.
 *   --json RUTA            Guarda el informe en JSON.
 *   --permitir-remoto      Permite hosts que no son localhost (con topes).
 */

const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
const multi = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));

const url = opt('url');
if (!url) {
    console.error('Falta --url. Ver el encabezado del archivo para el uso.');
    process.exit(2);
}
const target = new URL(url);
const LOCAL = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname);

if (/(^|\.)supabase\.(co|in|com)$/i.test(target.hostname)) {
    console.error('✋ Bloqueado: no se hacen pruebas de carga contra Supabase (base única dev/stg/prod).');
    process.exit(3);
}
const remoto = !LOCAL;
if (remoto && !flag('permitir-remoto')) {
    console.error(`✋ ${target.hostname} no es localhost. Si de verdad querés probar un host remoto, agregá --permitir-remoto`);
    console.error('   (topes: concurrencia ≤ 20, total ≤ 2 min). Si el endpoint lee la base, es carga sobre la base.');
    process.exit(3);
}

const MAX_CONC_REMOTO = 20;
const MAX_TOTAL_REMOTO_S = 120;

let escalones = opt('escalones', '5,10,25,50,100,200')
    .split(',')
    .map((n) => parseInt(n, 10))
    .filter((n) => n > 0);
let duracion = Math.max(1, parseInt(opt('duracion', '10'), 10));
if (remoto) {
    escalones = escalones.filter((c) => c <= MAX_CONC_REMOTO);
    if (!escalones.length) escalones = [MAX_CONC_REMOTO];
    duracion = Math.min(duracion, Math.floor(MAX_TOTAL_REMOTO_S / escalones.length));
}

const metodo = opt('metodo', 'GET').toUpperCase();
const body = opt('body');
const timeoutMs = parseInt(opt('timeout', '10000'), 10);
const maxError = parseFloat(opt('max-error', '1'));
const maxP95 = parseFloat(opt('max-p95', '1500'));
const nClientes = parseInt(opt('clientes', '0'), 10);
const ipBorde = opt('ip-borde');
const extraHeaders = Object.fromEntries(
    multi('header').map((h) => {
        const i = h.indexOf(':');
        return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
    }),
);

const ipsClientes = Array.from({ length: nClientes }, (_, i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${(i & 255) + 1}`);

function pct(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function una(clienteIdx) {
    const headers = { ...extraHeaders };
    if (body) headers['content-type'] = 'application/json';
    if (ipsClientes.length) headers['cf-connecting-ip'] = ipsClientes[clienteIdx % ipsClientes.length];
    if (ipBorde) headers['x-forwarded-for'] = ipBorde;
    const t0 = performance.now();
    try {
        const res = await fetch(url, { method: metodo, headers, body, signal: AbortSignal.timeout(timeoutMs) });
        await res.arrayBuffer();
        return { ms: performance.now() - t0, status: res.status };
    } catch (e) {
        const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        return { ms: performance.now() - t0, status: timeout ? 'timeout' : 'conexion' };
    }
}

async function escalon(concurrencia) {
    const fin = Date.now() + duracion * 1000;
    const lat = [];
    const codigos = {};
    let siguienteCliente = 0;
    const worker = async () => {
        while (Date.now() < fin) {
            const r = await una(siguienteCliente++);
            lat.push(r.ms);
            codigos[r.status] = (codigos[r.status] || 0) + 1;
        }
    };
    const t0 = performance.now();
    await Promise.all(Array.from({ length: concurrencia }, worker));
    const seg = (performance.now() - t0) / 1000;
    lat.sort((a, b) => a - b);
    const total = lat.length;
    const errores = Object.entries(codigos)
        .filter(([c]) => !(Number(c) >= 200 && Number(c) < 400) && !esperado(c))
        .reduce((n, [, v]) => n + v, 0);
    return {
        concurrencia,
        total,
        rps: +(total / seg).toFixed(1),
        p50: Math.round(pct(lat, 50)),
        p95: Math.round(pct(lat, 95)),
        p99: Math.round(pct(lat, 99)),
        errorPct: total ? +((errores / total) * 100).toFixed(2) : 100,
        codigos,
    };
}

// Códigos que el endpoint devuelve "bien" aunque no sean 2xx (p. ej. 401 sin
// token): --esperado 401,404
const esperados = new Set(opt('esperado', '').split(',').filter(Boolean));
function esperado(c) {
    return esperados.has(String(c));
}

function diagnostico(r) {
    const c = r.codigos;
    const n = (k) => c[k] || 0;
    const motivos = [];
    if (n(429)) motivos.push(`${n(429)} respuestas 429 (limitador de peticiones)`);
    const x5 = Object.entries(c).filter(([k]) => /^5\d\d$/.test(k)).reduce((a, [, v]) => a + v, 0);
    if (x5) motivos.push(`${x5} respuestas 5xx (el servidor se cae o su dependencia falla)`);
    if (n('timeout')) motivos.push(`${n('timeout')} timeouts (> ${timeoutMs} ms)`);
    if (n('conexion')) motivos.push(`${n('conexion')} conexiones rechazadas/cortadas`);
    if (r.p95 > maxP95) motivos.push(`p95 ${r.p95} ms > ${maxP95} ms`);
    return motivos;
}

console.log(`\nEscalera de carga → ${metodo} ${url}`);
console.log(
    `Escalones: ${escalones.join(', ')} · ${duracion}s c/u · falla si error > ${maxError}% o p95 > ${maxP95} ms` +
        (nClientes ? ` · ${nClientes} clientes simulados` : '') +
        (ipBorde ? ` · todos por el borde ${ipBorde}` : '') +
        (remoto ? ' · REMOTO (con topes)' : ''),
);
console.log('');
console.log('conc │   req/s │  p50 ms │  p95 ms │  p99 ms │ error % │ códigos');
console.log('─────┼─────────┼─────────┼─────────┼─────────┼─────────┼────────────────────');

const resultados = [];
let ultimoOk = null;
let primeraFalla = null;
for (const c of escalones) {
    const r = await escalon(c);
    resultados.push(r);
    const motivos = r.errorPct > maxError || r.p95 > maxP95 ? diagnostico(r) : [];
    const cod = Object.entries(r.codigos)
        .map(([k, v]) => `${k}×${v}`)
        .join(' ');
    console.log(
        `${String(c).padStart(4)} │ ${String(r.rps).padStart(7)} │ ${String(r.p50).padStart(7)} │ ${String(r.p95).padStart(7)} │ ${String(r.p99).padStart(7)} │ ${String(r.errorPct).padStart(7)} │ ${cod}${motivos.length ? '  ✘' : ''}`,
    );
    if (motivos.length) {
        r.motivos = motivos;
        primeraFalla ??= r;
        if (!flag('seguir')) break;
    } else if (!primeraFalla) {
        ultimoOk = r;
    }
}

console.log('');
if (!primeraFalla) {
    console.log(`✔ Aguantó todos los escalones (hasta ${ultimoOk.concurrencia} concurrentes, ${ultimoOk.rps} req/s, p95 ${ultimoOk.p95} ms).`);
} else {
    console.log(
        ultimoOk
            ? `✔ Aguanta hasta ${ultimoOk.concurrencia} concurrentes (${ultimoOk.rps} req/s, p95 ${ultimoOk.p95} ms).`
            : '✘ Falla desde el primer escalón.',
    );
    console.log(`✘ Falla con ${primeraFalla.concurrencia} concurrentes: ${primeraFalla.motivos.join('; ')}.`);
}

const salida = opt('json');
if (salida) {
    const fs = await import('node:fs');
    fs.writeFileSync(
        salida,
        JSON.stringify(
            { fecha: new Date().toISOString(), url, metodo, duracion, escalones, nClientes, ipBorde, maxError, maxP95, resultados, ultimoOk, primeraFalla },
            null,
            2,
        ),
    );
    console.log(`Informe: ${salida}`);
}
process.exit(primeraFalla ? 1 : 0);
