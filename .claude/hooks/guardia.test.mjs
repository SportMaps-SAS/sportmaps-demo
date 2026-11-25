// node --test .claude/hooks/guardia.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { revisarBash, revisarEdicion } from './guardia.mjs';

const bloquea = (c) => assert.ok(revisarBash(c).length > 0, `debería bloquear: ${c}`);
const deja = (c) => assert.deepEqual(revisarBash(c), [], `debería dejar pasar: ${c}`);

test('vercel: deploy y link manuales, también con npx y tras cd', () => {
    bloquea('vercel deploy');
    bloquea('vercel --prod');
    bloquea('npx vercel link');
    bloquea('cd frontend && vercel');
    bloquea('npx -y vercel deploy --prebuilt');
    deja('vercel --version');
    deja('vercel logs https://x.vercel.app');
    deja('cat vercel.json');
});

test('supabase: push/reset/repair bloqueados; lectura y gen types no', () => {
    bloquea('supabase db push');
    bloquea('npx supabase db reset --linked');
    bloquea('supabase migration repair --status applied 2026');
    deja('supabase migration list');
    deja('supabase --version');
});

test('git: push a main/stg, --force y --no-verify', () => {
    bloquea('git push origin main');
    bloquea('git push origin HEAD:main');
    bloquea('git push -u origin stg');
    bloquea('git push --force origin develop');
    bloquea('git push -f');
    bloquea('git commit -m "x" --no-verify');
    deja('git push -u origin claude/beautiful-albattani-khfshn');
    deja('git push origin develop');
    deja('git push --force-with-lease origin claude/mi-rama');
    deja('git push origin feature/main-menu');
    deja('git log main..develop');
});

test('migraciones por shell: escribir no, leer sí', () => {
    bloquea('rm supabase/migrations/20260101000000_x.sql');
    bloquea("sed -i 's/a/b/' supabase/migrations/20260101000000_x.sql");
    bloquea('echo "--" >> supabase/migrations/20260101000000_x.sql');
    bloquea('git checkout -- supabase/migrations/20260101000000_x.sql');
    deja('cat supabase/migrations/20260101000000_x.sql');
    deja('grep -rn GRANT supabase/migrations/ | head');
    deja('ls supabase/migrations | tail');
    deja('npm run migrations:new -- descuentos');
});

test('Edit/Write: migración commiteada no, nueva sí, resto sí', () => {
    const si = { commiteado: () => true };
    const no = { commiteado: () => false };
    assert.equal(revisarEdicion('supabase/migrations/20260101000000_x.sql', si).length, 1);
    assert.equal(revisarEdicion('supabase/migrations/20261125000000_nueva.sql', no).length, 0);
    assert.equal(revisarEdicion('frontend/src/App.tsx', si).length, 0);
    assert.equal(revisarEdicion('supabase/migrations_ledger.json', si).length, 0);
});

test('extremo a extremo: el proceso sale con 2 y explica el motivo', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const r = spawnSync(process.execPath, [path.join(here, 'guardia.mjs'), 'pre-bash'], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'vercel deploy --prod' } }),
        encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /vercel/);
    const ok = spawnSync(process.execPath, [path.join(here, 'guardia.mjs'), 'pre-bash'], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }),
        encoding: 'utf8',
    });
    assert.equal(ok.status, 0);
    // JSON roto: deja pasar (una guardia rota no traba el trabajo)
    const roto = spawnSync(process.execPath, [path.join(here, 'guardia.mjs'), 'pre-bash'], { input: '{no', encoding: 'utf8' });
    assert.equal(roto.status, 0);
    // migración realmente commiteada en este repo
    const repo = path.resolve(here, '..', '..');
    const una = execFileSync('git', ['-C', repo, 'ls-files', 'supabase/migrations'], { encoding: 'utf8' }).split('\n')[0];
    if (una) {
        const e = spawnSync(process.execPath, [path.join(here, 'guardia.mjs'), 'pre-edit'], {
            input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(repo, una) } }),
            encoding: 'utf8',
        });
        assert.equal(e.status, 2);
    }
});

test('el texto entre comillas o en heredoc no cuenta como comando', () => {
    deja('git commit -m "guardia: bloquea vercel deploy, supabase db push y --no-verify"');
    deja("git commit -m 'no hacer git push origin main'");
    deja('git commit -q -F - <<\'MSG\'\nbloquea vercel deploy\ny git push --force\nMSG\n');
    deja('echo "rm supabase/migrations/x.sql" > /tmp/nota.txt');
    // pero el comando real después del mensaje sí cuenta
    bloquea('git commit -m "fix" && git push origin main');
    bloquea('git commit -m "x" --no-verify');
    bloquea("sed -i 's/a/b/' supabase/migrations/20260101000000_x.sql");
});
