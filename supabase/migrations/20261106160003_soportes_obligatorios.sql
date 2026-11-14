-- =============================================================================
-- 20261106160003_soportes_obligatorios.sql
-- Autor: claude/soportes   Fecha: 2026-11-06   Versión anterior: 20261105225148
-- Spec: docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §6b (F6), D11 y D12.
--
-- Objetivo: «soportes obligatorios», configurable por escuela y SOLO Monster´s Volley Club lo prende
--   (eb3ebc77-4ea4-4992-96c8-3c8ec574578c, ver docs/migraciones-para-aplicar-2026-11-06/
--   soportes-encender-monster.sql, que aplica una persona). ESTA MIGRACIÓN NO PRENDE NADA.
--
-- Qué hace
--   1. school_settings.require_athlete_documents (bool, default false) y
--      school_settings.required_document_types (text[], default '{}', CHECK de tipos válidos).
--   2. Lectura en lote del estado de soportes por deportista:
--        athlete_documents_status(p_school_id)          -> authenticated, alcance ADMINISTRACIÓN validado adentro.
--        soportes_verificar_sujeto(school, tipo, id)    -> authenticated, ídem; ¿tiene todos? ¿qué falta?
--        soportes_estado_interno(school [, tipo, id])   -> SOLO service_role (BFF: job de recordatorios y bot).
--   3. D12, confirmación bloqueada, en el SERVIDOR: confirm_school_join_request_enrollment (paso «confirmar»
--      de la bandeja Por asignar) llama _soportes_exigir(): con el flag prendido y soportes faltantes
--      lanza SQLSTATE 'SP001' con mensaje `SOPORTES_INCOMPLETOS: ...` y DETAIL = JSON de lo que falta.
--      El BFF aplica el mismo chequeo antes de inscribir a un torneo (events.route register-athlete).
--   4. Tabla de control de recordatorios (soportes_recordatorios) + soportes_reclamar_avisos() atómico
--      (tope de frecuencia: cada 4 días, máximo 6 avisos). Solo service_role.
--
-- CON EL FLAG APAGADO EL COMPORTAMIENTO ES IDÉNTICO AL ACTUAL:
--   · confirm_school_join_request_enrollment solo agrega un IF que consulta el flag; apagado, no hace nada más.
--     (Salvo esa lectura de school_settings, el cuerpo es el de 20261026132948 sin cambios.)
--   · athlete_documents_status devuelve 0 filas; soportes_verificar_sujeto devuelve activo=false, completo=true.
--   · NO se bloquea la creación de la ficha ni de la inscripción (create-one, Asignar, Agregar atleta).
--
-- Decisiones de diseño
--   · ¿Vista security_invoker o función SECURITY DEFINER? FUNCIÓN DEFINER con alcance validado adentro:
--     el cálculo cruza athlete_documents, enrollments, children, profiles, unregistered_athletes y
--     storage.objects (lo que la familia sube desde Hijos V2 NO escribe fila en athlete_documents: vive solo en
--     el bucket identity-documents, carpetas children/{hijo}/docs y children/{acudiente}/{hijo}/docs, con el tipo
--     como prefijo del nombre). Con security_invoker cada tabla aplicaría su propia RLS (un admin no lee los
--     objetos de storage de las familias, ni profiles ajenos) y el resultado saldría incompleto sin avisar.
--     Gate: is_super_admin() OR escuela ∈ user_admin_school_ids() (el coach NO ve el estado; 42501).
--   · Una sola lectura en lote por escuela (sin N+1). Storage se consulta por rangos de prefijo sobre el índice
--     (bucket_id, name) ("C" collation), no con un LIKE por fila de la app.
--   · Escuela sin el flag: el cálculo sale en la primera línea sin tocar athlete_documents ni storage (costo ~0).
--   · Estados como text + CHECK; sin CREATE TYPE; search_path fijo en TODA función; GRANT EXECUTE explícito;
--     anon sin EXECUTE; sin policies que se auto-referencien.
--
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una migración NUEVA.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · GRANT EXECUTE explícito por RPC (SECURITY DEFINER no exime al caller).
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
--
-- REVERSA (no destructiva; ninguna escuela tiene el flag prendido al aplicar):
--   re-crear confirm_school_join_request_enrollment tal cual 20261026132948 §6 y luego
--   DROP FUNCTION public.athlete_documents_status(uuid), public.soportes_verificar_sujeto(uuid,text,uuid),
--     public.soportes_estado_interno(uuid,text,uuid), public._soportes_exigir(uuid,text,uuid),
--     public._soportes_tipo_de_archivo(text), public.soportes_reclamar_avisos(uuid,jsonb,integer,integer);
--   DROP TABLE public.soportes_recordatorios;
--   ALTER TABLE public.school_settings DROP CONSTRAINT school_settings_required_document_types_check,
--     DROP COLUMN require_athlete_documents, DROP COLUMN required_document_types;
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ─── 1. Flags en school_settings ─────────────────────────────────────────────
ALTER TABLE public.school_settings
  ADD COLUMN IF NOT EXISTS require_athlete_documents boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS required_document_types   text[]  NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.school_settings'::regclass
       AND conname  = 'school_settings_required_document_types_check'
  ) THEN
    ALTER TABLE public.school_settings
      ADD CONSTRAINT school_settings_required_document_types_check
      CHECK (required_document_types <@ ARRAY[
        'athlete_photo', 'eps_certificate',
        'guardian_id_front', 'guardian_id_back',
        'athlete_id_front', 'athlete_id_back',
        'guardian_signature', 'athlete_signature',
        'good_standing_certificate'
      ]::text[]);
  END IF;
END $$;

COMMENT ON COLUMN public.school_settings.require_athlete_documents IS
  'Soportes obligatorios (spec campanas-descuento… §6b). Prendido, confirmar la inscripción y convocar a torneos exige required_document_types. Default false: nada cambia. Solo Monster lo prende.';
COMMENT ON COLUMN public.school_settings.required_document_types IS
  'Tipos de athlete_documents.document_type exigidos cuando require_athlete_documents = true (sin ''other''). Monster: los 7 del formulario de afiliación.';

-- ─── 2. Helpers internos ─────────────────────────────────────────────────────

-- Tipo de documento según el nombre del archivo en storage (misma convención que
-- frontend/src/lib/documentosDeportista.ts: `{tipo}-{fecha}-{nombre}`; prefijos viejos
-- identity-/id- = documento del deportista (frente), eps- = certificado EPS). NULL si no corresponde.
CREATE OR REPLACE FUNCTION public._soportes_tipo_de_archivo(p_path text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN f LIKE 'athlete_id_front-%'          THEN 'athlete_id_front'
    WHEN f LIKE 'athlete_id_back-%'           THEN 'athlete_id_back'
    WHEN f LIKE 'athlete_photo-%'             THEN 'athlete_photo'
    WHEN f LIKE 'eps_certificate-%'           THEN 'eps_certificate'
    WHEN f LIKE 'good_standing_certificate-%' THEN 'good_standing_certificate'
    WHEN f LIKE 'guardian_id_front-%'         THEN 'guardian_id_front'
    WHEN f LIKE 'guardian_id_back-%'          THEN 'guardian_id_back'
    WHEN f LIKE 'guardian_signature-%'        THEN 'guardian_signature'
    WHEN f LIKE 'athlete_signature-%'         THEN 'athlete_signature'
    WHEN f LIKE 'identity-%' OR f LIKE 'id-%' THEN 'athlete_id_front'
    WHEN f LIKE 'eps-%'                       THEN 'eps_certificate'
    ELSE NULL
  END
  FROM (SELECT regexp_replace(p_path, '^.*/', '') AS f) x;
$$;
REVOKE ALL ON FUNCTION public._soportes_tipo_de_archivo(text) FROM PUBLIC, anon, authenticated;

-- Núcleo: estado de soportes por deportista de UNA escuela. SIN gate (solo service_role y las funciones de
-- abajo, que validan alcance). Sin parámetro de sujeto: todo el universo de la escuela (inscripción activa o
-- pendiente, más fichas sin cuenta activas). Con p_subject_id: solo ese sujeto, tenga o no inscripción.
-- p_subject_type ∈ child | profile | unregistered (mismo vocabulario que _v2_sujeto_en_escuela).
CREATE OR REPLACE FUNCTION public.soportes_estado_interno(
  p_school_id    uuid,
  p_subject_type text DEFAULT NULL,
  p_subject_id   uuid DEFAULT NULL
)
RETURNS TABLE (
  subject_type      text,
  subject_id        uuid,
  full_name         text,
  notify_profile_id uuid,
  has_account       boolean,
  required_total    integer,
  present_total     integer,
  missing           text[],
  complete          boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_on  boolean;
  v_req text[];
BEGIN
  SELECT s.require_athlete_documents, s.required_document_types
    INTO v_on, v_req
    FROM public.school_settings s
   WHERE s.school_id = p_school_id;

  -- Apagado (o sin tipos): sin trabajo y sin filas.
  IF NOT COALESCE(v_on, false) OR COALESCE(cardinality(v_req), 0) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH universo AS (
    SELECT 'child'::text AS st, e.child_id AS sid
      FROM public.enrollments e
     WHERE e.school_id = p_school_id AND e.status IN ('active', 'pending') AND e.child_id IS NOT NULL
    UNION
    SELECT 'profile', e.user_id
      FROM public.enrollments e
     WHERE e.school_id = p_school_id AND e.status IN ('active', 'pending')
       AND e.user_id IS NOT NULL AND e.child_id IS NULL AND e.unregistered_athlete_id IS NULL
    UNION
    SELECT 'unregistered', e.unregistered_athlete_id
      FROM public.enrollments e
     WHERE e.school_id = p_school_id AND e.status IN ('active', 'pending') AND e.unregistered_athlete_id IS NOT NULL
    UNION
    SELECT 'unregistered', ua.id
      FROM public.unregistered_athletes ua
     WHERE ua.school_id = p_school_id AND ua.is_active AND ua.linked_profile_id IS NULL
  ),
  u AS (
    SELECT p_subject_type AS st, p_subject_id AS sid
     WHERE p_subject_id IS NOT NULL AND p_subject_type IN ('child', 'profile', 'unregistered')
    UNION ALL
    SELECT un.st, un.sid FROM universo un
     WHERE p_subject_id IS NULL AND (p_subject_type IS NULL OR un.st = p_subject_type)
  ),
  presentes AS (
    -- (a) filas de athlete_documents (la escuela y el bot escriben aquí; también lo migrado a la cuenta)
    SELECT u.st, u.sid, d.document_type AS tipo
      FROM u JOIN public.athlete_documents d
        ON u.st = 'child' AND d.child_id = u.sid AND d.school_id = p_school_id
    UNION
    SELECT u.st, u.sid, d.document_type
      FROM u JOIN public.athlete_documents d
        ON u.st = 'profile' AND d.user_id = u.sid AND d.school_id = p_school_id
    UNION
    SELECT u.st, u.sid, d.document_type
      FROM u JOIN public.athlete_documents d
        ON u.st = 'unregistered' AND d.unregistered_athlete_id = u.sid AND d.school_id = p_school_id
    UNION
    -- (b) lo que la familia sube directo al bucket (sin fila): children/{hijo}/docs/ y children/{acudiente}/{hijo}/docs/
    SELECT u.st, u.sid, public._soportes_tipo_de_archivo(o.name)
      FROM u
      JOIN storage.objects o
        ON u.st = 'child' AND o.bucket_id = 'identity-documents'
       AND o.name >= 'children/' || u.sid::text || '/docs/'
       AND o.name <  'children/' || u.sid::text || '/docs0'
    UNION
    SELECT u.st, u.sid, public._soportes_tipo_de_archivo(o.name)
      FROM u
      JOIN public.children c ON u.st = 'child' AND c.id = u.sid AND c.parent_id IS NOT NULL
      JOIN storage.objects o
        ON o.bucket_id = 'identity-documents'
       AND o.name >= 'children/' || c.parent_id::text || '/' || c.id::text || '/docs/'
       AND o.name <  'children/' || c.parent_id::text || '/' || c.id::text || '/docs0'
    UNION
    -- adulto con cuenta propia: children/{uid}/docs/
    SELECT u.st, u.sid, public._soportes_tipo_de_archivo(o.name)
      FROM u
      JOIN storage.objects o
        ON u.st = 'profile' AND o.bucket_id = 'identity-documents'
       AND o.name >= 'children/' || u.sid::text || '/docs/'
       AND o.name <  'children/' || u.sid::text || '/docs0'
  ),
  agg AS (
    SELECT p.st, p.sid, array_agg(DISTINCT p.tipo) AS tiene
      FROM presentes p
     WHERE p.tipo = ANY (v_req)
     GROUP BY p.st, p.sid
  )
  SELECT u.st,
         u.sid,
         COALESCE(c.full_name, pr.full_name, ua.full_name, 'Sin nombre'),
         COALESCE(c.parent_id, pr.id, ua.linked_profile_id),
         COALESCE(c.parent_id, pr.id, ua.linked_profile_id) IS NOT NULL,
         cardinality(v_req),
         COALESCE(cardinality(a.tiene), 0),
         ARRAY(SELECT t.tipo FROM unnest(v_req) WITH ORDINALITY AS t(tipo, ord)
                WHERE t.tipo <> ALL (COALESCE(a.tiene, '{}'::text[])) ORDER BY t.ord),
         COALESCE(cardinality(a.tiene), 0) >= cardinality(v_req)
    FROM u
    LEFT JOIN agg a                    ON a.st = u.st AND a.sid = u.sid
    LEFT JOIN public.children c        ON u.st = 'child'        AND c.id  = u.sid
    LEFT JOIN public.profiles pr       ON u.st = 'profile'      AND pr.id = u.sid
    LEFT JOIN public.unregistered_athletes ua ON u.st = 'unregistered' AND ua.id = u.sid
   ORDER BY 3;
END;
$$;
REVOKE ALL ON FUNCTION public.soportes_estado_interno(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.soportes_estado_interno(uuid, text, uuid) TO service_role;

-- Exige los soportes de UN deportista. Interna: la llaman funciones definer que ya validaron al caller.
-- Flag apagado => no hace nada. Prendido y con faltantes => SQLSTATE 'SP001'.
CREATE OR REPLACE FUNCTION public._soportes_exigir(p_school_id uuid, p_subject_type text, p_subject_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_missing text[];
BEGIN
  IF p_subject_id IS NULL THEN RETURN; END IF;

  SELECT e.missing INTO v_missing
    FROM public.soportes_estado_interno(p_school_id, p_subject_type, p_subject_id) e
   LIMIT 1;

  -- Sin fila: flag apagado (o sin tipos). Con fila y completo: missing = {}.
  IF v_missing IS NOT NULL AND cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'SOPORTES_INCOMPLETOS: faltan % soporte(s): %', cardinality(v_missing), array_to_string(v_missing, ', ')
      USING ERRCODE = 'SP001',
            DETAIL  = to_jsonb(v_missing)::text,
            HINT    = 'Sube los soportes que faltan en la ficha del deportista y vuelve a confirmar.';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._soportes_exigir(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._soportes_exigir(uuid, text, uuid) TO service_role;

-- ─── 3. Lectura para la app (alcance validado adentro) ──────────────────────

-- Una sola lectura en lote: todos los deportistas de la escuela con cuántos soportes tienen y cuáles faltan.
-- Para el contador «Soportes X/7», el filtro «Faltan soportes» y el informe «Soportes pendientes».
-- Flag apagado => 0 filas. Solo administración de la escuela (el coach no ve esto): 42501.
CREATE OR REPLACE FUNCTION public.athlete_documents_status(p_school_id uuid)
RETURNS TABLE (
  subject_type      text,
  subject_id        uuid,
  full_name         text,
  notify_profile_id uuid,
  has_account       boolean,
  required_total    integer,
  present_total     integer,
  missing           text[],
  complete          boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT (public.is_super_admin() OR p_school_id = ANY (public.user_admin_school_ids())) THEN
    RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT * FROM public.soportes_estado_interno(p_school_id);
END;
$$;
REVOKE ALL ON FUNCTION public.athlete_documents_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.athlete_documents_status(uuid) TO authenticated;

-- Un deportista: {activo, completo, requeridos, faltan[]}. Para la ficha, el chequeo de torneos y la cola de
-- Por asignar. p_subject_type ∈ child | profile | unregistered. El sujeto debe ser de la escuela (22023 si no).
CREATE OR REPLACE FUNCTION public.soportes_verificar_sujeto(p_school_id uuid, p_subject_type text, p_subject_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_on   boolean;
  v_req  text[];
  r      record;
  v_ok   boolean;
BEGIN
  IF auth.uid() IS NULL
     OR NOT (public.is_super_admin() OR p_school_id = ANY (public.user_admin_school_ids())) THEN
    RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
  END IF;
  IF p_subject_type IS NULL OR p_subject_type NOT IN ('child', 'profile', 'unregistered') OR p_subject_id IS NULL THEN
    RAISE EXCEPTION 'Sujeto inválido.' USING ERRCODE = '22023';
  END IF;

  -- El sujeto tiene que ser de ESTA escuela (mismo criterio que _v2_sujeto_en_escuela).
  v_ok := CASE p_subject_type
    WHEN 'child' THEN
         EXISTS (SELECT 1 FROM public.children c WHERE c.id = p_subject_id AND c.school_id = p_school_id)
      OR EXISTS (SELECT 1 FROM public.enrollments e WHERE e.child_id = p_subject_id AND e.school_id = p_school_id)
    WHEN 'profile' THEN
         EXISTS (SELECT 1 FROM public.enrollments e WHERE e.user_id = p_subject_id AND e.school_id = p_school_id)
      OR EXISTS (SELECT 1 FROM public.school_members sm
                  WHERE sm.profile_id = p_subject_id AND sm.school_id = p_school_id AND sm.status = 'active')
    ELSE EXISTS (SELECT 1 FROM public.unregistered_athletes ua WHERE ua.id = p_subject_id AND ua.school_id = p_school_id)
  END;
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'El deportista no pertenece a esta escuela.' USING ERRCODE = '22023';
  END IF;

  SELECT s.require_athlete_documents, s.required_document_types INTO v_on, v_req
    FROM public.school_settings s WHERE s.school_id = p_school_id;
  IF NOT COALESCE(v_on, false) OR COALESCE(cardinality(v_req), 0) = 0 THEN
    RETURN jsonb_build_object('activo', false, 'completo', true, 'requeridos', '[]'::jsonb, 'faltan', '[]'::jsonb);
  END IF;

  SELECT * INTO r FROM public.soportes_estado_interno(p_school_id, p_subject_type, p_subject_id) LIMIT 1;
  RETURN jsonb_build_object(
    'activo',     true,
    'completo',   COALESCE(r.complete, false),
    'requeridos', to_jsonb(v_req),
    'faltan',     to_jsonb(COALESCE(r.missing, v_req))
  );
END;
$$;
REVOKE ALL ON FUNCTION public.soportes_verificar_sujeto(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.soportes_verificar_sujeto(uuid, text, uuid) TO authenticated;

-- ─── 4. Recordatorios con tope (cada 4 días, máximo 6) ──────────────────────
CREATE TABLE IF NOT EXISTS public.soportes_recordatorios (
  school_id    uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  subject_type text        NOT NULL CHECK (subject_type IN ('child', 'profile', 'unregistered')),
  subject_id   uuid        NOT NULL,
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  sent_count   integer     NOT NULL DEFAULT 1 CHECK (sent_count >= 0),
  PRIMARY KEY (school_id, subject_type, subject_id)
);

ALTER TABLE public.soportes_recordatorios ENABLE ROW LEVEL SECURITY;
-- Sin policies: solo service_role (que salta RLS). Nada legible por authenticated ni anon.
REVOKE ALL ON public.soportes_recordatorios FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.soportes_recordatorios TO service_role;

COMMENT ON TABLE public.soportes_recordatorios IS
  'Cuándo se avisó por última vez a la familia de un deportista que debe soportes. Solo service_role (job diario del BFF).';

-- Reclama en UNA sentencia los avisos que toca mandar (idempotente entre réplicas del BFF): el sujeto entra si no
-- tiene registro, o si pasaron p_cada_dias y no llegó a p_maximo. Devuelve solo los reclamados.
-- p_sujetos = [{"subject_type":"child","subject_id":"<uuid>"}, ...]
CREATE OR REPLACE FUNCTION public.soportes_reclamar_avisos(
  p_school_id uuid,
  p_sujetos   jsonb,
  p_cada_dias integer DEFAULT 4,
  p_maximo    integer DEFAULT 6
)
RETURNS TABLE (subject_type text, subject_id uuid, sent_count integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_dias integer := GREATEST(COALESCE(p_cada_dias, 4), 0);
  v_max  integer := GREATEST(COALESCE(p_maximo, 6), 0);
BEGIN
  IF v_max = 0 THEN RETURN; END IF;
  RETURN QUERY
  WITH reclamados AS (
    INSERT INTO public.soportes_recordatorios AS r (school_id, subject_type, subject_id, last_sent_at, sent_count)
    SELECT p_school_id, x.subject_type, x.subject_id, now(), 1
      FROM jsonb_to_recordset(COALESCE(p_sujetos, '[]'::jsonb)) AS x(subject_type text, subject_id uuid)
     WHERE x.subject_type IN ('child', 'profile', 'unregistered') AND x.subject_id IS NOT NULL
    ON CONFLICT (school_id, subject_type, subject_id) DO UPDATE
       SET last_sent_at = now(), sent_count = r.sent_count + 1
     WHERE r.last_sent_at <= now() - make_interval(days => v_dias)
       AND r.sent_count < v_max
    RETURNING r.subject_type AS st, r.subject_id AS sid, r.sent_count AS n
  )
  SELECT k.st, k.sid, k.n FROM reclamados k;
END;
$$;
REVOKE ALL ON FUNCTION public.soportes_reclamar_avisos(uuid, jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.soportes_reclamar_avisos(uuid, jsonb, integer, integer) TO service_role;

-- ─── 5. D12: confirmar la inscripción desde Por asignar exige los soportes ───
-- Cuerpo vivo de 20261026132948 §6 (única definición en el repo); ÚNICO cambio: el PERFORM de
-- _soportes_exigir justo antes de amarrar la inscripción. Flag apagado: no hace nada y todo queda igual.
CREATE OR REPLACE FUNCTION public.confirm_school_join_request_enrollment(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_school_id uuid;
    r           public.school_join_requests;
    v_enr       uuid;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
    END IF;

    SELECT school_id INTO v_school_id FROM public.school_join_requests WHERE id = p_request_id;
    IF v_school_id IS NULL THEN
        RAISE EXCEPTION 'Solicitud no encontrada.' USING ERRCODE = 'P0002';
    END IF;
    IF NOT (public.is_super_admin() OR v_school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO r FROM public.school_join_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND OR r.status NOT IN ('assigned', 'linked') THEN
        RAISE EXCEPTION 'La solicitud no está asignada.' USING ERRCODE = '55000';
    END IF;
    IF r.enrollment_id IS NOT NULL THEN
        RETURN jsonb_build_object('request_id', r.id, 'enrollment_id', r.enrollment_id);
    END IF;

    SELECT e.id INTO v_enr
      FROM public.enrollments e
     WHERE e.school_id = r.school_id
       AND e.status IN ('active', 'pending')
       AND (r.assigned_team_id IS NULL OR e.team_id = r.assigned_team_id)
       AND (   (r.child_id IS NOT NULL AND e.child_id = r.child_id)
            OR (r.for_whom = 'self' AND e.user_id = r.requester_profile_id))
     ORDER BY e.created_at DESC
     LIMIT 1;

    IF v_enr IS NOT NULL THEN
        -- D12 (soportes obligatorios): con el flag de la escuela prendido, no se confirma con soportes faltantes.
        -- Lanza SQLSTATE 'SP001' (SOPORTES_INCOMPLETOS + DETAIL con la lista). Apagado: no hace nada.
        PERFORM public._soportes_exigir(
            r.school_id,
            CASE WHEN r.child_id IS NOT NULL THEN 'child' ELSE 'profile' END,
            COALESCE(r.child_id, r.requester_profile_id)
        );
        UPDATE public.school_join_requests SET enrollment_id = v_enr WHERE id = r.id;
    END IF;

    RETURN jsonb_build_object('request_id', r.id, 'enrollment_id', v_enr);
END;
$$;
-- CREATE OR REPLACE conserva los grants vivos (REVOKE a anon/authenticated + GRANT authenticated de 20261026132948),
-- pero se repiten explícitos por si la base difiere.
REVOKE ALL ON FUNCTION public.confirm_school_join_request_enrollment(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_school_join_request_enrollment(uuid) TO authenticated;

COMMIT;

-- =============================================================================
-- PRUEBAS (ver supabase/migrations/_smoke/soportes_smoke.sql, BEGIN … ROLLBACK; NO se ejecutó contra la base)
--   T1  Flag apagado (estado de origen de TODAS las escuelas): athlete_documents_status(escuela) = 0 filas;
--       soportes_verificar_sujeto = {activo:false, completo:true}; _soportes_exigir no lanza; la confirmación de
--       Por asignar se comporta igual que antes.
--   T2  Flag prendido en una escuela con los 7 tipos, ficha con 6 de 7: missing = [el que falta], complete = false,
--       present_total = 6, required_total = 7.
--   T3  Ficha con los 7: complete = true, missing = {}; _soportes_exigir no lanza.
--   T4  _soportes_exigir con faltantes lanza SQLSTATE 'SP001', mensaje 'SOPORTES_INCOMPLETOS: …', DETAIL = JSON.
--       (Y confirm_school_join_request_enrollment, que lo invoca, propaga el mismo error y NO amarra la inscripción.)
--   T5  Permisos: coach de la escuela y admin de OTRA escuela -> 42501 en athlete_documents_status y
--       soportes_verificar_sujeto; anon no tiene EXECUTE; soportes_estado_interno / reclamar_avisos solo service_role.
--   T6  soportes_reclamar_avisos: 1.ª llamada reclama; la 2.ª inmediata devuelve 0; con last_sent_at de hace 5 días
--       reclama de nuevo y sent_count sube; con sent_count = 6 no reclama nunca más.
-- =============================================================================
