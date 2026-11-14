-- =============================================================================
-- 20261026155701_clase_prueba_canales_y_registro_rapido.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-26   Versión anterior: 20261025205957
-- Objetivo: clase de prueba con DOS entradas que caen en el mismo lugar
--   (pedido Dreamers 2026-10-26):
--   1. WhatsApp — el bot ya guarda el prospecto en `school_signup_leads`.
--   2. En la escuela — admin o coach registra acudiente + teléfono + nombres
--      de los niños, el niño toma la clase y listo (`registrar_clase_prueba_rapida`).
--   Los dos se ven en Deportistas → «Clase de prueba» (`listar_clase_prueba`)
--   hasta que se completan los datos con el alta normal (→ `converted`) o se
--   descartan (`cerrar_prospecto_clase_prueba`).
--   Y UNA sola configuración: `school_trial_class_settings` gana un switch por
--   canal; `obtener/guardar_config_clase_prueba` la leen y escriben junto con
--   lo del bot que vive en `school_settings` (cupos desde los entrenamientos e
--   indicaciones de qué llevar).
--
-- Por qué en `school_signup_leads` y no en children/enrollments: un prospecto
-- sin datos completos en `enrollments` contamina el motor de cobros (cicatriz
-- 20260803110621). Pasa a deportista solo por el alta normal.
--
-- Sin fila en `school_trial_class_settings` = todo prendido salvo el link
-- público (mismos defaults de la tabla): Dynasty y las demás escuelas con bot
-- siguen igual.
-- =============================================================================

BEGIN;

-- ─── 1. Switch por canal ────────────────────────────────────────────────────
-- `enabled` (ya existe) = interruptor general. `self_service_enabled` (ya
-- existe) = link público.
ALTER TABLE public.school_trial_class_settings
  ADD COLUMN IF NOT EXISTS presencial_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS whatsapp_enabled   boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.school_trial_class_settings.presencial_enabled IS
  'Registro rápido de clase de prueba en la escuela (admin/coach). Requiere enabled.';
COMMENT ON COLUMN public.school_trial_class_settings.whatsapp_enabled IS
  'El bot de WhatsApp ofrece cupos de clase de prueba. Apagado: igual guarda el prospecto, pero no ofrece cupos. Requiere enabled.';


-- ─── 2. Leer la configuración (staff: el coach necesita saber si puede registrar) ──
CREATE OR REPLACE FUNCTION public.obtener_config_clase_prueba(p_school_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_cfg  record;
    v_ss   record;
    v_slug text;
BEGIN
    IF NOT (public.is_super_admin() OR p_school_id = ANY (public.user_staff_school_ids())) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    SELECT enabled, presencial_enabled, whatsapp_enabled, self_service_enabled
      INTO v_cfg
      FROM public.school_trial_class_settings
     WHERE school_id = p_school_id;

    SELECT courtesy_from_training, wa_cortesia_indicaciones
      INTO v_ss
      FROM public.school_settings
     WHERE school_id = p_school_id;

    SELECT slug INTO v_slug FROM public.schools WHERE id = p_school_id;

    RETURN jsonb_build_object(
        'enabled',                COALESCE(v_cfg.enabled, true),
        'presencial_enabled',     COALESCE(v_cfg.presencial_enabled, true),
        'whatsapp_enabled',       COALESCE(v_cfg.whatsapp_enabled, true),
        'self_service_enabled',   COALESCE(v_cfg.self_service_enabled, false),
        'cupos_desde_entrenamientos', COALESCE(v_ss.courtesy_from_training, false),
        'indicaciones',           v_ss.wa_cortesia_indicaciones,
        'slug',                   v_slug,
        'es_admin',               (public.is_super_admin() OR public.is_school_admin(p_school_id))
    );
END;
$$;


-- ─── 3. Guardar la configuración (solo administración) ──────────────────────
-- NULL en un parámetro = no tocar ese valor.
CREATE OR REPLACE FUNCTION public.guardar_config_clase_prueba(
    p_school_id                  uuid,
    p_enabled                    boolean DEFAULT NULL,
    p_presencial_enabled         boolean DEFAULT NULL,
    p_whatsapp_enabled           boolean DEFAULT NULL,
    p_cupos_desde_entrenamientos boolean DEFAULT NULL,
    p_indicaciones               text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NOT (public.is_super_admin() OR public.is_school_admin(p_school_id)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    IF p_enabled IS NOT NULL OR p_presencial_enabled IS NOT NULL OR p_whatsapp_enabled IS NOT NULL THEN
        INSERT INTO public.school_trial_class_settings (school_id, enabled, presencial_enabled, whatsapp_enabled)
        VALUES (p_school_id, COALESCE(p_enabled, true), COALESCE(p_presencial_enabled, true), COALESCE(p_whatsapp_enabled, true))
        ON CONFLICT (school_id) DO UPDATE SET
            enabled            = COALESCE(p_enabled,            school_trial_class_settings.enabled),
            presencial_enabled = COALESCE(p_presencial_enabled, school_trial_class_settings.presencial_enabled),
            whatsapp_enabled   = COALESCE(p_whatsapp_enabled,   school_trial_class_settings.whatsapp_enabled);
    END IF;

    IF p_cupos_desde_entrenamientos IS NOT NULL OR p_indicaciones IS NOT NULL THEN
        INSERT INTO public.school_settings (school_id, courtesy_from_training, wa_cortesia_indicaciones)
        VALUES (p_school_id, COALESCE(p_cupos_desde_entrenamientos, false), NULLIF(TRIM(p_indicaciones), ''))
        ON CONFLICT (school_id) DO UPDATE SET
            courtesy_from_training   = COALESCE(p_cupos_desde_entrenamientos, school_settings.courtesy_from_training),
            wa_cortesia_indicaciones = CASE WHEN p_indicaciones IS NULL THEN school_settings.wa_cortesia_indicaciones
                                            ELSE NULLIF(TRIM(p_indicaciones), '') END;
    END IF;

    RETURN public.obtener_config_clase_prueba(p_school_id);
END;
$$;


-- ─── 4. Registro rápido en la escuela ───────────────────────────────────────
-- Un prospecto por niño, todos con el teléfono del acudiente. Adulto: un solo
-- nombre (el suyo) y sin acudiente. Si ya hay un prospecto ABIERTO con el
-- mismo teléfono y nombre, se actualiza en vez de duplicarlo. Todo en la misma
-- transacción (creación multi-fila = RPC, CLAUDE.md).
CREATE OR REPLACE FUNCTION public.registrar_clase_prueba_rapida(
    p_school_id uuid,
    p_acudiente text,
    p_telefono  text,
    p_nombres   text[],
    p_es_adulto boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_enabled    boolean;
    v_presencial boolean;
    v_slug       text;
    v_phone      text;
    v_acudiente  text;
    v_nombre     text;
    v_existing   uuid;
    v_id         uuid;
    v_ids        uuid[] := '{}';
    v_creados    int := 0;
    v_actualizados int := 0;
    v_hoy        date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_marca      jsonb;
BEGIN
    IF NOT (public.is_super_admin() OR p_school_id = ANY (public.user_staff_school_ids())) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    SELECT enabled, presencial_enabled INTO v_enabled, v_presencial
      FROM public.school_trial_class_settings WHERE school_id = p_school_id;
    IF NOT COALESCE(v_enabled, true) OR NOT COALESCE(v_presencial, true) THEN
        RAISE EXCEPTION 'El registro de clases de prueba en la escuela está apagado' USING ERRCODE = '22023';
    END IF;

    SELECT slug INTO v_slug FROM public.schools WHERE id = p_school_id;
    IF v_slug IS NULL THEN
        RAISE EXCEPTION 'Escuela no encontrada' USING ERRCODE = '02000';
    END IF;

    v_phone := NULLIF(regexp_replace(COALESCE(p_telefono, ''), '[^0-9+]', '', 'g'), '');
    IF v_phone IS NULL OR length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 7 THEN
        RAISE EXCEPTION 'Teléfono inválido' USING ERRCODE = '22023';
    END IF;

    v_acudiente := NULLIF(TRIM(p_acudiente), '');
    IF NOT COALESCE(p_es_adulto, false) AND v_acudiente IS NULL THEN
        RAISE EXCEPTION 'Falta el nombre del acudiente' USING ERRCODE = '22023';
    END IF;

    IF p_nombres IS NULL OR COALESCE(array_length(p_nombres, 1), 0) = 0 THEN
        RAISE EXCEPTION 'Falta al menos un nombre' USING ERRCODE = '22023';
    END IF;
    IF array_length(p_nombres, 1) > 10 THEN
        RAISE EXCEPTION 'Máximo 10 nombres por registro' USING ERRCODE = '22023';
    END IF;

    v_marca := jsonb_build_object(
        'canal', 'presencial',
        'registrado_por', auth.uid(),
        'etapa', 'asistio',
        'asistio_at', now(),
        'asistencia', 'asistio',
        'asistencia_at', now(),
        'asistencia_por', auth.uid(),
        'fecha_clase', v_hoy
    );

    FOREACH v_nombre IN ARRAY p_nombres LOOP
        v_nombre := NULLIF(regexp_replace(TRIM(COALESCE(v_nombre, '')), '\s+', ' ', 'g'), '');
        CONTINUE WHEN v_nombre IS NULL;

        SELECT id INTO v_existing
          FROM public.school_signup_leads
         WHERE school_id = p_school_id
           AND phone = v_phone
           AND lower(full_name) = lower(v_nombre)
           AND status IN ('new', 'contacted')
         ORDER BY created_at DESC
         LIMIT 1;

        IF v_existing IS NOT NULL THEN
            UPDATE public.school_signup_leads
               SET guardian_name = CASE WHEN p_es_adulto THEN guardian_name ELSE COALESCE(v_acudiente, guardian_name) END,
                   source_detail = COALESCE(source_detail, '{}'::jsonb)
                                   || (v_marca - 'canal' - 'registrado_por')
            WHERE id = v_existing;
            v_ids := v_ids || v_existing;
            v_actualizados := v_actualizados + 1;
        ELSE
            INSERT INTO public.school_signup_leads (
                school_id, source_slug, full_name, guardian_name, phone, how_heard, source_detail
            ) VALUES (
                p_school_id, v_slug, v_nombre,
                CASE WHEN p_es_adulto THEN NULL ELSE v_acudiente END,
                v_phone, 'presencial', v_marca
            ) RETURNING id INTO v_id;
            v_ids := v_ids || v_id;
            v_creados := v_creados + 1;
        END IF;
    END LOOP;

    IF v_creados + v_actualizados = 0 THEN
        RAISE EXCEPTION 'Falta al menos un nombre' USING ERRCODE = '22023';
    END IF;

    RETURN jsonb_build_object('ok', true, 'lead_ids', to_jsonb(v_ids),
                              'creados', v_creados, 'actualizados', v_actualizados);
END;
$$;


-- ─── 5. La pestaña «Clase de prueba» de Deportistas ─────────────────────────
-- Todos los prospectos abiertos (new/contacted) de todos los canales, con su
-- cupo si reservó. Staff: el coach también la ve.
CREATE OR REPLACE FUNCTION public.listar_clase_prueba(p_school_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_rows jsonb;
BEGIN
    IF NOT (public.is_super_admin() OR p_school_id = ANY (public.user_staff_school_ids())) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT l.id, l.full_name, l.guardian_name, l.phone, l.email, l.gender, l.birth_date,
               l.how_heard, l.notes, l.status, l.created_at,
               COALESCE(l.source_detail->>'canal',
                        CASE WHEN l.how_heard = 'whatsapp' THEN 'whatsapp' ELSE 'formulario' END) AS canal,
               l.source_detail->>'asistencia' AS asistencia,
               COALESCE(l.source_detail->>'fecha_clase', ts.slot_date::text) AS fecha_clase,
               ts.label      AS cupo_label,
               ts.start_time AS cupo_hora
          FROM public.school_signup_leads l
          LEFT JOIN public.school_trial_slots ts ON ts.id = l.trial_slot_id
         WHERE l.school_id = p_school_id
           AND l.status IN ('new', 'contacted')
         LIMIT 500
      ) t;

    RETURN v_rows;
END;
$$;


-- ─── 6. Sacarlo de la pestaña: inscrito (alta hecha) o descartado ───────────
-- Inscrito: staff (el coach también da altas). Se amarra a la inscripción más
-- reciente del deportista en la escuela, si la hay. Descartado: administración.
CREATE OR REPLACE FUNCTION public.cerrar_prospecto_clase_prueba(
    p_lead_id         uuid,
    p_estado          text,
    p_child_id        uuid DEFAULT NULL,
    p_user_id         uuid DEFAULT NULL,
    p_unregistered_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_school_id uuid;
    v_enrollment_id uuid;
BEGIN
    IF p_estado NOT IN ('converted', 'discarded') THEN
        RAISE EXCEPTION 'Estado inválido' USING ERRCODE = '22023';
    END IF;

    SELECT school_id INTO v_school_id FROM public.school_signup_leads WHERE id = p_lead_id;
    IF v_school_id IS NULL THEN
        RAISE EXCEPTION 'Prospecto no encontrado' USING ERRCODE = '02000';
    END IF;

    IF p_estado = 'discarded' THEN
        IF NOT (public.is_super_admin() OR public.is_school_admin(v_school_id)) THEN
            RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
        END IF;
    ELSIF NOT (public.is_super_admin() OR v_school_id = ANY (public.user_staff_school_ids())) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    IF p_estado = 'converted' AND COALESCE(p_child_id, p_user_id, p_unregistered_id) IS NOT NULL THEN
        SELECT e.id INTO v_enrollment_id
          FROM public.enrollments e
         WHERE e.school_id = v_school_id
           AND ((p_child_id IS NOT NULL AND e.child_id = p_child_id)
             OR (p_user_id IS NOT NULL AND e.user_id = p_user_id AND e.child_id IS NULL)
             OR (p_unregistered_id IS NOT NULL AND e.unregistered_athlete_id = p_unregistered_id))
         ORDER BY e.created_at DESC
         LIMIT 1;
    END IF;

    UPDATE public.school_signup_leads
       SET status = p_estado,
           converted_enrollment_id = CASE WHEN p_estado = 'converted' THEN v_enrollment_id ELSE converted_enrollment_id END,
           source_detail = COALESCE(source_detail, '{}'::jsonb) || jsonb_build_object(
               'etapa', CASE WHEN p_estado = 'converted' THEN 'inscrito' ELSE 'descartado' END,
               CASE WHEN p_estado = 'converted' THEN 'inscrito_at' ELSE 'descartado_at' END, now(),
               'cerrado_por', auth.uid())
     WHERE id = p_lead_id;

    RETURN jsonb_build_object('ok', true, 'lead_id', p_lead_id, 'status', p_estado,
                              'enrollment_id', v_enrollment_id);
END;
$$;


-- ─── 7. Cerrar un cupo cargado a mano (los de entrenamientos los maneja el job) ──
CREATE OR REPLACE FUNCTION public.cerrar_cupo_clase_prueba(p_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_school_id uuid;
BEGIN
    SELECT school_id INTO v_school_id FROM public.school_trial_slots WHERE id = p_slot_id;
    IF v_school_id IS NULL THEN
        RAISE EXCEPTION 'Cupo no encontrado' USING ERRCODE = '02000';
    END IF;
    IF NOT (public.is_super_admin() OR public.is_school_admin(v_school_id)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    UPDATE public.school_trial_slots SET is_open = false WHERE id = p_slot_id;
    RETURN jsonb_build_object('ok', true, 'id', p_slot_id);
END;
$$;


-- ─── 8. Permisos: solo authenticated (trampa 3: revocar explícito de anon) ──
REVOKE ALL ON FUNCTION public.obtener_config_clase_prueba(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.guardar_config_clase_prueba(uuid, boolean, boolean, boolean, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.registrar_clase_prueba_rapida(uuid, text, text, text[], boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.listar_clase_prueba(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cerrar_prospecto_clase_prueba(uuid, text, uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cerrar_cupo_clase_prueba(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.obtener_config_clase_prueba(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.guardar_config_clase_prueba(uuid, boolean, boolean, boolean, boolean, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.registrar_clase_prueba_rapida(uuid, text, text, text[], boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.listar_clase_prueba(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cerrar_prospecto_clase_prueba(uuid, text, uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cerrar_cupo_clase_prueba(uuid) TO authenticated, service_role;

COMMIT;
