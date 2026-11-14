/**
 * «¿Te sirvió?» de Mapi — lógica pura (sin supabase ni React) para poder
 * probarla sola.
 */

export interface MensajeHilo {
    id: string;
    author_type: "user" | "bot" | "agent";
}

/** { id de la respuesta de Mapi: 'si' | 'no' } — lo arma el BFF desde las notas internas. */
export type Feedback = Record<string, "si" | "no">;

const esUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

/**
 * Bajo qué mensaje va «¿Te sirvió?»: la ÚLTIMA respuesta de Mapi, mientras el
 * caso esté en manos de Mapi (bot_handled). Si ya escaló o lo tomó una
 * persona, no se pregunta. Los mensajes optimistas o de error locales no
 * tienen id de la base y no se califican.
 */
export function respuestaACalificar(messages: MensajeHilo[], status: string | undefined): string | null {
    if (status !== "bot_handled") return null;
    const ultimo = messages[messages.length - 1];
    if (!ultimo || ultimo.author_type !== "bot" || !esUuid(ultimo.id)) return null;
    return ultimo.id;
}
