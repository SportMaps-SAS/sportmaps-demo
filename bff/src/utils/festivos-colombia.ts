/**
 * festivos-colombia — calendario de festivos nacionales de Colombia, CALCULADO.
 *
 * POR QUÉ EXISTE
 *
 * La Ley 2300 de 2023 (art. 3, "dejen de fregar") prohíbe cualquier contacto
 * de cobranza los domingos y días festivos. La regla de horario de
 * whatsapp-plantillas ya excluía el domingo, pero no los festivos: no hay
 * calendario en la base. Se calcula en vez de guardarse en una tabla para que
 * no haya que acordarse de cargar el año siguiente (una tabla vacía en enero
 * significa cobrar el 1.º de enero).
 *
 * LAS TRES FAMILIAS
 *
 * 1. Fijos (no se mueven): 1 ene, 1 may, 20 jul, 7 ago, 8 dic, 25 dic.
 * 2. Ley Emiliani (Ley 51 de 1983): si no caen en lunes se trasladan al lunes
 *    SIGUIENTE: 6 ene, 19 mar, 29 jun, 15 ago, 12 oct, 1 nov, 11 nov, y desde
 *    2026 el 9 jul (Virgen de Chiquinquirá, Ley 2578 de 2026, que remite al
 *    mismo régimen de traslado).
 * 3. Dependientes de Pascua: Jueves y Viernes Santo (no se trasladan) y
 *    Ascensión (+39), Corpus Christi (+60) y Sagrado Corazón (+68), que la Ley
 *    51 traslada al lunes siguiente → quedan en Pascua +43, +64 y +71.
 *
 * Dos festivos pueden caer el mismo lunes (2025: San Pedro y Sagrado Corazón
 * el 30 de junio). No se "corre" ninguno: el día es festivo y ya.
 *
 * ZONA HORARIA
 *
 * Un `Date` se interpreta en America/Bogota, que es UTC-5 todo el año (no
 * hay horario de verano). El BFF corre en UTC: sin esta conversión, de 19:00
 * a medianoche hora Colombia se consultaría el día SIGUIENTE. Un string
 * 'YYYY-MM-DD' se toma como fecha calendario tal cual, sin zona.
 *
 * UNA SOLA FUENTE (2026-11-15)
 *
 * La fuente de los festivos es la tabla `co_holidays` de la base, cargada con
 * la función `co_festivos_del_anio(año)` (la misma regla, en SQL). El BFF la
 * lee al arrancar y una vez al día (`services/festivos-fuente.service.ts`) y
 * la deja aquí con `fijarFestivosDeLaBase`. El cálculo de este archivo queda
 * solo como red de seguridad: responde por un año que la tabla no tenga, o si
 * la base no contesta al arrancar. Así nunca se cobra un 1.º de enero por una
 * tabla vacía, y nunca hay dos calendarios distintos.
 *
 * Fuentes verificadas el 2026-10-04: listados 2025/2026/2027 de prensa
 * nacional (El País Cali, Caracol, El Universal) y la Ley 2578 de 2026.
 */

const OFFSET_BOGOTA_MS = 5 * 3600_000; // UTC-5 fijo

/** Domingo de Pascua (calendario gregoriano), algoritmo anónimo de Meeus/Jones/Butcher. */
export function domingoDePascua(anio: number): { mes: number; dia: number } {
    const a = anio % 19;
    const b = Math.floor(anio / 100);
    const c = anio % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mes = Math.floor((h + l - 7 * m + 114) / 31); // 3 = marzo, 4 = abril
    const dia = ((h + l - 7 * m + 114) % 31) + 1;
    return { mes, dia };
}

// Las fechas se manejan como medianoche UTC "de calendario": solo se usan para
// aritmética de días y día de la semana, nunca como instante real.
function fechaUTC(anio: number, mes: number, dia: number): Date {
    return new Date(Date.UTC(anio, mes - 1, dia));
}

function sumarDias(f: Date, dias: number): Date {
    return new Date(f.getTime() + dias * 86_400_000);
}

/** Ley Emiliani: si no es lunes, al lunes siguiente. */
function alLunesSiguiente(f: Date): Date {
    const dow = f.getUTCDay(); // 0 domingo, 1 lunes
    if (dow === 1) return f;
    const faltan = (8 - dow) % 7; // domingo → 1, martes → 6, sábado → 2
    return sumarDias(f, faltan);
}

function aISO(f: Date): string {
    return f.toISOString().slice(0, 10);
}

const cache = new Map<number, Set<string>>();
/** Años leídos de `co_holidays` (la fuente). Lo que esté aquí manda sobre el cálculo. */
const deLaBase = new Map<number, Set<string>>();

/**
 * Deja en memoria los festivos leídos de `co_holidays` ('YYYY-MM-DD'). Un año
 * solo entra si trae al menos 15 fechas (una carga a medias no reemplaza al
 * cálculo). Devuelve los años cargados y las fechas en que la tabla y el
 * cálculo NO coinciden, para dejarlo en el log.
 */
export function fijarFestivosDeLaBase(fechas: string[]): { anios: number[]; diferencias: string[] } {
    const porAnio = new Map<number, Set<string>>();
    for (const f of fechas) {
        const iso = String(f ?? '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
        const anio = Number(iso.slice(0, 4));
        if (!porAnio.has(anio)) porAnio.set(anio, new Set());
        porAnio.get(anio)!.add(iso);
    }
    const anios: number[] = [];
    const diferencias: string[] = [];
    for (const [anio, set] of porAnio) {
        if (set.size < 15) continue;
        const calculado = calcularFestivos(anio);
        for (const d of set) if (!calculado.has(d)) diferencias.push(`${d} (solo en la tabla)`);
        for (const d of calculado) if (!set.has(d)) diferencias.push(`${d} (solo en el cálculo)`);
        deLaBase.set(anio, set);
        anios.push(anio);
    }
    return { anios: anios.sort(), diferencias: diferencias.sort() };
}

/** Solo para pruebas: olvida lo leído de la base. */
export function olvidarFestivosDeLaBase(): void {
    deLaBase.clear();
}

/** Festivos nacionales del año como 'YYYY-MM-DD', ordenados. */
export function festivosColombia(anio: number): string[] {
    return [...festivosDelAnio(anio)].sort();
}

function festivosDelAnio(anio: number): Set<string> {
    return deLaBase.get(anio) ?? calcularFestivos(anio);
}

function calcularFestivos(anio: number): Set<string> {
    const enCache = cache.get(anio);
    if (enCache) return enCache;

    const fechas: Date[] = [];

    // 1. Fijos
    for (const [mes, dia] of [[1, 1], [5, 1], [7, 20], [8, 7], [12, 8], [12, 25]]) {
        fechas.push(fechaUTC(anio, mes, dia));
    }

    // 2. Trasladables (Ley 51 de 1983)
    const emiliani: [number, number][] = [[1, 6], [3, 19], [6, 29], [8, 15], [10, 12], [11, 1], [11, 11]];
    // Virgen de Chiquinquirá: Ley 2578 de 2026 (sancionada el 1 de junio de 2026).
    // Antes de 2026 no era festivo; no se agrega hacia atrás.
    if (anio >= 2026) emiliani.push([7, 9]);
    for (const [mes, dia] of emiliani) {
        fechas.push(alLunesSiguiente(fechaUTC(anio, mes, dia)));
    }

    // 3. Dependientes de Pascua
    const p = domingoDePascua(anio);
    const pascua = fechaUTC(anio, p.mes, p.dia);
    fechas.push(sumarDias(pascua, -3)); // Jueves Santo
    fechas.push(sumarDias(pascua, -2)); // Viernes Santo
    fechas.push(sumarDias(pascua, 43)); // Ascensión (+39, trasladada al lunes)
    fechas.push(sumarDias(pascua, 64)); // Corpus Christi (+60, trasladado)
    fechas.push(sumarDias(pascua, 71)); // Sagrado Corazón (+68, trasladado)

    const set = new Set(fechas.map(aISO));
    cache.set(anio, set);
    return set;
}

/** 'YYYY-MM-DD' de un instante en hora de Bogotá. */
function fechaBogota(instante: Date): string {
    return new Date(instante.getTime() - OFFSET_BOGOTA_MS).toISOString().slice(0, 10);
}

/**
 * ¿La fecha es festivo nacional en Colombia?
 * - `Date`: se toma el día calendario en America/Bogota.
 * - `string`: 'YYYY-MM-DD' (o un ISO que empiece así) se toma literal; si trae
 *   hora con zona ('...T...Z' / '...-05:00') se convierte como instante.
 * Una fecha inválida devuelve false: quien llama decide qué hacer con lo que
 * no es fecha, y aquí no se lanza en medio de un envío.
 */
export function esFestivoColombia(fecha: Date | string): boolean {
    let iso: string;
    if (fecha instanceof Date) {
        if (Number.isNaN(fecha.getTime())) return false;
        iso = fechaBogota(fecha);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(fecha.trim())) {
        iso = fecha.trim();
    } else {
        const d = new Date(fecha);
        if (Number.isNaN(d.getTime())) return false;
        iso = fechaBogota(d);
    }
    const anio = Number(iso.slice(0, 4));
    return festivosDelAnio(anio).has(iso);
}
