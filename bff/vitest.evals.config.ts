// Evals del modo agente de Mapi con el MODELO REAL (docs/specs/mapi-agente-plan.md §14).
//
//   cd bff && npm run mapi:evals
//
// Cuesta plata (llama a Claude): NO entra en `npm test` (vitest.config.ts solo
// incluye *.test.ts). Supabase va falso: nada se escribe en la base.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.eval.ts'],
        globals: false,
        fileParallelism: false,
        testTimeout: 60 * 60_000,
        hookTimeout: 60_000,
        env: {
            WHATSAPP_MODO_DISCRETO: 'false',
            // registrarUsoLlm escribe en llm_usage… de la base FALSA (se cuenta en el reporte).
            LLM_USAGE_EN_PRUEBAS: 'true',
            // Si `enviar_recordatorio_pago` está en el CATALOGO, que se le ofrezca al admin.
            MAPI_RECORDATORIO_MANUAL: 'true',
        },
    },
});
