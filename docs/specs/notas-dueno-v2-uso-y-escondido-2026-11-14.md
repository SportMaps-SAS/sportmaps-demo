# Notas — Dueño V2: uso medido y lo que la definición V2 esconde

Estado: **material de consulta** (2026-11-14). No es un plan de construcción: la V2 del dueño la tenía **otra sesión**; esto es lo que encontré al cruzar el uso real con `docs/specs/modulos-v2-definicion.md` por si sirve para revisarla.
No se escribió código, no se tocó la base (solo una consulta de lectura) y no se commiteó.

---

## A. Lo que encontré sobre el estado de la V2 del dueño

- **Del dueño V2 no hay código todavía.** Verifiqué en `frontend/src/lib/feature-flags.ts` y `components/v2/RutasSegunRol.tsx`: solo existen `ACUDIENTE_V2`, `ENTRENADOR_V2` y `DEPORTISTA_V2`. No hay bandera ni pantallas del dueño.
- **La definición sí está escrita:** `docs/specs/modulos-v2-definicion.md` §1 y §2 (propuesta para aprobar, 2026-10-24). Barra del celular: Hoy · Deportistas · Cobros · Entrenadores · Más; owner y school_admin comparten un solo árbol. Cada módulo trae su lista «Sale» y su «Hecho cuando».
- **El patrón de construcción ya está probado con otros tres roles:** bandera de reversa, pantallas en `components/<rol>/v2/`, `RutasSegunRol.tsx`, y la burbuja de Mapi y la barra inferior que trae el cascarón (`layouts/cascaronV2.ts`).
- **Mapi:** plan del agente (`mapi-agente-plan.md`) con 5 oleadas (§19), todavía **pendiente de aprobar**.

---

## B. Uso real y lo que la definición V2 hace con cada módulo

### B.1 Uso real, últimos 90 días, solo escuelas reales

Consulta de solo lectura a la base viva. Cuenta **filas creadas** y **escuelas distintas** que las crearon (se excluyen escuelas `test`/`demo`).

| Módulo (tabla) | Filas | Escuelas |
|---|---:|---:|
| Constancias (`athlete_certificates`) | 0 | 0 |
| Torneos / eventos (`events`) | 0 | 0 |
| Reservas de instalaciones (`facility_reservations`) | 0 | 0 |
| Rutinas (`trainer_routines`) | 1 | 1 |
| Equipos (`teams`) | 45 | 7 |
| Sesiones de entreno (`training_sessions`) | 128 | 2 |
| Informe mensual (`athlete_reports`) | 256 | 2 |
| Prospectos / QR (`school_signup_leads`) | 297 | 3 |
| Recordatorios (`collection_notices`) | 379 | 3 |
| Facturación electrónica (`electronic_invoices`) | 561 | 1 |
| Inscripciones (`enrollments`) | 644 | 8 |
| Pagos (`payments`) | 2.851 | 7 |
| Métricas (`performance_entries`) | 3.205 | 2 |
| WhatsApp (conversaciones) | 3.818 | 2 |
| Asistencia (`attendance_records`) | 6.747 | 5 |
| Control de acceso (`access_events`) | 9.103 | 2 |

**Lo que esta medición NO dice** (importante para decidir):
- Mide lo que se **escribe**. Un módulo de solo lectura (Reportes, Panel de reportes, Finanzas) puede usarse mucho y aquí aparece en cero o ni aparece. **No hay analítica de pantallas** (`analytics_events` está vacía), así que no sé qué se **mira**.
- Pocas escuelas no es lo mismo que poco valor: **Control de acceso** tiene 9.103 eventos en solo 2 escuelas (los lectores de GYM RM y Dreamers). Para ellas es crítico.
- Facturación electrónica: 1 escuela (la que tiene Factus), pero 561 facturas. Se esconde por escuela, nunca para todas.
- Las filas de recordatorios las crea el cron, no una persona: no cuentan como «uso del dueño».

### B.2 Lo que ya existe y se reutiliza

- **La definición de la V2 del dueño ya está escrita:** `docs/specs/modulos-v2-definicion.md` §1 y §2 (propuesta para aprobar, 2026-10-24). Barra del celular: **Hoy · Deportistas · Cobros · Entrenadores · Más**; owner y school_admin comparten **un solo árbol**. Cada módulo trae su lista «**Sale**» (lo que se funde, se oculta o se borra) y su «Hecho cuando».
- **El patrón de construcción V2**, ya probado con otros tres roles: bandera de reversa (`VITE_ACUDIENTE_V2`, `VITE_ENTRENADOR_V2`, `VITE_DEPORTISTA_V2` en `frontend/src/lib/feature-flags.ts`), pantallas en `components/<rol>/v2/`, y `RutasSegunRol.tsx` que decide qué pantalla ve cada rol. La burbuja de Mapi y la barra inferior ya las trae el cascarón (`layouts/cascaronV2.ts`).
- **Del dueño V2 no hay código todavía.** Verifiqué: no existe bandera ni pantallas del dueño (solo las tres de arriba). Está en el track V2 como parte de la ola 1 («Dueño Hoy»).
- **Apagar ítems por escuela** (`school_module_overrides`, 24 claves, `ModuleGate`): sirve de red de seguridad para una escuela que necesite algo escondido.
- **Mapi**: spec aprobado el 2026-10-27 y plan del agente (`mapi-agente-plan.md`, **pendiente de aprobar**) con las 5 oleadas de §19 y la regla «una herramienta por acción de pantalla, sobre el mismo servicio de la pantalla».
- **Mapa de la app para Mapi**: `bff/src/data/app-map.ts` (si cambia la navegación, se actualiza en el mismo commit).
- **Biblioteca de ejercicios** ya presente: tablas `exercise_library`, `exercise_packs`, `exercise_assignments`, `exercise_logs` y los componentes `ExerciseLibraryPanel` / `ExercisePacksTab`. El BFF mezcla wger.de + `free-exercise-db` (fotos estáticas) con traducción automática. *(por verificar)* qué tienen exactamente las tablas antes de crear nada nuevo. Ojo: el spec V2 §2.3 deja abierta **D-BIB** (las dos bibliotecas de ejercicios se unifican y no está dicho cuál queda); el catálogo del lémur cae justo ahí.

### B.3 Trampas que ya costaron caro y aplican aquí

- **Dos árboles de menú** (`school` y `school_admin`). Un cambio en uno que no se hace en el otro no lo nota nadie. Todo cambio de menú va en **los dos**.
- **El caso `SHOW_EXPLORE`**: una función quedó inaccesible en producción y por eso parecía que «nadie la quería». **Esconder puede fabricar su propio dato de «no uso».** Hay que medir contra esa trampa (ver C.3).
- **Mapi no mueve plata** (spec §4.2) y todo lo que escribe va por borrador → Confirmar.
- **Disk IO**: una sola sesión aplica migraciones; importar un catálogo grande va en lotes.

---

## C. Propuesta: Dueño V2 con Mapi al centro, construido por lo menos usado

### C.1 Idea en una línea

La V2 del dueño muestra solo lo que se hace a diario (**Hoy, Deportistas, Cobros, Entrenadores**) y deja lo demás en **Más** o lo funde en otra pantalla. **Mapi es el atajo a todo lo escondido**: «hazme una constancia», «¿quién no tomó lista ayer?», «llévame a reservas». Y la V2 se construye empezando por los módulos de menos uso, que son los más baratos y menos riesgosos de reorganizar.

### C.2 Qué ya dice la definición V2 que sale o se esconde, cruzado con el uso medido

Uso: últimos 90 días, escuelas reales, filas creadas (consulta del 2026-11-14). El spec V2 se escribió el 24-oct con otra ventana, por eso algunas cifras difieren.

| Módulo | Uso medido hoy | Qué dice la V2 (§2) | Tratamiento propuesto |
|---|---|---|---|
| Constancias | 0 filas, 0 escuelas | Sale (§2.2) | **Primero en construirse como escondido.** Mapi la emite. |
| Reservas de instalaciones | 0 filas | «Sedes e instalaciones» unificadas, dentro de Escuela (§2.9) | Fundido en Escuela › Sedes; Mapi reserva |
| Torneos / eventos | 0 filas en 90 días | Pestaña dentro de Calendario (§2.5) | Dentro de Calendario; sin entrada propia |
| Rutinas / Biblioteca de ejercicios | 1 fila, 1 escuela | Biblioteca dentro de Entrenadores; **D-BIB abierta** (§2.3) | Aquí entra el catálogo del lémur (Parte B) |
| Informe mensual | 256 filas, 2 escuelas | Evaluaciones e informes dentro de Entrenadores | Dentro de Entrenadores, solo lectura para el dueño |
| Prospectos / QR | 297 filas, 3 escuelas | Deportistas › Ingreso (§1, §2.2) | Pestaña de Deportistas |
| Panel, Reportes, Finanzas, Panel de reportes | **sin medir** (solo lectura) | Salen: cada cifra va junto a lo que mide (§2.1) | Se funden en Hoy; **medir antes de decidir** |
| Control de acceso | 9.103 eventos, 2 escuelas | Escuela › Control de acceso; el spec marca que **no tiene tablero** | **No se esconde:** es crítico para esas escuelas; falta su tablero |
| Facturación electrónica | 561 facturas, 1 escuela | Pasa a pestaña de Cobros (§2.6) | Dentro de Cobros, solo si la escuela la tiene contratada |
| Pagos / Asistencia / Inscripciones / WhatsApp | uso alto | Núcleo | Núcleo; no se esconde |

**Lo que la medición NO dice:** mide lo que se **escribe**, no lo que se **mira**. No hay analítica de pantallas (`analytics_events` vacía), así que Reportes, Panel y Finanzas no se pueden clasificar con esto. Pocas escuelas tampoco es poco valor (Control de acceso). Las filas de recordatorios las crea el cron, no una persona.

### C.3 Orden de construcción: de menos a más usado *(decisión pendiente)*

El orden que tienen hoy el spec V2 y el plan de Mapi parte del uso diario («Hoy» y la aprobación de comprobantes primero). Tu planteamiento es el inverso. Los dos tienen sentido y se pueden combinar:

| Tanda | Qué se construye | Por qué en este orden |
|---|---|---|
| **T0** Cimientos | Bandera `VITE_DUENO_V2` (propuesta de nombre), `RutasSegunRol` para el dueño, barra inferior y «Más», un solo árbol para owner y school_admin | Sin esto no hay dónde esconder nada. Reutiliza el patrón de los otros tres roles. |
| **T1** Lo de uso cero | Constancias, reservas de instalaciones, torneos: viven escondidos (Más / dentro de otra pestaña) y **Mapi los hace** (emitir constancia, crear reserva) | Riesgo mínimo: nadie los usa hoy, así que no se rompe a nadie, y prueba el patrón «escondido + Mapi» de punta a punta. Son acciones reversibles y no mueven dinero. |
| **T2** Uso bajo | Entrenadores (informes y biblioteca), Deportistas › Ingreso (QR y prospectos), Escuela (sedes, perfil público, dotación) | Sube la complejidad, con usuarios reales pero pocos. |
| **T3** Lo que se mira | Hoy (agregador de pendientes) y el reemplazo de Panel/Reportes/Finanzas, **después de medir qué se mira** | No se puede fundir lo que no se midió. |
| **T4** El núcleo | Cobros (aprobar con Deshacer, modal único), WhatsApp, Asistencia | Es lo que más valor tiene y lo que más duele si se rompe: va al final, con el patrón ya probado y con la compuerta de pruebas con personas. |

**Mi recomendación:** T0 y T1 ya (barato y seguro). En paralelo, **no frenar** lo que ya está aprobado para cobranza en Mapi (oleada 1) ni lo de WhatsApp, porque ahí está el valor real hoy (Dynasty, Monster). T3 y T4 se deciden con lo que se aprenda en T1. Es un híbrido: tú propones empezar por lo menos usado, yo propongo que eso no detenga lo que ya genera valor.

### C.4 Mapi como eje del dueño

- **Dónde vive:** la burbuja de Mapi ya está en el cascarón V2 (`fabVisible`); en el dueño V2 es además el atajo a lo escondido.
- **Fase 1, solo lectura:** herramienta `abrir_modulo` («eso está en Más › Constancias», con botón) y consultas del estado de cada módulo escondido. No escribe nada.
- **Fase 2, acciones de bajo riesgo:** emitir constancia, crear reserva. Entran por el flujo de siempre: **borrador → Confirmar**, con permisos en el servidor y no en el prompt.
- **Fuera de alcance de Mapi** (spec §4.2): borrar datos, anular o editar pagos, cambiar precios, roles, permisos y pasarelas.
- Cada herramienta nueva exige lo que pide el plan del agente: 3 evals mínimo (uno de rechazo por permiso), pruebas de seguridad y encendido escuela de pruebas → piloto → resto.

### C.5 Cómo sabremos que funcionó

Se heredan los «Hecho cuando» del spec V2 y se suman estos:
- Una pregunta del dueño por algo escondido se resuelve **en un turno** de Mapi, sin escribirle a soporte.
- Cero tickets nuevos del tipo «no encuentro X».
- La V2 del dueño entra a la **compuerta de pruebas con personas** (5 personas reales, tareas cronometradas) antes de quitar la reversa.
- Ninguna herramienta nueva de Mapi escribe sin borrador ni confirmación.

### C.6 Riesgos de esconder y cómo se cubren

| Riesgo | Cobertura |
|---|---|
| Reproducir el caso `SHOW_EXPLORE`: lo escondido «no se usa» porque nadie lo ve (y se cuenta como adopción cero) | «Más» siempre visible; Mapi lo ofrece; se mide antes y después; el spec V2 ya exige no mostrar destinos que el lateral oculta |
| Esconder algo que una escuela sí usa a fondo (control de acceso, facturación) | Esos no se esconden; lo con addon sigue el addon; `school_module_overrides` como red de seguridad por escuela |
| La reversa: el dueño V2 sin poder volver | Bandera `VITE_DUENO_V2=false` como en los otros tres roles, con la pantalla clásica intacta hasta que la V2 esté estable |
| `app-map.ts` desactualizado y Mapi manda al lugar equivocado | Se actualiza en el mismo commit que la navegación |
| Dos árboles de menú | La V2 los une en uno solo para owner y school_admin; aun así, probar con los dos roles |
| Quitar de golpe algo que la escuela de Dynasty usa | La primera escuela real la elige el usuario (D6); Dynasty no va primero |


---

## D. Qué sigue, si lo retomas

- Decidir **si la V2 del dueño se construye desde cero o continúa lo que tenía la otra sesión** (no encontré su trabajo en el repo).
- Decidir **si se mide lo que se mira** (analítica de pantallas) antes de fundir Reportes, Panel y Finanzas.
- Elegir **la escuela real** para la primera prueba (no propongo Dynasty primero).

## E. Onboarding ya construido: reutilizarlo, no reescribirlo (nota del 26-nov-2026)

Antes de diseñar el inicio o el arranque de la V2 del dueño, que este trabajo existe y está en `main` y `develop`. Análisis y propuesta: `docs/onboarding/registros-19-22-nov-2026-y-tutorial-guiado.md` (sección 2.7 manda sobre el resto). Diseño pendiente de la Etapa 4: `docs/onboarding/etapa-4-recordatorios-whatsapp-diseno.md`.

**Qué reutilizar tal cual**

| Pieza | Dónde | Qué hace |
|---|---|---|
| Pasos del checklist por rol | `frontend/src/lib/onboarding/onboardingChecklists.ts` | Academia (6 pasos), Club / Canchas (4) y acudiente (3). Cada paso se marca por lo que existe en la base, no por clics. Sin React ni íconos. |
| Reglas del asistente | `frontend/src/lib/onboarding/schoolOnboardingRules.ts` | Solo el deporte bloquea la entrada al panel (y solo si falta); el resto se salta. |
| Componente del checklist | `frontend/src/components/dashboard/DashboardChecklist.tsx` | Se colapsa a una píldora «2/6» y se reabre. Genérico: sirve para cualquier rol si se le pasan los pasos. |
| Datos del avance | RPC `get_onboarding_status` y `get_onboarding_checklist_extras` | Fuente única de «qué existe ya». |
| Medición | RPC `track_onboarding_event` y los triggers de hitos (`first_*`) | Embudo en `docs/onboarding/embudo-*.sql`. |
| Solicitudes de unión | `submit_school_join_request` y el job `solicitudes-union-avisos.job.ts` | Aprobación automática con coincidencia sin ambigüedad; aviso y recordatorio de 24 h. |

**Qué NO hacer**

- No crear otro asistente largo. La decisión de producto del 22-nov es que lo único obligatorio para entrar es el nombre y el deporte; «escuela nueva en 3 pasos» debe unificarse con `SchoolOnboardingWizard`, no sumarse a él.
- No volver a marcar pasos por clic. Siempre desde la base (por eso el paso se ve hecho si la escuela cargó deportistas por QR, foto o importación).
- No ocultar el checklist en `onboarding_status = completed`: sigue hasta el primer cobro.

**Qué se rompe si se mueven pantallas**

Los pasos apuntan a rutas (`/offerings`, `/students`, `/payments-automation`, `/staff`, `/teams`, `/branches`, `/children`, `/my-payments`, `/unirse`, `/venue/*`) y el aviso de WhatsApp de solicitudes a `/students?bandeja=por-asignar`. La prueba `frontend/src/lib/onboarding/checklistRutas.test.ts` falla si alguno deja de existir en `App.tsx`: si el menú de 44 a 10 renombra o fusiona rutas, ese es el aviso. Un cambio de ruta se resuelve en `onboardingChecklists.ts` (un solo archivo), no en cada pantalla.

**Dónde se monta hoy** (lo que habría que re-montar si cambia el inicio): `DashboardPage` (academia), `VenueDashboardPage` (club), el inicio V2 del acudiente y `MyChildrenPage` / `MyChildrenPageClassic` (tarjeta de solicitudes). La casilla de consentimiento de WhatsApp y las descripciones de rol viven en `RegisterPage`; si el alta pasa a «¿Eres Carolina?», hay que llevarse la casilla, porque el trigger de la base (`profiles.whatsapp_consent_at`) solo la lee del metadata del registro.

**Pendiente de la Etapa 4** (sin código): recordatorios automáticos por WhatsApp con tope de 3 en la primera semana, que respetan el «no». El único universo alcanzable son los registros posteriores a la casilla de consentimiento; las escuelas anteriores no tienen consentimiento.
