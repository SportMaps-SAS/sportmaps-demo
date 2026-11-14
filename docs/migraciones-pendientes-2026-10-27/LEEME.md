# Notificaciones push: desatascar el despachador y apagar el push legacy (2026-10-27)

## Qué pasa hoy

- **El despachador del BFF lleva atascado desde julio.** Es el job `bff/src/jobs/notifications-dispatch.job.ts`, que lee 50 filas `pending|failed` ordenadas por `next_attempt_at`.
- **Por qué se atascó.** Hay 62 filas `failed` con 5 de 5 intentos (del 2026-07-24 al 30). `finalize()` las seguía reprogramando y el job las descartaba en memoria. Así encabezaban siempre el lote y el job nunca llegaba al resto.
- **Lo que hay en la cola** (lectura del 2026-10-27): 2.532 `pending`, 584 `failed` reintentables y las 62 agotadas.
- **Quién entrega hoy.** El único push que llega es el del **trigger legacy** `trg_push_on_notification`, que llama a la Edge Function `send-push-notification`. Por eso la Edge Function **sigue desplegada y no se borra**.
- **Ojo con el BFF que despacha.** `notification_settings.bff_dispatch_url` apunta a **bffdev**: con una sola base, el BFF de dev despacha las notificaciones de producción.

## Orden (no saltarse pasos)

> **Primero la migración, después el código.** El worker de prod está vivo y habilitado. El código nuevo estaciona por sí solo las filas agotadas, así que si llega a prod antes que la migración, en menos de un minuto empieza a mandar las ~2.500 notificaciones viejas. Como un push a `main` despliega el BFF de prod solo, **el paso 2 tiene que estar aplicado antes de subir esta rama a `main`.**

| # | Qué | Archivo | Cómo saber que salió bien |
|---|---|---|---|
| 1 | Contar | `notificaciones-1-contar.sql` | Números del mismo orden que la lectura de referencia del encabezado |
| 2 | Desatascar (una transacción) | `notificaciones-2-desatascar.sql` (migración `20261027150500`) | Volver a correr el paso 1: `a_skipped_backlog_viejo = 0` y `b_infinity_agotadas = 0` |
| 3 | **Desplegar el código a prod** (rama `sec/fixes-1027`: `finalize()` ya no reprograma agotadas; el job estaciona agotadas y loguea el error del select) en el BFF que corre el cron **y** en el que recibe el disparo de pg_net | — | En los logs de Render aparece `[notif-dispatch] … parked=…` o `claimed=…` |
| 4 | **Verificar entregas reales durante 30–60 min** | `notificaciones-3-verificar.sql` | `entregadas_de_verdad_2h > 0` (filas `sent` con `web_sent > 0` o `native_sent > 0`) y `pendientes_elegibles` sin crecer |
| 5 | *(Opcional)* Mandar el disparo de pg_net al BFF de prod | `notificaciones-4-url-prod.sql` | `notificaciones-3-verificar.sql`, consulta 3: `status_code = 200` |
| 6 | **Recién aquí** apagar el push legacy | `disable-legacy-push-trigger.sql` (migración `20261027110334`) | `disable-legacy-push-trigger-verificar.sql` da `OK` |

> **Web push duplicado mientras convivan los dos.** Entre el paso 2 y el paso 6 cada notificación sale por web push dos veces: una por el trigger legacy y otra por el despachador. Es lo esperado y dura solo esa ventana. No hay que dejarla abierta más de lo necesario para verificar.
>
> **No apagar el legacy (paso 6) si el paso 4 no muestra entregas reales.** El legacy es hoy lo único que entrega. Apagarlo antes deja a todos sin push.

## Notas

- **Registrar las versiones.** Si se pega en el SQL editor, hay que registrar `20261027150500` y `20261027110334` en `schema_migrations`, porque el editor no deja rastro. Mejor aplicarlas por una vía que sí lo deje (CLI o `apply_migration`).
- **El paso 3 no reenvía avisos viejos.** Marca el backlog como `skipped` con `last_error = 'expired_backlog_2026_10_27'`. Ese backlog ya se entregó por el legacy o perdió vigencia. El backout está en el encabezado de la migración.
- **Retirar `send-push-notification` es otro cambio.** Va después del paso 6 y de unos días sin quejas.
