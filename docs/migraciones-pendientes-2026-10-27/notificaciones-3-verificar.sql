-- =============================================================================
-- PASO 4 del LEEME.md — Verificar que el despachador del BFF ENTREGA.
-- Solo lectura. Correr varias veces durante 30–60 min después de desatascar.
-- Son tres consultas: pegarlas de a una (el editor muestra solo el último resultado).
-- =============================================================================

-- 1) Resumen de las últimas 2 h. Lo que importa: entregadas_de_verdad > 0 y
--    pendientes_elegibles que no crezca sin parar.
SELECT
  count(*) FILTER (WHERE status = 'sent' AND updated_at > now() - interval '2 hours')                        AS sent_2h,
  count(*) FILTER (WHERE status = 'sent' AND updated_at > now() - interval '2 hours'
                     AND (web_sent > 0 OR native_sent > 0))                                                 AS entregadas_de_verdad_2h,
  coalesce(sum(web_sent)    FILTER (WHERE status = 'sent' AND updated_at > now() - interval '2 hours'), 0)  AS web_sent_2h,
  coalesce(sum(native_sent) FILTER (WHERE status = 'sent' AND updated_at > now() - interval '2 hours'), 0)  AS native_sent_2h,
  count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - interval '2 hours')                      AS failed_2h,
  count(*) FILTER (WHERE status IN ('pending', 'failed') AND attempts < max_attempts
                     AND next_attempt_at <= now())                                                          AS pendientes_elegibles,
  min(created_at) FILTER (WHERE status IN ('pending', 'failed') AND attempts < max_attempts
                     AND next_attempt_at <= now())                                                          AS elegible_mas_vieja
FROM public.notification_deliveries;

-- 2) Últimas 20 entregas 'sent' (detalle por canal).
SELECT id, created_at, updated_at, attempts, web_sent, web_failed, native_sent, native_failed, revoked, last_error
FROM public.notification_deliveries
WHERE status = 'sent' AND updated_at > now() - interval '2 hours'
ORDER BY updated_at DESC
LIMIT 20;

-- 3) Últimas respuestas de pg_net (el trigger del despachador hace POST al BFF).
--    Esperado: status_code 200. 401/403 = secreto; 404 = URL; timed_out = BFF caído.
--    Ojo: aquí también salen las llamadas de otros jobs de pg_net.
SELECT id, created, status_code, timed_out, error_msg, left(content, 160) AS content
FROM net._http_response
ORDER BY id DESC
LIMIT 20;
