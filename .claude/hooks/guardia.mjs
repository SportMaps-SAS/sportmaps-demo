#!/usr/bin/env node
/**
 * Guardia de Claude Code para SportMaps.
 *
 * Convierte en reglas automáticas lo que CLAUDE.md pide y hoy depende de que el
 * agente se acuerde. Lo invoca .claude/settings.json:
 *
 *   node .claude/hooks/guardia.mjs pre-bash    (PreToolUse · Bash)
 *   node .claude/hooks/guardia.mjs pre-edit    (PreToolUse · Edit|Write|MultiEdit|NotebookEdit)
 *   node .claude/hooks/guardia.mjs post-edit   (PostToolUse · Edit|Write|MultiEdit)
 *
 * Contrato de hooks de Claude Code: recibe JSON por stdin; salir con código 2
 * BLOQUEA la herramienta (Pre) o le devuelve el aviso a Claude (Post), y el
 * texto de stderr es el motivo. Código 0 = seguir.
 *
 * Patrón tomado de anthropics/claude-code examples/hooks/bash_command_validator_example.py,
 * reescrito en Node porque el equipo también trabaja en Windows (scripts .ps1)
 * y Node ya es requisito del repo.
 *
 * Si algo falla DENTRO de la guardia (JSON roto, git ausente) deja pasar: una
 * guardia rota no puede trabar el trabajo. Las reglas duras siguen en el
 * pre-commit (migrations:check) y en CI.
 *
 * Probar: node --test .claude/hooks/guardia.test.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(process.env.CLAUDE_PROJECT_DIR || path.join(here, '..', '..'));
const RAMAS_PROTEGIDAS = ['main', 'stg'];

// ── Reglas de Bash ──────────────────────────────────────────────────────────
// Cada regla: [regex, motivo]. Se evalúan sobre el comando completo (incluye
// `cd x && …`, `npx …`, subshells), no solo sobre el primer token.
const SEP = String.raw`(?:^|[;&|(\s])`; // inicio de comando o separador
export const REGLAS_BASH = [
    [
        new RegExp(String.raw`${SEP}(?:npx\s+(?:--yes\s+|-y\s+)?)?vercel(?:\s+(?:deploy|link|--prod|promote|redeploy|rollback|alias|remove|rm)\b|\s*(?:$|[;&|)]))`),
        'Nunca `vercel deploy/link/--prod` a mano: los despliegues salen SOLO del push a git (docs/gotchas-tecnicos.md, «NUNCA correr vercel deploy o vercel link manual»).',
    ],
    [
        new RegExp(String.raw`${SEP}(?:npx\s+)?supabase\s+(?:db\s+(?:push|reset|execute)|migration\s+(?:up|repair|squash))\b`),
        'Aplicar migraciones / tocar el esquema remoto no se hace desde un agente: la base es UNA para dev, stg y prod, y solo una sesión a la vez aplica DDL (CLAUDE.md, «Disk IO»). Pídeselo al usuario y que quede rastro (CLI o apply_migration) en una sola sesión.',
    ],
    [
        new RegExp(String.raw`${SEP}git\s+push\b[^;&|]*?(?:\s|:|/)(?:${RAMAS_PROTEGIDAS.join('|')})(?=\s|$|[;&|)])`),
        `Push a ${RAMAS_PROTEGIDAS.join('/')} prohibido: se trabaja en develop y nunca se mergea a main por iniciativa propia (CLAUDE.md, «Ramas»).`,
    ],
    [
        new RegExp(String.raw`${SEP}git\s+push\b[^;&|]*\s(?:--force(?!-with-lease)|-f)(?=\s|$)`),
        '`git push --force` reescribe historia que otras sesiones pueden tener. Si de verdad hace falta, `--force-with-lease` y solo sobre una rama propia.',
    ],
    [
        new RegExp(String.raw`${SEP}git\s+(?:commit|push|merge|rebase)\b[^;&|]*\s--no-verify\b`),
        '`--no-verify` se salta el pre-commit (migrations:check, tsc, eslint). Si el gate falla, hay que arreglar lo que dice.',
    ],
    [
        // Escribir/borrar/mover dentro de supabase/migrations por shell: la
        // guardia de Edit no lo ve. Las lecturas (cat, grep, ls, head) pasan.
        new RegExp(String.raw`(?:${SEP}(?:(?:rm|mv|truncate|git\s+(?:rm|mv|restore))\b|git\s+checkout\s+--\s)[^;&|]*supabase[\\/]migrations[\\/]|${SEP}(?:sed|perl)\s+[^;&|]*-i[^;&|]*supabase[\\/]migrations[\\/]|>>?\s*\S*supabase[\\/]migrations[\\/]|${SEP}tee\b[^;&|]*supabase[\\/]migrations[\\/])`),
        'Las migraciones son inmutables: nada de rm/mv/sed -i/redirecciones sobre supabase/migrations/. Un fix va en una migración NUEVA: `npm run migrations:new -- <slug>` (docs/migrations-workflow.md).',
    ],
];

/**
 * Quita lo que es TEXTO y no comando: cuerpos de heredoc y el contenido entre
 * comillas. Sin esto, `git commit -m "no usar vercel deploy"` se bloqueaba por
 * el mensaje. Costo: `bash -c "vercel deploy"` ya no se detecta (ver límites en
 * docs/claude-code-setup.md); el pre-commit y CI siguen siendo el muro.
 */
export function soloComando(comando) {
    let c = String(comando || '');
    // heredocs: <<EOF … EOF, <<'EOF', <<"EOF", <<-EOF
    c = c.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '<<HEREDOC');
    // contenido entre comillas (respeta escapes en las dobles)
    c = c.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");
    return c;
}

export function revisarBash(comando) {
    const c = soloComando(comando);
    return REGLAS_BASH.filter(([re]) => re.test(c)).map(([, motivo]) => motivo);
}

// ── Migraciones commiteadas: inmutables ─────────────────────────────────────
export function esMigracion(rel) {
    return /^supabase\/migrations\/.+/.test(rel);
}

function relativo(p) {
    const abs = path.isAbsolute(p) ? p : path.join(REPO, p);
    return path.relative(REPO, abs).split(path.sep).join('/');
}

function estaCommiteado(rel) {
    try {
        execFileSync('git', ['-C', REPO, 'cat-file', '-e', `HEAD:${rel}`], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export function revisarEdicion(filePath, { commiteado = estaCommiteado } = {}) {
    if (!filePath) return [];
    const rel = relativo(filePath);
    if (esMigracion(rel) && commiteado(rel)) {
        return [
            `\`${rel}\` ya está commiteada: las migraciones son INMUTABLES aunque estén mal (CLAUDE.md). ` +
                'El arreglo va en una migración nueva: `npm run migrations:new -- <slug>`. ' +
                'Las migraciones nuevas, todavía sin commitear, sí se pueden editar.',
        ];
    }
    return [];
}

// ── Compuerta V2 después de editar el frontend ──────────────────────────────
function compuertaV2(filePath) {
    const rel = relativo(filePath || '');
    if (!/^frontend\/src\/.+\.(tsx?|jsx?)$/.test(rel)) return null;
    const gate = path.join(REPO, 'scripts', 'v2-gate', 'run.mjs');
    if (!fs.existsSync(gate)) return null;
    try {
        execFileSync(process.execPath, [gate], { cwd: REPO, stdio: 'pipe', timeout: 20_000 });
        return null;
    } catch (e) {
        if (e.status !== 1) return null; // timeout u otro error: no molestar
        const out = String(e.stdout || '');
        const desde = out.indexOf('✘');
        return `La compuerta V2 empeoró tras editar ${rel} (DESIGN.md §12):\n${desde >= 0 ? out.slice(desde) : out}`;
    }
}

// ── Entrada ─────────────────────────────────────────────────────────────────
function leerStdin() {
    try {
        return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {
        return null;
    }
}

function main() {
    const modo = process.argv[2];
    const input = leerStdin();
    if (!input) process.exit(0);
    const ti = input.tool_input || {};
    let motivos = [];
    if (modo === 'pre-bash') motivos = revisarBash(ti.command);
    else if (modo === 'pre-edit') motivos = revisarEdicion(ti.file_path || ti.notebook_path);
    else if (modo === 'post-edit') {
        const aviso = compuertaV2(ti.file_path);
        if (aviso) motivos = [aviso];
    }
    if (motivos.length) {
        process.stderr.write(`🛡️ Guardia SportMaps:\n${motivos.map((m) => `• ${m}`).join('\n')}\n`);
        process.exit(2);
    }
    process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
