# Mapi: consultas sin IA primero (diseño, 2026-11-26)

Estado: **capas 1 y 2 y tope construidos (2026-11-26)**, sin desplegar. Código en `bff/src/services/mapi-agente/directo/`. Variables: `MAPI_SIN_MODELO` (por defecto true) y `MAPI_TOPE_TURNOS_MES`. Ojo: el tope cuenta LLAMADAS al modelo, no turnos; un turno con herramientas hace unas 2,1 llamadas (evals 11-26).

## Por qué

Con Sonnet 5.5, cada turno de Mapi cuesta unos US$0,015 (≈ $60 COP). Con 3 turnos por conversación, los
cupos de IA que vendemos se comen el 60 % del plan Pro y más del 100 % del Elite. Además, la
mayoría de lo que preguntan las escuelas ya lo resuelve una consulta que existe: no necesita
modelo.

Decisión: **el modelo es el último recurso**. Mapi responde solo sobre los datos de la escuela de quien
pregunta. No es un asistente general.

## Las tres capas

```
mensaje ─┬─► 1. botón / menú (WhatsApp) ───────────────► consulta fija + plantilla   costo 0
         ├─► 2. palabras clave reconocidas (app y WA) ─► consulta fija + plantilla   costo 0
         └─► 3. texto libre que no encaja ─────────────► modelo barato (Haiku 5.5)   ≈ $4 COP/turno
```

- **Capas 1 y 2** llaman la MISMA función `ejecutar` de la herramienta que hoy usa el modelo. Así heredan
  sus mismos permisos: escuela de la sesión, rol por membresía, equipos del coach y
  `coach_hide_financial_info`. No hay un segundo camino de datos que asegurar.
- **Si hay ambigüedad** (dos «Mariana»), se usa la búsqueda fonética que ya existe y se muestran botones
  para elegir. No se le pregunta al modelo.
- **Acciones** (excusar, baja, plata…): siguen saliendo SIEMPRE como tarjeta + Confirmar. Un botón puede
  preparar la tarjeta sin modelo.
- **Capa 3:** el modelo es Haiku 5.5, si pasa los evals. Sonnet solo vuelve si un eval demuestra que hace falta,
  y detrás de una variable.

## Consultas candidatas a ir sin IA

| Consulta | Herramienta actual | Rol | Disparador (ejemplos) |
|---|---|---|---|
| Quién debe / cuánto se debe | `cartera` | admin | «quién debe», «cartera», «morosos» |
| Cuánto debe X / estado de X | `resumen_deportista` | admin, coach sin plata | «cuánto debe Samuel», «cómo va Mariana» |
| Comprobantes por validar | `pagos_por_validar` | admin | «por validar», «comprobantes» |
| Por qué no se aprobó el de X | `por_que_no_se_aprobo` | admin | «por qué no se aprobó» |
| Asistencia de hoy / de una sesión | `asistencia_de_sesion` | admin, coach | «asistencia de hoy», «quién faltó» |
| Semana del equipo | `semana_del_equipo` | admin, coach | «semana de los Tiburones» |
| Equipos y horarios | `equipos_y_horarios` | admin, coach | «horarios», «equipos» |
| Clases de prueba de la semana | `clases_de_prueba` | admin, coach | «clases de prueba» |
| WhatsApp sin responder | `seguimiento_whatsapp` | admin | «sin responder», «quién escribió» |
| Reservas de hoy | `reservas` | admin | «reservas de hoy» |
| Ventas de la tienda del mes | `ventas_tienda` | admin | «ventas del mes» |
| Inventario bajo | `inventario` | admin | «qué se está acabando» |
| Próximos torneos | `torneos` | admin | «torneos» |

Los informes **no** se elaboran en el chat: la app ya los genera. Mapi solo da el enlace a la pantalla
o al informe que ya existe.

## Control de gasto

- **Tope mensual de turnos con modelo por escuela**, igual al cupo del plan: Pro 500 y Elite 4.000. Se cuentan desde
  `llm_usage` (feature `mapi_agente`). Al llegar al tope, solo quedan las capas 1 y 2.
- Cada eval reporta el costo por turno. Si ese costo sube, el cambio no entra sin una decisión.
- `max_tokens` corto para lo que no es de la escuela (una línea de rechazo).

## Seguridad: lo que no cambia y lo que se agrega

Ya está:
- La escuela sale de la sesión; ningún esquema la recibe del modelo.
- El rol sale de una membresía activa.
- El coach solo ve sus equipos.
- WhatsApp es solo para administración, y el número queda ligado a la cuenta.
- La plata va con tope y auditoría.
- Las propuestas se confirman con código de un uso.

Se agrega:
- **Regla en el prompt (2026-11-26):** nada que no sea de esta escuela (cultura general, código, tareas,
  traducciones, recetas, salud, otras escuelas). Lo rechaza en una línea, sin herramientas.
- **Evals:** `casos-alcance.ts` (10 casos, umbral 100 %).
- **Plantillas:** solo muestran campos que la herramienta ya filtra. Nunca teléfonos, documentos, direcciones ni datos
  médicos.

## Orden propuesto

1. Medir Haiku 5.5 con la suite completa (≈ US$1). Si mantiene la calidad, cambiar `MAPI_AGENT_MODEL`.
2. Construir las capas 1 y 2 para las consultas de la tabla, con pruebas unitarias y con evals que verifiquen
   que esos mensajes **no** llaman al modelo.
3. Implementar el tope mensual por escuela.

## Medición 2026-11-26 (evals ×3, costo por turno)

| Tipo | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|
| Consultas | US$0,0117 | US$0,0009 |
| Procesos / creaciones | US$0,0138 | US$0,0010 |
| Pagos | US$0,0146 | US$0,0011 |
| Rechazos / preguntas | US$0,0070 | US$0,0005 |

Con 1.000 operaciones al día (50 % consultas, 25 % procesos, 20 % pagos, 5 % otros; 1,2 turnos por operación), el costo mensual sale así:
- Todo Sonnet: unos US$453.
- Haiku + capas sin IA: unos US$23.

Haiku iguala a Sonnet en lo funcional, pero es menos consistente en seguridad: confirmar 67 %, fuera de alcance 92 %, entrenador 98 %. Esas fallas son de redacción, no de filtración, porque los permisos los aplica el servidor. Hay que ajustar el prompt antes de dejarlo por defecto.
