# Ficha técnica global (hoja de vida deportiva) — spec (F0)

**Estado:** borrador para revisión · **Fecha:** 2026-11-26 · **Roadmap:** `PAR-1` (`docs/plan-paridad-y-v2-2026-11.md` §2)
**Fuente de verdad** de las fases F1–F7. Plan antes de código: ninguna migración se escribe antes de aprobar las decisiones de §9. El SQL final se escribe en F1 y se muestra antes de aplicarlo.
**Referencia aprobada:** PDF de Carmel, arquero, 2 páginas (§5.3).

---

## 1. Qué es y para quién

Una hoja de vida deportiva de cada deportista, **para cualquier deporte, posición y club**, con la marca del club. Se ve en la app y se exporta a un PDF de dos páginas. Junta en un solo lugar lo que hoy está disperso (número y posición del carnet, partidos y minutos, asistencia, mediciones, evaluaciones), y agrega lo que no existe: **atributos 0–100 por posición, «media», pruebas físicas con nivel y la evaluación firmada del cuerpo técnico**.

| Usuario | Qué hace |
|---|---|
| **Dueño / admin del club** | Activa la ficha, ajusta las plantillas de atributos y pesos de su club, ve todas las fichas, exporta PDF (uno o por categoría) para visorías y becas. |
| **Entrenador** | Evalúa a los deportistas de **sus equipos** cada periodo (sliders 0–100), registra pruebas físicas, escribe fortalezas, aspectos a mejorar y objetivos, y firma. |
| **Acudiente** | Ve la ficha **de su hijo** (solo evaluaciones firmadas), descarga el PDF y decide si la comparte fuera del club. |
| **Deportista** | Adulto: igual que el acudiente sobre la suya. Menor con cuenta: la ve; no comparte. |
| **Club / tercero (visoría, beca, universidad)** | Recibe un **enlace firmado que vence** o el PDF. Nunca ve contacto, documento ni datos médicos. |

**Qué NO es:**
- No es el **Informe Mensual** (`athlete_reports`). Ese tiene envío automático a familias; la ficha no se envía sola.
- No es la **ficha informativa de MOD-37** (Carmel, interna, por periodo, sin familias). Las dos comparten el armador de datos (§6.1), pero son productos distintos.
- No es la **«ficha técnica» de Body** (`BOD-1`, `technique_sheets`). Esa es la ficha de un gesto técnico (saque, remate). Ver D2: nombres distintos en código.

## 2. Lo que ya existe y se reutiliza (verificado en repo, 2026-11-26)

| Pieza | Dónde | Uso en la ficha |
|---|---|---|
| Identidad del club: escudo, principal, secundario y **acento** | `schools.logo_url`, `branding_settings.{primary,secondary,accent}_color` (mig. `20261126095105`, gratis para todos desde `20261126154553`); `frontend/src/lib/cards/clubIdentity.ts` (`resolverIdentidad`, `luminancia`, `razonContraste`); BFF `utils/schoolBrandingResolver.ts` | Encabezado, colores, contraste automático del texto. Sin configuración nueva. |
| **Número y posición** | `enrollments.jersey_number` y `enrollments.position` (carnet F1); respaldo `_carnet_numero_posicion()` (última alineación) | Número grande y posición de la página 1. |
| Zona de juego + mini cancha | `frontend/src/lib/cards/zonaDeJuego.ts` (texto libre → `arquero/defensa/medio/delantero` + lado), `components/cards/reversos/ReversoFutbol.tsx`, registro por deporte `lib/cards/reversos.ts` | Bloque «EN CANCHA». Se copia el patrón de registro por deporte. |
| Código y QR del carnet | `athlete_id_cards.codigo` (`SM-AAAA-NNNNN`) | Opcional en el pie del PDF (D14). |
| Partidos y minutos | `match_results`, `match_lineups`, `match_lineup_players` (`position_code`, `role`, `minutes_played`), `football_match_events` (`goal, own_goal, yellow, red, assist`), mig. `20260812182000`; partido en vivo `match_live_events` (`goal`, `goal_against`, `sub`…), mig. `20261105231602`; BFF `GET /school/football/season-stats` (`bff/src/routes/school/football.ts` l. ~701) con `%` de minutos de MOD-37 | Estadísticas de temporada de fútbol **sin doble captura**. |
| Duración del partido por categoría | `teams.default_match_minutes` (mig. `20261125190617`, **sin aplicar**) | Vallas invictas y % de minutos. |
| Acumulados de temporada (UI) | `frontend/src/components/school/FootballSeasonStats.tsx` | Mismos números en la ficha; no se recalcula distinto. |
| Métricas por deporte | `sport_metric_definitions` (122 métricas, 7 deportes; `higher_is_better`, `min/max`, `category` incl. `physical`), `performance_entries` (`subject_type/subject_id`, `metric_key`, `value`, `context_type`), `sport_metric_thresholds` (bandas verde/amarillo/rojo, **sin edad ni sexo**) | Resultados de pruebas físicas y mediciones. |
| Criterios propios del club | `school_metric_definitions` (MOD-37 los amplía con `item_kind`, `level_guide`) | No se usan para los atributos 0–100 (D4), pero comparten pantalla de Ajustes. |
| Mediciones corporales | `body_metrics` (`height_cm`, `weight_kg`, `measured_at`, `client_type/client_id`, `school_id`; lo lee `ChildProgressPage.tsx`) | Estatura y peso de respaldo (D9). No tiene envergadura. |
| Asistencia | `attendance_records`; % = (P + T) ÷ registros; motivo de excusa y días de lesión de MOD-37 (D12: no bajan el %); `card_back_data` ya calcula asistencia de 90 días | Bloque «Asistencia a entrenos». |
| Fecha de nacimiento y sexo | `children.date_of_birth`, `children.gender`; `profiles` para adultos | Edad, año de nacimiento y baremos. |
| Categoría | Equipo del deportista (`teams`; en Carmel la categoría **es** el equipo, «Categoría 2018-19») | Rótulo «2011-2013». |
| Foto | `children.avatar_url`; foto por periodo de MOD-37 (`athlete_sheet_periods.photo_path`, bucket privado, gate de autorización de imagen D16) | Foto de la página 1. |
| PDF en el servidor | `pdfkit` + `sharp` en el BFF; `bff/src/utils/athleteReportPdfV2.ts` (informe V2), `utils/radarPdf.ts` (`drawRadarChart`), `utils/reportPdfHelpers.ts` (`drawBrandHeader`, `fetchSchoolLogo`, `addFooterToAllPages`, `sectionTitle`), `routes/certificates.ts`, `services/constancias.ts` | Motor del PDF de 2 páginas (D11). |
| PDF/imagen en el cliente | `jspdf` + `html2canvas`: `lib/cards/cardExport.tsx`, `components/partido-vivo/informe/informePdf.ts` | No se usa para la ficha (D11). |
| Radar en la app | `frontend/src/components/school/PlayerCard.tsx` (recharts, normaliza por banda) | Radar de atributos (aquí los valores ya son 0–100: sin normalizar). |
| Enlace público por token | `verify_athlete_id_card_public(p_qr_token)` + `AthleteCardPublicPage.tsx` (`/c/:token`); diseño de `athlete_report_share_links` en `docs/specs/informe-atleta-link-publico.md` (**sin construir**) | Molde del enlace compartido (§7). |
| Pantallas V2 | `components/athlete/v2/AthleteProgressV2.tsx`, `components/parent/v2/hijos/*`, `components/coach/v2/CoachEvaluateV2.tsx`, `coach/v2/equipos/DeportistasTab.tsx` | Dónde se cuelga la ficha y el editor. |
| Perfil V1 | `components/athlete/AthleteProfileTabs.tsx` (pestaña «sport»: nivel, categoría de edad) | Solo lectura de referencia; la ficha no vive aquí. |

**Lo que falta y crea este spec:** catálogo de atributos por deporte y posición, evaluación periódica 0–100 con firma, «media», baremos por edad y sexo, historial anterior a SportMaps, atajadas y estadísticas de otros deportes, enlace compartido con consentimiento, y el PDF.

## 3. Decisiones previas que condicionan el diseño

- **Una sola Supabase para todo** y Disk IO limitado: nada corre por cron; la ficha se arma **al abrirla** con lecturas acotadas (`.in()` en tandas). El PDF se genera al vuelo, no se guarda (como el informe, D-G).
- Las categorías no son un catálogo confiable (`teams.age_group` NULL en Dynasty; deporte guardado por nombre visible «Fútbol», memoria `project_sports_catalog_tres_fuentes`). La ficha resuelve el deporte con `claveDeporte()` de `reversos.ts` (quita tildes) y la categoría con el equipo.
- Identidades duplicadas (`unregistered` + `child`) parten los datos (memoria `project_duplicate_athlete_identities`). La ficha usa el mismo eje polimórfico `subject_type + subject_id` que `performance_entries` y no lo arregla.

## 4. Modelo de datos (descripción; el DDL va en F1)

Reglas del repo para todo lo de abajo: estados con `text + CHECK` (nunca `CREATE TYPE`); FKs de negocio a `public.profiles(id)` (autor, firmante); sujeto polimórfico `subject_type IN ('profile','child','unregistered') + subject_id` sin FK (convención de `performance_entries`), validado dentro de la RPC que escribe; RLS activa en todas; **escritura solo por RPC** `SECURITY DEFINER` con `SET search_path = pg_catalog, public, pg_temp`; `GRANT EXECUTE … TO authenticated` explícito y `REVOKE` explícito de `PUBLIC, anon`; policies con `(SELECT auth.uid())` y `school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])`, `TO authenticated`; `FOR ALL` nunca sin `WITH CHECK` (mejor: sin policies de escritura). Migraciones con `npm run migrations:new -- <slug>`, una sola sesión aplica, `types.ts` se regenera una vez al final, y `npm run seguridad:invariantes` al cerrar cada fase.

Prefijo de tablas: `ficha_jugador_*` (D2).

### 4.1 Catálogo de deportes, posiciones y atributos

| Tabla | Para qué | Columnas clave |
|---|---|---|
| `ficha_jugador_posiciones` | Posiciones por deporte | `id`, `school_id` NULL = plantilla SportMaps, `sport_key` (slug sin tildes: `futbol`, `voleibol`, `baloncesto`, `natacion`, `generico`), `position_key`, `sigla` (≤ 4, ej. `POR`), `nombre` («Arquero»), `zona_key` (para el dibujo), `zona_texto` («Área chica y salida»), `lineup_code` (puente a `match_lineup_players.position_code`: `arquero/defensa/medio/delantero`), `orden`, `activo`. `UNIQUE (coalesce(school_id), sport_key, position_key)`. |
| `ficha_jugador_atributos` | Atributos 0–100 de cada posición | `id`, `school_id` NULL = plantilla, `sport_key`, `position_key`, `attr_key`, `nombre`, `descripcion` (qué mira el entrenador), `peso numeric CHECK (peso >= 0 AND peso <= 10)` (0 = no cuenta en la media), `orden`, `activo`. `UNIQUE (coalesce(school_id), sport_key, position_key, attr_key)`. Máximo 8 activos por posición (se valida en la RPC; el PDF tiene lugar para 8). |
| `ficha_jugador_estadisticas_def` | Las 4 estadísticas de temporada por deporte y posición | `sport_key`, `position_key` (o `*`), `stat_key`, `nombre`, `fuente` CHECK (`futbol_alineacion`, `futbol_eventos`, `futbol_vallas`, `partido_stats`, `competencias`, `asistencia`, `generico`), `orden 1–4`. Solo plantilla SportMaps en v1 (el club no las cambia: dependen de qué se captura). |

**Override por club:** el admin no edita la plantilla; al «ajustar» se **copia** la fila con su `school_id` y la ficha usa la del club si existe (misma idea que `school_metric_definitions` sobre el catálogo). Lectura del catálogo: `authenticated` (filas `school_id IS NULL`) y staff del club (las suyas).

**Plantillas iniciales (peso entre paréntesis; sin número = 1):**

| Deporte · posición | Atributos | 4 estadísticas de temporada |
|---|---|---|
| **Fútbol · POR Arquero** (zona: «Área chica y salida») | Reflejos (1,5), Juego aéreo, Mano a mano, Juego con pies, Saque y distribución, Ubicación (1,5) | Partidos, Minutos, Vallas invictas, Atajadas |
| **Fútbol · DEF Defensa** («Línea defensiva») | Marca (1,5), Anticipación, Juego aéreo, Salida con balón, Velocidad de recuperación, Lectura de juego (1,5) | Partidos, Minutos, Goles, Vallas invictas como titular |
| **Fútbol · MED Mediocampista** («Mitad de cancha») | Pase (1,5), Visión de juego (1,5), Control y conducción, Recuperación, Llegada al área, Resistencia | Partidos, Minutos, Asistencias, Goles |
| **Fútbol · DEL Delantero** («Área rival») | Definición (2), Desmarque, Regate, Cabeceo, Velocidad, Juego de espaldas | Partidos, Goles, Asistencias, Minutos |
| **Voleibol · ARM Armador, OPU Opuesto, CEN Central, PUN Punta, LIB Líbero** (zonas 1–6) | Mismos 6 para todas: Saque, Recepción, Ataque, Bloqueo, Defensa, Colocación. Pesos por posición: ARM colocación 2; OPU y PUN ataque 2; CEN bloqueo 2; **LIB ataque 0, bloqueo 0, saque 0**, recepción y defensa 2 | Partidos, Sets jugados, Puntos, Aces (LIB: Partidos, Sets, Recepciones positivas, Defensas) |
| **Baloncesto · BAS Base, ESC Escolta, ALE Alero, ALP Ala-pívot, PIV Pívot** | Manejo de balón, Pase y visión, Tiro exterior, Finalización cerca del aro, Rebote, Defensa. Pesos: BAS manejo y pase 2; ESC tiro exterior 2; PIV rebote y finalización 2 | Partidos, Minutos, Puntos, Rebotes (BAS: Asistencias en vez de Rebotes) |
| **Natación · LIB, ESP, PEC, MAR, COM** (la «posición» es el estilo; sin cancha: bloque «Especialidad») | Técnica de nado (1,5), Salida, Virajes, Ritmo de carrera, Resistencia aeróbica, Potencia | Competencias, Pruebas nadadas, Mejores marcas del año, Podios (fuente `competition_results`) |
| **Genérico · GEN** (cualquier otro deporte) | Técnica, Lectura de juego / táctica, Condición física, Coordinación, Actitud y disciplina, Trabajo en equipo | Asistencia %, Sesiones, Evaluaciones, Antigüedad (las mismas del reverso genérico del carnet, `card_back_data`) |

Fútbol sala (`futsal`) toma la plantilla de fútbol con zonas propias (arquero, cierre, ala, pívot) en F6; mientras tanto cae en genérico (mismo criterio que el carnet: no se extienden gates «solo fútbol» sin decisión).

### 4.2 Perfil deportivo del deportista en la ficha

`ficha_jugador_perfiles` — una fila por deportista y club.
- `school_id`, `subject_type`, `subject_id`, `UNIQUE (school_id, subject_type, subject_id)`.
- `sport_key`, `position_key` (FK lógica al catálogo, validada en la RPC), `position_key_2` opcional (segunda posición, solo se muestra).
- `lado_habil text CHECK IN ('derecho','izquierdo','ambos')` («pie hábil» en fútbol, «mano hábil» en el resto: el rótulo lo da el deporte).
- `visible_familia boolean DEFAULT true`, `media_visible_familia boolean` (D7).
- `consentimiento_compartir` (jsonb: `{ por: profile_id, en: timestamptz }` o NULL) — lo escribe solo el acudiente o el adulto (§7).
- `updated_by → profiles(id)`, `updated_at`.

**Número y posición mostrada:** el número sale de `enrollments.jersey_number` (lo que ya edita el personal para el carnet; no se duplica). La posición estructurada (`position_key`) vive aquí porque `enrollments.position` es texto libre; al crear el perfil se **propone** con `zonaDeJuego.ts` (o desde `lineup_code` de la última alineación) y el entrenador confirma con un toque. Si `enrollments.position` está vacío, la RPC lo rellena con el nombre de la posición elegida (una sola captura).

### 4.3 Evaluación del cuerpo técnico por periodo (con firma)

| Tabla | Para qué | Columnas clave |
|---|---|---|
| `ficha_jugador_evaluaciones` | Una evaluación de un deportista en un periodo | `id`, `school_id`, `team_id` (equipo desde el que se evaluó: define qué entrenador puede), `subject_type`, `subject_id`, `periodo_tipo CHECK IN ('trimestre','semestre','anual','libre')`, `periodo_inicio`, `periodo_fin`, `temporada smallint`, `sport_key`, `position_key` (congelada: la plantilla vigente al evaluar), `status CHECK IN ('borrador','firmada','anulada')`, `fortalezas text`, `a_mejorar text`, `objetivos text` (cada uno ≤ 600, CHECK), `media numeric(5,2)` y `media_detalle jsonb` (pesos usados) **congelados al firmar**, `version int` (control optimista), `created_by`, `updated_by → profiles(id)`, timestamps. `UNIQUE (school_id, subject_type, subject_id, periodo_tipo, periodo_inicio) WHERE status <> 'anulada'`. |
| `ficha_jugador_evaluacion_puntajes` | Nota por atributo | `evaluacion_id` (FK, `ON DELETE CASCADE`), `attr_key`, `nombre` y `peso` **copiados** al guardar (si mañana cambia la plantilla, la evaluación vieja no cambia), `puntaje smallint CHECK (0–100)` o `no_evaluado boolean` (CHECK de una sola forma). `PK (evaluacion_id, attr_key)`. |
| `ficha_jugador_evaluacion_firmas` | Quién firma | `evaluacion_id`, `firmante → profiles(id)`, `staff_id` (identidad del entrenador vía `school_staff.id`, como en `athlete_reports` — `useCoachStaffId`), `nombre_impreso`, `cargo` («Entrenador», «Preparador de arqueros»…), `firmado_en`. `PK (evaluacion_id, firmante)`. |

Reglas:
- **Firmar congela.** Una evaluación firmada no se edita; se corrige **anulándola** (con motivo, solo admin) y haciendo otra. La familia solo ve `firmada`.
- **Cosigna** cualquier staff con alcance; la primera firma pasa el estado a `firmada`. Los demás pueden firmar después (no cambia notas).
- Al firmar, la RPC copia los puntajes a `performance_entries` con `context_type = 'ficha'` (si el CHECK de `context_type` no lo admite, F1 lo amplía en la misma migración) para que la evolución del deportista y PAR-7 lean una sola serie (mismo criterio que MOD-37 D5).

### 4.4 La «media»

- **Fórmula:** `media = round( Σ(puntaje_i × peso_i) ÷ Σ(peso_i) )` sobre los atributos con puntaje y peso > 0 de la **última evaluación firmada**. Entero 0–100.
- **Mínimo para mostrarla:** ≥ 4 atributos con puntaje y ≥ 2/3 del peso total cubierto. Si no, «—» y «Evaluación incompleta».
- **Pesos configurables:** por plantilla y, si el club ajusta, por club (§4.1). La media guardada al firmar usa los pesos de ese momento (`media_detalle`); cambiar pesos no reescribe el pasado.
- **Evolución T1–T4:** por trimestre de la temporada, la media de la **última evaluación firmada que cae en ese trimestre**; trimestre sin evaluación = punto vacío (no se interpola). Temporada = año calendario salvo que el club fije mes de inicio (D8).
- La media se calcula en **un solo lugar** (función SQL `ficha_jugador_calcular_media(evaluacion_id)`, interna, sin `EXECUTE` para `authenticated`) y la reusa la RPC de firma; el frontend nunca la calcula para guardarla (sí puede previsualizarla con la misma fórmula en `lib/ficha/media.ts`, con test que compare).

### 4.5 Estadísticas de temporada (sin doble captura)

Se **leen**, no se escriben, salvo lo que hoy no tiene dónde guardarse:

| Estadística | Fuente |
|---|---|
| Partidos, minutos, goles, asistencias, tarjetas (fútbol) | Lo mismo que `season-stats`: `match_lineup_players` + `football_match_events`; si el partido fue en vivo, `match_live_events`. Se extrae a un servicio compartido para que la ficha y `FootballSeasonStats` den el mismo número. |
| **Vallas invictas** (arquero) | Calculada: partidos donde fue arquero (`position_code = 'arquero'`), jugó ≥ 75 % de la duración (`teams.default_match_minutes` o `live_periods_count × live_period_minutes`) y el equipo recibió 0 goles (`match_results` o eventos `goal_against`). Defensa: igual, como titular. (D10) |
| **Atajadas** | **No existe hoy.** Nueva columna `match_lineup_players.saves smallint CHECK (>= 0)`, capturada en el paso «Evaluar» del formulario de partido que ya existe (solo aparece para el arquero). En el partido en vivo, evento nuevo `save` en `match_live_events` (F6). Si un partido tiene ambos, manda el vivo. |
| Voleibol y baloncesto (puntos, aces, sets, rebotes…) | **No existe hoy.** Tabla genérica `partido_jugador_estadisticas (source_type, source_id, subject_type, subject_id, stat_key, valor)` con `UNIQUE (source_type, source_id, subject_type, subject_id, stat_key)`, capturada en el mismo paso «Evaluar» del partido según el deporte del equipo (F6). Escritura por la RPC de partido que ya guarda alineación y eventos juntos. |
| Natación | `competition_results` (tiempo, posición) — ya existe. |
| Genérico | Asistencia y sesiones como `card_back_data`. |

Registro por deporte en el código: `frontend/src/lib/ficha/estadisticas.ts` y su gemelo en el BFF, con la misma forma que `lib/cards/reversos.ts` (agregar un deporte = agregar una entrada). El carnet F4 y la ficha leen **el mismo** servicio de estadísticas (las 4 del reverso del carnet de fútbol = las 4 de la ficha).

### 4.6 Pruebas físicas y baremos

- **Resultados:** en `performance_entries` (no tabla nueva), con métricas `category = 'physical'` de `sport_metric_definitions`. F1 siembra las que falten, por deporte, con `higher_is_better`, unidad y rango: `velocidad_30m` (s, menor es mejor), `salto_vertical_cmj` (cm), `agilidad_t_test` (s, menor es mejor), `yoyo_ir1` (m). Más las antropométricas `estatura_cm`, `peso_kg`, `envergadura_cm` (D9).
- **Captura:** RPC `ficha_jugador_guardar_pruebas(p_school_id, p_fecha, p_filas jsonb)` — lote de un equipo en **una** transacción (regla multi-fila), con `context_type = 'prueba_fisica'`.
- **Baremos:** tabla nueva `ficha_jugador_baremos`: `school_id` NULL = referencia SportMaps, `metric_key`, `sexo CHECK IN ('M','F','todos')`, `edad_min`, `edad_max`, `corte_medio`, `corte_bueno`, `corte_excelente` (numéricos; la dirección la da `higher_is_better` de la métrica), `fuente text` (cita), `UNIQUE (coalesce(school_id), metric_key, sexo, edad_min)`. Niveles: **Bajo · Medio · Bueno · Excelente**. Edad = edad cumplida a la fecha de la prueba.
- **Por qué no `sport_metric_thresholds`:** no tiene edad ni sexo, y sus colores verde/ámbar/rojo están **reservados** al semáforo (regla de color de la memoria `project_performance_metrics_model`). Los niveles de la ficha se pintan con la escala del acento del club, no con semáforo.
- Sin baremo para la edad/sexo del deportista: se muestra el resultado sin nivel («sin referencia para su edad»). Nunca se inventa.

### 4.7 Historial por año

- **Automático (con SportMaps):** por año, el equipo/categoría de su inscripción (`enrollments` con fechas), partidos jugados y rol: «Titular · 18 PJ» solo si la mayoría de sus partidos tienen alineación confiable (partido en vivo); si no, «Convocado · 18 PJ» (misma cautela de MOD-37 §2.3: la convocatoria normal guarda a todos como titulares).
- **Anterior a SportMaps:** tabla `ficha_jugador_historial_manual` (`school_id`, sujeto, `anio smallint`, `club_nombre`, `categoria`, `rol`, `partidos smallint NULL`, `nota ≤ 200`, `registrado_por → profiles`). La escribe el staff con alcance; se marca «declarado por el club» en la ficha.

### 4.8 RLS (solo SELECT; nadie escribe directo)

| Tabla | Lee |
|---|---|
| Catálogo (`posiciones`, `atributos`, `estadisticas_def`, `baremos`) | `school_id IS NULL` → `authenticated`. Filas del club → `user_staff_school_ids()`. |
| `ficha_jugador_perfiles` | Admin del club (`user_admin_school_ids()`), entrenador de un equipo del deportista (`coach_team_ids()` vía inscripción activa, con helper `SECURITY DEFINER` para no recorrer `enrollments` en la policy), acudiente (`is_parent_of_child(subject_id)` si `subject_type='child'`), el adulto (`subject_id = (SELECT auth.uid())`). |
| `evaluaciones`, `puntajes`, `firmas` | Igual que perfiles, **pero la familia y el deportista solo `status = 'firmada'`** y solo si `visible_familia`. Los puntajes/firmas heredan el filtro por la evaluación (helper `SECURITY DEFINER`, sin self-recursion). |
| `historial_manual` | Igual que perfiles. |
| `enlaces` (§7) | **Ninguna policy** (deny-all); todo por RPC. |

- **Nunca `user_school_ids()` para escribir** (incluye padres y atletas, invariante I2). Las RPC de escritura validan **adentro** que el caller sea admin de **esa** escuela o entrenador de **ese** equipo del deportista (`team_id` de la evaluación), y el flag `ficha_tecnica_enabled` del club.
- Helpers que use una policy: `GRANT EXECUTE … TO authenticated`. Helpers solo internos: `REVOKE ALL … FROM PUBLIC, anon, authenticated`.
- `anon`: sin `SELECT` en ninguna tabla; solo `EXECUTE` en `ficha_jugador_compartida(p_token)` (§7).
- Antes de aplicar: listar **todas** las policies de cada tabla tocada (`pg_policies`), incluida `match_lineup_players` (la columna `saves` no cambia sus policies, pero se revisa que la familia no lea las atajadas de otros jugadores más allá de lo que ya lee).

### 4.9 RPCs (todas con `search_path` fijo, `GRANT EXECUTE TO authenticated`, `REVOKE` de `PUBLIC, anon`)

| RPC | Qué hace |
|---|---|
| `ficha_jugador_guardar_perfil(p_subject_type, p_subject_id, p_school_id, p_datos jsonb)` | Posición, lado hábil, visibilidad. Admin o entrenador del equipo. |
| `ficha_jugador_guardar_evaluacion(p_payload jsonb)` | **Transaccional:** cabecera + todos los puntajes en una transacción. Crea o actualiza borrador; `SELECT … FOR UPDATE` sobre la fila y compara `version` (si no coincide: error `version_conflict`, el cliente recarga). Valida atributos contra la plantilla vigente, rango 0–100, máximo 8, largo de textos. Idempotente por `(sujeto, periodo)`: `INSERT … ON CONFLICT` sobre el índice único. |
| `ficha_jugador_firmar(p_evaluacion_id, p_version, p_cargo)` | `FOR UPDATE`; calcula y congela la media; inserta la firma (`ON CONFLICT DO NOTHING`); copia a `performance_entries`. |
| `ficha_jugador_anular(p_evaluacion_id, p_motivo)` | Solo admin. |
| `ficha_jugador_guardar_pruebas(...)` | §4.6, lote en una transacción. |
| `ficha_jugador_guardar_historial(...)` / `..._borrar_historial(...)` | §4.7. |
| `ficha_jugador_ajustar_plantilla(p_school_id, p_sport_key, p_position_key, p_atributos jsonb)` | Copia la plantilla al club y guarda nombres/pesos en una transacción. Solo admin (`user_admin_school_ids()`). |
| `ficha_jugador_crear_enlace(...)`, `..._revocar_enlace(...)`, `ficha_jugador_compartida(p_token)` | §7. La última es la única con `GRANT TO anon`. |
| `ficha_jugador_puede_ver(p_subject_type, p_subject_id, p_school_id)` | La usa el BFF antes de leer con `service_role` (§6.1). Devuelve el nivel (`admin`, `coach`, `familia`, `ninguno`). |

**Flag:** `school_settings.ficha_tecnica_enabled boolean DEFAULT false`, expuesto en `v_school_entitlements` → `useEntitlements().fichaTecnicaEnabled`.

## 5. Pantallas (V2, celular primero)

Criterios V2: 2–3 toques, vocabulario V2, sin tablas anchas en el celular. Se dibujan en el lienzo antes de construir (como pide la definición V2).

### 5.1 Ficha en la app (los cuatro roles, un solo componente)

`frontend/src/components/ficha/FichaTecnica.tsx`, con modo `familia | entrenador | admin`. Dos pestañas que espejan las dos páginas del PDF: **«Ficha»** y **«Informe técnico»**.
- **Deportista:** en `AthleteProgressV2.tsx` («Progreso») una tarjeta «Mi ficha técnica» con media y posición → abre la ficha.
- **Acudiente:** en la ficha del hijo (`parent/v2/hijos`), pestaña «Ficha técnica». Botones «Descargar PDF» y «Compartir» (§7).
- **Entrenador:** desde `coach/v2/equipos/DeportistasTab.tsx` (toque en el deportista) y desde la tarjeta de pendientes «Evaluar ficha · Sub-13 · 0 de 19» (`BandaPendientes.tsx`).
- **Admin:** desde la ficha del deportista y una vista por categoría que recorre a todos; «PDF de la categoría» (un deportista por par de páginas).
- **Estados vacíos honestos:** sin evaluación firmada → atributos y media «Sin evaluar todavía» (la familia ve la ficha con datos de partidos y asistencia, sin números de evaluación); sin partidos → la temporada muestra solo lo que hay.

### 5.2 Editor de evaluación del entrenador (rápido)

En `CoachEvaluateV2.tsx` como un modo nuevo «Ficha técnica»:
- Elige equipo y periodo (el trimestre en curso viene marcado). Lista «0 de 19» con un deportista a la vez, foto, número y posición (si falta la posición: chip para elegirla, una vez).
- **Sliders 0–100** por atributo con pasos de 5, número grande al lado, y la descripción del atributo en una línea. Arrastrar o tocar ±5.
- **«Copiar del periodo anterior»:** precarga los puntajes y textos de la última evaluación firmada (marcados como copiados hasta que se toquen). Es lo que hace viable evaluar 19 deportistas en un rato.
- Fortalezas, a mejorar y objetivos: tres cajas cortas con sugerencias de frases (sin IA en v1; PAR-6 puede redactarlas después con confirmación).
- Media en vivo (previsualización con `lib/ficha/media.ts`).
- Guardado automático como borrador (debounce, y en cola sin señal reutilizando el patrón de `colaAsistencia.ts`); «Firmar» por deportista o «Firmar todos los completos».
- **Pruebas físicas:** pantalla de lote por equipo (una fila por deportista, columnas por prueba), muestra el nivel al escribir.

### 5.3 PDF de 2 páginas idéntico a la referencia

Generado en el BFF con `pdfkit` (D11): `GET /api/v1/fichas/:subject_type/:subject_id/pdf?evaluacion=<id>`, y `GET /api/v1/public/fichas/:token/pdf` para el enlace. Tamaño carta, vertical.

**Página 1 — «FICHA TÉCNICA · Temporada 2026»**
- Banda superior con color principal y escudo (`fetchSchoolLogo`; sin escudo: escudo por defecto con iniciales, mismo generador del carnet, rasterizado con `sharp`).
- Foto del jugador (o iniciales), **número** grande en contorno con acento, **categoría** («2011-2013»), **nombre y apellido**, **posición con sigla** («POR · Arquero»), **media** en círculo de acento («76»).
- **Datos del jugador:** pie/mano hábil, edad, nacimiento, estatura, peso, envergadura (solo deportes donde la plantilla lo pide: arquero, voleibol, baloncesto, natación). Lo que no hay se omite (no «—» en fila).
- **ATRIBUTOS** 0–100: barras horizontales con el número.
- **EN CANCHA:** mini cancha del deporte con la zona sombreada y `zona_texto` («Área chica y salida»). Natación: «Especialidad». Genérico: se omite el bloque y se amplían atributos.
- **TEMPORADA 2026:** las 4 estadísticas de la posición.
- **Entrenadores:** nombres de los firmantes.
- **Lema del club** («Respeto · Responsabilidad · Diversión»): campo nuevo `schools.branding_settings.lema` (≤ 80), editable en «Identidad del club» (`BrandingSettingsForm.tsx`, ya con acento y escudo). Sin lema, la línea no sale.
- Pie: «Ficha generada con SportMaps · Página 1 de 2» (siempre, también con marca propia: memoria `feedback_powered_by_sportmaps_sin_marca_blanca`).

**Página 2 — «INFORME TÉCNICO»**
- **Radar de atributos** (`radarPdf.ts`, con rótulo por eje porque son ≤ 8; los valores ya son 0–100).
- **Evolución de la media** T1–T4 (línea simple con primitivas).
- **Asistencia a entrenos** (% de la temporada, con días de lesión fuera del denominador sin decir por qué).
- **Pruebas físicas:** prueba · resultado · nivel (Bajo/Medio/Bueno/Excelente).
- **Historial por año:** año · categoría · rol · PJ.
- **Evaluación del cuerpo técnico:** fortalezas, a mejorar, objetivos del semestre.
- **Firmas** de los entrenadores (nombre impreso, cargo, línea) y **fecha de evaluación**. Pie «Página 2 de 2».

**Colores:** principal, secundario y **acento** del carnet 3D; texto blanco o casi negro según `luminancia` (portar `clubIdentity.ts` al BFF o compartir el cálculo). Contraste < 3:1 → el acento cae al texto oscuro.

**Modo «datos de ejemplo»:** un deportista ficticio por deporte (fixture en el código, no en la base) para la vista previa del admin en «Identidad del club» y para ventas/demos. Marca de agua «EJEMPLO» en cada página; nunca mezcla datos reales. Es también la prueba visual de regresión del PDF.

## 6. Lectura, rendimiento y PDF

### 6.1 Armador de datos

Servicio del BFF `bff/src/services/ficha-jugador.service.ts`, único para la ficha, el PDF y el enlace compartido (y la base sobre la que se recomienda construir la ficha informativa de MOD-37 F4, para no tener dos armadores de asistencia y partidos). Flujo: `ficha_jugador_puede_ver()` → lecturas acotadas por deportista y temporada con `.in()` en tandas → objeto `FichaJugador` tipado, compartido con el frontend. El PDF de categoría arma todos los deportistas con **una** lectura por tabla, no una por deportista (nada de N+1). Sin jobs.

### 6.2 Disk IO

Solo al abrir la pantalla o pedir el PDF. Sin vistas materializadas ni cron. Tope de 40 deportistas por PDF de categoría.

## 7. Privacidad y compartir fuera del club

**Lo que nunca sale en la ficha (app, PDF ni enlace):** documento de identidad, RH, EPS, contacto de emergencia, teléfono, correo, dirección, nombre del acudiente, lesiones y cualquier dato de `health_records` / `clinical_*` / `athlete_injuries` / `athlete_injury_log`, pagos y estado de habilitación. El armador trabaja con **lista blanca** de campos y un test lo afirma.

**Datos que sí, con cuidado:** estatura, peso y envergadura son datos deportivos, no médicos; se muestran en la app al staff y a la familia. En el enlace compartido, el **peso** sale solo si la familia lo deja encendido al compartir (apagado por defecto, D12). **Nacimiento:** en la app, fecha completa; en el enlace, solo el año y la edad.

**Foto:** la del perfil o la del periodo (MOD-37). En el enlace compartido, solo si el club marcó la autorización de imagen (D16 de MOD-37 / `G-IMAGEN`) **y** la familia la deja encendida; si no, iniciales.

**Enlace compartido (consentimiento):**
- Tabla `ficha_jugador_enlaces`: `id`, `token_hash` (se guarda el hash; el token solo se muestra una vez), `school_id`, sujeto, `evaluacion_id` (la firmada que se comparte), `snapshot jsonb` (la ficha **congelada** al crear: lo que la familia aprobó es lo que ve el tercero), `opciones jsonb` (peso, foto), `creado_por → profiles`, `creado_en`, `vence_en` (por defecto 30 días, máximo 90, CHECK), `revocado_en`, `vistas int`. RLS activa **sin policies**.
- **Quién crea:** el acudiente (menor) o el deportista adulto. El admin puede crear solo si la familia encendió «Permitir que el club comparta mi ficha» (`ficha_jugador_perfiles.consentimiento_compartir`, con quién y cuándo, escrito solo por la familia). El entrenador no crea enlaces.
- `ficha_jugador_compartida(p_token)` (`anon`): compara el hash, rechaza vencido o revocado con la misma respuesta que «no existe», suma una vista y devuelve el snapshot. Página pública `/f/:token` fuera de `ProtectedRoute`, como `/c/:token`; botón «Descargar PDF».
- La familia ve sus enlaces activos, cuántas vistas tienen, y los revoca con un toque.
- El PDF descargado por la familia lleva en el pie «Compartida por la familia el …» cuando sale del enlace.

## 8. Fases (full-stack de corrido en `develop`; revisión entre fases)

| Fase | Qué | Criterio de salida | Pruebas |
|---|---|---|---|
| **F0** | Este spec | Decisiones de §9 cerradas | — |
| **F1 · Modelo** | Una migración: catálogo + plantillas sembradas (fútbol ×4, voleibol ×5, baloncesto ×5, natación ×5, genérico), perfiles, evaluaciones/puntajes/firmas, baremos de referencia, historial manual, `match_lineup_players.saves`, ampliación de `context_type` si hace falta, métricas físicas faltantes, `lema` en `update_school_branding`, flag + entitlements, RPCs de §4.9 (sin las de enlace). **Depende de** `20261125190617` aplicada (duración por categoría). | Aplicada por una sola sesión; `seguridad:invariantes` sin críticas; `pg_policies` listado de cada tabla; `types.ts` regenerado una vez | **RLS con sesiones simuladas** (`request.jwt.claims`) en transacción abortada: entrenador del equipo A no lee ni escribe un deportista del B; admin de otra escuela → error; acudiente lee solo su hijo y **solo firmadas**; deportista adulto lee la suya; padre/atleta no escriben aunque estén en `user_school_ids`; `anon` 0 filas en todas; flag apagado → error. **Concurrencia:** dos guardados con la misma `version` → uno gana, el otro `version_conflict`, sin pérdida; dos creaciones del mismo periodo → una fila; doble firma → una fila; lote de pruebas que falla a mitad → nada escrito. Media: casos con pesos 0, incompleta, redondeo. |
| **F2 · Ficha en la app (lectura)** | `ficha-jugador.service.ts` + `GET /fichas/:subject`, servicio de estadísticas compartido con `season-stats` y el carnet, vallas invictas, historial automático, `FichaTecnica.tsx` en los 4 roles | La ficha de un arquero de Carmel muestra datos reales; los números de temporada = `FootballSeasonStats` | Unitarias del armador (lista blanca de campos), vallas invictas (completo, 75 %, gol en contra), igualdad con `season-stats`, estados vacíos; Playwright del acudiente viendo solo su hijo |
| **F3 · Editor del entrenador** | Modo «Ficha técnica» en `CoachEvaluateV2`, sliders, copiar del periodo anterior, firma, pendiente en `BandaPendientes`, lote de pruebas físicas con nivel, historial manual, ajuste de plantilla del admin | Un entrenador evalúa y firma 19 deportistas en < 15 min con «copiar» | Unitarias de `media.ts` = SQL; cola sin señal; conflicto de versión en la UI; Playwright: admin ajusta pesos → entrenador evalúa → familia ve firmada |
| **F4 · PDF** | PDF de 2 páginas, PDF por categoría, «datos de ejemplo», lema en Identidad del club | El PDF del arquero de ejemplo coincide con la referencia aprobada (revisión visual) | Snapshot visual del PDF de ejemplo por deporte (fútbol, voleibol, natación, genérico); contraste con colores claros y oscuros; sin escudo; acentos y ñ |
| **F5 · Compartir** | Enlaces, consentimiento de la familia, `/f/:token`, PDF público, lista y revocación | Una familia comparte, el tercero abre sin sesión, la familia revoca y el enlace muere | RPC como `anon`: válido, vencido, revocado, token inventado (misma respuesta); admin sin consentimiento → error; payload sin claves de contacto/documento/salud (test de lista blanca); conteo de vistas concurrente |
| **F6 · Otros deportes** | `partido_jugador_estadisticas` + captura en «Evaluar» por deporte (voleibol, baloncesto), evento `save` en partido en vivo, natación desde `competition_results`, plantilla de futsal | Una ficha de voleibol de Dynasty/Monster muestra sus 4 estadísticas | Igual que F1 para la tabla nueva (RLS + concurrencia de la RPC de partido) |
| **F7 · Integraciones** | **PAR-7 Talento:** lee la serie de medias (`performance_entries` `context_type='ficha'`) y los niveles de baremo; la ficha es su base y su vista de detalle. **VID-4:** bloque «Video» con clips del deportista en la ficha y en el enlace, solo con D-IMAGEN resuelto; el PDF lleva un QR al enlace en vez de video. | Según los specs de PAR-7 y VID | Las de esos specs; el enlace con video exige consentimiento de imagen |

**Orden de despliegue de cada fase:** migración → BFF → frontend, detrás de `ficha_tecnica_enabled`. Piloto: **Carmel** (pidió el ejemplo; ya tiene marca y MOD-37) y una escuela de voleibol en F6.

## 9. Decisiones (con recomendación)

- **D1. Alcance.** Una ficha por deportista **por club** (si cambia de club, la nueva empieza vacía; el historial anterior se declara a mano). Recomendación: **sí**; portar fichas entre clubes es otra conversación de consentimiento.
- **D2. Nombre.** En pantalla «Ficha técnica»; en código y tablas `ficha_jugador_*` para no chocar con la ficha técnica de Body (`technique_sheets`, `BOD-1`). Recomendación: **sí**.
- **D3. Escala.** 0–100 en pasos de 5 para todos. Recomendación: **sí**; en categorías infantiles la familia ve palabras además del número (D7).
- **D4. ¿Atributos sobre `school_metric_definitions` (MOD-37)?** No: aquellos son ítems por etapa con escalas 1–5/1–10; estos son por posición, 0–100 y con peso. Comparten Ajustes y el armador, no la tabla. Recomendación: **tablas propias**.
- **D5. Periodicidad.** Evaluación **trimestral** por defecto (da T1–T4); el club puede usar semestral. Recomendación: **trimestral**.
- **D6. Plantillas editables por el club.** El admin cambia nombres y pesos y puede apagar o agregar atributos (máx. 8) copiando la plantilla. Recomendación: **sí**, solo admin.
- **D7. ¿La familia ve números?** Ve la ficha después de la primera evaluación firmada. En menores de 10 años la media se oculta por defecto a la familia (el club puede encenderla). Recomendación: **sí**, por la regla del informe de no presionar en deporte formativo.
- **D8. Temporada.** Año calendario; el club puede fijar el mes de inicio. Recomendación: **sí**.
- **D9. Estatura, peso y envergadura.** Se capturan con las pruebas físicas en `performance_entries`; si no hay, se usa la última de `body_metrics`. Recomendación: **sí** (una sola vía de captura para el staff).
- **D10. Valla invicta.** Arquero que jugó ≥ 75 % del partido y el equipo recibió 0 goles. Recomendación: **sí**.
- **D11. PDF en el servidor (`pdfkit`)**, no `html2canvas`: texto vectorial, mismo resultado desde la app y desde el enlace, y reutiliza el informe V2 y el radar. Recomendación: **BFF**.
- **D12. Enlace compartido.** Lo crea la familia (o el admin con su consentimiento); vence a los 30 días (máx. 90); snapshot congelado; peso apagado y nacimiento solo año por defecto. Recomendación: **sí**.
- **D13. Firma.** Registro de quién y cuándo + nombre impreso y línea en el PDF; sin firma manuscrita escaneada en v1. Recomendación: **sí**.
- **D14. Código del carnet en el PDF.** Mostrar `SM-AAAA-NNNNN` como prueba de autenticidad (se verifica en `/c`). Recomendación: **sí, pequeño, en el pie**.
- **D15. Atajadas.** Columna en la alineación capturada en «Evaluar», y evento en vivo después. Recomendación: **sí**.

## 10. Riesgos

| Riesgo | Mitigación |
|---|---|
| **Adopción del entrenador** (6 atributos × 19 deportistas × 4 trimestres): si no evalúa, la ficha queda vacía | «Copiar del periodo anterior», pendiente visible, lote por equipo, meta de < 15 min por equipo (criterio de F3). La ficha muestra igual partidos y asistencia. |
| **Medias infladas** o sin criterio común entre entrenadores | Descripción por atributo, pesos del club, y en PAR-7 comparar solo dentro del club. |
| **Baremos sin fuente confiable** para menores latinoamericanos | Sembrar referencia con cita (`fuente`), marcada como orientativa; el club puede ajustar los suyos. |
| Posición en texto libre inconsistente | `position_key` estructurada con propuesta automática y confirmación del entrenador. |
| Deportista en dos equipos | La evaluación lleva `team_id`; cualquiera de sus entrenadores puede evaluar; la ficha muestra la última firmada. |
| Identidades duplicadas parten partidos y asistencia | Fuera de alcance; la ficha muestra lo que encuentra por sujeto. |
| Migración de MOD-37 `20261125190617` sin aplicar | F1 depende de ella; se aplica antes en el mismo turno de DDL. |
| Exposición de menores en el enlace | Lista blanca, snapshot, vencimiento, revocación, foto y peso apagables, sin contacto. |
| Colisión de nombre con Body | D2. |

## 11. Preguntas abiertas para ti

1. **Plan:** ¿la ficha (app + PDF + enlace) va **incluida en todos los planes** como el carnet 3D, o el PDF/enlace es parte de un plan superior? Recomendación: incluida (es un ítem de paridad).
2. **Baremos:** ¿hay una tabla de referencia que use algún club (Carmel, Besser) o sembramos referencias publicadas y que cada club ajuste?
3. **Edad para ocultar la media a la familia** (propuesta: menores de 10). ¿Otra edad, o nunca ocultarla?
4. **¿El acudiente puede pedir al club que no muestre la ficha a su hijo menor?** (propuesta: no; `visible_familia` lo maneja el club).
5. **Plantillas de voleibol y baloncesto:** ¿las revisa un entrenador de Dynasty/Monster antes de sembrarlas, como se hizo con los rótulos de voleibol del informe?
6. **Piloto:** ¿Carmel primero (arquero del ejemplo), aunque hoy tenga 6 partidos sin alineación? Sin alineaciones la temporada saldrá casi vacía hasta que usen el formulario de partido completo.
7. **Firma manuscrita:** ¿algún club la exige para becas (imagen de la firma del entrenador)? Si sí, entra en F4 con subida privada.

### Respuestas del usuario (2026-11-26): se aceptan todas las recomendaciones

1. **Plan:** la ficha (app, PDF y enlace) va **incluida en todos los planes**.
2. **Baremos:** se siembran referencias publicadas por edad y sexo, y cada club puede ajustarlas.
3. **Media oculta a la familia** para **menores de 10 años**.
4. **El acudiente no puede pedir que se oculte la ficha.** Lo maneja el club con `visible_familia`.
5. **Plantillas de voleibol y baloncesto:** las revisa un entrenador de Dynasty o Monster **antes de sembrarlas**.
6. **Piloto:** **Carmel primero**, con fútbol y el arquero del ejemplo. Se le pide usar el formulario de partido completo para que la temporada tenga datos.
7. **Firma manuscrita:** no entra por ahora. Si un club la exige para becas, se agrega en F4 con subida privada.
