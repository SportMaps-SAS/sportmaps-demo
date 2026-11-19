# Campaña Black Friday de SportMaps (a nivel plataforma)

**Estado:** borrador para aprobar · **Fecha:** 2026-11-18 · **Black Friday:** viernes 2026-11-27 · **Rama:** `develop`
**Alcance:** solo documento. No se registró ninguna plantilla en Meta, no se envió nada y no se tocó código.

> **Lo primero: las condiciones de la promo NO están escritas en ningún lado.** Se buscó en `docs/` y `docs/specs/` del repo, la landing (`Landing_page/.../frontend`), `Downloads` y las memorias. Lo único que aparece es: (a) «noviembre gratis si matriculas» de **Monster's** (`whatsapp-monster-maqueta.html`, `whatsapp-monster-plan-B5.md`), que es promo de una escuela, no de SportMaps; (b) «Black Friday: 30% en toda la tienda» en `help-articles.ts` de la landing, que es solo un ejemplo de cupones de la tienda; (c) «Anual −17% (2 meses gratis)» en el roadmap SaaS viejo. **Nada de «noviembre y diciembre gratis» para escuelas.** Por eso todo lo que dependa de condiciones va como `«POR CONFIRMAR»` y la lista de preguntas está en §1.

## 1. Preguntas abiertas para el usuario (sin esto no se aprueba nada)

| # | Pregunta | Por qué importa |
|---|---|---|
| Q1 | ¿A quién aplica? ¿Escuelas **nuevas** que se registren, también escuelas actuales, y entrenadores/bienestar? | Define audiencia y textos. Una promo «para todos» regala ingresos a quien ya paga. |
| Q2 | ¿Qué incluye «gratis»? ¿El plan **de pago** (Start $69.000 / Pro $159.000 / Elite $349.000 según la landing v3.0) o solo Free Start (que ya es gratis para siempre, 20 alumnos)? ¿Cuál plan se regala? | Sin esto «gratis» puede ser un plan que ya era gratis (no es promo) o uno que cuesta. |
| Q3 | Vigencia: ¿hay que **registrarse/activar** entre el 27-nov y qué fecha? ¿Los dos meses (nov y dic) corren calendario o desde la activación? Si alguien entra el 10-dic, ¿le sirve? | Cambia el texto («noviembre y diciembre» vs «2 meses») y la urgencia. |
| Q4 | ¿Desde enero se cobra el plan automático, o la escuela decide? ¿Se avisa antes (cuándo)? ¿A qué precio (mensual o anual)? | Obligación de claridad: es lo que más reclamo genera. |
| Q5 | ¿Tope de escuelas o cupo (p. ej. «primeras 50»)? | Evita prometer lo que no se puede sostener. |
| Q6 | ¿Pide tarjeta? (hoy la regla del roadmap es «sin tarjeta» para Free/trials). | Es la objeción nº 1. |
| Q7 | Mapeo a planes Free/Start/Pro/Elite: ¿la promo es por plan o por capacidad (alumnos)? ¿Qué pasa si una escuela de 300 alumnos entra al plan gratis? | La BD de la app aún tiene `starter/crecimiento/...`, no Start/Pro/Elite (memoria landing-pricing-v3): hay que decir contra cuál se implementa. |
| Q8 | ¿Se publica también en la landing de sportmaps.co (banner, página `/black-friday`)? ¿Quién edita la landing (repo aparte)? | Un anuncio que lleva a una landing sin la promo se pierde. |
| Q9 | ¿Qué incluye de Mapi/WhatsApp IA? Hoy «WhatsApp IA gratis, solo se paga a Meta si se excede» aplica a **todos** los planes desde 10-14. ¿Se menciona como parte de la promo? | No duplicar como «regalo» lo que ya es estándar. |
| Q10 | ¿Quién aprueba el texto y desde qué número/WABA salen las plantillas (el comercial +57 320 268 3539)? ¿Hay lista de prospectos con consentimiento? | Cumplimiento (§3). |
| Q11 | ¿Presupuesto de anuncios click-to-WhatsApp, y fecha de inicio? | Cronograma y cupo (§3.3). |

## 2. Objetivo y audiencia

**Objetivo:** conseguir escuelas nuevas activadas (no solo conversaciones) en la ventana de Black Friday, y reactivar a las que se registraron y no operaron. Métrica norte: **escuelas con cuenta activa y primer atleta cargado** atribuidas a la campaña. Meta numérica: `POR CONFIRMAR` (no inventar).

| Audiencia | Fuente | Canal permitido | Nota |
|---|---|---|---|
| A. Leads que **escriben** al +57 320 268 3539 (por anuncio o directo) | `platform_wa_mensajes`, atribución `referral`/`ctwa_clid` | Respuesta de Mapi dentro de ventana 24 h (texto libre) | El caso principal. Hoy los desconocidos reciben silencio salvo `PLATFORM_WA_RESPUESTA_COMERCIAL=true` (1 respuesta/30 días); de desconocidos **no se guarda el texto** (D12 del canal). Para atribuir la promo hay que decidir si se guarda un metadato mínimo (ver §7). |
| B. Escuelas actuales (admins/owners con opt-in al canal) | `platform_wa_suscripciones` (activas) | Plantilla; el opt-in actual es solo para **avisos operativos**, no marketing | NO sirve de consentimiento de marketing. Para ellas, mejor correo o aviso in-app. |
| C. Prospectos de lista (escuelas que no han escrito) | No hay lista de prospectos en el repo | Plantilla MARKETING solo con opt-in de marketing | Sin base consentida no se envía (§3.2). |
| D. Registrados en la app sin actividad | `schools`/`profiles` (sin consentimiento WA) | Correo / in-app | Fuera de WhatsApp salvo consentimiento. |

## 3. Canal

### 3.1 Dos caminos, no mezclarlos
1. **Respuesta de Mapi (ventana 24 h).** Si el lead escribió en las últimas 24 h, sale texto libre y botones (cta_url, quick replies). No es mensaje de marketing iniciado por nosotros y no consume plantilla. Es el camino de bajo riesgo: **empezar por acá**.
2. **Plantilla MARKETING de Meta.** Para escribirle a quien no escribió en 24 h. Requiere **opt-in explícito de marketing** (`whatsapp-optin-y-rastreo-de-plantillas.md`), plantilla aprobada por Meta (suele tardar de minutos a 24 h) y cuenta **por mensaje entregado** (Meta cobra por mensaje desde 1-oct-2026; la tarifa de marketing en Colombia es mayor que utility, ≈ US$0,0008 la utility según D8 del canal; **la tarifa de marketing se verifica en el panel de Meta antes de aprobar el presupuesto**, no está en el repo).

### 3.2 Consentimiento (Ley 1581 de 2012 y política de Meta)
- Marketing por WhatsApp exige autorización previa, expresa e informada del titular, con constancia (quién, cuándo, de dónde, con qué texto). El opt-in de avisos de dueñas (D4 del canal) **no cubre** promociones.
- Todo mensaje de marketing lleva forma de baja («responde BAJA»). Ya existen comandos DESACTIVAR/PAUSAR/STOP/BAJA en el canal.
- Horario: 8:00–20:00 hora Colombia (sentido común y alineado con lo que ya se hace en campañas de escuela).
- No se sube a Meta/Ads una lista de teléfonos sin consentimiento.

### 3.3 Cupo de Meta
El canal comercial no tiene estado de cupo documentado. Monster (otro WABA) está en `TIER_250` con negocio **no verificado** (`whatsapp-plan-v2-anuncios-campanas-formularios.md`). **Verificar el tier y la verificación de negocio del WABA de SportMaps** antes de planear volumen; con `TIER_250` se pueden iniciar conversaciones con 250 destinatarios únicos cada 24 h. La verificación de negocio sube el límite; no se resuelve en una semana de forma segura.

## 4. Mecánica de la promo

Todo `POR CONFIRMAR` hasta responder §1.

- **Oferta (dicha por el usuario el 11-18):** noviembre y diciembre gratis, **con la migración de datos incluida y todas las funciones**. Ya está en `CONFIG_COMERCIAL.promo` del servicio de leads (vigente hasta el 31-dic-2026, inferido). **Tope (Q5, dicho el 11-19): hasta 20 cupos.** Lo demás (plan, cobro desde enero, tarjeta) sigue por confirmar y Mapi NO lo dice.
- **Plan incluido:** `POR CONFIRMAR` (Q2/Q7).
- **Activación:** registrarse en `POR CONFIRMAR (URL de la app; confirmar que sea PRODUCCIÓN, no staging — hubo un incidente de «Empieza gratis» apuntando a staging, memoria landing-prod-points-to-stg)`.
- **Vigencia:** del `POR CONFIRMAR` al `POR CONFIRMAR`.
- **Desde enero:** `POR CONFIRMAR` (Q4). Texto base: «Desde el 1 de enero tu plan sigue en $X al mes; te avisamos antes y cancelas cuando quieras». Solo si es cierto.
- **Tope:** `POR CONFIRMAR` (Q5).
- **Tarjeta:** `POR CONFIRMAR` (Q6).

**Reglas duras (mismas del bot de ventas):**
1. Mapi **nunca** dice precio, plan, vigencia ni condición que no salga del dato fijo `promo` (§6) o de `saas-plans`. El modelo redacta tono, no cifras.
2. Si `promo.activa=false` o `ahora` fuera de `[vigente_desde, vigente_hasta]`, Mapi **no menciona la promo** (responde con precios normales).
3. No prometer en la promo lo que el censo marca como no afirmable: app nativa publicada (están en pruebas), dominio propio en todos los planes, pizarra 3D, auto-aprobación de comprobantes (la IA deja listo para aprobar), clientes fuera de Colombia. «WhatsApp IA gratis» se puede decir con su matiz: se paga a Meta solo si se excede.
4. No nombrar escuelas clientes en la promo sin autorización (solo los 6 publicados en /clubes).
5. Tuteo siempre (Colombia). Sin «che»/«vos».

## 5. Métricas y atribución

Base: `whatsapp-anuncios-atribucion.md`. El webhook ya guarda el mensaje completo con `referral` (`source_id`, `source_type`, `headline`, `ctwa_clid`) en el canal de escuela; **para el canal de plataforma hay que verificar que se guarde igual** (los desconocidos no guardan texto, pero el `payload.referral` sí debería guardarse como metadato; confirmarlo antes de gastar en anuncios).

Embudo por conversación de anuncio: conversación → recibió la promo → pidió registro / abrió el enlace → creó cuenta → cargó primer atleta → (enero) pasó a pago.
- Anuncio: `source_id` y `ctwa_clid` (para reportar conversiones a Meta si se decide, `ads_read` requiere revisión de Meta).
- Plantillas: entregado / leído / botón tocado (`whatsapp-optin-y-rastreo-de-plantillas.md`), bajas y reportes de spam; **si la calidad baja, Meta baja el cupo**.
- Costo por escuela activada = gasto del anuncio + mensajes de plantilla / escuelas activadas.
- Éxito/fracaso: umbrales `POR CONFIRMAR`.

## 6. Configuración `promo` (dato fijo; la lee el servicio de leads de Mapi)

Un solo objeto, **apagado**. No va en el modelo ni en el prompt libre; va en código/tabla de config y el modelo solo recibe `texto_corto` y `condiciones` ya validados.

```ts
export const promo = {
  activa: false,                       // se prende solo tras aprobar Q1–Q11
  nombre: 'POR CONFIRMAR',             // p. ej. 'Black Friday SportMaps 2026'
  texto_corto: 'POR CONFIRMAR',        // una línea que Mapi puede citar tal cual
  vigente_desde: 'POR CONFIRMAR',      // ISO con zona, p. ej. '2026-11-27T00:00:00-05:00'
  vigente_hasta: 'POR CONFIRMAR',      // ISO con zona
  condiciones: [
    'POR CONFIRMAR: a quién aplica',
    'POR CONFIRMAR: qué plan incluye y qué cubre «gratis»',
    'POR CONFIRMAR: vigencia y fecha límite de activación',
    'POR CONFIRMAR: qué pasa desde enero (cobro, aviso previo, precio)',
    'POR CONFIRMAR: tope de escuelas',
    'POR CONFIRMAR: si pide tarjeta',
  ],
} as const;
```
Contrato sugerido para el otro agente: si `activa !== true` o la fecha actual no cae en el rango **o algún valor sigue en «POR CONFIRMAR»**, devolver `null` y no mencionar la promo.

## 7. Textos listos para aprobar

Variables entre llaves dobles `{{n}}` solo en plantillas Meta; en Mapi se llenan con el dato fijo. `[X]` = `POR CONFIRMAR`.

### 7.a Respuesta de Mapi a un lead que pregunta por precios (con promo)
> ¡Hola{nombre}! 👋 Soy Mapi, la asistente de SportMaps. Te cuento los planes para escuelas: Free Start $0 (hasta 20 alumnos), Start $69.000/mes, Pro $159.000/mes y Elite $349.000/mes (pagando anual salen más baratos). 
>
> 🎁 *Esta semana tenemos [texto_corto de la promo]*. Aplica [a quién, Q1] y va hasta el [vigente_hasta]. Desde enero [qué pasa, Q4].
>
> ¿Cuántos deportistas tiene tu escuela? Con eso te digo cuál plan te conviene y te paso el enlace para empezar.
> [Botón: Empezar ahora] [Botón: Hablar con una persona]

(Si la promo no está vigente: se omite el párrafo del regalo.) Precios tomados de la landing v3.0; **verificar contra la landing antes de salir**.

### 7.b Plantillas de marketing (categoría MARKETING, idioma `es_CO` o `es`)
Meta exige ejemplos para cada variable. Nombres en minúscula, snake_case.

**`sm_bf_oferta_escuelas`**
- Cuerpo: `Hola {{1}} 👋 Soy Mapi, de SportMaps. Por Black Friday, {{2}}. Vale hasta el {{3}}. Con SportMaps cobras, controlas la asistencia y ordenas los pagos de tu escuela por WhatsApp. ¿Quieres que te cuente cómo empezar?`
- Ejemplos: {{1}} = `Carlos`, {{2}} = `[texto_corto de la promo]`, {{3}} = `[fecha]`
- Botones respuesta rápida: `Quiero empezar` · `Ver planes` · `No me interesa`
- Pie: `Responde BAJA para no recibir más mensajes.`

**`sm_bf_ultimos_dias`**
- Cuerpo: `Hola {{1}}, te queda poco para aprovechar la promo de SportMaps: {{2}}. Termina el {{3}}. Si tienes dudas de cómo funciona o cuánto cuesta desde enero, te las resuelvo por aquí.`
- Ejemplos: {{1}} = `Carlos`, {{2}} = `[texto_corto]`, {{3}} = `[fecha]`
- Botones: botón URL `Activar mi escuela` → `[URL de registro]/{{1}}` (URL dinámica, ejemplo `?utm=bf`) · respuesta rápida `Hablar con una persona`
- Pie: `Responde BAJA para no recibir más mensajes.`

Cumplen: sin lenguaje engañoso, sin MAYÚSCULAS corridas, sin promesas no verificables, con baja. Registro: **no se hace** hasta aprobar; cuando se apruebe, con `bff/scripts/wa-registrar-plantilla.ts` (solo lectura revisada acá) o desde el panel de Meta.

### 7.c Anuncio click-to-WhatsApp
- Titular (≤ 40): `Tu escuela, ordenada desde hoy`
- Texto principal: `Black Friday en SportMaps: [texto_corto]. Cobros, asistencia y comprobantes de tu escuela en un solo lugar, con Mapi respondiendo a las familias por WhatsApp. [Condición clave, ej. vigencia].`
- Botón: `Enviar mensaje` (WhatsApp)
- Mensaje de bienvenida precargado: `Hola, quiero la promo de Black Friday de SportMaps`
- Texto de la conversación inicial (Mapi): ver 7.a. Imagen: Mapi (lémur con gafas, `public/mapi/` de la landing). No usar logos de clientes sin autorización.
- Ojo: si el texto precargado cambia, Mapi lo reconoce para atribuir; mantenerlo idéntico en todos los anuncios o mapear por `source_id`.

### 7.d Seguimiento (solo dentro de ventana 24 h o con plantilla de 7.b)
**Día 3** (si no activó): 
> Hola{nombre}, soy Mapi 👋 ¿Pudiste ver la promo de SportMaps? Si me cuentas cuántos deportistas tiene tu escuela, te digo el plan exacto y cómo cargarlos rápido. Si prefieres que te llame una persona del equipo, dime y te escriben.

**Día 7** (último):
> Hola{nombre}, la promo de SportMaps termina el [fecha]. No quiero llenarte de mensajes: ¿te ayudo a activar tu escuela hoy o lo dejamos aquí? Puedes responder *BAJA* y no te escribo más.

Regla: máximo 2 seguimientos, solo a quien no dijo «no»; quien responda «BAJA/no» se marca y no recibe más. Un mensaje iniciado por nosotros por persona al día.

### 7.e Objeciones comunes
| Objeción | Respuesta (sin prometer lo no confirmado) |
|---|---|
| «¿Es gratis de verdad? ¿Cuál es el truco?» | «Sí: [qué cubre, Q2] hasta el [fecha]. Desde enero [qué pasa, Q4]; te avisamos antes y no se cobra nada sin que lo sepas.» |
| «¿Me piden tarjeta?» | `[Respuesta según Q6]` |
| «Mi escuela es pequeña» | «Free Start es gratis para siempre hasta 20 alumnos y ya incluye WhatsApp IA (solo se paga a Meta si te pasas del uso incluido).» |
| «Ya uso Excel/otra plataforma» | «Mapi lee los comprobantes y te deja los pagos listos para aprobar; puedes empezar con un grupo y migrar poco a poco.» (No afirmar «aprobación automática».) |
| «¿Y mis datos?» | «La escuela es dueña de sus datos. Ver la política de privacidad: [enlace].» |
| «¿Hay app en la tienda?» | «La app de iOS y Android está en pruebas; hoy funciona desde el navegador y como app instalable (PWA).» |
| «Déjame pensarlo» | «Claro. La promo va hasta el [fecha]; si quieres te escribo un día antes.» (solo si acepta) |
| «¿Quién más lo usa?» | Solo los 6 de /clubes publicados (Dynasty, Monster's, Besser, Carmel, GYM RM, Dreamers) y solo si ese listado sigue vigente. |
| «Quiero hablar con una persona» | Escalar al equipo (la QA/ventas atiende desde la app de WhatsApp Business por Coexistence). |

## 8. Infraestructura existente: qué se reutiliza y qué falta (lectura de código)

**Hoy las campañas masivas son por escuela, no por plataforma.**
- `bff/src/services/whatsapp-campanas.service.ts`, `whatsapp-campanas.routes.ts`, `whatsapp-audiencias.service.ts`, `whatsapp-campanas-cupo.ts`, `whatsapp-campanas-freno.ts`, `whatsapp-campana-reporte.service.ts`, `whatsapp-campana-respuesta.service.ts`, `whatsapp-plantillas.service.ts`. Scripts: `wa-campana.ts` (estado/crear/simular/aprobar/pausar/reanudar), `wa-audiencia.ts` (clasifica los chats de la escuela), `wa-registrar-plantilla.ts`, `wa-estado-plantillas.ts`, `wa-seguimiento.ts`, `wa-responder-prospectos.ts`.
- Todo cuelga de `school_whatsapp_integrations` (`campanas.integration_id` y `school_id` NOT NULL) y de `whatsapp_campanas_ajustes` por escuela (habilitadas, base de consentimiento, tope diario, lote piloto, pausa).
- El **canal de plataforma** (`platform_wa_canal`, `platform_wa_*`, `plataforma-wa*.service.ts`, `wa-plataforma.ts`) es una tabla aparte (D1) y **no está conectado** a las campañas.

**Se reutiliza (como lógica o patrón):**
- Plantillas: registro, sincronización de estado, validación (`validarPlantillaDeCampana`), variables (`variablesDeCampana`, `primerNombre`), botones rápidos y payload (`payloadDeBoton`).
- Cupo por tick/tier (`cupoDelTick`, `whatsapp-campanas-cupo.ts`), freno por calidad (`whatsapp-campanas-freno.ts`), reintentos, lease y piloto.
- Reporte, atribución y la «respuesta Sí» con botones (`whatsapp-campana-respuesta.service.ts`).
- Clasificador de intención del bot (clase de prueba, precio, clínica) como ejemplo para detectar interés en la promo.

**Falta para una campaña a nivel plataforma:**
1. Una audiencia a nivel plataforma con **base de consentimiento de marketing** (no existe lista de prospectos ni tabla de opt-in de marketing para el canal comercial).
2. Un `integration`/`school` para el envío: las funciones de campaña asumen `school_id`; habría que parametrizar para usar `platform_wa_canal` o crear una «campaña de plataforma» aparte (migración nueva, requiere aprobación; `CLAUDE.md` pide plan antes de migrar).
3. Plantillas registradas en el WABA de SportMaps (no hay ninguna `sm_bf_*`).
4. Estado de cupo/verificación del WABA de SportMaps (no documentado).
5. Atribución de leads del número comercial: hoy desconocidos = silencio y sin texto guardado (D12); falta `referral` por anuncio para la plataforma.
6. Principio vigente (2026-11-15): «SportMaps no envía campañas por una escuela». Una campaña **de** SportMaps a escuelas es otro caso y no lo contradice, pero hay que decirlo explícito en la aprobación.
7. El servicio `bff/src/services/plataforma-wa-leads.service.ts` **aún no existe** en el árbol (otro agente); el objeto `promo` de §6 es el contrato.

**Recomendación:** lanzar solo con el camino 1 (respuesta de Mapi + anuncios click-to-WhatsApp) para el 27-nov; dejar la plantilla masiva (camino 2) como fase siguiente hasta tener consentimiento y cupo verificados.

## 9. Riesgos
- Prometer una condición no confirmada (mitigación: dato fijo `promo` + «POR CONFIRMAR» bloquea).
- «Gratis» que luego cobra en enero sin aviso (mitigación: Q4 explícita en todo texto).
- Marketing sin consentimiento: sanción SIC (Ley 1581) y baja de calidad en Meta.
- Spam/ráfagas: calidad baja → Meta reduce cupo o bloquea el número comercial, que **es el que atiende ventas** y avisos de dueñas.
- Aviso de «gratis» pisando a escuelas que ya pagan (Q1).
- Landing apuntando a staging (precedente real).
- Mapi respondiendo un precio viejo: usar la landing v3.0 como fuente y verificar antes.
- Costo por mensaje (marketing) desde 1-oct-2026: presupuestar con la tarifa real del panel.

## 10. Cronograma (hoy 2026-11-18)
| Fecha | Hito |
|---|---|
| 11-18 → 11-19 | Responder §1; aprobar textos; decidir si se usa solo camino 1 |
| 11-19 | Llenar `promo` (aún `activa:false`); verificar landing, precios y URL de registro (producción) |
| 11-20 | Verificar tier/verificación del WABA comercial; guardar `referral` en el canal de plataforma |
| 11-20 → 11-23 | (si se aprueba camino 2) registrar `sm_bf_*` en Meta; espera de aprobación |
| 11-24 | Prueba en modo pruebas (`/como prospecto`) con `promo` simulada; anuncio en revisión de Meta |
| 11-25 | Anuncio activo (preventa); QA de textos |
| 11-27 | **Black Friday**: `promo.activa=true`, 08:00 |
| 11-30 | Seguimiento día 3 |
| 12-04 | Seguimiento día 7; corte de métricas |
| `POR CONFIRMAR` | Cierre de la promo y comunicación del cobro de enero |

## 11. Qué NO se hizo
No se registraron plantillas, no se enviaron mensajes, no se editó bff/frontend, no hay migraciones, no hay commits.
