# Tarea: SportMaps en inglés y portugués (Brasil)

**Estado:** TAREA ARMADA, sin código. Es un refactor transversal, no una feature: no se hace de corrido ni en una sola sesión.
**Decisión previa:** Brayan lo dejó «para después» el 2026-09-12; el 2026-11-13 pidió armar la tarea.
**Por qué:** portugués apunta a Brasil (mercado real). Y el español único ya cuesta fuera de Colombia: el revisor del App Review de Meta no lo lee.
**Fecha:** 2026-11-13

## 1. Punto de partida (medido el 2026-11-13)

| Qué | Cantidad |
|---|---|
| Páginas del frontend | 153 + 108 en subcarpetas |
| Componentes | 608 |
| `toast` con título escrito directo | 986 |
| Usos de `'es-CO'` / `toLocale*` / `Intl.*` fijos | 399 / 469 |
| Dinero fijado a pesos colombianos (`currency: 'COP'`) | 67 |
| Plantillas de WhatsApp (cada una con su `language`) | 28 |
| Archivos del BFF que arman correos con marca | 7 |
| Artículos del Centro de Ayuda / Sportbot | 50 |
| Capa de traducción | **ninguna** (sin `i18next` ni archivos de idioma) |
| Idioma de la página | `<html lang="es">` fijo |

Verificado en `types.ts`: **no existe** una preferencia de idioma por persona ni por escuela. `locale` es de `user_devices` (el idioma del dispositivo, para notificaciones push) y `default_locale` es de `whatsapp_settings` (el idioma de WhatsApp de la escuela). Hay que crear la preferencia.

## 2. Qué NO es solo «traducir pantallas»

1. **Estados y rótulos que vienen de la base** (`overdue`, `absent`, `partial`…). Ya hay dos funciones únicas en español: `etiquetaEstadoPago` y `etiquetaAsistencia` (`estadoCuentaModel.ts`). Son el modelo a seguir: **toda etiqueta de un estado sale de una función, nunca del valor crudo**. Cada función ganaría un parámetro de idioma.
2. **Fechas, números y dinero.** Hoy `es-CO` y `COP` están fijos en cientos de sitios. En Brasil: `pt-BR`, reales (BRL), y el separador de miles cambia. Una escuela decide su moneda; el idioma de la persona no cambia la moneda de un cobro.
3. **Fuera de la interfaz**, y todo está en español:
   - Correos del BFF (`buildBrandedEmail`: estado de cuenta, cobros, recordatorios).
   - Plantillas de WhatsApp registradas en Meta: **una plantilla por idioma, y cada una la aprueba Meta** (días). Es lo que más tarda.
   - Prompts del bot y de Mapi.
   - Textos generados en documentos: el estado de cuenta imprimible (`statementPrint*.ts`) y los PDF.
   - Centro de Ayuda (50 artículos) y manuales.
4. **Vocabulario único.** Hoy conviven «Presente / Ausente / Tardanza / Justificada» (asistencia del hijo) y «Asistió / Faltó / Llegó tarde / Excusada» (estado de cuenta). Antes de traducir hay que **elegir una sola palabra por cosa** (ver la página «Una palabra por cosa» del rediseño V2) o se traducirá la inconsistencia tres veces.
5. **Legal.** Política de privacidad, términos, y la Ley 2300 (horario de cobranza) son de Colombia: Brasil tiene su propia normativa (LGPD, horario de cobranza propio). Esto NO se resuelve traduciendo.
6. **Pagos y facturación.** Wompi, Bre-B, PSE y la facturación electrónica DIAN (Factus) son colombianos. Brasil necesita otra pasarela y otro facturador. **Fuera del alcance de esta tarea**: traducir la app no la hace vendible en Brasil.

## 3. Decisiones que hay que tomar antes de escribir código

| # | Decisión | Propuesta |
|---|---|---|
| D1 | Librería | `react-i18next` + `i18next` (la más usada, con carga por idioma y plurales). Alternativa: Lingui. Se decide con una prueba de 1 día sobre el estado de cuenta. |
| D2 | Idioma fuente | **Español (Colombia)**: es el que está escrito y el que Brayan revisa. Las claves en español legible o en inglés técnico (`estadoCuenta.titulo`), no el texto como clave. |
| D3 | Dónde se guarda el idioma | Columna nueva por persona (`profiles.preferred_language`, `text + CHECK` en `es`/`en`/`pt`), con respaldo en el idioma del navegador y luego uno por escuela. Requiere migración (plan aprobado antes de escribirla). `user_devices.locale` y `whatsapp_settings.default_locale` se quedan para push y WhatsApp. |
| D4 | Quién traduce | Primera pasada con IA, **revisada por una persona nativa** (portugués de Brasil, no de Portugal). El español colombiano de producto («tú», sin «vos») se mantiene. |
| D5 | Mercado primero | Inglés: App Review de Meta y demos. Portugués: Brasil. Se propone **inglés primero** (más barato y desbloquea Meta), portugués después. |
| D6 | Dinero | El idioma NO cambia la moneda. Cada escuela tiene su moneda; el formato de número sigue al idioma. |
| D7 | Qué se traduce primero | Lo que ve la familia (estado de cuenta, pagos, inicio) antes que lo que ve la escuela. |

## 4. Plan por fases

**Fase 0 — Cimientos (1 semana)**
- Decidir D1 a D7. Elegir el vocabulario único (punto 4 de la sección 2).
- Instalar la librería, el cambio de idioma y la lectura del idioma de la persona.
- Un solo módulo de formato: `formatoFecha`, `formatoNumero`, `formatoDinero`, que lean el idioma y la moneda. Reemplazar los 399 `es-CO` y los 67 `COP` fijos por ese módulo, **sin cambiar ningún texto todavía**.
- Funciones de etiquetas (`etiquetaEstadoPago`, `etiquetaAsistencia`, estados de invitaciones, referidos, torneos, instalaciones) como único punto de verdad.
- Regla del repositorio: un lint o una prueba que **falla si aparece un texto de interfaz escrito directo** en un archivo ya migrado.

**Fase 1 — Piloto: estado de cuenta y pagos de la familia**
- Es lo más reciente, ya está bien aislado y tiene pruebas. Sirve para probar el método y medir el esfuerzo real por pantalla.
- Incluye el correo del estado de cuenta y la página pública `/e/:token`.

**Fase 2 — Pantallas de la familia y del deportista** (inicio, hijos, calendario, pagos, notificaciones, perfil).

**Fase 3 — Pantallas de la escuela** (por módulos: deportistas, pagos, equipos, asistencia, reportes, configuración).

**Fase 4 — Fuera de la interfaz**
- Plantillas de WhatsApp en inglés y portugués → enviarlas a aprobación de Meta **desde la fase 1**, porque tardan.
- Correos del BFF, prompts del bot, Centro de Ayuda, manuales.

**Fase 5 — Control de calidad por idioma** (ver sección 5).

## 5. Cómo se prueba

- **Cobertura de claves:** una prueba que compare los archivos de idioma y falla si a un idioma le falta una clave que el español sí tiene, o si sobra una.
- **Sin texto directo:** el lint de la fase 0 en cada archivo migrado.
- **Pseudo-idioma:** un idioma falso («[!! Ésta es la clave !!]») para ver en pantalla qué quedó sin traducir y qué se desborda por texto más largo.
- **Plurales y variables:** pruebas de «1 cobro / 2 cobros», «1 día / 3 días», y de frases con nombre, fecha y monto.
- **Capturas por idioma** de las pantallas clave (estado de cuenta, pagos, inicio) para revisar a ojo el largo del texto, sobre todo en el celular.
- **Revisión humana** del portugués por una persona nativa antes de publicar.
- **Fechas y dinero:** casos de borde (31 de diciembre, cambio de año, miles y decimales) en `es-CO`, `en-US` y `pt-BR`.

## 6. Riesgos

- **Es muy grande y toca todo.** Hecho de un golpe rompe pantallas y es imposible de revisar. Por eso se hace por fases y por módulo, con la prueba de «sin texto directo».
- **Textos largos** (el portugués suele ser ~20 % más largo que el español) desbordan botones y tablas. Se ven con el pseudo-idioma y capturas.
- **Dos fuentes de verdad.** Si se traduce un componente y otro que lo reutiliza no, la app queda mezclada. Orden: primero los componentes compartidos.
- **Plantillas de Meta:** sin aprobación no hay mensajes en ese idioma. Se pide pronto.
- **Costo de mantener:** cada texto nuevo pasa a necesitar tres versiones. Hay que decidir quién las pide y quién las revisa.
- **Brasil no se resuelve con idioma** (pagos, impuestos, legal): ver puntos 5 y 6 de la sección 2.

## 7. Entregables y criterio de «terminado» por fase

Cada fase se cierra con: pruebas pasando, la cobertura de claves en verde, capturas de las pantallas del módulo en cada idioma revisadas, y la lista de lo que queda pendiente. No se publica un idioma «a medias» a una escuela sin avisarle qué partes aún están en español.

## 8. Primer paso concreto (para arrancar)

1. Brayan decide D1, D5 y el vocabulario único.
2. Una sesión hace la fase 0 en una rama, sin cambiar textos.
3. Se traduce el estado de cuenta (fase 1) a inglés, se revisa en pantalla y se mide cuánto costó. Con ese dato se estima el resto.
