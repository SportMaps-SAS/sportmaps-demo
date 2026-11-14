# Spec — Correcciones de prioridad alta del link de agendamiento

**Producto:** SportMaps · **ID de roadmap:** `SEG-31` · **Fecha:** 2026-11-06
**Estado:** decisiones D1-D5 aprobadas con la recomendación (2026-11-07). **F1, F2 y F3 construidas y probadas en el repo, sin commitear ni desplegar. Las dos migraciones de F3 están SIN APLICAR** y requieren aprobación. Durante F3, seguridad encontró y se cerraron cinco fallas más del mismo dominio que ya existían (C1, C2, R1, R2, R3; ver el plan).

> **Ajuste a D3 durante F2 (2026-11-07):** sin fecha de nacimiento, «Crear cuenta» se bloquea **siempre**, haya o no acudiente. Era la opción más segura y la auditoría la exigió: la regla «solo si hay nombre de acudiente» dejaba pasar a un menor con solo correo o teléfono de acudiente. En vivo afecta a 7 de 89 fichas alcanzables, ninguna con datos de acudiente. La copia del correo al acudiente (D2) se envía **solo para menores**: 13 adultos alcanzables tienen un correo de emergencia que no debe recibirla.
**Plan técnico:** [`docs/plan-link-agendamiento-correcciones-alta.md`](../plan-link-agendamiento-correcciones-alta.md)
**Spec relacionada:** [`mis-inscripciones-agenda-clases-prueba.md`](mis-inscripciones-agenda-clases-prueba.md)

## 1. Objetivo

Antes de difundir `/agendar-clase/:slug`, garantizar que quien se identifica por correo y OTP no pueda:

- perder cupos al cancelar (H1);
- consumir un plan vencido o agotado (H2);
- convertir a un menor en cuenta `athlete` (H3);
- usar el link cuando la escuela lo apagó (H4);
- compartir cupo de rate limit con desconocidos (H5).

Es una corrección preventiva: las fallas salen de leer el código y las funciones vivas, y ninguna se reprodujo escribiendo en la base.

## 2. Evidencia en la base viva (2026-11-06, solo lectura)

| Medición | Resultado | Qué implica |
|---|---|---|
| OTP del link por escuela | 43, todos de Academia Superior Bogotá (escuela de pruebas); el último del 2026-09-17 | Ninguna escuela real ha usado el camino sin cuenta |
| Cuentas creadas desde el link | 0 | H3 no requiere reparación de perfiles |
| Reservas sin cuenta futuras y activas | 0 (14 `attended`, 2 `cancelled`) | H2 no deja reservas que revisar |
| Reservas con cuenta futuras ligadas a plan vencido | 0 | Igual que arriba |
| Cancelación sin cuenta y sin banco de horas | 1, con `cancelled_at` vacío | `cancelSessionBooking` siempre llena ese campo: **no salió de esta ruta**. Corrige la revisión anterior, que la contaba como afectada |
| Doble descuento en el cierre de asistencia | No ocurre | Con reserva del día la asistencia la marca `attended` sin tocar el saldo (`attendance-credits.ts:302-362`) |
| Fichas activas sin cuenta | 343; 97 alcanzables con correo exacto | 64 de las 112 con correo son menores por edad; 78 tienen acudiente |
| Inscripciones alcanzables | 21 por cupos, 19 vencidas con `status='active'`, 4 sin cupo | Exposición si se difunde el link |
| Self-service | Encendido en Academia Superior y Dreamers (0 categorías). Monster: `enabled=true`, `self_service=false` | H4 hoy deja el camino de fichas abierto en cualquier escuela con slug |

## 3. Alcance

**Entra:** H1 a H5 en `public-booking.routes.ts`, `session-bookings.ts`, `index.ts` y `PublicTrialClassBookingPage.tsx`, con la migración que haga falta y sus pruebas.

**No entra (prioridad media, sigue en la revisión del 2026-11-06):** reprogramar; tope de cancelación por coach; fichas sin correo, con mayúsculas o solo con correo del acudiente; `/confirm`; clases de prueba con fechas pasadas; dos fichas con el mismo correo; mensaje «Ya tienes matrícula» para fichas sin inscripción activa; endurecimiento del OTP.

**Iteración posterior:** acudiente que entra con `guardian_email` y elige entre varios hijos.

**Multi-tenant:** H1, H2, H3 y H5 aplican igual a todas las escuelas, sin configuración nueva. H4 usa `school_trial_class_settings.enabled` y `.self_service_enabled`, sin columnas nuevas.

## 4. Hallazgos, historias y criterios de aceptación

### H1. Cancelar sin cuenta devuelve el crédito

**Causa.** `session-bookings.ts:1811` guarda `enrollment_id=NULL` porque lo exige `chk_booking_identity`. `:2098` llama `move_session_credit` con ese NULL, que responde `{moved:false}` sin error. `:1830` sí había consumido el crédito. La reserva no recuerda de qué inscripción salió, así que con varias inscripciones no se puede deducir al cancelar.

**Historia.** Como persona sin cuenta con plan por cupos, quiero que al cancelar me devuelvan la clase.

**Criterios.**
- Reserva hecha por `/book-for-enrollment` con `sessions_used=n`: al cancelar queda `cancelled` y `sessions_used=n-1`.
- Reserva con `hour_bank_reservation_id`: se llama `cancel_hour_bank_reservation` y no se toca `sessions_used`.
- Repetir la cancelación responde 400 y no cambia el saldo, también con peticiones simultáneas.
- Reserva de otra ficha: 403 sin mover crédito.
- Si el crédito no se puede devolver, no se silencia: queda registrado con el id de la reserva y la respuesta indica que la escuela debe revisar.

### H2. Agendar sin cuenta valida vencimiento y cupos

**Causa.** `fn_process_session_booking` solo valida si `NEW.enrollment_id` no es NULL. `bookSession` no lo repite, aunque `/confirm` sí (`public-booking.routes.ts:824-839`). `listAvailableSessions` no lee `expires_at`. Además, `bookSession` ignora el resultado de `move_session_credit`, que recorta al tope sin error: una ficha sin cupos reserva con éxito y no se descuenta nada. En planes de horas, ni `reserve_hour_bank` ni `get_or_open_hour_bank_period_at` ni `move_hour_bank` leen `expires_at`.

**Historia.** Como dueño o admin de academia, quiero que un plan vencido o agotado no permita reservar por el link.

**Criterios.**
- Inscripción con `expires_at` anterior a hoy (Bogotá): 422 `plan_expired`, sin reserva ni reserva de banco de horas.
- `sessions_used >= max_sessions`: 422 `no_credits`, sin reserva.
- `status` distinto de `active`: 422 `enrollment_not_active`.
- Plan de horas sin saldo: rechazo con el mismo contrato. Vencido: según D4.
- Con 1 cupo y dos peticiones simultáneas, exactamente una reserva queda `confirmed`.
- Si la única inscripción activa no sirve, el listado da el motivo y no ofrece reservar.
- La ruta autenticada conserva su comportamiento y sus pruebas siguen pasando.

### H3. «Crear cuenta» no convierte a un menor en atleta

**Causa.** `/register-unregistered` (`public-booking.routes.ts:385-473`) crea siempre `role='athlete'`, contra la regla de `20261005135518_invitacion_ficha_menor_va_al_acudiente.sql`. Esa migración documenta la consecuencia: con un acudiente como atleta, las fichas de las hermanas pasan a su `user_id` y `open_month` emite un solo cobro por dos niñas. Además, si falla `migrate_unregistered_athlete_to_profile`, la cuenta queda sin historial y se responde éxito (`:443`).

**Historia.** Como acudiente, quiero que la cuenta de mi hijo menor siga la regla de la escuela, para que cobros y datos queden bien.

**Criterios.**
- Ficha de menor: no se crea usuario; responde 409 `minor_requires_guardian_invite`, y la página dice qué hacer.
- Ficha de adulto: sin cambios cuando todo sale bien.
- Migración fallida: no se responde éxito ni queda un usuario huérfano que bloquee el correo.
- Ficha inactiva o ya vinculada: se rechaza.

### H4. Autoservicio apagado apaga el link para todos

**Causa.** `/trial-start-verification` (`:1023-1059`) manda OTP sin revisar el permiso. Tampoco lo revisan `/available-for-enrollment`, `/book-for-enrollment`, `/my-bookings-for-enrollment`, `/cancel-for-enrollment`, `/hour-bank-balance-for-enrollment` ni `/register-unregistered`. Solo el camino de persona nueva lo revisa (`:1068`).

**Historia.** Como dueño o admin, quiero que al apagar el autoservicio nadie use el link.

**Criterios.**
- Con `enabled=false`, `self_service_enabled=false` o sin fila: 422 `link_disabled`, sin crear verificación ni enviar correo, y sin revelar si el correo existe.
- Un `booking_token` emitido antes de apagar deja de servir: el permiso se lee en cada llamada.
- Encendido: sin cambios.
- La página muestra el aviso antes de pedir el correo.
- **Cancelar por token con el link recién apagado:** según D2.

### H5. Límite de peticiones por cliente real

**Causa.** `otpStartLimiter` (`public-booking.routes.ts:12-16`) y `publicBookingLimiter` (`index.ts:381`) usan `req.ip`, que detrás de Cloudflare es la IP de borde. Usuarios no relacionados comparten 5 inicios de OTP cada 10 minutos y 200 peticiones cada 15, y quien rote de borde esquiva el tope. Es la misma causa de `SEG-28`, que ya documenta y verifica que Cloudflare va delante, incluso en `*.onrender.com`.

**Historia.** Como usuario del link, quiero que desconocidos no consuman mi cupo.

**Criterios.**
- Mismo `req.ip` y distinto `CF-Connecting-IP`: cuentan por separado.
- Mismo `CF-Connecting-IP`: el 6.º inicio en 10 minutos y la petición 201 en 15 reciben 429.
- Sin cabecera (local): se usa `req.ip`.
- Los topes 5 y 200 no cambian.

## 5. Decisiones de producto pendientes

| # | Decisión | Recomendación | Por qué |
|---|---|---|---|
| **D1** | ¿Qué hace un menor en «Crear cuenta»? | Bloquearlo y mandarlo a la invitación del acudiente, que ya crea rol `parent`, hijo y migración correctos | Crear cuenta de acudiente exige buscar por `guardian_email` y elegir hijo: es la iteración posterior. El correo de la ficha no prueba quién es el acudiente; en Monster, 25 de 87 menores usan el del niño como si fuera del acudiente |
| **D2** | ¿Un menor puede agendar y cancelar sin cuenta con el OTP del correo de su ficha? ¿Con el link apagado se puede cancelar? | Sí a agendar, con copia obligatoria al `guardian_email` si existe y sin mostrar datos sensibles. Con el link apagado, bloquear todo y remitir a la escuela | Es reversible y no mueve dinero, pero son datos de menores (Ley 1581): lo decide el responsable del negocio |
| **D3** | ¿Una ficha sin fecha de nacimiento se trata como menor? | Sí, con acudiente registrado o sin dato, bloquear «Crear cuenta». Agendar sin cuenta sigue permitido | Ante la duda, el error menos costoso es pedir invitación |
| **D4** | ¿Plan de horas con `expires_at` vencido se bloquea? | Sí, igual que por cupos | Un solo criterio. Revisar antes si hay planes de horas activos que dependan de `expires_at` vencido |
| **D5** | ¿Qué texto y contacto ve la persona con el link apagado? | «Esta escuela no tiene activo el agendamiento por este link. Escríbele a la escuela», con botón de iniciar sesión | Sin contacto si implica un campo público nuevo. Hoy `/schools/:slug` solo devuelve id y nombre |

**Ya no requieren decisión**, por la evidencia de §2: reparar la cancelación existente (no salió de esta ruta) y qué hacer con reservas ya hechas de planes vencidos (no hay). El riesgo de dejar sin link a Monster tampoco aplica: nunca lo ha usado.

## 6. Riesgos

- **Código compartido.** `bookSession` y `cancelSessionBooking` también atienden rutas autenticadas; todo cambio debe cubrirlas.
- **Cupos.** H1 y H2 mueven cupos, que son dinero para la escuela. Según `CLAUDE.md`, contadores solo en RPC `SECURITY DEFINER` con `FOR UPDATE`.
- **Disk IO.** Cualquier DDL recarga el esquema: migraciones desde una sola sesión y `types.ts` una vez al final.
- **Base compartida.** dev, stg y prod usan la misma base; las pruebas de escritura se limpian o van en el gemelo local.
- **Trabajo paralelo.** `c3023775` y `af319d28` entraron el mismo día y tocan áreas cercanas (reserva web de invitado). Revisar conflictos al empezar cada fase.
