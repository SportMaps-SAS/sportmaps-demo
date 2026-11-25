/**
 * comprobante-sellado.service — El servidor «sella» el comprobante que subió la
 * familia: lee el archivo GUARDADO, calcula el veredicto con los datos REALES
 * del cobro y lo escribe con service role.
 *
 * Spec: docs/specs/seguridad-veredicto-comprobante-plan.md §3.3.
 *
 * Por qué existe: hasta el 2026-11-25 el veredicto (`receipt_verdict*`), la
 * lectura (`ocr_*`) y la huella (`receipt_image_sha256*`) los escribía el
 * navegador de la familia, con el monto esperado y la categoría que el mismo
 * navegador mandaba a /extract-receipt, sobre los bytes que el navegador
 * eligió y con la huella que decía tener. El `ocr_amount` forjado alimentaba
 * el saldo a favor automático y «Aprobar todos los verdes».
 *
 * Aquí todo sale del servidor:
 *   · el cobro se carga con service role (monto, abonos, pronto pago, categoría);
 *   · el archivo es el que quedó en `payment-receipts` (`receipt_url`);
 *   · la huella es el sha256 de esos bytes;
 *   · UNA lectura con el primer proveedor que responda;
 *   · el veredicto y la escritura van por `estamparComprobante` (el mismo del
 *     bot), con escritura optimista sobre `receipt_url`: si la familia cambió
 *     el archivo en el medio, no se escribe nada.
 *
 * Después sigue `evaluatePaymentReceipt` (auto-aprobar / glosa / rechazo), que
 * ya era server-authoritative. Lo que ve la familia sigue siendo «recibido».
 *
 * Lo llaman: el frontend después de guardar el comprobante
 * (POST /api/v1/payments/:id/sellar-comprobante), la PWA vieja por
 * /glosas/auto-evaluate (delega aquí) y el barrido de receipt-review-alerts.
 */

import crypto from 'crypto';
import type { Logger } from 'pino';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { supabase } from '../config/supabase';
import { clientIp } from '../utils/clientIp';
import { extractReceiptWithFallback, listConfiguredProviders, tipoPorFirma } from './ocr.service';
import type { Verdict } from './receipt-verdict';
import type { EvaluateResult } from './receipt-approval.service';

export const BUCKET_COMPROBANTES = 'payment-receipts';
/** Mismo (cobro, archivo) dentro de esta ventana: no se vuelve a leer. */
export const VENTANA_IDEMPOTENCIA_MS = 10 * 60 * 1000;
/** Un comprobante real pesa menos de 2 MB; esto solo frena archivos que reventarían la memoria o el proveedor. */
export const MAX_BYTES_COMPROBANTE = 12 * 1024 * 1024;
/** Código del motivo cuando el servidor no pudo leer el archivo. No abre glosa (ver `escribirLecturaFallida`). */
export const MOTIVO_LECTURA_FALLIDA = 'LECTURA_FALLIDA';

/**
 * Cupo de las rutas que sellan (/:id/sellar-comprobante y /glosas/auto-evaluate,
 * compartido): cada llamada puede costar una lectura de OCR. 10/min por IP REAL
 * (detrás de Cloudflare, `req.ip` es el borde y juntaría a todas las familias).
 */
export const limiteSellado = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `sellado-${ipKeyGenerator(clientIp(req))}`,
    message: { error: 'Demasiadas peticiones. Intenta en 1 minuto.' },
});

/** Quién pide el sellado: un usuario con sesión, o el sistema (barrido). */
export type QuienSella = { uid: string } | { sistema: true };

export interface CobroParaSellar {
    id: string;
    school_id: string;
    status: string;
    amount: number;
    amount_paid: number | null;
    early_payment_discount_applied: number | null;
    receipt_url: string | null;
    parent_id: string | null;
    user_id: string | null;
    child_id: string | null;
    payment_category: string | null;
    concept: string | null;
}

const COLUMNAS_COBRO =
    'id, school_id, status, amount, amount_paid, early_payment_discount_applied, receipt_url, parent_id, user_id, child_id, payment_category, concept';

export type MotivoSinSello = 'lectura_fallida' | 'comprobante_compartido' | 'archivo_cambio';

export type ResultadoSellado =
    | {
        ok: true;
        /** Veredicto que quedó escrito (null si no se escribió ninguno). */
        verdict: Verdict | null;
        action: EvaluateResult['action'];
        glosaId?: string | null;
        /** La referencia o la imagen ya estaban en otro cobro de la escuela (23505). */
        duplicado?: boolean;
        /** Por qué no se escribió una lectura normal. */
        motivo?: MotivoSinSello;
    }
    | { ok: false; status: 403 | 404 | 409 | 422 | 500; error: string };

/** Dependencias pesadas, cargadas al primer uso (el grafo del bot no entra a quien solo importa este módulo). */
export interface DependenciasSellado {
    estamparComprobante: typeof import('../jobs/whatsapp-queue.job').estamparComprobante;
    evaluatePaymentReceipt: typeof import('./receipt-approval.service').evaluatePaymentReceipt;
    montoEsperadoDelComprobante: typeof import('./receipt-approval.service').montoEsperadoDelComprobante;
}

let depsCargadas: Promise<DependenciasSellado> | null = null;
function dependencias(): Promise<DependenciasSellado> {
    depsCargadas ??= Promise.all([import('../jobs/whatsapp-queue.job'), import('./receipt-approval.service')])
        .then(([wa, ra]) => ({
            estamparComprobante: wa.estamparComprobante,
            evaluatePaymentReceipt: ra.evaluatePaymentReceipt,
            montoEsperadoDelComprobante: ra.montoEsperadoDelComprobante,
        }));
    return depsCargadas;
}

const fallo = (status: 403 | 404 | 409 | 422 | 500, error: string): ResultadoSellado => ({ ok: false, status, error });

/**
 * Respuesta HTTP del sellado (la usan /:id/sellar-comprobante y /glosas/auto-evaluate).
 * Sin motivos del veredicto: el detalle de DESTINO_NO_COINCIDE trae las cuentas de
 * la escuela (SEG-26). La familia ve «recibido»; `duplicado` es lo único que se le
 * avisa aparte. Pura.
 */
export function respuestaDelSellado(r: ResultadoSellado): { status: number; body: Record<string, unknown> } {
    if (!r.ok) return { status: r.status, body: { error: r.error } };
    return {
        status: 200,
        body: { verdict: r.verdict, action: r.action, glosaId: r.glosaId ?? null, duplicado: r.duplicado === true },
    };
}

// ─── Reglas puras ───────────────────────────────────────────────────────────

/**
 * Ruta relativa dentro de `payment-receipts`, o null si `receipt_url` no es una
 * (URL http heredada, vacía, absoluta o con `..`). Pura.
 */
export function rutaDelComprobante(receiptUrl: string | null | undefined): string | null {
    const r = typeof receiptUrl === 'string' ? receiptUrl.trim() : '';
    if (!r) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(r)) return null; // http:, https:, data:…
    if (r.startsWith('/') || r.split('/').includes('..')) return null;
    return r;
}

/** ¿La ruta está en la carpeta de quien llama? Es donde la deja `useStorage` (`{uid}/{archivo}`). Pura. */
export function rutaEsDeLaCarpeta(ruta: string, uid: string): boolean {
    return !!uid && ruta.startsWith(`${uid}/`);
}

/** Tipo por la extensión, solo si los bytes no lo dicen (`tipoPorFirma`). Pura. */
export function tipoPorExtension(ruta: string): string {
    const p = ruta.toLowerCase();
    if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
    if (p.endsWith('.webp')) return 'image/webp';
    if (p.endsWith('.pdf')) return 'application/pdf';
    return 'image/png';
}

// ─── Autorización (igual que las policies de UPDATE de payments) ────────────

/** Administración de la escuela: dueño o miembro activo owner/admin/school_admin/super_admin (user_admin_school_ids). */
async function administraLaEscuela(uid: string, schoolId: string): Promise<boolean> {
    const [{ data: escuela }, { data: miembro }] = await Promise.all([
        supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle(),
        supabase.from('school_members').select('role, status')
            .eq('school_id', schoolId).eq('profile_id', uid).maybeSingle(),
    ]);
    if ((escuela as { owner_id?: string } | null)?.owner_id === uid) return true;
    const m = miembro as { role?: string; status?: string } | null;
    return m?.status === 'active' && ['owner', 'admin', 'school_admin', 'super_admin'].includes(String(m.role));
}

/**
 * Relación de `uid` con el cobro:
 *   · 'familia': `parent_id` o `user_id` es el suyo, o el cobro es de un hijo
 *     suyo (`children.parent_id`). Esto último lo omitía /auto-evaluate (usaba
 *     `parent_id ?? user_id`): un cobro creado por la escuela con `parent_id`
 *     NULL daba 403 silencioso.
 *   · 'admin': administra la escuela del cobro.
 */
export async function relacionConElCobro(p: CobroParaSellar, uid: string): Promise<'familia' | 'admin' | null> {
    if (p.parent_id === uid || p.user_id === uid) return 'familia';
    if (p.child_id) {
        const { data: hijo } = await supabase.from('children').select('parent_id').eq('id', p.child_id).maybeSingle();
        if ((hijo as { parent_id?: string } | null)?.parent_id === uid) return 'familia';
    }
    if (p.school_id && await administraLaEscuela(uid, p.school_id)) return 'admin';
    return null;
}

// ─── Idempotencia en memoria ────────────────────────────────────────────────
// (cobro, archivo) → la promesa del sellado. Dos llamadas seguidas (el frontend
// y la PWA vieja, o un reintento) leen una sola vez. Después de la migración del
// guard se podrá saltar la lectura si `receipt_image_sha256_source='server_verified'`
// y `receipt_verdict_at >= receipt_submitted_at` (§3.3); antes de ella la familia
// puede escribir esas dos columnas, así que no prueban nada.
const enCurso = new Map<string, { desde: number; promesa: Promise<ResultadoSellado> }>();

function limpiarVencidos(ahora: number): void {
    for (const [clave, v] of enCurso) if (ahora - v.desde >= VENTANA_IDEMPOTENCIA_MS) enCurso.delete(clave);
}

/** Solo para pruebas. */
export function _reiniciarSellado(): void {
    enCurso.clear();
    depsCargadas = null;
}

// ─── Sellado ────────────────────────────────────────────────────────────────

/**
 * Sella el comprobante del cobro. Nunca lanza: los errores vuelven como
 * `{ ok: false, status, error }`.
 *
 * `deps` existe para las pruebas; en producción se cargan solas.
 */
export async function sellarComprobante(
    paymentId: string,
    quien: QuienSella,
    log?: Logger,
    deps?: DependenciasSellado,
): Promise<ResultadoSellado> {
    try {
        const { data, error } = await supabase.from('payments').select(COLUMNAS_COBRO).eq('id', paymentId).maybeSingle();
        if (error) {
            (log ?? console).warn?.({ paymentId, err: error.message }, '[sellado] no se pudo leer el cobro');
            return fallo(500, 'No se pudo leer el cobro.');
        }
        if (!data) return fallo(404, 'Cobro no encontrado.');
        const p = data as unknown as CobroParaSellar;

        // Autorización antes que cualquier otra respuesta: a un ajeno no se le
        // cuenta en qué estado está el cobro.
        let relacion: 'familia' | 'admin' | 'sistema' = 'sistema';
        if ('uid' in quien) {
            const r = await relacionConElCobro(p, quien.uid);
            if (!r) return fallo(403, 'No autorizado sobre este cobro.');
            relacion = r;
        }

        if (p.status !== 'awaiting_approval') return fallo(409, 'El cobro no tiene un comprobante por validar.');

        const ruta = rutaDelComprobante(p.receipt_url);
        if (!ruta) {
            // El barrido marca la fila (si no, la reelegiría en cada vuelta); a
            // una persona solo se le responde.
            if (relacion === 'sistema' && p.receipt_url) {
                return await escribirLecturaFallida(p, p.receipt_url, null, 'ruta', log);
            }
            return fallo(422, 'El comprobante no está guardado en el almacenamiento de comprobantes.');
        }
        // La familia sella lo que ELLA subió. Un `receipt_url` apuntado a la
        // carpeta de otra persona (hallazgo D10 del spec) no se lee por su
        // pedido; si quedó así, lo sella el barrido y el dedup de huella lo
        // marca.
        if (relacion === 'familia' && 'uid' in quien && !rutaEsDeLaCarpeta(ruta, quien.uid)) {
            return fallo(422, 'El comprobante no es un archivo que hayas subido tú.');
        }

        const ahora = Date.now();
        limpiarVencidos(ahora);
        const clave = `${p.id}|${ruta}`;
        const previo = enCurso.get(clave);
        if (previo) return await previo.promesa;

        const promesa = sellarArchivo(p, ruta, log, deps).then((r) => {
            // Un error de infraestructura no deja la llave tomada: se puede reintentar.
            if (!r.ok && r.status >= 500) enCurso.delete(clave);
            return r;
        });
        enCurso.set(clave, { desde: ahora, promesa });
        return await promesa;
    } catch (err) {
        (log ?? console).warn?.({ err, paymentId }, '[sellado] falló');
        return fallo(500, 'No se pudo sellar el comprobante.');
    }
}

async function sellarArchivo(
    p: CobroParaSellar,
    ruta: string,
    log: Logger | undefined,
    depsInyectadas: DependenciasSellado | undefined,
): Promise<ResultadoSellado> {
    try {
        const d = depsInyectadas ?? await dependencias();

        // 0. Un comprobante para varios cobros (`wa_cubrir_cobros_con_comprobante`
        //    deja el mismo `receipt_url`, sin lectura, en los cobros cubiertos).
        //    El sellado es del cobro principal: leerlo aquí chocaría con su propia
        //    huella (23505) y rechazaría un pago legítimo. Mismo criterio que
        //    `fn_payments_saldo_a_favor_al_aprobar` (receipt_url igual, no terminal).
        const { data: otros, error: errOtros } = await supabase.from('payments').select('id')
            .eq('school_id', p.school_id).eq('receipt_url', ruta).neq('id', p.id)
            .not('status', 'in', '(rejected,cancelled,failed)')
            .limit(1);
        if (errOtros) return fallo(500, 'No se pudo revisar el comprobante.');
        if ((otros as unknown[] | null)?.length) {
            (log ?? console).info?.({ paymentId: p.id }, '[sellado] comprobante compartido con otro cobro: no se sella aquí');
            return { ok: true, verdict: null, action: 'none', motivo: 'comprobante_compartido' };
        }

        // 1. El archivo GUARDADO, no el que el navegador mandó a la vista previa.
        const { data: blob, error: dlErr } = await supabase.storage.from(BUCKET_COMPROBANTES).download(ruta);
        if (dlErr || !blob) {
            (log ?? console).warn?.({ paymentId: p.id, err: dlErr?.message }, '[sellado] no se pudo descargar el comprobante');
            return await escribirLecturaFallida(p, ruta, null, 'descarga', log);
        }
        const buf = Buffer.from(await blob.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_BYTES_COMPROBANTE) {
            return await escribirLecturaFallida(p, ruta, null, 'tamano', log);
        }
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        const base64 = buf.toString('base64');
        const mime = tipoPorFirma(base64) ?? tipoPorExtension(ruta);

        // 2. UNA lectura (OpenAI y Claude también leen PDF).
        const lectura = await extractReceiptWithFallback(listConfiguredProviders(), base64, mime);
        if (!lectura) return await escribirLecturaFallida(p, ruta, sha, 'ocr', log);

        // 3. Veredicto con los datos REALES del cobro y escritura con service role.
        const esperado = d.montoEsperadoDelComprobante(p);
        const estampado = await d.estamparComprobante(
            { schoolId: p.school_id, storagePath: ruta, sha, ocr: lectura.result, log, queueId: `sellado:${p.id}` },
            {
                id: p.id, amount: Number(p.amount), concept: p.concept, due_date: null,
                child_id: p.child_id, atleta: null, categoria: p.payment_category,
            },
            esperado,
            {
                estados: ['awaiting_approval'],
                archivo: ruta,
                categoria: { paymentCategory: p.payment_category, concept: p.concept },
            },
        );

        if (!estampado.ok) {
            if (estampado.duplicado) return await rechazarPorDuplicado(p, log);
            (log ?? console).warn?.({ paymentId: p.id, err: estampado.error }, '[sellado] no se pudo escribir');
            return fallo(500, 'No se pudo sellar el comprobante.');
        }
        const verdict = estampado.veredicto.verdict;
        if (!estampado.actualizado) {
            // Cambió el archivo (o el estado) entre la lectura y la escritura:
            // el archivo nuevo se sella en su propia llamada o en el barrido.
            return { ok: true, verdict: null, action: 'none', motivo: 'archivo_cambio' };
        }
        (log ?? console).info?.({ paymentId: p.id, provider: lectura.provider, verdict }, '[sellado] comprobante sellado');

        // 4. Decisión server-authoritative (auto-aprobar / glosa / rechazo del rojo).
        //    La lectura de arriba vale como lectura A (§3.5): no se paga dos veces.
        const r = await d.evaluatePaymentReceipt(p.id, log, {
            lecturaA: { provider: lectura.provider, result: lectura.result, sha },
        });
        return { ok: true, verdict, action: r.action, glosaId: r.glosaId ?? null };
    } catch (err) {
        (log ?? console).warn?.({ err, paymentId: p.id }, '[sellado] falló al leer o escribir');
        return fallo(500, 'No se pudo sellar el comprobante.');
    }
}

/**
 * El servidor no pudo leer el archivo: AMARILLO con un motivo propio que no
 * abre glosa (no se le pide a la familia «aclarar» un fallo nuestro) y que saca
 * la fila del barrido. Lo que hubiera escrito el navegador se borra: no es del
 * servidor. Con los bytes descargados, la huella sí queda (dedup).
 *
 * No llama a `evaluatePaymentReceipt`: su camino sin re-lectura abriría glosa
 * con este amarillo.
 */
async function escribirLecturaFallida(
    p: CobroParaSellar,
    receiptUrlLeido: string,
    sha: string | null,
    etapa: 'ruta' | 'descarga' | 'tamano' | 'ocr',
    log?: Logger,
): Promise<ResultadoSellado> {
    const motivo = {
        check: 0,
        code: MOTIVO_LECTURA_FALLIDA,
        level: 'amarillo' as const,
        message: 'El servidor no pudo leer el comprobante guardado: revísalo a mano con la foto.',
        detail: { etapa },
    };
    const { data, error } = await supabase.from('payments').update({
        ...LECTURA_VACIA,
        receipt_image_sha256: sha,
        receipt_image_sha256_source: sha ? 'server_verified' : null,
        receipt_verdict: 'amarillo',
        receipt_verdict_reasons: [motivo],
        receipt_verdict_at: new Date().toISOString(),
    }).eq('id', p.id).eq('status', 'awaiting_approval').eq('receipt_url', receiptUrlLeido).select('id');
    if (error) {
        if ((error as { code?: string }).code === '23505') return await rechazarPorDuplicado(p, log);
        (log ?? console).warn?.({ paymentId: p.id, err: error.message }, '[sellado] no se pudo marcar la lectura fallida');
        return fallo(500, 'No se pudo sellar el comprobante.');
    }
    (log ?? console).warn?.({ paymentId: p.id, etapa }, '[sellado] lectura fallida → amarillo, revisión manual');
    const escrito = Array.isArray(data) ? data.length > 0 : true;
    return { ok: true, verdict: escrito ? 'amarillo' : null, action: 'none', motivo: escrito ? 'lectura_fallida' : 'archivo_cambio' };
}

/** Columnas de lectura en blanco (las que antes escribía el navegador). */
const LECTURA_VACIA = {
    ocr_amount: null, ocr_currency: null, ocr_date: null, ocr_bank: null, ocr_reference: null,
    ocr_provider: null, ocr_destination: null, ocr_destination_name: null, ocr_origin_name: null,
    ocr_time: null, ocr_raw_response: null, receipt_reference_norm: null,
} as const;

/**
 * 23505 al sellar: esa referencia o esa imagen ya están en otro cobro vivo de
 * la escuela. Rechazo automático del comprobante, como el rojo del servidor
 * (decisión D4): el cobro vuelve a pendiente y la RPC le avisa a la familia.
 * En la práctica solo pasa con carreras o clientes forjados: la vista previa
 * ya bloquea los duplicados.
 */
async function rechazarPorDuplicado(p: CobroParaSellar, log?: Logger): Promise<ResultadoSellado> {
    const { error } = await supabase.rpc('reject_payment_receipt', {
        p_payment_id: p.id,
        p_reason_code: 'REFERENCIA_DUPLICADA',
        p_reason_text: 'Si hiciste otra transferencia, sube el comprobante de esa.',
    });
    if (error) {
        (log ?? console).warn?.({ paymentId: p.id, err: error.message }, '[sellado] duplicado, pero no se pudo rechazar → queda manual');
        return { ok: true, verdict: null, action: 'none', duplicado: true };
    }
    (log ?? console).info?.({ paymentId: p.id }, '[sellado] comprobante duplicado → rechazado');
    return { ok: true, verdict: null, action: 'rejected', duplicado: true };
}
