# Hoy del dueño — V2 (escuela: owner y school_admin)

**Estado:** propuesta para aprobar (2026-11-26). Sin código, sin migraciones, sin consultas a la base.
**Track:** V2, ola 1 («Dueño · Hoy», `V2-1…V2-4`). Define: `docs/specs/modulos-v2-definicion.md` §2.1.
**Criterios:** `DESIGN.md` §12 (8 reglas de la V2) · `CLAUDE.md` (base de datos, Disk IO).
**Fuente:** lectura del código del 2026-11-26 (rutas y líneas en §3). El lienzo de la V2 no se pudo
abrir desde la sesión que escribió esto: los textos de pantalla de §4 se ajustan contra el lienzo
antes de F1.

---

## 1. Para qué y cómo se mide

**Para qué:** decirle al dueño qué necesita de él ahora y dejarle resolverlo con un botón.

**Tarea principal:** aprobar los comprobantes de la mañana. Hoy: **36 toques** (V1). V2: **4**.
«9 coinciden: aprobar los 9», con Deshacer; los dudosos, uno por uno.

**Hecho cuando** (del spec de módulos, más lo medible):
- Un dueño aprueba 9 comprobantes en **≤ 30 s** en la prueba de las 5 personas.
- Existe el agregador de pendientes: **una** llamada trae los cuatro pendientes y el dinero del mes.
- Línea base antes de encender y número después (regla 4 del track): toques por aprobación,
  tiempo desde que llega el comprobante hasta que se aprueba (hoy lo mide `pagos-por-validar.job.ts`:
  «el más viejo lleva…»), y comprobantes aprobados desde el celular.

## 2. Lo que encontró la lectura del código (y cambia el diseño)

1. **Aprobar no se puede deshacer en la base.** `approvePayment` (`frontend/src/lib/approvePayment.ts:119`)
   es un `update` directo; al pasar a `paid` corren 7 triggers (extiende la inscripción, saldo a favor,
   comisión como gasto, cierra la bandeja de WhatsApp, auditoría…), se avisa a la familia
   (`notify_user`) y el cron de facturación puede emitir la factura electrónica. No hay
   «desaprobar», y `trg_zy_guard_pago_facturado` lo bloquea si ya hay factura.
   → **Deshacer = escritura diferida 8 s** (`ColaDeshacer` de `useAccionConDeshacer.ts`, que ya es
   genérica): no se escribe nada hasta que pasan los 8 s, se sale de la pantalla o la app va a
   segundo plano. Es el mismo patrón probado en la V2 del entrenador.
2. **Nada agrega los pendientes.** Los datos viven en 4 pantallas; el panel actual
   (`useDashboardStatsReal`) hace ~10 consultas desde el cliente. Para la base única y el Disk IO,
   Hoy necesita **una RPC** que devuelva todo en un viaje.
3. **«Profes sin lista» no existe a nivel escuela.** Existe la regla pura del lado del profe
   (`estadoDelDia` en `coach/v2/sesionesModel.ts:105`) y el horario en `teams.schedule`. El tablero
   `coach-activity` sirve pero es pesado (9 tablas, 8 semanas).
4. **Hueco en «verde»:** si la escuela no tiene cuentas de destino registradas, el chequeo de cuenta
   se salta y el comprobante puede salir verde (`receipt-verdict.ts:316-365`).
5. **Bloqueo conocido:** la auto-evaluación por `POST /glosas/auto-evaluate` da 403 cuando el cobro
   no tiene `parent_id` (589 menores sin pagador). Esos comprobantes nunca llegan a verde por esa vía,
   así que «aprobar los 9» los verá siempre como «uno por uno».
6. **Menú:** `school` y `school_admin` son dos árboles en `config/navigation.ts`; la barra inferior
   (`MobileBottomNav.tsx:53`) solo tiene caso `school`, así que **`school_admin` y `owner` caen en la
   barra genérica** (Inicio/Calendario/Mensajes/Perfil) *(por confirmar en ejecución)*.

## 3. Fuentes de cada bloque

| Bloque | Fuente que ya existe | Qué se reutiliza |
|---|---|---|
| Comprobantes por validar | `pagos-por-validar.job.ts`: `leerPendientes` (:455), `exclusionVerde` (:236), `armarResumen` (:272); regla del cliente `greenExclusion`/`bulkGreenSelection` (`lib/receiptReview.ts:173`) | La misma regla de «verde» en la RPC (espejo de `greenExclusion`) |
| Vencidos | `get_payment_aging_report` (`20261013192838`) — definición de vencido por `due_date`/periodo, hora Bogotá | Solo la **definición**; no la subconsulta por ítem a `attendance_records` |
| Solicitudes de ingreso | `list_school_join_requests` (código de escuela) + `enrollment_form_intake` con `status='waiting_review'` (BFF `/enrollment-intake`) | Conteos de las dos |
| Profes sin lista | `teams.schedule` + `attendance_sessions(team_id, session_date)`; regla `estadoDelDia` | La regla, aplicada a **ayer** (hoy todavía no terminó) |
| Dinero del mes | `finance_income_summary(p_owner_type='school', …)` — misma fórmula que caja y KPIs | Llamada tal cual (ya es una sola RPC) |
| Entrenos de hoy | `teams.schedule` (franjas de hoy) + `training_sessions` del día | Lista corta: equipo, hora, profe, si hay lista |
| Aprobar | `approvePayment` (cliente, guarda `already_handled`) | Tal cual en F2, envuelto en `ColaDeshacer` |

## 4. La pantalla

Celular primero (390 px); en escritorio, la misma pantalla con más aire. Un solo árbol para owner y
school_admin; school_admin con sede ve solo su sede (`p_branch_id`).

1. **Frase y un botón** (regla 02): «Hoy hay 3 cosas para ti» · botón de la más urgente.
   Si no hay nada: «Todo al día» — **solo** si los datos cargaron (si la consulta falla, se dice que
   falló; patrón de `ParentHomeV2`).
2. **Comprobantes** (regla 03, lo normal ya marcado): «9 coinciden con el monto y la cuenta:
   **Aprobar los 9**». Al tocar: desaparecen de la lista y sale el aviso «9 aprobados · Deshacer»
   (8 s). Los dudosos (amarillo/rojo, o sin evaluar) van debajo, uno por uno, con la razón en
   palabras («la cuenta no coincide», «monto distinto»).
3. **Vencidos:** «12 familias con la mensualidad vencida · $1.840.000» → Cobros › Vencidos (con el
   WhatsApp a deudores que hoy está en `PaymentAgingCard`).
4. **Solicitudes de ingreso:** «4 familias quieren entrar» → Deportistas › Ingreso.
5. **Profes sin lista (ayer):** «2 profes no tomaron lista ayer: Sub 11, Sub 13» → Entrenadores.
6. **Dinero del mes:** recaudado este mes y por cobrar, con la palabra «este mes» (no «periodo»).
7. **Entrenos de hoy:** lista corta, plegable.
8. El resto («Ver todo»): accesos a los módulos. Panel, Reportes, Finanzas y Panel de reportes **no
   se tocan en esta fase** (decisión D-HOY-7).

Estados distintos de carga, vacío y error en cada bloque. Montos con `tabular-nums` y formato COP
(`Intl.NumberFormat('es-CO')`).

## 5. Fases (una rama por fase, revisión entre fases)

| Fase | Qué | Base de datos | Hecho cuando |
|---|---|---|---|
| **F0 · Cascarón** | Bandera `ESCUELA_V2` (**apagada por defecto**), `RutasSegunRol` para owner/school_admin, barra inferior V2 de escuela (Hoy · Deportistas · Cobros · Entrenadores · Más) y «Más»; mover `useAccionConDeshacer` a `components/v2/` | No | Con la bandera apagada nada cambia; encendida, owner y school_admin ven el cascarón con los dos roles; tests de rutas |
| **F1 · Hoy en solo lectura** | RPC `school_hoy_resumen(p_school_id, p_branch_id)` y la pantalla con los bloques 1 y 3–8 (sin aprobar todavía; los comprobantes enlazan a la pantalla actual) | **Sí: 1 RPC nueva** (plan aprobado antes de escribirla) | Una llamada; `EXPLAIN` con índices por `school_id`; tests de alcance (owner, school_admin con sede, coach → 42501, padre → 42501) |
| **F2 · Aprobar los N con Deshacer** | Bloque 2 completo: selección «verde» (regla de §3), aprobar en lote con escritura diferida, dudosos uno por uno | No (reusa `approvePayment`) — ver D-HOY-5 | 9 aprobados en ≤ 30 s en la prueba; recargar o salir durante los 8 s **sí** aprueba; Deshacer no escribe nada; `already_handled` no se cuenta como error |
| **F3 · Medir y encender** | Línea base, prueba de 5 personas (las tareas del dueño), encendido escuela de pruebas → piloto → resto | No | Números de antes/después en este spec |

### F1 · Borrador de la RPC (para revisar, no para aplicar)

- `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`.
- **Alcance adentro:** `p_school_id = ANY (public.user_admin_school_ids())` — dinero y aprobación son
  de administración, no de coaches (D-HOY-2). Con `p_branch_id`, validar que la sede sea de esa escuela
  y que el admin con sede no pida otra.
- `REVOKE ALL … FROM PUBLIC, anon;` · `GRANT EXECUTE … TO authenticated;`
- Devuelve un `jsonb` con: `comprobantes {total, monto, verdes_listos, mas_viejo_desde}`,
  `vencidos {familias, monto}`, `solicitudes {codigo, matriculas}`, `sin_lista_ayer [{team, coach}]`,
  `entrenos_hoy [{team, hora, coach, con_lista}]`. El dinero del mes sale de
  `finance_income_summary` (ya existe) para no duplicar la fórmula.
- Cada parte con `FILTER`/un solo barrido por tabla e índice `school_id`; nada de subconsultas por
  fila. `teams.schedule` se interpreta en SQL **o** se devuelve crudo y se interpreta en el cliente con
  `leerFranjas` (D-HOY-3).
- Revisión de `revisor-rls` y `npm run seguridad:invariantes` tras aplicar.
- Sin sondeo: `staleTime` de 1–2 min y recarga al volver a la pantalla; **nada de polling por minuto**.

## 6. Decisiones abiertas (necesito respuesta)

| # | Pregunta | Propuesta |
|---|---|---|
| **D-HOY-1** | ¿La bandera arranca apagada y se enciende por escuela, o global? | Apagada; encendido por escuela piloto (no Dynasty primero, como dicen las notas del 14-nov) |
| **D-HOY-2** | ¿Quién ve dinero y aprueba: owner y todo school_admin, o solo admins con permiso de finanzas? | owner + school_admin (`user_admin_school_ids()`), admin con sede solo su sede. Coaches nunca |
| **D-HOY-3** | Horario de entrenos: ¿interpretar `teams.schedule` en SQL o en el cliente? | Cliente (`leerFranjas` ya probado); la RPC devuelve equipos con horario y las listas de ayer/hoy |
| **D-HOY-4** | Escuela **sin cuentas de destino registradas**: ¿sus verdes entran en «aprobar los N»? | **No**: van a «uno por uno» con «Registra tu cuenta para aprobar en un toque» |
| **D-HOY-5** | ¿Aprobar en lote con el bucle actual (`approvePayment` × N, ya probado) o con una RPC transaccional nueva? | F2 con el bucle (sin migración); RPC en una fase posterior si la prueba muestra fallas parciales. Un lote que falla a la mitad hoy deja aprobados los primeros: se reporta «7 de 9 aprobados, 2 quedaron por revisar» |
| **D-HOY-6** | ¿Se arregla en esta fase el 403 de auto-evaluación con `parent_id` nulo (589 menores)? | Aparte (BFF, otra rama): sin eso «los 9» serán menos, pero no bloquea |
| **D-HOY-7** | Panel, Reportes, Finanzas: ¿se funden ya en Hoy? | No en esta fase: no hay medición de lo que se **mira** (`analytics_events` vacía). Medir primero |
| **D-V2NAV** | ¿«Cobros» o «Dinero»? ¿«Entrenadores» o «Deportivo»? | «Cobros» y «Entrenadores» (lo que ya asume el spec de Comunicaciones) |

## 7. Fuera de alcance

Comunicaciones (su propio spec), «Te esperan» de WhatsApp (va con Comunicaciones F0), Mapi en el
dueño, Tienda, Control de acceso, el cascarón de los otros módulos del dueño (cada uno con su fase), y
`/evaluations` (pendiente anotado en `modulos-v2-definicion.md` §4.4).
