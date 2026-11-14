-- =============================================================================
-- Verificación de 20261028111725_gates_definer_authenticated (SOLO LECTURA)
-- Pegar en el SQL Editor DESPUÉS de aplicar la migración. No modifica nada.
-- Esperado: authenticated = false, anon = false, service_role = true en las 11.
-- =============================================================================

with f(sig) as (values
  ('public.close_cash_session(uuid,numeric,text)'),
  ('public.send_notification(text,text,text,text,uuid)'),
  ('public.submit_enrollment(uuid,uuid,uuid,numeric,uuid,text,date,text,text,text,text,boolean,text,text)'),
  ('public.submit_enrollment_v2(uuid,uuid,uuid,text,date,text,text,text,text,text,text)'),
  ('public.claim_child_for_parent(uuid,text,text)'),
  ('public.find_athletes_by_document(text,uuid)'),
  ('public.create_demo_link(text,text,text,text,text,text,text,text,text)'),
  ('public.access_demo_link(text)'),
  ('public.admin_create_staff_direct(text,text,uuid)'),
  ('public.run_saas_billing_cycle()'),
  ('public.generate_school_subscription_invoice(uuid)')
)
select f.sig,
       has_function_privilege('authenticated', f.sig::regprocedure, 'EXECUTE') as authenticated,  -- false
       has_function_privilege('anon',          f.sig::regprocedure, 'EXECUTE') as anon,           -- false
       has_function_privilege('service_role',  f.sig::regprocedure, 'EXECUTE') as service_role,   -- true
       (select prosecdef from pg_proc where oid = f.sig::regprocedure)          as sigue_definer    -- true
from f
order by 1;

-- Debe dar 0 filas: ninguna función revocada quedó ejecutable por un rol de sesión.
with f(sig) as (values
  ('public.close_cash_session(uuid,numeric,text)'),
  ('public.send_notification(text,text,text,text,uuid)'),
  ('public.submit_enrollment(uuid,uuid,uuid,numeric,uuid,text,date,text,text,text,text,boolean,text,text)'),
  ('public.submit_enrollment_v2(uuid,uuid,uuid,text,date,text,text,text,text,text,text)'),
  ('public.claim_child_for_parent(uuid,text,text)'),
  ('public.find_athletes_by_document(text,uuid)'),
  ('public.create_demo_link(text,text,text,text,text,text,text,text,text)'),
  ('public.access_demo_link(text)'),
  ('public.admin_create_staff_direct(text,text,uuid)'),
  ('public.run_saas_billing_cycle()'),
  ('public.generate_school_subscription_invoice(uuid)')
)
select f.sig
from f
where has_function_privilege('authenticated', f.sig::regprocedure, 'EXECUTE')
   or has_function_privilege('anon',          f.sig::regprocedure, 'EXECUTE');

-- Ninguna policy depende de ellas (debe dar 0 filas; si da filas, esa policy
-- empezaría a fallar con 42501 y hay que devolver el GRANT).
select tablename, policyname
from pg_policies
where coalesce(qual, '') || ' ' || coalesce(with_check, '')
      ~ '\m(close_cash_session|send_notification|submit_enrollment|submit_enrollment_v2|claim_child_for_parent|find_athletes_by_document|create_demo_link|access_demo_link|admin_create_staff_direct|run_saas_billing_cycle|generate_school_subscription_invoice)\(';

-- Las PREGUNTAS del doc (notify_user, mark_custom_domain_verified, save_school_*)
-- NO entraron en esta migración: su gate sigue igual. Para confirmar que nadie
-- las tocó por fuera del repo, el gate esperado sigue en el cuerpo vivo:
select proname,
       prosrc ilike '%school_members%' as gate_por_school_members,
       proacl::text
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('notify_user', 'mark_custom_domain_verified', 'save_school_info', 'save_school_branding')
order by 1;
