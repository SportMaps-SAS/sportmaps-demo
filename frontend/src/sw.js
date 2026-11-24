// Variable inyectada por vite-plugin-pwa en build time
// Lo asignamos a self para evitar que el minificador (esbuild) lo borre
self.__precacheManifest = [].concat(self.__WB_MANIFEST || []);

import { precachearBuild } from './pwa/precacheBuild'

// La versión de cache se DERIVA del manifiesto del build, no se escribe a mano.
//
// Antes era la constante 'sportmaps-v3' y el filtro de 'activate'
// (`k !== CACHE_NAME`) por lo tanto nunca borraba la cache de la app: el nombre
// era el mismo entre deploys. Los chunks de todos los builds se acumulaban sin
// techo, y offline se podían servir piezas de versiones distintas mezcladas.
// Purgar dependía de que alguien se acordara de subir el número a mano.
//
// `__WB_MANIFEST` cambia en cada build (trae url + revision de cada archivo),
// así que el hash cambia con el deploy y 'activate' sí encuentra caches viejas
// que borrar. Hash barato y síncrono a propósito: corre en el arranque del SW.
const BUILD_ID = (() => {
  let h = 0;
  for (const entry of self.__precacheManifest) {
    const s = typeof entry === 'string' ? entry : `${entry.url}|${entry.revision ?? ''}`;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
})();
const CACHE_NAME = `sportmaps-${BUILD_ID}`
// Caché ESTABLE de los archivos del build con hash (precarga offline). No cambia con el deploy:
// un deploy solo descarga lo que cambió y poda lo que ya no existe (src/pwa/precacheBuild.ts).
const ASSETS_CACHE = 'sportmaps-assets'
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

// Instalación — cachear assets estáticos
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  )
})

// Activación — limpiar caches viejos.
// Con CACHE_NAME derivado del build este filtro por fin hace algo: borra la cache
// del deploy anterior. Se mantiene a propósito el barrido de TODO lo que no sea la
// cache actual —incluida 'supabase-api'— porque es el comportamiento que ya tenía
// y porque datos de API cacheados antes de un deploy pueden haber quedado obsoletos.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== ASSETS_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

// Precarga del build para abrir sin señal (modo offline, Fase 1).
// NO en 'install': competiría con la carga inicial (medido 2026-08-17: login de 8 s a 16 s).
// La página, ya cargada y ociosa, manda PRECACHE_BUILD; se baja de a pocos y solo lo que falta.
// Va a ASSETS_CACHE (estable); el fetch de abajo ya busca en TODAS las cachés al fallar la red.
let precargando = null
self.addEventListener('message', (event) => {
  const msg = event.data
  if (!msg || msg.type !== 'PRECACHE_BUILD') return
  if (precargando) return
  precargando = caches.open(ASSETS_CACHE)
    .then(cache => precachearBuild({
      entradas: self.__precacheManifest,
      origen: self.location.origin,
      cache,
      traer: (url) => fetch(url, { cache: 'no-cache' }),
    }))
    .then(r => { if (event.source) event.source.postMessage({ type: 'PRECACHE_BUILD_DONE', ...r }) })
    .catch(() => { /* se reintenta en la próxima pasada */ })
    .finally(() => { precargando = null })
  event.waitUntil(precargando)
})

// Fetch — Network first para API, Cache first para assets
self.addEventListener('fetch', (event) => {
  // Solo interceptar peticiones GET. POST, PUT, DELETE, etc. no son soportados por la Cache API
  if (event.request.method !== 'GET') return

  const url = new URL(event.request.url)

  // Supabase API y Edge Functions → NO se interceptan ni se cachean aquí.
  //
  // Antes se guardaba cada GET por URL, SIN el token: dos usuarios que piden la misma URL compartían
  // entrada y, sin red, el segundo recibía los datos del primero (celular de una familia, tablet de
  // recepción). Las lecturas offline ahora van por React Query persistido en IndexedDB, con la copia
  // por usuario y borrada al cerrar sesión (src/lib/offline). Sin red el fetch falla de forma
  // natural y la app muestra lo guardado, con su etiqueta de hora.
  if (url.hostname.includes('supabase.co')) {
    return
  }

  // No interceptar peticiones cross-origin (BFF en onrender, Google, etc.).
  // El SW solo gestiona assets/navegación de ESTE origen; meterse con APIs de
  // terceros puede fabricar 503 sintéticos si el fetch falla un instante.
  // (Supabase ya se manejó arriba con su propia estrategia.)
  if (url.origin !== self.location.origin) {
    return;
  }

  // Assets estáticos → cache first
  if (event.request.destination === 'image' ||
      event.request.destination === 'font'  ||
      url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(event.request)
        .then(cached => cached || fetch(event.request))
    )
    return
  }

  // JS / CSS / módulos / assets con hash → network only, SIN fallback al shell.
  // Servir index.html (text/html) para un <script> produce el error de MIME
  // "Expected a JavaScript-or-Wasm module script ... text/html" y rompe los
  // imports dinámicos (lazy) tras un redeploy con hashes nuevos. Preferimos un
  // 503 (que dispara vite:preloadError → reload) antes que devolver HTML.
  if (
    event.request.destination === 'script' ||
    event.request.destination === 'style'  ||
    event.request.destination === 'worker' ||
    url.pathname.startsWith('/assets/')
  ) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // No cachear respuestas que no sean OK ni HTML servido por el rewrite SPA
          const ct = response.headers.get('content-type') || ''
          if (response.ok && !ct.includes('text/html')) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
          }
          return response
        })
        .catch(async () => {
          const cached = await caches.match(event.request)
          return cached || new Response('Asset no disponible', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          })
        })
    )
    return
  }

  // Navegaciones (documentos HTML) → network first, fallback al shell offline.
  // Solo aquí es correcto devolver index.html.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put('/index.html', clone))
          }
          return response
        })
        .catch(async () => {
          const shell = await caches.match('/index.html')
          return shell || new Response('Sin conexión', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          })
        })
    )
    return
  }

  // Resto de peticiones GET → network first con cache, SIN fallback al shell.
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
        }
        return response
      })
      .catch(async () => {
        const cached = await caches.match(event.request)
        return cached || new Response('Network error occurred', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: new Headers({ 'Content-Type': 'text/plain' }),
        })
      })
  )
})

// ─── Push Notifications ───────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  // Tolerante: payload JSON (BFF) o texto plano (botón Push de DevTools).
  let data = {}
  if (event.data) {
    try { data = event.data.json() }
    catch { data = { body: event.data.text() } }
  }
  const { title = 'SportMaps', body = '', url = '/', type = 'default' } = data

  const iconMap = {
    installment_received: '/icons/icon-192.png',  // abono recibido
    installment_approved: '/icons/icon-192.png',  // abono aprobado
    installment_rejected: '/icons/icon-192.png',  // abono rechazado
    payment_due:          '/icons/icon-192.png',  // pago próximo a vencer
    default:              '/icons/icon-192.png',
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: iconMap[type] || iconMap.default,
      badge: '/icons/icon-96.png',
      data: { url, type },
      vibrate: [200, 100, 200],
      requireInteraction: type === 'installment_received', // escuela debe ver esto
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        const existing = clientList.find(c => c.url.includes(targetUrl))
        if (existing) return existing.focus()
        return clients.openWindow(targetUrl)
      })
  )
})
