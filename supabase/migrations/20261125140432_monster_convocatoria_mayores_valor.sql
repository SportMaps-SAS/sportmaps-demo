-- =============================================================================
-- 20261125140432_monster_convocatoria_mayores_valor.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-25   Versión anterior: 20261125134852
-- Objetivo: DATOS de Monster's (2026-11-25, «Valores mayores competencia»): la
--   convocatoria de equipos mayores de competencia (Superliga) cuesta $145.000.
--   requiere_pago + valor (lo usa el verificador de montos del bot) y el texto
--   de «Inversión» de la escuela, tal cual, al final del cierre (cta). El bot no
--   repite la línea genérica «Valor:» cuando el texto de la escuela ya trae el monto.
--   El cierre de la escuela + su texto de inversión pasan los 400 caracteres que
--   permitía `cta` (20261125105009): el límite sube a 2000 (igual que descripcion).
--   Idempotente.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
-- =============================================================================

BEGIN;

ALTER TABLE public.bot_ofertas
    DROP CONSTRAINT IF EXISTS bot_ofertas_cta_check,
    ADD CONSTRAINT bot_ofertas_cta_check CHECK (cta IS NULL OR char_length(cta) <= 2000);

DO $$
DECLARE
    v_escuela constant uuid := 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
    v_mayores uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.schools WHERE id = v_escuela) THEN
        RAISE NOTICE 'Monster no existe en esta base: se omiten los datos';
        RETURN;
    END IF;

    SELECT id INTO v_mayores FROM public.bot_ofertas
     WHERE school_id = v_escuela AND tipo = 'convocatoria' AND titulo LIKE 'Convocatorias equipos mayores%';
    IF v_mayores IS NULL THEN
        RAISE EXCEPTION 'Falta la convocatoria de mayores de Monster (20261125105034)';
    END IF;

    UPDATE public.bot_ofertas SET
        requiere_pago = true,
        valor = 145000,
        cta = $t$Esta es una oportunidad para demostrar tu nivel, integrarte a un proceso competitivo y proyectarte hacia nuevos desafíos.

¡Queremos conocer tu talento y contar contigo en este nuevo proyecto!

*Inversión convocatoria – Grupos de competencia, sede Norte*

El valor de participación es de *$145.000*.

Esta convocatoria está dirigida a deportistas que desean asumir nuevos retos, fortalecer su nivel de juego y proyectarse hacia procesos de mayor exigencia competitiva.

Queremos conocer tu talento, compromiso y disposición para crecer dentro de nuestro proyecto deportivo 2027.

¡Es momento de demostrar de qué estás hecho y dar el siguiente paso en tu carrera deportiva!$t$
    WHERE id = v_mayores;
END $$;

COMMIT;
