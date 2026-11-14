/**
 * whatsapp-plan-comun — piezas puras compartidas por «pagar por plazos» y por
 * «pausar / retirar / reactivar el plan» desde WhatsApp
 * (docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §5 y §6).
 *
 * Todo lo de acá es PURO (sin base, sin Meta): fechas, meses en español, dinero,
 * lectura de «sí / no», y el estado del paso a paso. El estado viaja en el payload
 * de cada saliente del bot (igual que la clase de cortesía): `flujo`, `paso_plan`,
 * `datos_plan`. Un saliente SIN `flujo` cierra el flujo.
 *
 * Reglas del bot que se respetan acá: español tuteando; nada de mora, deuda,
 * atraso, multa ni recargo; nunca «gratis».
 */

import { normalizarFrase, type FilaReciente } from './whatsapp-reglas-turno';

// ─── Estado del paso a paso ──────────────────────────────────────────────────

export const FLUJO_PLAN = 'plan_whatsapp';
/** Cada confirmación (y cada paso) vence a los 30 minutos. */
export const VIGENCIA_MS = 30 * 60_000;

export type PasoPlan =
    | 'plazos_cobros' | 'plazos_cuotas' | 'plazos_confirmar'
    | 'plan_tipo' | 'plan_inscripcion' | 'plan_meses' | 'plan_fecha' | 'plan_confirmar'
    | 'plan_cancelar_confirmar';

export interface EstadoPlan {
    paso: PasoPlan;
    datos: Record<string, any>;
}

const t = (f: FilaReciente): number => new Date(f.wa_timestamp || f.created_at || 0).getTime();

/**
 * El estado abierto: el ÚLTIMO saliente de la conversación (el más nuevo) es del
 * flujo. Si el bot dijo cualquier otra cosa después, el flujo está cerrado.
 * `enviadoMs` es la marca del propio mensaje (o `t0`, la del primer resumen): ahí empiezan los 30 min.
 */
export function estadoAbierto(recientes: FilaReciente[]): { estado: EstadoPlan; enviadoMs: number } | null {
    const salientes = recientes.filter((f) => f.direction === 'outbound');
    if (!salientes.length) return null;
    const ultimo = salientes.reduce((a, b) => (t(b) > t(a) ? b : a));
    const p = ultimo.payload;
    if (!p || p.flujo !== FLUJO_PLAN || !p.paso_plan) return null;
    const enviadoMs = t(ultimo);
    const inicio = Number(p.datos_plan?.t0) || enviadoMs;
    return {
        estado: { paso: p.paso_plan as PasoPlan, datos: p.datos_plan ?? {} },
        // El reloj corre desde el primer resumen (t0) y desde el último mensaje: gana el más viejo.
        enviadoMs: Math.min(enviadoMs || inicio, inicio),
    };
}

export function haVencido(enviadoMs: number, ahora: number): boolean {
    return !(enviadoMs > 0) ? false : ahora - enviadoMs > VIGENCIA_MS;
}

// ─── Sí / no ─────────────────────────────────────────────────────────────────

export const BOTON_PLAN = { SI: 'plan_si', NO: 'plan_no' } as const;
/** Respaldo en texto de los botones (modo asistido: el buzón los aprueba como texto). */
export const EN_TEXTO_CONFIRMAR = 'Responde *Sí, confirmo* o *No*.';

const SI_EXACTO = /^(si|sii+|sip|claro|dale|listo|ok|okey|okay|confirmo|confirmado|confirmada|correcto|exacto|adelante|perfecto|hagale|de una|de acuerdo|asi es|si por favor|si claro|si dale|si confirmo|si confirmo por favor|si listo|si correcto|si adelante|ok confirmo|dale confirmo|listo confirmo|si procede|procede|proceda|proceder|si procedo|si crealo|si hazlo|hazlo|si gracias)$/;
const NO_EXACTO = /^(no|nop|nel|nada|cancelar|cancela|cancelalo|mejor no|no gracias|no por ahora|no ya no|dejalo asi|dejalo|olvidalo|olvida eso|no lo hagas|no confirmo|no quiero|ya no|no mejor no)$/;

/** «Sí» EXPLÍCITO: el mensaje completo es una afirmación. «Sí, pero…» no cuenta. */
export function esSiExplicito(texto: string | null | undefined, botonId?: string | null): boolean {
    if (botonId === BOTON_PLAN.SI) return true;
    if (botonId) return false;
    const n = normalizarFrase(texto);
    return SI_EXACTO.test(n);
}

export function esNoExplicito(texto: string | null | undefined, botonId?: string | null): boolean {
    if (botonId === BOTON_PLAN.NO) return true;
    if (botonId) return false;
    return NO_EXACTO.test(normalizarFrase(texto));
}

// ─── Dinero y fechas (formato) ───────────────────────────────────────────────

export function pesos(n: number): string {
    const s = String(Math.round(Math.abs(n)));
    return `$${s.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

export const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** 'YYYY-MM-DD' → «15 de diciembre» (con año si no es el actual). */
export function fechaLarga(f: string, hoy: string): string {
    const [y, m, d] = f.split('-').map(Number);
    const base = `${d} de ${MESES[m - 1]}`;
    return String(y) === hoy.slice(0, 4) ? base : `${base} de ${y}`;
}

/** 'YYYY-MM-01' o 'YYYY-MM' → «diciembre de 2026». */
export function mesLargo(f: string): string {
    const [y, m] = f.split('-').map(Number);
    return `${MESES[m - 1]} de ${y}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
const diasDelMes = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function sumarDias(fecha: string, dias: number): string {
    const d = new Date(`${fecha}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
}

/** Mes (1-12) nombrado en el texto, en orden de aparición. Pura. */
export function mesesNombrados(texto: string | null | undefined): number[] {
    const n = normalizarFrase(texto).replace(/\bsetiembre\b/g, 'septiembre');
    const re = new RegExp(`\\b(${MESES.join('|')})\\b`, 'g');
    const out: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(n))) out.push(MESES.indexOf(m[1]) + 1);
    return out;
}

/**
 * Año de un mes nombrado. Del mes actual en adelante: este año. Un mes que acaba de
 * pasar (hasta 3 atrás) se queda en este año, para que se vea como PASADO y se
 * vuelva a preguntar en vez de saltar un año entero; más atrás, es el del próximo año
 * («enero» dicho en noviembre).
 */
export function anioDeMes(mes: number, hoy: string): number {
    const y = Number(hoy.slice(0, 4));
    const diff = mes - Number(hoy.slice(5, 7));
    return diff >= -3 ? y : y + 1;
}

export type RangoMeses =
    | { ok: true; desde: string; hasta: string; meses: number }
    | { ok: false; motivo: 'sin_meses' | 'no_contiguos' };

/**
 * Meses de una pausa: «diciembre», «diciembre y enero», «de diciembre a febrero»,
 * «desde enero hasta marzo». Devuelve 'YYYY-MM-01' desde/hasta. Si los meses
 * nombrados no son seguidos («diciembre y febrero») NO adivina: pide aclarar. Pura.
 */
export function rangoDeMeses(texto: string | null | undefined, hoy: string): RangoMeses {
    const nombrados = mesesNombrados(texto);
    if (!nombrados.length) return { ok: false, motivo: 'sin_meses' };
    const n = normalizarFrase(texto);
    // Orden cronológico real (a partir de este mes).
    const abs = nombrados.map((m) => {
        const y = anioDeMes(m, hoy);
        return y * 12 + (m - 1);
    });
    const unicos = [...new Set(abs)].sort((a, b) => a - b);
    const hayRango = /\b(a|hasta|al)\b/.test(n) && /\b(de|desde|del)\b/.test(n) && unicos.length >= 2;
    const primero = unicos[0];
    const ultimo = unicos[unicos.length - 1];
    if (!hayRango && ultimo - primero + 1 !== unicos.length) return { ok: false, motivo: 'no_contiguos' };
    const fmt = (a: number) => `${Math.floor(a / 12)}-${pad((a % 12) + 1)}-01`;
    return { ok: true, desde: fmt(primero), hasta: fmt(ultimo), meses: ultimo - primero + 1 };
}

/** Primer día del mes siguiente a `hoy` ('YYYY-MM-01'). */
export function mesSiguiente(hoy: string): string {
    const y = Number(hoy.slice(0, 4));
    const m = Number(hoy.slice(5, 7));
    return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}

export function primerDiaDelMes(hoy: string): string {
    return `${hoy.slice(0, 7)}-01`;
}

/**
 * Fecha de salida de un retiro: «hoy», «mañana», «fin de mes», «30 de noviembre»,
 * «el 5 de diciembre», «desde diciembre» (= primer día). null si no se entiende o ya pasó. Pura.
 */
export function fechaDeSalida(texto: string | null | undefined, hoy: string): { ok: true; fecha: string } | { ok: false; motivo: 'sin_fecha' | 'pasada' } {
    const n = normalizarFrase(texto);
    const y = Number(hoy.slice(0, 4));
    const m = Number(hoy.slice(5, 7));
    let f: string | null = null;
    if (/\bhoy\b/.test(n)) f = hoy;
    else if (/\b(pasado manana)\b/.test(n)) f = sumarDias(hoy, 2);
    else if (/\bmanana\b/.test(n)) f = sumarDias(hoy, 1);
    else if (/\b(fin|finales|final|ultimo dia) (de|del) (este )?mes\b/.test(n) || /\bfin de mes\b/.test(n)) f = `${y}-${pad(m)}-${pad(diasDelMes(y, m))}`;
    else if (/\b(este mes)\b/.test(n)) f = `${y}-${pad(m)}-${pad(diasDelMes(y, m))}`;
    else if (/\b(proximo mes|mes que viene|mes siguiente)\b/.test(n)) f = mesSiguiente(hoy);
    if (!f) {
        const conDia = new RegExp(`\\b(\\d{1,2}) de (${MESES.join('|')})\\b`).exec(n);
        if (conDia) {
            const d = Number(conDia[1]);
            const mes = MESES.indexOf(conDia[2]) + 1;
            const anio = anioDeMes(mes, hoy);
            if (d >= 1 && d <= diasDelMes(anio, mes)) f = `${anio}-${pad(mes)}-${pad(d)}`;
        } else {
            const solo = mesesNombrados(n);
            if (solo.length === 1) f = `${anioDeMes(solo[0], hoy)}-${pad(solo[0])}-01`;
        }
    }
    if (!f) return { ok: false, motivo: 'sin_fecha' };
    if (f < hoy) return { ok: false, motivo: 'pasada' };
    return { ok: true, fecha: f };
}

/** Número 1..max escrito como cifra o palabra («dos», «tres»). null si no es. */
const PALABRAS_NUM: Record<string, number> = {
    un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
};
export function numeroEscrito(palabra: string): number | null {
    if (/^\d{1,2}$/.test(palabra)) return Number(palabra);
    return PALABRAS_NUM[palabra] ?? null;
}

/** Palabras que NO deben aparecer en ningún texto del flujo. */
export const PALABRAS_PROHIBIDAS = /\b(mora|moroso|morosa|deuda|deudor|atraso|atrasad[oa]s?|vencid[oa]s?|vencimiento|multa|recargo|gratis|gratuit[oa])\b/i;

/** Un solo mensaje para cada «no entendí» y para cada cierre: textos fijos. */
export const TXT = {
    noEntendi: 'No alcancé a entenderte 🙏',
    cancelado: 'Listo, no hice nada. Si más adelante quieres retomarlo, me escribes por aquí.',
    vencida: 'Esa confirmación venció (pasaron más de 30 minutos) y no hice nada. Si quieres, lo retomamos desde el principio: cuéntame qué necesitas.',
    revisaEscuela: 'Esto lo va a revisar la escuela. Dejo tu mensaje en su buzón y te escriben por aquí 🙏',
} as const;
