# Módulos de la V2 — definición de cada uno

**Estado:** propuesta para aprobar, 2026-10-24. Sin código. Parte del track V2 del [ROADMAP](../ROADMAP.md).
**Fuentes:** lienzo del rediseño (`CGQozXBXP91kJn7YNF5Cs4`, tableros `V2*`, `Navegacion`, `Sidebar`, `TabBar`), [`mapa-app/cruce-rediseno.md`](../mapa-app/cruce-rediseno.md) (342 pantallas) y el código al 24-oct.
**Manda sobre:** el contenido de cada módulo y su orden de construcción. No reemplaza a los specs de detalle (Comunicaciones, Cobros, Documentos), que siguen siendo la fuente de su frente.

---

## 0. La regla

**Toda tarea frecuente se hace en 2 o 3 toques, sin ayuda, desde el celular.** Si no cabe, el módulo está mal definido, no mal diseñado.

Cada módulo de este documento responde las mismas seis preguntas:

1. **Para qué:** una frase.
2. **Tarea principal y toques:** lo que más se hace y cuántos toques cuesta hoy y en la V2.
3. **Qué trae ya marcado:** el valor por defecto (regla 03 y 07 de la V2).
4. **Pestañas:** lo que queda dentro. Lo que no está aquí, no está en el menú.
5. **Qué sale:** lo que se fusiona, se oculta o se borra.
6. **Hecho cuando:** la medida que cierra el módulo.

Estados usados: ✅ existe · ◐ parcial · ✖ no existe · 🔒 existe oculto o roto.

### Las 8 reglas (criterio de aceptación, no estilo)

| # | Regla | Cómo se comprueba |
|---|---|---|
| 01 | WhatsApp primero | La tarea se puede iniciar desde un enlace del chat, sin contraseña |
| 02 | Una frase y un botón | La pantalla abre diciendo qué pasa y qué hacer; lo demás va plegado |
| 03 | Lo normal ya viene marcado | Solo se toca la excepción |
| 04 | Deshacer en vez de «¿Seguro?» | 8 s para deshacer; confirmar solo al borrar o anular dinero |
| 05 | Funciona sin señal | Lista y evaluación se guardan en el teléfono y suben solas |
| 06 | Palabras de la cancha | Una palabra por cosa (`V2Palabras`) |
| 07 | Valores por defecto | La escuela nueva arranca con todo resuelto; la mora y el bloqueo solo por la mensualidad |
| 08 | Celular primero | Se dibuja a 390 px; el escritorio es la misma pantalla con más aire |

---

## 1. Esqueleto de navegación (ya dibujado en el lienzo)

| Rol | Barra del celular | Menú lateral |
|---|---|---|
| **Escuela** (owner y school_admin, un solo árbol) | Hoy · Deportistas · Cobros · WhatsApp · Más (decidido en el PDF del rediseño del 13-nov-2026; Entrenadores pasa a «Más»; ver `hoy-dueno-v2.md` §4.1) | Hoy · Deportistas · Entrenadores · Asistencia · Calendario · Cobros · Tienda · WhatsApp · Escuela · Configuración |
| **Entrenador** | Hoy · Equipos · Sesiones · Asistencia · Más | Hoy · Mis equipos · Sesiones · Asistencia · Evaluar · Calendario · Más |
| **Acudiente** | Inicio · Calendario · Hijos · Pagos · Más | (sin lateral: celular primero) |
| **Deportista** | Hoy · Entrenos · Progreso · Carnet · Más | (sin lateral) |

Reglas de la barra: la quinta pestaña siempre es **Más**; respeta billing, addons y módulos apagados; nunca muestra un destino que el lateral oculta; el soporte vive dentro de Más.

**Tres pantallas con uso real y sin lugar en el lienzo** (propuesta de casa, a confirmar):

| Pantalla | Uso hoy | Casa propuesta |
|---|---|---|
| Planes y ofertas (`/offerings`) | 72 nuevos en 90 días, 11 escuelas | Cobros › Planes |
| QR de inscripción (`/qr-signup`) | 1.727 escaneos, 226 registros, 61 pagados | Deportistas › Ingreso (junto a solicitudes) |
| Dotación (`/school/equipment`) | 3 ítems, 2 escuelas | Escuela › Dotación |

---

## 2. Escuela (dueño y administrador)

### 2.1 Hoy
- **Para qué:** decirle al dueño qué necesita de él ahora y dejarle resolverlo con un botón.
- **Tarea principal:** aprobar los comprobantes de la mañana. V1: 36 toques → V2: 4. «9 coinciden: aprobar los 9», con Deshacer; los dudosos, uno por uno.
- **Viene marcado:** los comprobantes que coinciden en monto y cuenta destino, listos para aprobar juntos.
- **Contenido:** una frase («Hoy hay 3 cosas para ti»), pendientes del día (comprobantes, vencidos, solicitudes de ingreso, profes sin lista), dinero del mes, entrenos de hoy. El resto, plegado en «Ver todo».
- **Sale:** Panel, Reportes, Finanzas, Panel de reportes. Cada número vive junto a lo que mide. Los exportes CSV pasan a un botón «Exportar» dentro de cada módulo.
- **Estado:** ◐ los datos existen en 4 pantallas y no hay agregador. 🔒 Auto-revisión del comprobante: los cobros con `parent_id` nulo dan 403 y nunca se autoaprueban (589 menores sin pagador).
- **Hecho cuando:** un dueño aprueba 9 comprobantes en ≤ 30 s en la prueba de las 5 personas, y existe el agregador de pendientes.

### 2.2 Deportistas
- **Para qué:** tener a todos los deportistas y a sus familias al día en un solo lugar.
- **Tarea principal:** matricular. V1: 60+ toques → V2: foto de la planilla → confirmar (2). Al final, invitar a los acudientes por WhatsApp.
- **Viene marcado:** el plan y el equipo que la escuela usa más; la invitación sale al terminar la carga.
- **Pestañas:** Deportistas · Solicitudes de ingreso · Invitaciones · Ingreso (QR) · Carnets.
- **Ficha lateral:** Resumen · Pagos · Asistencia · Evaluaciones · Documentos. Cobros y pagos se abren desde la ficha.
- **Sale:** Constancias (0 emitidas), Membresías (0 filas).
- **Estado:** ◐ la carga por foto lee hoy una hoja por deportista (14 en 90 días); la planilla completa no existe. ✅ CSV, invitación masiva, QR. 🔒 «Cobros y pagos» desde la ficha, detrás de `VITE_COBROS_Y_PAGOS`.
- **Hecho cuando:** 20 deportistas cargados en ≤ 3 min desde una foto, con invitaciones enviadas.

### 2.3 Entrenadores
- **Para qué:** que el dueño mire cómo van los profes. **El dueño mira, el entrenador hace.**
- **Tarea principal:** saber quién no tomó lista o no evaluó, y escribirle.
- **Pestañas:** Seguimiento · Sesiones y mesociclos · Evaluaciones e informes · Equipos y categorías · Biblioteca. Solo lectura para el dueño; la edición vive en los tableros del entrenador.
- **Sale:** las dos bibliotecas de ejercicios se unifican (hoy `trainer_routines` y ejercicios de sesión; el rediseño no dice cuál queda: **decisión abierta D-BIB**).
- **Estado:** ✅ `/seguimiento-deportivo`. ◐ 64 de 67 sesiones de 90 días sin `created_by`, así que no se pueden atribuir a un profe.
- **Hecho cuando:** el resumen por profe muestra listas tomadas y evaluaciones pendientes de la semana.

### 2.4 Asistencia
- **Para qué:** ver si los deportistas vienen y si los profes toman lista.
- **Pestañas:** Por mes · Por atleta · Supervisión de hoy · Por día · Plan vs consumo. Exportar CSV.
- **Sale:** Encuestas (0 en 90 días).
- **Estado:** ✅ Por mes, Por atleta, CSV. Las pestañas «Por día», «Día por día» y «Plan vs consumo» existen sin dibujar.
- **Hecho cuando:** «2 profes no tomaron lista ayer» aparece en Hoy y lleva aquí en 1 toque.

### 2.5 Calendario
- **Para qué:** entrenos, partidos y torneos en una sola vista.
- **Pestañas:** Calendario · Torneos y partidos · Resultados. Un resultado es parte del partido.
- **Estado:** ✅ y reforzado el 24-oct con **torneos en vivo** (liga, copa y grupos, anotador, página pública, modo TV). El cruce los marcaba parciales y sin tablero; el tablero falta.
- **Hecho cuando:** el tablero de Torneos y partidos está dibujado y el acudiente ve las inscripciones y resultados de su hijo desde su Calendario.

### 2.6 Cobros
- **Para qué:** saber quién pagó, quién debe y cobrar sin errores.
- **Tareas:** aprobar un pago (2 toques, con Deshacer), cobrar un valor único o a un equipo (3 toques con el modal único), registrar un pago atrasado, escribirle a un deudor.
- **Viene marcado:** la mensualidad del mes con el valor del plan; el cobro sale en la fecha de corte de la escuela.
- **Pestañas:** Por validar · Cobros · Vencidos · Recepción · Contabilidad o Facturación · Medios de pago · **Planes** (nueva) · y las ya existentes sin dibujar: Glosas · Conciliación · Cierre de mes · Historial.
- **Reglas que no se rompen:** la mensualidad es la única que genera mora y vigencia; los pagos únicos nunca bloquean; la mora no cancela.
- **Sale:** Contabilidad ×5 entradas (pasan a pestañas), Facturación electrónica como entrada aparte.
- **Estado:** ✅ auto-evaluación de comprobantes y aprobación masiva (`BulkApproveGreensDialog`). 🔒 modal único y «Cobrar a un equipo», detrás de `VITE_COBROS_Y_PAGOS` (`charge_batches` = 0). ✖ **Deshacer 8 s no existe en pagos.** ✖ Bre-B, fuera hasta que Factus tenga fecha.
- **Hecho cuando:** el modal único reemplaza los tres caminos de registrar pago, y Deshacer existe en Aprobar.

### 2.7 Tienda
- **Para qué:** vender artículos del club. Solo aparece con el addon.
- **Pestañas:** Pedidos · Productos · Inventario · Promociones.
- **Estado:** 🔒 `store_enabled` apagado globalmente, 3 pedidos en 90 días. Promociones y Reportes están rotos.
- **Decisión:** no se rediseña en la primera tanda. Solo se alinea el menú.

### 2.8 WhatsApp
- **Para qué:** responder a las familias sin salir del celular y dejar que el bot haga lo repetible.
- **Tarea principal:** contestar a quien espera. Spec propio: [`comunicaciones-rediseno-v2.md`](comunicaciones-rediseno-v2.md) (F0 «Te esperan», F1 respuesta lista con Deshacer).
- **Pestañas:** Conversaciones · Avisos y plantillas · Recordatorios (más Comprobantes y Prospectos, que ya existen).
- **Sale:** Anuncios (0 filas), Mensajes (0 mensajes, no se puede redactar).
- **Línea base (Dynasty, 2–12 oct):** 0 respuestas desde el panel, 1 de 381 borradores aprobados.
- **Hecho cuando:** respuestas enviadas desde el panel > 0 y borradores aprobados ≥ 30 %.

### 2.9 Escuela
- **Para qué:** quién es la escuela y quién trabaja en ella.
- **Pestañas:** Personal · Sedes e instalaciones · Control de acceso · Perfil público · Plan · **Dotación** (nueva).
- **Sale:** Sedes, Instalaciones y Clubes se unifican en «Sedes e instalaciones».
- **Estado:** ✅. Control de acceso tiene el mayor volumen (10.376 eventos en 90 días, 4 escuelas) y **no tiene tablero**.
- **Hecho cuando:** los 5 tableros de pestañas sin dibujar existen antes de reconstruirlos.

### 2.10 Configuración
- **Para qué:** ajustes que se tocan una vez. Detrás de todo lo demás.
- **Contenido:** 10 secciones con guardado por sección; módulos del menú por escuela.
- **Viene marcado:** todo resuelto (cobra el 1, recuerda sola); la gracia y el recargo los decide la escuela.
- **Sale:** `/school-config` (huérfana), la pestaña Config de Pagos y la duplicada en `/settings`.
- **Hecho cuando:** una escuela nueva opera sin entrar a Configuración.

### 2.11 Escuela nueva (arranque)
- **Para qué:** que una escuela quede operando en 3 pasos: foto de la planilla, invitar por WhatsApp, cuánto cobras.
- **Hoy:** `SchoolOnboardingWizard` con 7 pasos (sede, modelo, equipo, plan, entrenador, atleta, cuenta). V1: 60+ toques → V2: 12.
- **Hecho cuando:** una escuela de prueba arranca en ≤ 12 toques.

---

## 3. Entrenador

### 3.1 Hoy
- **Para qué:** decir qué toca ahora: «En 40 minutos entrenas al Sub 11».
- **Tarea principal:** **Tomar lista**, una sola acción. Es hoy 3 o 4 entradas distintas.
- **Estado:** ✅ próximo entreno y plan. ◐ «Falta evaluar el entreno del martes» se puede derivar de `performance_entries` y `attendance_sessions`, pero no existe como pendiente.

### 3.2 Equipos y Asistencia (la lista)
- **Tarea principal:** tomar lista de 22 con 3 ausentes. V1: 22 toques → V2: 4. **Todos arrancan presentes; solo se toca a los que faltaron.**
- **Regla 05:** funciona sin señal y sube sola. **✖ No existe** (cero IndexedDB, cola offline o `navigator.onLine` en el frontend). Es el trabajo técnico más grande de este rol.
- **Estado:** ✅ lista presente por defecto. ◐ corregir hasta mañana: la fecha retroactiva solo existe en equipos, no en planes.
- **Hecho cuando:** 22 deportistas con 3 ausentes en ≤ 20 s, también en modo avión.

### 3.3 Sesiones
- **Para qué:** el plan del mes en palabras, y la pizarra por bloque.
- **Contenido:** Plan del mes · Semana · Carga · Balance del mes. Modo cancha: letra grande y pantalla encendida (**✖ no existe**).
- **Estado:** ✅ mesociclo y pizarra (M1–M6 hecha). 🔒 `WeekSessionsPanel` solo lo ve el administrador, no el coach.
- **Fuera de la V2:** pizarra animada, exportar video y vista 3D. Ya están construidos; no se tocan ni se destacan.

### 3.4 Evaluar
- **Tarea principal:** evaluar al equipo en una pantalla. V1: 100 toques → V2: 20, con «Bien · Normal · Le costó» por deportista.
- **Estado:** ◐ evaluación rápida 1 a 5 existe (665 manuales + 271 en sesión en 90 días). ✖ la escala «Bien · Normal · Le costó» y las métricas elegidas por la escuela no existen (Carmel usó 6 de 31 métricas).
- **Se suma aquí:** informe mensual (28 en 90 días, 2 escuelas) e informe grupal post-entreno. Arreglar antes el IDOR de `reports.ts:661-680`.

### 3.5 Más
- Calendario, rutinas, dotación, salud, ayuda, y **Agenda** (disponibilidad y citas: 734 franjas, 18 coaches, 13 escuelas, la función sin lugar con más uso real del entrenador).
- **Sale:** subir hoja de matrícula (0 subidas por coaches), Mensajes.

---

## 4. Acudiente

### 4.1 El cobro por WhatsApp y Pagar sin iniciar sesión
Es el módulo que convierte «pagar más rápido» en producto. Va en la **ola 1**.

- **Para qué:** que la mamá pague desde el chat sin contraseña.
- **Tarea principal:** pagar la mensualidad. V1: 9 toques → V2: 2. Toca «Pagar $180.000» en el WhatsApp del club y paga.
- **Medios, con lo que hay en producción:** pagar en línea (tarjeta, PSE, Nequi por Wompi) · transferencia con subida de comprobante. **Bre-B queda como «Pronto»** hasta que Factus tenga fecha.
- **Viene marcado:** el monto firmado, el cobro del mes; «Pagar también inscripción y seguro» como opción en el mismo enlace.
- **Estado hoy:** ✅ `/p/:token` con pago en línea y subir comprobante desde el enlace (desde el 13-oct, el cruce lo daba por parcial). ◐ «Pagar también inscripción y seguro»: sin verificar. ✖ «¿No eres Carolina? Avísanos».
- **Brechas medidas el 24-oct:**
  - Un acudiente **sin cuenta** no existe para el bot: la consulta de pagos filtra por `parent_id`. Caso real: 12 familias de Besser, $6,32 M.
  - En Dynasty, Wompi no ha avisado ningún pago desde el 07-oct; 0 cobros con transacción de Wompi desde el 13-oct.
  - La aprobación automática depende de la conciliación por correo del banco (DKIM) y de los menores sin `parent_id`.
- **Hecho cuando:** medido en Dynasty y Besser, tiempo de cobro a pago y porción que llega por enlace; y un acudiente sin cuenta paga desde el chat.

### 4.2 Inicio
- **Para qué:** «Todo al día, Carolina. Sofía entrena hoy a las 4:00 p. m.»
- **Contenido:** una frase, la tarjeta del hijo con la frase del profe, y tres filas: Ver cómo va · Pagos · Carnet. Una pregunta pendiente a la vez («¿Cuál es la EPS de Sofía?»).
- **Estado:** ✅ pagos y carnet. ◐ frase del profe (157 informes, solo 5 vistos). ✖ pedir datos «de a una pregunta».

### 4.3 Calendario
- Entrenos, partidos y torneos del hijo. **Se suma:** inscripción a torneo e inscripciones (`/tournaments/:eventId/register`, `/my-event-registrations`), hoy sin lugar en el lienzo. Se alinea con los torneos de la escuela y los torneos en vivo.

### 4.4 Hijos (ficha del hijo)
- **Contenido:** progreso, asistencia, informes mensuales, salud.
- **Estado:** ✅ (verificado en el código el 2026-11-26) Progreso lee `performance_entries` vía el BFF (`parent/v2/hijos/useHijosData.ts`) y `/children/:id/progress` usa `AcademicProgressPage`, que también lo lee; `academic_progress` queda como «evaluaciones anteriores». `ChildProgressPage` (la que leía solo la tabla legada) no tenía ruta y se borró. Pendiente aparte: `/evaluations` (`CoachEvaluationsPage`, sin enlace en ningún menú) todavía **escribe** en `academic_progress`.
- **Falta:** informe grupal post-entreno (`/children/:id/post-entreno-informe`).

### 4.5 Pagos
- Lista de cobros y total, tarjeta/PSE/Nequi, comprobante (486 en 90 días). Mismo núcleo que 4.1 pero dentro de la app.
- **Falta:** el atleta adulto no tiene tablero de pagos (`/athlete-payments` y `/my-payments` son duplicados que el rediseño no resuelve).

### 4.6 Más
- Tienda del club, citas, ayuda, Mapi, configuración, perfil.
- **Sale:** Constancias (0 emitidas), Mensajes (0), referidos con puntos (no existe `create_school_referral`).
- **🔒 Centro de ayuda:** `/ayuda` oculto.

### 4.7 Primera vez
- **Para qué:** «¿Eres Carolina, mamá de Sofía?» Sí. Lo demás se pide después.
- **Estado:** ◐ `/register?invite=` existe. **✖ no hay OTP por WhatsApp.** Línea base: 0 de 477 acudientes completaron la ficha.
- **Hecho cuando:** entrar por primera vez en ≤ 15 s.

### 4.8 Autoevaluación en el chat
- **Estado:** ✅ existe en la app (184 por acudientes, 21 por atletas en 90 días; responde el 4 %). ✖ responderla dentro de WhatsApp.

---

## 5. Deportista

| Módulo | Para qué | Estado |
|---|---|---|
| **Hoy** | Próxima sesión, «¿Qué tan duro fue?» de un toque, racha de entrenos, mostrar carnet | ✅ próxima sesión y carnet · ◐ formulario de esfuerzo · ✖ racha |
| **Entrenos** | Rutina para la casa y sesiones | ✅ |
| **Progreso** | Esfuerzo semanal y «lo que dijo el profe» | ✅ `/stats` |
| **Carnet** | QR para entrar y guardar imagen | ✅ · ✖ QR que se renueva cada minuto y Wallet |
| **Más** | Pagos, calendario, inscripciones, ajustes, perfil (76 atletas con login en 90 días) | **✖ No hay tablero.** Dibujarlo antes de construir |

**Sale:** Objetivos (`athlete_goals` = 0).

---

## 6. Transversales

| Módulo | Qué es | Estado |
|---|---|---|
| **Espacios** | Selector de escuela y rol, con último espacio guardado | ✖ `SchoolSwitcher` apagado desde el 21-abr; requiere columna nueva en el perfil |
| **Notificaciones** | Avisos in-app y push | ✅ 3.640 a acudientes, 153 leídas: el canal real es WhatsApp |
| **Mapi (asistente)** | Botón flotante de ayuda | ✅ |
| **Deshacer** | Patrón compartido: hook más aviso de 8 s | ✖ no existe en pagos; lo necesitan Aprobar, Comunicaciones y Lista |
| **Palabras** | Vocabulario único (`V2Palabras`) | ✖ solo existe en el lienzo; voseo pendiente en `TournamentRegisterPage.tsx:81` y `MyEnrollmentsPage.tsx:513` |
| **Sin conexión** | Cola local que sube sola | ✖ no existe |
| **SportPoints** | Puntos y premios de marcas aliadas | ✖ sin tabla ni código, sin presupuesto: **fuera de la primera tanda** |

---

## 7. Otros roles: se congelan en esta tanda

| Rol | Decisión | Por qué |
|---|---|---|
| Profesional de salud | Congelar | `clinical_patients` = 0, 1 cita histórica |
| Entrenador personal | Mantener, sin rediseño | Sin barra propia hoy; no es prioridad |
| Vendedor / tienda externa | Postergar | `vendor_payouts` = 0, reseñas = 0 |
| Super Admin | Solo MFA y limpieza | Ningún super_admin tiene MFA (SEG-13); `/admin/analytics` es mock |
| Organizador | Quitar (10 pantallas) | `event_organizers` = 0; los torneos viven en la escuela |

---

## 8. Qué se quita (sin uso medido)

Mensajes y Chat · Anuncios · Encuestas · Constancias y sus plantillas · Membresías · Objetivos del atleta · módulo organizador · subir hoja de matrícula como coach · tienda de vendedores externos (postergada) · Explorar global (se mantiene oculto) · rutas muertas (`/evaluations`, `/programs-management`, `/school-config`, `/pickup`, `/nutrition`, `/escuela/:id`, `/pagos/confirmacion`, `/shop`, `/marketplace*`, `/children/:id/progress|attendance`, `/vendor/appointments`) · en Super Admin: `/admin/clubs`, `/admin/logs`, `/admin/upgrade-requests`, `/admin/analytics`.

Antes de borrar cualquier ruta se mide si tiene uso en la base viva y se avisa al usuario. Borrar es decisión suya.

---

## 9. Orden de construcción

| Ola | Qué | Módulos | Depende de |
|---|---|---|---|
| **0 · Cimientos** | Palabras · Deshacer · tokens y píxeles fijos · menú unificado en el código | 6 (Palabras, Deshacer), 1 | Nada. Se puede empezar ya |
| **1 · Cobro y WhatsApp** | Pago sin sesión completo · acudiente sin cuenta reconocido · Comunicaciones F0/F1 · Hoy del dueño con Aprobar y Deshacer | 4.1, 2.1, 2.6, 2.8 | Wompi de Dynasty avisando; DKIM para la auto-aprobación |
| **2 · Entrenador en la cancha** | Lista sin señal · Evaluar en una pantalla · plan de hoy en palabras · modo cancha | 3.1–3.4 | Patrón Deshacer · cola sin conexión |
| **3 · Primera vez y arranque** | OTP por WhatsApp · escuela nueva en 3 pasos · carga por foto de planilla | 4.7, 2.11, 2.2 | Canal de WhatsApp por escuela |
| **4 · Lo que depende de afuera** | Bre-B · SportPoints · racha · Wallet | — | Factus · presupuesto |

**La compuerta no cambia:** prueba con 5 personas reales y 12 tareas antes de construir las olas 2 y 3. La ola 1 no la espera.

**Antes de dibujar encima, terminar lo roto:** modal único «Cobros y pagos» (flag apagado) · Progreso del hijo (lee una tabla muerta) · Mensajes · Centro de ayuda · semana de sesiones del coach · barra inferior por rol (hoy ignora billing y usa `profile.role`).

---

## 10. Decisiones abiertas (necesito respuesta)

| # | Pregunta | Mi propuesta |
|---|---|---|
| D-V2NAV | ¿Confirmas el menú de la escuela como está en el lienzo (Cobros + Entrenadores)? | Sí |
| D-CASAS | ¿Planes en Cobros, QR en Deportistas y Dotación en Escuela? | Sí |
| D-BIB | ¿Cuál biblioteca de ejercicios queda: `trainer_routines` o los ejercicios de sesión? | Medir uso antes de decidir |
| D-COM | Las 4 decisiones de Comunicaciones (§8 de su spec) | Ver ese spec |
| D-ATL | ¿Dibujamos el «Más» y los Pagos del deportista adulto? | Sí, antes de construir |
| D-ZERO | ¿Los módulos congelados de §7 son correctos? | Sí |

---

## 11. Cómo se mide que cada módulo cerró

Cada ola se cierra con el número de antes y el de después, medido en la base viva:

- **Cobro:** tiempo desde el aviso hasta el pago; porción de pagos que entra por enlace; comprobantes aprobados sin intervención.
- **Comunicaciones:** respuestas desde el panel; borradores aprobados.
- **Entrenador:** listas tomadas a tiempo; evaluaciones por semana.
- **Acudiente:** fichas completadas (hoy 0 de 477); informes vistos (hoy 5 de 157).
- **Todo:** tareas de la prueba de las 5 personas resueltas sin ayuda (4 de 5 en el tiempo meta).
