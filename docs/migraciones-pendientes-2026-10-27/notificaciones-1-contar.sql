-- =============================================================================
-- PASO 1 del LEEME.md — Contar lo que tocará notificaciones-2-desatascar.sql.
-- Solo lectura. Mismos WHERE que la migración 20261027150500.
--
-- Lectura de referencia del 2026-10-27 (~13:20 COT):
--   a_skipped_backlog_viejo  ≈ 3.116  (2.532 pending + 584 failed reintentables)
--   b_infinity_agotadas      = 62
--   quedan_para_entregar     = las de las últimas 2 h
-- Si los números son MUY distintos, parar y revisar antes de desatascar.
-- =============================================================================
SELECT
  count(*) FILTER (WHERE status IN ('pending', 'failed')
                     AND attempts < max_attempts
                     AND created_at < now() - interval '2 hours')          AS a_skipped_backlog_viejo,
  count(*) FILTER (WHERE status = 'pending'
                     AND attempts < max_attempts
                     AND created_at < now() - interval '2 hours')          AS a_de_ellas_pending,
  count(*) FILTER (WHERE status = 'failed'
                     AND attempts < max_attempts
                     AND created_at < now() - interval '2 hours')          AS a_de_ellas_failed,
  count(*) FILTER (WHERE status = 'failed'
                     AND attempts >= max_attempts
                     AND next_attempt_at <> 'infinity')                    AS b_infinity_agotadas,
  count(*) FILTER (WHERE status IN ('pending', 'failed')
                     AND attempts < max_attempts
                     AND created_at >= now() - interval '2 hours')         AS quedan_para_entregar,
  min(created_at) FILTER (WHERE status IN ('pending', 'failed'))           AS mas_vieja_en_cola
FROM public.notification_deliveries;
