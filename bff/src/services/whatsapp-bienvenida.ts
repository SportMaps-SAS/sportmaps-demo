/**
 * Bienvenida al desconocido que solo saluda («Hola», «Hola Dynasty 👋», «Buenos días»).
 *
 * Medido en Dynasty (16 → 23-oct-2026): 36 de ~82 saludos de desconocidos quedaron sin
 * respuesta del bot ni de la escuela. El silencio ante un saludo es deliberado (evita el
 * «escríbeme tu correo» a la mamá de la dueña, a proveedores, a amigos), pero a quien
 * escribe por primera vez a un número de escuela sin que nadie le haya hablado nunca sí
 * se le debe una frase. Estas reglas son puras: el cableado vive en `atenderDesconocido`.
 *
 * Qué NO es una bienvenida: un emoji o sticker suelto, «gracias»/«ok» (cierres), un saludo
 * con el nombre de quien atiende o con «profe» («hola mile»: es un contacto personal) ni
 * un mensaje con cualquier otra palabra (eso ya lo manejan los demás filtros).
 *
 * Apagada por defecto: solo corre en las escuelas de `WA_BIENVENIDA_DESCONOCIDOS_SCHOOL_IDS`.
 */
import { normalizarFrase, VOCATIVOS_GENERICOS } from './whatsapp-reglas-turno';

export const PASO_BIENVENIDA_DESCONOCIDO = 'bienvenida_desconocido';
/** Una bienvenida por conversación en esta ventana. */
export const BIENVENIDA_VENTANA_HORAS = 24;

const SALUDO_NUCLEO = new Set(['hola', 'holi', 'holaa', 'holaaa', 'ola', 'buenas', 'buenos', 'buen', 'saludos', 'hey', 'hi']);
const SALUDO_RELLENO = new Set([
    'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches', 'como', 'estas', 'esta', 'que', 'tal', 'bien', 'muy', 'feliz',
    'a', 'todos', 'todas', 'ustedes', 'equipo',
]);
const MAX_PALABRAS = 8;

/** ¿La escuela está en `WA_BIENVENIDA_DESCONOCIDOS_SCHOOL_IDS` (ids separados por coma)? */
export function bienvenidaHabilitada(schoolId: string, env: string | undefined = process.env.WA_BIENVENIDA_DESCONOCIDOS_SCHOOL_IDS): boolean {
    if (!schoolId || !env) return false;
    return env.split(',').map((s) => s.trim()).filter(Boolean).includes(schoolId);
}

/**
 * ¿El texto es SOLO un saludo para la escuela? `nombreEscuela` se quita («Hola Dynasty»);
 * `equipo` son los nombres de quienes atienden (normalizados, ver `vocativosDeEscuela`).
 */
export function esSaludoDeBienvenida(
    texto: string | null | undefined,
    opts: { nombreEscuela?: string; equipo?: ReadonlyMap<string, string> } = {},
): boolean {
    const crudo = (texto ?? '').trim();
    if (!crudo || crudo.length > 60) return false;
    if (!/\p{L}/u.test(crudo)) return false; // solo emojis o signos
    const palabras = normalizarFrase(crudo).split(' ').filter(Boolean);
    if (palabras.length === 0 || palabras.length > MAX_PALABRAS) return false;

    const deLaEscuela = new Set(normalizarFrase(opts.nombreEscuela).split(' ').filter((w) => w.length >= 3));
    let hayNucleo = false;
    for (const w of palabras) {
        if (opts.equipo?.has(w) || VOCATIVOS_GENERICOS.includes(w)) return false; // contacto personal
        if (SALUDO_NUCLEO.has(w)) { hayNucleo = true; continue; }
        if (SALUDO_RELLENO.has(w) || deLaEscuela.has(w)) continue;
        return false;
    }
    return hayNucleo;
}

/** El cuerpo tras la presentación («Hola 👋 soy el asistente automático de …»), corto y sin trámites. */
export function textoDeBienvenida(nombreClase = 'clase de cortesía'): string {
    return `¿En qué te puedo ayudar? Puedo contarte de la *${nombreClase}* y la *inscripción*, los *horarios*, ` +
        'o dejar tu mensaje para que una persona de la escuela te responda. 🙌';
}
