# Formularios dentro de WhatsApp (WhatsApp Flows) para todos los bots

Estado: **plan para aprobar (2026-11-04)**. Referencia que trajo el usuario: el bot de Pagui (botón «LEER y
ACEPTAR» → pantallas con barra de avance: «Cómo funciona», casilla «Sí, acepto» con enlace a la política de
datos, «Datos personales» con campos, lista de documento, fecha con calendario, «Sí, autorizo», rangos de
ingreso, código de tienda → «Response sent» → el bot sigue en el chat). Eso es **WhatsApp Flows**: formularios
nativos de Meta que se abren dentro del chat. Complementa (no reemplaza) el plan de anuncios
(`whatsapp-anuncios-atribucion.md`).

## 1. Qué ganamos

- **Menos pasos** (principio del usuario): el embudo de hoy son ~8 mensajes (sede + 5 preguntas + horario +
  consentimiento); en un formulario son 2–3 pantallas, con los datos validados (fecha con calendario, listas
  cerradas, sin «¡Mucho gusto, Cuanto!»).
- **Consentimiento explícito y guardado** (Ley 1581 / habeas data y opt-in de marketing): una casilla «Acepto
  la política de tratamiento de datos» (obligatoria) y otra «Quiero recibir novedades del club» (opcional) con
  enlace a la política unificada. **Resuelve el bloqueo de campañas** (Monster tiene 0 opt-ins): desde el
  formulario, cada interesado queda con su consentimiento registrado.
- **Medición por pantalla** en el embudo de anuncios: cuántos abrieron el formulario, en qué pantalla se fueron.

## 2. Los formularios

| # | Formulario | Para | Pantallas | Al terminar |
|---|---|---|---|---|
| F1 | **Clase de prueba** | Interesados (todas las escuelas con embudo) | 1) Qué es la clase de prueba + valor + casillas de datos y novedades · 2) Deportista: nombre, fecha (calendario), sexo, posición (lista), trayectoria · 3) Sede y horario: los cupos reales del grupo que le corresponde | Separa el cupo, registra lead + consentimiento, manda los datos de pago y deja el motivo esperado |
| F2 | **Inscripción a un servicio** (clínica, vacacional, torneo) | Interesados y familias | 1) Ficha del servicio (fechas, precio de hoy, qué incluye) + consentimiento · 2) Deportista, talla de camiseta (clínica), semanas (vacacional), afiliado o no · 3) Resumen con el valor y el abono | Lead/inscripción, motivo esperado con el monto, datos de pago |
| F3 | **Matrícula** (después de la clase de prueba) | Familias que pasan la prueba | Acudiente, deportista, documento, EPS, autorizaciones (fotos, salidas), grupo que asignó la escuela | Entra a la bandeja de matrículas V2 para que la escuela cree al deportista con un clic. Cierra el hueco «quiero matricularla» |
| F4 | **Comprobante con motivo** | Familias | Deportista, motivo (lista del catálogo), monto, foto o PDF del comprobante | La cola de comprobantes con el motivo ya elegido |
| F5 | **Datos y consentimiento de familias del club** | Familias (Dynasty, Monster…) | Confirmar datos del acudiente + casillas | Ficha actualizada + opt-in |
| F6 | **Encuestas** (post-entreno, PQRS, satisfacción) | Familias / deportistas | 1 pantalla | Lo que hoy pide el bot por mensajes |

Prioridad propuesta: **F2 (clínica, ya tiene anuncios corriendo) → F1 → F3 → F4**; F5–F6 después.

## 3. Cómo se construye

- **Definición en el repo**: `bff/whatsapp-flows/<nombre>.json` (Flow JSON de Meta), versionado como las
  plantillas. Textos por escuela (nombre, política, servicio) entran como datos, no como un formulario por
  escuela.
- **Registro por escuela**: Meta guarda cada Flow DENTRO de la cuenta de WhatsApp (WABA) de la escuela, como
  las plantillas. Script `wa-registrar-flow` (crear, subir JSON, publicar) y copia entre WABAs (como
  `wa-copiar-plantillas`). Tabla `whatsapp_flows` (school/integration, nombre, flow_id de Meta, versión,
  estado).
- **Dos tipos**:
  - *Estáticos* (F2 sin cupos, F5, F6): todo el formulario viaja en el JSON; al terminar llega por el webhook
    (`interactive.nfm_reply.response_json`). Sin servidor intermedio: **se puede empezar ya**.
  - *Dinámicos* (F1 horarios reales, F2 precio del día, F3 grupo asignado): Meta llama a un **endpoint
    nuestro** en cada pantalla. Requiere llave RSA por número (se sube la pública a Meta), cifrado
    AES-GCM de cada petición, responder en < 10 s y el chequeo de salud de Meta. Endpoint nuevo en el BFF
    `POST /api/v1/webhooks/whatsapp/flows`.
- **Envío**: dentro de la ventana de 24 h, mensaje interactivo tipo `flow` (botón «Reservar mi cupo»);
  fuera de la ventana, **plantilla con botón de Flow** (p. ej. la campaña de la clínica abre directo el
  formulario de inscripción).
- **Respuesta**: el webhook reconoce `nfm_reply` y lo enruta por el `flow_token` (lleva conversación, escuela y
  paso; firmado para que no se pueda falsificar) al mismo motor que hoy (lead, cupo, motivo esperado, buzón).
- **Respaldo**: si el teléfono no soporta Flows (o la persona lo cierra), sigue el chat por pasos de hoy. El
  bot nunca se queda esperando un formulario.
- **Consentimiento**: tabla/registro de consentimientos (texto y versión de la política aceptada, fecha,
  canal = formulario) que alimenta `whatsapp_optins` para las campañas.
- **Batería**: `qa:embudo` gana un bloque `flows` (respuestas `nfm_reply` simuladas: completo, incompleto,
  token inválido, sin cupo al confirmar).

## 4. Requisitos de Meta a verificar antes de construir

- Disponibilidad de Flows para números en **coexistencia** (Monster) y si algún tipo exige **verificación del
  negocio** (Monster hoy: no verificado; conviene verificarlo igual para subir el límite de 250).
- Límites de la versión de Flow JSON vigente (componentes: casilla de aceptación con enlace, calendario,
  listas, selector de fotos/documentos) y su revisión/publicación.
- Las plantillas con botón de Flow pasan por la misma revisión de Meta que las demás.

## 5. Fases (se suma al plan de anuncios)

1. **Fase F-a (rápida, estática)**: F2 para la clínica + consentimiento; plantilla de la clínica con botón
   «Reservar mi cupo» que abre el formulario. Registro de flows por escuela + recepción de `nfm_reply`.
2. **Fase F-b (endpoint)**: endpoint cifrado + F1 con cupos reales + F2 con precio del día.
3. **Fase F-c**: F3 matrícula y F4 comprobante. Luego F5–F6 y los mismos formularios para el canal de
   SportMaps (demo para escuelas, B10).
