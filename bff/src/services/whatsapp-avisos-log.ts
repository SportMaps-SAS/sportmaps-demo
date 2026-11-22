/**
 * Registro de avisos de WhatsApp por plantilla: cada intento, salga o no, con su motivo (plan:
 * docs/specs/registro-avisos-whatsapp.md). Un aviso que sale ya deja fila en `whatsapp_messages`; el que NO sale
 * (sin opt-in, fuera de horario, plantilla no aprobada…) no dejaba rastro y no se podía contestar «¿a quién le tocaba
 * y no le llegó?».
 *
 * Apagado por defecto, por escuela: WA_AVISOS_LOG_SCHOOL_IDS (ids separados por coma).
 * NUNCA lanza ni retrasa el envío: quien llama no espera el resultado del registro.
 * Los `no_enviado` repetidos (los jobs reintentan en cada tick) no se vuelven a guardar dentro de la ventana.
 */
import { supabase } from '../config/supabase';

/** Mismo (pago, concepto, motivo) dentro de este lapso: no se guarda otra fila de `no_enviado`. */
export const VENTANA_DEDUPE_HORAS = 12;
const MAX_DETALLE = 300;

export interface AvisoARegistrar {
    schoolId: string;
    concepto: string;
    plantilla?: string | null;
    paymentId?: string | null;
    parentId?: string | null;
    destino?: string | null;
    resultado: 'enviado' | 'no_enviado';
    motivo?: string | null;
    detalle?: string | null;
    waMessageId?: string | null;
}

export interface DepsAvisosLog {
    /** ¿Ya hay un `no_enviado` con la misma clave en las últimas `horas`? */
    existeReciente: (a: AvisoARegistrar, horas: number) => Promise<boolean>;
    insertar: (fila: Record<string, unknown>) => Promise<void>;
}

/** ¿Registra en esta escuela? Apagado si la variable no existe. Pura. */
export function avisosLogHabilitado(
    schoolId: string, env: string | undefined = process.env.WA_AVISOS_LOG_SCHOOL_IDS,
): boolean {
    if (!schoolId || !env) return false;
    return env.split(',').map((s) => s.trim()).filter(Boolean).includes(schoolId);
}

export const recortarDetalle = (d: string | null | undefined): string | null =>
    d ? (d.length > MAX_DETALLE ? d.slice(0, MAX_DETALLE) : d) : null;

const depsPorDefecto: DepsAvisosLog = {
    async existeReciente(a, horas) {
        const desde = new Date(Date.now() - horas * 3600_000).toISOString();
        let q = supabase.from('whatsapp_avisos_log').select('id', { head: true, count: 'exact' })
            .eq('school_id', a.schoolId).eq('concepto', a.concepto).eq('resultado', 'no_enviado')
            .eq('motivo', a.motivo ?? '').gte('created_at', desde);
        q = a.paymentId ? q.eq('payment_id', a.paymentId) : q.is('payment_id', null);
        if (!a.paymentId && a.destino) q = q.eq('destino', a.destino);
        const { count } = await q;
        return (count ?? 0) > 0;
    },
    async insertar(fila) {
        await supabase.from('whatsapp_avisos_log').insert(fila);
    },
};

/** Guarda el intento. Devuelve true si insertó. Nunca lanza. */
export async function registrarAviso(
    a: AvisoARegistrar, deps: DepsAvisosLog = depsPorDefecto, env?: string,
): Promise<boolean> {
    try {
        if (!avisosLogHabilitado(a.schoolId, env ?? process.env.WA_AVISOS_LOG_SCHOOL_IDS)) return false;
        if (a.resultado === 'no_enviado' && await deps.existeReciente(a, VENTANA_DEDUPE_HORAS)) return false;
        await deps.insertar({
            school_id: a.schoolId,
            concepto: a.concepto,
            plantilla: a.plantilla ?? null,
            payment_id: a.paymentId ?? null,
            parent_id: a.parentId ?? null,
            destino: a.destino ?? null,
            resultado: a.resultado,
            motivo: a.motivo ?? (a.resultado === 'enviado' ? 'ok' : null),
            detalle: recortarDetalle(a.detalle),
            wa_message_id: a.waMessageId ?? null,
        });
        return true;
    } catch {
        return false;
    }
}
