/**
 * whatsapp-pagar-mensualidad — «Quiero PAGAR una mensualidad» de alguien que el
 * teléfono no reconoce como familia del club (Monster 2026-11-05).
 *
 * Caso real: una persona NO inscrita pidió clase de prueba (entró al embudo),
 * preguntó por la clínica y por los pagos, y al final escribió «Para pagar una
 * mensualidad». El bot contestó solo «Ya le pasé tu mensaje a la escuela»: la
 * palabra «mensualidad» puede ser dos cosas y el bot no usaba lo que sabe de la
 * persona.
 *
 * Tres estados de la persona:
 *   A. Familia del club (el número está ligado a un deportista inscrito): NUNCA
 *      llega acá; el bot ya la identifica y le da el estado de pagos y los datos
 *      de pago (flujo de siempre, sin preguntar nada).
 *   B. Interesado del embudo (pidió clase de prueba / información / llegó por un
 *      anuncio) y no está inscrito.
 *   C. Desconocido sin contexto.
 *
 * Para B y C, «pagar una mensualidad» recibe UNA sola pregunta con dos botones:
 *   [Soy del club y pago]  → la puerta de «Ya soy del club» (nombre del deportista
 *                            o correo; si no aparece, la escuela lo ubica).
 *   [Quiero inscribirme]   → el embudo (clase de prueba; la mensualidad después).
 *
 * Todo lo de acá es PURO: las reglas de lectura y los textos. El envío y la base
 * viven en whatsapp-bot.service (`aclararPagoDeMensualidad`).
 */

import type { BotonInteractivo } from './whatsapp.service';
import { normalizarFrase } from './whatsapp-reglas-turno';
import { preguntaComoPagar } from './whatsapp-pago-publico';
import { formatoPesos } from './textos-clase-prueba';

/** step de la pregunta de aclaración (el freno «una sola vez» y la lectura de la respuesta por texto lo usan). */
export const PASO_PAGO_ACLARACION = 'pago_mensualidad_aclaracion';

/** Una sola vez por conversación: 30 días, la misma ventana del freno escolar. */
export const HORAS_FRENO_ACLARACION = 30 * 24;

export const BOTON_PAGO_MENSUALIDAD = {
    CLUB: 'sm_pm_club',
    INSCRIBIRME: 'sm_pm_inscribirme',
} as const;

export function esBotonPagoMensualidad(id: string | null | undefined): boolean {
    return !!id && id.startsWith('sm_pm_');
}

/** Títulos ≤ 20 caracteres (límite de Meta). */
export const BOTONES_PAGO_MENSUALIDAD: BotonInteractivo[] = [
    { id: BOTON_PAGO_MENSUALIDAD.CLUB, title: 'Soy del club y pago' },
    { id: BOTON_PAGO_MENSUALIDAD.INSCRIBIRME, title: 'Quiero inscribirme' },
];

export const ENTEXTO_PAGO_MENSUALIDAD = 'Responde *Soy del club y pago* o *Quiero inscribirme*.';

/** La pregunta. Una sola, sin repetir la bienvenida. Pura. */
export function textoAclaracionDePago(): string {
    return '¡Claro! 🙌 Para ayudarte bien, cuéntame: ¿*ya eres del club* y quieres pagar la mensualidad de tu deportista, ' +
        'o *quieres inscribirte*?';
}

// ─── Lectura de la frase (pura) ─────────────────────────────────────────────

const OBJETO = /\b(mensualidad(es)?|cuotas?|pension)\b/;
const VERBO = /\b(pagar|pagarla|pagarle|pago|pagos|cancelar|cancelarla|cancelo|cancela|abonar|abono|consignar|consigno|transferir)\b/;
/** Es una pregunta de valor (otro camino: la lista de precios), no un trámite de pago. */
const PIDE_VALOR = /\b(cuanto|cuanta|valor|valores|precio|precios|cuesta|vale|costo|costos|tarifa|tarifas)\b/;
/** De su cuenta, o ya hecho: no es «quiero pagar». */
const YA_HECHO = /\b(ya (pague|pagamos|cancele|cancelamos|consigne|transferi|abone)|pague|pagamos|consigne|transferi)\b/;
const NIEGA = /\bno (quiero|voy|puedo|pienso)\b|\bdar de baja|\bretir(ar|o|arme|arlo|arla)\b|\bpausar\b/;
const MAX_PALABRAS = 22;

/**
 * ¿Dice que quiere PAGAR una mensualidad? «Para pagar una mensualidad», «quiero
 * pagar la mensualidad», «voy a pagar la cuota», «cancelar la mensualidad» (en
 * Colombia cancelar = pagar). NO cuenta: preguntar cuánto vale, «ya pagué», «cómo
 * / dónde pago» (esa es información pública: los datos de pago), «cuánto debo»,
 * ni una frase larga (es otra conversación). Pura.
 */
export function quierePagarMensualidad(texto: string | null | undefined): boolean {
    const crudo = String(texto ?? '').trim();
    const t = normalizarFrase(crudo);
    if (!t || t.split(/\s+/).length > MAX_PALABRAS) return false;
    if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(crudo)) return false;
    if (!OBJETO.test(t) || !VERBO.test(t)) return false;
    if (PIDE_VALOR.test(t) || YA_HECHO.test(t) || NIEGA.test(t)) return false;
    const c = preguntaComoPagar(crudo);
    return !c.pagar && !c.presencial;
}

export type RespuestaAclaracion = 'club' | 'inscribirme';

/**
 * ¿Contestó la pregunta? Por botón, o escribiendo su título (el modo asistido manda
 * texto sin botones). Comparación contra el mensaje COMPLETO. Pura.
 */
export function leerRespuestaAclaracion(texto: string | null | undefined, botonId: string | null = null): RespuestaAclaracion | null {
    if (botonId === BOTON_PAGO_MENSUALIDAD.CLUB) return 'club';
    if (botonId === BOTON_PAGO_MENSUALIDAD.INSCRIBIRME) return 'inscribirme';
    const n = normalizarFrase(texto);
    if (!n) return null;
    if (/^(ya )?(soy|somos) (del |de la )?(club|escuela|academia)( y (quiero )?pag\w*)?$|^(soy|somos) (del |de la )?(club|escuela|academia),? (quiero )?pagar$/.test(n)) return 'club';
    if (/^(quiero|queremos) inscribirme$|^inscribirme$|^quiero inscribir\w*$/.test(n)) return 'inscribirme';
    return null;
}

/**
 * «Quiero inscribirme»: la clase de prueba primero, la mensualidad después. `valores`:
 * la lista de precios de la escuela (o null). `nombreClase`: cómo la llama la escuela.
 * Nunca dice «gratis». Pura.
 */
export function textoInscribirmeTrasPago(p: { valores: string | null; nombreClase: string }): string {
    return [
        `¡Perfecto! 🙌 Para inscribirte, primero se hace la *${p.nombreClase}* y, después de ella, te inscribes y pagas la mensualidad.`,
        p.valores ? `Estos son los valores de la escuela:\n\n${p.valores}` : null,
        'Cualquier duda, la escuela te responde por aquí.',
    ].filter(Boolean).join('\n\n');
}

// ─── «¿Y si soy afiliado?» de quien el teléfono no reconoce ─────────────────

/** step de la respuesta condicional (se manda una vez cada 24 h). */
export const PASO_PROSPECTO_AFILIADO = 'prospecto_afiliado_hipotetico';

/**
 * «¿Y si soy afiliado?», «si ya soy del club cuánto sería», «soy afiliado, ¿tiene
 * descuento?»: una HIPÓTESIS de quien no está reconocido como familia. No lo vuelve
 * familia ni merece el valor de afiliado como si fuera suyo. Pura.
 */
export function preguntaPorAfiliacionHipotetica(texto: string | null | undefined): boolean {
    const t = normalizarFrase(texto);
    if (!t || t.split(/\s+/).length > 22) return false;
    if (!/\b(afiliad[oa]s?|afiliacion|socios?|socias?|miembros?|del club|de la escuela|inscrit[oa]s?)\b/.test(t)) return false;
    return /\b(si|y si|siendo|como|en caso de) (yo )?(soy|fuera|estoy|ya soy|ya estoy|fuese)\b/.test(t)
        || /\b(soy|somos) (afiliad[oa]s?|socios?|socias?|miembros?)\b/.test(t)
        || /\b(precio|valor|descuento|tarifa|costo) (para|de|del|como) (afiliad|socio|miembro)/.test(t);
}

/**
 * El valor general que YA se le mostró a esta conversación (el de la ficha del
 * servicio, `precio_hoy`, solo si no era de afiliado), o null. Pura.
 */
export function precioGeneralMostrado(recientes: { direction: string; payload?: any }[]): number | null {
    for (const f of recientes) {
        if (f.direction !== 'outbound' || f.payload?.afiliado === true) continue;
        const v = Number(f.payload?.precio_hoy);
        if (Number.isFinite(v) && v > 0) return v;
    }
    return null;
}

/**
 * La respuesta CONDICIONAL: sin la cifra de afiliado como suya. Si ya es del club,
 * la escuela lo verifica (número o deportista) y le confirma su valor. Pura.
 */
export function textoAfiliadoSinReconocer(p: { general: number | null }): string {
    return [
        p.general !== null
            ? `Por ahora este número no aparece como el de una familia del club, así que el valor que te di (*${formatoPesos(p.general)}*) es el general.`
            : 'Por ahora este número no aparece como el de una familia del club.',
        'Si ya eres del club, la escuela verifica tu número o a tu deportista y te confirma por aquí el valor que te corresponde. ' +
            'Para agilizarlo, escríbeme el *nombre del deportista* o el *correo* con el que se inscribió 🙌',
    ].join('\n\n');
}

// (cambio mínimo dentro de bff/ para comprobar el autodeploy de Render tras reconectar el repo)
