-- =============================================================================
-- PRUEBAS ADICIONALES de reservas de canchas F1 (complementan reservas-f1-pruebas.sql).
-- NO es una migración. Correr SOLO contra el GEMELO local, con las 12 migraciones
-- 20261105* de reservas aplicadas:
--     npm run qa:sql -- supabase/verificaciones/reservas-f1-pruebas-extra.sql
-- Todo en una transacción con ROLLBACK final. Cada chequeo hace RAISE EXCEPTION si falla.
--
-- Cubre: E1 llave de idempotencia repetida por OTRO usuario · E2 reprogramar a franja más
-- cara (RESCHEDULE_PRICE_DIFFERS) · E3 pago parcial + expirar_holds · E4 anon / authenticated
-- sin EXECUTE (RPC y helpers) y sin acceso a las tablas nuevas · E5 staff de A vs reserva de B ·
-- E6 invariantes I1–I5/I7 sobre los objetos nuevos · E7 flujo VIEJO (solicitud 'pending' directa
-- + aprobación del admin) sigue vivo y ocupa la franja.
-- =============================================================================
begin;

create or replace function pg_temp.chk(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FALLO: %', msg; end if; raise notice 'OK: %', msg; end $$;
grant execute on function pg_temp.chk(boolean, text) to public;

create or replace function pg_temp.slot(dia text, hhmm text) returns timestamptz language sql as $$
  select ((dia || ' ' || hhmm)::timestamp at time zone 'America/Bogota') $$;
grant execute on function pg_temp.slot(text, text) to public;

create or replace function pg_temp.mk_user(p_email text, p_meta jsonb) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role, created_at, updated_at)
  values (v, p_email, p_meta, 'authenticated', 'authenticated', now(), now());
  return v;
end $$;

-- Como el actor: "as_user(uuid)" fija el JWT y cambia a authenticated; "as_service()" vuelve al dueño.
create or replace function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;
grant execute on function pg_temp.as_user(uuid) to public;

create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;
grant execute on function pg_temp.as_service() to public;

-- Filas de una tabla de la escuela dada que el rol actual ve; sin privilegio de SELECT cuenta como 0.
create or replace function pg_temp.visibles(p_tabla text, p_school uuid) returns int language plpgsql as $$
declare n int;
begin
  execute 'select count(*) from public.' || quote_ident(p_tabla) || ' where school_id = $1' into n using p_school;
  return n;
exception when insufficient_privilege then return 0; end $$;
grant execute on function pg_temp.visibles(text, uuid) to public;

select set_config('qa.dia',  ((now() at time zone 'America/Bogota')::date + 3)::text, true);
select set_config('qa.dia2', ((now() at time zone 'America/Bogota')::date + 4)::text, true);

-- ══ SETUP: dos escuelas venue, miembros, externo, una cancha en cada una ═══════════
do $$
declare
  v_oa uuid := pg_temp.mk_user('qx.own.a@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_ob uuid := pg_temp.mk_user('qx.own.b@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_sta uuid := pg_temp.mk_user('qx.staff.a@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_stb uuid := pg_temp.mk_user('qx.staff.b@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_p1 uuid := pg_temp.mk_user('qx.par1@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_p2 uuid := pg_temp.mk_user('qx.par2@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_ext uuid := pg_temp.mk_user('qx.ext@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_sa uuid := gen_random_uuid(); v_sb uuid := gen_random_uuid();
  v_fa uuid := gen_random_uuid(); v_fb uuid := gen_random_uuid();
  v_horas jsonb := '{"monday":["06:00-23:00"],"tuesday":["06:00-23:00"],"wednesday":["06:00-23:00"],"thursday":["06:00-23:00"],"friday":["06:00-23:00"],"saturday":["06:00-23:00"],"sunday":["06:00-23:00"]}';
begin
  insert into public.schools (id, name, owner_id, school_type) values (v_sa, 'QX Venue A', v_oa, 'venue'), (v_sb, 'QX Venue B', v_ob, 'venue');
  insert into public.school_members (school_id, profile_id, role, status) values
    (v_sa, v_sta, 'staff', 'active'), (v_sb, v_stb, 'staff', 'active'),
    (v_sa, v_p1, 'parent', 'active'), (v_sa, v_p2, 'parent', 'active')
  on conflict do nothing;
  update public.profiles set date_of_birth = (current_date - interval '40 years')::date where id in (v_p1, v_p2, v_ext);
  insert into public.facilities (id, school_id, name, type, capacity, hourly_rate, rental_rate, rental_enabled, bookable_by, booking_enabled, available_hours)
  values (v_fa, v_sa, 'QX Cancha A', 'futbol', 10, 80000, 100000, true, 'both', true, v_horas),
         (v_fb, v_sb, 'QX Cancha B', 'futbol', 10, 90000, 110000, true, 'both', true, v_horas);
  perform set_config('qa.sa', v_sa::text, true); perform set_config('qa.sb', v_sb::text, true);
  perform set_config('qa.fa', v_fa::text, true); perform set_config('qa.fb', v_fb::text, true);
  perform set_config('qa.oa', v_oa::text, true);
  perform set_config('qa.sta', v_sta::text, true); perform set_config('qa.stb', v_stb::text, true);
  perform set_config('qa.p1', v_p1::text, true);  perform set_config('qa.p2', v_p2::text, true);
  perform set_config('qa.ext', v_ext::text, true);
  perform pg_temp.chk(public.has_entitlement(v_sa, 'reservations'), 'setup: la escuela venue A tiene entitlement reservations');
end $$;

-- ══ E1. Misma llave de idempotencia desde DOS usuarios distintos ═══════════════════
do $$
declare r jsonb; r_b jsonb; r_a2 jsonb; v_id uuid; v_n int;
begin
  perform pg_temp.as_user(current_setting('qa.p1')::uuid);
  r := public.reservar_cancha(current_setting('qa.fa')::uuid, pg_temp.slot(current_setting('qa.dia'), '10:00'), pg_temp.slot(current_setting('qa.dia'), '11:00'), 'app', 'qx-shared-key-0001');
  perform pg_temp.chk((r->>'ok')::boolean, 'E1 usuario 1 reserva con la llave');
  v_id := (r->'reservation'->>'id')::uuid;

  -- el mismo usuario repite: réplica idempotente de SU reserva
  r_a2 := public.reservar_cancha(current_setting('qa.fa')::uuid, pg_temp.slot(current_setting('qa.dia'), '10:00'), pg_temp.slot(current_setting('qa.dia'), '11:00'), 'app', 'qx-shared-key-0001');
  perform pg_temp.chk((r_a2->>'ok')::boolean and (r_a2->>'idempotent_replay')::boolean and (r_a2->'reservation'->>'id')::uuid = v_id, 'E1 el mismo usuario recibe su propia reserva como réplica');

  -- OTRO usuario con la MISMA llave y la MISMA franja: no recibe la reserva ajena
  perform pg_temp.as_user(current_setting('qa.p2')::uuid);
  r_b := public.reservar_cancha(current_setting('qa.fa')::uuid, pg_temp.slot(current_setting('qa.dia'), '10:00'), pg_temp.slot(current_setting('qa.dia'), '11:00'), 'app', 'qx-shared-key-0001');
  perform pg_temp.chk(coalesce((r_b->>'ok')::boolean, false) = false and r_b->>'error' = 'IDEMPOTENCY_KEY_REUSED', 'E1 otro usuario con la misma llave y franja: IDEMPOTENCY_KEY_REUSED (' || coalesce(r_b->>'error', 'ok') || ')');
  perform pg_temp.chk(r_b->'reservation' is null and not (r_b::text like '%' || v_id::text || '%'), 'E1 la respuesta al otro usuario no filtra la reserva ajena (ni su id)');

  -- OTRO usuario con la misma llave y OTRA franja: tampoco
  r_b := public.reservar_cancha(current_setting('qa.fa')::uuid, pg_temp.slot(current_setting('qa.dia'), '14:00'), pg_temp.slot(current_setting('qa.dia'), '15:00'), 'app', 'qx-shared-key-0001');
  perform pg_temp.chk(r_b->>'error' = 'IDEMPOTENCY_KEY_REUSED', 'E1 otro usuario, misma llave, otra franja: IDEMPOTENCY_KEY_REUSED');
  perform pg_temp.as_service();

  select count(*) into v_n from public.facility_reservations where idempotency_key = 'qx-shared-key-0001';
  perform pg_temp.chk(v_n = 1, 'E1 una sola fila con esa llave (hay ' || v_n || ')');
end $$;

-- ══ E2. Reprogramar a una franja más cara: RESCHEDULE_PRICE_DIFFERS ════════════════
do $$
declare r jsonb; r2 jsonb; v_id uuid; v_ref text; v_price numeric;
begin
  -- tarifa de miembro: pico 18:00-22:00 a 120000, valle 06:00-08:00 a 50000, resto 80000 (default)
  insert into public.facility_rates (school_id, facility_id, audience, from_time, to_time, price_per_hour, priority, label)
  values (current_setting('qa.sa')::uuid, current_setting('qa.fa')::uuid, 'member', '18:00', '22:00', 120000, 10, 'pico'),
         (current_setting('qa.sa')::uuid, current_setting('qa.fa')::uuid, 'member', '06:00', '08:00', 50000, 10, 'valle');

  perform pg_temp.as_user(current_setting('qa.p1')::uuid);
  r := public.reservar_cancha(current_setting('qa.fa')::uuid, pg_temp.slot(current_setting('qa.dia2'), '12:00'), pg_temp.slot(current_setting('qa.dia2'), '13:00'), 'app', 'qx-key-resch-0001');
  perform pg_temp.as_service();
  perform pg_temp.chk((r->>'ok')::boolean, 'E2 reserva a tarifa normal');
  v_id := (r->'reservation'->>'id')::uuid; v_ref := r->'reservation'->>'payment_reference';
  v_price := (r->'reservation'->>'price')::numeric;
  perform pg_temp.chk(v_price = 80000, 'E2 precio base 80000 (hay ' || v_price || ')');
  perform public.confirmar_pago_reserva(v_ref, v_price, null, 'wompi', 'evt-qx-resch-1');

  perform pg_temp.as_user(current_setting('qa.p1')::uuid);
  r2 := public.reprogramar_reserva(v_id, pg_temp.slot(current_setting('qa.dia2'), '19:00'), pg_temp.slot(current_setting('qa.dia2'), '20:00'));
  perform pg_temp.as_service();
  perform pg_temp.chk(r2->>'error' = 'RESCHEDULE_PRICE_DIFFERS', 'E2 reprogramar a franja pico más cara = RESCHEDULE_PRICE_DIFFERS (' || coalesce(r2->>'error', 'ok') || ')');
  perform pg_temp.chk((select starts_at from public.facility_reservations where id = v_id) = pg_temp.slot(current_setting('qa.dia2'), '12:00'), 'E2 la reserva no se movió');
  perform pg_temp.chk(exists (select 1 from public.facility_occupancy where source_kind = 'rental' and source_id = v_id and status = 'active'
                              and slot = tstzrange(pg_temp.slot(current_setting('qa.dia2'), '12:00'), pg_temp.slot(current_setting('qa.dia2'), '13:00'), '[)')), 'E2 la ocupación sigue en la franja original');

  -- a una franja más barata sí, y conserva el precio original (no devuelve diferencia en F1)
  perform pg_temp.as_user(current_setting('qa.p1')::uuid);
  r2 := public.reprogramar_reserva(v_id, pg_temp.slot(current_setting('qa.dia2'), '06:00'), pg_temp.slot(current_setting('qa.dia2'), '07:00'));
  perform pg_temp.as_service();
  perform pg_temp.chk((r2->>'ok')::boolean, 'E2 reprogramar a franja valle más barata funciona (' || coalesce(r2->>'error', 'ok') || ')');
  perform pg_temp.chk((select price from public.facility_reservations where id = v_id) = 80000, 'E2 conserva el precio original al mudarse a una franja más barata');
end $$;

-- ══ E3. Pago parcial y vencimiento del hold ═══════════════════════════════════════
do $$
declare r jsonb; r2 jsonb; v_id uuid; v_ref text; v_st text; r3 jsonb;
begin
  perform pg_temp.as_user(current_setting('qa.p2')::uuid);
  r := public.reservar_cancha(current_setting('qa.fa')::uuid, pg_temp.slot(current_setting('qa.dia2'), '15:00'), pg_temp.slot(current_setting('qa.dia2'), '16:00'), 'app', 'qx-key-parcial-0001');
  perform pg_temp.as_service();
  perform pg_temp.chk((r->>'ok')::boolean and r->'reservation'->>'status' = 'pending_payment', 'E3 la reserva nace pending_payment');
  v_id := (r->'reservation'->>'id')::uuid; v_ref := r->'reservation'->>'payment_reference';

  r2 := public.confirmar_pago_reserva(v_ref, 20000, null, 'wompi', 'evt-qx-parcial-1');
  perform pg_temp.chk((select amount_paid from public.facility_reservations where id = v_id) = 20000, 'E3 el pago parcial queda registrado');
  v_st := (select status from public.facility_reservations where id = v_id);
  perform pg_temp.chk(v_st in ('pending_payment', 'confirmed'), 'E3 estado tras el parcial: ' || v_st);

  if v_st = 'pending_payment' then
    update public.facility_reservations set hold_expires_at = now() - interval '1 minute' where id = v_id;
    perform public.expirar_holds();
    perform pg_temp.chk((select status from public.facility_reservations where id = v_id) = 'pending_reconciliation', 'E3 hold vencido con pago parcial = pending_reconciliation (no expired)');
    perform pg_temp.chk((select amount_paid from public.facility_reservations where id = v_id) = 20000, 'E3 la plata del parcial no se pierde');
    perform pg_temp.chk(not exists (select 1 from public.facility_occupancy where source_kind = 'rental' and source_id = v_id and status in ('active', 'hold')), 'E3 la franja queda libre');
    -- otra persona puede tomar la franja
    perform pg_temp.as_user(current_setting('qa.ext')::uuid);
    r3 := public.reservar_cancha(current_setting('qa.fa')::uuid, pg_temp.slot(current_setting('qa.dia2'), '15:00'), pg_temp.slot(current_setting('qa.dia2'), '16:00'), 'public', 'qx-key-parcial-0002');
    perform pg_temp.as_service();
    perform pg_temp.chk((r3->>'ok')::boolean, 'E3 otro usuario toma la franja liberada (' || coalesce(r3->>'error', 'ok') || ')');
  end if;
end $$;

-- ══ E4. anon / authenticated sin EXECUTE en las RPC; anon sin acceso a las tablas nuevas ═
do $$
declare f text; v_n int; t text;
begin
  -- Matriz de EXECUTE (catálogo, sin ejecutar nada)
  foreach f in array array[
      'public.reservar_cancha(uuid,timestamptz,timestamptz,text,text,text,uuid,uuid,uuid,jsonb,text,integer,text,text,numeric,text)',
      'public.cancelar_reserva(uuid,text,uuid,uuid)',
      'public.reprogramar_reserva(uuid,timestamptz,timestamptz,uuid,uuid,uuid)',
      'public.disponibilidad_canchas(uuid,date,date,text,uuid,integer,text,uuid)',
      'public.confirmar_pago_reserva(text,numeric,uuid,text,text)',
      'public.expirar_holds()',
      'public.get_facility_availability(uuid,date)',
      'public.occupancy_backfill_reservas_y_clases()'] loop
    perform pg_temp.chk(not has_function_privilege('anon', f::regprocedure, 'EXECUTE'), 'E4 anon sin EXECUTE en ' || split_part(f, '(', 1));
  end loop;
  foreach f in array array[
      'public.confirmar_pago_reserva(text,numeric,uuid,text,text)',
      'public.expirar_holds()',
      'public.get_facility_availability(uuid,date)',
      'public.occupancy_backfill_reservas_y_clases()'] loop
    perform pg_temp.chk(not has_function_privilege('authenticated', f::regprocedure, 'EXECUTE'), 'E4 authenticated sin EXECUTE en ' || split_part(f, '(', 1) || ' (solo service_role)');
  end loop;
  -- ningún helper interno es ejecutable por anon ni authenticated
  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace and (p.proname like '\_reservas\_%' or p.proname like 'fn\_facility\_%')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  perform pg_temp.chk(v_n = 0, 'E4 los helpers _reservas_* y fn_facility_* no son ejecutables por anon/authenticated (' || v_n || ' expuestos)');

  -- Llamada real como anon: permission denied en cada RPC
  execute 'set local role anon';
  begin perform public.reservar_cancha(current_setting('qa.fa')::uuid, now(), now() + interval '1 hour', 'public', 'qx-anon-0001'); raise exception 'FALLO: anon ejecutó reservar_cancha';
  exception when insufficient_privilege then null; end;
  begin perform public.cancelar_reserva(gen_random_uuid(), 'x'); raise exception 'FALLO: anon ejecutó cancelar_reserva';
  exception when insufficient_privilege then null; end;
  begin perform public.reprogramar_reserva(gen_random_uuid(), now(), now() + interval '1 hour'); raise exception 'FALLO: anon ejecutó reprogramar_reserva';
  exception when insufficient_privilege then null; end;
  begin perform public.disponibilidad_canchas(current_setting('qa.sa')::uuid, current_date, current_date); raise exception 'FALLO: anon ejecutó disponibilidad_canchas';
  exception when insufficient_privilege then null; end;
  begin perform public.confirmar_pago_reserva('RSV-0000000000000000', 1, null, 'x', 'e'); raise exception 'FALLO: anon ejecutó confirmar_pago_reserva';
  exception when insufficient_privilege then null; end;
  begin perform public.expirar_holds(); raise exception 'FALLO: anon ejecutó expirar_holds';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  perform pg_temp.chk(true, 'E4 anon: permission denied en las 6 RPC (llamada real)');

  -- authenticated tampoco puede las dos de servicio
  perform pg_temp.as_user(current_setting('qa.p1')::uuid);
  begin perform public.confirmar_pago_reserva('RSV-0000000000000000', 1, null, 'x', 'e'); raise exception 'FALLO: authenticated ejecutó confirmar_pago_reserva';
  exception when insufficient_privilege then null; end;
  begin perform public.expirar_holds(); raise exception 'FALLO: authenticated ejecutó expirar_holds';
  exception when insufficient_privilege then null; end;
  perform pg_temp.as_service();
  perform pg_temp.chk(true, 'E4 authenticated: permission denied en confirmar_pago_reserva y expirar_holds (llamada real)');

  -- Tablas nuevas: anon sin privilegios de escritura ni TRUNCATE; lectura = denegada o 0 filas
  foreach t in array array['facility_occupancy', 'facility_rates', 'facility_blackouts', 'cancellation_policies', 'co_holidays', 'guest_bookers'] loop
    perform pg_temp.chk(not has_table_privilege('anon', ('public.' || t)::regclass, 'INSERT')
                    and not has_table_privilege('anon', ('public.' || t)::regclass, 'UPDATE')
                    and not has_table_privilege('anon', ('public.' || t)::regclass, 'DELETE')
                    and not has_table_privilege('anon', ('public.' || t)::regclass, 'TRUNCATE'), 'E4 anon sin escritura/TRUNCATE en ' || t);
    perform pg_temp.chk(not has_table_privilege('authenticated', ('public.' || t)::regclass, 'TRUNCATE'), 'E4 authenticated sin TRUNCATE en ' || t);
    begin
      execute 'set local role anon';
      execute 'select count(*) from public.' || quote_ident(t) into v_n;
      execute 'reset role';
      perform pg_temp.chk(v_n = 0, 'E4 anon: select count(*) de ' || t || ' = 0 (RLS)');
    exception when insufficient_privilege then
      execute 'reset role';
      raise notice 'OK: E4 anon: permission denied al leer %', t;
    end;
  end loop;
  perform pg_temp.chk((select count(*) from public.facility_occupancy) > 0, 'E4 (control) como dueño sí hay filas en facility_occupancy: el 0 de anon no es tabla vacía');
end $$;

-- ══ E5. Staff de la escuela A contra la reserva de B ══════════════════════════════
do $$
declare r jsonb; r_b jsonb; v_id_b uuid; v_n int;
begin
  -- una reserva en la cancha de B (por el externo), para atacarla desde el staff de A
  perform pg_temp.as_user(current_setting('qa.ext')::uuid);
  r_b := public.reservar_cancha(current_setting('qa.fb')::uuid, pg_temp.slot(current_setting('qa.dia'), '16:00'), pg_temp.slot(current_setting('qa.dia'), '17:00'), 'public', 'qx-key-b-0001');
  perform pg_temp.as_service();
  perform pg_temp.chk((r_b->>'ok')::boolean, 'E5 reserva en la cancha de B (' || coalesce(r_b->>'error', 'ok') || ')');
  v_id_b := (r_b->'reservation'->>'id')::uuid;

  perform pg_temp.as_user(current_setting('qa.sta')::uuid);
  r := public.cancelar_reserva(v_id_b, 'intento ajeno');
  perform pg_temp.chk(r->>'error' = 'FORBIDDEN', 'E5 staff de A no cancela la reserva de B (FORBIDDEN)');
  r := public.reprogramar_reserva(v_id_b, pg_temp.slot(current_setting('qa.dia'), '18:00'), pg_temp.slot(current_setting('qa.dia'), '19:00'));
  perform pg_temp.chk(r->>'error' = 'FORBIDDEN', 'E5 staff de A no reprograma la reserva de B (' || coalesce(r->>'error', 'ok') || ')');
  r := public.reservar_cancha(current_setting('qa.fb')::uuid, pg_temp.slot(current_setting('qa.dia'), '20:00'), pg_temp.slot(current_setting('qa.dia'), '21:00'), 'admin', 'qx-key-b-0002', 'cash');
  perform pg_temp.chk(r->>'error' = 'CHANNEL_NOT_ALLOWED', 'E5 staff de A no reserva como admin en la cancha de B (' || coalesce(r->>'error', 'ok') || ')');
  v_n := pg_temp.visibles('facility_reservations', current_setting('qa.sb')::uuid);
  perform pg_temp.chk(v_n = 0, 'E5 staff de A no lee reservas de B (RLS)');
  v_n := pg_temp.visibles('facility_occupancy', current_setting('qa.sb')::uuid);
  perform pg_temp.chk(v_n = 0, 'E5 staff de A no lee la ocupación de B (RLS)');
  v_n := pg_temp.visibles('facility_blackouts', current_setting('qa.sb')::uuid);
  perform pg_temp.chk(v_n = 0, 'E5 staff de A no lee bloqueos de B (RLS)');
  begin
    insert into public.facility_blackouts (school_id, facility_id, starts_at, ends_at, reason)
    values (current_setting('qa.sa')::uuid, current_setting('qa.fb')::uuid, now() + interval '5 days', now() + interval '5 days 2 hours', 'ataque');
    raise exception 'FALLO: staff de A creó un bloqueo en la cancha de B';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    update public.cancellation_policies set hours_full_refund = 0 where school_id = current_setting('qa.sb')::uuid;
    get diagnostics v_n = row_count;
    perform pg_temp.chk(v_n = 0, 'E5 staff de A no edita políticas de B');
  exception when insufficient_privilege then null; end;
  perform pg_temp.as_service();
  perform pg_temp.chk((select status from public.facility_reservations where id = v_id_b) = 'pending_payment', 'E5 la reserva de B quedó intacta');
end $$;

-- ══ E6. Invariantes I1–I5 / I7 sobre los objetos nuevos ═══════════════════════════
do $$
declare v_n int; v_det text;
begin
  select count(*), string_agg(invariante || ':' || objeto, ', ') into v_n, v_det
    from public.invariantes_seguridad()
   where objeto ~ '(facility_(occupancy|rates|blackouts|reservations|availability|child|resv)|facilities|cancellation_polic|co_holidays|guest_bookers|_reservas_|reservar_cancha|cancelar_reserva|reprogramar_reserva|confirmar_pago_reserva|disponibilidad_canchas|expirar_holds|occupancy_backfill|get_facility_availability|handle_new_user|schools_school_type|guard_school_type|school_type)';
  perform pg_temp.chk(v_n = 0, 'E6 invariantes_seguridad(): 0 violaciones sobre objetos de reservas' || coalesce(' — ' || v_det, ''));

  -- I3 explícito: ninguna policy FOR ALL sin WITH CHECK en las tablas de reservas
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and cmd = 'ALL' and with_check is null
     and tablename in ('facility_occupancy', 'facility_rates', 'facility_blackouts', 'cancellation_policies', 'co_holidays', 'guest_bookers', 'facilities', 'facility_reservations');
  perform pg_temp.chk(v_n = 0, 'E6 I3: ninguna policy FOR ALL sin WITH CHECK en las tablas de reservas');

  -- I2 explícito: policies de ESCRITURA de las tablas nuevas no usan user_school_ids() (familia)
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     and tablename in ('facility_occupancy', 'facility_rates', 'facility_blackouts', 'cancellation_policies', 'co_holidays', 'guest_bookers')
     and (coalesce(qual, '') ~ 'user_school_ids' or coalesce(with_check, '') ~ 'user_school_ids');
  perform pg_temp.chk(v_n = 0, 'E6 I2: ninguna policy de escritura de las tablas nuevas usa user_school_ids()');

  -- I4 explícito: todas las SECURITY DEFINER del módulo fijan search_path
  select count(*), string_agg(proname, ', ') into v_n, v_det from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and (p.proname like '\_reservas\_%' or p.proname like 'fn\_facility\_%' or p.proname in ('reservar_cancha', 'cancelar_reserva', 'reprogramar_reserva', 'confirmar_pago_reserva', 'disponibilidad_canchas', 'expirar_holds', 'get_facility_availability', 'occupancy_backfill_reservas_y_clases'))
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  perform pg_temp.chk(v_n = 0, 'E6 I4: SECURITY DEFINER del módulo con search_path fijo' || coalesce(' — faltan: ' || v_det, ''));

  -- I1 explícito: ninguna tabla nueva alcanzable por anon con USING(true)
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename in ('facility_occupancy', 'facility_rates', 'facility_blackouts', 'cancellation_policies', 'co_holidays', 'guest_bookers')
     and (roles::text[] && array['public', 'anon']) and has_table_privilege('anon', ('public.' || tablename)::regclass, 'SELECT');
  perform pg_temp.chk(v_n = 0, 'E6 I1: ninguna tabla nueva legible por anon (policy + GRANT)');
end $$;

-- ══ E7. Flujo VIEJO: solicitud 'pending' directa + aprobación del admin ═══════════
do $$
declare v_id uuid; v_id2 uuid; r jsonb; v_n int; v_price numeric; v_st text;
begin
  -- AJUSTE cierre de seguridad: tras 20261105213611 (revoca la escritura directa) este flujo viejo ya no existe;
  -- el chequeo equivalente (42501 + RPC funcionando) vive en seguridad-cierre/04-reservas-revocar-escritura.sql.
  if not has_table_privilege('authenticated', 'public.facility_reservations', 'INSERT') then
    raise notice 'E7 omitida: la escritura directa ya fue revocada (20261105213611)'; return;
  end if;
  -- el padre inserta DIRECTO (como lo hace el frontend de hoy) una solicitud, intentando colar status/precio
  perform pg_temp.as_user(current_setting('qa.p1')::uuid);
  insert into public.facility_reservations (facility_id, user_id, reservation_date, start_time, end_time, status, price, amount_paid, payment_status)
  values (current_setting('qa.fa')::uuid, current_setting('qa.p1')::uuid, current_setting('qa.dia')::date, '08:00', '09:00', 'confirmed', 0, 99999, 'paid')
  returning id into v_id;
  perform pg_temp.as_service();
  select status, price into v_st, v_price from public.facility_reservations where id = v_id;
  perform pg_temp.chk(v_st = 'pending' and v_price > 0, 'E7 la guarda fuerza status=pending y recalcula el precio (status=' || v_st || ', price=' || v_price || ')');
  perform pg_temp.chk((select amount_paid from public.facility_reservations where id = v_id) = 0, 'E7 la guarda anula el amount_paid autoasignado');

  -- ocupa la franja (trigger AFTER → facility_occupancy)
  perform pg_temp.chk(exists (select 1 from public.facility_occupancy where source_kind = 'rental' and source_id = v_id and status = 'active'), 'E7 la solicitud pending escribe su ocupación activa');

  -- otro intento por el camino nuevo sobre la misma franja: SLOT_TAKEN
  perform pg_temp.as_user(current_setting('qa.p2')::uuid);
  r := public.reservar_cancha(current_setting('qa.fa')::uuid, pg_temp.slot(current_setting('qa.dia'), '08:00'), pg_temp.slot(current_setting('qa.dia'), '09:00'), 'app', 'qx-key-old-0001');
  perform pg_temp.as_service();
  perform pg_temp.chk(r->>'error' = 'SLOT_TAKEN', 'E7 la solicitud vieja bloquea la franja para el motor nuevo (' || coalesce(r->>'error', 'ok') || ')');

  -- y otro insert directo que se cruce: lo rechaza el trigger viejo / el EXCLUDE
  begin
    perform pg_temp.as_user(current_setting('qa.p2')::uuid);
    insert into public.facility_reservations (facility_id, user_id, reservation_date, start_time, end_time)
    values (current_setting('qa.fa')::uuid, current_setting('qa.p2')::uuid, current_setting('qa.dia')::date, '08:30', '09:30');
    perform pg_temp.as_service();
    raise exception 'FALLO: dos solicitudes directas cruzadas coexisten';
  exception when exclusion_violation then perform pg_temp.as_service(); raise notice 'OK: E7 solicitud directa cruzada rechazada (23P01)'; end;

  -- el admin la aprueba (UPDATE status=confirmed, como hoy)
  perform pg_temp.as_user(current_setting('qa.oa')::uuid);
  update public.facility_reservations set status = 'confirmed', approved_by = current_setting('qa.oa')::uuid, approved_at = now() where id = v_id;
  get diagnostics v_n = row_count;
  perform pg_temp.as_service();
  perform pg_temp.chk(v_n = 1 and (select status from public.facility_reservations where id = v_id) = 'confirmed', 'E7 el admin aprueba la solicitud (pending → confirmed)');
  perform pg_temp.chk(exists (select 1 from public.facility_occupancy where source_kind = 'rental' and source_id = v_id and status = 'active'), 'E7 tras la aprobación la franja sigue ocupada');

  -- el padre NO puede aprobar su propia solicitud
  perform pg_temp.as_user(current_setting('qa.p1')::uuid);
  insert into public.facility_reservations (facility_id, user_id, reservation_date, start_time, end_time)
  values (current_setting('qa.fa')::uuid, current_setting('qa.p1')::uuid, current_setting('qa.dia')::date, '09:00', '10:00') returning id into v_id2;
  begin
    update public.facility_reservations set status = 'confirmed' where id = v_id2;
    perform pg_temp.as_service();
    raise exception 'FALLO: el padre aprobó su propia solicitud';
  exception when insufficient_privilege then perform pg_temp.as_service(); raise notice 'OK: E7 el padre no autoaprueba (forbidden_status)'; end;

  -- el padre cancela la suya (pending → cancelled) y la franja se libera
  perform pg_temp.as_user(current_setting('qa.p1')::uuid);
  update public.facility_reservations set status = 'cancelled' where id = v_id2;
  perform pg_temp.as_service();
  perform pg_temp.chk((select status from public.facility_reservations where id = v_id2) = 'cancelled', 'E7 el padre cancela su solicitud pending');
  perform pg_temp.chk(not exists (select 1 from public.facility_occupancy where source_kind = 'rental' and source_id = v_id2 and status in ('active', 'hold')), 'E7 cancelar la solicitud libera la franja');
end $$;

-- ══ E8. Gate de entitlement de submit_facility_booking_v2 (20261105163329) ═════════
do $$
declare
  v_oc uuid := pg_temp.mk_user('qx.own.c@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_mem uuid := pg_temp.mk_user('qx.mem.c@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_xt uuid := pg_temp.mk_user('qx.ext.c@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_sc uuid := gen_random_uuid(); v_fc uuid := gen_random_uuid(); r jsonb;
begin
  -- AJUSTE cierre de seguridad: 20261105213611 quita EXECUTE de submit_facility_booking_v2 a authenticated.
  if not has_function_privilege('authenticated', 'public.submit_facility_booking_v2(uuid,uuid,date,time,time,text,text,text,integer,text,numeric,text,text)'::regprocedure, 'EXECUTE') then
    raise notice 'E8 omitida: submit_facility_booking_v2 ya no es ejecutable por authenticated (20261105213611)'; return;
  end if;
  -- escuela NORMAL (no venue) sin el addon 'reservations'
  insert into public.schools (id, name, owner_id) values (v_sc, 'QX Escuela C sin addon', v_oc);
  insert into public.school_members (school_id, profile_id, role, status) values (v_sc, v_mem, 'parent', 'active') on conflict do nothing;
  insert into public.facilities (id, school_id, name, type, capacity, hourly_rate, rental_rate, rental_enabled, booking_enabled)
  values (v_fc, v_sc, 'QX Cancha C', 'futbol', 10, 70000, 90000, true, true);
  perform pg_temp.chk(not coalesce(public.has_entitlement(v_sc, 'reservations'), false), 'E8 setup: la escuela C no tiene el entitlement');

  perform pg_temp.as_user(v_xt);
  r := public.submit_facility_booking_v2(v_sc, v_fc, current_setting('qa.dia')::date, '10:00', '11:00', 'external', 'rental', 'Org X');
  perform pg_temp.as_service();
  perform pg_temp.chk(r->>'error' = 'entitlement_required', 'E8 sin addon: un externo no alquila (' || coalesce(r->>'error', 'ok') || ')');

  perform pg_temp.as_user(v_mem);
  r := public.submit_facility_booking_v2(v_sc, v_fc, current_setting('qa.dia')::date, '10:00', '11:00', 'parent', 'rental');
  perform pg_temp.chk(r->>'error' = 'entitlement_required', 'E8 sin addon: ni el miembro alquila (rental) (' || coalesce(r->>'error', 'ok') || ')');
  r := public.submit_facility_booking_v2(v_sc, v_fc, current_setting('qa.dia')::date, '10:00', '11:00', 'parent', 'internal');
  perform pg_temp.as_service();
  perform pg_temp.chk((r->>'ok')::boolean, 'E8 sin addon: el miembro SÍ solicita uso interno como hoy (' || coalesce(r->>'error', 'ok') || ')');

  -- el mismo horario ya está tomado (solicitud pending) → time_conflict
  perform pg_temp.as_user(v_mem);
  r := public.submit_facility_booking_v2(v_sc, v_fc, current_setting('qa.dia')::date, '10:30', '11:30', 'parent', 'internal');
  perform pg_temp.as_service();
  perform pg_temp.chk(r->>'error' = 'time_conflict', 'E8 choque con una solicitud vigente = time_conflict (' || coalesce(r->>'error', 'ok') || ')');

  -- con el addon, el alquiler a externos vuelve a funcionar
  insert into public.school_addons (school_id, addon_key, enabled) values (v_sc, 'reservations', true);
  perform pg_temp.chk(public.has_entitlement(v_sc, 'reservations'), 'E8 con addon: has_entitlement = true');
  perform pg_temp.as_user(v_xt);
  r := public.submit_facility_booking_v2(v_sc, v_fc, current_setting('qa.dia')::date, '14:00', '15:00', 'external', 'rental', 'Org X');
  perform pg_temp.as_service();
  perform pg_temp.chk((r->>'ok')::boolean, 'E8 con addon: el externo alquila (' || coalesce(r->>'error', 'ok') || ')');

  -- la v1 (8 args) ya no es ejecutable por usuarios
  perform pg_temp.chk(not has_function_privilege('authenticated', 'public.submit_facility_booking(uuid,uuid,date,time,time,integer,text,text)'::regprocedure, 'EXECUTE')
                      and not has_function_privilege('anon', 'public.submit_facility_booking(uuid,uuid,date,time,time,integer,text,text)'::regprocedure, 'EXECUTE'), 'E8 submit_facility_booking v1 sin EXECUTE para anon/authenticated');
  perform pg_temp.chk(not exists (select 1 from pg_proc where oid = 'public.submit_facility_booking_v2(uuid,uuid,date,time,time,text,text,text,integer,text,numeric,text,text)'::regprocedure and not coalesce(proconfig, '{}') && array['search_path=pg_catalog, public, pg_temp']), 'E8 v2 con search_path fijo');
end $$;

rollback;
