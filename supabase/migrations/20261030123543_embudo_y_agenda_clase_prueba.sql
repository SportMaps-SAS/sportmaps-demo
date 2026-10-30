-- =============================================================================
-- 20261030123543_embudo_y_agenda_clase_prueba.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-30   Versión anterior: 20261029222300
-- Objetivo: M1 del plan maestro del bot de WhatsApp de Monster
-- (docs/specs/whatsapp-monster-plan-maestro.md §2; base: plan B2/B3 §2).
--   · Embudo del interesado por escuela (school_settings.wa_*), modo discreto y
--     temas que pasan a una persona por escuela (B6).
--   · Agenda de la clase de prueba: nombre, horas para separar el cupo, cupos por
--     sesión, días de la semana, aviso al profe (school_trial_class_settings).
--   · teams.recibe_clase_prueba (D1 de Monster: la prueba va a Proyección) y
--     dirección, enlace de Maps e indicaciones de la cancha (facilities).
--   · Lead del embudo: sede, grupo, respuestas y cupo SEPARADO (columnas propias:
--     trial_slot_id sigue significando «agendada» para todos los lectores de hoy).
--   · Semana del profe: team_schedule_exceptions con RLS + RPC de la pantalla.
--   · RPC solo-BFF para tomar / confirmar / soltar el cupo.
--   · listar_clase_prueba reemplazada desde el cuerpo VIVO (2026-10-30), solo
--     agregando claves.
--
-- TODO NACE APAGADO: columnas NULL/false/'global' = el comportamiento de hoy para
-- Dynasty, Dreamers y las demás. Ninguna fila existente cambia de valor.
--
-- Hallazgo al escribirla (base viva 2026-10-30): teams.coach_id y
-- team_coaches.coach_id apuntan a school_staff(id), NO a profiles. El borrador del
-- plan comparaba con auth.uid(); aquí el «¿es el profe de este equipo?» va por
-- user_coached_team_ids() (school_staff.coach_auth_id / correo), la misma regla que
-- ya usa la policy «Teams: coach update own». Quien avise al profe desde el BFF
-- tiene que traducir school_staff.id → coach_auth_id para notifications.user_id.
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

-- ── 1. Ajustes del embudo y de la atención por escuela (school_settings) ─────
-- Sin IF NOT EXISTS a propósito: si alguna ya existiera, que falle y se mire.
-- NULL = el comportamiento de hoy. Solo las lee el BFF (service_role); la
-- validación fina del contenido la hace el BFF y, si es inválido, el embudo queda
-- apagado. Aquí solo la forma, con jsonpath (sin funciones propias en el CHECK:
-- un CHECK con función exige EXECUTE a quien escribe la tabla).
ALTER TABLE public.school_settings
    ADD COLUMN wa_bienvenida text
        CONSTRAINT school_settings_wa_bienvenida_check
        CHECK (wa_bienvenida IS NULL OR length(wa_bienvenida) BETWEEN 1 AND 1000),
    ADD COLUMN wa_botones_sede jsonb
        CONSTRAINT school_settings_wa_botones_sede_check
        CHECK (wa_botones_sede IS NULL OR (
            jsonb_typeof(wa_botones_sede) = 'array'
            AND jsonb_array_length(wa_botones_sede) BETWEEN 1 AND 10
            AND NOT (wa_botones_sede @? '$[*] ? (@.type() != "object"
                || !(exists(@.branch_id)) || !(exists(@.titulo))
                || @.branch_id.type() != "string" || @.titulo.type() != "string"
                || !(@.branch_id like_regex "^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")
                || !(@.titulo like_regex "^.{1,20}$"))'))),
    ADD COLUMN wa_preguntas_prospecto jsonb
        CONSTRAINT school_settings_wa_preguntas_prospecto_check
        CHECK (wa_preguntas_prospecto IS NULL OR (
            jsonb_typeof(wa_preguntas_prospecto) = 'array'
            AND jsonb_array_length(wa_preguntas_prospecto) BETWEEN 1 AND 15
            AND NOT (wa_preguntas_prospecto @? '$[*] ? (@.type() != "object"
                || !(exists(@.clave)) || !(exists(@.texto)) || !(exists(@.tipo))
                || @.clave.type() != "string" || @.texto.type() != "string" || @.tipo.type() != "string"
                || !(@.clave like_regex "^[a-z0-9_]{1,40}$")
                || !(@.tipo like_regex "^(texto|fecha|botones|lista)$"))'))),
    ADD COLUMN wa_modo_discreto text NOT NULL DEFAULT 'global'
        CONSTRAINT school_settings_wa_modo_discreto_check
        CHECK (wa_modo_discreto IN ('global', 'si', 'no')),
    ADD COLUMN wa_temas_a_persona jsonb
        CONSTRAINT school_settings_wa_temas_a_persona_check
        CHECK (wa_temas_a_persona IS NULL OR (
            jsonb_typeof(wa_temas_a_persona) = 'array'
            AND jsonb_array_length(wa_temas_a_persona) <= 40
            AND NOT (wa_temas_a_persona @? '$[*] ? (@.type() != "string")')));

COMMENT ON COLUMN public.school_settings.wa_bienvenida IS
    'Bot de WhatsApp: bienvenida al número desconocido en el embudo del interesado (≤1000). NULL = la de hoy. (20261030123543)';
COMMENT ON COLUMN public.school_settings.wa_botones_sede IS
    'Bot de WhatsApp: botones de sede de la bienvenida, [{branch_id, titulo≤20}] en orden. NULL = sin pregunta de sede. (20261030123543)';
COMMENT ON COLUMN public.school_settings.wa_preguntas_prospecto IS
    'Bot de WhatsApp: preguntas del embudo, [{clave, texto, tipo: texto|fecha|botones|lista, opciones?, detalle?}]. '
    'Claves reservadas: nombre, fecha_nacimiento, sexo. NULL = embudo apagado (como hoy). (20261030123543)';
COMMENT ON COLUMN public.school_settings.wa_modo_discreto IS
    'Bot de WhatsApp: modo discreto por escuela. global = la variable de entorno de hoy; si / no = forzado. (20261030123543)';
COMMENT ON COLUMN public.school_settings.wa_temas_a_persona IS
    'Bot de WhatsApp: temas que pasan a una persona (claves de texto). NULL = la lista global de hoy. (20261030123543)';

-- ── 2. Agenda de la clase de prueba (school_trial_class_settings) ────────────
-- El valor sigue siendo trial_price (20261029215003). NULL = como hoy.
ALTER TABLE public.school_trial_class_settings
    ADD COLUMN nombre_clase text
        CONSTRAINT school_trial_class_settings_nombre_clase_check
        CHECK (nombre_clase IS NULL OR nombre_clase IN ('cortesia', 'prueba')),
    ADD COLUMN separar_horas smallint
        CONSTRAINT school_trial_class_settings_separar_horas_check
        CHECK (separar_horas IS NULL OR separar_horas BETWEEN 1 AND 72),
    ADD COLUMN cupos_por_sesion smallint
        CONSTRAINT school_trial_class_settings_cupos_por_sesion_check
        CHECK (cupos_por_sesion IS NULL OR cupos_por_sesion BETWEEN 1 AND 500),
    ADD COLUMN agendar_al_recibir boolean NOT NULL DEFAULT true,
    ADD COLUMN avisar_entrenador boolean NOT NULL DEFAULT false,
    ADD COLUMN dias_semana smallint[]
        CONSTRAINT school_trial_class_settings_dias_semana_check
        CHECK (dias_semana IS NULL OR (
            cardinality(dias_semana) BETWEEN 1 AND 7
            AND array_position(dias_semana, NULL) IS NULL
            AND dias_semana <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]));

COMMENT ON COLUMN public.school_trial_class_settings.nombre_clase IS
    'Cómo la llama el bot: cortesia («clase de cortesía») o prueba («clase de prueba»). NULL = cortesía, como hoy. (20261030123543)';
COMMENT ON COLUMN public.school_trial_class_settings.separar_horas IS
    'Horas que el bot separa el cupo esperando el comprobante (1-72). NULL = sin flujo de pago en el bot. (20261030123543)';
COMMENT ON COLUMN public.school_trial_class_settings.cupos_por_sesion IS
    'Cupos por sesión de las franjas generadas (1-500). NULL = 999, como hoy. (20261030123543)';
COMMENT ON COLUMN public.school_trial_class_settings.agendar_al_recibir IS
    'D9: agenda al recibir el comprobante si monto y destino coinciden (true) o al revisarlo (false). (20261030123543)';
COMMENT ON COLUMN public.school_trial_class_settings.avisar_entrenador IS
    'Avisa al profe del equipo cuando se agenda, cambia o cancela una clase de prueba. (20261030123543)';
COMMENT ON COLUMN public.school_trial_class_settings.dias_semana IS
    'Días con clase de prueba: 0 = domingo … 6 = sábado (igual que teams.schedule[].day). NULL = todos. (20261030123543)';

-- ── 3. Equipos y canchas ─────────────────────────────────────────────────────
-- No se reusa admite_nuevos: eso dice si el grupo recibe deportistas inscritos.
ALTER TABLE public.teams
    ADD COLUMN recibe_clase_prueba boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.teams.recibe_clase_prueba IS
    'El embudo del bot solo ofrece clase de prueba en equipos con true (Monster: solo Proyección). (20261030123543)';

-- facilities ya es legible por anon cuando status = 'available' (policy
-- facilities_select_public): dirección, enlace e indicaciones son públicos a
-- propósito (canchas de parques y colegios).
ALTER TABLE public.facilities
    ADD COLUMN address text
        CONSTRAINT facilities_address_check
        CHECK (address IS NULL OR length(address) BETWEEN 1 AND 200),
    ADD COLUMN maps_url text
        CONSTRAINT facilities_maps_url_check
        CHECK (maps_url IS NULL OR (length(maps_url) <= 500 AND maps_url ~ '^https://[^\s"''<>`]+$')),
    ADD COLUMN indicaciones text
        CONSTRAINT facilities_indicaciones_check
        CHECK (indicaciones IS NULL OR length(indicaciones) BETWEEN 1 AND 500);

COMMENT ON COLUMN public.facilities.address IS 'Dirección de la cancha (la usa el bot al confirmar la clase). (20261030123543)';
COMMENT ON COLUMN public.facilities.maps_url IS 'Enlace de Google Maps de la cancha (https). (20261030123543)';
COMMENT ON COLUMN public.facilities.indicaciones IS 'Por dónde se entra, qué pasa si llueve. (20261030123543)';

-- ── 4. Lead del embudo y cupo separado ───────────────────────────────────────
ALTER TABLE public.school_signup_leads
    ADD COLUMN branch_id uuid REFERENCES public.school_branches(id) ON DELETE SET NULL,
    ADD COLUMN team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
    ADD COLUMN respuestas jsonb
        CONSTRAINT school_signup_leads_respuestas_check
        CHECK (respuestas IS NULL OR jsonb_typeof(respuestas) = 'object'),
    ADD COLUMN cupo_separado_slot_id uuid REFERENCES public.school_trial_slots(id) ON DELETE SET NULL,
    ADD COLUMN cupo_separado_hasta timestamptz,
    ADD CONSTRAINT chk_lead_cupo_separado
        CHECK ((cupo_separado_slot_id IS NULL) = (cupo_separado_hasta IS NULL));

COMMENT ON COLUMN public.school_signup_leads.branch_id IS 'Sede que eligió el interesado en el embudo del bot. (20261030123543)';
COMMENT ON COLUMN public.school_signup_leads.team_id IS
    'Grupo que eligió el bot (o el que recomendó el profe; el del bot queda en source_detail.team_id_bot). (20261030123543)';
COMMENT ON COLUMN public.school_signup_leads.respuestas IS 'Respuestas del embudo que no tienen columna propia (posición, trayectoria…). (20261030123543)';
COMMENT ON COLUMN public.school_signup_leads.cupo_separado_slot_id IS
    'Cupo SEPARADO esperando el comprobante (cuenta en reserved_count). trial_slot_id sigue siendo «agendada». (20261030123543)';
COMMENT ON COLUMN public.school_signup_leads.cupo_separado_hasta IS 'Vence el cupo separado; lo suelta soltar_cupos_separados. (20261030123543)';

CREATE INDEX idx_leads_cupo_separado
    ON public.school_signup_leads (cupo_separado_hasta)
    WHERE cupo_separado_hasta IS NOT NULL;
CREATE INDEX idx_leads_cupo_separado_slot
    ON public.school_signup_leads (cupo_separado_slot_id)
    WHERE cupo_separado_slot_id IS NOT NULL;

-- Si se borra la franja, el ON DELETE SET NULL deja cupo_separado_hasta sin
-- pareja y el CHECK haría fallar el borrado. Este trigger limpia la pareja (corre
-- también en el UPDATE que hace la FK).
CREATE FUNCTION public._lead_cupo_separado_pareja()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NEW.cupo_separado_slot_id IS NULL THEN
        NEW.cupo_separado_hasta := NULL;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._lead_cupo_separado_pareja() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_lead_cupo_separado_pareja
    BEFORE UPDATE OF cupo_separado_slot_id ON public.school_signup_leads
    FOR EACH ROW
    WHEN (NEW.cupo_separado_slot_id IS NULL AND OLD.cupo_separado_slot_id IS NOT NULL)
    EXECUTE FUNCTION public._lead_cupo_separado_pareja();

-- ── 5. Franjas: por qué se cerró (solo el generador reabre las suyas) ────────
ALTER TABLE public.school_trial_slots
    ADD COLUMN cerrada_por text
        CONSTRAINT school_trial_slots_cerrada_por_check
        CHECK (cerrada_por IS NULL OR cerrada_por IN ('escuela', 'horario'));

COMMENT ON COLUMN public.school_trial_slots.cerrada_por IS
    'escuela = la cerró una persona; horario = la cerró el generador (y solo esas reabre). NULL = antes de 20261030123543.';

-- ── 6. Consentimiento del interesado del bot ─────────────────────────────────
-- Misma lista viva (2026-10-30) + 'bot_prospecto'. wa_register_optin no valida la
-- fuente por su cuenta: el CHECK es el único lugar.
ALTER TABLE public.whatsapp_optins DROP CONSTRAINT chk_wa_optin_source;
ALTER TABLE public.whatsapp_optins ADD CONSTRAINT chk_wa_optin_source CHECK (
    source = ANY (ARRAY['user_confirmed', 'form_inscripcion', 'invitacion', 'import',
                        'admin_manual', 'baja_directa', 'bot_prospecto'])
);

-- ── 7. Semana del profe: team_schedule_exceptions ────────────────────────────
CREATE TABLE public.team_schedule_exceptions (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id     uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    team_id       uuid        NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    fecha         date        NOT NULL,
    tipo          text        NOT NULL CHECK (tipo IN ('cancelada', 'movida', 'extra')),
    hora_original time,       -- sesión del horario base (NULL en 'cancelada' = todo el día)
    hora_inicio   time,
    hora_fin      time,
    lugar         text        CHECK (lugar IS NULL OR length(lugar) BETWEEN 1 AND 120),
    creado_por    uuid        DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tse_movida_chk    CHECK (tipo <> 'movida' OR (hora_original IS NOT NULL AND hora_inicio IS NOT NULL)),
    CONSTRAINT tse_extra_chk     CHECK (tipo <> 'extra' OR (hora_inicio IS NOT NULL AND hora_original IS NULL)),
    CONSTRAINT tse_cancelada_chk CHECK (tipo <> 'cancelada' OR (hora_inicio IS NULL AND hora_fin IS NULL AND lugar IS NULL)),
    CONSTRAINT tse_horas_chk     CHECK (hora_fin IS NULL OR hora_inicio IS NULL OR hora_fin > hora_inicio)
);

COMMENT ON TABLE public.team_schedule_exceptions IS
    'Semana del profe: excepciones al horario base (teams.schedule) por fecha. Lee cualquier miembro de la escuela; '
    'escriben la administración y el profe de ESE equipo. La leen el generador de franjas, el bot y «Mi semana». (20261030123543)';

CREATE UNIQUE INDEX uq_tse_sesion
    ON public.team_schedule_exceptions (team_id, fecha, tipo, COALESCE(hora_original, hora_inicio, '00:00'::time));
CREATE INDEX idx_tse_escuela_fecha
    ON public.team_schedule_exceptions (school_id, fecha);

ALTER TABLE public.team_schedule_exceptions ENABLE ROW LEVEL SECURITY;

-- Helper de POLICY: SECURITY DEFINER (lee teams sin depender de su RLS y sin
-- recursión: la policy de team_schedule_exceptions nunca lee esa misma tabla) y
-- con GRANT a authenticated, porque la policy lo evalúa con el rol de quien
-- consulta. Escribe: la administración de ESA escuela o el profe de ESE equipo
-- (team_coaches o teams.coach_id, vía school_staff). Padres y deportistas no.
CREATE FUNCTION public.puede_editar_semana_equipo(p_team_id uuid, p_school_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT p_team_id IS NOT NULL
       AND p_school_id IS NOT NULL
       AND auth.uid() IS NOT NULL
       AND EXISTS (
            SELECT 1
              FROM public.teams t
             WHERE t.id = p_team_id
               AND t.school_id = p_school_id
               AND (   t.school_id = ANY (public.user_admin_school_ids())
                    OR (    t.school_id = ANY (public.user_staff_school_ids())
                        AND t.id = ANY (public.user_coached_team_ids())))
       );
$$;

REVOKE ALL ON FUNCTION public.puede_editar_semana_equipo(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.puede_editar_semana_equipo(uuid, uuid) TO authenticated;

-- Sin FOR ALL: una policy por comando, y toda escritura con WITH CHECK.
CREATE POLICY tse_select_miembros ON public.team_schedule_exceptions
    FOR SELECT TO authenticated
    USING (school_id = ANY ((SELECT public.user_school_ids())::uuid[]));

CREATE POLICY tse_insert_staff_equipo ON public.team_schedule_exceptions
    FOR INSERT TO authenticated
    WITH CHECK (creado_por = auth.uid() AND public.puede_editar_semana_equipo(team_id, school_id));

CREATE POLICY tse_update_staff_equipo ON public.team_schedule_exceptions
    FOR UPDATE TO authenticated
    USING (public.puede_editar_semana_equipo(team_id, school_id))
    WITH CHECK (public.puede_editar_semana_equipo(team_id, school_id));

CREATE POLICY tse_delete_staff_equipo ON public.team_schedule_exceptions
    FOR DELETE TO authenticated
    USING (public.puede_editar_semana_equipo(team_id, school_id));

-- Los default privileges le dan a authenticated todo en las tablas nuevas: se
-- limpia y se otorga solo lo que la pantalla usa. anon: nada.
REVOKE ALL ON public.team_schedule_exceptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_schedule_exceptions TO authenticated;
GRANT ALL ON public.team_schedule_exceptions TO service_role;

-- ── 8. RPC de la pantalla (authenticated; alcance validado ADENTRO) ──────────

-- 8a. «Repetir ajustes de la semana pasada»: varias filas → RPC transaccional.
CREATE FUNCTION public.repetir_semana_equipo(p_team_id uuid, p_lunes date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_school uuid;
    v_n      int;
BEGIN
    IF p_lunes IS NULL OR extract(isodow FROM p_lunes) <> 1 THEN
        RAISE EXCEPTION 'LUNES_INVALIDO' USING ERRCODE = '22023',
            HINT = 'p_lunes tiene que ser el lunes de la semana destino.';
    END IF;

    SELECT t.school_id INTO v_school FROM public.teams t WHERE t.id = p_team_id;
    IF v_school IS NULL OR NOT public.puede_editar_semana_equipo(p_team_id, v_school) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.team_schedule_exceptions (
        school_id, team_id, fecha, tipo, hora_original, hora_inicio, hora_fin, lugar, creado_por
    )
    SELECT e.school_id, e.team_id, e.fecha + 7, e.tipo, e.hora_original, e.hora_inicio, e.hora_fin, e.lugar, auth.uid()
      FROM public.team_schedule_exceptions e
     WHERE e.team_id = p_team_id
       AND e.school_id = v_school
       AND e.fecha BETWEEN p_lunes - 7 AND p_lunes - 1
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    RETURN jsonb_build_object('ok', true, 'copiadas', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.repetir_semana_equipo(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repetir_semana_equipo(uuid, date) TO authenticated;

-- 8b. Clases de prueba de la semana: la administración ve todas; el profe solo las
--     de sus equipos. SIN teléfono ni correo. Tope de 300.
CREATE FUNCTION public.clases_prueba_semana(p_school_id uuid, p_desde date, p_hasta date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_admin   boolean;
    v_equipos uuid[];
    v_rows    jsonb;
BEGIN
    IF p_school_id IS NULL OR p_desde IS NULL OR p_hasta IS NULL
       OR p_hasta < p_desde OR p_hasta - p_desde > 31 THEN
        RAISE EXCEPTION 'RANGO_INVALIDO' USING ERRCODE = '22023',
            HINT = 'Rango de fechas de máximo 31 días.';
    END IF;

    v_admin := public.is_super_admin() OR p_school_id = ANY (public.user_admin_school_ids());
    IF NOT v_admin THEN
        IF NOT (p_school_id = ANY (public.user_staff_school_ids())) THEN
            RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
        END IF;
        v_equipos := public.user_coached_team_ids();
    END IF;

    SELECT COALESCE(jsonb_agg(x.j ORDER BY x.fecha, x.hora, x.nombre), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT s.slot_date AS fecha, s.start_time AS hora, l.full_name AS nombre,
               jsonb_build_object(
                   'lead_id',        l.id,
                   'nombre',         l.full_name,
                   'anio',           extract(year FROM l.birth_date)::int,
                   'sexo',           l.gender,
                   'respuestas',     l.respuestas,
                   'estado_cupo',    CASE WHEN l.trial_slot_id = s.id THEN 'agendada' ELSE 'separado' END,
                   'separado_hasta', CASE WHEN l.trial_slot_id = s.id THEN NULL ELSE l.cupo_separado_hasta END,
                   'franja',         jsonb_build_object(
                                         'id', s.id, 'fecha', s.slot_date, 'hora_inicio', s.start_time,
                                         'hora_fin', s.end_time, 'etiqueta', s.label, 'lugar', s.location),
                   'equipo',         CASE WHEN t.id IS NULL THEN NULL
                                          ELSE jsonb_build_object('id', t.id, 'nombre', t.name) END,
                   'equipo_recomendado', CASE WHEN tr.id IS NULL THEN NULL
                                              ELSE jsonb_build_object('id', tr.id, 'nombre', tr.name) END,
                   'pago',           pg.pago,
                   'asistencia',     l.source_detail->>'asistencia',
                   'etapa',          l.source_detail->>'etapa'
               ) AS j
          FROM public.school_signup_leads l
          JOIN public.school_trial_slots s
            ON s.id = COALESCE(l.trial_slot_id, l.cupo_separado_slot_id)
           AND s.school_id = l.school_id
          LEFT JOIN public.teams t  ON t.id = s.team_id
          LEFT JOIN public.teams tr ON tr.id = l.team_id AND tr.school_id = l.school_id
          LEFT JOIN LATERAL (
              SELECT CASE WHEN v_admin
                          THEN jsonb_build_object('id', p.id, 'estado', p.status, 'monto', p.amount)
                          ELSE jsonb_build_object('estado', p.status) END AS pago
                FROM public.payments p
               WHERE p.signup_lead_id = l.id
                 AND p.payment_category = 'clase_prueba'
                 AND p.status NOT IN ('cancelled', 'failed', 'rejected')
               ORDER BY p.created_at DESC
               LIMIT 1
          ) pg ON true
         WHERE l.school_id = p_school_id
           AND l.status <> 'discarded'
           AND s.slot_date BETWEEN p_desde AND p_hasta
           AND (v_admin OR s.team_id = ANY (v_equipos))
         ORDER BY s.slot_date, s.start_time
         LIMIT 300
      ) x;

    RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.clases_prueba_semana(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clases_prueba_semana(uuid, date, date) TO authenticated;

-- 8c. «Asistió / No vino» y grupo recomendado, desde el app del profe.
--     p_asistencia NULL: con p_team_recomendado NULL desmarca la asistencia; con
--     equipo, solo recomienda grupo y deja la asistencia como está.
CREATE FUNCTION public.marcar_clase_prueba_entrenador(
    p_lead_id uuid,
    p_asistencia text,
    p_team_recomendado uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_lead      public.school_signup_leads%ROWTYPE;
    v_slot_team uuid;
    v_sd        jsonb;
    v_ahora     text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
    IF p_asistencia IS NOT NULL AND p_asistencia NOT IN ('asistio', 'no_vino') THEN
        RAISE EXCEPTION 'ASISTENCIA_INVALIDA' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_lead FROM public.school_signup_leads WHERE id = p_lead_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Prospecto no encontrado' USING ERRCODE = '02000';
    END IF;

    SELECT ts.team_id INTO v_slot_team
      FROM public.school_trial_slots ts
     WHERE ts.id = v_lead.trial_slot_id AND ts.school_id = v_lead.school_id;

    IF NOT (   public.is_super_admin()
            OR v_lead.school_id = ANY (public.user_admin_school_ids())
            OR (    v_lead.school_id = ANY (public.user_staff_school_ids())
                AND v_slot_team IS NOT NULL
                AND v_slot_team = ANY (public.user_coached_team_ids()))) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    IF v_lead.trial_slot_id IS NULL THEN
        RAISE EXCEPTION 'SIN_CLASE_AGENDADA' USING ERRCODE = '22023';
    END IF;
    IF v_lead.status = 'discarded' THEN
        RAISE EXCEPTION 'PROSPECTO_DESCARTADO' USING ERRCODE = '22023';
    END IF;
    IF p_team_recomendado IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.teams t WHERE t.id = p_team_recomendado AND t.school_id = v_lead.school_id
    ) THEN
        RAISE EXCEPTION 'EQUIPO_INVALIDO' USING ERRCODE = '22023';
    END IF;

    v_sd := COALESCE(v_lead.source_detail, '{}'::jsonb);

    IF p_asistencia IS NOT NULL THEN
        v_sd := v_sd || jsonb_build_object('asistencia', p_asistencia,
                                           'asistencia_at', v_ahora,
                                           'asistencia_por', auth.uid());
    ELSIF p_team_recomendado IS NULL THEN
        v_sd := v_sd - 'asistencia' - 'asistencia_at' - 'asistencia_por';
    END IF;

    -- Etapa del embudo (whatsapp-prospecto-lead.service.ts): nunca baja.
    IF p_asistencia = 'asistio'
       AND COALESCE(v_sd->>'etapa', '') NOT IN ('asistio', 'inscrito', 'descartado') THEN
        v_sd := v_sd || jsonb_build_object('etapa', 'asistio',
                                           'asistio_at', COALESCE(v_sd->>'asistio_at', v_ahora));
    END IF;

    IF p_team_recomendado IS NOT NULL THEN
        IF NOT (v_sd ? 'team_id_bot') THEN
            v_sd := v_sd || jsonb_build_object('team_id_bot', v_lead.team_id);
        END IF;
        v_sd := v_sd || jsonb_build_object('team_recomendado_por', auth.uid(),
                                           'team_recomendado_at', v_ahora);
    END IF;

    UPDATE public.school_signup_leads
       SET source_detail = v_sd,
           team_id       = COALESCE(p_team_recomendado, team_id),
           status        = CASE WHEN p_asistencia = 'asistio' AND status = 'new' THEN 'contacted' ELSE status END,
           updated_at    = now()
     WHERE id = p_lead_id;

    RETURN jsonb_build_object(
        'ok', true,
        'asistencia', v_sd->>'asistencia',
        'team_id', COALESCE(p_team_recomendado, v_lead.team_id),
        'etapa', v_sd->>'etapa');
END;
$$;

REVOKE ALL ON FUNCTION public.marcar_clase_prueba_entrenador(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_clase_prueba_entrenador(uuid, text, uuid) TO authenticated;

-- 8d. Ajustes de la clase de prueba desde Configurar (la tabla solo tiene policy
--     de SELECT para la administración). Solo cambia las claves que llegan.
CREATE FUNCTION public.guardar_ajustes_clase_prueba(p_school_id uuid, p_ajustes jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_fila public.school_trial_class_settings%ROWTYPE;
BEGIN
    IF NOT (public.is_super_admin() OR public.is_school_admin(p_school_id)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
    IF p_ajustes IS NULL OR jsonb_typeof(p_ajustes) <> 'object' THEN
        RAISE EXCEPTION 'AJUSTES_INVALIDOS' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_object_keys(p_ajustes) k
         WHERE k NOT IN ('nombre_clase', 'separar_horas', 'cupos_por_sesion',
                         'agendar_al_recibir', 'avisar_entrenador', 'dias_semana')
    ) THEN
        RAISE EXCEPTION 'AJUSTE_DESCONOCIDO' USING ERRCODE = '22023';
    END IF;
    IF p_ajustes ? 'dias_semana' AND jsonb_typeof(p_ajustes->'dias_semana') NOT IN ('array', 'null') THEN
        RAISE EXCEPTION 'AJUSTES_INVALIDOS' USING ERRCODE = '22023', HINT = 'dias_semana es una lista de 0 a 6.';
    END IF;

    -- Sin fila = todo con los DEFAULT (mismo patrón que guardar_valor_clase_prueba).
    INSERT INTO public.school_trial_class_settings (school_id)
    VALUES (p_school_id)
    ON CONFLICT (school_id) DO NOTHING;

    UPDATE public.school_trial_class_settings s
       SET nombre_clase       = CASE WHEN p_ajustes ? 'nombre_clase'
                                     THEN NULLIF(btrim(p_ajustes->>'nombre_clase'), '') ELSE s.nombre_clase END,
           separar_horas      = CASE WHEN p_ajustes ? 'separar_horas'
                                     THEN (p_ajustes->>'separar_horas')::smallint ELSE s.separar_horas END,
           cupos_por_sesion   = CASE WHEN p_ajustes ? 'cupos_por_sesion'
                                     THEN (p_ajustes->>'cupos_por_sesion')::smallint ELSE s.cupos_por_sesion END,
           agendar_al_recibir = CASE WHEN p_ajustes ? 'agendar_al_recibir'
                                     THEN COALESCE((p_ajustes->>'agendar_al_recibir')::boolean, true)
                                     ELSE s.agendar_al_recibir END,
           avisar_entrenador  = CASE WHEN p_ajustes ? 'avisar_entrenador'
                                     THEN COALESCE((p_ajustes->>'avisar_entrenador')::boolean, false)
                                     ELSE s.avisar_entrenador END,
           dias_semana        = CASE WHEN p_ajustes ? 'dias_semana'
                                     THEN CASE WHEN jsonb_typeof(p_ajustes->'dias_semana') = 'array'
                                               THEN ARRAY(SELECT DISTINCT d::smallint
                                                            FROM jsonb_array_elements_text(p_ajustes->'dias_semana') d
                                                           ORDER BY 1)
                                          END
                                     ELSE s.dias_semana END,
           updated_at         = now()
     WHERE s.school_id = p_school_id
    RETURNING s.* INTO v_fila;

    RETURN jsonb_build_object(
        'ok', true,
        'nombre_clase', v_fila.nombre_clase,
        'separar_horas', v_fila.separar_horas,
        'cupos_por_sesion', v_fila.cupos_por_sesion,
        'agendar_al_recibir', v_fila.agendar_al_recibir,
        'avisar_entrenador', v_fila.avisar_entrenador,
        'dias_semana', to_jsonb(v_fila.dias_semana),
        'trial_price', v_fila.trial_price);
END;
$$;

REVOKE ALL ON FUNCTION public.guardar_ajustes_clase_prueba(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.guardar_ajustes_clase_prueba(uuid, jsonb) TO authenticated;

-- ── 9. RPC solo para el BFF (service_role) ───────────────────────────────────
-- Sin caller autenticado que validar: el alcance es «el lead, la franja y el pago
-- son de la MISMA escuela». Candados: primero el lead, después las franjas
-- ordenadas por id (el mismo orden que wa_cancelar_clase_de_prueba).

-- 9a. Tomar un cupo: AGENDA si ya pagó, si la clase es gratis o si la escuela no
--     separa (separar_horas NULL); si no, SEPARA por separar_horas. El contador
--     reserved_count se mueve en la misma transacción.
CREATE FUNCTION public.tomar_cupo_clase_prueba(p_lead_id uuid, p_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_lead   public.school_signup_leads%ROWTYPE;
    v_slot   public.school_trial_slots%ROWTYPE;
    v_ahora  timestamp := now() AT TIME ZONE 'America/Bogota';
    v_precio numeric;
    v_horas  smallint;
    v_agenda boolean;
    v_hasta  timestamptz;
BEGIN
    IF p_lead_id IS NULL OR p_slot_id IS NULL THEN
        RETURN jsonb_build_object('estado', 'no_valido', 'codigo', 'parametros');
    END IF;

    SELECT * INTO v_lead FROM public.school_signup_leads WHERE id = p_lead_id FOR UPDATE;
    IF NOT FOUND OR v_lead.status IN ('discarded', 'converted') THEN
        RETURN jsonb_build_object('estado', 'no_valido', 'codigo', 'lead');
    END IF;

    PERFORM 1
       FROM public.school_trial_slots
      WHERE id = ANY (ARRAY[p_slot_id, v_lead.trial_slot_id, v_lead.cupo_separado_slot_id])
      ORDER BY id
        FOR UPDATE;

    SELECT * INTO v_slot FROM public.school_trial_slots WHERE id = p_slot_id;
    IF NOT FOUND OR v_slot.school_id <> v_lead.school_id THEN
        RETURN jsonb_build_object('estado', 'no_valido', 'codigo', 'franja');
    END IF;

    IF v_lead.trial_slot_id = p_slot_id THEN
        RETURN jsonb_build_object('estado', 'agendada', 'slot_id', p_slot_id, 'ya_estaba', true);
    END IF;

    SELECT s.trial_price, s.separar_horas INTO v_precio, v_horas
      FROM public.school_trial_class_settings s WHERE s.school_id = v_lead.school_id;

    v_agenda := COALESCE(v_precio, 0) <= 0
             OR v_horas IS NULL
             OR EXISTS (SELECT 1 FROM public.payments p
                         WHERE p.signup_lead_id = p_lead_id
                           AND p.school_id = v_lead.school_id
                           AND p.payment_category = 'clase_prueba'
                           AND p.status IN ('paid', 'awaiting_approval'));

    -- La franja que ya tenía separada: no se vuelve a contar.
    IF v_lead.cupo_separado_slot_id = p_slot_id THEN
        IF v_agenda THEN
            IF v_lead.trial_slot_id IS NOT NULL THEN
                UPDATE public.school_trial_slots SET reserved_count = GREATEST(0, reserved_count - 1)
                 WHERE id = v_lead.trial_slot_id;
            END IF;
            UPDATE public.school_signup_leads
               SET trial_slot_id = p_slot_id, cupo_separado_slot_id = NULL, cupo_separado_hasta = NULL,
                   updated_at = now()
             WHERE id = p_lead_id;
            RETURN jsonb_build_object('estado', 'agendada', 'slot_id', p_slot_id);
        END IF;
        IF v_lead.cupo_separado_hasta > now() THEN
            RETURN jsonb_build_object('estado', 'separada', 'slot_id', p_slot_id,
                                      'hasta', v_lead.cupo_separado_hasta, 'ya_estaba', true);
        END IF;
        -- Vencido pero todavía retenido (el job no lo ha soltado): se renueva.
        v_hasta := now() + make_interval(hours => v_horas::int);
        UPDATE public.school_signup_leads SET cupo_separado_hasta = v_hasta, updated_at = now()
         WHERE id = p_lead_id;
        RETURN jsonb_build_object('estado', 'separada', 'slot_id', p_slot_id, 'hasta', v_hasta);
    END IF;

    -- Franja nueva: abierta, a futuro y con lugar.
    IF NOT v_slot.is_open
       OR v_slot.slot_date < v_ahora::date
       OR (v_slot.slot_date = v_ahora::date AND v_slot.start_time <= v_ahora::time) THEN
        RETURN jsonb_build_object('estado', 'cerrada', 'slot_id', p_slot_id);
    END IF;
    IF v_slot.reserved_count >= v_slot.max_capacity THEN
        RETURN jsonb_build_object('estado', 'lleno', 'slot_id', p_slot_id);
    END IF;

    UPDATE public.school_trial_slots SET reserved_count = reserved_count + 1 WHERE id = p_slot_id;

    -- El separado anterior se suelta siempre (lo reemplaza el nuevo).
    IF v_lead.cupo_separado_slot_id IS NOT NULL THEN
        UPDATE public.school_trial_slots SET reserved_count = GREATEST(0, reserved_count - 1)
         WHERE id = v_lead.cupo_separado_slot_id;
    END IF;

    IF v_agenda THEN
        IF v_lead.trial_slot_id IS NOT NULL THEN
            UPDATE public.school_trial_slots SET reserved_count = GREATEST(0, reserved_count - 1)
             WHERE id = v_lead.trial_slot_id;
        END IF;
        UPDATE public.school_signup_leads
           SET trial_slot_id = p_slot_id, cupo_separado_slot_id = NULL, cupo_separado_hasta = NULL,
               updated_at = now()
         WHERE id = p_lead_id;
        RETURN jsonb_build_object('estado', 'agendada', 'slot_id', p_slot_id,
                                  'anterior_slot_id', v_lead.trial_slot_id);
    END IF;

    v_hasta := now() + make_interval(hours => v_horas::int);
    UPDATE public.school_signup_leads
       SET cupo_separado_slot_id = p_slot_id, cupo_separado_hasta = v_hasta, updated_at = now()
     WHERE id = p_lead_id;
    RETURN jsonb_build_object('estado', 'separada', 'slot_id', p_slot_id, 'hasta', v_hasta);
END;
$$;

REVOKE ALL ON FUNCTION public.tomar_cupo_clase_prueba(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tomar_cupo_clase_prueba(uuid, uuid) TO service_role;

-- 9b. Confirmar con el pago: el cupo separado pasa a agendado. Idempotente.
CREATE FUNCTION public.confirmar_cupo_clase_prueba(p_lead_id uuid, p_payment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_lead  public.school_signup_leads%ROWTYPE;
    v_slot  public.school_trial_slots%ROWTYPE;
    v_ahora timestamp := now() AT TIME ZONE 'America/Bogota';
BEGIN
    SELECT * INTO v_lead FROM public.school_signup_leads WHERE id = p_lead_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('estado', 'no_valido', 'codigo', 'lead');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.payments p
         WHERE p.id = p_payment_id
           AND p.signup_lead_id = p_lead_id
           AND p.school_id = v_lead.school_id
           AND p.payment_category = 'clase_prueba'
           AND p.status IN ('paid', 'awaiting_approval')
    ) THEN
        RETURN jsonb_build_object('estado', 'no_valido', 'codigo', 'pago');
    END IF;

    IF v_lead.cupo_separado_slot_id IS NULL THEN
        IF v_lead.trial_slot_id IS NOT NULL THEN
            RETURN jsonb_build_object('estado', 'ya_agendada', 'slot_id', v_lead.trial_slot_id);
        END IF;
        RETURN jsonb_build_object('estado', 'sin_separar');
    END IF;

    PERFORM 1
       FROM public.school_trial_slots
      WHERE id = ANY (ARRAY[v_lead.trial_slot_id, v_lead.cupo_separado_slot_id])
      ORDER BY id
        FOR UPDATE;

    SELECT * INTO v_slot FROM public.school_trial_slots WHERE id = v_lead.cupo_separado_slot_id;

    -- El lugar sigue contado mientras la columna exista (vigente o vencido sin
    -- soltar). Pero si la franja se cerró o ya pasó, no sirve: se suelta.
    IF NOT v_slot.is_open
       OR v_slot.slot_date < v_ahora::date
       OR (v_slot.slot_date = v_ahora::date AND v_slot.start_time <= v_ahora::time) THEN
        UPDATE public.school_trial_slots SET reserved_count = GREATEST(0, reserved_count - 1)
         WHERE id = v_slot.id;
        UPDATE public.school_signup_leads
           SET cupo_separado_slot_id = NULL, cupo_separado_hasta = NULL, updated_at = now()
         WHERE id = p_lead_id;
        RETURN jsonb_build_object('estado', 'sin_cupo', 'slot_id', v_slot.id);
    END IF;

    IF v_lead.trial_slot_id IS NOT NULL AND v_lead.trial_slot_id <> v_slot.id THEN
        UPDATE public.school_trial_slots SET reserved_count = GREATEST(0, reserved_count - 1)
         WHERE id = v_lead.trial_slot_id;
    END IF;

    UPDATE public.school_signup_leads
       SET trial_slot_id = v_slot.id, cupo_separado_slot_id = NULL, cupo_separado_hasta = NULL,
           updated_at = now()
     WHERE id = p_lead_id;

    RETURN jsonb_build_object('estado', 'agendada', 'slot_id', v_slot.id);
END;
$$;

REVOKE ALL ON FUNCTION public.confirmar_cupo_clase_prueba(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_cupo_clase_prueba(uuid, uuid) TO service_role;

-- 9c. Helper (solo lo llama soltar_cupos_separados, SECURITY DEFINER): con pago
--     confirma, sin pago suelta. Sin EXECUTE para nadie.
CREATE FUNCTION public._soltar_o_confirmar_cupo(p_lead_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_lead   public.school_signup_leads%ROWTYPE;
    v_pago   uuid;
    v_conf   jsonb;
    v_accion text;
BEGIN
    SELECT * INTO v_lead FROM public.school_signup_leads WHERE id = p_lead_id FOR UPDATE;
    IF NOT FOUND OR v_lead.cupo_separado_slot_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT p.id INTO v_pago
      FROM public.payments p
     WHERE p.signup_lead_id = p_lead_id
       AND p.school_id = v_lead.school_id
       AND p.payment_category = 'clase_prueba'
       AND p.status IN ('paid', 'awaiting_approval')
     ORDER BY p.created_at DESC
     LIMIT 1;

    IF v_pago IS NOT NULL THEN
        -- Pago registrado a mano o comprobante «al revisar» (D9): confirma.
        v_conf := public.confirmar_cupo_clase_prueba(p_lead_id, v_pago);
        v_accion := CASE WHEN v_conf->>'estado' IN ('agendada', 'ya_agendada') THEN 'confirmada' ELSE 'liberada' END;
    ELSE
        UPDATE public.school_trial_slots SET reserved_count = GREATEST(0, reserved_count - 1)
         WHERE id = v_lead.cupo_separado_slot_id;
        UPDATE public.school_signup_leads
           SET cupo_separado_slot_id = NULL, cupo_separado_hasta = NULL, updated_at = now()
         WHERE id = p_lead_id;
        v_accion := 'liberada';
    END IF;

    RETURN jsonb_build_object(
        'lead_id', v_lead.id, 'school_id', v_lead.school_id, 'phone', v_lead.phone,
        'slot_id', v_lead.cupo_separado_slot_id, 'accion', v_accion);
END;
$$;

REVOKE ALL ON FUNCTION public._soltar_o_confirmar_cupo(uuid) FROM PUBLIC, anon, authenticated;

-- 9d. Job (cada 15 min en el BFF) o un lead puntual. Con p_lead_id NULL toma los
--     vencidos con SKIP LOCKED (los 3 BFF no se pisan); con p_lead_id suelta ESE
--     cupo aunque no haya vencido (p. ej. la escuela no tiene cuentas de pago).
CREATE FUNCTION public.soltar_cupos_separados(p_lead_id uuid DEFAULT NULL, p_limite int DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_lim int := LEAST(GREATEST(COALESCE(p_limite, 200), 1), 1000);
    v_res jsonb := '[]'::jsonb;
    v_uno jsonb;
    r     record;
BEGIN
    IF p_lead_id IS NOT NULL THEN
        v_uno := public._soltar_o_confirmar_cupo(p_lead_id);
        RETURN CASE WHEN v_uno IS NULL THEN v_res ELSE jsonb_build_array(v_uno) END;
    END IF;

    FOR r IN
        SELECT l.id
          FROM public.school_signup_leads l
         WHERE l.cupo_separado_hasta IS NOT NULL
           AND l.cupo_separado_hasta <= now()
         ORDER BY l.cupo_separado_hasta
         LIMIT v_lim
           FOR UPDATE SKIP LOCKED
    LOOP
        v_uno := public._soltar_o_confirmar_cupo(r.id);
        IF v_uno IS NOT NULL THEN
            v_res := v_res || jsonb_build_array(v_uno);
        END IF;
    END LOOP;

    RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.soltar_cupos_separados(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.soltar_cupos_separados(uuid, int) TO service_role;

-- ── 10. listar_clase_prueba: cuerpo VIVO (pg_get_functiondef, 2026-10-30) ────
-- Solo se AGREGAN claves (sede, grupo, profe, respuestas, estado del cupo,
-- separado, pago). Las de hoy, el filtro, el alcance y el LIMIT no cambian.
CREATE OR REPLACE FUNCTION public.listar_clase_prueba(p_school_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
               ts.start_time AS cupo_hora,
               -- Embudo del bot (20261030123543): claves nuevas, nada de lo anterior cambia.
               l.respuestas,
               CASE WHEN l.trial_slot_id IS NOT NULL THEN 'agendada'
                    WHEN l.cupo_separado_slot_id IS NOT NULL THEN 'separado' END AS estado_cupo,
               l.cupo_separado_hasta AS separado_hasta,
               sep.slot_date  AS separado_fecha,
               sep.start_time AS separado_hora,
               sep.label      AS separado_label,
               sb.id   AS sede_id,
               sb.name AS sede,
               tm.id   AS grupo_id,
               tm.name AS grupo,
               pf.profe,
               pg.pago
          FROM public.school_signup_leads l
          LEFT JOIN public.school_trial_slots ts  ON ts.id = l.trial_slot_id
          LEFT JOIN public.school_trial_slots sep ON sep.id = l.cupo_separado_slot_id
          LEFT JOIN public.teams tm
                 ON tm.id = COALESCE(l.team_id, ts.team_id, sep.team_id) AND tm.school_id = l.school_id
          LEFT JOIN public.school_branches sb
                 ON sb.id = COALESCE(l.branch_id, tm.branch_id) AND sb.school_id = l.school_id
          LEFT JOIN LATERAL (
              SELECT string_agg(DISTINCT ss.full_name, ', ') AS profe
                FROM public.school_staff ss
               WHERE tm.id IS NOT NULL
                 AND (ss.id = tm.coach_id
                      OR ss.id IN (SELECT tc.coach_id FROM public.team_coaches tc WHERE tc.team_id = tm.id))
          ) pf ON true
          LEFT JOIN LATERAL (
              SELECT jsonb_build_object('id', p.id, 'monto', p.amount, 'estado', p.status) AS pago
                FROM public.payments p
               WHERE p.signup_lead_id = l.id
                 AND p.payment_category = 'clase_prueba'
                 AND p.status NOT IN ('cancelled', 'failed', 'rejected')
               ORDER BY p.created_at DESC
               LIMIT 1
          ) pg ON true
         WHERE l.school_id = p_school_id
           AND l.status IN ('new', 'contacted')
         LIMIT 500
      ) t;

    RETURN v_rows;
END;
$function$;

-- ACL igual a la viva (CREATE OR REPLACE la conserva; se reafirma).
REVOKE ALL ON FUNCTION public.listar_clase_prueba(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_clase_prueba(uuid) TO authenticated;

COMMIT;
