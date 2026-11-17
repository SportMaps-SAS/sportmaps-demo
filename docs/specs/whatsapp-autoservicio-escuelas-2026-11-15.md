# WhatsApp autoservicio: que la escuela cambie y programe sus mensajes

**Estado:** D1–D6 aprobadas el 2026-11-15 con los cambios de §2 (D7 resuelta, D8 nueva, F0 antes de F1). Sin código ni migraciones; el plan de la migración de F0 espera aprobación.

**Principio de producto (2026-11-15):** las escuelas autogestionan sus campañas por completo. Ellas crean la plantilla, eligen la audiencia, aprueban y programan, y aceptan una declaración de responsabilidad (contenido verídico, consentimiento de los destinatarios, horarios de la Ley 2300) que queda registrada con usuario y fecha. SportMaps no envía campañas en nombre de la escuela: solo pone las barreras (topes, reserva de cobranza, freno de calidad, horarios).
**Objetivo:** que una escuela cambie los textos, decida cuándo sale cada mensaje, programe envíos y ajuste su bot sin escribirle a SportMaps. Cierra con un manual.

## 1. Punto de partida (verificado en el código el 2026-11-15)

Las seis bases ya existen: ventana de 24 h (`whatsapp_conversations.last_inbound_at`), plantillas con espejo de Meta (`whatsapp_template_status`), consentimiento (`whatsapp_optins`), intereses (`whatsapp_audiencia.intereses`), freno por calidad y cupo en campañas, y registro de envíos (`whatsapp_messages`, `collection_notices`, `whatsapp_campana_envios`).

Lo que la escuela ya hace sola en `/whatsapp`: crear una plantilla y mandarla a aprobación, crear, aprobar, pausar y reanudar campañas, prender o apagar el bot, fijar el horario de atención, y prender o apagar los avisos de cobro en `/payments-automation`.

Lo que hoy depende de SportMaps:

| Hueco | Dónde está amarrado |
|---|---|
| Texto de los mensajes automáticos | Nombres de plantilla y orden de variables fijos en `CONCEPTOS` (`bff/src/services/whatsapp-plantillas.service.ts`); el resto, cadenas en los servicios del bot |
| Cuándo salen | Escalera −3, −1, 0, +3, +10, +20 en `recordatorios-cobro.service.ts`; horas en `maintenance.job.ts` |
| Programar a fecha y hora | No existe ningún `scheduled_at`; la campaña sale al aprobarla |
| Avisos a familias por grupo | Solo de a una conversación desde el chat; las campañas exigen promoción con 3 botones |
| Ficha y tono del bot | `wa_ficha_prospectos`, `wa_estilo_respuesta`, bienvenida, preguntas del embudo y temas a persona: solo por SQL |
| Prender campañas y topes | `whatsapp_campanas_ajustes` por SQL; la pantalla dice «Escríbele a SportMaps» |
| Clasificar intereses | Script `bff/scripts/wa-audiencia.ts`; no hay etiqueta manual |
| Baja de promociones | Una sola baja: quien toca «No recibir más» deja de recibir también la cobranza |
| Reportes | No hay vista por plantilla ni de `collection_notices`, ni costo en pesos |
| Activaciones | Bienvenida y consentimiento de seguimiento por variable de entorno |

Además, `/message-templates` confunde: edita textos que solo alimentan el enlace `wa.me` y el correo, no lo que sale por Meta. Y `whatsapp_settings.welcome_message` se guarda pero nada lo lee.

## 2. Decisiones de producto (aprobadas 2026-11-15)

- **D1. Editar un texto que va por plantilla pasa por Meta.** La escuela edita su versión, queda «en revisión» y la anterior sigue saliendo hasta que Meta apruebe. Si Meta la rechaza o la reclasifica como promoción, el aviso sigue con la plantilla de SportMaps y la escuela ve el motivo. Las variables (nombre, monto, fecha, enlace) son fijas por tipo de mensaje: la escuela cambia la redacción, no los datos.
- **D2. Los textos que salen con la ventana abierta se editan sin Meta** (desenlace del comprobante, «¿cómo le fue?», fuera de horario, bienvenida, «sigue en fila»), con las mismas variables fijas y botón «Volver al texto de SportMaps».
- **D3. Horarios dentro de la Ley 2300.** La escuela escoge días de la escalera de cobro y hora de envío, pero el sistema solo deja lunes a viernes 7:00–19:00 y sábados 8:00–15:00, nunca domingos ni festivos. Máximo seis escalones.
- **D4. Dos consentimientos.** Baja de promociones y baja total quedan separadas. El botón «No recibir más» de una campaña apaga solo promociones; «STOP» o «baja» escritos apagan todo. Las bajas actuales que vinieron de un botón de campaña se convierten a «solo promociones».
- **D5. Campañas se prenden solas, con los topes de SportMaps.** La escuela las activa aceptando la declaración; el lote piloto, el tope diario y la reserva del 20 % para cobranza no se pueden subir desde la pantalla.
- **D6. Sin pantalla nueva suelta.** Todo vive en `/whatsapp`; `/message-templates` se retira del menú y redirige a la pestaña nueva.
- **D7. Planes.** F1 y F3 van incluidas en el plan. La programación de campañas promocionales, las audiencias de F4 y los reportes de campaña van en el add-on Campañas, con el costo de Meta trasladado. Los avisos operativos a grupos van incluidos, con tope mensual.
- **D8. Un mensaje iniciado por el bot por persona al día,** sumando cobranza, campañas y avisos. La cobranza tiene prioridad; lo demás pasa al siguiente día hábil permitido. Quedan exentas las confirmaciones de pago y las respuestas dentro de conversaciones que inició la persona. Incluye el canal de la semana: una familia recibe la cobranza por un solo canal (WhatsApp o correo) en la misma semana; si ese canal no puede salir, espera, no cambia de canal. Hoy el candado es solo por día (ver §6).

## 3. Fases

### F0 — Antes de F1, en este orden
1. Separar la baja de promociones de la baja total (D4, con la conversión de las bajas existentes) y poner un aviso en `/message-templates`: «estos textos solo cambian el enlace manual y el correo, no los mensajes automáticos de WhatsApp».
2. Prender campañas para Monster's Volley con la declaración aceptada por ellos (hoy figura habilitada por el admin de plataforma y está en pausa desde el 2026-11-10).
3. Acompañar a Monster's para que ellos mismos creen y envíen la campaña de la clínica (5 % de descuento, últimos 5 cupos) a los interesados en la clínica. Domingo 15 y lunes 16 (festivo) no hay envíos: la primera ventana es el martes 17 desde las 7:00.

Cambios de F0 en la base: migración `20261115143758` (probada en el gemelo local; se aplica el lunes 16 en el mismo bloque que el despliegue del BFF, primero la migración). Contiene:
- `promos_out_at` en `whatsapp_optins`, `wa_registrar_baja_promos`, `wa_reactivar_promos`, `wa_puede_recibir_promos`.
- `whatsapp_campanas_declaraciones` (solo se agrega): una al activar y una por cada aprobación, con usuario, fecha, texto, y en la de campaña la plantilla, su texto y los destinatarios. Una campaña con declaración no se puede borrar.
- `wa_campanas_activar`: la escuela prende sus campañas. La aprobación (`wa_campana_aprobar`, 4 argumentos) ya no acepta al admin de plataforma; el texto de la plantilla que queda en la declaración lo lee la base del espejo `whatsapp_template_status`, no de un parámetro.
- Plantilla aprobada en Meta: sin fila `APPROVED` en el espejo no se aprueba la campaña ni se toma lote (un envío rechazado cuenta para el freno).
- Base al activarse sola una escuela: «contacto previo», con dos barreras: la campaña debe filtrar por al menos un interés y la antigüedad máxima del último mensaje es de 90 días (tope también para las escuelas ya activas).
- `wa_compradores_de_servicio` devuelve también la fecha del primer pago (para el reporte) y cuenta por nombre solo los pagos creados después del servicio.
- Festivos: `co_festivos_del_anio(año)` calcula con la regla de traslado, incluida la Virgen de Chiquinquirá (Ley 2578 de 2026). `co_holidays` queda cargada 2026–2035 y es la fuente única: la leen las reservas, el horario de campañas y el BFF (al arrancar y una vez al día; su cálculo local queda solo como red de seguridad).
- Pausas con origen validado adentro: `wa_campanas_pausar_escuela`, `wa_campanas_reanudar_escuela`, `wa_campanas_freno_global` y bitácora `whatsapp_campanas_pausas`.
- Horario de la Ley 2300 también dentro de `wa_campana_tomar_lote` (`wa_horario_de_campanas`, con `co_holidays`; sin festivos del año no envía).
- La regla de frecuencia pospone en vez de omitir.

Reglas de pausa (decididas el 2026-11-15):
- El freno automático marca `pausa_origen = 'freno'`. La escuela reanuda viendo el motivo y aceptándolo; queda registrado con usuario y fecha.
- Si el freno vuelve a saltar dentro de los 7 días siguientes a esa reanudación, la pausa nace con origen `plataforma` y solo SportMaps la levanta.
- SportMaps conserva dos frenos de emergencia: pausar una escuela y pausar todas. No crea, no aprueba ni envía por una escuela.
- En el BFF, quien actúa sale siempre de la sesión, nunca del cuerpo de la petición.
- Mínimo de muestra del freno por bajas: solo frena con al menos 100 envíos en 24 h o al menos 5 bajas (además del 5 %). Un lote piloto de 50 con 3 bajas no frena.

Cupos y lista de espera en la venta de servicios por el bot (decidido el 2026-11-15; necesita migración propia, plan pendiente de aprobación):
- El cupo se verifica ANTES de generar el cobro o el enlace de pago, nunca después de la transferencia.
- Ocupan cupo lo pagado, el abono y el comprobante en validación. Un cobro pendiente sin pago reserva el cupo solo 24 horas; al vencer se libera.
- Al llenarse, el bot cierra la venta y ofrece lista de espera simple. Al liberarse un cupo se avisa al primero de la lista: por texto libre si su ventana de 24 h está abierta; si no, queda marcado para que la escuela lo contacte.
- La lista de espera aparece en el reporte de campaña.
- El precio con descuento aplica a cualquiera que pregunte; si el tramo anterior era más caro, el bot muestra también «antes $X».

Consentimiento de prospectos (decidido el 2026-11-15): el bot pide desde ya consentimiento explícito para novedades a los prospectos, una sola vez; «no» es baja de promociones, nunca baja total.

Fallos «lo revisa SportMaps» (versión básica): aviso al equipo de SportMaps, uno por campaña y tipo de error (no uno por mensaje), con enlace a la campaña, conteos y el código de error de Meta, que ahora se guarda.

Campaña de la clínica de Monster's (requisitos del 2026-11-15):
- Audiencia: solo interesados en la clínica, sin vacacionales ni campamentos; fuera quien ya pagó o abonó la clínica. Se refresca justo antes de que Monster's apruebe, y Monster's confirma el número.
- La campaña lleva `vence_at` en la fecha de cierre.
- El bot cotiza con el 5 % y la fecha límite, y cierra la inscripción (o pasa a lista de espera) al llenarse los cupos reales.

### F0.5 — Reporte de campaña para la escuela (versión básica; lo completo sigue en F5)
Va justo después de F0 y antes de F1. Por campaña:
- destinatarios, enviados, entregados, leídos, respondieron y pagaron o abonaron el servicio dentro de la vigencia;
- pendientes y pospuestos, con la fecha en que saldrán;
- no enviados, con el motivo en lenguaje simple;
- fallidos, con el error de Meta traducido y qué hacer;
- bajas de promociones y cuánto falta para el freno.
Cada fallo va marcado como «lo puedes corregir tú» (texto, plantilla rechazada, audiencia, bajas) o «lo revisa SportMaps» (errores técnicos de envío, integración, envíos inciertos). Los segundos mandan un aviso por correo al equipo de SportMaps: uno por campaña y tipo de error (no uno por mensaje), con enlace a la campaña, conteos y el código de error de Meta. No abren caso en el módulo de soporte (versión básica). Usa los datos que ya se guardan.

### F1 — Mensajes automáticos: texto, interruptor y horario
Pestaña «Mensajes automáticos» con una fila por mensaje (los 15 del inventario): qué es, cuándo sale, por dónde, vista previa con datos de ejemplo, encendido y «Editar».
- Tabla `whatsapp_mensajes_escuela` (escuela, clave del mensaje, activo, texto propio, plantilla propia, días, hora). `text + CHECK` para estados.
- `CONCEPTOS` deja de resolver por nombre fijo: busca primero la plantilla propia aprobada y de utilidad; si no, la de SportMaps.
- Los jobs leen días y hora de la tabla en un solo lote por pase (sin N+1).
- Los ajustes que hoy son variable de entorno pasan a esta tabla.
- Escritura solo por RPC `SECURITY DEFINER` con `user_admin_school_ids()`.

### F2 — Programar y avisar por grupos
- `programada_para` en campañas; el cron de 10 minutos la respeta. La pantalla suma fecha de envío, vencimiento y sede (los dos últimos ya existen en el BFF).
- «Avisos» de utilidad a familias por equipo, sede o estado de pago, con plantilla aprobada, ahora o programados. Pasan por el mismo cupo, freno de calidad y tandas que las campañas.
- Calendario de lo programado, con cancelar y reprogramar.
- Al programar una campaña o un aviso se muestra cuántos mensajes salen y el costo estimado, antes de confirmar.
- Tope diario por persona y canal de la semana (D8). Va al inicio de F2, antes de los avisos a grupos.
- La exclusión de «ya pagó o abonó el servicio que se promociona» se revisa también al momento del envío, no solo al aprobar (alguien puede pagar entre la aprobación y su turno).

### F3 — El bot en manos de la escuela
Pestaña «Asistente»: ficha (lo que sabe), tono, bienvenida, preguntas al interesado, botones de sede, temas que pasan a una persona, modo discreto y respuestas rápidas guardadas para el buzón. Cada cambio guarda versión y permite deshacer; la revisión de coherencia que ya existe corre al guardar.

### F4 — Audiencias y etiquetas
Clasificación de intereses automática cada noche, en lote. Etiquetas manuales desde el chat. Audiencias guardadas («preguntaron por la clínica») reutilizables en campañas y avisos.

### F5 — Reportes, calidad y costo
Por envío y por plantilla: enviado, entregado, leído, respondió, pagó. Historial de avisos de cobro. Calidad del número y nivel de Meta visibles. Costo estimado por categoría. Plantillas: reenviar rechazadas, borrar, encabezado con imagen y botón con enlace.

### F6 — Manual
Dos versiones (interna y academias) con capturas reales del tenant demo, más los artículos para Mapi y el Centro de Ayuda. Se hace al final de cada fase sobre lo ya desplegado; no se commitea.

Pedido del usuario (2026-11-15): lo más claro posible, para que la escuela lo haga sola. Un capítulo por tarea, cada uno con «dónde entro», pasos numerados con captura y «cómo sé que quedó»:
1. Crear mi plantilla y mandarla a aprobación (qué es utilidad y qué es promoción, cuánto tarda Meta, qué hago si la rechazan).
2. Cambiar el texto de un mensaje automático.
3. Poner los horarios y los días de cada mensaje.
4. Encender y apagar cada mensaje, el asistente y las campañas.
5. Activar campañas (la declaración), armar la audiencia, aprobar y programar; cuántos salen y cuánto cuesta.
6. Pausar, reanudar y cancelar; qué pasa cuando el sistema pausa solo.
7. Bajas: «No recibir más» frente a BAJA, y cómo vuelve alguien con ACTIVAR.
8. Preguntas frecuentes y qué no se puede hacer (domingos, festivos, topes).

## 4. Reglas de construcción
- Una migración por fase con `npm run migrations:new`, plan aprobado antes de escribirla, aplicada por una sola sesión.
- Toda RPC valida el alcance contra el id de escuela recibido y lleva `GRANT EXECUTE … TO authenticated`; nada a `anon`.
- `npm run seguridad:invariantes` al cerrar cada fase; `types.ts` una vez por lote.
- La batería `qa:embudo` debe seguir en verde: los textos por defecto no cambian si la escuela no edita nada.

## 5. Riesgos
- Una escuela puede redactar un cobro que Meta reclasifique como promoción: por eso el respaldo de D1.
- Textos editados que rompan el bot (quitar el enlace de pago): las variables obligatorias se validan al guardar.
- Más envíos programados compiten por el cupo del día: cobranza siempre tiene la reserva.
- **Pendiente: dev, stg y prod comparten una sola base.** No hay staging de base de datos; las migraciones se prueban en el gemelo local (Docker, `npm run qa:twin:up`) y luego van directo a la base viva. Un error en una migración le pega a producción.
- `co_holidays` está cargada hasta 2028: hay que cargar 2029 antes de fin de 2028 o las campañas dejan de salir (fallo cerrado).

## 6. Correos de mora y WhatsApp en la misma semana (revisión del 2026-11-15)
Leído en `recordatorios-cobro.service.ts` y `payment-lifecycle-emails.job.ts`; no se midió en datos cuántas veces pasó.
- La escalera elige canal en cada envío: WhatsApp si la familia tiene consentimiento vigente, si no correo. El candado es familia-día, no familia-semana.
- El aviso de cobro generado y el de vencido intentan WhatsApp y, si no sale por cualquier motivo (sin plantilla aprobada, sin enlace, sin consentimiento), mandan correo.
- Resultado: una familia puede recibir WhatsApp el lunes y correo el miércoles si entre los dos cambió su consentimiento o falló la plantilla. Los envíos manuales de `/payment-reminders` no cuentan en ningún candado.
- Arreglo (D8): guardar el canal de la semana por familia a partir de `collection_notices` y respetarlo en los tres caminos.
