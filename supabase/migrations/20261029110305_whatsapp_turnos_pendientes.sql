-- Turnos del bot de WhatsApp en curso (auditoría 2026-10-28, A-01 / C-02).
--
-- El webhook responde 200 a Meta y el turno (ráfaga de 10 s + modelo) corre en
-- memoria. Si el BFF se reinicia en ese rato —5 despliegues a prod en 24 h—, el
-- mensaje queda sin respuesta y Meta no lo reintenta. Cada turno se anota acá al
-- lanzarse y se borra al terminar; lo que quede anotado más de unos minutos lo
-- relanza el barrido (bff/src/services/whatsapp-turnos-pendientes.service.ts),
-- solo en el BFF de producción.
--
-- Solo la usa el BFF con service_role: RLS prendido y sin policies, y sin
-- privilegios para anon/authenticated (los default privileges del esquema se
-- los darían).
CREATE TABLE IF NOT EXISTS public.whatsapp_turnos_pendientes (
    wa_message_id   text PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
    integration_id  uuid NOT NULL,
    contact_wa_id   text NOT NULL,
    texto           text,
    opted_out       boolean NOT NULL DEFAULT false,
    boton_id        text,
    origen          text NOT NULL DEFAULT 'texto' CHECK (origen IN ('texto', 'audio')),
    intentos        integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_turnos_pendientes_created
    ON public.whatsapp_turnos_pendientes (created_at);

ALTER TABLE public.whatsapp_turnos_pendientes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.whatsapp_turnos_pendientes FROM PUBLIC;
REVOKE ALL ON public.whatsapp_turnos_pendientes FROM anon;
REVOKE ALL ON public.whatsapp_turnos_pendientes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_turnos_pendientes TO service_role;
