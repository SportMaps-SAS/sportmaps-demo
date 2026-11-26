# Plan de paridad (frente a LUDMO+) y migración a V2 — 2026-11-26

> **Estado:** aprobado en dirección por el usuario el 2026-11-26 («armemos todo lo que falta, incluido
> video, todo contra el roadmap»). Cada ítem entra a la cola de `docs/ROADMAP.md` con su ID. Las
> migraciones se muestran antes de aplicarse y van una sesión a la vez (`CLAUDE.md`).
>
> **Orden general:** primero Mapi (ya en curso), después la paridad y, en paralelo, la V2, empezando
> por las pantallas menos usadas y dejando las más usadas para el final.

## 1. Dónde estamos frente a LUDMO+ (verificado en código, specs y memoria)

| Función que anuncia LUDMO+ | SportMaps hoy | ID |
|---|---|---|
| Mensualidades, mora, estado de cuenta | En producción | — |
| Asistencia desde la cancha | En producción (V2 del entrenador, QR del carnet, modo sin señal F1–F2) | — |
| Convocatorias con aviso a cada familia | En producción; el aviso sale solo por push, no por WhatsApp | PAR-10 |
| Gestión del club (DOMUS) | En producción | — |
| Reserva de espacios (ARENA) | En producción por addon; faltan pagos y WhatsApp del plan unificado | (ya en cola O2/O3) |
| Pizarra táctica (TACTICA) | En producción y supera lo anunciado (multideporte, 3D, IA) | — |
| Entrenamiento y carga (CORPUS) | En producción (track PER: sRPE, ACWR, alertas) | — |
| Datos protegidos | En producción con deudas (helpers RLS sin envolver, `user_school_ids` sin rol) | PAR-9 |
| **Análisis de video (MOTUS)** | Subida y clips construidos detrás de flag en la pizarra (Bunny, sin llaves); no hay video por partido ni por deportista | **PAR-2 = VID-1, 2, 4, 5, 6** |
| **Partido en vivo y transmisión (SPECTACULUM)** | Marcador en vivo en producción (torneos y partido del club, este último apagado en clientes); la transmisión es solo un enlace externo | **PAR-3 = VID-3** |
| **Hoja de vida deportiva** | No existe consolidada (datos dispersos) | **PAR-1 ficha técnica global** |
| **Seguimiento integral (físico, nutrición, mente)** | Lo físico en producción; nutrición es una pantalla de ejemplo vacía; mente no existe | **PAR-4, PAR-5** |
| **Informes con IA (INTELLECTUS)** | Parcial (Mapi arma informes de datos); no hay texto redactado por IA en el informe del deportista | **PAR-6** |
| **Talento deportivo (VIRTUS)** | No existe | **PAR-7** |
| **Neuroentrenamiento (MENS)** | No existe | **PAR-8** |

Lo que tenemos y LUDMO+ no anuncia (se conserva y se comunica):
- Bot de WhatsApp por escuela y Mapi.
- Pasarelas y comprobantes leídos con IA.
- Facturación electrónica DIAN.
- Contabilidad.
- Tienda y torneos.
- Carnets con QR y constancias.
- Control de acceso ZKTeco.
- Profesionales de salud.
- Captación (clase de prueba, QR, foto de la matrícula).
- Modo sin señal.
- Biomecánica.

## 2. Cola de paridad (PAR)

| ID | Trabajo | Tamaño | Depende de | Spec |
|---|---|---|---|---|
| **PAR-1** | **Ficha técnica global** (hoja de vida deportiva). Dos páginas con la marca del club, para cualquier deporte y posición. **Página 1:** foto, número, posición, categoría, «media», datos físicos, atributos por posición en escala 0–100, ubicación en cancha y temporada con estadísticas propias del deporte (atajadas y vallas invictas en arquero, goles en delantero…). **Página 2:** radar de atributos, evolución de la media, asistencia, pruebas físicas con nivel, historial por año y fortalezas, aspectos a mejorar y objetivos firmados por los entrenadores. Pantalla y PDF. | M | Carnet 3D F1 (número, posición, acento), MOD-37 F4 (ficha informativa), partidos (minutos), métricas físicas | [`ficha-tecnica-global.md`](specs/ficha-tecnica-global.md) — respuestas aprobadas 11-26 |
| **PAR-2** | **Video por partido y por deportista** (VID-1 → VID-2 → VID-4). VID-1: enlace a la grabación en el partido, link-out. VID-2: VOD propio con subida directa al proveedor, token firmado y RLS de dos capas. VID-4: clips por deportista que llegan al informe, al perfil, a la ficha y a la familia. | L | Proveedor único (D-VIDEO-1), consentimiento (VID-6 / G-IMAGEN), costo y retención (VID-5) | [`video-partidos-bunny.md`](specs/video-partidos-bunny.md) (reemplaza a Cloudflare en §VID) |
| **PAR-3** | **Transmisión.** (a) Encender `live_match_enabled` en clientes que lo pidan. (b) `stream_url` también en el partido del club. (c) VID-3: en vivo propio vía RTMP (Veo Live Custom), con el marcador de SportMaps encima. | S + S + L | (c) depende de PAR-2 y de que haya red en la cancha | ROADMAP §VID |
| **PAR-4** | **Nutrición e hidratación.** Plan del nutricionista para el club (no solo autorregistro), registro de hidratación en el entreno y alertas. Mientras tanto se oculta `/nutrition` (es de ejemplo). | M | Decisión de alcance (D-NUT-1) | [`seguimiento-integral-nutricion-bienestar.md`](specs/seguimiento-integral-nutricion-bienestar.md) |
| **PAR-5** | **Bienestar diario y mente.** Check-in de sueño, fatiga, ánimo y estrés (BOD-1B), con alertas al entrenador. | S–M | — | [`seguimiento-integral-nutricion-bienestar.md`](specs/seguimiento-integral-nutricion-bienestar.md) (detalle de BOD-1B) |
| **PAR-6** | **Informes con IA, con confirmación del entrenador.** Texto del informe del deportista redactado sobre los datos y aprobado antes de enviarse (MOD-19/20). Con Haiku y un tope por escuela, según la regla de costos de Mapi. | M | Mapi en Haiku (costos) | `informes-multi-cadencia-2026-08-19.md` |
| **PAR-7** | **Talento deportivo.** Detección por métricas con umbrales y evolución de la ficha técnica; lista de seguimiento de talentos por escuela. Solo datos de la propia escuela. | L | PAR-1 | [`talento-deportivo.md`](specs/talento-deportivo.md) |
| **PAR-8** | **Neuroentrenamiento.** Primero una investigación de alcance (pruebas cognitivas de reacción y atención en el celular). Sin spec no se construye. | L | D-NEURO-1 = pruebas propias | [`neuroentrenamiento-pruebas.md`](specs/neuroentrenamiento-pruebas.md) |
| **PAR-9** | **Aislamiento entre clubes sin matices.** Aplicar los lotes 1 y 2 de helpers RLS y `user_school_ids` con rol. | M | Turno de DDL, medir el radio | Migraciones 20261118163548, 20261123123742 |
| **PAR-10** | **Convocatoria por WhatsApp** a cada familia, además del push. | S | Despachador unificado | `project_notifications_unified` |

### Decisiones resueltas (2026-11-26, el usuario)

- **D-VIDEO-1 → Bunny Stream** para todo el video: subida, clips, VOD y en vivo. Se reutiliza la integración de la pizarra (`bff/src/services/video/bunny.ts`). La sección VID del ROADMAP queda con Bunny en lugar de Cloudflare Stream.
- **D-IMAGEN (VID-6) → el club entero ve, con consentimiento.** El staff y las familias del equipo ven el partido. Cada acudiente acepta una vez el consentimiento de imagen. Al deportista sin consentimiento no se le etiqueta en clips.
- **D-NUT-1 → plan del club más hidratación.** El nutricionista o el entrenador asigna plan y metas de hidratación; el deportista registra en 2 toques y el entrenador recibe alertas.
- **D-NEURO-1 → construir pruebas propias** de reacción, atención y toma de decisiones dentro de la app.
- Sigue abierta **D-VIDEO-2** (retención y precio): se costea con Bunny antes de activar el video en clientes.

### Decisiones que había que tomar antes de construir (contexto)

- **D-VIDEO-1 · Proveedor de video único.** La pizarra (M6h) usa Bunny Stream y VID propone Cloudflare Stream. Hay que elegir uno para todo, por costo de almacenamiento y salida, porque el modelo `recordings.provider` es agnóstico. Recomendación: **Bunny**. Ya está integrado y cuesta menos por GB. Cloudflare Stream se evaluaría solo si el en vivo RTMP de Bunny no alcanza.
- **D-IMAGEN (VID-6) · Video de menores.** Quién ve el partido (el club entero o cada familia solo sus clips) y cómo se pide el consentimiento del acudiente. Sin esto no se activa PAR-2 en clientes reales.
- **D-VIDEO-2 · Retención y precio (VID-5).** Cuántos meses se guarda y si el video es un addon pago.
- **D-NUT-1 · Alcance de nutrición.** ¿Plan del nutricionista del club, o autorregistro del deportista primero?
- **D-NEURO-1 · Neuroentrenamiento.** ¿Se construye, se integra con un tercero o se descarta?

## 3. Migración a V2 por uso (de menos a más usada)

**Fuente:** `ui_usage_daily`, vistas por ruta del 2026-11-17 al 2026-11-26, sin usuarios internos. Son
175 pantallas internas: **65 con visitas y 110 sin ninguna**. Se vuelve a medir antes de cada ola.

**Inventario V2-A:** [`v2-ola-a-inventario-pantallas-sin-uso.md`](v2-ola-a-inventario-pantallas-sin-uso.md): 49 fusionar, 36 retirar (28 seguras y 8 con verificación previa), 16 migrar, 5 ya en V2 y 1 que se mantiene.

**Regla:** una pantalla sin uso **no se migra a ciegas**. Se decide una de tres cosas:
- **Fusionar:** se vuelve una sección de otra pantalla V2.
- **Retirar:** se oculta del menú detrás de un flag y se borra después de 30 días sin reclamos.
- **Migrar.**

| Ola | Pantallas | Criterio |
|---|---|---|
| **V2-A** | Las 110 sin visitas: contabilidad (5), organizador (11), vendedor (13), entrenador personal (6), tienda de la escuela (3), pacientes, nutrición, `school/*` poco usadas, `stats`, `results-overview`, `reporter-dashboard`… | Inventario con decisión por pantalla (fusionar, retirar o migrar). Lo que es de un rol sin clientes activos se retira del menú. |
| **V2-B** | 1 a 5 vistas: configuración, calendario del dueño, mensajes, plantillas, instalaciones, QR de inscripción, reportes de escuela, cambios de plan, sedes, rutinas, dotación, informe mensual, supervisión de asistencia, notificaciones, resultados, recordatorios, carnets/constancias, equipos, programas… | Migrar en lotes por tema. |
| **V2-C** | 6 a 40 vistas: finanzas, seguimiento deportivo, staff, ofertas, invitaciones, WhatsApp, estado de cuenta | Migrar con prueba de usuario. |
| **V2-D (de últimas)** | Las más usadas: control de acceso (82), inicio del dueño (143), deportistas (169), automatización de pagos (221). Del acudiente: inicio, mis pagos, mis hijos, «más» y calendario (V2 ya construida detrás de `VITE_ACUDIENTE_V2`). | Migrar con prueba cronometrada (gate del Track V2: 4 de 5 personas lo logran solas) y reversa por flag. |

**Ya en V2:**
- Entrenador y deportista: en main.
- Acudiente: detrás de un flag.
- Comunicaciones V2.

## 4. Secuencia propuesta

1. **Ahora (sin decisiones pendientes):**
   - PAR-1, spec de la ficha técnica global.
   - PAR-3a/b (flags y enlace en el partido del club).
   - PAR-10.
   - Ocultar `/nutrition`.
   - V2-A, inventario y decisión por pantalla.
2. **Con D-VIDEO-1 y D-IMAGEN:** PAR-2, en orden VID-1, VID-2 y VID-4.
3. **En paralelo:**
   - PAR-5.
   - PAR-6, después de pasar Mapi a Haiku.
   - PAR-9, en turno de DDL.
4. **Después:** PAR-4, PAR-7, PAR-3c y PAR-8 (este último solo si D-NEURO-1 lo aprueba).
5. **V2:** las olas B, C y D, cada una con su medición de uso actualizada.
