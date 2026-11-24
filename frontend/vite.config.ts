/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: '/',
  build: {
    outDir: 'build',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("tesseract.js") || id.includes("tesseract-core")) return "vendor-tesseract";
          if (id.includes("pdfjs-dist")) return "vendor-pdfjs";
          // Visor 3D de la pizarra (M4): three + react-three-fiber van aparte y solo
          // bajan al tocar «Ver en 3D». Antes que la regla de react: react-reconciler
          // y react-use-measure contienen "node_modules/react" y caerían en vendor-react.
          if (/node_modules\/(three|@react-three|react-reconciler|react-use-measure|its-fine|suspend-react)\//.test(id)) return "vendor-three";
          if (id.includes("node_modules/react")) return "vendor-react";
        },
      }
    }
  },
  server: {
    host: "0.0.0.0",
    port: 3001,
    allowedHosts: true,
    proxy: {
      '/api/nominatim': {
        target: 'https://nominatim.openstreetmap.org',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/nominatim/, ''),
        headers: {
          'User-Agent': 'SportMaps/1.0 (sportmaps-demo)',
        },
      },
    },
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      // NO inyectar el registerSW.js automático: registramos el SW manualmente
      // en src/pwa/register.ts (como type:'module'). El script inyectado lo
      // registraba en paralelo como worker clásico → doble registro del mismo
      // scope con tipos distintos → controllerchange en bucle → recargas.
      injectRegister: null,
      includeAssets: ['favicon.png', 'sportmaps-logo.png'],
      // El manifest ya NO lo genera Vite: lo sirve el BFF por escuela en
      // /app.webmanifest (rewrite de vercel.json) y el link lo escribe el script
      // inline de index.html. Si Vite siguiera emitiendo su propio
      // manifest.webmanifest + <link>, habria DOS links rel=manifest y el
      // navegador se quedaria con el estatico de SportMaps, anulando la marca
      // de la escuela.
      // El contenido por defecto (nombre, colores, iconos de SportMaps) vive
      // ahora en DEFAULT_MANIFEST de bff/src/routes/pwa.routes.ts, que es lo que
      // se devuelve cuando la escuela no tiene marca propia.
      manifest: false,
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5 MB limit
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gstatic-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
      },
      // OJO: con strategies:'injectManifest' la seccion que manda es ESTA, no
      // el globPatterns de `workbox` (ese queda como config muerta).
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // No precachear los pesos muertos. Medido el 2026-08-17: el precache
        // eran 401 entradas / 7.4 MB, y sus fetches compiten con las peticiones
        // criticas de la app al entrar — el login pasaba de 8s a 16s con el SW
        // activo. Estos chunks se cargan on-demand cuando alguien de verdad
        // exporta un PDF o corre el OCR; el costo es que esas dos funciones no
        // sirven sin conexion, que es un intercambio razonable.
        globIgnores: [
          '**/vendor-pdfjs-*.js',
          '**/vendor-tesseract-*.js',
          '**/tesseract*.js',
          '**/jspdf*.js',
          '**/html2canvas*.js',
          '**/generateCategoricalChart-*.js',
          // Visor 3D: solo lo descarga quien lo abre (no al instalar la PWA).
          '**/vendor-three-*.js',
          '**/Tactical3DModal-*.js',
          // Modo offline (Fase 1): lo que no es del flujo del entrenador en la cancha. Medido el
          // 2026-11-23: el precache llegaba a 11,4 MB; exceljs (exportar a Excel) y el modelo de
          // visión pesan ~1 MB y solo se usan con red.
          '**/exceljs*.js',
          '**/vision_bundle-*.js',
        ],
      },
      devOptions: {
        // Desactivado: el dev-SW se regenera con cada HMR y provoca recargas en
        // bucle durante el desarrollo. Solo activamos el SW en producción.
        enabled: false,
        type: 'module',
      }
    })
  ].filter(Boolean),
  optimizeDeps: {
    include: ["react", "react-dom", "@tanstack/react-query", "@radix-ui/react-slider"],
    // FIX: excluir tesseract.js del procesamiento de Vite para evitar que el
    // minificador rompa los callbacks internos del worker (error "g is not a function")
    exclude: [],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  test: {
    globals: true,
    // Con ~100 archivos en paralelo, renderizar un modal completo pasa de los 5 s por defecto
    // y falla por tiempo aunque la logica este bien (cada prueba pasa sola).
    testTimeout: 20000,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/',
      ],
    },
  },
}));
