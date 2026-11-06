// Precarga (node -r) del BFF que se levanta contra el GEMELO LOCAL para QA.
//  1. Bloquea cualquier conexion que no sea loopback (dns.lookup + fetch): ningun
//     correo, cobro ni llamada a Meta/Resend/Anthropic/Wompi/MP puede salir.
//  2. Simula la API publica de Wompi (GET sandbox.wompi.co/v1/transactions/:id) leyendo
//     WOMPI_MOCK_FILE (JSON { "<txId>": {status, reference, amount_in_cents, currency} }),
//     porque el webhook re-consulta la transaccion. Sin red real.
const dns = require('dns');
const fs = require('fs');

const LOCAL = /^(127\.0\.0\.1|localhost|::1|host\.docker\.internal)$/i;
const bloqueados = [];

const origLookup = dns.lookup;
dns.lookup = function (hostname, ...rest) {
    if (typeof hostname === 'string' && !LOCAL.test(hostname) && !/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        bloqueados.push(hostname);
        console.error(`[solo-localhost] DNS BLOQUEADO: ${hostname}`);
        const cb = rest[rest.length - 1];
        const err = Object.assign(new Error(`solo-localhost: ${hostname} bloqueado`), { code: 'ENOTFOUND' });
        if (typeof cb === 'function') return process.nextTick(cb, err);
        throw err;
    }
    return origLookup.call(dns, hostname, ...rest);
};

const origFetch = global.fetch;
global.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    let u;
    try { u = new URL(url); } catch { return origFetch(input, init); }
    if (LOCAL.test(u.hostname)) return origFetch(input, init);
    const m = u.hostname === 'sandbox.wompi.co' && u.pathname.match(/\/v1\/transactions\/([^/]+)$/);
    if (m && (!init || !init.method || init.method === 'GET')) {
        let db = {};
        try { db = JSON.parse(fs.readFileSync(process.env.WOMPI_MOCK_FILE, 'utf8')); } catch { /* vacio */ }
        const tx = db[m[1]];
        if (!tx) return new Response(JSON.stringify({ error: 'not found (mock)' }), { status: 404 });
        return new Response(JSON.stringify({ data: { id: m[1], payment_method_type: 'CARD', created_at: new Date().toISOString(), ...tx } }), { status: 200 });
    }
    // MercadoPago simulado: GET /v1/payments/:id (clave "mp:<id>" del mismo archivo) y POST /checkout/preferences.
    const mp = u.hostname === 'api.mercadopago.com';
    if (mp) {
        const method = (init && init.method) || 'GET';
        const calls = (process.env.WOMPI_MOCK_FILE || '') + '.calls.jsonl';
        try { fs.appendFileSync(calls, JSON.stringify({ host: u.hostname, path: u.pathname, method, body: init && init.body ? String(init.body) : null }) + '
'); } catch { /* */ }
        const mm = u.pathname.match(/^/v1/payments/([^/]+)$/);
        if (mm && method === 'GET') {
            let db = {};
            try { db = JSON.parse(fs.readFileSync(process.env.WOMPI_MOCK_FILE, 'utf8')); } catch { /* */ }
            const p = db['mp:' + mm[1]];
            return p ? new Response(JSON.stringify({ id: Number(mm[1]) || mm[1], currency_id: 'COP', ...p }), { status: 200 }) : new Response('{"message":"not found (mock)"}', { status: 404 });
        }
        if (u.pathname === '/checkout/preferences' && method === 'POST') {
            return new Response(JSON.stringify({ id: 'pref-t1-mock', init_point: 'https://www.mercadopago.com.co/checkout/v1/redirect?pref_id=pref-t1-mock', sandbox_init_point: 'https://sandbox.mercadopago.com.co/checkout/v1/redirect?pref_id=pref-t1-mock' }), { status: 201 });
        }
    }
    bloqueados.push(url);
    console.error(`[solo-localhost] FETCH BLOQUEADO: ${init?.method ?? 'GET'} ${u.origin}${u.pathname}`);
    throw new TypeError(`solo-localhost: ${u.hostname} bloqueado`);
};

console.log(`[solo-localhost] SUPABASE_URL efectivo (antes de dotenv) = ${process.env.SUPABASE_URL}`);
setTimeout(() => console.log(`[solo-localhost] SUPABASE_URL efectivo (arrancado) = ${process.env.SUPABASE_URL} · DOTENV cwd=${process.cwd()}`), 1500).unref();
