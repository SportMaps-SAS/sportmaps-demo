-- =============================================================================
-- 20261119141857_invariantes_fix_regex_interno.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-19   Versión anterior: 20261119125245
-- Objetivo: corregir un error de la migración 20261119125245, ya aplicada.
--   Al reemitir invariantes_seguridad() la regex del gate de I7 quedó con
--   `|__interno(` (paréntesis sin escapar) en vez de `|__interno\(`. PostgreSQL
--   respondía «invalid regular expression: parentheses () not balanced» y el
--   detector dejó de funcionar (npm run seguridad:invariantes).
--
-- Cómo: parche sobre la definición VIVA (pg_get_functiondef + replace), para no
--   volver a transcribir el cuerpo completo. CREATE OR REPLACE conserva la ACL
--   (solo service_role), que ya es la correcta. Falla ruidosamente si no
--   encuentra el fragmento: nunca deja el detector a medias.
-- Radio de impacto: cero sobre datos o permisos; solo el diagnóstico.
-- Rollback: reemitir la función como en 20261119125245 (con el error) no tiene
--   sentido; para volver a la regex anterior, quitar
--   `|retiro_actor|retiro_titular|retiro_es_admin|_referral_assert_scope|__interno\(`.
-- =============================================================================

DO $fix$
DECLARE
    v_def   text;
    v_nueva text;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'invariantes_seguridad';
    IF v_def IS NULL THEN
        RAISE EXCEPTION 'invariantes_seguridad() no existe';
    END IF;

    v_nueva := replace(v_def, $a$|__interno(')$a$, $b$|__interno\(')$b$);
    IF v_nueva = v_def THEN
        RAISE EXCEPTION 'No se encontró el fragmento |__interno('') a corregir (¿ya estaba arreglado?)';
    END IF;

    EXECUTE v_nueva;
END
$fix$;
