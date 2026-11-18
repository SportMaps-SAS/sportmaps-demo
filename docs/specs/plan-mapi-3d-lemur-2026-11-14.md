# Plan — Mapi 3D: el lémur de SportMaps hace los ejercicios (catálogo propio)

Estado: **propuesta para revisar** (2026-11-14). No se escribió código, no se aplicó nada en la base y no se commiteó.
Lo marcado *(decisión)* necesita tu respuesta; lo marcado *(por verificar)* es algo que aún no comprobé.

> Alcance: **solo** el catálogo de ejercicios con el lémur. Lo de la V2 del dueño es otro tema (ver `notas-dueno-v2-uso-y-escondido-2026-11-14.md`).

---

## 0. Qué se busca

Que el lémur de SportMaps (Mapi) haga **todos los ejercicios**, desde varios ángulos y mostrando los músculos, como **contenido propio**. Así no dependemos de GIFs de terceros, cuya licencia es incierta, y la marca queda en cada ejercicio.

### Lo que ya existe en la app
- Tablas `exercise_library`, `exercise_packs`, `exercise_assignments`, `exercise_logs` y los componentes `ExerciseLibraryPanel` / `ExercisePacksTab`. *(por verificar)* qué tienen exactamente antes de crear nada nuevo.
- El BFF mezcla wger.de y `free-exercise-db` (fotos estáticas) con traducción automática.
- El spec V2 deja abierta **D-BIB** (las dos bibliotecas de ejercicios se unifican y no está dicho cuál queda). El catálogo del lémur cae justo ahí.
- La pizarra 3D (three.js) ya corre en el navegador: es un antecedente para mostrar el lémur en 3D en vivo.

### Reglas del repo que aplican
- Migraciones inmutables, con `npm run migrations:new`; estados con `text + CHECK`; RLS sin autorrecursión.
- Una sola sesión aplica migraciones; importar un catálogo grande va en lotes (Disk IO).

---

## 1. El plan

### 1.1 Qué decidimos hoy (y por qué)

- **No se usan** los GIFs del repo `ExerciseGymGifsDB` ni los de packs baratos: no tienen licencia, el propio README dice que fueron «extraídos de Internet» y que el autor no tiene los derechos. Re-alojarlos nos haría a nosotros los distribuidores.
- **Ruta elegida: contenido propio con el lémur de SportMaps.** Es lo único sin riesgo de derechos y refuerza la marca.
- **Alternativa de pago** (ExerciseDB en Gumroad, ~US$300 pago único) queda en reserva, **solo** si el vendedor confirma por escrito que los GIFs son suyos y que podemos alojarlos y usarlos en una app por suscripción. Los términos no pude leerlos (página 404 y Notion vacío).

### 1.2 Lo que mostraron las dos pruebas con video generativo (Gemini/Veo, capa gratis)

- Sentadilla y flexión: **se reconocen y el personaje se mantiene en líneas generales.**
- **Fallos que se repiten:** la cola cambia de forma y se mueve sola aunque el prompt lo prohibía; el visor sale como gafas verdes y no como el visor translúcido del dibujo; el cuerpo se ve más largo y delgado que el original; el video salió de 10 s y no de una repetición de 4 s.
- La capa gratis se cortó a las 3 generaciones, así que los ángulos extra (frontal, tres cuartos, cámara alta) **no se probaron**.
- Conclusión: sirve para **prototipar**; para un catálogo de cientos de ejercicios, la inconsistencia se nota.

### 1.3 Fases

**B0 — Cerrar la prueba de video generativo**
- Probar los ángulos pendientes (orden: tres cuartos trasero, frontal, tres cuartos frontal). Es lo que dirá si el diseño aguanta un cambio de cámara.
- Costo: casi nada, pero depende de la cuota diaria de la capa gratis.

**B1 — Piloto 3D con el lémur** *(decisión D1)*
- Pedir al diseñador una versión del lémur en **pose neutra** (de pie, brazos en T o A) y **sin elementos flotantes** (la pantalla y el reloj del dibujo actual estorban para el 3D).
- Convertir a 3D y rig con Meshy o Tripo en **plan de pago** (los términos de la capa gratis se contradicen entre sus propias páginas).
- Animar 5 ejercicios (sentadilla, flexión, plancha, zancada, salto) con clips de Mixamo, corregir en Blender. *(por verificar)* términos de uso comercial de Mixamo/Adobe antes de apoyar el catálogo en sus clips.
- Entregable: 5 ejercicios renderizados desde 3 ángulos cada uno.
- **Criterio de pasa / no pasa:** cola y visor idénticos en todos los ángulos, cuerpo sin deformarse, y que un entrenador apruebe la técnica de los 5.

**B2 — Datos del catálogo**
- **Antes de crear tabla**: revisar `exercise_library` / `exercise_packs` y ampliar lo que ya hay (por ejemplo `sport_tags`, ángulos, URL del medio) en vez de duplicar. *(por verificar)*
- Migración con las convenciones del repo: `npm run migrations:new`, `text + CHECK` para estados, RLS sin autorrecursión, lectura para autenticados y escritura solo por `service_role`.
- Importar por lotes, con una sola sesión aplicando migraciones.
- Los `sport_tags` (qué ejercicio sirve a qué deporte) los define **un entrenador**; no se asignan automáticamente.

**B3 — Mapi propone, el entrenador aprueba**
- Mapi redacta las instrucciones y propone las poses a partir de la descripción del ejercicio. Cada ejercicio pasa por revisión de una persona antes de publicarse: una postura mal enseñada a un menor no se puede corregir después con una disculpa.
- Empezar con los **50 a 100 ejercicios más usados** por los entrenadores, no con los 1.300.

**B4 — Entrega**
- Salida en WebP/MP4 en bucle (el GIF de 1280×720 pesa varias veces más). Almacenamiento propio con `Cache-Control` largo.
- Opcional, fase posterior: mostrar el lémur 3D en vivo en el navegador (three.js, como la pizarra 3D) para que el entrenador lo gire y se resalte el músculo trabajado.

### 1.4 Presupuesto y plazos

Sin precios inventados: lo único con cifra verificada es ExerciseDB (~US$300 pago único, en reserva). Meshy, Tripo y Blender/Cascadeur hay que cotizarlos al momento de decidir (D1). El plazo del piloto depende de **quién hace el arte del lémur separado en piezas / en pose neutra** (D2).

---

## 2. Cronograma propuesto (para discutir, no compromiso)

| Semana | Qué |
|---|---|
| 1 | B0 (ángulos pendientes del video); pedir al diseñador la pose neutra; D1 y D2 resueltas |
| 2 | B1 inicia si hay modelo; si no, B2 (revisar tablas existentes) |
| 3 | B1 piloto 3D: 5 ejercicios desde 3 ángulos |
| 4 | B1 revisión por un entrenador y decisión pasa / no pasa |
| 5–6 | B2 y B3 si el piloto pasó: datos del catálogo y los primeros 50 ejercicios |

---

## 3. Decisiones que necesito de ti

- **D1.** Piloto 3D: ¿pagamos un mes de Meshy o Tripo para probar? (hay que cotizar y leer los términos del plan exacto).
- **D2.** ¿Quién hace el arte del lémur en pose neutra y por piezas? Sin esto no hay fechas.
- **D3.** ¿Escribimos al vendedor de ExerciseDB como plan B? (yo redacto el mensaje con las tres preguntas de licencia).

---

## 4. Qué NO haré sin tu OK explícito

- Aplicar migraciones o importar datos a la base.
- Pagar o suscribirme a herramientas externas.
- Subir nada a `main` (ni a `develop` salvo lo que ya está acordado).
- Usar contenido de terceros sin licencia.
