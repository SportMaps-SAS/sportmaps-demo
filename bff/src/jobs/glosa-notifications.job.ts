/**
 * glosa-notifications.job — correos de glosa que el cron SQL no puede mandar.
 *
 * Dos eventos, ambos por EMAIL (además de la notif in-app):
 *   1. "Vence mañana": recordatorio antes de que el plazo se cierre (última
 *      oportunidad de réplica del acudiente).
 *   2. Ratificación automática: el plazo venció y el cobro se reactivó — el papá
 *      que no abre la app debe enterarse.
 *
 * Idempotencia por CLAIM ATÓMICO (UPDATE ... RETURNING sobre una marca *_sent_at),
 * igual patrón que el autopay/reproceso: dos réplicas del BFF no duplican el correo.
 * La transición de estado de ratificación la hace el pg_cron `ratify_expired_glosas`
 * de Fase 3 (robusta aunque el BFF esté caído); aquí solo se agregan los correos.
 */

import { supabase } from '../config/supabase';
import { emailClient } from '../utils/emailClient';
import { BrandedEmailTemplates } from '../utils/emailTemplates';
import { destinatarioDelCobro } from '../utils/destinatarioDelCobro';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.sportmaps.co';
const fmtCop = (n?: number | null) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

/** Fecha (yyyy-mm-dd) en America/Bogota, desplazada `days` días desde hoy. */
function bogotaDate(days: number): string {
    const d = new Date(Date.now() + days * 86400000);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
}

const REMINDER_SELECT =
    'id, school_id, responds_by, payments!inner(parent_id, user_id, concept, ' +
    'parent:profiles!payments_parent_id_fkey(full_name, email), ' +
    'owner:profiles!payments_user_id_fkey(full_name, email))';
const RATIFY_SELECT =
    'id, school_id, payments!inner(parent_id, user_id, concept, amount, ' +
    'parent:profiles!payments_parent_id_fkey(full_name, email), ' +
    'owner:profiles!payments_user_id_fkey(full_name, email))';

export async function runGlosaNotifications(): Promise<{ reminders: number; ratifyEmails: number }> {
    const nowIso = new Date().toISOString();
    let reminders = 0;
    let ratifyEmails = 0;

    // 1) Recordatorio "vence mañana" (claim atómico: stamp reminder_sent_at).
    try {
        const tomorrow = bogotaDate(1);
        const { data, error } = await supabase
            .from('payment_glosas')
            .update({ reminder_sent_at: nowIso })
            .eq('status', 'GLOSADA')
            .eq('responds_by', tomorrow)
            .is('reminder_sent_at', null)
            .select(REMINDER_SELECT);
        if (error) throw error;
        for (const g of (data ?? []) as any[]) {
            const p = g.payments;
            // Sin acudiente, al adulto titular del cobro (user_id).
            const dest = p?.parent_id ? p.parent : p?.owner;
            const destId = destinatarioDelCobro(p);
            // notif in-app
            if (destId) {
                await supabase.from('notifications').insert({
                    user_id: destId, school_id: g.school_id, type: 'glosa',
                    title: 'Tu aclaración vence mañana',
                    message: 'Es la última oportunidad para aclarar tu comprobante antes de que el plazo se cierre.',
                    link: '/my-payments',
                });
            }
            // email
            if (dest?.email) {
                const tpl = await BrandedEmailTemplates.glosaVenceManana({
                    parentName: dest.full_name || 'Acudiente',
                    concept: p.concept || 'tu pago',
                    respondsBy: g.responds_by,
                    link: `${FRONTEND_URL}/my-payments`,
                    schoolId: g.school_id,
                });
                emailClient.send({ to: dest.email, subject: tpl.subject, html: tpl.html })
                    .catch((e: unknown) => console.warn('[glosa-cron] email recordatorio falló', { glosaId: g.id, e }));
                reminders++;
            }
        }
    } catch (err: any) {
        console.error('[glosa-cron] recordatorio falló:', err?.message || err);
    }

    // 2) Correo de ratificación automática (resolved_by NULL = ratificada por el cron).
    try {
        const { data, error } = await supabase
            .from('payment_glosas')
            .update({ ratify_email_sent_at: nowIso })
            .eq('status', 'RATIFICADA')
            .is('resolved_by', null)
            .is('ratify_email_sent_at', null)
            .select(RATIFY_SELECT);
        if (error) throw error;
        for (const g of (data ?? []) as any[]) {
            const p = g.payments;
            const dest = p?.parent_id ? p.parent : p?.owner;
            if (!dest?.email) continue;
            const tpl = await BrandedEmailTemplates.glosaRatificada({
                parentName: dest.full_name || 'Acudiente',
                concept: p.concept || 'tu pago',
                amount: fmtCop(p.amount),
                link: `${FRONTEND_URL}/my-payments`,
                schoolId: g.school_id,
                expired: true,
            });
            emailClient.send({ to: dest.email, subject: tpl.subject, html: tpl.html })
                .catch((e: unknown) => console.warn('[glosa-cron] email ratificación falló', { glosaId: g.id, e }));
            ratifyEmails++;
        }
    } catch (err: any) {
        console.error('[glosa-cron] correo de ratificación falló:', err?.message || err);
    }

    if (reminders > 0 || ratifyEmails > 0) {
        console.log(`[glosa-cron] recordatorios=${reminders} ratifyEmails=${ratifyEmails}`);
    }
    return { reminders, ratifyEmails };
}
