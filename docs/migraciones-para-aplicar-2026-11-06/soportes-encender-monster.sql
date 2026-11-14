-- =============================================================================
-- Enciende los soportes obligatorios SOLO para Monster's Volley Club.
-- Se aplica DESPUES de supabase/migrations/20261106160003_soportes_obligatorios.sql, y la aplica UNA PERSONA.
-- Solo UPDATE de school_settings (sin DDL). Si Monster no tiene fila en school_settings, aborta sin cambiar nada.
--
-- Que cambia al prenderlo: confirmar la inscripcion desde Por asignar y convocar a torneos queda bloqueado
-- mientras falte alguno de los 7 soportes del formulario de afiliacion (error SOPORTES_INCOMPLETOS con la
-- lista), y empiezan los recordatorios diarios (cada 4 dias, maximo 6) a las familias con soportes pendientes.
-- Hoy 55 de 159 deportistas no tienen los 7 (medido 2026-11-06): no se bloquean, se les recuerda.
--
-- Apagar de nuevo: UPDATE public.school_settings SET require_athlete_documents = false
--                   WHERE school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.school_settings
     SET require_athlete_documents = true,
         required_document_types   = ARRAY[
           'athlete_photo', 'eps_certificate', 'guardian_id_front', 'athlete_id_front',
           'guardian_signature', 'athlete_signature', 'good_standing_certificate'
         ]::text[]
   WHERE school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Se esperaba actualizar 1 fila de school_settings (Monster) y fueron %', v_n;
  END IF;
END $$;

-- Verificacion: debe verse true y los 7 tipos.
SELECT school_id, require_athlete_documents, required_document_types
  FROM public.school_settings
 WHERE school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';

-- Esperado: 1 (solo Monster con el flag prendido).
SELECT count(*) AS escuelas_con_flag_prendido
  FROM public.school_settings
 WHERE require_athlete_documents;

COMMIT;
