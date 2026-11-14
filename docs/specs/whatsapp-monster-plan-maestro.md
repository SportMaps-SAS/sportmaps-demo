# Plan maestro · Bot de WhatsApp de Monster (y lo que sirve a todas las escuelas)

Aprobado por el usuario el 2026-10-30 («arma el plan completo y con múltiples agentes lo terminas»). Manda sobre los
planes por bloque cuando no coinciden: [spec](whatsapp-monster-requerimientos.md) (§8 decisiones, §9 respuestas de
Monster, §10 urgencia), [B2/B3](whatsapp-monster-plan-B2-B3.md), [B4](whatsapp-monster-plan-B4.md),
[B5](whatsapp-monster-plan-B5.md).

## 1. Reglas para todos los agentes

- Cada agente trabaja SOLO en su worktree `C:\Users\Usuario\Documents\demo\wt-monster-<x>` (rama `wt-monster-<x>`, sale
  de `develop` 4fa30a67). Nunca en el repo principal. `node_modules` son junctions: no `npm install`. Sin `.env`.
- Solo toca los archivos de su fila en §4. Si necesita otro, no lo toca: lo deja anotado para Integración.
- Todo lo nuevo va detrás de un ajuste por escuela que nace apagado: Dynasty, Dreamers y las demás quedan igual, con
  pruebas que lo fijen. Principio del usuario: **quitar pasos**; lo manual solo como respaldo.
- Código como el de alrededor (español, mismo estilo de comentarios y nombres). Repo en CRLF.
- Pruebas: escribirlas y CORRERLAS (vitest del BFF o del frontend) + `npx tsc --noEmit -p bff` (el error de
  `src/instrument.ts` por la versión de Sentry ya existe: ignorarlo). Reportar la salida real.
- Commit en SU rama (nunca en `develop`, nunca push), solo sus archivos, mensaje en español y al final:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Base de datos: solo lecturas puntuales filtradas por nombre (nada de `list_tables`, `get_advisors` ni barrer el
  catálogo: la base se cayó 14 h por Disk IO). Nadie aplica migraciones; las aplica el usuario al final.
- El código tiene que tolerar que la migración todavía no esté aplicada (columna inexistente → comportamiento de hoy),
  como ya hace `whatsapp-ajustes-escuela.service.ts`.

## 2. Esquema canónico (contrato; lo escribe el agente DB, lo usan todos)

**M1 `embudo_y_agenda_clase_prueba`** (B2/B3 + ajustes por escuela de B6). Base: plan B2/B3 §2, con estos cambios:
- `school_settings`: `wa_bienvenida text` (≤1000), `wa_botones_sede jsonb` (array `[{branch_id, titulo}]`, título ≤20;
  NULL = sin pregunta de sede), `wa_preguntas_prospecto jsonb` (array; NULL = embudo apagado),
  `wa_modo_discreto text CHECK IN ('global','si','no') DEFAULT 'global'`, `wa_temas_a_persona jsonb` (array; NULL =
  lista global). **No** van `wa_pregunta_sede` ni `wa_regla_nivel` (Monster: la prueba siempre en Proyección).
- `school_trial_class_settings`: `nombre_clase` ('cortesia'|'prueba'), `separar_horas smallint` 1–72,
  `cupos_por_sesion smallint` 1–500, `agendar_al_recibir boolean DEFAULT true`, `avisar_entrenador boolean DEFAULT false`,
  `dias_semana smallint[]` (0 = domingo … 6 = sábado, igual que `teams.schedule[].day`; NULL = todos). El valor es
  `trial_price` (ya existe).
- `teams.recibe_clase_prueba boolean NOT NULL DEFAULT true` (no se reusa `admite_nuevos`).
- `facilities`: `address text`, `maps_url text`, `indicaciones text` (por dónde se entra, qué pasa si llueve).
- `school_signup_leads`: `branch_id`, `team_id`, `respuestas jsonb`, `cupo_separado_slot_id`, `cupo_separado_hasta`
  (+ CHECK de pareja e índice). `school_trial_slots.cerrada_por` ('escuela'|'horario'). `whatsapp_optins.source` +
  `'bot_prospecto'`.
- `team_schedule_exceptions` + helper `puede_editar_semana_equipo` + policies y RPCs del plan B2/B3 §2 (7 y 8) y
  `listar_clase_prueba` reemplazada desde el cuerpo VIVO.

**M2 `comprobantes_con_motivo`** (B4). Base: plan B4 §2 (M1–M5; M6 ya lo hizo otra sesión), más:
- `school_tournament_items`: `precio_afiliado numeric`, `precios_por_fecha jsonb` (`[{desde: 'YYYY-MM-DD', precio}]`),
  `abono_minimo_pct smallint` 1–100, `opciones jsonb` (`[{clave, etiqueta, precio, precio_afiliado}]`, p. ej. semanas del
  vacacional). `wa_crear_cobro_desde_comprobante` calcula el precio con opción, afiliado y fecha, y acepta el abono.
- `wa_es_afiliado(p_school_id uuid, p_telefono text) RETURNS jsonb` (solo `service_role`): reconoce al afiliado por
  celular en cuentas, `children.parent_phone_temp` y `unregistered_athletes` (145 de 148 deportistas de Monster están
  sin cuenta). Solo para precio y saludo; nunca muestra datos privados.

**M3 `campanas_whatsapp`** (B5). Exactamente plan B5 §2 (4 tablas solo-BFF + `wa_audiencia_excluidos`,
`wa_campana_aprobar`, `wa_campana_tomar_lote`). Bases de consentimiento `optin` y `contacto_previo_declarado`; la
escuela elige al encender (decisión pendiente del usuario: el código soporta las dos).

**M4 `whatsapp_numero_proposito`** (B9, dos números por escuela): `school_whatsapp_integrations.proposito text NOT NULL
DEFAULT 'general' CHECK IN ('general','eventos')`, `nombre text` (≤40), índice único parcial `(school_id, proposito)
WHERE status = 'active'`.

## 3. Contratos entre agentes (nombres exactos)

- B2 → B4: `registrarConceptoEsperado(schoolId, telefono, { motivo, monto?, leadId?, childId?, venceEn? })` en
  `bff/src/services/wa-concepto-esperado.service.ts`.
- B4 → B2: `confirmarClasePruebaPagada({ schoolId, leadId, paymentId, telefono }): Promise<{ texto: string; botones?:
  {id: string; title: string}[]; step?: string }>` en `bff/src/services/clase-prueba-agenda.service.ts`. B4 lo carga
  con import dinámico; si falta, no agenda y pasa a una persona.
- B3-motor → B2: `elegirGrupoEmbudo(rangos, { branchId, anio, genero })` (solo equipos con `recibe_clase_prueba`; sede →
  año exacto → rama, Mixto acepta las dos), `direccionDeLugar`, `sesionesDelDia` (`semana-equipo.service.ts`),
  `textosDeClase({ nombre_clase, trial_price })` (`textos-clase-prueba.ts`). **B2 no los importa**: los recibe por
  inyección (`CtxEmbudo`); Integración los cablea.
- B5: botones `smc:<campana_id>:si|luego|baja`; `atenderRespuestaDeCampana(...)` en
  `whatsapp-campana-respuesta.service.ts`, enganchado en `routes/whatsapp.ts` por el propio agente B5.
- B9 (fase 2): `integracionDeEscuela(schoolId, { proposito?, conversationId? })` reemplaza las ~16 lecturas que hoy
  esperan un solo número por escuela; la respuesta manual sale por el número de la conversación.

## 4. Agentes y archivos (fase 1 en paralelo)

| Agente | Qué | Archivos exclusivos |
|---|---|---|
| T1 (ya corriendo) | Pedir el historial al alta + guardarlo con su fecha | `whatsapp-onboarding.service.ts`, `whatsapp-coexistence.service.ts` (+tests) |
| DB | M1–M4 con `npm run migrations:new`, en ese orden; prueba en Postgres desechable (Docker) si se puede; SQL de verificación; SQL de datos post-migración de Monster (canchas, `recibe_clase_prueba`, `dias_semana='{0,6}'`, clínica y vacacional como servicios con sus precios, ajustes de campaña apagados) | `supabase/migrations/*` nuevas, `supabase/migrations_ledger.json`, `supabase/migrations/_smoke/*` |
| B4-BFF | Plan B4 T2+T3+T4 + `wa-afiliado.service.ts` + precios de servicios (opción, afiliado, fecha, abono) | nuevos `motivos-de-cobro.ts`, `wa-concepto-esperado.service.ts`, `wa-cobro-desde-comprobante.service.ts`, `wa-afiliado.service.ts`; `tipo-de-cobro.ts`, `payment-accounts.ts`, `whatsapp-otro-concepto.service.ts`, `ventas-servicios.service.ts`, `routes/payments.routes.ts`, `receipt-verdict.ts`, `jobs/whatsapp-queue.job.ts`, `whatsapp-respuesta-de-cobro.service.ts`, `whatsapp-comprobante-guiado.service.ts` (+tests) |
| B4-front | Plan B4 T5 + editor del catálogo de servicios con precio de afiliado, opciones, precio por fecha y abono | `frontend/src/lib/motivosDeCobro.ts`, `lib/payment-accounts.ts`, `lib/manualPaymentCharge.ts`, `components/payment/PaymentCheckoutModal.tsx`, el editor de servicios (+tests). **No** `MyPaymentsPage.tsx` (otra sesión) |
| B3-motor | Plan B2/B3 T3+T4 (sin nivel; `recibe_clase_prueba`, `dias_semana`, Maps e indicaciones; nunca «gratis» con `trial_price > 0`, incluido `lineasQueLlevar`) | `grupos-por-edad.service.ts`, `franjas-cortesia.service.ts`, nuevos `semana-equipo.service.ts` y `textos-clase-prueba.ts`, `whatsapp-info-escuela.service.ts`, `whatsapp-clase-cortesia.service.ts`, `whatsapp-prospecto-ia.service.ts` (+tests) |
| B2-embudo | Plan B2/B3 T2+T5 + aviso «clase reprogramada» (lluvia / cancelación del profe) y plantillas de utilidad nuevas (recordatorio de clase de prueba, cupo por vencer, clase reprogramada) | nuevos `whatsapp-embudo-prospecto.ts`, `clase-prueba-agenda.service.ts`; `whatsapp-ajustes-escuela.service.ts`, `whatsapp-prospecto-lead.service.ts`, `routes/whatsapp-cortesias.routes.ts`, `whatsapp-plantillas.service.ts` (solo el catálogo de conceptos), `bff/whatsapp-templates/*.json` de esas plantillas (+tests) |
| B3-front | Plan B2/B3 T7 («Mi semana» del profe) + T8 (Clase de prueba con respuestas y sede) + campos de cancha (dirección, Maps, indicaciones) + interruptor «recibe clase de prueba» por equipo + ajustes de la clase de prueba (días, nombre, horas para separar, cupos, avisar al profe) | `components/coach/v2/CoachSessionsV2.tsx`, `coach/v2/semana/*`, `hooks/useClasePrueba.ts`, `components/students/ClasePruebaPanel.tsx`, nuevo `ProspectoDetalleEmbudo.tsx`, `components/whatsapp/HorariosDeEntrenamiento.tsx`, el editor de canchas y el de ajustes de la clase de prueba (+tests) |
| B5 | Plan B5 T2, T3 (sin registrar el cron), T4, T5 y T6 | nuevos `whatsapp-audiencias.service.ts`, `whatsapp-campanas.service.ts`, `whatsapp-campanas-freno.ts`, `whatsapp-campana-respuesta.service.ts`, `routes/whatsapp-campanas.routes.ts`, `scripts/wa-audiencia.ts`, `scripts/wa-campana.ts`, `components/whatsapp/Campanas.tsx`, `bff/whatsapp-templates/escuelas/monster/*.json`; `routes/whatsapp.ts`, `routes/whatsapp-admin.routes.ts`, `index.ts`, `pages/WhatsAppPage.tsx` (+tests) |

Ya construido: B7 (número de pruebas) en `wt-monster-b7`.

## 5. Fase 2 (en serie, después de la fase 1)

1. **Integración** (`wt-monster-integracion`): merge de b7, t1, db, b4, b4f, b3, b2, b3f y b5; conflictos; cableado en
   `whatsapp-bot.service.ts` (embudo B2/B3 T6, línea de B4 T6, «Sí» de campaña B5 T7, B6: modo discreto y temas a
   persona por escuela, «sigue en fila»), crons en `jobs/maintenance.job.ts` (cupos separados, campañas, sigue en fila),
   inyección de las funciones de B3-motor en el embudo, prueba de contrato de motivos BFF = frontend = CHECK. Suite
   completa del BFF y del frontend, `tsc` y `build`.
2. **B9 · dos números** sobre la integración: alta del segundo número con propósito, `integracionDeEscuela`, las ~16
   lecturas, respuesta por el número de la conversación, plantillas y campañas por propósito, y la pantalla (etiqueta
   por conversación, filtro, encabezado con los dos números, avisos «Nuevo mensaje en 🏆 Torneos»).

## 7. Después de Monster: B10 · Anuncios de SportMaps con clic a WhatsApp (pedido del usuario, 2026-10-30)

Prioridad alta, justo al cerrar Monster y antes de B9: «quiero aparecer en esos anuncios a como dé lugar».
- Los anuncios se crean en el Administrador de anuncios de Meta (sin revisión de la app), con la página de SportMaps
  vinculada al número comercial +57 320 268 3539.
- Conectar ese número al canal de plataforma (`/admin/whatsapp`, construido el 10-29 y nunca conectado).
- Guardar la atribución del anuncio (`referral` del primer mensaje: anuncio, título, `ctwa_clid`), hoy no se captura.
- Bot comercial de SportMaps: planes y precios de la landing, datos de la escuela (nombre, deporte, ciudad,
  deportistas) y agendar la demo; lead con su anuncio.
- Después: API de conversiones (sí pide revisión de Meta) para reportar demo agendada y escuela que paga con el
  `ctwa_clid`.

## 6. Fase 3 (con el usuario)

Aplicar M1–M4 en una sola sesión (el usuario), `npm run seguridad:invariantes`, `types.ts` una vez, SQL de datos de
Monster (antes y después de la migración), recorrido completo en el número de pruebas (B7) y `main` cuando el usuario
lo pida (T1 primero, antes de que Monster conecte).
