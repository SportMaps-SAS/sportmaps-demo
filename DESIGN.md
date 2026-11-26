---
name: SportMaps
description: Plataforma de gestión deportiva para escuelas, entrenadores, padres y atletas (Colombia / LATAM).
version: 1.0.0
updated: 2026-11-24
source_of_truth:
  colors: frontend/src/index.css (:root y .dark, valores HSL sin hsl())
  tailwind: frontend/tailwind.config.ts
  sizes: docs/design-tokens.md + frontend/src/lib/designTokens.ts
  components: frontend/src/components/ui (shadcn/ui sobre Radix)
colors:
  # Light (default). Formato HSL "h s% l%" tal como vive en index.css; hex de referencia.
  primary: { hsl: "119 60% 32%", hex: "#228321", on: "#FFFFFF", contrast_on: 4.84 }
  primary-glow: { hsl: "119 55% 42%" }
  primary-dark: { hsl: "119 65% 25%" }
  accent-orange: { hsl: "35 97% 55%", hex: "#FC9F1D", on: "#0B290A", contrast_on: 7.57 }
  accent-orange-dark: { hsl: "32 97% 48%", hex: "#F18204" }
  foreground: { hsl: "119 60% 10%", hex: "#0B290A" }
  background: { hsl: "0 0% 100%", hex: "#FFFFFF" }
  secondary: { hsl: "119 30% 96%", hex: "#F2F8F2" }
  muted-foreground: { hsl: "119 15% 45%", hex: "#628462", contrast_on_white: 4.20 }
  border: { hsl: "119 20% 90%" }
  destructive: { hsl: "0 84% 60%", hex: "#EF4343" }
colors_dark:
  background: { hsl: "119 45% 6%", hex: "#091608" }
  card: { hsl: "119 40% 12%", hex: "#132B12" }
  primary: { hsl: "119 55% 45%", hex: "#36B234", on: "#0B290A" }
  muted-foreground: { hsl: "119 15% 65%", hex: "#99B398", contrast_on_bg: 8.19 }
  border: { hsl: "119 30% 20%" }
typography:
  family: "Poppins, sans-serif"   # Google Fonts, pesos 400/500/600/700/800
  min_size: 12px                  # text-xs. Nada de text-[10px] / text-[11px]
  input_size: 16px                # text-input. Menos de 16px = zoom en iOS
  scale: { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, 2xl: 24, 3xl: 30, 4xl: 36, 5xl: 48 }
rounded:
  base: 0.5rem    # --radius → rounded-lg
  md: calc(0.5rem - 2px)
  sm: calc(0.5rem - 4px)
  pill: 9999px    # badges, chips, dots
spacing:
  gutter: 1rem
  touch: 2.75rem   # 44px mínimo táctil
  header: 3.5rem
  bottom_nav: 4rem # 0 desde md
breakpoints: { sm: 640, md: 768, lg: 1024, xl: 1280, container_2xl: 1400 }
motion:
  smooth: "0.3s cubic-bezier(0.4, 0, 0.2, 1)"
  spring: "0.35s cubic-bezier(0.2, 0, 0, 1)"
  reduced_motion: respetado globalmente en index.css (prefers-reduced-motion)
icons: lucide-react (stroke 2, tamaños h-4 / h-5 / h-6)
mascot: Mapi — lémur con gafas (brand/mapi/)
---

# SportMaps — DESIGN.md

Este archivo describe la identidad visual de SportMaps para que cualquier persona
o agente genere pantallas coherentes **sin inventar estilos**. Las fuentes de verdad
están en el front matter; si este archivo y el código discrepan, **gana el código** y
este archivo se corrige.

## 1. Personalidad

- **Deportivo, cercano y operativo.** SportMaps lo usan dueñas de escuelas, entrenadores
  en la cancha y padres desde el celular. Prima la claridad sobre lo espectacular.
- **Móvil primero.** La mayoría de padres y entrenadores entran desde Android de gama media
  y con datos móviles: poco peso, objetivos táctiles grandes, nada que dependa del hover.
- **Voz:** español de Colombia, tuteo («tu escuela», «registra la asistencia»). Frases cortas,
  verbos concretos. Cifras y condiciones solo si son verificables (ver §8).
- **Mapi** (lémur con gafas, `brand/mapi/`) es la cara del asistente de WhatsApp y de los
  estados vacíos o de ayuda. No se usa como decoración en pantallas operativas densas.

## 2. Color

Verde SportMaps (`primary`) es la marca y la acción principal. Naranja (`accent-orange`)
es el acento de energía: destacados, promociones, insignias. Todo se consume por token
(`bg-primary`, `text-muted-foreground`, `bg-orange`…); **nunca** hex sueltos en componentes.

| Rol | Token Tailwind | Uso |
|---|---|---|
| Acción principal | `bg-primary text-primary-foreground` | Botón principal, enlaces activos, foco |
| Acento | `bg-orange` / `bg-gradient-orange` | Destacar 1 cosa por pantalla: promo, «nuevo», CTA comercial |
| Superficie suave | `bg-secondary`, `bg-muted` | Fondos de sección, filas alternas |
| Texto secundario | `text-muted-foreground` | Metadatos, ayudas, fechas |
| Peligro | `bg-destructive` | Borrar, anular un pago, errores |
| Degradado de marca | `bg-gradient-brand` / `bg-gradient-hero` | Solo hero y piezas de marketing |

### Contraste (WCAG 2.1) — deuda conocida

Medido el 2026-11-24 sobre los valores de `index.css`:

| Par | Ratio | AA texto normal (4.5) |
|---|---|---|
| Blanco sobre `primary` (light) | 4.84 | ✅ |
| Blanco sobre `accent-orange` | **2.08** | ❌ |
| Blanco sobre `accent-orange-dark` | **2.65** | ❌ |
| `foreground` sobre `accent-orange` | 7.57 | ✅ |
| Blanco sobre `primary` (**dark mode**) | **2.77** | ❌ |
| `muted-foreground` sobre blanco | **4.20** | ❌ (pasa solo para texto ≥ 18.66px bold / 24px) |
| Blanco sobre `destructive` | **3.78** | ❌ |

Reglas mientras se corrigen los tokens globales:

1. **Texto sobre naranja va en `text-foreground` (verde oscuro), no en blanco.**
   Afecta `variant="orange"`, `bg-accent` y `accent-foreground`.
2. En dark mode, el botón `default` debe usar texto oscuro (`#0B290A`) sobre el verde claro.
3. `text-muted-foreground` no se usa para información necesaria en tamaños < 14px.

Cambiar `--accent-foreground`, `--primary-foreground` (dark) y `--muted-foreground` toca
toda la app: va en un PR propio con capturas antes/después (ver §10).

### Marca propia de escuela (white-label)

`BrandingScope` reescribe las variables CSS **en un contenedor**, no en `:root`, y solo en
rutas de escuela, para roles de escuela y con tier que incluya white-label. Consecuencias
para el diseño:

- Todo color de componente debe salir de una variable (`hsl(var(--primary))`). Un hex fijo
  rompe el branding de la escuela.
- No asumir que `primary` es verde: el diseño tiene que funcionar con cualquier color de marca.
- Pantallas públicas, de login, admin y marketplace siempre son SportMaps.
- Editar la marca (por tier, `school_has_branding_feature`) ≠ mostrarla (por addon,
  `school_shows_own_brand`).

## 3. Tipografía

- **Poppins** para todo (400 cuerpo, 500 etiquetas, 600 subtítulos, 700/800 títulos).
- Títulos de página: `text-2xl md:text-3xl font-bold`. Sección: `text-lg font-semibold`.
- Cuerpo: `text-sm` en tablas densas, `text-base` en lectura.
- **Mínimo `text-xs` (12px).** Campos de formulario en móvil: `text-input` (16px).
- Números (dinero, asistencia): `tabular-nums`. Moneda COP con separador de miles `.` y sin
  decimales: `$69.000`.

## 4. Layout y espaciado

Los tamaños estructurales están en `docs/design-tokens.md`. Resumen:

- Anchos: `max-w-page-narrow` (formularios), `max-w-page` (contenido), `max-w-page-wide` (tablas).
- Margen lateral móvil: `px-gutter` (16px). Contenedor centrado con padding 1 / 1.5 / 2rem.
- Contenido sobre la barra inferior móvil: `pb-nav-safe`. Pantalla completa: `h-screen-d`, nunca `h-screen`.
- Ritmo vertical en múltiplos de 4px (`gap-2/3/4/6`, `py-8/12/20` en marketing).
- Sin scroll horizontal de página en 360px de ancho. Las tablas anchas van en `overflow-x-auto`
  o pasan a tarjetas en móvil.

## 5. Forma y elevación

- Radio base `rounded-lg` (8px); tarjetas `rounded-lg`/`rounded-xl`; píldoras `rounded-full`.
- Sombras por token: `shadow-card` (tarjetas), `shadow-elevation` (hover/flotantes),
  `shadow-glow-*` solo marketing.
- Bordes `border` con `--border`; preferir borde + fondo suave antes que sombras fuertes.

## 6. Componentes

Base: **shadcn/ui** en `frontend/src/components/ui` (código propio, se edita ahí, no se
reinstala encima). Íconos: **lucide-react**.

| Componente | Variantes permitidas | Notas |
|---|---|---|
| `Button` | `default`, `outline`, `ghost`, `secondary`, `destructive`, `link` en producto; `hero`, `orange`, `elevation` solo marketing | Tamaño táctil: en móvil al menos `h-touch` (44px). `size="sm"` (36px) solo en escritorio o barras densas |
| Botón de ícono | `size="icon"` + `aria-label` obligatorio | En móvil `w-touch h-touch` |
| `Card` | — | Una idea por tarjeta. Título + dato + acción |
| `Badge` | `default`, `secondary`, `outline`, `destructive` | Estados de pago/inscripción con texto, nunca solo color |
| `Dialog` / `Sheet` | `max-w-modal-*` / `max-h-sheet` | En móvil, preferir `Sheet` inferior |
| `Tabs` | `h-tabs md:h-10` | |
| Tablas | `overflow-x-auto` | En móvil, convertir a lista de tarjetas si hay > 4 columnas |
| Estados vacíos | Ícono lucide o Mapi + 1 frase + 1 acción | Nunca una pantalla en blanco |
| Carga | `Skeleton` con la forma del contenido | Evitar spinners de pantalla completa |

## 7. Movimiento

Reglas tomadas de Emil Kowalski (autor de Sonner) y de las Web Interface Guidelines de Vercel, adaptadas
a una app operativa que se usa cientos de veces al día desde un Android de gama media.

- **Nombrar lo que se anima**, nunca `transition-all` (compuerta: regla `transition-all`). Solo
  `transform` y `opacity`; nada de animar `width`, `height`, `margin` o `top`.
- **Duraciones:** presionar 100–160 ms (el `Button` ya usa 100 ms y `active:scale-[0.97]`), menús
  150–250 ms, sheets y modales hasta 300 ms. Salir más rápido que entrar. Curva de salida (`ease-out`),
  nunca `ease-in` en UI. Nada empieza en `scale(0)`: desde 0.95 con opacidad.
- **Frecuencia:** lo que se ve 100+ veces al día (marcar asistencia, cambiar de pestaña) no se anima.
  Los datos (tablas, montos, gráficas) no se re-animan al montar. Sin pulsos ni brillos infinitos.
- **`prefers-reduced-motion`** está respetado globalmente en `index.css`: sin movimiento, pero los
  cambios de opacidad y color pueden quedarse.
- **Interrumpible:** lo que se dispara rápido o con gestos usa transiciones, no `@keyframes`.
- **Gestos** (cerrar un sheet deslizando): sigue al dedo 1:1, se cierra pasado ~40–50 % del recorrido
  o con un movimiento rápido, y siempre hay botón alternativo.
- **Toasts (Sonner):** un solo `<Toaster />`; en el celular va **encima de la barra inferior**
  (`mobileOffset` en `App.tsx`); el de Deshacer dura 8 s con `id` estable; deslizarlo para cerrarlo
  **no** deshace.
- **Hover:** en el celular no existe. Una acción que solo aparece con `group-hover` es invisible al
  tocar: usar `md:opacity-0 md:group-hover:opacity-100` (compuerta: regla `hover-oculto`).
- Nada que se mueva solo en pantallas operativas. Carruseles automáticos solo en marketing y
  **con pausa** (al pasar el mouse, al enfocar y con reduced-motion).
- Los tokens `transition-smooth`/`transition-spring` de `index.css` son `all` y **no generan clase**
  (los usan dos variantes de `Button` sin efecto): no usarlos; quedan para limpiar.

## 8. Contenido y honestidad

- Cifras públicas («150+ escuelas», «4.8 de rating», «Soporte 24/7») **solo si hay un dato
  que las respalde**. Si no, se quitan o se cambian por algo verificable.
- Precios y promos salen de la fuente comercial vigente (landing v3.0 / `saas-plans`), nunca escritos a mano en un componente.
- Sin enlaces muertos (`href="#"`) ni botones que no hacen nada.

## 9. Accesibilidad (mínimos)

- Contraste AA (ver §2). Foco visible (`ring`) en todo lo interactivo.
- `alt` en imágenes con contenido; `alt=""` en decorativas.
- Un `h1` por página; jerarquía de encabezados sin saltos.
- Objetivos táctiles ≥ 44×44px en móvil.
- Formularios: `Label` asociado, error en texto debajo del campo.
- **El zoom no se bloquea** (`index.html` sin `maximum-scale` ni `user-scalable=no`).
- Foco visible global para lo interactivo que no trae el suyo (`:focus-visible` en `index.css`).
- `color-scheme` claro/oscuro para que los selectores nativos de fecha y hora sigan el tema.
- Lo que se hace con clic en un `div`/`span` va en `<button>` (o con `role` y teclado).
- Avisos que cambian solos (sin señal, pendientes) con `role="status"`.
- «…» y no «...» en textos de carga y placeholders (compuerta: regla `tres-puntos`).
- En español, mayúscula solo al inicio en títulos y botones (no el *Title Case* de las guías en inglés).

## 10. QA visual y compuertas

| Herramienta | Qué cubre | Cuándo |
|---|---|---|
| `node scripts/v2-gate/run.mjs` | Estático, sin abrir la app: px fijos, texto < 12px, hex fijos, «¿Seguro?», voseo. **Trinquete** contra `scripts/v2-gate/baseline.json`: falla solo si algo empeora | Antes de cada commit de frontend. Tras pagar deuda: `--actualizar` |
| `node scripts/qa-responsive/run.mjs` | **La app con sesión** (cuentas de Club Campestre Demo, escrituras bloqueadas): todas las pantallas del menú por rol × 6 tamaños × densidad × zoom. Mide desborde, barra inferior, táctil, texto chico, pestañas, modales, **contraste, controles sin nombre, «¿Seguro?» y voseo en pantalla** | Cada fase de la V2: línea base antes y corrida después (regla 4 del track) |
| `npm run qa:visual` (en `frontend/`) | Páginas públicas sin sesión y sin base, claro y oscuro | Cambios en login, registro, páginas legales |

Cambios de tokens globales: adjuntar capturas antes/después de `qa-responsive`.

## 11. Qué no hacer

- Hex o `hsl(...)` literal en un componente (rompe dark mode y white-label).
- `w-[300px]`, `text-[11px]` y similares (ESLint avisa; usar tokens).
- Texto blanco sobre naranja.
- Más de un acento naranja compitiendo en la misma vista.
- Degradados y glow en pantallas operativas (asistencia, pagos, listas).
- Copiar el look de otra marca o app.

## 12. V2 de la app: criterios de aceptación

La V2 es el rediseño de la app (ROADMAP → «Track V2»). Fuentes: el lienzo
(`https://claude.ai/artifact/CGQozXBXP91kJn7YNF5Cs4`), `docs/mapa-app/cruce-rediseno.md`,
`docs/specs/modulos-v2-definicion.md` y el spec de cada módulo (`docs/specs/<módulo>-v2.md`).
Las pantallas nuevas viven en carpetas `…/v2/` (`components/coach/v2`, `parent/v2`, `athlete/v2`, `settings/v2`).

Las **8 reglas** no son estilo: una pantalla que las rompe no se da por cerrada.

| Regla | Qué significa en pantalla | Cómo se verifica |
|---|---|---|
| **WhatsApp primero** | Lo que la familia o el profe necesitan les llega por WhatsApp; la app es para lo que no cabe ahí | Spec del módulo; se prueba con mensajes reales |
| **Una frase y un botón** | Cada tarjeta dice una cosa y ofrece una acción principal. Nada de tableros con 6 métricas y 4 botones | Revisión contra el lienzo |
| **Lo normal ya viene marcado** | Lista con todos presentes; se toca la excepción, no la regla | Revisión + prueba de tareas |
| **Deshacer en vez de «¿Seguro?»** | Acción inmediata + aviso de 8 s con «Deshacer» (`useAccionConDeshacer`, `DESHACER_MS`). La escritura sale a los 8 s o al salir de la pantalla. El diálogo de confirmación queda solo para lo **irreversible hacia afuera** (borrar una escuela, anular un pago ya conciliado) | `v2-gate` (regla `seguro`) y `qa-responsive` (`v2Seguro`) |
| **Funciona sin señal** donde aplique | Asistencia y evaluación en la cancha se guardan en una cola local y suben solas (`colaAsistencia`); la pantalla lo dice («Se subirá cuando haya señal») | Pruebas con red cortada (Playwright `context.setOffline(true)`) |
| **Palabras de la cancha** | Una palabra por cosa (`V2Palabras`, V2-0b): «Cobros», «Entrenadores», «acudiente». Español de Colombia, de **tú**, sin voseo | `v2-gate` (regla `voseo`) y `qa-responsive` (`v2Voseo`) |
| **Valores por defecto** | Fecha de hoy, el grupo del profe, el monto del plan: el formulario llega casi lleno | Revisión + prueba de tareas |
| **Celular primero** | Se diseña a 360 px y se agranda. Cero píxeles fijos, solo tokens; objetivos de 44 px; claro y oscuro | `v2-gate` (`px-fijo`, `texto-chico`, `color-fijo`) y `qa-responsive` |

Además, en toda pantalla V2:

- **Carga, vacío y error son tres estados distintos**, cada uno con su texto y su acción (nunca un
  «No hay datos» cuando en realidad falló la red).
- **Interruptor de reversa por rol** mientras dure la transición (la V1 sigue disponible).
- **Cada fase se mide**: línea base de la base viva antes y número después (regla 4 del track). La
  corrida de `qa-responsive` de la fase va en `scripts/qa-responsive/out/<fase>`.

