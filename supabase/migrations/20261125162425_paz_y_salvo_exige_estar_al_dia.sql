-- =============================================================================
-- 20261125162425_paz_y_salvo_exige_estar_al_dia.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-25   Versión anterior: 20261125140410
-- Objetivo:
-- 1) Un paz y salvo (constancia de tipo 'payment') no se puede PEDIR ni EMITIR
--    si la familia tiene cobros vencidos en esa escuela. Antes el texto lo
--    escribía la escuela y nada lo validaba: una familia en mora podía recibir
--    un paz y salvo si alguien lo aprobaba sin mirar.
--    Se hace con un trigger BEFORE INSERT OR UPDATE OF status sobre
--    athlete_certificates, sin reescribir las RPC vivas (20261124152343).
--    «Vencido» = status 'overdue', o 'pending'/'partial' con due_date < hoy
--    (Bogotá). Cuenta los cobros del deportista y los de la familia sin
--    deportista (child_id NULL con el mismo acudiente).
-- 2) Plantilla «Paz y salvo» para Club Deportivo Besser y Monster's Volley Club
--    (a pedido del usuario, 2026-11-25). Activa y predeterminada de su tipo,
--    sin firmante: la escuela pone quién firma en Constancias → Plantillas.
--
-- RADIO: athlete_certificates tiene 5 filas (todas de la demo, ninguna de tipo
-- 'payment'): el trigger no cambia nada existente. Plantillas: +2 filas.
-- ROLLBACK: DROP TRIGGER trg_paz_y_salvo_al_dia + su función; DELETE de las 2
-- plantillas por nombre y escuela si no se usaron.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.tg_paz_y_salvo_exige_al_dia()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_parent  uuid;
    v_vencidos int;
    v_hoy     date := (now() AT TIME ZONE 'America/Bogota')::date;
BEGIN
    IF NEW.kind IS DISTINCT FROM 'payment'
       OR NEW.status NOT IN ('pending_review', 'pending_payment', 'issued') THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NEW.child_id IS NOT NULL THEN
        SELECT c.parent_id INTO v_parent FROM public.children c WHERE c.id = NEW.child_id;
    END IF;

    SELECT count(*) INTO v_vencidos
      FROM public.payments p
     WHERE p.school_id = NEW.school_id
       AND (p.status = 'overdue'
            OR (p.status IN ('pending', 'partial') AND p.due_date < v_hoy))
       AND (
            (NEW.child_id IS NOT NULL AND (p.child_id = NEW.child_id
                OR (p.child_id IS NULL AND v_parent IS NOT NULL AND p.parent_id = v_parent)))
         OR (NEW.profile_id IS NOT NULL AND (p.user_id = NEW.profile_id
                OR (p.child_id IS NULL AND p.parent_id = NEW.profile_id)))
       );

    IF v_vencidos > 0 THEN
        RAISE EXCEPTION 'No se puede dar el paz y salvo: hay % cobro(s) vencido(s). Cuando estén al día, se puede pedir de nuevo.', v_vencidos
            USING ERRCODE = '23514', HINT = 'paz_y_salvo_con_cobros_vencidos';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_paz_y_salvo_exige_al_dia() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_paz_y_salvo_al_dia ON public.athlete_certificates;
CREATE TRIGGER trg_paz_y_salvo_al_dia
    BEFORE INSERT OR UPDATE OF status ON public.athlete_certificates
    FOR EACH ROW EXECUTE FUNCTION public.tg_paz_y_salvo_exige_al_dia();

-- Plantillas de paz y salvo (mismo texto que la sugerida de frontend/src/lib/constancias.ts)
INSERT INTO public.school_certificate_templates
    (school_id, name, kind, title, body_template, footer_text, requires_payment, price, is_default, active)
SELECT s.id, 'Paz y salvo', 'payment', 'PAZ Y SALVO',
       E'{{escuela.nombre}} certifica que {{atleta.nombre}}, {{atleta.identificacion}}, {{atleta.inscrito}} en {{equipo}}, se encuentra a paz y salvo por todo concepto con la institución a la fecha.\n\nSe expide a solicitud del interesado el {{fecha_emision}}.',
       'Documento generado electrónicamente. Verifique su autenticidad escaneando el código QR.',
       false, 0, true, true
  FROM public.schools s
 WHERE s.slug IN ('club-deportivo-besser', 'monsters-volley-club')
   AND NOT EXISTS (
       SELECT 1 FROM public.school_certificate_templates t
        WHERE t.school_id = s.id AND t.kind = 'payment' AND (t.is_default OR t.name = 'Paz y salvo')
   );

COMMIT;
