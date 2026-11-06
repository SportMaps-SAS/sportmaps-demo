# Spec — Evaluaciones ampliadas (Carmel)

> Origen: pedido de Club Carmel (`docs/plan-club-carmel-2026-09.md`), ítem 5 del plan de la semana (`docs/plan-semana-2026-11-04.md`: «autoevaluación del coach con comparación, por categoría y por sesión») y Frente B #4 («rúbrica con "No aplica" que no cuenta en el promedio»).
> Fecha: 2026-11-05 · Estado: **BORRADOR para decisión. Sin código, sin migraciones.**
> Escuela: Carmel Club (`school_id 374a6716-af42-4745-afe1-8d089153e01b`). Todo detrás de flags **solo para Carmel**.
> Se apoya en: `docs/specs/evaluacion-de-entrenadores.md` (admin → coach), `docs/specs/evaluacion-post-entrenamiento.md` (encuesta de sesión), `docs/specs/partidos-registro-y-evaluacion-por-jugador.md` (criterios por escuela).

## 0. Cómo leer este documento

- §1 es lo que **existe hoy**, leído en el repo (migraciones, specs, componentes). No se consultó la base viva en esta sesión: los conteos de filas de Carmel salen del plan de septiembre y del plan de la semana (marcados).
- §2 es lo que falta. §3 a §9 es el diseño. §10 son las decisiones que necesito del usuario, con recomendación.
- Hay una **ambigüedad de alcance** (D1): «por categoría y por sesión» se puede leer como evaluación **del coach** o **de los deportistas**. Este spec asume lo primero y deja la otra lectura como decisión.

---

## 1. Qué existe HOY (verificado en el repo)

| Pieza | Dónde | Qué hace | Límite relevante para este pedido |
|---|---|---|---|
| **Evaluación de entrenadores (admin → coach)** | Migraciones `20261028201746_evaluacion_entrenadores.sql`, `20261029095042_..._gate_inline.sql`, `20261029191217_..._aviso_al_publicar.sql`; spec `evaluacion-de-entrenadores.md` (aprobado 10-28) | Tablas `coach_evaluation_criteria` (ítems por escuela), `coach_evaluations` (una por staff + período), `coach_evaluation_scores` (nota por ítem). RPCs `ensure_coach_evaluation_criteria`, `save_coach_evaluation_criterion`, `reorder_coach_evaluation_criteria`, `save_coach_evaluation`, `delete_coach_evaluation`. Escala 1–5, promedio simple, borrador/publicada, snapshot de actividad, aviso al coach al publicar (solo con cuenta) | Solo **admin/dueño** califica (D1 de ese spec). Solo **por período** (semanal a anual): sin categoría, sin sesión. `coach_evaluation_scores.score` es `NOT NULL CHECK 1..5`: **no existe «No aplica»**. `UNIQUE (staff_id, period_type, period_start)` impide dos evaluaciones del mismo período por categoría |
| **Lo que ve el coach** | Policy `coach_evaluations_select_admin_or_own`: admin de la escuela, o el coach dueño **solo si `status='publicada'`** (helper `my_coach_staff_ids()`); pantalla `/mis-evaluaciones` (ruta solo rol `coach`, `routePermissions.ts:123`; menú `navigation.ts:518`) | Solo lectura de lo publicado | No hay formulario del coach, ni comparación |
| **Resumen de actividad por rango** | BFF `bff/src/routes/school/coach-evaluation-summary.ts` (admin) sobre `coach-activity.aggregate.ts` | Totales del coach en un rango (sesiones planificadas, listas, evaluaciones, adherencia) para el snapshot | Gate de admin: el coach no puede pedir **sus propios** números |
| **Frontend de la evaluación** | `frontend/src/components/coach-evaluation/` (`CoachEvaluationDialog`, `CriteriaManagerDialog`, `EvaluationHistory`, `periods.ts`, `api.ts`) y `components/coach-activity/CoachDetailSheet.tsx` | Calificar, ítems, historial | Solo vista de administración |
| **Encuesta post-entreno** | `evaluacion-post-entrenamiento.md` (F0–F5 en `develop`): `performance_entries` con `context_type='session'`, `attendance_sessions.finalized` + `coach_notes`, `CoachPostTrainingRatingDialog` (el coach califica a cada deportista al finalizar la lista), informe grupal por equipo (`team_reports`) | Es la evaluación **de los deportistas** por sesión y por equipo | No evalúa al coach. Es el punto natural para colgar una autoevaluación de sesión |
| **Rúbrica del mesociclo** | `MesocycleRubricTable.tsx` + `training_mesocycle_evaluations` (6 indicadores × 5 checkpoints, `score 1..10 NOT NULL`, `UNIQUE (mesocycle_id, indicator, checkpoint)`); modo individual escribe `performance_entries` | Rúbrica por equipo y por checkpoint | Indicadores fijos en código y en CHECK. Tampoco admite «No aplica» |
| **Criterios por escuela (propuesto)** | `school_metric_definitions` en el spec de Partidos (sin construir) | Criterios configurables | Es de partidos/entrenamiento de atletas, no de coaches |
| **Flags por escuela** | Patrón `school_settings.<flag>` expuesto en `v_school_entitlements` y `useEntitlements.ts` (ej. `allow_secondary_team_enrollment`, Carmel = true, migración `20260924101138`) | Ya hay mecanismo para «solo Carmel» | — |
| **Carmel hoy** | Plan de septiembre: informes sin pestaña del coach, `reports_enabled=false`, 0 evaluaciones (de deportistas), 0 acudientes; 7 entrenadores, ya todos con `coach_auth_id` (actualización 09-24). Plan de la semana, Frente B #1: **la evaluación que publica el admin no le llega al coach** y está por reproducirse en vivo | — | Sin saber si alguien publicó, no se puede afirmar que el flujo admin → coach funciona en producción. **No verificado en base viva** |

**Conclusión:** la mitad «escuela evalúa al coach, por período, 1–5» existe y está aprobada. Falta todo lo demás: lado del coach, comparación, alcance por categoría/sesión y «No aplica». El pedido se construye **reutilizando** ítems, períodos, helpers, snapshot y gate, no creando un módulo aparte.

---

## 2. Qué falta (el pedido, desglosado)

| # | Pedido | Hoy | Falta |
|---|---|---|---|
| E1 | **Autoevaluación del coach** con los mismos ítems | Nada | Tabla, RPC, pantalla del coach |
| E2 | **Comparación**: lo mío vs lo que me puso la escuela, y vs el resto de entrenadores | Nada | RPC de comparación con reglas de privacidad |
| E3 | **Por categoría** (equipo): cómo trabajé con la categoría X | Solo evaluación general del período | Alcance `categoria` (`team_id`) |
| E4 | **Por sesión**: cómo me fue en el entreno de hoy | La encuesta evalúa deportistas, no al coach | Alcance `sesion` (`attendance_session_id`), paso opcional al finalizar la lista |
| E5 | **«No aplica»** que no cuenta en el promedio | `score` obligatorio 1–5 (y 1–10 en la rúbrica del mesociclo) | Nota nula + marca, promedio sobre lo aplicable |
| E6 | Flag solo Carmel | Mecanismo existe | Columna(s) nueva(s) en `school_settings` |

---

## 3. Alcance y vocabulario

- **Evaluación de la escuela** (`kind = escuela`): la que ya existe. Admin/dueño → coach.
- **Autoevaluación** (`kind = auto`): el coach sobre sí mismo.
- **Alcance** (`scope`): `periodo` (general, como hoy), `categoria` (un equipo en un período), `sesion` (una sesión de asistencia concreta).
- **Ítem aplicable**: el que tiene nota 1–5. **No aplica (N/A)**: el evaluador lo marcó explícitamente; no suma ni resta.
- **Pares**: los demás entrenadores de la misma escuela con evaluación de la escuela **publicada** en el mismo período.

Fuera de alcance: puntos, rankings con nombre, comparar coaches por nombre ante otros coaches, evaluación de la escuela por sesión (ver D5), notificaciones nuevas más allá de la que ya existe al publicar.

---

## 4. Modelo de datos (conceptual)

Todo `text + CHECK` (sin `CREATE TYPE`), RLS activo, **escritura solo por RPC** `SECURITY DEFINER`, `REVOKE ALL … FROM PUBLIC, anon, authenticated` y `GRANT SELECT` solo donde la policy lo necesite. Las migraciones se crean con `npm run migrations:new -- <slug>` y son inmutables: lo que cambie de las tablas vivas va en migración **nueva**.

### 4.1 Cambios mínimos a lo existente

**`coach_evaluation_scores`** (alcance del «No aplica»):
- `score` pasa a `NULL`-able.
- Columna nueva `not_applicable boolean NOT NULL DEFAULT false`.
- `CHECK ((not_applicable AND score IS NULL) OR (NOT not_applicable AND score BETWEEN 1 AND 5))`.
- Las filas existentes quedan `not_applicable=false` sin backfill. `avg()` ya ignora los nulos, así que el promedio queda correcto por construcción; igual se calcula explícito (§7).

**`coach_evaluation_criteria`**: columna nueva `applies_to text NOT NULL DEFAULT 'periodo' CHECK (applies_to IN ('periodo','sesion','ambos'))`. Permite que «Planificación de sesiones» solo aplique al período y «Objetivo de la sesión logrado» solo a la sesión. Mismos ítems, mismo `CriteriaManagerDialog`, una pestaña/selector más.

**`training_mesocycle_evaluations`** (solo si D2 incluye la rúbrica): `score` nullable + `not_applicable` con el mismo CHECK (1–10). El modo individual (`performance_entries`) queda con «No aplica = sin fila»; ver riesgo R5 (no verifiqué si `performance_entries.value` admite NULL).

**`school_settings`** (flags, §9): `rubric_allow_na boolean NOT NULL DEFAULT false` y `coach_self_eval_enabled boolean NOT NULL DEFAULT false`; ambas en `v_school_entitlements`. Carmel = true.

### 4.2 Tablas nuevas (autoevaluación)

Se recomienda **tablas paralelas** y no tocar `coach_evaluations` (D10): la evaluación de la escuela está aprobada y publicada; cambiar su `UNIQUE` y su policy para meter `kind`/`scope` arriesga el flujo que ya existe (y el Frente B #1 todavía investiga por qué no llega al coach).

**`coach_self_evaluations`**

| columna | tipo | nota |
|---|---|---|
| id | uuid pk | |
| school_id | uuid → schools | se toma del staff, no del parámetro |
| staff_id | uuid → school_staff | quien se autoevalúa |
| scope | text CHECK in (`periodo`,`categoria`,`sesion`) | |
| period_type | text CHECK in (`semanal`,`mensual`,`trimestral`,`semestral`,`anual`,`sesion`) | `sesion` solo con scope `sesion` |
| period_start / period_end | date | alineados con `_coach_eval_period_end`; para `sesion` ambos = fecha de la sesión |
| team_id | uuid → teams null | obligatorio si scope = `categoria` |
| attendance_session_id | uuid → attendance_sessions null | obligatorio si scope = `sesion` |
| status | text CHECK in (`borrador`,`enviada`) | |
| shared_with_school | boolean default false | D3 |
| overall_score | numeric(3,2) null | promedio de lo aplicable; null si todo es N/A |
| applicable_count / na_count | smallint | para mostrar «5 de 6 ítems» sin recalcular |
| strengths / improvements / commitments / other_notes | text (límites como la existente) | |
| activity_snapshot | jsonb null | los números propios del período al guardar |
| created_at / updated_at / sent_at | timestamptz | |

- CHECKs de coherencia: `scope='categoria' → team_id NOT NULL AND attendance_session_id IS NULL`; `scope='sesion' → attendance_session_id NOT NULL`; `scope='periodo' → ambos NULL`.
- Unicidad: índice único `(staff_id, scope, period_type, period_start, COALESCE(team_id, nil_uuid), COALESCE(attendance_session_id, nil_uuid))`. El `ON CONFLICT` de la RPC infiere sobre esa expresión.
- Índices de lectura: `(school_id, staff_id, period_start DESC)` y `(attendance_session_id)`.

**`coach_self_evaluation_scores`**: `(self_evaluation_id, criterion_id)` PK, `criterion_name` (copia, como la existente), `score smallint null`, `not_applicable boolean`, `comment`, con el mismo CHECK de N/A. `criterion_id` con `ON DELETE RESTRICT` (un ítem en uso se desactiva, no se borra).

### 4.3 RLS (solo SELECT; sin policies de escritura)

- `coach_self_evaluations`: `staff_id = ANY (my_coach_staff_ids())` (el coach ve **todas las suyas**, también borradores) **OR** `school_id = ANY (user_admin_school_ids()) AND status='enviada' AND shared_with_school` (la administración solo ve lo que el coach compartió). Helpers envueltos en `(SELECT …)`.
- `coach_self_evaluation_scores`: `EXISTS` sobre la tabla padre (tabla distinta, sin auto-recursión), igual que `coach_evaluation_scores_select_visible`.
- `user_staff_school_ids()` **no** se usa para leer esto: dejaría a otros coaches de la escuela ver autoevaluaciones ajenas.
- Verificación obligatoria tras aplicar: `npm run seguridad:invariantes` y `select … from pg_policies where tablename in (…)` listando **todas** las policies (son permisivas y se suman con OR).

---

## 5. RPCs

Todas `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`, `GRANT EXECUTE … TO authenticated`, `REVOKE` explícito de `anon`. **El gate va escrito dentro del cuerpo** (el invariante I7 no reconoce gates delegados en otra función; ya costó un falso positivo en la migración `20261029095042`). Cada RPC valida además el flag de la escuela y lo ata al **id que recibe**, nunca a «es admin de alguna escuela».

| RPC | Qué hace | Gate interno |
|---|---|---|
| `save_coach_self_evaluation(p_staff_id, p_scope, p_period_type, p_period_start, p_team_id, p_session_id, p_scores jsonb, p_strengths, p_improvements, p_commitments, p_other_notes, p_snapshot jsonb, p_send boolean)` | **Transaccional** (padre + notas + promedio en una transacción, regla del repo). Upsert idempotente por el índice único. Valida: período alineado (`_coach_eval_period_end`); `p_team_id` ∈ `team_coaches` del staff; sesión `finalized=true`, de un equipo del staff, y dentro de una ventana editable (propuesta 7 días); cada `criterion_id` es de la escuela y su `applies_to` sirve al alcance; sin ítems repetidos; notas 1–5 o N/A; para enviar, al menos un ítem aplicable | `school_staff.coach_auth_id = auth.uid()` para ese `p_staff_id`, `p_school` derivado del staff, flag `coach_self_eval_enabled` |
| `share_coach_self_evaluation(p_id, p_share boolean)` | Marca o retira «compartida con la escuela» (solo sobre una `enviada`) | Dueño de la fila |
| `delete_coach_self_evaluation(p_id)` | Borra solo **borradores** propios | Dueño de la fila |
| `get_coach_comparison(p_staff_id, p_period_type, p_period_start, p_team_id)` | Devuelve **un jsonb** con, por ítem: `self` (mi nota o N/A), `school` (solo si la evaluación de la escuela está **publicada**), `peers_avg` y `peers_n` (promedio de los demás coaches, solo con `n ≥ K`, ver §7.3), más los totales comparables. Una sola consulta agregada, sin N+1 | El coach pidiéndose a sí mismo, **o** `school_id = ANY(user_admin_school_ids())`. Para el coach, `school` y `peers_*` aplican las reglas de visibilidad de §6; para el admin ve lo de la escuela y sus propias reglas |
| `save_coach_evaluation` (**modificada**, migración nueva) | Acepta `{criterion_id, score|null, not_applicable}`; promedio sobre lo aplicable; no se puede publicar con 0 aplicables. Se parte del cuerpo de la **última** versión (`20261029191217`, con el aviso al publicar), no de la original, y `CREATE OR REPLACE` conserva los GRANT | Sin cambios (admin) |
| `ensure_coach_evaluation_criteria` (**opcional**) | Si se agregan ítems de sesión a la plantilla, solo para escuelas sin ítems; Carmel ya tiene los suyos, no se pisan | Sin cambios |

No hay RPCs de sistema ni jobs nuevos: nada por minuto.

---

## 6. Permisos (quién ve qué)

| Dato | Coach (el evaluado) | Otro coach | Admin / dueño | Familias |
|---|---|---|---|---|
| Su autoevaluación (borrador y enviada) | **Sí, siempre** | No | Solo si el coach la **compartió** | No |
| Evaluación de la escuela sobre él | Solo **publicada** (regla vigente D5) | No | Sí, todas | No |
| Comparación contra la escuela | Solo si hay evaluación publicada | — | Sí | No |
| Comparación contra pares | Solo el **promedio anónimo** y el n, con `n ≥ K` | — | Sí, y la administración ya ve las evaluaciones por coach | No |
| Autoevaluación de sesión | Sí | No | Solo compartida | No |

Reglas:
- «Coach solo ve lo suyo» se cumple en tres capas: policy, gate dentro de la RPC y la ruta de BFF (resuelve el staff desde `auth.uid()`, nunca desde un parámetro).
- La escritura la hace el **dueño de la ficha**; un admin no escribe autoevaluaciones por el coach.
- Un coach **sin cuenta** no se autoevalúa (no hay quién). La evaluación de la escuela sobre él sigue funcionando como hoy (D9 del spec original).
- Es contenido operativo de personal, no dato de menores: no se muestra a familias en ningún camino, y no entra a informes de deportistas.

---

## 7. Cálculo del promedio con «No aplica»

### 7.1 Regla

Para una evaluación (de la escuela o autoevaluación), con ítems `i` y nota `s_i` (1–5) o N/A:

```
aplicables = { i : not_applicable = false }
overall    = round( sum(s_i en aplicables) / |aplicables| , 2 )     si |aplicables| >= 1
overall    = NULL                                                    si |aplicables| = 0
```

- **N/A no es 0 ni se imputa.** Se excluye del numerador y del denominador. Sin pesos (D7 del spec original).
- La RPC calcula `overall_score`, `applicable_count` y `na_count` en la **misma transacción** que escribe las notas (nunca en el cliente).
- **Se muestra siempre el denominador**: «4,3 · 5 de 6 ítems» (y «1 no aplica»). Un promedio sobre 2 ítems de 6 no se presenta igual que sobre 6.
- **Borrador**: puede tener 0 aplicables. **Enviar/publicar**: exige al menos 1.
- **Aviso suave**: si N/A supera la mitad de los ítems, la pantalla lo señala («Marcaste 4 de 6 como no aplica; ¿seguro?»). No bloquea.
- **N/A pide motivo opcional** (el campo comentario ya existe), no obligatorio.

### 7.2 Comparación sin engaño

Dos evaluaciones con distintos N/A **no son comparables en el total**. Regla de la RPC `get_coach_comparison`:
- Por ítem: se compara solo donde hay nota en ambos lados.
- Total comparable: promedio de ambos lados **restringido a la intersección de ítems aplicables en las dos**. Además se muestran los dos totales propios, rotulados.
- La diferencia (`self − school`) se muestra con signo y sin juicio de valor en el texto («te pusiste 0,5 más alto que la escuela en este ítem»).

### 7.3 Pares

- `peers_avg` por ítem = promedio de las notas **publicadas por la escuela** a los demás coaches, mismo período, misma escala, N/A excluido. Se usa la evaluación de la escuela y no las autoevaluaciones ajenas (que son privadas por defecto).
- Umbral `K` de anonimato: **mínimo 4 coaches evaluados distintos** del coach consultante por ítem (recomendado; Carmel tiene 7, o sea 6 pares como máximo). Con menos, la columna dice «Aún no hay suficientes comparaciones» y no se devuelve ningún número (ni el n exacto cuando sea menor que K).
- Nunca nombres de coaches en la respuesta al coach.

### 7.4 Casos borde (para pruebas)

Todo N/A · un solo ítem aplicable · ítem desactivado a mitad de período (se conserva por `criterion_name`) · ítem renombrado · período con N/A en el lado de la escuela y no en el del coach · nota 0 o 6 (rechazada) · `score` presente con `not_applicable=true` (rechazado por CHECK).

---

## 8. Pantallas

Mobile primero (el coach evalúa de pie). Reusa los componentes de `components/coach-evaluation/`; botones 1–5 con palabras (no slider) y un chip **«No aplica»** del mismo tamaño, con otro color y sin ícono de alerta.

### 8.1 Coach

En «Mis evaluaciones» (`/mis-evaluaciones`, hoy solo lectura), tres pestañas:
1. **De la escuela**: lo publicado (como hoy).
2. **Mi autoevaluación**: botón «Autoevaluarme». Selector de alcance:
   - *Mi período* (mensual/trimestral…, mismos períodos que la escuela);
   - *Una categoría* (lista de **sus** equipos vía `team_coaches`);
   - *Una sesión* (lista de sus sesiones finalizadas recientes).
   Una fila por ítem filtrado por `applies_to`, con el dato automático de su actividad al lado, y los cuatro textos. «Guardar borrador» / «Enviar». Tras enviar: «¿Compartir con la escuela?» (apagado por defecto).
3. **Comparación**: tarjeta por período/categoría con barras agrupadas por ítem (yo · escuela · promedio de pares), el total comparable y los avisos de n insuficiente. Una pregunta por gráfica, número encima de la barra (misma regla de gráficas de Seguimiento).

**Por sesión, en el flujo real:** al final de `CoachPostTrainingRatingDialog` (cuando el coach termina de calificar a las deportistas) un paso opcional y saltable «¿Cómo te fue en este entreno?» con **3 ítems de sesión** y «No aplica» en cada uno. Máximo una por sesión; se puede completar después desde la pestaña 2. No agrega un segundo aviso push.

Rutas: `/mis-evaluaciones` ya existe solo para el rol `coach`; hay que revisar los **dos árboles de menú** (clásico y «Más» de la V2 del entrenador) y `routePermissions.ts`. Esos archivos tienen cambios sin commitear de otras sesiones (ver R8).

### 8.2 Administración (dueño / admin)

- **Ficha del entrenador** (`CoachDetailSheet`): pestaña **«Comparación»** con la misma tarjeta, más la autoevaluación **solo si fue compartida**, con la etiqueta «Compartida por el entrenador el …».
- **Calificar**: el `CoachEvaluationDialog` gana el chip «No aplica» (flag `rubric_allow_na`) y el total «n de m ítems».
- **Ítems de calificación**: campo «Aplica a» (período / sesión / ambos).
- **Por categoría (F4, si D5 lo aprueba):** selector «General / Una categoría» al calificar.

### 8.3 Rúbrica del mesociclo (si D2 la incluye)

`MesocycleRubricTable.tsx`: botón «N/A» por celda (indicador × checkpoint); la celda N/A se pinta distinta de la vacía (vacía = pendiente, N/A = decidido). El promedio por indicador y el global excluyen N/A y muestran «n de 5 checkpoints».

---

## 9. Flag solo Carmel

Dos banderas independientes en `school_settings`, ambas `DEFAULT false`, ambas en `v_school_entitlements` y en `useEntitlements.ts` (mismo patrón de `allow_secondary_team_enrollment`):

| Flag | Gobierna | Entrega |
|---|---|---|
| `rubric_allow_na` | «No aplica» en la evaluación de la escuela y, si D2 lo incluye, en la rúbrica del mesociclo | Frente B #4, **antes** que lo demás |
| `coach_self_eval_enabled` | Autoevaluación, comparación, alcance categoría/sesión | Este spec, F1 en adelante |

Cómo se aplica (tres capas, porque el frontend solo oculta):
1. **Frontend**: menú, pestañas y paso del diálogo post-entreno condicionados al entitlement.
2. **RPC**: cada RPC nueva lee el flag de la escuela del staff y falla con `42501`/mensaje claro si está apagado. Es el gate real.
3. **BFF**: la ruta de «mi actividad» valida el flag con el mismo helper. En el working tree hay un `requireEntitlement.ts` sin commitear de otra sesión: **no depender de él**; usar la lectura directa de `school_settings` hasta que esa sesión lo suba.

Encender Carmel: `UPDATE school_settings SET … WHERE school_id = '374a6716-…'` por una vía con rastro, pedido por el usuario (no se prende solo).

---

## 10. Decisiones para el usuario

### D1. ¿Qué significa «por categoría y por sesión»?
- **A. Del coach** (autoevaluación y evaluación con alcance de categoría y de sesión). *Es la lectura de este spec.*
- **B. De los deportistas**: ya existe casi todo (evaluación por sesión en `performance_entries`, informe grupal por equipo, `team_reports`); faltaría una vista y no una evaluación nueva.
- **C. Ambas.**
- **Recomendación: A**, y confirmar con Julián en una frase antes de construir F2. Si resulta B, este spec se reduce a F0 (N/A) más una vista.

### D2. ¿A qué rúbrica se le pone «No aplica»?
- **A. Solo la evaluación de entrenadores** (1–5).
- **B. Solo la rúbrica del mesociclo** (1–10, `MesocycleRubricTable`).
- **C. Las dos**, con la misma convención.
- El plan de la semana lista «Rúbrica con "No aplica"» junto a «Mesociclo: cargar dos semanas a la vez», lo que sugiere B; el ítem 5 habla de evaluaciones de entrenadores.
- **Recomendación: C**, con A primero (tabla chica, una sola RPC) y B enseguida. Preguntar a Julián cuál rúbrica nombró.

### D3. ¿La autoevaluación la ve la escuela?
- **A. Privada, y el coach decide compartirla** (casilla «Compartir con la escuela», apagada).
- **B. Siempre visible para la administración.**
- **C. Siempre privada** (solo el coach; la escuela solo ve la comparación).
- **Recomendación: A.** Una autoevaluación que se sabe vigilada tiende a inflarse; con la opción de compartir, el coach que quiere mostrar su reflexión puede hacerlo. B es defendible si Carmel la pide como instrumento de control, pero hay que pedirlo explícitamente.

### D4. ¿Contra quién se compara?
- **A. Solo contra la evaluación de la escuela.**
- **B. Solo contra pares.**
- **C. Contra ambos.**
- **Recomendación: C**, con pares condicionado a `n ≥ 4` y anónimo. Con 7 coaches, un promedio de 2 o 3 pares equivale a señalar personas; por eso el umbral. Con menos de 4, no se muestra y no se inventa.

### D5. ¿La escuela evalúa también por categoría y por sesión?
- **A. Por categoría sí; por sesión solo autoevaluación.**
- **B. Ninguno** (la escuela evalúa solo por período, como hoy).
- **C. Los dos.**
- **Recomendación: A.** Un coach con dos categorías (Carlos Ruiz tiene dos) puede rendir distinto en cada una. La evaluación de la escuela por sesión exigiría visitas y volumen que Carmel no ha pedido. La categoría para la escuela cambia el `UNIQUE` de `coach_evaluations`, por eso va en F4 y no antes.

### D6. ¿Cuándo se autoevalúa la sesión?
- **A. Paso opcional al terminar de calificar a las deportistas** (3 ítems, saltable).
- **B. Un resumen semanal** en lugar de por sesión.
- **C. Ninguno por ahora.**
- **Recomendación: A**: es el momento en que el coach ya tiene el celular y el contexto, sin push nuevo. Si en las primeras semanas la tasa de uso es baja, pasar a B.

### D7. ¿Mismos ítems o ítems propios para la autoevaluación?
- **A. Mismos ítems de la escuela**, con `applies_to` (período/sesión/ambos).
- **B. Un set aparte** para autoevaluación.
- **Recomendación: A.** Sin ítems comunes no hay comparación. Los de sesión (2–3) se agregan a la plantilla de Carmel desde `CriteriaManagerDialog`; no se pisan los ya existentes.

### D8. ¿Una bandera o dos?
- **A. Dos** (`rubric_allow_na` y `coach_self_eval_enabled`).
- **B. Una** (`evaluaciones_ampliadas`).
- **Recomendación: A.** El «No aplica» sale con el Frente B (ya está en la cola de esta semana) y no debe quedar esperando al resto.

### D9. ¿Tablas paralelas o extender `coach_evaluations`?
- **A. Paralelas para la autoevaluación**; la evaluación de la escuela solo gana N/A y, en F4, `team_id`.
- **B. Una sola tabla con `kind` y `scope`.**
- **Recomendación: A.** Evita tocar `UNIQUE` y policies de un módulo vivo mientras el Frente B #1 todavía investiga por qué no llega al coach. B es más compacto, pero cualquier error de policy expone autoevaluaciones privadas o borradores.

### D10. Ventana de edición de la autoevaluación de sesión
- **A. 7 días** desde la sesión.
- **B. Sin límite.**
- **C. 24 h** (como la encuesta del padre).
- **Recomendación: A**: el coach no siempre la llena el mismo día y 24 h sería frustrante; sin límite abre el cambio retroactivo de lo comparado.

---

## 11. Fases, criterios de aceptación y orden

**F0 — Prerrequisitos (sin código nuevo de este spec)**
1. Cerrar el Frente B #1: reproducir por qué la evaluación publicada no le llega al coach de Carmel. Si es un defecto de la RPC o de la policy, **se arregla antes** de apoyar la autoevaluación encima.
2. Confirmar D1 y D2 con Julián; pedirle su formato de evaluación actual (el plan de septiembre ya lo requería para el informe).
3. Verificación en la base viva, solo lectura filtrada por nombre: conteo de `coach_evaluations` publicadas de Carmel y que `my_coach_staff_ids()` devuelva ficha para uno de sus coaches.

**F1 — «No aplica» + flags `[DB/Frontend]`** (Frente B #4)
Migración nueva: `score` nullable + `not_applicable` + CHECK, `rubric_allow_na`, `save_coach_evaluation` actualizada desde la última versión. Frontend: chip y total «n de m». Acepta: con flag apagado todo se comporta como hoy; con flag, un N/A no entra al promedio; no se publica con 0 aplicables; las evaluaciones viejas no cambian.

**F2 — Autoevaluación por período y categoría + comparación con la escuela `[DB/BFF/Frontend]`**
Tablas §4.2, RLS §4.3, `save_/share_/delete_coach_self_evaluation`, `get_coach_comparison` (solo escuela en esta fase), ruta BFF «mi actividad» (misma lógica pura de `coach-activity.aggregate.ts`; gate coach por `auth.uid()`; solo al abrir la pantalla, lectura acotada por `staff_id` + fechas, `.in()` en tandas), pestañas del coach, pestaña «Comparación» del admin. Acepta: un coach no ve autoevaluaciones ajenas; el admin solo ve las compartidas; la comparación respeta N/A; `anon` = 0 filas.

**F3 — Por sesión y pares `[Frontend/DB]`**
Paso opcional en `CoachPostTrainingRatingDialog`; ítems de sesión (`applies_to`); `peers_avg` con `K`. Acepta: con menos de K pares la respuesta no trae ningún número; una sola autoevaluación por sesión; la sesión no finalizada o de otro equipo falla.

**F4 — Evaluación de la escuela por categoría (si D5 = A o C) `[DB/Frontend]`**
`team_id` en `coach_evaluations` con nuevo índice único; ajuste de `save_coach_evaluation` y del historial. Acepta: dos evaluaciones del mismo coach y período en categorías distintas conviven; la evaluación general sigue siendo única.

**Rule del repo para todas las fases:** una sola sesión aplica migraciones, con rastro (CLI o `apply_migration`); `types.ts` se regenera **una vez** al final del lote; no se usa `list_tables` ni `get_advisors` como sondeo; commit solo de lo propio (hay trabajo ajeno sin commitear).

### Pruebas mínimas

- **Unitarias** (vitest): promedio con N/A y casos borde de §7.4, alineación de períodos, intersección de ítems comparables, umbral `K`.
- **RPC/RLS** (con `set_config('request.jwt.claims', …)`): coach A llamando por el staff de coach B → `42501`; admin de otra escuela → error; flag apagado → error; `anon` → 0 filas; coach ve sus borradores pero no los ajenos; admin no ve una autoevaluación no compartida; la evaluación de la escuela en borrador **no** aparece en la comparación del coach.
- **Concurrencia**: dos envíos simultáneos de la misma autoevaluación → una sola fila (índice único + upsert).
- **Integridad**: `score` con `not_applicable=true` rechazado; CHECK de coherencia de `scope`.
- **En pantalla** (Playwright): autoevaluarse con un N/A, ver el total «n de m», compartir, ver la comparación; con `n < K` ver el aviso.
- **Gate**: `npm run seguridad:invariantes` sin críticas y, cuando se aplique la migración, listar todas las policies de las cuatro tablas (`pg_policies`).

---

## 12. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | **El flujo admin → coach aún no está verificado en producción** (Frente B #1). Apoyar la autoevaluación sobre una publicación que no llega daría una comparación sin contraparte | F0.1 antes de F2; la comparación muestra «Aún no hay evaluación publicada» sin romper |
| R2 | **Anonimato de pares con 7 coaches**: con pocos pares, un promedio señala personas | `K ≥ 4`, sin nombres, sin devolver el n si es menor que K; D4 |
| R3 | **Autoevaluación inflada si se siente vigilada** | Privada por defecto con opción de compartir (D3); la comparación la ve primero el coach |
| R4 | **N/A usado para esquivar ítems malos**: baja la exigencia del promedio | Se muestra siempre «n de m», aviso al pasar de la mitad, y el admin ve cuántos N/A puso cada quien |
| R5 | **N/A en `performance_entries` (modo individual de la rúbrica)**: no verifiqué si `value` admite NULL; usar «sin fila» confunde pendiente con N/A | Verificar la columna antes de F1 (D2 = B o C); si no admite NULL, N/A solo en modo equipo en la primera entrega |
| R6 | **Cambiar el `UNIQUE` de `coach_evaluations` para categoría (F4)**: un `ON CONFLICT` mal inferido rompe el guardado vivo | F4 al final, tras ver F2/F3 en uso; migración con rollback documentado; D9 = tablas paralelas para lo demás |
| R7 | **Policies permisivas se suman con OR**: una policy extra de lectura sobre `coach_evaluations` expone borradores | No se agrega ninguna policy sobre las tablas existentes; revisar `pg_policies` completa tras cada migración |
| R8 | **Conflicto con otras sesiones en `develop`**: `App.tsx`, `navigation.ts`, `routePermissions.ts`, `useEntitlements.ts`, `types.ts` y `migrations_ledger.json` tienen cambios sin commitear ajenos | Commit con índice temporal y solo lo propio; `ledger` con `npm run migrations:new`; no regenerar `types.ts` hasta el final |
| R9 | **Disk IO**: un rango anual por coach en «mi actividad» y comparaciones | Solo al abrir la pantalla, sin jobs, lectura acotada, `get_coach_comparison` en una consulta agregada; no usar el catálogo de funciones como sondeo |
| R10 | **Consentimiento y confianza en Carmel**: los padres ya objetaron datos de rendimiento; esto es sobre personal, no menores, pero el mismo cuidado de «no mostrar a quien no corresponde» aplica | Nada de esto llega a familias; sin informes públicos; ver §6 |
| R11 | **La sesión depende de `attendance_sessions.finalized`**: si el coach no cierra la lista, no hay autoevaluación de sesión (mismo cuello de botella de la encuesta; el plan registra la lista de «Ayer / Otro día» de la V2 sin cierre) | Aceptado: sin cierre no hay sesión evaluable; el pendiente del Coach V2 (B14) se arregla aparte |
| R12 | **CRLF en el repo**: parches multilínea fallan al editar | Normalizar `\r\n` al implementar |

---

## 13. Entrega

Full-stack de corrido, sin ramas por fases, con revisión entre F1, F2 y F3 si el usuario lo pide: migración (`npm run migrations:new -- coach-self-eval`) → RPCs → BFF → frontend → `seguridad:invariantes` → pruebas. Manual del entrenador de Carmel (ítem 10 del plan de septiembre) incluye un capítulo breve de autoevaluación **solo cuando F2 esté en producción**. Staging y main los pide el usuario.
