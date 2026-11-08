-- =============================================================================
-- 20261107180500_access_device_users_credenciales_sin_leer.sql
-- Objetivo: «IDs del lector» para lectores reales (Dreamers). pyzk, con el que el bridge lee los
-- usuarios del MB360, ve PIN, nombre y clave, y las huellas con un barrido aparte, pero NO ve
-- rostros. Hasta hoy has_face / has_fingerprint eran NOT NULL DEFAULT false, es decir, «no sé» se
-- guardaba como «no tiene»: una pantalla que dice «sin rostro» de alguien que sí lo tiene.
--
-- Cambio: ambas columnas pasan a admitir NULL = «no se pudo leer», sin default. Los datos que ya
-- existen (los 25 simulados de Academia Superior) no cambian de valor.
--
-- Radio: tabla nueva de 2026-10-31, solo la lee/escribe el BFF (RLS sin policies). Sin dependientes.
-- =============================================================================

BEGIN;

ALTER TABLE public.access_device_users
    ALTER COLUMN has_face        DROP NOT NULL,
    ALTER COLUMN has_face        DROP DEFAULT,
    ALTER COLUMN has_fingerprint DROP NOT NULL,
    ALTER COLUMN has_fingerprint DROP DEFAULT;

COMMENT ON COLUMN public.access_device_users.has_face IS
    'true/false = leído del lector; NULL = no se pudo leer (pyzk no ve rostros). NULL no equivale a false.';
COMMENT ON COLUMN public.access_device_users.has_fingerprint IS
    'true/false = leído del lector; NULL = no se leyó (la lectura de huellas es opcional). NULL no equivale a false.';

COMMIT;
