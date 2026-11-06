# Dreamers — Ciclo de cobro 1–5, vigencia de fin de mes y bloqueo por mora

**Estado (2026-10-05):** plan completo; configuración de cobro y vencimientos aplicados en vivo; arreglos del bloqueo hechos en código (sin desplegar); el resto, por fases (§3).
**Alcance:** las **mensualidades de los estudiantes a su escuela** (tabla `payments`, `school_settings`, inscripciones de atletas). **No** toca la suscripción de la escuela con SportMaps (`school_subscriptions` / `school_subscription_invoices`, `saasInvoicing.service.ts`). Regla **exclusiva de Dreamers** (su modelo de negocio): toda mecánica nueva va detrás de un ajuste por escuela, sin cambios para las demás ([niveles §4](dreamers-niveles-por-horas-y-progresion.md)).
**Ambiente:** Dreamers está hoy en laboratorio controlado (usuario de pruebas Athenea); las demás cuentas son de prueba. Complementa §3 del [spec de niveles](dreamers-niveles-por-horas-y-progresion.md) y el [banco de horas](dreamers-banco-de-horas-torniquete.md).

---

## 1. Reglas (decididas por el owner, 2026-10-05)

| # | Regla |
|---|---|
| R1 | Mes calendario. El plan vence el **último día del mes**. El día 1 todas las inscripciones aparecen por renovar/vencidas, porque **todos pagan del 1 al 5**. Durante el 1–5 entran normal (cobro `pending`, no `overdue`). |
| R2 | El cobro vence el **día 5** (corte 5, gracia 0). **Día 6, 02:00 hora Colombia** (pg_cron `apply-late-fees-daily`, 07:00 UTC): todo cobro sin pagar pasa a `overdue` y sube el **5 %** (`late_fee_percentage = 5`). |
| R3 | **Bloqueo:** el job de bloqueo automático (cada 15 min) deshabilita en los lectores el PIN de quien tenga una mensualidad `overdue`, menores incluidos; al pagar se rehabilita solo (máx. 15 min). El plan **queda vencido y bloqueado, no se cancela**. El admin puede habilitar a mano desde Control de acceso: es una **excepción de un solo día** (hora Colombia); al día siguiente, si sigue vencida, se bloquea de nuevo. |
| R4 | **Horas:** se usan hasta el último día del mes; el día 1 se reinician. Las no usadas se pierden y no ruedan (D-5 del banco de horas). |
| R5 | **Alta a mitad de mes:** se paga el mes completo y se tienen todas las horas hasta fin de mes (alta el día 10 = 20 días para usarlas). Sin proporcional: si no alcanza a usarlas, se pierden. |
| R6 | **Cambio de plan antes de pagar:** UPDATE de la misma inscripción más el cobro del plan nuevo; las horas ya usadas se trasladan. |
| R7 | **Cambio de plan después de pagar (ya consumió horas):** el banco del mes pasa a las horas del plan nuevo y lo consumido se conserva, para gastarlas hasta fin de mes. Aviso informativo antes del cobro: «ya pagó $X; ¿pago parcial o completo?». Criterio del owner: si ya gastó todas las horas y quedan días del mes, **pago completo**. |
| R8 | **No se cancelan inscripciones por mora en Dreamers por ahora:** solo se bloquea el acceso. Se deja sin tocar la regla general de cancelación (§4); la exclusión por escuela queda diferida. |
| R9 | **Edna y Fabio son dueños:** fuera de estudiantes; no generan cobros, mora, bloqueo ni banco de horas. |

## 2. Aplicado en vivo (2026-10-05)

- `school_settings` de Dreamers: `payment_cutoff_day` 1 → **5**, `payment_grace_days` 5 → **0**. Revertir: corte 1, gracia 5.
- Vencimiento de los 3 cobros de octubre pendientes (Bella $1.142.000, Mariapaz $884.000, Athenea $489.000) movido del 1-oct al **5-oct**. Si hoy no se pagan, el 6-oct a las 02:00 pasan a `overdue` con recargo (total $125.750).
- Fabio y Edna fuera de estudiantes: inscripciones y cobros sin pagar cancelados (sus 2 cobros pagados de Edna intactos); Fabio con rol `staff`; Edna se queda como `parent` (es la mamá de Athenea y Bella) y su registro de atleta quedó inactivo.
- `hours_billing_rounding = 'hour_up'` y regla de entrada duplicada (se ignora la segunda entrada con visita abierta): ver [banco de horas](dreamers-banco-de-horas-torniquete.md) §8.

## 3. Fases y estado

| Fase | Qué | Estado |
|---|---|---|
| A | **Bloqueo automático (R3).** Arreglos en código: `athleteKey` con `child_id` en `access-auto-block.job.ts` y `GET /access/overdue` (antes los menores caían en la clave `a:null` y podían bloquear el PIN de otro niño); excepción manual de un día en el job. | Hecho en código, **sin desplegar**. Falta: deploy y activar `access_auto_block_overdue_enabled` en Dreamers (juntos). Prueba de aceptación abajo. |
| B | **Vigencia = fin de mes (R1).** Hoy `fn_extend_enrollment_on_payment_paid` suma `duration_days` (30) al pagar y el alta fija inicio + 30; de ahí salen vencimientos en los días 5, 9, 13, 26, 27. Con ajuste por escuela: `expires_at` = último día del mes pagado. En el torniquete, para Dreamers el rechazo `enrollment_expired` no debe aplicar durante el 1–5 (con R1 `expires_at` ya pasó el día 1 y quedaría registrado «denegado» a todos); la decisión de acceso se guía solo por el pago `overdue`. | **Aplicado (2026-10-06).** Migración `20261005221257` (en vivo): `school_settings.enrollment_validity_mode` (`rolling` por defecto, `calendar_month_end` en Dreamers) y `fn_extend_enrollment_on_payment_paid` con la rama de fin de mes; `access-adms.ts` ya no rechaza por `enrollment_expired` en escuelas `calendar_month_end`. Sin backfill de los vencimientos existentes: se alinean al pagar. |
| C | **Cambio de plan (R6, R7).** El UPDATE en la misma inscripción ya existe (`enrollments.ts`, «Cambio de plan») y anula los cobros pendientes del plan viejo. Faltan: actualizar `included_minutes` del período vigente (`get_or_open_hour_bank_period` lo copia una sola vez al abrir el mes y nada lo actualiza al cambiar de plan) y el aviso parcial/completo (hoy cobra el precio completo del nuevo plan sin descontar lo pagado; peor: con pago previo el cobro nuevo choca con `uniq_payment_active_period_per_child` y `createPendingPayment` lo absorbe en silencio, o sea no se emitía). | **Construido (2026-10-06), sin desplegar el BFF ni el frontend.** `planChange.service.ts` (vista previa + efectos), RPC `apply_hour_bank_plan_change` (migración `20261005221257`, en vivo), `POST /api/v1/enrollments/plan-change-preview`, `plan_change_charge` en `POST /enrollments` y en el editor de atletas (`PUT /students/:id`), diálogo `PlanChangeDialog` en el editor y en «Inscribir en plan». 12 pruebas unitarias nuevas. |
| D | **Alta a mitad de mes (R5).** Hoy `billingDue` ya cobra el mes completo el día del alta. No requiere construir `remaining_classes` (F7 del spec de niveles); queda como mejora futura opcional. | Cubierto hoy; solo documentar. |
| E | **Edna a staff.** Pasar su cuenta a staff cuando termine la validación con Athenea (hoy es `parent` de las niñas). | Diferido por decisión. |

### Prueba de aceptación del bloqueo (con Athenea, PIN 4)
1. Desplegar el BFF y activar el flag de Dreamers.
2. 6-oct 02:00 COT: su cobro pasa a `overdue` con 5 %.
3. Hasta ~02:15: el job encola `disable_user` para sus dos lectores; verificar `device_commands` en `executed`.
4. Marcar en el torniquete: debe negar físicamente.
5. Habilitarla desde Control de acceso: debe pasar y **no** volver a bloquearse ese día.
6. Pagar el cobro: ≤15 min después queda habilitada (el job emite `enable_user`).
7. Verificar que Emma y Bella (vencidas desde septiembre) quedaron bloqueadas y que **ningún otro PIN** cambió de estado.

### 3.1 Cambio de plan (fase C) — diseño propuesto, pendiente de aprobación

**Alcance por escuela:** escuelas con `hours_plan_enabled = true` (hoy Dreamers y Academia Superior Bogotá; las demás no ven el aviso). La regla 1–5 y el bloqueo siguen siendo solo de Dreamers.

**Flujo para el admin** (aplica a las dos vías de cambio: `enrollments.ts` «Cambio de plan» y el editor de atletas en `students.ts`, que hoy duplican lógica; se centralizan en una función compartida):

1. Al elegir el plan nuevo, el BFF calcula una **vista previa** (no escribe nada): plan actual, lo **pagado** del período vigente, horas consumidas y restantes, días que faltan del período, precio y horas del plan nuevo.
2. Según la vista previa, aviso informativo con **recomendación**:
   - **Sin pago del período aún:** solo cambia el plan y se emite el cobro del nuevo (R6). Sin diálogo de cobro.
   - **Pagó y le quedan horas / faltan muchos días:** «pagó $X; ¿pago **parcial** ($ nuevo − X) o **completo** ($ nuevo)?». Decide el admin.
   - **Ya gastó todas las horas y quedan días del mes:** recomendado **completo** (criterio del owner).
   - **Cerca del fin de período y quedan pocas horas:** recomendación de esperar y cambiarlo el día 1 (el cobro de ese día ya sale con el precio del plan nuevo); no se bloquea el cambio ahora.
3. Al confirmar: se cambia el plan en la misma inscripción, se anulan los cobros pendientes del plan viejo y se emite el cobro elegido. El cobro adicional del mismo período usa `period_uniqueness_exempt = true` (el índice `uniq_payment_active_period_per_child` lo impediría si no); parcial = «Diferencia de plan {viejo} → {nuevo}».
4. **Horas:** `included_minutes` del período vigente pasa a las horas del plan nuevo y lo consumido se conserva (disponible = nuevas − consumidas). Función de base de datos nueva, con migración.

**Riesgo propio de Academia Superior (ciclo `rolling_30`):** el período se calcula desde `start_date` de la inscripción. Si un cambio de plan reescribe `start_date` a hoy (el editor lo hace cuando `plan_start_date` llega vacío), se abre un período nuevo con consumo en 0 y **se pierden las horas ya usadas**. El cambio de plan debe preservar `start_date`. En Dreamers (`fixed_calendar`, período = mes) no ocurre.

**Detalles de la implementación:**
- El cobro de la opción elegida vence **hoy** (misma regla que el resto de cobros nuevos: `billingDue`); en Dreamers, si no se paga antes de las 02:00 siguientes, pasa a `overdue` con el 5 %.
- «Parcial» se emite **sin plan** asociado (`offering_plan_id` NULL) para que `fn_extend_enrollment_on_payment_paid` no vuelva a correr la vigencia; «completo» sí lleva el plan nuevo. Ambos con `period_uniqueness_exempt = true` y concepto «Diferencia de plan A → B - mes/año» / «Plan B (cambio de plan) - mes/año».
- «Pagado en el período»: en `fixed_calendar`, lo pagado con `period_year/month` del mes en curso; en `rolling_30` es una aproximación (lo pagado con vencimiento dentro del período vigente, con 15 días de holgura), y el admin ve el monto en el aviso para verificarlo.
- Si la vista previa falla, el cambio sigue el flujo de siempre (el aviso es una ayuda, no una barrera). Sin `plan_change_charge` y con pago previo, el BFF asume «completo».
- El editor de atletas ya no reescribe `start_date` al cambiar de plan en una escuela con banco de horas si el formulario no mandó fecha (protege el período de `rolling_30`).

**Pruebas (ambas escuelas):** (a) cambio sin pago previo; (b) cambio con pago y horas a medias, parcial; (c) idem, completo; (d) cambio con todas las horas gastadas; (e) en Academia Superior, verificar que el consumo se conserva y que el período no se reinicia.

## 4. Regla general de cancelación a 7 días (no se toca)

`fn_expire_overdue_enrollments` (03:00 COT, decisión de producto D1 de [cobranza-vencidos-estados-y-alertas.md](cobranza-vencidos-estados-y-alertas.md), migración `20260902171932`) cancela inscripciones activas cuando `expires_at + gracia + 7 días < hoy`, salvo que el plan tenga tope de clases con clases sin usar. Aplica a **todas** las escuelas.
- Hoy no cancela a nadie en ninguna escuela: todas las inscripciones que cumplen la condición conservan sesiones sin usar (medido 2026-10-05).
- **Riesgo conocido (aceptado por ahora):** la protección depende del contador de clases; un plan sin tope, o con el contador lleno, se cancelaría a los 7 días aunque el comprobante esté pendiente de aprobar (un pago aprobado sí corre `expires_at` un período).
- Si se decide excluir a Dreamers: columna `auto_cancel_overdue_enabled boolean NOT NULL DEFAULT true`, apagada solo en Dreamers, **junto con** el bloqueo activo, y registrar la decisión (fecha y quién) en el spec de cobranza. Medir antes el radio y correr `npm run seguridad:invariantes` después.

## 5. Calendario de la noche del 5 al 6 de octubre (hora Colombia)

| Hora | Qué pasa |
|---|---|
| 01:30 | Se generan los cobros del mes (no hay cobros nuevos de Dreamers hasta noviembre). |
| 02:00 | `apply_late_fees`: los 3 cobros sin pagar pasan a `overdue` + 5 %. |
| 02:15 aprox. | Job de bloqueo (cada 15 min): bloquea los PIN con cobro `overdue`, si el flag está activo y el BFF desplegado. |
| 03:00 | Cancelación a 7 días: no afecta a nadie hoy (§4). |
| 07:15 | Correo «pago vencido» a las familias de los cobros vencidos. |

## 6. Registro de dudas

| # | Duda | Estado |
|---|---|---|
| 1 | Hora del cron del recargo | Resuelta: 02:00 COT (no 03:00; 03:00 es la cancelación). |
| 2 | Corte 1 vs 5 y desfase del recargo | Resuelta: corte 5, gracia 0, aplicado. |
| 3 | Bloqueo físico de menores | Resuelta en código; falta deploy y activar el flag. |
| 4 | Habilitación manual | Resuelta: excepción de un día. |
| 5 | Cancelación a 7 días | Resuelta: no se toca; riesgo documentado (§4). |
| 6 | Alta a mitad de mes | Resuelta: mes completo, horas hasta fin de mes (R5). |
| 7 | Cambio de plan, horas | Resuelta: banco = horas del plan nuevo, consumo conservado (R7). |
| 8 | Cambio de plan, cobro | **Parcial = diferencia entre el plan nuevo y lo pagado** (supuesto; falta confirmar). Completo si ya gastó todas las horas. |
| 9 | Porcentaje del recargo | La configuración tiene **5 %** (se habló de 6 % en voz; falta confirmar que es 5). |
| 10 | Edna y Fabio | Resuelta: fuera de estudiantes; Edna sigue como `parent` hasta terminar la validación. |
| 11 | Alcance (suscripción de la escuela) | Resuelta: no se toca. |

## 7. Fuera de este plan (en el radar)

- Planes de Dreamers sin horas configuradas (PGC12x3+2, PGC16x3, PGC20x2/3/4, PGN12x3, PGP4x1, PGP8x1) y PGR6x2 con bloque de 160 min (debería ser 120): hay que confirmar con Dreamers las horas de cada nivel.
- Inscripción ($120.000) y seguro ($150.000) existen como planes sueltos, no se pueden combinar con el plan del atleta (`allow_multiple_enrollments = false`) y nunca se han cobrado; solo PGP4x1 tiene `registration_fee` (en $0).
- Eliminar el plan PGN12x3: bloqueado por una invitación aceptada que lo referencia (`nassud@gmail.com`).
- Configuración de pagos de Dreamers (cuenta en campos legacy, `payment_accounts` vacío, `payment_setup_completed = false`), `NIV-7` (pronto pago), cargo por horas de más (F5) y lo demás de los spec de niveles.

## Primer cobro (mes de alta) sin recargo — 2026-10-11

Regla de Dreamers (`school_settings.late_fee_skip_signup_month = true`): la **primera mensualidad** del deportista (la del mes en que se inscribe) **vence el día de corte del mes siguiente** (el 5) y **nunca recibe recargo**. El recargo del 5 % arranca con la mensualidad siguiente, que se genera el 1 y vence el 5.

- **Por qué:** el alta después del corte emitía el cobro con vencimiento = día del alta (`dueInEntryMonth`); con 0 días de gracia el cron de las 02:00 lo pasaba a `overdue` y le sumaba 5 % al día siguiente (Zoe Barrera y Avril Salomé Aguilar, 2026-10-10). Además `overdue` alimenta el bloqueo automático.
- **Dónde vive:** migración `20261011101750` — trigger `trg_payments_primer_cobro_prox_corte` (mueve el vencimiento y el texto «vence día N» del concepto; un solo punto para todos los caminos de alta) y `apply_late_fees` (exenta del recargo al primer cobro vía `fn_is_first_monthly_charge`).
- **«Primer cobro»:** primera mensualidad del atleta en la escuela, sin otra mensualidad no anulada de un período anterior. No exenta: cambio de plan a mitad de mes de quien ya pagaba, ni reingreso tras un descanso (ya tiene cobros previos).
- **Otras escuelas:** el flag nace en `false`; sin cambio. No hay UI para el flag todavía (se cambia por SQL).

## Plan de cierre y estado (2026-10-14)

| # | Tarea | Estado |
|---|---|---|
| 1 | Corte 5, gracia 0, recargo 5 % el día 6, vigencia a fin de mes | ✅ en vivo |
| 2 | Primer cobro sin recargo (migración `20261011101750`) + Zoe y Avril corregidas a mano | ✅ en vivo y probado con rollback |
| 3 | Descuento del primer mes viaja con el cobro (`discount_pct`/`list_amount`); Zoe reversada con descuento | ✅ en vivo; **falta desplegar BFF + frontend** (editor, modal de pago) |
| 4 | Pago de varios cobros a la vez (`register_manual_payments`) | ✅ RPC en vivo; **falta desplegar el modal** |
| 5 | Cambio de plan con traslado de horas | ✅ construido; falta desplegar y probar C2–C7 (necesita un deportista de prueba con pago) |
| 6 | Mostrar el descuento en la ficha y en «Registrar pago» (hoy muestran el precio de lista) | ⏳ decidir: ¿el descuento es solo del primer mes o se repite? |
| 7 | Bloqueo físico por mora: el MB360 ignora el bit de privilegio; `access_auto_block_overdue_enabled` sigue **apagado** | ⏳ falta modelo/firmware y tipo de credencial de Athenea |
| 8 | Excluir a Dreamers de la cancelación a 7 días (`auto_cancel_overdue_enabled`) | 🕓 diferido |
| 9 | Eliminar el plan PGP12x3 (una invitación aceptada lo referencia) | 🕓 diferido |
| 10 | Edna a `staff` cuando termine la validación con Athenea | 🕓 diferido |
| 11 | ¿Puede `staff` registrar pagos? Hoy solo owner/admin/school_admin | ⏳ decisión de producto |
| 12 | Interruptor `late_fee_skip_signup_month` sin pantalla (SQL) | 🕓 opcional |

## Bloqueo físico: «borrar y restaurar» con el SDK oficial — prueba del 2026-10-23

**Hecho:** en los MB360 de Dreamers (firmware 6.60) el SDK oficial de ZKTeco (`zkemkeeper` 6.2.5.50, ya instalado con
ZKAccess 3.5 en la PC de la sede) **lee y escribe rostro y huellas**, cosa que pyzk no puede (solo cuenta rostros).
Probado con el PIN 12 (usuario de pruebas, huella + clave) en el lector de entrada:

| Paso | Resultado |
|---|---|
| Leer rostro (PIN con rostro, 41.216 bytes) y huella (1.148–1.580 bytes) | ✅ |
| Escribir huella en otro PIN y releerla | ✅ idéntica |
| Respaldar → borrar → marcar | ✅ huella **no válida** (el lector niega) |
| Restaurar → verificar → marcar | ✅ idéntica y **deja pasar** |

**Trampa:** el lector **aplica el borrado al cerrar la sesión**: leer en la misma conexión sigue mostrando al usuario
(dio dos falsos «FALLO»; el usuario ya no estaba al reconectar). Verificar siempre reconectando.

**Falta:** (1) repetir el ciclo con un PIN que tenga **rostro** y probar por separado huella / PIN / rostro; (2) **tarjeta
RFID** no se respalda; (3) integrar al bridge (Python 64 bits; el SDK es COM de 32 bits → el bridge invocaría el
PowerShell de 32 bits); (4) **dónde guardar los respaldos** (datos biométricos de menores: solo en la PC de la sede,
cifrados, no en la nube; decisión legal aparte); (5) decidir si reemplaza o complementa la Opción a de Brayan
(`dreamers-bloqueo-torniquete-opciones.md`). Scripts de prueba: `scripts/dreamers-bridge/diagnostico_rostro_sdk.ps1`,
`prueba_escritura_rostro_sdk.ps1`, `ciclo_bloqueo_restaurar_sdk.ps1`. Para registrar el SDK hizo falta `regsvr32` como
administrador y usar el ProgID `zkemkeeper.ZKEM.1`.

### Resultado del 2026-10-31 — ciclo completo con huella + clave + rostro (PIN 4, usuario de pruebas)

Respaldar → borrar → marcar → restaurar → marcar, sobre el lector de ENTRADA:

| Fase | Huella | Código | Rostro |
|---|---|---|---|
| Usuario borrado | negada | negado | **negado** |
| Usuario restaurado | abre | abre | **abre** |

- Restauración: usuario, huella (1356 bytes) y clave **idénticas**; rostro (41.216 bytes) con **32 posiciones distintas de
  41.216 (0,08 %)**, repartidas en dos bloques iguales con el mismo patrón → metadatos que el lector reescribe, no contenido; el
  torniquete lo reconoció. Con un solo usuario: repetir con 2–3 más para confirmar el patrón.
- **Códigos de verificación del lector** (campo 3 del ATTLOG que arma el bridge: `att.status` de pyzk): **16 = rostro, 1 = huella,
  0 = clave/código** (consistente con las marcaciones de Athenea; falta confirmar el orden exacto de la prueba).
- Con el usuario borrado **el lector no registra el intento**: SportMaps no ve a los bloqueados intentando entrar.
- Diseño resultante: bloquear **solo en el lector de entrada** (la salida nunca se niega y nadie queda atrapado); la verificación
  de la restauración debe tolerar esos pocos metadatos del rostro y apoyarse en huella/clave idénticas.
- Falta: **tarjeta RFID** (no se probó; el script ya la respalda), integrar al bridge (SDK COM de 32 bits), y dónde guardar los
  respaldos (biometría de menores: solo en la PC de la sede). Script: `ciclo_bloqueo_restaurar_sdk.ps1`; diagnóstico del rostro:
  `comparar_rostro_respaldo.ps1`.
**Decisión del owner (2026-10-31): la tarjeta RFID queda fuera de alcance — Dreamers no la usa.** El script la omite por defecto
(`-ConTarjeta` solo para un cliente que sí la use). El bloqueo cubre huella, clave y rostro.

