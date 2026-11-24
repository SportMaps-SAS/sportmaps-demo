# Registros nuevos del 19 al 22 de noviembre de 2026 y propuesta de tutorial guiado

- **Rango analizado:** jueves 19-nov-2026 00:00 a domingo 22-nov-2026 23:59, hora de Bogotá.
- **Corte de los datos:** domingo 22-nov-2026 11:24. Lo que pase el resto del domingo no está incluido.
- **Método:** lectura del código de registro y onboarding, y consultas de solo lectura a la base. No se modificó nada.
- **Estado:** análisis y propuesta. Nada implementado; espera aprobación.

## Resumen

En cuatro días se registraron **6 cuentas**: 2 academias, 1 club de espacios («Club / Canchas»), 3 acudientes. Cero entrenadores, cero atletas, cero registros con Google.

- De las 3 cuentas de negocio, solo terminó el asistente inicial una, y por el nombre parece una cuenta interna de prueba («pruebas demo»). Las dos reales lo dejaron a los 1–2 minutos y no volvieron.
- Ninguna de las 3 llegó a un primer cobro ni conectó WhatsApp. Ni siquiera la que terminó el asistente: el asistente no lleva hasta ahí.
- De los 3 acudientes, 2 quedaron vinculados a su escuela en menos de 2 minutos. La tercera lleva 3 días esperando a que la escuela apruebe su solicitud.
- No existe tracking de eventos. La tabla `analytics_events` existe pero ningún código escribe en ella. Todo lo de abajo está inferido por los registros que cada cuenta creó.

Con 6 cuentas, los porcentajes son ilustrativos, no estadística. Lo sólido de este análisis son las causas que se ven en el código, no los números.

---

## Parte 1 — Qué pasó

### 1.1 Cómo funciona hoy el registro y el onboarding

**Registro** (`/register`, `frontend/src/pages/RegisterPage.tsx`). Un solo formulario: correo, contraseña, nombre, WhatsApp, rol (9 tarjetas) y campos según el rol (nombre de la academia y deporte para «Escuela»; nombre para «Club / Canchas» y «Organizador»; fecha de nacimiento para personas; casilla de mayoría de edad para acudiente). El correo se autoconfirma, así que la cuenta queda con sesión al instante.

**Lo que crea la base sola.** El trigger `handle_new_user` crea el perfil y, si el rol es escuela o club, la fila en `schools` con `onboarding_status = 'in_progress'`. El trigger de `schools` crea la «Sede Principal», la fila de `school_settings` y la membresía de dueño.

**Asistente por rol**, forzado desde `DashboardPage` (no se puede entrar al panel hasta terminarlo):

| Rol | Ruta | Pasos, en orden | Qué deja en la base |
|---|---|---|---|
| Academia | `/onboarding/school` | 1. Tu sede · 2. Modelo (equipos / planes / ambos) · 3. Primer equipo y/o primer plan · 4. Entrenador · 5. Primer atleta · 6. Cobros | `school_branches`, `schools.business_model`, `teams`, `offerings` + `offering_plans`, `school_staff`, `children`, `school_settings`, y al final `schools.onboarding_status = 'completed'` |
| Club / Canchas | `/venue/onboarding` | 1. Tu espacio (nombre, ciudad) · 2. Primera cancha · 3. ¿Cómo te pagan? | `schools.city`, `facilities`, `onboarding_status` |
| Acudiente | `/onboarding/parent` | 1. Tus datos · 2. Tus hijos (código de escuela, «Agregar a mi hijo/a» o «Más tarde») | `profiles.onboarding_completed`, y según el camino: `school_join_requests`, `children`, `school_members` |
| Entrenador, atleta, profesional | `/onboarding/coach`, `/athlete`, `/wellness` | Perfil | `profiles.onboarding_completed`, `coach_profiles` |

En el asistente de academia, los pasos 1 a 3 son obligatorios y no tienen botón «Saltar»; 4 a 6 sí se pueden saltar.

**Después del asistente.** Existe un checklist en el panel (`DashboardChecklist` + `getStepsForRole`), pero solo se muestra mientras `onboarding_status` no sea `completed`. Como el asistente bloquea el panel hasta quedar en `completed`, en la práctica el dueño de academia nunca ve ese checklist.

**Tracking y logs disponibles:**

| Fuente | Estado |
|---|---|
| `analytics_events` | Existe. Nadie escribe en ella. 0 eventos de estas 6 cuentas. |
| `audit_logs` | Solo cambios en algunas tablas (pagos, ajustes). Sirve de reloj, no de embudo. |
| `auth.audit_log_entries` | Registro, login y refresco de sesión. Sirve para saber si alguien volvió. |
| `school_join_code_attempts` | Intentos de código de escuela, con éxito o fallo. |
| `system_errors` | 0 filas en el rango. |
| `email_sends` | Correos enviados y su estado. |
| Sentry (frontend), logs de Render (BFF), logs de la API de Supabase | **No se revisaron**: no hay acceso desde esta sesión. Ver 1.6. |

### 1.2 Registros por rol

| Rol | Cuentas | Detalle |
|---|---|---|
| Admin de academia | 2 | SAQUYEN RITMOS · pruebas demo (probable cuenta interna) |
| Club / Canchas | 1 | Club runner SKATE |
| Entrenador | 0 | — |
| Acudiente | 3 | 2 en Monster's Volley Club, 1 en Dreamers Gymnastics |
| Atleta | 0 | — |
| Otro | 0 | — |

Todas por correo y contraseña. Cuatro desde celular Android, dos desde computador Windows.

### 1.3 Hasta dónde llegó cada uno

| Cuenta | Rol | Registro | Último paso alcanzado | Tiempo registro → último paso | ¿Volvió? |
|---|---|---|---|---|---|
| **SAQUYEN RITMOS** (`84d17ad7`) | Academia | sáb 21, 20:09 · celular | Eligió modelo «Ambos». No creó equipo ni plan. | 2 min 20 s | No. Una sola sesión, nunca refrescada. |
| **Club runner SKATE** (`06ac909e`) | Club / Canchas | jue 19, 19:08 · celular | Creó su espacio (ciudad) y una instalación de tipo «Otro». No pulsó «Terminar» en «¿Cómo te pagan?». | 1 min 18 s | No. |
| **pruebas demo** (`e13bed1a`) | Academia | vie 20, 15:15 · computador | Asistente completo: plan, entrenador, atleta y cobros. Sin inscripciones ni cobros creados. | 2 min 23 s | No. |
| **Acudiente `264882c7`** → Monster's Volley Club | Acudiente | jue 19, 09:58 · computador | Terminó su perfil y envió solicitud con el código de la escuela. **Sigue «pendiente» de aprobación.** Sin hijo ni membresía. | 3 min 53 s | No. |
| **Acudiente `d1e2ac42`** → Monster's Volley Club | Acudiente | vie 20, 11:21 · celular | Vinculada a la escuela con su deportista; ve cobros (ya pagados). | 1 min 35 s | No. Dos avisos sin leer. |
| **Acudiente `ef3642d7`** → Dreamers Gymnastics | Acudiente | vie 20, 11:34 · celular | Llegó por invitación: vinculada al instante con 2 deportistas e inscripciones activas. Tiene un cobro pendiente. | 1 s | Sí, el mismo día a las 16:02. Cuatro avisos sin leer. |

Notas sobre lo que **no** se puede saber:

- «¿Volvió?» sale de si la sesión se refrescó (el token dura cerca de una hora). Alguien que usó la app 50 minutos seguidos se ve igual que alguien que la cerró a los 3.
- De la acudiente `d1e2ac42` no pude confirmar el camino exacto del vínculo. Usó el código de escuela y quedó enlazada sin solicitud pendiente; las inscripciones del deportista son de agosto y noviembre, lo que apunta a que la escuela ya lo tenía cargado.
- El pago de $20.000 con comprobante del 21-nov en la cuenta `ef3642d7` no se puede atribuir: su sesión no se refrescó después del 20, así que pudo registrarlo la escuela o entrar por WhatsApp.
- «pruebas demo» parece interna por el nombre de la cuenta y de la academia. No hay un campo que lo confirme.
- La acudiente `264882c7` y el dueño de SAQUYEN RITMOS comparten apellido. No hay dato que diga si tienen relación.
- No se puede saber cuánta gente abrió `/register` y no terminó: el formulario no deja rastro.

### 1.4 Embudo

**Cuentas de negocio (3: 2 academias + 1 club).** Entre paréntesis, sin contar «pruebas demo».

| Paso | Llegaron | % del inicio | Caída vs. paso anterior |
|---|---|---|---|
| Cuenta creada | 3 (2) | 100 % | — |
| Academia / espacio creado (automático) | 3 (2) | 100 % | 0 % |
| Sede con dirección | 0 (0) | 0 % | ver nota |
| Modelo elegido o espacio confirmado | 3 (2) | 100 % | 0 % |
| Primer equipo, plan o cancha | 2 (1) | 67 % | **−33 %** |
| Entrenador agregado | 1 (0) | 33 % | −50 % |
| Primer deportista | 1 (0) | 33 % | 0 % |
| Cobros configurados | 1 (0) | 33 % | 0 % |
| Asistente terminado | 1 (0) | 33 % | 0 % |
| Primera inscripción con plan | 0 | 0 % | **−100 %** |
| Primer cobro | 0 | 0 % | — |
| WhatsApp conectado | 0 | 0 % | — |

Nota: «Sede con dirección» es 0 de 3 porque el paso nunca se muestra (ver 1.5, hallazgo B). No es abandono, es un paso que el asistente se salta solo.

**Acudientes (3).**

| Paso | Llegaron | % | Caída |
|---|---|---|---|
| Cuenta creada | 3 | 100 % | — |
| Perfil / onboarding cerrado | 3 | 100 % | 0 % |
| Vinculado a una escuela | 2 | 67 % | **−33 %** (1 esperando aprobación) |
| Deportista visible | 2 | 67 % | 0 % |
| Cobro visible | 2 | 67 % | 0 % |
| Volvió después de la primera sesión | 1 | 33 % | −50 % |

### 1.5 Los 3 puntos donde más se abandona

**1. Academia: «Primer equipo» / «Primer plan», justo después de elegir el modelo.**
Caso: SAQUYEN RITMOS eligió «Ambos» a los 2 min 20 s y no creó nada más.

Causa probable según el código (`SchoolOnboardingWizard.tsx`):
- El paso es obligatorio y no tiene «Saltar». El botón «Siguiente» queda deshabilitado y no hay salida al panel: la única opción es crear o cerrar la app.
- Con «Ambos», son dos creaciones obligatorias seguidas (equipo **y** plan) antes de ver cualquier cosa del producto.
- Pide nombre, deporte y precio mensual a alguien que todavía no ha visto una sola pantalla útil, desde un celular y un sábado a las 8 de la noche.
- Vuelve a pedir el deporte, que ya se había pedido en el registro (hallazgo A).
- No es falta de datos en el catálogo: «Baile» y «Danza» sí están en la lista de deportes.

**2. Acudiente: solicitud por código que se queda esperando a la escuela.**
Caso: `264882c7` envió su solicitud a Monster's Volley Club el jueves 19 a las 10:02. Sigue pendiente tres días después.

Causa probable:
- El vínculo depende de que un admin de la escuela entre a Atletas → Por asignar. El único aviso que recibe es una notificación dentro de la app, y las dos que se generaron siguen sin leer.
- No es un caso aislado de esa escuela: Monster's tiene 4 solicitudes pendientes, la más vieja del 5-nov. Son las únicas 4 pendientes de toda la plataforma y todas pasan de 48 horas.
- Mientras tanto la acudiente no tiene hijo, ni escuela, ni cobros: su panel está vacío y nada le dice cuánto falta.
- Antes de lograrlo tuvo 2 intentos de código fallidos en un minuto («Ese código no existe…»). La otra acudiente de Monster's tuvo 1. No bloquearon, pero el código se está digitando mal con frecuencia.

**3. Después del asistente: nada lleva al primer cobro.**
Caso: «pruebas demo» terminó los 6 pasos en 2 min 23 s y quedó con 0 inscripciones y 0 cobros. Caso relacionado: Club runner SKATE dejó el asistente en el paso de pagos.

Causa probable:
- El paso «Primer atleta» inserta el deportista sin plan ni inscripción (solo le asigna el primer equipo, si hay). Sin inscripción no nace ningún cobro.
- Al terminar, `onboarding_status` pasa a `completed` y el checklist del panel deja de mostrarse. El dueño aterriza en un panel sin siguiente paso sugerido.
- «Terminar después» también marca `completed`, así que saltarse los pasos opcionales tiene el mismo efecto: desaparece toda guía.
- En el club, el paso 3 presenta la configuración completa de recaudo en línea como cierre obligado de un asistente de 1 minuto.

**También vale la pena mirar: la tarjeta «Club / Canchas».** Club runner SKATE la eligió, y su primera instalación fue de tipo «Otro». Es posible que sea un club deportivo (con deportistas y mensualidades) que leyó «Club» y terminó en el producto de alquiler de canchas, que no tiene equipos, atletas ni planes. No se puede confirmar con los datos, pero la etiqueta se presta para eso.

#### Hallazgos de código que explican parte de lo anterior

| | Hallazgo | Dónde | Efecto |
|---|---|---|---|
| A | El deporte elegido en el registro se descarta. `RegisterPage` lo arma en el metadata, pero `signUp` solo envía 6 campos y no lo incluye. | `AuthContext.tsx` (`signUp`) | Campo obligatorio que no se guarda. La promesa «autogenerará categorías sugeridas» no se cumple y el asistente vuelve a preguntar el deporte. Confirmado en la base: ninguna de las cuentas tiene `sport_id` en su metadata. |
| B | El paso «Tu sede» nunca se muestra. Se da por hecho si existe alguna sede, y el trigger siempre crea la «Sede Principal». | `get_onboarding_status` (`has_branches`) + `getInitialStep` | Las 3 cuentas de negocio tienen la sede sin dirección ni ciudad, incluida la que terminó. |
| C | «Cobros» solo cuenta como hecho si hay banco y número de cuenta, pero el asistente acepta solo Nequi o solo Bre-B. | `get_onboarding_status` (`payment_setup_completed`) | Una academia que cobra por Nequi nunca verá ese paso marcado. |
| D | «Entrenador» se marca con `school_members`, pero el asistente escribe en `school_staff`. | `get_onboarding_status` (`has_staff`) | El paso no se marca hasta que el entrenador se registre y acepte. |
| E | El checklist del panel está condicionado a `onboarding_status !== 'completed'`. | `DashboardPage.tsx` | El dueño de academia nunca lo ve. |
| F | El atleta del asistente se crea sin plan ni inscripción. | `handleCreateStudent` | No hay primer cobro posible desde el asistente. |
| G | Nada escribe en `analytics_events`. | — | Sin embudo medible. |

### 1.6 Errores y logs de esos usuarios

Lo que sí se pudo revisar:

- **`system_errors`:** 0 registros en el rango.
- **Correos:** los 3 de bienvenida a las academias y los 3 avisos internos de alta salieron bien (`sent`). El de cobro a la acudiente de Dreamers también.
- **Códigos de escuela:** 3 intentos fallidos (2 de `264882c7`, 1 de `d1e2ac42`), todos por código no encontrado. Ninguno bloqueó: las dos lo lograron en el siguiente intento, sin llegar al límite de intentos.
- **Bloqueo real encontrado:** la solicitud de unión pendiente de `264882c7`. No es un error técnico; es un paso que depende de otra persona y nadie lo atendió.

Lo que **no** se pudo revisar:

- **Sentry** (errores del frontend), **logs de Render** (BFF) y **logs de la API de Supabase** (respuestas 4xx/5xx). No hay acceso desde esta sesión.
- Por eso no puedo descartar que SAQUYEN RITMOS o Club runner SKATE hayan visto un error en pantalla antes de irse. Los datos no muestran escrituras a medias ni estados inconsistentes, que es lo que dejaría un fallo al guardar, pero un error de validación o de red no deja rastro en la base.
- Para cerrarlo: filtrar Sentry y los logs de la API de Supabase por los IDs `84d17ad7…` (sáb 21, 20:09–20:20) y `06ac909e…` (jue 19, 19:08–19:20). Los logs de Supabase se conservan pocos días, así que conviene mirarlo esta semana.

---

## Parte 2 — Propuesta de tutorial guiado

### 2.1 Principios

1. **El asistente inicial queda corto; el tutorial hace el resto.** Lo obligatorio antes de entrar al panel se reduce a lo mínimo (modelo y un plan o equipo con valores sugeridos). Todo lo demás pasa a un checklist dentro del panel.
2. **El orden lo manda el primer cobro.** Para una academia, el valor aparece cuando ve un cobro generado a nombre de un deportista real. Todo lo que no sea necesario para eso va después.
3. **Nada bloquea.** Cada paso se puede saltar. Saltar no lo marca como hecho: queda en el checklist.
4. **Los pasos se marcan por lo que existe en la base, no por clics.** Si la escuela cargó deportistas por otro camino (QR, foto de matrícula, importación), el paso aparece hecho.
5. **Los recordatorios van por WhatsApp o correo.** Las notificaciones internas no se leen: 6 de 6 quedaron sin leer en estas cuentas.

### 2.2 Admin de academia

**Checklist visible en el panel:** tarjeta fija arriba del inicio, «Pon a andar tu academia · 2 de 6 completados», con barra de progreso y un solo botón principal: el siguiente paso pendiente. Se colapsa a una píldora en el encabezado («2/6») y se puede reabrir. Desaparece al completar los 6 o cuando el dueño elige «No mostrar más» (queda accesible en Configuración).

| # | Paso | Objetivo | Dónde | Qué ve | Se completa cuando | Si lo salta |
|---|---|---|---|---|---|---|
| 1 | **Crea tu primer plan o grupo** | Tener algo que cobrar | `/offerings` (planes) o `/teams` (equipos), según el modelo | Estado vacío con un botón «Crear mi primer plan» y valores sugeridos ya llenos (nombre «Mensualidad», precio editable). Un solo campo obligatorio: el precio. | Existe un `offering_plan` activo o un `team` | No se puede inscribir con cobro. El paso 2 lo vuelve a ofrecer en línea («Aún no tienes plan: créalo aquí»). |
| 2 | **Registra a tu primer deportista** | Ver un deportista real con su plan | `/students` | Estado vacío con tres caminos: «Agregar uno», «Compartir mi QR o código» y «Subir mi lista». Tooltip sobre el campo de plan: «Con el plan asignado, el cobro se crea solo». | Existe un `children` de la escuela con inscripción activa | El panel sigue vacío. Recordatorio a las 24 h. |
| 3 | **Mira tu primer cobro** | El momento de valor: el cobro ya existe | `/payments-automation` | Al guardar el paso 2, aviso con enlace: «Ya se generó el cobro de noviembre de (deportista). Míralo.» En la pantalla, tooltip sobre la fila: «Así lo ve la familia. Puedes registrar el pago aquí.» | Existe un `payments` de la escuela | Sin efecto operativo; queda pendiente en el checklist. |
| 4 | **Dile a las familias cómo pagarte** | Que el cobro se pueda pagar | Configuración de cobros (`/settings`) | Formulario corto: Nequi, Bre-B o cuenta. Basta uno. Vista previa de cómo lo ve el acudiente. | `school_settings` tiene al menos un medio (Nequi, Bre-B o banco) | Las familias ven el cobro pero no a dónde pagar. Aviso fijo en Pagos hasta completarlo. |
| 5 | **Invita a las familias** | Que el acudiente vea al deportista y el cobro | `/students` y `/qr-signup` | Botón «Enviar invitación» por deportista y bloque «Tu código de escuela» para compartir por WhatsApp. | Existe una invitación enviada o un acudiente vinculado (`school_members` con rol `parent`) | La escuela sigue funcionando sola; las familias no entran. |
| 6 | **Invita a tu entrenador** | Que alguien tome asistencia | `/staff` | Estado vacío con «Invitar entrenador» (nombre y correo o WhatsApp). | Existe una fila en `school_staff` o un miembro con rol `coach` | Nada se rompe; el dueño toma la asistencia. |

Pasos opcionales, fuera del conteo, mostrados como «Siguiente nivel» al terminar los 6: completar la dirección de la sede, conectar WhatsApp (`/whatsapp`), subir el logo, tomar la primera asistencia.

Por qué este orden: plan → deportista → cobro son tres pasos encadenados que se pueden hacer en menos de 3 minutos y terminan con algo que la academia reconoce como suyo. El entrenador y WhatsApp, que hoy van antes o ni aparecen, no son necesarios para ese primer resultado.

**Recordatorios si se queda trabado:**

| Situación | Cuándo | Canal | Mensaje (idea) |
|---|---|---|---|
| Creó la cuenta y no pasó del asistente | 1 hora | WhatsApp | «Tu academia (nombre) ya está creada. Te faltan 2 minutos para ver tu primer cobro: (enlace directo al paso pendiente)». |
| Mismo caso, sin respuesta | 24 horas | Correo | Lo mismo, con 3 capturas de lo que va a ver. |
| Mismo caso, sin respuesta | 72 horas | WhatsApp, de una persona del equipo | «¿Te ayudamos a montarla? Nos mandas tu lista y la cargamos.» Último intento automático. |
| Terminó el paso 1 y no el 2 | 24 horas | WhatsApp | «Ya tienes tu plan. Agrega a tu primer deportista y el cobro se crea solo.» |
| Tiene cobros y no medio de pago | Al entrar | En la app, aviso fijo en Pagos | «Las familias aún no saben a dónde pagarte.» |
| Tiene solicitudes de unión sin atender | 4 horas, y luego cada día | WhatsApp y correo al dueño y admins | «(N) familias esperan que las aceptes en (escuela).» |

Tope: máximo 3 mensajes automáticos por WhatsApp en la primera semana, y ninguno después de que la persona responda «no».

### 2.3 Club / Canchas

Checklist «3 de 4»:

1. **Tu primera cancha** (`/venue/onboarding`, ya existe). Se completa con una fila en `facilities`.
2. **Comparte tu enlace de reservas.** Botón «Copiar enlace» en `/venue/dashboard`. Se completa al copiarlo o al recibir la primera reserva.
3. **Recibe tu primera reserva** (`/venue/reservas`). Se completa con la primera reserva. Si pasan 48 h sin ninguna: «Crea tú una reserva de prueba para ver cómo queda».
4. **Configura cómo te pagan** (`/venue/cobros`). Sale del asistente inicial y pasa aquí.

Además, una pregunta en el registro al elegir «Club / Canchas»: «¿Alquilas canchas o espacios por horas?». Si responde que no, sugerirle «Escuela».

### 2.4 Acudiente

Checklist corto, «1 de 3», en el inicio del acudiente:

| # | Paso | Dónde | Qué ve | Se completa cuando | Si lo salta |
|---|---|---|---|---|---|
| 1 | **Conéctate con tu escuela** | `/unirse` | Campo de código o lector de QR. Si ya envió solicitud: estado claro, «Tu solicitud está en revisión por (escuela), enviada hace 2 días», con botón para escribirle a la escuela por WhatsApp. | Tiene membresía activa | Panel vacío; el paso sigue arriba. |
| 2 | **Revisa a tu deportista** | `/children` | Ficha precargada con lo que puso la escuela; resalta lo que falta (ficha médica, documento). | El deportista tiene ficha médica | Aviso suave en la ficha. |
| 3 | **Mira tus pagos** | `/my-payments` | Tooltip sobre el primer cobro: «Aquí pagas o subes el comprobante». | Abrió la pantalla (requiere evento) o subió un comprobante | Recordatorio de cobro normal. |

Recordatorios:
- Solicitud pendiente más de 24 h: WhatsApp al acudiente («Tu escuela aún no responde; ya le avisamos») y, en paralelo, el recordatorio a la escuela de la tabla anterior.
- Vinculado y con cobro pendiente que no ha abierto Pagos en 48 h: entra al flujo de cobranza que ya existe; no se crea uno nuevo.

Quien llega por invitación (como `ef3642d7`) arranca con el paso 1 hecho.

### 2.5 Entrenador

No hubo registros de entrenadores en el rango, así que esta parte no tiene datos detrás. Propuesta mínima, «1 de 3»:

1. **Acepta la invitación de tu escuela.** Se completa con membresía activa.
2. **Conoce tu grupo** (`/students`). Se completa al abrirlo.
3. **Toma tu primera asistencia** (`/coach-attendance`). Se completa con el primer registro de asistencia. Recordatorio por WhatsApp una hora antes de su primera clase programada.

### 2.6 Eventos de tracking que faltan

Hoy no hay ninguno. Se puede usar la tabla que ya existe, `analytics_events` (`event_type`, `event_data`, `page_url`, `user_id`).

**Registro**
- `signup_viewed`, `signup_role_selected` (rol), `signup_submitted`, `signup_validation_error` (campo), `signup_failed` (motivo), `signup_completed` (rol, origen: directo, invitación, QR, código, Google).

**Asistente inicial** (para cada rol)
- `onboarding_step_viewed`, `onboarding_step_completed`, `onboarding_step_skipped`, `onboarding_step_error` (paso, mensaje), `onboarding_finished` (cómo: completo o «terminar después»), `onboarding_abandoned` (último paso visto; se calcula, no se dispara).

**Tutorial**
- `tutorial_shown`, `tutorial_step_cta_clicked`, `tutorial_step_completed` (paso, segundos desde el registro), `tutorial_step_skipped`, `tutorial_dismissed`, `tutorial_completed`.

**Hitos de valor** (se pueden derivar de la base, pero conviene tenerlos como evento con fecha)
- `first_plan_created`, `first_athlete_created`, `first_enrollment_created`, `first_charge_created`, `first_payment_recorded`, `payment_method_configured`, `first_family_invited`, `first_family_linked`, `first_coach_invited`, `first_attendance_taken`, `whatsapp_connected`.

**Acudiente**
- `join_code_entered` (éxito o fallo), `join_request_submitted`, `join_request_resolved` (horas de espera), `payments_screen_viewed`, `receipt_uploaded`.

**Recordatorios**
- `reminder_sent` (tipo, canal), `reminder_clicked`, `reminder_converted` (completó el paso en las 24 h siguientes).

Con esto el embudo de la sección 1.4 se arma con una sola consulta y deja de depender de inferencias. Para no cargar la base: un evento por acción (no por render), en lote, y nada de eventos de scroll o de foco.

### 2.7 Decisiones tomadas (22-nov-2026)

Estas decisiones mandan sobre lo que digan las secciones 2.1 a 2.6 cuando haya diferencia.

| # | Decisión | Detalle |
|---|---|---|
| 1 | **Asistente corto: sí.** | Lo único obligatorio para entrar al panel es el nombre de la academia y el deporte (ya se piden en el registro). El plan o grupo pasa al checklist, con «Saltar» y sin bloquear el panel. |
| 2 | **Solicitudes por código: aprobación automática solo con coincidencia sin ambigüedad** con un deportista ya cargado. | El resto sigue manual, pero el aviso al admin va por WhatsApp, con recordatorio a las 24 horas. |
| 3 | **Recordatorios por WhatsApp a dueños: sí, por fases.** | Casilla de consentimiento en el registro desde ya. Mientras se aprueban las plantillas de utilidad, se escribe a mano desde el número de SportMaps (2 o 3 academias por semana). |
| 4 | **Defectos A a F: en la misma entrega, y primero.** | El deporte que no se guarda y «Tu sede» que nunca aparece son bugs, no diseño. |
| 5 | **«Club / Canchas»: se aclara** con una línea de descripción debajo de cada tarjeta de rol. | Preguntarle al club, en la llamada, qué entendió. |

Dos agregados a la propuesta:

- **Tracking antes que tutorial.** Conectar `analytics_events` con 8 a 10 eventos básicos antes de construir el checklist: `signup_completed`, `onboarding_step_viewed`, `onboarding_step_completed`, `onboarding_step_skipped`, `onboarding_finished`, `first_plan_created`, `first_athlete_created`, `first_charge_created`, `payment_method_configured`, `whatsapp_connected`. El resto de la lista de 2.6 queda para después.
- **El checklist no se oculta en `completed`.** Sigue visible hasta que la academia tenga su primer cobro.

**Orden de trabajo**

1. Bugs A a F + tracking básico.
2. Asistente corto + checklist persistente hasta el primer cobro.
3. Aviso de solicitudes de unión por WhatsApp (y aprobación automática por coincidencia).
4. Recordatorios automáticos.

**Pendientes operativos, fuera del código**

- Avisar a Monster's Volley Club por WhatsApp de sus 4 solicitudes sin atender.
- Llamar a SAQUYEN RITMOS y a Club runner SKATE: dónde se trabaron, si vieron algún error y, al club, qué entendió por «Club / Canchas».
- Bajar los logs de la API de Supabase y revisar Sentry y Render en las ventanas de la sección 1.6, antes de que venzan.

### 2.8 Preguntas originales (ya resueltas en 2.7)

1. **¿Se acorta el asistente obligatorio de academia?** Recomiendo dejar solo modelo y un plan o grupo con valores sugeridos, y mover entrenador, atleta y cobros al checklist. Es lo que ataca el abandono número 1.
2. **¿Las solicitudes por código siguen necesitando aprobación manual?** Alternativa: aprobarlas solas cuando el documento o el nombre coincide con un deportista que la escuela ya cargó, y dejar la aprobación manual para el resto.
3. **¿Recordatorios por WhatsApp a dueños de academia desde el número de SportMaps?** Requiere plantillas aprobadas y el consentimiento en el registro.
4. **¿Se corrigen primero los hallazgos A a F?** Varios (A, B, C, D) hacen que el checklist marque mal aunque el tutorial esté bien hecho. Recomiendo corregirlos en la misma entrega.
5. **¿Se renombra o se aclara «Club / Canchas» en el registro?**
