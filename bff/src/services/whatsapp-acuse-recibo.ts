/**
 * Acuse de «recibido» que nunca se calla (Monster 2026-11-04 a 11-18, caso Carlos Clavijo: $175.000 el 15-nov sin
 * respuesta hasta que la escuela lo pidió de nuevo el 19-nov).
 *
 * Regla de producto: ante un comprobante, el bot SIEMPRE confirma que lo RECIBIÓ. Nunca dice «aprobado»: eso lo
 * decide y lo dice la escuela. Lo que se cierra en silencio (contacto que el bot no atiende, conversación tomada por
 * la escuela, modo discreto) quedaba sin ningún acuse, y la familia creía que su pago se había perdido.
 *
 * Este acuse NO pasa por `deliver` a propósito: `deliver` calla si la escuela escribió hace poco, y justamente ese
 * era el caso. Sale directo, con tres frenos: la bandera de la escuela, la ventana de 24 h de Meta (el archivo acaba
 * de llegar) y uno por ráfaga.
 *
 * Apagado por defecto, por escuela: WA_ACUSE_RECIBO_SCHOOL_IDS (ids separados por coma).
 */

/** Sin palabras de aprobación: «cupo confirmado» y «aprobado» solo salen después de que la escuela valida. */
export const TEXTO_ACUSE_RECIBO = 'Recibí tu comprobante 📄 La escuela lo revisa y te confirma por aquí.';
export const PASO_ACUSE_RECIBO = 'acuse_recibo_comprobante';

/** Un acuse por ráfaga: si ya salió uno en este lapso, no sale otro. */
export const VENTANA_ACUSE_RECIBO_MIN = 10;
/** Meta solo deja escribir texto libre dentro de las 24 h del último mensaje de la persona. */
const VENTANA_META_MS = 24 * 3600_000;

/** ¿Corre en esta escuela? Apagado si la variable no existe. Pura. */
export function acuseReciboHabilitado(
    schoolId: string, env: string | undefined = process.env.WA_ACUSE_RECIBO_SCHOOL_IDS,
): boolean {
    if (!schoolId || !env) return false;
    return env.split(',').map((s) => s.trim()).filter(Boolean).includes(schoolId);
}

export type ResultadoAcuseRecibo =
    | 'enviado' | 'apagado' | 'sin_conversacion' | 'fuera_de_ventana' | 'ya_acusado' | 'no_salio';

export interface DepsAcuseRecibo {
    /** ¿Ya salió un acuse de recibo en esta conversación en los últimos `minutos`? */
    yaAcuso: (conversationId: string, minutos: number) => Promise<boolean>;
    /** Manda el texto y lo deja registrado en la conversación. */
    enviar: (texto: string, paso: string) => Promise<{ ok: boolean }>;
}

/**
 * Manda «Recibí tu comprobante…» una vez por ráfaga. `llegoEn`: cuándo llegó el archivo (ISO). Nunca lanza: un
 * acuse que falla no puede romper el cierre de la fila.
 */
export async function acusarReciboDeComprobante(
    p: { schoolId: string; conversationId: string | null; llegoEn: string | null; ahora?: number },
    d: DepsAcuseRecibo,
    env?: string | undefined,
): Promise<ResultadoAcuseRecibo> {
    try {
        if (!acuseReciboHabilitado(p.schoolId, env ?? process.env.WA_ACUSE_RECIBO_SCHOOL_IDS)) return 'apagado';
        if (!p.conversationId) return 'sin_conversacion';
        const ahora = p.ahora ?? Date.now();
        const llegada = p.llegoEn ? Date.parse(p.llegoEn) : NaN;
        if (!Number.isFinite(llegada) || ahora - llegada > VENTANA_META_MS) return 'fuera_de_ventana';
        if (await d.yaAcuso(p.conversationId, VENTANA_ACUSE_RECIBO_MIN)) return 'ya_acusado';
        const r = await d.enviar(TEXTO_ACUSE_RECIBO, PASO_ACUSE_RECIBO);
        return r.ok ? 'enviado' : 'no_salio';
    } catch {
        return 'no_salio';
    }
}
