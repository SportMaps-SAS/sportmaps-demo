# Plan B5 mínimo · Campaña de marketing por escuela desde el historial (Monster´s Volley Club)

Escuela `eb3ebc77-4ea4-4992-96c8-3c8ec574578c`. Repo solo leído; 4 consultas SQL de solo lectura y puntuales
(integraciones, `whatsapp_messages` por integración, `whatsapp_account_events`). Rutas bajo `bff/src` salvo aviso. 2026-10-30.

## 0. Hallazgo que manda sobre todo: el historial NUNCA ha llegado

- Dynasty (integración `f50d6940…`, coexistencia desde 2026-10-02 19:28): **14.706 mensajes, 0 anteriores al alta, 0 con
  `history_context`**. `procesarHistorial` (`services/whatsapp-coexistence.service.ts:363-426`) nunca guardó nada.
- La doc de Meta («Onboarding WhatsApp Business app users», leída hoy) exige que el proveedor haga
  `POST /<PHONE_NUMBER_ID>/smb_app_data` con `sync_type: "history"` (y otra con `"smb_app_state_sync"` para contactos)
  **dentro de las 24 h** del alta y **una sola vez**; si no, desconectar y repetir el alta. También pide el campo `history`
  suscrito en App Dashboard. La escuela puede negarse (el webhook trae el error `2593109`). Son 180 días, sin grupos.
- **No hay ninguna llamada a `smb_app_data` en el repo.** `conectarEscuela` (`services/whatsapp-onboarding.service.ts:93-208`)
  solo hace `subscribed_apps` (`:85-91`); el comentario de `:182-185` habla del plazo, pero nada lo arranca.
- Segundo defecto: `guardarMensaje` (`whatsapp-coexistence.service.ts:122-147`) no fija `created_at`, así que lo histórico
  quedaría con la fecha de importación. Las ventanas del bot leen `created_at`: `escuelaLeEscribioEnDias`
  (`whatsapp-bot.service.ts:5813-5826`, 30 d), `entrantesDeTexto` (`:3432-3446`, 7 d) y `escuelaActiva`
  (`whatsapp-modo-discreto.ts:81-94`, 12 h). Tras importar, toda conversación vieja parecería «la escuela escribió hoy».

**Consecuencia:** si Monster conecta antes de que T1 esté en `main` (el webhook entra al BFF de prod), el historial se
pierde (salvo desconectar y reconectar). T1 es chica y va primero, sola.

## 1. Qué existe (file:line)

| Pieza | Dónde | Para B5 |
|---|---|---|
| Catálogo UTILITY y bloqueo de MARKETING | `whatsapp-plantillas.service.ts:89-155` (`CONCEPTOS`); `plantillaAprobada` `:522-545` (corte `:540-543`); manual: `whatsapp-plantilla-manual.service.ts:96` | No se tocan (cobranza). La campaña tiene camino y chequeo propios |
| Envío por plantilla | `enviarCobroPorPlantilla` `:574-660` (opt-in obligatorio `:589-595`); `armarPayloadPlantilla` `:264-290`, `limpiarParametro` `:219`, `renderizarCuerpo` `:237` | Se reusan las puras |
| Horario «Ley 2300» del código | `dentroDeHorarioDeCobranza` `:251-261`: L-V 7-19, sáb 8-15, nunca domingos ni festivos (`utils/festivos-colombia`; comprobado: 2-nov y 16-nov-2026 festivos) | Se usa tal cual (D11 sigue abierta) |
| Estado en Meta | `whatsapp_template_status` (mig. `20261004080918`), `sincronizarPlantillas` `:369-440`, sync cada 30 min (`maintenance.job.ts:708`) | Trae `category`, `status`, `components` |
| Crear plantilla en la WABA de la escuela | `POST /:schoolId/plantillas` (`routes/whatsapp-admin.routes.ts:925-1011`): acepta MARKETING, valida ejemplos; **solo BODY** | + FOOTER + 3 QUICK_REPLY |
| Registro por consola | `bff/scripts/wa-registrar-plantilla.ts` + JSON de `bff/whatsapp-templates/` | Respaldo sin pantalla |
| Botón de plantilla en el webhook | `whatsapp.service.ts:819-821` (`button.payload` → `botonId`) | El payload `smc:…` vuelve tal cual |
| Opt-in / baja | `whatsapp_optins` (migs. `20260909215933`, `20260909222343`: fuente `baja_directa`), `wa_register_optin(…, p_opt_out)`, `wa_can_send_template` | «No recibir más» = opt-out |
| Calidad | `procesarEventosDeCuenta` `routes/whatsapp.ts:243-342` → `whatsapp_account_events`; Graph `quality_rating` (`plataforma-wa-admin.service.ts:112`) | Freno (forma real abajo) |
| Intención, gratis y determinista | `intencionDeProspecto`/`interesesDeProspecto` (`whatsapp-atencion.service.ts:567-604, 647-659`), `resumirProspecto` (`whatsapp-prospecto-lead.service.ts:62`) | Núcleo del clasificador |
| Modelo con JSON | `generarJsonEstructurado` (`llm.service.ts:605`) | Ambiguos, opcional |
| Análisis de 604 conversaciones | Lo hicieron 6 agentes + scripts del scratchpad de otra sesión; **no quedó código en el repo** | Se reusa el criterio y las reglas de arriba |
| Marcas manuales | `TIPOS_MARCADOS` (`whatsapp-tipo-contacto.ts:25`), `clasificarConMarca` (`whatsapp-atencion.service.ts:125-150`) | Excluir personal/negocio/otro club |
| Lead, salida, admins | `registrarLeadDeProspecto` (`whatsapp-prospecto-lead.service.ts:125`); `deliver` (`whatsapp-bot.service.ts:4584`, asistido = borrador `:4651-4654`, la baja sale siempre `:4582`); `adminsDeEscuela` (`plataforma-wa.service.ts:190`) + `INSERT notifications` | Respuestas y avisos |

Forma real (base viva): `phone_number_quality_update` trae `{event: ONBOARDING|FLAGGED|…, current_limit: "TIER_250",
old_limit}`, **sin color**; queda `nuevo_estado = current_limit`, `motivo = event` (`routes/whatsapp.ts:306-325`). El color
llega por `message_template_quality_update.new_quality_score` (2 YELLOW el 14-sep) y por Graph `quality_rating`.
`account_update` llega a diario con `ACCOUNT_DELETED` (23→29-oct): frenar con «cualquier account_update» pausaría siempre.
Una integración por escuela: `conectarEscuela` → `ya_conectada` (`onboarding.service.ts:107-115`) e `integracionDeEscuela`
→ `integracion_ambigua` (`plantillas.service.ts:314-324`). Si «ambas sedes» son dos números, hoy entra uno (P2).

## 2. Borrador de migración (no escribir hasta aprobar; `npm run migrations:new -- wa_campanas_marketing`)

```sql
BEGIN;
-- 1) Interruptor + límites por escuela. Sin fila = apagado (Dynasty y demás no cambian). Solo BFF.
CREATE TABLE public.whatsapp_campanas_ajustes (
  school_id uuid PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
  habilitadas boolean NOT NULL DEFAULT false,
  base_consentimiento text NOT NULL DEFAULT 'optin' CHECK (base_consentimiento IN ('optin','contacto_previo_declarado')),
  tope_diario_max int NOT NULL DEFAULT 200 CHECK (tope_diario_max BETWEEN 1 AND 100000),
  lote_piloto int NOT NULL DEFAULT 50 CHECK (lote_piloto BETWEEN 1 AND 1000),          -- 1.er día de cada campaña
  frecuencia_min_dias int NOT NULL DEFAULT 7 CHECK (frecuencia_min_dias BETWEEN 1 AND 90),
  antiguedad_max_dias int NOT NULL DEFAULT 180 CHECK (antiguedad_max_dias BETWEEN 1 AND 365),
  palabras_sede jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{branch_id, palabras:[…]}]: nada de Monster en el código
  pausada_at timestamptz, pausa_motivo text, habilitado_por uuid REFERENCES public.profiles(id), habilitado_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
-- 2) Audiencia clasificada: una fila por número de la integración.
CREATE TABLE public.whatsapp_audiencia (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), integration_id uuid NOT NULL, school_id uuid NOT NULL,
  conversation_id uuid REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE, contact_wa_id text NOT NULL,
  intereses text[] NOT NULL DEFAULT '{}'
    CHECK (intereses <@ ARRAY['clase_prueba','inscripcion','clinica','precio','horarios','informacion']::text[]),
  branch_id uuid REFERENCES public.school_branches(id) ON DELETE SET NULL,
  excluido text CHECK (excluido IN ('familia','staff','marca_manual','baja','bloqueado','no_interesa','inscrito')),
  fuente text NOT NULL DEFAULT 'reglas' CHECK (fuente IN ('reglas','modelo','importado')),
  evidencia_wa_message_id text, primer_entrante_at timestamptz, ultimo_entrante_at timestamptz,
  version_reglas smallint NOT NULL DEFAULT 1, clasificado_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_wa_audiencia UNIQUE (integration_id, contact_wa_id),
  CONSTRAINT fk_wa_audiencia_integ FOREIGN KEY (integration_id, school_id)
    REFERENCES public.school_whatsapp_integrations(id, school_id) ON DELETE CASCADE);
CREATE INDEX idx_wa_audiencia_vigente ON public.whatsapp_audiencia(integration_id) WHERE excluido IS NULL;
-- 3) Campañas · 4) Envíos (idempotencia: UNIQUE campaña+número; a lo sumo una vez, con lease).
CREATE TABLE public.whatsapp_campanas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), integration_id uuid NOT NULL, school_id uuid NOT NULL,
  nombre text NOT NULL CHECK (length(nombre) BETWEEN 3 AND 80), plantilla text NOT NULL, idioma text NOT NULL DEFAULT 'es_CO',
  filtro jsonb NOT NULL DEFAULT '{}'::jsonb,       -- {intereses:[], branch_ids:[]}
  variables jsonb NOT NULL DEFAULT '[]'::jsonb,    -- ["nombre"] → {{1}}
  respuesta_si text CHECK (length(respuesta_si) <= 1024),
  estado text NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador','aprobada','enviando','pausada','terminada','cancelada')),
  destinatarios int, aprobada_por uuid REFERENCES public.profiles(id), aprobada_at timestamptz, declaracion_version text,
  vence_at timestamptz, pausa_motivo text, creada_por uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_wa_campana_integ FOREIGN KEY (integration_id, school_id)
    REFERENCES public.school_whatsapp_integrations(id, school_id) ON DELETE CASCADE);
CREATE TABLE public.whatsapp_campana_envios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campana_id uuid NOT NULL REFERENCES public.whatsapp_campanas(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL, school_id uuid NOT NULL, contact_wa_id text NOT NULL,
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','enviando','enviado','incierto','fallido',
    'omitido','respondio_si','respondio_luego','baja')),
  motivo text, wa_message_id text, intentos smallint NOT NULL DEFAULT 0, proximo_intento_at timestamptz,
  lease_hasta timestamptz, enviado_at timestamptz, respondido_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_wa_campana_envio UNIQUE (campana_id, contact_wa_id));
CREATE INDEX idx_wa_envios_cola ON public.whatsapp_campana_envios(campana_id, proximo_intento_at) WHERE estado='pendiente';
CREATE INDEX idx_wa_envios_contacto ON public.whatsapp_campana_envios(integration_id, contact_wa_id, enviado_at DESC);
CREATE UNIQUE INDEX uq_wa_envios_wamid ON public.whatsapp_campana_envios(wa_message_id) WHERE wa_message_id IS NOT NULL;
-- RLS: las 4 tablas son solo-BFF (la pantalla lee por rutas con administraEstaEscuela). ENABLE RLS en las 4, sin policies:
REVOKE ALL ON TABLE public.whatsapp_campanas_ajustes, public.whatsapp_audiencia, public.whatsapp_campanas,
  public.whatsapp_campana_envios FROM PUBLIC, anon, authenticated;            -- y GRANT ALL … TO service_role
-- 5) Exclusión por teléfono en UN barrido, no N llamadas a wa_identify_by_phone (compara right(regexp_replace(phone))
--    sin índice, mig. 20261025205953). Mismas fuentes: profiles con hijo/miembro/matrícula/no registrado de ESA escuela,
--    children.parent_phone_temp, staff activo, y school_signup_leads 'converted'.
CREATE FUNCTION public.wa_audiencia_excluidos(p_school_id uuid, p_wa_ids text[])
RETURNS TABLE (contact_wa_id text, motivo text) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$ /* WITH t(wa,t10) AS (SELECT … FROM unnest(p_wa_ids)) … */ $$;
-- 6) Aprobar = foto de la audiencia. Valida ADENTRO: campaña en 'borrador', ajustes.habilitadas, y que p_por sea owner u
--    owner/admin/school_admin activo de ESA escuela (como adminsDeEscuela). INSERT de envíos ON CONFLICT DO NOTHING.
CREATE FUNCTION public.wa_campana_aprobar(p_campana_id uuid, p_por uuid, p_declaracion text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ … $$;
-- 7) Tomar lote: pg_advisory_xact_lock por integración; 'enviando' con lease vencido → 'incierto' (no se reenvía);
--    'omitido' para baja, wa_is_blocked, marca manual, excluido, marketing a ese número hace < frecuencia_min_dias,
--    sin opt-in si base='optin', campaña vencida; cupo = least(p_max, p_limite_meta − destinatarios de plantillas en 24 h);
--    FOR UPDATE SKIP LOCKED → 'enviando', lease 10 min, intentos+1.
CREATE FUNCTION public.wa_campana_tomar_lote(p_campana_id uuid, p_max int, p_limite_meta int)
RETURNS SETOF public.whatsapp_campana_envios LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$ … $$;
-- Las 3: REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role.
COMMIT;
```
No toca el CHECK de `whatsapp_optins` (no choca con `bot_prospecto` del plan B2/B3). Después: `npm run
seguridad:invariantes`, `pg_policies` de las 4 tablas (0 filas), `set local role authenticated` → 42501; `types.ts` una vez.

## 3. Cambios archivo por archivo

**T1 · Historial (urgente, va solo a `main`).** `services/whatsapp-onboarding.service.ts`: tras el insert (`:153-171`), si
`sesion.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'`, `pedirSincronizacion(token, phoneNumberId, tipo)` →
`POST …/smb_app_data` para `smb_app_state_sync` e `history`. Si falla NO tumba el alta: queda en `whatsapp_account_events`
(`field: 'history_sync_request'`) y avisa a plataforma (plazo 24 h). `services/whatsapp-coexistence.service.ts`:
`created_at = wa_timestamp` en lo histórico, un upsert por hilo (arreglo) en vez de uno por mensaje, y registra `2593109`
y `progress: 100` para responder «¿ya sincronizó?». A mano: campo `history` suscrito en App Dashboard.

**T2 · Audiencias** (nuevo `services/whatsapp-audiencias.service.ts`):
- `clasificarConversacion(entrantes, salientes, palabrasSede)`, pura: `intencionDeProspecto` + `interesesDeProspecto`
  (`cortesia`→`clase_prueba`, `inscripcion`) + regex nueva `clinica|campamento`; sede por `palabras_sede` sobre entrantes y
  ecos de la escuela (las dos o ninguna → null). Sin intención clara no entra.
- `clasificarIntegracion`: solo con `habilitadas`; lee `whatsapp_messages` por `integration_id` (`idx_wa_msg_integration`)
  de a 1000, por `wa_timestamp` ≤ `antiguedad_max_dias`; agrupa en memoria; exclusiones por lotes de 500
  (`wa_audiencia_excluidos` + marcas manuales + `opted_out_at`); upsert de a 500. Incremental por `last_inbound_at`.
- Haiku para ambiguos (después): 20 conversaciones por llamada a `generarJsonEstructurado`, `fuente='modelo'`.
- `bff/scripts/wa-audiencia.ts --escuela <id> [--aplicar]`: conteos por interés y sede, teléfonos enmascarados.

**T3 · Motor** (nuevos `services/whatsapp-campanas.service.ts` y `whatsapp-campanas-freno.ts`):
- `plantillaDeCampana`: fila APPROVED + `category='MARKETING'` + misma `waba_id` + variables y 3 QUICK_REPLY que cuadran.
  Es el ÚNICO camino que manda MARKETING; `plantillaAprobada` (cobranza) queda igual.
- `armarPayloadCampana`: `armarPayloadPlantilla` + `{type:'button', sub_type:'quick_reply', index, parameters:[{type:
  'payload', payload:'smc:<campana_id>:si|luego|baja'}]}`. `{{1}}` = primer nombre limpio de `contact_name` o «familia» (P3).
- `runCampanas()`, cron `*/10` en `jobs/maintenance.job.ts` (junto a `:569`, bajo `DISABLE_WHATSAPP_QUEUE_CRON`): una
  consulta a campañas `aprobada|enviando` (tabla chica; sin campañas = cero IO). Por campaña: interruptor, `vence_at`,
  horario, freno, cupo del tick = restante del día ÷ ticks restantes (no 200 a las 7:00; día 1 = `lote_piloto`), límite de
  Meta del último `current_limit` (TIER_250 → 250), `wa_campana_tomar_lote`, envío en serie (≤ 20 mps), `UPDATE` a
  'enviado' ANTES de `wa_record_outbound_message` (`step:'campana'`, `campana_id`, `automatico:true`). Salta (pospone
  24 h) a quien tiene la ventana abierta o una persona de la escuela le escribió en 12 h.
- Reintentos: error de Graph al enviar → 'pendiente' a 5 min / 30 min / 2 h, máx. 3 → 'fallido'. Asíncronos: se concilian
  leyendo `whatsapp_messages.status/error_detail` con `.in('wa_message_id', lote)` (los escribe `procesarEstados`,
  `routes/whatsapp.ts:197-233`): 131050 (no quiere marketing) → baja; 131049 (tope de Meta por usuario) → 1 reintento a
  las 24 h; otro → 'fallido'. Códigos a confirmar contra la tabla de errores de Meta.
- `frenoDeCalidad` (puro + lectura) pausa la escuela con: Graph `quality_rating` YELLOW/RED (1 GET por tick y número);
  `phone_number_quality_update` con `event` FLAGGED/DOWNGRADE posterior a la aprobación; la plantilla en
  `message_template_quality_update` YELLOW/RED o fuera de APPROVED; bajas > 5 % o fallos > 20 % de lo entregado en 24 h.
  Pausa = `ajustes.pausada_at` + campaña 'pausada' + `notifications` a `adminsDeEscuela` + correo a soporte; reanudar a mano.
- `bff/scripts/wa-campana.ts crear|simular|aprobar|pausar|estado` (respaldo de la pantalla; `simular` no envía).

**T4 · Respuestas** (nuevo `services/whatsapp-campana-respuesta.service.ts` + 1 gancho en `routes/whatsapp.ts`,
`handleBotTurn` antes de `debeAtender` `:565`), solo si `msg.botonId` empieza por `smc:`:
- `baja` → `wa_register_optin(p_opt_out=true, source_ref=wamid)`, audiencia `excluido='baja'`, envío 'baja', confirmación
  con `deliver(…, {step:'opt_out_confirmado'})`. `luego` → 'respondio_luego' + texto corto.
- `si` → 'respondio_si'; `respuesta_si` (texto que la escuela aprobó) sale directo por la ventana recién abierta aunque el
  bot esté en asistido; respeta tomada y modo discreto; `registrarLeadDeProspecto` con los entrantes que dieron la
  intención; `abrirEnBuzon` + push «X respondió Sí».
- Texto libre «no me interesa / no más / no me escriban» con la plantilla como último saliente < 72 h →
  `excluido='no_interesa'` (A-06 de la auditoría 10-28: la baja hoy solo reconoce 6 palabras exactas).

**T5 · Plantillas y pantalla.** `routes/whatsapp-admin.routes.ts:925-1011`: `pie?` (FOOTER) y `botones_rapidos?` (≤3,
≤25 car.); sin ellos el cuerpo a Meta es idéntico al de hoy. Nuevo `routes/whatsapp-campanas.routes.ts` (montado en
`index.ts:349`): ajustes (lectura), conteos de audiencia, campañas (borrador, conteo, aprobar con declaración,
pausar/reanudar, avance). Frontend: nuevo `components/whatsapp/Campanas.tsx` (+test) y pestaña en `pages/WhatsAppPage.tsx`
(`:404-428`); en `PanelPlantillas` (`:561`) pie y botones. Tarjeta: «Lista: N personas · [Aprobar y enviar]» + avance.

**T6 · Textos de Monster.** Nuevos `bff/whatsapp-templates/escuelas/monster/*.json` (subcarpeta: ni `register-templates.sh`
ni el catálogo la leen). Recomiendo **una plantilla combinada** (regalo + clínica): un toque por persona y cabe antes del
9-nov. Borrador `monster_cierre_2026` (MARKETING, lo confirma Monster): «¡Hola {{1}}! 🏐 Hace un tiempo nos escribiste a
Monster´s Volley Club preguntando por clases. Dos novedades: si te matriculas antes del 30 de noviembre, noviembre te sale
gratis 🎁, y el 21 y 22 de noviembre es nuestra Clínica de Voleibol (preventa hasta el 9 de noviembre). ¿Te enviamos la
información?» · pie «Puedes dejar de recibir promociones cuando quieras» · [Sí, cuéntame] [Más adelante] [No recibir más].
SQL de encendido (lo corre el usuario): fila en `whatsapp_campanas_ajustes` con `habilitadas=true`, base de §5 y
`palabras_sede` (Norte: norte, 201, La Enseñanza · Suba: suba, 152, Pinar, Fesan, Lestonnac, Oxxo).

**T7 · Lo que escribe después del «Sí»** (la otra sesión ya commiteó `whatsapp-bot.service.ts` en `4fa30a67` durante
este plan; avisarle antes de tocarlo): `seguimientoQueContesta` (`:3330`) acepta también `step:'campana'`, y lo contesta el bot con la ficha
(Haiku) en vez de callar por `escuelaLeEscribioEnDias`. Mientras tanto el «Sí» queda en el buzón con aviso a una persona.

## 4. Apagado para las demás escuelas
Sin fila en `whatsapp_campanas_ajustes`: el clasificador no corre, el cron no encuentra campañas, aprobar responde 409 y
nada lee `whatsapp_messages`. El gancho del webhook solo mira `botonId` con `smc:` (solo nuestras plantillas lo llevan).
La cobranza y el envío manual siguen bloqueando MARKETING. T1 solo cambia altas NUEVAS (Dynasty no se reconecta).

## 5. Consentimiento: lo que se puede citar y la decisión
- Política citada en el repo (mig. `20260909215933:16-20`, whatsappbusiness.com/policy, verificada 2026-09-09): se puede
  escribir si «you have received opt-in permission from the recipient confirming that they wish to receive subsequent
  messages». La guía de opt-in de Meta (leída hoy) pide decir con claridad que la persona acepta recibir mensajes y **el
  nombre del negocio**, admite opt-in general «as long as businesses comply with all local laws», pide salida clara y
  avisa que la calidad baja con bloqueos y reportes. **No dice** que escribir primero cuente como opt-in.
- El repo ya decidió que no cuenta: «Los contactos que ya escribieron abrieron la ventana, no consintieron; insertarlos
  sería fabricar consentimiento» (mig. `20260909215933`, nota final). La auditoría 10-28 (D-03) agrega que el
  consentimiento del bot es el de Meta y no el de la Ley 1581.
- **Pregunta (P1):** (A) solo opt-in vigente: Monster tiene 0, la campaña del historial no llega a nadie; sirve para lo
  que entre desde ahora (el «sí» del bot de B2). (C) `contacto_previo_declarado`: un mensaje por persona, solo a quien
  preguntó por clase de prueba, inscripción o clínica en 180 días y no está inscrito, con «No recibir más», piloto de 50,
  freno, y la escuela declarando al aprobar que esas personas le escribieron pidiendo información. **Recomiendo C
  acotada, solo con Monster aceptando el riesgo por escrito** (es su número de diario) **y con revisión legal** (Ley 1581 y
  D11); el «Sí» abre la ventana y ahí se pide el consentimiento real. Si la asesoría dice no, A usa el mismo código.

## 6. Pruebas (vitest; archivos nuevos salvo los 3 tocados)
Puras: clasificador (clase de prueba Suba, matrícula, clínica, saludo, sin intención, dos sedes); cupo (TIER_250 − usados,
piloto, reparto); horario (domingo, 2-nov, sáb 15:01); freno (FLAGGED/DOWNGRADE y YELLOW pausan; ONBOARDING y
ACCOUNT_DELETED no); payload (3 `smc:`, nombre → «familia»); conciliación (131050, 131049, otro); lease vencido →
'incierto' sin reenvío. Con supabase/fetch simulados: aprobación = conteo previsto; 2.º tick no reenvía; botón baja →
opt-out; escuela sin ajustes → 1 lectura; `botonId` sin `smc:` → camino de hoy; POST de plantillas sin campos nuevos →
cuerpo idéntico; T1: `smb_app_data` ×2 tras alta con coexistencia y alta intacta si falla; historial con `created_at =
wa_timestamp` y un upsert por hilo. Base: invariantes, 42501 como `authenticated`, dos `wa_campana_tomar_lote` en
paralelo → filas disjuntas. En vivo: WABA de prueba (`838ccd56…`), plantilla MARKETING con botones, campaña a 1 tester.

## 7. Riesgos y choques
1. Sin T1 en `main` antes del alta no hay audiencia (§0); si Monster no comparte el historial (`2593109`), respaldo: CSV
   del Google Form de Monster → `fuente='importado'` (script de T2) y los que escriban desde el alta.
2. Una integración por escuela (P2). 3. Monster necesita método de pago en su WABA (en coexistencia paga ella el
   marketing); tarifa de Meta para Colombia por confirmar. 4. Aprobación de la plantilla: minutos a ~1 día; fechas en el
   texto → `vence_at`. 5. El tope de Meta por usuario (131049) baja la entrega sin ser error nuestro.
6. Choques (git status): `whatsapp-bot.service.ts` lo edita otra sesión (commit `4fa30a67` de hoy; coordinar T7);
   `migrations_ledger.json` modificado sin commit (crear la migración después; una sola sesión aplica);
   `docs/specs/whatsapp-monster-requerimientos.md` modificado (no tocarlo en este lote); `maintenance.job.ts` también está
   en T5 de B2/B3 (B5 entra primero). B5 no toca `MyPaymentsPage.tsx`, `EnrollmentIntakeInboxPage.tsx` ni `enrollment-intake/`.
7. Webhook y crons solo corren en prod: B5 tiene que llegar a `main` cuando el usuario lo pida, con pushes agrupados.

**Preguntas:** P1 consentimiento (§5). P2 ¿uno o dos números? ¿Cuál (319 450 5150 o 318 868 2241)? P3 `{{1}}` = nombre
con respaldo «familia», o sin variable. P4 la clínica a afiliados ($250.000) no va por marketing (sin opt-in): ¿aviso
in-app/push/correo existente? P5 ¿plantilla combinada o dos campañas a 7 días? P6 ¿pedir y guardar el sync de contactos
(una sola vez; trae la agenda personal de la dueña)? P7 D11 (Ley 2300 para marketing).

## 8. Tareas en paralelo (sin archivos en común)
| T | Archivos exclusivos | Depende de |
|---|---|---|
| T0 | migración nueva, `migrations_ledger.json`, al final `types.ts` | aprobación; commit del ledger ajeno |
| T1 | `whatsapp-onboarding.service.ts`, `whatsapp-coexistence.service.ts`, 2 tests nuevos | nada → `main` ya |
| T2 | `whatsapp-audiencias.service.ts`(+test), `scripts/wa-audiencia.ts` | RPC de T0 (inyectada en tests) |
| T3 | `whatsapp-campanas.service.ts`, `whatsapp-campanas-freno.ts`(+tests), `jobs/maintenance.job.ts`, `scripts/wa-campana.ts` | T0 |
| T4 | `whatsapp-campana-respuesta.service.ts`(+test), `routes/whatsapp.ts` | T0; formato `smc:` de T3 |
| T5 | `whatsapp-admin.routes.ts`, `whatsapp-campanas.routes.ts`, `index.ts`, `Campanas.tsx`(+test), `WhatsAppPage.tsx` | contratos de T3 |
| T6 | `bff/whatsapp-templates/escuelas/monster/*.json` | textos de Monster |
| T7 | `whatsapp-bot.service.ts` + test nuevo | aviso a la sesión que lo edita (ya commiteó `4fa30a67`) |

## 9. Camino más corto (clínica y regalo saliendo cuanto antes)
No hay envíos el 1-nov (domingo), el 2-nov (festivo) ni el 8-nov: quedan mar 3 → sáb 7 antes del cierre de la preventa
(≈ 50 + 4 × 200 ≈ 850 personas con el tope de 250 de Meta).
- **Imprescindible, en orden:** (1) T1 en `main` + `history` suscrito → (2) Monster conecta, comparte el historial y carga
  método de pago → (3) T6: plantilla combinada registrada por script → (4) T0 aplicada → (5) T2 solo reglas, una pasada al
  terminar el historial → (6) T3 + T4 en `main` (interruptor, horario, cupo, piloto, idempotencia, freno, 3 botones,
  `respuesta_si` fija, avisos) → (7) aprobación con `wa-campana.ts aprobar --por <admin>` tras el «sí» escrito de Monster
  al conteo (respaldo manual de la pantalla).
- **Puede esperar:** T5 (pantalla), Haiku para ambiguos, sede (D6: la oferta es igual en las dos), sync de contactos, T7,
  CSV y la **secuencia d1/d3/d7**, que no sale gratis: necesita el consentimiento del interesado nuevo (B2,
  `bot_prospecto`) y reglas de parada atadas a las etapas del lead que cambian B2/B3; el seguimiento de 20 h ya cubre el
  día 1 dentro de la ventana. La tabla de envíos la admite después (columna `paso`), ~1 día sobre B2.
