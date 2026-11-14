-- =============================================================================
-- Consumo de la IA de la pizarra de UNA escuela (por defecto Club Carmel)
-- 2026-10-27 — prueba de Carmel con cupo x3 hasta el 2026-11-04 23:59 (Bogotá),
-- migración 20261027110401_pizarra_ia_cupo_ampliado_temporal.
--
-- Solo lectura. Usa índices (tactical_ai_runs_school_period_idx). Fechas en
-- hora Colombia. Cambiar el school_id del CTE para otra escuela.
--
-- Fuente: tactical_ai_runs (una fila por intento). status:
--   settled   = análisis hecho y cobrado (costo real)     → «análisis»
--   cache_hit = misma jugada ya analizada, USD 0           → «de la caché»
--   denied    = sin cupo (pidió y no se llamó al modelo)   → «sin cupo»
--   released / expired = falló el modelo o se cayó el BFF  → no cobró
-- Tipo de análisis = deporte de la jugada (sport).
-- =============================================================================

-- 1) Por DÍA, USUARIO y TIPO (deporte)
WITH esc AS (SELECT '374a6716-af42-4745-afe1-8d089153e01b'::uuid AS id)
SELECT (r.created_at AT TIME ZONE 'America/Bogota')::date            AS dia,
       COALESCE(p.full_name, '(usuario borrado)')                     AS usuario,
       r.sport                                                        AS tipo,
       COUNT(*) FILTER (WHERE r.status = 'settled')                   AS analisis,
       COUNT(*) FILTER (WHERE r.status = 'cache_hit')                 AS de_cache,
       COUNT(*) FILTER (WHERE r.status = 'denied')                    AS sin_cupo,
       COUNT(*) FILTER (WHERE r.status IN ('released', 'expired'))    AS fallidos,
       ROUND(SUM(r.cost_micro_usd) / 1e6, 4)                          AS usd,
       SUM(r.input_tokens + r.cache_read_tokens + r.cache_write_tokens) AS tokens_entrada,
       SUM(r.output_tokens)                                           AS tokens_salida
  FROM public.tactical_ai_runs r
  JOIN esc ON esc.id = r.school_id
  LEFT JOIN public.profiles p ON p.id = r.user_id
 GROUP BY 1, 2, 3
 ORDER BY 1, 2, 3;

-- 2) Total del mes por usuario contra su cupo (base × multiplicador vigente)
WITH esc AS (SELECT '374a6716-af42-4745-afe1-8d089153e01b'::uuid AS id)
SELECT u.period,
       COALESCE(p.full_name, '(usuario borrado)')                              AS usuario,
       u.analyses, u.cache_hits, u.needs_more_count                            AS veces_sin_cupo,
       ROUND(u.used_micro_usd / 1e6, 4)                                        AS usado_usd,
       ROUND(u.budget_micro_usd / 1e6, 2)                                      AS cupo_base_usd,
       public.tactical_ai_quota_multiplier(u.school_id)                        AS multiplicador_hoy,
       ROUND((u.budget_micro_usd * public.tactical_ai_quota_multiplier(u.school_id) + u.extra_micro_usd) / 1e6, 2) AS cupo_hoy_usd,
       u.limit_hit_at AT TIME ZONE 'America/Bogota'                            AS topo_el
  FROM public.tactical_ai_user_usage u
  JOIN esc ON esc.id = u.school_id
  LEFT JOIN public.profiles p ON p.id = u.user_id
 ORDER BY u.period DESC, u.used_micro_usd DESC;
-- (multiplicador_hoy existe solo después de aplicar 20261027110401; antes, quitar esas dos columnas.)

-- 3) Utilidad de las sugerencias (después de 20261027110420)
WITH esc AS (SELECT '374a6716-af42-4745-afe1-8d089153e01b'::uuid AS id)
SELECT f.sport AS tipo, f.suggestion_kind AS sugerencia,
       COUNT(*) FILTER (WHERE f.verdict = 'util')            AS utiles,
       COUNT(*) FILTER (WHERE f.verdict = 'no_util')         AS no_utiles,
       COUNT(*) FILTER (WHERE f.saved_as_play_at IS NOT NULL) AS guardadas_como_jugada
  FROM public.tactical_ai_suggestion_feedback f
  JOIN esc ON esc.id = f.school_id
 GROUP BY 1, 2
 ORDER BY 1, 2;
