#!/usr/bin/env node
/**
 * Compuerta estática de las reglas de la V2 (ROADMAP «Track V2», DESIGN.md §12).
 *
 * Busca en frontend/src lo que las reglas de la V2 prohíben y se puede ver en el
 * código sin abrir la app:
 *
 *   px-fijo       w-[300px], h-[39px]…        → «cero píxeles fijos, solo tokens» (V2-0a)
 *   texto-chico   text-[10px], text-[11px]…   → mínimo 12px (docs/design-tokens.md)
 *   color-fijo    bg-[#4dcc4c], text-[#8a9186] → rompe dark mode y la marca de la escuela
 *   seguro        «¿Seguro…?», window.confirm → «Deshacer en vez de ¿Seguro?» (V2-0c)
 *   voseo         querés, tenés, podés…       → «palabras de la cancha», de tú (V2-0b)
 *
 * Funciona como TRINQUETE: compara contra scripts/v2-gate/baseline.json y falla
 * solo si un archivo empeora en alguna regla (o aparece uno nuevo con
 * hallazgos). La deuda vieja no bloquea; la nueva no entra.
 *
 *   node scripts/v2-gate/run.mjs                 # informe + compuerta contra la línea base
 *   node scripts/v2-gate/run.mjs --solo-v2       # solo carpetas …/v2/
 *   node scripts/v2-gate/run.mjs --actualizar    # reescribe la línea base (tras pagar deuda)
 *   node scripts/v2-gate/run.mjs --md salida.md  # informe en markdown
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');
const SRC = path.join(REPO, 'frontend', 'src');
const BASELINE = path.join(here, 'baseline.json');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
};

export const REGLAS = {
    'px-fijo': {
        regla: 'Cero píxeles fijos: usar tokens (docs/design-tokens.md)',
        re: /\b(?:-?(?:w|h|min-w|max-w|min-h|max-h|size|p[trblxyse]?|m[trblxyse]?|gap(?:-[xy])?|space-[xy]|top|left|right|bottom|inset(?:-[xy])?|basis|translate-[xy]|rounded(?:-[a-z]+)?|leading|tracking))-\[-?\d+(?:\.\d+)?px\]/g,
    },
    'texto-chico': {
        regla: 'Texto mínimo 12px (text-xs)',
        re: /\btext-\[(?:(?:[0-9]|1[01])(?:\.\d+)?px|0?\.[0-6]\d*rem)\]/g,
    },
    'color-fijo': {
        regla: 'Colores por token (hsl(var(--…))): un hex fijo rompe dark mode y la marca de la escuela',
        re: /\b(?:bg|text|border(?:-[trblxy])?|from|via|to|ring|fill|stroke|outline|decoration|shadow|divide|placeholder|accent|caret)-\[#[0-9a-fA-F]{3,8}\]/g,
    },
    'transition-all': {
        regla: 'Nombrar las propiedades que se animan, nunca transition-all (Vercel Web Interface Guidelines; Emil Kowalski)',
        re: /\btransition-all\b|transition:\s*all\b/g,
    },
    'hover-oculto': {
        regla: 'Acción visible solo con hover: en el celular no existe. Usar md:opacity-0 md:group-hover:opacity-100',
        re: /(?<![\w:-])opacity-0\b(?=[^"'`]*(?<![\w-])group-hover:opacity-100)|(?<![\w:-])group-hover:opacity-100\b(?=[^"'`]*(?<![\w:-])opacity-0\b)/g,
    },
    'tres-puntos': {
        regla: 'Puntos suspensivos «…», no «...» (Cargando…, placeholders)',
        re: /(?:Cargando|Guardando|Enviando|Procesando|Buscando|Subiendo|Generando|Actualizando|Verificando|Conectando)\.\.\.|placeholder="[^"]*\.\.\."/g,
    },
    seguro: {
        regla: 'Deshacer en vez de «¿Seguro?» (useAccionConDeshacer, 8 s)',
        re: /¿\s*(?:Seguro|Segura|Est[áa]s?\s+segur[oa]|Realmente)\b|\bwindow\.confirm\s*\(/g,
    },
    voseo: {
        regla: 'Español de Colombia de «tú», sin voseo (V2Palabras)',
        // Límites con \p{L}: con \b, «venía» daba «vení» y «confirmándolo» «confirmá».
        re: /(?<!\p{L})(?:querés|tenés|podés|sabés|hacé|decí|mirá|escribí|probá|tocá|subí|completá|ingresá|revisá|agregá|seleccioná|confirmá|elegí|marcá|actualizá|cargá|guardá|usá|pagá|buscá|intentá|esperá|volvé|poné|llamá|activá|creá|enviá|contanos|escribinos|avisanos|fijate|acordate|vení|andá|ponete)(?!\p{L})/giu,
    },
};

function* archivos(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === '__fixtures__' || e.name === 'test') continue;
            yield* archivos(p);
        } else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.(test|spec)\.[tj]sx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
            if (p.includes(`${path.sep}integrations${path.sep}supabase${path.sep}types`)) continue;
            yield p;
        }
    }
}

// Quita comentarios por línea (// …, /* …, * …) y los // al final de una línea
// de código. Un parser de comillas se confunde con apóstrofes del texto JSX.
function sinComentarios(src) {
    return src
        .split('\n')
        .map((l, i, all) => {
            if (i > 0 && /v2-gate: ok/.test(all[i - 1])) return '';
            const t = l.trimStart();
            if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return '';
            // Escape justificado en la misma línea o la anterior: «v2-gate: ok» (p. ej. «lo que elegí» es pasado, no voseo).
            if (/v2-gate: ok/.test(l)) return '';
            return l.replace(/\s\/\/\s.*$/, '');
        })
        .join('\n');
}

export function escanear(soloV2 = false) {
    const porArchivo = {};
    const muestras = [];
    for (const f of archivos(SRC)) {
        const rel = path.relative(REPO, f).split(path.sep).join('/');
        if (soloV2 && !/\/v2\//.test(rel)) continue;
        const raw = fs.readFileSync(f, 'utf8');
        const src = sinComentarios(raw);
        const lineas = src.split('\n');
        for (const [id, { re }] of Object.entries(REGLAS)) {
            for (let ln = 0; ln < lineas.length; ln++) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(lineas[ln]))) {
                    porArchivo[rel] ??= {};
                    porArchivo[rel][id] = (porArchivo[rel][id] || 0) + 1;
                    if (muestras.length < 4000) muestras.push({ archivo: rel, linea: ln + 1, regla: id, texto: m[0] });
                }
            }
        }
    }
    return { porArchivo, muestras };
}

function totales(porArchivo, filtro = () => true) {
    const t = Object.fromEntries(Object.keys(REGLAS).map((k) => [k, 0]));
    for (const [f, rs] of Object.entries(porArchivo)) if (filtro(f)) for (const [k, n] of Object.entries(rs)) t[k] += n;
    return t;
}

const { porArchivo, muestras } = escanear(flag('solo-v2'));
const esV2 = (f) => /\/v2\//.test(f);

if (flag('actualizar')) {
    fs.writeFileSync(BASELINE, JSON.stringify({ generado: new Date().toISOString().slice(0, 10), porArchivo }, null, 2) + '\n');
    console.log(`Línea base actualizada: ${Object.keys(porArchivo).length} archivos con hallazgos.`);
    process.exit(0);
}

const tV2 = totales(porArchivo, esV2);
const tResto = totales(porArchivo, (f) => !esV2(f));
const lines = [];
lines.push('Regla         │ V2 (*/v2/) │ resto de la app');
lines.push('──────────────┼────────────┼────────────────');
for (const k of Object.keys(REGLAS)) lines.push(`${k.padEnd(14)} │ ${String(tV2[k]).padStart(10)} │ ${String(tResto[k]).padStart(15)}`);
console.log(lines.join('\n'));

// Trinquete
let base = { porArchivo: {} };
if (fs.existsSync(BASELINE)) base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const empeoro = [];
for (const [f, rs] of Object.entries(porArchivo)) {
    for (const [k, n] of Object.entries(rs)) {
        const antes = base.porArchivo[f]?.[k] || 0;
        if (n > antes) empeoro.push({ archivo: f, regla: k, antes, ahora: n });
    }
}
let mejoro = 0;
for (const [f, rs] of Object.entries(base.porArchivo)) for (const [k, n] of Object.entries(rs)) if ((porArchivo[f]?.[k] || 0) < n) mejoro++;

const md = opt('md');
if (md) {
    const out = [`# Compuerta V2 — ${new Date().toISOString().slice(0, 10)}`, '', '| Regla | Qué pide | V2 (`*/v2/`) | Resto |', '|---|---|---|---|'];
    for (const [k, { regla }] of Object.entries(REGLAS)) out.push(`| \`${k}\` | ${regla} | ${tV2[k]} | ${tResto[k]} |`);
    out.push('', '## Pantallas V2 con hallazgos', '');
    const v2s = muestras.filter((m) => esV2(m.archivo));
    if (!v2s.length) out.push('Ninguna.');
    for (const m of v2s) out.push(`- \`${m.archivo}:${m.linea}\` — **${m.regla}** \`${m.texto}\``);
    out.push('', '## Resto de la app: archivos con más hallazgos', '', '| Archivo | Total | Detalle |', '|---|---|---|');
    const top = Object.entries(porArchivo)
        .filter(([f]) => !esV2(f))
        .map(([f, rs]) => [f, Object.values(rs).reduce((a, b) => a + b, 0), rs])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25);
    for (const [f, n, rs] of top) out.push(`| \`${f}\` | ${n} | ${Object.entries(rs).map(([k, v]) => `${k} ${v}`).join(' · ')} |`);
    for (const r of ['seguro', 'voseo']) {
        const xs = muestras.filter((m) => m.regla === r);
        out.push('', `## Todos los \`${r}\` (${xs.length})`, '');
        for (const m of xs.slice(0, 80)) out.push(`- \`${m.archivo}:${m.linea}\` \`${m.texto}\``);
        if (xs.length > 80) out.push(`- … y ${xs.length - 80} más`);
    }
    fs.writeFileSync(md, out.join('\n') + '\n');
    console.log(`\nInforme: ${md}`);
}

console.log('');
if (mejoro) console.log(`↓ ${mejoro} archivo×regla mejoraron frente a la línea base: corré --actualizar para fijar la ganancia.`);
if (empeoro.length) {
    console.log(`✘ Empeoró la V2 en ${empeoro.length} archivo×regla:`);
    for (const e of empeoro.slice(0, 30)) console.log(`   ${e.archivo} · ${e.regla}: ${e.antes} → ${e.ahora}  (${REGLAS[e.regla].regla})`);
    process.exit(1);
}
console.log('✔ Nada empeoró frente a la línea base.');
