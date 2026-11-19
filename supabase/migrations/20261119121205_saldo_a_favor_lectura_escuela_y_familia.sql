-- =============================================================================
-- 20261119121205_saldo_a_favor_lectura_escuela_y_familia.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-19   Versión anterior: 20261119120806
-- Objetivo: LEER el saldo a favor (20261013165308). Hasta hoy se registraba y se
--   consumía solo, sin ninguna pantalla. Tres lectores, una sola fuente:
--     · _saldos_a_favor(school, dueño)      interna, solo service_role (BFF: estado de cuenta)
--     · saldos_a_favor_escuela(school)      admin/finanzas de ESA escuela (Gestión de Pagos)
--     · mi_saldo_a_favor()                  acudiente / atleta adulto: solo lo propio
--   Solo lectura: no toca payments ni payment_adjustments.
-- Saldo = Σ 'saldo_a_favor' − Σ consumos ('descuento' origin saldo_a_favor), sin
--   contar lo revertido (misma regla que _saldo_a_favor_disponible).
-- =============================================================================

BEGIN;

-- ── 1. Núcleo interno ────────────────────────────────────────────────────────
-- Una fila por dueño con movimientos. p_dueno NULL = todos los de la escuela.
CREATE OR REPLACE FUNCTION public._saldos_a_favor(p_school_id uuid, p_dueno text DEFAULT NULL)
 RETURNS TABLE (
    dueno text, nombre text, generado numeric, consumido numeric, disponible numeric,
    ultimo_movimiento timestamptz, pago_origen_id uuid)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp
AS $function$
    WITH mov AS (
        SELECT public._saldo_a_favor_dueno(p.child_id, p.unregistered_athlete_id, p.user_id, p.parent_id) AS dueno,
               p.child_id, p.unregistered_athlete_id, COALESCE(p.user_id, p.parent_id) AS adulto,
               a.kind, a.amount, a.created_at, a.payment_id
          FROM public.payment_adjustments a
          JOIN public.payments p ON p.id = a.payment_id
         WHERE a.school_id = p_school_id
           AND a.origin = 'saldo_a_favor'
           AND a.kind IN ('saldo_a_favor', 'descuento')
           AND NOT EXISTS (SELECT 1 FROM public.payment_adjustments r WHERE r.reverts_id = a.id)
    ), agg AS (
        SELECT m.dueno,
               min(m.child_id::text)::uuid AS child_id,
               min(m.unregistered_athlete_id::text)::uuid AS unreg_id,
               min(m.adulto::text)::uuid AS adulto,
               COALESCE(sum(m.amount) FILTER (WHERE m.kind = 'saldo_a_favor'), 0) AS generado,
               COALESCE(sum(m.amount) FILTER (WHERE m.kind = 'descuento'), 0) AS consumido,
               max(m.created_at) AS ultimo,
               (array_agg(m.payment_id ORDER BY m.created_at DESC) FILTER (WHERE m.kind = 'saldo_a_favor'))[1] AS origen
          FROM mov m
         WHERE m.dueno IS NOT NULL AND (p_dueno IS NULL OR m.dueno = p_dueno)
         GROUP BY m.dueno
    )
    SELECT g.dueno,
           COALESCE(c.full_name, u.full_name, pr.full_name, 'Sin nombre'),
           g.generado, g.consumido, g.generado - g.consumido, g.ultimo, g.origen
      FROM agg g
      LEFT JOIN public.children c ON c.id = g.child_id
      LEFT JOIN public.unregistered_athletes u ON u.id = g.unreg_id
      LEFT JOIN public.profiles pr ON pr.id = g.adulto
     ORDER BY (g.generado - g.consumido) DESC, g.ultimo DESC;
$function$;

REVOKE ALL ON FUNCTION public._saldos_a_favor(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._saldos_a_favor(uuid, text) TO service_role;

-- ── 2. Escuela: lista de saldos (alcance validado sobre ESE school_id) ───────
CREATE OR REPLACE FUNCTION public.saldos_a_favor_escuela(p_school_id uuid)
 RETURNS TABLE (
    dueno text, nombre text, generado numeric, consumido numeric, disponible numeric,
    ultimo_movimiento timestamptz, pago_origen_id uuid)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
    IF p_school_id IS NULL OR NOT (p_school_id = ANY ((SELECT public.finance_read_school_ids())::uuid[])) THEN
        RAISE EXCEPTION 'Sin acceso a las finanzas de esta escuela' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT * FROM public._saldos_a_favor(p_school_id, NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.saldos_a_favor_escuela(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.saldos_a_favor_escuela(uuid) TO authenticated;

-- ── 3. Familia: solo lo propio (mismo predicado que v_payment_adjustments_familia)
CREATE OR REPLACE FUNCTION public.mi_saldo_a_favor()
 RETURNS TABLE (
    school_id uuid, escuela text, dueno text, nombre text,
    generado numeric, consumido numeric, disponible numeric, ultimo_movimiento timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp
AS $function$
    WITH propios AS (
        SELECT DISTINCT p.school_id,
               public._saldo_a_favor_dueno(p.child_id, p.unregistered_athlete_id, p.user_id, p.parent_id) AS dueno
          FROM public.payments p
         WHERE (p.parent_id = (SELECT auth.uid())
             OR p.user_id   = (SELECT auth.uid())
             OR p.child_id IN (SELECT c.id FROM public.children c WHERE c.parent_id = (SELECT auth.uid())))
           AND EXISTS (SELECT 1 FROM public.payment_adjustments a
                        WHERE a.payment_id = p.id AND a.origin = 'saldo_a_favor')
    )
    SELECT pr.school_id, COALESCE(s.name, 'Escuela'), x.dueno, x.nombre,
           x.generado, x.consumido, x.disponible, x.ultimo_movimiento
      FROM propios pr
      CROSS JOIN LATERAL public._saldos_a_favor(pr.school_id, pr.dueno) x
      LEFT JOIN public.schools s ON s.id = pr.school_id
     WHERE pr.dueno IS NOT NULL
       AND x.disponible > 0;
$function$;

REVOKE ALL ON FUNCTION public.mi_saldo_a_favor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_saldo_a_favor() TO authenticated;

COMMIT;
