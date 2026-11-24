#!/usr/bin/env node
// Arma un informe markdown con los JSON que deja visual-qa.spec.ts.
// Uso: node e2e/visual-qa/resumen.mjs [dir] > informe.md
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || path.join(process.cwd(), 'test-results', 'visual-qa');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
if (!files.length) {
    console.error(`No hay resultados en ${dir}. Corre antes: npm run qa:visual`);
    process.exit(1);
}
const runs = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

const porRuta = new Map();
for (const r of runs) {
    if (!porRuta.has(r.ruta)) porRuta.set(r.ruta, []);
    porRuta.get(r.ruta).push(r);
}

const lines = [`# QA visual — ${new Date().toISOString().slice(0, 10)}`, '', `${runs.length} combinaciones (página × ancho × tema).`, ''];
lines.push('| Página | Redirige a | Carga máx (ms) | Errores JS | Scroll horiz. | Táctil chico | Contraste | Sin alt | Enlaces # | Sin nombre | h1 | Texto < 12px |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
const count = (rs, t) => rs.reduce((n, r) => n + r.hallazgos.filter((h) => h.tipo === t).length, 0);
for (const [ruta, rs] of porRuta) {
    const redir = [...new Set(rs.map((r) => r.urlFinal))].filter((u) => u !== ruta).join(', ') || '—';
    lines.push(
        `| \`${ruta}\` | ${redir} | ${Math.max(...rs.map((r) => r.cargaMs))} | ${rs.reduce((n, r) => n + r.erroresJs.length, 0)} | ${count(rs, 'scroll-horizontal')} | ${count(rs, 'tactil-chico')} | ${count(rs, 'contraste')} | ${count(rs, 'img-sin-alt')} | ${count(rs, 'enlace-muerto')} | ${count(rs, 'sin-nombre-accesible')} | ${count(rs, 'h1')} | ${count(rs, 'texto-chico')} |`,
    );
}
lines.push('');

for (const [ruta, rs] of porRuta) {
    lines.push(`## \`${ruta}\``, '');
    const agrupado = new Map();
    for (const r of rs) {
        for (const e of r.erroresJs) agrupado.set(`error-js|${e}`, [...(agrupado.get(`error-js|${e}`) || []), `${r.viewport}/${r.theme}`]);
        for (const h of r.hallazgos) {
            const k = `${h.tipo}|${h.detalle}|${h.selector || ''}`;
            agrupado.set(k, [...(agrupado.get(k) || []), `${r.viewport}/${r.theme}`]);
        }
    }
    if (!agrupado.size) {
        lines.push('Sin hallazgos.', '');
        continue;
    }
    const orden = ['error-js', 'promesa-sin-catch-red', 'scroll-horizontal', 'contraste', 'enlace-muerto', 'sin-nombre-accesible', 'img-sin-alt', 'h1', 'tactil-chico', 'texto-chico'];
    const items = [...agrupado.entries()].sort((a, b) => orden.indexOf(a[0].split('|')[0]) - orden.indexOf(b[0].split('|')[0]));
    for (const [k, donde] of items.slice(0, 40)) {
        const [tipo, detalle, selector] = k.split('|');
        lines.push(`- **${tipo}** — ${detalle}${selector ? ` — \`${selector}\`` : ''} _(${[...new Set(donde)].join(', ')})_`);
    }
    if (items.length > 40) lines.push(`- … y ${items.length - 40} más`);
    lines.push('');
}
console.log(lines.join('\n'));
