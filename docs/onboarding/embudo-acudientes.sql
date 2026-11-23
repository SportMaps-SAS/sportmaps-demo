-- ============================================================================
-- Embudo de ACUDIENTES (sección 1.4 del análisis) con analytics_events.
-- SOLO LECTURA:
--     npx supabase db query --remote --read-only -f docs/onboarding/embudo-acudientes.sql -o json
--
-- Cohorte: cuentas con rol «parent» cuyo signup_completed cae en la ventana.
-- Un paso cuenta una vez por cuenta, si ocurrió DESPUÉS de registrarse.
--
-- Lo que estos 10 eventos NO miden del acudiente (se agrega en la Etapa 3, con los
-- eventos de solicitud de unión): vinculado a una escuela, deportista visible,
-- cobro visible. Hasta entonces se pueden contar a mano con school_members y
-- school_join_requests (ver la sección 1.3 del análisis).
--
-- Edita SOLO la CTE `params`. Fechas en hora de Bogotá (-05).
-- ============================================================================
with params as (
    select timestamptz '2026-11-19 00:00:00-05' as desde,   -- inclusive
           timestamptz '2026-11-23 00:00:00-05' as hasta    -- exclusive
),
cohorte as (
    select e.user_id, min(e.created_at) as registro
      from public.analytics_events e, params p
     where e.event_type = 'signup_completed'
       and e.event_data ->> 'role' = 'parent'
       and e.created_at >= p.desde and e.created_at < p.hasta
       and e.user_id is not null
     group by e.user_id
),
por_cuenta as (
    select c.user_id,
           coalesce(bool_or(e.event_type = 'onboarding_step_viewed'    and e.event_data ->> 'flow' = 'parent'), false) as vio_asistente,
           coalesce(bool_or(e.event_type = 'onboarding_step_completed' and e.event_data ->> 'flow' = 'parent' and e.event_data ->> 'step' = 'datos'), false) as datos,
           coalesce(bool_or(e.event_type = 'onboarding_finished'       and e.event_data ->> 'flow' = 'parent'), false) as asistente_terminado
      from cohorte c
      left join public.analytics_events e
             on e.user_id = c.user_id and e.created_at >= c.registro
     group by c.user_id
),
pasos as (
    select 1 as orden, 'Cuenta creada'      as paso, count(*)                                     as n from por_cuenta
    union all select 2, 'Vio el asistente',      count(*) filter (where vio_asistente)       from por_cuenta
    union all select 3, 'Datos completados',     count(*) filter (where datos)               from por_cuenta
    union all select 4, 'Asistente terminado',   count(*) filter (where asistente_terminado) from por_cuenta
)
select orden,
       paso,
       n,
       round(100.0 * n / nullif(first_value(n) over (order by orden), 0), 1)                          as pct_del_inicio,
       round(100.0 * (lag(n) over (order by orden) - n) / nullif(lag(n) over (order by orden), 0), 1) as pct_caida_vs_anterior
  from pasos
 order by orden;
