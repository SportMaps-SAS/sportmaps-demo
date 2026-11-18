/**
 * Cliente mínimo de la Decisions API de Google (gemini-decision-1).
 * https://aistudio.google.com/docs/decisions-api
 *
 * Devuelve probabilidades calibradas, no texto: sirve para bifurcar el flujo
 * del bot («¿esto es un aviso de ausencia?») con una confianza medible.
 *
 * Usa la MISMA `GEMINI_API_KEY` que ya usa el OCR (ocr.service.ts / llm.service.ts).
 *
 * POR AHORA SOLO PARA PRUEBA EN PARALELO (scripts/decisions-piloto.ts): no está
 * enchufado a ningún flujo de producción. Nunca lanza: ante cualquier fallo
 * devuelve `null`, y el llamador debe seguir con su regla de siempre.
 *
 * Ojo: el texto del usuario puede influir en la clasificación (lo advierte la
 * propia documentación). Nunca decidir dinero ni borrar nada solo con esto.
 */

export type PreguntaNoul = { type: 'noul'; instructions: string };
export type PreguntaChoice = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type Pregunta = PreguntaNoul | PreguntaChoice;

export interface RespuestaNoul { type: 'noul'; noul: number; confidence: number }
export interface RespuestaChoice { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export type Respuesta = RespuestaNoul | RespuestaChoice;

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
export const MODELO_DECISIONS = process.env.GEMINI_DECISIONS_MODEL || 'gemini-decision-1';
const TIMEOUT_MS = 15000;

export interface ResultadoDecisions {
    answers: Record<string, Respuesta>;
    inputTokens: number | null;
    ms: number;
}

/** Los bloques de texto contiguos se concatenan sin separador: se manda UN solo bloque. */
export async function decidir(
    texto: string,
    preguntas: Record<string, Pregunta>,
    timeoutMs: number = TIMEOUT_MS,
): Promise<ResultadoDecisions | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || !texto.trim() || !Object.keys(preguntas).length) return null;
    const t0 = Date.now();
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
                model: MODELO_DECISIONS,
                input: [{ type: 'text', text: texto }],
                questions: preguntas,
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
            // El cuerpo del error puede traer el texto del usuario: no se registra.
            console.warn(`[gemini-decisions] HTTP ${res.status}`);
            return null;
        }
        const json = (await res.json()) as { answers?: Record<string, Respuesta>; usage?: Record<string, unknown> };
        if (!json?.answers) return null;
        const u = json.usage ?? {};
        const total = Number((u as Record<string, unknown>).total_input_tokens ?? NaN);
        return { answers: json.answers, inputTokens: Number.isFinite(total) ? total : null, ms: Date.now() - t0 };
    } catch (e) {
        console.warn('[gemini-decisions] fallo:', (e as Error).name);
        return null;
    }
}

/** Pregunta sí/no con su probabilidad y confianza; null si la API no respondió. */
export async function decidirSiNo(
    texto: string,
    instrucciones: string,
): Promise<{ pSi: number; confianza: number; ms: number } | null> {
    const r = await decidir(texto, { q: { type: 'noul', instructions: instrucciones } });
    const a = r?.answers?.q;
    if (!r || !a || a.type !== 'noul') return null;
    return { pSi: a.noul, confianza: a.confidence, ms: r.ms };
}

/** Pregunta de enrutamiento: elige una opción; null si la API no respondió. */
export async function decidirOpcion(
    texto: string,
    instrucciones: string,
    opciones: Record<string, string>,
    timeoutMs?: number,
): Promise<{ opcion: string; probabilidades: Record<string, number>; confianza: number; ms: number } | null> {
    const r = await decidir(texto, { q: { type: 'choice', instructions: instrucciones, criteria: opciones } }, timeoutMs);
    const a = r?.answers?.q;
    if (!r || !a || a.type !== 'choice') return null;
    return { opcion: a.choice, probabilidades: a.probabilities, confianza: a.confidence, ms: r.ms };
}

/**
 * Clasificación del mensaje de una familia. Las instrucciones llevan NUESTRAS
 * reglas y ejemplos (la API no se entrena: todo el criterio va en el JSON).
 * Para mejorarla se editan estas descripciones, no hay nada más que ajustar.
 */
export const INSTRUCCIONES_MENSAJE_FAMILIA =
    'El mensaje lo escribe por WhatsApp el padre, madre o acudiente de un deportista (o el propio deportista) a su escuela deportiva. '
    + 'Clasifica el mensaje en UNA categoría. Un aviso de ausencia es cuando AVISA que el deportista no va a ir a entrenar; '
    + 'preguntar, quejarse, retirarse o hablar de pagos NO es un aviso de ausencia. '
    + 'Si el mensaje no dice nada con sentido (solo números, signos, un enlace), es "otro".';

export const CATEGORIAS_MENSAJE_FAMILIA: Record<string, string> = {
    ausencia_proxima:
        'Avisa que el deportista NO irá a entrenar hoy, mañana o un día próximo concreto (enfermedad, cita, viaje, tarea, se hizo tarde). '
        + 'Ej: "hoy no puede ir, está enfermo", "mañana no asiste", "el sábado no va por un cumpleaños", "hoy no alcanzamos a llegar".',
    ausencia_larga_o_evento:
        'Avisa que no irá durante un periodo o a un evento puntual (clínica, torneo, vacaciones, un rango de fechas, el fin de semana). '
        + 'Ej: "no puede ir del 1 al 3 de diciembre", "al torneo del sábado no vamos", "seguramente no vaya a poder ir a la clínica del sábado".',
    llegada_tarde_o_en_camino:
        'Avisa que va a llegar tarde, que ya viene en camino o que se retrasó, pero SÍ va a asistir. Ej: "voy en camino, se me acabó la gasolina", "voy a llegar un poco tarde".',
    retiro_o_salida:
        'Quiere salirse, retirarse o dejar un grupo, programa o la escuela, de forma definitiva. '
        + 'Ej: "vamos a salir del grupo porque no alcanzamos a ir", "quiero retirar a mi hija".',
    pregunta_horario_o_info:
        'Pregunta por horarios, sedes, si hay clase, precios o cualquier información. Ej: "a qué hora es el entrenamiento de mañana?", "mañana hay clase por el festivo?".',
    reclamo_o_pasado:
        'Habla de algo que ya pasó o de un reclamo: faltó antes, le cobraron, no recibió algo. Ej: "el mes pasado no asistió y me cobraron igual", "Velandia no fue".',
    condicional_o_horario_fijo:
        'Hipótesis o limitación permanente, no un aviso: "si no puede ir me avisan", "los sábados no puede porque estudia inglés", '
        + '"mi hija quiere el nacional pero no puede asistir a todas las clases".',
    pagos:
        'Habla de pagos, comprobantes, transferencias, mensualidad o saldo.',
    otro:
        'Saludo, agradecimiento, solo números o signos, un enlace, o cualquier otra cosa que no encaje arriba.',
};

export const CATEGORIAS_AUSENCIA = ['ausencia_proxima', 'ausencia_larga_o_evento'] as const;

/** Clasifica un mensaje de familia; null si la API no respondió. */
export async function clasificarMensajeFamilia(texto: string, timeoutMs?: number) {
    return decidirOpcion(texto, INSTRUCCIONES_MENSAJE_FAMILIA, CATEGORIAS_MENSAJE_FAMILIA, timeoutMs);
}
