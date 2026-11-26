-- =============================================================================
-- 20261126161937_carnet_codigo_con_sufijo_aleatorio.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-26   Versión anterior: 20261126154553
-- Objetivo: cerrar la ENUMERACIÓN de verificar_carnet_por_codigo (hallazgo del
-- orquestador, invariante I7 ALTA). El código era consecutivo (SM-2026-00001,
-- 00002…) y la RPC es pública: cualquiera podía recorrerlos y sacar el nombre
-- enmascarado + club de todos los carnets, casi todos de menores.
-- Decisión del usuario (2026-11-26): sufijo aleatorio en el código.
--   · Formato nuevo: SM-AAAA-NNNNN-XXXX, con XXXX = 4 caracteres de un
--     alfabeto de 31 sin ambiguos (sin 0/O, 1/I/L): 31^4 ≈ 923 mil
--     combinaciones por número. Adivinar uno exige ~460 mil intentos en
--     promedio; recorrerlos todos deja de ser práctico.
--   · Aleatoriedad: bytes de gen_random_uuid() (pg_strong_random).
--   · Los 521 carnets existentes reciben su sufijo (backfill). Cambia el
--     código que ven/imprimen; el QR (token) NO cambia y sigue sirviendo.
--   · verificar_carnet_por_codigo solo acepta el formato completo: un código
--     sin sufijo responde {found:false, motivo:'formato'}.
-- El frontend que acepta ambos formatos ya debe estar desplegado antes de
-- aplicar esto (VerificarPorCodigo.normalizarCodigo).
-- RADIO: athlete_id_cards.codigo de todas las filas (sin tocar updated_at).
-- ROLLBACK: no hay vuelta limpia sin reabrir la enumeración; si hiciera falta,
-- recrear _next_card_code y verificar_carnet_por_codigo de 20261126095105 y
-- quitar el sufijo con regexp_replace(codigo, '-[^-]{4}$', '').
-- =============================================================================

BEGIN;

-- 1) Sufijo aleatorio (interno: solo lo llama _next_card_code / el backfill)
CREATE OR REPLACE FUNCTION public._sufijo_codigo_carnet()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    c_alfabeto constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   -- 31, sin ambiguos
    v_bytes    bytea := uuid_send(gen_random_uuid());                -- bytes 0..3: aleatorios puros
    v_out      text  := '';
BEGIN
    FOR i IN 0..3 LOOP
        v_out := v_out || substr(c_alfabeto, (get_byte(v_bytes, i) % 31) + 1, 1);
    END LOOP;
    RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public._sufijo_codigo_carnet() FROM PUBLIC, anon, authenticated;

-- 2) Código nuevo al emitir: SM-AAAA-NNNNN-XXXX
CREATE OR REPLACE FUNCTION public._next_card_code(p_year int)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_seq int;
BEGIN
    INSERT INTO public.athlete_card_code_counters AS k (year, last_seq)
    VALUES (p_year, 1)
    ON CONFLICT (year) DO UPDATE
        SET last_seq = k.last_seq + 1, updated_at = now()
    RETURNING k.last_seq INTO v_seq;

    IF v_seq > 99999 THEN
        RAISE EXCEPTION 'Se agotaron los códigos de carnet del año % (máximo 99999).', p_year
            USING ERRCODE = '54000';
    END IF;

    RETURN 'SM-' || p_year::text || '-' || lpad(v_seq::text, 5, '0') || '-' || public._sufijo_codigo_carnet();
END;
$function$;

REVOKE ALL ON FUNCTION public._next_card_code(int) FROM PUBLIC, anon, authenticated;

-- 3) Backfill: los existentes reciben su sufijo (el trigger de inmutabilidad y
--    el de updated_at se apagan solo durante esta actualización).
ALTER TABLE public.athlete_id_cards DROP CONSTRAINT IF EXISTS athlete_id_cards_codigo_formato;
ALTER TABLE public.athlete_id_cards DISABLE TRIGGER trg_athlete_id_cards_codigo;
ALTER TABLE public.athlete_id_cards DISABLE TRIGGER trg_athlete_id_cards_touch;

UPDATE public.athlete_id_cards
   SET codigo = codigo || '-' || public._sufijo_codigo_carnet()
 WHERE codigo ~ '^SM-[0-9]{4}-[0-9]{5}$';

ALTER TABLE public.athlete_id_cards ENABLE TRIGGER trg_athlete_id_cards_touch;
ALTER TABLE public.athlete_id_cards ENABLE TRIGGER trg_athlete_id_cards_codigo;

ALTER TABLE public.athlete_id_cards
    ADD CONSTRAINT athlete_id_cards_codigo_formato
    CHECK (codigo ~ '^SM-[0-9]{4}-[0-9]{5}-[2-9A-HJKMNP-Z]{4}$');

-- 4) Verificación pública: solo con el código COMPLETO
CREATE OR REPLACE FUNCTION public.verificar_carnet_por_codigo(p_codigo text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_codigo text := upper(btrim(COALESCE(p_codigo, '')));
    v_card   record;
    v_nombre text;
    v_estado text;
    v_hoy    date := (now() AT TIME ZONE 'America/Bogota')::date;
BEGIN
    -- Sin el sufijo aleatorio no se responde nada (cierra la enumeración).
    IF v_codigo !~ '^SM-[0-9]{4}-[0-9]{5}-[2-9A-HJKMNP-Z]{4}$' THEN
        RETURN jsonb_build_object('found', false, 'motivo', 'formato');
    END IF;

    SELECT c.id, c.status, c.valid_until, c.child_id, c.profile_id, c.unregistered_athlete_id,
           s.name AS club, s.logo_url
      INTO v_card
      FROM public.athlete_id_cards c
      JOIN public.schools s ON s.id = c.school_id
     WHERE c.codigo = v_codigo;

    IF v_card.id IS NULL THEN
        RETURN jsonb_build_object('found', false, 'motivo', 'no_existe');
    END IF;

    SELECT COALESCE(
             (SELECT ch.full_name FROM public.children ch WHERE ch.id = v_card.child_id),
             (SELECT p.full_name FROM public.profiles p WHERE p.id = v_card.profile_id),
             (SELECT ua.full_name FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id))
      INTO v_nombre;

    v_estado := CASE WHEN v_card.status = 'revoked' THEN 'revoked'
                     WHEN v_card.status = 'expired' OR v_card.valid_until < v_hoy THEN 'expired'
                     ELSE 'active' END;

    RETURN jsonb_build_object(
        'found',  true,
        'codigo', v_codigo,
        'estado', v_estado,
        'valido', v_estado = 'active',
        'nombre', public._nombre_enmascarado(v_nombre),
        'club',   jsonb_build_object('name', v_card.club, 'logo_url', v_card.logo_url));
END;
$function$;

REVOKE ALL ON FUNCTION public.verificar_carnet_por_codigo(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verificar_carnet_por_codigo(text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
