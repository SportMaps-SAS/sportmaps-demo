# Demo — Club Campestre Demo

Tenant de demostración: club social multideporte con 8 unidades deportivas, staff con
alcances distintos, familias, cartera con mora realista, asistencia, control de acceso
biométrico y un torneo abierto.

- **school_id:** `25a123f0-6d57-48a4-9800-7b1531d61cd2`
- **slug / perfil público:** `/s/club-campestre-demo`
- **proyecto Supabase:** `luebjarufsiadojhvxgi` (la compartida) · todo marcado `is_demo = true`
- **contraseña de TODAS las cuentas:** `Demo2026!`
- **sembrado:** 2026-08-03 · **no toca** Dynasty, RMGYM ni ninguna otra escuela

```bash
node scripts/demo-club-campestre/seed.mjs             # crear / actualizar (idempotente)
node scripts/demo-club-campestre/seed.mjs --verify    # checklist de verificación
node scripts/demo-club-campestre/check-isolation.mjs  # qué ve cada usuario (RLS real)
node scripts/demo-club-campestre/seed.mjs --dry-run   # ensayo sin escribir
```

## Cómo entrar

1. Ir a **`/login`** (en el ambiente que estés usando, p. ej. `https://dev.sportmaps.co/login`).
2. Correo de la tabla de abajo + contraseña **`Demo2026!`** (la misma para las 17 cuentas).
3. Cae en `/dashboard`, que se arma según el rol. El staff ve el panel de escuela; el
   padre y los atletas ven la app.

Rutas útiles del panel: `/students` (deportistas), `/finances` (cartera), `/offerings`
(disciplinas y tarifas), `/branches` (unidades deportivas), `/attendance-supervision`,
`/school/access-control` (portería), `/school-reports`.
El perfil público **no** pide login: `/s/club-campestre-demo`.

Todas las cuentas quedan con el correo confirmado y el seed **re-escribe la contraseña en
cada corrida**, así que si alguien la cambia, volver a correr `seed.mjs` la restaura.

## Qué quedó sembrado

| | |
|---|---|
| Disciplinas (sedes) | 8 — Golf, Tenis, Pádel, Fútbol, Voleibol, Baloncesto, Natación, Gimnasio |
| Categorías (equipos) | 28, con rango de edad y mensualidad |
| Tarifas | 15 (matrícula + mensualidad por disciplina) |
| Instalaciones | 14, con tarifa por hora y alquiler a terceros habilitado |
| Reservas | 40 (16 completadas / 11 confirmadas / 7 por confirmar / 6 canceladas) · 11 alquileres a colegios y empresas · **$5.081.400** recaudados · 78 franjas de disponibilidad |
| Deportistas | 44 (29 menores + 13 adultos sin cuenta + 2 adultos con cuenta) |
| Cartera | 226 cobros · mayo–agosto 2026 · 186 pagados / 27 pendientes / 13 en mora · **$8.710.000** por cobrar |
| Agenda | 147 sesiones (2 semanas atrás + 2 adelante) |
| Asistencia | 54 marcas en 4 grupos |
| Acceso | 2 lectores, 17 huellas, 22 registros |
| Torneo | Abierto de Tenis, 2026-08-27, $95.000, con Alejandra inscrita |

## Cuentas

| Rol en la demo | Nombre | Correo | Alcance real |
|---|---|---|---|
| Gerencia (owner) | Ricardo Mendoza | `gerencia@demo.sportmaps.co` | Todo el club |
| **Auditora / finanzas** | Patricia Vargas | `finanzas@demo.sportmaps.co` | Solo lectura: `/reporter-dashboard` |
| Coordinador Golf | Andrés Salazar | `golf@demo.sportmaps.co` | Sede Golf (scoped) |
| Coordinadora Tenis | Camila Restrepo | `tenis@demo.sportmaps.co` | Sede Tenis (scoped) |
| Coordinador Natación | Jorge Pineda | `natacion@demo.sportmaps.co` | Sede Natación (scoped) |
| Portería | Puesto Portería Principal | `porteria@demo.sportmaps.co` | `/school/access-control` |
| Entrenador Tenis | Felipe Torres | `entrenador.tenis@demo.sportmaps.co` | Tenis — Juvenil Competitivo |
| Entrenadora Natación | Laura Gómez | `entrenadora.natacion@demo.sportmaps.co` | Natación — Infantil |
| **Entrenador Fútbol** | Andrés Ríos | `entrenador.futbol@demo.sportmaps.co` | Fútbol — Sub-15 y Fútbol — Sub-12 (agregado 2026-10-26, ver abajo) |
| **Padre estrella** | Mauricio Herrera | `mherrera@demo.sportmaps.co` | Sofía + Tomás |
| Atleta adulta | Valentina Cruz | `vcruz@demo.sportmaps.co` | Golf + Gimnasio, al día |
| Atleta en mora | Daniel Ospina | `dospina@demo.sportmaps.co` | Pádel, 2 meses de mora |
| Externa (torneo) | Alejandra Ruiz | `aruiz.externa@demo.sportmaps.co` | Solo el torneo |
| Familias de relleno | Rojas, Moreno, Castaño, Jaramillo, Quintero | `familia.<apellido>@demo.sportmaps.co` | Sus hijos |

## Entrenador de fútbol (2026-10-26)

Las funciones de partido con goles, asistencias y tarjetas por jugadora solo salen en equipos de
fútbol, y los entrenadores del seed eran de tenis y natación. Se agregó **Andrés Ríos**
(`coach_futbol` en `catalog.mjs`) sin volver a correr el seed completo:

```bash
node scripts/demo-club-campestre/add-coach.mjs              # coach_futbol (por defecto)
node scripts/demo-club-campestre/add-coach.mjs coach_futbol --dry-run
```

`add-coach.mjs` reproduce solo los pasos del seed para ese entrenador (cuenta de auth con
`Demo2026!` + `profiles` + `school_members` coach + `school_staff` con `coach_auth_id` +
`teams.coach_id` + `team_coaches` + `offering_coaches`), con los mismos ids deterministas y UPSERT:
es idempotente y nunca borra. Verifica antes que la escuela sea `is_demo=true`.

Ojo: `teams.coach_id` de Sub-15 y Sub-12 apuntaba a **Camilo Herrera** (`f0000000-…-000000000001`,
una ficha de `school_staff` sin cuenta); ahora apunta a Andrés. Camilo sigue en `team_coaches`.
La primera vez que Andrés entra, la app le pide el perfil profesional (ya quedó completo).
Se usó para probar y documentar el Entrenador V2: `docs/manuales/v2/`.

## Los tres casos que sostienen la demo

**1 · Tomás Herrera — multideporte con estados de pago independientes**
Fútbol Sub-15 al día ($180.000/mes) y Tenis Juvenil Competitivo con **julio en mora
($280.000)**. Mauricio ve ambos y puede pagar el de tenis con Wompi sandbox.

> Detalle técnico que importa si alguien pregunta: la base tiene índices únicos
> (`uniq_payment_active_period_per_child/_adult/_unreg`) que admiten **un solo cobro
> activo por atleta y mes**, y un trigger rellena `period_*` desde `due_date`. Para que
> Tomás tenga dos estados en el mismo mes, el cobro de su disciplina principal va con
> `child_id` y el de la secundaria con `parent_id` (el padre lo ve igual, porque
> `MyPaymentsPage` consulta `parent_id.eq.me OR child_id.in.(mis hijos)`).
> Los adultos (Valentina, Daniel) llevan **un** cobro mensual que suma sus disciplinas
> + la cuota social, con el detalle en el concepto — es lo que la plataforma sabe
> representar hoy para un adulto self-pay.

**2 · Bloqueo biométrico por mora** *(probado end-to-end contra el BFF desplegado)*
Daniel tiene julio y agosto en mora ⇒ el torniquete lo rechaza con `payment_overdue` y le
crea la notificación "⚠️ Acceso denegado — Pago vencido". Sin lector físico, se simula con:

```bash
BFF=https://sportmaps-bff-dev.onrender.com     # o http://localhost:3000

# Daniel (PIN 1002), 2 meses de mora → DENEGADO
printf "1002\t$(date '+%Y-%m-%d %H:%M:%S')\t0\t1\n" \
  | curl -s -X POST "$BFF/iclock/cdata?SN=DEMOCAMP0001&table=ATTLOG" \
         -H "Content-Type: text/plain" --data-binary @-

# Carlos Buitrago (PIN 2000), socio de pádel al día → CONCEDIDO
printf "2000\t$(date '+%Y-%m-%d %H:%M:%S')\t0\t1\n" \
  | curl -s -X POST "$BFF/iclock/cdata?SN=DEMOCAMP0001&table=ATTLOG" \
         -H "Content-Type: text/plain" --data-binary @-
```

Ambos casos verificados contra el BFF que está desplegado hoy. El resultado se ve en
vivo en `/school/access-control` con la cuenta de Portería.

PINes: Portería `1` y Gerencia `2` (staff: entran sin inscripción) · Valentina `1001` ·
Daniel `1002` (mora) · relleno `2000`–`2012`, casi todos al día salvo `2012`, que también
está en mora si quieres un segundo rechazo.

⚠️ **No usar el PIN 1001 (Valentina) para el caso "concedido":** tiene dos inscripciones
(golf + gimnasio) y hoy el torniquete la rechaza con `no_enrollment` por un bug de
`validateAccess`. El fix está aislado en
[pendiente-fix-torniquete-multideporte.patch](pendiente-fix-torniquete-multideporte.patch)
y **no se aplicó**, porque es el único cambio que alteraría el comportamiento de un tenant
real (GYM RM). Para la demo no se necesita: el caso "concedido" lo hace el PIN 2000.

**3 · Cartera consolidada vs. por disciplina**
Ricardo ve el total del club; el selector de sede filtra por unidad deportiva.

**4 · Reservas y alquiler de escenarios** (`/facilities` → pestaña Reservas)
40 reservas entre 3 semanas atrás y 3 adelante, sobre las 13 instalaciones con tarifa.
Dos historias en la misma pantalla: socios reservando cancha (`internal`) y **alquiler a
colegios y empresas** (`rental`, con `external_org_name` y tarifa 40% más alta) —
$5.081.400 recaudados. Las 7 "por confirmar" sirven para aprobar una en vivo.

Coherencias cuidadas, porque son las que delatan un demo armado a la carrera: ninguna
cancelada quedó como "pagada" (van `unpaid` o `waived`), y Daniel —bloqueado por mora— no
tiene reservas a futuro. `reservation_payments` no se sembró: ninguna pantalla la lee, el
estado de pago vive en `facility_reservations`.

## Orden sugerido de la demo

1. **Ricardo (gerencia)** → dashboard del club, las 8 unidades deportivas, cartera total.
2. **Andrés (golf)** → entra a su unidad deportiva: solo golf en pantalla. Separación
   club/deporte en acción (ojo con lo que se afirma, ver abajo).
3. **Mauricio (padre)** → 2 hijos, 3 matrículas; paga la mora de tenis de Tomás ($280.000)
   con Wompi sandbox.
4. **Portería** → `/school/access-control`: Carlos (PIN 2000, al día) entra; Daniel (PIN 1002)
   es rechazado por mora y le queda la notificación en su app. Los curls están arriba.
5. **Patricia (auditora)** → `/reporter-dashboard`: cierra con la cartera consolidada y su
   desglose por unidad deportiva, y la exporta. Perfil de **solo consulta**, que es justo el
   argumento: el club le abre las cuentas a su auditor sin entregarle el panel completo.
   Números de hoy: ingreso potencial $6.040.000/mes · recaudado $3.830.000 · por cobrar
   $5.750.000 · 3 morosos. *(Requiere el BFF con el fix de `/reports/reporter/dashboard`.)*
6. Si sobra tiempo: **Reservas** (`/facilities`) con los alquileres a colegios y empresas.

## Lo que la demo NO puede afirmar

Verificado con `check-isolation.mjs`, iniciando sesión de verdad con cada cuenta:

1. **El aislamiento por disciplina es del cliente, no de la base.** Andrés (coordinador de
   Golf) *ve en pantalla* solo golf porque el selector de sede filtra las consultas, pero
   su token lee las 8 disciplinas y los 226 cobros. No decir "los datos están aislados";
   sí se puede decir "cada coordinador entra a su unidad deportiva".
2. **Cualquier miembro del club lee la cartera completa por RLS** (entrenadores, padres y
   atletas incluidos: 226 cobros). Es un hallazgo conocido del producto — las policies
   tratan a cualquier miembro como staff — no algo de este seed. Alejandra, que no es
   miembro, correctamente ve 0.
3. **Patricia sí quedó acotada, pero solo en la interfaz.** Su rol es `reporter` — el que la
   UI llama **"Auditor"** (`AdminUsersPage.tsx`) —, la única figura de consulta que existe:
   entra a `/reporter-dashboard` (cartera consolidada, por cobrar, morosos, desglose por
   unidad deportiva, export CSV/PDF) y **no** ve `/students`, `/offerings` ni la
   configuración; la matriz `reporter` del BFF solo trae permisos `:view`.
   Pero **a nivel de base sí puede escribir**: con su token se logró crear un equipo
   (HTTP 201), porque las policies tratan a cualquier miembro como staff. La restricción es
   de interfaz, no de RLS — no afirmar "no tiene permisos para modificar".
   Contrapartida del cambio: `/finances` y `/accounting` (conciliación bancaria, nómina,
   proveedores, presupuesto) siguen siendo solo de los roles admin → esa parte se muestra
   con **Ricardo**.
4. **El recurrente de Valentina es decorativo.** Wompi todavía no expone
   `/v1/payment_sources`, así que hay un `payment_tokens` de demo pero no hay cobro
   automático real. MercadoPago sí soporta recurrente, pero su token en este entorno es
   de **producción**: no usarlo en la demo (por eso el addon `mp` quedó apagado).
5. **Portería es un `school_admin` entrando a `/school/access-control`**; el rol
   `facility_manager` no tiene UI todavía.

## Perfil público (`/s/club-campestre-demo`)

Se veía roto por un bug de código, no por falta de datos: `getSchoolBySlug` devolvía la fila
cruda de `schools` cuando encontraba el slug, y la página espera un perfil mapeado. Resultado:
banner con `src=undefined` (icono de imagen rota) y las pestañas Equipos / Servicios /
Entrenadores vacías **para cualquier escuela real**. Arreglado:

- `mapPublicProfile()` en [schools.ts](../../frontend/src/lib/api/schools.ts) arma equipos (28
  categorías con edad, horario y precio), servicios (las 8 disciplinas con su tarifa desde) y
  cuerpo técnico. Todo lo que consulta es legible por `anon` (verificado).
- `teams.schedule` es jsonb; se formatea a texto (`Mar/Jue 18:00-19:30`). Pintarlo directo
  reventaba el render de React.
- [sportImages.ts](../../frontend/src/lib/sportImages.ts): imagen por deporte, verificadas una
  por una. La foto de piscina que usaba el perfil público responde **404**, y por eso todas las
  instalaciones mostraban la imagen de fútbol.
- El club tiene portada y logo propios. El logo va en Storage (`school-assets/logos/<id>/`) y se
  aplica con la RPC `update_school_branding` autenticado como Ricardo, porque el trigger
  `branding_must_go_through_rpc` bloquea el UPDATE directo y la RPC solo acepta URLs de ese
  bucket. Colores del club: `#1f6f3f` / `#c9a227`.
- La portería quedó `inactive` en `school_staff`: es un puesto, no una persona, y `public_staff`
  no distingue cargo administrativo de entrenador, así que salía listada como "entrenador".

⚠️ Estos tres archivos son de **frontend**: hay que desplegar (o correr en local) para verlo
en `dev.sportmaps.co`.

## Decisiones que quedaron cableadas en los datos

- `payment_mode = 'aggregator'` → el checkout usa las llaves Wompi del BFF, que aquí son
  **sandbox** (`WOMPI_ENV=sandbox`). Con `'direct'` el checkout quedaría fail-closed.
- `school_settings`: `auto_generate_payments`, `late_fee_enabled`, `reminder_enabled`,
  `auto_glosa_enabled` y `auto_approve_enabled` **apagados**, para que ningún cron nocturno
  mueva la cartera sembrada ni mande correos a los buzones falsos `@demo.sportmaps.co`.
  Si se prenden, la demo puede amanecer distinta.
- Plan `enterprise` + addons `access_control, tournaments, accounting, whatsapp, wompi,
  store, invoicing` para que no aparezcan paywalls.
- Las matrículas se fechan en **febrero 2026** (3 meses antes del periodo más antiguo) para
  no competir por el mes de ninguna mensualidad en los índices únicos.

## Re-ejecución y rollback

El seed es idempotente: los ids son deterministas (`duid()` = sha1 del key) y hace UPSERT.
Las tablas tipo bitácora (`payments`, `attendance_records`, `access_events`) **no se
re-escriben**: si ya hay filas del club, el paso se omite. El script **nunca borra**.

Para borrar todo: `rollback.sql` (revisar y ejecutar a mano en el SQL Editor).

Pendiente de limpieza manual: la fila sonda `00000000-0000-4000-8000-0000000feed1` en
`payments` (cancelada y desvinculada) que se usó para comprobar el trigger de `period_*`.
