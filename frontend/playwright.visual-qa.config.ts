import { defineConfig } from '@playwright/test';

// QA visual de páginas PÚBLICAS (sin sesión). Ver DESIGN.md §10.
//
// No toca la base: levanta Vite con una URL de Supabase inexistente
// (127.0.0.1:9), así ninguna consulta llega a la base compartida dev/stg/prod.
// Las secciones que dependen de datos se ven en su estado de error/vacío.
//
// Para auditar contra un ambiente real ya levantado:
//   QA_BASE_URL=https://... npm run qa:visual
const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3005';

export default defineConfig({
    testDir: './e2e/visual-qa',
    fullyParallel: true,
    reporter: [['list']],
    timeout: 60_000,
    use: {
        baseURL: BASE_URL,
        trace: 'off',
        navigationTimeout: 30_000,
        // Si el Chromium de Playwright no está instalado (p. ej. sandbox con
        // otro navegador), apuntar al binario: QA_CHROMIUM_PATH=/ruta/chrome
        launchOptions: process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {},
    },
    webServer: process.env.QA_BASE_URL
        ? undefined
        : {
              command: 'npx vite --port 3005 --strictPort',
              url: 'http://localhost:3005',
              reuseExistingServer: true,
              timeout: 120_000,
              env: {
                  VITE_SUPABASE_URL: 'http://127.0.0.1:9',
                  VITE_SUPABASE_PUBLISHABLE_KEY: 'qa-visual-sin-base',
                  VITE_BFF_URL: 'http://127.0.0.1:9',
              },
          },
});
