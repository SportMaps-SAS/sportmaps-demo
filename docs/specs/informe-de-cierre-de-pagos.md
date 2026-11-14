# Informe de cierre de pagos — plan

**Versión 0.1 · 2026-11-10 · Estado: plan para revisar. No hay nada construido. Primero Monster, después las demás escuelas.**

Un cierre **manual**, lunes, miércoles y viernes (corrido al siguiente día hábil si cae en festivo), que congela
cuántos pagos llegaron y cuánto sumaron **por concepto**, y se envía por correo. Complementa a
[`editar-pago-y-cierre-de-caja.md`](editar-pago-y-cierre-de-caja.md): aquella cuadra el **efectivo de la recepción por
día y sede**; esta cuadra **todo lo que entró a la escuela** (transferencias y efectivo) por periodo y concepto.

---

## 0. Por qué

El 10-nov de 2026, Monster pidió «cuentas a las 6 p. m., todo lo que llegue». El corte de ese día, calculado a mano:

| Concepto | Hasta las 6 p. m. | Después de las 6 p. m. |
|---|---|---|
| Clínica | 2 pagos · $300.000 | 3 · $475.000 |
| Mensualidad | 1 · $145.000 | 4 · $545.000 |
| Torneos | 1 · $57.000 | 6 · $704.000 |
| **Total aprobado** | **4 · $502.000** | **13 · $1.724.000** |

Más 6 pagos por aprobar ($1.075.000). El 76 % de lo aprobado cayó después de la hora de corte. Hoy no hay forma de decir
«esto es lo que cerramos el lunes»: cada cifra se recalcula contra datos que siguen cambiando (aprobaciones tardías,
correcciones, comprobantes que llegan al día siguiente). El informe fija la foto.

**Lecciones de ese corte (el diseño las usa):**
- «Llegó» y «aprobado» son dos números distintos y los dos importan (Monster: pagos por aprobar a diario).
- Comparar horas como texto da cortes mal hechos (`-05:00` frente a `Z`): toda la lógica de fechas va en `timestamptz`.
- Sin método de pago guardado en algunos pagos (efectivo/transferencia/«?»): el informe lo muestra como «sin método», no lo oculta.

---

## 1. Lo que ya existe

| Pieza | Estado | Qué hacemos |
|---|---|---|
| `payments` (`status`, `amount_paid`, `approved_at`, `receipt_submitted_at`, `payment_method`, `payment_category`) | Viva | Fuente del informe. **No se escribe en ella** |
| `monthly_closes` (Cierre de mes) | Viva: foto mensual por alcance | Se mantiene. El informe es más fino (L/M/V) y por concepto |
| `cash_sessions` (cierre de caja) | Spec v0.2, sin construir | Independiente. Más adelante la caja puede alimentar la línea «efectivo» del informe |
| Correo del BFF (Resend) | Vivo, lo usan los avisos de cobro | **El informe sale por aquí**, no por Gmail ni por ningún conector de un asistente |
| `payment_category` | Mezcla de valores (`clase_extra`, mensualidad, …) | Se define un mapeo único a conceptos de informe (§2.2) |

---

## 2. Qué dice el informe

### 2.1 Periodo y corte

- El informe cubre **desde el cierre anterior hasta el momento de cerrar** (`periodo_desde` → `periodo_hasta`, ambos
  `timestamptz`). El primero de cada escuela parte de la fecha que se elija al activarlo.
- **Aprobado** = cobros cuyo `approved_at` cae en el periodo. **Llegó** = comprobantes cuyo `receipt_submitted_at` (o el
  pago registrado a mano) cae en el periodo. **Por aprobar** = pendientes de aprobación al momento del corte.
- Calendario sugerido: lunes, miércoles y viernes, 6 p. m. hora Colombia. Si el día es festivo, se corre al siguiente
  día hábil (festivos de Colombia, ley Emiliani, como función pura con pruebas). La escuela puede ajustar días y hora.
- **Cierre manual.** El sistema recuerda (avisos en la app y por correo a las 6 p. m. si no se ha cerrado), pero **no cierra
  solo**: una persona revisa y pulsa «Cerrar».

### 2.2 Conceptos

Mapeo único (función en la base, con el criterio escrito, y una línea **«Otros»** visible para que la suma nunca se pierda):

| Concepto del informe | Origen |
|---|---|
| Mensualidad | `payment_category` mensualidad / plan |
| Clases de prueba | categoría de clase de prueba / cortesía |
| Torneos | cobros de torneo (`Torneo · …`) |
| Clínica y servicios | ítems de servicio (`clase_extra`: clínicas, vacacionales, campamentos) |
| Inscripciones y matrículas | inscripción / matrícula |
| Cobros externos | cobros registrados como externos (§2.3) |
| Otros | todo lo demás, con su detalle |

Cada concepto muestra: **n.º de pagos**, **total recibido**, **por aprobar**, y la división **transferencia / efectivo / sin método**.

### 2.3 Cobros externos

Cobros que la escuela hace **fuera de un plan o torneo normal** (una clínica, un evento, algo que no vive en el catálogo).
Propuesta: reusar `payments` con `payment_category = 'cobro_externo'` y concepto libre, para que tengan la misma
aprobación, comprobante y reporte que el resto. *(Decisión D3 pendiente: ver §4.)*

### 2.4 Qué más trae el informe

- **Pendientes de aprobar** con antigüedad (los de más de 24 h, resaltados).
- **Alertas** (solo para revisar): transferencias aprobadas sin comprobante ni referencia, pagos sin método, aprobaciones
  hechas por una cuenta distinta de la habitual, abonos que dejaron saldo.
- **Ajustes posteriores:** correcciones o aprobaciones tardías de pagos ya cerrados en un informe anterior aparecen en el
  **siguiente** informe, en una línea propia. **El snapshot ya cerrado no cambia.**

---

## 3. Cómo se vive

1. Recordatorio (L/M/V, 6 p. m.) a dueño y administradores: «Falta cerrar el informe de pagos».
2. Entran a **Gestión de Pagos → Cierre de pagos**: ven el informe en borrador, calculado en vivo (por concepto, método y
   pendientes) y pueden revisar cada pago.
3. **Cerrar**: se congela el snapshot (`jsonb`), queda quién y cuándo, y se envía el correo con el resumen y el detalle.
4. **Reabrir** (solo dueño o administrador, con motivo, versionado): para casos como el de hoy, cuando se descubre un error.
5. Historial de informes cerrados, con descarga en PDF y CSV.

**Envío con respaldo:** cada envío se registra (`enviado` / `fallido` / `pendiente`). Si falla, se reintenta y se avisa en la app:
el dato **nunca se pierde** aunque el correo falle, porque el snapshot ya está guardado.

---

## 4. Decisiones pendientes

| # | Pregunta | Propuesta |
|---|---|---|
| D1 | ¿Quién cierra? | Solo dueño o administrador (igual que cierre de caja) |
| D2 | Hora y días | L/M/V a las 6 p. m. hora Colombia, configurables por escuela |
| D3 | ¿Qué es «cobro externo» y cómo se marca? | `payment_category = 'cobro_externo'` + acción «Registrar cobro externo» en Cobros y pagos. **Confirmar con Monster** |
| D4 | ¿Aprobado por `approved_at` o por fecha de pago? | `approved_at` para el informe; la fecha de pago se muestra en el detalle |
| D5 | Clínica: ¿cuenta con torneos o como línea propia? | Línea propia «Clínica y servicios» |
| D6 | ¿Quién recibe el correo? | Dueño y administradores de la escuela; Iván y quien indique |
| D7 | Primer corte de Monster | Desde el cierre del 10-nov 6 p. m. |

---

## 5. Construcción (por fases, una sesión aplica migraciones)

### 5.1 Base de datos — Migración única

Antes de cada `CREATE`/`ALTER`: `to_regclass` y `md5(prosrc)` contra la base viva. Estados con `text + CHECK`. Toda RPC con
`SET search_path = pg_catalog, public, pg_temp` y `GRANT EXECUTE … TO authenticated`, sin `anon`.

- `payment_period_closes`: `school_id`, `periodo_desde`, `periodo_hasta`, `closed_by`, `closed_at`, `snapshot jsonb`,
  `totales jsonb`, `status` (`cerrado`/`reabierto`), `version`, `reopen_reason`. Índice único (escuela, `periodo_hasta`).
- `payment_period_close_deliveries`: `close_id`, `canal`, `destino`, `status`, `intentos`, `ultimo_error`.
- `school_settings`: `informe_cierre_dias int[]`, `informe_cierre_hora time`, `informe_cierre_desde timestamptz`.
- RPC `informe_cierre_borrador(p_school_id)`: calcula el informe en vivo. Gate adentro: `school_id = ANY (user_admin_school_ids())`.
- RPC `cerrar_informe_pagos(p_school_id, p_hasta, p_visto)`: transaccional, lock por escuela, valida el periodo contiguo.
- RPC `reabrir_informe_pagos(p_close_id, p_motivo)`.
- Policies: solo `SELECT` para admin; escritura únicamente por RPC (sin `FOR ALL`).

### 5.2 BFF

- Job de recordatorio (L/M/V + festivos) y envío por Resend, con registro en `payment_period_close_deliveries`.
- Rutas: `GET /api/v1/cierres-pagos/borrador`, `POST /api/v1/cierres-pagos/cerrar`, `POST …/:id/reabrir`, `GET …/historial`.
- Sin consultas N+1 en el job: lee por lote con `.in('school_id', ids)`.

### 5.3 Frontend

Pestaña «Cierre de pagos» en Gestión de Pagos, con el borrador, los pendientes, las alertas, el botón «Cerrar» y el historial.

### 5.4 Pruebas

- **Corte:** pagos a las 17:59, 18:00 y 18:01 caen en el periodo correcto; aprobación tardía va al siguiente informe.
- **Festivos:** viernes festivo → siguiente día hábil; puente de ley Emiliani; fin de año.
- **Concurrencia:** dos cierres simultáneos → uno solo; cerrar mientras se aprueba un pago.
- **Seguridad:** coach, staff, padre y atleta reciben 42501; admin de la escuela A no cierra la B; `anon` sin EXECUTE;
  `npm run seguridad:invariantes` limpio.
- **Correo:** falla de Resend → queda `fallido` y se reintenta; el snapshot no cambia.

---

## 6. Fuera de alcance

Conciliación bancaria · contabilidad v2 · factura electrónica · **enero: matrícula y cambio de categoría** (es otro módulo, con
generación masiva de cobros: spec aparte) · cierre por sede.
