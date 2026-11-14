# Migraciones y scripts pendientes de aplicar — 2026-10-24

> **ARCHIVO PARA APLICAR: `cobros_seguridad_pendientes_CONSOLIDADA.sql`** (una sola transacción con las partes 1 a 4, con la `02` corregida para marcar en vez de rechazar y la `03` rebasada). Los archivos `01` a `04` son las piezas originales de referencia: **no aplicar las piezas además del consolidado.**
> Sin ejecutar contra ninguna base (no hay Postgres local). Antes de aplicar de verdad se puede ensayar en la base viva con `BEGIN; … ROLLBACK;` (necesita permiso: es DDL sobre la base compartida). Al aplicar, `ALTER TABLE payments … ADD CONSTRAINT … CHECK` valida todas las filas y toma un bloqueo exclusivo breve.


**Estado: NINGUNA está aplicada.** Verificado contra la base viva (`luebjarufsiadojhvxgi`, una sola para dev, stg y prod): no existen sus tablas, columnas, funciones ni triggers. Tampoco están en `develop` ni en `main`; viven solo en las ramas `cobros/*` del 2026-10-07.

Todo lo demás que había en develop (7 migraciones) **ya está vivo**, incluida `teams.sport_modality`.

## Orden de aplicación

| # | Archivo | Qué hace | Toca algo existente | Riesgo |
|---|---|---|---|---|
| 1 | `01_wa_limite_comprobantes_ocr.sql` | Límite de comprobantes que se mandan a leer (OCR) por número y por escuela, en ventana deslizante. Tabla `wa_ocr_cupos` + `wa_reservar_cupo_ocr`. | 3 columnas nuevas en `whatsapp_settings` | Bajo: solo objetos nuevos |
| 2 | `02_payments_monto_del_servidor.sql` | El monto de un cobro ya no lo decide el navegador. Mensualidad con monto distinto al válido → rechazo `PAYMENT_AMOUNT_MISMATCH`; los demás quedan `amount_source='cliente'` y `auto_approve_payment` no los aprueba. | `payments` (columna + CHECK), **`auto_approve_payment`** | **Medio-alto**, ver abajo |
| 3 | `03_wa_revinculacion_con_codigo_por_correo.REBASADA.sql` | Si el número de una conversación ya vinculada pasa a otro acudiente, no vincula hasta confirmar un código enviado por correo. | `whatsapp_identifications`, **`wa_identify_by_phone`** | **Medio-alto**, ver abajo |
| 4 | `04_conciliacion_correo_banco_dkim.sql` | Concilia pagos contra la notificación del banco reenviada por la escuela y verificada con DKIM. Tablas `bank_email_inboxes`, `bank_email_notices` + 3 RPC. | `school_settings` (columnas) | Bajo: objetos nuevos |
| 5 | `05_smoke_seguridad_cobro_wa.sql` | Prueba de humo de 1 a 3. **Correr después**, no es migración. | — | — |

Las versiones originales llevan fechas 10-07 (anteriores al head actual `20261024084549`). Para llevarlas a `supabase/migrations/` hay que crearlas con `npm run migrations:new -- <slug>` y pegar el contenido, o el ledger se queja del orden. **No lo hice.**

## Por qué la 03 está «REBASADA» (no es la original)

La original reemplaza `wa_identify_by_phone` con una versión escrita sobre la del 09-22. Aplicada tal cual **habría borrado** dos cambios posteriores que sí están vivos:

- teléfono solo Colombia (`wa_celular_remitente_co`, migración `20261008164914`)
- «atleta adulto» y «número del equipo en el perfil de otra persona» (bug 5 del informe 10-13, `20261013165308`)

Hice un merge de tres vías (base `20260922130832`, función viva, la migración). 4 conflictos, todos resueltos a favor de lo que está vivo en develop (dos eran el delimitador `$$`/`$fn$`). Comprobé que la función viva en la base **coincide** con la de `20261013165308` (solo difiere la sintaxis del envoltorio).

**Estado de la 03: BORRADOR.** Verificada de forma estática (variables declaradas, IF/END IF balanceados, conserva la lógica de re-vinculación y la de develop). **No se ejecutó** contra ninguna base. Es la puerta de identidad de WhatsApp: revisarla línea por línea antes de aplicar.

## Antes de aplicar

1. **La 02 puede cortar el checkout si el monto no cuadra.** Su propia cabecera mide el radio al 2026-10-07 (83 de 84 inserts coincidían). Desde entonces cambió el flujo de cobros (modal único, horas adicionales, pausas, cambio de plan). **Volver a medir** con datos de hoy antes de aplicar. CLAUDE.md pide medir el radio de cualquier cambio de permisos.
2. Los caminos del navegador que insertan `payments` con monto propio son `PaymentCheckoutModal.tsx` y `ParentCheckoutPage.tsx`: probar mensualidad, abono e inscripción de un acudiente después de aplicar.
3. La 02 declara que DIN-24 (`20261002125957`) ya está aplicado; está verificado en la base.
4. **Una sola sesión aplica**, una migración a la vez, por CLI (`npx supabase db query --linked -f <archivo>`), nunca desde el SQL editor ni desde sesiones en paralelo. Cada DDL recarga el esquema de PostgREST.
5. No usar `list_tables`, `get_advisors` ni regenerar `types.ts` como sondeo (Disk IO). Si las tablas nuevas necesitan tipos, regenerar **una vez** al final.
6. Backup de las dos funciones vivas antes de aplicar 2 y 3 (`pg_get_functiondef`), por si hay que volver atrás.

## Verificación después de cada una

```sql
-- 1
select proname from pg_proc where pronamespace='public'::regnamespace and proname='wa_reservar_cupo_ocr';
-- 2
select column_name from information_schema.columns where table_name='payments' and column_name='amount_source';
select tgname from pg_trigger where tgname='trg_zz_payments_monto_servidor' and not tgisinternal;
-- 3
select column_name from information_schema.columns where table_name='whatsapp_identifications' and column_name='revinculacion_de';
select proname from pg_proc where proname='wa_iniciar_revinculacion';
-- 4
select relname from pg_class where relnamespace='public'::regnamespace and relname in ('bank_email_inboxes','bank_email_notices');
```

Luego `05_smoke_seguridad_cobro_wa.sql`, `npm run seguridad:invariantes` (una vez, al final) y, para 3, probar un número ya vinculado que pasa a otro acudiente.

## Medición del radio de la 02 (2026-10-24, solo lectura)

Se emuló en SQL la regla de `payments_montos_mensualidad_validos` sobre las mensualidades de los últimos 90 días (sin canceladas). **No se puede aislar quién creó cada pago**: `payments.created_by` está en NULL en todos. Lo que sí sale:

- **~1.434 cuadran, ~152 no** (≈ 9,6 %). Es una cota superior, porque incluye lo que crean el cron y las RPC, que el trigger no toca.
- La mayor parte de los que no cuadran son cobros **vencidos con recargo de mora** (97, 75 con `late_fee_amount > 0`) y registros de staff: **no se rechazarían**.
- Lo que **sí se rechazaría** es lo que la familia inserta desde el navegador. La señal más fiable es `awaiting_approval` (comprobante por transferencia): **2 de las 3 de los últimos 90 días no cuadran**, ambas del 09-19 y de la misma escuela (`25a123f0`): un pago de 90.000 sobre una mensualidad de 200.000 (abono parcial) y uno de 290.000 sobre 180.000/280.000 (+10.000).
- Pagos por pasarela (tarjeta/PSE) que no cuadraban, todos de julio-agosto: 650.000 sobre 150.000/320.000 (varios meses juntos), 90.000 sobre 150.000, 150.000 sobre 210.000.

**Lectura:** el rechazo duro `PAYMENT_AMOUNT_MISMATCH` bloquearía **abonos parciales y pagos de varios meses** que hoy sí pasan, y la familia vería el error crudo. El fraude de «$1» ya lo neutraliza la otra mitad de la migración (`auto_approve_payment` se niega a aprobar `amount_source='cliente'`).

**Recomendación:** aplicar la 02 cambiando el rechazo por marca. Si el monto de una mensualidad no está entre los válidos, **no rechazar**: dejarlo con `amount_source='cliente'` (sin auto-aprobación, lo revisa una persona). Se conserva la defensa y no se bloquea a nadie. Dejar el rechazo solo para monto ≤ 0. Esto cambia la intención original de la migración: decisión de producto.

## Pendiente fuera de este paquete

- Las ramas `cobros/*` siguen sin integrarse: el **código** (BFF y front) que usa estas tablas tampoco está en develop (verificado por `git grep`: `wa_reservar_cupo_ocr`, `bank_email_*`, `wa_iniciar_revinculacion` y `PAYMENT_AMOUNT_MISMATCH` aparecen solo en `cobros/integracion`; el `amount_source` que sí aparece en develop es otra cosa, la fuente de la tarifa sugerida). Aplicar solo el SQL deja objetos sin uso, salvo la 02 y la 03, que sí cambian el comportamiento de la base.
- Consecuencia concreta de la 02 sin el front de `cobros/integracion`: un acudiente cuyo monto sea rechazado recibe el error crudo de la base (`PAYMENT_AMOUNT_MISMATCH`), no un mensaje claro.
- Registro: las 7 migraciones de develop vivas figuran «sin registro» en `schema_migrations` (se aplicaron por CLI sin dejar rastro). Es el patrón conocido; no afecta el funcionamiento.
