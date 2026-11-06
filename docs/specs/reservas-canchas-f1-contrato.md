# Reservas de canchas — F1: contrato de las RPCs (para BFF y frontend)

**Fecha:** 2026-11-05 · **Plan:** [`reservas-canchas-f1-plan-migraciones.md`](reservas-canchas-f1-plan-migraciones.md) · **Spec:** [`reservas-canchas-plan-unificado-2026-10.md`](reservas-canchas-plan-unificado-2026-10.md) §2–4
**Estado:** contrato escrito ANTES del SQL. Las migraciones `reservas_f1_*` lo implementan tal cual; si el SQL cambia, se cambia este archivo en el mismo commit. **Nada de esto está aplicado en la base todavía.**

## 0. Reglas generales (valen para las 6 RPC)

- Todas son `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`. Todas devuelven **`jsonb`** (salvo `expirar_holds`, que devuelve `integer`).
- **Los errores de negocio NO lanzan excepción:** devuelven `{"ok": false, "error": "<CODIGO>", "message": "<texto en español>", ...extras}`. Éxito: `{"ok": true, ...}`. Solo lo inesperado (bug, base caída) lanza excepción SQL. El BFF traduce `error` a HTTP con la tabla del §7.
- **Quién las llama:**
  - `authenticated` (la app con sesión): `disponibilidad_canchas`, `reservar_cancha`, `cancelar_reserva`, `reprogramar_reserva`. La identidad es `auth.uid()`.
  - `service_role` (el BFF): las mismas cuatro **más** `confirmar_pago_reserva` y `expirar_holds`. Como el BFF no tiene `auth.uid()`, pasa la identidad ya verificada en `p_actor_profile_id` (usuario con sesión) o en `p_guest_booker_id` (invitado con teléfono verificado). **Esos parámetros solo se leen cuando `auth.uid()` es NULL**; con sesión de usuario se ignoran (nadie puede hacerse pasar por otro).
  - **`anon` NO tiene `EXECUTE` en ninguna.** La página pública y el bot pasan por el BFF con `service_role`.
- **Zona horaria:** todos los instantes entran y salen como `timestamptz` en UTC con sufijo `Z` (`2026-11-06T19:00:00Z`). Las fechas y horas "de pared" son de `America/Bogota` y vienen aparte (`local_date`, `local_start`, `local_end`).
- **Moneda:** COP, enteros (sin decimales).
- **El `school_id` nunca lo manda el cliente en `reservar/cancelar/reprogramar`:** sale de la instalación. En `disponibilidad_canchas` sí entra (la página pública resuelve slug → school) y se valida contra el entitlement.
- **Entitlement:** `disponibilidad_canchas`, `reservar_cancha` y `reprogramar_reserva` exigen `has_entitlement(school_id, 'reservations')` (venue o addon `reservations`); si no, `ENTITLEMENT_REQUIRED`. `cancelar_reserva` y `confirmar_pago_reserva` NO lo exigen (nadie queda atrapado en una reserva si la escuela pierde el addon).
- **Quién es quién** (`rol` de quien llama respecto de la escuela de la cancha):
  - `staff`: en `user_staff_school_ids()` o dueño o admin de plataforma (con `p_actor_profile_id`, la misma lógica por consulta directa).
  - `member`: miembro activo de la escuela que no es staff (padre, atleta, contador).
  - `external`: cualquier otro (incluye invitados sin cuenta).
- **Tarifa (`audience`) por `bookable_by`:**

| `facilities.bookable_by` | staff | member | external |
|---|---|---|---|
| `members` | elige (`public` por defecto) | tarifa `member` | **no puede** (`AUDIENCE_NOT_ALLOWED`) |
| `public` | elige | tarifa `public` | tarifa `public` |
| `both` | elige | tarifa `member` | tarifa `public` |

- Sin fila en `facility_rates`: `public` cae a `rental_rate` (si no es NULL) y luego a `hourly_rate`; `member` cae a `hourly_rate` y luego a `rental_rate`. Los festivos de Colombia se cobran como domingo (`co_holidays`).

## 1. Columnas nuevas

### `facilities` (migración `reservas_f1_columnas`)

| Columna | Tipo | Default | Significado |
|---|---|---|---|
| `bookable_by` | `text NOT NULL CHECK IN ('members','public','both')` | `'members'` | Quién puede reservar. Backfill: `rental_enabled = true` → `'both'`, el resto `'members'` |
| `slot_step_min` | `integer NOT NULL CHECK BETWEEN 5 AND 240` | `30` | Paso de la grilla. Todo inicio cae en minuto-del-día múltiplo de este valor y toda duración es múltiplo |
| `min_duration_min` | `integer NOT NULL CHECK > 0` | `60` | Duración mínima de una reserva |
| `max_duration_min` | `integer NOT NULL CHECK > 0` | `240` | Duración máxima para quien no es staff (`DURATION_TOO_LONG`) |

`booking_enabled` (ya existía, `boolean NULL`): `false` = no recibe reservas (NULL se trata como `true`). Las clases **siguen** ocupando la franja.

### `facility_reservations` (las de F0 ya existen; estas son las que agrega F1)

| Columna | Tipo | Significado |
|---|---|---|
| `payment_reference` | `text UNIQUE` | Referencia estable `RSV-XXXXXXXXXXXXXXXX` (16 hex del id). La usa el BFF como referencia de pasarela y `confirmar_pago_reserva` para encontrar la reserva |
| `user_id` | ahora **nullable** | Reserva de invitado: `user_id` NULL y `guest_booker_id` lleno. `CHECK (user_id IS NOT NULL OR guest_booker_id IS NOT NULL)` |

Ya existían desde F0 (no se vuelven a crear): `starts_at`, `ends_at`, `hold_expires_at`, `idempotency_key` (+ UNIQUE `(school_id, idempotency_key)`), `channel`, `guest_booker_id`, `payment_id`, `price_snapshot`, `cancelled_by`, `refund_status`, `cancellation_reason`, `cancelled_at`. **El motivo de cancelación es `cancellation_reason`, no `cancel_reason`.** `status` admite: `hold`, `pending`, `pending_payment`, `confirmed`, `pending_reconciliation`, `cancelled`, `expired`, `completed`, `no_show`. **`pending` sigue siendo válido** (flujo de solicitud + aprobación del admin).

**Cuenta de reservas activas:** una persona (o invitado) no staff puede tener como máximo **3** reservas futuras en estados `hold`/`pending_payment`/`pending`/`confirmed` por escuela (`TOO_MANY_ACTIVE`). El camino directo viejo (INSERT del cliente) tiene su propio tope de 3 `pending` futuras (error SQL 42501 `too_many_pending`).

Un trigger mantiene `starts_at`/`ends_at` sincronizados con `reservation_date/start_time/end_time` (hora de Bogotá) y **escribe `facility_occupancy`** (fuente `rental`) según el estado:

| `status` | ocupación |
|---|---|
| `hold`, `pending_payment` con `hold_expires_at` | `hold` hasta `hold_expires_at` |
| `pending_payment` sin vencimiento, `pending`, `confirmed`, `completed`, `no_show` | `active` |
| `cancelled`, `expired`, `pending_reconciliation` | `released` |

`price_snapshot` (jsonb) guarda: `audience`, `total`, `deposit_min`, `source` (`facility_rates`/`facility_default`), `breakdown[]` (`{from,to,rate,source}`), `payment_method`, `hold_minutes`, `staff_override` (bool), `created_by`, `payment_events[]` (ids de eventos de pasarela ya aplicados), `payments[]` (`{event_id, amount, provider, payment_id, at}`), `rescheduled_from[]`.

### Tablas nuevas (migración `reservas_f1_tarifas_politicas`)

- `facility_rates (id, school_id, facility_id, audience 'public'|'member', weekdays smallint[] (0=domingo..6), from_time, to_time, price_per_hour, priority, valid_from, valid_to, label)`.
- `facility_blackouts (id, school_id, facility_id, starts_at, ends_at, kind 'maintenance'|'weather'|'closed'|'other', reason, created_by)`. Escribe ocupación `blackout`; si choca con una reserva vigente falla con `23P01` y mensaje `BLACKOUT_OVERLAPS_OCCUPANCY`.
- `cancellation_policies (id, school_id, facility_id NULL, hours_full_refund, hours_partial_refund, partial_pct, no_show_penalty_pct, is_active)`. Sin fila: 24 h / 6 h / 50 % (D10).
- `co_holidays (holiday_date, name)`: solo lectura interna (sin grants a clientes).

## 2. `disponibilidad_canchas`

```sql
public.disponibilidad_canchas(
  p_school_id        uuid,
  p_from             date,
  p_to               date,
  p_sport            text    DEFAULT NULL,   -- compara con facilities.type (sin mayúsculas)
  p_facility_id      uuid    DEFAULT NULL,
  p_duration_min     integer DEFAULT NULL,   -- por defecto facilities.min_duration_min
  p_audience         text    DEFAULT NULL,   -- 'public'|'member'; SOLO lo respeta el staff (por defecto 'public')
  p_actor_profile_id uuid    DEFAULT NULL    -- solo service_role: usuario ya verificado por el BFF
) RETURNS jsonb   -- STABLE, solo lectura
```

Rango máximo: `p_to - p_from <= 30` días. No muestra: instalaciones con `booking_enabled = false`, `status <> 'available'`, o cuyo `bookable_by` no admite al que consulta. Una franja libre excluye: fuera de `available_hours`, ocupación `active`, `hold` vigente (un hold vencido NO bloquea aunque el job no haya corrido), blackouts, anticipación (`min_booking_advance_hours`) y más de 90 días hacia adelante. El staff ve todo lo que termine en el futuro. **Ninguna franja termina a las 24:00** (el rango no puede cruzar la medianoche).

Éxito:

```json
{
  "ok": true,
  "school_id": "uuid",
  "timezone": "America/Bogota",
  "generated_at": "2026-11-05T15:00:00Z",
  "from": "2026-11-06", "to": "2026-11-08",
  "facilities": [{
    "facility_id": "uuid", "name": "Cancha 1", "type": "futbol_5", "capacity": 10,
    "audience": "public",            // tarifa que se aplica a quien consulta
    "slot_step_min": 30, "min_duration_min": 60, "duration_min": 60,
    "min_deposit_pct": 30,
    "days": [{
      "date": "2026-11-06", "weekday": 5, "is_holiday": false,
      "slots": [{
        "starts_at": "2026-11-06T22:00:00Z", "ends_at": "2026-11-06T23:00:00Z",
        "start_local": "17:00", "end_local": "18:00",
        "price": 120000, "deposit_min": 36000
      }]
    }]
  }]
}
```

No ofrece a no staff franjas con precio 0 (cancha sin tarifa) ni duraciones mayores que `max_duration_min`. `days` trae solo los días con al menos una franja libre. Una instalación sin franjas sale con `days: []`.

Errores: `INVALID_ARGUMENT` (nulos o `p_to < p_from`), `RANGE_TOO_LARGE`, `ENTITLEMENT_REQUIRED`, `FACILITY_NOT_FOUND` (`p_facility_id` no es de esa escuela), `FACILITY_NOT_BOOKABLE` (con `p_facility_id`: `booking_enabled=false` o no disponible), `AUDIENCE_NOT_ALLOWED` (con `p_facility_id`: `bookable_by` no admite al que consulta), `INVALID_DURATION` (no es múltiplo de `slot_step_min` o menor que `min_duration_min`).

## 3. `reservar_cancha`

```sql
public.reservar_cancha(
  p_facility_id        uuid,
  p_starts_at          timestamptz,
  p_ends_at            timestamptz,
  p_channel            text,                    -- 'app'|'public'|'whatsapp'|'admin'|'landing'
  p_idempotency_key    text,                    -- OBLIGATORIA, 8..128 caracteres
  p_payment_method     text    DEFAULT 'online',-- 'online'|'transfer'|'cash'|'none'
  p_actor_profile_id   uuid    DEFAULT NULL,    -- solo service_role: quien ejecuta
  p_booker_profile_id  uuid    DEFAULT NULL,    -- solo staff: reserva a nombre de este usuario
  p_guest_booker_id    uuid    DEFAULT NULL,    -- invitado ya creado (verificado) en guest_bookers
  p_guest              jsonb   DEFAULT NULL,    -- solo staff: {"phone","full_name","email"?}; crea/reusa guest SIN verificar
  p_rate_audience      text    DEFAULT NULL,    -- solo staff: 'public'|'member'
  p_participants       integer DEFAULT 1,
  p_notes              text    DEFAULT NULL,
  p_external_org_name  text    DEFAULT NULL,
  p_amount_paid        numeric DEFAULT 0        -- solo staff: lo que ya cobró en sede
) RETURNS jsonb
```

**Quién es el reservante:**
- Con sesión no-staff: `auth.uid()`. Pasar otro `p_booker_profile_id` → `FORBIDDEN`.
- Staff: `p_booker_profile_id` (tercero con cuenta), o `p_guest_booker_id`/`p_guest` (tercero sin cuenta), o nada (uso interno: `user_id` = el staff).
- Invitado (BFF, `auth.uid()` NULL y sin actor): exige `p_guest_booker_id`. Si `p_channel` es `public`, `whatsapp` o `landing`, el invitado debe tener `verified_phone_at` (el BFF lo marca tras el OTP o, en el bot, porque Meta ya verificó el número).
- **Menor de edad (limitación conocida):** quien no tiene fecha de nacimiento y tampoco ficha con acudiente NO se detecta como menor; la protección real depende de que las cuentas de menores traigan fecha o acudiente.
- **Menor de edad:** si el reservante (no staff) tiene cuenta y es menor → `MINOR_CANNOT_BOOK`. Menor = `profiles.date_of_birth` con menos de 18 años; sin fecha, solo si su ficha (`unregistered_athletes.linked_profile_id`) tiene datos de acudiente (y no es `parent` activo de la escuela). **El acudiente sí puede reservar.** El staff no pasa por este control.

**Qué hace (en este orden, una sola transacción):** valida argumentos, instalación, entitlement, rol, tarifa, menor → `pg_advisory_xact_lock(facility, día de Bogotá)` → si la llave ya existe devuelve esa reserva (`idempotent_replay: true`) → valida rango/horario/anticipación/blackout → libera los holds vencidos de esa cancha → calcula precio → inserta la reserva; el trigger escribe `facility_occupancy` en la misma transacción. `23P01` → `SLOT_TAKEN`.

**Estado resultante:**

| Caso | `status` | ocupación | `hold_expires_at` |
|---|---|---|---|
| Precio total = 0 | `confirmed`, `payment_status='waived'` | active | NULL |
| Staff, `cash` | `confirmed`, `unpaid`/`partial`/`paid` según `p_amount_paid` | active | NULL |
| Staff, `none` (uso interno) | `confirmed`, `waived`, precio 0 | active | NULL |
| Miembro, `cash` | `confirmed`, `unpaid` | active | NULL |
| `online` | `pending_payment` | hold | ahora + **10 min** |
| `transfer` | `pending_payment` | hold | ahora + **15 min** |

`cash` de un externo o invitado → `PAYMENT_REQUIRED`. `none` de un no-staff → `PAYMENT_METHOD_NOT_ALLOWED`. El BFF puede **alargar** `hold_expires_at` (p. ej. transferencia con comprobante en revisión) con un `UPDATE` de service_role.

Éxito (también en replay, mismo JSON):

```json
{
  "ok": true,
  "idempotent_replay": false,
  "requires_payment": true,
  "reservation": {
    "id": "uuid", "facility_id": "uuid", "facility_name": "Cancha 1", "school_id": "uuid",
    "status": "pending_payment", "payment_status": "unpaid",
    "starts_at": "2026-11-06T22:00:00Z", "ends_at": "2026-11-06T23:00:00Z",
    "local_date": "2026-11-06", "local_start": "17:00", "local_end": "18:00",
    "hold_expires_at": "2026-11-05T15:10:00Z",
    "channel": "public", "payment_reference": "RSV-3F9A1C0D22B4E7A1",
    "price": 120000, "amount_paid": 0, "min_deposit_pct": 30, "deposit_min": 36000,
    "refund_status": null
  },
  "pricing": { "audience": "public", "total": 120000, "deposit_min": 36000, "currency": "COP",
               "source": "facility_rates", "breakdown": [{"from":"2026-11-06T22:00:00Z","to":"2026-11-06T22:30:00Z","rate":120000,"source":"facility_rates"}] }
}
```

`SLOT_TAKEN` además trae `"alternatives": [ {facility_id, starts_at, ends_at, start_local, end_local, price}, ...hasta 3 ]` (siguientes franjas libres de esa cancha, misma duración).

Errores: `INVALID_ARGUMENT`, `INVALID_AMOUNT`, `FACILITY_NOT_FOUND`, `ENTITLEMENT_REQUIRED`, `FACILITY_NOT_BOOKABLE`, `AUDIENCE_NOT_ALLOWED`, `MINOR_CANNOT_BOOK`, `FORBIDDEN`, `STAFF_ONLY_FIELD`, `GUEST_REQUIRED`, `GUEST_NOT_FOUND`, `GUEST_NOT_VERIFIED`, `CHANNEL_NOT_ALLOWED` (`admin` solo staff), `PAYMENT_METHOD_NOT_ALLOWED`, `PAYMENT_REQUIRED`, `IDEMPOTENCY_KEY_REUSED` (la llave existe con otros datos u otro reservante), `TOO_MANY_ACTIVE`, `DURATION_TOO_LONG`, `PRICE_NOT_CONFIGURED`, `INVALID_RANGE`, `DURATION_TOO_SHORT`, `INVALID_DURATION`, `CROSSES_MIDNIGHT`, `SLOT_NOT_ALIGNED`, `OUTSIDE_HOURS`, `TOO_SOON`, `TOO_FAR`, `IN_THE_PAST` (staff), `FACILITY_BLOCKED` (blackout), `SLOT_TAKEN`.

**Reglas anti-abuso (no staff):** máximo 3 reservas activas (`TOO_MANY_ACTIVE`), duración ≤ `max_duration_min` (`DURATION_TOO_LONG`), cancha sin tarifa → `PRICE_NOT_CONFIGURED`, `p_notes` ≤ 500 y `p_participants` entre 1 y la capacidad (si es > 0) → `INVALID_ARGUMENT`. **Staff:** `p_booker_profile_id` debe ser alguien vinculado a su escuela y `p_guest_booker_id` alguien con historial en ella (si no, `FORBIDDEN`); para un invitado nuevo o por teléfono usar `p_guest` (nunca pisa el nombre/correo de un invitado existente).

El staff se salta `OUTSIDE_HOURS`, `TOO_SOON`, `TOO_FAR` y `bookable_by`; queda `price_snapshot.staff_override = true`. **Nadie** se salta `booking_enabled`, alineación, blackouts ni el EXCLUDE.

## 4. `cancelar_reserva`

```sql
public.cancelar_reserva(
  p_reservation_id   uuid,
  p_reason           text DEFAULT NULL,   -- se guarda en cancellation_reason
  p_actor_profile_id uuid DEFAULT NULL,   -- solo service_role
  p_guest_booker_id  uuid DEFAULT NULL    -- solo service_role: invitado dueño (enlace /r/:token ya validado por el BFF)
) RETURNS jsonb
```

Pueden: el dueño (`user_id` = quien llama, o `guest_booker_id` = el invitado), el staff de la escuela. Estados cancelables: `hold`, `pending_payment`, `pending`, `confirmed`, `pending_reconciliation`. Ya cancelada → `ok: true, already_cancelled: true` (idempotente). No-staff: no puede cancelar una reserva que ya empezó (`ALREADY_STARTED`) ni dentro de `facilities.min_cancellation_hours` (`CANCELLATION_WINDOW_CLOSED`).

Una reserva en `pending_reconciliation` (pagó y perdió la franja) se cancela **sin ventana** y con reembolso del 100 %.

Devolución sobre `amount_paid` según `cancellation_policies` (de la cancha, luego de la escuela, luego 24 h/6 h/50 %): `>= hours_full_refund` → 100 %; `>= hours_partial_refund` → `partial_pct`; si no, 0 %. **Si cancela el staff: siempre 100 %.** `refund_status`: `'none'` si no hay nada que devolver, `'manual'` si hay (no hay billetera hasta F6: la devolución la registra una persona). Marca `cancelled_by`, `cancelled_at`, `cancellation_reason`; el trigger libera la ocupación.

```json
{ "ok": true, "already_cancelled": false,
  "reservation": { ...mismo objeto de §3... },
  "refund": { "pct": 50, "amount": 60000, "status": "manual", "hours_before": 8.5,
              "policy": { "hours_full_refund": 24, "hours_partial_refund": 6, "partial_pct": 50, "source": "default|school|facility" } } }
```

Errores: `RESERVATION_NOT_FOUND`, `FORBIDDEN`, `INVALID_STATE` (`completed`, `no_show`, `expired`), `ALREADY_STARTED`, `CANCELLATION_WINDOW_CLOSED`.

## 5. `reprogramar_reserva`

```sql
public.reprogramar_reserva(
  p_reservation_id   uuid,
  p_new_starts_at    timestamptz,
  p_new_ends_at      timestamptz,
  p_new_facility_id  uuid DEFAULT NULL,   -- solo staff; misma escuela
  p_actor_profile_id uuid DEFAULT NULL,   -- solo service_role
  p_guest_booker_id  uuid DEFAULT NULL    -- solo service_role
) RETURNS jsonb
```

**Atómico:** mueve la fila de ocupación de la reserva al rango nuevo con un solo `UPDATE`; el EXCLUDE valida el rango nuevo contra todo lo demás **sin soltar el viejo antes** (no hay instante sin cancha, ni instante en que otro la tome). Estados: `hold`, `pending_payment`, `pending`, `confirmed`. Se valida el rango nuevo con las mismas reglas que `reservar_cancha`.

- **No-staff:** misma duración (`DURATION_MISMATCH`), misma cancha, **dentro de la ventana de reembolso total** (`now() <= starts_at - hours_full_refund`; si no, `RESCHEDULE_WINDOW_CLOSED`). Se recalcula el total del horario nuevo con la misma tarifa: si es **mayor** que el precio original → `RESCHEDULE_PRICE_DIFFERS` (F1 no cobra diferencias); si es igual o menor se conserva el precio original.
- **Staff:** puede cambiar duración y cancha; el precio se recalcula con la misma tarifa y queda `price_snapshot.rescheduled_from[]`.
- Mismo rango = no-op `ok: true, unchanged: true`.

Éxito: `{ "ok": true, "unchanged": false, "reservation": {...}, "previous": { "starts_at": "...", "ends_at": "...", "facility_id": "uuid" } }`.

Errores: `RESERVATION_NOT_FOUND`, `ENTITLEMENT_REQUIRED`, `FORBIDDEN`, `INVALID_STATE`, `ALREADY_STARTED`, `RESCHEDULE_WINDOW_CLOSED`, `RESCHEDULE_PRICE_DIFFERS`, `DURATION_MISMATCH`, `STAFF_ONLY_FIELD`, `FACILITY_NOT_FOUND`, `FACILITY_NOT_BOOKABLE`, más los de rango de §3 (`INVALID_RANGE`, `CROSSES_MIDNIGHT`, `SLOT_NOT_ALIGNED`, `OUTSIDE_HOURS`, `TOO_SOON`, `TOO_FAR`, `FACILITY_BLOCKED`), `SLOT_TAKEN` (con `alternatives`).

## 6. `confirmar_pago_reserva` y `expirar_holds`

```sql
public.confirmar_pago_reserva(
  p_reference         text,            -- 'RSV-<16hex>' o con sufijo de reintento 'RSV-<16hex>-<n>' (se normaliza)
  p_amount            numeric,         -- monto aprobado por la pasarela (> 0)
  p_payment_id        uuid DEFAULT NULL,   -- payments.id si el BFF lo creó
  p_provider          text DEFAULT NULL,   -- 'wompi'|'mercadopago'|'transfer'…
  p_provider_event_id text DEFAULT NULL    -- id del evento/transacción: clave de idempotencia. OBLIGATORIO ENVIAR event_id O payment_id (si no, INVALID_ARGUMENT)
) RETURNS jsonb      -- SOLO service_role (la llama el webhook)

public.expirar_holds() RETURNS integer   -- SOLO service_role / pg_cron. Devuelve cuántas reservas pasó a 'expired'
```

`confirmar_pago_reserva` bloquea la fila (`FOR UPDATE`) y es **idempotente**: el mismo `p_provider_event_id` (o el mismo `p_payment_id`) dos veces no suma dos veces (`already_processed: true`). Suma `p_amount` a `amount_paid` y actualiza `payment_status` (`partial`/`paid`).

| Estado al llegar el pago | Resultado |
|---|---|
| `hold`/`pending_payment`/`pending`, hold vigente | `confirmed` si `amount_paid >= deposit_min`; si no, sigue `pending_payment` con `confirmed:false, reason:"DEPOSIT_NOT_REACHED"` |
| `expired`, o hold vencido, y la franja sigue libre | Re-ocupa y confirma |
| `expired`/hold vencido y la franja **ya la tomó otro** | `pending_reconciliation` + `reconciliation: true` (el BFF alerta al admin: devolver o saldo a favor). **Nunca se pierde el pago** |
| `cancelled` | `pending_reconciliation` + `reconciliation: true` (hay plata sin reserva) |
| `confirmed` | Solo suma si el evento es nuevo; no cambia el estado |

```json
{ "ok": true, "already_processed": false, "confirmed": true, "reconciliation": false,
  "reservation": { ...objeto de §3... } }
```

Errores: `INVALID_ARGUMENT`, `INVALID_AMOUNT`, `RESERVATION_NOT_FOUND`, `INVALID_STATE`. Con `reconciliation: true` trae además `reason` (`CANCELLED` | `SLOT_TAKEN`), `reason_detail` (`PAID_AFTER_CANCELLATION`, `PAID_AGAIN_PENDING_RECONCILIATION`, `PAID_AFTER_EXPIRATION_DEPOSIT_NOT_REACHED` o `SLOT_TAKEN_AFTER_HOLD_EXPIRED`), `amount_paid` y `price`. En `payment_events` se guarda exactamente el `p_provider_event_id` recibido; con `confirmed: false` y estado vigente, `reason: DEPOSIT_NOT_REACHED`.

`expirar_holds` pasa a `expired` las reservas `hold`/`pending_payment` con `hold_expires_at < now()` y `amount_paid = 0` (las que ya tienen plata pasan a `pending_reconciliation`, igual que en los barridos de `reservar_cancha` y `reprogramar_reserva`) (en lote, `FOR UPDATE SKIP LOCKED`) y libera sus ocupaciones, más cualquier hold huérfano de `facility_occupancy`. Es higiene: la disponibilidad ya ignora holds vencidos y `reservar_cancha` los libera de su cancha antes de insertar.

## 7. Tabla de traducción BFF (sugerida)

| `error` | HTTP |
|---|---|
| `SLOT_TAKEN` | **409** (con `alternatives`) |
| `IDEMPOTENCY_KEY_REUSED` | 409 |
| `TOO_MANY_ACTIVE` | 429 (o 409) |
| `PRICE_NOT_CONFIGURED`, `RESCHEDULE_PRICE_DIFFERS`, `DURATION_TOO_LONG` | 422 |
| `INVALID_STATE`, `ALREADY_STARTED`, `CANCELLATION_WINDOW_CLOSED`, `RESCHEDULE_WINDOW_CLOSED`, `FACILITY_BLOCKED` | 409 |
| `FORBIDDEN`, `STAFF_ONLY_FIELD`, `CHANNEL_NOT_ALLOWED`, `AUDIENCE_NOT_ALLOWED`, `MINOR_CANNOT_BOOK`, `GUEST_NOT_VERIFIED` | 403 |
| `ENTITLEMENT_REQUIRED`, `PAYMENT_REQUIRED` | 402/403 (decide el BFF; `ENTITLEMENT_REQUIRED` = 403 con mensaje de plan) |
| `FACILITY_NOT_FOUND`, `RESERVATION_NOT_FOUND`, `GUEST_NOT_FOUND` | 404 |
| `FACILITY_NOT_BOOKABLE` | 422 |
| `INVALID_*`, `DURATION_*`, `CROSSES_MIDNIGHT`, `SLOT_NOT_ALIGNED`, `OUTSIDE_HOURS`, `TOO_SOON`, `TOO_FAR`, `IN_THE_PAST`, `GUEST_REQUIRED`, `PAYMENT_METHOD_NOT_ALLOWED`, `RANGE_TOO_LARGE` | 400/422 |

El `Idempotency-Key` del header HTTP es `p_idempotency_key`. La llave es **por escuela** (UNIQUE `(school_id, idempotency_key)`) y queda atada al reservante: otro usuario con la misma llave recibe `IDEMPOTENCY_KEY_REUSED`.

## 8. Cosas que F1 NO hace (para no construir contra lo que no existe)

- No crea el pago ni el link: el BFF lo hace con `payment_reference` y llama `confirmar_pago_reserva` desde el webhook (F2).
- No revoca la escritura directa en `facility_reservations` (M7): los clientes actuales siguen funcionando mientras migran a estas RPC. Hasta M7, un cliente que inserte directo **sí** ocupa la franja (el trigger escribe la ocupación) pero el servidor no le calcula la tarifa de `facility_rates`.
- No hay `generar_recurrencia`, ni motor de reglas por segmento (§2.3.1), ni lista de espera, ni pago dividido.
- La reserva no cruza la medianoche (`reservations_time_valid` exige `end_time > start_time`).
