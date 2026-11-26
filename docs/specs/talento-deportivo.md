# Spec — Talento deportivo: detección y seguimiento por escuela (PAR-7)

**Estado:** plan para aprobación (2026-11-26). Sin código, sin migraciones y sin consultas a la base.

**Origen:**
- `docs/plan-paridad-y-v2-2026-11.md`: PAR-7, equivalente a VIRTUS de LUDMO+.
- `docs/sportmaps-strategic-roadmap.md` §7.bis (BLQ-8): D3 «Pasaporte deportivo global» y D4 «Scouting con IA». Este spec **no** es D3 ni D4: es la versión dentro de cada escuela. Deja el camino abierto para que, en el futuro, la familia porte sus datos con consentimiento.

**Se apoya en:**
- `docs/specs/ficha-tecnica-global.md` (PAR-1, escrita en paralelo): «media», atributos por posición 0–100, pruebas físicas e historial.
- `docs/specs/neuroentrenamiento-pruebas.md` (PAR-8).
- `sport_metric_definitions` y `sport_metric_thresholds` (MOD-10).
- `performance_entries`.
- Minutos de partido (`partidos-registro-y-evaluacion-por-jugador.md`).
- Asistencia.

> **Convenciones de `CLAUDE.md` que aplican:**
> - Migraciones con `npm run migrations:new`, mostradas antes de aplicarse y aplicadas una sesión a la vez.
> - Estados con `text + CHECK`.
> - FKs de negocio a `profiles`.
> - `SET search_path = pg_catalog, public, pg_temp`.
> - `GRANT EXECUTE` explícito por RPC.
> - Policies con `(SELECT auth.uid())` y `= ANY ((SELECT public.f())::uuid[])`, y `TO authenticated`.
> - Escritura con `user_staff_school_ids()` o `user_admin_school_ids()`, **nunca** con `user_school_ids()` (invariante I2).
> - Creación de varias filas con RPC transaccional.
> - Jobs sin N+1.

---

## 1. Objetivo

Que el cuerpo técnico de **una escuela** pueda hacer cinco cosas:
1. Llevar una **lista de seguimiento** de sus deportistas con proyección, con dueño, motivo y revisión periódica.
2. Recibir **sugerencias** cuando un deportista cumple los criterios que la escuela definió:
   - métricas con umbrales;
   - evolución de la ficha (media, atributos, pruebas físicas);
   - pruebas cognitivas;
   - asistencia y minutos.
3. Recibir **alertas de progreso** de quienes ya están en la lista.
4. **Comparar dentro de una categoría corrigiendo por edad relativa**, para no confundir «nació en enero» con «tiene talento».
5. **Exportar la ficha para una visoría** con un enlace firmado que vence, solo con **consentimiento del acudiente**, o del propio deportista si es mayor de edad.

### 1.1 Lo que no es
- **No hay datos entre escuelas.** Una escuela nunca ve, busca ni compara deportistas de otra. No existe rol de *scout* ni buscador externo, porque eso es D4 y exige su propio spec y consentimiento.
- **No hay decisión automática.** Los criterios **sugieren** y una persona decide. Nada entra a la lista, se descarta ni se exporta sin un humano.
- **No hay etiqueta visible para el niño ni para su familia.** «Talento» es una herramienta interna del cuerpo técnico (§7).
- **No predice** el éxito adulto. La literatura muestra que la detección temprana falla mucho y que el rendimiento juvenil predice mal el adulto (Vaeyens et al., 2008; Johnston et al., 2018; Güllich, Macnamara y Hambrick, 2022). El producto lo dice en pantalla: «seguimiento», no «selección».

## 2. Lo que ya existe (leído en el repo el 2026-11-26)

| Pieza | Estado | Implicación |
|---|---|---|
| `sport_metric_definitions` | Catálogo por deporte con `higher_is_better`, `min_value`, `max_value` y `category ∈ {physical, technical, tactical, attendance}` | Fuente de las métricas de los criterios |
| `sport_metric_thresholds` | Bandas `green`, `yellow` y `red` por métrica. **Sin eje de edad ni de categoría**: gap documentado en `20260731154626_regularize_performance_schema.sql` | Un umbral de «salto vertical en cm» vale igual a los 9 y a los 16 años. Talento **no** puede usar estas bandas tal cual para comparar edades (§4.2) |
| `school_metric_definitions` | Métricas propias por escuela (`20261008154653`) | Los criterios aceptan también métricas de la escuela |
| `performance_entries` | Sujeto polimórfico (`profile`, `child` o `unregistered`) + `metric_key` + `value` + `recorded_at` | Se reutiliza el mismo eje de sujeto en todas las tablas nuevas |
| Fecha de nacimiento | `children.date_of_birth` y `profiles.date_of_birth` | **Hay que medir cuántos deportistas activos la tienen** (T0). Sin ella no hay corrección por edad relativa |
| `teams.age_group` | Nulo en muchos equipos (los 11 de Dynasty, según la misma migración) | La categoría se deriva del año de nacimiento y del corte de la escuela, no de `age_group` |
| Ficha técnica (PAR-1) | Spec en curso: media, atributos 0–100 por posición, pruebas físicas con nivel e historial por año | Talento lee la ficha; no recalcula la media por su cuenta |
| Enlaces públicos con token | `athlete_report_share_links` (informe por enlace), `tactical_shared_plays` (jugada por enlace) y `verificar_carnet_por_codigo` (carnet, menor enmascarado) | Patrón de referencia: tabla sin policies y una RPC `SECURITY DEFINER` con `GRANT` a `anon` que devuelve una **foto congelada**. Esta versión mejora el patrón: guarda el **hash** del token, no el token |
| Consentimientos | `payment_consents`, `clinical_consents`, `whatsapp_consentimientos` y el consentimiento de imagen (D-IMAGEN / VID-6) | No hay una tabla genérica de consentimiento por finalidad: se propone `athlete_data_consents` (§6), que también usa neuro |
| Despachador de notificaciones | `notifications-unified.md` | Las alertas salen por ahí y van solo al staff |

## 3. Conceptos

- **Lista de seguimiento:** deportistas que el cuerpo técnico decidió seguir de cerca, cada uno con:
  - estado (`observacion`, `seguimiento`, `priorizado` o `cerrado`);
  - entrenador responsable;
  - motivo;
  - próxima fecha de revisión.
- **Criterio:** regla definida por la escuela, por ejemplo «sub-13 de fútbol: media ≥ 70 **y** sprint de 20 m en el percentil 80 corregido **y** asistencia ≥ 80 % en 90 días».
- **Señal:** un deportista cumplió un criterio en una fecha. Es una sugerencia y alguien la revisa.
- **Alerta de progreso:** un cambio relevante en alguien que ya está en la lista.
- **Edad relativa:** cuántos meses es mayor o menor un deportista que sus compañeros de categoría, según su fecha de nacimiento y la fecha de corte.
- **Exportación:** una foto congelada de la ficha, aprobada por el acudiente y accesible por un enlace que vence.

## 4. Criterios con umbrales y evolución

### 4.1 Tipos de regla (fuente × operador)

| Fuente | Ejemplos de clave | Operadores |
|---|---|---|
| `media` | Media de la ficha | `>=`, `<=`, `percentil_cat >=`, `delta >=` en N días |
| `atributo` | Atributo 0–100 por posición (velocidad, visión…) | Los mismos |
| `prueba_fisica` | `metric_key` de `sport_metric_definitions` o `school_metric_definitions` con `category = 'physical'` | Los mismos, respetando `higher_is_better`, y además `banda = green` |
| `metrica` | Cualquier otra métrica del catálogo | Los mismos |
| `neuro` | Puntaje principal de una prueba (PAR-8), solo con consentimiento `neuro_pruebas` | `percentil_edad >=` y `delta_vs_base >=` (en múltiplos del cambio mínimo relevante) |
| `asistencia` | % de asistencia en N días | `>=` |
| `minutos` | Minutos jugados o partidos titulares en N días | `>=` |

- **Composición:** un criterio tiene de 1 a 8 reglas y **cuántas deben cumplirse** (`min_rules_met`; por defecto, todas).
- **Alcance:** deporte, categoría o banda de nacimiento, y posición (opcional).
- **Ventana:** el valor que cuenta es el **último dentro de la ventana** (por defecto 120 días). Un dato viejo no dispara señales.

**Reglas de robustez obligatorias:**
1. **Ninguna regla de evolución usa diferencias crudas.** Un `delta` cuenta solo si supera el **cambio mínimo relevante** de la métrica. Por defecto es 0,2 × la desviación estándar entre deportistas de la categoría, el «cambio pequeño» de Hopkins (2000). Si no hay suficientes datos, se usa el que defina la ficha para ese atributo. Con dos mediciones ruidosas, una mejora de 3 puntos no es una mejora.
2. **Los percentiles en la categoría** se calculan solo con n ≥ 8 deportistas con dato. Si no se alcanza, la regla queda «sin datos» y no se cumple.
3. **Por defecto, los percentiles y umbrales comparan la versión corregida por edad relativa** (§5). El admin puede pedir el valor crudo de forma explícita.
4. **Un criterio no puede tener solo reglas `neuro`**, ni basarse solo en la fecha de nacimiento.

### 4.2 Umbrales por edad (cierra el gap de `sport_metric_thresholds`)
- Las bandas del catálogo no tienen eje de edad, así que los criterios de talento **no** usan `green`, `yellow` o `red` para comparar entre edades.
- Usan:
  - el percentil dentro de la categoría, corregido; o
  - un umbral absoluto **que el admin fija por criterio**, que ya está acotado a una categoría.
- La regla «`banda = green`» se permite solo dentro de una categoría y con advertencia.
- Arreglar `sport_metric_thresholds` con un eje de edad es trabajo de MOD-10, no de este spec (D-TAL-3).

### 4.3 Cálculo y costo
- **Lote semanal** (domingo en la noche) por escuela con el módulo activo:
  - se leen en bloque las métricas, la ficha y la asistencia de los deportistas de la escuela con `.in(...)`;
  - se evalúan los criterios en el BFF;
  - se escriben las señales nuevas en un solo `INSERT … ON CONFLICT DO NOTHING`.
  
  Cero consultas por deportista. Corre **una vez por semana, no cada minuto**: los tres BFF comparten la base.
- **Recalcular por deportista:** cuando el staff registra una evaluación desde la ficha, el BFF reevalúa solo a ese deportista.
- **No se usan triggers:** un trigger en `performance_entries` dispararía en cada carga masiva.

## 5. Vista comparativa por categoría con edad relativa

### 5.1 Por qué
En el fútbol juvenil y en casi todo deporte por categorías de año, los nacidos en el primer trimestre del año de
corte están sobrerrepresentados entre los seleccionados: es el **efecto de edad relativa** (Musch y Grondin, 2001;
Helsen, van Winckel y Williams, 2005; Cobley et al., 2009). Un sub-13 nacido en enero tiene casi un año más de
desarrollo que uno nacido en diciembre. Si talento compara valores crudos, la herramienta **automatiza ese sesgo**.

### 5.2 Qué muestra
Una tabla por categoría (deporte + año o rango de nacimiento según el corte de la escuela) con, por deportista:
- foto, posición, media y atributos clave;
- pruebas físicas y neuro, si las hay;
- **trimestre de nacimiento** (T1 a T4) como etiqueta;
- **edad decimal** y **edad relativa en meses** frente a la media de la categoría;
- marca «en lista» y tendencia.

Opciones de la vista:
- Interruptor **«Corregir por edad relativa»**, encendido por defecto.
- Vista de dispersión: valor contra edad decimal, con la recta esperada por edad. Lo que queda arriba de la recta es rendimiento por encima de lo esperado para su edad.
- Con n < 8 no se muestran percentiles, solo valores.

### 5.3 Cómo se corrige
Se sigue la lógica de los ajustes correctivos de Romann y Cobley (2015): restar el efecto esperado de la edad.
1. **Edad decimal** = (fecha de medición − fecha de nacimiento) / 365,25.
2. **Pendiente por edad** de cada métrica (cuánto cambia el valor por año de edad):
   - se estima con una **regresión robusta (Theil-Sen)** sobre todas las mediciones de **la misma escuela y el mismo deporte** en los últimos 12 meses, en todas las edades;
   - exige n ≥ 30 deportistas distintos que cubran al menos 3 años de edad;
   - si no se alcanza, **no se corrige**, y la vista lo dice: «no hay datos suficientes en tu escuela para corregir esta métrica».
   
   No se toman pendientes de otras escuelas (D-TAL-4).
3. **Valor corregido** = valor observado − pendiente × (edad decimal − edad decimal media de la categoría). Para métricas con `higher_is_better = false` se respeta el signo.
4. **Percentil corregido**: percentil del valor corregido dentro de la categoría.
5. **Auditoría de la lista:**
   - la vista de la lista muestra la distribución por trimestre de nacimiento de la lista frente a la de toda la categoría;
   - si T1 + T2 suman más del 70 % de la lista y la categoría está equilibrada (±10 puntos), aparece un aviso: «tu lista parece favorecer a los nacidos a comienzo de año».
   
   No bloquea, pero queda registrado.
6. **Maduración biológica.** Pesa además de la edad cronológica. Se puede estimar con estatura, talla sentado y peso (Mirwald et al., 2002) y usar para agrupar por maduración (*bio-banding*: Cumming et al., 2017). **No entra en la primera versión:** la talla sentado no se registra y el error de la ecuación es de alrededor de ±1 año en los extremos (D-TAL-5).

**Fecha de corte:**
- Configurable por escuela, en `school_settings` o con la categoría de la ficha si PAR-1 la define.
- **Por defecto, 1 de enero** (categorías por año de nacimiento).

## 6. Modelo de datos (propuesta, sin escribir)

Todas las tablas van con `school_id NOT NULL`, RLS activo, sujeto polimórfico como en `performance_entries` y estados con `text + CHECK`.

| Tabla | Columnas clave | Notas |
|---|---|---|
| `talent_criteria` | `id`, `school_id`, `name`, `sport`, `scope` jsonb (categoría o rango de nacimiento y posiciones), `min_rules_met` int, `window_days` int (por defecto 120), `age_adjusted` bool (por defecto true), `status` text CHECK (`activo`, `pausado`, `archivado`), `created_by` → `profiles` | Lo escribe la administración |
| `talent_criterion_rules` | `id`, `criterion_id`, `source` text CHECK (`media`, `atributo`, `prueba_fisica`, `metrica`, `neuro`, `asistencia`, `minutos`), `key` text, `operator` text CHECK (`>=`, `<=`, `percentil_cat_>=`, `delta_>=`, `banda_verde`), `value` numeric, `window_days` int (opcional) | Se crean y editan junto con el criterio en una RPC transaccional (`talent_guardar_criterio`) |
| `talent_signals` | `id`, `school_id`, `criterion_id`, `subject_type`, `subject_id`, `detected_at`, `period_key` text (semana ISO), `snapshot` jsonb (valores que cumplieron, con crudo y corregido), `status` text CHECK (`nueva`, `vista`, `descartada`, `agregada`), `reviewed_by` → `profiles`, `reviewed_at`, `dismiss_reason` text | `UNIQUE (criterion_id, subject_type, subject_id, period_key)`. Un criterio no dispara dos veces en la misma semana |
| `talent_watchlist` | `id`, `school_id`, `subject_type`, `subject_id`, `sport`, `status` text CHECK (`observacion`, `seguimiento`, `priorizado`, `cerrado`), `reason` text, `source_signal_id` (opcional), `owner_coach_id` → `profiles`, `next_review_on` date, `closed_reason` text CHECK (`promovido`, `sin_progreso`, `retiro`, `salio_de_la_escuela`, `otro`), `added_by` → `profiles`, `created_at`, `closed_at` | Índice único parcial `(school_id, subject_type, subject_id, sport) WHERE status <> 'cerrado'` |
| `talent_watchlist_events` | `id`, `entry_id`, `kind` text CHECK (`nota`, `cambio_estado`, `revision`, `objetivo`), `body` text, `from_status`, `to_status`, `author_id` → `profiles`, `created_at` | Solo se agregan filas: no hay `UPDATE` ni `DELETE` para `authenticated`. Es el historial del seguimiento |
| `athlete_data_consents` | `id`, `school_id`, `subject_type`, `subject_id`, `purpose` text CHECK (`talento_exportacion`, `neuro_pruebas`), `scope` jsonb (secciones, destinatario y vigencia, para exportación), `granted_by` → `profiles` (acudiente, o el deportista si es mayor), `channel` text CHECK (`app`, `registrado_por_staff`), `evidence_path` text (si lo registró el staff), `text_version` text, `granted_at`, `expires_at`, `revoked_at`, `revoked_by` | **Tabla genérica que también usa neuro.** Sin policies directas, solo por RPC (patrón de `payment_consents`) |
| `talent_exports` | `id`, `school_id`, `subject_type`, `subject_id`, `consent_id`, `recipient_name` text, `recipient_org` text, `purpose` text, `sections` text[], `snapshot` jsonb (foto congelada de la ficha), `token_hash` text UNIQUE (sha256 del token), `status` text CHECK (`borrador`, `esperando_consentimiento`, `activo`, `vencido`, `revocado`, `rechazado`), `expires_at`, `max_views` int (opcional), `view_count` int, `created_by` → `profiles`, `created_at`, `revoked_at`, `revoked_by` | Sin policies para `anon` ni `authenticated`. Todo por RPC. **El token en claro no se guarda**: se muestra una vez al crear y se puede regenerar |
| `talent_export_access_log` | `id`, `export_id`, `accessed_at`, `ip_hash`, `user_agent_short` | La escribe la RPC pública. Por RPC, la leen el staff de la escuela y el acudiente |

### 6.1 RLS: matriz de acceso

| Tabla | Staff de la escuela (`user_staff_school_ids`) | Admin (`user_admin_school_ids`) | Acudiente / deportista | `anon` |
|---|---|---|---|---|
| `talent_criteria` y `_rules` | Lee | Lee y escribe (por RPC) | — | — |
| `talent_signals` | Lee y cambia el estado (`vista`, `descartada` o `agregada`) | Igual | — | — |
| `talent_watchlist` y `_events` | Lee; crea y edita entradas y agrega eventos (D-TAL-2 define si el entrenador ve toda la escuela o solo sus equipos) | Todo, incluido cerrar | **Nada** (§7) | — |
| `athlete_data_consents` | Lee las de su escuela por RPC y registra con evidencia (`registrado_por_staff`) | Igual | Lee, otorga y revoca **las de sus hijos** (o las propias si es mayor) por RPC (`is_parent_of_child()`) | — |
| `talent_exports` | Crea el borrador y revoca (por RPC) | Igual | Ve las de sus hijos, aprueba, rechaza y revoca (por RPC) | Solo `get_talent_export(p_token)` |
| `talent_export_access_log` | Lee (por RPC) | Igual | Lee las de sus hijos (por RPC) | — |

**Forma de las policies.** Ejemplo de lectura del staff:
`USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]))`, con `TO authenticated` y sin
recursión.

**Escritura de la lista y los eventos:**
- se hace con `user_staff_school_ids()` y con `WITH CHECK` igual al `USING`, o con policies por comando;
- **nunca** con `user_school_ids()`, que incluye a padres y atletas (I2);
- `FOR ALL` no se usa.

**RPCs:**
- todas son `SECURITY DEFINER` con `search_path` fijo y validan **adentro** el alcance del caller sobre **ese** `school_id` y **ese** sujeto;
- `REVOKE ALL … FROM PUBLIC, anon, authenticated` y `GRANT EXECUTE … TO authenticated` explícito;
- solo `get_talent_export` lleva `GRANT EXECUTE … TO anon`.

**Antes de cerrar la fase T1:**
- listar todas las policies de cada tabla nueva (`pg_policies`);
- probar con sesiones simuladas: staff A, staff B, coach A, acudiente de un deportista de A, acudiente de otro, deportista y `anon`;
- correr `npm run seguridad:invariantes` y `npm run migrations:check`.

### 6.2 Flujo de la exportación para visoría
1. **El staff arma el borrador:**
   - destinatario (nombre y organización), propósito y vencimiento (**por defecto 14 días, máximo 30**);
   - secciones de la ficha que se envían. Por defecto:
     - página 1 y página 2 de la ficha;
     - **sin** datos de contacto, dirección, documento, pagos, salud, bienestar ni neuro.
     
     Neuro y la foto se incluyen solo si se marcan y el consentimiento los cubre.
   - El BFF congela el `snapshot`, que es exactamente lo que verá el destinatario.
2. **Pasa a `esperando_consentimiento`.** El acudiente recibe una notificación en la app (despachador unificado) y, si tiene WhatsApp con plantilla aprobada, un aviso. Ve:
   - la ficha exacta tal como se enviará;
   - el destinatario, el propósito y la vigencia;
   - el texto del consentimiento (versionado).
3. **El acudiente aprueba o rechaza.**
   - Al aprobar, se crea la fila en `athlete_data_consents` (`channel = 'app'`), la exportación pasa a `activo` y se genera el token. Son 32 bytes aleatorios en base64url y se guarda solo su sha256.
   - El staff copia el enlace `/visoria/:token`.
4. **Excepción, con la decisión D-TAL-7.** Si el acudiente no tiene cuenta:
   - el staff registra el consentimiento con evidencia adjunta (captura o documento firmado) y `channel = 'registrado_por_staff'`;
   - queda marcado así y el acudiente puede revocarlo si después crea su cuenta.
5. **La página pública:**
   - llama a `get_talent_export(p_token)`, que hashea el token, verifica estado, vencimiento y vistas, registra el acceso y devuelve **solo** el `snapshot`;
   - lleva la marca de agua «Preparado para <destinatario> · vence <fecha>» y el escudo del club;
   - no tiene navegación hacia la app y no es indexable (`noindex`).
   
   Vencida o revocada, solo dice «Este enlace ya no está disponible».
6. **Cuando se abre:**
   - el acudiente y el responsable ven el registro de aperturas;
   - el primer acceso genera un aviso al acudiente («la ficha de X fue abierta por primera vez»).
7. **Revocación:** el staff o el acudiente pueden revocar en cualquier momento, y la revocación vale de inmediato.
8. **Deportista mayor de edad:** él mismo aprueba, sin acudiente.

## 7. Privacidad de menores

**Marco:**
- Ley 1581 de 2012, art. 7: el tratamiento de datos de niños, niñas y adolescentes debe responder a su interés superior y respetar sus derechos fundamentales, con autorización del representante;
- Decreto 1377 de 2013, art. 12;
- Ley 1098 de 2006 (Código de la Infancia y la Adolescencia);
- la política de privacidad unificada de SportMaps se actualiza antes de T4 con la finalidad «seguimiento deportivo interno y exportación para visorías con autorización».

**Reglas:**
1. **Ningún dato entre escuelas.** Si el deportista se cambia de escuela, su historial de talento **no viaja**. La única portabilidad es la exportación que autoriza la familia.
2. **La etiqueta es interna.** El deportista y la familia **no ven** que están en la lista ni las señales. Etiquetar a un niño como talento, o como «no talento», cambia cómo lo trata su entorno. Lo que la familia sí ve es la ficha y su evolución (PAR-1), igual que todos.
3. **Minimización.** La exportación lleva por defecto solo lo deportivo. Salud, bienestar, pagos y datos de contacto nunca salen. Neuro y la foto, solo con marca explícita y consentimiento.
4. **Decisión humana.** Una señal no agrega a nadie a la lista sola, y un criterio no descarta a nadie. Cada cambio de estado queda en `talent_watchlist_events` con su autor.
5. **No discriminar.** Los criterios no pueden usar sexo, etnia, estrato, sede ni capacidad de pago. La fecha de nacimiento se usa **solo** para corregir (§5), nunca como regla.
6. **Retención (D-TAL-6).** Al salir el deportista de la escuela, su entrada se cierra con `salio_de_la_escuela`. A los 12 meses se borran las señales y los eventos de texto libre, y se conserva solo el agregado anónimo de estados. Las exportaciones vencidas se purgan a los 90 días, incluido el `snapshot`, pero se conservan el registro de consentimiento y el de accesos como prueba.
7. **Derecho de acceso.** El acudiente puede pedir a la escuela lo que hay sobre su hijo. La escuela lo genera desde la ficha y el historial de exportaciones. La lista interna se entrega si la ley lo exige; el texto de la política lo deja claro.

## 8. Alertas de progreso

Solo para quienes están en la lista y solo hacia el staff: el responsable y la administración. **Nunca** hacia el deportista o la familia.

| Alerta | Cuándo | Prioridad |
|---|---|---|
| Mejora relevante | Media, atributo o prueba con un cambio mayor al cambio mínimo relevante desde la última revisión | Normal |
| Estancamiento | 3 mediciones seguidas dentro de ± el cambio mínimo relevante en las métricas del criterio que lo trajo | Baja |
| Caída | Cambio negativo mayor al cambio mínimo relevante. Si hay bienestar (BOD-1B) con fatiga o dolor altos, se muestra al lado para leerlo bien | Alta |
| Revisión vencida | Se pasó `next_review_on` | Alta |
| Sin datos | Sin mediciones nuevas en 90 días | Normal |
| Nueva señal | Alguien que no está en la lista cumple un criterio | Normal |

**Entrega:**
- resumen semanal, junto con el lote del §4.3, por el despachador unificado;
- como máximo **un resumen por entrenador por semana**, salvo «revisión vencida», que puede ir en el día;
- la bandeja dentro de la app muestra todo.

## 9. Pantallas (V2 del entrenador y del dueño)

1. **Talento → Lista:** entradas por estado, dueño, próxima revisión y tendencia. Acciones:
   - abrir la ficha;
   - agregar una nota u objetivo;
   - cambiar el estado;
   - pedir exportación.
2. **Talento → Señales:** bandeja de sugerencias con el motivo exacto (valores crudos y corregidos). Acciones:
   - agregar a la lista;
   - descartar con motivo.
3. **Talento → Comparar:** la vista de §5 por categoría.
4. **Talento → Criterios** (solo admin): constructor de reglas con vista previa de «cuántos deportistas cumplirían hoy». La vista previa se calcula en el BFF.
5. **Talento → Exportaciones:** estado, vencimiento, aperturas y revocar.
6. **Acudiente → Solicitudes de autorización:** ver la ficha exacta y aprobar o rechazar. Desde ahí también ve sus autorizaciones vigentes y las aperturas.

**Gate:**
- el módulo se enciende por escuela con un flag en los módulos del menú;
- el cobro queda en D-TAL-8.

## 10. Fases

| Fase | Contenido | Pruebas | Criterio de salida |
|---|---|---|---|
| **T0: verificación (solo lectura)** | Consultas puntuales por nombre, sin `list_tables`, por escuela activa: % de deportistas con fecha de nacimiento, volumen de `performance_entries` en 12 meses por deporte, estado de PAR-1 (qué columnas de media, atributos y pruebas existen) y equipos con `age_group` nulo | — | Números anotados en este spec. Si la fecha de nacimiento está por debajo del 80 % en la escuela piloto, se planea una campaña de completado (carnet o constancias) antes de T2 |
| **T1: modelo y RLS** | Migración con las tablas de §6, las RPCs (`talent_guardar_criterio`, `talent_agregar_a_lista`, `talent_cambiar_estado`, `consent_*`, `talent_crear_export`, `talent_aprobar_export`, `talent_revocar_export` y `get_talent_export`) y los grants. Mostrada antes de aplicar y aplicada en un turno de DDL | SQL de RLS con sesiones simuladas (matriz de §6.1, incluido que `anon` no lea ninguna tabla y que un coach de B no vea a A). `seguridad:invariantes` sin CRÍTICAS. `migrations:check` | Todo verde. Revisión de las policies línea por línea |
| **T2: lista y comparación** | Lista de seguimiento manual, eventos, vista comparativa con edad relativa y auditoría por trimestre. Piloto en una escuela | Vitest de edad decimal, Theil-Sen, valor corregido (incluido `higher_is_better = false`), percentil con n mínimo y aviso de sesgo. Pruebas del BFF de alcance. Prueba de punta a punta: agregar, anotar, cerrar | El entrenador del piloto la usa 4 semanas y lleva ≥ 10 entradas con revisión |
| **T3: criterios, señales y alertas** | Constructor de criterios, lote semanal, recálculo por deportista y resumen de alertas | Vitest del evaluador de reglas (ventanas, cambio mínimo relevante, «sin datos», `min_rules_met`). Prueba del lote con 500 deportistas sintéticos: número de consultas constante y sin N+1. Prueba de deduplicación por `period_key` | Lote < 30 s por escuela piloto y 0 consultas por deportista. Señales revisadas por el entrenador con < 50 % de descartes en el primer mes (si no, se ajustan los criterios por defecto) |
| **T4: exportación con consentimiento** | Borrador, foto congelada, solicitud al acudiente, token con hash, página pública, registro de accesos, revocación y purga | Vitest del token (hash, vencimiento, máximo de vistas). Prueba de punta a punta completa: borrador → acudiente aprueba → abrir enlace → revocar → «ya no está disponible». Prueba de `anon` contra todas las tablas. Revisión de seguridad de la RPC pública (limitación de intentos y token no adivinable) | Política de privacidad actualizada y texto del consentimiento aprobado por el usuario |
| **T5: neuro y maduración** | Fuente `neuro` en reglas (cuando PAR-8 llegue a N4). Opcional: maduración y agrupación por maduración (D-TAL-5) | Las de cada pieza | Según D-TAL-5 |

## 11. Decisiones (con recomendación)

| # | Decisión | Recomendación |
|---|---|---|
| **D-TAL-1** | ¿Escuela piloto? | **Dynasty** (volumen y categorías) o **Carmel** (ya evalúa con el informe). Elegir la que tenga más fechas de nacimiento completas según T0 |
| **D-TAL-2** | ¿El entrenador ve la lista de toda la escuela o solo la de sus equipos? | **Toda la escuela** para leer, porque el seguimiento es colegiado. **Escribe** sobre las entradas de sus equipos o las que tiene asignadas. La administración, todo |
| **D-TAL-3** | ¿Talento arregla `sport_metric_thresholds` con un eje de edad? | **No.** Talento usa percentiles corregidos y umbrales por criterio. El eje de edad en las bandas va a MOD-10 |
| **D-TAL-4** | ¿La pendiente por edad se calcula con datos de otras escuelas? | **No.** Solo con los de la propia escuela. Si a futuro hay una referencia agregada y anónima (como D-NEU-3), se decide aparte |
| **D-TAL-5** | ¿Maduración biológica (Mirwald, agrupación por maduración)? | **Después**, en T5 y como opcional. Exige registrar talla sentado y explicar el error de la ecuación |
| **D-TAL-6** | ¿Retención al salir de la escuela? | Cerrar la entrada, borrar a los 12 meses las señales y el texto libre, y purgar las exportaciones vencidas a los 90 días. Conservar los registros de consentimiento y de acceso como prueba |
| **D-TAL-7** | ¿Se acepta el consentimiento registrado por el staff con evidencia (acudiente sin cuenta)? | **Sí, como excepción marcada y visible.** El camino principal es la aprobación en la app |
| **D-TAL-8** | ¿Cobro? | Incluido en un plan superior o como parte del addon de rendimiento (junto con D-BOD-7 y D-NEU-8). Piloto gratis |
| **D-TAL-9** | ¿La familia ve que su hijo está en seguimiento? | **No.** Es una herramienta interna. Se revisa si el piloto muestra que las familias lo piden; en ese caso, solo como «objetivos del entrenador», nunca como etiqueta |
| **D-TAL-10** | ¿Vencimiento por defecto del enlace de visoría? | **14 días**, máximo 30 y sin renovación automática. Renovar exige un consentimiento nuevo si cambia el destinatario |

## 12. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| La herramienta automatiza el efecto de edad relativa | Alta sin corrección | Alto | Corrección encendida por defecto, trimestre visible, auditoría de la lista y criterios sobre valores corregidos |
| Faltan fechas de nacimiento | Media | Alto | Verificación en T0 y campaña de completado. Sin fecha, la vista lo marca y el deportista queda fuera de los percentiles corregidos |
| Pocos datos por categoría: percentiles inestables | Alta en escuelas chicas | Medio | n ≥ 8 para percentiles, n ≥ 30 para la pendiente y «sin datos» explícito |
| Señales ruidosas que el entrenador ignora | Media | Medio | Cambio mínimo relevante obligatorio, deduplicación semanal, métrica de descartes en T3 y criterios por defecto conservadores |
| Fuga de la ficha de un menor por el enlace | Baja | Alto | Token de 32 bytes con hash, vencimiento, revocación, máximo de vistas, registro de accesos, aviso al acudiente, `noindex` y foto congelada sin contacto ni salud |
| Consentimiento débil (registrado por el staff) | Media | Medio | Evidencia obligatoria, marca visible y revocable por el acudiente |
| La etiqueta «talento» se filtra a la familia o al niño | Media | Medio | Sin RLS para la familia, sin notificaciones hacia la familia y política de staff |
| Se confunde con D4 (*scouting* entre escuelas) | Media | Alto (legal) | Fuera de alcance explícito: cualquier visibilidad entre escuelas exige su propio spec y consentimiento |
| PAR-1 cambia la forma de la media o de los atributos | Media | Medio | Talento lee la ficha por una vista o RPC de PAR-1, no por sus columnas internas. La foto congelada guarda los valores, no referencias |
| IO del lote semanal | Baja | Medio | Lectura en bloque, una escritura por lote, sin triggers y a la hora de menos carga |

## 13. Referencias
- Cobley, S., Baker, J., Wattie, N., y McKenna, J. (2009). Annual age-grouping and athlete development: a meta-analytical review of relative age effects in sport. *Sports Medicine*, 39(3), 235–256.
- Cumming, S. P., Lloyd, R. S., Oliver, J. L., Eisenmann, J. C., y Malina, R. M. (2017). Bio-banding in sport: applications to competition, talent identification, and strength and conditioning of youth athletes. *Strength and Conditioning Journal*, 39(2), 34–47.
- Güllich, A., Macnamara, B. N., y Hambrick, D. Z. (2022). What makes a champion? Early multidisciplinary practice, not early specialization, predicts world-class performance. *Perspectives on Psychological Science*, 17(1), 6–29.
- Helsen, W. F., van Winckel, J., y Williams, A. M. (2005). The relative age effect in youth soccer across Europe. *Journal of Sports Sciences*, 23(6), 629–636.
- Hopkins, W. G. (2000). Measures of reliability in sports medicine and science. *Sports Medicine*, 30(1), 1–15.
- Johnston, K., Wattie, N., Schorer, J., y Baker, J. (2018). Talent identification in sport: a systematic review. *Sports Medicine*, 48(1), 97–109.
- Mirwald, R. L., Baxter-Jones, A. D. G., Bailey, D. A., y Beunen, G. P. (2002). An assessment of maturity from anthropometric measurements. *Medicine & Science in Sports & Exercise*, 34(4), 689–694.
- Musch, J., y Grondin, S. (2001). Unequal competition as an impediment to personal development: a review of the relative age effect in sport. *Developmental Review*, 21(2), 147–167.
- Romann, M., y Cobley, S. (2015). Relative age effects in athletic sprinting and corrective adjustments as a solution for their removal. *PLoS ONE*, 10(4), e0122988.
- Vaeyens, R., Lenoir, M., Williams, A. M., y Philippaerts, R. M. (2008). Talent identification and development programmes in sport: current models and future directions. *Sports Medicine*, 38(9), 703–714.
- Colombia: Ley 1581 de 2012, Decreto 1377 de 2013 y Ley 1098 de 2006.

> Antes de publicar material comercial, verificar cada referencia contra la fuente original. Se citaron de memoria.
