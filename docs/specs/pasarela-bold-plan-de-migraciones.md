# Pasarela Bold — plan de migraciones (F2)

Estado: **A y B APLICADAS en la base viva el 2026-11-19** (aprobadas por el usuario), por `supabase db query --remote -f <archivo> --yes`, una a una por una sola sesión.
Archivos: `20261119145807_payment_provider_bold.sql` (A) y `20261119145819_payment_links_enlace_del_proveedor.sql` (B).
Verificado contra la base: enum = `wompi,mercadopago,bold`; `payment_links.provider_link_id` y `checkout_url` (text, nullable); índice `idx_payment_links_provider_link_id`; `anon` sin grants sobre `payment_links`; `seguridad:invariantes` sin críticas (las ALTA/MEDIA que salen son de otras tablas).
`types.ts`: edición mínima a mano (enum + 2 columnas), no regeneración completa (arrastraría 2 semanas de cambios ajenos).
Regla del repo: plan aprobado ANTES de escribir migraciones; policies y funciones se revisan línea por línea antes de aplicar.
Spec madre: `docs/specs/pasarela-bold-y-adaptador-de-proveedores.md` (§2.3). Depende de la F1 (ya en develop: `1a666c82`, `34c8df4e`).

## 1. Resumen: dos migraciones, nada más

| # | Slug | Qué hace | Riesgo |
|---|---|---|---|
| **A** | `payment_provider_bold` | `ALTER TYPE public.payment_provider ADD VALUE IF NOT EXISTS 'bold'` | Bajo. No se puede deshacer (Postgres no borra valores de enum). |
| **B** | `payment_links_enlace_del_proveedor` | `payment_links` gana `provider_link_id text` y `checkout_url text` + índice parcial por `provider_link_id` | Bajo. Aditiva, nullable, sin backfill. |

Todo lo demás que pide Bold **no necesita migración** (verificado contra `supabase/migrations/`):
- `payment_links`, `payments` y `payment_splits` ya tienen `payment_provider`, `provider_reference` y (menos `payment_links`) `provider_transaction_id`/`provider_fee`, desde `20260504000001_payment_provider_generic.sql`. Mercado Pago ya los usa; Bold hace lo mismo.
- `school_payment_providers` (una fila por escuela y pasarela, único `(school_id, provider)`) y `payment_provider_secrets` (cifrado AES-256-GCM, solo `service_role`) ya existen: la llave de identidad va en `access_token_enc` y la secreta en `events_secret_enc`. Sin columnas `bold_*`.
- `upsert_school_provider(p_provider public.payment_provider, …)` toma el enum: acepta `bold` solo con que A exista. No se toca la función.
- `webhook_events.provider` es texto libre: Bold entra sin migración.
- El índice único `idx_payment_links_provider_ref (payment_provider, provider_reference)` ya cubre a Bold.

## 2. Por qué A va SOLA

`ALTER TYPE … ADD VALUE` no puede usarse en la misma transacción que lo agrega (gate G-ENUM del repo). Mismo patrón que `20261014153533_rol_facility_manager.sql` («DEPLOY FIRST, standalone»). Se aplica primero, aparte, y B no la referencia: B solo agrega columnas de texto, así que podría ir junta o después sin problema.

### Migración A — borrador

```sql
-- 20261119XXXXXX_payment_provider_bold.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-19
-- Objetivo: Bold (API de Link de pagos) como pasarela. Spec: docs/specs/pasarela-bold-y-adaptador-de-proveedores.md
--
-- DEPLOY FIRST, standalone: ALTER TYPE ... ADD VALUE no puede usarse en la misma
-- transacción que lo agrega (gate G-ENUM). Nada en este lote lo referencia.
ALTER TYPE public.payment_provider ADD VALUE IF NOT EXISTS 'bold';
```

Sin funciones, sin policies, sin GRANT: no hay nada que revisar de seguridad.

## 3. Migración B — borrador

```sql
-- 20261119XXXXXX_payment_links_enlace_del_proveedor.sql
-- Objetivo: poder reabrir el link que la pasarela creó por API sin crear otro.
-- Hoy la URL de Wompi se firma al vuelo y no se guarda; la de Bold se crea con
-- POST /online/link/v1 (LNK_…) y hay que recordarla.
ALTER TABLE public.payment_links
    ADD COLUMN IF NOT EXISTS provider_link_id text,   -- LNK_… de Bold (nulo en Wompi/MP)
    ADD COLUMN IF NOT EXISTS checkout_url     text;   -- URL a la que va la familia (nulo en Wompi/MP)

COMMENT ON COLUMN public.payment_links.provider_link_id IS
  'Id del link creado en la pasarela por API (Bold: LNK_…). Nulo si la pasarela firma la URL al vuelo (Wompi).';
COMMENT ON COLUMN public.payment_links.checkout_url IS
  'URL de pago creada por la pasarela. Nulo si se firma al vuelo. Solo https.';

CREATE INDEX IF NOT EXISTS idx_payment_links_provider_link_id
    ON public.payment_links (payment_provider, provider_link_id)
    WHERE provider_link_id IS NOT NULL;
```

Decisiones de diseño:
- **Nullable y sin DEFAULT:** no reescribe la tabla ni toma lock largo (Postgres 15, `ADD COLUMN` nullable es instantáneo).
- **Índice parcial NO único:** el único ya está en `(payment_provider, provider_reference)`. El `LNK_` solo se usa para buscar (webhook que trae el `LNK_` en `metadata.reference`, hueco §1.1 del spec) y para consultar la API.
- **`checkout_url` con CHECK `https`:** NO se agrega. La validación va en el BFF (`esUrlDeLinkDePago` ya exige https) y un CHECK obliga a una migración más si Bold cambia de dominio. Se valida al escribir, no en la base.
- **Sin backfill:** los links de Wompi/MP quedan nulos a propósito.

## 4. Seguridad (revisar antes de aplicar)

1. **Quién lee `payment_links`.** Las columnas nuevas heredan los privilegios de la tabla. `checkout_url` es una URL de pago de un cobro concreto: no debe leerla `anon`. La migración `20260813133108_cerrar_fuga_de_payment_links_a_anon.sql` ya cerró eso; **antes de aplicar** se confirma con una consulta puntual (no con `list_tables`/`get_advisors`):
   ```sql
   select policyname, roles, cmd, qual from pg_policies where tablename = 'payment_links';
   set local role anon; select count(*) from public.payment_links;   -- debe dar 42501 o 0 filas
   ```
2. **Invariantes:** correr `npm run seguridad:invariantes` después de aplicar (I1–I4). No se agregan policies ni funciones, así que no debe cambiar nada; se corre igual porque es la fuente de verdad.
3. **Sin funciones nuevas** → no aplican `search_path` ni `GRANT EXECUTE` de esta fase.
4. **Llaves de Bold:** no se tocan en la base ni en migraciones. Entran por `PaymentProvidersAdmin` → `POST /payment-providers/school/:schoolId` → `upsert_school_provider` → `payment_provider_secrets` cifrado. Ningún secreto en `.sql`, en el repo ni en el chat.

## 5. Radio de impacto (Disk IO y PostgREST)

- Una sola base para dev, stg y prod, y **cada DDL recarga el esquema de PostgREST**. Por eso: **una sola sesión aplica A y B**, una detrás de otra, sin sesiones en paralelo haciendo DDL.
- `types.ts` se regenera **una sola vez**, después de B.
- Cero sondeos de catálogo (`list_tables`, `get_advisors`, listado de funciones).
- Efecto en escuelas existentes: ninguno. Ninguna columna existente cambia, ningún código lee las nuevas hasta la F3. El BFF actual ignora el valor `bold` y las columnas nuevas.
- Interacción con el código ya en `develop`: `webhook-events.service.ts`, `payment-providers.routes.ts` y compañía tienen la unión `PaymentProvider` fija en TypeScript. Con `bold` en el enum y `types.ts` regenerado puede aparecer algún error de tipos donde se hace `switch` exhaustivo: se resuelve en F2 (§6), no en la migración.

## 6. Qué entra en la F2 además de las migraciones (código, sin DDL)

1. Regenerar `types.ts` una vez.
2. `payment-provider.resolver`: aceptar `bold`; la rama Bold exige las dos llaves y rechaza llave de sandbox con `sandbox=false` (y a la inversa).
3. `payment-providers.routes.ts`: variante `bold` en la unión zod (llave de identidad + llave secreta + `sandbox`), con la validación de arriba.
4. `PaymentProvidersAdmin` (visible solo para admin de plataforma): formulario de 2 llaves para Bold.
5. Pruebas: resolver con y sin conexión Bold (fail-closed), esquema zod, llave de sandbox en producción.
6. Criterio de salida: se puede **guardar** una conexión Bold cifrada para Monster, **sin activarla** (`enabled=false`, `payment_mode` intacto), y el resolver la devuelve. Nada cambia para las otras escuelas.

## 7. Orden de ejecución

1. Revisión de este plan (tú).
2. Escribir A y B con `npm run migrations:new -- <slug>` (reserva versión y entra al ledger); commit del `.sql` + `supabase/migrations_ledger.json` en el mismo commit.
3. **Aplicar** A, luego B, por una vía con rastro (CLI de Supabase o `apply_migration`), **una sola sesión**. Hoy el usuario aplica migraciones de noche y `SUPABASE_DB_URL` ha faltado antes: se confirma que esté disponible antes de prometer fecha.
4. Verificar contra la base (no contra el repo):
   ```sql
   select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'payment_provider' order by enumsortorder;       -- wompi, mercadopago, bold
   select column_name, data_type from information_schema.columns
    where table_schema='public' and table_name='payment_links'
      and column_name in ('provider_link_id','checkout_url');           -- 2 filas, text
   ```
5. `npm run seguridad:invariantes`.
6. Regenerar `types.ts` y seguir con el código de §6.

## 8. Reversa

- **B:** `ALTER TABLE public.payment_links DROP COLUMN provider_link_id, DROP COLUMN checkout_url;` (y el índice cae con la columna). Se hace con una migración NUEVA (las migraciones son inmutables), y solo si no hay links de Bold creados.
- **A:** no tiene reversa limpia. Un valor de enum sin uso no estorba: ninguna fila lo usa hasta que se conecte Bold. Si se abandonara la pasarela, el valor queda como inerte.

## 9. Estado de aplicación de otras migraciones (contexto para no pisarse)

En el árbol hay migraciones de otras sesiones sin commitear (`20261119125220`, `…125234`, `…125245`, `…141319`, `…141857`) y una (`20261118163548`, lote 1 de RLS + Wompi) en el repo pero **sin aplicar** (falta `SUPABASE_DB_URL`). Las versiones de A y B las reserva `migrations:new` posteriores al head del ledger, así que no chocan; pero el orden de aplicación lo coordina una sola sesión.

## 10. Decisiones que pido

- **M1.** ¿Apruebas A y B como están (dos migraciones, sin CHECK de https, índice parcial no único)?
- **M2.** ¿Se aplican por CLI esta noche junto con las demás pendientes, o esperan a tener las llaves de prueba de Monster (F0)? Propuesta: aplicarlas ya; son aditivas y no dependen de las llaves.
