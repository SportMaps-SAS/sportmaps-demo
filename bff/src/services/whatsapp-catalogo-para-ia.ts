/**
 * whatsapp-catalogo-para-ia — los servicios vigentes de la escuela (clínica,
 * torneo, vacacional…) escritos para el modelo, con los datos que la escuela
 * configuró y nada más (plan docs/specs/whatsapp-ventas-de-servicio-blindaje.md,
 * frente B).
 *
 * Por qué existe (Monster, 2026-11-08): el modelo solo veía el texto libre de la
 * escuela (`wa_ficha_prospectos`), que decía «preventa hasta el 9 de noviembre»;
 * el catálogo (`school_tournament_items.precios_por_fecha` = [{desde: '2026-11-11',
 * precio: 350000}]) decía «hasta el 10». Sin el catálogo delante, la IA no tenía
 * con qué corregir la ficha. Y a preguntas que SÍ estaban en los datos («¿incluye
 * grupo femenino?», «titular de la cuenta») respondía «eso te lo confirma la
 * escuela» porque no los tenía.
 *
 * Qué lleva cada servicio:
 *   · nombre y cuándo (fechas en hora de Bogotá, con el día de la semana);
 *   · el valor de HOY y los tramos por fecha con fechas inclusivas correctas:
 *     desde = '2026-11-11' → «$300.000 hasta el martes 10 de noviembre; desde el
 *     miércoles 11, $350.000»;
 *   · el precio de afiliado SOLO si el número es de una familia del club (si no,
 *     solo se dice que existe y que la escuela lo confirma);
 *   · el abono mínimo, las opciones (semanas del vacacional), las cuentas con su
 *     titular y cómo se confirma el cupo;
 *   · la descripción completa que escribió la escuela.
 *
 * Puro: quien llama trae el catálogo (`serviciosDeAnuncio`) y las cuentas.
 */

import {
    diaLegible, precioDelServicio, type ItemConFicha,
} from './whatsapp-anuncio-destino';
import { comoPagar, type CuentaDePagoEmbudo } from './whatsapp-embudo-prospecto';
import { hoyBogota, opcionesDelItem, tramosPorFecha, type ItemDeServicio } from './wa-cobro-desde-comprobante.service';
import { cop } from './whatsapp-venta-servicios.service';

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
/** Máximo de servicios en el bloque (una escuela real tiene 1 a 3). */
const MAX_SERVICIOS = 8;
const MAX_DESCRIPCION = 3500;

/** Día de la semana de 'YYYY-MM-DD' (`menos` días antes). Pura. */
function diaDeLaSemana(ymd: string, menos = 0): string {
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
    return DIAS[new Date(Date.UTC(y, m - 1, d - menos)).getUTCDay()];
}

/** 'YYYY-MM-DD' → «martes 10 de noviembre» (`menos` días antes). Pura. */
export function diaConSemana(ymd: string, menos = 0): string {
    return `${diaDeLaSemana(ymd, menos)} ${diaLegible(ymd, menos)}`;
}

/** 'YYYY-MM-DD' → «domingo 8 de noviembre de 2026». Pura. */
export function hoyLegibleDe(ymd: string): string {
    return `${diaConSemana(ymd)} de ${ymd.slice(0, 4)}`;
}

/** Mes (1–12) de 'YYYY-MM-DD' − `menos` días. Pura. */
function mesDe(ymd: string, menos = 0): number {
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - menos)).getUTCMonth() + 1;
}

const positivo = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Los tramos de precio por fecha, con fechas inclusivas: el precio de lista va
 * HASTA el día anterior al primer `desde`, y cada tramo va DESDE su `desde`.
 * «$300.000 hasta el martes 10 de noviembre; desde el miércoles 11, $350.000».
 * null si el servicio no tiene tramos. Pura.
 */
export function textoDeTramos(item: Pick<ItemDeServicio, 'price' | 'precios_por_fecha'>): string | null {
    const tramos = tramosPorFecha(item.precios_por_fecha);
    if (!tramos.length) return null;
    const partes: string[] = [];
    const base = positivo(item.price);
    let mesAnterior: number | null = null;
    if (base !== null) {
        partes.push(`${cop(base)} hasta el ${diaConSemana(tramos[0].desde, 1)}`);
        mesAnterior = mesDe(tramos[0].desde, 1);
    }
    for (const t of tramos) {
        const mes = mesDe(t.desde);
        // Mismo mes que la fecha anterior: «desde el miércoles 11» (sin repetir «de noviembre»).
        const dia = mes === mesAnterior
            ? `${diaDeLaSemana(t.desde)} ${Number(t.desde.slice(8, 10))}`
            : diaConSemana(t.desde);
        partes.push(`desde el ${dia}, ${cop(t.precio)}`);
        mesAnterior = mes;
    }
    return partes.join('; ');
}

/** Fecha y hora de Bogotá de un ISO; la hora null si es medianoche o 11:59 p. m. (día completo). Pura. */
function partesBogota(iso: string): { ymd: string; hora: string | null } | null {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return null;
    const ymd = hoyBogota(t);
    const local = new Date(t - 5 * 3600_000);
    const hh = local.getUTCHours();
    const mm = local.getUTCMinutes();
    const diaCompleto = (hh === 0 && mm === 0) || (hh === 23 && mm >= 59);
    const hora = diaCompleto ? null : `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'a. m.' : 'p. m.'}`;
    return { ymd, hora };
}

/**
 * Cuándo es el servicio, en hora de Bogotá: «del sábado 21 al domingo 22 de
 * noviembre de 2026» / «sábado 21 de noviembre de 2026, de 9:00 a. m. a 3:00
 * p. m.». null sin fecha. Pura.
 */
export function cuandoParaIa(item: Pick<ItemDeServicio, 'starts_at' | 'ends_at'>): string | null {
    const a = item.starts_at ? partesBogota(item.starts_at) : null;
    if (!a) return null;
    const b = item.ends_at ? partesBogota(item.ends_at) : null;
    if (!b || b.ymd === a.ymd) {
        const horas = a.hora && b?.hora && b.hora !== a.hora ? `, de ${a.hora} a ${b.hora}` : a.hora ? `, ${a.hora}` : '';
        return `${hoyLegibleDe(a.ymd)}${horas}`;
    }
    const mismoMes = a.ymd.slice(0, 7) === b.ymd.slice(0, 7);
    const inicio = mismoMes ? `${diaDeLaSemana(a.ymd)} ${Number(a.ymd.slice(8, 10))}` : diaConSemana(a.ymd);
    const horas = a.hora || b.hora
        ? ` (empieza ${a.hora ? `a las ${a.hora}` : 'ese día'}${b.hora ? `; termina a las ${b.hora}` : ''})`
        : '';
    return `del ${inicio} al ${hoyLegibleDe(b.ymd)}${horas}`;
}

/** El texto de la escuela sin marcas que puedan cerrar las etiquetas del prompt. Pura. */
function textoDeEscuela(t: string | null | undefined, max = MAX_DESCRIPCION): string {
    const s = String(t ?? '').replace(/\r\n/g, '\n').replace(/<\/?\s*[a-z_]+\s*>/gi, ' ').trim();
    return s.length > max ? `${s.slice(0, max).replace(/\s+\S*$/, '')}…` : s;
}

/**
 * (Monster 2026-11-19) El cobro que la persona YA TIENE de este servicio (`payments.amount` y `amount_paid`).
 * Con un abono hecho, el precio que rige para ella es el de ESE cobro, no el del catálogo de hoy: abonó $150.000 de
 * $300.000 en preventa y al cambiar el precio el bot le dijo «saldo $166.250» (la mitad de $332.500).
 */
export interface CobroPrevioParaIa {
    amount: number;
    amountPaid: number;
}

/** El cobro previo con abono hecho (lo único que reemplaza al precio de hoy). Pura. */
export function cobroConAbono(c: Partial<CobroPrevioParaIa> | null | undefined): CobroPrevioParaIa | null {
    const amount = Number(c?.amount);
    const amountPaid = Number(c?.amountPaid);
    return Number.isFinite(amount) && amount > 0 && Number.isFinite(amountPaid) && amountPaid > 0
        ? { amount: Math.round(amount), amountPaid: Math.round(amountPaid) }
        : null;
}

/** Los montos del cobro previo: total, abonado y saldo. Pura. */
export function montosDelCobroPrevio(c: CobroPrevioParaIa): number[] {
    const saldo = c.amount - c.amountPaid;
    return [c.amount, c.amountPaid, ...(saldo > 0 ? [saldo] : [])];
}

/** Las líneas del valor de quien ya abonó: total del cobro, abonado y SALDO (nunca el precio de hoy). Pura. */
export function lineasDeSaldoDelCobro(c: CobroPrevioParaIa): string[] {
    const saldo = c.amount - c.amountPaid;
    return saldo > 0
        ? [`Tu cobro por este servicio es de *${cop(c.amount)}*; abonaste *${cop(c.amountPaid)}* y el saldo pendiente es *${cop(saldo)}*.`]
        : [`Tu cobro por este servicio es de *${cop(c.amount)}* y ya está pagado completo.`];
}

export interface OpcionesCatalogoIa {
    /** Cobro que la persona ya tiene del servicio: con abono, su saldo manda sobre el precio de hoy. */
    cobroPrevio?: CobroPrevioParaIa | null;
    /** 'YYYY-MM-DD' en Bogotá. */
    hoy: string;
    /** El número es de una familia del club (le corresponde el precio de afiliado si el ítem lo tiene). */
    afiliado: boolean;
    /** Las cuentas para pagar: las mismas para todos o por servicio. */
    cuentas: CuentaDePagoEmbudo[] | ((item: ItemConFicha) => CuentaDePagoEmbudo[]);
}

const CONFIRMACION_DEL_CUPO = 'Cómo se confirma el cupo: la persona envía por este chat la foto o el PDF del comprobante con el nombre completo de quien asiste; la escuela lo valida y le confirma el cupo por aquí.';

/** Los datos de UN servicio para el modelo, una línea por dato. Pura. */
export function fichaDeServicioParaIa(item: ItemConFicha, o: OpcionesCatalogoIa): string {
    const precio = precioDelServicio(item, { afiliado: o.afiliado, hoy: o.hoy });
    const tieneAfiliado = positivo(item.precio_afiliado) !== null
        || opcionesDelItem(item).some((op) => positivo(op.precio_afiliado) !== null);
    const lineas: string[] = [`Servicio: ${textoDeEscuela(item.name, 200)}`];
    const cuando = cuandoParaIa(item);
    lineas.push(`Cuándo: ${cuando ?? 'la fecha no está cargada en el catálogo'}`);

    const cobro = cobroConAbono(o.cobroPrevio);
    if (cobro) {
        const saldo = cobro.amount - cobro.amountPaid;
        lineas.push(`Cobro de ESTA persona por este servicio (es SU valor; manda sobre el catálogo): ${cop(cobro.amount)} en total; ya abonó ${cop(cobro.amountPaid)}; `
            + (saldo > 0 ? `saldo pendiente ${cop(saldo)}.` : 'ya está pagado completo.'));
        lineas.push(saldo > 0
            ? `Si pregunta cuánto falta, cuánto debe pagar o cuál es el abono mínimo, la respuesta es el SALDO: ${cop(saldo)} (puede pagarlo completo). `
              + 'NO uses el valor de hoy ni los de otras fechas, no recalcules abonos, mitades ni descuentos, y no mezcles «abono» con un precio de otra fecha.'
            : 'No debe nada de este servicio; no le des otro valor ni le pidas otro abono.');
    } else if (precio.opciones.length) {
        // (Monster 2026-11-20) Teléfono sin identificar como afiliado: NO se asume «externo». Se dan las dos tarifas de cada
        // opción y se le pide que diga cuál es (antes solo veía la de externos y el bot decía «no tengo otro valor»).
        const dosTarifas = !precio.deAfiliado && precio.opciones.some((op) => op.precioAfiliado !== undefined);
        lineas.push(dosTarifas
            ? 'Opciones y valor de hoy (no se sabe si la persona es afiliada del club): '
              + precio.opciones.map((op) => (op.precioAfiliado !== undefined
                  ? `${op.etiqueta}: afiliados ${cop(op.precioAfiliado)} · externos ${cop(op.precio)}`
                  : `${op.etiqueta}: ${cop(op.precio)}`)).join(' | ')
            : `Opciones y valor de hoy${precio.deAfiliado ? ' (valor de afiliado del club)' : ''}: `
              + precio.opciones.map((op) => `${op.etiqueta}: ${cop(op.precio)}`).join(' · '));
        if (dosTarifas) {
            lineas.push('Tarifa: no sabes si la persona es afiliada del club (entrena en él) o externa. Da LAS DOS tarifas de la opción que pregunta («afiliados X · externos Y») y pídele que diga cuál es. '
                + 'NUNCA asumas que es externa ni digas que no hay otro valor para quien no es afiliada.');
        }
    } else if (precio.hoy !== null) {
        if (precio.deAfiliado) {
            lineas.push(`Valor para esta persona (afiliada al club): ${cop(precio.hoy)}, sin importar la fecha.`);
        } else {
            lineas.push(`Valor hoy (${diaConSemana(o.hoy)}): ${cop(precio.hoy)}${precio.antes ? ` (antes ${cop(precio.antes)})` : ''}`);
            const tramos = textoDeTramos(item);
            if (tramos) lineas.push(`Precio por fecha: ${tramos}`);
        }
    } else {
        lineas.push('Valor: no está cargado en el catálogo.');
    }
    if (!cobro && tieneAfiliado && !precio.deAfiliado && !precio.opciones.some((op) => op.precioAfiliado !== undefined)) {
        lineas.push('Afiliados del club: tienen un valor especial; si la persona dice ser del club, la escuela verifica su número y le confirma ese valor (no des la cifra).');
    }
    if (cobro) {
        // El abono y el saldo ya salieron del cobro de la persona; el abono del catálogo no aplica.
    } else if (precio.abono !== null && precio.hoy !== null) {
        lineas.push(`Abono mínimo para separar el cupo: ${cop(precio.abono)}${precio.abonoPct ? ` (${precio.abonoPct} %)` : ''}; el resto (${cop(precio.hoy - precio.abono)}) queda pendiente.`);
    } else if (!precio.opciones.length && precio.hoy !== null) {
        lineas.push('Abono: el catálogo no tiene abono; el cupo se separa con el valor completo.');
    }

    const cuentas = typeof o.cuentas === 'function' ? o.cuentas(item) : o.cuentas;
    lineas.push(cuentas.length
        ? `Cuentas para pagar: ${comoPagar(cuentas).replace(/\n+$/, '')}`
        : 'Cuentas para pagar: la escuela no tiene cuentas cargadas aquí; los datos de pago los envía la escuela por este chat.');
    lineas.push(CONFIRMACION_DEL_CUPO);

    const desc = textoDeEscuela(item.description);
    lineas.push(desc ? `Descripción escrita por la escuela:\n${desc}` : 'Descripción: la escuela no escribió descripción.');
    return lineas.join('\n');
}

/**
 * El bloque de todos los servicios vigentes ('' si no hay). Va dentro de
 * <catalogo> en el prompt; el catálogo manda sobre la ficha libre. Pura.
 */
export function bloqueDeCatalogoParaIa(items: ItemConFicha[], o: OpcionesCatalogoIa): string {
    return items.slice(0, MAX_SERVICIOS)
        .map((it, i) => `[Servicio ${i + 1}]\n${fichaDeServicioParaIa(it, o)}`)
        .join('\n\n');
}
