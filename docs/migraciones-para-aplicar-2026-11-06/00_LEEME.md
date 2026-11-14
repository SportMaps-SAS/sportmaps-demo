# Migraciones para aplicar a mano — 2026-11-06

Partido en vivo de Carmel, Fase 1 (`docs/plan-partido-en-vivo-f1.md`) + encender el «No aplica» de Carmel.
**Nada de esto está aplicado.** Estos archivos son COPIAS de `supabase/migrations/` (la fuente de verdad, ya en el ledger).
Si hay que cambiar algo, se cambia en `supabase/migrations/`, se corre `npm run migrations:sync` y se vuelven a copiar.

## Orden de aplicación (una sola sesión, en este orden, nunca en paralelo)

| Orden | Archivo (copia) | Versión | Qué hace |
|---|---|---|---|
| 01 | `01_carmel_enciende_rubrica_na.sql` | 20261105231542 | `rubric_allow_na = true` solo en Carmel. Con guarda por columna; idempotente. |
| 02 | `02_partido_vivo_flag_agenda_y_dorsal.sql` | 20261105231554 | Flag `live_match_enabled` (false para todas), columna al final de `v_school_entitlements`, 4 columnas de agenda en `match_results`, `live_event_id` en `football_match_events`, CHECK del dorsal. |
| 03 | `03_partido_vivo_tablas_y_rls.sql` | 20261105231602 | 4 tablas (`match_live`, `_periods`, `_events`, `match_player_stints`), RLS solo SELECT staff, trigger de protección de `match_lineup_players`. |
| 04 | `04_partido_vivo_rpcs.sql` | 20261105231608 | 14 helpers `_live_*` (sin grant) + 9 RPC públicas. |
| 05 | `05_partido_vivo_bloqueo_roster_y_minutos_al_publicar.sql` | 20261105231617 | `save_match_roster` bloqueada con partido iniciado + `publish_match_report` copia los minutos al publicar. Termina con `NOTIFY pgrst`. |

Reglas: una sola sesión aplica (cada DDL recarga el esquema de PostgREST: Disk IO). No regenerar `types.ts` hasta que la 05 esté aplicada y verificada (una sola vez, al final). Cada archivo es `BEGIN … COMMIT` con `lock_timeout = 3s`: si falla por bloqueo, se reintenta. Las migraciones sin commitear de otras sesiones (`…212701`, `…213545`, `…213600`, `…222237`, `…225148`) se aplican antes o después de este bloque, no intercaladas.

## Antes de aplicar (las dos migraciones que copian código vivo)

Las definiciones se extrajeron de la base viva el 2026-11-05. Antes de la 02 y la 05, confirma que no cambiaron (lectura):

```sql
select md5(pg_get_viewdef('public.v_school_entitlements'::regclass, true));   -- esperado 4afc09d16defdab52217ef4680f84e88
select proname, md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace
  and proname in ('save_match_roster','publish_match_report');                 -- esperado 311140a4e6c7c7b47b5e8ed75dcf191b / 3d47c540a6237eb3bb0093dc4ad2ae88
```

Si algún hash difiere: PARAR, re-extraer con `pg_get_viewdef` / `pg_get_functiondef` y regenerar esa migración (la 02 ya aborta sola si la vista cambió de última columna).
Dato de hoy: `rubric_allow_na` de Carmel ya figura en `true` en la base viva, así que la 01 puede salir con 0 filas cambiadas: es lo esperado (idempotente).

## Qué verificar tras CADA una

Corre `verificacion.sql` (solo lectura) completo; las filas con `ok = false` ordenan primero. Hasta aplicar todo es normal que fallen las de las migraciones pendientes. Tras cada paso, lo que debe estar en `true`:

- **01**: bloque `01 rubric_allow_na` (Carmel = true; solo 1 escuela encendida).
- **02**: bloque `02 *`. Clave: `escuelas con live_match_enabled = true` = **0** (el flag NO se enciende en ninguna escuela, ni Carmel), la vista termina en `live_match_enabled`, conserva `security_invoker`, y los 55 partidos existentes quedan sin datos de agenda.
- **03**: bloques `03 *`: 4 tablas, RLS activa, exactamente 4 policies (todas SELECT, authenticated), `anon` sin privilegios, `authenticated` solo SELECT, trigger presente, 0 filas en `match_live`.
- **04**: bloque `04 *`: 9 RPC (authenticated sí, anon no, PUBLIC no) y 15 helpers sin EXECUTE para nadie, todos con `search_path` fijo.
- **05**: bloque `05 *`: `save_match_roster` contiene `LIVE_STARTED`, `publish_match_report` contiene el hook, ACL intacta (authenticated sí, anon no).

Al final: segundo bloque de `verificacion.sql` (`invariantes_seguridad()`, equivale a `npm run seguridad:invariantes`) sin críticas, y luego `pruebas-sesion.sql` (T1–T18).
`pruebas-sesion.sql` corre en UNA transacción y termina con una excepción a propósito que trae el reporte y deshace todo (prende el flag solo dentro de esa transacción). El reporte debe decir `N pruebas: N OK, 0 FALLAN`.

## Decisión D-P1 = A (ajustada) — cómo quedaron los minutos

- Los minutos se registran EN VIVO en los tramos (`match_player_stints`) con cada salida/ingreso (formato por partido, p. ej. 3×15′; reingresos sin tope).
- Staff y administración los ven desde que se registran, en vivo y al terminar, por `match_live_report(p_match)` (minutos, segundos y % por jugador, tramos, goles, cambios por tiempo). `finish_live_match` cierra los tramos abiertos y deja todo consultable.
- `finish_live_match` **NO** escribe `match_lineup_players.minutes_played`.
- Solo al **PUBLICAR** el informe (`publish_match_report(p_match, true)`) de un partido en vivo terminado se copian los minutos a `minutes_played` (lo que leen las pantallas del acudiente). Al despublicar (`false`) vuelven a NULL. Si el partido se reabre y se termina otra vez con el informe ya publicado, `finish_live_match` actualiza `minutes_played` para que no quede viejo.

**NOTA PARA LA F2 (frontend; no se hace ahora):** el paso **Evaluar** y el **informe/PDF** deben leer los minutos de `match_live_report` y NO de `minutes_played`. Hoy esa columna queda NULL hasta publicar, así que si Evaluar la lee verá vacío.

## Cambios frente al plan (para que no sorprendan)

- La migración 02 **no** enciende Carmel (el plan hacía `UPDATE … live_match_enabled = true` con assert). Pedido: el flag queda en false en todas hasta que el frontend esté listo. Para encenderlo después: `update school_settings set live_match_enabled = true where school_id = '374a6716-af42-4745-afe1-8d089153e01b';` (1 fila; es una migración aparte, nueva).
- El gancho de publicación va en la 05 junto con `save_match_roster` (ambas son funciones globales; por eso van al final). El helper `_live_write_minutes` nace en la 04.
- `match_live_report` y `_live_state_json` son VOLATILE (el plan decía STABLE): releen lo escrito en la misma transacción.
- `clock_adjust` no se puede anular (se corrige con otro `clock_adjust`). Tampoco `callup`, `match_end`, `match_reopen`.
- `match_live_finished_chk` se simplificó a «finished implica finished_at» (R-10 del plan).
- Cinturón `FUTURE_EVENT`: el cliente debe mandar `client_at` en el `period_start` (sin él, el ancla es la hora del servidor y un lote con eventos de más de 120 s sobre un tiempo recién abierto se rechaza).

## Riesgos que ves al aplicar

1. `save_match_roster` y `publish_match_report` son funciones usadas por TODAS las escuelas: por eso van al final y con el cuerpo vivo copiado textual. Sin fila en `match_live` el chequeo nuevo es una búsqueda por PK que no devuelve nada.
2. El trigger de `match_lineup_players` (03) roza convocatorias de todas las escuelas (2 búsquedas por PK solo en DELETE y UPDATE de role/subject). Inerte sin `match_live`. Quitarlo: `DROP TRIGGER trg_live_guard_lineup_players ON public.match_lineup_players;`.
3. La 02 hace `CREATE OR REPLACE VIEW v_school_entitlements` (vista caliente, la lee todo el frontend): `lock_timeout = 3s`, aplicar en hora valle; verificar `reloptions` y que el total de filas de la vista no cambió.
4. Aplicar por el SQL Editor no escribe en `schema_migrations`: `npm run migrations:pendientes` las listará como «sin registro» aunque estén vivas. El ledger del repo (`supabase/migrations_ledger.json`) sí las tiene.
5. Reversa normal: apagar el flag (no hace falta tocar nada más). Reversa completa: plan §11, en una migración NUEVA.

## 06 — Correcciones de la revisión independiente (20261105234602)

Archivo: `06_correcciones_revision.sql`. Aplicar DESPUÉS de la 05 (las funciones corregidas ya existen con la 03/04/05 aplicadas). Los cuerpos son los vivos del 2026-11-05 con un cambio mínimo; el trigger no se toca.

1. **ALTO** `_live_guard_lineup_players`: en UPDATE devolvía OLD y descartaba en silencio el cambio de `role/subject_id/subject_type` en `match_lineup_players` (todas las escuelas). Ahora devuelve NEW salvo DELETE.
2. **MEDIO** `publish_match_report`: `PERFORM 1 FROM match_live … FOR SHARE` antes del UPDATE de `match_reports` (mismo orden de bloqueos que `finish_live_match`; evita deadlock).
3. **MEDIO** `start_live_match`: `pg_advisory_xact_lock(hashtextextended(p_match::text,0))` tras el gate; dos inicios simultáneos ya no dan 23505 en `match_live_pkey`.
4. **BAJO** `apply_live_events`: el duplicado por `client_event_id` compara también `subject_id`, `period_second` y `period_no`; si difiere, `CLIENT_EVENT_ID_REUSED` (código ya existente).
- NO incluye (decisión de producto pendiente): minutos manuales al despublicar.
- Aviso: el trigger de la 03 es el que ya estaba vivo sin esta corrección: hasta aplicar la 06, un UPDATE de rol/sujeto en convocatorias no surte efecto.

Verificar tras aplicarla (solo lectura):

```sql
select proname,
       prosrc like '%CASE WHEN TG_OP = ''DELETE'' THEN OLD ELSE NEW END%' and prosrc not like '%COALESCE(OLD, NEW)%' as guard_ok
  from pg_proc where pronamespace='public'::regnamespace and proname='_live_guard_lineup_players';   -- true
select proname,
       prosrc like '%FROM public.match_live WHERE match_id = p_match FOR SHARE%' as for_share_ok
  from pg_proc where pronamespace='public'::regnamespace and proname='publish_match_report';          -- true (y conserva _live_write_minutes)
select proname,
       prosrc like '%pg_advisory_xact_lock(hashtextextended(p_match::text, 0))%' as advisory_ok
  from pg_proc where pronamespace='public'::regnamespace and proname='start_live_match';              -- true
select proname,
       prosrc like '%v_old.period_second IS DISTINCT FROM v_sec%' and prosrc like '%v_old.subject_id IS DISTINCT FROM v_sid%' as idem_ok
  from pg_proc where pronamespace='public'::regnamespace and proname='apply_live_events';             -- true
-- ACL: debe ser idéntica a la de antes
select proname, proacl::text, prosecdef, provolatile, proconfig::text from pg_proc
 where pronamespace='public'::regnamespace
   and proname in ('_live_guard_lineup_players','publish_match_report','start_live_match','apply_live_events') order by 1;
-- esperado: guard {postgres=X/postgres,service_role=X/postgres}; las otras 3 {postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres};
-- todas prosecdef=t, provolatile=v, proconfig {search_path=pg_catalog, public, pg_temp}
```
Luego `pruebas-sesion.sql` otra vez (debe seguir en `N OK, 0 FALLAN`).

## 07 — Origen de los minutos (20261105235829)

Archivo: `07_origen_de_minutos.sql`. Aplicar DESPUÉS de la 06. Decisión del usuario: «guardamos cada minuto».

- `match_lineup_players.minutes_source text` CHECK (`manual`,`live`), NULL = sin dato / histórico. `ADD COLUMN` nullable sin DEFAULT: solo catálogo, no reescribe la tabla (PG15). Medido el 2026-11-05: 296 filas, 5 escuelas, 18 con `minutes_played`, 0 partidos en vivo.
- Trigger `trg_lineup_minutes_source_mark` (BEFORE UPDATE OF `minutes_played`): si el valor cambia, marca `manual` (si lo dejan en NULL, source NULL). Mismo valor = no marca. Las otras escuelas no ven ningún cambio: el valor se guarda tal cual, solo se anota el origen. Convive con `trg_live_guard_lineup_players` (no se toca; su rama «role/subject sin cambio» devuelve NEW).
- Por qué marca de sesión (`set_config('app.live_minutes_write','1',true)`) y no `pg_trigger_depth()`: el UPDATE que hace `_live_write_minutes` desde la RPC corre a profundidad 1, igual que un UPDATE directo del cliente; depth no los distingue. La marca es local a la transacción, la prende y apaga `_live_write_minutes`, y el cliente (PostgREST) no puede fijarla (no expone `set_config`).
- `_live_write_minutes(true)` escribe los tramos solo donde `minutes_played IS NULL` o `source='live'` y marca `live`. `(false)` pone NULL solo donde `source='live'`. Los `manual` y los históricos con minutos se respetan.
- `_live_report_data` (lo devuelve `match_live_report`, que no se redefine) agrega por jugador `minutes_live`, `minutes_published`, `minutes_source`. `minutes` queda igual. El cálculo de tramos (`match_player_stints`) nunca se toca: siempre queda disponible.
- **Backfill: ninguno.** Las 18 filas con minutos quedan con source NULL y se tratan como manuales al publicar (no se pisan): no hay forma de saber de dónde vinieron, y marcarlas `live` permitiría que despublicar las borre. Cuerpos extraídos vivos (solo lectura) el 2026-11-05; ACL vivas: postgres+service_role en las dos funciones (no cambian).

Verificar tras aplicarla (solo lectura):

```sql
select column_name, data_type, is_nullable, column_default from information_schema.columns
 where table_schema='public' and table_name='match_lineup_players' and column_name='minutes_source';  -- text, YES, null
select conname, pg_get_constraintdef(oid) from pg_constraint where conname='match_lineup_players_minutes_source_check';
select tgname, tgenabled from pg_trigger where tgrelid='public.match_lineup_players'::regclass and not tgisinternal order by 1;
-- esperado: trg_lineup_minutes_source_mark (O) y trg_live_guard_lineup_players (O)
select count(*) total, count(minutes_played) con_minutos, count(minutes_source) con_origen from public.match_lineup_players;  -- con_origen = 0
select proname, proacl::text, prosecdef, proconfig::text,
       prosrc like '%app.live_minutes_write%' as marca_ok
  from pg_proc where pronamespace='public'::regnamespace
   and proname in ('_live_write_minutes','_live_report_data','_lineup_minutes_source_mark') order by 1;
-- ACL: las dos _live_* {postgres=X/postgres,service_role=X/postgres}; la del trigger sin EXECUTE para anon/authenticated
select prosrc like '%minutes_published%' and prosrc like '%minutes_live%' as report_ok
  from pg_proc where pronamespace='public'::regnamespace and proname='_live_report_data';                  -- true
```
Luego `pruebas-sesion.sql` (incluye T-minutos: manual no se pisa al publicar, despublicar solo limpia `live`, edición manual marca `manual`, otras escuelas sin cambio visible). Debe seguir en `N OK, 0 FALLAN`.
Reversa: nueva migración que restaure los cuerpos de `_live_write_minutes`/`_live_report_data` de la 04 y haga `DROP TRIGGER`; la columna puede quedarse (inerte).

## 08 — Agenda: create_match y update_match con formato del partido (20261106001001)

Archivo: `08_agenda_create_update_match.sql`. Aplicar DESPUÉS de la 07 (precondición dura: la 02, con las 4 columnas y el flag; la guarda lo verifica). Solo cambia cuerpos de función, sin DDL de tablas.

- `create_match(jsonb)` y `update_match(uuid, jsonb)`: cuerpo VIVO (pg_get_functiondef 2026-11-06; última definición 20260926131340, sin versiones posteriores) más lectura de `live_periods_count`, `live_period_minutes`, `match_kind`, `referee_name` **solo si la clave viene en `p`**. Sin la clave: update conserva, create deja el DEFAULT. CalendarPage y las demás escuelas no cambian.
- Validación adentro, 22023: tiempos 1–4, minutos 5–60 enteros, match_kind `official|practice` (null/vacío = `official`), árbitro <=120 tras `btrim` (vacío = NULL).
- Si viene cualquiera de las 4 claves y `school_settings.live_match_enabled` de la escuela del partido no está encendido: `P0001`, HINT `LIVE_DISABLED` (mismo contrato que `_live_raise`, inlineado para no depender de la 04).
- Firma, retorno, SECURITY DEFINER, search_path y gate de alcance (`user_staff_school_ids()` / `is_platform_admin()`) idénticos. ACL viva `{postgres,service_role,authenticated}`; la migración repite REVOKE PUBLIC/anon + GRANT authenticated, service_role (queda igual).
- Reversa: nueva migración con los cuerpos de 20260926131340.

Verificar tras aplicarla (solo lectura):

```sql
select proname, proacl::text, prosecdef, proconfig::text,
       prosrc like '%live_periods_count%' and prosrc like '%live_period_minutes%'
         and prosrc like '%match_kind%' and prosrc like '%referee_name%' and prosrc like '%LIVE_DISABLED%' as claves_ok
  from pg_proc where pronamespace='public'::regnamespace and proname in ('create_match','update_match') order by 1;
-- esperado: ACL {postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres} en las dos (igual que antes);
-- prosecdef=t; proconfig {"search_path=pg_catalog, public, pg_temp"}; claves_ok = true
```
Luego `pruebas-sesion.sql` (incluye T-agenda: sin claves = igual; con claves y flag apagado = `LIVE_DISABLED`; con claves y flag encendido guarda; update sin claves conserva; rangos 22023). Debe seguir en `N OK, 0 FALLAN`.
