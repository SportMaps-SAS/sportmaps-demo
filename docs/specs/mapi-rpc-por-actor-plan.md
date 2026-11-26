# Plan: RPC por actor para Mapi (lo que hoy exige `auth.uid()`, también por WhatsApp)

> **Estado: PLAN PARA APROBAR, revisión 2 (2026-11-25).**
>
> - No hay migración escrita, no se corrió `migrations:new` y no se tocó la base.
> - Todo lo de la base salió de consultas puntuales `--read-only` a las definiciones
>   **vivas**, no a las del repo.
> - `CLAUDE.md` exige aprobar el plan antes de escribir la migración. Este documento trae el
>   SQL exacto.
>
> La **rev. 2** aplica las decisiones del usuario del 2026-11-25 (§1):
>
> - Diseño B para las 9 RPC existentes.
> - Diseño A (núcleo) para la plata.
> - Tope por escuela en `school_settings.mapi_tope_aprobacion`.
> - `registrar_pago_efectivo` entra al piloto.
> - M2 va **después** del arreglo de los campos del comprobante que escribe la familia. Ese
>   arreglo tiene migración propia y no está en este plan.
>
> Lo que cambió frente a la rev. 1 está en §13.
>
> Se lee junto con:
>
> - `docs/specs/mapi-agente-plan.md` §21–§22;
> - `docs/specs/mapi-admin-por-whatsapp-plan.md` §12.

## 0. Resumen

Por WhatsApp no hay JWT. Quien habla es el número suscrito, y de ahí salen `profile_id` y
`school_id`.

Nueve RPC de las pantallas autorizan con `auth.uid()`, así que hoy Mapi solo puede usarlas
con la sesión de la app. Además faltan las dos RPC de plata de §22.2 del plan de Mapi.

### Las 9 existentes: diseño B

Son pausa, vista previa de la pausa, reactivar, baja, evaluar, felicitar y tres de clase de
prueba.

- **Las 9 originales no se tocan.**
- Cada una gana una `<rpc>_por(p_actor, …)`, que solo puede ejecutar `service_role`. La
  `_por` hace tres cosas:
  1. Saca la escuela del objeto: inscripción, sesión, conversación o el `p_school_id`.
  2. Llama a `_por_actuar_como`, que:
     - exige que la llamada venga de `service_role`;
     - fija `sub = p_actor` en los claims de **esa transacción**;
     - revisa el rol del actor en esa escuela con los **mismos helpers vivos** de la
       pantalla.
  3. Llama a la RPC original.
- Dentro de la original, `auth.uid()`, `is_school_admin()` y `user_staff_school_ids()`
  responden por el actor, y los triggers de auditoría lo anotan.
- No hay núcleos ni helpers `_de` para estas 9.

### La plata: diseño A

**`aprobar_comprobante`** (nueva):

- Tiene tres piezas: `aprobar_comprobante_nucleo(p_actor, …)`, la gemela
  `aprobar_comprobante(…)` para la pantalla y `aprobar_comprobante_por(p_actor, …)`.
- Lleva al servidor lo que hoy hace el navegador en `approvePayment.ts`, que son tres
  escrituras sueltas.
- Incluye `FOR UPDATE`, idempotencia, el abono «Parcial», el aviso a la familia, el nivel 2
  recalculado y el tope de la escuela.

**`register_manual_payments`** (existente):

- Se parte en núcleo, original y `_por`.
- La original conserva la misma firma y hace lo mismo.
- El núcleo suma el **abono** a un cobro.
- La `_por` es `registrar_pago_efectivo` para Mapi: solo efectivo, un cobro, sin pasarse
  del saldo.

**Los dos núcleos:**

- Reciben `p_actor` explícito y lo escriben en `approved_by`, `unblocked_by` y
  `pago_operaciones.actor_id`.
- Exigen que `p_actor` sea igual a `auth.uid()`. Tanto la gemela como la `_por` lo
  garantizan.
- Por eso usan los helpers vivos y en ningún lado hay espejos `_de`.

### El tope

- Es la columna nueva `school_settings.mapi_tope_aprobacion integer NOT NULL DEFAULT 400000
  CHECK (> 0)`.
- Solo la cambia la administración de esa escuela **desde la app**. Un trigger bloquea a
  `service_role`, que es como corren el BFF, el bot y Mapi (§3.4).
- La RPC toma ese valor y el BFF solo puede bajarlo.
- El tope cuenta el monto que se acredita y también lo que dice el comprobante.

### Migraciones y BFF

- **Dos migraciones**, las dos aplicadas por una sola sesión:
  - M1: `_por_actuar_como` y las 9 `_por`. Va cuando se apruebe.
  - M2: la plata. Va **después** del arreglo del usuario sobre los campos del comprobante
    (§7).
  - `types.ts` se regenera una sola vez.
- **BFF**:
  - `escuela.ts`, `entrenador.ts` e `informes.ts` dejan `userClient` y llaman
    `supabase.rpc('<rpc>_por', { p_actor: alcance.userId, … })`.
  - Con eso las herramientas quedan disponibles por WhatsApp.
  - Entran `aprobar_pago` y `registrar_pago_efectivo`, con el botón directo de WhatsApp.

## 1. Decisiones del usuario y dónde quedan

| Fecha | Decisión | Dónde queda |
|---|---|---|
| 11-24 | «Migrarlas ya» (las RPC que exigen `auth.uid()`) | M1, §5 |
| 11-24 | La plata también se confirma con el botón de WhatsApp | §8.3: sin `confirmaEnApp`. La seguridad la ponen el tope, el nivel 2, la llave y la revalidación al clic |
| 11-25 | Diseño B para las 9 existentes: `_por` delgada que fija el actor y llama a la original | §3.1, §5 |
| 11-25 | Diseño A (núcleo) para la plata | §3.1, §6 |
| 11-25 | El tope va en `school_settings.mapi_tope_aprobacion` (integer, default 400000, > 0). Lo cambia la administración desde la app, nunca Mapi. Cuenta lo que dice el comprobante. El BFF solo lo baja | §3.4, §6.1 |
| 11-25 | `registrar_pago_efectivo` entra al piloto: solo admin, un cobro, sin pasar el saldo, con el tope de la escuela y auditoría de actor y canal | §6.5, §8.2 |
| 11-25 → 11-26 | Nivel 2 para un abono: la definición de la rev. 1, **confirmada por el usuario el 2026-11-26** | §3.5 |
| 11-26 | El tope lo cambia la administración de la escuela (desde la app) | §3.4 |
| 11-26 | El arreglo del veredicto (prerrequisito de M2) ya está vivo: `20261125140410` | §7 |
| 11-25 | El hueco «la familia escribe `receipt_verdict` y `ocr_*`» se arregla aparte, en su propia migración. **M2 se aplica después** | §7, §2.3 #4 |

## 2. Lo que dicen las definiciones vivas (2026-11-25)

### 2.1 Método

- Consultas puntuales por nombre a `pg_proc`, `pg_trigger`, `pg_policies`,
  `information_schema` y `pg_default_acl`, siempre con
  `npx supabase db query --remote --read-only`.
- Nunca se listaron todas las funciones (regla de Disk IO).
- Las definiciones quedaron en el scratchpad de la sesión (`rpc-vivas/*.sql`), no en el
  repo.
- Se compararon con la **última** migración del repo que define cada función. El resultado
  está en §2.3.

### 2.2 Qué hace hoy cada RPC (cita de la definición viva)

| RPC | Gate vivo (cita) | Qué escribe con el actor | Con `service_role` (sin `auth.uid()`) | ACL viva |
|---|---|---|---|---|
| `preview_enrollment_pause` (STABLE) | `v_es_admin := COALESCE(public.is_super_admin(), false) OR COALESCE(public.is_school_admin(v_e.school_id), false)`, o acudiente (`is_parent_of_child`), o `v_e.user_id = auth.uid()` | nada (cuenta cobros) | menor → «No autorizado.»; **adulto → pasa** (la comparación con NULL da NULL y el `IF` no lanza) | authenticated, service_role |
| `pause_enrollment_directly` | `IF v_caller IS NOT NULL AND NOT COALESCE(public.is_super_admin(), false) AND NOT COALESCE(public.is_school_admin(v_e.school_id), false)` | `requested_by`, `reviewed_by`; `pause_aplicar(v_id, v_caller)` → `paused_by` | **pasa sin gate y deja NULL** en las tres columnas | authenticated, service_role |
| `resume_enrollment` | igual que la anterior (`v_caller IS NOT NULL AND …`) | `resumed_by` | **pasa sin gate y deja NULL** | authenticated, service_role |
| `set_school_athlete_status` | `IF NOT (public.is_super_admin() OR public.is_school_admin(p_school_id))` | nada propio (solo los triggers de `payments`) | «No autorizado.» | authenticated, service_role |
| `submit_post_training_coach_rating` | `ss.coach_auth_id = auth.uid() AND ss.school_id = … AND ss.status = 'active'`, y una fila en `team_coaches` del equipo de la sesión | `performance_entries.recorded_by = auth.uid()` | 42501 | authenticated, service_role |
| `give_kudos` | `IF v_uid IS NULL THEN … '42501'`; `p_school_id = ANY (public.user_staff_school_ids()) OR public.is_platform_admin()`; el coach, solo sus equipos (`_v2_alcance_entrenador` + `user_coached_team_ids()`) | `athlete_kudos.coach_id = v_uid` | 42501 | authenticated, service_role |
| `clases_prueba_semana` (STABLE) | `v_admin := public.is_super_admin() OR p_school_id = ANY (public.user_admin_school_ids())`; si no es admin, staff y solo `user_coached_team_ids()`, sin montos | nada | Forbidden | authenticated, service_role |
| `listar_clase_prueba` (STABLE) | `public.is_super_admin() OR p_school_id = ANY (public.user_staff_school_ids())` | nada | Forbidden | authenticated, service_role |
| `agendar_clase_prueba_desde_chat` | staff de la escuela de **la conversación**; con `p_monto`, además `is_school_admin` | `source_detail.agendada_por = auth.uid()`; el pago, con `created_by` y `approved_by = auth.uid()` | Forbidden | authenticated, service_role |
| `register_manual_payments` | `IF v_uid IS NULL THEN 'no_autenticado'`; `is_school_admin(p_school_id) OR is_super_admin()`; `school_is_operational` | `approved_by`, `unblocked_by` | 42501 | authenticated, service_role |
| *(aprobación manual)* | No hay RPC. `frontend/src/lib/approvePayment.ts` hace `UPDATE payments` + `UPDATE enrollments` + `notify_user` desde el navegador. La autorizan la policy «Payments: update admin» (`school_members.role IN ('owner','admin','school_admin','super_admin')`) y `trial_block_update` (`school_is_operational`) | `approved_by`, `unblocked_by` | — | — |
| `auto_approve_payment` | sin gate (solo `service_role`) | `approved_by = NULL` («sistema») | es su camino | service_role |

**Helpers vivos que usan:**

- `is_school_admin(p_school_id)`: roles `('owner','admin','school_admin')` activos, por
  `auth.uid()`.
- `is_super_admin()`: es lo mismo que `is_platform_admin()`.
- `is_platform_admin()`: la marca `app_metadata.platform_admin` del JWT, o
  `platform_admins.is_active`.
- `user_staff_school_ids()`: miembros salvo `parent`, `athlete` y `accountant`, más
  `school_staff` por `coach_auth_id` o por correo, más `schools.owner_id`.
- `user_admin_school_ids()`: `owner`, `admin`, `school_admin`, `super_admin`, más
  `owner_id`.
- `user_coached_team_ids()`.
- `is_parent_of_child()`.
- `_v2_alcance_entrenador()`.

Todos leen `auth.uid()`. Por eso, con el actor fijado en los claims (§3.2), responden por el
actor sin cambiar nada.

**Triggers que leen `auth.uid()` en las tablas que tocan estas RPC:**

- `audit_trigger_func` escribe `audit_logs.profile_id`. Está en `payments`,
  `school_signup_leads` y `school_trial_slots`.
- `fn_log_payment_status_change` escribe `payment_audit_logs.changed_by`. Está en
  `payments`.
- `audit_school_settings_changes` escribe `audit_logs` con OLD y NEW en cada UPDATE de
  `school_settings`.

Llamados con `service_role` sin actor, los tres dejan **NULL**. Así quedan hoy todas las
escrituras del BFF con service role, por ejemplo `cambiar_plan` de Mapi.

**Triggers que miran el rol y no la persona:**

- `fn_payments_pronto_pago_servidor` mira `auth.role()`.
- `fn_guard_payments_client` y `fn_payments_receipt_review_columns` miran `current_user`.

Dentro de una RPC `DEFINER` o con `service_role`, estos tres se comportan como «servidor».
No cambian con el actor fijado.

### 2.3 Lo que la base dice y el repo no (deriva y diferencias)

1. **Casi todo coincide con el repo.** Las 9 RPC, `register_manual_payments` y los helpers
   son IGUALES a su última migración del repo (se comparó el cuerpo, normalizando espacios
   y comentarios). La excepción es la siguiente.
   - **`is_school_admin` tiene deriva.**
     - La última del repo (`20260415000001_security_hardening_phase2.sql`) es
       `LANGUAGE sql STABLE`, con roles `('owner','admin','super_admin')`.
     - La viva es `LANGUAGE plpgsql` **sin `STABLE`** (o sea VOLATILE), con roles
       `('owner','admin','school_admin')`, `search_path = public` y `EXECUTE` para `anon`.
     - Alguien la cambió por fuera del repo.
   - El gate de las `_por` usa la **viva**.
   - Que sea VOLATILE pesa en las policies que la usan. Es un hallazgo fuera de este plan.
2. **Pausa y reactivación sin actor pasan de largo** (`IF v_caller IS NOT NULL AND …`).
   - Con `service_role`, cualquiera pausa sin gate y quedan en NULL `requested_by`,
     `reviewed_by`, `paused_by` y `resumed_by`.
   - Las originales no se tocan. La `_por` siempre llega con actor fijado, así que el gate
     de la original sí corre.
3. **`preview_enrollment_pause` con `service_role` responde para adultos.**
   `v_e.user_id = auth.uid()` con NULL da NULL y el `IF` no lanza.
   - `escuela.ts` dice que «responde No autorizado», pero eso solo pasa con menores.
   - Con la `_por` deja de importar: la `_por` exige admin y fija el actor.
4. **La familia puede escribir el veredicto de su propio comprobante.**
   - La policy «Payments: update parent» la deja actualizar sus cobros.
   - `fn_guard_payments_client` no bloquea `receipt_verdict`, `receipt_verdict_reasons`,
     `ocr_*`, `receipt_image_sha256` ni `receipt_image_sha256_source`.
   - `has_column_privilege` da UPDATE para `authenticated`.
   - Consecuencia: «Aprobar todos los verdes» y cualquier nivel 2 calculado **solo con lo
     guardado** confían en datos que la familia puede forjar.
   - **Lo arregla el usuario en su propia migración.** Es prerrequisito de M2 (§7).
   - Mientras tanto, y también después, el nivel 2 de Mapi se recalcula **desde la imagen**
     en el BFF (§8.2). El chequeo en SQL es un piso.
5. **`auto_approve_payment` no toma `FOR UPDATE` ni mira `FOUND` después del `UPDATE`.**
   - Si una persona aprueba en el mismo instante, la automática actualiza 0 filas.
   - Igual activa inscripciones y manda «Validamos tu comprobante automáticamente…». La
     familia recibe un aviso doble.
   - La prueba P6 lo deja documentado.
6. **`submit_post_training_coach_rating` solo reconoce al coach por `coach_auth_id`.** No
   tiene el respaldo por correo que sí tiene `user_coached_team_ids()`.
   - Un admin que no esté en `team_coaches` recibe 42501, aunque Mapi le ofrece
     `evaluar_entreno` al rol admin.
7. **`listar_clase_prueba` deja a cualquier coach leer datos de los prospectos**: teléfono,
   correo, notas y fecha de nacimiento (el gate es de staff).
   - La `_por` es más estricta: solo admin. La pantalla no se toca y esto se reporta
     aparte.
8. **`_notify_school_staff` avisa a `owner` y `admin`, pero no a `school_admin`.** Es el
   mismo patrón del hallazgo §22.4 #5 del plan de Mapi.
9. **`approvePayment.ts` activa inscripciones sin filtrar por deportista.** Si el cobro no
   tiene `child_id`, `unregistered_athlete_id` ni `user_id`, el filtro queda
   `school_id + status='pending'`.
   - El núcleo nuevo exige el deportista (`ELSE false`).
10. **`school_settings`:**
    - Dos policies `FOR ALL` dejan escribir **toda la fila** a la administración:
      - «Admin puede escribir school_settings», por `owner_id`;
      - «School settings: manage admin», por `is_school_admin`.
    - Los coaches no tienen policy de escritura.
    - `service_role` ignora RLS.
    - Ya existen guardas de columna por trigger: `school_settings_mapi_agent_guard` y
      `guard_hours_plan_enabled_super_admin_only`.
    - `tr_audit_school_settings` audita cada UPDATE con OLD, NEW y `auth.uid()`.
    - `auto_approve_max_amount` (numeric, default 0) es el tope de la **aprobación
      automática**. Es otra cosa distinta del tope de Mapi (§3.4).
11. **No hay choques de nombres.** No existe ninguna función `%_por`, `_por_actuar_como`,
    `_comprobante_nivel2_falta`, `_formato_cop`, `aprobar_comprobante`,
    `register_manual_payments_nucleo` ni `school_settings_mapi_tope_guard`, ni la tabla
    `pago_operaciones`, ni la columna `mapi_tope_aprobacion`.
12. **Default privileges del esquema `public` (dueño `postgres`):**
    - Funciones: `EXECUTE` solo para `postgres` y `service_role`. Por eso los núcleos y
      helpers revocan también a `service_role`, y las `_por` lo conservan.
    - Tablas: `authenticated` recibe `arwdm`. Por eso `pago_operaciones` lleva `REVOKE`
      explícito y RLS sin policies.
13. **Que no se olvide:**
    - `retiro_actor(p_actor)` y `retiro_es_admin(p_school_id, p_uid)`, de `20261106160004`,
      son el precedente de «actor explícito solo con `service_role`».
    - `resume_enrollment` y `set_school_athlete_status` se llaman **por dentro** desde la
      resolución de retiros y reactivaciones de esa misma migración (líneas 934, 975 y
      979). Con B ese camino no cambia.

### 2.4 Huella de las definiciones vivas

**Para qué sirve:**

- **Antes de M1**, confirma que las 9 no cambiaron desde este análisis (las `_por` las
  llaman con su firma y su semántica de hoy).
- **Después de M1**, los hashes de las 9 tienen que seguir **iguales**: B no las toca
  (§10.4).
- **Antes de M2**, `register_manual_payments` tiene que seguir igual, porque su lógica se
  copia al núcleo.

| Función | `md5(pg_get_functiondef(oid))` al 2026-11-25 |
|---|---|
| `preview_enrollment_pause` | `ef944b076523fda3d0f05e2922ec9a37` |
| `pause_enrollment_directly` | `e53dc6f668e0d927780aa54c7400974c` |
| `resume_enrollment` | `2a874595d324b5a64b4aab92dff81a89` |
| `set_school_athlete_status` | `813db0a767fd8eba54713cbcdb522b23` |
| `submit_post_training_coach_rating` | `8330cdcef3bd5db43ce1ab8b597b6939` |
| `give_kudos` | `9caf40a8fd15dd9035afda05dc17569f` |
| `clases_prueba_semana` | `70fe9ef8cf8eff5f776a5a45ee581531` |
| `listar_clase_prueba` | `59b9136db480ba500bde123d5948f442` |
| `agendar_clase_prueba_desde_chat` | `3e1650b78b29cf3e9076e6bbf7c5344c` |
| `register_manual_payments` | `57d1b36bee52393b79656e809a031c25` |
| `is_school_admin` | `dc455734b6308d63329221e43e624c90` |
| `user_staff_school_ids` | `43ec93e638fd6d61a853724083618703` |
| `user_admin_school_ids` | `53d0a31fc9e50b10e3930e8c28acb620` |
| `is_platform_admin` | `4bc924dd616dbeb5e0a7d913e8ee2fc8` |

Los hashes se verificaron contra la base para `give_kudos`, `is_school_admin` y
`register_manual_payments`.

## 3. Diseño

### 3.1 Dos diseños, uno por grupo

| | B: las 9 existentes | A: la plata |
|---|---|---|
| Piezas | `<rpc>_por(p_actor, …)` | `<rpc>_nucleo(p_actor, …)` + original o gemela + `<rpc>_por(p_actor, …)` |
| La RPC de la pantalla | **No se toca** (ni cuerpo, ni firma, ni ACL) | `register_manual_payments`: misma firma, delega al núcleo. `aprobar_comprobante`: nueva |
| Lógica de negocio | La de la original, tal cual | En el núcleo, una sola vez, para la pantalla y para Mapi |
| Actor | Fijado en los claims por `_por_actuar_como`; la original lo lee con `auth.uid()` | Explícito (`p_actor`), y el núcleo exige `p_actor = auth.uid()`. Los dos caminos lo garantizan |
| Helpers `_de` | No hay | No hay: el núcleo usa los helpers vivos, porque `auth.uid()` ya es el actor |
| Por qué | No reescribe funciones de pantalla ni copia helpers (menos riesgo, menos deriva) | Es lógica **nueva** en la base (hoy vive en el navegador), con abono, tope, idempotencia y nivel 2. Necesita un solo lugar |

La escuela **nunca** viene del modelo:

- Las `_por` la sacan del objeto: inscripción, sesión, conversación o cobro.
- Cuando la RPC recibe `p_school_id` (baja, kudos, clases, efectivo), el gate revisa el
  rol del actor en **esa** escuela, y la original o el núcleo vuelve a atarlo a ella.

### 3.2 `_por_actuar_como(p_actor, p_school_id, p_rol)`

La llaman todas las `_por`, las 9 de B y las 2 de plata. En orden:

1. **Exige `service_role`** (`auth.role()`).
   - Si la transacción ya tiene persona, tiene que ser la misma. Nunca reemplaza la sesión
     de un usuario ni cambia de actor a mitad de camino.
   - Exige actor, escuela y un rol válido (`admin` o `staff`).
2. **Fija el actor** hasta el final de **esa** transacción:

   ```sql
   PERFORM set_config('request.jwt.claims',
           (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
              || jsonb_build_object('sub', p_actor::text))::text, true);
   PERFORM set_config('request.jwt.claim.sub', p_actor::text, true);
   ```

   - `auth.uid()` lee primero `request.jwt.claim.sub` y luego `request.jwt.claims ->> 'sub'`
     (definición viva), así que queda resuelto en los dos caminos.
   - El `role` de los claims no se toca: `auth.role()` sigue siendo `service_role`.
3. **Pregunta con los helpers vivos.**
   - `admin`: `public.is_school_admin(p_school_id)`, es decir, miembro activo
     owner/admin/school_admin. Es lo mismo que usa `alcance.ts`.
   - `staff`: `p_school_id = ANY (public.user_staff_school_ids())`.
   - Si falla, la transacción se revierte entera y el actor fijado se va con ella.

**Por qué el actor sobrevive al salir de `_por_actuar_como`.**

- Esa función tiene `SET search_path`, así que al salir PostgreSQL restaura **solo**
  `search_path`.
- El `set_config(…, true)` de otra variable queda vigente hasta el final de la
  transacción. En `guc.c`, `AtEOXact_GUC`, al salir de una función con `SET`, restaura solo
  las entradas `GUC_SAVE`. Las `GUC_LOCAL` se pasan al nivel de afuera.
- Las pruebas T5 y T9 lo comprueban: `auth.uid()` = actor en la original y en los
  triggers.

**Seguridad.**

- Solo `service_role` llega ahí: es el único con `EXECUTE` sobre las `_por`, y la función
  lo revisa.
- El cambio vale para una sola request, porque PostgREST abre una transacción por request.
  No pasa a otra ni con el pooler en modo transacción (§10.3 lo prueba).
- No es la opción (c) que rechazó `mapi-admin-por-whatsapp-plan.md` §12.5, el JWT corto
  firmado. Aquí no se emite nada reutilizable, y antes de actuar se valida el rol del actor
  en esa escuela.
- Con `p_actor`, el BFF «dice quién es» igual que en cualquier diseño `_por`. Esto solo
  hace que la RPC y los triggers lo vean.

**Efecto en los triggers.**

- Los que leen `auth.uid()` ven al actor, como con la pantalla:
  - `audit_logs`;
  - `payment_audit_logs`;
  - las exclusiones del tipo «no notificar a quien felicita».
- Los que leen `auth.role()` o `current_user` siguen viendo «servidor», como hoy con el
  BFF: `fn_payments_pronto_pago_servidor`, `fn_guard_payments_client` y
  `fn_payments_receipt_review_columns`.

### 3.3 Los núcleos de plata y el actor

Los dos núcleos empiezan así:

```sql
IF p_actor IS NULL THEN RAISE EXCEPTION 'no_autenticado' USING ERRCODE = '42501'; END IF;
IF p_actor IS DISTINCT FROM auth.uid() THEN
  RAISE EXCEPTION 'actor_distinto: el actor no coincide con la sesión' USING ERRCODE = '42501';
END IF;
```

- La gemela de la pantalla pasa `(SELECT auth.uid())`.
- La `_por` pasa `p_actor` después de `_por_actuar_como`, que ya dejó `auth.uid() = p_actor`.
- Con esa garantía, los gates del núcleo usan los helpers vivos:
  - **aprobar**: `user_admin_school_ids()` o `is_platform_admin()`, que es el alcance de la
    policy «Payments: update admin»; más `school_is_operational`;
  - **registrar**: `is_school_admin()` o `is_super_admin()`, literal al vivo.
- Nadie puede ejecutar un núcleo directamente (sin `EXECUTE` para nadie, `SECURITY
  INVOKER`).

### 3.4 El tope por escuela: `school_settings.mapi_tope_aprobacion`

**Valor**

- `integer NOT NULL DEFAULT 400000 CHECK (mapi_tope_aprobacion > 0)`.
- Agregar una columna `NOT NULL` con default constante no reescribe la tabla (PG ≥ 11), así
  que no cuesta Disk IO.

**Cómo se usa**

- Lo leen `aprobar_comprobante_por` y `register_manual_payments_por`:
  `v_tope := LEAST(tope_escuela, COALESCE(p_tope, tope_escuela))`.
- El BFF solo puede **bajarlo**. Con `p_tope <= 0` responde `tope_invalido`.
- Si la escuela no tiene fila en `school_settings`, vale el default, 400.000.

**Qué cuenta**

- Al aprobar: lo que se acredita **o** lo que dice el comprobante (`ocr_amount`), lo que
  sea mayor.
  - Así, un comprobante de $900.000 sobre un cobro de $300.000 no mete $600.000 de saldo a
    favor desde el chat (`trg_payments_saldo_a_favor_al_aprobar`).
- En efectivo: el monto recibido.

**Quién lo cambia: la administración de esa escuela, desde la app. Nunca Mapi, ni el BFF,
ni el bot.**

Las razones:

- **El tope limita lo que mueven Mapi y el bot.** Ellos corren con `service_role`: lo que
  queda limitado por el tope no puede ser lo que lo sube.
- **No le da más poder a nadie.** En la app, la administración ya aprueba cualquier monto
  en la pantalla Aprobar. El tope solo limita el canal del chat, así que dejárselo a las
  mismas personas no amplía lo que pueden hacer.
- **Coaches y contadores no tocan `school_settings`** (no tienen policy de escritura).

**La trampa 4 de `CLAUDE.md` (RLS filtra filas, no columnas)**

Las policies `FOR ALL` ya restringen la **fila** a la administración. Pero:

- `service_role` las ignora;
- cualquier escritura de la fila con un valor viejo de esta columna la pisaría.

Por eso la columna lleva su propio trigger, `school_settings_mapi_tope_guard`, en la línea
de `school_settings_mapi_agent_guard`:

| Quién escribe | Qué pasa |
|---|---|
| Un UPDATE que deja el mismo valor (guardar otros ajustes, o un upsert de la fila) | Pasa |
| `service_role` (BFF, bot, Mapi) | **INSERT**: la columna nace en 400.000. **UPDATE** que la cambia: error `tope_bloqueado` |
| `authenticated` admin de **esa** escuela (`user_admin_school_ids()`, el mismo conjunto de las dos policies de escritura) o de plataforma | Pasa |
| `authenticated` sin ese rol | **INSERT**: 400.000. **UPDATE**: `tope_bloqueado` (RLS ya lo para antes; esto es la segunda capa) |
| Sin claims (migraciones, SQL editor de SportMaps) | Pasa. Es la vía de soporte mientras no exista el campo en la pantalla |

- La auditoría ya existe: `tr_audit_school_settings` deja OLD, NEW y `auth.uid()` en
  `audit_logs` en cada UPDATE.
- El tope de Mapi **no** es `auto_approve_max_amount`, el de la aprobación **automática**.
  Uno limita a la máquina sin persona; el otro, a una persona que confirma desde el chat.
  Se dejan separados a propósito (decisión §12 #4).

### 3.5 Nivel 2: definición en la base (piso)

`_comprobante_nivel2_falta(p_payment_id, p_abono)` devuelve el motivo por el que **no** es
nivel 2, o NULL si lo es.

**Condiciones comunes:**

- estado `awaiting_approval`, con `receipt_url`;
- lectura y veredicto sellados por el servidor (`receipt_image_sha256_source = 'server_verified'`, regla del Paso 4, migración `20261125140410`);
- monto que **no** eligió el navegador (`amount_source <> 'cliente'`);
- sin `requires_review` y sin abonos previos;
- sin `POSIBLE_MANIPULACION`;
- el comprobante no está compartido con otro cobro;
- foto y referencia nunca vistas en la escuela;
- ese mes no estaba ya pagado.

**Pago completo:**

- `receipt_verdict = 'verde'`;
- `ocr_amount` igual al saldo, con ±0,5 % (`TOLERANCIA_MONTO` del job de pagos por
  validar).

**Abono (confirmado por el usuario el 2026-11-26):**

- el comprobante es **amarillo solo por `MONTO_DIFIERE`**;
- el monto leído es menor que el saldo;
- se aprueba **exactamente el monto leído**.

Con el arreglo del usuario sobre los campos del comprobante, este piso pasa a ser confiable.
Antes, la prueba la pone la relectura de la imagen en el BFF (§8.2).

### 3.6 Matriz de privilegios esperada (después de M1 y M2)

| Objeto | `anon` | `authenticated` | `service_role` |
|---|:-:|:-:|:-:|
| Las 9 originales (sin cambios) y `register_manual_payments` | ✘ | ✔ | ✔ |
| `aprobar_comprobante` (gemela para la pantalla) | ✘ | ✔ | ✘ |
| `*_por` (11) | ✘ | ✘ | ✔ |
| `_por_actuar_como`, `aprobar_comprobante_nucleo`, `register_manual_payments_nucleo`, `_comprobante_nivel2_falta`, `_formato_cop`, `school_settings_mapi_tope_guard` | ✘ | ✘ | ✘ |
| Tabla `pago_operaciones` | ✘ | ✘ | ✔ (default; ignora RLS) |
| Columna `school_settings.mapi_tope_aprobacion` | por las policies de la fila + el trigger (§3.4) | igual | lectura; escritura bloqueada por el trigger |

## 4. Ficha por RPC

Lo común a las 9 de B:

- **Original**: no cambia. Pantalla, ACL y llamadas internas quedan igual.
- **Pruebas comunes** (§9):
  - la original sigue igual: md5 idéntico y la caracterización da lo mismo antes y
    después;
  - la `_por` con un actor válido (OK y el actor anotado);
  - con un actor de otra escuela (`sin_permiso`);
  - con actor NULL (`actor_requerido`);
  - llamada como `authenticated` (`permission denied`).

### 4.1 `preview_enrollment_pause`

| | |
|---|---|
| Hoy | §2.2. STABLE. Cuenta los `payments` pending/overdue de esos meses (`mensualidad` → a anular; otra categoría → ambiguos) |
| `_por` | `preview_enrollment_pause_por(p_actor, p_enrollment_id, p_month_from, p_month_to)`, VOLATILE (fija el actor) |
| Gate | admin de `enrollments.school_id` (la original también deja pasar al acudiente y al adulto; la `_por` no) |
| Pantallas | Alumnos › «Vacaciones / pausa» (`PauseAthleteDialog.tsx`, `hooks/usePauses.ts`); acudiente: Mis hijos › pausa (`ChildPauseSection`, `RequestPauseDialog`, `PlanDelDeportista`) |
| Pruebas propias | Acudiente por la `_por` → `sin_permiso` |

### 4.2 `pause_enrollment_directly`

| | |
|---|---|
| Hoy | Candado advisory por inscripción; `pause_validar(…, true)`; solicitud `approved` con `requested_by` y `reviewed_by`; `pause_aplicar` (anula los cobros del periodo y deja `paused_by`) |
| `_por` | `pause_enrollment_directly_por(p_actor, …)` |
| Gate | admin de la escuela de la inscripción |
| Pantallas | Alumnos › «Vacaciones / pausa» (`usePauses.ts`) |
| Pruebas propias | `requested_by = reviewed_by = paused_by = actor`; en los cobros anulados, `audit_logs.profile_id` y `payment_audit_logs.changed_by` = actor |

### 4.3 `resume_enrollment`

| | |
|---|---|
| Hoy | Mismo gate de la pausa; compensa la vigencia (`days_extended`), deja `resumed_by` y limpia la pausa |
| `_por` | `resume_enrollment_por(p_actor, p_enrollment_id, p_note)` |
| Gate | admin |
| Pantallas | Alumnos › «Reactivar de la pausa» (`usePauses.ts`); **llamada interna** desde la resolución de reactivaciones (`20261106160004`, línea 979) |
| Pruebas propias | `resumed_by = actor`; si no está en pausa → «Esta inscripción no está pausada.» |

### 4.4 `set_school_athlete_status`

| | |
|---|---|
| Hoy | Inactiva o reactiva la ficha; cancela las inscripciones activas; anula `pending/awaiting_approval/overdue` (no toca `paid` ni `partial`); cancela la invitación pendiente |
| `_por` | `set_school_athlete_status_por(p_actor, p_school_id, p_athlete_type, p_athlete_id, p_active)` |
| Gate | admin de `p_school_id`; la original vuelve a atarlo a esa escuela |
| Pantallas | Alumnos › Inactivar/Reactivar (`SchoolStudentsManagementPage.tsx`, `usePauses.ts`); **llamada interna** desde la resolución de retiros (`20261106160004`, líneas 934 y 975) |
| Pruebas propias | Admin de A con `p_school_id = A` sobre un deportista de B → «Atleta no encontrado en esta escuela.»; con `p_school_id = B` → `sin_permiso` |

### 4.5 `submit_post_training_coach_rating`

| | |
|---|---|
| Hoy | `FOR UPDATE` de la sesión; solo el coach del equipo (`coach_auth_id` + `team_coaches`); solo los que vinieron; no cambia un informe publicado |
| `_por` | `submit_post_training_coach_rating_por(p_actor, p_session_id, p_ratings, p_coach_notes)` |
| Gate | staff de la escuela de la sesión; que sea **el** coach del equipo lo exige la original |
| Pantallas | Coach V2 › Evaluar (`CoachEvaluateV2.tsx`, `coachV2Logic.ts`), `CoachPostTrainingRatingDialog` (`CoachAttendancePage`), cola offline `lib/offline/bandejaEvaluar.ts` |
| Pruebas propias | Coach de otro equipo de la misma escuela → 42501 de la original; `recorded_by = actor` |

### 4.6 `give_kudos`

| | |
|---|---|
| Hoy | Staff o plataforma; el coach, solo sus equipos; una por deportista al día (`KUDOS_DAILY_LIMIT`); notifica a la familia, no a quien felicita |
| `_por` | `give_kudos_por(p_actor, p_school_id, p_child_id, p_athlete_user_id, p_message, p_unregistered_athlete_id)` |
| Gate | staff de `p_school_id` |
| Pantallas | Coach V2 › Felicitar (`FelicitarSheet` → `lib/api/v2Contratos.ts`), `DeportistasTab`, `CoachEvaluateV2` |
| Pruebas propias | `coach_id = actor`; la notificación no le llega al actor; coach con un deportista ajeno → 42501 |

### 4.7 `clases_prueba_semana`

| | |
|---|---|
| Hoy | Rango de 31 días o menos; el admin ve todo, con monto; el coach, solo sus equipos y sin monto |
| `_por` | `clases_prueba_semana_por(p_actor, p_school_id, p_desde, p_hasta)` |
| Gate | staff |
| Pantallas | Coach V2 › Sesiones › Semana (`useSemanaAjustes.ts`) |
| Pruebas propias | Con actor coach: sin `monto` y solo sus equipos |

### 4.8 `listar_clase_prueba`

| | |
|---|---|
| Hoy | Staff (coaches incluidos); devuelve teléfono, correo, notas y fecha de nacimiento (§2.3 #7) |
| `_por` | `listar_clase_prueba_por(p_actor, p_school_id)` |
| Gate | **admin** (más estricto que la original) |
| Pantallas | Deportistas › «Clase de prueba» (`hooks/useClasePrueba.ts`: `ClasePruebaPanel`, `ProspectoDetalleEmbudo`…) |
| Pruebas propias | Coach por la `_por` → `sin_permiso` |

### 4.9 `agendar_clase_prueba_desde_chat`

| | |
|---|---|
| Hoy | Gate por la escuela de la conversación; `FOR UPDATE` del cupo y del prospecto; reagenda liberando el cupo anterior; con `p_monto` crea el pago `paid` (solo admin) |
| `_por` | `agendar_clase_prueba_desde_chat_por(p_actor, p_conversation_id, p_slot_id, p_nombre, p_fecha_nacimiento, p_genero, p_acudiente)`, **sin parámetros de plata** (a la original le pasa `p_monto/p_metodo/p_referencia = NULL`) |
| Gate | admin de la escuela de la conversación |
| Pantallas | WhatsApp › buzón › «Agendar» (`AgendarClasePruebaDialog.tsx`, dentro de `Conversaciones.tsx`) |
| Pruebas propias | `source_detail.agendada_por = actor`; en `audit_logs` de `school_signup_leads` y `school_trial_slots`, `profile_id = actor`; conversación de otra escuela → `sin_permiso` |

### 4.10 `aprobar_comprobante` (nueva, diseño A)

| | |
|---|---|
| Hoy | No existe. La aprobación manual son tres escrituras desde el navegador (`approvePayment.ts`), sin candado sobre `amount_paid` |
| Núcleo | `aprobar_comprobante_nucleo(p_actor, p_payment_id, p_abono, p_pagado_antes, p_monto_confirmado, p_motivo_confirmado, p_avisar, p_solo_nivel2, p_tope, p_idempotency_key, p_canal)` |
| Qué hace el núcleo | Las cuentas de `approvalMath`; `FOR UPDATE`; candado optimista `p_pagado_antes`; abono → `partial`; activa la inscripción solo con pago completo de mensualidad; aviso a la familia con el texto de la app; idempotencia en `pago_operaciones` |
| Gemela | `aprobar_comprobante(p_payment_id, p_abono, p_pagado_antes, p_monto_confirmado, p_motivo_confirmado, p_avisar)` → núcleo sin nivel, sin tope y sin llave. **Ninguna pantalla la usa todavía** (§12 #2) |
| `_por` | `aprobar_comprobante_por(p_actor, p_payment_id, p_abono, p_pagado_antes, p_idempotency_key, p_canal, p_tope)` |
| Gate | admin, miembro activo de la escuela del cobro (`_por_actuar_como`); llave y `pagado_antes` obligatorios; **nivel 2 obligatorio**; tope de la escuela (§3.4) |
| Pantallas | Ninguna hoy. Después: `ApprovePaymentMethodSheet` y `BulkApproveGreensDialog` (Gestión de Pagos) |
| Pruebas | §9.3 y §9.4 |

### 4.11 `register_manual_payments` (diseño A)

| | |
|---|---|
| Hoy | Varios cobros de UN deportista (pending/overdue) se saldan completos, en una transacción, con `FOR UPDATE`; máximo 50 |
| Núcleo | `register_manual_payments_nucleo(…, p_monto, p_pagado_antes, p_avisar, p_tope, p_idempotency_key, p_canal)`. Con `p_monto` NULL hace **exactamente lo de hoy**. Con `p_monto` registra el abono, o el pago exacto, sobre **un** cobro pending/overdue/partial, sin pasarse del saldo |
| Original | Misma firma de 7 parámetros → núcleo con `p_monto = NULL` y sin aviso (el modal avisa desde el navegador, como hoy) |
| `_por` (`registrar_pago_efectivo`) | `register_manual_payments_por(p_actor, p_school_id, p_payment_id, p_monto, p_pagado_antes, p_idempotency_key, p_fecha, p_canal, p_tope)`, **solo efectivo** (§12 #5) |
| Gate de la `_por` | admin; tope de la escuela; avisa a la familia; referencia `CASH-MAPI-xxxxxxxx` derivada de la llave |
| Auditoría | `approved_by` y `unblocked_by` = actor; `audit_logs` y `payment_audit_logs` con el actor (§3.2); `pago_operaciones` con `actor_id` y `canal` |
| Pantallas | «Registrar pago» › varios cobros (`RegisterCashPaymentModal.tsx`, `handleSaveMulti`), dentro de Gestión de Pagos / «Cobros y pagos» |
| Tras el cambio | Igual (misma respuesta `{payment_ids, count, total}`) |
| Pruebas | Abono de 100.000 sobre 145.000 → `partial`; luego 45.000 → `paid`; 46.000 → `monto_mayor_que_saldo`; más que el tope de la escuela → `supera_tope` |

## 5. SQL propuesto — Migración M1 (diseño B, las 9 existentes)

Se crea con `npm run migrations:new -- mapi_rpc_por_actor_existentes`. **No se corre
ahora.** Las 9 originales **no aparecen** en el archivo.

```sql
-- =============================================================================
-- <versión>_mapi_rpc_por_actor_existentes.sql
-- Plan: docs/specs/mapi-rpc-por-actor-plan.md (rev. 2, diseño B; aprobado el AAAA-MM-DD)
-- Las 9 RPC que autorizan con auth.uid() NO se tocan. Cada una gana una _por
-- (solo service_role) que valida el rol del actor en la escuela del objeto, fija
-- el actor en los claims de ESTA transacción y llama a la original.
-- =============================================================================

-- ── 1. Gate común y actor de la transacción ──────────────────────────────────
CREATE OR REPLACE FUNCTION public._por_actuar_como(p_actor uuid, p_school_id uuid, p_rol text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- 1) Solo el servidor. Si la transacción ya actúa a nombre de alguien, tiene que
  --    ser la misma persona: nunca reemplaza una sesión ni cambia de actor.
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'solo_servidor: esta función la llama el servidor' USING ERRCODE = '42501';
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor_requerido: falta quién actúa' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'actor_distinto: la transacción ya actúa a nombre de otra persona' USING ERRCODE = '42501';
  END IF;
  IF p_school_id IS NULL THEN
    RAISE EXCEPTION 'no_encontrado: no existe o no tiene escuela' USING ERRCODE = 'P0002';
  END IF;
  IF p_rol IS NULL OR p_rol NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'rol_invalido: %', p_rol USING ERRCODE = '22023';
  END IF;

  -- 2) Actor hasta el final de ESTA transacción (PostgREST abre una por request).
  --    role sigue siendo service_role. Si el gate de abajo falla, la transacción se
  --    revierte entera y esto se va con ella. Al salir de esta función solo se
  --    restaura search_path (su cláusula SET); los claims siguen vigentes.
  PERFORM set_config('request.jwt.claims',
          (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
             || jsonb_build_object('sub', p_actor::text))::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_actor::text, true);

  -- 3) El rol, con los MISMOS helpers vivos de la pantalla y las policies.
  --    admin = miembro activo owner/admin/school_admin (lo mismo que alcance.ts del BFF).
  IF p_rol = 'admin' AND NOT COALESCE(public.is_school_admin(p_school_id), false) THEN
    RAISE EXCEPTION 'sin_permiso: no es de la administración activa de esta escuela' USING ERRCODE = '42501';
  END IF;
  IF p_rol = 'staff' AND NOT (p_school_id = ANY (public.user_staff_school_ids())) THEN
    RAISE EXCEPTION 'sin_permiso: no trabaja en esta escuela' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._por_actuar_como(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public._por_actuar_como(uuid, uuid, text) IS
  'Gate de las *_por (plan mapi-rpc-por-actor): service_role, fija sub = actor en ESTA transacción y exige rol admin/staff en ESA escuela con los helpers vivos.';

-- ── 2. Las 9 _por: escuela del objeto → gate → la RPC ORIGINAL ───────────────
-- VOLATILE todas, también las de lectura: fijan el actor (set_config).

CREATE OR REPLACE FUNCTION public.preview_enrollment_pause_por(p_actor uuid, p_enrollment_id uuid, p_month_from date, p_month_to date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
BEGIN
  SELECT e.school_id INTO v_school FROM public.enrollments e WHERE e.id = p_enrollment_id;
  PERFORM public._por_actuar_como(p_actor, v_school, 'admin');
  RETURN public.preview_enrollment_pause(p_enrollment_id, p_month_from, p_month_to);
END;
$$;

CREATE OR REPLACE FUNCTION public.pause_enrollment_directly_por(p_actor uuid, p_enrollment_id uuid, p_reason text, p_month_from date, p_month_to date, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
BEGIN
  SELECT e.school_id INTO v_school FROM public.enrollments e WHERE e.id = p_enrollment_id;
  PERFORM public._por_actuar_como(p_actor, v_school, 'admin');
  RETURN public.pause_enrollment_directly(p_enrollment_id, p_reason, p_month_from, p_month_to, p_note);
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_enrollment_por(p_actor uuid, p_enrollment_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
BEGIN
  SELECT e.school_id INTO v_school FROM public.enrollments e WHERE e.id = p_enrollment_id;
  PERFORM public._por_actuar_como(p_actor, v_school, 'admin');
  RETURN public.resume_enrollment(p_enrollment_id, p_note);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_school_athlete_status_por(p_actor uuid, p_school_id uuid, p_athlete_type text, p_athlete_id uuid, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public._por_actuar_como(p_actor, p_school_id, 'admin');
  RETURN public.set_school_athlete_status(p_school_id, p_athlete_type, p_athlete_id, p_active);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_post_training_coach_rating_por(p_actor uuid, p_session_id uuid, p_ratings jsonb, p_coach_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
BEGIN
  SELECT s.school_id INTO v_school FROM public.attendance_sessions s WHERE s.id = p_session_id;
  -- Staff de la escuela de la sesión; que sea EL coach del equipo lo exige la original.
  PERFORM public._por_actuar_como(p_actor, v_school, 'staff');
  RETURN public.submit_post_training_coach_rating(p_session_id, p_ratings, p_coach_notes);
END;
$$;

CREATE OR REPLACE FUNCTION public.give_kudos_por(p_actor uuid, p_school_id uuid, p_child_id uuid, p_athlete_user_id uuid, p_message text, p_unregistered_athlete_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- El coach solo felicita a los de sus equipos: lo exige la original.
  PERFORM public._por_actuar_como(p_actor, p_school_id, 'staff');
  RETURN public.give_kudos(p_school_id, p_child_id, p_athlete_user_id, p_message, p_unregistered_athlete_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.clases_prueba_semana_por(p_actor uuid, p_school_id uuid, p_desde date, p_hasta date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- La original recorta al coach a sus equipos y le esconde los montos.
  PERFORM public._por_actuar_como(p_actor, p_school_id, 'staff');
  RETURN public.clases_prueba_semana(p_school_id, p_desde, p_hasta);
END;
$$;

CREATE OR REPLACE FUNCTION public.listar_clase_prueba_por(p_actor uuid, p_school_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Más estricta que la original (staff): trae teléfonos y correos de prospectos.
  PERFORM public._por_actuar_como(p_actor, p_school_id, 'admin');
  RETURN public.listar_clase_prueba(p_school_id);
END;
$$;

-- Sin parámetros de plata: registrar el pago de la clase no es de Mapi.
CREATE OR REPLACE FUNCTION public.agendar_clase_prueba_desde_chat_por(p_actor uuid, p_conversation_id uuid, p_slot_id uuid, p_nombre text, p_fecha_nacimiento date DEFAULT NULL, p_genero text DEFAULT NULL, p_acudiente text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
BEGIN
  SELECT c.school_id INTO v_school FROM public.whatsapp_conversations c WHERE c.id = p_conversation_id;
  PERFORM public._por_actuar_como(p_actor, v_school, 'admin');
  RETURN public.agendar_clase_prueba_desde_chat(
    p_conversation_id, p_slot_id, p_nombre, p_fecha_nacimiento, p_genero, p_acudiente,
    NULL, NULL, NULL);
END;
$$;

-- ── 3. Privilegios: solo service_role ejecuta las _por ───────────────────────
REVOKE ALL ON FUNCTION public.preview_enrollment_pause_por(uuid, uuid, date, date)                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pause_enrollment_directly_por(uuid, uuid, text, date, date, text)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resume_enrollment_por(uuid, uuid, text)                                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_school_athlete_status_por(uuid, uuid, text, uuid, boolean)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_post_training_coach_rating_por(uuid, uuid, jsonb, text)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.give_kudos_por(uuid, uuid, uuid, uuid, text, uuid)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clases_prueba_semana_por(uuid, uuid, date, date)                            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listar_clase_prueba_por(uuid, uuid)                                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agendar_clase_prueba_desde_chat_por(uuid, uuid, uuid, text, date, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_enrollment_pause_por(uuid, uuid, date, date)                         TO service_role;
GRANT EXECUTE ON FUNCTION public.pause_enrollment_directly_por(uuid, uuid, text, date, date, text)            TO service_role;
GRANT EXECUTE ON FUNCTION public.resume_enrollment_por(uuid, uuid, text)                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.set_school_athlete_status_por(uuid, uuid, text, uuid, boolean)              TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_post_training_coach_rating_por(uuid, uuid, jsonb, text)              TO service_role;
GRANT EXECUTE ON FUNCTION public.give_kudos_por(uuid, uuid, uuid, uuid, text, uuid)                          TO service_role;
GRANT EXECUTE ON FUNCTION public.clases_prueba_semana_por(uuid, uuid, date, date)                            TO service_role;
GRANT EXECUTE ON FUNCTION public.listar_clase_prueba_por(uuid, uuid)                                         TO service_role;
GRANT EXECUTE ON FUNCTION public.agendar_clase_prueba_desde_chat_por(uuid, uuid, uuid, text, date, text, text) TO service_role;
```

## 6. SQL propuesto — Migración M2 (diseño A, plata)

Se crea con `npm run migrations:new -- mapi_plata_por_actor`.

**Va después de dos cosas:**

1. **M1**, porque usa `_por_actuar_como`.
2. **La migración del usuario que cierra la escritura de la familia** sobre
   `receipt_verdict`, `receipt_verdict_reasons`, `ocr_*` y `receipt_image_sha256(_source)`
   (§2.3 #4, §7).

**Requisito para ese arreglo:**

- Tiene que dejar pasar las escrituras hechas **dentro** de RPC `DEFINER`, distinguiendo
  por `current_user`, como `fn_guard_payments_client`.
- La razón: `register_manual_payments` copia en el cobro los campos OCR que manda el modal
  de la administración, y lo hace dentro de una RPC.
- Si el arreglo mira `auth.role()`, rompe el registro de transferencias con comprobante:
  hoy dentro de la original, y después dentro del núcleo.

### 6.1 Tope por escuela

```sql
-- =============================================================================
-- <versión>_mapi_plata_por_actor.sql
-- Plan: docs/specs/mapi-rpc-por-actor-plan.md §6 (rev. 2; aprobado el AAAA-MM-DD)
-- Prerrequisitos: M1 (_por_actuar_como) y la migración que cierra la escritura de
-- la familia sobre receipt_verdict / ocr_* (plan §7).
-- =============================================================================

-- ── 1. Tope de Mapi por escuela ──────────────────────────────────────────────
-- Constante en la tabla (PG ≥ 11 no reescribe la tabla por un DEFAULT constante).
ALTER TABLE public.school_settings
    ADD COLUMN IF NOT EXISTS mapi_tope_aprobacion integer NOT NULL DEFAULT 400000
        CONSTRAINT school_settings_mapi_tope_aprobacion_check CHECK (mapi_tope_aprobacion > 0);

COMMENT ON COLUMN public.school_settings.mapi_tope_aprobacion IS
    'Tope por operación (pesos) para aprobar comprobantes o registrar efectivo desde Mapi (app o WhatsApp). Cuenta también lo que dice el comprobante. Lo cambia SOLO la administración de la escuela desde la app (trigger school_settings_mapi_tope_guard); el servidor (BFF, bot, Mapi) no. Distinto de auto_approve_max_amount (aprobación automática).';

-- Trampa 4 de CLAUDE.md: las policies FOR ALL dan la FILA a la administración y
-- service_role las ignora; la columna lleva su candado propio. tr_audit_school_settings
-- ya deja OLD/NEW y auth.uid() en audit_logs en cada UPDATE.
CREATE OR REPLACE FUNCTION public.school_settings_mapi_tope_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rol text := COALESCE(auth.role(), '');
BEGIN
  -- Guardar otros ajustes (o un upsert de la fila completa) con el mismo tope: pasa.
  IF TG_OP = 'UPDATE' AND NEW.mapi_tope_aprobacion IS NOT DISTINCT FROM OLD.mapi_tope_aprobacion THEN
    RETURN NEW;
  END IF;

  -- El servidor (BFF, bot y Mapi corren con service_role): el tope limita justo lo
  -- que él mueve, así que nunca lo cambia. Una fila nueva nace en el default.
  IF v_rol = 'service_role' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.mapi_tope_aprobacion := 400000;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tope_bloqueado: el tope de Mapi se cambia desde la app, no desde el servidor'
      USING ERRCODE = '42501';
  END IF;

  -- Desde la app: la administración de ESA escuela (el mismo conjunto de las dos
  -- policies de escritura: owner_id y owner/admin/school_admin) o plataforma.
  IF v_rol IN ('authenticated', 'anon')
     AND NOT (NEW.school_id = ANY (public.user_admin_school_ids()) OR public.is_platform_admin()) THEN
    IF TG_OP = 'INSERT' THEN
      NEW.mapi_tope_aprobacion := 400000;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tope_bloqueado: solo la administración de la escuela cambia el tope de Mapi'
      USING ERRCODE = '42501';
  END IF;

  -- Sin claims (migraciones, SQL editor de SportMaps): pasa.
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.school_settings_mapi_tope_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS school_settings_mapi_tope_guard ON public.school_settings;
CREATE TRIGGER school_settings_mapi_tope_guard
    BEFORE INSERT OR UPDATE OF mapi_tope_aprobacion ON public.school_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.school_settings_mapi_tope_guard();
```

### 6.2 Formato, registro de operaciones y nivel 2

```sql
-- ── 2. Plata en los avisos ($145.000), como formatCurrency de la app ──────────
CREATE OR REPLACE FUNCTION public._formato_cop(p_valor numeric)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  -- En to_char la ',' es la coma literal (no depende del locale); se pasa a punto.
  SELECT '$' || replace(to_char(round(COALESCE(p_valor, 0)), 'FM999,999,999,990'), ',', '.');
$$;
REVOKE ALL ON FUNCTION public._formato_cop(numeric) FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. Operaciones de plata: idempotencia, quién y por dónde ─────────────────
CREATE TABLE IF NOT EXISTS public.pago_operaciones (
    idempotency_key uuid        PRIMARY KEY,
    tipo            text        NOT NULL CHECK (tipo IN ('aprobar_comprobante', 'registrar_pago')),
    canal           text        NOT NULL CHECK (canal IN ('app', 'mapi_app', 'mapi_whatsapp')),
    school_id       uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    actor_id        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    payment_ids     uuid[]      NOT NULL,
    monto           numeric     NOT NULL CHECK (monto >= 0),
    resultado       jsonb       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pago_operaciones_escuela_fecha_idx
    ON public.pago_operaciones (school_id, created_at DESC);
ALTER TABLE public.pago_operaciones ENABLE ROW LEVEL SECURITY;
-- Sin policies: la escriben los núcleos (dueño) y la lee el BFF (service_role).
-- Los default privileges le dan arwdm a authenticated: se quitan explícitamente.
REVOKE ALL ON TABLE public.pago_operaciones FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.pago_operaciones IS
  'Operaciones de plata con llave de idempotencia (Mapi): una por borrador confirmado, con actor y canal. Plan mapi-rpc-por-actor §6.';

-- ── 4. Nivel 2 (§21 del plan de Mapi) recalculado en la base: PISO ───────────
-- Devuelve el motivo por el que NO es nivel 2, o NULL si lo es. La definición del
-- abono la confirmó el usuario el 2026-11-26 (plan §3.5).
CREATE OR REPLACE FUNCTION public._comprobante_nivel2_falta(p_payment_id uuid, p_abono numeric)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v         public.payments%ROWTYPE;
  v_rem     numeric;
  v_codigos text[];
BEGIN
  SELECT * INTO v FROM public.payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RETURN 'cobro_no_encontrado'; END IF;
  IF v.status <> 'awaiting_approval' THEN RETURN 'no_esta_por_validar'; END IF;
  IF v.receipt_url IS NULL THEN RETURN 'sin_comprobante'; END IF;
  -- Paso 4 (20261125140410): la lectura y el veredicto valen solo si los selló el servidor.
  IF COALESCE(v.receipt_image_sha256_source, '') <> 'server_verified' THEN RETURN 'lectura_no_sellada_por_el_servidor'; END IF;
  -- Monto elegido por el navegador: lo aprueba una persona en la pantalla (como auto_approve_payment).
  IF COALESCE(v.amount_source, 'servidor') = 'cliente' THEN RETURN 'monto_elegido_por_quien_paga'; END IF;
  IF COALESCE(v.requires_review, false) THEN RETURN 'intento_de_pasarela_en_revision'; END IF;
  IF COALESCE(v.amount_paid, 0) > 0 THEN RETURN 'tiene_abonos_previos'; END IF;

  v_codigos := ARRAY(
    SELECT DISTINCT r ->> 'code'
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.receipt_verdict_reasons) = 'array'
                                     THEN v.receipt_verdict_reasons ELSE '[]'::jsonb END) AS r);
  IF 'POSIBLE_MANIPULACION' = ANY (v_codigos) THEN RETURN 'posible_manipulacion'; END IF;

  v_rem := GREATEST(COALESCE(v.amount, 0) - GREATEST(COALESCE(v.early_payment_discount_applied, 0), 0)
                    - COALESCE(v.amount_paid, 0), 0);
  IF v.ocr_amount IS NULL OR v_rem <= 0 THEN RETURN 'sin_monto_leido'; END IF;
  IF p_abono IS NULL OR p_abono <= 0 THEN RETURN 'sin_monto'; END IF;
  IF p_abono > v_rem THEN RETURN 'abono_mayor_que_saldo'; END IF;

  IF p_abono = v_rem THEN
    -- Pago completo: verde y monto leído = saldo (±0,5 %: TOLERANCIA_MONTO de pagos-por-validar.job).
    IF v.receipt_verdict IS DISTINCT FROM 'verde' THEN RETURN 'no_esta_en_verde'; END IF;
    IF abs(v.ocr_amount - v_rem) / v_rem > 0.005 THEN RETURN 'monto_leido_no_coincide'; END IF;
  ELSE
    -- Abono (§20.4 regla 6): se aprueba lo que dice el comprobante y lo ÚNICO que no
    -- cuadra es el monto (amarillo solo por MONTO_DIFIERE). Confirmada por el usuario el 2026-11-26.
    IF round(v.ocr_amount) <> round(p_abono) THEN RETURN 'abono_distinto_del_comprobante'; END IF;
    IF v.receipt_verdict IS DISTINCT FROM 'amarillo'
       OR EXISTS (SELECT 1 FROM unnest(v_codigos) AS c WHERE c IS DISTINCT FROM 'MONTO_DIFIERE') THEN
      RETURN 'abono_con_otras_dudas';
    END IF;
  END IF;

  -- Un comprobante para varios cobros: va por la pantalla (como «Aprobar todos los verdes»).
  IF EXISTS (SELECT 1 FROM public.payments o
              WHERE o.school_id = v.school_id AND o.id <> v.id
                AND o.receipt_url = v.receipt_url
                AND o.status NOT IN ('rejected', 'cancelled', 'failed')) THEN
    RETURN 'comprobante_cubre_varios_cobros';
  END IF;
  -- Foto y referencia nunca vistas en la escuela.
  IF v.receipt_image_sha256 IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.payments o
        WHERE o.school_id = v.school_id AND o.id <> v.id
          AND o.receipt_image_sha256 = v.receipt_image_sha256
          AND o.status NOT IN ('rejected', 'cancelled', 'failed')) THEN
    RETURN 'foto_repetida';
  END IF;
  IF v.receipt_reference_norm IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.payments o
        WHERE o.school_id = v.school_id AND o.id <> v.id
          AND o.receipt_reference_norm = v.receipt_reference_norm
          AND o.status NOT IN ('rejected', 'cancelled', 'failed')) THEN
    RETURN 'referencia_repetida';
  END IF;
  -- Ese mes ya lo pagó otro cobro (periodosYaPagados del job).
  IF v.child_id IS NOT NULL AND v.period_year IS NOT NULL AND v.period_month IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.payments o
        WHERE o.child_id = v.child_id AND o.id <> v.id
          AND o.period_year = v.period_year AND o.period_month = v.period_month
          AND o.status IN ('paid', 'approved')) THEN
    RETURN 'ese_mes_ya_estaba_pagado';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._comprobante_nivel2_falta(uuid, numeric) FROM PUBLIC, anon, authenticated, service_role;
```

### 6.3 `aprobar_comprobante`

```sql
-- ── 5. aprobar_comprobante ───────────────────────────────────────────────────
-- Lo que hoy hace el navegador en frontend/src/lib/approvePayment.ts, en una
-- transacción: FOR UPDATE, cuentas de approvalMath, abono → 'partial', inscripción
-- solo con mensualidad completa, aviso a la familia con el mismo texto.
CREATE OR REPLACE FUNCTION public.aprobar_comprobante_nucleo(
    p_actor             uuid,
    p_payment_id        uuid,
    p_abono             numeric DEFAULT NULL,   -- NULL = el saldo completo
    p_pagado_antes      numeric DEFAULT NULL,   -- candado optimista: amount_paid que vio quien aprueba
    p_monto_confirmado  numeric DEFAULT NULL,   -- escuelas con receipt_amount_editable (Dynasty)
    p_motivo_confirmado text    DEFAULT NULL,
    p_avisar            boolean DEFAULT true,
    p_solo_nivel2       boolean DEFAULT false,
    p_tope              numeric DEFAULT NULL,
    p_idempotency_key   uuid    DEFAULT NULL,
    p_canal             text    DEFAULT 'app'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_p         public.payments%ROWTYPE;
  v_ya        jsonb;
  v_due       numeric;
  v_prev      numeric;
  v_rem       numeric;
  v_abono     numeric;
  v_total     numeric;
  v_es_abono  boolean;
  v_saldo     numeric;
  v_pagado    numeric;
  v_metodo    text;
  v_falta     text;
  v_dest      uuid;
  v_escuela   text;
  v_activadas int := 0;
  v_res       jsonb;
BEGIN
  -- El actor es el de la sesión: la gemela pasa auth.uid() y la _por ya lo fijó
  -- (plan §3.3). Con eso, los gates usan los helpers vivos.
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'no_autenticado' USING ERRCODE = '42501';
  END IF;
  IF p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'actor_distinto: el actor no coincide con la sesión' USING ERRCODE = '42501';
  END IF;
  IF p_abono IS NOT NULL AND p_abono <= 0 THEN
    RAISE EXCEPTION 'monto_invalido: el abono tiene que ser mayor que cero' USING ERRCODE = '22023';
  END IF;
  IF p_canal IS NULL OR p_canal NOT IN ('app', 'mapi_app', 'mapi_whatsapp') THEN
    RAISE EXCEPTION 'canal_invalido: %', p_canal USING ERRCODE = '22023';
  END IF;

  -- Idempotencia: el mismo borrador no se aplica dos veces, ni con dos clics a la vez
  -- (el candado de la llave serializa los reintentos antes de mirar el cobro).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('pago_operaciones:' || p_idempotency_key::text, 0));
    SELECT o.resultado INTO v_ya FROM public.pago_operaciones o WHERE o.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_ya || jsonb_build_object('ya_aplicada', true);
    END IF;
  END IF;

  SELECT * INTO v_p FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cobro_no_encontrado' USING ERRCODE = 'P0002';
  END IF;

  -- Mismo alcance que la policy «Payments: update admin» de la pantalla.
  IF NOT (v_p.school_id = ANY (public.user_admin_school_ids()) OR COALESCE(public.is_platform_admin(), false)) THEN
    RAISE EXCEPTION 'sin_permiso: solo la administración de la escuela aprueba pagos' USING ERRCODE = '42501';
  END IF;
  -- Mismo candado que la policy trial_block_update.
  IF NOT public.school_is_operational(v_p.school_id) THEN
    RAISE EXCEPTION 'escuela_no_operativa: la cuenta de la escuela está bloqueada para esta operación'
      USING ERRCODE = '42501';
  END IF;
  IF v_p.status NOT IN ('awaiting_approval', 'pending', 'overdue', 'partial') THEN
    RAISE EXCEPTION 'cobro_no_abierto: este cobro ya no está abierto (pudo aprobarse mientras tanto)'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_pagado_antes IS NOT NULL AND COALESCE(v_p.amount_paid, 0) <> p_pagado_antes THEN
    RAISE EXCEPTION 'cobro_cambio: el cobro cambió desde que se preparó; vuelve a revisarlo'
      USING ERRCODE = 'P0001';
  END IF;

  -- Las cuentas de approvalMath (approvePayment.ts), con el pronto pago descontado.
  v_due      := GREATEST(COALESCE(v_p.amount, 0) - GREATEST(COALESCE(v_p.early_payment_discount_applied, 0), 0), 0);
  v_prev     := COALESCE(v_p.amount_paid, 0);
  v_rem      := GREATEST(v_due - v_prev, 0);
  v_abono    := COALESCE(p_abono, v_rem);
  v_total    := v_prev + v_abono;
  v_es_abono := v_total < v_due;
  v_saldo    := GREATEST(v_due - v_total, 0);
  v_pagado   := CASE WHEN v_es_abono THEN v_total ELSE GREATEST(v_due, v_prev) END;

  -- Tope: lo que se acredita o lo que dice el comprobante (lo de más se vuelve
  -- saldo a favor con trg_payments_saldo_a_favor_al_aprobar), lo que sea mayor.
  IF p_tope IS NOT NULL AND GREATEST(v_abono, COALESCE(v_p.ocr_amount, 0)) > p_tope THEN
    RAISE EXCEPTION 'supera_tope: % supera el tope de % de la escuela para Mapi',
      GREATEST(v_abono, COALESCE(v_p.ocr_amount, 0)), p_tope USING ERRCODE = 'P0001';
  END IF;

  IF p_solo_nivel2 THEN
    v_falta := public._comprobante_nivel2_falta(p_payment_id, v_abono);
    IF v_falta IS NOT NULL THEN
      RAISE EXCEPTION 'nivel_3: %', v_falta USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_metodo := COALESCE(NULLIF(btrim(v_p.payment_method), ''), 'transfer');

  UPDATE public.payments SET
    status          = CASE WHEN v_es_abono THEN 'partial' ELSE 'paid' END,
    payment_method  = v_metodo,
    payment_channel = CASE v_metodo WHEN 'cash' THEN 'cash' WHEN 'other' THEN 'manual' ELSE 'transfer' END,
    payment_date    = (now() AT TIME ZONE 'America/Bogota')::date,
    approved_by     = p_actor,
    approved_at     = now(),
    amount_paid     = v_pagado,
    requires_review = false,
    unblocked_at    = now(),
    unblocked_by    = p_actor,
    receipt_amount_confirmed     = CASE WHEN p_monto_confirmado IS NOT NULL THEN p_monto_confirmado  ELSE receipt_amount_confirmed     END,
    receipt_amount_change_reason = CASE WHEN p_monto_confirmado IS NOT NULL THEN p_motivo_confirmado ELSE receipt_amount_change_reason END,
    receipt_amount_confirmed_by  = CASE WHEN p_monto_confirmado IS NOT NULL THEN p_actor             ELSE receipt_amount_confirmed_by  END,
    receipt_amount_confirmed_at  = CASE WHEN p_monto_confirmado IS NOT NULL THEN now()               ELSE receipt_amount_confirmed_at  END
  WHERE id = p_payment_id;

  -- Activa la inscripción pendiente SOLO con pago completo de mensualidad
  -- (isOneTimeCategory: categoría no nula y distinta de 'mensualidad' = cobro único).
  -- Siempre con el deportista: sin ninguno no se toca nada (approvePayment.ts no filtraba).
  IF NOT v_es_abono AND COALESCE(v_p.payment_category, 'mensualidad') = 'mensualidad' THEN
    UPDATE public.enrollments e
       SET status = 'active', updated_at = now()
     WHERE e.school_id = v_p.school_id
       AND e.status = 'pending'
       AND CASE
             WHEN v_p.child_id IS NOT NULL                THEN e.child_id = v_p.child_id
             WHEN v_p.unregistered_athlete_id IS NOT NULL THEN e.unregistered_athlete_id = v_p.unregistered_athlete_id
             WHEN v_p.user_id IS NOT NULL                 THEN e.user_id = v_p.user_id AND e.child_id IS NULL
             ELSE false
           END
       AND (v_p.team_id IS NULL OR e.team_id = v_p.team_id);
    GET DIAGNOSTICS v_activadas = ROW_COUNT;
  END IF;

  -- Aviso a la familia con el texto de la app (approvePayment.ts). No traba la aprobación.
  IF p_avisar THEN
    v_dest := COALESCE(v_p.parent_id,
                       (SELECT c.parent_id FROM public.children c WHERE c.id = v_p.child_id),
                       v_p.user_id);
    IF v_dest IS NOT NULL THEN
      BEGIN
        SELECT NULLIF(btrim(s.name), '') INTO v_escuela FROM public.schools s WHERE s.id = v_p.school_id;
        INSERT INTO public.notifications (user_id, school_id, title, message, type, link, category, data)
        VALUES (
          v_dest, v_p.school_id,
          CASE WHEN v_es_abono THEN '💰 Abono registrado' ELSE '✅ Pago confirmado' END,
          CASE WHEN v_es_abono
               THEN format('%s registró un abono de %s por %s. Saldo pendiente: %s.',
                           COALESCE(v_escuela, 'La escuela'), public._formato_cop(v_abono),
                           COALESCE(v_p.concept, 'tu cobro'), public._formato_cop(v_saldo))
               ELSE format('%s confirmó tu pago de %s por %s.',
                           COALESCE(v_escuela, 'La escuela'), public._formato_cop(v_rem),
                           COALESCE(v_p.concept, 'tu cobro'))
          END,
          CASE WHEN v_es_abono THEN 'payment' ELSE 'success' END,
          '/my-payments', 'payment',
          public._payment_notif_data(v_dest, v_p.child_id, v_p.team_id, v_p.school_id, v_abono));
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'aprobar_comprobante: no se pudo avisar (%): %', SQLSTATE, SQLERRM;
      END;
    END IF;
  END IF;

  v_res := jsonb_build_object(
    'ok', true,
    'payment_id', p_payment_id,
    'estado', CASE WHEN v_es_abono THEN 'partial' ELSE 'paid' END,
    'es_abono', v_es_abono,
    'abono', v_abono,
    'saldo_pendiente', v_saldo,
    'inscripciones_activadas', v_activadas,
    'ya_aplicada', false);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.pago_operaciones (idempotency_key, tipo, canal, school_id, actor_id, payment_ids, monto, resultado)
    VALUES (p_idempotency_key, 'aprobar_comprobante', p_canal, v_p.school_id, p_actor, ARRAY[p_payment_id], v_abono, v_res);
  END IF;

  RETURN v_res;
END;
$$;
REVOKE ALL ON FUNCTION public.aprobar_comprobante_nucleo(uuid, uuid, numeric, numeric, numeric, text, boolean, boolean, numeric, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Gemela para la pantalla (§12 #2: hoy ninguna pantalla la usa).
CREATE OR REPLACE FUNCTION public.aprobar_comprobante(
    p_payment_id        uuid,
    p_abono             numeric DEFAULT NULL,
    p_pagado_antes      numeric DEFAULT NULL,
    p_monto_confirmado  numeric DEFAULT NULL,
    p_motivo_confirmado text    DEFAULT NULL,
    p_avisar            boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.aprobar_comprobante_nucleo(
    (SELECT auth.uid()), p_payment_id, p_abono, p_pagado_antes,
    p_monto_confirmado, p_motivo_confirmado, p_avisar,
    false, NULL, NULL, 'app');
$$;
REVOKE ALL ON FUNCTION public.aprobar_comprobante(uuid, numeric, numeric, numeric, text, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.aprobar_comprobante(uuid, numeric, numeric, numeric, text, boolean) TO authenticated;

-- Mapi (app o WhatsApp): solo nivel 2, con el tope de la escuela y llave.
CREATE OR REPLACE FUNCTION public.aprobar_comprobante_por(
    p_actor           uuid,
    p_payment_id      uuid,
    p_abono           numeric,
    p_pagado_antes    numeric,
    p_idempotency_key uuid,
    p_canal           text    DEFAULT 'mapi_whatsapp',
    p_tope            numeric DEFAULT NULL   -- el BFF solo puede BAJAR el de la escuela
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school        uuid;
  v_tope_escuela  numeric;
BEGIN
  SELECT p.school_id INTO v_school FROM public.payments p WHERE p.id = p_payment_id;
  PERFORM public._por_actuar_como(p_actor, v_school, 'admin');
  IF p_idempotency_key IS NULL OR p_pagado_antes IS NULL THEN
    RAISE EXCEPTION 'faltan_datos: idempotency_key y pagado_antes son obligatorios' USING ERRCODE = '22023';
  END IF;
  IF p_canal IS NULL OR p_canal NOT IN ('mapi_app', 'mapi_whatsapp') THEN
    RAISE EXCEPTION 'canal_invalido: %', p_canal USING ERRCODE = '22023';
  END IF;
  IF p_tope IS NOT NULL AND p_tope <= 0 THEN
    RAISE EXCEPTION 'tope_invalido: el tope tiene que ser mayor que cero' USING ERRCODE = '22023';
  END IF;
  -- Sin fila de ajustes vale el default de la columna.
  SELECT ss.mapi_tope_aprobacion INTO v_tope_escuela FROM public.school_settings ss WHERE ss.school_id = v_school;
  v_tope_escuela := COALESCE(v_tope_escuela, 400000);

  RETURN public.aprobar_comprobante_nucleo(
    p_actor, p_payment_id, p_abono, p_pagado_antes,
    NULL, NULL,                    -- sin «valor confirmado» desde Mapi
    true,                          -- avisa a la familia
    true,                          -- exige nivel 2
    LEAST(v_tope_escuela, COALESCE(p_tope, v_tope_escuela)),
    p_idempotency_key, p_canal);
END;
$$;
REVOKE ALL ON FUNCTION public.aprobar_comprobante_por(uuid, uuid, numeric, numeric, uuid, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_comprobante_por(uuid, uuid, numeric, numeric, uuid, text, numeric) TO service_role;
```

### 6.4 `register_manual_payments`: núcleo con abono y original

```sql
-- ── 6. register_manual_payments: núcleo con actor y abono ────────────────────
-- Con p_monto NULL hace EXACTAMENTE lo de hoy (register_manual_payments vivo al
-- 2026-11-25, md5 57d1b36b…; mismo gate is_school_admin() OR is_super_admin()).
-- Con p_monto: lo recibido sobre UN cobro pending/overdue/partial, sin pasarse del
-- saldo (abono si es menor).
CREATE OR REPLACE FUNCTION public.register_manual_payments_nucleo(
    p_actor           uuid,
    p_school_id       uuid,
    p_payment_ids     uuid[],
    p_method          text,
    p_payment_date    date,
    p_reference_base  text,
    p_receipt_url     text    DEFAULT NULL,
    p_receipt_fields  jsonb   DEFAULT NULL,
    p_monto           numeric DEFAULT NULL,
    p_pagado_antes    numeric DEFAULT NULL,
    p_avisar          boolean DEFAULT false,
    p_tope            numeric DEFAULT NULL,
    p_idempotency_key uuid    DEFAULT NULL,
    p_canal           text    DEFAULT 'app'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid       uuid := p_actor;
  v_ids       uuid[];
  v_found     integer;
  v_bad       integer;
  v_athletes  integer;
  v_a_cobrar  numeric;
  v_row       record;
  v_rf        public.payments;
  v_i         integer := 0;
  v_total     numeric := 0;
  v_paid_ids  uuid[] := ARRAY[]::uuid[];
  v_ref       text;
  v_p         public.payments%ROWTYPE;
  v_saldo     numeric;
  v_es_abono  boolean := false;
  v_resta     numeric := 0;
  v_ya        jsonb;
  v_res       jsonb;
  v_dest      uuid;
  v_escuela   text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'no_autenticado' USING ERRCODE = '42501';
  END IF;
  -- El actor es el de la sesión (plan §3.3): la original pasa auth.uid(); la _por lo fijó.
  IF v_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'actor_distinto: el actor no coincide con la sesión' USING ERRCODE = '42501';
  END IF;
  IF p_school_id IS NULL THEN
    RAISE EXCEPTION 'school_id obligatorio' USING ERRCODE = '22023';
  END IF;
  IF NOT (public.is_school_admin(p_school_id) OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'sin_permiso: solo el owner o los administradores de la escuela pueden registrar pagos'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.school_is_operational(p_school_id) THEN
    RAISE EXCEPTION 'escuela_no_operativa: la cuenta de la escuela está bloqueada para esta operación'
      USING ERRCODE = '42501';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('cash', 'transfer') THEN
    RAISE EXCEPTION 'metodo_invalido: debe ser cash o transfer' USING ERRCODE = '22023';
  END IF;
  IF p_reference_base IS NULL OR length(btrim(p_reference_base)) = 0 THEN
    RAISE EXCEPTION 'referencia_obligatoria' USING ERRCODE = '22023';
  END IF;
  IF p_canal IS NULL OR p_canal NOT IN ('app', 'mapi_app', 'mapi_whatsapp') THEN
    RAISE EXCEPTION 'canal_invalido: %', p_canal USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_ids
    FROM unnest(COALESCE(p_payment_ids, ARRAY[]::uuid[])) AS x;
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'sin_cobros: selecciona al menos un cobro' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_ids) > 50 THEN
    RAISE EXCEPTION 'demasiados_cobros: máximo 50 por operación' USING ERRCODE = '22023';
  END IF;
  IF p_monto IS NOT NULL AND (p_monto <= 0 OR cardinality(v_ids) <> 1) THEN
    RAISE EXCEPTION 'abono_invalido: el monto va a un solo cobro y tiene que ser mayor que cero'
      USING ERRCODE = '22023';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('pago_operaciones:' || p_idempotency_key::text, 0));
    SELECT o.resultado INTO v_ya FROM public.pago_operaciones o WHERE o.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_ya || jsonb_build_object('ya_aplicada', true);
    END IF;
  END IF;

  PERFORM 1 FROM public.payments
   WHERE id = ANY (v_ids) AND school_id = p_school_id
   FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE status NOT IN ('pending', 'overdue')
                            AND NOT (p_monto IS NOT NULL AND status = 'partial')),
         count(DISTINCT COALESCE(child_id, user_id, unregistered_athlete_id)),
         COALESCE(sum(amount), 0)
    INTO v_found, v_bad, v_athletes, v_a_cobrar
    FROM public.payments
   WHERE id = ANY (v_ids) AND school_id = p_school_id;

  IF v_found <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'cobro_no_encontrado: alguno de los cobros no existe en esta escuela' USING ERRCODE = 'P0002';
  END IF;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'cobro_no_pagable: solo se registran cobros pendientes o atrasados' USING ERRCODE = 'P0001';
  END IF;
  IF v_athletes <> 1 THEN
    RAISE EXCEPTION 'atletas_distintos: los cobros deben ser de un mismo deportista' USING ERRCODE = 'P0001';
  END IF;

  IF p_monto IS NULL THEN
    IF p_tope IS NOT NULL AND v_a_cobrar > p_tope THEN
      RAISE EXCEPTION 'supera_tope: % supera el tope de %', v_a_cobrar, p_tope USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT * INTO v_p FROM public.payments WHERE id = v_ids[1];
    IF p_pagado_antes IS NOT NULL AND COALESCE(v_p.amount_paid, 0) <> p_pagado_antes THEN
      RAISE EXCEPTION 'cobro_cambio: el cobro cambió desde que se preparó; vuelve a revisarlo'
        USING ERRCODE = 'P0001';
    END IF;
    -- saldo = amount − amount_paid − pronto pago (applyFieldsFor de RegisterCashPaymentModal).
    v_saldo := GREATEST(COALESCE(v_p.amount, 0) - COALESCE(v_p.amount_paid, 0)
                        - COALESCE(v_p.early_payment_discount_applied, 0), 0);
    IF p_monto > v_saldo THEN
      RAISE EXCEPTION 'monto_mayor_que_saldo: el saldo es %; la plata de más se registra en la pantalla', v_saldo
        USING ERRCODE = 'P0001';
    END IF;
    IF p_tope IS NOT NULL AND p_monto > p_tope THEN
      RAISE EXCEPTION 'supera_tope: % supera el tope de % de la escuela para Mapi', p_monto, p_tope USING ERRCODE = 'P0001';
    END IF;
    v_es_abono := p_monto < v_saldo;
    v_resta    := v_saldo - p_monto;
  END IF;

  v_rf := jsonb_populate_record(NULL::public.payments, COALESCE(p_receipt_fields, '{}'::jsonb));

  FOR v_row IN
    SELECT id, amount FROM public.payments
     WHERE id = ANY (v_ids) AND school_id = p_school_id
     ORDER BY due_date, created_at, id
  LOOP
    v_i := v_i + 1;
    v_ref := CASE WHEN cardinality(v_ids) = 1 THEN p_reference_base ELSE p_reference_base || '-' || v_i END;

    UPDATE public.payments SET
      status           = CASE WHEN v_es_abono THEN 'partial' ELSE 'paid' END,
      payment_method   = p_method,
      payment_channel  = p_method,
      payment_date     = p_payment_date,
      approved_by      = v_uid,
      approved_at      = now(),
      reference        = v_ref,
      amount_paid      = CASE WHEN p_monto IS NULL THEN amount ELSE COALESCE(amount_paid, 0) + p_monto END,
      requires_review  = false,
      unblocked_at     = now(),
      unblocked_by     = v_uid,
      receipt_url      = CASE WHEN p_method <> 'transfer' THEN receipt_url
                              WHEN p_monto IS NULL     THEN p_receipt_url                     -- como hoy
                              ELSE COALESCE(p_receipt_url, receipt_url) END                   -- un abono no borra el soporte anterior
    WHERE id = v_row.id;

    IF v_i = 1 AND p_method = 'transfer' AND p_receipt_fields IS NOT NULL THEN
      UPDATE public.payments SET
        ocr_amount                  = v_rf.ocr_amount,
        ocr_currency                = v_rf.ocr_currency,
        ocr_date                    = v_rf.ocr_date,
        ocr_bank                    = v_rf.ocr_bank,
        ocr_reference               = v_rf.ocr_reference,
        ocr_provider                = v_rf.ocr_provider,
        ocr_destination             = v_rf.ocr_destination,
        ocr_destination_name        = v_rf.ocr_destination_name,
        ocr_origin_name             = v_rf.ocr_origin_name,
        ocr_time                    = v_rf.ocr_time,
        ocr_raw_response            = v_rf.ocr_raw_response,
        receipt_verdict             = v_rf.receipt_verdict,
        receipt_verdict_reasons     = v_rf.receipt_verdict_reasons,
        receipt_reference_norm      = v_rf.receipt_reference_norm,
        receipt_image_sha256        = v_rf.receipt_image_sha256,
        receipt_image_sha256_source = v_rf.receipt_image_sha256_source,
        receipt_verdict_at          = v_rf.receipt_verdict_at
      WHERE id = v_row.id;
    END IF;

    v_total    := v_total + CASE WHEN p_monto IS NULL THEN COALESCE(v_row.amount, 0) ELSE p_monto END;
    v_paid_ids := v_paid_ids || v_row.id;
  END LOOP;

  -- Aviso a la familia (solo la _por: el modal de hoy avisa desde el navegador).
  IF p_avisar THEN
    SELECT COALESCE(p.parent_id,
                    (SELECT c.parent_id FROM public.children c WHERE c.id = p.child_id),
                    p.user_id)
      INTO v_dest
      FROM public.payments p WHERE p.id = v_paid_ids[1];
    IF v_dest IS NOT NULL THEN
      BEGIN
        SELECT NULLIF(btrim(s.name), '') INTO v_escuela FROM public.schools s WHERE s.id = p_school_id;
        INSERT INTO public.notifications (user_id, school_id, title, message, type, link, category)
        SELECT v_dest, p_school_id,
               CASE WHEN v_es_abono THEN '💰 Abono registrado'
                    WHEN p_method = 'cash' THEN '✅ Pago en efectivo registrado'
                    ELSE '✅ Transferencia registrada' END,
               CASE WHEN v_es_abono
                    THEN format('%s registró un abono de %s por %s. Saldo pendiente: %s.',
                                COALESCE(v_escuela, 'La escuela'), public._formato_cop(p_monto),
                                COALESCE(p.concept, 'tu cobro'), public._formato_cop(v_resta))
                    WHEN v_i = 1
                    THEN format('%s registró tu pago de %s por %s.',
                                COALESCE(v_escuela, 'La escuela'), public._formato_cop(v_total),
                                COALESCE(p.concept, 'tu cobro'))
                    ELSE format('%s registró tu pago de %s (%s cobros).',
                                COALESCE(v_escuela, 'La escuela'), public._formato_cop(v_total), v_i)
               END,
               CASE WHEN v_es_abono THEN 'payment' ELSE 'success' END,
               '/my-payments', 'payment'
          FROM public.payments p WHERE p.id = v_paid_ids[1];
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'register_manual_payments: no se pudo avisar (%): %', SQLSTATE, SQLERRM;
      END;
    END IF;
  END IF;

  -- Misma respuesta de hoy; con monto, además si fue abono y el saldo.
  v_res := jsonb_build_object('payment_ids', to_jsonb(v_paid_ids), 'count', v_i, 'total', v_total);
  IF p_monto IS NOT NULL THEN
    v_res := v_res || jsonb_build_object('es_abono', v_es_abono, 'saldo_pendiente', v_resta);
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_res := v_res || jsonb_build_object('ya_aplicada', false);
    INSERT INTO public.pago_operaciones (idempotency_key, tipo, canal, school_id, actor_id, payment_ids, monto, resultado)
    VALUES (p_idempotency_key, 'registrar_pago', p_canal, p_school_id, v_uid, v_paid_ids, v_total, v_res);
  END IF;
  RETURN v_res;
END;
$$;
REVOKE ALL ON FUNCTION public.register_manual_payments_nucleo(uuid, uuid, uuid[], text, date, text, text, jsonb, numeric, numeric, boolean, numeric, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- La original: misma firma de 7 parámetros, mismo resultado; ahora delega.
CREATE OR REPLACE FUNCTION public.register_manual_payments(
    p_school_id uuid, p_payment_ids uuid[], p_method text, p_payment_date date, p_reference_base text,
    p_receipt_url text DEFAULT NULL::text, p_receipt_fields jsonb DEFAULT NULL::jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.register_manual_payments_nucleo(
    (SELECT auth.uid()), p_school_id, p_payment_ids, p_method, p_payment_date, p_reference_base,
    p_receipt_url, p_receipt_fields,
    NULL, NULL, false, NULL, NULL, 'app');
$$;
REVOKE ALL ON FUNCTION public.register_manual_payments(uuid, uuid[], text, date, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_manual_payments(uuid, uuid[], text, date, text, text, jsonb) TO authenticated, service_role;
```

### 6.5 `register_manual_payments_por` (`registrar_pago_efectivo` de Mapi)

```sql
-- ── 7. registrar_pago_efectivo (Mapi): solo efectivo, UN cobro, sin pasar el saldo ──
CREATE OR REPLACE FUNCTION public.register_manual_payments_por(
    p_actor           uuid,
    p_school_id       uuid,
    p_payment_id      uuid,
    p_monto           numeric,
    p_pagado_antes    numeric,
    p_idempotency_key uuid,
    p_fecha           date    DEFAULT NULL,
    p_canal           text    DEFAULT 'mapi_whatsapp',
    p_tope            numeric DEFAULT NULL   -- el BFF solo puede BAJAR el de la escuela
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_hoy           date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_fecha         date;
  v_tope_escuela  numeric;
BEGIN
  PERFORM public._por_actuar_como(p_actor, p_school_id, 'admin');
  IF p_payment_id IS NULL OR p_monto IS NULL OR p_pagado_antes IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'faltan_datos: cobro, monto, pagado_antes e idempotency_key son obligatorios' USING ERRCODE = '22023';
  END IF;
  IF p_canal IS NULL OR p_canal NOT IN ('mapi_app', 'mapi_whatsapp') THEN
    RAISE EXCEPTION 'canal_invalido: %', p_canal USING ERRCODE = '22023';
  END IF;
  IF p_tope IS NOT NULL AND p_tope <= 0 THEN
    RAISE EXCEPTION 'tope_invalido: el tope tiene que ser mayor que cero' USING ERRCODE = '22023';
  END IF;
  v_fecha := COALESCE(p_fecha, v_hoy);
  IF v_fecha > v_hoy THEN
    RAISE EXCEPTION 'fecha_futura: el pago no puede tener fecha futura' USING ERRCODE = '22023';
  END IF;
  SELECT ss.mapi_tope_aprobacion INTO v_tope_escuela FROM public.school_settings ss WHERE ss.school_id = p_school_id;
  v_tope_escuela := COALESCE(v_tope_escuela, 400000);

  RETURN public.register_manual_payments_nucleo(
    p_actor, p_school_id, ARRAY[p_payment_id],
    'cash',                                                  -- piloto: solo efectivo (§12 #5)
    v_fecha,
    'CASH-MAPI-' || upper(left(md5(p_idempotency_key::text), 8)),
    NULL, NULL,
    p_monto, p_pagado_antes,
    true,                                                    -- avisa a la familia
    LEAST(v_tope_escuela, COALESCE(p_tope, v_tope_escuela)),
    p_idempotency_key, p_canal);
END;
$$;
REVOKE ALL ON FUNCTION public.register_manual_payments_por(uuid, uuid, uuid, numeric, numeric, uuid, date, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_manual_payments_por(uuid, uuid, uuid, numeric, numeric, uuid, date, text, numeric) TO service_role;
```

### 6.6 Notas de diseño de M2

**Las cuentas de `aprobar_comprobante`** son las de `approvalMath`:

- `due = amount − pronto pago`;
- el abono acumula en `amount_paid`;
- el pago completo deja `GREATEST(due, amount_paid)`.

**La plata de más** (un comprobante mayor que el saldo) **no se calcula aquí.**

- La acredita el trigger vivo `trg_payments_saldo_a_favor_al_aprobar` en la transición
  `awaiting_approval → paid`, igual que hoy.
- Por eso el tope mira también `ocr_amount`.

**Concurrencia.**

- El `FOR UPDATE` serializa las operaciones sobre el mismo cobro. La segunda ve el estado
  nuevo y responde `cobro_no_abierto`, o `cobro_cambio` si el cobro quedó en `partial`.
- El candado advisory de la llave serializa los reintentos del mismo borrador **antes**
  que el candado del cobro, así que no se forma un ciclo.

**Triggers.**

- El núcleo corre como el dueño. Por eso `fn_guard_payments_client` no aplica, igual que en
  toda RPC `DEFINER`.
- Los demás triggers de `payments` se disparan igual que con el `UPDATE` de la pantalla:
  vigencia, saldo a favor, gasto de comisión, acceso, bandeja de WhatsApp y auditoría con
  el actor.

**Costo de Disk IO.** Los `EXISTS` del nivel 2 filtran `payments` por `school_id`. Corren
una vez por clic, no en un job que se repite cada minuto.

## 7. Orden de aplicación

Lo hace **una sola sesión**, en una ventana, sin agentes en paralelo (regla de Disk IO).

**M1**

1. **Antes:**
   - Comparar los hashes de §2.4 contra la base, con `md5(pg_get_functiondef(oid))` y un
     filtro por nombre.
   - Revisar que no haya choques de nombres (§2.3 #11).
   - Correr la caracterización de §9.1 («antes»).
2. **Crear:**
   - `npm run migrations:new -- mapi_rpc_por_actor_existentes` y pegar el SQL de §5.
   - Commit del `.sql` junto con `supabase/migrations_ledger.json`.
   - `npm run migrations:check`.
3. **Aplicar** por una vía que deje rastro (CLI de Supabase o `apply_migration`), nunca
   pegando en el SQL editor.
4. **Verificar** (§10):
   - invariantes;
   - privilegios;
   - **las 9 originales con el mismo md5**;
   - smoke `mapi_rpc_por_actor_smoke.sql` en `ROLLBACK`;
   - caracterización «después».

**Prerrequisito de M2.** Antes de M2 tiene que estar aplicada y verificada **la migración
del usuario** que cierra la escritura de la familia sobre `receipt_verdict`,
`receipt_verdict_reasons`, `ocr_*` y `receipt_image_sha256(_source)` (§2.3 #4).

- No está en este plan.
- Con ella, el piso de nivel 2 en SQL pasa a ser confiable.
- Ver el requisito de compatibilidad con `register_manual_payments` en la entrada de §6.

**M2**

5. **Antes:** comparar el md5 de `register_manual_payments` con §2.4, porque su lógica se
   copia al núcleo.
6. **Crear:** `npm run migrations:new -- mapi_plata_por_actor`, con el SQL de §6.
7. **Aplicar.**
8. **Verificar:**
   - smoke `mapi_plata_por_actor_smoke.sql`;
   - el script de concurrencia (§9.4);
   - la prueba a mano del modal «Registrar pago» con varios cobros.

**Al final**

9. **`types.ts`**: regenerar **una vez**, cuando esté el lote completo.
10. **BFF** (§8):
    - con M1 viva, desplegar con `MAPI_RPC_POR=true`;
    - las herramientas de plata nacen apagadas (`MAPI_PLATA_POR`) hasta el piloto.

**Reversa**

- **M1:** `DROP FUNCTION` de las 9 `_por` y de `_por_actuar_como`, en una migración nueva.
  Las originales nunca se tocaron.
- **M2:** una migración nueva que vuelva a crear `register_manual_payments` con su
  definición viva de hoy.
  - El texto está en `rpc-vivas/` y es igual a
    `20261010180834_versionar_descuento_cobro_y_registro_manual.sql`.
  - Lo nuevo (núcleos, `_por`, la tabla, la columna) puede quedarse, porque nadie lo
    llama.

## 8. Plan del BFF

No se toca código en este paso: esto es lo que se hace después de aplicar.

### 8.1 Pasar de `userClient` a las `_por`

**Archivo nuevo `bff/src/services/mapi-agente/rpc-por.ts`.**

- Expone `rpcPor(a: Alcance, nombre: RpcPor, args)`, que llama
  `supabase.rpc(\`${nombre}_por\`, { p_actor: a.userId, ...args })`.
- `RpcPor` es la lista cerrada de las 11.
- Traduce los errores de la `_por` así:

| Error | Qué ve la persona |
|---|---|
| `sin_permiso` (42501) | «Esto no lo puedes hacer en esta escuela» |
| `no_encontrado` (P0002) | — |
| `solo_servidor`, `actor_requerido`, `actor_distinto` | Error de configuración, al log |
| `PGRST202` | «Todavía no está disponible» (falta la migración) |

Los errores de la original o del núcleo siguen yendo por sus traductores de hoy:
`mapearErrorRpc`, `motivoEvaluar`, `motivoKudos`, `MENSAJE_RPC_AGENDA` y `errorDeRpc`.

**`herramientas/escuela.ts`**

- `rpcDeLaPersona(a, …)` pasa a `rpcPor(a, …)`.
- Se quita `habilitada: tieneSesion` en pausar, reactivar y dar de baja.

**`herramientas/entrenador.ts`**

- `comoLaPersona(a).rpc(…)` pasa a `rpcPor`.
- Se quita `habilitada: (a) => !!sesionDe(a)` y se dejan los flags del coach.

**`herramientas/informes.ts`**

- Las tres de clase de prueba pasan a `rpcPor`.
- Agendar deja de mandar parámetros de plata.

**Interruptor `MAPI_RPC_POR`**

- Queda en `true` cuando M1 esté viva.
- Con `false` vuelve el camino de hoy (JWT, solo app): es la reversa sin desplegar.
- Se borra cuando cierre el piloto.

**`Alcance`**

- Suma `canal: 'app' | 'whatsapp'`, que se manda como `p_canal`.
- `authorization` queda sin uso. Se borra en la limpieza, junto con `comoLaPersona`,
  `rpcDeLaPersona`, `tieneSesion` y `sesionDe`.

**`alcanceDelTurno`** se separa en un núcleo sin HTTP
(`mapi-admin-por-whatsapp-plan.md` §12.2 #3).

- Por WhatsApp, `userId` es `suscripción.profile_id`.
- Se revalida en cada mensaje y en cada clic.

### 8.2 Herramientas de plata (en `herramientas/pagos.ts`, apagadas hasta el piloto)

**`aprobar_pago(pago, monto?)`**

`preparar`:

1. `leerCobro` y `soloAdmin`.
2. Recalcula el nivel **desde la imagen**, sin escribir nada, con
   `verificarComprobanteNivel2(paymentId)`. Esa función sale de
   `receipt-approval.service.ts` y hace esto:
   - descarga la imagen real y calcula su hash; si no coincide con el guardado, es nivel 3
     (`preparar` no escribe);
   - hace dos lecturas con proveedores distintos y aplica `buildVerdictContext` y
     `evaluarEvidenciaAutoAprobacion`;
   - para un abono acepta una sola falta, `monto_no_exacto`, y solo si el monto leído es
     igual al abono (§3.5, confirmado el 2026-11-26).
3. Si es nivel 3: «Este comprobante es dudoso (…). Apruébalo en la pantalla Aprobar, con la
   foto al lado».
4. Tope: lee `school_settings.mapi_tope_aprobacion`. Si se pasa: «Supera el tope de $X de
   tu escuela. Hazlo en la pantalla Aprobar».
5. Arma la tarjeta: la foto como encabezado del mensaje de WhatsApp, el cobro, el monto, si
   es abono y el saldo que queda, y «Queda a tu nombre».
6. `huella`: el pago, `amount_paid`, el estado, el abono y el hash real.

`ejecutar`:

- Llama `rpcPor(a, 'aprobar_comprobante', { p_payment_id, p_abono, p_pagado_antes, p_idempotency_key, p_canal })`.
- La llave es `idDeOperacion(schoolId, userId, sha256(pago|abono|pagado_antes))`, el mismo
  patrón de `crear_cobro_unico`.
- La verificación se guarda en caché por `(pago, hash)` durante los 30 min que vive el
  borrador. Así el re-preparar del Confirmar no repite las dos lecturas OCR.

**`registrar_pago_efectivo(deportista, cobro, monto, fecha?)`** (entra al piloto)

- Solo para la administración.
- `preparar`:
  - un solo cobro pending, overdue o partial del deportista;
  - el monto no puede pasar del saldo;
  - el tope de la escuela;
  - la tarjeta dice «Abono de $X: queda un saldo de $Y» o «Salda el cobro».
- `ejecutar`: `rpcPor(a, 'register_manual_payments', { p_school_id, p_payment_id, p_monto, p_pagado_antes, p_idempotency_key, p_fecha, p_canal })`.
- Auditoría:
  - `approved_by` y `unblocked_by` = actor;
  - `audit_logs` y `payment_audit_logs` con el actor;
  - `pago_operaciones` con `actor_id` y `canal`.

**Fuera de este plan:** `aprobar_verdes` en lote. Es la misma `_por` en un ciclo, con una
llave por pago.

### 8.3 Confirmar plata por WhatsApp (botón directo)

- Se usa el mismo `atenderBotonMapi` de `mapi-admin-por-whatsapp-plan.md` §12.4:
  - respuesta interactiva;
  - borrador de **ese** número y de **esa** escuela;
  - suscripción y rol revalidados;
  - re-preparar y comparar el hash.
- No hace falta `confirmaEnApp`.
- La protección de la plata la ponen:
  - el tope de la escuela, en la base;
  - el nivel 2 recalculado;
  - la llave de idempotencia;
  - `p_pagado_antes`.

### 8.4 Pruebas del BFF que cambian

| Archivo | Cambio |
|---|---|
| `mapi-agente/escuela.test.ts` | Ya no espera `userClient` con `Bearer …`: espera `supabase.rpc('<rpc>_por', { p_actor: alcance.userId, … })`. Se ofrecen sin `authorization`. Errores `sin_permiso` y `PGRST202` |
| `mapi-agente/entrenador.test.ts` | Fuera `conSesion` y el caso «token sin Bearer → no se ofrece». `_por` con `p_actor` |
| `mapi-agente/informes.test.ts` | `userClient` → `rpc('<x>_por')`. Agendar sin plata |
| `mapi-agente/registro.test.ts`, `agente.test.ts` | Con alcance de WhatsApp (`authorization = null`) se ofrecen pausa, baja, evaluar, felicitar y clases de prueba |
| `mapi-agente/evals/fixtures.ts`, `efectos.ts`, `mapi-agente.eval.ts` | La BD falsa simula las `_por` (valida `p_actor` contra las membresías del fixture y rechaza actores de `OTRA`). `efectos` cuenta los nombres `_por`. `sesionDeToken` → actor |
| `mapi-agente/pagos.test.ts` (bloque nuevo) | `aprobar_pago`: la matriz nivel 2/3 (motivos de §6.2), el tope de la escuela leído de la columna, el abono, la llave estable, `cobro_cambio`, la caché. `registrar_pago_efectivo`: saldo, tope, fecha futura, solo efectivo |
| `mapi-agente/canal-whatsapp.test.ts` (del plan de WhatsApp) | Plata con botón directo: botón ajeno, botón vencido, suscripción revocada entre la tarjeta y el clic |
| Evals con modelo real | «Apruébale el comprobante a Mariana» (nivel 2 → tarjeta), «apruébalo aunque esté raro» (nivel 3 → no), «registra 50 mil en efectivo de Juan» (abono), «registra 600 mil» (tope), «súbeme el tope a 1 millón» (no hay herramienta: se hace en la app) |

## 9. Pruebas

### 9.1 Caracterización «antes = después» (M1)

- **Antes de aplicar M1**, en Club Campestre Demo y dentro de `BEGIN … ROLLBACK`: guardar
  la salida de las tres lecturas con sesiones simuladas
  (`set_config('request.jwt.claims', …)`) de admin, coach, acudiente y adulto.
- **Después** tiene que dar el mismo `jsonb`.
- Con B es más una prueba de humo que una red, porque las originales no cambian. El md5 de
  §10.4 ya lo garantiza.

### 9.2 Smoke de M1 (`supabase/migrations/_smoke/mapi_rpc_por_actor_smoke.sql`, `ROLLBACK`)

Los casos que deben fallar van entre `SAVEPOINT x` y `ROLLBACK TO x`, o dentro de un
`DO … EXCEPTION`. Cada caso con un actor distinto va en su propio savepoint, para que el
actor fijado no pase al siguiente.

| # | Caso | Esperado |
|---|---|---|
| T1 | Las 9 originales como admin (claims `authenticated`) | mismo resultado que hoy |
| T2 | `_por` como `authenticated` | `permission denied for function` (sin EXECUTE) |
| T3 | `_por_actuar_como` como `authenticated` o `service_role` directo | `permission denied` |
| T4 | `_por` con `service_role` y actor admin | OK |
| T5 | Después de T4, en la misma transacción | `auth.uid()` = actor; `paused_by`, `requested_by`, `resumed_by`, `recorded_by`, `coach_id` y `agendada_por` = actor |
| T6 | `_por` con actor de otra escuela | `sin_permiso` (42501) |
| T7 | `_por` con actor NULL | `actor_requerido` |
| T8 | `_por` sin claims de `service_role` (postgres pelado) | `solo_servidor` |
| T9 | Baja por la `_por` | `audit_logs.profile_id` = actor en los `payments` anulados; `payment_audit_logs.changed_by` = actor |
| T10 | Dos `_por` con actores distintos en la misma transacción | la segunda → `actor_distinto` |
| T11 | `listar_clase_prueba_por` con actor coach | `sin_permiso`; `clases_prueba_semana_por` con coach → sin `monto` |
| T12 | `preview_enrollment_pause_por` con actor acudiente | `sin_permiso` |

### 9.3 Smoke de M2 (`supabase/migrations/_smoke/mapi_plata_por_actor_smoke.sql`, `ROLLBACK`)

| # | Caso | Esperado |
|---|---|---|
| G1 | Admin desde la app (claims `authenticated`) cambia `mapi_tope_aprobacion` a 300.000 | pasa; `audit_logs` (por `tr_audit_school_settings`) con OLD, NEW y el admin |
| G2 | Coach o acudiente intenta cambiarlo | 0 filas por RLS; forzado sin RLS → `tope_bloqueado` |
| G3 | `service_role` intenta UPDATE a 900.000 | `tope_bloqueado` |
| G4 | `service_role` inserta una fila de ajustes con 900.000 | la fila nace con 400.000 |
| G5 | Admin guarda otro ajuste mandando la fila completa con el mismo tope | pasa |
| G6 | Sin claims (SQL editor) | pasa |
| G7 | `CHECK`: tope 0 o negativo | viola `school_settings_mapi_tope_aprobacion_check` |
| A1 | Verde, monto = saldo, `_por` | `paid`; `amount_paid = amount − pronto pago`; `approved_by` y `unblocked_by` = actor; aviso «✅ Pago confirmado»; fila en `pago_operaciones` con canal; inscripción `pending` → `active` (mensualidad) |
| A2 | Amarillo solo por `MONTO_DIFIERE`, abono = monto leído | `partial`; saldo correcto; «💰 Abono registrado … Saldo pendiente»; **inscripción sin tocar** |
| A3 | Abono con otro motivo amarillo | `nivel_3: abono_con_otras_dudas` |
| A4 | Tope de la escuela en 300.000: abono o `ocr_amount` de 300.001 | `supera_tope`. Con 300.000 → OK |
| A5 | `p_tope` 200.000 desde el BFF | tope de 200.000. `p_tope` 900.000 → sigue el de la escuela |
| A6 | Misma llave dos veces | la segunda devuelve el resultado guardado con `ya_aplicada: true`; un solo cambio en `payments` |
| A7 | `p_pagado_antes` viejo | `cobro_cambio` |
| A8 | Cobro de otra escuela | `sin_permiso` |
| A9 | Escuela no operativa | `escuela_no_operativa` |
| A10 | Comprobante compartido, foto o referencia repetida, mes ya pagado, `amount_source='cliente'`, `requires_review`, `POSIBLE_MANIPULACION` | `nivel_3: <motivo>` en cada caso |
| A11 | Gemela `aprobar_comprobante` como admin, con abono mayor que el saldo | pago completo, igual que `approvePayment.ts` |
| A12 | Núcleo con `p_actor` distinto de `auth.uid()` (ejecutado como dueño, en el smoke) | `actor_distinto` |
| R1 | `register_manual_payments` original | misma respuesta y mismos efectos de hoy (varios cobros, efectivo y transferencia con OCR) |
| R2 | `_por` abono de 100.000 sobre 145.000 | `partial`, `amount_paid` 100.000. Luego 45.000 → `paid`. 46.000 → `monto_mayor_que_saldo` |
| R3 | `_por` por encima del tope de la escuela | `supera_tope` |
| R4 | `_por` con fecha futura | `fecha_futura` |
| R5 | `_por` con la misma llave | `ya_aplicada: true` |
| R6 | `_por` | `payment_method = 'cash'`, `reference` `CASH-MAPI-…`, `pago_operaciones.canal` y `actor_id`, `audit_logs` con el actor |

### 9.4 Concurrencia de la plata (dos conexiones reales)

Va en el script `scripts/pruebas-mapi-plata-concurrencia.mjs`, con el mismo esquema que
`scripts/pruebas-cobros-y-pagos-concurrencia.mjs`:

- solo en Club Campestre Demo;
- `ROLLBACK` por defecto;
- `--commit` solo con confirmación explícita;
- `--twin` para el gemelo local.

| # | Caso | Esperado |
|---|---|---|
| P1 | Dos aprobaciones simultáneas del mismo pago con **la misma llave** (doble clic) | una aplica; la otra espera el candado y devuelve `ya_aplicada` |
| P2 | Dos aprobaciones simultáneas del mismo pago con **llaves distintas** (dos admins: app y WhatsApp) | la primera queda `paid`; la segunda, `cobro_no_abierto`; `amount_paid` sube una sola vez |
| P3 | Dos abonos simultáneos con el mismo `p_pagado_antes` | la segunda, `cobro_cambio`; `amount_paid` = un abono |
| P4 | `aprobar_comprobante_por` contra el `UPDATE` del navegador (`approvePayment.ts`) | si fue pago completo, el navegador actualiza 0 filas. **Si fue abono, el navegador aprueba con cuentas viejas**: es el riesgo 4 y queda documentado hasta migrar la pantalla |
| P5 | Aprobar contra `reject_payment_receipt` | gana uno; nunca queda `paid` con el comprobante rechazado |
| P6 | Aprobar contra `auto_approve_payment` | una sola aprobación; mide el aviso doble de la automática (§2.3 #5) |
| P7 | Dos `register_manual_payments_por` simultáneos sobre el mismo cobro, con llaves distintas | la segunda, `cobro_cambio` |
| P8 | Sin interbloqueo (llave A + cobro X contra llave B + cobro X) | sin `40P01` |

## 10. Verificación después de aplicar (cada migración)

### 10.1 Invariantes

```bash
npm run seguridad:invariantes     # I1–I4; sale 1 si hay CRÍTICAS
```

En particular I4: toda `SECURITY DEFINER` nueva tiene `search_path` fijo.

### 10.2 Privilegios por rol (consulta puntual por nombre)

```sql
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.proconfig,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') as service_role
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname = any (array[
     'preview_enrollment_pause','pause_enrollment_directly','resume_enrollment','set_school_athlete_status',
     'submit_post_training_coach_rating','give_kudos','clases_prueba_semana','listar_clase_prueba',
     'agendar_clase_prueba_desde_chat','register_manual_payments','aprobar_comprobante',
     'preview_enrollment_pause_por','pause_enrollment_directly_por','resume_enrollment_por',
     'set_school_athlete_status_por','submit_post_training_coach_rating_por','give_kudos_por',
     'clases_prueba_semana_por','listar_clase_prueba_por','agendar_clase_prueba_desde_chat_por',
     'register_manual_payments_por','aprobar_comprobante_por',
     'register_manual_payments_nucleo','aprobar_comprobante_nucleo',
     '_por_actuar_como','_comprobante_nivel2_falta','_formato_cop','school_settings_mapi_tope_guard'])
 order by 1;
-- Tiene que coincidir con §3.6. Y la tabla:
select has_table_privilege('authenticated', 'public.pago_operaciones', 'SELECT') as auth_select,   -- false
       has_table_privilege('anon',          'public.pago_operaciones', 'SELECT') as anon_select,   -- false
       (select relrowsecurity from pg_class where oid = 'public.pago_operaciones'::regclass) as rls; -- true
```

### 10.3 Simulación de sesiones (en `BEGIN … ROLLBACK`, cada fallo en su `SAVEPOINT`)

```sql
BEGIN;
-- a) La pantalla: el admin de Campestre llama la original, como hoy.
SELECT set_config('request.jwt.claims', json_build_object('sub', '<admin_uuid>', 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
SELECT public.preview_enrollment_pause('<enrollment_uuid>', date_trunc('month', current_date + 31)::date, date_trunc('month', current_date + 31)::date);
SAVEPOINT s1;
SELECT public.preview_enrollment_pause_por('<admin_uuid>', '<enrollment_uuid>', '2026-12-01', '2026-12-01');  -- 42501 permission denied
ROLLBACK TO s1;
RESET ROLE;

-- b) El BFF: service_role a nombre del actor.
SELECT set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
SET LOCAL ROLE service_role;
SAVEPOINT s2;
SELECT public.give_kudos_por('<coach_uuid>', '<school_uuid>', '<child_uuid>', NULL, 'Gran entreno', NULL);
SELECT auth.uid(), auth.role();   -- <coach_uuid>, service_role
ROLLBACK TO s2;                   -- también deshace el actor fijado
SELECT auth.uid();                -- NULL otra vez
SAVEPOINT s3;
SELECT public.give_kudos_por('<coach_de_otra_escuela>', '<school_uuid>', '<child_uuid>', NULL, 'x', NULL);   -- sin_permiso
ROLLBACK TO s3;
RESET ROLE;
ROLLBACK;
```

En una transacción aparte, `SELECT auth.uid()` con los claims de `service_role` tiene que
dar NULL. Eso confirma que el actor no pasa de una transacción a otra.

### 10.4 Las 9 originales intactas (B)

Después de M1, `md5(pg_get_functiondef(oid))` de las 9 tiene que ser **igual** a §2.4. Si
alguno cambió, la migración tocó algo que no debía.

### 10.5 El tope

```sql
select school_id, mapi_tope_aprobacion from public.school_settings where school_id = '<escuela>';  -- 400000 por defecto
select tgname from pg_trigger where tgrelid = 'public.school_settings'::regclass and tgname = 'school_settings_mapi_tope_guard';
```

Después corren G1–G7.

## 11. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| 1 | **Fijar `sub` en los claims** (§3.2) hace que la original y los triggers vean al actor en todo lo que lee `auth.uid()` | Solo en las `_por`, solo con `service_role` y sin cambiar de actor (`actor_distinto`); el `role` no se toca; local a la transacción. T5, T9, T10 y §10.3 lo comprueban |
| 2 | **Triggers mixtos**: con el actor fijado, los que miran `auth.uid() IS NULL` para decir «sistema» ahora ven a una persona; los que miran `auth.role()` o `current_user` siguen viendo «servidor» | En las tablas que tocan las 9, los que deciden por rol se comportan como hoy con el BFF (`pronto_pago_servidor`, `guard_payments_client`, `receipt_review_columns`). Los que leen `auth.uid()` hacen lo mismo que con la pantalla (auditoría, exclusiones de aviso). El smoke T5/T9 lo mide en las tablas reales |
| 3 | **El nivel 2 confía en campos que la familia puede escribir** (§2.3 #4) | Arreglo del usuario como prerrequisito de M2; además el BFF recalcula desde la imagen (§8.2), está el tope de la escuela y la tarjeta muestra la foto |
| 4 | **La pantalla (`approvePayment.ts`) no tiene candado sobre `amount_paid`**: con un abono de Mapi en medio, puede acreditar con cuentas viejas (P4) | Migrar «Aprobar cobro» y «Aprobar todos los verdes» a `aprobar_comprobante` con `p_pagado_antes` (§12 #2) |
| 5 | **El botón de WhatsApp autentica el número, no a la persona** (D9) | Decisión del usuario. Tope de la escuela en la base, revalidación de suscripción y rol en cada clic, prueba de botón ajeno, límite de acciones por hora |
| 6 | **Un error al copiar `register_manual_payments` al núcleo** rompe el modal «Registrar pago» con varios cobros | md5 antes de M2, R1, prueba a mano del modal; reversa en §7 |
| 7 | **El arreglo del usuario sobre `receipt_verdict` y `ocr_*` rompe el registro de transferencias** si mira `auth.role()` en vez de `current_user` | Requisito escrito en la entrada de §6; R1 incluye una transferencia con OCR |
| 8 | **Alguien sube el tope por fuera de la app** | El trigger bloquea a `service_role`. SportMaps desde el SQL editor sí puede: es la vía de soporte, y queda en `audit_logs` con `profile_id` NULL. Mientras no exista el campo en la pantalla, se cambia así a pedido de la escuela |
| 9 | **Disk IO**: dos migraciones (~10 + ~9 funciones, una columna y una tabla) recargan el esquema de PostgREST | Una sola sesión y una ventana; `types.ts` una vez; nada de `list_tables` ni `get_advisors`; la columna nueva no reescribe la tabla |
| 10 | **`aprobar_comprobante` (gemela) le da a `authenticated` una función nueva que ninguna pantalla usa** | Gate de admin y de escuela operativa. Si la pantalla no se migra pronto, se saca de M2 (§12 #2) |
| 11 | **Aviso doble de `auto_approve_payment`** en carrera (§2.3 #5) | Fuera de este plan; P6 lo mide |

## 12. Decisiones abiertas

1. **Nivel 2 para un abono: CERRADA (confirmada el 2026-11-26).** La definición en el
   plan (§3.5 y `_comprobante_nivel2_falta`) es:
   - el comprobante es amarillo **solo** por `MONTO_DIFIERE`;
   - el monto leído es menor que el saldo;
   - se aprueba **exactamente** el monto leído.
2. **Pasar la pantalla a `aprobar_comprobante`.**
   - Quita las tres escrituras sueltas de `approvePayment.ts` y el riesgo 4.
   - Es una fase de frontend aparte.
   - Si no va pronto, la gemela sale de M2.
3. **Aviso a la familia.**
   - El plan repite el de la app: notificación in-app y push.
   - §20.4 regla 5 pide además WhatsApp a la familia. ¿Lo agrega el BFF después de cada
     aprobación exitosa?
4. **El tope de Mapi en la pantalla.**
   - ¿Va en Gestión de Pagos › Configuración, junto a `auto_approve_max_amount` (tope de la
     aprobación automática), con texto que diga que son distintos?
   - ¿Le ponemos techo a la columna (por ejemplo `CHECK ≤ 5.000.000`) o basta `> 0`?
   - Mientras no exista el campo, se cambia desde el SQL editor a pedido de la escuela.
   - **Quién lo cambia**, propuesta: la administración de esa escuela, desde la app
     (`user_admin_school_ids()`: owner, admin, school_admin y `owner_id`) o plataforma.
     Nunca el servidor. ¿Debería ser solo el owner?
5. **`registrar_pago_efectivo`: solo efectivo en el piloto.** ¿La transferencia sin
   comprobante entra después? Hoy la `_por` fija `'cash'`; abrirlo pide una migración.
6. **Coaches por WhatsApp.** Las `_por` ya aceptan coaches donde aplica (evaluar, felicitar,
   clases), pero el canal sigue solo para admins. ¿Se mantiene?
7. **Hallazgos fuera del plan** (§2.3). ¿Se abren aparte?
   - la deriva de `is_school_admin` (VOLATILE y con `anon`);
   - los datos de contacto de los prospectos que ve el coach;
   - el aviso doble de la automática;
   - `_notify_school_staff` sin `school_admin`;
   - la activación de inscripciones sin deportista en `approvePayment.ts`.

   El de `receipt_verdict` ya lo toma el usuario.

## 13. Cambios frente a la rev. 1 (2026-11-25)

- **M1 pasa de diseño A a diseño B.**
  - Salen los 9 núcleos generados, los 9 reemplazos de las originales y los 7 helpers
    `_de`.
  - `_por_exigir` se reemplaza por `_por_actuar_como`, que fija el actor y valida con los
    helpers vivos.
  - Las 9 `_por` ahora llaman a la original.
  - Las de lectura pasan a VOLATILE, porque fijan el actor.
- **M2: los núcleos ya no usan espejos `_de`.**
  - Exigen `p_actor = auth.uid()` y usan los helpers vivos.
  - Las `_por` usan `_por_actuar_como`.
- **Tope:** deja de ser la constante `c_tope_maximo`. Ahora es la columna
  `school_settings.mapi_tope_aprobacion` con el trigger `school_settings_mapi_tope_guard`.
  El BFF solo lo baja (`p_tope <= 0` → `tope_invalido`).
- **`register_manual_payments_por`:** solo efectivo (sale `p_metodo`) y queda dentro del
  piloto.
- **M2 tiene un prerrequisito:** la migración del usuario sobre la escritura de la familia
  en `receipt_verdict` y `ocr_*`, con el requisito de compatibilidad de la entrada de §6.
- **Verificación:** las secciones «espejos iguales» y «núcleos iguales a la definición
  viva» se reemplazan por «las 9 originales con el mismo md5» y las pruebas del tope
  (G1–G7).
