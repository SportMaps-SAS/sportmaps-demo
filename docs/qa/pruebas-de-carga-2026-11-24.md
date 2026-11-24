# Pruebas de carga — 2026-11-24

**Pregunta:** ¿hasta dónde aguanta SportMaps y cómo falla?
**Herramienta:** `scripts/carga/escalera.mjs` (sin dependencias). Sube la concurrencia por escalones
y se detiene en el primero que rompe un umbral, diciendo por qué (429, 5xx, timeouts, latencia).

## Reglas de seguridad (no negociables)

La base es **una sola** para dev, stg y prod, y el 2026-10-14 se cayó todo ~14 h por agotar el Disk IO
(CLAUDE.md). Por eso:

- La herramienta **se niega** a apuntar a `*.supabase.co` / `*.supabase.in`.
- Por defecto solo acepta `localhost`. Un host remoto exige `--permitir-remoto` y queda con un tope de
  20 concurrentes y 2 min en total. **Un endpoint remoto que lee la base es carga sobre la base.**
- En esta ronda **no se tocó ninguna base**: el BFF corrió local con `SUPABASE_URL=http://127.0.0.1:9`
  (inalcanzable) y `NODE_ENV=production` (límites de producción). Los crons no arrancan fuera de Render.

## Resultados

Máquina: contenedor de 4 núcleos; el generador de carga y el BFF corren en la misma máquina, así que
las cifras absolutas son un piso, no la capacidad de Render.

### 1. Proceso Express sin base (`GET /health`)

| Concurrencia | req/s | p50 | p95 | p99 | Error |
|---|---|---|---|---|---|
| 10 | 3.806 | 2 ms | 6 ms | 10 ms | 0 % |
| 100 | 4.393 | 20 ms | 41 ms | 63 ms | 0 % |
| 500 | 4.924 | 64 ms | 129 ms | 192 ms | 0 % |
| 1000 | 4.404 | 107 ms | 215 ms | 8.107 ms | 0 % |

**Conclusión:** el BFF en sí no es el cuello de botella. A 1000 concurrentes aparece cola (p99 de 8 s),
pero sin errores. El límite real va a estar en la base (Disk IO) y en los limitadores.

### 2. Limitador general — ❌ fallaba desde el primer escalón (corregido)

Escenario: **300 usuarios distintos** entrando por el **mismo borde de Cloudflare**, que es como llegan
a Render (`X-Forwarded-For` = IP del borde, `CF-Connecting-IP` = IP del usuario). Ruta: `GET /api/v1/me`
(responde 401 sin token, no toca la base; el limitador cuenta igual).

**Antes:**

| Concurrencia | Respuestas | Error |
|---|---|---|
| 2 | 401×66 · **429×10.551** | 99,4 % |
| 5 | **429×16.299** | 100 % |

**Después:**

| Concurrencia | Respuestas | Error |
|---|---|---|
| 2 | 401×9.149 | 0 % |
| 25 | 401×15.947 | 0 % |

Había dos fallas en `generalLimiter` (200 peticiones / 15 min, montado en ~40 rutas de `/api/v1`):

1. **Llave = IP del borde de Cloudflare.** Usaba `req.ip`, que con `trust proxy = 1` detrás de
   Cloudflare → Render es la IP del borde. Todos los usuarios que entran por el mismo borde (en Bogotá,
   casi todos) compartían **un solo cupo de 200**. Es el mismo bug del incidente de la tienda del
   2026-09-22 (`storeRateLimit.ts`), y **no estaba en la lista de `SEG-32`**.
2. **Cuenta doble.** El mismo limitador está montado en varios `app.use` que matchean la misma URL
   (`/api/v1/schools` dos veces y dos comodines `app.use('/api/v1', generalLimiter, …)` para
   `vendorShippingRouter` y `reviewsRouter`). Medido con `RateLimit-Remaining`: según la ruta, **una
   petición gastaba entre 1 y 4 unidades** (`/api/v1/me` 3, `/api/v1/schools` 4).

**En la práctica:** en hora pico (p. ej. una escuela pasando asistencia o los padres pagando a fin de
mes), la app entera empezaba a responder «Demasiadas peticiones. Intenta de nuevo en 15 minutos» tras
unas 50–200 peticiones **sumando a todos los usuarios** de ese borde.

**Corrección:** `bff/src/middlewares/generalRateLimit.ts`, con el mismo patrón ya probado en la tienda:
llave = `clientIp()` (CF-Connecting-IP, con `req.ip` de respaldo local) y una sola cuenta por petición.
Tests en `generalRateLimit.test.ts`. El cupo por usuario sigue igual (200/15 min).

> **Depende de `SEG-28`:** `CF-Connecting-IP` solo es confiable mientras Render sea alcanzable
> únicamente vía Cloudflare (que la sobreescribe). Es la misma premisa que ya usan la tienda y el link
> de agendamiento.

## Lo que falta medir (necesita decisión)

| Prueba | Qué responde | Riesgo / requisito |
|---|---|---|
| Endpoints que leen la base (`/api/v1/school/context`, asistencia, pagos) | ¿Cuántos usuarios aguanta la base antes de quemar Disk IO? | **Prohibido contra la base compartida.** Requiere un proyecto Supabase aparte (branch o restore de un backup) o una ventana fuera de horario mirando el panel de IO, con tope bajo |
| Frontend en Vercel | Tiempo de carga real en 4G | Es CDN; conviene Lighthouse/WebPageTest, no carga |
| Webhooks (Wompi, WhatsApp) | ¿Se pierden eventos en ráfaga? | Necesita firmas válidas; hacerlo en local con fixtures |
| Jobs de cada minuto | N+1 multiplicado por los 3 BFF | Revisión de código, no carga |

## Cómo repetirlo

```bash
# BFF local SIN base, con límites de producción
cd bff && NODE_ENV=production PORT=4100 SUPABASE_URL=http://127.0.0.1:9 \
  SUPABASE_SERVICE_ROLE_KEY=x SUPABASE_ANON_KEY=x npx tsx src/index.ts &

# 1. Capacidad cruda
node scripts/carga/escalera.mjs --url http://localhost:4100/health --escalones 10,50,100,250,500,1000 --duracion 8 --max-p95 500

# 2. Limitador: 300 usuarios detrás de un mismo borde de Cloudflare
node scripts/carga/escalera.mjs --url http://localhost:4100/api/v1/me --esperado 401 \
  --escalones 2,5,10,25 --duracion 5 --clientes 300 --ip-borde 172.70.80.1 --seguir
```
