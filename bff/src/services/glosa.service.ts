/**
 * glosa.service — App-layer del ciclo de glosas (Fase 3).
 *
 * El BFF es el ÚNICO caller de los RPCs de glosa (otorgados solo a service_role).
 * Valida el JWT en la ruta y pasa el usuario como `p_actor`; el RPC autoriza por
 * ese actor. Aquí van los wrappers + la auto-creación app-layer gateada por
 * `school_settings.auto_glosa_enabled` (default false → dormant).
 */

import type { Logger } from 'pino';
import { supabase } from '../config/supabase';
import { emailClient } from '../utils/emailClient';
import { BrandedEmailTemplates } from '../utils/emailTemplates';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.sportmaps.co';
const fmtCop = (n?: number | null) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

/** Motivo → texto simple para el acudiente (espeja REASON_LABELS del frontend). */
const REASON_TEXT: Record<string, string> = {
    MONTO_DIFIERE: 'El monto del comprobante no coincide con el valor esperado.',
    FECHA_FUERA_VENTANA: 'La fecha del comprobante está fuera del plazo permitido.',
    REFERENCIA_DUPLICADA: 'Este número de comprobante ya se había usado.',
    DESTINO_NO_COINCIDE: 'El dinero se envió a una cuenta que no reconocemos.',
    CAMPOS_ILEGIBLES: 'No pudimos leer bien algunos datos del comprobante.',
    LECTURA_INCONSISTENTE: 'Necesitamos verificar algunos datos del comprobante.',
    NO_APARECE_EN_BANCO: 'No pudimos confirmar el pago en el extracto del banco.',
    OTRO: 'Necesitamos que aclares un detalle de tu comprobante.',
};

export type GlosaReason =
    | 'MONTO_DIFIERE'
    | 'FECHA_FUERA_VENTANA'
    | 'REFERENCIA_DUPLICADA'
    | 'DESTINO_NO_COINCIDE'
    | 'CAMPOS_ILEGIBLES'
    | 'LECTURA_INCONSISTENTE'
    | 'NO_APARECE_EN_BANCO'
    | 'OTRO';

export type GlosaOutcome = 'ACEPTADA' | 'RATIFICADA';

/** Error que preserva el código Postgres para que la ruta mapee 23505→409, 42501→403, etc. */
export class GlosaRpcError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
        super(message);
        this.name = 'GlosaRpcError';
        this.code = code;
    }
}

async function callRpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new GlosaRpcError(error.message, (error as { code?: string }).code);
    return data as T;
}

// ── Wrappers de la máquina de estados ───────────────────────────────────────

export function createGlosa(
    actor: string | null,
    paymentId: string,
    reason: GlosaReason,
    reasonDetail?: unknown,
    respondsBy?: string,
): Promise<string> {
    return callRpc<string>('create_glosa', {
        p_actor: actor,
        p_payment_id: paymentId,
        p_reason: reason,
        p_reason_detail: reasonDetail ?? null,
        p_responds_by: respondsBy ?? null,
    });
}

export function respondGlosa(
    actor: string,
    glosaId: string,
    responseText: string,
    responseFiles?: unknown,
): Promise<void> {
    return callRpc('respond_glosa', {
        p_actor: actor,
        p_glosa_id: glosaId,
        p_response_text: responseText,
        p_response_files: responseFiles ?? null,
    });
}

export function conciliateGlosa(actor: string, glosaId: string): Promise<void> {
    return callRpc('conciliate_glosa', { p_actor: actor, p_glosa_id: glosaId });
}

export function resolveGlosa(
    actor: string,
    glosaId: string,
    outcome: GlosaOutcome,
    resolutionNote: string,
): Promise<void> {
    return callRpc('resolve_glosa', {
        p_actor: actor,
        p_glosa_id: glosaId,
        p_outcome: outcome,
        p_resolution_note: resolutionNote,
    });
}

export function reopenGlosa(actor: string, glosaId: string, note: string): Promise<void> {
    return callRpc('reopen_glosa', { p_actor: actor, p_glosa_id: glosaId, p_note: note });
}

// ── Lecturas (para el panel de Fase 4) ──────────────────────────────────────

export async function listGlosasBySchool(schoolId: string, status?: string) {
    // Join al pago para que la conciliación (3 columnas) sea self-contained.
    const PAYMENT_JOIN =
        'payments!inner(id, amount, concept, due_date, payment_date, receipt_url, ' +
        'ocr_amount, ocr_currency, ocr_date, ocr_bank, ocr_reference, ocr_destination, ' +
        'receipt_verdict, receipt_verdict_reasons, ' +
        'child:children!payments_child_id_fkey(full_name), ' +
        'parent:profiles!payments_parent_id_fkey(full_name, email))';
    let q = supabase
        .from('payment_glosas')
        .select(`*, ${PAYMENT_JOIN}`)
        .eq('school_id', schoolId)
        .order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw new GlosaRpcError(error.message, (error as { code?: string }).code);

    // Firmar la URL del comprobante con service-role (bypassa RLS): el admin NO es
    // dueño del objeto en storage, así que su sign client-side da 400. Aquí lo
    // firmamos server-side y lo adjuntamos para que la conciliación muestre la imagen.
    const rows = (data ?? []) as any[];
    await Promise.all(rows.map(async (g) => {
        const url = g?.payments?.receipt_url as string | undefined;
        if (url && g.payments) {
            g.payments.receipt_signed_url = await signReceiptObject(url);
        }
    }));
    return rows;
}

/** Firma un objeto de payment-receipts con service-role. null si no existe / falla. */
async function signReceiptObject(receiptUrl: string): Promise<string | null> {
    try {
        // Normalizar a path relativo (soporta URL completa o prefijo de bucket).
        let path = receiptUrl.trim();
        if (path.startsWith('http')) {
            const marker = '/storage/v1/object/';
            const idx = path.indexOf(marker);
            if (idx === -1) return path.includes('supabase.co') ? null : path; // externo → tal cual
            path = path.substring(idx + marker.length).split('/').slice(2).join('/');
        }
        if (path.startsWith('payment-receipts/')) path = path.substring('payment-receipts/'.length);
        if (path.startsWith('/')) path = path.substring(1);
        if (!path) return null;
        const { data, error } = await supabase.storage.from('payment-receipts').createSignedUrl(path, 900);
        if (error) return null;
        return data?.signedUrl ?? null;
    } catch {
        return null;
    }
}

export async function listGlosasForParent(parentId: string) {
    // service-role bypassa RLS → filtramos por join a payments del acudiente.
    const { data, error } = await supabase
        .from('payment_glosas')
        .select('*, payments!inner(parent_id, user_id)')
        // El acudiente, o el adulto titular del cobro (parent_id NULL, user_id = él).
        .or(`parent_id.eq.${parentId},and(parent_id.is.null,user_id.eq.${parentId})`, { referencedTable: 'payments' })
        .order('created_at', { ascending: false });
    if (error) throw new GlosaRpcError(error.message, (error as { code?: string }).code);
    return data ?? [];
}

// ── Correos branded por evento (fire-and-forget desde las rutas) ─────────────

const GLOSA_EMAIL_SELECT =
    'reason, responds_by, payments!inner(school_id, concept, amount, parent_id, user_id, ' +
    'parent:profiles!payments_parent_id_fkey(full_name, email), ' +
    'owner:profiles!payments_user_id_fkey(full_name, email))';

/** Glosa creada → correo al acudiente. */
export async function sendGlosaCreatedEmail(glosaId: string, log?: Logger): Promise<void> {
    try {
        const { data: g } = await supabase
            .from('payment_glosas')
            .select(GLOSA_EMAIL_SELECT)
            .eq('id', glosaId)
            .single();
        const p: any = (g as any)?.payments;
        // Sin acudiente, al adulto titular del cobro (user_id).
        const parent = p?.parent_id ? p?.parent : p?.owner;
        if (!parent?.email) return;
        const tpl = await BrandedEmailTemplates.glosaCreada({
            parentName: parent.full_name || 'Acudiente',
            concept: p.concept || 'tu pago',
            amount: fmtCop(p.amount),
            reasonText: REASON_TEXT[(g as any).reason] || REASON_TEXT.OTRO,
            respondsBy: (g as any).responds_by,
            link: `${FRONTEND_URL}/my-payments`,
            schoolId: p.school_id,
        });
        await emailClient.send({ to: parent.email, subject: tpl.subject, html: tpl.html });
    } catch (err) {
        (log ?? console).warn?.({ err, glosaId }, '[glosa] email creada falló');
    }
}

/** Acudiente respondió → correo al dueño de la escuela. */
export async function sendGlosaRespondedEmail(glosaId: string, log?: Logger): Promise<void> {
    try {
        const { data: g } = await supabase
            .from('payment_glosas')
            .select('payments!inner(school_id, concept, parent:profiles!payments_parent_id_fkey(full_name))')
            .eq('id', glosaId)
            .single();
        const p: any = (g as any)?.payments;
        if (!p?.school_id) return;
        const { data: school } = await supabase.from('schools').select('owner_id').eq('id', p.school_id).single();
        if (!school?.owner_id) return;
        const { data: owner } = await supabase.from('profiles').select('email').eq('id', school.owner_id).single();
        if (!owner?.email) return;
        const tpl = await BrandedEmailTemplates.glosaRespondida({
            parentName: p.parent?.full_name || 'Un acudiente',
            concept: p.concept || 'un pago',
            link: `${FRONTEND_URL}/payments-automation`,
            schoolId: p.school_id,
        });
        await emailClient.send({ to: owner.email, subject: tpl.subject, html: tpl.html });
    } catch (err) {
        (log ?? console).warn?.({ err, glosaId }, '[glosa] email respondida falló');
    }
}

/** Glosa resuelta (ACEPTADA|RATIFICADA) → correo al acudiente. */
export async function sendGlosaResolvedEmail(glosaId: string, outcome: GlosaOutcome, log?: Logger): Promise<void> {
    try {
        const { data: g } = await supabase
            .from('payment_glosas')
            .select(GLOSA_EMAIL_SELECT)
            .eq('id', glosaId)
            .single();
        const p: any = (g as any)?.payments;
        // Sin acudiente, al adulto titular del cobro (user_id).
        const parent = p?.parent_id ? p?.parent : p?.owner;
        if (!parent?.email) return;
        const common = {
            parentName: parent.full_name || 'Acudiente',
            concept: p.concept || 'tu pago',
            amount: fmtCop(p.amount),
            link: `${FRONTEND_URL}/my-payments`,
            schoolId: p.school_id as string | null,
        };
        const tpl = outcome === 'ACEPTADA'
            ? await BrandedEmailTemplates.glosaAceptada(common)
            : await BrandedEmailTemplates.glosaRatificada(common);
        await emailClient.send({ to: parent.email, subject: tpl.subject, html: tpl.html });
    } catch (err) {
        (log ?? console).warn?.({ err, glosaId }, '[glosa] email resuelta falló');
    }
}

// ── Auto-creación app-layer (gateada por flag; dormant en Fase 3) ────────────

/** VerdictCode (amarillo) → GlosaReason. FORMATO_REFERENCIA no es un GlosaReason → OTRO. */
const AMARILLO_TO_GLOSA: Record<string, GlosaReason> = {
    MONTO_DIFIERE: 'MONTO_DIFIERE',
    FECHA_FUERA_VENTANA: 'FECHA_FUERA_VENTANA',
    CAMPOS_ILEGIBLES: 'CAMPOS_ILEGIBLES',
    FORMATO_REFERENCIA: 'OTRO',
    // Amarillo solo cuando el destino es una llave de la escuela restringida a
    // otro concepto (payment_accounts[].only_for). El rojo nunca llega acá.
    DESTINO_NO_COINCIDE: 'DESTINO_NO_COINCIDE',
};

interface VerdictReasonRow {
    code?: string;
    level?: string;
    detail?: unknown;
}

/**
 * Si la escuela tiene `auto_glosa_enabled` y el pago quedó AMARILLO, abre una
 * glosa (p_actor=NULL, creación de sistema) mapeando el primer motivo amarillo.
 * Fire-and-forget: nunca rompe el flujo llamante, pero loguea con paymentId si falla
 * (un amarillo que no se glosa y nadie sabe por qué es peor que un log ruidoso).
 * Devuelve el id de la glosa creada, o null si no aplicaba / falló.
 */
export async function maybeAutoCreateGlosa(paymentId: string, log?: Logger): Promise<string | null> {
    try {
        const { data: payment, error: pErr } = await supabase
            .from('payments')
            .select('school_id, receipt_verdict, receipt_verdict_reasons')
            .eq('id', paymentId)
            .single();
        if (pErr || !payment) return null;
        if (payment.receipt_verdict !== 'amarillo') return null;

        const reasons: VerdictReasonRow[] = Array.isArray(payment.receipt_verdict_reasons)
            ? (payment.receipt_verdict_reasons as VerdictReasonRow[])
            : [];
        return await autoCreateGlosaFromReasons(paymentId, payment.school_id, reasons, log);
    } catch (err) {
        (log ?? console).warn?.({ err, paymentId }, '[glosa] auto-create falló');
        return null;
    }
}

/**
 * Abre una glosa de sistema (p_actor=NULL) mapeando el primer motivo amarillo de
 * `reasons`, gateada por `auto_glosa_enabled` de la escuela. La usa tanto
 * maybeAutoCreateGlosa (con el veredicto persistido) como el evaluador de Fase 5
 * (con el veredicto RE-COMPUTADO server-side). Devuelve el id de la glosa o null.
 */
export async function autoCreateGlosaFromReasons(
    paymentId: string,
    schoolId: string,
    reasons: VerdictReasonRow[],
    log?: Logger,
): Promise<string | null> {
    try {
        const { data: settings } = await supabase
            .from('school_settings')
            .select('auto_glosa_enabled')
            .eq('school_id', schoolId)
            .single();
        if (!settings?.auto_glosa_enabled) return null;

        const firstYellow = reasons.find((r) => r.level === 'amarillo' && r.code);
        const glosaReason: GlosaReason = firstYellow?.code
            ? AMARILLO_TO_GLOSA[firstYellow.code] ?? 'OTRO'
            : 'OTRO';

        return await createGlosa(null, paymentId, glosaReason, firstYellow?.detail ?? null);
    } catch (err) {
        (log ?? console).warn?.({ err, paymentId }, '[glosa] auto-create-from-reasons falló');
        return null;
    }
}
