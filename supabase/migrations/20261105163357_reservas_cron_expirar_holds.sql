-- =============================================================================
-- 20261105163357_reservas_cron_expirar_holds.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05   Versión anterior: 20261105163329
--
-- aplicar al final
--   Después de M1–M6 y de tener holds reales (F1 en uso). Depende de expirar_holds()
--   de reservas_f1_rpc_ciclo. Es higiene: la correctitud no depende de este job.
--
-- Programa expirar_holds() cada minuto (en lote, 500 por pasada, sin N+1).
-- pg_cron 1.6.4 está instalado (verificado en F0). Idempotente: reprograma si ya existe.
-- =============================================================================

-- Orden requerido: DESPUÉS de reservas_f1_rpc_ciclo (define expirar_holds). Va de última.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron no está instalado: reservas_expirar_holds NO se programó (la correctitud no depende de él).';
    RETURN;
  END IF;
  -- Idempotente: quita el job previo con ese nombre y lo vuelve a crear.
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'reservas_expirar_holds';
  PERFORM cron.schedule('reservas_expirar_holds', '* * * * *', 'SELECT public.expirar_holds()');
END
$$;
