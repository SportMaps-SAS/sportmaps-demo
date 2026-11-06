-- 20261105213601_anon_sin_escritura_en_tablas_de_planes.sql
--
-- ORDEN: 4.º (después de 20261105212125; independiente del resto; no depende del frontend).
-- PRECONDICIONES: ninguna.
--
-- POR QUÉ: anon (sin sesión) tiene hoy INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER sobre las tablas que
-- deciden qué paga cada escuela (school_addons, school_subscriptions, subscription_plans) y sobre school_members,
-- school_settings y schools. Hoy las frena solo RLS; un error de policy (p. ej. un USING(true) nuevo) las dejaría
-- escribibles sin login. Son grants "inertes" por los default privileges de Supabase y no los necesita nadie:
-- el registro ocurre con authenticated tras signUp y handle_new_user es SECURITY DEFINER (dueño postgres).
-- Verificado con Grep en frontend/src, bff/src y supabase/functions: ningún cliente sin sesión escribe estas
-- tablas. Se conserva SELECT de anon (la landing / planes públicos pueden leer subscription_plans y schools;
-- school_addons y school_subscriptions no tienen policy para anon, su SELECT es inerte).

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.school_addons        FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.school_subscriptions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.subscription_plans   FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.school_members       FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.school_settings      FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.schools              FROM anon;

COMMIT;
