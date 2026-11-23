-- ============================================================================
-- Onboarding · Etapa 1 · Hallazgo A
-- La academia elige su deporte principal en /register (campo obligatorio) y ese
-- dato nunca llegaba a la base: el frontend no lo enviaba y nada lo guardaba.
--
-- El frontend ahora envía `sport_name` en raw_user_meta_data. Esta migración lo
-- copia a schools.sports cuando nace la escuela.
--
-- Por qué un trigger en schools y no tocar handle_new_user: handle_new_user es
-- el trigger de alta de TODA cuenta; reemitirlo para una columna es arriesgar el
-- registro entero. Este trigger es aditivo, corre BEFORE INSERT y nunca aborta
-- el alta: si algo falla, la escuela nace sin deporte, como hoy.
--
-- Solo actúa si la escuela llega sin deportes y su dueño trae `sport_name`.
-- El valor lo escribe el cliente: se limita a 80 caracteres y se guarda como
-- texto en la escuela del propio dueño (no otorga nada).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_schools_sport_from_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_sport text;
BEGIN
    IF NEW.owner_id IS NULL OR COALESCE(array_length(NEW.sports, 1), 0) > 0 THEN
        RETURN NEW;
    END IF;

    BEGIN
        SELECT NULLIF(btrim(u.raw_user_meta_data ->> 'sport_name'), '')
          INTO v_sport
          FROM auth.users u
         WHERE u.id = NEW.owner_id;
    EXCEPTION WHEN others THEN
        v_sport := NULL;
    END;

    IF v_sport IS NOT NULL AND char_length(v_sport) <= 80 THEN
        NEW.sports := ARRAY[v_sport];
    END IF;

    RETURN NEW;
END;
$$;

-- Función de trigger: nadie la llama directo.
REVOKE ALL ON FUNCTION public.fn_schools_sport_from_signup() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_schools_sport_from_signup ON public.schools;
CREATE TRIGGER trg_schools_sport_from_signup
    BEFORE INSERT ON public.schools
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_schools_sport_from_signup();

COMMIT;
