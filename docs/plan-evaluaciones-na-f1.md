# Plan — Evaluaciones ampliadas (Carmel), Fase 1: «No aplica» (N/A) en ambas rúbricas

> Fecha: 2026-11-05 · Estado: **PLAN para aprobación. Sin código, sin migraciones, sin tocar la base.**
> Spec madre: `docs/specs/evaluaciones-ampliadas-carmel.md` (§10: D1 = entrenador, D2 = ambas rúbricas, ya cerradas). Esta fase es el «F1» del §11 (Frente B #4 del plan de la semana).
> Alcance: la opción **«No aplica»**, que **no cuenta en el promedio**, en (1) la evaluación de entrenadores (escala 1–5) y (2) la rúbrica del mesociclo (escala 1–10). Todo detrás de `school_settings.rubric_allow_na` (default `false`, Carmel `true`). Más 2 mejoras UX baratas (§10).
> Fuera de esta fase: autoevaluación, comparación, categoría/sesión, pares (F2–F4 del spec).

---

## 0. Lo verificado (código + base viva, solo lectura filtrada por nombre)

Consultas por nombre a `pg_proc`, `pg_constraint`, `information_schema` y conteos (2026-11-05, base compartida). Sin `list_tables`, sin `get_advisors`.

| Hecho | Evidencia |
|---|---|
| `save_coach_evaluation` viva **coincide con el repo** (`20261029191217`, con aviso al publicar): md5 del cuerpo sin espacios `aafb5c90…` en ambos lados | SECURITY DEFINER, `search_path=pg_catalog, public, pg_temp`, ACL: `postgres, service_role, authenticated` (sin `anon`, sin PUBLIC) |
| `coach_evaluation_scores.score` = `smallint NOT NULL`, CHECK `coach_evaluation_scores_score_check (score >= 1 AND score <= 5)` | Nadie más lee o escribe esa tabla: solo la RPC, `api.ts`, el diálogo y `EvaluationHistory` |
| `training_mesocycle_evaluations.score` = `smallint NOT NULL`, CHECK `training_mesocycle_evaluations_score_check (1..10)`, `UNIQUE (mesocycle_id, indicator, checkpoint)`; triggers: solo `update_..._updated_at`; 142 filas | Se **escribe directo desde el cliente** (`supabase.from(...).upsert`, RLS `user_staff_school_ids()`), **sin RPC** |
| `performance_entries.value` = `numeric NOT NULL` (modo individual de la rúbrica). Tabla compartida con Evolución, informes, snapshots. 9 filas `mesociclo_*` en total | No admite NULL. Meterle NULL contamina a todos sus lectores |
| `v_school_entitlements`: 41 columnas, la última es `coach_attendance_retro_days` (pos. 41), idéntica a la cola de `20261014153542` | El BFF la entrega con `select('*')` (`me.routes.ts:40`): una columna nueva llega sola al frontend |
| `school_settings.rubric_allow_na` **no existe** aún | — |
| `coach_evaluations`: 2 filas en total en toda la base, **0 de Carmel** | Radio mínimo; nada que migrar |
| La rúbrica del mesociclo **no calcula ningún promedio**: ni en el componente, ni en el PDF (`MesocycleExportButton.drawRubric` solo pinta celdas), ni en la base. Tampoco hay columna que lo guarde | El promedio de la rúbrica es **nuevo**; no hay nada que corregir, hay que decidir dónde nace (§4) |
| El promedio de entrenadores hoy: `CoachEvaluationDialog.tsx:110` (vista previa en el cliente) y `save_coach_evaluation` (`round(avg(score)::numeric, 2)` → `coach_evaluations.overall_score`, el valor que se guarda y se muestra) | — |
| BFF cuenta filas de `training_mesocycle_evaluations` por `created_by` como actividad del entrenador (`coach-activity.ts:178` y `:331`) | Una fila N/A no debe inflar «evaluaciones» (§6.3) |

**Estado de los archivos ajenos (git status de hoy, 2026-11-05):** `App.tsx`, `navigation.ts`, `routePermissions.ts`, `useEntitlements.ts` y `types.ts` aparecen **limpios ahora** (la otra sesión ya los subió). Lo que sigue modificado sin commitear y es ajeno: `supabase/migrations_ledger.json`, `bff/src/index.ts`, `authMiddleware.ts`, rutas de reservas, `ApprovePaymentMethodSheet.tsx`, `reservasApi.ts`, `approvePayment.ts`, `PaymentsAutomationPage.tsx`, y `docs/specs/evaluaciones-ampliadas-carmel.md` / `partido-en-vivo-sustituciones.md`. Ver §11: se re-verifica antes de editar.

---

## 1. Decisión de modelo: `not_applicable boolean` vs `score` nullable

**Recomendación: columna explícita `not_applicable boolean NOT NULL DEFAULT false` + `score` nullable + CHECK de coherencia.** (Es lo que ya trae el spec §4.1.)

Por qué no «solo `score NULL`»:
1. **NULL es ambiguo.** «Todavía no lo califiqué» y «decidí que no aplica» serían lo mismo. En la rúbrica del mesociclo importa: celda vacía = pendiente, N/A = decidido (spec §8.3). En la evaluación de entrenadores hoy `NULL` significa «error» y la RPC lo rechaza (`s.score IS NULL` en el conteo de `v_bad`).
2. **El CHECK lo puede imponer la base**, no solo el cliente: `(not_applicable AND score IS NULL) OR (NOT not_applicable AND score BETWEEN 1 AND 5)`. Con solo-NULL no hay forma de prohibir «score NULL por descuido».
3. **Compatibilidad total hacia atrás:** `DEFAULT false` deja todas las filas existentes válidas sin backfill; el código viejo que no manda `not_applicable` sigue funcionando para el 100 % de los datos que existen hoy.
4. **`avg()` ya ignora NULL**, pero igual se calcula con `FILTER (WHERE NOT not_applicable)` para que la regla se lea y no dependa de un efecto lateral.

Costo aceptado: una columna más y un CHECK nuevo. Tablas chicas (`coach_evaluation_scores`: pocas filas; `training_mesocycle_evaluations`: 142), el `ADD CONSTRAINT` valida en milisegundos.

**Modo individual del mesociclo (`performance_entries`):** `value` es `NOT NULL` y la tabla la leen otras pantallas (Evolución, informes), así que **no se le mete NULL ni un valor centinela**. N/A va en una **tabla lateral** (§5.4, opcional y al final, F1c). Dato clave: solo hay **9 filas `mesociclo_*`** en toda la base (el modo individual casi no se usa), por eso es lo último y se puede postergar sin bloquear lo demás.

---

## 2. Reglas del promedio (idénticas en las dos rúbricas)

```
aplicables = celdas/ítems con nota (not_applicable = false)
promedio   = sum(notas de aplicables) / |aplicables|     si |aplicables| >= 1
promedio   = NULL                                         si |aplicables| = 0
```
- **N/A fuera del numerador y del denominador.** No es 0, no se imputa. Sin pesos.
- **Pendiente ≠ N/A.** Un ítem sin responder tampoco cuenta, pero no es una decisión; en la rúbrica se pinta distinto (vacío vs «N/A») y se informa aparte («2 pendientes»).
- **Siempre se muestra «n de m»**: «4,3 · 5 de 6 ítems» (y «1 no aplica» si hay). Un promedio sobre 2 de 6 no se presenta igual que sobre 6.
- **No se publica con 0 aplicables** (entrenadores): la RPC lo rechaza (`22023`) y el botón «Publicar» se deshabilita. El **borrador sí** puede quedar todo en N/A (`overall_score = NULL`).
- **Aviso suave** (no bloquea): si N/A supera la mitad de los ítems, «Marcaste 4 de 6 como no aplica; ¿seguro?».
- **Dónde nace el promedio:**
  - Entrenadores: **la RPC es la fuente** (`overall_score`, ya existente); el cliente solo hace la vista previa con la misma fórmula (función pura compartida, §6.1) y History/coach muestran el `overall_score` guardado.
  - Rúbrica del mesociclo: **solo en el frontend, solo de visualización** (función pura `mesocycleRubricMath.ts`). Justificación: hoy nada guarda ni consume un promedio de rúbrica (verificado: ni columna, ni PDF, ni BFF); inventar una RPC o columna agregada sería construir lo que nadie lee. Si más adelante un informe lo necesita, se migra a SQL con la misma regla y el mismo test de paridad.

---

## 3. Flag `school_settings.rubric_allow_na`

| Capa | Qué hace |
|---|---|
| Base | `school_settings.rubric_allow_na boolean NOT NULL DEFAULT false`; se agrega **al final** de `v_school_entitlements` (posición 42). Carmel (`374a6716-af42-4745-afe1-8d089153e01b`) en `true`. |
| Gate real (entrenadores) | Dentro de `save_coach_evaluation`: si algún ítem viene en N/A y la escuela no tiene el flag → `42501`. Si no hay N/A **no se lee `school_settings`** (cero consultas nuevas para las demás escuelas). |
| Gate real (mesociclo, escritura directa) | Trigger `BEFORE INSERT OR UPDATE` sobre `training_mesocycle_evaluations` que rechaza `not_applicable = true` sin flag (§5.3). Se usa trigger porque esa tabla no pasa por RPC. |
| Frontend | `useEntitlements` expone `rubricAllowNa`; chip, «n de m» y promedio de la rúbrica solo con flag. **Leer** N/A ya guardados funciona siempre (con o sin flag). |
| BFF | Sin cambios de lógica de flag (`select('*')` ya lo entrega). |

Encendido de Carmel: el `UPDATE school_settings … WHERE school_id = '374a6716-…'` va como **última sentencia de la migración A** (mismo patrón de `20260926124337` y `20260924101138`, fila verificada) y la migración queda aplicada por una vía con rastro. Ver checklist: opción A (en la migración) o B (paso aparte cuando el usuario lo pida).

---

## 4. Migraciones propuestas (se crean al ejecutar, con `npm run migrations:new -- <slug>`; **no** se crean en este plan)

Dos migraciones (una por rúbrica, para poder revertir cada una sin tocar la otra) y una tercera opcional. **Una sola sesión las aplica**, en este orden, con rastro (CLI o `apply_migration`), `types.ts` sin regenerar (todo el código usa `supabase as any`; ver §11).

### 4.A `rubrica_na_entrenadores` — flag + vista + scores + RPC

1. **Flag**
```sql
ALTER TABLE public.school_settings
  ADD COLUMN IF NOT EXISTS rubric_allow_na boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.school_settings.rubric_allow_na IS
  '«No aplica» en las rúbricas (evaluación de entrenadores y rúbrica del mesociclo); no cuenta en el promedio. Carmel = true.';
```
2. **Vista:** `CREATE OR REPLACE VIEW public.v_school_entitlements` copiando la definición **viva** completa (`pg_get_viewdef('public.v_school_entitlements'::regclass, true)`, una sola lectura filtrada por nombre) y agregando **al final** `COALESCE(sset.rubric_allow_na, false) AS rubric_allow_na`. Después `ALTER VIEW … SET (security_invoker = true)` y `NOTIFY pgrst, 'reload schema'`. Reglas: `CREATE OR REPLACE VIEW` no reordena ni renombra (42P16), por eso la columna nueva va al final; la cola vigente es `…allow_secondary_team_enrollment, coach_attendance_retro_days` (mismo patrón que `20260926124337`). Copiar de la base y no de una migración vieja, porque el repo y la base no siempre coinciden.
3. **Scores**
```sql
ALTER TABLE public.coach_evaluation_scores
  ADD COLUMN IF NOT EXISTS not_applicable boolean NOT NULL DEFAULT false;
ALTER TABLE public.coach_evaluation_scores ALTER COLUMN score DROP NOT NULL;
ALTER TABLE public.coach_evaluation_scores DROP CONSTRAINT IF EXISTS coach_evaluation_scores_score_check;
ALTER TABLE public.coach_evaluation_scores
  ADD CONSTRAINT coach_evaluation_scores_na_score_check
  CHECK ((not_applicable AND score IS NULL) OR (NOT not_applicable AND score BETWEEN 1 AND 5));
```
Con `SET LOCAL lock_timeout = '5s'` al inicio (patrón de `20260925170003`). Sin policies nuevas ni cambios de GRANT de tabla (las policies actuales de `coach_evaluations`/`coach_evaluation_scores` no se tocan: riesgo R7 del spec).

4. **`save_coach_evaluation`** — `CREATE OR REPLACE` **partiendo del cuerpo de `20261029191217`** (la versión viva, verificada por hash). **Misma firma** de 10 parámetros → conserva ACL, y aun así se repiten `REVOKE … FROM PUBLIC, anon` y `GRANT EXECUTE … TO authenticated` (CLAUDE.md: GRANT explícito por RPC). Cambios señalados con `-- NUEVO`; todo lo demás (gate, período, duplicados, upsert, aviso con su `EXCEPTION WHEN OTHERS`) queda **igual**:

```sql
CREATE OR REPLACE FUNCTION public.save_coach_evaluation(
    p_staff_id uuid, p_period_type text, p_period_start date, p_scores jsonb,
    p_strengths text, p_improvements text, p_commitments text, p_other_notes text,
    p_snapshot jsonb, p_publish boolean)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid(); v_school uuid; v_coach_user uuid; v_prev text; v_end date;
    v_id uuid; v_bad integer; v_n integer; v_score numeric; v_school_nm text;
    v_na integer; v_app integer; v_allow_na boolean;                         -- NUEVO
BEGIN
    -- GATE (idéntico, escrito dentro del cuerpo)
    SELECT school_id, coach_auth_id INTO v_school, v_coach_user FROM public.school_staff WHERE id = p_staff_id;
    IF v_uid IS NULL OR v_school IS NULL
       OR NOT (public.is_super_admin() OR v_school = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Solo el dueño o la administración de la escuela califican a los entrenadores.' USING ERRCODE = '42501';
    END IF;

    v_end := public._coach_eval_period_end(p_period_type, p_period_start);

    IF p_scores IS NULL OR jsonb_typeof(p_scores) <> 'array' OR jsonb_array_length(p_scores) = 0 THEN
        RAISE EXCEPTION 'Califica al menos un ítem.' USING ERRCODE = '22023';
    END IF;

    -- NUEVO: cuántos N/A y cuántos con nota
    SELECT count(*) FILTER (WHERE COALESCE(s.not_applicable, false)),
           count(*) FILTER (WHERE NOT COALESCE(s.not_applicable, false))
      INTO v_na, v_app
      FROM jsonb_to_recordset(p_scores) AS s(criterion_id uuid, score int, not_applicable boolean, comment text);

    -- NUEVO: el flag solo se lee si vino algún N/A
    IF v_na > 0 THEN
        SELECT COALESCE(ss.rubric_allow_na, false) INTO v_allow_na
          FROM public.school_settings ss WHERE ss.school_id = v_school;
        IF NOT COALESCE(v_allow_na, false) THEN
            RAISE EXCEPTION 'La opción «No aplica» no está habilitada para esta escuela.' USING ERRCODE = '42501';
        END IF;
    END IF;

    -- CAMBIA: nota 1-5 si aplica; sin nota (NULL) si es N/A
    SELECT count(*) INTO v_bad
      FROM jsonb_to_recordset(p_scores) AS s(criterion_id uuid, score int, not_applicable boolean, comment text)
      LEFT JOIN public.coach_evaluation_criteria c ON c.id = s.criterion_id AND c.school_id = v_school
     WHERE c.id IS NULL
        OR (COALESCE(s.not_applicable, false) AND s.score IS NOT NULL)
        OR (NOT COALESCE(s.not_applicable, false) AND (s.score IS NULL OR s.score NOT BETWEEN 1 AND 5));
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'Hay ítems que no son de la escuela, notas fuera de 1 a 5 o «No aplica» con nota.' USING ERRCODE = '22023';
    END IF;

    -- (duplicados: idéntico)

    -- NUEVO: publicar exige al menos un ítem con nota
    IF p_publish AND v_app = 0 THEN
        RAISE EXCEPTION 'Para publicar necesitas al menos un ítem con nota (todos en «No aplica» solo sirve como borrador).' USING ERRCODE = '22023';
    END IF;

    -- (v_prev + INSERT … ON CONFLICT (staff_id, period_type, period_start): idéntico)

    DELETE FROM public.coach_evaluation_scores WHERE evaluation_id = v_id;
    INSERT INTO public.coach_evaluation_scores (evaluation_id, criterion_id, criterion_name, score, not_applicable, comment)
    SELECT v_id, s.criterion_id, c.name,
           CASE WHEN COALESCE(s.not_applicable, false) THEN NULL ELSE s.score END,
           COALESCE(s.not_applicable, false),
           NULLIF(btrim(COALESCE(s.comment, '')), '')
      FROM jsonb_to_recordset(p_scores) AS s(criterion_id uuid, score int, not_applicable boolean, comment text)
      JOIN public.coach_evaluation_criteria c ON c.id = s.criterion_id;

    -- CAMBIA: promedio solo de lo aplicable (NULL si no hay)
    SELECT round((avg(score) FILTER (WHERE NOT not_applicable))::numeric, 2) INTO v_score
      FROM public.coach_evaluation_scores WHERE evaluation_id = v_id;
    UPDATE public.coach_evaluations SET overall_score = v_score WHERE id = v_id;

    -- Aviso (idéntico; v_score nunca es NULL aquí porque publicar exige v_app >= 1).
    -- Único ajuste: si v_na > 0 el mensaje añade ' (' || v_app || ' de ' || (v_app+v_na) || ' ítems)'.
    …
    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_coach_evaluation(uuid,text,date,jsonb,text,text,text,text,jsonb,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_coach_evaluation(uuid,text,date,jsonb,text,text,text,text,jsonb,boolean) TO authenticated;
```
Notas de diseño:
- Un payload **sin** `not_applicable` (frontend viejo, otras escuelas) se comporta **exactamente** igual que hoy: `COALESCE(…, false)`, `v_na = 0`, no se lee `school_settings`.
- El recordset declara `not_applicable boolean`; un JSON sin esa clave da NULL → `false`.
- **Antes de aplicar:** volver a comparar el hash vivo de `save_coach_evaluation` (`aafb5c90…`); si alguien lo cambió por fuera, se parte de la versión viva.
- Invariantes del repo: `SECURITY DEFINER` con `search_path` fijo (I4), gate dentro del cuerpo (I7), sin `FOR ALL`.

5. **Carmel:** `UPDATE public.school_settings SET rubric_allow_na = true WHERE school_id = '374a6716-af42-4745-afe1-8d089153e01b';` (última sentencia; ver opción A/B del checklist).

### 4.B `rubrica_na_mesociclo` — tabla del modo equipo + trigger de gate

```sql
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.training_mesocycle_evaluations
  ADD COLUMN IF NOT EXISTS not_applicable boolean NOT NULL DEFAULT false;
ALTER TABLE public.training_mesocycle_evaluations ALTER COLUMN score DROP NOT NULL;
ALTER TABLE public.training_mesocycle_evaluations DROP CONSTRAINT IF EXISTS training_mesocycle_evaluations_score_check;
ALTER TABLE public.training_mesocycle_evaluations
  ADD CONSTRAINT training_mesocycle_evaluations_na_score_check
  CHECK ((not_applicable AND score IS NULL) OR (NOT not_applicable AND score BETWEEN 1 AND 10));

CREATE OR REPLACE FUNCTION public._guard_mesocycle_eval_na() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.not_applicable AND NOT COALESCE(
       (SELECT ss.rubric_allow_na FROM public.school_settings ss WHERE ss.school_id = NEW.school_id), false) THEN
    RAISE EXCEPTION 'La opción «No aplica» no está habilitada para esta escuela.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._guard_mesocycle_eval_na() FROM PUBLIC, anon, authenticated;  -- helper de trigger: sin GRANT (no lo llama una policy)
CREATE TRIGGER trg_mesocycle_eval_na_guard
  BEFORE INSERT OR UPDATE OF not_applicable ON public.training_mesocycle_evaluations
  FOR EACH ROW EXECUTE FUNCTION public._guard_mesocycle_eval_na();
```
- Es **helper que no usa una policy** → `REVOKE ALL … FROM PUBLIC, anon, authenticated` y sin GRANT (regla de «dos casos» de CLAUDE.md). Postgres no exige `EXECUTE` al disparar un trigger.
- La **RLS no cambia** (`user_staff_school_ids()` para select/insert/update/delete). La escritura sigue directa; el trigger solo añade el gate del flag. No se agregan policies.
- `_drift_check.sql` (línea 204) lista las columnas esperadas de esta tabla: agregar `not_applicable` ahí en el mismo commit.
- El `UNIQUE (mesocycle_id, indicator, checkpoint)` queda igual: el upsert del cliente sigue infiriendo sobre él.

### 4.C `rubrica_na_mesociclo_individual` — OPCIONAL (F1c), solo si el usuario lo confirma
Tabla lateral `training_mesocycle_individual_na (id, school_id, mesocycle_id FK ON DELETE CASCADE, subject_type CHECK in (profile,child,unregistered), subject_id, indicator CHECK, checkpoint CHECK, marked_by FK profiles, marked_at timestamptz DEFAULT now(), UNIQUE (mesocycle_id, subject_type, subject_id, indicator, checkpoint))`, RLS solo `SELECT` con `user_staff_school_ids()`, escritura por RPC `set_mesocycle_individual_na(p_mesocycle_id, p_subject_type, p_subject_id, p_indicator, p_checkpoint, p_na boolean)` (`SECURITY DEFINER`, `search_path` fijo, `REVOKE … FROM PUBLIC, anon`, `GRANT EXECUTE … TO authenticated`; gate dentro: escuela derivada **del mesociclo**, `= ANY(user_staff_school_ids())`, flag, y la misma validación del sujeto que usa `performance_entries_insert_school_or_self`, que hay que leer antes de escribirla). **Regla de lectura sin acoplar escrituras:** una celda es N/A si existe fila lateral **y no hay** `performance_entries` posterior (`recorded_at > marked_at`) para ese sujeto/indicador/corte/mesociclo; guardar una nota después de un N/A lo anula solo, y marcar N/A después de una nota lo pisa. Reversible sin tocar `performance_entries`. Se justifica con los 9 registros reales: puede esperar.

---

## 5. Archivos exactos a tocar

### 5.1 Frontend — evaluación de entrenadores
| Archivo | Cambio |
|---|---|
| `frontend/src/components/coach-evaluation/scoring.ts` (**nuevo**, puro) | `summarizeScores(items): { applicable, na, answered, total, average }` (promedio solo de aplicables, `null` sin aplicables), `canPublish`, `naMajority` (N/A > 50 %), `buildScoresPayload(state, { allowNa })` (con flag apagado el payload es **idéntico al de hoy**: sin clave `not_applicable`), `formatCount(applicable, total)` → «5 de 6 ítems». Lo usan el diálogo y el historial. |
| `frontend/src/components/coach-evaluation/api.ts` | `EvaluationScore`: `score: number \| null`, `not_applicable: boolean`. `EVAL_COLS`: agregar `not_applicable` dentro de `coach_evaluation_scores(...)`. `saveEvaluation`: `scores: { criterion_id; score: number \| null; not_applicable?: boolean; comment }[]`. |
| `frontend/src/components/coach-evaluation/CoachEvaluationDialog.tsx` | `ScoreState` gana `na?: boolean`. Línea 97: cargar `score: s.score ?? undefined, na: s.not_applicable`. Línea 108: el ítem inactivo se conserva si tiene nota **o** N/A. Líneas 109–112: `scored` → `answered` (nota o N/A) y `average` = `summarizeScores`. Línea ~236–255: bajo los 5 botones, chip «No aplica» (mismo tamaño táctil, color neutro, sin ícono de alerta, `role="radio"` en el mismo grupo; elegirlo borra la nota y elegir una nota lo quita); solo si `rubricAllowNa`. Líneas 289–293: pie «Promedio: 4,3 · 5 de 6 ítems · 1 no aplica». Aviso ámbar si `naMajority`. «Publicar» deshabilitado con 0 aplicables (con texto «Para publicar, al menos un ítem con nota»); «Guardar borrador» sigue exigiendo ≥ 1 respondido. Línea 119: payload por `buildScoresPayload`. **Mejora UX #1 (toast, línea ~127):** ver §10. |
| `frontend/src/components/coach-evaluation/EvaluationHistory.tsx` | Detalle (línea ~82–91): si `s.not_applicable`, mostrar chip gris «No aplica» en vez de «score · palabra» (sin color de nota). Fila del historial (línea ~59): `4,3 · Muy bien` **+ ` · 5 de 6 ítems` solo si hay N/A** (así lo ya publicado se ve idéntico). `overall_score = null` → «Sin ítems con nota». Las barras (`scoreTone`) ya manejan `null`. Sirve igual para la ficha del admin y para «Mis evaluaciones» del coach (RLS no cambia: el coach sigue viendo solo lo publicado). |
| `frontend/src/hooks/useEntitlements.ts` | `EntitlementsResponse.rubric_allow_na?: boolean`; `Entitlements.rubricAllowNa: boolean`; `EMPTY_ENTITLEMENTS.rubricAllowNa = false`; mapeo `rubricAllowNa: data.rubric_allow_na === true`. Un BFF/vista vieja sin el campo → `false` (nadie ve el chip). Ningún test arma un `Entitlements` completo (verificado por búsqueda), no se rompen fixtures. |

### 5.2 Frontend — rúbrica del mesociclo
| Archivo | Cambio |
|---|---|
| `frontend/src/components/coach/mesocycleRubricMath.ts` (**nuevo**, puro) | `summarizeRubric(cells)` → por indicador `{ average, applicable, na, pending, total: 5 }` y global `{ average, applicable, na, pending, total: 30 }`. Mismas reglas del §2. |
| `frontend/src/components/coach/MesocycleRubricTable.tsx` | (a) `select('indicator, checkpoint, score, not_applicable')` (línea 82) y tipo `{ score: number \| null; not_applicable: boolean }`. (b) `teamScoreMap` guarda `{ score, na }`. (c) `saveTeamScore`: el upsert **siempre** manda `score` y `not_applicable` (`{score: v, not_applicable: false}` o `{score: null, not_applicable: true}`); mandar siempre ambos evita que un upsert sobre una fila N/A deje `score` con `not_applicable=true` (violaría el CHECK). (d) Nueva mutación `clearTeamCell` (DELETE de la fila → vuelve a «pendiente»). (e) Celda: vacía = `<Input>` como hoy; con nota = `<Input>`; N/A = chip «N/A ✕» (clic → `clearTeamCell`); un botón pequeño «N/A» junto al input, **solo si `rubricAllowNa` y no `readOnly`**. (f) `ScoreValue` (solo lectura): `N/A` en gris itálico, distinto del guion de pendiente; se muestra aunque el flag esté apagado. (g) Con flag: columna «Prom.» por indicador («7,5 · 4 de 5») y línea global («Promedio general 7,2 · 21 de 30 con nota · 6 N/A · 3 pendientes»), calculados con `summarizeRubric`. Con flag apagado: tabla idéntica a la de hoy. (h) El modo individual (F1c) usa el mismo patrón sobre la tabla lateral; sin F1c, en modo individual no aparece el botón N/A. |
| `frontend/src/components/coach/MesocycleExportButton.tsx` | `RubricRow` (línea 121): `score: number \| null; not_applicable?: boolean`; `select(... , not_applicable)` (línea ~620); `drawRubric` (línea ~519): `v` = `'N/A'` si `not_applicable` (gris), nota si hay, `—` si no hay fila. Sin promedio en el PDF en esta fase. **Ojo con el orden de despliegue:** pedir la columna antes de que exista da error 400 → migración B primero (§9). |

### 5.3 BFF
| Archivo | Cambio |
|---|---|
| `bff/src/routes/school/coach-activity.ts` (líneas 178 y 331) | Agregar `.not('score', 'is', null)` a las dos consultas de `training_mesocycle_evaluations`: una celda N/A no cuenta como «evaluación hecha» (no infla la actividad ni la adherencia). Se filtra por `score`, no por `not_applicable`, **a propósito**: funciona antes y después de la migración (no hay dependencia de orden) y con el flag apagado el resultado es idéntico (hoy `score` es NOT NULL). Decisión de producto en el checklist (alternativa: que N/A sí cuente como actividad). |
| `bff/src/routes/me.routes.ts` | **Sin cambios** (`select('*')`). El objeto fail-closed de «escuela inexistente» no necesita el campo: ausente = `false`. |
| `bff/src/routes/school/coach-evaluation-summary.ts` | Sin cambios (no lee puntajes de rúbrica, solo cuenta actividad). |

### 5.4 No se toca
`docs/specs/evaluaciones-ampliadas-carmel.md` (modificado por otra sesión; el estado «aprobado» se anota después, en commit aparte), `types.ts` (ver §11), `routePermissions.ts`, `App.tsx` (la mejora de menú no necesita ruta nueva, §10).

---

## 6. Cómo se ve

### 6.1 Admin: diálogo «Calificar a …»
- Cada ítem: 5 botones 1–5 en palabras + debajo un chip ancho «No aplica» (gris, mismo alto, sin ícono de alarma). Comentario opcional sirve de motivo.
- Pie: `Promedio: 4,3 · 5 de 6 ítems · 1 no aplica`. Con todo en N/A: «Todo en “No aplica”: puedes guardarlo como borrador, no publicarlo».
- Con el flag apagado: **ni chip ni textos nuevos**; el diálogo es el de hoy.

### 6.2 `EvaluationHistory` y vista del coach
- Lista de períodos: igual que hoy; solo agrega « · 5 de 6 ítems» cuando hubo N/A. Barra de progreso con `overall_score` guardado (ya calculado sobre aplicables).
- Detalle: los N/A salen como chip gris «No aplica», sin nota ni color, y el comentario (si lo hay) debajo. El coach lo entiende como «este criterio no se evaluó este período», no como nota baja.
- Evaluaciones anteriores a la migración: idénticas (no tienen N/A, `not_applicable=false`).

### 6.3 Rúbrica del mesociclo
- Celda **vacía = pendiente**, **N/A = decidido** (chip gris), nota = número. Promedio por indicador y general solo con flag; excluye N/A y pendientes y dice cuántos («4 de 5 cortes»).
- El PDF muestra «N/A» donde corresponde.
- Actividad del coach (BFF): las celdas N/A no suman a «evaluaciones».

### 6.4 Casos de borde de UI
- Flag apagado después de haber usado N/A: el diálogo y la rúbrica **muestran** los N/A ya guardados (lectura no depende del flag). En el diálogo, un ítem N/A existente con flag apagado se trata como sin responder y se avisa («Esta evaluación tenía “No aplica” y la opción está apagada; elige una nota»); la RPC lo rechazaría de todos modos.
- Ítem desactivado a mitad de período con N/A: se conserva por `criterion_name` (igual que hoy con las notas).

---

## 7. Pruebas

### 7.1 Unitarias (vitest, `frontend/src/test/`, junto a `coachEvaluationPeriods.test.ts`)
- `coachEvaluationScoring.test.ts`: promedio con y sin N/A; **N/A fuera de numerador y denominador** (`[5,4,N/A,3,N/A,5]` → 4,25 sobre 4); todo N/A → `null`; un solo aplicable; ninguno respondido; `canPublish` falso con 0 aplicables; `naMajority` justo en el límite (3 de 6 no avisa, 4 de 6 sí); `buildScoresPayload` con flag apagado **sin clave** `not_applicable` (paridad con el payload de hoy) y con flag encendido `{score:null, not_applicable:true}`; formato «5 de 6 ítems»; redondeo a 2 decimales igual a `round(x,2)` de SQL (tabla de casos compartida con el script de base, para que el cliente y la RPC no diverjan).
- `mesocycleRubricMath.test.ts`: indicador con 5 cortes (3 notas, 1 N/A, 1 pendiente → «3 de 5», pendiente aparte); global de 30 celdas; vacío total → `null`; N/A no es 0.
- `EvaluationHistory.test.tsx` (testing-library, como `usePublicLive.test.tsx`): chip «No aplica», sufijo «n de m» solo con N/A, `overall_score = null`.
- `MesocycleRubricTable`: con flag apagado no hay botón N/A ni columna «Prom.»; con flag, el botón guarda `{score:null, not_applicable:true}` y el upsert sobre una celda N/A con nota manda `not_applicable:false`.

### 7.2 Base (simulación de sesión) — `supabase/verificaciones/evaluaciones-na-f1.sql`
Todo dentro de `BEGIN; … ROLLBACK;` con `set_config('request.jwt.claims', json_build_object('sub','<uuid>')::text, true)` y `SET LOCAL ROLE authenticated`. Como escribe (aunque se revierte) **no corre con `--read-only`**: lo ejecuta el usuario en el SQL Editor o con la confirmación de la CLI. Se corre **antes** de desplegar el frontend.
1. Admin de Carmel + flag: guardar con 1 N/A → fila con `score NULL, not_applicable true`; `overall_score` = promedio de aplicables.
2. Escuela sin flag + N/A → `42501`. Sin N/A → mismo resultado que antes (comparar `overall_score` y filas contra una corrida con la versión previa).
3. Publicar con 0 aplicables → `22023`; borrador con 0 aplicables → ok, `overall_score IS NULL`.
4. Nota con `not_applicable=true` → `22023` por la RPC y `23514` por INSERT directo (CHECK). Nota 0 y 6, o NULL sin N/A → `22023`. Ítem duplicado → `22023` (se conserva).
5. **Aviso conservado:** publicar con staff con cuenta → 1 fila nueva en `notifications` con link `/mis-evaluaciones` (y «n de m» si hubo N/A); volver a publicar → 0 filas nuevas; staff sin cuenta → 0.
6. **Gate:** coach (no admin) → `42501`; admin de otra escuela → `42501`; `has_function_privilege('anon', 'public.save_coach_evaluation(…)', 'EXECUTE')` = `false`.
7. **RLS del coach** (policies intactas): ve su evaluación publicada con N/A; **no** ve el borrador; `anon` = 0 filas.
8. **Backfill:** `count(*) FROM coach_evaluation_scores WHERE not_applicable` = 0 al aplicar; las 2 evaluaciones existentes conservan `overall_score` (comparar antes/después).
9. **Mesociclo:** INSERT N/A sin flag → `42501` (trigger); con flag → ok; UPDATE de N/A a nota (`not_applicable=false`) → ok; nota + `not_applicable=true` → `23514`; el `UNIQUE` sigue vigente; el upsert por `onConflict` funciona.
10. **Vista:** 42 columnas, las 41 anteriores en el **mismo orden**; `rubric_allow_na = true` solo para Carmel, `false` para el resto.
11. `npm run seguridad:invariantes` sin críticas, y `select policyname, cmd, roles, qual, with_check from pg_policies where tablename in ('coach_evaluations','coach_evaluation_scores','training_mesocycle_evaluations','school_settings')` **sin policies nuevas** (las permisivas se suman con OR).
12. BFF: con una celda N/A del mesociclo, el conteo de `coach-activity` no la cuenta (consulta puntual contra la base; no hay prueba unitaria porque el filtro vive en la ruta, no en `coach-activity.aggregate.ts`).

### 7.3 Compilación
`npm run build` del frontend y `tsc` del BFF; `npm run migrations:check` (gate de pre-commit) y `npm run validar:estructura` si aplica al repo de pruebas, no a este.

---

## 8. Radio (qué pasa con las otras escuelas)

- **Datos:** `coach_evaluations` tiene 2 filas en toda la base y ninguna de Carmel; `training_mesocycle_evaluations` 142 filas (todas quedan `not_applicable=false`, válidas por el CHECK); `performance_entries` no se toca. Sin backfill.
- **RPC:** payload sin N/A = comportamiento idéntico (mismo gate, mismas validaciones, mismo aviso, `overall_score` idéntico), y sin lecturas nuevas de `school_settings`.
- **Frontend:** `rubricAllowNa = false` fuera de Carmel → ningún chip, ningún texto nuevo, ninguna columna «Prom.».
- **BFF:** `.not('score','is',null)` no cambia ningún resultado hoy (`score` es NOT NULL hasta que exista el primer N/A).
- **Vista y PostgREST:** una columna al final; las demás no se mueven; `NOTIFY pgrst` recarga el esquema una vez por migración (por eso son 2, aplicadas seguidas por una sola sesión, sin `gen types` entre medias).
- **Disk IO:** DDL liviano sobre tablas chicas, sin jobs, sin N+1, sin sondeos de catálogo.
- **Único cambio visible para todas las escuelas:** el acceso directo del menú (§10, mejora #2), pedido explícitamente.

---

## 9. Orden de ejecución y despliegue

1. **Pre-vuelo:** `git status --short` (§11); confirmar **una sola sesión** aplicando migraciones; releer el hash vivo de `save_coach_evaluation` (`aafb5c90…`) y la definición viva de la vista.
2. `npm run migrations:new -- rubrica-na-entrenadores` y `… -- rubrica-na-mesociclo` (reservan versión posterior al head y tocan el ledger, ver §11). Escribir SQL, revisarlo línea por línea.
3. Aplicar A y luego B con rastro. Correr `evaluaciones-na-f1.sql` y `seguridad:invariantes`. **`types.ts` no se regenera** en esta fase.
4. Código: `scoring.ts`, `mesocycleRubricMath.ts`, `api.ts`, diálogo, historial, tabla, PDF, `useEntitlements.ts`, BFF; pruebas unitarias; build.
5. Commit selectivo (§11) en `develop` (solo `develop`; nunca a `main` por iniciativa propia).
6. Despliegue en este orden: **BFF primero** (Render no tiene autodeploy desde que el repo pasó a SportMaps-SAS: revisar el deploy a mano), **frontend después** (Vercel: un solo push agrupado, cada push gasta 4 despliegues del cupo). Con el flag de Carmel ya en `true` desde la migración, el chip aparece cuando sale el frontend; el BFF ya excluye N/A de la actividad.
7. Humo en vivo con quien el usuario indique (QA con sesión de cliente real pide su OK): N/A en una evaluación borrador de un coach de Carmel; publicar; ver «n de m».
8. F1c (individual) solo si el usuario lo aprueba, en migración y commit aparte.

---

## 10. Las 2 mejoras UX baratas del diagnóstico

**#1 — Toast de `CoachEvaluationDialog.tsx` (~L127–129):** hoy dice «`<nombre>` ya puede verla» aunque el entrenador no tenga cuenta (la RPC solo avisa a staff con `coach_auth_id`, y sin cuenta no hay quién entre a `/mis-evaluaciones`). Cambio:
- Publicar con cuenta: «Publicada. `<nombre>` la verá en “Mis evaluaciones” y le llegó un aviso.» (solo la **primera** publicación avisa; si `existing?.status === 'publicada'`, título «Evaluación actualizada» y sin prometer aviso).
- Publicar sin cuenta (`!target.hasAccount`): «Publicada. `<nombre>` todavía no entra a SportMaps: la verá cuando ingrese.»
- Borrador: igual que hoy.
Solo texto; sin cambios de datos.

**#2 — Acceso directo desde el menú admin:** hoy calificar exige «Seguimiento deportivo» → abrir la ficha de un entrenador → pestaña «Calificación» → botón. Propuesta: en `frontend/src/config/navigation.ts`, en `GESTION_DEPORTIVA_ESCUELA` (constante compartida por `school` y `school_admin`, junto a «Seguimiento deportivo», ~L177), agregar `{ title: 'Calificar entrenadores', href: '/seguimiento-deportivo?calificar=1', icon: Award }`. En `CoachActivityPage.tsx` leer `?calificar=1` (`useSearchParams`), mostrar una línea «Elige un entrenador para calificarlo» y abrir la ficha en la pestaña «Calificación» (`CoachDetailSheet.tsx` L110: `defaultValue` pasa de fijo `"sesiones"` a una prop). **Sin ruta nueva**: `App.tsx` y `routePermissions.ts` no se tocan (la ruta `/seguimiento-deportivo` ya existe con sus roles). **Verificar al implementar** que el resaltado del ítem activo del menú funciona con query string; si no, plan B: alias de ruta `/calificar-entrenadores` (ahí sí tocaría `App.tsx` + `routePermissions.ts`, con los cuidados del §11). La ruta de «Mis evaluaciones» del coach ya está en sus dos árboles de menú (`navigation.ts:518`, `coachMasModel.ts:66`), no hay nada que arreglar ahí.

---

## 11. Conflictos con archivos ajenos sin commitear — cómo no pisarlos

Hay varias sesiones en `develop`. Reglas (memoria del proyecto: commit solo lo propio, índice temporal, `--only` arrastra imports sin trackear, `stash pop` deja todo staged, repo en CRLF):

| Archivo | Estado hoy | Qué hacer |
|---|---|---|
| `frontend/src/App.tsx` | limpio | **No se toca** en este plan (plan B del menú lo tocaría: re-verificar antes). |
| `frontend/src/config/navigation.ts` | limpio | Se toca (menú). Antes de editar: `git status --short -- <archivo>` y `git diff --stat`; si apareció con cambios ajenos, editar con `Edit` (parche puntual) y commitear **solo mi hunk**. |
| `frontend/src/config/routePermissions.ts` | limpio | No se toca (salvo plan B). |
| `frontend/src/hooks/useEntitlements.ts` | limpio | Se toca (4 inserciones pequeñas). Misma verificación previa. |
| `frontend/src/integrations/supabase/types.ts` | limpio | **No se regenera ni se edita** en F1: el código usa `supabase as any`. Se regenera una sola vez al final del lote, en commit aparte, y solo cuando ninguna otra sesión lo esté tocando. |
| `supabase/migrations_ledger.json` | **modificado por otra sesión** (hay 4 migraciones `20261105…` sin trackear) | `migrations:new` agrega mis entradas **encima de las suyas**; **no** revertir ni reordenar las de ellos. Commitear el ledger solo con mis entradas: (a) esperar a que esa sesión suba el suyo, o (b) `git diff supabase/migrations_ledger.json`, dejar solo mis hunks en un parche y `git apply --cached`. Nunca `git add` del archivo completo mientras tenga entradas ajenas. |
| `docs/specs/evaluaciones-ampliadas-carmel.md` | modificado por otra sesión | No se edita en este plan. |
| `bff/src/index.ts`, `authMiddleware.ts`, rutas de reservas, `ApprovePaymentMethodSheet.tsx`, `reservasApi.ts`, `approvePayment.ts`, `PaymentsAutomationPage.tsx` | modificados por otras sesiones | No se tocan. |

Procedimiento de commit: índice temporal (`GIT_INDEX_FILE` apuntando a una copia de `HEAD`), `git add` **solo** de mis archivos por ruta (los nuevos: `scoring.ts`, `mesocycleRubricMath.ts`, las dos migraciones, `supabase/verificaciones/evaluaciones-na-f1.sql`, las pruebas), y verificar con `git diff --cached --stat` que no entró nada ajeno **ni imports a archivos sin trackear** (lección del 10-06: Render roto 11 h). Sin `stash`. CRLF: normalizar `\r\n` antes de parches multilínea. Mensaje con la línea de coautoría de Claude.

---

## 12. Reversa

- **Inmediata, sin deploy:** `UPDATE school_settings SET rubric_allow_na = false WHERE school_id = '374a6716-…'` (por una vía con rastro). Deja de poder escribir N/A (RPC y trigger responden `42501`) y la UI esconde chip, «n de m» y promedios. Lo ya guardado se sigue **leyendo** bien.
- **Código:** revertir el commit del frontend/BFF. Ojo: el código viejo no sabe pintar `score = null`; si ya existen N/A, **primero** apagar el flag y revertir solo cuando se haya decidido qué hacer con esas filas.
- **Base (nueva migración posterior, nunca editar las aplicadas):** (1) restaurar `save_coach_evaluation` al cuerpo de `20261029191217`; (2) para cada evaluación con N/A: borrar sus filas N/A y recalcular `overall_score` (**se pierde la marca N/A**, por eso solo si de verdad se abandona la función); (3) `ALTER COLUMN score SET NOT NULL` y volver el CHECK a `1..5` / `1..10`; (4) `DROP COLUMN not_applicable`; (5) `DROP TRIGGER` + `DROP FUNCTION _guard_mesocycle_eval_na`. La columna `rubric_allow_na` de la vista **no se quita** (quitar una columna de la vista exige `DROP VIEW` y recrearla): queda inofensiva en `false`.
- F1c es independiente: `DROP` de la tabla lateral y la RPC no toca nada más.

---

## 13. Checklist de aprobación

- [ ] **Modelo:** `not_applicable boolean` + `score` nullable + CHECK (en vez de solo `score NULL`), en las dos tablas.
- [ ] **Promedio de la rúbrica del mesociclo:** solo de visualización en el frontend (no se guarda en base); la evaluación de entrenadores sigue calculándose en la RPC.
- [ ] **Carmel encendido** en la propia migración A (opción A, patrón de las migraciones anteriores) **o** como paso aparte cuando lo pidas (opción B).
- [ ] **Actividad del coach (BFF):** las celdas N/A del mesociclo **no** cuentan como evaluaciones hechas (recomendado) **o** sí cuentan.
- [ ] **Modo individual del mesociclo (F1c):** postergado y opcional (9 registros reales) **o** incluido ahora con tabla lateral.
- [ ] **Dos migraciones** (A: flag+vista+entrenadores, B: mesociclo) aplicadas seguidas por **una sola sesión**, sin regenerar `types.ts`.
- [ ] **Mejora UX #1** (texto del toast) y **#2** (ítem «Calificar entrenadores» en el menú de escuela/admin; visible para todas las escuelas, no solo Carmel).
- [ ] **Orden de despliegue:** BFF primero (revisión manual en Render), frontend después, un solo push agrupado a `develop`.
- [ ] **Commit selectivo** con índice temporal; el ledger se sube solo con mis entradas.
- [ ] El script `evaluaciones-na-f1.sql` lo corre el usuario (escribe dentro de `ROLLBACK`; no admite `--read-only`).
- [ ] El humo en vivo con un coach/escuela real de Carmel lo autoriza el usuario.
