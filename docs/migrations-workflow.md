# Migraciones — inventario, versionado y acuerdo entre quienes suben

Las migraciones se aplican **a mano** en Supabase y son **inmutables**. Con varias
personas (y varias sesiones de agentes) trabajando a la vez, los tres accidentes
típicos son: dos migraciones con el **mismo timestamp**, una migración **editada**
después de aplicada, y **dos personas escribiendo el mismo cambio** sin enterarse.

El registro `supabase/migrations_ledger.json` y el script `scripts/migrations.mjs`
existen para que esas tres cosas fallen *antes* del merge, no en producción.

---

## 1. Ver todas las migraciones

```bash
npm run migrations:list              # inventario completo (# · versión · alta · autor · estado)
npm run migrations:list -- --last 20 # solo las últimas 20
npm run migrations:list -- --grep pago
npm run migrations:list -- --dups    # solo las colisiones de versión
npm run migrations:list -- --json    # para scripts
```

Columna **ESTADO**:

| Estado | Significado |
|---|---|
| `registrada` | En el ledger y con el contenido intacto. Todo bien. |
| `sin registrar` | Existe el `.sql` pero nadie corrió `sync`. El commit se bloquea. |
| `sin sync` | Cambió un `.sql` que aún **no** está commiteado. Solo hay que re-sincronizar. |
| `EDITADA` | Cambió un `.sql` **ya commiteado** → se rompió la inmutabilidad. Error duro. |

Banderas: `dup` (comparte versión con otra), `legacy` (nombre viejo sin hora),
`sin commitear` (todavía no está en git).

---

## 2. Crear una migración

```bash
npm run migrations:new -- descuentos_por_hermano
```

Hace tres cosas en un paso: toma la **próxima versión libre** (siempre posterior al
head del ledger), crea `supabase/migrations/<versión>_descuentos_por_hermano.sql`
con la plantilla y los recordatorios de `CLAUDE.md`, y **reserva esa versión** en el
ledger.

Si prefieres crear el archivo a mano, pide la versión primero y registra después:

```bash
npm run migrations:next    # imprime la versión que te toca
# ... creas el archivo, escribes el SQL ...
npm run migrations:sync    # lo registra en el ledger
```

**Commitea siempre el `.sql` y `supabase/migrations_ledger.json` juntos, en el mismo
commit.**

### Funciones: GRANT explícito, porque nacen sin EXECUTE

Desde `20261029101115` toda función que crea `postgres` nace **sin `EXECUTE` para
nadie** salvo el dueño y `service_role` (default privileges: ni `PUBLIC`, ni `anon`, ni
`authenticated`). Si olvidas el `GRANT`, la pantalla que la llama da **42501 / 403**.
Reglas:

- **RPC que llama el frontend** → `GRANT EXECUTE … TO authenticated`, explícito.
- **`anon`** → solo si hay un flujo público demostrado (pantalla sin sesión).
- **Helper que usa una POLICY** (aparece en un `USING` o un `WITH CHECK`) → **SÍ**
  `GRANT EXECUTE … TO authenticated`, y también `TO anon` si la policy alcanza a `anon`
  sobre una tabla que `anon` lee. Las policies se evalúan con el rol de quien consulta:
  sin ese GRANT, **toda** consulta a la tabla da 42501.
- **Helper que solo llama otra función `SECURITY DEFINER`** → `REVOKE ALL … FROM PUBLIC,
  anon, authenticated` y sin `GRANT`: lo ejecuta el dueño de la función que lo llama.
- **Alcance adentro:** si recibe un id de escuela o de usuario, valida que el caller
  tenga relación con **ese** id (`user_*_school_ids()`, `is_school_admin(id)`…), no
  «que sea admin de alguna escuela».

```sql
CREATE OR REPLACE FUNCTION public.mi_rpc(p_school_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NOT (p_school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Sin permisos sobre esta escuela' USING ERRCODE = '42501';
    END IF;
    -- …
END;
$$;

REVOKE ALL ON FUNCTION public.mi_rpc(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_rpc(uuid) TO authenticated;
```

---

## 3. El acuerdo: cómo se evita el trabajo duplicado

Toda migración nueva **agrega una línea al final del ledger**. Eso es a propósito:

- Si dos ramas crean una migración a la vez, ambas tocan el final del mismo archivo
  → **git da conflicto al mergear**. No es una molestia, es la señal: hay dos
  migraciones nuevas y alguien tiene que mirar si hacen lo mismo.
- Resolver el conflicto es conversación, no `--theirs`: se abren los dos `.sql`, se
  decide si sobra uno, y quien llegó segundo **renumera la suya** con
  `npm run migrations:next` (que ahora ve el head del otro) y corre `sync`.
- El ledger dice **quién** creó cada migración y **cuándo**, así que antes de escribir
  un fix vale la pena un `npm run migrations:list -- --grep <tema>` para ver si ya
  existe y de quién es.

Regla práctica: **una migración nueva siempre va después del head del ledger.** Si
mientras trabajabas alguien mergeó una más nueva, tu versión queda "fuera de orden"
y el gate te obliga a renumerar — que es exactamente lo que hay que hacer cuando el
orden de aplicación importa.

---

## 4. El gate (`check`)

Corre solo en **pre-commit** (`.husky/pre-commit`) y en **CI** (`.github/workflows/ci.yml`):

```bash
npm run migrations:check
```

Falla si:

1. Una migración **commiteada** cambió de contenido → inmutabilidad rota.
2. Una migración **commiteada** desapareció o se renombró.
3. Dos migraciones nuevas comparten versión.
4. Una migración nueva tiene versión **anterior o igual** al head del ledger.
5. Hay un `.sql` sin registrar, o el ledger quedó desfasado → `npm run migrations:sync`.
6. El nombre no es `YYYYMMDDHHMMSS_slug_en_snake_case.sql`.

Casi siempre el arreglo es `npm run migrations:sync` o renumerar con
`npm run migrations:next`.

El pre-commit además rechaza el commit si estás subiendo un `.sql` de migración **sin**
`supabase/migrations_ledger.json` en el mismo commit: si el ledger llega un commit
después, deja de ser un registro confiable de qué versión iba con qué contenido.

---

## 5. Línea base (lo que ya existía)

El ledger se creó el 2026-07-30 sobre 290 migraciones. Todo lo anterior entró **tal
cual**, incluidas:

- **14 colisiones de versión históricas** (28 archivos marcados `dup`). Son inmutables
  y ya están aplicadas a mano: no se renombran. El gate las acepta y solo las reporta
  como advertencia.
- **1 nombre legacy** (`20260411_sportmaps_pay_epayco.sql`, sin hora), marcado `legacy`.

De ahí en adelante no se admite ninguna colisión nueva.

---

## 6. Notas

- El ledger **no** dice qué está aplicado en Supabase; dice qué existe en el repo y con
  qué contenido. La aplicación sigue siendo manual.
- El `sha256` se calcula normalizando saltos de línea a LF, así que Windows y Linux dan
  el mismo valor.
- No edites `supabase/migrations_ledger.json` a mano: lo genera el script.
