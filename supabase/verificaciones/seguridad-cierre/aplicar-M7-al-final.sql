-- aplicar-M7-al-final.sql: SOLO la M7 (copia exacta de supabase/migrations/20261105213611_reservas_revocar_escritura_directa.sql).
-- Aplicar DESPUÉS de aplicar-1-a-N.sql Y de desplegar el frontend nuevo y el BFF nuevo. Lleva su BEGIN/COMMIT.

-- 20261105213611_reservas_revocar_escritura_directa.sql
--
-- APLICAR AL FINAL: SOLO DESPUÉS de desplegar el frontend nuevo que ya no escribe directo (de lo contrario las pantallas dan 42501).
--
-- ORDEN: ÚLTIMA de las migraciones del cierre de seguridad de reservas (después de 20261105211824,
--   20261105212046, 20261105212125 y 20261105213601). PRECONDICIONES, TODAS:
--   1. Frontend desplegado SIN escrituras directas a facility_reservations / reservation_payments /
--      facility_blackouts (solo RPC reservar_cancha / cancelar_reserva / reprogramar_reserva / confirmar_pago_reserva
--      y rutas BFF /api/v1/reservations-admin/* con service_role). Ya NO existe el flujo viejo de "solicitud directa"
--      (INSERT status='pending' del padre): migró a reservar_cancha.
--   2. BFF desplegado con las rutas de bloqueos (POST/DELETE /reservations-admin/blackouts).
--   3. 20261105212125 aplicada (reservar_cancha de 16 argumentos).
--
-- QUÉ HACE (M7):
--   * authenticated pierde INSERT/UPDATE/DELETE (y TRUNCATE/REFERENCES/TRIGGER) sobre facility_reservations,
--     reservation_payments y facility_blackouts; conserva SELECT. service_role y las funciones SECURITY DEFINER
--     (dueño postgres) siguen escribiendo. Hasta hoy cualquier "staff" (incluido coach/viewer/reporter, vía
--     user_staff_school_ids) y cualquier usuario con su propio user_id podía escribir esas tablas por PostgREST,
--     saltándose todo el motor de reglas (precio, cupo, ventanas, tarifa member, canal, pago).
--   * Policies de ESCRITURA retiradas (quedaban inertes tras el REVOKE; se retiran para que nadie las "reviva"
--     con un GRANT): facility_resv_athlete_cancel, facility_resv_athlete_insert, facility_resv_insert_own,
--     reservations_insert_request, reservations_update, reservations_delete; las ALL facility_resv_school_manage,
--     rp_school y rp_school_all se sustituyen por SELECT-only equivalentes; rp_insert/rp_insert_own se retiran;
--     facility_blackouts_insert/update/delete se retiran. Se conservan las de lectura (reservations_select,
--     facility_resv_select_own, rp_own, rp_select_own, facility_blackouts_select). NO se tocan las guardas
--     trg_aa_guarda_* (defensa en profundidad: siguen frenando escrituras fuera del RPC).
--   * reservation_payments: ningún escritor en frontend ni BFF (el único era submit_facility_booking_v2, DEFINER sin
--     llamadores); por eso también se retira la escritura directa.
--   * submit_facility_booking_v2: EXECUTE se retira a authenticated (otra vía que escribía ambas tablas).
--     service_role lo conserva.
--   * sync_reservation_payment_status (trigger SECURITY DEFINER): search_path fijo a pg_catalog, public, pg_temp,
--     mismo cuerpo.
--   * Filas históricas 'Bloqueo interno' (notes='Bloqueo interno', price=0, sin starts_at) NO se tocan; el
--     frontend las sigue leyendo con SELECT.
--
-- REVERSA (si algo se rompe tras aplicarla): GRANT INSERT, UPDATE, DELETE ON <tabla> TO authenticated; y recrear
-- las policies desde el dump; no hace falta tocar nada más.

BEGIN;

-- ── facility_reservations ──────────────────────────────────────────────────
REVOKE ALL ON public.facility_reservations FROM anon, authenticated;
GRANT SELECT ON public.facility_reservations TO authenticated;

DROP POLICY IF EXISTS facility_resv_athlete_cancel ON public.facility_reservations;
DROP POLICY IF EXISTS facility_resv_athlete_insert ON public.facility_reservations;
DROP POLICY IF EXISTS facility_resv_insert_own     ON public.facility_reservations;
DROP POLICY IF EXISTS reservations_insert_request  ON public.facility_reservations;
DROP POLICY IF EXISTS reservations_update          ON public.facility_reservations;
DROP POLICY IF EXISTS reservations_delete          ON public.facility_reservations;
DROP POLICY IF EXISTS facility_resv_school_manage  ON public.facility_reservations;
DROP POLICY IF EXISTS facility_resv_school_select  ON public.facility_reservations;
CREATE POLICY facility_resv_school_select ON public.facility_reservations
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.school_members sm
                  WHERE sm.school_id = facility_reservations.school_id
                    AND sm.profile_id = auth.uid()
                    AND sm.role = ANY (ARRAY['owner', 'admin', 'staff', 'school_admin'])
                    AND sm.status = 'active'));

-- ── reservation_payments ───────────────────────────────────────────────────
REVOKE ALL ON public.reservation_payments FROM anon, authenticated;
GRANT SELECT ON public.reservation_payments TO authenticated;

DROP POLICY IF EXISTS rp_insert        ON public.reservation_payments;
DROP POLICY IF EXISTS rp_insert_own    ON public.reservation_payments;
DROP POLICY IF EXISTS rp_school        ON public.reservation_payments;
DROP POLICY IF EXISTS rp_school_all    ON public.reservation_payments;
DROP POLICY IF EXISTS rp_school_select ON public.reservation_payments;
CREATE POLICY rp_school_select ON public.reservation_payments
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.school_members sm
                  WHERE sm.school_id = reservation_payments.school_id
                    AND sm.profile_id = auth.uid()
                    AND sm.role = ANY (ARRAY['owner', 'admin', 'staff', 'school_admin'])
                    AND sm.status = 'active'));

-- ── facility_blackouts (escribe solo el BFF con service_role) ──────────────
REVOKE ALL ON public.facility_blackouts FROM anon, authenticated;
GRANT SELECT ON public.facility_blackouts TO authenticated;
DROP POLICY IF EXISTS facility_blackouts_insert ON public.facility_blackouts;
DROP POLICY IF EXISTS facility_blackouts_update ON public.facility_blackouts;
DROP POLICY IF EXISTS facility_blackouts_delete ON public.facility_blackouts;

-- ── submit_facility_booking_v2: sin EXECUTE para authenticated ─────────────
REVOKE EXECUTE ON FUNCTION public.submit_facility_booking_v2(uuid, uuid, date, time, time, text, text, text, integer, text, numeric, text, text)
  FROM PUBLIC, anon, authenticated;

-- ── trigger de pagos: search_path fijo (mismo cuerpo) ──────────────────────
CREATE OR REPLACE FUNCTION public.sync_reservation_payment_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_paid  numeric;
  v_price numeric;
  v_ps    resv_payment_status;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_paid
  FROM reservation_payments
  WHERE reservation_id = COALESCE(NEW.reservation_id, OLD.reservation_id)
    AND status = 'approved';

  SELECT price INTO v_price FROM facility_reservations
  WHERE id = COALESCE(NEW.reservation_id, OLD.reservation_id);

  IF v_paid <= 0        THEN v_ps := 'unpaid';
  ELSIF v_paid < v_price THEN v_ps := 'partial';
  ELSE                       v_ps := 'paid';
  END IF;

  UPDATE facility_reservations
  SET amount_paid    = v_paid,
      payment_status = v_ps,
      updated_at     = now()
  WHERE id = COALESCE(NEW.reservation_id, OLD.reservation_id);

  RETURN NEW;
END;
$function$;

COMMIT;
