/**
 * wa-cola-reglas — reglas PURAS de la cola de comprobantes de WhatsApp.
 *
 * Salen de la auditoría de producción del 1 al 16 de noviembre de 2026: de 723 archivos, el 27 % terminó en un
 * cobro; ~$3,0 M en una escuela y ~$13,8 M en otra eran comprobantes probablemente reales sin cobro. Cada regla
 * de acá cierra una de las formas en que la cola perdía un pago. Sin base y sin red: las usa whatsapp-queue.job
 * (el worker), whatsapp-respuesta-de-cobro (la respuesta de la familia) y whatsapp-bandeja (lo que ve la escuela).
 *
 *  R1  guardar SIEMPRE lo leído (`lecturaCompleta`)
 *  R2  sin cobros abiertos pero con un pago real → acción (`motivoSinPendientesConPago`)
 *  R4  el nombre del pie o de la nota manda sobre el hijo por defecto (`hijoNombrado`, `mesNombrado`)
 *  R5  número que no está en la ficha, pero nombra a un deportista (`fichaPorNombreYApellido`)
 *  R6  pagos de torneo o de club (`senalDeTorneoOClub`)
 *  R7  la venta de un servicio no secuestra pagos de familias (`laVentaCede`)
 *  R8  pago partido en dos comprobantes (`pagoPartido`)
 *  R9  monto leído distinto del cobro al que se aplicó (`difiereDelCobro`)
 *  R10 pregunta abierta que atrapa mensajes ajenos (`hablaDePagoMesOMonto`, `pareceNombreDePersona`)
 *  R11 reclamo o corrección tras el resultado (`esCorreccionDeResultado`)
 */

import type { PagoPendiente } from './whatsapp-receipt-matching.service';
import { mesDePago, mesesDelTexto, NOMBRE_MES } from './whatsapp-eleccion-de-pago.service';

const plano = (s: string | null | undefined) => String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
const pesos = (n: number) => `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n))}`;
const cita = (s: string | null | undefined, max = 120) => String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, max);
const TOLERANCIA = 1;
const igual = (a: number, b: number) => Math.abs(a - b) <= TOLERANCIA;

// ─── R1. Guardar siempre lo leído ────────────────────────────────────────────

/** Lo del OCR que hace falta para auditar una fila que no terminó en cobro. */
export interface LecturaDeOcr {
    amount?: number | null; reference?: string | null; date?: string | null; destination?: string | null;
    bank?: string | null; originName?: string | null; description?: string | null; destinationName?: string | null;
    isReceipt?: boolean | null; isTransactionList?: boolean | null;
}

/**
 * Las huellas de siempre (`huellasDelComprobante`: sha, monto, referencia, destino, fecha, banco, referencias) MÁS
 * quién pagó, la nota y el titular del destino. Mismo formato de `pregunta_ocr` que usan las demás ramas (la
 * bandeja lee `sha`, `ocr.reference` y `referencias`), así que nada de lo que ya lee esa columna cambia. Pura.
 */
export function lecturaCompleta(
    huellas: Record<string, unknown> | null | undefined, ocr: LecturaDeOcr | null | undefined,
): Record<string, unknown> | null {
    if (!huellas && !ocr) return null;
    const base = (huellas ?? { sha: null, storagePath: null, parentId: null, referencias: [] }) as Record<string, any>;
    if (!ocr) return base;
    return {
        ...base,
        ocr: {
            amount: ocr.amount ?? null, reference: ocr.reference ?? null, destination: ocr.destination ?? null,
            date: ocr.date ?? null, bank: ocr.bank ?? null,
            ...(base.ocr && typeof base.ocr === 'object' ? base.ocr : {}),
            originName: ocr.originName ?? null,
            description: ocr.description ? cita(ocr.description, 300) : null,
            destinationName: ocr.destinationName ?? null,
            ...(ocr.isReceipt === false ? { isReceipt: false } : {}),
            ...(ocr.isTransactionList === true ? { isTransactionList: true } : {}),
        },
    };
}

// ─── R2. Sin cobros abiertos, con un pago real ───────────────────────────────

/** Prefijo del `error_message` (la bandeja lo muestra como ACCIÓN; el texto exacto «sin pagos pendientes» sigue igual). */
export const CODIGO_SIN_PENDIENTES_CON_PAGO = 'sin_pendientes';

/** El motivo y la propuesta de la bandeja. Pura. */
export function motivoSinPendientesConPago(e: {
    monto: number; quienPago?: string | null; deportistas?: (string | null)[]; fecha?: string | null; dice?: string | null;
}): { base: string; propuesta: string } {
    const ds = (e.deportistas ?? []).filter(Boolean) as string[];
    return {
        base: `${CODIGO_SIN_PENDIENTES_CON_PAGO}: pagó ${pesos(e.monto)} y no tiene cobros abiertos: puede ser otro concepto `
            + `o un mes que no se ha generado${e.dice ? ` · dice: «${cita(e.dice, 90)}»` : ''}`,
        propuesta: `Propuesta → pagó: ${e.quienPago ?? 'no se leyó'} · deportista: ${ds.length ? ds.join(' / ') : 'sin identificar'}`
            + `${e.fecha ? ` · fecha del pago: ${e.fecha}` : ''} · crear el cobro que corresponde (o el del mes) y aplicar este comprobante`,
    };
}

/** Lo que se le dice a la familia: llegó, no tiene cobros abiertos y lo mira la escuela. Nunca «quedó registrado». Pura. */
export function textoSinPendientesALaEscuela(monto: number | null): string {
    return `Recibí tu comprobante${monto ? ` de *${pesos(monto)}*` : ''} 📄 Ahora mismo no te aparece ningún cobro pendiente, `
        + 'así que se lo paso a la escuela para que revise a qué corresponde y te confirme por aquí.';
}

/** El archivo no se pudo abrir (muy grande o un formato que no se lee): se dice, y la fila queda en acción. */
export const TEXTO_ARCHIVO_NO_LEIDO =
    'Recibí tu archivo 📄 No lo pude abrir (pesa mucho o viene en un formato que no leo), así que la escuela lo revisa. '
    + 'Si puedes, mándame una captura de pantalla del comprobante.';
export const PASO_ARCHIVO_NO_LEIDO = 'archivo_no_leido';

// ─── R4. El nombre del pie o de la nota manda sobre el hijo por defecto ──────

export interface PersonaConNombre { id: string; nombre: string | null }

/** Palabras que no identifican a nadie aunque estén en un nombre («de», «la») o que también son un mes. */
const CONECTORES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'san', 'santa']);
const MESES_PLANOS = new Set(NOMBRE_MES.map((m) => plano(m)));

const palabrasDe = (nombre: string | null | undefined) =>
    [...new Set(plano(nombre).split(' ').filter((w) => w.length >= 3 && !CONECTORES.has(w)))];

/**
 * El hijo de ESTA familia que nombran el pie, la nota del comprobante o los textos de la ráfaga, si es UNO solo.
 * Cuenta el nombre de pila con al menos un apellido, o una palabra del nombre que solo tiene ese hermano (los
 * apellidos los comparten, así que «Isabella» desempata entre Isabella y Juliana Rodríguez Amórtegui). Un nombre que
 * también es un mes («Abril», «Julio») necesita otra palabra más. Si nombra a dos, a ninguno o a alguien que no es
 * de la familia: null (se pregunta como siempre). Pura.
 *
 * Casos de la auditoría: pie «Mensualidad Isabella Rodríguez Amórtegui» (se preguntó por Juliana); pie «Juan Diego
 * Osorio» (se preguntó por Victoria); «pago del mes de noviembre de mi hija Antonella» («¿De cuál deportista es?»).
 */
export function hijoNombrado<T extends PersonaConNombre>(textos: (string | null | undefined)[], hijos: T[]): T | null {
    const conNombre = hijos.filter((h) => h.nombre && plano(h.nombre));
    if (!conNombre.length) return null;
    const t = ` ${plano(textos.filter(Boolean).join(' · '))} `;
    if (t.trim().length < 3) return null;
    const veces = new Map<string, number>();
    for (const h of conNombre) for (const w of palabrasDe(h.nombre)) veces.set(w, (veces.get(w) ?? 0) + 1);
    const escritasDe = (h: T) => palabrasDe(h.nombre).filter((w) => t.includes(` ${w} `));
    /** Una palabra que solo tiene este hermano (su nombre de pila, casi siempre), y que no es un mes. */
    const conPalabraPropia = (h: T) => conNombre.length >= 2
        && escritasDe(h).some((w) => veces.get(w) === 1 && !MESES_PLANOS.has(w) && w.length >= 4);
    const nombrados = conNombre.filter((h) => {
        const escritas = escritasDe(h);
        if (!escritas.length) return false;
        // Nombre de pila + al menos un apellido (u otro nombre).
        if (escritas.includes(palabrasDe(h.nombre)[0]) && escritas.length >= 2) return true;
        return conPalabraPropia(h);
    });
    if (nombrados.length === 1) return nombrados[0];
    // «María Camila Torres» nombra a María Camila y, por «María» + «Torres», también a María José: gana la que
    // tiene escrita una palabra que es solo suya.
    const propias = nombrados.filter(conPalabraPropia);
    return propias.length === 1 ? propias[0] : null;
}

/**
 * El mes que la familia dijo que paga («Adjunto soporte de pago Noviembre», «Mes noviembre María Camila…», «19 de
 * octubre de 2026»), si es UNO. `nombres`: los de los deportistas, para no leer «Abril» como mes. El año se deduce:
 * un mes posterior al siguiente es del año pasado. Pura.
 */
export function mesNombrado(
    textos: (string | null | undefined)[], hoy: Date, nombres: (string | null | undefined)[] = [],
): { mes: number; anio: number } | null {
    const comoPagos = nombres.filter(Boolean).map((n) => ({ atleta: n }) as PagoPendiente);
    for (const t of textos) {
        if (!t || !String(t).trim()) continue;
        const meses = mesesDelTexto(String(t), comoPagos);
        if (meses.length !== 1) { if (meses.length > 1) return null; continue; }
        const mes = meses[0];
        const anioEscrito = /\b(20\d{2})\b/.exec(String(t))?.[1];
        const actual = hoy.getUTCMonth() + 1;
        const anio = anioEscrito ? Number(anioEscrito) : (mes > actual + 1 ? hoy.getUTCFullYear() - 1 : hoy.getUTCFullYear());
        return { mes, anio };
    }
    return null;
}

/**
 * Antes de «¿a cuál de estos cobros?»: los cobros del hijo que la familia nombró y, si dijo el mes, los de ese mes.
 * `elegido` solo cuando queda UN cobro por el monto del comprobante (±$1); si no, `opciones` es la lista acotada
 * para preguntar (o null si no se pudo acotar). Pura.
 */
export function acotarCobrosPorLoEscrito(
    opciones: PagoPendiente[], textos: (string | null | undefined)[], monto: number | null,
): { elegido: PagoPendiente | null; opciones: PagoPendiente[] | null; por: 'nombre' | 'nombre_y_mes' | null } {
    const hijos = new Map<string, PersonaConNombre>();
    for (const p of opciones) {
        const id = p.child_id ?? p.atleta ?? '';
        if (id && p.atleta && !hijos.has(id)) hijos.set(id, { id, nombre: p.atleta });
    }
    if (hijos.size < 2) return { elegido: null, opciones: null, por: null };
    const hijo = hijoNombrado(textos, [...hijos.values()]);
    if (!hijo) return { elegido: null, opciones: null, por: null };
    let suyos = opciones.filter((p) => (p.child_id ?? p.atleta ?? '') === hijo.id);
    let por: 'nombre' | 'nombre_y_mes' = 'nombre';
    const meses = textos.flatMap((t) => (t ? mesesDelTexto(String(t), opciones) : []));
    if (meses.length) {
        const delMes = suyos.filter((p) => { const m = mesDePago(p); return m !== null && meses.includes(m); });
        if (delMes.length) { suyos = delMes; por = 'nombre_y_mes'; }
    }
    if (monto !== null) {
        const delMonto = suyos.filter((p) => igual(Number(p.amount), monto));
        if (delMonto.length === 1) return { elegido: delMonto[0], opciones: suyos, por };
        // Varios del mismo valor del MISMO deportista: el más antiguo (la regla de la escuela, 2026-09-15).
        if (delMonto.length > 1) {
            const masAntiguo = [...delMonto].sort((a, b) => String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')))[0];
            return { elegido: masAntiguo, opciones: suyos, por };
        }
    }
    return { elegido: null, opciones: suyos.length && suyos.length < opciones.length ? suyos : null, por };
}

// ─── R5. Número que no está en la ficha ──────────────────────────────────────

export interface FichaDeEscuela { id: string; nombre: string; tipo: 'child' | 'unregistered' }

/**
 * El deportista ACTIVO de la escuela que nombran los textos con nombre + apellido, si la coincidencia es ÚNICA.
 * Exige el nombre de pila (o el segundo nombre, en nombres de 4 palabras) y al menos otra palabra; gana quien más
 * palabras acierta y un empate no señala a nadie. Solo sirve para PROPONER en la bandeja: nunca para aplicar ni
 * para mostrarle nada a quien escribe. Pura.
 *
 * Caso: pie «comprobante de pago SARA DAZA» de un número que no está en la ficha → se preguntó «¿de qué deportista?».
 */
export function fichaPorNombreYApellido<T extends FichaDeEscuela>(textos: (string | null | undefined)[], fichas: T[]): T | null {
    const t = ` ${plano(textos.filter(Boolean).join(' · '))} `;
    if (t.trim().length < 5) return null;
    let mejor = 0;
    let out: T[] = [];
    for (const f of fichas) {
        const ws = palabrasDe(f.nombre);
        if (ws.length < 2) continue;
        const escritas = ws.filter((w) => t.includes(` ${w} `));
        if (escritas.length < 2) continue;
        const dePila = escritas.includes(ws[0]) || (ws.length >= 4 && escritas.includes(ws[1]));
        if (!dePila) continue;
        if (escritas.length > mejor) { mejor = escritas.length; out = [f]; } else if (escritas.length === mejor) out.push(f);
    }
    return out.length === 1 ? out[0] : null;
}

/** Código de la fila (queda bajo `sin_familia:`, que la bandeja ya muestra como acción). */
export const CODIGO_NUMERO_FUERA_DE_FICHA = 'numero_fuera_de_la_ficha';

/**
 * La propuesta EXACTA para la escuela cuando el número no está en la ficha pero el pie nombra a un deportista con
 * un cobro abierto por ese monto. No se aplica solo: es dinero atribuido por nombre desde un número desconocido. Pura.
 */
export function propuestaNumeroFueraDeFicha(e: {
    deportista: string; monto: number | null; cobro?: Pick<PagoPendiente, 'concept' | 'due_date' | 'amount' | 'id'> | null;
    abiertos?: string | null;
}): { detalle: string; propuesta: string } {
    const valor = e.monto !== null ? pesos(e.monto) : 'monto sin leer';
    if (e.cobro) {
        const mes = mesDePago(e.cobro as PagoPendiente);
        const de = mes ? `de ${NOMBRE_MES[mes - 1]}` : `de «${e.cobro.concept ?? 'un cobro'}»`;
        return {
            detalle: `parece el pago ${de} de ${e.deportista}: ${valor}; el número no está en su ficha`,
            propuesta: `aplicar al cobro ${e.cobro.id} («${e.cobro.concept ?? ''}», ${pesos(Number(e.cobro.amount))}) y ligar el número a la ficha de ${e.deportista}`,
        };
    }
    return {
        detalle: `parece un pago de ${e.deportista}: ${valor}; el número no está en su ficha y ese valor no es el de un cobro abierto`
            + `${e.abiertos ? ` (${e.abiertos})` : ''}`,
        propuesta: `confirmar con quien pagó, aplicar este comprobante a ${e.deportista} y ligar el número a su ficha`,
    };
}

// ─── R6. Pagos de torneo o de club ───────────────────────────────────────────

const TORNEO_O_CLUB_RE = new RegExp('\\b('
    + 'torneos?|copas?|campeonatos?|festival(es)?|ligas?|'
    + 'inscripcion(es)? (del?|de los|de las|para el|para los) (equipos?|clubes?|club)|'
    + 'equipos?|clubes|club|'
    + 'sub ?\\d{1,2}|categorias? (sub|infantil|prejuvenil|juvenil|mayores|libre|benjamin|pony|\\d{4})|'
    + 'infantil [ab]\\b|prejuvenil|juvenil (a|b|masculino|femenino)|rama (masculina|femenina)'
    + ')\\b');
const ES_DE_LA_MENSUALIDAD_RE = /\b(mensualidad(es)?|pension|mes de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre))\b/;

/**
 * ¿El pie, la nota o los textos dicen que es un pago de torneo o de club («torneo», «equipo», «club», «inscripción
 * del equipo», «liga», una categoría de competencia)? Devuelve lo que dijo (para la bandeja) o null. Si el mismo
 * texto habla de la mensualidad, no: «mensualidad del club» es una familia. Pura.
 *
 * Caso: clubes externos pagando $900.000 a los que el bot les preguntó «¿de qué deportista?» (~20 filas, > $2,2 M).
 */
export function senalDeTorneoOClub(textos: (string | null | undefined)[]): string | null {
    for (const crudo of textos) {
        const t = plano(crudo);
        if (!t || !TORNEO_O_CLUB_RE.test(t) || ES_DE_LA_MENSUALIDAD_RE.test(t)) continue;
        return cita(crudo, 140);
    }
    return null;
}

export const CODIGO_TORNEO_O_CLUB = 'torneo_o_club';

/** Motivo y propuesta de la bandeja para un pago de torneo o de club. Pura. */
export function motivoTorneoOClub(e: { monto: number | null; dijo: string; quienPago?: string | null; fecha?: string | null; contacto?: string | null }):
{ base: string; propuesta: string } {
    return {
        base: `${CODIGO_TORNEO_O_CLUB}: ${e.monto !== null ? pesos(e.monto) : 'comprobante sin monto leído'} que parece de un torneo o de un club`
            + ` · dijo: «${cita(e.dijo, 140)}»`,
        propuesta: `Propuesta → pagó: ${e.quienPago ?? 'no se leyó'}${e.contacto ? ` · contacto: ${cita(e.contacto, 40)}` : ''}`
            + `${e.fecha ? ` · fecha del pago: ${e.fecha}` : ''} · registrar como pago de torneo o del club (no es de un deportista)`,
    };
}

/** Lo que se le dice a quien pagó un torneo o lo de un club: llegó y lo registra la escuela. Pura. */
export function textoTorneoOClubRecibido(monto: number | null): string {
    return `Recibí tu comprobante${monto ? ` de *${pesos(monto)}*` : ''} 📄 Se lo paso a la escuela para que lo registre y te confirme por aquí.`;
}

// ─── R7. La venta de un servicio no secuestra pagos de familias ──────────────

const DE_LA_FAMILIA_RE = /\b(mensualidad(es)?|pension|mes|meses|saldo|resto|cuota|abono (de|del|a) (la )?mensualidad)\b/;

export type RazonDeCeder = 'desmiente_el_servicio' | 'habla_de_la_mensualidad' | 'saldo_de_un_cobro' | 'suma_de_cobros' | null;

/**
 * ¿La venta de un servicio (clínica, vacacional…) le CEDE este comprobante al camino de familia?
 *
 *  · El texto desmiente el servicio («no estamos pagando la clínica, estamos pagando la mensualidad») → siempre.
 *  · Habla de mensualidad / mes / saldo y NO nombra el servicio → sí.
 *  · El monto es el saldo de un cobro abonado de la familia, o la suma exacta de varios de sus cobros → sí.
 *
 * Si nada de eso pasa, decide la venta como siempre (precio o abono válido del servicio). `alias`: los nombres del
 * servicio ya normalizados (`aliasesDelServicio`). Pura.
 */
export function laVentaCede(e: {
    textos: (string | null | undefined)[]; alias: string[]; monto: number | null;
    pendientes?: Pick<PagoPendiente, 'amount'>[]; parciales?: { amount: number; amount_paid: number | null }[];
}): { cede: boolean; razon: RazonDeCeder; desmiente: boolean } {
    const textos = e.textos.map((t) => plano(t)).filter(Boolean);
    const alias = [...new Set(e.alias.map((a) => plano(a)).filter((a) => a.length >= 4))];
    const nombra = (t: string) => alias.some((a) => ` ${t} `.includes(` ${a} `));
    const desmienteEn = (t: string) => alias.some((a) =>
        new RegExp(`\\bno\\b(?: \\w+){0,4} (?:(?:de |para |a )?(?:la |el |lo de la |lo del )?)${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t));
    if (textos.some(desmienteEn)) return { cede: true, razon: 'desmiente_el_servicio', desmiente: true };
    const nombraElServicio = textos.some(nombra);
    if (!nombraElServicio && textos.some((t) => DE_LA_FAMILIA_RE.test(t))) return { cede: true, razon: 'habla_de_la_mensualidad', desmiente: false };
    if (e.monto !== null && !nombraElServicio) {
        const saldos = (e.parciales ?? []).map((p) => Number(p.amount) - Number(p.amount_paid ?? 0)).filter((s) => s > 0);
        if (saldos.some((s) => igual(s, e.monto as number))) return { cede: true, razon: 'saldo_de_un_cobro', desmiente: false };
        const montos = (e.pendientes ?? []).map((p) => Number(p.amount)).filter((m) => m > 0).slice(0, 8);
        if (montos.length >= 2 && algunaSumaDa(montos, e.monto)) return { cede: true, razon: 'suma_de_cobros', desmiente: false };
    }
    return { cede: false, razon: null, desmiente: false };
}

/** ¿Dos o más de `montos` suman `objetivo` (±$1)? */
function algunaSumaDa(montos: number[], objetivo: number): boolean {
    const buscar = (i: number, resto: number, n: number): boolean => {
        if (Math.abs(resto) <= TOLERANCIA && n >= 2) return true;
        if (resto < -TOLERANCIA || i >= montos.length) return false;
        return buscar(i + 1, resto - montos[i], n + 1) || buscar(i + 1, resto, n);
    };
    return buscar(0, objetivo, 0);
}

// ─── R8. Pago partido ────────────────────────────────────────────────────────

/** Minutos hacia atrás en los que otro comprobante del mismo contacto cuenta como parte del mismo pago. */
export const VENTANA_PAGO_PARTIDO_MIN = 10;
export const CODIGO_PAGO_PARTIDO = 'pago_partido';

export interface ParteDePago { id: string; monto: number }

/**
 * ¿Este comprobante y los anteriores del mismo contacto (últimos 10 min, sin aplicar) suman un cobro abierto?
 * $9.000 + $81.000 = la cuota de $90.000 (dio `monto_no_cuadra` dos veces). Se prueba con todos los anteriores y,
 * si no, con el más reciente. Devuelve el cobro y las partes, o null. No aplica nada: un cobro admite UN
 * comprobante, así que lo junta la escuela. Pura.
 */
export function pagoPartido(
    previos: ParteDePago[], monto: number | null, pendientes: PagoPendiente[],
): { cobro: PagoPendiente; partes: ParteDePago[]; total: number } | null {
    if (monto === null || !previos.length || !pendientes.length) return null;
    const validos = previos.filter((p) => Number.isFinite(p.monto) && p.monto > 0);
    const intentos = [validos, validos.slice(-1)].filter((x) => x.length);
    for (const partes of intentos) {
        const total = partes.reduce((s, p) => s + p.monto, 0) + monto;
        const cobros = pendientes.filter((p) => igual(Number(p.amount), total));
        if (cobros.length >= 1) {
            const masAntiguo = [...cobros].sort((a, b) => String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')))[0];
            // Dos cobros iguales de deportistas distintos: no se adivina de quién es.
            const deportistas = new Set(cobros.map((c) => c.child_id ?? c.atleta ?? ''));
            if (deportistas.size > 1) continue;
            return { cobro: masAntiguo, partes, total };
        }
    }
    return null;
}

/** Motivo y propuesta de la bandeja. `descripcion`: el cobro como lo nombra la cola (`describirPago`). Pura. */
export function motivoPagoPartido(e: { partes: ParteDePago[]; monto: number; total: number; descripcion: string; cobroId: string }):
{ base: string; propuesta: string } {
    const sumandos = [...e.partes.map((p) => pesos(p.monto)), pesos(e.monto)].join(' + ');
    return {
        base: `${CODIGO_PAGO_PARTIDO}: ${sumandos} = ${pesos(e.total)}, el valor de ${e.descripcion} (llegó en ${e.partes.length + 1} comprobantes)`,
        propuesta: `Propuesta → aplicar los ${e.partes.length + 1} comprobantes al cobro ${e.cobroId} (un cobro admite un solo comprobante: `
            + `registrar uno y dejar los otros como soporte) · filas: ${e.partes.map((p) => p.id).join(', ')}`,
    };
}

export function textoPagoPartido(total: number, n: number): string {
    return `Recibí tus ${n} comprobantes 📄 Juntos suman *${pesos(total)}*. Se los paso a la escuela para que los aplique al mismo cobro y te confirme por aquí.`;
}

// ─── R9. Monto leído distinto del cobro ──────────────────────────────────────

export const CODIGO_MONTO_DISTINTO_APLICADO = 'monto_distinto_aplicado';

/** ¿El monto leído difiere del valor que se esperaba para el cobro en más de la tolerancia? Pura. */
export function difiereDelCobro(montoLeido: number | null | undefined, esperado: number | null | undefined): boolean {
    const m = Number(montoLeido);
    const e = Number(esperado);
    if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(e) || e <= 0) return false;
    return Math.abs(m - e) > TOLERANCIA;
}

/**
 * El motivo de la fila cuando el comprobante SÍ quedó en un cobro, pero por otro valor: $197.000 leídos contra una
 * mensualidad de $180.000; $708.000 sobre $180.000; $110.000 sobre $150.000. Con ambos valores y la diferencia. Pura.
 */
export function motivoMontoDistintoAplicado(e: { montoLeido: number; valorCobro: number; descripcion: string; detalle?: string | null }): string {
    const dif = e.montoLeido - e.valorCobro;
    return `${CODIGO_MONTO_DISTINTO_APLICADO}: comprobante de ${pesos(e.montoLeido)} aplicado a ${e.descripcion}, que vale ${pesos(e.valorCobro)} `
        + `(${dif > 0 ? `${pesos(dif)} de más` : `faltan ${pesos(-dif)}`}): revisar antes de aprobar`
        + `${e.detalle ? ` · ${cita(e.detalle, 160)}` : ''}`;
}

// ─── R10. Pregunta abierta que atrapa mensajes ajenos ────────────────────────

/** Pasado esto desde la pregunta, un texto solo cuenta como respuesta si calza con una opción o habla de pago/mes/monto. */
export const MINUTOS_RESPUESTA_LIBRE = 60;

const PAGO_MES_MONTO_RE = new RegExp('\\b('
    + 'pagos?|pague|pago|pagar|pagamos|pagando|cancele|cancelar|consigne|consignacion|transferi|transferencias?|comprobantes?|soportes?|recibos?|'
    + 'mensualidad(es)?|pension|mes|meses|cuotas?|abonos?|saldo|inscripcion|matricula|uniformes?|torneo|valor|monto|cobros?|deuda|debo|debemos|'
    + 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|'
    + 'ninguno|ninguna|todos|ambos|los dos|el primero|el segundo|el ultimo|la primera|la segunda|la ultima'
    + ')\\b');

/** ¿El texto habla de un pago, de un mes o de un monto? Pura. */
export function hablaDePagoMesOMonto(texto: string | null | undefined): boolean {
    const crudo = String(texto ?? '');
    const t = plano(crudo);
    if (!t) return false;
    if (/^\d{1,2}$/.test(t)) return true;                       // «2»: la opción
    if (/\$\s?\d|\b\d{1,3}([.,]\d{3})+\b|\b\d{2,3} ?mil\b/.test(crudo.toLowerCase())) return true;   // un monto
    return PAGO_MES_MONTO_RE.test(t);
}

/** ¿El texto parece el nombre de una persona (2 a 6 palabras, solo letras, sin pregunta)? Pura. */
export function pareceNombreDePersona(texto: string | null | undefined): boolean {
    const crudo = String(texto ?? '').trim();
    if (!crudo || /[?¿]/.test(crudo) || /\d{3,}/.test(crudo)) return false;
    const ws = plano(crudo).split(' ').filter(Boolean);
    if (ws.length < 2 || ws.length > 6) return false;
    return ws.every((w) => /^[a-z]+$/.test(w)) && !ws.some((w) => ['hola', 'gracias', 'buenos', 'buenas', 'porque', 'cuando', 'donde', 'necesito', 'quiero', 'puedes', 'favor'].includes(w));
}

/**
 * ¿Un texto que llega `minutos` después de la pregunta cuenta como respuesta? Dentro de la primera hora, sí (como
 * siempre). Después, solo si calza con una opción ofrecida (`calzaConOpcion`, lo decide quien llama con sus
 * opciones), habla de pago/mes/monto o —si se preguntó un nombre— parece un nombre. Lo demás no se consume ni
 * dispara una repregunta. Pura.
 *
 * Caso: 16 h después la clienta le hablaba a la dueña de otra cosa y recibió dos veces «no te entendí a cuál cobro va».
 */
export function cuentaComoRespuesta(e: {
    texto: string | null | undefined; minutos: number; calzaConOpcion: boolean; esperaNombre?: boolean;
}): boolean {
    if (!(e.minutos > MINUTOS_RESPUESTA_LIBRE)) return true;
    if (e.calzaConOpcion) return true;
    if (hablaDePagoMesOMonto(e.texto)) return true;
    return e.esperaNombre === true && pareceNombreDePersona(e.texto);
}

// ─── R11. Reclamo o corrección del cliente tras el resultado ─────────────────

/** Minutos desde el mensaje de resultado de la cola en los que un texto cuenta como corrección. */
export const MINUTOS_CORRECCION = 30;
export const CODIGO_RECLAMO = 'reclamo_del_cliente';

/** Lo último que la cola le dijo al cliente sobre un comprobante. */
export interface UltimoResultado {
    /** `payload.step` del saliente: resultado_comprobante, no_es_comprobante, sin_pendientes… */
    paso?: string | null;
    texto?: string | null;
    /** Minutos desde ese mensaje. Sin dato, se asume dentro de la ventana. */
    minutos?: number | null;
}

export type Correccion =
    | { tipo: 'mes_o_concepto'; mesDicho: number | null }
    | { tipo: 'si_es_un_pago' }
    | { tipo: 'no_revisado' };

const PASOS_NO_ES_PAGO = new Set(['no_es_comprobante', 'es_listado', 'escalated']);
const INSISTE_QUE_ES_PAGO_RE = /\b(estado exitos[oa]|compra exitosa|transferencia exitosa|transaccion exitosa|pago exitoso|exitos[oa]|aprobad[oa]|si es (el|un|mi) (comprobante|pago|soporte)|es el comprobante|ese es el (comprobante|pago)|si (lo )?pague|ahi dice|alli dice|ahi esta el (pago|valor|comprobante))\b/;
const NO_REVISADO_RE = /\b(no (me )?(has|han|ha) (revisado|confirmado|aplicado|registrado|validado)|no (lo |la |me |le )?(revisaste|revisaron|aplicaste|aplicaron|registraste|registraron)|sigue (apareciendo |saliendo )?(pendiente|sin aplicar|debiendo|en mora)|aun (aparece|sale|figura)|todavia (aparece|sale|figura|no))\b/;
const CORRIGE_RE = /\b(este fue|ese fue|esta fue|esa fue|fue el de|fue de|es (el )?de|era (el )?de|es para|era para|no es (de|el de|para)|no era|estoy pagando|estamos pagando|ahora (estoy|estamos)? ?pag|corresponde a|va para|iba para|me equivoque|esta mal|quedo mal|no es ese|ese no es)\b/;

/**
 * ¿El texto del cliente contradice o reclama el resultado que la cola le acaba de dar?
 *
 *  · Tras «Listo: comprobante… para octubre»: «Este fue octubre», «El 3 de octubre hicimos pago de octubre. Ahora
 *    estoy pagando noviembre» → `mes_o_concepto` (con el mes que dijo, si es otro).
 *  · Tras «no es un comprobante de pago»: «Ahí dice estado exitoso / compra exitosa» → `si_es_un_pago`.
 *  · «No has revisado este pago del domingo» → `no_revisado`.
 *
 * Solo dentro de los 30 minutos siguientes al mensaje de resultado. null = no es una corrección (el texto sigue su
 * curso). No decide nada sobre el cobro: quien llama deja la fila en ACCIÓN con el texto del cliente. Pura.
 */
export function esCorreccionDeResultado(texto: string | null | undefined, ultimoResultado: UltimoResultado | null | undefined): Correccion | null {
    if (!ultimoResultado) return null;
    if (typeof ultimoResultado.minutos === 'number' && ultimoResultado.minutos > MINUTOS_CORRECCION) return null;
    const crudo = String(texto ?? '').trim();
    const t = plano(crudo);
    if (!t || t.split(' ').length < 2) return null;
    const paso = String(ultimoResultado.paso ?? '');
    const dicho = plano(ultimoResultado.texto);
    const noEraPago = PASOS_NO_ES_PAGO.has(paso) || /\bno es un comprobante\b/.test(dicho);

    if (NO_REVISADO_RE.test(t) && hablaDePagoMesOMonto(crudo)) return { tipo: 'no_revisado' };
    if (noEraPago) return INSISTE_QUE_ES_PAGO_RE.test(t) ? { tipo: 'si_es_un_pago' } : null;

    const mesesDichos = mesesDelTexto(crudo);
    const mesesDelResultado = mesesDelTexto(String(ultimoResultado.texto ?? ''));
    const otroMes = mesesDichos.find((m) => !mesesDelResultado.includes(m)) ?? null;
    if (CORRIGE_RE.test(t) && (mesesDichos.length > 0 || DE_LA_FAMILIA_RE.test(t) || /\b(clinica|torneo|uniforme|inscripcion|matricula|vacacional)\b/.test(t))) {
        return { tipo: 'mes_o_concepto', mesDicho: otroMes };
    }
    // Nombra un mes distinto del que se le confirmó, hablando de un pago: también es una corrección.
    if (otroMes !== null && mesesDelResultado.length > 0 && /\b(pago|pague|pagando|comprobante|mensualidad|es de|es el de)\b/.test(t)) {
        return { tipo: 'mes_o_concepto', mesDicho: otroMes };
    }
    return null;
}

/**
 * Filtro barato ANTES de leer nada de la base: ¿el texto tiene forma de corrección o reclamo? (Casi ningún mensaje
 * la tiene, así que la respuesta de la familia no paga una lectura por cada «gracias».) Pura.
 */
export function puedeSerCorreccion(texto: string | null | undefined): boolean {
    const crudo = String(texto ?? '').trim();
    const t = plano(crudo);
    if (!t || t.split(' ').length < 2) return false;
    if (INSISTE_QUE_ES_PAGO_RE.test(t) || NO_REVISADO_RE.test(t) || CORRIGE_RE.test(t)) return true;
    return mesesDelTexto(crudo).length > 0 && /\b(pago|pague|pagando|comprobante|mensualidad|es de|es el de)\b/.test(t);
}

/** El motivo de la fila que el cliente reclamó: su texto primero, y detrás lo que ya decía la fila. Pura. */
export function motivoReclamo(e: { texto: string; correccion: Correccion; paso?: string | null; previo?: string | null }): string {
    const que = e.correccion.tipo === 'si_es_un_pago' ? 'insiste en que sí es un pago'
        : e.correccion.tipo === 'no_revisado' ? 'dice que su pago no se ha revisado'
            : `corrige el mes o el concepto${e.correccion.mesDicho ? ` (dice ${NOMBRE_MES[e.correccion.mesDicho - 1]})` : ''}`;
    return `${CODIGO_RECLAMO}: la familia ${que}: «${cita(e.texto, 200)}»${e.paso ? ` (tras ${e.paso})` : ''}`
        + `${e.previo ? ` | antes: ${cita(e.previo, 160)}` : ''}`;
}

export const TEXTO_RECLAMO_RECIBIDO = 'Gracias por avisarme 🙏 Le paso tu mensaje a la escuela para que lo revise y te confirme por aquí.';

// ─── Abonos de un servicio juzgados por la fecha de pago y la afiliación (Monster, clínica, 2026-11-16) ─────────────
//
// Tres comprobantes reales cerraron `venta_monto_no_cuadra` sin que la escuela supiera por qué: $150.000 pagados el 11-nov
// (el mínimo de no afiliado subió a $175.000 ese día), $150.000 pagados el 15-nov (la persona ya había abonado antes del
// 10-nov) y dos de $100.000 del mismo contacto (10-nov y 12-nov) que juntos suman $200.000. Acá solo se EXPLICA y se
// PROPONE para la bandeja: nunca se aplica nada solo, y el precio del cobro sigue siendo el de la RPC.

export interface NivelDeAbono { total: number; minimo: number | null }
export interface MinimosEnFecha { fecha: string; noAfiliado: NivelDeAbono | null; afiliado: NivelDeAbono | null }

const nivelTexto = (n: NivelDeAbono) => `${n.minimo !== null ? pesos(n.minimo) : 'sin abono'} (precio ${pesos(n.total)})`;

/**
 * «en la fecha del pago (2026-11-11) el abono mínimo era $175.000 (precio $350.000) si no es afiliado o $125.000 (precio
 * $250.000) si es afiliado; el saldo se paga hasta el 2026-11-20». `hoy`: para decir «hoy» en vez de la fecha. Pura.
 */
export function textoMinimosEnFecha(m: MinimosEnFecha, saldoHasta?: string | null, hoy?: string): string {
    const esHoy = !!hoy && m.fecha === hoy;
    const cuando = esHoy ? `hoy (${m.fecha})` : `en la fecha del pago (${m.fecha})`;
    const partes = [
        m.noAfiliado ? `${nivelTexto(m.noAfiliado)} si no es afiliado` : null,
        m.afiliado ? `${nivelTexto(m.afiliado)} si es afiliado` : null,
    ].filter(Boolean);
    if (!partes.length) return saldoHasta ? `el saldo se paga hasta el ${saldoHasta}` : '';
    return `${cuando} el abono mínimo ${esHoy ? 'es' : 'era'} ${partes.join(' o ')}${saldoHasta ? `; el saldo se paga hasta el ${saldoHasta}` : ''}`;
}

/** Un comprobante anterior del mismo contacto para el mismo servicio (cerrado en la bandeja, sin aplicar). */
export interface PagoPrevioDeServicio { id: string; monto: number; fecha: string | null }

export interface SumaDeAbonos {
    partes: PagoPrevioDeServicio[];
    suma: number;
    /** `completo`: la suma alcanza el precio; `abono`: alcanza el mínimo pero no el precio. */
    nivel: 'completo' | 'abono';
    conAfiliado: boolean;
    /** Alcanza solo con el mínimo de afiliado y la afiliación no está confirmada: la escuela tiene que verificarla. */
    afiliadoSinConfirmar: boolean;
    minimo: number | null;
    total: number;
    fecha: string;
}

/**
 * ¿Los comprobantes ANTERIORES del contacto para este servicio (en días distintos también) más este suman el abono
 * mínimo —o el precio— que pedía el servicio el día del PRIMER pago? `minimosPrimera`: los mínimos de esa fecha.
 * `afiliado`: lo que se sabe de la persona (null = no se sabe: cuenta cualquiera de los dos niveles). Devuelve null
 * si no hay anteriores o la suma no alcanza ningún nivel. Es solo una PROPUESTA para la escuela. Pura.
 */
export function sumaDeAbonosDeServicio(e: {
    previos: PagoPrevioDeServicio[]; monto: number; minimosPrimera: MinimosEnFecha; afiliado: boolean | null;
}): SumaDeAbonos | null {
    const partes = e.previos.filter((p) => Number.isFinite(p.monto) && p.monto > 0);
    if (!partes.length || !(e.monto > 0)) return null;
    const suma = partes.reduce((s, p) => s + p.monto, 0) + e.monto;
    const niveles: { n: NivelDeAbono; conAfiliado: boolean }[] = [];
    if (e.afiliado !== true && e.minimosPrimera.noAfiliado) niveles.push({ n: e.minimosPrimera.noAfiliado, conAfiliado: false });
    if (e.afiliado !== false && e.minimosPrimera.afiliado) niveles.push({ n: e.minimosPrimera.afiliado, conAfiliado: true });
    // Gana el primero que alcanza, en el orden de arriba: sin saber si es afiliado, el de NO afiliado (el mínimo más alto,
    // el que no promete de más); el de afiliado solo si es lo único que alcanza (y entonces hay que confirmar la afiliación).
    const g = niveles.find(({ n }) => suma >= n.total - TOLERANCIA || (n.minimo !== null && suma >= n.minimo - TOLERANCIA));
    if (!g) return null;
    return {
        partes, suma, conAfiliado: g.conAfiliado, afiliadoSinConfirmar: g.conAfiliado && e.afiliado !== true, minimo: g.n.minimo, total: g.n.total, fecha: e.minimosPrimera.fecha,
        nivel: suma >= g.n.total - TOLERANCIA ? 'completo' : 'abono',
    };
}

/** La propuesta de la bandeja para la suma de comprobantes. Pura. */
export function propuestaSumaDeAbonos(s: SumaDeAbonos, servicio: string): string {
    const sumandos = [...s.partes.map((p) => `${pesos(p.monto)}${p.fecha ? ` (${p.fecha})` : ''}`), 'este'].join(' + ');
    const alcanza = s.nivel === 'completo'
        ? `el precio completo (${pesos(s.total)})`
        : `el abono mínimo ${s.conAfiliado ? 'de afiliado' : 'de no afiliado'} (${pesos(s.minimo as number)}) vigente el ${s.fecha}`
            + `${s.afiliadoSinConfirmar ? ' (solo si es afiliado: verificarlo)' : ''}`;
    return `sumar ${s.partes.length + 1} comprobantes del mismo contacto para ${servicio} (${sumandos} = ${pesos(s.suma)}): alcanza ${alcanza}; `
        + `si la escuela lo confirma, registrar el abono por la suma (filas ${s.partes.map((p) => p.id).join(', ')}). No se aplica solo`;
}

/** Lo que se le dice a la persona cuando lo que mandó, sumado a lo anterior, alcanza: llegó y lo revisa la escuela. Pura. */
export function textoSumaDeAbonos(monto: number, s: SumaDeAbonos, delServicio: string): string {
    return `Recibí tu comprobante de *${pesos(monto)}* 📄 Con lo que enviaste antes (${s.partes.map((p) => `*${pesos(p.monto)}*`).join(' + ')}) `
        + `suman *${pesos(s.suma)}* ${delServicio}; la escuela lo revisa y te confirma por aquí.`;
}

/** El cobro previo parcial del mismo contacto: lo que ya tiene y lo que quedaría sumando este comprobante. Pura. */
export function propuestaDeCobroPrevio(e: {
    previo: { id: string; amount: number; amountPaid: number; ocrAmount: number | null; status: string }; monto: number;
}): string | null {
    const { previo, monto } = e;
    const ya = previo.status === 'partial' ? previo.amountPaid : previo.status === 'awaiting_approval' ? (previo.ocrAmount ?? 0) : 0;
    if (!(ya > 0) || !(previo.amount > 0)) return null;
    const suma = ya + monto;
    const queda = previo.amount - suma;
    return `ya tiene el cobro ${previo.id} de ${pesos(previo.amount)} con ${pesos(ya)} ${previo.status === 'partial' ? 'abonados' : 'en revisión'}: `
        + `sumando este comprobante de ${pesos(monto)} serían ${pesos(suma)}`
        + `${queda > TOLERANCIA ? ` (faltarían ${pesos(queda)})` : queda < -TOLERANCIA ? ` (${pesos(-queda)} de más)` : ' (el cobro completo)'}; `
        + 'sumarlo al mismo cobro, no crear otro';
}
