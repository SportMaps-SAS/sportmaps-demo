# Evaluación de entrenadores (dueño / admin → entrenador)

> Origen: pedido del usuario, 2026-10-28.
> Estado: **APROBADO 2026-10-28 — en construcción.**
> Se apoya en Seguimiento deportivo (`docs/specs/rediseno-seguimiento-deportivo.md`, F4).

## 1. Qué se pide

El dueño o el admin de la escuela **califica a cada entrenador** por cómo trabajó en un período,
mirando lo mismo que ya muestra Seguimiento deportivo (qué planificó, si tomó lista, si evaluó a sus
deportistas, adherencia al mesociclo).

## 2. Decisiones ya tomadas (usuario, 2026-10-28)

| # | Decisión |
|---|---|
| D1 | **Solo el dueño o el admin** califican. Los coordinadores y los entrenadores no califican a nadie. |
| D2 | Períodos: **semanal, mensual, trimestral, semestral y anual**. |
| D3 | **Cada escuela define qué ítems califica** (los crea, los edita, los ordena y los desactiva). |
| D4 | La calificación se hace **a partir de lo que muestra Seguimiento deportivo**: los datos del período aparecen al lado de cada ítem. |

## 3. Decisiones resueltas (usuario, 2026-10-28)

| # | Decisión |
|---|---|
| D5 | El entrenador **ve** su evaluación **solo cuando el admin la publica**. El borrador es interno. Sin notificación en la primera versión. |
| D6 | Escala 1 a 5 con palabras (1 Deficiente · 2 Por mejorar · 3 Cumple · 4 Bueno · 5 Excelente) **más «Otras acotaciones»**: campo libre de la evaluación, aparte de fortalezas / a mejorar / compromisos. |
| D7 | Sin pesos: el puntaje total es el promedio simple de los ítems calificados. |
| D8 | Se puede editar después de publicar; queda registrado quién y cuándo (`updated_by`, `updated_at`). |
| D9 | Se califica también a entrenadores **sin cuenta** (la evaluación cuelga de `school_staff`), pero la pantalla **recomienda que ingrese**: aviso «Este entrenador todavía no entra a SportMaps: sin cuenta no hay datos de actividad para calificar» con acceso a reenviar la invitación. |

## 4. Cómo funciona para el usuario

### 4.1 Configurar los ítems (botón «Ítems de calificación» en Seguimiento deportivo)

Pantalla «Ítems para calificar entrenadores». La primera vez viene precargada con una plantilla que
la escuela puede cambiar:

| Ítem sugerido | Dato de Seguimiento deportivo que se muestra al lado |
|---|---|
| Planificación de sesiones | Sesiones planificadas en el período y semanas sin planificar |
| Toma de asistencia | Días con lista / sesiones del período |
| Evaluación de deportistas | Evaluaciones registradas y deportistas evaluados |
| Cumplimiento del mesociclo | Adherencia % (planificadas vs hechas) |
| Puntualidad y presentación | — (solo criterio del admin) |
| Trato con deportistas y familias | — (solo criterio del admin) |

Cada ítem tiene nombre, descripción corta (qué significa un 5) y, opcionalmente, **qué dato
automático mostrar a su lado** (lista cerrada: sesiones planificadas · listas tomadas · evaluaciones
· adherencia del mesociclo · ninguno). Un ítem en uso no se borra: se **desactiva**, para que las
evaluaciones viejas sigan leyéndose.

### 4.2 Calificar (desde Seguimiento deportivo)

1. En la ficha del entrenador (`CoachDetailSheet`), botón **«Calificar»**.
2. Elegir período: Semanal / Mensual / Trimestral / Semestral / Anual y cuál (ej. «Octubre 2026»,
   «T3 2026»). Por defecto: el último período cerrado del tipo que se usó la vez anterior.
3. Pantalla de calificación, una fila por ítem:
   - nombre del ítem + su dato automático del período («8 de 9 sesiones planificadas»);
   - 1 a 5 con palabras (botones, no slider);
   - comentario opcional.
4. Abajo: **Fortalezas**, **Aspectos a mejorar**, **Compromisos para el próximo período** y **Otras acotaciones**.
5. «Guardar borrador» o «Publicar».

### 4.3 Historial

Pestaña **«Evaluaciones»** en la ficha del entrenador: lista por período con el puntaje (número +
palabra) y una gráfica de barras simple «¿Cómo le fue en cada período?» (mismas reglas de
gráficas de la spec de Seguimiento: una pregunta por gráfica, número encima de la barra).

### 4.4 El entrenador (si se aprueba D5)

En su perfil, «Mis evaluaciones»: solo las **publicadas**, de solo lectura.

## 5. Modelo de datos

Todas las tablas nuevas con `text + CHECK` (no `CREATE TYPE`), RLS activo y escritura **solo por RPC**.

### `coach_evaluation_criteria` — los ítems de cada escuela
| columna | tipo | nota |
|---|---|---|
| id | uuid pk | |
| school_id | uuid → schools | |
| name | text not null | |
| description | text | |
| auto_metric | text null, CHECK in (`sesiones_planificadas`,`listas_tomadas`,`evaluaciones`,`adherencia_mesociclo`) | dato a mostrar |
| sort_order | int | |
| active | bool default true | desactivar en lugar de borrar |
| created_at / updated_at | timestamptz | |

### `coach_evaluations` — una evaluación de un entrenador en un período
| columna | tipo | nota |
|---|---|---|
| id | uuid pk | |
| school_id | uuid → schools | |
| staff_id | uuid → school_staff | ver D9 |
| period_type | text CHECK in (`semanal`,`mensual`,`trimestral`,`semestral`,`anual`) | |
| period_start / period_end | date | alineados: lunes · día 1 · ene/abr/jul/oct · ene/jul · 1-ene |
| status | text CHECK in (`borrador`,`publicada`) | |
| overall_score | numeric(3,2) | promedio, lo calcula la RPC |
| strengths / improvements / commitments / other_notes | text | other_notes = «Otras acotaciones» (D6) |
| activity_snapshot | jsonb | los datos de Seguimiento **tal como los vio el admin** al guardar |
| evaluator_id / updated_by | uuid → profiles | |
| published_at, created_at, updated_at | timestamptz | |
| UNIQUE (staff_id, period_type, period_start) | | una evaluación por entrenador y período |

`activity_snapshot` congela los números: si después se cargan listas atrasadas, la nota sigue
correspondiendo a lo que el admin tenía delante.

### `coach_evaluation_scores` — la nota por ítem
| columna | tipo | nota |
|---|---|---|
| evaluation_id | uuid → coach_evaluations on delete cascade | |
| criterion_id | uuid → coach_evaluation_criteria | |
| criterion_name | text | copia del nombre: si el ítem se renombra, la evaluación vieja no cambia |
| score | smallint CHECK 1..5 | |
| comment | text | |
| PK (evaluation_id, criterion_id) | | |

## 6. RPCs (todas `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`, `GRANT EXECUTE … TO authenticated`, `REVOKE` explícito de `anon`)

| RPC | Qué hace | Gate |
|---|---|---|
| `ensure_coach_evaluation_criteria(p_school_id)` | Si la escuela no tiene ítems, inserta la plantilla. Idempotente. | `p_school_id = ANY(user_admin_school_ids())` |
| `upsert_coach_evaluation_criterion(...)` / `reorder_…` / `set_…_active` | ABM de ítems | idem |
| `save_coach_evaluation(p_staff_id, p_period_type, p_period_start, p_scores jsonb, p_texts…, p_snapshot jsonb, p_publish bool)` | **Transaccional**: upsert del padre + reemplazo de las notas + promedio, todo en una transacción (regla «multi-fila = RPC»). Valida que el staff sea de la escuela, que el período esté alineado y que cada criterio pertenezca a la escuela. | idem, escuela tomada del staff, **no** del parámetro |
| `delete_coach_evaluation(p_id)` | Borra (solo borradores ❓) | idem |

**Alcance:** `user_admin_school_ids()`, nunca `user_school_ids()` ni `user_staff_school_ids()`
(D1: coaches excluidos; invariante I2).

### Policies (solo SELECT; las escrituras van por las RPCs)
- `coach_evaluation_criteria`: SELECT para `school_id = ANY(user_admin_school_ids())`.
- `coach_evaluations` / `_scores`: SELECT para admin de la escuela; además (D5) el
  entrenador dueño de la fila **y solo con `status = 'publicada'`** (vía función `SECURITY DEFINER`
  que resuelva `school_staff.coach_auth_id = auth.uid()`, sin auto-recursión).
- Sin policies de INSERT/UPDATE/DELETE → nadie escribe directo.
- Verificación: `npm run seguridad:invariantes` y prueba con `set local role anon` = 0 filas.

## 7. BFF

Hoy `GET /api/v1/school/coach-activity?week=` arma **una semana** (+8 de gráfica). Para calificar
hace falta el mismo cálculo para **un rango cualquiera** (hasta un año):

- `GET /api/v1/school/coach-activity/summary?staff_id=&from=&to=` → los totales del entrenador en
  el rango (sesiones planificadas, listas, evaluaciones, adherencia) con la misma lógica pura de
  `coach-activity.aggregate.ts` (se extrae una función por rango y se reutiliza; test incluido).
- Mismo gate (`requireRole` admin + filtro explícito por `req.schoolId`), lecturas paginadas y `.in()`
  en tandas de 30.
- **Disk IO:** solo se llama cuando el admin abre la pantalla de calificar (nada de jobs, nada
  por minuto). Un rango anual de un entrenador es una lectura acotada por `staff_id` + fechas.

El frontend manda el resumen recibido como `p_snapshot` al guardar.

## 8. Frontend

| Pieza | Dónde |
|---|---|
| Configuración de ítems | `CriteriaManagerDialog`, botón «Ítems de calificación» en `/seguimiento-deportivo` |
| Botón «Calificar» + pestaña «Calificación» | `components/coach-activity/CoachDetailSheet.tsx` |
| Formulario de calificación | componente nuevo `CoachEvaluationDialog` |
| Selector de período | helper puro `coachEvaluationPeriods.ts` (alinear fechas, etiqueta «T3 2026»), con test |
| «Mis evaluaciones» (D5) | `/mis-evaluaciones` (menú clásico y «Más» de la V2) |

Solo visible para `owner` / `school_admin` (mismo criterio que `/seguimiento-deportivo`).

## 9. Pruebas

- Unitarias: alineación de períodos, promedio, resumen por rango (aggregate).
- RLS/RPC: un coach llamando `save_coach_evaluation` → error; un admin de otra escuela → error;
  `anon` → 0 filas; coach ve solo sus publicadas (D5).
- Concurrencia: dos admins guardando la misma evaluación a la vez → una sola fila (UNIQUE + upsert).
- En pantalla: crear ítems, calificar un mes, publicar, ver historial.

## 10. Entrega

Full-stack de corrido: migración (ledger `npm run migrations:new -- evaluacion-entrenadores`) →
RPCs → BFF → frontend → invariantes de seguridad → pruebas. Migración aplicada por una sola sesión,
con rastro (CLI / `apply_migration`), y `types.ts` regenerado una vez al final.
