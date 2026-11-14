/**
 * A qué cobro va un comprobante según lo que la familia ESCRIBIÓ con él (el pie
 * de la foto y los textos cercanos) y si el monto cuadra.
 *
 * Casos de Dynasty del 2026-10-09 (la escuela no recibe abonos:
 * `school_settings.allow_installments = false`):
 *
 *   - Pie «… envío saldo sept 15 - oct 15 $80.000»: el único pendiente era la
 *     mensualidad de octubre por $150.000, y se le estampó el comprobante como
 *     un pago nuevo (amarillo, MONTO_DIFIERE). La escuela tuvo que adivinar.
 *   - $150.000 sin pie contra tres mensualidades de $180.000: no cuadra con
 *     ninguna. Ahí se pregunta (y no se aplica al que no es).
 *
 * Reglas:
 *   1. «Saldo», «resto», «abono»: se busca el cobro PARCIAL cuyo saldo es ese
 *      monto. El estampado del worker no toca cobros parciales, así que el
 *      abono lo aplica la escuela, con el resumen.
 *   2. El monto no cuadra con ningún cobro (ni suma de cobros, ni saldo de un
 *      parcial) y la escuela no recibe abonos: NO se aplica en silencio. Con un
 *      solo candidato, a la escuela con el resumen; con varios, se pregunta.
 *   3. El texto nombra el mes («octubre», «10/2026»): ese cobro, si cuadra.
 *      Varios cobros del mismo monto del MISMO deportista y el texto no dice
 *      cuál: el vencido MÁS ANTIGUO (la regla de la escuela, 2026-09-15). De
 *      deportistas distintos se sigue preguntando.
 *
 * Pura: quien la llama trae los cobros, los parciales y el ajuste.
 */

import { describirPago, type PagoPendiente } from './whatsapp-receipt-matching.service';
import { mesDePago, mesesDelTexto, montoEscrito } from './whatsapp-eleccion-de-pago.service';

/** Un cobro abonado: lo que falta es `amount - amount_paid`. */
export interface CobroParcial {
    id: string;
    amount: number;
    amount_paid: number | null;
    concept: string | null;
}

export type DecisionPorTexto =
    | {
        tipo: 'aplicar'; pago: PagoPendiente;
        /**
         * `recargo`: el monto es el del enlace de pago (cobro + recargo online),
         * es pago completo. `excedente`: el monto es MAYOR que el cobro; se toma
         * igual y lo de más queda como saldo a favor al aprobarse (decisión de
         * la escuela, 2026-10-13; lo registra la base, migración 20261013165308).
         */
        motivo: 'mes_del_texto' | 'mas_antiguo' | 'recargo' | 'excedente';
        /** Solo con `excedente`: lo que pagó de más. */
        excedente?: number;
    }
    | { tipo: 'preguntar'; opciones: PagoPendiente[] }
    /** No se estampa: lo aplica (o lo revisa) la escuela. */
    | { tipo: 'a_la_escuela'; resumen: string; mensaje: string; codigo: 'saldo_de_parcial' | 'monto_no_cuadra' | 'excedente_de_parcial'; pagoId: string | null }
    /** Sin opinión: sigue la lógica de siempre (monto, pista, pregunta). */
    | null;

const plano = (s: string | null | undefined) =>
    String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ').trim();

const cop = (n: number) => `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n)}`;

const SALDO_RE = /\b(saldo|resto|restante|lo que falta|lo que faltaba|abono|abonar|abone|complemento|completar|diferencia)\b/;
const HABLA_DE_PAGO_RE = /\b(pagos?|pague|pagar|comprobantes?|soportes?|transferencias?|transferi|consignacion|consigne|mensualidad|saldo|resto|abono|cuota|envio|mando|adjunto)\b/;

export interface LecturaDelComprobante {
    /** Lo que se cita en el resumen (el pie, o el primer texto que habla de pago). */
    texto: string | null;
    meses: number[];
    saldo: boolean;
    montoEscrito: number | null;
}

/**
 * Lee el pie y los textos cercanos. El pie manda; los textos del chat solo
 * cuentan si hablan de pago (si no, «el sábado de octubre hay torneo» elegiría
 * octubre).
 */
export function leerTextosDelComprobante(
    pie: string | null | undefined,
    cercanos: (string | null | undefined)[],
    pendientes: PagoPendiente[] = [],
): LecturaDelComprobante {
    const deChat = cercanos
        .map((t) => String(t ?? '').trim())
        .filter((t) => t && t !== String(pie ?? '').trim() && HABLA_DE_PAGO_RE.test(plano(t)));
    const fuentes = [String(pie ?? '').trim(), ...deChat].filter(Boolean);
    let meses: number[] = [];
    for (const f of fuentes) {
        meses = mesesDelTexto(f, pendientes);
        if (meses.length) break;
    }
    return {
        texto: fuentes[0] ? fuentes[0].replace(/\s+/g, ' ').slice(0, 160) : null,
        meses,
        saldo: fuentes.some((f) => SALDO_RE.test(plano(f))),
        montoEscrito: fuentes.map((f) => montoEscrito(f)).find((m) => m !== null) ?? null,
    };
}

/** ¿Alguna suma de cobros da el monto? (combinación de hasta 8, como `resolverPago`). */
function algunaSumaDa(pendientes: PagoPendiente[], monto: number): boolean {
    if (pendientes.length > 8) return false;
    const buscar = (i: number, resto: number, n: number): boolean => {
        if (resto === 0 && n > 1) return true;
        if (resto < 0 || i >= pendientes.length) return false;
        return buscar(i + 1, resto - pendientes[i].amount, n + 1) || buscar(i + 1, resto, n);
    };
    return buscar(0, monto, 0);
}

export function decidirCobroPorTexto(e: {
    pendientes: PagoPendiente[];
    parciales: CobroParcial[];
    /** Lo que leyó el OCR; null = no se pudo leer (no se decide por monto). */
    monto: number | null;
    lectura: LecturaDelComprobante;
    permiteAbonos: boolean;
    /**
     * Montos que valen como pago completo de cada cobro por el recargo de su
     * enlace de pago (id del cobro → montos). Ver `montosConRecargo`.
     */
    recargos?: Map<string, number[]>;
}): DecisionPorTexto {
    const { pendientes, parciales, monto, lectura } = e;
    const conRecargo = (p: PagoPendiente) => monto !== null && (e.recargos?.get(p.id) ?? []).includes(monto);
    const saldoDe = (p: CobroParcial) => Math.max(Number(p.amount) - Number(p.amount_paid ?? 0), 0);
    const cita = lectura.texto ? ` («${lectura.texto}»)` : '';

    // 1. «Envío el saldo»: el parcial cuyo saldo es ese monto.
    if (monto !== null && lectura.saldo) {
        const parcial = parciales.filter((p) => saldoDe(p) === monto);
        if (parcial.length === 1) {
            const p = parcial[0];
            return {
                tipo: 'a_la_escuela',
                codigo: 'saldo_de_parcial',
                pagoId: p.id,
                resumen: `La familia mandó ${cop(monto)} como saldo de ${p.concept ?? 'un cobro'}${cita} ` +
                    `(abonado ${cop(Number(p.amount_paid ?? 0))} de ${cop(Number(p.amount))}). ` +
                    'Es un abono a un cobro parcial: aplíquenlo desde Pagos.',
                mensaje: `Recibí tu comprobante de *${cop(monto)}* para el saldo de *${p.concept ?? 'tu cobro'}* 📄 ` +
                    'Se lo paso a la escuela para que lo aplique y te confirme.',
            };
        }
    }

    // 1a. MAYOR que el saldo de un cobro ya abonado y sin ningún pendiente que cuadre (Monster 2026-11-12, Shara:
    //     $145.000 sobre un cobro de $145.000 con $20.000 abonados). No se estampa ni se cierra con «ya registrado»:
    //     la escuela aplica el saldo y decide el excedente.
    if (monto !== null && !pendientes.some((p) => Number(p.amount) === monto)) {
        const sobre = parciales.filter((p) => monto > saldoDe(p) && saldoDe(p) > 0);
        if (sobre.length === 1) {
            const p = sobre[0];
            return {
                tipo: 'a_la_escuela',
                codigo: 'excedente_de_parcial',
                pagoId: p.id,
                resumen: `La familia mandó ${cop(monto)}${cita}; ${p.concept ?? 'un cobro'} tiene un saldo de ${cop(saldoDe(p))} ` +
                    `(abonado ${cop(Number(p.amount_paid ?? 0))} de ${cop(Number(p.amount))}). Excede el saldo en ${cop(monto - saldoDe(p))}: ` +
                    'apliquen el saldo y decidan el excedente (saldo a favor o devolución).',
                mensaje: `Recibí tu comprobante de *${cop(monto)}* 📄 Tu cobro *${p.concept ?? ''}* tenía un saldo de *${cop(saldoDe(p))}*; ` +
                    'se lo paso a la escuela para que aplique el saldo y revise la diferencia.',
            };
        }
    }

    const igual = (p: PagoPendiente) => monto !== null && Number(p.amount) === monto;
    const cuadra = (p: PagoPendiente) => igual(p) || conRecargo(p);
    const porMes = lectura.meses.length
        ? pendientes.filter((p) => { const m = mesDePago(p); return m !== null && lectura.meses.includes(m); })
        : [];

    // 1b. El monto es el del enlace de pago de UN cobro (cobro + recargo
    //     online, aunque hoy la escuela tenga otro %): pago completo de ese.
    if (monto !== null && !pendientes.some(igual)) {
        const porRecargo = pendientes.filter(conRecargo);
        const elegido = porRecargo.length === 1 ? porRecargo[0] : elMasAntiguoDelMismoDeportista(porRecargo);
        if (elegido) return { tipo: 'aplicar', pago: elegido, motivo: 'recargo' };
    }

    // 2. No cuadra con nada y la escuela no recibe abonos: no en silencio.
    const algoCuadra = monto === null
        || pendientes.some(cuadra)
        || algunaSumaDa(pendientes, monto)
        || parciales.some((p) => saldoDe(p) === monto);
    // 2a. MAYOR que el cobro al que va (el del mes que dice, el único, o el más
    //     antiguo del mismo deportista): se toma el pago igual y lo de más queda
    //     como saldo a favor (decisión de la escuela, 2026-10-13). Una suma
    //     exacta de varios cobros ya «cuadra» y la reparte quien llama.
    if (!algoCuadra && pendientes.length && monto !== null) {
        const pool = porMes.length ? porMes : pendientes;
        const destino = pool.length === 1 ? pool[0] : elMasAntiguoDelMismoDeportista(pool);
        if (destino && monto > Number(destino.amount)) {
            return { tipo: 'aplicar', pago: destino, motivo: 'excedente', excedente: monto - Number(destino.amount) };
        }
    }

    if (!algoCuadra && !e.permiteAbonos && pendientes.length) {
        const pool = porMes.length ? porMes : pendientes;
        if (pool.length > 1) return { tipo: 'preguntar', opciones: pool.slice(0, 5) };
        const p = pool[0];
        return {
            tipo: 'a_la_escuela',
            codigo: 'monto_no_cuadra',
            pagoId: p.id,
            resumen: `La familia mandó un comprobante de ${cop(monto as number)}${cita} y no cuadra con ` +
                `ningún cobro pendiente (${describirPago(p)}). La escuela no recibe abonos: ` +
                'revisen a qué corresponde antes de aplicarlo.',
            mensaje: `Recibí tu comprobante de *${cop(monto as number)}* 📄 No coincide con el valor de ` +
                `*${describirPago(p)}*, así que se lo paso a la escuela para que lo revise y te confirme.`,
        };
    }

    // 3a. El texto dice el mes y ese cobro cuadra (o la escuela recibe abonos).
    if (porMes.length === 1 && (cuadra(porMes[0]) || e.permiteAbonos)) {
        return { tipo: 'aplicar', pago: porMes[0], motivo: 'mes_del_texto' };
    }

    // 3b. Varios del mismo monto: mes del texto, o el más antiguo si son del
    //     mismo deportista. `pendientes` viene del más viejo al más nuevo.
    const exactos = pendientes.filter(igual);
    if (exactos.length > 1) {
        const delMes = exactos.filter((p) => porMes.includes(p));
        if (delMes.length === 1) return { tipo: 'aplicar', pago: delMes[0], motivo: 'mes_del_texto' };
        const masAntiguo = elMasAntiguoDelMismoDeportista(exactos);
        if (masAntiguo) return { tipo: 'aplicar', pago: masAntiguo, motivo: 'mas_antiguo' };
    }
    return null;
}

/**
 * LA regla «el más antiguo» (la de la escuela, 2026-09-15): entre varios
 * cobros del MISMO deportista, el de vencimiento más viejo. De deportistas
 * distintos (o sin saber de quién son) no se adivina: null. La usan el worker
 * (`decidirCobroPorTexto`) y la recuperación (`decidirRecuperacion`). Pura.
 */
export function elMasAntiguoDelMismoDeportista(cobros: PagoPendiente[]): PagoPendiente | null {
    if (cobros.length === 0) return null;
    const deportistas = new Set(cobros.map((p) => p.child_id ?? p.atleta ?? ''));
    if (deportistas.size !== 1 || deportistas.has('')) return null;
    return [...cobros].sort((a, b) => String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')))[0];
}

/**
 * Montos que valen como pago COMPLETO de un cobro por el recargo de su enlace
 * de pago: el `gross_amount` del enlace, y el cobro × (1 + fee_pct del ENLACE).
 * El % es el del enlace con que se creó, no el vigente de la escuela: un link
 * viejo del 5 % sigue vivo aunque hoy la escuela cobre 0 %. Sin el monto del
 * cobro mismo. Pura.
 *
 * Mora (2026-10-14): `apply_late_fees()` SUMA el recargo por mora a
 * `payments.amount`. Un enlace creado ANTES de la mora congeló la base vieja,
 * y su `gross_amount` (o base × (1 + fee)) es menos de lo que hoy se debe: un
 * comprobante por ese valor NO es pago completo. Por eso lo derivado del
 * enlace (gross y base × fee) solo vale si `base_amount` es el saldo ACTUAL
 * del cobro (`montoCobro − pagado`, tolerancia 1). Un enlace sin base o con
 * otra base aporta solo el cobro actual × (1 + su fee).
 */
export function montosConRecargo(
    montoCobro: number,
    enlaces: { gross_amount: number | string | null; base_amount?: number | string | null; fee_pct: number | string | null }[],
    /** Lo ya cubierto del cobro: `amount_paid` + descuento por pronto pago. */
    pagado = 0,
): number[] {
    const out = new Set<number>();
    const saldo = montoCobro - (Number.isFinite(Number(pagado)) ? Number(pagado) : 0);
    for (const l of enlaces) {
        const base = l.base_amount === null || l.base_amount === undefined ? NaN : Number(l.base_amount);
        const vigente = Number.isFinite(base) && Math.abs(base - saldo) <= 1;
        const fee = Number(l.fee_pct);
        if (vigente) {
            const gross = l.gross_amount === null ? NaN : Number(l.gross_amount);
            if (Number.isFinite(gross) && gross > montoCobro) out.add(Math.round(gross));
            if (Number.isFinite(fee) && fee > 0) out.add(Math.round(base * (1 + fee / 100)));
        }
        if (Number.isFinite(fee) && fee > 0) out.add(Math.round(montoCobro * (1 + fee / 100)));
    }
    out.delete(montoCobro);
    return [...out];
}
