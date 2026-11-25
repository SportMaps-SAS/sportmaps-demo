/**
 * Sellado del comprobante por el SERVIDOR (spec seguridad-veredicto-comprobante §3.3 y §3.7).
 *
 * Desde el 2026-11-25 el navegador de la familia ya no escribe la lectura del
 * comprobante (`ocr_*`), su veredicto (`receipt_verdict*`) ni su huella
 * (`receipt_image_sha256*`): guarda solo el archivo (`receipt_url`) y el estado,
 * y después llama SIEMPRE a este endpoint. El BFF lee el archivo GUARDADO, calcula
 * el veredicto con el monto y la categoría reales del cobro y lo escribe.
 *
 * La vista previa (/extract-receipt, dentro de FileUpload) sigue igual: bloquea
 * rojo, fecha y monto en la pantalla y no escribe nada.
 */
import { bffClient } from './bffClient';

export interface ResultadoSellado {
    verdict: 'verde' | 'amarillo' | 'rojo' | null;
    action: 'approved' | 'glosa' | 'rejected' | 'none';
    glosaId?: string | null;
    /** La referencia o la imagen ya estaban en otro cobro de la escuela. */
    duplicado?: boolean;
}

export interface AvisoDelSellado {
    title: string;
    description: string;
}

export const MENSAJE_COMPROBANTE_YA_RECIBIDO =
    'Este comprobante ya fue recibido: está vinculado a otro pago de esta escuela (puede haber llegado por WhatsApp o por otro cobro tuyo). Si crees que es un error, contacta a la administración.';

/** POST /api/v1/payments/:id/sellar-comprobante. No manda nada del comprobante: el servidor lo lee. */
export const sellarComprobante = (paymentId: string) =>
    bffClient.post<ResultadoSellado>(`/api/v1/payments/${encodeURIComponent(paymentId)}/sellar-comprobante`, {});

/**
 * Qué decirle a la familia según la respuesta. Solo el duplicado se avisa: el
 * resto sigue siendo «recibido», nunca «aprobado» (la validación es de la
 * escuela). Un rechazo lo avisa la base con su notificación. Pura.
 */
export function avisoDelSellado(r: ResultadoSellado | null | undefined): AvisoDelSellado | null {
    if (r?.duplicado) return { title: 'Comprobante ya recibido', description: MENSAJE_COMPROBANTE_YA_RECIBIDO };
    return null;
}

/**
 * Sella sin bloquear la pantalla (la lectura tarda unos segundos) y, si el
 * servidor detecta un duplicado, avisa. Nunca lanza: si falla, el barrido del
 * BFF lo sella en unos minutos.
 */
export function sellarSinEsperar(paymentId: string, avisar: (a: AvisoDelSellado) => void): void {
    sellarComprobante(paymentId)
        .then((r) => {
            const aviso = avisoDelSellado(r);
            if (aviso) avisar(aviso);
        })
        .catch(() => { /* lo recoge el barrido del BFF */ });
}
