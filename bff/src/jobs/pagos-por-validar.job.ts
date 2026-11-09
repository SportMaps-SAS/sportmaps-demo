/**
 * pagos-por-validar.job — resumen diario de «Pagos por validar» para el dueño y
 * los admins de cada escuela que tenga comprobantes esperando.
 *
 * Por qué (2026-11-08): Monster´s Volley Club tenía 33 comprobantes en
 * `awaiting_approval` (unos 20 en verde, varios de hace días) y el dueño entró a
 * la app sin aprobar ninguno. El aviso de comprobantes (receipt-review-alerts)
 * es solo in-app + push y se pierde entre las notificaciones del día. Este job
 * manda UN resumen por escuela y tramo:
 *
 *   · 07:30 COT ('manana'): solo si hay pagos por validar.
 *   · 17:00 COT ('tarde'): recordatorio extra solo si alguno lleva más de 48 h.
 *
 * Contenido: cuántos son y cuánto suman (saldo por cubrir), cuántos están en
 * verde y cuántos entran en «Aprobar todos los verdes» (misma regla que
 * `greenExclusion` + grupos de `bulkGreenSelection` en
 * frontend/src/lib/receiptReview.ts), el más antiguo y el desglose por tipo
 * (mismas claves y etiquetas que el filtro «Tipo» de Gestión de pagos,
 * frontend/src/lib/tipoDeCobro.ts; la prueba de contrato lo compara).
 *
 * Canales:
 *   (a) correo con el layout branded (`BrandedEmailTemplates.pagosPorValidar`),
 *       por la edge function send-email, en un solo lote por escuela;
 *   (b) notificación in-app: INSERT en `notifications` con service_role,
 *       category 'payment' y type 'payment' (los mismos del aviso de
 *       comprobantes). El despachador la convierte en push. `data` NO lleva
 *       `amount`: Modo Recepción lo sumaría al recaudo del día;
 *   (c) WhatsApp de plataforma: listo pero APAGADO detrás de
 *       PAGOS_POR_VALIDAR_WA_ENABLED (ver plataforma-wa-avisos.service: qué
 *       más hace falta para encenderlo).
 *
 * Aprobación automática (2026-11-08): con `school_settings.auto_approve_enabled`
 * los verdes que siguen en la cola son los que NO se aprobaron solos (tope,
 * PDF, monto elegido por el navegador, lecturas que no coinciden, o llegaron
 * antes de encenderla). El resumen dice cuántos son y pide revisarlos: no
 * invita a «Aprobar todos los verdes». Sin aprobación automática la menciona,
 * pero después de revisarlos.
 *
 * Pronto pago: el saldo es amount − amount_paid − early_payment_discount_applied
 * (utils/saldo-cobro, igual que `remainingOf` del frontend): un comprobante de
 * $137.750 sobre $145.000 con $7.250 de descuento está completo.
 *
 * Destinatarios: `schools.owner_id` + `school_members` activos con rol
 * owner/admin/school_admin (mismo criterio que receipt-review-alerts; nunca
 * coach). Solo escuelas `account_type = 'real'` y `is_demo = false`; se excluyen
 * los perfiles `is_demo`.
 *
 * Idempotencia SIN migración: una reserva en `email_sends` con id determinístico
 * por escuela + día de Colombia + tramo
 * (`pagos_por_validar:<school_id>:<YYYY-MM-DD>:<manana|tarde>`). El PK hace de
 * candado para LOS TRES canales: solo el proceso que reserva avisa. Un reinicio
 * del BFF o varios BFF corriendo el mismo cron no duplican. Si la escuela no
 * tiene correo, la reserva igual se escribe (cerrada como 'failed' con el
 * motivo) para que el aviso in-app tampoco se repita.
 *
 * Disk IO: UNA lectura de `payments` para todas las escuelas (índice
 * idx_payments_status) y lecturas en lote (`.in`) de escuelas, periodos ya
 * pagados, reservas, miembros y perfiles. Nada por escuela salvo las escrituras.
 *
 * Dónde corre: `pagosPorValidarActivo` (solo NODE_ENV=production), dentro de
 * initMaintenanceJobs, que ya exige Render (debenCorrerLosCrons) y respeta
 * CRONS_ENABLED=false.
 *
 * Enlaces con origen FIJO de producción: el .env local trae
 * FRONTEND_URL=http://localhost:5173 y un script con service role lo heredaría
 * (memoria feedback_scripts_correo_frontend_url_localhost).
 */

import type { Logger } from 'pino';
import { supabase } from '../config/supabase';
import { esMotivo } from '../services/motivos-de-cobro';
import { categoriaDeCobro } from '../services/payment-accounts';
import {
    cerrarEnvio, enviarPlantilla, fechaColombia, horaColombia, reservarEnvio, uuidDeClave,
} from '../services/avisos-correo.service';
import { avisarPagosPorValidarPorPlataforma } from '../services/plataforma-wa-avisos.service';
import { saldoPorCobrar } from '../utils/saldo-cobro';
import { BrandedEmailTemplates } from '../utils/emailTemplates';
import { formatoEspera } from './receipt-review-alerts.job';

export const TIPO_CORREO = 'pagos_por_validar';
/** Origen fijo de producción. Nunca `env.FRONTEND_URL`. */
export const ORIGEN_APP = 'https://app.sportmaps.co';
export const URL_PANEL = `${ORIGEN_APP}/payments-automation`;
/** El mismo enlace del aviso de comprobantes (pestaña «Cobros», la que abre por defecto). */
export const LINK_IN_APP = '/payments-automation?tab=recurrent';
export const UMBRAL_TARDE_MS = 48 * 3600_000;
export const ROLES_DESTINO = ['owner', 'admin', 'school_admin'] as const;
const LIMITE = 5000;
/** Misma tolerancia que la hoja de aprobación y `greenExclusion` (0,5 %). */
const TOLERANCIA_MONTO = 0.005;

export type Tramo = 'manana' | 'tarde';

/**
 * ¿Corre el cron en este proceso? Ya está dentro de initMaintenanceJobs (solo
 * Render, salvo CRONS_LOCALES=true, y nunca con CRONS_ENABLED=false). Además:
 *
 *   · DISABLE_PAGOS_POR_VALIDAR=true lo apaga (kill-switch, como los demás).
 *   · Solo NODE_ENV=production. render.yaml fija development / staging /
 *     production por servicio, y sportmaps-bff-dev NO tiene CRONS_ENABLED=false
 *     (los puentes de GYM RM y Dreamers siguen colgados de él): sin esto, el
 *     resumen saldría desde dev con el código de develop antes de llegar a main.
 *   · PAGOS_POR_VALIDAR_FUERA_DE_PROD=true lo permite fuera de producción, para
 *     probarlo a propósito.
 *
 * Aun si corrieran dos, la reserva en email_sends deja pasar a uno solo. Pura.
 */
export function pagosPorValidarActivo(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.DISABLE_PAGOS_POR_VALIDAR === 'true') return false;
    if (env.NODE_ENV === 'production') return true;
    return env.PAGOS_POR_VALIDAR_FUERA_DE_PROD === 'true';
}

// ─── Tipo de cobro (espejo de frontend/src/lib/tipoDeCobro.ts) ───────────────

export type ClaveTipo =
    | 'mensualidad' | 'inscripcion' | 'clase_prueba' | 'clinica' | 'clase_extra' | 'torneo'
    | 'vacacional' | 'articulos' | 'seguro' | 'viaje' | 'excedente' | 'reserva' | 'otro';

/** Orden del filtro de Gestión de pagos: lo de todos los meses primero, «Otro» al final. */
export const ORDEN_TIPOS: readonly ClaveTipo[] = [
    'mensualidad', 'inscripcion', 'clase_prueba', 'clinica', 'clase_extra', 'torneo',
    'vacacional', 'articulos', 'seguro', 'viaje', 'excedente', 'reserva', 'otro',
];

/** = ETIQUETA_TIPO_DE_COBRO del frontend. */
export const ETIQUETA_TIPO: Record<ClaveTipo, string> = {
    mensualidad: 'Mensualidad',
    inscripcion: 'Inscripción / Matrícula',
    clase_prueba: 'Clase de prueba',
    clinica: 'Clínica',
    clase_extra: 'Clase extra',
    torneo: 'Torneo',
    vacacional: 'Vacacional',
    articulos: 'Uniformes / Artículos',
    seguro: 'Seguro',
    viaje: 'Viaje',
    excedente: 'Horas adicionales',
    reserva: 'Reserva',
    otro: 'Otro',
};

/** Etiqueta del desglose = la del filtro (`etiquetaDeFiltro`): la cortesía comparte clave con la clase de prueba. */
export const etiquetaDeDesglose = (clave: ClaveTipo): string =>
    clave === 'clase_prueba' ? 'Clase de prueba / cortesía' : ETIQUETA_TIPO[clave];

const normalizar = (s: string): string =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const nombraClinica = (texto: string) => /clinica/.test(texto);

function claveDesdeConcepto(texto: string): ClaveTipo | null {
    if (/clase de (prueba|cortesia)/.test(texto)) return 'clase_prueba';
    if (nombraClinica(texto)) return 'clinica';
    // Antes que la inscripción: «Inscripción torneo» es plata del torneo.
    if (/torneo/.test(texto)) return 'torneo';
    if (/vacacional/.test(texto)) return 'vacacional';
    if (/\bviaje\b/.test(texto)) return 'viaje';
    if (/horas? adicional/.test(texto)) return 'excedente';
    return null;
}

/**
 * Qué es el cobro, con la misma decisión que `tipoDeCobro().clave` del frontend:
 * la categoría manda (la clínica viaja como 'clase_extra' y se reconoce por el
 * concepto), y sin categoría (o 'otro') decide el concepto. NULL sin pistas =
 * mensualidad. SOLO para mostrar: no decide reglas de dinero. Pura.
 */
export function tipoDeCobro(p: { payment_category?: string | null; concept?: string | null }): ClaveTipo {
    const cat = p.payment_category ?? null;
    const texto = normalizar(String(p.concept ?? ''));
    if (cat && cat !== 'otro') {
        if (cat === 'clase_extra') return nombraClinica(texto) ? 'clinica' : 'clase_extra';
        return esMotivo(cat) ? cat : 'otro';
    }
    const porConcepto = claveDesdeConcepto(texto);
    if (porConcepto) return porConcepto;
    const vieja = categoriaDeCobro(cat, p.concept ?? null);
    if (vieja) return vieja;
    return cat === 'otro' ? 'otro' : 'mensualidad';
}

// ─── Pagos y resumen ─────────────────────────────────────────────────────────

export interface PagoPorValidar {
    id: string;
    school_id: string;
    amount: number;
    amount_paid: number;
    /** Pronto pago congelado en el cobro: la familia transfiere amount − esto. */
    early_payment_discount_applied: number;
    concept: string | null;
    payment_category: string | null;
    receipt_verdict: string | null;
    receipt_url: string | null;
    ocr_amount: number | null;
    requires_review: boolean;
    child_id: string | null;
    period_year: number | null;
    period_month: number | null;
    /** Cuándo entró el comprobante (ISO): el mismo criterio que receipt-review-alerts. */
    enviado_en: string;
}

/** Lo que falta por cubrir del cobro: amount − abonos − pronto pago (utils/saldo-cobro). Pura. */
export const saldo = (p: Pick<PagoPorValidar, 'amount' | 'amount_paid'> & { early_payment_discount_applied?: number | null }): number =>
    saldoPorCobrar(p);

export const clavePeriodo = (childId: string, year: number, month: number) => `${childId}|${year}|${month}`;

export interface ContextoVerdes {
    /** receipt_url que comparten 2+ cobros de la cola (un comprobante, varios meses). */
    compartidos: Set<string>;
    /** `child|año|mes` ya pagados por OTRO cobro (period_already_settled del frontend). */
    periodosPagados: Set<string>;
}

/** Comprobantes ligados a 2 o más cobros de la lista. Pura. */
export function comprobantesCompartidos(pagos: readonly Pick<PagoPorValidar, 'receipt_url'>[]): Set<string> {
    const vistos = new Map<string, number>();
    for (const p of pagos) if (p.receipt_url) vistos.set(p.receipt_url, (vistos.get(p.receipt_url) ?? 0) + 1);
    return new Set([...vistos].filter(([, n]) => n >= 2).map(([url]) => url));
}

/**
 * ¿Entra en «Aprobar todos los verdes»? Espejo de `greenExclusion` y de la regla
 * de grupos de `bulkGreenSelection` (frontend/src/lib/receiptReview.ts).
 * Devuelve el motivo de exclusión, o null si entra. Pura.
 */
export function exclusionVerde(p: PagoPorValidar, ctx: ContextoVerdes): string | null {
    if (p.receipt_verdict !== 'verde') return 'no está en verde';
    if (!p.receipt_url) return 'sin comprobante';
    if (ctx.compartidos.has(p.receipt_url)) return 'el comprobante cubre varios cobros';
    if ((Number(p.amount_paid) || 0) > 0) return 'tiene abonos previos';
    if (p.requires_review) return 'tiene un intento de pasarela en revisión';
    if (p.child_id && p.period_year && p.period_month
        && ctx.periodosPagados.has(clavePeriodo(p.child_id, p.period_year, p.period_month))) return 'ese mes ya estaba pagado';
    const restante = saldo(p);
    if (p.ocr_amount == null || restante <= 0) return 'sin monto leído';
    if (Math.abs(Number(p.ocr_amount) - restante) / restante > TOLERANCIA_MONTO) return 'el monto leído no coincide';
    return null;
}

export interface LineaDesglose { clave: ClaveTipo; etiqueta: string; cantidad: number; monto: number }

export interface ResumenPagos {
    schoolId: string;
    total: number;
    /** Suma de saldos por cubrir. */
    monto: number;
    verdes: number;
    /** Los que entran en «Aprobar todos los verdes». */
    verdesUnClic: number;
    /** Verdes que NO entran, por motivo (para el simulacro y el log). */
    verdesExcluidos: Record<string, number>;
    /** Cuándo entró el más antiguo (ISO). */
    masAntiguo: string | null;
    esperaMasAntiguoMs: number;
    /** Cuántos llevan más de 48 h. */
    masDe48h: number;
    /** Por tipo, de más a menos cobros (empates en el orden del filtro). */
    desglose: LineaDesglose[];
}

/** El resumen de UNA escuela. Pura. */
export function armarResumen(
    schoolId: string, pagos: readonly PagoPorValidar[], ahora: number, periodosPagados: Set<string> = new Set(),
): ResumenPagos {
    const ctx: ContextoVerdes = { compartidos: comprobantesCompartidos(pagos), periodosPagados };
    const porTipo = new Map<ClaveTipo, LineaDesglose>();
    let monto = 0;
    let verdes = 0;
    let verdesUnClic = 0;
    const verdesExcluidos: Record<string, number> = {};
    let masDe48h = 0;
    let masAntiguo: number | null = null;
    for (const p of pagos) {
        const s = saldo(p);
        monto += s;
        if (p.receipt_verdict === 'verde') {
            verdes++;
            const motivo = exclusionVerde(p, ctx);
            if (motivo === null) verdesUnClic++;
            else verdesExcluidos[motivo] = (verdesExcluidos[motivo] ?? 0) + 1;
        }
        const entro = Date.parse(p.enviado_en);
        if (Number.isFinite(entro)) {
            if (ahora - entro >= UMBRAL_TARDE_MS) masDe48h++;
            if (masAntiguo === null || entro < masAntiguo) masAntiguo = entro;
        }
        const clave = tipoDeCobro(p);
        const linea = porTipo.get(clave) ?? { clave, etiqueta: etiquetaDeDesglose(clave), cantidad: 0, monto: 0 };
        linea.cantidad++;
        linea.monto += s;
        porTipo.set(clave, linea);
    }
    return {
        schoolId,
        total: pagos.length,
        monto,
        verdes,
        verdesUnClic,
        verdesExcluidos,
        masAntiguo: masAntiguo === null ? null : new Date(masAntiguo).toISOString(),
        esperaMasAntiguoMs: masAntiguo === null ? 0 : Math.max(0, ahora - masAntiguo),
        masDe48h,
        // De más a menos; los empates, en el orden del filtro (sort es estable).
        desglose: ORDEN_TIPOS.map((k) => porTipo.get(k)).filter((l): l is LineaDesglose => !!l)
            .sort((a, b) => b.cantidad - a.cantidad),
    };
}

/** Mañana: si hay algo. Tarde: solo si algo lleva más de 48 h. Pura. */
export function debeAvisar(r: Pick<ResumenPagos, 'total' | 'masDe48h'>, tramo: Tramo): boolean {
    return tramo === 'manana' ? r.total > 0 : r.masDe48h > 0;
}

export const claveAviso = (schoolId: string, fecha: string, tramo: Tramo) =>
    `${TIPO_CORREO}:${schoolId}:${fecha}:${tramo}`;

/** Solo escuelas reales: ni demo ni de prueba. Pura. */
export function escuelaElegible(e: { account_type?: string | null; is_demo?: boolean | null }): boolean {
    return e.account_type === 'real' && e.is_demo !== true;
}

/** Tramo por la hora de Colombia: antes del mediodía, la mañana. Pura. */
export function tramoPorHora(ahora: number): Tramo {
    const h = (new Date(ahora).getUTCHours() + 19) % 24;
    return h < 12 ? 'manana' : 'tarde';
}

// ─── Textos ──────────────────────────────────────────────────────────────────

/** «$4.547.500»: determinista, sin depender del ICU del servidor. Pura. */
export const cop = (n: number): string =>
    '$' + Math.round(Math.abs(n || 0)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const pagos = (n: number) => (n === 1 ? '1 pago' : `${n} pagos`);

/** «a***@gmail.com». Para imprimir destinatarios sin regalar el correo. Pura. */
export function enmascararCorreo(correo: string): string {
    const m = /^(.)[^@]*(@.+)$/.exec(String(correo ?? '').trim());
    return m ? `${m[1]}***${m[2]}` : '***';
}

/**
 * Línea de los verdes, o null si no hay. Nunca invita a aprobar a ciegas:
 *   · con aprobación automática, los verdes que quedan son los que NO se
 *     aprobaron solos → cuántos son y que se revisen, sin «Aprobar todos los verdes»;
 *   · sin ella, «Aprobar todos los verdes» se menciona DESPUÉS de revisarlos.
 * Pura.
 */
export function lineaVerdes(r: Pick<ResumenPagos, 'verdes' | 'verdesUnClic'>, autoAprobacion = false): string | null {
    const { verdes, verdesUnClic: u } = r;
    if (verdes === 0) return null;
    if (autoAprobacion) {
        return verdes === 1
            ? '1 está en verde, pero no se aprobó solo: revisa el comprobante antes de aprobarlo.'
            : `${verdes} están en verde, pero no se aprobaron solos: revisa cada comprobante antes de aprobarlo.`;
    }
    if (u === verdes) {
        return verdes === 1
            ? '1 está en verde (el comprobante coincide con el cobro): revísalo y apruébalo desde su fila.'
            : `${verdes} están en verde (el comprobante coincide con el cobro). Después de revisarlos, puedes aprobarlos juntos con «Aprobar todos los verdes».`;
    }
    if (u === 0) {
        return verdes === 1
            ? '1 está en verde, pero hay que revisarlo desde su fila (no entra en «Aprobar todos los verdes»).'
            : `${verdes} están en verde, pero hay que revisarlos desde su fila (no entran en «Aprobar todos los verdes»).`;
    }
    const resto = verdes - u;
    return `${verdes} están en verde: después de revisarlos, ${u === 1 ? '1 se puede aprobar' : `${u} se pueden aprobar`} con «Aprobar todos los verdes»`
        + ` y ${resto === 1 ? '1 se aprueba' : `${resto} se aprueban`} desde su fila.`;
}

/** «El más antiguo lleva 4 días esperando.» Pura. */
export function lineaEspera(r: Pick<ResumenPagos, 'total' | 'esperaMasAntiguoMs'>): string {
    const espera = formatoEspera(r.esperaMasAntiguoMs);
    return r.total === 1 ? `Lleva ${espera} esperando.` : `El más antiguo lleva ${espera} esperando.`;
}

export function linea48(r: Pick<ResumenPagos, 'masDe48h'>): string | null {
    if (r.masDe48h === 0) return null;
    return r.masDe48h === 1 ? '1 lleva más de 48 h esperando.' : `${r.masDe48h} llevan más de 48 h esperando.`;
}

/** «Mensualidad 22 · Torneo 5 · Clínica 1». Pura. */
export const desgloseCorto = (r: Pick<ResumenPagos, 'desglose'>): string =>
    r.desglose.map((l) => `${l.etiqueta} ${l.cantidad}`).join(' · ');

export interface TextosAviso {
    /** Notificación in-app / push. */
    titulo: string;
    mensaje: string;
    /** Correo. */
    asunto: string;
    tituloCorreo: string;
}

/** Los textos de los tres canales, a partir del mismo resumen. Pura. */
export function textosDelAviso(r: ResumenPagos, escuela: string, tramo: Tramo, autoAprobacion = false): TextosAviso {
    const nombre = escuela.trim() || 'tu escuela';
    const verdes = lineaVerdes(r, autoAprobacion);
    const espera = lineaEspera(r);
    const porTipo = r.desglose.length > 1 ? `Por tipo: ${desgloseCorto(r)}.` : '';
    if (tramo === 'tarde') {
        const viejos = r.masDe48h === 1 ? '1 pago lleva' : `${r.masDe48h} pagos llevan`;
        return {
            titulo: `${viejos} más de 48 h sin validar`,
            mensaje: [`En total hay ${r.total} por validar (${cop(r.monto)}).`, verdes, espera].filter(Boolean).join(' '),
            asunto: `Recordatorio — ${nombre}: ${viejos} más de 48 h sin validar`,
            tituloCorreo: `${viejos} más de 48 h esperando`,
        };
    }
    return {
        titulo: `${pagos(r.total)} por validar · ${cop(r.monto)}`,
        mensaje: [verdes, espera, porTipo].filter(Boolean).join(' '),
        asunto: `${nombre}: ${pagos(r.total)} por validar (${cop(r.monto)})`,
        tituloCorreo: `Tienes ${pagos(r.total)} por validar`,
    };
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

const SELECT_PAGOS = 'id, school_id, amount, amount_paid, early_payment_discount_applied, concept, payment_category, receipt_verdict, receipt_url, '
    + 'ocr_amount, requires_review, child_id, period_year, period_month, receipt_submitted_at, receipt_verdict_at, created_at';

function aPago(f: any): PagoPorValidar {
    return {
        id: f.id,
        school_id: f.school_id,
        amount: Number(f.amount) || 0,
        amount_paid: Number(f.amount_paid) || 0,
        early_payment_discount_applied: Number(f.early_payment_discount_applied) || 0,
        concept: f.concept ?? null,
        payment_category: f.payment_category ?? null,
        receipt_verdict: f.receipt_verdict ?? null,
        receipt_url: f.receipt_url ?? null,
        ocr_amount: f.ocr_amount == null ? null : Number(f.ocr_amount),
        requires_review: f.requires_review === true,
        child_id: f.child_id ?? null,
        period_year: f.period_year ?? null,
        period_month: f.period_month ?? null,
        enviado_en: f.receipt_submitted_at ?? f.receipt_verdict_at ?? f.created_at,
    };
}

/** LA lectura agregada: todos los comprobantes por validar de todas las escuelas. */
async function leerPendientes(escuela?: string): Promise<PagoPorValidar[]> {
    let q = supabase.from('payments').select(SELECT_PAGOS)
        .eq('status', 'awaiting_approval')
        .not('receipt_url', 'is', null)
        .not('school_id', 'is', null);
    if (escuela) q = q.eq('school_id', escuela);
    const { data, error } = await q.limit(LIMITE);
    if (error) throw new Error(`payments: ${error.message}`);
    return ((data ?? []) as any[]).map(aPago);
}

/** Meses ya pagados por otro cobro, solo para los verdes con periodo (una lectura). */
async function periodosYaPagados(lista: readonly PagoPorValidar[]): Promise<Set<string>> {
    const candidatos = lista.filter((p) => p.receipt_verdict === 'verde' && p.child_id && p.period_year && p.period_month);
    if (!candidatos.length) return new Set();
    const hijos = [...new Set(candidatos.map((p) => p.child_id!))];
    const anios = [...new Set(candidatos.map((p) => p.period_year!))];
    const { data, error } = await supabase.from('payments')
        .select('child_id, period_year, period_month')
        .in('child_id', hijos)
        .in('status', ['paid', 'approved'])
        .in('period_year', anios)
        .limit(LIMITE);
    if (error) throw new Error(`payments (periodos): ${error.message}`);
    const out = new Set<string>();
    for (const f of (data ?? []) as any[]) {
        if (f.child_id && f.period_year && f.period_month) out.add(clavePeriodo(f.child_id, f.period_year, f.period_month));
    }
    return out;
}

/**
 * Escuelas con la aprobación automática encendida (una lectura). Si no se puede
 * leer, se asumen TODAS encendidas: la línea prudente («revísalos») nunca invita
 * a aprobar a ciegas.
 */
async function escuelasConAutoAprobacion(ids: readonly string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const { data, error } = await supabase.from('school_settings')
        .select('school_id, auto_approve_enabled')
        .in('school_id', [...ids]);
    if (error) return new Set(ids);
    return new Set(((data ?? []) as any[]).filter((s) => s.auto_approve_enabled === true).map((s) => s.school_id));
}

interface Destinatarios { perfiles: string[]; correos: string[] }

/** Owner + admins activos de varias escuelas, en dos lecturas (miembros y perfiles). */
async function destinatariosEnLote(escuelas: readonly { id: string; owner_id: string | null }[]): Promise<Map<string, Destinatarios>> {
    const out = new Map<string, Destinatarios>();
    if (!escuelas.length) return out;
    const { data: miembros, error } = await supabase.from('school_members')
        .select('school_id, profile_id')
        .in('school_id', escuelas.map((e) => e.id))
        .eq('status', 'active')
        .in('role', [...ROLES_DESTINO]);
    if (error) throw new Error(`school_members: ${error.message}`);

    const idsPorEscuela = new Map<string, Set<string>>();
    for (const e of escuelas) idsPorEscuela.set(e.id, new Set(e.owner_id ? [e.owner_id] : []));
    for (const m of (miembros ?? []) as any[]) if (m.profile_id) idsPorEscuela.get(m.school_id)?.add(m.profile_id);

    const todos = [...new Set([...idsPorEscuela.values()].flatMap((s) => [...s]))];
    const perfiles = new Map<string, { email: string | null; is_demo: boolean }>();
    if (todos.length) {
        const { data, error: errPerfiles } = await supabase.from('profiles').select('id, email, is_demo').in('id', todos);
        if (errPerfiles) throw new Error(`profiles: ${errPerfiles.message}`);
        for (const p of (data ?? []) as any[]) perfiles.set(p.id, { email: p.email ?? null, is_demo: p.is_demo === true });
    }

    for (const [schoolId, ids] of idsPorEscuela) {
        const validos = [...ids].filter((id) => perfiles.has(id) && !perfiles.get(id)!.is_demo);
        const correos = new Set<string>();
        for (const id of validos) {
            const e = String(perfiles.get(id)!.email ?? '').trim().toLowerCase();
            if (e.includes('@')) correos.add(e);
        }
        out.set(schoolId, { perfiles: validos, correos: [...correos] });
    }
    return out;
}

export interface PlanEscuela {
    schoolId: string;
    escuela: string;
    clave: string;
    /** Ya hay reserva de este día y tramo (otro BFF o una corrida anterior). */
    yaEnviado: boolean;
    resumen: ResumenPagos;
    /** Perfiles que reciben el aviso in-app. */
    perfiles: string[];
    correos: string[];
    /** La escuela tiene la aprobación automática encendida (cambia la línea de los verdes). */
    autoAprobacion: boolean;
    textos: TextosAviso;
}

export interface ResultadoCorrida {
    tramo: Tramo;
    fecha: string;
    /** Escuelas con comprobantes por validar (antes de filtrar). */
    escuelasConPendientes: number;
    plan: PlanEscuela[];
    avisadas: number;
    duplicadas: number;
    fallosCorreo: number;
    sinCorreo: number;
    omitidas: { noElegible: number; nadaQueAvisar: number; sinDestinatarios: number };
}

export interface OpcionesCorrida {
    tramo: Tramo;
    ahora?: number;
    /** Acota a una escuela (script manual). */
    escuela?: string;
    /** false = simulacro: arma el plan y no escribe NADA. */
    aplicar?: boolean;
    log?: Logger;
}

/** El correo de una escuela (HTML del layout branded). */
export async function correoDelPlan(p: PlanEscuela): Promise<{ subject: string; html: string }> {
    const r = p.resumen;
    return BrandedEmailTemplates.pagosPorValidar({
        escuela: p.escuela,
        asunto: p.textos.asunto,
        titulo: p.textos.tituloCorreo,
        total: r.total,
        monto: cop(r.monto),
        lineaVerdes: lineaVerdes(r, p.autoAprobacion),
        lineaEspera: lineaEspera(r),
        masAntiguoFecha: r.masAntiguo ? horaColombia(r.masAntiguo) : '',
        linea48: linea48(r),
        desglose: r.desglose.map((l) => ({ etiqueta: l.etiqueta, cantidad: l.cantidad, monto: cop(l.monto) })),
        url: URL_PANEL,
    });
}

type Desenlace = 'avisada' | 'duplicada' | 'fallo_correo' | 'sin_correo';

async function avisarEscuela(p: PlanEscuela, tramo: Tramo, fecha: string, log: Logger | Console): Promise<Desenlace> {
    // El candado de los tres canales. Sin reserva (otro BFF ya la tiene, o no se
    // pudo escribir) no se avisa por ningún lado.
    const reserva = await reservarEnvio({
        clave: p.clave, tipo: TIPO_CORREO, schoolId: p.schoolId, refId: null,
        destinos: p.correos.length ? p.correos : ['(sin correo: solo aviso in-app)'],
    });
    if (!reserva) return 'duplicada';

    const r = p.resumen;
    if (p.perfiles.length) {
        const { error } = await supabase.from('notifications').insert(p.perfiles.map((user_id) => ({
            user_id,
            school_id: p.schoolId,
            title: p.textos.titulo,
            message: p.textos.mensaje,
            type: 'payment',
            category: 'payment',
            link: LINK_IN_APP,
            data: {
                school_id: p.schoolId,
                sede_id: null,
                aviso: TIPO_CORREO,
                clave: p.clave,
                tramo,
                fecha,
                total: r.total,
                monto_total: r.monto,
                verdes: r.verdes,
                verdes_un_clic: r.verdesUnClic,
                mas_de_48h: r.masDe48h,
            },
        })));
        if (error) (log as any).warn?.({ schoolId: p.schoolId, err: error.message }, '[pagos-por-validar] no se pudo guardar el aviso in-app');
    }

    let desenlace: Desenlace;
    if (p.correos.length) {
        const tpl = await correoDelPlan(p);
        const envio = await enviarPlantilla(null, p.correos, {}, {
            subject: tpl.subject, titulo: p.textos.tituloCorreo, lineas: [], html: tpl.html,
        });
        await cerrarEnvio(reserva, envio);
        desenlace = envio.ok ? 'avisada' : 'fallo_correo';
        if (!envio.ok) (log as any).error?.({ schoolId: p.schoolId, err: envio.error }, '[pagos-por-validar] el correo no salió');
    } else {
        await cerrarEnvio(reserva, { ok: false, error: 'sin destinatarios con correo: solo aviso in-app' });
        desenlace = 'sin_correo';
    }

    // (c) WhatsApp de plataforma: apagado salvo PAGOS_POR_VALIDAR_WA_ENABLED=true.
    avisarPagosPorValidarPorPlataforma({
        schoolId: p.schoolId,
        escuela: p.escuela,
        fecha,
        tramo,
        titulo: p.textos.titulo,
        mensaje: p.textos.mensaje,
        total: r.total,
        esperaMasAntiguo: formatoEspera(r.esperaMasAntiguoMs),
    });
    return desenlace;
}

/**
 * Una corrida de un tramo. Con `aplicar: false` solo lee (incluida la consulta
 * de reservas) y devuelve el plan. Lanza si falla una lectura; por escuela
 * nunca lanza: sigue con las demás.
 */
export async function runPagosPorValidar(opts: OpcionesCorrida): Promise<ResultadoCorrida> {
    const ahora = opts.ahora ?? Date.now();
    const aplicar = opts.aplicar !== false;
    const log: Logger | Console = opts.log ?? console;
    const fecha = fechaColombia(ahora);
    const res: ResultadoCorrida = {
        tramo: opts.tramo, fecha, escuelasConPendientes: 0, plan: [],
        avisadas: 0, duplicadas: 0, fallosCorreo: 0, sinCorreo: 0,
        omitidas: { noElegible: 0, nadaQueAvisar: 0, sinDestinatarios: 0 },
    };

    const pendientes = await leerPendientes(opts.escuela);
    if (!pendientes.length) return res;
    const porEscuela = new Map<string, PagoPorValidar[]>();
    for (const p of pendientes) {
        const l = porEscuela.get(p.school_id);
        if (l) l.push(p); else porEscuela.set(p.school_id, [p]);
    }
    res.escuelasConPendientes = porEscuela.size;

    const { data: escuelas, error: errEscuelas } = await supabase.from('schools')
        .select('id, name, owner_id, account_type, is_demo')
        .in('id', [...porEscuela.keys()]);
    if (errEscuelas) throw new Error(`schools: ${errEscuelas.message}`);
    const elegibles = ((escuelas ?? []) as any[]).filter(escuelaElegible);
    res.omitidas.noElegible = porEscuela.size - elegibles.length;
    if (!elegibles.length) return res;

    const periodos = await periodosYaPagados(elegibles.flatMap((e) => porEscuela.get(e.id) ?? []));
    const candidatas = elegibles
        .map((e) => ({ e, resumen: armarResumen(e.id, porEscuela.get(e.id) ?? [], ahora, periodos) }))
        .filter(({ resumen }) => debeAvisar(resumen, opts.tramo));
    res.omitidas.nadaQueAvisar = elegibles.length - candidatas.length;
    if (!candidatas.length) return res;

    // Reservas de hoy y este tramo: una lectura, para no intentar lo ya hecho.
    const claves = candidatas.map(({ e }) => claveAviso(e.id, fecha, opts.tramo));
    const { data: hechas, error: errHechas } = await supabase.from('email_sends').select('id').in('id', claves.map(uuidDeClave));
    if (errHechas) throw new Error(`email_sends: ${errHechas.message}`);
    const yaHechas = new Set(((hechas ?? []) as any[]).map((h) => h.id));

    const destinatarios = await destinatariosEnLote(candidatas.map(({ e }) => ({ id: e.id, owner_id: e.owner_id ?? null })));
    const conAutoAprobacion = await escuelasConAutoAprobacion(candidatas.map(({ e }) => e.id));

    for (const { e, resumen } of candidatas) {
        const d = destinatarios.get(e.id) ?? { perfiles: [], correos: [] };
        if (!d.perfiles.length) { res.omitidas.sinDestinatarios++; continue; }
        const clave = claveAviso(e.id, fecha, opts.tramo);
        const escuela = String(e.name ?? '').trim() || 'tu escuela';
        res.plan.push({
            schoolId: e.id,
            escuela,
            clave,
            yaEnviado: yaHechas.has(uuidDeClave(clave)),
            resumen,
            perfiles: d.perfiles,
            correos: d.correos,
            autoAprobacion: conAutoAprobacion.has(e.id),
            textos: textosDelAviso(resumen, escuela, opts.tramo, conAutoAprobacion.has(e.id)),
        });
    }
    if (!aplicar) return res;

    for (const p of res.plan) {
        if (p.yaEnviado) { res.duplicadas++; continue; }
        try {
            const desenlace = await avisarEscuela(p, opts.tramo, fecha, log);
            if (desenlace === 'avisada') res.avisadas++;
            else if (desenlace === 'duplicada') res.duplicadas++;
            else if (desenlace === 'fallo_correo') { res.avisadas++; res.fallosCorreo++; }
            else { res.avisadas++; res.sinCorreo++; }
        } catch (err: any) {
            res.fallosCorreo++;
            (log as any).error?.({ schoolId: p.schoolId, err: err?.message || String(err) }, '[pagos-por-validar] falló la escuela');
        }
    }
    return res;
}
