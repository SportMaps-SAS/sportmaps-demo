# Runbook: encender los avisos del canal SportMaps (+57 320 268 3539)

Estado al 2026-11-18: canal `sportmaps` conectado (CONNECTED, CLOUD_API), 5 plantillas `sm_*` APPROVED, interruptor apagado, 0 escuelas habilitadas, 0 suscripciones, 0 salientes. Specs: `docs/specs/canal-whatsapp-plataforma.md`, `docs/specs/mapi-admin-por-whatsapp-plan.md` §6.

Todo se opera desde `bff/` con `npx tsx scripts/wa-plataforma.ts <cmd>` (sin `--aplicar` solo simula) y desde `/admin/whatsapp`. Nunca imprimir tokens ni teléfonos completos.

## 0. Antes de empezar (una vez)

- Monster: quien debe recibir los avisos tiene que ser **owner/admin** en `school_members` (o `schools.owner_id`). Iván Sossa figura hoy como **coach**: con ese rol `adminsDeEscuela` no lo incluye, el enlace de activación da 403 y, aunque se suscribiera, `avisarPorPlataforma` lo descarta (`sinPermiso`). Decidir: o se le sube el rol, o recibe la admin existente de la escuela, o la dueña (perfil owner) activa. Lo decide la persona a cargo, no se cambia por iniciativa propia.
- Decidir si se enciende también `PAGOS_POR_VALIDAR_WA_ENABLED` (flag aparte, apagado). Con ambos jobs de comprobantes activos la dueña puede recibir dos avisos de «comprobantes por revisar» (claves distintas). Recomendado: primera semana sin ese flag.

## 1. Plantillas OK

```
cd bff && npx tsx scripts/wa-plataforma.ts estado
```
Verificar: número `CONNECTED`, las 5 `sm_*` en `APPROVED` (`sm_comprobantes_por_revisar` y `sm_informe_cartera_semanal` UTILITY; `sm_resumen_diario`, `sm_caso_por_atender`, `sm_clase_cortesia_novedad` MARKETING). Si alguna está PENDING/REJECTED: no seguir; `plantillas --aplicar` o el botón de plantillas en /admin/whatsapp solo registra las que faltan.

## 2. Habilitar la escuela

`/admin/whatsapp` → buscar «Monster» → habilitar (o `habilitar-escuela eb3ebc77-4ea4-4992-96c8-3c8ec574578c --aplicar`). Verificar: `estado` lista la escuela en «Escuelas habilitadas». Sin esto `avisarPorPlataforma` devuelve `escuela_no_habilitada`.

## 3. Suscribir a la persona (opt-in con ACTIVAR)

1. La persona (owner/admin) entra a la app en la escuela → ajuste «Avisos de SportMaps por WhatsApp» (`AvisosSportMaps.tsx`; `POST /api/.../:schoolId/avisos-sportmaps` con su celular). Requiere el interruptor general encendido para que `disponible` sea true (ver orden abajo) o el POST responde 409.
2. La app muestra el enlace `wa.me` con el texto «… ACTIVAR <código>» (código vigente 7 días). La persona lo abre y envía desde **ese** celular al +57 320 268 3539.
3. Verificar: `estado` → «Suscripciones activas: 1»; la persona recibe el mensaje de confirmación del canal.

Nota de orden: el paso 3.1 exige el interruptor encendido. Por eso, para Monster, se hace el paso 4 con la escuela ya habilitada y **sin suscripciones** (no sale nada a nadie hasta que alguien diga ACTIVAR) y luego se suscribe.

## 4. Encender el interruptor

`/admin/whatsapp` → interruptor (`platform_wa_canal.habilitado`, queda en auditoría), o `PLATFORM_WA_ENABLED=true` en Render (no hace falta si se usa el interruptor). Los 3 BFF comparten base: el interruptor de la base aplica a los tres; la variable, solo al servicio donde se pone.

## 5. Prueba con tester

- `PLATFORM_WA_TESTERS=57…` (números de pruebas) o botón «Prueba» de /admin/whatsapp (`POST /prueba`, manda un mensaje de prueba al número indicado).
- Verificar en `platform_wa_envios`: fila con `estado='enviado'`, `via` (`texto` si hay ventana de 24 h abierta, `plantilla` si no) y, en `platform_wa_mensajes`, el estado de entrega `delivered`/`read` que llega por webhook. Un `fallido` trae el motivo en `detalle`.
- Disparar un caso real controlado (p. ej. «Hablar con alguien» desde un número propio hacia el bot de la escuela) y comprobar que llega UN solo aviso y que repetirlo en la misma ventana no duplica (clave `caso:<conv>:<ancla>:<etapa>`).

## 6. Monitoreo (primeras 48 h)

- `platform_wa_envios` por `estado`/`tipo`: `fallido` > 0 → revisar `detalle` (131047 = ventana cerrada sin plantilla; 131049 = límite de marketing por usuario; 132xxx = plantilla/variables).
- Calidad del número en `estado` (`quality_rating`; hoy UNKNOWN) y tier de mensajería en Business Manager.
- Que no se acumulen `silencio` en el resultado: lo de 22:00–07:00 no se reserva y lo recoge el resumen de las 7:00.
- Apagado de emergencia: interruptor off en /admin/whatsapp (efecto en ≤1 min por el caché de `leerCanal`) o `deshabilitar-escuela <id> --aplicar`.

## Riesgos

- **Cupo de Meta**: el número es nuevo, tier inicial bajo y calidad UNKNOWN. Pocos destinatarios y pocos avisos (los urgentes tienen un aviso por conversación/hora). No usar este canal para campañas.
- **Plantillas MARKETING** (`caso`, `resumen`, `cortesia`): solo salen con opt-in; el ACTIVAR es ese opt-in. Meta limita marketing por usuario (131049): un fallo ahí no es un bug. Si una plantilla se recategoriza o cambia a pausada, se ve en `estado`.
- **Fuera de ventana de 24 h solo sale plantilla**; dentro, texto libre con enlace. La primera vez siempre es plantilla.
- **Horario silencioso**: por defecto 22:00–07:00 y `urgentes_en_silencio=false`: un urgente de la noche NO sale, lo recoge el resumen. Si Monster lo quiere distinto (propuesta del spec: urgentes pasan en la clínica hasta cerrar la preventa), se cambia por suscripción, no por código.
- **Cobro**: desde el 2026-10-01 Meta cobra por mensaje de plantilla entregado (utility, marketing, autenticación; el texto de servicio dentro de la ventana de 24 h no). Estimar volumen antes de abrir a más escuelas.
- **Rol**: dejar de ser admin corta los avisos sin tocar la suscripción (D5).
- **Comprobante que no cuadra / supera tope**: hoy llega al dueño solo por el aviso agrupado de comprobantes por revisar o, si queda sin procesar 10 min, como caso; no hay aviso urgente inmediato propio (ver bandeja «por clasificar», trabajo en curso en otra sesión).
