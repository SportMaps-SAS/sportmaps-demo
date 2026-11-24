# Spec — Módulo de Nutrición para atletas independientes (registro de comida + calorías/macros)

**Estado:** propuesta, sin código — modelo de datos y fases de entrega cerrados; falta decisión de producto sobre proveedor de datos de alimentos y sobre monetización
**Origen:** el atleta pidió poder llevar, además del progreso de carga (peso×reps por ejercicio, ya cubierto por `session_exercise_results` + `StatsPage`), un registro de comida con calorías/fibra/carbohidratos/proteína — hoy no existe nada funcional para esto (`NutritionPage.tsx` es un cascarón mock, ver `project_frontend_tables_audit` y el propio `docs/ROADMAP.md` que lo marca como bug DIN-4: activar el addon "no cambia nada visible")
**Roles cubiertos:** `athlete` **sin** afiliación a ninguna escuela (`profiles.role='athlete'` sin fila en `school_members`) — ver §0 decisión 1 sobre por qué el diseño termina sirviendo a cualquier atleta, tenga o no escuela detrás
**Relacionado:** [[project_performance_metrics_model]] (por qué esto NO se modela como `sport_metric_definitions`/`performance_entries`), [[project_math_audit_census]] (once divergencias de cálculo ya encontradas — no repetir el patrón de calcular en el navegador), `docs/specs/profesionales-independientes-agentes-ia.md` (precedente de "cuenta sin escuela real", descartado acá — ver §0 decisión 2), [[project_saas_roadmap]] (billing individual, hoy inexistente)

> **Nota 2026-11-20.** Nutrición quedó **fuera de alcance** del track `BOD`
> ([body-biblioteca-tecnicas-y-rendimiento.md](body-biblioteca-tecnicas-y-rendimiento.md)) hasta cerrar `BOD-5`.
> Idea anotada para cuando entre, tomada de la revisión de Calor.IA: registrar la comida por **foto con
> corrección por texto** («eran 2, no 3»), montada sobre este mismo modelo y con el patrón «la IA solo extrae, una
> persona confirma» que ya usan los servicios de OCR. Este spec no contempla foto hoy.

---

## 0. Decisiones cerradas

| # | Decisión | Resuelto así | Por qué |
|---|---|---|---|
| 1 | **Tenancy / a quién pertenece el dato** | Tablas nuevas con `owner_profile_id uuid not null references profiles(id)`, **sin `school_id`**. Ninguna condición de "¿tiene escuela o no?" en el schema. | Ya existe el precedente exacto en el propio schema base: `training_logs` y `athlete_stats` son propiedad de `athlete_id` sin `school_id`, con RLS simple `athlete_id = auth.uid()`. Copiar ese patrón evita inventar un concepto de "atleta independiente" que no existe hoy como estado explícito — un atleta con o sin escuela usa la misma tabla, la pertenencia a escuela es irrelevante para su propio registro de comida. |
| 2 | **No se modela como "escuela de un solo atleta"** | Se descarta el patrón que usó el spec de profesionales independientes (`schools.school_type='professional'`). | Ese patrón resuelve el problema de *facturarle a los clientes de un profesional* reutilizando `school_subscriptions`/`school_addons`. Acá no hay clientes ni facturación a terceros — es un atleta llevando su propio dato. Forzarlo a ser una "escuela" para heredar billing sería inventar tenancy falsa para un caso que no la necesita (mismo tipo de sobre-ingeniería que la auditoría de seguridad ya marcó como riesgo cuando se duplican helpers de RLS sin necesidad). |
| 3 | **No usa `sport_metric_definitions` / `performance_entries`** | Catálogo y tablas propias (`food_items`, `nutrition_logs`, `nutrition_goals`). | Ese modelo está pensado para métricas de **rendimiento deportivo** evaluadas por un coach/escuela (`context_type in ('manual','competition','evaluation','session')`, con `sport_metric_thresholds` por deporte). Nutrición es autorregistro diario del propio atleta, cardinalidad y forma de consulta totalmente distintas (series de tiempo por comida/día, no una medición puntual por sesión). Meterlo ahí sería forzar un modelo que no calza, igual que ya pasó al confundir `school_has_branding_feature()` con `school_shows_own_brand()`. |
| 4 | **Página nueva, no reusar `NutritionPage.tsx`** | Se crea una ruta nueva orientada al atleta (ej. `/mi-nutricion`). `NutritionPage.tsx` (gateada a `wellness_professional/admin/school`) queda intacta. | `NutritionPage.tsx` es una consola de gestión (un profesional armando planes para clientes) — otro producto, con otro dueño de dato. Mezclar ambos en la misma pantalla obligaría a resolver permisos cruzados que no vienen al caso para un MVP de autorregistro. Si en el futuro se quiere que un `wellness_professional` vea el registro de un atleta que lo autoriza, es una fase posterior explícita (§2, Fase 3), no parte de este alcance. |
| 5 | **Catálogo de alimentos: API externa + caché local, no catálogo propio de cero** | `food_items` se llena por búsqueda contra una API externa de alimentos (candidata: Open Food Facts — gratis, sin costo por request, buena cobertura de productos empacados LATAM vía código de barras/nombre) y se cachea localmente lo que el atleta efectivamente usa. | Mantener una base de datos nutricional propia desde cero (miles de alimentos con macros verificados) es un proyecto en sí mismo, fuera de alcance de un MVP. Cachear por uso real evita pagar/consultar la API para lo mismo dos veces y deja la puerta abierta a cambiar de proveedor sin migrar datos ya guardados (el registro histórico del atleta no depende de que la API siga viva). **Queda abierta la decisión comercial de qué proveedor usar en producción — ver §4, D1 🔴.** |
| 6 | **Metas de macros: fórmula sugerida + override manual, nunca solo automático** | Se calcula una sugerencia (Mifflin-St Jeor + factor de actividad) si el atleta tiene peso y datos básicos cargados, pero el atleta siempre puede fijar sus propias metas a mano. | Sin fecha de nacimiento/sexo/altura confiables para todos los perfiles hoy, una meta 100% automática puede quedar mal calculada silenciosamente — mismo tipo de riesgo que ya costó caro en el censo de cálculos monetarios (`project_math_audit_census`): mostrar un número "calculado" sin dejar ver ni corregir la base del cálculo. |
| 7 | **Cálculo de macros totales, siempre en el servidor** | La suma diaria/semanal de calorías/proteína/carbos/fibra se calcula en una vista o RPC de Postgres, nunca en el navegador a partir de los `nutrition_logs` crudos. | Regla ya aprendida en el propio repo: "el navegador infla" (`project_math_audit_census`) — evitar que dos pantallas (hoy vs. progreso semanal) sumen distinto por redondeos o por no traer el mismo set de filas. |

---

## 1. Modelo de datos

### 1.1 Catálogo de alimentos (compartido entre todos los atletas, no por dueño)

```sql
-- Alimentos ya buscados/usados al menos una vez. No es un catálogo curado a mano.
create table food_items (
  id                uuid primary key default gen_random_uuid(),
  external_source   text not null check (external_source in ('openfoodfacts','manual','usda')), -- ver D1
  external_id       text,                              -- id/barcode en la fuente externa, null si es 'manual'
  name              text not null,
  brand             text,
  serving_size_g    numeric,                           -- gramos de la porción de referencia
  serving_label     text,                               -- "1 taza", "1 unidad", texto libre para mostrar
  calories_kcal     numeric not null,                   -- por serving_size_g
  protein_g         numeric not null default 0,
  carbs_g           numeric not null default 0,
  fat_g             numeric not null default 0,
  fiber_g           numeric not null default 0,
  sugar_g           numeric,
  sodium_mg         numeric,
  verified          boolean not null default false,     -- true si viene de fuente oficial, false si autocompletado/manual
  created_by        uuid references public.profiles(id), -- quién lo dio de alta si es 'manual' (receta propia del atleta)
  created_at        timestamptz not null default now(),
  unique (external_source, external_id)
);
-- RLS: lectura para cualquier authenticated (catálogo compartido). Escritura solo vía función de "buscar o crear"
-- (ver 1.4) para no dejar que cualquiera inserte filas sueltas con datos inventados.
```

### 1.2 Registro diario del atleta

```sql
create table nutrition_logs (
  id                uuid primary key default gen_random_uuid(),
  owner_profile_id  uuid not null references public.profiles(id),
  food_item_id      uuid not null references food_items(id),
  logged_at         date not null default current_date,      -- día del registro (no timestamp; el detalle de hora es meal_type)
  meal_type         text not null check (meal_type in ('desayuno','almuerzo','cena','snack')),
  quantity          numeric not null default 1,               -- múltiplo de serving_size_g del food_item
  -- valores calculados y CONGELADOS al momento de registrar (quantity * food_items.*_por_serving),
  -- para que si el food_item se corrige después no se reescriba silenciosamente el histórico del atleta
  calories_kcal     numeric not null,
  protein_g         numeric not null,
  carbs_g           numeric not null,
  fat_g             numeric not null,
  fiber_g           numeric not null,
  notes             text,
  created_at        timestamptz not null default now()
);
create index on nutrition_logs (owner_profile_id, logged_at);
```

```sql
-- RLS: mismo patrón que training_logs — el dueño lee/escribe lo suyo, nada más.
alter table nutrition_logs enable row level security;

create policy nutrition_logs_select on nutrition_logs
  for select using (owner_profile_id = (select auth.uid()));

create policy nutrition_logs_write on nutrition_logs
  for all using (owner_profile_id = (select auth.uid()))
  with check (owner_profile_id = (select auth.uid()));
  -- FOR ALL con WITH CHECK explícito — invariante I3 (CLAUDE.md), no confiar en que
  -- el USING alcance para validar el INSERT.
```

### 1.3 Metas del atleta

```sql
create table nutrition_goals (
  owner_profile_id  uuid primary key references public.profiles(id),
  calories_kcal     numeric not null,
  protein_g         numeric not null,
  carbs_g           numeric not null,
  fat_g             numeric not null,
  fiber_g           numeric not null,
  source            text not null default 'manual' check (source in ('manual','sugerido')), -- 'sugerido' = vino de la fórmula, el atleta no lo tocó
  updated_at        timestamptz not null default now()
);
-- RLS igual que nutrition_logs: owner_profile_id = (select auth.uid())
```

### 1.4 Función de "buscar o crear" alimento (única vía de escritura a `food_items` desde el cliente)

```sql
-- SECURITY DEFINER: valida forma de los datos (calorías/macros no negativos, nombre no vacío)
-- antes de insertar, así el catálogo compartido no se llena de basura.
-- SET search_path = pg_catalog, public, pg_temp  -- obligatorio (CLAUDE.md, invariante I4)
create or replace function find_or_create_food_item(
  p_external_source text,
  p_external_id text,
  p_name text,
  p_serving_size_g numeric,
  p_serving_label text,
  p_calories_kcal numeric,
  p_protein_g numeric,
  p_carbs_g numeric,
  p_fat_g numeric,
  p_fiber_g numeric
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  -- upsert por (external_source, external_id) si viene de API; si es 'manual', siempre inserta nuevo
  -- (una receta propia del atleta no se deduplica contra la de otro atleta)
$$;

grant execute on function find_or_create_food_item to authenticated;
-- GRANT explícito — SECURITY DEFINER no exime de esto (invariante I2/nota de CLAUDE.md sobre GRANT EXECUTE).
```

### 1.5 Vista de totales diarios (cálculo en servidor, invariante §0.7)

```sql
create view v_nutrition_daily_totals as
select
  owner_profile_id,
  logged_at,
  sum(calories_kcal) as calories_kcal,
  sum(protein_g)      as protein_g,
  sum(carbs_g)        as carbs_g,
  sum(fat_g)          as fat_g,
  sum(fiber_g)         as fiber_g
from nutrition_logs
group by owner_profile_id, logged_at;
-- security_invoker=true (no security definer): hereda RLS de nutrition_logs directo,
-- sin necesidad de política propia. Ojo con el gotcha ya documentado de vistas
-- security_invoker con subquery reactivando RLS por fila (project_rls_view_perf_lateral) —
-- este agregado es simple (sum+group by), no debería toparse con ese caso, pero medir con EXPLAIN
-- antes de darlo por bueno si la tabla crece mucho.
```

---

## 2. Flujo funcional y pantallas

### Fase 1 — Registro manual + totales del día (MVP)

1. Atleta entra a `/mi-nutricion` (ruta nueva, rol `athlete`, sin depender de escuela).
2. Ve el día actual: barra de progreso de calorías/proteína/carbos/fibra vs. `nutrition_goals` (si no tiene metas fijadas, ve la sugerencia calculada y un botón "usar esta meta" / "definir la mía").
3. Botón "Agregar comida" → busca alimento por nombre (llama a la API externa en vivo, `find_or_create_food_item` cachea el resultado elegido) → elige porción/cantidad → elige tipo de comida (desayuno/almuerzo/cena/snack) → guarda como `nutrition_logs`.
4. Si no encuentra el alimento, opción "Crear alimento propio" (receta casera): formulario manual de calorías/macros por porción, queda con `external_source='manual'`, `verified=false`.
5. Lista del día editable/borrable (solo lo del propio día, sin límite de tiempo para editar — a diferencia de la ventana de 24h del post-entreno, acá no hay otra parte esperando el dato).

### Fase 2 — Progreso en el tiempo

6. Vista semanal/mensual: promedio de calorías/macros por día, comparado contra la meta — mismo patrón visual que `StatsPage.tsx` (Recharts, gráfica de línea/barra por día).
7. Alertas simples de tendencia (ej. "llevas 4 días bajo tu meta de proteína") — cálculo en el mismo RPC/vista de §1.5, no en el cliente.

### Fase 3 — Integraciones (fuera del MVP, quedan como siguiente iteración)

8. Balance calórico del día: cruzar `v_nutrition_daily_totals.calories_kcal` (consumidas) contra `training_logs.calories_burned` / `session_exercise_results` (quemadas) del mismo `owner_profile_id` y `logged_at` — ya existen ambos lados del dato, solo falta la vista que los une.
9. Si el atleta pertenece a una escuela y su `wellness_professional`/coach tiene el addon activo, ver su registro con consentimiento explícito del atleta (mismo patrón de consentimiento ya usado en Club Carmel para informes — nunca por defecto).
10. Escaneo de código de barras (cámara) contra la misma API externa de §1.1 — mejora de UX sobre la búsqueda por texto, no cambia el modelo de datos.

---

## 3. Fases de entrega

| Fase | Alcance | Depende de |
|---|---|---|
| F0 | Migraciones de §1 (`food_items`, `nutrition_logs`, `nutrition_goals`, `find_or_create_food_item`, `v_nutrition_daily_totals`) + RLS | Decisión D1 (§4) sobre proveedor de API, aunque sea provisional para desarrollo |
| F1 | Pantalla `/mi-nutricion`: registro del día + búsqueda de alimento + alimento manual + metas (sugerida/manual) | F0 |
| F2 | Vista de progreso semanal/mensual con gráfica | F1 |
| F3 | Balance calórico (consumo vs. gasto) cruzando `training_logs` | F2, y confirmar qué tabla de gasto calórico es la vigente (`training_logs.calories_burned` vs. cualquier cálculo de `calorieUtils.ts`, que hoy es solo del track PT/coach) |
| F4 | Compartir con `wellness_professional`/coach con consentimiento | F2, y el modelo de consentimiento (§4, D3) |
| F5 | Escaneo de código de barras | F1 |

---

## 4. Decisiones de producto pendientes

| # | Decisión | Por qué bloquea | Estado |
|---|---|---|---|
| D1 | **Proveedor de datos de alimentos en producción** — Open Food Facts es gratis pero la cobertura de comida colombiana/casera (no empacada) es floja; alternativas pagas (Nutritionix, Edamam, USDA FoodData Central) tienen mejor cobertura de comida preparada/genérica pero cuota o costo por request. | Sin esto no se puede fijar el costo variable del módulo ni saber si hace falta un fallback (ej. permitir que el atleta cree su alimento manual como default para comida casera desde el día uno, no como excepción). | 🔴 abierta |
| D2 | **¿Es addon pago o viene incluido gratis para todo atleta?** Hoy no existe ningún riel de cobro a un atleta individual (todo el billing real es por `school_id`; `profiles.subscription_tier` existe en el schema pero no está conectado a ningún webhook de pago, ver `project_saas_billing_no_negotiated_price` y el hallazgo de esta investigación). El addon `nutrition` de `school_addons` tampoco sirve acá porque exige `school_id`. | Si se decide monetizarlo, hay que construir primero un riel de suscripción personal (fuera de alcance de este spec) — eso es un proyecto de billing individual aparte, no una decisión de schema de nutrición. | 🔴 abierta — recomendado: **F1-F2 gratis para validar con el piloto real (el atleta que lo pidió), decisión de monetización se toma con datos de uso, no antes** |
| D3 | **Consentimiento para compartir con un profesional (Fase 3, punto 9)** | Es dato de salud/hábito personal — mismo estándar que ya se exigió para informes de coach (Club Carmel) y para `clinical_doc` en el spec de profesionales independientes: consentimiento explícito, nunca retroactivo, nunca por defecto. | Se decide al llegar a F4, no bloquea F0-F2 |
| D4 | **¿Qué pasa si el atleta después se une a una escuela?** Como las tablas no llevan `school_id` (§0.1), el historial no se pierde ni cambia de dueño — pero hay que decidir si un coach de esa escuela debería poder verlo (mismo tema que D3) o si queda siempre privado salvo consentimiento explícito. | No bloquea el MVP — el dato ya queda bien parado por diseño, es solo una decisión de visibilidad futura | Se decide junto con D3 |

---

## 5. Riesgos

- **R1 — Calidad de los macros de fuentes gratuitas.** Un alimento mal cargado en Open Food Facts (calorías erróneas por porción) contamina el histórico de cualquier atleta que lo use después, porque `nutrition_logs` congela el valor al momento de registrar (§1.2) pero lo copia del `food_items` vigente en ese momento. Mitigación: marcar `verified=false` para todo lo que no venga de una fuente oficial y mostrarlo distinto en la UI (ej. ícono de "dato no verificado"), sin bloquear su uso.
- **R2 — Doble carátula del mismo alimento.** Sin normalización de nombres, "arroz blanco" y "Arroz Blanco Cocido" pueden terminar como dos filas distintas en `food_items`, fragmentando el catálogo compartido. No es bloqueante (cada atleta ve solo lo que registra), pero afecta la calidad del catálogo a largo plazo. Mitigación mínima para v1: normalizar a minúsculas + trim antes del `unique` lookup; una limpieza más fina (fuzzy matching) queda fuera de alcance.
- **R3 — Costo variable si se elige un proveedor pago (D1).** Sin límite de requests por atleta/día, un uso intensivo (buscar el mismo alimento muchas veces sin encontrar el correcto) puede generar costo no presupuestado. Mitigación: cachear agresivamente en `food_items` (§0.5) y, si se usa API paga, fijar un límite razonable de búsquedas/día por perfil desde el día uno.
- **R4 — Confusión con el `NutritionPage.tsx` existente.** Como ya existe una ruta `/nutrition` (gestión, para `wellness_professional`), hay que asegurarse en el router y en la navegación de que la ruta nueva del atleta (`/mi-nutricion`) no se confunda ni en código ni en comunicación a usuarios con la consola de gestión existente, que sigue siendo un cascarón sin construir y es un proyecto aparte.

---

## 6. Fuera de alcance (v1)

- Reconstruir `NutritionPage.tsx` (la consola de gestión para `wellness_professional`) — es un proyecto propio, no parte de este.
- Planes de comida prescritos por un profesional (eso sí es responsabilidad de `NutritionPage.tsx`/su propio spec futuro).
- Escaneo de código de barras (Fase 3/F5, no MVP).
- Cualquier billing individual nuevo — si D2 termina en "es addon pago", el riel de cobro personal es un spec aparte.
- Recomendaciones automáticas de dieta o ajuste de macros por IA — esto es autorregistro, no un coach nutricional.
- Vincular a `children`/`unregistered_athletes` (menores gestionados por una escuela) — el alcance es el `profile` adulto autónomo; si se quiere nutrición para un menor, es una extensión posterior con su propio análisis de quién tiene permiso de registrar por él.
