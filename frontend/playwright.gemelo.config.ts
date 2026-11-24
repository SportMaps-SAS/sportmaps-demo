// Playwright contra el GEMELO LOCAL (Supabase en Docker), nunca contra la viva.
//
//   npm run qa:twin:up                       (en la raiz)
//   cd frontend && npx playwright test -c playwright.gemelo.config.ts
//
// - globalSetup: e2e/helpers/guard-no-prod.ts aborta si algo apunta a produccion.
// - Levanta su PROPIO Vite en el puerto 3101 (strictPort, sin reusar) con las
//   variables del gemelo: un `npm run dev` abierto en 3001 apunta a la viva y
//   reusarlo haria que la UI escribiera en produccion aunque la guarda pase.
// - Specs: e2e/tienda/** y e2e/contabilidad/** (tienda v2 §8.5, contabilidad v2 §8.8).
// - BFF: si la prueba lo necesita, levantarlo aparte con las variables del gemelo
//   (npm run qa:twin:status) y exportar QA_TWIN_BFF_URL.
// Ver docs/qa-gemelo-local.md.
import { defineConfig, devices } from '@playwright/test';

// QA_TWIN_VITE_PORT: otro puerto si 3101 está ocupado por otra corrida (sigue sin reusar).
const PORT = Number(process.env.QA_TWIN_VITE_PORT ?? 3101);
// Llave anon de DEMO que la CLI de Supabase usa en todo stack local (no es secreta).
const LOCAL_ANON =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const twinEnv = {
    VITE_SUPABASE_URL: process.env.QA_TWIN_SUPABASE_URL ?? 'http://127.0.0.1:54321',
    VITE_SUPABASE_PUBLISHABLE_KEY: process.env.QA_TWIN_ANON_KEY ?? LOCAL_ANON,
    VITE_SUPABASE_ANON_KEY: process.env.QA_TWIN_ANON_KEY ?? LOCAL_ANON,
    VITE_BFF_URL: process.env.QA_TWIN_BFF_URL ?? 'http://127.0.0.1:3000',
    VITE_API_URL: process.env.QA_TWIN_BFF_URL ?? 'http://127.0.0.1:3000',
    // Wompi: solo sandbox. Vacio = el checkout no arranca el widget.
    VITE_WOMPI_PUBLIC_KEY: process.env.QA_TWIN_WOMPI_PUBLIC_KEY ?? '',
    VITE_APP_ENV: 'qa-gemelo',
};
// Para que la guarda vea lo que realmente usara el webServer.
Object.assign(process.env, twinEnv, { PLAYWRIGHT_SUPABASE_URL: twinEnv.VITE_SUPABASE_URL });

export default defineConfig({
    testDir: './e2e',
    testMatch: ['tienda/**/*.spec.ts', 'contabilidad/**/*.spec.ts', 'pagos/**/*.spec.ts'],
    globalSetup: './e2e/helpers/guard-no-prod.ts',
    fullyParallel: false,
    retries: 0,
    reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-gemelo' }]],
    use: {
        baseURL: `http://localhost:${PORT}`,
        trace: 'retain-on-failure',
    },
    projects: [
        { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
        { name: 'pixel-7', use: { ...devices['Pixel 7'] } },
    ],
    webServer: {
        command: `npx vite --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: process.env.QA_TWIN_REUSE === '1', // solo con un Vite propio ya apuntando al gemelo
        env: twinEnv,
        timeout: 120_000,
    },
});
