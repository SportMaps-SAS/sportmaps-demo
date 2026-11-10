/**
 * Contactos de WhatsApp con NOMBRE DE USUARIO (sin teléfono) — 2026-11-10.
 *
 * Desde que Meta dejó adoptar nombres de usuario, el webhook de quien lo tiene
 * y cuyo teléfono no nos consta llega SIN `from` y sin `contacts[].wa_id`: trae
 * `from_user_id` (el BSUID, p. ej. «CO.1234567890123456») y
 * `contacts[].profile.username`. Todo el sistema está llaveado por
 * `contact_wa_id` y descartaba esos mensajes: ni chat, ni comprobante, ni
 * prospecto (Monster, clínica de noviembre: @dr_xanl, @carovega12 y más de 30
 * chats de anuncios sin respuesta).
 *
 * El BSUID se guarda en `contact_wa_id` con un ALIAS reversible y SIN DÍGITOS.
 * Sin dígitos a propósito: medio centenar de sitios hacen
 * `.replace(/\D/g, '')` sobre ese campo para cruzarlo contra teléfonos de
 * fichas, acudientes y prospectos. Un BSUID crudo («CO.» + 16 dígitos) pasaría
 * por teléfono; el alias da cadena vacía y todos esos cruces lo tratan como
 * «no es un celular», que es la verdad.
 *
 *   BSUID  CO.1234567890123456   →   alias  wau-CO.-b-c-d-e-f-g-h-i-j-a-b-c-d-e-f-g
 *
 * Al enviar, Meta pide `recipient: <BSUID>` en vez de `to` (`conDestinatarioDeMeta`).
 * El BSUID es único por portafolio de negocio y cambia si la persona cambia de
 * número; el nombre de usuario puede cambiar sin que cambie el BSUID.
 *
 * Todo puro: sin red ni base.
 */

const PREFIJO = 'wau-';
const LETRAS = 'abcdefghij';
/** País (2 letras) + «.» + alfanuméricos (y «.» del padre: «CO.ENT.…»). Nunca trae guion. */
const RE_BSUID = /^[A-Za-z]{2}\.[A-Za-z0-9.]{1,140}$/;

/** ¿Este `contact_wa_id` es el alias de un contacto sin teléfono? */
export function esAliasDeUsuario(waId: unknown): waId is string {
    return typeof waId === 'string' && waId.startsWith(PREFIJO);
}

/** BSUID de Meta → lo que se guarda en `contact_wa_id`. null si no tiene forma de BSUID. */
export function aliasDeBsuid(bsuid: unknown): string | null {
    const s = typeof bsuid === 'string' ? bsuid.trim() : '';
    if (!RE_BSUID.test(s)) return null;
    return PREFIJO + s.replace(/\d/g, (d) => `-${LETRAS[Number(d)]}`);
}

/** El inverso: alias → BSUID para mandarle a Meta. null si no es un alias válido. */
export function bsuidDeAlias(alias: unknown): string | null {
    if (!esAliasDeUsuario(alias)) return null;
    const cuerpo = alias.slice(PREFIJO.length);
    if (/\d/.test(cuerpo)) return null;
    const s = cuerpo.replace(/-([a-j])/g, (_m, l: string) => String(LETRAS.indexOf(l)));
    return RE_BSUID.test(s) ? s : null;
}

/**
 * Llave del contacto para tokens y cruces en memoria: el alias tal cual, o los
 * dígitos del teléfono. Sin esto todos los contactos sin teléfono compartirían
 * la llave vacía.
 */
export function claveDeContacto(waId: unknown): string {
    if (esAliasDeUsuario(waId)) return waId;
    return String(waId ?? '').replace(/\D/g, '');
}

/** «carovega12» / «@carovega12» → «@carovega12»; null si no hay. */
export function usuarioConArroba(usuario: unknown): string | null {
    const u = typeof usuario === 'string' ? usuario.trim().replace(/^@+/, '') : '';
    return u ? `@${u}` : null;
}

/**
 * Nombre con el que se guarda la conversación de un contacto sin teléfono:
 * «Carolina Vega (@carovega12)». El @usuario es lo que la escuela ve en su
 * WhatsApp y por lo que busca el chat en el buzón.
 */
export function nombreConUsuario(nombre: string | null | undefined, usuario: unknown): string | null {
    const n = String(nombre ?? '').trim();
    const u = usuarioConArroba(usuario);
    if (!u) return n || null;
    if (!n) return u;
    return n.includes(u) ? n : `${n} (${u})`;
}

/**
 * El payload de /messages listo para Meta: si `to` es un alias, sale con
 * `recipient: <BSUID>` y sin `to` (con los dos, Meta usa `to`). Cualquier otro
 * payload sale igual.
 */
export function conDestinatarioDeMeta<T extends Record<string, unknown>>(payload: T): T {
    const bsuid = bsuidDeAlias(payload?.to);
    if (!bsuid) return payload;
    const { to: _to, ...resto } = payload;
    return { ...resto, recipient: bsuid } as unknown as T;
}
