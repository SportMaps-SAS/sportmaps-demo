-- =============================================================================
-- PASO 5 del LEEME.md (OPCIONAL) — Que el disparo de pg_net vaya al BFF de PROD.
--
-- Hoy (2026-10-27) notification_settings.bff_dispatch_url apunta a
-- https://bffdev.sportmaps.co/internal/notifications/dispatch: como la base es
-- una sola, las notificaciones de producción las despacha el BFF de DEV.
--
-- ANTES de correrlo, confirmar en Render que sportmaps-bff-prod tiene
-- NOTIF_DISPATCH_ENABLED=true, NOTIF_DISPATCH_SECRET (el mismo que manda
-- pg_net), VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT y FIREBASE_SERVICE_ACCOUNT.
--
-- Backout:
--   UPDATE public.notification_settings
--      SET bff_dispatch_url = 'https://bffdev.sportmaps.co/internal/notifications/dispatch',
--          updated_at = now()
--    WHERE id = true;
--
-- Después: notificaciones-3-verificar.sql, consulta 3 → status_code 200.
-- =============================================================================
BEGIN;

UPDATE public.notification_settings
   SET bff_dispatch_url = 'https://bffprod.sportmaps.co/internal/notifications/dispatch',
       updated_at       = now()
 WHERE id = true;

SELECT bff_dispatch_url, dispatch_enabled, updated_at FROM public.notification_settings;

COMMIT;
