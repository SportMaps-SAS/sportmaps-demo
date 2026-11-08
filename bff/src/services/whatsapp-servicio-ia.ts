/**
 * whatsapp-servicio-ia — contestar una pregunta sobre UN servicio del catálogo
 * (clínica, torneo, vacacional…) con los datos que la escuela configuró, sin
 * inventar nada (plan docs/specs/whatsapp-ventas-de-servicio-blindaje.md, frente B).
 *
 * Contrato (lo usa el bot en la venta de un servicio, frente A):
 *   · Entra: el ítem del catálogo, la pregunta, el hilo reciente, si el número es
 *     de una familia del club (precio de afiliado) y las cuentas de pago.
 *   · Sale: `{ tipo: 'respuesta', texto }` SOLO si la respuesta está en los datos
 *     (descripción del ítem, fechas, precios por fecha, abono, cuentas y titular);
 *     si no, `{ tipo: 'no_se', motivo }` y el bot dice con claridad que la escuela
 *     lo confirma y le avisa a la escuela (nunca adivina).
 *   · Todo texto que sale pasa por el verificador de montos y fechas contra el
 *     catálogo: un monto o una fecha de precio que no esté en los datos = no sale.
 *
 * Esta primera versión es el CONTRATO (devuelve 'no_se'); la implementación la
 * hace el frente B sin cambiar la firma.
 */
import type { FilaReciente } from './whatsapp-reglas-turno';
import type { ItemConFicha } from './whatsapp-anuncio-destino';
import type { CuentaDePagoEmbudo } from './whatsapp-embudo-prospecto';

export interface PreguntaDeServicio {
    schoolId: string;
    conversationId: string;
    item: ItemConFicha;
    pregunta: string;
    recientes: FilaReciente[];
    /** El número es de una familia del club (le toca el precio de afiliado si el ítem lo tiene). */
    afiliado: boolean;
    cuentas: CuentaDePagoEmbudo[];
    /** 'YYYY-MM-DD' en Bogotá. */
    hoy: string;
}

export type RespuestaDeServicio =
    | { tipo: 'respuesta'; texto: string }
    | { tipo: 'no_se'; motivo: string };

export async function responderPreguntaDeServicio(_p: PreguntaDeServicio): Promise<RespuestaDeServicio> {
    return { tipo: 'no_se', motivo: 'sin_implementar' };
}
