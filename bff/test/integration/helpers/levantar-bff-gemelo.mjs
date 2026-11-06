// Levanta el BFF contra el GEMELO LOCAL con un entorno EXPLICITO y minimo
// (no hereda process.env, no lee bff/.env: cwd = carpeta temporal sin .env).
//
//   node bff/test/integration/helpers/levantar-bff-gemelo.mjs [--gating=audit|soft|enforce] [--port=3101]
//
// Imprime el SUPABASE_URL efectivo y queda en primer plano (Ctrl+C / kill para apagar).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const bffDir = resolve(aqui, '..', '..', '..');
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];

// Llaves de demo de la CLI de Supabase local (no secretas; las imprime qa:twin:status).
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const workdir = mkdtempSync(join(tmpdir(), 'bff-gemelo-'));
const mockFile = process.env.WOMPI_MOCK_FILE || join(tmpdir(), 'wompi-mock-t1.json');
writeFileSync(mockFile, '{}');

const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME,
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: ANON,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    PORT: arg('port', '3101'),
    NODE_ENV: 'development',
    GATING_MODE: arg('gating', 'enforce'),
    PUBLIC_BOOKING_DEBUG_OTP: 'true',
    RESERVATIONS_TOKEN_SECRET: 'secreto-local-t1-no-es-de-nadie',
    PAYMENT_TOKENS_ENC_KEY: 'clave-local-t1-para-cifrar-llaves-falsas',
    FAMILIAS_APP_URL: 'http://localhost:5173',
    FAMILIAS_BFF_URL: `http://127.0.0.1:${arg('port', '3101')}`,
    TS_NODE_PROJECT: join(bffDir, 'tsconfig.json'),
    TS_NODE_TRANSPILE_ONLY: 'true',
    WOMPI_MOCK_FILE: mockFile,
    // Llave global FALSA (los eventos de referencias desconocidas se validan con la de ENV):
    WOMPI_EVENTS_SECRET: 'events-global-falso-t1',
};
// Guarda dura: ninguna variable puede apuntar a produccion.
for (const [k, v] of Object.entries(env)) {
    if (v && /luebjarufsiadojhvxgi|supabase\.co/i.test(String(v))) { console.error(`ABORTADO: ${k} apunta a produccion`); process.exit(2); }
}
console.log(`[levantar-bff-gemelo] cwd=${workdir} (sin .env) gating=${env.GATING_MODE} puerto=${env.PORT} SUPABASE_URL=${env.SUPABASE_URL}`);

const child = spawn(process.execPath, [
    '-r', join(aqui, 'solo-localhost.cjs'),
    '-r', join(bffDir, 'node_modules', 'ts-node', 'register', 'transpile-only.js'),
    join(bffDir, 'src', 'index.ts'),
], { cwd: workdir, env, stdio: 'inherit' });
child.on('exit', (c) => process.exit(c ?? 0));
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
