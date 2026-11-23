/**
 * Aviso de «el PAC bloquea la emisión de una escuela» (Dynasty, 2026-11-03 a 11-23: Factus rechazó una factura con
 * RUT01, quedó pendiente de enviar a la DIAN y bloqueó TODA emisión nueva durante 19 días; nadie se enteró porque la
 * alerta de «factura atascada» solo mira las facturas que tienen id del PAC y esta no lo tenía).
 *
 * Lo dispara el barrido de emisión cuando una escuela choca con PAC_BLOQUEADO. Como mucho un aviso cada 6 h por escuela.
 * Puro: sin base ni red.
 */

export const FRENO_AVISO_BLOQUEO_PAC_MS = 6 * 3_600_000;

/** ¿Toca avisar de esta escuela ahora? `ultimo` = cuándo se avisó por última vez (ms) o undefined. Pura. */
export function tocaAvisarBloqueoPac(ultimo: number | undefined, ahora: number = Date.now()): boolean {
    return ahora - (ultimo ?? 0) >= FRENO_AVISO_BLOQUEO_PAC_MS;
}

/** El texto del aviso (log y Sentry). Pura. */
export function mensajeBloqueoPac(escuelaId: string): string {
    return `[invoicing] El PAC está bloqueando la emisión de la escuela ${escuelaId}: hay una factura pendiente de enviar a la DIAN `
        + `y no sale ninguna factura nueva hasta resolverla. Entrar al panel del PAC, buscarla y enviarla o eliminarla; `
        + `después, backfillInvoices desde la fecha del bloqueo.`;
}
