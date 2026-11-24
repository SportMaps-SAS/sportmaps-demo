# Fortalecer la V2 de la app — 2026-11-24

La V2 es el rediseño de la app (ROADMAP → «Track V2»). Este trabajo no agrega pantallas: deja
**compuertas, criterios y robustez** para que lo que se construya en las olas 1–3 entre bien y se
pueda medir (regla 4 del track: número de antes y de después).

## Qué quedó

| Frente | Qué | Dónde |
|---|---|---|
| Criterios | Las 8 reglas de la V2 como criterio de aceptación verificable, con la herramienta que mide cada una | `DESIGN.md` §12 |
| Compuerta estática | `node scripts/v2-gate/run.mjs`: px fijos, texto < 12px, hex fijos, «¿Seguro?», voseo. Trinquete contra `baseline.json`: la deuda vieja no bloquea, la nueva no entra | `scripts/v2-gate/` |
| QA con sesión | La auditoría existente (`scripts/qa-responsive`, cuentas demo, escrituras bloqueadas) ahora mide también **contraste WCAG, controles sin nombre accesible, «¿Seguro?» y voseo en pantalla** | `checks.mjs` §12–14, `lib.mjs` |
| Vocabulario (V2-0b) | **Voseo en 0 en toda la app** (9 textos corregidos: «Tenés», «Elegí», «Agregá», «Revisá», «Confirmá», «actualizá», «Subí», «Volvé») | ver commit |
| Pantallas V2 | 0 hallazgos en las cinco reglas (2 textos de 11px pasaron a `text-xs`) | `athlete/v2`, `coach/v2` |
| Sin señal | Las tres colas offline (asistencia V2, marcador en vivo, bandeja) reintentaban **todas a la vez** (1 s, 2 s, 4 s… sin azar). Ahora con *jitter*: cada teléfono espera entre la mitad y el total | `conJitter` en `lib/tournamentActionQueue.ts` |
| Carga | `generalLimiter` del BFF por IP real y una cuenta por petición (antes: 99–100 % de 429 con 300 usuarios) | `docs/qa/pruebas-de-carga-2026-11-24.md` |

## Línea base de la compuerta (2026-11-24)

| Regla | Pantallas V2 (`*/v2/`) | Resto de la app |
|---|---|---|
| `px-fijo` | 0 | 84 |
| `texto-chico` | 0 | 1.438 |
| `color-fijo` | 0 | 331 |
| `seguro` («¿Seguro?» / `window.confirm`) | 0 | 35 |
| `voseo` | 0 | 0 |

> El ROADMAP dice «quedan 39 px fijos». La compuerta cuenta 84 porque también mira `rounded-`,
> `leading-`, `tracking-` y `translate-` con px; el criterio de V2-0a es el del ROADMAP.

Los 35 «¿Seguro?» son la lista de trabajo del patrón Deshacer (V2-0c) fuera de las pantallas V2:
`docs/qa/v2-compuerta-linea-base-2026-11-24.md` los trae con archivo y línea.

## Por qué el jitter importa para la V2

La regla «funciona sin señal» hace que el teléfono guarde la lista y la suba solo. Bien. Pero si la base
o el BFF responden 5xx (la caída de Disk IO del 14-oct fue exactamente eso), **todas** las colas
abiertas reintentaban al mismo milisegundo, una ola tras otra, sobre un servidor que ya estaba mal. Lo
mismo cuando varios profes recuperan la señal a la vez en la misma cancha. Con *jitter* la carga se
reparte (en el test, 200 colas que fallan juntas reintentan en más de 100 instantes distintos). El
`Retry-After` del servidor se sigue respetando.

## Lo que no se pudo correr desde aquí

- **La auditoría con sesión** (`scripts/qa-responsive/run.mjs`, apunta a `https://dev.sportmaps.co`):
  la red de este entorno la bloquea. Para la línea base de la V2:

  ```bash
  node scripts/qa-responsive/run.mjs --roles school,coach,parent,athlete --passes base \
    --out scripts/qa-responsive/out/v2-linea-base-2026-11-24
  ```

  Solo lee, con las cuentas de Club Campestre Demo, y bloquea toda escritura. Igual son lecturas
  sobre la base compartida: correrla en una sola sesión y fuera de hora pico.
- **Carga contra la base** (cuántos profes subiendo listas a la vez aguanta antes de quemar Disk IO):
  necesita un proyecto Supabase aparte. Ver `pruebas-de-carga-2026-11-24.md`.

## Siguientes pasos sugeridos

1. Correr la línea base con sesión (comando de arriba) antes de Comunicaciones F1.
2. Poner `node scripts/v2-gate/run.mjs` en el pre-commit o en CI junto a `migrations:check`.
3. V2-0c: reemplazar los 35 «¿Seguro?» por `useAccionConDeshacer` empezando por pagos (Aprobar).
4. Tokens globales con contraste bajo (`DESIGN.md` §2) en un PR propio con capturas de `qa-responsive`.
