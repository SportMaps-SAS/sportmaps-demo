-- =============================================================================
-- 20261103202210_informe_corregir_publicado.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-04   Versión anterior: 20261031121849
-- Objetivo: Besser pidió corregir informes mensuales YA publicados. La vía
--   existe a medias: `set_athlete_report_note` (20260731163725) rechaza la nota
--   de un publicado con el mensaje "Usa regenerate_report_snapshot si hay que
--   corregirlo", pero esa RPC solo reemplaza el snapshot jsonb — no toca
--   coach_note — y nadie la invoca desde el frontend ni el BFF (verificado por
--   grep: 0 llamadas reales). Hoy, un informe publicado NO se puede corregir
--   desde la app. Esta migración agrega `correct_published_athlete_report`,
--   calcada de `regenerate_report_snapshot` pero que también actualiza
--   coach_note/coach_note_by en la misma transacción, igual de auditada
--   (archiva la versión vigente en athlete_report_snapshots antes de
--   sobreescribir). El informe SIGUE publicado: esto no es "reabrir" ni volver
--   a borrador, es corregir sin romper la máquina de estados.
--
--   Quién puede corregir: el pedido real vino de un ENTRENADOR, no de un
--   admin. En Besser `school_settings.reports_release_by = 'coach'`: ahí el
--   coach ya es quien PUBLICA sus propios informes (`publish_athlete_report`,
--   misma migración 20260731163725), así que corregirlos después es la misma
--   responsabilidad, no una nueva. Se copia LITERAL la autorización de
--   `publish_athlete_report`: admin siempre; coach solo si
--   `reports_release_by = 'coach'` Y `coach_can_see_report` (sus equipos,
--   incluido el atleta compartido de D19). Un coach de una escuela donde
--   publica el admin sigue sin poder corregir nada.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role):
--     REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION … TO authenticated;   -- o la pantalla da 42501/403
--     anon solo con flujo público demostrado. SECURITY DEFINER no exime al caller.
--   · Helper usado en una POLICY (USING / WITH CHECK): SÍ GRANT EXECUTE a
--     authenticated (y a anon si la policy alcanza a anon en una tabla que lee);
--     la policy corre con el rol de quien consulta: sin GRANT, 42501 en toda la tabla.
--   · Helper que solo llama otra función SECURITY DEFINER: REVOKE ALL … FROM
--     PUBLIC, anon, authenticated y sin GRANT.
--   · RPC que recibe id de escuela/usuario: validar alcance del caller sobre ESE id.
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Corrige un informe YA publicado: nota + snapshot en una sola transacción,
-- versionado y auditado igual que regenerate_report_snapshot. Autorización
-- COPIADA de publish_athlete_report (misma migración 20260731163725): admin
-- siempre, coach solo si la escuela delegó la publicación Y es su informe.
CREATE OR REPLACE FUNCTION public.correct_published_athlete_report(
    p_report_id uuid,
    p_coach_note text,
    p_snapshot   jsonb,
    p_reason     text
)
RETURNS smallint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    r            public.athlete_reports;
    v_staff_id   uuid;
    v_release_by text;
    v_es_admin   boolean;
BEGIN
    -- FOR UPDATE: mismo candado que publish/regenerate contra dos correcciones
    -- simultáneas chocando en el índice único de athlete_report_snapshots.
    SELECT * INTO r FROM public.athlete_reports WHERE id = p_report_id FOR UPDATE;

    IF r.id IS NULL THEN
        RAISE EXCEPTION 'Informe no encontrado.' USING ERRCODE = 'P0002';
    END IF;

    v_es_admin := public.can_manage_reports(r.school_id);

    SELECT COALESCE(ss.reports_release_by, 'school') INTO v_release_by
    FROM public.school_settings ss WHERE ss.school_id = r.school_id;
    v_release_by := COALESCE(v_release_by, 'school');

    IF NOT (v_es_admin
            OR (v_release_by = 'coach' AND public.coach_can_see_report(p_report_id))) THEN
        RAISE EXCEPTION 'No tienes permisos para corregir este informe.'
            USING ERRCODE = '42501';
    END IF;

    IF COALESCE(btrim(p_reason), '') = '' THEN
        RAISE EXCEPTION 'Corregir exige un motivo: queda en la auditoría.'
            USING ERRCODE = '22023';
    END IF;

    IF r.status <> 'publicado' THEN
        RAISE EXCEPTION 'Solo se corrige un informe publicado (este está %). '
                        'Antes de publicar, la nota se edita con set_athlete_report_note.', r.status
            USING ERRCODE = '55000';
    END IF;

    IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' OR p_snapshot = '{}'::jsonb THEN
        RAISE EXCEPTION 'El snapshot nuevo es obligatorio y no puede estar vacío.'
            USING ERRCODE = '22023';
    END IF;

    -- Archivar la versión vigente ANTES de sobreescribir (idéntico a
    -- regenerate_report_snapshot).
    INSERT INTO public.athlete_report_snapshots (report_id, version, snapshot, reason, archived_by)
    VALUES (r.id, r.snapshot_version, r.snapshot, btrim(p_reason), auth.uid());

    -- Mismo lookup que set_athlete_report_note: school_staff.id del caller en
    -- ESA escuela. NULL si quien corrige es un admin que no es staff.
    SELECT ss.id INTO v_staff_id
    FROM public.school_staff ss
    WHERE ss.id = ANY (public.current_staff_ids())
      AND ss.school_id = r.school_id
    LIMIT 1;

    UPDATE public.athlete_reports
       SET coach_note       = NULLIF(btrim(p_coach_note), ''),
           coach_note_by    = v_staff_id,
           snapshot         = p_snapshot,
           snapshot_version = r.snapshot_version + 1
     WHERE id = p_report_id;

    RETURN (r.snapshot_version + 1)::smallint;
END;
$$;

COMMENT ON FUNCTION public.correct_published_athlete_report(uuid, text, jsonb, text) IS
    'Corrige nota + snapshot de un informe YA publicado, en una transacción. '
    'Archiva el snapshot vigente en athlete_report_snapshots (versionado, igual '
    'que regenerate_report_snapshot) y sube snapshot_version. El informe SIGUE '
    'publicado: no revierte a borrador. Autorización igual que '
    'publish_athlete_report: admin siempre, o coach si reports_release_by = '
    '''coach'' y coach_can_see_report. Motivo obligatorio. FOR UPDATE contra '
    'correcciones simultáneas.';

REVOKE ALL ON FUNCTION public.correct_published_athlete_report(uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_published_athlete_report(uuid, text, jsonb, text) TO authenticated;

COMMIT;
