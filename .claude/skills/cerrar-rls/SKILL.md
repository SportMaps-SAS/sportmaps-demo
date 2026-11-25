---
name: cerrar-rls
description: Cerrar, endurecer o auditar el acceso a una tabla o función de Supabase en SportMaps (RLS, policies, GRANT/REVOKE, «un usuario ve datos de otra escuela», 42501/403, «anon puede leer X»). Úsala antes de dar por cerrado cualquier cambio de RLS, policies o permisos, y cuando alguien reporte una fuga o un 403.
---

# Cerrar RLS — SportMaps

La fuente de verdad es **la base viva, nunca el repo**: que el fix esté commiteado no significa que
esté aplicado. Base de todo: `CLAUDE.md` § «Seguridad» y `docs/auditoria-seguridad-2026-08-14.md`.

## 1. Leer el estado real (consultas puntuales, nada de sondeos)

No usar `list_tables`, `get_advisors` ni listar todas las funciones: queman Disk IO (caída del
2026-10-14). Consultar el objeto por nombre:

```sql
select cmd, policyname, permissive, roles, qual, with_check
from pg_policies where tablename = '<tabla>';            -- TODAS: son permisivas y se suman con OR
select prosrc, proacl, proconfig from pg_proc where proname = '<funcion>';
```

## 2. Las cinco trampas (revisar una por una)

1. **Permisivas con OR:** endurecer 4 policies no sirve si queda una 5.ª abierta sobre la misma tabla.
2. **`FOR ALL` sin `WITH CHECK`:** el USING valida los INSERT.
3. **`REVOKE ALL … FROM PUBLIC` no alcanza:** revocar explícito de `authenticated` y `anon`.
4. **RLS filtra filas, no columnas:** lo público va por vista (`v_*_publico`).
5. **`…_by_token` en una policy no compara ningún token:** termina en `USING(true)`. Va RPC con token.

Y la regla de alcance: **si un permiso permite otorgar permisos, no se delega** (`user_admin_school_ids()`).
Nunca revocar helpers de RLS (`is_school_admin()`, `is_super_admin()`…) al rol que los usa en policies.

## 3. Medir el radio ANTES de aplicar

Un fix mal medido deja escuelas sin operar. Contar cuántas escuelas quedan sin nadie con el permiso y
cruzarlo con miembros activos (303 «sin admin» resultaron 302 sin ningún miembro). Simular sesiones:

```sql
select set_config('request.jwt.claims', json_build_object('sub','<uuid>')::text, true);
select public.user_school_ids(), public.user_staff_school_ids(), public.user_admin_school_ids();
set local role anon; select count(*) from public.<tabla>;   -- la prueba definitiva para anon
```

## 4. Escribir el cambio

Con la skill `nueva-migracion`, y revisión del subagente `revisor-rls`.

## 5. Después de aplicar (lo hace el usuario o la única sesión que aplica)

```bash
npm run seguridad:invariantes      # I1–I4; sale 1 si hay violaciones CRÍTICAS
npm run seguridad:rls-negativas    # pruebas negativas por rol
```

Repetir las consultas del paso 1 y dejar en el resumen: policies antes/después, resultado de
invariantes y escuelas afectadas. No reportar «cerrado» sin esa evidencia.
