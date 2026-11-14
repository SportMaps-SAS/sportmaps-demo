# notify_user con relación real + funciones nuevas sin EXECUTE por defecto (2026-10-29)

Dos migraciones independientes. Cada una es una transacción con autoverificación: si algo no queda como se espera, aborta entera.

## Orden

| # | Qué | Archivo | Cómo saber que salió bien |
|---|---|---|---|
| 1 | `notify_user` solo a destinatarios con relación | `aplicar-1-20261029101109_notify_user_solo_destinatarios_con_relacion.sql` | Termina sin error (trae su propio chequeo) |
| 2 | Verificar 1 | `notify-user-verificar.sql` | Un **error** que empieza por `RESULTADO — 17/17 OK (se deshace a propósito)`. Si faltan datos de wellness o de admin de plataforma, el total baja y lo dice al final del mensaje |
| 3 | Funciones nuevas sin EXECUTE para PUBLIC | `aplicar-2-20261029101115_funciones_nuevas_sin_execute_por_defecto.sql` | Termina sin error |
| 4 | Verificar 3 (solo lectura) | `default-privileges-verificar.sql` | Fila `RESUMEN` = `4/4 OK`. Hoy, antes de aplicar, da `3/4` (falta la fila global) |
| 5 | **Paso manual** (no lo puede hacer `postgres`) | Ticket a soporte de Supabase o sesión `supabase_admin` | Ver abajo |

## Qué cambia para la app

- **Paso 1.** El admin de una escuela ya no puede notificar a cualquier usuario: solo a gente de **sus** escuelas. El acudiente sigue avisando a la escuela cuando paga. La cita de wellness (atleta → profesional) ahora **sí** llega; antes fallaba en silencio. Un coach o un contador siguen sin poder notificar a familias, igual que antes. Además, `p_link` tiene que ser una ruta interna (`/…`); ningún llamador pasa links externos y nunca se guardó uno en `notifications`.
- **Paso 3.** No toca ninguna función existente. Desde ahí, **toda función nueva sin `GRANT EXECUTE … TO authenticated` da 42501 / 403 desde el frontend**. Es lo que se busca: el olvido se ve en la primera prueba en vez de quedar abierto para `anon`.

## Paso manual (supabase_admin)

`postgres` no es miembro de `supabase_admin`, así que no puede cambiar sus default privileges. Hoy en `public` siguen dando EXECUTE a `anon` y `authenticated` (fila INFO del verificar). Ninguna función de `public` es de `supabase_admin` hoy, así que el riesgo es bajo, pero queda pedirlo:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
```

## Notas

- **Registrar las versiones.** Si se pega en el SQL editor, hay que registrar `20261029101109` y `20261029101115` en `schema_migrations`, porque el editor no deja rastro. Mejor por CLI o `apply_migration`.
- **El verificar de notify_user no manda push.** Las notificaciones de prueba se insertan y se deshacen con el `RAISE` final. El trigger `trg_enqueue_notification_delivery` llama `net.http_post`, que solo inserta en `net.http_request_queue` (transaccional); el worker de pg_net nunca ve filas deshechas.
- **Una sola sesión a la vez** aplica migraciones (CLAUDE.md, Disk IO). `types.ts` no cambia: la firma de `notify_user` es la misma.
