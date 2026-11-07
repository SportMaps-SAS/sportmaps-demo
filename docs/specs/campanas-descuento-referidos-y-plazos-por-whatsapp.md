# Campañas de descuento por referidos, pago por plazos y gestión del plan por WhatsApp

Estado: **spec para aprobar (2026-11-06)**. Sin código ni migraciones todavía. Pedido de Monster´s Volley Club
(primera escuela); se diseña para todas las escuelas.

Relacionados (no se reconstruye lo que ya existe): `docs/specs/descuentos-hermanos-primos-referidos.md`
(referidos hoy son **manuales**), `docs/specs/pausa-vacaciones-enrollments.md` (F1–F3 construidas),
`docs/specs/cobranza-vencidos-estados-y-alertas.md`, `docs/plan-dynasty-cobranza-2026-11-05.md`.

## 1. Qué se pidió

1. **Referidos automáticos.** Al inscribir a un deportista se anota **quién lo refirió**. El que refiere recibe un
   descuento en su mensualidad del **mes siguiente** («en diciembre paga la mitad»), según la edad del **referido**:
   - de 4 a 15 años → **50 %** de la mensualidad;
   - más de 15 años → **25 %**.
   Hoy se hace a mano desde «Cobros abiertos» con «Valor nuevo» y un motivo escrito.
2. **El bot organiza las campañas de descuento** que la escuela tenga activas: las explica, pregunta «¿te refirió
   alguien?» y guarda el nombre.
3. **Pago por plazos desde WhatsApp.** Si una persona dice que quiere pagar por plazos, el bot la deja elegir en
   cuántas cuotas y qué fechas (dentro de lo que la escuela permita).
4. **Retirar, suspender o congelar el plan** desde WhatsApp o desde la app.
5. **Caso puntual:** Daniel Felipe Becerra Neira → dejarlo en su doble categoría (ver §9).
6. **Soportes obligatorios, solo para Monster:** que sea obligatorio cargar todos los soportes del deportista (§6b).

## 2. Lo que ya existe y se reutiliza

| Pieza | Dónde | Cómo se reutiliza |
|---|---|---|
| Marca «Referido» y cuota manual | `enrollments.discount_type = 'referral'` + `fee_is_manual` | El referido manual actual sigue funcionando; la campaña automática lo reemplaza para las escuelas que la prendan. |
| Cascada de descuentos del cierre de mes | `open_month` / `preview_open_month` | Aquí se calcula el descuento por referido, igual que hermanos: **sin camino nuevo de cobros** (hay 13; no se crea el 14). |
| Motivo visible para la familia | línea del descuento en `MyPaymentsPage` y aviso | «Descuento 50 % por referido: <nombre>». |
| Pausa de inscripción | `enrollment_pause_requests`, `paused_reason`, `school_settings.pause_enabled` | Congelar = pausar por meses completos. Falta la superficie del atleta adulto y el canal de WhatsApp. |
| Solicitud → aprobación | patrón `plan_upgrade_requests` | Pausas, retiros y plazos usan el mismo patrón. |
| Identificación por teléfono / OTP | `identificarPorTelefono`, `handleIdentification` | El bot solo actúa sobre la cuenta de quien está identificado. |
| Abonos / cobros parciales | estado `partial` y «Cobros abiertos» | Los plazos se registran como abonos; no se crea otra forma de pagar. |
| Embudo del bot (clase de prueba, anuncios) | `school_signup_leads.source_detail` | Se guarda ahí «referido por». |

## 3. Decisiones de producto

Resueltas el 2026-11-06 (Monster):
- **D1.** El porcentaje depende de la edad del **referido** (no de quien refiere).
- **D2.** El descuento se **gana cuando el referido paga su primera mensualidad**, no al inscribirse.
- **D5.** Quien refiere debe ser una **familia o deportista activo y al día** en el mes en que se aplica.
- **D6.** Daniel Becerra: asignarlo a su doble categoría y, si ya está, dejarlo bien (§9).
- **D7.** Plazos y retiro/suspensión/congelación: disponibles **desde WhatsApp y desde la app**.

**Pendientes de confirmar con Monster** (no se les preguntó; se proponen valores por defecto):
- **D3 — Acumulación.** Propuesta: **un descuento por mes por deportista** (consistente con la regla «uno solo por atleta»).
  Si refiere a varios, cada referido gana **un mes**, aplicados en meses consecutivos, nunca dos a la vez. Tope por
  defecto: 12 meses pendientes.
- **D4 — A cuál inscripción se aplica.** Propuesta: la del propio referente si es deportista; si es una familia con
  varios hijos, la de **mayor mensualidad**; la administración puede cambiarla antes de que se aplique.
- **D8 — Conflicto con hermanos y becas.** Propuesta: el descuento por referido **reemplaza** al de hermanos ese mes
  (mismo criterio «el manual gana» del spec de descuentos) y **no aplica** a inscripciones con beca de 100 %.
- **D9 — Plazos.** Máximo de cuotas, máximo de días y si se aprueban solos o con visto de la administración
  (propuesta: hasta 3 cuotas y 60 días aprobados solos; más que eso, a la administración).
- **D10 — Pausa en Monster.** ¿Se prende `pause_enabled` y con qué tope de meses por año?
- **D11 — Qué son «los soportes».** Entendido como los **7 documentos de la ficha** del formulario de afiliación de Monster (§6b). Si se refería a los **comprobantes de pago**, es otra regla (§6b, variante).
- **D12 — Qué bloquea la falta de soportes.** Propuesta: no se puede **confirmar la inscripción** ni convocar al deportista a torneos hasta completarlos; se puede crear la ficha y la inscripción en estado «faltan soportes».

## 4. Parte A — Campañas de descuento y referidos

### 4.1 Modelo de datos (una migración por fase, una sola sesión las aplica)

```sql
-- Campaña configurable por escuela (el tipo de hoy: 'referral'; el modelo admite otras).
school_discount_campaigns (
  id uuid PK, school_id uuid NOT NULL, kind text CHECK (kind IN ('referral')),
  name text NOT NULL, active boolean NOT NULL DEFAULT false,
  starts_on date, ends_on date,
  -- tramos por edad del REFERIDO. Ej: [{"age_min":4,"age_max":15,"pct":50},{"age_min":16,"age_max":null,"pct":25}]
  tiers jsonb NOT NULL,
  reward_months int NOT NULL DEFAULT 1,           -- meses de descuento por referido
  max_pending int NOT NULL DEFAULT 12,
  require_referrer_current boolean NOT NULL DEFAULT true,
  created_at, updated_at
);

-- Un renglón por referido.
enrollment_referrals (
  id uuid PK, school_id uuid NOT NULL, campaign_id uuid NOT NULL,
  referred_enrollment_id uuid NOT NULL UNIQUE,    -- un referido, un solo referente
  referrer_enrollment_id uuid NULL,               -- inscripción del referente donde se aplica (D4)
  referrer_profile_id uuid NULL,                  -- familia o deportista
  referrer_name_text text NULL,                   -- lo que dijo el bot si todavía no se vinculó
  referred_age_at_enrollment int NOT NULL,
  pct numeric NOT NULL,                           -- se congela al ganar
  status text CHECK (status IN ('sin_confirmar','pendiente','ganado','aplicado','anulado','vencido')),
  qualified_at timestamptz, apply_year int, apply_month int,
  applied_payment_id uuid NULL, created_by uuid, created_at, updated_at
);
```
Reglas: `text + CHECK` (sin enums); RLS por escuela con `user_admin_school_ids()` para escribir y `user_staff_school_ids()`
para leer; sin `anon`; RPCs con `search_path` fijo, `GRANT EXECUTE` explícito y el alcance validado adentro.

### 4.2 Flujo

1. **Captura.** Campo «¿Quién lo refirió?» (buscador de familias y deportistas + texto libre) en **Agregar atleta**,
   en **Por asignar → Asignar** y en el alta que arma el bot. Si solo hay texto, queda `sin_confirmar` hasta que la
   administración lo vincule.
2. **Cálculo del porcentaje.** Con la edad del referido a la fecha de la inscripción y los tramos de la campaña
   (4 a 15 → 50 %; 16 o más → 25 %; menos de 4 → no califica). Se guarda el porcentaje en el renglón.
3. **Se gana** cuando el referido **paga su primera mensualidad**. Un trabajo diario en lote (`.in('id', ids)`,
   nunca una consulta por fila) revisa los `pendiente` y los pasa a `ganado`, fijando `apply_year/apply_month` = mes
   siguiente al pago, o el primer mes libre si ya hay descuentos en cola (D3).
4. **Se aplica** dentro de `open_month` / `preview_open_month`: para la inscripción del referente, si hay un renglón
   `ganado` cuyo mes toca y la familia está activa y al día (D5), la mensualidad sale con el porcentaje y el renglón
   pasa a `aplicado` con el `payment_id`, **en la misma transacción** (idempotente: un cierre repetido no aplica dos
   veces).
5. **Aviso** a quien refiere cuando gana («¡Ganaste 50 % en tu mensualidad de diciembre por referir a X!») y línea en
   el recibo con el motivo. Los avisos desde el BFF van con `INSERT` en `notifications` con service role.
6. **Anulación.** Si el referido se retira antes de pagar la primera mensualidad, el renglón queda `anulado`. Si ya
   se ganó, el descuento se mantiene (no se revierte el mes ya cobrado).

### 4.3 Pantallas

- **Configuración → Campañas de descuento:** prender/apagar, tramos por edad, fechas, meses por referido, tope.
- **Ficha del deportista:** «Referido por <nombre>» con estado y el mes del descuento.
- **Informe «Referidos»:** quién refirió a quién, porcentaje, mes y estado, con totales por mes (lo que la escuela
  deja de cobrar).
- «Cobros abiertos» mantiene el ajuste manual para casos fuera de campaña.

### 4.4 Bot

- Pregunta «¿Te refirió alguien del club?» en la inscripción y la clase de prueba y guarda el nombre en
  `source_detail.referido_por` (sin confirmar).
- Si preguntan «¿hay descuento por referidos?» responde **solo** con las campañas activas de esa escuela (nunca
  inventa porcentajes); sin campaña, deriva a la escuela.
- El descuento nunca lo da el bot: lo da el cálculo del cierre de mes.

## 5. Parte B — Pago por plazos

**Idea:** un *acuerdo de pago* es un compromiso de **fechas y montos** sobre uno o más cobros abiertos. El dinero entra
por la vía de abonos que ya existe; el acuerdo solo organiza fechas, recordatorios y mora.

```sql
payment_agreements (
  id uuid PK, school_id uuid NOT NULL, requested_by uuid NOT NULL, payer_profile_id uuid,
  status text CHECK (status IN ('solicitado','activo','cumplido','incumplido','rechazado','cancelado')),
  approved_by uuid, approved_at timestamptz, source text CHECK (source IN ('whatsapp','app','admin')),
  created_at, updated_at
);
payment_agreement_items ( id uuid PK, agreement_id uuid, payment_id uuid, due_date date, amount numeric,
                          status text CHECK (status IN ('pendiente','pagado','vencido')) );
```
- **Elección:** la persona dice en cuántas cuotas y en qué fechas, dentro de los topes de la escuela (D9). El bot
  propone un calendario y pide confirmación antes de crear nada.
- **Aprobación:** automática dentro de los topes; fuera de ellos, solicitud a la administración (patrón de
  `plan_upgrade_requests`).
- **Mora:** mientras el acuerdo esté `activo` y al día, no se aplica recargo a esos cobros; si una cuota vence sin pago,
  el acuerdo pasa a `incumplido` y la mora retoma desde la fecha original.
- **Recordatorios:** el día de cada cuota, por el despachador de notificaciones existente.
- **Pago:** cada comprobante se aplica como abono con la cola de comprobantes de siempre; el acuerdo marca la cuota
  `pagado` cuando el abono cubre su monto.

## 6. Parte C — Retirar, suspender o congelar desde WhatsApp y la app

| Acción | Mecanismo | Quién aprueba |
|---|---|---|
| **Congelar / suspender (pausa)** | Reutiliza `enrollment_pause_requests` por meses completos (desde / hasta) y los topes de `pause_enabled`. | Dentro del tope: automática; fuera: administración. |
| **Retirar (baja)** | Solicitud de retiro con fecha de salida; reutiliza la política de baja (`set_school_athlete_status`) y la detección `esSolicitudDeRetiro`. | **Siempre la administración** (la baja anula cobros y toca la inscripción). |
| **Reactivar** | Solicitud inversa; vuelve a generar cobros desde el mes elegido. | Administración. |

- **Bot:** el flujo pide el mes de inicio y de fin, resume lo que se va a hacer y pide confirmación; recién entonces
  crea la solicitud. Solo actúa sobre inscripciones de la persona identificada.
- **App:** botones equivalentes para el acudiente y para el deportista adulto (la superficie del adulto sigue
  pendiente en el spec de pausa, §11).
- **Aviso** a la administración con la solicitud en el buzón y en la bandeja de pendientes.

## 6b. Parte D — Soportes obligatorios (solo Monster)

**Qué es hoy.** La ficha de cada deportista admite documentos (`athlete_documents`). Monster pide los **7 del formulario de
afiliación**: foto del deportista, certificado EPS, documento del acudiente (frente), documento del deportista (frente),
firma del acudiente, firma del deportista y paz y salvo.

**Qué hay cargado hoy en Monster** (medido el 2026-11-06, solo lectura):

| Grupo | Total | Con los 7 | Con algunos (1–6) | Con ninguno |
|---|---|---|---|---|
| Deportistas con cuenta e inscripción activa | 59 | 38 | 9 | 12 |
| Fichas sin cuenta (activas) | 100 | 66 | 9 | 25 |
| **Total** | **159** | **104** | **18** | **37** |

Son **55 deportistas** a los que hoy les falta al menos un soporte.

**Diseño (configurable por escuela; solo Monster lo prende):**
- `school_settings.require_athlete_documents boolean NOT NULL DEFAULT false` y
  `school_settings.required_document_types text[] NOT NULL DEFAULT '{}'`. Para Monster: los 7 tipos. Ninguna otra escuela cambia.
- La ficha muestra **«Soportes X/7»** y la lista de lo que falta. Un filtro «Faltan soportes» en Atletas.
- **Obligatoriedad (D12):** una inscripción nueva se crea en estado «faltan soportes»; para **confirmarla** (y para convocar a
  torneos) deben estar los 7. El botón «Asignar» de «Por asignar» sigue funcionando, pero la confirmación queda bloqueada con la
  lista de lo que falta. Esto no frena a quien opera: solo evita dar por cerrada una ficha incompleta.
- **Cómo se cargan:** el acudiente desde la app (ficha de su hijo) y desde **WhatsApp**: el bot recibe la foto o el PDF, pregunta
  de cuál soporte es y de qué deportista, y lo guarda; el equipo también puede subirlos.
- **Recordatorios automáticos** a las familias con soportes pendientes (app y WhatsApp), cada pocos días y con tope, por el
  despachador de notificaciones existente. Sin mensajes de mora ni de cobro (regla de Monster).
- **Los 55 actuales:** no se bloquean. Se les pide completar con los recordatorios y un informe «Soportes pendientes» con el
  detalle de qué falta a cada uno.
- Seguridad: los documentos son datos privados; se mantienen las políticas actuales del bucket y de la tabla (nada legible sin
  autenticar), y el bot nunca reenvía un documento a otra persona.

**Variante, si «soportes» eran los comprobantes de pago.** Monster tendría que adjuntar el comprobante para **marcar un pago
como pagado** (flag `require_payment_proof` por escuela, hoy existe un patrón parecido en `installment_require_proof`). Se
confirma con Monster antes de construir cualquiera de las dos.

## 7. Fases

| Fase | Contenido | Entrega |
|---|---|---|
| F0 | Dato de Daniel Becerra (§9); definir D3, D4, D8, D9 y D10 con Monster. | Hoy |
| F1 | Referidos: tablas, cálculo de porcentaje, ganar al pagar, aplicar en `open_month`, pruebas de concurrencia y de idempotencia. | DB + BFF |
| F2 | Referidos: captura en Agregar atleta y Por asignar, ficha, informe, aviso y línea del recibo, configuración de la campaña. | Frontend |
| F3 | Bot: pregunta de referido y respuesta sobre campañas activas. | BFF |
| F4 | Pago por plazos: acuerdos, recordatorios, mora, flujo del bot y de la app. | Full-stack |
| F5 | Pausa y retiro por WhatsApp; superficie del adulto en la app; prender `pause_enabled` en Monster. | Full-stack |
| F6 | Soportes obligatorios solo para Monster (§6b): flags, contador en la ficha, filtro, confirmación bloqueada, carga por WhatsApp y recordatorios. | Full-stack |

Cada fase: spec de migración aprobado antes de escribir SQL; policies de RLS revisadas línea por línea;
`npm run seguridad:invariantes` limpio; tests de concurrencia en la fase backend; sin ramas por fase (todo en
`develop`, sin subir a `stg` ni `main` por iniciativa propia).

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| Doble aplicación del descuento en cierres repetidos | Renglón con estado y `applied_payment_id`; idempotencia dentro de la transacción de `open_month`; prueba de concurrencia. |
| Autorreferidos o referir a un hermano | El referido debe ser un deportista **nuevo** (sin inscripción en la escuela en los últimos 12 meses); el referente no puede ser de la misma familia (hermanos ya tiene su regla). |
| Referente que deja de estar al día | `require_referrer_current`: el descuento espera hasta que esté al día (no se pierde dentro de un máximo de meses). |
| El bot promete un descuento | El bot solo lee campañas activas y nunca calcula ni aplica; el cálculo es del cierre de mes. |
| Disk IO del trabajo diario | Un lote por escuela con `.in(ids)`, una vez al día, sin N+1. |
| Retiro automático por error | La baja siempre pasa por la administración. |

## 9. Caso Daniel Felipe Becerra Neira (Monster)

Hoy tiene **una sola inscripción activa**: MIXTO MAYORES PROFUNDIZACION a **$155.000**, que coincide con el precio del
plan «Plan 12 clases mayores mixto (básico) + doble categoría». Falta la **segunda categoría**. No se ha escrito nada en
la base. Hace falta saber **cuál es el segundo equipo** (y la sede) para crear la segunda inscripción; la cuota la decide la
escuela (la regla del plan de doble categoría), sin generar un cobro duplicado.

## 10. Criterios de aceptación

- Referido de 10 años que paga noviembre: el referente ve diciembre al 50 %, con el motivo, sin intervención manual.
- Referido de 17 años: el referente ve el 25 %.
- Dos referidos en el mismo mes: diciembre y enero, no dos descuentos en diciembre.
- Referente con beca de 100 %: no se aplica (D8).
- Cerrar el mes dos veces no aplica el descuento dos veces.
- Familia con acuerdo de 3 cuotas: sin recargo mientras cumpla; un abono por comprobante marca la cuota.
- Pausa pedida por WhatsApp para diciembre y enero: queda la solicitud; tras aprobarla no se generan esos cobros.
- Escuela sin el flag de soportes: nada cambia. Monster: una inscripción con 6 de 7 soportes no se puede confirmar y muestra qué falta.
- Una coach u otra escuela no ve campañas, referidos ni acuerdos que no son suyos (0 filas / 403).
