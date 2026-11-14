# Contratos de la oleada 1 (base de datos + BFF) — para pantallas y bot

Fuente: informes de los cuatro agentes de la oleada 1 (2026-11-06). Spec madre:
`docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md`. Todo está **sin aplicar y sin commit**:
las migraciones las aplica una persona, en una sola sesión. El SQL no se ha podido ejecutar.

## Decisiones por defecto (cerradas para no frenar)
- Retiro pedido por WhatsApp o app: **no** da de baja completa por defecto (`dar_de_baja=false`); solo la administración lo decide al resolver.
- Plazos: aprobación automática hasta 3 cuotas y 60 días (configurable); más que eso va a la administración. Solo pagadores con cuenta.
- Referidos: el % se aplica solo a cuotas **no manuales** (la beca de 100 % y las cuotas manuales no descuentan). Un mes de descuento por referido.
- Soportes: bloqueo al **confirmar** la inscripción y al inscribir a torneos por la escuela; no bloquea crear la ficha.
- Monster nunca recibe textos de mora/cobro en recordatorios nuevos.

## Montaje en `bff/src/index.ts` (lo hace quien integra; NO lo edites en las ramas de trabajo)
```ts
import referidosRoutes from './routes/referidos.routes';            app.use('/api/v1/referidos', referidosRoutes);
import acuerdosDePagoRouter from './routes/acuerdos-de-pago.routes'; app.use('/api/v1/payment-agreements', generalLimiter, acuerdosDePagoRouter);
import retiroYPausaRouter from './routes/retiro-y-pausa.routes';     app.use('/api/v1/plan-requests', generalLimiter, retiroYPausaRouter);
import soportesRouter from './routes/soportes.routes';               app.use('/api/v1/soportes', generalLimiter, soportesRouter);
// dentro de if (debenCorrerLosCrons()): iniciarReferidosCron() (06:30 COT), iniciarSoportesRecordatoriosCron() (10:00 COT)
// plazos: runAcuerdosRecordatorios cada hora (07:00–20:59 COT) y correrMantenimientoAcuerdos() una vez al día antes de apply_late_fees
```

## 1. Referidos — `/api/v1/referidos` (headers `Authorization` y `x-school-id`)
Escritura: `owner`, `admin`, `school_admin`. Lectura: esos + `accountant`. Coach/acudiente/atleta → 403.
Errores `{error, code}`; Zod → 422 con `issues`; migración pendiente → 503 `MIGRACION_PENDIENTE`.

| Método y ruta | Cuerpo / consulta | Respuesta |
|---|---|---|
| `GET /campaign` | — | `{campaign\|null, tramos_por_defecto}` |
| `PUT /campaign` | `{name, active, tiers:[{age_min, age_max\|null, pct}], starts_on?, ends_on?, max_pending=12, require_referrer_current=true}` | `{campaign}` |
| `POST /` | `{referred_enrollment_id, referrer_enrollment_id?, referrer_profile_id?, referrer_name_text?}` (al menos un referente) | 201 `{ok:true, referral}`; menor de 4 años: 200 `{ok:false, califica:false, motivo:'edad_fuera_de_tramos', edad}` |
| `PATCH /:id` | `{action:'vincular'\|'cambiar_inscripcion'\|'anular', referrer_enrollment_id?, referrer_profile_id?, referrer_name_text?, reason?}` | `{ok:true, referral}` (409 `REF_ESTADO_FINAL` si ya aplicado/anulado/vencido) |
| `GET /?year&month&status&referred_enrollment_id` | mes exige año | `{rows, total}` |
| `GET /report?year&month` | — | `{school_id, year, month, rows, totals:{total, por_estado, dejado_de_cobrar}, by_month:[{year, month, aplicados, ganados_por_aplicar, dejado_de_cobrar}]}` |

Estados del renglón: `sin_confirmar` → `pendiente` (al vincular referente) → `ganado` → `aplicado`; también `anulado`, `vencido`.
Códigos: `REF_CAMPANA_INACTIVA` 409, `REF_NO_ES_NUEVO` 409, `REF_MISMA_FAMILIA` 422, `REF_AUTOREFERIDO` 422, `REF_SIN_FECHA_NACIMIENTO` 422 (la pantalla pide la fecha antes), `YA_REGISTRADO` 409, `SIN_PERMISO` 403.
Para el bot (servicio `bff/src/services/referidos.service.ts`): `registrarReferido(schoolId, null, ...)` con actor null; el texto libre queda `sin_confirmar` hasta que la administración lo vincule.
RPC (todas con `p_actor uuid DEFAULT NULL`): `register_enrollment_referral`, `update_enrollment_referral`, `qualify_enrollment_referrals`, `referrals_report`, `upsert_school_discount_campaign`.

## 2. Plazos — `/api/v1/payment-agreements` (todas con sesión; el alcance lo imponen RLS y RPC)
| Método y ruta | Cuerpo / consulta | Respuesta | Quién |
|---|---|---|---|
| `GET /settings/:schoolId` | — | `{habilitado, max_cuotas, max_dias, auto_aprobar}` | cualquier autenticado |
| `POST /preview` | `{school_id, payment_ids[], cuotas?, fechas?[], montos?[]}` (al menos uno de los tres) | `{saldo_total, cuotas:[{seq,fecha,monto}], primera_fecha, ultima_fecha, dias, requiere_aprobacion, motivos[], topes, cobros[]}` | pagador o staff |
| `POST /` | `{school_id, payment_ids[], items:[{due_date, amount}], payer_profile_id?}` | 201 `{agreement_id, status, auto_aprobado, total, cuotas}` | pagador; `payer_profile_id` solo administración |
| `GET /mine?estado=a,b` | — | `{acuerdos:[... con items y cobros]}` | el propio usuario |
| `GET /school/:schoolId?estado=` | — | `{acuerdos, puede_resolver}` | staff o admin de la escuela |
| `POST /:id/resolve` | `{decision:'aprobar'\|'rechazar', nota?}` | `{agreement_id, status}` | solo administración |
| `POST /:id/cancel` | `{nota?}` | `{agreement_id, status}` | pagador, quien lo pidió o administración |

Motivos de `preview`: `mas_cuotas_del_tope`, `mas_dias_del_tope`, `sin_autoaprobacion`, `incumplio_antes`. Errores: 400 (`datos_invalidos`, `fecha_pasada`, `fechas_desordenadas`, `suma_distinta_del_saldo`), 403, 404 `acuerdo_no_encontrado`, 409 (`acuerdos_apagados`, `cobro_ya_en_acuerdo`, `estado_invalido`), 422 `cobro_no_elegible`, 503.
Estados del acuerdo: `solicitado`, `activo`, `cumplido`, `incumplido`, `rechazado`, `cancelado`. Cuotas: `pendiente`, `pagado`, `vencido`. Montos en pesos enteros; la última cuota absorbe el redondeo.
Configuración por escuela (`school_settings`): `payment_agreements_enabled` (false), `agreement_max_installments` (3), `agreement_max_days` (60), `agreement_auto_approve` (true).
Para el bot: llamar al servicio `solicitar()` de `bff/src/services/acuerdos-de-pago.service.ts` con cliente `service_role` y `p_payer_profile_id` del perfil identificado (la RPC `request_payment_agreement(p_school_id, p_payment_ids, p_items, p_payer_profile_id, p_source)`; con `service_role` el origen es `whatsapp`). Recordatorios de cuota: ya los hace el job, sin palabras de mora.

## 3. Pausa, retiro y reactivación — `/api/v1/plan-requests` (todas con `requireAuth`)
El canal de origen se llama **`channel`** (`app` | `whatsapp` | `admin`), NO `source`.
| Método y ruta | Cuerpo | Roles | Respuesta |
|---|---|---|---|
| `POST /pausa` | `{enrollment_id, reason:'injury'\|'vacation'\|'other', month_from:'AAAA-MM', month_to:'AAAA-MM', note?}` (máx. 12 meses) | familia titular | 201 `{request_id, status:'approved'\|'pending', auto_aprobada, fuera_de_tope, meses, tope, usados, ...}` |
| `POST /retiro` | `{enrollment_id, exit_date:'AAAA-MM-DD', reason?}` | familia titular | 201 `{request_id, status:'solicitado', kind:'retiro', effective_date}` |
| `POST /reactivacion` | `{enrollment_id, from_month:'AAAA-MM', reason?}` | familia titular | 201 |
| `DELETE /:tipo/:id` | — | quien la pidió o administración | 200 `{status:'cancelado'}` |
| `GET /mias?estado=` | — | familia | `{solicitudes: SolicitudDto[]}` |
| `GET /escuela/:schoolId?estado=&tipo=&limit=` | — | administración | `{solicitudes}` |
| `POST /:tipo/:id/resolver` | `{decision:'aprobar'\|'rechazar', note?, dar_de_baja?}` (`dar_de_baja` solo retiro) | administración de esa escuela | salida de la RPC |

`:tipo` = `pausa` | `retiro` | `reactivacion`. `SolicitudDto`: `id, tipo, enrollment_id, school_id, estado (solicitado|aprobado|rechazado|cancelado), atleta_nombre, desde, hasta (solo pausa), motivo, detalle_motivo, canal, solicitante_rol, auto_aprobada, fuera_de_tope, nota_administracion, creada_at, resuelta_at`.
Errores: 400, 401, 403, 404, 409 (ya hay solicitud abierta/resuelta), 422 (regla de negocio, texto en español listo para mostrar), 503 `{code:'migracion_pendiente'}`.
Reglas: pausa dentro del tope y con `pause_enabled` y `pause_auto_approve` (nueva, true) se aprueba sola y anula los cobros del periodo; fuera del tope queda pendiente con `fuera_de_tope=true`. El retiro **nunca** se autoaprueba; al aprobar cancela la inscripción, anula cobros desde la fecha de salida (con doble categoría los deja en `payments_a_revisar`). Reactivación vuelve la inscripción a `active`; los cobros los emite `open_month`.
Para el bot (sin HTTP): importar de `bff/src/services/retiro-y-pausa.service.ts` `pedirPausa`, `pedirRetiro`, `pedirReactivacion`, `cancelarSolicitud`, `listarMias` con `ctx = {actorId: <perfil identificado>, canal:'whatsapp'}` y sin `authorization`; el servicio comprueba que la inscripción sea de esa persona. `resolverSolicitud` exige JWT de administración. Aprobar/rechazar pausas en la app sigue siendo `approve_enrollment_pause` / `reject_enrollment_pause`.

## 4. Soportes (solo Monster) — `/api/v1/soportes`
| Método y ruta | Quién | Respuesta |
|---|---|---|
| `GET /:schoolId/estado?solo_faltan=true` | administración | `{activo, requeridos[], resumen:{total, completos, incompletos, sin_cuenta_incompletos}, deportistas:[{subject_type, subject_id, full_name, notify_profile_id, has_account, required_total, present_total, missing[], complete}]}` |
| `GET /:schoolId/deportistas/:tipoSujeto/:sujetoId` | administración | `{activo, completo, requeridos[], faltan[]}` (404 si no es de la escuela) |
| `POST /:schoolId/deportistas/:tipoSujeto/:sujetoId/:tipoDocumento` | administración o la propia familia (no coach) | 201 `{id, tipo, activo, completo, faltan[]}`; cuerpo `{archivoBase64, nombre?}`; JPG/PNG/WEBP/PDF hasta 4 MB; fotos y firmas solo imagen; errores 400 `codigo` (`tipo_invalido`, `formato_no_permitido`, `solo_imagen`), 413, 403, 404 |

`tipoSujeto`: `child` | `profile` | `unregistered`. Los 7 requeridos de Monster: `athlete_photo`, `eps_certificate`, `guardian_id_front`, `athlete_id_front`, `guardian_signature`, `athlete_signature`, `good_standing_certificate`. Las respuestas nunca traen URLs ni rutas de storage.
Bloqueo: `register-athlete` (escuela inscribe a torneo) → 409 `{codigo:'SOPORTES_INCOMPLETOS', faltan[]}`. La confirmación de Por asignar (`confirm_school_join_request_enrollment`) lanza SQLSTATE **`SP001`**, mensaje `SOPORTES_INCOMPLETOS: faltan N soporte(s): a, b`, `DETAIL` = JSON de tipos faltantes. **`PorAsignarSection.tsx` hoy hace `confirmEnrollment(...).catch(() => undefined)` y se tragaría ese error: hay que mostrarlo.**
RPC para pantallas: `athlete_documents_status(p_school_id)`, `soportes_verificar_sujeto(p_school_id, p_subject_type, p_subject_id)`. Solo `service_role`: `soportes_estado_interno(school, tipo?, id?)`, `soportes_reclamar_avisos(school, sujetos jsonb, cada_dias=4, maximo=6)`.
Para el bot: `guardarSoporte({schoolId, sujeto:{tipo, id}, tipo, archivo:{buffer, nombre?}, subidoPor?})` de `bff/src/services/soportes.service.ts` → `{ok:true, id, storagePath, tipo, faltan[], completo, activo}` o `{ok:false, status, error}`. NO decide quién puede subir por ese deportista: el bot solo pasa deportistas de la persona identificada. Exporta además `estadoInterno`, `esFamiliaDelSujeto`, `TIPOS_SOPORTE`, `ETIQUETAS_SOPORTE`, `SOPORTES_MONSTER`, `textoAviso`, `agruparAvisos`.
Las fichas sin cuenta (100 de 159 en Monster) no reciben avisos del job diario: los recordatorios por WhatsApp para ellas los hace el bot con `soportes_estado_interno` y `soportes_reclamar_avisos`.
Lo que sube la familia desde «Hijos V2» NO escribe fila en `athlete_documents` (solo el bucket, con el tipo como prefijo): el estado ya cuenta ambas fuentes.
