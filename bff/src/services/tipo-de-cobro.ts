/**
 * tipo-de-cobro — de qué es un cobro y cómo se le nombra a la familia.
 *
 * Por qué existe (2026-10-10): las escuelas ya cobran, además de la
 * mensualidad, pagos ÚNICOS al inscribir (Dreamers: inscripción + seguro de
 * accidentes, `payment_type='one_time'`, `payment_category` 'inscripcion' /
 * 'seguro', mismo vencimiento que el alta). Viene una «lista de pagos únicos
 * por plan» que va a crear más categorías, así que nada de acá puede suponer
 * que solo existen inscripción y seguro: cualquier `payment_category` distinta
 * de 'mensualidad' (y de 'otro') es su propio tipo, con o sin etiqueta conocida.
 *
 * Orden de la decisión (ver memoria project_payment_type_not_reliable):
 *   1. `payment_category` específica manda (también una que todavía no
 *      conocemos: 'uniforme_gala' es 'uniforme_gala').
 *   2. Sin categoría (o 'otro'): el concepto («Mensualidad 10/2026 - …»,
 *      «Plan PRO — Mensualidad completa…», «Inscripción — …»).
 *   3. Sin pista en el concepto: `payment_type` — 'subscription' es la
 *      mensualidad (la fila mensual del alta llega con categoría NULL);
 *      'one_time' es otro cobro.
 *
 * Todo puro: sin base, sin red.
 *
 * OJO (F0, 2026-10-10): esto deduce del CONCEPTO y sirve para NOMBRAR el cobro
 * (plantillas, rótulos, recordatorios). Las REGLAS de dinero y acceso (mora,
 * recargo, bloqueo, vigencia) van SOLO por la categoría explícita:
 * `esCobroUnico` / `esMensualidadPorCategoria` / `FILTRO_SOLO_MENSUALIDAD` de
 * payment-accounts.ts, igual que la SQL (migración 20261010143132).
 */

import { categoriaDeCobro } from './payment-accounts';
import { mapaDeMotivos } from './motivos-de-cobro';

export interface CobroClasificable {
    payment_category?: string | null;
    payment_type?: string | null;
    concept?: string | null;
    period_year?: number | null;
    period_month?: number | null;
    due_date?: string | null;
}

/** La categoría del cobro. Nunca null: lo que no se sabe es 'otro'. */
export function categoriaDelCobro(c: CobroClasificable | null | undefined): string {
    const cat = String(c?.payment_category ?? '').trim().toLowerCase();
    if (cat && cat !== 'otro') return cat;
    const porConcepto = categoriaDeCobro(cat || null, c?.concept ?? null);
    if (porConcepto && porConcepto !== 'otro') return porConcepto;
    if (cat === 'otro') return 'otro';
    if (c?.payment_type === 'subscription') return 'mensualidad';
    return 'otro';
}

export function esMensualidad(c: CobroClasificable | null | undefined): boolean {
    return categoriaDelCobro(c) === 'mensualidad';
}

/** Pago único = todo lo que no es la mensualidad (inscripción, seguro, torneo, …). */
export function esPagoUnico(c: CobroClasificable | null | undefined): boolean {
    return !esMensualidad(c);
}

/**
 * Cómo se nombra cada categoría conocida (del catálogo único,
 * motivos-de-cobro.ts). Las nuevas se nombran por su clave.
 */
export const ETIQUETA_CATEGORIA: Record<string, string> = mapaDeMotivos('etiqueta');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** «octubre 2026»: el periodo del cobro; sin periodo, el mes en que vence. */
export function periodoDelCobro(c: CobroClasificable | null | undefined): string | null {
    const y = Number(c?.period_year);
    const m = Number(c?.period_month);
    if (y && m >= 1 && m <= 12) return `${MESES[m - 1]} ${y}`;
    const d = String(c?.due_date ?? '');
    if (/^\d{4}-\d{2}/.test(d)) {
        const mes = Number(d.slice(5, 7));
        if (mes >= 1 && mes <= 12) return `${MESES[mes - 1]} ${d.slice(0, 4)}`;
    }
    return null;
}

/** 'uniforme_gala' → 'Uniforme gala'. */
const humanizar = (clave: string) => {
    const t = clave.replace(/[_-]+/g, ' ').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Otro cobro';
};

/** Lo que la escuela escribió antes del primer « — » / « - » del concepto. */
const cabezaDelConcepto = (concept: string | null | undefined) =>
    String(concept ?? '').split(/\s+[—–-]\s+/)[0].replace(/\s+/g, ' ').trim();

/**
 * El nombre humano del cobro: «Mensualidad octubre 2026», «Inscripción»,
 * «Seguro de accidentes», «Torneo»… Un cobro 'otro' se nombra con el
 * comienzo de su concepto (lo que escribió la escuela), que es más útil que
 * «Otro cobro».
 */
export function etiquetaDelCobro(c: CobroClasificable | null | undefined): string {
    const cat = categoriaDelCobro(c);
    if (cat === 'mensualidad') {
        const p = periodoDelCobro(c);
        return p ? `Mensualidad ${p}` : 'Mensualidad';
    }
    if (cat === 'otro') {
        const cabeza = cabezaDelConcepto(c?.concept);
        return cabeza ? cabeza.slice(0, 60) : ETIQUETA_CATEGORIA.otro;
    }
    return ETIQUETA_CATEGORIA[cat] ?? humanizar(cat);
}

const ABREV_MES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
/** Rótulos cortos del catálogo único: la clase de prueba es «Prueba» (antes salía «Clase», igual que la clase extra). */
const CORTA: Record<string, string> = mapaDeMotivos('corta');

/**
 * Rótulo de ≤ 9 caracteres para un botón de WhatsApp (el título se corta en
 * 20): el mes de la mensualidad («Oct») o el tipo del pago único («Inscrip.»,
 * «Seguro»). null si no hay nada que decir.
 */
export function etiquetaCortaDelCobro(c: CobroClasificable | null | undefined): string | null {
    const cat = categoriaDelCobro(c);
    if (cat === 'mensualidad') {
        const m = Number(c?.period_month) || Number(String(c?.due_date ?? '').slice(5, 7));
        return m >= 1 && m <= 12 ? ABREV_MES[m - 1] : null;
    }
    return CORTA[cat] ?? humanizar(cat).split(' ')[0].slice(0, 9);
}

/** Lo que se debe de una lista de la RPC `wa_get_payment_status` (solo `debe_pagarse`). */
export function resumenDeDeuda(pagos: { debe_pagarse?: boolean | null; saldo?: unknown; amount?: unknown; amount_paid?: unknown }[] | null | undefined): {
    cantidad: number; total: number;
} {
    const pend = (Array.isArray(pagos) ? pagos : []).filter((p) => p?.debe_pagarse === true);
    const total = pend.reduce((s, p) => {
        const saldo = p.saldo !== undefined && p.saldo !== null
            ? Number(p.saldo)
            : Math.max(0, Number(p.amount ?? 0) - Number(p.amount_paid ?? 0));
        return s + (Number.isFinite(saldo) ? saldo : 0);
    }, 0);
    return { cantidad: pend.length, total };
}
