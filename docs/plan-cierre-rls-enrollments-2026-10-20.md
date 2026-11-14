# Plan — cierre del hueco de RLS en `public.enrollments` (2026-10-20)

> Estado: **PLAN, sin aplicar.** Nada de esto está en la base ni commiteado. Requiere aprobación
> antes de crear la migración (`npm run migrations:new -- cerrar-escritura-coach-enrollments`).
> Propuesta de id: **SEG-31** (último en docs: SEG-30).

## 1. Hallazgo (verificado contra la base viva, 2026-10-20)

Todas las policies de `public.enrollments` (`pg_policies`):

| cmd | policy | tipo | roles | USING | WITH CHECK |
|---|---|---|---|---|---|
| SELECT | Coaches can view enrollments of their teams | PERM | public | `team_id = ANY (coach_team_ids())` | — |
| SELECT | Enrollments: select athlete | PERM | public | `user_id = auth.uid()` | — |
| SELECT | Parents can view their children enrollments | PERM | public | `child_id IN (hijos de auth.uid())` | — |
| UPDATE | Enrollments: athlete cancel own | PERM | public | propio + `status='active'` | propio + `status='cancelled'` |
| UPDATE | Enrollments: parent cancel child | PERM | public | hijo + `status='active'` | hijo + `status='cancelled'` |
| **ALL** | **Staff can manage enrollments** | PERM | public | `is_school_admin(school_id) OR is_school_coach(school_id)` | **null** |
| DELETE/INSERT/UPDATE | trial_block_* | RESTRICTIVE | authenticated | `school_is_operational(school_id)` | ídem |

Helpers (`pg_proc`, en vivo):

- `is_school_admin(p_school_id)` — `school_members` con rol `owner/admin/school_admin`, activo. **No** cubre `schools.owner_id`.
- `is_school_coach(p_school_id)` — `school_members` con rol **`coach`** únicamente, activo.
  (Corrige `docs/coach-athlete-scoping.md:144`, que dice que devuelve true para owner/admin/coach: en vivo es solo `coach`.)
- `user_admin_school_ids()` — `owner/admin/school_admin/super_admin` activos **∪ `schools.owner_id`**. Superconjunto estricto de `is_school_admin`.

Grants: `anon` y `authenticated` tienen `SELECT, INSERT, UPDATE, DELETE` sobre la tabla (el default privilege viejo de SEG-23, no retroactivo).

**Consecuencia:** cualquier coach activo puede `INSERT/UPDATE/DELETE` **cualquier** inscripción de su escuela (no solo de sus equipos) directo por REST, saltándose los gates del BFF (`coach_can_enroll_paid_teams` en `POST /api/v1/enrollments`, `coach_can_edit_categories` en `bff/src/routes/students.ts`). Viola **I2** (escritura con un alcance que incluye a quien no administra) e **I3** (`FOR ALL` sin `WITH CHECK`). La policy no existe en ningún `.sql` del repo: entró por el editor.

Efecto de dinero: `trg_cancel_payments_on_enrollment_cancel` (AFTER UPDATE) anula cobros al cancelar una inscripción. Un coach que pulsa "Remover" **anula cobros pendientes** del atleta — algo que `canManageCharges` le prohíbe en la UI ("El coach NUNCA").

## 2. Radio medido

### Base (2026-10-20)

| | |
|---|---|
| Membresías `coach` activas que **pierden escritura** | 37, en 16 escuelas |
| De ellas, coaches que además son admin/dueño de la misma escuela | **0** |
| Membresías admin (`owner/admin/school_admin`) | 74 — no pierden nada (`user_admin_school_ids ⊇ is_school_admin`) |
| Dueños por `owner_id` sin membresía admin que **ganan** escritura | 305 escuelas, solo 1 con inscripciones (1 fila) — ajuste inofensivo |
| Funciones `SECURITY INVOKER` que escriben `enrollments` | **0** (todas las RPC que escriben son DEFINER o se llaman con service role) |
| Inscripciones totales / canceladas en últimos 30 días | 1 981 / 56 (no hay columna de autor: no se puede saber cuántas las hizo un coach) |

### BFF — no le afecta

Todas las escrituras a `enrollments` del BFF usan el cliente **service role** (`bff/src/config/supabase.ts`; `bulkUpload.ts` crea el suyo, también service role). Ninguna pasa por `userClient(req)`. Revisado: `enrollments.ts`, `students.ts`, `students-create-one.route.ts`, `public-booking.routes.ts`, `trainer/routines.ts`, `attendance.ts`, `session-bookings.ts`, `offerings.ts`, `athletes/bulkUpload.ts`.

Por eso **no se rompen**: walk-in / descuentos de asistencia (`attendance.ts`), cambio de categoría de Besser (`PUT /students/:id`), inscripción por coach (`POST /api/v1/enrollments`), link público, torniquete.

### Frontend — escrituras con el cliente del usuario

| # | Archivo | Operación | Quién llega | ¿Se rompe? |
|---|---|---|---|---|
| F1 | [EnrollTeamStudentModal.tsx:308](frontend/src/components/teams/EnrollTeamStudentModal.tsx:308) — "Remover" | `update status='cancelled'` | `/teams` **sin `allowedRoles`** → admin **y coach** | **Coach: sí** (es el objetivo). Admin: no. |
| F2 | [EnrollPlanStudentModal.tsx:248](frontend/src/components/enrollment/EnrollPlanStudentModal.tsx:248) — quitar de plan | `update status='cancelled'` | `OfferingsManagement` → `/offerings` (solo admin) | No |
| F3 | [classes.ts:281](frontend/src/lib/api/classes.ts:281) `unenrollStudent` | `update status='cancelled'` | `EnrollStudentModal` → `/programs-management` (solo admin) | No |
| F4 | [approvePayment.ts:97](frontend/src/lib/approvePayment.ts:97) | `update status='active'` | `/payments-automation` (solo admin, `canManageCharges`) | No |
| F5 | [PendingEnrollmentModal.tsx:51](frontend/src/components/dashboard/PendingEnrollmentModal.tsx:51) | `insert` | padre/atleta en `DashboardPage` | **Ya está roto hoy**: no hay policy de INSERT para padre/atleta. No cambia. |
| F6 | [usePrograms.ts:78](frontend/src/hooks/usePrograms.ts:78) `enrollInProgram` | `insert` | sin llamadores | Código muerto. No cambia. |

El resto de `.from('enrollments')` en `frontend/src` son `select`.

### Lectura — no se toca en este cambio

La policy `FOR ALL` es hoy la **única** que da a admin y coach la lectura de toda la escuela. Si se borra sin reemplazo, el admin no ve inscripciones y el coach solo ve las de sus equipos — y pantallas del coach como [EnrollTeamStudentModal.tsx:141](frontend/src/components/teams/EnrollTeamStudentModal.tsx:141) (que mira inscripciones en otros equipos para avisar del conflicto) dependen de lectura de escuela. Por eso la migración **conserva la lectura actual** tal cual; estrechar lo que lee un coach es un cambio aparte con su propio radio.

## 3. Cambio propuesto

### 3.1 Migración (nueva, no editar ninguna existente)

```sql
-- SEG-31: cierra la escritura de coaches sobre enrollments.
-- "Staff can manage enrollments" (FOR ALL, sin WITH CHECK, entró por el editor) daba
-- INSERT/UPDATE/DELETE a cualquier coach sobre todas las inscripciones de su escuela.
-- Se reemplaza por: lectura igual que hoy + escritura solo para administración.

DROP POLICY IF EXISTS "Staff can manage enrollments" ON public.enrollments;

-- Lectura: mismo alcance que la policy borrada (admin + coach de la escuela),
-- más el dueño por schools.owner_id. Estrechar al coach es otro cambio.
CREATE POLICY enrollments_staff_select ON public.enrollments
    FOR SELECT TO authenticated
    USING (school_id = ANY (public.user_admin_school_ids())
           OR public.is_school_coach(school_id));

CREATE POLICY enrollments_admin_insert ON public.enrollments
    FOR INSERT TO authenticated
    WITH CHECK (school_id = ANY (public.user_admin_school_ids()));

CREATE POLICY enrollments_admin_update ON public.enrollments
    FOR UPDATE TO authenticated
    USING      (school_id = ANY (public.user_admin_school_ids()))
    WITH CHECK (school_id = ANY (public.user_admin_school_ids()));

CREATE POLICY enrollments_admin_delete ON public.enrollments
    FOR DELETE TO authenticated
    USING (school_id = ANY (public.user_admin_school_ids()));

-- anon no tiene ninguna policy que le devuelva filas (todas dependen de auth.uid()),
-- pero conserva los grants del default privilege viejo (SEG-23). Se cierran.
REVOKE ALL ON public.enrollments FROM anon;
```

Revisión línea por línea:

- `DROP POLICY IF EXISTS` — el nombre exacto con comillas y espacios; `IF EXISTS` porque la policy no nació en el repo y la migración debe poder correr en una base limpia.
- **Una policy por comando, no `FOR ALL`** — elimina I3 por construcción y hace visible qué expresión valida qué.
- `TO authenticated` en vez de `public` — `anon` no tiene `auth.uid()`; restringir el rol deja el I1 imposible y alinea con las `trial_block_*`.
- `user_admin_school_ids()` (no `user_staff_school_ids()` ni `user_school_ids()`) — inscribir/cancelar dispara cobros (`emit_enrollment_fees`, `trg_cancel_payments_on_enrollment_cancel`): es dinero, no operación. Cumple I2. Es el mismo idiom que ya usan otras policies del repo.
- `is_school_coach()` solo en el `SELECT` — preserva la lectura de hoy. No hace `SELECT FROM enrollments` (lee `school_members`): sin self-recursion.
- `INSERT` con `WITH CHECK`: `trg_auto_enrollment_school_id` (BEFORE INSERT) completa `school_id` antes de evaluar el check, así que un insert sin `school_id` sigue funcionando para el admin.
- `UPDATE` con `USING` y `WITH CHECK` iguales — impide mover una inscripción a otra escuela.
- Las policies de padre/atleta (cancelar propio) y las RESTRICTIVE `trial_block_*` quedan intactas; siguen sumándose con OR / AND como hoy.
- No se revoca ningún helper (`is_school_admin`, `is_school_coach`, `user_admin_school_ids`) — regla del CLAUDE.md.
- No se crean funciones: no aplica `search_path` / `GRANT EXECUTE`.
- `REVOKE ALL … FROM anon` — riesgo nulo verificado: ninguna policy de la tabla devuelve filas a `anon` y ninguna función INVOKER escribe la tabla. Si se prefiere no mezclar, se puede sacar a su propia migración.

### 3.2 Frontend — "Remover" (F1)

Dos opciones; **recomiendo A** ahora:

- **A (recomendada):** ocultar "Remover" cuando `currentUserRole === 'coach'` y, para admin, cambiar `handleUnenroll` a `DELETE /api/v1/enrollments/:id` vía `bffClient` (ya existe, admin-only, filtra por `school_id`). Corregir el comentario de [EnrollTeamStudentModal.tsx:300-304](frontend/src/components/teams/EnrollTeamStudentModal.tsx:300) y el de [classes.ts:285](frontend/src/lib/api/classes.ts:285), que hoy afirman que la RLS ya lo rechaza.
- **B (si producto quiere que el coach saque atletas de sus equipos):** abrir `DELETE /api/v1/enrollments/:id` a `coach` con dos candados servidor: `team_id = ANY(equipos del coach)` y un toggle de escuela (análogo a `coach_can_edit_categories`). Ojo: cancelar anula cobros por trigger, así que el toggle es una decisión de dinero. Decisión de producto, ya anotada como pendiente en `docs/coach-athlete-scoping.md`.

F2–F4 no necesitan cambio (solo admin llegan). Opcional y de bajo valor: pasarlos también por el BFF por consistencia.

### 3.3 Orden de despliegue

1. Frontend A (ocultar para coach + Remover del admin por BFF) → Vercel. Inofensivo con la policy vieja todavía viva.
2. Migración por **CLI / `apply_migration`** (con rastro), desde **una sola sesión**. No regenerar `types.ts` (no cambia el esquema).
3. Verificación (sección 4) + `npm run seguridad:invariantes`.
4. Registrar SEG-31 en `docs/seguridad-escritura-rls-registro.md` y cerrar las notas pendientes de `docs/coach-athlete-scoping.md:140` y `docs/plan-club-carmel-2026-09.md:220`.

## 4. Verificación (después de aplicar)

Elegir un coach y un admin reales de la misma escuela (consultar por `school_members`, no listar tablas) y una inscripción activa de esa escuela de un equipo que **no** sea del coach. Todo dentro de una transacción con `ROLLBACK`:

```sql
-- 0) policies resultantes
select cmd, policyname, permissive, roles, qual, with_check
  from pg_policies where tablename = 'enrollments' order by cmd, policyname;

-- 1) COACH: lee, pero no escribe
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<coach_uuid>','role','authenticated')::text, true);
select public.user_admin_school_ids(), public.is_school_coach('<school_id>');   -- {} , true
select count(*) from public.enrollments where school_id = '<school_id>';           -- igual que antes (>0)
update public.enrollments set status = 'cancelled' where id = '<enrollment_id>'
  returning id;                                                                    -- 0 filas
insert into public.enrollments (school_id, child_id, team_id, status, start_date)
  values ('<school_id>', '<child_id>', '<team_id>', 'active', current_date);       -- ERROR 42501 (RLS)
rollback;

-- 2) ADMIN: lee y escribe en su escuela, no en otra
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<admin_uuid>','role','authenticated')::text, true);
update public.enrollments set status = 'cancelled' where id = '<enrollment_id>'
  returning id;                                                                    -- 1 fila
update public.enrollments set school_id = '<otra_school_id>' where id = '<enrollment_id>';
                                                                                   -- ERROR 42501 (WITH CHECK)
rollback;

-- 3) PADRE: sigue pudiendo cancelar a su hijo (policy intacta)
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<parent_uuid>','role','authenticated')::text, true);
update public.enrollments set status = 'cancelled'
 where child_id = '<hijo_id>' and status = 'active' returning id;                  -- ≥1 fila
rollback;

-- 4) ANON: nada
begin; set local role anon;
select count(*) from public.enrollments;                                           -- ERROR permission denied
rollback;
```

> El `ROLLBACK` es obligatorio: un `UPDATE` real a `cancelled` dispara `trg_cancel_payments_on_enrollment_cancel` y anula cobros.

Después: `npm run seguridad:invariantes` (I2/I3 sin hallazgos en `enrollments`) y prueba de humo en la UI — coach en `/teams` ya no ve "Remover"; admin sí, y la baja pasa por el BFF; walk-in de asistencia y cambio de categoría de Besser siguen funcionando (van por service role).

## 5. Fuera de alcance (anotado, no se toca aquí)

- **Lectura del coach a toda la escuela** vía `is_school_coach()`: se conserva; estrecharla a `coach_team_ids()` exige revisar pantallas del coach que miran otros equipos.
- **`PUT /students/:id`** lee el equipo sin `.eq('school_id', …)` y no consulta `coach_can_enroll_paid_teams` (ver `docs/coach-athlete-scoping.md`). Hueco del BFF, independiente de la RLS.
- **F5/F6**: inserción de inscripción por padre/atleta desde el cliente — ya falla hoy por RLS; `enrollInProgram` no tiene llamadores. Limpiar o mover al BFF.
