-- =============================================================================
-- 20261107101703_slug_escuela_enie_y_cedilla.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-07   Versión anterior: 20261106191635
-- Objetivo: el slug de la escuela convertía la «ñ» minúscula en «c» (y la «ç» en
--   «n»). En generate_school_slug() (20260421000002) las dos últimas letras del
--   translate() estaban cruzadas: 'ûñç' → 'ucn'. Las mayúsculas sí estaban bien
--   ('ÑÇ' → 'NC').
--   Caso real 2026-11-07: «Colegio bilingüe nuestra señora del rosario bogota»
--   nació con /colegio-bilingue-nuestra-secora-del-rosario-bogota.
-- Qué hace:
--   1. Reescribe generate_school_slug() con 'ûñç' → 'unc'. El resto del cuerpo
--      es idéntico al vivo (verificado contra pg_proc el 2026-11-07).
--   2. Corrige el slug de esa única escuela afectada. Es la única con «ñ»
--      minúscula en el nombre y slug autogenerado; la otra escuela con «ñ» ya
--      tiene un slug correcto. Todavía no publicó su página
--      (public_profile_enabled = false), así que no rompe enlaces compartidos.
-- Permisos: CREATE OR REPLACE conserva el ACL vivo (postgres + service_role).
--   Es función de trigger: no la llama ningún cliente, no necesita GRANT.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.generate_school_slug()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_base_slug text;
    v_slug      text;
    v_counter   integer := 0;
BEGIN
    IF NEW.slug IS NULL OR NEW.slug = '' THEN
        -- lowercase + remover acentos + dejar solo a-z0-9 y espacios/guiones.
        -- Las dos cadenas del translate van letra por letra: cada posición de la
        -- primera se cambia por la MISMA posición de la segunda.
        v_base_slug := lower(
            regexp_replace(
                translate(
                    COALESCE(NEW.name, ''),
                    'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛÑÇáéíóúàèìòùäëïöüâêîôûñç',
                    'AEIOUAEIOUAEIOUAEIOUNCaeiouaeiouaeiouaeiounc'
                ),
                '[^a-zA-Z0-9\s-]', '', 'g'
            )
        );
        v_base_slug := regexp_replace(v_base_slug, '\s+', '-', 'g');
        v_base_slug := regexp_replace(v_base_slug, '-+', '-', 'g');
        v_base_slug := trim(both '-' from v_base_slug);

        IF v_base_slug = '' THEN
            v_base_slug := 'escuela';
        END IF;

        v_slug := v_base_slug;

        WHILE EXISTS (
            SELECT 1 FROM public.schools
             WHERE slug = v_slug AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
        ) LOOP
            v_counter := v_counter + 1;
            v_slug := v_base_slug || '-' || v_counter;
        END LOOP;

        NEW.slug := v_slug;
    END IF;

    RETURN NEW;
END;
$function$;

-- Escuela afectada. Atado al slug viejo: idempotente y no pisa un cambio manual.
UPDATE public.schools
   SET slug = 'colegio-bilingue-nuestra-senora-del-rosario-bogota'
 WHERE id = '0a98e623-58b9-4561-bf06-76c3b5fee459'
   AND slug = 'colegio-bilingue-nuestra-secora-del-rosario-bogota'
   AND NOT EXISTS (
       SELECT 1 FROM public.schools
        WHERE slug = 'colegio-bilingue-nuestra-senora-del-rosario-bogota'
   );

-- Prueba dentro de la misma transacción: si la función sigue cruzando letras,
-- la migración entera se revierte.
DO $$
DECLARE
    v_out text;
BEGIN
    v_out := lower(regexp_replace(translate('Señora Peña Çapa',
        'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛÑÇáéíóúàèìòùäëïöüâêîôûñç',
        'AEIOUAEIOUAEIOUAEIOUNCaeiouaeiouaeiouaeiounc'), '[^a-zA-Z0-9\s-]', '', 'g'));
    IF v_out <> 'senora pena capa' THEN
        RAISE EXCEPTION 'translate del slug sigue mal: %', v_out;
    END IF;
    IF position('aeiounc''' IN (SELECT prosrc FROM pg_proc
                                 WHERE proname = 'generate_school_slug'
                                   AND pronamespace = 'public'::regnamespace)) = 0 THEN
        RAISE EXCEPTION 'generate_school_slug no quedó con el mapeo corregido';
    END IF;
END;
$$;

COMMIT;
