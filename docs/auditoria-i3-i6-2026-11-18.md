# Auditoría I3 (27 policies FOR ALL sin WITH CHECK) e I6 (1 vista) — 2026-11-18

Estado: SOLO ANÁLISIS. Nada se aplicó a la base. Borrador de migración (SIN APLICAR):
`docs/borradores/i3-with-check-2026-11-18.sql.borrador`.

Método: `invariantes_seguridad()` (27 I3 + 1 I6 + 14 I7, estas últimas fuera de este informe), definiciones
vivas leídas de `pg_policies` / `pg_proc` / `pg_get_viewdef` con `supabase db query --remote --read-only`
(consultas puntuales por nombre, sin listar catálogo) y conteos de filas. Las migraciones del repo no
sirven aquí: 15 de las 27 policies no figuran en ninguna migración (deriva), así que manda la base.

## Cómo leer el riesgo

Sin `WITH CHECK`, Postgres valida INSERT y el estado nuevo de UPDATE con la expresión del `USING`.
Entonces el riesgo no es "falta el CHECK", sino **qué columnas acota el USING**:
- USING que acota por `school_id` / `user_id` / `id` de la propia fila: el CHECK implícito ya es seguro.
  `ALTER POLICY … WITH CHECK (<mismo USING>)` es **idéntico en comportamiento** (radio de impacto = 0).
- USING que acota solo UNA columna cuando la fila tiene otras que apuntan a otro tenant, o que no limita
  qué estados puede escribir quien escribe: riesgo real.

Todas son `FOR ALL`, rol `{public}` salvo donde se indica; `anon` no pasa porque `auth.uid()` es null.

## Tabla de las 27 policies

| # | policy | tabla | roles | riesgo | por qué | fix propuesto |
|---|---|---|---|---|---|---|
| 1 | academic_progress_admin_all | academic_progress | public | bajo | `child_id` debe ser hijo de una escuela donde `is_school_admin()`; el estado nuevo se evalúa igual | CHECK = USING |
| 2 | activities_access | activities | public | bajo | `user_id = auth.uid() OR is_platform_admin()` | CHECK = USING |
| 3 | attendance_admin_all | attendance | public | bajo | igual que 1 (por `child_id`) | CHECK = USING |
| 4 | attendance_records_admin_all | attendance_records | public | bajo (observación) | acota `school_id`, pero `child_id`, `class_id`, `team_id`, `session_id` quedan libres: un admin puede escribir asistencia con SU school_id sobre un niño ajeno. Hoy hay 1 fila así | CHECK = USING + `child_id` de la misma escuela |
| 5 | Admins can manage all sessions | attendance_sessions | public | bajo | `is_school_admin(school_id)` | CHECK = USING |
| 6 | Attendance sessions: manage staff | attendance_sessions | public | bajo | `school_id = ANY(user_staff_school_ids())` (staff, sin padres/atletas) | CHECK = USING |
| 7 | owner and admin can manage cash entries | cash_session_entries | public | medio | `school_members` sin `status='active'`: un owner/admin dado de baja conserva escritura de caja (hoy 2 owners `inactive`). Además `session_id` no se valida contra la escuela. Tabla sin datos | USING y CHECK con `status='active'` + sesión de la misma escuela |
| 8 | owner and admin can manage cash sessions | cash_sessions | public | medio | mismo defecto de `status` | USING y CHECK con `status='active'` |
| 9 | trainer_manage_children_stats | children_stats | authenticated | **REAL (alto)** | ver detalle A | USING y CHECK acotados a staff de la escuela del niño |
| 10 | class_enrollments_manage_admin | class_enrollments | public | bajo (observación) | acota la clase (`class_id`); `enrollment_id` queda libre: se puede colgar una inscripción ajena de una clase propia | CHECK = USING + inscripción de la misma escuela |
| 11 | classes_admin_all | classes | public | bajo | `is_school_admin(school_id)` | CHECK = USING |
| 12 | coach_profiles_admin_all | coach_profiles | public | bajo | `is_platform_admin()` | CHECK = USING |
| 13 | coach_profiles_self_all | coach_profiles | public | bajo | `id = auth.uid()`: solo su fila | CHECK = USING |
| 14 | platform admins manage demo links | demo_links | public | bajo | `platform_admins` por `auth.uid()` | CHECK = USING |
| 15 | categories_organizer_manage | event_categories_config | public | bajo | `event_id` de eventos con `creator_id = auth.uid()` | CHECK = USING |
| 16 | del_payments_organizer_manage | event_delegation_payments | public | bajo | `event_id` propio; el organizador puede poner cualquier `school_id`, pero solo dentro de SU evento. Duplicada por `del_payments_host_manage` (que sí tiene CHECK) | CHECK = USING (o dropear) |
| 17 | del_payments_school_manage | event_delegation_payments | public | **REAL (alto)** | ver detalle B | CHECK que ate delegación+evento+escuela y estado inicial |
| 18 | delegation_school_manage | event_delegations | public | **REAL (alto)** | ver detalle C | CHECK que fije estado inicial y montos |
| 19 | price_phases_organizer_manage | event_price_phases | public | bajo | `event_id` de eventos propios | CHECK = USING |
| 20 | coaches_school_manage | event_team_coaches | public | bajo | `delegation_id` de delegaciones de escuelas donde es admin activo | CHECK = USING |
| 21 | mp_shipping_rates_owner | marketplace_shipping_rates | authenticated | bajo | `vendor_profile_id` propio | CHECK = USING |
| 22 | School manages own templates | payment_message_templates | public | bajo | `school_id` de membresía admin ACTIVA | CHECK = USING |
| 23 | sa_school_manage | school_availability | public | bajo | `school_id` por membresía activa (owner/admin/staff/school_admin) | CHECK = USING |
| 24 | school_members_admin_crud | school_members | public | bajo en I3, medio de diseño | duplicada con "Members: manage admin", que SÍ tiene CHECK `is_school_admin(school_id)`: el CHECK efectivo (OR de permisivas) ya existe. Pero cualquier admin puede insertar `role='owner'`/`'admin'` para quien quiera: "permiso que otorga permisos no se delega" (CLAUDE.md) | dropear la duplicada; decisión de producto sobre quién otorga `owner`/`admin` |
| 25 | Staff: manage admin | school_staff | public | bajo en I3, mismo matiz | `is_school_admin(school_id)` | CHECK = USING |
| 26 | training_sessions_admin_all | training_slots | public | bajo | `team_id` de equipos de escuelas donde es admin | CHECK = USING |
| 27 | school_owner_manage_unregistered_athletes | unregistered_athletes | public | bajo | `school_id` de escuelas propias o membresía activa admin/coach/staff | CHECK = USING |

Resumen: 3 reales (9, 17, 18), 2 medias (7, 8), 2 con observación de integridad (4, 10), 1 de diseño
(24/25), el resto bajas. Las bajas se cierran sin cambio de comportamiento.

## Detalle de los riesgos reales

### A. `children_stats.trainer_manage_children_stats` (authenticated)
USING: existe un `trainer_session_plans` con `client_id = children_stats.child_id AND trainer_id = auth.uid()`.
El problema está aguas arriba: `trainer_session_plans_owner_all` (`trainer_id = auth.uid()`, USING y CHECK) deja
a CUALQUIER usuario autenticado insertar un plan propio con `client_id` = uuid de cualquier niño y cualquier
`school_id`; `client_id` NO tiene FK (verificado: solo hay FK a school, trainer, routine, enrollment).
Exploit: un padre, atleta o coach de otra escuela inserta un plan con `client_id=<child_id ajeno>` y queda con
lectura, INSERT, UPDATE y DELETE sobre `children_stats` de ese niño (marcas, PRs, notas). Requiere conocer el uuid
del niño (no adivinable, pero lo conocen padres, staff y cualquiera con un enlace). Hoy hay 3 filas en
`children_stats`: impacto de datos pequeño, pero el vector cruza tenants. Además 8 planes tienen `client_id` =
niño de otra escuela que el `school_id` del plan (a revisar: pueden ser legítimos o ya explotados).
Fix: acotar `children_stats` a staff de la escuela del niño (no a "tengo un plan"); en una segunda pasada,
validar `client_id` contra la escuela dentro de `trainer_session_plans_owner_all` (decisión de producto, porque
hay `client_type` = adult/registered/unregistered/child).

### B. `event_delegation_payments.del_payments_school_manage`
USING acota solo `school_id`. Un admin de escuela puede insertar pagos de delegación con SU school_id pero
`event_id` y `delegation_id` de OTRO evento/organizador, y con `status='approved'`, `reviewed_by` y `amount`
libres (estados válidos: pending/approved/rejected). Además puede actualizar sus propios pagos a `approved`:
aprobación de su propio pago sin revisión del organizador. Parte del problema está en el USING (no solo en el
CHECK): un CHECK con `status='pending'` y coherencia delegación-evento-escuela cierra el INSERT; para el UPDATE
hace falta además un trigger o separar la policy por comando (decisión de producto).
Hoy 0 filas incoherentes y 0 filas con estado: radio actual = 0.

### C. `event_delegations.delegation_school_manage`
Igual: acota solo `school_id`. Un admin de escuela inserta una delegación en cualquier `event_id` (evento ajeno,
incluso cerrado) y con `status` libre (`draft, submitted, pending_payment, confirmed, closed, rejected`),
`total_paid` y `confirmed_at`: se autoconfirma o se declara pagado. Existen `delegation_organizer_update` y
`delegation_host_manage` que sí deberían controlar eso. Hoy hay 1 delegación (`confirmed`).

## Observaciones de integridad (no explotables por sí solas)
- `attendance_records` (4): 1 fila con `child_id` de otra escuela que su `school_id`.
- `class_enrollments` (10): columnas `class_id, enrollment_id`; el CHECK solo valida la clase.
- Policies 7-8: hoy `cash_sessions` está vacía, así que corregir `status='active'` cuesta 0.

## Radio de impacto del fix
- CHECK = USING: comportamiento idéntico al actual; no cambia ninguna fila ni sesión. Solo explicita.
- Estrictas (7, 8, 9, 17, 18, y observaciones 4, 10): consultas de medición y simulación en el borrador.
  Medido hoy: cash 0 filas; 2 owners `inactive` perderían escritura (correcto); `children_stats` 3 filas;
  8 planes con niño de otra escuela (trainers que perderían acceso a las stats de ese niño, a validar);
  delegaciones 1, pagos de delegación 0.
- Quién escribe estas tablas: no hay escritura directa desde el frontend (Grep sin coincidencias; solo lecturas
  tipo `useAthleteData`). El BFF las toca en `events.route.ts`, `organizers.route.ts`, `school-delegations.route.ts`,
  `trainer/clients.ts`, `school/football.ts`, `trainer/availability.ts` con el cliente `supabase` de
  `config/supabase` (verificar que sea service_role; si lo es, la RLS no lo afecta y el endurecimiento no rompe
  el BFF).

## I6 — `v_payment_adjustments_familia` (ALTA según el script; intencional)
- Definición viva: `security_barrier=true`, dueño `postgres`, sin `security_invoker`. GRANT SELECT solo a
  `authenticated`; sin `anon`.
- Columnas expuestas: id, payment_id, kind, origin, applies_to, sequence, basis, pct, amount, reason_code,
  reason_label (derivado), reverted (derivado), created_at. NO expone `reason_text`, `created_by`,
  `amount_before/after/paid_at`, `school_id`, `scope`, `context` (decisión Q-D7, spec §8.1b).
- Filtro: `kind <> 'reversion'` y el cobro debe ser del llamante (`p.parent_id` o `p.user_id` = `auth.uid()`,
  o hijo cuyo `parent_id = auth.uid()`). `auth.uid()` se evalúa por llamante también dentro de una vista del dueño.
- Consumidores: ninguno en `frontend/src` ni `bff/src` salvo `types.ts` (generado). La migración
  `20261010144554` la creó para la pantalla de familia; `20261013165308` y `20261029190004` la reafirman como
  único camino de la familia a los ajustes.
- ¿Rompería `security_invoker`? Sí: la familia no tiene policy sobre `payment_adjustments` (solo
  `padj_select_finance`, para finanzas de la escuela) y el sub-select `reverted` también lee la tabla base. Con
  invoker la vista devolvería 0 filas a todo acudiente. La migración original documenta ese desvío a propósito.
- Veredicto: bajo riesgo, intencional. Fix correcto = excluirla de I6 como `v_school_staff_publico` y
  `v_school_settings_publico` (la exclusión es una lista fija dentro del RPC; ver sección 3 del borrador).
  Riesgo residual: el dueño es `postgres` (BYPASSRLS); si alguien quita el filtro por `auth.uid()` del WHERE,
  fuga total. Conviene un test de regresión (un acudiente no ve ajustes ajenos).

## Lo más grave (10 líneas)
1. `children_stats`: cualquier autenticado se vuelve "entrenador" de cualquier niño insertando un plan en `trainer_session_plans` (sin FK en `client_id`) y lee/escribe/borra sus marcas.
2. Causa raíz: `trainer_session_plans_owner_all` no valida `client_id` ni `school_id`; hay 8 planes con niño de otra escuela por revisar.
3. `event_delegations`: un admin de escuela puede inscribirse en cualquier evento y ponerse `confirmed`/pagado (el USING acota solo la escuela).
4. `event_delegation_payments`: un admin de escuela crea y aprueba (`approved`) pagos sobre eventos de otros organizadores.
5. Las dos de torneos necesitan más que `WITH CHECK = USING`: fijar estado inicial y tratar el UPDATE (decisión de producto).
6. `cash_sessions` / `cash_session_entries` no filtran `status='active'`; 2 owners `inactive` conservan escritura (tablas vacías, costo 0).
7. `school_members` / `school_staff`: un admin puede otorgar `owner`/`admin`; no es I3, pero rompe "quien otorga no delega".
8. Las demás son benignas: el USING ya acota; `ALTER POLICY … WITH CHECK (mismo USING)` no cambia nada y silencia I3.
9. I6 `v_payment_adjustments_familia` es intencional (invoker daría 0 filas a todo acudiente); excluirla del invariante, no tocar la vista; sin consumidores en código aún.
10. Nada aplicado; el borrador exige una sola sesión aplicando, vía `npm run migrations:new`, sin regenerar `types.ts` (no cambia esquema).
