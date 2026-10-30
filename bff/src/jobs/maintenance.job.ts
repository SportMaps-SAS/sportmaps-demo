import cron from 'node-cron';
import * as Sentry from '@sentry/node';
import { supabase } from '../config/supabase';
import {
    createTransactionWithToken,
    copToCents,
} from '../services/wompi.service';
import { reprocessOrphanWebhooks } from '../services/webhook-reprocess.service';
import { autoEmitPendingInvoices, autoEmitPendingMarketplaceInvoices, autoEmitPendingOrders, reconcilePendingInvoices, FACTURA_ATASCADA_HORAS } from '../services/invoicing.service';

import { runGlosaNotifications } from './glosa-notifications.job';
import { isStoreEnabled } from '../services/store-flag.service';
import { sendChargeCreatedEmails, sendOverdueNoticeEmails } from './payment-lifecycle-emails.job';
import { runEstadoDeCuentaMensualJob } from './estado-de-cuenta-mensual.job';
import { runRecordatoriosCobro } from '../services/recordatorios-cobro.service';
import { runNotificationDispatch } from './notifications-dispatch.job';
import { runAthleteReportsCycle } from './athlete-reports.job';
import { runTeamReportsCycle } from './team-reports.job';
import { runHourBankAutoclose } from './hour-bank-autoclose.job';
import { runHourBankOverageSuggestions } from './hour-bank-overage.job';
import { runAccessAutoBlockCycle } from './access-auto-block.job';
import { runHourBankBalanceNotices } from '../services/hour-bank-balance-notices.service';
import { runHourBankOverageAutoConfirm } from '../services/hour-bank-overage-auto.service';
import { runSaasBillingCycle } from './saas-billing-cycle.job';
import { runBridgeHeartbeatCheck } from './bridge-heartbeat-check.job';
import { runAccountDeletionCycle } from './account-deletion.job';
import { runPostTrainingReminders } from './post-training-reminders.job';
import { runWhatsAppQueue } from './whatsapp-queue.job';
import { runWhatsAppPaymentOutcome } from './whatsapp-payment-outcome.job';
import { runReceiptReviewAlerts } from './receipt-review-alerts.job';
import { runBienvenidaEscuelas } from './bienvenida-escuelas.job';
import { runWhatsAppMantenimiento } from './whatsapp-mantenimiento.job';
import { vencerComprobantesColgados } from './whatsapp-cola-vencimiento.job';
import { runWhatsAppPlantillasSync } from './whatsapp-plantillas-sync.job';
import { runWhatsAppResumenDiario } from './whatsapp-resumen-diario.job';
import { runBotResumenSemanal } from './bot-resumen-semanal.job';
import { runInformeCalidadBotSemanal } from '../services/informe-calidad-bot.service';
import { runInformeCarteraSemanal } from '../services/informe-cartera.service';
import { runFranjasCortesia } from '../services/franjas-cortesia.service';
import { anularCobrosSueltosVencidos } from '../services/ventas-servicios.service';
import { runRecordatorioCortesia } from '../services/recordatorio-cortesia.service';
import { runCortesiaVencida } from '../services/cortesia-vencida.service';
import { runSeguimientoNocheCortesia, detectarInscripcionesDeLeads } from '../services/prospecto-ciclo-clase.service';
import { runPlanChangeDetector } from './plan-change-detector.job';

/** Último aviso de factura atascada por dueño (memoria del proceso; se reinicia con el deploy). */
const ultimoAvisoFacturaAtascada = new Map<string, number>();

/**
 * Inicia los trabajos de mantenimiento programados para el BFF.
 */
export function initMaintenanceJobs() {
    // ────────────────────────────────────────────────────────────────────────
    // Interruptor global (plan-arquitectura-robusta-2026-10, F0). Los tres BFF
    // de Render (dev, stg, prod) comparten UNA sola base: cada cron que corre
    // en dev o stg es un disparo duplicado contra los mismos datos de prod
    // (correos dobles, bloqueos dobles, glosas, conciliación...). Los
    // DISABLE_* por tarea no alcanzan: ~15 tareas no tienen interruptor.
    //
    // La INTENCIÓN era CRONS_ENABLED=false en sportmaps-bff-dev y
    // sportmaps-bff-stg y sin definir en prod (= habilitado). OJO: al
    // 2026-10-27 sportmaps-bff-dev NO tiene CRONS_ENABLED=false, así que sus
    // crons SÍ corren contra la base compartida (y además
    // notification_settings.bff_dispatch_url apunta a bffdev). stg no está
    // verificado. Antes de asumir que un cron no corre en dev/stg, mirar las
    // variables de cada servicio en Render. Los DISABLE_* de cada tarea siguen
    // funcionando en cualquier proceso.
    // ────────────────────────────────────────────────────────────────────────
    if (process.env.CRONS_ENABLED === 'false') {
        console.log('[CRON] CRONS_ENABLED=false: no se registra ningún cron en este proceso.');
        return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Mantenimiento diario de sesiones (auto_finalize_stale_sessions +
    // refresh_session_health): NO va acá. Lo corre pg_cron en la base, job
    // `auto-finalize-stale-sessions`, a las 04:55 UTC — que son las 23:55 COT,
    // exactamente el minuto en que corría este bloque. Eran dos disparos
    // simultáneos de las mismas dos RPCs desde dos lados.
    //
    // Se dejó el de pg_cron porque es SQL puro: no depende de que el proceso
    // del BFF esté vivo ni de un redeploy de Render, y se ahorra el viaje de
    // red. Si alguna vez hay que devolverlo acá, primero hay que quitar el job
    // de la base (`SELECT cron.unschedule('auto-finalize-stale-sessions')`),
    // no dejar los dos.
    // ────────────────────────────────────────────────────────────────────────

    // ────────────────────────────────────────────────────────────────────────
    // Auto-cobro de suscripciones recurrentes con token Wompi
    //
    // Frecuencia: 02:00 COT cada día. Recorre `subscriptions_due_for_billing`
    // (vista que filtra suscripciones con auto_renew=true y next_billing_date
    // vencida) y crea una transaccion server-to-server contra Wompi usando el
    // token guardado. Al exito, marca paid + avanza next_billing_date un mes;
    // al fallo, registra last_billing_error y marca para review del negocio.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('0 2 * * *', async () => {
        // Kill-switch: este es el autopay LEGACY (tabla `subscriptions`). El canonico
        // es `recurring_subscriptions` (pg_cron -> /api/v1/recurring/run). Mientras ambos
        // coexistan, poner DISABLE_LEGACY_SUBSCRIPTION_AUTOPAY=true para apagar este sin
        // redeploy de codigo. Ver auditoria H-01.
        if (process.env.DISABLE_LEGACY_SUBSCRIPTION_AUTOPAY === 'true') {
            console.log('[CRON] Auto-cobro legacy de suscripciones DESACTIVADO por env.');
            return;
        }
        console.log('[CRON] Iniciando auto-cobro de suscripciones...');
        try {
            const { data: dueSubs, error } = await supabase
                .from('subscriptions_due_for_billing')
                .select('*');

            // La vista se crea solo si existe la tabla legacy `subscriptions`, y en
            // la base viva no existe (2026-10-29): no hay nada que cobrar, no es error.
            if (error && (error.code === 'PGRST205' || error.code === '42P01')) {
                console.log('[CRON] Auto-cobro legacy: la vista subscriptions_due_for_billing no existe; nada que cobrar.');
                return;
            }
            if (error) {
                console.error('[CRON] Error consultando subscriptions_due_for_billing:', error.message);
                return;
            }

            if (!dueSubs || dueSubs.length === 0) {
                console.log('[CRON] No hay suscripciones por cobrar hoy.');
                return;
            }

            console.log(`[CRON] Procesando ${dueSubs.length} cobros de suscripcion...`);

            for (const sub of dueSubs) {
                if (!sub.wompi_token || !sub.price) continue;

                const { data: userInfo } = await supabase
                    .from('profiles')
                    .select('email, full_name')
                    .eq('id', sub.user_id)
                    .single();

                if (!userInfo?.email) {
                    await supabase
                        .from('subscriptions')
                        .update({
                            last_billing_attempt_at: new Date().toISOString(),
                            last_billing_error: 'no_user_email',
                        })
                        .eq('id', sub.subscription_id);
                    continue;
                }

                // Referencia DETERMINISTICA por (sub, periodo YYYY-MM). Asi:
                //  - dos replicas del BFF que corran el cron a la vez colisionan en el
                //    INSERT (idx_marketplace_tx_provider_ref unico) -> solo una cobra.
                //  - si next_billing_date no avanza (llega tarde el webhook) y el cron
                //    re-corre al dia siguiente, el mismo periodo choca -> no re-cobra.
                // Ver auditoria H-01. El prefijo SUB- lo rutea el webhook a marketplace.
                const periodKey = new Date().toISOString().slice(0, 7); // YYYY-MM
                const reference = `SUB-${String(sub.subscription_id).slice(0, 8)}-${periodKey}`;
                const amountInCents = copToCents(Number(sub.price));

                // Crear marketplace_transaction antes de cobrar (para que webhook reconcilie).
                // provider_reference + payment_provider activan el unico parcial
                // idx_marketplace_tx_provider_ref (payment_provider, provider_reference).
                const { data: tx, error: txErr } = await supabase
                    .from('marketplace_transactions')
                    .insert({
                        user_id: sub.user_id,
                        checkout_type: 'subscription',
                        subscription_id: sub.subscription_id,
                        gross_amount: Number(sub.price),
                        payment_provider: 'wompi',
                        provider_reference: reference,
                        wompi_reference: reference,
                        status: 'pending',
                        description: `Renovacion auto: ${sub.plan_name || 'plan'}`,
                    })
                    .select('id')
                    .single();

                // 23505 = unique_violation: ya existe una tx para esta sub en este
                // periodo -> otro proceso/corrida ya inicio el cobro. Saltar (idempotente).
                if (txErr) {
                    if ((txErr as any).code === '23505') {
                        console.log(`[CRON] Cobro ya iniciado este periodo sub=${sub.subscription_id} (${periodKey}); saltando.`);
                    } else {
                        console.error(`[CRON] Error creando marketplace_transaction sub=${sub.subscription_id}: ${txErr.message}`);
                    }
                    continue;
                }

                const result = await createTransactionWithToken({
                    paymentToken: sub.wompi_token,
                    amountInCents,
                    reference,
                    customerEmail: userInfo.email,
                });

                if (!result.ok) {
                    console.warn(`[CRON] Cobro fallido sub=${sub.subscription_id}: ${result.error}`);
                    await supabase
                        .from('subscriptions')
                        .update({
                            last_billing_attempt_at: new Date().toISOString(),
                            last_billing_error: result.error,
                        })
                        .eq('id', sub.subscription_id);

                    if (tx?.id) {
                        await supabase.rpc('flag_payment_for_review', {
                            p_kind: 'marketplace_transaction',
                            p_id: tx.id,
                            p_reason: `autopay_failed: ${result.error}`,
                        });
                    }
                    continue;
                }

                // Wompi crea la tx pero el resultado real llega via webhook.
                // Marcar el intento; cuando llegue APPROVED, el webhook actualiza next_billing_date.
                await supabase
                    .from('subscriptions')
                    .update({
                        last_billing_attempt_at: new Date().toISOString(),
                        last_billing_error: null,
                    })
                    .eq('id', sub.subscription_id);

                console.log(`[CRON] Cobro iniciado sub=${sub.subscription_id} txWompi=${result.transactionId} status=${result.status}`);
            }

            console.log('[CRON] Auto-cobro de suscripciones completado.');
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error inesperado en auto-cobro:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Auto-cobro de suscripciones registrado para las 02:00 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Reproceso de webhooks huerfanos (Fix H-03). Cada 10 min reintenta los
    // eventos 'orphan'/'failed' cuya entidad local ya deberia existir. El claim
    // atomico dentro del runner evita doble-proceso entre replicas.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/10 * * * *', async () => {
        try {
            const r = await reprocessOrphanWebhooks(100);
            if (r.scanned > 0) {
                console.log(`[CRON] Reproceso webhooks: scanned=${r.scanned} processed=${r.processed} stillOrphan=${r.stillOrphan} failed=${r.failed} gaveUp=${r.gaveUp}`);
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en reproceso de webhooks:', err?.message || err);
        }
    });

    console.log('[CRON] Reproceso de webhooks huerfanos registrado (cada 10 min).');

    // ────────────────────────────────────────────────────────────────────────
    // Conciliacion diaria de pagos (Fix H-04). Detecta duplicados internos y
    // webhooks huerfanos estancados, los registra en payment_anomalies y alerta
    // por logs las criticas (visibles en el monitoreo del BFF). 03:30 COT.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('30 3 * * *', async () => {
        console.log('[CRON] Iniciando conciliacion de pagos...');
        try {
            const { data, error } = await supabase.rpc('detect_payment_anomalies');
            if (error) {
                console.error('[CRON] detect_payment_anomalies error:', error.message);
                return;
            }
            const r = (data ?? {}) as Record<string, number>;
            const criticas = (r.duplicate_split ?? 0) + (r.duplicate_marketplace ?? 0);
            if (criticas > 0) {
                // ALERTA critica: posible doble cobro/contabilizacion detectado.
                console.error(`[ALERT][pagos] Anomalias CRITICAS nuevas: duplicate_split=${r.duplicate_split ?? 0} duplicate_marketplace=${r.duplicate_marketplace ?? 0}. Revisar payment_anomalies (status='open').`);
            }
            console.log(`[CRON] Conciliacion: dupSplit=${r.duplicate_split ?? 0} dupMkt=${r.duplicate_marketplace ?? 0} rapid=${r.rapid_duplicate ?? 0} staleWebhook=${r.stale_orphan_webhook ?? 0}`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en conciliacion de pagos:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Conciliacion de pagos registrada para las 03:30 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Auto-facturación electrónica (trigger automático). Cada 15 min emite la
    // factura de los pagos 'paid' recientes de escuelas con facturador activo
    // que aún no tienen documento. Idempotente; cubre todos los caminos a
    // 'paid' (checkout, webhook, aprobación manual, recurrente).
    // Kill-switch: DISABLE_AUTO_INVOICING=true.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/15 * * * *', async () => {
        if (process.env.DISABLE_AUTO_INVOICING === 'true') return;
        try {
            const r = await autoEmitPendingInvoices();
            if (r.scanned > 0) {
                console.log(`[CRON] Auto-facturación (escuela): scanned=${r.scanned} emitted=${r.emitted} skipped=${r.skipped} failed=${r.failed}`);
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en auto-facturación (escuela):', err?.message || err);
        }
        try {
            const rm = await autoEmitPendingMarketplaceInvoices();
            if (rm.scanned > 0) {
                console.log(`[CRON] Auto-facturación (marketplace): scanned=${rm.scanned} emitted=${rm.emitted} skipped=${rm.skipped} failed=${rm.failed}`);
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en auto-facturación (marketplace):', err?.message || err);
        }
        try {
            // Tienda apagada (spec blindaje §1.3): no se facturan órdenes de tienda.
            if (await isStoreEnabled()) {
                const ro = await autoEmitPendingOrders();
                if (ro.scanned > 0) {
                    console.log(`[CRON] Auto-facturación (tienda/orders): scanned=${ro.scanned} emitted=${ro.emitted} skipped=${ro.skipped} failed=${ro.failed}`);
                }
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en auto-facturación (tienda/orders):', err?.message || err);
        }
        // Reconciliación: los PACs que validan asíncrono (Factus V2 en
        // producción solo acusa recibo) dejan la factura sin número ni CUFE.
        // Sin este paso se queda así para siempre: el dueño ve "—" y el
        // pagador no tiene nada que abrir, aunque la DIAN ya la validó.
        try {
            const rr = await reconcilePendingInvoices();
            if (rr.scanned > 0) {
                console.log(`[CRON] Reconciliación de facturas: scanned=${rr.scanned} completed=${rr.completed} stillPending=${rr.stillPending} failed=${rr.failed} stuck=${rr.stuck}`);
            }
            // Factura atascada sin validar: bloquea al PAC para todo el dueño.
            // Se avisa como mucho una vez cada 6 h por dueño (el cron corre cada 15 min).
            for (const owner of rr.stuckOwners) {
                const ultimo = ultimoAvisoFacturaAtascada.get(owner) ?? 0;
                if (Date.now() - ultimo < 6 * 3_600_000) continue;
                ultimoAvisoFacturaAtascada.set(owner, Date.now());
                const msg = `[invoicing] ${rr.stuck} factura(s) llevan más de ${FACTURA_ATASCADA_HORAS} h sin validar en la DIAN (dueño ${owner}). El PAC no emite nada nuevo hasta que se resuelvan: revisar en el panel del PAC.`;
                console.error(msg);
                Sentry.captureMessage(msg, 'error');
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en reconciliación de facturas:', err?.message || err);
        }
    });

    console.log('[CRON] Auto-facturación electrónica registrada (cada 15 min).');

    // ────────────────────────────────────────────────────────────────────────
    // Correos de glosa que el cron SQL no puede mandar: recordatorio "vence
    // mañana" y ratificación automática. 08:05 COT (después del pg_cron de
    // ratificación 08:00 UTC/03:00 COT — ya ratificó lo vencido). Idempotente
    // por claim atómico sobre reminder_sent_at / ratify_email_sent_at.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('5 8 * * *', async () => {
        try {
            await runGlosaNotifications();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en notificaciones de glosa:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Notificaciones de glosa registradas para las 08:05 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Correo "cobro generado" (apertura del mes). Por polling, no desde
    // open_month() en sí — cubre tanto el botón manual como el cron
    // auto_generate_payments (30 6 * * *) sin acoplarse a ninguno. Gateado por
    // school_settings.charge_notifications_enabled (apagado por defecto).
    // Cada 15 min, mismo ritmo que los otros jobs reactivos de este archivo.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/15 * * * *', async () => {
        try {
            await sendChargeCreatedEmails();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en correo de cobro generado:', err?.message || err);
        }
    });

    console.log('[CRON] Correo de cobro generado registrado (cada 15 min).');

    // ────────────────────────────────────────────────────────────────────────
    // Correo "pago vencido": corre después de apply_late_fees() (pg_cron,
    // 07:00 UTC/02:00 COT), que es quien marca status='overdue' al pasar los
    // días de gracia. Este job solo agrega el correo. Mismo gate que arriba.
    // ────────────────────────────────────────────────────────────────────────
    // Sin opción `timezone`: igual que el resto de jobs anclados a un cron de
    // Postgres (pg_cron corre siempre en UTC). Corre a las 12:15 UTC = 07:15
    // COT, después de 'apply-late-fees-daily' (07:00 UTC). Antes era 07:15 UTC
    // = 02:15 COT: un aviso de cobro a las 2 de la mañana, y por WhatsApp ni
    // siquiera saldría (fuera del horario de cobranza de whatsapp-plantillas).
    cron.schedule('15 12 * * *', async () => {
        try {
            await sendOverdueNoticeEmails();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en correo de pago vencido:', err?.message || err);
        }
    });

    console.log('[CRON] Aviso de pago vencido registrado para las 12:15 UTC = 07:15 COT (tras apply_late_fees).');

    // ────────────────────────────────────────────────────────────────────────
    // Estado de cuenta MENSUAL por familia (correo, o WhatsApp si la familia lo
    // aceptó y la plantilla está aprobada). L-V 8:00-12:00 COT; el servicio
    // decide si hoy toca (día hábil, festivos, cobros del mes ya creados) y la
    // base garantiza uno por familia y mes entre los tres BFF. Mientras esté
    // pendiente, los avisos por cobro de esa escuela esperan (ver el servicio).
    // Kill-switch de este proceso: DISABLE_ESTADO_CUENTA_MENSUAL=true.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('0 8-12 * * 1-5', async () => {
        try {
            await runEstadoDeCuentaMensualJob();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en estado de cuenta mensual:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Estado de cuenta mensual registrado (L-V 8:00-12:00 COT).');

    // ────────────────────────────────────────────────────────────────────────
    // Cadencia de recordatorios de cobro por WhatsApp (plantillas aprobadas,
    // solo opt-in): días -3/-1/0/+3/+10/+20 respecto al vencimiento. L-V 8:00
    // COT; el servicio salta festivos, espera al estado de cuenta del mes y
    // garantiza en la base 1 contacto por familia y día entre los tres BFF.
    // Se registra DESPUÉS del estado de cuenta: en el mismo minuto, node-cron
    // dispara en orden de registro.
    // Activación por escuela: charge_notifications_enabled AND
    // whatsapp_collection_reminders_enabled. Kill-switch de este proceso:
    // DISABLE_RECORDATORIOS_COBRO_WHATSAPP=true.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('0 8 * * 1-5', async () => {
        if (process.env.DISABLE_RECORDATORIOS_COBRO_WHATSAPP === 'true') return;
        try {
            await runRecordatoriosCobro();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en recordatorios de cobro por WhatsApp:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Recordatorios de cobro por WhatsApp registrados (L-V 8:00 COT).');

    // ────────────────────────────────────────────────────────────────────────
    // Ciclo diario del Informe Mensual (F5): genera borradores, publica lo que
    // vence hoy y envía lo publicado sin marcar sent_at. Kill-switch por env
    // mientras se prueba en una escuela piloto.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('10 6 * * *', async () => {
        if (process.env.DISABLE_ATHLETE_REPORTS_CRON === 'true') return;
        try {
            await runAthleteReportsCycle();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en ciclo de informes:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Ciclo de informes registrado para las 06:10 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Ciclo diario del Informe GRUPAL (de equipo) de Evaluación
    // Post-Entrenamiento (F4 segunda mitad): genera borradores y publica los
    // que ya cumplieron su día de envío (misma cadencia que el informe
    // individual de arriba — report_team_schedule.send_day /
    // reports_default_send_day). Sin paso de envío: el informe de equipo no
    // se manda a familias (spec §7 abierta #1), solo lo ven coach/admin. Va
    // justo después del ciclo individual para que salgan como "el mismo
    // informe mensual". Mismo kill-switch de env mientras se prueba.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('12 6 * * *', async () => {
        if (process.env.DISABLE_ATHLETE_REPORTS_CRON === 'true') return;
        try {
            await runTeamReportsCycle();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en ciclo de informes de equipo:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Ciclo de informes de equipo registrado para las 06:12 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Evaluación Post-Entrenamiento (F2) — recordatorios.
    // El disparo del aviso original NO va acá: es un trigger SQL sobre
    // attendance_sessions.finalized (post_training_notify_on_finalize). Esto
    // es solo el recordatorio único a las 20h para el padre que no respondió, y
    // el aviso al coach con una sesión sin cerrar — ambos idempotentes en SQL.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('0 20 * * *', async () => {
        if (process.env.DISABLE_POST_TRAINING_REMINDERS_CRON === 'true') return;
        try {
            await runPostTrainingReminders();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en recordatorios de post-entrenamiento:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Recordatorios de post-entrenamiento registrados para las 20:00 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Despachador unificado (F1) — red de seguridad. Drena el outbox
    // notification_deliveries cada minuto: cubre fallos de pg_net, BFF caído,
    // reintentos con backoff y crashes entre claim y envío (lease expira).
    // No-op si NOTIF_DISPATCH_ENABLED != 'true'. Claim por lease (idempotente).
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('* * * * *', async () => {
        try {
            await runNotificationDispatch();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en despacho de notificaciones:', err?.message || err);
        }
    });

    console.log('[CRON] Despachador de notificaciones registrado (cada minuto).');

    // ────────────────────────────────────────────────────────────────────────
    // Cola de comprobantes de WhatsApp — cada minuto.
    //
    // El webhook solo encola (procesar ahí no es opción: el OCR tarda segundos
    // y Meta reintenta si no respondemos rápido). Este job baja el archivo, lo
    // guarda en el bucket ANTES de leerlo, extrae y aplica al pago.
    //
    // El claim es una RPC con lease y SKIP LOCKED, así que dos instancias del
    // BFF no se pisan. Kill-switch por env para poder apagarlo sin redeploy si
    // el proveedor de OCR se cae.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('* * * * *', async () => {
        if (process.env.DISABLE_WHATSAPP_QUEUE_CRON === 'true') return;
        try {
            const r = await runWhatsAppQueue();
            if (r.tomadas > 0) {
                console.log(`[CRON] Cola de WhatsApp: ${r.tomadas} tomada(s), ${r.errores} con error.`);
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en la cola de comprobantes de WhatsApp:', err?.message || err);
        }
    });

    console.log('[CRON] Cola de comprobantes de WhatsApp registrada (cada minuto).');

    // Turnos del bot que se perdieron en un reinicio (A-01): los relanza. Mismo
    // interruptor que la cola: solo el BFF que recibe el webhook (prod).
    cron.schedule('* * * * *', async () => {
        if (process.env.DISABLE_WHATSAPP_QUEUE_CRON === 'true') return;
        try {
            const { barrerTurnosPendientes } = await import('../services/whatsapp-turnos-pendientes.service');
            const r = await barrerTurnosPendientes();
            if (r.relanzados || r.descartados) {
                console.log(`[CRON] WhatsApp: ${r.relanzados} turno(s) relanzado(s), ${r.descartados} descartado(s) por viejos.`);
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error relanzando turnos de WhatsApp:', err?.message || err);
        }
    });

    // Seguimiento de ~20 h al interesado que dejó de escribir (ventana abierta,
    // sin plantilla). Mismo interruptor: solo prod. De 8 a 20 h lo filtra el job.
    cron.schedule('7,22,37,52 * * * *', async () => {
        if (process.env.DISABLE_WHATSAPP_QUEUE_CRON === 'true') return;
        try {
            const { runSeguimientoProspectos20h } = await import('../services/whatsapp-prospecto-seguimiento.service');
            const r = await runSeguimientoProspectos20h();
            if (r.enviados || r.fallidos) {
                console.log(`[CRON] WhatsApp: seguimiento 20 h — ${r.enviados} enviado(s), ${r.fallidos} con error.`);
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el seguimiento de 20 h de prospectos:', err?.message || err);
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    // El desenlace del comprobante vuelve al chat donde entró.
    //
    // El bot promete "la escuela lo está revisando y te confirma"; al aprobar
    // salía correo y notificación in-app, pero por WhatsApp nada. Va como job y
    // no enganchado al botón porque hay mas de un camino de aprobación en la
    // app y enganchar uno dejaria el otro mudo.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('* * * * *', async () => {
        if (process.env.DISABLE_WHATSAPP_QUEUE_CRON === 'true') return;
        try {
            const r = await runWhatsAppPaymentOutcome();
            if (r.avisados > 0) console.log(`[CRON] WhatsApp: ${r.avisados} desenlace(s) avisado(s).`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error avisando el desenlace de comprobantes:', err?.message || err);
        }
    });

    console.log('[CRON] Aviso de desenlace de comprobantes registrado (cada minuto).');

    // ────────────────────────────────────────────────────────────────────────
    // Comprobantes por validar → dueño y admins de la escuela — cada 5 min.
    //
    // p50 3,7 h y p90 49 h de la foto a la aprobación (Dynasty, 2026-10-08):
    // nadie le avisaba a la escuela que había algo esperando. In-app + push:
    // «comprobante nuevo» agrupado y recordatorio de >2 h (máx. 1 cada 2 h),
    // nada entre 22:00 y 07:00. Idempotente entre los 3 BFF por versión en
    // school_receipt_review_alerts. NO aprueba nada.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/5 * * * *', async () => {
        if (process.env.DISABLE_RECEIPT_REVIEW_ALERTS === 'true') return;
        try {
            const r = await runReceiptReviewAlerts();
            if (r.avisos > 0) console.log(`[CRON] Comprobantes por validar: ${r.avisos} aviso(s) a escuelas.`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error avisando comprobantes por validar:', err?.message || err);
        }
    });

    console.log('[CRON] Avisos de comprobantes por validar registrados (cada 5 min).');

    // ────────────────────────────────────────────────────────────────────────
    // Bienvenida a escuelas y entrenadores nuevos — cada 10 min.
    //
    // Antes la mandaba el navegador y solo en el registro con correo y rol
    // 'school': con Google o como entrenador personal no salía (2026-10-26).
    // Correo al dueño + aviso interno a contacto@. Idempotente entre los 3 BFF
    // por la reserva en email_sends. Kill-switch: DISABLE_BIENVENIDA_ESCUELAS.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/10 * * * *', async () => {
        if (process.env.DISABLE_BIENVENIDA_ESCUELAS === 'true') return;
        try {
            const r = await runBienvenidaEscuelas();
            if (r.enviadas || r.fallos) console.log(`[CRON] Bienvenidas: ${r.enviadas} enviada(s), ${r.fallos} fallida(s).`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error enviando bienvenidas:', err?.message || err);
        }
    });

    console.log('[CRON] Bienvenida a escuelas nuevas registrada (cada 10 min).');

    // ────────────────────────────────────────────────────────────────────────
    // Plazo de la promesa del acuse (P1, análisis 2026-10-06) — cada 2 min.
    //
    // El 06-oct, 15 adjuntos de familias quedaron `pending` una hora sin que
    // nadie se enterara (primero sin worker, después con el OCR fallando).
    // Este job avisa (log + Sentry) desde los 5 min y a los 10 min pasa el caso
    // a la escuela (buzón + push + correo) y le escribe UNA vez a la familia.
    //
    // Kill-switch PROPIO, a propósito: si se apaga la cola con
    // DISABLE_WHATSAPP_QUEUE_CRON, este es el que tiene que seguir avisando.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/2 * * * *', async () => {
        if (process.env.DISABLE_WHATSAPP_COLA_VENCIMIENTO === 'true') return;
        try {
            const r = await vencerComprobantesColgados();
            if (r.alerta > 0) {
                const msg = `[wa-vencimiento] ${r.alerta} adjunto(s) de WhatsApp sin desenlace hace más de 5 min `
                    + `(el más viejo: ${r.masVieja}); ${r.vencidas} pasado(s) a la escuela, ${r.avisadas} familia(s) avisada(s).`
                    + (process.env.DISABLE_WHATSAPP_QUEUE_CRON === 'true' ? ' OJO: la cola está apagada (DISABLE_WHATSAPP_QUEUE_CRON).' : '');
                console.warn(msg);
                Sentry.captureMessage(msg, 'warning');
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el vencimiento de comprobantes de WhatsApp:', err?.message || err);
        }
    });

    console.log('[CRON] Vencimiento de comprobantes de WhatsApp registrado (cada 2 min).');

    // ────────────────────────────────────────────────────────────────────────
    // Buzón de WhatsApp (Fase A) — cada 15 min.
    //
    // Conversaciones 'open' sin actividad hace 48 h → 'closed', y borradores
    // 'pending' de más de 24 h → 'expired' (la ventana de Meta ya cerró, no se
    // pueden enviar como texto libre). Dynasty llegó a 55 conversaciones todas
    // 'open' y 316 borradores colgados el 2026-10-03. Idempotente y en lotes.
    // Mismo kill-switch que la cola de WhatsApp.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/15 * * * *', async () => {
        if (process.env.DISABLE_WHATSAPP_QUEUE_CRON === 'true') return;
        try {
            await runWhatsAppMantenimiento();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el mantenimiento del buzón de WhatsApp:', err?.message || err);
        }
    });

    console.log('[CRON] Mantenimiento del buzón de WhatsApp registrado (cada 15 min).');

    // ────────────────────────────────────────────────────────────────────────
    // Estado de las plantillas de Meta por WABA — cada 30 min.
    //
    // La cobranza por WhatsApp solo usa plantillas APPROVED de la WABA de esa
    // escuela. El webhook de status no trajo ningún evento de la WABA de
    // Dynasty (2026-10-04), así que el sync es la fuente confiable.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/30 * * * *', async () => {
        if (process.env.DISABLE_WHATSAPP_QUEUE_CRON === 'true') return;
        try {
            await runWhatsAppPlantillasSync();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error sincronizando plantillas de WhatsApp:', err?.message || err);
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    // Resumen diario de WhatsApp por correo — 07:00 COT.
    //
    // El push del escalamiento no se ve ("no me entero", 2026-10-04). Cada
    // mañana, a owner + admins de cada escuela con WhatsApp conectado: familias
    // sin responder, comprobantes que quedaron para la escuela y prospectos de
    // las últimas 24 h. Si no hay nada, no se manda.
    //
    // Los tres BFF (dev/stg/prod) comparten la base y los tres disparan este
    // cron: la idempotencia está en `email_sends` (id determinístico por
    // escuela + fecha), no en memoria. Kill-switch: DISABLE_WHATSAPP_RESUMEN_CORREO.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('0 7 * * *', async () => {
        if (process.env.DISABLE_WHATSAPP_RESUMEN_CORREO === 'true') return;
        try {
            const r = await runWhatsAppResumenDiario();
            if (r.enviados > 0) console.log(`[CRON] Resumen diario de WhatsApp: ${r.enviados} de ${r.escuelas} escuela(s).`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el resumen diario de WhatsApp:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Resumen diario de WhatsApp por correo registrado para las 07:00 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Resumen semanal de los bots a SportMaps — lunes 07:05 COT (5 min después
    // del diario para no pedir las mismas tablas en el mismo minuto). WhatsApp
    // por escuela + tickets de Mapi de la semana anterior. Misma
    // idempotencia en base. Kill-switch: DISABLE_BOT_RESUMEN_SEMANAL_CORREO.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('5 7 * * 1', async () => {
        if (process.env.DISABLE_BOT_RESUMEN_SEMANAL_CORREO === 'true') return;
        try {
            const r = await runBotResumenSemanal();
            console.log(`[CRON] Resumen semanal de los bots: ${r}.`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el resumen semanal de los bots:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Resumen semanal de los bots registrado para los lunes 07:05 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Informe de CALIDAD Y COSTO del bot a SportMaps — lunes 08:00 COT, con
    // ticks hasta las 11:00 para recoger un BFF dormido o reiniciado. Por
    // escuela con WhatsApp: resolución bot/escuela/sin respuesta, escalaciones,
    // errores, comprobantes, cortesías, opt-ins y costo (llm_usage). Uno por
    // semana entre los tres BFF (email_sends, clave por lunes). Destino:
    // BOT_REPORT_EMAIL o SUPPORT_ALERT_EMAIL. Kill-switch: DISABLE_INFORME_CALIDAD_BOT.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('0 8-11 * * 1', async () => {
        if (process.env.DISABLE_INFORME_CALIDAD_BOT === 'true') return;
        try {
            const r = await runInformeCalidadBotSemanal();
            if (r !== 'duplicado') console.log(`[CRON] Informe de calidad del bot: ${r}.`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el informe de calidad del bot:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Informe de calidad del bot registrado para los lunes 08:00 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Informe de CARTERA semanal a owner + admins — lunes 07:10 COT, con ticks
    // hasta las 11:10 para recoger un BFF dormido o reiniciado. Morosos,
    // pendientes del mes, comprobantes en revisión, inactivos y bajas con
    // saldo. Activo por escuela con school_settings.cartera_report_enabled (NULL
    // = automático: solo si auto_cancel_overdue_enabled = false). Uno por
    // escuela y semana entre los tres BFF (email_sends, id determinístico).
    // Kill-switch: DISABLE_INFORME_CARTERA=true.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('10 7-11 * * 1', async () => {
        if (process.env.DISABLE_INFORME_CARTERA === 'true') return;
        try {
            const r = await runInformeCarteraSemanal();
            const enviados = Object.values(r).filter((x) => x === 'enviado').length;
            if (enviados > 0) console.log(`[CRON] Informe de cartera: ${enviados} de ${Object.keys(r).length} escuela(s).`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el informe de cartera semanal:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Informe de cartera semanal registrado para los lunes 07:10 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Banco de horas por torniquete (F5) — auto-cierre de visitas 'open'.
    // Factura apenas se sepa la hora real de salida y pase la ventana de
    // reentrada sin volver (fix 2026-09-05); para quien nunca marcó salida,
    // sigue el cutoff largo (hora de cierre / tope de horas) + pending_review.
    //
    // Cada 1 minuto (bajado de 15, mismo día del fix): no se puede facturar
    // exactamente en el instante de la salida sin romper D-6 (una reentrada
    // corta — "voy al baño" — tiene que fusionarse en la misma visita, no
    // verse como dos), así que el retraso real sigue siendo al menos la
    // ventana de gracia de la escuela (15 min en Dreamers) — pero antes se le
    // sumaban hasta 15 min más por esperar el tick del cron (caso real: Edna,
    // 2026-09-05, tocó dispararlo a mano). A 1 min, el cron deja de ser la
    // parte lenta. Costo despreciable: la query solo mira escuelas con
    // hours_plan_enabled=true (2 hoy) y visitas 'open' (siempre pocas).
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('* * * * *', async () => {
        try {
            await runHourBankAutoclose();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en auto-cierre de banco de horas:', err?.message || err);
        }
    });

    console.log('[CRON] Auto-cierre de banco de horas registrado (cada 1 min).');

    // ────────────────────────────────────────────────────────────────────────
    // Cargo por horas de más del banco de horas (F-E, migración 20261005214302).
    // Genera sugerencias 'suggested' para periodos cerrados con excedente; el
    // owner confirma o descarta. Nunca crea cobros. No-op para toda escuela con
    // school_settings.hour_bank_overage_charges_enabled = false (default).
    // 03:00 COT: después del auto-cierre nocturno de visitas y lejos de open_month.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('0 3 * * *', async () => {
        try {
            await runHourBankOverageSuggestions();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error generando cargos por horas de más:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Cargos por horas de más del banco de horas registrado para las 03:00 COT.');

    // Confirmación AUTOMÁTICA de excedentes bajo tope (08:00 COT, para que la familia reciba el aviso
    // del cobro de día). Solo escuelas con al menos un tope definido (default NULL = apagado); lo que
    // supere un tope, las inscripciones no activas y lo del dueño siguen `suggested` para decidir a mano.
    cron.schedule('0 8 * * *', async () => {
        try {
            await runHourBankOverageAutoConfirm();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en la confirmación automática de excedentes:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Confirmación automática de excedentes de horas registrada para las 08:00 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Bloqueo automático por mora (school_settings.access_auto_block_overdue_enabled,
    // migración 20260905111458). Reconcilia contra payments.status='overdue' —
    // bloquea (Grp=2) a quien debe y no está bloqueado, desbloquea (Grp=1) a
    // quien ya no debe. Deliberadamente NO usa enrollments.expires_at (hereda
    // dos bugs conocidos de vigencia, ver el comentario del job). No-op para
    // toda escuela con el flag en false (default). Piloto: Dreamers Gymnastics.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/15 * * * *', async () => {
        try {
            await runAccessAutoBlockCycle();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en bloqueo automático por mora:', err?.message || err);
        }
    });

    console.log('[CRON] Bloqueo automático por mora registrado (cada 15 min).');

    // ────────────────────────────────────────────────────────────────────────
    // Avisos de saldo del banco de horas (escalera 50/20/10/0 %, push + correo).
    // Plan: docs/specs/dreamers-horas-agotadas-bloqueo-y-excedentes-automaticos.md §2.1.
    // No-op para toda escuela sin escalones configurados (default '{}') y mientras la
    // migración 20261023194135 no esté aplicada. Solo manda de 8:00 a 19:59 hora Colombia.
    // Nunca cobra ni bloquea nada.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/15 * * * *', async () => {
        try {
            await runHourBankBalanceNotices();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en avisos de saldo de horas:', err?.message || err);
        }
    });

    console.log('[CRON] Avisos de saldo de horas registrados (cada 15 min).');

    // ────────────────────────────────────────────────────────────────────────
    // Ciclo diario de facturación SaaS SportMaps → escuelas (Fase 1). Llama a
    // run_saas_billing_cycle() (flip a overdue + avanza período + genera la
    // próxima factura + calcula recordatorios de 3 etapas) y por cada fila
    // manda el email/PDF vía sendSaasInvoice. 09:20 COT: a las 06:20 el push de
    // «Factura SportMaps vencida» despertaba a la dueña todos los días
    // (2026-10-29); sigue lejos del cron SQL de mensualidades (06:30 UTC).
    // Kill-switch: DISABLE_SAAS_BILLING_CRON=true.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('20 9 * * *', async () => {
        if (process.env.DISABLE_SAAS_BILLING_CRON === 'true') return;
        try {
            await runSaasBillingCycle();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en ciclo de facturación SaaS:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Ciclo de facturación SaaS registrado para las 09:20 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Chequeo de latido de bridges locales (ej. scripts/gymrm-door-bridge/).
    // Cada sondeo exitoso a GET /bridge/door-commands sella bridge_heartbeats
    // (ver bridge.routes.ts); si un bridge lleva 10+ min sin sondear, avisa al
    // owner una sola vez por caída. Sin owner_id en la escuela, no hay a quién
    // avisar -- se sella igual para no reintentar cada corrida.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/5 * * * *', async () => {
        try {
            await runBridgeHeartbeatCheck();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en chequeo de latido de bridges:', err?.message || err);
        }
    });

    console.log('[CRON] Chequeo de latido de bridges registrado (cada 5 min).');

    // ────────────────────────────────────────────────────────────────────────
    // Borrado físico de cuentas (Ley 1581/2012 derecho de supresión + Apple
    // Guideline 5.1.1(v) / Google Play). request_account_deletion() programa
    // el borrado a 30 días; este job ejecuta lo que quedó pendiente:
    // anonimiza `profiles` y banea el login (nunca auth.admin.deleteUser —
    // cascadearía sobre tablas de la escuela que dependen del profile_id).
    // Kill-switch: DISABLE_ACCOUNT_DELETION_CRON=true.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('30 6 * * *', async () => {
        if (process.env.DISABLE_ACCOUNT_DELETION_CRON === 'true') return;
        try {
            await runAccountDeletionCycle();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en borrado físico de cuentas:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Borrado físico de cuentas registrado para las 06:30 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Terminó la semana de cortesía (escuelas con school_settings.cortesia_unica):
    // avisa a la administración, UNA vez por inscripción, de quien sigue sin plan
    // ni cuota. Solo informa: no cancela ni cobra. 08:30 COT.
    // Kill-switch: DISABLE_CORTESIA_VENCIDA_CRON=true.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('30 8 * * *', async () => {
        if (process.env.DISABLE_CORTESIA_VENCIDA_CRON === 'true') return;
        try {
            await runCortesiaVencida();
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en aviso de cortesías vencidas:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Aviso de cortesías vencidas registrado para las 08:30 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Franjas de clase de cortesía desde los entrenamientos (teams.schedule).
    // Mantiene una ventana rodante de 3 semanas en las escuelas con
    // school_settings.courtesy_from_training = true: cada día entra el día
    // nuevo del final y se cierran (sin borrar) las franjas generadas que ya
    // no corresponden al horario, si no tienen reservas. 05:30 COT: antes de
    // que las familias escriban y antes de los demás ciclos de la mañana.
    // Corre en los 3 BFF a la vez: idempotente por el índice único
    // (team_id, slot_date, start_time) de la migración 20261006084303.
    // Kill-switch: DISABLE_FRANJAS_CORTESIA=true.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('30 5 * * *', async () => {
        if (process.env.DISABLE_FRANJAS_CORTESIA === 'true') return;
        try {
            const r = await runFranjasCortesia();
            console.log(`[CRON] Franjas de cortesía: ${r.escuelas} escuela(s), ${r.creadas} creada(s), ${r.cerradas} cerrada(s), ${r.errores} error(es).`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error generando franjas de cortesía:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Franjas de cortesía registradas para las 05:30 COT.');

    // ────────────────────────────────────────────────────────────────────────
    // Ventas por WhatsApp, carril B — cada 5 min.
    //
    // Un cobro suelto (clase extra, vacacional, torneo, viaje) que la familia
    // pidió por el chat y no pagó en la hora (+15 min de margen) pasa a
    // 'cancelled' con motivo venta_whatsapp_vencida y libera su cupo. Si no, la
    // cobranza lo perseguiría como deuda que la familia nunca contrajo. Solo
    // toca lo que creó wa_crear_cobro_suelto (tabla wa_cobros_sueltos), nunca
    // un cobro con comprobante en revisión. Idempotente y con SKIP LOCKED:
    // seguro en los 3 BFF. Spec docs/specs/ventas-por-whatsapp.md §16.3.
    // Kill-switch: DISABLE_VENTAS_ANULAR_VENCIDOS=true.
    // ────────────────────────────────────────────────────────────────────────
    let ventasMigracionAvisada = false;
    cron.schedule('*/5 * * * *', async () => {
        if (process.env.DISABLE_VENTAS_ANULAR_VENCIDOS === 'true') return;
        try {
            const r = await anularCobrosSueltosVencidos();
            if (r.migracionPendiente) {
                if (!ventasMigracionAvisada) {
                    ventasMigracionAvisada = true;
                    console.log('[CRON] Ventas WhatsApp: la migración 20261007095911 no está aplicada; el job no hace nada.');
                }
                return;
            }
            if (r.anulados > 0) {
                console.log(`[CRON] Ventas WhatsApp: ${r.anulados} cobro(s) suelto(s) vencido(s) anulado(s).`);
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error anulando cobros sueltos vencidos:', err?.message || err);
        }
    });

    console.log('[CRON] Anulación de cobros sueltos vencidos (ventas WhatsApp) registrada (cada 5 min).');

    // ────────────────────────────────────────────────────────────────────────
    // Recordatorio de la clase de cortesía por WhatsApp (recordatorio-cortesia.service).
    //  · Víspera, 18:00 COT: plantilla UTILITY `recordatorio_clase_cortesia`
    //    (texto si la ventana de 24 h sigue abierta).
    //  · Mismo día, cada 15 min de 7:00 a 19:45 COT: texto ~3 h antes, SOLO
    //    con la ventana abierta; cerrada, nada.
    // «CANCELAR» en la respuesta libera el cupo (wa_cancelar_clase_de_prueba).
    // Corre en los 3 BFF: idempotente por school_trial_reminders (UNIQUE lead,
    // cupo, tipo; migración 20261007095845). Sin esa tabla no manda nada.
    // Kill-switch: DISABLE_RECORDATORIO_CORTESIA=true.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('0 18 * * *', async () => {
        if (process.env.DISABLE_RECORDATORIO_CORTESIA === 'true') return;
        try {
            const r = await runRecordatorioCortesia('vispera', { log: console });
            if (r.candidatas > 0 || r.sinTabla) {
                console.log(`[CRON] Recordatorio de cortesía (víspera): ${r.candidatas} reserva(s), ${r.enviados} enviado(s), ${r.noEnviados} sin enviar, ${r.omitidos} omitida(s)${r.sinTabla ? ' — FALTA la tabla school_trial_reminders' : ''}.`);
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el recordatorio de cortesía (víspera):', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    cron.schedule('*/15 7-19 * * *', async () => {
        if (process.env.DISABLE_RECORDATORIO_CORTESIA === 'true') return;
        try {
            const r = await runRecordatorioCortesia('mismo_dia', { log: console });
            if (r.enviados > 0 || r.noEnviados > 0) {
                console.log(`[CRON] Recordatorio de cortesía (mismo día): ${r.enviados} enviado(s), ${r.noEnviados} sin enviar.`);
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el recordatorio de cortesía (mismo día):', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Recordatorio de cortesía registrado (víspera 18:00 COT; mismo día cada 15 min 7:00-19:45 COT).');

    // ────────────────────────────────────────────────────────────────────────
    // Ciclo de la clase de cortesía (prospecto-ciclo-clase.service, embudo
    // 2026-10-08):
    //  · 20:00-21:45 COT cada 15 min: «¿Cómo le fue?» + enlace de inscripción
    //    a las reservas de HOY ya terminadas, SOLO con la ventana de 24 h
    //    abierta. Uno por reserva entre los 3 BFF (UPDATE condicional sobre
    //    source_detail.seguimiento_clase_at).
    //  · 21:30 COT: leads de WhatsApp con inscripción nueva (mismo teléfono o
    //    correo) → «inscrito» (status converted). Idempotente.
    // Kill-switch: DISABLE_SEGUIMIENTO_CLASE_CORTESIA=true.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/15 20-21 * * *', async () => {
        if (process.env.DISABLE_SEGUIMIENTO_CLASE_CORTESIA === 'true') return;
        try {
            const r = await runSeguimientoNocheCortesia();
            if (r.enviados > 0 || r.fallidos > 0) {
                console.log(`[CRON] Seguimiento de la clase de cortesía: ${r.enviados} enviado(s), ${r.fallidos} fallido(s), ${r.omitidos} omitido(s).`);
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el seguimiento de la clase de cortesía:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    cron.schedule('30 21 * * *', async () => {
        if (process.env.DISABLE_SEGUIMIENTO_CLASE_CORTESIA === 'true') return;
        try {
            const n = await detectarInscripcionesDeLeads();
            if (n > 0) console.log(`[CRON] Leads de WhatsApp inscritos: ${n}.`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el cruce de leads con inscripciones:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Ciclo de la clase de cortesía registrado (seguimiento 20:00-21:45 COT; cruce de inscripciones 21:30 COT).');

    // ────────────────────────────────────────────────────────────────────────
    // Clase de prueba del embudo (B2/B3, Monster 2026-10-30) — cada 15 min:
    //  · cupos separados: a las ~22 h «tu cupo vence en 2 h» (ventana abierta o
    //    plantilla) y a las `separar_horas` se libera con aviso a la escuela; si
    //    ya hay pago, confirma en vez de soltar. Una sola RPC por lote.
    //  · clases reprogramadas: red de seguridad del aviso de «Mi semana» (sesión
    //    cancelada o movida en las últimas 48 h → «clase reprogramada»).
    // Las dos escriben por WhatsApp: solo el BFF de la cola (prod). Idempotentes
    // entre los 3 BFF por marcas en source_detail del lead. Sin escuelas con
    // embudo o sin la migración M1, no hacen nada. Kill-switch propio de los
    // cupos: DISABLE_CUPOS_SEPARADOS=true.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/15 * * * *', async () => {
        if (process.env.DISABLE_WHATSAPP_QUEUE_CRON === 'true') return;
        try {
            const { runCuposSeparados, runClasesReprogramadas } = await import('../services/clase-prueba-agenda.service');
            const c = await runCuposSeparados();
            if (c.avisados || c.liberados || c.confirmados || c.errores) {
                console.log(`[CRON] Clase de prueba: ${c.avisados} aviso(s) de cupo por vencer, ${c.liberados} liberado(s), ${c.confirmados} confirmado(s), ${c.errores} error(es).`);
            }
            const r = await runClasesReprogramadas();
            if (r.avisos) console.log(`[CRON] Clase de prueba: ${r.avisos} aviso(s) de clase reprogramada en ${r.escuelas} escuela(s).`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en los cupos de la clase de prueba:', err?.message || err);
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    // Campañas de WhatsApp (plan B5) — cada 10 min. Sin campañas aprobadas o
    // enviando, una sola lectura a una tabla chica (cero IO para las demás
    // escuelas). Horario, tope diario, piloto, cupo de Meta y freno por calidad
    // los decide el motor. Mismo interruptor que la cola: solo prod.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('*/10 * * * *', async () => {
        if (process.env.DISABLE_WHATSAPP_QUEUE_CRON === 'true') return;
        try {
            const { runCampanas } = await import('../services/whatsapp-campanas.service');
            const r = await runCampanas();
            if (r.enviados || r.fallidos || r.pausadas || r.terminadas) {
                console.log(`[CRON] Campañas de WhatsApp: ${r.enviados} enviado(s), ${r.fallidos} fallido(s), ${r.pausadas} pausada(s), ${r.terminadas} terminada(s).`);
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en las campañas de WhatsApp:', err?.message || err);
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    // «Sigue en fila» (B6) — cada 15 min, lun–sáb en horario hábil. A quien el
    // bot pasó a una persona y la escuela no le ha contestado en 2 h hábiles
    // (lun–sáb 8:00–18:00 Bogotá) se le confirma UNA vez que su mensaje sigue en
    // fila. Solo escuelas con `wa_temas_a_persona` configurado (Dynasty no
    // cambia). Escribe por WhatsApp: solo prod.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('5,20,35,50 8-18 * * 1-6', async () => {
        if (process.env.DISABLE_WHATSAPP_QUEUE_CRON === 'true') return;
        try {
            const { runSigueEnFila } = await import('../services/whatsapp-sigue-en-fila.service');
            const r = await runSigueEnFila();
            if (r.avisados || r.errores) console.log(`[CRON] WhatsApp «sigue en fila»: ${r.avisados} aviso(s), ${r.errores} error(es).`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el aviso «sigue en fila»:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    // ────────────────────────────────────────────────────────────────────────
    // Detector de cambio de plan: la familia paga el valor de otro plan sin avisar.
    // Cambia el plan solo con dos periodos seguidos al mismo valor de UN único plan;
    // si no, avisa a la dueña una vez. Solo para las escuelas de
    // PLAN_CHANGE_AUTO_SCHOOL_IDS (vacía = no hace nada). Kill-switch:
    // DISABLE_PLAN_CHANGE_DETECTOR=true.
    // ────────────────────────────────────────────────────────────────────────
    cron.schedule('20 9 * * *', async () => {
        if (process.env.DISABLE_PLAN_CHANGE_DETECTOR === 'true') return;
        try {
            const r = await runPlanChangeDetector();
            if (r.cambiados > 0 || r.avisados > 0 || r.errores > 0) {
                console.log(`[CRON] Cambio de plan: revisados=${r.revisados} cambiados=${r.cambiados} avisados=${r.avisados} errores=${r.errores}`);
            }
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en el detector de cambio de plan:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });

    console.log('[CRON] Detector de cambio de plan registrado (09:20 COT, solo escuelas de PLAN_CHANGE_AUTO_SCHOOL_IDS).');
}
