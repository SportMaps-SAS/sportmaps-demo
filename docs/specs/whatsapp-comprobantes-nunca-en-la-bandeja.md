# Comprobantes con plata: nunca se quedan en la bandeja

Estado: **PROPUESTA — sin construir, sin migraciones aplicadas** · 2026-11-18 · Aplica a todas las escuelas con el bot de cobros (hoy: Monster´s Volley y Dynasty primero)

## Problema

La «Bandeja» de comprobantes de WhatsApp es un callejón sin salida. La propia pantalla lo dice: *«Marcar resuelto o descartar no cambia ningún pago»*. Cuando el bot duda de un comprobante (no sabe de quién es, el monto no cuadra, no hay cobro, el concepto es otro, la escuela tomó el chat), lo escala a la bandeja y ahí el dinero espera a que alguien lo busque y lo aplique a mano en Pagos.

Evidencia (Monster´s Volley Club, corte 2026-11-18, desde el 4-nov):

- 211 imágenes en la bandeja. Solo 23 tenían un monto leído (≈ $3,95 M). El resto nunca se había leído.
- Al leerlas (simulación de `wa-recuperar-comprobantes.ts --incluir-no-atendidos`): 78 no eran comprobantes, 50 ya no se pueden bajar de Meta (pasaron los ~30 días de vida del archivo o nunca se guardaron) y **6 eran dinero** que estaba clasificado como «número que no es de una familia» (p. ej. 3 comprobantes de $140.000 del mismo número, $175.000, $145.000, $30.000).
- Los 23 «Requiere tu acción» son de 5 tipos: servicio por registrar (5), otro concepto (7), número sin ficha (4), la escuela tomó el chat (4), prospecto/exceso/sin respuesta (3). Los más viejos llevan 8 días.
- Efecto: cupos de la clínica sin descontar, abonos sin aplicar, saldos que no se cobran, y la escuela sin ver lo que realmente se vendió.

Causa raíz: el worker (`bff/src/jobs/whatsapp-queue.job.ts`) solo estampa un comprobante en un cobro si **ya existe el cobro y es uno solo**. Para todo lo demás cierra la fila con un motivo. La RPC `wa_crear_cobro_desde_comprobante` además exige un dueño (hijo, no registrado, prospecto o usuario) y que el monto coincida con el catálogo (`monto_no_coincide` no crea nada).

## Principios

1. **Un comprobante con dinero real nunca termina en la bandeja.** Termina en Cobros, «En revisión», con su etiqueta.
2. **La escuela decide y aplica**; el sistema solo propone. Nada se aprueba solo.
3. **Mapi pregunta, pero no espera.** Si la familia no contesta en 24 h, el comprobante pasa igual a Cobros con lo que se sabe.
4. **La bandeja queda solo para lo que no es plata** (archivos ilegibles, contactos que no son familias, estados).
5. **Nada envejece sin avisar:** un comprobante en revisión con más de 24 h avisa al administrador.

## Decisiones de producto (a confirmar)

| # | Decisión | Propuesta |
|---|---|---|
| D1 | Comprobante sin dueño ni cobro | Se crea como «Pago por clasificar» en Cobros, con nombre del remitente, monto, referencia y propuesta; sin deportista hasta que la escuela lo asigne |
| D2 | Los «Para revisar» sin lectura | Solo pasan a Cobros los que traen un comprobante leído con monto > 0 y destino a una cuenta de la escuela |
| D3 | Monto que no cuadra con el catálogo | Entra a Cobros con la etiqueta «monto distinto» y los precios vigentes al lado; la escuela elige abono / saldo / otro |
| D4 | Referencia ya usada en otro pago | No se crea; se muestra enlazada al pago existente (defensa antiduplicado de siempre) |
| D5 | Chats que tomó la escuela | El comprobante entra igual a Cobros; el bot no responde, pero el dinero no se pierde |

## Diseño

### Etiquetas (la propuesta que ve la escuela)

`abono_de_cobro` · `saldo_de_cobro` · `servicio_nuevo` (clínica, vacacional, torneo) · `inscripcion` · `clase_de_prueba` · `articulo` · `exceso` · `repetido` · `por_identificar` · `fuera_de_sportmaps`.

### Datos

- Una entrada `payments` en `awaiting_approval` marcada en `wa_cobros_desde_comprobante` con categoría `por_clasificar`. **A verificar antes de escribir la migración:** si `payments` permite hoy un cobro sin dueño (CHECK / NOT NULL sobre hijo, prospecto, usuario). Si no, la alternativa es una tabla propia `wa_comprobantes_por_clasificar` unida a la lista de Cobros por una vista.
- RPC nueva `wa_crear_cobro_por_clasificar(p_school_id, p_queue_id, p_etiqueta, p_monto, …)`: `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`, idempotente por (fila de la cola + fuente), `GRANT EXECUTE … TO service_role` solamente (la llama el BFF). Transaccional: cobro + marca + fila de la cola en la misma transacción.
- RPC de decisión `wa_clasificar_cobro(p_payment_id, p_accion, …)` para la escuela, con gate adentro (`user_admin_school_ids()`/`user_staff_school_ids()` atado al id de la escuela del cobro) y `GRANT EXECUTE … TO authenticated`.
- Sin `CREATE TYPE`: estados y etiquetas como `text + CHECK`.

### Worker

`whatsapp-queue.job.ts`: antes de `cerrar()` con un motivo de bandeja, si hay un monto leído > 0 y el destino es de la escuela, llama a `wa_crear_cobro_por_clasificar`. Los motivos que hoy producen bandeja con plata (`varios_cobros`, `monto_distinto`, `sin_familia`, `familia_sin_cuenta`, `numero_ambiguo`, `otro_concepto`, `venta_servicio`, `venta_faltan_datos`, `venta_incompleto`, `escuela_tomo`, `sin_pendientes_con_pago`, `saldo_de_parcial`, `excedente_de_parcial`, `prospecto_sin_concepto`, `pregunta_vencida`, `venta_ya_tiene_cobro`, `venta_monto_no_cuadra`) pasan a ese camino.

### Frontend

En Cobros: columna «Qué es» con la etiqueta y botones por salida (aplicar como abono a…, crear cobro de…, saldo a favor, devolver, no es nuestro). Un comprobante por fila, con la imagen. La bandeja de WhatsApp conserva lo que no es plata.

### Aviso

Job diario (sin N+1: lote con `.in()`) que avisa por WhatsApp/correo al administrador cuando hay comprobantes en revisión con > 24 h, con conteo y monto.

## Fases

| Fase | Qué | Migración | Riesgo |
|---|---|---|---|
| **1** | Barrido de lo atascado: lectura de los no leídos (simulación hecha 2026-11-18), lista priorizada para la escuela y, con los que ya tienen dueño y precio, estampado en revisión con el script existente | No | Bajo (simulación primero; no aprueba ni escribe a familias) |
| **2** | RPCs `wa_crear_cobro_por_clasificar` y `wa_clasificar_cobro` + cambio del worker | Sí (una sola sesión aplica migraciones; plan aprobado antes) | Medio |
| **3** | Pantalla de decisión en Cobros + alarma de 24 h | No | Bajo |
| **4** | Monster y Dynasty: backfill con la RPC de la fase 2 (simulación, luego aplicar) | No | Medio |

## Criterios de aceptación

- Ninguna fila de `whatsapp_inbound_queue` con monto leído > 0 y destino de la escuela queda en `failed | ignored | waiting_user` sin un cobro asociado.
- Todo comprobante en revisión > 24 h genera aviso.
- Un comprobante repetido (misma referencia) nunca duplica un pago.
- La bandeja, tras el backfill, solo contiene filas sin monto.
- `npm run seguridad:invariantes` limpio; RPCs con `GRANT` explícitos y gate adentro.

## Lo que NO cambia

- La escuela aprueba. El bot nunca aprueba ni aplica.
- No se le escribe a nadie por el backfill.
- Los motivos «no es comprobante», «contacto no atendido sin monto», «ráfaga de imágenes de otros números» siguen sin crear cobros.

## Alcance por escuela (decidido 2026-11-18)

Solo **Monster´s Volley** y **Dynasty** usan «Por clasificar»; las demás escuelas siguen con la bandeja de siempre.

- El bot registra en «Por clasificar» únicamente para los ids de `WA_POR_CLASIFICAR_ESCUELAS` (separados por coma). **Vacía o sin definir = nadie.**
- `WA_POR_CLASIFICAR_OFF=1` apaga todo, aunque la escuela esté en la lista.
- Monster `eb3ebc77-4ea4-4992-96c8-3c8ec574578c` · Dynasty `2d509571-3238-4c04-ac3f-6dfe20539226`.
- La tarjeta de Cobros solo se pinta si hay filas: en escuelas fuera de la lista no aparece.
- Sumar o quitar una escuela = cambiar la variable en Render (BFF), sin código ni migración.
