/**
 * directo/texto — normalización del español de Colombia escrito en un chat
 * (docs/specs/mapi-consultas-sin-ia.md, capa 2). Todo puro: sin red ni base.
 *
 *   · minúsculas, sin tildes ni signos, letras repetidas («holaaa»);
 *   · abreviaturas de WhatsApp («q», «x fa», «xq», «wsp») y errores frecuentes
 *     («asistensia», «comprovante», «aller»);
 *   · cortesías al principio o al final («hola Mapi, me puedes decir…», «gracias»);
 *   · fechas relativas en hora de Colombia a partir de `alcance.hoy` (AAAA-MM-DD).
 */

import { sumarDias } from '../fechas';

/** Palabra suelta → reemplazo (se aplica palabra por palabra). */
const PALABRAS: Record<string, string> = {
    q: 'que', k: 'que', ke: 'que', qe: 'que', xq: 'por que', pq: 'por que', porq: 'por que', porque: 'por que', xk: 'por que',
    x: 'por', pa: 'para', d: 'de', dl: 'del', tb: 'tambien', tmb: 'tambien', tambn: 'tambien',
    hoi: 'hoy', oy: 'hoy', aller: 'ayer', ayel: 'ayer', ayr: 'ayer', anteayer: 'antier', antiayer: 'antier', antenoche: 'antier',
    kuanto: 'cuanto', cuantoo: 'cuanto', cuant: 'cuanto', kuantos: 'cuantos', kuantas: 'cuantas',
    kien: 'quien', kienes: 'quienes', qien: 'quien', qienes: 'quienes', quen: 'quien',
    deve: 'debe', deven: 'deben', deb: 'debe',
    asistensia: 'asistencia', asistecia: 'asistencia', asitencia: 'asistencia', asistenca: 'asistencia', asistencias: 'asistencia',
    asistensias: 'asistencia', asistenia: 'asistencia', asisstencia: 'asistencia',
    orario: 'horario', orarios: 'horarios', horaio: 'horario', horaios: 'horarios',
    comprovante: 'comprobante', comprovantes: 'comprobantes', conprobante: 'comprobante', conprobantes: 'comprobantes',
    balidar: 'validar', valida: 'validar', inbentario: 'inventario', imventario: 'inventario',
    resevas: 'reservas', reserbas: 'reservas', torneo: 'torneo', tornéos: 'torneos',
    wsp: 'whatsapp', wpp: 'whatsapp', whats: 'whatsapp', wasap: 'whatsapp', guasap: 'whatsapp', whatsap: 'whatsapp',
    watsap: 'whatsapp', whatsaap: 'whatsapp', wasa: 'whatsapp',
    xfa: '', xfavor: '', porfa: '', porfis: '', porfavor: '', plis: '', pls: '', please: '', pliss: '', plz: '',
    clace: 'clase', claces: 'clases', pruva: 'prueba', prueva: 'prueba',
    moroso: 'moroso', morozos: 'morosos', morosos: 'morosos', cartera: 'cartera', kartera: 'cartera',
    semna: 'semana', smana: 'semana', mñana: 'manana',
};

/**
 * Normaliza el mensaje para reconocerlo: minúsculas, sin tildes ni signos,
 * abreviaturas y errores frecuentes corregidos. Pura.
 */
export function normalizarMensaje(s: unknown): string {
    let t = String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    // Signos, emojis y comillas fuera; se conservan / y - (fechas «20/11», equipos «sub-12»).
    t = t.replace(/[^a-z0-9/\-\s]/g, ' ');
    t = t.replace(/(^|\s)-+|-+(?=\s|$)/g, ' ');
    // «holaaa», «cuantooo»: tres o más letras iguales seguidas → una.
    t = t.replace(/([a-z])\1{2,}/g, '$1');
    t = t.split(/\s+/).filter(Boolean).map((w) => (w in PALABRAS ? PALABRAS[w] : w)).join(' ');
    return t.replace(/\s+/g, ' ').trim();
}

// ─── Cortesías ──────────────────────────────────────────────────────────────

const SALUDO = /^(hola|holi|ola|buenas tardes|buenas noches|buenos dias|buenas|buen dia|hey|ey|oye|oe|mapi|disculpa|perdon|una pregunta|pregunta|a ver|bueno|por fa|por favor)\b\s*/;
const PEDIDO = new RegExp('^(' + [
    'me (puedes|podrias|pudieras|podes|puede|podria) (decir|mostrar|contar|pasar|dar|regalar|confirmar|enviar|mandar)',
    '(puedes|podrias|pudieras|podes|puede|podria) (decirme|mostrarme|contarme|pasarme|darme|regalarme|decir|mostrar|contar|revisar|consultar|ver)',
    'dime', 'dame', 'muestrame', 'mostrame', 'cuentame', 'contame', 'pasame', 'regalame',
    'me regalas', 'me dices', 'me cuentas', 'me muestras', 'me pasas', 'me das', 'me ayudas con', 'ayudame con',
    '(quiero|necesito|quisiera|queria) (saber|ver|conocer|revisar|consultar)', 'necesito', 'quiero', 'quisiera',
    'sabes', 'consultar', 'consulta', 'ver', 'revisa', 'revisar', 'revisame', 'mira', 'mirame', 'chequea', 'chequear',
].join('|') + ')\\b\\s*');
const DESPEDIDA = /\s*\b(por favor|por fa|gracias|muchas gracias|mil gracias|mapi|ya|ahora|ahorita|rapido|porfa)$/;

/** Quita saludos, «me puedes decir…» y «gracias» del principio y del final. Pura. */
export function sinCortesias(t: string): { texto: string; saludo: boolean } {
    let s = t;
    let saludo = false;
    for (let i = 0; i < 6; i++) {
        const antes = s;
        if (SALUDO.test(s)) { saludo = true; s = s.replace(SALUDO, ''); }
        s = s.replace(PEDIDO, '').replace(DESPEDIDA, '').trim();
        if (s === antes) break;
    }
    return { texto: s.trim(), saludo };
}

// ─── Fechas (hora de Colombia: `hoy` ya viene en America/Bogota) ────────────

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MES_RE = `(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)`;
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

const numMes = (m: string) => (m === 'setiembre' ? 9 : MESES.indexOf(m) + 1);
const dos = (n: number) => String(n).padStart(2, '0');

function fechaValida(y: number, m: number, d: number): string | null {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const iso = `${y}-${dos(m)}-${dos(d)}`;
    const f = new Date(`${iso}T00:00:00Z`);
    return !Number.isNaN(f.getTime()) && f.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Hacia dónde mira la consulta cuando la fecha es ambigua («el lunes»). */
export type Orientacion = 'pasado' | 'futuro';

export interface FechaExtraida {
    fecha: string | null;
    resto: string;
    /** Dos fechas, «en la mañana» (¿mañana o por la mañana?) o un día imposible. */
    dudosa: boolean;
}

const CONECTOR = '(?:(?:de|del|para|el|en|por) )*';

/**
 * Saca UNA fecha del texto y devuelve el resto. «hoy», «ayer», «antier»,
 * «mañana», «pasado mañana», «el lunes», «el 20», «20 de noviembre», «20/11»,
 * «2026-11-20». Pura.
 */
export function extraerFecha(t: string, hoy: string, orientacion: Orientacion): FechaExtraida {
    let resto = ` ${t} `;
    const halladas: string[] = [];
    let dudosa = false;
    const quitar = (re: RegExp, f: (m: RegExpExecArray) => string | null) => {
        let m: RegExpExecArray | null;
        while ((m = re.exec(resto))) {
            const fecha = f(m);
            if (fecha) halladas.push(fecha); else dudosa = true;
            resto = `${resto.slice(0, m.index)} ${resto.slice(m.index + m[0].length)}`;
            re.lastIndex = 0;
        }
    };
    const [y, mHoy] = hoy.split('-').map(Number);

    // «en la mañana» / «por la mañana»: ¿mañana o la jornada? Nunca se adivina.
    if (/ (en|por|de) la manana /.test(resto)) dudosa = true;
    quitar(new RegExp(` ${CONECTOR}pasado manana `, 'g'), () => sumarDias(hoy, 2));
    quitar(new RegExp(` ${CONECTOR}hoy `, 'g'), () => hoy);
    quitar(new RegExp(` ${CONECTOR}ayer `, 'g'), () => sumarDias(hoy, -1));
    quitar(new RegExp(` ${CONECTOR}antier `, 'g'), () => sumarDias(hoy, -2));
    quitar(new RegExp(` ${CONECTOR}manana `, 'g'), () => sumarDias(hoy, 1));
    quitar(/ (?:(?:de|del|para|en) )*(\d{4})-(\d{2})-(\d{2}) /g, (m) => fechaValida(Number(m[1]), Number(m[2]), Number(m[3])));
    quitar(/ (?:(?:de|del|para|el|en) )*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))? /g, (m) => {
        const anio = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : y;
        return fechaValida(anio, Number(m[2]), Number(m[1]));
    });
    quitar(new RegExp(` ${CONECTOR}(\\d{1,2}) de ${MES_RE}(?: de(?:l)? (\\d{4}))? `, 'g'), (m) => {
        const mes = numMes(m[2]);
        const anio = m[3] ? Number(m[3]) : y;
        return fechaValida(anio, mes, Number(m[1]));
    });
    quitar(new RegExp(` ${CONECTOR}(lunes|martes|miercoles|jueves|viernes|sabado|domingo)( pasado| que viene| proximo| que paso)? `, 'g'), (m) => {
        const objetivo = DIAS_SEMANA.indexOf(m[1]);
        const hoyDow = new Date(`${hoy}T00:00:00Z`).getUTCDay();
        const sufijo = (m[2] ?? '').trim();
        const haciaAtras = sufijo === 'pasado' || sufijo === 'que paso' || (!sufijo && orientacion === 'pasado');
        if (haciaAtras) {
            const d = (hoyDow - objetivo + 7) % 7;
            return sumarDias(hoy, sufijo ? (d === 0 ? -7 : -d) : -d);
        }
        const d = (objetivo - hoyDow + 7) % 7;
        return sumarDias(hoy, sufijo ? (d === 0 ? 7 : d) : d);
    });
    // «el 20» solo: día del mes en curso.
    quitar(/ (?:(?:de|del|para|en) )*el (\d{1,2}) /g, (m) => fechaValida(y, mHoy, Number(m[1])));

    const unicas = [...new Set(halladas)];
    if (unicas.length > 1) dudosa = true;
    return { fecha: unicas.length === 1 ? unicas[0] : null, resto: resto.replace(/\s+/g, ' ').trim(), dudosa };
}

export interface MesExtraido {
    mes: string | null;
    resto: string;
    dudosa: boolean;
}

/**
 * Saca UN mes (AAAA-MM): «este mes», «del mes», «el mes pasado», «noviembre»,
 * «octubre de 2025». Un mes sin año que todavía no llega es del año pasado. Pura.
 */
export function extraerMes(t: string, hoy: string): MesExtraido {
    let resto = ` ${t} `;
    const hallados: string[] = [];
    const actual = hoy.slice(0, 7);
    const [y, m] = actual.split('-').map(Number);
    const quitar = (re: RegExp, f: (x: RegExpExecArray) => string) => {
        let x: RegExpExecArray | null;
        while ((x = re.exec(resto))) {
            hallados.push(f(x));
            resto = `${resto.slice(0, x.index)} ${resto.slice(x.index + x[0].length)}`;
            re.lastIndex = 0;
        }
    };
    quitar(/ (?:(?:de|del|en|para) )*(?:el )?(?:mes pasado|mes anterior) /g, () => (m === 1 ? `${y - 1}-12` : `${y}-${dos(m - 1)}`));
    quitar(/ (?:(?:de|del|en|para) )*(?:este mes|el mes en curso|mes en curso|mes actual|el mes|mes) /g, () => actual);
    quitar(new RegExp(` (?:(?:de|del|en|para) )*(?:(?:el )?mes de )?${MES_RE}(?: de(?:l)? (\\d{4}))? `, 'g'), (x) => {
        const mes = numMes(x[1]);
        const anio = x[2] ? Number(x[2]) : mes > m ? y - 1 : y;
        return `${anio}-${dos(mes)}`;
    });
    const unicos = [...new Set(hallados)];
    return { mes: unicos.length === 1 ? unicos[0] : null, resto: resto.replace(/\s+/g, ' ').trim(), dudosa: unicos.length > 1 };
}

// ─── Nombres y equipos ──────────────────────────────────────────────────────

/** Palabras que nunca son (parte de) el nombre de un deportista: si aparecen, va al modelo. */
const NO_NOMBRES = new Set([
    // pronombres y cuantificadores
    'el', 'ella', 'ellos', 'ellas', 'ese', 'esa', 'eso', 'esos', 'esas', 'este', 'esta', 'esto', 'estos', 'estas', 'aquel', 'usted',
    'yo', 'tu', 'mi', 'mis', 'nosotros', 'todos', 'todas', 'todo', 'nadie', 'alguien', 'cada', 'uno', 'cual', 'cuales', 'quien',
    'quienes', 'que', 'cuanto', 'cuantos', 'como', 'porque', 'lo', 'le', 'les', 'me', 'nos', 'se', 'y', 'o', 'pero', 'no', 'si',
    // personas por rol o parentesco (el modelo resuelve «el hijo de…»)
    'hijo', 'hija', 'hijos', 'hijas', 'nino', 'nina', 'ninos', 'ninas', 'mama', 'papa', 'padre', 'madre', 'padres', 'acudiente',
    'acudientes', 'familia', 'familias', 'papas', 'mamas', 'deportista', 'deportistas', 'jugador', 'jugadores', 'jugadora',
    'jugadoras', 'alumno', 'alumnos', 'alumna', 'alumnas', 'estudiante', 'estudiantes', 'atleta', 'atletas', 'chico', 'chicos',
    'chica', 'chicas', 'muchacho', 'muchachos', 'pelado', 'pelados', 'gente', 'profe', 'profesor', 'entrenador', 'entrenadores',
    'coach', 'hermano', 'hermana', 'hermanos', 'sobrino', 'sobrina', 'nieto', 'nieta', 'senor', 'senora', 'don', 'dona',
    // tiempo
    'hoy', 'ayer', 'manana', 'antier', 'mes', 'meses', 'semana', 'semanas', 'ano', 'anos', 'dia', 'dias', 'lunes', 'martes',
    'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', ...MESES, 'pasado', 'proximo', 'actual',
    // la escuela y sus módulos
    'escuela', 'club', 'academia', 'equipo', 'equipos', 'grupo', 'grupos', 'categoria', 'categorias', 'sub', 'asistencia',
    'cartera', 'pago', 'pagos', 'plata', 'dinero', 'cobro', 'cobros', 'deuda', 'deudas', 'mensualidad', 'mensualidades', 'tienda',
    'venta', 'ventas', 'pedido', 'pedidos', 'reserva', 'reservas', 'cancha', 'canchas', 'torneo', 'torneos', 'clase', 'clases',
    'prueba', 'whatsapp', 'mensaje', 'mensajes', 'informe', 'informes', 'reporte', 'reportes', 'inventario', 'stock',
    'comprobante', 'comprobantes', 'horario', 'horarios', 'entreno', 'entrenos', 'entrenamiento', 'sesion', 'sesiones', 'clinica',
    'vacacional', 'servicio', 'servicios', 'app', 'sistema', 'mapi', 'sportmaps', 'total', 'general', 'resumen', 'estado',
    'cuenta', 'saldo', 'cosa', 'cosas', 'vaina', 'tal', 'bien', 'mal', 'nuevo', 'nuevos', 'otro', 'otra', 'otros', 'mas', 'menos',
    'lista', 'partido', 'partidos', 'evaluacion', 'nota', 'notas', 'salud', 'lesion', 'rodilla', 'uniforme', 'carnet',
    'matricula', 'inscripcion', 'inscripciones', 'plan', 'planes', 'tarifa', 'precio', 'precios', 'vamos', 'va', 'van',
]);
/** Palabras que pueden ir DENTRO de un nombre («María de los Ángeles»), nunca al principio. */
const UNIONES = new Set(['de', 'del', 'la', 'los', 'las']);

/** El nombre de un deportista tal como lo escribieron, o null si no parece un nombre. Pura. */
export function nombreValido(s: string): string | null {
    let t = ` ${s.trim()} `;
    for (let i = 0; i < 3; i++) t = t.replace(/^ (a|al|el|la|los|las|de|del|a la|para|sobre) /, ' ');
    const w = t.trim().split(' ').filter(Boolean);
    if (!w.length || w.length > 5) return null;
    if (UNIONES.has(w[0]) || UNIONES.has(w[w.length - 1])) return null;
    if (w.filter((x) => !UNIONES.has(x)).length > 4) return null;
    for (const x of w) {
        if (UNIONES.has(x)) continue;
        if (!/^[a-z]{2,}$/.test(x) || NO_NOMBRES.has(x)) return null;
    }
    return w.join(' ');
}

/** Palabras que nunca son el nombre de un equipo (son otra consulta o un pronombre). */
const NO_EQUIPOS = new Set([
    'el', 'ella', 'ellos', 'ellas', 'ese', 'esa', 'eso', 'esos', 'esas', 'todos', 'todas', 'todo', 'escuela', 'club', 'yo', 'nosotros',
    'pago', 'pagos', 'plata', 'debe', 'deben', 'cartera', 'tienda', 'venta', 'ventas', 'reserva', 'reservas', 'torneo', 'torneos',
    'prueba', 'whatsapp', 'comprobante', 'comprobantes', 'informe', 'informes', 'inventario', 'stock', 'mensualidad', 'cobro',
    'cobros', 'que', 'quien', 'quienes', 'cuanto', 'cuantos', 'como', 'por', 'hoy', 'ayer', 'manana', 'semana', 'mes', 'dia',
    'y', 'o', 'no', 'si', 'pero', 'hijo', 'hija', 'deportista', 'jugador', 'salud', 'clinica', 'servicio', 'servicios',
]);

/**
 * El equipo escrito en el resto del mensaje. `undefined` = no nombró ninguno
 * («asistencia de hoy», «de mi equipo»); null = lo que queda no parece un equipo. Pura.
 */
export function equipoDelResto(resto: string): string | null | undefined {
    let t = ` ${resto.trim()} `;
    for (let i = 0; i < 4; i++) {
        t = t.replace(/^ (de|del|en|el|la|los|las|para|con|a|al|equipo|grupo|categoria|mi|mis|nuestro|nuestra|nuestros|nuestras|como va|como fue|como estuvo|como) /, ' ');
    }
    const w = t.trim().split(' ').filter(Boolean);
    if (!w.length) return undefined;
    if (w.length > 5) return null;
    if (w.some((x) => !/^[a-z0-9-]+$/.test(x) || NO_EQUIPOS.has(x))) return null;
    return w.join(' ');
}

/**
 * El nombre de un servicio, producto o instalación escrito en el resto
 * («la clínica de porteros», «camiseta azul»). null si no parece un nombre. Pura.
 */
export function objetoDelResto(resto: string): string | null {
    let t = ` ${resto.trim()} `;
    for (let i = 0; i < 3; i++) t = t.replace(/^ (de|del|en|el|la|los|las|para|con|a|al) /, ' ');
    const w = t.trim().split(' ').filter(Boolean);
    if (!w.length || w.length > 6) return null;
    if (w.some((x) => !/^[a-z0-9-]+$/.test(x) || NO_OBJETOS.has(x))) return null;
    return w.join(' ');
}
const NO_OBJETOS = new Set(['el', 'ella', 'ellos', 'ellas', 'ese', 'esa', 'eso', 'esos', 'esas', 'todos', 'todas', 'todo', 'y', 'o', 'no',
    'si', 'pero', 'que', 'quien', 'quienes', 'cuanto', 'cuantos', 'como', 'hoy', 'ayer', 'manana', 'mes', 'semana', 'tienda',
    'debe', 'deben', 'cartera', 'pago', 'pagos', 'hijo', 'hija', 'deportista']);

/** Quita palabras de relleno y deja lo que en realidad se preguntó. Pura. */
export function sinRelleno(t: string): string {
    return t.replace(/\b(de|del|la|el|los|las|en|a|al|para|por|que|hay|tengo|tenemos|tiene|tienen|mi|mis|nuestra|nuestro|nuestras|nuestros|escuela|club|academia|me|nos|lo|todo|todos|todas|completo|completa|actual|ahora|ahorita|cual|cuales|como|va|van|vamos|esta|estan|son|es|un|una|unos|unas|cuantos|cuantas|cuanto|ver|lista|listado|quiero|saber|toda|general|resumen|estado|si|ya|hoy|bueno|entonces|pues|ok|vale|listo)\b/g, ' ')
        .replace(/\s+/g, ' ').trim();
}
