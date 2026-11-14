# Plan técnico — `SEG-31`: correcciones de prioridad alta del link de agendamiento

**Fecha:** 2026-11-07 · **Spec:** [`docs/specs/link-agendamiento-correcciones-alta.md`](specs/link-agendamiento-correcciones-alta.md)
**Estado:** D1-D5 aprobadas con la recomendación. F2 y F3 pendientes; §6 dice qué cambia si se decide otra cosa.

**F3 construida 2026-11-07, sin commitear, con las dos migraciones SIN APLICAR:**
- **`20261107111754_seg31_cupos_reserva_sin_cuenta`:**
  - Columna `credit_enrollment_id`.
  - RPC `book_session_with_credit`: bloquea sesión y luego inscripción; valida escuela, identidad, estado, vencimiento (Bogotá) y cupo; exige reserva de horas en planes de horas.
  - RPC `cancel_session_booking_with_credit`: UPDATE condicional; no cancela sesiones de días pasados ni con asistencia registrada; devuelve el crédito solo desde `credit_enrollment_id`.
  - `migrate_unregistered_athlete_to_profile` rellena `enrollment_id`.
  - Índice único sobre la reserva de horas activa.
  - Rollback en `_smoke/seg31_cupos_reserva_sin_cuenta_rollback.sql`.
- **`20261107174916_seg31_session_bookings_escritura_cliente`:** cierra C2. `anon` y `authenticated` quedan solo con SELECT sobre `session_bookings`; se borran las policies de UPDATE e INSERT y un trigger guarda bloquea cualquier cambio de `status` por REST. Con el enum vivo (`confirmed`, `cancelled`, `attended`, `no_show`) no había escritura legítima por REST.
- **BFF:**
  - Prechequeo antes de estirar sesiones, reserva y cancelación por las RPC, y listado con `plan_expired`.
  - **C1:** `/athlete/cancel-booking` valida que el hijo sea del padre.
  - **I1:** las rutas de cancelación antiguas usan la RPC y el staff solo cancela en su escuela.
  - **R3:** `POST /sessions/:id/book` exige staff de la escuela o identidad propia.
  - **R2:** las encuestas ya no guardan `enrollment_id`.
- **Validación:**
  - Seguridad: apta en el ciclo 3. Los ciclos 1 y 2 encontraron C1, C2, R1, R2 y R3, que ya existían antes de esta fase, todos cerrados.
  - QA: apto con la suite completa (BFF 7062 tests, frontend 3654), condicionado a aplicar y correr los smokes.
- **Orden de despliegue OBLIGATORIO:**
  1. Aplicar `20261107111754`, desde una sola sesión y por una vía con rastro.
  2. Correr el smoke funcional.
  3. Desplegar el BFF. Antes de esto, el BFF nuevo da 500 al reservar o cancelar.
  4. Aplicar `20261107174916` y correr su smoke.
  5. Correr `npm run seguridad:invariantes`.
  6. Regenerar `types.ts` una sola vez.
- **Deuda:**
  - Una clase del mismo día que ya terminó, sin asistencia registrada, aún se puede cancelar con devolución (🟡: comparar fecha y hora).
  - Carrera de milisegundos entre la toma de asistencia y la cancelación (`consumeBooking` sin `.eq('status','confirmed')`).
  - El listado sin cuenta no oculta las sesiones con `plan_expired`.
  - Los botones aprobar y completar cortesía de `/facilities` ya estaban rotos (enum) y ahora dan 42501.
  - Cuando cancela el staff, `cancelled_reason` queda como «Cancelado por el atleta».
  - El coach puede agendar un drop-in a cualquier atleta de su escuela.
  - El nuevo **`SEG-33`**.

**F2 construida 2026-11-07, sin commitear ni desplegar:**
- **Bloqueos de `/register-unregistered`:** la ficha menor (por edad o sin fecha) recibe 409 `minor_requires_guardian_invite` antes de `createUser`; la ficha inactiva recibe 400 `ficha_inactive`.
- **Rollback:** si falla la migración, se borra la fila de `profiles` y después el usuario de `auth`. Si el rollback falla, queda un log del huérfano. El trigger de pedidos de tienda no corre, porque la cuenta nace confirmada.
- **Errores:** todos los 500 llevan `reason`.
- **Correos de `/book-for-enrollment`:** usan la plantilla con marca `enrollmentClassBooked`, y la copia va al acudiente solo si la ficha es de un menor.
- **Frontend:** con el 409 se oculta «Crear mi cuenta».
- **Validación:** seguridad apta en el ciclo 2 (el ciclo 1 marcó un 🔴, ya corregido); revisión de código aprobada con 🟡, todos corregidos menos partir el handler; QA apto con la suite completa (BFF 6993 tests, frontend 3654).
- **Deuda:** el handler de `/register-unregistered` tiene unas 77 líneas; los usuarios huérfanos de `auth` solo quedan en logs; `migrate_unregistered_athlete_to_profile` no bloquea la ficha (`FOR UPDATE`); falta un test de la copia al acudiente para una ficha sin fecha.

**F1 construida 2026-11-07, sin commitear ni desplegar:**
- **Código:** `bff/src/utils/clientIp.ts` (`clientIp`, `publicBookingRateKey`); limitadores de `public-booking.routes.ts` e `index.ts`; `isTrialLinkEnabled`/`isTrialLinkOpen` en 8 rutas más `trial_link_enabled` en `/schools/:slug`; paso `link_disabled` en `PublicTrialClassBookingPage.tsx` (con sesión lleva a «Mis Inscripciones»); prop `retry` opcional en `HourBankBalanceCard.tsx`.
- **Comportamiento:** un error al leer los settings responde 500, no 422.
- **Pruebas:** suite completa en verde (BFF 6966 tests, frontend 3654) y `tsc` limpio en los dos. Seguridad: apto, sin 🔴 ni 🟡. Revisión de código: aprobada; sus 🟡 se corrigieron.
- **Sin probar en el navegador:** el BFF local arranca 6 jobs sin interruptor contra la base compartida. Se prueba en stg o local con los jobs apagados después del deploy.
- **Sin test directo:** el tope de 200 de `publicBookingLimiter`; solo se prueba su llave.
**Verificado:** código del repo en `af319d28` y base viva en solo lectura (2026-11-06/07).

## 1. Lo que el código cambia respecto de la spec

1. **El cierre de asistencia no descuenta dos veces.** Con una reserva del día, la asistencia la marca `attended` y no toca el saldo (`attendance-credits.ts:302-362`). El único consumo es el de `bookSession`, así que H1 se arregla solo en la cancelación.
2. **Hallazgo nuevo en H1.** `migrate_unregistered_athlete_to_profile` pasa las reservas a `user_id`/`child_id`, pero deja `enrollment_id` en NULL. Si una ficha crea cuenta con reservas futuras, al cancelarlas con cuenta tampoco se devuelve el crédito. Hoy no hay ninguna (0 reservas futuras sin cuenta), pero el arreglo debe cubrirlo.
3. **Tokens compartidos.** Un token de `/agendar/:slug` (`/start-verification`, tipo `enrolled_unregistered`) también sirve para las rutas `*-for-enrollment`: `resolveUnregisteredIdentity` solo mira el tipo (`public-booking.routes.ts:484-500`). El gate de H4 debe aplicarse por escuela en cada uso, sin importar de qué flujo salió el token. `PublicFacilityBookingPage.tsx` no usa esas rutas, así que no se rompe.
4. **Regla de menor.** `_invitacion_ficha_es_de_acudiente(uuid, text)` es accesible para `service_role` (`20261005135518:52-78`). Pero, sin fecha de nacimiento, solo devuelve `true` si el correo es el del acudiente y no el de la ficha. En este link el correo es siempre el de la ficha, así que una ficha sin fecha pasa como adulto: la decisión D3 se resuelve en el BFF.
5. **Rollback de cuenta.** `profiles_id_fkey` apunta a `auth.users` sin `ON DELETE CASCADE`. Para deshacer una cuenta hay que borrar primero el `profiles` y después el usuario de `auth`.
6. **Mismo bug de IP fuera del link.** Más limitadores usan `req.ip`: `cobro-enlace-publico.routes.ts` (7), `tournament-live.route.ts` (3) y `devices.routes.ts`. Ya hay tres copias de la lógica de IP real: `storeClientIp`, `reservationsClientIp` (`public-reservations.routes.ts:59`) y `clientIp` en `access-adms.ts`. Se propone otro ítem (§7).
7. **Cloudflare.** Que Render solo se alcance por Cloudflare, incluso en `*.onrender.com`, ya está verificado en `SEG-28` (ROADMAP:2019). `CF-Connecting-IP` es confiable.
8. **Línea citada.** `publicBookingLimiter` está en `index.ts:381`, no en `:373`.

## 2. Diseño por hallazgo

### H5. IP real en los limitadores del link

- **Utilidad única.** `bff/src/utils/clientIp.ts` con `clientIp(req)`: `CF-Connecting-IP` → `True-Client-IP` → `req.ip` → `socket.remoteAddress`. `storeClientIp` pasa a reexportarla. `access-adms.ts` y `bridgeWsServer.ts` no se tocan: tienen reglas de allowlist propias y riesgo de torniquetes.
- **Llaves.** `otpStartLimiter`: `otp-start-${ipKeyGenerator(clientIp(req))}`. `publicBookingLimiter` (`index.ts:381`): agregar el mismo `keyGenerator`. Los topes no cambian.
- **Pruebas.** `bff/src/utils/clientIp.test.ts` y un test del router copiando `storeRateLimit.test.ts` (express en puerto efímero, `trust proxy` 1, cabeceras distintas con el mismo `req.ip`).

### H4. Un solo gate del autoservicio

- **Helper.** `assertTrialLinkOpen(schoolId)`: lee `school_trial_class_settings` y exige `enabled` y `self_service_enabled`; si no, `422 { reason: 'link_disabled' }`.
- **Dónde se llama:**
  - En `/trial-start-verification`, después de validar el correo y **antes** del anti-flood y de `already_registered`. Así la respuesta de una escuela apagada es la misma para cualquier correo.
  - Dentro de `resolveUnregisteredIdentity`, con `verif.school_id`. Eso cubre `/available-for-enrollment`, `/book-for-enrollment`, `/my-bookings-for-enrollment`, `/cancel-for-enrollment` y `/hour-bank-balance-for-enrollment`.
  - En `/register-unregistered`.
  - En `/trial-slots` y `/trial-confirm` por defensa, aunque la RPC ya lo revisa.
- **No se toca:** `/verify-otp`, que es genérico; ni `/start-verification`, `/slots` y `/confirm`, que son de `/agendar/:slug` con su propio permiso.
- **`/schools/:slug`.** Agrega `trial_link_enabled: boolean`. Hoy solo existe `trial_classes_available`, que exige categorías: Dreamers tiene el link encendido con 0 categorías.
- **Frontend.** Si `trial_link_enabled` es `false`, se muestra el paso `link_disabled` con el texto de D5 y un enlace a `/login`. No se usa el login en línea: la cuenta agenda desde «Mis Inscripciones», que no depende del flag. El error `link_disabled` en cualquier paso posterior lleva a ese mismo paso.

### H3. Menores no reciben cuenta de atleta

- **Validación en `/register-unregistered`, antes de `createUser`.** Se busca la ficha con `is_active`, `linked_profile_id`, `date_of_birth` y `guardian_full_name`, y se rechaza si está inactiva o vinculada. Se considera menor si `rpc('_invitacion_ficha_es_de_acudiente', { p_unregistered_athlete_id, p_email })` devuelve `true`, o si `date_of_birth IS NULL AND guardian_full_name IS NOT NULL` (D3). En ese caso: `409 { reason: 'minor_requires_guardian_invite' }`.
- **Orden para adultos:** `createUser` → `UPDATE profiles` → `migrate_unregistered_athlete_to_profile`. Si la migración falla: `DELETE profiles` → `auth.admin.deleteUser` → `500` con un mensaje de reintento. Si el rollback falla, se registra el `user_id` huérfano en el log de error. Ese tramo sigue sin ser atómico (Auth no participa de la transacción): es un riesgo aceptado y queda registrado.
- **Frontend.** En `enrolled_choice`, con el 409 se oculta «Crear mi cuenta» y se muestra: «Pídele a la escuela que te invite como acudiente». «Agendar sin crear cuenta» sigue disponible (D2).
- **Sin migración.** La copia al acudiente de D2 (correo de confirmación a `guardian_email`) va en el `postSuccess` de `/book-for-enrollment` (`public-booking.routes.ts:537`).

### H1 y H2. Cupos atómicos sin cuenta

**Migración** (una sola, `npm run migrations:new -- seg31_cupos_reserva_sin_cuenta`):

1. **Columna.** `ALTER TABLE session_bookings ADD COLUMN credit_enrollment_id uuid NULL REFERENCES enrollments(id)` e índice parcial `WHERE credit_enrollment_id IS NOT NULL`. No choca con `chk_booking_identity` ni con `check_hybrid_booking`, que solo restringen `enrollment_id`, `user_id`, `child_id` y `unregistered_athlete_id`. **Por qué una columna:** sin ella, la cancelación tendría que adivinar con `findCreditEnrollment`, que es una heurística y falla con varias inscripciones.
2. **RPC `book_session_with_credit`.** Recibe `p_school_id`, `p_session_id`, `p_enrollment_id`, `p_user_id`, `p_child_id`, `p_unregistered_athlete_id`, `p_is_secondary`, `p_hour_bank_reservation_id` y `p_today` (fecha de Bogotá). `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`. Orden:
   - `SELECT … FROM enrollments WHERE id = p_enrollment_id FOR UPDATE`, más su plan.
   - Valida `status='active'` y `expires_at >= p_today` (también en planes de horas, D4). En planes por cupos, `sessions_used < max_sessions` o la bolsa secundaria. Si algo falla, lanza `enrollment_not_active`, `plan_expired` o `no_credits`.
   - `INSERT` de la reserva: `enrollment_id` según la identidad, como hoy, y `credit_enrollment_id = p_enrollment_id` siempre. El trigger `fn_process_session_booking` sigue corriendo: con cuenta revalida contra `sessions_used` aún sin incrementar, así que no rechaza el último cupo.
   - Si no es plan de horas: `move_session_credit(p_enrollment_id, 1, p_is_secondary)` dentro de la misma transacción.
   - Devuelve la fila de la reserva.
3. **RPC `cancel_session_booking_with_credit`.** Recibe `p_booking_id` y la identidad. Hace `UPDATE … SET status='cancelled' … WHERE id=… AND status='confirmed' AND <identidad> RETURNING …`. Si no actualiza nada, la reserva ya estaba cancelada o es ajena: así se cierra la doble cancelación. Devuelve el crédito con `coalesce(enrollment_id, credit_enrollment_id)` y `move_session_credit(-1)`, o con `cancel_hour_bank_reservation` si hay `hour_bank_reservation_id`. Responde `{ cancelled, credit_returned }`.
4. **`migrate_unregistered_athlete_to_profile`.** Partiendo del **cuerpo vivo** (gotcha de `apply_late_fees`), en las dos ramas de `session_bookings` agregar `enrollment_id = credit_enrollment_id`.
5. **Grants de las dos RPC nuevas.** `REVOKE ALL … FROM PUBLIC, anon, authenticated` y `GRANT EXECUTE … TO service_role`. Solo las llama el BFF.
6. **Sin backfill:** no hay reservas sin cuenta confirmadas a futuro (§2 de la spec).

**BFF (`session-bookings.ts`):**

- **Prechequeo no autoritativo.** `validateEnrollmentOwnership` (`:237`) devuelve también `expires_at`, `sessions_used` y el plan. `bookSession` corta con 422 **antes** de la rama `avail_`, para no estirar sesiones (`:1308-1400`) que luego se rechazan.
- **Reserva y crédito.** Los pasos 4 y 5 (`:1802-1833`) se reemplazan por `rpc('book_session_with_credit')`. Se conserva la compensación existente: si la RPC falla, `cancel_hour_bank_reservation` (`:1820-1823`), y los motivos se traducen a 422 con `reason`. Vale para las tres identidades: un solo criterio, y la ruta autenticada gana validación explícita.
- **Cancelación.** En `cancelSessionBooking`, el `UPDATE` y el reembolso (`:2086-2101`) pasan a `rpc('cancel_session_booking_with_credit')`. Si `credit_returned` es `false` y no es plan de horas, se registra un error con `booking_id`. El estiramiento de bloques (`:2103-2148`) queda igual.
- **Listado.** `listAvailableSessions` (`:528`) lee `expires_at` y marca `booking_status: 'plan_expired'` en las sesiones de esa inscripción.

**Frontend:** muestra `reason` en lugar de un error genérico, en `PublicTrialClassBookingPage.tsx` y en el hook de «Mis Inscripciones», si este no lo hace ya.

## 3. Fases

| Fase | Contenido | Migración | Esfuerzo | Agentes |
|---|---|---|---|---|
| **F1** | H5 + H4: `clientIp`, limitadores, gate, `trial_link_enabled`, paso `link_disabled` | No | **S** (1 d) | `sm-backend-dev`, `sm-frontend-dev` → `sm-security-auditor` → `sm-code-reviewer` → `sm-qa-engineer` |
| **F2** | H3: chequeo de menor, rollback de cuenta, copia al acudiente, mensaje | No | **S** (½–1 d) | Los mismos |
| **F3** | H1 + H2: columna, 2 RPC, ajuste de migración de ficha, `bookSession`/`cancelSessionBooking`/listado | **Sí**, 1 | **M** (2–3 d) | `sm-db-architect` → `sm-backend-dev` → `sm-security-auditor` (revisa la migración línea por línea) → `sm-code-reviewer` → `sm-qa-engineer` |

**Orden y por qué.** F1 primero: sin migración, cierra el link en toda escuela que no lo encendió, así que H1-H3 quedan acotados a Academia Superior y Dreamers. F2 después: es corto, no toca la base y evita el daño más difícil de deshacer (cobros mal asignados). F3 al final: es la única con DDL y la que toca cupos de las rutas autenticadas. **Hasta cerrar F3, no difundir el link en Dreamers.**

Cada fase va en su rama desde `develop`, se revisa y se integra a `develop`. Nunca a `main`.

### Pruebas por fase

- **F1:** tests de `clientIp` y de los dos limitadores. Tests del router con `supabase` simulado: OTP bloqueado, token emitido y luego apagado, encendido sin cambios, y la misma respuesta con y sin cuenta. Recorrido en el navegador con el BFF local en Academia Superior encendida y en una escuela apagada.
- **F2:** tests de `/register-unregistered` para menor por fecha, sin fecha con acudiente, adulto, migración fallida con rollback, ficha vinculada e inactiva.
- **F3:**
  - Tests unitarios de `bookSession`/`cancelSessionBooking` con RPC simulada, siguiendo `niveles-ff.test.ts`.
  - **Concurrencia en SQL:** dos sesiones llaman `book_session_with_credit` sobre una inscripción con 1 cupo, y dos cancelaciones simultáneas de la misma reserva. Se corre en el gemelo local (Docker, `plan-ejecucion-ecosistema-2026-10.md:25`). Si no está disponible, en la base compartida con una inscripción de prueba en Academia Superior, un script que limpie sus filas y verifique la limpieza, y una sola sesión aplicando DDL.
  - Regresión de la ruta autenticada: los tests existentes de `session-bookings` más un recorrido real en «Mis Inscripciones».

## 4. Despliegue

| Fase | Orden | Ventana de compatibilidad |
|---|---|---|
| F1 | BFF → frontend | Frontend viejo con BFF nuevo: el 422 `link_disabled` se ve como error genérico. Aceptable por minutos |
| F2 | BFF → frontend | Frontend viejo: el 409 se ve como error genérico. Ningún menor recibe cuenta mientras tanto |
| F3 | Migración (aditiva) → `types.ts` una sola vez → BFF | BFF viejo con base nueva: funciona igual, ignora la columna. Sin frontend obligatorio |

Migraciones con `npm run migrations:new` y `migrations:check`. Aplicarlas desde una sola sesión y por una vía con rastro (CLI o `apply_migration`). Después de aplicar F3: `npm run seguridad:invariantes` y verificar `proacl`/`proconfig` de las dos RPC en `pg_proc`.

## 5. Riesgos

- **F3 toca la ruta autenticada.** `bookSession`/`cancelSessionBooking` atienden «Mis Inscripciones», el link y los tests de niveles. Una regresión deja sin agendar a todas las escuelas. Mitigación: tests existentes más los nuevos y recorrido real antes del deploy.
- **Trigger y RPC.** El trigger `fn_process_session_booking` sigue validando por su cuenta. Si alguna vez se cambia el orden (consumir antes de insertar), rechazaría el último cupo. Dejarlo comentado en la RPC.
- **Rollback de Auth no atómico (F2).** Riesgo aceptado: queda registrado en el log.
- **Migración de ficha.** Se redefine desde el cuerpo vivo, no desde el repo.
- **Trabajo paralelo.** `c3023775`/`af319d28` del 2026-11-06 tocan reservas web de invitado. Revisar conflictos al abrir cada rama.

## 6. Qué cambia si D1-D5 se deciden distinto

| Decisión | Alternativa | Efecto en el plan |
|---|---|---|
| D1 | Crear cuenta de acudiente | F2 crece a **M**: buscar por `guardian_email`, elegir hijo y `migrate_…` con `p_new_child_id`. Pasa a la iteración posterior |
| D2 | Menor no agenda sin cuenta | F2 bloquea también `*-for-enrollment` para menores. Sin migración |
| D2 | Cancelar con el link apagado | F1 deja `/cancel-for-enrollment` y `/my-bookings-for-enrollment` fuera del gate |
| D3 | Sin fecha = adulto | Se quita la segunda condición del chequeo |
| D4 | No bloquear planes de horas vencidos | La RPC valida `expires_at` solo en planes por cupos |
| D5 | Mostrar contacto de la escuela | F1 agrega campos públicos a `/schools/:slug`; revisar qué datos son publicables (trampa 4 de `CLAUDE.md`) |

## 7. Fuera de este plan, para el ROADMAP

- **IP de borde en otros limitadores** (`cobro-enlace-publico`, `tournament-live`, `devices`): misma causa que H5. Ítem nuevo, que reutiliza la utilidad de F1.
- **Prioridad media de la revisión del 2026-11-06** (lista en la spec, §3).
