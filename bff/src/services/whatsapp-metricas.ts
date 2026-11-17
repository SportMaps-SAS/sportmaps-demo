/**
 * whatsapp-metricas — fórmulas PURAS del tablero de métricas del bot.
 *
 * Separadas de la ruta (routes/whatsapp-metricas.routes.ts) para probarlas sin
 * Express ni Supabase, igual que whatsapp-buzon.ts. Hasta el 2026-10-04 el bot
 * no tenía NINGUNA medición de si sirve: se sabía cuántos mensajes salían
 * (consumo de Meta) pero no si resolvían algo.
 *
 * Definiciones (todas sobre el rango pedido, hora de Bogotá):
 *
 *  - Saliente del BOT: `ai_generated=true` sin `aprobado_por`. Un borrador
 *    aprobado tal cual también llega con ai_generated=true, pero lo mandó una
 *    persona después de leerlo: cuenta como HUMANO.
 *  - Saliente HUMANO: echo del celular de la escuela (payload con `to`, 193
 *    filas en Dynasty el 2026-10-03), respuesta del buzón (`payload.manual`) o
 *    borrador aprobado (`payload.aprobado_por`).
 *  - Saliente AUTOMÁTICO: saludo / ausencia de la app WhatsApp Business
 *    (`payload.automatico`, o la regla de repetición de whatsapp-buzon). No es
 *    respuesta de nadie.
 *  - OTRO: saliente sin IA que no es ninguno de los anteriores (plantillas,
 *    avisos del sistema). Se cuenta en la serie pero no como respuesta.
 *  - ESCALAMIENTO: los pasos en que el bot reconoce que no puede y abre la
 *    conversación en el buzón. Se toman del saliente O del borrador (en modo
 *    asistido el aviso queda como borrador, y la escalación igual ocurrió).
 */

import { TIPOS_FAMILIA, esSalienteAutomatico } from './whatsapp-buzon';

export const DIA_MS = 24 * 3600_000;
/** Bogotá no tiene horario de verano: UTC-5 fijo todo el año. */
const OFFSET_BOGOTA_MS = -5 * 3600_000;

/**
 * Pasos del bot que equivalen a «no pude, que lo vea una persona».
 *  - escalated:            `escalate()` (pidió humano, error del modelo, tool caída).
 *  - identificacion_ambigua: número en dos cuentas, siempre llama a `escalate()`.
 *  - ask_email:            desconocido sin tema claro → `abrirEnBuzon()`.
 *  - desconocido_tema_escolar con `con_enlace=false`: prospecto sin enlace de
 *    inscripción → `abrirEnBuzon(…, prospecto)` (ver `esEscalamiento`).
 * `debe_registrarse` también deja la conversación 'open', pero ahí el bot SÍ
 * resolvió el turno (mandó el enlace de registro): no es una escalación.
 */
export const PASOS_ESCALAMIENTO: readonly string[] = ['escalated', 'identificacion_ambigua', 'ask_email'];
export const PASO_PROSPECTO = 'desconocido_tema_escolar';

export function esEscalamiento(step: string | null | undefined, conEnlace?: unknown): boolean {
    if (!step) return false;
    if (PASOS_ESCALAMIENTO.includes(step)) return true;
    return step === PASO_PROSPECTO && (conEnlace === false || conEnlace === 'false');
}

export type TipoDeEvento = 'entrante' | 'bot' | 'escalamiento' | 'humano' | 'automatico' | 'otro';

/** Lo mínimo que la ruta pide de cada mensaje (columnas + flechas de payload). */
export type MensajeCrudo = {
    id: string;
    conversation_id: string;
    direction: string;
    ai_generated?: boolean | null;
    wa_timestamp?: string | null;
    created_at?: string | null;
    step?: string | null;
    con_enlace?: unknown;
    intencion?: string | null;
    automatico?: unknown;
    to?: unknown;
    manual?: unknown;
    aprobado_por?: unknown;
};

export const momentoDe = (m: { wa_timestamp?: string | null; created_at?: string | null }) =>
    new Date(m.wa_timestamp ?? m.created_at ?? 0).getTime();

const presente = (v: unknown) => v !== null && v !== undefined && v !== false && v !== '';

/**
 * Qué fue este mensaje para las métricas. `automaticosPorRegla` son los ids que
 * `echosAutomaticos()` marcó: en Dynasty el 2026-10-04 ningún echo tenía
 * todavía `payload.automatico` (el script de limpieza no se había corrido), así
 * que sin la regla el saludo «Gracias por comunicarte…» contaría como humano y
 * bajaría el tiempo de respuesta a 1-8 s.
 */
export function tipoDeMensaje(m: MensajeCrudo, automaticosPorRegla?: Set<string>): TipoDeEvento {
    if (m.direction === 'inbound') return 'entrante';
    if (esSalienteAutomatico({ automatico: m.automatico }) || automaticosPorRegla?.has(m.id)) return 'automatico';
    if (presente(m.aprobado_por)) return 'humano';
    if (m.ai_generated === true) return esEscalamiento(m.step, m.con_enlace) ? 'escalamiento' : 'bot';
    if (presente(m.to) || presente(m.manual)) return 'humano';
    return 'otro';
}

export type Evento = { t: number; tipo: TipoDeEvento };

export type ResultadoConversacion = {
    tuvoEntrante: boolean;
    tuvoBot: boolean;
    tuvoHumano: boolean;
    escalada: boolean;
    /** ms desde que la familia quedó esperando a una persona hasta que una respondió. */
    esperas: number[];
};

/**
 * Recorre UNA conversación en orden y decide qué pasó.
 *
 * La espera por una persona arranca en el PRIMER entrante que nadie atendió
 * (desde la última respuesta de quien sea), porque es cuando la familia empezó
 * a esperar, y se cierra con la primera respuesta humana:
 *   - si el bot contestó (sin escalar), ese entrante queda atendido;
 *   - si el bot escaló, la espera sigue abierta aunque el bot haya dicho «ya le
 *     aviso a la escuela»: eso no es una respuesta;
 *   - si no hubo bot (apagado, o contacto que no atiende), la espera es desde
 *     el entrante hasta el echo/buzón.
 * Una espera sin respuesta humana al final del rango no entra al tiempo: la
 * cuenta `sin responder >24 h`.
 */
export function analizarConversacion(eventos: Evento[]): ResultadoConversacion {
    const r: ResultadoConversacion = { tuvoEntrante: false, tuvoBot: false, tuvoHumano: false, escalada: false, esperas: [] };
    const orden = [...eventos].sort((a, b) => a.t - b.t);
    let entranteSinAtender: number | null = null;
    let esperaDesde: number | null = null;

    for (const e of orden) {
        switch (e.tipo) {
            case 'entrante':
                r.tuvoEntrante = true;
                if (entranteSinAtender === null && esperaDesde === null) entranteSinAtender = e.t;
                break;
            case 'escalamiento':
                r.escalada = true;
                if (esperaDesde === null) esperaDesde = entranteSinAtender ?? e.t;
                entranteSinAtender = null;
                break;
            case 'bot':
                r.tuvoBot = true;
                if (esperaDesde === null) entranteSinAtender = null;
                break;
            case 'humano': {
                r.tuvoHumano = true;
                const inicio = esperaDesde ?? entranteSinAtender;
                if (inicio !== null) r.esperas.push(Math.max(0, e.t - inicio));
                esperaDesde = null;
                entranteSinAtender = null;
                break;
            }
            default:
                // automatico / otro: no es respuesta de nadie.
                break;
        }
    }
    return r;
}

export type DesenlaceFamilia = 'solo_bot' | 'escalada' | 'humano' | 'sin_respuesta';

/**
 * Partición de las conversaciones de familia con al menos un entrante:
 *   solo_bot      → el bot respondió y no hubo humano ni escalación.
 *   escalada      → el bot escaló (haya respondido o no alguien después).
 *   humano        → respondió una persona sin que el bot escalara.
 *   sin_respuesta → nadie dijo nada (ni bot, ni persona).
 */
export function desenlace(r: ResultadoConversacion): DesenlaceFamilia | null {
    if (!r.tuvoEntrante) return null;
    if (r.escalada) return 'escalada';
    if (r.tuvoHumano) return 'humano';
    if (r.tuvoBot) return 'solo_bot';
    return 'sin_respuesta';
}

/** Percentil con interpolación lineal (p entre 0 y 1). null si no hay datos. */
export function percentil(valores: number[], p: number): number | null {
    if (!valores.length) return null;
    const v = [...valores].sort((a, b) => a - b);
    const pos = (v.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export const esFamilia = (kind: string | null | undefined) =>
    !!kind && (TIPOS_FAMILIA as readonly string[]).includes(kind);

/** Día calendario en Bogotá (YYYY-MM-DD) de un instante en ms. */
export function diaBogota(t: number): string {
    return new Date(t + OFFSET_BOGOTA_MS).toISOString().slice(0, 10);
}

export type PuntoSerie = {
    dia: string; entrantes: number; bot: number; humano: number; automatico: number; otro: number;
};

/** Serie diaria con TODOS los días del rango (los vacíos en cero, para que la gráfica no salte). */
export function serieDiaria(eventos: { t: number; tipo: TipoDeEvento }[], desde: number, hasta: number): PuntoSerie[] {
    const dias = new Map<string, PuntoSerie>();
    for (let t = desde; diaBogota(t) <= diaBogota(hasta); t += DIA_MS) {
        const d = diaBogota(t);
        dias.set(d, { dia: d, entrantes: 0, bot: 0, humano: 0, automatico: 0, otro: 0 });
    }
    for (const e of eventos) {
        const p = dias.get(diaBogota(e.t));
        if (!p) continue;
        if (e.tipo === 'entrante') p.entrantes++;
        else if (e.tipo === 'bot' || e.tipo === 'escalamiento') p.bot++;
        else if (e.tipo === 'humano') p.humano++;
        else if (e.tipo === 'automatico') p.automatico++;
        else p.otro++;
    }
    return [...dias.values()];
}

/** Rango por defecto y máximo. 180 días alcanza para comparar trimestres sin abrir la puerta a barridos enormes. */
export const DIAS_POR_DEFECTO = 30;
export const DIAS_MAXIMO = 180;

/**
 * 'YYYY-MM-DD' es un día de Bogotá: `desde` = 00:00 y `hasta` = 23:59:59.999
 * de ese día. Cualquier otra cosa se interpreta como instante ISO.
 */
export function leerRango(desdeQ: unknown, hastaQ: unknown, ahora = Date.now()):
    { desde: number; hasta: number } | { error: string } {
    const leer = (v: unknown, finDeDia: boolean): number | null | undefined => {
        if (v === undefined || v === null || v === '') return undefined;
        const s = String(v);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
            const t = Date.parse(`${s}T00:00:00-05:00`);
            return Number.isNaN(t) ? null : (finDeDia ? t + DIA_MS - 1 : t);
        }
        const t = Date.parse(s);
        return Number.isNaN(t) ? null : t;
    };
    const h = leer(hastaQ, true);
    const d = leer(desdeQ, false);
    if (h === null || d === null) return { error: 'fecha_invalida' };
    const hasta = Math.min(h ?? ahora, ahora);
    const desde = d ?? hasta - DIAS_POR_DEFECTO * DIA_MS;
    if (desde >= hasta) return { error: 'rango_invalido' };
    if (hasta - desde > DIAS_MAXIMO * DIA_MS) return { error: 'rango_demasiado_largo' };
    return { desde, hasta };
}

// ─── Comprobantes ───────────────────────────────────────────────────────────

export type ClaseComprobante =
    | 'aprobado_solo' | 'aprobado_por_escuela' | 'esperando_revision' | 'rechazado'
    | 'escalado' | 'fallido' | 'esperando_familia' | 'ignorado' | 'matricula' | 'en_proceso';

/**
 * Qué pasó con una fila de `whatsapp_inbound_queue`.
 *
 * `done` + `payment_receipt` = el bot aplicó el comprobante a un cobro. Si el
 * pago quedó `paid` sin `approved_by`, lo aprobó el auto-aprobador; con
 * `approved_by`, una persona; `awaiting_approval` espera a la escuela (3 de 4
 * en Dynasty el 2026-10-04). `done` con otro result_type es la hoja de
 * matrícula (enrollment_form_intake), que no es un comprobante.
 */
export function clasificarComprobante(
    fila: { status: string; result_type?: string | null },
    pago?: { status?: string | null; approved_by?: string | null } | null,
): ClaseComprobante {
    if (fila.status === 'pending' || fila.status === 'processing') return 'en_proceso';
    if (fila.status === 'waiting_user') return 'esperando_familia';
    if (fila.status === 'failed') return 'fallido';
    // (2026-11-16) `result_type = payment_receipt` es «el bot lo aplicó a un cobro» sin importar el estado de la fila:
    // cuando el monto leído difiere del cobro, o la familia reclamó el resultado, la fila queda `ignored` (para verse en
    // la bandeja) pero el comprobante SIGUE en el cobro. Contarla como «ignorada» escondía pagos aplicados.
    if (fila.status === 'ignored' && fila.result_type !== 'payment_receipt') return fila.result_type === 'escalated' ? 'escalado' : 'ignorado';
    if (fila.status === 'ignored' && fila.result_type !== 'payment_receipt') return fila.result_type === 'escalated' ? 'escalado' : 'ignorado';
    if ((fila.status === 'done' || fila.status === 'ignored') && fila.result_type === 'payment_receipt') {
        const s = pago?.status ?? null;
        if (s === 'paid' || s === 'approved' || s === 'completed') {
            return pago?.approved_by ? 'aprobado_por_escuela' : 'aprobado_solo';
        }
        if (s === 'rejected') return 'rechazado';
        return 'esperando_revision';
    }
    if (fila.status === 'done') return 'matricula';
    return 'en_proceso';
}

/** «referencia ya usada: 123» → «referencia ya usada», para agrupar motivos. */
export function motivoCorto(error: string | null | undefined): string {
    const m = (error ?? '').split(':')[0].trim();
    return m || 'sin motivo';
}

// ─── Teléfonos ──────────────────────────────────────────────────────────────

/**
 * Formas en que un número de WhatsApp colombiano ('573001234567') puede estar
 * guardado en `profiles.phone` / `school_signup_leads.phone`. Medido el
 * 2026-10-04: 409 '+57XXXXXXXXXX', 310 'XXXXXXXXXX', 1 '57XXXXXXXXXX', 29 con
 * otro formato (espacios, guiones) que no se cruzan.
 */
export function variantesDeTelefono(waId: string): string[] {
    const d = (waId ?? '').replace(/\D/g, '');
    if (!d) return [];
    const local = d.startsWith('57') && d.length === 12 ? d.slice(2) : d;
    return [...new Set([d, `+${d}`, local, `+57${local}`, `57${local}`])];
}
