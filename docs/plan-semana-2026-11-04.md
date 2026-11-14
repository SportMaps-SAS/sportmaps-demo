# Plan de la semana — 4 al 10 de noviembre de 2026

**Fuentes:** `docs/ROADMAP.md` v2.39 (corte 27-oct), memorias del proyecto y los pedidos de las sesiones
paralelas (Editar pago y Cierre de caja, backlog de Carmel/Julián, rol Organizador).
**Verificado el 04-nov en git y, para los puntos marcados ✅, en la base viva** (consulta de solo lectura
a `pg_trigger`, `pg_proc` e `information_schema`). Lo demás que dice «sin aplicar» o «abierto» sale de
memoria y hay que confirmarlo contra el objeto.

**Cómo leerlo**
- **Tú** = lo que solo puedes hacer tú: push a `main`, SQL en la base, paneles de Meta, Render y Wompi, y
  hablar con las escuelas.
- **Sesión** = construcción en código (DB + BFF + frontend + QA, de corrido).
- Reglas que no cambian: una sola sesión aplica migraciones, una por una; los pushes se agrupan (cupo de
  Vercel); nada a `main` sin que tú lo pidas.

---

## 1. Primero: el roadmap quedó atrás de lo que se está haciendo

La cola v2.39 (27-oct) dice: G0 de seguridad antes de cualquier feature con cobro, datos sensibles o
multi-tenant, y después las olas O1–O6. Lo que pasó en la semana fue otra cosa (Monster, Dynasty, WhatsApp
v2, Carmel). Contrastado:

| Ítem del roadmap | Estado real | Qué hacer |
|---|---|---|
| G0.1 documentos, G0.3 webhook Wompi, G0.4 autopay | La revisión del 27-oct concluyó que SEC-01/03/09/10 eran falsos o ya estaban cerrados | Marcarlos cerrados **con la evidencia** en v2.40, no dejarlos como bloqueo |
| G0.2 separar dev/stg/prod | Abierto. Sigue siendo una sola Supabase | El único gate grande que sigue en pie. No cabe esta semana: se agenda |
| G0.5 inventario multi-tenant | Parcial (`seguridad:invariantes` sin críticas, 28 I3 altas) | Sigue en el backlog de seguridad (§8) |
| C1 compromisos v2.38 | Varios cerrados; quedan Besser sin pagador, Wompi Dynasty y datos de Dynasty | Cerrar con evidencia (§3) |
| O1 organizador anfitrión (22–28 oct) | **No cerró:** el rol `organizer` sigue dando 403 | Pasa a la semana próxima (§5) |
| O2 Canchas, Bienestar (29 oct–6 nov) | Sin avance; «Hoy» del coach sí salió con la V2 del 25-oct | Se corre una ola. No se fuerza esta semana |
| O3 (9–20 nov) | Por arrancar | Partidos en vivo y Organizador F0 entran aquí (§5) |

**Recomendación:** al cierre de la semana, publicar `ROADMAP.md` v2.40 con este corte. La cola del 27-oct
ya no sirve para decidir.

---

## 2. Hoy en la noche o mañana temprano: desbloqueo (Tú, unos 45 min)

1. ✅ **Migración 9** (`20261104115612`, anuncios): **ya aplicada**. Existen `whatsapp_atribucion`,
   `whatsapp_anuncio_destino` y `wa_embudo_anuncios`.
2. ✅ **Migración 10** (`20261104131451`, formularios): **ya aplicada**. Existen `whatsapp_flows`,
   `whatsapp_flow_respuestas`, `whatsapp_consentimientos` y `wa_consentimientos_de_escuela`.
   Con las dos vivas, el push del paso 4 ya no espera a nada de la base.
3. **`WHATSAPP_FLOW_TOKEN_SECRET`** en Render, prod y dev.
4. **Push de `C:\tmp\wt-promote-main`** (main va 3 commits adelante de `origin/main`): anuncios con clic a
   WhatsApp, formularios fase F-a y **la plantilla de la clínica de Monster con preventa hasta el 10-nov**.
   Si no sube, esa preventa no tiene recordatorio en prod.
   ```
   git -C C:/tmp/wt-promote-main push origin main
   ```
5. **Meta, App Dashboard:** suscribir los campos `flows` y `history` del webhook.
6. **Jueves 05-nov después de las 11:00:** `8-relleno-last-inbound-historial.sql`. Sí existe: está en
   `Descargas\monster-migraciones` (04-nov 12:03). No está en el repo, y es a propósito.
7. **Repo local:** `develop` va 5 commits detrás de `origin/develop`. Antes de traerlo, decidir qué pasa con
   el árbol sucio: `.gitignore`, los manuales de Dreamers, el spec de editar pago y `PaymentsAutomationPage.tsx`
   en staged, que puede ser de otra sesión.

---

## 3. P0: esta semana, con fecha o con plata en juego

| # | Qué | Quién | Cuándo | Hecho cuando |
|---|---|---|---|---|
| P0.1 | ✅ **Cerrado (verificado 04-nov).** El trigger `trg_profiles_guard_role` (`20260910073724`) está vivo y habilitado, y `authenticated`/`anon` ya no tienen `UPDATE` sobre `profiles.role`/`role_id`. Las columnas de notas crédito (`20260910092915`: `voided_at`, `voided_by`, `voided_by_invoice_id`, `void_reason`) existen. `platform_admins` tiene 1 activo | — | — | Hecho |
| P0.2 | **Factura SaaS de Monster** SM-2026-00003, $419.000, vence el 05-nov | Tú | Jue 05 | Recibida o pagada. **No apagar y prender** la facturación: eso emite la del periodo siguiente |
| P0.3 | **Cobros de Monster:** aprobar a $125.000 los 3 comprobantes en revisión (Páez, Ximena Cabuya, Laura Valentina Muñoz); registrar los pagos de U15 contra el mismo cobro cuando Monster los mande; crear los 8 deportistas que faltan y las 13 filas del Sheet de Suba | Tú / Sesión | Antes del 14-nov | 0 en revisión, U15 al día, 8 + 13 creados |
| P0.4 | **Modo discreto de Dynasty:** verificar en prod (logs de Render + `whatsapp_messages`) que desde el 29-oct el bot no respondió con Milena activa | Sesión | Jue 05 | 0 respuestas del bot dentro de las 12 h de silencio |
| P0.5 | **Aviso doble de cortesía:** migración para que `submit_school_lead` no avise cuando `p_source_detail.canal = 'whatsapp'` | Sesión | Jue–Vie | Una sola notificación por reserva que llega por el bot |
| P0.6 | **Rotar `WHATSAPP_ACCESS_TOKEN`:** `process-ocr` lo mandaba a URLs arbitrarias hasta el 27-oct. Confirmar si ya se rotó | Tú | Esta semana | Token nuevo en Render y en Meta |
| P0.7 | **C1 del roadmap pendientes de cerrar:** Besser, 18 cobros sin pagador ($6,32 M); Wompi de Dynasty sin URL de eventos registrada (#17); confirmar que las 4 familias de Dynasty reenviaron el comprobante (el reproceso falló: Meta ya había borrado los archivos) | Tú + escuela | Vie 06 | Cada uno Hecho, Pausado o Cancelado con evidencia |

---

## 4. P1: lo que se construye esta semana (máximo 2 frentes en paralelo)

### Frente A: Editar pago y Cierre de caja (Jue → Sáb, sesión principal)
- Spec `docs/specs/editar-pago-y-cierre-de-caja.md`, actualizado. La otra sesión confirmó que no hay choque:
  ya salió de Gestión de Pagos y su arreglo del lote ya está en la base.
- Alcance: botón «Editar pago» en la pestaña «Pagos recibidos»; la marca de «corregido» aparece también en
  el detalle del lote en Operaciones; caja por sede que se abre sola con el primer efectivo; solo dueño o
  admin editan, cierran y reabren. Historial en `payment_corrections`.
- Incluye cerrar las policies `FOR ALL` sin `WITH CHECK` de `cash_sessions` y `cash_session_entries` (I3), y
  reemplazar `close_cash_session`, que no tiene gate.
- **Por qué va primero:** es plata real. Las correcciones se hacen hoy por SQL y sin actor (caso Santiago en
  Dreamers), y GYM RM registró 13 de 14 transferencias sin soporte.
- **Bloqueo:** tu aprobación del plan.

### Frente B: Carmel, bloque 1 de fixes chicos (Jue → Dom, sesión aparte, otros archivos)
Todo detrás de flags **solo para Carmel**:
1. Reproducir en vivo por qué la evaluación que publica el admin no le llega al coach (primero ver si alguien
   la publicó; el gate `20261029095042` está aplicado).
2. «Solo fines de semana» para entrenamiento: flag en `school_settings`.
3. Mesociclo: cargar dos semanas a la vez (`MesocycleSection`).
4. Rúbrica con «No aplica», que no cuenta en el promedio.
5. Editar permisos de entrenadores: **falta que Julián diga cuál permiso**. Los toggles ya existen.
6. Bibliotecas: ya están construidas; solo confirmar que el paquete esté prendido para Carmel.

### Frente C: Formularios de WhatsApp (cuando Meta verifique a Monster)
- Prueba en draft con tu teléfono: `wa-registrar-flow` y luego `wa-enviar-flow-prueba --draft`. Después, F-b.
- No bloquea nada. Si la verificación de Monster no sale esta semana, pasa a la próxima.

### Fixes sueltos para cuando un frente se libere
- **Clase de prueba:** filtrar por `payment_category = 'clase_prueba'` en registrar, listar y mover. Va
  **antes** de prender el bot de Monster, que también usa `signup_lead_id` para la matrícula.
- **Coach V2 (B14):** la lista de «Ayer / Otro día» no se puede cerrar ni evaluar. Sin cierre no sale la
  encuesta a los padres, el mismo problema del 29-oct en Besser.
- **Deportista V2:** «¿Qué tan duro fue?» no guarda fuera de fútbol, voleibol y fútbol sala
  (`useAthleteV2Data.ts:386`).

---

## 5. Próxima semana (9 al 13 de noviembre), alineada con O3 del roadmap

| Orden | Qué | Por qué ahí |
|---|---|---|
| 1 | **Partidos en vivo (Carmel):** spec primero. Iniciar, sustituir y terminar partido, tiempo jugado automático, 3 tiempos y ajuste del «45», % jugado, informe automático al finalizar. Base: `docs/specs/partidos-registro-y-evaluacion-por-jugador.md` | Es lo de mayor impacto para Julián (hoy redacta el informe a mano por WhatsApp) y el bloque más grande |
| 2 | **Organizador F0:** fila en `schools` con `school_type = 'event_organizer'` usando el motor nuevo. El plan anterior se descartó: rehacerlo con `docs/specs/organizador-torneos-modulo-aparte.md` (D1–D9 sin decidir) | Es el «organizador v2» de O3; O1 no lo cerró |
| 3 | **Canal WhatsApp de SportMaps:** conectar +57 320 268 3539, enviar las 5 plantillas `sm_*` a Meta, habilitar Dynasty, encender, y Milena escribe «ACTIVAR» | Desbloquea B10 (anuncios de SportMaps) y el cierre de lista asistido |
| 4 | **Cierre de lista asistido (Dynasty):** si Milena lo valida, Fase 0 para el cobro del 1-dic (corre el día 1 a la 1:30) | Fecha dura: 1-dic |
| 5 | **Evaluaciones ampliadas (Carmel):** autoevaluación del coach con comparación, por categoría y por sesión | Se apoya en el bloque 1 |
| 6 | **Mapi agente:** bloques 1 y 2 (ficha por rol, clasificación) | Spec aprobado el 27-oct, sin código |

---

## 6. Bloqueado por terceros: solo seguimiento, no se construye

| Quién | Qué falta |
|---|---|
| **Monster** | Conectar el número (¿318 868 2241?) con el bot apagado; enlace de Maps de «Pinar»; dónde entrena Mayores Mixto el 5.º domingo (el 29-nov sale con el texto crudo); textos de plantillas y método de pago en Meta; verificación del negocio (en revisión); lista de quién pagó en U15 |
| **Dynasty (Milena)** | Su Nequi entre las cuentas registradas; los cobros de $180.000 donde la familia paga $150.000; direcciones de Nido del Colibrí y Asoalsacia; el saludo de su WhatsApp Business (manda a `stg.sportmaps.co`); 9 matrículas en `waiting_review` desde el 05-oct; validar el cierre de lista asistido |
| **Besser** | Probar el código BES-TA8H y la bandeja «Por asignar»; pantalla de partidos con Duván; categoría de los 2 hermanos sin inscripción; si a Isabella Millán se le cobra octubre |
| **Dreamers** | En pausa por decisión tuya hasta que la dueña defina su software. Pendiente cuando vuelva: decisiones §6 de horas, cupos y categorías para la clase de prueba |
| **Carmel (Julián)** | Qué permiso de entrenador quiere editar; qué le falló en «#1 Pizarra» y en «#8 mejoras en los esfuerzos» |

---

## 7. Decisiones tuyas esta semana

1. **Aprobar el plan de Editar pago y Cierre de caja** (desbloquea el Frente A).
2. **Datos médicos visibles al coach de Carmel:** ¿solo alergias y contacto de emergencia el día del
   entrenamiento? ¿con consentimiento nuevo? Carmel tiene 0 acudientes vinculados.
3. **Base de consentimiento para las campañas de Monster:** «optin» llega a 0 personas, «contacto previo» a 939.
4. **Prender `wa_cobro_desde_comprobante`** antes de encender el bot de Monster.
5. **Organizador:** confirmar que pasa a la semana próxima, y las decisiones D1–D9 del spec.

---

## 8. Backlog sin fecha (no entra esta semana)

- **Seguridad:** las 4 policies `FOR ALL` autoadjudicables de clase D (necesitan decisión de producto);
  unas 72 funciones `SECURITY DEFINER` ejecutables por `anon` (borrador en
  `docs/migraciones-pendientes-2026-10-24/`); default privileges de `supabase_admin` (ticket a soporte);
  4 buckets públicos con listado; protección de contraseñas filtradas; `npm audit`; **G0.2 separar ambientes**.
- **Carmel, fase posterior:** pizarra con pases y tiros secuenciales en el tiempo; enlace pizarra ↔
  mesociclo; vista del admin con sesión, pizarra y gráfica; planeación semestral (Track PER).
- **Horas (Dreamers):** aviso al entrar («entraste con 20 %») y sumar horas al pagar una `clase_extra`.
- **Torneos:** «equipo de mi escuela» real, ½ del ajedrez en `ShareResultButton`, `/public/:slug/player-stats`,
  pasarela en el link del delegado, precio del complemento. (La migración `20261020113208` ✅ ya está viva:
  `school_register_athlete_for_tournament` tiene la firma nueva de 4 parámetros.)
- **World Office (Dreamers):** sin código; espera a que Dreamers salga de la pausa.
- **Multirol:** doble conteo de cobros sin sede en `finance_income_lines` y `school_payment_kpis`.
- **Comunicaciones V2 F0:** pausado desde el 14-oct.
- **Entrenador V2:** segunda campana en «Hoy», policy de `enrollments` para la ficha vinculada.

---

## 9. Calendario

| Día | Tú | Sesiones |
|---|---|---|
| **Mié 04, noche** | §2, pasos 3 a 5 (los pasos 1 y 2 ya están hechos) | — |
| **Jue 05** | Relleno 8 (después de las 11:00) · factura de Monster · 3 comprobantes de Monster · aprobar Editar pago | P0.4 · arrancan Frente A y Frente B |
| **Vie 06** | Pagos de U15 si Monster los manda · seguimiento a escuelas (§6) · P0.7 | Frente A · P0.5 · Frente B entrega 1 y 2 |
| **Sáb 07 – Dom 08** | — | Frente A con QA real en dev · Frente B entrega 3 y 4 |
| **Lun 09** | Revisión de la semana · pedir los datos de §6 que sigan faltando | ROADMAP v2.40 · actualizar las 6 memorias desactualizadas · spec de Partidos en vivo |
| **Mar 10** | Vence la preventa de la clínica de Monster | Push agrupado de lo cerrado (A y B) |
