# Mapi por WhatsApp para administradores — plan (2026-11-09)

**Qué es:** el administrador de una escuela (Iván en Monster, Milena en Dynasty) recibe por el **número de SportMaps (+57 320 268 3539)** los avisos de lo que necesita a una persona, y desde ese mismo chat **le hace preguntas a Mapi** y, con confirmación, le pide que haga cosas. Es la puerta de entrada del agente de Mapi (`mapi-agente-plan.md`) por el canal de plataforma (`canal-whatsapp-plataforma.md`).
**Pedido del usuario (11-09, noche):** armar el plan con lo que ya hay y empezar al día siguiente con el canal (F2) y el agente de IA de Mapi.
**Por qué ahora:** la clínica de Monster mostró que la app y el correo no se leen (20 avisos en la app, 20 sin leer; tres casos urgentes sin ningún aviso) y que el administrador vive en WhatsApp.

## 1. Cómo se ve (ejemplos)
```
SportMaps  Hola, en Monster´s Volley Club hay un caso de WhatsApp que necesita a una persona:
           Angela pidió hablar con la escuela. Respóndele a la familia desde SportMaps.   [Ver en la app]

Iván:      ¿cómo vamos con la clínica?
Mapi:      Clínica de armadores · preventa hasta hoy.
           Pagados: 4 ($1.050.000) · abono: 1 ($150.000, saldo $150.000)
           Con datos de pago y sin comprobante: 8. Piden persona: 2.            [Ver quiénes]

Iván:      aprueba el pago de $600.000 de Katherin
Mapi:      ┌ Aprobar pago ──────────────────────────────┐
           │ Katherin R · $600.000 · Bancolombia · hoy   │
           │ 2 cupos: Valentina R. y María Alejandra M.  │
           │ Supera el tope de $400.000: lo confirmas tú │
           │          [Confirmar]  [Cancelar]             │
           └──────────────────────────────────────────────┘
Iván:      [Confirmar]
Mapi:      Listo: quedaron pagados los 2 cupos y le avisé a Katherin.    ← lo escribe el servidor
```

## 2. Lo que ya tenemos (estado al cierre del 11-09)
| Pieza | Estado |
|---|---|
| Número de SportMaps conectado al canal (`platform_wa_canal`, token cifrado, webhooks suscritos) | **hecho** (`bff/scripts/wa-conectar-canal.ts`); canal APAGADO |
| 5 plantillas de aviso `sm_*` en la cuenta «Sportmaps» | registradas, **en revisión de Meta**; Meta recategorizó 2 a MARKETING (`sm_caso_por_atender`, `sm_clase_cortesia_novedad`) |
| Canal F1: opt-in con «ACTIVAR <código>», preferencias, horario silencioso, envío con reserva, ganchos en los 5 eventos | hecho, detrás de `PLATFORM_WA_ENABLED` / `platform_wa_canal.habilitado` |
| Canal F2: modo pruebas con cortafuegos (`/escuela`, `/como papa`…) | hecho, detrás de `PLATFORM_WA_TESTERS`. **No es lo mismo que el agente**: simula a una familia |
| Motor del agente (`mapi-agente/`: ciclo, registro de herramientas, borradores) | **construido el 2026-11-23/24** (38 herramientas, evals con el modelo real); en la app, apagado en todas las escuelas. Diseño del canal en §12 |
| Herramientas de cobros especificadas (§20.3 del plan de Mapi) | **consultas construidas el 11-24** (`herramientas/pagos.ts`); aprobar y registrar efectivo necesitan RPC (plan de Mapi §22.2) |
| «Aprobar un comprobante desde el chat» | **decidido** el 2026-11-08 («sí, exactamente es eso», §20.6.1) |
| Qué hace hoy un administrador suscrito que escribe al canal | solo una ayuda corta, 1 vez cada 24 h (canal §3.3) |
| Suscripciones activas / escuelas habilitadas | 0 / ninguna |

**Nombres:** en el spec del canal «F2» es el modo pruebas (ya hecho). Este plan es la fase nueva **F5 del canal: entrantes de administradores atendidos por Mapi**, que usa el motor del plan de Mapi.

## 3. Decisiones del canal que este plan cambia (pedir OK)
| Decisión vigente | Cambio propuesto | Base |
|---|---|---|
| **D9** «Nada se aprueba desde WhatsApp; solo enlaces a la app» | Mapi puede **aplicar y aprobar con tarjeta de confirmación** (borrador → [Confirmar]), con topes y solo para administradores suscritos | decisión del 11-08 (§20.6.1) y práctica de la clínica (11-09) |
| **D11** informe sin nombres ni teléfonos | **Las plantillas siguen sin nombres** (cifras + enlace). Dentro de la ventana de 24 h, en la conversación con el administrador suscrito, Mapi puede dar nombres de familias | el administrador ya los ve en su app |
| **§3.3** suscrito que escribe → ayuda corta | suscrito que escribe → **Mapi** (si la escuela tiene el agente encendido) | |
| **D12** desconocidos → silencio | **se mantiene** | evita chocar con ventas |
Se mantiene tal cual: D3 (token cifrado), D4 (el consentimiento lo da el propio número), D5 (se revalida owner/admin en cada envío), D6 (horario silencioso), D7 (idempotencia), D15 (service-only).

## 4. Arquitectura (reusa lo existente)
1. **Entrante:** en `atenderEntrantePlataforma`, antes de la «ayuda corta»: si el `from` tiene suscripción activa de una escuela con el agente encendido → `mapiPorWhatsApp.atender(...)`.
2. **Identidad:** el número que escribe (Meta autentica el `from`) + suscripción activa + owner/admin vigente (D5). `school_id` y `profile_id` salen de la suscripción, **nunca** de lo que diga el modelo. Si el administrador lo es de varias escuelas, Mapi pregunta cuál y la recuerda 24 h.
3. **Motor:** `bff/src/services/mapi-agente/` del plan de Mapi §3.1 (`agente.ts`, `registro.ts`, `borradores.ts`, `herramientas/*`). El canal de WhatsApp es solo **un adaptador** de entrada/salida (la pantalla de la app es el otro).
4. **Salida:** texto libre dentro de la ventana de 24 h; botones de respuesta para [Confirmar] / [Cancelar] / [Ver quiénes]; fuera de la ventana solo plantillas aprobadas.
5. **Confirmación:** el id del botón lleva el borrador (`mapi:confirmar:<borrador_id>`). El servidor comprueba que el borrador es de **esa** suscripción, lo **re-prepara** (§10.1 del plan de Mapi) y el «Listo» lo escribe el servidor (§10.3). Un botón viejo no ejecuta nada.
6. **Tablas:** reutiliza `platform_wa_*` y los borradores del plan de Mapi (§5). Migración nueva solo si hace falta (plan antes de código; una sola sesión aplica migraciones; regla de Disk IO).
7. **Kill-switches:** los del canal (§4 del spec) + un interruptor propio `mapi_whatsapp` por escuela.

## 5. Herramientas por oleada
**Oleada 1 — consulta (solo lectura; mañana):**
| Herramienta | Responde |
|---|---|
| `estado_de_servicio(servicio?)` | «¿cómo vamos con la clínica?»: pagados, abonos, con datos de pago sin comprobante, piden persona (nace de la clínica del 11-09) |
| `comprobantes_por_revisar()` | cuántos y cuál espera más |
| `casos_por_atender()` | quién pidió hablar con alguien, quién tiene pregunta sin responder |
| `cartera(periodo)` | mora y plata, igual que la pantalla (plan de Mapi §4) |
| `buscar_deportista` / `resumen_deportista` | plan de Mapi §4 |
| `estado_de_campana()` | enviados, «Sí», bajas, cupo de Meta del día |

**Oleada 2 — acciones con confirmación:** `aprobar_comprobante`, `aplicar_comprobante_a_cobro` (incluye pagos de varios deportistas: lista «Jugador 1… Jugador 2» y monto múltiplo del precio), `crear_ficha_desde_chat` (el caso Dynasty), `escribir_a_familia` (borrador del mensaje → confirmar).
**Oleada 3 — masivas:** recordatorios y campañas (con tope y vista previa).
**Fuera de Mapi:** encender o cambiar la aprobación automática (§19.5), conectar números, tocar precios.

## 6. Avisos de salida (lo primero de mañana, en cuanto Meta apruebe)
| Evento | Urgencia | Plantilla | Hoy |
|---|---|---|---|
| Pide hablar con una persona («Hablar con alguien») | urgente | `sm_caso_por_atender` | solo notificación en la app |
| Comprobante que no cuadra o supera el tope | urgente | `sm_caso_por_atender` | quedó en la cola sin aviso (caso $600.000) |
| Pregunta que el bot no supo contestar | urgente | `sm_caso_por_atender` | pendiente en el buzón |
| Interesado caliente (pidió pago y no pagó, o se retira por precio) | normal | resumen | sin aviso |
| Comprobantes en revisión | normal | `sm_comprobantes_por_revisar` | cron de pagos por validar (flag de WhatsApp apagado) |
| Resumen del día | diario | `sm_resumen_diario` | existe como evento |
Reglas: una clave determinística por evento (D7); un aviso por conversación por hora como máximo; lo de la noche entra al resumen de las 7:00 (D6); **en la clínica, los urgentes pasan el horario silencioso hasta el cierre de la preventa** (propuesta).

## 7. Orden de construcción (mañana en adelante)
1. **Revisar las plantillas** (¿aprobadas? ¿marketing o utilidad?). Si Meta las dejó en marketing y estorba, registrar versiones neutras.
2. **Prerrequisito:** confirmar quién es el owner/admin de Monster en la app (quien genera el código «ACTIVAR»), y habilitar a Monster en `/admin/whatsapp` (con OK).
3. **Disparadores → canal** (§6): reutilizar los eventos existentes (`abrirEnBuzon`, `avisarAdministracion`, cola de comprobantes) como destino más (D10).
4. **Suscribir a Iván:** código desde la app → «ACTIVAR <código>» al 320 268 3539 desde el WhatsApp del club. Probar con el modo pruebas (F2) y con un aviso real.
5. **Motor del agente** (plan de Mapi §7 pasos 1-2): ciclo, registro, borradores, encendido por escuela, topes, `llm_usage`; pruebas con el modelo simulado.
6. **Oleada 1** (§5) y el adaptador de WhatsApp (§4). **Evals con el modelo real** (plan de Mapi §14) antes de encender para Iván.
7. **Oleada 2** cuando Iván la use sin fricción, empezando por `aprobar_comprobante` y `aplicar_comprobante_a_cobro`.
8. **Dynasty:** no se habilita hasta que Milena lo acepte (ver `dynasty-plan-actualizacion-v2-mapi.md` §2b: chat muy personal; un solo aviso al comienzo).

## 8. Seguridad y privacidad
- Datos de menores mínimos al modelo (plan de Mapi §12); nombres solo dentro de la conversación con el administrador.
- Cada acción deja `audit_logs` (actor = el administrador suscrito) y el borrador original.
- Topes: aprobar ≤ $400.000 por acción sin avisar de más; por encima, tarjeta con «supera el tope» (la decide el administrador); acciones por hora limitadas.
- Un número = un administrador de una escuela; quitarle el rol corta Mapi y los avisos (D5). `DESACTIVAR` en cualquier momento.
- Credenciales: el token del canal **se rota** (se pegó en el chat el 11-09): generar uno nuevo, volver a correr `wa-conectar-canal.ts --aplicar` desde la terminal del usuario y revocar el anterior.

## 9. Riesgos
| Riesgo | Mitigación |
|---|---|
| Plantillas recategorizadas a MARKETING (costo, límites de frecuencia, consentimiento) | esperar la decisión de Meta; versión neutra si estorba; los avisos reales abren la ventana de 24 h |
| El modelo elige mal una herramienta | evals (40 casos) antes de encender; las acciones siempre con tarjeta |
| Confirmar un borrador viejo | re-preparar al confirmar; el botón guarda el id del borrador |
| El administrador comparte el número con el club (Iván usa el teléfono del club) | la identidad es el número suscrito; `from` = el número del club; vale mientras él sea el único que lo usa |
| Costo del modelo | topes diarios por escuela (§13.2 del plan de Mapi), medir desde el día 1 |

## 10. Decisiones que necesita el usuario
1. **OK al cambio de D9** (§3): Mapi aplica y aprueba con confirmación y topes.
2. **Quién entra primero:** propuesta Iván (Monster), con la oleada 1; Milena después y a su ritmo.
3. **Tope de aprobación desde el chat:** propuesta $400.000 sin aviso extra (el mismo de la aprobación automática de Monster).
4. **Coaches:** propuesta dejarlos fuera de Mapi por WhatsApp en esta fase (solo administradores).

## 12. Diseño técnico con el motor ya construido (2026-11-24)

> Desde el 11-23/24 el motor existe: `bff/src/services/mapi-agente/`, con 38 herramientas, borradores con Confirmar y
> evals con el modelo real (168/170 en la corrida del 11-24; las 2 restantes eran del calificador). Esta sección dice
> cómo se enchufa al canal sin duplicar lógica. WhatsApp es **un adaptador más**; el chat de la app es el otro.

### 12.1 Qué cambia respecto de la app

| | App (hoy) | WhatsApp |
|---|---|---|
| Quién habla | sesión JWT + `x-school-id` | el **número** (Meta autentica el `from`) + suscripción activa + owner/admin vigente (D4, D5) |
| Escuela | la activa de la sesión | la de la suscripción. Si hay varias, Mapi pregunta con botones y la recuerda 24 h |
| Confirmar | botón en la tarjeta del chat | botón de respuesta de WhatsApp **o** «Confirmar en la app», según la herramienta (§12.4) |
| RPC «como la persona» (pausa, baja, evaluar, felicitar, clases de prueba) | con el JWT de la request | **no hay JWT**: esas herramientas no se ofrecen (§12.5) |
| Formato | markdown de la app (`**negrita**`, rutas) | `*negrita*`, sin tablas ni rutas; enlaces como botón «Ver en la app» |
| Coaches | sí | **no en esta fase** (la suscripción es solo de owner/admin) |

### 12.2 Flujo de un mensaje entrante

```
webhook → atenderEntrantePlataforma (plataforma-wa-entrante.service.ts)
  registrarMensaje (wa_message_id UNIQUE: Meta reintenta → 'duplicado')   ← ya existe
  ¿botón mapi:c|x|l:<borrador>?  → atenderBotonMapi (§12.4)
  ¿suscripción activa + MAPI_WHATSAPP=true + school_settings.mapi_agent_enabled?
       → mapiPorWhatsApp.atender(...)        ← NUEVO, antes de la «ayuda corta»
  si no → lo de hoy (ayuda corta / leads / silencio)
```

`mapiPorWhatsApp.atender` (archivo nuevo `mapi-agente/canal-whatsapp.ts`):
1. **Una sola conversación a la vez por número.** Usa un candado en memoria por número: los webhooks de producción llegan a un solo BFF. Así, dos mensajes seguidos no corren dos turnos cruzados.
2. **Escuela:** sale de la suscripción, nunca del texto.
3. **Alcance:** `alcanceDelTurno` se separa en un núcleo sin HTTP que se usa desde las dos entradas.
   - Revalida el owner/admin en cada mensaje (D5).
   - Exige `rol = 'admin'`.
   - Va con `authorization = null`.
4. **Historial:** los últimos 12 mensajes del número en `platform_wa_mensajes` dentro de 24 h. Toma los entrantes y los salientes `paso LIKE 'mapi%'`.
5. **Turno:** `turnoAgente({ …, canal: 'whatsapp' })`. El canal va en el bloque de contexto del turno (después del corte de caché), con la instrucción de formato de WhatsApp y «no hay pantalla: describe en palabras».
6. **Salida:**
   - Convierte el texto a formato WhatsApp y lo parte en mensajes de 4.000 caracteres o menos.
   - Cada borrador del turno sale como **mensaje interactivo**: cuerpo = título + líneas + aviso (máx. 1.024 caracteres) y hasta 3 botones: `Confirmar`, `Cancelar` y `Ver lista` (si hay detalle).
   - Los títulos de botón tienen máximo 20 caracteres, así que el texto específico («Enviar a 23 familias») va en el cuerpo.
7. **Ventana de 24 h:** quien escribe la abre. Las respuestas de Mapi son texto libre, sin plantillas. Lo proactivo (avisos) sigue con las plantillas `sm_*`.

### 12.3 Audios, imágenes y mensajes raros

- **Audio** (los administradores mandan notas de voz):
  - Se transcribe con el servicio que ya usa el bot de WhatsApp (feature `transcripcion` en `llm_usage`).
  - Mapi responde primero «Entendí: «…»» y sigue con ese texto.
  - Toda acción igual pasa por Confirmar, así que una mala transcripción no ejecuta nada.
- **Imagen o documento:** «Por ahora los comprobantes se suben en la app» más un botón. Después puede ir a la cola de comprobantes.
- **«si», «ok», «👍» sin una tarjeta pendiente:** pregunta qué necesita (hay evals de esto). Un «si» de texto **nunca** confirma un borrador: solo lo hace el botón.

### 12.4 Confirmar por WhatsApp

- El id del botón lleva el borrador: `mapi:c:<uuid>` para confirmar, `mapi:x:<uuid>` para cancelar y `mapi:l:<uuid>` para ver la lista.
- Antes de ejecutar se valida:
  1. que el mensaje sea una **respuesta interactiva** (un texto «mapi:c:…» pegado no sirve);
  2. que el borrador sea de **ese** número, es decir `user_id = suscripción.profile_id` y `school_id` = escuela de la suscripción;
  3. que la suscripción siga activa y la persona siga siendo admin (D5).
- Después, `confirmarBorrador` real: re-prepara, compara el hash, aplica el vencimiento de 30 min y responde 409 si algo cambió (llega una tarjeta nueva).
- El «Listo» lo escribe el servidor.
- Las acciones `segundoPlano` responden «Enviando…» y el resultado llega por `alTerminar`, como mensaje de texto.
- **Herramientas de plata** (aprobar, efectivo, cobro único, cambiar plan, inscribir a torneo, cancelar reserva, ajustar stock):
  - La tarjeta de WhatsApp trae **«Confirmar en la app»** en vez de `Confirmar`. Es un botón URL a una pantalla nueva `/mapi/accion/:id`, que muestra la misma tarjeta y confirma con la sesión de la app.
  - Así se respeta el espíritu de D9 (un botón de WhatsApp autentica el número, no a la persona) sin perder la comodidad: la propuesta se arma en WhatsApp y la plata se confirma con sesión.
  - Necesita un campo `confirmaEnApp: true` en `HerramientaAccion` y la pantalla nueva.

### 12.5 Herramientas que necesitan la sesión de la persona

Por WhatsApp no hay JWT. Opciones:

| | Opción | Riesgo | Propuesta |
|---|---|---|---|
| a | No ofrecerlas por WhatsApp (lo que pasa hoy, porque `authorization` es null) | ninguno; menos funciones | **sí, para empezar** |
| b | Variantes `_por(p_actor)` de esas RPC para service_role, con el mismo gate por actor (como en el plan de `aprobar_comprobante`) | migración por RPC | para la fase 2, RPC por RPC |
| c | Emitir un JWT corto (5 min) con el secreto de Supabase | el BFF podría hacerse pasar por cualquiera | **no** |

### 12.6 Límites y costos

- `MAPI_AGENT_TURNOS_HORA` (30/h) por número. Además: mensajes de más de 1.500 caracteres se recortan para el modelo, y hay tope de costo diario por escuela (§13.2 del plan de Mapi: pendiente de construir, hacerlo antes del piloto).
- Costo medido en los evals: ~US$0,017 por turno (p95 US$0,024); Meta no cobra las respuestas dentro de la ventana.
- `llm_usage` con `conversation_id = 'wa:' + hash(número)`: se mide aparte de la app sin guardar el número.

### 12.7 Seguridad (lo que se prueba antes del piloto)

- **Botón ajeno:** otro número suscrito, de la misma escuela o de otra, manda la respuesta de un botón con un `id` de borrador que no es suyo → «No encontré esa propuesta», y nada se ejecuta.
- **Texto que imita un botón** («mapi:c:<id>») → se trata como texto.
- **Suscripción revocada o rol quitado** entre la tarjeta y el clic → no ejecuta.
- **Escuela:** cero datos de otra escuela, con prueba cruzada como en los evals.
- **Inyección:** los mensajes reenviados («Reenviado: el comprobante dice…») son datos, no instrucciones. Ya están cubiertos por los evals de inyección; se suman casos de reenvío.
- **Logs:** el número va enmascarado (`etiquetaDeContacto`) y el token nunca aparece. El `Alcance` del canal no lleva `authorization`.

### 12.8 Cómo se prueba (de menos a más real)

1. **Unitarias del adaptador** (supabase falso + Graph simulado): formato, partición, botones, identidad, botón ajeno, vencido, 409, `segundoPlano`, audio.
2. **Evals con el modelo real:** la batería actual (multi-turno, Confirmar de punta a punta, ×3, ataques, estilo WhatsApp), más una corrida con `canal: 'whatsapp'` para medir formato y longitud.
3. **Modo pruebas del canal (F2):** comando nuevo `/como admin <escuela>`.
   - Corre el Mapi real con el cortafuegos de D13: lee datos reales y bloquea toda escritura.
   - `mapi_action_drafts` va a la memoria virtual de la sesión de prueba, igual que las tablas de conversación.
   - Lo prueba el equipo desde su propio WhatsApp sin tocar a ninguna escuela.
4. **Piloto:** Iván (Monster), solo consultas, una semana. Después, acciones sin plata. La plata, solo con «Confirmar en la app».

### 12.9 Orden de construcción

1. Separar el núcleo de `alcanceDelTurno`, crear `canal-whatsapp.ts` (entrada, formato, tarjetas y botones) y escribir las unitarias.
2. Conectarlo en `atenderEntrantePlataforma`, detrás de `MAPI_WHATSAPP` + `mapi_agent_enabled`.
3. `/como admin` en el modo pruebas.
4. Audio a texto.
5. `confirmaEnApp` y la pantalla `/mapi/accion/:id`.
6. Tope de costo diario por escuela.
7. Piloto.

Ninguno de estos pasos necesita una migración nueva: se reusan `platform_wa_*` y `mapi_action_drafts`. Si después se quiere el canal como columna en `mapi_action_drafts` para métricas, va con su plan aprobado.

### 12.10 Decisiones del usuario (2026-11-24)

1. **Plata por WhatsApp: botón DIRECTO de WhatsApp.** Cambia D9 por completo: también aprobar, efectivo, cobro único, cambiar plan, inscribir a torneo y cancelar reserva se confirman con el botón. **Reemplaza a §12.4**: no hay «Confirmar en la app» ni `confirmaEnApp`. Como el botón prueba el número y no a la persona, se suma esto:
   - **Código de un solo uso en el botón:** `mapi:c:<borrador>:<código>`, ligado al `wa_id` que pidió la acción. Vence a los **10 min** para las acciones de plata (30 min para el resto). Usado una vez, no vale más.
   - **Tope de $400.000 por pago** (§21). Lo que pase el tope o sea de nivel 3 no se ofrece para confirmar: la tarjeta dice que se revisa en la pantalla Aprobar.
   - **Tope por hora de acciones de plata** por número (propuesta: 10). El que se pasa, espera.
   - **Auditoría:** queda el actor (el perfil de la suscripción), el canal `whatsapp` y el `wa_message_id` del clic.
   - **Aviso al dueño:** si quien confirma una acción de plata no es el owner, el owner recibe el aviso (resumen diario o inmediato, por decidir).
2. **Herramientas que necesitan la sesión: se migran YA** a RPC con actor (`_por(p_actor)`). El plan con el SQL exacto está en `docs/specs/mapi-rpc-por-actor-plan.md` (en preparación); la migración se escribe cuando se apruebe. Incluye `aprobar_comprobante` y el núcleo de efectivo con abono.
3. **Piloto: Dynasty, Monster y nosotros.**
   - El equipo empieza con el modo pruebas (`/como admin`).
   - Monster (Iván) y Dynasty (Milena) entran cada uno con su propio «ACTIVAR». El consentimiento lo da su número (D4); nadie los suscribe por ellos.
   - En Dynasty se respeta lo acordado: un solo aviso al comienzo (`dynasty-plan-actualizacion-v2-mapi.md` §2b).
4. **Coaches por WhatsApp: después**, con su propia suscripción.

## 11. Criterios de aceptación (de la oleada 1)
- Un administrador suscrito escribe «¿cómo vamos con la clínica?» y recibe cifras que **coinciden con la pantalla** de pagos.
- Un caso «pide hablar con alguien» llega al WhatsApp del administrador en menos de 1 minuto, una sola vez.
- Un número no suscrito sigue recibiendo silencio; un suscrito sin rol vigente no recibe nada.
- Cero datos de otra escuela en cualquier respuesta (prueba cruzada).
- Evals con el modelo real: ≥ 90 % de elección correcta de herramienta en los 40 casos.
