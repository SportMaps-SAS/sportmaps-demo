/**
 * Patrocinio y alianzas de marca (Monster, 2026-11-11).
 *
 * Monster abrió una convocatoria a empresas («¿Tu marca juega con nosotros?»: comenta «MARCA» o escribe por
 * WhatsApp). Esas personas NO son participantes: si escriben «quiero patrocinar la clínica» o «cuánto cuesta ser
 * aliado», el destino por texto (que reconoce la clínica por su nombre) les contestaría la ficha de INSCRIPCIÓN con
 * el precio de hoy y los datos de pago. Una consulta de patrocinio se la pasa a una persona de la escuela.
 */
import { normalizarFrase } from './whatsapp-reglas-turno';

/** Señales de que quien escribe es una empresa o marca, no un participante. */
const PATROCINIO = new RegExp([
    // patrocinar / patrocinio / patrocinador, auspicio, sponsor
    '(patrocin|auspici|sponsor)[a-z]*',
    // aliado(s), alianza(s), «aliarnos»
    'aliad[oa]s?', 'alianzas?', 'aliarnos',
    // publicidad / visibilidad de marca
    'publicidad', 'visibilidad de (mi |nuestra |la )?marca',
    // «mi marca», «nuestra marca», «tu marca» (no «la marca del balón»)
    '(mi|nuestra|su|tu) marca',
    // «somos / tengo / represento una empresa, marca o emprendimiento»
    '(somos|tengo|represento|soy) (una |un |la )?(empresa|marca|emprendimiento|compania|organizacion)',
    '(mi|nuestra) (empresa|compania|organizacion|emprendimiento)',
].join('|'));

/**
 * ¿El texto es de una empresa o marca interesada en patrocinar o aliarse? Incluye el «MARCA» suelto del comentario
 * del anuncio. Conservadora: «la marca de la camiseta» o «marca de balones» de una familia NO cuentan. Pura.
 */
export function esConsultaDePatrocinio(texto: string | null | undefined): boolean {
    const t = normalizarFrase(texto);
    if (!t) return false;
    if (t === 'marca' || t === 'marcas') return true;
    return new RegExp('\\b(' + PATROCINIO.source + ')\\b').test(t);
}

/** Lo que se le contesta a una empresa: gracias, y una persona le escribe. Sin precios ni datos de pago. Pura. */
export function textoDePatrocinio(nombreEscuela: string | null | undefined): string {
    const quien = (nombreEscuela ?? '').trim() || 'nuestro club';
    return `¡Gracias por tu interés en ser aliado de ${quien}! 🏐 Ya le avisé a la persona encargada de alianzas para que te escriba por aquí y conozcas las opciones.`;
}
