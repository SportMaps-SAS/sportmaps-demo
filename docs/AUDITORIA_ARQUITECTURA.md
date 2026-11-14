# Auditoría de Arquitectura — SportMaps

> Auditoría panorámica generada el **2026-07-28**. Alcance: visión global de cómo se conectan las capas (frontend / BFF / base de datos / deploy), patrones, decisiones de diseño y deuda técnica. **No** entra módulo por módulo a fondo (para eso, auditoría dedicada por módulo).
>
> Volumen del código: **~165k** líneas frontend · **~37k** líneas BFF · **~57k** líneas en **273 migraciones** SQL · **~180 páginas** React.

---

## 0. Resumen ejecutivo

SportMaps es una plataforma multi-tenant de gestión deportiva (escuelas, entrenadores, padres, atletas, tiendas, organizadores, gimnasios) construida como **monorepo informal** de tres piezas desplegadas por separado:

```
┌─────────────────┐     Bearer JWT + x-school-id      ┌──────────────────┐
│    FRONTEND     │ ────────────────────────────────► │       BFF        │
│ React+Vite+PWA  │                                    │  Express 5 / TS  │
│    (Vercel)     │ ◄──── lecturas directas ─────┐     │    (Render)      │
└─────────────────┘                              │     └──────────────────┘
        │                                        │              │
        │ supabase-js (anon key, RLS)            │              │ service_role
        ▼                                        │              ▼  (bypassa RLS)
┌───────────────────────────────────────────────┴────────────────────────┐
│               SUPABASE  (PostgreSQL 15 + RLS + Auth + Edge Functions)     │
│                    273 migraciones · RPCs SECURITY DEFINER                 │
└──────────────────────────────────────────────────────────────────────────┘
```

**Decisión arquitectónica central:** el frontend habla con Supabase por **dos vías en paralelo**:
1. **Directo** con `supabase-js` + anon key para **lecturas** (protegidas por RLS en la DB).
2. **Vía BFF** para **escrituras, lógica sensible y jobs** (el BFF usa `service_role`, que *bypassa* RLS, y hace la autorización él mismo en middlewares + RPCs).

Esto da lo mejor de dos mundos (lecturas rápidas sin backend intermedio + escrituras validadas server-side) pero crea una **frontera difusa**: la regla "GET por Supabase, escrituras por BFF" está documentada pero no se cumple de forma uniforme.

**Estado de madurez:** funcionalmente muy rico y con patrones de seguridad avanzados (idempotencia en pagos, defensa en profundidad, cifrado de secretos), pero con **deuda técnica de higiene** significativa: repo contaminado con artefactos, tipado laxo, catálogo de roles duplicado en 6 sitios, dos sistemas de cron coexistiendo, y gates de calidad inconsistentes entre local y CI.

---

## 1. Estructura del repositorio

Monorepo **informal**: NO usa npm/bun workspaces. Cada paquete (`frontend`, `bff`) tiene su propio `package.json`, `package-lock.json` y `node_modules`. La coordinación es por convención (rutas relativas en configs de deploy).

```
sportmaps-demo/
├── frontend/          # React SPA + PWA + Capacitor (Android)  → Vercel
├── bff/               # Express 5 API REST (/api/v1/*)          → Render
├── supabase/
│   ├── migrations/    # 273 archivos .sql (aplicación manual)
│   ├── functions/     # 8 Edge Functions (Deno)
│   └── config.toml
├── docs/              # specs, arquitectura, roadmaps
├── scripts/           # imports, scrapers, migrations.mjs (ledger de migraciones)
├── backend/           # ⚠️ LEGADO Python (vestigial)
├── api/               # ⚠️ LEGADO
├── mobile/            # ⚠️ LEGADO Flutter (solo analysis_options.yaml)
└── tests/             # scripts SQL de validación (RLS, QA)
```

**Deuda:** conviven directorios legado (`backend/` Python, `api/`, `mobile/` Flutter vestigial) con el stack real. El `.husky/pre-commit` incluso rotula el frontend como *"Next.js"* (es Vite/React) y chequea un `backend/` Python desalineado con el servicio Python real de Render.

---

## 2. Frontend (React + Vite + TypeScript)

### 2.1 Montaje y árbol de providers

`main.tsx` monta `<StrictMode><App/></StrictMode>` con un listener de `vite:preloadError` (guard en `sessionStorage`) que recupera la app de chunks obsoletos tras un deploy, y registra el service worker de PWA.

`App.tsx` anida los providers en este orden (de fuera hacia dentro):

```
QueryClientProvider (react-query)
 └ TooltipProvider
   └ IdleConfigProvider          (timeout por inactividad)
     └ AuthProvider              (sesión Supabase + profile)
       └ SchoolProvider          (multi-tenant; ¡vive en hooks/, no en contexts/!)
         └ ThemeProvider         (tema + branding white-label)
           └ ErrorBoundary
             └ CartProvider      (carrito multi-tipo)
               └ BrowserRouter → Suspense(PageLoader) → <Routes>
```

Orden **deliberado y documentado en el código**: `SchoolProvider` va por encima de `ThemeProvider` y `ProtectedRoute` porque ambos consumen el contexto de escuela (branding + roles) antes de llegar al layout.

`QueryClient`: `staleTime 5min`, `gcTime 10min`, `retry 1`, `refetchOnWindowFocus:false`.

### 2.2 Routing — React Router v6

- **Todas** las páginas son `lazy()` + `Suspense` (code-splitting exhaustivo, ~200 imports lazy).
- **Públicas**: `/`, `/login`, `/register`, `/explorar`, `/marketplace`, `/event/:slug`, `/tienda/:slug`, `/entrenador/:userId`, `/c/:qrToken` (carné público), `/cert/:folio`, `/join/:slug`…
- **Recepción kiosco** (`/recepcion`): protegida por rol pero fuera del chrome de `AuthLayout`.
- **Autenticadas**: un `<ProtectedRoute><AuthenticatedLayout/></ProtectedRoute>` envuelve todas las rutas hijas; cada hija puede tener su propio `<ProtectedRoute allowedRoles={...}>` anidado.

### 2.3 Estructura de carpetas `src/`

| Carpeta | Propósito |
|---|---|
| `components/` (44 subdirs) | UI shadcn (`ui/`, 52 comp.) + guards + componentes por dominio |
| `pages/` (~180) | Vistas ruteadas (111 en raíz + subcarpetas por rol/dominio) |
| `contexts/` | 4 Contexts: Auth, Cart, Theme, IdleConfig |
| `hooks/` (60) | Datos/negocio; 30 usan react-query. Incluye `useSchoolContext` (Provider) |
| `lib/` | Lógica no-React: `api/` (clientes+servicios), `permissions.ts` (RBAC), utils |
| `integrations/supabase/` | `client.ts` + `types.ts` (generados de la DB) |
| `config/` | `navigation.ts`, `routePermissions.ts`, `saas-plans.ts` |
| `constants/roles.ts` | Catálogo `USER_ROLES` |
| `layouts/AuthLayout.tsx` | Shell autenticado (sidebar + header + `<Outlet/>` en `BrandingScope`) |
| `pwa/` | Registro SW, push, banners install/update |
| `features/recepcion/` | **Único** módulo con estructura feature-based (el resto es type-based) |

### 2.4 Gestión de estado

**Contexts (5):**
1. **AuthContext** — sesión Supabase, `profile`, `signIn/signUp/signInWithGoogle/signOut`, detección de "personal trainer workspace". Escucha `onAuthStateChange`, difiere fetches con `setTimeout(...,0)` para evitar deadlocks del cliente Supabase.
2. **SchoolContext** (`hooks/useSchoolContext.ts`) — el más complejo. Multi-tenant: resuelve `school_members`, selecciona escuela activa por prioridad de rol, maneja `switchSchool`, sucursales, branding, y **inyecta `schoolId` al `bffClient`**. Persiste en `localStorage`. *Code smell:* contiene el helper de dominio `createStudentWithPendingPayment` que no debería vivir en un contexto.
3. **ThemeContext** — tema light/dark/system + branding white-label; `useBranding()`/`useBrandingCssVars()` convierten hex→HSL e inyectan `--primary/--secondary`.
4. **CartContext** — carrito multi-tipo (`enrollment | product | appointment | service`), persistido, se limpia al logout.
5. **IdleConfigContext** — auto-logout por inactividad, con registro de formularios sin guardar para pausarlo.

**react-query (TanStack v5):** mecanismo principal de estado servidor — **214 usos** en 30 de 60 hooks. Debilidad: no es universal; muchas páginas hacen `supabase` directo con `useEffect/useState`.

### 2.5 Integración con backend (dos vías)

**Cliente Supabase** (`integrations/supabase/client.ts`): `persistSession + autoRefreshToken`, `localStorage`. Importado directo en **95 páginas**.

**Cliente BFF** (`lib/api/bffClient.ts`):
- Base URL resuelta **por hostname en runtime** (localhost→:3000, dev/preview→onrender dev, prod→onrender prod).
- Auth por `Authorization: Bearer <access_token>` (obtenido de la sesión Supabase). **Sin CSRF token** (auth por Bearer, no cookies).
- Inyecta header `x-school-id` (multi-tenancy) desde SchoolContext.
- `authMode` por request: `required | optional | public` (soporta links públicos).
- Clase `BFFError`; trata 207 Multi-Status como éxito parcial.
- **Deuda:** existe `lib/api-config.ts` (`API_URL`) que coexiste con `resolveBffUrl()` — dos fuentes de verdad de la URL del BFF.

Patrón híbrido documentado (`lib/api/students.ts`): **lecturas via Supabase SDK directo; escrituras/bulk via BFF** (validación server-side + `school_id` forzado).

### 2.6 Auth, sesión y guards por rol

- **Login/sesión** en AuthContext. `signOut` hace limpieza agresiva (borra `sb-*` y `sportmaps_*` de localStorage, `queryClient.clear()`, `window.location.replace('/login')`).
- **`ProtectedRoute`**: espera loading; sin usuario→`/login`; sin rol→`/onboarding/role`; los roles privilegiados (`owner, admin, super_admin, school_admin`) hacen bypass de `allowedRoles` salvo `strictRoleCheck` (rutas super-admin).
- **Guards extra:** `VendorGuard`, `OrganizerGuard`, `RequirePersonalTrainer`, `PermissionGate`.
- **⚠️ Catálogo de roles duplicado en ≥6 sitios** (`constants/roles.ts`, `routePermissions.ts`, `lib/permissions.ts`, `AuthContext`, `ProtectedRoute`, `useSchoolContext`, `types/dashboard.ts`) con listas divergentes (el rol `reporter` aparece en unos y no en otros) → **fuente potencial de bugs de autorización**.

### 2.7 UI y theming

- **shadcn/ui** (52 componentes) + **Tailwind** con colores mapeados a CSS vars HSL.
- **White-label por escuela**: `useBranding()` deriva colores de `schoolBranding.branding_settings` (DB); se aplica **scopeado** vía `<BrandingScope>` que envuelve el `<Outlet/>` (no global a `:root` — cambio de diseño documentado). Gateado por `entitlements.addons.whitelabel`.

### 2.8 PWA

- Registro de `/sw.js` como módulo, **desactivado en DEV** (evita bucles de recarga por HMR). Auto-update escucha `controllerchange` (diferido si hay flujo crítico como pago); `reg.update()` cada 60 min.
- Service Worker (`CACHE_NAME='sportmaps-v3'`): estrategias diferenciadas — Supabase API network-first (excluye `/auth/` y `/realtime/`); JS/CSS **network-only sin fallback al shell** (evita error MIME tras redeploy); navegaciones network-first con fallback offline.
- **Push (VAPID)**: `subscribeToPush` → `upsert` en tabla `push_subscriptions`; el SW maneja `push` (iconos por tipo de notificación) y `notificationclick`.

### 2.9 Deuda técnica del frontend

1. **Doble camino de datos sin frontera clara** (95 páginas con Supabase directo en paralelo al BFF).
2. **Listados ad-hoc sin paginación**: solo 39 usos de `.range()`/`.limit()` frente a decenas de listados con `select('*')` sin límite → riesgo de rendimiento a escala.
3. **Fetching inconsistente**: react-query en 30 hooks, pero muchas páginas con `useEffect+useState+supabase` manual.
4. **Tipado débil**: **1272 ocurrencias de `any`/`as any`** en 275 archivos.
5. **`UserRole` duplicado** en ≥6 archivos con listas divergentes.
6. **Config del BFF duplicada** (`api-config.ts` vs `bffClient`).
7. **Árbol de fuentes contaminado** (logs, `.timestamp-*.mjs`, `sw.js` en `src/`, `SchoolProvider` en `hooks/`).

---

## 3. BFF (Express 5 + TypeScript)

Ejecutado con `nodemon`/`ts-node` en dev y `node dist/index.js` en prod. Desplegado en **Render**. ~70 archivos de rutas, **~412 handlers** de endpoint.

### 3.1 Punto de entrada `index.ts` — orden de middlewares

1. `dotenv.config()` **primero** (antes de imports que usan env).
2. **helmet** (con `crossOriginEmbedderPolicy:false` para iframes Wompi, CSP off porque sirve JSON; HSTS 1 año).
3. **No-cache headers** en todas las respuestas (anti fuga de PII).
4. **CORS** con allowlist explícita + validación de subdominios `*.sportmaps.co` por `URL.hostname` (anti-bypass) + previews Vercel por regex.
5. **`admsRouter` montado en `/` ANTES de `express.json()`** — router de dispositivos biométricos ZKTeco que habla protocolo `/iclock` en texto plano.
6. **express.json** `limit:'5mb'` + `verify` que guarda `req.rawBody` (para HMAC del webhook WhatsApp).
7. **pino-http** con `requestId` y serializers que no loguean PII.
8. **404 handler** + **error handler centralizado** (oculta el mensaje en producción).

**Rate limiting** (3 limitadores): `generalLimiter` (200/15min prod), `paymentLimiter` (20/min), `cardAlterLimiter` (10/h **keyed por userId**, anti card-testing).

### 3.2 Estructura

| Carpeta | Propósito |
|---|---|
| `config/` | Clientes externos: `supabase.ts` (service_role), `firebase.ts` (FCM lazy), `webpush.ts` (VAPID) |
| `controllers/` | Solo **3** (explorar, favoritos, polls) — el 95% de la lógica está inline en rutas ⚠️ |
| `routes/` (~70) | Núcleo. Sub-carpetas `athlete/`, `trainer/`, `school/`, `athletes/` |
| `services/` | Integraciones + negocio (pagos, invoicing, notif, whatsapp, ocr, llm, shipping); `invoicing/` y `shipping/` con patrón adapter/factory |
| `middlewares/` | `authMiddleware.ts`, `csrfHeader.ts`, `tenantBySubdomain.ts` |
| `jobs/` | 3 archivos de crons in-process |
| `utils/` | email, branding, `payment-crypto` (AES-256-GCM), geocoding, proration |

### 3.3 Rutas / API (bajo `/api/v1` salvo excepciones)

- **Estudiantes/inscripciones**: students, enrollments, attendance, session-bookings, offerings, sport-configs, billing-events.
- **Escuela**: schools (branding), custom-domains (Enterprise), school-staff, delegations, performance, routines.
- **Pagos** (con `paymentLimiter`): payments (Wompi), payments/mp (MercadoPago), payment-providers, payment-tokens (+CSRF), recurring (+CSRF, autopay), glosas, reconciliation, admin/payments, vendor payouts.
- **Webhooks** (sin JWT, validación por firma): `/webhooks/wompi` (checksum SHA256), `/webhooks/mercadopago` (HMAC x-signature), `/webhooks/whatsapp` (HMAC X-Hub-Signature-256), `/webhooks/shipping`.
- **Marketplace**: marketplace(+catalog/admin/checkout/orders), reviews, vendor(+products/services), shipping.
- **Facturación electrónica**: invoicing (Factus/PAC Colombia).
- **Notificaciones**: `/internal/notifications` (interno, sin JWT), devices (FCM/web-push).
- **Trainer** (`requireTrainerAuth`) y **Athlete** (`requireAthleteAuth`): perfiles, rutinas, biomech, wger.
- **ADMS `/iclock`**: dispositivos ZKTeco, texto plano, auth solo por **IP allowlist**.

### 3.4 Auth / Autorización (`middlewares/authMiddleware.ts`)

**Autenticación:** valida `Bearer <token>` llamando a `supabase.auth.getUser(token)` **en cada request** (round-trip al Auth de Supabase; no hay verificación JWT local con JWKS). Variantes: `requireAuth`, `requireMarketplaceAuth`, `requireTrainerAuth`, `requireAthleteAuth`, `optionalAuth`, `requireBasicAuth`.

**Autorización:** `requireRole()`, `requirePermission()` (matriz RBAC espejo del frontend), `requireVendorProfile()` (RPC `has_vendor_capability`), `requireOwnership()` (anti-IDOR), `auditLog()` (fail-safe a `security_audit_log`).

**CSRF** (`csrfHeader.ts`): header custom `X-Requested-With: SportMaps` en métodos state-changing; montado en `payment-tokens` y `recurring`.

**Multi-tenant** (`tenantBySubdomain.ts`): resuelve `schoolId` desde subdominio vía RPC + cache TTL 60s (no montado globalmente).

### 3.5 Acceso a datos

**No hay `pg` Pool ni conexión directa a Postgres.** Todo via `@supabase/supabase-js` con **`SUPABASE_SERVICE_ROLE_KEY`, que bypassa RLS** (documentado en `config/supabase.ts`). El BFF es el único caller de los RPCs con service_role; la autorización fina la hacen middlewares + RPCs. Se apoya fuertemente en **RPCs de Postgres** (`claim_due_recurring_subscriptions` con FOR UPDATE SKIP LOCKED, `detect_payment_anomalies`, `auto_finalize_stale_sessions`…) y vistas.

> ⚠️ **Implicación de seguridad:** como el service_role bypassa RLS, toda la autorización recae en middlewares + RPCs. Un bug en un middleware expone datos cross-tenant **sin la red de seguridad de RLS**.

### 3.6 Jobs / crons — **dos mecanismos coexisten** (deuda documentada)

**A) node-cron in-process** (dentro del proceso web, TZ `America/Bogota`):
| Cron | Horario | Función |
|---|---|---|
| Mantenimiento | `55 23 * * *` | finalizar sesiones stale + refresh MV |
| Autopay **legacy** | `0 2 * * *` | cobra `subscriptions` (kill-switch `DISABLE_LEGACY_SUBSCRIPTION_AUTOPAY`) |
| Reproceso webhooks | `*/10 * * * *` | reprocesa webhooks huérfanos |
| Conciliación | `30 3 * * *` | detecta anomalías/duplicados |
| Auto-facturación | `*/15 * * * *` | emite facturas (kill-switch `DISABLE_AUTO_INVOICING`) |
| Notif. glosa | `5 8 * * *` | recordatorios de glosa |
| Despachador notif. | `* * * * *` | drena outbox `notification_deliveries` |

**B) pg_cron (Supabase) → endpoint HTTP** (mecanismo **canónico** para lo nuevo): autopay canónico (`/recurring/run` con `x-cron-secret`), notificaciones (`/internal/notifications/dispatch` con `x-notif-secret` + `timingSafeEqual`, fail-closed).

> ⚠️ Los node-cron corren en el proceso web: con múltiples réplicas en Render se ejecutarían N veces — mitigado por **idempotencia** (leases, referencias únicas, manejo de `23505`), no por un scheduler dedicado. El autopay legacy y el canónico están **vivos a la vez** (riesgo de doble cobro mitigado solo por idempotencia).

### 3.7 Integraciones externas

| Integración | Servicio | Notas |
|---|---|---|
| **Wompi** (pagos CO) | `wompi.service.ts` | Widget + server-to-server; firma integridad SHA256, re-fetch anti-spoofing |
| **MercadoPago** | `mercadopago.service.ts` | Bricks + API; credenciales por escuela/vendor o default |
| **Web Push (VAPID)** | `webpush.service.ts` | no-op seguro si falta config |
| **FCM/Firebase** | `push.service.ts` | firebase-admin, init lazy, credencial base64 |
| **WhatsApp/Meta** | `whatsapp*.service.ts` | Tech Provider multi-tenant, token cifrado AES-256-GCM, bot con LLM tool-calling |
| **LLM** | `llm.service.ts` | abstracción Gemini/DeepSeek/Groq |
| **OCR** | `ocr.service.ts` | LLM Vision (Groq→OpenAI/Gemini) para comprobantes |
| **Email** | `emailClient.ts` | invoca Edge Function `send-email` (no SMTP directo) |
| **Facturación DIAN** | `invoicing/factus.adapter.ts` | patrón adapter (Siigo/Alegra comentados) |
| **Shipping** | `shipping/` | solo mock implementado |
| **Acceso biométrico** | `access-adms.ts` | ZKTeco `/iclock` texto plano |

### 3.8 Secretos

Cargados con `dotenv`. Secretos de pasarela por escuela cifrados **AES-256-GCM** (`gcm:<iv>:<tag>:<ct>`) en `payment_provider_secrets` con `PAYMENT_TOKENS_ENC_KEY`; clave de WhatsApp separada para aislar radio de exposición. Patrón: servicios opcionales se degradan a **no-op seguro** si falta el secreto; pagos/crypto **lanzan**.

### 3.9 Deuda técnica del BFF

1. Dos sistemas de cron coexistiendo (legacy + canónico).
2. Crons dentro del proceso web (no escalan limpio).
3. `supabase.auth.getUser()` en cada request (round-trip; sin verificación local).
4. Service_role bypassa RLS en todo el BFF.
5. Convención inconsistente controllers vs rutas (solo 3 controllers; lógica inline en 70 routers grandes) → dificulta testing (solo 1 test: `notification.service.test.ts`).
6. Ruta trainer "temporalmente sin auth" (`trainerWgerRouter`).
7. Fallbacks a URLs/keys hardcodeadas (`apply-rls.ts`).
8. Artefactos de build versionados (`tsc_error.log`, etc.).

---

## 4. Base de datos (Supabase / PostgreSQL 15 + RLS)

~**175 tablas**, gobernadas por 273 migraciones inmutables.

### 4.0 ⚠️ Hallazgo transversal: DOS esquemas paralelos en el repo

Existen dos "esquemas" que **NO son la misma base de datos**:
- **`database_schema.sql`** (raíz) es un MVP v1.0 **heredado y obsoleto**: usa `CREATE TYPE` masivo, tabla `students` (no `children`), `transactions`/`manual_payments`, `schools.admin_id`. **No refleja la DB de producción** ni lo referencian las migraciones. Solo documento histórico → **puede confundir a cualquiera que lo tome como referencia.**
- **`supabase/migrations/`** es la **fuente de verdad real.** Empieza en `20260217000001_schema_refactored.sql` ("MASTER PLAN v2.0", multi-tenant) y evoluciona 272 migraciones.

### 4.1 Modelo de datos por dominio (todas en `public.`)

| Dominio | Tablas núcleo |
|---|---|
| **Perfiles / IAM** | `profiles` (PK=`auth.users.id`), `roles` (catálogo), `user_roles`, `user_devices`, `push_subscriptions` |
| **Escuelas / sedes** | `schools` (`owner_id`), `school_settings` (1:1), `school_branches`, `school_members` (membresía multi-tenant), `school_staff`, `school_custom_domains`, `school_addons` |
| **Inscripciones** | `enrollments` (sujeto polimórfico: `child_id`\|`user_id`\|`unregistered_athlete_id` con CHECK), `children`, `classes`, `offerings`+`offering_plans`, `teams`+`team_members` |
| **Pagos** | `payments` (central; `status` **TEXT+CHECK**), `payment_reminders/links/tokens/consents/splits/glosas`, `payment_provider_secrets`, `recurring_subscriptions`, `recurring_charge_attempts`, `refunds`, `webhook_events`, `payment_anomalies` |
| **Marketplace** | `products`(+`variants`/`images`), `orders`(+`items`), `carts`, `stock_holds`, `inventory_transactions`, `vendor_profiles/balances/payouts`, `marketplace_transactions`, `coupons`, `disputes`, `shipments`, `service_listings`/`session_bookings` |
| **Torneos/eventos** | `events`, `event_registrations`, `tournament_matches`(+`events`), `calendar_events` |
| **Notificaciones** | `notifications`, `notification_deliveries` (**outbox**), `messages`, `announcements` |
| **Reservas** | `facilities`, `facility_reservations`, `service_availability`, `session_bookings` |
| **Contabilidad** | `expenses` (owner polimórfico), `expense_categories`, `suppliers`, `payroll_*`, `invoices`, `electronic_invoices` (FE DIAN), `bank_statements`(+`lines`), `cash_ledger` |
| **Asistencia** | `attendance_records`, `attendance_sessions`, `session_attendance` |
| **Métricas** | `athlete_stats`, `training_logs`, `match_results`, `training_plans` |
| **Carnets** | `athlete_id_cards`(+`templates`), `athlete_certificates`, `school_join_qr_codes` |
| **WhatsApp** | `school_whatsapp_integrations` (routing por `phone_number_id`, token cifrado), `whatsapp_conversations/messages/identifications` |
| **Control de acceso** | `turnstile_devices`, `zk_user_mappings`, `access_events`, `device_commands`, `adms_device_log` |
| **Plataforma/auditoría** | `audit_logs`, `security_audit_log`, `analytics_events`, `platform_config`, `school_subscriptions`, `subscription_plans` |

### 4.2 Catálogo de roles — **triple vocabulario** (deuda)

Hay **tres vocabularios de rol conviviendo**, causa raíz de varios bugs históricos de autorización:
1. **`profiles.role`** — ENUM `user_role` (`admin, school, coach, parent, athlete, wellness_professional, store_owner`).
2. **`roles.name`** — catálogo textual sembrado (`athlete, coach, admin, super_admin, wellness_professional, store_owner, organizer, parent`; luego `external_vendor`, `personal_trainer`). El propio seed comenta: *"Ojo: DB usa school_admin, Frontend dice 'school'"*.
3. **`school_members.role`** — ENUM `member_role` (`owner/admin/coach/staff/parent/athlete/viewer`) — **es el que consulta la RLS** para decisiones por-tenant, NO `profiles.role`.

`super_admin` existe en el catálogo y helpers pero **no** en el enum `user_role` (se resuelve tratando `role` como texto). `facility_manager` no está sembrado. Requirió migraciones dedicadas de mapeo (`fix_role_mapping_school_admin`, `google_oauth_role_selection`).

### 4.3 RLS — patrón de seguridad

RLS habilitada en ~50 tablas. Las policies **delegan toda decisión a funciones helper `SECURITY DEFINER STABLE`** para evitar recursión:
- `user_school_ids() → uuid[]`, `is_school_admin(school_id)`, `user_school_role(school_id)`, `is_super_admin()`, `can_manage_finances(owner_type, owner_id)` (punto único multi-owner que despacha a school/vendor/organizer), y familia extendida (`is_school_coach`, `is_parent_of_child`, `coach_team_ids`…).

**Regla de no self-recursion confirmada y aplicada** — una policy sobre X nunca hace `SELECT FROM X` en su `USING`; invoca un helper `SECURITY DEFINER` que bypassa RLS. La cicatriz del aprendizaje es visible: cadena `fix_recursion` → `fix_school_recursion` → `nuclear_rls_fix` → `fix_sm_recursion_final` (que además hace `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` en `school_members`/`schools`).

**Incidente documentado (regla "nunca revocar EXECUTE de helpers"):** la migración `20260513000003` revocó EXECUTE de los helpers para callar el linter y **rompió con 403 todas las queries**; el hotfix `…006` re-otorgó `GRANT EXECUTE … TO anon, authenticated`. Exactamente la convención del CLAUDE.md.

### 4.4 RPCs clave (`SECURITY DEFINER`)

- **Pagos/cobros:** `process_enrollment_checkout`, `confirm_order_payment`, `confirm_marketplace_payment`, `save_payment_token`, `resolve_payment_provider`, y **`open_month(school, year, month, branch)`** — generación canónica de cuotas con `pg_advisory_xact_lock` por (escuela, periodo) para serializar doble-clic/cron. `generate_monthly_charges()` ahora **delega en `open_month`**.
- **Stock:** `hold_stock()`, `expire_stock_holds()`; mutación real en trigger `deduct_stock_on_payment()` con `SELECT stock … FOR UPDATE`.
- **Reconciliación:** `detect_payment_anomalies()` (restringida a `service_role`), `reconcile_statement()`.

**Convenciones:** `search_path` mixto (70 archivos usan la forma canónica `pg_catalog, public, pg_temp`; 63 la forma corta — no todos alineados). `GRANT EXECUTE` bien aplicado en RPCs modernas (patrón `REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO authenticated`).

### 4.5 Auditoría

`audit_trigger_func()` — trigger universal `SECURITY DEFINER` que captura `TG_OP` + `to_jsonb(OLD/NEW)` y escribe en `audit_logs`. **⚠️ Cobertura limitada:** hoy solo está cableado explícitamente a **`payments`** (`trg_audit_payments`). La auditoría es opt-in tabla por tabla y no cubre `enrollments`, `orders`, `school_members`, etc.

### 4.6 Cumplimiento de convenciones del CLAUDE.md

| Convención | ¿Se cumple? |
|---|---|
| Migraciones inmutables (fix = migración nueva) | ✅ **Sí, estrictamente** (abundan `fix_*`, `_v2/v3_final`, `round2/3/4`) |
| `search_path` en función nueva | 🟡 **Parcial** (canónico en nuevas, corto/ausente en viejas) |
| `GRANT EXECUTE` explícito por RPC | ✅ Sí (mayormente) |
| `text + CHECK` en vez de `CREATE TYPE` | 🟠 **Violada en el núcleo** (16 ENUMs en el master), cumplida en tablas nuevas — la regla se adoptó *después* |
| `payments.status` es TEXT | ✅ Confirmado |
| FKs de negocio → `profiles(id)` | 🟠 **Inconsistente** (muchas van a `auth.users(id)` directo: `schools.owner_id`, `children.parent_id`, `payments.parent_id`…) |
| Mutación de stock solo en RPC con `FOR UPDATE` | ✅ Sí (`deduct_stock_on_payment` con FOR UPDATE; sin UPDATE de stock desde cliente) |

### 4.7 Deuda técnica de la base de datos

1. **🔴 SQL corrupto en la migración maestra.** `schema_refactored.sql:1162` y `:1174` contienen `CREATE OR REPLACE FUNCTION public.EXISTS (SELECT 1 FROM school_members WHERE …)` — un buscar/reemplazar fallido dejó el *cuerpo* de la función como su *nombre*. Es SQL inválido; los nombres reales (probablemente `is_school_staff`/`is_admin`) se perdieron. Por inmutabilidad la cicatriz es permanente y las funciones se redefinen después. **Si se corre tal cual en una DB fresca, falla.**
2. **Doble esquema en el repo** (§4.0).
3. **Tablas creadas fuera de git ("directo a la DB")**, versionadas idempotentemente a posteriori: control de acceso ZKTeco (`access_control_versioned_schema.sql` — "creadas a mano en producción RMGYM") y columnas `billing_*` de `profiles` (facturación electrónica).
4. **Enum vs CHECK desincronizados:** `payments` migró de enum `pay_status` a TEXT, pero se agregó `'partial'` al enum y no al CHECK → fallos de inserción (narrado en `20260711130002`). Enum y CHECK coexisten como dos fuentes de verdad.
5. **Triple vocabulario de roles** (§4.2).
6. **`can_manage_finances` definida dos veces** (SQL en accounting vs plpgsql en invoicing) con lógica distinta según orden de aplicación.
7. **Dedup de cobros incompleto:** dependía de `period_year/month` NULL en legacy; `open_month` hace doble chequeo (por periodo y por `due_date`). Índices reforzados recién en `20260724000001`.
8. **"Tres vías incompatibles" de generación de cobros** (cron + botón + insert manual → duplicados) unificadas apenas en julio 2026.
9. **Colisiones de timestamp** en nombres de migración (orden ambiguo entre homónimos): `20260511000004_*` (dos), `20260511000006_*`, `20260710000001_*`, `20260519000001_*`.
10. Auditoría de bajo alcance (§4.5).

---

## 5. Build, Deploy y Tooling

### 5.1 Deploy — 3 proveedores

- **Vercel = Frontend.** Dos `vercel.json` (raíz + `frontend/`) con reglas de rewrite **divergentes** → riesgo según el Root Directory configurado. `vercel-ignore-build.sh` solo construye en ramas `main|staging|production|develop`.
- **Render = BFF** — `render.yaml` define **4 servicios web**:
  1. `sportmaps-demo` — runtime **Python** legacy (webhooks Wompi antiguos, `server.py`).
  2. `sportmaps-bff-dev` — Node, rama `develop` → `dev.sportmaps.co` (Supabase dev).
  3. `sportmaps-bff-stg` — Node, rama `staging` → `stg.sportmaps.co` (Supabase dev).
  4. `sportmaps-bff-prod` — Node, rama `main` → `app.sportmaps.co` (Supabase prod).
  > ⚠️ **dev y staging comparten el mismo proyecto Supabase**; solo prod está aislado.
  > **Corrección 2026-10-05 (hosts):** `dev.sportmaps.co`, `stg.sportmaps.co` y `app.sportmaps.co` los sirve
  > **Vercel** (frontend; solo reescriben unas rutas, p. ej. el manifest/íconos del PWA, hacia el BFF). El
  > BFF dev se llama por `bffdev.sportmaps.co` / `sportmaps-bff-dev.onrender.com`, y **todo el tráfico a
  > Render pasa por Cloudflare** (también el `.onrender.com` crudo): la IP del cliente sale de
  > `cf-connecting-ip`, no de `req.ip` (ver `docs/gotchas-tecnicos.md`, Control de acceso).
  > **Estado en memoria:** el BFF además expone un WebSocket (`/bridge/ws`, bridges locales de GYM RM y
  > Dreamers) cuyo registro de conexiones vive en memoria de **una sola instancia** — con más de una
  > instancia de Render el aviso `wake` solo llegaría a los bridges conectados a la que atiende el request.
  > Es un requisito a resolver antes de escalar horizontalmente (hoy es una instancia por ambiente).
- **Supabase Cloud = DB + Edge Functions.** 7 funciones Deno en el repo (analyze-receipt, payment-reminders-cron, run-recurring-charges, send-email, send-push-notification, wompi-sign, platform-admin-hook). `wompi-webhook` se retiró el 2026-10-27: el webhook de Wompi lo recibe el BFF (`bff/src/routes/wompi.ts`). `send-push-notification` sigue desplegada y en uso (trigger legacy) hasta que el despachador del BFF entregue de verdad; ver docs/migraciones-pendientes-2026-10-27/LEEME.md. Migraciones aplicadas **manualmente** (no hay job de deploy de DB en CI; único guard: `scripts/migrations.mjs check` sobre el ledger versionado `supabase/migrations_ledger.json` — ver [docs/migrations-workflow.md](migrations-workflow.md)).

### 5.2 Build frontend

- **Vite 5** + plugin-react-swc; `outDir: 'build'` (no `dist`), `manualChunks` para tesseract/pdfjs/react; proxy dev `/api/nominatim`; **puerto dev 3001**. Incluye `lovable-tagger` (herencia de la plataforma Lovable).
- **PWA** via `vite-plugin-pwa` (`injectManifest`, `sw.js`, registro manual).
- **TSConfig**: `tsconfig.app.json` tiene **`strict: false`** y todos los `noUnused*` desactivados → **chequeo de tipos laxo** (contradice el "Zero-Tolerance" del pre-commit).
- Coexisten dos configs ESLint (`eslint.config.js` flat + `.eslintrc.json` legacy) y dos lockfiles (`package-lock.json` + `bun.lockb` huérfano).

### 5.3 Móvil (Capacitor)

- `appId: co.sportmaps.app`, `webDir: 'build'`, plugin PushNotifications (FCM). **Solo Android** inicializado (`frontend/android/` completo); **NO existe `frontend/ios/`** pese al script `cap:ios`. `mobile/` en la raíz es un vestigio Flutter.

### 5.4 Testing

- **Unit (Vitest):** frontend 3 tests (`AuthContext`, `ProtectedRoute`, `usePermissions`); BFF 1 test (`notification.service`). **Cobertura muy baja.**
- **E2E (Playwright):** `e2e/` con `login.spec.ts`, `branding-isolation.spec.ts`.
- **SQL de validación** en `tests/`: `validate_rls_deployment.sql`, `qa_validation_scripts.sql`.
- ⚠️ **Configs de test rotas:** Playwright fija `baseURL 5173` pero Vite corre en **3001**; el step de bundle-size del CI apunta a `dist/` cuando el build emite a `build/` (efectivamente muerto).

### 5.5 Git hooks

Único hook `pre-commit` ("Zero-Tolerance Gatekeeper"): (1) check de timestamps de migraciones, (2) `tsc --noEmit` + `eslint` bloqueantes en frontend, (3) `ruff` en `backend/` Python si existe. ⚠️ El lint local es bloqueante pero en CI es `continue-on-error` → **política inconsistente local vs CI**.

### 5.6 Variables de entorno

- **Frontend** (`.env.example` versionado): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_BFF_URL`, `VITE_WOMPI_PUBLIC_KEY`, `VITE_SENTRY_DSN`… ⚠️ el `.env.example` trae un JWT anon real embebido.
- **BFF**: **NO existe `.env.example`** (deuda). ~35 vars reales (Supabase, Wompi, MP, WhatsApp, LLMs). Los secretos NO están en `render.yaml` (`sync:false` / manuales en dashboard) → riesgo de drift/undocumented.

### 5.7 Contaminación del repo (higiene)

- **frontend/** ~30 archivos basura: `build_output_*.txt`, `lint_*.txt/json` (uno de ~2 MB), **5× `vite.config.ts.timestamp-*.mjs`**, `remote_schema.sql`, `dev-dist/`.
- **bff/**: `tsc_error.log`, `bff_build_err.txt`, SQL sueltos, scripts one-off `list-*.mjs`.
- **raíz**: `frontend_tree.txt`, `temp_commit.patch` (50 KB), `wger_needs_translation.json` (~694 KB), `playwright-report/`, `test-results/`.
- **supabase/**: SQL de depuración manual mezclado con las migraciones reales (`fix_*.sql`, `test_*.sql`, `master_plan.sql` 63 KB), carpetas `temp_manual/`, `archive/`.

---

## 6. Riesgos priorizados (todas las capas)

| # | Riesgo | Capa | Severidad |
|---|---|---|---|
| 1 | **SQL corrupto en la migración maestra** (`schema_refactored.sql:1162/1174`, `CREATE FUNCTION public.EXISTS(...)`): una DB fresca falla al aplicarla | DB | 🔴 Crítica |
| 2 | Service_role bypassa RLS en todo el BFF: un bug de middleware expone datos cross-tenant sin red de seguridad | BFF | 🔴 Alta |
| 3 | **Triple vocabulario de roles** (`profiles.role` / `roles.name` / `school_members.role`) + catálogo duplicado en ≥6 sitios del frontend con listas divergentes → bugs de autorización | DB+FE | 🔴 Alta |
| 4 | Dev y staging comparten proyecto Supabase | Deploy | 🔴 Alta |
| 5 | Dos sistemas de autopay vivos a la vez (legacy + canónico), sin protección de doble cobro más allá de idempotencia | BFF | 🟠 Media-alta |
| 6 | Doble esquema en el repo (`database_schema.sql` obsoleto vs migraciones) confunde la fuente de verdad | DB | 🟠 Media |
| 7 | Auditoría (`audit_trigger_func`) solo cableada a `payments`; enrollments/orders/school_members sin rastro | DB | 🟠 Media |
| 8 | Listados sin paginación (`select('*')`) → degradación a escala | Frontend | 🟠 Media |
| 9 | Falta `bff/.env.example` + secretos fuera de `render.yaml` → config de prod no documentada | Deploy | 🟠 Media |
| 10 | Gates de calidad inconsistentes (strict:false, lint bloqueante local vs `continue-on-error` en CI) | Tooling | 🟠 Media |
| 11 | Colisiones de timestamp en migraciones (orden de aplicación ambiguo) | DB | 🟡 Baja |
| 12 | Configs de test rotas (puerto Playwright, bundle-size CI) + cobertura casi nula (4 unit + 2 e2e) | Tooling | 🟡 Baja |
| 13 | Repo contaminado (>40 artefactos, JSON de 2 MB, timestamps de Vite, lockfile bun huérfano) | Tooling | 🟡 Baja |

---

## 7. Fortalezas destacables

- **Idempotencia robusta** en pagos/webhooks (dedup por `(provider, event_id)`, leases con claim optimista, referencias determinísticas, manejo de `23505`, estado 'orphan' + reproceso).
- **Defensa en profundidad**: CORS con parseo de URL anti-bypass, CSRF por header, rate limiters diferenciados (anti card-testing por user), HMAC en todos los webhooks con re-fetch anti-spoofing, fail-closed con `timingSafeEqual`, `requireOwnership` anti-IDOR, audit log.
- **Cifrado de secretos en reposo** (AES-256-GCM) con claves separadas por dominio.
- **Patrón adapter/factory** extensible (invoicing, shipping).
- **Kill-switches por env** para features de riesgo.
- **Code-splitting exhaustivo** + recuperación de chunks obsoletos post-deploy (SW + ErrorBoundary + preloadError guard coordinados).
- **Comentarios de auditoría trazables** en el código (H-01, R17, decisiones #N).

---

*Documento generado por auditoría automatizada de la rama `develop`.*
