-- =============================================================================
-- Verificación de 20261027110334_reaplicar_disable_legacy_push_trigger
-- Correr DESPUÉS de pegar disable-legacy-push-trigger.sql. Solo lectura.
--
-- Resultado esperado: UNA fila con resultado = 'OK' (trigger legacy apagado,
-- despachador nuevo encendido). Cualquier otro valor dice qué falta.
-- tgenabled: 'O' = encendido · 'D' = apagado · 'R'/'A' = replica/always.
-- =============================================================================
WITH t AS (
  SELECT
    max(tg.tgenabled::text) FILTER (WHERE tg.tgname = 'trg_push_on_notification')          AS legacy,
    max(tg.tgenabled::text) FILTER (WHERE tg.tgname = 'trg_enqueue_notification_delivery') AS despachador
  FROM pg_catalog.pg_trigger tg
  WHERE tg.tgrelid = pg_catalog.to_regclass('public.notifications')
    AND NOT tg.tgisinternal
)
SELECT
  CASE
    WHEN legacy IS NULL                   THEN 'OK (el trigger legacy no existe)'
    WHEN legacy = 'D' AND despachador = 'O' THEN 'OK'
    WHEN legacy = 'D'                     THEN 'OJO: legacy apagado pero el despachador NO está encendido (estado ' || coalesce(despachador, 'inexistente') || ') → nadie envía push'
    ELSE 'FALLA: trg_push_on_notification sigue encendido (tgenabled=' || legacy || ') → doble push'
  END AS resultado,
  legacy      AS tgenabled_trg_push_on_notification,
  despachador AS tgenabled_trg_enqueue_notification_delivery
FROM t;
