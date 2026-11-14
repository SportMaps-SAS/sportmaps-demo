// QA T2 del frontend de reservas contra el GEMELO LOCAL. NO levanta Vite: espera uno propio ya
// arrancado en 5174 con entorno explicito (VITE_SUPABASE_URL=http://127.0.0.1:54321, VITE_BFF_URL=http://127.0.0.1:3102).
//   cd frontend && npx playwright test -c playwright.reservas.config.ts
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.QA_T2_VITE_PORT ?? 5174);
export default defineConfig({
    testDir: './e2e/reservas',
    testMatch: ['*.spec.ts'],
    globalSetup: './e2e/helpers/guard-no-prod.ts',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 90_000,
    reporter: [['list']],
    use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', locale: 'es-CO', timezoneId: 'America/Bogota' },
    projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
