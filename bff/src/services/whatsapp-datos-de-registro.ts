/**
 * Los DATOS DE REGISTRO de quien asiste a un servicio que el bot vende por WhatsApp
 * (clínica, vacacional, torneo). Módulo PURO: sin base, sin red y sin reloj (la fecha
 * de hoy entra por parámetro).
 *
 * Decisión de producto (2026-11-16): los datos son OBLIGATORIOS. La inscripción no
 * queda completa hasta tener
 *   1. el nombre completo de quien asiste,
 *   2. la fecha de nacimiento (se acepta la edad, marcada como «solo edad»: la fecha
 *      sigue faltando),
 *   3. si es menor de 18 años, el nombre de la persona responsable (acudiente).
 * Opcional, se guarda si viene: la posición de juego. Nunca se pide documento.
 *
 * El nombre se lee con `nombreDeAsistente` (whatsapp-comprobante-de-ficha.service),
 * que solo mira el COMIENZO de un texto. Acá se le pasa cada tramo del mensaje (cada
 * línea y cada parte separada por «/», «·», «;») y lo que sigue a una marca («la
 * niña…», «a nombre de…»), así el nombre se encuentra aunque no venga de primero.
 */
import { nombreDeAsistente } from './whatsapp-comprobante-de-ficha.service';
import { normalizarFrase } from './whatsapp-reglas-turno';

export interface DatosDeRegistro {
    nombre: string | null;
    /** 'YYYY-MM-DD' */
    fechaNacimiento: string | null;
    /** La calculada con la fecha; si no hay fecha, la que dijo la persona (o la aproximada por el año). */
    edad: number | null;
    /** Dieron edad (o solo el año) pero no la fecha completa. */
    soloEdad: boolean;
    acudiente: string | null;
    /** Masculino singular sin tilde: 'armador', 'opuesto', 'central', 'libero', 'punta', 'atacante', 'receptor'… */
    posicion: string | null;
}
export type DatoFaltante = 'nombre' | 'fecha_nacimiento' | 'acudiente';

const VACIO: DatosDeRegistro = { nombre: null, fechaNacimiento: null, edad: null, soloEdad: false, acudiente: null, posicion: null };

export const EDAD_MINIMA = 3;
export const EDAD_MAXIMA = 90;
export const MAYORIA_DE_EDAD = 18;

// ─── Texto ──────────────────────────────────────────────────────────────────

/** Sin emojis, sin el formato de WhatsApp (*negrita*, _cursiva_) y sin caracteres invisibles. */
function limpiar(texto: string | null | undefined): string {
    return String(texto ?? '')
        .normalize('NFC')
        .replace(/[​-‍﻿️]/g, '')
        .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}]/gu, ' ')
        .replace(/[*_~`]/g, ' ');
}

/** Minúsculas y sin tildes, carácter por carácter: conserva las posiciones del original. */
function plano(t: string): string {
    let s = '';
    for (const c of t) {
        const b = c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
        s += b.length === c.length ? b : c;
    }
    return s;
}

/** Líneas y tramos: salto de línea, «·», «;», «|», « / », « - » (nunca el «/» de una fecha). */
function tramos(t: string): string[] {
    return t.split(/\r?\n|[·•;|]|\s+[/–—-]\s+|(?<=[^\d\s])\/(?=[^\d\s])/).map((s) => s.trim()).filter(Boolean);
}

// ─── Fecha de nacimiento y edad ─────────────────────────────────────────────

interface Fecha { y: number; m: number; d: number }

function partirFecha(iso: string | null | undefined): Fecha | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
    if (!m) return null;
    const f = { y: +m[1], m: +m[2], d: +m[3] };
    return fechaReal(f) ? f : null;
}
const fechaReal = (f: Fecha) => {
    if (f.m < 1 || f.m > 12 || f.d < 1) return false;
    const u = new Date(Date.UTC(f.y, f.m - 1, f.d));
    return u.getUTCFullYear() === f.y && u.getUTCMonth() === f.m - 1 && u.getUTCDate() === f.d;
};
const dos = (n: number) => String(n).padStart(2, '0');
const aIso = (f: Fecha) => `${f.y}-${dos(f.m)}-${dos(f.d)}`;

/** Años cumplidos en `hoy` de quien nació en `fecha` (las dos 'YYYY-MM-DD'). null si alguna no es una fecha. Pura. */
export function edadEn(fecha: string | null | undefined, hoy: string): number | null {
    const n = partirFecha(fecha);
    const h = partirFecha(hoy);
    if (!n || !h) return null;
    return h.y - n.y - (h.m < n.m || (h.m === n.m && h.d < n.d) ? 1 : 0);
}

const MESES: Record<string, number> = {
    enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6,
    julio: 7, jul: 7, agosto: 8, ago: 8, septiembre: 9, setiembre: 9, sept: 9, sep: 9, set: 9, octubre: 10, oct: 10,
    noviembre: 11, nov: 11, diciembre: 12, dic: 12,
};
const MES = '(enero|ene|febrero|feb|marzo|mar|abril|abr|mayo|may|junio|jun|julio|jul|agosto|ago|septiembre|setiembre|sept|sep|set|octubre|oct|noviembre|nov|diciembre|dic)\\b\\.?';

/** «nacimiento», «nació», «nacida», «cumpleaños», «f. nac.»: lo que hace de una fecha una fecha de NACIMIENTO. */
const MARCA_DE_NACIMIENTO = /nacimiento|\bnaci[oó]?\b|\bnacid[oa]\b|cumple|\bf\.?\s?nac/;

/** «07» → 2007 si no supera el año de hoy; si no, 1907… → 19xx. */
function anoCompleto(texto: string, hoyY: number): number {
    const n = Number(texto);
    if (texto.length !== 2) return n;
    return 2000 + n <= hoyY ? 2000 + n : 1900 + n;
}

/**
 * La fecha de nacimiento escrita en `p` (texto plano), o null. Día/mes/año.
 * Sin una marca de nacimiento cerca solo vale una fecha COMPLETA cuya edad sea
 * plausible (3 a 90 años): así no se lee la fecha del evento ni la del pago, que
 * son de este año o vienen sin año («del 23 al 27 de noviembre»).
 */
function fechaDeNacimientoEn(p: string, hoy: Fecha): string | null {
    const hallazgos: { i: number; f: Fecha }[] = [];
    const agregar = (re: RegExp, armar: (m: RegExpExecArray) => Fecha) => {
        for (let m = re.exec(p); m; m = re.exec(p)) hallazgos.push({ i: m.index, f: armar(m) });
    };
    // 22/06/2007 · 22-06-2007 · 22 / 06 / 07 (el mismo separador las dos veces)
    agregar(/(?<![\d/\-.])(\d{1,2})\s?([/-])\s?(\d{1,2})\s?\2\s?(\d{4}|\d{2})(?![\d/\-])/g,
        (m) => ({ d: +m[1], m: +m[3], y: anoCompleto(m[4], hoy.y) }));
    // 22.06.2007 (con punto, pegado: «2. 03/05/2014» es una lista numerada)
    agregar(/(?<![\d/\-.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?![\d.])/g,
        (m) => ({ d: +m[1], m: +m[2], y: anoCompleto(m[3], hoy.y) }));
    // 22 06 2007 (con espacios: solo con el año completo)
    agregar(/(?<!\d)(\d{1,2})\s+(\d{1,2})\s+((?:19|20)\d{2})(?!\d)/g, (m) => ({ d: +m[1], m: +m[2], y: +m[3] }));
    // 2007-06-22
    agregar(/(?<!\d)((?:19|20)\d{2})([/\-.])(\d{1,2})\2(\d{1,2})(?!\d)/g, (m) => ({ y: +m[1], m: +m[3], d: +m[4] }));
    // 22 de junio de 2007 · 22 junio 2007 · 3 de mayo del 2012 (el año, completo)
    agregar(new RegExp(`(?<!\\d)(\\d{1,2})\\s*(?:de\\s+)?${MES},?\\s*(?:de\\s+|del\\s+)?(?:ano\\s+)?((?:19|20)\\d{2})(?!\\d)`, 'g'),
        (m) => ({ d: +m[1], m: MESES[m[2]], y: +m[3] }));
    // junio 22 de 2007
    agregar(new RegExp(`\\b${MES}\\s*(\\d{1,2})(?:\\s*,|\\s+del?)?\\s+((?:19|20)\\d{2})(?!\\d)`, 'g'),
        (m) => ({ m: MESES[m[1]], d: +m[2], y: +m[3] }));

    hallazgos.sort((a, b) => a.i - b.i);
    const hoyIso = aIso(hoy);
    let sinMarca: string | null = null;
    for (const h of hallazgos) {
        if (!fechaReal(h.f)) continue;
        const iso = aIso(h.f);
        const edad = edadEn(iso, hoyIso);
        if (edad === null || iso > hoyIso || edad > EDAD_MAXIMA) continue;
        if (MARCA_DE_NACIMIENTO.test(p.slice(Math.max(0, h.i - 40), h.i))) return iso;
        if (edad >= EDAD_MINIMA && !sinMarca) sinMarca = iso;
    }
    return sinMarca;
}

const edadValida = (n: number) => Number.isInteger(n) && n >= EDAD_MINIMA && n <= EDAD_MAXIMA;

/** «13 años», «13 años 6 meses», «tiene 13», «de 13 añitos», «edad: 13». null si no la dicen. */
function edadDichaEn(p: string): number | null {
    const patrones = [
        // «lleva 3 años jugando», «hace 2 años», «5 años de experiencia» no son la edad
        /(?<!\d)(?<!(?:lleva|llevo|llevamos|hace|desde|durante|por|en)\s)(\d{1,2})\s*an(?:os|itos)\b(?!\s+(?:de\s+experiencia|jugando|entrenando|practicando|en\s))/g,
        /\bedad\s*(?::|=|es|de)?\s*(\d{1,2})(?![\d/\-.])/g,
        /\b(?:tiene|tengo|cumplio|cumple|cumpli)\s+(?:ya\s+)?(\d{1,2})(?![\d/\-.])(?!\s*(?:semanas?|meses|mes|dias?|clases?|horas?|cupos?|hij[oa]s?|nin[oa]s?|partidos?|pagos?|de\s))/g,
    ];
    for (const re of patrones) {
        for (let m = re.exec(p); m; m = re.exec(p)) {
            const n = Number(m[1]);
            if (edadValida(n)) return n;
        }
    }
    return null;
}

/** Un año suelto con marca («año 2007», «nació en 2012», «categoría 2012», «es del 2010») o un tramo que es solo el año. */
function anoDeNacimientoEn(p: string, hoyY: number): number | null {
    const candidatos: string[] = [];
    const conMarca = /\b(?:ano|nacimiento|nacio|naci|nacid[oa]|categoria|cat|es\s+del|soy\s+del|es\s+de)\b[^0-9\n]{0,20}?((?:19|20)\d{2})(?![\d/\-.])/g;
    for (let m = conMarca.exec(p); m; m = conMarca.exec(p)) candidatos.push(m[1]);
    for (const tramo of tramos(p)) if (/^(?:19|20)\d{2}$/.test(tramo)) candidatos.push(tramo);
    for (const c of candidatos) if (edadValida(hoyY - Number(c))) return Number(c);
    return null;
}

// ─── Posición de juego ──────────────────────────────────────────────────────

/** La misma lista de `DATO_DE_ASISTENTE` (whatsapp-venta-servicio), en singular: «armadores y atacantes» es el servicio. */
const POSICIONES = 'armadora?|opuest[oa]|central|libero|punta|atacante|receptora?|levantadora?|colocadora?|pasadora?';
const POSICION_CON_MARCA = new RegExp(`\\bposicion\\s*(?::|=|es|de)?\\s*(?:de\\s+)?(${POSICIONES})\\b`);
const POSICION_SUELTA = new RegExp(`(?<!(?:sede|cancha|zona|parque|oficina)\\s)\\b(${POSICIONES})\\b`);

function posicionEn(p: string): string | null {
    const m = POSICION_CON_MARCA.exec(p) ?? POSICION_SUELTA.exec(p);
    if (!m) return null;
    return m[1].replace(/^opuesta$/, 'opuesto').replace(/(dor|tor)a$/, '$1');
}

// ─── Nombre y acudiente ─────────────────────────────────────────────────────

/**
 * Palabras que `nombreDeAsistente` deja pasar y que no son de un nombre: cortesías
 * («Mucho gusto», «Dios los bendiga») y palabras del pago o del servicio.
 */
const NO_ES_NOMBRE = new Set(('mucho mucha muchos gusto feliz saludos bendiciones bendicion bendiga dios igualmente amable ' +
    'amables tranquilo tranquila hecho ahora luego despues manana hoy ayer verdad seguro segura comparto compartimos ' +
    'separar apartar reservar semana semanas evento eventos descuento datos puestos escritos exitosa exitoso ahorros ' +
    'corriente banco total referencia numero celular telefono whatsapp academia deportivo deportiva inscribir ' +
    'inscribirme quisiera deseo estamos somos vamos puedes podria tienes cuesta cuestan mes meses dos tres ambos ambas ' +
    'realizado realizada enviado enviada hago hice hicimos debe deben firmar pendiente queda quedamos recibo recibido ' +
    'aprobado aprobada persona responsable acudiente mama papa mami papi madre padre').split(' '));

const DOCUMENTO = /(?<![\p{L}\d])(?:c\.?\s?c\.?|t\.?\s?i\.?|r\.?\s?c\.?|cedula|documento|doc|identificacion|nit|tel|cel)(?![\p{L}\d])/u;

/** `nombreDeAsistente` sobre un tramo (recortado a su tope de 160) y sin las palabras que no son de nombre. */
function nombreEn(t: string, o: { entero?: boolean } = {}): string | null {
    let s = t.trim().replace(/^(?:\d{1,2}[.)]\s+|[-•>]+\s*)/, '');
    if (s.length > 160) {
        if (o.entero) return null;
        s = s.slice(0, 160).replace(/\s+\S*$/, '');
    }
    if (!o.entero) {
        // «Sara Torres Díaz cc 1012…», «… T.I. 1034…»: el documento no se pide y no es parte del nombre.
        const doc = plano(s).search(DOCUMENTO);
        if (doc > 0) s = s.slice(0, doc);
    }
    const n = nombreDeAsistente(s, o);
    if (!n) return null;
    const palabras = normalizarFrase(n).split(' ');
    // «Daniela y Sara Torres Díaz» son dos personas: no se decide.
    return palabras.includes('y') || palabras.some((w) => NO_ES_NOMBRE.has(w)) ? null : n;
}

const PARIENTE = '(?:mama|mami|madre|papa|papi|padre|acudiente|abuel[ao]|abuelit[ao]|ti[ao]|herman[ao]|madrina|padrino|tutora?|responsable)';

/** «acudiente: …», «responsable: …», «nombre del acudiente: …»: SIEMPRE con «:», «=», «es» o «se llama». */
const ACUDIENTE_A = /(?:\bnombres?\s+(?:completo\s+)?(?:de\s+la\s+|del\s+|de\s+(?:el\s+)?)?)?\b(?:(?:persona\s+)?responsable|acudiente|representante(?:\s+legal)?|tutora?)\s*(?::|=|\bes\b|\bse llama\b)\s*(.+)$/;
/** «mamá: …», «papá: …», «la mamá es …», «su mamá se llama …». */
const ACUDIENTE_B = /\b(?:(?:mi|su|la|el)\s+)?(?:mama|mami|madre|papa|papi|padre)\s*(?::|=|\bes\b|\bse llama\b)\s*(.+)$/;
/** «soy su mamá, Brady Luz». */
const SOY_PARIENTE = new RegExp(`\\bsoy\\s+(?:su|la|el)\\s+${PARIENTE}(?:\\s+de\\s+[^,:]+)?\\s*[,:]\\s*(.+)$`);
/** «Soy …», «me llamo …», «mi nombre es …»: es quien ESCRIBE. */
const SOY = /^(?:[^\p{L}]*(?:hola|buen[oa]s?(?:\s+(?:dias?|tardes?|noches?))?)\b)?[\s,.!]*(?:soy|me llamo|mi nombre es)\s+(.+)$/u;
const CORTE_DE_SOY = new RegExp(`,|\\s+(?:(?:la|el|su)\\s+)?${PARIENTE}\\b|\\s+y\\s+`);
/** Las marcas tras las que viene el nombre de quien asiste. */
const MARCA = new RegExp('(?:' + [
    '\\ba nombre de',
    '\\bnombres?(?:\\s+y\\s+apellidos?)?(?:\\s+completos?)?(?:\\s+es)?\\s*:?',
    '\\bse llama',
    '\\b(?:la|el|del|mi|una?)\\s+nin[ao]',
    '\\bmi\\s+(?:hij[ao]|sobrin[ao]|niet[ao]|herman[ao]|ahijad[ao])',
    // «Jugador 1: VALENTINA…», «Participante #2 - …» (dos asistentes en un mensaje).
    '\\b(?:participante|asistente|deportista|jugadora?|alumn[ao]|estudiante|atleta)(?:\\s*(?:n[°ºo]?\\.?\\s*|#\\s*)?\\d{1,2}\\s*[.)-]?)?(?:\\s+es)?',
    `\\b${PARIENTE}\\s+del?`,
    '\\bes para',
    '\\binscribir a',
    '\\binscripcion de',
    // «El nombre de mi hijo: Felipe…»: tras la marca puede venir «:» o «=» (antes los dos puntos la rompían).
].join('|') + ')(?:\\s*[:=]\\s*|\\s+)', 'g');

/** Lo que va antes del nombre en un pie o en la nota del pago: «Pago vacacional Gabriela Reina». */
const RUIDO = /^(?:pagos?|abonos?|saldo|cupos?|inscripcion|clinica|torneo|campamento|vacacional|comprobantes?|soportes?|transferencia|consignacion|envio|adjunto|aqui|va|mira|de|del|la|el|para)$/;

/** Después del nombre, en el mismo tramo, solo vale un dato de registro («… 13 años», «… posición armador»). */
const EMPIEZA_CON_DATO = new RegExp(`^(?:\\d|de \\d|posicion|edad|tiene|nacio|nacid|nacimiento|fecha|ano|categoria|juega|${POSICIONES})`);

type Tipo = 'marca' | 'suelto' | 'escribe';
interface Candidato { nombre: string; tipo: Tipo; entero: boolean; /** Vino en una lista con comas: «Juan Pérez, María López». */ lista?: boolean }

const clave = (n: string) => normalizarFrase(n);
/** El mismo nombre, o uno contenido en el otro («Gabriela Covaleda» y «Gabriela Covaleda García»). */
function mismoNombre(a: string, b: string): boolean {
    const A = clave(a).split(' ');
    const B = clave(b).split(' ');
    const [corto, largo] = A.length <= B.length ? [A, B] : [B, A];
    return corto.every((w) => largo.includes(w));
}
function distintos(lista: Candidato[]): Candidato[] {
    const r: Candidato[] = [];
    for (const c of lista) {
        const i = r.findIndex((x) => mismoNombre(x.nombre, c.nombre));
        if (i < 0) r.push(c);
        else if (clave(c.nombre).length > clave(r[i].nombre).length) r[i] = c;
    }
    return r;
}

/** Lo que queda del tramo después del nombre, normalizado. null si no se ubica. */
function restoTrasNombre(tramo: string, nombre: string): string | null {
    const t = normalizarFrase(tramo);
    const n = normalizarFrase(nombre);
    const i = t.indexOf(n);
    return i < 0 ? null : t.slice(i + n.length).trim();
}

function leerNombres(texto: string): { candidatos: Candidato[]; acudiente: string | null; unSoloTramo: boolean } {
    const candidatos: Candidato[] = [];
    let acudiente: string | null = null;
    const lista = tramos(texto);

    lista.forEach((original, indice) => {
        let tramo = original;
        let p = plano(tramo);
        const cortar = (hasta: number) => { tramo = tramo.slice(0, hasta); p = p.slice(0, hasta); };

        // a. El acudiente dicho con su marca: sale del tramo para que no se lea como quien asiste.
        for (const re of [ACUDIENTE_A, ACUDIENTE_B]) {
            const m = re.exec(p);
            if (!m) continue;
            const n = nombreEn(tramo.slice(m.index + m[0].length - m[1].length));
            if (!n) continue;
            acudiente = acudiente ?? n;
            cortar(m.index);
            break;
        }
        // b. «soy su mamá, Brady Luz»
        const sp = SOY_PARIENTE.exec(p);
        if (sp) {
            const desde = sp.index + sp[0].length - sp[1].length;
            const n = nombreEn(tramo.slice(desde), { entero: true });
            if (n) { acudiente = acudiente ?? n; cortar(desde); }
        }
        if (!tramo.trim()) return;

        // c. «Soy Brady Luz…»: quien escribe. Asiste solo si no hay nadie más en el mensaje.
        const soy = SOY.exec(p);
        if (soy) {
            const desde = soy.index + soy[0].length - soy[1].length;
            const hasta = soy[1].search(CORTE_DE_SOY);
            const n = nombreEn(tramo.slice(desde, hasta < 0 ? undefined : desde + hasta));
            if (n) candidatos.push({ nombre: n, tipo: 'escribe', entero: false });
        }
        // d. Tras una marca: «la niña …», «a nombre de …», «la mamá de …».
        MARCA.lastIndex = 0;
        let conMarca = false;
        for (let m = MARCA.exec(p); m; m = MARCA.exec(p)) {
            const n = nombreEn(tramo.slice(m.index + m[0].length));
            if (!n) continue;
            candidatos.push({ nombre: n, tipo: 'marca', entero: false });
            conMarca = true;
            break;
        }
        if (soy || conMarca) return;

        // e. Sin marca. «Juan Pérez, María López»: dos personas, no un nombre de cuatro palabras.
        const porComa = tramo.split(',').map((x) => nombreEn(x, { entero: true })).filter((x): x is string => !!x);
        if (porComa.length >= 2) {
            for (const n of porComa) candidatos.push({ nombre: n, tipo: 'suelto', entero: true, lista: true });
            return;
        }
        // «Listo, Sara Torres Díaz» · «Buenas tardes, Sara Torres Díaz»
        const n = nombreEn(tramo) ?? (porComa.length === 1 && tramo.split(',').length === 2 ? porComa[0] : null);
        if (n) {
            const resto = restoTrasNombre(tramo, n);
            // El primer tramo es «el comienzo del texto» (lo que ya leía `nombreDeAsistente`);
            // en los demás, el tramo tiene que ser el nombre, solo o seguido de un dato.
            if (indice === 0 || resto === '' || (resto !== null && EMPIEZA_CON_DATO.test(resto))) {
                candidatos.push({ nombre: n, tipo: 'suelto', entero: resto === '' });
            }
            return;
        }
        const palabras = tramo.split(/\s+/);
        let k = 0;
        while (k < palabras.length && RUIDO.test(normalizarFrase(palabras[k]))) k++;
        if (k > 0) {
            const limpio = nombreEn(palabras.slice(k).join(' '), { entero: true });
            if (limpio) candidatos.push({ nombre: limpio, tipo: 'suelto', entero: true });
        }
    });
    return { candidatos, acudiente, unSoloTramo: lista.length === 1 };
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Los nombres de VARIAS personas en un mismo mensaje («Jugador 1: VALENTINA R… TI … / Jugador 2: MARIA ALEJANDRA M…
 * TI …», «mi hija Sara Torres» y «mi hijo Juan Torres» en dos líneas). [] si hay uno solo o ninguno. Con dos o más,
 * `leerDatosDeRegistro` devuelve `nombre: null` (no se elige a nadie en silencio): quien llama pregunta para cuál
 * es el pago. Cuentan los nombres con marca; sin marca, solo si cada tramo es ENTERO un nombre.
 * `sinLineasSueltas`: no cuentan dos nombres sin marca en líneas distintas (en la respuesta a «nombre completo… y
 * persona responsable» eso es quien asiste y su acudiente: `nombreYAcudienteEnLineas`). Pura.
 */
export function nombresDeAsistentesEn(texto: string | null | undefined, o: { sinLineasSueltas?: boolean } = {}): string[] {
    const v = variosNombres(texto);
    return v && !(o.sinLineasSueltas && v.forma === 'lineas') ? v.nombres : [];
}

/**
 * Dos nombres sin marca, cada uno en su línea («Sara Torres Díaz\nBrady Luz Pérez»), como respuesta al pedido de
 * datos: quien asiste y la persona responsable, en el orden en que se pidieron. null si no es ese caso. Pura.
 */
export function nombreYAcudienteEnLineas(texto: string | null | undefined): { nombre: string; acudiente: string } | null {
    const v = variosNombres(texto);
    return v && v.forma === 'lineas' && v.nombres.length === 2 ? { nombre: v.nombres[0], acudiente: v.nombres[1] } : null;
}

function variosNombres(texto: string | null | undefined): { nombres: string[]; forma: 'marca' | 'lista' | 'lineas' } | null {
    const limpio = limpiar(texto);
    if (!limpio.trim()) return null;
    const leido = leerNombres(limpio);
    const noEsAcudiente = (c: Candidato) => !(leido.acudiente && mismoNombre(c.nombre, leido.acudiente));
    const marcados = distintos(leido.candidatos.filter((c) => c.tipo === 'marca' && noEsAcudiente(c)));
    if (marcados.length >= 2) return { nombres: marcados.map((c) => c.nombre), forma: 'marca' };
    if (marcados.length) return null;
    const sueltos = leido.candidatos.filter((c) => c.tipo === 'suelto' && noEsAcudiente(c));
    const unicos = distintos(sueltos);
    if (unicos.length < 2 || !sueltos.every((c) => c.entero)) return null;
    return { nombres: unicos.map((c) => c.nombre), forma: sueltos.some((c) => c.lista) ? 'lista' : 'lineas' };
}

/** Lee los datos de UN texto (mensaje del chat, pie de foto o nota del comprobante leída por OCR). Pura. */
export function leerDatosDeRegistro(
    texto: string | null | undefined, o: { hoy: string; fuente: 'chat' | 'nota' },
): DatosDeRegistro {
    const limpio = limpiar(texto);
    const hoy = partirFecha(o.hoy);
    if (!limpio.trim() || !hoy) return { ...VACIO };
    const p = plano(limpio);

    const fechaNacimiento = fechaDeNacimientoEn(p, hoy);
    let edad = fechaNacimiento ? edadEn(fechaNacimiento, o.hoy) : edadDichaEn(p);
    if (edad === null && !fechaNacimiento) {
        const ano = anoDeNacimientoEn(p, hoy.y);
        if (ano) edad = hoy.y - ano;
    }
    const posicion = posicionEn(p);

    const leido = leerNombres(limpio);
    let acudiente = leido.acudiente;
    const esAcudiente = (c: Candidato) => !!acudiente && mismoNombre(c.nombre, acudiente);
    const marcados = distintos(leido.candidatos.filter((c) => c.tipo === 'marca' && !esAcudiente(c)));
    const sueltos = distintos(leido.candidatos.filter((c) => c.tipo === 'suelto' && !esAcudiente(c)));
    const escriben = distintos(leido.candidatos.filter((c) => c.tipo === 'escribe'));

    let elegido: Candidato | null = null;
    if (marcados.length === 1) elegido = marcados[0];
    else if (marcados.length === 0 && sueltos.length === 1) elegido = sueltos[0];
    const hayOtros = marcados.length + sueltos.length > 0;
    if (hayOtros) {
        // Quien escribe («Soy Brady Luz…») es el candidato a acudiente.
        const quien = escriben.filter((c) => !elegido || !mismoNombre(c.nombre, elegido.nombre));
        if (!acudiente && quien.length === 1) acudiente = quien[0].nombre;
    } else if (escriben.length === 1 && !esAcudiente(escriben[0])) {
        elegido = escriben[0];
    }

    // En la nota del comprobante un nombre suelto puede ser el titular de la cuenta:
    // vale con marca, acompañado de otro dato de registro, o si la nota entera es el nombre.
    if (elegido && o.fuente === 'nota' && elegido.tipo !== 'marca') {
        const conOtroDato = !!fechaNacimiento || edad !== null || !!posicion || !!acudiente;
        const laNotaEsElNombre = leido.unSoloTramo && elegido.entero;
        if (!conOtroDato && !laNotaEsElNombre) elegido = null;
    }

    return {
        nombre: elegido?.nombre ?? null,
        fechaNacimiento,
        edad,
        soloEdad: !fechaNacimiento && edad !== null,
        acudiente,
        posicion,
    };
}

/**
 * Une varias lecturas en orden de prioridad (la primera que traiga cada dato gana).
 * La edad sale de la lectura que trae la fecha (es la calculada); si ninguna trae
 * fecha, la primera edad dicha, con `soloEdad`. Pura.
 */
export function unirDatosDeRegistro(...partes: (Partial<DatosDeRegistro> | null | undefined)[]): DatosDeRegistro {
    const r: DatosDeRegistro = { ...VACIO };
    let edadDeLaFecha: number | null | undefined;
    for (const parte of partes) {
        if (!parte) continue;
        r.nombre = r.nombre ?? (parte.nombre || null);
        r.acudiente = r.acudiente ?? (parte.acudiente || null);
        r.posicion = r.posicion ?? (parte.posicion || null);
        if (!r.fechaNacimiento && parte.fechaNacimiento) {
            r.fechaNacimiento = parte.fechaNacimiento;
            edadDeLaFecha = parte.edad ?? null;
        }
        if (r.edad === null && typeof parte.edad === 'number') r.edad = parte.edad;
    }
    if (r.fechaNacimiento && typeof edadDeLaFecha === 'number') r.edad = edadDeLaFecha;
    r.soloEdad = !r.fechaNacimiento && r.edad !== null;
    return r;
}

/**
 * Qué falta para que la inscripción esté completa. La fecha falta aunque haya edad.
 * El acudiente se exige si es menor de 18 (por la fecha, calculada contra `hoy`, o
 * por la edad dicha); si no se sabe la edad, todavía no (se sabrá con la fecha). Pura.
 */
export function datosFaltantes(d: DatosDeRegistro, o: { hoy: string }): DatoFaltante[] {
    const faltan: DatoFaltante[] = [];
    if (!d.nombre) faltan.push('nombre');
    if (!d.fechaNacimiento) faltan.push('fecha_nacimiento');
    const edad = (d.fechaNacimiento ? edadEn(d.fechaNacimiento, o.hoy) : null) ?? d.edad;
    if (edad !== null && edad < MAYORIA_DE_EDAD && !d.acudiente) faltan.push('acudiente');
    return faltan;
}

const enLista = (nombres: string[]) => nombres.map((n) => `*${n}*`).join(', ').replace(/, ([^,]*)$/, ' y $1');

/**
 * Llegaron DOS o más nombres en un mensaje y el cobro es por persona: no se elige a nadie en silencio, se pregunta.
 * `pagado`: ya hay un comprobante en la venta. No dice que anotó nada. Pura.
 */
export function textoVariosAsistentes(nombres: string[], o: { pagado: boolean }): string {
    const n = nombres.length;
    const inicio = `Recibí ${n === 2 ? 'dos' : n} nombres: ${enLista(nombres)} 🙌 El cupo se paga por persona.`;
    return o.pagado
        ? `${inicio} ¿Tu comprobante es de una sola persona (dime de quién) o de los ${n === 2 ? 'dos' : n} cupos?`
        : `${inicio} ¿Vas a separar ${n === 2 ? 'dos' : n} cupos, o uno solo (dime para quién)?`;
}

/** «Listo 🙌 Le paso a la escuela que son dos cupos: *A* y *B*…» (el cobro por persona lo arma la escuela). Pura. */
export function textoVariosCuposALaEscuela(nombres: string[]): string {
    const n = nombres.length;
    return `Listo 🙌 Le paso a la escuela que son ${n === 2 ? 'dos' : n} cupos: ${enLista(nombres)}. Te confirma por aquí.`;
}

const RELLENO_DE_ELECCION = new Set(('para por solo solamente unicamente nada mas que este esta ese esa pago comprobante cupo ' +
    'del las los una uno con ella ella nombre llama nina nino hija hijo jugador jugadora').split(' '));

/**
 * La respuesta a «¿de una sola persona (dime de quién) o de los dos cupos?»: el nombre elegido (el nombre completo de
 * la lista, aunque escriba solo «Valentina» o «la segunda»), 'todos' («son dos cupos», «para las dos», «ambas») o
 * null si no se entiende. Nunca elige con un nombre que le sirve a dos de la lista. Pura.
 */
export function elegirEntreNombres(texto: string | null | undefined, nombres: string[]): string | 'todos' | null {
    const t = normalizarFrase(texto);
    if (!t || nombres.length < 2) return null;
    if (/\b(ambos|ambas|los dos|las dos|los tres|las tres|todos|todas|cada un[oa]|(?:son|de|los|las|para) (?:dos|tres|cuatro|\d) (?:cupos|personas|ninas|ninos)|(?:dos|tres|cuatro|\d) cupos)\b/.test(t)) return 'todos';
    const orden = /\b(?:(?:la|el) primer[oa]?|jugador[a]? 1|(?:la|el) 1)\b/.test(t) ? 0
        : /\b(?:(?:la|el) segund[oa]|jugador[a]? 2|(?:la|el) 2)\b/.test(t) ? 1
            : /\b(?:(?:la|el) tercer[oa]?|jugador[a]? 3|(?:la|el) 3)\b/.test(t) ? 2 : -1;
    if (orden >= 0) return nombres[orden] ?? null;
    const palabras = t.split(' ').filter((w) => w.length >= 3 && !RELLENO_DE_ELECCION.has(w));
    if (!palabras.length || palabras.length > 6) return null;
    const sirven = nombres.filter((n) => {
        const del = normalizarFrase(n).split(' ');
        return palabras.every((w) => del.includes(w));
    });
    return sirven.length === 1 ? sirven[0] : null;
}

const PEDIDO: Record<DatoFaltante, string> = {
    nombre: 'Nombre completo',
    fecha_nacimiento: 'Fecha de nacimiento (día/mes/año)',
    acudiente: 'Nombre de la persona responsable (mamá, papá o acudiente)',
};
const PEDIDO_EN_FRASE: Record<DatoFaltante, string> = {
    nombre: 'el nombre completo de quien asiste',
    fecha_nacimiento: 'la fecha de nacimiento (día/mes/año)',
    acudiente: 'el nombre de la persona responsable (mamá, papá o acudiente), porque es menor de edad',
};
const ORDEN: DatoFaltante[] = ['nombre', 'fecha_nacimiento', 'acudiente'];

/**
 * El mensaje que pide SOLO lo que falta, numerado y en una sola burbuja. Con
 * `anotado`, confirma en la misma burbuja el nombre que sí se entendió. Sin nada
 * que pedir devuelve ''. No promete cupo. Pura.
 */
export function textoPidiendoDatos(
    faltan: DatoFaltante[],
    o: { servicio: string; conComprobante: boolean; anotado?: DatosDeRegistro | null },
): string {
    const lista = ORDEN.filter((f) => faltan.includes(f));
    if (!lista.length) return '';
    const servicio = o.servicio.trim().replace(/\s+/g, ' ').slice(0, 80);
    const anotado = o.anotado ?? null;
    // Todavía no se sabe si es menor: se avisa que, si lo es, también va el responsable.
    const avisoDeMenor = lista.includes('fecha_nacimiento') && !lista.includes('acudiente')
        && !anotado?.acudiente && (anotado?.edad ?? null) === null
        ? '\nSi es menor de edad, también el nombre de la persona responsable.' : '';
    const numerada = lista.map((f, i) => `${i + 1}. ${PEDIDO[f]}`).join('\n');

    if (anotado?.nombre && !lista.includes('nombre')) {
        const inicio = `Anoté a *${anotado.nombre}*${o.conComprobante ? ' y recibí tu comprobante' : ''} 🙌 `;
        const cierre = ` para completar la inscripción a *${servicio}*`;
        return lista.length === 1
            ? `${inicio}Solo me falta ${PEDIDO_EN_FRASE[lista[0]]}${cierre}.${avisoDeMenor}`
            : `${inicio}Solo me falta${cierre}:\n${numerada}\nPuedes escribirlos en un solo mensaje.`;
    }
    const inicio = o.conComprobante ? 'Recibí tu comprobante 📄 ' : '';
    if (lista.length === 1) {
        return `${inicio}Para completar la inscripción a *${servicio}* solo me falta ${PEDIDO_EN_FRASE[lista[0]]}.${avisoDeMenor}`;
    }
    return `${inicio}Para completar la inscripción a *${servicio}* necesito estos datos de quien asiste:\n` +
        `${numerada}${avisoDeMenor}\nPuedes escribirlos en un solo mensaje.`;
}

const FALTA: Record<DatoFaltante, string> = {
    nombre: 'nombre completo', fecha_nacimiento: 'fecha de nacimiento', acudiente: 'acudiente',
};

/** «22/06/2007» a partir de '2007-06-22'. */
function fechaCorta(iso: string): string {
    const f = partirFecha(iso);
    return f ? `${dos(f.d)}/${dos(f.m)}/${f.y}` : iso;
}

/** La línea para la escuela: «Gabriela Covaleda García · 13 años (sin fecha) · acudiente: Brady Luz · falta: fecha de nacimiento». Pura. */
export function resumenParaLaEscuela(d: DatosDeRegistro, faltan: DatoFaltante[]): string {
    const partes: string[] = [d.nombre ?? 'Sin nombre'];
    const anos = d.edad === null ? null : `${d.edad} ${d.edad === 1 ? 'año' : 'años'}`;
    if (d.fechaNacimiento) partes.push(anos ? `${anos} (${fechaCorta(d.fechaNacimiento)})` : `nació el ${fechaCorta(d.fechaNacimiento)}`);
    else if (anos) partes.push(`${anos} (sin fecha)`);
    if (d.posicion) partes.push(`posición: ${d.posicion}`);
    if (d.acudiente) partes.push(`acudiente: ${d.acudiente}`);
    const lista = ORDEN.filter((f) => faltan.includes(f));
    if (lista.length) partes.push(`falta: ${lista.map((f) => FALTA[f]).join(', ')}`);
    return partes.join(' · ');
}
