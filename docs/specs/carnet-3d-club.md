# Carnet 3D por club — spec (F0)

**Estado:** aprobada (puntos 1–8 de §11, 2026-11-26) · **F1 y F5 APLICADAS** (`20261126095105`, `20261126103934`) · F2–F5 y pantalla V2 construidas el 2026-11-26 (sin desplegar) · **Fecha:** 2026-11-24 · **Autor:** Brayan Steven Lopez (con Claude)
**Fuente de verdad** de las fases F1–F5. Cada fase va con revisión antes de la siguiente; ninguna migración se escribe antes de aprobar esta spec.

---

## 1. Qué es

Un carnet digital de jugador con efecto 3D (inclinación, brillo holográfico, giro al tocarlo) y con la identidad visual del club (tres colores y escudo). Se construye **sobre el carnet que ya existe** (`athlete_id_cards`), no como una entidad nueva.

## 2. Decisiones de producto (resueltas el 2026-11-24)

| # | Tema | Decisión |
|---|---|---|
| D1 | Mapa de calor | **No se inventa.** El reverso muestra la **posición asignada en las alineaciones**, rotulada **«Zona de juego»**. Estadísticas del partido en vivo solo si existen; si no, reverso genérico (D2). |
| D2 | Multideporte | Por fases. En F4: **fútbol** + **reverso genérico** (asistencia y evaluaciones) que sirve para cualquier deporte. Voleibol, gimnasia y MMA, en una fase posterior. El componente queda con un **registro por deporte** para agregar deportes sin reescribirlo. |
| D3 | Plan | **Cambiado el 2026-11-26:** el carnet 3D **y** los **colores y el escudo del club** son **gratis para todas las escuelas** (migración `20261126154553`: `update_school_branding` ya no exige `school_has_branding_feature`). **Marca propia** queda para la app con la marca de la escuela (`school_shows_own_brand`) y apagar el «Powered by» (whitelabel). |
| D4 | Código | **`SM-AAAA-NNNNN`** (5 dígitos). Va **impreso** en el carnet; el **QR sigue apuntando al token secreto** (`qr_token`). |
| D5 | Escudo SVG | Se **convierte a PNG en el BFF** al subirlo (el SVG nunca se sirve tal cual). |
| D6 | Archivo del escudo | Límite **2 MB** (el actual). La conversión a **WebP debe conservar la transparencia** (prueba automática). |
| D7 | Habilitación (F5) | Semáforo consultado **en vivo** al escanear; **nunca** se muestra en el carnet ni en sus exportaciones. Criterios configurables por club. |
| D8 | Datos del deportista (EPS, RH, contacto de emergencia, documento, talla…) | **Los configura cada escuela.** Se reutilizan los «Campos visibles» que ya tiene la plantilla de carnet (`show_fields`); no se crea otra configuración. Ver §4.1. |

## 3. Lo que ya existe y se reutiliza

| Pieza | Dónde | Uso en este proyecto |
|---|---|---|
| Club | `schools` (`name`, `logo_url`, `branding_settings.primary_color/secondary_color`) | El **escudo es `logo_url`**; se agrega `accent_color` a `branding_settings`. Sin tabla nueva. |
| Edición de marca | `BrandingSettingsForm.tsx` + RPC `update_school_branding` (gate `school_has_branding_feature`) | Se amplía con acento, escudo y vista previa del carnet 3D (F2). |
| Jugador | `children` (menor), `profiles` + `school_members.role='athlete'` (adulto), `unregistered_athletes` (sin cuenta) | Nombre, foto (`avatar_url` / `photo_url` del carnet), categoría (`teams`), sede (`school_branches`). |
| Carnet | `athlete_id_cards` (+ `athlete_id_card_templates`), `AthleteIdCard.tsx` | Emisión, versión, vigencia, revocado, lote, PNG/PDF por equipo, aviso a la familia. Se agrega `codigo`. |
| Verificación pública | `/c/:token` → `verify_athlete_id_card_public` (niveles `public` / `staff` / `guardian`) | Se amplía en F1 (código, identidad) y en F5 (semáforo y nuevos niveles). |
| Contraste por luminancia | `AthleteIdCard.tsx` (≈ l. 906), `tournaments/public/publicModel.ts` | Se unifica en `lib/cards/clubIdentity.ts`. |
| Movimiento reducido | Pizarra 3D (`tactical3d/*`) | Mismo criterio: sin inclinación ni animaciones fuertes. |
| Asistencia al escanear | BFF `POST /api/v1/attendance/checkin-by-card` + botón «Marcar asistencia» en `AthleteCardPublicPage` | El botón opcional de F5 ya existe: solo se ubica en la vista del personal. |
| Número y posición | Solo en alineaciones / partido en vivo (`match_lineup_players`, `match_live_events`) y en el formulario de jugador de torneos | Ver §5.2. |
| Pagos | `payments.status` (`pending`, `overdue`, `partial`…), `due_date`, mora (`mark_overdue_payments`) | Criterio «pagos al día» de F5. |
| Inscripción | `enrollments` (equipo activo), `event_registrations` (torneo/evento) | Criterio «inscripción» de F5. |

**Fuera de alcance:** los jugadores de equipos externos de torneos (tienen su propio carné con QR firmado en el módulo de torneos).

## 4. Diseño del carnet (F3)

- **Proporción ID-1** (54 × 85,6 mm, vertical), bordes redondeados. Mismo tamaño base que el carnet actual (340 × 540 px) para reusar exportación.
- **Frente:** logo de SportMaps; escudo del club arriba; escudo como **marca de agua tenue** detrás del **número de camiseta grande en contorno**; foto del jugador o **iniciales en círculo**; nombre; **posición en color de acento**; club; categoría; **código `SM-AAAA-NNNNN`**.
- **Fondo tipo uniforme:** franjas del color principal + **banda diagonal** del secundario.
- **Reverso:** «Zona de juego» (mini cancha con la posición), 4 estadísticas según posición/deporte, QR al token.
- **Efectos:** inclinación que sigue el dedo/mouse y el **giroscopio** (permiso explícito en iOS con un toque: «Activar movimiento»); **brillo holográfico** y **reflejo** que se mueven con la inclinación; **tocar gira** el carnet.
- **Contraste automático:** texto blanco o casi negro según la luminancia del color de fondo.
- **Movimiento reducido** (`prefers-reduced-motion`): sin inclinación, sin giroscopio, sin brillo animado; el giro es un fundido.
- **Rendimiento (gama media):** solo `transform` y `opacity` animados, un `requestAnimationFrame` por cuadro, sin `filter: blur` ni sombras animadas, CSS 3D (sin three.js).
- **Sin complemento de marca (D3):** diseño base SportMaps (verde/naranja, escudo por defecto con iniciales en esos colores).
- **Dónde se ve:** «Carnets» de la familia (V2), vista previa del admin (`/cards`), página de verificación (`/c/:token`).

**Escudo por defecto:** SVG generado en el cliente (determinista) con los colores del club y sus iniciales. No se guarda en Storage.

### 4.1 Datos visibles: los configura cada escuela (D8)

- **Fijos en el diseño** (los pide el carnet 3D): nombre, foto o iniciales, número, posición, club, categoría y código.
- **Configurables por escuela**, con los mismos «Campos visibles» de la plantilla de carnet (`athlete_id_card_templates.show_fields`, plantilla predeterminada de la escuela): **documento, sede, vigencia, RH, EPS, talla y contacto de emergencia**. Si la escuela no tiene plantilla, se usan los valores por defecto actuales. Se editan en **Carnets → Plantillas** (no es parte del complemento de marca: la privacidad no se cobra).
- **Dónde salen:** en el **reverso** del carnet que ve la familia y en la **verificación** para el personal y el acudiente. **Nunca** al público, aunque la escuela los encienda (regla vigente desde `20261010201231`): RH y EPS son datos de salud.
- **«Estado de cuota» sale del carnet 3D:** pasa al semáforo de habilitación (F5), que nunca se pinta en el carnet ni en las exportaciones (D7). El campo sigue sirviendo a las plantillas clásicas hasta que se decida retirarlo.
- Lo que la escuela apague no viaja en la respuesta de la RPC (no solo se oculta en pantalla).

## 5. Modelo de datos (F1)

Una sola migración. Reglas del repo: `text + CHECK`, `search_path` fijo, `GRANT EXECUTE` explícito, policies con helpers envueltos, sin `CREATE TYPE`.

### 5.1 Identidad del club
- `schools.branding_settings.accent_color` (hex `#RRGGBB`), validado en `update_school_branding` (mismo gate de plan que los otros colores).
- `schools.branding_settings.escudo_derechos = { confirmado_por, confirmado_en }`, lo escribe el BFF al subir el escudo (quién y cuándo los pone el servidor, no el cliente).

### 5.2 Número y posición
- Columnas nuevas en **`enrollments`** (es la relación jugador ↔ equipo): `jersey_number smallint CHECK (0–999)`, `position text` (texto libre corto, CHECK de largo). Las edita el personal en la ficha / el equipo.
- **Respaldo de lectura:** si la inscripción no los tiene, se toman de la última alineación del jugador (`match_lineup_players`). *Nombres exactos de columnas a confirmar contra la base en F1.*

### 5.3 Código del carnet
- `athlete_id_cards.codigo text UNIQUE` con formato `^SM-\d{4}-\d{5}$`.
- Consecutivo **global por año** en `athlete_card_code_counters(year PK, last_seq)`, mutado solo con `SELECT … FOR UPDATE` dentro de un trigger `BEFORE INSERT` (patrón de `certificate_folio_counters`).
- **Cada emisión (versión) lleva su código**; el de una versión revocada sigue resolviendo como «no válido».
- **Backfill** de los 515 carnets existentes por `created_at`.
- **Búsqueda por código** (alguien lo digita): responde solo válido/no válido + primer nombre e iniciales + club. El nombre completo solo por el QR (token). Mismo criterio que las constancias (2026-11-24).

### 5.4 Reverso (lectura)
- RPC `card_back_data(p_qr_token uuid)` → `{ deporte, zona_de_juego, estadisticas[4], origen }` solo para personal del club, acudiente y el propio deportista adulto (nunca `anon`).

## 6. Pantalla de identidad del club (F2)

Ampliación de `BrandingSettingsForm.tsx` (solo administradores del club: owner, admin, school_admin):
- Selectores de **principal, secundario y acento**; botón **Restablecer** (vuelve al diseño base de SportMaps).
- **Escudo:** PNG, WebP o SVG; **≤ 2 MB**; **≥ 512 px** en el lado menor; aviso si no tiene transparencia. Antes de subir, casilla obligatoria **«Confirmo que el club tiene derecho a usar este escudo»**.
- Ruta BFF `POST /api/v1/branding/escudo`: valida por **firma de bytes** (no por extensión), rasteriza el **SVG → PNG** con `sharp`, normaliza a **WebP con alfa**, sube a `school-assets/logos/<school_id>/` y registra `escudo_derechos`.
- **Aviso de contraste:** si el acento contra el principal da < 3:1 (WCAG para texto grande), mensaje claro y sugerencia.
- **Vista previa en vivo** del carnet 3D de ejemplo mientras edita.
- **Sin complemento (D3):** puede probar colores y escudo en la vista previa (sin guardar) y ve el llamado a activar el complemento.

## 7. Reverso por deporte (F4)

- Registro `lib/cards/reversos.ts`: `{ [deporte]: componente }` con **`generico`** de respaldo. Agregar un deporte = agregar una entrada.
- **Fútbol:** mini cancha con la «Zona de juego» (posición de la alineación más frecuente en los últimos partidos) + 4 estadísticas según la posición, del partido en vivo (p. ej. delantero: goles, asistencias, partidos, minutos; arquero: partidos, minutos, goles recibidos, vallas invictas). *Las métricas exactas se cierran con las columnas reales de `match_live_events` en F4.*
- **Genérico (cualquier deporte o sin datos de partido):** % de asistencia (últimos 90 días), sesiones, última evaluación y antigüedad en el club.
- **Extras:** descarga/compartir como imagen y cuadrícula por club reutilizan `cardExport` y la pestaña «Carnets emitidos». Las exportaciones van **planas** (sin efectos) y **sin estado de habilitación**.

## 8. Habilitación al escanear (F5)

### 8.1 Niveles de visibilidad (reemplazan los actuales)
| Quién | Ve |
|---|---|
| **Público sin sesión** | Carnet **válido / no válido**, foto, nombre y club. Si el jugador es **menor de edad**: primer nombre e iniciales. *(Confirmar en la revisión.)* |
| **Personal del club** (coach, admin, school_admin) | Lo anterior + **semáforo**: 🟢 habilitado · 🟡 algo vence en ≤ 7 días · 🔴 no habilitado, con **el motivo en una línea** y **sin montos**. Botón **«Registrar asistencia»** (ya existe). |
| **Admin del club y acudiente** (y el deportista adulto) | **Detalle completo**: cada criterio con su estado y fecha, y los datos del deportista que la escuela haya encendido (EPS, RH, contacto de emergencia…, §4.1). |

Hoy `staff` incluye coaches y admins por igual: se separan en `coach` y `admin`.

### 8.2 Criterios (cada club elige cuáles aplican)
| Criterio | Fuente | Hoy |
|---|---|---|
| Pagos al día | Sin cobros vencidos (`overdue`, o `pending`/`partial` con `due_date` pasada la gracia del club). 🟡 si uno vence en ≤ 7 días. | Existe (estados de pago). Reemplaza la heurística «último pago < 30 días» del carnet. |
| Seguro deportivo vigente | **Nuevo:** documento del deportista con vigencia | No existe |
| Certificado médico vigente | **Nuevo:** documento con vigencia. **Solo vigente/vencido; nunca diagnósticos** (no se toca `health_records` ni `clinical_*`). | No existe |
| Autorización del acudiente para el evento | **Nuevo:** documento firmado por evento | No existe |
| Inscripción en la categoría o torneo | `enrollments` activa en el equipo; `event_registrations` aprobada si se escanea en contexto de un evento | Existe |

**Modelo propuesto (reutiliza, no duplica):** ampliar **`athlete_documents`** con tipos `sports_insurance`, `medical_certificate`, `event_authorization`, columnas `valid_until date` y `event_id uuid` (solo para la autorización). Configuración por club en `school_eligibility_rules(school_id PK, pagos, seguro, certificado_medico, autorizacion_evento, inscripcion boolean, dias_aviso int DEFAULT 7)`.

**Contexto de evento:** al escanear, el personal puede elegir «Verificar para: <torneo/evento>»; sin evento, la autorización no aplica y la inscripción se mira contra la categoría.

### 8.3 Reglas firmes
- El estado se consulta **en vivo** con una RPC aparte (`estado_habilitacion(p_qr_token, p_event_id)`); **no** viaja en `verify_athlete_id_card_public` para el público.
- **Nunca** se pinta en el carnet ni en PNG/PDF.

## 9. Fases y archivos

| Fase | Qué | Archivos principales |
|---|---|---|
| **F0** | Esta spec | `docs/specs/carnet-3d-club.md` |
| **F1** | Migración: acento + derechos del escudo, número/posición en `enrollments`, código `SM-AAAA-NNNNN` + backfill, `verify_…` con código e identidad, `card_back_data` | `supabase/migrations/<nueva>.sql`, `migrations_ledger.json`, `types.ts` (una sola regeneración al final) |
| **F2** | Identidad del club | `frontend/src/lib/cards/clubIdentity.ts` (+ test), `BrandingSettingsForm.tsx`, `bff/src/routes/branding-escudo.ts` (+ test), registro en `bff/src/index.ts` |
| **F3** | Carnet 3D | `frontend/src/components/cards/AthleteCard3D.tsx`, `frontend/src/hooks/useTilt3D.ts`, `MyAthleteCardsPage.tsx`, `SchoolCardsAdminPage.tsx`, `AthleteCardPublicPage.tsx` |
| **F4** | Reverso fútbol + genérico, extras | `frontend/src/lib/cards/reversos.ts`, `components/cards/reversos/*`, `cardExport.tsx` |
| **F5** | Habilitación | Migración (documentos con vigencia, reglas por club, `estado_habilitacion`, niveles coach/admin), pantalla de reglas del club, vista del personal en `/c/:token`, carga de documentos con vigencia |

## 10. Pruebas (calidad)

- **Validación de archivos** (`clubIdentity.test.ts` y test del BFF): tipo por firma de bytes, 2 MB, 512 px, SVG → PNG, **WebP conserva el alfa** (píxel transparente sigue transparente).
- **Contraste:** luminancia relativa y razón WCAG con casos conocidos (blanco/negro = 21:1).
- **Verificación:** ensayo de la RPC en la base viva dentro de una transacción abortada como `anon`, acudiente, coach y admin (lo que ve cada nivel; código digitado → enmascarado), más test del modelo de la página.
- **Habilitación (F5):** casos por criterio y por nivel (verde/amarillo/rojo, sin montos para coach).
- Cierre de cada fase con BD: `npm run seguridad:invariantes` sin críticas.

## 10.1 F1 — lo que quedó vivo (migración `20261126095105`, 2026-11-26)

- `athlete_id_cards.codigo` (`NOT NULL`, `UNIQUE`, CHECK de formato): 517 carnets con `SM-2026-00001…00517` por `created_at`, sin tocar su `updated_at`. Contador `athlete_card_code_counters` (RLS sin policies, sin permisos para `anon`/`authenticated`); el trigger `trg_athlete_id_cards_codigo` lo asigna **siempre** el servidor al insertar y lo hace inmutable.
- `enrollments.jersey_number` (0–999) y `enrollments.position` (1–40 caracteres). Lectura con respaldo en la última alineación: `_carnet_numero_posicion()` (interna).
- `update_school_branding` (firma nueva, los argumentos viejos siguen igual): `p_accent_color`, `p_reset_colores` (log `reset_default`) y `p_confirma_derechos_escudo` → `branding_settings.escudo_derechos = { confirmado_por: auth.uid(), confirmado_en: now(), logo_url }`. El BFF deberá mapear el error nuevo `invalid_accent_color` (F2).
- `verify_athlete_id_card_public` agrega `codigo`, `numero`, `posicion` (también `codigo` en revocado/vencido). Nada de lo anterior cambió.
- `verificar_carnet_por_codigo(p_codigo)` (`anon`): `found`, `estado`, `valido`, nombre enmascarado («Brayan S. L.»), club. Sin token, foto ni documento.
- `card_back_data(p_qr_token)` (solo `authenticated`; personal de esa escuela, acudiente, deportista adulto): `deporte` (`futbol`/`generico`), `zona_de_juego` {posicion, numero, origen}, 4 estadísticas genéricas (asistencia y sesiones de 90 días, último informe publicado, antigüedad). **Las de fútbol se agregan en F4.**
- **Quedan para F5:** punto 3 (nombre del menor enmascarado en `/c/:token` público) y punto 6 (separar coach/admin). F1 no cambió lo que ve cada nivel.
- `types.ts` **sin regenerar** (se hace una vez al cerrar el lote, ver CLAUDE.md).

## 11. Pendiente de confirmar en la revisión de esta spec

**1–8 aprobados como se proponen (2026-11-26).** La pantalla V2 vive en `/carnets-constancias`.

1. **3D y plantillas clásicas:** propuesta: en la app (familia, admin, verificación) se ve el **carnet 3D**; la **impresión y el PDF por equipo** siguen con las plantillas clásicas (el papel no es 3D).
2. **Código por emisión:** cada reemisión lleva **código nuevo** (el viejo queda «no válido»). Alternativa: un código fijo por jugador.
3. **Nombre del menor en la vista pública:** primer nombre + iniciales (propuesta) o nombre completo.
4. **«Pagos al día»:** todos los cobros vencidos (propuesta, porque la categoría del cobro no es confiable en 9 de los 13 caminos que crean cobros) o solo mensualidades.
5. **Número y posición:** en `enrollments` (por equipo) con respaldo en la última alineación (propuesta).
6. **El coach y los datos de emergencia:** propuesta: el coach ve los datos de emergencia que la escuela haya encendido (RH, EPS, contacto de emergencia), porque es quien atiende una lesión en la cancha; el documento y el detalle de pagos, no.
7. **Pantalla nueva del dueño (ver §12):** propuesta: construir ya la pantalla V2 «Carnets, constancias y QR» del lienzo, en vez de seguir con las cuatro pantallas V1.
8. **Constancias en la V2:** el lienzo del 13-nov **sí las conserva** (Más → Identidad → «Carnets, constancias y QR»), aunque `modulos-v2-definicion.md` (24-oct) las quitaba. Propuesta: manda el lienzo, que es más nuevo.

## 12. Encaje con la V2 (revisado contra el lienzo y el código, 2026-11-24)

**Lienzo** (`CGQozXBXP91kJn7YNF5Cs4`, mapa del dueño `DueMapa`, 13-nov): el Dueño V2 tiene cinco pestañas (Hoy · Deportistas · Cobros · WhatsApp · Más). En **Más → Identidad** está **«Carnets, constancias y QR»** (`DueFlow`, pantalla `car`) con tres filas —Carnets digitales («con foto y QR»), Constancias («de estudio y de pago»), QR de inscripción— y sus ventanas: **«Generar carnets»** (para un equipo, plantilla) y **«Constancia»** (deportista, tipo, periodo → «Generar y enviar»). En **Más → Configuración → «Datos y marca»**: logo (PNG/JPG, mínimo 512 px), un solo «color de marca» y «Powered by SportMaps siempre visible». Estado de error dibujado: «No se puede generar el carnet: falta la foto del deportista». Carnet del deportista: `DepCarnet` (QR que se agranda para el torniquete, aviso de vigencia, guardar y compartir).

**Código:**
| Pantalla V2 | Estado |
|---|---|
| Carnet del deportista (`DepCarnet`) | ✅ construido: `AthleteCardV2.tsx` (`VITE_DEPORTISTA_V2`) |
| Acudiente (Inicio, hijos, carnet) | ✅ construido (`VITE_ACUDIENTE_V2`) |
| Entrenador | ✅ construido (`VITE_ENTRENADOR_V2`) |
| **Dueño V2** (las 5 pestañas, «Carnets, constancias y QR», «Datos y marca») | ✖ **sin código**: ni bandera ni pantallas |

**Propuesta: una pantalla nueva del dueño, «Carnets, constancias y QR»,** que junta todo lo de este proyecto y reemplaza las cuatro entradas V1 (Carnets Digitales, Plantillas de Carnets, Constancias, QR de Inscripción):
1. **Arriba, el carnet 3D del club** (vista previa en vivo) y el botón **«Identidad del club»** → ventana «Datos y marca» ampliada (tres colores, escudo con confirmación de derechos, aviso de contraste; sin complemento: vista previa + llamado a activarlo).
2. **Carnets:** cobertura (X de Y con carnet), **«Generar carnets»** por equipo como en el lienzo, emitidos, PDF/imagen, y **«Datos que salen en el carnet»** (EPS, RH, contacto de emergencia… por escuela, D8).
3. **Constancias:** por aprobar, **«Generar y enviar»** como en el lienzo y las plantillas.
4. **QR de inscripción:** el enlace y el QR.
5. **(F5) «Reglas para entrar»:** los criterios del semáforo que elige la escuela.

Se construye con los criterios V2 (2–3 toques, celular primero, vocabulario V2) y se entra hoy desde el menú actual (Documentos e Identidad); cuando exista el armazón del Dueño V2, se cuelga en Más → Identidad sin rehacerla. **Antes de construirla se dibuja en el lienzo** (celular y computador) para aprobarla, como pide la definición V2 («dibujarlo antes de construir»).
