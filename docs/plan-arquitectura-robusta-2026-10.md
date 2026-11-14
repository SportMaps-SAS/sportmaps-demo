# Plan de arquitectura robusta sin subir de plan — SportMaps

**Fecha:** 2026-10-06. Todos los números de la sección 1 se midieron en vivo ese día (SQL contra la base, logs de Supabase, advisors, repo).
**Complementa** a [`plan-escalabilidad-infraestructura.md`](plan-escalabilidad-infraestructura.md) (2026-09-06) — aquel recomendaba pasar a Pro; el 2026-10-04 se decidió **seguir en Free** y este plan es el cómo.
**Estado:** propuesta. Nada de esto está aplicado.
**Actualización 2026-11-07:** sección 11, plan de rendimiento con línea base medida (red Oregon→São Paulo, p95 del BFF, `pg_stat_statements`, Lighthouse).

---

## 0. Resumen

SportMaps hoy se sostiene sobre **una sola base Supabase Free** que comparten dev, staging y producción, y **dos clientes reales (GymRM y Dreamers) operan sobre el ambiente de dev** — frontend `dev.sportmaps.co`, BFF `bffdev.sportmaps.co` y sus 4 torniquetes ZKTeco. Eso hace que "dev" sea producción de facto, que no se pueda apagar, y que cada prueba toque datos reales.

Los cuatro avisos de Supabase (Disk IO, Log Ingestion 503 %, Storage 101 %, advisors) tienen **causas distintas y ninguna requiere pagar** para mitigarse:

| Aviso | Causa real | Arreglo principal |
|---|---|---|
| Disk IO Budget | Introspección del catálogo (750 funciones, 859 policies) volcando a disco: **2.273 GB de archivos temporales** desde feb-2026 | Limpiar esquema, menos DDL suelto, dev/stg fuera de la base real |
| Log Ingestion 503 % | **112k peticiones REST/día del BFF**: ZKTeco (40 %) + crons duplicados en 3 BFF | Crons solo en prod, ZKTeco 3→1 y menos frecuente, colas por evento en vez de sondeo cada minuto |
| Storage 101 % | Medidor del período (antes de la compresión del 04-10). Vivo: **~535 MB** | R2 a mediano plazo; huérfanos ya |
| Advisors | RLS sin envolver (347), policies duplicadas (858), índices | Migración mecánica probada en Docker |

**La arquitectura objetivo** (sección 4): Supabase Free solo para producción, dev/staging en Supabase local con Docker, Cloudflare delante (DNS, WAF, Access para dev/stg, R2 para archivos, opcionalmente Workers para los torniquetes), BFF en Render con un solo líder de tareas programadas y colas que reaccionan a eventos en vez de sondear, respaldos propios en R2.

---

## 1. Estado medido (2026-10-06)

### 1.1 Plataformas

| | Hoy | Costo |
|---|---|---|
| Supabase | Free, proyecto único `luebjarufsiadojhvxgi` (dev+stg+prod) | $0 |
| Render | 4 servicios Starter: BFF dev / stg / prod + `sportmaps-demo` (Python, webhook Wompi viejo) | ~$28/mes |
| Vercel | Hobby — frontend estático (dev, stg, prod) | $0 |
| DNS | Namecheap | — |
| Otros | Resend Pro, Sentry, Groq, Firebase FCM | — |

### 1.2 Uso Supabase (período 12-sep → 12-oct)

| Métrica | Uso | Límite Free |
|---|---|---|
| Log Ingestion | **5,03 GB (503 %)** | 1 GB — no se cobra aún; grace period hasta inicios de 2027 ([changelog](https://supabase.com/changelog/logs-usage-based-pricing)) |
| Storage Size | 1,014 GB (101 %) — **vivo ~535 MB** | 1 GB |
| Egress | 3,3 GB (66 %) | 5 GB |
| Database | 202–227 MB (45 %) | 500 MB |
| MAU | 269 | 50.000 |
| Realtime | 8 conexiones pico | 200 |

### 1.3 Quién genera el tráfico (24 h, `edge_logs` = 112.310 peticiones, todas `node` desde Render)

| Ruta | Peticiones/día | Origen |
|---|---|---|
| `PATCH turnstile_devices` | 15.906 | `touchDevice()` en cada poll del ZKTeco |
| `GET device_commands` | 14.549 | poll de comandos del ZKTeco |
| `PATCH device_commands` | 14.432 | "limpiar expirados" en cada poll |
| `GET payments` | 5.397 | jobs del BFF |
| `GET notification_deliveries` | 3.839 | despachador cada minuto ×3 BFF |
| `rpc/auto_close_stale_hour_bank_visits` | 3.779 | cron cada minuto ×3 BFF (≈2,6/min) |
| `GET whatsapp_inbound_queue` / `rpc/wa_queue_claim` | 5.549 | cola de WhatsApp ×3 BFF |
| `POST bridge_heartbeats` | 2.038 | puente local del torniquete |
| Config (`school_settings`, `whatsapp_settings`, `electronic_invoice_providers`, `platform_admins`, `payer_billing_profiles`) | ~6.400 | lecturas repetidas sin caché |

Código: [`access-adms.ts:985-1025`](../bff/src/routes/access-adms.ts) (3 llamadas por poll), [`maintenance.job.ts`](../bff/src/jobs/maintenance.job.ts) (30 tareas, sin gate de ambiente, arrancan en `index.ts:503` en los 3 BFF).

Logging de Postgres ya está austero (`log_statement=ddl`, `log_min_duration_statement=-1`): **el volumen es casi todo `edge_logs`** (~1,5 KB por petición). Para entrar en 1 GB/mes hay que bajar a **~22.000 peticiones REST/día**.

### 1.4 Base de datos

- `temp_bytes` acumulado: **2.273 GB** desde 2026-02-25. Las consultas de la app escriben 0 temp; todo es introspección (Studio, recarga de caché de PostgREST — 7.948 veces, cada una con `pg_timezone_names` de 446 ms —, linter/MCP).
- Catálogo: **750 funciones** en `public` (28 con sobrecargas), **859 policies**, 294 tablas, 27 vistas. `work_mem` 2 MB, `shared_buffers` 224 MB, `max_connections` 60.
- `track_functions = none` → no hay registro de qué funciones se usan.
- Consultas de usuario más caras: vista `school_athletes` **734 ms** media; `get_onboarding_status` 81 ms × 21.825.
- Tablas más grandes: `access_events` 38 MB, `audit_logs` 38 MB, `adms_device_log` 5 MB (19k filas), `cron.job_run_details` 38k filas sin purga.
- pg_cron: 14 jobs activos (uno cada minuto: `release_expired_holds`).

### 1.5 Advisors

| Tipo | Hallazgo | Cantidad |
|---|---|---|
| Rendimiento | `auth_rls_initplan` (auth.* sin envolver) | 347 (345/397 policies, 140 tablas) |
| Rendimiento | helpers de alcance sin envolver | 173/216 policies |
| Rendimiento | `multiple_permissive_policies` | 858 |
| Rendimiento | índices duplicados | 10 (payments ×3 iguales, children ×2 pares…) |
| Rendimiento | índices sin uso / FK sin índice | 135 / 351 |
| Seguridad | ERROR `security_definer_view` | 2 (`v_school_staff_publico`, `v_school_settings_publico`) |
| Seguridad | `SECURITY DEFINER` ejecutable por `anon` | 137 |
| Seguridad | protección de contraseñas filtradas | apagada |
| Seguridad | tablas con RLS sin policy | 26 |

### 1.6 Torniquetes y clientes en dev

| Escuela | Seriales | Puente local | Apunta a |
|---|---|---|---|
| GYM RM | JJA1254900898, JJA1254900899 | sí | `bffdev` |
| Dreamers Gymnastics | CEZU214960067, CEZU222860004 | sí | `bffdev` |
| Club Campestre Demo | DEMOCAMP0001/0002 | no | inactivos desde 08-03 |

Usuarios de GymRM y Dreamers entran por **`dev.sportmaps.co`**.
`main` va 2 commits detrás de `develop`; las 30 tareas programadas son idénticas en `main`, `staging` y `develop`.

---

## 2. Principios

1. **Producción es un solo ambiente, y es `main`.** Ningún cliente vive en dev o staging.
2. **Una prueba nunca toca datos reales.** Dev y staging tienen su propia base.
3. **Un solo líder por tarea programada.** Ninguna tarea corre N veces porque haya N procesos.
4. **El BFF no le pregunta a la base lo que ya sabe.** Caché en memoria para configuración; escrituras de "sigo vivo" con tope de frecuencia.
5. **Se reduce el trabajo, no se esconde.** Una petición que no hace falta se elimina; no se mueve a otro canal para que no aparezca en el medidor. Un solo camino de acceso a datos (supabase-js).
6. **Cada pieza tiene respaldo y reversa** antes de tocarse.
7. **Gratis mientras se pueda, con umbrales explícitos para pagar** (sección 8).

---

## 3. Catálogo de opciones evaluadas

Veredicto: ✅ recomendado · 🟡 opcional / más adelante · ❌ descartado por ahora.

### 3.1 Base de datos

| Opción | Pros | Contras | Costo | Veredicto |
|---|---|---|---|---|
| **A. Supabase Free optimizado** | $0; ya está todo ahí (Auth, Storage, RLS, Realtime) | Sin respaldos automáticos; compute Nano; 1 GB logs; se pausa por inactividad (no aplica con tráfico) | $0 | ✅ hoy, con F0–F6 |
| B. Supabase Pro | Respaldos diarios 7 días, 8 GB base, 100 GB archivos, 20 GB logs, sin pausa | $25/mes; el compute sigue chico (Micro) | $25/mes | 🟡 al cruzar umbral (sec. 8) |
| C. Supabase self-host en Docker (VPS) | Control total, sin cuotas | **Tú eres el DBA**: respaldos, parches, seguridad, caídas. Auth/Storage/Realtime a mantener | ~$5–15/mes + horas | ❌ para prod · 🟡 para staging |
| D. Otro Postgres gestionado (Neon, etc.) | Branching gratis, escala a cero | Perder Auth/Storage/RLS integrados; migración enorme | $0–19 | ❌ |
| E. Segundo proyecto Supabase Free para staging | Aísla pruebas; $0 (Free permite 2 proyectos activos) | Otra base que mantener sincronizada en esquema; misma cuota de logs propia | $0 | ✅ para staging tras F1 |
| F. Supabase local con Docker (`supabase start`) | $0, aislado, rápido, ya instalado (Docker 29, CLI 2.120) | Solo en la máquina de cada dev | $0 | ✅ para desarrollo |

### 3.2 Cómputo del BFF

| Opción | Pros | Contras | Veredicto |
|---|---|---|---|
| **Render Starter (actual)** | Funciona, blueprint en `render.yaml`, WebSocket y node-cron | 0,5 vCPU / 512 MB; 3 BFF corriendo lo mismo | ✅ prod; dev/stg a Free (duermen) tras F1 |
| Render: borrar `sportmaps-demo` (Python, webhook Wompi viejo) | −$7/mes | Verificar que nada apunte a él (el BFF ya tiene `/api/v1/webhooks/wompi`) | ✅ tras verificar |
| Cloudflare Workers para **rutas calientes** (ADMS de torniquetes) | Gratis hasta 100k req/día; Durable Object por aparato mantiene estado en memoria | Reescribir ~1 ruta; Hyperdrive para hablar con Postgres | 🟡 F8 |
| Mover todo el BFF a Workers | Edge, barato | Express 5 + node-cron + sharp + WS hub: **reescritura grande** | ❌ |
| Cloudflare Containers | Correr el BFF tal cual | Plan pago, beta | ❌ por ahora |
| VPS + Docker (Coolify/Dokploy) | 4 GB RAM por ~$5–7, varios servicios | Operarlo tú; sin autoscale | 🟡 si Render queda chico |

### 3.3 Archivos

| Opción | Pros | Contras | Veredicto |
|---|---|---|---|
| Supabase Storage (actual) | Integrado con RLS de storage | 1 GB; egress cuenta | ✅ mientras se migra |
| **Cloudflare R2** | 10 GB gratis, **egress $0**, S3-compatible, URLs firmadas | Tarjeta requerida; 34 puntos de código a adaptar; otro proveedor | ✅ F7, bucket por bucket |
| Cloudflare Images | Redimensiona al vuelo | Pago por imagen | ❌ (ya se comprime al subir) |

### 3.4 Frontend

| Opción | Pros | Contras | Veredicto |
|---|---|---|---|
| Vercel Hobby (actual) | $0, funciona | **Hobby es para uso no comercial** según sus términos — verificar exposición | 🟡 revisar términos |
| Vercel Pro | Comercial, protección de previews | $20/mes | 🟡 |
| Cloudflare Pages | $0 comercial, builds ilimitadas estáticas, mismo proveedor que DNS/R2 | Reescribir rewrites por host del `vercel.json` raíz como reglas/Worker; mover DNS | 🟡 F8 si se decide salir de Vercel |

### 3.5 Red y borde (Cloudflare)

| Opción | Para qué sirve aquí | Veredicto |
|---|---|---|
| **DNS de `sportmaps.co` en Cloudflare** (hoy Namecheap) | Prerrequisito de WAF, Access, reglas de caché | ✅ F8 (con cuidado: registros de Vercel en "DNS only") |
| **WAF + rate limiting** gratis | Frenar abuso a endpoints públicos (inscripción por QR, webhooks, `/iclock`) | ✅ F8 |
| **Cloudflare Access (Zero Trust, gratis ≤50 usuarios)** | Cerrar `dev.` y `stg.` para que solo entre el equipo — evita que un cliente vuelva a quedar en dev | ✅ F2/F8 |
| **Cloudflare Tunnel** (`cloudflared`) | Exponer el puente local de cada gimnasio sin abrir puertos; acceso remoto seguro a los aparatos para soporte | ✅ F8 |
| **Workers VPC** ("VPC de Cloudflare") | Que un Worker alcance servicios privados detrás de un Tunnel (p.ej. el puente del gimnasio o un Postgres propio) | 🟡 ver 3.6 |
| Turnstile | Anti-bots en formularios públicos (registro, prospectos) | 🟡 |
| Hyperdrive | Pool de conexiones + caché de consultas de Workers a Postgres; Free 100k consultas/día | 🟡 con F8 |
| Queues / Cron Triggers / Durable Objects | Colas y tareas fuera del BFF; DO también en Free | 🟡 |

### 3.6 Sobre la "VPC de Cloudflare"

Cloudflare **Workers VPC** no es una VPC tipo AWS donde se aloja una base o un servidor. Es una forma de que **código en Cloudflare (Workers) llegue a redes privadas** a través de un Cloudflare Tunnel, sin abrir puertos ni exponer IPs. Está en beta abierta y **gratis durante la beta** (se paga solo el uso de Workers); desde abril de 2026 permite enlazar redes completas por `tunnel_id` ([changelog](https://developers.cloudflare.com/changelog/post/2026-04-14-vpc-networks/index.md), [pricing](https://55041f86.previews.developers.cloudflare.com/workers-vpc/reference/pricing/index.md)).

**Dónde encaja en SportMaps:**
- **Torniquetes:** cada gimnasio corre `cloudflared` junto a su puente local. Un Worker (o el BFF) le habla al puente por la red privada en vez de que el puente esté golpeando al BFF por HTTP. Abrir puerta, enrolar huella, sincronizar usuarios: todo sin puertos abiertos en el router del cliente.
- **Soporte remoto** a los aparatos ZKTeco (hoy hay que ir en sitio o pedir AnyDesk).
- **Si algún día hay un Postgres propio** (staging en VPS), los Workers lo alcanzan privado.

**Dónde no encaja:** no reemplaza a Supabase ni aloja la base de producción. No reduce por sí sola los logs: eso lo hacen F0 y F3.

**Veredicto:** 🟡 — vale la pena para la red de torniquetes (F8) cuando haya más de 2 gimnasios; Tunnel solo (sin Workers VPC) ya da el 80 % del beneficio y es GA.

### 3.7 Torniquetes ZKTeco (40 % del tráfico)

| Opción | Efecto | Esfuerzo | Veredicto |
|---|---|---|---|
| **Quick win:** `touchDevice` con tope de 1 escritura/60 s por aparato (en memoria); "limpiar expirados" a un cron cada 5 min | 45k → ~15k peticiones/día | Bajo | ✅ F0 |
| Subir `Delay` del handshake ADMS de 10 s a 30 s ([`access-adms.ts:785`](../bff/src/routes/access-adms.ts)). Con puente local, `open_door` no depende de este poll; enrolar huella tardaría ≤30 s | ~15k → ~5k/día | Bajo | ✅ F0 |
| ~~Poll por conexión directa `pg`~~ | Descartado: solo esconde la petición del medidor, agrega un segundo camino de acceso a datos y riesgo de conexiones | — | ❌ |
| Heartbeat del puente por el WebSocket que ya existe (`bridgeWsServer.ts`), escritura a la base cada 60 s | −2k/día | Bajo | ✅ F0 |
| Endpoint `/iclock` en Worker + Durable Object por aparato (estado y cola de comandos en el DO; Postgres solo para eventos) | Saca el ADMS del BFF; más resiliente si Render cae | Medio | 🟡 F8 |

### 3.8 Tareas programadas

| Opción | Pros | Contras | Veredicto |
|---|---|---|---|
| **`RUN_CRONS=true` solo en el BFF de prod** | 1 línea, inmediato | Lo nuevo de `develop` no corre hasta llegar a `main` | ✅ F0 |
| + candado de líder por RPC (fila `job_leases` con `FOR UPDATE SKIP LOCKED`, mismo patrón que `wa_queue_claim`) | Aunque se escale a 2 instancias, una sola corre cada tarea | 1 RPC | 🟡 solo si prod pasa a >1 instancia |
| Mover tareas SQL puras a pg_cron | Sin red; ya hay 14 | Más carga en la base; no sirve para tareas con API externa | 🟡 caso a caso |
| Cloudflare Cron Triggers + Queues | Fuera de Render | Reescritura | ❌ por ahora |

### 3.9 Ambientes

| Opción | Veredicto |
|---|---|
| **Supabase local en Docker**, sembrado con volcado del esquema vivo (resuelve de paso los ~336 objetos sin versionar) | ✅ F2 |
| Staging contra segundo proyecto Free | ✅ F2 |
| Supabase Branching | ❌ es de pago |
| Dev/stg frontend cerrados con Cloudflare Access o allowlist en la app | ✅ F2 |

### 3.10 Respaldos y observabilidad

| Opción | Veredicto |
|---|---|
| **`pg_dump` semanal (diario cuando se pueda) por GitHub Actions → cifrado con `age` → R2**, retención 8 semanas | ✅ F4 |
| Simulacro de restauración trimestral en Docker local | ✅ F4 |
| Monitoreo de uptime (BetterStack / UptimeRobot free) sobre `/health` de prod y los heartbeats de torniquetes | ✅ F4 |
| Tablero semanal de consumo (tamaño base, archivos, peticiones/día) | ✅ F4 |
| Sentry (ya está) con alertas por tasa de error | ✅ |

---

## 4. Arquitectura objetivo

```
                         ┌───────────────── Cloudflare ─────────────────┐
  Usuarios ─────────────►│ DNS · WAF · rate limit · Access(dev/stg)     │
                         │ R2 (archivos, respaldos)                      │
                         │ [opcional] Worker /iclock + Durable Objects   │
                         └───────┬───────────────────────┬──────────────┘
                                 │                       │ Tunnel / Workers VPC
                     app.sportmaps.co              ┌─────┴──────────────┐
                       (Vercel/Pages)              │ Gimnasios: puente  │
                                 │                 │ local + ZKTeco     │
                         bffprod.sportmaps.co      └────────────────────┘
                     ┌──── Render (prod) ───────┐
                     │ BFF Express              │
                     │  · RUN_CRONS + líder pg  │
                     │  · caché de config 60 s  │
                     │  · colas por evento      │
                     │  · supabase-js (usuario) │
                     └──────────┬───────────────┘
                                │
                ┌──── Supabase Free (SOLO prod) ────┐
                │ Postgres · Auth · RLS envuelta    │
                │ Storage (transición a R2)         │
                └───────────────────────────────────┘

  Dev:      Docker local (supabase start) + BFF local
  Staging:  2.º proyecto Supabase Free + BFF stg (Render Free, duerme) + Access
```

---

## 5. Plan por fases

Cada fase: objetivo · tareas · criterio de éxito · reversa. Esfuerzo en días de un dev.

### F0 — Contención inmediata (semana 1, ~2 días)

**Objetivo:** cortar a la mitad las peticiones sin tocar a ningún cliente.

1. **Crons solo en prod — implementado 2026-10-14 como `CRONS_ENABLED`** (ver "F0.1 — Interruptor global de crons" abajo). Dev y stg siguen sirviendo peticiones.
   - ⚠️ Antes: confirmar que `main` tiene todo lo de `develop` que GymRM/Dreamers usan (hoy 2 commits de diferencia).
2. ZKTeco: `touchDevice` con tope de 60 s por serial (mapa en memoria); "limpiar expirados" sale del poll a una tarea cada 5 min.
   - Subir `Delay=10` → `Delay=30` en el handshake (`access-adms.ts:785`): el aparato pregunta 3 veces menos. La apertura de puerta va por el puente local y no se afecta; enrolar una huella tarda hasta 30 s.
3. Puente: heartbeat por WebSocket, escritura a `bridge_heartbeats` cada 60 s.
4. Caché en memoria 60 s para `school_settings`, `whatsapp_settings`, `electronic_invoice_providers`, `platform_admins`, `payer_billing_profiles` (invalidación al escribir desde el BFF).
5. Migración: quitar los 10 índices duplicados.
6. Purga: `cron.job_run_details` > 7 días (y job de pg_cron que lo haga a diario).
7. Activar protección de contraseñas filtradas (Auth → settings).
8. Activar `track_functions = 'pl'` (si el rol lo permite) para empezar a medir uso de funciones.

**Éxito:** `edge_logs` < 55.000/día; `auto_close_stale_hour_bank_visits` ≈ 1/min; torniquetes y bot funcionando igual.
**Reversa:** quitar `RUN_CRONS` o ponerla en dev; los demás cambios son independientes.

#### F0.1 — Interruptor global de crons (`CRONS_ENABLED`, 2026-10-14)

Se eligió *opt-out* en vez del `RUN_CRONS=true` *opt-in* de la tabla 3.8: si la variable falta, prod sigue corriendo sus crons sin tocar su entorno.

- Código: al inicio de `initMaintenanceJobs()` ([`maintenance.job.ts`](../bff/src/jobs/maintenance.job.ts)), si `process.env.CRONS_ENABLED === 'false'` registra una línea `[CRON] CRONS_ENABLED=false: no se registra ningún cron en este proceso.` y no agenda **ninguno** de los 35 `cron.schedule`. Los `DISABLE_*` por tarea se mantienen y siguen valiendo en prod.
- **`sportmaps-bff-dev` y `sportmaps-bff-stg`: `CRONS_ENABLED=false`** (declarado en `render.yaml`; si el servicio no se sincroniza por Blueprint, ponerla a mano en el dashboard de Render).
- **`sportmaps-bff-prod`: sin definir.**
- No se apagan: las rutas ZKTeco `/iclock`, el WebSocket de puentes `/bridge/ws` ni su `setInterval` de sockets colgados (estado por conexión, no tareas sobre la base).
- ⚠️ Mientras GymRM/Dreamers sigan conectados a `bffdev` (F1 pendiente): el bloqueo automático por mora (`runAccessAutoBlockCycle`) llama a `wakeSchool()`, que solo despierta puentes WebSocket conectados **al mismo proceso**. Corriendo en prod, encola los comandos en la base pero el puente de GymRM (en dev) no se entera hasta su próxima reconexión — vuelve el retraso de horas del 2026-10-06. Mitigación: hacer F1 primero, o mientras tanto que el puente sondee periódicamente / que `wakeSchool` se dispare entre procesos (Realtime/NOTIFY). Los torniquetes ADMS que sondean `/iclock` leen la cola de la base y no se afectan.
- Reversa: borrar la variable en dev (o ponerla en `true`) y redeploy.

### F1 — Sacar a GymRM y Dreamers de dev (semanas 1–2, ~2 días + coordinación)

**Objetivo:** que dev deje de ser producción. Como la base es la misma, **sus cuentas, datos y flags ya existen en prod**: solo cambian las URLs.

1. **Paridad de código:** subir `develop` a `main` (lo hace el usuario) y verificar en prod las pantallas que usan: banco de horas, control de acceso, reglas de Dreamers, cobros.
2. **Inventario de lo que apunta a dev:** URL ADMS en los 4 aparatos, `.env` del puente local de cada gimnasio, webhooks (Meta WhatsApp, Wompi, Mercado Pago — ver a qué BFF apunta cada uno), enlaces en correos/plantillas, QR impresos, PWA instaladas.
3. **Ventana con cada gimnasio** (hora valle):
   - Cambiar en el ZKTeco *Comm → Cloud Server* de `bffdev` a `bffprod` (en sitio o remoto).
   - Cambiar la URL del puente y reiniciarlo; verificar `last_seen_at` y una apertura real.
   - Probar una entrada con huella y una con QR.
4. **Usuarios:** comunicado + enlace a `app.sportmaps.co`; instrucciones para reinstalar la PWA. Redirección desde `dev.sportmaps.co` para usuarios que no sean del equipo (banner + redirect por rol/correo) durante 2–4 semanas.
5. Bajar `sportmaps-bff-dev` y `-stg` a plan Free de Render (duermen) y evaluar borrar `sportmaps-demo` (Python).

**Éxito:** 0 peticiones de clientes en `bffdev` durante 7 días; torniquetes reportando a `bffprod`.
**Reversa:** reapuntar el aparato y el puente a `bffdev` (minutos).

### F2 — Ambientes de verdad (semanas 2–3, ~3 días)

1. **Supabase local en Docker:** `supabase db dump` del esquema vivo → baseline en el repo; `supabase start`; seed con datos sintéticos (escuelas, padres, atletas, pagos de ejemplo).
   - Decisión pendiente: ¿también un volcado con datos reales cifrado, para pruebas de RLS que necesiten volumen real? (contiene menores).
2. Script `npm run db:local` que levanta todo y aplica las migraciones pendientes.
3. **Staging → segundo proyecto Supabase Free**, sembrado desde el baseline. Credenciales de pasarelas y Factus en **sandbox**. Esto elimina el riesgo de facturas reales desde staging.
4. Cerrar `dev.` y `stg.` (Cloudflare Access cuando el DNS esté en Cloudflare; mientras, allowlist en la app).
5. Regla de equipo: **toda migración se prueba en local antes de la base real** y se aplica por CLI/`apply_migration`, nunca pegada en el editor.

**Éxito:** ningún BFF que no sea prod habla con la base de producción.

### F3 — BFF eficiente: reaccionar en vez de sondear (semanas 3–4, ~3 días)

Principio: **eliminar trabajo innecesario**, no esconderlo. Nada de conexión directa a Postgres solo para que no aparezca en los logs.

1. **Cola de WhatsApp por evento:** el webhook de Meta, al guardar el mensaje entrante, dispara el procesamiento en el momento (`setImmediate`/cola en memoria). El cron cada minuto pasa a **barredor cada 5 min** para lo que haya quedado colgado. Igual para `runWhatsAppPaymentOutcome`: se dispara al aprobar/rechazar el pago, barredor cada 5 min.
2. **Despacho de notificaciones por evento:** quien crea la notificación la encola y el BFF la despacha al momento; barredor cada 5 min para reintentos.
3. **Banco de horas:** `auto_close_stale_hour_bank_visits` de cada minuto a cada 5–10 min (una visita "colgada" se cierra igual, solo unos minutos después) o pasarlo a pg_cron (SQL puro, sin ida y vuelta por la red).
4. **Revisar cada tarea `* * * * *`** de `maintenance.job.ts`: ¿de verdad necesita correr cada minuto? Por defecto, 5 min.
5. **`get_onboarding_status`** (21k llamadas): cachear en el cliente por sesión.
6. Agrupar lecturas repetidas dentro de un mismo job (una consulta con `in(...)` en vez de N consultas por escuela).

**Éxito:** `edge_logs` < 30.000/día, sin pérdida de funcionalidad ni latencia perceptible para el usuario (el bot responde igual o más rápido, porque ya no espera al siguiente minuto).
**Si después de esto sigue sobre 1 GB/mes** al terminar el grace period (inicios de 2027): eso es el costo real de operar y es una señal legítima para Pro (20 GB incluidos), no para inventar atajos.

### F4 — Respaldos y observabilidad (semana 4, ~2 días)

1. GitHub Action semanal: `pg_dump` → `age` → R2 (o Drive mientras no hay R2). Retención 8 semanas.
2. Simulacro de restauración en Docker local; documentar en `docs/`.
3. Uptime monitor sobre `bffprod /health`, frontend prod y heartbeats de torniquetes (alerta si un gimnasio no reporta en 10 min — ya existe `alert_offline_access_devices`, conectarlo a un canal).
4. Tablero semanal de consumo (SQL guardado + captura de Usage).

### F5 — Rendimiento de base (semanas 5–7, ~5 días)

1. **RLS envuelta** (`auth.uid()` → `(select auth.uid())`, helpers → `(select fn())`):
   - Generada desde `pg_policies` vivo (no desde el repo).
   - Probada en Docker: conteo de filas por rol (padre, atleta, coach, admin, anon) idéntico antes/después en las tablas clave + `seguridad:invariantes`.
   - Aplicada por grupos (enrollments, payments, children, school_members, notifications, attendance primero) con `ALTER POLICY` + `lock_timeout` corto, en hora valle.
2. Vista `school_athletes` (734 ms): reescribir laterales o reemplazar por RPC con los campos que de verdad se piden.
3. **Unificar policies duplicadas** (858): aparte, revisión línea por línea — aquí sí cambia lógica.
4. Retención: archivar a R2 (CSV) y borrar `audit_logs`, `access_events`, `adms_device_log` > 90 días.

**Éxito:** advisors `auth_rls_initplan` ≈ 0; `school_athletes` < 100 ms.

### F6 — Limpieza del esquema (semanas 8–10, ~3 días)

1. Con 2–4 semanas de `track_functions` + grep del repo: lista de funciones nunca llamadas.
2. Respaldar definiciones (`pg_get_functiondef`) y borrar en una migración.
3. Resolver las 28 sobrecargas (dejar la firma vigente).
4. Índices sin uso (135) tras el mismo período de observación.
5. Versionar en el repo los objetos vivos que no tienen migración.

**Éxito:** catálogo < 450 funciones; recargas de PostgREST y temp de introspección a la baja.

### F7 — Archivos a R2 (en paralelo desde semana 4, ~4 días)

1. Capa `storageService` en el BFF (subir, URL firmada, borrar) que decide Supabase o R2 por bucket.
2. Orden: `avatars` → `identity-documents` (privado, URL firmada de minutos) → `equipment-photos`/`school-assets`/`product-images` → `clinical-files` → **`payment-receipts` al final** (probar OCR y dedupe sha256 leyendo de R2).
3. Por bucket: escribir nuevo en R2, leer de ambos, copiar lo viejo con respaldo, actualizar rutas, borrar de Supabase.
4. Mencionar el proveedor en la política de privacidad (Ley 1581).

**Éxito:** Supabase Storage < 100 MB; egress de Supabase a la baja.

### F8 — Borde Cloudflare (mes 3, ~4 días)

1. Mover DNS de Namecheap a Cloudflare (registros de Vercel en "DNS only"; probar las 3 sedes antes de cambiar nameservers).
2. WAF + rate limiting en `/api/v1/webhooks/*`, inscripción por QR, `/iclock/*`.
3. Access en `dev.`/`stg.`.
4. Cloudflare Tunnel en cada gimnasio junto al puente (acceso remoto de soporte).
5. 🟡 Worker `/iclock` + Durable Object por aparato + Hyperdrive; 🟡 Workers VPC para hablarle al puente por red privada.
6. 🟡 Evaluar Cloudflare Pages para el frontend (si los términos de Vercel Hobby obligan a moverse).

### F9 — Seguridad pendiente (transversal)

- Revisar las 137 `SECURITY DEFINER` ejecutables por `anon` (revocar las que no sean públicas a propósito).
- Las 2 vistas `security_definer` públicas: justificar o reemplazar por RPC.
- 26 tablas con RLS sin policy: confirmar que es intencional (solo service_role).
- Pendientes de [`auditoria-seguridad-2026-08-14.md`](auditoria-seguridad-2026-08-14.md) y de la auditoría de contabilidad/tienda del 10-02.

---

## 6. Calendario resumido

| Semana | Fases |
|---|---|
| 1 | F0 contención · inicio F1 (paridad `main`) |
| 2 | F1 migración de gimnasios · inicio F2 |
| 3 | F2 Docker + staging aislado · inicio F3 |
| 4 | F3 colas por evento · F4 respaldos · inicio F7 |
| 5–7 | F5 RLS y rendimiento · F7 R2 |
| 8–10 | F6 limpieza de esquema |
| 11–12 | F8 borde Cloudflare |
| Continuo | F9 seguridad |

---

## 7. Costos

| | Hoy | Objetivo |
|---|---|---|
| Supabase | $0 (fuera de cuota) | $0 (dentro de cuota) |
| Render | ~$28 (4 Starter) | ~$7 (solo prod Starter; dev/stg Free; Python borrado) |
| Cloudflare | — | $0 (R2 ≤10 GB, Access ≤50, WAF, Tunnel, Workers Free) |
| Vercel | $0 Hobby | $0 (o $20 Pro / Pages $0 si los términos obligan) |
| **Total infra** | **~$28/mes** | **~$7/mes** |

---

## 8. Umbrales para pagar Supabase Pro ($25/mes)

Pasar a Pro **en cuanto ocurra cualquiera** de estos:

- La base supera **400 MB** (80 % del Free).
- Tras F3, `edge_logs` sigue > 1 GB/mes cuando termine el grace period (inicios de 2027).
- Se agota el Disk IO **con uso normal de la app** (no por Studio/migraciones) más de una vez al mes.
- Primer incidente de pérdida o corrupción de datos, o un cliente exige respaldos con RPO < 1 semana.
- Más de **15 escuelas pagando** — el costo de un incidente supera con creces $25/mes.

---

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| Crons solo en prod y `main` desactualizado → una tarea nueva no corre | Checklist de release: tareas nuevas listadas en el PR a `main` |
| Migrar gimnasios rompe una apertura de puerta | Ventana en hora valle, persona en sitio, reversa en minutos |
| RLS envuelta cambia visibilidad | Conteo por rol en Docker + invariantes; aplicar por grupos |
| Procesar por evento pierde un mensaje si el BFF se reinicia a mitad | El barredor de 5 min lo recoge (la cola ya tiene lease) |
| Mover DNS causa caída | Replicar registros, TTL bajo, cambiar en hora valle |
| Datos de menores en volcados locales | Cifrado con `age`, borrado al terminar, nunca en el repo |
| Free sin respaldos mientras tanto | F4 lo antes posible; hasta entonces `pg_dump` manual semanal |

---

## 10. Decisiones pendientes

1. ¿Crons **solo en prod** aceptando que lo nuevo de `develop` corre al subir a `main`?
2. ¿Fecha para mover a GymRM y Dreamers a prod? ¿Hay acceso (en sitio o remoto) a los 4 aparatos?
3. Pruebas de RLS: ¿solo datos sintéticos o volcado real cifrado?
4. ¿Abrir cuenta Cloudflare con tarjeta (R2) y mover el DNS?
5. ¿Borrar el servicio `sportmaps-demo` (Python) de Render?
6. Vercel Hobby vs uso comercial: ¿se revisa ya o se deja para F8?

---

## 11. Plan de rendimiento (2026-11-07)

Nace de un plan genérico de 4 semanas (medir → base → backend → frontend → verificar) contrastado con el repo y con la base viva. Lo que ya estaba hecho o no aplica se sacó (11.4); lo que es peligroso aquí se corrigió (11.5). **Cuando un punto coincide con F3 o F5 de este documento, manda la fase de arriba**; esta sección la adelanta y le agrega números.

### 11.1 Línea base medida el 2026-11-07

Datos crudos y scripts para repetir la medición: `C:\tmp\perf-baseline-2026-11-07\` (fuera del repo).

**Red — el hallazgo principal.** El BFF corre en Render **Oregon**; Supabase está en **São Paulo** (`aws-1-sa-east-1`).

| Tramo | p50 | mín | Cómo |
|---|---|---|---|
| Render (Oregon) → Supabase, 1 fila por REST | **218 ms** | 194 ms | one-off job en `sportmaps-bff-dev`, 20 llamadas con keep-alive |
| Render (Oregon) → Supabase, `/auth/v1/health` | 232 ms | 197 ms | ídem |
| Colombia → Supabase | 167 ms | 157 ms | desde la máquina de desarrollo |
| Colombia → BFF prod | 171 ms | 149 ms | ídem |

Cada consulta **en serie** dentro de un handler cuesta ~220 ms de red aunque la base responda en 1 ms. Ejemplo: `/me/entitlements` tarda p50 **1.579 ms** en el servidor, y la consulta (`v_school_entitlements`) gasta 7–18 ms de base; `platform_admins` y `school_members` < 1 ms. El resto son viajes: `getUser` contra GoTrue + membresía + la consulta. La caché de auth (`bff/src/utils/authCache.ts`) dura 60 s, así que una carga de página separada más de un minuto de la anterior probablemente paga todo de nuevo (hipótesis: falta medir la tasa de aciertos).

**BFF prod — logs de `pino-http` en Render, 72 h (4→7 nov), 19.291 peticiones, 0 errores 5xx.** Tiempo medido dentro del servidor (no incluye el tramo navegador → BFF).

| Endpoint (los más usados por personas) | n | p50 | p95 |
|---|---|---|---|
| `POST /devices/register` | 828 | 706 | 1.095 |
| `GET /events/my-open-tournaments` | 602 | 726 | 1.559 |
| `GET /tournament-live/me/today` | 594 | 486 | 1.270 |
| `GET /me/entitlements` | 492 | 1.579 | 2.146 |
| `GET /school/context` | 454 | 746 | 1.329 |
| `GET /marketplace/school-store/:id` | 302 | 1.193 | 1.555 |
| `GET /attendance/session/:id` | 195 | 881 | 1.334 |
| `GET /autopay/mine` | 159 | 1.210 | 2.108 |
| `GET /school/performance/roster` | 118 | 1.792 | 2.369 |
| `GET /school/reports` | 102 | 1.761 | 2.629 |

Peores p95: `POST /payments/extract-receipt` 7,6 s (OCR), media de WhatsApp 4,6 s, `GET /attendance/roster/team/:id` 2,9 s. **Ninguno de los 10 más usados cumple p95 < 500 ms.** (El webhook de WhatsApp, 9.587 peticiones, responde en 1 ms: se excluye.)

**Base — `pg_stat_statements`.** Ojo: **no se ha reiniciado desde el 2026-02-25**, así que acumula ocho meses y mezcla consultas ya arregladas. Se guardó una foto por `queryid` (`pgss-2026-11-07.json`) para medir la próxima semana **por diferencia**, sin reiniciar.

| Rol | % del tiempo total | Qué es |
|---|---|---|
| `supabase_admin` | 43,6 % | interno (Realtime): ignorar |
| `authenticated` | 21,8 % | la app desde el navegador |
| `service_role` | 19,7 % | el BFF y sus jobs |
| `authenticator` | 6,9 % | recarga de esquema de PostgREST: 10.466 recargas de ~1 s cada una |
| `postgres` | 6,4 % | Studio/CLI: **3,29 M bloques temporales (~25 GB)** — el Disk IO |

Consultas de la app que más pesan:
- `school_athletes`: entre 567 y 1.096 ms de media según la variante; máximo 12 s.
- `storage.search` (listar archivos de Storage desde el cliente): **3,5 s de media**, máximo 25 s, 584 llamadas.
- `children` por `parent_id`, con conteo: 158 ms de media en 13.784 llamadas, para una búsqueda trivial (costo de RLS).
- `UPDATE payments` desde el cliente: 530–690 ms de media.
- `get_onboarding_status`: 41.688 llamadas a 48 ms. Se puede cachear por sesión, como ya decía F3.5.
- Jobs: `auto_close_stale_hour_bank_visits` 246 k llamadas, sondeo de `notification_deliveries` 322 k, `UPDATE turnstile_devices.last_seen_at` 1,3 M y `bridge_heartbeats` 321 k. Todo esto es F3.

**Frontend prod (`app.sportmaps.co`, cuenta demo `gerencia@demo.sportmaps.co`).** La escuela demo es chica: en escuelas grandes las listas pesan más.

| Escenario | Resultado |
|---|---|
| Lighthouse móvil `/login`, 2 corridas | puntaje **52–56**, FCP 4,3 s, **LCP 5,7–5,8 s**, TBT 490–610 ms, 752 KiB |
| Bloquean el render (Lighthouse) | `checkout.wompi.co/widget.js` ~1,1 s · Google Fonts (5 pesos de Poppins) ~1 s · CSS 0,5 s |
| JS sin usar en la entrada | 170 de 258 KiB de `index-*.js` |
| Escritorio sin throttle: clic «Entrar» → dashboard listo | 5,9 s · 43 llamadas a la API + ~110 chunks |
| Móvil (Pixel 5, 4G lento, CPU ×4): clic «Entrar» → dashboard | 10,6 s |
| `/dashboard` con caché caliente (escritorio) | listo 4,0 s · LCP 2,1 s · 43 llamadas a la API · 122 peticiones de chunks |
| `/students` con caché caliente (escritorio) | **LCP 7,1 s**: `school_athletes?select=*` sola tarda 2,6 s; 37 llamadas (10 al BFF) |
| `/payments` con caché caliente (escritorio) | listo 1,6 s · 13 llamadas |
| Navegador → Supabase por consulta simple | p50 ~220–245 ms |

### 11.2 Prioridades, por impacto medido

**R1 — Viajes BFF ↔ base (la palanca más grande del BFF).**
1. **Menos viajes en serie, sin cambiar de región:**
   - verificar el JWT localmente: si el proyecto usa llaves de firma asimétricas, `getClaims()` valida con JWKS sin secreto (revisar en el dashboard de Supabase);
   - membresía + entitlements en una sola RPC;
   - `Promise.all` donde los `await` son independientes;
   - medir la tasa de aciertos de `authCache`.
   Empezar por los 10 endpoints de la tabla.
2. **Región:** Render no tiene Sudamérica; Virginia es lo más cercano a São Paulo (estimado ~120 ms por viaje contra los 218 medidos, **sin medir**). Antes de decidir, medir con el mismo job en un servicio temporal en Virginia. Mover implica servicio nuevo (la región no se cambia en uno existente), mover `bffprod.sportmaps.co` y revisar listas de IP de salida en proveedores. **Desde Oregon, ningún endpoint con 2 o más consultas en serie puede cumplir p95 < 500 ms.**

**R2 — Base (adelanta F5).**
1. RLS envuelta por grupos: `children`, `enrollments`, `payments`, `school_members`, `attendance_records`. Mismo método de F5: generada desde `pg_policies` vivo, forma `= ANY ((SELECT f())::uuid[])` para helpers `uuid[]`, `lock_timeout` corto, hora valle, una sola sesión, `gen types` al final, `seguridad:invariantes` después.
2. `/students`: dejar de pedir `school_athletes?select=*`; usar RPC paginada con los campos que la tabla muestra.
3. Encontrar quién llama `storage.search` (3,5 s) y reemplazarlo por rutas guardadas en columnas.
4. `UPDATE payments` desde el cliente (~600 ms): revisar triggers y policies; si es el flujo de aprobar o registrar pago, que pase por una RPC.
5. Índices: **solo** los que pida un `EXPLAIN` hecho como `authenticated` (con `set_config('request.jwt.claims', …)`). Las tablas caben en RAM: un índice ahorra CPU, no IO, y ya hay 135 sin uso.

**R3 — Frontend.**
1. Cargar `widget.js` de Wompi solo al abrir el checkout (hoy bloquea todas las páginas, login incluido).
2. Fuentes: menos pesos de Poppins, o servirlas desde el propio dominio con `preload`.
3. Dashboard: 43 llamadas y 122 chunks. Consolidar los KPIs en una RPC; quitar las lecturas repetidas (p. ej. `profiles` se pide dos veces); los dos `HEAD children` (~650 ms cada uno) se van con R2.1; rastrear qué arrastra al dashboard los chunks del asistente de onboarding, `colombian-banks` y `store` (pendiente desde agosto).
4. Sacar de `index-*.js` lo que no usa el login (170 KiB).
5. Debounce de 300 ms en los buscadores que consultan por tecla (hoy solo 4 archivos usan debounce).
6. Skeletons y UI optimista: después, y **nunca** optimista en pagos ni cobros.

**R4 — Trabajo de fondo (= F3).** Sondeos por eventos. `extract-receipt` (7,6 s): evaluar responder al instante y procesar en la cola, si el flujo del acudiente lo permite (decisión de producto).

### 11.3 Verificación

- Repetir con los mismos scripts: logs de Render (p50/p95 por endpoint), diferencia de `pg_stat_statements` contra la foto del 11-07, Lighthouse móvil y el recorrido con la cuenta demo.
- **Prueba de carga: solo contra `supabase start` local + BFF local + pasarelas en sandbox** (ver 11.5). Antes de simularlo, sacar el pico real de los datos (pagos y comprobantes por hora) en vez de suponer «el día 5».
- Regresión de pagos, RLS (`seguridad:invariantes` + conteo por rol) y conciliación.

**Criterio de éxito.** p95 < 500 ms en los 10 endpoints de 11.1 (no alcanzable desde Oregon con 2+ viajes en serie: ver R1.2), LCP < 2,5 s en móvil (hoy 5,7 s en el login), cero errores en el pico simulado.

### 11.4 Ya hecho o no aplica (se sacó del plan original)

| Ítem | Realidad |
|---|---|
| Code splitting con `React.lazy` | Ya: 225 rutas lazy en `App.tsx`. Lo pendiente es R3.3. |
| React Query | Ya: 247 archivos. |
| Pool con Supavisor | El BFF va por REST, no usa `pg` directo (y conectar directo a Postgres ya se descartó). |
| Idempotency keys en pagos | Ya existe `requireIdempotencyKey`; solo falta auditar que cubra todos los endpoints de pago. |
| Outbox | Ya: notificaciones, Wompi, Mercado Pago. |
| Tracing con Sentry | No hace falta: los logs de `pino-http` en Render ya dan p50/p95 por endpoint. Sentry sigue solo con errores. |
| Diferir GTM | No hay GTM; el tercero que pesa es Wompi (R3.1). |
| Avatares y documentos en WebP | Ya se comprimen al subir desde el 2026-10-04. |
| Streaming de Mapi | Mapi no está construido; va en su spec. |
| Redis | Solo si una medición muestra lecturas repetidas caras que no resuelva una caché en memoria. |

### 11.5 Correcciones obligatorias al plan original

1. **Prueba de carga nunca contra un ambiente actual.** Una sola Supabase para dev, stg y prod (caída de 14 h el 2026-10-14 por Disk IO); las credenciales de Mercado Pago de dev son de producción; el OCR gasta IA; la facturación es real.
2. **Los comprobantes no se recomprimen ni se pasan a WebP.** El OCR necesita la resolución completa y la deduplicación compara sha256. Solo miniaturas con lazy loading en la vista.
3. **`EXPLAIN ANALYZE` como `authenticated`**, nunca como `postgres` en el SQL Editor: la misma consulta dio 1,4 ms sin RLS y 555 ms con RLS.
4. En `pg_stat_statements`, ignorar `realtime.list_changes` y lo que corre como `postgres` o `supabase_admin`.
5. Medir con la cuenta demo, no con la sesión de un cliente, y separar el tráfico de QA y demo (fue el 75 % de los logins de octubre).

---

## Fuentes

- Supabase — logs usage-based pricing (grace period hasta inicios de 2027): https://supabase.com/changelog/logs-usage-based-pricing
- Supabase — Manage Logs Ingest usage (Free 1 GB, Pro 20 GB, $0,50/GB): https://supabase.com/docs/guides/platform/manage-your-usage/logs-ingest.md
- Cloudflare — VPC Networks (abril 2026): https://developers.cloudflare.com/changelog/post/2026-04-14-vpc-networks/index.md
- Cloudflare — Workers VPC pricing (gratis en beta): https://55041f86.previews.developers.cloudflare.com/workers-vpc/reference/pricing/index.md
- Cloudflare — Workers pricing (Hyperdrive, Queues, Durable Objects en Free): https://developers.cloudflare.com/workers/platform/pricing/
