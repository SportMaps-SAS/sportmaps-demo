-- ============================================================================
-- Embudo de ACADEMIAS (sección 1.4 del análisis) armado con analytics_events.
-- SOLO LECTURA. Se corre con:
--     npx supabase db query --remote --read-only -f docs/onboarding/embudo-academias.sql -o json
--
-- Cohorte: cuentas con rol «school» cuyo signup_completed cae en la ventana.
-- Cada paso cuenta una vez por cuenta, si lo alcanzó DESPUÉS de registrarse; no
-- exige orden (un paso saltado no tumba los siguientes).
--   · «% del inicio»  = n / cuentas creadas
--   · «caída»         = (n anterior − n) / n anterior
-- Nota: con cohortes de menos de ~30 cuentas los porcentajes son orientativos.
--
-- Eventos que alimentan cada paso:
--   cliente (RPC track_onboarding_event): onboarding_step_viewed / _completed /
--       _skipped / onboarding_finished, con event_data.flow = 'school' y .step
--   base (triggers): signup_completed, first_plan_created, first_athlete_created,
--       first_charge_created, payment_method_configured, whatsapp_connected
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
       and e.event_data ->> 'role' = 'school'
       and e.created_at >= p.desde and e.created_at < p.hasta
       and e.user_id is not null
     group by e.user_id
),
por_cuenta as (
    select c.user_id,
           coalesce(bool_or(e.event_type = 'onboarding_step_viewed'    and e.event_data ->> 'flow' = 'school'), false) as vio_asistente,
           coalesce(bool_or(e.event_type = 'onboarding_step_completed' and e.event_data ->> 'flow' = 'school' and e.event_data ->> 'step' = 'branch'), false) as sede,
           coalesce(bool_or(e.event_type = 'onboarding_step_completed' and e.event_data ->> 'flow' = 'school' and e.event_data ->> 'step' = 'model'), false)  as modelo,
           coalesce(bool_or(
                (e.event_type = 'onboarding_step_completed' and e.event_data ->> 'flow' = 'school' and e.event_data ->> 'step' in ('team', 'plan'))
                or e.event_type = 'first_plan_created'), false) as equipo_o_plan,
           coalesce(bool_or(e.event_type = 'onboarding_step_completed' and e.event_data ->> 'flow' = 'school' and e.event_data ->> 'step' = 'coach'), false) as entrenador,
           coalesce(bool_or(e.event_type = 'first_athlete_created'), false)       as deportista,
           coalesce(bool_or(e.event_type = 'payment_method_configured'), false)   as medio_cobro,
           coalesce(bool_or(e.event_type = 'onboarding_finished' and e.event_data ->> 'flow' = 'school'), false) as asistente_terminado,
           coalesce(bool_or(e.event_type = 'first_charge_created'), false)        as primer_cobro,
           coalesce(bool_or(e.event_type = 'whatsapp_connected'), false)          as whatsapp
      from cohorte c
      left join public.analytics_events e
             on e.user_id = c.user_id and e.created_at >= c.registro
     group by c.user_id
),
pasos as (
    select 1  as orden, 'Cuenta creada'                 as paso, count(*)                                      as n from por_cuenta
    union all select 2,  'Vio el asistente',                 count(*) filter (where vio_asistente)        from por_cuenta
    union all select 3,  'Sede confirmada (con dirección)',  count(*) filter (where sede)                 from por_cuenta
    union all select 4,  'Modelo elegido',                   count(*) filter (where modelo)               from por_cuenta
    union all select 5,  'Primer equipo o plan',             count(*) filter (where equipo_o_plan)        from por_cuenta
    union all select 6,  'Entrenador agregado',              count(*) filter (where entrenador)           from por_cuenta
    union all select 7,  'Primer deportista',                count(*) filter (where deportista)           from por_cuenta
    union all select 8,  'Medio de cobro configurado',       count(*) filter (where medio_cobro)          from por_cuenta
    union all select 9,  'Asistente terminado',              count(*) filter (where asistente_terminado)  from por_cuenta
    union all select 10, 'Primer cobro',                     count(*) filter (where primer_cobro)         from por_cuenta
    union all select 11, 'WhatsApp conectado',               count(*) filter (where whatsapp)             from por_cuenta
)
select orden,
       paso,
       n,
       round(100.0 * n / nullif(first_value(n) over (order by orden), 0), 1)                     as pct_del_inicio,
       round(100.0 * (lag(n) over (order by orden) - n) / nullif(lag(n) over (order by orden), 0), 1) as pct_caida_vs_anterior
  from pasos
 order by orden;
