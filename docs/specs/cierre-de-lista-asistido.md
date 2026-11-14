# Plan — Cierre de lista asistido

> Estado: **propuesta 2026-10-30, pendiente de validar con Dynasty (Milena).**
> Origen: las escuelas no mantienen actualizado quién sigue y quién no. Se generan
> cobros a deportistas que ya se fueron, se pierde visibilidad y la app pierde
> confianza. Capacitar no lo resuelve: la persona que administra trabaja en papel y
> no tiene tiempo de mantener dos sistemas.
> Principio: **no pedirle a la escuela que mantenga los datos; hacerle preguntas de
> sí o no en el momento justo, por el canal que ya usa.**
> Los valores marcados *(propuesta)* son puntos de partida, no decisiones (§10).
> Lo que ya existe en el código y la base, y cómo cambia el plan: **§13** (verificado
> el 2026-10-30).
> Plan hermano: [`mapi-agente-plan.md`](mapi-agente-plan.md) (§11).

## 1. Qué ve la persona que administra

Unos días antes de generar los cobros del mes, le llega un WhatsApp:

```
SportMaps: Hola Milena 👋 Antes de generar los cobros de noviembre,
           revisamos la lista de Dynasty. Estos 7 deportistas podrían
           ya no estar en la escuela:

           1. Juanita Pérez · Sub-12 · no viene desde el 2 oct · debe octubre
           2. Samuel Ortiz · Sub-10 · no viene desde el 18 sep · debe sep y oct
           3. Valeria Gómez · Sub-14 · su familia escribió «ya no seguimos»
           ...

           Responde con los números de los que YA NO están (ej.: 1 3).
           Si todos siguen, responde «todos siguen».
           Si prefieres verlo en pantalla: [link]

Milena:    1 3 6

SportMaps: Listo para confirmar:
           ❌ Juanita Pérez, Valeria Gómez y Andrés Ruiz ya no están.
           ✅ Los otros 4 siguen.
           No se les generará el cobro de noviembre a los 3.
           [Confirmar]  [Corregir]
```

Si no responde, los cobros se generan como siempre y recibe un único recordatorio al
día siguiente. **No responder nunca cambia nada.**

> **Cuándo es «unos días antes» en Dynasty (§13.1):** sus cobros se generan solos el
> día 1 de cada mes a la 1:30 a. m. El mensaje tiene que salir antes del último día
> hábil del mes.

## 2. Las señales: quién es «dudoso»

Un deportista entra a la lista si cumple **al menos dos** señales *(propuesta)*, o si
su familia pidió la baja:

| Señal | Regla *(propuesta)* | Fuente |
|---|---|---|
| Sin asistencia | 21 días sin marca de asistencia ni torniquete | asistencia del coach, QR, ZKTeco |
| Sin pago | 1 cobro vencido hace más de 15 días | cobros |
| Sin contacto | La familia no abrió la app ni respondió WhatsApp en 30 días | sesiones, WhatsApp |
| La familia lo dijo | Mensaje por WhatsApp clasificado como «ya no seguimos», o botón de baja (§5) | WhatsApp |

> **Ya existe (§13.2):** la señal «sin asistencia», con la regla de §2.1, ya la calcula
> el informe de cartera semanal (sección INACTIVOS). La de «la familia lo dijo» ya la
> detecta el bot (`esSolicitudDeRetiro`). La de «sin contacto» tiene un problema de
> fuente (§13.3).

### 2.1 Cuidado: la asistencia solo cuenta si se toma

En Dynasty hubo unas 2.665 marcas de asistencia en tres meses para 510 inscripciones
activas. Si un equipo no toma asistencia, «no vino en 21 días» es falso para todos sus
deportistas. Regla: la señal **sin asistencia** solo aplica a equipos con al menos una
marca en los últimos 14 días. Si el equipo no toma lista, esa señal se ignora y el
deportista necesita las otras dos.

### 2.2 Exclusiones (nunca entran a la lista)

- Inscritos hace menos de 30 días.
- Con excusa o aviso de ausencia activo en el periodo.
- Con pausa de inscripción.
- Marcados «sigue» en un cierre anterior, durante 60 días *(propuesta)*.
- Becados, si la escuela lo configura.

### 2.3 Tope

Máximo 15 deportistas por mensaje *(propuesta)*, ordenados por cuántas señales
cumplen. Una lista larga no se contesta.

## 3. Qué pasa con cada respuesta

| Respuesta | Efecto |
|---|---|
| **Ya no está** | Inscripción en baja con fecha de hoy. No se le generan cobros nuevos. Los cobros ya vencidos **se mantienen** *(propuesta, §10.3)*. Sale de la lista del coach. |
| **Sigue** | No vuelve a la lista en 60 días. |
| **Sin respuesta** | Nada cambia. Se registra para medir. |

Antes de aplicar, siempre hay una confirmación con la lista resumida («Confirmar /
Corregir»). Una baja se puede deshacer desde la ficha del deportista.

> **Choca con la política de baja vigente (§13.4).** La baja de hoy
> (`set_school_athlete_status`, decisión del 2026-07-30) **anula** los cobros
> pendientes y vencidos, y reactivar **no** restaura el plan ni los cobros. Mantener
> los vencidos exige una variante de la baja. «Deshacer» hoy significa reactivar y
> volver a asignar el plan a mano.

## 4. Cómo responde: tres formas, una sola lógica

1. **Números por WhatsApp** («1 3 6», «todos siguen», «el 2 sí sigue, los demás no»).
   El texto lo interpreta el modelo y siempre se devuelve la confirmación del §1.
   Es la forma principal, porque es como ya escribe.
2. **Link a una página móvil** con la lista y un botón por deportista. Sin
   contraseña: enlace firmado de un solo uso que vence en 72 horas *(propuesta)*.
3. **En el panel**, para quien sí entra (bandeja «Revisar lista»).

Las tres escriben en las mismas tablas (§6).

## 5. Las familias también avisan

- El recordatorio de cobro incluye un botón: **«Ya no estamos en la escuela»**.
- Esa respuesta **nunca da de baja sola**: crea un ítem con origen `familia` que le
  llega a la escuela en el siguiente cierre, o de inmediato si la escuela lo prefiere.
  Si diera de baja sola, sería una forma de no pagar.
- La familia recibe: «Gracias, le avisamos a la escuela».

> **Ya hay un camino sin botón (§13.2):** desde el 2026-10-08 el bot detecta «la
> vamos a retirar» y similares, escala a la escuela como «Solicitud de retiro» y le
> dice eso a la familia. Ese mismo evento crea el ítem `familia`, sin esperar a
> cambiar plantillas.

## 6. Base de datos (para aprobar antes de escribir)

| # | Cambio | Por qué |
|---|---|---|
| 1 | Tabla `roster_reviews`: `id, school_id, period, status text CHECK ('sent','partial','closed','no_response'), sent_at, reminded_at, closed_at, channel` | Un cierre por escuela y periodo |
| 2 | Tabla `roster_review_items`: `id, review_id null, school_id, enrollment_id, signals jsonb, source text CHECK ('system','family'), status text CHECK ('pending','active','left','no_response'), reviewed_by, reviewed_at, snooze_until` | Cada deportista dudoso y su resultado; `review_id` es nulo para avisos de familia que llegan entre cierres |
| 3 | `school_settings.roster_review_enabled boolean default false`, `roster_review_days_before int default 3`, `roster_review_admin_contact` | Encendido por escuela y a quién se le escribe |
| 4 | RLS por `school_id`; escritura del enlace móvil solo por ruta del BFF que valida el token | Regla de multi-tenant |

Estados en `text + CHECK`, una migración por el ledger, `seguridad:invariantes`
antes de cerrar.

> **Por decidir (§10.6):** el ítem va por **inscripción** (`enrollment_id`), pero la
> baja de hoy es por **deportista** (se va de toda la escuela). Un deportista con dos
> equipos puede dejar uno y seguir en el otro.

## 7. WhatsApp: lo que hay que resolver

- **Desde qué número.** El mensaje va a la administración, no a familias: sale del
  número de SportMaps, no de la WABA de la escuela.
- **Plantilla.** Es un mensaje que inicia la empresa, así que necesita una plantilla
  aprobada de tipo utilidad. Por eso la lista va dentro de un texto variable o detrás
  del link, y la plantilla solo dice «Tienes N deportistas por revisar antes de los
  cobros de {mes}». La respuesta de Milena abre la ventana de 24 horas y lo demás va
  como mensaje normal.
- **Botón de familias (§5):** botón de respuesta rápida en la plantilla de
  recordatorio de cobro de cada escuela. Cambiar esa plantilla requiere nueva
  aprobación en cada WABA; arrancar solo con Dynasty.

> **El número de SportMaps existe pero no está conectado (§13.5).** La Fase 1 depende
> de conectarlo, de que Meta apruebe sus plantillas y de que Milena escriba «ACTIVAR».

## 8. Fases

### Fase 0 — Manual, sin código nuevo (esta semana)

1. Sacar de la base la lista de dudosos de Dynasty con las reglas del §2.
2. Revisarla **con Milena** contra su papel: ¿cuántos de verdad ya no están?
3. Medir la **precisión**: de los marcados, cuántos se fueron. Si es baja, se ajustan
   las reglas antes de automatizar.
4. Aplicar a mano las bajas que ella confirme antes del próximo lote de cobros.

Si la precisión es mala o Milena no le ve valor, se para aquí y no se construye nada.

> **Plazo real (§13.1):** el lote de noviembre se genera el **domingo 1 de noviembre
> a la 1:30 a. m.** Para que la Fase 0 evite esos cobros, las bajas tienen que quedar
> aplicadas el **sábado 31 de octubre**. Si no alcanza, la baja posterior igual anula
> el cobro de noviembre (política vigente), pero la familia ya pudo recibir su estado
> de cuenta. La alternativa es apuntar la Fase 0 al lote de diciembre.

### Fase 1 — Cierre por WhatsApp para Dynasty

Cálculo de señales, mensaje con plantilla, respuesta por números, confirmación,
aplicación de bajas. Sin link ni panel todavía.

### Fase 2 — Link móvil, bandeja en el panel y botón de las familias

### Fase 3 — Otras escuelas

Con la regla de asistencia del §2.1 ajustada a cada una.

## 9. Métricas

| Métrica | Qué indica |
|---|---|
| Precisión: marcados que de verdad se fueron | Si las reglas sirven |
| % de cierres respondidos y tiempo hasta responder | Si el formato funciona para la escuela |
| Cobros que se dejaron de generar por bajas confirmadas | Valor directo para la escuela |
| Bajas que la escuela deshizo después | Errores del proceso |
| Avisos de baja de familias por mes | Uso del botón |

## 10. Decisiones abiertas

1. **Umbrales del §2** (21 días, 15 días, dos señales, 60 días de «sigue»). El
   informe de cartera usa 14 días para «sin asistencia»; conviene un solo número
   para que los dos no se contradigan.
2. **Cuándo se envía**: cuántos días antes del lote de cobros, y a qué hora (el uso
   pico de admins es de 8 a 11 a. m.).
3. **Deuda de quien se fue**: mantener los cobros vencidos, anularlos, o preguntar en
   cada caso. **Hoy la baja los anula** (decisión del 2026-07-30, §13.4): mantenerlos
   cambia esa política.
4. **Aviso de familias**: al siguiente cierre o de inmediato.
5. **¿El coach también confirma?** Podría responder por sus equipos y descargar a la
   administración. Ojo: desde el 2026-07-30 el coach no puede dar de baja
   (`set_school_athlete_status` exige admin); su respuesta tendría que quedar como
   propuesta para el admin.
6. **Ítem por deportista o por inscripción** (§6).

## 11. Relación con Mapi agente

Es independiente del plan del agente y no lo bloquea. Comparte piezas: la
interpretación de la respuesta en lenguaje natural, la confirmación antes de aplicar
y la regla de que no responder no cambia nada. Más adelante, «revisar la lista» puede
ser una herramienta de Mapi.

## 12. Criterios de aceptación

- Un deportista de un equipo que no toma asistencia no entra a la lista solo por
  falta de asistencia.
- «1 3 6» produce la confirmación correcta; nada se aplica sin «Confirmar».
- Sin respuesta, los cobros del mes se generan igual que hoy.
- Un deportista confirmado como «ya no está» no recibe el cobro del mes siguiente y no
  aparece en la lista del coach.
- El botón de la familia nunca da de baja sin la confirmación de la escuela.
- Una baja confirmada se puede deshacer desde la ficha (hoy: reactivar y volver a
  asignar el plan, §13.4).
- Los dudosos «sin asistencia» del cierre coinciden con los INACTIVOS del informe de
  cartera de la misma fecha.

## 13. Lo que ya existe y cómo cambia el plan (verificado 2026-10-30)

### 13.1 Cuándo se generan los cobros de Dynasty

Configuración viva de DYNASTY VOLLEY CLUB: `auto_generate_payments = true`,
`billing_cycle_type = 'fixed_calendar'`, `payment_cutoff_day = 10`,
`auto_cancel_overdue_enabled = false`, **510 inscripciones activas** (coincide con el
dato de §2.1). `generate_monthly_charges` abre el mes en curso todos los días a la
1:30 a. m. (hora de Colombia), así que el lote de cada mes nace el **día 1**. El
estado de cuenta a las familias sale el primer día hábil, a las 8:00 a. m.

### 13.2 Señales que ya se calculan

| Pieza | Dónde | Qué reusar |
|---|---|---|
| Informe de cartera semanal (pedido de Dynasty, 2026-10-07) | `informe-cartera.service.ts` | Su sección INACTIVOS ya es «activos que no asisten hace N días, **solo donde el equipo sí toma asistencia**» (N = 14 por defecto). El cierre debe usar la misma función, no una nueva. También tiene los **dados de baja con saldo**. Dynasty lo recibe porque apagó la cancelación automática. |
| Detección de retiro en WhatsApp (2026-10-08) | `whatsapp-escalaciones.service.ts` (`esSolicitudDeRetiro`) | Ya escala «Solicitud de retiro» a la escuela, y hay un aviso `retiro` en el canal de SportMaps. Es la señal «la familia lo dijo» sin tocar plantillas. |
| Avisos de ausencia | `athlete_absence_notices` | La exclusión «con aviso de ausencia activo» (§2.2) |

### 13.3 La señal «sin contacto» no tiene fuente confiable

Supabase guarda `last_sign_in_at` en `auth.users`, que registra **inicios de sesión**,
no aperturas de la app: con la sesión persistente, una familia que abre la app a
diario puede no iniciar sesión en meses. Antes de usar esta señal hay que confirmar
si existe una marca de actividad real. Si no existe, la propuesta es dejar solo la
parte de WhatsApp («no respondió en 30 días»).

### 13.4 Política de baja vigente

`set_school_athlete_status` (mig `20260730170000`) cancela la inscripción activa y
**anula** los cobros `pending` / `awaiting_approval` / `overdue`; los `paid` y
`partial` no se tocan. Reactivar **no** restaura el plan. Exige `is_school_admin`.
Efectos sobre el plan:

- «Ya no está» puede usar esta RPC tal cual, pero entonces la deuda vencida se anula,
  al revés de lo que propone §3.
- Mantener la deuda requiere una variante (o un parámetro) de la RPC, y eso cambia
  una política acordada: decisión §10.3.
- Sacar al deportista de la lista del coach y de los recordatorios ya ocurre con la
  baja (`cobrosDeAtletaDadoDeBaja` en recordatorios).

### 13.5 Canal de WhatsApp de SportMaps

La pantalla `/admin/whatsapp` (super admin) y el servicio de la plataforma existen
desde el 2026-10-29, pero el canal está **apagado y sin conectar**: no se ha conectado
el número, no se han enviado a Meta las 5 plantillas `sm_*` y Milena no ha escrito
«ACTIVAR». La plantilla de este cierre (§7) se envía a Meta junto con esas. Mientras
tanto, la Fase 0 no depende del canal.
