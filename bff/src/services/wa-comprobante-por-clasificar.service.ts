/**
 * wa-comprobante-por-clasificar — un comprobante con dinero real NUNCA se queda en la bandeja.
 *
 * Spec: docs/specs/whatsapp-comprobantes-nunca-en-la-bandeja.md (fase 2).
 * Migración: 20261118124124_wa_comprobantes_por_clasificar.
 *
 * Cuando el bot no puede aplicar un comprobante solo (sin dueño, monto distinto, otro concepto, la escuela
 * tomó el chat…), antes cerraba la fila con un motivo y el dinero quedaba en la bandeja, donde «marcar
 * resuelto» no cambia ningún pago. Ahora, si la fila trae un monto leído y el destino es de la escuela, se
 * registra en `wa_comprobantes_por_clasificar` con su etiqueta y su propuesta, y la escuela lo decide desde
 * Cobros. NO crea `payments`, NO aprueba nada, NO le escribe a la familia.
 *
 * Este módulo es PURO salvo `registrarPorClasificar` (una RPC). La decisión «¿hay plata aquí?» vive en
 * `decidirPorClasificar` y la comparten el worker (al cerrar la fila) y el barrido (filas que ya estaban).
 */

import { supabase } from '../config/supabase';
import { motivoDeFila } from './whatsapp-bandeja.service';
import type { OcrResult } from './ocr.service';

export type EtiquetaPorClasificar =
    | 'abono_de_cobro' | 'saldo_de_cobro' | 'servicio_nuevo' | 'inscripcion' | 'clase_de_prueba'
    | 'articulo' | 'mensualidad' | 'exceso' | 'repetido' | 'por_identificar' | 'fuera_de_sportmaps' | 'otro';

/** Lo que el OCR dejó de un comprobante (el subconjunto que se usa; coincide con `pregunta_ocr.ocr`). */
export interface LecturaParaClasificar {
    amount?: number | string | null;
    reference?: string | null;
    date?: string | null;
    bank?: string | null;
    destination?: string | null;
    originName?: string | null;
    description?: string | null;
    isReceipt?: boolean | null;
    isTransactionList?: boolean | null;
}

/**
 * Motivos de bandeja que traen plata por aplicar → etiqueta que ve la escuela.
 *
 * Fuera a propósito: `monto_distinto_aplicado` (el abono YA quedó en revisión en un cobro), `duplicado`,
 * `ya_registrado`, `enviado_por_equipo`, `fuera_de_sportmaps`, `destino_ajeno` (el dinero no fue a la
 * escuela), `no_es_comprobante`, `es_listado` y los que no traen lectura (`archivo_no_*`, `limite_ocr`,
 * `ocr_omitido`): sin monto no hay nada que clasificar.
 */
const ETIQUETA_POR_MOTIVO: Record<string, EtiquetaPorClasificar> = {
    varios_cobros: 'otro',
    monto_distinto: 'abono_de_cobro',
    sin_familia: 'por_identificar',
    familia_sin_cuenta: 'por_identificar',
    numero_ambiguo: 'por_identificar',
    otro_concepto: 'otro',
    pregunta_vencida: 'otro',
    venta_servicio: 'servicio_nuevo',
    venta_faltan_datos: 'servicio_nuevo',
    venta_incompleto: 'servicio_nuevo',
    escuela_tomo: 'otro',
    sin_pendientes_con_pago: 'otro',
    sin_pendientes: 'otro',
    saldo_de_parcial: 'saldo_de_cobro',
    excedente_de_parcial: 'exceso',
    prospecto_sin_concepto: 'por_identificar',
    torneo_o_club: 'servicio_nuevo',
    pago_partido: 'otro',
    reclamo_del_cliente: 'otro',
    motivo_esperado: 'otro',
    // «Revisar» en la bandeja: solo cuentan si el OCR leyó un comprobante real a una cuenta de la escuela
    // (la auditoría del 18-nov encontró 3 × $140.000 y otros ahí).
    contacto_no_atendido: 'por_identificar',
    bot_apagado: 'por_identificar',
};

export const MOTIVOS_CON_PLATA: readonly string[] = Object.keys(ETIQUETA_POR_MOTIVO);

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Etiqueta más fina cuando el detalle del bot dice de qué concepto es (otro_concepto, venta_*, escuela_tomo…). */
function afinarEtiqueta(base: EtiquetaPorClasificar, texto: string): EtiquetaPorClasificar {
    const t = sinTildes(texto);
    if (/clase de prueba|clase prueba/.test(t)) return 'clase_de_prueba';
    if (/inscripcion|matricula/.test(t)) return 'inscripcion';
    if (/uniforme|camiseta|balon|articulo|talla|dotacion/.test(t) && base !== 'servicio_nuevo') return 'articulo';
    if (/mensualidad|cuota mensual/.test(t) && base === 'otro') return 'mensualidad';
    if (/clinica|vacacional|torneo|viaje/.test(t) && (base === 'otro' || base === 'por_identificar')) return 'servicio_nuevo';
    return base;
}

export interface DecisionPorClasificar {
    etiqueta: EtiquetaPorClasificar;
    monto: number;
    referencia: string | null;
    fecha: string | null;
    banco: string | null;
    destino: string | null;
    contactoNombreEscrito: string | null;
    /** El motivo de bandeja de la fila (código estable). */
    motivo: string;
    /** Lo que se guarda en `propuesta`: nunca trae PII de más (sin rawText, sin teléfono completo). */
    propuesta: Record<string, unknown>;
}

const num = (v: unknown): number | null => {
    const n = typeof v === 'string' ? Number(v.replace(/[^0-9.]/g, '')) : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * ¿Esta fila de la cola trae dinero que la escuela tiene que decidir? Pura.
 * Devuelve null si no (no es comprobante, no hay monto, o el motivo no es de plata).
 *
 * El destino NO se mira aquí (necesita las cuentas de la escuela): lo cruza quien llama.
 */
export function decidirPorClasificar(i: {
    errorMessage: string | null | undefined;
    ocr: LecturaParaClasificar | null | undefined;
    /** Texto del chat que acompañaba al comprobante (pie de foto), si lo hubo. */
    texto?: string | null;
}): DecisionPorClasificar | null {
    const ocr = i.ocr;
    if (!ocr) return null;
    if (ocr.isReceipt === false || ocr.isTransactionList === true) return null;
    const monto = num(ocr.amount);
    if (monto === null) return null;

    const { motivo, detalle } = motivoDeFila({ id: '', status: 'ignored', error_message: i.errorMessage ?? null });
    const base = ETIQUETA_POR_MOTIVO[motivo];
    if (!base) return null;

    const etiqueta = afinarEtiqueta(base, `${detalle ?? ''} ${i.texto ?? ''} ${ocr.description ?? ''}`);
    return {
        etiqueta,
        monto,
        referencia: ocr.reference ? String(ocr.reference).trim() || null : null,
        fecha: ocr.date && /^\d{4}-\d{2}-\d{2}$/.test(ocr.date) ? ocr.date : null,
        banco: ocr.bank ?? null,
        destino: ocr.destination ?? null,
        contactoNombreEscrito: ocr.originName ?? null,
        motivo,
        propuesta: {
            motivo,
            detalle: detalle ? detalle.slice(0, 400) : null,
            texto: i.texto ? i.texto.slice(0, 200) : null,
            descripcion: ocr.description ? String(ocr.description).slice(0, 200) : null,
            pagador: ocr.originName ?? null,
        },
    };
}

/**
 * La lectura que la cola guardó en `pregunta_ocr.ocr` es un RESUMEN (monto, referencia, fecha, banco, destino…), no el
 * `OcrResult` completo: le faltan campos que `evaluateVerdict` da por sentados (`missingFields`, `isTransactionList`…).
 * Sin esto, estampar un comprobante desde «Por clasificar» tira `Cannot read properties of undefined (reading 'map')`.
 * Esta función la completa con valores neutros (nada de lo que añade inventa un dato del comprobante). Pura.
 */
export function lecturaComoOcr(ocr: Record<string, any> | null | undefined): OcrResult {
    const o = ocr ?? {};
    const monto = num(o.amount);
    return {
        amount: monto,
        currency: o.currency ?? 'COP',
        date: o.date ?? null,
        time: o.time ?? null,
        bank: o.bank ?? null,
        reference: o.reference ?? null,
        destination: o.destination ?? null,
        destinationName: o.destinationName ?? null,
        originName: o.originName ?? null,
        description: o.description ?? null,
        isReceipt: o.isReceipt !== false,
        isTransactionList: o.isTransactionList === true,
        missingFields: Array.isArray(o.missingFields) ? o.missingFields.map(String) : [],
        rawText: o.rawText ?? null,
        injectionSuspected: o.injectionSuspected === true,
        provider: String(o.provider ?? 'gemini'),
    };
}

export type ResultadoPorClasificar =
    | { ok: true; id: string; yaExistia: boolean; repetido: boolean }
    | { ok: false; codigo: string; paymentId?: string };

const FALLA_DE_MIGRACION = /Could not find the function|does not exist|schema cache|PGRST202|42883|42P01/i;

/**
 * Registra el comprobante en «por clasificar» con la RPC (idempotente por fila de la cola) y lo saca de la
 * bandeja. Nunca lanza: si la migración no está aplicada devuelve `migracion_pendiente` y la fila queda como
 * antes (en la bandeja), sin romper el worker.
 */
export async function registrarPorClasificar(i: {
    schoolId: string;
    queueId: string;
    decision: DecisionPorClasificar;
    storagePath: string | null;
    telefono: string | null;
    nombre: string | null;
    motivoBot: string | null;
}): Promise<ResultadoPorClasificar> {
    try {
        const d = i.decision;
        const { data, error } = await supabase.rpc('wa_crear_comprobante_por_clasificar', {
            p_school_id: i.schoolId,
            p_queue_id: i.queueId,
            p_etiqueta: d.etiqueta,
            p_monto: d.monto,
            p_referencia: d.referencia,
            p_fecha: d.fecha,
            p_banco: d.banco,
            p_destino: d.destino,
            p_storage_path: i.storagePath,
            p_contacto: i.telefono,
            p_contacto_nombre: i.nombre,
            p_motivo_bot: i.motivoBot,
            p_propuesta: d.propuesta,
        });
        if (error) {
            if (FALLA_DE_MIGRACION.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
                return { ok: false, codigo: 'migracion_pendiente' };
            }
            console.warn('[wa-por-clasificar] la RPC falló', { queueId: i.queueId, code: error.code, msg: error.message });
            return { ok: false, codigo: 'error' };
        }
        const r = (data ?? {}) as Record<string, unknown>;
        if (r.ok !== true || typeof r.id !== 'string') {
            return {
                ok: false, codigo: String(r.codigo ?? 'error'),
                ...(typeof r.payment_id === 'string' ? { paymentId: r.payment_id } : {}),
            };
        }
        return { ok: true, id: r.id, yaExistia: r.ya_existia === true, repetido: r.repetido === true };
    } catch (e: any) {
        console.warn('[wa-por-clasificar] la RPC lanzó', { queueId: i.queueId, error: e?.message });
        return { ok: false, codigo: 'error' };
    }
}

export type CierrePorClasificar =
    | { ok: true; yaAplicado: boolean }
    | { ok: false; codigo: string; http: number; estado?: string };

/**
 * Cierra la fila «por clasificar» con la RPC `wa_comprobante_por_clasificar_aplicar` y REVISA el resultado (antes la
 * ruta lo descartaba: si el cierre fallaba, el comprobante ya estaba en el cobro y la fila seguía abierta en Cobros).
 * Reintenta UNA vez ante un error de red/RPC (la RPC es idempotente: `ya_aplicado`). Nunca lanza.
 *
 *  · ok / ya_aplicado        → { ok: true }
 *  · ya_cerrado              → 409: otra persona la cerró antes (la carrera de dos administradores).
 *  · no_existe               → 404
 *  · pago_ajeno / parametros → 422
 *  · error de la RPC / red   → 502 `cierre_fallo`
 */
export async function cerrarPorClasificar(i: {
    id: string; paymentId: string; resolucion: string; por: string | null;
}): Promise<CierrePorClasificar> {
    let ultimo = 'cierre_fallo';
    for (let intento = 0; intento < 2; intento++) {
        try {
            const { data, error } = await supabase.rpc('wa_comprobante_por_clasificar_aplicar', {
                p_id: i.id, p_payment_id: i.paymentId, p_resolucion: i.resolucion, p_por: i.por,
            });
            if (error) { ultimo = String(error.message ?? 'cierre_fallo'); continue; }
            const r = (data ?? {}) as Record<string, unknown>;
            if (r.ok === true) return { ok: true, yaAplicado: r.ya_aplicado === true };
            const codigo = String(r.codigo ?? 'cierre_fallo');
            if (codigo === 'ya_cerrado') return { ok: false, codigo, http: 409, ...(typeof r.estado === 'string' ? { estado: r.estado } : {}) };
            if (codigo === 'no_existe') return { ok: false, codigo, http: 404 };
            if (codigo === 'pago_ajeno' || codigo === 'parametros') return { ok: false, codigo, http: 422 };
            ultimo = codigo;
        } catch (e: any) {
            ultimo = String(e?.message ?? e);
        }
    }
    console.warn('[wa-por-clasificar] el cierre de la fila falló', { id: i.id, paymentId: i.paymentId, error: ultimo });
    return { ok: false, codigo: 'cierre_fallo', http: 502 };
}

/** Interruptor de emergencia: `WA_POR_CLASIFICAR_OFF=1` devuelve el worker al comportamiento anterior. */
export const porClasificarApagado = (): boolean => process.env.WA_POR_CLASIFICAR_OFF === '1';

/**
 * ¿Esta escuela usa «Por clasificar»? Solo las de `WA_POR_CLASIFICAR_ESCUELAS` (ids separados por coma).
 * Vacía o sin definir = NADIE (lo seguro): las demás escuelas siguen con la bandeja de siempre.
 * Hoy: Monster´s Volley y Dynasty. Para sumar o quitar una escuela se cambia la variable, sin código ni base.
 */
export function porClasificarActivoPara(schoolId: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.WA_POR_CLASIFICAR_OFF === '1') return false;
    const ids = (env.WA_POR_CLASIFICAR_ESCUELAS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    return ids.includes(String(schoolId).toLowerCase());
}
