# Spec: neuroentrenamiento con pruebas cognitivas propias (PAR-8)

**Estado:** plan para aprobación (2026-11-26). Sin código, sin migraciones y sin consultas a la base.
**Origen:** `docs/plan-paridad-y-v2-2026-11.md`, PAR-8 y decisión **D-NEURO-1 → construir pruebas propias**
dentro de la app (no integrar un tercero).
**Depende de y alimenta a:**
- `docs/specs/ficha-tecnica-global.md` (PAR-1): ficha técnica con atributos 0–100, «media», pruebas físicas e historial. Se estaba escribiendo en paralelo.
- `docs/specs/talento-deportivo.md` (PAR-7), que usa estas pruebas como un criterio más.
- `docs/specs/body-biblioteca-tecnicas-y-rendimiento.md`: bienestar diario BOD-1B y `athlete_wellness_checkins`.
- `docs/specs/modo-offline-y-sincronizacion.md`.
- `docs/specs/pizarra-multideporte-3d-ia.md`: la pizarra táctica y sus jugadas.

> Convenciones que aplican (de `CLAUDE.md`):
> - Migraciones con `npm run migrations:new`.
> - Estados con `text + CHECK`.
> - FKs de negocio a `profiles`.
> - `search_path` fijo y `GRANT EXECUTE` explícito por RPC.
> - Helpers RLS envueltos `(SELECT …)::uuid[]`.
> - `FOR ALL` nunca sin `WITH CHECK`.
> - Una sola sesión aplica migraciones.
> - Nada de N+1 en jobs.

---

## 1. Objetivo y lo que NO es

**Objetivo.** El entrenador mide en el celular o la tableta del club cinco capacidades cognitivas con relevancia
deportiva:
- reacción;
- control inhibitorio;
- atención visual;
- memoria de trabajo;
- toma de decisiones en escenas de su deporte.

Además debe poder:
- ver la evolución de cada deportista contra **su propia línea base**;
- llevar esas mediciones a la ficha técnica (PAR-1) y a talento (PAR-7);
- asignar programas cortos de entrenamiento cognitivo con progresión.

**Qué NO se afirma (y se escribe así en la pantalla, en el informe y en la venta):**
1. **No es diagnóstico clínico.** No detecta ni descarta TDAH, dislexia, trastornos del aprendizaje, deterioro
   cognitivo ni conmoción cerebral. No reemplaza una evaluación neuropsicológica ni el protocolo de conmoción
   (SCAT6 o el que aplique el profesional de salud).
2. **No mide inteligencia** ni produce un «coeficiente».
3. **No predice** que un deportista llegará al profesionalismo, y **no se usa sola para seleccionar o descartar** a
   nadie (ver §11 y `talento-deportivo.md`).
4. **No promete que entrenar en la app mejora el rendimiento en la cancha.** La evidencia de transferencia lejana
   del «entrenamiento cerebral» genérico es débil (Simons et al., 2016; Harris, Wilson y Vine, 2018). Lo que sí se
   puede mostrar es la mejora **en las propias pruebas** (transferencia cercana) y, en el piloto, si se mueve algo
   en las métricas de campo.
5. **No es un dispositivo médico.** No se declara ninguna finalidad diagnóstica ni terapéutica, que es lo que
   pondría el software bajo la regulación de dispositivos médicos (INVIMA).

Vocabulario permitido en la interfaz: «prueba de reacción», «prueba de atención», «tu mejor marca», «por encima o
por debajo de tu habitual».

Vocabulario prohibido: «evaluación neurológica», «déficit», «trastorno», «diagnóstico», «edad cerebral».

## 2. Base científica de cada prueba

Se eligieron paradigmas con décadas de uso, que corren en pantalla táctil y en menos de 3 minutos cada uno, y cuya
relación con el rendimiento deportivo está estudiada:
- metaanálisis de expertos frente a no expertos en tareas cognitivas: Mann et al., 2007; Voss et al., 2010;
- funciones ejecutivas en futbolistas de élite y juveniles talentosos: Vestberg et al., 2012; Verburgh et al., 2014.

| Código | Prueba | Paradigma de origen | Qué mide | Por qué entra |
|---|---|---|---|---|
| `N-TRS` | Reacción simple | Donders (1868); variante breve de la prueba de vigilancia psicomotora (Dinges y Powell, 1985; Basner y Dinges, 2011) | Velocidad básica de respuesta y fallos de atención sostenida | Es la base: sin ella no se separa la velocidad motora de la cognitiva |
| `N-TRE` | Reacción de elección (2 y 4 opciones) | Ley de Hick-Hyman (Hick, 1952; Hyman, 1953) | Costo de decidir entre opciones | El deporte es elección bajo presión de tiempo |
| `N-GNG` | Go / No-Go | Donders; revisión de Simmonds, Pekar y Mostofsky (2008) | Control inhibitorio: frenar una respuesta automática | Frenar un pase o no morder un amague; ligado a funciones ejecutivas en jugadores (Vestberg et al., 2012) |
| `N-BUS` | Búsqueda visual | Teoría de integración de rasgos (Treisman y Gelade, 1980) | Eficiencia para encontrar un objetivo entre distractores (pendiente en ms por ítem) | Leer la cancha: encontrar al compañero libre |
| `N-COR` | Memoria de trabajo espacial (bloques de Corsi en pantalla, directa e inversa) | Corsi (1972); normas y procedimiento de Kessels et al. (2000) | Cuántas posiciones retiene y reproduce en orden | Espacial y sin lenguaje: sirve para cualquier edad e idioma, y es más cercano al juego que el span de dígitos |
| `N-DEC` | Decisión táctica con escenas de la pizarra | Paradigma de oclusión temporal (Abernethy y Russell, 1987; Farrow y Abernethy, 2002) | Precisión y tiempo para elegir la mejor opción en una jugada congelada | Es la prueba propia del deporte; Mann et al. (2007) muestran que el experto se diferencia sobre todo en tareas con estímulos del deporte |

**En lista para una versión 2, no para la primera:**
- **Señal de parada (*stop-signal*).** Sigue la guía de consenso de Verbruggen et al. (2019). Es más fina que el go/no-go, pero exige una escalera adaptativa y una precisión de tiempo que primero hay que medir en la fase N0.
- **Flanker** (Eriksen y Eriksen, 1974).
- **Seguimiento de múltiples objetos** (Pylyshyn y Storm, 1988), el paradigma que usa NeuroTracker. Su transferencia al campo está discutida (Harris et al., 2018).

## 3. Protocolo de aplicación

### 3.1 Condiciones (se piden en pantalla antes de empezar y se registran)
- **Modo supervisado.**
  - El entrenador abre la prueba en el dispositivo del club, elige al deportista y entrega el equipo.
  - **Solo las sesiones supervisadas entran a la ficha y a talento.**
  - El **modo autónomo** (el deportista en su propio celular) sirve para los programas de entrenamiento (§8) y queda en una serie aparte.
- **Mismo dispositivo:**
  - Cada deportista queda asociado a un dispositivo de prueba (`device_id`, ver §5).
  - Si cambia de equipo, la siguiente sesión abre una **línea base nueva** y no se calculan diferencias contra la anterior.
- **Postura:** el equipo va **apoyado sobre una mesa** (no en la mano), en horizontal y con brillo al máximo. El deportista usa el índice de la mano dominante.
- **Sin sonido** en la primera versión: la latencia del parlante varía mucho entre equipos.
- **Contexto:**
  - Antes del entrenamiento, nunca después de un partido o de una sesión intensa.
  - Misma franja horaria (±2 h) entre mediciones.
  - Se registra el contexto (`reposo`, `pre_entreno`, `post_entreno`) y, si existe, el bienestar del día (BOD-1B: sueño y fatiga), que sirve para leer una caída.
- **Edad mínima: 8 años** en la primera versión. Por debajo, la comprensión de la consigna y la variabilidad hacen ruido. Se revisa en el piloto.
- **Sin interrupciones:**
  - Se pide activar «no molestar».
  - Si la app pasa a segundo plano (`visibilitychange`), la sesión se invalida.

### 3.2 Estructura de cada prueba
- **Consigna con animación** (sin texto largo) y **calentamiento de 5 a 8 ensayos** con retroalimentación. El calentamiento no se puntúa.
- **Bloque medido:** sin retroalimentación de acierto o error.
- **Duración objetivo:**
  - batería completa (5 pruebas): **≤ 12 minutos**;
  - batería corta para equipo (`N-TRS`, `N-GNG` y `N-COR`): **≤ 6 minutos**.

| Prueba | Ensayos medidos | Parámetros clave |
|---|---|---|
| `N-TRS` | 30 | Intervalo previo aleatorio de 1,5 a 4 s (impide anticipar el ritmo) |
| `N-TRE` | 2 bloques de 24 (2 opciones y 4 opciones) | Posiciones balanceadas y orden pseudoaleatorio |
| `N-GNG` | 80 (75 % «sí», 25 % «no») | Estímulo de 500 ms y ventana de respuesta de 800 ms |
| `N-BUS` | 48 (tamaños de 8, 16 y 24; objetivo presente en la mitad) | Búsqueda por conjunción de color y forma |
| `N-COR` | Adaptativo: 2 ensayos por longitud, arranca en 3 y para cuando falla los dos | Directa, y después inversa |
| `N-DEC` | 12 escenas | Oclusión en el cuadro elegido por el entrenador y límite de 3 s por escena |

### 3.3 Familiarización y línea base
- **La primera sesión completa de cada prueba se descarta** (`descartada_familiarizacion`). Entre la sesión 1 y la 2
  está el mayor efecto de aprendizaje.
- **La línea base** es el promedio de las sesiones 2 y 3, hechas con al menos 48 h y como mucho 14 días de distancia.
- **Retest** cada 6 a 8 semanas. Hacerlo más seguido mide sobre todo práctica.

### 3.4 Descarte de atípicos (se calcula en el servidor, nunca en el cliente)

**Por ensayo:**
- **Anticipación:** tiempo de reacción < 100 ms. No se cuenta como respuesta válida, pero se suma en un indicador
  (es también señal de trampa, §6).
- **Fallo de atención:** en `N-TRS`, más de 500 ms. Es el criterio de la prueba de vigilancia psicomotora
  (Basner y Dinges, 2011). El ensayo se cuenta aparte y no entra en la mediana.
- **Tope por prueba:**
  - `N-TRS`: 1.500 ms;
  - `N-TRE` y `N-GNG`: 2.000 ms;
  - `N-BUS`: 6.000 ms.
  
  Lo que pasa el tope es omisión.
- **Recorte personal:** entre los válidos, fuera ±2,5 desviaciones absolutas de la mediana (MAD). Es la
  recomendación de Leys et al. (2013): no usar ±2 desviaciones estándar sobre la media, que es frágil con la
  asimetría propia del tiempo de reacción (Ratcliff, 1993; Whelan, 2008).

**Por sesión:**
- Se marca `invalida` si:
  - más del 20 % de los ensayos quedan excluidos, o
  - la precisión queda en el nivel del azar (`N-TRE` < 60 %, `N-GNG` con comisiones > 50 %), o
  - la app pasó a segundo plano, o
  - el reloj de cuadros mostró caídas graves (§4).
- El entrenador ve el motivo y puede repetir otro día. **Nunca el mismo día** para la línea base.

**Puntajes (siempre con la mediana, no con la media):**

| Prueba | Puntaje principal | Secundarios |
|---|---|---|
| `N-TRS` | Mediana de tiempo de reacción (ms) | Fallos de atención, anticipaciones y variabilidad (rango intercuartil) |
| `N-TRE` | Mediana de los aciertos, con 2 y con 4 opciones | % de error y costo por opción adicional |
| `N-GNG` | Tasa de comisión (respondió en «no») | Omisión, mediana en «sí» y d′ con corrección log-lineal (Hautus, 1995) |
| `N-BUS` | Pendiente en ms por ítem (presente) | Precisión e intercepto |
| `N-COR` | Span directo e inverso | Puntaje total = span × ensayos correctos (Kessels et al., 2000) |
| `N-DEC` | % de aciertos | Mediana del tiempo de decisión en aciertos y puntaje de eficiencia invertida = tiempo / proporción de aciertos (Townsend y Ashby, 1983) |

## 4. Reproducibilidad técnica (el punto más delicado)

Un celular no es un equipo de laboratorio. Entre el momento en que el código pide mostrar el estímulo y el momento
en que la pantalla lo enciende hay latencia de pantalla, y entre el toque y el evento hay latencia táctil. Ambas
suman decenas de milisegundos y **cambian según el modelo** (Plant, 2016; Pronk et al., 2020; Bridges et al.,
2020). Las diferencias reales entre deportistas también son de decenas de milisegundos.

**Consecuencias de diseño:**
1. **Solo se compara al deportista contra sí mismo y en el mismo dispositivo.**
   - El error constante del equipo se cancela al restar.
   - Los percentiles contra otros (§7) se calculan solo entre sesiones hechas en la **misma clase de dispositivo** (`device_class`, ver el siguiente punto), y la pantalla lo dice.
2. **Perfil del dispositivo en cada sesión.** Se guarda:
   - el agente de usuario y el modelo cuando la app nativa lo da;
   - el tamaño y la densidad de pantalla;
   - **la frecuencia de refresco medida**: mediana del intervalo de `requestAnimationFrame` en 2 s de calibración (60, 90 o 120 Hz);
   - el jitter de cuadros y el tipo de entrada.
   
   `device_class` = plataforma + frecuencia + rango de gama.
3. **Temporización:**
   - El estímulo se dibuja sincronizado con `requestAnimationFrame` y el inicio se toma del cuadro en que se pintó.
   - La respuesta se toma con `pointerdown` y su `event.timeStamp`, nunca con `click`, para evitar el retraso del gesto.
   - Se usa `touch-action: manipulation` y se ignoran los toques múltiples.
   - Todo se mide con `performance.now()`.
4. **Calidad de la sesión.** Se invalida si durante el bloque medido más del 5 % de los cuadros superan 1,5 veces el intervalo nominal (equipo en ahorro de energía o caliente). Se avisa si la batería está por debajo del 20 % o si el modo de ahorro está activo.
5. **Fase N0, banco de medición.** Antes de dar por buena cualquier prueba se mide la latencia real de punta a punta en 6 a 8 equipos representativos de los clubes (gama baja Android, gama media, iPhone y la tableta del club):
   - se graba la pantalla y el dedo con cámara lenta a 240 cuadros por segundo;
   - se cuentan cuadros entre el toque y el cambio.
   
   El resultado decide si la versión web alcanza o si las pruebas de tiempo necesitan el contenedor nativo.
6. **Versionado.** Cada prueba tiene `test_version`. Cambiar cualquier parámetro (ensayos, tiempos, colores o tamaño) crea versión nueva, y **nunca se comparan puntajes entre versiones**.
7. **Sin señal.** La prueba corre completa sin red; los ensayos crudos se guardan en la cola del modo sin señal y se suben al volver. La temporización no depende de la red.

**Confiabilidad exigida** (se mide en el piloto, §10):
- correlación intraclase ICC(2,1) ≥ 0,75 en el puntaje principal de cada prueba entre las sesiones 2 y 3. Koo y Li (2016) consideran «buena» desde 0,75;
- se publican el **error típico** y el **cambio mínimo relevante** de cada prueba (Hopkins, 2000);
- una prueba que no llegue al umbral no entra a la ficha.

## 5. Modelo de datos (propuesta, sin escribir)

Pensado para no castigar el Disk IO:
- **los ensayos van en un solo `jsonb` por sesión**, no una fila por ensayo;
- un `INSERT` por sesión;
- normas calculadas en lote semanal.

| Tabla | Columnas clave | Notas |
|---|---|---|
| `neuro_test_definitions` | `test_key` (text), `test_version` (int), `name`, `params` jsonb, `status` text CHECK (`borrador`, `activa`, `retirada`), `min_age` | Catálogo del sistema. Solo lo escribe `service_role`. Cualquier autenticado lo lee. `PRIMARY KEY (test_key, test_version)` |
| `neuro_devices` | `id`, `school_id`, `label` («Tableta 1»), `device_class`, `last_profile` jsonb, `created_by` → `profiles` | Equipo de prueba del club. El identificador vive en el almacenamiento local del equipo y se registra aquí |
| `neuro_sessions` | `id`, `school_id`, `subject_type` text CHECK (`profile`, `child`, `unregistered`), `subject_id`, `test_key`, `test_version`, `mode` text CHECK (`supervisado`, `autonomo`, `entrenamiento`), `context` text CHECK (`reposo`, `pre_entreno`, `post_entreno`), `device_id`, `device_profile` jsonb, `administered_by` → `profiles`, `started_at`, `finished_at`, `status` text CHECK (`valida`, `invalida`, `descartada_familiarizacion`), `invalid_reason` text, `trials` jsonb, `wellness_checkin_id` (opcional), `baseline_group` int | Mismo eje de sujeto que `performance_entries`. `trials` guarda el estímulo, el inicio, la respuesta, el tiempo de reacción y las marcas de cada ensayo |
| `neuro_session_scores` | `session_id`, `metric_key` (p. ej. `trs_mediana_ms`, `gng_comision_pct`), `value`, `unit`, `is_primary` | Puntajes que calcula el servidor. Alimentan la evolución, la ficha y talento. `UNIQUE (session_id, metric_key)` |
| `neuro_norms` | `test_key`, `test_version`, `metric_key`, `age_band`, `device_class`, `scope` text CHECK (`escuela`, `sportmaps`), `school_id` (NULL si es `sportmaps`), `n`, `p10`, `p25`, `p50`, `p75`, `p90`, `computed_at` | Lote semanal. Solo se publica una fila con `n ≥ 20` |
| `neuro_scenes` | `id`, `school_id` (NULL = escena del sistema), `sport`, `title`, `source` text CHECK (`pizarra_ejercicio`, `jugada_compartida`, `manual`), `board_snapshot` jsonb, `occlusion_frame` int, `options` jsonb, `correct_option`, `validated_by` uuid[], `status` text CHECK (`borrador`, `validada`, `archivada`), `created_by` → `profiles` | Copia congelada del tablero. Si el ejercicio original cambia, la escena no cambia |
| `neuro_programs` / `neuro_program_assignments` | Programa: `test_key` base, semanas, sesiones por semana, regla de progresión. Asignación: sujeto, `assigned_by`, `starts_on`, `status` text CHECK (`activo`, `pausado`, `terminado`), `current_level` | §8. Las sesiones de entrenamiento se guardan en `neuro_sessions` con `mode = 'entrenamiento'` |

**Consentimiento.** Se usa la tabla genérica `athlete_data_consents` con propósito `neuro_pruebas`, definida en
`talento-deportivo.md` §6.

**Escritura.**
- **Toda escritura de sesiones pasa por el BFF**:
  - `POST /api/v1/neuro/sessions` recibe los ensayos crudos;
  - verifica que el sujeto pertenezca a `req.schoolId`, que haya consentimiento vigente y que la prueba esté activa;
  - **recalcula los puntajes en el servidor**: el puntaje que manda el cliente se ignora;
  - escribe sesión y puntajes en una sola transacción, con una RPC `SECURITY DEFINER` o el cliente de servicio.
- El frontend no hace `INSERT` directo.
- Escenas y programas se escriben por RPC con el alcance validado adentro, usando `user_staff_school_ids()`.

**Lectura (RLS, `TO authenticated`, helpers envueltos):**
- **Staff de la escuela** (`school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])`): todo lo de su escuela.
- **Deportista adulto:** sus propias sesiones (`subject_type = 'profile' AND subject_id = (SELECT auth.uid())`).
- **Acudiente:** solo `neuro_session_scores` de sus hijos y solo desde la fase N4, por una vista que **no expone percentiles contra compañeros** (§7).
- **`anon`:** nada. Ningún `GRANT` a `anon`.
- `neuro_norms` con `scope = 'sportmaps'` solo guarda agregados por banda y nunca identifica escuela ni deportista.

## 6. Anti-trampa

| Riesgo | Cómo se detecta o se evita |
|---|---|
| Tocar al ritmo en vez de reaccionar | Intervalo previo aleatorio, ensayos sin estímulo en `N-TRS` (10 %) y conteo de anticipaciones. Más de 3 anticipaciones invalida la sesión |
| Tocar todo en go/no-go | La tasa de comisión es el puntaje principal: tocar todo da el peor resultado |
| Que otro haga la prueba | Solo cuenta el modo supervisado, con el entrenador presente. El autónomo queda en serie aparte |
| Hacerse el lento en la línea base para «mejorar» después | La línea base es supervisada. Se marca la variabilidad intraindividual anómala (rango intercuartil más de 2 veces el habitual del grupo de edad) y la precisión perfecta con tiempos muy altos. El entrenador ve la marca |
| Repetir hasta que salga bien | Máximo 1 sesión válida por prueba por día en modo supervisado. Los intentos invalidados quedan visibles |
| Manipular el cliente o la red | Los puntajes los calcula el servidor desde los ensayos crudos. Se valida la coherencia: tiempos monótonos, número de ensayos, secuencia de estímulos reproducible desde una semilla guardada. Límite de envíos por usuario |
| Memorizar las escenas de decisión | Banco de escenas con rotación, espejado aleatorio (izquierda / derecha) y un 30 % de escenas nuevas en cada retest |

## 7. Normalización por edad

El tiempo de reacción y la memoria de trabajo cambian mucho entre los 8 y los 18 años:
- la velocidad de procesamiento mejora con la edad durante toda la adolescencia (Kail, 1991);
- la capacidad de la memoria de trabajo crece entre los 4 y los 15 años (Gathercole et al., 2004).

Comparar a un niño de 9 con uno de 13 sin corregir no tiene sentido. Se usan tres niveles, en este orden:
1. **Contra sí mismo (siempre, y es lo principal).** Diferencia contra la línea base, expresada en múltiplos del
   cambio mínimo relevante de la prueba: «mejoró más de lo que varía por azar» / «dentro de lo habitual» / «por
   debajo de lo habitual».
2. **Contra su grupo de edad en su escuela.**
   - Bandas: 8–9, 10–11, 12–13, 14–15, 16–17 y 18 o más, calculadas con la **edad decimal** el día de la prueba.
   - Percentil dentro de la banda, la misma `device_class` y la misma versión, **solo si n ≥ 20**. Si no, no se muestra.
   - **Solo lo ve el staff.**
3. **Norma de referencia SportMaps** (decisión D-NEU-3). Agregado anónimo por banda, entre escuelas que lo autoricen:
   - no expone nada de ninguna escuela;
   - exige n ≥ 20 por celda;
   - solo existe después del piloto.

**Hacia la ficha técnica (PAR-1).**
- Cada capacidad (Reacción, Inhibición, Atención, Memoria y Decisión) se muestra en 0–100 **como percentil de su banda de edad**, con la etiqueta «medido» para diferenciarla de los atributos que califica el entrenador.
- No se mezcla en la «media» de la ficha sin aprobación (D-NEU-4).
- Si no hay norma con n suficiente, la ficha muestra el valor crudo y la evolución, sin 0–100.

## 8. Programas de entrenamiento cognitivo

**Formato:**
- sesiones de **6 a 8 minutos**, **3 por semana** y **4 a 6 semanas**;
- después, retest con la batería supervisada.

Cada programa toma una prueba como base y sube la dificultad con una **escalera adaptativa de 2 aciertos para subir y
1 error para bajar**, que converge cerca del 70,7 % de aciertos (Levitt, 1971). Así cada deportista entrena en su
límite, ni aburrido ni frustrado.

| Programa | Base | Cómo progresa (nivel 1 a 10) |
|---|---|---|
| Reacción | `N-TRE` | De 2 a 4 a 6 opciones, intervalo previo más variable y estímulos periféricos |
| Frenar a tiempo | `N-GNG` | Más ritmo, menos ventana y menos proporción de «no» (más difícil de frenar) |
| Leer la cancha | `N-BUS` | Más distractores, distractores más parecidos y tiempo límite |
| Memoria de juego | `N-COR` | Secuencias más largas, inversa y posiciones sobre una cancha en vez de una grilla |
| Decidir rápido | `N-DEC` | Oclusión más temprana, más opciones y menos tiempo; escenas de su posición |

**Reglas:**
- Las sesiones de programa se guardan con `mode = 'entrenamiento'` y **nunca** cuentan como medición para la ficha.
- El deportista puede hacerlas en su propio celular, en modo autónomo.
- El entrenador ve la adherencia: sesiones hechas y nivel alcanzado.
- Recordatorio con el despachador unificado (`notifications-unified.md`), como máximo uno por día.
- Enganche opcional con SportPoints (D-NEU-6).
- **Más adelante (fuera de la primera versión): «modo cancha».** El celular en un trípode hace de luz o estímulo en un
  ejercicio con balón (doble tarea). Queda para después del piloto.

## 9. Cómo entra al perfil, a la ficha y al informe

- **Entrenador V2 → deportista → pestaña «Pruebas».** Historial por prueba con:
  - la línea base;
  - la banda de cambio mínimo relevante;
  - las sesiones inválidas con su motivo;
  - el dispositivo usado.
- **Modo estación (equipo completo):**
  - el entrenador arma una lista de deportistas y el equipo los rota;
  - batería corta de 6 minutos;
  - con 2 equipos, un plantel de 20 se mide en una hora.
- **Ficha técnica (PAR-1):**
  - bloque «Capacidades cognitivas (medidas)», con 5 barras en percentil de edad y una flecha de tendencia;
  - fecha de la última medición válida;
  - en la página 2, la evolución.
- **Talento (PAR-7):** los puntajes y su evolución están disponibles como fuente `neuro` en los criterios, solo con consentimiento `neuro_pruebas` vigente.
- **Familias (fase N4):**
  - solo la evolución contra sí mismo, con lenguaje neutro;
  - sin percentiles contra compañeros y sin ranking;
  - un resultado bajo nunca dispara un aviso automático a la familia.
- **Informe mensual:** no entra hasta N4. Cuando entre, entra como sección propia, no como métrica en `performance_entries`. Volcar a `performance_entries` exigiría ampliar el `CHECK` de `category` y atarlo a un deporte (D-NEU-5).

## 10. Fases

Cada fase tiene criterio de salida. No se pasa a la siguiente sin cumplirlo.

| Fase | Contenido | Pruebas | Criterio de salida |
|---|---|---|---|
| **N0: banco de medición** | Prototipo de `N-TRS` sin persistencia, medido con cámara de 240 cuadros por segundo en 6 a 8 equipos reales. Calibración de refresco y jitter | Planilla con latencia media y desviación estándar por equipo | Desviación estándar intra-equipo ≤ 10 ms en gama media. Decisión web o nativo (D-NEU-1) escrita en este spec |
| **N1: núcleo supervisado** | `N-TRS`, `N-TRE`, `N-GNG` y `N-COR`; tablas de §5 (migración mostrada antes de aplicar), consentimiento, endpoint del BFF con recálculo, pestaña «Pruebas» solo para staff, modo sin señal | Vitest del cálculo de puntajes con vectores de ensayos conocidos (atípicos, anticipaciones, invalidación). Pruebas del BFF de alcance (escuela A no escribe sujetos de B; sin consentimiento da 403). SQL de RLS con sesiones simuladas (staff A, staff B, acudiente, deportista y `anon`). `npm run seguridad:invariantes`. Prueba de punta a punta del flujo estación | Todo verde y cero CRÍTICAS. Batería completa ≤ 12 min en un equipo de gama baja |
| **N2: piloto con un club** | Un club, ≥ 30 deportistas de 10 a 17 años con consentimiento. Sesión 1 de familiarización y sesiones 2 y 3 separadas de 2 a 7 días. Entrevista a 2 entrenadores | Confiabilidad: ICC(2,1), error típico y cambio mínimo relevante por prueba. Validez de grupos conocidos: los puntajes mejoran con la edad (correlación con la edad decimal en la dirección esperada). Convergencia: correlación con la calificación ciega del entrenador sobre «lectura de juego» (exploratoria, sin umbral). Operación: % de sesiones inválidas y tiempo real | ICC ≥ 0,75 en el puntaje principal (la prueba que no llega no pasa a la ficha), < 10 % de sesiones inválidas y los entrenadores lo quieren usar sin acompañamiento. Informe del piloto en `docs/` |
| **N3: decisión táctica** | `N-DEC` con escenas creadas desde la pizarra: un ejercicio de la biblioteca (`board`) o una jugada (`tactical_shared_plays.payload`), con el cuadro de oclusión y las opciones marcadas por el entrenador. Cada escena se valida con ≥ 2 entrenadores que coinciden en la respuesta. Banco inicial de 24 escenas de fútbol | Vitest de la reproducción del tablero en el cuadro de oclusión. ICC en el club piloto | ≥ 24 escenas validadas, ICC ≥ 0,70 (más bajo porque la respuesta «correcta» es el criterio del club) y acuerdo entre entrenadores ≥ 80 % por escena |
| **N4: ficha, talento y familia** | Bloque en la ficha, fuente `neuro` en talento, vista para familias y normas por escuela | Vitest de percentiles con n mínimo. Prueba de punta a punta de la vista de familia (sin percentiles ni ranking). RLS del acudiente | Revisión del texto de familia por el usuario; ningún término prohibido de §1 |
| **N5: programas** | Los 5 programas, escalera, adherencia y recordatorio | Vitest de la escalera. En el club piloto: grupo con programa frente a grupo en lista de espera durante 6 semanas, comparando el cambio en las pruebas (transferencia cercana) y, exploratorio, en una métrica de campo | Adherencia ≥ 60 % de sesiones. Se reporta el efecto, sea cual sea; no se vende «mejora en la cancha» si no aparece |
| **N6 (opcional)** | Señal de parada, flanker, seguimiento de múltiples objetos y modo cancha | Según cada prueba | Mismo umbral de confiabilidad |

## 11. Decisiones (con recomendación)

| # | Decisión | Recomendación |
|---|---|---|
| **D-NEU-1** | ¿Las pruebas corren en la web o en la app nativa? | **Web primero, decidido con los datos de N0.** Pasar a nativo solo las pruebas de tiempo si la desviación estándar en web supera 10 ms en gama media |
| **D-NEU-2** | ¿Club piloto? | **Besser**: busca monitoreo completo para la temporada 2027 y ya captura RPE y bienestar. Alterna: Dynasty (volumen) |
| **D-NEU-3** | ¿Norma de referencia SportMaps entre escuelas? | **Sí, solo agregada y anónima**, con opción de no participar por escuela, n ≥ 20 por celda y después del piloto. Nunca se exponen datos de una escuela a otra |
| **D-NEU-4** | ¿Las capacidades medidas entran en la «media» de la ficha? | **No en la primera versión.** Bloque aparte con etiqueta «medido». Se revisa con PAR-1 después de N2 |
| **D-NEU-5** | ¿Volcar puntajes a `performance_entries`? | **No.** Tablas propias. Volcar obligaría a una categoría `cognitive` atada a un deporte y mezclaría lo medido con lo calificado en el informe |
| **D-NEU-6** | ¿Programas con SportPoints? | Sí, como opcional y después de N5. Puntos por adherencia, nunca por puntaje (premiar el puntaje invita a la trampa) |
| **D-NEU-7** | ¿Las familias ven resultados? | Sí desde N4: solo la evolución contra sí mismo y con lenguaje neutro |
| **D-NEU-8** | ¿Cobro? | Incluido en el plan durante el piloto. Después, decidir si va dentro del addon de rendimiento (D-BOD-7) |
| **D-NEU-9** | ¿Retención de ensayos crudos? | 24 meses y después se borra `trials`, conservando los puntajes. Al irse el deportista de la escuela, lo mismo que decida D-TAL-6 |
| **D-NEU-10** | ¿Qué hacer ante una caída fuerte contra la línea base? | Solo un mensaje neutro al entrenador: «por debajo de lo habitual; repetir otro día». **Ninguna** interpretación de salud. Si el entrenador sospecha un golpe en la cabeza, sigue el protocolo médico del club, no la app |

## 12. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| La latencia del celular tapa diferencias reales | Alta | Alto | Comparación intra-dispositivo, fase N0 y umbral de confiabilidad antes de mostrar nada |
| Una familia o un entrenador lo lee como diagnóstico | Media | Alto | Lenguaje de §1, sin avisos automáticos, revisión de textos en N4 y aviso fijo en la pestaña |
| Vender «mejora en la cancha» sin evidencia | Media | Alto (reputación) | Prohibido en materiales; se reporta lo que salga en N5 |
| Etiquetar a un niño de «lento» y que eso afecte su selección | Media | Alto | Percentiles solo para staff, nunca como criterio único en talento (`talento-deportivo.md` §4) y comparación por edad |
| Baja adherencia en el autónomo | Alta | Medio | Sesiones de 6 minutos, recordatorio único y modo estación supervisado como camino principal |
| Datos de cognición de menores: sensibilidad legal | Media | Alto | Consentimiento previo del acudiente (`athlete_data_consents`), minimización, sin datos entre escuelas, retención limitada y política de privacidad actualizada antes de N1 |
| El club piloto no logra 30 deportistas con 3 sesiones | Media | Medio | Modo estación, 2 equipos y calendario acordado de antemano |
| IO de la base | Baja | Medio | Un `INSERT` por sesión con ensayos en `jsonb` y normas en lote semanal |

## 13. Fuera de alcance
- Integración con NeuroTracker, Senaptec u otros (decisión D-NEURO-1).
- Electroencefalografía, seguimiento ocular o hardware externo.
- Cualquier uso clínico o de conmoción.
- Comparar escuelas entre sí o mostrar rankings.

## 14. Referencias
- Abernethy, B., y Russell, D. G. (1987). Expert-novice differences in an applied selective attention task. *Journal of Sport Psychology*, 9, 326–345.
- Basner, M., y Dinges, D. F. (2011). Maximizing sensitivity of the psychomotor vigilance test (PVT) to sleep loss. *Sleep*, 34(5), 581–591.
- Bridges, D., Pitiot, A., MacAskill, M. R., y Peirce, J. W. (2020). The timing mega-study: comparing a range of experiment generators, both lab-based and online. *PeerJ*, 8, e9414.
- Corsi, P. M. (1972). *Human memory and the medial temporal region of the brain* (tesis doctoral). McGill University.
- Dinges, D. F., y Powell, J. W. (1985). Microcomputer analyses of performance on a portable, simple visual RT task during sustained operations. *Behavior Research Methods, Instruments, & Computers*, 17, 652–655.
- Eriksen, B. A., y Eriksen, C. W. (1974). Effects of noise letters upon the identification of a target letter in a nonsearch task. *Perception & Psychophysics*, 16, 143–149.
- Farrow, D., y Abernethy, B. (2002). Can anticipatory skills be learned through implicit video-based perceptual training? *Journal of Sports Sciences*, 20(6), 471–485.
- Gathercole, S. E., Pickering, S. J., Ambridge, B., y Wearing, H. (2004). The structure of working memory from 4 to 15 years of age. *Developmental Psychology*, 40(2), 177–190.
- Harris, D. J., Wilson, M. R., y Vine, S. J. (2018). A systematic review of commercial cognitive training devices: implications for use in sport. *Frontiers in Psychology*, 9, 709.
- Hautus, M. J. (1995). Corrections for extreme proportions and their biasing effects on estimated values of d′. *Behavior Research Methods*, 27, 46–51.
- Hick, W. E. (1952). On the rate of gain of information. *Quarterly Journal of Experimental Psychology*, 4, 11–26.
- Hopkins, W. G. (2000). Measures of reliability in sports medicine and science. *Sports Medicine*, 30(1), 1–15.
- Hyman, R. (1953). Stimulus information as a determinant of reaction time. *Journal of Experimental Psychology*, 45, 188–196.
- Kail, R. (1991). Developmental change in speed of processing during childhood and adolescence. *Psychological Bulletin*, 109(3), 490–501.
- Kessels, R. P. C., van Zandvoort, M. J. E., Postma, A., Kappelle, L. J., y de Haan, E. H. F. (2000). The Corsi Block-Tapping Task: standardization and normative data. *Applied Neuropsychology*, 7(4), 252–258.
- Koo, T. K., y Li, M. Y. (2016). A guideline of selecting and reporting intraclass correlation coefficients for reliability research. *Journal of Chiropractic Medicine*, 15(2), 155–163.
- Levitt, H. (1971). Transformed up-down methods in psychoacoustics. *Journal of the Acoustical Society of America*, 49, 467–477.
- Leys, C., Ley, C., Klein, O., Bernard, P., y Licata, L. (2013). Detecting outliers: do not use standard deviation around the mean, use absolute deviation around the median. *Journal of Experimental Social Psychology*, 49(4), 764–766.
- Mann, D. T. Y., Williams, A. M., Ward, P., y Janelle, C. M. (2007). Perceptual-cognitive expertise in sport: a meta-analysis. *Journal of Sport & Exercise Psychology*, 29(4), 457–478.
- Plant, R. R. (2016). A reminder on millisecond timing accuracy and potential replication failure in computer-based psychology experiments. *Behavior Research Methods*, 48, 408–411.
- Pronk, T., Wiers, R. W., Molenkamp, B., y Murre, J. (2020). Mental chronometry in the pocket? Timing accuracy of web applications on touchscreen and keyboard devices. *Behavior Research Methods*, 52, 1371–1382.
- Pylyshyn, Z. W., y Storm, R. W. (1988). Tracking multiple independent targets. *Spatial Vision*, 3(3), 179–197.
- Ratcliff, R. (1993). Methods for dealing with reaction time outliers. *Psychological Bulletin*, 114(3), 510–532.
- Simmonds, D. J., Pekar, J. J., y Mostofsky, S. H. (2008). Meta-analysis of Go/No-go tasks demonstrating that fMRI activation associated with response inhibition is task-dependent. *Neuropsychologia*, 46(1), 224–232.
- Simons, D. J., Boot, W. R., Charness, N., et al. (2016). Do «brain-training» programs work? *Psychological Science in the Public Interest*, 17(3), 103–186.
- Townsend, J. T., y Ashby, F. G. (1983). *Stochastic modeling of elementary psychological processes*. Cambridge University Press.
- Treisman, A. M., y Gelade, G. (1980). A feature-integration theory of attention. *Cognitive Psychology*, 12(1), 97–136.
- Verbruggen, F., Aron, A. R., Band, G. P., et al. (2019). A consensus guide to capturing the ability to inhibit actions and impulsive behaviors in the stop-signal task. *eLife*, 8, e46323.
- Verburgh, L., Scherder, E. J. A., van Lange, P. A. M., y Oosterlaan, J. (2014). Executive functioning in highly talented soccer players. *PLoS ONE*, 9(3), e91254.
- Vestberg, T., Gustafson, R., Maurex, L., Ingvar, M., y Petrovic, P. (2012). Executive functions predict the success of top-soccer players. *PLoS ONE*, 7(4), e34731.
- Voss, M. W., Kramer, A. F., Basak, C., Prakash, R. S., y Roberts, B. (2010). Are expert athletes «expert» in the cognitive laboratory? A meta-analytic review of cognition and sport expertise. *Applied Cognitive Psychology*, 24(6), 812–826.
- Whelan, R. (2008). Effective analysis of reaction time data. *The Psychological Record*, 58, 475–482.

> Antes de publicar material comercial o el informe del piloto, verificar cada referencia contra la fuente original
> (año, volumen y páginas). Se citaron de memoria del corpus.
