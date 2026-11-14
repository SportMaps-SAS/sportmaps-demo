# Spec — Directivos / staff del club que solo ven informes

**Producto:** SportMaps · **Versión:** v0.1 · **Fecha:** 2026-11-05
**Estado:** 🟡 diseño propuesto, sin implementar, con decisiones abiertas (§12). Cliente de origen: Club Carmel (`school_id = 374a6716-af42-4745-afe1-8d089153e01b`).

> Reglas del repo que aplican: plan antes de código en migraciones; RLS línea por línea antes de aplicar; una sola sesión aplica migraciones; `GRANT EXECUTE` explícito por RPC; `search_path` fijo; todo de corrido, sin ramas por fases. Este documento no toca código, ni base, ni migraciones.

---

## 1. Problema

En la reunión con Carmel pidieron «solo para visualizar el informe» (`docs/plan-club-carmel-2026-09.md` §2.11, pregunta 4 de §4). Dos lecturas posibles: la familia o un directivo. El usuario respondió el 2026-11-05: **lo verán directivos o staff del club; deben poder registrarse ellos mismos y ver solo esos informes, nada más de la app.**

Hoy no existe una figura así. Las tres cosas más cercanas fallan:

- `reporter` es de cartera (dinero), no de lo deportivo (§2.1).
- `school_admin` con módulos apagados ve y puede tocar demasiado (§2.3).
- Un `coach` ve solo sus equipos y escribe notas.

Además hay una restricción de fondo que no es técnica: **el bloqueo real de Carmel es el consentimiento de los padres** (consideran el rendimiento de sus hijos muy sensible). Carmel tiene **0 acudientes vinculados** (de 72 a 108 menores) y, al 2026-10-07, 81 informes de atleta todos en `borrador`, 0 publicados. Dar acceso a un directivo no resuelve eso, y puede agravarlo si se hace mal. Por eso §6 decide qué ven y bajo qué condición.

## 2. Qué existe hoy (verificado en el repo)

### 2.1 El rol `reporter`: es de cartera, y es un riesgo si se reutiliza

- **Etiquetas incoherentes:** en la UI de invitaciones y en el correo se llama «Súper Usuario» (`InvitationsManagementPage.tsx`, `lib/email/invitationEmail.ts`); en el sidebar se rotula «Auditoría» (`AppSidebar.tsx:271`); en el catálogo de roles es `reporter`.
- **Menú propio** (`config/navigation.ts:950`): Dashboard, «Panel de Reportes» (`/reporter-dashboard`), Calendario, Notificaciones, Facturación (`/mi-plan`), Configuración. El panel es «cartera por estado (pagado/pendiente/vencido) con exportación CSV» (`routePermissions.ts:146`). **Nada deportivo.**
- **BFF:** `bff/src/routes/reports.ts` lo deja entrar a reportes de cartera (`ROLES_CARTERA` incluye `reporter`). Está excluido de finanzas (`assertSchoolFinanceAdmin`) y de cobros.
- **Es un rol de `school_members` y por eso cuenta como staff.** `user_staff_school_ids()` (def. viva en `20261003202416`) devuelve toda escuela donde hay membresía activa con rol **NOT IN (`parent`,`athlete`,`accountant`)**. `reporter` y `viewer` entran. `user_school_ids()` (`20260301000000`) devuelve **cualquier** membresía activa. O sea: poner a un directivo como `reporter` le da, sin que nadie lo decida, la lectura que las policies dan al staff (la migración `20260814184457` midió 2 reporters que perdían escritura al cerrar el piso de RLS).
- **Trampa en el frontend:** `useSchoolContext.ts:292` trata un perfil `reporter` **sin membresía** como dueño nuevo y lo manda a onboarding de escuela (`setCurrentUserRole('owner')`, `onboardingStatus = 'pending'`). Un directivo que se registre así cae a crear una escuela.
- **Registro:** `normalize_signup_role` no lo reconoce. Un registro con `role=reporter` termina como `athlete` + `needs_role_selection`, salvo que haya invitación pendiente a su correo (`handle_new_user`, `20261010202857`). `accept_invitation_pro` y `create_invitation` aceptan `reporter` en su lista blanca (`20261014212620`) y lo insertan en `school_members`.

**Conclusión:** `reporter` no sirve tal cual y no debe ser el vehículo.

### 2.2 Invitación y registro existentes

- **Invitaciones** (`invitations`, `create_invitation`, `accept_invitation_pro`): lista blanca de rol (`parent, athlete, coach, reporter, accountant, school_admin`); `school_admin` solo lo invita el dueño. Aceptar siempre termina en una fila de `school_members`. Ojo: el vencimiento de invitaciones es decorativo (memoria `project_invitation_expiry_is_decorative`), hay que aplicarlo adentro de la RPC nueva.
- **Código de escuela** (`20261026132948_codigo_de_escuela.sql`): `school_join_codes`, `school_join_requests`, `school_join_code_attempts` (rate limit, `_school_join_code_rate_ok`), RPCs `preview_school_join_code`, `submit_school_join_request`, `list_school_join_requests`, `resolve_school_join_request`, `get/rotate_school_join_code`. **Está pensado para deportistas e hijos** (`p_for_whom IN ('self','child')`, nombre y fecha de nacimiento del deportista); `resolve_school_join_request` reutiliza el camino de «Agregar estudiante». No sirve para staff sin extenderlo, pero su patrón (código + solicitud + aprobación del admin + rate limit) es el molde.
- **Solicitudes de acceso con menor privilegio:** `handle_new_user` ya deja a quien llega por invitación como `athlete` mientras `accept_invitation_pro` le pone el rol real.
- **Multirol y contextos:** `lib/roleContexts.ts` (`ContextViewRole`) y `accept_invitation_pro` D3 (una persona puede ser staff y familia a la vez sin que aceptar una invitación le pise el rol).

### 2.3 Los informes que existen

| Informe | Tabla / fuente | Quién lo ve hoy | Qué contiene | ¿Cabe en «esos informes»? |
|---|---|---|---|---|
| **Informe Mensual del Atleta** | `athlete_reports` (`status`: borrador, listo, **publicado**, retenido, omitido), `snapshot` jsonb congelado | Familia (solo `publicado`, policy `athlete_reports_select_family`), coach de sus atletas (`coach_can_see_report`), admin (`can_manage_reports`) | Destacados, métricas a trabajar, asistencia del mes, radar, notas de equipo, nota individual; **datos de un menor identificable** | **Sí**, es «el informe». Sujeto a consentimiento (§6) |
| **Informe de equipo** | `team_reports` (`borrador/publicado`) + `report_section_notes` | Coach y admin (la migración dice que por ahora NO se expone a familias) | Agregado por equipo y periodo, con un comentario del coach por bloque | **Sí**, es el candidato natural: agregado, bajo riesgo |
| **Reporte de partido** | `match_reports` (+ `match_report_replies`) | Staff; la familia lo recibe por RPC si `school_settings.share_match_reports` | Resumen, desarrollo, aspectos a mejorar, comentario de administración; las **respuestas de familias** viven aparte | **No en v1.** Mezcla comentarios de administración y respuestas de familias; no fue pensado para terceros |
| **Evaluaciones** (`performance_entries`, evaluación post-entreno, mesociclo) | Datos crudos | Staff | Mediciones por menor, sin curar | **No.** Son crudos; el informe ya los resume y congela en `snapshot` |
| **Asistencia del mes** (`/school-reports`) | Agregado por equipo | Admin | % de asistencia | Opcional, ya es agregado; ver D-2 |

**Regla de oro heredada del módulo:** el `snapshot` es la única fuente de lo que se muestra (no se lee `performance_entries` en vivo). El directivo también lee el snapshot.

### 2.4 Menú y rutas

Hay dos árboles: `config/navigation.ts` (menú por rol) y el rediseño V2 (`MobileBottomNav`, `components/v2/RutasSegunRol`, `lib/feature-flags.ts`). El informe del acudiente vive en `/children/:id/reports` y `/children/:id/reports/:reportId` (`ChildReportsPage`, `ChildReportDetailPage`); el del staff, en `/informe-mensual` (`MonthlyReportsPage`, roles `school/school_admin/coach`, con `ModuleGate`).

## 3. Opciones de modelo

| | A. `reporter` reutilizado | B. Rol nuevo en `school_members` (`report_viewer`) | C. Tabla propia de accesos de lectura por escuela (`report_viewer_access`), **sin** tocar `school_members` ni `profiles.role` | D. Permiso/flag sobre `school_admin` o `coach` |
|---|---|---|---|---|
| Qué es | Invitar con `reporter` | Rol más, como se hizo con `accountant` | Una fila (escuela, persona, estado) leída solo por RPCs | Un switch «solo informes» en un rol existente |
| Radio de lectura accidental | **Alto:** cuenta como staff en `user_staff_school_ids()` y como miembro en `user_school_ids()` | **Medio-alto:** entra por defecto en `user_school_ids()` (todo SELECT por membresía) y, si no se excluye a mano, en `user_staff_school_ids()` y `staff_school_ids()`. El precedente `accountant` tuvo que excluirlo en 2 helpers (N1, `20261003202416`) | **Mínimo:** ningún helper existente lo ve; las ~cientos de policies no cambian | Alto: hereda todo el rol y depende de que el front lo esconda (el front nunca es la barrera) |
| Costo en código | Bajo, pero hay que arreglar `useSchoolContext:292`, el menú y el rol que ve cartera | Alto: enum `user_role` (+ `profiles.role`), CHECK de `school_members`, `AuthContext`, `ProtectedRoute`, `routePermissions`, ~13 uniones de tipos, `accept_invitation_pro`, `create_invitation`, invitaciones UI | Medio: tabla + ~8 RPCs + una pantalla + un guard de ruta; sin tocar el enum | Bajo en DB, alto en riesgo |
| Multirol (padre + directivo, coach + directivo) | Pelea con `ROLE_PRIORITY` y `profiles.role` | Mejor, pero cada rol extra complica `ROLE_PRIORITY` | Natural: es un **contexto** adicional, no un rol de perfil | Confuso |
| Encaja con «solo informes, nada más» | No | Sí, si se excluye en todos los helpers (fácil olvidar uno) | **Sí, por construcción:** lo único que existe para esa persona son las RPCs de informes | No |
| Reversibilidad | Media | Baja (valor de enum no se quita) | **Alta** (se revoca una fila) | Media |

## 4. Recomendación

**Opción C: tabla propia `report_viewer_access`, acceso solo por RPC, sin tocar `school_members`, `profiles.role` ni las policies de `athlete_reports` / `team_reports`.**

Por qué:

1. **«Ver solo informes» tiene que ser verdad en la base, no en el menú.** En este repo cada rol que entra a `school_members` hereda lectura por `user_school_ids()` y, salvo exclusión explícita, por `user_staff_school_ids()`. Para B habría que acordarse de excluirlo en cada helper (lección N1 de `accountant`) y revisar cada policy que use `user_school_ids()` para lectura. Con C, esa revisión no existe: el directivo no pertenece a ninguna escuela a ojos del resto del sistema.
2. **Trampa 1 de CLAUDE.md** (las policies permisivas se suman con OR): no se agrega **ninguna** policy nueva a `athlete_reports`/`team_reports`. El directivo no hace SELECT directo; todo pasa por RPC `SECURITY DEFINER` con gate interno. Así no se abre una quinta puerta sobre tablas con datos de menores.
3. **Multirol sin pelea:** un padre que además es directivo conserva su rol de familia; el acceso de directivo es un contexto aparte (patrón de `roleContexts.ts` y D3 de `20261014212620`), no un cambio de `profiles.role`.
4. **Evita las tres trampas de `reporter`** (§2.1): no cuenta como staff, no cae a onboarding de dueño, no ve cartera.
5. **Reversible:** revocar es un `UPDATE status`. No hay valores de enum que no se puedan quitar.

Costo aceptado: una pantalla y un guard de ruta propios, y que el nombre del rol no vive en `profiles.role` (la persona es `athlete` o `parent` en su perfil; su condición de directivo sale de la tabla). Eso exige que el front pregunte por `my_report_viewer_scope()` después del login (§9).

El nombre de producto: **«Directivo»** (o «Acceso a informes») en pantalla; internamente `report_viewer`. No «Súper Usuario» ni «Auditoría».

## 5. Cómo se registran

Objetivo del usuario: que se registren ellos mismos. Se separan tres cosas: **crear la cuenta** (siempre lo hace la persona), **pedir acceso** y **que la escuela lo apruebe**. Nunca hay acceso automático.

| | Invitación del admin | Auto-registro con código + aprobación |
|---|---|---|
| Flujo | El admin escribe correo + cargo; la persona recibe enlace, crea su cuenta (o inicia sesión) y queda activa al confirmar | La persona crea cuenta, escribe el **código de la escuela** y cargo; queda `pendiente`; el admin aprueba o rechaza |
| Quién decide | El admin, antes | El admin, después |
| Riesgo | Bajo: ligado a un correo, token de un solo uso | Medio: el código circula (hoy se pensó para familias; si un padre lo ve en un grupo de WhatsApp, puede pedir acceso). La aprobación manual lo contiene |
| Infra reutilizada | `invitations` no (su aceptación termina en `school_members`); tabla/RPC propias | `school_join_codes` + `_school_join_code_rate_ok` + `school_join_code_attempts` (mismo rate limit) |
| Fricción para el club | El admin necesita conocer los correos | Cero: la directiva solo recibe el código |

**Recomendación:** ambos caminos, uno como principal y otro como atajo, **sin acceso sin aprobación en ninguno**:

- **F1: invitación del admin** (correo + cargo) con enlace de un solo uso. Es lo más seguro, está atado al correo y da el flujo completo con menos superficie. El «registrarse ellos mismos» se cumple: ellos crean su cuenta desde el enlace.
- **F2: auto-registro con código + aprobación del admin**, si Carmel prefiere no recolectar correos. Reusa el código existente, pero **el código no otorga nada**: solo crea una solicitud `pendiente`. Por eso mismo conviene un **código distinto del de familias** (columna nueva o tabla aparte), para que quien tenga el de familias no pueda pedir acceso de directivo.

Reglas comunes (se aplican **dentro de las RPCs**, no en el front):

- La invitación se liga al correo de `auth.users` **verificado** (`email_confirmed_at` no nulo); reclamarla con otra cuenta falla.
- Vence a los N días (la RPC lo valida; no confiar en el vencimiento decorativo de `invitations`).
- Un solo uso; reclamarla marca `claimed_at` y no se puede reenviar a otra cuenta.
- Rate limit en el reclamo y en la solicitud por código (reutilizar el patrón de `_school_join_code_rate_ok`).
- Un usuario puede tener acceso en varias escuelas; cada fila es independiente.

## 6. Qué ven exactamente

**Pantalla única «Informes del club»** (§9), con filtro por periodo (año/mes) y por equipo. Dos listas:

1. **Informes de equipo** (`team_reports`, solo `status = 'publicado'`): lo que el equipo trabajó, por bloque, con el comentario del coach. Es **agregado**: bajo riesgo.
2. **Informes de atleta** (`athlete_reports`, solo `status = 'publicado'`), solo de menores con consentimiento registrado (abajo).

Nunca: borradores, `retenido`/`omitido` ni su `hold_reason`, ids de staff, histórico de snapshots, reporte de partido, respuestas de familias, evaluaciones crudas, cartera, pagos, asistencia individual, listados de deportistas, datos de contacto de familias, mensajería.

### Datos de menores y consentimiento (el punto delicado)

El Informe del Atleta muestra el rendimiento de un menor identificable. Los padres de Carmel lo consideran sensible, y hoy ni siquiera hay acudiente vinculado. Cuatro niveles posibles de exposición, de menor a mayor:

| Nivel | Qué ve el directivo | Consentimiento necesario |
|---|---|---|
| N1 | Solo informes de **equipo** (agregados, sin nombres de menores) | Ninguno adicional: es información de gestión del club, igual que ya la ve el coach/admin |
| N2 | N1 + informes de atleta **anonimizados** (iniciales o «Deportista 1», sin nombre ni documento) | Recomendable aviso en la política de privacidad (§12 D-3) |
| N3 | N1 + informes de atleta **con nombre**, solo de menores con **consentimiento registrado** por el admin | Sí, por menor (switch del admin; se reutiliza el criterio del link público: el consentimiento se obtiene fuera del sistema y se registra con un switch) |
| N4 | Todo informe publicado del club | No recomendado |

**Recomendación: N1 en la primera entrega, N3 como segundo paso**, con el switch por menor (`consent_viewers` sobre el informe/atleta, apagado por defecto, lo prende solo el admin). Razón: da valor inmediato a la directiva (ve cómo va cada categoría) sin tocar datos individuales de menores hasta que el club tenga el consentimiento. Si Carmel quiere ver a cada niño, ese es exactamente el cuello de botella del consentimiento que ya existe, y no se resuelve con código. N2 se descarta salvo que el club lo pida: la anonimización de informes con radar y notas libres es frágil (la nota del coach suele traer el nombre).

> A verificar al implementar: que el `snapshot` de `team_reports` no traiga nombres de menores dentro de sus bloques. Si los trae, el N1 tendría que filtrarlos en la RPC o el informe de equipo caer a N3.

El directivo ve solo lo **publicado**: el borrador nunca llega. Publicar sigue siendo del admin/coach; el directivo no puede publicar, retener, corregir ni comentar.

## 7. Datos, RLS y RPCs

### 7.1 Tablas nuevas (diseño; nada se escribe aquí)

- **`report_viewer_access`**: `id`, `school_id` → `schools`, `profile_id` → `profiles(id)` (nullable hasta reclamar), `email` (normalizado), `display_name`, `title` (cargo), `status` text + CHECK (`invited | pending | active | revoked`), `invited_by`, `approved_by`, `token_hash`, `expires_at`, `claimed_at`, `revoked_at`, `created_at`. Único `(school_id, profile_id)` y único parcial por `(school_id, email)` activo/pendiente. Estados con `text + CHECK`, no `CREATE TYPE`.
- **`report_viewer_access_log`** (auditoría, append-only): `viewer_id`, `school_id`, `report_kind` (`team|athlete`), `report_id`, `viewed_at`. Sin `UPDATE`/`DELETE` para nadie.
- Columna en `school_settings`: `report_viewers_enabled boolean NOT NULL DEFAULT false` (flag solo Carmel, §10).
- (N3) Registro de consentimiento por menor/sujeto, atado a `school_id` + `subject_type/subject_id`, escrito solo por RPC del admin.

Las tres tablas: `ENABLE ROW LEVEL SECURITY`, **cero policies** para `authenticated`/`anon` y `REVOKE ALL … FROM PUBLIC, anon, authenticated` explícito (molde de `whatsapp_identifications`; la lección de `payment_links`). Todo acceso es por RPC.

### 7.2 RPCs (todas `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`, con `GRANT EXECUTE … TO authenticated` explícito, nada a `anon`)

**Del directivo (solo lectura):**

| RPC | Hace | Gate interno |
|---|---|---|
| `my_report_viewer_scope()` | Devuelve las escuelas donde el caller tiene acceso `active` (id, nombre, flag) | Solo filas del propio `auth.uid()`; no recibe ids |
| `list_report_viewer_reports(p_school_id, p_year, p_month, p_team_id)` | Lista informes `publicado` visibles (equipo y, con N3, atleta con consentimiento) | `is_report_viewer_of(p_school_id)`: acceso activo **en ese** `p_school_id`, flag de escuela encendido; si no, `42501` |
| `get_report_viewer_report(p_kind, p_report_id)` | Devuelve el `snapshot` de un informe | Resuelve la escuela **desde el informe**, no desde un parámetro; exige acceso activo a esa escuela, `status = 'publicado'` y (atleta) consentimiento; inserta en `report_viewer_access_log` en la misma transacción |

**De la administración (escritura), todas atadas a `p_school_id`:**

| RPC | Gate |
|---|---|
| `invite_report_viewer(p_school_id, p_email, p_name, p_title)` | `can_manage_reports(p_school_id)` **y** flag encendido |
| `claim_report_viewer_invite(p_token)` | Caller autenticado; el correo de `auth.users` (verificado) coincide con la invitación; vigente; un solo uso |
| `request_report_viewer_access(p_code, p_title)` (F2) | Caller autenticado; código válido y rate limit; crea `pending`, **no** `active` |
| `list_report_viewers(p_school_id)` / `resolve_report_viewer_request(p_school_id, p_id, p_decision)` / `revoke_report_viewer(p_school_id, p_id)` | `can_manage_reports(p_school_id)`; el `p_id` debe pertenecer a ese `p_school_id` |
| `list_report_viewer_access_log(p_school_id, p_from, p_to)` | `can_manage_reports(p_school_id)` |
| `set_report_consent_viewers(p_school_id, p_subject_type, p_subject_id, p_on)` (N3) | `can_manage_reports(p_school_id)` |

### 7.3 Helpers de alcance: cuál sí y cuál no

- **Nunca `user_school_ids()` para escritura ni para decidir acceso de directivo** (incluye padres y atletas; invariante I2). Aquí ni siquiera se usa para lectura: el alcance de lectura del directivo es **su fila en `report_viewer_access`**, no una membresía.
- **Administración de accesos: `can_manage_reports(p_school_id)`** (admin/owner/`school_admin` por ambos helpers, `20260731161243`), siempre **atado al id** que recibe la RPC. Quien otorga acceso no puede ser coach ni directivo. El directivo **no** puede invitar a otro directivo (si un permiso permite otorgar permisos, no se delega).
- **`is_report_viewer_of(p_school_id uuid)`**: helper que solo llaman las RPCs (no aparece en ninguna policy porque no se crean policies). Es el segundo caso de CLAUDE.md: `REVOKE ALL … FROM PUBLIC, anon, authenticated` y sin GRANT (lo ejecuta el dueño de la función). Si en algún momento una policy lo necesitara, el caso cambia y llevaría `GRANT … TO authenticated`: documentarlo en la migración.
- **Gates de alcance adentro de cada RPC**, atados al id que llega o al id derivado del informe. Un gate que solo pregunta «¿es directivo de alguna escuela?» no es gate (así estaba `notify_user`).
- **Sin `notify_user`** a directivos en v1.
- Invariantes: `npm run seguridad:invariantes` después de aplicar (I3 y I4 aplican a lo nuevo: sin `FOR ALL` sin `WITH CHECK`, ni `SECURITY DEFINER` sin `search_path`).
- **Aplicar con vía que deje rastro**, una sola sesión, `types.ts` una sola vez al final (reglas de Disk IO de CLAUDE.md).

### 7.4 Lo que NO se toca

`athlete_reports`, `team_reports`, `school_members`, `profiles.role`, `accept_invitation_pro`, `create_invitation`, `handle_new_user`, `user_*_school_ids()`. Cero cambios en lo existente reduce el radio a cero: ninguna escuela distinta de Carmel puede verse afectada aunque la migración falle a medias.

## 8. Auditoría de accesos (quién vio qué)

- Cada llamada a `get_report_viewer_report` escribe una fila en `report_viewer_access_log` **dentro de la misma transacción** que entrega el dato (si el log falla, no se entrega).
- Se registra también: reclamo de invitación, aprobación/rechazo, revocación, y cambios de consentimiento (quién, cuándo, sobre quién).
- Pantalla de administración «Accesos a informes» (dentro de la configuración de informes del admin): directivos activos, pendientes, último acceso, y el log filtrable por persona o por informe. El admin puede revocar con un clic; efecto inmediato (la RPC consulta `status` en cada llamada, no hay token de larga vida).
- **Importante:** la vista del directivo **no** incrementa `athlete_reports.view_count` ni escribe `viewed_at`. Esos campos gobiernan la cascada de entrega a la familia (§7.1 del módulo de informes); un directivo que los mueva haría creer que la familia ya leyó. Hay un log aparte justamente por eso.
- Si la tabla general `security_audit_log` (migración `20261105211824`, de otra sesión, aún sin commitear) llega a develop antes, evaluar escribir también ahí; no depender de ella.

## 9. Menú mínimo: una sola pantalla

- Ruta única `/informes-club`, fuera de los menús por rol. **Guard propio** (no `ProtectedRoute` por `profiles.role`): llama `my_report_viewer_scope()` y si no hay acceso activo redirige. Va en `routePermissions.ts` con su descripción.
- Shell mínimo: sin sidebar de escuela, sin bottom nav V2, sin enlaces a pagos, asistencia, calendario ni mensajería. Solo: nombre de la escuela, filtros, lista, detalle, y menú de cuenta (perfil, cerrar sesión).
- **Los dos árboles de menú:** en `navigation.ts` el contexto «Directivo» tiene un único ítem; en V2 (`MobileBottomNav`, `RutasSegunRol`) el contexto no muestra barra inferior. Agregarlo a `BrandingScope` para que use la marca de la escuela.
- **Reutiliza el render del informe** (`ChildReportDetailPage` → componente compartido, mismo criterio del spec del link público) para no duplicar JSX; el de equipo reutiliza el render de `CoachTeamPostTrainingReportPage`/informe de equipo.
- **Login:** tras el login, si `my_report_viewer_scope()` trae una escuela y la persona **no tiene otras membresías**, aterriza en `/informes-club`. Si además es padre/coach, ve su app normal y un cambio de contexto «Informes del club» (patrón `roleContexts.ts`); el contexto de directivo nunca expone las pantallas del otro rol.
- **Guardas del frontend:** evitar el caso `useSchoolContext:292` (perfil sin membresía que cae a onboarding de dueño): el directivo puro es `athlete`/`parent` sin membresía, que hoy «salta el School Gate». Verificar en pantalla, no por lectura.

## 10. Flag solo para Carmel

`school_settings.report_viewers_enabled`, `DEFAULT false`, encendido por `UPDATE` puntual para Carmel después de aplicar la migración (mismo patrón que `coach_can_create_teams`, `allow_secondary_team_enrollment`, `reports_share_via_token_enabled`). Expuesto en `v_school_entitlements` y en `useEntitlements`. Con el flag apagado: `invite_*`/`request_*` rechazan, las RPCs de lectura devuelven `42501` y el menú de admin no muestra el módulo. Toda escuela distinta de Carmel queda idéntica a hoy.

Prerrequisitos de Carmel: `reports_enabled` (hoy `false`) y que existan informes **publicados**. Sin eso, la pantalla del directivo estará vacía; hay que decirlo en el aviso de «próximamente» y no prometer una fecha.

## 11. Fases (todo de corrido; sin ramas por fases; staging/main los pide el usuario)

1. **Plan de migración aprobado** antes de escribir SQL: tablas, RPCs, GRANT, pruebas.
2. **Base:** tablas + flag + helpers + RPCs de admin e invitación (F1) + RPCs de lectura (N1: solo informes de equipo). Una sola sesión aplica; invariantes; `types.ts` al final.
3. **BFF:** correo de invitación (plantilla propia, no la de «Súper Usuario») y, si hace falta, un endpoint delgado que llame las RPCs (el patrón del repo es RPC directa desde el cliente).
4. **Frontend:** pantalla `/informes-club`, guard, contexto en los dos árboles, pantalla de administración «Accesos a informes».
5. **N3 (informe de atleta con consentimiento):** tabla/switch de consentimiento + RPCs de lectura de atleta. Solo cuando Carmel tenga consentimientos registrados.
6. **F2 (opcional):** auto-registro con código + aprobación.
7. **QA real:** simulación de sesiones (`set_config('request.jwt.claims', …)` + `SET LOCAL ROLE authenticated`) y prueba en pantalla con una cuenta de directivo; un directivo de Carmel no debe ver nada de otra escuela; un padre no debe poder reclamar una invitación ajena.

### Pruebas que el cierre debe demostrar

1. Directivo activo en Carmel: lista y abre un informe **publicado** de equipo; un `borrador` → no aparece; uno de otro equipo/escuela → `42501`.
2. Directivo **revocado**: la siguiente llamada falla (no hay caché de acceso).
3. `SELECT` directo del directivo sobre `athlete_reports`, `team_reports`, `match_reports`, `school_members`, `payments`, `children` → **0 filas / sin privilegio** (como cuenta sin membresía).
4. Invitación reclamada con otro correo → falla; vencida → falla; reutilizada → falla.
5. Un padre de Carmel que se hace pasar por directivo (pide acceso con el código de familias) → no entra a ninguna lista.
6. `set local role anon;` a las tablas nuevas → sin privilegio.
7. `view_count` y `viewed_at` de `athlete_reports` no cambian al ver como directivo.
8. Fila de `report_viewer_access_log` por cada informe abierto.
9. Con `report_viewers_enabled = false`, todo falla.
10. Multirol: usuario padre **y** directivo ve su app de padre intacta y el contexto de directivo solo con la pantalla de informes.

## 12. Riesgos

| Riesgo | Mitigación |
|---|---|
| **Datos de menores sin consentimiento** (el bloqueo real de Carmel) | N1 primero (agregados); N3 solo con consentimiento por menor y switch del admin; nada de N4. Hablarlo con Carmel antes de subir a producción |
| **Escalada de privilegios** (directivo invita a otro, se autoaprueba, reclama la invitación de otro) | El directivo no tiene RPC de escritura; invitar/aprobar exige `can_manage_reports(p_school_id)`; el reclamo exige correo verificado igual al invitado; sin `school_members`, no hereda nada |
| **Quinta puerta por policy OR** | No se crean policies nuevas sobre tablas de informes; solo RPC con gate interno |
| **Multirol** (padre + directivo; coach + directivo) | El acceso de directivo es contexto, no `profiles.role`; las RPCs resuelven por fila de acceso, no por rol del perfil; pruebas §11.10 |
| **Código de escuela compartido en grupos de familias** | Código distinto para directivos (F2), aprobación obligatoria, rate limit; F2 es opcional |
| **El directivo marca como «visto» el informe de la familia** | Log aparte; `get_report_viewer_report` no toca `view_count`/`viewed_at` |
| **Fuga por `snapshot` con nombres** | Verificar el contenido real de `team_reports.snapshot` antes de N1; si trae nombres, filtrar en la RPC |
| **Pantalla vacía** (0 informes publicados hoy) | Es prerrequisito del flag, no del acceso: explicarlo; el valor llega cuando la escuela publique |
| **Perfil `reporter` sin membresía cae a onboarding de dueño** (`useSchoolContext:292`) | No usar `reporter`; el guard del directivo no depende de `profiles.role` |
| **Etiquetas confusas** («Súper Usuario», «Auditoría») | Rotular **«Directivo / Acceso a informes»**; no reusar esas etiquetas |
| **Disk IO** | Una sola sesión aplica la migración, `types.ts` al final, sin listar catálogo como sondeo; las RPCs de lista leen por índice `(school_id, period_year, period_month, status)` ya existente |
| **Dos árboles de menú** | Cubrir `navigation.ts` y V2 en la misma entrega; probar con el flag V2 prendido y apagado |

## 13. Decisiones para el usuario

**D-1. Modelo.**
- (a) `reporter` reutilizado — no recomendado (cartera + cuenta como staff + cae a onboarding de dueño).
- (b) Rol nuevo en `school_members` — viable pero costoso y con riesgo de olvidar un helper.
- **(c) Tabla propia + RPC, sin tocar roles existentes — RECOMENDADO** (§4).
- (d) Flag sobre `school_admin`/`coach` — no.

**D-2. Qué informes ve el directivo.**
- (a) Solo informes de **equipo** — **RECOMENDADO para la primera entrega**.
- (b) Equipo + asistencia del mes agregada por equipo (ya existe como bloque) — razonable, bajo riesgo.
- (c) Equipo + informes de atleta (ver D-3).
- (d) Además reporte de partido y evaluaciones — no en v1.

**D-3. Informes individuales de menores (el que más pesa).**
- (a) No mostrarlos hasta tener consentimiento — **RECOMENDADO**.
- (b) Mostrarlos solo de los menores con consentimiento registrado por el admin (N3) — **RECOMENDADO como segundo paso**.
- (c) Anonimizados (N2) — no recomendado (las notas libres delatan al niño).
- (d) Todos los publicados — no.
Pregunta de fondo para Carmel (ya pendiente en su plan, #5): ¿los padres firmaron algo que cubra «informes de rendimiento» y que nombre a la directiva como destinataria?

**D-4. Cómo se registran.**
- (a) Solo invitación del admin — **RECOMENDADO para F1**.
- (b) Código + aprobación del admin — **RECOMENDADO como F2** si Carmel no quiere recopilar correos; con código distinto al de familias.
- (c) Ambos desde el inicio — más trabajo, mismo riesgo si hay aprobación.
- (d) Auto-registro sin aprobación — **no**, ni siquiera con código.

**D-5. Quién puede aprobar o invitar.**
- (a) Solo owner/`school_admin` (`can_manage_reports`) — **RECOMENDADO**.
- (b) También el coach — no (coach no otorga acceso).

**D-6. Alcance por equipo.**
- (a) El directivo ve todos los equipos del club — **RECOMENDADO** (es directiva).
- (b) Se puede acotar por equipos (una directiva por categoría) — más tabla, solo si Carmel lo pide.

**D-7. Nombre en pantalla.**
- (a) «Directivo» / «Acceso a informes» — **RECOMENDADO**.
- (b) Otro nombre que Carmel prefiera.

**D-8. Vigencia del acceso.**
- (a) Hasta que el admin lo revoque, con aviso mensual de «tienes N directivos activos» — **RECOMENDADO**.
- (b) Caduca cada año y se renueva.

**D-9. Auditoría visible.**
- (a) Solo el admin ve el log — **RECOMENDADO**.
- (b) También se avisa al coach cuando un directivo abre el informe de su equipo — no en v1.

## Referencias

- `docs/plan-club-carmel-2026-09.md` §2.11, §4 · `docs/specs/athlete-reports-module.md` · `docs/specs/informe-atleta-link-publico.md` (patrón de consentimiento fuera del sistema y de tablas sin policies).
- `supabase/migrations/20260731161043_athlete_reports_tables.sql`, `20260731161243_athlete_reports_rls.sql`, `20260914151925_post_entreno_informe_grupal.sql`, `20261022110209_reporte_partido_entrenador_admin_familia.sql`, `20261026132948_codigo_de_escuela.sql`, `20261014212620_contextos_familia_invitaciones.sql`, `20261003202416_finanzas_permiso_y_rol_contador.sql`, `20260814184457_piso_rls_padres_no_gestionan_staff_ni_invitaciones.sql`, `20261010202857_signup_rol_whitelist_y_gates_admin_por_rol.sql`.
- `frontend/src/config/navigation.ts` (rol `reporter`, L950), `hooks/useSchoolContext.ts` (L274, L292), `lib/roleContexts.ts`, `components/ModuleGate.tsx`, `bff/src/routes/reports.ts` (`ROLES_CARTERA`).
