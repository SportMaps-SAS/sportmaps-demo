-- =============================================================================
-- 20261125105034_monster_convocatorias_dic_2026.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-25   Versión anterior: 20261125105009
-- Objetivo: DATOS de Monster's Volley Club (escuela eb3ebc77-…) para el fix
--   urgente del 2026-11-25 (pedido de Alejandra por el grupo de soporte):
--   · sin clases de prueba por WhatsApp del 1-dic-2026 al 31-ene-2027
--     (vuelven solas el 1-feb-2027);
--   · tres convocatorias activas con sus sesiones (Norte formación, Superliga,
--     Suba). Cada sesión deja de mostrarse sola cuando pasa su fecha.
--   Solo datos (tablas de 20261125105009). Idempotente: no duplica si ya existe.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
-- =============================================================================

BEGIN;

DO $$
DECLARE
    v_escuela constant uuid := 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
    v_cta     constant text :=
        'Para inscribirte escríbenos el nombre completo del deportista, su fecha de nacimiento '
        || 'y la convocatoria (día y hora) a la que quiere ir. La escuela te confirma el cupo.';
    v_norte   uuid;
    v_mayores uuid;
    v_suba    uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.schools WHERE id = v_escuela) THEN
        RAISE NOTICE 'Monster no existe en esta base (gemelo/otra): se omiten los datos';
        RETURN;
    END IF;

    -- ── Bloqueo: sin clases de prueba en diciembre y enero ──────────────────
    IF NOT EXISTS (
        SELECT 1 FROM public.bot_oferta_bloqueos
        WHERE school_id = v_escuela AND tipo = 'clase_prueba'
          AND desde = DATE '2026-12-01' AND hasta = DATE '2027-01-31'
    ) THEN
        INSERT INTO public.bot_oferta_bloqueos (school_id, tipo, desde, hasta, motivo)
        VALUES (v_escuela, 'clase_prueba', DATE '2026-12-01', DATE '2027-01-31',
                'En diciembre y enero no hay clases de prueba: se ofrecen las convocatorias (pedido de la escuela, 2026-11-25).');
    END IF;

    IF EXISTS (SELECT 1 FROM public.bot_ofertas WHERE school_id = v_escuela AND tipo = 'convocatoria') THEN
        RAISE NOTICE 'Monster ya tiene convocatorias cargadas: no se duplican';
        RETURN;
    END IF;

    -- ── A) Sede Norte — grupos de formación ─────────────────────────────────
    INSERT INTO public.bot_ofertas (school_id, tipo, titulo, sede, publico, estado,
                                    vigente_desde, vigente_hasta, prioridad, requiere_inscripcion, cta)
    VALUES (v_escuela, 'convocatoria', 'Convocatorias Sede Norte — grupos de formación',
            'Sede Norte', 'Grupos de formación', 'activa',
            DATE '2026-11-25', DATE '2026-12-12', 30, true, v_cta)
    RETURNING id INTO v_norte;

    INSERT INTO public.bot_oferta_sesiones (oferta_id, school_id, fecha, hora_inicio, hora_fin, lugar) VALUES
        (v_norte, v_escuela, DATE '2026-12-05', TIME '07:00', TIME '09:00', 'Locos por Pádel'),
        (v_norte, v_escuela, DATE '2026-12-06', TIME '07:00', TIME '09:00', 'Locos por Pádel'),
        (v_norte, v_escuela, DATE '2026-12-12', TIME '08:00', TIME '10:00', 'ECCI');

    -- ── B) Equipos mayores de competencia — Superliga (ECCI) ────────────────
    INSERT INTO public.bot_ofertas (school_id, tipo, titulo, sede, publico, estado,
                                    vigente_desde, vigente_hasta, prioridad, requiere_inscripcion, cta)
    VALUES (v_escuela, 'convocatoria', 'Convocatorias equipos mayores de competencia — Superliga',
            'Sede Norte', 'Equipos mayores de competencia (Superliga), femenino y masculino', 'activa',
            DATE '2026-11-25', DATE '2026-12-11', 20, true, v_cta)
    RETURNING id INTO v_mayores;

    INSERT INTO public.bot_oferta_sesiones (oferta_id, school_id, fecha, hora_inicio, hora_fin, lugar, genero, notas) VALUES
        (v_mayores, v_escuela, DATE '2026-12-01', TIME '19:00', TIME '21:00', 'ECCI', 'femenino',  NULL),
        (v_mayores, v_escuela, DATE '2026-12-01', TIME '19:00', TIME '21:00', 'ECCI', 'masculino', NULL),
        (v_mayores, v_escuela, DATE '2026-12-03', TIME '19:00', TIME '21:00', 'ECCI', 'femenino',  NULL),
        (v_mayores, v_escuela, DATE '2026-12-03', TIME '19:00', TIME '21:00', 'ECCI', 'masculino', NULL),
        (v_mayores, v_escuela, DATE '2026-12-09', TIME '19:00', TIME '21:00', 'ECCI', 'femenino',  NULL),
        (v_mayores, v_escuela, DATE '2026-12-09', TIME '20:00', TIME '22:00', 'ECCI', 'masculino', NULL),
        (v_mayores, v_escuela, DATE '2026-12-11', TIME '19:00', TIME '21:00', 'ECCI', 'femenino',  'Una cancha femenino y otra masculino'),
        (v_mayores, v_escuela, DATE '2026-12-11', TIME '19:00', TIME '21:00', 'ECCI', 'masculino', 'Una cancha femenino y otra masculino');

    -- ── C) Sede Suba — Parque Pinar de Suba (por año de nacimiento) ─────────
    INSERT INTO public.bot_ofertas (school_id, tipo, titulo, sede, publico, genero, estado,
                                    vigente_desde, vigente_hasta, prioridad, requiere_inscripcion, cta)
    VALUES (v_escuela, 'convocatoria', 'Convocatorias Sede Suba (Parque Pinar de Suba)',
            'Sede Suba', 'Nacidas y nacidos de 2009 a 2022, por año de nacimiento', 'mixto', 'activa',
            DATE '2026-11-25', DATE '2026-12-13', 10, true, v_cta)
    RETURNING id INTO v_suba;

    -- Viernes 4 y 11 de diciembre (tarde)
    INSERT INTO public.bot_oferta_sesiones (oferta_id, school_id, fecha, hora_inicio, lugar, genero, publico)
    SELECT v_suba, v_escuela, d.fecha, h.hora, 'Parque Pinar de Suba', 'mixto', h.publico
    FROM (VALUES (DATE '2026-12-04'), (DATE '2026-12-11')) AS d(fecha)
    CROSS JOIN (VALUES
        (TIME '14:00', 'Nacidos 2017, 2018, 2019, 2020, 2021 y 2022'),
        (TIME '14:00', 'Nacidos 2015 y 2016'),
        (TIME '16:00', 'Nacidos 2013 y 2014'),
        (TIME '18:00', 'Nacidos 2011 y 2012'),
        (TIME '20:00', 'Nacidos 2009 y 2010')
    ) AS h(hora, publico);

    -- Sábados 5 y 12, domingos 6 y 13 de diciembre (mañana)
    INSERT INTO public.bot_oferta_sesiones (oferta_id, school_id, fecha, hora_inicio, lugar, genero, publico)
    SELECT v_suba, v_escuela, d.fecha, h.hora, 'Parque Pinar de Suba', 'mixto', h.publico
    FROM (VALUES (DATE '2026-12-05'), (DATE '2026-12-12'), (DATE '2026-12-06'), (DATE '2026-12-13')) AS d(fecha)
    CROSS JOIN (VALUES
        (TIME '07:00', 'Nacidos 2017, 2018, 2019, 2020, 2021 y 2022'),
        (TIME '07:00', 'Nacidos 2015 y 2016'),
        (TIME '09:00', 'Nacidos 2013 y 2014'),
        (TIME '11:00', 'Nacidos 2011 y 2012'),
        (TIME '13:00', 'Nacidos 2009 y 2010')
    ) AS h(hora, publico);
END $$;

COMMIT;
