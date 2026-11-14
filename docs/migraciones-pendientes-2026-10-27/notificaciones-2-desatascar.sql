-- Copia lista para pegar en el SQL editor de Supabase (idéntica a
-- supabase/migrations/20261027150500_desatascar_cola_notificaciones.sql).
-- PASO 2 del LEEME.md: ANTES de desplegar a prod el código nuevo del BFF.
-- Antes: notificaciones-1-contar.sql. Después: notificaciones-3-verificar.sql
-- y registrar la versión 20261027150500 en schema_migrations si se aplica por el editor.

-- =============================================================================
-- 20261027150500_desatascar_cola_notificaciones.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27   Versión anterior: 20261027110334
-- Objetivo: desatascar el outbox public.notification_deliveries (DML, sin DDL).
-- =============================================================================
-- Historia:
--   · El worker del despachador (bff/src/jobs/notifications-dispatch.job.ts) lee
--     50 filas pending|failed por next_attempt_at ASC y descartaba EN MEMORIA las
--     que tenían attempts >= max_attempts. finalize() (notification.service.ts)
--     les seguía poniendo backoff aunque estuvieran agotadas.
--   · Resultado: 62 filas 'failed' 5/5 del 2026-07-24..30 encabezan siempre el
--     lote y el worker no procesa nada desde julio. Lectura del 2026-10-27:
--     2.532 pending viejas (desde 2026-10-09) + 584 failed reintentables
--     (2026-07-31..2026-10-09) + 62 failed agotadas.
--   · Mientras tanto el push lo entregó el trigger legacy trg_push_on_notification
--     (Edge Function send-push-notification), así que ese backlog YA se entregó
--     por web push o ya no tiene sentido mandarlo (avisos de hace días/meses).
--   · El código que evita que se repita va en el mismo cambio (finalize no
--     reprograma agotadas; el worker estaciona agotadas y loguea el error del select).
--
-- Qué hace (UNA transacción):
--   (a) backlog viejo (> 2 h) reintentable → status 'skipped' con
--       last_error = 'expired_backlog_2026_10_27' (rastro para auditar/revertir).
--       'skipped' está permitido por notification_deliveries_status_check
--       (pending|sent|failed|skipped).
--   (b) failed agotadas → next_attempt_at = 'infinity' (la columna es timestamptz
--       NOT NULL, no admite NULL). Dejan de encabezar la cola para siempre.
--   Las filas de las últimas 2 h quedan para que el despachador las entregue.
--
-- APLICAR ANTES de desplegar el código del BFF (orden completo en
-- docs/migraciones-pendientes-2026-10-27/LEEME.md). El worker de prod está vivo:
-- el código nuevo estaciona las agotadas por sí solo, así que si se despliega
-- primero, en menos de un minuto empieza a mandar las ~2.500 pendientes viejas.
-- Con esta migración primero, el backlog ya está en 'skipped' y además el
-- worker viejo queda desatascado. El código nuevo después evita que una
-- 'failed' que se agote más adelante vuelva a atascar la cola.
--
-- Backout:
--   (a) UPDATE public.notification_deliveries
--         SET status = CASE WHEN attempts = 0 THEN 'pending' ELSE 'failed' END,
--             last_error = NULL, next_attempt_at = now(), updated_at = now()
--       WHERE status = 'skipped' AND last_error = 'expired_backlog_2026_10_27';
--       (OJO: reenviaría miles de avisos viejos; casi nunca es lo que se quiere.)
--   (b) no hace falta revertirlo: son filas que ya no se reintentan.
-- =============================================================================

BEGIN;

-- (a) Backlog viejo reintentable → skipped con rastro.
UPDATE public.notification_deliveries
   SET status     = 'skipped',
       last_error = 'expired_backlog_2026_10_27',
       updated_at = now()
 WHERE status IN ('pending', 'failed')
   AND attempts < max_attempts
   AND created_at < now() - interval '2 hours';

-- (b) Agotadas → fuera de la cola para siempre.
UPDATE public.notification_deliveries
   SET next_attempt_at = 'infinity',
       updated_at      = now()
 WHERE status = 'failed'
   AND attempts >= max_attempts
   AND next_attempt_at <> 'infinity';

COMMIT;
