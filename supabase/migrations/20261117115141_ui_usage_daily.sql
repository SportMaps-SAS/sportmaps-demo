-- Uso por pantalla y botón, agregado por usuario y día.
--
-- Por qué una tabla nueva y no `analytics_events`: esa tabla no tiene school_id y su
-- INSERT acepta filas con user_id NULL (cualquiera, incluso `anon`, la puede llenar).
-- Se deja como está; esta es la que se usa.
--
-- Por qué agregada: un evento por clic serían ~2 M de filas/mes en la base compartida
-- (ver "Disk IO de la base" en CLAUDE.md). El navegador acumula contadores y manda
-- uno por usuario y día; el BFF los suma con la función de abajo (~600 filas/día).
--
-- Claves de `counters` (prefijo : valor):
--   sess                       → sesiones (cargas de la app)
--   v:<ruta normalizada>       → pantalla vista
--   c:<ruta>|<botón>           → clic en un botón (data-track o verbo de acción)
--   a:<MÉTODO> <ruta> <código> → resultado de una llamada al BFF (201, 403, 409, 0 = sin red)
-- Nunca se guardan nombres, textos libres ni ids.

create table if not exists public.ui_usage_daily (
  id           uuid primary key default gen_random_uuid(),
  day          date not null,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  school_id    uuid,
  role         text,
  display_mode text not null check (display_mode in ('browser', 'standalone', 'native')),
  app_version  text,
  is_internal  boolean not null default false,
  counters     jsonb not null default '{}'::jsonb check (jsonb_typeof(counters) = 'object'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists ui_usage_daily_uniq
  on public.ui_usage_daily (user_id, day, display_mode, (coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid)));
create index if not exists ui_usage_daily_school_day on public.ui_usage_daily (school_id, day);

alter table public.ui_usage_daily enable row level security;

-- Solo lectura para el admin de plataforma. Nadie escribe desde el cliente: lo hace el BFF
-- con service_role a través de track_ui_usage().
drop policy if exists ui_usage_daily_select_admin on public.ui_usage_daily;
create policy ui_usage_daily_select_admin on public.ui_usage_daily
  for select to authenticated using (public.is_platform_admin());

revoke all on public.ui_usage_daily from public, anon, authenticated;
grant select on public.ui_usage_daily to authenticated;

-- Suma los contadores recibidos a los del día. El rol y la escuela NO se confían al cliente:
-- se resuelven aquí contra school_members (si el usuario no es miembro de p_school_hint,
-- school_id y role quedan NULL).
create or replace function public.track_ui_usage(
  p_user_id     uuid,
  p_school_hint uuid,
  p_mode        text,
  p_version     text,
  p_internal    boolean,
  p_counters    jsonb
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_school uuid;
  v_role   text;
begin
  if p_user_id is null or p_counters is null or jsonb_typeof(p_counters) <> 'object' then
    return;
  end if;
  if p_mode not in ('browser', 'standalone', 'native') then
    return;
  end if;

  if p_school_hint is not null then
    select sm.school_id, sm.role
      into v_school, v_role
      from public.school_members sm
     where sm.profile_id = p_user_id
       and sm.school_id  = p_school_hint
       and sm.status     = 'active'
     limit 1;
  end if;

  insert into public.ui_usage_daily as t
    (day, user_id, school_id, role, display_mode, app_version, is_internal, counters)
  values
    ((now() at time zone 'America/Bogota')::date, p_user_id, v_school, v_role, p_mode,
     left(p_version, 64), coalesce(p_internal, false), p_counters)
  on conflict (user_id, day, display_mode, (coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  do update set
    counters = (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
        from (
          select k, sum(v)::int as v
            from (
              select key as k, value::int as v from jsonb_each_text(t.counters)
              union all
              select key, value::int from jsonb_each_text(excluded.counters)
            ) u
           group by k
        ) s
    ),
    role        = coalesce(excluded.role, t.role),
    app_version = coalesce(excluded.app_version, t.app_version),
    is_internal = t.is_internal or excluded.is_internal,
    updated_at  = now();
end;
$$;

-- Solo la ejecuta el BFF (service_role). authenticated/anon NO: si pudieran, cualquiera
-- escribiría contadores a nombre de otro usuario.
revoke all on function public.track_ui_usage(uuid, uuid, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.track_ui_usage(uuid, uuid, text, text, boolean, jsonb) to service_role;

comment on table public.ui_usage_daily is
  'Uso por pantalla/botón agregado por usuario y día. Lo escribe el BFF vía track_ui_usage(); ver cabecera de la migración 20261117115141.';
