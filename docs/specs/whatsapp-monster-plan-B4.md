# Plan B4 · Comprobantes con motivo (todas las escuelas)

Planeación de solo lectura, 2026-10-29. Rutas relativas al repo. Construye encima de `20261029215003_cobro_clase_prueba.sql`
(aplicada en la base y sin commitear; verificado en vivo: `payments.signup_lead_id`, `trial_price`, CHECK con `reserva` y
`clase_prueba`). **Reemplaza lo que la spec B4.3 dice de `unregistered_athlete` por `payments.signup_lead_id`.**

## 1. Qué existe hoy

**Las listas de motivos (12, no 7) que no coinciden**
| # | Dónde | Qué tiene / qué le falta |
|---|---|---|
| L1 | CHECK `payments_payment_category_check` (vivo = `20261029215003:63-69`) | 12: mensualidad, inscripcion, articulos, torneo, otro, seguro, excedente, clase_extra, vacacional, viaje, reserva, clase_prueba |
| L2 | `bff/src/services/tipo-de-cobro.ts:62-75` `ETIQUETA_CATEGORIA`; `:122-132` `CORTA` | sin `reserva`; `CORTA` sin `clase_prueba` (sale «Clase», choca con clase_extra). La línea 72 `clase_prueba` es de OTRA sesión, sin commitear |
| L3 | `bff/src/services/payment-accounts.ts:20` `CATEGORIAS_COBRO`, `:148-162` `categoriaDeCobro`, `:170` `NOMBRE_CATEGORIA`, `:191` `ETIQUETA_COBRO` | sin `clase_prueba` ni `reserva`: `categoriaDeCobro('clase_prueba')` da **null** → `receipt-context` y `only_for` no la conocen |
| L4 | `bff/src/services/whatsapp-otro-concepto.service.ts:23-31` `OtroConcepto`, `:34` nombres, `:49-60` patrones, `:85-94` mapa categoría→concepto | sin clínica ni clase de prueba |
| L5 | `bff/src/services/ventas-servicios.service.ts:20` `TipoServicio` + CHECK `school_tournament_items.kind` (`20261007095911:251`) | torneo/viaje/clase_extra/vacacional/otro |
| L6 | `bff/src/services/whatsapp-comprobante-guiado.service.ts:210-214` `OPCIONES_CONCEPTO` | fijo [Mensualidad][Inscripción][Otro] |
| L7 | `bff/src/routes/payments.routes.ts:525` zod de `/extract-receipt` | 10 valores: **un `clase_prueba` desde la app da 400** |
| L8 | `frontend/src/components/payment/PaymentCheckoutModal.tsx:129` unión `conceptType`; `:1148-1171` selector; `:341-346` y `:421-426` mapeo | 6 opciones fijas. **Bug**: `:185-206` carga TODOS los ítems de `school_tournament_items` y los cobra como `torneo` (una clínica `clase_extra` o un viaje quedan mal categorizados) |
| L9 | `frontend/src/lib/payment-accounts.ts:54` `CHARGE_CATEGORIES`, `:101-115`, `:118-129` etiquetas, `:199-212` filtro (`reserva` a mano) | sin `clase_prueba`/`reserva` |
| L10 | `frontend/src/lib/manualPaymentCharge.ts:28-39` | opciones de «Registrar pago» |
| L11 | `frontend/src/lib/accounting/csv.ts:80-84` | OTRA sesión agregó `clase_prueba` (sin commitear) |
| L12 | SQL `open_month` y su vista previa: `NOT IN` explícito (`20261014212627:651-653` y `:807-809`) | **sin `clase_prueba` ni `reserva`**: un pago de clase de prueba que pasa al deportista (trigger de la otra sesión) con `due_date` en el mes **cuenta como la mensualidad** y `open_month` no emite la de ese mes. Bug latente hoy |

**Decisión: NO se crea `evento`.** La clínica es `clase_extra` (formación adicional, igual que el «perfeccionamiento» que
Dynasty ya vende) con el nombre del ítem en el concepto («Clínica de armadores y atacantes — Mariana»). Una categoría nueva
cuesta: 2 CHECK (`payments` y `school_tournament_items.kind`), las 2 funciones de L12 (si no, el mismo bug de mensualidad
saltada), `wa_crear_cobro_suelto`, y las 11 listas; la ganancia es solo una etiqueta. Si más escuelas venden eventos, se
agrega junto con la regla genérica de `open_month`. `clase_prueba` NO se vuelve a agregar al CHECK.

**Comprobante por WhatsApp** (`bff/src/jobs/whatsapp-queue.job.ts`): `procesarFilaInterna` `:2346-2706` decide por
`decidirAdjunto` `:1702-1716` (prospecto = `desconocido` → `comprobanteDeNumeroSinFicha` `:2147-2237`, que busca deportista
por nombre y si no, pregunta). `continuarComoComprobante` `:1021-1319`: repetido → destino fuera/ajeno `:1055-1092` →
venta abierta `:1103-1122` (el único «motivo esperado» que existe hoy, en `whatsapp_conversation_flows`) → otro concepto
`:1128-1157` → texto/monto `:1169-1215` (`preguntarConcepto` `:817-840`) → sin pendientes `:1240-1268`
(`preguntarMesOQuien` `:777-814`, pregunta de quién con 2-3 hijos) → combinación `:1277-1290`
(`wa_cubrir_cobros_con_comprobante`, `20261013165308:467-518`: principal en `awaiting_approval`, resto `pending/overdue`, ≤8)
→ preguntar `:1292-1304` → aplicar. `estamparComprobante` `:492-586` deja `awaiting_approval` + veredicto;
`aplicarComprobante` `:588-705` llama `evaluatePaymentReceipt` (auto-aprobación por ajuste de la escuela) y responde.
Precios esperados de la familia: `whatsapp-pago-esperado.service.ts:320-400` (cuota, plan, `registration_fee`).

**Ráfaga y preguntas:** `runWhatsAppQueue` `:2798-2852` agrupa por contacto y procesa en serie; las respuestas se juntan
en `resumirRafaga` `:1865-1880`, pero las preguntas (`PASOS_PREGUNTA` `:1848-1851`) salen YA, una por foto.
`resolverRespuestaDeCobro` (`whatsapp-respuesta-de-cobro.service.ts:96-104`) toma **solo la fila más nueva**; la anterior
queda `waiting_user` sin que nadie la vuelva a preguntar y vence a las 24 h (`vencerPreguntasSinRespuesta` `:2737`).
Para familias identificadas el resolver corre en cada mensaje (`whatsapp-bot.service.ts:469`); para no identificadas
(prospectos) solo si `hayPreguntaDeCobroAbierta` (`whatsapp-bot.service.ts:4961-4976`, filas `waiting_user`).

**Destino:** `destinoEsDeLaEscuela` `:969-980` es permisivo (sin cuentas o sin destino leído → true).
`buildVerdictContext` (`receipt-context.service.ts:76-148`) ya junta `nequi_number`, `daviplata_number`, `bank_account_number`,
`breb_key`, `transfer_key`, `breb_number` y `payment_accounts[]` (con `only_for` y `fuera_de_sportmaps`). Monster no tiene
ninguna (B1). Hueco: `normalizeDestination` (`receipt-verdict.ts:183-194`) no quita `+57`: «+57 319 450 5150» no casa con
«3194505150».

**«Motivo esperado» — dónde guardarlo.** `whatsapp_turnos_pendientes` (`20261029110305`) no sirve: es recuperación de
turnos, se borra al terminar. `whatsapp_conversation_flows` tiene PK `conversation_id` (`20261005133534:507`): uno por
conversación, chocaría con la venta o la factura abiertas. El payload del saliente no registra consumo, no admite dos
esperados (hermanos, matrícula + uniformes), en modo asistido puede ser un borrador y obliga a un UPDATE sobre
`whatsapp_messages`. → **tabla propia pequeña** (`whatsapp_conceptos_esperados`), solo `service_role`.

## 2. Borrador de migración (NO escribir hasta aprobar; `npm run migrations:new -- comprobantes_con_motivo`)

```sql
BEGIN;
-- M1 Interruptor por escuela (sin UI en esta entrega: lo prende SportMaps, como tournament_charges_enabled)
ALTER TABLE public.school_settings ADD COLUMN wa_cobro_desde_comprobante boolean NOT NULL DEFAULT false;
-- M2 Motivo esperado (lo escribe registrarConceptoEsperado; lo consume la cola)
CREATE TABLE public.whatsapp_conceptos_esperados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  telefono text NOT NULL CHECK (telefono ~ '^[0-9]{10,15}$'),          -- = contact_wa_id
  motivo text NOT NULL CHECK (motivo = ANY (ARRAY['mensualidad','inscripcion','articulos','torneo','otro','seguro',
        'excedente','clase_extra','vacacional','viaje','reserva','clase_prueba'])),
  monto numeric CHECK (monto IS NULL OR monto > 0),
  signup_lead_id uuid REFERENCES public.school_signup_leads(id) ON DELETE CASCADE,
  child_id uuid REFERENCES public.children(id) ON DELETE CASCADE,
  origen text NOT NULL DEFAULT 'bot' CHECK (origen IN ('clase_prueba','venta','bot')),
  vence_en timestamptz NOT NULL,
  consumido_at timestamptz, payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL, queue_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(signup_lead_id, child_id) <= 1));
CREATE INDEX idx_wa_conceptos_vivos ON public.whatsapp_conceptos_esperados (school_id, telefono) WHERE consumido_at IS NULL;
-- M3 Marca «lo creó el asistente desde un comprobante» + idempotencia (un comprobante puede crear 2: combinación)
CREATE TABLE public.wa_cobros_desde_comprobante (
  payment_id uuid PRIMARY KEY REFERENCES public.payments(id) ON DELETE CASCADE,
  school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  queue_id uuid NOT NULL,
  fuente text NOT NULL CHECK (fuente IN ('trial_price','registration_fee','merchandise_item','tournament_item')),
  fuente_id uuid, concepto_esperado_id uuid REFERENCES public.whatsapp_conceptos_esperados(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_cobros_desde_comprobante_uq UNIQUE NULLS NOT DISTINCT (queue_id, fuente, fuente_id));
-- Ambas: RLS prendido, SIN policies; REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT SELECT,INSERT,UPDATE,DELETE TO service_role.
-- M4 RPC (solo BFF). SECURITY DEFINER, SET search_path = pg_catalog, public, pg_temp.
CREATE FUNCTION public.wa_crear_cobro_desde_comprobante(p_school_id uuid, p_queue_id uuid, p_categoria text,
  p_monto numeric, p_fuente text, p_fuente_id uuid, p_child_id uuid, p_unregistered_id uuid, p_signup_lead_id uuid,
  p_concepto text, p_concepto_esperado_id uuid DEFAULT NULL) RETURNS jsonb ...
--  1. Idempotencia: si ya hay fila en M3 con (queue, fuente, fuente_id) → {ok:true, payment_id, ya_existia:true}.
--  2. Alcance (no hay auth.uid: es service_role): num_nonnulls(child, unregistered, lead) = 1 y ESE dueño es de
--     p_school_id (children.school_id / unregistered_athletes.school_id / school_signup_leads.school_id); lead FOR UPDATE,
--     status <> 'discarded'. parent_id sale de children.parent_id (nunca del BFF).
--  3. Precio desde la fuente, nunca del BFF (|precio - p_monto| <= 1, si no → {ok:false,codigo:'monto_no_coincide'}):
--     trial_price      → categoria='clase_prueba', exige lead; school_trial_class_settings.trial_price
--     registration_fee → categoria='inscripcion'; offering_plans.id=p_fuente_id AND school_id=p_school_id
--     merchandise_item → categoria='articulos'; activo, de la escuela; price o un valor de price_by_size
--     tournament_item  → categoria = item.kind; activo, event_id IS NULL; con capacity: item FOR UPDATE + vivos < capacity
--  4. clase_prueba: si el lead ya tiene un cobro clase_prueba vivo → {ok:false, codigo:'ya_tiene_cobro', payment_id}.
--  5. INSERT payments (status 'pending', amount = precio de la fuente, payment_type 'one_time',
--     period_uniqueness_exempt true, due_date = hoy Bogotá (clase_prueba: fecha de la clase, igual que
--     registrar_pago_clase_prueba), created_by NULL, notes 'Creado por el asistente desde un comprobante')
--     + INSERT M3; si el lead ya está convertido → PERFORM _mover_pago_clase_prueba(lead) (pasa el cobro al deportista).
REVOKE ALL ON FUNCTION public.wa_crear_cobro_desde_comprobante(...) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_crear_cobro_desde_comprobante(...) TO service_role;
-- (Convención del repo para RPC solo-BFF, igual que wa_cubrir_cobros_con_comprobante: ningún authenticated la llama,
--  así que no hay caller que validar; la validación de alcance es «todo pertenece a p_school_id».)
-- M5 (va en ESTA migración; acordado con la sesión de 20261029215003, que ya está commiteada en ce6b66a0)
--    CREATE OR REPLACE registrar_pago_clase_prueba y listar_cobros_clase_prueba desde el cuerpo VIVO: el «ya pagada»
--    y el LATERAL filtran payment_category='clase_prueba' (hoy cuentan cualquier cobro del lead: una matrícula del
--    prospecto bloquearía registrar la clase). _mover_pago_clase_prueba NO se filtra: al inscribirse, la matrícula y
--    los uniformes pagados como prospecto también tienen que pasar al deportista.
-- M6 HECHO por la otra sesión: 20261029222300_open_month_ignora_clase_prueba (develop ce6b66a0, main 1de4de9c,
--    aplicada). Ya no va aquí.
COMMIT;
```
Sin `IF NOT EXISTS`, sin `CREATE TYPE`. Después: `npm run seguridad:invariantes` (I1-I4 no aplican: tablas sin policies,
RPC con search_path), `npm run migrations:check`; `types.ts` una sola vez al final del lote. Smoke en
`supabase/migrations/_smoke/` con ROLLBACK (idempotencia, monto ajeno, dueño de otra escuela, cupo, lead descartado).

## 3. Cambios archivo por archivo

**BFF — catálogo único** (nuevo `bff/src/services/motivos-de-cobro.ts`, la fuente): `MOTIVOS` = las 12 claves de L1 en orden,
cada una con `etiqueta`, `corta` (≤9: «Prueba», «Reserva»), `plural`, `palabrasClave` (regex de otro-concepto),
`seCobraPorItem`. Derivan de él: L2 (`ETIQUETA_CATEGORIA`/`CORTA` mismos nombres de export), L3 (`CATEGORIAS_COBRO`,
`NOMBRE_CATEGORIA`, `ETIQUETA_COBRO`; `categoriaDeCobro` reconoce `clase_prueba`/`reserva`), L4 (patrones nuevos
`clase_prueba` = «clase de prueba|clase de cortesia», y «clinica» en `clase_extra`), L5 (`TipoServicio` = subconjunto
tipado), L7 (zod desde `MOTIVOS`). `receipt-verdict.ts:183`: quitar `+57`/`57` delante de un celular de 10 dígitos.

**BFF — motivo esperado** (nuevo `bff/src/services/wa-concepto-esperado.service.ts`):
- `registrarConceptoEsperado(schoolId, telefono, c: { motivo; monto?; leadId?; childId?; venceEn? }): Promise<boolean>`
  (contrato con B3, nombres exactos). Normaliza teléfono a dígitos (10 dígitos con 3 → antepone 57), valida motivo contra
  `MOTIVOS`, vence por defecto en 24 h, «upsert» (mismo school+teléfono+motivo+dueño sin consumir → actualiza). Nunca lanza.
- `conceptosEsperadosDe(schoolId, telefono)` (vivos), `elegirEsperado(lista, monto)` pura, `consumirEsperado(id, paymentId,
  queueId)` con UPDATE condicionado `consumido_at IS NULL` (gana uno entre los 3 BFF).

**BFF — cobro desde comprobante** (nuevo `bff/src/services/wa-cobro-desde-comprobante.service.ts`):
- `cobroDesdeComprobanteActivo(schoolId)`: lee SOLO `school_settings.wa_cobro_desde_comprobante` (si la columna no existe →
  false). No toca `whatsapp-ajustes-escuela.service.ts` (B2/B3/B6 lo editan).
- `preciosDeMotivos(schoolId, dueño)`: `trial_price`; `registration_fee` (con deportista: el de su plan vía
  `deportistasEsperados`; prospecto: el único valor distinto entre planes activos, si hay uno); `school_merchandise_items`
  activos; `catalogoServicios` (ítems de servicio). Una lectura por fuente, solo cuando se necesita.
- Puras: `motivoPorMonto(monto, precios, {cuotas})` → `uno | varios (≤3, combinación única) | ambiguo | ninguno` (nunca
  propone si el monto es una cuota: eso sigue por el camino de hoy); `decidirConEsperado(esperado, monto, destino,
  pendientes)` → `aplicar_existente | crear | a_la_escuela | seguir`; `opcionesDeMotivo(precios)` → 2 motivos con precio +
  «Otro» (botones).
- `crearCobroDesdeComprobante(...)` → RPC M4; `anularCobroCreado(paymentId)` (si el estampado falla: `pending` → `cancelled`,
  solo si está en M3).
- `pendientesDelLead(schoolId, leadId)`; lead por teléfono con `variantesTelefonoLead` (`whatsapp-prospecto-lead.service.ts:48`).

**BFF — cola** (`jobs/whatsapp-queue.job.ts`):
1. `continuarComoComprobante` `:1021`: `opts.motivo?` (forzado). Tras la venta `:1122` y antes de otro concepto: esperado
   vivo → `decidirConEsperado`. Con lead y `clase_prueba`: aplicar al cobro pendiente del lead o crear (M4) y estampar con
   `aplicarComprobante`; **agenda solo si** monto = esperado (±$1), `destinoDelComprobante` = 'general' con coincidencia
   `exact` (nunca null/«sin cuentas», nunca `masked`) y veredicto ≠ rojo → `confirmarClasePruebaPagada({ schoolId, leadId,
   paymentId, telefono })` por import dinámico de `clase-prueba-agenda.service` (B3); su `texto` es la respuesta. Si algo no
   coincide: no se crea nada, a la bandeja con propuesta y a una persona (B4 no agenda). Esperado de familia (childId) que no
   calza → `seguir` (puede ser la mensualidad).
2. `aplicarComprobante` `:588`: devuelve `{action, veredicto}` (los llamadores actuales lo ignoran); `extra.alAplicar?` para
   reemplazar la respuesta (texto de B3); pasa `linea {monto, motivo, atleta, paymentId, nuevo}` al `responder`.
3. Con el interruptor prendido: en `sin_pendientes` `:1240` (después de «ya registrado», antes de `preguntarMesOQuien`), en
   `monto_no_cuadra` `:1197` y en otro concepto `a_la_escuela` `:1148` (el pie dice «uniformes» y $60.000 es el precio) →
   `motivoPorMonto`: `uno` crea+aplica; `varios` crea todos y aplica el principal con `cubre` (RPC existente); `ninguno` →
   `preguntarConcepto` con `opcionesDeMotivo`. Apagado: idéntico a hoy.
4. Hermanos: motivo resuelto sin dueño y 2-3 deportistas → pregunta de deportista (reusa `botonesDeDeportistas`) con
   `guia.motivo`; `aplicarComprobanteDeFicha` `:2304` pasa `guardado.parentId` y `motivo` SOLO si `guia.motivo` existe.
5. Prospecto: `comprobanteDeNumeroSinFicha` `:2147`: con esperado vivo cuenta como «habla de pago» (sin tope OCR) y va al
   punto 1 antes de `deportistaPorNombre`; sin esperado y con interruptor: lead por teléfono + `motivoPorMonto`.
6. Fila de preguntas: en `responder` `:2475`, si `paso ∈ PASOS_PREGUNTA` y el contacto ya tiene otra fila `waiting_user` con
   `pregunta_at` < 24 h → no se envía; la fila queda `waiting_user` con `pregunta_at = null` y
   `pregunta_ocr.en_fila = {texto, paso, botones, monto}` (lo persisten `esperarAlUsuario` `:388` y `guardarPreguntaGuiada`).
7. Ráfaga `:2837`: si ≥1 respuesta trae `linea` asignada por B4 → «¡Recibí N comprobantes! ✅ 1. $310.000 → Matrícula ·
   Mariana …» + [Sí, está bien][Cambiar un motivo], paso `resumen_motivos`, `lineas` en el payload. Si no → `resumirRafaga`
   intacto. Silencio = está bien (no agrega paso).

**BFF — respuestas** (`services/whatsapp-respuesta-de-cobro.service.ts`, `whatsapp-comprobante-guiado.service.ts`):
- Tras resolver una fila (cerrada o aplicada) → `promoverSiguientePregunta`: la `en_fila` más vieja sale con «Sigue el
  comprobante de $X: …» y recibe `pregunta_at = now()`.
- Respuesta a `ask_concepto` con un motivo con precio y monto igual → crear+aplicar (vive aquí, que ya importa la cola);
  si no, la bandeja de hoy. `OPCIONES_CONCEPTO` queda como default (interruptor apagado).
- «Sí, está bien» / «Cambiar un motivo» (solo si el texto ES el título del botón: cero lecturas extra en mensajes normales) y
  el último saliente < 24 h es `resumen_motivos` → «¡Gracias!» / a la escuela con las líneas y el texto de la familia
  (v1: la corrección la hace la escuela; todo está en revisión).
- Exporta `hayResumenDeMotivosAbierto(integrationId, contactWaId)`.

**BFF — integración** (`whatsapp-bot.service.ts:4961`, 1 línea, con B3/sesión del bot): `hayPreguntaDeCobroAbierta` ||
`hayResumenDeMotivosAbierto` (para que un prospecto pueda tocar «Cambiar un motivo»).

**Frontend:** nuevo `frontend/src/lib/motivosDeCobro.ts` (espejo de `MOTIVOS`, con `enSubidaAcudiente`,
`enRegistroManual`). `lib/payment-accounts.ts` deriva `CHARGE_CATEGORIES`/`CHARGE_CATEGORY_LABEL` de ahí (el filtro de
Pagos `chargeFilterKey` ya agrupa por categoría: con eso aparecen «Clase de prueba», «Reserva» y «Clase extra/Clínica» sin
tocar `PaymentsAutomationPage.tsx`). `lib/manualPaymentCharge.ts` deriva sus opciones (mismo orden y textos de hoy).
`PaymentCheckoutModal.tsx`: opciones de `MOTIVOS.enSubidaAcudiente`; `initialConceptType` acepta cualquier motivo (motivo
preseleccionado); ítems de servicio con `kind` y `payment_category = kind` (arregla el bug de L8, un `kind` por pago);
`payment_category` y `period_uniqueness_exempt` desde el catálogo. En un segundo paso, cuando la otra sesión commitee:
`?motivo=` en `pages/MyPaymentsPage.tsx` y `csv.ts` derivado.

## 4. Cómo no cambia el flujo de hoy (Dynasty, Dreamers…)

- `wa_cobro_desde_comprobante` nace `false`: sin él no hay motivo por monto, ni cobros creados, ni botones nuevos.
- El esperado solo existe si alguien lo registra (B3 con `trial_price` > 0): sin fila, `continuarComoComprobante` no cambia.
- El resumen nuevo de ráfaga solo sale si alguna línea la asignó B4; si no, `resumirRafaga` igual que hoy.
- Refactor de catálogos con los mismos nombres de export y las mismas salidas (pruebas de caracterización ANTES).
- Cambios que sí alcanzan a todos y piden visto bueno (sección 6): fila de preguntas, patrones de otro concepto, `+57`,
  `clase_prueba` reconocida en `categoriaDeCobro`, el bug del modal (L8).
- La aprobación sigue siendo de `evaluatePaymentReceipt` y del ajuste `auto_approve_*` de cada escuela.

**Estado del cobro de clase de prueba creado por comprobante: `awaiting_approval`, no `paid`.** Sale del mismo
estampado que cualquier comprobante. Así un pantallazo editado no entra como ingreso (caja y KPIs suman por estado),
el «ya pagada» de `registrar_pago_clase_prueba` igual lo cuenta (no hay cobro doble) y, si la escuela tiene
auto-aprobación con tope ≥ $15.000 y el veredicto sale verde, queda pagado solo. D9 se cumple: se agenda al recibir y la
revisión no frena la agenda.

## 5. Pruebas (vitest; escribir primero las de caracterización y commitearlas solas)

| Archivo | Qué fija |
|---|---|
| `bff/src/services/motivos-de-cobro.contrato.test.ts` | claves = último CHECK de `supabase/migrations` = espejo del frontend; cada motivo con etiqueta, corta ≤9 única |
| `tipo-de-cobro.test.ts`, `payment-accounts.test.ts`, `whatsapp-otro-concepto.test.ts` (+) | tabla de salidas de HOY para las 10 categorías viejas sin cambio; `clase_prueba`/`reserva` nuevas; «clínica», «clase de prueba» |
| `receipt-verdict.test.ts` (+) | `+57 319 450 5150` = `3194505150`; `0089455111`, `@3204298969`, `****6942` como hoy |
| `wa-concepto-esperado.service.test.ts` | teléfono normalizado, motivo inválido no escribe, sin duplicados, vence 24 h, vencidos/consumidos fuera, consumo único |
| `wa-cobro-desde-comprobante.test.ts` | `motivoPorMonto` (único, ambiguo, 370 = 310 + 60, ±$1, ≤3, nunca una cuota); `decidirConEsperado` (lead ok, monto distinto, destino null/masked, cobro pendiente existente, familia → seguir) |
| `jobs/whatsapp-queue-motivo.test.ts` | caracterización con interruptor apagado: pregunta de mes, [Mensualidad][Inscripción][Otro], otro concepto a la escuela, ráfaga sin botones = hoy. Nuevo: clase de prueba → RPC con lead, `awaiting_approval`, `evaluatePaymentReceipt`, B3 una vez y su texto; B3 ausente → no agenda; 310 k crea inscripción; 370 k crea 2 y cubre; 55 k → botones; hermanos; fila (sale 1 pregunta) |
| `whatsapp-respuesta-de-cobro.test.ts` (+) | promueve la siguiente con su monto; «Sí, está bien» / «Cambiar un motivo»; un texto normal no lee `whatsapp_messages` |
| `frontend/src/lib/motivosDeCobro.test.ts`, test del modal | etiquetas y filtro; opciones de «Registrar pago» idénticas a hoy; preselección; servicio con su `kind` |

## 6. Riesgos, choques y preguntas abiertas

**Choques (git status de hoy):** `bff/src/services/tipo-de-cobro.ts` (M, otra sesión) → T2 lo toca después de su
commit. `frontend/src/lib/accounting/csv.ts` (M) y `pages/MyPaymentsPage.tsx` (M, archivo entero en CRLF) → segundo paso.
`pages/PaymentsAutomationPage.tsx` (M) y `ClasesDePruebaDialog.tsx`/`useCobrosClasePrueba.ts` (??) → no se tocan.
`supabase/migrations_ledger.json` (M) y `20261029215003_cobro_clase_prueba.sql` (??): esa migración tiene que estar
commiteada antes que la de B4. `whatsapp-bot.service.ts` (lo editan B3 y otra sesión) → solo la línea de T6.
`docs/specs/whatsapp-monster-requerimientos.md` (M) → corregir B4 (signup_lead_id, sin `evento`) cuando se apruebe.
El repo está en CRLF: los parches de varias líneas fallan si no se normaliza.

**Riesgos:** cobro creado y estampado fallido → se anula (y antes se mira la referencia duplicada para no crearlo); 3 BFF
→ consumo condicionado + idempotencia por fila de la cola + FOR UPDATE del lead; IO → +2 lecturas por comprobante con
índice y cero por mensaje normal; una sola sesión aplica la migración; el número de pruebas no recibe imágenes hasta B7.

**Preguntas para el usuario:**
1. Fila de preguntas para TODAS las escuelas (hoy una ráfaga de Dynasty saca 2 preguntas y una se pierde). Recomiendo sí.
2. Patrones nuevos («clínica», «clase de prueba») que sacan comprobantes de la mensualidad en todas. Recomiendo sí.
3. Matrícula pagada como prospecto + alta que emite `registration_fee` = doble inscripción. ¿Exonerar sola en el alta
   cuando el lead trae una inscripción viva? Sin decidir esto, B4 v1 crea la matrícula del prospecto solo con esperado.
4. Si la escuela rechaza después el comprobante de una clase ya agendada: ¿se desagenda? Propuesta: no, decide la escuela (B3).
5. «Cambiar un motivo» v1 = a la escuela (sin autoservicio). ¿OK?
6. M5 y M6 (bug latente de `open_month` con `clase_prueba`/`reserva`): ¿los hace B4 o la sesión de `cobro_clase_prueba`?
7. B3 debe usar `trial_price` (no crear `precio_whatsapp`) y mostrar `awaiting_approval` como «En revisión» en el diálogo.
8. Interruptor sin pantalla en esta entrega (lo prende SportMaps por SQL para Monster). ¿OK?
9. ¿Quién registra el esperado de matrícula/uniformes (paso 7 de la maqueta)? B4 da la función; quien escribe «Paga
   $370.000…» (B2 o la herramienta del bot) debe llamarla. Sin eso, decide el monto.

## 7. Tareas de construcción paralelas (sin archivos en común)

| Tarea | Archivos (exclusivos) | Depende de |
|---|---|---|
| T1 Migración | nueva `supabase/migrations/<ts>_comprobantes_con_motivo.sql`, `migrations_ledger.json`, smoke; al final `types.ts` | aprobación; commit de 20261029215003; una sola sesión aplica |
| T2 Catálogo BFF | nuevo `motivos-de-cobro.ts` + contrato; `tipo-de-cobro.ts`, `payment-accounts.ts`, `whatsapp-otro-concepto.service.ts`, `ventas-servicios.service.ts`, `routes/payments.routes.ts`, `receipt-verdict.ts` y sus tests | commit de la otra sesión en `tipo-de-cobro.ts` |
| T3 Esperado + creación | nuevos `wa-concepto-esperado.service.ts`, `wa-cobro-desde-comprobante.service.ts` y sus tests | firmas de este plan; RPC de T1 para correr en vivo |
| T4 Cola y respuestas | `jobs/whatsapp-queue.job.ts`, `services/whatsapp-respuesta-de-cobro.service.ts`, `services/whatsapp-comprobante-guiado.service.ts`, nuevos `whatsapp-queue-motivo.test.ts` y `whatsapp-respuesta-fila.test.ts` | interfaces de T3 (stub), B3 por import dinámico |
| T5 Frontend | nuevo `lib/motivosDeCobro.ts` + test, `lib/payment-accounts.ts`, `lib/manualPaymentCharge.ts`, `components/payment/PaymentCheckoutModal.tsx` + test | ninguna |
| T6 Integración (al final) | `whatsapp-bot.service.ts` (1 línea), spec, `MyPaymentsPage.tsx` (`?motivo=`), `csv.ts` | T4, B3 y la otra sesión commiteados |

Orden de commit: caracterización (T4 paso 0) → T2/T5 → T3 → T4 → T1 aplicada → T6. Commits con índice temporal (solo lo
propio), pushes agrupados.
