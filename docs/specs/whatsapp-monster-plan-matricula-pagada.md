# Plan · Matrícula ya pagada como interesado (prospecto → deportista)

Planeación de solo lectura, 2026-11-03. Rutas relativas al repo. Sin código ni migración creada: este documento es el
plan a aprobar. Base: `20261029215003_cobro_clase_prueba.sql`, `20261030123543_embudo_y_agenda_clase_prueba.sql`,
`20261030123549_comprobantes_con_motivo.sql` (las tres vivas en la base, verificado hoy). Cuerpos vivos comparados
por `pg_proc` filtrando por nombre.

## 0. Resumen

Con los comprobantes con motivo (B4), un interesado paga la matrícula (o la clase de prueba) por WhatsApp **antes** de
que exista el deportista: `wa_crear_cobro_desde_comprobante` crea el cobro atado a `payments.signup_lead_id`. Cuando la
escuela inscribe, ninguno de los caminos que crean el cobro de inscripción sabe de ese pago, así que **la inscripción se
cobra otra vez**. Encima, el trigger que hoy «pasa los pagos del prospecto al deportista» al convertirlo
(`trg_lead_convertido_mueve_pago`) lleva el pago de matrícula al estado de cuenta **al lado** del cobro nuevo: el
doble cobro queda a la vista de la familia.

Propuesta: **una sola función con la regla** (`_aplicar_pagos_del_prospecto`) que corre dentro de la **misma
transacción** que crea el cobro de inscripción, con el prospecto identificado **explícitamente** (nunca por teléfono a
solas). La puerta principal es `emit_enrollment_fees`, por donde pasan 4 de los 5 caminos que cobran inscripción. El
trigger de conversión queda como red para las conversiones tardías.

**Radio hoy: cero.** No hay ningún pago con `signup_lead_id` (consulta de §9), el interruptor
`wa_cobro_desde_comprobante` está apagado en todas las escuelas y Monster no tiene planes activos con
`registration_fee > 0`. El bug es latente: aparece el día que Monster cargue la matrícula en sus planes y se encienda el
interruptor. Hay tiempo de hacerlo antes, no después.

## 1. La secuencia que duplica (hoy)

1. Prospecto escribe; el bot pide la matrícula; llega el comprobante de $310.000.
2. `wa_crear_cobro_desde_comprobante(p_fuente='registration_fee', p_signup_lead_id=L)` crea `payments`
   (`inscripcion`, `signup_lead_id=L`, sin deportista) y el comprobante se le aplica (`awaiting_approval` → `paid`).
3. El bot le manda el enlace de inscripción `/join/<slug>` (`whatsapp-bot.service.ts:3874` `enlaceDeInscripcion`;
   el plan de requerimientos §6 dice «el bot lo manda al confirmar la matrícula»), o la escuela hace el alta.
4. Cualquier alta con plan llama `emit_enrollment_fees` → **segunda** fila `inscripcion` `pending` por $310.000.
5. Si alguien cierra el prospecto (botón del panel o el cruce nocturno), el trigger mueve la fila del paso 2 al
   deportista: el estado de cuenta muestra **Inscripción pagada + Inscripción pendiente**.
6. Si nadie lo cierra (lo normal en Monster: el cruce nocturno solo encuentra cuentas, y 145 de 148 deportistas no
   tienen), el pago queda huérfano en el prospecto y la familia igual debe la segunda.

## 2. Censo de caminos

### 2.1 Caminos que crean el cobro de inscripción

| # | Camino | Dónde | Crea deportista | Cómo cobra la inscripción | ¿Sabe el prospecto? |
|---|---|---|---|---|---|
| C1 | `POST /api/v1/students/create-one` | `bff/src/routes/students-create-one.route.ts:650`; arma el elemento `enrollment_fees` en `:533-546` y llama `create_enrollment_with_payments` en `:552` | Sí (menor: INSERT `children` **antes** de la RPC, fuera de la transacción) | `create_enrollment_with_payments` (vivo = `20261013192955:1529`) → `emit_enrollment_fees` | No |
| C1a | · Alta manual menor | `frontend/src/components/students/CreateChildModal.tsx:428` | | | No |
| C1b | · Alta manual adulto | `frontend/src/components/students/CreateAdultAthleteModal.tsx:381` y `:403` | | | No |
| C1c | · «Completar alta» desde Clase de prueba | `frontend/src/pages/SchoolStudentsManagementPage.tsx:1630-1633` abre C1a/C1b con `prefill`; al terminar, `cerrarProspectoInscrito` `:355-366` llama `cerrar_prospecto_clase_prueba` en **otra** llamada (`frontend/src/hooks/useClasePrueba.ts:141`) | | | **Sí (`p.id`), pero no viaja al alta** |
| C1d | · Bandeja de matrículas (foto por WhatsApp) | `frontend/src/pages/school/EnrollmentIntakeInboxPage.tsx:373`, `:385` y luego `/mark-approved` `:401` (`bff/src/routes/enrollment-intake.routes.ts:232`) | | | No (la fila tiene `wa_phone_number`) |
| C1e | · «Por asignar» (código de escuela) | `frontend/src/lib/api/schoolJoin.ts:121` | | | No |
| C2 | `POST /api/v1/enrollments` (plan a un deportista existente) | `bff/src/routes/enrollments.ts:93`; INSERT `:664`; `emitEnrollmentFees` `:696` → `bff/src/services/enrollmentBilling.ts:401` (RPC `:436`) | No | `emit_enrollment_fees` | No |
| C3 | `POST /api/v1/students/:id/enrollment-fees` («cobrar inscripción después») | `bff/src/routes/students-create-one.route.ts:1545`, `:1558` → `bff/src/services/enrollment-fees-edit.service.ts:152`, `:177` | No | `emit_enrollment_fees` | No |
| C4 | QR público `/join/<slug>` (la familia, con sesión) | `submit_qr_signup` 2 variantes vivas (`20261014113038_…:60` y `:342`; llaman a `emit_enrollment_fees` en `:311` y `:635`); `frontend/src/pages/JoinSchoolPublicPage.tsx:397` | Sí | `emit_enrollment_fees` | No |
| C5 | «Cobros y pagos» (lote), con atleta nuevo (`p_new_athlete`) o existente | `create_charge_batch` (vivo = `20261031121849:26`; atleta nuevo `:87-157`; INSERT de líneas `:236-256`); `bff/src/services/charge-batches.service.ts:274`; reglas de omisión `_charge_duplicate_reason` (`20261010144559`) | Sí (opcional) | Línea con `category='inscripcion'` y monto del cliente (no pasa por `emit_enrollment_fees`) | No |
| C6 | El bot, desde el comprobante | `wa_crear_cobro_desde_comprobante` `20261030123549:237`; `registration_fee` `:383-406` | No | Es **el pago del prospecto** (el que hay que reconocer) | Sí (`p_signup_lead_id`) |

`emit_enrollment_fees` (vivo = `20261010124934:38-157`, md5 sin `\r` `57fcfc19…`) es la **fuente única** de la
inscripción automática: C1, C2, C3 y C4 pasan por ella. Su regla D18 es «inscripción en **cada** alta» (no deduplica
la inscripción; sí el seguro a 365 días).

Clase de prueba (el otro pago previo): `wa_crear_cobro_desde_comprobante` fuente `trial_price` (`:353-381`) y
`registrar_pago_clase_prueba` (`20261030123549:614-679`, desde `frontend/src/hooks/useCobrosClasePrueba.ts:63`).

### 2.2 Caminos que crean deportista o inscripción SIN cobrar inscripción

No duplican, pero tampoco enlazan el prospecto: `bff/src/routes/athletes/bulkUpload.ts:204`,
`bff/src/routes/students.ts:475`, `:1193`, `:1345`, `bff/src/routes/public-booking.routes.ts:860`,
`resolve_school_join_request` y `registrar_clase_prueba_rapida` (crea **un prospecto por nombre con el MISMO
teléfono**: hermanos). Quedan fuera de este plan.

### 2.3 Enlace prospecto ↔ deportista que existe hoy

| # | Qué | Dónde | Problema |
|---|---|---|---|
| E1 | `cerrar_prospecto_clase_prueba(p_lead_id, 'converted', child/user/unreg)` | `20261026155701:288-344` | Llamada aparte, después del alta (no transaccional). Toma la inscripción más reciente del deportista |
| E2 | Cruce nocturno `detectarInscripcionesDeLeads` | `bff/src/services/prospecto-ciclo-clase.service.ts:409-474` (desde `bff/src/jobs/maintenance.job.ts:1101`) | Solo `how_heard='whatsapp'`, 45 días, y solo encuentra **perfiles** por teléfono/correo: sin cuenta no enlaza |
| E3 | Trigger `trg_lead_convertido_mueve_pago` → `_mover_pago_clase_prueba` | `20261029215003:75-133` | Mueve **todos** los pagos sin deportista del prospecto al convertir: la matrícula llega junto al cobro nuevo |
| E4 | `wa_crear_cobro_desde_comprobante` con prospecto ya convertido | `20261030123549:589-592` | Crea el cobro en el prospecto y lo mueve; el control de «ya tiene inscripción» mira el **prospecto** y solo cobros abiertos (`:394-405`, sin `paid`) |

Ningún camino lleva un `signup_lead_id` al alta. No hay `enrollment_id` en `payments` (verificado).

## 3. Cómo enlazar sin adivinar

**Regla: el prospecto viaja como id explícito, elegido por una persona o probado por un token.** El teléfono a solas no
identifica: lo comparten hermanos (`registrar_clase_prueba_rapida` crea un prospecto por nombre con el mismo número),
acudientes con dos escuelas y familias que escriben desde el celular de otro.

| Camino | De dónde sale el id |
|---|---|
| C1c «Completar alta» | Ya está (`prospectoEnAlta.id`): viaja como `signup_lead_id` en el cuerpo de create-one |
| C1a/C1b/C1e alta manual | Aviso en el modal al escribir el teléfono del acudiente: «Este número pagó Inscripción $310.000 el 02/11 como prospecto *Mariana Ruiz*. ¿Es esta persona?». La casilla viene **sin marcar**; marcarla manda el id |
| C1d bandeja de matrículas | Igual, con el `wa_phone_number` de la fila. Con un solo candidato se muestra marcado y a la vista; con varios (hermanos) se elige |
| C4 QR `/join` | Enlace **personal**: `/join/<slug>?p=<token>`. El bot lo genera para ese prospecto y lo manda a ese número; tener el enlace prueba haber recibido el mensaje. `submit_qr_signup` recibe el token, compara su hash, que el QR sea de la misma escuela y que el prospecto no esté usado. Sin token = como hoy (lo atrapa la red de §4.4) |
| C5 Cobros y pagos | El mismo aviso del modal; viaja en `p_new_athlete.signup_lead_id` |
| C2, C3 | Sin contexto de prospecto: no viaja. Los cubre la red de §4.4 |

Candidatos del aviso: endpoint de lectura del BFF
`GET /api/v1/students/prospectos-con-pagos?school_id&telefono` → prospectos de ESA escuela (variantes del teléfono,
como `variantesTelefonoLead`), no descartados ni usados, con pagos vivos sin aplicar. Solo administración
(`administraEstaEscuela`). Devuelve nombre, motivo, monto y fecha: nada que no vea ya en Gestión de Pagos.

## 4. Dónde enganchar

### 4.1 Una función con la regla

`public._aplicar_pagos_del_prospecto(p_lead_id, p_school_id, p_child_id, p_user_id, p_unreg_id) RETURNS jsonb`,
`SECURITY DEFINER`, sin `EXECUTE` para nadie (solo la llaman otras `SECURITY DEFINER`). Hace, en este orden:

1. `SELECT … FROM school_signup_leads WHERE id = p_lead_id AND school_id = p_school_id FOR UPDATE`.
   No existe o `discarded` → `prospecto_invalido`. Ya aplicado a **otro** deportista → `prospecto_ya_usado`
   (el alta se cae con 409 y la pantalla lo explica). Ya aplicado a **este** → devuelve lo de antes (idempotente).
2. `SELECT … FROM payments WHERE signup_lead_id = p_lead_id AND school_id = p_school_id AND status NOT IN
   ('cancelled','failed','rejected','refunded') ORDER BY id FOR UPDATE`.
3. Los pasa al deportista (lo que hoy hace `_mover_pago_clase_prueba`: `child_id`, `parent_id` desde `children`,
   `user_id` o `unregistered_athlete_id`, más `branch_id` si venía nulo). `signup_lead_id` se conserva (rastro).
4. Una fila por pago en el registro `prospecto_pagos_aplicados` (§6), `UNIQUE (payment_id)`: un pago del prospecto se
   aplica **una sola vez** en la vida.
5. Devuelve `{inscripcion: {monto, payment_ids}, clase_prueba: {credito, payment_ids}, movidos: n}` con lo que quede
   **sin consumir** en el registro.

### 4.2 Puerta principal: `emit_enrollment_fees` (cubre C1–C4)

Gana `p_signup_lead_id uuid DEFAULT NULL` al final (DROP de la firma de 11 + CREATE de la de 12, igual que hizo
`20261010124934` para no dejar una sobrecarga ambigua). Con `NULL`, byte a byte lo de hoy. Con prospecto:

- Llama a `_aplicar_pagos_del_prospecto`.
- **Inscripción prepagada** (pagos `inscripcion` del prospecto, cualquier estado vivo: `paid`, `partial`,
  `awaiting_approval`, `pending`, `overdue`): esa fila **ES** la inscripción del alta. Se le estampa
  `offering_plan_id = p_plan_id` y **no** se inserta otra. Si el plan del alta cobra más que lo prepagado → fila
  «Inscripción — diferencia» por el saldo (decisión D2). Si cobra menos → nada (no hay devolución automática) y se
  avisa.
- **Clase de prueba** según el ajuste de la escuela (§5).
- Marca esas filas del registro como consumidas (`aplicado_a_plan_id`), para que un alta posterior del mismo
  deportista vuelva a cobrar inscripción normal (D18 intacta).
- Devuelve en `v_ids` también el id adoptado, para que create-one lo informe en «cobros del alta».

Quién la llama con prospecto y marca la conversión **en la misma transacción** (`status='converted'`,
`converted_enrollment_id` = la inscripción que acaba de crear):

- `create_enrollment_with_payments`: lee `signup_lead_id` de `p_enrollment`; toma el candado del prospecto **al
  empezar** (ver §4.7), lo pasa al elemento `enrollment_fees` y, al final, marca la conversión con `v_enr_id`. Si el
  alta no tiene plan (no hay elemento de inscripción), igual llama a la función para mover y convertir.
- `submit_qr_signup`: resuelve `p_lead_token` → prospecto, candado al empezar, lo pasa a `emit_enrollment_fees` y
  marca la conversión con su inscripción.

Con la conversión dentro de la transacción, `cerrarProspectoInscrito` del frontend queda redundante (al llamarlo con la
misma inscripción, el trigger no corre: `WHEN … IS DISTINCT FROM OLD`). Se quita en la misma entrega.

### 4.3 Puerta secundaria: `create_charge_batch` (C5)

Con `p_new_athlete.signup_lead_id`: después de crear el atleta (`:157`) y antes de planificar (`:184`), llama a la
función. `_charge_duplicate_reason` gana la razón `inscripcion_pagada_como_prospecto`: una línea `inscripcion` para un
atleta con inscripción adoptada sin consumir se **omite** y la vista previa lo muestra en «Omitidas» (el
`preview_hash` lo incluye, así que no hay sorpresa entre vista previa y lote).

### 4.4 Red: conversión tardía (trigger)

`fn_lead_convertido_mueve_pago` pasa a llamar a la misma función (en vez de `_mover_pago_clase_prueba`) y, si el
deportista ya tiene una inscripción **emitida** para el plan de esa inscripción (`offering_plan_id` igual,
`signup_lead_id IS NULL`, creada después del pago del prospecto):

- **Intacta** (`pending`/`overdue`, `amount_paid = 0`, sin comprobante en revisión ni transacción): se anula
  (`cancelled`, nota «La pagó como prospecto: pago X»), registro + `audit_logs`.
- **Con cualquier pago**: no se toca; aviso a la administración («Posible doble cobro de inscripción de *Nombre*»)
  y fila `conflicto` en el registro.

Esto cubre E1 (botón «Ya se inscribió»), E2 (cruce nocturno), C2/C3 y el QR sin token. Decisión D3: anular sola o
solo avisar.

### 4.5 El bot después de la conversión (E4)

En `wa_crear_cobro_desde_comprobante`: si el prospecto ya está convertido, se trabaja con el **deportista** de su
inscripción (`p_child_id`/`p_unregistered_id`), no con el prospecto. Así el «ya tiene cobro» mira el estado de cuenta
real y el comprobante se aplica a la inscripción que ya existe en vez de crear otra. Para `registration_fee` el control
de duplicado del prospecto incluye `paid` (dos matrículas pagadas por el mismo prospecto es un error, no una segunda
alta).

### 4.6 Idempotencia

- `UNIQUE (payment_id)` en el registro: un pago del prospecto no se aplica dos veces, ni por dos altas ni por alta +
  trigger.
- La función, con el prospecto ya aplicado a ese mismo deportista, devuelve el resultado anterior sin escribir.
- `emit_enrollment_fees` solo descuenta lo **no consumido**; una segunda llamada en la misma transacción (create-one con
  dos elementos) no lo descuenta dos veces.
- C5 conserva su idempotencia por `client_request_id`.

### 4.7 Concurrencia: un solo orden de candados

**Prospecto → atleta → pagos.** Hoy el atleta se bloquea con
`pg_advisory_xact_lock(hashtextextended('enrollment_fees:'||atleta, 0))` en `create_enrollment_with_payments`,
`emit_enrollment_fees` y `create_charge_batch`. Si la función de §4.1 pidiera el prospecto **después** de eso,
chocaría con el trigger (que ya tiene el prospecto por el `UPDATE` y pide el atleta): interbloqueo. Por eso:

- `create_enrollment_with_payments`, `submit_qr_signup` y `create_charge_batch` piden `FOR UPDATE` del prospecto
  **antes** del candado de atleta. Dentro, `emit_enrollment_fees` lo vuelve a pedir (misma transacción: no espera).
- El trigger ya entra con el prospecto bloqueado y pide el atleta después.
- `wa_crear_cobro_desde_comprobante` ya bloquea el prospecto (`:333-336`): queda en serie con el alta.
- Pagos: `ORDER BY id FOR UPDATE`, como `create_charge_batch` `:170-175`.

Casos que quedan en serie: dos administradores con el mismo prospecto; alta + familia por QR a la vez; alta + bot
creando el cobro del comprobante en el mismo segundo.

## 5. Clase de prueba de $15.000 (D14, sin responder por Monster)

Ajuste por escuela en `school_trial_class_settings`:
`clase_prueba_abona_a text NOT NULL DEFAULT 'nada' CHECK (clase_prueba_abona_a IN ('nada', 'inscripcion'))`
(text + CHECK y no boolean, por si mañana alguien la abona a la primera mensualidad). Se edita en Clase de prueba →
Configurar, junto al valor.

| | `'nada'` (default = hoy) | `'inscripcion'` |
|---|---|---|
| Al pagar la prueba | Cobro `clase_prueba`, como hoy | Igual |
| Lo que cotiza el bot por la matrícula | El valor del plan | Valor del plan − lo pagado de la prueba (para que el comprobante de $295.000 cuadre) |
| `wa_crear_cobro_desde_comprobante` `registration_fee` para ese prospecto | Precio del plan | Mismo descuento (la base pone el precio; un helper `_precio_inscripcion_prospecto` usado aquí y en `emit_enrollment_fees`) |
| Alta sin matrícula prepagada | Inscripción completa; la prueba pasa a su estado de cuenta como ingreso aparte | Inscripción con `list_amount` = valor del plan, `discount_amount` = $15.000, concepto «… (abono clase de prueba)» |
| Alta con matrícula prepagada | Se adopta (§4.2) | Se adopta; si la familia pagó la matrícula completa antes de que corriera el descuento, no se devuelve nada: aviso a la escuela |
| Abona | — | Solo pruebas `paid` (aprobadas). Una vez (`UNIQUE (payment_id)` en el registro). Tope: el valor de la inscripción |
| Plan sin inscripción | La prueba queda como ingreso | Igual: no hay a qué abonarla |
| No se inscribe nunca | Ingreso de la prueba | Igual |

`'nada'` no cambia ningún número de ninguna escuela. Monster decide; hasta entonces queda en `'nada'`.

## 6. Esquema de migración (NO creada)

Una migración, una sesión, después de aprobado este plan (`npm run migrations:new -- prospecto_pagos_aplicados`):

```sql
-- 1. Registro de aplicación (solo BFF / funciones; RLS sin policies)
CREATE TABLE public.prospecto_pagos_aplicados (
    payment_id          uuid PRIMARY KEY REFERENCES public.payments(id) ON DELETE CASCADE,
    lead_id             uuid NOT NULL REFERENCES public.school_signup_leads(id) ON DELETE CASCADE,
    school_id           uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    child_id            uuid REFERENCES public.children(id) ON DELETE SET NULL,
    user_id             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    unregistered_athlete_id uuid REFERENCES public.unregistered_athletes(id) ON DELETE SET NULL,
    accion              text NOT NULL CHECK (accion IN ('movido', 'inscripcion_adoptada', 'credito_clase_prueba',
                                                        'duplicado_anulado', 'conflicto')),
    monto               numeric NOT NULL DEFAULT 0 CHECK (monto >= 0),
    aplicado_a_plan_id  uuid REFERENCES public.offering_plans(id) ON DELETE SET NULL,
    anulado_payment_id  uuid REFERENCES public.payments(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.prospecto_pagos_aplicados (lead_id);
ALTER TABLE … ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON … FROM PUBLIC, anon, authenticated;  GRANT … TO service_role;

-- 2. Ajuste D14 (text + CHECK, default = hoy)
ALTER TABLE public.school_trial_class_settings ADD COLUMN clase_prueba_abona_a text NOT NULL DEFAULT 'nada'
    CHECK (clase_prueba_abona_a IN ('nada', 'inscripcion'));
-- + guardar_ajustes_clase_prueba acepta la clave (cuerpo vivo + una línea)

-- 3. Token del enlace personal (C4)
ALTER TABLE public.school_signup_leads ADD COLUMN enlace_token_hash text, ADD COLUMN enlace_token_vence timestamptz;
CREATE UNIQUE INDEX … ON public.school_signup_leads (enlace_token_hash) WHERE enlace_token_hash IS NOT NULL;

-- 4. Funciones (todas con SET search_path = pg_catalog, public, pg_temp)
CREATE FUNCTION public._aplicar_pagos_del_prospecto(uuid, uuid, uuid, uuid, uuid) …;     -- REVOKE ALL de PUBLIC, anon, authenticated
CREATE FUNCTION public._precio_inscripcion_prospecto(uuid, uuid, uuid) …;                -- ídem
DROP FUNCTION public.emit_enrollment_fees(uuid,uuid,uuid,uuid,uuid,uuid,uuid,date,text,boolean,boolean);
CREATE FUNCTION public.emit_enrollment_fees(… , p_signup_lead_id uuid DEFAULT NULL);     -- GRANT solo service_role (como hoy)
CREATE OR REPLACE FUNCTION public.create_enrollment_with_payments(uuid, jsonb, jsonb) …;  -- cuerpo VIVO (20261013192955:1529) + prospecto
DROP + CREATE public.submit_qr_signup(… 13 args …, p_lead_token text DEFAULT NULL);        -- ACL viva: authenticated + service_role; conservar guard school_is_operational
CREATE OR REPLACE FUNCTION public.create_charge_batch(…) / public._charge_duplicate_reason(…);
CREATE OR REPLACE FUNCTION public.fn_lead_convertido_mueve_pago() …;                      -- llama a la función nueva + reconciliación §4.4
CREATE OR REPLACE FUNCTION public.wa_crear_cobro_desde_comprobante(…) …;                  -- §4.5 y precio §5

-- 5. Guardas al final (DO): md5 de los cuerpos vivos leídos, ACL esperada, sin sobrecargas de emit_enrollment_fees ni submit_qr_signup.
```

Antes de escribirla: releer los cuerpos **vivos** de las 7 funciones que se reemplazan (hubo deriva en el pasado:
`20261010124934` y `20261014113038` lo documentan) y fijar sus md5 en la guarda. `_mover_pago_clase_prueba` se deja
(sin uso) para revertir.

**Fuera de la base (misma entrega):**
- BFF: zod de create-one acepta `signup_lead_id` y lo pone en `p_enrollment`; `409 PROSPECTO_YA_USADO`;
  endpoint de candidatos (§3); `enlaceDeInscripcion(schoolId, leadId?)` genera el token (32 bytes, se guarda el sha256,
  vence a los 30 días) y lo agrega al enlace; `charge-batches.service.ts` pasa el id en `p_new_athlete`.
- Frontend: aviso con casilla en `CreateChildModal`, `CreateAdultAthleteModal`, bandeja de matrículas y Cobros y pagos;
  `prospectoEnAlta.id` viaja; se quita `cerrarProspectoInscrito`; `JoinSchoolPublicPage` lee `?p=` y lo manda;
  Configurar de Clase de prueba con el ajuste D14.
- Una sola sesión aplica la migración; `types.ts` una vez al final.

## 7. Pruebas

**SQL en el gemelo** (`npm run qa:twin:up`, estilo `supabase/migrations/_smoke/enrollment_fees_smoke.sql`), nuevo
`supabase/migrations/_smoke/prospecto_pagos_smoke.sql`:
1. Sin prospecto: `emit_enrollment_fees` da exactamente las mismas filas que hoy (regresión de D18 y del seguro).
2. Matrícula prepagada `paid` → alta con el mismo plan: **una** inscripción (la adoptada), `offering_plan_id` puesto,
   prospecto `converted` con la inscripción, registro con `inscripcion_adoptada`.
3. Igual con el pago en `awaiting_approval` y en `pending`.
4. Plan del alta más caro → fila «diferencia» por el saldo; más barato → nada + aviso.
5. Re-alta del mismo deportista meses después → inscripción normal (lo prepagado ya está consumido).
6. Prospecto ya usado por otro deportista → `prospecto_ya_usado`, nada escrito.
7. D14 `'nada'` vs `'inscripcion'`: prueba `paid` abona $15.000 una vez; prueba `awaiting_approval` no abona; tope en
   el valor de la inscripción.
8. Conversión tardía (botón / cruce): duplicado intacto → anulado; duplicado con abono → intacto + `conflicto`.
9. `wa_crear_cobro_desde_comprobante` con prospecto convertido → `ya_tiene_cobro` del deportista, no crea otro.
10. Token: válido / de otra escuela / vencido / ya usado / sin token (comportamiento de hoy).
11. ACL: `has_function_privilege` de `authenticated`/`anon` en falso para las nuevas; `submit_qr_signup` igual que hoy.

**Concurrencia** (como `supabase/migrations/_smoke/pruebas-cobros-y-pagos-concurrencia.mjs`, dos conexiones al gemelo):
- Dos `create_enrollment_with_payments` con el mismo prospecto a la vez → una gana, la otra `prospecto_ya_usado`; una
  sola inscripción adoptada.
- Alta + `submit_qr_signup` con token del mismo prospecto → en serie, sin interbloqueo.
- Alta + `wa_crear_cobro_desde_comprobante` del mismo prospecto en el mismo instante → el cobro termina en el
  deportista y hay una sola inscripción.
- Alta + `cerrar_prospecto_clase_prueba` del mismo prospecto → sin `deadlock detected` (orden de candados §4.7).

**BFF (vitest):** create-one pasa `signup_lead_id` y traduce `PROSPECTO_YA_USADO` a 409; endpoint de candidatos solo
para administración y acotado a la escuela; `enlaceDeInscripcion` con prospecto agrega `?p=` y guarda solo el hash.
**Frontend (vitest):** el aviso aparece con un candidato marcado a la vista, con varios obliga a elegir, y sin marcar
no manda el id. **E2E en vivo** (dev, con permiso): `npm run qa:embudo` extendido con «paga matrícula → alta → una
sola inscripción».

## 8. Riesgos

- **`submit_qr_signup` tiene dos variantes y ya perdió su guard una vez** (`20261014113038`). Cambiarle la firma
  exige DROP + CREATE y reponer ACL y guard: la guarda del DO lo verifica. Alternativa más chica: dejar C4 para una
  segunda entrega y confiar en la red §4.4 mientras tanto (decisión D5).
- **create-one inserta `children` fuera de la transacción** (`:795`, antes de la RPC). Si la RPC falla, el niño queda
  y el pago del prospecto NO se movió (todo lo del prospecto va dentro de la RPC): no se pierde dinero, pero queda la
  ficha. Ya pasa hoy; no se arregla aquí.
- **Exonerar la inscripción con matrícula prepagada:** exonerar no devuelve el pago. La pantalla lo avisa; la fila
  adoptada se queda.
- **Anular un cobro automáticamente** (§4.4) toca dinero sin clic: solo filas intactas, con nota y `audit_logs`.
  Si se prefiere solo avisar, D3.
- **`open_month` y la clase de prueba** (B4 L12): ya cerrado en vivo (`open_month` y `preview_open_month` excluyen
  `'clase_prueba'` y `'reserva'`, verificado hoy en `pg_proc`). Un pago movido del prospecto no se confunde con la
  mensualidad.
- **Disk IO:** todo es por PK o por índices existentes (`idx_payments_signup_lead`, PK de leads); el endpoint de
  candidatos lee por `(school_id, phone)` de `school_signup_leads` (tabla chica: 96 filas). Sin jobs nuevos.

## 9. Radio (consultas puntuales, 2026-11-03)

```sql
select … from payments p where p.signup_lead_id is not null group by escuela, categoría, estado;  -- 0 filas
```

| Medida | Valor |
|---|---|
| Pagos con `signup_lead_id` | **0** (ni de clase de prueba ni de matrícula) |
| Escuelas con `wa_cobro_desde_comprobante = true` | **0** |
| Prospectos en total / convertidos con inscripción | 96 / 2 |
| Escuelas con `trial_price` | 1: Monster´s Volley Club, $15.000 |
| Monster: prospectos / esperados / cobros del bot | 0 / 0 / 0 |
| Monster: planes activos con `registration_fee > 0` | **0** (la matrícula de $310.000 todavía no está en sus planes) |

Ninguna fila existente cambia con la migración: el registro nace vacío, el ajuste nace en `'nada'`, `emit_enrollment_fees`
sin prospecto se comporta igual y el trigger nuevo solo corre en conversiones futuras.

## 10. Decisiones para el usuario

| # | Decisión | Propuesta |
|---|---|---|
| D1 | ¿Enlace explícito (casilla / token) o automático por teléfono + nombre? | Explícito. Automático solo como sugerencia |
| D2 | Plan del alta con inscripción distinta a lo prepagado | Más cara: cobrar la diferencia. Más barata: nada, aviso a la escuela |
| D3 | Conversión tardía con inscripción duplicada intacta | Anularla sola, con nota y auditoría. Con abono: solo avisar |
| D4 (= D14 de Monster) | ¿La prueba se abona a la matrícula? | Ajuste por escuela, default `'nada'`; Monster elige. Abonan solo pruebas aprobadas |
| D5 | ¿El QR con token entra en esta entrega o en la siguiente? | Esta, porque el bot manda `/join` justo después de la matrícula; si se quiere menos riesgo, la siguiente con la red §4.4 |
| D6 | Vencimiento del token del enlace | 30 días |
