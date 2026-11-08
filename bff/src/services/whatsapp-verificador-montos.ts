/**
 * whatsapp-verificador-montos — ningún monto ni fecha de precio sale hacia un
 * interesado si no está en los datos que la escuela configuró (plan
 * docs/specs/whatsapp-ventas-de-servicio-blindaje.md, frente B, regla 4).
 *
 * Por qué existe (Monster, clínica de armadores, 2026-11-08): el texto libre que
 * la escuela le escribió al asistente decía «Preventa: $300.000 hasta el 9 de
 * noviembre»; el catálogo y el anuncio decían «hasta el 10». La IA le repitió
 * «hasta el 9» a 12 personas. Un verificador a la salida habría frenado esas 12
 * respuestas: la fecha de precio no cuadraba con el catálogo.
 *
 * Qué revisa un texto que escribió el modelo:
 *   · MONTOS: «$300.000», «$ 300.000», «300.000», «300 mil», «300k», «150000»,
 *     «1,5 millones». Cada uno tiene que estar en el conjunto permitido.
 *   · FECHAS DE PRECIO: «hasta el (martes) 10 de noviembre», «desde el 11»,
 *     «a partir del 11», «después del 10», «antes del 11», en una frase que habla
 *     de dinero (un monto, «precio», «valor», «preventa»…). Cada una se traduce al
 *     día en que EMPIEZA el precio nuevo (el «corte»: «hasta el 10» y «desde el
 *     11» son el mismo corte, el 11) y ese corte tiene que estar permitido.
 *
 * Qué NO cuenta (falsos positivos que ya se ven en los textos reales):
 *   · horas («9:00 a. m.», «de 8 a 11»), años («2026», «2015-2016»), edades
 *     («desde 14 años»), porcentajes («50 %»), semanas («hasta 4 semanas»);
 *   · teléfonos y cuentas («3194505150», «319 450 5150», «318 868 2241»);
 *   · los días del evento («21 y 22 de noviembre», «del 17 de noviembre al 10 de
 *     diciembre», «la clínica va hasta el 22 de noviembre»): no son fechas de precio;
 *   · lo que va dentro de un enlace.
 *
 * Puro: sin base ni red. Lo usan whatsapp-servicio-ia (respuestas sobre un
 * servicio), whatsapp-prospecto-ia (respuestas y seguimiento de 20 h al
 * interesado) y whatsapp-coherencia-ficha (la ficha libre contra el catálogo).
 */

import {
    abonoMinimo, hoyBogota, opcionesDelItem, tramosPorFecha, type ItemDeServicio,
} from './wa-cobro-desde-comprobante.service';

// ─── Normalización ──────────────────────────────────────────────────────────

/** Minúsculas y sin tildes, conservando dígitos, signos y espacios. Pura. */
export function normalizarParaMontos(t: string | null | undefined): string {
    return String(t ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

const URL = /(https?:\/\/\S+|www\.\S+)/gi;

/** Frases (cláusulas) de un texto: punto final, salto de línea, «;», viñetas. Pura. */
export function clausulas(texto: string | null | undefined): string[] {
    return String(texto ?? '')
        .split(/\r?\n|;|•|·|(?<=[.!?…])\s+/)
        .map((x) => x.trim())
        .filter(Boolean);
}

// ─── Montos ─────────────────────────────────────────────────────────────────

export interface MontoEnTexto {
    valor: number;
    /** Cómo aparece (normalizado). */
    texto: string;
}

/** Grupos de cifras separados por espacio o guion (sin puntos de miles): candidato a teléfono. */
const TELEFONO_EN_GRUPOS = /(?<![\d$.,])\+?\d{1,7}(?:[ \t-]\d{1,7}){1,5}(?![\d.,])/g;

const SUFIJO: Record<string, number> ={ mil: 1_000, k: 1_000, millon: 1_000_000, millones: 1_000_000 };

/** «300.000» / «300,000» → 300000; «1,5» → 1.5. Pura. */
function numeroDe(s: string): number {
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
    return Number(s.replace(',', '.'));
}

/**
 * Los patrones en orden de prioridad: el primero que toma un pedazo del texto lo
 * consume (así «$300 mil» no cuenta dos veces).
 */
const PATRONES_MONTO: { re: RegExp; valor: (m: RegExpMatchArray) => number | null; sinSigno?: true }[] = [
    // «$300.000», «$ 300.000», «$300000», «$300 mil», «cop 300.000», «$1,5 millones»
    {
        re: /(?:\$|\bcop\b\.?)\s?(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d{1,2})?)(?:\s?(millones|millon|mil|k)\b)?/g,
        valor: (m) => numeroDe(m[1]) * (m[2] ? SUFIJO[m[2]] : 1),
    },
    // «un millón», «1,5 millones», «medio millón»
    {
        re: /\b(un|medio|\d+(?:[.,]\d{1,2})?)\s?(millones|millon)\b/g,
        valor: (m) => (m[1] === 'un' ? 1 : m[1] === 'medio' ? 0.5 : numeroDe(m[1])) * 1_000_000,
    },
    // «300 mil», «300mil», «300k»
    {
        re: /(?<![\d.,])(\d{1,3}(?:[.,]\d{1,3})?)\s?(mil|k)\b/g,
        valor: (m) => numeroDe(m[1]) * 1_000,
    },
    // «300.000» sin signo (miles con punto o coma, grupos de 3)
    {
        re: /(?<![\d.,:/#+-])(\d{1,3}(?:[.,]\d{3})+)(?![\d]|[.,]\d|\s?%)/g,
        valor: (m) => numeroDe(m[1]),
        sinSigno: true,
    },
    // «150000» suelto: 5 a 7 cifras (4 son años; 10 son teléfonos)
    {
        re: /(?<![\d.,:/#+-])(\d{5,7})(?![\d]|[.,]\d|:|\/|-|\s?%)/g,
        valor: (m) => Number(m[1]),
        sinSigno: true,
    },
];

/**
 * Los montos de dinero de un texto. `ignorarNumeros`: cuentas y teléfonos (solo
 * dígitos) que pueden aparecer sueltos y no son plata. Pura.
 */
export function extraerMontos(texto: string | null | undefined, o: { ignorarNumeros?: readonly string[] } = {}): MontoEnTexto[] {
    const t = normalizarParaMontos(texto)
        .replace(URL, (u) => ' '.repeat(u.length))
        // Teléfonos partidos en grupos («319 4505150», «+57 319 450 5150»): 10 a 13 cifras no son plata.
        .replace(TELEFONO_EN_GRUPOS, (g) => {
            const n = g.replace(/\D/g, '').length;
            return n >= 10 && n <= 13 ? ' '.repeat(g.length) : g;
        });
    const ignorados = (o.ignorarNumeros ?? []).map((n) => String(n).replace(/\D/g, '')).filter((n) => n.length >= 5);
    const tomados: [number, number][] = [];
    const encontrados: { valor: number; texto: string; inicio: number }[] = [];
    for (const { re, valor, sinSigno } of PATRONES_MONTO) {
        re.lastIndex = 0;
        for (const m of t.matchAll(re)) {
            const ini = m.index ?? 0;
            const fin = ini + m[0].length;
            if (tomados.some(([a, b]) => ini < b && fin > a)) continue;
            const digitos = m[0].replace(/\D/g, '');
            // Un número suelto que es parte de una cuenta o un teléfono de la escuela no es plata.
            if (sinSigno && ignorados.some((n) => n.includes(digitos))) { tomados.push([ini, fin]); continue; }
            const v = valor(m);
            tomados.push([ini, fin]);
            if (v === null || !Number.isFinite(v) || v <= 0) continue;
            encontrados.push({ valor: Math.round(v), texto: m[0].trim(), inicio: ini });
        }
    }
    return encontrados.sort((a, b) => a.inicio - b.inicio).map(({ valor, texto: tx }) => ({ valor, texto: tx }));
}

// ─── Fechas de precio ───────────────────────────────────────────────────────

export type TipoLimite = 'hasta' | 'desde' | 'despues' | 'antes';

export interface FechaDePrecio {
    tipo: TipoLimite;
    dia: number;
    mes: number;
    /** El mes no estaba escrito: se dedujo de la fecha anterior del texto (o de hoy). */
    mesDeducido: boolean;
    /** 'MM-DD' de la fecha escrita. */
    declarada: string;
    /** 'MM-DD' del día en que EMPIEZA el precio nuevo («hasta el 10» → '11-11'). */
    corte: string;
    /** La frase donde aparece, tal cual (para mostrársela a la escuela). */
    frase: string;
    /** El pedazo exacto («hasta el martes 10 de noviembre»), normalizado. */
    texto: string;
}

const MES_NUM: Record<string, number> = {
    enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6,
    julio: 7, jul: 7, agosto: 8, ago: 8, septiembre: 9, setiembre: 9, sept: 9, sep: 9, set: 9, octubre: 10, oct: 10,
    noviembre: 11, nov: 11, diciembre: 12, dic: 12,
};
const MESES_RE = Object.keys(MES_NUM).sort((a, b) => b.length - a.length).join('|');
const DIA_SEMANA_RE = 'lunes|martes|miercoles|jueves|viernes|sabado|domingo';

/** Lo que va después del número y lo descarta como fecha («14 años», «4 semanas», «9:00», «50 %»). */
const NO_ES_FECHA = '\\s*(?::|\\d|%|[.,]\\d|(?:anos?|meses?|semanas?|dias?|horas?|h|am|pm|a\\.?\\s?m|p\\.?\\s?m|personas?|cupos?|cuotas?|pagos?|veces|clases?|sesiones?|entrenos?|jornadas?|categorias?|grupos?|ninos?|ninas?|jugador(?:es|as)?|deportistas?|mil|k|millon(?:es)?)\\b)';

const RE_LIMITE = new RegExp(
    `\\b(hasta|desde|a partir|despues|luego|antes)\\s+` +
    `(?:(de el|del|de|el|al)\\s+)?` +
    `(?:(este|el|proximo)\\s+)?` +
    `(?:(${DIA_SEMANA_RE})\\s+)?` +
    `(\\d{1,2})(?!${NO_ES_FECHA})` +
    `(?:\\s*(?:de\\s+)?(${MESES_RE})\\b)?`,
    'g',
);

/** ¿La frase habla de dinero? (si no, «hasta el 22 de noviembre» es una fecha cualquiera). */
const CONTEXTO_DE_PRECIO = /\$|\d\s?(mil|k)\b|\b(precios?|valor(es)?|preventa|tarifas?|cuesta|cuestan|vale|valen|inversion|descuentos?|neto|pagas|pagar|pago|abono|costo|costos|promo|promocion|valida|vigente|vence|vencimiento)\b/;

/** «desde el 21 al 22» / «desde el 17 de noviembre hasta el 10 de diciembre»: un rango de días, no un cambio de precio. */
const CONECTOR_DE_RANGO = new RegExp(`^\\s*,?\\s*(?:al|hasta(?:\\s+el)?|a)\\s+(?:el\\s+)?(?:(?:${DIA_SEMANA_RE})\\s+)?\\d{1,2}\\b`);

const MES_SUELTO = new RegExp(`\\b(${MESES_RE})\\b`, 'g');

const dosDigitos = (n: number) => String(n).padStart(2, '0');

/** 'MM-DD' de (año, mes, día + suma) en calendario real. Pura. */
function mmdd(anio: number, mes: number, dia: number, suma = 0): string {
    const f = new Date(Date.UTC(anio, mes - 1, dia + suma));
    return `${dosDigitos(f.getUTCMonth() + 1)}-${dosDigitos(f.getUTCDate())}`;
}

const TIPO: Record<string, TipoLimite> = { hasta: 'hasta', desde: 'desde', 'a partir': 'desde', despues: 'despues', luego: 'despues', antes: 'antes' };

/**
 * Las fechas de precio de un texto. `hoy` ('YYYY-MM-DD', Bogotá) sirve para el
 * año y para deducir el mes cuando no está escrito y no hay fecha anterior
 * («desde el 11» → el mes de la última fecha del texto; si no hay, el de hoy, o
 * el siguiente si ese día ya pasó). `mesInicial`: el mes que venía de antes
 * (líneas anteriores de la ficha). Pura.
 */
export function extraerFechasDePrecio(
    texto: string | null | undefined,
    o: { hoy?: string; mesInicial?: number | null } = {},
): FechaDePrecio[] {
    const hoy = o.hoy ?? hoyBogota();
    const [anio, mesHoy, diaHoy] = hoy.split('-').map(Number);
    let ultimoMes: number | null = o.mesInicial ?? null;
    const out: FechaDePrecio[] = [];
    const frases = clausulas(String(texto ?? '').replace(URL, ' '));
    // Una frase habla de dinero si ella o la anterior lo hacen («Preventa: $300.000. Válida hasta el 9 de noviembre»).
    const conDinero = frases.map((f) => CONTEXTO_DE_PRECIO.test(normalizarParaMontos(f)));
    for (const [k, frase] of frases.entries()) {
        const n = normalizarParaMontos(frase);
        const deDinero = conDinero[k] || (k > 0 && conDinero[k - 1]);
        // Las menciones de mes de la frase, en orden, para deducir el de una fecha sin mes.
        const meses = [...n.matchAll(MES_SUELTO)].map((m) => ({ i: m.index ?? 0, mes: MES_NUM[m[1]] }));
        const candidatos = [...n.matchAll(RE_LIMITE)].map((m) => ({ m, ini: m.index ?? 0, fin: (m.index ?? 0) + m[0].length }));
        const saltar = new Set<number>();
        candidatos.forEach((c, i) => {
            const tipo = TIPO[c.m[1]];
            if (tipo === 'desde' && CONECTOR_DE_RANGO.test(n.slice(c.fin))) {
                saltar.add(i);
                const sig = candidatos[i + 1];
                if (sig && sig.ini - c.fin <= 8) saltar.add(i + 1);
            }
        });
        // «del 17 de noviembre al 10 de diciembre» sin palabra de límite: no entra a RE_LIMITE.
        let cursorMes = 0;
        candidatos.forEach((c, i) => {
            while (cursorMes < meses.length && meses[cursorMes].i < c.ini) ultimoMes = meses[cursorMes++].mes;
            if (saltar.has(i) || !deDinero) return;
            const [, palabra, articulo, , diaSemana, diaTxt, mesTxt] = c.m;
            const dia = Number(diaTxt);
            if (!(dia >= 1 && dia <= 31)) return;
            // «hasta 3»: sin artículo, sin día de la semana y sin mes no es una fecha.
            if (!mesTxt && !articulo && !diaSemana) return;
            let mes = mesTxt ? MES_NUM[mesTxt] : null;
            const mesDeducido = mes === null;
            if (mes === null) mes = ultimoMes ?? (dia >= diaHoy ? mesHoy : (mesHoy % 12) + 1);
            if (mesTxt) ultimoMes = mes;
            const tipo = TIPO[palabra];
            // Año: el de hoy; si el mes quedó muy atrás, el siguiente.
            const anioFecha = mes < mesHoy - 6 ? anio + 1 : anio;
            const suma = tipo === 'hasta' || tipo === 'despues' ? 1 : 0;
            out.push({
                tipo, dia, mes, mesDeducido,
                declarada: mmdd(anioFecha, mes, dia),
                corte: mmdd(anioFecha, mes, dia, suma),
                frase,
                texto: c.m[0],
            });
        });
        while (cursorMes < meses.length) ultimoMes = meses[cursorMes++].mes;
    }
    return out;
}

/** El último mes nombrado en un texto (para seguir deduciendo en la línea siguiente). Pura. */
export function ultimoMesDe(texto: string | null | undefined): number | null {
    const todos = [...normalizarParaMontos(texto).matchAll(MES_SUELTO)];
    return todos.length ? MES_NUM[todos[todos.length - 1][1]] : null;
}

// ─── Lo permitido ───────────────────────────────────────────────────────────

export interface Permitidos {
    montos: Set<number>;
    /** 'MM-DD': días en que empieza un precio nuevo según los datos. */
    cortes: Set<string>;
    /** 'MM-DD': día de inicio y de fin de cada servicio (sus fechas no son fechas de precio). */
    diasDeEvento: Set<string>;
    /** Cuentas y teléfonos (solo dígitos): no son montos. */
    numerosIgnorados: string[];
}

export function permitidosVacios(): Permitidos {
    return { montos: new Set(), cortes: new Set(), diasDeEvento: new Set(), numerosIgnorados: [] };
}

export function unirPermitidos(...ps: (Permitidos | null | undefined)[]): Permitidos {
    const out = permitidosVacios();
    for (const p of ps) {
        if (!p) continue;
        p.montos.forEach((m) => out.montos.add(m));
        p.cortes.forEach((c) => out.cortes.add(c));
        p.diasDeEvento.forEach((d) => out.diasDeEvento.add(d));
        out.numerosIgnorados.push(...p.numerosIgnorados);
    }
    return out;
}

const positivo = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/**
 * Los montos que puede decir el asistente de un servicio: el precio, cada tramo
 * por fecha, las opciones, el abono mínimo de cada precio y lo que queda después
 * del abono. `afiliado`: true = el número es de una familia (suma el precio de
 * afiliado); 'todos' = los dos (para auditar textos de la escuela). Pura.
 */
export function montosDelItem(item: ItemDeServicio, o: { afiliado: boolean | 'todos' }): Set<number> {
    const conAfiliado = o.afiliado === true || o.afiliado === 'todos';
    const precios: number[] = [];
    const agregar = (v: unknown) => { const n = positivo(v); if (n !== null) precios.push(n); };
    const opciones = opcionesDelItem(item);
    if (opciones.length) {
        for (const op of opciones) {
            if (o.afiliado !== true || !positivo(op.precio_afiliado)) agregar(op.precio);
            if (conAfiliado) agregar(op.precio_afiliado);
        }
    } else {
        if (o.afiliado !== true || !positivo(item.precio_afiliado)) {
            agregar(item.price);
            for (const t of tramosPorFecha(item.precios_por_fecha)) agregar(t.precio);
        }
        if (conAfiliado) agregar(item.precio_afiliado);
    }
    const out = new Set(precios);
    if (!opciones.length && item.allow_installments === true) {
        for (const p of precios) {
            const abono = abonoMinimo(p, item.abono_minimo_pct);
            if (abono !== null && abono < p) {
                out.add(abono);
                out.add(p - abono);
            }
        }
    }
    return out;
}

/** Los cortes de precio del servicio ('MM-DD' de cada `precios_por_fecha.desde`). Pura. */
export function cortesDelItem(item: Pick<ItemDeServicio, 'precios_por_fecha'>): Set<string> {
    return new Set(tramosPorFecha(item.precios_por_fecha).map((t) => t.desde.slice(5, 10)));
}

/** Día de inicio y de fin del servicio en Bogotá ('MM-DD'). Pura. */
export function diasDelItem(item: Pick<ItemDeServicio, 'starts_at' | 'ends_at'>): Set<string> {
    const out = new Set<string>();
    for (const iso of [item.starts_at, item.ends_at]) {
        const t = iso ? new Date(iso).getTime() : NaN;
        if (Number.isFinite(t)) out.add(hoyBogota(t).slice(5, 10));
    }
    return out;
}

/** Lo permitido por el catálogo (todos los servicios que se le dan al modelo). Pura. */
export function permitidosDelCatalogo(items: ItemDeServicio[], o: { afiliado: boolean | 'todos' }): Permitidos {
    const out = permitidosVacios();
    for (const it of items) {
        montosDelItem(it, o).forEach((m) => out.montos.add(m));
        cortesDelItem(it).forEach((c) => out.cortes.add(c));
        diasDelItem(it).forEach((d) => out.diasDeEvento.add(d));
    }
    return out;
}

/** Los montos que aparecen en un texto de la escuela (planes, clase de prueba, horarios). Pura. */
export function permitidosDeTexto(...textos: (string | null | undefined)[]): Permitidos {
    const out = permitidosVacios();
    for (const t of textos) for (const m of extraerMontos(t)) out.montos.add(m.valor);
    return out;
}

/** Números de cuentas y teléfonos que no deben leerse como montos. Pura. */
export function conNumerosIgnorados(p: Permitidos, numeros: (string | null | undefined)[]): Permitidos {
    return { ...p, numerosIgnorados: [...p.numerosIgnorados, ...numeros.map((n) => String(n ?? '').replace(/\D/g, '')).filter((n) => n.length >= 5)] };
}

// ─── Verificación ───────────────────────────────────────────────────────────

export type Violacion =
    | { tipo: 'monto'; valor: number; texto: string }
    | { tipo: 'fecha_de_precio'; texto: string; frase: string; corte: string };

export type ResultadoVerificacion = { ok: true } | { ok: false; violaciones: Violacion[] };

/**
 * ¿Todo monto y toda fecha de precio del texto están en los datos? Pura.
 * Una fecha cuyo día es el inicio o el fin de un servicio no se toma como fecha
 * de precio («la clínica va hasta el 22 de noviembre y vale $300.000»).
 */
export function verificarSalida(texto: string | null | undefined, permitidos: Permitidos, o: { hoy?: string } = {}): ResultadoVerificacion {
    const violaciones: Violacion[] = [];
    for (const m of extraerMontos(texto, { ignorarNumeros: permitidos.numerosIgnorados })) {
        if (!permitidos.montos.has(m.valor)) violaciones.push({ tipo: 'monto', valor: m.valor, texto: m.texto });
    }
    for (const f of extraerFechasDePrecio(texto, { hoy: o.hoy })) {
        if (permitidos.diasDeEvento.has(f.declarada)) continue;
        if (!permitidos.cortes.has(f.corte)) violaciones.push({ tipo: 'fecha_de_precio', texto: f.texto, frase: f.frase, corte: f.corte });
    }
    return violaciones.length ? { ok: false, violaciones } : { ok: true };
}

/** Las violaciones en una línea, para el log y para la corrección que se le pide al modelo. Pura. */
export function describirViolaciones(v: Violacion[]): string {
    return v.map((x) => (x.tipo === 'monto'
        ? `el monto «${x.texto}» no está en los datos`
        : `la fecha de precio «${x.texto}» no coincide con las fechas de precio de los datos`)).join('; ');
}
