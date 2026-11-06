// Saneamiento de texto libre (notas, nombres, motivos, nombre de organización).
//
// REGLA: sanitizar al ENTRAR (esto) y escapar al SALIR (escapeHtml en cada plantilla).
// Una sola función para todo el módulo de reservas: no hay variantes locales.
//
// Qué hace:
//  - normaliza Unicode a NFC (ñ, tildes: «n» + «◌̃» pasa a «ñ»; no se pierde contenido en español),
//  - quita NULL y demás caracteres de control C0/C1 (Postgres rechaza \u0000: era un 500),
//  - quita caracteres invisibles de formato que sirven para engañar (ancho cero, marcas bidi
//    LRO/RLO/LRI/…, BOM), pero NO el ZWJ/ZWNJ que usan emojis y algunos idiomas,
//  - normaliza espacios (cualquier blanco Unicode, saltos de línea, tabs) a un espacio simple
//    (o, con keepNewlines, a un salto de línea simple como máximo),
//  - recorta bordes y limita la longitud por puntos de código (nunca parte un emoji a la mitad).
//
// Qué NO hace: no elimina `<`, `>`, comillas ni «&» (son texto legítimo); eso se escapa al renderizar.

// C0 (salvo \t \n \r, que se tratan aparte), DEL y C1.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Invisibles de formato: soft hyphen (00AD), arabic letter mark (061C), ancho cero (200B), LRM/RLM (200E/200F),
// embebidos/overrides bidi (202A–202E), word joiner (2060), aislados bidi (2066–2069), BOM (FEFF).
const INVISIBLE_RE = /[­؜​‎‏‪-‮⁠⁦-⁩﻿]/g;

export interface SanitizeOptions {
    /** Máximo en puntos de código (default 500). */
    max?: number;
    /** Conserva saltos de línea (como mucho uno seguido). Útil para notas. */
    keepNewlines?: boolean;
}

export function sanitizeFreeText(input: unknown, opts: SanitizeOptions = {}): string {
    if (input === null || input === undefined) return '';
    const max = opts.max ?? 500;
    let s = typeof input === 'string' ? input : String(input);
    // Sustitutos sueltos (UTF-16 inválido) rompen JSON/PG: se descartan antes de normalizar.
    s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
    s = s.normalize('NFC');
    s = s.replace(CONTROL_RE, '').replace(INVISIBLE_RE, '');
    s = s.replace(/\r\n?/g, '\n');
    if (opts.keepNewlines) {
        s = s.split('\n').map((l) => l.replace(/[^\S\n]+/g, ' ').trim()).join('\n').replace(/\n{2,}/g, '\n');
    } else {
        s = s.replace(/\s+/g, ' ');
    }
    s = s.trim();
    const cps = Array.from(s);
    if (cps.length > max) s = cps.slice(0, max).join('').trimEnd();
    return s;
}

/** Escape HTML para interpolar texto de usuario en cualquier plantilla de correo / HTML. */
export function escapeHtmlText(str: unknown): string {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Texto de usuario que va a un LLM: saneado, acotado y envuelto en un delimitador explícito de
 * «dato no confiable». Los marcadores de cierre dentro del texto se neutralizan para que nadie
 * pueda «salirse» del bloque. El prompt de sistema debe decir que lo de adentro es DATO.
 */
export function wrapUntrustedForLlm(label: string, input: unknown, max = 300): string {
    const safeLabel = String(label).replace(/[^a-z0-9_]/gi, '_').slice(0, 40) || 'dato';
    const body = sanitizeFreeText(input, { max }).replace(/<\/?\s*dato_no_confiable[^>]*>/gi, '[…]');
    return `<dato_no_confiable campo="${safeLabel}">${body}</dato_no_confiable>`;
}
