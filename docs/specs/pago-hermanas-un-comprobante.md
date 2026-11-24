# Un comprobante para varias hermanas + «monto recibido» en el registro manual

**Estado:** spec **aprobado con cambios** el 2026-11-23 (decisiones Q1–Q5 incorporadas, rev. 2). Sin código ni migraciones. Compuerta F0: **nada se aplica a la base compartida sin OK explícito**. Origen: soporte Dreamers (caso Emily Piñero Herrera, pago del 5-nov).
Relacionados: [`pago-multiple-y-acudiente-sin-cuenta.md`](pago-multiple-y-acudiente-sin-cuenta.md) §1.2, [`editar-pago-y-cierre-de-caja.md`](editar-pago-y-cierre-de-caja.md), [`cobros-multiples.md`](cobros-multiples.md).

---

## 0. Qué se verificó (base viva y gemelo, 2026-11-23)

1. **El saldo a favor solo nace en un camino:** el trigger `trg_payments_saldo_a_favor_al_aprobar` corre cuando un pago pasa de `awaiting_approval` a `paid` con comprobante y `ocr_amount` mayor al esperado. El registro manual (`register_manual_payments`, `RegisterCashPaymentModal`) pasa de `pending/overdue` a `paid`: **nunca dispara el trigger** y no existe campo «monto recibido».
2. **`register_manual_payments` ya admite un comprobante para varios cobros**, pero exige `v_athletes = 1` (`atletas_distintos`). Los campos OCR/huella solo se escriben en el primer cobro del grupo.
3. **Dedup vivo:** `uq_payments_school_receipt_hash` (excluye `rejected/cancelled/failed`) y `uq_payments_school_ocr_reference` (sin filtro de estado). La misma imagen en dos cobros vivos da 23505 cuando la huella llega calculada.
4. **Corrección previa:** el caso C2 del ensayo (saldo falso por hermana) usó filas sin huella ni referencia OCR; en producción con huella calculada no ocurre. El riesgo real es solo con huella y referencia **nulas** (ver §2.4, Q4).
5. **Emily (lectura de producción):** el pago `493e0ddd-7add-43f8-9e27-93e4c80268ce` es de $723.000, `cash`, sin comprobante, `payment_date` 2026-11-05, creado el 2026-11-15 en el cobro manual en lote `c3bc53c3-…` (`CYP-c3bc53c387d4-1`). **Ese lote contiene un solo pago (el de Emily)**; Emily no tiene `parent_id` ni vínculo en `school_sibling_links`, así que **el sistema no registra ninguna hermana** y no puede decir si la consignación cubría a otra niña.
6. El gemelo recibió el 2026-11-23 las migraciones `20261013165308`, `20261119164527` y `20261120143043` (solo gemelo). Ensayos: un comprobante enlazado a dos cobros → saldo 0; un cobro con $728.500 → saldo $5.500.

## 1. Qué se construye

### 1.1 Hermanas en el registro manual (Q1)
- En `RegisterCashPaymentModal`, al elegir una deportista con hermanas **vinculadas** (mismo `children.parent_id` o `school_sibling_links`) que tengan cobros `pending/overdue`, aparece «¿Este pago también es de sus hermanas?» con sus cobros y casillas sin marcar.
- Si una hermana no aparece, el modal ofrece un acceso para **vincularlas** con la RPC existente `link_siblings` (sin salir del flujo) y recargar la lista.
- Solo hermanas de una misma familia; nunca se mezclan familias.

### 1.2 «Monto recibido» y saldo a favor (Q2, Q3)
- Campo **Monto recibido**, precargado así: **con comprobante**, el monto que leyó el OCR (la pantalla marca la diferencia con la suma); **en efectivo**, la suma de los cobros.
- `excedente = monto_recibido − suma de los cobros del grupo`.
- **Recibido menor que la suma:** se bloquea, con el mensaje «Lo recibido es menor que lo que cubren estos cobros. Registra cada cobro con su abono».
- **Reparto del excedente (Q2):** en partes iguales **por deportista** (una hermana con dos cobros cuenta una vez), en pesos enteros; el residuo del redondeo va a la deportista con la que se abrió el registro (la «ancla»). Con una sola deportista, completo a ella.
- El aviso previo muestra el reparto: «Sobran $5.500: quedan $2.750 a favor de cada una».

### 1.3 Corrección de Emily (Q5) — sigue sin aplicarse
Solo cuando haya OK explícito y con el comprobante de la mamá a la vista. Pendientes de confirmar con Dreamers (ver §6):
- ¿La consignación cubría solo a Emily o también a una hermana? Si cubría a dos, los $5.500 van $2.750 a cada una (la hermana necesita un cobro pagado para colgar su ajuste, o se registra al hacerse su cobro); si era solo de ella, van completos.
- Si fue consignación y no efectivo, adjuntar el comprobante y corregir el método con el flujo de «editar pago». **Ese flujo no existe todavía** (spec sin construir), así que hoy esa corrección tendría que ser un ajuste manual con su propia aprobación.
- No se borra ni se edita el monto del pago del 5-nov.

## 2. Diseño técnico

### 2.1 RPC nueva `register_manual_payments_familia`
Parámetros: `p_school_id, p_payment_ids uuid[], p_method, p_payment_date, p_reference_base, p_receipt_url, p_receipt_fields, p_monto_recibido numeric, p_ancla_child uuid`.
- `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`; valida `is_school_admin(p_school_id)` y `school_is_operational` **adentro**, `FOR UPDATE` sobre los cobros, máximo 12, solo `pending/overdue`, una transacción. `REVOKE ALL … FROM PUBLIC, anon, authenticated` explícito y luego `GRANT EXECUTE … TO authenticated, service_role`.
- Valida que todas las deportistas pertenezcan a una misma familia de la escuela; si no, `familia_distinta`.
- **Cálculo explícito del excedente (cambio 1):** `p_monto_recibido − sum(amount)` de los cobros del grupo (menos el descuento por pronto pago ya aplicado en cada uno, como hace `_saldo_a_favor_registrar`). **No se llama a `_saldo_a_favor_registrar`** con «recibido − suma de los demás»: esa función ya resta lo cubierto por cobros con el mismo `receipt_url`, y en transferencia se restaría dos veces mientras que en efectivo no. La RPC inserta directamente los ajustes y el resultado es **idéntico en efectivo y en transferencia**.
- **Ajustes:** un `payment_adjustments(kind='saldo_a_favor')` **por deportista**, colgado de su primer cobro del grupo (el ajuste exige `payment_id`), con el mismo motivo y una referencia común `grupo_registro` (uuid determinista a partir de los ids de cobro ordenados), columna nueva nullable en `payment_adjustments`. En ese cobro `amount_paid = amount + parte`, igual que el comportamiento actual. Después llama a `_saldo_a_favor_consumir` por dueño para que el próximo cobro de cada hermana se descuente.
- **Idempotencia por grupo (cambio 2):** si todos los cobros del grupo ya están `paid` con el mismo `grupo_registro`, devuelve `ya_registrado` con el resultado anterior sin error y **sin crear ajustes nuevos**. Índice único parcial `(grupo_registro, payment_id) WHERE kind='saldo_a_favor'` como cinturón.
- Campos OCR/huella al primer cobro del grupo (como hoy); todos llevan el mismo `receipt_url`.
- Sin tocar la RPC viva. **Deuda técnica (cambio 5):** `register_manual_payments` debe terminar llamando a la nueva con una sola deportista para no mantener dos cuerpos iguales; queda fuera de este lote.

### 2.2 Frontend
`handleSaveMulti` pasa a la RPC nueva cuando hay hermanas marcadas o monto recibido declarado; sin eso, la ruta actual queda intacta. Búsqueda de hermanas por lectura acotada (`.in()`), sin N+1. El modal precarga el monto recibido según §1.2.

### 2.3 Traspaso de huella al anular (cambio 4)
Trigger sobre `payments` al pasar a `cancelled/rejected/failed`: si el cobro tiene `receipt_image_sha256` u `ocr_reference`, se **limpian en ese cobro y se pasan a otro cobro vivo que comparta su `receipt_url`**, en ese orden (`uq_payments_school_ocr_reference` no filtra por estado y chocaría si se copia antes de limpiar). Si no queda ninguno vivo, se liberan. Así el mismo comprobante no puede volver a subirse mientras algún cobro lo use.

### 2.4 Endurecimiento del trigger de saldo (Q4)
Migración aparte, versión simple: en `fn_payments_saldo_a_favor_al_aprobar`, si `receipt_image_sha256` **y** `ocr_reference` llegan nulos, **no se acredita saldo automático** y el pago queda marcado `requires_review = true` con el motivo en `notes`. Sin heurística por acudiente y monto. Supuesto a confirmar: «queda a revisión» = `requires_review`, porque el pago ya pasó a `paid` cuando el trigger corre.

### 2.5 Migraciones (una sesión a la vez)
A) RPC + columna `grupo_registro` + índice. B) Trigger de saldo (Q4). C) Traspaso de huella (§2.3). Cada una con `npm run migrations:new -- <slug>`, ledger commiteado, `search_path`, ACL explícita, sin `CREATE TYPE`.

## 3. Plan por fases (todo en `develop`)

| Fase | Qué | Compuerta |
|---|---|---|
| **F0** | Spec aprobado; **Emily: confirmar hermana, método y monto con el comprobante** | Tu OK explícito para cualquier escritura |
| **F1** | Migraciones A, B y C escritas y ensayadas en el gemelo (`psql -v ON_ERROR_STOP=1`, archivo propio con BEGIN/ROLLBACK; revisar primeras líneas antes de correr) | `npm run migrations:check`; revisión de ACL línea por línea |
| **F1b** | Aplicar a la base compartida por vía con rastro, **una sola sesión**, con tu OK; `types.ts` una vez al final | `npm run seguridad:invariantes`; `proacl` verificado |
| **F2** | Modal: hermanas, vincular, monto recibido, reparto, bloqueo | Vitest desde `C:\…` en mayúscula |
| **F3** | QA real en el gemelo y escuela de prueba | Pruebas de §4 |

No usar `list_tables` ni `get_advisors` como sondeo; consultar `pg_proc`/`pg_policies` por nombre.

## 4. Pruebas obligatorias
1. Dos hermanas, un comprobante, suma exacta → ambos `paid`, mismo `receipt_url`, saldo 0.
2. **Dos hermanas en efectivo, recibido +$5.500 → dos ajustes de $2.750, total $5.500.**
3. **Dos hermanas por transferencia, +$5.500 → mismo resultado que en efectivo.**
4. **Excedente impar $5.501 → $2.751 a la ancla y $2.750 a la otra.**
5. **Una hermana con dos cobros y otra con uno → reparto entre dos deportistas, no tres cobros.**
6. **Segunda llamada con el mismo grupo → `ya_registrado`, sin ajustes nuevos.**
7. **Comprobante con monto OCR distinto de la suma → el campo trae el OCR y la diferencia se ve antes de guardar.**
8. **Anular el cobro que guarda la huella y volver a subir el mismo comprobante → rechazo por duplicado; sin cobros vivos → se libera.**
9. **El siguiente cobro de cada hermana se descuenta con su parte del saldo.**
10. Cobros de dos familias distintas → `familia_distinta`, nada a medias.
11. Cobro ya `paid`, `cancelled` o de otra escuela → rechazo y rollback total.
12. Sin rol de admin de esa escuela y anónimo → 42501.
13. Dos administradores sobre el mismo cobro a la vez → uno gana, el otro `cobro_no_pagable`.
14. Efectivo con recibido mayor, una sola deportista (caso Emily) → saldo completo a ella.
15. Recibido menor que la suma → el modal no guarda y muestra el mensaje de abono.
16. Misma imagen dos veces → 23505 como hoy, con mensaje claro.
17. Huella y referencia nulas en el camino `awaiting_approval` → no acredita, queda `requires_review`.

## 5. Decisiones resueltas (2026-11-23)
Q1 solo hermanas vinculadas, con acceso para vincular · Q2 reparto igual por deportista, pesos enteros, residuo a la ancla, un ajuste por hermana con referencia de grupo · Q3 bloquear si recibido < suma · Q4 en este lote, migración aparte, versión simple · Q5 corregir Emily ya, tras confirmar.

## 6. Pendiente de ti / Dreamers
- ¿El pago de Emily cubría también a una hermana? El sistema no tiene ninguna vinculada. Si la hay, hay que vincularlas antes de repartir.
- ¿Fue consignación? Hoy `editar pago` no existe; ¿se deja el método como está con una nota, o se espera esa pantalla?
- Monto exacto del comprobante (la transcripción del audio es confusa).

## 7. F3 — prueba real en el gemelo (2026-11-24)
Modal real en el navegador (Playwright contra el gemelo, `frontend/e2e/pagos/hermanas-un-comprobante.spec.ts`), con las migraciones A/B/C ya aplicadas. 5/5 verdes, verificando después en la base del gemelo:
- Efectivo con $5.500 de más: las dos pagadas, dos ajustes de $2.750 con el mismo `grupo_registro` (pruebas 2 y 3 del §4, camino efectivo).
- Excedente impar $5.501: $2.751 a la hermana con la que se abrió y $2.750 a la otra (4).
- Suma exacta: sin saldo a favor (1).
- Recibido menor que la suma: botón bloqueado, mensaje de abono y nada escrito (15).
- El siguiente cobro de cada hermana recibe su descuento de $2.750 y no queda saldo suelto (9).
Notas: la familia sale solo de hermanas con **inscripción activa** (`_sibling_family`); la pantalla de Pagos pide el BFF para el listado, que el gemelo no levanta (toast «Error en suscripciones», ajeno a este cambio). Sin cubrir en navegador: transferencia con comprobante (subida de imagen), 8, 13, 16 y 17, que siguen probados solo por SQL.
