# ID del torniquete en el registro del deportista (Dreamers, Academia Superior)

**Estado (2026-10-14):** base y código listos; **falta commit y despliegue de BFF + frontend** (la migración ya está
aplicada en vivo). Origen: pedido del owner de Dreamers el 2026-10-13.

## 1. Qué se pidió

En el registro del deportista (menor o adulto), **solo para Dreamers**, el campo «Dorsal» se reemplaza por el **ID del
lector ZKTeco** (`zk_pin`), con la sugerencia de que ese ID es importante: es el que conecta el ingreso con SportMaps
y controla el acceso. Objetivo: que **no haga falta enrolar después** en Control de acceso → «asignar usuario»; si el
deportista ya tiene su ID, queda asociado desde el alta. Se activó también en **Academia Superior Bogotá** para
probar.

## 2. Por qué

El torniquete reporta en cada marcación el PIN; `zk_user_mappings (school_id, zk_pin) → child_id | user_id |
unregistered_athlete_id` lo cruza con la persona (`access-adms → resolveMapping`). Sin mapeo la marcación no se
resuelve y la puerta no abre. En Dreamers **el dorsal ya se usaba a mano como el ID** (Mariapaz 605/605, Athenea
4/4), pero era un texto suelto: el 2026-10-13 había tres inscritos con el número escrito en el dorsal y **sin
mapeo** (Zoe 602, Avril 439, Sofía 525) → no abrían el torniquete.

## 3. Comportamiento

Interruptor por escuela: `school_settings.registration_zk_pin_enabled` (default `false`; `true` en Dreamers y Academia
Superior). Migración `20261013180924`. Se expone al frontend en `GET /me/entitlements` (select aparte, falla cerrado).

| Dónde | Con el flag | Sin el flag |
|---|---|---|
| Alta de menor (`CreateChildModal`) | campo «ID del torniquete (ZKTeco)» con aviso | «Dorsal» |
| Alta de adulto (`CreateAdultAthleteModal`: existente o sin cuenta) | igual | «Dorsal» |
| Edición (`SchoolStudentsManagementPage`) | ID en lugar del dorsal, con el ID actual; solo se envía si cambió | «Dorsal» |
| Ficha | fila «ID torniquete (ZKTeco)» o «Sin asociar» | «Dorsal» |

El campo es **opcional** (puede quedar vacío y asociarse luego). No se manda ningún comando al lector: el ID ya existe
en él o se enrola después con ese mismo número (igual que `POST /access/assign-user`).

## 4. Reglas y validaciones (BFF, `services/zkPinAssignment.ts`)

- Entero de **1 a 99.999.999**.
- Solo escuelas con el flag (si no: 400 `ZK_PIN_NOT_ENABLED`).
- **Único por escuela**: si el ID ya es de otra persona, 409 `ZK_PIN_IN_USE` con su nombre. El ID que ya es de la misma
  persona (edición) no es conflicto.
- **Una persona = un ID**: al cambiarlo se retira el anterior (`delete … neq zk_pin` + `upsert`).
- **Solo administración** (`owner`/`admin`/`school_admin`), igual que `assign-user`: el entrenador recibe 403
  `ZK_PIN_FORBIDDEN`. En `create-one` el ID se valida **antes** de crear al deportista; si el vínculo falla después
  (carrera por el mismo ID) el alta **no** se revierte y la respuesta trae `zk_pin_warning`.
- En edición, un valor vacío significa «no tocar»; **quitar** un ID se hace en Control de acceso.
- Rutas: `POST /students/create-one` (`child`, `adult_existing`, `unregistered_adult`) y `PUT /students/:id`.
- Pruebas: `bff/src/services/zkPinAssignment.test.ts` (14).

## 5. Plan

| # | Tarea | Estado |
|---|---|---|
| 1 | Migración del flag + Dreamers/Academia Superior en `true` | ✅ en vivo |
| 2 | Servicio, rutas `create-one` y `PUT`, entitlements | ✅ en el árbol, tsc limpio, 53 pruebas OK |
| 3 | Formularios de alta, edición y ficha | ✅ en el árbol, tsc limpio; **sin probar en navegador** |
| 4 | Commit + despliegue BFF y frontend | ⏳ Julián |
| 5 | Prueba de aceptación en Dreamers: alta con ID nuevo, con ID repetido (409), edición, ficha | ⏳ tras desplegar |
| 6 | Asociar Zoe 602 / Avril 439 / Sofía 525 (hoy sin mapeo) | ⏳ decisión del owner; verificar choques antes |
| 7 | Dorsal 4 de Bella Cardona = ID de Athenea (el de Bella es el 12): corregir al migrar el dato | ⏳ |
| 8 | Pantalla en Ajustes para el flag (hoy se cambia por SQL) | 🕓 opcional |
| 9 | `MOD-34` (carga masiva de los PIN que ya están en el lector): este campo cubre las altas nuevas, no el backlog | 🕓 abierto |

## 6. No cubierto

- Altas por CSV y `child_existing` no piden el ID (se asigna en la edición o en Control de acceso).
- `CreateStudentModal` es código sin uso; no se tocó.
- Escuelas sin el flag no cambian en nada.

## 7. «IDs del lector» (Control de acceso, F1) — 2026-10-31

Botón «IDs del lector» en Control de acceso → diálogo con los usuarios que reporta el lector (PIN, nombre en el lector,
credenciales huella/rostro/clave), a quién están asociados, su estado de cobro (staff, al día, mora, sin inscripción) y una
**sugerencia de asociación por parecido de nombre**. Filtros Todos / Sin asociar / Asociados / Con mora, búsqueda por PIN o
nombre, paginación. Asociar usa `POST /access/assign-user` (que ahora valida que la persona sea de la escuela).

- **Interruptor por escuela:** `school_settings.access_roster_enabled` (default false). Encendido **solo en Academia Superior
  Bogotá** (pruebas); Dreamers después, cuando el bridge sincronice.
- **Datos:** tabla `access_device_users` (foto que se reemplaza en cada sincronización; **sin plantillas biométricas**, solo
  banderas; RLS sin policies, la lee/escribe solo el BFF). Migración `20261031131601`.
- **Academia Superior no tiene lector:** se cargó una lista **simulada** (25 filas, `device_serial = 'DEMO-SIMULADO'`,
  `is_simulated = true`); el diálogo muestra el aviso «Datos simulados». Borrar: `delete from access_device_users where is_simulated`.
- **Sugerencias** (`services/accessRoster.service.ts`): coincidencia por nombre con tolerancia a iniciales («Katherin T.» →
  80 %), nombres pegados («NanaPerez») y tildes; **sin sugerencia si hay dos o más deportistas con el mismo nombre** (empate)
  o si nada pasa del 75 %. 9 pruebas.
- **Pendiente para Dreamers:** que el bridge envíe los usuarios del lector (pyzk `get_users` ya los lista; falta el comando de
  sincronización y el endpoint de ingesta autenticado) y encender el flag. Después: F2 (Vencidos con borrar/restaurar), F3
  (ficha), F4 (ajustes).

