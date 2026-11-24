# Etapa 4 — Recordatorios automáticos por WhatsApp (solo diseño)

**Estado:** diseño para aprobar. No hay código, ni plantillas enviadas a Meta, ni migraciones.
**Fecha:** 23-nov-2026 · **Depende de:** consentimiento del registro (etapa 2, `profiles.whatsapp_consent_at`), checklist y tracking (etapas 1–2), canal de plataforma existente (`plataforma-wa.service`).

## 0. Dos cosas que hay que corregir antes

1. **La etapa 3 reutiliza una plantilla que no dice lo correcto.** El aviso de solicitudes de unión sale con `sm_caso_por_atender`, cuyo cuerpo aprobado es «hay un caso de WhatsApp que necesita a una persona: {{2}}. Respóndele a la familia desde SportMaps». Con la variable «3 familias esperan que las aceptes» queda confuso, y Meta puede objetar una plantilla usada para algo distinto de lo que declara. Se resuelve con la plantilla 3 de abajo (propia). Hasta que esté aprobada, conviene dejar el job de la etapa 3 apagado en producción (`DISABLE_SOLICITUDES_UNION_AVISOS=true`) o activarlo solo para las escuelas de prueba.
2. **La categoría UTILITY no está garantizada.** Meta clasifica por contenido, no por lo que pedimos. Un recordatorio de «termina de configurar» puede reclasificarse como MARKETING (cuesta más y exige opt-in explícito, que sí tenemos solo para quien marcó la casilla). El diseño asume que **toda plantilla de onboarding solo se envía a quien tiene `whatsapp_consent_at`**, así que una reclasificación no rompe el cumplimiento; solo cambia el costo.

## 1. Plantillas a pedir a Meta

Idioma `es_CO`. Una sola variable de ruta en el botón (`https://app.sportmaps.co/{{1}}`), como las del canal actual. Variables sin saltos de línea. Sin nombres de personas ni cifras de dinero.

| # | Nombre | Categoría pedida | Cuerpo | Variables | Botón |
|---|---|---|---|---|---|
| 1 | `sm_onboarding_siguiente_paso` | UTILITY | Hola, tu academia {{1}} ya está creada en SportMaps. Para ver tu primer cobro te falta un paso: {{2}}. Toma unos minutos. | {{1}} academia · {{2}} paso pendiente (texto fijo por paso, ver §2) | «Continuar» → `/{{1}}` (ruta del paso) |
| 2 | `sm_onboarding_retomar` | UTILITY | Hola, ya tienes {{1}} en SportMaps. El siguiente paso es {{2}}, y así el cobro se crea solo. | {{1}} lo que ya hizo («tu plan») · {{2}} lo que sigue («agregar a tu primer deportista») | «Continuar» |
| 3 | `sm_solicitudes_union_pendientes` | UTILITY | Hola, en {{1}} hay {{2}} esperando que las aceptes para unirse. Se resuelve en un minuto desde SportMaps. | {{1}} academia · {{2}} «1 familia» / «3 familias» | «Ver solicitudes» → `/students?bandeja=por-asignar` |
| 4 | `sm_onboarding_acudiente_solicitud` | UTILITY | Hola, tu solicitud para unirte a {{1}} sigue en revisión. Ya le avisamos a la escuela; si prefieres, puedes escribirle tú. | {{1}} escuela | «Ver mi solicitud» → `/dashboard` |

Notas:
- Los textos de la variable {{2}} de las plantillas 1 y 2 son una **lista cerrada** en el código (uno por paso del checklist), no texto libre, para que lo aprobado y lo enviado coincidan.
- La plantilla 4 es el aviso al acudiente de la sección 2.4 de la propuesta («Tu escuela aún no responde; ya le avisamos»). Se envía solo si el acudiente tiene celular verificado y consintió; si no, no hay mensaje (la pantalla ya muestra el estado).
- La llamada de «¿Te ayudamos a montarla?» a las 72 h **no es plantilla**: la escribe una persona del equipo desde el número comercial (decisión 3). El sistema solo genera la lista de quién la necesita.
- Plantilla 3 reemplaza el uso de `sm_caso_por_atender` en la etapa 3: es un cambio de una constante en `solicitudes-union-avisos.job.ts`.

## 2. Disparadores

Todos se calculan con datos que ya existen: `get_onboarding_status`, `get_onboarding_checklist_extras` y `analytics_events` (hitos `first_*`, `signup_completed`). Un job cada 15 min, lecturas en lote, nada por fila.

| Situación | Condición | Cuándo | Plantilla | Texto de {{2}} |
|---|---|---|---|---|
| Creó la cuenta y no pasó del asistente | `onboarding_status <> completed`, sin `first_plan_created` | 1 h después de `signup_completed` | 1 | «elegir tu deporte» (si falta) o «crear tu primer plan» |
| Terminó el plan y no agregó deportista | `first_plan_created` sin `first_athlete_created` | 24 h después del plan | 2 | «agregar a tu primer deportista» |
| Tiene deportista y no hay cobro | `first_athlete_created` sin `first_charge_created` | 24 h después | 2 | «asignarle un plan para que se cree el cobro» |
| Sigue sin avanzar | Cualquiera de las anteriores, sin cambio | 72 h: **no es mensaje automático**; entra a la lista de «llamar» del equipo | — | — |
| Solicitudes de unión sin atender | `school_join_requests` pendiente | 4 h y luego una vez al día mientras haya pendientes (hoy la etapa 3 hace aviso + recordatorio a las 24 h) | 3 | cantidad |
| Acudiente con solicitud pendiente > 24 h | pendiente, con celular y consentimiento | una sola vez | 4 | — |

Reglas comunes:
- **Un solo mensaje de onboarding por ejecución y por escuela**, el del paso más temprano pendiente.
- **Se cancela solo** si, al momento de enviar, el paso ya se completó (se vuelve a leer justo antes). Nunca se manda un recordatorio de algo ya hecho.
- Horario: entre 8:00 y 20:00 hora de Colombia. Fuera de ese rango se reserva para la siguiente ventana; no se descarta (se reutiliza `enSilencio`).
- Sin consentimiento (`whatsapp_consent_at` nulo) **no hay WhatsApp**: solo correo, y solo para el aviso de las 24 h. Esto incluye a quien se registró con Google, que hoy no tiene la casilla.
- Solo escuelas `account_type = 'real'` y no demo, como los demás resúmenes.

## 3. Tope de 3 mensajes en la primera semana

- **Qué cuenta:** las plantillas 1 y 2 (las de «configura tu cuenta»), por escuela, en los 7 días siguientes a `signup_completed`. Tope duro: 3.
- **Qué no cuenta:** la plantilla 3 (hay familias esperando, es operativa) y la 4 (va a otra persona). Quedan acotadas aparte: la 3 a un mensaje por escuela por día y un máximo de 5 en la primera semana; la 4 a una vez por solicitud. **Decisión para ti** si prefieres que todo entre en el mismo tope de 3.
- **Cómo se hace cumplir:** tabla `onboarding_recordatorios_log` (escuela, perfil, tipo, paso, enviado_at, resultado, wa_message_id) con `UNIQUE (escuela, tipo, paso)` para que cada recordatorio exista una sola vez. El conteo del tope se hace con una consulta sobre esa tabla **antes** de enviar; si ya hay 3, no sale. La reserva se inserta primero y solo quien logra el INSERT envía (mismo patrón que `platform_wa_envios`), así los tres BFF no duplican.
- El tope aplica aunque el mensaje falle: un envío fallido cuenta como intento, para no reintentar sin fin.

## 4. Cómo se respeta el «no»

1. **Antes de enviar, siempre:** se consulta la tabla `whatsapp_bajas` (perfil o celular normalizado, fecha, origen). Si hay baja, no sale nada y se registra el motivo `baja`. La consulta va justo antes del envío, no al armar el lote.
2. **Cómo se registra una baja** (cualquiera de las tres):
   - Responde al número de SportMaps con «stop», «baja», «no», «no gracias», «no más» o «desactivar». Hoy el canal ya entiende «stop», «baja» y «desactivar avisos» para los suscriptores; se amplía la lista y se aplica **también a quien no es suscriptor** (hoy se ignora). Respuesta única de confirmación («Listo, no te escribiremos más por aquí. Si cambias de opinión, escríbenos»); es texto libre dentro de la ventana de 24 h, sin plantilla.
   - Desactiva el interruptor en Configuración → Notificaciones. Mismo efecto.
   - Lo pide una persona del equipo (por llamada o chat): se registra con origen `manual`.
3. **Alcance:** la baja es **global para ese celular** y cubre las plantillas 1, 2 y 4. Para la 3 (operativa de la escuela) se respeta también: el dueño que dijo «no» deja de recibir incluso esos avisos por WhatsApp; la escuela sigue viendo las solicitudes en la app. Si prefieres que la operativa siga llegando, es una excepción explícita que habría que aprobar.
4. **Dura hasta que la persona vuelva a consentir** (marca la casilla de nuevo en Configuración o responde «activar»). Una respuesta de «no» posterior a la casilla del registro **gana** sobre `whatsapp_consent_at`.
5. **Medición honesta:** si Meta devuelve error de «destinatario no quiere mensajes» (código 131050), se registra como baja automática.
6. **Sin celular o con celular inválido:** no se intenta; queda en el log como `sin_destino`.

## 5. Medición

Se amplía la lista cerrada de `track_onboarding_event` (o una RPC nueva solo para el BFF) con tres eventos, uno por acción real: `reminder_sent` (plantilla, paso), `reminder_clicked` (cuando el enlace trae `?r=<id corto>`; el botón URL lleva ese parámetro), `reminder_converted` (el paso se completó en las 24 h siguientes al envío; se calcula con una consulta, no se dispara). Con esto se responde la pregunta real: **¿el recordatorio hizo avanzar a alguien?** Si en 4 semanas la conversión es baja, se apaga sin tocar nada más.

## 6. Despliegue por fases

| Fase | Qué | Condición para pasar a la siguiente |
|---|---|---|
| 0 (ya) | Mensajes escritos a mano desde el número de SportMaps, 2 o 3 academias por semana | — |
| 1 | Plantillas 1–4 enviadas a Meta; job en modo **simulación** (calcula a quién le tocaría y lo registra en el log sin enviar) | Plantillas aprobadas; revisión humana de 1 semana de simulación: ¿a quién le habría escrito y por qué? |
| 2 | Envío real solo a escuelas de una lista blanca (hoy el canal ya tiene `platform_wa_escuelas`) | 2 semanas sin quejas ni bajas inesperadas |
| 3 | Todas las escuelas con consentimiento | — |

Interruptores: `ONBOARDING_RECORDATORIOS_WA=off|simulacion|on`, y `DISABLE_ONBOARDING_RECORDATORIOS=true` como kill-switch, como los demás jobs. Solo producción.

## 7. Qué hay que construir (cuando se apruebe)

1. Migración: `onboarding_recordatorios_log`, `whatsapp_bajas`, índices parciales; RLS solo `service_role` (tablas internas).
2. Job del BFF `onboarding-recordatorios.job.ts` (lecturas en lote, una reserva por envío, relectura del paso antes de enviar).
3. Ampliación del webhook entrante para las bajas de quien no es suscriptor, y el interruptor en Configuración.
4. Las 4 plantillas en `bff/whatsapp-templates/plataforma/` y el sincronizador que ya existe.
5. Pruebas: tope de 3, cancelación por paso ya hecho, baja respetada justo antes de enviar, idempotencia entre BFF, horario.

## 8. Decisiones que necesito de ti

1. ¿La plantilla 3 (solicitudes) cuenta o no dentro del tope de 3 de la primera semana? Recomiendo que **no cuente** y tenga su propio límite.
2. ¿Una baja corta también los avisos operativos (plantilla 3) por WhatsApp? Recomiendo que **sí**: es lo más fácil de explicar y de cumplir.
3. ¿Se aprueba apagar el job de la etapa 3 en producción hasta tener la plantilla 3 aprobada?
4. ¿Quién del equipo escribe la llamada de las 72 h y dónde quieres ver esa lista (pantalla de admin o un archivo semanal)?
5. Registro con Google: hoy no tiene la casilla de consentimiento. ¿La agregamos en `ElegirRolPage` para que esos dueños también puedan recibir WhatsApp?

## 9. Límites de este diseño

- La categoría y el costo reales los decide Meta al revisar; no se pueden verificar de antemano.
- No se midió cuántas escuelas tienen celular válido y consentimiento: el consentimiento existe desde la etapa 2 y aún no está aplicado en producción, así que **hoy el universo alcanzable es cero** hasta aplicar las migraciones y pasar unas semanas de registros nuevos. Las escuelas ya registradas no tienen consentimiento.
