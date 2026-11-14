# Plan B2 + B3 · Embudo del interesado y agenda automática de la clase de prueba (por escuela)

Estado: **borrador para aprobar, sin código ni migración escrita.** Base: spec `docs/specs/whatsapp-monster-requerimientos.md`
(§2, §3, §4 B2/B3, §5), maqueta pasos 1-5 y 11, migración viva `20261029215003_cobro_clase_prueba.sql`.
Esquema verificado en la base el 2026-10-29 con 6 consultas puntuales a `information_schema`, `pg_constraint`,
`pg_policies` y `pg_proc`, filtradas por tabla o función.

## 1. Qué existe hoy (file:line, rutas bajo `bff/src` salvo aviso)

**Entrada del desconocido** (`services/whatsapp-bot.service.ts`)
- `atenderDesconocido` :2581. Orden: llegada :2624 → cortesía en curso :2644 → **puerta en curso :2654** → OTP → …
  → filtro de tema/prospecto :2784 → bienvenida al saludo suelto :2790 (solo env `WA_BIENVENIDA_DESCONOCIDOS_SCHOOL_IDS`,
  `whatsapp-bienvenida.ts:30`) → **primera respuesta al prospecto :2975-3026** (`iniciarCortesia` con «*clase de cortesía* gratis»
  :3009-3014) → enlace :3028.
- La **puerta de 3 botones** solo arranca en el camino de identificación :2088-2096 y **no** con modo discreto (:2083, global por env).
- `ctxPuerta` :2129-2186 (guarda el lead con `registrarLeadDeProspecto`, grupo por edad, precios, enlace). `ctxCortesia` :1525-1555.
- Consentimiento: `registrarOptIn` :3732 llama `wa_register_optin` con `source='user_confirmed'`. Al desconocido que toca el botón
  `CONSENTIR_SI` se le contesta «este número no está registrado» (`respuestaConsentimientoSinCuenta` :2563, usada en :2614).
- «Gratis» en la salida: `whatsapp-clase-cortesia.service.ts:731,733,983,1001,1106`, `whatsapp-bot.service.ts:2743,3009-3014,3204,5572`,
  prompt :4003, descripción de la tool :4050, `whatsapp-cortesia-semana.service.ts:133` (modo `semana_app`), prompt de IA
  `whatsapp-prospecto-ia.service.ts:167,170`.

**Puerta y mini-registro** (`services/whatsapp-puerta-desconocido.ts`): botones fijos :62-66, `iniciarPuerta` :222,
`atenderTurnoPuerta` :232. El mini-registro tiene 4 preguntas fijas (nombre, edad, acudiente, qué quiere) :323-415 y la
lectura múltiple está en `leerNombreDeDeportista` :189 (nombre + fecha). El estado viaja en el payload del último saliente
(`flujo/paso_puerta/datos_puerta`) :474. Ajustes por escuela: `whatsapp-ajustes-escuela.service.ts`, con fallback por columnas
:62-66 y lectura que nunca lanza.

**Clase de cortesía del bot** (`services/whatsapp-clase-cortesia.service.ts`): `CtxCortesia` :192-231 (inyectable),
`filtrarPorPerfil` :530 (edad + género por nombre, **sin sede ni nivel**), `iniciarCortesia` :954, `reservar` :1577-1654
(gratis, sin pago), `franjasDeSupabase` :1783-1835 (lee `team_id`, rango de edad, y **dirección de la sede** por nombre con
`direccionDeSede` :1764, que usa *contains* y por eso confunde «Pinar» con «Pinar 2»). `reservarEnSupabase` :1880 →
`submit_school_lead` (`FOR UPDATE` del cupo, `reserved_count+1`). Aviso **solo a dueño/admins**: `cortesia-reservas.service.ts`
`destinatariosIds` :362, `avisarCortesia` :379 (inserta en `notifications` y además llama `sendToUser`).

**Generador** (`services/franjas-cortesia.service.ts`): `planificarFranjas` :136-198 (puro, salta festivos :168),
`compararConExistentes` :209-230 (nunca reabre una franja cerrada), `filaParaInsertar` :233-250 (`max_capacity=999`),
`runFranjasCortesia` :386 (solo escuelas con `courtesy_from_training`). El cron de las 05:30 está en `jobs/maintenance.job.ts:987`.

**Grupos** (`services/grupos-por-edad.service.ts`): `construirRangos` :231-308 convierte `birth_year_*` en una edad
aproximada (:263-267, ±1 año), `elegirGrupo` :329-377. `rangosDeEscuela` :474 **no lee** `branch_id`, `level` de la categoría
ni coaches. `nivelDeNombre` :125 sale del nombre.

**Horario de hoy para afiliados**: `whatsapp-info-escuela.service.ts` `horariosDelDia` :509, solo con `teams.schedule`.
**Asistencia**: `cortesia-reservas.service.ts` `marcarAsistencia` :272. Su ruta `routes/whatsapp-cortesias.routes.ts:53`
es **solo para la administración**, así que el coach recibe 403.
**Recordatorio**: `recordatorio-cortesia.service.ts:177` lee los leads con `trial_slot_id`.
**Medios de pago**: `whatsapp-medios-de-pago.service.ts:83`, `mediosDePago(schoolId, { categoria })`.
**Despachador unificado**: un `INSERT` en `notifications` encola en `notification_deliveries`
(`jobs/notifications-dispatch.job.ts`; patrón en `plan-por-asistencia-aviso.service.ts:81-106`). Las claves idempotentes
usan `uuidDeClave` (`avisos-correo.service.ts:78`).
**Número de pruebas**: `config/cortafuegos-simulacion.ts`. Bloquea escrituras y RPC que no estén en la lista (`SIM00`);
`enSimulacion()` está en `whatsapp-bot.service.ts:177`.

**Base viva** (consultada hoy):
- Franjas y equipos: `school_trial_slots` tiene `team_id` y `generated_from_schedule`, pero **no** `branch_id`, coach ni
  dirección (CHECK `reserved_count <= max_capacity`, `max_capacity > 0`). `teams` tiene `branch_id`, `category_id`,
  `facility_id`, `level`, `coach_id` (legado), `schedule` y `admite_nuevos`. `school_categories` tiene `branch_id`, `level`
  (sin CHECK), `rama` (CHECK) y `birth_year_min/max`. `facilities` tiene `branch_id` y **no tiene dirección**.
- Leads y ajustes: `school_signup_leads` **no tiene** `branch_id`, `team_id` ni `respuestas`. `school_trial_class_settings`
  tiene `payment_mode` y `trial_price`; su única policy es SELECT para la administración.
- Consentimiento: `whatsapp_optins.source` tiene un CHECK con 6 valores; `integration_id` y `source_ref` son NOT NULL;
  `wa_register_optin` solo da EXECUTE a `service_role`.
- Acceso del coach: `school_signup_leads` y `school_trial_slots` no tienen policies para `authenticated` (el coach necesita
  una RPC). `team_coaches` lo lee el staff.
- No existe todavía: `team_schedule_exceptions`. `coach_availability` existe, pero es del módulo de la app.
- `notifications.category` tiene CHECK; `enrollment` sirve.
- El módulo de la app `trial_class_*` (`routes/trial-classes*.ts`, cobro en `20260829115629:330-343`) **no se usa**: sigue aparte.

**Frontend**:
- `components/coach/v2/CoachSessionsV2.tsx`: la pestaña **Semana** `TabSemana` :398-505 ya muestra la semana del coach desde
  `teams.schedule` (`sesionesModel.ts` `entrenosDelHorario` :163). El horario base se edita en `equipos/AgregarHorarioSheet.tsx`.
  La ruta es `/training-plans` → `SesionesSegunRol` (`components/v2/RutasSegunRol.tsx:99`).
- Deportistas → Clase de prueba: `components/students/ClasePruebaPanel.tsx` ← `hooks/useClasePrueba.ts:101`
  ← RPC `listar_clase_prueba` (`20261026155701:249`).

## 2. Borrador de migración (NO escribir hasta que se apruebe; crear con `npm run migrations:new -- embudo_y_agenda_clase_prueba`)

Usa `trial_price` (20261029215003) en vez de `precio_whatsapp`, y `payments.signup_lead_id` en vez de
`school_signup_leads.payment_id`. Sin `IF NOT EXISTS` (que falle si algo choca). Todo el DDL va en una sola transacción.

```sql
-- 1. Ajustes del embudo (school_settings). Todos nacen NULL/false = el comportamiento de hoy.
ALTER TABLE public.school_settings
  ADD COLUMN wa_bienvenida text CHECK (wa_bienvenida IS NULL OR length(wa_bienvenida) <= 1000),
  ADD COLUMN wa_pregunta_sede boolean NOT NULL DEFAULT false,
  ADD COLUMN wa_preguntas_prospecto jsonb CHECK (wa_preguntas_prospecto IS NULL OR jsonb_typeof(wa_preguntas_prospecto) = 'array'),
  ADD COLUMN wa_regla_nivel jsonb CHECK (wa_regla_nivel IS NULL OR jsonb_typeof(wa_regla_nivel) = 'object');
-- 2. Agenda (school_trial_class_settings). NULL = como hoy.
ALTER TABLE public.school_trial_class_settings
  ADD COLUMN nombre_clase text CHECK (nombre_clase IS NULL OR nombre_clase IN ('cortesia','prueba')),
  ADD COLUMN separar_horas smallint CHECK (separar_horas IS NULL OR separar_horas BETWEEN 1 AND 72),  -- NULL = sin flujo de pago en el bot
  ADD COLUMN cupos_por_sesion smallint CHECK (cupos_por_sesion IS NULL OR cupos_por_sesion BETWEEN 1 AND 500), -- NULL = 999
  ADD COLUMN agendar_al_recibir boolean NOT NULL DEFAULT true,   -- D9
  ADD COLUMN avisar_entrenador boolean NOT NULL DEFAULT false;
-- 3. Lead del embudo. El cupo SEPARADO va en columnas propias: trial_slot_id sigue significando «agendada»
--    y los lectores de hoy (recordatorio, llegada, listados, cancelar) no cambian.
ALTER TABLE public.school_signup_leads
  ADD COLUMN branch_id uuid REFERENCES public.school_branches(id) ON DELETE SET NULL,
  ADD COLUMN team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  ADD COLUMN respuestas jsonb CHECK (respuestas IS NULL OR jsonb_typeof(respuestas) = 'object'),
  ADD COLUMN cupo_separado_slot_id uuid REFERENCES public.school_trial_slots(id) ON DELETE SET NULL,
  ADD COLUMN cupo_separado_hasta timestamptz,
  ADD CONSTRAINT chk_lead_cupo_separado CHECK ((cupo_separado_slot_id IS NULL) = (cupo_separado_hasta IS NULL));
CREATE INDEX idx_leads_cupo_separado ON public.school_signup_leads (cupo_separado_hasta) WHERE cupo_separado_hasta IS NOT NULL;
-- 4. Dirección de la cancha (D3) y por qué se cerró una franja (solo el generador reabre las suyas).
ALTER TABLE public.facilities ADD COLUMN address text;
ALTER TABLE public.school_trial_slots ADD COLUMN cerrada_por text CHECK (cerrada_por IS NULL OR cerrada_por IN ('escuela','horario'));
-- 5. Consentimiento del interesado.
ALTER TABLE public.whatsapp_optins DROP CONSTRAINT chk_wa_optin_source;
ALTER TABLE public.whatsapp_optins ADD CONSTRAINT chk_wa_optin_source CHECK (source = ANY (ARRAY['user_confirmed','form_inscripcion',
  'invitacion','import','admin_manual','baja_directa','bot_prospecto']));
-- 6. Semana del profe.
CREATE TABLE public.team_schedule_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  fecha date NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('cancelada','movida','extra')),
  hora_original time,                        -- sesión del horario base (NULL en 'cancelada' = todo el día)
  hora_inicio time, hora_fin time, lugar text CHECK (lugar IS NULL OR length(lugar) <= 120),
  creado_por uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (tipo <> 'movida' OR (hora_original IS NOT NULL AND hora_inicio IS NOT NULL)),
  CHECK (tipo <> 'extra' OR (hora_inicio IS NOT NULL AND hora_original IS NULL)),
  CHECK (hora_fin IS NULL OR hora_inicio IS NULL OR hora_fin > hora_inicio));
CREATE UNIQUE INDEX uq_tse_sesion ON public.team_schedule_exceptions (team_id, fecha, tipo, COALESCE(hora_original, hora_inicio, '00:00'::time));
CREATE INDEX idx_tse_escuela_fecha ON public.team_schedule_exceptions (school_id, fecha);
ALTER TABLE public.team_schedule_exceptions ENABLE ROW LEVEL SECURITY;
-- Helper de POLICY: SECURITY DEFINER (lee teams/team_coaches sin recursión) y GRANT a authenticated (lo evalúa la policy).
CREATE FUNCTION public.puede_editar_semana_equipo(p_team_id uuid, p_school_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.teams t WHERE t.id = p_team_id AND t.school_id = p_school_id AND (
      t.school_id = ANY (public.user_admin_school_ids())
   OR (t.school_id = ANY (public.user_staff_school_ids())
       AND (t.coach_id = auth.uid() OR EXISTS (SELECT 1 FROM public.team_coaches tc WHERE tc.team_id = t.id AND tc.coach_id = auth.uid())))));
$$;
REVOKE ALL ON FUNCTION public.puede_editar_semana_equipo(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.puede_editar_semana_equipo(uuid, uuid) TO authenticated;
CREATE POLICY tse_select_miembros ON public.team_schedule_exceptions FOR SELECT TO authenticated
  USING (school_id = ANY ((SELECT public.user_school_ids())::uuid[]));              -- lectura: miembros
CREATE POLICY tse_insert_staff_equipo ON public.team_schedule_exceptions FOR INSERT TO authenticated
  WITH CHECK (creado_por = auth.uid() AND public.puede_editar_semana_equipo(team_id, school_id));
CREATE POLICY tse_update_staff_equipo ON public.team_schedule_exceptions FOR UPDATE TO authenticated
  USING (public.puede_editar_semana_equipo(team_id, school_id)) WITH CHECK (public.puede_editar_semana_equipo(team_id, school_id));
CREATE POLICY tse_delete_staff_equipo ON public.team_schedule_exceptions FOR DELETE TO authenticated
  USING (public.puede_editar_semana_equipo(team_id, school_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_schedule_exceptions TO authenticated;   -- anon: nada
-- 7. RPC para la pantalla (alcance validado ADENTRO y atado a ESE id). REVOKE … FROM PUBLIC, anon + GRANT … TO authenticated.
--  repetir_semana_equipo(p_team_id uuid, p_lunes date) RETURNS jsonb: crea varias filas, por eso es RPC transaccional.
--     Valida puede_editar_semana_equipo(p_team_id, (school del team)) y copia las excepciones de [p_lunes-7, p_lunes-1]
--     corridas +7 días, con ON CONFLICT (uq_tse_sesion) DO NOTHING. Devuelve {copiadas}.
--  clases_prueba_semana(p_school_id uuid, p_desde date, p_hasta date) RETURNS jsonb, STABLE: si es admin de p_school_id, todas;
--     si es staff de p_school_id, solo las franjas de equipos donde es coach (team_coaches o teams.coach_id). Devuelve los leads
--     con trial_slot_id o con cupo separado en el rango: nombre, año, sexo, respuestas, franja, equipo, estado del cupo, pago
--     (payments.signup_lead_id) y asistencia. SIN teléfono. Tope de 300.
--  marcar_clase_prueba_entrenador(p_lead_id uuid, p_asistencia text, p_team_recomendado uuid DEFAULT NULL) RETURNS jsonb:
--     FOR UPDATE del lead. Lo puede usar un admin de lead.school_id o el coach del equipo de su franja.
--     p_asistencia IN ('asistio','no_vino') o NULL. Si viene p_team_recomendado, tiene que ser de la misma escuela.
--     Escribe source_detail.asistencia/_at/_por; con 'asistio', además etapa='asistio'. El equipo recomendado va a lead.team_id
--     y el que eligió el bot queda en source_detail.team_id_bot.
-- 8. RPC solo para el BFF (service_role): REVOKE ALL … FROM PUBLIC, anon, authenticated, sin GRANT. Candados: primero el lead,
--    después los cupos ordenados por id (el mismo orden que wa_cancelar_clase_de_prueba).
--  tomar_cupo_clase_prueba(p_lead_id uuid, p_slot_id uuid) RETURNS jsonb
--     FOR UPDATE del lead y de los cupos (el anterior y el nuevo). Valida que el cupo sea de la misma escuela, esté abierto y
--     tenga cupo (reserved_count < max_capacity). Si el lead ya pagó (payments.signup_lead_id con status paid/awaiting_approval),
--     o trial_price es 0/NULL, o separar_horas es NULL: AGENDA (trial_slot_id = nuevo y se suelta el anterior o el separado).
--     Si no: SEPARA (cupo_separado_slot_id/hasta = now() + separar_horas y se suelta el separado anterior).
--     El contador se mueve +1/−1 en la misma transacción. Devuelve {estado:'agendada'|'separada'|'lleno'|'cerrada', hasta}.
--  confirmar_cupo_clase_prueba(p_lead_id uuid, p_payment_id uuid) RETURNS jsonb
--     FOR UPDATE del lead. El pago tiene que tener payment_category='clase_prueba', signup_lead_id=p_lead_id, misma escuela y
--     status paid/awaiting_approval. Si hay un cupo separado (vigente o vencido pero todavía con lugar), lo pasa a trial_slot_id.
--     Devuelve {estado:'agendada'|'ya_agendada'|'sin_cupo'|'sin_separar', slot_id}. Es idempotente.
--  soltar_cupos_separados(p_lead_id uuid DEFAULT NULL, p_limite int DEFAULT 200) RETURNS jsonb
--     Con p_lead_id NULL toma los vencidos, con FOR UPDATE SKIP LOCKED. Si el lead ya tiene pago, confirma en vez de soltar
--     (cubre el pago registrado a mano y el D9 «al revisar»). Si no, reserved_count−1 y limpia las columnas.
--     Devuelve [{lead_id, school_id, phone, accion:'confirmada'|'liberada'}].
-- 9. listar_clase_prueba: CREATE OR REPLACE a partir del cuerpo VIVO (pg_proc, no del archivo de 20261026155701), solo
--    AGREGANDO sede, grupo, profe, respuestas, estado_cupo ('separado'|'agendada'), separado_hasta y pago.
```
Después: `npm run seguridad:invariantes` (I1-I4), sesión simulada de un coach de Monster y de un padre
(`set_config('request.jwt.claims', …)`) contra la policy y las RPC, `select … from pg_policies where tablename='team_schedule_exceptions'`,
y `types.ts` **una sola vez** al final del lote.

## 3. Cambios archivo por archivo

**BFF: archivos nuevos**
- `services/whatsapp-embudo-prospecto.ts`: motor puro con `CtxEmbudo` inyectable, igual que la puerta. El estado viaja en el
  payload (`flujo:'embudo'`, `paso_embudo`, `datos_embudo`) con 24 h de vigencia. Los botones llevan el prefijo `sm_em_`.
  Pasos: `sede` → `pregunta[i]` → `grupo` → `elegir_franja` → `esperando_pago` | `consentimiento`.
  - Bienvenida: `wa_bienvenida`. Botones `Sede {name}` (≤20) de las `school_branches` activas, más «Ya soy del club» con id
    `BOTON_PUERTA.CLUB`, que lo atiende la puerta de hoy sin código nuevo. Con más de 2 sedes, lista.
    `leerSede()` entiende «Suba», «la del norte» y «calle 152» por nombre o dirección.
  - Preguntas: `preguntasDesdeJson()` valida el jsonb; si es inválido, el embudo queda apagado. Tipos `texto|fecha|botones|lista`.
    Hay un `detalle` condicional (trayectoria «club»). Claves reservadas: `nombre`→full_name, `fecha_nacimiento`→birth_date
    (acepta solo el año), `sexo`→gender. Las demás van a `respuestas`. Varias respuestas en un mensaje se rellenan con
    `leerNombreDeDeportista`, `leerPerfil` y las opciones normalizadas. Dos intentos fallidos → pasa a una persona con lo que haya.
  - Grupo: `elegirGrupoEmbudo` (T3). Sin grupo: botón «Ver Sede X» si la otra sede tiene uno, o persona con el lead guardado.
    Nunca inventa.
  - Franjas: lista propia (fila «Sáb 31 oct · 8:00–10:00», descripción «Sede/cancha · Profe Iván · N cupos»; sin cifra si es 999).
  - Al elegir: `tomarCupo`. Si queda **separada**: `mediosDePago(schoolId,{categoria:'clase_prueba'})`. Si no hay cuentas
    (Monster hoy) → persona y se suelta el cupo. Si hay: texto de instrucciones y `registrarConceptoEsperado(schoolId, telefono,
    {motivo:'clase_prueba', monto: trial_price, leadId, venceEn: hasta})` (B4, inyectado).
    Si queda **agendada** (gratis o ya pagó): confirmación + consentimiento.
  - Consentimiento: [Sí, claro][No, gracias] (`sm_em_optin_si|no`) → `wa_register_optin` con `p_source:'bot_prospecto'`.
  - «Cambiar horario»: vuelve a ofrecer las franjas de `lead.team_id` → `tomarCupo` (agenda directo porque ya pagó).
- `services/clase-prueba-agenda.service.ts` (contrato con B4):
  `tomarCupo(leadId, slotId)`, `confirmarClasePruebaPagada({schoolId, leadId, paymentId, telefono}): Promise<{texto}>`
  (RPC confirmar → franja enriquecida → texto «Tu clase quedó agendada 🎉 📅 … 📍 {cancha} · {dirección} 👤 Te recibe el profe
  {nombre} 🎒 {wa_cortesia_indicaciones, o nada}» → `avanzarEtapaLead(…,'agendado')` → `avisarEntrenador` →
  `avisarCortesia('reservada')` a los admins).
  También: `runCuposSeparados()` para el job y `avisarEntrenador(evento, lead, franja)`.
  `avisarEntrenador` solo corre con `avisar_entrenador=true`. Destinatarios: `team_coaches.coach_id ∪ teams.coach_id`.
  Solo hace el `INSERT` en `notifications` con id `uuidDeClave('clase_prueba_coach:{evento}:{lead}:{slot}:{uid}')`, categoría
  `enrollment` y link `/training-plans?tab=semana&fecha=…`. Sin `sendToUser`: entrega el despachador.
  Eventos: agendada, cambiada, cancelada, llegada. Este archivo **no importa** nada de B4 (no hay ciclo).
- `services/semana-equipo.service.ts`: `sesionesDelDia(schedule, excepciones, fecha)`, puro y compartido por el generador, el
  horario de hoy y el bot. También `excepcionesDeEscuela(schoolId, desde, hasta)` con caché de 10 min.
- `services/textos-clase-prueba.ts`: `textosDeClase({nombre_clase, trial_price})` → `{nombre:'clase de cortesía'|'clase de prueba',
  gratis:boolean, precio:'$15.000'|null}`. Los textos por defecto son **los literales de hoy**.

**BFF: archivos existentes**
- `services/whatsapp-ajustes-escuela.service.ts`: `AjustesWhatsAppEscuela` gana `bienvenida`, `preguntaSede`,
  `preguntasProspecto`, `reglaNivel`; nueva primera fila en `COLUMNAS` (el fallback sigue sirviendo sin la migración).
  Más `ajustesClasePrueba(schoolId)` (nombre_clase, trial_price, separar_horas, cupos, agendar, avisar). Nunca lanza.
- `services/whatsapp-bot.service.ts`, el único cableado. (a) `atenderEmbudoEnBot` justo después de la puerta (:2654) y una rama
  antes de :2614 para `sm_em_optin_*`. (b) En :2975, si `embudoActivo` → `iniciarEmbudo` en vez de semana/cortesía/enlace, con el
  mismo step `PASO_DESCONOCIDO_ESCOLAR` (sigue contando para el freno de 30 días). (c) En :2088-2096, embudo en vez de la puerta
  de 3 botones. (d) En :2790, saludo suelto → bienvenida del embudo (P4). (e) `ctxEmbudo`. (f) `textosDeClase` en
  :2743, 3009-3014, 3204, 5572 y una línea por escuela en el prompt cuando `nombre_clase='prueba'` o el precio es > 0.
  La descripción de la tool :4050 no se toca.
- `services/whatsapp-clase-cortesia.service.ts`: `CtxCortesia.textos?` → :731,733,983,1001,1106,1312,1323,1468,1667.
  `franjasDeSupabase` :1783 suma `branchId`, `coaches`, `nivel`, `anios` y `direccion` desde
  `facilities.address` (coincidencia **exacta** antes que la más larga; `direccionDeLugar` de T3) con caída a `teams.facility_id`
  y después a la sede. También filtra las sesiones canceladas por `team_schedule_exceptions` al leer (red de seguridad).
  `bloqueFranja` y `filaDeLista` **no cambian**.
- `services/whatsapp-prospecto-ia.service.ts`: `promptDeProspecto` recibe `textos` (líneas :167 y :170).
- `services/whatsapp-prospecto-lead.service.ts`: `completo` suma `branchId`, `teamId`, `genero` y `respuestas` (columnas nuevas).
- `services/grupos-por-edad.service.ts`: `RangoGrupo` suma `branchId`, `nivelCategoria`, `anioMin/anioMax` y `coachIds`; la
  lectura `rangosDeEscuela` :474 agrega esas columnas y `team_coaches` con `.in`. Nueva `elegirGrupoEmbudo(rangos,
  {branchId, anio, genero, nivel})`: sede → año dentro de `birth_year_*` (exacto, sin pasar por edad) → rama (Mixto admite los
  dos) → nivel por `wa_regla_nivel` (si ningún candidato tiene nivel, todos valen). También `direccionDeLugar` y `nivelDeRegla`.
  `elegirGrupo` **no cambia**.
- `services/franjas-cortesia.service.ts`: `planificarFranjas(…, {excepciones})` aplica cancelada/movida/extra;
  `filaParaInsertar(…, cupos)`; `compararConExistentes` gana `ajustarCupo` (abiertas, generadas y con
  `reserved_count <= cupos`) y `reabrir` (solo `cerrada_por='horario'`). El cierre de las obsoletas escribe `cerrada_por='horario'`.
  `sincronizarFranjasDeEscuela(…, {soloEquipo})`.
- `services/whatsapp-info-escuela.service.ts`: `horariosDelDia` :509 usa `sesionesDelDia` (+1 consulta por fecha).
- `routes/whatsapp-cortesias.routes.ts` (ya montada en `index.ts:349`; **no se toca `index.ts`**):
  `POST /:schoolId/cortesias/sincronizar-franjas` para el staff de esa escuela → `sincronizarFranjasDeEscuela(soloEquipo)`.
  Solo corre si `courtesy_from_training`.
- `jobs/maintenance.job.ts`: cron `*/15 * * * *` `runCuposSeparados()` con el kill-switch `DISABLE_CUPOS_SEPARADOS`.
  Hace una sola RPC por lote, sin N+1.

**Frontend**
- `components/coach/v2/semana/` (nuevo):
  - `semanaAjustesModel.ts`: aplica las excepciones a `entrenosDelHorario` y arma el «repetir».
  - `useSemanaAjustes.ts`: lee las excepciones con RLS, escribe con insert/delete y llama `repetir_semana_equipo` y
    `clases_prueba_semana`. Después de un cambio hace un POST fire-and-forget a sincronizar-franjas.
  - `AjustarEntrenoSheet.tsx`: Cancelar este día · Mover (hora/lugar) · Entreno extra · Deshacer.
  - `ClasesPruebaDelDia.tsx`: chip «🔔 Clase de prueba · Mariana · 2011 · Punta · Pagó ✅» con [Asistió] [No vino] y
    «Grupo recomendado» (equipos de la misma escuela).
- `components/coach/v2/CoachSessionsV2.tsx`: dentro de `TabSemana` :398-505 usa el modelo con las excepciones, un botón «⋯» por
  entreno, «Repetir ajustes de la semana pasada» y los chips. `?tab=semana&fecha=` abre la pestaña (link del aviso). **No hay
  pantalla ni ruta nuevas** (quitar pasos).
- `hooks/useClasePrueba.ts` + `components/students/ClasePruebaPanel.tsx`: tipos y una línea de detalle
  («2011 · Mujer · Punta · Club y torneos (…)», «🟡 Sede Norte · Infantil Femenino · Profe Iván · Sáb 31 oct 8:00»,
  «Cupo separado · sin comprobante»), en un componente nuevo `ProspectoDetalleEmbudo.tsx` y un solo punto de inserción.

## 4. Cómo queda apagado para las escuelas sin ajuste

- **Embudo** = `wa_preguntas_prospecto` válido y no vacío. Si es NULL, `atenderDesconocido` no lo llama nunca, y la
  continuación solo existe si el último saliente lleva `flujo:'embudo'`. `wa_bienvenida` y `wa_pregunta_sede` solo se leen
  dentro del embudo.
- **Pago en el bot** = embudo activo **y** `separar_horas` no NULL **y** `trial_price > 0`. Que Dreamers ponga un precio en la
  app no le prende el cobro por chat.
- **Textos**: `nombre_clase` NULL → «clase de cortesía»; `trial_price` NULL → «gratis» con los literales de hoy.
- **Generador**: sin excepciones el plan es idéntico. Con `cupos_por_sesion` NULL queda en 999. Las franjas cerradas antes de la
  migración tienen `cerrada_por` NULL y nunca se reabren.
- **Franjas**: los campos nuevos son aditivos y los textos de siempre no los imprimen. `facilities.address` está vacía para
  todos, así que la dirección sale igual que hoy.
- **Coach**: `avisar_entrenador=false` → sin avisos. Las columnas del cupo separado en NULL → los lectores de `trial_slot_id`
  no cambian. `listar_clase_prueba` solo agrega claves al JSON.

## 5. Pruebas unitarias (vitest; ninguna prueba existente se edita, solo se agregan casos)

1. `whatsapp-embudo-prospecto.test.ts` (nuevo, motor puro): sede por botón y por texto; preguntas en orden; «Mariana,
   14/03/2011, punta» llena tres de una vez; detalle solo con «club»; solo el año alcanza; dos fallos → persona; «Ya soy del
   club» deja `sm_pd_club`; sin grupo → otra sede o persona. Precio > 0 → cupo separado + instrucciones +
   `registrarConceptoEsperado({motivo:'clase_prueba',monto:15000,leadId,venceEn})`; sin cuentas de pago → persona y se suelta
   el cupo; gratis → agendada + consentimiento. Ningún saliente de Monster cumple `/gratis|cortes[ií]a/i`; botones ≤20,
   filas ≤24.
2. `grupos-por-edad.service.test.ts` (agregar): `elegirGrupoEmbudo` con sede, 2011 en 2011-2012 (borde incluido), Mixto acepta
   F y M, regla de nivel y nivel ausente. `elegirGrupo` da lo mismo de antes (misma tabla de casos).
3. `franjas-cortesia.service.test.ts` (agregar): cancelada/movida/extra, festivo más extra, cupos y `ajustarCupo` respetando el
   CHECK, reabrir solo `horario`. **Sin excepciones ni cupos, el plan es igual al de hoy** (fixture de Dynasty).
4. `semana-equipo.service.test.ts` (nuevo) y `whatsapp-info-escuela.test.ts` (agregar): un día cancelado no aparece en «hoy
   entrenan».
5. `textos-clase-prueba.test.ts` (nuevo): los textos por defecto son idénticos a los literales de :731/:733/:1001 (golden);
   «prueba»+15000 da «$15.000» y nunca «gratis».
6. `clase-prueba-agenda.service.test.ts` (nuevo): confirmar es idempotente (mismo texto, sin repetir el aviso al coach);
   `sin_cupo` ofrece otra franja; un lead de otra escuela da error; destinatarios = team_coaches ∪ coach_id con id
   determinístico; `avisar_entrenador=false` → 0 inserts; `runCuposSeparados` confirma si hay pago y si no libera.
7. `whatsapp-embudo-por-escuela.test.ts` (nuevo, mismo andamiaje que `whatsapp-prospecto-embudo.test.ts`): **Dynasty igual**.
   Con `school_settings` sin las columnas o en NULL, «quiero información», «Hola», «clase de prueba», la puerta de 3 botones y
   el `CONSENTIR_SI` de un desconocido dan el mismo step, texto y botones que hoy. Monster ve la bienvenida con sedes.
8. `whatsapp-ajustes-escuela` (agregar): JSON inválido o columnas faltantes → embudo apagado.
9. Frontend: `semanaAjustesModel.test.ts`. Los tests de coach v2 que ya existen pasan sin tocarlos.
10. Backend de concurrencia: dos `tomar_cupo` simultáneos sobre el último cupo de una franja de la escuela de pruebas → uno
    `lleno`. Dentro de `BEGIN…ROLLBACK` cuando se pueda; la base es la única que existe.

## 6. Riesgos, choques y preguntas

**Choques con otras sesiones** (`git status` de hoy):
- Sesión del cobro de la clase de prueba: tiene sin commitear `20261029215003` (ya aplicada), `ClasePruebaPanel.tsx`,
  `CanalesClasePrueba.tsx`, `ClasesDePruebaDialog.tsx`, `useCobrosClasePrueba.ts` y `SchoolStudentsManagementPage.tsx`.
  **Mi plan toca `ClasePruebaPanel.tsx` y `useClasePrueba.ts`** → va al final, después de su commit, y `listar_clase_prueba` se
  reemplaza desde el cuerpo vivo.
- Modificados por otros y que el plan **no toca**: `bff/src/index.ts`, `frontend/src/App.tsx`, `config/navigation.ts` y
  `tipo-de-cobro.ts` (sesión del cobro/B4). `migrations_ledger.json` también está modificado: crear con `migrations:new` y
  commitear con índice temporal.
- Limpios hoy pero con commits de hoy: `whatsapp-bot.service.ts` y `whatsapp-clase-cortesia.service.ts` (5da0b8b5; la spec §7
  avisa que otra sesión los edita, coordinar) y `coach/v2/*` (54f15a9a). B4 es dueño de comprobantes, cola y `PaymentCheckoutModal`.

**Riesgos técnicos**: `direccionDeSede` confunde «Pinar» con «Pinar 2» (se usa coincidencia exacta). `birth_year` → edad tiene
±1 de error (se usa el año). El modo discreto global (:2083) no corta el embudo, porque arranca por prospecto o saludo. En el
número de pruebas las RPC de escritura dan `SIM00` → el motor responde «simulado» (B7 amplía). Disk IO: cachés de 10 min,
`.in()` por lote y un job de 15 min con una sola RPC. Deadlock: orden lead → cupos por id.

**Preguntas nuevas**:
- **P1 (con B4):** el consentimiento necesita botones después de la confirmación. Propongo que `confirmarClasePruebaPagada`
  devuelva además `botones?` y `step?` (aditivo; los nombres no cambian) y que B4 los reenvíe. Si no, la pregunta va en texto y
  B4 tiene que usar el step `clase_prueba_agendada`.
- **P2:** el «cupo liberado, ¿te guardo otro horario?» a las 24 h cae fuera de la ventana y sin consentimiento, así que no se
  puede mandar. Propuesta: aviso dentro de la ventana a las ~22 h («tu cupo vence en 2 h») y liberar en silencio con aviso a la
  escuela, o pedir el consentimiento al separar.
- **P3:** con `trial_price > 0`, ¿el bot deja de decir «gratis» en **todas** las escuelas (Dreamers incluida si carga un precio)?
  Propongo que sí: decir gratis cuando se cobra está mal.
- **P4:** el saludo suelto («Hola») de un número nuevo ¿recibe la bienvenida del embudo sin la variable de entorno?
- **P5:** ¿los coaches de Monster usan el entrenador V2? «Mi semana» va solo en V2.
- **P6:** emojis 🟡/⚫ solo en el texto de bienvenida; los botones dicen «Sede Norte».

**Decisiones de la spec**:
- **Bloquean código: D9** (al recibir; «al revisar» queda cubierto por `soltar_cupos_separados`, que confirma si encuentra pago)
  y **D13** (cuántas veces se reagenda con el mismo pago; propuesta: 1).
- **Solo datos (B1/SQL): D1** (`wa_regla_nivel`), **D2, D3** (`facilities.address`), **D4, D5, D6, D7**
  (`wa_cortesia_indicaciones`) y **D12** (`cupos_por_sesion`).
- **Fuera de B2/B3:** D8, D10 (B6), D11 (B5), D14 (B4/cobros).
- Sin cuentas de pago cargadas (B1.5), el flujo con valor pasa a una persona.

## 7. Tareas de construcción en paralelo (sin archivos en común)

| T | Qué | Archivos (exclusivos) | Depende de |
|---|---|---|---|
| T1 | Migración aprobada, invariantes, sesiones simuladas, concurrencia, `types.ts` al final | `supabase/migrations/<nuevo>.sql`, `migrations_ledger.json`, `frontend/src/integrations/supabase/types.ts` | aprobación |
| T2 | Motor del embudo + ajustes | `whatsapp-embudo-prospecto.ts`(+test), `whatsapp-ajustes-escuela.service.ts`(+test), `whatsapp-prospecto-lead.service.ts` | contratos de T3/T5 (tipos) |
| T3 | Grupos, generador, semana, horario de hoy | `grupos-por-edad.service.ts`, `franjas-cortesia.service.ts`, `semana-equipo.service.ts`, `whatsapp-info-escuela.service.ts` (+tests) | — |
| T4 | Textos por escuela + franjas enriquecidas + prompt de IA | `textos-clase-prueba.ts`, `whatsapp-clase-cortesia.service.ts`, `whatsapp-prospecto-ia.service.ts` (+tests) | exports puros de T3 |
| T5 | Agenda, contrato B4, aviso al coach, job, endpoint de sincronización | `clase-prueba-agenda.service.ts`(+test), `jobs/maintenance.job.ts`, `routes/whatsapp-cortesias.routes.ts` | RPC de T1 |
| T6 | Cableado del bot + regresión Dynasty | `whatsapp-bot.service.ts`, `whatsapp-embudo-por-escuela.test.ts` | T2, T4, T5 y el export de B4 |
| T7 | Mi semana del coach | `frontend/src/components/coach/v2/CoachSessionsV2.tsx`, `coach/v2/semana/*` | T1 |
| T8 | Deportistas → Clase de prueba | `hooks/useClasePrueba.ts`, `students/ClasePruebaPanel.tsx`, `ProspectoDetalleEmbudo.tsx` | T1 y el commit de la sesión del cobro |

Orden: T3, T4 y T5 (con las RPC simuladas por inyección) pueden arrancar antes de aplicar T1. T6 cierra el lote. Cada tarea
corre `npm test` del BFF o del frontend y commitea solo lo propio con índice temporal. Las migraciones las aplica una sola sesión.
