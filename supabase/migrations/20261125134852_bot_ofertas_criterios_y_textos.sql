-- =============================================================================
-- 20261125134852_bot_ofertas_criterios_y_textos.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-25   Versión anterior: 20261125105034
-- Objetivo: que el bot ORIENTE a la convocatoria que le aplica a cada persona,
--   con los textos que escribió la escuela (Monster's, 2026-11-25):
--   1. pregunta primero (año de nacimiento, trayectoria, posición, género) —
--      `bot_ofertas_ajustes.preguntas_ofertas`;
--   2. con la respuesta elige la(s) oferta(s) por criterios configurables de
--      cada oferta (rango de año de nacimiento, si exige trayectoria, género) y
--      manda su texto (descripción + fechas que no han pasado + cierre) y la
--      nota común (`nota_ofertas`).
--   Esquema (columnas nuevas, nullable/default: compatible con el BFF anterior)
--   + datos de Monster (textos tal cual los mandó la escuela).
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
-- =============================================================================
-- Sin funciones ni policies nuevas: las de 20261125105009 cubren las columnas.
-- =============================================================================

BEGIN;

-- ─── 1. Criterios por oferta ────────────────────────────────────────────────

ALTER TABLE public.bot_ofertas
    ADD COLUMN anio_nacimiento_desde smallint
        CHECK (anio_nacimiento_desde IS NULL OR anio_nacimiento_desde BETWEEN 1900 AND 2100),
    ADD COLUMN anio_nacimiento_hasta smallint
        CHECK (anio_nacimiento_hasta IS NULL OR anio_nacimiento_hasta BETWEEN 1900 AND 2100),
    -- true = solo para quien cuenta trayectoria (clubes, torneos…). Si la persona
    -- califica para una oferta así, el bot le manda SOLO esas.
    ADD COLUMN requiere_trayectoria boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT bot_ofertas_anios_ok CHECK (
        anio_nacimiento_desde IS NULL OR anio_nacimiento_hasta IS NULL
        OR anio_nacimiento_hasta >= anio_nacimiento_desde);

COMMENT ON COLUMN public.bot_ofertas.anio_nacimiento_desde IS
    'Año de nacimiento mínimo de quien aplica (null = sin mínimo). Lo usa el bot para elegir la oferta.';
COMMENT ON COLUMN public.bot_ofertas.anio_nacimiento_hasta IS
    'Año de nacimiento máximo de quien aplica (null = sin máximo).';
COMMENT ON COLUMN public.bot_ofertas.requiere_trayectoria IS
    'Solo para quien cuenta trayectoria deportiva (clubes, torneos). Si califica, el bot manda solo estas.';
COMMENT ON COLUMN public.bot_ofertas.descripcion IS
    'Texto de la escuela que abre la oferta. Con descripción, el bot manda: descripción + fechas vigentes + cta (cierre).';

-- ─── 2. Preguntas previas y nota común ──────────────────────────────────────

ALTER TABLE public.bot_ofertas_ajustes
    ADD COLUMN preguntas_ofertas text
        CHECK (preguntas_ofertas IS NULL OR char_length(preguntas_ofertas) <= 1500),
    ADD COLUMN nota_ofertas text
        CHECK (nota_ofertas IS NULL OR char_length(nota_ofertas) <= 1500);

COMMENT ON COLUMN public.bot_ofertas_ajustes.preguntas_ofertas IS
    'Lo que el bot pregunta ANTES de mostrar ofertas (año de nacimiento, trayectoria…). Null = muestra las ofertas de una vez.';
COMMENT ON COLUMN public.bot_ofertas_ajustes.nota_ofertas IS
    'Texto común que acompaña a la(s) oferta(s) elegida(s) (p. ej. cómo es la evaluación).';

-- ─── 3. Datos de Monster's (textos tal cual los mandó la escuela) ───────────

DO $$
DECLARE
    v_escuela constant uuid := 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
    v_mayores uuid;
    v_suba    uuid;
    v_norte   uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.schools WHERE id = v_escuela) THEN
        RAISE NOTICE 'Monster no existe en esta base: se omiten los datos';
        RETURN;
    END IF;

    SELECT id INTO v_mayores FROM public.bot_ofertas
     WHERE school_id = v_escuela AND tipo = 'convocatoria' AND titulo LIKE 'Convocatorias equipos mayores%';
    SELECT id INTO v_suba FROM public.bot_ofertas
     WHERE school_id = v_escuela AND tipo = 'convocatoria' AND titulo LIKE 'Convocatorias Sede Suba%';
    SELECT id INTO v_norte FROM public.bot_ofertas
     WHERE school_id = v_escuela AND tipo = 'convocatoria' AND titulo LIKE 'Convocatorias Sede Norte%';

    IF v_mayores IS NULL OR v_suba IS NULL OR v_norte IS NULL THEN
        RAISE EXCEPTION 'Faltan las convocatorias de Monster (20261125105034): mayores %, suba %, norte %', v_mayores, v_suba, v_norte;
    END IF;

    -- Mayores de competencia (Superliga 2027): adultos con trayectoria.
    UPDATE public.bot_ofertas SET
        descripcion = $t$¡Tu experiencia en el voleibol puede llevarte a un nuevo nivel!

Por tu trayectoria y perfil deportivo, te invitamos a participar en las *convocatorias de los equipos mayores de competencia de Monster’s Volley*, orientadas a conformar nuestros equipos para el proyecto Superliga 2027.

Buscamos deportistas comprometidos, con experiencia, mentalidad competitiva y disposición para asumir nuevos retos deportivos.$t$,
        cta = $t$Esta es una oportunidad para demostrar tu nivel, integrarte a un proceso competitivo y proyectarte hacia nuevos desafíos.

¡Queremos conocer tu talento y contar contigo en este nuevo proyecto!$t$,
        anio_nacimiento_desde = NULL,
        anio_nacimiento_hasta = 2008,
        requiere_trayectoria = true
    WHERE id = v_mayores;

    UPDATE public.bot_oferta_sesiones SET lugar = 'Universidad ECCI'
    WHERE oferta_id = v_mayores AND lugar = 'ECCI';

    -- Sede Suba — grupos de proyección, por año de nacimiento (2009–2022).
    UPDATE public.bot_ofertas SET
        descripcion = $t$¡Queremos descubrir tu talento y ayudarte a dar el siguiente paso en el voleibol!

Por tu año de nacimiento, te invitamos a participar en las *convocatorias de los grupos de proyección de nuestra sede Suba*.

Estas jornadas nos permitirán conocer tus habilidades, evaluar tu nivel deportivo e identificar el grupo más adecuado para continuar tu proceso de formación y proyección.$t$,
        cta = $t$Queremos que cada deportista tenga la oportunidad de demostrar sus capacidades y encontrar un espacio donde pueda seguir creciendo.

*¡Tu próximo paso en el voleibol puede comenzar aquí!* Te esperamos en las convocatorias de Monster’s Volley.$t$,
        publico = 'Grupos de proyección, nacidas y nacidos de 2009 a 2022',
        anio_nacimiento_desde = 2009,
        anio_nacimiento_hasta = 2022,
        requiere_trayectoria = false
    WHERE id = v_suba;

    UPDATE public.bot_oferta_sesiones SET publico = CASE publico
            WHEN 'Nacidos 2017, 2018, 2019, 2020, 2021 y 2022' THEN 'Nacidos entre 2017 y 2022'
            WHEN 'Nacidos 2015 y 2016' THEN 'Nacidos en 2015 y 2016'
            WHEN 'Nacidos 2013 y 2014' THEN 'Nacidos en 2013 y 2014'
            WHEN 'Nacidos 2011 y 2012' THEN 'Nacidos en 2011 y 2012'
            WHEN 'Nacidos 2009 y 2010' THEN 'Nacidos en 2009 y 2010'
            ELSE publico END
    WHERE oferta_id = v_suba;

    -- Sede Norte — grupos de formación, todas las categorías.
    UPDATE public.bot_ofertas SET
        descripcion = $t$¡Tenemos una oportunidad para que sigas creciendo en el voleibol!

Por tu edad y perfil, te invitamos a participar en las *convocatorias de los grupos de formación de nuestra sede norte*.

Buscamos identificar tus habilidades, conocer tu nivel de juego y orientarte hacia el grupo que mejor acompañe tu desarrollo deportivo.$t$,
        cta = $t$Queremos brindarte un espacio donde puedas aprender, mejorar tus habilidades y disfrutar del voleibol mientras avanzas en tu proceso deportivo.

¡Anímate a participar y comienza a construir tu camino en Monster’s Volley!$t$,
        publico = 'Grupos de formación, todas las categorías',
        anio_nacimiento_desde = NULL,
        anio_nacimiento_hasta = NULL,
        requiere_trayectoria = false
    WHERE id = v_norte;

    UPDATE public.bot_oferta_sesiones SET lugar = 'Universidad ECCI'
    WHERE oferta_id = v_norte AND lugar = 'ECCI';

    -- Preguntas previas y nota de la evaluación (comunes a las tres).
    INSERT INTO public.bot_ofertas_ajustes (school_id, preguntas_ofertas, nota_ofertas)
    VALUES (v_escuela,
        $t$¡Queremos conocerte y conocer tu experiencia en el voleibol!

Para orientarte hacia la convocatoria que mejor se adapte a tu perfil, cuéntanos:

- *Año de nacimiento:*
- *Trayectoria deportiva:* ¿En qué clubes has entrenado y en qué torneos has participado?
- *Posición de juego:* ¿En qué posición juegas habitualmente?
- *Género:* ¿Masculino o femenino?

Con esta información podremos identificar la convocatoria más adecuada para ti y orientarte sobre el proceso de ingreso a nuestro proyecto deportivo 2027.

¡Queremos conocer tu talento y ayudarte a llevarlo al siguiente nivel!$t$,
        $t$¡Queremos conocer tu potencial y ayudarte a encontrar el grupo ideal para tu desarrollo deportivo!

Durante las convocatorias realizaremos una evaluación objetiva de tus habilidades técnicas, capacidades físicas y fundamentos de juego.

Nuestro propósito es identificar tus fortalezas y oportunidades de mejora para que, al finalizar enero, podamos asignarte al grupo de proyección o competencia que mejor se ajuste a tu nivel y proceso deportivo.

No se trata solamente de seleccionar jugadores, sino de encontrar el espacio donde puedas crecer, mejorar y alcanzar tus objetivos en el voleibol.$t$)
    ON CONFLICT (school_id) DO UPDATE
        SET preguntas_ofertas = EXCLUDED.preguntas_ofertas,
            nota_ofertas      = EXCLUDED.nota_ofertas,
            updated_at        = now();
END $$;

COMMIT;
