-- =============================================================================
-- 20261123112301_consentimiento_whatsapp_registro.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-23   Versión anterior: 20261123111624
-- Objetivo: guardar el consentimiento para avisos por WhatsApp que el dueño de
--   una academia / club / organización marca en el registro (casilla opcional,
--   sin marcar por defecto). Decisión de producto 3 del 22-nov-2026: sin esta
--   marca no se le escribe por WhatsApp para recordarle su configuración.
--
-- Cómo: el formulario envía `whatsapp_consent: true` en el metadata de signUp
--   (solo si la persona la marcó). Un trigger BEFORE INSERT en profiles lo copia
--   a profiles.whatsapp_consent_at con la fecha. NO se toca handle_new_user.
--   Nulo = nunca consintió (o se registró antes de existir la casilla).
--
-- Radio: columna nueva nullable sin default (cambio de catálogo, sin reescribir la
--   tabla); trigger por fila solo en altas de cuenta.
-- Nota: la persona es dueña de su fila de profiles y puede editarla; es su propio
--   consentimiento. El envío real lo valida además un registro de baja («no»).
-- =============================================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS whatsapp_consent_at timestamptz;

COMMENT ON COLUMN public.profiles.whatsapp_consent_at IS
  'Cuándo marcó la casilla de avisos por WhatsApp en el registro. NULL = no consintió.';

CREATE OR REPLACE FUNCTION public.fn_profiles_whatsapp_consent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  BEGIN
    IF NEW.whatsapp_consent_at IS NULL AND EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = NEW.id
        AND u.raw_user_meta_data ->> 'whatsapp_consent' = 'true'
    ) THEN
      NEW.whatsapp_consent_at := now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Nunca debe romper el alta de una cuenta.
    NULL;
  END;
  RETURN NEW;
END;
$$;

-- Función de trigger: solo la ejecuta el dueño.
REVOKE ALL ON FUNCTION public.fn_profiles_whatsapp_consent() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_profiles_whatsapp_consent ON public.profiles;
CREATE TRIGGER trg_profiles_whatsapp_consent
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_profiles_whatsapp_consent();

COMMIT;
