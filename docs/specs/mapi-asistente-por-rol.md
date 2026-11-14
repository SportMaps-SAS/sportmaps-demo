# Spec — Mapi: asistente por rol (soporte, buscador y acciones)

> Estado: **aprobado** · decisiones resueltas 2026-10-27 (§12) · amplía MOD-21 (soporte in-app).
> Origen: caso de soporte de Robert Herrera (Club Carmel, 2026-10-27). Mapi le dijo
> «hasta 7 días» cuando su escuela tiene 90, y no reconoció que «solo me sale ayer
> y hoy» era una falla. El arreglo fue el commit `3e8cdac6`.

## 1. Qué queremos

Un solo asistente, Mapi, que para cada persona sepa **quién es, en qué escuela está y
qué puede y qué no puede hacer**, y que sirva para tres cosas:

| Modo | Ejemplo | Quién |
|---|---|---|
| **Soporte** | «¿Cómo cargo la asistencia del sábado?» · «No me deja subir la asistencia» | Todos |
| **Consulta / buscador** | «¿Cuánto debe Juan Pérez?» · «Asistencias de la 2018-19 en abril» · «¿Quién no ha pagado octubre?» | Admin, entrenador; acudiente y deportista solo sobre lo suyo |
| **Acciones** | «Envía recordatorio de pago a los que deben octubre» · «Genera el reporte de abril» · «Avisa a la 2020-21 que mañana no hay entreno» | Admin; entrenador sobre sus equipos |

Mapi aparece en tres lugares: el chat de soporte que ya existe (FAB), un **buscador
global** (barra arriba / `Ctrl+K`) y un panel de asistente para el admin.

## 2. Lo que ya existe y se reusa (no se construye de nuevo)

| Pieza | Dónde | Para qué la usamos |
|---|---|---|
| Orquestador con herramientas y fallback de proveedores | `bff/src/services/llm.service.ts` (`chatWithTools`) | El cerebro de los tres modos |
| Bot de soporte in-app | `bff/src/services/inapp-support-bot.service.ts` | Modo soporte; se le agregan ficha, clasificación y seguimiento |
| Contexto del usuario | `bff/src/services/mapi-contexto.service.ts` | Se amplía a la **ficha por rol** (§3) |
| Mapa de la app por rol | `bff/src/data/app-map.ts` | Rutas exactas de menús; también alimenta el buscador de pantallas |
| Diagnóstico de usuario | `support-diagnosis.service.ts` (`buildUserState`) | Herramienta `get_my_state` |
| Cartera / quién debe | `informe-cartera.service.ts`, RPC `wa_get_payment_status` | Consultas de deuda |
| Recordatorios de cobro | `recordatorios-cobro.service.ts` | Acción «enviar recordatorio» |
| Despachador de notificaciones | `notification.service.ts` | Acción «avisar a un equipo» (push + correo + WhatsApp) |
| Informes del atleta | `report-snapshot`, `report-delivery`, `report-access` | Acción «genera / envía informe» |
| Asistencia por WhatsApp del staff | `whatsapp-asistencia-staff.service.ts` | Mismo guardado (`guardarSesionAsistencia`) si se habilita «registrar asistencia» por chat |
| Consumo de LLM | `llm_usage` + `llm-usage.service.ts` | Topes por escuela y reporte de costo |
| Pruebas de seguridad del LLM | `seguridad-llm-*.poc.test.ts` | Se extienden a cada herramienta nueva |

## 3. La ficha: lo que Mapi sabe de quien le habla

No se le pasa al modelo **toda** la configuración de la escuela. Recibe una ficha corta
(10 a 15 frases), armada en el BFF para **ese rol**, con lo que cambia lo que la persona
ve y puede hacer. Cada línea sale de un dato real de la base.

Ejemplo para un entrenador (Robert):

```
USUARIO: Robert Herrera · entrenador · Club Carmel
Equipos que dirige: Categoría 2018-19, Categoría 2020-21
Reglas de su escuela:
- Puede cargar asistencia hasta 90 días atrás (el estándar es 7).
- Puede crear sus propios equipos, pero no cambiar quién los entrena.
- Puede dar de alta deportistas.
- La escuela no cobra mensualidades por la app.
Módulos apagados: Tienda, Reservas
```

### 3.1 Qué entra por rol

| Rol | Entra en la ficha | NO entra nunca |
|---|---|---|
| **Admin / owner** | Plan (tier) y add-ons; módulos; cobros (activos, día de corte, mora y recargo, pasarelas activas sin llaves); ventanas (asistencia del coach); permisos delegados a coaches; nº de sedes, equipos y deportistas; pendientes (pagos por revisar, prospectos, inscripciones sin monto) | Llaves de pasarela, tokens, datos de otras escuelas |
| **Entrenador** | Sus equipos y planes; ventana de asistencia; qué le delega la escuela (crear equipos o atletas, ver pagos o no: `coach_hide_financial_info`; registrar asistencia por Mapi: `coach_mapi_attendance`; enviar avisos a sus equipos por Mapi: `coach_mapi_notices`); módulos | Montos y deudas si la escuela se los oculta; configuración de cobros; cartera, recordatorios de cobro e ingresos (nunca, aunque la escuela le muestre pagos) |
| **Acudiente** | Sus hijos, con equipo, categoría, plan y estado; si la escuela cobra por la app y por qué medios; pagos pendientes; consentimientos | Datos de otros deportistas; configuración interna |
| **Deportista** | Su inscripción, plan, saldo de clases u horas, próximas sesiones | Lo mismo que el acudiente |
| **Otros** (tienda, profesional de salud, organizador, sede) | Su módulo y su estado | — |
| **Super admin (SportMaps)** | Ficha de la escuela consultada + estado de salud (§8) | — |

### 3.2 Reglas de la ficha

- **Una línea por regla, con su texto por rol.** Cada regla nueva del producto (como
  `coach_attendance_retro_days`) se registra en un catálogo
  (`bff/src/data/mapi-reglas.ts`) con: qué columna lee, a qué roles aplica y cómo se
  dice. Así no hay que tocar el prompt.
- **1 o 2 consultas por turno**, filtradas por `school_id`, con caché de 5 minutos por
  usuario. No lee catálogo ni hace una consulta por regla (Disk IO).
- **Lo que no está en la ficha se consulta**: herramienta `consultar_regla_escuela(clave)`,
  limitada a las claves del catálogo.
- **Corrige el bug actual:** `mapi-contexto.service.ts` busca los equipos que dirige el
  coach con `teams.coach_id = auth uid`, pero `coach_id` guarda `school_staff.id`. Hoy
  solo encuentra los equipos donde el coach es adicional.

## 4. Herramientas (lo que Mapi puede consultar y hacer)

### 4.1 Principio de seguridad (no negociable)

1. **El permiso lo aplica el servidor, no el prompt.** Cada herramienta llama al mismo
   servicio o endpoint del BFF que usa la pantalla, con el mismo chequeo de rol
   (`assertCoachHasTeamAccess`, `requireRole`, etc.). Si la pantalla no lo deja, Mapi
   tampoco.
2. **El `school_id` y el usuario salen de la sesión, nunca de los argumentos del
   modelo.** El modelo no puede pedir datos de otra escuela, aunque el texto se lo diga.
3. **No hay SQL libre.** El modelo no escribe consultas. Solo elige herramientas con
   parámetros validados: fechas, ids que pertenecen a la escuela, enums. Así se evitan
   fugas entre escuelas, consultas que funden el Disk IO e inyección.
4. **Todo lo que escriben los usuarios es dato, no instrucción**: nombres de
   deportistas, mensajes, notas. Ya está en las reglas del prompt; se prueba con
   `seguridad-llm-mapi.poc.test.ts`.

### 4.2 Catálogo

**Consulta (solo lectura, se ejecuta sin confirmar):**

| Herramienta | Admin | Coach | Acudiente / deportista | Reusa |
|---|:-:|:-:|:-:|---|
| `buscar` (personas, equipos, pagos, pantallas) | ✔ | sus equipos | lo suyo | RPC nueva `mapi_buscar` + `app-map` |
| `estado_de_cuenta(persona)` | ✔ | si la escuela le muestra pagos | lo suyo | `wa_get_payment_status`, `informe-cartera` |
| `cartera(periodo, equipo?)` — quién debe | ✔ | ✘ | ✘ | `informe-cartera.service` |
| `asistencia(equipo/persona, desde, hasta)` | ✔ | sus equipos | lo suyo | lecturas de `attendance.ts` |
| `quien_falta_mucho(equipo, periodo)` | ✔ | sus equipos | ✘ | `faltanMucho` (asistencia V2) |
| `ingresos(periodo)` | ✔ | ✘ | ✘ | las tres agregaciones de ingreso (usar la canónica) |
| `inscripciones(estado, equipo?)` | ✔ | sus equipos | ✘ | `enrollments` |
| `pendientes_de_revision` (comprobantes, prospectos) | ✔ | ✘ | ✘ | bandejas existentes |
| `mi_estado`, `buscar_ayuda`, `consultar_regla_escuela` | ✔ | ✔ | ✔ | ya existen / §3 |

**Acciones (siempre con vista previa y confirmación, §5):**

| Herramienta | Admin | Coach | Reusa |
|---|:-:|:-:|---|
| `enviar_recordatorio_pago(filtro)` | ✔ | ✘ | `recordatorios-cobro.service` |
| `enviar_aviso(equipo/grupo, texto, canal)` | ✔ | sus equipos, si `coach_mapi_notices` | `notification.service` |
| `generar_reporte(tipo, periodo, formato)` | ✔ | sus equipos (asistencia, rendimiento) | endpoints de reportes + exportación CSV/PDF |
| `enviar_informe_atleta(atleta/equipo, mes)` | ✔ | sus equipos | `report-delivery.service` |
| `registrar_asistencia(equipo, fecha, lista)` | ✔ | sus equipos, si `coach_mapi_attendance` | `guardarSesionAsistencia` (misma ventana retroactiva de la escuela) |
| `escalar_a_soporte` | ✔ | ✔ | ya existe |

`coach_mapi_attendance` y `coach_mapi_notices` son columnas nuevas de `school_settings`
(boolean, default `true`), delegables igual que `coach_hide_financial_info`. El chequeo
va en el servidor: con el permiso apagado, la herramienta no se le ofrece al modelo y,
si igual llega la llamada, se rechaza.

**Acudiente — pagar desde el chat:** herramienta `enlace_de_pago(cobro)` que devuelve
el enlace al flujo de pago existente (modal de pagos o link del QR `/join/<slug>`).
Mapi nunca ejecuta un cobro, no recibe ni muestra datos de tarjeta o cuenta, y no
genera montos: el enlace apunta al cobro que ya existe.

**Fuera de alcance de Mapi** (se hacen en pantalla): borrar datos, cambiar precios,
anular o editar pagos, cambiar roles o permisos, configurar pasarelas. Son
irreversibles, mueven plata u otorgan permisos.

### 4.3 Reportes («genera un reporte de abril»)

- Mapi entiende el pedido y lo traduce a `generar_reporte(tipo, periodo, formato)`.
  Tipos iniciales: **asistencia**, **cartera**, **ingresos**, **inscripciones**,
  **informes de rendimiento enviados**.
- Si el pedido es ambiguo, pregunta. «Abril» → ¿2026? ¿Todos los equipos o uno?
- El resultado es un **resumen en el chat** (3 a 5 cifras clave) más un **archivo
  descargable** (CSV y PDF). No se pega una tabla larga en el chat.
- Los números salen del mismo cálculo que la pantalla de reportes. Si la pantalla y Mapi
  dieran cifras distintas, el error está en Mapi.

## 5. Acciones: vista previa → confirmar → ejecutar → auditar

```
Admin: «envía recordatorio a los que deben octubre»
Mapi:  Encontré 23 familias con octubre pendiente ($2.760.000).
       Les llegaría por WhatsApp y correo:
       «Hola {acudiente}, la mensualidad de octubre de {deportista} …»
       [Ver lista] [Enviar a los 23] [Cancelar]
Admin: [Enviar a los 23]
Mapi:  Enviado: 21 por WhatsApp y correo, 2 solo por correo (sin teléfono).
```

- **El modelo nunca ejecuta una acción en el mismo turno en que la propone.** La
  herramienta devuelve un *borrador* con un id y un hash del contenido. Solo el botón
  «Confirmar» (no un texto del usuario) lo ejecuta, y si el borrador cambió se rechaza.
- **Topes**: máximo de destinatarios por acción (configurable, 300 por defecto) y una
  acción masiva igual por día y por escuela, para no repetir envíos. El **volumen
  mensual** (destinatarios por mes, reportes por mes) escala por tier. Al llegar al tope,
  Mapi lo dice y ofrece la ampliación de paquete; la función no se bloquea por plan.
- **Idempotencia**: confirmar dos veces el mismo borrador no envía dos veces.
- **Auditoría**: cada acción queda en `audit_logs` con quién, qué, a cuántos y el
  borrador original.
- Las acciones respetan los mismos filtros que la pantalla: mora sin cancelar,
  pausados por vacaciones fuera, becados sin cobro, etc.

## 6. Buscador global

Una barra (`Ctrl+K` en escritorio, ícono de lupa en móvil) con tres tipos de resultado
en la misma lista:

1. **Pantallas** — «asistencia» → *Asistencias*, *Supervisión* (desde `app-map`, sin LLM,
   instantáneo).
2. **Registros** — «juan pé» → Juan Pérez (deportista, 2018-19), su pago de octubre,
   su ficha (RPC `mapi_buscar`, sin LLM, con índice trigram por escuela y respetando RLS).
3. **Preguntarle a Mapi** — si lo escrito es una pregunta («cuánto debe juan pérez»), la
   última opción es «Preguntarle a Mapi» y abre el panel con la respuesta.

Las dos primeras no gastan LLM. Solo se llama al modelo cuando la persona elige
preguntar.

## 7. Soporte: clasificar, preguntar y hacer seguimiento

### 7.1 Cada caso se clasifica

| Tipo | Ejemplo | Qué pasa |
|---|---|---|
| **Informativo** | «¿Cómo cargo la asistencia?» | Responde con la ruta exacta y la regla de SU escuela. Fin. |
| **Falla** | «No me deja», «antes podía», error en pantalla | Pide lo que falta (pantalla, fecha, qué sale, captura) → abre caso técnico (§7.3) |
| **Dato a corregir** | Cobro duplicado, acceso, inscripción mal | Pide los datos → caso para el admin de la escuela o para SportMaps |
| **Pedido nuevo** | «Sería bueno que…» | Lo registra en el backlog y lo dice así, sin prometer fecha |

Señal clave: si el usuario dice que lo que Mapi explicó **no coincide con lo que ve**, es
una falla, no una duda. Así fue el caso de Robert.

### 7.2 Seguimiento

- Después de responder un caso informativo, pregunta «¿te funcionó?». Si dice que sí, lo
  cierra; si dice que no, lo reclasifica como falla.
- Cuando se publica un arreglo, Mapi le escribe al usuario «ya quedó, haz esto» y le
  pide confirmar.
- Casos sin respuesta del usuario en 48 h: un recordatorio y luego se cierran solos.

### 7.3 Casos técnicos con Claude

1. **Diagnóstico automático.** Una rutina programada de Claude (cada 15 min) toma los
   casos *falla* y *dato*. Lee el ticket, consulta la base y revisa el código. Deja una
   **nota interna** en el ticket con la causa, el arreglo propuesto, el alcance (a quién
   más afecta) y un borrador de respuesta. Para la base usa un **usuario de base de datos
   propio, de solo lectura**, sin acceso a llaves de pasarela, tokens ni al bucket
   `identity-documents`.
2. **Arreglo.** Si es código: rama `hotfix/*` **desde `main`** (no desde `develop`),
   arreglo, tests y PR hacia `main`, enlazado en la nota. Así, aprobar un arreglo no
   publica cambios de `develop` que nadie revisó. Después del merge, el hotfix se lleva
   también a `develop`.
3. **Aprobación humana (un clic).** El clic aprueba el PR; la salida a producción sigue
   el flujo de release habitual. Cualquier SQL que escriba datos o cualquier migración
   también requiere aprobación, porque la base es una sola para todos los ambientes.
   Aviso del PR:
   - **WhatsApp** corto con el enlace, solo si la falla afecta a varios usuarios o a una
     escuela con plan pago.
   - **Correo diario** con el resto de PRs pendientes y los casos cerrados.
4. **Cierre.** Al publicarse: verificación en producción, respuesta al usuario, ticket
   resuelto y resumen semanal (casos, tiempo de resolución, causas repetidas).

## 8. Super admin (SportMaps)

El mismo asistente, con alcance de plataforma y sin acciones masivas:
«¿qué escuelas no han tomado asistencia esta semana?», «¿qué escuelas tienen pagos sin
revisar hace más de 5 días?», «estado de Dynasty». Reusa `informe-calidad-bot` y el
diagnóstico de soporte.

## 9. Costo y proveedor

- **Claude es el proveedor principal de Mapi**; Groq/Gemini quedan de respaldo en
  `llm.service`. Mapi deja de consumir la cuota de Groq que usan los bots de WhatsApp en
  producción. Reparto por costo:
  - **Haiku**: clasificación de casos y soporte informativo.
  - **Sonnet**: turnos con herramientas (consultas, reportes y acciones).
- `llm_usage` registra el **modelo usado en cada turno** (Haiku o Sonnet) para medir el
  costo por modo. Si la tabla no tiene la columna, va en la migración del bloque 1.
- Todo va incluido en todos los planes, con **tope de volumen por escuela** en
  `llm_usage` y aviso al 80 %. Superar el tope se ofrece como ampliación de paquete.
- El buscador (§6) no gasta LLM en pantallas ni registros.

## 10. Fases

Se construye de corrido, en este orden, con revisión al cerrar cada bloque.

La cobranza va adelante: es lo que más le ahorra a la escuela.

| # | Bloque | Entrega | Criterio de aceptación |
|---|---|---|---|
| **1** | Ficha por rol + bug de equipos + Claude como proveedor | `mapi-reglas.ts` (con `coach_mapi_attendance` y `coach_mapi_notices`), ficha en `mapi-contexto`, `consultar_regla_escuela`, Haiku/Sonnet en `llm.service`, modelo por turno en `llm_usage` | Batería de 30 preguntas reales por rol (incluido el caso Robert) con la regla de la escuela correcta; Mapi ya no consume la cuota de Groq |
| **2** | Clasificación y seguimiento en soporte | Tipo de caso en `support_tickets`, preguntas antes de escalar, «¿te funcionó?», cierre automático | Robert habría quedado clasificado como *falla* con pantalla y fecha |
| **3a** | Cartera y estado de cuenta | `cartera`, `estado_de_cuenta`, `enlace_de_pago` (acudiente) + panel del asistente | Cada cifra coincide con la pantalla de cartera; pruebas de cruce entre escuelas en rojo → verde |
| **6a** | Recordatorio de pago | `enviar_recordatorio_pago` con vista previa, confirmación, topes por tier y auditoría | Doble confirmación no duplica; respeta mora, pausas y becados |
| **3b** | Resto de consultas | Asistencia, quién falta mucho, ingresos, inscripciones, pendientes | Cada cifra coincide con su pantalla |
| **4** | Buscador global | Barra `Ctrl+K`, RPC `mapi_buscar`, opción «Preguntarle a Mapi» | < 300 ms para pantallas y registros; sin resultados de otra escuela |
| **5** | Reportes | `generar_reporte` con CSV/PDF | «Reporte de asistencia de abril» = mismo número que la pantalla |
| **6b** | Resto de acciones | Aviso a equipo, informe del atleta, registrar asistencia (admin y coach con permiso) | Con el permiso apagado, el coach no puede aunque lo pida; auditoría verificada |
| **7** | Casos técnicos con Claude | Rutina de diagnóstico (usuario de BD de solo lectura), notas internas, PR `hotfix/*` desde `main`, avisos (WhatsApp / correo diario), cierre con aviso | Un caso tipo Robert llega a PR en < 30 min sin intervención; en una muestra revisada de casos, el diagnóstico acierta la causa raíz en **≥ 80 %** |
| **8** | Super admin | Consultas de plataforma | — |

Base de datos: las migraciones previstas son las columnas `coach_mapi_attendance` y
`coach_mapi_notices` en `school_settings` y el modelo por turno en `llm_usage` (bloque 1),
la clasificación del ticket (bloque 2), la tabla de borradores de acciones (bloque 6a),
la RPC `mapi_buscar` con su índice (bloque 4) y el rol de base de datos de solo lectura
de la rutina (bloque 7). Estados en `text + CHECK`, funciones con `search_path` fijo,
`GRANT` explícito y `seguridad:invariantes` antes de cerrar cada bloque.

## 11. Cómo medimos

- % de casos resueltos sin humano (hoy no se mide; meta inicial 60 %).
- Tiempo de primera respuesta útil y tiempo hasta el arreglo en casos de falla.
- % de respuestas con el dato de la escuela correcto (batería del bloque 1, corrida semanal
  con tope de cuota).
- Uso del buscador y de acciones por escuela; costo LLM por escuela.

## 12. Decisiones (resueltas 2026-10-27)

1. **Planes:** soporte y consultas van incluidos en todos los planes, con tope de
   volumen por escuela en `llm_usage`. Las acciones masivas también van en todos los
   planes, pero el volumen escala por tier (destinatarios por mes, reportes por mes).
   Superar el tope se ofrece como ampliación de paquete, no como función bloqueada.
   Motivo: SportMaps se vende como agente de IA todo incluido; cobrar aparte por
   preguntar contradice esa propuesta.

2. **Acciones del coach:** puede registrar asistencia y enviar avisos a sus equipos,
   siempre con vista previa y confirmación (§5). Es un permiso delegable por escuela,
   igual que `coach_hide_financial_info`:
   - `coach_mapi_attendance`: encendido por defecto.
   - `coach_mapi_notices`: encendido por defecto, la escuela lo puede apagar.
   El coach sigue sin acceso a cartera, recordatorios de cobro ni ingresos.

3. **Proveedor:** Claude es el proveedor principal de Mapi. Groq/Gemini quedan de
   respaldo en `llm.service`. Mapi deja de consumir la cuota de Groq que usan los bots
   de WhatsApp en producción. Reparto por costo:
   - Haiku: clasificación de casos y soporte informativo.
   - Sonnet: turnos con herramientas (consultas, reportes y acciones).

4. **Acudiente:** puede pagar desde el chat solo mediante un enlace al flujo de pago
   existente (modal de pagos o link del QR `/join/<slug>`). Mapi nunca ejecuta un
   cobro ni maneja datos de pago. Se mantiene la regla de §4.2: Mapi no mueve plata.

5. **Aviso de PR:**
   - WhatsApp corto con enlace al PR solo si la falla afecta a varios usuarios o a una
     escuela con plan pago.
   - Resumen diario por correo con el resto de PRs pendientes y casos cerrados.

### Cambios derivados (ya aplicados en este documento)

- **§7.3:** los arreglos de casos técnicos salen de `main` en una rama `hotfix/*`, no
  de `develop`, para que aprobar un arreglo no publique cambios no revisados de
  `develop`. El clic aprueba el PR y la salida a producción sigue el flujo de release
  habitual. La rutina de diagnóstico usa un usuario de base de datos propio, de solo
  lectura, sin acceso a llaves, tokens ni `identity-documents`.
- **§10:** se adelanta la cobranza: 1 · 2 · 3a · 6a · 3b · 4 · 5 · 6b · 7 · 8.
- **§10, bloque 7:** criterio de calidad sumado: en una muestra revisada de casos, el
  diagnóstico acierta la causa raíz en al menos el 80 %.
- **§3.1 y §4.2:** `coach_mapi_attendance` y `coach_mapi_notices` en la ficha del coach,
  en el catálogo `mapi-reglas.ts` y como condición de sus herramientas.
- **§9:** `llm_usage` registra el modelo usado por turno (Haiku o Sonnet) para medir el
  costo por modo.
