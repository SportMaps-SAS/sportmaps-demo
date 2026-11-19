# Pasarela Bold (API de Link de pagos) y adaptador de proveedores

Estado: PROPUESTA v2, sin aprobar, sin código ni migraciones. Fecha: 2026-11-18.
Origen: Monster cobra hoy con un link ABIERTO de Bold (`payment_link` en `payment_accounts`, memoria
`project_monster_link_bold_2026_11_18`). El recibo de Bold no trae cuenta destino, queda «Por validar» y alguien lo
confirma a mano en el panel de Bold. Meta: que el pago se concilie solo, y que sumar la siguiente pasarela sea escribir
UN adaptador y no copiar otro webhook de 1.000 líneas.

> Cambio frente a la v1 (hallazgo al leer el código): **Mercado Pago ya es una segunda pasarela en producción y tiene su
> propia copia de `handleSchoolPayment`** (`routes/mercadopago.ts:413`, 1.070 líneas) al lado de la de Wompi
> (`routes/wompi.ts:448`, 1.116 líneas). El patrón vigente es «un router por pasarela que duplica el núcleo». Bold sería la
> tercera copia. Por eso la Fase 1 no es «extraer Wompi» sino **unificar las dos copias existentes en un núcleo** con
> pruebas de caracterización de ambas, y Bold entra ya sobre el núcleo.

## 1. Lo que Bold ofrece (leído en developers.bold.co el 2026-11-18)

| Tema | Hecho | Fuente |
|---|---|---|
| Crear link | `POST https://integrations.api.bold.co/online/link/v1`, encabezado `Authorization: x-api-key <llave de identidad>` (sin Bearer) | /pagos-en-linea/api-link-de-pagos |
| Cuerpo | `amount_type` OPEN\|CLOSE; si CLOSE, `amount{currency,total_amount,tip_amount,taxes[]}`; `reference` (alfanumérico, `_`, `-`, máx. 60); `description` 2–100; `expiration_date`; `callback_url` https; `payment_methods` [CREDIT_CARD, PSE, BOTON_BANCOLOMBIA, NEQUI]; `payer_email` | idem |
| Respuesta | `payload.payment_link` = `LNK_…`, `payload.url` = `https://checkout.bold.co/LNK_…` | idem |
| Consultar link | `GET /online/link/v1/{payment_link}`; estados ACTIVE, PROCESSING, PAID, REJECTED, CANCELLED, EXPIRED; trae `transaction_id`, `payment_method`, `reference`, `is_sandbox` | idem |
| Webhook | Se configura por COMERCIO en el panel (Integraciones → Webhooks, hasta 5 URL https). Eventos SALE_APPROVED, SALE_REJECTED, VOID_APPROVED, VOID_REJECTED. Formato CloudEvents; `data.payment_id`, `data.amount.total`, `data.metadata.reference`, `data.integration='LINK'` | /webhook |
| Firma | `x-bold-signature` = HMAC-SHA256 hex de `base64(cuerpo crudo)` con la llave secreta (la de «Botón de pagos»). En pruebas el secreto es cadena vacía | /webhook |
| Entrega | Responder 200 en ≤ 2 s. Reintentos a 15 min, 1 h, 4 h, 8 h, 24 h. Puede haber duplicados y hasta 10 min de retraso | /webhook |
| Pruebas | Llaves de prueba distintas de las de producción, por comercio; en pruebas NO se envían webhooks salvo el botón «Probar el webhook». Tarjeta aprobada 4111111111111111 | /ambiente-pruebas |

### 1.1 Huecos que se cierran en sandbox (Fase 0), no con suposiciones
1. `expiration_date`: el texto dice nanosegundos, los ejemplos traen 13 dígitos (milisegundos).
2. `data.metadata.reference` en el webhook: la tabla dice «el `LNK_`», un ejemplo trae la referencia propia (`WEB-ORD-009876`).
   Si trae el `LNK_`, se busca por `provider_link_id`; si trae la propia, por `provider_reference`. El código soporta ambas.
3. Un link abierto creado en el PANEL (el de Monster hoy): la doc no dice si su webhook trae algo que lo identifique.
   No se depende de él; el link abierto es respaldo manual.
4. Activación de llaves de producción (`/api-de-pagos-en-linea/activacion`, certificación): NO se leyó. Se lee al arrancar F0.
5. Comisión: solo hay una cifra de un tercero sin verificar («desde 2,99 % + $900»). No se decide nada con ella.
6. ¿El webhook llega con `integration='LINK'` también cuando el link nació por API? (afecta el filtro del evento).

## 2. Diseño

### 2.1 Estado actual del código (verificado 2026-11-18)
| Pieza | Hoy |
|---|---|
| Webhook Wompi | `routes/wompi.ts`: valida checksum con `events_secret` de la escuela dueña de la referencia, re-consulta la transacción a la API, rutea por prefijo (`SCH`, `CART`, `RSV`…) a `HANDLERS`. `handleSchoolPayment` busca `payment_links.wompi_reference`, idempotencia por `payment_splits.wompi_transaction_id`, ganchos de autopay y de pago parcial. |
| Webhook Mercado Pago | `routes/mercadopago.ts`: misma forma; `handleSchoolPayment` busca `provider_reference`, idempotencia por `provider_transaction_id`, escribe `payment_provider: 'mercadopago'`. Usa `p_wompi_reference` de RPCs con semántica «provider_reference». |
| Cuerpo crudo | Ya existe: `app.use(express.json({ verify }))` guarda `req.rawBody` (`index.ts:328`). **No hace falta `express.raw`** (corrige la v1). |
| Enum | `payment_provider` = `('wompi','mercadopago')` (migración `20260504000001`). Bold exige `ADD VALUE 'bold'`. |
| Reproceso | `webhook-reprocess.service.ts:43` `routeStoredEvent`: ramas `wompi` y `mercadopago`; cualquier otro proveedor devuelve null y se reintenta sin fin. |
| Cobro público | `cobro-enlace-publico.service.ts:313` `pasarelaParaCobro` pide `resolveProvider({preferredProvider:'wompi'})` y descarta todo lo que no sea Wompi; `prepararCheckoutDeCobro` (:559) firma el checkout de Wompi al vuelo y no guarda la URL. |
| Bot / estado de cuenta | `conEnlacesDePago` (`whatsapp-enlaces-de-pago.service.ts:120`) pide el link con monto a través de `prepararCheckoutDeCobro`. |
| Pruebas existentes | `wompi.doble-pago.test.ts`, `mercadopago.pago-parcial.test.ts`, `payment-provider.resolver.test.ts`, `wompi-link-con-monto.service.test.ts`, `wompi-llave-checkout.guard.test.ts`. Son la base de la caracterización. |

### 2.2 Adaptador por pasarela
Carpeta `bff/src/services/pasarelas/` con un archivo por proveedor (`wompi.ts`, `mercadopago.ts`, `bold.ts`) y un `index.ts` que devuelve
el adaptador por `PaymentProvider`:

```ts
interface AdaptadorPasarela {
  id: PaymentProvider;
  /** Crea (o reabre) el cobro y devuelve la URL a la que va la familia. */
  crearCobro(c: CobroACobrar, creds: Creds): Promise<{ url: string; referenciaProveedor: string; linkId?: string; venceEn: Date }>;
  /** Firma del webhook con el secreto DE LA ESCUELA, sobre el cuerpo crudo. */
  validarWebhook(raw: Buffer, headers: Headers, creds: Creds): boolean;
  /** Evento del proveedor → evento común. */
  normalizarEvento(body: unknown): EventoPago | null;
  /** Consulta autoritativa: el webhook avisa, la API confirma. */
  consultar(ref: { linkId?: string; txId?: string }, creds: Creds): Promise<EstadoCobro>;
}
interface EventoPago {
  eventId: string;            // idempotencia (webhook_events)
  referencia: string;         // SCH-… (o el LNK_ si la pasarela solo trae ese)
  estado: 'aprobado' | 'rechazado' | 'anulado' | 'pendiente' | 'otro';
  idTransaccion: string;
  montoCOP: number;
  metodo: 'card' | 'pse' | 'transfer' | 'other';
}
```

**Núcleo común** `aplicarPagoDeCobro(evento, link, ctx)` (en `services/pagos-en-linea.core.ts`): lo que hoy hacen las dos
`handleSchoolPayment`: validar monto contra `gross_amount` (±1), conciliar contra `base_amount`, `payments` → paid/partial,
`payment_links` → paid, `payment_splits`, notificaciones, doble pago → `flag_payment_for_review`, ganchos de autopay.

Reglas de la unificación (no negociables):
- **Cero cambio de conducta** en Wompi y Mercado Pago. Las pruebas de caracterización se escriben ANTES y deben pasar idénticas DESPUÉS.
- Los handlers de prefijos que no son `SCH` (tienda, reservas, torneos, marketplace) NO se tocan.
- Las rutas `/webhooks/wompi` y `/webhooks/mercadopago` siguen existiendo con su URL (están configuradas en los paneles de las pasarelas).
  Solo su `handleSchoolPayment` pasa a delegar en el núcleo.
- Si la unificación de MP y Wompi resulta con diferencias que no se pueden reconciliar sin cambiar conducta, el núcleo
  recibe una función de «política» por proveedor y se anota la diferencia; no se «arregla» en silencio.

### 2.3 Datos (mínimo)
- **Migración A** (SOLA, sin nada más, una sola sesión): `ALTER TYPE public.payment_provider ADD VALUE IF NOT EXISTS 'bold'`.
  Postgres no deja usar un valor de enum nuevo en la misma transacción que lo crea.
- **Migración B**: `payment_links` gana `provider_link_id text` y `checkout_url text` (la URL de Bold se crea por API y hay que poder
  reabrirla sin crear otro link). Índice por `provider_link_id` donde no sea null.
  Plantilla de migración: `npm run migrations:new -- <slug>`; RPCs nuevas con `SET search_path` y `GRANT EXECUTE` explícito (CLAUDE.md).
- Sin columnas `bold_*`: Bold usa las genéricas que ya usa Mercado Pago (`provider_reference`, `provider_transaction_id`, `payment_provider`)
  en `payments`, `payment_links` y `payment_splits`.
- `payments_payment_method_check` (`pse|card|transfer|cash|other`): CREDIT_CARD→card, PSE→pse, NEQUI/BOTON_BANCOLOMBIA→other.
- Secretos de Bold en `payment_provider_secrets` (AES-256-GCM existente): llave de identidad → `access_token_enc`, llave secreta →
  `events_secret_enc`. Sandbox y producción no se mezclan (`sandbox` boolean).
- `webhook_events.provider` es texto libre: Bold entra sin migración.
- Un solo `payment_links` pendiente por cobro (índice único existente): Bold y Wompi se excluyen entre sí; ya está contemplado el 23505.
- Ninguna migración se aplica desde agentes en paralelo (regla de Disk IO). `types.ts` se regenera UNA vez al final de A+B.

### 2.4 Flujo de pago con Bold
1. La familia abre `/p/:token` (o el bot manda el link). `pasarelaParaCobro` deja de estar fija a Wompi: usa `resolveProvider` de la escuela y
   el adaptador que corresponda. Fail-closed: sin proveedor resuelto no hay botón.
2. `crearCobro` Bold: `POST /online/link/v1`, `amount_type: CLOSE`, `total_amount = gross_amount`, `reference = SCH-…` (la misma que hoy),
   `callback_url = /p/:token`, vence en 72 h (unidad según F0), `payer_email` si se conoce. Se guarda `provider_link_id` y `checkout_url`.
   Si ya hay un link pendiente con el mismo `base_amount` y `fee_pct`, se reabre el existente (misma regla que Wompi).
3. Webhook `POST /api/v1/webhooks/bold`: toma `req.rawBody`, lee la referencia, resuelve la escuela por `payment_links`, valida `x-bold-signature`
   con el secreto de ESA escuela (`timingSafeEqual`), registra en `webhook_events` (`eventId = <payment_id>:<tipo>`), **responde 200 de inmediato**
   (límite de 2 s de Bold) y procesa en segundo plano. Antes de marcar pagado, `consultar` el link: debe decir PAID con el mismo monto.
4. Falla o evento huérfano → `reprocessOrphanWebhooks` con rama `bold` (consulta el link y reaplica).
5. Recargo online: DECIDIDO (D1) 6 % a cargo de quien paga (padre o deportista) por Bold. Mecánica igual que hoy (`school_settings.online_fee_pct`, gross = base + fee, tolerancia ±1); Monster queda con `online_fee_pct = 6`. Ojo: es un valor por ESCUELA, no por pasarela; si Monster usa dos pasarelas en línea a la vez el 6 % les aplica a ambas (hoy Monster solo tendría Bold). Si alguna vez hace falta un % distinto por pasarela, va como tarea aparte (columna por proveedor).
6. VOID_APPROVED: queda registrado y marcado para revisión humana; no revierte plata solo en esta entrega.

### 2.5 Qué hay que generalizar (hoy está fijo a Wompi)
Unión `PaymentProvider` y sus copias (`webhook-events.service.ts:18`, `payment-providers.routes.ts:302/428`, `reservation-payments.service.ts:30`,
`store-checkout.ts:176`); `enLinea.proveedor: 'wompi'` y `ResultadoIniciar.provider` en `cobro-enlace-publico.service.ts`; `pasarelaParaCobro` y
`prepararCheckoutDeCobro`; `conEnlacesDePago`; `routeStoredEvent`; textos del bot que dicen «Wompi»; `PaymentProvidersAdmin` (formulario de 2 llaves para Bold).
Tienda, reservas, torneos y marketplace NO entran: Bold arranca solo con cobros de escuela (`SCH-`).

### 2.6 Seguridad
- Firma sobre cuerpo crudo con `timingSafeEqual`; sin firma válida → 401 y no se toca nada.
- El webhook no es la verdad: se confirma con la API de Bold antes de mover plata.
- Llaves de sandbox rechazadas con `sandbox=false` (y a la inversa), como Wompi rechaza `pub_test_`. Webhook de sandbox en el BFF de producción: ignorado.
- Las llaves de Monster las carga un admin de plataforma desde `PaymentProvidersAdmin`. **Nunca por el chat, ni en archivos, ni en `.env` del repo.**
- Fail-closed: escuela sin Bold conectado no cae a ninguna llave de ENV.
- Monster queda en `payment_mode = 'direct'` con su fila `bold` conectada; se verifica su modo actual en la base antes de mover nada.
- Cada pieza nueva con SECURITY DEFINER: `search_path` fijo y `GRANT EXECUTE` explícito; correr `npm run seguridad:invariantes` si se toca RLS.

## 3. Plan por fases
Todo de corrido en `develop` (sin ramas por fase). `main` y `staging` solo cuando el usuario lo pida. Cada fase cierra con su criterio de salida;
no se pasa a la siguiente sin cumplirlo. Commits solo de lo propio (`git commit --only`), revisando `.git/index.lock` y que haya otras sesiones.

### F0 — Verificación en sandbox (sin código de producto) · bloqueada por las llaves
- Entradas: llaves de PRUEBA de Monster (D3). Leer la página de activación de producción de Bold.
- Trabajo: script de lectura **fuera del repo** (scratchpad), llaves por variable de entorno del shell, nunca en archivo:
  crear link CLOSE; probar `expiration_date` en ms y ns; consultar el link; disparar «Probar el webhook» y capturar el cuerpo y la firma;
  confirmar qué trae `metadata.reference`; comprobar `integration`.
- Salida: §1.1 cerrada con evidencia (cuerpos reales con datos sensibles quitados) y este spec corregido. Decisión de si la referencia es `LNK_` o `SCH-`.
- Criterio de salida: los 6 huecos tienen respuesta, o quedan documentados como «se resuelve con el primer cobro real» con su mitigación.

### F1 — Núcleo común (sin Bold, sin migración) · se puede hacer YA
- 1.1 Pruebas de caracterización de `handleSchoolPayment` de Wompi y de Mercado Pago, ampliando `wompi.doble-pago.test.ts` y
  `mercadopago.pago-parcial.test.ts`: pago exacto, pago parcial, monto distinto (400), doble pago, idempotencia por split, link vencido,
  link inexistente, rechazado, autopay, recargo. Se confirma que pasan sobre el código ACTUAL.
- 1.2 Crear `services/pagos-en-linea.core.ts` + `pasarelas/{index,wompi,mercadopago}.ts` con la interfaz de §2.2; las dos `handleSchoolPayment`
  delegan en el núcleo.
- 1.3 Las mismas pruebas de 1.1 pasan SIN modificarlas. Cualquier prueba que haya que tocar se explica en el commit.
- Criterio de salida: batería de pruebas del BFF en verde igual que antes, diff de rutas legible, sin cambios de esquema, Wompi y MP intactos.
- Riesgo: Dynasty cobra por Wompi. Mitigación: es refactor puro; se valida en develop con un cobro de prueba sandbox antes de pedir main.

### F2 — Base de datos y llaves · UNA sola sesión aplica
- 2.1 Plan de migraciones A y B revisado línea por línea por el usuario (regla «plan antes de código en migraciones»).
- 2.2 Migración A (enum) y, aparte, B (columnas). Inventario con `npm run migrations:list`, gate `migrations:check`, ledger commiteado.
- 2.3 `payment-provider.resolver` y `upsert_school_provider` aceptan `bold`; esquema zod de `payment-providers.routes.ts` con la variante Bold
  (identidad + secreta, validación de sandbox/producción); `PaymentProvidersAdmin` con formulario Bold.
- 2.4 Regenerar `types.ts` una sola vez.
- Criterio de salida: se puede guardar una conexión Bold cifrada para Monster (sin activarla), y el resolver la devuelve; nada cambia para las otras escuelas.

### F3 — Cobrar con Bold
- 3.1 `pasarelas/bold.ts` `crearCobro` y `consultar`, con cliente HTTP con timeout, reintento acotado y errores sin filtrar la llave en logs.
- 3.2 `pasarelaParaCobro`/`prepararCheckoutDeCobro` por adaptador; reapertura del link por `provider_link_id`.
- 3.3 `enLinea.proveedor` y `ResultadoIniciar.provider` generalizados; frontend `/p/:token` y estado de cuenta rotulan por proveedor (ya existe `textoBotonLinkDePago`).
- 3.4 Textos del bot sin «Wompi» fijo; la batería `qa:embudo` no debe bajar.
- Pruebas: vitest con el HTTP de Bold simulado (crear, reabrir, error 4xx/5xx, monto con recargo, link vencido, índice único 23505).
- Criterio de salida: en sandbox, un cobro de escuela genera su link Bold con el monto bruto y la familia lo abre desde `/p/:token`.

### F4 — Conciliar
- 4.1 `pasarelas/bold.ts` `validarWebhook`/`normalizarEvento`; ruta `/api/v1/webhooks/bold` registrada ANTES de los parsers que pidan sesión,
  usando `req.rawBody`, respuesta 200 inmediata y proceso en segundo plano.
- 4.2 Consulta autoritativa antes de pagar; idempotencia por `webhook_events`; rama `bold` en `routeStoredEvent`.
- 4.3 Pruebas: firma buena y mala, duplicado, monto distinto, doble pago, link vencido, evento huérfano que luego aparece su link,
  VOID_APPROVED, sandbox en producción, secreto vacío en sandbox, cuerpo sin referencia.
- Criterio de salida: en sandbox, el evento de prueba de Bold marca pagado un cobro de punta a punta (con el webhook disparado a mano desde el panel).

### F5 — Monster en producción
- 5.1 Llaves de producción cargadas por un admin de plataforma desde la pantalla; webhook configurado en el panel de Bold apuntando al BFF de producción.
- 5.2 Verificar `payment_mode` de Monster en la base; pasar a `direct` solo con OK del usuario.
- 5.3 Primer cobro real de monto bajo con una persona de Monster; verificar en base: `payments`, `payment_links`, `payment_splits`, `webhook_events`.
- 5.4 Según D2: retirar el link abierto de `payment_accounts` o dejarlo de respaldo; actualizar el texto del bot.
- 5.5 Memoria y documentación: actualizar `project_monster_link_bold_2026_11_18` y agregar la guía «cómo sumar otra pasarela» a `docs/`.
- Criterio de salida: un pago de Monster por Bold queda «Pagado» sin intervención humana, y el recibo ya no cae a «Por validar».

## 4. Riesgos
- **Regresión en Wompi/Dynasty o MP al unificar el núcleo.** Mitigación: F1 es refactor puro con pruebas de caracterización previas.
- **Disk IO / una sola base:** una sola sesión aplica A y B juntas, `types.ts` se regenera una vez, sin `list_tables`/`get_advisors` como sondeo.
- **Webhook sin sandbox automático:** el primer cobro real prueba el camino completo; por eso la consulta autoritativa y el monto bajo en F5.
- **Recargo 6 %:** lo asume quien paga; el monto que ve la familia (base + 6 %) debe quedar claro en `/p/:token`, en el bot y en el estado de cuenta, y el recibo de Bold mostrará el bruto. La tarifa real de Bold no está verificada: si el 6 % no cubre la comisión, Monster pierde la diferencia; verificar con el contrato de Iván antes de F5.
- **Respuesta en 2 s:** si el procesamiento bloquea, Bold reintenta y duplica; por eso 200 inmediato y trabajo en segundo plano con idempotencia.
- **Un solo webhook por comercio en Bold:** si Monster ya usa webhooks para otra cosa, hay que convivir (hasta 5 URL).
- **Llaves en claro:** solo por la pantalla de admin; nunca por chat, archivos o repo.

## 5. Decisiones (con propuesta por defecto; falta el OK del usuario)
| | Pregunta | Propuesta |
|---|---|---|
| D1 | Recargo online de Monster con Bold | **DECIDIDO (usuario, 2026-11-18): 6 %, lo asumen los padres o deportistas que pagan por este medio.** Se fija `online_fee_pct = 6` para Monster en F5 (con OK, no antes). |
| D2 | Link abierto actual | Dejarlo como respaldo hasta que haya 2–3 cobros reales conciliados; luego retirarlo. |
| D3 | Llaves | Las crea Iván Sossa en el panel de Bold; las carga un admin de plataforma. Prueba primero, producción después de F4. |
| D4 | Alcance | Solo cobros de escuela (`SCH-`). Tienda, reservas, torneos y marketplace después. |
| D5 | Métodos de pago | Todos (tarjeta, PSE, Nequi, Bancolombia) salvo que Monster pida limitar. |
