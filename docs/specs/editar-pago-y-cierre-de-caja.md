# Editar pago y Cierre de caja — plan

**Versión 0.2 · 2026-10-31 · Estado: decisiones D1–D4 confirmadas por el usuario; falta aprobar el
plan para construir. No hay nada construido.**

Dos piezas que se necesitan juntas: **Editar pago** para corregir un pago registrado a mano, y
**Cierre de caja** para que la recepción cuadre el efectivo del día. Van juntas porque la caja define
cuándo un pago en efectivo ya no se puede tocar.

---

## 0. Por qué

- **Caso origen (Dreamers, 31-oct).** A las 10:39 la cuenta de la escuela registró en Cobros y pagos
  una transferencia de $489.000 para Santiago Rodríguez Mesa, sin comprobante ni referencia
  (lote `2151e409…`). La persona dijo que había cancelado. No había cómo corregirlo desde pantalla:
  «Anular lote» solo anula cobros creados y sin pagar, y en la pantalla de «Listo» ni aparece cuando
  la operación solo registró un pago. Soporte lo devolvió a pendiente por SQL (nota en
  `payment_audit_logs`).
- **Volumen de octubre (pagados con fecha de pago en octubre):**

  | Escuela | Efectivo | Transferencias | Transferencias sin ningún soporte* |
  |---|---|---|---|
  | Dynasty | 68 | 201 | 6 |
  | GYM RM | 17 | 14 | **13** |
  | Besser | 12 | 21 | 2 |
  | Dreamers | 2 | 4 | 0 |

  \* sin comprobante, sin hash de imagen, sin referencia OCR y sin número de recibo.
- **Antecedentes:** `docs/plan-salida-ingresos-egresos-2026-10-02.md` H2 («las correcciones reescriben
  el pasado»: 77 `paid → cancelled` por SQL, sin actor), H3 («el cierre de mes no bloquea») y P0-3
  (pedía «Anular pago» con motivo para owner/admin). Este plan cubre P0-3 sin esperar a contabilidad v2.

---

## 1. Lo que ya existe (verificado contra la base el 2026-10-31)

| Pieza | Estado | Qué hacemos |
|---|---|---|
| `payment_corrections` (motivo, quién, valor antes/después, estado antes) | Viva; la usa «No asistió / cobros abiertos». `kind` ∈ `anulado_no_asistio`, `valor_cambio_plan` | **Reusar**: nuevo `kind = 'edicion_pago'` + columna `cambios jsonb` |
| `payment_audit_logs` + `audit_logs` (trigger) | Vivos; registran cada cambio de estado | Siguen igual |
| Trigger `guard_payment_invoiced` | Vivo: impide sacar de `paid` un pago con factura electrónica | Se respeta; el editor lo explica antes |
| `cash_sessions` / `cash_session_entries` | **0 filas.** Ninguna pantalla ni el BFF las usa | **Reusar** las tablas y rehacer sus policies y RPCs |
| `close_cash_session` / `get_cash_session_summary` | Sin gate de alcance adentro, `search_path=public`, EXECUTE solo `service_role` | **Reemplazar** (sin llamadores) |
| Policies de caja | `FOR ALL` sin `WITH CHECK` (viola **I3**) y escritura directa desde el cliente | Quitar escritura del cliente: solo RPC |
| `payments.cash_session_id` | Columna sin uso; el guard la bloquea para el cliente | **No se usa.** El vínculo vive en `cash_session_entries` |
| `monthly_closes` (Cierre de mes) | Vivo, es una foto: no bloquea escrituras | El editor **sí** lo respeta (§2.2) |
| `hour_bank_grants` (`payment_id`, `reverted_at/by/reason`) | Vivo; la venta de horas en Cobros y pagos suma minutos con su pago | El editor revierte la venta y la crea de nuevo con el valor corregido |

---

## 2. Editar pago

### 2.1 Qué se edita

Aplica a cobros **pagados o con abono**, registrados a mano (efectivo o transferencia).

| Campo | Ejemplo | Efecto |
|---|---|---|
| **Valor recibido** | Pagó $200.000, no $489.000 | Recalcula el estado: `0` → pendiente · menor que el cobro → abono parcial · igual → pagado. **Mayor que el cobro: se rechaza** en v1 (sin saldo a favor) |
| **Valor del cobro** | Vendió 2 horas y era 1 | Cambia `amount`. Si el cobro tiene **horas** asociadas, pide las horas nuevas (§2.3). Si el cobro tiene descuentos activos de Cobros y pagos, se rechaza: primero «Quitar descuento» |
| **Método** | Era efectivo, no transferencia | Mueve la entrada de caja (§3.2) |
| **Fecha del pago** | Pagó el 28, no hoy | ≤ hoy. Respeta el cierre de mes (§2.2) |
| **Referencia / comprobante** | Faltó subir el soporte | Mismo flujo de comprobante de Cobros y pagos (hash, OCR) |

Siempre lleva **motivo obligatorio** (máx. 500) y una **vista previa «antes → después»** antes de
guardar, con lo que arrastra: horas, vigencia y caja.

### 2.2 Cuándo NO se puede (se explica en la vista previa, no con un error crudo)

1. **Pago por pasarela** (`payment_channel = 'online'`, o con `wompi_*` / `provider_transaction_id`):
   la plata sí se movió; lo que corresponde es una devolución.
2. **Con factura electrónica emitida:** necesita nota crédito (ya existe el trigger que lo impide).
3. **Efectivo de una caja cerrada:** primero hay que reabrir la caja (§3.4).
4. **Mes cerrado:** si el mes del periodo del cobro **o** el mes de la fecha de pago está cerrado en
   `monthly_closes` (`scope='cobros'`), primero se reabre el mes (ya existe, con motivo). Así la
   corrección no cambia en silencio una cifra ya reportada (H2/H3).
5. **Horas ya usadas:** si bajar el valor quita horas que el atleta ya gastó.

### 2.3 Qué arrastra cada cambio

- **Horas:** si el pago tiene un `hour_bank_grants` vivo, se revierte (`reverted_at/by/reason`) y se
  crea uno nuevo con los minutos corregidos (`source = 'correccion'`), en la misma transacción. Si
  el saldo disponible del periodo no alcanza para quitar la diferencia, se bloquea (§2.2.5).
- **Vigencia:** si el cobro deja de estar pagado y es una mensualidad, con
  `enrollment_validity_mode = 'calendar_month_end'` la vigencia vuelve al último mes que sí está
  pagado. En modo `rolling` no se toca y la vista previa lo avisa.
- **Torniquete:** nada directo. Si el cobro queda pendiente y ya venció, el cron de mora lo pasa a
  vencido y ahí actúa el bloqueo de siempre (si la escuela lo tiene prendido).
- **Lote de Cobros y pagos:** no se toca; la corrección queda en el historial del pago. Desde
  `20261031121849` (sesión 2a, aplicada el 31-oct), el pago de un cobro que ya existía queda con
  `charge_batch_id` (antes `NULL`, como en el caso de Santiago). Así, «Ver detalle» del lote en
  Operaciones lo muestra, y ahí también debe verse la marca «corregido». `annul_charge_batch` sigue
  sin anular nada pagado.
- **Libro (`cash_ledger`):** es una vista sobre `payments`, así que el ingreso cambia en el mes donde
  estaba. Por eso el bloqueo 4. El reverso con fecha propia llega con contabilidad v2.

### 2.4 Quién

Solo **dueño o administrador de la escuela del pago** (`user_admin_school_ids()`), validado
**dentro** de la RPC contra el `school_id` del pago. Ni coach, ni recepción, ni familias. *(D3)*

### 2.5 Historial

`payment_corrections` con `kind='edicion_pago'`, `motivo`, `created_by`, `status_before`,
`amount_before/after` y `cambios` (`{campo: {antes, despues}}`). Se ve en el detalle del pago como
«Corregido el 31-oct por X: valor recibido $489.000 → $0. Motivo: …».

### 2.6 Dónde está el botón

- **Pantalla de «Listo» de Cobros y pagos**, cuando la operación registró pagos: «Corregir pago».
  Es donde la persona de Dreamers lo habría buscado.
- **Gestión de Pagos → Pagos recibidos** (antes «Historial», renombrada en b92d6f87): acción
  «Editar pago» en la fila.

---

## 3. Cierre de caja

### 3.1 Cómo lo vive la recepción

1. Registra pagos en efectivo como hoy (Cobros y pagos). **No hay paso de «abrir caja»**: el primer
   efectivo del día abre la caja de la sede sola. La base es lo que se dejó en la caja anterior. *(D2)*
2. Arriba de Gestión de Pagos ve una tarjeta: **«Caja de hoy · Sede X: $340.000 en efectivo (6 pagos)»**.
   El botón **«Cerrar caja»** solo le aparece al dueño o administrador. *(D4)*
3. Al cerrar: el dueño o administrador cuenta el efectivo, escribe **cuánto contó** y **cuánto deja de base para mañana**. El
   sistema muestra lo esperado (base + efectivo del día ± correcciones) y la diferencia. Si la
   diferencia no es cero, el **motivo es obligatorio**.
4. El resumen del cierre también lista, solo para revisar, las **transferencias registradas hoy sin
   ningún soporte**. Es la alerta que habría atrapado el caso de Santiago.

### 3.2 Qué entra a la caja

- Cada vez que un pago queda pagado o abonado **en efectivo**, se crea una entrada en
  `cash_session_entries` (`reference_table='payments'`) por **el valor que entró en ese momento**
  (un abono = su delta). Lo hace un trigger `SECURITY DEFINER` sobre `payments`, así cubre todos los
  caminos (Cobros y pagos y el modal viejo mientras exista), y toma un advisory lock por
  (escuela, sede, día) para no abrir dos cajas a la vez.
- **Correcciones:** si «Editar pago» cambia un efectivo de una caja **abierta**, se agrega una entrada
  `entry_type='correccion'` con el delta, que puede ser negativo. La entrada original no se borra.
- **Sede:** la del pago (`payments.branch_id`). Sin sede → caja general de la escuela. *(D1)*
- **Fuera de v1:** tienda, reservas y torneos en efectivo (las tablas ya los admiten; se suman después).

### 3.3 Cerrar

Solo dueño o administrador (`user_admin_school_ids()` sobre la escuela de la caja). El staff que
cobra ve la tarjeta y el total, pero no cierra. Queda quién cerró, a qué hora, lo contado, la base que se deja, la diferencia y
el motivo. Una caja cerrada no recibe más entradas: el siguiente efectivo abre una nueva. *(D4)*

### 3.4 Reabrir

Solo dueño o administrador, con motivo, y queda en el historial. Mientras está reabierta se pueden
corregir sus pagos en efectivo; al volver a cerrarla se cuenta otra vez.

### 3.5 Caja olvidada

Si la caja de un día no se cerró, el primer efectivo del día siguiente abre otra (las cajas son por
día) y la de ayer queda «pendiente de cierre», con un aviso en la tarjeta hasta que alguien la cierre.

---

## 4. Decisiones de producto

| # | Pregunta | Decisión |
|---|---|---|
| D1 | ¿Caja por sede o por persona? | **Por sede** (una gaveta por recepción) — confirmada 2026-10-31 |
| D2 | ¿Abrir caja con botón o sola? | **Sola**, con el primer efectivo del día — confirmada 2026-10-31 |
| D3 | ¿Quién edita pagos? | **Solo dueño/administrador** — confirmada 2026-10-31 |
| D4 | ¿Quién cierra y quién reabre? | **Solo dueño/administrador** las dos cosas — confirmada 2026-10-31 |
| D5 | Valor recibido mayor que el cobro | **Se rechaza** en v1 (sin saldo a favor) — propuesta |
| D6 | Diferencia al cerrar | Motivo **obligatorio** si ≠ $0 — propuesta |

---

## 5. Construcción (todo de corrido en `develop`)

### 5.1 Base de datos — una sola sesión aplica (regla de Disk IO)

Antes de cada `CREATE OR REPLACE`/`ALTER`: `to_regclass` y `md5(prosrc)` contra la base viva. Nada de
`IF NOT EXISTS` para objetos nuevos. Toda RPC nueva con
`SET search_path = pg_catalog, public, pg_temp`, `GRANT EXECUTE … TO authenticated`, sin `anon`.

**Migración A — `editar_pago`**
- `payment_corrections`: `kind` += `'edicion_pago'`; columna `cambios jsonb`.
- `preview_editar_pago(p_payment_id, p_cambios jsonb)` y
  `editar_pago(p_payment_id, p_cambios jsonb, p_motivo text, p_visto jsonb)`: `SECURITY DEFINER`,
  gate `school_id = ANY (user_admin_school_ids())`, `SELECT … FOR UPDATE` del pago, `p_visto`
  (`amount`, `amount_paid`, `updated_at`) para rechazar si alguien lo cambió mientras tanto. Aplica
  §2.1–2.3 en una transacción y escribe `payment_corrections`.

**Migración B — `caja_recepcion`**
- `cash_sessions`: `business_date date`, `base_siguiente numeric`, `difference_reason text`,
  `reopened_by/at`, `reopen_reason`; índice único parcial de caja abierta por
  (escuela, sede, día), con su variante `WHERE branch_id IS NULL`.
- `cash_session_entries`: `entry_type` += `'correccion'`; `amount <> 0` solo para `correccion`.
- Policies: se borran las `FOR ALL`; queda solo `SELECT` para `user_staff_school_ids()` y reporter.
  Escritura únicamente por RPC.
- Trigger `fn_caja_entrada_por_pago` (§3.2).
- RPCs: `caja_de_hoy(p_school_id, p_branch_id)`, `cerrar_caja(p_session_id, p_contado,
  p_base_siguiente, p_motivo, p_visto)`, `reabrir_caja(p_session_id, p_motivo)`,
  `cajas_historial(p_school_id, p_desde, p_hasta, p_branch_id)`. Se borran `close_cash_session` y
  `get_cash_session_summary`.

`types.ts` se regenera **una vez** al final del lote.

### 5.2 BFF

Mismo patrón que `charge-batches` (validación, errores con código, idempotencia por
`client_request_id`):
`POST /api/v1/payments/:id/edit/preview`, `POST /api/v1/payments/:id/edit`,
`GET /api/v1/caja/hoy`, `POST /api/v1/caja/:id/cerrar`, `POST /api/v1/caja/:id/reabrir`,
`GET /api/v1/caja/historial`. Documentados en el OpenAPI del BFF.

### 5.3 Frontend

- `EditarPagoDialog`: campos de §2.1, vista previa «antes → después», motivo, bloqueos explicados.
- `ResultScreen`: «Corregir pago» cuando `payments_registered > 0`.
- Gestión de Pagos → Pagos recibidos: acción «Editar pago». Detalle del pago y detalle del lote en
  Operaciones: historial de correcciones.
- `CajaDeHoyCard` arriba de Gestión de Pagos + `CerrarCajaDialog` + pestaña «Caja» con el historial
  de cierres y «Reabrir».
- Cobros y pagos, método efectivo: línea «Entra a la caja de hoy · Sede X».

### 5.4 Pruebas

- **Concurrencia (fase backend):** dos efectivos simultáneos abren **una** sola caja · cerrar
  mientras entra un pago (el pago cae en la caja nueva, no en la cerrada) · dos ediciones del mismo
  pago (la segunda falla por `p_visto`) · editar mientras se cierra la caja.
- **Seguridad:** coach, recepción/staff, padre y atleta reciben 42501 en las RPCs de editar, cerrar
  y reabrir · staff sí lee `caja_de_hoy` · `anon` sin
  EXECUTE · admin de la escuela A no edita pagos de la escuela B · `npm run seguridad:invariantes`
  limpio (I3 de caja cerrado).
- **Funcional (Playwright TS):** los casos de §2.1, cada bloqueo de §2.2, horas (2 → 1 con saldo y
  sin saldo), vigencia, cierre con diferencia, caja olvidada, reabrir y corregir.

---

## 6. Fuera de alcance

Reverso contable con fecha propia (contabilidad v2) · saldo a favor por pago de más · efectivo de
tienda, reservas y torneos en la caja · arqueo por denominación (billetes y monedas) · varias cajas
en la misma sede.
