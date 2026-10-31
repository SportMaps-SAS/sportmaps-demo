# Cambio de plan y cobros abiertos («No asistió»)

Estado: construido 2026-10-29 · Migraciones `20261029161649_cobros_abiertos_no_asistio_y_cambio_plan` + `20261029190004_cobros_abiertos_tabla_propia_y_quitar_policy` + `20261031105601_cobros_abiertos_solo_de_la_inscripcion`

## Problema

Caso real (Besser, Isabella Alfonso, 2026-10-29): la deportista no fue en septiembre y volvió en octubre con un plan de menos clases ($340.000 → $210.000).

- **El cambio de cuota solo tocaba cobros `pending`** (`bff/src/routes/students.ts`, rama «mismo plan»; en un cambio de plan, `cancelPendingPlanPayments` también solo mira `pending`). Septiembre (atrasado) y octubre (en revisión con comprobante de $210.000) se quedaron en $340.000.
- **No había forma de anular un mes pasado desde la app.** La Pausa rechaza meses pasados, exige `pause_enabled` (Besser lo tiene apagado) y deja al atleta en pausa hoy (lo saca del roster, corre el vencimiento).
- La familia no veía nada de lo que la escuela decidía.

## Decisiones de producto

| # | Decisión |
|---|---|
| D1 | **Lo decide el admin, nunca el sistema.** La asistencia se muestra como ayuda; nada se preselecciona para anular. |
| D2 | Escuelas que no toman lista: la columna de asistencia no aparece. Mes sin ninguna lista del equipo = «Sin registro de asistencia», nunca «0 asistencias». |
| D3 | Se anulan solo mensualidades `pending`/`overdue`, **sin abonos**, de **este mes o anteriores**. Futuro = Pausa. |
| D4 | Un cobro con comprobante (`awaiting_approval`) **no se anula** (la familia ya pagó); sí se le puede poner el valor nuevo. |
| D5 | Valor nuevo sugerido = cuota vigente × (1 − descuento del cobro) + mora ya causada. El admin puede editarlo. Debe ser > lo abonado. |
| D6 | Anular exige **motivo**; la familia lo ve. |
| D7 | Todo en **una transacción** y **un solo aviso** a la familia. |
| D8 | No depende del opt-in de la Pausa ni gasta su tope anual. |

## Cómo funciona

### Base (migración `20261029161649`)

- **`payment_corrections`** — historial: `kind` ∈ `anulado_no_asistio` | `valor_cambio_plan`, monto antes/después, estado anterior, motivo, quién y cuándo. RLS: finanzas de la escuela (`finance_read_school_ids()`) + la familia dueña del cobro. Solo escribe la RPC. **No confundir con `payment_adjustments`** (descuentos de cobros múltiples): la 161649 intentó crear esa tabla con `IF NOT EXISTS`, no hizo nada y le sumó una policy abierta; la 190004 la quitó y movió esto a tabla propia.
- **Solo los cobros de ESA inscripción** (`20261031105601`, helper `_cobro_de_otra_inscripcion`). `payments` no tiene `enrollment_id`; el cobro lleva el `team_id`/`offering_plan_id` de su inscripción. Es de esta si su equipo es el de esta; es de otra si coincide (equipo, o programa del plan cuando difiere del de esta) con otra inscripción **no cancelada** del mismo atleta. Sin señal → se muestra. Un cambio de plan/equipo dentro de la misma inscripción no lo saca. Antes, un atleta en Fútbol + Tenis veía los dos en cada ventana (53 atletas / 8 escuelas el 2026-10-31; verificado: los 51 cobros abiertos de esos atletas quedan cada uno en exactamente una ventana).
- **`cobros_abiertos_de_inscripcion(p_enrollment_id)`** — lectura, solo `is_school_admin`. Mensualidades abiertas (`pending/overdue/partial/awaiting_approval`) de la inscripción con: asistencias del mes (`present/late`), días con lista del equipo, valor sugerido, `puede_anular`, y `escuela_toma_lista` (alguna lista en 90 días).
- **`resolver_cobros_abiertos(p_enrollment_id, p_decisiones, p_motivo)`** — escritura, solo `is_school_admin`. `p_decisiones = [{payment_id, accion: 'anular'|'valor', monto}]`. Bloquea cada cobro con `FOR UPDATE` en orden fijo, revalida bajo el candado (si otro admin lo movió, aborta todo), escribe `payment_corrections` y manda **un** aviso (`notifications`, categoría `payment`, link `/my-payments`).
- **Que el mes anulado no se vuelva a cobrar:** un cobro `cancelled` no bloquea a `open_month`. Por eso se inserta una fila aprobada en `enrollment_pause_requests` con `reason = 'no_asistio'` y `resumed_at = inicio del mes`. Efecto:
  - `enrollment_pausada_en` / `open_month` → el mes queda exento (la lectura mensual acepta `resumed_at` dentro del mes).
  - `v_enrollment_pauses_effective` → ventana de días **vacía**: no saca del roster ni pinta «en pausa».
  - `pause_validar` → esas filas no cuentan para el tope anual.
  - `fn_notify_pause_decision` → no manda el aviso de «pausa».

### Pantalla del admin

`ResolverCobrosAbiertosDialog` (Deportistas):
- **Sola** después de guardar un cambio de plan, equipo o cuota, si quedó algún cobro con otro valor o atrasado (origen `cambio_plan`: propone el valor nuevo).
- Desde el menú del atleta: **«No asistió / cobros abiertos»** (origen `no_asistio`: todo en «Dejar igual»). En escritorio está en el menú del lápiz de la fila (junto a «Editar deportista» y «Cobros y pagos»); en celular, en el menú «⋯» de la tarjeta.

Por cobro: Dejar igual · Valor nuevo · Anular: no asistió. Motivo obligatorio si hay anulaciones.

### Pantalla de la familia

`MyPaymentsPage` → `AcuPagosV2`:
- Mes anulado: aparece en «Por pagar» con la etiqueta **«No se cobra»** y «La escuela anuló este mes: no asistió. {motivo}» durante 45 días.
- Cobro con valor nuevo: nota «Ajustado por cambio de plan (antes $X)».
- Además, la notificación con el resumen.

## Fuera de alcance / pendiente

- La vista del **atleta adulto** (`AthletePaymentsV2` / `useAthleteV2Data`) recibe el aviso pero aún no muestra las notas en la lista.
- El cambio de plan del BFF y la resolución de cobros son dos pasos: si la RPC falla, el plan queda cambiado y los cobros se resuelven después desde el menú.
- No se recalcula `receipt_verdict` de un comprobante tras cambiar el valor (la aprobación compara contra el saldo nuevo, así que deja de marcar diferencia).

## Pruebas

- Unitarias: `frontend/src/lib/cobrosAbiertos.test.ts` (ayuda de asistencia, decisiones por defecto, validación, envío, vista de la familia).
- Base (con sesiones simuladas): coach/acudiente → 42501; anular cobro con comprobante → error; dos resoluciones del mismo cobro → la segunda aborta; `preview_open_month` del mes anulado no lo incluye.
