# Estado de cuenta con enlace para las familias (envío anual y a pedido)

**Estado (2026-11-12):** plan APROBADO por Brayan con los valores por defecto (60 días, asistencia resumida). FASE 1 construida en `develop`, sin commit. La migración `20261112122901_estado_cuenta_enlaces` está escrita y **sin aplicar**. Ver §8.
**Primer cliente:** Club Deportivo Besser (marca negro `#030303`, rojo `#E3000F`, amarillo `#FFCC00`).
**Fecha:** 2026-11-12 · **Autor:** Brayan + Claude

## 1. Qué se quiere

La escuela le manda a cada acudiente un estado de cuenta claro: mes a mes, qué se cobró, cuándo era el límite, cuándo y cómo se pagó, si fue puntual, y cómo le fue en asistencia. Para revisarlo con cada familia, una vez al año o cuando la escuela lo pida.

Lo que ya existe y se reutiliza:
- La pantalla V2 del estado de cuenta (`EstadoCuentaAcudiente`, con `modo="escuela"` y el modal de la escuela). Fechas, puntualidad, abono, cómo pagó, asistencia por mes, «Ver comprobante».
- El patrón de enlace público de un cobro (`/p/:token`, tabla `payment_public_tokens`): token de 144 bits, RLS sin policies, solo `service_role`, estados `active/replaced/revoked`, vigencia, contador de aperturas.
- El envío mensual por familia (`estado-de-cuenta.service.ts`): un mensaje por familia, horario de cobranza, un contacto por día, idempotencia en `email_sends`.
- El correo con marca de la escuela (`buildBrandedEmail` + `resolveSchoolBranding`).

## 2. Decisiones de producto (con el valor por defecto que se propone)

| # | Decisión | Propuesta |
|---|---|---|
| D1 | Qué es «anual» | Los últimos 12 meses hasta el día del envío (Besser solo tiene unos 3 meses de historia: se muestra lo que hay). Tope técnico de la RPC: 36 meses. |
| D2 | Una familia, un enlace | Un enlace por acudiente y escuela, con todos sus hijos. No un enlace por hijo. |
| D3 | Vigencia del enlace | 60 días. Un reenvío dentro de los últimos 7 días reutiliza el mismo enlace (igual que `/p/:token`). Tope 90. |
| D4 | Qué ve quien abre el enlace | Mes a mes por hijo: fecha límite, fecha de pago, puntualidad, valor cobrado y pagado, cómo pagó, y asistencia **resumida por mes** (cuántas clases, faltas). No ve fechas de cada clase, ni imágenes de comprobantes, ni documentos, correos ni teléfonos. |
| D5 | Nombre del deportista | Nombre corto («Valentina O.»), como la página `/p/:token`. |
| D6 | Quién puede enviar | `owner`, `admin`, `school_admin` (los de `canManageCharges`). El coach no. |
| D7 | Canal | Fase 1: correo (sin depender de Meta). Fase 2: WhatsApp con plantilla aprobada, solo a quien dio su consentimiento. Un solo canal por familia y día (Ley 2300). |
| D8 | Cobros abiertos en el enlace | Fase 1: el enlace es solo de lectura y lleva un botón «Pagar» que abre el enlace de cobro que ya existe. Fase 2: botón por cobro. |
| D9 | PDF | Se guarda desde la propia página (imprimir del navegador), con la marca de la escuela. No hay generador de PDF en el servidor. |
| D10 | Factura electrónica | Fuera de alcance. Besser no la tiene habilitada. Cuando exista, se suma una columna «Factura». |

## 3. Datos que NO salen nunca por el enlace

Correo, teléfono o documento de nadie; ids internos; imágenes de comprobantes; referencias bancarias; notas internas de la escuela; datos de otros atletas que no sean de esa familia.

## 4. Diseño técnico

### 4.1 Base de datos (migración nueva, una sola sesión la aplica)

Tabla `public.estado_cuenta_enlaces`, calcada de `payment_public_tokens`:

| Columna | Detalle |
|---|---|
| `id` | uuid, PK |
| `school_id` | FK a `schools`, `ON DELETE CASCADE` |
| `familia_clave` | text: correo en minúscula o `wa:<wa_id>`; la misma clave de `agruparPorFamilia` |
| `atletas` | jsonb: `[{ "tipo": "hijo"\|"adulto"\|"ficha", "id": "<uuid>" }]`, fotografía de a quiénes cubre |
| `desde`, `hasta` | date: el período que muestra |
| `token` | text único, `CHECK (token ~ '^[A-Za-z0-9_-]{24}$')`, 18 bytes de pgcrypto |
| `status` | text + CHECK: `active` / `replaced` / `revoked` |
| `expires_at`, `open_count`, `last_opened_at`, `created_at`, `created_by` | `created_by` es el perfil que envió |

- Un solo `active` por (`school_id`, `familia_clave`, `hasta`): índice único parcial.
- RLS activa y **sin policies**. `REVOKE ALL … FROM PUBLIC, anon, authenticated`; `GRANT ALL … TO service_role`. El token es la credencial: nunca una policy «by_token».
- Dos RPC `SECURITY DEFINER` con `SET search_path = pg_catalog, public, pg_temp`, solo `service_role` (revocadas explícitamente a `anon` y `authenticated`):
  - `estado_cuenta_enlace_emitir(p_school_id, p_familia_clave, p_atletas jsonb, p_desde date, p_hasta date, p_created_by uuid, p_dias int default 60)`: reutiliza el `active` si le quedan más de 7 días; si no, lo pasa a `replaced` y emite uno nuevo. Serializa con `pg_advisory_xact_lock`.
  - `estado_cuenta_enlace_resolver(p_token text)`: devuelve escuela, atletas, período y estado; suma `open_count`.
- Estados en `text + CHECK`, no `CREATE TYPE`. FKs de negocio a `profiles(id)`.
- Verificación al aplicar: `npm run seguridad:invariantes` y `set local role anon; select count(*) from public.estado_cuenta_enlaces;` debe fallar con 42501.
- Se crea con `npm run migrations:new -- estado-cuenta-enlaces`, se commitea el `.sql` con `migrations_ledger.json`. Se aplica con una sola sesión, por una vía que deje rastro, y `types.ts` se regenera una sola vez al final.

### 4.2 BFF

- `services/estado-cuenta-enlace.service.ts`: emite el enlace, y arma el contenido público con **funciones puras** (recorte de datos de la sección 3 y nombre corto). Lee en lote con `.in('id', ids)`: pagos de los hijos del período, asistencia agregada por mes y nombres. Nada de una consulta por fila.
- Rutas públicas `GET /api/v1/public/estado-cuenta/:token` con el mismo manejo que `/p/:token`: 404 `no_existe` (token mal formado e inexistente indistinguibles), 410 `vencido` / `revocado`. Limitador por IP y por token.
- Ruta autenticada `POST /api/v1/estado-cuenta/enviar` (gate `canManageCharges` **dentro** de la ruta, atado a la escuela del llamador): `{ atleta, canal, simular }`. Con `simular: true` no manda nada y devuelve a quién llegaría y por qué canal.
- Correo con `buildBrandedEmail` y los colores de la escuela: resumen (debe, pagado, puntualidad, asistencia), botón «Ver mi estado de cuenta» al enlace y, si debe algo, «Pagar».
- Idempotencia: id determinístico en `email_sends` por escuela + familia + período. Un reenvío es una acción explícita («Reenviar»), no un efecto de reintentar.
- Reglas de contacto: horario de cobranza (L-V 7-19, sáb 8-15, nunca domingos ni festivos), un contacto por familia y día, salta a quien ya recibió un aviso hoy. Mismo criterio que `estado-de-cuenta.service.ts`.
- Registro en `audit`: quién envió, a quién, cuándo, por qué canal.

### 4.3 Frontend

- Página pública `/e/:token` (fuera del login) que reutiliza `EstadoCuentaAcudienteView` con una variante `modo="publica"`: sin botones de pagar propios, con «Pagar» hacia el enlace de cobro, con la marca de la escuela (logo, color primario) y «Guardar como PDF».
- En el modal de la escuela: botón «Enviar al acudiente» (con confirmación y la simulación a la vista: «Llega a carolina@… por correo»), y «Reenviar» si ya se envió.
- Fase 2: «Enviar a todos los que deben» desde el Ciclo de Mes, siempre con simulación previa.
- `statementPrint.ts` recibe la marca de la escuela y genera el PDF con el diseño del ejemplo de Besser (encabezado de marca, mes a mes, asistencia). Modelo visual: `c:\tmp\estado-de-cuenta-besser-ejemplo.pdf`.

## 5. Pruebas (todas antes de enviar a una familia real)

- Puras: recorte de datos (ningún campo prohibido de la sección 3 sale), nombre corto, período, familia con dos hijos, hijo sin cuenta (ficha), adulto con cuenta, atleta sin cobros, becado en $0, pagos sin fecha, abono, cobros anulados.
- Seguridad de la tabla: `anon` y `authenticated` no leen ni escriben; token mal formado y token inexistente responden igual; vencido y revocado se distinguen; el límite por IP y por token corta.
- Contacto: fuera de horario no se envía; domingo y festivo no se envía; segundo envío el mismo día no se envía; `simular` nunca escribe en `email_sends`.
- Contra los datos reales de Besser, en solo lectura y sin enviar nada: generar el contenido de las ~69 familias y revisar que ninguna salga vacía ni con datos de otra familia. La simulación de envío se revisa con la escuela antes del primer envío real.
- Rendimiento: el contenido de todas las familias de una escuela sale con un número fijo de consultas (no crece con las familias).

## 6. Fases

1. **Base + enlace + correo.** Migración, servicio, rutas, página pública, botón «Enviar al acudiente», simulación.
2. **PDF con marca** desde la página y desde el modal de la escuela.
3. **WhatsApp:** plantilla nueva (la aprueba Meta) y envío solo a quien dio su consentimiento.
4. **Envío en lote** desde el Ciclo de Mes y botón «Pagar» por cobro.

Cada fase termina con sus pruebas pasando. Se trabaja en `develop`; staging y `main` los sube el usuario.

## 7. Riesgos conocidos

- El enlace es una credencial: quien lo reenvíe da acceso a lo de la sección 4 durante 60 días. Por eso la sección 3 es corta a propósito y existe `revoked`.
- Datos de Besser a corregir antes del primer envío: 3 pagos «pagados» sin fecha de pago, 2 transferencias sin comprobante, 5 pagos sin pagador identificado, 3 pagos registrados a mano sin medio.
- La plantilla de WhatsApp depende de la aprobación de Meta (días). La fase 1 no depende de ella.
- Aplicar la migración sube la carga del catálogo de PostgREST: se hace en una sola sesión, sin otras migraciones en paralelo.

## 8. Estado de la fase 1 (2026-11-12)

**Construido (develop, sin commit):**
- Base: `supabase/migrations/20261112122901_estado_cuenta_enlaces.sql` (tabla + 2 RPC solo `service_role`). **Sin aplicar.** Pasa `npm run migrations:check`.
- BFF: `estado-cuenta-enlace.contenido.ts` (puro: qué sale por el enlace y el correo), `estado-cuenta-enlace.service.ts` (token, lectura en lote, envío), `routes/estado-cuenta-enlace.routes.ts` (`GET /api/v1/public/estado-cuenta/:token`, `POST /api/v1/estado-cuenta/enviar`), montadas en `index.ts`.
- Frontend: `/e/:token` (`EstadoCuentaPublicoPage`), el modo `publica` de la pantalla V2, «Enviar al acudiente» (simula, confirma, envía, «Reenviar»), cliente `lib/api/estadoCuentaEnlace.ts`.
- Cambio de diseño respecto al plan: el enlace muestra el estado **en vivo** de los últimos 12 meses cada vez que se abre (no una fotografía); por eso la tabla guarda `meses`, no `desde/hasta`.
- La RPC `get_athlete_account_statement` NO se usa desde el BFF: se probó en solo lectura y da `42501` para el rol de la consola; el resumen se calcula en el BFF con la misma fórmula y se verificó contra la base (ver abajo).

**Verificado con los datos reales de Besser (solo lectura, sin enviar nada):**
- El resumen (esperado, liquidado, mora) coincide con la cuenta de la base para los **78 atletas**.
- El contenido de los 78 atletas no filtra apellidos, correos, rutas de archivo ni ids. La prueba encontró un error de la carga («Sngel Felipe Torres» por «Ángel Felipe Torres») que dejaba los apellidos en el concepto; se reforzó la limpieza.
- 42 comprobantes, 202 cobros visibles; 3 atletas sin cobros vigentes (todos anulados).

**Pruebas:** BFF 141 (contenido 39, rutas 31, y las del cobro y del estado de cuenta mensual); frontend 106 en estado de cuenta, página pública y botón de envío.

**Para salir a producción (en este orden):**
1. Aprobar la aplicación de la migración. Una sola sesión, sin otras migraciones en paralelo. Después: `set local role anon; select count(*) from public.estado_cuenta_enlaces;` debe dar 42501, y `npm run seguridad:invariantes`. Regenerar `types.ts` una vez.
2. Arreglar en Besser los datos de la sección 7 (3 pagados sin fecha, 5 sin pagador, 2 transferencias sin comprobante).
3. Simular desde el modal de la escuela con 3 familias reales y revisar a quién llegaría.
4. Primer envío real a UNA familia (la de Brayan) dentro del horario de cobranza, abrir el enlace desde el celular y verificar el correo.
5. Recién ahí, el resto.
