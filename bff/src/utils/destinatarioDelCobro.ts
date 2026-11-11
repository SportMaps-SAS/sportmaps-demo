/**
 * A quién se le avisa de un cobro: al acudiente (`parent_id`) y, si el cobro no
 * tiene acudiente, al adulto dueño del cobro (`user_id`). Un atleta adulto con
 * cuenta propia (Carlos Martínez, Monster) tiene `parent_id` NULL y `user_id` =
 * él: avisar solo a `parent_id` lo dejaba sin correo de aprobación, de glosa ni
 * de recordatorio. Pura.
 */
export function destinatarioDelCobro(
    p: { parent_id?: string | null; user_id?: string | null } | null | undefined,
): string | null {
    return p?.parent_id || p?.user_id || null;
}
