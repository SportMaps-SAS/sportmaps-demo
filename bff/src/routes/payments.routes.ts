/**
 * payments.routes — Pagos de escuela via Wompi.
 *
 * Reemplaza la ruta antigua /api/v1/payments (pasarela legacy).
 * Endpoints:
 *  - POST /api/v1/payments/create-session
 *      Crea o reutiliza un payment_link para un pago de escuela
 *      y devuelve la `reference` que el frontend pasara al Widget Wompi.
 *  - GET /api/v1/payments/link/:token
 *      Pagina publica de informacion del enlace de pago (sin auth).
 */

import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import crypto from 'crypto';
import { supabase } from '../config/supabase';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middlewares/authMiddleware';
import {
    generateReference, copToCents, assertUserNotBlocked, UserPaymentBlockedError,
    signIntegrity, wompiCredsFrom,
} from '../services/wompi.service';
import { generateMpReference } from '../services/mercadopago.service';
import { resolveProvider, type PaymentProvider } from '../services/payment-provider.resolver';
import { extractReceipt } from '../services/ocr.service';
import { evaluateVerdict, normalizeReference } from '../services/receipt-verdict';
import { CLAVES_MOTIVO } from '../services/motivos-de-cobro';
import { buildVerdictContext } from '../services/receipt-context.service';
import { debitoEnCurso, MENSAJE_DEBITO_EN_CURSO } from '../services/autopay.service';
import { saldoPorCobrar, ESTADOS_PAGABLES_EN_LINEA } from '../utils/saldo-cobro';
import { validarLlaveCheckoutEscuela, MENSAJE_CHECKOUT_NO_DISPONIBLE } from '../services/wompi-llave-checkout.guard';

const router = Router();

const CreateSessionSchema = z.object({
    paymentId: z.string().uuid(),
    enrollmentId: z.string().uuid().optional(),
    preferredProvider: z.enum(['wompi', 'mercadopago']).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /create-session — Crea referencia Wompi para un pago de escuela
// ─────────────────────────────────────────────────────────────────────────────
// El frontend recibe { reference, amountInCents, publicKey, signature } y abre el
// Widget Wompi. Llave pública y firma salen SIEMPRE de aquí (mismo par de
// credenciales); el frontend ya no usa VITE_WOMPI_PUBLIC_KEY ni la Edge Function.
// Validamos: pago existe, pertenece a la escuela, esta en estado pagable,
// la escuela tiene Wompi habilitado, y no existe link activo previo.
router.post(
    '/create-session',
    requireAuth,
    requireRole('owner', 'admin', 'school_admin', 'parent', 'athlete'),
    async (req: AuthenticatedRequest, res: Response) => {
        try {
            const parsed = CreateSessionSchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({
                    error: 'Datos invalidos',
                    details: parsed.error.issues,
                });
            }

            const { paymentId, enrollmentId, preferredProvider } = parsed.data;
            const { schoolId } = req;

            // 0. Lock de negocio: si el usuario tiene pagos pendientes de revision,
            // no puede iniciar ningun nuevo checkout hasta que el negocio destrabe.
            try {
                await assertUserNotBlocked(req.user.id);
            } catch (err) {
                if (err instanceof UserPaymentBlockedError) {
                    return res.status(409).json({
                        error: err.message,
                        code: err.code,
                        details: err.details,
                    });
                }
                throw err;
            }

            // 1. Pago debe existir y pertenecer a la escuela del request
            const { data: payment, error: paymentErr } = await supabase
                .from('payments')
                .select('id, amount, amount_paid, early_payment_discount_applied, status, concept, child_id, user_id, parent_id, school_id, requires_review')
                .eq('id', paymentId)
                .eq('school_id', schoolId)
                .single();

            if (paymentErr || !payment) {
                return res.status(404).json({ error: 'Pago no encontrado.' });
            }

            // 1.a IDOR check: usuarios no-staff (parent/athlete) solo pueden
            // pagar pagos donde figuran como parent_id o user_id. Sin esto,
            // un padre podia pagar la deuda de otro padre en la misma escuela
            // si conocia el paymentId.
            const STAFF_ROLES = new Set(['owner', 'admin', 'super_admin', 'school_admin']);
            const isStaff = STAFF_ROLES.has(req.role);
            if (!isStaff) {
                const callerId = req.user.id;
                const payerIds = [(payment as any).parent_id, (payment as any).user_id].filter(Boolean);
                let allowed = payerIds.includes(callerId);

                // Fallback por tutela: el cobro puede haber nacido sin parent_id (bug del
                // generador, ver enrollmentBilling.createPendingPayment) y entonces
                // payerIds queda vacío y ni el propio acudiente puede pagar. Se acepta si
                // el menor del cobro es hijo del caller — es la MISMA noción de propiedad,
                // verificada contra children, no un relajo del control.
                if (!allowed && (payment as any).child_id) {
                    const { data: child } = await supabase
                        .from('children')
                        .select('parent_id')
                        .eq('id', (payment as any).child_id)
                        .maybeSingle();
                    if ((child as any)?.parent_id === callerId) {
                        allowed = true;
                        req.log?.warn(
                            { paymentId, callerId, childId: (payment as any).child_id },
                            'create-session: pago sin parent_id, autorizado por tutela del menor',
                        );
                    }
                }

                if (!allowed) {
                    req.log?.warn(
                        { paymentId, callerId, payerIds },
                        'create-session: caller no es payer del pago',
                    );
                    return res.status(403).json({
                        error: 'No tienes permiso para pagar este registro.',
                    });
                }
            }

            // 1.b Lock especifico al pago
            if ((payment as any).requires_review) {
                return res.status(409).json({
                    error: 'Este pago esta bloqueado pendiente de revision del negocio.',
                    code: 'PAYMENT_REQUIRES_REVIEW',
                });
            }

            // 2. Estado pagable. 'partial' también (2026-10-14): un pago en línea con
            //    un link de antes de la mora deja el cobro parcial y falta el saldo.
            if (!ESTADOS_PAGABLES_EN_LINEA.includes(payment.status)) {
                return res.status(400).json({
                    error: `Este pago no se puede procesar (estado actual: ${payment.status}).`,
                });
            }

            // 2.b Débito automático en vuelo (§7.3 del spec de débito): el enlace del
            //     débito es 'pending' del mismo cobro, así que el reuso de abajo se lo
            //     entregaría al Widget. Si se rechaza, la familia vuelve a pagar aquí.
            if (await debitoEnCurso(paymentId)) {
                return res.status(409).json({ error: MENSAJE_DEBITO_EN_CURSO, code: 'autopay_in_progress' });
            }

            // 3. Resolver provider de pago para esta escuela.
            //    El resolver es la ÚNICA autoridad: decide según schools.payment_mode
            //    ('direct' = cuenta propia, 'aggregator' = llaves de ENV, 'unset' = bloqueada).
            //
            //    Se eliminó el fallback legacy a school_settings.wompi_enabled: ese flag
            //    hacía que una escuela BLOQUEADA igual eligiera 'wompi', y la firma la
            //    emite la Edge Function con las llaves de ENV — que son de una escuela
            //    real. O sea el flag salteaba el fail-closed y le ruteaba el dinero a la
            //    cuenta comercial de otra escuela. wompi_enabled queda solo como control
            //    de UI. Ref: docs/payments-connected-accounts-fase0-cierre.md §2 ter.
            const resolved = await resolveProvider({ schoolId, preferredProvider });

            const { data: settings } = await supabase
                .from('school_settings')
                .select('online_fee_pct, fee_payer')
                .eq('school_id', schoolId)
                .single();

            if (!resolved) {
                return res.status(400).json({
                    error: 'Esta escuela todavía no tiene su cuenta de pagos conectada, '
                        + 'así que no puede recibir pagos online. Comunícate con la escuela '
                        + 'para pagar por otro medio.',
                    code: 'payment_account_not_connected',
                });
            }

            const provider: PaymentProvider = resolved.provider;

            // 3.b Wompi: llave pública y firma de integridad salen del MISMO par de
            //     credenciales que resolvió el BFF, o no hay checkout (fail-closed).
            //     Dynasty 2026-10-05: el BFF de dev devolvió su pub_test_ (sandbox
            //     11981889) y la Edge Function firmó con el secret de producción →
            //     "La firma es inválida". Ver services/wompi-llave-checkout.guard.ts.
            const wompiCreds = provider === 'wompi' ? wompiCredsFrom(resolved) : null;
            if (provider === 'wompi') {
                const llave = validarLlaveCheckoutEscuela(resolved);
                const code = !llave.ok ? llave.code
                    : !wompiCreds?.integritySecret ? 'wompi_sin_integrity_secret' : null;
                if (code) {
                    req.log?.error(
                        { schoolId, paymentId, source: resolved.source, code, motivo: !llave.ok ? llave.motivo : undefined },
                        'create-session: checkout Wompi bloqueado (llave/firma no confiables, fail-closed)',
                    );
                    return res.status(503).json({ error: MENSAJE_CHECKOUT_NO_DISPONIBLE, code });
                }
            }

            const feePct = Number(settings?.online_fee_pct ?? 3);

            // 4. Reutilizar link activo (idempotencia — evita doble cobro accidental).
            //    Consulta y respuesta factorizadas para reusar tambien en el 23505.
            // Reusar solo un link del MISMO provider — si no, un checkout Wompi
            // reutilizaba un link MP pendiente (y viceversa) → ref de otro provider
            // → wompi-sign 404 "Reference no encontrada".
            const fetchActiveLink = () => supabase
                .from('payment_links')
                .select('id, status, expires_at, payment_provider, provider_reference, wompi_reference, gross_amount, base_amount, sportmaps_fee, fee_pct')
                .eq('payment_id', paymentId)
                .eq('payment_provider', provider)
                .eq('status', 'pending')
                .gte('expires_at', new Date().toISOString())
                .maybeSingle();

            // Firma de integridad del Widget, calculada en el BFF con el integrity secret
            // del MISMO comercio cuya llave pública se devuelve: cuenta propia ('direct',
            // payment_provider_secrets) o llaves de ENV ('aggregator', WOMPI_PUBLIC_KEY +
            // WOMPI_INTEGRITY_SECRET del mismo Render). Antes, en 'aggregator', firmaba la
            // Edge Function con su propio secret: llave de un lado y firma de otro, que es
            // justo lo que se cruzó cuando la llave venía de otro ambiente.
            // wompiCreds.integritySecret ya se verificó en 3.b, así que no lanza.
            const signFor = (reference: string, amountInCents: number): string | null => {
                if (provider !== 'wompi' || !wompiCreds) return null;
                return signIntegrity({ reference, amountInCents }, wompiCreds);
            };

            const reuseResponse = (link: any) => res.status(200).json({
                provider: (link.payment_provider as PaymentProvider) ?? 'wompi',
                publicKey: resolved?.publicKey ?? null,
                sandbox: resolved?.sandbox ?? true,
                reference: link.provider_reference || link.wompi_reference,
                signature: signFor(
                    link.provider_reference || link.wompi_reference,
                    copToCents(Number(link.gross_amount)),
                ),
                amountInCents: copToCents(Number(link.gross_amount)),
                transactionAmount: Number(link.gross_amount),
                grossAmount: Number(link.gross_amount),
                baseAmount: Number(link.base_amount),
                sportmapsFee: Number(link.sportmaps_fee),
                feePct: Number(link.fee_pct),
                reused: true,
            });

            // 5. Calcular montos en el server (NUNCA confiar en el cliente).
            //    Va ANTES del reuso porque hacen falta para decidir si el link vigente
            //    sigue siendo válido.
            //    La base es el SALDO (amount − amount_paid − descuento por pronto
            //    pago), no el valor total: un 'partial' cobra solo lo que falta y el
            //    recargo en línea va sobre eso. El chequeo de vigencia del link de
            //    abajo compara `base_amount` contra este mismo saldo.
            const baseAmount = saldoPorCobrar(payment as any);
            if (!(baseAmount > 0)) {
                return res.status(400).json({ error: 'Este cobro no tiene saldo por pagar.', code: 'sin_saldo' });
            }
            const sportmapsFee = Math.round(baseAmount * (feePct / 100));
            const grossAmount = baseAmount + sportmapsFee;

            // 5.b Reusar el link activo SOLO si sus montos siguen vigentes.
            //
            //     El link congela `fee_pct` y `base_amount` al crearse y vive 72h. Si la
            //     escuela cambia `online_fee_pct` (o cambia el monto del cobro) dentro de esa
            //     ventana, devolver la fila vieja hace que el Widget cobre la tarifa anterior
            //     mientras la UI muestra la nueva — sin error visible en ningún lado.
            //     Caso real (Dynasty, link creado 2026-07-31 con fee_pct=0): siguió abriendo
            //     el checkout en $180.000 después de subir la tarifa a 5% ($189.000).
            //     Si quedó obsoleto se expira y se crea uno nuevo con los montos vigentes.
            //     También cubre la mora (2026-10-14): `apply_late_fees()` suma el recargo
            //     a `payments.amount`, así que un link de antes de la mora queda con la
            //     base vieja y cobraría de menos.
            const linkObsoleto = (link: any) => linkDesactualizado(link, feePct, baseAmount);
            const expirarLink = (linkId: string) => supabase
                .from('payment_links')
                .update({ status: 'expired', updated_at: new Date().toISOString() })
                .eq('id', linkId)
                .eq('status', 'pending');

            const { data: existingLink } = await fetchActiveLink();
            if (existingLink && (existingLink.provider_reference || existingLink.wompi_reference)) {
                const { staleFee, staleBase } = linkObsoleto(existingLink);

                if (!staleFee && !staleBase) {
                    return reuseResponse(existingLink);
                }

                req.log?.warn(
                    {
                        paymentId,
                        linkId: existingLink.id,
                        linkFeePct: Number(existingLink.fee_pct),
                        currentFeePct: feePct,
                        linkBaseAmount: Number(existingLink.base_amount),
                        currentBaseAmount: baseAmount,
                    },
                    'create-session: link obsoleto (cambió la tarifa o el monto) → se expira y se recrea',
                );

                // Expirarlo libera el único parcial uq_payment_links_one_pending_per_payment
                // para el INSERT de más abajo.
                await expirarLink(existingLink.id);
            }

            // 6. Generar referencia segun provider
            const reference = provider === 'mercadopago'
                ? generateMpReference('school_payment')
                : generateReference('school_payment');

            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72h

            // 6.b Expirar links 'pending' vencidos por tiempo: no son un checkout
            //     activo y chocarian con el unico parcial (H-05). Solo toca los ya
            //     vencidos, nunca uno vigente creado por otra request.
            await supabase
                .from('payment_links')
                .update({ status: 'expired', updated_at: new Date().toISOString() })
                .eq('payment_id', paymentId)
                .eq('status', 'pending')
                .lt('expires_at', new Date().toISOString());

            // 7. Persistir payment_link con columnas genericas + legacy mirror
            const insertarLink = () => supabase
                .from('payment_links')
                .insert({
                    payment_id: paymentId,
                    school_id: schoolId,
                    token,
                    payment_provider: provider,
                    provider_reference: reference,
                    wompi_reference: provider === 'wompi' ? reference : null,
                    gross_amount: grossAmount,
                    base_amount: baseAmount,
                    sportmaps_fee: sportmapsFee,
                    fee_pct: feePct,
                    status: 'pending',
                    expires_at: expiresAt.toISOString(),
                    failed_attempts: 0,
                    enrollment_id: enrollmentId || null,
                });
            let { error: linkErr } = await insertarLink();

            if (linkErr && (linkErr as any).code === '23505') {
                // 23505: otra request concurrente ya creo la link 'pending' para esta
                // deuda (carrera H-05, bloqueada por uq_payment_links_one_pending_per_payment).
                // Reusar la existente en vez de crear una segunda referencia pagable…
                // pero con el MISMO chequeo de vigencia que el reuso de arriba: la
                // ganadora pudo leer el cobro antes de que `apply_late_fees()` le
                // sumara la mora (o con otra tarifa). Si quedó obsoleta se expira y se
                // reintenta el INSERT una sola vez con los montos vigentes.
                const { data: raced } = await fetchActiveLink();
                if (raced && (raced.provider_reference || raced.wompi_reference)) {
                    // El monto vigente se relee: si ESTA request es la que leyó el
                    // cobro antes de la mora, la ganadora tiene razón y no se pisa.
                    const { data: fresco } = await supabase
                        .from('payments')
                        .select('amount, amount_paid, early_payment_discount_applied')
                        .eq('id', paymentId)
                        .maybeSingle();
                    const montoVigente = fresco && Number.isFinite(Number((fresco as any).amount))
                        ? saldoPorCobrar(fresco as any)
                        : baseAmount;
                    const decision = decidirLinkDeCarrera(raced, { feePct, baseAmount, montoVigente });
                    if (decision === 'reusar') {
                        req.log?.info({ paymentId }, 'create-session: carrera resuelta, reusando link existente');
                        return reuseResponse(raced);
                    }
                    req.log?.warn(
                        {
                            paymentId,
                            linkId: raced.id,
                            linkFeePct: Number(raced.fee_pct),
                            currentFeePct: feePct,
                            linkBaseAmount: Number(raced.base_amount),
                            currentBaseAmount: baseAmount,
                            montoVigente,
                            decision,
                        },
                        'create-session: link de la carrera obsoleto (cambió la tarifa o el monto)',
                    );
                    if (decision === 'monto_cambio') {
                        return res.status(409).json({
                            error: 'El valor de este cobro acaba de cambiar. Vuelve a intentar el pago.',
                            code: 'payment_amount_changed',
                        });
                    }
                    await expirarLink(raced.id);
                    ({ error: linkErr } = await insertarLink());
                }
            }

            if (linkErr) {
                req.log?.error({ err: linkErr }, 'Error inserting payment_link');
                return res.status(500).json({ error: 'Error al registrar el enlace de pago.' });
            }

            return res.status(201).json({
                provider,
                publicKey: resolved?.publicKey ?? null,
                sandbox: resolved?.sandbox ?? true,
                reference,
                signature: signFor(reference, copToCents(grossAmount)),
                amountInCents: copToCents(grossAmount),
                transactionAmount: grossAmount,
                grossAmount,
                baseAmount,
                sportmapsFee,
                feePct,
                token,
            });
        } catch (err: any) {
            req.log?.error({ err }, 'Error creating Wompi payment session');
            return res.status(500).json({
                error: err.message || 'Error interno al crear sesion de pago.',
            });
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /link/:token — Info publica de un payment_link (sin auth)
// ─────────────────────────────────────────────────────────────────────────────
// Usado por la pagina de confirmacion despues de Wompi redirect.
router.get('/link/:token', async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { token } = req.params;

        const { data: link, error } = await supabase
            .from('payment_links')
            .select(`
                id, payment_id, school_id, token,
                gross_amount, base_amount, sportmaps_fee, fee_pct,
                status, expires_at, paid_at, created_at, wompi_reference
            `)
            .eq('token', token)
            .single();

        if (error || !link) {
            return res.status(404).json({ error: 'Enlace de pago no encontrado.' });
        }

        const { data: payment } = await supabase
            .from('payments')
            .select('id, concept, child_id, user_id, due_date, status')
            .eq('id', link.payment_id)
            .single();

        let childName: string | null = null;
        if (payment?.child_id) {
            const { data: child } = await supabase
                .from('children')
                .select('full_name')
                .eq('id', payment.child_id)
                .single();
            childName = child?.full_name || null;
        }

        const { data: school } = await supabase
            .from('schools')
            .select('name')
            .eq('id', link.school_id)
            .single();

        return res.json({
            linkStatus: link.status,
            wompiReference: link.wompi_reference,
            grossAmount: link.gross_amount,
            baseAmount: link.base_amount,
            sportmapsFee: link.sportmaps_fee,
            feePct: link.fee_pct,
            expiresAt: link.expires_at,
            paidAt: link.paid_at,
            concept: payment?.concept || null,
            childName,
            schoolName: school?.name || null,
            paymentStatus: payment?.status || null,
            nextDueDate: payment?.due_date || null,
        });
    } catch (err: any) {
        req.log?.error({ err }, 'Error fetching payment link');
        return res.status(500).json({ error: 'Error al obtener informacion del pago.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /extract-receipt — Extrae monto/fecha/banco de un comprobante via LLM Vision
// ─────────────────────────────────────────────────────────────────────────────
// Usado por el frontend al subir un comprobante manual. El cliente envia la
// imagen en base64 y recibe JSON estructurado que se persiste en payments.ocr_*.
//
// Seguridad:
//  - rate-limit dedicado: 10/min por IP (encima del paymentLimiter del router).
//  - imageBase64 acotado a ~6 MB binario para evitar memory exhaustion / abuso
//    del free tier de Groq.
//  - mimeType validado contra whitelist (imagenes y PDF).

// ~8 MB de base64 == ~6 MB de imagen binaria. Suficiente para PNG/JPG de un
// comprobante movil; bloquea uploads disenados para reventar memoria.
const MAX_BASE64_LENGTH = 8 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'] as const;

const ExtractSchema = z.object({
    imageBase64: z.string()
        .min(100, 'Imagen demasiado pequena')
        .max(MAX_BASE64_LENGTH, 'Imagen demasiado grande (max ~6 MB).'),
    mimeType: z.enum(ALLOWED_MIME_TYPES).optional(),
    // Contexto opcional para computar el veredicto (Fase 2, modo sombra). Si no
    // viene schoolId, el endpoint responde el OcrResult como antes (verdict null) —
    // backward-compatible con callers viejos.
    schoolId: z.string().uuid().optional(),
    expectedAmount: z.number().nonnegative().optional(),
    conceptKind: z.enum(['fixed', 'lenient']).optional(),
    // SHA-256 hex de la imagen ORIGINAL (calculado en el front antes del PDF→PNG).
    imageSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    // En el flujo de update: pago a excluir del dedup.
    paymentId: z.string().uuid().optional(),
    // Categoría del cobro que se está pagando: decide qué llaves restringidas
    // (`payment_accounts[].only_for`) valen como destino. Con paymentId se lee
    // del pago; sin ninguno de los dos, las llaves restringidas dan amarillo.
    // Del catálogo único (motivos-de-cobro.ts): antes eran 10 a mano y un
    // `clase_prueba` desde la app daba 400 (2026-10-30).
    paymentCategory: z.enum(CLAVES_MOTIVO).optional(),
    concept: z.string().max(300).optional(),
});

const ocrLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas peticiones de OCR. Intenta en 1 minuto.' },
});

// Cliente liviano con ANON key, solo para validar JWTs en endpoints userspace
// (evita depender del SUPABASE_SERVICE_ROLE_KEY que puede estar como placeholder
// en local). El SERVICE_ROLE_KEY es necesario para acceder a tablas con RLS,
// pero no para hacer auth.getUser() que solo decodea el JWT contra /auth/v1/user.
import { createClient } from '@supabase/supabase-js';
const supabaseAnonClient = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_ANON_KEY || '',
    { auth: { autoRefreshToken: false, persistSession: false } },
);

router.post(
    '/extract-receipt',
    ocrLimiter,
    // Auth ligera: solo valida el JWT (no consulta school_members). Es suficiente
    // porque este endpoint solo procesa una imagen — no toca data de la escuela.
    async (req: AuthenticatedRequest, res: Response) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader?.startsWith('Bearer ')) {
                return res.status(401).json({ error: 'Token de autorizacion requerido.' });
            }
            const token = authHeader.split(' ')[1];
            const { data: { user }, error: authError } = await supabaseAnonClient.auth.getUser(token);
            if (authError || !user) {
                req.log?.warn({ err: authError }, '[OCR] JWT validation failed');
                return res.status(401).json({ error: 'Token invalido o expirado.' });
            }

            const parsed = ExtractSchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({
                    error: 'Datos invalidos',
                    details: parsed.error.issues,
                });
            }
            const { imageBase64, mimeType, schoolId, expectedAmount, imageSha256, paymentId, paymentCategory, concept } = parsed.data;

            const result = await extractReceipt(imageBase64, mimeType || 'image/png');

            // Hash: preferimos el que mandó el front (SHA-256 del File original,
            // determinista cross-device). Si no vino, lo calculamos del base64
            // recibido — ojo: para PDFs eso ya es el PNG convertido, otro espacio
            // de hash. Registramos la fuente para no perseguir fantasmas al calibrar.
            let hash: string | null = imageSha256 ?? null;
            let hashSource: 'client_original' | 'server_base64' | null = imageSha256 ? 'client_original' : null;
            if (!hash) {
                hash = crypto.createHash('sha256').update(imageBase64).digest('hex');
                hashSource = 'server_base64';
            }
            const referenceNorm = normalizeReference(result.reference);

            // Veredicto (modo sombra): solo si hay schoolId para resolver el contexto.
            // Cualquier fallo aquí NO debe tumbar la extracción — degradamos a null.
            let verdict = null as null | ReturnType<typeof evaluateVerdict>;
            if (schoolId) {
                try {
                    const ctx = await buildVerdictContext(schoolId, {
                        referenceNorm,
                        imageSha256: hash,
                        expectedAmount,
                        paymentId,
                        paymentCategory,
                        concept,
                    });
                    verdict = evaluateVerdict(result, ctx);
                } catch (err) {
                    req.log?.warn({ err }, '[OCR] no se pudo computar el veredicto; se devuelve sin él');
                }
            }

            // SEG-26 (2026-10-05): el endpoint valida solo el JWT y acepta
            // cualquier `schoolId`. `DESTINO_NO_COINCIDE.detail.comparedAgainst`
            // traía TODAS las cuentas bancarias de la escuela del `schoolId`, así
            // que cualquier autenticado leía las cuentas de cualquier escuela
            // mandando su id. `comparedAgainst` existe solo para calibrar el modo
            // sombra server-side; no tiene por qué viajar al cliente. Se poda del
            // detail antes de responder (se conserva el resto: expected/extracted,
            // destination, etc. — nada de otra escuela).
            const safeReasons = verdict?.reasons?.map((r) => {
                if (r.detail && typeof r.detail === 'object' && 'comparedAgainst' in r.detail) {
                    const { comparedAgainst: _omit, ...restDetail } = r.detail as Record<string, unknown>;
                    return { ...r, detail: restDetail };
                }
                return r;
            }) ?? null;

            return res.json({
                ...result,
                referenceNorm,
                imageSha256: hash,
                imageSha256Source: hashSource,
                verdict: verdict?.verdict ?? null,
                verdictReasons: safeReasons,
            });
        } catch (err: any) {
            req.log?.error({ err }, 'Error extracting receipt with LLM Vision');
            return res.status(502).json({
                error: 'No se pudo procesar el comprobante con OCR.',
                detail: err.message,
            });
        }
    },
);

/**
 * ¿El link `pending` quedó con montos viejos? Congela `fee_pct` y `base_amount`
 * al crearse: si la escuela cambió la tarifa, o el cobro cambió de valor (la
 * mora de `apply_late_fees()` se SUMA a `payments.amount`, 2026-10-14), cobrar
 * con ese link recibe un valor que ya no es el que se debe. Pura.
 */
export function linkDesactualizado(
    link: { fee_pct: unknown; base_amount: unknown },
    feePct: number,
    baseAmount: number,
): { staleFee: boolean; staleBase: boolean } {
    return {
        staleFee: Number(link.fee_pct) !== feePct,
        staleBase: !(Math.abs(Number(link.base_amount) - baseAmount) <= 0.5),
    };
}

/**
 * Carrera H-05 (23505 al insertar): qué hacer con el link que insertó la otra
 * request. Mismo criterio de vigencia que el reuso normal, contra el monto
 * RELEÍDO del cobro (`montoVigente`):
 *   · 'reusar'       — el link de la ganadora vale con la tarifa y el monto vigentes.
 *   · 'monto_cambio' — ESTA request leyó un monto que ya no es el del cobro
 *                      (p. ej. antes de la mora): no se crea nada, el cliente reintenta.
 *   · 'recrear'      — el link de la ganadora quedó viejo: se expira y se reinserta.
 * Pura.
 */
export function decidirLinkDeCarrera(
    raced: { fee_pct: unknown; base_amount: unknown },
    e: { feePct: number; baseAmount: number; montoVigente: number },
): 'reusar' | 'monto_cambio' | 'recrear' {
    const vigente = linkDesactualizado(raced, e.feePct, e.montoVigente);
    if (!vigente.staleFee && !vigente.staleBase) return 'reusar';
    if (Math.abs(e.montoVigente - e.baseAmount) > 0.5) return 'monto_cambio';
    return 'recrear';
}

export default router;
