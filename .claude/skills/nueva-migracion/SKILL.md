---
name: nueva-migracion
description: Crear una migración de Supabase en SportMaps (tabla, columna, policy de RLS, función/RPC, índice, fix de esquema). Úsala SIEMPRE antes de escribir SQL en supabase/migrations/, aunque el pedido parezca chico ("agrega una columna", "arregla la policy", "crea la RPC"). Aplica la plantilla obligatoria (search_path, GRANT EXECUTE, policies envueltas, alcance del caller) y el flujo del ledger.
---

# Nueva migración — SportMaps

Fuente de verdad: `CLAUDE.md` («Convenciones de base de datos») y `docs/migrations-workflow.md`.
Esta skill es el orden de trabajo; si algo aquí contradice esos dos archivos, ganan ellos.

## 0. Antes de escribir

1. **Plan antes de código.** Para cualquier cambio de esquema o RLS, presentar el plan al usuario y
   esperar aprobación. Nada de escribir SQL «para adelantar».
2. ¿Ya existe? `npm run migrations:list -- --grep <tema>`. Si otra sesión lo está haciendo, se habla.
3. ¿Es creación multi-fila (padre + hijos)? Va en **una RPC transaccional** `SECURITY DEFINER`, no
   en inserts sueltos desde el frontend (precedente: `create_mesocycle_with_weeks`).

## 1. Crear el archivo (nunca a mano)

```bash
npm run migrations:new -- <slug_en_snake_case>
```

Reserva la versión en `supabase/migrations_ledger.json`. Las migraciones **commiteadas son
inmutables**: la guardia de `.claude/hooks` bloquea editarlas. Un fix va en otra migración nueva.

## 2. Lista de chequeo del SQL (cada punto, cada vez)

- [ ] **Estados/enums:** `text` + `CHECK`, nunca `CREATE TYPE`.
- [ ] **FKs de negocio** a `public.profiles(id)`, no a `auth.users`.
- [ ] **Toda `CREATE FUNCTION`:** `SET search_path = pg_catalog, public, pg_temp`.
- [ ] **RPC que llama el frontend:** `REVOKE ALL … FROM PUBLIC, anon;` + `GRANT EXECUTE … TO authenticated;`
      (desde `20261029101115` nacen sin EXECUTE; sin GRANT la pantalla da 42501/403).
- [ ] **`anon`:** solo con un flujo público demostrado (pantalla sin sesión que la llama).
- [ ] **Helper usado en una POLICY:** SÍ `GRANT EXECUTE … TO authenticated` (y `anon` si la policy lo alcanza).
- [ ] **Helper que solo llama otra `SECURITY DEFINER`:** `REVOKE ALL … FROM PUBLIC, anon, authenticated`, sin GRANT.
- [ ] **Alcance adentro:** si recibe un id de escuela/usuario, valida contra **ese** id
      (`user_admin_school_ids()`, `is_school_admin(id)`…). «¿Es admin de alguna escuela?» no es gate.
- [ ] **Función de alcance correcta:** lectura `user_school_ids()` · escritura operativa
      `user_staff_school_ids()` · lo que otorga permisos `user_admin_school_ids()`.
- [ ] **Policies envueltas:** `(SELECT auth.uid())` y `school_id = ANY ((SELECT public.f())::uuid[])`.
      Escape justificado: comentario `rls-lint: ok` dentro de la sentencia.
- [ ] **`TO authenticated`** si la policy no tiene sentido sin sesión.
- [ ] **`FOR ALL` siempre con `WITH CHECK`** (si no, los INSERT se validan con el USING).
- [ ] **Sin self-recursion:** una policy sobre X no hace `SELECT FROM X`.
- [ ] **Stock/contadores:** solo en RPC `SECURITY DEFINER` con `SELECT … FOR UPDATE`.
- [ ] **Datos públicos de tabla sensible:** vista con columnas publicables, no policy (RLS filtra filas, no columnas).

## 3. Revisión independiente

Para policies, grants o funciones `SECURITY DEFINER`, pedir al subagente **`revisor-rls`** que lea la
migración sin darle tu conclusión. Corregir lo que encuentre antes de seguir.

## 4. Cerrar

```bash
npm run migrations:check        # el mismo gate del pre-commit y CI
```

Commitear el `.sql` **y** `supabase/migrations_ledger.json` en el mismo commit.

**No aplicar** la migración desde el agente (`supabase db push`, SQL con DDL): la base es una sola
para dev, stg y prod y solo una sesión a la vez aplica DDL. Decirle al usuario que está lista, cómo
aplicarla con rastro, y qué verificar después:

```sql
select policyname, roles, qual, with_check from pg_policies where tablename = '…';
select prosrc, proacl, proconfig from pg_proc where proname = '…';
```

y `npm run seguridad:invariantes` tras aplicar cualquier cambio de RLS (ver skill `cerrar-rls`).
Regenerar `types.ts` **una sola vez** al final del lote, no por migración.
