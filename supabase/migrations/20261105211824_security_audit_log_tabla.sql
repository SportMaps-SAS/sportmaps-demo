-- 20261105211824_security_audit_log_tabla.sql
--
-- ORDEN DE APLICACIÓN EN PRODUCCIÓN: 1.º de las 4 migraciones del cierre de seguridad de reservas
--   (independiente de las demás; puede ir en cualquier momento, ANTES de desplegar el BFF que audita).
-- PRECONDICIONES: ninguna. Idempotente: si la tabla ya existe (twin, o alguna base), la endurece.
--
-- POR QUÉ: bff/src/utils/auditWrite.ts inserta en public.security_audit_log, pero en producción la
-- tabla NO EXISTE (to_regclass = NULL; la 20260415000001 figura "aplicada" en el ledger y nunca
-- llegó). Resultado: cada auditoría (borrar/aprobar/completar reservas, etc.) fallaba en silencio.
--
-- COLUMNAS: exactamente las que escribe auditWrite.ts (user_id, action, target_table, target_id,
-- old_value, new_value, ip_address, user_agent, metadata) + id y ts que pone la base.
-- Diferencias deliberadas frente a la definición original (20260415000001:202):
--   * SIN CHECK de lista cerrada en `action` (el original tenía 16 valores y rechazaría decenas de
--     acciones del BFF con 23514). Solo formato/longitud: 1..120, [A-Za-z0-9_:.-] (TG_OP en mayúsculas
--     de los triggers de salud también pasa).
--   * ip_address es TEXT (<= 64): inet fallaba con un x-forwarded-for en lista.
--   * user_id -> auth.users ON DELETE SET NULL (no bloquea el borrado de usuarios).
--   * RLS habilitada; SIN policy de INSERT (el original daba WITH CHECK(true) a authenticated: cualquiera
--     podía falsificar auditoría). Solo service_role escribe. SELECT solo para admin de plataforma.
--   * Inmutable: sin UPDATE/DELETE para nadie salvo service_role.

BEGIN;

CREATE TABLE IF NOT EXISTS public.security_audit_log (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts           timestamptz NOT NULL DEFAULT now(),
    user_id      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
    action       text        NOT NULL,
    target_table text,
    target_id    text,
    old_value    jsonb,
    new_value    jsonb,
    ip_address   text,
    user_agent   text,
    metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Si existía con el CHECK cerrado original, fuera (cualquier CHECK que toque `action`).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.conname FROM pg_constraint c
            WHERE c.conrelid = 'public.security_audit_log'::regclass AND c.contype = 'c'
              AND pg_get_constraintdef(c.oid) ILIKE '%action%'
  LOOP
    EXECUTE format('ALTER TABLE public.security_audit_log DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- Si existía con ip_address inet, pasa a text; y la FK a SET NULL.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'security_audit_log' AND column_name = 'ip_address') <> 'text' THEN
    ALTER TABLE public.security_audit_log ALTER COLUMN ip_address TYPE text USING host(ip_address);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'security_audit_log_user_id_fkey' AND conrelid = 'public.security_audit_log'::regclass
                AND confdeltype <> 'n') THEN
    ALTER TABLE public.security_audit_log DROP CONSTRAINT security_audit_log_user_id_fkey;
    ALTER TABLE public.security_audit_log
      ADD CONSTRAINT security_audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.security_audit_log DROP CONSTRAINT IF EXISTS security_audit_log_action_fmt;
ALTER TABLE public.security_audit_log ADD CONSTRAINT security_audit_log_action_fmt
  CHECK (length(action) BETWEEN 1 AND 120 AND action ~ '^[A-Za-z0-9_:.-]+$') NOT VALID;
ALTER TABLE public.security_audit_log VALIDATE CONSTRAINT security_audit_log_action_fmt;
ALTER TABLE public.security_audit_log DROP CONSTRAINT IF EXISTS security_audit_log_ip_len;
ALTER TABLE public.security_audit_log ADD CONSTRAINT security_audit_log_ip_len
  CHECK (ip_address IS NULL OR length(ip_address) <= 64) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_audit_log_user_ts   ON public.security_audit_log (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action    ON public.security_audit_log (action, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target    ON public.security_audit_log (target_table, target_id);
-- La escuela vive en metadata.school_id (auditWrite.ts).
CREATE INDEX IF NOT EXISTS idx_audit_log_school_ts ON public.security_audit_log ((metadata ->> 'school_id'), ts DESC);

ALTER TABLE public.security_audit_log ENABLE ROW LEVEL SECURITY;

-- Las policies originales (INSERT abierto, SELECT admin por profiles.role) se reemplazan.
DROP POLICY IF EXISTS "audit_log_insert_authenticated" ON public.security_audit_log;
DROP POLICY IF EXISTS "audit_log_select_admin"         ON public.security_audit_log;
DROP POLICY IF EXISTS audit_log_select_platform_admin  ON public.security_audit_log;
CREATE POLICY audit_log_select_platform_admin ON public.security_audit_log
  FOR SELECT TO authenticated
  USING (public.is_platform_admin());

REVOKE ALL ON public.security_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.security_audit_log TO authenticated;      -- filtrado por la policy de arriba
GRANT ALL ON public.security_audit_log TO service_role;
REVOKE ALL ON SEQUENCE public.security_audit_log_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.security_audit_log_id_seq TO service_role;

COMMIT;
