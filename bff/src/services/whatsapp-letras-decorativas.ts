/**
 * Letras decorativas → letras normales (Dynasty 2026-10-26: una deportista
 * escribe todo en versalitas, «ʜᴏʟᴀ ᴍɪʟᴇ… sᴇʀᴀ ǫ ᴍᴇ ᴘᴜᴇᴅᴇs ᴄᴀᴍʙɪᴀʀ ʟᴀ ᴛᴀʟʟᴀ»).
 * Ninguna regla del bot la leía: «ᴍɪʟᴇ» no era «Mile», y el bot le contestó
 * «No te entendí bien el último mensaje» en plena charla con Milena.
 *
 * Solo se transforma si el texto trae esas letras: NFKC sobre cualquier texto
 * también cambiaría «²», «½» o «™», y eso no es de nadie.
 */

/** Versalitas y parecidas que NFKC no convierte. */
const VERSALITAS: Record<string, string> = {
    'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ғ': 'f', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i',
    'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r', 'ꜱ': 's',
    'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z',
};

const RE_VERSALITAS = new RegExp(`[${Object.keys(VERSALITAS).join('')}]`, 'gu');
/** Alfanuméricos matemáticos (𝗦𝗼𝘆, 𝓒𝓪𝓵𝓮𝓻𝓸), letras de ancho completo y en círculo: NFKC los vuelve normales. */
const RE_COMPATIBLES = /[\u{1D400}-\u{1D7FF}０-９Ａ-Ｚａ-ｚⒶ-ⓩ]/u;

/** ¿Trae letras decorativas? Pura. */
export function tieneLetrasDecorativas(texto: string | null | undefined): boolean {
    if (!texto) return false;
    RE_VERSALITAS.lastIndex = 0;
    return RE_VERSALITAS.test(texto) || RE_COMPATIBLES.test(texto);
}

/** El mismo texto con letras normales; igual si no trae decorativas. Pura. */
export function aLetrasNormales(texto: string): string;
export function aLetrasNormales(texto: string | null): string | null;
export function aLetrasNormales(texto: string | null): string | null {
    if (!texto || !tieneLetrasDecorativas(texto)) return texto;
    let t = texto.replace(RE_VERSALITAS, (c) => VERSALITAS[c] ?? c);
    if (RE_COMPATIBLES.test(t)) t = t.normalize('NFKC');
    return t;
}
