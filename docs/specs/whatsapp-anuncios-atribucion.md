# Anuncios con clic a WhatsApp: de dónde viene cada interesado y hasta dónde llega

Estado: **plan para aprobar (2026-11-04)**. Pedido: Monster activó anuncios en Meta y quiere saber qué pasa
después del clic. Sirve igual para los anuncios de SportMaps (B10).

## 1. Lo que ya existe (y cambia el plan)

- **El dato ya se está guardando.** El webhook guarda el mensaje entrante COMPLETO de Meta en
  `whatsapp_messages.payload` (`routes/whatsapp.ts:406`, `p_payload: msg.raw`). Cuando el mensaje viene de un
  anuncio, Meta trae ahí `referral`: `source_id` (id del anuncio), `source_type` (`ad`/`post`), `source_url`,
  `headline`, `body`, `media_type`, `image_url`/`video_url`, `ctwa_clid`. Monster quedó conectado el 2026-11-04
  10:54: **desde ese momento no se pierde nada**, aunque esto se construya después. Lo anterior (historial) no
  trae `referral`.
- El interesado del embudo guarda su conversación (`school_signup_leads.source_detail.conversation_id`).
- Pagos por comprobante: `wa_cobros_desde_comprobante` (cola → conversación, `signup_lead_id`, `payment_id`).

## 2. Hueco urgente: el anuncio de la clínica cae en el embudo de la clase de prueba

Ni el embudo ni la puerta del desconocido reconocen «clínica»: un clic en un anuncio de la clínica + «quiero
información» arranca sede + 5 preguntas de la clase de prueba. Hoy no pasa porque el bot está apagado; **hay que
resolverlo antes de prenderlo.**

Propuesta (fase 1): **destino por anuncio**. Si el primer mensaje trae `referral`:
- el `source_id` está mapeado por la escuela a un destino (`clase_prueba` | `servicio:<id del catálogo>` |
  `persona`), o
- sin mapeo: se infiere del texto del anuncio/mensaje (`headline`/`body`/texto: «clínica», «vacacional»,
  «torneo» → el servicio del catálogo con ese nombre; si no, el embudo de siempre).
Destino servicio → el bot manda la ficha del servicio (descripción, precio de hoy, afiliado, abono), los datos
de pago y deja el **motivo esperado** (B4) para que el comprobante se aplique solo. Destino persona → buzón.

## 3. Esquema (una migración, se aplica en una sola sesión)

- `whatsapp_atribucion` (PK `conversation_id`): `integration_id`, `school_id`, `contact_wa_id`,
  `primer_source_id`, `primer_source_type`, `primer_headline`, `primer_source_url`, `primer_at`,
  `ultimo_source_id`, `ultimo_headline`, `ultimo_ctwa_clid`, `ultimo_at`, `toques int`.
  Primer toque = de qué anuncio llegó; último = el que lo hizo volver.
  RLS activado y **sin policies** (solo BFF / RPC).
- Se llena con un trigger `AFTER INSERT ON whatsapp_messages` (solo `direction = 'inbound'` y
  `payload ? 'referral'`; `SECURITY DEFINER`, `search_path` fijo, REVOKE a todos) y un **backfill** desde los
  payloads guardados desde el 2026-11-04.
- `whatsapp_anuncio_destino` (`school_id`, `source_id`, `destino text CHECK (…)`, `servicio_id`): el mapeo §2.
  Policies: escritura `user_admin_school_ids()`; lectura staff.
- `whatsapp_anuncio_gasto` (`school_id`, `source_id`, `desde`, `hasta`, `monto`): opcional, lo escribe la
  escuela para ver costo por conversación / por pago. (Después: traerlo solo con la API de Marketing; pide
  permiso `ads_read` y revisión de Meta.)
- RPC `wa_embudo_anuncios(p_school_id, p_desde, p_hasta, p_branch_id DEFAULT NULL)` `SECURITY DEFINER`,
  `STABLE`: valida ADENTRO que el caller administre ESA escuela (`user_admin_school_ids()` o admin de plataforma);
  `GRANT EXECUTE … TO authenticated`. Devuelve una fila por anuncio + total.

## 4. Las etapas (por conversación que llegó de un anuncio)

| Etapa | Regla |
|---|---|
| Conversaciones | Tiene fila en `whatsapp_atribucion` dentro del rango (por `primer_at`). |
| Contestó las preguntas | Hay lead del embudo con `source_detail.conversation_id` = la conversación. |
| Separó / agendó | El lead tiene `cupo_separado_slot_id` o `trial_slot_id`. |
| Pagó | Pago aprobado ligado al lead o a la conversación (comprobante con motivo), separado por motivo: clase de prueba, clínica, matrícula…; suma del monto. |
| Asistió | El ciclo de la clase lo marcó asistido (prospecto-ciclo-clase). |
| Se matriculó | Lead convertido / deportista creado desde el lead. |

Para la clínica: conversaciones → pidieron info → separaron (abono) → pagaron completo, con el recaudo.

## 5. Pantalla

WhatsApp → pestaña **Anuncios** (dueño/admin de la escuela y admin de plataforma): filtros de fechas y sede;
tabla por anuncio (título del anuncio, miniatura si viene) con cada etapa, % de paso y recaudo; si hay gasto,
costo por conversación y por pago; clic en un anuncio → las conversaciones (enlace al buzón). Ahí mismo, el
mapeo «este anuncio va a…» (§2).

## 6. Pruebas

- Unitarias: extracción de `referral`, primer/último toque, inferencia de destino.
- Batería `qa:embudo`: nuevo bloque `anuncios` — primer mensaje con `referral` (clínica, clase de prueba, sin
  mapeo) → destino correcto, motivo esperado, nunca el embudo equivocado.
- RPC sobre datos reales en solo lectura (conteos) + gate: un coach / otra escuela → 0 filas / 403.

## 7. Fases

1. **Ya (antes de prender el bot):** destino por anuncio/intención (§2) + tabla de atribución + trigger +
   backfill + RPC + pestaña Anuncios (sin gasto).
2. Gasto manual → costo por pago. Mismo panel para el canal de SportMaps (B10).
3. Devolver a Meta los eventos (API de conversiones para mensajería) para que optimice hacia quienes pagan;
   requiere revisión de Meta.

## 8. Decisiones

- D1. ¿El destino lo infiere el bot por el texto del anuncio, o la escuela mapea cada anuncio? Propuesta: las
  dos; el mapeo manda, la inferencia cubre los anuncios nuevos.
- D2. Atribución por primer toque (de dónde llegó) en el embudo; el último toque se muestra aparte.
- D3. ¿El gasto lo cargan a mano ya, o esperamos la API de Marketing? Propuesta: a mano primero.
