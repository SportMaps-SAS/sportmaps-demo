# Cobro de servicio unificado — capa de base (2026-11-11)

**Estado: escrita y revisada de sintaxis, NO aplicada.** Plan: `docs/specs/pago-manual-de-servicio.md` v0.2 §4 y §5.
Migración: `supabase/migrations/20261111114349_cobro_servicio_unificado.sql` (una sola; ya está en `supabase/migrations_ledger.json`).

## Por qué UNA sola sesión aplica

La base es **una sola** para dev, stg y prod y se cayó ~14 h el 2026-10-14 por Disk IO. Cada DDL obliga a PostgREST a
recargar todo el esquema (814 funciones). Esta migración hace ~20 DDL en una transacción; si dos sesiones aplican a la vez
(o se corre `gen types` entre medio) se multiplican las recargas. Reglas:

1. Una sesión, una vez. Nada de `apply_migration` en paralelo desde otros agentes.
2. `gen types` **una vez**, al final (paso 6), nunca por pasos.
3. Sin sondeos (`list_tables`, `get_advisors`): las verificaciones de abajo consultan objetos por nombre.
4. Aplicar por una vía que deje rastro (CLI de Supabase), no pegando en el SQL Editor.

## Orden de aplicación

| Paso | Qué | Qué verifica / por qué en este orden |
|---|---|---|
| 0 | `npm run migrations:check` y `git status` | Que el ledger esté sincronizado y que nadie más tenga una migración nueva (head = `20261111114349`). |
| 1 | Aplicar la migración (CLI) | Es una transacción: o entra toda o no entra nada. Dentro ya va el orden correcto: columnas del ítem → siembra → tablas → helpers → RPC → `wa_crear_cobro_desde_comprobante` (DROP de la firma vieja + CREATE nueva) → `wa_crear_cobro_suelto` → `auto_approve_payment`. |
| 2 | `pruebas-rollback.sql` | Sesión simulada (anon, coach, padre, admin de otra escuela → 42501), idempotencia, abono + saldo, sobrepago, precio por fecha (250.000 → 300.000; grupo 175.000 → 210.000), ligar sin cambiar `amount`, ambiguo, y `invariantes_seguridad()`. **Todo se deshace** (la transacción termina en un error con el reporte). Debe salir sin `FALLA`. |
| 3 | `npm run seguridad:invariantes` | La fuente de verdad es la base viva: 0 críticas, y que ninguna de las funciones/tablas nuevas aparezca (I4: todas llevan `search_path` fijo; I1: las tablas nuevas no tienen policies ni GRANT a anon/authenticated). |
| 4 | Verificaciones de objeto (abajo) | Confirman la sobrecarga eliminada, los ACL y la siembra. |
| 5 | BFF/frontend (otra sesión, después) | Consumen las RPC (contrato en el reporte). Hasta entonces nada llama a lo nuevo, salvo `wa_crear_cobro_desde_comprobante` (que mantiene los nombres de siempre). |
| 6 | `gen types` (una vez) | Para que `types.ts` conozca `cobros_servicio_item`, las columnas nuevas del ítem y las RPC. |
| 7 | `datos-pendientes.sql` | **Borradores**, de a un bloque, con el OK de la escuela. No son parte de la migración. |

### Verificaciones de objeto (solo lectura, por nombre — sin listar el catálogo)

```sql
-- Una sola firma de wa_crear_cobro_desde_comprobante, con p_user_id (esperado: 1 fila).
select pg_get_function_identity_arguments(oid) from pg_proc
 where proname = 'wa_crear_cobro_desde_comprobante' and pronamespace = 'public'::regnamespace;

-- ACL (esperado: anon nunca; authenticated solo en registrar/ligar/reclasificar; aplicar y wa_* solo service_role).
select proname, proacl::text from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('registrar_pago_servicio_manual','ligar_cobro_a_servicio','reclasificar_pago_servicio',
                   'aplicar_comprobante_a_cobro_abierto','wa_crear_cobro_desde_comprobante','wa_crear_cobro_suelto',
                   'auto_approve_payment','_servicio_precio_vigente','_servicio_cupos_vivos','_servicio_grupo_cumple',
                   '_servicio_es_afiliado','_servicio_cobros_del_dueno','_servicio_pago_ligado');

-- Siembra de la clínica (esperado: equipo30 / 16-nov=300000 / 2026-11-20).
select descuentos_grupo, precios_afiliado_por_fecha, saldo_hasta
  from school_tournament_items where id = '16766d2e-f8b0-4285-88e3-b1e67dda6d45';

-- Tablas nuevas: RLS activo y 0 policies (esperado: true, true, 0).
select c.relrowsecurity from pg_class c where c.relname in ('cobros_servicio_item','cobros_servicio_movimientos');
select count(*) from pg_policies where tablename in ('cobros_servicio_item','cobros_servicio_movimientos');

-- La prueba definitiva de la tabla cerrada (esperado: error 42501 permission denied).
begin; set local role anon; select count(*) from public.cobros_servicio_item; rollback;
```

## Qué trae la migración (resumen; el detalle está en el encabezado del `.sql`)

- **Ítem:** `descuentos_grupo`, `precios_afiliado_por_fecha`, `saldo_hasta` con sus CHECK (los de `descuentos_grupo` se
  probaron en la base viva con casos buenos y malos). Siembra **solo** la clínica de Monster.
- **Tablas:** `cobros_servicio_item` (enlace pago ↔ ítem; contrato pedido) y `cobros_servicio_movimientos` (rastro de cada
  pago/abono/saldo: idempotencia de abonos y de filas de la cola; **añadida** porque un abono no crea otra fila de enlace).
  RLS activo, sin policies, sin GRANT a anon/authenticated.
- **Internas** (`REVOKE ALL … FROM PUBLIC, anon, authenticated`, sin GRANT): `_servicio_precio_vigente`,
  `_servicio_cupos_vivos`, `_servicio_grupo_cumple`, más `_servicio_es_afiliado`, `_servicio_cobros_del_dueno`,
  `_servicio_pago_ligado`.
- **Escuela (authenticated, gate adentro):** `registrar_pago_servicio_manual`, `ligar_cobro_a_servicio`,
  `reclasificar_pago_servicio`.
- **BFF (service_role):** `aplicar_comprobante_a_cobro_abierto`; `wa_crear_cobro_desde_comprobante` (4.º dueño, vínculo vivo,
  precio por fecha de afiliado, «ya lo compró» y cupos por los helpers); `wa_crear_cobro_suelto` (cupos por el helper).
- **Guardas (plan §5):** `auto_approve_payment` solo activa inscripciones si la categoría es mensualidad y avisa a
  `COALESCE(parent_id, user_id)`.

## Reverso de la migración

No hay `DOWN` automático (las migraciones son inmutables: un arreglo va en una migración nueva). Si hubiera que retirarla
**antes de que el BFF o la app la usen**: una migración nueva que (1) restaure `wa_crear_cobro_desde_comprobante` a la firma de 13
parámetros y el cuerpo de `20261030123549`, `wa_crear_cobro_suelto` y `auto_approve_payment` a sus cuerpos de esa fecha,
(2) elimine las funciones nuevas y (3) `DROP TABLE cobros_servicio_movimientos, cobros_servicio_item`. Las columnas del ítem
se pueden dejar (son inertes). Los datos de `datos-pendientes.sql` tienen su propio reverso, bloque a bloque.

## Cosas a vigilar (decisiones tomadas dentro, para que las revise quien aprueba)

- **Mínimo del grupo:** los cobros pendientes/vencidos de la escuela vencen el 20-nov, no el 15; contarlos «solo si
  `due_date <= 15-nov`» los dejaría fuera. Se cuentan si `due_date <= corte` **o mientras hoy (Bogotá) <= corte**; el corte
  es el día anterior al primer cambio de precio de afiliado del ítem (15-nov). Pasado el 15-nov dejan de contar los pendientes.
- `_servicio_precio_vigente` usa la **primera** entrada de `descuentos_grupo` salvo que se le pida otra clave.
- `registrar_pago_servicio_manual` no exige que el ítem esté activo ni vigente (la escuela puede anotar un pago tardío);
  el bot sí lo exige (como antes).
- Cualquier admin de la escuela puede fijar precio acordado (decisión del dueño, plan §7.3): queda en el enlace con su motivo.

## Cosas que conviene saber

- **(a) El 30 % arranca LIGANDO.** `_servicio_grupo_cumple` solo cuenta cobros con `descuento_clave`, y esa clave la pone
  `ligar_cobro_a_servicio(…, 'equipo30')` sobre los cobros que la escuela ya creó; `registrar_pago_servicio_manual` solo la
  aplica cuando el grupo YA cumple (cuenta al nuevo: 4 ligados + 1). Y **el bot nunca aplica descuento de grupo**: un
  comprobante de $175.000 sin cobro previo da `monto_no_coincide` por diseño (se resuelve ligando el cobro y aplicando el comprobante
  con `aplicar_comprobante_a_cobro_abierto`).
- **(b) `ligar` no escribe en `payment_adjustments`:** el 30 % queda en `list_amount`/`discount_amount`/`discount_pct` del pago
  y en el enlace, pero no sale en el libro de descuentos. (Evita rotularlo como «descuento del alta»; si se quiere en el libro, es un cambio aparte.)
- **(c) FKs:** `cobros_servicio_item.item_id` es `ON DELETE RESTRICT` (no se borra un ítem con cobros ligados);
  `cobros_servicio_movimientos.payment_id` es `ON DELETE CASCADE` (al borrar un pago se va su rastro).
- **(d) Orden de aplicación — aplicar SOLO este archivo.** La base viva tiene `schema_migrations` hasta `20261107180500` y ~82
  migraciones aplicadas por SQL Editor sin registro. `20261111105120_whatsapp_marca_staff.sql` es de OTRA sesión y NO se aplica con esta.
  Usar `npx supabase db query --remote -f supabase/migrations/20261111114349_cobro_servicio_unificado.sql` (el archivo ya trae su
  BEGIN/COMMIT) o `apply_migration` de ESTA versión; **nunca `db push` a ciegas** (empujaría también las que no son de esta sesión).
- **(e) Pruebas que dependen de la fecha** (hoy ≤ 15-nov): D1 (afiliado 250.000 hasta el 15-nov), D13 (externo 350.000 desde el 11-nov)
  y E4/E5 (los cobros vencidos cuentan para el grupo solo hasta el 15-nov). Cada una lo dice en su nombre. Pasado el 16-nov
  fallarán a propósito: ajustar los montos esperados, no es un bug.
- **`aplicar_comprobante_a_cobro_abierto` deja `approved_by` NULL a propósito** (decisión consciente, igual que `auto_approve_payment`:
  lo aplicó el sistema, no una persona) y estampa `reconciliation_status = 'pendiente'`. Rechaza mensualidades (`categoria_no_permitida`),
  un `p_payment_id` que no sea del dueño recibido (`cobro_no_es_del_dueno`) y una referencia ya usada (`referencia_duplicada`,
  salvo `p_permitir_referencia_repetida`).
- **Orden de candados:** prospecto → ítem → pago (igual que `wa_crear_cobro_desde_comprobante`). `ligar` y `aplicar` no toman el
  prospecto, así que no cierran ciclo. Prueba manual de dos sesiones: bloque J0 de `pruebas-rollback.sql`.
- Los CHECK de fechas de `precios_afiliado_por_fecha` validan fecha real vía `_servicio_fechas_validas` (IMMUTABLE, con GRANT a
  authenticated/service_role porque la evalúa quien escribe el ítem). El CHECK viejo de `precios_por_fecha` NO se tocó (solo regex).
- **Vencimiento de los abonos:** un cobro que nace como ABONO (por el bot o por `registrar_pago_servicio_manual`) lleva
  `due_date = saldo_hasta` del ítem (si es posterior a hoy); `aplicar_comprobante_a_cobro_abierto` sube a `saldo_hasta` el
  `due_date` de un cobro que queda en partial (nunca baja uno más lejano). El pago completo conserva hoy y `ligar` no toca `due_date`.
  Sin `saldo_hasta` en el ítem, todo se comporta como antes. Pruebas J7 (dependen de la fecha: hoy < 20-nov).

## Seguimiento: `20261111151130_cobro_servicio_seguimiento.sql`

La primera migración ya está aplicada (inmutable). Las pruebas de rollback dieron 91 de 93; el seguimiento arregla las dos que fallaban
y suma un CHECK. Aplicar DESPUÉS de la primera, con el mismo cuidado (una sola sesión, `db query --remote -f`, nunca `db push` a ciegas):
- **J4:** `registrar_pago_servicio_manual` ignora `p_opcion` en ítems sin opciones (`jsonb_typeof(NULL)` anulaba el IF; ahora con COALESCE).
- **G3:** era un error de la función. Re-ligar un enlace anulado con el MISMO descuento ya estampado es ok y no re-estampa; otro descuento distinto sigue dando `ya_tiene_descuento` (prueba G4).
- **`whatsapp_audiencia.intereses`** admite además `vacacional` y `campamento` (las 3 pruebas J8); antes de reemplazar el CHECK se comprueba que ninguna fila viola la lista ampliada. Con esto el BFF puede encender `WA_AUDIENCIA_INTERES_PARTIDO=1`.
