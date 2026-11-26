# Revisión de skills «anti AI slop» y qué no funciona en la app — 2026-11-26

Se revisaron las cinco skills que circularon. Se leyeron sin ejecutar nada; ninguna se instaló. Sus reglas se
usaron para revisar SportMaps, y lo que aplica quedó en `DESIGN.md` (§7 y §9) y en la compuerta
`scripts/v2-gate` (reglas `transition-all`, `hover-oculto`, `tres-puntos`).

## Las skills

| Skill | Qué es en realidad | Veredicto |
|---|---|---|
| **Vercel Web Design Guidelines** (`vercel-labs/web-interface-guidelines`, `vercel-labs/agent-skills`) | ~100 reglas concretas de interfaz (accesibilidad, foco, formularios, animación, toques, tema, i18n). La skill fija las reglas a un commit con SHA-256 (verificado: coincide) | **La más útil.** Se usó para revisar. Ojo: su `install.sh` baja las reglas de `main` con `curl` a tu carpeta global; si se usa, preferir la versión fijada. «Title Case» no aplica en español |
| **Emil Kowalski** (`emilkowalski/skill`, MIT) | 21 skills en markdown, sin scripts ni hooks: animación, gestos, Sonner, móvil nativo, `break-ui` (catálogo de casos límite) | **Útil como referencia.** Sus reglas de movimiento y de Sonner quedaron en `DESIGN.md` §7. Instalación sugerida remota (`npx skills@latest`) |
| **Taste Skill** (`Leonxlnx/taste-skill`, MIT) | Para **sitios de marketing** (1440×900, foto real, animación de entrada obligatoria, fuentes nuevas por página). Trae un hook de cierre que abre Chrome sin interfaz y escribe `.taste-skill/` en el proyecto; scripts que llaman a Wikimedia, picsum y jsDelivr | **No instalar.** Choca con celular primero, tokens, Poppins y la marca de cada escuela. Su lista de muletillas de texto se parece a `DESIGN.md` §8 |
| **ThinkUI** (thinkui.xyz) | No se pudo abrir: la red de este entorno no resuelve el dominio | Sin evaluar |
| **Anti UI Slop** (uizze.com) | Igual | Sin evaluar |

## Qué no funcionaba y se arregló

| Problema | Alcance | Arreglo |
|---|---|---|
| **No se podía hacer zoom** (`maximum-scale=1, user-scalable=no`). Falla WCAG 1.4.4; Android lo respeta | Toda la app | Quitado. La pizarra y la alineación ya tienen `touch-none` propio y los campos son de 16 px, así que no cambia nada más |
| **El «Deshacer» de la V2 tapaba la barra inferior** 8 s: Sonner pone el toast a 16 px del borde y la barra mide 64 px | Celular, toda la app | `mobileOffset` en `App.tsx`: medido en navegador, ahora queda a 76 px del borde en 390 px y sin cambio en escritorio |
| **Botones nativos sin foco visible con teclado** (la V2 usa `<button>` propios; 0 `focus-visible`) | Toda la app | Anillo `:focus-visible` global en `index.css` (los componentes shadcn traen el suyo y lo pisan) |
| **Selectores de fecha/hora claros en modo oscuro** (no había `color-scheme`) | V2 (Ajustar entreno, horarios) y toda la app | `color-scheme: light/dark` |
| Sin `theme-color` (barra del navegador) y `public/manifest.json` con un azul `#0ea5e9` que no es de la marca | Toda la app | Meta `theme-color` claro/oscuro; manifest en el verde de la marca |
| Buscador de «Convocar de otra categoría» (V2): campo de 36 px, «X» de 14 px sin área táctil, sin nombre accesible, «Buscando...» | V2 | 44 px, `aria-label`, `type="search"`, sin corrector, «…» |

Verificado: 4.096 tests del frontend, `tsc`, QA visual de páginas públicas (42/42) y prueba en navegador
del toast, el zoom, el foco y `color-scheme`.

## La V2 sale bien parada

Antes de estos arreglos ya tenía 0 `transition-all`, 0 `outline-none` sin reemplazo, 0 `div` con `onClick`,
89 `aria-label`, `tabular-nums` en números y `role="status"` en los avisos de «sin señal». Con las tres
reglas nuevas, la compuerta la deja en **0 en las ocho reglas**.

## Pendientes (V1), con lista de trabajo

No se tocaron: son pantallas de la V1 y cada arreglo cambia comportamiento.

1. **Acciones que solo aparecen con hover** (en el celular hay que tocar dos veces, o no se ven).
   Patrón correcto: el de `whatsapp/Conversaciones.tsx` (`md:opacity-0 md:group-hover:opacity-100`).
   Cuando estén todas, se puede activar `future.hoverOnlyWhenSupported` de Tailwind (hoy los `hover:`
   quedan «pegados» tras tocar en Android). Archivos:
   - `components/payment/PaymentCheckoutModal.tsx`
   - `components/payment/PaymentModal.tsx`
   - `components/school/TacticalBoard.tsx`
   - `components/settings/ProfileSection.tsx`
   - `components/trainer/QuickUseRoutineModal.tsx`
   - `components/ui/toast.tsx`
   - `components/vendor/product-wizard/ProductGalleryUploader.tsx`
   - `components/whatsapp/Conversaciones.tsx`
   - `pages/CalendarPage.tsx`
   - `pages/InvitationsManagementPage.tsx`
   - `pages/MyChildrenPageClassic.tsx`
   - `pages/ParentCheckoutPage.tsx`
   - `pages/trainer/tabs/ClientGoalsTab.tsx`
2. **Clic en `div`/`span`/`li` sin rol ni teclado** (no se pueden usar con teclado ni lector de
   pantalla). Lista aproximada (escáner por etiqueta; revisar cada una):
   - `components/GlobalNotificationBell.tsx:115`
   - `components/coach/StandaloneMicrocyclesPanel.tsx:202`
   - `components/enrollment/EnrollStudentModal.tsx:169`
   - `components/enrollment/EnrollStudentModal.tsx:212`
   - `components/explore/CompareSchools.tsx:76`
   - `components/explore/EnrollmentAuthModal.tsx:164`
   - `components/explore/EnrollmentAuthModal.tsx:184`
   - `components/explore/SchoolMap.tsx:281`
   - `components/pages/Dashboard.tsx:87`
   - `components/payment/PaymentCheckoutModal.tsx:1495`
   - `components/school/LineupModal.tsx:438`
   - `components/school/TacticalBoard.tsx:1190`
   - `components/school/TacticalBoard.tsx:1200`
   - `components/school/TacticalBoard.tsx:1247`
   - `components/school/TacticalTeamPin.tsx:25`
   - `components/tournaments/public/PublicMatchCard.tsx:141`
   - `components/trainer/RoutineCard.tsx:101`
   - `components/whatsapp/Conversaciones.tsx:797`
   - `pages/AttendanceSupervisionPage.tsx:1350`
   - `pages/AttendanceSupervisionPage.tsx:1565`
   - `pages/AttendanceSupervisionPage.tsx:1690`
   - `pages/InvitationsManagementPage.tsx:1228`
   - `pages/ParentCheckoutPage.tsx:923`
   - `pages/ParentCheckoutPage.tsx:939`
   - `pages/ParentCheckoutPage.tsx:953`
   - `pages/ParentCheckoutPage.tsx:974`
   - `pages/ParentCheckoutPage.tsx:1056`
   - `pages/RegisterPage.tsx:722`
   - `pages/RegisterPage.tsx:745`
   - `pages/RegisterPage.tsx:935`
   - `pages/SchoolProfilePage.tsx:158`
   - `pages/SchoolStudentsManagementPage.tsx:1506`
   - `pages/WellnessSchedulePage.tsx:241`
   - `pages/organizer/CreateEventPage.tsx:77`
   - `pages/organizer/OrganizerDashboardPage.tsx:190`
   - `pages/polls/PollsPage.tsx:112`
   - `pages/recepcion/RecepcionPage.tsx:356`
   - `pages/recepcion/RecepcionPage.tsx:357`
   - `pages/vendor/VendorOnboardingPage.tsx:421`
3. **333 `transition-all`**, **35 «¿Seguro?»** (patrón Deshacer, V2-0c) y **227 «...»**: en la compuerta,
   con trinquete (`node scripts/v2-gate/run.mjs --md salida.md` da archivo y línea).
4. Tokens `--transition-smooth`/`--transition-spring` (`all`, 300–350 ms) que no generan clase: limpiar.
5. Casos límite de `break-ui` para probar a mano en la V2: nombres largos con tildes («María José de la
   Cruz y Fernández»), «1 deportistas», montos en COP grandes, listas vacías y de 1, foto que no carga,
   logo oscuro de escuela en modo oscuro (white-label), 320 px y zoom 200 %.
