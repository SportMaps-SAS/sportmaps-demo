# Revisión adversarial: migración `wa_comprobantes_por_clasificar` + falsos positivos del detector I7

Fecha: 2026-11-18. Solo lectura: no se aplicó nada a la base ni se editó código o migraciones. Todo se verificó leyendo `supabase/migrations/`, el BFF y el spec.

---

## PARTE A. `20261118124124_wa_comprobantes_por_clasificar.sql`

### Estado del archivo

- `git status`: `??` (sin trackear, sin commit). `git log` sobre el archivo: vacío. La copia de `Downloads\monster-clinica\` es idéntica (`diff -q` sin salida).
- Por eso **aplica EDICIÓN en el sitio**: no hace falta migración nueva para corregir este archivo, siempre que NO esté ya aplicado en la base. Esto lo debes confirmar tú con una consulta puntual a `pg_proc` por nombre (`wa_crear_comprobante_por_clasificar`). El spec dice «sin migraciones aplicadas» y el BFF tiene el camino `migracion_pendiente`. Si ya está aplicado, cada corrección va en una migración nueva con timestamp posterior.
- Si editas, hay que regenerar el sha del ledger. El sha de este archivo queda en `supabase/migrations_ledger.json` (línea `20261118124124`, `85aceedd…`).
- `npm run migrations:check`: OK. 931 archivos, 931 registrados, head `20261118131559`, sin colisiones, ediciones ni borrados. Las 14 colisiones históricas son línea base aceptada.
- El ledger también trae `20261118131559_admin_ui_usage_resumen.sql`, que es otra migración sin commitear y NO es de esta revisión. Ojo al commitear con `--only`: el ledger mezcla las dos.

### Lo que verifiqué y está bien

| Punto | Resultado |
|---|---|
| `search_path` | Las 3 funciones: `SET search_path = pg_catalog, public, pg_temp`. OK |
| `GRANT`/`REVOKE` por RPC | `crear` y `aplicar`: `REVOKE ALL FROM PUBLIC, anon, authenticated` + `GRANT` solo a `service_role`. `descartar`: `REVOKE FROM PUBLIC, anon` + `GRANT authenticated`. Firmas del `REVOKE`/`GRANT` coinciden con las de `CREATE` (13 args, 4 args, 2 args). OK |
| Gate de `descartar` | `auth.uid()` no nulo, y `v_fila.school_id = ANY (user_admin_school_ids())` atado a la escuela de ESA fila, después de leer la fila con `FOR UPDATE`. No es el gate «admin de alguna escuela». OK |
| `user_admin_school_ids()` | Devuelve `uuid[]` (`COALESCE(ARRAY(...), '{}')`, nunca NULL). `= ANY (...)` es correcto. `GRANT EXECUTE` a `authenticated, service_role`. Sin él la policy daría 42501 (migraciones `20260814184457`, `20261028111254`). OK |
| I1 | No hay policy hacia `anon`; `REVOKE ALL … FROM anon`. OK |
| I2 | La policy es de SELECT y usa `user_admin_school_ids()`, no `user_school_ids()`. OK |
| I3 | Sin `FOR ALL`. Policy solo SELECT; INSERT/UPDATE/DELETE sin policy, así que RLS los rechaza. Además el `REVOKE` quita el privilegio de tabla. OK |
| I4 | Las 3 con `search_path` fijo. OK |
| `text + CHECK`, sin `CREATE TYPE` | OK. Las etiquetas del CHECK coinciden exactamente con la lista de la RPC. |
| FKs y columnas | `schools(id)`, `whatsapp_inbound_queue(id)`, `payments(id)`, `profiles(id)` (FK de negocio a `profiles`, como manda el CLAUDE.md) existen. `payments.ocr_reference` existe (`20260503000002`) y tiene índice único parcial `(school_id, ocr_reference)`. `whatsapp_inbound_queue.school_id` es `NOT NULL`, `error_message text` y `status` con CHECK `pending/processing/waiting_user/done/failed/ignored`. Los tres estados que usa el `UPDATE` (`failed`, `ignored`, `waiting_user`) existen. OK |
| `set_updated_at()` | Existe (`20260217000001`, `RETURNS trigger`). OK |
| `LIKE 'cerrado\_escuela:%'` | `LIKE` usa `\` como escape por defecto. Con `standard_conforming_strings = on` (default de Postgres y de Supabase) el literal conserva la barra, así que `\_` es un `_` literal. Es correcto y no necesita `ESCAPE`. El prefijo coincide con `PREFIJO_CERRADA = 'cerrado_escuela:'` del BFF. OK |
| Carreras en `crear` | Idempotencia por `queue_id` (índice único) + handler `unique_violation` que relee por `queue_id` o por referencia abierta, con `RAISE;` si no encuentra nada. Cubre el doble worker. OK |
| Carreras en `aplicar`/`descartar` | `SELECT … FOR UPDATE` sobre la fila; después chequean `estado`. OK dentro de la base (ver A-2 para la carrera en el BFF). |
| Firmas BFF ↔ RPC | `wa-comprobante-por-clasificar.service.ts:170` pasa los 13 `p_*` con los nombres exactos. `whatsapp-por-clasificar.routes.ts` llama `aplicar` con `p_id, p_payment_id, p_resolucion, p_por`, también exacto. El frontend llama `descartar` con `p_id, p_motivo`. OK |
| Ruta | Montada en `/api/v1/whatsapp`; cada endpoint pasa `requireAuth` + `administraEstaEscuela(user, schoolId)` y filtra siempre por `school_id`. El `ilike` escapa `%` y `_`. Los ids de dueño están acotados por escuela dentro de `wa_crear_cobro_desde_comprobante` (`20261111151130`, líneas 184–200). OK |

### Hallazgos

**Bloqueantes: ninguno.** No encontré nada que abra datos entre escuelas, ni que permita a un cliente escribir.

#### Importantes

**A-1. `waiting_user` cerrado con prefijo sigue vivo para el handler de respuestas de la familia** (migración, línea 232–238).
- El `UPDATE` solo escribe `error_message` y deja `status = 'waiting_user'`. Los handlers de la respuesta de la familia en `whatsapp-queue.job.ts` (líneas 2996, 4291, 4880, 4909, 5048, 5529) filtran por `status = 'waiting_user'` y NO miran el prefijo `cerrado_escuela:`. Las líneas 2137 y 4410 además cuentan `waiting_user` como fila «viva».
- Riesgo: la familia contesta la pregunta del bot después de que el comprobante pasó a «Por clasificar». El bot lo aplica por su cuenta y la fila de Cobros queda abierta: dos caminos sobre el mismo dinero. El antiduplicado por `ocr_reference` protege solo si el OCR leyó referencia.
- Corrección propuesta (edición, o migración nueva si ya está aplicada): en el `UPDATE`, sacar la fila de `waiting_user` con `status = CASE WHEN q.status = 'waiting_user' THEN 'ignored' ELSE q.status END` (`ignored` es válido en `chk_wa_queue_status` y es estado de bandeja). Verifica antes que ningún handler necesite leer esa fila como `waiting_user` después. Si prefieres no tocar la base, el equivalente es filtrar `error_message NOT LIKE 'cerrado\_escuela:%'` en esos 6 handlers.

**A-2. La ruta `aplicar`/`crear-servicio` estampa el comprobante ANTES de cerrar la fila y descarta el resultado del cierre** (`whatsapp-por-clasificar.routes.ts`, bloques `aplicar` y `crear-servicio`, el `supabase.rpc('wa_comprobante_por_clasificar_aplicar', …)` final).
- No se revisa `error` ni `cierre.ok`. Si la RPC falla (red, `ya_cerrado`, `pago_ajeno`), el cobro ya quedó con el comprobante en revisión pero la fila sigue abierta en Cobros. Si la escuela reintenta, `estamparComprobante` devuelve `duplicado` → 409 `referencia_ya_usada`: la fila ya no se puede cerrar salvo descartándola.
- Carrera: dos administradores aplican la misma fila a dos cobros distintos. Ninguno bloquea la fila antes de estampar. Si el OCR no trae referencia, los dos estampados pasan y solo uno cierra la fila.
- Corrección (BFF, no migración): revisar `error` y `cierre.ok`, loguear y devolver 500/409 con claridad. Tratar `ya_aplicado` como idempotente. Si el cierre responde `ya_cerrado` con otro `payment_id`, avisar. Opcional más robusto: una RPC `…_reservar(p_id)` que ponga la fila en un estado intermedio antes de estampar (requeriría ampliar el CHECK de `estado`).

#### Menores

**A-3. Super admin de plataforma ve y actúa en el BFF, pero no en la RPC ni en RLS** (líneas 124 y 338). `administraEstaEscuela` deja pasar a `platform_admins`; `user_admin_school_ids()` no los incluye. Un super admin puede listar desde el BFF pero no descartar desde el frontend ni leer la tabla directo. Si quieres paridad, agrega `OR public.is_super_admin()` en la policy y en el gate de `descartar`. Es decisión de producto.

**A-4. Policy sin envolver el helper en `SELECT`** (línea 124). `school_id = ANY (public.user_admin_school_ids())` se evalúa por fila. Mejor `school_id = ANY ((SELECT public.user_admin_school_ids()))` (initPlan, una vez por consulta). La tabla es pequeña, así que el efecto es mínimo, pero encaja con el cuidado de Disk IO.

**A-5. Referencia sin normalizar en el antiduplicado** (línea 155 y 192–195). Solo se hace `btrim`. Si `estamparComprobante` normaliza la referencia distinto al guardar `payments.ocr_reference` (mayúsculas, ceros, guiones), el chequeo falla en silencio. Verifica que la normalización sea la misma en ambos lados.

**A-6. Sin límite de tamaño en `propuesta` jsonb ni en `storage_path`** (líneas 63, 209–210). Solo la llama `service_role`, así que el riesgo es bajo. Un `CHECK (pg_column_size(propuesta) < 20000)` basta.

**A-7. Idempotencia por `queue_id` antes de comprobar la escuela** (líneas 177–180). Si el `queue_id` ya existe, devuelve esa fila aunque `p_school_id` no coincida. Solo `service_role`, sin fuga real. Mover el chequeo `cola_ajena` antes lo deja estricto.

**A-8. `CREATE TRIGGER` y `CREATE POLICY` no son idempotentes** mientras el resto usa `IF NOT EXISTS` (líneas 109 y 120). Va dentro de `BEGIN/COMMIT`, así que es atómico, pero si alguien reaplica a mano con la tabla ya creada falla. Agregar `DROP TRIGGER/POLICY IF EXISTS` antes.

**A-9. Índice faltante en `payment_id` y `resuelto_por`** (líneas 67 y 70). Con `ON DELETE SET NULL`, un borrado en `payments` o `profiles` escanea esta tabla. Es chica y no urge.

**A-10. El spec quedó desactualizado frente a la migración.** El spec habla de `wa_crear_cobro_por_clasificar`, `wa_clasificar_cobro` y una fila en `payments` con categoría `por_clasificar`. La migración implementa lo que el spec dejó como alternativa: tabla propia y RPC `wa_crear_comprobante_por_clasificar` / `…_aplicar` / `…_descartar`. El spec sigue en «PROPUESTA» y falta la decisión D1 sin dueño. Actualizar el spec antes de cerrar la fase 2.

**A-11. Columna `avisado_at` sin consumidor visible** (línea 73). El spec exige aviso a las 24 h. No encontré el job en el diff; es la parte pendiente de la fase 3.

**A-12. Orden dentro del worker.** `pasarAPorClasificar` se llama dentro de `cerrar()`. Confirma que el `UPDATE` del worker que escribe `status`/`error_message` corre ANTES de la RPC. Si corre después, pisa el prefijo `cerrado_escuela:` y la fila reaparece en la bandeja. No pude verificarlo sin ejecutar.

---

## PARTE B. Detector I7: 14 RPC `SECURITY DEFINER` «sin gate»

Contexto: `request_enrollment_withdrawal` ya estaba verificada como falso positivo. Todas las demás se revisaron en su definición más reciente.

Veredicto global: **13 de 13 son FALSO POSITIVO en cuanto a acceso entre escuelas o usuarios.** El detector solo busca `auth.uid()` o `user_*_school_ids()` en el cuerpo y no ve el gate cuando vive en una función auxiliar, en la función interna de un envoltorio, o cuando el único control es un token secreto. Hay **un caso con una observación real pero menor** (`get_personal_trainer_school_id`).

Dato importante sobre las migraciones `20261106160001` y `20261106160004`: según tu memoria están **sin aplicar** («SIN aplicar ni push; LEEME en docs/migraciones-para-aplicar-2026-11-06»). Los veredictos valen para el texto, y vendrá bien confirmarlo con una consulta a `pg_proc` antes de aplicar.

### B.1. Grupo referidos (`20261106160001_referidos_campanas_y_motor.sql`)

Gate común: `_referral_assert_scope(p_school_id, p_actor, p_write)` (línea 223), llamado en la primera línea útil de cada RPC.

Cómo funciona:
- `v_actor := COALESCE(auth.uid(), p_actor)`: si hay JWT de usuario, **`auth.uid()` gana y `p_actor` se ignora**. Un `authenticated` no puede suplantar a nadie pasando `p_actor`.
- Con JWT de usuario: `is_super_admin() OR p_school_id = ANY (user_admin_school_ids())` para escritura, y se suma `user_staff_school_ids()` para lectura.
- Solo si `auth.uid()` es NULL (service_role) se acepta `p_actor`, validado contra `platform_admins`, dueño o `school_members` con rol admin/owner.
- Si no hay actor devuelve NULL; eso solo lo alcanza `service_role` porque `anon` y `PUBLIC` no tienen `EXECUTE` (`REVOKE … FROM PUBLIC, anon`).
- El helper tiene `REVOKE ALL … FROM PUBLIC, anon, authenticated` (línea 271): correcto, es el caso «helper que solo llaman otras definer».

| RPC | Gate real (dónde) | ¿`authenticated` sobre escuela ajena? | Veredicto |
|---|---|---|---|
| `upsert_school_discount_campaign` | `_referral_assert_scope(p_school_id, p_actor, true)` (línea 390). Escritura = administración. | No: un admin de la escuela A pasando `p_school_id` de B recibe 42501. | FALSO POSITIVO |
| `register_enrollment_referral` | `_referral_assert_scope(..., true)` (línea 438) + `enrollments.school_id = p_school_id` (`REF_INSCRIPCION_NO_ENCONTRADA`) + `_referral_check_pair` valida que el referente sea de la misma escuela (`REF_REFERENTE_NO_ENCONTRADO`). | No. Ni la inscripción ni el referente pueden ser de otra escuela. | FALSO POSITIVO |
| `update_enrollment_referral` | Lee `school_id` de la fila del referido, **no del parámetro**, y llama `_referral_assert_scope(v_school, …, true)` (línea 540). | No: el alcance se ata a la escuela de ESE `p_referral_id`. | FALSO POSITIVO |
| `qualify_enrollment_referrals` | `_referral_assert_scope(p_school_id, …, true)` (línea 619). | No. | FALSO POSITIVO |
| `referrals_report` | `_referral_assert_scope(p_school_id, …, false)` (línea 770): lectura admin o staff. Es `STABLE`; solo SELECT. | No: otra escuela da 42501. | FALSO POSITIVO |

Nota menor: `register_enrollment_referral` toma `pg_advisory_xact_lock('referidos:'||school)` después del gate, no antes: bien, un no autorizado no puede bloquear a nadie.

### B.2. Grupo retiro/pausa (`20261106160004_retiro_y_pausa_por_canales.sql`)

Gate común: `retiro_actor(p_actor)` (línea 111) + `retiro_titular(enrollment, uid)` (línea 155) o `retiro_es_admin(school, uid)` (línea 134).
- `retiro_actor`: `auth.uid()` si existe; `p_actor` **solo si `auth.role() = 'service_role'`**; si no, `RAISE 'Sesión requerida'`. Un `authenticated` no puede inyectar `p_actor`.
- `retiro_titular`: devuelve `'parent'` solo si `children.parent_id = uid`, `'athlete'` solo si `enrollments.user_id = uid`, y NULL en otro caso (la RPC lanza «No autorizado»).
- Los helpers tienen `REVOKE ALL … FROM PUBLIC, anon, authenticated` y `GRANT` solo a `service_role` (líneas 278–291).

| RPC | Gate real | ¿`authenticated` sobre usuario/escuela ajena? | Veredicto |
|---|---|---|---|
| `request_enrollment_reactivation` | `retiro_actor` (línea 725) y `retiro_titular(p_enrollment_id, v_caller)` (línea 738): solo el acudiente o el atleta adulto de ESA inscripción. | No. Un acudiente de otro niño no es titular de esta inscripción. | FALSO POSITIVO |
| `cancel_enrollment_request` | `retiro_actor`; la solicitud se lee por `p_request_id` y se exige `requested_by = v_caller` **o** `retiro_es_admin(school_de_la_solicitud, v_caller)` (líneas 1043 y 1058). Solo estados pendientes. | No: solo quien la pidió o la administración de la escuela de esa solicitud. | FALSO POSITIVO |
| `request_enrollment_pause_v2` | `retiro_actor` (línea 435) + `retiro_titular` (línea 449), con `pg_advisory_xact_lock` por inscripción después del gate. | No. | FALSO POSITIVO |

### B.3. Resto

| RPC | Gate real (dónde) | ¿Acceso ajeno? | Veredicto |
|---|---|---|---|
| `get_tactical_shared_play(p_token)` | Es **pública a propósito** (`anon` + `authenticated`, `20261027112704` línea 14 y 74). El control es el token: 18 bytes de `gen_random_bytes` (144 bits), validado con regex `^[A-Za-z0-9_-]{16,64}$`, búsqueda por índice único y `status = 'active'`. Devuelve solo `title/sport/payload/created_at`; `create_` quita `playerNames/notes/videos`. No hay `school_id`, `created_by` ni listado. | No hay enumeración: el token no se adivina. Es un secreto tipo capability (exactamente el patrón que el CLAUDE.md pide para «token» en una RPC en vez de una policy). `20261028111254` la lista como excepción pública deliberada. | FALSO POSITIVO. Menor: los enlaces no vencen solos (solo `revoke_`). |
| `request_athlete_certificate` | La versión vigente es un **envoltorio** (`20260921204955`, línea 121) que solo valida `school_is_operational` y delega a `request_athlete_certificate__interno` (`REVOKE ALL … FROM PUBLIC, anon, authenticated`, solo `service_role`). El gate está en la función original (`20260424000004`, líneas 294–400): `is_super_admin() OR is_school_admin(p_school_id)` o `p_profile_id = auth.uid()` o `children.parent_id = auth.uid()`. Además valida que el niño (o el perfil como miembro activo) sea de `p_school_id` y que la plantilla sea de esa escuela. `auth.uid()` se conserva al delegar. | No: el cross-tenant se valida (42501). | FALSO POSITIVO. Nota: el detector lee el envoltorio, que no contiene el gate. |
| `issue_athlete_certificate` | Mismo patrón envoltorio (línea 161) → `__interno`. Gate en el original (`20260424000004`, línea 407): `is_super_admin() OR is_school_admin(v_cert.school_id)`, con el `school_id` de LA constancia. Y exige pago `paid` si estaba `pending_payment`. | No. | FALSO POSITIVO |
| `create_school_join_qr` | Envoltorio (línea 60) → `__interno`. Gate en el original vigente (`20260625000002`, línea 186): `is_super_admin() OR is_school_admin(v_school_uuid)` sobre el `p_school_id` recibido, `42501 Forbidden`. `20260930131401` cerró el `EXECUTE` a `anon`. | No. | FALSO POSITIVO |
| `get_personal_trainer_school_id(p_user_id)` | **No tiene gate**: devuelve el id de la escuela `personal_trainer` cuyo `owner_id = p_user_id`. Es un helper de RLS usado en 19–23 policies (siempre con `auth.uid()`), y por eso `20261025020013` le devolvió `EXECUTE` a `authenticated`. La definición NO está en `supabase/migrations/` (deriva de esquema sin versionar); salió de `supabase/qa-twin/dump/01_public.sql` línea 22537. | Sí, pero de bajo impacto: cualquier `authenticated` puede llamar `rpc('get_personal_trainer_school_id', {p_user_id: <uuid ajeno>})` y obtener el `school_id` de un entrenador personal si conoce su uuid. No devuelve datos personales ni permite actuar sobre nada. Es un oráculo de enumeración uuid → escuela, de severidad baja (el propio CLAUDE.md acepta este trade-off para helpers de RLS). Además la función tiene `search_path = public` sin `pg_catalog, pg_temp`. | **REAL, severidad baja (hay que anotar, no urge).** Ver abajo. |

#### Fix propuesto para `get_personal_trainer_school_id` (migración NUEVA, no se aplicó nada)

Las policies la llaman siempre con `auth.uid()`; solo hay 4 menciones con `p_user_id` y son la propia definición. Se puede atar el parámetro al caller sin romper policies:

```sql
-- Plantilla; recrear con CREATE OR REPLACE y conservar el GRANT a authenticated (NO revocar: 19+ policies).
CREATE OR REPLACE FUNCTION public.get_personal_trainer_school_id(p_user_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.id
    FROM public.schools s
   WHERE s.owner_id = p_user_id
     AND s.school_type = 'personal_trainer'
     AND (p_user_id = auth.uid() OR public.is_super_admin())   -- solo el propio uid
   LIMIT 1;
$$;
-- GRANT EXECUTE … TO authenticated, service_role ya existe; REVOKE de anon se mantiene.
```

Riesgo del cambio: policies evaluadas con un `p_user_id` distinto de `auth.uid()` dejarían de devolver escuela. El dump muestra que no existen. Aun así, mide con sesión simulada (`set_config('request.jwt.claims', …)` + `select count(*)` en `athlete_goals`, `training_logs`) y respeta la regla de una sola sesión aplicando migraciones y no regenerar `types.ts` por esto.

### B.4. Conclusión de I7 y mejora del detector

- 13 de 13 revisadas son falsos positivos de acceso. 1 tiene un hallazgo menor real (oráculo de uuid → escuela), no explotable para actuar sobre datos.
- Tres patrones explican los falsos positivos y conviene enseñárselos a `invariantes_seguridad()`:
  1. **Gate delegado a helper**: `_referral_assert_scope`, `retiro_actor` + `retiro_titular`/`retiro_es_admin`. Regla propuesta: tratar como gate una llamada a una función cuyo cuerpo contiene `auth.uid()` o `user_*_school_ids()`.
  2. **Envoltorio + `__interno`**: el gate vive en la función renombrada. Seguir la llamada a `<nombre>__interno`.
  3. **Capability por token**: `get_tactical_shared_play`. Una RPC con parámetro `*_token` comparado contra una columna única no debería marcarse. Ponerla en una lista de excepciones documentada.
- Nota de higiene (sin acción de seguridad): `request_athlete_certificate__interno` e `issue_athlete_certificate__interno` y `create_school_join_qr__interno` conservan `SET search_path = public` (sin `pg_catalog, pg_temp`). I4 no se viola (está fijo), pero no cumple la plantilla del CLAUDE.md. Si algún día las tocas, corrígelo en esa misma migración.
