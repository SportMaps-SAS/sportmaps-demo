# Mapi por WhatsApp para administradores — plan (2026-11-09)

**Qué es:** el administrador de una escuela (Iván en Monster, Milena en Dynasty) recibe por el **número de SportMaps (+57 320 268 3539)** los avisos de lo que necesita a una persona, y desde ese mismo chat **le hace preguntas a Mapi** y, con confirmación, le pide que haga cosas. Es la puerta de entrada del agente de Mapi (`mapi-agente-plan.md`) por el canal de plataforma (`canal-whatsapp-plataforma.md`).
**Pedido del usuario (11-09, noche):** armar el plan con lo que ya hay y empezar al día siguiente con el canal (F2) y el agente de IA de Mapi.
**Por qué ahora:** la clínica de Monster mostró que la app y el correo no se leen (20 avisos en la app, 20 sin leer; tres casos urgentes sin ningún aviso) y que el administrador vive en WhatsApp.

## 1. Cómo se ve (ejemplos)
```
SportMaps  Hola, en Monster´s Volley Club hay un caso de WhatsApp que necesita a una persona:
           Angela pidió hablar con la escuela. Respóndele a la familia desde SportMaps.   [Ver en la app]

Iván:      ¿cómo vamos con la clínica?
Mapi:      Clínica de armadores · preventa hasta hoy.
           Pagados: 4 ($1.050.000) · abono: 1 ($150.000, saldo $150.000)
           Con datos de pago y sin comprobante: 8. Piden persona: 2.            [Ver quiénes]

Iván:      aprueba el pago de $600.000 de Katherin
Mapi:      ┌ Aprobar pago ──────────────────────────────┐
           │ Katherin R · $600.000 · Bancolombia · hoy   │
           │ 2 cupos: Valentina R. y María Alejandra M.  │
           │ Supera el tope de $400.000: lo confirmas tú │
           │          [Confirmar]  [Cancelar]             │
           └──────────────────────────────────────────────┘
Iván:      [Confirmar]
Mapi:      Listo: quedaron pagados los 2 cupos y le avisé a Katherin.    ← lo escribe el servidor
```

## 2. Lo que ya tenemos (estado al cierre del 11-09)
| Pieza | Estado |
|---|---|
| Número de SportMaps conectado al canal (`platform_wa_canal`, token cifrado, webhooks suscritos) | **hecho** (`bff/scripts/wa-conectar-canal.ts`); canal APAGADO |
| 5 plantillas de aviso `sm_*` en la cuenta «Sportmaps» | registradas, **en revisión de Meta**; Meta recategorizó 2 a MARKETING (`sm_caso_por_atender`, `sm_clase_cortesia_novedad`) |
| Canal F1: opt-in con «ACTIVAR <código>», preferencias, horario silencioso, envío con reserva, ganchos en los 5 eventos | hecho, detrás de `PLATFORM_WA_ENABLED` / `platform_wa_canal.habilitado` |
| Canal F2: modo pruebas con cortafuegos (`/escuela`, `/como papa`…) | hecho, detrás de `PLATFORM_WA_TESTERS`. **No es lo mismo que el agente**: simula a una familia |
| Motor del agente (`mapi-agente/`: ciclo, registro de herramientas, borradores) | **NO construido**; solo `mapi-contexto.service` y `mapi-feedback.service` |
| Herramientas de cobros especificadas (§20.3 del plan de Mapi) | especificadas, sin código |
| «Aprobar un comprobante desde el chat» | **decidido** el 2026-11-08 («sí, exactamente es eso», §20.6.1) |
| Qué hace hoy un administrador suscrito que escribe al canal | solo una ayuda corta, 1 vez cada 24 h (canal §3.3) |
| Suscripciones activas / escuelas habilitadas | 0 / ninguna |

**Nombres:** en el spec del canal «F2» es el modo pruebas (ya hecho). Este plan es la fase nueva **F5 del canal: entrantes de administradores atendidos por Mapi**, que usa el motor del plan de Mapi.

## 3. Decisiones del canal que este plan cambia (pedir OK)
| Decisión vigente | Cambio propuesto | Base |
|---|---|---|
| **D9** «Nada se aprueba desde WhatsApp; solo enlaces a la app» | Mapi puede **aplicar y aprobar con tarjeta de confirmación** (borrador → [Confirmar]), con topes y solo para administradores suscritos | decisión del 11-08 (§20.6.1) y práctica de la clínica (11-09) |
| **D11** informe sin nombres ni teléfonos | **Las plantillas siguen sin nombres** (cifras + enlace). Dentro de la ventana de 24 h, en la conversación con el administrador suscrito, Mapi puede dar nombres de familias | el administrador ya los ve en su app |
| **§3.3** suscrito que escribe → ayuda corta | suscrito que escribe → **Mapi** (si la escuela tiene el agente encendido) | |
| **D12** desconocidos → silencio | **se mantiene** | evita chocar con ventas |
Se mantiene tal cual: D3 (token cifrado), D4 (el consentimiento lo da el propio número), D5 (se revalida owner/admin en cada envío), D6 (horario silencioso), D7 (idempotencia), D15 (service-only).

## 4. Arquitectura (reusa lo existente)
1. **Entrante:** en `atenderEntrantePlataforma`, antes de la «ayuda corta»: si el `from` tiene suscripción activa de una escuela con el agente encendido → `mapiPorWhatsApp.atender(...)`.
2. **Identidad:** el número que escribe (Meta autentica el `from`) + suscripción activa + owner/admin vigente (D5). `school_id` y `profile_id` salen de la suscripción, **nunca** de lo que diga el modelo. Si el administrador lo es de varias escuelas, Mapi pregunta cuál y la recuerda 24 h.
3. **Motor:** `bff/src/services/mapi-agente/` del plan de Mapi §3.1 (`agente.ts`, `registro.ts`, `borradores.ts`, `herramientas/*`). El canal de WhatsApp es solo **un adaptador** de entrada/salida (la pantalla de la app es el otro).
4. **Salida:** texto libre dentro de la ventana de 24 h; botones de respuesta para [Confirmar] / [Cancelar] / [Ver quiénes]; fuera de la ventana solo plantillas aprobadas.
5. **Confirmación:** el id del botón lleva el borrador (`mapi:confirmar:<borrador_id>`). El servidor comprueba que el borrador es de **esa** suscripción, lo **re-prepara** (§10.1 del plan de Mapi) y el «Listo» lo escribe el servidor (§10.3). Un botón viejo no ejecuta nada.
6. **Tablas:** reutiliza `platform_wa_*` y los borradores del plan de Mapi (§5). Migración nueva solo si hace falta (plan antes de código; una sola sesión aplica migraciones; regla de Disk IO).
7. **Kill-switches:** los del canal (§4 del spec) + un interruptor propio `mapi_whatsapp` por escuela.

## 5. Herramientas por oleada
**Oleada 1 — consulta (solo lectura; mañana):**
| Herramienta | Responde |
|---|---|
| `estado_de_servicio(servicio?)` | «¿cómo vamos con la clínica?»: pagados, abonos, con datos de pago sin comprobante, piden persona (nace de la clínica del 11-09) |
| `comprobantes_por_revisar()` | cuántos y cuál espera más |
| `casos_por_atender()` | quién pidió hablar con alguien, quién tiene pregunta sin responder |
| `cartera(periodo)` | mora y plata, igual que la pantalla (plan de Mapi §4) |
| `buscar_deportista` / `resumen_deportista` | plan de Mapi §4 |
| `estado_de_campana()` | enviados, «Sí», bajas, cupo de Meta del día |

**Oleada 2 — acciones con confirmación:** `aprobar_comprobante`, `aplicar_comprobante_a_cobro` (incluye pagos de varios deportistas: lista «Jugador 1… Jugador 2» y monto múltiplo del precio), `crear_ficha_desde_chat` (el caso Dynasty), `escribir_a_familia` (borrador del mensaje → confirmar).
**Oleada 3 — masivas:** recordatorios y campañas (con tope y vista previa).
**Fuera de Mapi:** encender o cambiar la aprobación automática (§19.5), conectar números, tocar precios.

## 6. Avisos de salida (lo primero de mañana, en cuanto Meta apruebe)
| Evento | Urgencia | Plantilla | Hoy |
|---|---|---|---|
| Pide hablar con una persona («Hablar con alguien») | urgente | `sm_caso_por_atender` | solo notificación en la app |
| Comprobante que no cuadra o supera el tope | urgente | `sm_caso_por_atender` | quedó en la cola sin aviso (caso $600.000) |
| Pregunta que el bot no supo contestar | urgente | `sm_caso_por_atender` | pendiente en el buzón |
| Interesado caliente (pidió pago y no pagó, o se retira por precio) | normal | resumen | sin aviso |
| Comprobantes en revisión | normal | `sm_comprobantes_por_revisar` | cron de pagos por validar (flag de WhatsApp apagado) |
| Resumen del día | diario | `sm_resumen_diario` | existe como evento |
Reglas: una clave determinística por evento (D7); un aviso por conversación por hora como máximo; lo de la noche entra al resumen de las 7:00 (D6); **en la clínica, los urgentes pasan el horario silencioso hasta el cierre de la preventa** (propuesta).

## 7. Orden de construcción (mañana en adelante)
1. **Revisar las plantillas** (¿aprobadas? ¿marketing o utilidad?). Si Meta las dejó en marketing y estorba, registrar versiones neutras.
2. **Prerrequisito:** confirmar quién es el owner/admin de Monster en la app (quien genera el código «ACTIVAR»), y habilitar a Monster en `/admin/whatsapp` (con OK).
3. **Disparadores → canal** (§6): reutilizar los eventos existentes (`abrirEnBuzon`, `avisarAdministracion`, cola de comprobantes) como destino más (D10).
4. **Suscribir a Iván:** código desde la app → «ACTIVAR <código>» al 320 268 3539 desde el WhatsApp del club. Probar con el modo pruebas (F2) y con un aviso real.
5. **Motor del agente** (plan de Mapi §7 pasos 1-2): ciclo, registro, borradores, encendido por escuela, topes, `llm_usage`; pruebas con el modelo simulado.
6. **Oleada 1** (§5) y el adaptador de WhatsApp (§4). **Evals con el modelo real** (plan de Mapi §14) antes de encender para Iván.
7. **Oleada 2** cuando Iván la use sin fricción, empezando por `aprobar_comprobante` y `aplicar_comprobante_a_cobro`.
8. **Dynasty:** no se habilita hasta que Milena lo acepte (ver `dynasty-plan-actualizacion-v2-mapi.md` §2b: chat muy personal; un solo aviso al comienzo).

## 8. Seguridad y privacidad
- Datos de menores mínimos al modelo (plan de Mapi §12); nombres solo dentro de la conversación con el administrador.
- Cada acción deja `audit_logs` (actor = el administrador suscrito) y el borrador original.
- Topes: aprobar ≤ $400.000 por acción sin avisar de más; por encima, tarjeta con «supera el tope» (la decide el administrador); acciones por hora limitadas.
- Un número = un administrador de una escuela; quitarle el rol corta Mapi y los avisos (D5). `DESACTIVAR` en cualquier momento.
- Credenciales: el token del canal **se rota** (se pegó en el chat el 11-09): generar uno nuevo, volver a correr `wa-conectar-canal.ts --aplicar` desde la terminal del usuario y revocar el anterior.

## 9. Riesgos
| Riesgo | Mitigación |
|---|---|
| Plantillas recategorizadas a MARKETING (costo, límites de frecuencia, consentimiento) | esperar la decisión de Meta; versión neutra si estorba; los avisos reales abren la ventana de 24 h |
| El modelo elige mal una herramienta | evals (40 casos) antes de encender; las acciones siempre con tarjeta |
| Confirmar un borrador viejo | re-preparar al confirmar; el botón guarda el id del borrador |
| El administrador comparte el número con el club (Iván usa el teléfono del club) | la identidad es el número suscrito; `from` = el número del club; vale mientras él sea el único que lo usa |
| Costo del modelo | topes diarios por escuela (§13.2 del plan de Mapi), medir desde el día 1 |

## 10. Decisiones que necesita el usuario
1. **OK al cambio de D9** (§3): Mapi aplica y aprueba con confirmación y topes.
2. **Quién entra primero:** propuesta Iván (Monster), con la oleada 1; Milena después y a su ritmo.
3. **Tope de aprobación desde el chat:** propuesta $400.000 sin aviso extra (el mismo de la aprobación automática de Monster).
4. **Coaches:** propuesta dejarlos fuera de Mapi por WhatsApp en esta fase (solo administradores).

## 11. Criterios de aceptación (de la oleada 1)
- Un administrador suscrito escribe «¿cómo vamos con la clínica?» y recibe cifras que **coinciden con la pantalla** de pagos.
- Un caso «pide hablar con alguien» llega al WhatsApp del administrador en menos de 1 minuto, una sola vez.
- Un número no suscrito sigue recibiendo silencio; un suscrito sin rol vigente no recibe nada.
- Cero datos de otra escuela en cualquier respuesta (prueba cruzada).
- Evals con el modelo real: ≥ 90 % de elección correcta de herramienta en los 40 casos.
