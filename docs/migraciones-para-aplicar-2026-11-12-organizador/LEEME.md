# Organizador como entidad propia: aplicar

Una sola migración: `supabase/migrations/20261112114054_organizador_entidad_propia.sql`.
`aplicar.sql` es la misma más el rastro en `schema_migrations`.

**Ya probada el 2026-11-12** en una transacción que se revirtió sola (smoke:
`supabase/migrations/_smoke/organizador_entidad_propia_smoke.sql`): registro, RPC, entidad,
plan Gratis, `has_tournaments=t`, `has_academy=f` y los 5 negativos (atleta, nombre corto,
logo http, helper sin EXECUTE, anon sin EXECUTE) dieron OK.

## Aplicar (una sola sesión; Disk IO)
```
npx supabase db query --remote --yes -f docs/migraciones-para-aplicar-2026-11-12-organizador/aplicar.sql
```
Es una transacción (BEGIN/COMMIT): si algo falla, no queda nada.

## Verificar
```
npx supabase db query --remote --read-only -c "select proname from pg_proc where proname in ('create_organizer_org','_create_organizer_org')"
```
Deben salir las dos funciones.

## Después
- Regenerar `types.ts` UNA vez (la RPC nueva `create_organizer_org`).
- NO aplicar acá `20261112122901_estado_cuenta_enlaces.sql`: es de otra sesión.
- Probar: `/register?role=organizer` con una cuenta de prueba.
