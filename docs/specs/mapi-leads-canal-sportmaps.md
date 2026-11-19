# Mapi atiende a los leads del canal de SportMaps

Estado: construido detrás de flag (apagado). Código: `bff/src/services/plataforma-wa-leads.service.ts`, cableado en `plataforma-wa-entrante.service.ts`.

## Qué hace

Quien escribe al +57 320 268 3539 sin ser suscriptor ni tester ya no queda en silencio (D12): Mapi le responde con un modelo (Claude Haiku por `chatWithTools`, `PLATFORM_WA_LEADS_MODEL` o `WHATSAPP_PROSPECTO_MODEL`).

**El modelo nunca es fuente de datos comerciales.** Planes, precios, topes de alumnos y promo salen de `CONFIG_COMERCIAL` (landing v3.0, `RolePricingSection.tsx`): Free Start $0 (20 alumnos), Start $69.000 (50), Crecimiento $99.000 (120), Pro $159.000 (300), Elite $349.000 (800), Custom desde $750.000 (cotiza una persona). Anual: 59/89/139/299 mil. La landing tiene además Crecimiento, que no estaba en la lista del encargo: se incluyó porque está publicada; quitarlo del arreglo si no debe decirse.

Defensas:
1. Prompt: lo que escribe el lead va en `<mensaje>`, una línea, sin etiquetas; solo un enlace permitido (`https://sportmaps.co`).
2. Verificador de salida (`verificarRespuesta`): monto que no está en la configuración, enlace ajeno, promo/descuento/«Black Friday» sin promo vigente, fuga del prompt → la respuesta NO sale y se escala a persona.
3. Escalado: pide persona/asesor/llamada/precio especial/cotización/queja (palabras clave, sin gastar modelo), el modelo contesta `[[ESCALAR]]`, o el modelo falla → UN texto «te contacta una persona del equipo» (paso `lead_escalado`). Después, silencio hacia ese número por 3 días.
4. Topes por número: 4 respuestas/hora y 10/día. Si no se pueden leer los topes, no se responde.
5. Ventana de 24 h de Meta: solo texto libre, solo si el número escribió en las últimas 24 h; nada de plantillas.
6. Audio/imagen/etc.: una frase pidiendo texto, una vez al día (`lead_pide_texto`).

## Promo (Black Friday)

`CONFIG_COMERCIAL.promo = { texto, desde, hasta }`, vacía por defecto. Mientras `texto` esté vacío o fuera de vigencia, ni el prompt ni el verificador permiten mencionar promo, descuento, ofertas ni «meses gratis». Al llenarla (por ejemplo «Black Friday: noviembre y diciembre gratis») con sus fechas ISO, el prompt la recibe en `<promo>` y el verificador deja pasar solo esa redacción; los montos que traiga el texto se consideran permitidos.

## Cómo se enciende

1. Canal habilitado (`PLATFORM_WA_ENABLED` + canal activo): hoy el flujo de entrantes ya corta con `apagado` si no lo está.
2. `PLATFORM_WA_LEADS_MAPI=true` en el BFF de prod. Sin la variable, todo sigue como antes (silencio o `PLATFORM_WA_RESPUESTA_COMERCIAL`).
3. Llave de Claude (`ANTHROPIC_API_KEY`); si falla el modelo, el lead recibe el texto de escalado.
4. Probar primero con un número en `PLATFORM_WA_TESTERS`: el tester va al modo pruebas y NO pasa por este flujo, así que la prueba real es desde un celular que no esté en la lista.

## Registro del lead (hoy)

No existe tabla adecuada: `school_signup_leads` es de escuelas captando familias (otro negocio, según su propia migración) y `demo_links.prospect_*` es otro embudo. Sin migración, el rastro queda en `platform_wa_mensajes` (clase `desconocido`, direccion `saliente`) con `paso` ∈ `lead_mapi`, `lead_escalado`, `lead_pide_texto`. Para la persona que atiende: los números con `paso = 'lead_escalado'` son los pendientes de atención humana.

Limitación: de un desconocido no se guarda el texto (CHECK `platform_wa_mensajes_desconocido_sin_texto`), por eso el modelo ve solo el mensaje actual (sin historial) y nadie puede releer qué preguntó el lead. Ver decisión 1.

## Propuesta de migración (NO aplicada)

Tabla `platform_leads` (RLS sin policies, acceso por RPC `SECURITY DEFINER` solo para admin de plataforma; `GRANT EXECUTE` explícito; `search_path` fijo):

| columna | nota |
|---|---|
| `id uuid pk`, `contact_wa_id text unique` | `^[0-9]{10,15}$` |
| `nombre text null` | perfil de WhatsApp |
| `estado text check in ('nuevo','atendido_mapi','escalado','en_conversacion','ganado','perdido')` | text + CHECK |
| `interes text null`, `alumnos_aprox int null`, `plan_sugerido text null` | los llena Mapi con una herramienta, no a mano |
| `primer_mensaje_at`, `ultimo_mensaje_at`, `escalado_at`, `atendido_por uuid null references profiles(id)` | |
| `consentimiento_texto boolean default false` | para guardar texto solo con aviso de privacidad |

Más una vista/pantalla en `/admin/whatsapp` con los escalados. Si se aprueba guardar texto, cambiar el CHECK (decisión de privacidad, D12) y pasar la conversación al modelo.

## Por decidir

1. ¿Guardar el texto de los leads (para historial y para que Mapi recuerde la conversación)? Requiere cambiar D12 y la política de privacidad.
2. Choque con ventas: el número está en Coexistence y el equipo atiende desde la app de WhatsApp Business; si una persona responde, Mapi seguiría contestando mensajes siguientes. Opciones: silencio de N horas tras detectar una salida humana (el webhook de eco/`smb_message_echoes`), o dejar el escalado como único corte.
3. Horario: ¿responder 24/7 o solo fuera de horario laboral?
4. Texto y vigencia de la promo de Black Friday.
5. ¿Crecimiento se menciona? ¿Anual se ofrece?
6. Los suscriptores revocados/en pausa quedan en D12 (silencio), no en este flujo.
