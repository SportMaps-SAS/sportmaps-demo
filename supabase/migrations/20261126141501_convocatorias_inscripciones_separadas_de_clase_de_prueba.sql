-- =============================================================================
-- 20261126141501_convocatorias_inscripciones_separadas_de_clase_de_prueba.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-26   Versión anterior: 20261126140304
-- Objetivo: las inscripciones a CONVOCATORIAS que llegan por el bot de WhatsApp
--   (school_signup_leads con source_detail.quiere = 'convocatoria') salen de la
--   pestaña «Clase de prueba» y quedan en una lista propia, clara y con sus datos
--   en columnas (Monster's las lleva hoy en Excel y correo y exige verlas aparte).
--
--   a) listar_clase_prueba: la definición VIVA (leída de pg_proc el 2026-11-26) +
--      UN filtro que excluye las inscripciones a convocatoria. Misma firma, mismo
--      gate. CREATE OR REPLACE conserva el ACL (hoy: postgres, service_role,
--      authenticated); se afirma al final.
--   b) listar_inscripciones_convocatoria(p_school_id): la lista de la escuela,
--      ordenada por convocatoria y orden de llegada. Gate ADENTRO (staff o super admin).
--   c) marcar_inscripcion_convocatoria(p_lead_id, p_estado, p_nota): la escuela
--      mueve el estado (pendiente / confirmada / pagada / descartada) y deja una
--      nota. Gate ADENTRO atado a la escuela DEL LEAD (staff: escritura operativa).
--   d) _inscripcion_convocatoria_json: helper interno (una fila → el contrato JSON).
--      Solo lo llaman las dos RPC SECURITY DEFINER: sin EXECUTE para nadie.
--   e) Backfill NO destructivo: a los leads quiere='convocatoria' sin
--      source_detail.convocatoria se les agrega {titulo: suggested_category}.
--      Solo agrega una clave; no cambia status ni nada más (hoy: 1 fila, Monster's).
--
--   Contrato de cada fila (el frontend se escribe contra él):
--     { id, created_at, status, estado_inscripcion ('pendiente'|'confirmada'|'pagada'|'descartada'),
--       convocatoria, oferta_id, sede, deportista, telefono, contacto, acudiente,
--       anio_nacimiento, genero, trayectoria, detalle, fechas (jsonb array de text),
--       valor, valor_con_descuento, promo_pct, conversation_id, notas, nota_escuela }
--   Los datos estructurados los escribe el BFF en source_detail.convocatoria
--   (whatsapp-prospecto-lead.service `detalleDeConvocatoria`); para leads viejos
--   lo que falte va null y `convocatoria` cae a suggested_category.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role):
--     REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION … TO authenticated;   -- o la pantalla da 42501/403
--     anon solo con flujo público demostrado. SECURITY DEFINER no exime al caller.
--   · Helper que solo llama otra función SECURITY DEFINER: REVOKE ALL … FROM
--     PUBLIC, anon, authenticated y sin GRANT.
--   · RPC que recibe id de escuela/usuario: validar alcance del caller sobre ESE id.
-- =============================================================================

BEGIN;

-- ─── a) Clase de prueba SIN las inscripciones a convocatoria ─────────────────
-- Definición viva (pg_get_functiondef, 2026-11-26) + la línea marcada «20261126141501».
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
           -- 20261126141501: las inscripciones a convocatoria van en su propia lista.
           AND COALESCE(l.source_detail->>'quiere', '') <> 'convocatoria'
         LIMIT 500
      ) t;

    RETURN v_rows;
END;
$function$;

-- ─── d) Helper: una fila de school_signup_leads → el contrato JSON ───────────
CREATE OR REPLACE FUNCTION public._inscripcion_convocatoria_json(l public.school_signup_leads)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public, pg_temp
AS $function$
    WITH d AS (
        SELECT COALESCE(l.source_detail, '{}'::jsonb) AS sd,
               CASE WHEN jsonb_typeof(l.source_detail->'convocatoria') = 'object'
                    THEN l.source_detail->'convocatoria' ELSE '{}'::jsonb END AS c
    )
    SELECT jsonb_build_object(
        'id',                 l.id,
        'created_at',         l.created_at,
        'status',             l.status,
        'estado_inscripcion', CASE WHEN d.c->>'estado' IN ('pendiente', 'confirmada', 'pagada', 'descartada')
                                   THEN d.c->>'estado' ELSE 'pendiente' END,
        'convocatoria',       COALESCE(NULLIF(btrim(d.c->>'titulo'), ''), l.suggested_category),
        'oferta_id',          CASE WHEN d.c->>'oferta_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                   THEN (d.c->>'oferta_id')::uuid END,
        'sede',               COALESCE(NULLIF(btrim(d.c->>'sede'), ''),
                                       (SELECT sb.name FROM public.school_branches sb
                                         WHERE sb.id = l.branch_id AND sb.school_id = l.school_id)),
        'deportista',         l.full_name,
        'telefono',           l.phone,
        'contacto',           d.sd->>'contacto',
        'acudiente',          l.guardian_name,
        'anio_nacimiento',    COALESCE(CASE WHEN d.c->>'anio' ~ '^\d{4}$' THEN (d.c->>'anio')::int END,
                                       EXTRACT(YEAR FROM l.birth_date)::int),
        'genero',             COALESCE(NULLIF(btrim(d.c->>'genero'), ''),
                                       CASE upper(l.gender) WHEN 'F' THEN 'femenino' WHEN 'M' THEN 'masculino' END),
        'trayectoria',        CASE WHEN jsonb_typeof(d.c->'trayectoria') = 'boolean' THEN (d.c->'trayectoria')::boolean END,
        'detalle',            NULLIF(btrim(d.c->>'detalle'), ''),
        'fechas',             CASE WHEN jsonb_typeof(d.c->'fechas') = 'array' THEN d.c->'fechas' ELSE '[]'::jsonb END,
        'valor',              CASE WHEN jsonb_typeof(d.c->'valor') = 'number' THEN (d.c->>'valor')::numeric END,
        'valor_con_descuento', CASE WHEN jsonb_typeof(d.c->'valor_con_descuento') = 'number'
                                    THEN (d.c->>'valor_con_descuento')::numeric END,
        'promo_pct',          CASE WHEN jsonb_typeof(d.c->'promo_pct') = 'number' THEN round((d.c->>'promo_pct')::numeric)::int END,
        'conversation_id',    CASE WHEN d.sd->>'conversation_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                   THEN (d.sd->>'conversation_id')::uuid END,
        'notas',              l.notes,
        'nota_escuela',       NULLIF(d.c->>'nota_escuela', '')
    )
    FROM d;
$function$;

COMMENT ON FUNCTION public._inscripcion_convocatoria_json(public.school_signup_leads) IS
    'Interna (20261126141501): una inscripción a convocatoria en el formato de listar_inscripciones_convocatoria. '
    'Solo la llaman las RPC SECURITY DEFINER; sin EXECUTE para nadie.';

-- ─── b) La lista de inscripciones a convocatoria de la escuela ───────────────
CREATE OR REPLACE FUNCTION public.listar_inscripciones_convocatoria(p_school_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_rows jsonb;
BEGIN
    IF NOT (public.is_super_admin() OR p_school_id = ANY (public.user_staff_school_ids())) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    -- Todas, sin importar status: la pantalla filtra por estado_inscripcion.
    -- Las 1000 más recientes; dentro, por convocatoria y orden de llegada.
    SELECT COALESCE(jsonb_agg(t.fila ORDER BY t.fila->>'convocatoria' NULLS LAST, t.created_at ASC, t.id), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT l.id, l.created_at, public._inscripcion_convocatoria_json(l) AS fila
          FROM public.school_signup_leads l
         WHERE l.school_id = p_school_id
           AND l.source_detail->>'quiere' = 'convocatoria'
         ORDER BY l.created_at DESC
         LIMIT 1000
      ) t;

    RETURN v_rows;
END;
$function$;

COMMENT ON FUNCTION public.listar_inscripciones_convocatoria(uuid) IS
    'Inscripciones a convocatorias (bot de WhatsApp) de una escuela, aparte de la clase de prueba. '
    'Staff de la escuela o super admin. Orden: convocatoria, luego llegada. (20261126141501)';

-- ─── c) La escuela mueve el estado de una inscripción ────────────────────────
CREATE OR REPLACE FUNCTION public.marcar_inscripcion_convocatoria(
    p_lead_id uuid, p_estado text, p_nota text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_lead public.school_signup_leads;
    v_conv jsonb;
BEGIN
    IF p_estado IS NULL OR p_estado NOT IN ('pendiente', 'confirmada', 'pagada', 'descartada') THEN
        RAISE EXCEPTION 'Estado inválido: % (pendiente, confirmada, pagada o descartada)', p_estado
            USING ERRCODE = '22023';
    END IF;
    IF p_nota IS NOT NULL AND char_length(p_nota) > 500 THEN
        RAISE EXCEPTION 'La nota no puede pasar de 500 caracteres' USING ERRCODE = '22001';
    END IF;

    SELECT * INTO v_lead FROM public.school_signup_leads WHERE id = p_lead_id FOR UPDATE;
    -- Mismo error si no existe o no es de una escuela del caller: no se revela qué ids existen.
    IF NOT FOUND OR NOT (public.is_super_admin() OR v_lead.school_id = ANY (public.user_staff_school_ids())) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
    IF COALESCE(v_lead.source_detail->>'quiere', '') <> 'convocatoria' THEN
        RAISE EXCEPTION 'No es una inscripción a convocatoria' USING ERRCODE = '22023';
    END IF;

    v_conv := CASE WHEN jsonb_typeof(v_lead.source_detail->'convocatoria') = 'object'
                   THEN v_lead.source_detail->'convocatoria' ELSE '{}'::jsonb END
              || jsonb_build_object('estado', p_estado, 'estado_at', now(), 'estado_por', (SELECT auth.uid()))
              -- p_nota NULL = no se toca; '' (o solo espacios) = se borra la nota.
              || CASE WHEN p_nota IS NOT NULL
                      THEN jsonb_build_object('nota_escuela', NULLIF(btrim(p_nota), ''))
                      ELSE '{}'::jsonb END;

    UPDATE public.school_signup_leads
       SET source_detail = jsonb_set(COALESCE(source_detail, '{}'::jsonb), '{convocatoria}', v_conv, true)
     WHERE id = p_lead_id
     RETURNING * INTO v_lead;

    RETURN public._inscripcion_convocatoria_json(v_lead);
END;
$function$;

COMMENT ON FUNCTION public.marcar_inscripcion_convocatoria(uuid, text, text) IS
    'La escuela marca una inscripción a convocatoria (pendiente/confirmada/pagada/descartada) y deja una nota '
    '(≤500). Staff de la escuela del lead o super admin. No cambia status. (20261126141501)';

-- ─── Permisos ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._inscripcion_convocatoria_json(public.school_signup_leads) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.listar_inscripciones_convocatoria(uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.marcar_inscripcion_convocatoria(uuid, text, text)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listar_inscripciones_convocatoria(uuid)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.marcar_inscripcion_convocatoria(uuid, text, text) TO authenticated;

-- ─── e) Backfill (solo agrega una clave) ─────────────────────────────────────
UPDATE public.school_signup_leads
   SET source_detail = jsonb_set(source_detail, '{convocatoria}', jsonb_build_object('titulo', suggested_category), true)
 WHERE source_detail->>'quiere' = 'convocatoria'
   AND NOT (source_detail ? 'convocatoria')
   AND suggested_category IS NOT NULL;

-- ─── Afirmaciones ────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT has_function_privilege('authenticated', 'public.listar_clase_prueba(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'listar_clase_prueba perdió el EXECUTE de authenticated';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.listar_inscripciones_convocatoria(uuid)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.marcar_inscripcion_convocatoria(uuid, text, text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Las RPC de convocatorias no quedaron con EXECUTE para authenticated';
    END IF;
    IF has_function_privilege('anon', 'public.listar_inscripciones_convocatoria(uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.marcar_inscripcion_convocatoria(uuid, text, text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public._inscripcion_convocatoria_json(public.school_signup_leads)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public._inscripcion_convocatoria_json(public.school_signup_leads)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anon (o authenticated en el helper) quedó con EXECUTE';
    END IF;
END $$;

COMMIT;
