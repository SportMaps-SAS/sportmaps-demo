# Registro de avisos de WhatsApp (intentos, salieron o no)

Estado: PLAN, sin código ni migración. Requiere aprobación antes de escribir nada.

## Problema
Hoy un aviso que SALE deja fila en `whatsapp_messages` (el reporte `bff/scripts/registro-avisos.ts` la lee).
Un aviso que NO sale (sin opt-in, fuera de horario, plantilla no aprobada, bandera apagada, número sin ficha) no deja
rastro. No se puede contestar «¿a quién le tocaba y no le llegó?».

## Punto único de captura
Las plantillas de cobro pasan todas por `enviarCobroPorPlantilla` (`whatsapp-plantillas.service.ts:599`), que ya
devuelve `{enviado, motivo}` y no lanza. Sus llamadores: `payment-lifecycle-emails.job`, `whatsapp-payment-outcome.job`,
`estado-de-cuenta.service`, `recordatorios-cobro.service`, `recordatorio-cortesia.service`, `clase-prueba-agenda.service`,
`whatsapp-aviso-revision.service`. Registrar ahí cubre todos sin tocar cada uno.
Fuera de alcance (v1): el acuse de «recibido» y el link del grupo (texto libre, no plantilla) y las campañas masivas
(`campana`); las campañas ya dejan su rastro en su propia tabla.

## Tabla propuesta: `whatsapp_avisos_log`
| Columna | Tipo | Nota |
|---|---|---|
| id | uuid pk | |
| school_id | uuid not null → schools | |
| concepto | text not null | `ConceptoCobro` (`cobro_unico_nuevo`, etc.) |
| plantilla | text null | nombre real en Meta |
| payment_id | uuid null | |
| parent_id | uuid null → profiles(id) | |
| destino | text null | wa_id o null si es BSUID; teléfono completo SOLO aquí (RLS de staff) |
| resultado | text not null, CHECK in (`enviado`,`no_enviado`) | text + CHECK, no enum |
| motivo | text null | `MotivoNoEnvio` o `ok` |
| detalle | text null | recortado a 300 caracteres |
| wa_message_id | text null | une con `whatsapp_messages` |
| created_at | timestamptz default now() | |

Índices: `(school_id, created_at desc)` y `(payment_id)`. Nada más (IO).

## RLS y permisos (conforme al CLAUDE.md)
- RLS activa. Lectura: `TO authenticated`, `school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])`
  (quien trabaja en la escuela; padres y atletas no ven teléfonos ajenos). Sin policy de escritura.
- Escritura solo con `service_role` desde el BFF (INSERT directo, sin RPC: es un solo insert, no multi-fila).
- Sin GRANT a `anon`. Policy envuelta con `(SELECT …)`, para no evaluar por fila.
- No hay función nueva, así que no hay `GRANT EXECUTE` ni `search_path` que fijar.
- Verificación: `npm run seguridad:invariantes` después de aplicar, y `set local role anon; select count(*)` debe dar 42501.

## BFF
1. `registrarAviso(...)` en un módulo aparte, `whatsapp-avisos-log.ts`. Función que NUNCA lanza ni bloquea el envío
   (`.catch(() => undefined)`, como `registrarSaliente`).
2. Se llama una vez por intento al final de `enviarCobroPorPlantilla`, en cada `return` (los 12 motivos + `enviado`).
3. Bandera por escuela `WA_AVISOS_LOG_SCHOOL_IDS`, apagada por defecto, igual que acuse y grupo. Empezar con Monster.
4. Deduplicar los `no_enviado` repetitivos: los jobs reintentan cada tick (`fuera_de_horario`, `sin_optin`). Sin freno
   se inserta una fila por tick por persona. Regla: un `no_enviado` con el mismo `(payment_id, concepto, motivo)` en las
   últimas 12 h no se vuelve a insertar. Es una consulta por intento, así que va con índice y solo con la bandera encendida.
5. Retención: borrar a los 90 días con el job de limpieza que ya exista; no crear un cron nuevo.

## Reporte
`registro-avisos.ts` pasa a leer esta tabla además de `whatsapp_messages`, y agrega la sección «No salieron»
agrupada por motivo, con las personas afectadas.

## Pruebas
- Unitarias de `registrarAviso` (nunca lanza, recorta el detalle, deduplica).
- Una por motivo de `enviarCobroPorPlantilla` (que cada `return` deje exactamente una fila, con la bandera encendida; ninguna sin ella).
- Prueba de RLS en la base: staff de otra escuela no ve filas; `anon` da 42501.

## Orden de entrega (sin ramas por fases; se trabaja en develop)
1. Migración con `npm run migrations:new -- whatsapp_avisos_log` y ledger. **Una sola sesión aplica migraciones.**
2. BFF + pruebas, con la bandera apagada.
3. Aplicar en la base por CLI, una sola vez; regenerar `types.ts` solo al final.
4. Encender para Monster, mirar un día el reporte y comparar con lo que la escuela ve en el buzón.

## Riesgos
- Filas con teléfono completo: por eso el acceso es solo staff y el CSV/reporte no se sube al repo.
- Volumen: acotado por la deduplicación y la bandera por escuela; sin ella crece por tick.
- No registra lo que ocurre antes de `enviarCobroPorPlantilla` (por ejemplo, cuando un job decide ni intentar a quien
  no entra en la escalera). Eso es decisión de cada job, y es un hueco conocido de v1.

## Decisiones que necesito de ti
1. ¿Incluyo en v1 el acuse y el link del grupo (texto libre)? Recomendación: no, v2.
2. ¿Retención de 90 días está bien?
3. ¿Doy luz verde para escribir la migración con este diseño?
