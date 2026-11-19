# Revisión de datos cruzados, URLs de Unsplash y estado de migraciones — 2026-11-19

Solo lectura. Consultas puntuales con `npx supabase db query --remote --read-only` (Supabase compartida). Sin PII: solo ids y roles.

## Parte 1 — Filas «cross-tenant» de la auditoría I3/I6

### Hallazgo central
Las 8 filas de `trainer_session_plans`, las 3 de `children_stats` y la de `attendance_records` giran alrededor de **UN solo niño** (1 `client_id` distinto, escuela de origen `90b2cc2e…`, activo, no demo, creado 2026-03-18) y de **dos entrenadores personales**, cada uno dueño (`school_members.role = owner`, activo, y `school_staff` activo) de su propia «escuela» de PT:

| Entrenador (profile) | Rol en profiles | Escuela PT donde es owner | Planes totales |
|---|---|---|---|
| `0394e265…` | personal_trainer | `531d5333…` | 5 |
| `7c1d503c…` | personal_trainer | `a1765dc1…` | 34 |

Ninguno es padre del niño (`trainer_is_parent = false`). Los 7 planes con `enrollment_id` apuntan a una inscripción **del mismo niño** en la escuela PT (verificado: `enrollments.child_id = client_id`, 7 de 7). `assignment_source = 'pt'` en las 8. Es decir: el niño está inscrito como cliente en dos escuelas de entrenador personal además de su escuela de origen. El patrón es el flujo normal de «entrenador personal con cliente niño», no un uuid inyectado.

### trainer_session_plans (8 filas)
| Plan | Entrenador | school del plan | Fecha de creación | Estado | enrollment_id | Veredicto |
|---|---|---|---|---|---|---|
| `4d386ea6…` | 0394e265 | 531d5333 | 2026-04-18 | completed | null | LEGÍTIMA (sin inscripción propia, pero mismo entrenador tiene otro plan con inscripción del mismo niño en 531d5333; revisar que sea cliente real) |
| `fb1ed393…` | 0394e265 | 531d5333 | 2026-04-18 | assigned | b6a40c30 (esc. 531d5333) | LEGÍTIMA |
| `eb2ab987…` | 7c1d503c | a1765dc1 | 2026-04-19 | cancelled | 46c31e42 (esc. a1765dc1) | LEGÍTIMA |
| `7cd7aee6…` | 7c1d503c | a1765dc1 | 2026-04-19 | cancelled | 46c31e42 | LEGÍTIMA |
| `f7f1d9c0…` | 7c1d503c | a1765dc1 | 2026-04-19 | cancelled | 46c31e42 | LEGÍTIMA |
| `132c1ce1…` | 7c1d503c | a1765dc1 | 2026-04-19 | completed | 46c31e42 | LEGÍTIMA |
| `e98b7fe7…` | 7c1d503c | a1765dc1 | 2026-04-20 | cancelled | 46c31e42 | LEGÍTIMA |
| `a91a8f47…` | 7c1d503c | a1765dc1 | 2026-05-14 | assigned | 46c31e42 | LEGÍTIMA |

Explicación: el niño es cliente de PT de dos entrenadores; la «escuela» del plan es la del entrenador, la del niño es la de origen. Ninguna fila luce como explotación (no hay entrenador ajeno sin vínculo, todos con membresía propia, todos con inscripción del niño salvo la primera). Las canceladas y la fecha 2026-05-14 son uso normal de agenda.

Qué hacer: nada sobre los datos. Esto confirma que **la segunda pasada del fix (validar `client_id` contra la escuela del plan) NO puede ser un `children.school_id = plan.school_id` simple**: rompería estos 8 planes legítimos. La validación correcta es «el niño tiene inscripción (`enrollments.child_id`) en la escuela del plan, o pertenece a ella».

### children_stats (3 filas)
Ids `2694ddb3…`, `a1d3de13…`, `f56655bc…`. Mismo niño, `school_id` de la fila = `531d5333…` (la escuela PT del entrenador 0394e265), stats de fuerza (sentadilla, prensa, extensión), `stat_date` 2026-04-18, creadas 2026-04-25 00:29:25 (mismo instante, carga por lote), `is_demo = false`. El único entrenador con plan en 531d5333 para ese niño es 0394e265, que además es owner de esa escuela. Veredicto: LEGÍTIMA (marcas de un cliente de PT cargadas por su entrenador).
Nota: el vector real sigue abierto (cualquier autenticado puede crearse un plan y quedar «entrenador»), pero **estas 3 filas no son evidencia de explotación**. El fix de `children_stats` debe contemplar este caso: acotar por inscripción del niño en la escuela de la fila, no por `children.school_id`, o estas 3 filas dejarían de ser visibles/editables para su entrenador.

### attendance_records (1 fila)
Id `87e25d30…`. `school_id = a1765dc1…` (escuela PT del entrenador 7c1d503c), niño de origen `90b2cc2e…`, `attendance_date` 2026-05-04, creada el mismo día, `marked_by = 7c1d503c…` (owner de a1765dc1, activo), `check_in_method = manual`, sin clase/equipo/sesión, y el niño **tiene 1 inscripción en a1765dc1**. Veredicto: LEGÍTIMA (el PT marcó asistencia de su cliente inscrito).

### class_enrollments
Tabla con **0 filas**. No hay nada que revisar; la observación de integridad es solo de diseño del CHECK.

### Conclusión parte 1
8/8 planes, 3/3 stats y 1/1 asistencia: LEGÍTIMAS. No se encontró explotación ya ocurrida, ni dato basura. Pendiente humano (no bloquea): confirmar con el acudiente del niño que sabe que está inscrito en dos escuelas PT (tema de consentimiento, no de seguridad técnica). Hallazgo colateral: la regla de negocio real es «cliente por inscripción», así que los fixes propuestos deben usar `enrollments`, no `children.school_id`.

## Parte 2 — Unsplash

80 URLs `images.unsplash.com` únicas en los 4 archivos (`idrd_avaladas_2026_fix_v2.sql`, `_apply_to_staging_consolidated.sql`, `seed_sportmaps_colombia.sql`, `20260210184500_seed_facilities.sql`). 66 devuelven 200 image/*. **14 devuelven 404 text/html**:

```
photo-1508344928-66a2f8b51c1b?w=1600&q=80
photo-1508344928-66a2f8b51c1b?w=400&q=80
photo-1517926116664-ac9be6dc9c05?q=80&w=2000&auto=format&fit=crop
photo-1538511637916-cfa05c2cf07a?w=1600&q=80
photo-1538511637916-cfa05c2cf07a?w=400&q=80
photo-1551773188-0801da12ddda?w=600
photo-1591741471265-8e8db8e0d063?w=1600&q=80
photo-1591741471265-8e8db8e0d063?w=400&q=80
photo-1599582909646-2117a6b1c46e?w=1600&q=80
photo-1599582909646-2117a6b1c46e?w=400&q=80
photo-1614632537190-23e4b8e66c66?w=400
photo-1622279488297-7b8e8a3a1d61?w=1600&q=80
photo-1622279488297-7b8e8a3a1d61?w=400&q=80
photo-1622484212850-eb596d769eab?w=400
```
(host `https://images.unsplash.com/`; 9 fotos distintas rotas.)

URL rota `photo-1591741471265-8e8db8e0d063` (patinaje) en la base viva: tabla `public.schools`, **26 filas en `cover_image_url` y las mismas 26 en `logo_url`** (variantes 1600 y 400). Contexto: 346 escuelas tienen algún `images.unsplash.com` en cover/logo, así que el resto de las 8 fotos rotas restantes también puede estar en `schools`; no se contó (consulta única pedida). No se eligió reemplazo.

## Parte 3 — Memoria desactualizada

En la base viva EXISTEN: `request_enrollment_withdrawal`, `request_enrollment_pause_v2`, `wa_crear_comprobante_por_clasificar` (funciones en `public`) y la tabla `public.wa_comprobantes_por_clasificar` (`to_regclass` no nulo). Por lo tanto las migraciones 20261106160001/04 y 20261118124124 **están aplicadas** (al menos sus objetos principales; no se comparó el cuerpo). La nota de memoria «SIN aplicar ni push» de referidos/plazos/retiro/pausa 11-06 está desactualizada.
