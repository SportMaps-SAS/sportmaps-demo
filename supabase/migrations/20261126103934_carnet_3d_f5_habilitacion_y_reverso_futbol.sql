-- =============================================================================
-- 20261126103934_carnet_3d_f5_habilitacion_y_reverso_futbol.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-26   Versión anterior: 20261126095105
-- Spec: docs/specs/carnet-3d-club.md §4.1, §7, §8, §10, §11 (puntos 3, 4 y 6
-- aprobados tal como se proponen).
--
-- Objetivo:
-- 1) Documentos con vigencia (§8.2): athlete_documents gana los tipos
--    sports_insurance, medical_certificate y event_authorization, y las
--    columnas valid_until (fecha de vencimiento) y event_id (solo para la
--    autorización). Solo vigente / vencido: NUNCA diagnósticos (no se tocan
--    health_records ni clinical_*). Policies de athlete_documents SIN cambios:
--    hoy hay UNA sola (school_staff_manage_athlete_documents, FOR ALL con
--    USING y WITH CHECK = is_school_admin(school_id) OR is_super_admin()), así
--    que la administración carga con vigencia por la misma vía, y la familia
--    sigue subiendo por el BFF (/api/v1/soportes, service role con candado
--    «administración o la propia familia»). No se abre nada nuevo.
-- 2) school_eligibility_rules: «Reglas para entrar» por club (qué criterios
--    pesan en el semáforo y con cuántos días de aviso). Sin fila = valores por
--    defecto (pagos + inscripción encendidos, 7 días). Lee el personal de la
--    escuela (user_staff_school_ids); escribe solo la administración
--    (user_admin_school_ids), WITH CHECK en todo. updated_at / updated_by los
--    pone el servidor.
-- 3) estado_habilitacion(p_qr_token, p_event_id) — semáforo en vivo al
--    escanear (D7, §8.1, §8.3). Solo authenticated; el público no tiene
--    acceso ({found:false}). Coach (personal de ESA escuela que no la
--    administra): semáforo verde/amarillo/rojo + motivo en una línea SIN
--    montos + datos de emergencia que la plantilla encienda (RH, EPS,
--    contacto). Admin del club, acudiente y deportista adulto: además cada
--    criterio con estado y fecha. Criterios (punto 4): pagos = TODOS los
--    cobros vencidos con el criterio del paz y salvo (20261125162425:
--    'overdue', o 'pending'/'partial' con due_date < hoy Bogotá); amarillo si
--    alguno vence en ≤ dias_aviso. Seguro y certificado = documento con
--    valid_until ≥ hoy. Autorización = solo con p_event_id. Inscripción =
--    enrollments activa, o event_registrations aprobada con evento. Gana el
--    peor estado. El alcance del caller se valida ADENTRO.
-- 4) verify_athlete_id_card_public (desde la versión viva de F1, solo estos
--    cambios): punto 3 → para el público, si el deportista es menor de edad,
--    el nombre sale enmascarado (primer nombre + iniciales). Punto 6 → el
--    nivel 'staff' se separa: la ADMINISTRACIÓN sigue con viewer='staff'
--    (compatibilidad con el frontend) y el COACH pasa a viewer='coach': ve
--    RH / EPS / contacto de emergencia / talla si la plantilla los enciende,
--    pero NO doc_number, fee_status, plan ni pagos.
-- 5) card_back_data con fútbol (F4): si el deporte es fútbol y hay datos de
--    partido (alineación de partido con minutos > 0 o eventos en
--    football_match_events), origen 'futbol' y 4 estadísticas según la
--    posición. Mismo criterio que el BFF (season-stats): «partido jugado» =
--    minutes_played > 0 en una alineación de team_match / tournament_match
--    (las de training_session no cuentan). Goles recibidos y vallas invictas
--    salen del marcador de match_results de los partidos jugados (si no hay
--    marcador, el valor va NULL: no se inventa). Sin datos → genérica.
-- 6) Helpers internos: _carnet_nivel_visor, _carnet_es_menor,
--    _carnet_emergencia (REVOKE ALL FROM PUBLIC, anon, authenticated).
--
-- RADIO: athlete_documents (≈ 1 000 filas): CHECK de tipos ampliado (todas
-- las filas existentes lo cumplen), 2 columnas nuevas en NULL, ninguna fila
-- cambia. school_eligibility_rules: tabla nueva, vacía (todas las escuelas
-- quedan con los valores por defecto). verify_athlete_id_card_public: cambia
-- lo que ven (a) el público con carnets de menores (nombre enmascarado) y (b)
-- los coaches (ya no reciben documento ni pagos). La administración y el
-- acudiente ven lo mismo que hoy. card_back_data: solo cambia para jugadores
-- de fútbol con datos de partido (hoy 3 carnets activos de una escuela).
-- ROLLBACK: DROP FUNCTION estado_habilitacion(uuid, uuid), _carnet_nivel_visor,
-- _carnet_es_menor, _carnet_emergencia, tg_school_eligibility_rules_touch;
-- DROP TABLE school_eligibility_rules; ALTER TABLE athlete_documents DROP
-- CONSTRAINT athlete_documents_event_solo_autorizacion /
-- athlete_documents_vigencia_requerida, DROP COLUMN valid_until / event_id,
-- y restaurar athlete_documents_document_type_check con los 10 tipos de antes
-- (borrando antes las filas de los 3 tipos nuevos); recrear
-- verify_athlete_id_card_public y card_back_data con su definición de
-- 20261126095105.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Documentos con vigencia
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.athlete_documents DROP CONSTRAINT IF EXISTS athlete_documents_document_type_check;
ALTER TABLE public.athlete_documents
    ADD CONSTRAINT athlete_documents_document_type_check CHECK (document_type = ANY (ARRAY[
        'athlete_photo', 'eps_certificate', 'guardian_id_front', 'guardian_id_back',
        'athlete_id_front', 'athlete_id_back', 'guardian_signature', 'athlete_signature',
        'good_standing_certificate', 'other',
        -- F5 (habilitación): solo vigencia, nunca diagnósticos.
        'sports_insurance', 'medical_certificate', 'event_authorization']::text[]));

ALTER TABLE public.athlete_documents
    ADD COLUMN IF NOT EXISTS valid_until date,
    ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES public.events(id) ON DELETE SET NULL;

-- event_id solo tiene sentido en la autorización por evento.
ALTER TABLE public.athlete_documents
    ADD CONSTRAINT athlete_documents_event_solo_autorizacion
    CHECK (event_id IS NULL OR document_type = 'event_authorization');
-- Un seguro o certificado sin fecha de vencimiento no sirve para el semáforo.
ALTER TABLE public.athlete_documents
    ADD CONSTRAINT athlete_documents_vigencia_requerida
    CHECK (document_type NOT IN ('sports_insurance', 'medical_certificate') OR valid_until IS NOT NULL);

COMMENT ON COLUMN public.athlete_documents.valid_until IS 'Vence el (carnet 3D F5). Obligatoria en sports_insurance y medical_certificate. Solo vigencia, nunca diagnósticos.';
COMMENT ON COLUMN public.athlete_documents.event_id IS 'Evento al que aplica la autorización del acudiente (solo event_authorization).';

CREATE INDEX IF NOT EXISTS athlete_documents_event_id_idx
    ON public.athlete_documents (event_id) WHERE event_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Reglas para entrar (por club)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.school_eligibility_rules (
    school_id           uuid        PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
    pagos               boolean     NOT NULL DEFAULT true,
    seguro              boolean     NOT NULL DEFAULT false,
    certificado_medico  boolean     NOT NULL DEFAULT false,
    autorizacion_evento boolean     NOT NULL DEFAULT false,
    inscripcion         boolean     NOT NULL DEFAULT true,
    dias_aviso          int         NOT NULL DEFAULT 7 CHECK (dias_aviso BETWEEN 0 AND 60),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.school_eligibility_rules IS 'Carnet 3D F5: criterios del semáforo de habilitación por club. Sin fila = pagos + inscripción, 7 días de aviso.';

-- Quién y cuándo los pone el servidor, nunca el cliente.
CREATE OR REPLACE FUNCTION public.tg_school_eligibility_rules_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
    NEW.updated_at := now();
    NEW.updated_by := COALESCE((SELECT auth.uid()), CASE WHEN TG_OP = 'UPDATE' THEN OLD.updated_by ELSE NULL END);
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_school_eligibility_rules_touch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_school_eligibility_rules_touch ON public.school_eligibility_rules;
CREATE TRIGGER trg_school_eligibility_rules_touch
    BEFORE INSERT OR UPDATE ON public.school_eligibility_rules
    FOR EACH ROW EXECUTE FUNCTION public.tg_school_eligibility_rules_touch();

ALTER TABLE public.school_eligibility_rules ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.school_eligibility_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.school_eligibility_rules TO authenticated;
GRANT ALL ON TABLE public.school_eligibility_rules TO service_role;

-- Lectura: personal de la escuela (coach incluido: es quien escanea).
CREATE POLICY school_eligibility_rules_select_staff
    ON public.school_eligibility_rules
    FOR SELECT
    TO authenticated
    USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));

-- Escritura: solo la administración (sin coaches), WITH CHECK en todo.
CREATE POLICY school_eligibility_rules_write_admin
    ON public.school_eligibility_rules
    FOR ALL
    TO authenticated
    USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))
    WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Helpers internos (solo los llaman funciones SECURITY DEFINER)
-- ─────────────────────────────────────────────────────────────────────────────

-- Nivel de quien mira un carnet: 'admin' | 'acudiente' | 'deportista' | 'coach' | 'public'.
-- La administración gana; después la familia (ve el detalle de lo suyo aunque
-- también sea coach); el coach es personal de ESA escuela que no la administra.
CREATE OR REPLACE FUNCTION public._carnet_nivel_visor(
    p_school_id uuid, p_child_id uuid, p_profile_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_uid uuid := (SELECT auth.uid());
BEGIN
    IF v_uid IS NULL OR p_school_id IS NULL THEN
        RETURN 'public';
    END IF;
    IF public.is_super_admin()
       OR p_school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]) THEN
        RETURN 'admin';
    END IF;
    IF p_child_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM public.children cc WHERE cc.id = p_child_id AND cc.parent_id = v_uid) THEN
        RETURN 'acudiente';
    END IF;
    IF p_profile_id IS NOT NULL AND p_profile_id = v_uid THEN
        RETURN 'deportista';
    END IF;
    IF p_school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]) THEN
        RETURN 'coach';
    END IF;
    RETURN 'public';
END;
$function$;

REVOKE ALL ON FUNCTION public._carnet_nivel_visor(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ¿Menor de edad? Conservador con la privacidad: un menor (children) o un
-- deportista sin cuenta SIN fecha de nacimiento se trata como menor; un
-- perfil con cuenta propia solo si su fecha lo dice.
CREATE OR REPLACE FUNCTION public._carnet_es_menor(
    p_child_id uuid, p_profile_id uuid, p_unregistered_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_dob date;
    v_hoy date := (now() AT TIME ZONE 'America/Bogota')::date;
BEGIN
    IF p_child_id IS NOT NULL THEN
        SELECT c.date_of_birth INTO v_dob FROM public.children c WHERE c.id = p_child_id;
        RETURN v_dob IS NULL OR v_dob > (v_hoy - interval '18 years')::date;
    ELSIF p_profile_id IS NOT NULL THEN
        SELECT p.date_of_birth INTO v_dob FROM public.profiles p WHERE p.id = p_profile_id;
        RETURN v_dob IS NOT NULL AND v_dob > (v_hoy - interval '18 years')::date;
    ELSIF p_unregistered_id IS NOT NULL THEN
        SELECT ua.date_of_birth INTO v_dob FROM public.unregistered_athletes ua WHERE ua.id = p_unregistered_id;
        RETURN v_dob IS NULL OR v_dob > (v_hoy - interval '18 years')::date;
    END IF;
    RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public._carnet_es_menor(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Datos de emergencia que la escuela encendió en la plantilla del carnet
-- (show_fields: blood_type, eps, emergency_contact). Lo apagado no viaja.
CREATE OR REPLACE FUNCTION public._carnet_emergencia(p_card_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_card  record;
    v_show  jsonb;
    v_out   jsonb := '{}'::jsonb;
    v_rh    text;
    v_eps   text;
    v_cont  text;
BEGIN
    SELECT c.id, c.school_id, c.template_id, c.child_id, c.profile_id, c.unregistered_athlete_id
      INTO v_card FROM public.athlete_id_cards c WHERE c.id = p_card_id;
    IF v_card.id IS NULL THEN
        RETURN v_out;
    END IF;

    SELECT t.show_fields INTO v_show FROM public.athlete_id_card_templates t WHERE t.id = v_card.template_id;
    IF v_show IS NULL THEN
        SELECT t.show_fields INTO v_show
          FROM public.athlete_id_card_templates t
         WHERE t.school_id = v_card.school_id AND t.is_default = true AND t.active = true
         ORDER BY t.updated_at DESC NULLS LAST, t.created_at DESC
         LIMIT 1;
    END IF;
    v_show := COALESCE(v_show, '{}'::jsonb);   -- por defecto los tres van apagados

    IF v_card.child_id IS NOT NULL THEN
        SELECT c.blood_type, c.eps_name, c.emergency_contact INTO v_rh, v_eps, v_cont
          FROM public.children c WHERE c.id = v_card.child_id;
    ELSIF v_card.unregistered_athlete_id IS NOT NULL THEN
        SELECT ua.blood_type, ua.eps_name,
               NULLIF(btrim(COALESCE(ua.guardian_full_name, '') || ' ' || COALESCE(ua.guardian_phone, '')), '')
          INTO v_rh, v_eps, v_cont
          FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id;
    END IF;   -- perfiles adultos: hoy no tienen RH / EPS / contacto en la base

    IF COALESCE((v_show->>'blood_type')::boolean, false) THEN
        v_out := v_out || jsonb_build_object('blood_type', v_rh);
    END IF;
    IF COALESCE((v_show->>'eps')::boolean, false) THEN
        v_out := v_out || jsonb_build_object('eps_name', v_eps);
    END IF;
    IF COALESCE((v_show->>'emergency_contact')::boolean, false) THEN
        v_out := v_out || jsonb_build_object('emergency_contact', v_cont);
    END IF;
    RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public._carnet_emergencia(uuid) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) estado_habilitacion — semáforo en vivo al escanear
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.estado_habilitacion(p_qr_token uuid, p_event_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_uid        uuid := (SELECT auth.uid());
    v_hoy        date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_card       record;
    v_nivel      text;
    v_detalle    boolean;
    v_reglas     record;
    v_r_pagos    boolean := true;
    v_r_seguro   boolean := false;
    v_r_cert     boolean := false;
    v_r_autor    boolean := false;
    v_r_inscr    boolean := true;
    v_dias       int := 7;
    v_parent     uuid;
    v_evento     record;
    v_eventos    jsonb;
    v_criterios  jsonb := '[]'::jsonb;
    -- cálculo por criterio
    v_estado     text;
    v_motivo     text;
    v_det        text;
    v_fecha      date;
    v_n          int;
    v_n2         int;
    v_d1         date;
    v_d2         date;
    v_txt        text;
    -- resumen
    v_peor       int := 0;            -- 0 verde · 1 amarillo · 2 rojo
    v_motivo_g   text;
    v_otros      int := 0;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    SELECT * INTO v_card FROM public.athlete_id_cards WHERE qr_token = p_qr_token;
    IF v_card.id IS NULL THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    -- Alcance del caller sobre ESTE carnet (personal de su escuela, acudiente,
    -- el propio deportista). Cualquier otro => igual que si no existiera.
    v_nivel := public._carnet_nivel_visor(v_card.school_id, v_card.child_id, v_card.profile_id);
    IF v_nivel = 'public' THEN
        RETURN jsonb_build_object('found', false);
    END IF;
    v_detalle := v_nivel IN ('admin', 'acudiente', 'deportista');

    IF v_card.status = 'revoked' OR v_card.valid_until < v_hoy THEN
        RETURN jsonb_build_object(
            'found', true, 'nivel', v_nivel, 'semaforo', 'rojo',
            'motivo', CASE WHEN v_card.status = 'revoked' THEN 'El carnet fue revocado' ELSE 'El carnet está vencido' END,
            'criterios', CASE WHEN v_detalle THEN '[]'::jsonb END,
            'emergencia', '{}'::jsonb, 'evento', NULL, 'eventos', '[]'::jsonb);
    END IF;

    SELECT * INTO v_reglas FROM public.school_eligibility_rules WHERE school_id = v_card.school_id;
    IF FOUND THEN
        v_r_pagos := v_reglas.pagos;        v_r_seguro := v_reglas.seguro;
        v_r_cert  := v_reglas.certificado_medico;
        v_r_autor := v_reglas.autorizacion_evento;
        v_r_inscr := v_reglas.inscripcion;  v_dias := v_reglas.dias_aviso;
    END IF;

    -- Contexto de evento: solo eventos de la escuela o donde la escuela inscribe.
    SELECT NULL::uuid AS id, NULL::text AS title, NULL::date AS event_date INTO v_evento;
    IF p_event_id IS NOT NULL THEN
        SELECT e.id, e.title, e.event_date INTO v_evento
          FROM public.events e
         WHERE e.id = p_event_id
           AND (e.school_id = v_card.school_id
                OR EXISTS (SELECT 1 FROM public.event_registrations er
                            WHERE er.event_id = e.id AND er.school_id = v_card.school_id));
        IF v_evento.id IS NULL THEN
            RETURN jsonb_build_object('found', true, 'nivel', v_nivel, 'error', 'evento_no_valido');
        END IF;
    END IF;

    -- ── Pagos al día (TODOS los cobros, criterio del paz y salvo) ───────────
    IF v_r_pagos THEN
        IF v_card.child_id IS NOT NULL THEN
            SELECT c.parent_id INTO v_parent FROM public.children c WHERE c.id = v_card.child_id;
        END IF;
        SELECT count(*) FILTER (WHERE p.status = 'overdue' OR (p.status IN ('pending', 'partial') AND p.due_date < v_hoy)),
               min(p.due_date) FILTER (WHERE p.status = 'overdue' OR (p.status IN ('pending', 'partial') AND p.due_date < v_hoy)),
               count(*) FILTER (WHERE p.status IN ('pending', 'partial') AND p.due_date BETWEEN v_hoy AND v_hoy + v_dias),
               min(p.due_date) FILTER (WHERE p.status IN ('pending', 'partial') AND p.due_date BETWEEN v_hoy AND v_hoy + v_dias)
          INTO v_n, v_d1, v_n2, v_d2
          FROM public.payments p
         WHERE p.school_id = v_card.school_id
           AND p.status IN ('overdue', 'pending', 'partial')
           AND (   (v_card.child_id IS NOT NULL AND (p.child_id = v_card.child_id
                       OR (p.child_id IS NULL AND v_parent IS NOT NULL AND p.parent_id = v_parent)))
                OR (v_card.profile_id IS NOT NULL AND (p.user_id = v_card.profile_id
                       OR (p.child_id IS NULL AND p.parent_id = v_card.profile_id)))
                OR (v_card.unregistered_athlete_id IS NOT NULL AND p.unregistered_athlete_id = v_card.unregistered_athlete_id));

        IF v_n > 0 THEN
            v_estado := 'rojo'; v_motivo := 'Tiene cobros vencidos'; v_fecha := v_d1;
            v_det := v_n || CASE WHEN v_n = 1 THEN ' cobro vencido' ELSE ' cobros vencidos' END
                     || CASE WHEN v_d1 IS NOT NULL THEN ' desde el ' || to_char(v_d1, 'DD/MM/YYYY') ELSE '' END;
        ELSIF v_n2 > 0 THEN
            v_estado := 'amarillo'; v_fecha := v_d2;
            v_motivo := 'Un cobro vence el ' || to_char(v_d2, 'DD/MM');
            v_det := v_n2 || CASE WHEN v_n2 = 1 THEN ' cobro vence' ELSE ' cobros vencen' END
                     || ' pronto; el primero, el ' || to_char(v_d2, 'DD/MM/YYYY');
        ELSE
            v_estado := 'verde'; v_motivo := 'Pagos al día'; v_det := 'Sin cobros vencidos'; v_fecha := NULL;
        END IF;
        v_criterios := v_criterios || jsonb_build_array(jsonb_build_object(
            'clave', 'pagos', 'etiqueta', 'Pagos al día', 'estado', v_estado,
            'motivo', v_motivo, 'detalle', v_det, 'fecha', v_fecha));
    END IF;

    -- ── Seguro deportivo y certificado médico (solo vigencia) ───────────────
    FOR v_txt IN SELECT unnest(ARRAY['sports_insurance', 'medical_certificate']) LOOP
        CONTINUE WHEN (v_txt = 'sports_insurance' AND NOT v_r_seguro)
                   OR (v_txt = 'medical_certificate' AND NOT v_r_cert);
        SELECT max(d.valid_until) INTO v_d1
          FROM public.athlete_documents d
         WHERE d.school_id = v_card.school_id
           AND d.document_type = v_txt
           AND (   (v_card.child_id IS NOT NULL AND d.child_id = v_card.child_id)
                OR (v_card.profile_id IS NOT NULL AND d.user_id = v_card.profile_id)
                OR (v_card.unregistered_athlete_id IS NOT NULL AND d.unregistered_athlete_id = v_card.unregistered_athlete_id));

        IF v_d1 IS NULL THEN
            v_estado := 'rojo';
            v_motivo := CASE v_txt WHEN 'sports_insurance' THEN 'Sin seguro deportivo' ELSE 'Sin certificado médico' END;
            v_det := 'No hay documento cargado';
        ELSIF v_d1 < v_hoy THEN
            v_estado := 'rojo';
            v_motivo := CASE v_txt WHEN 'sports_insurance' THEN 'Seguro deportivo vencido' ELSE 'Certificado médico vencido' END;
            v_det := 'Venció el ' || to_char(v_d1, 'DD/MM/YYYY');
        ELSIF v_d1 <= v_hoy + v_dias THEN
            v_estado := 'amarillo';
            v_motivo := CASE v_txt WHEN 'sports_insurance' THEN 'El seguro vence el ' ELSE 'El certificado médico vence el ' END
                        || to_char(v_d1, 'DD/MM');
            v_det := 'Vence el ' || to_char(v_d1, 'DD/MM/YYYY');
        ELSE
            v_estado := 'verde';
            v_motivo := CASE v_txt WHEN 'sports_insurance' THEN 'Seguro vigente' ELSE 'Certificado médico vigente' END;
            v_det := 'Vigente hasta el ' || to_char(v_d1, 'DD/MM/YYYY');
        END IF;
        v_criterios := v_criterios || jsonb_build_array(jsonb_build_object(
            'clave', CASE v_txt WHEN 'sports_insurance' THEN 'seguro' ELSE 'certificado_medico' END,
            'etiqueta', CASE v_txt WHEN 'sports_insurance' THEN 'Seguro deportivo' ELSE 'Certificado médico' END,
            'estado', v_estado, 'motivo', v_motivo, 'detalle', v_det, 'fecha', v_d1));
    END LOOP;

    -- ── Autorización del acudiente (solo con evento) ────────────────────────
    IF v_r_autor THEN
        IF v_evento.id IS NULL THEN
            v_criterios := v_criterios || jsonb_build_array(jsonb_build_object(
                'clave', 'autorizacion_evento', 'etiqueta', 'Autorización para el evento',
                'estado', 'no_aplica', 'motivo', NULL,
                'detalle', 'Solo se revisa al verificar para un evento', 'fecha', NULL));
        ELSE
            SELECT count(*), max(d.valid_until) INTO v_n, v_d1
              FROM public.athlete_documents d
             WHERE d.school_id = v_card.school_id
               AND d.document_type = 'event_authorization'
               AND d.event_id = v_evento.id
               AND (d.valid_until IS NULL OR d.valid_until >= v_hoy)
               AND (   (v_card.child_id IS NOT NULL AND d.child_id = v_card.child_id)
                    OR (v_card.profile_id IS NOT NULL AND d.user_id = v_card.profile_id)
                    OR (v_card.unregistered_athlete_id IS NOT NULL AND d.unregistered_athlete_id = v_card.unregistered_athlete_id));
            IF v_n > 0 THEN
                v_estado := 'verde'; v_motivo := 'Autorización cargada'; v_det := 'Autorización cargada para ' || v_evento.title;
            ELSE
                v_estado := 'rojo'; v_motivo := 'Falta la autorización del acudiente';
                v_det := 'No hay autorización para ' || v_evento.title;
            END IF;
            v_criterios := v_criterios || jsonb_build_array(jsonb_build_object(
                'clave', 'autorizacion_evento', 'etiqueta', 'Autorización para el evento',
                'estado', v_estado, 'motivo', v_motivo, 'detalle', v_det, 'fecha', v_d1));
        END IF;
    END IF;

    -- ── Inscripción (categoría, o el evento si se verifica para uno) ────────
    IF v_r_inscr THEN
        v_d1 := NULL;
        IF v_evento.id IS NULL THEN
            SELECT t.name, e.start_date INTO v_txt, v_d1
              FROM public.enrollments e
              LEFT JOIN public.teams t ON t.id = e.team_id
             WHERE e.school_id = v_card.school_id AND e.status = 'active'
               AND (   (v_card.child_id IS NOT NULL AND e.child_id = v_card.child_id)
                    OR (v_card.profile_id IS NOT NULL AND e.user_id = v_card.profile_id AND e.child_id IS NULL)
                    OR (v_card.unregistered_athlete_id IS NOT NULL AND e.unregistered_athlete_id = v_card.unregistered_athlete_id))
             ORDER BY e.created_at DESC
             LIMIT 1;
            IF FOUND THEN
                v_estado := 'verde'; v_motivo := 'Inscrito';
                v_det := 'Inscripción activa' || COALESCE(' en ' || v_txt, '');
            ELSE
                v_estado := 'rojo'; v_motivo := 'Sin inscripción activa'; v_det := 'No tiene inscripción activa en la escuela';
            END IF;
        ELSE
            SELECT er.status, er.approved_at::date INTO v_txt, v_d1
              FROM public.event_registrations er
             WHERE er.event_id = v_evento.id
               AND (   (v_card.child_id IS NOT NULL AND er.child_id = v_card.child_id)
                    OR (v_card.profile_id IS NOT NULL AND er.user_id = v_card.profile_id AND er.child_id IS NULL))
             ORDER BY (er.status = 'approved') DESC, er.created_at DESC
             LIMIT 1;
            IF v_txt = 'approved' THEN
                v_estado := 'verde'; v_motivo := 'Inscrito en el evento'; v_det := 'Inscripción aprobada en ' || v_evento.title;
            ELSIF v_txt = 'pending' THEN
                v_estado := 'rojo'; v_motivo := 'Inscripción al evento sin aprobar'; v_det := 'La inscripción en ' || v_evento.title || ' está pendiente';
            ELSE
                v_estado := 'rojo'; v_motivo := 'No está inscrito en el evento'; v_det := 'Sin inscripción aprobada en ' || v_evento.title;
            END IF;
        END IF;
        v_criterios := v_criterios || jsonb_build_array(jsonb_build_object(
            'clave', 'inscripcion', 'etiqueta', CASE WHEN v_evento.id IS NULL THEN 'Inscripción en la categoría' ELSE 'Inscripción en el evento' END,
            'estado', v_estado, 'motivo', v_motivo, 'detalle', v_det, 'fecha', v_d1));
    END IF;

    -- ── Resumen: gana el peor; el motivo es el del primer criterio con ese estado
    SELECT COALESCE(max(CASE c->>'estado' WHEN 'rojo' THEN 2 WHEN 'amarillo' THEN 1 ELSE 0 END), 0)
      INTO v_peor
      FROM jsonb_array_elements(v_criterios) c;

    IF v_peor = 0 THEN
        v_motivo_g := CASE WHEN jsonb_array_length(v_criterios) = 0 THEN 'La escuela no tiene reglas para entrar activas'
                           ELSE 'Habilitado' END;
    ELSE
        SELECT c->>'motivo' INTO v_motivo_g
          FROM jsonb_array_elements(v_criterios) WITH ORDINALITY AS x(c, o)
         WHERE (CASE c->>'estado' WHEN 'rojo' THEN 2 WHEN 'amarillo' THEN 1 ELSE 0 END) = v_peor
         ORDER BY o LIMIT 1;
        SELECT count(*) - 1 INTO v_otros
          FROM jsonb_array_elements(v_criterios) c
         WHERE c->>'estado' IN ('rojo', 'amarillo');
        IF v_otros > 0 THEN
            v_motivo_g := v_motivo_g || ' (+' || v_otros || ' más)';
        END IF;
    END IF;

    -- Eventos para «Verificar para: <evento>» (activos, de hoy en adelante).
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', x.id, 'titulo', x.title, 'fecha', x.event_date)
                              ORDER BY x.event_date NULLS LAST, x.title), '[]'::jsonb)
      INTO v_eventos
      FROM (SELECT e.id, e.title, e.event_date
              FROM public.events e
             WHERE e.status = 'active'
               AND COALESCE(e.end_date, e.event_date, v_hoy) >= v_hoy - 1
               AND (e.school_id = v_card.school_id
                    OR EXISTS (SELECT 1 FROM public.event_registrations er
                                WHERE er.event_id = e.id AND er.school_id = v_card.school_id))
             ORDER BY e.event_date NULLS LAST
             LIMIT 20) x;

    RETURN jsonb_build_object(
        'found', true,
        'nivel', v_nivel,
        'semaforo', CASE v_peor WHEN 2 THEN 'rojo' WHEN 1 THEN 'amarillo' ELSE 'verde' END,
        'motivo', v_motivo_g,
        'evento', CASE WHEN v_evento.id IS NULL THEN NULL
                       ELSE jsonb_build_object('id', v_evento.id, 'titulo', v_evento.title, 'fecha', v_evento.event_date) END,
        'eventos', v_eventos,
        'emergencia', public._carnet_emergencia(v_card.id),
        -- Detalle (admin, acudiente, deportista adulto). El coach NO lo recibe:
        -- solo semáforo y motivo (sin montos, sin documento).
        'criterios', CASE WHEN v_detalle THEN
                         (SELECT COALESCE(jsonb_agg(c - 'motivo' ORDER BY o), '[]'::jsonb)
                            FROM jsonb_array_elements(v_criterios) WITH ORDINALITY AS x(c, o))
                     END,
        'reglas', CASE WHEN v_detalle THEN jsonb_build_object(
                         'pagos', v_r_pagos, 'seguro', v_r_seguro, 'certificado_medico', v_r_cert,
                         'autorizacion_evento', v_r_autor, 'inscripcion', v_r_inscr, 'dias_aviso', v_dias) END,
        'sujeto', CASE WHEN v_detalle THEN jsonb_build_object(
                         'school_id', v_card.school_id,
                         'tipo', CASE WHEN v_card.child_id IS NOT NULL THEN 'child'
                                      WHEN v_card.profile_id IS NOT NULL THEN 'profile' ELSE 'unregistered' END,
                         'id', COALESCE(v_card.child_id, v_card.profile_id, v_card.unregistered_athlete_id)) END);
END;
$function$;

-- Requiere sesión; nunca anon (D7: el público no ve el semáforo).
REVOKE ALL ON FUNCTION public.estado_habilitacion(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estado_habilitacion(uuid, uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) verify_athlete_id_card_public — niveles coach / admin y menor enmascarado
--    (cuerpo de 20261126095105; cambios marcados con «F5»)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.verify_athlete_id_card_public(p_qr_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_card        record;
    v_template    record;
    v_school      record;
    v_show        jsonb;
    v_athlete_filtered jsonb := '{}'::jsonb;
    v_branch_name text;
    v_team_name   text;
    v_monthly_fee numeric;
    v_fee_status  text := 'unknown';
    v_last_paid   date;
    v_next_due    date;
    v_today       date := CURRENT_DATE;
    v_child_branch uuid;
    v_child_team   uuid;
    v_child_parent uuid;
    v_last_payment jsonb;
    v_uid          uuid := (SELECT auth.uid());
    v_is_staff     boolean := false;
    v_is_admin     boolean := false;   -- F5
    v_is_coach     boolean := false;   -- F5
    v_is_guardian  boolean := false;
    v_private      boolean := false;
    v_viewer       text := 'public';
    v_kind         text;
    v_np           jsonb;
    v_enmascarar   boolean := false;   -- F5
BEGIN
    SELECT * INTO v_card FROM public.athlete_id_cards WHERE qr_token = p_qr_token;

    IF v_card.id IS NULL THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    IF v_card.status = 'revoked' THEN
        RETURN jsonb_build_object('found', true, 'status', 'revoked', 'revoked_at', v_card.revoked_at,
                                  'reason', v_card.revocation_reason, 'codigo', v_card.codigo);
    END IF;

    IF v_card.valid_until < v_today THEN
        RETURN jsonb_build_object('found', true, 'status', 'expired', 'valid_until', v_card.valid_until,
                                  'codigo', v_card.codigo);
    END IF;

    -- ¿Quién mira? Sin sesión → público. F5: el personal se separa en
    -- administración (viewer 'staff', ve todo lo que la plantilla encienda) y
    -- coach (viewer 'coach': datos de emergencia sí; documento, plan y pagos no).
    IF v_uid IS NOT NULL THEN
        v_is_admin := public.is_super_admin()
                      OR v_card.school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]);
        v_is_staff := v_is_admin
                      OR v_card.school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]);
        v_is_coach := v_is_staff AND NOT v_is_admin;
        v_is_guardian := (v_card.profile_id IS NOT NULL AND v_card.profile_id = v_uid)
                      OR (v_card.child_id IS NOT NULL AND EXISTS (
                            SELECT 1 FROM public.children cc
                             WHERE cc.id = v_card.child_id AND cc.parent_id = v_uid));
    END IF;
    v_private := COALESCE(v_is_admin, false) OR COALESCE(v_is_guardian, false);
    v_viewer  := CASE WHEN v_is_admin THEN 'staff'
                      WHEN v_is_guardian THEN 'guardian'
                      WHEN v_is_coach THEN 'coach'
                      ELSE 'public' END;

    SELECT * INTO v_template FROM public.athlete_id_card_templates WHERE id = v_card.template_id;

    -- Carnet sin plantilla → la predeterminada activa de la escuela.
    IF v_template.id IS NULL THEN
        SELECT * INTO v_template
        FROM public.athlete_id_card_templates t
        WHERE t.school_id = v_card.school_id AND t.is_default = true AND t.active = true
        ORDER BY t.updated_at DESC NULLS LAST, t.created_at DESC
        LIMIT 1;
    END IF;

    v_show := COALESCE(v_template.show_fields, jsonb_build_object(
        'photo', true, 'doc_number', false, 'team', true, 'branch', true, 'plan', false,
        'valid_until', true, 'fee_status', false, 'blood_type', false,
        'emergency_contact', false, 'eps', false, 'tshirt_size', false));

    IF v_viewer = 'coach' THEN
        -- F5 (punto 6): el coach atiende la lesión en la cancha → RH, EPS,
        -- contacto y talla según la plantilla; documento, plan y pagos, nunca.
        v_show := v_show || jsonb_build_object('doc_number', false, 'fee_status', false, 'plan', false);
    ELSIF NOT v_private THEN
        -- Lo privado se apaga para el público aunque la plantilla lo encienda.
        v_show := v_show || jsonb_build_object(
            'doc_number', false, 'fee_status', false, 'blood_type', false,
            'emergency_contact', false, 'eps', false, 'tshirt_size', false, 'plan', false);
    END IF;

    SELECT id, name, logo_url, branding_settings, slug INTO v_school FROM public.schools WHERE id = v_card.school_id;

    IF v_card.child_id IS NOT NULL THEN
        v_kind := 'child';

        SELECT jsonb_build_object('kind', 'child', 'full_name', c.full_name,
                                  'avatar_url', COALESCE(v_card.photo_url, c.avatar_url)),
               c.branch_id, c.team_id, c.monthly_fee, c.parent_id
        INTO v_athlete_filtered, v_child_branch, v_child_team, v_monthly_fee, v_child_parent
        FROM public.children c WHERE c.id = v_card.child_id;

        IF COALESCE((v_show->>'doc_number')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('doc_type', c.doc_type, 'doc_number', c.doc_number)
            INTO v_athlete_filtered FROM public.children c WHERE c.id = v_card.child_id;
        END IF;
        IF COALESCE((v_show->>'blood_type')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('blood_type', c.blood_type)
            INTO v_athlete_filtered FROM public.children c WHERE c.id = v_card.child_id;
        END IF;
        IF COALESCE((v_show->>'eps')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('eps_name', c.eps_name)
            INTO v_athlete_filtered FROM public.children c WHERE c.id = v_card.child_id;
        END IF;
        IF COALESCE((v_show->>'tshirt_size')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('tshirt_size', c.tshirt_size)
            INTO v_athlete_filtered FROM public.children c WHERE c.id = v_card.child_id;
        END IF;
        IF COALESCE((v_show->>'emergency_contact')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('emergency_contact', c.emergency_contact)
            INTO v_athlete_filtered FROM public.children c WHERE c.id = v_card.child_id;
        END IF;

        IF COALESCE((v_show->>'branch')::boolean, true) THEN
            SELECT name INTO v_branch_name FROM public.school_branches WHERE id = v_child_branch;
        END IF;
        IF COALESCE((v_show->>'team')::boolean, true) THEN
            SELECT name INTO v_team_name FROM public.teams WHERE id = v_child_team;
        END IF;

    ELSIF v_card.profile_id IS NOT NULL THEN
        v_kind := 'profile';

        SELECT jsonb_build_object('kind', 'profile', 'full_name', p.full_name,
                                  'avatar_url', COALESCE(v_card.photo_url, p.avatar_url))
        INTO v_athlete_filtered FROM public.profiles p WHERE p.id = v_card.profile_id;

        IF COALESCE((v_show->>'doc_number')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('doc_type', p.document_type, 'doc_number', p.document_number)
            INTO v_athlete_filtered FROM public.profiles p WHERE p.id = v_card.profile_id;
        END IF;

        IF COALESCE((v_show->>'branch')::boolean, true) THEN
            SELECT sb2.name INTO v_branch_name
            FROM (
                SELECT sb2.id FROM public.team_members tm
                  JOIN public.teams t ON t.id = tm.team_id
                  JOIN public.school_branches sb2 ON sb2.id = t.branch_id
                 WHERE tm.profile_id = v_card.profile_id AND t.school_id = v_card.school_id
                UNION ALL
                SELECT sb2.id FROM public.enrollments e
                  JOIN public.teams prog ON prog.id = e.team_id
                  JOIN public.school_branches sb2 ON sb2.id = prog.branch_id
                 WHERE e.user_id = v_card.profile_id AND e.school_id = v_card.school_id AND e.status = 'active'
                UNION ALL
                SELECT sb2.id FROM public.school_members sm
                  JOIN public.school_branches sb2 ON sb2.id = sm.branch_id
                 WHERE sm.profile_id = v_card.profile_id AND sm.school_id = v_card.school_id
            ) sub
            JOIN public.school_branches sb2 ON sb2.id = sub.id
            LIMIT 1;
        END IF;

        IF COALESCE((v_show->>'team')::boolean, true) THEN
            SELECT t.name INTO v_team_name
            FROM public.team_members tm
            JOIN public.teams t ON t.id = tm.team_id
            WHERE tm.profile_id = v_card.profile_id AND t.school_id = v_card.school_id
            LIMIT 1;

            IF v_team_name IS NULL THEN
                SELECT t.name INTO v_team_name
                FROM public.enrollments e
                JOIN public.teams t ON t.id = e.team_id
                WHERE e.user_id = v_card.profile_id AND e.school_id = v_card.school_id AND e.status = 'active'
                ORDER BY e.created_at LIMIT 1;
            END IF;
        END IF;

    ELSE
        v_kind := 'unregistered';

        SELECT jsonb_build_object('kind', 'unregistered', 'full_name', ua.full_name,
                                  'avatar_url', COALESCE(v_card.photo_url, ua.avatar_url)),
               ua.branch_id
        INTO v_athlete_filtered, v_child_branch
        FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id;

        IF COALESCE((v_show->>'doc_number')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('doc_type', ua.doc_type, 'doc_number', ua.doc_number)
            INTO v_athlete_filtered FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id;
        END IF;
        IF COALESCE((v_show->>'blood_type')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('blood_type', ua.blood_type)
            INTO v_athlete_filtered FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id;
        END IF;
        IF COALESCE((v_show->>'eps')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('eps_name', ua.eps_name)
            INTO v_athlete_filtered FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id;
        END IF;
        IF COALESCE((v_show->>'emergency_contact')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object(
                     'emergency_contact',
                     NULLIF(btrim(COALESCE(ua.guardian_full_name, '') || ' ' || COALESCE(ua.guardian_phone, '')), '')
                   )
            INTO v_athlete_filtered FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id;
        END IF;

        IF COALESCE((v_show->>'branch')::boolean, true) THEN
            SELECT name INTO v_branch_name FROM public.school_branches WHERE id = v_child_branch;
        END IF;
        IF COALESCE((v_show->>'team')::boolean, true) THEN
            SELECT t.name INTO v_team_name
            FROM public.enrollments e
            JOIN public.teams t ON t.id = e.team_id
            WHERE e.unregistered_athlete_id = v_card.unregistered_athlete_id
              AND e.school_id = v_card.school_id AND e.status = 'active'
            ORDER BY e.created_at LIMIT 1;
        END IF;
    END IF;

    -- Si la fila del atleta desapareció, el objeto nunca queda NULL.
    v_athlete_filtered := COALESCE(v_athlete_filtered, jsonb_build_object('kind', v_kind));

    -- F5 (punto 3): para el público, el nombre de un menor sale enmascarado
    -- («Tomás H. M.»). El personal, el acudiente y el propio deportista lo ven completo.
    IF v_viewer = 'public' AND public._carnet_es_menor(v_card.child_id, v_card.profile_id, v_card.unregistered_athlete_id) THEN
        v_enmascarar := true;
        v_athlete_filtered := v_athlete_filtered || jsonb_build_object(
            'full_name', public._nombre_enmascarado(v_athlete_filtered->>'full_name'));
    END IF;

    IF COALESCE((v_show->>'fee_status')::boolean, false) AND v_card.unregistered_athlete_id IS NULL THEN
        SELECT jsonb_build_object('concept', p.concept, 'amount', p.amount, 'amount_paid', p.amount_paid,
                                  'payment_date', p.payment_date, 'created_at', p.created_at,
                                  'provider_reference', p.provider_reference, 'payment_method', p.payment_method),
               COALESCE(p.payment_date, p.created_at::date)
          INTO v_last_payment, v_last_paid
          FROM public.payments p
         WHERE p.school_id = v_card.school_id
           AND p.status = 'paid'
           AND ((v_card.child_id IS NOT NULL AND (p.child_id = v_card.child_id OR (p.child_id IS NULL AND v_child_parent IS NOT NULL AND p.parent_id = v_child_parent)))
                OR (v_card.profile_id IS NOT NULL AND p.parent_id = v_card.profile_id))
         ORDER BY COALESCE(p.payment_date, p.created_at::date) DESC, p.created_at DESC
         LIMIT 1;

        IF v_last_paid IS NULL THEN
            v_fee_status := 'no_payments';
            v_last_payment := NULL;
        ELSE
            IF v_today - v_last_paid <= 30 THEN
                v_fee_status := 'paid';
            ELSIF v_today - v_last_paid <= 45 THEN
                v_fee_status := 'due_soon';
            ELSE
                v_fee_status := 'overdue';
            END IF;
            v_next_due := v_last_paid + interval '30 days';
        END IF;
    ELSE
        v_fee_status := NULL;
        v_last_paid := NULL;
        v_next_due := NULL;
        v_monthly_fee := NULL;
        v_last_payment := NULL;
    END IF;

    -- Carnet 3D (F1): número y posición van en el frente, no son datos privados.
    v_np := public._carnet_numero_posicion(v_card.school_id, v_card.child_id,
                                           v_card.profile_id, v_card.unregistered_athlete_id);

    RETURN jsonb_build_object(
        'found', true,
        'status', 'active',
        'viewer', v_viewer,
        'nombre_enmascarado', v_enmascarar,
        'card_id', v_card.id,
        'qr_token', v_card.qr_token,
        'codigo', v_card.codigo,
        'numero', v_np->'numero',
        'posicion', v_np->'posicion',
        'issued_at', v_card.issued_at,
        'valid_until', v_card.valid_until,
        'version', v_card.version,
        'school', jsonb_build_object('id', v_school.id, 'name', v_school.name, 'slug', v_school.slug,
                                     'logo_url', v_school.logo_url, 'branding_settings', v_school.branding_settings),
        'template', CASE WHEN v_template.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', v_template.id,
            'name', v_template.name,
            'accent_color', v_template.accent_color,
            'secondary_color', v_template.secondary_color,
            'layout', v_template.layout,
            'pattern', v_template.pattern,
            'photo_shape', v_template.photo_shape,
            'text_mode', v_template.text_mode,
            'background_url', v_template.background_url,
            'header_text', v_template.header_text,
            'footer_text', v_template.footer_text,
            -- show_fields EFECTIVOS (con lo privado apagado según el nivel):
            -- el frontend decide qué filas pinta con esto.
            'show_fields', v_show) END,
        'athlete', v_athlete_filtered,
        'branch_name', v_branch_name,
        'team_name', v_team_name,
        'monthly_fee', v_monthly_fee,
        'fee_status', v_fee_status,
        'last_paid_at', v_last_paid,
        'next_due', v_next_due,
        'last_payment', v_last_payment
    );
END;
$function$;

-- Flujo público demostrado: /c/:token sin sesión (sin cambio de permisos).
REVOKE ALL ON FUNCTION public.verify_athlete_id_card_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_athlete_id_card_public(uuid) TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) card_back_data — reverso con fútbol (F4)
--    (cuerpo de 20261126095105; se agrega el bloque «F4 fútbol»)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.card_back_data(p_qr_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_uid      uuid := (SELECT auth.uid());
    v_card     record;
    v_tipo     text;
    v_sujeto   uuid;
    v_team     uuid;
    v_sport    text;
    v_deporte  text;
    v_np       jsonb;
    v_freq     text;
    v_total    int;
    v_asist    int;
    v_desde    date;
    v_inf_y    int;
    v_inf_m    int;
    v_meses    int;
    v_hoy      date := (now() AT TIME ZONE 'America/Bogota')::date;
    c_meses constant text[] := ARRAY['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    -- F4 fútbol
    v_pj       int := 0;
    v_min      int := 0;
    v_goles    int := 0;
    v_asis     int := 0;
    v_amar     int := 0;
    v_rojas    int := 0;
    v_eventos  int := 0;
    v_marc     int := 0;
    v_recib    int;
    v_invic    int;
    v_pos      text;
    v_grupo    text;
    v_stats    jsonb;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    SELECT * INTO v_card FROM public.athlete_id_cards WHERE qr_token = p_qr_token;
    IF v_card.id IS NULL THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    -- Personal de la escuela del carnet, acudiente o el deportista adulto.
    IF NOT (   public.is_super_admin()
            OR v_card.school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])
            OR (v_card.profile_id IS NOT NULL AND v_card.profile_id = v_uid)
            OR (v_card.child_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.children cc
                     WHERE cc.id = v_card.child_id AND cc.parent_id = v_uid))) THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    v_tipo   := CASE WHEN v_card.child_id IS NOT NULL THEN 'child'
                     WHEN v_card.profile_id IS NOT NULL THEN 'profile'
                     ELSE 'unregistered' END;
    v_sujeto := COALESCE(v_card.child_id, v_card.profile_id, v_card.unregistered_athlete_id);

    -- Equipo: la inscripción activa más reciente; si no, el equipo del menor.
    SELECT e.team_id INTO v_team
      FROM public.enrollments e
     WHERE e.school_id = v_card.school_id AND e.status = 'active' AND e.team_id IS NOT NULL
       AND (   (v_tipo = 'child' AND e.child_id = v_sujeto)
            OR (v_tipo = 'profile' AND e.user_id = v_sujeto AND e.child_id IS NULL)
            OR (v_tipo = 'unregistered' AND e.unregistered_athlete_id = v_sujeto))
     ORDER BY e.created_at DESC
     LIMIT 1;
    IF v_team IS NULL AND v_tipo = 'child' THEN
        SELECT ch.team_id INTO v_team FROM public.children ch WHERE ch.id = v_sujeto;
    END IF;

    SELECT t.sport INTO v_sport FROM public.teams t WHERE t.id = v_team;
    v_deporte := CASE WHEN translate(lower(COALESCE(v_sport, '')), 'áéíóú', 'aeiou') LIKE 'futbol%'
                      THEN 'futbol' ELSE 'generico' END;

    -- Zona de juego (D1): posición asignada; si no hay, la más frecuente de
    -- las últimas 10 alineaciones.
    v_np := public._carnet_numero_posicion(v_card.school_id, v_card.child_id,
                                           v_card.profile_id, v_card.unregistered_athlete_id);
    SELECT x.position_code INTO v_freq
      FROM (SELECT lp.position_code
              FROM public.match_lineup_players lp
              JOIN public.match_lineups ml ON ml.id = lp.lineup_id
             WHERE lp.school_id = v_card.school_id AND lp.subject_type = v_tipo
               AND lp.subject_id = v_sujeto AND lp.position_code IS NOT NULL
             ORDER BY ml.created_at DESC
             LIMIT 10) x
     GROUP BY x.position_code
     ORDER BY count(*) DESC, x.position_code
     LIMIT 1;

    -- ── F4 fútbol: estadísticas del partido (mismo criterio que season-stats del BFF)
    IF v_deporte = 'futbol' THEN
        -- Partidos jugados = alineación de PARTIDO con minutos > 0 (una vez por partido).
        WITH partidos AS (
            SELECT ml.source_type, ml.source_id, max(lp.minutes_played) AS minutos
              FROM public.match_lineup_players lp
              JOIN public.match_lineups ml ON ml.id = lp.lineup_id
             WHERE lp.school_id = v_card.school_id AND lp.subject_type = v_tipo
               AND lp.subject_id = v_sujeto
               AND ml.source_type IN ('team_match', 'tournament_match')
               AND lp.minutes_played > 0
             GROUP BY ml.source_type, ml.source_id
        ), marcador AS (
            SELECT p.source_type, p.source_id,
                   (SELECT CASE WHEN mr.is_home THEN mr.away_score ELSE mr.home_score END
                      FROM public.match_results mr
                     WHERE mr.school_id = v_card.school_id
                       AND mr.home_score IS NOT NULL AND mr.away_score IS NOT NULL
                       AND (   (p.source_type = 'team_match' AND mr.id = p.source_id)
                            OR (p.source_type = 'tournament_match' AND mr.tournament_match_id = p.source_id))
                     LIMIT 1) AS en_contra
              FROM partidos p
        )
        SELECT (SELECT count(*) FROM partidos),
               (SELECT COALESCE(sum(minutos), 0) FROM partidos),
               count(m.en_contra),
               sum(m.en_contra),
               count(*) FILTER (WHERE m.en_contra = 0)
          INTO v_pj, v_min, v_marc, v_recib, v_invic
          FROM marcador m;

        SELECT count(*) FILTER (WHERE f.type = 'goal'),
               count(*) FILTER (WHERE f.type = 'assist'),
               count(*) FILTER (WHERE f.type = 'yellow'),
               count(*) FILTER (WHERE f.type = 'red'),
               count(*)
          INTO v_goles, v_asis, v_amar, v_rojas, v_eventos
          FROM public.football_match_events f
         WHERE f.school_id = v_card.school_id AND f.subject_type = v_tipo AND f.subject_id = v_sujeto;

        IF v_pj > 0 OR v_eventos > 0 THEN
            v_pos := translate(lower(btrim(COALESCE(v_np->>'posicion', v_freq, ''))), 'áéíóú', 'aeiou');
            v_grupo := CASE
                WHEN v_pos ~ '(arquer|porter|guardamet|goler|^gk$|^po$)' THEN 'arquero'
                WHEN v_pos ~ '(medi|volante|centrocamp|pivote|enganche|interior)' THEN 'medio'
                WHEN v_pos ~ '(defens|lateral|central|zaguer|libero|carriler|^df$)' THEN 'defensa'
                WHEN v_pos ~ '(delanter|extrem|punta|ariete|atacante|^fw$|^dc$)' THEN 'delantero'
                ELSE NULL END;
            IF v_marc = 0 THEN
                v_recib := NULL; v_invic := NULL;   -- sin marcador cargado no se inventa
            END IF;

            v_stats := CASE v_grupo
                WHEN 'arquero' THEN jsonb_build_array(
                    jsonb_build_object('clave', 'partidos', 'etiqueta', 'Partidos', 'detalle', 'jugados', 'valor', v_pj::text),
                    jsonb_build_object('clave', 'minutos', 'etiqueta', 'Minutos', 'detalle', 'jugados', 'valor', v_min::text),
                    jsonb_build_object('clave', 'goles_recibidos', 'etiqueta', 'Goles recibidos', 'detalle', 'en sus partidos', 'valor', v_recib::text),
                    jsonb_build_object('clave', 'vallas_invictas', 'etiqueta', 'Vallas invictas', 'detalle', 'partidos sin goles', 'valor', v_invic::text))
                WHEN 'defensa' THEN jsonb_build_array(
                    jsonb_build_object('clave', 'partidos', 'etiqueta', 'Partidos', 'detalle', 'jugados', 'valor', v_pj::text),
                    jsonb_build_object('clave', 'minutos', 'etiqueta', 'Minutos', 'detalle', 'jugados', 'valor', v_min::text),
                    jsonb_build_object('clave', 'vallas_invictas', 'etiqueta', 'Vallas invictas', 'detalle', 'partidos sin goles', 'valor', v_invic::text),
                    jsonb_build_object('clave', 'tarjetas', 'etiqueta', 'Tarjetas', 'detalle',
                        v_amar || ' amarilla' || CASE WHEN v_amar = 1 THEN '' ELSE 's' END || ' · ' || v_rojas || ' roja' || CASE WHEN v_rojas = 1 THEN '' ELSE 's' END,
                        'valor', (v_amar + v_rojas)::text))
                ELSE jsonb_build_array(   -- delantero, medio o sin posición
                    jsonb_build_object('clave', 'goles', 'etiqueta', 'Goles', 'detalle', NULL, 'valor', v_goles::text),
                    jsonb_build_object('clave', 'asistencias', 'etiqueta', 'Asistencias', 'detalle', NULL, 'valor', v_asis::text),
                    jsonb_build_object('clave', 'partidos', 'etiqueta', 'Partidos', 'detalle', 'jugados', 'valor', v_pj::text),
                    jsonb_build_object('clave', 'minutos', 'etiqueta', 'Minutos', 'detalle', 'jugados', 'valor', v_min::text))
                END;

            RETURN jsonb_build_object(
                'found', true,
                'estado', v_card.status,
                'deporte', v_deporte,
                'deporte_nombre', v_sport,
                'zona_de_juego', jsonb_build_object(
                    'posicion', COALESCE(v_np->>'posicion', v_freq),
                    'numero',   v_np->'numero',
                    'origen',   CASE WHEN v_np->>'posicion' IS NOT NULL THEN v_np->>'origen'
                                     WHEN v_freq IS NOT NULL THEN 'alineaciones' END),
                'estadisticas', v_stats,
                'origen', 'futbol');
        END IF;
    END IF;

    -- ── Genérico (cualquier deporte o fútbol sin datos de partido)
    -- Asistencia de los últimos 90 días (las excusas no cuentan en contra).
    SELECT count(*) FILTER (WHERE ar.status <> 'excused'),
           count(*) FILTER (WHERE ar.status IN ('present', 'late'))
      INTO v_total, v_asist
      FROM public.attendance_records ar
     WHERE ar.school_id = v_card.school_id
       AND ar.attendance_date BETWEEN v_hoy - 90 AND v_hoy
       AND (   (v_tipo = 'child' AND ar.child_id = v_sujeto)
            OR (v_tipo = 'profile' AND ar.user_id = v_sujeto AND ar.child_id IS NULL)
            OR (v_tipo = 'unregistered' AND ar.unregistered_athlete_id = v_sujeto));

    SELECT min(e.start_date) INTO v_desde
      FROM public.enrollments e
     WHERE e.school_id = v_card.school_id
       AND (   (v_tipo = 'child' AND e.child_id = v_sujeto)
            OR (v_tipo = 'profile' AND e.user_id = v_sujeto AND e.child_id IS NULL)
            OR (v_tipo = 'unregistered' AND e.unregistered_athlete_id = v_sujeto));

    SELECT r.period_year, r.period_month INTO v_inf_y, v_inf_m
      FROM public.athlete_reports r
     WHERE r.school_id = v_card.school_id AND r.subject_type = v_tipo
       AND r.subject_id = v_sujeto AND r.status = 'publicado'
     ORDER BY r.period_year DESC, r.period_month DESC
     LIMIT 1;

    IF v_desde IS NOT NULL THEN
        v_meses := (EXTRACT(year FROM age(v_hoy, v_desde)) * 12 + EXTRACT(month FROM age(v_hoy, v_desde)))::int;
    END IF;

    RETURN jsonb_build_object(
        'found', true,
        'estado', v_card.status,
        'deporte', v_deporte,
        'deporte_nombre', v_sport,
        'zona_de_juego', jsonb_build_object(
            'posicion', COALESCE(v_np->>'posicion', v_freq),
            'numero',   v_np->'numero',
            'origen',   CASE WHEN v_np->>'posicion' IS NOT NULL THEN v_np->>'origen'
                             WHEN v_freq IS NOT NULL THEN 'alineaciones' END),
        'estadisticas', jsonb_build_array(
            jsonb_build_object('clave', 'asistencia', 'etiqueta', 'Asistencia', 'detalle', 'últimos 90 días',
                'valor', CASE WHEN v_total > 0 THEN round(100.0 * v_asist / v_total)::int || ' %' END),
            jsonb_build_object('clave', 'sesiones', 'etiqueta', 'Sesiones', 'detalle', 'últimos 90 días',
                'valor', CASE WHEN v_total > 0 OR v_asist > 0 THEN v_asist::text END),
            jsonb_build_object('clave', 'ultimo_informe', 'etiqueta', 'Último informe', 'detalle', NULL,
                'valor', CASE WHEN v_inf_y IS NOT NULL THEN c_meses[v_inf_m] || ' ' || v_inf_y END),
            jsonb_build_object('clave', 'antiguedad', 'etiqueta', 'En el club', 'detalle', NULL,
                'valor', CASE WHEN v_meses IS NULL THEN NULL
                              WHEN v_meses < 1 THEN 'menos de 1 mes'
                              WHEN v_meses = 1 THEN '1 mes'
                              WHEN v_meses < 12 THEN v_meses || ' meses'
                              WHEN v_meses < 24 THEN '1 año'
                              ELSE (v_meses / 12) || ' años' END)),
        'origen', 'generico');
END;
$function$;

-- Requiere sesión; nunca anon (sin cambio de permisos).
REVOKE ALL ON FUNCTION public.card_back_data(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.card_back_data(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
