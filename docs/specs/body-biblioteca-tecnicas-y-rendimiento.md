# Spec — Body, biblioteca de técnicas y rendimiento

> Fecha: 2026-11-20 · Estado: **PLAN para aprobación. Sin código, sin migraciones, sin consultas a la base.**
> Regla del repo: plan antes de código en migraciones. Nada de §5 se escribe hasta aprobar este documento y cerrar el paso 0.
> Lo marcado *(decisión)* necesita respuesta del usuario; lo marcado *(por verificar)* no se ha comprobado contra la base viva.
> Se apoya en: `docs/analysis/BIOMECH_MODULE_ANALYSIS.md` (diseño de Body), `plan-mapi-3d-lemur-2026-11-14.md` (Mapi 3D),
> `pizarra-m6h-videos-subidos.md` (video subido), `evaluacion-post-entrenamiento.md` (RPE), `docs/performance-metrics-spec.md`
> (métricas), `profesionales-salud-fisioterapia.md` (lesiones), `periodizacion-microciclos-y-carga.md` (carga),
> `rediseno-seguimiento-deportivo.md` (uso real en Carmel) y `docs/ROADMAP.md` (track `VID`, gate `G-IMAGEN`, MOD-36).
> En el roadmap: track **`BOD`** (`BOD-0` a `BOD-6`, con `BOD-1B`) y decisiones `D-BOD-1` a `D-BOD-7`. El paso N de este spec es `BOD-N`; la decisión A*n* de §8 es `D-BOD-n`.

---

## 1. Objetivo

Que el deportista vea cómo se hace bien una técnica, la ejecute frente a la cámara, reciba qué hizo mal y por qué, y que
eso entre solo a su rutina y a su historial. La IA explica a partir de fichas validadas por un entrenador y **nunca
inventa técnica**.

No es otro analizador de video (Onform, MotionCoach y Formanti ya lo hacen). Lo que ninguno tiene es la conexión entre
conocimiento validado, demostración, evaluación y el entrenamiento que la escuela ya gestiona en SportMaps.

## 2. Pilotos

| Escuela | Qué valida | Por qué ella |
|---|---|---|
| **Carmel** | Fichas, biblioteca de fútbol y vóley, Mapi demostrando, la mirada del entrenador | Ya pidieron la biblioteca y sus entrenadores usan la V2 de entrenamiento |
| **Besser** | Bienestar diario, carga/RPE, lesiones, historial del deportista, correctivos en la rutina | Ya capturan RPE; la meta es arrancar la temporada 2027 con monitoreo completo |

Fútbol pesa más de lo normal: si Carmel sale bien, Mauricio podría llevarlo a Santa Fe, donde importa la metodología y
la estadística de fútbol.

## 3. Lo que ya existe (leído en el repo el 2026-11-20)

| Pieza | Qué hay | Límite |
|---|---|---|
| **Body: captura y pose** | `BiomechCaptureModal.tsx` con MediaPipe en el dispositivo (graba hasta 15 s o recibe un archivo). Analizadores: `hack_squat`, `incline_press`, `row`, `volleyball_serve`, `volleyball_spike`. `lib/biomech/volleyball.ts` mide ángulo de codo, extensión del brazo y altura de salto | No guarda video (cumple `G-IMAGEN`) |
| **Body: piloto de vóley** | `BiomechVolleyballLabPage` en `/coach/voleibol-pose` | Sin enlace en el menú y sin guardar nada, a propósito |
| **Body: backend** | `bff/src/routes/trainer/biomech.ts` y `athlete/biomech.ts`; UI en `SessionExecution.tsx` y `ClientProgressTab.tsx`; addon `biomech` | **Las tablas (`biomech_captures`, `biomech_analyses`, `biomech_baselines`, `biomech_annotations`, `biomech_access_grants`, `skill_biomech_evidence`, `exercise_analyzers`, `exercise_analyzer_mappings`) no tienen `CREATE TABLE` en `supabase/migrations`**: deriva de esquema |
| **Biblioteca táctica** | `training_exercises` + `exercise_packs` (pizarra): objetivo, edad, materiales, deporte, dibujo | Sin músculos, sin fases, sin criterios |
| **Biblioteca clínica** | `exercise_library` + `exercise_assignments` + `exercise_logs` (fisioterapia): región, categoría, `video_url` | Sin deporte ni criterios técnicos |
| **Catálogo de gimnasio** | Proxy a wger y `free-exercise-db` (`routes/trainer/wger.ts`): músculos, equipo, nivel, imágenes | Sin tabla local, sin video, búsqueda solo por nombre |
| **Rutinas** | `trainer_routines` (bloques con `analyzer_code`), `athlete_training_plans`, `session_exercise_results`; `/trainer/routines` y `/school/routines` | — |
| **Rendimiento** | `sport_metric_definitions`, `sport_metric_thresholds`, `performance_entries`; informe mensual; encuesta post-entreno (RPE Borg, esfuerzo, comprensión, satisfacción) | Carmel usó 6 de 31 métricas de fútbol |
| **Lesiones** | Módulo clínico F0–F3: `athlete_injuries`, `athlete_injury_events`, `/salud` | — |
| **Bienestar** | `/wellness` guarda peso, talla y % de grasa en `body_metrics` | **No registra sueño, fatiga ni dolor muscular** |
| **Video subido** | `school_videos`, `school_video_clips` (un recorte se enlaza a `exercise_id`), subida directa a Bunny Stream | Solo personal y entrenadores. El spec dice migración sin aplicar y sin llaves *(por verificar)*. No se puede dibujar sobre el video |
| **Mapi 3D** | `three` y `@react-three/fiber` instalados (pizarra 3D); `plan-mapi-3d-lemur-2026-11-14.md` con piloto B1 definido | No hay modelo 3D con esqueleto. Video generativo (Veo) ya se probó y falló en consistencia |
| **Móvil** | Capacitor 8 + PWA. La captura usa `getUserMedia` y `<input capture>` | Android no declara permiso de cámara ni micrófono; iOS no tiene el de micrófono |

## 4. Decisiones de diseño

**D-1. La ficha técnica vive en su propia tabla** *(cerrada, 2026-11-20)*. No se cuelga de ninguna de las tres
bibliotecas. Lleva un vínculo **opcional** a `training_exercises` para que la ficha aparezca junto al ejercicio de la
pizarra cuando exista uno equivalente.

**D-2. Cada correctivo guarda biblioteca de origen e id** *(cerrada, 2026-11-20)*. Un correctivo puede salir de
`training_exercises`, de `exercise_library` o de wger. Como son tres orígenes con tipos de id distintos, es una
referencia sin llave foránea: la integridad se valida en la RPC que escribe, y la lectura tolera un origen que ya no
existe.

**D-3. Mapi se anima con movimiento capturado, no con IA de video.** Un entrenador validado ejecuta el movimiento,
MediaPipe extrae los 33 puntos en 3D y esa secuencia se aplica al esqueleto de Mapi. La misma captura sirve de
referencia contra la que Body compara al deportista. No se guarda video. Riesgo: las proporciones de un lémur pueden
deformar la técnica; se prueba con un solo movimiento antes de comprometerse. Depende del piloto B1 del plan del lémur
y de sus decisiones abiertas (§8).

**D-4. Primero un movimiento completo de punta a punta, no una biblioteca ancha.** Candidato: saque o remate de vóley,
porque el analizador ya existe.

**D-5. La ficha es la pieza que une todo.** Los criterios medibles usan las mismas claves que emite el analizador
(p. ej. `elbow_angle_contact`). Cada error se ata a un criterio y cada correctivo a un error. Así Body nombra el error,
muestra la fase y propone el correctivo. La IA solo redacta sobre ese contenido.

**D-6. Fichas cortas.** Carmel usó 6 de 31 métricas. Una ficha arranca con pocos criterios por fase, los que el
entrenador validador considere imprescindibles.

## 5. Modelo de datos propuesto

Borrador para discutir. Convenciones del repo que aplican: `npm run migrations:new`, estados con `text + CHECK`, FKs
de negocio a `public.profiles(id)`, `search_path` fijo y `GRANT EXECUTE` explícito por RPC, helpers envueltos en
`(SELECT …)::uuid[]`, `FOR ALL` nunca sin `WITH CHECK`, una sola sesión aplicando migraciones.

### 5.1 Ficha técnica

| Tabla | Columnas clave | Notas |
|---|---|---|
| `technique_sheets` | `id`, `school_id` (NULL = ficha del sistema), `sport`, `name`, `level`, `analyzer_code` (opcional), `training_exercise_id` (opcional → `training_exercises`), `status` (`borrador` / `validada` / `archivada`), `source`, `validated_by` → `profiles`, `validated_at`, `created_by` → `profiles` | Mismo patrón de `training_exercises`: plantillas del sistema con `school_id` NULL |
| `technique_sheet_phases` | `sheet_id`, `position`, `name`, `description` | Aproximación, salto, contacto, caída |
| `technique_sheet_criteria` | `phase_id`, `metric_key` (clave del analizador, opcional), `label`, `min_value`, `max_value`, `unit` | Sin `metric_key` es un criterio que solo evalúa el ojo del entrenador |
| `technique_sheet_errors` | `criterion_id`, `name`, `explanation` | Error frecuente atado a un criterio |
| `technique_sheet_correctives` | `error_id`, `source_library` (`training_exercises` / `exercise_library` / `wger`), `source_id` (texto), `note`, `position` | D-2. `source_id` es texto porque wger usa enteros y las otras dos UUID |

- **Escritura por RPC transaccional.** Crear o editar una ficha toca cinco tablas; va en una RPC `SECURITY DEFINER`
  que valida el alcance del caller contra **esa** escuela y que el `source_id` exista cuando el origen es local.
- **RLS.** Lectura: fichas del sistema para cualquier autenticado; fichas de escuela con `user_school_ids()` y solo en
  estado `validada` para padres y atletas. Escritura: `user_staff_school_ids()`. Fichas del sistema: solo `service_role`.
- **Validación.** Solo una ficha `validada` se muestra al deportista y alimenta a Body. Quién puede validar es una
  decisión abierta (§8).

### 5.2 Bienestar diario

| Tabla | Columnas clave | Notas |
|---|---|---|
| `athlete_wellness_checkins` | `id`, `school_id`, `athlete_id`, `checkin_date`, `sleep_hours`, `sleep_quality`, `fatigue`, `muscle_soreness`, `stress`, `mood` (escalas 1–5), `note`, `submitted_by` → `profiles` | `UNIQUE (athlete_id, checkin_date)` |

- **Escritura por RPC `SECURITY DEFINER`**, igual que `submit_post_training_self_eval`: el acudiente responde por el
  menor y los padres no escriben tablas operativas por RLS.
- **Lectura:** el propio atleta, su acudiente y el personal de la escuela (`user_staff_school_ids()`).
- Es dato de salud de menores: no sale en vistas públicas ni en el informe compartido por enlace.
- *(decisión)* Tabla propia (recomendado: es autorregistro diario, mismo razonamiento que el spec de nutrición) o
  reutilizar `performance_entries` con un `context_type` nuevo.

## 6. Paso a paso

| Paso | Entregable | Piloto | Se apoya en |
|---|---|---|---|
| **0** | Verificación y saneamiento (detalle en §7) | Interno | Base viva |
| **1** | Modelo de ficha técnica (§5.1) con saque y remate cargados y firmados por un entrenador | Carmel | Analizador de vóley |
| **1B** | Registro de bienestar diario (§5.2): captura, recordatorio y vista del entrenador. **En paralelo al paso 1** | Besser | Patrón de la encuesta post-entreno |
| **2** | Pantalla de ficha: fases, errores, correctivos y botón «Analiza tu ejecución» | Carmel | Paso 1 |
| **3** | Resultado de Body leído contra la ficha, con historial del deportista junto a bienestar, RPE, carga y lesiones | Besser | Pasos 1, 1B y 2 |
| **4** | Prueba de Mapi 3D animado con una captura real | Carmel | Piloto B1 del plan del lémur |
| **5** | Correctivos que entran solos a la rutina | Besser | Constructor de rutinas |
| **6** | Segundo deporte (fútbol), aportes de entrenadores con atribución y contenido real en video | Ambos | Video subido (Bunny) y `G-IMAGEN` |

**Paso 1B, alcance.** Formulario de menos de un minuto para el atleta o su acudiente; un recordatorio diario que lee
el lote completo con `.in('id', ids)` (los tres BFF comparten la base: nada de una consulta por fila); vista del
entrenador por equipo con quién no respondió y quién marca fatiga o dolor alto. Las alertas automáticas y el cruce con
carga quedan para el paso 3. Tiene que estar en uso antes del arranque de la temporada 2027 de Besser
*(decisión: fecha exacta)*.

**Reparto.** Los pasos 1 y 1B tocan tablas distintas y se pueden construir a la vez, pero **las migraciones las aplica
una sola sesión**, en un solo lote, y `types.ts` se regenera una vez al final.

## 7. Paso 0 en detalle

Nada de esto cambia la base; son lecturas puntuales por nombre (`pg_policies`, `pg_proc`, `information_schema`), sin
`list_tables` ni `get_advisors`.

1. **Tablas de Body: existencia y versionado.** Confirmar que las ocho tablas existen, leer su definición real y
   escribir una migración nueva e idempotente que las deje versionadas en el repo.
2. **Tablas de Body: RLS por `school_id`.** Para cada una:
   - ¿Tiene columna `school_id` y RLS habilitado?
   - Listar **todas** sus policies (son permisivas y se suman con `OR`).
   - Comprobar que no hay `FOR ALL` sin `WITH CHECK`, ni escritura con `user_school_ids()`, ni helpers sin envolver.
   - Probar con sesiones simuladas que un entrenador de la escuela A no lee ni escribe capturas de la escuela B, y que
     `anon` no lee nada.
   - Correr `npm run seguridad:invariantes`.
   - Antecedente: `trainer/biomech.ts` ya tuvo rutas sin validar pertenencia (cerradas, ver ROADMAP). El BFF usa
     `service_role`, así que el RLS no lo cubre: revisar también que cada ruta filtre por `req.schoolId`.
   - **Tensión con el diseño original:** `BIOMECH_MODULE_ANALYSIS.md` define al atleta como dueño del dato
     (`athlete_id` + `biomech_access_grants`), no a la escuela. El aislamiento por `school_id` y la propiedad del
     atleta pueden convivir, pero hay que decidir qué pasa con el historial cuando el atleta cambia de escuela (§8).
3. **Video subido.** Confirmar si la migración `20261015171131` está viva y si existen las llaves de Bunny.
4. **Captura en la app instalada.** Probar Body en Android e iOS nativos; si falla, declarar los permisos de cámara.
5. **Rendimiento y bienestar.** Confirmar qué de `performance_entries` y de la encuesta post-entreno usa Besser hoy.

Salida del paso 0: una nota corta con lo que está vivo, lo que no, y la migración de versionado lista para revisión.

### 7.1 Resultado de BOD-0, lecturas de solo lectura (2026-11-23)

Hecho: puntos 1 y 2 (existencia, policies, grants y funciones de ayuda, por nombre), más `npm run seguridad:invariantes`. **Pendiente:** puntos 3 (video subido, aunque `pizarra-m6h-videos-subidos.md` ya dice aplicada), 4 (app nativa) y 5 (uso de Besser). La auditoría del BFF fue solo por búsqueda de patrones (`req.schoolId`, `athlete_id`), no ruta por ruta.

**Existe y está vivo.** Las 8 tablas existen con RLS activo. No hay ningún `CREATE TABLE` para ellas en `supabase/migrations` (deriva confirmada). Hay **45 capturas, todas de una sola escuela (Pibe Valderrama), la última del 2026-08-05**; ninguna con video guardado (`video_path` nulo, sin bucket) y 11 siguen en `pending`. Body nunca se usó en Carmel ni en Besser.

**Seguridad.** `seguridad:invariantes` no marca ninguna tabla de Body (sus 2 ALTA son de `event_delegation_payments`). Aun así, la lectura de policies deja cinco hallazgos:

| # | Hallazgo | Gravedad | Arreglo propuesto |
|---|---|---|---|
| 1 | `ban_coach_insert` solo exige `coach_id = auth.uid()`: **cualquier autenticado puede insertar una anotación en cualquier captura** de la que conozca el id, y el atleta la ve (`ban_athlete_read`) | Media: necesita el UUID de la captura | Exigir que la captura sea de un atleta con `biomech_access_grants` vigente o de un plan del propio entrenador |
| 2 | `anon` tiene INSERT/UPDATE/DELETE de tabla sobre `biomech_analyses`, `biomech_annotations`, `exercise_analyzers` y `exercise_analyzer_mappings`. Hoy lo frena RLS (no hay policy de escritura para ellos o `auth.uid()` es nulo), pero un grant es una segunda llave abierta | Baja | `REVOKE ALL` a `anon` en las ocho tablas; `anon` no tiene flujo público aquí |
| 3 | `auth.uid()` sin envolver y roles `{public}` en 8 policies (`ba_athlete_*`, `ban_*`, `bag_coach_read`, `sbe_athlete_read`) | Baja: rendimiento y rechazo del linter en migraciones futuras | Recrearlas con `(SELECT auth.uid())` y `TO authenticated` |
| 4 | Solo 2 de las 8 tablas tienen `school_id` (`biomech_captures`, `biomech_access_grants`). El aislamiento entre escuelas es **indirecto**: capturas → atleta → permiso con `school_id`. Es coherente con el diseño del atleta como dueño, pero obliga a decidir `D-BOD-4` | Informativa | Decisión de diseño, no un parche |
| 5 | `exercise_analyzers` y `exercise_analyzer_mappings` son legibles por cualquiera (`USING (true)`). Es catálogo de umbrales, sin datos personales | Baja | Aceptable; pasar a `TO authenticated` junto con el punto 3 |

**Migración propuesta (sin escribir todavía).** Una sola, idempotente, que (a) versione las 8 tablas tal como están en la base, (b) corrija los puntos 1 a 3 y 5, sin tocar datos. Antes de escribirla hay que sacar la definición real de columnas, llaves y la policy de `bc_coach_read` completa (la lectura quedó cortada a 260 caracteres). Por la regla del repo, plan antes de código: **no escribo la migración hasta tu visto bueno explícito**, y la aplicaría una sola sesión, pidiendo turno a `sportmaps-demo-f0`.

**Prueba que falta.** Verificar con sesiones simuladas (`set_config('request.jwt.claims', ...)`) que un entrenador de la escuela A no lee capturas de B, y probar el hallazgo 1 con un usuario sin relación. No las corrí: requieren dos usuarios reales y la regla del repo pide cuidado con la base compartida.

## 8. Decisiones abiertas

| # | Decisión | Bloquea |
|---|---|---|
| A1 | **Resuelta 2026-11-23 (recomendación aprobada por el usuario): remate y saque de vóley.** **Primer movimiento:** remate o saque de vóley (analizador listo) o algo de fútbol (más valor para Carmel y Santa Fe, sin analizador) | Paso 1 |
| A2 | **Quién firma las fichas** y qué rol puede validarlas (¿cualquier entrenador de la escuela, solo administración, o SportMaps para las del sistema?) | Paso 1 |
| A3 | **Resuelta 2026-11-23 (recomendación aprobada por el usuario): tabla propia `athlete_wellness_checkins`.** Quedan por definir las preguntas exactas de Besser y la fecha de arranque de su temporada 2027. **Bienestar diario:** tabla propia o `performance_entries`; qué preguntas exactas quiere Besser; fecha de arranque de la temporada 2027 | Paso 1B |
| A4 | **Historial de Body al cambiar de escuela:** ¿viaja con el atleta o se queda en la escuela? | Paso 0, punto 2 |
| A5 | **Mapi 3D** (heredadas del plan del lémur): pagar un mes de Meshy o Tripo; quién hace el arte en pose neutra; escribir o no al vendedor de ExerciseDB | Paso 4 |
| A6 | **Resuelta 2026-11-23 (propuesta aprobada por el usuario): el video de menores queda para `BOD-6`.** **Video de menores:** el contenido real guarda video y exige consentimiento del acudiente (`D-IMAGEN`). En Carmel es más difícil porque el club no comparte los datos de los padres. Propuesta: dejarlo para el paso 6 | Paso 6 |
| A7 | **Cobro:** ¿todo entra en el addon `biomech` existente, o la biblioteca y el bienestar van incluidos en el plan? | Paso 2 |

## 9. Qué se toma de cada referencia

- **Onform:** el deportista entra gratis si su entrenador o escuela paga; notas de voz sobre el video.
- **MotionCoach:** comparación lado a lado y en superposición; anotaciones fijadas a un fotograma.
- **Formanti:** el análisis termina en un plan semanal, no en un número.
- **MuscleWiki:** mapa corporal y filtros por equipo y nivel. Tiene API comercial de pago; wger ya está integrado.
- **Calor.IA:** nutrición por foto con corrección por texto. Fuera de alcance hasta cerrar el paso 5; cuando entre,
  se monta sobre `nutricion-atletas-independientes.md`.
- **ExRx:** contenido con derechos de autor; no se copia.

## 10. Fuera de alcance

- Diagnóstico clínico: una sola cámara da ±5–10° en ángulos articulares. Sirve para entrenar, no para decisiones médicas.
- Dibujar o medir sobre video subido (no existe hoy; se evalúa después del paso 6).
- Nutrición, wearables y coaching en vivo con pose en tiempo real.

## 11. Qué no se hace sin aprobación explícita

- Aplicar migraciones o importar datos.
- Pagar o suscribirse a herramientas externas.
- Guardar video de menores.
- Subir nada a `main`.
