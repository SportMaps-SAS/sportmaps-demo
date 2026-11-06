# SPEC — Comprobantes de pago recibidos por correo (ingesta vía email)

> **Estado:** borrador para discusión · **Fecha:** 2026-11-05
> **Objetivo:** que un acudiente/atleta pueda mandar su comprobante de pago **por correo**
> (adjunto, al buzón de la escuela) y que el sistema lo procese con el mismo pipeline de
> OCR/veredicto que ya existe para los uploads manuales en la app — en vez de que alguien de
> la escuela lo revise y lo cargue a mano.

## 0. Contexto y motivación

Monster´s Volley Club (`school_id eb3ebc77-4ea4-4992-96c8-3c8ec574578c`) recibe HOY los
comprobantes de pago de sus acudientes directamente en `monstersvolleyclub@gmail.com` (correo
real de Gmail de la escuela) y alguien del staff los revisa manualmente uno por uno para
marcar los pagos en el sistema. Monster sería el primer piloto de esta funcionalidad.

Esto coincide en el tiempo con el envío masivo de 118 invitaciones a las fichas sin cuenta de
Monster (2026-11-05): de esas, 111 siguen `pending` — es decir, **ahora mismo hay familias
reales de Monster que pueden mandar su comprobante por correo ANTES de haber aceptado su
invitación y creado su cuenta.** Ese caso de borde es real, no hipotético, y se trata en §7.

## 1. Decisiones de producto YA TOMADAS (no se vuelven a discutir)

1. **Sin cruce automático → cola de revisión manual.** Cuando el remitente del correo no
   cruza con ningún `guardian_email` / `email` de ficha / `parent_email_temp` / correo de
   cuenta conocido, el comprobante **no se descarta ni se auto-asigna a ciegas**: queda
   visible para la escuela en una cola, para que lo asignen a mano al pago/niño correcto.
2. **Funcionalidad de plataforma, no solo para Monster.** Se construye como un toggle de
   escuela (mismo patrón de activación que `bank_email_reconciliation_enabled`), no
   hardcodeado para Monster. Monster es el primer piloto, no el único cliente.
3. **Nunca auto-aprobar por este canal.** Un verde por correo nunca marca el pago como pagado
   solo: siempre pasa por un clic humano de la escuela antes de aplicarse. El ancla de
   identidad (conocer la dirección secreta de reenvío) es más débil que un padre logueado con
   JWT, así que no recibe el mismo privilegio de auto-aprobación — ver §5.3.
4. **Ficha sin cuenta: ambos caminos desde el día 1.** El comprobante queda en cola de revisión
   manual **y además** la notificación a la escuela trae un acceso directo para reenviarle el
   link de invitación a ese acudiente (ya sabemos que está activo: acaba de escribir) — ver §7.
5. **Varios adjuntos en un mismo correo → uno por adjunto.** Cada adjunto elegible se procesa
   como un mensaje independiente por el pipeline de OCR/cruce (cubre el caso real de hermanos:
   un papá manda dos comprobantes de dos hijos en un solo correo).
6. **Correo sin ningún adjunto pero que menciona un pago → aviso silencioso.** Se guarda con
   `estado = 'sin_adjunto'` y aparece en la cola para que la escuela sepa que alguien escribió
   algo relacionado a un pago, sin intentar procesarlo — no se ignora por completo.
7. **Activación: pantalla propia**, no se reusa el flujo de confirmación de reenvío de Gmail del
   banco. Los dos canales (banco vs. comprobantes de afiliados) son conceptualmente distintos
   para quien configura la escuela, y conviene que cada uno tenga su propio texto/instrucciones
   aunque el mecanismo de Resend Inbound por debajo sea el mismo — ver §8-bis.
8. **La cola de revisión NO es "banco" o "comprobante" por separado: es por PAGO, y se funden
   ambas evidencias cuando aplican.** Aclaración del usuario (2026-11-05): en Monster es común
   que el mismo acudiente mande por correo TANTO el comprobante (foto/PDF) COMO —en el mismo
   hilo o en uno aparte— el aviso que el banco le manda a él (reenviado), para el mismo pago.
   La pantalla de revisión debe mostrar UNA fila por pago/transacción candidata, con las DOS
   piezas de evidencia adjuntas cuando ambas lleguen (bandera `via_banco` + `via_comprobante`
   sobre el mismo `matched_payment_id`), no dos filas sueltas sin relación que alguien tenga que
   cruzar a mano comparando dos pantallas. Ver §6 y §8-bis para el mecanismo de correlación.

## 2. Qué se reusa tal cual, y qué es nuevo

Esta feature **reutiliza el 90% de la infraestructura** de
`docs/specs/conciliacion-correo-banco-dkim.md` (correos del banco por DKIM), que ya está en
producción y probada. La pieza de ingesta (Resend Inbound + webhook + firma Svix) es idéntica;
lo que cambia es QUÉ se verifica del remitente y QUÉ se hace con el contenido.

| Pieza | Banco (existente) | Comprobantes de afiliados (nuevo) |
|---|---|---|
| Transporte | Resend Inbound, evento `email.received` | **Igual** (mismo dominio, mismo webhook de Resend) |
| Firma del webhook | Svix sobre el cuerpo crudo | **Igual**, sin cambios |
| Dirección de entrada | `banco+<token>@<dominio>` | **Nueva**: `comprobante+<token>@<dominio>` (mismo `<dominio>`, prefijo distinto para rutear a un handler distinto desde el mismo webhook) |
| Config por escuela | `bank_email_inboxes` (token → school_id, mailboxes del banco) | **Nueva tabla análoga**: `receipt_email_inboxes` (token → school_id) — no necesita `mailboxes` (no hay una lista blanca de remitentes-banco; ver §5) |
| Flag de activación | `school_settings.bank_email_reconciliation_enabled` | **Nueva columna**: `school_settings.receipt_email_intake_enabled` |
| Verificación de autenticidad | DKIM contra DNS del banco (`verificarCorreoBancario`) | **Distinta por naturaleza** — ver §5, no hay "banco" que firmar |
| Parser de contenido | Texto plano → monto/fecha/remitente (`banco-correo-parser.service`) | **Nuevo**: toma el/los ADJUNTO(S) del correo (imagen/PDF) en vez de leer texto |
| Pipeline de extracción | — | **Reusa** `extractReceipt()` (`bff/src/services/ocr.service.ts`), la MISMA función que usa `POST /api/v1/payments/extract-receipt`, importada directo (no vía HTTP: no hay JWT de un padre logueado) |
| Veredicto / reglas | — | **Reusa** el pipeline de §2 de `receipt-extraction-v2-glosas.md` (verde/amarillo/rojo) tal cual |
| Ciclo de disputa | — | **Reusa el módulo de GLOSAS** (§5 de `receipt-extraction-v2-glosas.md`) para todo lo que no sea verde limpio — no se inventa un segundo sistema de disputa |
| Cruce correo→pago | `decidirCruce()` (monto+fecha+destino+nombre, TODOS los pagos de la escuela) | **Nuevo, pero misma forma**: primero se acota a los pagos de los HIJOS/cuenta del remitente (si cruza), y recién ahí monto+fecha como desempate — ver §4 |
| Tabla de resultado | `bank_email_notices` | **Nueva tabla análoga**: `receipt_email_messages` |
| RPC de aplicación | `bank_email_notice_apply` | **Nueva RPC análoga**: `receipt_email_message_apply` |

## 3. Arquitectura — flujo completo

```
Acudiente de Monster
   │ manda correo con foto/PDF del comprobante adjunto
   ▼
comprobante+<token>@<dominio Resend Inbound>
   (la escuela configura un filtro de Gmail que reenvía ahí los correos
    que le llegan a monstersvolleyclub@gmail.com con un adjunto)
   │
   ▼
POST /api/v1/webhooks/resend-inbound   (MISMO webhook que ya existe)
   │  1. Verifica firma Svix (igual que hoy)
   │  2. Por el prefijo del destinatario (`comprobante+` vs `banco+`) rutea
   │     a un handler NUEVO: procesarEventoResendComprobante()
   ▼
procesarEventoResendComprobante()
   │  1. token → school_id (tabla receipt_email_inboxes)
   │  2. flag receipt_email_intake_enabled → si está apagado, se ignora
   │  3. Descarga el MIME crudo (Resend GET /emails/receiving/{id}), igual que hoy
   │  4. Extrae adjuntos elegibles (image/*, application/pdf) — ver §5 límites
   │  5. Si CERO adjuntos elegibles → se guarda como 'sin_adjunto', no se procesa
   │  6. Resuelve remitente → candidato de acudiente/atleta (§4)
   │  7. Por cada adjunto: extractReceipt() (LLM Vision) + pipeline de veredicto
   │  8. Cruce contra pagos del candidato (si lo hay) → payment_id probable, o ninguno
   ▼
   ┌─────────────────────────────┬──────────────────────────────┐
   │ Remitente + pago resueltos  │ Remitente o pago NO resueltos │
   │ y veredicto VERDE           │ (ambiguo / sin cruce / rojo)  │
   ▼                             ▼
 Igual que un upload manual:   Fila en receipt_email_messages
 auto-aprueba si corresponde,  con estado 'revision_pendiente',
 o GLOSA si no (reusa el       visible en la pantalla de la
 pipeline de reglas y el       escuela para asignar a mano
 módulo de glosas existente)   (mismo lugar donde hoy se ve
                                'sin_cruce'/'ambiguo' de banco)
```

## 4. Cruce remitente → acudiente → pago

A diferencia del banco (que cruza por monto+fecha contra TODOS los pagos de la escuela,
porque el aviso no dice de quién es), acá el correo SÍ trae quién lo mandó. Dos pasos:

**Paso A — ¿quién es el remitente?** Buscar el `From:` (dirección, no el nombre visible) contra,
en este orden, dentro de la escuela:
1. `auth.users.email` de un `school_members` activo con rol `parent`/`athlete` de esa escuela.
2. `unregistered_athletes.guardian_email` o `unregistered_athletes.email` (ficha activa,
   `linked_profile_id IS NULL`) — cubre exactamente el caso de las 111 invitaciones `pending`
   de Monster: la familia ya puede mandar comprobante aunque no haya aceptado la invitación.
3. `children.parent_email_temp` (hijo cargado manualmente, acudiente sin cuenta aún).

Si el remitente no aparece en NINGUNA de las tres → **cola de revisión manual** directo,
sin intentar adivinar por monto/fecha (decisión §1.1: no hay suficiente certeza sin ancla de
identidad, a diferencia del banco que sí tiene monto+fecha+destino como ancla fuerte).

**Paso B — ¿cuál de sus pagos/fichas es?** Con el remitente resuelto, se acota el universo de
`decidirCruce()` a SOLO los pagos (`payments` o, si aún no hay cuenta ni `payments.parent_id`,
el pago PROYECTADO de la ficha — ver §7) de ese acudiente/sus hijos, y ahí sí monto+fecha
desempatan igual que hoy. Si tiene un solo hijo con un solo pago pendiente, no hace falta ni
monto: ya está resuelto por identidad sola (pero igual se corre la extracción para el veredicto
verde/amarillo/rojo — la identidad no exime el pipeline de reglas).

## 5. Seguridad — el punto más delicado del spec

El banco se verifica con DKIM porque **cualquiera puede escribir un "From:" falso**, y lo que
no se puede falsificar es la firma del banco. Un comprobante de un papá **no tiene ese ancla**:
no hay un "banco" que lo firme — es una foto/PDF que cualquiera pudo editar.

Esto significa que **el correo entrante NUNCA puede ser, por sí solo, motivo de auto-aprobación
a ciegas.** Las salvaguardas:

1. **El canal no sustituye el pipeline de reglas, lo alimenta.** Un comprobante que llega por
   correo pasa por EXACTAMENTE las mismas reglas verde/amarillo/rojo que uno subido por la app
   (§2 de `receipt-extraction-v2-glosas.md`) — monto exacto, fecha en ventana, referencia no
   duplicada, destino registrado, etc. Nada de esto se relaja por venir de este canal nuevo.
2. **La dirección de reenvío (`comprobante+<token>@...`) es un secreto por escuela**, igual que
   hoy con `banco+<token>@...` — no se publica, cada escuela la configura una sola vez en su
   filtro de Gmail. Conocerla no alcanza para inyectar un pago: alcanza para que el correo
   ENTRE al pipeline de extracción, que igual exige que monto+fecha+destino coincidan con un
   cobro real pendiente de ESA escuela.
3. **Resuelto (§1.3): nunca se auto-aprueba por este canal.** Un padre logueado ya probó ser
   dueño de esa cuenta (JWT); un correo solo probó que conoce la dirección secreta de reenvío,
   un estándar más débil de identidad. Todo verde-por-correo queda en estado
   `revision_pendiente` con el veredicto ya calculado (no hay que repetir el OCR), con una
   bandera `via_correo = true` visible al admin, y un botón de un clic "Aplicar" que es lo único
   que mueve el pago a pagado — la escuela sigue viendo el veredicto verde como ayuda, pero la
   decisión final es humana.
4. **Límite de tamaño y tipo de adjunto**, igual que `extract-receipt` hoy (whitelist de
   `image/png|jpeg|webp` y `application/pdf`, tope ~6 MB) — un adjunto que no sea esos tipos no
   entra al pipeline, se descarta sin procesar (no es un "comprobante ilegible", es ruido:
   firmas de correo con logos, archivos .exe, etc.).
5. **Idempotencia igual que hoy**: `(resend_email_id)` y `(message_id, body_sha256)` únicos —
   un reintento de Resend no duplica el procesamiento ni el pago.

## 6. Modelo de datos (propuesta, sin SQL final todavía)

Respetando las convenciones obligatorias del CLAUDE.md del repo (texto+CHECK no enums,
migraciones inmutables con timestamp nuevo, `GRANT EXECUTE` explícito por rol, `search_path`
fijo en toda función nueva, RLS sin auto-recursión, FKs de negocio a `profiles`):

- **`receipt_email_inboxes`** — análoga a `bank_email_inboxes`: `token` (pk, el mismo patrón de
  20 hex), `school_id` (FK `schools`). Sin columna `mailboxes` (no aplica, ver §5).
- **`school_settings.receipt_email_intake_enabled`** (boolean, default false) — columna nueva,
  no tabla nueva (mismo lugar que el flag del banco).
- **`receipt_email_messages`** — análoga a `bank_email_notices`, **una fila por ADJUNTO** (§1.5:
  uno por adjunto, no por correo): columnas de entrega/idempotencia iguales (`resend_email_id`,
  `message_id`, `body_sha256`, `recipient`, `from_address`, `subject`), más: `attachment_index`,
  `matched_profile_id` (nullable, FK `profiles`), `matched_unregistered_athlete_id` (nullable,
  FK `unregistered_athletes`), `matched_payment_id` (nullable, FK `payments`), `estado`
  (`text + CHECK`: `'revision_pendiente' | 'aplicado' | 'sin_adjunto' | 'rechazado' |
  'duplicado'` — nunca `'auto_procesado'`, por §1.3), `ocr_result` (jsonb, lo que devolvió
  `extractReceipt()`), `veredicto` (`'verde'|'amarillo'|'rojo'`), `via_correo` boolean (bandera
  de §1.3/§5.3).
- **Correlación con `bank_email_notices` (§1.8 — NUEVO, es el punto que cambia el diseño de la
  pantalla):** cuando `matched_payment_id` queda resuelto (de cualquiera de las dos tablas), se
  usa ESE `payment_id` como llave de agrupación en la pantalla, no la tabla de origen. La
  pantalla de revisión consulta **una vista** `v_payment_evidence_queue` (o similar) que hace
  `FULL OUTER JOIN` de `bank_email_notices` y `receipt_email_messages` por `matched_payment_id`
  (cuando ambos lo tienen) y muestra una sola fila por pago candidato con dos columnas de
  evidencia (`aviso_banco` / `comprobante_correo`), cada una pudiendo estar vacía. Si llegan en
  momentos distintos (lo normal: primero el comprobante del papá, el aviso del banco tarda más
  o nunca llega si el papá no lo reenvía), la fila se actualiza in-place agregando la segunda
  evidencia en vez de crear una fila nueva — evita que la escuela tenga que cruzar a mano dos
  pantallas para el mismo pago.
- **RPC `receipt_email_message_apply`** — análoga a `bank_email_notice_apply`: SECURITY DEFINER,
  `search_path` fijo, aplica el resultado del cruce de forma atómica (actualiza
  `receipt_email_messages` y, si corresponde, `payments`/abre glosa), con `GRANT EXECUTE`
  explícito solo a `service_role` (la llama el BFF, nunca el cliente).
- **RLS**: la escuela ve sus propias filas de `receipt_email_messages` (mismo patrón que
  `bank_email_notices`, vía `user_staff_school_ids()` para lectura/asignación manual — es
  escritura operativa, no de alcance amplio como `user_school_ids()`).

## 7. Caso de borde real: comprobante de alguien que AÚN no tiene cuenta

`payments.parent_id` es `NOT NULL` contra `auth.users` — no puede existir una fila de `payments`
para una ficha sin cuenta. Con 111 invitaciones `pending` de Monster hoy, es el caso más
probable del piloto, no una rareza. Dos caminos, a decidir en §8:

- **(a) Cola de espera:** el comprobante queda en `receipt_email_messages` con
  `matched_unregistered_athlete_id` resuelto pero `matched_payment_id = NULL` y
  `estado = 'revision_pendiente'`, visible para que la escuela lo asocie a mano al concepto que
  corresponda (igual que hace hoy manualmente), y/o se re-intenta el cruce automático la
  próxima vez que ese acudiente acepte su invitación y su ficha migre a un `payment` real.
- **(b) Empujar la aceptación:** la notificación a la escuela incluye un acceso directo para
  reenviarle el link de invitación a ese acudiente (ya tiene su correo, ya sabemos que está
  activo porque escribió).

Ambos caminos conviven desde el día 1 (resuelto, §1.4): cola de espera **y** acceso directo a
reenviar el link de invitación.

## 8. Decisiones de producto — resueltas 2026-11-05

Las 6 quedaron resueltas en la conversación con el usuario (ver §1 para el detalle de cada una):
auto-aprobación (nunca, §1.3) · ficha sin cuenta (ambos caminos, §1.4) · multi-adjunto (uno por
adjunto, §1.5) · correo sin adjunto (aviso silencioso, §1.6) · activación (pantalla propia,
§8-bis) · pantalla de revisión (correlación por pago, no por tabla de origen, §1.8 y §6).

No queda ninguna decisión de producto abierta para empezar F0/F1. Lo que sigue son detalles de
implementación a resolver al escribir el código (no bloquean el inicio):

- Texto exacto e instrucciones de la pantalla propia de activación (§8-bis).
- Nombre final de la vista de correlación (`v_payment_evidence_queue` es un nombre de trabajo).
- Si `attachment_index` + `message_id` alcanza como llave de idempotencia por adjunto, o hace
  falta además el hash del adjunto (dos adjuntos distintos podrían, en teoría, tener el mismo
  índice si Resend reintenta con un MIME reordenado — improbable pero verificar al implementar).

## 8-bis. Pantalla propia de activación (§1.7)

Una pantalla nueva en la configuración de la escuela, separada del flujo de activación del
banco, con su propio copy: "Recibe los comprobantes que te mandan tus familias por correo".
Genera su propio `token` (tabla `receipt_email_inboxes`), arma la dirección
`comprobante+<token>@<dominio>` y muestra las instrucciones de filtro de Gmail (mismo texto base
que ya existe para bancos, adaptado). Puede **reusar el componente de UI** que ya dibuja esas
instrucciones de filtro (es el mismo patrón visual), pero como pantalla/ruta independiente, no
como una opción dentro del flujo de banco — para que la escuela entienda que son dos cosas
distintas que puede prender por separado.

## 9. Plan de fases

- **F0 — Medición (sin código):** con el piloto de Monster, confirmar qué % de los correos que
  hoy llegan a `monstersvolleyclub@gmail.com` con comprobante tienen un remitente que SÍ cruza
  limpio contra un acudiente/ficha conocido. Si el % es bajo, la cola de revisión manual es el
  camino principal, no la excepción, y cambia cuánto esfuerzo vale la pena poner en F2.
- **F1 — Ingesta + cola de revisión manual (sin auto-match):** webhook nuevo, tabla de config,
  TODO comprobante entrante cae en `receipt_email_messages` con `estado = 'revision_pendiente'`
  y se asigna 100% a mano desde una pantalla nueva o reusada. Ya resuelve el dolor principal
  (nadie busca el adjunto a mano en Gmail), aunque no automatice el cruce todavía.
- **F2 — Auto-match (remitente + monto/fecha):** suma §4 completo — resuelve SOLO a qué
  pago/niño corresponde el comprobante (deja de ser 100% manual asignar), pero sigue sin
  auto-aprobar (§1.3): el caso feliz pasa de "buscar a mano el adjunto y el pago" a "un clic de
  Aplicar sobre una fila ya pre-llenada", nunca a cero intervención humana.
- **F3 — Piloto en vivo con Monster:** activar el flag, pedirle a Monster que configure el
  filtro de Gmail, medir una semana real.
- **F4 — Generalizar activación por escuela:** pantalla de self-service (igual que el flujo de
  banco) para que cualquier escuela prenda esto sin intervención de desarrollo.

---

**Archivos reales que ancla este spec** (para no partir de cero al implementar):
`bff/src/routes/resend-inbound.routes.ts`, `bff/src/services/banco-correo-dkim.service.ts`,
`bff/src/services/banco-correo-cruce.service.ts`, `bff/src/services/banco-correo-repo.service.ts`,
`bff/src/services/ocr.service.ts`, `bff/src/routes/payments.routes.ts` (`extract-receipt`),
`docs/specs/conciliacion-correo-banco-dkim.md`, `docs/specs/receipt-extraction-v2-glosas.md`.
