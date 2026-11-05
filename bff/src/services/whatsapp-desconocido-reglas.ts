/**
 * whatsapp-desconocido-reglas — Reglas puras para el contacto que NO es
 * familia identificada (Dynasty 2026-10-08, `responder_desconocidos=true`).
 *
 *  - `esCierreDeCortesia`: «Cualquier inquietud quedo pendiente», «quedo atenta»,
 *    «estamos en contacto», «gracias por la información». No piden nada: no se
 *    les contesta «escríbeme tu correo».
 *  - `seIdentificaComoExterno`: entrenador(a) o club de OTRA institución,
 *    empresa, proveedor, «le escribo de parte de…», invitaciones a amistosos.
 *    No es familia ni prospecto: ni plantilla de inscripción ni pedido de
 *    correo; al buzón, en silencio.
 *  - `preguntaHorarioDeHoy`: «¿Cambiaron el horario de hoy?»,
 *    «¿hay entreno hoy?». Se contesta con el horario del día, sin correo.
 *
 * Sin modelo, deterministas, sobre el texto normalizado (sin tildes, minúsculas,
 * puntuación vuelta espacio). Ante la duda, NO: estas reglas callan o cambian
 * la respuesta, y equivocarse en ellas le quita una respuesta a una familia.
 */

import { normalizarFrase, pideALaPersona, VOCATIVOS_GENERICOS } from './whatsapp-reglas-turno';

// ─── Cierres de cortesía ─────────────────────────────────────────────────────

/** Frases de cierre que no piden nada (sobre el texto normalizado). */
const FRASES_DE_CIERRE: RegExp[] = [
    /\bcualquier (duda|cosa|inquietud|novedad|pregunta|consulta|informacion)( adicional)?\b/,
    /\b(quedo|quedamos|estoy|estamos|estare|estaremos|sigo|seguimos) (muy )?(atent[oa]s?|pendientes?|al pendiente|a la espera|a la orden|a (tu|su|sus) (disposicion|orden)|en contacto)\b/,
    /\b(estamos|seguimos|quedamos) en contacto\b/,
    /\b(me|nos) (avisas|avisan|avisa|cuentas|cuentan|cuenta|dices|dicen|escribes|escriben|comentas|comentan)\b/,
    /\b(te|le|les) (aviso|avisamos|cuento|contamos|escribo|escribimos)( (luego|despues|mas tarde|pronto|cualquier cosa))?\b/,
    /\bhablamos( (luego|despues|mas tarde|pronto|manana))?\b/,
    /\ba la orden\b/,
    /\bcon (mucho )?gusto\b/,
    /\b(gracias|muchas gracias|mil gracias|agradezco|agradecemos|agradecida|agradecido) (por|x) (la|el|tu|su|toda la) (informacion|info|atencion|respuesta|ayuda|colaboracion|tiempo|amabilidad|datos)\b/,
    /\b(que (estes|este|esten) (muy )?bien|feliz (dia|tarde|noche|fin de semana|fin)|buen (dia|fin de semana)|un abrazo|abrazos|saludos|bendiciones)\b/,
];

/** Relleno que puede quedar al lado de un cierre sin que pida nada. */
const RELLENO_DE_CIERRE = new Set([
    'gracias', 'muchas', 'mil', 'ok', 'okey', 'okay', 'listo', 'vale', 'dale', 'bueno', 'perfecto', 'super',
    'genial', 'entonces', 'y', 'pues', 'si', 'igual', 'igualmente', 'por', 'favor', 'tu', 'te', 'le', 'les', 'su',
    'mi', 'cualquier', 'cosa', 'duda', 'aqui', 'aca', 'estoy', 'estamos', 'quedo', 'de', 'la', 'el', 'lo', 'que',
    'para', 'lo', 'demas', 'todo', 'eso', 'seria', 'por', 'ahora', 'hola', 'buenas', 'buenos', 'dias', 'tardes',
    'noches', 'querida', 'querido', 'linda', 'lindo', 'reina', 'amiga', 'amigo', 'mija', 'mijo', 'hermosa',
    'nena', 'ya', 'ahi', 'me', 'nos', 'quedamos', 'atento', 'atenta', 'pendiente', 'pendientes', 'o', 'a', 'en',
]);

/**
 * ¿Es un cierre de cortesía que no pide nada? «Cualquier inquietud
 * quedo pendiente», «Quedo atenta», «Listo, estamos en contacto», «Gracias por la
 * información». `equipo`: vocativos de la escuela («marce», «marcela»).
 * Con signo de pregunta, no.
 */
export function esCierreDeCortesia(
    texto: string | null | undefined,
    equipo: ReadonlyMap<string, string> | ReadonlySet<string> = new Map(),
): boolean {
    const crudo = (texto || '').trim();
    if (!crudo || /[?¿]/.test(crudo)) return false;
    let t = normalizarFrase(crudo);
    if (!t) return false;
    let alguna = false;
    for (const re of FRASES_DE_CIERRE) {
        const g = new RegExp(re.source, 'g');
        if (g.test(t)) {
            alguna = true;
            t = t.replace(new RegExp(re.source, 'g'), ' ');
        }
    }
    if (!alguna) return false;
    return t.split(' ').filter(Boolean)
        .every((w) => RELLENO_DE_CIERRE.has(w) || equipo.has(w) || VOCATIVOS_GENERICOS.includes(w));
}

/** ¿La línea pide algo (pregunta o pedido)? Para no callar un cierre que viene después de una pregunta. */
export function pideAlgo(texto: string | null | undefined): boolean {
    const crudo = (texto || '').trim();
    if (!crudo) return false;
    if (/[?¿]/.test(crudo)) return true;
    const t = normalizarFrase(crudo);
    return /^(que|cual|cuales|cuando|donde|como|cuanto|cuanta|cuantos|cuantas|por que|hay|hubo|tienen|tiene|puedo|pueden|podria|podrian|podrias|quisiera|quiero|queria|necesito|necesitamos|me (puedes|puede|podrias|regalas|regala|das|da|envias|envia|pasas|pasa|confirmas|confirma|ayudas|ayuda|informas|informa))\b/.test(t)
        || /\b(por favor|porfa|xfa|me (puedes|podrias|regalas|confirmas|ayudas|informas|envias|pasas))\b/.test(t);
}

// ─── Otra institución, empresa o proveedor ───────────────────────────────────

const CARGO = '(entrenador|entrenadora|profe|profesor|profesora|coach|director|directora|coordinador|coordinadora|'
    + 'presidente|presidenta|delegado|delegada|representante|asesor|asesora|gerente|ejecutivo|ejecutiva|fundador|'
    + 'fundadora|administrador|administradora|vendedor|vendedora|comercial|dt)';
const INSTITUCION = '(club|empresa|fundacion|academia|escuela|liga|colegio|corporacion|marca|tienda|agencia|'
    + 'institucion|universidad|alcaldia|federacion|gimnasio|almacen|distribuidora|compania|organizacion)';

const EXTERNO: RegExp[] = [
    // «hablas con Ana entrenadora de …», «habla con el director del club …»
    new RegExp(`\\b(hablas|habla|hablan) con\\b(\\s+\\w+){0,3}\\s+${CARGO} (de|del)\\b`),
    // «soy la entrenadora de …», «soy Ana, coordinadora del club …»
    new RegExp(`\\bsoy\\b(\\s+\\w+){0,3}\\s+${CARGO} (de|del)\\b`),
    // «somos de la empresa …», «somos una fundación», «somos el club …»
    new RegExp(`\\bsomos (de|del|una|un|el|la)\\b(\\s+\\w+){0,2}\\s+${INSTITUCION}\\b`),
    new RegExp(`\\bsomos (el|la|una|un) ${INSTITUCION}\\b`),
    // «le escribo de parte de …», «de parte de la empresa …»
    /\b(les|le|te|los|las) (escribo|escribimos|contacto|contactamos|saludo|saludamos) de parte de\b/,
    new RegExp(`\\bde parte de (el |la |los |nuestra |nuestro )?${INSTITUCION}\\b`),
    new RegExp(`\\b(les|le|te) (escribo|escribimos) (desde|de) (el |la |nuestra |nuestro )?${INSTITUCION}\\b`),
    // «en nuestro club», «nuestros productos»
    /\bnuestr[oa]s? (club|academia|escuela|empresa|fundacion|liga|institucion|marca|tienda|productos|servicios|portafolio|catalogo)\b/,
    // invitaciones a otro club: amistosos, festivales, «quedan invitados»
    /\b(jugar|hacer|organizar|programar|cuadrar) (un |unos )?(amistosos?|partidos? amistosos?|cuadrangular|triangular|festival)\b/,
    // 2026-10-19: más verbos («agendar/coordinar un amistoso») y la invitación sin la palabra «amistoso»
    /\b(agendar|coordinar|concretar|pactar|acordar|fijar|armar|gestionar|realizar|tener|disputar|jugar|organizar) (con ustedes )?(un |unos |el )?(partidos? |encuentros? )?(amistosos?|cuadrangular|triangular|festival)\b/,
    /\b(partidos?|encuentros?) amistosos?\b.*\b(ustedes|sede|nuestr[oa]s?|invit\w*)\b|\bamistosos?\b.*\b(en|a) (nuestra|nuestro) (sede|cancha|club|coliseo|escuela)\b/,
    /^amistosos?\b/, // título suelto: «Amistoso CVJ MAXI SENIORS» (Dynasty 10-16)
    /\b(venir|ir|vayan|vengan|visitarnos) a (jugar|competir) (con nosotr\w+|contra nosotr\w+|un|unos)\b/,
    /\bjugar con nosotr[oa]s\b|\b(los|las|les) (esperamos|retamos|retar)\b/,
    /\b(en|a) nuestr[oa] (sede|cancha|coliseo)\b/,
    /\b(los|las|les) (invitamos|invito|queremos invitar)\b/,
    /\b(super |muy )?invitad[oa]s\b/,
    /\b(nos|me) (puedan|pueden|podrian) acompanar\b/,
    /\binvitacion (a|al|para) (un |el |la |nuestro |nuestra )?(torneo|festival|amistoso|cuadrangular|triangular|copa|evento|encuentro)\b/,
    // proveedores
    /\b(cotizacion|cotizaciones|portafolio de (productos|servicios)|(les|le|te) (ofrecemos|ofrezco)|proveedor(es)?|propuesta comercial|alianza comercial)\b/,
];

/** Señales de que SÍ es familia o prospecto: con esto no se descarta. */
const ES_FAMILIA = /\b(mi|mis|nuestr[oa]s?) (hij[oa]s?|nin[oa]s?|nen[ea]s?|sobrin[oa]s?|niet[oa]s?)\b|\bsoy (la |el )?(mama|papa|madre|padre|acudiente|abuel[oa]|ti[oa])\b|\b(inscrib\w*|inscripcion|matricul\w*|mensualidad|comprobante)\b/;

/**
 * ¿Se presenta como de OTRA institución (entrenador(a), club, empresa,
 * proveedor) o invita a la escuela a algo? Pura. Con señales de familia
 * («mi hija», «soy la mamá», «inscribir») no.
 */
export function seIdentificaComoExterno(...textos: (string | null | undefined)[]): boolean {
    const t = normalizarFrase(textos.filter(Boolean).join(' '));
    if (!t) return false;
    if (ES_FAMILIA.test(t)) return false;
    return EXTERNO.some((re) => re.test(t));
}

// ─── Horario de hoy ──────────────────────────────────────────────────────────

const DE_HORARIO = /\b(horarios?|clases?|entrenos?|entrenamientos?|practicas?|entrenan|entrenamos|entrena)\b/;
const HOY = /\b(hoy|esta tarde|esta noche|esta manana|en la tarde de hoy)\b/;
const COMO_PREGUNTA = /\b(hay|hubo|habra|tienen|tenemos|a que hora|que hora|cual es|cuales son|sabes si|saben si|sabe si|se cancel\w*|cancelad[oa]s?|cambio|cambios|cambiaron|sigue|siguen|normal)\b/;
const AUSENCIA = /\bno (puede|puedo|pueden|podra|podemos|va|vamos|voy|van|ira|iremos|asiste|asistira|asistimos|llega|llegamos|alcanza|alcanzamos)\b/;

/**
 * ¿Pregunta por el horario o la clase de HOY? «¿Cambiaron el horario de
 * hoy?», «¿hay entreno hoy?», «a qué hora es la clase hoy».
 * Un aviso de ausencia («hoy no puede ir a clase») no. Pura.
 */
export function preguntaHorarioDeHoy(texto: string | null | undefined): boolean {
    const crudo = (texto || '').trim();
    if (!crudo) return false;
    const t = normalizarFrase(crudo);
    if (!DE_HORARIO.test(t) || !HOY.test(t)) return false;
    if (AUSENCIA.test(t)) return false;
    return /[?¿]/.test(crudo) || COMO_PREGUNTA.test(t);
}

/** ¿Habla de un cambio, una cancelación o la sede cerrada? (para que la escuela lo vea). */
export function mencionaCambioOCierre(texto: string | null | undefined): boolean {
    return /\b(cambio|cambios|cambiaron|cancel\w*|cerrad[oa]s?|no hay nadie|no han llegado|no ha llegado|no abren|no abrieron)\b/
        .test(normalizarFrase(texto));
}

// ─── Contacto personal de la dueña (conversación v2, 2026-10-24) ─────────────
//
// «Hola Milena buenos días», «Mile querida…», «Hola Milena… me podrías facilitar el
// correo»: quien escribe por primera vez LLAMANDO A LA DUEÑA por su nombre y sin
// pedir nada de la escuela es un conocido, no un cliente. La puerta única
// («¿Ya eres del club?») y «escríbeme tu correo» a eso son ruido. Silencio.
//
// Ante la duda, NO callar: un pedido real de la escuela (`haySenalEscolar`) o
// pedir hablar con una persona (eso se escala) nunca entran acá.

/** Palabras que, tras el saludo, NO son un nombre propio («Hola Buenas tardes», «Hola Quisiera…»). */
const NO_ES_NOMBRE_TRAS_SALUDO = new Set([
    'buenas', 'buenos', 'buen', 'tardes', 'noches', 'dias', 'dia', 'saludos', 'gracias', 'amigos', 'amigas',
    'quisiera', 'necesito', 'quiero', 'queria', 'disculpa', 'disculpe', 'favor', 'podria', 'podrian', 'puedes',
    'pueden', 'hay', 'tienen', 'tiene', 'me', 'mi', 'una', 'un', 'el', 'la', 'info', 'informacion', 'senora',
    'senor', 'doctor', 'doctora', 'profe', 'profesor', 'profesora', 'como', 'que', 'cual', 'cuanto', 'cuando',
    'donde', 'estoy', 'soy', 'somos', 'vi', 'vimos', 'buena', 'bueno', 'todo', 'todos', 'todas', 'favorcito',
]);

/** Apelativos de confianza que delatan una charla entre conocidos. */
// «amor», «bb», «mi vida»: Dynasty 2026-10-17, «Amor será que le hago una colada
// a la bebé» recibió el menú del asistente (auditoría 2026-10-28, X-04).
const APELATIVO_PERSONAL = /\b(querida|querido|amiga|amigo|linda|lindo|hermosa|hermoso|mija|mijo|reina|cielo|corazon|mami|mamita|cari|amor|amorcito|mor|bb|mi vida|gorda|gordo|flaca|flaco|parce|parcero|parcera)\b/;

/** «Hola Fulana» / «Buenas tardes Fulana»: nombre propio (con mayúscula) tras el saludo. */
const SALUDO_Y_NOMBRE = /^\s*(?:[Hh]ola|[Hh]oli|[Hh]ey|[Hh]ello|[Hh]i|[Bb]uen[oa]s?(?:\s+(?:[Dd][ií]as?|[Tt]ardes|[Nn]oches))?|[Ss]aludos)[\s,.!¡:;…-]*(?:[Bb]uen[oa]s?\s+(?:[Dd][ií]as?|[Tt]ardes|[Nn]oches)[\s,.!¡:;…-]*)?([A-ZÁÉÍÓÚÑ][A-Za-záéíóúñ]{2,})/;

/**
 * ¿Le escribe a la dueña (o al equipo) por su nombre, sin pedir nada de la
 * escuela? `equipo`: vocativos del equipo (`vocativosDeEscuela`). `haySenalEscolar`:
 * quien llama pasa `hablaDeLaEscuela` (evita un import circular): con tema de
 * escuela NO es personal. Pura.
 */
export function llamaAPersonaSinPedir(
    texto: string | null | undefined,
    equipo: ReadonlyMap<string, string> = new Map(),
    haySenalEscolar: (t: string) => boolean = () => false,
): boolean {
    const crudo = (texto || '').trim();
    if (!crudo || crudo.length > 400) return false;
    if (haySenalEscolar(crudo)) return false;
    const t = normalizarFrase(crudo);
    if (!t) return false;

    // «Pásame con alguien», «¿estás por acá?»: eso es un pedido real (se escala).
    const pedido = pideALaPersona(crudo, new Map(equipo));
    if (pedido?.tipo === 'escalar') return false;
    if (pedido?.tipo === 'vocativo') return true;

    // El nombre del equipo en cualquier parte de una frase corta con tono de confianza.
    const palabras = t.split(' ');
    if (palabras.some((w) => equipo.has(w)) && palabras.length <= 25) return true;

    // «Hola Fulana…» con un nombre que el equipo no tiene cargado (o sin equipo).
    const m = crudo.match(SALUDO_Y_NOMBRE);
    if (m && !NO_ES_NOMBRE_TRAS_SALUDO.has(normalizarFrase(m[1]))) return true;

    // «Querida, cómo has estado»: confianza sin pedir nada.
    return APELATIVO_PERSONAL.test(t) && palabras.length <= 25;
}
