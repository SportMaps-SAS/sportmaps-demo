/**
 * receipt-approval.service — Evaluador post-insert de un comprobante (Fase 5).
 *
 * Corre después de que el frontend insertó el pago (patrón /auto-evaluate). Decide,
 * de forma SERVER-AUTHORITATIVE, entre: auto-aprobar / abrir glosa / dejar manual.
 * NO confía en el veredicto ni en los ocr_* que persistió el cliente: para aprobar
 * (mover plata) re-descarga la imagen REAL de storage, recomputa el hash, y re-extrae
 * con DOS providers distintos. Fire-and-forget: nunca rompe el flujo llamante.
 */

import crypto from 'crypto';
import type { Logger } from 'pino';
import { supabase } from '../config/supabase';
import { extractReceiptWithFallback, listConfiguredProviders } from './ocr.service';
import { evaluateVerdict, evaluarEvidenciaAutoAprobacion, normalizeReference } from './receipt-verdict';
import type { VerdictReason } from './receipt-verdict';
import { buildVerdictContext } from './receipt-context.service';
import { autoCreateGlosaFromReasons, maybeAutoCreateGlosa } from './glosa.service';
import { emailClient } from '../utils/emailClient';
import { BrandedEmailTemplates } from '../utils/emailTemplates';
import { saldoPorCobrar } from '../utils/saldo-cobro';
import { destinatarioDelCobro } from '../utils/destinatarioDelCobro';

const fmtCop = (n?: number | null) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

function guessMime(path: string): string {
    const p = path.toLowerCase();
    if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
    if (p.endsWith('.webp')) return 'image/webp';
    if (p.endsWith('.pdf')) return 'application/pdf';
    return 'image/png';
}

type PaymentRow = {
    id: string; school_id: string; status: string; amount: number;
    amount_paid?: number | null; early_payment_discount_applied?: number | null;
    receipt_url: string | null; receipt_image_sha256: string | null;
    parent_id: string | null; user_id?: string | null; child_id: string | null; team_id: string | null;
    concept: string | null; ocr_reference: string | null;
    receipt_verdict: string | null; receipt_verdict_reasons: unknown;
};

/**
 * Lo que el comprobante DEBE decir: el saldo del cobro con el pronto pago
 * descontado (amount − amount_paid − early_payment_discount_applied, la regla
 * de utils/saldo-cobro). Antes se comparaba contra `amount`: con pronto pago
 * (Monster: 5 % hasta el día 5) la familia transfiere $137.750 de un cobro de
 * $145.000, el veredicto salía MONTO_DIFIERE y el comprobante iba a glosa en
 * vez de aprobarse solo. `auto_approve_payment` ya acredita amount − descuento
 * (migración 20261025205952). Sin saldo (cobro raro en 0), `amount`. Pura.
 */
export function montoEsperadoDelComprobante(
    p: Pick<PaymentRow, 'amount' | 'amount_paid' | 'early_payment_discount_applied'>,
): number {
    const saldo = saldoPorCobrar(p);
    return saldo > 0 ? saldo : Number(p.amount) || 0;
}

export interface EvaluateResult {
    action: 'approved' | 'glosa' | 'rejected' | 'none';
    glosaId?: string | null;
    /** Motivo del rechazo automático, listo para mostrar. Solo con action='rejected'. */
    reason?: string;
}

/** Forma mínima de una razón de veredicto tal como se persiste en jsonb. */
type ReasonLike = { code?: string; level?: string; message?: string; detail?: unknown };

/**
 * Traduce los motivos ROJOS a un texto que el acudiente pueda entender, nombrando
 * el dato concreto que no cuadró. Devuelve null si no hay ningún motivo rojo (y por
 * tanto no hay nada que rechazar).
 */
export function redRejectionMessage(reasons: ReasonLike[]): string | null {
    const red = reasons.filter((r) => r?.level === 'rojo' && r?.code);
    if (red.length === 0) return null;

    const parts = red.map((r) => {
        const d = (r.detail ?? {}) as Record<string, unknown>;
        switch (r.code) {
            case 'DESTINO_NO_COINCIDE': {
                const dest = typeof d.destination === 'string' ? d.destination : null;
                return dest
                    ? `el comprobante muestra un envío a la cuenta ${dest}, que no es ninguna de las cuentas registradas por la escuela`
                    : 'el dinero se envió a una cuenta que no está registrada por la escuela';
            }
            case 'NOT_A_RECEIPT':
                return 'el archivo no es un comprobante de pago';
            case 'IS_TRANSACTION_LIST':
                return 'el archivo es una lista de movimientos, no un comprobante individual';
            case 'REFERENCIA_DUPLICADA':
                return 'la referencia de ese comprobante ya se usó en otro pago';
            case 'IMAGEN_DUPLICADA':
                return 'esa imagen de comprobante ya se había subido antes';
            case 'FECHA_FUTURA':
                return 'el comprobante tiene una fecha futura';
            default:
                return r.message || String(r.code);
        }
    });

    return `Rechazado automáticamente: ${parts.join('; ')}.`;
}

/**
 * Rechaza el COMPROBANTE por veredicto ROJO con `reject_payment_receipt`: el
 * cobro vuelve a pending/overdue (la deuda sigue), el motivo queda en
 * `rejection_reason` y la RPC le avisa al acudiente in-app. La RPC exige que el
 * comprobante siga en revisión: si el admin ya lo aprobó o rechazó a mano, no
 * se pisa su decisión.
 *
 * Antes era `status='rejected'` sobre el propio cobro, que lo sacaba de la
 * cartera y del motor de mora (bug del 2026-10-08). Sin la migración
 * 20261008165728 la RPC no existe y el comprobante queda para revisión manual:
 * nunca se vuelve a borrar la deuda.
 *
 * Devuelve null si no había motivo rojo o si la RPC no rechazó nada.
 */
async function autoRejectRed(p: PaymentRow, reasons: ReasonLike[], log?: Logger): Promise<EvaluateResult | null> {
    const message = redRejectionMessage(reasons);
    if (!message) return null;

    const { error } = await supabase.rpc('reject_payment_receipt', {
        p_payment_id: p.id,
        p_reason_code: 'AUTOMATICO',
        p_reason_text: `${message} Revisa los datos de pago de la escuela y vuelve a enviarlo.`,
    });

    if (error) {
        (log ?? console).warn?.(
            { paymentId: p.id, code: (error as { code?: string } | null)?.code, err: error.message },
            '[auto-reject] no se aplicó (el admin ya actuó, falta la migración o falló la RPC) → queda manual',
        );
        return null;
    }

    (log ?? console).info?.({ paymentId: p.id, reason: message }, '[auto-reject] comprobante rechazado por veredicto rojo; el cobro sigue pendiente');
    return { action: 'rejected', reason: message };
}

/** 'HH:MM' actual en Bogotá (para descartar comprobantes con hora futura). */
function horaBogota(): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date());
}

const esManipulacion = (reasons: ReasonLike[]) => reasons.some((r) => r?.code === 'POSIBLE_MANIPULACION');

/**
 * Posible manipulación (inyección de prompt en el comprobante): NO se aprueba,
 * NO se rechaza y NO se abre glosa (la glosa le pediría al acudiente "aclarar",
 * que es darle pistas a quien está probando el sistema). Queda en la cola de
 * revisión manual con el veredicto recomputado por el servidor, para que el
 * admin vea el motivo aunque el cliente hubiera persistido "verde".
 */
async function marcarRevisionManualPorManipulacion(
    p: PaymentRow, reasons: VerdictReason[] | ReasonLike[], log?: Logger,
): Promise<EvaluateResult> {
    const { error } = await supabase
        .from('payments')
        .update({ receipt_verdict: 'amarillo', receipt_verdict_reasons: reasons, receipt_verdict_at: new Date().toISOString() })
        .eq('id', p.id)
        .eq('status', 'awaiting_approval');
    (log ?? console).warn?.(
        { paymentId: p.id, schoolId: p.school_id, persistError: (error as { code?: string } | null)?.code ?? null },
        '[auto-approve] POSIBLE_MANIPULACION en el comprobante → revisión manual',
    );
    return { action: 'none' };
}

/**
 * ¿El monto del cobro lo eligió el navegador? Consulta aparte y tolerante: sin
 * la columna (migración sin aplicar) responde false y todo sigue como antes.
 */
export async function montoElegidoPorElCliente(paymentId: string): Promise<boolean> {
    try {
        const { data, error } = await supabase.from('payments')
            .select('amount_source').eq('id', paymentId).maybeSingle();
        if (error || !data) return false;
        return (data as { amount_source?: string }).amount_source === 'cliente';
    } catch {
        return false;
    }
}

export async function evaluatePaymentReceipt(paymentId: string, log?: Logger): Promise<EvaluateResult> {
    try {
        const { data: pay } = await supabase
            .from('payments')
            .select('id, school_id, status, amount, amount_paid, early_payment_discount_applied, receipt_url, receipt_image_sha256, parent_id, user_id, child_id, team_id, concept, ocr_reference, receipt_verdict, receipt_verdict_reasons')
            .eq('id', paymentId)
            .single();
        if (!pay || (pay as PaymentRow).status !== 'awaiting_approval') return { action: 'none' };
        const p = pay as PaymentRow;

        const { data: settings } = await supabase
            .from('school_settings')
            .select('auto_approve_enabled, auto_approve_max_amount')
            .eq('school_id', p.school_id)
            .single();

        const amount = Number(p.amount);
        const esperado = montoEsperadoDelComprobante(p);
        const cap = Number(settings?.auto_approve_max_amount ?? 0);
        // Monto elegido por el navegador (amount_source='cliente', migración
        // 20261025205952): el comprobante se compararía contra un valor que pone
        // quien paga. Ni se re-lee (no se gasta OCR): lo revisa una persona.
        // `auto_approve_payment` también se niega; esto evita las dos lecturas.
        const autoApproveEligible = !!settings?.auto_approve_enabled && cap > 0 && amount <= cap
            && !(await montoElegidoPorElCliente(paymentId));

        const path = typeof p.receipt_url === 'string' ? p.receipt_url : null;
        const downloadable = !!path && !path.toLowerCase().startsWith('http');
        const mime = downloadable ? guessMime(path!) : '';

        // ── Camino AUTO-APPROVE (solo si elegible + imagen descargable, no PDF) ──
        if (autoApproveEligible && downloadable && mime !== 'application/pdf') {
            const { data: blob, error: dlErr } = await supabase.storage.from('payment-receipts').download(path!);
            if (!dlErr && blob) {
                const buf = Buffer.from(await blob.arrayBuffer());
                const base64 = buf.toString('base64');
                const realHash = crypto.createHash('sha256').update(buf).digest('hex');

                // Fix seguridad: sobrescribe el hash con el REAL. Si choca el índice único
                // (otra fila no-terminal con ese hash) → imagen reusada → NO auto-aprueba.
                if (realHash !== p.receipt_image_sha256) {
                    const { error: upErr } = await supabase
                        .from('payments')
                        .update({ receipt_image_sha256: realHash, receipt_image_sha256_source: 'server_verified' })
                        .eq('id', paymentId);
                    if (upErr) {
                        (log ?? console).warn?.({ paymentId, code: (upErr as { code?: string }).code }, '[auto-approve] hash real duplicado/upd falló → manual');
                        return await glosaFallback(p, log);
                    }
                }

                const providers = listConfiguredProviders();
                // Antes: providers[0] pelado. Si ese provider estaba caido (Groq
                // dando 404), la excepcion mataba la evaluacion entera.
                const attemptA = await extractReceiptWithFallback(providers, base64, mime);
                if (attemptA) {
                    const { provider: providerA, result: ocrA } = attemptA;
                    const ctx = await buildVerdictContext(p.school_id, {
                        referenceNorm: normalizeReference(ocrA.reference),
                        imageSha256: realHash,
                        expectedAmount: esperado,
                        paymentId, // excluir el propio pago del dedup (si no, se marca dup contra sí mismo)
                    });
                    const verdictA = evaluateVerdict(ocrA, ctx);

                    // ROJO recomputado por el servidor (imagen real re-descargada y
                    // re-extraída): rechazo automático. Es el veredicto más confiable
                    // que tenemos, así que aquí no hay razón para dejarlo esperando.
                    if (verdictA.verdict === 'rojo') {
                        const rejected = await autoRejectRed(p, verdictA.reasons, log);
                        if (rejected) return rejected;
                    }

                    if (esManipulacion(verdictA.reasons)) {
                        return await marcarRevisionManualPorManipulacion(p, verdictA.reasons, log);
                    }

                    if (verdictA.verdict === 'verde') {
                        // Sigue exigiendo un provider DISTINTO al que leyó A; lo
                        // único que cambia es que prueba los demás en vez de
                        // rendirse si el segundo de la lista está caído.
                        const attemptB = await extractReceiptWithFallback(
                            providers.filter((x) => x !== providerA), base64, mime,
                        );
                        if (attemptB) {
                            const { provider: providerB, result: ocrB } = attemptB;
                            const sameAmount = ocrA.amount != null && ocrA.amount === ocrB.amount;
                            const sameRef = normalizeReference(ocrA.reference) === normalizeReference(ocrB.reference);
                            // El veredicto lo calcula ESTE código desde los campos
                            // de las dos lecturas; ningún texto del modelo decide.
                            const evidencia = evaluarEvidenciaAutoAprobacion(ocrA, ocrB, ctx, horaBogota());
                            if (evidencia.faltas.includes('posible_manipulacion')) {
                                const verdictB = evaluateVerdict(ocrB, ctx);
                                return await marcarRevisionManualPorManipulacion(p, verdictB.reasons, log);
                            }
                            if (sameAmount && sameRef && !evidencia.ok) {
                                // Las lecturas coinciden pero falta evidencia que el
                                // modelo no pueda "decir" (hora, destino exacto,
                                // referencia con forma bancaria…): sin glosa, a la
                                // cola manual de siempre.
                                (log ?? console).info?.({ paymentId, faltas: evidencia.faltas }, '[auto-approve] evidencia insuficiente → manual');
                                return { action: 'none' };
                            }
                            if (evidencia.ok) {
                                const { data: approved } = await supabase.rpc('auto_approve_payment', { p_payment_id: paymentId });
                                if (approved === true) {
                                    await sendApprovalEmail(p, esperado, log);
                                    (log ?? console).info?.({ paymentId, providerA, providerB }, '[auto-approve] aprobado');
                                    return { action: 'approved' };
                                }
                                return { action: 'none' }; // RPC no-op (el admin ya actuó / carrera)
                            }
                            // Doble extracción inconsistente → LECTURA_INCONSISTENTE → glosa (server reasons)
                            const gid = await autoCreateGlosaFromReasons(paymentId, p.school_id,
                                [{ code: 'LECTURA_INCONSISTENTE', level: 'amarillo', detail: { a: ocrA.amount, b: ocrB.amount } }], log);
                            return { action: gid ? 'glosa' : 'none', glosaId: gid };
                        }
                        // Sin 2º provider no se puede confirmar → no auto-aprueba (manual).
                        return { action: 'none' };
                    }

                    // Verde no confirmado por el servidor → glosa con los motivos REALES.
                    const gid = await autoCreateGlosaFromReasons(paymentId, p.school_id, verdictA.reasons, log);
                    return { action: gid ? 'glosa' : 'none', glosaId: gid };
                }
            }
        }

        // ── Fallback: auto-approve apagado / PDF / no descargable → glosa por veredicto persistido ──
        return await glosaFallback(p, log);
    } catch (err) {
        (log ?? console).warn?.({ err, paymentId }, '[auto-approve] evaluate falló');
        return { action: 'none' };
    }
}

async function glosaFallback(p: PaymentRow, log?: Logger): Promise<EvaluateResult> {
    // Camino sin re-extracción (auto-approve apagado, PDF, o imagen no descargable):
    // se decide con el veredicto ya persistido. Ese veredicto lo computó el BFF en
    // /extract-receipt — el cliente solo lo relaya — y para RECHAZAR el sesgo juega
    // a favor: un cliente hostil nunca se auto-rechaza. Antes un ROJO caía en
    // maybeAutoCreateGlosa, que solo mapea motivos AMARILLOS y además exige
    // auto_glosa_enabled, así que devolvía null y el comprobante se quedaba mudo
    // en la cola esperando a que alguien lo viera.
    const persisted = Array.isArray(p.receipt_verdict_reasons) ? (p.receipt_verdict_reasons as ReasonLike[]) : [];
    if (p.receipt_verdict === 'rojo') {
        const rejected = await autoRejectRed(p, persisted, log);
        if (rejected) return rejected;
    }
    // Posible manipulación: revisión manual, sin glosa al acudiente.
    if (esManipulacion(persisted)) return { action: 'none' };
    const gid = await maybeAutoCreateGlosa(p.id, log);
    return { action: gid ? 'glosa' : 'none', glosaId: gid };
}

/** `pagado`: lo que la familia transfirió (con pronto pago, amount − descuento), no `amount`. */
async function sendApprovalEmail(p: PaymentRow, pagado: number, log?: Logger): Promise<void> {
    try {
        // Sin acudiente, al adulto dueño del cobro (user_id): un atleta adulto con
        // cuenta propia tiene parent_id NULL y antes no recibía el aviso.
        const destinatario = destinatarioDelCobro(p);
        if (!destinatario) return;
        const { data: parent } = await supabase.from('profiles').select('full_name, email').eq('id', destinatario).single();
        if (!parent?.email) return;
        const tpl = await BrandedEmailTemplates.paymentConfirmation({
            parentName: parent.full_name || 'Acudiente',
            amount: fmtCop(pagado),
            concept: p.concept || 'tu pago',
            receiptNumber: p.ocr_reference || String(p.id).slice(0, 8).toUpperCase(),
            schoolId: p.school_id,
        });
        await emailClient.send({ to: parent.email, subject: tpl.subject, html: tpl.html });
    } catch (err) {
        (log ?? console).warn?.({ err, paymentId: p.id }, '[auto-approve] email de aprobación falló');
    }
}
