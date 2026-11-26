/**
 * ¿Este mensaje es un pedido de BAJA (dejar de recibir mensajes)? Pura.
 *
 * Auditoría del bot (F3-01/F3-02, 2026-11-24): la ingesta SQL solo reconoce 6 frases exactas
 * ('stop', 'baja', 'cancelar suscripcion', 'desuscribir', 'no molestar', 'salir'); de 40 variantes
 * naturales solo 15 daban de baja. Esta lista las amplía SIN tocar la función SQL (ninguna migración):
 * la ruta del webhook la consulta y, si coincide, registra la baja con la misma RPC.
 *
 * Reglas para no dar de baja a quien no la pidió (la baja corta cobranza y avisos):
 *  · Solo mensajes cortos (≤ 12 palabras): «no me escriban más por favor, ya no me interesa nada» sí;
 *    un párrafo que menciona «baja» no.
 *  · «Dar de baja a mi hijo / de la clase» NO es una baja de mensajes (es un retiro): «darme de baja»
 *    cuenta solo si el mensaje termina ahí (o en «por favor» / «gracias»).
 *  · «cancelar» a secas tampoco: «quiero cancelar la clase del sábado» es otra cosa.
 *  · «no me interesa» tampoco: eso lo maneja la campaña (excluye de la audiencia, no es baja).
 */

const MAX_PALABRAS = 12;

const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Mensaje completo (con «por favor / gracias» opcionales al final). */
const COLETILLA = '(?: (?:por favor|porfa|porfavor|gracias|ya))?';
const EXACTAS = new RegExp(
    '^(?:' + [
        'stop', 'parar', 'pare', 'unsubscribe', 'baja', 'bajas', 'no molestar', 'no molesten', 'salir', 'alto',
        'cancelar suscripcion', 'cancelar la suscripcion', 'cancelar notificaciones', 'cancelar mensajes',
        '(?:quiero |quisiera )?(?:darme|dar me|me doy|me quiero dar|denme|den me|dame|dar nos|darnos|nos den) de baja',
        '(?:quiero )?(?:desuscribirme|desuscribir|desinscribirme)',
        'no mas mensajes', 'no mas notificaciones', 'no mas avisos', 'ya no mas mensajes',
    ].join('|') + ')' + COLETILLA + '$',
);

/** Frases que valen dentro de un mensaje corto. */
const FRASES: RegExp[] = [
    // «ya no quiero (recibir) (más) mensajes / notificaciones / avisos / publicidad»
    /\b(?:ya )?no (?:quiero|queremos|deseo|deseamos|necesito) (?:recibir |que me lleguen |mas )*(?:mensajes|notificaciones|avisos|publicidad|promociones|informacion|correos)\b/,
    // «no me escriban / manden / envíen / molesten / llamen (más)»
    /\b(?:ya )?no me (?:escriban|escribas|escriba|manden|mandes|envien|envies|molesten|molestes|llamen|llames|sigan escribiendo|sigan enviando|sigan mandando)\b/,
    /\bno (?:nos) (?:escriban|manden|envien|molesten|llamen)\b/,
    // «dejen de escribir / enviar / mandar / molestar»
    /\b(?:dejen|deja|dejes|dejar) de (?:escribir|enviar|mandar|molestar|llamar)/,
    // «quítenme / sáquenme / bórrenme de la lista (de contactos / de difusión)»
    /\b(?:quitenme|saquenme|borrenme|eliminenme|quitame|sacame|borrame|quitar me|sacar me|borrar me)\b/,
    /\b(?:quitar|sacar|borrar|eliminar|quiten|saquen|borren|eliminen)(?:me|nos| me| nos| mi numero| mi contacto)? (?:de|del) (?:la |su |esta |ese )?(?:lista|listado|grupo|difusion|base de datos|contactos)\b/,
    // «stop por favor», «stop a los mensajes»
    /^stop\b/,
];

/** «No quiero que me den de baja», «no me quiero dar de baja»: lo contrario. */
const NIEGA_LA_BAJA = /\bno (?:quiero|me quiero|deseo|me)\b[^.]*\b(?:baja|desuscrib|dar me de baja|darme de baja|den de baja)\b/;

export function pideBajaTotal(texto: string | null | undefined): boolean {
    const t = plano(String(texto ?? ''));
    if (!t || t.split(' ').length > MAX_PALABRAS) return false;
    if (NIEGA_LA_BAJA.test(t)) return false;
    if (EXACTAS.test(t)) return true;
    return FRASES.some((re) => re.test(t));
}
