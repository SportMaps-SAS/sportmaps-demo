# Spec — Agendamiento unificado desde Mis Inscripciones (planes + clases de prueba)

**Producto:** SportMaps · **Versión:** v1 · **Fecha:** 2026-08-29
**Estado:** decisiones de producto **resueltas** en conversación (§3) · diseño técnico (§4) **aprobado** · **Fases 1-3 (backend, BFF, frontend) aplicadas y probadas en vivo el 2026-08-29** contra `luebjarufsiadojhvxgi`, sin commitear todavía. Fase 4 (QA) la corre el usuario.

> **Corrección 2026-11-07 (`SEG-31`):** la revisión del 2026-11-06 encontró que el camino sin
> cuenta de abajo no valida vencimiento ni cupos al agendar, no devuelve el cupo al cancelar en
> planes por cupos, crea cuenta `athlete` también para menores y no respeta
> `self_service_enabled`. Ver [link-agendamiento-correcciones-alta.md](link-agendamiento-correcciones-alta.md).

**Ampliación 2026-09-15/17 — banco de horas real desde el link, con y sin cuenta:** el
escenario `enrolled_unregistered` (ficha con enrollment real en la escuela, sin cuenta) hoy
siempre caía a "clase de prueba" — sin forma de tocar su plan/banco de horas real sin
registrarse. Se agregó, en `public-booking.routes.ts`:
- `POST /register-unregistered` — crea la cuenta real desde el OTP ya verificado (reusa
  `booking_token`, sin segundo código), migra el historial completo (`enrollments`,
  `attendance_records`, `session_bookings`, `payments`, `zk_user_mappings`) vía
  `migrate_unregistered_athlete_to_profile` (misma RPC que `accept_invitation_pro`), y entra
  logueado con un magic link. Bug encontrado y corregido: `createUser` no mandaba `role` en
  `user_metadata`, así que `handle_new_user()` dejaba `needs_role_selection=true` (el camino de
  OAuth sin rol) y `ProtectedRoute` lo mandaba siempre a `/onboarding/role`, pisando el
  `redirectTo` del magic link.
- **Paridad completa sin cuenta** con lo que ya tenía "Mis Inscripciones" — no una versión
  reducida: `GET /available-for-enrollment`, `POST /book-for-enrollment`,
  `POST /cancel-for-enrollment`, `GET /my-bookings-for-enrollment`,
  `GET /hour-bank-balance-for-enrollment` (saldo — `HourBankBalanceCard` reusado tal cual, con
  un `fetcher` opcional nuevo para no depender de sesión de Supabase). Backend: se generalizó
  `session-bookings.ts` con un tipo `AthleteIdentity` (`userId | childId | unregisteredAthleteId`)
  en vez de duplicar `listAvailableSessions`/`bookSession`/`cancelSessionBooking` — las rutas
  autenticadas quedaron como wrappers delgados sobre las mismas funciones, cero regresión
  (verificado: misma cantidad de sesiones antes/después del refactor). Frontend: el paso
  `enrolled_choice` del link ahora ofrece "Crear mi cuenta" o "Agendar sin crear cuenta"
  (ya no manda automáticamente a clase de prueba); el paso nuevo replica el selector
  Por-bloque/Personalizada (elegido ANTES de ver la lista) y el filtro Personal/Grupal — son
  dos ejes independientes que se habían mezclado en un primer intento.
- **Bug real encontrado probando el camino "Personalizada" sin cuenta:** el `INSERT` en
  `session_bookings` violaba el CHECK `chk_booking_identity` porque mandaba `enrollment_id`
  además de `unregistered_athlete_id` — ese CHECK exige que sean mutuamente excluyentes (mismo
  criterio que ya documentaba `trial_class_public_create` en
  `20260827184021_clases_de_prueba_agenda.sql`, pero `bookSession` no lo tenía en cuenta al
  generalizarse). Corregido: `enrollment_id: identity.unregisteredAthleteId ? null : enrollment_id`.
- **Verificado en vivo end-to-end, camino sin cuenta:** listar con saldo (720 min completos),
  agendar por bloque (2h), agendar personalizada (3h, vía `HourGridPicker` con horas atómicas),
  cancelar (reembolso de banco de horas + reversión del bloque estirado a su hora atómica
  original), todo con datos reales en Academia Superior Bogotá, limpiado después de cada
  prueba. El camino **con cuenta** (`plan_sessions`) ya tenía exactamente esta misma UI de
  antes (`planBookingModeChoice`/`planClassTypeFilter`/`HourGridPicker`/`useCancelBooking`) —
  solo se le agregó `HourBankBalanceCard`, sin tocar su lógica; no se pudo re-probar por click
  hoy por no tener la contraseña de una cuenta de prueba real, queda pendiente de un smoke test
  del usuario.
- **Deuda heredada, NO cerrada en esta ampliación:** `min_cancellation_hours` (el tope de horas
  para poder cancelar) solo se evalúa en `DELETE /athlete/cancel-booking` cuando la sesión
  tiene `facility_id` — las reservas por coach (`avail_`, que es lo que usan estos planes de
  banco de horas) no tienen ningún tope de cancelación, ni en el camino autenticado ni en el
  nuevo sin cuenta. No es una regresión de hoy — ya era así antes; solo se heredó al reusar la
  misma función.

**Ampliación 2026-08-29 — link público (`/agendar-clase/:slug`):** además de Mis
Inscripciones, el owner puede compartir un link público (y QR) para agendar clases de prueba
sin cuenta — nuevo y separado de `/agendar/:slug` (instalaciones + cortesía, SEG-20), pero
reusando su misma identificación por correo+OTP (`/verify-otp` tal cual, `/trial-start-verification`
y `/trial-confirm` nuevos). Reemplaza la cortesía como opción pública para escuelas con
categorías de prueba configuradas. El botón "Compartir link" vive en Ajustes de Clases de
Prueba, visible solo si el self-service está prendido.

⚠️ **Dos bugs reales encontrados probando esta ampliación, ambos corregidos y re-verificados:**
1. La versión de 4 parámetros de `trial_class_self_has_active_plan` quedó con `EXECUTE` para
   `anon`/`authenticated` pese al `REVOKE` explícito en su propia migración — cerrado en
   `20260829121154`.
2. Agregar ese 4º parámetro como *overload* (en vez de reemplazar la firma) dejó dos versiones
   ambiguas — cualquier llamada de `trial_class_self_create` para sujeto `child_id` o `self`
   fallaba con `function ... is not unique`. Es decir, **el self-service completo (Fase 1-3)
   quedó roto** hasta `20260829121405`, que dropea el overload viejo. Encontrado por la propia
   batería de regresión de esta sesión, no por un reporte externo.

**Deuda conocida, sin resolver a propósito:** el link público solo permite **crear** —
reprogramar/cancelar una reserva hecha por ahí se gestiona por ahora desde el panel del owner
(Instalaciones), no hay flujo público de autoservicio para eso todavía.
> Actualizado 2026-09-17: esto seguía siendo cierto solo para **clases de prueba**
> (`trial_class_bookings`). Para reservas de **plan** (banco de horas) agendadas por este
> mismo link, sí hay cancelación pública de autoservicio — ver la ampliación 2026-09-15/17
> más arriba (`POST /cancel-for-enrollment` sin cuenta, `useCancelBooking` ya existente con
> cuenta). Reprogramar sigue sin existir para ninguno de los dos casos.

**Decisión añadida el mismo día, tras la primera pasada:** antes de ofrecer una prueba para un
sujeto (hijo ya registrado, o el propio adulto), se valida si ese sujeto **ya tiene un plan
real activo** en la escuela (`trial_class_self_has_active_plan` — cualquier enrollment activo
cuyo `offering.offering_type <> 'single_session'`, por ESCUELA completa, sin importar
disciplina). Si lo tiene, no se le ofrece prueba — el frontend lo bloquea en el Paso 1 y lo
manda a agendar desde su plan (`ScheduleClassModal`, ya existente). Un hermano/a nuevo nunca
tiene plan, no aplica. La opción `self` (adulto agendando para sí mismo) **se mantuvo** —no se
eliminó— pero queda sujeta al mismo chequeo.

> Documento base para la construcción. Se construye **por fases con revisión entre cada una**
> (no "todo el módulo de una"), mismo patrón que
> [clases-de-prueba-agenda-owner.md](clases-de-prueba-agenda-owner.md) y
> [agenda-publica-reservas.md](agenda-publica-reservas.md).

---

## 0. Objetivo y por qué existe este doc

Crear el **vínculo** entre planes e instalaciones desde el lado del padre/atleta: que una
persona **ya logueada** pueda agendar, desde **Mis Inscripciones**, tanto una clase de su
plan como una **clase de prueba** — sin salir de la app y sin depender de que el owner lo
haga a mano o de usar el link público anónimo.

**No es un módulo nuevo desde cero.** Antes de diseñar nada se auditó qué ya existe (§1) —
gran parte de "agendar clases del plan" ya está construido y en producción. El hueco real es
uno solo: **clases de prueba no tiene ningún camino de self-service para un usuario con
cuenta.**

La gestión de reservas de **plan** (owner/coach) sigue en **Asistencia**, sin cambios. La
gestión de **clases de prueba** (owner) sigue en la pestaña de Instalaciones que ya existe,
sin cambios. Este spec solo agrega el lado del **padre/atleta**.

---

## 1. Qué existe hoy (auditado 2026-08-29, no se reconstruye)

| Escenario | Quién lo usa | Dónde vive | Estado |
|---|---|---|---|
| Agendar clase **del plan** (principal/secundaria/PT) | Padre/atleta logueado | `MyEnrollmentsPage.tsx` → `ScheduleClassModal` → `PrimarySessionsTab`/`SecondarySessionsTab`/`PTPrimarySessionsTab`, hooks `useAvailableSessions`/`useBookSession` | ✅ En producción. CRUD hoy: **crear + cancelar**, sin reprogramar propio |
| Reservar una **instalación** (alquiler, con crédito del plan) | Padre/atleta logueado | `MyEnrollmentsPage.tsx` → `FacilityReserveModal` | ✅ En producción |
| Agendar **clase de prueba** | Owner/admin | `SchoolFacilitiesPage.tsx` → `TrialClassBookingModal`, `bff/src/routes/trial-classes.ts` | ✅ En producción, **solo owner/admin** (decisión #9 del spec original) |
| Agendar **clase de prueba** | Prospecto anónimo, sin cuenta | `/agendar/:slug` (`PublicFacilityBookingPage.tsx`, `public-booking.routes.ts`) | ✅ En producción (auditado en `SEG-20`/`MOD-29`) |
| Agendar **clase de prueba** | Padre/atleta **ya logueado** | — | ❌ **No existe.** Es el hueco que cierra este spec |

`trial_class_bookings` ya tiene `category_id` (disciplina, de la ampliación v1.1 del
2026-08-29) y `enrollment_id`/`unregistered_athlete_id` nullable — el modelo de datos ya
distingue prospecto nuevo de alguien con enrollment, aunque hoy nada lo usa desde el lado del
padre.

---

## 2. Los tres caminos para agendar una clase de prueba, después de este spec

| | Owner (existente) | Público anónimo (existente) | **Padre/atleta logueado (nuevo)** |
|---|---|---|---|
| Quién inicia | Owner/admin | Prospecto sin cuenta | Padre/atleta con sesión activa |
| Verificación de identidad | N/A (el owner ya está autenticado) | OTP por correo (`SEG-20`) | Ya autenticado — sin OTP, mismo principio que `SEG-20` §2 (dar tu propio dato no es una fuga) |
| Para quién puede ser | Cualquier prospecto | Cualquier prospecto | Un **hermano nuevo** (sin registrar) o **un hijo/el propio atleta ya inscrito**, probando otra disciplina |
| Coach asignado | Sí | No | Sí (reusa `coach_availability`, igual que el owner) |

---

## 3. Decisiones de producto (RESUELTAS en conversación, 2026-08-29)

1. **Sujeto de la prueba — ambos casos.** Puede ser (a) alguien nuevo sin registrar
   (hermano) — reusa `unregistered_athlete_id`, o (b) un hijo/atleta **ya inscrito**
   probando otra disciplina — necesita ligarse a `children`/`profiles`, no solo a
   `unregistered_athletes` (ver hueco de datos en §4.1).
2. **Reprogramar — sí, con ventana de corte.** El padre puede reprogramar su propia clase
   de prueba, pero solo hasta **N horas antes** de la sesión (configurable por escuela).
   Pasado ese corte, el cambio se gestiona con el owner — igual razón que ya usa
   `min_booking_advance_hours` en `facilities`: evita reprogramar a 5-10 minutos del
   horario.
3. **Precio — dos niveles. "Primera vez" por ESCUELA, precio de repetición por CATEGORÍA.**
   ⚠️ Corregido dos veces (2026-08-29): primero se scopeó por `category_id` (mal, pasó a
   escuela), después el precio de repetición se puso en `school_trial_class_settings`
   (también mal — el owner necesita distinto precio de repetición por disciplina). Diseño
   final:
   - **Elegibilidad ("¿es su primera prueba?")** sigue siendo por **atleta + escuela**,
     sin importar la disciplina — `trial_class_self_is_first` no cambia.
   - **El precio** sale de la **categoría elegida**: `trial_class_categories.price` la
     primera vez, `trial_class_categories.repeat_price` de ahí en adelante — cada
     categoría tiene su propio `allow_repeat`/`repeat_price`, la escuela puede permitirlo
     en "Natación" y no en "Fútbol", con precios distintos.
   - **Sin tope de repeticiones.** No es "una vez más" — es cada vez que agende, mientras
     `allow_repeat` esté prendido en esa categoría, siempre al mismo `repeat_price`.
4. **Cobro — modo por escuela, reusando lo que ya existe.**
   - Si la escuela tiene pasarela conectada → cobro online al agendar (checkout real).
   - Si la escuela cobra manual (el caso más común hoy, `DIN-6` ~85%) → se gestiona
     **exactamente como un pago manual de hoy**: nace un cobro `pending`, la escuela lo
     concilia con comprobante/aprobación, mismo flujo que ya usan para mensualidades e
     inscripción (`chargeRegistrationFeeIfApplicable`, [guía](../guia-registro-pagos-manual.md)).
   - Si la escuela cobra **en sede** → no se crea ningún cobro en el sistema, solo se
     registra `price_charged` para el reporte — igual que el v1 original (decisión #7 del
     spec original, cobro fuera del sistema).
   - El owner **elige el modo** por escuela, no es automático según si tiene pasarela.

---

## 4. Diseño propuesto (pendiente de tu aprobación — nada de esto está escrito todavía)

### 4.1 Modelo de datos

```sql
-- school_trial_class_settings: 5 columnas nuevas
ALTER TABLE public.school_trial_class_settings
  ADD COLUMN self_service_enabled   boolean NOT NULL DEFAULT false,     -- apaga por default: opt-in
  ADD COLUMN reschedule_cutoff_hours integer NOT NULL DEFAULT 12,       -- ventana para reprogramar solo
  ADD COLUMN payment_mode           text NOT NULL DEFAULT 'en_sede'     -- 'gateway' | 'manual' | 'en_sede'
                                     CHECK (payment_mode IN ('gateway','manual','en_sede')),
  ADD COLUMN repeat_trial_price     numeric(10,2),                      -- NULL = no permite repetir
  ADD COLUMN price_first_trial      numeric(10,2);                      -- si es distinto del `price` general

-- trial_class_bookings: 1 columna nueva -- falta un lugar para "hijo YA registrado"
ALTER TABLE public.trial_class_bookings
  ADD COLUMN child_id uuid REFERENCES public.children(id);
  -- mutuamente excluyente con unregistered_athlete_id (CHECK a definir en la migración:
  -- exactamente uno de child_id / unregistered_athlete_id / (enrollment_id ya inscrito) no-nulo)
```

**Por qué `child_id` y no reusar `enrollment_id`:** un hijo ya inscrito en fútbol que quiere
**probar** natación no tiene ningún `enrollment` de natación todavía — es justamente lo que
la prueba precede. `enrollment_id` sigue existiendo para el caso (raro, pero posible) de que
la prueba sea sobre la MISMA disciplina en la que ya tiene una inscripción vigente (ej.
cambiar de sede/coach).

**Detección de "primera vez" en la escuela** — mismo patrón que ya usa
`school_courtesy_settings` para saber si alguien ya usó su cortesía: una función
`SECURITY DEFINER` que cuenta `trial_class_bookings` previas para
`(school_id, COALESCE(child_id, unregistered_athlete_id))` — **sin** `category_id`, cualquier
disciplina previa ya cuenta como "usada" — filtrando estados `agendada`/`realizada`/
`convertida` (una cancelada no cuenta como "ya usada").

### 4.2 RPCs nuevas (self-service, distintas de las del owner)

Las RPCs del owner (`trial_class_create`, etc.) validan `is_school_admin` — no sirven tal
cual para el padre. Se necesitan versiones propias, incluso si internamente comparten
lógica:

- `trial_class_self_create(...)` — valida que quien llama sea el padre del `child_id` o el
  propio atleta (`auth.uid()`), o que esté creando un `unregistered_athlete` propio (mismo
  patrón anti-abuso que ya usa `enrolled_unregistered` en `SEG-20`). Calcula el precio
  (primera vez vs repetición) y arma el `payments` pending si `payment_mode='manual'`.
- `trial_class_self_reschedule(...)` — mismo patrón de `session_booking_reschedule`
  (advisory lock + upsert atómico), **más** el chequeo de `reschedule_cutoff_hours`: si
  faltan menos horas que el cutoff, rechaza con un motivo explícito (`too_late_to_reschedule`)
  para que el frontend diga "contactá a la escuela".
- `trial_class_self_cancel(...)` — igual de simple que la cancelación que ya tiene el padre
  para clases de plan.

### 4.3 BFF

Nuevo router `bff/src/routes/trial-classes-self.routes.ts`, montado en
`/api/v1/trial-classes-self`, con `requireAuth` (padre/atleta, **no** `requireOwnerOrAdmin`):
`POST /` (crear), `PATCH /:id/reschedule`, `PATCH /:id/cancel`, `GET /slots` (disponibilidad
por categoría, mismo patrón que `GET /courtesy/slots` de `reservations-admin.routes.ts`).

### 4.4 Frontend

En `MyEnrollmentsPage.tsx`: una entrada nueva ("Agendar clase de prueba") visible solo si
`self_service_enabled` está prendido para la escuela — para un hijo ya inscrito (elige
disciplina distinta a la actual) o para agregar un hermano nuevo (formulario corto: nombre +
fecha de nacimiento, reusa el patrón de alta de menor que ya existe en otros flujos). Muestra
el precio (primero vs repetición) **antes** de confirmar.

---

## 5. Fases de construcción

| Fase | Entregable |
|---|---|
| **1 · Backend** ✅ | Migraciones [20260829020235](../../supabase/migrations/20260829020235_trial_class_self_service_backend.sql) + [20260829021014](../../supabase/migrations/20260829021014_trial_class_self_create_payment_period_conflict.sql) (fix, ver §7.4). 6 RPCs (`trial_class_self_service_save_settings`, `trial_class_self_is_first`, `trial_class_self_get_joint_slots`, `trial_class_self_create`, `trial_class_self_reschedule`, `trial_class_self_cancel`), todas `service_role`-only. **Probado en vivo** (transacciones con `ROLLBACK`, sin dejar rastro): sujeto `child_id` con padre correcto/incorrecto, sujeto `self`, primera-vez vs repetición (bloqueada y permitida con precio propio), reprogramar dentro y fuera de la ventana de corte, cancelar, cobro `manual` (nace `payments` pending). `npm run seguridad:invariantes` sin violaciones críticas. |
| **2 · BFF** | `trial-classes-self.routes.ts` + templates de email (confirmación/reprogramación ya existen, solo reusar) |
| **3 · Frontend** | Entrada en `MyEnrollmentsPage.tsx` + flujo de precio/confirmación |
| **4 · QA local** | Los tres escenarios de §2 probados en la misma escuela: owner, público anónimo, padre logueado — que no se pisen entre sí (mismo slot, mismo `category_id`) |

---

## 6. Checklist de convenciones del repo (no romper)

- [ ] Migraciones nuevas, nunca editar/borrar existentes; `npm run migrations:new -- <slug>`
- [ ] `SET search_path = pg_catalog, public, pg_temp` en toda función nueva
- [ ] `GRANT EXECUTE` explícito — estas RPCs las llama el BFF con `service_role`, **no**
      `anon`/`authenticated` directo (mismo patrón que `SEG-20`/`SEG-21`)
- [ ] RLS sin self-recursion
- [ ] `text + CHECK` para `payment_mode`, no `CREATE TYPE`
- [ ] Capacidad/slot protegido por `pg_advisory_xact_lock` + upsert atómico, no por
      validación previa en el BFF (misma doctrina que `agenda-publica-reservas.md` §3.2)
- [ ] `npm run seguridad:invariantes` sin violaciones críticas después de cada migración
- [ ] Reusar `chargeRegistrationFeeIfApplicable` (o extraerlo a helper compartido) para el
      modo `manual` — no reinventar el cobro pendiente

---

## 7. Preguntas abiertas / riesgos que quedan para cuando se apruebe

1. **Menor de edad sin acudiente en la sesión:** si el "hermano nuevo" es menor, ¿quién firma
   consentimiento/datos médicos al momento de la prueba, o eso se difiere hasta la
   conversión real (como hoy)? Se propone: **diferir**, igual que las clases de prueba del
   owner hoy (`is_minor`/`child_name` ya existen, sin exigir más datos en la prueba).
2. **`payment_mode='gateway'` sin pasarela conectada:** si la escuela elige `gateway` pero no
   tiene `payment_provider` activo, la UI debe bloquear esa opción en Ajustes, no fallar en
   tiempo de agendamiento.
4. **Encontrado probando Fase 1 en vivo (resuelto):** cuando el sujeto es `p_self` (el propio adulto) y ya tiene un cobro `payments` activo ese mes calendario, el `INSERT` del cobro de la prueba chocaba con el índice único `uniq_payment_active_period_per_adult` — error crudo de Postgres (`23505`), transacción revertida por completo (correcto) pero con un mensaje inservible para el usuario. Solo afecta el camino `p_self`; `child_id`/`unregistered_athlete_id` no están cubiertos por ese índice. Fix en [20260829021014](../../supabase/migrations/20260829021014_trial_class_self_create_payment_period_conflict.sql): se atrapa `unique_violation` puntual y se re-lanza como `payment_period_conflict: ...` — mismo prefijo reconocible que `too_late_to_reschedule:`, para que el BFF (Fase 2) pueda mostrar "coordiná el pago con la escuela" en vez del error de Postgres.

3. **Qué pasa con el `trial_offering_plan_id` (lazy-init) cuando hay dos precios:** hoy es un
   solo plan $0/1-sesión. Con precio primera-vez vs repetición, ¿es el mismo
   `offering_plan_id` con `monthly_fee` distinto por `enrollment`, o dos planes lazy-init
   distintos? Se propone: **mismo plan, precio va en `payments.amount`** (el plan es solo el
   vehículo de la sesión, igual que hoy) — a confirmar.
