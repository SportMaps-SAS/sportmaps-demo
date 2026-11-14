# Partidos — registro, convocados y evaluación de rendimiento por jugador

> **Estado: spec aprobado en sus decisiones de producto (2026-09-23). No se escribe
> código de migraciones hasta aprobar el plan de la Fase 1** (convención del repo:
> *plan antes de código en migraciones*).
>
> **Origen:** CLUB DEPORTIVO BESSER, 2026-09-23. El coach preguntó: «dentro de las
> sesiones solo está la opción de generar clase; ¿cómo registramos el día del partido
> y evaluamos el rendimiento del partido? En el mesociclo hay una opción que dice
> partido, uno la selecciona pero no deja editar nada». Y el usuario añadió la
> pregunta que ordena todo el diseño: **«si no se requiere mesociclo y solo partido,
> ¿dónde se hace eso? No siempre todo debe ir por mesociclo»**.
>
> **Decisiones cerradas con el usuario el 2026-09-23:** (1) el partido es un solo
> registro con varias puertas de entrada y el mesociclo es opcional; (2) los
> criterios de evaluación los define el **admin** de la escuela y los coaches los
> usan; (3) partidos y evaluación son **genéricos para todos los deportes**; lo
> específico de fútbol (goles, tarjetas, pizarra) se queda en el módulo Fútbol.

---

## 0. El problema, en una línea

Hoy un partido se puede **agendar** en el Calendario, **registrar** en Resultados o
en Fútbol → Partidos de Club, y **planificar** como día «partido» del mesociclo, y
**ninguna de las cuatro puertas se habla con las otras**. Y en ninguna se puede
evaluar a cada jugador después del partido.

---

## 1. Qué existe HOY (verificado en la base viva y en el repo, 2026-09-23)

| Pieza | Dónde | Qué hace | Qué le falta |
|---|---|---|---|
| **Calendario** · evento tipo `match` | `CalendarPage.tsx` (`calendar_events`, ya con `team_id`/`school_id` desde la migración `20260923113401`) | Agenda el partido; las familias del equipo lo ven | No crea ningún registro del partido; no muestra marcador |
| **Resultados** (`/results`) | `ResultsPage.tsx` → `match_results` (23 filas vivas) | Rival, fecha, local/visitante, marcador, tipo | Sin escuela en la tabla (solo `team_id`), sin estado (programado/jugado), sin convocados, sin evaluación; inserta directo desde el cliente |
| **Fútbol → Partidos de Club** | `FootballDashboardModal.tsx`, `useFootballData.ts`, BFF `school/football.ts` | Crea `match_results` + alineación (`match_lineups`, `match_lineup_players` con `minutes_played`) + goles/tarjetas (`football_match_events`) | Solo fútbol; el marcador no se puede editar después de crear; sin evaluación por jugador |
| **Mesociclo** · día `partido` | `MesocycleSection.tsx` → `training_microcycle_days` (5 días `partido` vivos) | Etiqueta el día y alimenta el índice MD | El único botón es «Crear sesión» (formulario de entrenamiento). `tournament_match_id` existe y nadie lo usa. El día no se puede editar ni borrar. Título del diálogo dice «Editar» al crear |
| **Métricas de rendimiento** | `performance_entries` (683 filas; `context_type` admite `'competition'` + `context_id`, **0 filas** lo usan) · catálogo `sport_metric_definitions` (122 métricas, 7 deportes, clave `sport_category_id`, sin `school_id`) · BFF `school/performance.ts` | Evaluar atletas en entrenamiento/evaluación | Nada por partido; criterios **no configurables por escuela** (solo `is_active` global) |
| **Rúbrica del mesociclo** | `MesocycleRubricTable.tsx` + `training_mesocycle_evaluations` | 6 indicadores × 5 checkpoints | Indicadores fijos en código **y** en CHECK de la tabla |
| **Torneos internos** | `tournament_matches`, `tournament_match_events` | Fixture de torneos que organiza SportMaps | Mundo aparte; se enlaza, no se fusiona (D12) |
| **`competition_results`** | tabla genérica «resultado después de competir» | Sin UI relevante | Se deja como está; no se toca |

**RLS viva que se reemplaza en F1** (`pg_policies`, releído completo el 2026-09-26):
`match_results` tiene 5 policies: `match_results_admin_all` (FOR ALL, sí trae
WITH CHECK, vía `is_school_admin(teams.school_id)`), lectura para **cualquier
miembro activo** de la escuela (`teams JOIN school_members`, sin filtrar rol) y
escritura para roles `owner/admin/staff/coach/super_admin/school_admin` por el
mismo JOIN. No es un hueco de seguridad, pero: no usa los helpers de alcance del
repo (`user_staff_school_ids()`), evalúa un JOIN por fila y no contempla a la
familia de un equipo que no sea miembro de `school_members`. Se reemplazan por 4
policies con helpers envueltos, igual que `calendar_events`. Las de
`match_lineups` / `match_lineup_players` / `performance_entries` ya usan
`user_staff_school_ids()` para escribir y dejan leer a la familia lo de su hijo
(`is_parent_of_child`); la de lectura de `performance_entries` se **modifica**
(no se suma otra: son permisivas) para que lo de contexto `competition` solo
llegue a la familia cuando el partido está publicado (D7).
`sport_metric_definitions` es lectura `true` para `authenticated`, correcto para
un catálogo. `match_lineup_players.position_code` tiene CHECK solo con posiciones
de fútbol: para otros deportes va `NULL` (el CHECK lo admite).

---

## 2. Decisiones de producto

| # | Pregunta | Decisión | Estado |
|---|---|---|---|
| **D1** | ¿Tabla nueva `matches` o ampliar `match_results`? | **Ampliar `match_results`.** Ya la usan Resultados, el módulo Fútbol y las alineaciones (`source_type = 'team_match'`); una tabla nueva obligaría a migrar 23 partidos, 5 alineaciones y dos pantallas. Se le agregan escuela, estado, hora, lugar, enlace al calendario y auditoría | 🟢 cerrada |
| **D2** | ¿Todo pasa por el mesociclo? | **No.** El partido es **un registro** y se llega a él desde **tres puertas**: Calendario (agendar), Resultados (marcador + convocados + evaluar), Mesociclo (solo enlaza el día; opcional). Una escuela que nunca abre el mesociclo hace todo entre Calendario y Resultados | 🟢 cerrada (usuario) |
| **D3** | ¿Quién define los criterios de evaluación? | **El admin/owner de la escuela.** Los coaches los usan. Así las evaluaciones de todas las categorías son comparables. Un coach que quiera un criterio nuevo se lo pide al admin | 🟢 cerrada (usuario) |
| **D4** | ¿Fútbol o todos los deportes? | **Genérico.** Rival, marcador, convocados, minutos y evaluación aplican igual en voleibol o baloncesto. Goles, tarjetas y pizarra táctica siguen siendo del módulo Fútbol, que lee el mismo `match_results` | 🟢 cerrada (usuario) |
| **D5** | ¿Dónde vive la evaluación? | **`performance_entries` con `context_type = 'competition'` y `context_id = match_results.id`**, una fila por jugador × criterio. Es el modelo que ya alimenta el Informe Mensual y la evolución del atleta; no se inventa otro | 🟢 propuesta |
| **D6** | ¿Convocados y minutos? | **`match_lineups` + `match_lineup_players`** (`source_type = 'team_match'`, `source_id = match_results.id`). Ya tienen `role` titular/banca y `minutes_played`. Para deportes sin «alineación» la pantalla los muestra como lista de convocados, sin cancha | 🟢 propuesta |
| **D7** | ¿La familia ve la evaluación de su hijo? | **El marcador sí, siempre** (en la tarjeta del evento del calendario). **La evaluación individual solo si la escuela la publica:** `match_results.evaluation_published_at` la abre por partido, y `school_settings.share_match_evaluations` (default `false`) la habilita por escuela. Nunca ve la de otros jugadores | 🟡 **pendiente del usuario** (¿default apagado?) |
| **D8** | ¿Quién registra y evalúa? | Staff de la escuela (`user_staff_school_ids()`): el coach de la categoría y la administración. La UI del coach filtra a sus equipos igual que el calendario; la RLS lo acota a la escuela | 🟢 propuesta |
| **D9** | ¿Estados del partido? | `scheduled` → `played` → (`cancelled`). El marcador se puede **editar siempre** por staff (hoy no se puede); queda `updated_by`/`updated_at` | 🟢 propuesta |
| **D10** | ¿Qué escalas admite un criterio? | `scale_1_5`, `scale_1_10`, `yes_no`, `number` (con unidad y rango), `text`. Al menos un criterio numérico obligatorio para poder promediar; `text` no entra en promedios | 🟢 propuesta |
| **D11** | ¿Un partido para varias categorías? | **No.** Un partido pertenece a **una** categoría y a lo sumo a **un** evento del calendario (1:1). Dos categorías que juegan el mismo día son dos partidos | 🟢 propuesta |
| **D12** | ¿Y los torneos internos (`tournament_matches`)? | Se **enlazan** (`match_results.tournament_match_id`), no se fusionan. El fixture del torneo sigue mandando sobre fecha y rival; la evaluación se hace sobre el `match_results` enlazado | 🟢 propuesta |
| **D13** | ¿Criterios por defecto? | Al abrir «Criterios de evaluación» por primera vez, la escuela recibe **6 genéricos** (`scale_1_5`): Actitud y compromiso · Técnica · Toma de decisiones · Físico · Comunicación · Cumplimiento del rol, más «Comentario del coach» (`text`). Editables y desactivables. Las 122 métricas globales por deporte quedan disponibles como **plantillas** para agregar con un clic | 🟢 propuesta |
| **D14** | ¿Un solo evaluador por partido? | Sí en v1: la última escritura gana por (jugador, criterio), con `recorded_by`. Dos coaches evaluando al mismo tiempo no duplican (índice único) — se prueba en F1 | 🟢 propuesta |

---

## 3. Modelo conceptual (borrador — el DDL real va en el plan de la Fase 1)

### 3.1 `match_results` ampliada (el partido)

```
match_results  (existente: id, team_id, opponent, home_score, away_score, is_home,
                match_date, match_type, notes, created_at, opponent_team_id)
  + school_id            uuid NOT NULL  → backfill desde teams.school_id; trigger que lo
                                          copia del equipo (mismo patrón que calendar_events)
  + status               text NOT NULL DEFAULT 'played'  CHECK (scheduled|played|cancelled)
                                          (las 23 filas vivas tienen marcador → 'played')
  + kickoff_at           timestamptz     hora del partido (match_date se conserva por compat)
  + location             text
  + calendar_event_id    uuid UNIQUE REFERENCES calendar_events(id) ON DELETE SET NULL
  + tournament_match_id  uuid REFERENCES tournament_matches(id) ON DELETE SET NULL
  + evaluation_published_at timestamptz  (D7)
  + created_by / updated_by uuid REFERENCES profiles(id), updated_at timestamptz
```

Enlaces hacia el partido (una sola dirección cada uno, sin FKs cruzados):

```
training_microcycle_days.match_id  uuid REFERENCES match_results(id) ON DELETE SET NULL
   (tournament_match_id se conserva; el día puede tener uno u otro)
calendar_events ← match_results.calendar_event_id
   (el calendario muestra el marcador con el embed inverso match_results(home_score,…))
```

### 3.2 `school_metric_definitions` (criterios de la escuela — nueva)

```
id, school_id NOT NULL, metric_key text, display_name text, description text,
scale text CHECK (scale_1_5|scale_1_10|yes_no|number|text),
unit text, min_value numeric, max_value numeric, options jsonb,
applies_to text CHECK (match|training|both) DEFAULT 'match',
sort_order int, is_active bool DEFAULT true,
source_definition_id uuid REFERENCES sport_metric_definitions(id)  -- si vino de una plantilla
created_by, created_at, updated_at
UNIQUE (school_id, metric_key)
```

`performance_entries.metric_key` sigue siendo texto: para un criterio de escuela se
guarda `school:<metric_key>`; para uno global, la clave global. El catálogo del BFF
(`metric-catalog.service.ts`) resuelve primero en la escuela y cae al global.

### 3.3 Evaluación

```
performance_entries (existente)
  context_type = 'competition', context_id = match_results.id,
  subject_type child|profile|unregistered, subject_id, metric_key, value numeric, notes text
  + índice único (school_id, context_type, context_id, subject_type, subject_id, metric_key)
    → D14: dos evaluadores no duplican; el upsert gana
```

Los criterios `text` se guardan con `value = NULL` y el texto en `notes`.

### 3.4 RPCs transaccionales (regla del repo: multi-fila = RPC, nunca N inserts sueltos)

| RPC (`SECURITY DEFINER`, `search_path` fijo, `GRANT EXECUTE … TO authenticated`) | Hace | Gate interno |
|---|---|---|
| `create_match(p jsonb)` | Inserta el partido y, si `p.create_calendar_event`, el evento del calendario enlazado, **en una transacción** | `school_id = ANY(user_staff_school_ids())` |
| `save_match_roster(p_match uuid, p_players jsonb)` | Upsert de `match_lineups` + `match_lineup_players` (convocados, titular/banca, minutos) | staff de la escuela del partido |
| `submit_match_evaluation(p_match uuid, p_entries jsonb)` | Upsert de N `performance_entries` del partido; marca `status = 'played'` si estaba `scheduled` | staff |
| `publish_match_evaluation(p_match uuid, p_publish bool)` | Sella/borra `evaluation_published_at` (D7) | staff |
| `link_day_to_match(p_day uuid, p_match uuid)` | Enlaza un día `partido` del mesociclo | staff |
| `seed_school_match_criteria(p_school uuid)` | Crea los 7 criterios por defecto si la escuela no tiene ninguno (idempotente) | `user_admin_school_ids()` |

El BFF expone `/api/v1/school/matches…` y `/api/v1/school/evaluation-criteria…`
y llama a estas RPCs (el BFF sigue siendo el gate, como en Fútbol y Rendimiento).
`ResultsPage` y `useFootballData` dejan de insertar directo en `match_results`.

### 3.5 RLS (se revisa línea por línea en el plan de F1)

| Tabla | Lectura | Escritura |
|---|---|---|
| `match_results` | Creador · `school_id = ANY(user_school_ids())` · familia con alguien en el equipo (`calendar_family_team_ids()`, ya existe) | `user_staff_school_ids()`; se **eliminan** `match_results_admin_all` y las policies vía `teams JOIN school_members` |
| `school_metric_definitions` | `user_school_ids()` (el coach necesita leerlas) | `user_admin_school_ids()` (D3) |
| `performance_entries` | Se conserva; para `context_type = 'competition'` la lectura de la familia exige además `evaluation_published_at IS NOT NULL` del partido y el flag de la escuela (D7) | Se conserva (`user_staff_school_ids()` / `recorded_by`) |
| `training_microcycle_days` | Se conserva | Se conserva; el enlace va por RPC |

Después de aplicar: `npm run seguridad:invariantes` y simulación de sesión de un
papá, un coach y un admin con `set_config('request.jwt.claims', …)`.

---

## 4. Las tres puertas en la interfaz

### 4.1 Calendario (agendar) — cualquier escuela
- Al elegir **Tipo de evento = Partido** con una categoría en «Para quién», aparecen
  dos campos: **Rival** y **Local / Visitante**. Al guardar, `create_match` crea el
  evento y el partido enlazados (`status = 'scheduled'`).
- La tarjeta del evento muestra **el marcador** cuando el partido pasa a `played`,
  y un enlace «Registrar resultado» para el staff.
- Las familias lo ven como hoy (migración `20260923113401`).

### 4.2 Resultados (registrar y evaluar) — cualquier escuela, después del partido
- Lista por categoría con dos pestañas: **Programados** y **Jugados**. Un partido
  agendado en el calendario ya aparece aquí sin volver a escribirlo.
- **Editar partido:** rival, fecha y hora, lugar, local/visitante, marcador
  (editable siempre, D9), tipo (liga / amistoso / torneo), notas.
- **Convocados:** lista del roster de la categoría con casilla «convocado»,
  titular/banca y minutos. Sin cancha en deportes que no la usan (D6).
- **Evaluar rendimiento:** tabla jugadores × criterios activos de la escuela
  (D3/D10). Guardado en lote con `submit_match_evaluation`. Botón **Publicar a las
  familias** (D7).
- Botón «Registrar partido» también desde cero, para quien no lo agendó.

### 4.3 Mesociclo (planificar) — solo el coach que planifica
- En un día `partido` el botón «Crear sesión» se reemplaza por **Registrar partido**
  (crea uno nuevo o **enlaza uno existente** de esa semana y categoría).
- El día enlazado muestra rival y marcador; el índice MD sigue calculándose igual.
- Arreglos que van en la misma fase: **editar y borrar un día**, y el título del
  diálogo de sesión que dice «Editar» cuando se está creando
  (`sessionDialogSession` siempre trae `session_date`).

### 4.4 Configuración → Criterios de evaluación — admin/owner (D3)
- Lista ordenable de criterios de la escuela: nombre, escala, aplica a
  (partido/entrenamiento/ambos), activo.
- «Agregar criterio» (propio) o «Agregar desde plantilla» (las 122 métricas del
  deporte de la escuela).
- Desactivar en vez de borrar cuando ya tiene evaluaciones.
- El coach **no** ve esta pantalla; en la evaluación ve los criterios activos.

### 4.5 Familia
- Marcador en la tarjeta del evento (siempre).
- Si la escuela publica (D7): «Rendimiento de <hijo> en el partido» con sus
  criterios y el comentario del coach. Nunca los de otros jugadores.

### 4.6 Informe Mensual del atleta (fase final)
- Agrega el promedio de los criterios numéricos de partido del mes y la lista de
  partidos jugados con minutos.

---

## 5. Fases de entrega (una rama por fase; revisión entre fases)

| Fase | Contenido | Entregable de cierre |
|---|---|---|
| **F0** | Este spec | Decisiones D1–D6, D8–D14 cerradas; D7 confirmada por el usuario |
| **F1 · DB + RLS + RPC** | Columnas de `match_results` con backfill (23 filas) y trigger de escuela · `school_metric_definitions` · enlaces en `training_microcycle_days` · índice único de `performance_entries` · 6 RPCs · policies nuevas (se tiran las 5 viejas de `match_results`) | Migración aplicada por `apply_migration`; `seguridad:invariantes` sin críticas; **test de concurrencia**: dos `submit_match_evaluation` simultáneos sobre el mismo partido → una fila por (jugador, criterio) |
| **F2 · BFF** | `school/matches` (CRUD, roster, evaluación, publicar) · `school/evaluation-criteria` (CRUD admin, seed, plantillas) · `metric-catalog.service` resuelve escuela → global · `ResultsPage`/`useFootballData` dejan de escribir directo | OpenAPI actualizado; pruebas de autorización (padre 403, coach de otra escuela 403) |
| **F3 · UI Resultados + Criterios** | `ResultsPage` nueva (programados/jugados, editar, convocados, evaluar, publicar) · pantalla de criterios del admin con seed y plantillas | Capturas reales; QA con Besser (Duván) en dev |
| **F4 · Calendario ↔ Partido + Mesociclo** | Campos rival/local en el evento tipo Partido · marcador en la tarjeta · día `partido` con «Registrar/enlazar partido» · editar/borrar día · título del diálogo | Un partido agendado en calendario aparece en Resultados y en el mesociclo sin re-tipear |
| **F5 · Familia + Informe + Manual** | Vista de la familia (D7) · Informe Mensual con partidos · manual «Partidos y evaluación» en `docs/manuales/_src/` (interno + academias) · artículo del Centro de Ayuda | Despliegue a dev/stg/prod; manual en las dos versiones |

---

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| `match_results` sin `school_id`: el backfill depende de que las 23 filas tengan `team_id` válido | Contar huérfanas en el plan de F1 antes de poner `NOT NULL`; si hay, `school_id` nace nullable y se endurece después |
| El módulo Fútbol y `ResultsPage` escriben `match_results` directo desde el cliente | F2 los pasa por el BFF **antes** de endurecer las policies de escritura (o los dos caminos conviven una fase, con la RLS de staff como red) |
| `performance_entries.metric_key` es texto libre: un criterio de escuela renombrado no reescribe historiales | La clave `school:<metric_key>` es inmutable; solo cambia `display_name` |
| Un coach evalúa a un jugador que no estaba convocado | Permitido pero avisado (el jugador aparece en gris); no se bloquea, la lista de convocados suele quedar incompleta |
| Publicar la evaluación a la familia expone opiniones del coach | D7 default apagado a nivel escuela; se publica partido por partido; el texto del botón lo dice explícito |
| Cuota de despliegues de Vercel y deploy manual | Ver `feedback_batch_pushes_vercel_quota` y `project_vercel_deploys_son_manuales` |

---

## 7. Fuera de alcance (v1)

- Un partido para varias categorías (D11).
- Estadísticas agregadas de temporada por deporte (goles por jugador, etc.): siguen en el módulo Fútbol.
- Marcador en vivo / minuto a minuto.
- Fusionar `tournament_matches` con `match_results` (D12).
- Que el coach cree criterios propios (D3).
- Evaluación del rival o del árbitro.

---

## 8. Preguntas abiertas para el usuario

1. **D7:** ¿la evaluación individual del hijo arranca **apagada** para todas las
   escuelas y cada una la prende en Configuración? (Recomendado.) ¿O prendida?
2. ¿Besser quiere criterios distintos por categoría (Infantil vs Juvenil) o los
   mismos para toda la escuela? El modelo de D3 los hace por escuela; por
   categoría sería una columna `team_id` opcional en `school_metric_definitions`
   (fácil de agregar en F1 si se decide ahora, incómodo después).

---

## 9. Estado

- 2026-09-23 · F0 escrito con D2, D3 y D4 cerradas por el usuario en la
  conversación de ese día.
- 2026-09-26 · «dale, continúa»: D7 queda **apagada por defecto** (la escuela la prende) y
  los criterios son **por escuela**. Plan de F1 escrito en
  [plan-partidos-f1-db-rls-rpc.md](../plan-partidos-f1-db-rls-rpc.md) con el DDL, las
  policies, los RPCs, el radio de impacto y las 10 pruebas; verificado contra la base viva
  (24 partidos, 0 huérfanos, 3 sin marcador). Pendiente: aprobar el plan y aplicar.
- 2026-09-26 · **F1 aplicada** (`20260926131340_partidos_f1_school_id_status_criterios_rls_rpcs`).
  Pruebas T1–T10 en verde con sesiones simuladas del papá y del coach de Besser, todas en
  transacciones revertidas. Diferencia con el plan: un criterio `text` guarda `value = 0` porque
  `performance_entries.value` es NOT NULL. Siguiente: F2 (BFF).
- 2026-10-26 · **Pantalla única del partido** (`/partidos/:id`, `frontend/src/components/partidos/PartidoFlujo.tsx`;
  lógica pura en `partidoFlujoLogic.ts` con pruebas). Pasos: Programar (`create_match` / `update_match`) →
  Convocar (`ConvocatoriaPartido`, extraída de Equipos › Partidos; `save_match_roster`) → Resultado (marcador +
  goles/asistencias/tarjetas por jugadora en la misma vista, vía BFF `/school/football/events` como
  `MatchEventsModal`; solo en fútbol) → Evaluar (solo convocadas; criterios `school_metric_definitions`
  activos de partido/ambos y, si la escuela no tiene, la lista rápida del deporte del BFF;
  `submit_match_evaluation` y `publish_match_evaluation`, sujeto a `share_match_evaluations`) → Reporte
  (`MatchReportDialog`). Sin migraciones nuevas. Decisiones de esta entrega:
  · `metric_key` se guarda tal cual la clave del criterio (sin prefijo `school:`), igual que el resto del
    repo (`metric-catalog.service.ts`).
  · Menú de escuela «Resultados» → `/results`. `/results-overview` sale del menú pero la ruta queda: hoy
    solo pinta datos de demostración de cheer. Deportes por sets (voleibol) siguen con
    `CompetitionResultsList` dentro de `/results`.
  · Calendario: un evento tipo Partido para un equipo crea el partido con `create_match`
    (`create_calendar_event: true`) y luego ajusta título/hora de fin del mismo evento. Editar un evento
    existente no toca el partido.
  · Fútbol (panel): «Programar Partido» y el lápiz enlazan a la pantalla del partido; «Eventos» queda
    solo para partidos de torneo.
