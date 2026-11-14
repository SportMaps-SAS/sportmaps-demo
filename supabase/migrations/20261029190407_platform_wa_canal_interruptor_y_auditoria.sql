-- Canal de WhatsApp de SportMaps administrado desde la app (2026-10-29).
--
-- Hasta hoy el canal se prendía con la variable PLATFORM_WA_ENABLED de Render
-- (cambiarla = redesplegar) y se conectaba con un script de consola. La pantalla
-- /admin/whatsapp del super admin lo maneja ahora:
--   1. platform_wa_canal.habilitado: el interruptor general en la base. El BFF
--      lo lee con cache de 1 min; PLATFORM_WA_ENABLED=true sigue prendiéndolo
--      (compatibilidad), nunca lo apaga.
--   2. platform_wa_auditoria: quién conectó, desconectó, prendió, apagó,
--      habilitó escuelas, registró plantillas o mandó pruebas.
-- Las dos son service-only, igual que el resto de platform_wa_*.

ALTER TABLE public.platform_wa_canal
    ADD COLUMN IF NOT EXISTS habilitado boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.platform_wa_auditoria (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    accion      text NOT NULL CHECK (accion IN (
                    'conectar', 'desconectar', 'habilitar_canal', 'deshabilitar_canal',
                    'habilitar_escuela', 'deshabilitar_escuela', 'registrar_plantillas', 'enviar_prueba')),
    detalle     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_wa_auditoria_created
    ON public.platform_wa_auditoria (created_at DESC);

ALTER TABLE public.platform_wa_auditoria ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.platform_wa_auditoria FROM PUBLIC;
REVOKE ALL ON public.platform_wa_auditoria FROM anon;
REVOKE ALL ON public.platform_wa_auditoria FROM authenticated;
GRANT SELECT, INSERT ON public.platform_wa_auditoria TO service_role;
