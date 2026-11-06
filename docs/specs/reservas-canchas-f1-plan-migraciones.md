# Reservas de canchas — F1: motor de reservas (plan para aprobar)

**Fecha:** 2026-11-05 · **Spec:** [`reservas-canchas-plan-unificado-2026-10.md`](reservas-canchas-plan-unificado-2026-10.md) §2–4, §8
**Estado:** plan. **No hay SQL escrito ni aplicado.** Se escribe con `npm run migrations:new` cuando se apruebe.
**Antecedente:** F0 aplicada el 2026-10-14 (`20261014152937`, `…153533`, `…153538`, `…153542`). Desde entonces no hay trabajo de reservas.

---

## 0. Alcance acordado con el usuario (2026-11-05)

La idea es una sola plataforma donde **cualquiera pueda poner sus espacios y recibir reservas**, en dos ambientes con el mismo motor:

| Ambiente | Quién | Cómo entra |
|---|---|---|
| **Escuela** | Una escuela existente con sus instalaciones | Activa el addon `reservations` |
| **Dueño de espacios** | Persona o club sin escuela (`school_type = 'venue'`) | Registro propio (F3), plan Gratis hasta 2 espacios |

Quién puede reservar:

| Quién | Entra con | Precio |
|---|---|---|
| Staff (coach, admin) | Sesión | Uso interno, sin pago, o reserva para un tercero |
| Padre o acudiente | Sesión | Tarifa `member` si la define la escuela; pago en línea o transferencia |
| Atleta **mayor de edad** | Sesión | Igual que el padre |
| **Menor de edad** | **No reserva.** Reserva su acudiente | — |
| Externo | Sin cuenta, con número verificado (página pública, WhatsApp) | Tarifa `public`; solo pago en línea o abono (D7) |

**Por cada instalación**, la escuela o el dueño decide si recibe reservas. Un espacio de **entrenamiento** no recibe reservas: sigue ocupado por sus clases (bloquea la franja), pero nadie lo reserva.

---

## 1. Decisiones de diseño que salen de lo anterior

### 1.1 «Recibe reservas» reusa `facilities.booking_enabled` (no se crea columna nueva)
`booking_enabled` ya existe y ya lo leen `public-booking.routes.ts:62` y `SchoolDetailPage.tsx:726`. Significa justo esto. Reglas:
- `booking_enabled = false` → la RPC `disponibilidad_canchas` no devuelve franjas y `reservar_cancha` rechaza con `FACILITY_NOT_BOOKABLE`. La ocupación por clases **sigue escribiendo** en `facility_occupancy`.
- `booking_enabled` es `boolean NULL` hoy. **Verificar en la base viva** cuántas filas son NULL y qué significa cada valor antes de decidir el default (NULL se trata como `true`, como hace el frontend con `!== false`).
- `rental_enabled` (12 de 30 canchas) es otra cosa: «se alquila a externos». Ver §1.2.

### 1.2 Quién puede reservar cada instalación: `bookable_by`
Columna nueva `facilities.bookable_by text NOT NULL DEFAULT 'both' CHECK (bookable_by IN ('members','public','both'))`.
- `members`: solo gente vinculada a la escuela (padres, atletas mayores, staff).
- `public`: solo externos.
- `both`: ambos, con tarifa distinta (`facility_rates.audience`).
- **Los 12 espacios con `rental_enabled = true` arrancan en `both`; los demás en `members`** (backfill), para no abrir al público espacios que nunca estuvieron abiertos. Esto cambia el default de la columna a `members` en la migración. **Pendiente confirmar con el usuario.**

### 1.3 Menores no reservan
`reservar_cancha` rechaza (`MINOR_CANNOT_BOOK`) si el booker es un atleta menor de 18 años. El acudiente sí puede reservar. **Verificar** de dónde sale la edad (`profiles.birth_date` o `athletes.birth_date`) y qué pasa con cuentas sin fecha: propuesta, sin fecha = se trata como menor si el rol es `athlete` y está vinculado a un acudiente, y como adulto si no. **Pendiente confirmar.**

### 1.4 Una sola ocupación para todo
Ya existe (`facility_occupancy`, EXCLUDE `facility_occupancy_sin_cruces`). F1 hace que **todas** las escrituras pasen por las RPCs y que las clases también escriban ahí (backfill trivial: 0 clases futuras con cancha a 2026-10-14; **re-verificar hoy**).

---

## 2. Migraciones propuestas (orden y contenido)

Una sola sesión las aplica, una a la vez, con `db query --linked` + registro en `schema_migrations` (regla de Disk IO). `types.ts` se regenera **una vez al final**.

| # | Slug | Contenido | Riesgo |
|---|---|---|---|
| M1 | `reservas_f1_columnas` | Columnas de spec §2.2 en `facility_reservations`: `starts_at`, `ends_at`, `hold_expires_at`, `idempotency_key` + UNIQUE `(school_id, idempotency_key)`, `channel` CHECK, `guest_booker_id`, `payment_id`, `price_snapshot`, `cancelled_by`, `cancel_reason`, `refund_status`. `status` pasa a text+CHECK con los 8 estados; migrar `pending`→`pending_payment` y `confirmed`. En `facilities`: `bookable_by`, `slot_step_min`, `min_duration_min`. | Medio: toca 61 filas históricas, 0 futuras. Medir antes |
| M2 | `reservas_f1_tarifas_politicas` | `facility_rates` (audience public/member, franjas, festivos), `facility_blackouts`, `cancellation_policies`. RLS: lectura por `user_school_ids()`, **escritura por `user_admin_school_ids()`** (tarifas y políticas), blackouts por `user_staff_school_ids()`. Con `WITH CHECK` (I3). Sin acceso `anon`. | Bajo |
| M3 | `reservas_f1_rpc_disponibilidad` | `disponibilidad_canchas(...)`. Solo lectura, `SECURITY DEFINER`, `search_path` fijo, `GRANT EXECUTE` a `authenticated` y a `anon` **solo** si la página pública la llama (lo hace, vía BFF: preferir llamarla con `service_role` desde el BFF y **no** dar `anon`). Respeta `booking_enabled` y `bookable_by` según el tipo de quien consulta. | Bajo |
| M4 | `reservas_f1_rpc_reservar` | `reservar_cancha` con advisory lock `(facility, día)`, idempotencia, `expirar_holds` en línea, reglas (anticipación mínima, duración, blackouts, `booking_enabled`, `bookable_by`, menor de edad), `price_snapshot`. Valida el alcance del caller **adentro** (regla de CLAUDE.md). `23P01` → `SLOT_TAKEN`. | **Alto**: es el núcleo. Revisar línea por línea |
| M5 | `reservas_f1_rpc_ciclo` | `cancelar_reserva`, `reprogramar_reserva` (ocupa lo nuevo antes de soltar lo viejo), `confirmar_pago_reserva` (se escribe aquí pero se conecta en F2). Programar `expirar_holds()` en `pg_cron` cada minuto, en lote, sin N+1. | Medio |
| M6 | `reservas_f1_backfill_clases` | Las clases con cancha escriben en `facility_occupancy` (trigger o desde la RPC de horarios). | Bajo hoy, medir |
| M7 | `reservas_f1_revocar_escritura_directa` | `REVOKE INSERT, UPDATE, DELETE` sobre `facility_reservations` a `authenticated`. **Solo después** de migrar los 4 clientes de §3 y de probarlos corriendo. Va en su propia fase y su propio commit. | **Alto**: si se aplica antes, las pantallas dan 42501 |

Cada función nueva lleva `SET search_path = pg_catalog, public, pg_temp` y `GRANT EXECUTE` explícito; el verificador `npm run seguridad:invariantes` corre al cerrar M2–M5 y M7.

---

## 3. Clientes que hoy escriben directo y hay que migrar (antes de M7)

| Cliente | Hoy | Pasa a |
|---|---|---|
| `useFacilityReservations` (frontend) | insert/update directo | `reservar_cancha` / `cancelar_reserva` vía BFF |
| `FacilityReservationModal` (frontend) | insert directo, **precio desde el cliente** | RPC; el precio lo calcula el servidor |
| `reservations-admin` (BFF) | escribe directo | RPCs |
| `book-secondary` (BFF) | inserta directo | `reservar_cancha` |

---

## 4. BFF (F1: solo API, sin pantallas nuevas)

- `GET /api/v1/facilities/:id/availability` y público `GET /api/v1/public/facilities/:slug/availability` (rate limit + captcha).
- `POST /api/v1/reservations` con `requireIdempotencyKey` (sin header = 400). Conflicto → **409 `SLOT_TAKEN`** con 3 alternativas.
- `DELETE /api/v1/reservations/:id`, `POST /:id/reschedule`.
- `requireEntitlement('reservations')` en todo, salvo lo público (que valida el addon de la escuela dueña dentro de la RPC).
- Job `expirar_holds`: una consulta por lote.

---

## 5. Pruebas obligatorias (en la fase, no después)

1. **Concurrencia:** 50 reservas simultáneas a la misma franja → 1 gana, 49 reciben 409.
2. Misma `idempotency_key` ×10 → 1 sola fila.
3. Hold vencido + pago tardío (cuando F2 conecte el pago).
4. Una clase ocupa la cancha → el alquiler de esa franja da 409; y al revés.
5. `booking_enabled = false` → sin franjas y `FACILITY_NOT_BOOKABLE`; la clase sigue ocupando.
6. `bookable_by = 'members'` → un externo no ve ni reserva; `'public'` → un padre sí paga tarifa pública, pero no la de socio.
7. **Menor de edad** no reserva; su acudiente sí.
8. **Negativa de seguridad:** el staff de la escuela A no lee ni escribe reservas de la B; `set local role anon; select count(*) from facility_occupancy;` → 0.
9. Prueba **corriendo** con sesión real de cada rol (staff, padre, atleta adulto, externo), no solo typecheck.

---

## 6. Antes de escribir SQL (verificaciones en la base viva, una consulta filtrada por nombre)

1. `facilities.booking_enabled`: conteo de `true / false / NULL`.
2. De dónde sale la edad del atleta y cuántos atletas activos no tienen fecha.
3. Reservas con fecha futura y clases futuras con cancha (hoy).
4. Que `facility_occupancy`, `guest_bookers` y el addon existan como en F0 (sin regenerar el catálogo).
5. Políticas actuales de `facility_reservations` (`pg_policies` filtrado por tabla): tras M0 deben ser 3 con `WITH CHECK`.

## 7. Decisiones pendientes del usuario

| # | Pregunta | Propuesta |
|---|---|---|
| P1 | ¿Los espacios con `rental_enabled = false` arrancan como solo para miembros? | Sí (`members`); los 12 con `rental_enabled` en `both` |
| P2 | ¿Atleta sin fecha de nacimiento cuenta como menor? | Sí si es `athlete` vinculado a un acudiente; si no, adulto |
| P3 | ¿Tarifa `member` aplica también al staff que reserva para un tercero? | No: el staff reserva a la tarifa que elija en la agenda |
| P4 | Plazo | F1 ≈ 2 semanas (spec §8); M7 se aplica al cierre, no antes |
