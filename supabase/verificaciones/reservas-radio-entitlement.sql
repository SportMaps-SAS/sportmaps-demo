-- =============================================================================
-- Radio de las migraciones de reservas F1. SOLO LECTURA, filtrado por nombre
-- (nada de listar el catálogo: regla de Disk IO). Correr UNA consulta a la vez:
--   npx supabase db query --linked "<consulta>"   (la base es una sola: dev=stg=prod)
-- R1-R2 son el radio de 20261105163329_reservas_gate_entitlement_submit_v2 (NO APLICAR hasta medir radio).
-- El resto mide M1, M4, M6 y el registro de dueños de espacios.
-- =============================================================================

-- R1. Canchas con rental_enabled=true cuyas escuelas NO tienen el entitlement 'reservations'.
--     Esas son las que el gate de submit_facility_booking_v2 deja sin alquiler a externos.
select s.id as school_id, s.name, s.school_type,
       count(*) filter (where f.rental_enabled) as canchas_rental,
       count(*) as canchas_total
  from public.facilities f
  join public.schools s on s.id = f.school_id
 where f.rental_enabled = true
   and not public.has_entitlement(s.id, 'reservations')
 group by s.id, s.name, s.school_type
 order by canchas_rental desc;

-- R2. ¿Esas escuelas tienen alquileres reales? (últimos 120 días y futuras)
select s.id as school_id, s.name,
       count(*) filter (where r.resv_type = 'rental') as alquileres,
       count(*) filter (where r.booker_type = 'external') as externos,
       count(*) filter (where r.starts_at > now()) as futuras,
       max(r.created_at) as ultima
  from public.facility_reservations r
  join public.facilities f on f.id = r.facility_id
  join public.schools s on s.id = f.school_id
 where f.rental_enabled = true
   and not public.has_entitlement(s.id, 'reservations')
   and (r.created_at > now() - interval '120 days' or r.starts_at > now())
 group by s.id, s.name;

-- R3. Escuelas que SÍ tienen el addon 'reservations'.
select a.school_id, s.name, s.school_type, a.enabled
  from public.school_addons a join public.schools s on s.id = a.school_id
 where a.addon_key = 'reservations';

-- R4. booking_enabled: true / false / NULL (el NULL se trata como true).
select booking_enabled, count(*) from public.facilities group by 1;

-- R5. Vista previa del backfill de bookable_by (rental_enabled=true -> 'both', resto 'members').
select rental_enabled, count(*) from public.facilities group by 1;

-- R6. Menores: atletas sin fecha de nacimiento y con ficha ligada a acudiente
--     (los que _reservas_es_menor trataría como menores), y menores por fecha.
select count(*) filter (where p.date_of_birth is null) as sin_fecha,
       count(*) filter (where p.date_of_birth is null and exists (
         select 1 from public.unregistered_athletes u
          where u.linked_profile_id = p.id
            and (u.guardian_full_name is not null or u.guardian_email is not null or u.guardian_phone is not null))) as sin_fecha_con_acudiente,
       count(*) filter (where p.date_of_birth > current_date - interval '18 years') as menores_por_fecha
  from public.profiles p
 where p.role = 'athlete';

-- R7. M6: clases futuras con cancha que se cruzan entre sí (la segunda NO quedaría marcada).
select a.facility_id, count(*) as pares_cruzados
  from public.attendance_sessions a
  join public.attendance_sessions b
    on b.facility_id = a.facility_id and b.session_date = a.session_date and b.id > a.id
   and a.start_time < b.end_time and b.start_time < a.end_time
 where a.session_date >= current_date - 1 and a.facility_id is not null
 group by a.facility_id order by 2 desc;

-- R8. M6: candidatas del backfill (clases con cancha) y reservas vigentes.
select (select count(*) from public.attendance_sessions
         where facility_id is not null and start_time is not null and end_time > start_time and session_date >= current_date - 1) as clases_candidatas,
       (select count(*) from public.facility_reservations
         where ends_at > now() and status not in ('cancelled','expired','pending_reconciliation')) as reservas_vigentes;

-- R9. Policies de facility_reservations (las de M0 + las de siempre).
select policyname, cmd, roles, with_check is not null as tiene_with_check
  from pg_policies where tablename = 'facility_reservations' order by cmd, policyname;

-- R10. El índice recreado (sin expired/pending_reconciliation) no debe chocar con datos vivos: 0 filas.
select facility_id, reservation_date, start_time, count(*)
  from public.facility_reservations
 where status in ('pending','confirmed','completed','no_show')
 group by 1,2,3 having count(*) > 1;

-- R11. Instalaciones sin school_id (el trigger de tarifas/blackouts las rechazaría).
select count(*) from public.facilities where school_id is null;

-- R12. Registro de dueños: ¿cuántas escuelas ya son venue?
select school_type, count(*) from public.schools where school_type = 'venue' group by 1;
