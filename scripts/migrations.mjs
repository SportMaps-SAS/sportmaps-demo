#!/usr/bin/env node
/**
 * migrations — inventario, versionado y control de cambios de las migraciones.
 *
 * Problema que resuelve: varias personas/sesiones creando migraciones en paralelo
 * terminan con el MISMO prefijo (YYYYMMDDHHMMSS), con migraciones editadas después
 * de aplicadas, o con dos ramas tocando la misma versión sin enterarse.
 *
 * La fuente de verdad es `supabase/migrations_ledger.json`: un registro versionado
 * y COMMITEADO con una línea por migración (versión, archivo, sha256, fecha, autor).
 * Como toda migración nueva agrega una línea al final del ledger, dos ramas que
 * creen migraciones a la vez chocan en git → hay que ponerse de acuerdo en la
 * versión ANTES de mergear, en vez de descubrir el duplicado en producción.
 *
 * Comandos:
 *   node scripts/migrations.mjs list [--last N] [--grep TXT] [--dups] [--json]
 *   node scripts/migrations.mjs check          # gate de pre-commit y CI
 *   node scripts/migrations.mjs sync           # registra las migraciones nuevas
 *   node scripts/migrations.mjs next           # imprime la próxima versión libre
 *   node scripts/migrations.mjs new <slug>     # crea el .sql y lo registra
 *
 * Reglas que hace cumplir (ver CLAUDE.md):
 *   1. Migraciones inmutables: si cambia el contenido de una ya registrada → error.
 *   2. No se borran migraciones: si falta una registrada → error.
 *   3. Una versión = un archivo: dos migraciones nuevas con el mismo prefijo → error.
 *   4. Orden monótono: una migración nueva siempre va después del head del ledger.
 *   5. Toda migración nueva queda registrada en el ledger antes de commitear.
 *
 * Las colisiones y los nombres legacy que YA existían cuando se creó el ledger
 * quedan en la línea base (marcados `dup`/`legacy`): son inmutables y aplicadas a
 * mano, no se renombran. Solo se bloquea lo nuevo.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const LEDGER_PATH = join(ROOT, 'supabase', 'migrations_ledger.json');
const NAME_RE = /^(\d{14})_([a-z0-9_]+)\.sql$/;

const C = process.stdout.isTTY
    ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', off: '\x1b[0m' }
    : { dim: '', red: '', green: '', yellow: '', cyan: '', bold: '', off: '' };

// ---------------------------------------------------------------------------
// Lectura del disco y del ledger
// ---------------------------------------------------------------------------

/** sha256 del contenido normalizado a LF (para que Windows y Linux coincidan). */
function sha256(path) {
    const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Archivos .sql en supabase/migrations (ignora subdirectorios como _smoke/). */
function readDisk() {
    const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .filter((f) => statSync(join(MIGRATIONS_DIR, f)).isFile())
        .sort();

    return files.map((file) => {
        const m = file.match(NAME_RE);
        const legacyVersion = file.match(/^(\d{8,})_/);
        return {
            file,
            version: m ? m[1] : legacyVersion ? legacyVersion[1] : null,
            slug: m ? m[2] : file.replace(/^\d+_/, '').replace(/\.sql$/, ''),
            standardName: Boolean(m),
            sha256: sha256(join(MIGRATIONS_DIR, file)),
        };
    });
}

function readLedger() {
    if (!existsSync(LEDGER_PATH)) return null;
    try {
        return JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
    } catch (err) {
        fail(`El ledger está corrupto (${LEDGER_PATH}): ${err.message}`);
    }
}

/**
 * Serializa el ledger con UNA migración por línea. Es a propósito: así una
 * migración nueva = una línea agregada al final, y dos ramas que agreguen
 * migraciones a la vez producen un conflicto de git limpio y evidente.
 */
function writeLedger(ledger) {
    const lines = ledger.migrations.map((m) => '    ' + JSON.stringify(m));
    const body = [
        '{',
        `  "schema": ${ledger.schema},`,
        `  "note": ${JSON.stringify(ledger.note)},`,
        `  "count": ${ledger.migrations.length},`,
        `  "head": ${JSON.stringify(ledger.head)},`,
        '  "migrations": [',
        lines.join(',\n'),
        '  ]',
        '}',
        '',
    ].join('\n');
    writeFileSync(LEDGER_PATH, body, 'utf8');
}

/** Fecha y autor del commit que AGREGÓ cada migración (una sola pasada de git). */
function gitAddMetadata() {
    const meta = new Map();
    let out;
    try {
        out = execFileSync(
            'git',
            ['log', '--diff-filter=A', '--name-only', '--format=@|%an|%aI', '--', 'supabase/migrations'],
            { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        );
    } catch {
        return meta; // sin git (tarball, CI raro) → seguimos sin autor
    }
    let by = null;
    let at = null;
    for (const line of out.split('\n')) {
        if (line.startsWith('@|')) {
            const [, author, iso] = line.split('|');
            by = author;
            at = iso?.slice(0, 10);
            continue;
        }
        const f = line.trim();
        if (!f.startsWith('supabase/migrations/')) continue;
        const name = f.slice('supabase/migrations/'.length);
        if (name.includes('/')) continue;
        // git log va de lo más nuevo a lo más viejo → el último que veamos es el alta real
        meta.set(name, { by: by || 'desconocido', added: at || '' });
    }
    return meta;
}

/**
 * Migraciones que YA están commiteadas en HEAD. Solo esas son inmutables: una
 * migración todavía sin commitear se sigue escribiendo, y su sha cambia sin que
 * eso sea una violación (el ledger simplemente se re-sincroniza).
 */
function gitTrackedFiles() {
    try {
        const out = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'supabase/migrations'], {
            cwd: ROOT,
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
        });
        return new Set(
            out
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.startsWith('supabase/migrations/'))
                .map((l) => l.slice('supabase/migrations/'.length))
                .filter((n) => !n.includes('/')),
        );
    } catch {
        return null; // sin git → no podemos distinguir; tratamos todo como commiteado
    }
}

function gitUser() {
    try {
        return execFileSync('git', ['config', 'user.name'], { cwd: ROOT, encoding: 'utf8' }).trim() || 'desconocido';
    } catch {
        return 'desconocido';
    }
}

function fail(msg) {
    console.error(`\n${C.red}❌ ${msg}${C.off}\n`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Diff disco ↔ ledger — el corazón de todos los comandos
// ---------------------------------------------------------------------------

function diff() {
    const disk = readDisk();
    const ledger = readLedger();
    if (!ledger) {
        fail(
            `No existe ${LEDGER_PATH}.\n   Genera la línea base con: ${C.cyan}npm run migrations:sync${C.off}`,
        );
    }

    const byFile = new Map(ledger.migrations.map((m) => [m.file, m]));
    const diskByFile = new Map(disk.map((d) => [d.file, d]));
    const tracked = gitTrackedFiles();
    const estaCommiteada = (file) => (tracked ? tracked.has(file) : true);

    const registered = [];
    const nuevas = [];
    const editadas = []; // commiteadas y cambiadas → violación de inmutabilidad
    const desfasadas = []; // aún sin commitear y cambiadas → solo hay que re-sincronizar
    for (const d of disk) {
        const l = byFile.get(d.file);
        if (!l) {
            nuevas.push(d);
            continue;
        }
        if (l.sha256 !== d.sha256) {
            (estaCommiteada(d.file) ? editadas : desfasadas).push({ ...d, ledgerSha: l.sha256 });
        }
        registered.push({ ...l, ...d, entry: l });
    }

    const faltantes = ledger.migrations.filter((m) => !diskByFile.has(m.file));
    // Borrar una migración commiteada es violación; descartar una WIP local no lo es.
    const borradas = faltantes.filter((m) => estaCommiteada(m.file));
    const abandonadas = faltantes.filter((m) => !estaCommiteada(m.file));

    // Colisiones: agrupamos por versión sobre todo (ledger + nuevas)
    const byVersion = new Map();
    for (const d of disk) {
        if (!d.version) continue;
        if (!byVersion.has(d.version)) byVersion.set(d.version, []);
        byVersion.get(d.version).push(d);
    }
    const dupsBaseline = [];
    const dupsNuevas = [];
    for (const [v, list] of byVersion) {
        if (list.length < 2) continue;
        const tieneNueva = list.some((d) => !byFile.has(d.file));
        (tieneNueva ? dupsNuevas : dupsBaseline).push([v, list]);
    }

    return {
        disk,
        ledger,
        registered,
        nuevas,
        editadas,
        desfasadas,
        borradas,
        abandonadas,
        dupsBaseline,
        dupsNuevas,
        byFile,
        estaCommiteada,
    };
}

// ---------------------------------------------------------------------------
// list — ver TODAS las migraciones
// ---------------------------------------------------------------------------

function cmdList(argv) {
    const asJson = argv.includes('--json');
    const soloDups = argv.includes('--dups');
    const lastIdx = argv.indexOf('--last');
    const last = lastIdx >= 0 ? Number(argv[lastIdx + 1]) : null;
    const grepIdx = argv.indexOf('--grep');
    const grep = grepIdx >= 0 ? argv[grepIdx + 1]?.toLowerCase() : null;

    const { disk, ledger, nuevas, editadas, desfasadas, borradas, abandonadas, dupsBaseline, dupsNuevas, byFile, estaCommiteada } =
        diff();
    const nuevasSet = new Set(nuevas.map((n) => n.file));
    const editadasSet = new Set(editadas.map((n) => n.file));
    const desfasadasSet = new Set(desfasadas.map((n) => n.file));
    const dupFiles = new Set([...dupsBaseline, ...dupsNuevas].flatMap(([, l]) => l.map((d) => d.file)));

    let rows = disk.map((d, i) => {
        const l = byFile.get(d.file);
        const estado = editadasSet.has(d.file)
            ? 'EDITADA'
            : nuevasSet.has(d.file)
              ? 'sin registrar'
              : desfasadasSet.has(d.file)
                ? 'sin sync'
                : 'registrada';
        return {
            n: i + 1,
            version: d.version ?? '—',
            fecha: l?.added || '',
            autor: l?.by || '',
            slug: d.slug,
            file: d.file,
            estado,
            dup: dupFiles.has(d.file),
            legacy: !d.standardName,
            wip: !estaCommiteada(d.file),
        };
    });

    if (grep) rows = rows.filter((r) => (r.slug + ' ' + r.version).toLowerCase().includes(grep));
    if (soloDups) rows = rows.filter((r) => r.dup);
    if (last) rows = rows.slice(-last);

    if (asJson) {
        console.log(JSON.stringify({ head: ledger.head, count: disk.length, migrations: rows }, null, 2));
        return;
    }

    const wSlug = Math.max(...rows.map((r) => r.slug.length), 10);
    console.log(
        `\n${C.bold}Migraciones de SportMaps${C.off} ${C.dim}— ${disk.length} archivos · head ${ledger.head} · ledger supabase/migrations_ledger.json${C.off}\n`,
    );
    console.log(
        `${C.dim}${'#'.padStart(4)}  ${'VERSIÓN'.padEnd(14)}  ${'ALTA'.padEnd(10)}  ${'AUTOR'.padEnd(10)}  ${'MIGRACIÓN'.padEnd(wSlug)}  ESTADO${C.off}`,
    );
    for (const r of rows) {
        const marca = r.estado === 'EDITADA' ? C.red : r.estado === 'registrada' ? C.dim : C.yellow;
        const flags = [
            r.dup ? `${C.yellow}dup${C.off}` : '',
            r.legacy ? `${C.dim}legacy${C.off}` : '',
            r.wip ? `${C.cyan}sin commitear${C.off}` : '',
        ]
            .filter(Boolean)
            .join(' ');
        console.log(
            `${String(r.n).padStart(4)}  ${r.version.padEnd(14)}  ${(r.fecha || '—').padEnd(10)}  ${(r.autor || '—').padEnd(10)}  ${r.slug.padEnd(wSlug)}  ${marca}${r.estado.padEnd(13)}${C.off} ${flags}`,
        );
    }

    console.log('');
    if (dupsBaseline.length) {
        console.log(
            `${C.yellow}⚠️  ${dupsBaseline.length} colisiones de versión en la línea base${C.off} ${C.dim}(inmutables, aplicadas a mano — no se renombran)${C.off}`,
        );
        for (const [v, list] of dupsBaseline) console.log(`   ${v}: ${list.map((d) => d.slug).join(', ')}`);
    }
    if (dupsNuevas.length) {
        console.log(`${C.red}❌ ${dupsNuevas.length} colisiones NUEVAS — hay que renombrar${C.off}`);
        for (const [v, list] of dupsNuevas) console.log(`   ${v}: ${list.map((d) => d.file).join(', ')}`);
    }
    if (nuevas.length) console.log(`${C.yellow}• ${nuevas.length} migración(es) sin registrar → npm run migrations:sync${C.off}`);
    if (desfasadas.length || abandonadas.length)
        console.log(`${C.yellow}• ${desfasadas.length + abandonadas.length} cambio(s) local(es) sin sincronizar → npm run migrations:sync${C.off}`);
    if (editadas.length) console.log(`${C.red}• ${editadas.length} migración(es) commiteadas y luego EDITADAS (inmutabilidad rota)${C.off}`);
    if (borradas.length) console.log(`${C.red}• ${borradas.length} migración(es) commiteadas que ya no están en disco${C.off}`);
    if (!nuevas.length && !editadas.length && !borradas.length && !dupsNuevas.length && !desfasadas.length && !abandonadas.length) {
        console.log(`${C.green}✅ Ledger al día: disco y registro coinciden.${C.off}`);
    }
    console.log('');
}

// ---------------------------------------------------------------------------
// check — gate de pre-commit y CI
// ---------------------------------------------------------------------------

function cmdCheck() {
    const { disk, ledger, nuevas, editadas, desfasadas, borradas, abandonadas, dupsNuevas, dupsBaseline } = diff();
    const errores = [];

    if (desfasadas.length || abandonadas.length) {
        errores.push(
            `El ledger quedó desfasado respecto a migraciones aún sin commitear:\n` +
                [...desfasadas.map((d) => `        - ${d.file} (cambió después de registrarse)`),
                 ...abandonadas.map((a) => `        - ${a.file} (registrada pero ya no está en disco)`)].join('\n') +
                `\n      → corre ${C.cyan}npm run migrations:sync${C.off} para ponerlo al día.`,
        );
    }

    for (const e of editadas) {
        errores.push(
            `Migración EDITADA (las migraciones son inmutables): ${e.file}\n` +
                `      sha registrado ${e.ledgerSha.slice(0, 12)} ≠ sha actual ${e.sha256.slice(0, 12)}\n` +
                `      → revierte el archivo y mete el cambio en una migración NUEVA con timestamp posterior.`,
        );
    }
    for (const b of borradas) {
        errores.push(
            `Migración BORRADA o renombrada: ${b.file} (versión ${b.v})\n` +
                `      → restáurala. Un fix va siempre en una migración nueva, nunca borrando la vieja.`,
        );
    }
    for (const [v, list] of dupsNuevas) {
        errores.push(
            `Colisión de versión ${v}: ${list.map((d) => d.file).join(', ')}\n` +
                `      → renombra TU migración a una versión única: npm run migrations:next`,
        );
    }
    for (const n of nuevas) {
        if (!n.standardName) {
            errores.push(
                `Nombre no estándar: ${n.file}\n` +
                    `      → usa YYYYMMDDHHMMSS_slug_en_snake_case.sql`,
            );
            continue;
        }
        if (n.version <= ledger.head) {
            errores.push(
                `Versión fuera de orden: ${n.file} (${n.version}) no es posterior al head del ledger (${ledger.head}).\n` +
                    `      Alguien registró una migración más nueva mientras trabajabas: reordena la tuya con npm run migrations:next.`,
            );
        }
    }
    const sinRegistrar = nuevas.filter((n) => n.standardName && n.version > ledger.head && !dupsNuevas.some(([, l]) => l.some((d) => d.file === n.file)));
    if (sinRegistrar.length) {
        errores.push(
            `${sinRegistrar.length} migración(es) sin registrar en el ledger:\n` +
                sinRegistrar.map((n) => `        - ${n.file}`).join('\n') +
                `\n      → corre ${C.cyan}npm run migrations:sync${C.off} y commitea supabase/migrations_ledger.json junto al .sql`,
        );
    }
    if (ledger.head !== maxVersion(ledger.migrations)) {
        errores.push(`El head del ledger (${ledger.head}) no coincide con la versión máxima registrada (${maxVersion(ledger.migrations)}). → npm run migrations:sync`);
    }

    if (dupsBaseline.length) {
        console.warn(
            `${C.yellow}⚠️  ${dupsBaseline.length} colisiones de versión históricas (línea base, aceptadas).${C.off}`,
        );
    }

    if (errores.length) {
        console.error(`\n${C.red}❌ Control de migraciones — ${errores.length} problema(s):${C.off}\n`);
        errores.forEach((e, i) => console.error(`   ${i + 1}. ${e}\n`));
        console.error(`   ${C.dim}Ver el inventario completo: npm run migrations:list${C.off}\n`);
        process.exit(1);
    }

    console.log(
        `${C.green}✅ Migraciones: ${disk.length} archivos, ${ledger.migrations.length} registrados, head ${ledger.head}. Sin colisiones, ediciones ni borrados.${C.off}`,
    );
}

function maxVersion(entries) {
    return entries.reduce((max, m) => (m.v > max ? m.v : max), '');
}

// ---------------------------------------------------------------------------
// sync — registrar migraciones nuevas en el ledger
// ---------------------------------------------------------------------------

function cmdSync({ silent = false } = {}) {
    const disk = readDisk();
    let ledger = readLedger();
    const meta = gitAddMetadata();
    const hoy = new Date().toISOString().slice(0, 10);
    const yo = gitUser();

    if (!ledger) {
        // Línea base: todo lo que ya está en el repo entra tal cual, incluidas las
        // colisiones históricas y el nombre legacy. Solo se controla lo que venga después.
        const seen = new Map();
        const migrations = disk.map((d) => {
            const entry = {
                v: d.version ?? '00000000000000',
                file: d.file,
                sha256: d.sha256,
                added: meta.get(d.file)?.added || '',
                by: meta.get(d.file)?.by || '',
            };
            if (!d.standardName) entry.legacy = true;
            const previa = seen.get(entry.v);
            if (previa) {
                entry.dup = true;
                previa.dup = true;
            } else {
                seen.set(entry.v, entry);
            }
            return entry;
        });
        migrations.sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : a.file < b.file ? -1 : 1));
        ledger = {
            schema: 1,
            note: 'Registro versionado de migraciones. Lo genera scripts/migrations.mjs — no editar a mano. Toda migración nueva agrega una línea al final; si dos ramas chocan aquí, pónganse de acuerdo en la versión ANTES de mergear.',
            head: maxVersion(migrations),
            migrations,
        };
        writeLedger(ledger);
        const dups = migrations.filter((m) => m.dup).length;
        console.log(
            `${C.green}✅ Línea base creada:${C.off} ${migrations.length} migraciones registradas en supabase/migrations_ledger.json (head ${ledger.head}${dups ? `, ${dups} archivos en colisión histórica` : ''}).`,
        );
        return;
    }

    const byFile = new Map(ledger.migrations.map((m) => [m.file, m]));
    const nuevas = disk.filter((d) => !byFile.has(d.file));
    const tracked = gitTrackedFiles();
    const estaCommiteada = (file) => (tracked ? tracked.has(file) : true);

    // Validamos ANTES de registrar: el ledger nunca debe absorber algo inválido.
    const errores = [];
    const versionesUsadas = new Set(ledger.migrations.map((m) => m.v));
    for (const n of nuevas) {
        if (!n.standardName) {
            errores.push(`${n.file}: nombre no estándar (usa YYYYMMDDHHMMSS_slug.sql).`);
        } else if (versionesUsadas.has(n.version)) {
            errores.push(`${n.file}: la versión ${n.version} ya está tomada. Renómbrala (npm run migrations:next).`);
        } else if (n.version <= ledger.head) {
            errores.push(
                `${n.file}: la versión ${n.version} no es posterior al head (${ledger.head}). Renómbrala (npm run migrations:next).`,
            );
        } else {
            versionesUsadas.add(n.version);
        }
    }
    // Editar o borrar una migración YA COMMITEADA es violación: no se sincroniza.
    // Una migración local todavía sin commitear sí se re-sincroniza (se sigue escribiendo).
    const reSync = [];
    const descartadas = [];
    for (const [file, entry] of byFile) {
        const d = disk.find((x) => x.file === file);
        if (!d) {
            if (estaCommiteada(file)) {
                errores.push(`${file}: registrada en el ledger pero no está en disco. Restáurala (las migraciones no se borran).`);
            } else {
                descartadas.push(file);
            }
        } else if (d.sha256 !== entry.sha256) {
            if (estaCommiteada(file)) {
                errores.push(`${file}: fue editada después de registrarse. Revierte y crea una migración nueva.`);
            } else {
                entry.sha256 = d.sha256;
                reSync.push(file);
            }
        }
    }
    if (descartadas.length) {
        ledger.migrations = ledger.migrations.filter((m) => !descartadas.includes(m.file));
    }
    if (errores.length) {
        console.error(`\n${C.red}❌ No puedo registrar — arregla esto primero:${C.off}\n`);
        errores.forEach((e, i) => console.error(`   ${i + 1}. ${e}`));
        console.error('');
        process.exit(1);
    }

    if (reSync.length || descartadas.length) {
        ledger.head = maxVersion(ledger.migrations);
        writeLedger(ledger);
        for (const f of reSync) console.log(`${C.dim}↻ sha actualizado (aún sin commitear): ${f}${C.off}`);
        for (const f of descartadas) console.log(`${C.dim}– descartada del ledger (nunca se commiteó): ${f}${C.off}`);
    }

    if (!nuevas.length) {
        if (!silent && !reSync.length && !descartadas.length) {
            console.log(`${C.green}✅ Ledger al día:${C.off} ${ledger.migrations.length} migraciones, head ${ledger.head}. Nada que registrar.`);
        }
        return;
    }

    for (const n of nuevas.sort((a, b) => (a.version < b.version ? -1 : 1))) {
        ledger.migrations.push({
            v: n.version,
            file: n.file,
            sha256: n.sha256,
            added: meta.get(n.file)?.added || hoy,
            by: meta.get(n.file)?.by || yo,
        });
    }
    ledger.head = maxVersion(ledger.migrations);
    writeLedger(ledger);
    console.log(`${C.green}✅ Registradas ${nuevas.length} migración(es):${C.off}`);
    for (const n of nuevas) console.log(`   ${n.version}  ${n.slug}`);
    console.log(`   ${C.dim}head → ${ledger.head} · commitea supabase/migrations_ledger.json junto a los .sql${C.off}`);
}

// ---------------------------------------------------------------------------
// next / new — reservar una versión
// ---------------------------------------------------------------------------

function nextVersion(ledger) {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    let v = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    // Si el head es "del futuro" (o alguien usó contadores tipo ...000005), empujamos
    // un segundo por encima para no romper el orden.
    if (v <= ledger.head) v = String(BigInt(ledger.head) + 1n);
    return v;
}

function cmdNext() {
    const ledger = readLedger() ?? fail('No hay ledger. Corre: npm run migrations:sync');
    const v = nextVersion(ledger);
    console.log(v);
    console.error(
        `${C.dim}head actual ${ledger.head} → tu versión ${v}. Crea el archivo con: npm run migrations:new -- mi_cambio${C.off}`,
    );
}

function cmdNew(argv) {
    const slug = argv.find((a) => !a.startsWith('-'));
    if (!slug) fail('Falta el nombre. Uso: npm run migrations:new -- agregar_indice_pagos');
    if (!/^[a-z0-9_]+$/.test(slug)) fail(`Nombre inválido "${slug}": usa snake_case en minúsculas (a-z, 0-9, _).`);

    const ledger = readLedger() ?? fail('No hay ledger. Corre: npm run migrations:sync');
    const v = nextVersion(ledger);
    const file = `${v}_${slug}.sql`;
    const path = join(MIGRATIONS_DIR, file);
    if (existsSync(path)) fail(`Ya existe ${file}.`);

    const hoy = new Date().toISOString().slice(0, 10);
    const plantilla = `-- =============================================================================
-- ${file}
-- Autor: ${gitUser()}   Fecha: ${hoy}   Versión anterior: ${ledger.head}
-- Objetivo: TODO — qué problema resuelve esta migración.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role):
--     REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION … TO authenticated;   -- o la pantalla da 42501/403
--     anon solo con flujo público demostrado. SECURITY DEFINER no exime al caller.
--   · Helper usado en una POLICY (USING / WITH CHECK): SÍ GRANT EXECUTE a
--     authenticated (y a anon si la policy alcanza a anon en una tabla que lee);
--     la policy corre con el rol de quien consulta: sin GRANT, 42501 en toda la tabla.
--   · Helper que solo llama otra función SECURITY DEFINER: REVOKE ALL … FROM
--     PUBLIC, anon, authenticated y sin GRANT.
--   · RPC que recibe id de escuela/usuario: validar alcance del caller sobre ESE id.
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

-- TODO

COMMIT;
`;
    writeFileSync(path, plantilla, 'utf8');
    cmdSync({ silent: true });
    console.log(`${C.green}✅ Creada${C.off} supabase/migrations/${file}`);
    console.log(`   ${C.dim}Versión ${v} reservada en el ledger. Commitea el .sql y migrations_ledger.json juntos.${C.off}`);
}

// ---------------------------------------------------------------------------

const [, , cmd = 'list', ...argv] = process.argv;
switch (cmd) {
    case 'list':
    case 'ls':
        cmdList(argv);
        break;
    case 'check':
        cmdCheck();
        break;
    case 'sync':
        cmdSync();
        break;
    case 'next':
        cmdNext();
        break;
    case 'new':
        cmdNew(argv);
        break;
    default:
        console.error(`Comando desconocido "${cmd}". Usa: list | check | sync | next | new <slug>`);
        process.exit(1);
}
