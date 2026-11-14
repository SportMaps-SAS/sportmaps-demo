-- =============================================================================
-- Enciende el pago por plazos y la pausa/retiro desde la app y WhatsApp SOLO para Monster's Volley Club.
-- Se aplica DESPUES de 20261106160002_acuerdos_de_pago.sql y 20261106160004_retiro_y_pausa_por_canales.sql,
-- y la aplica UNA PERSONA. Solo UPDATE de school_settings (sin DDL). Si Monster no tiene fila, aborta sin cambiar nada.
--
-- Plazos:  hasta 3 cuotas y 60 dias se aprueban solos; mas que eso va a la administracion.
-- Pausa:   dentro del tope de meses por anio se aprueba sola (pause_auto_approve); fuera del tope va a la administracion.
--          El retiro y la reactivacion NUNCA se aprueban solos.
--          Retiro y reactivacion no tienen interruptor propio: comparten pause_enabled.
--
-- Apagar de nuevo:
--   UPDATE public.school_settings SET payment_agreements_enabled = false, pause_enabled = false
--    WHERE school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.school_settings
     SET payment_agreements_enabled = true,
         agreement_max_installments = 3,
         agreement_max_days         = 60,
         agreement_auto_approve     = true,
         pause_enabled              = true,
         pause_auto_approve         = true,
         pause_max_months_per_year  = 3          -- AJUSTAR con Monster antes de aplicar (D10)
   WHERE school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Se esperaba actualizar 1 fila de school_settings (Monster) y fueron %', v_n;
  END IF;
END $$;

-- Verificacion: deben verse los siete valores de arriba.
SELECT school_id, payment_agreements_enabled, agreement_max_installments, agreement_max_days, agreement_auto_approve,
       pause_enabled, pause_auto_approve, pause_max_months_per_year
  FROM public.school_settings
 WHERE school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';

-- Esperado: 1 (solo Monster con los plazos prendidos).
SELECT count(*) AS escuelas_con_plazos_prendidos FROM public.school_settings WHERE payment_agreements_enabled = true;

COMMIT;
