-- =============================================================================
-- 20261125105009_bot_ofertas_bloqueos_y_sesiones.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-25   Versión anterior: 20261124100705
-- Objetivo: que lo que el bot de WhatsApp OFRECE sea configuración por escuela y
--   no texto fijo en código. Fix urgente de Monster (2026-11-25): en diciembre y
--   enero no hay clases de prueba y el bot debe ofrecer las CONVOCATORIAS.
--   · bot_ofertas         — ofertas que el bot puede ofrecer (convocatoria, …),
--                           con estado borrador/activa/archivada y vigencia.
--   · bot_oferta_sesiones — fechas/horas/lugar/género/público de cada oferta;
--                           una sesión pasada deja de mostrarse sola.
--   · bot_oferta_bloqueos — «el bot NO ofrece <tipo> del <desde> al <hasta>»;
--                           al terminar el rango vuelve solo.
--   · bot_ofertas_ajustes — mensaje de respaldo cuando no hay ninguna oferta.
--   El bot lee todo con service_role desde el BFF (bot-ofertas.service.ts).
--   Auditoría: audit_trigger_func() → audit_logs (quién y cuándo).
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
-- Sin funciones nuevas: no hay GRANT EXECUTE que dar. Los helpers de las
-- policies (user_staff_school_ids, user_admin_school_ids) ya tienen EXECUTE
-- para authenticated porque los usan cientos de policies.
-- =============================================================================

BEGIN;

-- ─── 1. Ofertas ──────────────────────────────────────────────────────────────

CREATE TABLE public.bot_ofertas (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id            uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    tipo                 text        NOT NULL CHECK (tipo IN (
                                         'convocatoria', 'clase_prueba', 'clinica', 'vacacional',
                                         'cambio_de_grupo', 'torneo', 'otro')),
    titulo               text        NOT NULL CHECK (char_length(titulo) BETWEEN 3 AND 140),
    descripcion          text        CHECK (descripcion IS NULL OR char_length(descripcion) <= 2000),
    sede                 text        CHECK (sede IS NULL OR char_length(sede) <= 140),
    -- A quién va dirigida (grupo/categoría): «Equipos mayores de competencia», «Nacidos 2009–2022».
    publico              text        CHECK (publico IS NULL OR char_length(publico) <= 200),
    genero               text        CHECK (genero IS NULL OR genero IN ('femenino', 'masculino', 'mixto')),
    -- borrador = nunca la ve el bot; archivada = histórica.
    estado               text        NOT NULL DEFAULT 'borrador'
                                     CHECK (estado IN ('borrador', 'activa', 'archivada')),
    vigente_desde        date,
    vigente_hasta        date,
    prioridad            smallint    NOT NULL DEFAULT 0,
    cupos                integer     CHECK (cupos IS NULL OR cupos > 0),
    requiere_inscripcion boolean     NOT NULL DEFAULT true,
    requiere_pago        boolean     NOT NULL DEFAULT false,
    valor                numeric(12, 2) CHECK (valor IS NULL OR valor >= 0),
    -- Qué hacer para inscribirse (lo dice el bot tal cual).
    cta                  text        CHECK (cta IS NULL OR char_length(cta) <= 400),
    mensaje_sin_cupos    text        CHECK (mensaje_sin_cupos IS NULL OR char_length(mensaje_sin_cupos) <= 500),
    created_by           uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bot_ofertas_vigencia_ok
        CHECK (vigente_hasta IS NULL OR vigente_desde IS NULL OR vigente_hasta >= vigente_desde),
    CONSTRAINT bot_ofertas_pago_con_valor
        CHECK (NOT requiere_pago OR valor IS NOT NULL),
    -- Para la FK compuesta de las sesiones (la sesión no puede ser de otra escuela).
    CONSTRAINT bot_ofertas_id_escuela_uq UNIQUE (id, school_id)
);

COMMENT ON TABLE public.bot_ofertas IS
    'Lo que el bot de WhatsApp puede ofrecer, por escuela (convocatorias, …). Solo estado=activa y dentro de la vigencia llega al bot. Lee el BFF con service_role (bot-ofertas.service.ts).';

CREATE INDEX bot_ofertas_escuela_estado_idx ON public.bot_ofertas (school_id, estado);

-- ─── 2. Sesiones de cada oferta ─────────────────────────────────────────────

CREATE TABLE public.bot_oferta_sesiones (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    oferta_id   uuid        NOT NULL,
    school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    fecha       date        NOT NULL,
    hora_inicio time        NOT NULL,
    hora_fin    time,
    lugar       text        CHECK (lugar IS NULL OR char_length(lugar) <= 160),
    genero      text        CHECK (genero IS NULL OR genero IN ('femenino', 'masculino', 'mixto')),
    publico     text        CHECK (publico IS NULL OR char_length(publico) <= 200),
    notas       text        CHECK (notas IS NULL OR char_length(notas) <= 300),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bot_oferta_sesiones_horas_ok CHECK (hora_fin IS NULL OR hora_fin > hora_inicio),
    CONSTRAINT bot_oferta_sesiones_oferta_fk
        FOREIGN KEY (oferta_id, school_id) REFERENCES public.bot_ofertas (id, school_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.bot_oferta_sesiones IS
    'Fechas de una oferta del bot. La sesión con fecha anterior a hoy (America/Bogota) deja de mostrarse sola.';

CREATE INDEX bot_oferta_sesiones_oferta_idx ON public.bot_oferta_sesiones (oferta_id, fecha, hora_inicio);
CREATE INDEX bot_oferta_sesiones_escuela_fecha_idx ON public.bot_oferta_sesiones (school_id, fecha);

-- ─── 3. Bloqueos por tipo y rango de fechas ─────────────────────────────────

CREATE TABLE public.bot_oferta_bloqueos (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    tipo        text        NOT NULL CHECK (tipo IN (
                                'convocatoria', 'clase_prueba', 'clinica', 'vacacional',
                                'cambio_de_grupo', 'torneo', 'otro')),
    desde       date        NOT NULL,
    hasta       date        NOT NULL,
    motivo      text        CHECK (motivo IS NULL OR char_length(motivo) <= 300),
    created_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bot_oferta_bloqueos_rango_ok CHECK (hasta >= desde)
);

COMMENT ON TABLE public.bot_oferta_bloqueos IS
    'El bot NO ofrece <tipo> entre desde y hasta (fechas America/Bogota, ambas incluidas). Para clase_prueba se suma al interruptor school_trial_class_settings.whatsapp_enabled.';

CREATE INDEX bot_oferta_bloqueos_escuela_idx ON public.bot_oferta_bloqueos (school_id, tipo, hasta);

-- ─── 4. Ajustes (mensaje de respaldo) ───────────────────────────────────────

CREATE TABLE public.bot_ofertas_ajustes (
    school_id           uuid        PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
    -- Lo que dice el bot cuando no hay ninguna oferta vigente (null = texto neutro del BFF).
    mensaje_sin_ofertas text        CHECK (mensaje_sin_ofertas IS NULL OR char_length(mensaje_sin_ofertas) <= 600),
    updated_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bot_ofertas_ajustes IS
    'Ajustes de las ofertas del bot por escuela: mensaje de respaldo sin ofertas vigentes.';

-- ─── 5. updated_at y auditoría ──────────────────────────────────────────────

CREATE TRIGGER bot_ofertas_set_updated_at
    BEFORE UPDATE ON public.bot_ofertas
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER bot_ofertas_ajustes_set_updated_at
    BEFORE UPDATE ON public.bot_ofertas_ajustes
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER bot_ofertas_audit
    AFTER INSERT OR UPDATE OR DELETE ON public.bot_ofertas
    FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_func();
CREATE TRIGGER bot_oferta_sesiones_audit
    AFTER INSERT OR UPDATE OR DELETE ON public.bot_oferta_sesiones
    FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_func();
CREATE TRIGGER bot_oferta_bloqueos_audit
    AFTER INSERT OR UPDATE OR DELETE ON public.bot_oferta_bloqueos
    FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_func();

-- ─── 6. RLS ─────────────────────────────────────────────────────────────────
-- Lectura: quien TRABAJA en la escuela (user_staff_school_ids: sin padres ni atletas).
-- Escritura: quien la ADMINISTRA (user_admin_school_ids: sin coaches). Una policy
-- por comando, con WITH CHECK en INSERT/UPDATE (invariante I3). El bot no pasa por
-- aquí: lee con service_role.

ALTER TABLE public.bot_ofertas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_oferta_sesiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_oferta_bloqueos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_ofertas_ajustes ENABLE ROW LEVEL SECURITY;

-- bot_ofertas
CREATE POLICY bot_ofertas_select_staff ON public.bot_ofertas
    FOR SELECT TO authenticated
    USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));
CREATE POLICY bot_ofertas_insert_admin ON public.bot_ofertas
    FOR INSERT TO authenticated
    WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));
CREATE POLICY bot_ofertas_update_admin ON public.bot_ofertas
    FOR UPDATE TO authenticated
    USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))
    WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));
CREATE POLICY bot_ofertas_delete_admin ON public.bot_ofertas
    FOR DELETE TO authenticated
    USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

-- bot_oferta_sesiones
CREATE POLICY bot_oferta_sesiones_select_staff ON public.bot_oferta_sesiones
    FOR SELECT TO authenticated
    USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));
CREATE POLICY bot_oferta_sesiones_insert_admin ON public.bot_oferta_sesiones
    FOR INSERT TO authenticated
    WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));
CREATE POLICY bot_oferta_sesiones_update_admin ON public.bot_oferta_sesiones
    FOR UPDATE TO authenticated
    USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))
    WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));
CREATE POLICY bot_oferta_sesiones_delete_admin ON public.bot_oferta_sesiones
    FOR DELETE TO authenticated
    USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

-- bot_oferta_bloqueos
CREATE POLICY bot_oferta_bloqueos_select_staff ON public.bot_oferta_bloqueos
    FOR SELECT TO authenticated
    USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));
CREATE POLICY bot_oferta_bloqueos_insert_admin ON public.bot_oferta_bloqueos
    FOR INSERT TO authenticated
    WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));
CREATE POLICY bot_oferta_bloqueos_update_admin ON public.bot_oferta_bloqueos
    FOR UPDATE TO authenticated
    USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))
    WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));
CREATE POLICY bot_oferta_bloqueos_delete_admin ON public.bot_oferta_bloqueos
    FOR DELETE TO authenticated
    USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

-- bot_ofertas_ajustes
CREATE POLICY bot_ofertas_ajustes_select_staff ON public.bot_ofertas_ajustes
    FOR SELECT TO authenticated
    USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));
CREATE POLICY bot_ofertas_ajustes_insert_admin ON public.bot_ofertas_ajustes
    FOR INSERT TO authenticated
    WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));
CREATE POLICY bot_ofertas_ajustes_update_admin ON public.bot_ofertas_ajustes
    FOR UPDATE TO authenticated
    USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))
    WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

-- ─── 7. Permisos de tabla ───────────────────────────────────────────────────

REVOKE ALL ON public.bot_ofertas, public.bot_oferta_sesiones,
              public.bot_oferta_bloqueos, public.bot_ofertas_ajustes FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_ofertas, public.bot_oferta_sesiones,
              public.bot_oferta_bloqueos TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.bot_ofertas_ajustes TO authenticated;
GRANT ALL ON public.bot_ofertas, public.bot_oferta_sesiones,
             public.bot_oferta_bloqueos, public.bot_ofertas_ajustes TO service_role;

COMMIT;
