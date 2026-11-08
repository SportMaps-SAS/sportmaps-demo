-- =============================================================================
-- 20261107174916_seg31_session_bookings_escritura_cliente.sql
-- Autor: judegor99   Fecha: 2026-11-07   Versión anterior: 20261107111754
-- Objetivo: SEG-31 C2 — cerrar la escritura directa (REST) de session_bookings
--   desde el navegador. *** REQUIERE APROBACIÓN HUMANA ANTES DE APLICAR ***
--
--   Hallazgo (estado vivo verificado el 2026-11-07):
--     · Grants de tabla INSERT/SELECT/UPDATE/DELETE para anon y authenticated.
--     · session_bookings_update_cancel (UPDATE, authenticated):
--         USING/CHECK user_id = auth.uid() OR is_parent_of_child(child_id)
--                     OR school_id = ANY(user_staff_school_ids())
--       → el atleta o el padre puede, por REST, volver a 'confirmed' una
--         reserva que ya canceló por el BFF (con el crédito ya devuelto):
--         cancelar/reactivar en bucle = créditos infinitos. También puede
--         pasar attended/no_show → confirmed y después cancelar con
--         devolución (R1). Y con UPDATE de toda la fila puede cambiar
--         session_id, enrollment_id, is_secondary…
--     · session_bookings_insert_with_enrollment (INSERT, authenticated) y
--       «public can confirm attendance via poll link» (INSERT, roles public):
--       insertar reservas por REST sin pasar por move_session_credit = clases
--       sin consumir crédito.
--
--   Escritores reales (verificado en el repo el 2026-11-07):
--     · Navegador: SOLO frontend/src/hooks/useFacilityReservations.ts:282-298
--       (updateReservation): UPDATE de status + updated_at, para clases de
--       cortesía, desde SchoolFacilitiesPage (ruta /facilities: school,
--       admin, school_admin, super_admin, facility_manager). Lo llaman
--       approveReservation (manda 'confirmed' si la fila está 'pending') y
--       completeReservation (manda 'completed' si está 'confirmed').
--       Atleta y padre NO escriben session_bookings por REST en ningún lado:
--       cancelan por el BFF. supabase/functions/: no escribe session_bookings.
--     · BFF: todos los escritores usan el cliente service_role
--       (bff/src/config/supabase.ts → SUPABASE_SERVICE_ROLE_KEY), incluida la
--       inserción de la encuesta (polls.controller.ts:312-333, `const client
--       = supabase`). El userClient (anon key + JWT) de polls.controller.ts:99
--       solo toca attendance_polls y attendance_sessions.
--
--   Enum vivo (verificado 2026-11-07): public.booking_status solo tiene
--   'confirmed', 'cancelled', 'attended', 'no_show'. NO existen 'pending' ni
--   'completed'. Consecuencias:
--     · Ninguna fila puede estar 'pending', así que approveReservation nunca
--       aplica a una session_booking; y completeReservation manda 'completed',
--       que la columna rechaza con 22P02. El flujo del staff por REST YA
--       FALLABA hoy. Es un bug previo de la UI (fuera de alcance: hay que
--       decidir si se quita el botón o se mueve al BFF con un estado real);
--       tras esta migración el mismo botón da 42501 en vez de 22P02.
--
--   Decisión: no queda NINGÚN uso legítimo de UPDATE por REST (el único caller
--   apunta a valores imposibles y los demás actores escriben por el BFF). Por
--   eso NO se devuelve el GRANT UPDATE (status, updated_at) que proponía el
--   ciclo anterior y se ELIMINA session_bookings_update_cancel en lugar de
--   restringirla a staff: una policy sin GRANT no hace nada hoy y revive (con
--   la rama del dueño = R1) el día que alguien devuelva el GRANT. Radio: 0
--   escuelas pierden una operación que funcionara.
--
--   Bloques:
--     1. REVOKE INSERT/UPDATE/DELETE (y TRUNCATE/REFERENCES/TRIGGER, que en
--        Supabase vienen en el GRANT ALL por defecto; TRUNCATE ignora RLS) de
--        anon y authenticated. Quedan solo con SELECT (no se toca).
--     2. Trigger BEFORE UPDATE OF status trg_session_bookings_guard_cliente
--        (defensa en profundidad): desde anon/authenticated, CUALQUIER cambio
--        de status → 42501 transicion_no_permitida. Cambiar solo updated_at no
--        la dispara. Compara con ::text.
--     3. DROP de session_bookings_update_cancel y de las dos policies de
--        INSERT, imprimiendo antes su definición (RAISE NOTICE «policy previa:»).
--     4. Afirmaciones: aborta si queda policy INSERT/UPDATE/ALL, si falta la
--        guardia o si anon/authenticated conservan INSERT/UPDATE (tabla o
--        columna), DELETE o TRUNCATE.
--   Helpers de RLS (is_parent_of_child, user_*_school_ids): NO se tocan.
--   session_bookings_select_own y _delete_none: NO se tocan.
--   Ojo: docs/migraciones-pendientes-2026-10-28/cerrar-anon-funciones-definer-verificar.sql
--   (y la afirmación histórica de 20261028111254) esperan que existan
--   session_bookings_update_cancel e _insert_with_enrollment; tras aplicar,
--   ese verificador las reportará como «no existe la policy» — es esperado.
--
-- -----------------------------------------------------------------------------
-- Verificación PREVIA (guardar la salida: es el insumo del rollback):
--
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema='public' and table_name='session_bookings'
--      and grantee in ('anon','authenticated') order by 1,2;
--   select format('CREATE POLICY %I ON public.session_bookings AS %s FOR %s TO %s%s%s;',
--                 policyname, permissive, cmd, array_to_string(roles, ', '),
--                 coalesce(' USING (' || qual || ')', ''),
--                 coalesce(' WITH CHECK (' || with_check || ')', ''))
--     from pg_policies where schemaname='public' and tablename='session_bookings';
--   select enum_range(null::public.booking_status);    -- {confirmed,cancelled,attended,no_show}
--   -- Funciones SECURITY INVOKER que escriben session_bookings: si alguna la
--   -- dispara authenticated (RPC o trigger de otra tabla), empezaría a dar
--   -- 42501. En el repo todas las que escriben son SECURITY DEFINER; esto lo
--   -- confirma en vivo (esperado: 0 filas):
--   select p.proname, p.prosecdef
--     from pg_proc p
--    where p.pronamespace = 'public'::regnamespace and not p.prosecdef
--      and p.prosrc ~* '(update|insert\s+into|delete\s+from)\s+(public\.)?session_bookings';
--
-- Verificación POSTERIOR:
--
--   -- a) Grants de tabla: anon y authenticated solo con SELECT
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema='public' and table_name='session_bookings'
--      and grantee in ('anon','authenticated') order by 1,2;
--   -- b) Grants de columna distintos de SELECT: 0 filas
--   select grantee, column_name, privilege_type from information_schema.column_privileges
--    where table_schema='public' and table_name='session_bookings'
--      and grantee in ('anon','authenticated') and privilege_type <> 'SELECT';
--   -- c) Policies: solo SELECT (select_own) y DELETE (delete_none); ninguna INSERT/UPDATE/ALL
--   select cmd, policyname, permissive, roles, qual, with_check
--     from pg_policies where schemaname='public' and tablename='session_bookings' order by cmd;
--   -- d) Trigger y función
--   select tgname, tgenabled from pg_trigger
--    where tgrelid='public.session_bookings'::regclass and tgname='trg_session_bookings_guard_cliente';
--   select proname, prosecdef, proconfig, proacl from pg_proc where proname='fn_session_bookings_guard_cliente';
--                                       -- prosecdef = false, search_path fijo
--   -- e) Pruebas de rol (no persisten). Script ejecutable con datos de prueba
--   --    y ROLLBACK: supabase/migrations/_smoke/seg31_session_bookings_escritura_cliente_smoke.sql
--   --    A mano, con un atleta y con un staff reales:
--   begin; set local role authenticated;
--   select set_config('request.jwt.claims',
--          json_build_object('sub','<uuid>','role','authenticated')::text, true);
--   update public.session_bookings set status='confirmed' where id='<attended o cancelada>';  -- 42501
--   rollback;
--   begin; set local role authenticated; ...claims...;
--   insert into public.session_bookings (school_id, session_id, user_id, status)
--        values ('<escuela>','<sesion>','<uuid>','confirmed');                    -- 42501
--   rollback;
--   -- f) npm run seguridad:invariantes
--
-- -----------------------------------------------------------------------------
-- Rollback (reabre el hueco C2/R1: solo si algo del navegador que SÍ funcionaba
-- se rompió y no hay otra salida; preferir arreglar el caller):
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_session_bookings_guard_cliente ON public.session_bookings;
--   DROP FUNCTION IF EXISTS public.fn_session_bookings_guard_cliente();
--   GRANT INSERT, UPDATE, DELETE ON public.session_bookings TO anon, authenticated;
--   -- Recrear session_bookings_update_cancel y las dos policies de INSERT con
--   -- las sentencias que imprimió esta migración (NOTICE «policy previa:») o la
--   -- consulta previa. Valor vivo conocido de update_cancel (TO authenticated):
--   --   USING/CHECK ((user_id = auth.uid()) OR is_parent_of_child(child_id)
--   --                OR (school_id = ANY (user_staff_school_ids())))
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
--   · Trampa 1: las policies son permisivas y se suman con OR — al cerrar una
--     tabla se listan TODAS sus policies.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. Grants de tabla: anon y authenticated quedan SOLO con SELECT
-- =============================================================================
-- REVOKE de la tabla también retira los grants de columna que hubiera.
-- No se devuelve ningún GRANT de columna: con el enum vivo no existe ninguna
-- escritura legítima desde el navegador (ver encabezado, «Decisión»).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.session_bookings FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.session_bookings FROM authenticated;

-- =============================================================================
-- 2. Guardia de status (defensa en profundidad)
-- =============================================================================
-- Tras el bloque 1, un UPDATE por REST ya da 42501 por privilegios antes de
-- llegar aquí. La guardia queda para el día que alguien devuelva un GRANT o
-- una policy de UPDATE (trampa 1): desde anon/authenticated, CUALQUIER cambio
-- de status da 42501 transicion_no_permitida. Cambiar solo updated_at (o
-- reescribir el mismo status) no la dispara.
-- Compara con ::text: nunca castea a booking_status un literal (si se
-- nombrara un valor inexistente daría 22P02 en vez de 42501).
-- SECURITY INVOKER a propósito: decide por current_user. En una función
-- SECURITY DEFINER current_user sería el dueño (postgres) y no dispararía
-- nunca. Como INVOKER, current_user es el rol que hizo el UPDATE:
--   · anon / authenticated  → REST directo desde el navegador → se aplica.
--   · service_role (BFF) o el dueño de una RPC SECURITY DEFINER
--     (session_booking_reschedule, cancel_session_booking_with_credit, …)
--     → no se aplica: esos caminos validan y mueven el crédito.
-- No lee ninguna tabla (solo OLD/NEW): no necesita privilegios extra.
CREATE OR REPLACE FUNCTION public.fn_session_bookings_guard_cliente()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF current_user IN ('anon', 'authenticated')
       AND NEW.status::text IS DISTINCT FROM OLD.status::text
    THEN
        RAISE EXCEPTION 'transicion_no_permitida: El estado de una reserva no se cambia desde aquí (% → %).',
            OLD.status::text, NEW.status::text
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_session_bookings_guard_cliente() IS
    'SEG-31 C2/R1: anon/authenticated (REST directo) no pueden cambiar '
    'session_bookings.status (42501 transicion_no_permitida). Defensa en '
    'profundidad: hoy ya no tienen GRANT de UPDATE. SECURITY INVOKER porque '
    'decide por current_user. Migración 20261107174916.';

-- Función de trigger: nadie la llama directo. El trigger no usa el EXECUTE de
-- quien dispara el UPDATE (solo se exige al crear el trigger, como dueño).
REVOKE ALL ON FUNCTION public.fn_session_bookings_guard_cliente() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_session_bookings_guard_cliente() FROM anon;
REVOKE ALL ON FUNCTION public.fn_session_bookings_guard_cliente() FROM authenticated;

DROP TRIGGER IF EXISTS trg_session_bookings_guard_cliente ON public.session_bookings;
CREATE TRIGGER trg_session_bookings_guard_cliente
    BEFORE UPDATE OF status ON public.session_bookings
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_session_bookings_guard_cliente();

-- =============================================================================
-- 3. Policies de escritura: se eliminan (sin GRANT ya no tienen efecto)
-- =============================================================================
-- Dejarlas es la trampa 1 de CLAUDE.md: el día que alguien devuelva un GRANT,
-- reviven (update_cancel con la rama del dueño y del padre = R1). Antes de
-- borrarlas se imprime su definición para el log de aplicación y el rollback.
DO $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT format('CREATE POLICY %I ON public.session_bookings AS %s FOR %s TO %s%s%s;',
                      policyname, permissive, cmd, array_to_string(roles, ', '),
                      coalesce(' USING (' || qual || ')', ''),
                      coalesce(' WITH CHECK (' || with_check || ')', '')) AS ddl
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'session_bookings'
           AND cmd IN ('INSERT', 'UPDATE', 'ALL')
    LOOP
        RAISE NOTICE 'policy previa: %', r.ddl;
    END LOOP;
END $$;

DROP POLICY IF EXISTS "session_bookings_update_cancel"               ON public.session_bookings;
DROP POLICY IF EXISTS "session_bookings_insert_with_enrollment"      ON public.session_bookings;
DROP POLICY IF EXISTS "public can confirm attendance via poll link"  ON public.session_bookings;

-- =============================================================================
-- 4. Afirmaciones (abortan todo si el estado final no es el esperado)
-- =============================================================================
-- Si el nombre vivo de alguna policy difiere, el DROP IF EXISTS no hace nada
-- en silencio; esto lo detecta.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'session_bookings'
                  AND cmd IN ('INSERT', 'UPDATE', 'ALL')) THEN
        RAISE EXCEPTION 'SEG-31 C2: queda una policy INSERT/UPDATE/ALL en session_bookings; revisar nombres vivos antes de aplicar.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = 'public.session_bookings'::regclass
                      AND tgname = 'trg_session_bookings_guard_cliente' AND tgenabled <> 'D') THEN
        RAISE EXCEPTION 'SEG-31 R1: falta la guardia trg_session_bookings_guard_cliente.';
    END IF;
    -- has_any_column_privilege es true si el privilegio está a nivel de tabla
    -- O en cualquier columna: cubre los dos casos.
    IF has_any_column_privilege('anon',          'public.session_bookings', 'INSERT')
       OR has_any_column_privilege('anon',          'public.session_bookings', 'UPDATE')
       OR has_table_privilege     ('anon',          'public.session_bookings', 'DELETE')
       OR has_table_privilege     ('anon',          'public.session_bookings', 'TRUNCATE')
       OR has_any_column_privilege('authenticated', 'public.session_bookings', 'INSERT')
       OR has_any_column_privilege('authenticated', 'public.session_bookings', 'UPDATE')
       OR has_table_privilege     ('authenticated', 'public.session_bookings', 'DELETE')
       OR has_table_privilege     ('authenticated', 'public.session_bookings', 'TRUNCATE') THEN
        RAISE EXCEPTION 'SEG-31 C2: anon/authenticated conservan escritura sobre session_bookings (¿grant vía PUBLIC u otro rol?).';
    END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
