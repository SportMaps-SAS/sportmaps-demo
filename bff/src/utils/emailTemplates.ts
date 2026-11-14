// bff/src/utils/emailTemplates.ts
//
// Templates de email branded. Cada template:
//   1. Resuelve el branding de la escuela (resolveSchoolBranding) — aplica
//      feature gate por tier; free tier → defaults SportMaps.
//   2. Sanitiza variables del usuario (escapeHtml) para evitar HTML injection.
//   3. Construye HTML final via buildBrandedEmail (layout unificado).
//
// Los templates son async porque hacen un fetch a DB para el branding.
// Si no tenes schoolId, pasa null y se usan defaults SportMaps.
//
// Compatibilidad: existe `EmailTemplates` (export legacy SINCRONICO) para
// los callsites que ya usan el patron viejo. Esos seguiran funcionando
// pero sin branding personalizado. Migrar a `BrandedEmailTemplates` cuando
// se pueda.

import { resolveSchoolBranding, escapeHtml } from './schoolBrandingResolver';
import { buildBrandedEmail } from './emailLayout';

/**
 * Desglose de un cobro con mora (2026-10-14): apply_late_fees() suma el
 * recargo DENTRO de payments.amount, así que `amount` del correo ya es el
 * total; esto solo explica de dónde sale. `base` = total - recargo, ya
 * formateado como el resto de los montos (ver utils/desglose-mora).
 */
export interface DesgloseMoraCorreo {
    base: string;
    fee: string;
}

/** «Mensualidad $X · Recargo por mora $Y · Total $Z» (valores ya formateados). */
function lineaMora(amount: string, mora: DesgloseMoraCorreo | null | undefined, etiquetaBase = 'Mensualidad'): string {
    if (!mora) return '';
    return `${escapeHtml(etiquetaBase)} ${escapeHtml(mora.base)} · Recargo por mora ${escapeHtml(mora.fee)} · Total ${escapeHtml(amount)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// API moderna — async, con branding por escuela
// ─────────────────────────────────────────────────────────────────────────────
export const BrandedEmailTemplates = {
    /**
     * Invitacion a padre/madre para crear cuenta y vincular a un hijo
     * registrado por la escuela.
     */
    invitation: async (params: {
        parentName: string | null;
        childName: string;
        schoolId: string | null;  // si null → defaults SportMaps
        inviteLink: string;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        const safeParent = escapeHtml(params.parentName || 'Padre/Madre');
        const safeChild  = escapeHtml(params.childName);

        return {
            subject: `Invitación de ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: `¡Invitación de ${branding.schoolName}!`,
                greeting: `Hola ${safeParent},`,
                bodyHtml: `
                    <p>La escuela <strong>${branding.schoolName}</strong> ha registrado
                    a <strong>${safeChild}</strong> en su sistema.</p>
                    <p>Para ver el progreso, realizar pagos y recibir notificaciones,
                    acepta la invitación y completa tu registro.</p>
                `,
                cta: { label: 'Aceptar Invitación', url: params.inviteLink },
                closingHtml: `
                    <p>Si ya tienes cuenta en SportMaps, el deportista se asociará
                    automáticamente cuando inicies sesión con este correo.</p>
                `,
            }),
        };
    },

    /**
     * Confirmacion de pago aprobado.
     */
    paymentConfirmation: async (params: {
        parentName: string;
        amount: string;
        concept: string;
        receiptNumber: string;
        schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);

        return {
            subject: `Pago confirmado — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: '¡Pago Recibido!',
                greeting: `Hola ${escapeHtml(params.parentName)},`,
                bodyHtml: `
                    <p>Hemos recibido y validado tu pago exitosamente. Aquí están los detalles:</p>
                    <table cellpadding="0" cellspacing="0" border="0" width="100%"
                           style="background-color: #f3f4f6; border-radius: 8px; margin: 16px 0;">
                        <tr><td style="padding: 16px;">
                            <p style="margin: 4px 0;"><strong>Concepto:</strong> ${escapeHtml(params.concept)}</p>
                            <p style="margin: 4px 0;"><strong>Monto:</strong> ${escapeHtml(params.amount)}</p>
                            <p style="margin: 4px 0;"><strong>Referencia:</strong> ${escapeHtml(params.receiptNumber)}</p>
                            <p style="margin: 4px 0;"><strong>Estado:</strong>
                                <span style="color: #059669; font-weight: 600;">Aprobado</span></p>
                        </td></tr>
                    </table>
                `,
                closingHtml: 'Gracias por confiar en nosotros.',
            }),
        };
    },

    /**
     * Recordatorio de pago pendiente.
     */
    paymentReminder: async (params: {
        parentName: string;
        amount: string;
        childName: string;
        dueDate: string;
        paymentLink: string;
        schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);

        return {
            subject: `Recordatorio de pago — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Recordatorio de Pago',
                greeting: `Hola ${escapeHtml(params.parentName)},`,
                bodyHtml: `
                    <p>Te recordamos amablemente el pago pendiente para la mensualidad
                    de <strong>${escapeHtml(params.childName)}</strong>.</p>
                    <table cellpadding="0" cellspacing="0" border="0" width="100%"
                           style="background-color: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; margin: 16px 0;">
                        <tr><td style="padding: 16px;">
                            <p style="margin: 4px 0;"><strong>Monto a pagar:</strong> ${escapeHtml(params.amount)}</p>
                            <p style="margin: 4px 0;"><strong>Fecha límite:</strong> ${escapeHtml(params.dueDate)}</p>
                        </td></tr>
                    </table>
                `,
                cta: { label: 'Pagar Ahora', url: params.paymentLink },
                closingHtml: 'Si ya realizaste el pago, puedes omitir este mensaje.',
            }),
        };
    },

    /**
     * Aviso de cobro recién generado (apertura del mes — open_month). Distinto
     * de paymentReminder: este es informativo ("ya está disponible"), no un
     * reclamo por atraso.
     */
    chargeCreated: async (params: {
        parentName: string;
        amount: string;
        childName: string;
        concept: string;
        dueDate: string;
        paymentLink: string;
        schoolId: string | null;
        /**
         * Cobro ÚNICO (inscripción, seguro…): su etiqueta. Sin ella el texto
         * habla de «la mensualidad», que es lo que este aviso fue siempre.
         */
        chargeLabel?: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        const queCobro = params.chargeLabel
            ? `el cobro de <strong>${escapeHtml(params.chargeLabel)}</strong>`
            : 'la mensualidad';

        return {
            subject: `Nuevo cobro disponible — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Nuevo Cobro Disponible',
                greeting: `Hola ${escapeHtml(params.parentName)},`,
                bodyHtml: `
                    <p>Ya está disponible ${queCobro} de <strong>${escapeHtml(params.childName)}</strong>
                    en <strong>${branding.schoolName}</strong>.</p>
                    <table cellpadding="0" cellspacing="0" border="0" width="100%"
                           style="background-color: #f3f4f6; border-radius: 8px; margin: 16px 0;">
                        <tr><td style="padding: 16px;">
                            <p style="margin: 4px 0;"><strong>Concepto:</strong> ${escapeHtml(params.concept)}</p>
                            <p style="margin: 4px 0;"><strong>Monto:</strong> ${escapeHtml(params.amount)}</p>
                            <p style="margin: 4px 0;"><strong>Vence:</strong> ${escapeHtml(params.dueDate)}</p>
                        </td></tr>
                    </table>
                `,
                cta: { label: 'Pagar Ahora', url: params.paymentLink },
                closingHtml: 'Gracias por estar al día.',
            }),
        };
    },

    /**
     * Recordatorio de pago VENCIDO — se envía una vez pasan los días de gracia
     * (apply_late_fees ya marcó el pago 'overdue'). Distinto de paymentReminder,
     * que es el recordatorio in-app previo al vencimiento.
     */
    paymentOverdue: async (params: {
        parentName: string;
        amount: string;
        childName: string;
        dueDate: string;
        paymentLink: string;
        schoolId: string | null;
        /** Cobro ÚNICO (inscripción, seguro…): su etiqueta. Sin ella, «la mensualidad». */
        chargeLabel?: string | null;
        /** Concepto del cobro; si viene, se muestra en el recuadro. */
        concept?: string | null;
        /** Cobro con mora (late_fee_amount > 0): desglose bajo el monto. `amount` ya es el total. */
        lateFee?: DesgloseMoraCorreo | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        const queCobro = params.chargeLabel
            ? `del cobro de <strong>${escapeHtml(params.chargeLabel)}</strong>`
            : 'de la mensualidad';
        const lineaConcepto = params.concept
            ? `<p style="margin: 4px 0;"><strong>Concepto:</strong> ${escapeHtml(params.concept)}</p>`
            : '';
        const desglose = lineaMora(params.amount, params.lateFee, params.chargeLabel ? 'Valor del cobro' : 'Mensualidad');
        const lineaDesglose = desglose
            ? `<p style="margin: 4px 0; color: #991b1b; font-size: 13px;">${desglose}</p>`
            : '';

        return {
            subject: `Pago vencido — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Pago Vencido',
                greeting: `Hola ${escapeHtml(params.parentName)},`,
                bodyHtml: `
                    <p>El pago ${queCobro} de <strong>${escapeHtml(params.childName)}</strong>
                    en <strong>${branding.schoolName}</strong> ya pasó su fecha límite y sigue pendiente.</p>
                    <table cellpadding="0" cellspacing="0" border="0" width="100%"
                           style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; margin: 16px 0;">
                        <tr><td style="padding: 16px;">
                            ${lineaConcepto}
                            <p style="margin: 4px 0;"><strong>Monto a pagar:</strong> ${escapeHtml(params.amount)}</p>
                            ${lineaDesglose}
                            <p style="margin: 4px 0;"><strong>Venció el:</strong> ${escapeHtml(params.dueDate)}</p>
                        </td></tr>
                    </table>
                `,
                cta: { label: 'Pagar Ahora', url: params.paymentLink },
                closingHtml: 'Si ya realizaste el pago, puedes omitir este mensaje.',
            }),
        };
    },

    /**
     * Escalón de la cadencia de recordatorios de cobro por CORREO
     * (recordatorios-cobro.service): mismo momento y mismo tono que la
     * plantilla de WhatsApp del escalón. Uno por familia: si debe de varios
     * hijos, los nombra juntos con el total. Ley 2300: respetuoso, sin
     * amenazas; el botón abre /p/:token (paga sin iniciar sesión).
     * Con `cutoffDay` (school_settings.payment_cutoff_day) recuerda hasta qué
     * día del mes hay que estar al día.
     */
    recordatorioCobro: async (params: {
        concepto: 'recordatorio_previo' | 'vence_manana' | 'vence_hoy' | 'pendiente_suave' | 'pendiente_directo' | 'aviso_final';
        parentName: string;
        athletes: string;          // "Samuel" o "Samuel y Sofía"
        amount: string;
        period: string | null;     // "octubre 2026"
        dueDate: string;           // "10 de octubre"
        daysOverdue: number | null;
        paymentLink: string;
        schoolId: string | null;
        cutoffDay?: number | null; // 10 → "los primeros 10 días de cada mes"
        /** Política de cobranza de la escuela (school_settings.collection_policy_notice): recuadro destacado. */
        policyNotice?: string | null;
        /** Mora incluida en `amount` (suma de late_fee_amount del mensaje): desglose bajo el total. */
        lateFee?: DesgloseMoraCorreo | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        const escuela = branding.schoolName.replace(/&amp;/g, '&');
        const primary = /^#[0-9A-Fa-f]{6}$/.test(branding.primaryColor) ? branding.primaryColor : '#248223';
        const atletas = `<strong>${escapeHtml(params.athletes)}</strong>`;
        const fecha = escapeHtml(params.dueDate);
        const dias = params.daysOverdue ?? 0;

        type Tono = 'info' | 'warn' | 'late';
        const textos: Record<typeof params.concepto, { subject: string; title: string; pill: string; body: string; tone: Tono }> = {
            recordatorio_previo: {
                subject: `Recordatorio: tu mensualidad vence el ${params.dueDate} — ${escuela}`,
                title: 'Tu mensualidad vence pronto',
                pill: 'Próxima a vencer',
                body: `Te recordamos que la mensualidad de ${atletas} vence el <strong>${fecha}</strong>.
                    Puedes pagarla desde ya con el botón de abajo.`,
                tone: 'info',
            },
            vence_manana: {
                subject: `Tu mensualidad vence mañana — ${escuela}`,
                title: 'Tu mensualidad vence mañana',
                pill: 'Vence mañana',
                body: `Te recordamos que la mensualidad de ${atletas} vence mañana, <strong>${fecha}</strong>.`,
                tone: 'info',
            },
            vence_hoy: {
                subject: `Hoy vence tu mensualidad — ${escuela}`,
                title: 'Hoy vence tu mensualidad',
                pill: 'Vence hoy',
                body: `Hoy es el último día para pagar a tiempo la mensualidad de ${atletas}.`,
                tone: 'warn',
            },
            pendiente_suave: {
                subject: `Tu mensualidad está pendiente — ${escuela}`,
                title: 'Tu mensualidad está pendiente',
                pill: 'Pendiente de pago',
                body: `La mensualidad de ${atletas} venció el <strong>${fecha}</strong> y aún no registramos el pago.
                    Si tuviste algún inconveniente, escríbenos y lo resolvemos juntos.`,
                tone: 'late',
            },
            pendiente_directo: {
                subject: `Mensualidad con ${dias} días de vencida — ${escuela}`,
                title: 'Tu mensualidad está vencida',
                pill: `${dias} días de vencida`,
                body: `La mensualidad de ${atletas} presenta <strong>${dias} días de vencida</strong>.
                    Te invitamos a ponerte al día para que siga entrenando sin novedad.`,
                tone: 'late',
            },
            aviso_final: {
                subject: `Último recordatorio de pago — ${escuela}`,
                title: 'Último recordatorio de pago',
                pill: 'Último recordatorio',
                body: `La mensualidad de ${atletas} sigue pendiente desde el ${fecha}. Este es el último recordatorio
                    automático de este cobro; si necesitas un acuerdo de pago, comunícate con la escuela.`,
                tone: 'late',
            },
        };
        const t = textos[params.concepto];
        const color = {
            info: { pillBg: '#dbeafe', pillFg: '#1e40af', cardBg: '#f8fafc', amount: '#111827' },
            warn: { pillBg: '#fef3c7', pillFg: '#92400e', cardBg: '#fffbeb', amount: '#111827' },
            late: { pillBg: '#fee2e2', pillFg: '#991b1b', cardBg: '#fef2f2', amount: '#b91c1c' },
        }[t.tone];

        const fila = (etiqueta: string, valor: string, ultima: boolean) => {
            const borde = ultima ? '' : ' border-bottom: 1px solid #f1f5f9;';
            return `
            <tr>
                <td style="padding: 10px 20px; color: #6b7280; font-size: 14px;${borde}">${etiqueta}</td>
                <td align="right" style="padding: 10px 20px; color: #111827; font-size: 14px; font-weight: 600;${borde}">${valor}</td>
            </tr>`;
        };
        const periodo = params.period ? params.period.charAt(0).toUpperCase() + params.period.slice(1) : null;
        const desglose = lineaMora(params.amount, params.lateFee);
        const lineaDesglose = desglose
            ? `
                                <p style="margin: 6px 0 0 0; color: #6b7280; font-size: 13px; line-height: 1.4;">${desglose}</p>`
            : '';
        const filas: [string, string][] = [
            ['Deportista', escapeHtml(params.athletes)],
            ...(periodo ? [['Mensualidad', escapeHtml(periodo)] as [string, string]] : []),
            [t.tone === 'late' ? 'Venció el' : 'Fecha límite', fecha],
            ...(t.tone === 'late' && dias > 0 ? [['Días de atraso', `${dias} día${dias === 1 ? '' : 's'}`] as [string, string]] : []),
        ];

        const corte = params.cutoffDay && params.cutoffDay >= 1 && params.cutoffDay <= 28
            ? `
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 20px 0 4px 0;">
                    <tr>
                        <td style="background-color: #f9fafb; border-left: 4px solid ${primary}; border-radius: 6px; padding: 14px 16px;">
                            <p style="margin: 0; color: #374151; font-size: 14px; line-height: 1.5;">
                                <strong>Recuerda:</strong> la mensualidad se paga dentro de los
                                <strong>primeros ${params.cutoffDay} días de cada mes</strong>.
                                Estar al día le permite a tu deportista entrenar sin interrupciones.
                            </p>
                        </td>
                    </tr>
                </table>`
            : '';

        const politica = params.policyNotice?.trim()
            ? `
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                       style="margin: 20px 0 4px 0; border: 2px solid #dc2626; border-radius: 10px; border-collapse: separate; overflow: hidden;">
                    <tr>
                        <td style="background-color: #dc2626; padding: 10px 16px;">
                            <p style="margin: 0; color: #ffffff; font-size: 14px; font-weight: 800; letter-spacing: 0.6px; text-transform: uppercase;">&#9888;&#65039; Importante</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="background-color: #fef2f2; padding: 14px 16px;">
                            <p style="margin: 0; color: #7f1d1d; font-size: 16px; font-weight: 700; line-height: 1.45;">${escapeHtml(params.policyNotice.trim())}</p>
                        </td>
                    </tr>
                </table>`
            : '';

        return {
            subject: t.subject,
            html: buildBrandedEmail({
                branding,
                title: t.title,
                // El layout ya escapa el saludo.
                greeting: `Hola ${params.parentName},`,
                bodyHtml: `
                    <p style="margin: 0 0 16px 0;">
                        <span style="display: inline-block; background-color: ${color.pillBg}; color: ${color.pillFg};
                                     font-size: 12px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase;
                                     padding: 5px 12px; border-radius: 999px;">${escapeHtml(t.pill)}</span>
                    </p>
                    <p style="margin: 0 0 20px 0;">${t.body}</p>
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                           style="border: 1px solid #e5e7eb; border-radius: 12px; border-collapse: separate; overflow: hidden;">
                        <tr>
                            <td colspan="2" style="background-color: ${color.cardBg}; padding: 18px 20px; border-bottom: 1px solid #e5e7eb;">
                                <p style="margin: 0; color: #6b7280; font-size: 12px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase;">Total a pagar</p>
                                <p style="margin: 4px 0 0 0; color: ${color.amount}; font-size: 30px; font-weight: 800; line-height: 1.2;">${escapeHtml(params.amount)}</p>${lineaDesglose}
                            </td>
                        </tr>
                        ${filas.map(([k, v], i) => fila(k, v, i === filas.length - 1)).join('')}
                    </table>
                    ${politica}
                    ${corte}
                `,
                cta: { label: 'Pagar ahora', url: params.paymentLink },
                closingHtml: '¿Ya pagaste? Puedes omitir este mensaje: el pago puede tardar un poco en verse reflejado.',
            }),
        };
    },

    // ── Glosas (aclaraciones de comprobante) ─────────────────────────────────
    /** Glosa creada → acudiente: necesita aclarar su comprobante. */
    glosaCreada: async (params: {
        parentName: string; concept: string; amount: string; reasonText: string;
        respondsBy: string; link: string; schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        return {
            subject: `Tu comprobante necesita una aclaración — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Tu comprobante necesita una aclaración',
                greeting: `Hola ${escapeHtml(params.parentName)},`,
                bodyHtml: `
                    <p>Revisamos el comprobante de <strong>${escapeHtml(params.concept)}</strong>
                    (${escapeHtml(params.amount)}) y necesitamos que aclares un detalle:</p>
                    <table cellpadding="0" cellspacing="0" border="0" width="100%"
                           style="background-color: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; margin: 16px 0;">
                        <tr><td style="padding: 16px;">
                            <p style="margin: 4px 0;">${escapeHtml(params.reasonText)}</p>
                            <p style="margin: 8px 0 0;"><strong>Responde antes del ${escapeHtml(params.respondsBy)}.</strong></p>
                        </td></tr>
                    </table>
                `,
                cta: { label: 'Responder ahora', url: params.link },
                closingHtml: 'Si no respondes a tiempo, el pago quedará pendiente.',
            }),
        };
    },

    /** Acudiente respondió → dueño de la escuela: lista para conciliar. */
    glosaRespondida: async (params: {
        parentName: string; concept: string; link: string; schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        return {
            subject: `Aclaración recibida — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Una aclaración está lista para conciliar',
                greeting: 'Hola,',
                bodyHtml: `<p><strong>${escapeHtml(params.parentName)}</strong> respondió la aclaración
                    del comprobante de <strong>${escapeHtml(params.concept)}</strong>. Ya puedes conciliarla.</p>`,
                cta: { label: 'Ir a conciliar', url: params.link },
            }),
        };
    },

    /** Glosa aceptada → acudiente: pago aprobado. */
    glosaAceptada: async (params: {
        parentName: string; concept: string; amount: string; link: string; schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        return {
            subject: `Pago aprobado — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: '¡Pago aprobado!',
                greeting: `Hola ${escapeHtml(params.parentName)},`,
                bodyHtml: `<p>Revisamos tu aclaración y tu pago de
                    <strong>${escapeHtml(params.concept)}</strong> (${escapeHtml(params.amount)})
                    quedó <span style="color:#059669;font-weight:600;">aprobado</span>. ¡Gracias!</p>`,
                cta: { label: 'Ver mis pagos', url: params.link },
            }),
        };
    },

    /** Glosa ratificada (o vencida) → acudiente: pago sigue pendiente. */
    glosaRatificada: async (params: {
        parentName: string; concept: string; amount: string; link: string; schoolId: string | null;
        expired?: boolean;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        return {
            subject: `Tu pago sigue pendiente — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Tu pago sigue pendiente',
                greeting: `Hola ${escapeHtml(params.parentName)},`,
                bodyHtml: `<p>${params.expired
                    ? 'No recibimos tu aclaración a tiempo, así que'
                    : 'Revisamos tu aclaración pero'} el pago de
                    <strong>${escapeHtml(params.concept)}</strong> (${escapeHtml(params.amount)})
                    <strong>sigue pendiente</strong>. Comunícate con la escuela para regularizarlo.</p>`,
                cta: { label: 'Ver mis pagos', url: params.link },
            }),
        };
    },

    /** Recordatorio: la aclaración vence mañana (última oportunidad). */
    glosaVenceManana: async (params: {
        parentName: string; concept: string; respondsBy: string; link: string; schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        return {
            subject: `Última oportunidad para aclarar tu comprobante — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Tu aclaración vence mañana',
                greeting: `Hola ${escapeHtml(params.parentName)},`,
                bodyHtml: `<p>Te recordamos que la aclaración del comprobante de
                    <strong>${escapeHtml(params.concept)}</strong> vence
                    <strong>${escapeHtml(params.respondsBy)}</strong>. Si no respondes, el pago
                    quedará pendiente.</p>`,
                cta: { label: 'Responder ahora', url: params.link },
                closingHtml: 'Es la última oportunidad antes de que el plazo se cierre.',
            }),
        };
    },

    // ── Intento de pago online rechazado (Wompi/MercadoPago) ─────────────────
    /** El banco rechazó el intento → acudiente: puede reintentar ya mismo. */
    /**
     * Saldo del banco de horas (escalera de avisos). UN correo por acudiente con TODAS las
     * hijas que cruzaron un escalón en esta corrida (hermanas = un solo mensaje).
     * Plan: docs/specs/dreamers-horas-agotadas-bloqueo-y-excedentes-automaticos.md §2.1.
     */
    hourBankBalance: async (params: {
        recipientName: string;
        items: { athlete: string; title: string; body: string; severity: 'info' | 'aviso' | 'critico' }[];
        link: string;
        schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        const one = params.items.length === 1 ? params.items[0] : null;
        const color = (sev: string) => (sev === 'critico' ? '#b91c1c' : sev === 'aviso' ? '#b45309' : '#166534');
        const bloques = params.items.map((it) => `
            <div style="border-left: 4px solid ${color(it.severity)}; padding: 4px 0 4px 12px; margin: 14px 0;">
                <p style="margin: 0 0 4px; font-weight: 700;">${escapeHtml(it.title)}</p>
                <p style="margin: 0;">${escapeHtml(it.body)}</p>
            </div>`).join('');
        return {
            subject: one
                ? `${one.title} — ${branding.schoolName.replace(/&amp;/g, '&')}`
                : `Saldo de horas de tus deportistas — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Saldo de horas',
                greeting: `Hola ${escapeHtml(params.recipientName)},`,
                bodyHtml: `<p>Así va el banco de horas de este mes:</p>${bloques}`,
                cta: { label: 'Ver el saldo', url: params.link },
                closingHtml: 'Si necesitas más horas, escríbele a la escuela.',
            }),
        };
    },

    paymentAttemptFailed: async (params: {
        parentName: string; concept: string; amount: string; bankReason: string | null;
        link: string; schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        return {
            subject: `Tu pago no se pudo procesar — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Tu pago no se pudo procesar',
                greeting: `Hola ${escapeHtml(params.parentName)},`,
                bodyHtml: `
                    <p>Intentaste pagar <strong>${escapeHtml(params.concept)}</strong>
                    (${escapeHtml(params.amount)}) y el banco rechazó la transacción${
                        params.bankReason ? `: <em>${escapeHtml(params.bankReason)}</em>` : '.'
                    }</p>
                    <p>No te preocupes: el cobro sigue disponible, no perdiste el intento.
                    Puedes volver a intentarlo con el mismo medio o con otro.</p>
                `,
                cta: { label: 'Reintentar pago', url: params.link },
                closingHtml: 'Si el problema persiste, contacta directamente a la escuela.',
            }),
        };
    },

    /** Resultado ambiguo (ERROR/VOIDED) → acudiente: que NO reintente todavía. */
    paymentAttemptAmbiguous: async (params: {
        parentName: string; concept: string; amount: string; link: string; schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        return {
            subject: `No pudimos confirmar tu pago — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'No pudimos confirmar tu pago',
                greeting: `Hola ${escapeHtml(params.parentName)},`,
                bodyHtml: `
                    <p>El pago de <strong>${escapeHtml(params.concept)}</strong>
                    (${escapeHtml(params.amount)}) quedó sin confirmar con la pasarela.</p>
                    <p><strong>No vuelvas a pagar todavía</strong>: estamos verificando con el
                    banco si el dinero se movió, y te avisamos apenas lo sepamos.</p>
                `,
                cta: { label: 'Ver mis pagos', url: params.link },
            }),
        };
    },

    /** Intento rechazado/ambiguo → escuela: para que responda con el motivo real. */
    paymentAttemptFailedSchoolAlert: async (params: {
        payerName: string; studentName: string | null; concept: string; amount: string;
        bankReason: string | null; ambiguous: boolean; link: string; schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        const quien = params.studentName
            ? `${escapeHtml(params.payerName)} (${escapeHtml(params.studentName)})`
            : escapeHtml(params.payerName);
        return {
            subject: params.ambiguous
                ? `Pago sin confirmar — ${branding.schoolName.replace(/&amp;/g, '&')}`
                : `Intento de pago rechazado — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: params.ambiguous ? 'Pago sin confirmar' : 'Intento de pago rechazado',
                greeting: 'Hola,',
                bodyHtml: params.ambiguous
                    ? `<p><strong>${quien}</strong> intentó pagar <strong>${escapeHtml(params.concept)}</strong>
                        (${escapeHtml(params.amount)}) pero la pasarela no confirmó el resultado.
                        Verificá en el dashboard de la pasarela antes de volver a cobrarle: no sabemos
                        todavía si el dinero se movió.</p>`
                    : `<p><strong>${quien}</strong> intentó pagar <strong>${escapeHtml(params.concept)}</strong>
                        (${escapeHtml(params.amount)}) y el banco lo rechazó${
                            params.bankReason ? `: <em>${escapeHtml(params.bankReason)}</em>` : '.'
                        }</p>
                        <p>El cobro sigue pendiente y la familia ya puede reintentar. Si le escribís,
                        contale el motivo exacto en vez de solo decir "no ha pagado" — a veces el
                        rechazo lo dio el banco, no una decisión suya.</p>`,
                cta: { label: 'Ver cartera', url: params.link },
            }),
        };
    },

    /**
     * Bienvenida tras registrarse. Sin schoolId (usuario nuevo sin escuela aún).
     */
    welcome: async (params: { name: string }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(null); // defaults SportMaps

        return {
            subject: '¡Bienvenido a SportMaps!',
            html: buildBrandedEmail({
                branding,
                title: '¡Bienvenido a SportMaps!',
                greeting: `Hola ${escapeHtml(params.name)},`,
                bodyHtml: `
                    <p>Estamos emocionados de tenerte con nosotros. Ahora puedes gestionar
                    las actividades deportivas de tus hijos de forma fácil y rápida.</p>
                    <p>Explora las escuelas cercanas y encuentra el programa perfecto.</p>
                `,
                cta: { label: 'Explorar Programas', url: 'https://app.sportmaps.co/explorar' },
            }),
        };
    },

    /**
     * Confirmación de clase de prueba agendada por el owner/admin desde el
     * módulo de instalaciones (ver docs/specs/clases-de-prueba-agenda-owner.md).
     * Va al prospecto, no a un usuario con cuenta — sin CTA de login.
     */
    trialClassConfirmation: async (params: {
        prospectName: string;
        childName?: string | null; // presente = prospectName es el acudiente, no el atleta
        dateLabel: string;
        timeLabel: string;
        facilityName: string;
        coachName: string;
        priceLabel: string | null; // null = sin costo, no se muestra la fila
        schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        const priceRow = params.priceLabel
            ? `<p style="margin: 4px 0;"><strong>Costo:</strong> ${escapeHtml(params.priceLabel)}</p>`
            : '';
        const intro = params.childName
            ? `Confirmamos la clase de prueba de <strong>${escapeHtml(params.childName)}</strong> en <strong>${branding.schoolName}</strong>:`
            : `Confirmamos tu clase de prueba en <strong>${branding.schoolName}</strong>:`;

        return {
            subject: `Confirmación de tu clase de prueba — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: '¡Clase de prueba confirmada!',
                greeting: `Hola ${escapeHtml(params.prospectName)},`,
                bodyHtml: `
                    <p>${intro}</p>
                    <table cellpadding="0" cellspacing="0" border="0" width="100%"
                           style="background-color: #f3f4f6; border-radius: 8px; margin: 16px 0;">
                        <tr><td style="padding: 16px;">
                            <p style="margin: 4px 0;"><strong>Fecha:</strong> ${escapeHtml(params.dateLabel)}</p>
                            <p style="margin: 4px 0;"><strong>Hora:</strong> ${escapeHtml(params.timeLabel)}</p>
                            <p style="margin: 4px 0;"><strong>Lugar:</strong> ${escapeHtml(params.facilityName)}</p>
                            <p style="margin: 4px 0;"><strong>Entrenador:</strong> ${escapeHtml(params.coachName)}</p>
                            ${priceRow}
                        </td></tr>
                    </table>
                `,
                closingHtml: '¡Te esperamos!',
            }),
        };
    },

    /** Cancelación de una clase de prueba ya agendada — ver trialClassConfirmation. */
    trialClassCancellation: async (params: {
        prospectName: string;
        childName?: string | null;
        dateLabel: string;
        timeLabel: string;
        cancelReason?: string | null;
        schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        const who = params.childName ? `la clase de prueba de <strong>${escapeHtml(params.childName)}</strong>` : 'tu clase de prueba';
        const reasonRow = params.cancelReason
            ? `<p style="margin: 8px 0 0;">Motivo: ${escapeHtml(params.cancelReason)}</p>`
            : '';

        return {
            subject: `Tu clase de prueba fue cancelada — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Clase de prueba cancelada',
                greeting: `Hola ${escapeHtml(params.prospectName)},`,
                bodyHtml: `
                    <p>Te confirmamos que ${who} programada para el <strong>${escapeHtml(params.dateLabel)}</strong> a las <strong>${escapeHtml(params.timeLabel)}</strong> en <strong>${branding.schoolName}</strong> fue cancelada.${reasonRow}</p>
                    <p>Si quieres reagendar, contáctanos cuando quieras.</p>
                `,
            }),
        };
    },

    /** Reprogramación (cambio de fecha/hora) de una clase de prueba ya agendada. */
    trialClassRescheduled: async (params: {
        prospectName: string;
        childName?: string | null;
        dateLabel: string;
        timeLabel: string;
        facilityName: string;
        coachName: string;
        schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        const who = params.childName ? `la clase de prueba de <strong>${escapeHtml(params.childName)}</strong>` : 'tu clase de prueba';

        return {
            subject: `Tu clase de prueba fue reprogramada — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Clase de prueba reprogramada',
                greeting: `Hola ${escapeHtml(params.prospectName)},`,
                bodyHtml: `
                    <p>Te confirmamos que ${who} en <strong>${branding.schoolName}</strong> fue reprogramada:</p>
                    <table cellpadding="0" cellspacing="0" border="0" width="100%"
                           style="background-color: #f3f4f6; border-radius: 8px; margin: 16px 0;">
                        <tr><td style="padding: 16px;">
                            <p style="margin: 4px 0;"><strong>Nueva fecha:</strong> ${escapeHtml(params.dateLabel)}</p>
                            <p style="margin: 4px 0;"><strong>Nueva hora:</strong> ${escapeHtml(params.timeLabel)}</p>
                            <p style="margin: 4px 0;"><strong>Lugar:</strong> ${escapeHtml(params.facilityName)}</p>
                            <p style="margin: 4px 0;"><strong>Entrenador:</strong> ${escapeHtml(params.coachName)}</p>
                        </td></tr>
                    </table>
                `,
                closingHtml: '¡Te esperamos!',
            }),
        };
    },

    /**
     * Cancelación de una reserva de instalación (alquiler del owner o clase
     * de cortesía pública) — ver reservationRescheduled y useFacilityReservations.
     */
    reservationCancelled: async (params: {
        recipientName: string;
        facilityName: string;
        dateLabel: string;
        timeLabel: string;
        cancelReason?: string | null;
        schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        const reasonRow = params.cancelReason
            ? `<p style="margin: 8px 0 0;">Motivo: ${escapeHtml(params.cancelReason)}</p>`
            : '';

        return {
            subject: `Tu reserva fue cancelada — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Reserva cancelada',
                greeting: `Hola ${escapeHtml(params.recipientName)},`,
                bodyHtml: `
                    <p>Te confirmamos que tu reserva en <strong>${escapeHtml(params.facilityName)}</strong> programada para el <strong>${escapeHtml(params.dateLabel)}</strong> a las <strong>${escapeHtml(params.timeLabel)}</strong> fue cancelada.${reasonRow}</p>
                    <p>Si quieres reservar de nuevo, contáctanos cuando quieras.</p>
                `,
            }),
        };
    },

    /** Reprogramación (cambio de fecha/hora) de una reserva de instalación. */
    reservationRescheduled: async (params: {
        recipientName: string;
        facilityName: string;
        dateLabel: string;
        timeLabel: string;
        schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);

        return {
            subject: `Tu reserva fue reprogramada — ${branding.schoolName.replace(/&amp;/g, '&')}`,
            html: buildBrandedEmail({
                branding,
                title: 'Reserva reprogramada',
                greeting: `Hola ${escapeHtml(params.recipientName)},`,
                bodyHtml: `
                    <p>Te confirmamos que tu reserva en <strong>${branding.schoolName}</strong> fue reprogramada:</p>
                    <table cellpadding="0" cellspacing="0" border="0" width="100%"
                           style="background-color: #f3f4f6; border-radius: 8px; margin: 16px 0;">
                        <tr><td style="padding: 16px;">
                            <p style="margin: 4px 0;"><strong>Nueva fecha:</strong> ${escapeHtml(params.dateLabel)}</p>
                            <p style="margin: 4px 0;"><strong>Nueva hora:</strong> ${escapeHtml(params.timeLabel)}</p>
                            <p style="margin: 4px 0;"><strong>Lugar:</strong> ${escapeHtml(params.facilityName)}</p>
                        </td></tr>
                    </table>
                `,
                closingHtml: '¡Te esperamos!',
            }),
        };
    },

    /**
     * Confirmación de reserva agendada desde el flujo público (/agendar/:slug,
     * bff/src/routes/public-booking.routes.ts POST /confirm) — clase de
     * cortesía o reserva de socio con plan activo. Va al prospecto tras
     * verificar el código OTP; distinta de reservationCancelled/Rescheduled,
     * que son para reservas ya agendadas.
     */
    publicBookingConfirmation: async (params: {
        recipientName: string;
        facilityName: string;
        dateLabel: string;
        timeLabel: string;
        schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);

        return {
            subject: `Tu reserva en ${branding.schoolName.replace(/&amp;/g, '&')} está confirmada`,
            html: buildBrandedEmail({
                branding,
                title: '¡Reserva confirmada!',
                greeting: `Hola ${escapeHtml(params.recipientName)},`,
                bodyHtml: `
                    <p>Confirmamos tu reserva en <strong>${branding.schoolName}</strong>:</p>
                    <table cellpadding="0" cellspacing="0" border="0" width="100%"
                           style="background-color: #f3f4f6; border-radius: 8px; margin: 16px 0;">
                        <tr><td style="padding: 16px;">
                            <p style="margin: 4px 0;"><strong>Fecha:</strong> ${escapeHtml(params.dateLabel)}</p>
                            <p style="margin: 4px 0;"><strong>Hora:</strong> ${escapeHtml(params.timeLabel)}</p>
                            <p style="margin: 4px 0;"><strong>Lugar:</strong> ${escapeHtml(params.facilityName)}</p>
                        </td></tr>
                    </table>
                `,
                closingHtml: '¡Te esperamos!',
            }),
        };
    },

    /**
     * Clase agendada sin cuenta (POST /book-for-enrollment). Al titular
     * (sin forName) o, como copia, al acudiente (forName = nombre de la ficha).
     */
    enrollmentClassBooked: async (params: {
        recipientName: string;
        forName?: string;
        dateLabel: string;
        timeLabel: string;
        schoolId: string | null;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(params.schoolId);
        const intro = params.forName
            ? `La clase de <strong>${escapeHtml(params.forName)}</strong> quedó agendada en <strong>${branding.schoolName}</strong>:`
            : `Tu clase quedó agendada en <strong>${branding.schoolName}</strong>:`;

        return {
            subject: params.forName ? 'Clase agendada' : 'Tu clase quedó agendada',
            html: buildBrandedEmail({
                branding,
                title: 'Clase agendada',
                greeting: `Hola ${escapeHtml(params.recipientName)},`,
                bodyHtml: `
                    <p>${intro}</p>
                    <table cellpadding="0" cellspacing="0" border="0" width="100%"
                           style="background-color: #f3f4f6; border-radius: 8px; margin: 16px 0;">
                        <tr><td style="padding: 16px;">
                            <p style="margin: 4px 0;"><strong>Fecha:</strong> ${escapeHtml(params.dateLabel)}</p>
                            <p style="margin: 4px 0;"><strong>Hora:</strong> ${escapeHtml(params.timeLabel)}</p>
                        </td></tr>
                    </table>
                `,
                closingHtml: '¡Te esperamos!',
            }),
        };
    },

    /**
     * Resumen de «Pagos por validar» para el dueño y los admins de la escuela
     * (jobs/pagos-por-validar.job). Va DE SportMaps A la escuela, así que usa
     * la marca de SportMaps (sin schoolId), no la de la escuela. Los textos ya
     * vienen armados por el job; acá solo se escapan y se maquetan.
     */
    pagosPorValidar: async (params: {
        escuela: string;
        asunto: string;
        titulo: string;
        total: number;
        /** Ya formateado («$4.547.500»). */
        monto: string;
        lineaVerdes: string | null;
        lineaEspera: string;
        /** «4 nov, 8:08 a. m.» (hora de Colombia), o vacío. */
        masAntiguoFecha: string;
        linea48: string | null;
        desglose: { etiqueta: string; cantidad: number; monto: string }[];
        url: string;
    }): Promise<{ subject: string; html: string }> => {
        const branding = await resolveSchoolBranding(null); // marca SportMaps
        const escuela = escapeHtml(params.escuela);
        const filas = params.desglose.map((l) => `
                        <tr>
                            <td style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(l.etiqueta)}</td>
                            <td style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb; text-align: center;">${l.cantidad}</td>
                            <td style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb; text-align: right; white-space: nowrap;">${escapeHtml(l.monto)}</td>
                        </tr>`).join('');
        const espera = params.masAntiguoFecha
            ? `${escapeHtml(params.lineaEspera.replace(/\.$/, ''))} (entró el ${escapeHtml(params.masAntiguoFecha)}).`
            : escapeHtml(params.lineaEspera);

        return {
            subject: params.asunto,
            html: buildBrandedEmail({
                branding,
                title: params.titulo,
                greeting: `Hola, equipo de ${params.escuela}:`,
                bodyHtml: `
                    <table cellpadding="0" cellspacing="0" border="0" width="100%"
                           style="background-color: #f3f4f6; border-radius: 8px; margin: 4px 0 18px 0;">
                        <tr>
                            <td style="padding: 16px; text-align: center; width: 50%;">
                                <div style="font-size: 28px; font-weight: 700; color: #111827;">${params.total}</div>
                                <div style="font-size: 13px; color: #6b7280;">${params.total === 1 ? 'pago por validar' : 'pagos por validar'}</div>
                            </td>
                            <td style="padding: 16px; text-align: center; width: 50%;">
                                <div style="font-size: 28px; font-weight: 700; color: #111827;">${escapeHtml(params.monto)}</div>
                                <div style="font-size: 13px; color: #6b7280;">por confirmar</div>
                            </td>
                        </tr>
                    </table>
                    ${params.lineaVerdes ? `<p style="margin: 0 0 10px 0; padding: 10px 12px; background-color: #ecfdf5; border-left: 3px solid #059669; border-radius: 6px;"><span style="color: #047857;">${escapeHtml(params.lineaVerdes)}</span></p>` : ''}
                    <p style="margin: 0 0 10px 0;">${espera}</p>
                    ${params.linea48 ? `<p style="margin: 0 0 10px 0; padding: 10px 12px; background-color: #fffbeb; border-left: 3px solid #d97706; border-radius: 6px;">${escapeHtml(params.linea48)}</p>` : ''}
                    ${filas ? `
                    <p style="margin: 18px 0 6px 0; font-weight: 600; color: #111827;">Por tipo de cobro</p>
                    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse: collapse; font-size: 14px;">
                        <tr style="color: #6b7280;">
                            <td style="padding: 6px 10px; border-bottom: 2px solid #e5e7eb;">Tipo</td>
                            <td style="padding: 6px 10px; border-bottom: 2px solid #e5e7eb; text-align: center;">Cantidad</td>
                            <td style="padding: 6px 10px; border-bottom: 2px solid #e5e7eb; text-align: right;">Valor</td>
                        </tr>${filas}
                    </table>` : ''}
                `,
                cta: { label: 'Revisar pagos por validar', url: params.url },
                closingHtml: `Recibes este resumen porque eres dueño o administrador de <strong>${escuela}</strong> en SportMaps.
                    Llega a las 7:30 a. m. solo los días con pagos esperando, y a las 5:00 p. m. si alguno lleva más de 48 horas.`,
            }),
        };
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// API legacy — SINCRONICA, sin branding por escuela.
// Los callsites antiguos no se rompen. Migrar a BrandedEmailTemplates.
// ─────────────────────────────────────────────────────────────────────────────
export const EmailTemplates = {
    paymentConfirmation: (parentName: string, amount: string, concept: string, receiptNumber: string) => `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #248223;">¡Pago Recibido!</h1>
        <p>Hola ${escapeHtml(parentName)},</p>
        <p>Hemos recibido y validado tu pago exitosamente. Aquí están los detalles:</p>
        <div style="background-color: #F3F4F6; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Concepto:</strong> ${escapeHtml(concept)}</p>
          <p><strong>Monto:</strong> ${escapeHtml(amount)}</p>
          <p><strong>Referencia:</strong> ${escapeHtml(receiptNumber)}</p>
          <p><strong>Estado:</strong> <span style="color: green; font-weight: bold;">Aprobado</span></p>
        </div>
        <p>Gracias por confiar en nosotros.</p>
        <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 30px 0;" />
        <p style="color: #6B7280; font-size: 12px;">SportMaps - Gestión Deportiva</p>
      </div>
    `,

    paymentReminder: (parentName: string, amount: string, childName: string, dueDate: string, paymentLink: string) => `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #FB9F1E;">Recordatorio de Pago</h1>
        <p>Hola ${escapeHtml(parentName)},</p>
        <p>Este es un recordatorio amable sobre el pago pendiente para la mensualidad de <strong>${escapeHtml(childName)}</strong>.</p>
        <div style="background-color: #FFFBEB; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #FEF3C7;">
          <p><strong>Monto a pagar:</strong> ${escapeHtml(amount)}</p>
          <p><strong>Fecha límite:</strong> ${escapeHtml(dueDate)}</p>
        </div>
        <a href="${escapeHtml(paymentLink)}" style="background-color: #248223; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Pagar Ahora</a>
        <p style="margin-top: 20px;">Si ya realizaste el pago, por favor omite este mensaje.</p>
        <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 30px 0;" />
        <p style="color: #6B7280; font-size: 12px;">SportMaps - Gestión Deportiva</p>
      </div>
    `,

    welcome: (name: string) => `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #248223;">¡Bienvenido a SportMaps!</h1>
        <p>Hola ${escapeHtml(name)},</p>
        <p>Estamos emocionados de tenerte con nosotros.</p>
        <a href="https://app.sportmaps.co/explorar" style="background-color: #248223; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin-top: 10px;">Explorar Programas</a>
      </div>
    `,

    invitation: (parentName: string, childName: string, schoolName: string, inviteLink: string) => `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #248223;">¡Invitación de ${escapeHtml(schoolName)}!</h1>
        <p>Hola ${escapeHtml(parentName || 'Padre/Madre')},</p>
        <p>La escuela <strong>${escapeHtml(schoolName)}</strong> ha registrado a <strong>${escapeHtml(childName)}</strong> en su sistema.</p>
        <p>Para ver el progreso de tu hijo/a, realizar pagos y recibir notificaciones, por favor completa tu registro en SportMaps.</p>
        <div style="background-color: #F3F4F6; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
          <a href="${escapeHtml(inviteLink)}" style="background-color: #248223; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">Aceptar Invitación y Crear Cuenta</a>
        </div>
        <p>Si ya tienes cuenta, el deportista se asociará automáticamente cuando inicies sesión con este correo.</p>
        <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 30px 0;" />
        <p style="color: #6B7280; font-size: 12px;">SportMaps - Gestión Deportiva</p>
      </div>
    `,
};
