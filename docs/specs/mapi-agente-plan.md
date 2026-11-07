# Plan — Mapi agente: el motor y las primeras herramientas

> Estado: **propuesta 2026-10-30, con los complementos integrados; pendiente de
> aprobación.** Desarrolla §4 y §5 de [`mapi-asistente-por-rol.md`](mapi-asistente-por-rol.md)
> (aprobado 2026-10-27).
> Origen: el usuario quiere que Mapi «funcione como Claude Code: uno le da la
> instrucción —recordatorios de pago, excusar a un deportista, el reporte de una
> niña— y él la realiza».
> Los valores marcados *(propuesta)* son puntos de partida, no decisiones (§16).

## 1. Qué ve el usuario

```
Admin: excusa a Mariana del 3 al 10, se va de vacaciones
Mapi:  Encontré a Mariana López (Sub-12, equipo Tiburones).
       ┌──────────────────────────────────────────────────┐
       │ Excusar a Mariana López                          │
       │ Del lunes 3 al lunes 10 de noviembre de 2026     │
       │ Motivo: viaje · 8 días · 4 sesiones              │
       │ El entrenador la verá «excusada» en la lista.    │
       │ No descuenta clases ni toca cobros.              │
       │ Puedes quitar la excusa después.                 │
       │              [Confirmar]  [Cancelar]             │
       └──────────────────────────────────────────────────┘
Admin: [Confirmar]
Mapi:  Mariana López quedó excusada del 3 al 10 de noviembre de 2026.   ← lo escribe el servidor
```

```
Admin: (con la ficha de Sofía abierta) dame el reporte de esta niña
Mapi:  Sofía Ruiz · Sub-10 · plan mensual
       Octubre: 9 de 12 sesiones (2 faltas, 1 excusada).
       Debe octubre: $120.000, vencido hace 5 días.
       Última evaluación: 14 oct, 4,2/5.
```

```
Admin: mándale recordatorio a los que deben octubre
Mapi:  23 familias deben octubre ($2.760.000). 21 por WhatsApp, 2 por correo.
       Esto no se puede deshacer.
       [Ver lista]  [Enviar a las 23]  [Cancelar]
```

## 2. Cómo funciona: el mismo ciclo que Claude Code

1. La persona escribe en el chat de Mapi (el FAB que ya existe).
2. El BFF arma el turno: instrucciones fijas, **solo las herramientas que ese rol
   puede usar en esa escuela**, la ficha del usuario (§3 del spec), la fecha de hoy y
   la pantalla en la que está.
3. Claude decide qué herramientas usar. Las de **consulta** se ejecutan de una y el
   resultado vuelve al modelo. Puede encadenar varias (buscar → resumir) y pedir
   varias a la vez.
4. Las herramientas que **cambian algo** no ejecutan: crean un **borrador** con la
   vista previa y el turno termina con la tarjeta de confirmación.
5. El botón **Confirmar** ejecuta el borrador **sin pasar por el modelo**: el servidor
   revalida permisos con el rol **actual**, **vuelve a preparar** la acción y la compara
   con la vista previa que vio la persona (§10.1). Si coincide, ejecuta una sola vez y
   deja auditoría. Si cambió, muestra la vista previa nueva y pide confirmar otra vez.

La diferencia con Claude Code: Mapi no tiene SQL ni terminal. Solo tiene herramientas
con nombre, con los permisos de quien le habla. Su «¿permito esta acción?» es el
botón Confirmar.

## 3. Arquitectura

### 3.1 Piezas nuevas en el BFF (`bff/src/services/mapi-agente/`)

| Archivo | Qué hace |
|---|---|
| `agente.ts` | Ciclo del agente con bloques nativos `tool_use` / `tool_result`, sobre `client.beta.messages` del SDK (`@anthropic-ai/sdk` 0.135, ya instalado; ahí están tipados `output_config.effort`, `fallbacks` y `strict`, ver §18). Tope de 6 rondas por turno. |
| `registro.ts` | Catálogo de herramientas. Cada una declara roles, flag de escuela que la habilita y su esquema (`strict: true`). Filtra lo que se le ofrece al modelo y **vuelve a chequear al ejecutar**. |
| `herramientas/*.ts` | Una por archivo. Las de consulta exponen `ejecutar(ctx, args)`; las acciones exponen `preparar(ctx, args)` (vista previa, sin efectos), `ejecutar(ctx, borrador)` y las plantillas fijas de la tarjeta y del resultado (§10.3). |
| `borradores.ts` | Crear, reclamar, confirmar, cancelar y vencer borradores (§10). |
| Rutas: `POST /api/v1/mapi/acciones/:id/confirmar` y `/cancelar` | Lo que llaman los botones. |

**Por qué un ciclo propio y no `chatWithTools`:** `chatClaude` en `llm.service.ts`
aplana el resultado de cada herramienta como texto del usuario, porque el bot de
WhatsApp no reenvía el `tool_use`. Sirve para una o dos rondas, pero un agente que
encadena y paraleliza herramientas necesita los bloques nativos. `llm.service` sigue
igual para WhatsApp y para el modo soporte.

### 3.2 Modelo, costo y encendido

- **`claude-sonnet-5-5`** en los turnos con herramientas (decisión §12.3 del spec),
  esfuerzo `medium`, con `fallbacks: 'default'` (beta `server-side-fallback-2026-07-01`)
  para que una negativa del modelo no deje el turno vacío.
- **Sin respaldo a Groq/Gemini en modo agente.** Si Claude no responde, Mapi contesta
  en modo soporte y sin herramientas de escritura. Un proveedor de respaldo con
  acciones es un segundo agente que nadie probó.
- **Caché de prompt:** las herramientas y las instrucciones son el prefijo estable. La
  ficha, la fecha y la pantalla van **después** del corte, en el mensaje del turno; si
  fueran en el sistema, cada usuario rompería la caché.
- `llm_usage` registra la función nueva y el modelo de cada turno (su `feature` tiene
  CHECK: va en la migración).
- El modo agente se activa por escuela con `school_settings.mapi_agent_enabled`
  (default `false`) y tiene un apagado global por variable de entorno (§13.1).
- Topes de turnos y de costo en §13.2.

### 3.3 «Esta niña»: el contexto de pantalla

El front manda con cada mensaje `{ ruta, entidad?: { tipo: 'deportista' | 'equipo' | 'cobro', id } }`.
El BFF valida que el id sea de la escuela de la sesión antes de dárselo al modelo.

### 3.4 Seguridad (reglas del spec §4.1, aplicadas)

- `school_id` y usuario salen de la sesión, nunca de los argumentos del modelo.
- Todo id que proponga el modelo se valida contra la escuela y, si es un coach, contra
  sus equipos (`idsDeCoach`, que ya lee bien `school_staff.id`; el bug de §3.2 del
  spec **ya está corregido**).
- Nombres, notas y mensajes de usuarios son datos: se amplía
  `seguridad-llm-mapi.poc.test.ts` con cada herramienta.
- Las acciones respetan los mismos filtros que la pantalla: bajas, pausas, becados,
  duplicados y mora sin cancelar.
- El texto de la tarjeta y el mensaje de «Listo» salen del servidor, nunca del modelo
  (§10.3).
- El resumen que recibe el modelo excluye datos que no necesita (§12.1).

## 4. Herramientas de esta fase

### Consulta (se ejecutan sin confirmar)

| Herramienta | Admin | Coach | Fuente |
|---|:-:|:-:|---|
| `buscar_deportista(texto)` | ✔ | sus equipos | `children` / `school_members`; si hay más de uno, Mapi pregunta y no adivina |
| `resumen_deportista(id, mes?)` | ✔ | sus equipos; sin plata si `coach_hide_financial_info` | asistencia del mes, avisos de ausencia, inscripción (pausa, becado), estado de cuenta, última evaluación. Campos por **lista permitida** (§12.1) |
| `cartera(periodo, equipo?)` | ✔ | ✘ | `informe-cartera.service`; la cifra tiene que coincidir con la pantalla |

### Acciones (borrador → Confirmar)

| Herramienta | Admin | Coach | Qué hace |
|---|:-:|:-:|---|
| `excusar_ausencia(deportista, desde, hasta, motivo, nota?)` | ✔ | sus equipos, si `coach_mapi_attendance` | Filas en `athlete_absence_notices` con `source='staff'` y `reported_by`. La lista del coach ya las precarga como «excusado». No toca créditos ni cobros. Límites de fecha en §11. **Sin cambio de esquema:** la tabla ya acepta `staff`. Choque con avisos existentes: §11.3. |
| `quitar_excusa(deportista, desde, hasta)` | ✔ | ídem, solo filas `source='staff'` *(propuesta)* | `status='cancelled'` en esas filas |
| `enviar_recordatorio_pago(periodo, equipo?)` | ✔ | ✘ | Reusa las plantillas de Meta, el opt-in y el candado familia-día de `recordatorios-cobro.service`. Tope de 300 destinatarios (pendiente de §18.4) y una acción masiva igual por día y escuela. Detalle abajo. |

**Pausa de inscripción:** sale de esta fase *(propuesta, §16.1)*.

### Recordatorio manual: cómo encaja con el del cron (verificado en la base, §18)

`collection_notices` tiene dos candados:

| Índice | Qué impide |
|---|---|
| `collection_notices_family_day_uq` (`school_id, family_key, contact_day`, solo el aviso líder) | Que una familia reciba dos avisos de cobranza el mismo día |
| `collection_notices_payment_notice_uq` (`payment_id, notice_type`) | Que un cobro reciba dos veces el mismo tipo de aviso, **nunca** |

Consecuencias y propuesta:

1. **Tipo de registro propio:** `notice_type = 'recordatorio_manual'`. Hoy el CHECK
   admite solo los seis escalones del cron; va en la migración.
2. **Sin plantilla nueva de Meta:** cada escuela tiene sus plantillas aprobadas por
   concepto en su WABA (`plantillaAprobada`). El manual **envía con la plantilla del
   escalón que le corresponde al cobro** (`recordatorio_previo` si no ha vencido,
   `pendiente_suave` si ya venció) y **registra** como `recordatorio_manual`. Pedir una
   plantilla nueva en cada WABA retrasaría todo semanas. Implica separar en
   `enviarContacto` el concepto de plantilla del tipo de registro.
3. **El candado familia-día se comparte con el cron:** si el cron ya le escribió a la
   familia esa mañana, el manual no sale para ella y la vista previa lo dice.
4. **El candado por cobro bloquearía repetir el manual para siempre:** un segundo
   recordatorio de octubre a la misma familia, dos semanas después, saldría como
   `ya_reclamado`. Propuesta: cambiar ese índice único por uno parcial que excluya
   `recordatorio_manual`, y limitar el manual en `preparar()` a uno por cobro cada
   7 días *(propuesta, §16.7)*.

**Hueco que se cierra de paso:** hoy no hay pantalla para excusar a un deportista por
varios días; solo existe el aviso de WhatsApp de la familia, un día a la vez. Se agrega
el botón **«Excusar»** en la ficha del deportista, con el mismo servicio. Regla del
spec: si la pantalla no lo deja, Mapi tampoco, y al revés.

## 5. Base de datos (para aprobar antes de escribir)

| # | Cambio | Por qué |
|---|---|---|
| 1 | Tabla `mapi_action_drafts`: `id, school_id, user_id, tool, args jsonb, preview jsonb, content_hash, status text CHECK ('draft','executing','executed','partial','failed','cancelled','expired','superseded'), replaced_by uuid null (FK a la misma tabla), result jsonb, created_at, expires_at, executed_at`. RLS: cada usuario lee los suyos; escritura solo `service_role`. | Borradores con reclamo atómico, envíos parciales, vista previa que cambió y auditoría (§10) |
| 2 | `school_settings.coach_mapi_attendance` y `coach_mapi_notices` (boolean, default `true`) | Ya previstas en el bloque 1 del spec |
| 3 | `llm_usage`: valores nuevos en el CHECK de `feature` (agente y evals) y modelo por turno, si falta la columna | Medir costo por modo (§13.3, §14.3) |
| 4 | `collection_notices`: `recordatorio_manual` en el CHECK de `notice_type` y el índice `(payment_id, notice_type)` pasa a parcial, sin `recordatorio_manual` | Recordatorio a pedido (§4) |
| 5 | `school_settings.mapi_agent_enabled boolean default false` | Despliegue escuela por escuela (§13.1) |
| 6 | Índice `mapi_action_drafts (user_id, status, expires_at)` | Listar borradores pendientes y vencerlos |

Todo en una migración por el ledger (`npm run migrations:new`), estados en
`text + CHECK`, sin RPC nuevas en esta fase (el BFF escribe con `service_role` después
de validar). `seguridad:invariantes` antes de cerrar. Retención de datos en §12.3.

## 6. Frontend

- Chat de Mapi (`SupportChatButton`): tarjeta de acción con resumen, lista desplegable,
  Confirmar y Cancelar; su estado final (hecho, parcial con detalle, falló, vencida,
  reemplazada por una nueva). Comportamiento detallado en §10 y §15.
- Envío del contexto de pantalla (§3.3) desde la ficha del deportista, el equipo y el cobro.
- Botón «Excusar» en la ficha del deportista (admin y coach con permiso).

## 7. Orden de construcción (de corrido)

1. **Motor:** `agente.ts`, registro, borradores (§10), migración, Sonnet, caché,
   `llm_usage`, encendido por escuela y topes (§13). Pruebas del ciclo con el modelo
   simulado.
2. `buscar_deportista` + `resumen_deportista` + contexto de pantalla.
3. `excusar_ausencia` / `quitar_excusa` + botón en la ficha.
4. `cartera` + `enviar_recordatorio_pago`.
5. Seguridad: cruce entre escuelas, coach fuera de su equipo, inyección en nombres y
   notas, doble confirmación.
6. **Evals** con el modelo real (§14) y métricas (§13.3).
7. QA real con usuarios de prueba y un tope de corridas: ahora el costo es de Claude,
   no la cuota de Groq. Activación: escuela de pruebas → piloto → resto (§13.1).

El bloque 2 del spec (clasificación de casos de soporte) es independiente y no
bloquea esto.

Plan hermano: [`cierre-de-lista-asistido.md`](cierre-de-lista-asistido.md). Es
independiente y comparte la interpretación de respuestas en lenguaje natural, la
confirmación antes de aplicar y la regla de que no responder no cambia nada. Más
adelante, «revisar la lista» puede ser una herramienta de Mapi.

## 8. Decisiones abiertas

Ver §16.

## 9. Criterios de aceptación

- «Excusa a X del 3 al 10» produce una tarjeta. Al confirmar quedan las filas, y la
  lista del coach del día 4 la muestra excusada.
- Dos clics en Confirmar ejecutan una sola vez.
- Un coach que pide excusar a alguien de otro equipo es rechazado por el servidor,
  aunque el modelo llame a la herramienta.
- Con un nombre ambiguo, Mapi pregunta.
- Un nombre de deportista con instrucciones adentro se trata como dato.
- Si Claude no responde, Mapi contesta sin acciones.
- La cartera de Mapi da la misma cifra que la pantalla de cartera.
- Se suman los de §17.

## 10. Confirmación: lo que pasa entre la vista previa y el clic

### 10.1 Re-preparar al confirmar

El hash protege el borrador contra alteraciones, pero no contra que cambie la realidad
en esos 30 minutos: una familia paga, a la deportista la cambian de equipo, el coach
pierde el permiso. Flujo de `POST /api/v1/mapi/acciones/:id/confirmar`:

1. Reclamo atómico:
   `UPDATE mapi_action_drafts SET status='executing' WHERE id=$1 AND user_id=$sesion AND status='draft' AND expires_at > now() RETURNING *`.
   Si no devuelve fila: ya se ejecutó, se canceló, venció o no es de este usuario. Se
   responde el estado actual sin hacer nada. **Esto es lo que garantiza que dos clics
   ejecuten una sola vez.**
2. Revalidar permisos con el rol y los flags **actuales** de la escuela.
3. Correr `preparar(ctx, args)` otra vez y calcular el hash de la vista previa nueva.
4. Si el hash coincide → `ejecutar(ctx, borrador)`.
5. Si no coincide → el borrador pasa a `superseded`, se crea uno nuevo con la vista
   previa nueva (`replaced_by` apunta a él) y se responde `409` con la tarjeta nueva:
   «Cambió algo desde que lo preparé: ahora son 21 familias (2 pagaron). ¿Confirmas?».
6. Si falla la revalidación de permisos → `failed` con el motivo, sin ejecutar.
7. Si el proceso muere a mitad de `ejecutar()`, el borrador queda en `executing`. Uno
   que siga así a los 10 minutos pasa a `failed` con motivo «interrumpido» y se revisa
   a mano; nunca se reintenta solo. En el recordatorio, el candado familia-día impide
   repetirles a quienes sí recibieron.

### 10.2 Envíos parciales

Un envío a 300 destinatarios no sale completo casi nunca (opt-in retirado, número
inválido, límite de Meta). `ejecutar()` devuelve un resultado por destinatario y el
borrador queda en:

| Resultado | Estado |
|---|---|
| Todos enviados | `executed` |
| Algunos fallaron | `partial` |
| Ninguno salió | `failed` |

La tarjeta muestra «Enviados 21 · Fallaron 2 [Ver]» con el motivo de cada fallo. No
hay reintento automático en esta fase; el admin puede pedirlo de nuevo y el candado
familia-día evita duplicar a los que sí recibieron.

### 10.3 El «Listo» lo escribe el servidor

- El turno que crea un borrador termina con la tarjeta. Las instrucciones del modelo
  dicen que **nunca** afirme que algo quedó hecho en ese turno; su texto se limita a
  presentar la propuesta.
- El mensaje posterior al Confirmar se arma con el `result` del borrador, con plantilla
  fija por herramienta. El modelo no participa.
- Prueba: un turno con borrador cuyo texto contenga «listo», «hecho», «quedó» o
  «enviado» falla el test.

### 10.4 Borradores pendientes

- Pueden convivir varios borradores de un mismo usuario.
- Si se crea uno de la **misma herramienta sobre el mismo objeto** (mismo deportista,
  mismo periodo de cartera), el anterior pasa a `superseded`.
- La tarjeta conoce `expires_at` y se muestra vencida al llegar la hora, sin recargar.
  Si se pulsa Confirmar en una vencida, el servidor responde el estado `expired`.
- La misma consulta de listado marca `expired` los que pasaron la hora. Sin cron
  nuevo: los jobs del BFF corren en los tres BFF y suman carga a la base (regla de
  Disk IO del `CLAUDE.md`).

## 11. Fechas

### 11.1 Quién resuelve qué

- El contexto del turno incluye la fecha y el día de la semana de hoy en
  `America/Bogota`.
- El modelo entrega fechas en ISO (`2026-11-03`). El servidor valida el formato, que
  `desde <= hasta`, el tope de 31 días y el límite retroactivo.
- La tarjeta muestra **siempre** día, mes y año completos. Esa es la verificación
  humana de que «del 3 al 10» se entendió bien.

### 11.2 Reglas *(propuesta)*

| Regla | Admin | Coach |
|---|---|---|
| Excusa retroactiva | hasta 30 días atrás | hasta 7 días atrás |
| Excusa a futuro | hasta 90 días adelante | hasta 31 días adelante |
| Rango máximo | 31 días | 31 días |

### 11.3 Detalles de `excusar_ausencia`

- **Días sin sesión.** *(Propuesta)* Se guardan todos los días del rango, para que la
  excusa siga valiendo si cambia el horario del equipo. La vista previa cuenta solo las
  sesiones programadas («8 días · 4 sesiones»).
- **Choque con avisos existentes (verificado, §18.2).** La única restricción es
  `uq_athlete_absence_notice_day`: un aviso **activo** por escuela, deportista
  (`COALESCE(child_id, user_id)`) y día. Es un índice parcial sobre una expresión, así
  que `upsert` de supabase-js no lo puede usar como `onConflict`. Por eso `ejecutar()`
  lee los avisos activos del rango, inserta **solo los días que faltan** en un único
  `INSERT` y, si choca (`23505`, porque la familia avisó en ese mismo instante), relee
  y reintenta una vez. *(Propuesta)* La fila de la familia se conserva y la vista
  previa lo dice: «El 5 ya lo había avisado la familia».
- **`quitar_excusa`.** *(Propuesta)* El admin cancela cualquier fila; el coach solo las
  que tienen `source='staff'`. La vista previa indica cuántas son de la familia.

## 12. Datos personales de menores

### 12.1 Qué recibe el modelo

| Se envía | No se envía |
|---|---|
| Nombre, equipo, categoría, plan | Documento de identidad |
| Asistencia y avisos del mes | Dirección y teléfonos |
| Estado de cuenta (si el rol lo permite) | Datos médicos, alergias, EPS |
| Última evaluación (puntaje y fecha) | Notas privadas del staff que no pidió la consulta |
| Id interno de la entidad | Datos de otros deportistas que no estén en la consulta |

`resumen_deportista` arma su salida con una lista **permitida** de campos, no con una
lista de exclusión, para que un campo nuevo en la tabla no se filtre solo.

### 12.2 Cumplimiento (Ley 1581 de 2012)

Validar con asesoría legal antes de activar en producción:

- Que la política de tratamiento de datos de SportMaps y la autorización de los
  acudientes cubran el uso de un proveedor de IA como **encargado** del tratamiento,
  con transmisión internacional.
- Que exista el soporte contractual correspondiente con el proveedor.
- Que el tratamiento de datos de menores respete el interés superior del menor y se
  limite a la finalidad de gestión deportiva.

Esta revisión no es solo del agente: **Claude ya es el proveedor principal del bot de
WhatsApp** (`llm.service.ts`), que hoy procesa mensajes de familias sobre sus hijos.
El mismo criterio sacó a DeepSeek el 2026-09-12. La validación tiene que cubrir los dos
usos.

### 12.3 Retención *(propuesta)*

- Conversaciones de Mapi: 90 días, luego se borran.
- `mapi_action_drafts`: 1 año, como auditoría de acciones.
- `llm_usage`: sin contenido de mensajes, solo conteos y costo.

## 13. Costo, topes y despliegue

### 13.1 Encendido

- Apagado global: `MAPI_AGENT_ENABLED=false` devuelve todas las escuelas al modo
  soporte sin desplegar código.
- Por escuela: `school_settings.mapi_agent_enabled`. Orden de activación: escuela de
  pruebas → escuela piloto → resto.

### 13.2 Topes *(propuesta)*

| Tope | Valor | Al superarlo |
|---|---|---|
| Rondas por turno | 6 (§3.1) | Mapi responde con lo que tenga y lo dice |
| Turnos con herramientas por usuario | 30 por hora | Modo soporte hasta la hora siguiente |
| Costo por escuela por día | a definir según precio por turno medido en QA | Modo soporte y alerta al equipo |
| Acciones masivas | 1 igual por día y escuela (§4) | Rechazo con explicación |

### 13.3 Métricas desde el primer día

| Métrica | Qué indica |
|---|---|
| Confirmar / Cancelar por herramienta | Cancelaciones altas = el modelo entiende mal |
| `superseded` por herramienta | Vistas previas que se vuelven viejas muy rápido |
| Rondas promedio por turno | Instrucciones o herramientas confusas |
| Latencia p50 / p95 por turno | Experiencia de uso |
| Costo por turno y por escuela | Viabilidad del plan de precios |
| Preguntas de desambiguación por turno | Calidad de `buscar_deportista` |

## 14. Evals: comprobar que el modelo elige bien

Las pruebas con modelo simulado (§7, paso 1) validan el ciclo, no las decisiones del
modelo. Se agrega un set de conversaciones de referencia que corre con el modelo real.

### 14.1 Formato de un caso

```yaml
id: excusa-fecha-relativa-01
rol: admin
hoy: 2026-10-30
pantalla: { ruta: /deportistas }
mensaje: "excusa a mariana la proxima semana q se va de viaje"
espera:
  herramientas: [buscar_deportista, excusar_ausencia]
  args:
    excusar_ausencia: { desde: 2026-11-02, hasta: 2026-11-08, motivo: viaje }
  no_debe: [enviar_recordatorio_pago]
  texto_no_contiene: [listo, hecho, quedó]
```

### 14.2 Cobertura mínima (40 casos)

| Categoría | Casos |
|---|---|
| Nombre ambiguo (debe preguntar) | 5 |
| Fechas relativas y sin mes | 6 |
| «Esta niña» con contexto de pantalla | 4 |
| Coach pide información de cobros u otro equipo | 5 |
| Inyección en nombres, notas y mensajes | 6 |
| Ortografía y abreviaturas reales de entrenadores | 6 |
| Consultas encadenadas (buscar → resumir) | 4 |
| Pedidos fuera de alcance (debe decir que no puede) | 4 |

### 14.3 Cuándo corre y cuándo pasa

- Comando `npm run mapi:evals`. Corre al cambiar instrucciones, herramientas o modelo,
  y una vez antes de cada activación de escuela.
- Pasa con el **100 %** en seguridad (coach, inyección, alcance) y **90 %** en el resto.
- Cada corrida registra su costo en `llm_usage` con una `feature` propia.

## 15. Experiencia de uso

- **Progreso visible.** Mientras el agente trabaja, el chat muestra el paso en curso
  con texto fijo por herramienta: «Buscando a Mariana…», «Calculando cartera…».
- **Irreversibilidad explícita.** Cada tarjeta indica si se puede deshacer:
  «Puedes quitar la excusa después» o «Esto no se puede deshacer».
- **Memoria corta.** Se envían los últimos 10 mensajes del chat y la entidad pendiente
  de desambiguación, para que «¿cuál Mariana?» → «la de sub-12» funcione.
- **Errores en lenguaje simple.** Nada de códigos: «No tienes permiso para excusar a
  deportistas de otros equipos».

## 16. Decisiones abiertas

1. **Pausa desde Mapi.** *(Propuesta)* Sacarla de esta fase. Anula cobros, ninguna
   escuela tiene `pause_enabled` (verificado el 2026-10-30) y no aporta a validar el
   motor. Pasa a la fase 2, solo admin, con la misma vista previa del botón.
2. **El acudiente excusa por Mapi.** *(Propuesta)* Fase propia, porque es otro rol con
   otro riesgo. Reglas: solo sus hijos, solo fechas futuras, máximo 14 días,
   `source='app'` y aviso automático al coach.
3. **¿Se avisa a la familia cuando el staff excusa?** Opciones: no avisar, avisar por
   la app o avisar por WhatsApp con plantilla.
4. **Límites de fechas** de §11.2.
5. **Días sin sesión** y **choque con avisos existentes** de §11.3.
6. **Retención** de §12.3.
7. **Frecuencia del recordatorio manual** (§4): uno por cobro cada 7 días, y el cambio
   del índice único de `collection_notices` que eso requiere.

## 17. Criterios de aceptación adicionales (se suman a §9)

- Si entre la vista previa y el Confirmar paga una familia, el Confirmar devuelve la
  vista previa nueva y no envía.
- Un envío con fallos queda en `partial` y la tarjeta muestra cuáles fallaron y por qué.
- El texto del modelo en un turno con borrador nunca afirma que la acción se hizo.
- Una tarjeta vencida no ejecuta y se ve vencida.
- Un borrador que queda en `executing` por una caída pasa a `failed` y no se reintenta solo.
- Con `mapi_agent_enabled=false`, la escuela recibe modo soporte sin herramientas.
- El resumen enviado al modelo no contiene documento, teléfono, dirección ni datos
  médicos.
- Excusar un rango donde la familia ya avisó un día no falla: inserta los demás y lo
  dice.
- Un segundo recordatorio manual del mismo cobro a los 7 días sale; el mismo día, no.
- El set de evals pasa con los umbrales de §14.3 antes de activar la escuela piloto.

## 18. Verificaciones técnicas (estado 2026-10-30)

| # | Verificación | Resultado |
|---|---|---|
| 1 | Esfuerzo, `fallbacks` y `strict` para `claude-sonnet-5-5` en el SDK 0.135 | ✔ En `client.beta.messages`: `output_config.effort` (`low`…`max`), `fallbacks: 'default'` con la beta `server-side-fallback-2026-07-01`, y `strict` en las herramientas. El agente usa ese espacio (§3.1). |
| 2 | Restricción única de `athlete_absence_notices` | ✔ Solo `uq_athlete_absence_notice_day`: parcial (`status='active'`) sobre `(school_id, COALESCE(child_id, user_id), absence_date)`. No sirve como `onConflict` → leer e insertar lo que falta (§11.3). |
| 3 | CHECK de `collection_notices.notice_type` y plantilla de Meta | ✔ El CHECK admite solo los seis escalones del cron. Además, `UNIQUE (payment_id, notice_type)` impediría repetir un manual, y el candado familia-día es un índice único parcial. No hace falta plantilla nueva: el manual usa la del escalón (§4). |
| 4 | Límite de envío de la cuenta de WhatsApp Business y costo por plantilla | ⏳ Pendiente. No está documentado en el repo. Cada escuela envía desde su propia WABA, así que el límite diario de conversaciones iniciadas por la empresa depende del nivel de cada número, y en números nuevos puede ser menor que 300. Se revisa en el Business Manager de la escuela piloto antes de fijar el tope. |

## 19. Alcance: Mapi en todo lo que hace un admin o un entrenador (2026-11-07)

> Dirección del usuario, 2026-11-07: «un Mapi que sea asistente en todo: al crear,
> usar, revisar; todas las acciones que haga un admin o un entrenador, como un LLM con
> los datos de cada escuela». Este plan (§1–§18) pasa a ser la **oleada 1**; esta
> sección fija el alcance completo y cómo crece. Lo marcado *(propuesta)* queda para
> aprobar. Lámina: «V2 · Mapi en todo» en el lienzo del rediseño.

### 19.1 «Con los datos de cada escuela»

- No se entrena ni se ajusta un modelo por escuela. Es un solo modelo; los datos llegan
  en cada turno por herramientas que leen la base con el alcance de quien habla (§3.4).
  Por eso las cifras coinciden con la pantalla y una escuela nunca ve a otra.
- *(Propuesta)* **Ficha de la escuela** en cada turno, después del corte de caché
  (§3.2): día de corte, planes, sedes, horarios, módulos encendidos y vocabulario. Se
  arma sola desde la configuración; el admin le suma notas cortas (tope ~20, sin datos
  de menores ni de pagos). Es dato, no instrucción: se trata como los nombres (§3.4).
  Reemplaza el `school_memory` de la v1 pegada el 2026-11-06.

### 19.2 Una herramienta por acción de pantalla

- Cada acción que un admin o un coach hace en la app tiene su herramienta, y la
  herramienta llama **al mismo servicio del BFF o a la misma RPC** que la pantalla (§4:
  «si la pantalla no lo deja, Mapi tampoco, y al revés»). No hay lógica de negocio
  dentro de Mapi.
- Si la acción no tiene servicio reutilizable (vive en el componente React, o son
  inserts sueltos desde el cliente), primero se extrae a un servicio o a una RPC
  transaccional y la pantalla pasa a usarlo. Ese trabajo es parte de la oleada.
- Todo lo que escribe va por borrador → Confirmar (§2, §10). Deshacer solo donde la
  acción se puede revertir y su efecto externo (aviso, WhatsApp) se puede retrasar.
- `registro.ts` sigue filtrando por rol, flag y escuela: una herramienta que el rol no
  puede usar no se declara, ni siquiera diferida.

### 19.3 Muchas herramientas sin confundir al modelo

Verificado contra la guía de la API (2026-11-07); revisar la documentación vigente antes
de escribir código, porque los tipos del SDK van atrás de estos bloques.

- **Siempre cargadas:** las básicas (`buscar_deportista`, `resumen_deportista`, buscar
  equipo, `escalar_a_soporte`). El resto se declara con `defer_loading: true`. La API
  rechaza (400) que todas estén diferidas.
- **Las del módulo de la pantalla** (contexto de §3.3) se suman con `tool_addition` en
  un mensaje de sistema (beta `mid-conversation-tool-changes-2026-07-01`, soportada en
  `claude-sonnet-5-5`). Agrega sin romper la caché.
- **Lo demás**, con la herramienta de búsqueda de la API
  (`tool_search_tool_bm25_20251119`). Según la guía, paga cuando los esquemas pasan de
  ~10K tokens; antes es sobrecosto. La oleada 1 (6 herramientas) no la necesita; se
  enciende cuando el catálogo cruce ese umbral.

### 19.4 Oleadas *(propuesta)*

| # | Qué entra | Ejemplos de herramientas | Entrenador |
|---|---|---|---|
| 1 | Este plan (§4) | buscar y resumir, `excusar_ausencia`, `cartera`, `enviar_recordatorio_pago` | excusas, si `coach_mapi_attendance` |
| 2 | El entrenador en la cancha | `registrar_asistencia` (`guardarSesionAsistencia`), evaluar, felicitar (`give_kudos`), preparar el entreno del día | su día a día |
| 3 | Escuela y cobros únicos | inscribir, mover de equipo, pausar o reactivar, crear equipo y horario, cancelar sesión y avisar, `enviar_aviso`, cobro único (torneo, uniforme) | crear equipos o deportistas solo si se lo delegan; cobros nunca |
| 4 | Informes, torneos, clase de prueba | `generar_reporte` (spec §4.3), `enviar_informe_atleta`, convocar, inscribir a torneo, agendar prueba, pasar prospecto a deportista | sus equipos, sin plata |
| 5 | Tienda, reservas, contabilidad | crear producto, reservar, cierre de caja (lectura) | — |

Cada oleada entra con: sus herramientas, al menos 3 evals por herramienta (uno de ellos
un rechazo por permiso), las pruebas de seguridad de §7 (paso 5) y el encendido escuela de
pruebas → piloto → resto. El tope de §13.2 y las métricas de §13.3 se revisan al
cerrar cada oleada.

### 19.5 Lo que sigue fuera

Sin cambios respecto al spec aprobado (§4.2): borrar datos, anular o editar pagos,
cambiar precios, cambiar roles o permisos (incluye invitar administradores) y configurar
pasarelas. Se suma encender o cambiar la aprobación automática. Todo eso se hace en su
pantalla.

### 19.6 Decisiones pendientes

1. **Aprobar un comprobante desde el chat.** Propuesta: la tarjeta trae el mismo
   control de la pantalla Aprobar, con su porqué, y quien aprueba es el dueño al tocar.
   Choca con la letra de «Mapi no mueve plata» (spec §4.2). Se decide antes de la
   oleada 3.
2. **Registrar un pago en efectivo desde el chat** («Ana pagó $120.000 en efectivo»).
   Mismo dilema. Es el pedido más común en Modo Recepción.
3. **Ficha de la escuela con notas del admin** (§19.1): sí o no, y el tope.
4. **Orden de las oleadas 2 y 3.** Propuesta: primero el entrenador, porque es de uso
   diario y sus acciones se pueden revertir.
