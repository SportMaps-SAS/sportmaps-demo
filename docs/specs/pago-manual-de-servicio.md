# Cobro de servicio unificado (clínica, torneo, viaje…) — plan

**Versión 0.2 · 2026-11-11 · Estado: plan para revisar. No hay nada construido. Primero Monster.**

Reemplaza a la v0.1. Sale de cuatro investigaciones de solo lectura (panel, bot, base de datos, app) hechas el 11-nov sobre
la clínica de armadores y atacantes de Monster's Volley Club. Marcas: **[V]** verificado en código o base viva ·
**[P]** propuesto · **[DEC]** decisión humana · **[RLS]** toca permisos.

---

## 0. Qué falla hoy (resumen)

Un mismo cobro puede nacer por tres caminos —la escuela en la app («Cobros y pagos»/cobro por equipo), el bot de WhatsApp y el
registro manual— y **no se reconocen entre sí**. Consecuencias vistas el 11-nov:

1. **Carlos Martínez** (atleta de Mixto Mayores Profundización) pagó $175.000 por WhatsApp. El bot no lo reconoció como del
   club y creó un cobro externo de $300.000 en «parcial», mientras su cobro de la escuela ($175.000) seguía pendiente. [V]
2. **Aleja**: el cobro quedó con el nombre del perfil de WhatsApp («Aleja 💫»). El nombre real que ella escribió no se guardó
   en ningún sitio. [V]
3. **El panel «Pagos recibidos»**: el abono de Emiliano ($150.000) no aparece; Carlos muestra $300.000 en vez de lo recibido;
   los pagos por validar no están en esa pestaña; los cobros pendientes de la escuela no salen en Gestión de Pagos. [V]
4. Los cobros que la escuela creó por equipo («Clínica Jorge Mesa — …», $175.000) están como «Otro cobro», **sin ligar al ítem**:
   no cuentan para cupos, reportes ni el mínimo de 5. [V]

## 1. Reglas de negocio (Iván, 2026-11-11)

| Quién | Hasta 15-nov | Después del 15-nov |
|---|---|---|
| Afiliado sin descuento | $250.000 | $300.000 |
| Afiliado con 30 % de grupo (mín. 5 de la **misma categoría**, no se suman categorías) | $175.000 | $210.000 |
| Externo | $300.000 (preventa hasta 10-nov 11:59 pm) | $350.000 desde 11-nov |

Abono del 50 % aparta el cupo con ese valor. Saldo antes del 20-nov. Un joven de 21 años puede participar.

## 2. Panel de Cobros y pagos (frontend) — [V] causas, [P] arreglos

`PaymentsAutomationPage.tsx` tiene cambios sin commitear de otra sesión: se trabaja sobre esa copia, **sin commitear lo ajeno**.

| # | Causa verificada | Arreglo propuesto |
|---|---|---|
| P1 | El historial pinta `amount` (valor del cobro), no lo recibido (líneas ~2496 y ~2603). Carlos: $300.000 en vez de $175.000 | En `partial`, mostrar «Recibido $X de $Y» (`amount_paid`) |
| P2 | Un `awaiting_approval` manual (con comprobante) va a la cola «Por validar», no a «Pagos recibidos»; su abono vive en `ocr_amount`, no en `amount_paid` | Mostrar «Por validar · abono $150.000 (leído del comprobante)» en la cola; aviso «N por validar» en «Pagos recibidos». No mezclar por validar con recibidos |
| P3 | Con sede activa el filtro es `branch_id = X`: 15 de 19 cobros sin sede son de clínica y desaparecen | Que el filtro incluya «Sin sede» (ya lo dice el comentario de ~l.934) y que el bot cree cobros con sede. [DEC] multisede |
| P4 | Los cobros `pending` sin comprobante no están en Gestión de Pagos (solo Finanzas y el modal) | Texto claro en la pestaña; el cobro pendiente visible con etiqueta |
| P5 | El modal «Cobros y pagos» usa `chargeCategoryOf` (clasificación vieja): «clínica» → «otro» | Usar `tipoDeCobro()` y `TipoDeCobroBadge` también en el modal |

`tipoDeCobro()` clasifica bien los cuatro casos [V]: no se toca. Pruebas: caso `{otro, «Clínica Jorge Mesa — X»}` → `clinica`;
fila `partial` del historial con `amount_paid`; extraer a función pura la regla de `rawHistoryPayments` para probarla.

## 3. Bot de WhatsApp (BFF)

Causas [V]: (a) `wa_es_afiliado` exige teléfono y ficha activa; el contacto de Carlos es un alias `wau-…` y su ficha está
inactiva (**consolidada** con su perfil, no se «activa»). (b) `cobroPrevioDelServicio` solo busca por child/unregistered/lead,
exige categoría `clase_extra` y el nombre del ítem en el concepto; el cobro de la escuela es `otro`, «Clínica Jorge Mesa» y
dueño `user_id`. (c) Aleja: la fila de cola cerró como `payment_receipt` sin pasar por la pregunta del nombre (probable camino
previo a la venta); el nombre tardío solo se procesa si hay una fila en espera de esa pregunta.

[P] Cambios:
1. `cobroAbiertoDelAtleta(schoolId, {userId, childId, unregisteredId, leadId}, item)`: **una** lectura (sin N+1) antes de
   decidir monto; sin filtro de categoría; ligado por ítem (columna nueva, §4), no por texto. Si hay 2 o más abiertos: a la escuela.
2. Contacto `wau-…`: resolver al atleta por el nombre dado en la venta; aplicar **solo** si coincide exactamente un atleta con
   cobro abierto y el monto cuadra (riesgo: pago cruzado entre homónimos; precedente Ethann, 05-nov).
3. Montos contra el cobro abierto: igual → pago completo; ≥ 50 % → abono; otro valor → a la escuela con propuesta.
4. Pedir el nombre siempre que el del lead sea el del perfil de WhatsApp (no solo «Prospecto»).
5. Camino «nombre tardío» (≤ 48 h tras un comprobante con concepto de relleno): actualizar lead, concepto del pago y
   acompañante (marca «Acompañante:»), sin tocar monto ni estado.
6. Convertir el N+1 de la «red de seguridad» (`whatsapp-queue.job.ts` ~2083-2100) en una sola lectura; **escribir su prueba**.
7. Nunca prometer «anotado» sin haber guardado.

## 4. Base de datos — una sola sesión aplica migraciones; plan aprobado antes de código

Todo con `npm run migrations:new`, `SET search_path = pg_catalog, public, pg_temp`, `GRANT EXECUTE` explícito, text+CHECK, sin enums.

**4.1 Modelo del ítem** [P]: `school_tournament_items.descuentos_grupo jsonb` (`[{clave,pct,minimo,por:'equipo'}]`) y
`precios_afiliado_por_fecha jsonb`. El descuento es **porcentaje** sobre el precio de afiliado vigente (no un valor fijo):
250.000×0,7 = 175.000; 300.000×0,7 = 210.000. Se congela en el cobro (`list_amount`, `discount_pct`, `discount_amount`;
cumple `payments_amount_invariante`). Función interna `_servicio_precio_vigente`.

**4.2 Tabla de enlace propia** `cobros_servicio_item` [P][RLS]: payment_id PK, school_id, item_id, dueño (child|user|unregistered|lead),
origen (manual|ligado_escuela|comprobante_app|comprobante_bot), es_abono, precio_acordado + motivo, team_id, idempotency_key,
anulado_*. RLS activo, sin policies, solo service_role. No se reutiliza `wa_cobros_sueltos` (exige parent_id y canal whatsapp).
Los cupos de las dos RPC del bot pasan por `_servicio_cupos_vivos(item)` para que los tres caminos cuenten igual.

**4.3 RPC `registrar_pago_servicio_manual`** [P][RLS]: gate adentro (`user_admin_school_ids()`/super admin, si no 42501);
dueño exactamente uno de 4 (incluye `p_user_id`); método `transfer|cash`; `p_idempotency_key` obligatoria; referencia en
`receipt_number`/`receipt_reference_norm` (no `payments.reference`, único global); precio vigente a la fecha del pago; precio
acordado con motivo ≥ 10 caracteres [DEC quién]; si ya hay cobro vivo del ítem, abono/saldo con `_registrar_pago_en_cobro`;
si no, INSERT directo `paid|partial` (no `pending`, para no disparar avisos). Motivo y acuerdo en el enlace, no en `notes` (límite 500).

**4.4 `ligar_cobro_a_servicio`** (no cambia `amount`; rellena descuento) y **`aplicar_comprobante_a_cobro_abierto`** (solo
service_role; llave school + dueño + ítem; 2 o más candidatos → `ambiguo`; en revisión → `en_revision`; sobrepago → saldo a
favor; idempotente por `queue_id`). **`reclasificar_pago_servicio`** con el mismo gate.

**4.5 Reconocer atletas con cuenta/inactivos** [P]: `wa_crear_cobro_desde_comprobante` acepta `p_user_id` (atleta con
`school_members` activo) y no exige `is_active` en el unregistered con vínculo vivo. Sin tocar `wa_es_afiliado` ni abrir RLS.

## 5. App del atleta [V]

Funciona: el cobro de Carlos aparece en su app; pagar el 100 % queda verde y por aprobar; el duplicado se ataja por
referencia y por huella. Se rompe o es ambiguo:
1. **Abono con dos reglas**: app = `min_installment_amount` ($72.500), bot = 50 % del ítem. [P] resolvedor único (el del ítem
   si existe, si no el de la escuela), expuesto por el BFF; parametrizado por escuela.
2. **Aviso de aprobación** solo a `parent_id`: el adulto no lo recibe. [P] `COALESCE(parent_id, user_id)` en
   `auto_approve_payment` y `sendApprovalEmail`.
3. **Doble pago entre canales**: la imagen recomprimida por WhatsApp cambia el sha256; solo la referencia lo ataja. [P] el BFF
   busca otra fila viva con misma referencia/huella antes de crear; el bot trata el 23505 como «ya recibido».
4. **`auto_approve_payment` sin guarda de categoría**: en un menor con cobro «otro» y equipo podría activar matrícula. [P] guarda.
5. Los abonos sucesivos pisan `receipt_url`/`ocr_*`. [P] historial de comprobantes.
6. **PII en `payments.notes`** (pago de Gabriela Galvis: documento, estatura, WhatsApp de la mamá): sin fuga pública, pero
   cualquier staff, coaches incluidos, lo lee por API directa. [P] limpiar la fila y mover los datos a la ficha del prospecto.

## 6. Datos de hoy — correcciones (BORRADORES; cada una con SELECT antes/después y reverso; probar con ROLLBACK)

| | Qué | Estado |
|---|---|---|
| a | **Carlos**: pasar los $175.000 (comprobante 10-nov 12:30, ref. 1869669577) del cobro externo `3bdf799a` al cobro de la escuela `772e15f2`, dejar el externo anulado. **No se activa su ficha** (está consolidada con su perfil `6d48c9b9`; reactivarla duplica su identidad) | Pendiente de OK en el CLI |
| b | **Aleja**: lead `c4f2a164` → «María Alejandra Muñoz Hernández», acompañante «Juan Sebastian Muñoz Hernández»; mismo nombre en el concepto del pago `880cb5d6` | Pendiente de OK en el CLI |
| c | Ligar los 6 cobros del lote `930cfc4e` al ítem y categoría `clase_extra`; en los 5 de Mixto, `list_amount` 250.000 / `discount_pct` 30. [DEC] Daniel Becerra (Mayores Masculino, y también matriculado en Mixto) | Después de la migración |
| d | **Karen**: lead `24473e26` → teléfono 3112540145. Ojo: el lead `1e8d19ca` (Paola Aguirre) ya lo tiene. [DEC] ¿fusionar? | Pendiente de decisión |
| e | **Camilo Aguirre ($100.000, alquiler de cancha)**: **no es un `payments`**, es la fila de cola `7ec0b14c` en `waiting_user`. Crear el lead y un cobro «Alquiler de cancha» y cerrar la cola. [DEC] categoría `otro` o `reserva` | Pendiente de decisión |
| f | Pagos de clínica hechos a mano sin enlace: Karen `2a4d28fe`, Gabriela Galvis `3bb21414`, Silvana La Rotta `46bb3df8`, M.ª Alejandra Martínez `ad59ddd6`, Valentina Rincón `694a65d0` | Ligar con 4.4 |
| g | Limpiar `notes` de `3bb21414` (PII) | Pendiente de OK |

## 7. Decisiones pendientes

1. ¿Qué cuenta para el mínimo de 5? Propuesta: cobros del ítem, mismo equipo, con descuento de grupo, en parcial/pagado/por aprobar, más los pendientes hasta el 15-nov. Si baja a 4: no repreciar solo; los que abonaron ≥ 50 % antes de la fecha conservan el precio; aviso a la escuela.
2. Daniel Becerra: $250.000 solo en Masculino, o asignarlo a Mixto (grupo de 6).
3. ¿Quién fija precio acordado: cualquier admin o solo el dueño?
4. Marcador de lead sin teléfono (propuesta `sin_telefono:<uuid corto>`).
5. Camilo: categoría y crear lead.
6. Karen/Paola: fusionar o no.
7. ¿Un exdeportista inactivo sin vínculo vivo tiene precio de afiliado? (propuesta: no).
8. Sede por defecto de los cobros que crea el bot (multisede).

## 8. Orden de entrega

1. Correcciones de datos a, b (y g) — sin migración.
2. Panel (§2), solo frontend, sin commitear lo de otra sesión.
3. Migración única (§4) → RPC + pruebas de concurrencia y de sesión simulada → `npm run seguridad:invariantes` → `gen types` una vez.
4. Bot (§3) y app (§5).
5. Correcciones de datos c, d, e, f con las RPC nuevas.
6. Manual para Iván.

Pruebas mínimas: concurrencia del último cupo (mezclando bot y RPC manual); admin de otra escuela, coach, parent y anon → 42501;
precio por fecha (15 vs 16-nov; 175.000 → 210.000); abono + saldo; mínimo de 5 que baja a 4; idempotencia; doble canal con la
misma referencia deja una sola fila viva.

---

## 9. Cambio de sede de la clínica (2026-11-11)

La clínica (21 y 22 de nov, 9:00 a. m.–3:00 p. m.) pasó del **Colegio Bilingüe La Enseñanza** a la **Universidad ECCI, Campus 170
(Cl. 170 #49b-96, Bogotá)** — https://maps.app.goo.gl/QCwRCPuVbKiW9zVk7.

**Dónde estaba escrito el lugar viejo [V]:** `school_tournament_items.description` del ítem 16766d2e (de ahí sacan el lugar Mapi y la
ficha; no hay otra fuente), `whatsapp_campanas.respuesta_si` de las 3 campañas (Sede Suba y Sede Norte terminadas; «preventa» pausada →
corregir ANTES de reanudar) y la plantilla Meta `monster_clinica_2026` (aprobada, no editable: hace falta una nueva).
**No se toca:** `facilities` (La Enseñanza sigue siendo cancha de entrenamiento) ni `palabras_sede`.

**A quién ya se le dijo el lugar viejo [V]:** 424 conversaciones (318 plantilla de campaña, 12 respuestas «sí», 31 seguimientos IA,
116 textos de Mapi, 140 fichas completas, 3 manuales). De los que ya pagaron/abonaron: con ventana de 24 h Emiliano Becerra y
Gabriela Galvis; sin ventana María Alejandra Muñoz, Nicolás Cubides, Valeria Ocampo, Ancizar Vargas, David Silva, Mariana la Rotta y
Ronald Amaya; 7 pagos sin cruce confiable (Paipilla, Agreda, Chizaba, Karen Restrepo y tres sin datos de contacto).

**Hecho:** SQL listo (`scratchpad/cambio-de-sede-clinica-ecci.sql`, con antes/después/reverso). **Pendiente de OK:** correrlo; avisar a los
que ya pagaron (texto libre solo con ventana abierta; sin ventana: plantilla nueva aprobada por Meta, o el grupo de la clínica);
crear la plantilla nueva y actualizar `bff/whatsapp-templates/escuelas/monster/monster_clinica_2026.json`.

## 10. Errores del bot entre clínica, vacacional, campamento y torneo (auditoría del 11-nov)

| # | Error | Estado |
|---|---|---|
| 1 | El comprobante de la clínica se comparó contra el Vacacional por la palabra «campamento» (dinero) | Arreglado en `de4dccaa`; verificar despliegue |
| 2 | La campaña de la clínica llegó a 19 personas que solo habían hablado del vacacional (`EVENTO_DE_SERVICIO` mezcla los tres) | En curso (partir el interés por servicio) |
| 3 | «Vacacional» solo se contestaba con los horarios de clase de prueba (`pideOQuiereServicio` da false) | En curso |
| 4 | `inferirServicio`: «el vacacional del 21 de nov» → clínica; «campamento… torneo» → vacacional; «campamento» solo → vacacional | En curso |
| 5 | Un comprobante de $145.000 (¿mensualidad?) se trató como segundo cupo de la clínica (hipótesis) | Pendiente |
| 6 | El prospecto IA dijo «preventa hasta el 9-nov» (era el 10) | La escuela ya lo corrigió |
| — | «Evento para armadoras» no se reconocía como la clínica | Arreglado hoy (reconocimiento por nombre) |

## 11. SQL pendientes de correr por ti (todos con antes/después/reverso, en el scratchpad de la sesión)

1. `vencimiento-saldo-clinica.sql` — vencimiento 20-nov de los 9 abonos de la clínica.
2. `cambio-de-sede-clinica-ecci.sql` — lugar nuevo en el ítem y en las 3 campañas.
3. `torneo-ximena-cabuya-115000.sql` — torneo de Ximena en $115.000.
4. La migración `20261111114349_cobro_servicio_unificado.sql` + `pruebas-rollback.sql` + `npm run seguridad:invariantes`.
Ya aplicados: Carlos y Aleja; la mensualidad de Ximena volvió a «parcial».
