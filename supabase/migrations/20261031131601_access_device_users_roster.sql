-- =============================================================================
-- 20261031131601_access_device_users_roster.sql
-- Objetivo: pestaña «IDs del lector» de Control de acceso (F1). Muestra a quienes tiene
-- cargados el lector (PIN, nombre, credenciales) para asociarlos a deportistas de SportMaps.
--
--   1. school_settings.access_roster_enabled (default false): interruptor por escuela.
--      Se enciende primero solo en Academia Superior Bogotá (pruebas); Dreamers después.
--   2. access_device_users: FOTO de lo que el lector reporta, reemplazada en cada
--      sincronización (no es un registro histórico ni un padrón de personas):
--      PIN, nombre tal como figura en el lector y qué credenciales tiene (SIN plantillas
--      biométricas: solo banderas). is_simulated marca datos de demostración.
--
-- Seguridad (CLAUDE.md): RLS activo SIN policies = nadie lo lee/escribe desde el
-- navegador; lo lee y escribe solo el BFF con service role (que filtra por school_id).
-- Se revoca explícito de anon y authenticated (default privileges de tablas/funciones).
-- Radio: tabla nueva y columna con default false → ninguna escuela cambia.
-- =============================================================================

BEGIN;

ALTER TABLE public.school_settings
    ADD COLUMN IF NOT EXISTS access_roster_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.school_settings.access_roster_enabled IS
    'true = Control de acceso muestra la pestaña «IDs del lector» (usuarios cargados en el lector + asociarlos). '
    'Academia Superior (pruebas) 2026-10-31.';

UPDATE public.school_settings ss
   SET access_roster_enabled = true
  FROM public.schools s
 WHERE s.id = ss.school_id
   AND s.name ILIKE 'ACADEMIA SUPERIOR%';

CREATE TABLE IF NOT EXISTS public.access_device_users (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id        uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    device_serial    text        NOT NULL,
    zk_pin           integer     NOT NULL CHECK (zk_pin > 0),
    reader_name      text        NOT NULL DEFAULT '',
    has_face         boolean     NOT NULL DEFAULT false,
    has_fingerprint  boolean     NOT NULL DEFAULT false,
    has_password     boolean     NOT NULL DEFAULT false,
    privilege        integer     NOT NULL DEFAULT 0,
    is_simulated     boolean     NOT NULL DEFAULT false,
    synced_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT access_device_users_unico UNIQUE (school_id, device_serial, zk_pin)
);

CREATE INDEX IF NOT EXISTS idx_access_device_users_school_pin
    ON public.access_device_users (school_id, zk_pin);

COMMENT ON TABLE public.access_device_users IS
    'Foto de los usuarios que reporta el lector (PIN, nombre, banderas de credenciales). Se reemplaza en cada '
    'sincronización; NO guarda plantillas biométricas. Solo la lee/escribe el BFF (RLS sin policies).';

ALTER TABLE public.access_device_users ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.access_device_users FROM PUBLIC, anon, authenticated;

COMMIT;
