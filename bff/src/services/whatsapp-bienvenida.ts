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
import type { EstadoOfertas, TipoOferta } from './bot-ofertas.service';

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

/**
 * Cómo se nombra cada tipo de oferta (bot-ofertas) en un botón (≤ 20 caracteres) y en
 * una frase. Andamiaje: títulos, fechas y lugares salen de la base, nunca de aquí.
 */
const ETIQUETAS_OFERTA: Record<TipoOferta, { boton: string; frase: string }> = {
    convocatoria: { boton: 'Convocatorias', frase: 'las *convocatorias*' },
    clase_prueba: { boton: 'Clase de prueba', frase: 'la *clase de prueba*' },
    clinica: { boton: 'Clínicas', frase: 'las *clínicas*' },
    vacacional: { boton: 'Vacacionales', frase: 'los *vacacionales*' },
    cambio_de_grupo: { boton: 'Cambio de grupo', frase: 'los *cambios de grupo*' },
    torneo: { boton: 'Torneos', frase: 'los *torneos*' },
    otro: { boton: 'Próximas fechas', frase: 'las *próximas fechas*' },
};

/** La etiqueta de las ofertas vigentes: la de su tipo si son de uno solo; si no, «Próximas fechas». null sin ofertas. Pura. */
export function etiquetaDeOfertas(ofertas: readonly { tipo: TipoOferta }[]): { boton: string; frase: string } | null {
    const tipos = [...new Set(ofertas.map((o) => o.tipo))];
    if (!tipos.length) return null;
    return (tipos.length === 1 ? ETIQUETAS_OFERTA[tipos[0]] : null) ?? ETIQUETAS_OFERTA.otro;
}

/** Lo que la bienvenida necesita saber de bot-ofertas (`estadoDeOfertas`). */
export type OfertasDeBienvenida = Pick<EstadoOfertas, 'claseDePrueba' | 'ofertas'>;

/**
 * El cuerpo tras la presentación («Hola 👋 soy el asistente automático de …»), corto y sin trámites.
 * `ofertas` (bot-ofertas): sin clase de prueba hoy no se nombra; si hay ofertas vigentes se nombran por
 * su tipo («las *convocatorias*»). Sin `ofertas`, o con la clase disponible y sin ofertas, el de siempre.
 */
export function textoDeBienvenida(nombreClase = 'clase de cortesía', ofertas?: OfertasDeBienvenida | null): string {
    const cola = 'o dejar tu mensaje para que una persona de la escuela te responda. 🙌';
    const etiqueta = ofertas ? etiquetaDeOfertas(ofertas.ofertas) : null;
    if (!ofertas || ofertas.claseDePrueba.disponible) {
        const clase = etiqueta ? `la *${nombreClase}*, ${etiqueta.frase}` : `la *${nombreClase}*`;
        return `¿En qué te puedo ayudar? Puedo contarte de ${clase} y la *inscripción*, los *horarios*, ${cola}`;
    }
    return etiqueta
        ? `¿En qué te puedo ayudar? Puedo contarte de ${etiqueta.frase} y la *inscripción*, los *horarios*, ${cola}`
        : `¿En qué te puedo ayudar? Puedo contarte de la *inscripción* y los *horarios*, ${cola}`;
}

/**
 * `textoDeBienvenida` con lo que la escuela puede ofrecer hoy (lee `estadoDeOfertas`, caché de 60 s;
 * falla cerrado para la clase de prueba). Para el cableado en `atenderDesconocido`. Nunca lanza.
 */
export async function textoDeBienvenidaDeEscuela(schoolId: string, nombreClase = 'clase de cortesía'): Promise<string> {
    try {
        const { estadoDeOfertas } = await import('./bot-ofertas.service');
        return textoDeBienvenida(nombreClase, await estadoDeOfertas(schoolId));
    } catch {
        return textoDeBienvenida(nombreClase, { claseDePrueba: { disponible: false, motivo: 'error', bloqueadaHasta: null, proximoBloqueo: null }, ofertas: [] });
    }
}
