/**
 * Link del grupo de WhatsApp de un servicio (Monster: la clínica de armadores y atacantes). La escuela lo mandaba a
 * mano a quien pagaba o abonaba; nunca se automatizó y se quedaba sin enviar (Giovanni Solarte, 11-16/11-18).
 *
 * Apagado por defecto: sin la variable no se agrega nada. WA_GRUPO_SERVICIO_JSON es un objeto
 * `{"<nombre del servicio>": "https://chat.whatsapp.com/…"}` (el nombre se compara sin tildes ni mayúsculas).
 * Solo se aceptan enlaces de chat.whatsapp.com: lo demás se ignora.
 */

const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const ENLACE = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+(\?[^\s]*)?$/;

/** El link del grupo del servicio, o null. Pura. */
export function grupoDelServicio(
    servicio: string | null | undefined, env: string | undefined = process.env.WA_GRUPO_SERVICIO_JSON,
): string | null {
    if (!servicio || !env) return null;
    try {
        const mapa = JSON.parse(env) as Record<string, unknown>;
        const buscado = normalizar(servicio);
        for (const [nombre, link] of Object.entries(mapa ?? {})) {
            if (normalizar(nombre) === buscado && typeof link === 'string' && ENLACE.test(link.trim())) return link.trim();
        }
    } catch { /* variable mal formada: sin grupo */ }
    return null;
}

/** La invitación al grupo, para pegar al final del texto de «cupo confirmado». Pura. */
export const textoGrupo = (link: string) => `Únete al grupo de WhatsApp del servicio para estar al tanto de todo: ${link}`;
