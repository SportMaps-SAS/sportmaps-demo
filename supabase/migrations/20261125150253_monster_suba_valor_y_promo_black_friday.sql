-- =============================================================================
-- 20261125150253_monster_suba_valor_y_promo_black_friday.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-25   Versión anterior: 20261125140432
-- Objetivo:
--   1. Promoción con fechas para las ofertas del bot (bot_ofertas_ajustes.promo_*):
--      el bot la muestra junto a la oferta elegida solo entre promo_desde y
--      promo_hasta (America/Bogota); después desaparece sola.
--   2. DATOS de Monster's (2026-11-25): la convocatoria de Suba (grupos de
--      proyección) cuesta $145.000 con su texto de «Inversión»; Black Friday:
--      10 % a quien se inscriba el viernes 27-nov (se muestra del 25 al 27).
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
-- =============================================================================

BEGIN;

ALTER TABLE public.bot_ofertas_ajustes
    ADD COLUMN promo_texto text CHECK (promo_texto IS NULL OR char_length(promo_texto) <= 1000),
    ADD COLUMN promo_desde date,
    ADD COLUMN promo_hasta date,
    ADD CONSTRAINT bot_ofertas_ajustes_promo_rango_ok
        CHECK (promo_desde IS NULL OR promo_hasta IS NULL OR promo_hasta >= promo_desde);

COMMENT ON COLUMN public.bot_ofertas_ajustes.promo_texto IS
    'Promoción que el bot muestra con la oferta elegida, solo entre promo_desde y promo_hasta (America/Bogota).';

DO $$
DECLARE
    v_escuela constant uuid := 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
    v_suba uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.schools WHERE id = v_escuela) THEN
        RAISE NOTICE 'Monster no existe en esta base: se omiten los datos';
        RETURN;
    END IF;

    SELECT id INTO v_suba FROM public.bot_ofertas
     WHERE school_id = v_escuela AND tipo = 'convocatoria' AND titulo LIKE 'Convocatorias Sede Suba%';
    IF v_suba IS NULL THEN
        RAISE EXCEPTION 'Falta la convocatoria de Suba de Monster (20261125105034)';
    END IF;

    UPDATE public.bot_ofertas SET
        requiere_pago = true,
        valor = 145000,
        cta = $t$Queremos que cada deportista tenga la oportunidad de demostrar sus capacidades y encontrar un espacio donde pueda seguir creciendo.

*¡Tu próximo paso en el voleibol puede comenzar aquí!* Te esperamos en las convocatorias de Monster’s Volley.

*Inversión convocatoria – Sede Suba*

El valor de participación en las convocatorias para los grupos de proyección es de *$145.000*.

Queremos brindarte la oportunidad de demostrar tus capacidades, fortalecer tu proceso deportivo y encontrar el grupo adecuado para continuar creciendo en el voleibol.

¡Esta puede ser la oportunidad que estabas esperando para avanzar en tu camino deportivo!$t$
    WHERE id = v_suba;

    -- Corrección de la escuela (2026-11-25): los VIERNES 4 y 11 en Suba son una hora
    -- antes — 1:00 (2017–2022 y 2015–2016), 3:00, 5:00 y 7:00 p. m. Fines de semana igual.
    UPDATE public.bot_oferta_sesiones SET hora_inicio = hora_inicio - interval '1 hour'
    WHERE oferta_id = v_suba
      AND fecha IN (DATE '2026-12-04', DATE '2026-12-11')
      AND hora_inicio IN (TIME '14:00', TIME '16:00', TIME '18:00', TIME '20:00');

    UPDATE public.bot_ofertas_ajustes SET
        promo_texto = $t$¡Este *viernes 27 de noviembre* tenemos una oportunidad especial para ti!

Por nuestro *BLACK FRIDAY*, todos los deportistas que realicen su inscripción a las convocatorias durante este día recibirán un *10% de descuento* en el valor de inscripción.

Es el momento ideal para asegurar tu participación, aprovechar este beneficio y comenzar a construir tu proceso deportivo con Monster’s Volley.

¡No dejes pasar esta oportunidad! Tu próximo desafío en el voleibol puede comenzar con esta convocatoria.$t$,
        promo_desde = DATE '2026-11-25',
        promo_hasta = DATE '2026-11-27'
    WHERE school_id = v_escuela;
END $$;

COMMIT;
