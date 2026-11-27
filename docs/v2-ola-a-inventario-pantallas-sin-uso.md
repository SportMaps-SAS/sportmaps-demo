# V2 · Ola A — inventario de pantallas sin uso

**Fecha:** 2026-11-26 · **Plan:** `docs/plan-paridad-y-v2-2026-11.md` §3 (ola V2-A).
**Fuente de uso:** `ui_usage_daily`, vistas por ruta del 2026-11-17 al 2026-11-26, sin usuarios internos. Una pantalla aparece aquí si NO está en la lista de 65 rutas con visitas.
**Fuente de rutas:** `frontend/src/App.tsx` (rutas internas). Menús: `frontend/src/config/navigation.ts` (árboles `school` y `school_admin` separados, ver memoria `project_dos_arboles_de_menu`), `components/navigation/MobileBottomNav.tsx` y las pestañas «Más» de la V2 (`components/coach/v2/coachMasModel.ts`, `pages/ParentMorePage.tsx`, `components/athlete/v2/AthleteMorePage.tsx`).

Quedan fuera las rutas públicas (auth, onboarding, checkout, enlaces con token `/p` `/e` `/c` `/r` `/s` `/cert` `/jugada` `/torneo/:slug…`, `/salud/invitacion/:token`), las de `/admin/*` y las legales. También quedan fuera `/trainer/onboarding`, `/organizer/onboarding`, `/setup/school` y `/parent-checkout`, porque son onboarding o checkout.

## Cómo leer las decisiones

- **FUSIONAR → X:** la pantalla pasa a ser una sección o pestaña de la pantalla V2 X. La ruta vieja queda como redirección.
- **RETIRAR:** sale del menú detrás de un flag y se borra a los 30 días sin reclamos. Si la ruta es solo un alias o una redirección, se borra directamente.
- **MIGRAR:** se rediseña como pantalla propia en V2.
- **YA V2:** la pantalla ya tiene el diseño actual y no hay trabajo de migración. Se vuelve a medir en la próxima ola.
- **⚠ crítica:** una pantalla de uso bajo por naturaleza, o de un cliente que la tiene activa. No se retira aunque tenga cero visitas.

Gates que aparecen en las tablas:
- `MG:<key>`: `ModuleGate`. Es un módulo del menú que el super admin prende o apaga por escuela. Solo aplica a los roles `school` y `school_admin`.
- `addon:<k>`: addon comercial que viene en `v_school_entitlements`.
- `Store`: `StoreGate`, que depende del flag global `store_enabled()`.
- `VITE_*`: bandera horneada en el build.

Los clientes salen de la memoria del proyecto: `project_uso_escuelas_mensual_2026_11_17`, `project_uso_real_3m_2026_10_30`, `project_electronic_invoicing`, `project_auditoria_contabilidad_tienda_2026_10_02`, `project_torneos_escuela_inscribe_y_gratis` y `project_dead_modules_roles_audit`.

---

## 1. Escuela — dinero y cuenta

| # | Ruta | Componente | Roles y menú | Gate | Estado | Decisión |
|---|---|---|---|---|---|---|
| 1 | `/accounting` | `pages/AccountingPage.tsx` | school, school_admin, accountant. Menú: Finanzas › Contabilidad (los dos árboles) y el árbol `accountant` | `addon:accounting` + `MG:finanzas_contabilidad` | Real, con datos | **FUSIONAR → «Contabilidad» V2** (las 5 de contabilidad en una pantalla con pestañas). ⚠ crítica: **Monster** es la única escuela con el addon prendido (desde 10-13). Es diferencial frente a LUDMO+ |
| 2 | `/accounting/suppliers` | `pages/AccountingSuppliersPage.tsx` | igual que #1 | igual que #1 | Real (CxP) | **FUSIONAR → Contabilidad V2** (pestaña Proveedores) |
| 3 | `/accounting/payroll` | `pages/PayrollPage.tsx` | igual que #1 | igual que #1 | Real (nómina CO) | **FUSIONAR → Contabilidad V2** (pestaña Nómina) |
| 4 | `/accounting/reports` | `pages/AccountingReportsPage.tsx` | igual que #1 | igual que #1 | Real (P&L) | **FUSIONAR → Contabilidad V2** (pestaña Estado de resultados) |
| 5 | `/accounting/budget` | `pages/AccountingBudgetPage.tsx` | igual que #1 | igual que #1 | Real | **FUSIONAR → Contabilidad V2** (pestaña Presupuesto) |
| 6 | `/facturacion-electronica` | `pages/InvoicingStandalonePage.tsx` (envoltorio de `InvoicingTab`) | school, school_admin. Menú: Finanzas › Facturación electrónica. Se oculta si la escuela tiene `accounting` | `addon:invoicing` + `MG:finanzas_facturacion_electronica` | Real. Duplica la pestaña de Contabilidad, a propósito | **MIGRAR.** ⚠ crítica: **Dynasty** emite por Factus y **Monster** empieza en noviembre. La emisión es automática (cron), así que tener 0 visitas es normal. Que sea la misma pantalla que la pestaña de Contabilidad V2 |
| 7 | `/recepcion` | `pages/recepcion/RecepcionPage.tsx` | school, school_admin, reporter. Menú: Finanzas › Modo Recepción. Es un kiosko sin chrome | `MG:finanzas_recepcion` | Real, pero `cash_sessions` tiene 0 filas y el cierre de caja no está construido | **FUSIONAR → `/payments-automation`** (acción «Recibir en sede»). Nadie la usa y Pagos ya registra el cobro manual |
| 8 | `/mi-plan` | `pages/MiPlanPage.tsx` | todos los roles que pagan SaaS. Menú «Facturación» en school, school_admin, wellness, store_owner, organizer, reporter, personal_trainer, facility_manager y admin. 17 enlaces | — (el filtro fino está en la página) | Real | **MIGRAR.** ⚠ crítica: es la factura SaaS (Besser con ciclo al día 1, Monster opción D). Se abre poco, pero no puede fallar |
| 9 | `/reporter-dashboard` | `pages/ReporterDashboardPage.tsx` | reporter («Auditor»), school, school_admin. Menú: Reportes › Panel de Reportes y el árbol `reporter` | `MG:reportes_panel` | Real (cartera vía BFF) | **FUSIONAR → `/finances`** (vista «Cartera»). Repite indicadores de Finanzas y Reportes. El rol reporter pasa a aterrizar en Finanzas de solo lectura |
| 10 | `/school-config` | `pages/SchoolSettingsPage.tsx` | school, school_admin, facility_manager. Sin entrada en el menú de escuela. Es la pestaña «Config» de la barra del facility_manager. También la enlazan `EmptyDashboardState` y `useDashboardConfig` («Crea tu Academia») | — | Real (nombre, logo, contacto) | **FUSIONAR → `/settings`** (sección «Datos de la escuela»). Duplica Configuración. Hay que mover los 3 enlaces |
| 11 | `/school/public-profile` | `pages/school/SchoolPublicProfilePage.tsx` | school. Menú: Cuenta › Mi Perfil Público. **Falta en el árbol `school_admin`** | `MG:cuenta_perfil_publico` | Real | **FUSIONAR → `/settings`** (sección «Perfil público»). Al fusionar, el `school_admin` lo gana sin tocar los dos árboles |
| 12 | `/cards` | `pages/SchoolCardsAdminPage.tsx` | school, school_admin. Ya no está en el menú: la reemplazó `/carnets-constancias`, que la enlaza para lo avanzado (`?tab=templates`) | `MG:documentos_carnets` | Real. Usa `datosDeEjemplo` solo para la vista previa del carnet 3D | **FUSIONAR → `/carnets-constancias`** (sección «Carnets avanzado / plantillas»). Carnet 3D F1 está viva. Es la ruta V1 de una pantalla que ya tiene visitas |

## 2. Escuela — gestión deportiva

| # | Ruta | Componente | Roles y menú | Gate | Estado | Decisión |
|---|---|---|---|---|---|---|
| 13 | `/school-sports` | `pages/SchoolSportsPage.tsx` | school, school_admin. Menú: Equipos y Planes › Deportes y Categorías | `MG:gestion_deportiva_equipos_planes` | Real | **FUSIONAR → `/teams`** (sección «Deportes y categorías»). Solo sirve en escuelas multideporte |
| 14 | `/memberships` | `pages/MembershipsPage.tsx` | school, school_admin. Menú: Equipos y Planes › Membresías. Solo aparece si la escuela NO cobra por SportMaps (CAR-4) | `MG:gestion_deportiva_equipos_planes` | Real | **FUSIONAR → `/offerings`** (pestaña «Membresías»). Viene de **Carmel** (CAR-4): hay que confirmar con Carmel antes de mover |
| 15 | `/school/attendance-sheets` | `pages/school/AttendanceSheetIntakePage.tsx` | school, school_admin, coach. Menú: Asistencias › Planillas por revisar, y «Más» del coach | — | Real (OCR de planillas por WhatsApp) | **FUSIONAR → `/attendance-supervision`** (bandeja «Por revisar»). Es la salida de las planillas de papel de **Dynasty**. Hoy no entra nada, pero es la vía acordada |
| 16 | `/dashboard/polls` | `pages/polls/PollsPage.tsx` | school, school_admin, coach. Menú: Asistencias › Encuestas, y «Más» del coach (Comunicación) | — | Real. `attendance_polls` tenía 1 fila real (08-31) | **FUSIONAR → `/attendance-supervision`** (pestaña «Encuestas de asistencia»). Casi nadie la usa. No confundir con la encuesta post-entreno (#103) |
| 17 | `/dashboard/polls/:pollId/results` | `pages/polls/PollResultsPage.tsx` | igual que #16 | — | Real | **FUSIONAR** (es el detalle de #16) |
| 18 | `/results-overview` | `pages/ResultsOverviewPage.tsx` | school, school_admin. Ya no está en el menú | — | **Mock.** `results = isDemoMode ? demoResults : []`: vacía para cualquier escuela real | **RETIRAR (segura).** Feed de medallas de demostración; `/results` la reemplaza |
| 19 | `/school/routines/:routineId` | `pages/trainer/TrainerRoutineDetail.tsx` | school, school_admin, coach | `MG:gestion_deportiva_entrenamiento_rutinas` | Real | **MIGRAR junto con `/school/routines`**, que sí tiene visitas. Es el mismo componente que #73 |
| 20 | `/school/dotacion` | `pages/school/SchoolEquipmentPage.tsx` (alias) | school, school_admin. Sin menú. Solo la enlaza `lib/notifications/navigation.ts:113` | — | Duplicado exacto de `/school/equipment` | **FUSIONAR → `/school/equipment`.** Convertirla en redirección y corregir el enlace de la notificación |
| 21 | `/pickup` | `pages/school/PickupMonitorPage.tsx` | school, admin. Sin menú | — | **Mock.** `MOCK_STUDENTS` con actualización simulada cada 3 s | **RETIRAR (segura).** Maqueta sin datos |
| 22 | `/partidos/:matchId` | `pages/PartidoPage.tsx` → `components/partidos/PartidoFlujo` | staff y coach. La abre `/results` (11 enlaces) | Gate real en RLS/RPC | Real, diseño de nov-2026 | **YA V2.** Pantalla nueva. Cero visitas porque casi no hay partidos fuera del demo |
| 23 | `/partido-en-vivo/:matchId` | `pages/PartidoEnVivoPage.tsx` | staff y coach | Flag de escuela `live_match_enabled` (solo prendido en escuelas demo) | Real, nuevo | **YA V2.** Que tenga 0 visitas es lo esperado: el flag está apagado en los clientes. PAR-3 lo enciende |
| 24 | `/coach/voleibol-pose` | `pages/BiomechVolleyballLabPage.tsx` | coach, school, school_admin. Sin menú a propósito («Piloto») | — | Piloto real que procesa en el dispositivo | **RETIRAR** de la ola (ya está oculta). Hay que decidir si el piloto sigue con **Monster** (voleibol). Si sigue, se queda como ruta oculta sin migrar |

## 3. Torneos (escuela y organizador)

Los torneos dependen del addon `tournaments`. **Besser** lo tiene de cortesía desde el 10-20, pero todavía no ha creado ningún torneo. El organizador usa este mismo motor. Es diferencial comercial.

| # | Ruta | Componente | Roles y menú | Gate | Estado | Decisión |
|---|---|---|---|---|---|---|
| 25 | `/school/tournaments` | `pages/school/SchoolTournamentsPage.tsx` | school, school_admin, organizer. Menú: Torneos › Mis Torneos. Es el inicio del organizer | `addon:tournaments` (en el menú) | Real | **MIGRAR** como «Torneos» V2, con pestañas Organizo / Participo |
| 26 | `/school/tournaments/new` | `pages/school/CreateTournamentPage.tsx` | igual que #25. Menú organizer: «Torneo avanzado» | igual que #25 | Real | **FUSIONAR → `/school/tournaments/nuevo-rapido`** («Opciones avanzadas»). Son dos formas de crear lo mismo |
| 27 | `/school/tournaments/nuevo-rapido` | `components/tournaments/create/TournamentWizard.tsx` | igual que #25. Menú: Torneos › Crear torneo | igual que #25 | Real | **MIGRAR** (asistente único de creación) |
| 28 | `/school/tournaments/:id` | `pages/school/SchoolTournamentDetailPage.tsx` | igual que #25 | — | Real | **MIGRAR** (detalle del torneo) |
| 29 | `/school/delegations` | `pages/school/SchoolDelegationsPage.tsx` | school, school_admin, organizer. Menú organizer: «Torneos donde participo» | — | Real | **FUSIONAR → Torneos V2** (pestaña «Participo») |
| 30 | `/school/delegations/:id` | `pages/school/SchoolDelegationDetailPage.tsx` | igual que #29 | — | Real | **FUSIONAR** (detalle dentro de «Participo») |
| 31 | `/school/enroll/:eventId` | `pages/school/EventEnrollmentPage.tsx` | school, school_admin. La enlaza `EventPublicPage` | — | Rehecho en jul-2026 (antes estaba roto) | **FUSIONAR → Torneos V2 › Participo** (paso «Inscribir delegación») |
| 32 | `/tournaments/:eventId/register` | `pages/events/TournamentRegisterPage.tsx` | parent, athlete. Se llega por enlace desde el evento | — | Real | **MIGRAR** (baja prioridad): es el flujo de inscripción individual a torneo. Se migra cuando torneos tenga uso |

## 4. Tienda de la escuela y alias de `store_owner`

**Monster** tiene el addon `store` (y `accounting`/`invoicing`). Desde noviembre tiene 92 familias activas. GYM RM está pendiente de habilitar. Todo va detrás de `StoreGate`.

| # | Ruta | Componente | Roles y menú | Gate | Estado | Decisión |
|---|---|---|---|---|---|---|
| 33 | `/orders` | `pages/StoreOrdersPage.tsx` | store_owner, school, school_admin. Grupo «Tu tienda › Pedidos» | `Store` | Real (BFF a RPC) | **FUSIONAR → «Tu tienda» V2** (pestaña Pedidos). ⚠ crítica para Monster |
| 34 | `/inventory` | `pages/StoreInventoryPage.tsx` | igual que #33. «Tu tienda › Inventario» | `Store` | Real | **FUSIONAR → Tu tienda V2** (pestaña Inventario) |
| 35 | `/tienda-escuela` | redirección a `/tienda-escuela/ajustes` | school, school_admin | — | Alias | **RETIRAR (segura)**: es solo un alias |
| 36 | `/tienda-escuela/ajustes` | `pages/school/SchoolStoreSettingsPage.tsx` | school, school_admin. «Tu tienda › Cobros y entrega / Activar tienda» | — (sin StoreGate: así es como se activa) | Real | **FUSIONAR → Tu tienda V2** (pestaña Ajustes). Es la puerta para activar la tienda |
| 37 | `/tienda-escuela/cupones` | `pages/school/SchoolStoreCouponsPage.tsx` | school, school_admin. «Tu tienda › Cupones» | `Store` | Real | **FUSIONAR → Tu tienda V2** (pestaña Cupones) |
| 38 | `/products` | `pages/StoreProductsPage.tsx` (re-exporta `VendorProductsPage`) | store_owner, school, school_admin. La enlaza `useDashboardConfig` | `Store` | Alias de `/vendor/products` | **RETIRAR (segura)**: redirigir a Tu tienda V2 y corregir los 2 enlaces del dashboard |
| 39 | `/suppliers` | `StoreInventoryPage` (alias) | store_owner, admin. Menú store_owner «Proveedores» | `Store` | **Alias engañoso**: dice Proveedores y muestra el inventario | **RETIRAR (segura)**. `store_owner` es un rol legacy (`is_visible:false`, 1 usuario) |
| 40 | `/categories` | `VendorProductsPage` (alias) | store_owner, admin | `Store` | Alias | **RETIRAR (segura)** |
| 41 | `/customers` | `StoreOrdersPage` (alias) | store_owner, admin | `Store` | Alias | **RETIRAR (segura)** |
| 42 | `/promotions` | `VendorProductsPage` (alias) | store_owner, admin | `Store` | Alias engañoso: dice Promociones y muestra los productos | **RETIRAR (segura)** |
| 43 | `/store-reports` | `pages/ReportsPage.tsx` (los reportes de la ESCUELA) | store_owner, admin | `Store` | **Página equivocada**: muestra los reportes de escuela | **RETIRAR (segura)** |

## 5. Vendedor / marketplace (`/vendor/*`, detrás de `VendorGuard`)

El marketplace externo está **pausado a propósito**: `marketplace_transactions` no existe y había 0 de 3 `external_vendor` con perfil. Pero `/vendor/dashboard` es el **Inicio del profesional de salud**, y `/vendor/products` es **Productos de la tienda de la escuela**.

| # | Ruta | Componente | Roles y menú | Gate | Estado | Decisión |
|---|---|---|---|---|---|---|
| 44 | `/vendor/onboarding` | `pages/vendor/VendorOnboardingPage.tsx` | cualquiera con vendor_profile. Menú «Verificación» | — | Real | **FUSIONAR → Inicio del profesional (#45)** (tarjeta «Verificación») |
| 45 | `/vendor/dashboard` | `pages/vendor/VendorDashboardPage.tsx` | wellness_professional («Inicio»), store_owner, vendedores. 9 enlaces | — | Real | **MIGRAR** como «Inicio del profesional». Lo comparte con el rol de salud (ver §6) |
| 46 | `/vendor/services` | `pages/vendor/VendorServicesPage.tsx` | wellness («Mis Servicios»), vendedores | — | Real. La edición dice «próximamente» | **FUSIONAR → Inicio del profesional** (sección «Mis servicios») |
| 47 | `/vendor/appointments` | `pages/vendor/VendorAppointmentsPage.tsx` | vendedores | — | Solo redirige a `/schedule` | **RETIRAR (segura)** |
| 48 | `/vendor/products` | `pages/vendor/VendorProductsPage.tsx` | escuela («Tu tienda › Productos»), store_owner, vendedores | `Store` | Real | **FUSIONAR → Tu tienda V2** (pestaña Productos). ⚠ crítica para Monster |
| 49 | `/vendor/products/new` | `components/vendor/product-wizard/ProductWizard` | igual que #48 | `Store` | Real | **FUSIONAR** (asistente dentro de Tu tienda) |
| 50 | `/vendor/products/:id/edit` | `ProductWizard` | igual que #48 | `Store` | Real | **FUSIONAR** (igual que #49) |
| 51 | `/vendor/inbox` | `pages/vendor/VendorInboxPage.tsx` | vendedores externos | `Store` | Real, sin usuarios | **RETIRAR**. Segura si se confirma que hay 0 vendedores externos activos |
| 52 | `/vendor/payouts` | `pages/vendor/VendorPayoutsPage.tsx` | vendedores externos | `Store` | Real, sin usuarios. La escuela cobra con sus cuentas: no hay liquidación | **RETIRAR** (misma condición que #51) |
| 53 | `/vendor/subscribers` | `pages/vendor/VendorSubscribersPage.tsx` | vendedores. Sin menú | — | Depende de suscripciones del marketplace, que no existen | **RETIRAR (segura)** |
| 54 | `/vendor/shipping` | `pages/vendor/VendorShippingSettingsPage.tsx` | vendedores externos | `Store` | El proveedor de envío es mock. La tienda de la escuela entrega con retiro | **RETIRAR** (misma condición que #51) |
| 55 | `/vendor/promotions` | `pages/vendor/VendorPromotionsPage.tsx` | vendedores externos | `Store` | Duplica Cupones (mismo `StoreCouponsManager`) | **RETIRAR** (misma condición que #51) |
| 56 | `/vendor/public-profile` | `pages/vendor/VendorPublicProfilePage.tsx` | wellness_professional, store_owner. Menú «Mi Perfil Público» | — | Real | **FUSIONAR → `/settings`** del profesional (sección «Perfil público») |

## 6. Profesional de salud (`wellness_professional`)

El módulo clínico se aplicó entre F0 y F3 el 10-06. Tiene custodia legal (Res. 1995, notas inmutables). Del lado del profesional, el rol tiene muy pocos usuarios reales. Pero alimenta `/salud` y `/disponibilidad-medica`, que **sí tienen visitas**. No se puede retirar sin exportar las historias.

| # | Ruta | Componente | Roles y menú | Gate | Estado | Decisión |
|---|---|---|---|---|---|---|
| 57 | `/pacientes` | `pages/clinical/PatientsPage.tsx` | wellness. Menú «Pacientes» | — | Real | **MIGRAR.** ⚠ crítica (legal) |
| 58 | `/pacientes/:patientId` | `pages/clinical/PatientDetailPage.tsx` | wellness | — | Real | **MIGRAR** (detalle de #57) |
| 59 | `/pacientes/:patientId/imprimir` | `pages/clinical/PatientRecordPrintPage.tsx` | wellness | — | Real (vista de impresión) | **FUSIONAR → #58** (acción «Imprimir»). La ruta se queda sin rediseño |
| 60 | `/historias` | `pages/clinical/FollowUpsPage.tsx` | wellness. Menú «Seguimientos» | — | Real | **FUSIONAR → `/pacientes`** (pestaña «Seguimientos») |
| 61 | `/disponibilidad` | `pages/clinical/AvailabilityPage.tsx` | wellness. Menú «Disponibilidad» | — | Real | **FUSIONAR → `/schedule`** (pestaña «Mi horario») |
| 62 | `/schedule` | `pages/WellnessSchedulePage.tsx` | wellness. Menú «Agenda» | — | Real | **MIGRAR** («Agenda» del profesional) |
| 63 | `/wellness-reports` | `pages/clinical/ProfessionalReportsPage.tsx` | wellness. Menú «Reportes» | — | Real | **FUSIONAR → Inicio del profesional (#45)** |
| 64 | `/nutrition` | `pages/NutritionPage.tsx` | wellness, admin, super_admin. Sin menú | — | **Mock.** `const mockPlans = []`: siempre vacía | **RETIRAR (segura).** El plan ya dice «Ocultar `/nutrition`». La nutrición se rehace en PAR (plan del club + hidratación) |
| 65 | `/athletes` | redirección a `/pacientes` | — | — | Alias viejo | **RETIRAR (segura)** |
| 66 | `/evaluations/new` | redirección a `/pacientes` | — | — | Alias viejo | **RETIRAR (segura)** |
| 67 | `/medical-history` | redirección a `/historias` | — | — | Alias viejo | **RETIRAR (segura)** |
| 68 | `/follow-ups` | redirección a `/historias` | — | — | Alias viejo | **RETIRAR (segura)** |

## 7. Entrenador del club (`coach`)

| # | Ruta | Componente | Roles y menú | Gate | Estado | Decisión |
|---|---|---|---|---|---|---|
| 69 | `/pendientes` | `components/coach/v2/PendientesPage.tsx` | coach, athlete, parent. Aparece solo si hay cola offline | — | Real, V2 | **YA V2.** Que tenga 0 visitas es lo esperado: solo se abre cuando algo quedó sin enviar |
| 70 | `/coach-attendance/scan` | `pages/CoachCheckInScanPage.tsx` | coach. Se abre desde Asistencia V2 | — | Real | **FUSIONAR → `/coach-attendance`** (acción «Escanear QR» dentro de Asistencia V2) |
| 71 | `/coach-plans` | `pages/CoachPlansPage.tsx` | coach. «Más › Agenda y citas (Citas 1 a 1)» | `MG:gestion_deportiva_disponibilidad_coach` (con `roles=['coach']`) | Real | **FUSIONAR → `/calendar`** del coach (sección «Citas 1 a 1»). La V2 ya la presenta como agenda |
| 72 | `/coach-reports` | `pages/CoachReportsPage.tsx` | coach. «Más › Informes del entreno» | — | Real. Ya no tiene textos fijos («Octubre / Temporada 2025») | **MIGRAR.** Es el informe del equipo. Sirve a **Besser** (1.738 mediciones en oct) y **Carmel** (métricas) |
| 73 | `/coach-reports/entreno-equipo` | `pages/CoachTeamPostTrainingReportPage.tsx` | coach, staff. Enlazada desde #72 y `coachV2Logic` | — | Real | **FUSIONAR → `/coach-reports`** (pestaña «Post-entreno del equipo») |
| 74 | `/evaluations` | `pages/CoachEvaluationsPage.tsx` | coach. **Sin menú y sin enlaces** (solo `routePermissions`) | — | Real pero huérfana | **RETIRAR (segura).** `/coach/evaluar/:sessionId` (V2) la reemplaza |
| 75 | `/announcements` | `pages/AnnouncementsPage.tsx` | coach. «Más › Comunicación › Anuncios» | — | Escribe en `announcements`, pero **ninguna pantalla de familia la lee**. Tenía 0 filas (08-31). Trae equipos demo para cuentas @demo | **RETIRAR.** Segura si se confirma que sigue con 0 filas. Comunicaciones V2 cubre el caso |
| 76 | `/mis-evaluaciones` | `pages/CoachMyEvaluationsPage.tsx` | coach. «Más › Mis evaluaciones» | — | Real (D5, en main desde 10-29) | **YA V2 / MIGRAR liviano** (43 líneas). Tiene 0 visitas porque todavía casi no hay evaluaciones publicadas |
| 77 | `/coach/dotacion` | `pages/coach/CoachEquipmentPage.tsx` | coach, school. «Más › Mi dotación» | — | Real | **FUSIONAR → `/teams`** V2 del coach (sección «Mi dotación») |

## 8. Entrenador personal (`personal_trainer`, detrás de `RequirePersonalTrainer`)

El rol **tiene uso real**: `/trainer/dashboard`, `/trainer/plans` y `/trainer/routines` tienen visitas. No se retira.

| # | Ruta | Componente | Roles y menú | Gate | Estado | Decisión |
|---|---|---|---|---|---|---|
| 78 | `/trainer/clients` | `pages/trainer/TrainerClients.tsx` | personal_trainer. Menú «Mis Clientes» | guard | Real | **MIGRAR** (núcleo del rol) |
| 79 | `/trainer/clients/:clientId` | `pages/trainer/TrainerClientProfile.tsx` | igual que #78 | guard | Real | **MIGRAR** (detalle) |
| 80 | `/trainer/routines/:routineId` | `pages/trainer/TrainerRoutineDetail.tsx` | igual que #78 | guard | Real | **MIGRAR** con #19: es el mismo componente y se migra una sola vez |
| 81 | `/trainer/availability` | `pages/trainer/TrainerAvailability.tsx` | igual que #78. Menú «Disponibilidad» | guard | Real | **FUSIONAR → `/trainer/dashboard`** (sección «Mi horario») |
| 82 | `/trainer/payments` | `pages/trainer/TrainerPayments.tsx` (envuelve `PaymentsAutomationPage`) | igual que #78. Menú «Pagos» | guard | Envoltorio | **FUSIONAR**: se migra sola cuando `/payments-automation` pase a V2-D |
| 83 | `/trainer/profile` | `pages/trainer/TrainerProfileEditor.tsx` | igual que #78. Menú «Mi Perfil Público» | guard | Real | **FUSIONAR → `/settings`** (sección «Perfil público», como #11 y #56) |

## 9. Dueño de espacios (`facility_manager`)

El rol **tiene uso real**: `/venue/dashboard` y `/venue/onboarding` tienen visitas.

| # | Ruta | Componente | Roles y menú | Gate | Estado | Decisión |
|---|---|---|---|---|---|---|
| 84 | `/venue/reservas` | `pages/venue/VenueReservationsPage.tsx` | facility_manager. Menú y barra «Reservas» | — | Real, solo lectura. Las acciones están en `/facilities` | **FUSIONAR → `/facilities`** (pestaña «Próximas reservas»). ⚠ es un rol con cliente |
| 85 | `/venue/cobros` | `pages/venue/VenuePaymentsPage.tsx` (envuelve `SportMapsPaySettings`) | facility_manager. Menú y barra «Cobros» | — | Envoltorio | **FUSIONAR → `/settings`** (sección «Cobros»). Es el mismo componente que usa la escuela |

## 10. Organizador (`organizer`, detrás de `OrganizerGuard`)

El rol no tiene clientes: `event_organizers` tiene 0 filas y los eventos reales los crea `creator_role='school'`. Todas sus rutas ya redirigen al motor de torneos de la escuela (spec organizador-torneos-modulo-aparte, D5).

| # | Ruta | Destino | Decisión |
|---|---|---|---|
| 86 | `/organizer/dashboard` | `/school/tournaments` | **RETIRAR (segura)** |
| 87 | `/organizer/events` | `/school/tournaments` | **RETIRAR (segura)** |
| 88 | `/organizer/calendar` | `/school/tournaments` | **RETIRAR (segura)** |
| 89 | `/organizer/finances` | `/school/tournaments` | **RETIRAR (segura)** |
| 90 | `/organizer/reports` | `/school/tournaments` | **RETIRAR (segura)** |
| 91 | `/organizer/create-event` | `/school/tournaments/new` | **RETIRAR (segura)** |
| 92 | `/organizer/torneo-rapido` | `/school/tournaments/nuevo-rapido` | **RETIRAR (segura)** |
| 93 | `/organizer/event/:id` | `OrganizerEventRedirect` | **RETIRAR (segura)** |
| 94 | `/organizer/profile` | `/settings` | **RETIRAR (segura)** |
| 95 | `/organizer/settings` | `/settings` | **RETIRAR (segura)** |

(`/organizer/onboarding` queda fuera porque es onboarding. Con las 10 de arriba suma las 11 del plan.)

## 11. Acudiente y deportista

| # | Ruta | Componente | Roles y menú | Gate | Estado | Decisión |
|---|---|---|---|---|---|---|
| 96 | `/profile` | `components/parent/v2/PerfilSegunRol.tsx` | todos. Barra clásica del coach. 9 enlaces | — | Real | **FUSIONAR → `/settings`** («Mi cuenta»). La V2 del acudiente y la del coach ya la unen (`RUTAS_UNIDAS`) |
| 97 | `/stats/todo` | `EstadisticasCompletas` (`RutasSegunRol`) | athlete. Se abre desde Progreso V2 | `VITE_DEPORTISTA_V2` | Real, V2 | **YA V2** |
| 98 | `/shop` | `pages/ShopPage.tsx` | todos. Solo la enlaza `DemoQuickLinks` | `Store` | Tienda vieja que lee `products` directo | **RETIRAR (segura).** La reemplaza `/mi-tienda` → `/tienda/:slug` |
| 99 | `/wellness` | `pages/AthleteWellnessPage.tsx` → `WellnessModule` | athlete («Más › Explorar bienestar»), menú clásico del deportista | — | Depende del marketplace de profesionales, que está pausado | **FUSIONAR → `/salud`** (sección «Profesionales»), o retirar si PAR no la retoma |
| 100 | `/mi-tienda` | `pages/MiTiendaPage.tsx` (47 líneas, resuelve el slug y redirige) | parent, athlete. Menú «Tienda» | `Store` | Sin pantalla propia | **MANTENER** como redirección. No hay nada que migrar |
| 101 | `/mis-compras` | `pages/MisComprasPage.tsx` | cualquiera con sesión. Menú «Mis compras» | `Store` | Real | **FUSIONAR → `/my-payments` y `/athlete-payments`** (sección «Compras»). Relevante para las familias de Monster |
| 102 | `/mis-compras/:orderId` | `pages/MiCompraDetallePage.tsx` | igual que #101 | `Store` | Real | **FUSIONAR** (detalle de la compra dentro de Pagos) |
| 103 | `/my-event-registrations` | `pages/events/MyEventRegistrationsPage.tsx` | parent, athlete. «Más › Mis eventos» | — | Real | **FUSIONAR → `/enrollments`** (pestaña «Eventos y torneos») |
| 104 | `/academic-progress` | `pages/AcademicProgressPage.tsx` | parent. Solo en el menú clásico (`VITE_ACUDIENTE_V2=false`) | reversa del acudiente | Duplica `/children/:id/progress`, que sí tiene visitas | **RETIRAR** cuando se retire la reversa `VITE_ACUDIENTE_V2` |
| 105 | `/parent-attendance` | `pages/AttendancePage.tsx` | parent. Solo en el menú clásico | reversa del acudiente | Duplica `/children/:id/attendance` | **RETIRAR** junto con la reversa |

## 12. Flujos protegidos fuera del layout (por confirmar si la medición los cuenta)

| # | Ruta | Componente | Quién llega | Decisión |
|---|---|---|---|---|
| 106 | `/post-entreno/:sessionId` | `pages/PostTrainingSelfEvalPage.tsx` | deportista o acudiente, por notificación o WhatsApp | **MIGRAR.** ⚠ crítica: es la encuesta post-entreno activa (incidente de **Besser** el 10-29, «no llega la encuesta a los padres»). Si no aparece en `ui_usage_daily`, es un hueco de la medición y no falta de uso |
| 107 | `/post-entreno/:sessionId/resultado` | `pages/PostTrainingDayRecapPage.tsx` | igual que #106 | **FUSIONAR → #106** (paso final) |

---

## Totales

107 rutas en total: 105 internas sin visitas y 2 flujos post-entreno que hay que confirmar.

| Decisión | Cuántas | Rutas (#) |
|---|---|---|
| **FUSIONAR** | 49 | 1–5, 7, 9–17, 20, 26, 29–31, 33, 34, 36, 37, 44, 46, 48–50, 56, 59–61, 63, 70, 71, 73, 77, 81–85, 96, 99, 101–103, 107 |
| **RETIRAR** | 36 | 18, 21, 24, 35, 38–43, 47, 51–55, 64–68, 74, 75, 86–95, 98, 104, 105 |
| **MIGRAR** | 16 | 6, 8, 19, 25, 27, 28, 32, 45, 57, 58, 62, 72, 78–80, 106 |
| **YA V2** (sin trabajo) | 5 | 22, 23, 69, 76, 97 |
| **MANTENER** (redirección, sin UI) | 1 | 100 |

Las 49 fusiones caben en unas **15 pantallas V2 de destino**: Contabilidad, Tu tienda, Torneos, Settings («Mi cuenta» con las secciones de perfil público, datos de la escuela y cobros), Pagos de la escuela, Finanzas, Equipos/Ofertas, Supervisión de asistencia, Carnets, Inicio del profesional, Pacientes, Agenda del profesional, Informes del coach, Pagos e Inscripciones de la familia, y Salud.

**Diferencia con las 110 del plan:** aquí salen 105 rutas internas porque dejé fuera `/trainer/onboarding`, `/organizer/onboarding`, `/setup/school`, `/parent-checkout` y `/salud/invitacion/:token` (onboarding, checkout y token). Con esas cinco quedan las 110. El plan nombra `stats` dentro de V2-A, pero en la lista de visitas `/stats` sí tiene visitas. Aquí solo entra `/stats/todo`.

## Críticas aunque tengan cero visitas (no retirar)

- **Facturación electrónica** (#6): Dynasty emite por Factus y Monster empieza en noviembre. La emisión es automática, por eso nadie abre la pantalla.
- **Contabilidad** (#1–5): Monster es la única escuela con el addon. Es argumento comercial frente a LUDMO+.
- **Mi plan / factura SaaS** (#8): todos los roles que pagan.
- **Tu tienda** (#33, 34, 36, 37, 48–50): Monster tiene la tienda activa y familias desde noviembre.
- **Módulo clínico** (#57, 58, 62): custodia legal de historias. Alimenta `/salud` y `/disponibilidad-medica`, que sí tienen uso.
- **Entrenador personal y dueño de espacios** (§8, §9): son roles con usuarios reales en la medición.
- **Planillas por revisar** (#15): es la vía acordada para la asistencia en papel de Dynasty.
- **Encuesta post-entreno** (#106): activa en Besser.
- **Membresías** (#14): pedida por Carmel (CAR-4). Confirmar con Carmel antes de mover.

## «Retirar» que es segura hoy

Son de un rol sin clientes activos, son placeholder o mock, o son solo un alias o una redirección. Son **28**:

- **Mock o placeholder:** `/results-overview` (#18), `/pickup` (#21), `/nutrition` (#64).
- **Huérfanas o reemplazadas:** `/evaluations` (#74; la reemplaza `/coach/evaluar/:id`) y `/shop` (#98; la reemplaza `/mi-tienda`).
- **Organizador:** las 10 redirecciones `/organizer/*` (#86–95). El rol tiene 0 organizadores.
- **Alias de `store_owner`** (rol legacy oculto, 1 usuario): `/suppliers`, `/categories`, `/customers`, `/promotions`, `/store-reports` (#39–43). Además `/products` (#38), que es alias de `/vendor/products`.
- **Redirecciones viejas:** `/tienda-escuela` (#35), `/vendor/appointments` (#47), `/athletes`, `/evaluations/new`, `/medical-history`, `/follow-ups` (#65–68).
- **Marketplace sin suscripciones:** `/vendor/subscribers` (#53).

**Retirar con una verificación previa** (son 8 y no entran en las 28):
- `/vendor/inbox`, `/vendor/payouts`, `/vendor/shipping`, `/vendor/promotions` (#51, 52, 54, 55): confirmar que hay 0 vendedores externos verificados y activos.
- `/announcements` (#75): confirmar que `announcements` sigue con 0 filas.
- `/coach/voleibol-pose` (#24): confirmar que el piloto de voleibol con Monster no sigue.
- `/academic-progress` y `/parent-attendance` (#104, 105): se retiran solo junto con la reversa `VITE_ACUDIENTE_V2`.

## Arreglos que salen del inventario (no son de la ola, pero aparecieron)

- `lib/notifications/navigation.ts:113` manda a `/school/dotacion` (alias). Debería ir a `/school/equipment`.
- `/school/public-profile` falta en el árbol `school_admin` de `navigation.ts`. Se resuelve solo al fusionarla en `/settings`.
- `/store-reports` muestra los reportes de la escuela, y `/suppliers` y `/promotions` muestran otra pantalla con el nombre equivocado.
- `useDashboardConfig.ts` (líneas 101 y 361) enlaza `/products` y `/school-config`. Hay que moverlos al destino V2 cuando se fusionen.
