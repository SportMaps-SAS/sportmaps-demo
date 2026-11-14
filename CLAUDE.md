# Contexto del Proyecto — SportMaps

Plataforma de gestión deportiva para escuelas, entrenadores, padres y atletas.
Servicios: `frontend` (React + Vite + TypeScript) y `bff` (Express/Node.js). BD: Supabase (PostgreSQL 15 + RLS). Auth: Supabase Auth. Deploy: Vercel (frontend) + Render (bff) + Supabase Cloud (migraciones manuales).

Roles: athlete, parent, coach, school (owner/admin), wellness_professional, store_owner, admin, organizer, facility_manager.

## Convenciones de base de datos (OBLIGATORIAS)

- **Migraciones inmutables:** nunca editar ni borrar archivos en `supabase/migrations/`, aunque estén corruptos. Todo fix va en una migración **nueva** con timestamp posterior (`YYYYMMDDHHMMSS`).
- **Ledger de migraciones:** crear siempre con `npm run migrations:new -- <slug>` (reserva versión única y posterior al head) y commitear el `.sql` junto a `supabase/migrations_ledger.json`. Inventario: `npm run migrations:list`. El gate `npm run migrations:check` corre en pre-commit y CI. Flujo completo en `docs/migrations-workflow.md`.
- **`search_path`:** toda `CREATE FUNCTION` nueva debe incluir `SET search_path = pg_catalog, public, pg_temp` (evita warnings del linter).
- **`GRANT EXECUTE` OBLIGATORIO por RPC:** desde `20261029101115` toda función nueva nace **sin `EXECUTE` para nadie** salvo el dueño (y `service_role`). Sin `GRANT EXECUTE ON FUNCTION … TO authenticated` la pantalla da **42501 / 403**. `SECURITY DEFINER` NO exime al caller de tener `EXECUTE`. Plantilla en `docs/migrations-workflow.md` §2.
- **`anon` sin `EXECUTE`** salvo flujo público demostrado (pantalla sin sesión que la llama).
- **Helpers: dos casos, no mezclarlos.**
  - **Helper que usa una POLICY** (aparece en un `USING` o `WITH CHECK`): **SÍ** lleva `GRANT EXECUTE … TO authenticated`, y también `TO anon` si la policy alcanza a `anon` sobre una tabla que `anon` lee. Las policies se evalúan con el rol de quien consulta: sin ese GRANT, **toda** consulta a la tabla da 42501.
  - **Helper que solo llama otra función `SECURITY DEFINER`**: `REVOKE ALL … FROM PUBLIC, anon, authenticated` y sin GRANT (lo ejecuta el dueño).
- **Toda RPC que recibe un id de escuela/usuario valida el alcance del caller ADENTRO** (`user_*_school_ids()`, `is_school_admin()`, `is_platform_admin()`…) y lo ata a **ese** id. Un gate que solo pregunta «¿es admin de alguna escuela?» no es gate (así estaba `notify_user`).
- **`notify_user` solo a destinatarios con relación** (a sí mismo, gente de una escuela que administras, staff de tu escuela, cita de wellness) y con `p_link` interno (`/…`). Para avisos desde el BFF, `INSERT` en `notifications` con `service_role`.
- **Helpers de RLS:** nunca revocar `is_school_admin()`, `is_super_admin()`, etc. al rol que las invoca desde policies, o rompe con 403 todas las queries.
- **RLS sin self-recursion:** una policy sobre la tabla X nunca hace `SELECT FROM X` en su `USING`. Usar funciones `SECURITY DEFINER`.
- **Estados/enums en tablas nuevas:** usar `text + CHECK`, **no** `CREATE TYPE`. (Historia: `payments.status` es `TEXT` por el dolor de castear a `pay_status`.)
- **FKs de negocio** apuntan a `public.profiles(id)`, no a `auth.users` directo.
- **Stock/contadores:** mutar solo dentro de RPCs `SECURITY DEFINER` con `SELECT … FOR UPDATE`. Nunca `UPDATE` de stock desde el cliente.
- **Creación multi-fila = RPC transaccional, nunca N inserts sueltos desde el cliente.** Si crear una entidad implica escribir en más de una tabla relacionada (padre + hijos), va en una RPC `SECURITY DEFINER` que haga todo en la misma transacción. Dos+ inserts sueltos desde el frontend dejan al padre commiteado aunque el segundo falle — sin transacción no hay rollback. Costó un bug real: `create_mesocycle_with_weeks` (`20260918124721`) reemplazó 2 inserts sueltos que dejaban mesociclos sin sus semanas cuando el segundo chocaba contra un `UNIQUE`.

## Seguridad — OBLIGATORIO antes de dar por cerrado cualquier cambio de RLS, policies o permisos

**La fuente de verdad es la BASE, nunca el repo.** Que el fix esté commiteado no significa que esté vivo.

```bash
npm run seguridad:invariantes     # afirma las reglas contra la base viva
```

Sale con código 1 si hay violaciones **CRÍTICAS**. Correrlo después de tocar RLS, y también periódicamente: detecta lo que entró por fuera del repo.

Los cuatro invariantes están en la RPC `invariantes_seguridad()` (migración `20260814195349`):

| | Qué prohíbe |
|---|---|
| **I1** | Tabla con datos privados legible sin autenticación (`USING(true)` + policy que alcanza a `anon`/`public` + GRANT a `anon`) |
| **I2** | Policy de **escritura** que usa `user_school_ids()`, que incluye a padres y atletas |
| **I3** | `FOR ALL` sin `WITH CHECK` — PostgreSQL valida los INSERT con la expresión de `USING` |
| **I4** | `SECURITY DEFINER` sin `search_path` fijo |

### Las tres funciones de alcance: elegir la correcta

```
user_school_ids()        → CUALQUIER miembro activo, padres y atletas incluidos.  Solo LECTURA.
user_staff_school_ids()  → quien TRABAJA en la escuela (sin parent/athlete).      Escritura operativa.
user_admin_school_ids()  → administración (sin coaches).                          Lo que OTORGA permisos.
```

Regla: **si un permiso permite otorgar permisos, no se delega.** Invitar con rol admin es volverse admin.

Y `school_has_branding_feature()` (¿puede **editar** su marca? → por tier) es una pregunta distinta de `school_shows_own_brand()` (¿se le **muestra**? → por addon). Compartir un solo gate para las dos fue el origen de varios bugs.

### Cinco trampas que ya costaron caro

1. **Las policies son PERMISIVAS y se suman con `OR`.** Endurecer cuatro no sirve si queda una quinta abierta sobre la misma tabla. Al cerrar una tabla, listar **todas** sus policies: `select cmd, policyname, permissive, roles, qual, with_check from pg_policies where tablename = '…'`.
2. **`FOR ALL` sin `WITH CHECK`** usa el `USING` para validar los INSERT. Una policy `USING (email = auth.email())` sin `WITH CHECK` dejaba a cualquiera insertarse como staff de **cualquier** escuela.
3. **`REVOKE ALL … FROM PUBLIC` no alcanza:** los default privileges del esquema otorgan `EXECUTE` a `authenticated` en cada función nueva. Hay que revocar **explícitamente** de `authenticated` y `anon`.
4. **RLS filtra FILAS, no COLUMNAS.** Cuando una pantalla pública necesita parte de una tabla sensible, va una **vista** con las columnas publicables (`v_school_staff_publico`, `v_school_settings_publico`), no una policy.
5. **Una policy llamada `…_by_token` no compara ningún token.** En RLS no hay forma limpia de contrastar contra un valor de la query; esas policies terminan siendo `USING(true)`. Para eso va una RPC `SECURITY DEFINER` que reciba el token.

### El registro de migraciones NO dice qué está aplicado

Lo que se corre desde el **SQL editor** de Supabase cambia la base sin escribir en `schema_migrations`. Hay ~82 migraciones que figuran "sin registro" y en su mayoría **sí** están aplicadas.

```bash
npm run migrations:pendientes     # lista de candidatas a verificar, NO un veredicto
```

Para saber si algo está vivo, preguntarle al objeto:

```sql
select policyname, roles, qual, with_check from pg_policies where tablename = '…';
select prosrc, proacl, proconfig from pg_proc where proname = '…';
set local role anon; select count(*) from public.<tabla>;   -- la prueba definitiva
```

**Aplicar migraciones por una vía que deje rastro** (CLI de Supabase o `apply_migration`), no pegando SQL en el editor.

### Antes de aplicar un cambio de RLS: medir el radio

Un fix mal medido deja escuelas sin operar. Contar cuántas quedan sin nadie con el permiso, y cruzar con si esas escuelas tienen miembros activos — 303 escuelas sin admin resultaron tener 302 sin ningún miembro. Verificar simulando sesiones:

```sql
select set_config('request.jwt.claims', json_build_object('sub','<uuid>')::text, true);
select public.user_school_ids(), public.user_staff_school_ids(), public.user_admin_school_ids();
```

## Disk IO de la base — OBLIGATORIO (caída de ~14 h el 2026-10-14)

**Desde el 2026-10-14 Supabase es plan Pro** (se compró para trabajar con más holgura), pero **el plan de optimización sigue vigente**: Pro sube el techo, no lo quita, y la base sigue siendo **una sola** para dev, stg y prod. Si se agota el presupuesto de Disk IO, se cae TODO (login incluido; el navegador lo muestra como error de CORS, pero es un 504). Las reglas de abajo NO se relajan por el cambio de plan. Lo que más quema IO no son las consultas de la app sino **leer el catálogo** (814 funciones): cada lectura escribe archivos temporales.

- **Una sola sesión a la vez aplica migraciones.** Nunca aplicar migraciones (`apply_migration`, `db push`, SQL con DDL) desde agentes o sesiones en paralelo: cada DDL obliga a PostgREST a recargar todo el esquema.
- **Regenerar `types.ts` (`gen types` / `generate_typescript_types`) solo una vez, al final del lote de migraciones**, no después de cada una.
- **No usar `list_tables`, `get_advisors` ni el listado de funciones como sondeo.** Para un objeto puntual, consultar `pg_policies` / `pg_proc` filtrando por nombre.
- **Jobs del BFF que corren cada minuto: nada de N+1.** Leer el lote con `.in('id', ids)`, no una consulta por fila. Los tres BFF comparten la base, así que cada consulta por minuto se multiplica por tres.

## Cómo se entregan las features

- **Full-stack por feature:** DB + RLS + RPCs + BFF + API + Frontend + Auditoría + QA. No migraciones sueltas.
- **Módulos grandes por fases,** con revisión entre cada una (una rama por fase). Spec como fuente de verdad en `docs/specs/`, con las decisiones de producto resueltas dentro. **Plan antes de código en migraciones** (no escribir hasta aprobar el plan). Tests de concurrencia en la fase backend. Revisar policies de RLS línea por línea antes de aplicar.

## Ramas

- Se trabaja **solo en `develop`**. `develop`/`stg`/`main` están divergidos.
- **Nunca** mergear a `main` por iniciativa propia.

## Notas

- Este es el `CLAUDE.md` del repo (SportMaps). El `~/.claude/CLAUDE.md` global es de **otro contexto** (pipeline RCM/QA de Osigu) — no aplicarlo aquí.
- Specs de módulos en `docs/specs/`. Planes/roadmaps en `docs/`.
- **`docs/gotchas-tecnicos.md`** — trampas que ya costaron horas y no se deducen leyendo el código (una sola Supabase para todos los ambientes, `payments.status` es TEXT, los dos `vercel.json`, íconos PWA, `localStorage` entre usuarios…). Léelo antes de pelearte con algo que parece inexplicable.
- **`docs/auditoria-seguridad-2026-08-14.md`** — qué se encontró, qué se cerró y **qué queda pendiente**.
