-- =============================================================================
-- Verificación de 20261029101115_funciones_nuevas_sin_execute_por_defecto
-- SOLO LECTURA (no crea ni modifica nada). Correr DESPUÉS de pegar la migración.
--
-- Devuelve una fila por chequeo con ok = true/false, y una última fila RESUMEN.
-- Esperado: todas true, RESUMEN «4/4 OK».
-- La fila de supabase_admin es INFORMATIVA (paso manual; postgres no puede
-- tocarla): se espera que siga dando EXECUTE a anon/authenticated hasta que
-- soporte de Supabase (o una sesión supabase_admin) corra el ALTER.
-- =============================================================================
WITH chequeos AS (
  -- C1: existe fila GLOBAL de postgres para funciones
  SELECT 1 AS n, 'postgres · global · funciones: existe fila' AS chequeo,
         EXISTS (SELECT 1 FROM pg_default_acl d
                  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0
                    AND d.defaclobjtype = 'f') AS ok
  UNION ALL
  -- C2: esa fila global NO da EXECUTE a PUBLIC (grantee 0)
  SELECT 2, 'postgres · global · funciones: sin PUBLIC',
         NOT EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
                      WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0
                        AND d.defaclobjtype = 'f' AND a.grantee = 0)
  UNION ALL
  -- C3: en public, postgres no da EXECUTE a PUBLIC/anon/authenticated
  SELECT 3, 'postgres · public · funciones: sin PUBLIC/anon/authenticated',
         NOT EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
                      WHERE d.defaclrole = 'postgres'::regrole
                        AND d.defaclnamespace = 'public'::regnamespace
                        AND d.defaclobjtype = 'f'
                        AND a.grantee IN (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid))
  UNION ALL
  -- C4: service_role conserva EXECUTE por defecto en public (lo usa el BFF)
  SELECT 4, 'postgres · public · funciones: service_role conserva EXECUTE',
         EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
                  WHERE d.defaclrole = 'postgres'::regrole
                    AND d.defaclnamespace = 'public'::regnamespace
                    AND d.defaclobjtype = 'f'
                    AND a.grantee = 'service_role'::regrole::oid
                    AND a.privilege_type = 'EXECUTE')
)
SELECT n, chequeo, ok, NULL::text AS detalle FROM chequeos
UNION ALL
SELECT 90, 'INFO supabase_admin · public · funciones (paso manual)', NULL,
       (SELECT d.defaclacl::text FROM pg_default_acl d
         WHERE d.defaclrole = 'supabase_admin'::regrole
           AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'f')
UNION ALL
SELECT 91, 'INFO postgres · todas las filas de funciones', NULL,
       (SELECT string_agg(coalesce(n.nspname, '(global)') || ' ' || d.defaclacl::text, ' | ')
          FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
         WHERE d.defaclrole = 'postgres'::regrole AND d.defaclobjtype = 'f')
UNION ALL
SELECT 99, 'RESUMEN',
       bool_and(ok),
       count(*) FILTER (WHERE ok) || '/' || count(*) || ' OK'
  FROM chequeos
ORDER BY n;
