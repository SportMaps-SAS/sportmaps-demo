-- Fase 2 del uso por pantalla/botón: lectura para el admin de plataforma.
--
-- Agrega en el servidor (no se traen filas al navegador). El gate es INTERNO:
-- is_platform_admin(), no un "¿es admin de alguna escuela?". Tope de 90 días y se llama
-- a demanda desde /admin/uso, sin refresco automático (Disk IO de la base compartida).
--
-- Devuelve un jsonb con: usuarios, por_modo, por_rol, por_dia, por_escuela (solo sin filtro
-- de escuela), top_pantallas, top_botones, api y errores_api. Formato de claves de
-- counters en 20261117115141_ui_usage_daily.sql.

create or replace function public.admin_ui_usage_resumen(
  p_days     int     default 30,
  p_school   uuid    default null,
  p_internos boolean default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_days  int  := greatest(1, least(coalesce(p_days, 30), 90));
  v_desde date := (now() at time zone 'America/Bogota')::date - (greatest(1, least(coalesce(p_days, 30), 90)) - 1);
  r       jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with base as materialized (
    select * from public.ui_usage_daily u
     where u.day >= v_desde
       and (p_school is null or u.school_id = p_school)
       and (p_internos or not u.is_internal)
  ),
  kv as materialized (
    select b.user_id, b.school_id, b.role, b.display_mode, b.day, e.key as k, e.value::int as v
      from base b, jsonb_each_text(b.counters) e
  ),
  api as materialized (
    select split_part(substr(k, 3), ' ', 1)        as metodo,
           split_part(substr(k, 3), ' ', 2)        as ruta,
           split_part(substr(k, 3), ' ', 3)::int   as estado,
           user_id, v
      from kv where k like 'a:%'
  )
  select jsonb_build_object(
    'desde', v_desde,
    'dias', v_days,
    'usuarios', (select count(distinct user_id) from base),
    'por_modo', (
      select coalesce(jsonb_agg(x order by x->>'display_mode'), '[]'::jsonb) from (
        select jsonb_build_object(
                 'display_mode', display_mode,
                 'usuarios', count(distinct user_id),
                 'sesiones', coalesce(sum(v) filter (where k = 'sess'), 0)) x
          from kv group by display_mode) t),
    'por_rol', (
      select coalesce(jsonb_agg(x order by (x->>'usuarios')::int desc), '[]'::jsonb) from (
        select jsonb_build_object(
                 'rol', coalesce(role, 'sin_escuela'),
                 'usuarios', count(distinct user_id),
                 'usuarios_app', count(distinct user_id) filter (where display_mode <> 'browser'),
                 'sesiones', coalesce(sum(v) filter (where k = 'sess'), 0)) x
          from kv group by coalesce(role, 'sin_escuela')) t),
    'por_dia', (
      select coalesce(jsonb_agg(x order by x->>'dia'), '[]'::jsonb) from (
        select jsonb_build_object(
                 'dia', day,
                 'usuarios', count(distinct user_id),
                 'sesiones', coalesce(sum(v) filter (where k = 'sess'), 0)) x
          from kv group by day) t),
    'por_escuela', case when p_school is not null then '[]'::jsonb else (
      select coalesce(jsonb_agg(x order by (x->>'usuarios')::int desc), '[]'::jsonb) from (
        select jsonb_build_object(
                 'school_id', kv.school_id,
                 'escuela', coalesce(s.name, '(sin escuela)'),
                 'usuarios', count(distinct kv.user_id),
                 'usuarios_app', count(distinct kv.user_id) filter (where kv.display_mode <> 'browser'),
                 'sesiones', coalesce(sum(kv.v) filter (where kv.k = 'sess'), 0)) x
          from kv left join public.schools s on s.id = kv.school_id
         group by kv.school_id, s.name
         order by count(distinct kv.user_id) desc limit 40) t) end,
    'top_pantallas', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select jsonb_build_object('pantalla', substr(k, 3), 'vistas', sum(v), 'usuarios', count(distinct user_id)) x
          from kv where k like 'v:%' group by k order by sum(v) desc limit 40) t),
    'top_botones', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select jsonb_build_object(
                 'pantalla', split_part(substr(k, 3), '|', 1),
                 'boton', split_part(substr(k, 3), '|', 2),
                 'clics', sum(v), 'usuarios', count(distinct user_id)) x
          from kv where k like 'c:%' group by k order by sum(v) desc limit 50) t),
    'api', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select jsonb_build_object('metodo', metodo, 'ruta', ruta, 'estado', estado,
                                  'llamadas', sum(v), 'usuarios', count(distinct user_id)) x
          from api group by metodo, ruta, estado order by sum(v) desc limit 60) t),
    'errores_api', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select jsonb_build_object('metodo', metodo, 'ruta', ruta, 'estado', estado,
                                  'llamadas', sum(v), 'usuarios', count(distinct user_id)) x
          from api where estado = 0 or estado >= 400
         group by metodo, ruta, estado order by sum(v) desc limit 40) t)
  ) into r;

  return r;
end;
$$;

-- El gate está adentro (is_platform_admin). authenticated necesita EXECUTE para poder
-- llamarla; anon no.
revoke all on function public.admin_ui_usage_resumen(int, uuid, boolean) from public, anon;
grant execute on function public.admin_ui_usage_resumen(int, uuid, boolean) to authenticated;
