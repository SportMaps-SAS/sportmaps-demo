/**
 * useReceiptValidator.ts
 *
 * Validador de comprobantes de pago via LLM Vision en el BFF.
 * Reemplaza el Tesseract.js anterior — el LLM lee fuentes raras de
 * cualquier banco colombiano (DaviPlata, Nequi, Bancolombia, BBVA, etc.)
 * con mucha mayor precision.
 *
 * Flujo:
 *   1. Si es PDF, render la primera pagina a imagen via pdfjs-dist + canvas
 *   2. Convertir blob a base64
 *   3. Llamar POST /api/v1/payments/extract-receipt
 *   4. Validar resultado:
 *      - Fecha dentro de la ventana permitida (por defecto hoy o ayer en Bogota)
 *        -> bloquea si es mas vieja, independiente del conceptKind (evita reuso
 *        de comprobantes vencidos). Una fecha futura tambien bloquea. Se desactiva
 *        entera con dateMode:'any' para el registro manual desde el panel de la
 *        escuela, donde el soporte ya le llego por WhatsApp dias antes.
 *      - Moneda debe ser COP -> SIEMPRE bloquea si OCR detecto otra (USD, etc.)
 *      - Si conceptKind === 'fixed':
 *          * monto debe coincidir con expectedAmount (tolerancia 0.5%)
 *          * exige fecha Y monto detectados (sin advisory en fixed)
 *      - Si conceptKind === 'lenient':
 *          * el monto es advisory (no bloquea)
 *          * si LLM no detecto fecha/monto -> advisory (admin valida visualmente)
 */

import { useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { sha256File } from '@/lib/sha256File';
import { minimoDeAbono } from '@/lib/minimoDeAbono';
import type { PaymentChargeCategory } from '@/lib/payment-accounts';

export type ReceiptVerdict = 'verde' | 'amarillo' | 'rojo';

export interface ReceiptValidationResult {
    valid: boolean;
    extractedDate: string | null;        // ISO yyyy-mm-dd
    extractedAmount: number | null;      // numero, sin formato
    extractedReference: string | null;
    extractedBank: string | null;
    extractedCurrency: string | null;
    rejectionReason: string | null;
    /** Provider que respondio (groq/openai/gemini), util para debug */
    provider?: string;
    /** Respuesta cruda del LLM (string JSON o texto). Se persiste en
     *  payments.ocr_raw_response para auditoria/forensia. */
    rawResponse?: string;
    // ── Campos v2 extraídos (schema nuevo). Opcionales; se persisten en payments. ──
    extractedTime?: string | null;
    extractedDestination?: string | null;
    extractedDestinationName?: string | null;
    extractedOriginName?: string | null;
    // ── Fase 2 (modo sombra): veredicto de reglas + dedup. Todos opcionales para
    //    no romper los literales de fallback/reset que construyen este objeto. ──
    /** Veredicto determinístico computado por el BFF. null si no se envió schoolId. */
    verdict?: ReceiptVerdict | null;
    /** Razones {check, code, level, message, detail} del veredicto. */
    verdictReasons?: unknown[] | null;
    /** Referencia normalizada para dedup. */
    referenceNorm?: string | null;
    /** SHA-256 de la imagen original (para persistir en el pago). */
    imageSha256?: string | null;
    /** Origen del hash: 'client_original' | 'server_base64'. */
    imageSha256Source?: string | null;
}

export type ConceptKind = 'fixed' | 'lenient';

/**
 * 'window' → el comprobante debe caer dentro de la ventana permitida hacia atrás
 *            (`dateWindowDays`, default 1 = hoy o ayer en Bogotá). Flujo del
 *            acudiente: paga y sube casi en el momento, pero puede transferir de
 *            noche y subir a la mañana siguiente. Más viejo que eso es reuso.
 * 'any'    → no se bloquea por fecha. Flujo de la ESCUELA registrando desde su
 *            panel un pago que ya recibió: el soporte le llegó por WhatsApp días
 *            antes y solo se está adjuntando como evidencia. El veredicto del BFF
 *            igual marca FECHA_FUERA_VENTANA en amarillo (informativo) y el dedup
 *            por referencia/hash sigue vivo.
 *
 * En modo 'window' una fecha futura también bloquea (no existe comprobante de
 * mañana). En 'any' no se mira la fecha en absoluto.
 */
export type DateMode = 'window' | 'any';

/** Días hacia atrás aceptados por defecto en modo 'window' (1 = hoy o ayer). */
export const DEFAULT_DATE_WINDOW_DAYS = 1;

export interface ValidationOptions {
    expectedAmount?: number;
    conceptKind?: ConceptKind;
    /** Si la escuela permite abonos (school_settings.allow_installments).
     *  Si es false, un comprobante por MENOS del esperado se BLOQUEA
     *  (no se puede pagar parcial). Default: false (más restrictivo). */
    allowPartial?: boolean;
    /** Monto mínimo por abono (school_settings.min_installment_amount).
     *  Solo aplica cuando allowPartial=true. 0 = sin mínimo. */
    minPartialAmount?: number;
    /** `abono_minimo_pct` del ítem de servicio al que está ligado el cobro. Sin él
     *  (cobros de mensualidad, escuelas sin ítems) rige `minPartialAmount` como siempre.
     *  Ver lib/minimoDeAbono: una sola regla para la app y el bot. */
    abonoMinimoPctItem?: number | null;
    /** Escuela del cobro. Si se pasa, el BFF computa el veredicto (modo sombra). */
    schoolId?: string;
    /** Pago en edición (update flow), para excluirlo del dedup en el BFF. */
    paymentId?: string;
    /** Categoría del cobro (mensualidad/inscripcion/...): el BFF solo acepta una
     *  llave restringida (`only_for`) como destino del cobro de su concepto. */
    /** Misma lista que el z.enum del BFF (payments.routes.ts /validate-receipt). */
    paymentCategory?: PaymentChargeCategory;
    /** Ver DateMode. Default 'window' (flujo del acudiente). */
    dateMode?: DateMode;
    /**
     * Si un veredicto ROJO bloquea la subida en el momento del OCR. Default true.
     *
     * Se pasa `false` en el flujo de la ESCUELA registrando un pago que ya recibió:
     * ahí el admin es la autoridad y decide con el soporte a la vista, así que el
     * rojo se muestra pero no le cierra la puerta. Para el acudiente sí bloquea:
     * antes un comprobante a una cuenta ajena subía como válido y se quedaba
     * esperando validación sin que nadie le dijera qué estaba mal.
     */
    blockOnRedVerdict?: boolean;
    /** Días hacia atrás aceptados en modo 'window'. Default 1 (hoy o ayer). */
    dateWindowDays?: number;
}

interface OcrResponse {
    amount: number | null;
    currency: string | null;
    date: string | null;
    bank: string | null;
    reference: string | null;
    provider?: string;
    rawResponse?: string;
    time?: string | null;
    destination?: string | null;
    destinationName?: string | null;
    originName?: string | null;
    // Fase 2 (modo sombra) — el BFF los agrega cuando recibe schoolId.
    verdict?: ReceiptVerdict | null;
    verdictReasons?: unknown[] | null;
    referenceNorm?: string | null;
    imageSha256?: string | null;
    imageSha256Source?: string | null;
}

// Tolerancia: monto OCR puede diferir del esperado en hasta esto y se considera match.
// Util para variantes de redondeo o cuando el comprobante incluye un peso adicional.
const AMOUNT_TOLERANCE_PCT = 0.5; // 0.5%

export const todayIsoBogota = (): string => {
    // en-CA formatea como YYYY-MM-DD. Intl resuelve la zona correctamente
    // para usuarios en cualquier tz (no solo UTC).
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
};

/** Parsea 'YYYY-MM-DD' a epoch ms UTC (medianoche). null si no es fecha válida. */
const parseIsoDate = (iso: string): number | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return null;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(ms) ? null : ms;
};

/** Días calendario entre dos ISO (a - b). null si alguna no parsea.
 *  Positivo = `a` es posterior a `b`. Se compara en UTC-medianoche, así que no
 *  depende del reloj ni de la tz del dispositivo (el "hoy" ya viene en Bogotá). */
const diffDays = (aIso: string, bIso: string): number | null => {
    const a = parseIsoDate(aIso);
    const b = parseIsoDate(bIso);
    if (a === null || b === null) return null;
    return Math.round((a - b) / 86_400_000);
};

const formatCop = (n: number): string =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

/** Forma mínima de una razón de veredicto (viene como jsonb desde el BFF). */
type VerdictReasonLike = { code?: string; level?: string; message?: string; detail?: unknown };

/**
 * Traduce los motivos ROJOS del veredicto a mensajes para quien sube el archivo,
 * nombrando el dato concreto que no cuadró (cuenta destino y titular leídos).
 *
 * FECHA_FUTURA se omite a propósito: en modo 'window' ya lo dice el check local de
 * fecha (duplicaría el mensaje) y en modo 'any' la fecha se ignora deliberadamente
 * porque el LLM confunde DD/MM con MM/DD en comprobantes colombianos.
 */
function redVerdictMessages(
    reasons: unknown,
    read: { destination: string | null; destinationName: string | null },
): string[] {
    if (!Array.isArray(reasons)) return [];
    const out: string[] = [];
    for (const raw of reasons as VerdictReasonLike[]) {
        if (raw?.level !== 'rojo' || !raw?.code) continue;
        switch (raw.code) {
            case 'DESTINO_NO_COINCIDE': {
                const quien = [
                    read.destination ? `cuenta ${read.destination}` : null,
                    read.destinationName ? `a nombre de ${read.destinationName}` : null,
                ].filter(Boolean).join(' ');
                out.push(
                    quien
                        ? `El comprobante muestra un envío a la ${quien}, que no corresponde a las cuentas registradas por la escuela. Verifica los datos de pago de la escuela y transfiere de nuevo.`
                        : 'El comprobante muestra un envío a una cuenta que no está registrada por la escuela. Verifica los datos de pago y transfiere de nuevo.',
                );
                break;
            }
            case 'NOT_A_RECEIPT':
                out.push('El archivo no parece un comprobante de pago.');
                break;
            case 'IS_TRANSACTION_LIST':
                out.push('Subiste una lista de movimientos. Sube el comprobante individual de la transacción.');
                break;
            case 'REFERENCIA_DUPLICADA':
                out.push('La referencia de este comprobante ya se usó en otro pago.');
                break;
            case 'IMAGEN_DUPLICADA':
                out.push('Esta imagen de comprobante ya se había subido antes.');
                break;
            case 'FECHA_FUTURA':
                break;
            default:
                if (raw.message) out.push(raw.message);
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF -> primera pagina como blob de imagen
// ─────────────────────────────────────────────────────────────────────────────
const pdfPageToImageBlob = async (file: File): Promise<Blob> => {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);

    const scale = 2;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;

    return new Promise(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
};

// ─────────────────────────────────────────────────────────────────────────────
// Blob -> base64 (sin prefijo data:)
// ─────────────────────────────────────────────────────────────────────────────
const blobToBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result as string;
            // dataUrl: "data:image/png;base64,XXXX..."
            const base64 = result.includes(',') ? result.split(',')[1] : result;
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });

// ─────────────────────────────────────────────────────────────────────────────
// Hook principal
// ─────────────────────────────────────────────────────────────────────────────
export function useReceiptValidator() {
    const [validating, setValidating] = useState(false);

    const validate = async (
        file: File,
        opts: ValidationOptions = {},
    ): Promise<ReceiptValidationResult> => {
        setValidating(true);

        try {
            // 1) Preparar imagen (PDFs -> rasterizar primera pagina)
            let imageBlob: Blob = file;
            let mimeType: string = file.type || 'image/png';

            if (file.type === 'application/pdf') {
                try {
                    imageBlob = await pdfPageToImageBlob(file);
                    mimeType = 'image/png';
                } catch {
                    return advisory(
                        'No se pudo procesar el PDF. Conviertelo a imagen (JPG/PNG) e intentalo de nuevo.',
                    );
                }
            }

            // Hash de la imagen ORIGINAL (antes del PDF→PNG) para dedup determinista.
            // No bloquea si crypto.subtle no está disponible (contexto no seguro).
            let imageSha256: string | null = null;
            try { imageSha256 = await sha256File(file); } catch { imageSha256 = null; }

            const base64 = await blobToBase64(imageBlob);

            // 2) Llamar al BFF (LLM Vision + veredicto en modo sombra si hay schoolId)
            let ocr: OcrResponse;
            try {
                ocr = await bffClient.post<OcrResponse>('/api/v1/payments/extract-receipt', {
                    imageBase64: base64,
                    mimeType,
                    schoolId: opts.schoolId,
                    expectedAmount: opts.expectedAmount,
                    conceptKind: opts.conceptKind ?? 'lenient',
                    imageSha256: imageSha256 ?? undefined,
                    paymentId: opts.paymentId,
                    paymentCategory: opts.paymentCategory,
                });
            } catch (err: any) {
                console.error('[OCR] error llamando al BFF:', err);
                return advisory(
                    'No pudimos verificar el comprobante automaticamente. Sera revisado manualmente por la administracion.',
                );
            }

            const { amount, date, reference, bank, currency, provider, rawResponse } = ocr;
            // Campos del veredicto (modo sombra). El hash resuelto es el del BFF si lo
            // devolvió, si no el que calculamos localmente.
            const verdict = ocr.verdict ?? null;
            const verdictReasons = ocr.verdictReasons ?? null;
            const referenceNorm = ocr.referenceNorm ?? null;
            const resolvedHash = ocr.imageSha256 ?? imageSha256 ?? null;
            const imageSha256Source = ocr.imageSha256Source ?? (imageSha256 ? 'client_original' : null);
            const extractedTime = ocr.time ?? null;
            const extractedDestination = ocr.destination ?? null;
            const extractedDestinationName = ocr.destinationName ?? null;
            const extractedOriginName = ocr.originName ?? null;

            const v2Fields = {
                extractedTime, extractedDestination, extractedDestinationName, extractedOriginName,
                verdict, verdictReasons, referenceNorm,
                imageSha256: resolvedHash, imageSha256Source,
            };

            // 3) Validacion de fecha (referencia: hoy en Bogota). Independiente del
            //    conceptKind. Evita que se reusen comprobantes viejos para "pagar"
            //    de nuevo, pero tolera la ventana de `dateWindowDays` porque el papa
            //    puede transferir de noche y subir el soporte a la manana siguiente.
            //    En modo 'any' NO se valida fecha en absoluto (ni futura): el LLM
            //    confunde DD/MM con MM/DD en comprobantes colombianos, y un falso
            //    "futuro" bloquearia a la escuela justo donde no queremos validar.
            const today = todayIsoBogota();
            const conceptKind: ConceptKind = opts.conceptKind ?? 'lenient';
            const expected = opts.expectedAmount;
            const errors: string[] = [];

            const dateMode: DateMode = opts.dateMode ?? 'window';
            const windowDays = Math.max(0, opts.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS);
            // Positivo = comprobante posterior a hoy (futuro); negativo = mas viejo.
            const ageDays = date ? diffDays(date, today) : null;

            if (ageDays !== null && dateMode === 'window' && ageDays > 0) {
                errors.push(
                    `El comprobante tiene fecha futura (${date}). Verifica que sea el archivo correcto.`,
                );
            } else if (ageDays !== null && dateMode === 'window' && -ageDays > windowDays) {
                errors.push(
                    windowDays === 0
                        ? `El comprobante es del ${date}, pero debe ser de hoy (${today}).`
                        : `El comprobante es del ${date}. Solo aceptamos comprobantes de los últimos ${windowDays === 1 ? '2 días (hoy o ayer)' : `${windowDays + 1} días`}.`,
                );
            }

            // 3.b) Validacion de moneda: SIEMPRE bloquea si el OCR detecto una
            //      moneda distinta a COP. Comprobantes en USD u otra moneda
            //      no aplican para pagos en SportMaps Colombia.
            if (currency && currency.toUpperCase() !== 'COP') {
                errors.push(
                    `El comprobante esta en ${currency}, pero solo aceptamos pagos en pesos colombianos (COP).`,
                );
            }

            // 4) Validacion de monto (solo aplica si conceptKind === 'fixed')
            let amountMatches: boolean | null = null;
            if (typeof amount === 'number' && typeof expected === 'number' && expected > 0) {
                const diffPct = Math.abs(amount - expected) / expected * 100;
                amountMatches = diffPct <= AMOUNT_TOLERANCE_PCT;
            }
            // Un comprobante por MÁS del esperado ya NO se bloquea (Monster 2026-11-12): quien abonó
            // y paga el valor completo, o paga de más, sube igual. Queda como aviso y la escuela lo
            // revisa (el excedente lo decide ella). Los otros bloqueos duros (moneda, fecha, cuenta) siguen.
            let avisoMayor: string | null = null;
            if (
                conceptKind === 'fixed' &&
                typeof amount === 'number' &&
                expected &&
                amountMatches === false &&
                amount > expected
            ) {
                avisoMayor = `El comprobante es por ${formatCop(amount)}, mayor al saldo de ${formatCop(expected)}; la escuela lo revisará y te confirmará el excedente.`;
            }

            // Un monto MENOR al esperado sólo es un ABONO válido si la escuela
            // permite pagos parciales. Si NO los permite, se BLOQUEA: el padre
            // debe pagar el valor completo o comunicarse con la escuela.
            // Si los permite, se valida el monto mínimo por abono.
            if (
                conceptKind === 'fixed' &&
                typeof amount === 'number' &&
                expected &&
                amountMatches === false &&
                amount < expected
            ) {
                if (!opts.allowPartial) {
                    errors.push(
                        `El comprobante es por ${formatCop(amount)}, inferior al valor requerido ${formatCop(expected)}. Esta escuela no permite pagos parciales (abonos); paga el valor completo o comunícate con la escuela para gestionar esta situación.`,
                    );
                } else {
                    const minAbono = minimoDeAbono({
                        pctItem: opts.abonoMinimoPctItem,
                        minEscuela: opts.minPartialAmount,
                        precio: expected,
                    });
                    if (minAbono && amount < minAbono) {
                        errors.push(
                            `El abono mínimo permitido es ${formatCop(minAbono)}. El comprobante es por ${formatCop(amount)}.`,
                        );
                    }
                }
            }

            // 4.b) OCR ilegible (no leyó fecha/monto) → NO se bloquea al acudiente.
            //      Con comprobantes v2 el motor de reglas + el admin (o la auto-
            //      aprobación server-side) deciden; un OCR vacío se sube como
            //      advisory y queda en 'awaiting_approval' para revisión. Solo
            //      bloquean los conflictos DUROS de arriba (moneda, fecha vencida,
            //      monto leído que no cuadra). Antes esto hacía un hard-block que
            //      dejaba al papá sin poder pagar cuando el OCR no leía la imagen.
            const ocrUnreadable = !date || typeof amount !== 'number';

            // 5) Veredicto ROJO → se bloquea acá, en el momento del OCR, diciendo
            //    exactamente qué no concuerda. Antes el validador solo miraba fecha,
            //    moneda y monto: nunca leía el veredicto, así que un comprobante
            //    girado a una cuenta ajena subía como válido y se quedaba en la cola
            //    esperando que un humano lo notara.
            if ((opts.blockOnRedVerdict ?? true) && verdict === 'rojo') {
                errors.push(...redVerdictMessages(verdictReasons, {
                    destination: extractedDestination,
                    destinationName: extractedDestinationName,
                }));
            }

            if (errors.length > 0) {
                return {
                    valid: false,
                    extractedDate: date,
                    extractedAmount: amount,
                    extractedReference: reference,
                    extractedBank: bank,
                    extractedCurrency: currency,
                    provider,
                    rawResponse,
                    ...v2Fields,
                    rejectionReason: errors.join(' ') + ' Sube el comprobante correcto.',
                };
            }

            // 6) Si llegamos aqui: o todo coincide, o concept es lenient, o el LLM no detecto algun campo.
            //    Marcamos valid=true (permite subir). El admin valida visualmente.
            return {
                valid: true,
                extractedDate: date,
                extractedAmount: amount,
                extractedReference: reference,
                extractedBank: bank,
                extractedCurrency: currency,
                provider,
                rawResponse,
                ...v2Fields,
                // OCR ilegible: sube igual (advisory), la escuela lo revisará. No es un bloqueo.
                rejectionReason: ocrUnreadable
                    ? 'No pudimos leer todos los datos automáticamente; la escuela revisará tu comprobante.'
                    : avisoMayor,
            };
        } catch (err) {
            console.error('Error en OCR:', err);
            return advisory('Error al analizar el archivo. Intenta de nuevo con una imagen mas nitida.');
        } finally {
            setValidating(false);
        }
    };

    return { validate, validating };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: resultado advisory (no bloquea, marca valid=true)
// ─────────────────────────────────────────────────────────────────────────────
function advisory(reason: string): ReceiptValidationResult {
    return {
        valid: true,
        extractedDate: null,
        extractedAmount: null,
        extractedReference: null,
        extractedBank: null,
        extractedCurrency: null,
        rejectionReason: reason,
    };
}
