# Auditoría: funciones SECURITY DEFINER ejecutables por `authenticated` (2026-10-28)

**Pregunta:** ¿qué puede hacer con las funciones `SECURITY DEFINER` de `public` alguien con sesión de **otra** escuela (padre, atleta, coach)?

**Universo:** 416 funciones (410 nombres; algunas tienen sobrecargas) en `public` con `prosecdef`, `has_function_privilege('authenticated', …, 'EXECUTE')`, sin `RETURNS trigger` y sin pertenecer a una extensión. 127 de ellas también las puede ejecutar `anon`. El contexto daba 417; la diferencia es una función de extensión o de trigger que quedó fuera por el filtro.

**Fuente:** el catálogo vivo, leído **una vez** (`npx supabase db query --linked`, 1 MB con firma, retorno, volatilidad, `proconfig`, `prosrc` y las policies que nombran a cada función), y analizado en local. Después hubo dos consultas puntuales por nombre para buscar llamadores `SECURITY INVOKER` o vistas y para leer los ACL de las funciones que se revocan. No se llamó ninguna RPC ni se leyeron datos.

Inventario completo, una fila por función: [`auditoria-definer-authenticated-2026-10-28-inventario.csv`](auditoria-definer-authenticated-2026-10-28-inventario.csv).

## Resultado

| Categoría | Cantidad | Qué significa |
|---|---:|---|
| **CRIT** | 5 | Escribe dinero, estado o permisos de otro tenant sin gate |
| **ALTO** | 2 | Devuelve datos personales de otro tenant, o escribe sobre otro usuario con un gate que no está atado al objetivo |
| **MEDIO** | 22 | Oráculo booleano o de ids entre tenants, o un gate flojo dentro del propio tenant |
| **SERVICE** | 2 | Solo la debería llamar el BFF con service_role |
| **OK** | 385 | Tiene gate, solo opera sobre `auth.uid()`, es helper de RLS del propio caller, o es pública por diseño (slug, token o búsqueda) |

**Qué entró a la migración `20261028111725_gates_definer_authenticated`:** 11 `REVOKE` (5 CRIT, 1 ALTO, 3 MEDIO, 2 SERVICE). Ninguna función tiene hoy un llamador con sesión de usuario, ninguna la usa una policy, ninguna la llama una función INVOKER ni una vista. **No hay `CREATE OR REPLACE`**, así que no hay riesgo de pisar la deriva entre repo y base.

**Qué quedó como pregunta:** `notify_user` (ALTO, con 7 llamadores en el frontend), `mark_custom_domain_verified` (además, la llamada del BFF está rota), `save_school_info` / `save_school_branding`, `get_trainer_athlete_ids` y los oráculos de plan.

## Método

1. **Parámetros de tenant.** Se marcaron las funciones que reciben un parámetro `uuid` o `*_id` (317 de 416).
2. **Filtro heurístico por cuerpo.** Para cada función se buscó (a) un helper de alcance (`is_school_admin`, `user_*_school_ids`, `can_*`, `finance_permission`, `is_parent_of_child`, `_store_actor`, `platform_admins`…) **junto con** una salida de rechazo (`42501`, `Forbidden`, `RAISE`/`RETURN` de "no autorizado"), o (b) un ligue del objeto a `auth.uid()`. Quedaron 112 sin las dos cosas. Se sumaron 16 que no tenían ningún camino de rechazo y 83 en las que el parámetro nunca aparecía cerca de un gate.
3. **Lectura a mano** de esas ~130 funciones, más todas las que no reciben ids pero devuelven datos (99).
4. **Llamadores.** Se buscó cada nombre en `frontend/src` (sin `types.ts` ni tests), `bff/src` (y con qué cliente: `supabase` = service_role, o `userClient(req)` = JWT del usuario), `supabase/functions`, `mobile`, en las policies (`pg_policies.qual/with_check`) y en el `prosrc` de las demás funciones. Para las 11 que se revocan también se revisaron las funciones INVOKER, las vistas y las 158 ramas del repo.

**Límite honesto:** las ~285 funciones que pasaron el paso 2 con un gate reconocible se clasificaron OK por la heurística, sin leerlas línea por línea. El patrón de `notify_user` (gate presente pero sin atar al objetivo) se encontró leyendo; puede haber más casos así entre esas 285. Ese tipo de bug hay que buscarlo a mano, la heurística no lo ve.

## CRIT: escribe sobre otro tenant sin gate

| Firma | Por qué | Llamador | Arreglo |
|---|---|---|---|
| `close_cash_session(p_session_id uuid, p_closing_cash numeric, p_notes text) → cash_sessions` | **Cero gate.** Cualquier sesión cierra la caja abierta de cualquier escuela con el efectivo que declare, y así falsea `cash_difference` y `closed_by`. `search_path=public` | Ninguno (ni frontend, ni BFF, ni policies, ni funciones) | **REVOKE** de PUBLIC/anon/authenticated (en la migración) |
| `send_notification(p_title, p_message, p_type, p_link text, p_user_id uuid)` | `p_user_id` libre, sin gate: inserta en `notifications` de **cualquier** usuario con título, texto y **link** arbitrarios. `trg_enqueue_notification_delivery` lo convierte en push/web. Es phishing con la marca de la app | Ninguno (el frontend usa `notify_user`) | **REVOKE** (en la migración) |
| `submit_enrollment(p_school_id uuid, …, p_price numeric, …)` | `p_school_id` libre: crea `enrollments` + `payments` e **inserta a quien llama como `school_members` activo (parent/athlete) de esa escuela**. Con eso entra a `user_school_ids()` de una escuela ajena y hereda toda la lectura por RLS (perfiles de miembros, calendario…). Si `p_team_id` no es de la escuela, toma el precio del cliente (`v_price := p_price`) | Ninguno | **REVOKE** (en la migración) |
| `submit_enrollment_v2(p_school_id uuid, …)` | El mismo auto-alta como miembro activo de cualquier escuela | Ninguno | **REVOKE** (en la migración) |
| `claim_child_for_parent(p_child_id uuid, p_full_name, p_phone text)` (también `anon`) | Con solo el `child_id` de un menor sin acudiente, quien llama se vuelve su `parent_id`, lo inscribe y entra como miembro activo. **No pide documento.** Los `child_id` salen por otras RPC (`find_athletes_by_document` los devolvía por documento) | Hoy ninguno. Solo la usan las ramas viejas `production` (abril) y `demo` (julio) en `JoinTeamPage.tsx`; `develop` y `main` usan `claim_children_by_document` | **REVOKE** (en la migración) |

## ALTO: datos personales de otro tenant, o escritura sobre otro usuario

| Firma | Por qué | Llamador | Arreglo |
|---|---|---|---|
| `find_athletes_by_document(p_doc_number text, p_school_id uuid)` | **SEG-14 quedó a medias.** Se le quitó `anon` y JoinTeamPage dejó de usarla, pero con sesión devuelve **nombre completo, fecha de nacimiento, equipo, sede y escuela** de cualquier menor del país a partir del documento. `p_school_id` solo ordena, no filtra, y no hay límite de intentos (`buscar_menor_por_documento_publico` sí lo tiene). Cualquier cuenta gratis puede recorrer documentos | Ninguno. Solo aparece en un **comentario** de `frontend/src/pages/JoinTeamPage.tsx:26` | **REVOKE** (en la migración) |
| `notify_user(p_user_id uuid, p_title, p_message, p_type, p_link text)` | El gate tiene tres ramas y la primera no mira al objetivo: *«quien llama es owner/admin/school_admin activo de **alguna** escuela»*. Así, el admin de cualquier escuela (incluida una escuela de prueba recién creada) puede mandar notificaciones push con link arbitrario a **cualquier** usuario de la plataforma | **Frontend:** `lib/approvePayment.ts:116` (staff → acudiente o atleta adulto del pago), `components/payment/RegisterCashPaymentModal.tsx:561,841` (staff → acudiente o sí mismo), `pages/ParentCheckoutPage.tsx:576` (acudiente → dueño de la escuela, rama 3), `lib/api/transactions.ts:108` (sí mismo), `lib/api/transactions.ts:144` (atleta → profesional de wellness) | **Pregunta 1.** No entró a la migración |

## MEDIO

| Firma | Por qué | Llamador | Arreglo |
|---|---|---|---|
| `get_trainer_athlete_ids(p_school_id uuid) → SETOF uuid` | Devuelve los `user_id`/`child_id` de todos los inscritos activos de **cualquier** escuela. Solo devuelve ids, pero esos ids alimentan RPC como `claim_child_for_parent` | 17 policies (`athlete_stats_*`, `athlete_goals_*`, `training_logs_*`, `body_metrics_*`, `atp_*`, `academic_progress_trainer_insert`) | No se puede revocar (rompería las policies). **Pregunta 4** |
| `is_school_member(_user_id, _school_id)`, `calendar_team_in_school(p_team, p_school)`, `is_coach_parent_messaging_blocked(p_sender, p_recipient)`, `order_belongs_to_store(p_order_id, p_vendor_profile_id)`, `match_evaluation_visible_to_family(p_match)` | Oráculos booleanos sobre ids ajenos (¿U es miembro de S?, ¿el equipo T es de S?…). Mismo patrón que `es_staff_de_escuela` (cerrado el 10-27) | 1 o 2 policies cada una | Gate al estilo de `20261027192225` (devolver false si quien llama no pertenece a la escuela). Hay que revisar cada policy antes, así que queda para otro lote |
| Oráculos de plan: `has_entitlement`, `school_has_addon`, `school_has_branding_feature`, `school_has_custom_domain_feature`, `school_has_native_app`, `school_shows_own_brand`, `is_gov_entity`, `is_non_saas_entity`, `school_is_operational` | Dicen el tier, los addons y el estado de prueba de cualquier escuela. Es información comercial, no personal | Policies (`school_is_operational`: 42) y otras funciones | Aceptable por ahora; ninguna devuelve datos personales |
| `mark_custom_domain_verified(p_id uuid)` | El owner o admin de una escuela puede **marcar verificado su propio dominio sin pasar la verificación DNS TXT** que hace el BFF. Es dentro del propio tenant. Y la llamada del BFF (`bff/src/routes/custom-domains.routes.ts:191`) usa el cliente service_role, con el que `auth.uid()` es NULL: la RPC responde `auth_required` y **la ruta siempre termina en 500**. Hoy la verificación por el BFF no puede funcionar | BFF (roto) | **Pregunta 2** |
| `create_demo_link(…)` + `access_demo_link(p_token)` (anon) | Cualquier sesión crea `app.sportmaps.co/demo/<token>` con el nombre de escuela, logo y color que quiera | Ninguno | **REVOKE** de las dos (en la migración) |
| `admin_create_staff_direct(p_email, p_role, p_branch_id)` | Crea una invitación sin validar `p_role` ni que `p_branch_id` sea de la escuela. Hoy la frena `accept_invitation_pro` (rechaza `owner` y el `school_admin` sin `invited_by` dueño) | Ninguno | **REVOKE** (en la migración) |
| `save_school_info` (2 sobrecargas), `save_school_branding` | El gate es `school_members` con rol owner/admin/school_admin/school **sin `status = 'active'`**: un admin dado de baja sigue pudiendo renombrar la escuela o cambiar su marca. Además, `save_school_branding` no consulta `school_has_branding_feature` (¿puede **editar** su marca según el tier?) | `frontend/src/hooks/useSettings.ts:235,275` | **Pregunta 3** |

## SERVICE

| Firma | Por qué | Llamador | Arreglo |
|---|---|---|---|
| `run_saas_billing_cycle()` | Job de facturación SaaS. Ya tiene gate (super_admin / service_role); el EXECUTE de `authenticated` sobra | `bff/src/jobs/saas-billing-cycle.job.ts:21` con `supabase` (service_role). No la usan el frontend ni las policies | **REVOKE** (en la migración) |
| `generate_school_subscription_invoice(p_school_id uuid)` | Igual | La llaman `run_saas_billing_cycle` y `admin_set_saas_billing_enabled`, las dos DEFINER (corren como dueño, no necesitan el grant del caller) | **REVOKE** (en la migración) |

Se revisaron otras funciones con gate de service_role y se descartaron como SERVICE:

- `grant_tactical_ai_credits` y `unblock_payment`: el BFF las llama con `userClient(req)`, así que necesitan `authenticated`.
- `admin_set_school_billing_agreement` y `set_school_video_settings`: no tienen llamador, pero ya tienen gate. No vale el riesgo de cortarle el paso a un super_admin.

## OK (385)

- **Helpers de RLS sobre el propio caller:** `user_*_school_ids()`, `coach_*_ids()`, `current_staff_*`, `is_parent_of_child`, `is_school_admin(p)` y similares. Comparan el parámetro con `auth.uid()`, así que no son oráculos.
- **Con gate explícito sobre el objeto** (cargan la fila y comparan su `school_id` con `user_staff/admin_school_ids()`, `can_manage_*`, `finance_permission` o `is_school_admin`): tesorería, facturas, informes, dotación, pizarra, torneos, tienda (`_store_actor` solo respeta `p_actor` bajo service_role), clínica y similares.
- **Ligadas a `auth.uid()`:** `get_my_*`, `my_*`, `save_*_preferences`, `claim_orphan_children` (por el correo de la sesión), `submit_athlete_installment`, `cancel_my_order`, etc.
- **Públicas por diseño:** por slug (`get_school_by_slug`, `get_join_qr_public`, `submit_school_lead`), por token de capacidad (`get_invitation_details`, `verify_athlete_*_public`) o por búsqueda (`search_*`). También `get_school_payment_info`, que devuelve cuentas bancarias solo si la escuela activó `public_profile_enabled`, como pide la pantalla de pago.

## Preguntas (no entraron a la migración)

1. **`notify_user`.** Arreglo propuesto: cambiar la primera rama por *«el objetivo es miembro activo, acudiente de un menor o dueño de una escuela donde quien llama es owner/admin/school_admin activo»*. Así seguirían funcionando `approvePayment`, `RegisterCashPaymentModal` y `ParentCheckoutPage`. Lo que no está claro es `transactions.ts:144` (atleta → profesional de wellness): hoy pasa **solo** si el atleta es admin de alguna escuela, o sea que casi siempre falla en silencio. ¿Esa notificación tiene que llegar? Si sí, se agrega una cuarta rama: *«existe una `wellness_appointments` del caller con ese profesional»*. Con la respuesta, va el `CREATE OR REPLACE` partiendo del `prosrc` vivo, con `SET search_path = pg_catalog, public, pg_temp` (hoy tiene `search_path=public`).
2. **`mark_custom_domain_verified`.** ¿La verificación DNS es la que manda? Si sí: REVOKE de `authenticated` y que la RPC acepte service_role con el actor por parámetro (patrón `_store_actor`). Con eso se arregla también el 500 del BFF. Es un cambio de firma, por eso no entró aquí.
3. **`save_school_info` / `save_school_branding`.** ¿Se agrega `status = 'active'` al gate? Lo que no se sabe es si hay owners cuyo `school_members.status` no sea `'active'`; eso requiere contar filas, y en esta auditoría no se leyeron datos. ¿Y `save_school_branding` tiene que respetar `school_has_branding_feature`, o `branding_settings` es otra cosa distinta de la marca que se cobra por tier?
4. **`get_trainer_athlete_ids(p_school_id)`.** ¿Se le pone gate (devolver vacío si quien llama no es staff de `p_school_id`)? Las 17 policies que la usan seguramente ya exigen que el caller sea trainer de esa escuela, pero hay que leerlas una por una antes de tocarla.
5. **Ramas `production` y `demo`.** Su `JoinTeamPage.tsx` llama `claim_child_for_parent`. Si alguna de las dos sigue desplegada en algún dominio, su alta por QR va a fallar después del REVOKE. Según la topología, producción es `main`; `demo` se resetea a `develop` cuando se actualiza.

## Cómo aplicar

- Migración: `supabase/migrations/20261028111725_gates_definer_authenticated.sql`.
- Copia para pegar: `docs/migraciones-pendientes-2026-10-28/gates-definer-authenticated.sql`.
- Verificación de solo lectura: `docs/migraciones-pendientes-2026-10-28/gates-definer-authenticated-verificar.sql`. Tiene que dar `authenticated=false`, `anon=false` y `service_role=true` en las 11 funciones, y 0 policies afectadas.
- Después: `npm run seguridad:invariantes`.
