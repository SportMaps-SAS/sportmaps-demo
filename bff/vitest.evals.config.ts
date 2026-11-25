// Evals del modo agente de Mapi con el MODELO REAL (docs/specs/mapi-agente-plan.md §14).
//
//   cd bff && npm run mapi:evals
//
// Cuesta plata (llama a Claude): NO entra en `npm test` (vitest.config.ts solo
// incluye *.test.ts). Supabase va falso: nada se escribe en la base, y nada sale
// a la red salvo la API de Anthropic (guardia de fetch en mapi-agente.eval.ts).
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.eval.ts'],
        globals: false,
        fileParallelism: false,
        // Con MAPI_EVALS_REPETIR=3 la corrida completa pasa de una hora.
        testTimeout: 5 * 60 * 60_000,
        hookTimeout: 60_000,
        env: {
            WHATSAPP_MODO_DISCRETO: 'false',
            // registrarUsoLlm escribe en llm_usage… de la base FALSA (se cuenta en el reporte).
            LLM_USAGE_EN_PRUEBAS: 'true',
            // Si `enviar_recordatorio_pago` está en el CATALOGO, que se le ofrezca al admin.
            MAPI_RECORDATORIO_MANUAL: 'true',
            // Oleadas 2–5: las acciones que nacen apagadas también se evalúan (casos-oleadas.ts).
            // Las que llaman RPC «como la persona» se ofrecen porque alcanceDe trae `authorization`.
            MAPI_PAGOS_ACCIONES: 'true',
            MAPI_CAMBIAR_PLAN: 'true',
            MAPI_COBROS_UNICOS: 'true',
            MAPI_INSCRIBIR_TORNEO: 'true',
            MAPI_OPERACION_ACCIONES: 'true',
            // Sin MAPI_AGENT_STRICT: strict va apagado por defecto (registro.ts, «compiled grammar
            // is too large»). Los evals corren con la misma configuración que producción.
        },
    },
});
