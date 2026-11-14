// Debe ser el PRIMER import de index.ts — Sentry necesita instrumentar los
// módulos (express, http, etc.) antes de que index.ts los importe.
import dotenv from 'dotenv';
dotenv.config();

import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
        // Solo error monitoring (decisión: plan gratis, alcance mínimo) — sin
        // tracing/profiling. No mandar PII del usuario ni bodies de HTTP.
        // v11 cambió los defaults de lo que NO se declara aquí (cookies, cuerpos
        // de IA, datos de consultas a BD, variables locales → todo encendido).
        // Se apaga explícito para mantener el alcance de v10.
        dataCollection: {
            userInfo: false,
            httpBodies: [],
            cookies: false,
            httpHeaders: {
                request: { deny: ['authorization', 'cookie', 'apikey', 'x-api-key', 'x-forwarded-for', 'cf-connecting-ip', 'true-client-ip', 'x-real-ip'] },
                response: false,
            },
            genAI: { inputs: false, outputs: false },
            mcp: { inputs: false, outputs: false },
            graphQL: { document: false, variables: false },
            databaseQueryData: false,
            queues: false,
            stackFrameVariables: false,
        },
    });
}
