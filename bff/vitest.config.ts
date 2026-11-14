import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        globals: false,
        // El bot de WhatsApp corre en «modo discreto» por defecto (2026-10-29). Los
        // tests de siempre validan el bot completo, que sigue siendo el respaldo
        // (`WHATSAPP_MODO_DISCRETO=false`); los del modo discreto lo prenden ellos.
        env: { WHATSAPP_MODO_DISCRETO: 'false' },
    },
});
