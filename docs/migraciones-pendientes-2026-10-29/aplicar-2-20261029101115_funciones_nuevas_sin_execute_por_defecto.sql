-- =============================================================================
-- 20261029101115_funciones_nuevas_sin_execute_por_defecto.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-29   Versión anterior: 20261029101109
-- Objetivo: que toda función NUEVA creada por postgres nazca sin EXECUTE para
--           PUBLIC (y por lo tanto sin EXECUTE para anon ni authenticated).
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · GRANT EXECUTE explícito por RPC (SECURITY DEFINER no exime al caller).
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================
--
-- ESTADO ANTES (pg_default_acl leído el 2026-10-29, solo lectura)
--   postgres · public · funciones  {postgres=X/postgres, service_role=X/postgres}
--     (anon y authenticated ya se quitaron en 20260917152834)
--   postgres · GLOBAL · funciones  SIN FILA → rige el default de PostgreSQL:
--     EXECUTE a PUBLIC. Los defaults por esquema se SUMAN al global, así que
--     cada función nueva de postgres en public nacía con «=X/postgres» y anon y
--     authenticated la ejecutaban por ser miembros de PUBLIC. Por eso todas las
--     migraciones recientes llevan REVOKE … FROM PUBLIC a mano.
--   supabase_admin · public · funciones  {postgres, anon, authenticated, service_role}=X
--     → NO se puede tocar desde postgres (no es miembro de supabase_admin).
--     Paso manual: abrir ticket a soporte de Supabase o correrlo con una sesión
--     supabase_admin:
--       ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--       ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
--           REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
--     Hoy ninguna función de public es de supabase_admin (las 968 son de postgres).
--
-- QUÉ HACE
--   1. Global para postgres: REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC.
--   2. En public: repite el REVOKE de PUBLIC, anon y authenticated (idempotente;
--      deja la regla explícita en el esquema donde viven las RPC).
--   NO es retroactivo: ninguna función existente cambia de ACL. Hoy hay 40
--   funciones de public con EXECUTE a PUBLIC explícito (=X); siguen igual.
--
-- CONSECUENCIA (la regla de CLAUDE.md pasa de recomendación a obligatoria)
--   Una función nueva sin GRANT EXECUTE … TO authenticated la ejecutan solo
--   postgres (dueño) y service_role (default de public). Desde el frontend da
--   42501 / HTTP 403 la primera vez que se llama. El olvido deja de ser un
--   agujero silencioso y pasa a ser un error visible en la primera prueba.
--
-- DIMENSIÓN DEL HÁBITO (migraciones desde 2026-10-15, 71 archivos, 154 funciones
-- no-trigger): 26 sin GRANT EXECUTE explícito; de esas, 4 las llama el frontend
-- por rpc y las 4 son CREATE OR REPLACE en 20261029095042 de funciones que ya
-- tenían el GRANT de 20261028201746 (el ACL se conserva). Las otras 22 son
-- helpers internos, todos con REVOKE explícito. O sea: hoy NINGUNA RPC reciente
-- del frontend dependía del EXECUTE por PUBLIC.
-- =============================================================================

BEGIN;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Autoverificación: el default global de postgres para funciones ya no incluye PUBLIC
DO $$
DECLARE
    v_acl aclitem[];
BEGIN
    SELECT d.defaclacl INTO v_acl
      FROM pg_default_acl d
     WHERE d.defaclrole = 'postgres'::regrole
       AND d.defaclnamespace = 0
       AND d.defaclobjtype = 'f';
    IF v_acl IS NULL THEN
        RAISE EXCEPTION 'No quedó fila global de default privileges para funciones de postgres';
    END IF;
    IF EXISTS (SELECT 1 FROM aclexplode(v_acl) a WHERE a.grantee = 0) THEN
        RAISE EXCEPTION 'El default global de postgres sigue dando EXECUTE a PUBLIC: %', v_acl;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
         WHERE d.defaclrole = 'postgres'::regrole
           AND d.defaclnamespace = 'public'::regnamespace
           AND d.defaclobjtype = 'f'
           AND a.grantee IN (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
    ) THEN
        RAISE EXCEPTION 'El default de postgres en public sigue dando EXECUTE a PUBLIC/anon/authenticated';
    END IF;
END $$;

COMMIT;
