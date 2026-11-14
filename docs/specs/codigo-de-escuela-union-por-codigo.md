# Código de escuela — unirse después de registrarse

**Estado:** construido de corrido (DB + RLS + RPCs + UI) · 2026-10-26 · decisiones D1–D5 aprobadas (§8). Migración `20261026132948_codigo_de_escuela.sql` escrita, **pendiente de aplicar** (la aplica el responsable; las pruebas SQL van comentadas al final del archivo).
**Origen:** caso Besser / Isabella Millán (2026-10-26).

## 1. El problema

Hoy una persona puede crear su cuenta en SportMaps sin quedar unida a ninguna escuela, y desde ahí **no tiene forma de llegar a su escuela**. La escuela tampoco se entera de que existe.

Las entradas que existen hoy no cubren a quien **ya tiene cuenta**:

| Entrada | Qué hace | Por qué no sirve aquí |
|---|---|---|
| Invitación de la escuela | La escuela invita un correo | La escuela tiene que saber antes que esa persona existe |
| QR de inscripción (`/join/:slug`, `school_join_qr_codes`) | Registro nuevo + ficha + inscripción `pending` + **cobro** | Es para entrar desde cero; además cobra antes de que la escuela asigne categoría |
| Prospectos (`/inscripcion/:slug`, `school_signup_leads`) | Formulario público sin login | No liga la cuenta; la pantalla de la escuela (F1) nunca se construyó |

**Medido en vivo el 2026-10-26:** 164 cuentas reales (`is_demo = false`) de rol `parent` o `athlete` no tienen membresía, ni hijos, ni inscripción, ni invitación pendiente: 115 deportistas y 49 acudientes. **34 se crearon en los últimos 60 días.**

Caso testigo: `elika2013s@gmail.com`. La mamá creó la cuenta como acudiente el 30-sep. Un minuto después el perfil se renombró a la deportista (16 años). La cuenta quedó sin hijos y sin escuela, entró una sola vez y Besser no sabe que existe.

## 2. La propuesta en una línea

Cada escuela tiene un **código corto** (`BES-4K7Q`). Quien ya tiene cuenta lo ingresa y queda de inmediato en la bandeja **«Por asignar»** de esa escuela. Ahí la escuela elige la **categoría (equipo)**, y con eso queda también el entrenador. Hasta ese momento **no se crea inscripción ni cobro**.

## 3. Flujo

### Escuela
1. **Estudiantes → «Código de la escuela»**: tarjeta con el código, botón copiar, compartir por WhatsApp, QR imprimible (que abre `/unirse?codigo=BES-4K7Q`) y «Cambiar código» (el anterior deja de servir).
2. **Estudiantes → «Por asignar (N)»**: lista de solicitudes con nombre, edad, categoría sugerida por la familia y fecha. Por cada una:
   - **Asignar a un equipo.** El entrenador es el del equipo (`team_coaches`), así que no hace falta un paso aparte.
   - **«Ya tiene ficha»**: si existe una ficha del mismo nombre en la escuela (por ejemplo, cargada por la escuela sin acudiente), se ofrece **vincular** la cuenta a esa ficha en vez de crear otra. Esto evita las identidades duplicadas que ya nos costaron (ver `project_duplicate_athlete_identities`).
   - **Rechazar**, con motivo opcional.
3. Aviso a los administradores de la escuela cuando entra una solicitud, por el despachador de notificaciones.

### Familia o deportista
1. Al terminar el onboarding de `parent` o `athlete` aparece el paso opcional **«¿Ya tienes escuela? Ingresa su código»**. Si la cuenta no tiene ninguna escuela, también aparece un aviso en el inicio y en «Mis hijos».
2. Al escribir el código se muestra **nombre y logo de la escuela** para confirmar («¿Es Club Deportivo Besser?»).
3. **¿Para quién es?** Hay dos opciones: «Para mí» o «Para mi hijo(a)». En los dos casos se pide nombre, fecha de nacimiento y una categoría sugerida (texto libre, opcional). Así se corrige el caso Isabella: la cuenta de la mamá queda como acudiente y la deportista como hija.
4. Pantalla de «Solicitud enviada — Besser te asignará la categoría». Cuando la escuela asigna, llega un aviso y el inicio pasa a mostrar la escuela.

## 4. Modelo de datos (propuesta F1)

Todas las tablas son nuevas, con estados `text + CHECK` y FKs a `profiles(id)`.

**`school_join_codes`**
- `id`, `school_id` → `schools`, `branch_id` (opcional, ver D2), `code text UNIQUE`, `active boolean`, `uses_count int`, `created_by` → `profiles`, `created_at`, `revoked_at`.
- Formato: prefijo de 3 letras + 4 caracteres de un alfabeto sin ambiguos (sin `0/O/1/I/L`). Se normaliza a mayúsculas y sin guiones al validar.
- Un solo código activo por escuela (índice único parcial `WHERE active`).

**`school_join_requests`**
- `id`, `school_id`, `join_code_id`, `requester_profile_id` → `profiles`.
- `for_whom text CHECK (for_whom IN ('self','child'))`, `athlete_name`, `birth_date`, `suggested_category`.
- `status text CHECK (status IN ('pending','assigned','linked','rejected','cancelled'))`.
- `assigned_team_id`, `child_id`, `enrollment_id`, `resolved_by`, `resolved_at`, `reject_reason`, `created_at`.
- Índice único parcial: una sola `pending` por `(school_id, requester_profile_id, normalize_athlete_name(athlete_name))` (la misma normalización inmutable que usan los guardas de duplicados; `unaccent` no es inmutable).
- Al construir se agregó `assigned_branch_id` (D2) y `updated_at`, más la tabla `school_join_code_attempts` para el límite de intentos.

**¿Por qué no reusar `school_signup_leads`?** Un prospecto es anónimo y sin cuenta, y una solicitud ya trae cuenta y debe terminar ligada a ella. El dato es distinto y, desde el 2026-10-29, tampoco se ven en la misma bandeja (ver D1).

## 5. RPCs (todas `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`)

| RPC | Quién | Qué hace |
|---|---|---|
| `preview_school_join_code(p_code)` | `authenticated` | Devuelve solo nombre, logo y ciudad. Tiene límite de intentos por usuario para que no se puedan adivinar códigos. |
| `submit_school_join_request(p_code, p_for_whom, p_name, p_birth_date, p_category)` | `authenticated` | Crea la solicitud `pending`, suma `uses_count` y avisa a los admins. |
| `cancel_school_join_request(p_id)` | quien la creó | Solo si sigue `pending`. |
| `list_school_join_requests(p_school)` | staff de la escuela | Bandeja «Por asignar», con las fichas candidatas a vincular. |
| `resolve_school_join_request(p_request_id, p_action, p_team_id, p_branch_id, p_child_id, p_reason)` | admin de la escuela | **Transaccional:** asignar crea la ficha (si es `child`, con `parent_id` = quien pidió; si la familia ya tenía esa ficha en su cuenta sin escuela, la adopta) o la membresía de atleta (`self`); vincular pone `parent_id` en la ficha existente; rechazar solo cambia el estado. Bloquea la solicitud con `FOR UPDATE` para que dos admins no la resuelvan dos veces (el segundo recibe `55000` «ya fue resuelta»). **No crea inscripción ni cobro**: devuelve `needs_enrollment` (ver «Camino de inscripción»). |
| `confirm_school_join_request_enrollment(p_request_id)` | admin de la escuela | Después del alta por el BFF, amarra la inscripción a la solicitud y la saca de la bandeja. Idempotente. |
| `get_school_join_code(p_school)` | admin de la escuela | Devuelve el código activo (lo crea si la escuela es posterior al backfill). |
| `rotate_school_join_code(p_school)` | admin de la escuela | Revoca el código activo y crea uno nuevo. |
| `my_school_join_status()` | `authenticated` | ¿La cuenta tiene escuela? + sus solicitudes recientes (aviso del inicio y de «Mis hijos»). |

- `GRANT EXECUTE … TO authenticated` explícito, y `REVOKE` explícito de `anon` y `authenticated` donde no aplica (los default privileges otorgan `EXECUTE` solos).
- **La inscripción NO se crea con un INSERT propio.** No se suma un camino 14 que cree cobros (ver el censo de 13 caminos).
- El monto y el primer cobro siguen la regla normal de la escuela: la escuela decide el precio.

### Camino de inscripción (decidido al construir)

«Agregar atleta» en Atletas (`CreateChildModal` / `CreateAdultAthleteModal`) **no es una RPC**: es `POST /api/v1/students/create-one` del BFF, que calcula la cuota y el primer cobro en TypeScript (`buildAltaPayments`, `calcFirstPayment`, clases restantes, inscripción/seguro del plan) y escribe inscripción + cobros en una sola transacción con la RPC `create_enrollment_with_payments`. Llamar `create_enrollment_with_payments` desde SQL habría obligado a reescribir ese cálculo en SQL (un segundo cálculo de cobros = el origen de los duplicados).

Por eso se reutiliza **el mismo endpoint**, igual que ya lo hace la bandeja de hojas de matrícula (`EnrollmentIntakeInboxPage`):

1. `resolve_school_join_request` (RPC, transaccional, `FOR UPDATE`) crea o vincula la **ficha** — `children` con `parent_id` = quien pidió — o, en el caso «para mí», la membresía `school_members` de atleta. Sin inscripción, sin cobro.
2. Si devuelve `needs_enrollment = true`, la bandeja llama a `POST /api/v1/students/create-one` con `type: 'child_existing'` (`child_id`) o `type: 'adult_existing'` (`user_id`), con el equipo, la sede, el plan opcional y la fecha de inicio. Para `child_existing` se manda `monthly_fee` = precio del plan si se eligió plan, si no el del equipo — exactamente la precedencia del alta de un menor (`child`): ese ramal solo cobra con `monthly_fee` explícito.
3. `confirm_school_join_request_enrollment` amarra la inscripción a la solicitud.

Si el paso 2 falla (periodo ocupado, plan ajeno, BFF caído), la solicitud queda asignada y aparece en la bandeja como **«Falta inscribir»** para reintentar; un reintento no duplica cobros porque `create-one` no crea otra inscripción si ya hay una activa y `create_enrollment_with_payments` rechaza un periodo ya cobrado (`periodo_ocupado`).

## 6. RLS

- Escritura en las dos tablas: **ninguna policy** desde el cliente; todo pasa por las RPCs.
- Lectura de `school_join_requests`: quien la creó ve las suyas; la escuela ve las suyas con `user_staff_school_ids()`. Nunca `user_school_ids()`, que incluye padres y atletas.
- Lectura de `school_join_codes`: solo `user_admin_school_ids()`. El público solo conoce el código por la RPC de vista previa.
- Al cerrar F1 se corre `npm run seguridad:invariantes` y se listan **todas** las policies de las dos tablas.

## 7. Fases

| Fase | Contenido | Entregable |
|---|---|---|
| F0 | Este spec + decisiones | Aprobación |
| F1 | DB + RLS + RPCs + pruebas (incluida la de concurrencia de `resolve`) | Plan de migración aprobado → migración por `npm run migrations:new` |
| F2 | UI de la familia: paso en el onboarding, aviso en el inicio y en «Mis hijos», `/unirse?codigo=` | Probado con una cuenta real sin escuela |
| F3 | UI de la escuela: tarjeta del código, bandeja «Por asignar», avisos | Probado con Besser |
| F4 | Recuperar las 164 cuentas: aviso único en el inicio de las cuentas sin escuela + manual de una página para que las escuelas compartan su código | — |

## 8. Decisiones (resueltas 2026-10-26)

- **D1. RESUELTA — una sola bandeja en pantalla, datos separados.** «Por asignar (N)» muestra las solicitudes por código (`school_join_requests`) y los prospectos abiertos (`new`/`contacted`) del formulario público (`school_signup_leads`, con las RPCs `list_school_leads` / `update_school_lead_status` que ya existían sin UI). Un prospecto no tiene cuenta: desde la bandeja se contacta y se marca (contactado / inscrito / descartado); para inscribirlo se usa «Agregar atleta» o se le comparte el código.
  - **Revisada 2026-10-29 — los prospectos salen de «Por asignar».** Ahora la bandeja muestra solo las solicitudes por código. Al bot de WhatsApp nadie lo había tenido en cuenta: desde el 2026-10-06 registra en `school_signup_leads` a todo desconocido que escribe. En Dynasty, 80 de los 84 prospectos abiertos eran de WhatsApp y la tarjeta decía «Formulario público» a todos. Su «Contactado» significaba que respondió el bot, no la escuela. Además eran los mismos de la pestaña «Clase de prueba» (mig. `20261026155701`), que sí muestra el canal y el cupo reservado. Los prospectos quedan solo en esa pestaña, que ganó el botón de WhatsApp. La bandeja deja un enlace con el número. `list_school_leads` / `update_school_lead_status` siguen en la base, pero ya no los usa ninguna pantalla.
- **D2. RESUELTA — un código por escuela; la sede se elige al asignar** (`p_branch_id`, por defecto la sede del equipo). `school_join_codes.branch_id` queda en la tabla, siempre `NULL`.
- **D3. RESUELTA — solo administración asigna** (`user_admin_school_ids()`: owner/admin/school_admin). El staff (coach incluido) puede leer la bandeja por RLS, pero no resolver; la UI solo la muestra a administración.
- **D4. RESUELTA — se sigue la regla de cobro actual de la escuela.** El primer cobro lo calcula el mismo alta de «Agregar atleta» (ver «Camino de inscripción»); no hay regla nueva.
- **D5. RESUELTA — el código no vence, pero se puede cambiar** («Cambiar código»: el anterior deja de servir de inmediato y nunca se reasigna a otra escuela).

## 9. Lo construido

- **Migración** `supabase/migrations/20261026132948_codigo_de_escuela.sql`: tablas `school_join_codes`, `school_join_requests`, `school_join_code_attempts` (límite: 8 códigos inválidos en 15 min por usuario); RLS sin policies de escritura; lectura de códigos solo `user_admin_school_ids()`, de solicitudes quien la creó o `user_staff_school_ids()`; RPCs de §5; backfill de un código por escuela. Código: prefijo de 3 letras del nombre saltando palabras genéricas («Club Deportivo Besser» → `BES`) + 4 de `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, único con reintento.
- **Escuela:** Atletas → tarjeta «Código de la escuela» (copiar, enlace, WhatsApp, QR descargable, cambiar) y bandeja «Por asignar (N)» con Asignar / Ya tiene ficha / Rechazar / Falta inscribir, y los prospectos. Aviso a la administración por `notifications` (categoría `enrollment`, link `/students?bandeja=por-asignar`).
- **Familia:** `/unirse?codigo=…` (sin sesión guarda el código y lo retoma tras entrar o registrarse), paso opcional en el onboarding de acudiente y deportista, y aviso en el inicio y en «Mis hijos» para cuentas sin escuela (con el estado de sus solicitudes).
- **Pendiente de F4:** el manual de una página para las escuelas y medir cuántas de las 164 cuentas usan el código.
