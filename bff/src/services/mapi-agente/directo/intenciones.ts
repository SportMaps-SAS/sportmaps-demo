/**
 * directo/intenciones — capa 2 de docs/specs/mapi-consultas-sin-ia.md: reconoce
 * por palabras clave las CONSULTAS frecuentes, sin modelo. Pura: no lee la base.
 *
 * Regla de oro: ante la duda, null (= al modelo). Un falso positivo que responde
 * otra cosa es peor que gastar un turno. Por eso:
 *   · cualquier ACCIÓN (excusar, baja, pagar, aprobar, cobrar, enviar…) → null;
 *   · lo compuesto («y», «además»), las negaciones raras y lo que depende de la
 *     conversación («y el de Samuel?», «ese») → null;
 *   · cada intención exige que lo que sobra del mensaje sea vacío, un nombre o un
 *     equipo válido. Lo que no se entiende entero no se responde a medias.
 * Las intenciones se prueban en orden: la primera que encaja gana.
 */

import { extraerFecha, extraerMes, equipoDelResto, objetoDelResto, nombreValido, normalizarMensaje, sinCortesias, sinRelleno } from './texto';

export type FiltroTorneo = 'vigentes' | 'activos' | 'borradores' | 'finalizados';

export type Intencion =
    | { tipo: 'menu' }
    | { tipo: 'ayuda'; consulta: string }
    | { tipo: 'cartera'; mes: string | null }
    | { tipo: 'debe'; nombre: string; mes: string | null }
    | { tipo: 'resumen'; nombre: string; mes: string | null }
    | { tipo: 'por_validar' }
    | { tipo: 'por_que'; nombre: string | null }
    | { tipo: 'auditar' }
    | { tipo: 'aprobacion_automatica' }
    | { tipo: 'asistencia'; equipo: string | null; fecha: string }
    | { tipo: 'semana'; equipo: string | null }
    | { tipo: 'horarios' }
    | { tipo: 'clases_prueba'; fecha: string | null }
    | { tipo: 'whatsapp'; dias: number | null }
    | { tipo: 'reservas'; fecha: string; instalacion: string | null }
    | { tipo: 'tienda'; mes: string | null }
    | { tipo: 'inventario'; producto: string | null }
    | { tipo: 'torneos'; estado: FiltroTorneo }
    | { tipo: 'servicios'; item: string | null }
    | { tipo: 'informes'; nombre: string };

export type TipoIntencion = Intencion['tipo'];

// ─── Guardas ────────────────────────────────────────────────────────────────

/** Frases con forma de verbo que en realidad son una CONSULTA: se tapan antes de buscar acciones. */
const FRASES_DE_CONSULTA = [
    /\b(por|en|a) (validar|aprobar|revisar|responder|contestar)\b/g,
    /\b(por|falta|faltan|le falta|les falta|falta por|faltan por) pagar\b/g,
    /\bsin (validar|aprobar|revisar|responder|contestar|pagar)\b/g,
    /\bpendientes? de (validar|aprobar|revisar|revision|pago)\b/g,
    /\baprobacion automatica\b/g,
    /\bno se (ha )?aprobo\b/g, /\bno (lo |la )?aprobaron\b/g, /\bse aprobo\b/g,
    /\bclases? de prueba\b/g,
    /\b(en )?borrador(es)?\b/g,
];

/**
 * Verbos de ACCIÓN (y sus formas con pronombre). Las acciones siguen saliendo
 * como tarjeta + Confirmar con el modelo; aquí solo se reconocen consultas.
 */
const ACCION = new RegExp('\\b(' + [
    'excus\\w*', 'justific\\w*', 'dar de baja', 'da de baja', 'dale de baja', 'baja', 'bajas', 'retir\\w*', 'paus\\w*', 'reactiv\\w*',
    'aprueb\\w*', 'aprob(ar|arlo|arla|arlos|arlas|ado|ados|ada|adas)', 'registr\\w*', 'pag(a|ar|ale|ales|ue|uen|arle)', 'abon(a|ar|ale|e)',
    'cobr(a|ar|ale|ales|e|en|arle)', 'recuerd\\w*', 'recordatorio\\w*', 'record(ar|ale|ales|arle)', 'envi(a|ar|ale|ales|e|en|arle|alo|ala)',
    'mand(a|ar|ale|ales|e|en|arle|alo|ala)', 'notific\\w*', 'avis(a|ar|ale|ales|e|en|arle)', 'escrib(e|ele|eles|ir|irle)',
    'crea(r|le|lo|la)?', 'cre(e|en)', 'camb(ia|iar|iale|ie|ien|iarle)', 'modific\\w*', 'edit\\w*', 'borr\\w*', 'elimin\\w*',
    'anul\\w*', 'reembols\\w*', 'devolv\\w*', 'devuelv\\w*', 'cancel(a|ar|ale|e|en|arla|arlo)', 'agend(a|ar|ale|ame|e|en|arle)',
    'convoc\\w*', 'inscrib\\w*', 'matricul(a|ar|ale|e)', 'felicit\\w*', 'evalu(a|ar|ale|e|en)', 'califica(r|le)?', 'marc(a|ar|ale|alo|ala|ales)',
    'pas(a|ar|e) (la )?lista', 'tom(a|ar|e) (la )?lista', 'ajust\\w*', 'sub(e|ir|ele|irle)', 'baj(ar|ale|arle)', 'pon(le|er|gale|ganle|go)?',
    'quit\\w*', 'descart\\w*', 'prend\\w*', 'encend\\w*', 'enciend\\w*', 'activ(a|ar|ala|alo|e)', 'apag\\w*', 'desactiv\\w*',
    'asign\\w*', 'mov(er|e|elo|ela)', 'muev\\w*', 'reserv(a|ar|ame|ale|e)', 'aclaracion', 'glos(a|ar)', 'factur\\w*', 'invit\\w*',
    'acept\\w*', 'rechaz\\w*', 'confirm\\w*', 'valid(ar|alo|ala|ame|e)', 'haz', 'hace', 'hacer', 'hagas', 'hagale', 'deshac\\w*',
    'genera(r|le|me)?', 'descarg\\w*', 'export\\w*', 'imprim\\w*', 'compart\\w*', 'reenvi\\w*', 'program\\w*', 'traslad\\w*',
    'congel\\w*', 'suspend\\w*', 'descont\\w*', 'descuent\\w*', 'perdon(a|ar|ale)', 'exoner\\w*', 'regal(a|ar|ale)', 'llam(a|ar|ale)',
].join('|') + ')\\b');

/** Negaciones que cambian el sentido. Las conocidas («no han pagado», «no vino») se tapan antes. */
const NEGACION = /\b(no|ni|nunca|tampoco|jamas|excepto|salvo|menos|sin contar|aparte de)\b/;
const NEGACIONES_CONOCIDAS = [
    /\bno (ha|han|hayan|haya) pagado\b/g, /\bno pag(o|aron)\b/g, /\bno se (ha )?aprobo\b/g, /\bno (lo |la )?aprobaron\b/g,
    /\bno (vino|vinieron|asistio|asistieron|llego|llegaron|fue|fueron)\b/g, /\bno (me |nos )?(han|ha) (respondido|contestado)\b/g,
    /\bno (ha|han) (venido|asistido|llegado)\b/g, /\bno paso\b/g,
];

/** Lo que depende de la conversación anterior: sin el hilo no se sabe de quién hablan. */
const DE_CONTEXTO = /^(y|entonces|o sea|osea|eso|ese|esa|esos|esas|ella|ellos|ellas|el de|la de|los de|las de|lo mismo|igual|otra vez|de nuevo|tambien|y el|y la|y los|y las|ahora el|ahora la|ahora los|ahora las)\b/;

const tapar = (t: string, res: RegExp[]) => res.reduce((s, re) => s.replace(re, ' '), t).replace(/\s+/g, ' ').trim();

export function esAccion(t: string): boolean {
    return ACCION.test(tapar(t, FRASES_DE_CONSULTA));
}

// ─── Utilidades ─────────────────────────────────────────────────────────────

const MENU = /^(menu|el menu|ver menu|opciones|ver opciones|las opciones|ayuda|inicio|empezar|start|comandos|que puedes hacer|que sabes hacer|que haces|que mas haces|en que me (puedes )?ayudar|en que me ayudas|como funcionas|como funciona|que consultas hay|que puedo preguntar|que te puedo preguntar)$/;

/** Ayuda de la app: «¿cómo hago…?», «¿dónde…?». No «cómo va…» (eso es un resumen). */
const AYUDA = /^(como (hago|puedo|se hace|se puede|hacer|hacemos|creo|cambio|agrego|anado|registro|subo|veo|configuro|activo|desactivo|invito|elimino|borro|edito|pongo|quito|cargo|descargo|exporto|imprimo|asigno|inscribo|saco|genero|envio|mando|reviso|apruebo|cobro|cancelo|programo|habilito|uso|encuentro|consigo|recupero)|donde (veo|esta|estan|encuentro|queda|se ve|se hace|puedo|cambio|configuro|registro|creo)|en donde|en que parte|en que pantalla|por donde)\b/;

/** Consulta sin argumentos: el resto, sin relleno, tiene que quedar vacío. */
const vacio = (resto: string) => sinRelleno(resto) === '';

function conMes(t: string, hoy: string): { mes: string | null; resto: string } | null {
    const m = extraerMes(t, hoy);
    return m.dudosa ? null : { mes: m.mes, resto: m.resto };
}

const quitarPatron = (t: string, re: RegExp) => t.replace(re, ' ').replace(/\s+/g, ' ').trim();

// ─── Reconocedores (en orden) ───────────────────────────────────────────────

type Reconocedor = (t: string, hoy: string) => Intencion | null;

const porQue: Reconocedor = (t) => {
    const m = /^por que (no se (ha )?aprobo|no (lo |la )?aprobaron|no se aprueba|no paso|quedo (en|por) validar|quedo pendiente|sigue (pendiente|por validar|en revision)|esta (en )?(rojo|amarillo|revision)|no (ha )?entrado)\b(.*)$/.exec(t);
    if (!m) return null;
    let resto = ` ${m[m.length - 1].trim()} `;
    resto = resto.replace(/ (el|la|los|las|ese|esa) (pago|comprobante|cobro|transferencia|consignacion|soporte)s? /g, ' ')
        .replace(/ (pago|comprobante|cobro|transferencia) /g, ' ').trim();
    if (!resto || /^(de )?(el|la|este|esta|ese|esa)$/.test(resto)) return { tipo: 'por_que', nombre: null };
    const nombre = nombreValido(resto.replace(/^(de|del|a) /, ''));
    return nombre ? { tipo: 'por_que', nombre } : null;
};

const auditar: Reconocedor = (t) =>
    /^(auditar|audita|auditame|auditalos|auditoria|una auditoria|la auditoria)( de| a)?( los| las)?( comprobantes| pagos| pendientes| comprobantes pendientes| pagos pendientes| comprobantes por validar| pagos por validar| por validar)?( que hay| pendientes)?$/.test(t)
        ? { tipo: 'auditar' } : null;

const aprobacionAutomatica: Reconocedor = (t) => {
    if (!/\baprobacion automatica\b/.test(t)) return null;
    const resto = quitarPatron(t, /\b(aprobacion automatica|de los comprobantes|de comprobantes|de pagos|lista de verificacion|lista|checklist|requisitos|que (me |nos |le )?falta(n)?|falta(n)?|para|como (va|esta)|en que va|estado|esta lista|se puede|puedo|podemos|tengo|tenemos|activada|encendida|prendida|apagada)\b/g);
    return vacio(resto) ? { tipo: 'aprobacion_automatica' } : null;
};

const porValidar: Reconocedor = (t) => {
    if (!/\b(por validar|por aprobar|sin validar|sin aprobar|pendientes? de (validar|aprobar|revisar|revision)|por revisar|en revision|comprobantes?|soportes de pago|pagos por revisar|transferencias por revisar)\b/.test(t)) return null;
    const resto = quitarPatron(t, /\b(por validar|por aprobar|sin validar|sin aprobar|pendientes? de (validar|aprobar|revisar|revision)|por revisar|en revision|comprobantes?|soportes de pago|soportes|pagos?|transferencias?|pendientes?|nuevos?|que (han )?llegado|que llegaron|recibidos|que (me )?(han )?mandado|que mandaron|hay|cuantos|cuantas|que|tengo|tenemos|cola|la cola)\b/g);
    return vacio(resto) ? { tipo: 'por_validar' } : null;
};

const CARTERA = /\b(cartera|morosos|moroso|morosidad|deudores|en mora|la mora|mora|cuentas por cobrar|por cobrar)\b|\bquien(es)? (me |nos |le |les )?(debe|deben|esta(n)? debiendo|esta(n)? en mora|no (ha|han) pagado|no pag(o|aron)|esta(n)? atrasad[oa]s?|tiene(n)? deuda(s)?|esta(n)? sin pagar|falta(n)? por pagar|le(s)? falta pagar)\b|\bcuanto (me |nos |se )(deben|debe)\b|\bcuanto (hay|tenemos|llevamos) (en|de) (mora|cartera|deuda|vencido)\b|\b(pagos|cobros|mensualidades|cuotas) (vencid[oa]s|atrasad[oa]s|sin pagar|en mora|por cobrar)\b|\b(lo|la plata) que (me |nos )?deben\b/;

const cartera: Reconocedor = (t, hoy) => {
    if (!CARTERA.test(t)) return null;
    const mm = conMes(t, hoy);
    if (!mm) return null;
    const resto = quitarPatron(mm.resto, new RegExp(CARTERA.source, 'g'));
    const limpio = quitarPatron(resto, /\b(familias?|gente|personas|papas|acudientes|deportistas|total|cuanto|cuanta plata|plata|dinero|vencido|vencida|vencidos|debe|deben|la|el|en|de|mora|esta|estan|hoy)\b/g);
    return vacio(limpio) ? { tipo: 'cartera', mes: mm.mes } : null;
};

/** «cuánto debe X», «X cuánto debe», «ya pagó X», «estado de cuenta de X», «saldo de X». */
const debe: Reconocedor = (t, hoy) => {
    const pats = [
        /^(?:cuanto|que|cuanta plata|cuanto dinero) (?:debe|adeuda|le debe|nos debe|me debe) (.+)$/,
        /^(?:cuanto|que) le falta (?:por )?pagar(?: a)? (.+)$/,
        /^(?:ya pago|pago|esta al dia|debe algo|tiene deuda|tiene saldo pendiente|tiene pagos pendientes|esta en mora|esta atrasad[oa]) (.+)$/,
        /^(?:estado de cuenta|saldo|deuda|cuenta|mensualidad|mensualidades|pagos|cobros) (?:de|del) (.+)$/,
        /^(.+?) (?:cuanto debe|que debe|ya pago|esta al dia|debe algo|tiene deuda|esta en mora|cuanto adeuda)$/,
    ];
    for (const re of pats) {
        const m = re.exec(t);
        if (!m) continue;
        const mm = conMes(m[1], hoy);
        if (!mm) return null;
        const nombre = nombreValido(mm.resto);
        return nombre ? { tipo: 'debe', nombre, mes: mm.mes } : null;
    }
    return null;
};

const informes: Reconocedor = (t) => {
    const m = /^(?:el |los |la |las )?(?:informe|informes|informe mensual|informes mensuales|reporte mensual|reportes mensuales)(?: mensual| mensuales)? (?:de|del|para) (.+)$/.exec(t);
    if (!m) return null;
    const nombre = nombreValido(m[1]);
    return nombre ? { tipo: 'informes', nombre } : null;
};

const resumen: Reconocedor = (t, hoy) => {
    const m = /^(?:como (?:va|le va a|le va|le ha ido a|le fue a|anda|esta)|resumen de|resumen del|estado de|ficha de|info de|informacion de|datos de|novedades de|que tal va) (.+)$/.exec(t);
    if (!m) return null;
    const mm = conMes(m[1], hoy);
    if (!mm) return null;
    const nombre = nombreValido(mm.resto);
    return nombre ? { tipo: 'resumen', nombre, mes: mm.mes } : null;
};

const clasesPrueba: Reconocedor = (t, hoy) => {
    const CLAVE = /\b(clases? de prueba|clases? gratis|clases? de cortesia|prospectos|clase muestra)\b/g;
    if (!CLAVE.test(t)) return null;
    const f = extraerFecha(t, hoy, 'futuro');
    if (f.dudosa) return null;
    const resto = quitarPatron(f.resto, /\b(clases? de prueba|clases? gratis|clases? de cortesia|prospectos|clase muestra|quien(es)?|viene(n)?|agendad[oa]s|programad[oa]s|esta semana|la semana|semana|proximos (7 )?dias|proxima(s)?|hay|tengo|tenemos|cuantas|cuantos|pendientes|para)\b/g);
    return vacio(resto) ? { tipo: 'clases_prueba', fecha: f.fecha } : null;
};

const whatsapp: Reconocedor = (t, hoy) => {
    const CLAVE = /\b(sin responder|sin contestar|por responder|por contestar|seguimiento|whatsapp|mensajes|chats|conversaciones|quien(es)? (me |nos )?(escribio|escribieron|ha escrito|han escrito)|quien(es)? (esta|estan) esperando( respuesta)?)\b/;
    if (!CLAVE.test(t)) return null;
    let dias: number | null = null;
    let s = t;
    const n = /\b(?:los )?(?:ultimos )?(\d{1,2}) dias\b/.exec(s);
    if (n) { dias = Number(n[1]); s = quitarPatron(s, /\b(los )?(ultimos )?\d{1,2} dias\b/); }
    if (/\b(esta semana|la semana|semana)\b/.test(s)) { dias = 7; s = quitarPatron(s, /\b(esta semana|la semana|semana)\b/); }
    if (/\bhoy\b/.test(s)) { dias = 1; s = quitarPatron(s, /\bhoy\b/); }
    if (/\bayer\b/.test(s)) { dias = 2; s = quitarPatron(s, /\bayer\b/); }
    if (dias !== null && (dias < 1 || dias > 31)) return null;
    const resto = quitarPatron(s, /\b(sin responder|sin contestar|por responder|por contestar|seguimiento|whatsapp|de whatsapp|por whatsapp|en whatsapp|mensajes|chats|conversaciones|pendientes|nuevos|quien(es)?|me|nos|escribio|escribieron|ha escrito|han escrito|esta|estan|esperando|respuesta|del|de|el|la|los|las|hay|tengo|tenemos|cuantos|cuantas|que)\b/g);
    return vacio(resto) ? { tipo: 'whatsapp', dias } : null;
};

const reservas: Reconocedor = (t, hoy) => {
    const CLAVE = /\b(reservas|reservaciones|agenda de (las )?canchas|canchas (libres|disponibles|ocupadas)|quien reservo|que reservaron|reservado|reservada)\b/;
    if (!CLAVE.test(t)) return null;
    const f = extraerFecha(t, hoy, 'futuro');
    if (f.dudosa) return null;
    const resto = quitarPatron(f.resto, /\b(reservas|reservaciones|agenda de (las )?canchas|agenda|canchas libres|canchas disponibles|canchas ocupadas|libres|disponibles|ocupadas|quien reservo|que reservaron|reservado|reservada|hay|tengo|tenemos|cuantas|que|para|las|los)\b/g);
    const instalacion = equipoDelResto(resto);
    if (instalacion === null) return null;
    return { tipo: 'reservas', fecha: f.fecha ?? hoy, instalacion: instalacion ?? null };
};

const tienda: Reconocedor = (t, hoy) => {
    const tieneTienda = /\b(tienda|pedidos|ordenes)\b/.test(t);
    const vendido = /\bcuanto (se )?(vendio|vendimos|hemos vendido|llevamos vendido|se ha vendido|vendi)\b/.test(t);
    const ventas = /\bventas?\b/.test(t);
    if (!tieneTienda && !vendido && !ventas) return null;
    const mm = conMes(t, hoy);
    if (!mm) return null;
    const resto = quitarPatron(mm.resto, /\b(ventas?|de la tienda|en la tienda|la tienda|tienda|pedidos|ordenes|cuanto (se )?(vendio|vendimos|hemos vendido|llevamos vendido|se ha vendido|vendi)|como (van|va)|vendido|total)\b/g);
    return vacio(resto) ? { tipo: 'tienda', mes: mm.mes } : null;
};

const inventario: Reconocedor = (t) => {
    if (/^(inventario|el inventario|stock|el stock|existencias|agotados|productos agotados|stock bajo|inventario bajo|que se (esta|estan|nos esta|nos estan) (acabando|agotando)|que (esta|estan) agotad[oa]s?|que hay que reponer|que (falta|hace falta) reponer|lo que se esta acabando)( de la tienda| en la tienda)?$/.test(t)) {
        return { tipo: 'inventario', producto: null };
    }
    const m = /^(?:inventario|stock|existencias|cuanto stock (?:hay|queda)|cuanto (?:hay|queda) en stock) (?:de|del|de la|de los|de las) (.+)$/.exec(t);
    if (!m) return null;
    const producto = objetoDelResto(m[1]);
    return producto ? { tipo: 'inventario', producto } : null;
};

const torneos: Reconocedor = (t) => {
    if (!/\btorneos?\b/.test(t)) return null;
    let estado: FiltroTorneo = 'vigentes';
    if (/\b(activos?|abiertos?|en curso)\b/.test(t)) estado = 'activos';
    else if (/\b(borrador(es)?|en borrador)\b/.test(t)) estado = 'borradores';
    else if (/\b(finalizados?|terminados?|pasados?|anteriores|cancelados?|viejos)\b/.test(t)) estado = 'finalizados';
    const resto = quitarPatron(t, /\b(torneos?|proximos?|vigentes?|activos?|abiertos?|en curso|borrador(es)?|en borrador|finalizados?|terminados?|pasados?|anteriores|cancelados?|viejos|organizamos|organizados|tenemos|hay|que|cuales|los|la|de|del|escuela)\b/g);
    return vacio(resto) ? { tipo: 'torneos', estado } : null;
};

const SERVICIOS = '(clinica|clinicas|vacacional|vacacionales|campamento|campamentos|curso|cursos|taller|talleres|camp|semillero)';

const servicios: Reconocedor = (t) => {
    if (/^(ventas? de servicios|los servicios|servicios|como van los servicios|interesados|los interesados|como van las ventas de servicios)$/.test(t)) return { tipo: 'servicios', item: null };
    const pats = [
        /^(?:como (?:va|van) )?(?:la |las |el |los )?ventas? (?:de|del|de la|de los|de las) (.+)$/,
        /^(?:los )?interesados (?:en|de|del|en la|en el|de la) (.+)$/,
        new RegExp(`^(?:como (?:va|van) )?(?:la |las |el |los )?(${SERVICIOS}(?: .+)?)$`),
    ];
    for (const re of pats) {
        const m = re.exec(t);
        if (!m) continue;
        const item = objetoDelResto(m[1]);
        if (!item) return null;
        // «ventas de octubre» es de la tienda, no un servicio.
        if (/^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|este mes|el mes)$/.test(item)) return null;
        return { tipo: 'servicios', item };
    }
    return null;
};

const horarios: Reconocedor = (t) => {
    if (/^(los |mis |nuestros |sus )?(horarios?|equipos|grupos|categorias)( de (los )?(entrenos|entrenamientos|equipos|clases|grupos))?( de (hoy|manana))?$/.test(t)) return { tipo: 'horarios' };
    if (/^(que|cuales) (equipos|grupos|entrenos|entrenamientos|sesiones|clases) (hay|tengo|tenemos|entrenan|tiene la escuela)( hoy| manana)?$/.test(t)) return { tipo: 'horarios' };
    if (/^(los )?(entrenos|entrenamientos|sesiones) de (hoy|manana)$/.test(t)) return { tipo: 'horarios' };
    if (/^quien(es)? entrena(n)? (hoy|manana)$/.test(t)) return { tipo: 'horarios' };
    if (/^a que horas? (entrenamos|entreno|entrenan|son los entrenos|es el entreno)( hoy| manana)?$/.test(t)) return { tipo: 'horarios' };
    return null;
};

const ASISTENCIA = /\b(asistencia|quien(es)? (falto|faltaron|vino|vinieron|asistio|asistieron|no vino|no vinieron|no asistio|no asistieron|llego|llegaron|no llego|no llegaron)|faltaron|vinieron|como va la lista|la lista de (hoy|ayer)|lista de (hoy|ayer)|ausentes)\b/;

const asistencia: Reconocedor = (t, hoy) => {
    if (!ASISTENCIA.test(t)) return null;
    const f = extraerFecha(t, hoy, 'pasado');
    if (f.dudosa) return null;
    const resto = quitarPatron(f.resto, new RegExp(`${ASISTENCIA.source}|\\b(la|el|los|las|lista|tomada|como fue|como va|como estuvo|que tal|de|del|en|hay|registrada|sesion|entreno|del entreno|de la sesion)\\b`, 'g'));
    const equipo = equipoDelResto(resto);
    if (equipo === null) return null;
    return { tipo: 'asistencia', equipo: equipo ?? null, fecha: f.fecha ?? hoy };
};

const semana: Reconocedor = (t) => {
    const m = /^(?:la |que hay (?:esta|la) )?(?:semana|agenda de la semana|programacion de la semana|entrenos de la semana|sesiones de la semana|proximos 7 dias|esta semana|la semana)(?: (?:de|del|para|en) (.+))?$/.exec(t)
        ?? /^(?:que hay (?:esta|la) semana|que tiene (?:esta|la) semana|como viene la semana|como es la semana)(?: (?:de|del|para|en) (.+))?$/.exec(t)
        ?? /^(?:el )?horarios? (?:de|del|para) (.+)$/.exec(t);
    if (!m) return null;
    const equipo = m[1] ? equipoDelResto(m[1]) : undefined;
    if (equipo === null) return null;
    return { tipo: 'semana', equipo: equipo ?? null };
};

const RECONOCEDORES: Reconocedor[] = [
    porQue, auditar, aprobacionAutomatica, porValidar, cartera, debe, informes, resumen, clasesPrueba, whatsapp, reservas,
    inventario, torneos, servicios, tienda, horarios, asistencia, semana,
];

// ─── Entrada ────────────────────────────────────────────────────────────────

/** Mensajes más largos que esto casi siempre traen contexto o piden dos cosas. */
export const MAX_LARGO = 110;

/**
 * La consulta frecuente que pide el mensaje, o null si hay la menor duda
 * (y entonces responde el modelo). `hoy` en America/Bogota (AAAA-MM-DD). Pura.
 */
export function reconocer(texto: string, hoy: string): Intencion | null {
    const n = normalizarMensaje(texto);
    if (!n || n.length > MAX_LARGO) return null;
    const { texto: t, saludo } = sinCortesias(n);
    if (!t) return saludo ? { tipo: 'menu' } : null;
    if (MENU.test(t)) return { tipo: 'menu' };

    // Lo que depende de la conversación, lo compuesto y las negaciones raras: al modelo.
    if (DE_CONTEXTO.test(t)) return null;
    if (/\b(y|e|ademas|tambien|aparte|junto con|igual que|comparad[oa]|vs|versus|mientras|promedio|porcentaje|tendencia|mejor|peor|mas que|menos que)\b/.test(t)) return null;

    if (AYUDA.test(t) && !/^como (va|van|vamos|esta|estan|le va|les va|anda|andan|voy|vamos)\b/.test(t)) {
        return { tipo: 'ayuda', consulta: t };
    }

    if (NEGACION.test(tapar(t, [...NEGACIONES_CONOCIDAS, ...FRASES_DE_CONSULTA]))) return null;
    if (esAccion(t)) return null;

    for (const r of RECONOCEDORES) {
        const it = r(t, hoy);
        if (it) return it;
    }
    return null;
}
