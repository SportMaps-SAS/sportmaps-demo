# Plan: el veredicto del comprobante lo escribe solo el servidor

- **Fecha:** 2026-11-25 · **Estado:** PLAN (sin código, sin migración aplicada, sin commits)
- **Origen:** hueco verificado en la base viva el 2026-11-25. Una familia (acudiente o atleta adulto) escribe con su propia sesión `receipt_verdict`, `receipt_verdict_reasons`, `ocr_*` y `receipt_image_sha256` de su propio cobro.
- **Fuente de verdad:** la base. Todo lo marcado «(vivo)» se leyó con `npx supabase db query --remote --read-only` el 2026-11-25. Fueron consultas puntuales por nombre: no se listó el catálogo de funciones.

---

## 0. Resumen

1. **El hueco es más grave de lo que parecía.** Además de «Aprobar todos los verdes», el `ocr_amount` que escribe la familia alimenta el **saldo a favor automático** (`fn_payments_saldo_a_favor_al_aprobar`, lee `NEW.ocr_amount`). Con la aprobación automática encendida pasa sin que intervenga nadie. La familia sube un comprobante real por el valor exacto, que el servidor relee y aprueba. En la misma fila deja `ocr_amount` forjado hasta 4 veces lo debido y cualquier huella. `auto_approve_payment` no toca `ocr_amount`, así que el trigger acredita hasta 3 veces lo debido como saldo a favor, y `_saldo_a_favor_consumir` lo aplica a los cobros siguientes. Detalle en §1.3.
2. **No existe hoy ninguna columna que solo escriba el servidor** y que diga quién calculó el veredicto (§6.1). La mitigación sin migración es **pausar el lote** y **cerrar el saldo a favor en el camino automático** desde el BFF (§6.2).
3. **Arreglo de fondo:**
   - un endpoint del BFF «sellar comprobante» que, después de que la familia envía, lee el archivo **guardado**, calcula el veredicto con los datos **reales del cobro** y lo escribe con service role;
   - el frontend deja de mandar esos campos;
   - `fn_guard_payments_client` **ignora** (no rechaza) esas columnas para quien no administra la escuela. Así la PWA vieja sigue subiendo comprobantes sin error.
4. **Orden:** Paso 0 (hoy, solo código), BFF, frontend, migración, re-sellado de la cola y fin de la pausa (§5). Las decisiones que te tocan están en §9.

---

## 1. El hueco, verificado en la base

### 1.1 Qué hay vivo

| Pieza | Estado vivo (2026-11-25) |
|---|---|
| `fn_guard_payments_client` | Idéntica a `20261010144558_cobros_f1_guardia_y_notificaciones.sql`. SECURITY INVOKER, `search_path` fijo, ACL `{postgres, service_role}`. Detecta cliente con `current_user IN ('authenticated','anon')` y deja pasar todo al staff (`user_staff_school_ids()`, coaches incluidos). **No menciona ninguna columna `ocr_*` ni `receipt_*`.** |
| Trigger | `trg_zz_guard_payments_client BEFORE INSERT OR UPDATE ON payments FOR EACH ROW`. Antes, por orden alfabético, corren `trg_payments_receipt_review_columns`, `trg_updated_at`, etc. Después corren `trg_zzy_monto_cobro_cliente`, `trg_zzyz_payments_monto_servidor`, `trg_zzz_pronto_pago_servidor` y otros. |
| Policies de UPDATE | `Payments: update parent`: `parent_id = auth.uid() OR child_id IN (hijos de auth.uid())`. `Payments: update athlete`: `user_id = auth.uid()`. `Payments: update admin`: owner/admin/school_admin/super_admin; **coach no**. |
| Policies de INSERT | `insert parent` (`parent_id = auth.uid()`), `insert athlete` (`user_id = auth.uid()`), `insert staff` (`staff_school_ids()`; **coach sí**). |
| Privilegios de columna | `authenticated` tiene INSERT y UPDATE en las 20 columnas revisadas (`receipt_verdict*`, `ocr_*`, `receipt_image_sha256*`, `receipt_reference_norm`, `receipt_url`, `receipt_storage_bucket`, `receipt_submitted_at`). `anon`, ninguno. |
| Índices de dedup | `uq_payments_school_ocr_reference (school_id, ocr_reference)` y `uq_payments_school_receipt_hash (school_id, receipt_image_sha256)` sobre filas no terminales. **Los alimenta lo que manda el navegador.** |
| Precedente útil | `fn_payments_receipt_review_columns` (20261008165728) ya **conserva OLD** de `receipt_submitted_at` y de las columnas de rechazo cuando escribe un cliente. Es el mismo patrón que se propone aquí. |

### 1.2 Distribución de veredictos (vivo)

| Estado | verde | amarillo | rojo | Total |
|---|---|---|---|---|
| `awaiting_approval` | 17 (1 `client_original`, 16 `server_verified`) | 22 (7 / 15) | 2 (`server_verified`) | **41** |
| `paid` | 591 (310 `client_original`, 70 sin fuente, 211 `server_verified`) | 312 | 10 | **913** |
| `partial` | 4 | 5 | 1 | 10 |

`server_verified` lo pone hoy el bot (`estamparComprobante`) y el auto-approve cuando el hash real difiere. Pero **la familia también puede escribir ese valor**: no está bloqueado y no hay CHECK vivo que lo impida. Por eso no prueba nada.

Saldos a favor automáticos (`payment_adjustments.kind='saldo_a_favor'`), vivo: **42 créditos por $1.907.250**:

| Fuente de la huella | Créditos | Monto |
|---|---|---|
| `server_verified` | 31 | $1.732.750 |
| Sin fuente | 10 | $154.500 |
| `client_original` | 1 | $20.000 |

### 1.3 Quién se deja engañar por lo que escribe la familia

| Consumidor | Archivo | Qué hace con el dato | Gravedad |
|---|---|---|---|
| Saldo a favor al aprobar | trigger `fn_payments_saldo_a_favor_al_aprobar` (20261123123730:18-77) | Acredita `ocr_amount − saldo` si `ocr_amount ≤ 4×` y hay huella o referencia (las dos las pone la familia). Corre con **cualquier** aprobación: automática, de a uno o en lote. | **Crítica**: plata. Con auto-aprobación, sin humano. |
| Aprobación automática | `bff/src/services/receipt-approval.service.ts:188-322` | Relee con dos proveedores y decide bien, **pero no reescribe `ocr_amount`** antes de `auto_approve_payment` (:292). Con eso el trigger de arriba usa el monto forjado. | Crítica (vía saldo a favor) |
| Fallback sin re-lectura | `receipt-approval.service.ts:324-341` (`glosaFallback`) | Con la auto-aprobación apagada, PDF o archivo no descargable, decide con el veredicto guardado. Un rojo real convertido en verde o amarillo evita el rechazo automático. | Alta |
| «Aprobar todos los verdes» | `frontend/src/lib/receiptReview.ts:173-200` (`greenExclusion`, `bulkGreenSelection`), `frontend/src/components/payment/BulkApproveGreensDialog.tsx:48-62` | Entra al lote si `receipt_verdict='verde'` y `ocr_amount ≈ saldo`. Ninguno de los dos es confiable. | Alta |
| Resumen diario y Mapi | `bff/src/jobs/pagos-por-validar.job.ts:238-250` (`exclusionVerde`). `bff/src/services/mapi-agente/herramientas/pagos.ts:248-252, 572-573, 636` (`auditar_pendientes` propone «completo») | Cuentan e invitan a aprobar lo forjado. | Media |
| Hoja de aprobación de a uno | `ApprovePaymentMethodSheet.tsx:102` + `compareReceipt` | Muestra «sobra $X → saldo a favor» con el monto de la familia. El admin solo lo detecta si mira la foto. | Media |
| Dedup | índices `uq_payments_school_*` | La familia puede mandar huella o referencia NULL o inventada y reusar un comprobante. También puede «ocupar» la huella de otra (molestia). | Media |
| Conciliación | `bff/src/services/banco-correo-cruce.service.ts:91, 110, 124` (`ocr_date`, `ocr_origin_name`, `ocr_destination`). RPC de conciliación bancaria (20260723000001:151-157, `ocr_date`) | Desvía candidatos de cruce. Solo propone. | Baja |
| Cierre de la bandeja de WhatsApp | `wa_bandeja_cerrar_por_pago` (20261013165308:615) por huella o referencia | Puede cerrar un ítem ajeno de la bandeja. | Baja |

**Lo que NO está expuesto:** la decisión de auto-aprobar. `evaluatePaymentReceipt` re-descarga el archivo y exige dos lecturas coincidentes con monto exacto (`evaluarEvidenciaAutoAprobacion`, `receipt-verdict.ts:598-653`). El único escape es el saldo a favor de la fila 1.

---

## 2. Mapa

### 2.1 De dónde sale hoy el resultado del OCR del lado de la familia

```
FileUpload (validateReceipt)                frontend/src/components/common/FileUpload.tsx:133-154
  └─ useReceiptValidator.validate()         frontend/src/hooks/useReceiptValidator.ts:282-497
       ├─ sha256File(file)  (hash calculado por el navegador)                          :306-307
       └─ POST /api/v1/payments/extract-receipt                                         :314-323
            bff/src/routes/payments.routes.ts:551-643
            · auth: solo valida el JWT (:556-567); acepta cualquier schoolId/paymentId
            · extractReceipt(imageBase64) = OCR de LO QUE MANDÓ el navegador (:578)
            · hash = el que mandó el cliente; si no vino, el del base64 (:584-589)
            · veredicto con expectedAmount / paymentCategory / concept QUE MANDA EL CLIENTE (:595-609)
            · responde { ...ocr, verdict, verdictReasons, referenceNorm, imageSha256, imageSha256Source }
  └─ onValidationResult(result)
       ├─ ParentCheckoutPage:   setManualOcrResult   frontend/src/pages/ParentCheckoutPage.tsx:66 (FileUpload en :1115)
       └─ PaymentCheckoutModal: setOcrResult         frontend/src/components/payment/PaymentCheckoutModal.tsx:149, :1525
  └─ uploadFile(file) → payment-receipts/{uid}/{archivo}   frontend/src/hooks/useStorage.ts:37-66
       (payment-receipts NO se comprime: frontend/src/lib/imageCompression.ts:119-121)
```

Conclusión: aunque el cliente relayara honestamente, ese veredicto **no es del servidor** en el sentido que importa:

- se calcula con el monto esperado y la categoría que manda el navegador;
- se calcula sobre los bytes que mandó el navegador (en PDF, un PNG renderizado), no sobre el archivo que queda guardado;
- el hash es el que dice el cliente.

### 2.2 Todos los caminos que escriben esas columnas

**Familia y atleta adulto (navegador, `authenticated`). Son los que hay que cortar.**

| Camino | Archivo:línea | Qué escribe |
|---|---|---|
| QR / `/parent-checkout`: enlace al subir | `ParentCheckoutPage.tsx:103-113` (`linkReceiptOnUpload`) | Solo `receipt_url` y `status='awaiting_approval'`. Ninguna columna de OCR. |
| QR / `/parent-checkout`: confirmar | `ParentCheckoutPage.tsx:480-512` (`mutableFields`, OCR en :491-511), UPDATE :521-524, INSERT :526-541 | Las 11 `ocr_*` + `receipt_verdict`, `receipt_verdict_reasons`, `receipt_reference_norm`, `receipt_image_sha256`, `receipt_image_sha256_source`, `receipt_verdict_at` |
| Modal de pago (Mis pagos, Atleta, Torneos) | `PaymentCheckoutModal.tsx:963-984` (`receiptOcrFields`), UPDATE :987-996, INSERT :999-1020. Lo montan `MyPaymentsPage.tsx:807`, `MyPaymentsPageClassic.tsx:835`, `AthletePaymentsPage.tsx:503/528`, `athlete/v2/useAthleteCheckout.tsx:136`, `events/TournamentRegisterPage.tsx:327` | Las mismas |
| Mismo modal, Wompi y MercadoPago | `PaymentCheckoutModal.tsx:562` (insert pending Wompi), `:811`/`:826` (MercadoPago) | **Nada** de OCR (verificado) |
| Disparo posterior | `ParentCheckoutPage.tsx:570-572`, `PaymentCheckoutModal.tsx:1026-1028` → `POST /api/v1/payments/glosas/auto-evaluate` | Solo se dispara si el veredicto **del cliente** es verde o amarillo |
| Helper compartido | `frontend/src/lib/receiptOcrFields.ts:18-40` (`buildReceiptOcrFields`) | Lo usan solo caminos de admin (abajo). Las páginas de familia tienen el bloque duplicado. |

**Administración de la escuela (navegador o RPC). Queda permitido (ver §3.6).**

| Camino | Archivo:línea | Rol en la base |
|---|---|---|
| Registrar pago, un cobro | `RegisterCashPaymentModal.tsx:758-760` (UPDATE/INSERT directo con `buildReceiptOcrFields`) | `authenticated` (staff). Hoy pasa por el atajo de staff del guard. |
| Registrar pago, varios o hermanas | `RegisterCashPaymentModal.tsx:635-644` → RPC `register_manual_payments` / `register_manual_payments_familia` con `p_receipt_fields` (20261010180834:140-158, 20261123121346:196-214) | SECURITY DEFINER; exige owner o admin. El guard no aplica (`current_user` = dueño). |
| «Cobros y pagos» | `cobros-y-pagos/PaymentBlock.tsx:195` → `drafts.ts:104-124` (`paymentPayload.ocr`) → `lib/api/chargeBatches.ts:907` → `bff/src/services/charge-batches.service.ts:280` `create_charge_batch` → `_registrar_pago_en_cobro` (20261010144559:733-749) | service_role + `p_actor` |
| Aprobar | `frontend/src/lib/approvePayment.ts:147-150` | Solo `receipt_amount_confirmed*`, ninguna columna de OCR |
| Glosas y conciliación | `GlosaConciliationDialog.tsx:117-121`, `CreateGlosaDialog.tsx:46`, `bff/src/services/glosa.service.ts` | **Solo leen.** El admin no escribe veredicto ni `ocr_*` desde glosas ni conciliación. |

**BFF (service_role). Ya calcula en servidor; se mantiene y se amplía.**

| Camino | Archivo:línea |
|---|---|
| `estamparComprobante` (archivo + lectura + veredicto + `awaiting_approval`) | `bff/src/jobs/whatsapp-queue.job.ts:669-729` (23505 en :740-760). Lo usan el worker del bot (:808), la bandeja «por clasificar» del admin (`routes/whatsapp-por-clasificar.routes.ts:245, 310`), el enlace público `/p/:token` (`services/cobro-enlace-publico.service.ts:833`) y la recuperación/importador (`services/whatsapp-recuperacion.service.ts:908`) |
| Posible manipulación → amarillo | `receipt-approval.service.ts:158-171` |
| Hash real + `server_verified` | `receipt-approval.service.ts:228-237` (solo si difiere del que dijo el cliente) |
| Rechazo del comprobante (limpia hash y referencia) | RPC `reject_payment_receipt` (20261008165728:222-241), llamada desde `receipt-approval.service.ts:124` y desde el admin |

**Base (triggers y RPC SECURITY DEFINER; el guard no les aplica).** `fn_payments_huella_pasa_al_anular` (20261123155851: mueve la huella al anular). `wa_cubrir_cobros_con_comprobante` (solo service_role).

**Scripts con service role.** `bff/scripts/fusionar-fichas-duplicadas.ts`, `resolver-cobros-auditados.ts`, `_tmp_j4.ts`.

**Jobs (solo leen).**
- `pagos-por-validar.job.ts:433-470` (también lo usa Mapi);
- `receipt-review-alerts.job.ts:201-207` (cada 5 min);
- `resumen-cuentas.job.ts`;
- `whatsapp-payment-outcome.job.ts:283-287` (`receipt_amount_confirmed`).

No hay escritores en `supabase/functions`.

> Lo que no se verificó: funciones vivas fuera del repo (deriva) que escriban estas columnas. Buscarlas obliga a leer `prosrc` de las ~814 funciones, y eso es justo lo que la regla de Disk IO pide no hacer como sondeo. Las del repo están todas arriba. Las RPC que las escriben son SECURITY DEFINER, y el guard no las toca.

---

## 3. Diseño

### 3.1 Regla

La lectura del comprobante, su veredicto y su huella los escribe **solo**:

- el servidor (service_role o RPC SECURITY DEFINER); o
- la **administración** de esa escuela (`user_admin_school_ids()`: owner, admin, school_admin, super_admin y `schools.owner_id`).

Para cualquier otro cliente del navegador (acudiente, atleta, coach) la base **ignora** lo que mande. No da error.

Columnas, grupo A (lectura):
- `ocr_amount`, `ocr_currency`, `ocr_date`, `ocr_bank`, `ocr_reference`, `ocr_provider`, `ocr_destination`, `ocr_destination_name`, `ocr_origin_name`, `ocr_time`, `ocr_raw_response`;
- `receipt_verdict`, `receipt_verdict_reasons`, `receipt_verdict_at`;
- `receipt_reference_norm`, `receipt_image_sha256`, `receipt_image_sha256_source`.

Columnas, grupo B (valor confirmado por la escuela; decisión D3): `receipt_amount_confirmed`, `receipt_amount_confirmed_by`, `receipt_amount_confirmed_at`, `receipt_amount_change_reason`.

### 3.2 Por qué no escribir en `/extract-receipt`, al leer

La opción preferida del pedido es que el endpoint que hoy calcula el OCR escriba en el cobro. Así como está no sirve, por cuatro razones:

1. **En el alta no hay cobro todavía.** `ParentCheckoutPage` sin `payment_id` y `PaymentCheckoutModal` en modo crear insertan el cobro después del OCR.
2. **El OCR se hace al elegir el archivo, antes de confirmar.** La familia puede cambiar de archivo o abandonar.
3. **No ata lo leído con lo guardado.** `/extract-receipt` lee los bytes que manda el navegador, y el archivo se sube aparte. Si se escribiera «verde» al leer, una familia podría leer una imagen buena y guardar otra.
4. **El contexto lo pone el cliente**: `expectedAmount`, `paymentCategory`, `conceptKind`.

Por eso la escritura va en el **paso posterior al envío**, con el archivo ya guardado y el cobro real. Es el mismo endpoint de OCR, pero corrido sobre el archivo guardado. `/extract-receipt` queda como **vista previa**: sigue bloqueando rojo, fecha y monto en la pantalla de la familia y no escribe nada.

### 3.3 BFF: `POST /api/v1/payments/:id/sellar-comprobante` (nuevo)

Va en `bff/src/routes/payments.routes.ts`. `POST /api/v1/payments/glosas/auto-evaluate` (`glosas.routes.ts:149-162`) **delega** en él, porque la PWA instalada vieja sigue llamando a ese.

1. **Autenticación:** JWT liviano, igual que `getJwtUser` (las familias no son `school_members`). Rate limit propio de 10 por minuto, como `ocrLimiter`.
2. **Carga** del cobro con service role.
3. **Autorización, igual que las policies.**
   - Familia: `parent_id = uid`, o `user_id = uid`, o `child_id` de un hijo con `children.parent_id = uid`.
   - Admin: `is_school_admin(school_id)` / `user_admin_school_ids`.
   - Ojo: el chequeo actual de `/auto-evaluate` usa `destinatarioDelCobro` (`parent_id ?? user_id`). Con eso un cobro de la escuela con `parent_id` NULL y `child_id` del hijo da **403 silencioso**: se corrige aquí.
4. **Validación.**
   - `status = 'awaiting_approval'`.
   - `receipt_url` es una ruta relativa de `payment-receipts`.
   - Si llama la familia, la ruta empieza por `{uid}/`, que es donde la deja `useStorage.ts:47-49`.
5. **Lectura del archivo guardado.**
   - Descarga con service role, `sha256` de los bytes reales y tipo por firma (`tipoPorFirma`, `ocr.service.ts:309`).
   - **Una** lectura con `extractReceiptWithFallback(listConfiguredProviders(), …)`. OpenAI y Claude leen PDF.
   - Si no lee nadie, queda amarillo con un motivo de lectura fallida que no abra glosa, para que el barrido no reintente en bucle.
6. **Veredicto con los datos del cobro:** `buildVerdictContext(p.school_id, { referenceNorm, imageSha256: real, expectedAmount: montoEsperadoDelComprobante(p), paymentId: p.id, paymentCategory: p.payment_category, concept: p.concept })`, luego `evaluateVerdict`.
7. **Escritura** con `estamparComprobante(…, { estados: ['awaiting_approval'] })`, ampliado (§3.4) y con escritura optimista `.eq('receipt_url', path)`. Si la familia cambió el archivo en el medio, no se escribe nada: el archivo nuevo se sella en su propia llamada o en el barrido.
8. **Si choca con 23505** (referencia o imagen ya usada en la escuela), `reject_payment_receipt(p_reason_code => 'REFERENCIA_DUPLICADA', …)`, igual que el rojo automático: el cobro vuelve a pendiente y la familia recibe aviso (decisión D4). En la práctica solo pasa con carreras o clientes forjados, porque la vista previa ya bloquea los duplicados.
9. **Después** sigue `evaluatePaymentReceipt(id, { lecturaA })`, reutilizando la lectura del paso 5 como «lectura A». Así no se paga dos veces la primera lectura.
10. **Respuesta:** `{ verdict, action }`. Lo que ve la familia sigue siendo «recibido», nunca «aprobado».

**Idempotencia.**
- Antes de la migración: mapa en memoria `(paymentId, receipt_url)` por 10 minutos, más el rate limit.
- Después de la migración: se puede saltar la lectura si `receipt_image_sha256_source='server_verified'` y `receipt_verdict_at >= receipt_submitted_at`. Desde ahí la familia ya no puede escribir esas dos columnas.

**Costo.**
- Con auto-aprobación apagada: una lectura más por comprobante subido desde la app.
- Con auto-aprobación encendida: el total no cambia, porque la lectura del sellado reemplaza la lectura A.
- Optimización opcional (D6): caché en memoria de lo que leyó `/extract-receipt`, por **sha256 calculado por el servidor de los bytes recibidos**. Solo para imágenes, que se guardan sin comprimir y dan la misma huella. Nunca por la huella que declara el cliente, porque así se podría envenenar la caché.

### 3.4 BFF: `estamparComprobante` más completo

Hoy no escribe `ocr_currency`, `ocr_time`, `ocr_destination_name`, `ocr_raw_response` ni `receipt_reference_norm`. Con el guard, para las subidas de la app esas columnas quedarían en NULL. Se agregan, y sirven también para el bot.

### 3.5 BFF: `evaluatePaymentReceipt`

- **(Paso 0, ya.)** En el camino de auto-aprobación, **antes** de `auto_approve_payment` (`receipt-approval.service.ts:292`), escribir con service role la lectura del servidor: `ocr_amount`, `ocr_reference`, `ocr_date`, `ocr_destination` y el veredicto A, con `.eq('status','awaiting_approval')`. Eso cierra el saldo a favor forjado en el camino automático.
- Acepta una lectura previa (§3.3, paso 9).
- `glosaFallback` (:324-341) deja de confiar en el veredicto guardado para rechazar o glosar, salvo que lo haya sellado el servidor. Después del Paso 4, todo lo de la cola lo está.

### 3.6 Barrido de red de seguridad

Va dentro de `runReceiptReviewAlerts` (`receipt-review-alerts.job.ts:198`), que ya corre cada 5 minutos y ya lee la cola.

- **Selección:** cobros con `status='awaiting_approval'`, `receipt_url` presente, `receipt_verdict IS NULL` y `receipt_submitted_at < now() − 3 min`.
- **Acción:** sellar, como máximo 5 por corrida.
- **Dónde corre:** **solo con `NODE_ENV=production`**, igual que `pagosPorValidarActivo`. Los BFF comparten la base; el de dev tiene crons.

Cubre tres casos:
- la PWA vieja, que llama a `/auto-evaluate` solo si su veredicto local es verde o amarillo;
- fallos de red;
- familias que subieron y no confirmaron (`linkReceiptOnUpload`).

**Disk IO:** reusa la misma lectura de la cola (índice `idx_payments_awaiting_submitted`). Nada por fila salvo el sellado.

### 3.7 Frontend

- `ParentCheckoutPage.tsx:491-511` y `PaymentCheckoutModal.tsx:963-984`: quitar todas las columnas de OCR y veredicto del payload. Siguen `receipt_url`, `status`, `payment_method` y `payment_date`.
- Después de enviar una transferencia, llamar **siempre** a `sellar-comprobante`, con o sin veredicto local. Reemplaza `autoEvaluateGlosa` en `ParentCheckoutPage.tsx:570` y `PaymentCheckoutModal.tsx:1026`.
- El manejo de 23505 en el INSERT o UPDATE de la familia (`ParentCheckoutPage.tsx:546-566`, `PaymentCheckoutModal.tsx:1058`) deja de dispararse, porque huella y referencia ya no viajan. El duplicado lo informa la respuesta del sellado.
- `useReceiptValidator` y `FileUpload` no cambian: la vista previa sigue bloqueando.
- `receiptOcrFields.ts` queda **solo para administración**. Lo dice en su comentario.
- Cola del admin (`PaymentsAutomationPage.tsx`): opcionalmente, una etiqueta «Leyendo comprobante…» cuando `receipt_verdict IS NULL` y entró hace menos de 5 minutos.
- `greenExclusion` y `exclusionVerde` **excluyen `amount_source='cliente'`** (D8), como ya hace `auto_approve_payment`. El monto que eligió el navegador no se aprueba en lote. Hay que agregar `amount_source` al select (`PaymentsAutomationPage.tsx:886-902`, `pagos-por-validar.job.ts:433-434`).

### 3.8 ¿Puede escribirlo el staff?

- **Administración: sí.** Es la autoridad que aprueba. Sus caminos (registrar pago y cobros y pagos) dejan el cobro **pagado**: el veredicto es informativo, y la huella y la referencia alimentan el dedup.
- **Glosas y conciliación:** no escriben nada de esto (§2.2).
- **Coach: no (D2).** Hoy no puede hacer UPDATE (policy `update admin`), pero sí INSERT por `insert staff`. Con el atajo de staff del guard, un coach podría insertar un cobro `awaiting_approval` en verde que entraría al lote. Se le aplica la regla de la familia.
- **Platform admin global** (`profiles.role='admin'`): no está en `user_admin_school_ids()`. Desde el navegador se le ignorarían esas columnas; sus caminos reales son el BFF y los scripts.

---

## 4. Migración: `CREATE OR REPLACE` de `fn_guard_payments_client`

- **Crear con:** `npm run migrations:new -- veredicto_comprobante_solo_servidor`. No se crea en este plan.
- **Versión anterior:** `20261010144558` (cuerpo vivo idéntico, leído el 2026-11-25).
- **Sin cambio de esquema:** no se regenera `types.ts`.
- **Policies:** no se tocan. El guard es un trigger y aplica a todas las policies permisivas a la vez (trampa 1).
- **Por qué no `REVOKE UPDATE (col) FROM authenticated`:**
  1. el admin escribe desde el navegador;
  2. PostgREST rechazaría con 42501 **todo** el UPDATE de la PWA vieja y rompería la subida;
  3. trampa 3: los default privileges.

  Conservar OLD es lo que no rompe.
- **Funciones de alcance dentro del trigger:** no hace falta envolverlas en `(SELECT …)`. Esa regla es para policies, y un trigger evalúa una vez por fila de todas formas.
- **Privilegios:** el guard es SECURITY INVOKER, como el vivo. Invoca `user_admin_school_ids()`, que es SECURITY DEFINER con EXECUTE para `authenticated` (vivo). **No** tiene EXECUTE para `anon`: por eso solo se llama si `current_user = 'authenticated'`. Igual `anon` no tiene privilegios de escritura en `payments`.
- **EXECUTE de la función trigger:** no hace falta para quien dispara el trigger. Prueba viva: el ACL actual es `{postgres, service_role}` y las familias escriben hoy. Se re-emiten el `REVOKE` y el `GRANT` idénticos.

```sql
-- =============================================================================
-- <VERSION>_veredicto_comprobante_solo_servidor.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-xx   Versión anterior: 20261010144558
-- Spec: docs/specs/seguridad-veredicto-comprobante-plan.md
-- Objetivo: la lectura del comprobante (ocr_*), su veredicto (receipt_verdict*),
--   su huella (receipt_image_sha256*, receipt_reference_norm) y el valor que
--   confirmó la escuela (receipt_amount_confirmed*) solo los escriben el servidor
--   (service_role / RPC SECURITY DEFINER) y la administración de la escuela.
--   Para cualquier otro cliente del navegador (acudiente, atleta, coach) se
--   IGNORA lo que mande — sin error, para no romper la subida desde la PWA vieja:
--     · INSERT                        → NULL
--     · UPDATE que cambia receipt_url → NULL en la lectura (el servidor vuelve a
--                                        leer el archivo nuevo); el valor
--                                        confirmado conserva OLD
--     · UPDATE sin cambiar el archivo → OLD
--   CREATE OR REPLACE desde el cuerpo VIVO (pg_get_functiondef, 2026-11-25,
--   idéntico a 20261010144558). Cambios marcados «(veredicto servidor)».
-- Radio (base viva 2026-11-25, solo lectura):
--   · Escritores no-admin desde el navegador: ParentCheckoutPage y
--     PaymentCheckoutModal (cero después del deploy del frontend del plan).
--   · Escritores admin (siguen): RegisterCashPaymentModal (directo y RPC),
--     create_charge_batch (BFF). Escritores servidor (siguen): estamparComprobante,
--     receipt-approval, reject_payment_receipt, fn_payments_huella_pasa_al_anular.
--   · No modifica filas existentes. No toca policies ni columnas.
-- Precondición: BFF con /sellar-comprobante desplegado (si no, las subidas
--   nuevas de la app quedan sin lectura hasta que el BFF exista — ver §5 del spec).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_guard_payments_client()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
    v_open_states text[] := ARRAY['pending','overdue','partial','rejected','failed','awaiting_approval'];
    v_col text;
    v_admin boolean := false;        -- (veredicto servidor)
    v_archivo_nuevo boolean;         -- (veredicto servidor)
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    -- (cobros F1) Columnas que solo escriben las RPC de «Cobros y pagos», para
    -- TODO cliente del navegador (staff incluido).
    IF TG_OP = 'INSERT' THEN
        v_col := CASE
            WHEN NEW.charge_batch_id IS NOT NULL               THEN 'charge_batch_id'
            WHEN COALESCE(NEW.discount_amount, 0) <> 0         THEN 'discount_amount'
            WHEN COALESCE(NEW.late_fee_waived_amount, 0) <> 0  THEN 'late_fee_waived_amount'
            WHEN NEW.list_amount IS NOT NULL                   THEN 'list_amount'
        END;
    ELSE
        v_col := CASE
            WHEN NEW.charge_batch_id        IS DISTINCT FROM OLD.charge_batch_id        THEN 'charge_batch_id'
            WHEN NEW.discount_amount        IS DISTINCT FROM OLD.discount_amount        THEN 'discount_amount'
            WHEN NEW.late_fee_waived_amount IS DISTINCT FROM OLD.late_fee_waived_amount THEN 'late_fee_waived_amount'
            WHEN NEW.list_amount            IS DISTINCT FROM OLD.list_amount            THEN 'list_amount'
        END;
    END IF;
    IF v_col IS NOT NULL THEN
        RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: %', v_col USING ERRCODE = '42501',
            HINT = 'Descuentos, condonaciones y lotes solo se registran desde «Cobros y pagos».';
    END IF;

    -- (veredicto servidor) Lectura, veredicto y huella del comprobante: solo el
    -- servidor o la administración de la escuela. Al resto se le IGNORA (no se
    -- lanza error: la PWA instalada vieja sigue mandando estos campos al subir).
    -- Va ANTES del atajo de staff: un coach (staff sin administración) también
    -- cae aquí. user_admin_school_ids() no tiene EXECUTE para anon: solo se
    -- consulta con sesión.
    IF current_user = 'authenticated' AND NEW.school_id IS NOT NULL THEN
        IF TG_OP = 'INSERT' THEN
            v_admin := NEW.school_id = ANY (public.user_admin_school_ids());
        ELSIF OLD.school_id IS NOT DISTINCT FROM NEW.school_id THEN
            v_admin := NEW.school_id = ANY (public.user_admin_school_ids());
        END IF;
    END IF;

    IF NOT v_admin THEN
        IF TG_OP = 'INSERT' THEN
            v_archivo_nuevo := true;
        ELSE
            v_archivo_nuevo := NEW.receipt_url IS DISTINCT FROM OLD.receipt_url;
        END IF;

        IF v_archivo_nuevo THEN
            -- Archivo nuevo (o cobro nuevo): nada de lo que diga el navegador
            -- cuenta; el BFF lo lee del archivo guardado (/sellar-comprobante).
            NEW.ocr_amount                  := NULL;
            NEW.ocr_currency                := NULL;
            NEW.ocr_date                    := NULL;
            NEW.ocr_bank                    := NULL;
            NEW.ocr_reference               := NULL;
            NEW.ocr_provider                := NULL;
            NEW.ocr_destination             := NULL;
            NEW.ocr_destination_name        := NULL;
            NEW.ocr_origin_name             := NULL;
            NEW.ocr_time                    := NULL;
            NEW.ocr_raw_response            := NULL;
            NEW.receipt_verdict             := NULL;
            NEW.receipt_verdict_reasons     := NULL;
            NEW.receipt_verdict_at          := NULL;
            NEW.receipt_reference_norm      := NULL;
            NEW.receipt_image_sha256        := NULL;
            NEW.receipt_image_sha256_source := NULL;
        ELSE
            NEW.ocr_amount                  := OLD.ocr_amount;
            NEW.ocr_currency                := OLD.ocr_currency;
            NEW.ocr_date                    := OLD.ocr_date;
            NEW.ocr_bank                    := OLD.ocr_bank;
            NEW.ocr_reference               := OLD.ocr_reference;
            NEW.ocr_provider                := OLD.ocr_provider;
            NEW.ocr_destination             := OLD.ocr_destination;
            NEW.ocr_destination_name        := OLD.ocr_destination_name;
            NEW.ocr_origin_name             := OLD.ocr_origin_name;
            NEW.ocr_time                    := OLD.ocr_time;
            NEW.ocr_raw_response            := OLD.ocr_raw_response;
            NEW.receipt_verdict             := OLD.receipt_verdict;
            NEW.receipt_verdict_reasons     := OLD.receipt_verdict_reasons;
            NEW.receipt_verdict_at          := OLD.receipt_verdict_at;
            NEW.receipt_reference_norm      := OLD.receipt_reference_norm;
            NEW.receipt_image_sha256        := OLD.receipt_image_sha256;
            NEW.receipt_image_sha256_source := OLD.receipt_image_sha256_source;
        END IF;

        -- El valor que la ESCUELA confirmó al aprobar (approvePayment.ts:147-150).
        IF TG_OP = 'INSERT' THEN
            NEW.receipt_amount_confirmed     := NULL;
            NEW.receipt_amount_confirmed_by  := NULL;
            NEW.receipt_amount_confirmed_at  := NULL;
            NEW.receipt_amount_change_reason := NULL;
        ELSE
            NEW.receipt_amount_confirmed     := OLD.receipt_amount_confirmed;
            NEW.receipt_amount_confirmed_by  := OLD.receipt_amount_confirmed_by;
            NEW.receipt_amount_confirmed_at  := OLD.receipt_amount_confirmed_at;
            NEW.receipt_amount_change_reason := OLD.receipt_amount_change_reason;
        END IF;
    END IF;

    IF NEW.school_id IS NOT NULL
       AND NEW.school_id = ANY (public.user_staff_school_ids())
       AND (TG_OP = 'INSERT' OR OLD.school_id IS NOT DISTINCT FROM NEW.school_id) THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.school_id IS NULL
           OR NOT (
                NEW.school_id = ANY (public.user_school_ids())
                OR EXISTS (SELECT 1 FROM public.children c
                            WHERE c.parent_id = auth.uid() AND c.school_id = NEW.school_id)
           ) THEN
            RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: school_id' USING ERRCODE = '42501',
                HINT = 'Solo puedes registrar pagos en una escuela de la que eres miembro.';
        END IF;
        IF NEW.status NOT IN ('pending', 'awaiting_approval') THEN
            RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: status'
                USING ERRCODE = '42501',
                      HINT = 'Solo la escuela o la pasarela marcan un pago como pagado.';
        END IF;

        v_col := CASE
            WHEN COALESCE(NEW.amount_paid, 0) <> 0      THEN 'amount_paid'
            WHEN NEW.approved_at IS NOT NULL            THEN 'approved_at'
            WHEN NEW.approved_by IS NOT NULL            THEN 'approved_by'
            WHEN COALESCE(NEW.late_fee_amount, 0) <> 0  THEN 'late_fee_amount'
            WHEN NEW.late_fee_applied_at IS NOT NULL    THEN 'late_fee_applied_at'
            WHEN NEW.gross_amount IS NOT NULL           THEN 'gross_amount'
            WHEN NEW.sportmaps_fee IS NOT NULL          THEN 'sportmaps_fee'
            WHEN NEW.epayco_fee IS NOT NULL             THEN 'epayco_fee'
            WHEN NEW.wompi_transaction_id IS NOT NULL   THEN 'wompi_transaction_id'
            WHEN NEW.provider_transaction_id IS NOT NULL THEN 'provider_transaction_id'
            WHEN NEW.cash_session_id IS NOT NULL        THEN 'cash_session_id'
            WHEN NEW.reconciliation_status IS NOT NULL  THEN 'reconciliation_status'
            WHEN NEW.unblocked_at IS NOT NULL           THEN 'unblocked_at'
            WHEN NEW.unblocked_by IS NOT NULL           THEN 'unblocked_by'
            WHEN NEW.discount_pct IS NOT NULL           THEN 'discount_pct'
            WHEN NEW.list_amount IS NOT NULL            THEN 'list_amount'
            -- (cobros F1)
            WHEN COALESCE(NEW.sibling_discount_applied, 0) <> 0 THEN 'sibling_discount_applied'
            WHEN NEW.created_by IS NOT NULL             THEN 'created_by'
            WHEN NEW.notes IS NOT NULL                  THEN 'notes'
        END;
        IF v_col IS NOT NULL THEN
            RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: %', v_col USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status IN ('paid', 'glosado', 'cancelled')
       AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
        RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: status (cobro %)', OLD.status USING ERRCODE = '42501';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (NEW.status = 'awaiting_approval' AND OLD.status = ANY (v_open_states)) THEN
        RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: status (% -> %)', OLD.status, NEW.status
            USING ERRCODE = '42501';
    END IF;

    v_col := CASE
        WHEN NEW.amount                   IS DISTINCT FROM OLD.amount                   THEN 'amount'
        WHEN NEW.amount_paid              IS DISTINCT FROM OLD.amount_paid              THEN 'amount_paid'
        WHEN NEW.school_id                IS DISTINCT FROM OLD.school_id                THEN 'school_id'
        WHEN NEW.branch_id                IS DISTINCT FROM OLD.branch_id                THEN 'branch_id'
        WHEN NEW.offering_plan_id         IS DISTINCT FROM OLD.offering_plan_id         THEN 'offering_plan_id'
        WHEN NEW.team_id                  IS DISTINCT FROM OLD.team_id                  THEN 'team_id'
        WHEN NEW.child_id                 IS DISTINCT FROM OLD.child_id                 THEN 'child_id'
        WHEN NEW.parent_id                IS DISTINCT FROM OLD.parent_id                THEN 'parent_id'
        WHEN NEW.user_id                  IS DISTINCT FROM OLD.user_id                  THEN 'user_id'
        WHEN NEW.unregistered_athlete_id  IS DISTINCT FROM OLD.unregistered_athlete_id  THEN 'unregistered_athlete_id'
        WHEN NEW.coach_id                 IS DISTINCT FROM OLD.coach_id                 THEN 'coach_id'
        WHEN NEW.late_fee_amount          IS DISTINCT FROM OLD.late_fee_amount          THEN 'late_fee_amount'
        WHEN NEW.late_fee_applied_at      IS DISTINCT FROM OLD.late_fee_applied_at      THEN 'late_fee_applied_at'
        WHEN NEW.approved_at              IS DISTINCT FROM OLD.approved_at              THEN 'approved_at'
        WHEN NEW.approved_by              IS DISTINCT FROM OLD.approved_by              THEN 'approved_by'
        WHEN NEW.rejection_reason         IS DISTINCT FROM OLD.rejection_reason         THEN 'rejection_reason'
        WHEN NEW.gross_amount             IS DISTINCT FROM OLD.gross_amount             THEN 'gross_amount'
        WHEN NEW.sportmaps_fee            IS DISTINCT FROM OLD.sportmaps_fee            THEN 'sportmaps_fee'
        WHEN NEW.epayco_fee               IS DISTINCT FROM OLD.epayco_fee               THEN 'epayco_fee'
        WHEN NEW.payment_category         IS DISTINCT FROM OLD.payment_category         THEN 'payment_category'
        WHEN NEW.period_uniqueness_exempt IS DISTINCT FROM OLD.period_uniqueness_exempt THEN 'period_uniqueness_exempt'
        WHEN NEW.sibling_discount_applied IS DISTINCT FROM OLD.sibling_discount_applied THEN 'sibling_discount_applied'
        WHEN NEW.discount_pct             IS DISTINCT FROM OLD.discount_pct             THEN 'discount_pct'
        WHEN NEW.list_amount              IS DISTINCT FROM OLD.list_amount              THEN 'list_amount'
        WHEN NEW.due_date                 IS DISTINCT FROM OLD.due_date                 THEN 'due_date'
        WHEN NEW.concept                  IS DISTINCT FROM OLD.concept                  THEN 'concept'
        WHEN NEW.payment_type             IS DISTINCT FROM OLD.payment_type             THEN 'payment_type'
        WHEN NEW.provider_transaction_id  IS DISTINCT FROM OLD.provider_transaction_id  THEN 'provider_transaction_id'
        WHEN NEW.wompi_transaction_id     IS DISTINCT FROM OLD.wompi_transaction_id     THEN 'wompi_transaction_id'
        WHEN NEW.wompi_id                 IS DISTINCT FROM OLD.wompi_id                 THEN 'wompi_id'
        WHEN NEW.cash_session_id          IS DISTINCT FROM OLD.cash_session_id          THEN 'cash_session_id'
        WHEN NEW.reconciliation_status    IS DISTINCT FROM OLD.reconciliation_status    THEN 'reconciliation_status'
        WHEN NEW.requires_review          IS DISTINCT FROM OLD.requires_review          THEN 'requires_review'
        WHEN NEW.unblocked_at             IS DISTINCT FROM OLD.unblocked_at             THEN 'unblocked_at'
        WHEN NEW.unblocked_by             IS DISTINCT FROM OLD.unblocked_by             THEN 'unblocked_by'
        -- (cobros F1)
        WHEN NEW.created_by               IS DISTINCT FROM OLD.created_by               THEN 'created_by'
        WHEN NEW.notes                    IS DISTINCT FROM OLD.notes                    THEN 'notes'
        WHEN OLD.period_year  IS NOT NULL AND NEW.period_year  IS DISTINCT FROM OLD.period_year  THEN 'period_year'
        WHEN OLD.period_month IS NOT NULL AND NEW.period_month IS DISTINCT FROM OLD.period_month THEN 'period_month'
        WHEN NEW.status <> 'awaiting_approval'
             AND NEW.payment_date IS DISTINCT FROM OLD.payment_date THEN 'payment_date'
        WHEN NEW.status <> 'awaiting_approval'
             AND NEW.early_payment_discount_applied IS DISTINCT FROM OLD.early_payment_discount_applied
             THEN 'early_payment_discount_applied'
    END;
    IF v_col IS NOT NULL THEN
        RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: %', v_col USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$function$;

-- Privilegios vivos: postgres + service_role (CREATE OR REPLACE los conserva;
-- se re-emiten por claridad). Una función trigger no necesita EXECUTE para el
-- rol que dispara el trigger.
REVOKE ALL ON FUNCTION public.fn_guard_payments_client() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_guard_payments_client() TO service_role;

COMMIT;
```

Notas del SQL:

- Como el bloque pone los valores a OLD o NULL **antes** del chequeo `OLD.status IN ('paid','glosado','cancelled')`, un UPDATE de la PWA vieja que solo traía campos de OCR sobre un cobro pagado ya no revienta. Es más tolerante que hoy, y correcto.
- Los BEFORE triggers que corren después (`trg_zzy*`, `trg_zzyz*`, `trg_zzz*`) no escriben estas columnas.
- **Aplicación.**
  - Una sola sesión.
  - Por la vía con rastro, con OK explícito del usuario: `npx supabase db query --remote -f supabase/migrations/<archivo>.sql --yes -o json`, y luego `insert into supabase_migrations.schema_migrations …`.
  - **Nunca** `db push`.
  - Primero en el gemelo (`supabase_db_sportmaps-qa-twin`).
- **Verificación (solo lectura):**
  - `select prosrc ilike '%veredicto servidor%' from pg_proc where proname='fn_guard_payments_client'`;
  - `proacl` igual que antes;
  - `select pg_get_triggerdef(oid) from pg_trigger where tgname='trg_zz_guard_payments_client'`;
  - `npm run seguridad:invariantes`.

**Hallazgo lateral (D10, opcional en la misma migración).** La policy de storage `Parents can view own payment receipts via DB 18eicde_0` (viva) deja leer **cualquier** objeto de `payment-receipts` cuyo nombre coincida con el `receipt_url` de un cobro con `parent_id = auth.uid()`. Además, la policy de subida `Schools can upload payment receipts` no exige carpeta propia. Como `receipt_url` lo escribe libremente la familia, apuntarlo a la ruta de otro comprobante le da lectura de ese archivo. Explotarlo exige conocer la ruta, que es aleatoria, pero el hueco existe. Arreglo barato dentro del mismo bloque `IF NOT v_admin`: si cambia `receipt_url` y no empieza por `auth.uid()::text || '/'`, se conserva OLD. Ningún camino legítimo de la familia sube fuera de su carpeta (`useStorage.ts:47-49`).

---

## 5. Orden de despliegue y qué pasa entre pasos

Recordatorios: Render no tiene autodeploy (el deploy del BFF es manual). Los pushes a Vercel se agrupan por cupo.

| Paso | Qué | Estado del hueco al terminar | Qué ve cada quien |
|---|---|---|---|
| **0. Hoy, solo código** | Mitigación de §6.2 en frontend y BFF: pausa del lote, `amount_source='cliente'` fuera del lote, y en `evaluatePaymentReceipt` escribir la lectura del servidor antes de `auto_approve_payment` | **Cerrado:** saldo a favor forjado en la auto-aprobación, y aprobación en lote de verdes forjados. **Abierto:** la familia sigue escribiendo; aprobación de a uno con `ocr_amount` forjado (el admin ve «sobra $X» y debe mirar la foto). | Admin: «Aprobar todos los verdes» pausado con su motivo. El resumen diario dice «revísalos desde su fila». Mapi deja de proponer «completo». |
| **1. BFF** | `/sellar-comprobante`, `/auto-evaluate` que delega, `estamparComprobante` ampliado, barrido en `receipt-review-alerts` (solo prod) | La familia sigue escribiendo, pero el servidor **pisa** su lectura segundos después de enviar (frontend nuevo o PWA vieja con verde o amarillo) o en el barrido (los que llegan con veredicto NULL). Sin guard, una familia hostil puede re-escribir **después** del sellado: por eso el lote sigue pausado. | Sin cambio visible para la familia. El admin ve el veredicto del servidor. |
| **2. Frontend** (Vercel) | Quitar los campos de §3.7 y llamar siempre al sellado | El cliente nuevo no manda nada. La PWA instalada vieja sigue mandando todo; a partir del Paso 3 se ignora. | Para la familia, igual (la vista previa sigue). El admin, en la cola, ve «sin veredicto» o «Leyendo…» unos segundos. |
| **3. Migración** | Guard de §4 | **Cerrado en la base:** lo que mande la familia se ignora. La PWA vieja sube sin error. Un archivo nuevo queda sin lectura hasta el sellado. | Nada nuevo. |
| **4. Re-sellar la cola y fin de la pausa** | Script único del BFF con service role, en prod: sella los ~41 `awaiting_approval` con comprobante (unas 41 lecturas). Luego se levanta la pausa. Regla nueva del lote: verde **y** `receipt_image_sha256_source='server_verified'`, que desde el Paso 3 solo puede ser del servidor o del admin, **y** `amount_source <> 'cliente'`. | Cerrado, y los verdes de la cola son todos del servidor. | Vuelve «Aprobar todos los verdes». |
| **5. Retro-auditoría** | Re-leer los 42 saldos a favor (§8.3) y listar diferencias | Informe | La escuela revisa los casos marcados |

**¿Y si la migración va primero?** (D1)
- **Es segura:** no rompe la subida, porque ignora en vez de fallar.
- **Degrada** hasta que salga el BFF:
  - las subidas nuevas de la app quedan sin lectura ni veredicto (cola «sin veredicto»);
  - no hay glosa automática;
  - el dedup de la base no actúa en el camino de la familia (la vista previa sigue bloqueando duplicados en la pantalla);
  - la auto-aprobación sigue funcionando, porque relee el archivo, y el saldo a favor no se acredita con `ocr_amount` NULL.
- **Recomendación:** Paso 0 hoy y luego 1, 2 y 3 seguidos. Migración primero **solo** si el BFF se demora más de un día.

---

## 6. Mitigación inmediata sin migración

### 6.1 ¿Hay una marca que solo ponga el servidor?

**No.** Revisé cada candidata contra el código y la base viva:

| Candidata | ¿La escribe la familia? | ¿Sirve? |
|---|---|---|
| `receipt_verdict_at` | **Sí:** `receiptOcrFields.ts:38`, `ParentCheckoutPage.tsx:511`, `PaymentCheckoutModal.tsx:983` | No |
| `ocr_provider` | **Sí:** `receiptOcrFields.ts:25`, `ParentCheckoutPage.tsx:497`, `PaymentCheckoutModal.tsx:969` | No |
| `receipt_image_sha256_source = 'server_verified'` | Hoy manda `client_original`, pero **puede** mandar `server_verified`: no está bloqueado y no hay CHECK vivo que lo impida | No, hasta el Paso 3 |
| `ocr_raw_response` | **Sí** (:502 y :974) | No |
| `receipt_submitted_at` | No (trigger `fn_payments_receipt_review_columns` conserva OLD) | No dice quién leyó, solo cuándo entró |
| `amount_source` | No (trigger) | No habla del veredicto (sí sirve para D8) |
| `payment_audit_logs` | No (trigger) | Solo registra **cambios de estado**. Un verde forjado sin cambiar el estado no deja rastro. |
| `audit_logs` (trigger `trg_audit_payments`, guarda `auth.uid()` y la fila completa en cada escritura) | No | Sería la prueba correcta, pero pesa **61 MB / ~37 mil filas sin índice por `record_id`**. Consultarlo al abrir el diálogo o cada 5 min es un seq scan (choca con la regla de Disk IO), y por RLS solo lo lee el platform admin. Indexarlo es una migración. |

### 6.2 Propuesta (Paso 0, solo frontend y BFF, desplegable hoy)

1. **Pausar el lote** hasta el Paso 4. Hay que hacerlo en tres lugares:
   - `frontend/src/lib/receiptReview.ts`, `greenExclusion`: primera regla `if (!LOTE_VERDES_ACTIVO) return 'aprobación en lote pausada: revisa cada comprobante desde su fila'`. La constante va en un solo lugar.
   - `BulkApproveGreensDialog` y el botón de `PaymentsAutomationPage.tsx:1457/3407` muestran el motivo y quedan deshabilitados.
   - BFF `exclusionVerde` (`pagos-por-validar.job.ts:238`): la misma regla con `LOTE_VERDES_ACTIVO=false` por variable de entorno. Así el resumen diario y `auditar_pendientes` de Mapi dejan de invitar a aprobar en lote.

   La prueba de contrato entre los dos espejos se actualiza en los dos lados.
2. **Excluir `amount_source='cliente'`** del lote (D8). Queda también después de la pausa.
3. **Cerrar el saldo a favor en la auto-aprobación** (§3.5): reescribir `ocr_amount` y demás campos con la lectura A del servidor antes de `auto_approve_payment`. Es un cambio de pocas líneas en `receipt-approval.service.ts`.
4. **Riesgo que queda abierto hasta el Paso 3 (1 a 2 días):** aprobación **de a uno** de un cobro con `ocr_amount` forjado. La hoja muestra «sobra $X → saldo a favor». Aviso a los admins de Monster y Dynasty: si la hoja ofrece saldo a favor, mirar la foto antes de aprobar.

**Alternativa (D5) si el Paso 3 se demora más de 2 o 3 días:** un sello interino HMAC.
- El BFF guarda `ocr_raw_response._sello = HMAC(secreto, id|receipt_url|veredicto|ocr_amount|hash)` cada vez que escribe un veredicto.
- Un endpoint `POST /api/v1/payments/verdes-sellados {ids}` (solo admin) dice cuáles tienen sello válido, y el diálogo aprueba solo esos.
- La familia no puede forjar el HMAC ni moverlo a otra fila o archivo.
- Es más código para una ventana corta. Si la migración sale en 1 o 2 días, no se justifica.

---

## 7. Pruebas

### 7.1 SQL: la familia no puede cambiar el veredicto

Correr primero en el **gemelo** con psql:

```
docker exec -i supabase_db_sportmaps-qa-twin psql -U postgres -v ON_ERROR_STOP=1 -f - < prueba.sql
```

En producción solo con OK explícito: escribe aunque termine en ROLLBACK, porque los triggers disparan. Por la CLI no hay `\set`: hay que reemplazar los valores a mano. Para el gemelo, usar la escuela `00000000-0000-4000-b000-000000000001` y un acudiente, un hijo, un coach y un owner de ella.

```sql
\set escuela   '00000000-0000-4000-b000-000000000001'
\set acudiente '<uuid acudiente de prueba>'
\set hijo      '<uuid hijo de ese acudiente en la escuela>'
\set admin     '<uuid owner/admin de la escuela>'
\set coach     '<uuid coach activo de la escuela>'
\set pago      'a1000000-0000-4000-8000-0000000000a1'

BEGIN;

-- Fixture como postgres (el guard no aplica): cobro por validar con lectura del servidor.
INSERT INTO public.payments (id, school_id, child_id, parent_id, amount, concept, status, due_date,
       payment_type, payment_category, receipt_url, receipt_verdict, receipt_verdict_reasons,
       receipt_verdict_at, ocr_amount, ocr_reference, receipt_image_sha256, receipt_image_sha256_source)
VALUES (:'pago', :'escuela', :'hijo', :'acudiente', 150000, 'Prueba guardia veredicto', 'awaiting_approval',
       current_date, 'one_time', 'otro', :'acudiente' || '/prueba-a.png', 'amarillo',
       '[{"code":"MONTO_DIFIERE","level":"amarillo"}]', now(), 100000, 'PRUEBA-REF-A1',
       repeat('a', 64), 'server_verified');

-- ── Familia ───────────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'acudiente', 'role', 'authenticated')::text, true);

-- T1: forjar verde + monto + huella + valor confirmado, sin cambiar el archivo
UPDATE public.payments
   SET receipt_verdict = 'verde', receipt_verdict_reasons = '[]', receipt_verdict_at = now() + interval '1 day',
       ocr_amount = 400000, ocr_reference = 'FORJADA', receipt_image_sha256 = repeat('b', 64),
       receipt_image_sha256_source = 'server_verified', receipt_amount_confirmed = 400000
 WHERE id = :'pago';
SELECT 'T1 conserva lo del servidor' AS caso,
       (receipt_verdict = 'amarillo' AND ocr_amount = 100000 AND ocr_reference = 'PRUEBA-REF-A1'
        AND receipt_image_sha256 = repeat('a', 64) AND receipt_amount_confirmed IS NULL) AS ok
  FROM public.payments WHERE id = :'pago';

-- T2: cambiar el archivo borra la lectura (el servidor debe volver a leer)
UPDATE public.payments SET receipt_url = :'acudiente' || '/prueba-b.png', receipt_verdict = 'verde', ocr_amount = 150000
 WHERE id = :'pago';
SELECT 'T2 archivo nuevo = sin lectura' AS caso,
       (receipt_verdict IS NULL AND ocr_amount IS NULL AND receipt_image_sha256 IS NULL
        AND receipt_verdict_at IS NULL AND ocr_reference IS NULL) AS ok
  FROM public.payments WHERE id = :'pago';

-- T3: INSERT con veredicto → entra, sin lectura
INSERT INTO public.payments (school_id, child_id, parent_id, amount, concept, status, due_date, payment_type,
       payment_category, receipt_url, receipt_verdict, ocr_amount, receipt_image_sha256)
VALUES (:'escuela', :'hijo', :'acudiente', 50000, 'Prueba guardia insert', 'awaiting_approval', current_date,
       'one_time', 'otro', :'acudiente' || '/prueba-c.png', 'verde', 50000, repeat('c', 64))
RETURNING 'T3 insert sin lectura' AS caso,
          (receipt_verdict IS NULL AND ocr_amount IS NULL AND receipt_image_sha256 IS NULL) AS ok;

-- T4: la PWA vieja (todo junto con status/receipt_url) NO recibe error
UPDATE public.payments
   SET status = 'awaiting_approval', receipt_url = :'acudiente' || '/prueba-b.png', payment_method = 'transfer',
       receipt_verdict = 'verde', ocr_amount = 150000, ocr_raw_response = '{"x":1}'
 WHERE id = :'pago';
SELECT 'T4 PWA vieja sin error' AS caso, (receipt_verdict IS NULL AND ocr_amount IS NULL) AS ok
  FROM public.payments WHERE id = :'pago';
RESET ROLE;

-- ── Coach (staff sin administración) ─────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'coach', 'role', 'authenticated')::text, true);
INSERT INTO public.payments (school_id, child_id, amount, concept, status, due_date, payment_type,
       payment_category, receipt_url, receipt_verdict, ocr_amount)
VALUES (:'escuela', :'hijo', 50000, 'Prueba guardia coach', 'awaiting_approval', current_date,
       'one_time', 'otro', :'coach' || '/prueba-d.png', 'verde', 50000)
RETURNING 'T5 coach insert sin lectura' AS caso, (receipt_verdict IS NULL AND ocr_amount IS NULL) AS ok;
RESET ROLE;

-- ── Administración: sí escribe ───────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);
UPDATE public.payments SET ocr_amount = 150000, receipt_verdict = 'verde' WHERE id = :'pago';
SELECT 'T6 admin escribe' AS caso, (ocr_amount = 150000 AND receipt_verdict = 'verde') AS ok
  FROM public.payments WHERE id = :'pago';
RESET ROLE;

-- ── Servidor (BFF) ───────────────────────────────────────────────────────
SET LOCAL ROLE service_role;
UPDATE public.payments SET receipt_verdict = 'rojo', ocr_amount = 1 WHERE id = :'pago';
SELECT 'T7 service_role escribe' AS caso, (receipt_verdict = 'rojo' AND ocr_amount = 1) AS ok
  FROM public.payments WHERE id = :'pago';
RESET ROLE;

ROLLBACK;
```

Todas las filas tienen que salir con `ok = t`. Además:

- **T8:** `reject_payment_receipt` sigue limpiando la huella. Corre como dueño.
- **T9:** contra el guard **actual**, T1 y T3 salen `f`. Es la prueba de que la prueba detecta el hueco: correrla antes de aplicar.

### 7.2 PostgREST con usuarios reales

Agregar un caso «M5 veredicto» a `scripts/pruebas-blindaje-dinero.mjs`. Ese script ya crea usuarios y escuelas desechables, hace login real y prueba contra PostgREST.

- Un PATCH del acudiente con `receipt_verdict='verde'` y `ocr_amount` responde 204 y la fila no cambia.
- Un PATCH con `receipt_url` nuevo deja la lectura en NULL.
- Un INSERT con veredicto entra sin veredicto.

Antes de la migración el caso debe fallar con el mensaje «guard de veredicto no aplicado», igual que hoy detecta «M2 no aplicada».

### 7.3 BFF (vitest)

- **`sellar-comprobante.test.ts`:**
  - autorización: `parent_id`, `user_id`, hijo del usuario con `parent_id` NULL (hoy daba 403), ajeno 403, admin OK;
  - `receipt_url` fuera de la carpeta de la familia → 422;
  - el veredicto se calcula con `montoEsperadoDelComprobante(p)` y `p.payment_category`, **no** con lo que manda el cliente;
  - 23505 → `reject_payment_receipt`;
  - `receipt_url` cambiado en el medio → no escribe;
  - lectura fallida → amarillo sin glosa.
- **Regresión del saldo a favor:** fila con `ocr_amount` forjado a 3 veces lo debido; después de `evaluatePaymentReceipt` con auto-aprobación, `ocr_amount` es igual a la lectura A **antes** de llamar a `auto_approve_payment`. Va en `receipt-approval.pronto-pago.test.ts` o en un archivo nuevo.
- **`estamparComprobante`** escribe las columnas agregadas (§3.4).
- **Barrido:** solo con `NODE_ENV=production`, máximo 5 por corrida, solo `receipt_verdict IS NULL` y más de 3 minutos.
- **Actualizar:** `pagos-por-validar.job.test.ts` (pausa y `amount_source`), `receipt-approval.*.test.ts`, `seguridad-llm-extract-receipt.poc.test.ts` (el endpoint sigue sin escribir).

### 7.4 La subida sigue funcionando de punta a punta (e2e en el gemelo)

Spec nuevo `frontend/e2e/pagos/familia-sube-comprobante.spec.ts` (`npx playwright test -c playwright.gemelo.config.ts e2e/pagos`), con el patrón de `hermanas-un-comprobante.spec.ts`:

- **(a)** Familia → Mis pagos → `PaymentCheckoutModal` → transferencia → subir imagen fixture, con `/extract-receipt` simulado → Enviar. El cobro queda `awaiting_approval` con `receipt_url`, y el BFF local, con OCR simulado, lo sella: el veredicto y `ocr_amount` son los del servidor.
- **(b)** Igual por `/parent-checkout?payment_id=…` (QR), incluido `linkReceiptOnUpload` sin confirmar: el barrido lo sella.
- **(c)** PWA vieja: `page.request.patch` a PostgREST con el payload viejo completo responde 204, con los campos ignorados y el comprobante adjunto.
- **(d)** Forja: PATCH con verde después del sellado no cambia nada.

### 7.5 «Aprobar verdes» no toma un verde forjado

- **Unidad** (`frontend/src/test/receiptReview.test.ts`, `approvePaymentProntoPago.test.ts`):
  - con la pausa, `bulkGreenSelection` devuelve `eligible=[]` con el motivo;
  - sin la pausa, un verde sin `server_verified` o con `amount_source='cliente'` queda excluido.
- **e2e (d) + diálogo:** sembrar un cobro verde **forjado por la sesión de la familia**. Abrir «Aprobar todos los verdes» como owner y comprobar que no está en la lista. Después del Paso 3 ni siquiera es verde.

### 7.6 Verificación después de cada deploy (solo lectura, prod)

- Ningún `awaiting_approval` con comprobante y `receipt_verdict IS NULL` de más de 10 minutos (el barrido funciona).
- Después del Paso 4, todos los `awaiting_approval` con veredicto tienen `receipt_image_sha256_source='server_verified'`.
- `npm run seguridad:invariantes` limpio.

---

## 8. Radio de impacto

### 8.1 Pantallas

| Pantalla | Cambio |
|---|---|
| Checkout de la familia (`ParentCheckoutPage`; `PaymentCheckoutModal` en Mis pagos, Atleta, Torneos) | Ninguno visible. La vista previa sigue bloqueando rojo, fecha y monto. El mensaje sigue siendo «recibido». |
| Validación de cobros (`PaymentsAutomationPage`) | Las subidas de la app aparecen unos segundos «sin veredicto» o «Leyendo…» hasta el sellado. El veredicto mostrado es el del servidor. |
| «Aprobar todos los verdes» | Pausado del Paso 0 al Paso 4. Después, solo verdes del servidor y sin monto elegido por el navegador. |
| Hoja «Aprobar cobro» y `compareReceipt` | Usa la lectura del servidor. El saldo a favor ya no se infla con datos de la familia. |
| Glosas (`GlosaConciliationDialog`, `CreateGlosaDialog`) | Motivos del servidor |
| Resumen diario «Pagos por validar» y Mapi | Texto de la pausa. Luego, cuentas sobre verdes del servidor. |
| Registrar pago y Cobros y pagos (admin) | **Sin cambio.** El admin sigue escribiendo lectura y huella. |
| Bot de WhatsApp y enlace público `/p/:token` | Sin cambio (ya era del servidor). Gana las columnas de §3.4. |

### 8.2 Costo

- **OCR:** una lectura más por comprobante de la app cuando la escuela no tiene auto-aprobación, más unas 41 lecturas una sola vez (Paso 4) y unas 42 de la retro-auditoría.
- **Disk IO:** el barrido reusa la lectura de la cola que ya hace `receipt-review-alerts`. No hay consultas nuevas por minuto.

### 8.3 Datos viejos con veredicto del cliente: ¿se recalculan?

| Grupo | Filas (vivo) | Propuesta |
|---|---|---|
| `awaiting_approval` con veredicto | 41 (17 verde, 22 amarillo, 2 rojo) | **Sí, re-sellar todos** (Paso 4). Es la cola que puede aprobarse en lote. |
| `paid` con veredicto | 913 (`client_original` 510, sin fuente 72, `server_verified` 331) | **No.** El veredicto ya no decide nada en un cobro pagado. Re-leer ~900 comprobantes cuesta y no cambia la operación. |
| `partial` | 10 | No |
| Saldos a favor automáticos | 42 créditos, $1.907.250 (31 `server_verified` $1.732.750; 10 sin fuente $154.500; 1 `client_original` $20.000) | **Sí, auditar.** Re-leer el archivo de los 42, comparar la lectura del servidor con el `ocr_amount` guardado y listar diferencias de más de 0,5 %. Aunque diga `server_verified`, puede venir de la app, porque la familia puede escribir ese valor. Reversar solo a mano, con la escuela; nunca en automático. |

Consulta base de la retro-auditoría (solo lectura):

```sql
select a.payment_id, p.school_id, a.amount as saldo_a_favor, p.ocr_amount, p.amount,
       p.early_payment_discount_applied, p.receipt_image_sha256_source, p.receipt_url, a.created_at
  from public.payment_adjustments a
  join public.payments p on p.id = a.payment_id
 where a.kind = 'saldo_a_favor' and a.origin = 'saldo_a_favor'
 order by a.created_at;
```

---

## 9. Decisiones para ti

| # | Decisión | Recomendación |
|---|---|---|
| **D1** | Orden: BFF, frontend, migración (sin degradación, 1 a 2 días) o **migración primero hoy** (cierra ya, pero la cola de la app queda sin lectura, sin glosa automática y sin dedup en la base hasta que salga el BFF) | Paso 0 hoy, y 1, 2 y 3 seguidos. Migración primero solo si el BFF se demora más de un día. |
| **D2** | ¿El coach puede escribir lectura y veredicto (hoy sí, por el atajo de staff)? | **No.** Se le aplica la regla de la familia. Puede insertar cobros, y un verde suyo entraría al lote. |
| **D3** | Incluir `receipt_amount_confirmed*` en el guard | **Sí.** Hoy ningún escritor que no sea admin las usa. |
| **D4** | Duplicado detectado al sellar (23505): ¿rechazo automático del comprobante (`reject_payment_receipt`, como el rojo) o dejarlo en rojo para la escuela? | Rechazo automático, consistente con el rojo del servidor |
| **D5** | Mitigación interina: **pausa total del lote** hasta el Paso 4, o sello HMAC | Pausa. HMAC solo si la migración se demora más de 2 o 3 días. |
| **D6** | Lectura extra por subida, o caché por huella del servidor de lo que leyó `/extract-receipt` | Lectura extra primero. La caché, después, si el costo lo pide. |
| **D7** | Retro-auditoría de los 42 saldos a favor: ¿se revisan con cada escuela? | Sí, como informe. Sin reversión automática. |
| **D8** | Excluir `amount_source='cliente'` de «Aprobar todos los verdes» | **Sí**, igual que `auto_approve_payment` |
| **D9** | Aviso a los admins (Monster, Dynasty) mientras dura el Paso 0: «si la hoja ofrece saldo a favor, mira la foto» | Sí, por el canal de siempre |
| **D10** | Hallazgo lateral: `receipt_url` libre más la policy de storage «via DB» da lectura de comprobantes ajenos. ¿Se cierra en la misma migración (conservar OLD si la ruta no es de la carpeta propia)? | Sí. Es barato y ningún camino legítimo lo usa. |
