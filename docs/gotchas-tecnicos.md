# Trampas técnicas de este repo

Cosas que ya costaron horas y que no se deducen leyendo el código. Las
**reglas obligatorias** están en `CLAUDE.md`; esto es el mapa de minas.

Deliberadamente **sin** datos de clientes, montos, credenciales ni nombres de
escuelas: eso vive en otro lado y no corresponde versionarlo.

---

## Base de datos

### Una sola Supabase para todo

`dev`, `staging` y producción apuntan a **la misma base**. No hay sandbox.

Escribir con la service key toca datos reales. Un script "de prueba" corre
contra producción. Tenerlo presente antes de cualquier `UPDATE` masivo.

### `payments.status` es `TEXT`, no el enum

Existe un tipo `pay_status`, pero la columna **no** lo usa. Castear a
`::pay_status` dentro de un `CASE` rompe. Usar literales pelados.

Es el motivo por el que la convención del repo es `text + CHECK` en tablas
nuevas y **no** `CREATE TYPE`.

### `enrollments.status` también es `TEXT`

Y **no** existe el valor `pending_payment` que a veces se asume. Además hay un
constraint XOR entre `user_id` y `child_id`: una inscripción es de un adulto o
de un menor, nunca de los dos.

### El catálogo de roles usa `school_admin`, no `admin`

`public.roles` no contiene `admin`. Pero `profiles.role` sí tiene perfiles con
ese valor, y `school_members.role` lo usa legítimamente para "admin **de esa
escuela**".

Son dos cosas distintas y confundirlas abre rutas de plataforma a gente de una
escuela. Al mapear roles, **nunca degradar a `athlete`** por defecto.

### Dos tablas de planes que no son lo mismo

| Tabla | Qué es |
|---|---|
| `school_subscriptions` | Lo que la escuela le paga **a SportMaps** |
| `subscription_plans` | **Deprecada** para escuela→familias desde 2026-08 (commits `f300860a`, `c6a024c0`). Sigue viva solo para `vendor_profiles` (trainers/wellness/stores), vía la policy `sub_plans_owner` |

`offering_plans` es la que el producto lee de verdad para las cuotas de
escuela — escribir solo en `subscription_plans` hace que el plan no aparezca
en ningún lado. `COMMENT ON TABLE` actualizado en la migración
`20260829011715`, verificado en vivo el 2026-08-29 (comentario anterior
estaba en `NULL`, no reflejaba la migración de mayo que se supone lo ponía).

### `apply_migration` (MCP) nunca usa el timestamp del archivo — siempre pone "ahora"

La herramienta MCP `apply_migration` de Supabase genera su propia versión en
`supabase_migrations.schema_migrations` al momento de correr, sin importar qué
timestamp lleve el nombre del `.sql` del repo o el comentario dentro del
archivo. Aplicar el archivo `20260821112428_algo.sql` puede terminar
registrado como `20260821130357` — versión distinta, mismo DDL. Confirmado en
vivo: pasó dos veces en la misma tarde, una vez con dos sesiones corriendo el
mismo cambio en paralelo, y otra conmigo mismo aplicando un archivo ya
reservado en el ledger.

Consecuencia práctica: si el DDL ya se aplicó una vez (por otra sesión, o por
vos mismo con otro nombre), reintentar `apply_migration` con el archivo del
repo **truena** — `column/relation already exists` — porque Postgres no sabe
nada de nombres de archivo, solo del objeto que ya existe. No es un bug que
arreglar; el esquema ya quedó en el estado correcto. Antes de reintentar algo
que "debería estar pendiente", confirmar contra la base (`to_regclass`,
`information_schema.columns`, o `select version, name from
supabase_migrations.schema_migrations order by version desc limit 10`) en vez
de asumir por el ledger del repo.

Mismo problema con cambios de **datos** (un `INSERT`/`UPDATE` puntual) corridos
vía `apply_migration`: quedan en `schema_migrations` con nombre y versión
propios, sin ningún `.sql` que los respalde en `supabase/migrations/` si nadie
commitea el archivo correspondiente. `npm run migrations:check` no lo detecta
— solo valida los archivos que SÍ están en el repo. El repo y
`schema_migrations` son dos historias que hay que cruzar a mano cuando algo no
cuadra, nunca asumir que una implica la otra.

### `execute_sql` (MCP) devuelve solo el resultado de la ÚLTIMA sentencia

Si mandas varias sentencias en una sola llamada (`select …; select …;`), la respuesta trae
únicamente las filas de la última. Las anteriores corren pero no se ven: una verificación con
tres `select` en un solo `execute_sql` parece "vacía" o "bien" sin serlo. Una consulta por
llamada, o unir los resultados con `union all` / un solo `select` con subconsultas.

### `school_athletes.enrollment_id` era `NULL` para atletas de plan sin equipo

La vista trae `enrollment_id` del lateral `te` (inscripción **con equipo**, `team_id IS NOT NULL`)
— el lateral `pe` (inscripción **con plan**) nunca seleccionaba `e.id`. Cualquier atleta inscrito
solo en un plan, sin equipo (el caso normal en escuelas tipo academia, no una rareza), tenía
`plan_name` correcto pero `enrollment_id` en `NULL`. Corregido 2026-08-27 con
`COALESCE(te.enrollment_id, pe.enrollment_id)` en las 3 ramas del `UNION ALL`
(`20260827144226_fix_school_athletes_enrollment_id_plan_only.sql`). Si algo lee
`school_athletes.enrollment_id` y sale `NULL` para un atleta que sí tiene plan activo, ya no
debería pasar — pero si aparece de nuevo, es la misma clase de bug.

### El monto que paga un atleta tiene precedencia

```
enrollments.monthly_fee  →  offering_plans.price  →  teams.price_monthly
```

Cualquier lector que se salte ese orden muestra un número distinto al que se
cobra.

### `payment_type` no es fiable

Una mensualidad pagada puede venir marcada como `one_time`. Para deduplicar o
clasificar, mirar el **concepto**, no ese campo.

### Borrar un usuario: referencias escondidas

Hay FKs que no se ven venir: `school_staff.coach_auth_id` y
`storage.objects.owner`. Borrar `profiles` a mano **antes** que el resto.

---

## RLS y permisos

Las reglas están en `CLAUDE.md`. Acá van las de **rendimiento**, que son otra
clase de problema:

### Los helpers sin envolver se ejecutan por fila

Una función `STABLE` pelada en el `USING` de una policy se evalúa **una vez por
fila**. Envolverla en `(SELECT fn())` hace que Postgres la evalúe una sola vez.

Al medirlo, **0 de ~74 sitios** lo hacían. En tablas grandes eso multiplica el
costo por el número de filas.

### `ALTER POLICY` no evita el lock

Cambiar una policy toma `ACCESS EXCLUSIVE` sobre la tabla igual que
`DROP + CREATE`. En una tabla caliente, planificarlo.

### Vistas con `LATERAL` no se pueden podar

`school_athletes` es una vista con 12 `LATERAL`. El planner no puede empujar
los filtros hacia adentro, así que cualquier consulta materializa mucho más de
lo que necesita.

---

## Migraciones

### El registro no dice qué está aplicado

Lo que se corre desde el **SQL editor** de Supabase cambia la base sin escribir
en `schema_migrations`. Hay decenas de migraciones que figuran "sin registro" y
sí están aplicadas.

Para saber qué está vivo, preguntarle al objeto (`pg_policies`, `pg_proc`), no
al repo. Ver `CLAUDE.md`.

### La cadena ya no reproduce la base

Hay cientos de objetos que la base tiene y el repo no crea. Correr las
migraciones desde cero **no** produce el esquema actual.

```bash
npm run migrations:drift    # mide la deriva
```

Consecuencia práctica: no asumir que un objeto existe porque hay una migración
que lo crea, ni que no existe porque no la hay.

### `DROP CONSTRAINT IF EXISTS` + `ADD` no es re-ejecutable

El `IF EXISTS` protege del caso "no está". **No** protege del caso "está y otro
objeto depende de ella", que es el que aparece al re-correr una migración ya
aplicada:

```
ERROR: cannot drop constraint uq_… because other objects depend on it
DETAIL: constraint fk_… on table … depends on index uq_…
HINT: Use DROP ... CASCADE
```

Pasó el 2026-09-09 con `20260909215933`: crea un `UNIQUE (id, school_id)` en
`school_whatsapp_integrations` y después una tabla cuya FK compuesta apunta a
ese único. En base limpia corre; en base ya migrada, la tabla que ella misma
creó le bloquea su primera sentencia.

**No aceptar el `HINT` de Postgres.** El `CASCADE` se lleva la FK dependiente y
te deja la tabla funcionando *sin* la garantía que esa FK daba — en ese caso,
que el `school_id` desnormalizado no pueda apuntar a otra escuela. Falla
silenciosa y difícil de detectar después.

Para una constraint que va a ser destino de una FK, la forma re-ejecutable es
agregar solo si falta:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_…') THEN
    ALTER TABLE … ADD CONSTRAINT uq_… UNIQUE (…);
  END IF;
END $$;
```

Y el error, cuando aparece, casi siempre significa **que la migración ya está
aplicada** y alguien la está corriendo de nuevo — no que haya algo roto.

---

## Frontend

### Hay DOS `vercel.json` y gana el de la raíz

`frontend/vercel.json` es **código muerto**: Vercel usa el de la raíz del repo
(el que tiene `cd frontend && npm run build`).

Diagnóstico rápido cuando un rewrite no funciona:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" <url>
```

Si un rewrite hacia un destino externo devuelve `200 text/html`, **no es que el
destino falle**: el rewrite no matcheó y cayó al catch-all del SPA. El
content-type distingue los dos casos al instante.

### Los archivos de `public/` ganan sobre los rewrites

Si existe `public/algo.json`, ningún rewrite hacia `/algo.json` se aplica jamás.

### `vercel.json` valida esquema estricto

Una clave desconocida —por ejemplo `comment` dentro de un rewrite— rompe el
build. JSON no admite comentarios y Vercel no perdona.

### Los íconos del PWA tienen que ser PNG de verdad

Hubo un caso en que `favicon.png` y `sportmaps-logo.png` eran **JPEG con
extensión `.png`**. Chrome los rechaza como íconos inválidos, la app deja de
cumplir los criterios de instalabilidad y `beforeinstallprompt` **nunca se
dispara**: el banner de instalar desaparece sin ningún error visible.

Si el banner no aparece, sospechar del formato real de los íconos antes que del
código.

### El service worker puede entrar en bucle de recarga

Registrar el SW dos veces sobre el mismo scope con tipos distintos (clásico y
módulo) produce `controllerchange` en bucle. Por eso `injectRegister: null` en
`vite.config.ts` y el registro manual en `src/pwa/register.ts`.

### `localStorage` es del dispositivo, no del usuario

Sobrevive al cierre de sesión y al cambio de cuenta. Todo lo que se persista en
el cliente debe borrarse al cerrar sesión, salvo razón explícita.

Ya pasó tres veces: la marca de una escuela, el nombre en iOS y el caché de
respuestas de Supabase del service worker se filtraban entre usuarios del mismo
teléfono.

El `signOut` limpia una **lista enumerada** de claves, y esa lista se
desactualiza cada vez que alguien agrega una. Conviene migrar a un prefijo común
y borrar por prefijo.

### iOS ignora el manifest

En Safari, el nombre del ícono sale de `apple-mobile-web-app-title` (o del
`<title>`) y el ícono del `apple-touch-icon`. Además Safari lee esas etiquetas
**al parsear**: lo que React escriba después no cuenta para "Añadir a inicio".

Y una vez agregado, el ícono queda **congelado** — no se actualiza nunca.

### Pizarra táctica: cuatro trampas de gestos y de pantalla (2026-10-05)

Salieron de la auditoría del editor (`docs/specs/pizarra-tactica-material-y-3d.md` §9).

- **Un `<rect>`/`<path>` con relleno captura los toques de todo lo que tenga debajo.** La capa SVG
  de dibujo (z-40) va encima de los jugadores (HTML, z-10): una zona grande tapaba a los pines
  cubiertos (tocarla la borraba y no se podían arrastrar). Para una figura rellena, el relleno va
  con `pointer-events-none` y el borde interactivo es un trazo ancho transparente con
  `pointerEvents="stroke"`.
- **Un gesto táctil puede terminar en `pointercancel`/`lostpointercapture`, no en `pointerup`.**
  Una llamada, un gesto del sistema de iOS o un segundo dedo lo interrumpen; si el estado del gesto
  (vista previa, trazo, handle arrastrado) solo se limpia en `pointerup`, queda colgado hasta el
  próximo toque. Ambos eventos burbujean: alcanza con escucharlos en el `<svg>` contenedor.
- **iOS Safari hace zoom de página al enfocar un campo con fuente < 16 px.** Los campos
  compactos de la pizarra (etiqueta del jugador) tienen que subir a 16 px **solo en táctil**:
  `[@media(pointer:coarse)]:text-[16px]` (por tipo de puntero, no por ancho de pantalla: una
  tableta de 1024 px también es táctil).
- **`<Select>` de Radix: elegir el valor ya seleccionado no dispara `onValueChange`**, y un
  `<Select>` sin `value` (no controlado) puede mostrar un nombre que ya no existe. Controlarlo
  (`value={id ?? ''}`) y ofrecer una acción explícita para "volver a cargar".
- **Las preferencias de vista de la pizarra viven en `localStorage`** (`tactical_board_pin_style`,
  `tactical_board_pin_photos`) y se borran al cerrar sesión (`AuthContext.tsx`). La de las fotos
  **tiene que** borrarse: la foto de un menor no puede quedar prendida para el siguiente que use
  el dispositivo. Una clave nueva de la pizarra se agrega a esa misma lista.
  Excepción ya resuelta por prefijo: los «Ajustes de la pizarra» (M6g) van en
  `tactical_board_settings:<user_id>` (una clave por usuario) y el signOut borra todo lo que
  empiece con `tactical_board_settings:` (`clearBoardSettings`), sin enumerar.

---

## Correo

Los envíos masivos se cortaban alrededor de 100 destinatarios por el rate limit
del proveedor (2 por segundo). Se resolvió con lotes de 100 y un endpoint de
envío masivo en el BFF.

---

## Despliegue

- **Frontend** → Vercel. **BFF** → Render. **Migraciones** → manuales.
- Cada push dispara ~4 despliegues contra una cuota diaria acotada: **agrupar**,
  no pushear por commit.
- Todo empieza en `develop`. La promoción a `staging` y `main` la pide el
  usuario; **nunca** mergear a `main` por iniciativa propia.

### `sportmaps-dev`, `sportmaps-stg` y `sportmaps-prod` comparten UN repo y UN `vercel.json`

Los 3 proyectos de Vercel apuntan al mismo GitHub repo. Sin filtro, un solo
push a `develop` dispara build en los 3 (2 de más). El filtro vive en
`vercel-ignore-build.sh` (invocado desde `ignoreCommand` en el `vercel.json`
raíz, **no** desde el dashboard) y aplica dos reglas, en orden:

1. **Rama** — solo `main|staging|production|develop` construyen algo.
2. **La rama de ESE proyecto** — compara `VERCEL_GIT_COMMIT_REF` contra la env
   var `VERCEL_PROJECT_BRANCH` (Settings → Environment Variables, valor
   distinto por proyecto: `develop`/`staging`/`main`). **Fail-open** si la env
   var no está puesta — si alguien agrega un proyecto nuevo y se olvida de
   configurarla, este filtro no hace nada y ese proyecto vuelve a construir en
   cada push de cualquier rama.
3. **Qué cambió** — si el commit no toca `frontend/`, `vercel.json` ni el
   script mismo, se cancela. Comparado contra `HEAD^`, así que un commit que
   solo toca `bff/`, `supabase/`, `docs/` o `scripts/` no gasta un build.

Verificado en vivo 2026-09-06: de 7 commits seguidos que solo tocaban
`bff/`/migraciones, los 7 quedaron `CANCELED`. El filtro funciona — el
consumo de builds no viene de ahí.

### La cuota que se agota no es "por builds de más" — es Deployment Storage por deployment retenido

Cada proyecto retiene N deployments (`Settings → Git → Deployment Retention`,
`deploymentsToKeep` / `expirationDays` por API). Cada deployment retenido pesa
lo que pese el build completo del SPA (~200-300 MB con 78 páginas, PWA,
imágenes), **sin importar si ese build era necesario o no**. Bajar la
frecuencia de builds innecesarios ayuda a **Build Time** (cuota separada,
horas de build/mes), no a Function/Deployment Storage — para eso lo que
importa es **cuántos deployments se retienen**, no cuántos se disparan.

Confirmado en vivo 2026-09-06 vía dashboard (Team → Usage, la API de
desglose por proyecto es **solo Pro/Enterprise** — en Hobby no hay forma de
verlo por CLI, solo por dashboard):

| Proyecto | Deployment Storage |
|---|---|
| `sportmaps-dev` / `-stg` / `-prod` | ~2.1-2.2 GB cada uno (retención en 10) |
| `sportmaps-landing-page` | 150 MB |
| `qualitytechsolutions` (personal, mismo team) | 46 MB |

### NUNCA correr `vercel deploy` o `vercel link` manual desde una laptop

Los despliegues reales pasan **solo** por el push a Git (`git.deploymentEnabled`
en `vercel.json` raíz). Si alguien corre `vercel deploy`/`vercel --prod` a
mano desde una carpeta cuyo `.vercel/project.json` local quedó apuntando a un
proyecto que ya no existe (se borró, se renombró), la CLI en modo interactivo
puede ofrecer "crear un proyecto nuevo" — y si se acepta sin fijarse, Vercel
crea uno con nombre autogenerado (`<carpeta>-<timestamp>-<random>`) que nadie
va a recordar borrar. Así apareció y se quedó pesando 2.87 GB un proyecto
fantasma detectado el 2026-09-06 (ya no existe, pero tardó en liberar la
cuota).

Antes de correr cualquier `vercel <comando>` a mano: `vercel whoami` y
confirmar que el proyecto vinculado (`.vercel/project.json`, que **no** se
commitea) es el que se espera. Si la CLI dice "Project was either deleted,
transferred..." o pregunta si crear uno nuevo, **parar y avisar**, no aceptar
por default.

## Llamar una RPC desde el BFF le apaga su propia autorización

`bff/src/config/supabase.ts` crea el cliente con `SUPABASE_SERVICE_ROLE_KEY`.
Con el service role, **`auth.uid()` dentro de la RPC es `NULL`**. Y la guarda
estándar de las RPCs de este repo tiene esta forma:

```sql
IF v_caller IS NOT NULL AND NOT (public.is_super_admin() OR public.is_school_admin(...)) THEN
  RAISE EXCEPTION 'No autorizado…';
END IF;
```

Ese `v_caller IS NOT NULL` está ahí para que el cron y `service_role` puedan
correr. El efecto colateral es que **una RPC llamada desde el BFF se saltea su
propio chequeo de permisos**: pasa siempre. Si el endpoint del BFF no replica la
autorización, cualquiera con sesión válida puede operar sobre cualquier escuela.

Peor todavía con las RPCs que *derivan* identidad de `auth.uid()` en vez de solo
autorizar: `request_enrollment_pause` resuelve si el que pide es el acudiente con
`is_parent_of_child(auth.uid())`, así que por el BFF **falla siempre** con "No
autorizado", no es que pase de largo.

Regla: una RPC que autoriza por `auth.uid()` se llama **desde el frontend** con
el JWT del usuario —`(supabase.rpc as any)('nombre', { … })`, como
`set_school_athlete_status` y `create_invitation`— y así su gate es el gate real.
Por el BFF van solo las cosas que genuinamente necesitan service role (webhooks,
crons, el roster de asistencia que arma la lista él mismo).

## La pausa de vacaciones tiene DOS reglas, y confundirlas es el bug

`enrollment_pause_requests` (migración `20260910080206`) responde dos preguntas
distintas con granularidades distintas:

| Pregunta | Granularidad | Dónde vive |
|---|---|---|
| ¿Se cobra el mes M? | **MES** — `month_from`/`month_to` | `enrollment_pausada_en()`, usada por `open_month` |
| ¿Aparece en la lista de asistencia del día D? | **DÍA** — ventana recortada en `resumed_at` | `v_enrollment_pauses_effective` / `enrollment_pausada_el()` |

El que vuelve de vacaciones el 12 reaparece en el roster **el 12**, pero el mes
sigue sin cobro: la plata de ese mes ya se decidió cuando se aprobó la pausa (y
el cobro se anuló). Usar la ventana de días para decidir el cobro haría que el
cron del día siguiente le re-emitiera la cuota — un `payment` en `cancelled`
**no** bloquea la regeneración, porque el dedup de `open_month` solo mira
`pending/awaiting_approval/paid/partial/overdue/glosado`.

Pero "ignorar `resumed_at` en el cobro" a secas también estaba mal, y costó una
migración de fix (`20260910082323`): una pausa **programada** para un mes futuro
y **cancelada antes de que ese mes arranque** dejaba el mes sin cobro para
siempre. El admin programa julio por error, lo cancela en junio, y julio no se
factura nunca. La condición correcta es *el mes no se cobra si la pausa lo cubre
Y no terminó antes de que el mes empezara*:

```sql
AND (r.resumed_at IS NULL
     OR date_trunc('month', (r.resumed_at AT TIME ZONE 'America/Bogota')::date)::date
          >= <primer dia del mes>)
```

Esa condición está **duplicada** en tres lugares a propósito —
`enrollment_pausada_en()`, `open_month` y `preview_open_month`— para no meter una
llamada a función por fila en el CTE de generación. Si se toca uno, tocar los
tres.

Dos consecuencias que no se deducen leyendo el código:

- **`apply_late_fees` no excluye pausados y no hace falta que lo haga**: sin
  cobro no hay a qué aplicarle recargo. La nota de la migración `20260902171932`
  que decía que anular cobros era impracticable "porque `payments` no tiene
  `enrollment_id`" quedó superada: no lo tiene, pero sí tiene
  `period_year`/`period_month` + el trío de identidad del atleta.
- **El autopay, cuando se despliegue, hay que tocarlo.**
  `recurring_subscriptions` hoy **no existe en la base**, pero
  `bff/src/services/recurring-charges.service.ts` crea su propio `payments` por
  fuera de `open_month`. El chequeo de pausa va dentro de
  `claim_due_recurring_subscriptions`, o le cobrará la tarjeta a un pausado.
- **La puerta le sigue abriendo al pausado**: `access-auto-block.job.ts` bloquea
  por `payments.status = 'overdue'`, y un pausado nunca llega a overdue. Sale de
  la lista de asistencia pero el torno lo deja entrar. Deliberado, no un olvido.

## Control de acceso y torniquetes (ZKTeco)

### Render pone a Cloudflare delante: `clientIp()` con `req.ip` rechaza todo

Todo el tráfico a Render pasa primero por Cloudflare — **también el `*.onrender.com` crudo**, sin ningún
dominio nuestro (`curl -I` devuelve `Server: cloudflare` + `CF-RAY` junto a `x-render-origin-server: Render`).
No es un toggle de nuestro DNS ni algo que se pueda apagar. La cadena real son **dos saltos**
(cliente → Cloudflare → Render → app) y `app.set('trust proxy', 1)` descuenta solo uno: `req.ip` es la IP de
borde de Cloudflare, que **rota por request** (rangos 172.64.0.0/13, 104.16.0.0/13).

Costó ~24 h con los 4 torniquetes (GYM RM + Dreamers) en 403: el commit `42fef4d` cambió `clientIp()` de
`X-Forwarded-For[0]` (spoofeable) a `req.ip` — fix de seguridad bien intencionado, mal calibrado. El log lo
delata: el mismo serial aparece con 5–6 IPs distintas en minutos, todas de Cloudflare.

**Regla:** detrás de Render, la IP del cliente sale de `cf-connecting-ip` (Cloudflare lo sobrescribe, el
cliente no lo puede falsificar), con `req.ip` solo de respaldo para local/dev. Aplica a `clientIp()`
(`access-adms.ts`) y a `requestIp()` del WS (`bridgeWsServer.ts`, que además no pasa por `trust proxy`).
Nunca contar saltos de `X-Forwarded-For` a mano.

### Tres señales de vida distintas, solo una dice si la asistencia fluye

Un lector de Dreamers puede verse «en línea» y llevar días sin capturar nada:

| Señal | Qué prueba | Qué NO prueba |
|---|---|---|
| `bridge_heartbeats` (`door-bridge`) | el canal de **comandos** del bridge llega al backend | que la captura de asistencia funcione — es otro hilo |
| `turnstile_devices.last_seen_at` | lo que el script decida mandar (hoy: latido cada 60 s por el WebSocket —con respaldo HTTP si el BFF es viejo— **solo mientras `live_capture` está conectado**) | nada, si el script no manda heartbeat: se mueve solo al marcar |
| `access_events` recientes | hubo marcaciones | que hubiera gente marcando |

Pasó de verdad: LECTOR ENTRADA ~3 días sin capturar con `bridge_heartbeats` verde. La alerta vigente es
`alert_offline_access_devices()` (pg_cron, 5 min, 15+ min sin `last_seen_at`) — depende de que el script
mande el heartbeat. **No quitar `send_heartbeat()` del loop de captura** (la primera versión con
`live_capture` lo dejó definido pero sin llamar).

### `get_attendance()` trae TODA la tabla (y deshabilitar el lector para leerla deja el torniquete sin aceptar huellas)

`pyzk` no filtra por fecha: con ~48.000 registros acumulados un solo `get_attendance()` tarda ~47 s. La
primera versión del script lo envolvía en `disable_device()` — **el lector no acepta huellas todo ese
tiempo** — y el sondeo viejo (cada 5 s) lo dejaba deshabilitado cerca de la mitad del día. `get_attendance()`
no deshabilita nada por sí mismo; el barrido de respaldo ya no lo hace (`SPORTMAPS_BRIDGE_SWEEP_DISABLE_DEVICE=1`
lo restaura; leer con el equipo habilitado no se había probado en el MB360). La captura normal debe ser
`live_capture`, que **tampoco** debe llamar `disable_device()`. Y el barrido no se puede espaciar a «una vez
al día»: el backend descarta ATTLOG de más de 3 h (`ADMS_BACKLOG_SKIP_HOURS`), así que solo recupera algo si
corre al menos cada ~2 h (hoy cada 30 min).

### Un cursor que no avanza se traba para siempre

El guard «más de N eventos nuevos de golpe, no envío nada» tiene que **avanzar el cursor** igual: si no,
vuelve a ver los mismos eventos en cada ciclo y nunca sale solo (LECTOR ENTRADA, 102 eventos > 20). Y el
cursor compara contra el **reloj del lector**: una marcación con `timestamp ≤ cursor` se descarta — por eso
el barrido reenvía también una ventana anterior (los duplicados los absorbe el índice único
`device_id+zk_user_id+occurred_at`, y los efectos —banco de horas, notificaciones, asistencia— solo corren
en fila nueva).

### `apply_migration` rechaza `DROP FUNCTION` sobre una función viva

Reemplazar una RPC viva con `DROP FUNCTION` + `CREATE FUNCTION` fue rechazado cuatro veces en el aviso de
permiso del tool, aunque se aprobara en el chat. `CREATE OR REPLACE FUNCTION` (misma firma) pasó a la
primera **y además conserva el ACL** (`service_role` solo) y no deja ventana sin función. Usar
`CREATE OR REPLACE` siempre que la firma y el tipo de retorno no cambien; el `DROP` solo si de verdad
cambian. Para una migración grande, partirla (aditiva primero, reemplazos después) la hace revisable.

### El descuento del alta vivía solo en `amount` y se perdía al guardar el editor de atletas

**Caso real (Dreamers, 2026-10-10):** Zoe Barrera se registró con 5 % de descuento (insertada a $232.750).
Dos minutos después un `UPDATE` del BFF dejó el cobro en $245.000 —el precio del plan— y el pago manual se
registró sin descuento. La traza está en `audit_logs` (INSERT $232.750 → UPDATE `profile_id` nulo $245.000 → pago).

**Causa:** el descuento solo estaba "horneado" en `payments.amount` y en el texto del concepto («… (Desc. 5%)»).
La rama «mismo plan/equipo» de `PUT /students/:id` reescribía el monto de los cobros pendientes a la cuota
completa y no sabía que ese cobro tenía un descuento. El modal de pago manual tampoco lo conocía.

**Arreglo (migración `20261010140353`):** `payments.discount_pct` y `payments.list_amount`, escritos por
`create_enrollment_with_payments`. `repricePendingCharges()` (enrollmentBilling) recalcula respetando el % de
cada cobro, y el modal muestra «lista − descuento = valor» y pide confirmar si se registra un monto distinto.
**Regla:** cualquier código que recalcule o reverse un cobro con descuento debe volver a aplicarlo. Los cobros
anteriores a la migración se rellenaron leyendo el «(Desc. X%)» del concepto, solo los pendientes.

### Registrar un pago manual con un rol que no es owner/admin «funcionaba» sin registrar nada

**Causa:** la policy `Payments: update admin` solo deja actualizar cobros a `owner` / `admin` / `school_admin`.
El modal «Registrar pago manual» (`RegisterCashPaymentModal`) se muestra a cualquiera que no sea `coach`
(`canManageStudents = role !== 'coach'`), así que un `staff` (secretaría) hacía el UPDATE, RLS lo filtraba a
**0 filas sin error** y el modal anunciaba «Cobro registrado». Verificado en vivo el 2026-10-10 con una sesión
simulada de un `staff` de Dreamers (0 filas) frente a la del owner (1 fila).

**Arreglo:** el UPDATE individual ahora pide `.select('id')` y falla con un mensaje claro si no afectó filas; el
pago de varios cobros va por la RPC `register_manual_payments` (migración `20261010143350`), atómica y con la
misma regla de autorización (`is_school_admin` o super admin, escuela operativa, cobros pendientes/atrasados de
un mismo deportista, máx. 50). Ampliar el permiso a `staff` es una decisión de producto aparte: hoy NO puede.

### El primer cobro de un alta nacía vencido y con recargo al día siguiente

**Causa:** `dueInEntryMonth` (`prorationUtils.ts`) pone el vencimiento en el día de corte *o el día del alta si el corte
ya pasó* («un cobro no nace vencido»). Con corte 5 y gracia 0 (Dreamers), un alta el 10 vence el 10 y el cron
`apply_late_fees` de las 02:00 del 11 lo pasaba a `overdue` y le sumaba 5 %. Además `overdue` alimenta el bloqueo
automático. Pasó con Zoe Barrera y Avril Salomé Aguilar (2026-10-10).

**Arreglo (migración `20261011101750`, solo con `school_settings.late_fee_skip_signup_month = true`):** trigger
`trg_payments_primer_cobro_prox_corte` mueve el vencimiento del primer cobro mensual al corte del mes siguiente y
`apply_late_fees` nunca le suma recargo (`fn_is_first_monthly_charge`: primera mensualidad no anulada del atleta).
**Trampa:** quien redefina `apply_late_fees` debe partir del cuerpo VIVO, o pierde la exención sin que nada falle.

### En Dreamers el «dorsal» se usaba como ID del torniquete, y sin mapeo no abre

**Causa:** el registro tenía un campo «Dorsal» de texto libre; Dreamers escribía ahí el PIN del lector, pero el torniquete
solo reconoce a alguien con una fila en `zk_user_mappings`. Tres inscritos recientes tenían el número y no abrían.
**Arreglo:** el campo se reemplaza por el ID del torniquete y se asocia en el alta
(`docs/specs/dreamers-id-torniquete-en-registro.md`). Un dorsal escrito **no** crea mapeo.

### El botón «Compartir link» no aparecía: la escuela no tenía fila en `school_trial_class_settings`

**Causa:** el botón (Planes y Membresías y Ajustes de clases de prueba) exige `self_service_enabled` de esa tabla, que
se crea «lazy» al primer uso. Dreamers nunca la tuvo, así que no se mostraba. **Arreglo:** se activó con la RPC
`trial_class_self_service_save_settings` (reagendar 12 h, cobro `en_sede`) el 2026-10-13. El link es
`/agendar-clase/<slug>`; las categorías de clase de prueba de Dreamers están en 0.

### MB360: el borrado de un usuario por SDK se ve solo al reconectar

`SSR_DeleteEnrollDataExt(…, 12)` borra al usuario, pero **en la misma sesión** `SSR_GetUserInfo` lo sigue devolviendo; el
cambio se refleja al cerrar la conexión. Un script que verifique dentro de la sesión da un falso «no se pudo borrar» y,
si se detiene ahí, deja al usuario borrado sin restaurar (pasó con el PIN 12 de Dreamers el 2026-10-23; el respaldo
guardado antes de borrar lo recuperó). Verificar **reconectando**, y guardar siempre el respaldo a disco **antes** de
borrar. El SDK `zkemkeeper` es COM de 32 bits: va con `SysWOW64\WindowsPowerShell`, no con el Python de 64 bits.

