# Spec — Seguimiento integral: nutrición del club, hidratación y bienestar diario

> **Fecha:** 2026-11-26 · **Estado:** PLAN para aprobación. Sin código, sin migraciones, sin consultas a la base.
> **Cubre:** `PAR-4` (nutrición e hidratación) y `PAR-5` (bienestar diario y mente = `BOD-1B`) del
> [plan de paridad](../plan-paridad-y-v2-2026-11.md).
> **Decisión de partida (D-NUT-1, el usuario, 2026-11-26):** nutrición empieza por **plan del club + hidratación**.
> El nutricionista de la escuela o el entrenador asigna plan y metas de hidratación a un equipo o a un deportista. El
> deportista registra en 2 toques y el entrenador recibe alertas. PAR-5 suma un check-in diario de sueño, fatiga,
> ánimo, estrés y dolor, con alertas. Se integra con la carga (ACWR) y con la encuesta post-entreno **sin repetir preguntas**.
> **Reemplaza/ajusta:** §5.2 de [body-biblioteca-tecnicas-y-rendimiento.md](body-biblioteca-tecnicas-y-rendimiento.md)
> (este spec es ahora el detalle de `BOD-1B`). [nutricion-atletas-independientes.md](nutricion-atletas-independientes.md)
> sigue vigente para el autorregistro de comida del adulto sin escuela, pero queda **después** de este spec (§13).
> Lo marcado *(por verificar)* no se ha comprobado contra la base viva.

---

## 1. Lo que ya existe (leído en el repo el 2026-11-26)

| Pieza | Qué hay | Qué significa para este spec |
|---|---|---|
| `/nutrition` → `NutritionPage.tsx` | Pantalla de ejemplo: `mockPlans = []`, botón «Nuevo Plan» que no hace nada. Ruta en `App.tsx` (~l. 1120) para `wellness_professional/admin/super_admin`. `routePermissions.ts` además admite `school/school_admin`. **No tiene entrada en el menú.** | Se retira (§9). No se reutiliza el componente. |
| Addon `nutrition` | Se vende en `saas-plans.ts` (incluido en enterprise) y aparece en `AdminSubscriptionsPage`, `MiPlanPage` y `useEntitlements`. Activarlo no cambia nada visible (el mismo defecto de `DIN-4`) | Se retira de la venta hasta F3 (§9) |
| `/wellness` → `WellnessModule.tsx` | Mediciones corporales del deportista (peso, talla, % de grasa en `body_metrics`), con evolución e historial | Sigue igual. El peso de esta tabla sirve en F5 para la tasa de sudoración. **No registra sueño, fatiga ni dolor** |
| Profesionales de salud | Módulo clínico F0–F3 vivo (`clinical_*`, `athlete_injuries`, consentimientos versionados `clinical_consent_texts`/`clinical_consents`). **El custodio es el profesional, no la escuela**. La escuela solo ve disponibilidad por `get_school_athlete_availability()`. Especialidades: `fisioterapia`, `nutricion`, `psicologia`, `medicina_deportiva` (`vendor_profiles.professional_specialty`) | El nutricionista ya existe como usuario. **No hay vínculo «profesional ↔ escuela»**: hoy el profesional atiende a pacientes, no a un club. Hay que crearlo (§3.1) |
| Encuesta post-entreno | Sale al **cerrar la lista** (trigger `post_training_notify_on_finalize`). La responde el acudiente o el deportista: `rpe_borg`, `self_effort_pct`, `task_comprehension`, `satisfaction` y los `focus_*` de cada deporte, guardados en `performance_entries` (`context_type='session'`). Plazo: fin del día siguiente | Ya mide el **RPE individual**. El check-in **no pregunta esfuerzo ni RPE** (§6) |
| Carga (track PER) | `v_session_load` (RPE de sesión × minutos de `session_blocks`). `training_load_summary()`: UA, monotonía, strain y **ACWR por equipo**, en NULL con menos de 28 días de historia. `athlete_weekly_load()`: carga por atleta = RPE **de la sesión** × minutos × asistencia. `MicrocycleLoadPanel.tsx` pinta ACWR con los rangos de Gabbett (0,8–1,3; > 1,5 riesgo alto) | El cruce bienestar × carga se apoya en estas RPC, no en un cálculo nuevo en el navegador |
| Despachador de notificaciones | `INSERT` en `notifications` → outbox → in-app, web push y FCM. **Solo push**: no manda WhatsApp. Las categorías se validan con `notifications_category_check` | Las alertas salen por aquí con una categoría nueva `bienestar`. El WhatsApp va por `whatsapp-bot.service` y `wa_can_send_template` |
| V2 | `AthleteHomeV2.tsx` (con `useEnvioConDeshacer`), `CoachHomeV2.tsx`, `BandaPendientes.tsx`, `CoachAttendanceV2.tsx` y la cola sin señal (`colaAsistencia.ts`) | Las pantallas nuevas son tarjetas dentro de la V2, no rutas sueltas |
| Identidad del deportista | `performance_entries` usa `subject_type ∈ {profile, child, unregistered}` + `subject_id`. Helpers vivos: `is_parent_of_child()`, `is_linked_unregistered_athlete()`, `coach_team_ids()`, `is_own_team_coach()` | Se copia el mismo patrón de sujeto |

---

## 2. Decisiones (numeradas, con recomendación)

Las que dicen **Recomendado** esperan tu visto bueno. Ninguna bloquea F0.

| # | Decisión | Opciones | Recomendado |
|---|---|---|---|
| **D-SI-1** | **Quién es «el nutricionista del club»** | (a) Fila en `school_staff` con especialidad. (b) Un `wellness_professional` existente vinculado a la escuela por una **asignación** explícita que otorga la administración | **(b)**. Con (a) el nutricionista entra en `user_staff_school_ids()` y ve todo lo operativo (pagos incluidos). Con (b) el permiso alcanza solo a lo de salud y a los equipos asignados. Además respeta la decisión de 2026-10-06: el profesional es un usuario aparte, no un empleado que absorbe la escuela |
| **D-SI-2** | **Quién puede asignar plan y metas** | Solo el nutricionista, o también el entrenador | **Ambos, con un límite**. El entrenador asigna **plantillas del club** (guía general por momento: antes, durante y después del entreno, día de partido) y **metas de hidratación**. Un plan **individual con cantidades** (dieta) lo firma solo un profesional con especialidad `nutricion` y tarjeta profesional cargada (Ley 73 de 1979, §11) |
| **D-SI-3** | **Unidad de hidratación** | ml libres, o envases | **Envases configurables** (vaso 250 ml, botella 500 ml, botella 750 ml o 1 L). Se guarda en ml. El plan define el envase por defecto del equipo |
| **D-SI-4** | **Quién registra la hidratación** | Deportista, acudiente o entrenador | **Los tres**. El deportista con cuenta, desde su celular. El entrenador, para el equipo desde la lista de asistencia («todos 1 botella» y corrige excepciones), porque los menores de Monster, Besser o Dreamers muchas veces no llevan celular al entreno. Cada registro guarda `source` |
| **D-SI-5** | **Escala del check-in** | 1–7 (Hooper original), 1–5 o deslizador | **1–5 con caras**, guardado en sentido Hooper: **más alto = peor** en sueño (calidad), fatiga, dolor y estrés. Ánimo va aparte, también 1–5 con 5 = peor, para sumar sin invertir. Índice Hooper adaptado = sueño + fatiga + estrés + dolor (4–20) |
| **D-SI-6** | **Botón «Todo bien»** | Sí o no | **Sí**, marcado `quick = true`. Guarda 2 en las cuatro escalas y en el ánimo. Las pantallas lo muestran como «rápido» y la línea base personal lo pondera menos. Sin él, la adherencia cae, que es el riesgo dominante (§12) |
| **D-SI-7** | **Frecuencia y recordatorio** | Diario, o solo días de entreno | **Disponible todos los días; el recordatorio sale solo en días de entreno, el día de partido y el día siguiente**, a la hora que fije la escuela (por defecto 2 h antes de la primera sesión del equipo, o 7:00 si no hay horario) |
| **D-SI-8** | **Quién responde por un menor** | Siempre el acudiente, o el menor si tiene cuenta | **El menor con cuenta propia responde, si el acudiente lo autorizó en el consentimiento. Si no, responde el acudiente.** Menores de 12 años: versión corta (sueño, dolor, ánimo), sin estrés |
| **D-SI-9** | **Qué ve el entrenador** | Detalle, semáforo, o semáforo con dimensión | **Semáforo** (verde, amarillo, rojo, sin dato) + una dimensión gruesa: `descanso`, `físico` o `general`. Si la causa es ánimo o estrés, dice `general`, nunca «ánimo». El detalle lo ven el profesional asignado con consentimiento, el propio deportista y su acudiente (§4) |
| **D-SI-10** | **Alertas de ánimo y estrés** | Al entrenador, al psicólogo o a nadie | **Al «referente de bienestar» de la escuela**: psicólogo asignado (D-SI-1) o, si no hay, un adulto que designa la administración. Nunca al entrenador con detalle. Al deportista se le muestra siempre un mensaje fijo con líneas de ayuda *(por verificar: Línea 192 opción 4 de MinSalud y Línea 106 en Bogotá)*. **SportMaps no es un canal de crisis**: lo dice el consentimiento y lo dice la pantalla |
| **D-SI-11** | **WhatsApp** | Alertas por WhatsApp, o solo recordatorios | **Solo recordatorios y resúmenes sin datos de salud**: «Hoy tienes 3 alertas de bienestar en SportMaps» + enlace, sin nombres ni causas. El detalle no viaja por Meta (§11). Va en F4 y por plantilla aprobada |
| **D-SI-12** | **Integración con la encuesta post-entreno** | Unificar formularios, o mantenerlos separados | **Separados, sin tocar la encuesta**. Check-in = estado **antes** de entrenar. Encuesta = esfuerzo **después**. Ninguna pregunta se repite (§6). No se agrega hidratación a la encuesta: sería cambiar un flujo acordado |
| **D-SI-13** | **Carga individual** | RPE de la sesión (lo que usa `athlete_weekly_load` hoy), o RPE del deportista | **El `rpe_borg` del deportista cuando existe; si no, el de la sesión**. Cada dato guarda su origen. ACWR individual solo con 28 días de historia **del deportista**; antes, se muestra el del equipo con la etiqueta «del equipo» |
| **D-SI-14** | **Cobro** | Addon `nutrition`, o incluido | **PAR-5 (check-in) incluido en todos los planes**: es seguridad del deportista y alimenta la adopción. **PAR-4 (plan del nutricionista) va dentro del addon `nutrition`**, que se vuelve a vender cuando F3 esté vivo. La hidratación básica (meta del entrenador + registro) va incluida |
| **D-SI-15** | **Retención** | Indefinida, o con plazo | **Detalle diario por 24 meses; después solo agregados mensuales.** Al revocar el consentimiento, el detalle se borra en 30 días (§11). Son datos de bienestar, no historia clínica, así que no aplican los 15 años de la Res. 1995 |
| **D-SI-16** | **Ficha técnica PAR-1** | Mostrar bienestar, o no | **No mostrar salud en la ficha**: es una hoja de vida que se comparte con otros clubes. Solo «adherencia a hidratación» y «adherencia al check-in» como hábitos, y ni eso si el acudiente no lo autoriza (§8) |

---

## 3. Modelo de datos

Convenciones obligatorias (`CLAUDE.md`):
- `npm run migrations:new`.
- Estados con `text + CHECK`, nunca `CREATE TYPE`.
- FKs de negocio a `public.profiles(id)`.
- `SET search_path = pg_catalog, public, pg_temp` en toda función.
- `GRANT EXECUTE` explícito por RPC, y `REVOKE` explícito de `anon` y `authenticated` en lo que no se expone.
- Policies `TO authenticated`, con `(SELECT auth.uid())` y helpers envueltos (`= ANY ((SELECT public.f())::uuid[])`).
- `FOR ALL` nunca sin `WITH CHECK`.
- Escritura por `user_staff_school_ids()` o por el profesional asignado, **nunca** por `user_school_ids()` (I2).
- Creación multi-fila por RPC transaccional.

**Sujeto del dato.** Igual que `performance_entries`: `subject_type text CHECK (subject_type IN ('profile','child','unregistered'))` + `subject_id uuid`. No hay FK posible a tres tablas: la integridad la valida la RPC que escribe, con `is_parent_of_child()` y `is_linked_unregistered_athlete()`. Quien escribe queda en `recorded_by → profiles(id)`.

### 3.1 Base común (F1)

| Tabla | Columnas clave | Notas |
|---|---|---|
| `school_health_assignments` | `id`, `school_id`, `professional_id → profiles`, `specialty` (`nutricion` / `psicologia` / `fisioterapia` / `medicina_deportiva`), `team_ids uuid[]` (NULL = toda la escuela), `is_wellbeing_referent boolean`, `status` (`activa` / `revocada`), `granted_by → profiles`, `granted_at`, `revoked_at` | D-SI-1. La crea y revoca solo la administración (`user_admin_school_ids()`), por RPC: es un permiso que **otorga acceso a datos de salud**, no se delega. `is_wellbeing_referent` también puede marcarse en un adulto del staff no profesional (D-SI-10) |
| `wellness_consent_texts` | `id`, `version`, `scope` (`bienestar` / `hidratacion_nutricion` / `detalle_a_salud`), `body`, `published_at` | Versionado igual que `clinical_consent_texts`. Lo redacta SportMaps con revisión legal (§11) |
| `wellness_consents` | `id`, `school_id`, `subject_type`, `subject_id`, `text_id`, `body_snapshot`, `granted_by → profiles`, `relationship` (`propio` / `acudiente`), `minor_self_report boolean`, `channel` (`app` / `presencial`), `granted_at`, `revoked_at` | Una fila por sujeto, escuela y alcance. **Nunca se borra; revocar pone fecha**. Sin consentimiento vigente de `bienestar`, la RPC del check-in responde 42501 con un mensaje claro |
| `school_wellness_settings` | `school_id` PK, `checkin_enabled`, `reminder_mode` (`antes_sesion` / `hora_fija`), `reminder_time`, `pain_red_threshold` (4–5), `hooper_red_abs` (12–18), `team_low_response_pct` (40–90), `updated_by`, `updated_at` | Umbrales con CHECK de rango: la escuela ajusta, pero no puede apagar el rojo por dolor 5 |

### 3.2 Bienestar diario — PAR-5 (F1)

`athlete_wellness_checkins` (nombre de `BOD-1B`; la decisión A3 ya fijó tabla propia):

| Columna | Tipo | Notas |
|---|---|---|
| `id`, `school_id`, `subject_type`, `subject_id` | | |
| `checkin_date` | `date` | Fecha de Bogotá, calculada en el servidor |
| `sleep_hours` | `numeric(3,1)` NULL | Chips 5 / 6 / 7 / 8 / 9+; opcional |
| `sleep_quality`, `fatigue`, `soreness`, `stress`, `mood` | `smallint CHECK 1..5` | Más alto = peor (D-SI-5). `stress` es NULL en la versión corta (D-SI-8) |
| `pain_region` | `text` NULL, CHECK contra la lista `BodyRegion` del módulo clínico | Solo si `soreness ≥ 4`. Es zona gruesa, no un diagnóstico |
| `hooper_index` | `smallint` generado | `sleep_quality + fatigue + COALESCE(stress, …) + soreness`. Se calcula en la base, nunca en el navegador |
| `quick` | `boolean` | D-SI-6 |
| `source` | `text CHECK ('deportista','acudiente')` | |
| `recorded_by → profiles`, `created_at`, `updated_at` | | |
| | | `UNIQUE (subject_type, subject_id, checkin_date)`. Se puede corregir el mismo día; después queda congelado |

- **Escritura:** solo por `submit_wellness_checkin(p_subject_type, p_subject_id, p_payload jsonb)`, `SECURITY DEFINER`. Valida:
  - que el caller sea el sujeto o su acudiente (y, en un menor con cuenta, el permiso `minor_self_report`);
  - que haya consentimiento vigente;
  - que la inscripción esté activa en esa escuela;
  - las escalas.

  Hace `INSERT … ON CONFLICT DO UPDATE` solo si es el mismo día. Al terminar, evalúa las reglas de alerta **de esa fila** (§7).
- **Lectura directa (RLS):** el dueño. `subject_id = ANY ((SELECT public.my_subject_ids())::uuid[])`, con un helper nuevo `my_subject_ids()` que devuelve: el propio `profile`, los `children` del acudiente y los `unregistered` vinculados. Como lo usa una policy, lleva `GRANT EXECUTE … TO authenticated` (regla de helpers, `CLAUDE.md`).
- **Sin policy de lectura para el staff.** Entrenador y escuela leen por RPC (§4). RLS filtra filas, no columnas.

### 3.3 Plan del club e hidratación — PAR-4 (F3)

| Tabla | Columnas clave | Notas |
|---|---|---|
| `nutrition_plans` | `id`, `school_id`, `kind` (`plantilla_club` / `individual`), `title`, `objective`, `status` (`borrador` / `activo` / `archivado`), `author_id → profiles`, `author_role` (`entrenador` / `nutricionista`), `version`, `created_at` | `individual` exige `author_role = 'nutricionista'`, validado en la RPC (D-SI-2) |
| `nutrition_plan_items` | `plan_id`, `position`, `moment` (`dia_normal` / `pre_entreno` / `durante` / `post_entreno` / `dia_partido` / `recuperacion`), `guidance text`, `portion_hint text` NULL | Guía legible, no un catálogo de alimentos. Los macros y el registro de comida son de otro spec (§13) |
| `hydration_targets` | `id`, `school_id`, `plan_id` NULL, `ml_per_session`, `ml_per_hour` NULL, `ml_per_day` NULL, `default_container_ml`, `container_options int[]` | Una meta puede existir sin plan de comida (el entrenador solo pone agua) |
| `nutrition_assignments` | `id`, `school_id`, `plan_id` NULL, `hydration_target_id` NULL, `team_id` NULL **o** (`subject_type`, `subject_id`), `starts_on`, `ends_on` NULL, `assigned_by → profiles`, `status` (`activa` / `terminada`) | `CHECK` de que haya equipo **o** sujeto. Precedencia: la asignación individual gana a la del equipo |
| `hydration_logs` | `id`, `school_id`, `subject_type`, `subject_id`, `log_date`, `attendance_session_id` NULL, `amount_ml` (CHECK 50–3000), `source` (`deportista` / `acudiente` / `entrenador`), `recorded_by → profiles`, `client_uuid uuid UNIQUE`, `created_at`, `voided_at` NULL | `client_uuid` da idempotencia ante doble toque y ante la cola sin señal. Deshacer = `voided_at`, no `DELETE` |

- **Escritura:**
  - `upsert_nutrition_plan(p_plan jsonb)` es transaccional: plan + ítems + meta + asignaciones en una sola RPC, nunca inserts sueltos.
  - `log_hydration(p_subject…, p_amount_ml, p_session_id, p_client_uuid)` para el deportista o su acudiente.
  - `log_team_hydration(p_session_id, p_amount_ml, p_overrides jsonb, p_client_uuid)` para el entrenador del equipo (`is_own_team_coach()`) o el staff de esa escuela.

  Todas validan alcance **contra esa escuela**: `user_staff_school_ids()` o una asignación activa de `school_health_assignments` con el equipo dentro.
- **Lectura:**
  - Planes y metas: staff de la escuela por RLS (`school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])`) y profesional asignado.
  - El deportista y su acudiente leen **solo lo asignado a ellos** por `my_nutrition_plan()`.
  - `hydration_logs`: el dueño por `my_subject_ids()`; el staff, solo agregado por RPC.

### 3.4 Alertas (F2)

| Tabla | Columnas clave | Notas |
|---|---|---|
| `wellness_alerts` | `id`, `school_id`, `subject_type`, `subject_id`, `alert_date`, `kind` (`dolor_alto` / `hooper_alto` / `sueno_bajo` / `animo_bajo` / `carga_y_malestar` / `hidratacion_baja` / `sin_registro`), `band` (`amarillo` / `rojo`), `dimension` (`descanso` / `fisico` / `general`), `audience` (`entrenador` / `referente` / `nutricionista`), `status` (`abierta` / `vista` / `cerrada`), `seen_by`, `closed_by`, `close_note`, `created_at` | `UNIQUE (subject_type, subject_id, alert_date, kind)`: una alerta por tipo, deportista y día. `close_note` es texto corto del staff, sin diagnóstico. **No se borra** |

Lectura solo por RPC con filtro de audiencia (§4). `REVOKE ALL` de `anon` en todas las tablas nuevas.

### 3.5 Notificaciones

Una migración amplía `notifications_category_check` con `bienestar`, siguiendo el patrón de `20261025003647`. Así se respetan las preferencias del despachador.

---

## 4. Quién ve qué

Principio: **minimizar**. Los datos de salud de menores son sensibles (Ley 1581, art. 5 y 7). Cada rol ve lo mínimo que necesita para actuar.

| Rol | Ve | No ve | Por dónde |
|---|---|---|---|
| **Deportista adulto** | Todo lo suyo: check-ins, tendencia, alertas propias, plan, meta e hidratación | — | RLS por `my_subject_ids()` |
| **Deportista menor con cuenta** | Lo mismo, si el acudiente activó `minor_self_report` | — | Ídem |
| **Acudiente** | Todo lo de su hijo, incluidas las alertas | Lo de otros deportistas | Ídem. Es el representante legal |
| **Entrenador del equipo** | Semáforo por deportista y día, con dimensión gruesa (D-SI-9). Quién no respondió. Hidratación del equipo en % de la meta y quién quedó bajo. Plan y metas del equipo | Escalas, horas de sueño, ánimo, estrés, zona de dolor, notas | `team_wellness_board(p_team_id, p_date)` y `team_hydration_board(…)`, `SECURITY DEFINER`, con `is_own_team_coach()` o el equipo dentro de `user_staff_school_ids()`. Devuelven columnas ya recortadas |
| **Nutricionista asignado** | Hidratación individual, plan y metas de sus equipos. Del check-in, **fatiga y sueño** de sus equipos, si hay consentimiento `detalle_a_salud` | Ánimo y estrés | `health_staff_wellness_detail(p_team_id, p_from, p_to)` con asignación activa + consentimiento |
| **Psicólogo / referente de bienestar** | Ánimo, estrés y alertas `animo_bajo` de su alcance, si hay consentimiento `detalle_a_salud` | Lo nutricional | Ídem, filtrado por especialidad |
| **Fisioterapeuta asignado** | Dolor y zona, alertas `dolor_alto` | Ánimo y estrés | Ídem |
| **Administración de la escuela** | Agregados por equipo (% de respuesta, % en rojo por semana, adherencia a hidratación). Gestión de asignaciones y umbrales | Datos individuales de salud, salvo que también sea entrenador del equipo (entonces ve el semáforo) | `school_wellness_summary(p_school_id, p_month)` |
| **Directivo solo informes** | Los mismos agregados | Individual | Ídem |
| **Super admin** | Nada individual por defecto | — | Soporte excepcional y auditado, como en el módulo clínico |
| **`anon`, enlace público del informe, ficha compartida** | Nada de esto | Todo | Excluido a propósito (§8) |

Cada lectura de detalle hecha por personal de salud queda en un registro de accesos, igual que `clinical_access_log`, o reutilizándolo *(por verificar si el esquema lo admite sin `patient_id`)*.

---

## 5. Flujos móviles V2

### 5.1 Check-in de 20 segundos (deportista o acudiente)

1. **Entrada.** Tarjeta «¿Cómo amaneciste?» arriba en `AthleteHomeV2`, y en la V2 del acudiente una por hijo. Aparece solo si hay consentimiento vigente y no hay check-in hoy. Llega también desde el push del recordatorio (deep link a la tarjeta abierta).
2. **Una sola pantalla, sin pasos:** cinco filas de cinco caras (Sueño · Cansancio · Dolor muscular · Estrés · Ánimo) y chips opcionales de horas de sueño. Cada fila es un toque. Si «Dolor» queda en 4 o 5, se despliega la silueta para tocar una zona (opcional).
3. **Botones:** «Todo bien» (D-SI-6, un toque) o «Listo». La meta es 6 toques y menos de 20 s, cronometrado en la prueba de usuario.
4. **Al guardar:** «Gracias, quedó» y deshacer por 5 s (`useEnvioConDeshacer`). Si el resultado es rojo, un mensaje para el deportista: «Cuéntale a tu entrenador antes de empezar». Si es ánimo bajo, el mensaje fijo con líneas de ayuda (D-SI-10). **Nunca** «tu entrenador ya fue avisado con el detalle»: no es cierto (D-SI-9).
5. **Sin señal:** se encola igual que la asistencia (`colaAsistencia`) con `client_uuid` y se envía al volver la señal.

### 5.2 Hidratación en 2 toques

- **Deportista.** Durante el día de una sesión, botón «+ Agua» en la tarjeta de la sesión del Inicio V2. Toque 1 abre los envases del plan; toque 2 elige uno y se guarda con deshacer. La barra muestra «750 de 1.000 ml» de la meta de la sesión. Fuera de sesión, el mismo botón suma a la meta del día, si el plan la tiene.
- **Entrenador.** En `CoachAttendanceV2`, junto a la lista, un modo «Hidratación». Un toque en «Todos: 1 botella» y después toques sueltos sobre quien tomó de más o de menos. Al «Cerrar la lista» aparece una sola línea: «3 deportistas por debajo de la meta». No se agrega un paso obligatorio al cierre: el flujo de «Cerrar y evaluar» que ya se acordó no cambia.
- **Sin señal:** misma cola, con `client_uuid`.

### 5.3 Entrenador: tablero del día

En `CoachHomeV2`, la tarjeta del equipo de hoy suma un semáforo compacto («2 en rojo · 3 en amarillo · 5 sin responder»). Al tocarlo, aparece la lista con nombre, color y dimensión. Cada alerta tiene dos acciones:
- «Lo vi»;
- «Hablé con él/ella», con una nota corta.

Si hay fisio o psicólogo asignado, un tercer botón «Pedir que lo revise», que avisa al profesional sin enviarle datos nuevos.

En `BandaPendientes` entra «Alertas de bienestar sin ver».

### 5.4 Nutricionista o entrenador: asignar plan y metas (F3)

Pantalla V2 «Nutrición del equipo» (sale del menú de Seguimiento deportivo del staff):
1. Elegir equipo o deportista.
2. Elegir una plantilla del club o crear una (momentos y guía).
3. Fijar la meta de hidratación con los envases.
4. Fechas.
5. Publicar.

El deportista y el acudiente reciben un push: «Tu entrenador te asignó un plan de hidratación». Un plan individual muestra el sello del profesional que lo firma.

---

## 6. Integración con la carga y la encuesta post-entreno, sin duplicar

| Pregunta | Dónde se hace | Cuándo |
|---|---|---|
| Sueño (calidad y horas), cansancio, dolor y zona, estrés, ánimo | **Check-in** (nuevo) | Antes de entrenar o al levantarse |
| RPE Borg, esfuerzo propio, comprensión, satisfacción, focos | **Encuesta post-entreno** (existe, no se toca) | Después de cerrar la lista |
| Esfuerzo del equipo (calificación del entrenador) | Rating del entrenador (existe) | Al cerrar |
| Agua tomada | **Hidratación** (nuevo) | Durante la sesión |
| Peso, talla, % de grasa | `/wellness` (existe) | Cuando se mida |
| Lesión y disponibilidad | Módulo clínico (existe) | Lo registra el profesional |

**Cruce (F2), calculado en el servidor:**
- `athlete_readiness(p_subject…, p_date)` une:
  - el check-in del día;
  - la carga del deportista (D-SI-13): `rpe_borg` × minutos de la sesión, o el RPE de sesión si no respondió;
  - su ACWR individual con historia de 28 días (si no la tiene, el del equipo de `training_load_summary` con la etiqueta «del equipo»);
  - la disponibilidad clínica si el profesional la comparte.
- Regla «carga y malestar»: ACWR > 1,5 **y** amarillo en el check-in, o día después de partido con Hooper alto → rojo con `kind = carga_y_malestar` y dimensión `fisico`.
- En `MicrocycleLoadPanel` se añade una columna «bienestar del equipo» (% en verde) junto a la UA y al ACWR, para que el entrenador vea juntas carga y respuesta. Es lectura, nunca bloquea (mismo criterio «audit» de PER-2).
- **Nada de esto se calcula en el navegador.** El frontend pinta lo que devuelve la RPC (lección del censo de cálculos).

---

## 7. Alertas

### 7.1 Reglas por defecto (la escuela ajusta dentro de rangos)

| Regla | Banda | Audiencia | Dimensión |
|---|---|---|---|
| Dolor = 5, o dolor ≥ `pain_red_threshold` (4 por defecto) con zona | Rojo | Entrenador (semáforo) + fisio asignado (detalle) | físico |
| Cualquier escala en 4, sin otra roja | Amarillo | Entrenador | según la escala |
| Hooper ≥ línea base personal + 1,5 DE (con ≥ 14 check-ins no rápidos en 28 días) | Rojo | Entrenador | descanso / físico |
| Hooper ≥ `hooper_red_abs` (15 por defecto) sin línea base todavía | Rojo | Entrenador | descanso / físico |
| Sueño < 6 h dos noches seguidas (< 7 h en menores de 18) | Amarillo | Entrenador | descanso |
| Ánimo o estrés = 5 dos días seguidos, o ≥ 4 cinco días de siete | Rojo | **Referente de bienestar** (detalle). Al entrenador: amarillo `general` | general |
| ACWR > 1,5 + amarillo | Rojo (`carga_y_malestar`) | Entrenador | físico |
| Hidratación < 50 % de la meta de la sesión al cierre de la lista | Amarillo | Entrenador + nutricionista | físico |
| Sin hidratación registrada 3 sesiones seguidas con meta activa | Amarillo | Nutricionista | físico |
| Equipo con < `team_low_response_pct` (60 %) de check-ins 1 h antes de la sesión | Aviso (no por deportista) | Entrenador | — |

Las reglas viven en **una** función pura en SQL, `wellness_eval_rules(…)`, con su espejo en TypeScript solo para las pruebas unitarias. La fuente es SQL.

### 7.2 Cuándo se evalúan

- **Por fila, al guardar** (dentro de `submit_wellness_checkin` y `log_*_hydration`): las reglas que solo miran ese registro y los 7 días anteriores del mismo deportista. Es una consulta acotada por índice.
- **Un job diario por lote:** baja de respuesta, línea base y «3 sesiones sin hidratación». Es una sola RPC `SECURITY DEFINER` de `service_role` que trabaja por conjunto (`INSERT … SELECT … ON CONFLICT DO NOTHING`), **sin N+1** (regla de Disk IO: los tres BFF comparten la base). Lo dispara `maintenance.job.ts` con su propio interruptor `DISABLE_WELLNESS_CRON`.

### 7.3 Entrega

- **In-app y push** con `INSERT` en `notifications`, `category = 'bienestar'`.
- **Para el entrenador, un resumen por equipo**, no un push por deportista: «Sub-15: 2 en rojo, 3 en amarillo antes del entreno de las 4». Sale a la hora del recordatorio + 1 h, o al instante si aparece un rojo de dolor después del resumen.
- **El texto del push nunca lleva datos de salud.** Dice «Bienestar: 2 alertas en Sub-15» y el detalle se ve dentro de la app con sesión. El push pasa por FCM y Apple, y la pantalla bloqueada la ve cualquiera.
- **Al acudiente:** sin alertas proactivas, salvo rojo de dolor cuando el que respondió fue el menor. Entonces: «Revisa el check-in de hoy de Juan».
- **WhatsApp (F4):** solo el recordatorio del check-in al acudiente, y para el entrenador el resumen sin nombres (D-SI-11). Va por `whatsapp-bot.service` + `wa_can_send_template`, con plantilla de utilidad aprobada y opt-in en `whatsapp_optins`.
- **Antispam:** máximo un push de bienestar por destinatario cada 3 horas (salvo el rojo de dolor) y `UNIQUE` por alerta y día.

---

## 8. Informes

| Destino | Qué entra | Qué no entra |
|---|---|---|
| **Informe Mensual del Atleta** (`report-snapshot.service.ts`, sección nueva `wellness_summary`) | Días con check-in / días de entreno, promedio por escala con tendencia frente al mes anterior, semanas en rojo, adherencia a hidratación (% de sesiones con la meta cumplida). Solo si hay consentimiento vigente; si no, la sección no aparece | Ánimo y estrés individual: se muestran como «estado general» en tres niveles, nunca con la cifra. Nada de notas del staff |
| **Enlace público del informe** (`informe-atleta-link-publico.md`) | **Nada** de esta sección | Todo. Mismo criterio que `BOD §5.2`: no sale en vistas públicas |
| **Informe grupal del entrenador** (`CoachTeamPostTrainingReportPage`) | Agregados del equipo: % de respuesta, % en rojo por semana, hidratación promedio frente a la meta, al lado de la carga | Individuales |
| **Ficha técnica global PAR-1** (`docs/specs/ficha-tecnica-global.md`, por escribir) | Solo hábitos, si el acudiente lo autoriza: «Check-in: 85 % de los días · Hidratación: 90 % de las sesiones» (D-SI-16) | Escalas, alertas, dolor y lesiones |
| **Mapi** | Puede responder al entrenador «¿quién llega cansado hoy?» con el mismo semáforo de `team_wellness_board` (mismo permiso, mismo recorte) | El detalle de salud. Mapi no recibe datos de salud en el prompt más allá de lo que el rol ya ve |

Los números del informe se calculan en el BFF/SQL desde las tablas, como `metrics_session`, nunca en el navegador.

---

## 9. Retiro de la pantalla mock `/nutrition` (F0, ya mismo)

Va en el punto 1 de la secuencia del plan de paridad («Ahora: ocultar `/nutrition`»). Es solo frontend, sin base:
1. `App.tsx`: `path="nutrition"` pasa a `<Navigate to="/pacientes" replace />` para `wellness_professional`, y al inicio para los demás. Es el mismo patrón que ya usan `athletes`, `evaluations/new` y `follow-ups`.
2. `routePermissions.ts`: quitar `/nutrition`.
3. Addon `nutrition`: se saca de la venta y de las listas (`saas-plans.ts`, `AdminSubscriptionsPage`, `MiPlanPage`) detrás de un flag `nutrition_addon_visible = false`. **No se borra la clave del `CHECK` de `school_addons`**. *(Por verificar con una consulta puntual: cuántas escuelas lo tienen activo; si alguna lo pagó, se le avisa y se le mantiene sin costo hasta F3.)*
4. `NutritionPage.tsx` queda sin importar. Se borra 30 días después sin reclamos (regla V2-A del plan), y F3 construye la pantalla nueva desde cero en V2.

---

## 10. Fases

Orden del plan de paridad: **PAR-5 en paralelo ya** (F1–F2), **PAR-4 después** (F3). F0 se puede hacer hoy. Todas las migraciones de una fase van **en un solo lote, aplicado por una sola sesión** con `apply_migration` o el CLI, y `types.ts` se regenera una vez al final del lote.

### F0 — Preparación (sin DDL)
- Retiro de `/nutrition` (§9).
- Texto de consentimiento v1 (bienestar, hidratación y nutrición, detalle a salud) redactado y **revisado por un abogado** (§11).
- Lecturas puntuales por nombre:
  - `notifications_category_check`;
  - existencia y grants de `is_parent_of_child`, `is_linked_unregistered_athlete`, `coach_team_ids`, `is_own_team_coach`;
  - escuelas con addon `nutrition` activo;
  - qué usa Besser hoy de la encuesta.

  Nada de `list_tables` ni de `get_advisors`.
- Preguntas exactas y fecha de arranque de la temporada 2027 confirmadas con Besser (es la decisión A3 que quedó abierta en BOD).

**Salida:** consentimiento aprobado, decisiones D-SI-1…16 respondidas, `/nutrition` fuera en develop.

### F1 — Check-in diario (PAR-5 / BOD-1B núcleo)
- **Migración:**
  - `school_health_assignments`;
  - `wellness_consent_texts` y `wellness_consents`;
  - `school_wellness_settings`;
  - `athlete_wellness_checkins`;
  - helper `my_subject_ids()`;
  - RPCs `grant_wellness_consent`, `revoke_wellness_consent`, `submit_wellness_checkin`, `team_wellness_board`, `upsert_health_assignment`;
  - categoría `bienestar`.
- **Frontend V2:**
  - consentimiento en el Inicio del acudiente y del deportista adulto;
  - tarjeta del check-in (§5.1) con cola sin señal;
  - semáforo **sin reglas avanzadas** en `CoachHomeV2` (rojo/amarillo por umbral fijo de escala, quién no respondió);
  - pantalla de administración para asignar el referente y los profesionales.
- **Recordatorio:** job diario que lee el lote con `.in('id', ids)` y crea las notificaciones.
- **Piloto:** Besser.

**Salida:**
- `seguridad:invariantes` sin críticos.
- Pruebas negativas de RLS en verde (abajo).
- 5 personas reales (acudientes y deportistas de Besser) completan el check-in **en < 20 s** y 4 de 5 lo logran solas (gate del Track V2).
- ≥ 60 % de respuesta en la primera semana del piloto.

### F2 — Alertas y cruce con la carga
- `wellness_alerts`, `wellness_eval_rules`, job diario por lote, `athlete_readiness`.
- Columna de bienestar en `MicrocycleLoadPanel`, D-SI-13 en la carga individual.
- Resumen push del entrenador, bandeja de alertas con «Lo vi» y «Hablé con…».
- Detalle para el referente de bienestar y el fisio asignado, con registro de accesos.

**Salida:**
- Reglas con prueba unitaria por regla, incluidos los bordes (sin línea base, check-in rápido, menor < 12 sin estrés).
- Una semana de piloto con cero push con datos de salud en el texto, verificado leyendo `notifications`.
- El entrenador de Besser confirma que el resumen le llega antes del entreno.

### F3 — Plan del club e hidratación (PAR-4)
- `nutrition_plans`, `nutrition_plan_items`, `hydration_targets`, `nutrition_assignments`, `hydration_logs`.
- RPCs `upsert_nutrition_plan` (transaccional), `log_hydration`, `log_team_hydration`, `my_nutrition_plan`, `team_hydration_board`, `health_staff_wellness_detail`.
- Pantallas §5.2 y §5.4. Reglas de hidratación en `wellness_eval_rules`.
- Addon `nutrition` de vuelta a la venta con lo que de verdad hace.
- **Piloto:** una escuela con nutricionista real *(decisión: ¿Carmel? ¿Monster?)*.

**Salida:**
- El entrenador registra la hidratación de un equipo de 20 en < 30 s.
- El deportista en 2 toques.
- Doble toque y reintento sin señal = un solo registro (prueba de concurrencia).
- Un plan individual sin un nutricionista firmante se rechaza.

### F4 — Informes y WhatsApp
- `wellness_summary` en el Informe Mensual.
- Agregados en el informe grupal.
- Hábitos en la ficha PAR-1 (si ya existe).
- `school_wellness_summary` para la administración.
- Plantillas de WhatsApp (recordatorio, resumen sin nombres).
- Retención (job mensual que agrega y borra el detalle de más de 24 meses y el de los consentimientos revocados hace 30 días).

**Salida:**
- El PDF del informe muestra la sección solo con consentimiento.
- El enlace público no la muestra (prueba explícita).
- La plantilla de WhatsApp aprobada por Meta.

### F5 — Después (no comprometido)
- Tasa de sudoración: peso antes y después del entreno (con `body_metrics`). Es un registro del nutricionista, no del deportista.
- Clima del día de la sesión.
- Autorregistro de comida del adulto ([nutricion-atletas-independientes.md](nutricion-atletas-independientes.md)) y foto de comida (idea Calor.IA), sobre su propio modelo.

### Pruebas, en todas las fases
- **RLS negativas,** con un script nuevo `npm run seguridad:rls-bienestar`, igual que `rls-clinicas` y con cuentas desechables `@rls-pruebas-negativas.invalid`. Casos:
  - un acudiente no lee el check-in de otro niño;
  - un entrenador de la escuela A no ve el tablero de B;
  - un entrenador de otro equipo de la misma escuela no ve el semáforo;
  - el nutricionista sin asignación no ve nada;
  - el psicólogo no ve hidratación;
  - `anon` no lee ninguna tabla;
  - sin consentimiento, 42501;
  - un menor sin `minor_self_report` no puede responder por sí mismo.
- **Unitarias (vitest):** reglas de alerta, línea base y Hooper, precedencia de asignaciones (individual sobre equipo), envases a ml.
- **Concurrencia:** dos check-ins simultáneos del mismo día, mismo `client_uuid` dos veces, cola sin señal reenviando.
- **E2E (Playwright)** en «Escuela Demo SportMaps» con usuarios de prueba propios. **Nunca con cuentas ni escuelas reales.** Recorrido: acudiente da consentimiento → check-in rápido → el entrenador ve el semáforo → cierra la lista con hidratación.
- **Antes de cerrar cualquier fase con RLS:** `npm run seguridad:invariantes` contra la base viva, y `pg_policies` de cada tabla nueva leída completa (las policies se suman con `OR`).

---

## 11. Riesgos legales y consentimiento (Colombia)

> Esto es un mapa para el abogado, no una opinión legal. Antes de F1, el texto del consentimiento y la política de
> privacidad unificada los revisa un asesor.

| Tema | Norma | Qué exige | Cómo lo cubre el diseño |
|---|---|---|---|
| **Dato sensible** | Ley 1581/2012, art. 5 y 6 | Sueño, dolor, ánimo, estrés, hidratación y plan alimentario son datos relativos a la salud. Exigen autorización **explícita**, informar que es **facultativo** responder, y qué datos son sensibles y para qué | Consentimiento propio por alcance (`bienestar`, `hidratacion_nutricion`, `detalle_a_salud`), versionado, con texto congelado. **El check-in es opcional y no condiciona la inscripción ni el entreno**: la escuela no puede exigirlo |
| **Niños, niñas y adolescentes** | Ley 1581, art. 7; Sentencia C-748/2011; Dec. 1377/2013 art. 12 (compilado en el Dec. 1074/2015); Ley 1098/2006 | Tratamiento solo si responde al **interés superior** del menor y respeta sus derechos. Autoriza el **representante legal**, previo ejercicio del derecho del menor a ser escuchado según su madurez | Autoriza solo el acudiente vinculado (`is_parent_of_child`). `minor_self_report` lo decide el acudiente. La finalidad declarada es su cuidado (prevenir lesión, fatiga y deshidratación). Minimización (§4) y versión corta para < 12 años (D-SI-8) |
| **Responsable y encargado** | Ley 1581, art. 3, 17 y 18; Dec. 1377 art. 25 | La escuela es **responsable** (decide la finalidad); SportMaps es **encargado**. Hace falta un contrato de transmisión, y la escuela debe tener política de tratamiento y, si le aplica, registro en el RNBD de la SIC | Cláusula de encargo en los términos de servicio de la escuela *(por verificar que exista: [politica_privacidad_unificada])*. Al activar el check-in, la escuela acepta esa cláusula |
| **Transferencia internacional** | Ley 1581, art. 26; circulares de la SIC sobre países adecuados | La base está en São Paulo, el BFF en Oregón, el push por Google y Apple, y WhatsApp por Meta | Se declara en el consentimiento. **Ningún dato de salud viaja en el texto del push ni por WhatsApp** (§7.3, D-SI-11). *(Por verificar con el asesor: si Brasil y EE. UU. figuran como adecuados o si basta el consentimiento expreso)* |
| **Derechos del titular** | Ley 1581, art. 8 | Conocer, actualizar, rectificar, revocar y suprimir | El titular ve todo lo suyo. Revocar consentimiento desde la app. Supresión del detalle en 30 días tras revocar (D-SI-15). Exportación por solicitud |
| **Ejercicio profesional** | Ley 73/1979 (nutrición y dietética); Ley 1164/2007 (talento humano en salud); Ley 1090/2006 (psicología) | Una prescripción dietaria individual o una intervención psicológica son actos profesionales | El entrenador solo asigna plantillas y metas de agua (D-SI-2). El plan individual exige un profesional con tarjeta cargada. El check-in **no diagnostica** y el texto lo dice: «es una guía para tu entrenador, no una evaluación médica ni psicológica» |
| **Riesgo de salud mental** | Deber de cuidado; Ley 1616/2013 (salud mental) | Si la app pregunta por el ánimo, alguien tiene que poder actuar | Alertas de ánimo al referente de bienestar humano (D-SI-10). Mensaje fijo con líneas de ayuda. Declaración explícita de que **no es un canal de crisis ni se monitorea en tiempo real**. Si la escuela no tiene referente, **no se activan** las preguntas de ánimo y estrés (quedan sueño, cansancio y dolor) |
| **Historia clínica** | Res. 1995/1999 | Aplica a registros de un profesional que atiende | El check-in no es historia clínica. Si el fisio actúa por una alerta, lo que escriba va al módulo clínico con su propio consentimiento, no a estas tablas |

---

## 12. Otros riesgos

- **R1 — Nadie responde.** Es el mismo riesgo dominante del RPE (`performance_entries` tenía 486 filas en toda la base). Mitigaciones:
  - «Todo bien» en un toque;
  - recordatorio solo en días de entreno;
  - el entrenador ve quién falta;
  - que el semáforo sirva con cero datos («sin dato» es un color, no un error).
- **R2 — Falsa calma.** «Sin alertas» no significa «todos bien» si respondió el 30 %. El tablero siempre muestra el % de respuesta al lado.
- **R3 — Alerta que nadie mira.** Una alerta roja sin «Lo vi» en 24 h sube a la administración como pendiente en `BandaPendientes`. El texto no lleva detalle.
- **R4 — Disk IO.** El job diario por lote y los tableros por RPC indexados por `(school_id, checkin_date)` y `(subject_type, subject_id, checkin_date)`. Nada de consultas por deportista en bucle. Medir con `EXPLAIN` antes de F2.
- **R5 — El entrenador infiere el dato sensible del semáforo** («general» repetido). Es aceptable y lo dice el consentimiento. Mitigación: «general» agrupa ánimo, estrés y combinaciones, así que no es una etiqueta exclusiva de salud mental.
- **R6 — Confusión de RPE.** `athlete_weekly_load` hoy usa el RPE de la sesión. Si F2 cambia a `rpe_borg`, los números de carga cambian. Se muestra el origen («RPE del deportista» / «del entrenador») y se anuncia el cambio al piloto.
- **R7 — Cuentas compartidas.** Un acudiente con tres hijos puede contestar los tres con la misma cara. Es aceptable en v1; `quick` y la línea base personal amortiguan.

---

## 13. Fuera de alcance

- Registro de comida, calorías y macros (lo cubre [nutricion-atletas-independientes.md](nutricion-atletas-independientes.md), después de F3).
- Foto de comida con IA.
- Wearables, GPS y variabilidad de la frecuencia cardíaca.
- Diagnóstico de cualquier tipo, cuestionarios clínicos validados de ansiedad o depresión (PHQ, GAD), y respuesta a crisis.
- Escribir en la historia clínica desde una alerta.
- Neuroentrenamiento (PAR-8, spec aparte).

## 14. Qué no se hace sin aprobación explícita

- Aplicar migraciones (una sola sesión, por lote, mostrando el SQL antes).
- Activar el check-in en una escuela real sin consentimiento aprobado por el asesor.
- Mandar WhatsApp a familias.
- Volver a vender el addon `nutrition`.
- Subir nada a `main`.
