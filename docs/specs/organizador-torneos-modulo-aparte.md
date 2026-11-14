# Torneos: complemento de escuela + rol Organizador (mismo motor)

**Estado:** propuesta, sin código · **Fecha:** 2026-10-27 · **Autor:** sesión de análisis (solo lectura del repo + SELECT puntuales a la base)

> **Enfoque (corrección del usuario, 2026-10-27).** Torneos NO cambia de enfoque. Conviven **dos caminos con el mismo motor**:
>
> 1. **Complemento para escuelas.** El admin lo usa con su misma cuenta, sin otro correo, desde su menú de admin.
> 2. **Rol Organizador**, que ya existe a medias, para quien no es escuela (liga, federación, empresa de eventos, colegio, club externo).
>
> Meta de producto: «ser mucho mejores en todo sentido que Copa Fácil y Star Vivo» y poder vender el camino 2 como **módulo aparte**.
>
> El modelo recomendado es el de **menor cambio**. El organizador también recibe un `school_id`, porque todo el motor ya cuelga de ese campo.

Relacionados: `docs/specs/torneos-en-vivo-multideporte-plan.md`, `docs/specs/torneos-inscripcion-escuela-y-pago-2026-10-15.md`, `docs/specs/torneos-externos-registro-liviano-2026-09-03.md`, `docs/tournaments-decisions.md`.

---

## 1. Estado real hoy

### 1.1 Datos en la base (consultado 2026-10-27, base única `luebjarufsiadojhvxgi`)

| Dato | Valor |
|---|---|
| Perfiles con `profiles.role='organizer'` | **2**. Uno de 2026-04-14 con onboarding sin terminar y 0 eventos. Otro de 2026-07-01 con onboarding hecho y 1 evento. |
| Esos 2 perfiles en `school_members` | **0 membresías** |
| Filas en `event_organizers` | **0**. Ningún organizador terminó el onboarding del BFF. |
| `school_members.role = 'organizer'` | **imposible**: el CHECK `school_members_role_check` solo admite owner/admin/school_admin/coach/staff/parent/athlete/viewer/reporter/super_admin/accountant |
| `events` en total | 14. Hay 13 con `creator_role='school'` y 1 con `creator_role='organizer'` («Copa Demo SportMaps 2026», `school_id NULL`, active/public, creado el 2026-07-01). |
| `events.organizer_id` no nulo | **0** |
| Escuelas con el complemento `tournaments` | **31**. Todas con `monthly_price_cents = 0`: nadie paga hoy por Torneos. |
| `events_creator_role_check` | `creator_role IN ('school','organizer')` |
| `events_school_owner_requires_school_id` | `creator_role <> 'school' OR school_id IS NOT NULL` (NOT VALID) |
| `schools_school_type_check` | academy, club, federation, institute, personal_trainer, association, hybrid, gimnasio, escuela, venue. **No existe `organizer`.** |
| `schools` por tipo | Hay federation 79, institute 62 y association 10, **todas sin dueño ni miembros**: son filas de directorio importadas. Hay personal_trainer 13, todas con dueño: es el precedente que sirve, ver §3. |
| `school_subscriptions.plan_code` CHECK | starter, start, crecimiento, profesional, elite, enterprise |
| `school_subscriptions.billing_cycle` CHECK | monthly, quarterly, semiannual, annual. **Coincide con los ciclos que ofrece Copa Fácil.** |

### 1.2 Lo que tiene construido el organizador

**Frontend**, unas 4.400 líneas en `frontend/src/pages/organizer/*` y `frontend/src/components/organizer/*`:

- Rutas `/organizer/{onboarding,dashboard,profile,create-event,event/:id,events,finances,calendar,reports,settings}` detrás de `OrganizerGuard` (`frontend/src/App.tsx:1135-1146`).
- Menú propio (`frontend/src/config/navigation.ts:863-885`): Dashboard, Crear Evento, Mis Eventos, Calendario, Finanzas, Reportes, Perfil, Configuración.
- Permisos en `frontend/src/config/routePermissions.ts:173-182`.
- Wizard de creación de 5 pasos (`components/organizer/wizard/Step1..Step5`), más las pestañas Delegaciones y Documentos (`EventDelegationsTab.tsx`, `EventDocumentsTab.tsx`).
- Se elige como rol en `RoleSelection.tsx:32` y en `OnboardingRolePage.tsx:20,31`, que redirige a `/organizer/onboarding`.

**BFF:** `bff/src/routes/organizers.route.ts` (perfil POST/PUT, `stats`, `finances`) y los handlers del organizador en `bff/src/routes/events.route.ts` (`/mine` :86, `POST /` :118, `preview` :1600, `publish` :1629, `PUT /:id` :1746, `status` :1784, `delegations` :1843/:1909).

**Base:** `complete_role_selection` acepta `organizer`. `handle_new_user` manda a `organizer` por el camino «elige rol después» (queda athlete + `needs_role`) y **no le crea entidad**.

### 1.3 Por qué hoy no funciona de punta a punta (bloqueantes, en orden)

1. **El BFF rechaza al organizador en todas sus rutas.** `requireAuth` exige una fila activa en `school_members` (`bff/src/middlewares/authMiddleware.ts:150-190`). Sin membresía responde 403 «No tienes permisos para acceder a esta escuela». Además, `requireRole('organizer')` compara contra `school_members.role`, y ese CHECK no admite `'organizer'`. Por eso **ninguna ruta `requireRole('organizer')` puede pasar nunca**. Así se explica que `event_organizers` tenga 0 filas: el `POST /api/v1/organizer/profile` del onboarding (`OrganizerOnboardingPage.tsx:95`) devuelve 403.
2. **El `POST /api/v1/events` del organizador está desincronizado con la base** (`events.route.ts:118-230`). No envía `creator_id`/`creator_role`, que son NOT NULL. Inserta `bank_data` (:173). Usa `organizer_id = event_organizers.id` cuando el FK real apunta a `profiles`. Para las categorías usa nombres viejos (`min_age` :200, en lugar de `age_min`, etc.). Ya estaba anotado en la memoria del 2026-07-14 y sigue igual.
3. **Al terminar el onboarding navega a `/organizer/home`** (`OrganizerOnboardingPage.tsx:118,143,191`), una ruta que no existe.
4. `RoleSelection.tsx:62` apunta a `organizer-register`, una ruta que tampoco existe.
5. `OrganizerGuard.tsx:25-28` lee `event_organizers`. Como está vacía, todo organizador termina en el onboarding roto.
6. El motor nuevo (en vivo, fixture, inscripciones, catálogo, y lo que construyen los 4 agentes) **solo se alcanza con `school_id`**. Los ejemplos son `ownedEvent` (`bff/src/routes/tournament-live.route.ts:46-54`, que exige `ev.school_id === req.schoolId` y `creator_role === 'school'`), `assertOwnedSchoolTournament` (`events.route.ts:546-555`) y la compuerta `has_tournaments` (`events.route.ts:294-313`). A esto se suma que las rutas `/school/tournaments*` del frontend permiten solo `['school','admin','school_admin']` (`App.tsx:676-690`).
7. **El único evento del organizador** se creó directo desde el cliente: `useEvents.createEvent` (`frontend/src/hooks/useEvents.ts:39-50`) hace un `insert` a `events` con `creator_role='organizer'` y sin `school_id`. Quedó fuera del motor: no tiene fixture, ni en vivo, ni complemento.

**Conclusión:** el organizador tiene **pantallas, pero no tiene entidad**. Sin `school_id` no puede usar nada del motor nuevo, y el motor viejo que sí le pertenece está roto en tres capas (middleware, esquema y rutas).

### 1.4 El camino escuela (complemento) hoy

- El menú tiene «Mis Torneos» en Gestión Deportiva, visible solo con el complemento (`navigation.ts:212`, `addon: 'tournaments'`). También existe el acceso rápido `tournaments` (`config/quickActionsCatalog.ts:51`).
- Pantallas: `pages/school/SchoolTournamentsPage.tsx`, `CreateTournamentPage.tsx` (compuerta `hasAddon('tournaments')` en :89) y `SchoolTournamentDetailPage.tsx`, junto con los componentes de `components/tournaments/*` (LiveScorer, FixtureGenerator, ResultsPanel). Las páginas públicas son `/torneo/:slug/en-vivo` y `/torneo/:slug/tv` (`App.tsx:428-429`).
- Precio en el catálogo: $49.000/mes, incluido en elite/enterprise (`frontend/src/config/saas-plans.ts:265-272`). En la práctica las 31 escuelas lo tienen a $0.
- Funciona con la misma cuenta del admin: `requireAuth` resuelve `req.schoolId` desde `school_members` o desde `x-school-id`. **Ese camino ya cumple el requisito «sin otro correo».**

### 1.5 RLS de `events`: observaciones que ya existían (no las introduce esta spec)

- `events_all_access` es `FOR ALL` sin `WITH CHECK` (USING `creator_id = auth.uid() OR is_platform_admin()`). Esto choca con la **I3**: quien creó un evento puede hacerle UPDATE y apuntar su `school_id` a otra escuela.
- `events_select_authenticated` es `USING (true)`, así que cualquier usuario autenticado lee eventos `school_only` y borradores. No viola la I1, porque anon no tiene acceso, pero es una fuga de privacidad de los torneos internos.
- `event_organizers.organizer_manage_own_profile` es `FOR ALL` para `public` sin `WITH CHECK`. Como el USING es `profile_id = auth.uid()`, el riesgo es bajo.
- **Corregirlas en F1** (§6), con su `npm run seguridad:invariantes`.

---

## 2. Brechas

### 2.1 Organizador sin escuela, de punta a punta

| # | Brecha | Hoy |
|---|---|---|
| B1 | **Entidad propia**: crear la organización de forma transaccional al registrarse | No existe. `handle_new_user` no crea nada para el organizador. |
| B2 | Que el BFF lo reconozca: membresía en su entidad | 403 en todas las rutas |
| B3 | Usar el **mismo** creador, fixture, en vivo, inscripciones y página pública que la escuela | Solo existe con `school_id` + `creator_role='school'` |
| B4 | Inscribir **equipos externos**: clubes y colegios que no están en SportMaps | Existe el registro liviano (`torneos-externos-registro-liviano`). Equipos externos, logos y jugadores: **en curso (agente datos)**. |
| B5 | Cobrar la inscripción **en línea** a cada equipo o jugador | Solo existe el pago manual registrado por el anfitrión. Falta el adaptador de la pasarela a `event_delegation_payments` (pendiente desde julio). |
| B6 | Cobrarle **al organizador** por el plan | Falta el plan y sus límites. La facturación SaaS sí existe, ver §4.4. |
| B7 | Onboarding corto (nombre, deporte, ciudad, logo) que termine en «crea tu primer torneo» | El onboarding actual está roto (§1.3) |
| B8 | Equipo de trabajo: coorganizadores y anotadores | Ya existen anotadores por token (`tournament_scorekeepers`). Para coorganizar se invita como `admin` a la entidad, con la misma tabla que usa la escuela. |
| B9 | Perfil público del organizador (página de la liga con todos sus torneos) | No existe. Página del torneo: **en curso (agente público)**. |
| B10 | Mi plan / facturas para un rol no-escuela | `/mi-plan` ya permite `organizer` (`App.tsx:755`), pero no tiene entitlements que leer |

### 2.2 Escuela con complemento

| # | Brecha |
|---|---|
| E1 | Torneos está escondido como **un ítem más** dentro de Gestión Deportiva. Para un módulo que se vende aparte, le falta su lugar propio: grupo de menú, inicio y accesos (ver §2.3). |
| E2 | Sin complemento el ítem **desaparece**. No hay forma de descubrirlo ni de pedirlo. |
| E3 | No hay inicio de torneos («hoy juegan», «en vivo ahora», «inscripciones por aprobar»). |
| E4 | El precio de $49.000 nunca se cobró (31 escuelas a $0). |

### 2.3 Cómo debe verse en el frontend del admin de la escuela

**Menú:** Torneos pasa a ser un **grupo propio** (fuera de Gestión Deportiva), justo debajo de Inicio cuando la escuela tiene el complemento:

```
Torneos                         (ícono Trophy; contador = partidos en vivo ahora)
  ├─ Inicio de torneos          /school/tournaments            (panel, ver abajo)
  ├─ Crear torneo               /school/tournaments/new        (asistente de 4 pasos del agente deportes)
  ├─ Inscripciones              /school/tournaments?tab=inscripciones  (por aprobar / por pagar)
  ├─ En vivo                    /school/tournaments?tab=vivo   (anotar, enlaces de anotador)
  ├─ Patrocinadores             /school/tournaments?tab=patrocinadores (agente datos)
  └─ Torneos donde participo    /school/delegations            (inscripciones de la escuela en torneos ajenos)
```

- **Sin complemento:** el grupo aparece como un único ítem «Torneos» con un candado. Al abrirlo se ve una página de venta con video y captura, el precio y el botón «Probar 30 días» (o «Pedir activación» mientras no haya autoservicio). Esto se hace con la misma lógica `addon` de `navigation.ts`, mostrando el bloqueo en lugar de ocultar el ítem.
- **Inicio de torneos (panel):** tarjetas con *En vivo ahora*, *Hoy juegan* (con su cancha), *Por aprobar*, *Por cobrar* y *Próximo torneo*. Debajo, la lista de torneos con su estado (borrador, inscripciones, en curso, terminado) y accesos directos a «Compartir enlace», «Abrir marcador» y «Ver página pública».
- **Inicio general de la escuela:** una tarjeta «Torneos» que solo aparece si hay un torneo activo. El acceso rápido `tournaments` ya existe en `quickActionsCatalog.ts:51`; agregar `tournament_live` («Anotar partido») y `tournament_new`.
- **Misma cuenta:** se mantiene la regla del 10-15. Inscribe y administra quien tiene `user_admin_school_ids()`. El entrenador puede ser anotador por token, pero no administra.

---

## 3. Modelo de datos (recomendado: menor cambio)

### Recomendación: la organización organizadora **es una fila de `schools`** con `school_type = 'event_organizer'`

Ya hay un precedente idéntico en producción: el **personal_trainer**. Es dueño de su propia fila en `schools` (`school_type='personal_trainer'`, 13 filas, todas con `owner_id`) y el BFF lo resuelve en `requireTrainerAuth` (`authMiddleware.ts:439-505`).

Cómo queda:

- La organización es una fila en `schools(school_type='event_organizer', owner_id=<perfil>)`.
- El usuario tiene `school_members(role='owner', status='active')`. Con eso, `requireAuth` encuentra `req.schoolId` sin tocar el middleware. Como `owner` está en `PRIVILEGED_ROLES` (`authMiddleware.ts:51`), pasa **todas** las rutas `requireRole('school','school_admin')` del motor.
- `profiles.role` sigue en `'organizer'`. Decide **qué menú y qué inicio** ve el usuario. No decide permisos: los permisos salen de la membresía, como en el resto del sistema.
- Los coorganizadores entran como `school_members(role='admin')` por la invitación que ya existe. `can_manage_event()` e `is_school_admin_of()` ya aceptan owner/admin/school_admin, así que **no se toca RLS**.
- Planes y facturación: `school_subscriptions` + `school_addons` + `v_school_entitlements` + `run_saas_billing_cycle`, todos **sin cambios estructurales**.
- `has_academy` da `false` para `event_organizer`, porque ese tipo no está en la lista de la vista. Así no le aparecen los módulos de academia.

### Por qué no una tabla nueva `organizations`

| | `schools` + tipo (recomendado) | Tabla nueva `organizations` |
|---|---|---|
| Cambio en el motor y en los 4 agentes | **Ninguno**: todos asumen `school_id` | Cada tabla y ruta de torneo necesitaría un dueño polimórfico (`school_id` o `organization_id`) |
| RLS | Reusa `user_admin_school_ids()`, `can_manage_event`, `is_school_admin_of` | Hay que duplicar helpers y policies. Mucho riesgo de I1/I2. |
| Facturación SaaS | Reusa todo | Habría que rehacer suscripciones, facturas y ciclo |
| Pasarela de cobro de inscripciones | Reusa `school_payment_providers` / Wompi / MP por escuela | Habría que rehacerla |
| Contras | `schools` sigue creciendo como «entidad genérica». Cada pantalla o reporte que cuente «escuelas» debe filtrar `school_type`. | Modelo más limpio |
| Una liga que luego abre academia | Pasa a `hybrid`, en la misma fila | Migración de datos |

**Contras a vigilar en el modelo recomendado:**

1. Los conteos y KPIs de «escuelas» (panel de super admin, métricas, Explorar) deben excluir `event_organizer`.
2. `school_is_operational()` y el bloqueo de fin de prueba deben responder bien al tipo nuevo.
3. Las vistas públicas de escuela no deben listar organizadores como academias.

### Qué pasa con lo viejo

- **`event_organizers` (0 filas):** se **retira** (queda sin uso). NIT, ciudad, logo, deportes, datos bancarios y WhatsApp pasan a `schools` / `school_settings` / `school_payment_providers`, que ya existen para la escuela. Antes hay que verificar qué columnas faltan en `schools` (por ejemplo `nit`).
- **`events.organizer_id`:** queda NULL siempre. Se documenta como legado.
- **`creator_role`:** los torneos de una organizadora se guardan con `creator_role='organizer'` + `school_id=<org>`, para distinguirlos en reportes y comisiones. **Único cambio de código en el motor:** los dos helpers de propiedad (`ownedEvent` en `tournament-live.route.ts:46-54` y `assertOwnedSchoolTournament` en `events.route.ts:546-555`) se unifican en uno solo, `ownsEvent(eventId, schoolId)`. Ese helper compara `school_id = req.schoolId AND creator_role IN ('school','organizer')`. *Alternativa de cero cambios:* guardarlos como `creator_role='school'` y distinguir por `schools.school_type`. Funciona, pero confunde. Se recomienda el helper.
- **El evento huérfano «Copa Demo SportMaps 2026»** (`school_id NULL`): se le asigna a la organización demo o el usuario decide qué hacer con él. No se borra por iniciativa propia.
- **Las 79 federaciones y 62 institutos de directorio sin dueño:** se pueden ofrecer como **«reclamar perfil»**. Una federación real toma su fila, la pasa a `event_organizer` u `hybrid` y hereda su página. Es un diferencial (§5.2).

### Cómo encaja el trabajo de los 4 agentes

Todo lo que hoy cuelga de `events.school_id` (equipos externos, patrocinadores, copas, planilla, carnés con QR, página pública, embed, en vivo, presets por deporte) **funciona sin cambios** para la organizadora. La única condición es que los agentes usen el helper de propiedad unificado y no comparen `creator_role === 'school'` a mano. **Pedido concreto a los 4 agentes: no escribir `creator_role === 'school'` en rutas nuevas; usar el helper.**

---

## 4. Producto y precio (decide el usuario)

Supuesto de cambio: **US$1 ≈ COP 4.000**. Referencia: Copa Fácil cobra US$6/mes (≈ $24.000) en el plan a medida y US$10,30/mes (≈ $41.000) en el Pro ilimitado, con ciclos mensual, trimestral, semestral y anual.

### 4.1 Qué NO se cobra nunca

- Ver la página pública, el marcador en vivo, la TV, los resultados y el embed básico.
- Seguir un torneo o equipo y recibir notificaciones (familias y aficionados).
- Que un equipo o jugador **se inscriba** (lo paga el organizador si quiere cobrar inscripción, no SportMaps).
- Anotadores por enlace, cantidad de partidos, cambio de deporte.
- Las escuelas **participantes** (inscribirse en torneos ajenos sigue siendo gratis, como hoy).

### 4.2 Opciones para el **Organizador** (camino 2)

**Opción A: «Gratis de verdad + 2 planes» (recomendada)**

| Nivel | COP/mes | USD/mes | Anual (−17%) | Qué incluye |
|---|---|---|---|---|
| **Gratis** | $0 | 0 | — | 1 torneo activo, hasta 12 equipos, página pública con marca SportMaps, marcador en vivo, planilla, compartir. Supera el plan gratis de Copa Fácil. |
| **Organizador** | **$29.000** | ~7,3 | $24.000/mes | Torneos ilimitados, equipos ilimitados, 300 jugadores con carné y QR, 5 patrocinadores, artes para redes, link propio `sportmaps.co/t/<liga>`, sin anuncios, informes. Compite contra los US$6 de Copa Fácil: casi el mismo precio con más funciones. |
| **Liga Pro** | **$69.000** | ~17 | $57.000/mes | Todo lo anterior, más jugadores y patrocinadores ilimitados, cobro de inscripción en línea, embed sin marca, API JSON, importar planillas en Excel, coorganizadores ilimitados, reporte para patrocinadores, ranking entre torneos. Compite contra los US$10,30 de Copa Fácil: cuesta más, pero cobra en línea (Copa Fácil no lo hace). |
| Federación / Custom | desde $549.000 | a medida | a medida | Se alinea con «Federación Pro» de la landing v3.0: muchos clubes, multi-sede, SLA |

**Comisión (opcional, recomendada):** del 3% al 5% sobre las inscripciones **cobradas en línea por SportMaps**, que paga quien se inscribe como «costo de servicio». En Liga Pro baja al 2%. No hay comisión sobre pagos manuales o en efectivo.

**Opción B: «Por torneo»** (estilo empresa de eventos). Gratis hasta 8 equipos. **$99.000 por torneo** (≈ US$25) con todo incluido durante 90 días, o el plan anual Liga Pro a $690.000. Sirve para quien hace 1 o 2 eventos al año. Para ligas recurrentes es más caro y más difícil de recaudar.

**Opción C: «Freemium + solo comisión».** Todo gratis, ganancia solo por la comisión del 5% al 7% sobre inscripciones en línea, más Pro de $49.000 para quitar la marca y usar la API. Es la que más adopción genera, pero el ingreso depende de que el organizador cobre en línea. Hoy esa pasarela de inscripciones no existe (B5).

**Recomendación: A + comisión.** El plan Organizador a $29.000 vence a Copa Fácil en valor percibido sin regalar el producto. El cobro en línea con comisión es lo que Copa Fácil no puede ofrecer. Prueba gratis: **30 días de Liga Pro sin tarjeta**, coherente con la regla global; al vencer baja a Gratis sin perder datos («nadie pierde acceso»).

### 4.3 Camino 1: **complemento de la escuela**

- **Recomendación:** que el complemento Torneos sea **equivalente a «Organizador»** y cueste **$29.000/mes** ($49.000 en el catálogo actual, `saas-plans.ts:269`). Que siga incluido en Elite/Enterprise. Quien necesite cobro en línea de inscripciones externas o API sube a «Torneos Pro», a $59.000.
- Las 31 escuelas que lo tienen a $0 **se quedan como están** (grandfathering). El precio aplica a altas nuevas.
- Regla de no duplicar: una escuela **nunca** compra el plan de organizador. Compra el complemento sobre su misma suscripción.

### 4.4 Cómo se cobra en cada camino (con lo que ya existe)

| | Escuela (complemento) | Organizador (plan) |
|---|---|---|
| Fila de suscripción | La `school_subscriptions` de su escuela (ya existe) | La `school_subscriptions` **de su fila `event_organizer`**: el mismo mecanismo |
| Qué se factura | `school_addons(addon_key='tournaments', monthly_price_cents)`. La factura ya suma los complementos encendidos con precio > 0 (`line_items`, mig `20260929183752`). | `plan_code` del organizador. Requiere ampliar el CHECK con `org_free / org_organizador / org_pro` y el `CASE` de `generate_school_subscription_invoice`. **Alternativa sin tocar el CHECK:** `plan_code='starter'` + complemento `tournaments` con su precio por nivel en `monthly_price_cents`. |
| Ciclo | `run_saas_billing_cycle` (job diario del BFF, `bff/src/jobs/saas-billing-cycle.job.ts`), ciclos monthly/quarterly/semiannual/annual (CHECK vigente) | Igual |
| Precio acordado | `custom_price_cents` / `school_billing_schedule` / `school_one_time_charges` (mig `20261015124518`) | Igual. Útil para la opción B (cobro único por torneo = `school_one_time_charges`). |
| Cómo paga hoy | Factura `school_subscription_invoices` (PDF, correo, WhatsApp vía `saasInvoicing.service.ts`). Se paga por **transferencia o Bre-B y la concilia el super admin** (`platform-invoicing.routes.ts:107`, `mark-paid`). | Igual |
| Pago con tarjeta / PSE de la factura SaaS | `MiPlanPage.tsx:700` dice «Paga con PSE, Nequi o tarjeta vía Wompi», **pero en este worktree no encontré ese flujo para facturas SaaS**: solo hay `cobro-factura-publica.routes.test.ts`, sin su ruta. Antes de prometerlo en la venta, verificarlo o construirlo en F1. | Igual |
| Inscripciones que cobra el organizador a los equipos | No pasa por SaaS. Usa la pasarela de la propia entidad (`school_payment_providers`, Wompi/MP) con un adaptador nuevo a `event_delegation_payments` (B5). La comisión se registra en ese momento. | Igual |

---

## 5. «Mucho mejores en todo sentido»

Leyenda: **Hoy** = en develop · **Agente** = en construcción ahora (datos / público / vivo / deportes) · **Falta** = no empezado. Lo de Copa Fácil y Star Vivo sale de su oferta pública y de lo que trajo el usuario. **Star Vivo no fue auditado a fondo, así que su columna hay que verificarla antes de usarla en material de venta.**

| Capacidad | Copa Fácil | Star Vivo | SportMaps |
|---|---|---|---|
| Crear torneo (liga/copa/grupos) | Sí | Sí | **Hoy** (liga, copa, grupos, americano) + asistente de 4 pasos (**Agente deportes**) |
| Inscripción **y pago en línea** de equipos | No (manual) | a verificar | Inscripción **Hoy**. Pago manual **Hoy**. Pasarela **Falta** (B5). |
| Equipos externos (fuera de la plataforma) | Sí | Sí | Registro liviano **Hoy** + logos (**Agente datos**) |
| Jugadores / planilla | Sí (300-900 según plan) | Sí | **Agente datos** (jugadores, planilla) + planilla de juego (**Agente deportes**) |
| Carnés con QR de validación | No | a verificar | **Agente datos** |
| Validación de edad por documento | No | No | **Falta**: con el carné y la fecha de nacimiento ya guardada para atletas de escuelas |
| Calendario / fixture | Sí | Sí | **Hoy** (sorteo configurable, canchas) |
| Anotador | Planilla | Sí | **Hoy** (`LiveScorer`, anotadores por token, registro de acciones) |
| Tiempo real | Parcial | Sí (su fuerte) | **Hoy** (motor en vivo) + seguir partidos (**Agente vivo**) |
| Página pública | Sí | Sí | **Hoy** `/torneo/:slug/en-vivo`, `/tv` + página estilo Star Vivo (**Agente público**) |
| Compartir / artes para redes | Sí (plan pago) | Sí | Tarjeta para compartir (**Agente vivo**). Artes por plantilla: **Falta**. |
| Patrocinadores | 3-12 según plan | a verificar | **Agente datos**. Reporte para el patrocinador: **Falta**. |
| Estadísticas | Goleadores, tabla | Sí | Tabla y goleadores **Hoy**. Stats por jugadora y MVP: **Agente vivo**. |
| Comentarios / medios | Videos 2 min, HD | Sí | **Agente vivo** (comentarios/medios) |
| Notificaciones | Limitadas | a verificar | Despachador unificado push + correo **Hoy**. WhatsApp: **Hoy** para escuelas. |
| Embed / API | Embed + API JSON (Pro) | a verificar | Embed (**Agente público**). API JSON: **Falta** (F2). |
| Multideporte | Sobre todo fútbol | Varios | Presets para ~19 deportes + atletismo por marca (**Agente deportes**). Arquetipos de puntuación juzgada (cheer/gimnasia) en `docs/tournaments-scoring-engine.md`: **Falta**. |
| Idioma | Español | a verificar | Español **Hoy**. Inglés y portugués: postergado. |
| App | Web | App | PWA instalable **Hoy**. Capacitor / Play: en curso aparte. |
| Ecosistema escuela ↔ torneo | No existe | No existe | **Hoy**: la escuela inscribe su roster real con un clic y la familia recibe el aviso y el cobro |

### 5.1 Diferenciales que solo SportMaps puede tener (porque ya tiene escuelas, familias y pagos)

1. **Inscripción con pago en línea** de equipos y jugadores, con abonos, depósito que reserva el cupo y la regla «sin pago no entra al fixture» (`payment_gates_approval`, que ya existe).
2. **Comisión por inscripción como ingreso** (§4.2) y liquidación al organizador, con su recibo.
3. **Roster verificado:** las escuelas de SportMaps inscriben atletas reales con su documento y su fecha de nacimiento. La **validación de edad** por categoría es automática y el carné QR funciona en la cancha.
4. **Historial del deportista entre torneos:** partidos, goles, MVP y medallas quedan en su perfil y en su informe mensual. Ninguna plataforma de torneos sueltos tiene esto.
5. **Ranking nacional por deporte y categoría** a partir de todos los torneos publicados (en la línea del ranking PWR del roadmap).
6. **Árbitros y jueces:** asignación por partido, planilla firmada y **pago al árbitro** desde el mismo sistema (D5 de `tournaments-decisions.md`).
7. **Boletería y streaming:** venta de entradas con QR (reusa el patrón del torniquete y el control de acceso) y transmisión enlazada al marcador en vivo.
8. **IA que arma el calendario por canchas y horarios:** restricciones de cancha, descanso mínimo y que no se crucen equipos de la misma escuela. Puede reusar Reservas para bloquear las canchas.
9. **Reporte para patrocinadores:** impresiones de la página, vistas en vivo y alcance de lo compartido, en PDF de una página para renovar el patrocinio.
10. **Embudo de captación para escuelas:** cada torneo de una organizadora invita a clubes que no están en SportMaps, y esos clubes son clientes potenciales del producto Academia (crecimiento viral).
11. **Reclamar perfil de federación o liga** (las 79 + 62 + 10 filas de directorio): la organización llega con su página ya armada.
12. **Mapi / WhatsApp:** «¿a qué hora juega mi hija?» respondido por el bot con el fixture real.

---

## 6. Plan por fases (plan antes de código: aquí no hay SQL)

### F0: vender ya, con alta asistida (≈ 1 a 1,5 semanas)

Objetivo: el primer organizador pagando, sin autoservicio.

- **Migración 1:** ampliar `schools_school_type_check` con `'event_organizer'`. Revisar que `v_school_entitlements.has_academy` y `school_is_operational()` den lo correcto para el tipo nuevo. Solo lectura de catálogo puntual; una sola DDL.
- **Alta asistida por el super admin:** crear la fila `schools(event_organizer)` + `school_members(owner)` + `school_subscriptions` + `school_addons(tournaments, precio)`. Mejor aún, una **RPC transaccional** `admin_create_organizer_org`, por la regla de creación multi-fila.
- **BFF:** helper único `ownsEvent` en `tournament-live.route.ts` y `events.route.ts`, que acepte `creator_role IN ('school','organizer')`. La creación de torneo pone `creator_role='organizer'` cuando `schools.school_type='event_organizer'`. Avisar a los 4 agentes.
- **Frontend:**
  - Agregar `'organizer'` a `allowedRoles` de `/school/tournaments*` y `/school/delegations`.
  - El menú del organizador (`navigation.ts:863-885`) apunta a esas mismas pantallas: Inicio de torneos, Crear torneo, Inscripciones, En vivo, Patrocinadores, Mi plan, Configuración.
  - `OrganizerGuard` deja de leer `event_organizers` y pasa a mirar si existe la membresía `owner`.
  - Las páginas viejas `/organizer/*` redirigen a las nuevas (sin borrarlas, a la espera de la decisión del usuario).
- **Escuela:** grupo de menú «Torneos» con inicio y la versión con candado (§2.3).
- **Precio:** usar `custom_price_cents` o el precio del complemento. Cobro por transferencia o Bre-B (lo que ya funciona).

### F1: autoservicio y cobro en línea (≈ 3 a 4 semanas)

- **Registro de organizador:** RPC transaccional `create_organizer_org` (fila en `schools` + membresía + suscripción en prueba, en una sola transacción, con `search_path` y `GRANT EXECUTE` explícito) llamada desde un onboarding nuevo de 3 pasos (nombre, deporte y ciudad, logo) que termina en «crea tu primer torneo». Arreglar `RoleSelection.tsx:62` y quitar `/organizer/home`.
- **Migración 2:** códigos de plan del organizador (`org_*`) en el CHECK de `plan_code` y en el `CASE` de `generate_school_subscription_invoice`, o la alternativa con complemento por nivel (decisión D3).
- **Límites del plan en el BFF** (torneos activos, equipos, jugadores, patrocinadores) en modo `audit → soft → enforce`, con la regla de que nadie pierde acceso.
- **Pasarela de inscripciones:** adaptador de Wompi/MP a `event_delegation_payments` + registro de la comisión (migración 3: columnas de comisión o una tabla de liquidación).
- **Pago de la factura SaaS** con Wompi (verificar §4.4) para que la prueba pueda convertirse sola.
- **Migración 4 (seguridad):** cerrar `events_all_access` con `WITH CHECK`, reemplazar `events_select_authenticated USING(true)` por la visibilidad real (`school_only` → miembros) y retirar la policy de `event_organizers`. Antes, medir el radio y listar todas las policies de `events`. Después, correr `npm run seguridad:invariantes`.
- **Retirar `event_organizers`** y el `POST /api/v1/events` viejo (decisión D5). Excluir `event_organizer` de los conteos de «escuelas».

### F2: diferenciales (≈ 6 a 10 semanas, por prioridad)

Página pública de la organización y reclamo de perfil de federación · API JSON + embed sin marca · reporte para patrocinadores · historial del deportista y ranking nacional · árbitros y su pago · IA de calendario por canchas (con Reservas) · boletería con QR · validación de edad automática · artes para redes por plantilla · inglés y portugués cuando se retome i18n.

Disk IO: una sola sesión aplica las migraciones. `types.ts` se regenera una vez al final de cada lote.

---

## 7. Decisiones que necesita el usuario

| # | Decisión | Recomendación |
|---|---|---|
| D1 | Modelo de la organización | **Fila de `schools` con `school_type='event_organizer'`** (precedente del personal_trainer). No crear tabla nueva. |
| D2 | Precio del organizador | **Opción A**: Gratis / Organizador $29.000 (~US$7) / Liga Pro $69.000 (~US$17), −17% anual, prueba de 30 días de Liga Pro sin tarjeta |
| D3 | Cómo representarlo en la facturación | Códigos `org_*` en `plan_code` (más claro para reportes). Si se quiere cero DDL en F0, usar el complemento `tournaments` con precio por nivel. |
| D4 | Comisión sobre inscripciones en línea | **Sí: 4% (2% en Liga Pro)**, la paga quien se inscribe. Nada sobre pagos manuales. |
| D5 | Destino de `/organizer/*` viejo, `event_organizers` y `POST /api/v1/events` | Redirigir en F0 y retirar en F1. El usuario confirma antes de borrar. |
| D6 | Precio del complemento para escuelas nuevas | **$29.000/mes** (igual a Organizador). Las 31 actuales siguen a $0. Sigue incluido en Elite. |
| D7 | Torneos sin complemento en el menú de la escuela | **Mostrar con candado** y una página de venta, en lugar de ocultarlo |
| D8 | Evento huérfano «Copa Demo SportMaps 2026» y los 2 perfiles organizer | Asignarlos a una organización demo. No borrar nada. |
| D9 | ¿Se promete pago de factura SaaS con tarjeta o PSE? | No prometerlo hasta verificar o construir el flujo (§4.4) |
