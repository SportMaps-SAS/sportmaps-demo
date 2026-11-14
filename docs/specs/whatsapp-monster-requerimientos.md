# Bot de WhatsApp de Monster´s Volley Club: automático de punta a punta

Estado: **construido y en producción (2026-10-31); falta conectar el número de Monster y prender el bot.**
M1–M5 aplicadas. Escuela `eb3ebc77-4ea4-4992-96c8-3c8ec574578c`, slug `monsters-volley-club`.

**2026-10-31 — franjas prendidas y batería de escenarios.** La simulación de un interesado de Norte y otro de Suba
terminaba en «no tengo horarios»: `courtesy_from_training` seguía en `false` (§9, «no antes de B3»). Se prendió y se
generaron 66 franjas (sáb. y dom., 3 semanas, 11 grupos que reciben clase de prueba); el cron de las 05:30 mantiene la
ventana. Arreglos que salieron de la simulación: el lugar «1.er domingo del mes: Pinar; 2.º a 4.º: La Enseñanza» se
resuelve por fecha (`lugarDelDia` en `semana-equipo.service`); la bienvenida no repite las sedes que el texto de la
escuela ya trae con dirección; «Su profe es…» en vez de «con el profe…»; y en el número de pruebas separar el cupo se
simula (antes se cortaba antes del pago). Para repetir cientos de conversaciones sin mandar nada:
`npm run qa:embudo -- --escuela monsters-volley-club [--solo matriz|guiones] [--transcripcion archivo.md]`.
Origen: grupo «Soporte Monsters Volley», 2026-10-29 (lista de 10 puntos, textos, afiches de Norte y Suba, cuadro de
horarios por categoría de Suba).

**Maqueta de la conversación:** [whatsapp-monster-maqueta.html](whatsapp-monster-maqueta.html) (11 pasos + encendido).
Esta spec es el cómo; la maqueta es el qué ve cada persona.

## 0. Principio (pedido del usuario, 2026-10-29)

> «La idea es siempre quitar pasos, no agregar uno. Todo debe ser automatizado y basarnos en los horarios de
> entrenadores, categorías y las clases.»

- Hoy Monster hace tres pasos a mano: Google Form, pago con comprobante **por correo** y alguien que lee el correo y
  asigna un entrenador por nivel. Todo eso pasa al chat y aterriza solo en SportMaps.
- Todo lo que se construye es **por escuela**. Dynasty y las demás siguen exactamente igual
  ([[feedback_no_cambiar_flujos_acordados_sin_preguntar]]).
- Tiene que quedar listo para «conectar, aprobar plantillas en Meta y encender», probado antes en el número de pruebas.
- Tono muy amistoso (texto de Monster como base).

## 1. Los 10 pedidos de Monster

Leyenda: ✅ existe · ⚙️ existe, falta cargar datos o textos · 🟡 parcial · ❌ no existe

| # | Pedido | Estado | Dónde queda en el diseño |
|---|---|---|---|
| 1 | Mensaje de bienvenida | 🟡 | B2: texto de Monster + botones 🟡 Norte / ⚫ Suba / Ya soy del club. Hoy la bienvenida es fija (`whatsapp-puerta-desconocido.ts`) |
| 2 | Guiones para seguir la conversación | 🟡 | B2 (preguntas configurables) + ficha para Haiku (`wa_ficha_prospectos`) con precios, regalo de noviembre y clínica |
| 3 | Hasta dónde el bot y cuándo un asesor | 🟡 | B6: lista de temas por escuela, «sigue en fila», modo discreto por escuela |
| 4 | El profesor pone su horario semana a semana | ❌ | B3: excepciones por semana sobre `teams.schedule` + pantalla «Mi semana» del profe |
| 5 | Seguimiento «ilimitado» | ❌ | B5: secuencia con plantillas de marketing. «Ilimitado» no existe (tope de Meta por calidad) |
| 6 | WhatsApp bloquea la cuenta a los ~80 mensajes | ✅ al conectar | Se resuelve con la API oficial (coexistencia) + B5 (freno por calidad) |
| 7 | La clase de prueba queda agendada en la app | 🟡 | B3: agenda automática con valor ($15.000), entrenador y aviso al profe |
| 8 | Mensaje de seguimiento | ❌ | B5: plantilla de marketing con el texto de Monster |
| 9 | Mensaje de lead | 🟡 | B2: preguntas de Monster; el lead queda completo en Deportistas → Clase de prueba |
| 10 | Atención a afiliados | ✅ / 🟡 | Existe; falta decidir modo discreto (B6) y el horario de la semana (B3) |

Además pidió (respuesta del usuario, 2026-10-29): **varios comprobantes en la misma conversación, cada uno
categorizado por deportista y motivo, para todas las escuelas**; por chat o subiéndolo en SportMaps eligiendo el motivo,
o con el motivo ya marcado por el flujo («si dicen cortesía, se sube como cortesía»). → B4.

## 2. Estado medido (base viva, 2026-10-29)

| Dato | Valor |
|---|---|
| Número conectado / conversaciones | 0 / 0 (`school_whatsapp_integrations` vacío) |
| Ajustes `wa_*` | Todos vacíos o por defecto; sin `school_trial_class_settings`; `courtesy_from_training=false` |
| Cuentas de pago | **Ninguna** (`nequi_number`, `daviplata_number`, `payment_accounts` vacíos). Sin esto el bot no puede validar el destino del comprobante |
| Sedes | Norte (Cl. 201 #67-12) y Suba (Cl. 152 #94A-67) en `school_branches` |
| Norte | 9 equipos, categorías por año (`age_rule=birth_year`), $165.000, todos con Iván Felipe Sossa, **0 con horario** |
| Suba | 13 equipos ($145.000; Mayores Mixto $135.000), coach en `team_coaches`, **categorías sin edades** (`age_at_date` sin `age_min/max` ni años), **1 de 13 con horario** |
| Nivel | Solo en el nombre (Proyección / Profundización / Competencia); `teams.level` y `school_categories.level` vacíos |
| Leads, franjas, reservas | 0 |

Lo que mandó Monster y hay que cargar:

- **Afiche Norte:** matrícula $310.000 (kit de competencia, sudadera, póliza), camisetas de entrenamiento $60.000 (2),
  mensualidad $165.000, sábados y domingos 8:00–10:00 a. m. (horario inicial para todas las categorías).
- **Afiche Suba:** matrícula $310.000, camisetas $60.000, mensualidad $145.000 menores y $135.000 Mayores Mixto
  (sin coliseo), incluye sesión de psicología deportiva. Dice «sábados y domingos 8–10» pero el cuadro por categoría
  da otros horarios (decisión D5).
- **Cuadro de horarios de Suba (13 categorías):**

| # | Categoría (cuadro) | Equipo en SportMaps | Horario |
|---|---|---|---|
| 1 | U7-U13 Mixto Proyección | U9 Y U11 MIXTO | Vie 4–6 p. m. Pinar · Sáb 7–9 a. m. Pinar 2 · Dom 7:30–9:30 a. m. Fesan |
| 2 | U13 Mixto | U13 MIXTO | Lun 4–6 p. m. Pinar 2 · Sáb 7–9 a. m. Pinar 2 · Dom 7:30–9:30 a. m. Fesan |
| 3 | U15 Fem Proyección | U15 FEMENINO PROYECCION | Lun 4–6 p. m. Pinar 2 · Sáb 9–11 a. m. Pinar 2 · Dom 9:30–11:30 a. m. Fesan |
| 4 | U15 Fem Competitivo | U15 FEMENINO COMPETENCIA | Mié 4–6 p. m. Fesan · Sáb 9–11 a. m. Pinar 2 · Dom 9:30–11:30 a. m. Pinar |
| 5 | U15 Masculino | U15 MASCULINO | Vie 4–6 p. m. Pinar 2 · Sáb 11 a. m.–1 p. m. Pinar 2 · Dom 11:30 a. m.–1:30 p. m. Pinar |
| 6 | U17 Masc Proyección | U17 MASCULINO PROFUNDIZACIÓN | Mié 4–6 p. m. Pinar 2 · Sáb 1–3 p. m. Pinar 2 · Dom 11:30 a. m.–1:30 p. m. Fesan |
| 7 | U17 Fem Proyección | U17 FEMENINO PROFUNDIZACION | Vie 4–6 p. m. Fesan · Sáb 11 ¿a. m.?–1 p. m. Pinar 2 · Dom 3:30–5:30 p. m. Fesan |
| 8 | U17 Masc Competitivo | U17 MASCULINO COMPETENCIA | Vie 4–6 p. m. Pinar 2 · Sáb 11 a. m.–1 p. m. Pinar 2 · Dom 9:30–11:30 ¿a. m.? Pinar 2 |
| 9 | U19-U21 Masc Competitivo | U19 Y U21 MASCULINO | Mié 6–8 p. m. Pinar · Sáb 3–5 p. m. Fesan · Dom 12–2 p. m. Pinar |
| 10 | U19-U21 Fem Competitivo | U19 Y U21 FEMENINO | Mié 6:30–8:30 p. m. Pinar · Sáb 1(¿p. m.?)–3 p. m. Pinar 2 · Dom 1:30–3:30 p. m. Fesan |
| 11 | Mayores Fem Competencia | MAYORES FEMENINO | Mar 7–9 p. m. Lestonnac · Jue 7–9 p. m. Lestonnac · Dom 1:30–3:30 p. m. Fesan |
| 12 | Mayores Masc Competitivo | MAYORES MASCULINO | Mar 7–9 p. m. Lestonnac · Jue 7–9 p. m. Lestonnac · Sáb 3–5 p. m. Fesan |
| 13 | Mayores Mixto Proyección | MIXTO MAYORES PROFUNDIZACION | Lun 6–8 p. m. Pinar · Sáb 7–9 a. m. Pinar-Oxxo · Dom 7–9 a. m. 1.º Pinar; 2.º-4.º La Enseñanza |

Los «¿?» son errores aparentes del cuadro (D4). El equipo 4 ya tiene en la base «miércoles 4–6 p. m. Colegio Liseo
Fesan», que coincide.

## 3. Qué existe hoy (código) y qué no

Investigado el 2026-10-29. Rutas relativas a `bff/src` salvo que se diga otra cosa.

**Clase de prueba: dos sistemas que no se tocan.**
- El del bot (`services/whatsapp-clase-cortesia.service.ts`, `franjas-cortesia.service.ts`, `cortesia-reservas.service.ts`):
  franjas en `school_trial_slots` generadas a diario desde `teams.schedule` (`franjas-cortesia.service.ts:136-198`,
  job 05:30 en `maintenance.job.ts:986`, solo con `courtesy_from_training=true`, cupo ficticio 999, salta festivos);
  la reserva escribe `school_signup_leads` vía `submit_school_lead`. **Gratis, sin entrenador, sin pago**, el aviso va
  solo a dueño/admins (`cortesia-reservas.service.ts:362-441`). «Gratis» está escrito en
  `whatsapp-clase-cortesia.service.ts:723,725,984,1089`, `whatsapp-bot.service.ts` (descripción de
  `get_trial_class_info` y otros) y `whatsapp-cortesia-semana.service.ts:133`.
- El de la app (`trial_class_*`, `routes/trial-classes*.ts`, `/agendar-clase/:slug`): tiene precio por categoría,
  entrenador y cobro pendiente opcional (`20260829115629:330-343`), pero el checkout no está construido y **el bot no
  lo usa**.
- El grupo sale de `services/grupos-por-edad.service.ts` (edad por equipo → categoría → atletas → año en el nombre;
  sexo por nombre → `rama`). **No filtra por sede** (`branch_id` se ignora) **ni por nivel**.
- **No hay horario por semana**: solo `teams.schedule` fijo (el profe lo edita en `AgregarHorarioSheet.tsx`) y
  `coach_availability` (del módulo de la app). No hay cancelaciones ni cambios por fecha.

**Comprobantes** (`jobs/whatsapp-queue.job.ts`, `services/whatsapp-receipt-matching.service.ts`):
- El comprobante es **columnas de un cobro** (`payments.receipt_url`, `ocr_*`): uno por cobro, y solo si el cobro
  ya existe. Matrícula, uniformes, clase de prueba o clínica sin cobro creado → bandeja de la escuela.
- El deportista sale del cobro elegido; no es un paso propio.
- En una ráfaga cada comprobante se procesa solo y las respuestas se juntan (`resumirRafaga`), pero **solo la pregunta
  más nueva se resuelve** (`whatsapp-respuesta-de-cobro.service.ts:96-104`); las anteriores vencen a las 24 h.
- Un número desconocido no paga nada en el chat (no se crea cobro).
- Hay **7 listas de motivos** que no coinciden (CHECK de `payments.payment_category`, `tipo-de-cobro.ts`,
  `whatsapp-otro-concepto.service.ts`, `TipoServicio`, el modal, `/extract-receipt`, el flujo guiado). Ninguna tiene
  clase de prueba, uniforme ni clínica como tal.
- En la app, `PaymentCheckoutModal.tsx` sube **un** comprobante por pago con lista fija de motivos.

**Seguimiento y plantillas:**
- Un solo seguimiento a las ~20 h, **texto libre del modelo, solo dentro de las 24 h** y solo con ficha
  (`whatsapp-prospecto-seguimiento.service.ts`); la noche de la clase, «¿cómo le fue?» (`prospecto-ciclo-clase.service.ts`).
- Plantillas: catálogo de plataforma, **todas UTILITY** (`whatsapp-plantillas.service.ts:89-155`); enviar una MARKETING
  está bloqueado (`:522-545`). No hay plantilla de reenganche.
- Consentimiento (`whatsapp_optins`): el bot lo pide **solo a familias identificadas**. Un interesado nunca da el «sí»,
  así que ni el recordatorio del día anterior le puede llegar fuera de la ventana.
- Los eventos de calidad de Meta se guardan (`whatsapp_account_events`) pero **nada frena los envíos**.

**Paso a una persona:** existe (tomar/soltar, silencio de 12 h tras un mensaje de la escuela en modo discreto, avisos
push y resumen diario). La lista de temas es global. **Modo discreto** es una variable de entorno global, por defecto
desde el 2026-10-29: con él, «cuánto debo» escrito pasa a la escuela.

**Número de pruebas** (`services/plataforma-wa-pruebas.service.ts`): `/escuela monsters-volley-club` + `/como prospecto`
simula a la escuela sin integración y lee sus `wa_*` reales. Solo texto y botones: **sin imágenes, sin plantillas, sin
jobs programados**; testers en `PLATFORM_WA_TESTERS`.

**Conexión:** Embedded Signup con coexistencia (`ConectarNumero.tsx`); crea `whatsapp_settings` con
`ai_enabled=false, mode=auto`. Ojo: `ai_enabled=false` es **bot apagado**; el modo asistido es `mode='assisted'`
(la versión anterior de esta spec lo confundía).

## 4. Diseño: lo que se construye

Ocho bloques. Todo de corrido en `develop` ([[feedback_sin_ramas_por_fases_todo_de_corrido]]); a `main` solo cuando el
usuario lo pida (el webhook de WhatsApp llega al BFF de prod).

### B1 · Datos de Monster (sin código, SQL que corre el usuario)

1. Horarios en `teams.schedule` de los 13 equipos de Suba (cuadro §2) y de los 9 de Norte (sáb y dom 8–10).
2. Años de nacimiento en las 13 categorías de Suba (`age_rule=birth_year`, `birth_year_min/max`) — D2.
3. Nivel en `school_categories.level`: `proyeccion` / `competitivo` (texto + CHECK si la columna no lo tiene) — D1.
4. Canchas con dirección: Pinar, Pinar 2, Fesan, Lestonnac, La Enseñanza, Pinar-Oxxo. `facilities` no tiene dirección:
   se agrega `facilities.address` y `teams.schedule[].place` se resuelve contra `facilities.name` — D3.
5. Cuenta de pago: Nequi y Daviplata 319 450 5150 en `school_settings` (para validar el destino del comprobante).
6. Precios de la escuela que el bot usa para crear cobros: clase de prueba $15.000, matrícula $310.000, camisetas de
   entrenamiento $60.000, renovación $170.000, clínica $300.000 (catálogos existentes: `school_merchandise_items`,
   `school_tournament_items`, `offering_plans.registration_fee`; ver B4).
7. Textos: `wa_ficha_prospectos` (precios por sede, regalo de noviembre, renovación, clínica, qué incluye la matrícula,
   psicología deportiva en Suba), `wa_estilo_respuesta` (amistoso, de «tú», emojis moderados),
   `wa_cortesia_indicaciones` (qué llevar — D7), `wa_atencion_presencial`.
8. Celulares de acudientes: contar cuántos acudientes activos de Monster no tienen celular antes de encender.

### B2 · Embudo del interesado, por escuela

Nuevo en `school_settings` (texto/jsonb, sin `CREATE TYPE`):

| Columna | Qué guarda | Monster |
|---|---|---|
| `wa_bienvenida` | Texto de bienvenida al desconocido (hoy `whatsapp_settings.welcome_message` existe pero nadie lo lee y es por integración) | Su texto, con 🟡/⚫ |
| `wa_pregunta_sede` | boolean: con ≥2 sedes, primero la sede (botones con nombre de `school_branches`) | true |
| `wa_preguntas_prospecto` | jsonb ordenado: `{clave, texto, tipo: texto/fecha/botones/lista, opciones}` | nombre, fecha de nacimiento, sexo, posición, trayectoria (+ detalle si «Club y torneos») |
| `wa_regla_nivel` | jsonb: respuesta de trayectoria → nivel | D1 |

- `whatsapp-puerta-desconocido.ts`: si la escuela tiene `wa_bienvenida`/`wa_pregunta_sede`, la puerta es
  «sede + Ya soy del club» en vez de «Ya soy del club / Quiero información / Otro tema». Sin esos ajustes, igual que hoy.
- El mini-registro lee `wa_preguntas_prospecto` en vez de las 4 fijas; respuestas múltiples en un mensaje se toman
  todas (ya existe para nombre + edad).
- `school_signup_leads`: + `branch_id`, `respuestas jsonb`, `team_id` asignado, `payment_id`. Deportistas → Clase de
  prueba muestra las respuestas.
- **Consentimiento del interesado:** al confirmar la clase, botón «¿Te puedo escribir recordatorios y novedades?»
  → `whatsapp_optins` con fuente `bot_prospecto` (fuente nueva en el CHECK). Sin «sí» no hay plantillas después.
- Opción posterior (no en esta entrega): WhatsApp Flows (formulario nativo).

### B3 · Agenda automática de la clase de prueba

- `school_trial_class_settings`: + `nombre_clase` (`cortesia` | `prueba`), `separar_horas int` (24),
  `agendar_al_recibir boolean` (D9), `cupos_por_sesion int` (D12; hoy es 999). El valor es `trial_price`, que ya existe
  (`20261029215003_cobro_clase_prueba.sql`, de otra sesión); no se crea `precio_whatsapp`.
- Generador (`franjas-cortesia.service.ts`): franja por equipo **con** `branch_id`, nivel de la categoría, coach de
  `team_coaches`, dirección de la cancha; lee las excepciones de la semana; respeta festivos (ya lo hace).
- Selección (`grupos-por-edad.service.ts` / `filtrarPorPerfil`): sede elegida → año → sexo → nivel por `wa_regla_nivel`.
  Sin grupo: ofrece la otra sede o pasa a una persona con el lead guardado. Nunca inventa.
- Todos los textos «gratis / cortesía» pasan por `nombre_clase` y `precio_whatsapp`. Con precio > 0 jamás dice gratis.
- Flujo con valor: elige horario → **cupo separado** `separar_horas` → instrucciones de pago (cuentas de la escuela) →
  comprobante con motivo `clase_prueba` ya marcado (B4) → si monto y destino coinciden, **agendada** (lead con
  `trial_slot_id`, cobro pagado, aviso al profe). Si no coinciden, no agenda y pasa a una persona. Sin comprobante a
  tiempo, se libera el cupo y se ofrece otro horario una sola vez.
- «Cambiar horario» / «No puedo ir» conservan el pago (el cobro queda atado al lead, no a la franja).
- **Semana del profe (pedido 4):** tabla `team_schedule_exceptions` (`team_id`, `fecha`, `tipo` text CHECK
  `cancelada|movida|extra`, `hora_inicio`, `hora_fin`, `lugar`, `creado_por`), RLS: escribe staff del equipo
  (`user_staff_school_ids()` + `team_coaches`), lee miembros. Pantalla «Mi semana» en el app del entrenador: ver la
  semana, cancelar o mover un día, «repetir semana anterior». El generador y el bot de afiliados («horario de la
  semana») leen esto.
- **Aviso al entrenador:** al agendar, notificación (despachador unificado) al coach del equipo con los datos del
  interesado; después de la clase, «Asistió / No vino» y grupo-nivel recomendado.

### B4 · Comprobantes con motivo (todas las escuelas)

Sin tabla nueva de comprobantes en esta entrega: se mantiene `payments` como el cobro y el comprobante estampado en él.

1. **Un solo catálogo de motivos** (`motivos-de-cobro.ts` + espejo en el frontend), del que leen las 12 listas que hay
   hoy. `clase_prueba` ya está en el CHECK (`20261029215003`); **no se crea `evento`**: la clínica es `clase_extra` con
   su nombre en el concepto (matrícula = `inscripcion`, uniformes = `articulos`).
2. **Motivo esperado:** cuando el bot pide un pago, guarda `concepto_esperado` (+ deportista o lead) en el payload del
   saliente. El siguiente comprobante de ese contacto toma ese motivo sin preguntar.
3. **Crear el cobro desde el comprobante** cuando el motivo tiene precio en la escuela y no hay cobro pendiente
   (clase de prueba, matrícula, uniformes, clínica). Para interesados sin ficha, el cobro va atado al prospecto con
   `payments.signup_lead_id` (`20261029215003`); al inscribirse, el trigger lo pasa al deportista.
4. **Motivo por monto** si no hay motivo esperado: $310.000 = matrícula, $60.000 = uniformes; un pago que suma varios
   se reparte (`wa_cubrir_cobros_con_comprobante` ya existe). Si no calza: botones [Matrícula] [Uniformes] [Otro].
5. **Ráfaga:** un solo resumen («Recibí 2 comprobantes: 1… 2…») con [Sí, está bien] [Cambiar un motivo]; las
   preguntas pendientes van en fila (una a la vez), no solo la más nueva.
6. **Hermanos:** si el acudiente tiene más de un deportista y no se sabe de quién es, se pregunta.
7. **App:** `PaymentCheckoutModal` con el catálogo único (clase de prueba, uniformes, clínica) y motivo preseleccionado
   cuando se entra por un enlace de cobro. En Pagos, filtro por motivo (el filtro por tipo ya existe desde `129e0c68`).

### B5 · Seguimiento automático con plantillas

- Catálogo de plantillas con categoría MARKETING por escuela (texto de la escuela, variables `{{nombre}}`, botones
  rápidos); el envío permite MARKETING solo con consentimiento y sin «No recibir más».
- Secuencia del interesado: día 1 (texto si la ventana sigue abierta; si no, plantilla), día 3 y día 7 (plantillas de
  marketing). Se detiene si responde, agenda, se matricula o toca «No recibir más». Marcas en
  `school_signup_leads.source_detail` (como el `seguimiento_20h_at` de hoy).
- Propuesta: solo de día, nunca domingos ni festivos. Los horarios y la frecuencia finales se ajustan a lo que diga la
  verificación legal (D11, Ley 2300 de 2023).
- **Freno por calidad:** con `phone_number_quality_update` en amarillo/rojo o `FLAGGED`, se pausan los envíos de
  marketing de esa escuela y se avisa al admin. Tope diario por escuela según el nivel de Meta.
- Plantillas iniciales de Monster: recordatorio de clase de prueba (utilidad), cupo liberado (utilidad), seguimiento de
  interés (marketing, texto de Monster), regalo de cierre de año (marketing, hasta el 30-nov), clínica (marketing).

### B6 · Paso a una persona, por escuela

- `school_settings.wa_temas_a_persona` (jsonb) con la lista de la maqueta (becas/descuentos, quejas, comprobante que no
  coincide, sin grupo, retiros/cambio de sede, salud, pide persona, 2 sin entender). Sin ajuste, la lista global de hoy.
- `school_settings.wa_modo_discreto` (`global` | `si` | `no`): hoy es una variable de entorno global — D10.
- «Sigue en fila»: si nadie respondió en 2 h hábiles, el bot se lo confirma una vez a la persona.

### B7 · Número de pruebas ampliado

- Recibir imágenes/PDF (OCR real, sin escribir en `payments`: en la burbuja de pruebas se muestra qué haría).
- Simular plantillas y los jobs (recordatorio, seguimiento d1/d3/d7) con un comando (`/avanzar 3d`).
- Agregar a quien vaya a probar a `PLATFORM_WA_TESTERS`.

### B8 · Encendido

1. B1 cargado y verificado (consultas de §2 en verde).
2. Recorrido completo en el número de pruebas: Norte y Suba, con nivel, pago, ráfaga de comprobantes, seguimiento,
   clínica, afiliado, paso a persona.
3. Monster conecta el 319 450 5150 por coexistencia (sigue usando WhatsApp Business en el celular).
4. Enviar las plantillas a Meta; esperar APPROVED.
5. Encender con `mode='assisted'` la primera semana; luego `auto`.

## 5. Decisiones pendientes (Monster / usuario)

| # | Decisión | Propuesta |
|---|---|---|
| D1 | Regla de nivel en Suba | «Estoy empezando» y «Colegio o escuela» → Proyección; «Club y torneos» → Competitivo. El profe corrige en la clase |
| D2 | Años por categoría de Suba | Monster dice qué años van en cada una (p. ej. si U15 en 2026 son nacidos en 2011-2012 o en 2012-2013) |
| D3 | Direcciones de las canchas | Monster las pasa |
| D4 | Tres horas del cuadro que parecen errores | Sáb 11 a. m.–1 p. m. (U17 Fem), Dom 9:30–11:30 a. m. (U17 Masc Comp), Sáb 1–3 p. m. (U19-U21 Fem) |
| D5 | Afiche de Suba («sáb y dom 8–10») vs. cuadro | Manda el cuadro |
| D6 | ¿Regalo de noviembre, renovación de $170.000 y clínica aplican a las dos sedes? | Sí, salvo que digan otra cosa |
| D7 | Qué llevar a la clase de prueba | Texto de Monster |
| D8 | Quién atiende como asesor y en qué horario | Monster |
| D9 | ¿Se agenda al recibir el comprobante o al revisarlo? | Al recibir, si monto y destino coinciden; la escuela revisa después |
| D10 | Modo discreto para Monster | No: el bot responde «cuánto debo» y lo demás de afiliados |
| D11 | Frecuencia del seguimiento frente a la Ley 2300 de 2023 | Verificar con asesoría legal antes de encender la secuencia; ajustar días |
| D12 | Cupos de clase de prueba por sesión | Monster (hoy no hay tope: 999) |
| D13 | Si no se presenta: ¿se reagenda gratis o se pierde el pago? | Se reagenda una vez |
| D14 | ¿Los $15.000 de la prueba se descuentan de la matrícula? | Monster |

## 6. Fuera de esta entrega (del mismo hilo)

- **«Se paga durante el mes según las sesiones que queden para ese grupo».** ❌ Hoy `billing_cycle_type='prorated'`
  (`bff/src/utils/prorationUtils.ts`) prorratea por **días**, no por sesiones restantes. Dos decisiones pendientes:
  valor por sesión (mensualidad ÷ sesiones del mes o precio fijo) y si cuentan festivos y sesiones canceladas. Con B3
  las sesiones canceladas ya quedan registradas, lo que facilita esto después.
- **Resolución IDRD, RUT, cédula y logo:** documentos del alta en Meta y de marca; no cambian el bot.
- **Inscripción de acudientes:** enlace o QR de inscripción (existe); el bot lo manda al confirmar la matrícula.
- **WhatsApp Flows** (formulario nativo) para las preguntas del B2.

## 7. Riesgos y coordinación

- Otra sesión edita `whatsapp-bot.service.ts`, `whatsapp-clase-cortesia.service.ts` y los jobs del bot (2026-10-29):
  coordinar antes de tocarlos; commits con índice temporal.
- B2, B3 y B4 tocan el flujo de Dynasty: cada cambio va detrás de un ajuste por escuela, con pruebas que fijan que sin
  el ajuste el bot responde igual que hoy.
- B4 toca el CHECK de `payments.payment_category` y la ruta de comprobantes de todas las escuelas: migración nueva con
  plan aprobado antes de escribirla; `npm run seguridad:invariantes` después.
- Una sola sesión aplica migraciones; `types.ts` se regenera una vez al final.

## 8. Plan de construcción (2026-10-29)

Planes detallados (archivo por archivo, borrador de DDL, pruebas y reparto en tareas sin archivos en común):
[whatsapp-monster-plan-B2-B3.md](whatsapp-monster-plan-B2-B3.md) y [whatsapp-monster-plan-B4.md](whatsapp-monster-plan-B4.md).
B7 (número de pruebas) se construye aparte, sin migración.

**Dos migraciones, por aprobar:**
- *Embudo y agenda (B2/B3):* ajustes por escuela del embudo; columnas del cupo separado y de la sede/grupo/respuestas
  en `school_signup_leads`; `facilities.address`; fuente `bot_prospecto` en `whatsapp_optins`; tabla
  `team_schedule_exceptions` con RLS (lee el miembro, escribe el admin o el coach de ese equipo) y RPCs de cupo (solo
  BFF) y de la semana del profe.
- *Comprobantes con motivo (B4):* interruptor `school_settings.wa_cobro_desde_comprobante` (nace apagado), tabla
  `whatsapp_conceptos_esperados` y marca `wa_cobros_desde_comprobante` (solo `service_role`), y la RPC
  `wa_crear_cobro_desde_comprobante`, que toma el precio de la fuente y nunca del BFF.
- Base: `20261029215003_cobro_clase_prueba.sql` y su fix `20261029222300_open_month_ignora_clase_prueba` (otra
  sesión) ya están en develop y main y aplicados. La migración de B4 suma el filtro `payment_category='clase_prueba'`
  en `registrar_pago_clase_prueba` y `listar_cobros_clase_prueba`.

**Decisiones tomadas con el principio «quitar pasos»** (el usuario puede vetarlas):
1. D9: se agenda **al recibir** el comprobante si el monto, el destino exacto y el veredicto coinciden. El cobro queda
   «En revisión» (`awaiting_approval`) y la escuela revisa después. Si lo rechaza, no se desagenda solo: le llega el aviso.
2. Cambio del plan B2/B3: los botones de sede llevan su emoji (pedido de Monster: «botones con los colores»). En vez de
   `wa_pregunta_sede boolean`, un `wa_botones_sede jsonb` con `[{branch_id, titulo}]`; NULL = sin pregunta de sede.
3. El consentimiento se pide **al separar el cupo**, no después de pagar. A las ~22 h, todavía dentro de la ventana, sale
   «tu cupo vence en 2 h»; a las 24 h el cupo se libera sin mensaje y la escuela recibe el aviso.
4. Si la escuela cobra la clase de prueba (`trial_price > 0`), el bot nunca dice «gratis», en ninguna escuela.
5. Para todas las escuelas: las preguntas de una ráfaga de comprobantes van en fila (hoy una se pierde) y el detector
   reconoce «clínica» y «clase de prueba».
6. La matrícula pagada como prospecto no se vuelve a cobrar al inscribirse.
7. «Quiero matricularla» en el chat: el bot da las instrucciones y deja esperados matrícula + uniformes.
8. «Cambiar un motivo» en la v1 lo atiende la escuela; los interruptores se prenden por SQL, sin pantalla en esta entrega.

## 9. Respuestas de Monster (2026-10-30, comentarios en el PDF y grupo «Soporte Monsters Volley»)

| # | Respuesta | Qué cambia en el diseño |
|---|---|---|
| D1 | La clase de prueba va **siempre a un grupo de Proyección**, nunca a Competencia. Sub-15 en adelante → **Mayores Mixto (Proyección)**. «Club y torneos» apunta a Competencia, pero eso se decide **después** de la clase con el feedback del profe | Se quita `wa_regla_nivel`. Nuevo `teams.recibe_clase_prueba boolean DEFAULT true` (no se reusa `admite_nuevos`, que significa «recibe deportistas nuevos»). En Suba solo `U9 Y U11 MIXTO` (U7-U13 Proyección) y `MIXTO MAYORES PROFUNDIZACION`. La trayectoria queda en `respuestas` y la ve el profe junto a «Asistió / grupo recomendado» |
| D2 | «Así son los años»: U15 en 2026 = nacidos en 2011-2012 | B1: U7-U13 Proyección 2013-2020, U13 2013-2014, U15 2011-2012, U17 2009-2010, U19-U21 2005-2008, Mayores ≤2004 y Mayores Mixto Proyección ≤2012 (por D1) |
| D3 | Enlaces de Google Maps: Parque Pinar de Suba 2, Liceo Fesan, Parque Oxxo Pinar, Colegio Lestonnac (**entrada de deportistas**) y Colegio Bilingüe La Enseñanza (sede Norte). Preguntan cómo indicar la entrada | `facilities` + `maps_url` y `indicaciones` (por dónde se entra, qué pasa si llueve), además de `address`. **Falta el enlace de «Pinar»** (sin el 2) |
| D4 | «Así son los horarios» | Se cargan como se leen: sáb 11 a. m.–1 p. m., dom 9:30–11:30 a. m., sáb 1–3 p. m. |
| D5 | Quitar «sábados y domingos de 8 a 10» de Suba; manda el cuadro | Suba = cuadro de §2; Norte sigue sáb y dom 8–10 |
| D6 | El regalo y la clínica aplican a las dos sedes. Clínica: **$250.000 afiliados**; preventa $300.000; **desde el 10 de noviembre $350.000**; se separa cupo con el **50 % de la preventa** y se mantiene el precio. Contacto de la clínica: 318 868 2241 | `school_tournament_items` ya tiene `allow_installments` y `capacity`; se agregan `precio_afiliado` y `precios_por_fecha jsonb` (`[{desde, precio}]`) y `abono_minimo_pct`. B4 calcula el precio así, y el abono del 50 % queda como pago parcial |
| D7 | Ropa deportiva (camiseta negra, pantaloneta, medias y tenis), agua abundante; en la cancha nadie atiende temas administrativos, todo por WhatsApp | `wa_cortesia_indicaciones` (B1) |
| — | Las clases de prueba son **solo sábados y domingos**; entre semana no hay agenda | `school_trial_class_settings.dias_semana smallint[]` (NULL = todos). Monster: {6,7} |
| — | Si llueve y la clase es en un parque, ¿cómo se avisa? O un aviso al agendar | `indicaciones` de la cancha al confirmar («si llueve, la clase se reprograma y te avisamos por aquí»). Si el profe cancela el día en «Mi semana», el bot avisa a los agendados con plantilla de utilidad «Clase reprogramada» y botón para elegir otro horario, sin cobrar de nuevo |
| — | El comprobante de la clase de prueba ¿queda en la app? (seguimiento financiero) | Sí: B4 (cobro `clase_prueba` atado al prospecto) |
| — | ¿El bot puede retomar las conversaciones de las dos sedes y escribirles del regalo a los contactos con etiqueta «clase de prueba» e «inscripción sede Norte»? | Las **etiquetas de WhatsApp Business no llegan por la API**. El historial de hasta 6 meses solo llega si SportMaps lo **pide** (`POST /<phone_number_id>/smb_app_data`, `sync_type: history`) dentro de las 24 h del alta, una sola vez. **Eso nunca se construyó:** Dynasty tiene 0 mensajes anteriores a su alta (verificado 2026-10-30). Arreglo T1 del [plan B5](whatsapp-monster-plan-B5.md), que tiene que estar en `main` **antes** de que Monster conecte. Con el historial, las conversaciones se clasifican solas (clase de prueba o inscripción, por sede) y van a la campaña de B5 |
| — | Urgencia: arrancar hoy con WhatsApp por la clínica | Ver §10 |
| — | Vacacional de voleibol, Sede Suba (mensaje para quien pregunte): Parque Pinar de Suba 2, 17-nov a 10-dic, martes a jueves 8–11 a. m. Afiliados $80k/$120k/$150k/$170k y externos $100k/$140k/$170k/$200k por 1, 2, 3 o 4 semanas. WhatsApp 318 868 2241 | En la ficha (B1). En B4 es un servicio `kind='vacacional'` con **opciones** (semanas) y precio de afiliado y de externo: el catálogo de servicios necesita precio por opción, no solo `precio_afiliado` |

**Hallazgos al preparar los datos (2026-10-30):**
- **Afiliados que el bot no reconoce:** 145 de los 148 deportistas activos de Monster son `unregistered_athletes` sin
  cuenta. El bot los trata como «debe registrarse», así que no les puede dar el precio de afiliado de la clínica o del
  vacacional ni atenderlos como familia del club. 135 tienen el celular del acudiente cargado: reconocer al afiliado
  por ese celular (solo para precio y saludo, sin mostrar datos privados) entra en B4/B6.
- `dias_semana` usa la misma numeración que `teams.schedule` (0 = domingo … 6 = sábado). Monster: `{0,6}`.
- El número del bot es probablemente el **318 868 2241**: los avisos de la clínica y del vacacional dicen «WhatsApp: 318
  868 2241», y el 319 450 5150 es el de Nequi/Daviplata. Hay que confirmarlo.
- Hoy el bot agrega «La clase es *gratis*» después de las indicaciones (`lineasQueLlevar`) y el prompt dice «clase de
  cortesía». No se prende `courtesy_from_training` ni se crean franjas para Monster antes de B3.

Sin responder todavía: D8 (quién atiende y en qué horario), D10 (modo discreto), D11 (Ley 2300), D12 (cupos por
clase), D13 (no se presenta), D14 (¿los $15.000 se descuentan de la matrícula?) y qué número se conecta (319 450 5150 o
318 868 2241).

## 10. Orden propuesto por la urgencia (2026-10-30)

La preventa de la clínica vence el 9 de noviembre, la clínica es el 21-22 y el regalo va hasta el 30. Por eso:
0. **Antes de conectar:** T1 del plan B5 (pedir el historial al alta y guardarlo con su fecha real) en `main`, y el
   campo `history` suscrito en el panel de la app de Meta. Sin esto, el historial de Monster se pierde.
1. **En cuanto T1 esté en `main`, sin más código:** Monster conecta el número por coexistencia, se cargan la ficha
   (clínica con sus precios, regalo, clase de prueba de $15.000), las cuentas Nequi/Daviplata y el estilo, y el bot
   arranca en **modo asistido** (`mode='assisted'`): responde a quien escribe y una persona aprueba antes de enviar. Los
   comprobantes llegan a la bandeja de la escuela, como hoy con un número desconocido.
2. **Primero en construcción, B5 mínimo:** campaña con plantilla de marketing por escuela a los contactos clasificados
   del historial (clínica, regalo), con «No recibir más», tope diario y freno por calidad.
3. B4 (comprobantes con motivo, con los precios de la clínica) y después B2/B3 (embudo y agenda).

**Arreglado por la otra sesión (20261029222300):** `open_month` y `preview_open_month` no excluían `clase_prueba` ni
`reserva` del «ya tiene cobro este mes»; al convertir un prospecto con la clase pagada, ese mes quedaba sin mensualidad.
