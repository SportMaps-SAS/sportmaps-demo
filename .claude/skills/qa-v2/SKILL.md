---
name: qa-v2
description: Verificar una pantalla o fase de la V2 de la app SportMaps (rediseño: coach/v2, parent/v2, athlete/v2, settings/v2, Comunicaciones, Hoy del dueño, lista sin señal) antes de darla por cerrada. Úsala al terminar cualquier cambio de UI de la V2, al medir la línea base de una fase, o cuando pidan «QA», «revisar responsive», «¿cumple las reglas de la V2?» o «prueba de carga».
---

# QA de la V2 — SportMaps

Criterios: `DESIGN.md` §12 (las 8 reglas de la V2) y §9 (accesibilidad). La V2 no se da por cerrada
sin el número de antes y el de después (regla 4 del track).

## 1. Compuerta estática (siempre, segundos)

```bash
node scripts/v2-gate/run.mjs
```

px fijos, texto < 12px, hex fijos, «¿Seguro?», voseo. Trinquete contra `scripts/v2-gate/baseline.json`.
Si algo mejoró: `--actualizar` y commitear la línea base. Las pantallas `*/v2/` están en 0: deben seguir en 0.

## 2. Tests

```bash
cd frontend && VITE_SUPABASE_URL=http://127.0.0.1:9 VITE_SUPABASE_PUBLISHABLE_KEY=x npx vitest run src/components/<rol>/v2
```

(Sin esas variables, los tests que importan el cliente de Supabase fallan al cargar.)

## 3. Recorrido con sesión (lecturas reales sobre la base compartida)

```bash
node scripts/qa-responsive/run.mjs --roles <rol> --routes "<regex de rutas>" --passes base \
  --out scripts/qa-responsive/out/<fase>-<antes|despues>
```

Cuentas de **Club Campestre Demo** (nunca escuelas reales); toda escritura se bloquea. Mide desborde,
barra inferior, táctil, pestañas, modales, contraste, controles sin nombre, «¿Seguro?» y voseo.
Son lecturas sobre la base única: una sola corrida a la vez, filtrar rutas, fuera de hora pico.

## 4. Reglas que solo se ven a mano

- **Una frase y un botón; lo normal ya marcado; valores por defecto:** comparar con el lienzo
  (`docs/mapa-app/cruce-rediseno.md`).
- **Deshacer:** la acción usa `useAccionConDeshacer` (8 s) y sobrevive a recargar la página.
- **Sin señal:** con Playwright `context.setOffline(true)`, guardar, volver a la red; se sube una vez,
  sin duplicar, y la pantalla lo dice.
- **Carga, vacío y error** son tres estados distintos.

## 5. Carga (solo local, nunca contra Supabase)

```bash
node scripts/carga/escalera.mjs --url http://localhost:4100/<ruta> --escalones 5,10,25,50
```

Ver `docs/qa/pruebas-de-carga-2026-11-24.md` para levantar el BFF sin base. La herramienta se niega a
apuntar a Supabase; no esquivarla.

## 6. Reporte

Resumir en la conversación: compuerta (antes → después), tests, hallazgos de `qa-responsive` por
severidad, y lo que no se pudo verificar y por qué.
