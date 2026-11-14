# Referidos, plazos, retiro/pausa y soportes — para aplicar a mano (2026-11-06)

Spec madre: `docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md`. Contratos de API:
`docs/contratos-api-oleada-1-2026-11-06.md`. Plan de anuncios: `docs/plan-anuncios-atribucion-multiescuela-2026-11-06.md`.

**Nada de esto está aplicado, commiteado ni subido.** El SQL no se ha podido ejecutar contra la base: las migraciones y los
`_smoke` se revisaron a ojo y con las definiciones vivas de `pg_proc`. Aplica en UNA sola sesión, en orden, nunca en paralelo.

## Orden de aplicación

| Orden | Migración (fuente de verdad en `supabase/migrations/`) | Qué hace |
|---|---|---|
| 0 | `20261106115639_whatsapp_anuncio_regla_texto.sql` | Tabla de reglas por texto + 5 reglas de canal de la plataforma. Atribuye por texto cuando Meta no manda el anuncio. |
| 1 | `20261106160001_referidos_campanas_y_motor.sql` | Campañas de referidos, renglones por referido, RPC y **cambio de `open_month` / `preview_open_month`** (con la campaña apagada, idéntico al actual). |
| 2 | `20261106160002_acuerdos_de_pago.sql` | Acuerdos de pago por plazos, 4 ajustes por escuela, RPC y **cambio de `apply_late_fees`** (sin acuerdos, idéntico al actual). |
| 3 | `20261106160003_soportes_obligatorios.sql` | Ajustes de soportes, estado de soportes, y el bloqueo en `confirm_school_join_request_enrollment` (apagado = idéntico). |
| 4 | `20261106160004_retiro_y_pausa_por_canales.sql` | Pausa por canal con autoaprobación, solicitudes de retiro y reactivación, `pause_validar` redefinida. |

Luego, si se quiere encender para Monster (son datos, los aplica una persona):
`soportes-encender-monster.sql` y `plazos-y-pausa-encender-monster.sql` (en esta carpeta). Ajusta antes el tope de meses de pausa (D10).
La campaña de referidos se enciende desde la pantalla (Configuración → Descuento por referidos), no por SQL.

## ANTES de aplicar las migraciones 1 y 2 (tocan funciones que corren para todas las escuelas)

1. **Confirma que las funciones vivas no cambiaron** desde que se copiaron (lectura):
   ```sql
   select proname, length(prosrc), md5(prosrc) from pg_proc
    where pronamespace = 'public'::regnamespace and proname in ('open_month','preview_open_month','apply_late_fees','confirm_school_join_request_enrollment','pause_validar');
   ```
   Compara contra los tamaños que dejaron los agentes en los encabezados de cada migración (`open_month` 7454, `preview_open_month` 6311 caracteres).
2. **Guarda el resultado de `preview_open_month` ANTES** en una escuela real (Monster y Dynasty) y compáralo DESPUÉS: con campaña y acuerdos
   apagados el resultado tiene que ser idéntico.
3. Corre cada `supabase/migrations/_smoke/*_smoke.sql` dentro de `BEGIN; … ROLLBACK;` después de aplicar la migración que le corresponde.
4. Después de aplicar: `npm run seguridad:invariantes`, y `pg_policies` / `pg_proc` por nombre para las tablas y RPC nuevas.
5. `types.ts`: regenerar UNA sola vez, al final del lote. Hasta entonces los componentes nuevos castean las columnas nuevas.

## Montaje en el BFF (ya hecho en el árbol de trabajo)

`bff/src/index.ts`: rutas `/api/v1/referidos`, `/api/v1/payment-agreements`, `/api/v1/plan-requests`, `/api/v1/soportes`; crons de referidos (06:30 COT) y de soportes
(10:00 COT). `bff/src/jobs/maintenance.job.ts`: recordatorios de cuotas cada hora y mantenimiento de acuerdos a las 06:30 UTC (antes de `apply_late_fees`).
Kill-switches: `DISABLE_REFERIDOS_CRON`, `DISABLE_SOPORTES_CRON`, `DISABLE_ACUERDOS_CRON`, y para el bot `WA_SILENCIO_DIALOGO_EQUIPO=false`, `WA_REFERIDOS_BOT=false`.
Sin las migraciones aplicadas, todo responde 503 `migracion_pendiente` o simplemente no se ve: el código es seguro de desplegar antes que la base.

## Decisiones tomadas por defecto (ver el spec)

Referidos: un mes de descuento por referido, un descuento por mes por deportista, no aplica a cuotas manuales ni a becas, reemplaza al de hermanos.
Plazos: hasta 3 cuotas / 60 días se aprueban solos; solo con cuenta. Retiro: nunca autoaprobado y sin baja completa por defecto.
Soportes: bloquea al confirmar la inscripción y al inscribir a torneos por la escuela; no bloquea crear la ficha.

## Pendiente / conocido

- **Convocatoria de partidos** sin bloqueo de soportes: `save_match_roster` la reescribe la migración 05 de partido en vivo (sin aplicar); queda para una migración posterior.
- **Inscripción a torneos por la propia familia** (`/school-tournaments/:id/register`) no está bloqueada por soportes.
- **Recordatorio por WhatsApp de soportes a fichas sin cuenta**: la función existe (`enviarRecordatoriosDeSoportes`) pero no está en ningún cron y fuera de la ventana de 24 h
  necesita una plantilla de Meta aprobada.
- **Recordatorios de plazos y soportes** de la app usan la categoría `payment` / `enrollment` de `notifications`: confirmar que el despachador las entrega por push.
- **Fuga existente (no es de esta tanda)**: la policy `pause_requests_select_staff` usa `user_school_ids()` y deja a un acudiente leer las solicitudes de pausa de toda su escuela. Corregir en otra migración.
- **`create-one` no devuelve `enrollment_id`**: la pantalla de referidos lo busca leyendo la inscripción más reciente del deportista. Mejor que lo devuelva el BFF.
- **Cuota manual con referido**: no descuenta; el renglón queda `ganado` esperando (definido solo el caso de la beca de 100 %).
- Con un acuerdo activo el cobro sigue pasando a `overdue` (solo se omite el recargo); los correos de vencimiento y el bloqueo automático por mora lo siguen viendo.
- Retiro con fecha futura: cancela la inscripción al aprobar, no en la fecha (no hay cron que lo difiera): aprobar cerca de la fecha.
- Falta una pantalla de reglas por texto de anuncios, el catálogo de anuncios y el gasto por CSV (fase 1 del plan de anuncios).
