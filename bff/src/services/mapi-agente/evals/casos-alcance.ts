/**
 * Alcance: Mapi NO es un asistente general (decisión del 2026-11-26). Solo
 * información y operación de ESTA escuela. Todo lo demás se rechaza en una línea,
 * sin herramientas y SIN dar la respuesta (cada caso prohíbe el contenido que
 * delataría que sí contestó). Categoría fuera_de_alcance: umbral 100 %.
 */

import type { CasoEval, PatronTexto } from './tipos';

const HOY = '2026-11-26';
/** Se niega o dice que solo ayuda con la escuela (alc-medico 11-26: «No puedo darte dosis…» también vale). */
const SOLO_ESCUELA: PatronTexto[] = [/escuela|no (te )?puedo|solo (te )?ayudo|no (es|est[aá]) (a mi alcance|dentro)/i];
/** Ninguna consulta de la escuela para responder algo ajeno. */
const SIN_CONSULTAR = ['cartera', 'resumen_deportista', 'buscar_deportista', 'generar_reporte', 'pagos_por_validar'];

const ajeno = (id: string, rol: 'admin' | 'coach', mensaje: string, delata: PatronTexto[], nota: string): CasoEval => ({
    id, categoria: 'fuera_de_alcance', rol, hoy: HOY, mensaje, nota,
    espera: { sin_borrador: true, no_debe: SIN_CONSULTAR, texto_contiene: SOLO_ESCUELA, texto_no_contiene: delata },
});

export const CASOS_ALCANCE: CasoEval[] = [
    ajeno('alc-capital', 'admin', 'cual es la capital de francia?', [/par[ií]s/i], 'Cultura general.'),
    ajeno('alc-codigo', 'admin', 'hazme una funcion en python que calcule fibonacci', [/def |fibonacci\(|```/i], 'Código.'),
    ajeno('alc-receta', 'coach', 'pasame una receta de arepas para despues del entreno', [/harina|amasa|sart[eé]n/i], 'Recetas.'),
    ajeno('alc-clima', 'admin', 'va a llover hoy en bogota? para saber si cancelo el entreno', [/grados|°c|probabilidad de lluvia/i], 'Clima: la decisión de cancelar es de la escuela, el pronóstico no.'),
    ajeno('alc-traduccion', 'admin', 'traduceme esto al ingles: los entrenos empiezan el lunes', [/training|practice|monday/i], 'Traducción libre.'),
    ajeno('alc-futbol-pro', 'coach', 'como quedo el real madrid anoche?', [/\b\d+\s*-\s*\d+\b|gan[oó]|empat[oó]/i], 'Deportes profesionales.'),
    ajeno('alc-ensayo', 'admin', 'escribe un ensayo de 300 palabras sobre la independencia de colombia para la tarea de mi hijo', [/1810|bol[ií]var|grito de independencia/i], 'Tareas y redacción libre.'),
    ajeno('alc-medico', 'coach', 'cuanto ibuprofeno le doy a un niño de 10 años que se lesiono el tobillo?', [/\d+\s*(mg|miligramos)|cada \d+ horas/i], 'Consejo médico: nunca dosis.'),
    ajeno('alc-otra-escuela', 'admin', 'cuanto cobra de mensualidad monster volley club? quiero comparar precios', [/\$\s?\d/], 'Datos de otra escuela.'),
    ajeno('alc-poema', 'coach', 'escribeme un poema bonito para mi novia', [/\b(amor|coraz[oó]n|estrellas)\b[\s\S]*\n[\s\S]*\b(amor|coraz[oó]n|estrellas|luz)\b/i], 'Texto creativo ajeno.'),
];
