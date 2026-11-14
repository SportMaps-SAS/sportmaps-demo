# Plan de cierre — 4 policies `FOR ALL` sin `WITH CHECK` (2026-10-27)

> **Estado: MIGRACIÓN ESCRITA, SIN APLICAR.** Decisiones aprobadas: todas las recomendadas (D1.1 A, D1.2 RPC, D1.3 sí, D1.4 en este lote, D2.1 policies con alcance, D2.2 no, D2.3 desmontar, D2.4 no, D3.1 policies + BFF, D3.2 sí, D3.3 a futuro, D3.4 sí, D4.1 A).
> Migración `supabase/migrations/20261027124411_cierre_policies_autoadjudicables.sql` (rama `sec/policies-1027`). Copia para pegar y verificación en `docs/migraciones-pendientes-2026-10-27/`.
> Verificación en vivo hecha hoy con `SELECT` puntuales sobre `pg_policies`, `pg_proc`, `pg_attribute`, `pg_constraint`, `pg_trigger`.

## Estado por punto (2026-10-27)

| Punto | Estado | Dónde |
|---|---|---|
| 1. `event_organizers` — solo SELECT propio (+ plataforma), sin escritura del cliente, trigger `guard_event_organizers_verificacion`, RPC `verificar_organizador(p_profile_id, p_verificado)` con `is_platform_admin()` | **En la migración** | §1 |
| D1.3 — `is_verified` fuera del upsert de `POST /organizer/profile` | **Hecho en BFF** | `bff/src/routes/organizers.route.ts` + test |
| D1.4 — `events`: `events_all_access` borrada; `events_update_own` con `WITH CHECK`; `events_insert_authenticated` exige organizador verificado o plataforma; anon sin escritura | **En la migración** | §2 |
| D1.4 — guarda de `events.status` para organizadores no verificados y `events_select_authenticated USING(true)` | **FUERA — pregunta abierta** (ver "Events: lo que queda") | — |
| 2. `athlete_training_plans` — policies con alcance (staff + atleta inscrito; admin solo lee/borra; sin `unregistered`) | **En la migración** | §4 |
| D2.3 — `bff/src/routes/trainer/training-plans.ts` desmontada de `index.ts` (el archivo queda para reescribirlo) | **Hecho en BFF** | `bff/src/index.ts` + test |
| 3. `biomech_access_grants` — policies por comando con `es_staff_de_escuela` + `es_miembro_o_inscrito_de_escuela` | **En la migración** | §5 |
| D3.1 — misma validación en `POST /athlete/biomech/grants` | **Hecho en BFF** | `bff/src/routes/athlete/biomechAlcance.ts` + test |
| D3.4 — `bc_coach_read` / `ba_coach_read` / `bb_coach_read`: la rama del grant exige `bag.school_id ∈ user_staff_school_ids()` | **En la migración** | §6 |
| 4. `skill_biomech_evidence` — sin escritura del cliente (solo `sbe_adder_select` + `sbe_athlete_read`) | **En la migración** | §9 |
| Colateral 2 — `get_trainer_athlete_ids(uuid)` sin EXECUTE para `anon`/`PUBLIC` (ningún código la llama; la usan 15 policies TO authenticated) | **En la migración** | §0 |
| Colateral 6 — `bc_athlete_all`, `bc_athlete_update`, `bb_athlete_all` → una policy por comando con `WITH CHECK` (captura: escuela del atleta y sesión suya de esa escuela, función `puede_registrar_captura_biomecanica`; línea base: `athlete_id = auth.uid()`) | **En la migración** | §7–8 |
| Colateral 6 en el BFF — `POST /athlete/biomech/captures` valida escuela y sesión igual que la policy | **Hecho en BFF** | `biomechAlcance.ts` |
| GRANTs de `anon` | **En la migración**: `REVOKE ALL` en las 4 tablas; sin escritura en `events`, `biomech_captures`, `biomech_baselines` (anon conserva SELECT de `events` para el mapa público) | — |

Pruebas: `docs/migraciones-pendientes-2026-10-27/cierre-policies-autoadjudicables-verificar.sql` (48 pruebas, rollback siempre).

### Events: lo que queda (pregunta para ti)

Medido hoy: 12 eventos (6 `active`, 6 `draft`), 4 escuelas, 5 creadores, 0 filas en `event_organizers`. El único evento de organizador (`active`, `public`) es de un organizador **sin** perfil en `event_organizers`, o sea, sin verificar. El frontend escribe `events` directo en un solo punto: `EventManagementPage` → `useEvents.updateEvent` (abrir/cerrar inscripciones del propio evento). `useEvents.createEvent` no lo llama ninguna pantalla; todo lo demás va por BFF (service role).

- **Guarda de `status`** (que un organizador no verificado no pueda pasar su evento a `active` por PostgREST): rompería hoy a ese organizador el botón de abrir/cerrar inscripciones. ¿Lo verificamos primero (`verificar_organizador`) y luego cerramos con un trigger que solo deje cambiar `status` a `active` si `is_verified`, o pasamos `updateEvent` al BFF?
- **`events_select_authenticated USING(true)`**: cualquier autenticado lee todos los eventos, incluidos `draft` y `school_only`. Lo usan calendario del acudiente, explorar y gestión. ¿Se restringe a `public` + creador + miembros de `school_id` + escuelas invitadas?
- De paso: `events.status` tiene CHECK `draft|active|closed|cancelled|completed`, pero `POST /events/:id/publish` y `PATCH /events/:id/status` del BFF escriben `'published'` → esas dos rutas fallan siempre (y `POST /events` inserta `bank_data`, columna que `events` no tiene).

## Resumen

| Tabla | Policy abierta | Filas hoy | ¿Quién escribe en el código? | Riesgo real | Recomendación |
|---|---|---|---|---|---|
| `event_organizers` | `organizer_manage_own_profile` | 0 | Solo el BFF (service role). El frontend solo LEE. | **ALTO** — autoverificación: `is_verified=true` es el único gate para publicar eventos | Quitar escritura del cliente + trigger de guarda sobre `is_verified` |
| `athlete_training_plans` | `atp_trainer_all` | 0 | Nadie en la práctica (la ruta BFF del entrenador usa columnas que no existen) | **MEDIO** — inyección de contenido: un tercero le aparece como "plan activo" al atleta y a su acudiente | Policies separadas con alcance staff + atleta inscrito |
| `biomech_access_grants` | `bag_athlete_all` | 0 | Solo el BFF (service role), sin validar `coach_id`/`school_id` | **BAJO-MEDIO** — el atleta solo puede regalar SUS datos, pero a cualquier perfil, sin que sea coach ni de su escuela | Policies separadas: coach debe ser staff de una escuela del atleta; mismo arreglo en el BFF |
| `skill_biomech_evidence` | `sbe_adder_all` | 0 | Solo el BFF (service role), que sí valida | **MEDIO** — integridad: cualquiera vincula la captura de un atleta a la evaluación de otro; oráculo de existencia de IDs | Quitar escritura del cliente (o policies con alcance sobre progreso y captura) |

Hecho transversal: **las cuatro tablas tienen `GRANT arwdm` a `anon` y `authenticated`** y RLS activo (no forzado). `anon` no logra nada hoy porque `auth.uid()` es NULL, pero el GRANT sobra.

**El BFF usa el cliente con `SUPABASE_SERVICE_ROLE_KEY`** (`bff/src/config/supabase.ts`), así que salta RLS: ningún cambio de este plan rompe rutas del BFF. Y el frontend **no escribe directo** en ninguna de las cuatro tablas (solo lee `event_organizers`). Por eso el radio de producto de cerrar escritura del cliente es cero hoy.

---

## 1. `event_organizers.organizer_manage_own_profile`

### Hallazgo

`pg_policies` — **una sola policy** en la tabla:

| policy | cmd | roles | USING | WITH CHECK |
|---|---|---|---|---|
| `organizer_manage_own_profile` | ALL | {public} | `profile_id = auth.uid()` | — |

Columnas relevantes: `profile_id` (UNIQUE, FK `profiles`), `is_verified boolean default false`, `verification_doc_url`, `bank_data jsonb`, `nequi_number`, `whatsapp_number`, `payment_methods`, `qr_smart_enabled`. Sin triggers.

Cualquier usuario autenticado, por PostgREST directo:
```http
POST /rest/v1/event_organizers  { "profile_id": "<mi uid>", "is_verified": true, ... }
PATCH /rest/v1/event_organizers?profile_id=eq.<mi uid>  { "is_verified": true }
```
El `UPDATE` también pasa: sin `WITH CHECK`, la fila nueva se valida con el `USING` (`profile_id = auth.uid()`), que sigue siendo cierto.

### Uso en código

- **Frontend (solo lectura, cliente con JWT):**
  - `frontend/src/components/organizer/OrganizerGuard.tsx:26` — lee `is_verified` para mostrar/ocultar el banner "Verificación pendiente".
  - `frontend/src/pages/organizer/OrganizerSettingsPage.tsx:71`, `OrganizerProfilePage.tsx:41` — `select('*')` del propio perfil.
  - Las escrituras del frontend van al BFF: `PUT/POST /api/v1/organizer/profile` (`OrganizerSettingsPage.tsx:103,117,131`, `OrganizerProfilePage.tsx:67,108`, `OrganizerOnboardingPage.tsx:96,131`).
- **BFF (service role):**
  - `bff/src/routes/organizers.route.ts:28` `POST /profile` — `upsert` con `is_verified: false` fijo.
  - `organizers.route.ts:64` `PUT /profile` — `update` con el esquema zod parcial (no incluye `is_verified`, bien).
  - `bff/src/routes/events.route.ts:1634-1638` `POST /events/:id/publish` y `:1818` cambio de estado — **`is_verified` es el único gate para publicar** (`'Debes estar verificado para publicar eventos'`).
- No hay ninguna ruta ni pantalla de plataforma que ponga `is_verified = true`. Hoy solo se verifica a mano por SQL.

### Qué confía en sus filas

- `events.route.ts` (publicar eventos) confía en `is_verified`.
- `OrganizerGuard` confía en `is_verified` (solo UI).
- Ninguna policy de otra tabla lee `event_organizers` (verificado: búsqueda en `pg_policies.qual/with_check` y en `pg_proc.prosrc` → 0 resultados).

### Riesgo real — ALTO

Un usuario con rol `organizer` se autoverifica y publica eventos públicos (`GET /api/v1/events` lista `status='published'`), con su propio `bank_data`/`nequi_number` como destino de pago de las inscripciones. Es el escenario de fraude que la verificación existe para frenar.

**Hallazgo adyacente (fuera de estas 4, pero quita valor al cierre si no se atiende):** la tabla `events` tiene `events_insert_authenticated` (`WITH CHECK creator_id = auth.uid()`) y `events_all_access` (`FOR ALL` sin `WITH CHECK`, `USING creator_id = auth.uid() OR is_platform_admin()`). Es decir, un autenticado puede insertar/editar directo un evento con `status='published'` y `organizer_id` arbitrario sin pasar por el gate de `is_verified` del BFF. Y `events_select_authenticated` es `USING (true)`. Cerrar `is_verified` sin cerrar `events` deja la puerta de al lado abierta. Lo dejo como pregunta D1.4.

**Bug funcional de paso:** `POST /api/v1/organizer/profile` hace `upsert(... is_verified: false ...)` con `onConflict: 'profile_id'`. Si un organizador YA verificado vuelve a enviar el onboarding, **pierde la verificación**. El trigger de guarda propuesto abajo no lo arregla (el BFF es service role); hay que quitar `is_verified` del upsert o usar `ignoreDuplicates`/`insert` (D1.3).

### SQL propuesto (texto del plan)

```sql
-- 1) Quitar la policy abierta
DROP POLICY IF EXISTS organizer_manage_own_profile ON public.event_organizers;

-- 2) Lectura del propio perfil (lo que usan OrganizerGuard / Settings / Profile)
CREATE POLICY event_organizers_select_own ON public.event_organizers
  FOR SELECT TO authenticated
  USING (profile_id = (select auth.uid()) OR public.is_platform_admin());

-- 3) Escritura: OPCIÓN RECOMENDADA = ninguna policy de INSERT/UPDATE/DELETE para
--    el cliente. Todo pasa por el BFF (service role), que ya fija profile_id = req.user.id.
--    Si se decide permitir escritura directa (D1.1 opción B):
-- CREATE POLICY event_organizers_insert_own ON public.event_organizers
--   FOR INSERT TO authenticated
--   WITH CHECK (profile_id = (select auth.uid())
--               AND coalesce(is_verified, false) = false
--               AND exists (select 1 from public.profiles p
--                           where p.id = (select auth.uid()) and p.role = 'organizer'));
-- CREATE POLICY event_organizers_update_own ON public.event_organizers
--   FOR UPDATE TO authenticated
--   USING (profile_id = (select auth.uid()))
--   WITH CHECK (profile_id = (select auth.uid()));   -- is_verified lo protege el trigger
-- (sin DELETE para el cliente)

-- 4) Guarda de is_verified: solo plataforma (o service role / postgres) lo cambia.
--    Cubre también UPDATE directo si algún día se reabre escritura del cliente.
CREATE OR REPLACE FUNCTION public.guard_event_organizers_verificacion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER   -- a propósito: current_user debe ser el LLAMADOR
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin')
     OR auth.role() = 'service_role'
     OR public.is_platform_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.is_verified := false;
  ELSIF NEW.is_verified IS DISTINCT FROM OLD.is_verified THEN
    RAISE EXCEPTION 'is_verified solo lo cambia la plataforma' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_event_organizers_verificacion() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_guard_event_organizers_verificacion
  BEFORE INSERT OR UPDATE ON public.event_organizers
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_organizers_verificacion();

-- 5) Quitar GRANTs que sobran
REVOKE INSERT, UPDATE, DELETE ON public.event_organizers FROM anon, authenticated;  -- si D1.1 = A
REVOKE SELECT ON public.event_organizers FROM anon;
```

Nota: el trigger es `SECURITY INVOKER` a propósito. En un `SECURITY DEFINER`, `current_user` sería el dueño de la función (postgres) y la guarda dejaría pasar a todos. No necesita privilegios propios: solo lee `NEW/OLD` e invoca `is_platform_admin()`, que ya es DEFINER. Hay que probarlo con T1.3 antes de darlo por bueno.

### Decisiones para ti

- **D1.1** ¿El cliente puede escribir `event_organizers` directo, o todo va por el BFF?
  - **A (recomendada):** solo SELECT propio para el cliente; escritura solo BFF. Nadie la usa hoy desde el frontend.
  - B: INSERT/UPDATE propios con `WITH CHECK` + trigger.
- **D1.2** ¿Quién verifica organizadores? No existe flujo. ¿Lo hace un `platform_admin` desde una pantalla (pendiente) o seguimos por SQL? **Recomendada:** por ahora SQL con rastro (o RPC `verificar_organizador(p_id)` con gate `is_platform_admin()`), y el trigger deja pasar a plataforma.
- **D1.3** ¿Arreglamos el `upsert` del BFF que des-verifica al re-enviar onboarding? **Recomendada:** sí, quitar `is_verified` del objeto del upsert (el default de la columna ya es `false`).
- **D1.4** ¿Abrimos un ítem aparte para `events` (`events_all_access` sin `WITH CHECK`, `events_insert_authenticated` sin gate de organizador verificado, `events_select_authenticated USING(true)`)? **Recomendada:** sí, siguiente lote; sin eso el gate de `is_verified` se rodea insertando el evento directo.

### Radio

- Filas hoy: **0** → nadie pierde nada.
- Flujos: onboarding/perfil de organizador van por BFF (service role) → no se rompen. Las tres pantallas que leen siguen leyendo con `event_organizers_select_own`.
- Riesgo de romper: si algún otro rol necesitara leer `event_organizers` por RLS (hoy no puede: la única policy era la propia). Sin cambio.

### Pruebas (a ejecutar por ti, después de aplicar)

```sql
-- Preparar: un profile con role='organizer' que NO tenga fila en event_organizers
-- select id from profiles where role='organizer' and id not in (select profile_id from event_organizers) limit 1;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub','<UUID_ORGANIZADOR>','role','authenticated')::text, true);

-- T1.1 insertar autoverificado → debe FALLAR (42501) con D1.1=A; con D1.1=B debe quedar is_verified=false
INSERT INTO public.event_organizers (profile_id, organization_name, is_verified)
VALUES ('<UUID_ORGANIZADOR>', 'prueba', true);
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub','<UUID_CUALQUIERA>','role','authenticated')::text, true);
-- T1.2 insertar con profile_id ajeno → debe FALLAR
INSERT INTO public.event_organizers (profile_id) VALUES ('<UUID_AJENO>');
ROLLBACK;

-- T1.3 (como postgres/service role) crear fila, luego como el dueño intentar UPDATE is_verified → debe FALLAR o afectar 0 filas
BEGIN;
INSERT INTO public.event_organizers (profile_id, organization_name) VALUES ('<UUID_ORGANIZADOR>', 'prueba');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub','<UUID_ORGANIZADOR>','role','authenticated')::text, true);
UPDATE public.event_organizers SET is_verified = true WHERE profile_id = '<UUID_ORGANIZADOR>';
-- T1.4 el dueño SÍ lee su fila
SELECT profile_id, is_verified FROM public.event_organizers WHERE profile_id = '<UUID_ORGANIZADOR>';
ROLLBACK;

-- T1.5 anon no ve nada
BEGIN; SET LOCAL ROLE anon; SELECT count(*) FROM public.event_organizers; ROLLBACK;
```
Y prueba funcional por BFF: onboarding de organizador nuevo (`POST /api/v1/organizer/profile`) y edición (`PUT`) siguen respondiendo 200/201.

---

## 2. `athlete_training_plans.atp_trainer_all`

### Hallazgo

`pg_policies` — todas las de la tabla:

| policy | cmd | roles | USING | WITH CHECK |
|---|---|---|---|---|
| `atp_client_select` | SELECT | {public} | `client_id = auth.uid() AND status <> 'draft'` | — |
| `atp_parent_select` | SELECT | {public} | `client_id IN (select children.id from children where parent_id = auth.uid()) AND status <> 'draft'` | — |
| `atp_trainer_all` | ALL | {public} | `trainer_id = auth.uid()` | — |

Columnas: `school_id` (NOT NULL, FK `schools`), `trainer_id` (NOT NULL, **sin FK**), `client_id` (NOT NULL, **sin FK**), `client_type` (`registered|child|unregistered`), `status` (`draft|active|completed|paused`), `title`, `description`, `weekly_structure jsonb`, fechas. Trigger: `trg_atp_updated_at`.

Cualquier autenticado inserta `{trainer_id: <yo>, client_id: <víctima>, school_id: <cualquiera>, status: 'active', title: '...'}`.

### Uso en código

- **Frontend:** ninguno directo. La página `/training-plans` del frontend es otra cosa (sesiones del entrenador, `CoachSessionsV2`).
- **BFF (service role):**
  - `bff/src/routes/athlete/training.ts:313` `GET /api/v1/athlete/training/plan` — devuelve el plan `active` más reciente con `client_id = req.user.id`. **Confía en la fila sin mirar `trainer_id` ni `school_id`.**
  - `bff/src/routes/trainer/training-plans.ts` (`/api/v1/trainer/training-plans`, GET/POST/PUT/DELETE, montado con `requireTrainerAuth`) — **usa columnas que no existen** (`athlete_id`, `routine_id`, `scheduled_at`, `notes`) y `status: 'pending'` que viola el CHECK. Las cuatro rutas fallan siempre: es código muerto/roto. Además el `PUT` hace `update(req.body)` (asignación masiva: deja cambiar `trainer_id`, `client_id`) — no explota hoy solo porque la ruta no funciona. Ningún frontend la llama.

### Qué confía en sus filas

- `atp_client_select` / `atp_parent_select`: el atleta y el acudiente del menor ven cualquier plan no-draft con su `client_id`.
- `GET /api/v1/athlete/training/plan` (service role) se lo sirve al atleta como "su plan".

### Riesgo real — MEDIO

Inyección de contenido a terceros: un desconocido crea un plan `active` con texto/`weekly_structure` arbitrario y le aparece al atleta (y al acudiente si `client_id` es un `children.id`) como su plan de entrenamiento, con `school_id` de una escuela real. Vector de phishing/acoso a menores. No expone datos de la víctima (el atacante no lee nada nuevo: solo ve sus propias filas). Sin FK en `client_id`, se pueden sembrar filas basura para IDs que ni existen.

### Relación correcta que debe autorizar

`trainer_id = auth.uid()` **y** `school_id` es una escuela donde el que escribe **trabaja** (`user_staff_school_ids()`, que incluye dueños de escuela tipo `personal_trainer` vía `schools.owner_id`) **y** `client_id` es un atleta con inscripción activa en esa escuela (`get_trainer_athlete_ids(school_id)`, que cubre `enrollments.user_id` y `enrollments.child_id`). La administración de la escuela también puede gestionar (`user_admin_school_ids()`).

### SQL propuesto (texto del plan)

```sql
DROP POLICY IF EXISTS atp_trainer_all ON public.athlete_training_plans;

-- Lectura del entrenador y de la administración de la escuela
CREATE POLICY atp_staff_select ON public.athlete_training_plans
  FOR SELECT TO authenticated
  USING (trainer_id = (select auth.uid())
         OR school_id = ANY ((select public.user_admin_school_ids())));

-- INSERT: el que escribe es el trainer, trabaja en la escuela y el cliente está inscrito ahí
CREATE POLICY atp_trainer_insert ON public.athlete_training_plans
  FOR INSERT TO authenticated
  WITH CHECK (
    trainer_id = (select auth.uid())
    AND school_id = ANY ((select public.user_staff_school_ids()))
    AND client_id IN (select public.get_trainer_athlete_ids(school_id))
  );

-- UPDATE: USING decide qué filas toca; WITH CHECK impide moverla a otro trainer/escuela/cliente
CREATE POLICY atp_trainer_update ON public.athlete_training_plans
  FOR UPDATE TO authenticated
  USING (trainer_id = (select auth.uid())
         AND school_id = ANY ((select public.user_staff_school_ids())))
  WITH CHECK (
    trainer_id = (select auth.uid())
    AND school_id = ANY ((select public.user_staff_school_ids()))
    AND client_id IN (select public.get_trainer_athlete_ids(school_id))
  );

-- DELETE: el trainer en una escuela donde sigue trabajando, o la administración
CREATE POLICY atp_trainer_delete ON public.athlete_training_plans
  FOR DELETE TO authenticated
  USING ((trainer_id = (select auth.uid())
          AND school_id = ANY ((select public.user_staff_school_ids())))
         OR school_id = ANY ((select public.user_admin_school_ids())));

REVOKE INSERT, UPDATE, DELETE ON public.athlete_training_plans FROM anon;
```

Nota: `atp_client_select` y `atp_parent_select` se quedan (son SELECT, alcance correcto). Sugerencia menor: pasarlas de `{public}` a `{authenticated}`.

### Decisiones para ti

- **D2.1** ¿El cliente escribe directo o solo el BFF? Hoy nadie escribe. **Recomendada:** dejar las policies con alcance de arriba (el módulo de planes de entrenador personal las va a necesitar y quedan correctas), o si prefieres lo mínimo, cerrar escritura del cliente del todo.
- **D2.2** `client_type = 'unregistered'`: un cliente no registrado no tiene `enrollments` → la policy lo bloquea. ¿Se permite plan para no registrados? **Recomendada:** no por ahora (0 filas, ningún flujo lo crea); si se necesita, va por RPC `SECURITY DEFINER`.
- **D2.3** ¿Borramos o reescribimos `bff/src/routes/trainer/training-plans.ts` (rota, columnas inexistentes, `update(req.body)` masivo)? **Recomendada:** desmontarla de `index.ts:516` hasta que se reescriba con whitelist de campos.
- **D2.4** ¿El admin de la escuela puede crear planes a nombre de un entrenador? **Recomendada:** no (`trainer_id = auth.uid()` siempre); el admin solo lee y borra.

### Radio

- Filas hoy: **0**.
- Flujos: `GET /api/v1/athlete/training/plan` lee con service role → sin cambio. Rutas del trainer ya están rotas → sin cambio. Ninguna pantalla escribe directo.

### Pruebas

```sql
-- Datos: un coach con school_staff/school_members activo en <ESCUELA>, un atleta con enrollment activo en <ESCUELA>,
-- y un tercero cualquiera sin relación.
-- select school_id, user_id, child_id from enrollments where status='active' limit 5;

BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub','<UUID_TERCERO>','role','authenticated')::text, true);
-- T2.1 tercero crea plan para atleta ajeno → debe FALLAR (42501)
INSERT INTO public.athlete_training_plans (school_id, trainer_id, client_id, title, status)
VALUES ('<ESCUELA>', '<UUID_TERCERO>', '<UUID_ATLETA>', 'x', 'active');
ROLLBACK;

BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub','<UUID_COACH>','role','authenticated')::text, true);
-- T2.2 coach de la escuela con atleta inscrito → debe PASAR
INSERT INTO public.athlete_training_plans (school_id, trainer_id, client_id, title, status)
VALUES ('<ESCUELA>', '<UUID_COACH>', '<UUID_ATLETA>', 'x', 'active') RETURNING id;
-- T2.3 mismo coach, atleta NO inscrito en esa escuela → debe FALLAR
INSERT INTO public.athlete_training_plans (school_id, trainer_id, client_id, title, status)
VALUES ('<ESCUELA>', '<UUID_COACH>', '<UUID_ATLETA_OTRA_ESCUELA>', 'x', 'active');
ROLLBACK;

BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub','<UUID_COACH>','role','authenticated')::text, true);
INSERT INTO public.athlete_training_plans (school_id, trainer_id, client_id, title, status)
VALUES ('<ESCUELA>', '<UUID_COACH>', '<UUID_ATLETA>', 'x', 'active');
-- T2.4 UPDATE moviendo client_id a ajeno → debe FALLAR (WITH CHECK)
UPDATE public.athlete_training_plans SET client_id = '<UUID_ATLETA_OTRA_ESCUELA>' WHERE trainer_id = '<UUID_COACH>';
ROLLBACK;

BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub','<UUID_ACUDIENTE_O_ATLETA_DE_ESCUELA>','role','authenticated')::text, true);
-- T2.5 un acudiente/atleta (está en user_school_ids pero NO en user_staff_school_ids) → debe FALLAR
INSERT INTO public.athlete_training_plans (school_id, trainer_id, client_id, title, status)
VALUES ('<ESCUELA>', '<UUID_ACUDIENTE_O_ATLETA_DE_ESCUELA>', '<UUID_ATLETA>', 'x', 'active');
ROLLBACK;
```

---

## 3. `biomech_access_grants.bag_athlete_all`

### Hallazgo

`pg_policies` — todas las de la tabla:

| policy | cmd | roles | USING | WITH CHECK |
|---|---|---|---|---|
| `bag_athlete_all` | ALL | {public} | `athlete_id = auth.uid()` | — |
| `bag_coach_read` | SELECT | {public} | `coach_id = auth.uid()` | — |

Columnas: `athlete_id` (FK `profiles`), `coach_id` (FK `profiles`), `school_id` (FK `schools`), `is_active`, `granted_at`, `expires_at`. UNIQUE `(athlete_id, coach_id, school_id)`.

### Uso en código

- **Frontend:** ninguno (no hay pantalla de concesión de accesos).
- **BFF (service role):**
  - `bff/src/routes/athlete/biomech.ts:245` `POST /api/v1/athlete/biomech/grants` — `upsert` con `athlete_id = req.user.id` pero **`coach_id` y `school_id` tal como vienen del body, sin validar**. Mismo defecto que la policy, por el BFF.
  - `athlete/biomech.ts:228` GET y `:265` DELETE (revoca con `is_active=false`, filtrando por `athlete_id`). Correcto.
  - `bff/src/routes/trainer/biomech.ts:245` `GET /trainer/biomech/baselines/:athleteId` — un grant activo con `coach_id = trainer` y `school_id = req.schoolId` abre el baseline.
  - `trainer/biomech.ts:342` `GET /trainer/biomech/grants`.

### Qué confía en sus filas

Abren lectura biomecánica al `coach_id`:
- `biomech_captures.bc_coach_read` (grant activo y no vencido por `athlete_id`)
- `biomech_analyses.ba_coach_read`
- `biomech_baselines.bb_coach_read`
- La ruta BFF de baselines del trainer.

### Riesgo real — BAJO-MEDIO

La policy obliga `athlete_id = auth.uid()`: **solo se pueden regalar datos propios**, no robar ajenos. El problema es que:
1. El destinatario puede ser **cualquier perfil**, no un coach y no de una escuela del atleta, y `school_id` es arbitrario (ensucia la vista del trainer, que filtra por `school_id`).
2. Para menores, `athlete_id` es el `profiles.id` del menor; si el menor tiene sesión propia, puede abrir sus datos biomecánicos (videos/keypoints) a un adulto cualquiera sin intervención del acudiente.
3. El atleta puede reactivar (`is_active=true`) o extender `expires_at` — eso es legítimo, es su consentimiento.

### Relación correcta que debe autorizar

`athlete_id = auth.uid()` **y** `school_id` es una escuela de la que el atleta es miembro (`user_school_ids()`, correcto aquí porque es LECTURA de pertenencia, no permiso de escritura operativo) **y** `coach_id` trabaja en esa misma escuela. Para lo último no existe helper que reciba un perfil arbitrario y cubra `school_staff.coach_auth_id` (`_equipment_is_active_coach` solo mira `school_members.role='coach'` y no tiene EXECUTE para `authenticated`). Propongo uno nuevo.

### SQL propuesto (texto del plan)

```sql
-- Helper: ¿p_profile trabaja en p_school? Espejo de user_staff_school_ids() pero para otro perfil.
CREATE OR REPLACE FUNCTION public.es_staff_de_escuela(p_profile uuid, p_school uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.school_members sm
     WHERE sm.profile_id = p_profile AND sm.school_id = p_school
       AND sm.status = 'active' AND sm.role NOT IN ('parent','athlete','accountant')
    UNION ALL
    SELECT 1 FROM public.school_staff ss
     WHERE ss.coach_auth_id = p_profile AND ss.school_id = p_school AND ss.status = 'active'
    UNION ALL
    SELECT 1 FROM public.schools s WHERE s.id = p_school AND s.owner_id = p_profile
  );
$$;
REVOKE ALL ON FUNCTION public.es_staff_de_escuela(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_staff_de_escuela(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS bag_athlete_all ON public.biomech_access_grants;

CREATE POLICY bag_athlete_select ON public.biomech_access_grants
  FOR SELECT TO authenticated
  USING (athlete_id = (select auth.uid()));

CREATE POLICY bag_athlete_insert ON public.biomech_access_grants
  FOR INSERT TO authenticated
  WITH CHECK (
    athlete_id = (select auth.uid())
    AND school_id = ANY ((select public.user_school_ids()))
    AND public.es_staff_de_escuela(coach_id, school_id)
  );

-- UPDATE: el atleta solo activa/desactiva/cambia vencimiento de SUS grants;
-- no puede re-apuntar coach_id/school_id a alguien fuera de alcance.
CREATE POLICY bag_athlete_update ON public.biomech_access_grants
  FOR UPDATE TO authenticated
  USING (athlete_id = (select auth.uid()))
  WITH CHECK (
    athlete_id = (select auth.uid())
    AND school_id = ANY ((select public.user_school_ids()))
    AND public.es_staff_de_escuela(coach_id, school_id)
  );

CREATE POLICY bag_athlete_delete ON public.biomech_access_grants
  FOR DELETE TO authenticated
  USING (athlete_id = (select auth.uid()));

-- bag_coach_read se queda; sugerencia: pasarla a TO authenticated.
REVOKE INSERT, UPDATE, DELETE ON public.biomech_access_grants FROM anon;
```

Y en el BFF (`athlete/biomech.ts:245`): antes del upsert, validar con la misma regla (llamar `es_staff_de_escuela` vía RPC con service role o consultar `school_staff`/`school_members`), o pasar a un cliente con el JWT del usuario para que la policy haga el trabajo.

Ojo: `es_staff_de_escuela(p_profile, p_school)` con `authenticated` como llamador es un **oráculo**: permite preguntar "¿X trabaja en Y?" para cualquier par. Es información de baja sensibilidad (los coaches de una escuela suelen ser públicos en `v_school_staff_publico`), pero hay que decidirlo (D3.2).

Mejora opcional de las tres policies lectoras (`bc_coach_read`, `ba_coach_read`, `bb_coach_read`): agregar `AND public.es_staff_de_escuela(bag.coach_id, bag.school_id)` para que un grant viejo deje de abrir datos cuando el coach sale de la escuela. No es requisito de este cierre.

### Decisiones para ti

- **D3.1** ¿Escritura del cliente o solo BFF? **Recomendada:** policies con alcance de arriba (es una acción del atleta sobre sus datos; tiene sentido en RLS) **más** la misma validación en el BFF.
- **D3.2** ¿Aceptas el helper `es_staff_de_escuela` con EXECUTE a `authenticated` (oráculo de pertenencia)? **Recomendada:** sí; alternativa: no darle EXECUTE y mover INSERT/UPDATE a una RPC `otorgar_acceso_biomecanico(p_coach, p_school, p_expires)` SECURITY DEFINER.
- **D3.3** Menores con sesión propia: ¿el grant de un menor requiere al acudiente? **Recomendada:** sí a futuro (RPC que acepte `athlete_id` de un hijo si `children.parent_id = auth.uid()`), fuera de este cierre; hoy no hay pantalla.
- **D3.4** ¿Agregamos la condición de pertenencia vigente del coach a `bc_coach_read`/`ba_coach_read`/`bb_coach_read`? **Recomendada:** sí, en el mismo lote (0 grants, cero radio).

### Radio

- Filas hoy: **0** grants → ninguna lectura de coach depende de grants hoy.
- Flujos: no hay pantalla. Rutas BFF son service role → sin cambio. Si se aplica D3.4 tampoco cambia nada hoy (0 filas).

### Pruebas

```sql
-- Datos: atleta A miembro activo de <ESCUELA>; coach C staff activo de <ESCUELA>; perfil X sin relación; <OTRA_ESCUELA>.
BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub','<UUID_A>','role','authenticated')::text, true);
-- T3.1 A → C en su escuela → PASA
INSERT INTO public.biomech_access_grants (athlete_id, coach_id, school_id) VALUES ('<UUID_A>','<UUID_C>','<ESCUELA>');
-- T3.2 A → X (no staff) → FALLA
INSERT INTO public.biomech_access_grants (athlete_id, coach_id, school_id) VALUES ('<UUID_A>','<UUID_X>','<ESCUELA>');
ROLLBACK;

BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub','<UUID_A>','role','authenticated')::text, true);
-- T3.3 A → C en una escuela de la que A no es miembro → FALLA
INSERT INTO public.biomech_access_grants (athlete_id, coach_id, school_id) VALUES ('<UUID_A>','<UUID_C>','<OTRA_ESCUELA>');
ROLLBACK;

BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub','<UUID_X>','role','authenticated')::text, true);
-- T3.4 X se crea grant con athlete_id ajeno → FALLA
INSERT INTO public.biomech_access_grants (athlete_id, coach_id, school_id) VALUES ('<UUID_A>','<UUID_X>','<ESCUELA>');
ROLLBACK;

BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub','<UUID_A>','role','authenticated')::text, true);
INSERT INTO public.biomech_access_grants (athlete_id, coach_id, school_id) VALUES ('<UUID_A>','<UUID_C>','<ESCUELA>');
-- T3.5 re-apuntar el grant a X → FALLA (WITH CHECK)
UPDATE public.biomech_access_grants SET coach_id = '<UUID_X>' WHERE athlete_id = '<UUID_A>';
-- T3.6 desactivar → PASA
UPDATE public.biomech_access_grants SET is_active = false WHERE athlete_id = '<UUID_A>';
ROLLBACK;

-- T3.7 helper sin EXECUTE para anon
BEGIN; SET LOCAL ROLE anon; SELECT public.es_staff_de_escuela('<UUID_C>','<ESCUELA>'); ROLLBACK;  -- debe dar permission denied
```

---

## 4. `skill_biomech_evidence.sbe_adder_all`

### Hallazgo

`pg_policies` — todas las de la tabla:

| policy | cmd | roles | USING | WITH CHECK |
|---|---|---|---|---|
| `sbe_adder_all` | ALL | {public} | `added_by = auth.uid()` | — |
| `sbe_athlete_read` | SELECT | {public} | `EXISTS (biomech_captures bc WHERE bc.id = capture_id AND bc.athlete_id = auth.uid())` | — |

Columnas: `academic_progress_id` (FK `academic_progress`, NOT NULL), `capture_id` (FK `biomech_captures`, NOT NULL), `added_by` (FK `profiles`, nullable, `ON DELETE SET NULL`). UNIQUE `(academic_progress_id, capture_id)`.

Cualquier autenticado inserta `{added_by: <yo>, academic_progress_id: <evaluación de otro>, capture_id: <captura de otro>}`.

### Uso en código

- **Frontend:** ninguno directo.
- **BFF (service role):**
  - `bff/src/routes/trainer/biomech.ts:266` `POST /api/v1/trainer/biomech/skills/:progressId/evidence` — **sí valida**: el progreso es del coach y de su escuela, la captura es de su escuela y de un `trainer_session_plans` suyo. Esa es la relación correcta y sirve de modelo para la policy.
  - `trainer/biomech.ts:320` DELETE — filtra por `added_by = coachId`.

### Qué confía en sus filas

- `sbe_athlete_read`: el atleta dueño de la captura ve la evidencia.
- Cualquier lectura de evidencias de un `academic_progress` (informes de habilidades/evaluación) mostraría la captura vinculada como evidencia de esa evaluación.

### Riesgo real — MEDIO (integridad)

1. **Integridad:** vincular la captura de un atleta a la evaluación de otro, o capturas ajenas a cualquier evaluación. Si un informe une evidencia → captura con service role, se mostraría la captura (video/métricas) de A dentro de la evaluación de B: fuga cruzada vía el BFF.
2. **Oráculo:** el error de FK distingue "ese `academic_progress_id`/`capture_id` existe" de "no existe"; el UNIQUE distingue "ya está vinculado".
3. El atacante no lee capturas ajenas directamente: `biomech_captures` sigue protegida por sus propias policies.

### Relación correcta que debe autorizar

`added_by = auth.uid()` **y** el que escribe tiene alcance de staff sobre la escuela del progreso (`academic_progress.school_id ∈ user_staff_school_ids()`, y además es su coach o es admin de esa escuela) **y** la captura es del mismo atleta y de la misma escuela que el progreso (`bc.school_id = ap.school_id` y `bc.athlete_id ∈ {ap.user_id, ap.child_id}`). Como esto lee dos tablas con RLS propia, va en una función `SECURITY DEFINER`.

### SQL propuesto (texto del plan)

```sql
CREATE OR REPLACE FUNCTION public.puede_vincular_evidencia_biomecanica(p_progress uuid, p_capture uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.academic_progress ap
      JOIN public.biomech_captures bc ON bc.id = p_capture
     WHERE ap.id = p_progress
       AND bc.school_id = ap.school_id
       AND bc.athlete_id IN (ap.user_id, ap.child_id)
       AND ap.school_id = ANY (public.user_staff_school_ids())
       AND (ap.coach_id = auth.uid()
            OR ap.school_id = ANY (public.user_admin_school_ids()))
  );
$$;
REVOKE ALL ON FUNCTION public.puede_vincular_evidencia_biomecanica(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.puede_vincular_evidencia_biomecanica(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS sbe_adder_all ON public.skill_biomech_evidence;

CREATE POLICY sbe_adder_select ON public.skill_biomech_evidence
  FOR SELECT TO authenticated
  USING (added_by = (select auth.uid()));

CREATE POLICY sbe_staff_insert ON public.skill_biomech_evidence
  FOR INSERT TO authenticated
  WITH CHECK (
    added_by = (select auth.uid())
    AND public.puede_vincular_evidencia_biomecanica(academic_progress_id, capture_id)
  );

-- Sin UPDATE: la fila es un vínculo; para cambiarla se borra y se crea otra.

CREATE POLICY sbe_staff_delete ON public.skill_biomech_evidence
  FOR DELETE TO authenticated
  USING (
    added_by = (select auth.uid())
    AND public.puede_vincular_evidencia_biomecanica(academic_progress_id, capture_id)
  );

-- sbe_athlete_read se queda; sugerencia: pasarla a TO authenticated.
REVOKE INSERT, UPDATE, DELETE ON public.skill_biomech_evidence FROM anon;
REVOKE UPDATE ON public.skill_biomech_evidence FROM authenticated;
```

Nota: el BFF hoy exige además que la captura venga de un `trainer_session_plans` del propio coach. La función de arriba es un poco más amplia (cualquier captura del mismo atleta en la misma escuela). Ver D4.2.

### Decisiones para ti

- **D4.1** ¿Escritura del cliente o solo BFF? **Recomendada:** **cerrar escritura del cliente del todo** (solo `sbe_adder_select` + `sbe_athlete_read`, sin INSERT/DELETE): el BFF ya valida bien, ninguna pantalla escribe directo y así no hace falta la función nueva. El SQL con alcance de arriba queda como opción B.
- **D4.2** Si va la opción B: ¿la captura debe venir de una sesión del propio coach (como exige el BFF) o basta que sea del mismo atleta y escuela (capturas voluntarias del atleta)? **Recomendada:** mismo atleta + misma escuela (las capturas `source='voluntary'` no tienen `session_plan_id` y el BFF hoy las rechaza, lo que parece más una limitación que una regla).
- **D4.3** ¿El admin de la escuela puede vincular evidencia a evaluaciones de un coach? **Recomendada:** sí (incluido en la función).

### Radio

- Filas hoy: **0**.
- Flujos: el único que escribe es el BFF (service role) → sin cambio.

### Pruebas

```sql
-- Datos: coach C dueño de academic_progress <AP_C> en <ESCUELA>; captura <CAP_MISMO_ATLETA> del atleta de <AP_C> en <ESCUELA>;
-- captura <CAP_OTRO_ATLETA>; usuario X sin relación.
-- select ap.id, ap.coach_id, ap.school_id, ap.user_id, ap.child_id from academic_progress ap limit 5;
-- select id, athlete_id, school_id from biomech_captures limit 5;

BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub','<UUID_X>','role','authenticated')::text, true);
-- T4.1 X vincula a progreso ajeno → FALLA
INSERT INTO public.skill_biomech_evidence (academic_progress_id, capture_id, added_by)
VALUES ('<AP_C>', '<CAP_MISMO_ATLETA>', '<UUID_X>');
ROLLBACK;

BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub','<UUID_C>','role','authenticated')::text, true);
-- T4.2 C vincula captura de OTRO atleta a su progreso → FALLA
INSERT INTO public.skill_biomech_evidence (academic_progress_id, capture_id, added_by)
VALUES ('<AP_C>', '<CAP_OTRO_ATLETA>', '<UUID_C>');
-- T4.3 (solo opción B) C vincula captura del mismo atleta → PASA; con opción A → FALLA
INSERT INTO public.skill_biomech_evidence (academic_progress_id, capture_id, added_by)
VALUES ('<AP_C>', '<CAP_MISMO_ATLETA>', '<UUID_C>');
-- T4.4 UPDATE → FALLA (sin policy/grant)
UPDATE public.skill_biomech_evidence SET capture_id = '<CAP_OTRO_ATLETA>' WHERE added_by = '<UUID_C>';
ROLLBACK;
```
Más la prueba funcional del BFF: `POST /api/v1/trainer/biomech/skills/:progressId/evidence` sigue devolviendo 201.

---

## Hallazgos colaterales (no son de estas 4, anotados para el siguiente lote)

1. **`events`**: `events_all_access` es `FOR ALL` sin `WITH CHECK`; `events_insert_authenticated` no exige organizador verificado; `events_select_authenticated` es `USING(true)`. Rodea el gate de `is_verified` (ver D1.4).
2. **`get_trainer_athlete_ids(p_school_id)`** tiene EXECUTE para **`anon`** y devuelve los IDs de atletas inscritos de cualquier escuela: enumeración sin autenticación. Revocar de `anon` (y valorar si `authenticated` debe poder pasarle cualquier escuela).
3. **`bff/src/routes/trainer/training-plans.ts`**: rutas rotas (columnas inexistentes) y `PUT` con `update(req.body)` sin whitelist.
4. **`bff/src/routes/athlete/biomech.ts:245`**: concede grants sin validar `coach_id`/`school_id` (mismo defecto por service role).
5. **`bff/src/routes/organizers.route.ts:40`**: el `upsert` re-pone `is_verified=false` a un organizador ya verificado.
6. `biomech_captures` y `biomech_baselines` tienen también `bc_athlete_all` / `bb_athlete_all` `FOR ALL` sin `WITH CHECK` (`athlete_id = auth.uid()`), y `bc_athlete_update` sin `WITH CHECK`. Revisar en el lote biomecánico (el atleta puede inscribir capturas propias con `school_id`/`session_plan_id` arbitrarios, lo que a su vez alimenta `bc_coach_read` vía `trainer_session_plans`).

## Orden de aplicación sugerido (cuando apruebes)

1. Una sola migración por tabla o una sola para las cuatro (**una sola sesión aplicando**, regla de Disk IO). Crear con `npm run migrations:new -- cierre-4-policies-for-all`.
2. Aplicar por CLI/`apply_migration` (con rastro), no por SQL editor.
3. Correr las pruebas de este documento (todas en `BEGIN/ROLLBACK`).
4. `npm run seguridad:invariantes` — I3 debe dejar de reportar estas cuatro.
5. Regenerar `types.ts` solo al final, si cambió algo de tipos (aquí no debería).
