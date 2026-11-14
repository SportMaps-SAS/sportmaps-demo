-- LOTE 3 — apagar el push legacy (20261027110334). SOLO cuando Claude confirme ~30 min de entregas reales del despachador.
-- Reversible: ALTER TABLE public.notifications ENABLE TRIGGER trg_push_on_notification;

-- =============================================================================
-- 20261027110334_reaplicar_disable_legacy_push_trigger.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27   Versión anterior: 20261026155701
-- Objetivo: apagar (otra vez) el trigger legacy de web push sobre
--           public.notifications, que hoy está ENCENDIDO junto al despachador
--           nuevo y produce DOBLE push.
-- =============================================================================
-- Historia:
--   · `trg_push_on_notification` (función fn_trigger_push_on_notification) se
--     creó FUERA del repo: en cada INSERT a notifications hace POST a la Edge
--     Function `send-push-notification` (web push viejo, sin preferencias, sin
--     nativo, sin reintentos ni limpieza de tokens).
--   · 20260722000005_disable_legacy_push_trigger.sql debía apagarlo en el go-live
--     del despachador unificado (docs/specs/notifications-unified.md §2 #4, §10).
--   · Verificado en vivo el 2026-10-27: tgenabled = 'O' (encendido) para
--     trg_push_on_notification Y para trg_enqueue_notification_delivery, con
--     notification_settings.dispatch_enabled = true → cada notificación sale
--     dos veces por web push. La 20260722000005 nunca llegó a la base, o algo
--     lo volvió a encender por fuera del repo.
--   · OJO (2026-10-27): HOY el trigger legacy es el ÚNICO que entrega push. El
--     despachador del BFF está atascado (cola bloqueada por filas failed 5/5 de
--     julio). NO aplicar esta migración hasta que el despachador entregue de
--     verdad: orden completo en docs/migraciones-pendientes-2026-10-27/LEEME.md
--     (desatascar cola → desplegar código → verificar entregas → recién aquí).
--     Mientras convivan los dos habrá web push duplicado.
--
-- Qué hace: DISABLE (no DROP) del trigger, solo si existe y no está ya apagado.
-- Idempotente: correrla dos veces no cambia nada. No toca la función
-- fn_trigger_push_on_notification (con el trigger apagado no se ejecuta).
--
-- Backout (solo si el despachador del BFF deja de enviar push y hay que volver
-- al mecanismo viejo; requiere que la Edge Function siga desplegada):
--   ALTER TABLE public.notifications ENABLE TRIGGER trg_push_on_notification;
--
-- Verificación: docs/migraciones-pendientes-2026-10-27/disable-legacy-push-trigger-verificar.sql
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_estado "char";
BEGIN
  SELECT t.tgenabled INTO v_estado
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = pg_catalog.to_regclass('public.notifications')
    AND t.tgname  = 'trg_push_on_notification'
    AND NOT t.tgisinternal;

  IF NOT FOUND THEN
    RAISE NOTICE 'trg_push_on_notification no existe en public.notifications: nada que hacer.';
  ELSIF v_estado = 'D' THEN
    RAISE NOTICE 'trg_push_on_notification ya estaba apagado: nada que hacer.';
  ELSE
    EXECUTE 'ALTER TABLE public.notifications DISABLE TRIGGER trg_push_on_notification';
    RAISE NOTICE 'trg_push_on_notification apagado (estaba en %).', v_estado;
  END IF;
END
$$;

COMMIT;

INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261027110334', 'reaplicar_disable_legacy_push_trigger') ON CONFLICT (version) DO NOTHING;
