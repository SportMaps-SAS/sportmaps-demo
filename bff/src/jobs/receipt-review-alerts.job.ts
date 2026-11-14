/**
 * receipt-review-alerts.job — avisar a la escuela que hay comprobantes por validar.
 *
 * Medido el 2026-10-08 (Dynasty, 43 comprobantes del bot): de la foto a la
 * aprobación pasan p50 3,7 h y p90 49 h. El bot registra en 3,5 min; lo que
 * tarda es que una sola persona aprueba por tandas, y los «verde» esperan igual
 * que los dudosos. Nadie le avisaba que había algo esperando: la app solo
 * notificaba al DUEÑO y solo cuando el comprobante entraba por la app (no por
 * el bot ni por el importador de chats).
 *
 * Este job observa el RESULTADO (cobros en `awaiting_approval` con comprobante),
 * que es común a todos los caminos de entrada, y avisa in-app + push (el outbox
 * `notification_deliveries` sale solo del INSERT en `notifications`) al dueño y
 * a los admins de la escuela:
 *
 *   · «Comprobante nuevo»: lo que entró desde el último aviso. Agrupado: como
 *     mucho uno cada INTERVALO_NUEVO_MIN por escuela.
 *   · «Recordatorio»: hay comprobantes con más de 2 h sin revisar. Uno solo,
 *     agrupado, cada 2 h por escuela.
 *   · Nada entre las 22:00 y las 06:59 (hora Colombia): lo acumulado sale a las 7.
 *
 * NO aprueba nada. La aprobación sigue siendo de una persona.
 *
 * Idempotencia: los 3 BFF (dev/stg/prod) comparten la base y corren este job a
 * la vez. El estado de cada escuela vive en `school_receipt_review_alerts` con
 * una versión optimista: solo el BFF que logra el UPDATE … WHERE version = leída
 * manda el aviso. Sin la migración 20261008165728 el job no hace nada.
 */

import { supabase } from '../config/supabase';
import type { Logger } from 'pino';
import { avisarComprobantesPorPlataforma } from '../services/plataforma-wa-avisos.service';

export const RECORDATORIO_MS = 2 * 60 * 60 * 1000;
export const INTERVALO_NUEVO_MS = 10 * 60 * 1000;
const HORA_INICIO = 7;   // 07:00 Colombia
const HORA_FIN = 21;     // hasta las 21:59
const LINK = '/payments-automation?tab=recurrent';
const LIMITE = 2000;

export interface ComprobantePorValidar {
    id: string;
    school_id: string;
    amount: number;
    amount_paid: number;
    concept: string | null;
    receipt_verdict: string | null;
    /** Cuándo entró el comprobante (ISO). */
    enviado_en: string;
}

export interface EstadoAlertas {
    school_id: string;
    new_cursor: string;
    last_new_alert_at: string | null;
    last_reminder_at: string | null;
    version: number;
}

export interface Aviso {
    tipo: 'nuevo' | 'recordatorio';
    titulo: string;
    mensaje: string;
}

export interface Plan {
    aviso: Aviso | null;
    /** Columnas a escribir si se reclama el aviso. */
    patch: Partial<Pick<EstadoAlertas, 'new_cursor' | 'last_new_alert_at' | 'last_reminder_at'>>;
}

const cop = (n: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

/** Hora 0-23 en Colombia (UTC-5 fijo, sin horario de verano). Pura. */
export function horaColombia(ahora: number): number {
    return (new Date(ahora).getUTCHours() + 19) % 24;
}

export function enHorarioDeAvisos(ahora: number): boolean {
    const h = horaColombia(ahora);
    return h >= HORA_INICIO && h <= HORA_FIN;
}

/** «45 min», «3 h», «2 días». Pura. */
export function formatoEspera(ms: number): string {
    const min = Math.max(0, Math.floor(ms / 60_000));
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} h`;
    return `${Math.floor(h / 24)} días`;
}

/** Lo que falta por cubrir de un cobro (con abonos, el saldo). */
function saldo(c: ComprobantePorValidar): number {
    return Math.max(c.amount - (c.amount_paid || 0), 0);
}

/**
 * Decide qué avisar a UNA escuela en esta vuelta. Pura.
 * Un solo aviso por vuelta: si toca recordatorio, ese lleva todo (y adelanta el
 * cursor de «nuevos» para no mandar los dos a la vez).
 */
export function planDeAvisos(estado: EstadoAlertas, lista: ComprobantePorValidar[], ahora: number): Plan {
    if (lista.length === 0) return { aviso: null, patch: {} };

    const cursor = Date.parse(estado.new_cursor) || 0;
    const nuevos = lista.filter((c) => Date.parse(c.enviado_en) > cursor);
    const maxEnviado = lista.reduce((m, c) => Math.max(m, Date.parse(c.enviado_en) || 0), cursor);
    const viejos = lista.filter((c) => ahora - (Date.parse(c.enviado_en) || ahora) >= RECORDATORIO_MS);
    const verdes = lista.filter((c) => c.receipt_verdict === 'verde').length;

    const ultimoRecordatorio = estado.last_reminder_at ? Date.parse(estado.last_reminder_at) : 0;
    // Un recordatorio por comprobante (2026-10-29): antes se repetía cada 2 h
    // mientras quedara UNO pendiente («1 comprobante lleva más de 2 h sin revisar»
    // 16 veces en 4 días a la misma dueña). Ahora solo suena si hay comprobantes
    // que cumplieron las 2 h DESPUÉS del último recordatorio.
    const viejosSinAvisar = viejos.filter((c) => (Date.parse(c.enviado_en) || 0) + RECORDATORIO_MS > ultimoRecordatorio);
    const tocaRecordatorio = viejosSinAvisar.length > 0 && ahora - ultimoRecordatorio >= RECORDATORIO_MS;

    if (tocaRecordatorio) {
        const masAntiguo = viejos.reduce((m, c) => Math.min(m, Date.parse(c.enviado_en) || ahora), ahora);
        const total = lista.reduce((s, c) => s + saldo(c), 0);
        const titulo = viejos.length === 1
            ? '1 comprobante lleva más de 2 h sin revisar'
            : `${viejos.length} comprobantes llevan más de 2 h sin revisar`;
        const partes = [
            `El más antiguo espera hace ${formatoEspera(ahora - masAntiguo)}.`,
            `En total hay ${lista.length} por validar (${cop(total)}).`,
        ];
        if (verdes > 0) {
            partes.push(verdes === 1
                ? '1 está en verde y se aprueba en un clic.'
                : `${verdes} están en verde: se aprueban juntos con «Aprobar todos los verdes».`);
        }
        const ahoraIso = new Date(ahora).toISOString();
        return {
            aviso: { tipo: 'recordatorio', titulo, mensaje: partes.join(' ') },
            patch: {
                last_reminder_at: ahoraIso,
                ...(nuevos.length > 0 ? { new_cursor: new Date(maxEnviado).toISOString(), last_new_alert_at: ahoraIso } : {}),
            },
        };
    }

    const ultimoNuevo = estado.last_new_alert_at ? Date.parse(estado.last_new_alert_at) : 0;
    if (nuevos.length > 0 && ahora - ultimoNuevo >= INTERVALO_NUEVO_MS) {
        const total = nuevos.reduce((s, c) => s + saldo(c), 0);
        const verdesNuevos = nuevos.filter((c) => c.receipt_verdict === 'verde').length;
        let titulo: string;
        let mensaje: string;
        if (nuevos.length === 1) {
            const c = nuevos[0];
            titulo = 'Comprobante nuevo por validar';
            mensaje = `${c.concept ?? 'Cobro'} · ${cop(saldo(c))}.`
                + (c.receipt_verdict === 'verde' ? ' Está en verde: listo para aprobar.' : ' Revísalo en Gestión de pagos.');
        } else {
            titulo = `${nuevos.length} comprobantes nuevos por validar`;
            mensaje = `Suman ${cop(total)}.`
                + (verdesNuevos > 0 ? ` ${verdesNuevos} en verde, listos para aprobar.` : ' Revísalos en Gestión de pagos.');
        }
        return {
            aviso: { tipo: 'nuevo', titulo, mensaje },
            patch: { new_cursor: new Date(maxEnviado).toISOString(), last_new_alert_at: new Date(ahora).toISOString() },
        };
    }

    return { aviso: null, patch: {} };
}

// ─── I/O ────────────────────────────────────────────────────────────────────

let avisoSinMigracion = false;
function sinMigracion(log: Logger | undefined, detalle: string): { avisos: number } {
    if (!avisoSinMigracion) {
        avisoSinMigracion = true;
        (log ?? console).warn?.({ detalle }, '[receipt-alerts] falta la migración 20261008165728: el job no avisa');
    }
    return { avisos: 0 };
}

const esFaltaDeEsquema = (code?: string) =>
    code === '42703' || code === '42P01' || code === 'PGRST204' || code === 'PGRST205';

async function destinatarios(schoolId: string): Promise<string[]> {
    const [{ data: escuela }, { data: miembros }] = await Promise.all([
        supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle(),
        supabase.from('school_members').select('profile_id')
            .eq('school_id', schoolId).eq('status', 'active')
            .in('role', ['owner', 'admin', 'school_admin']),
    ]);
    const ids = new Set<string>();
    if ((escuela as any)?.owner_id) ids.add((escuela as any).owner_id);
    for (const m of (miembros as any[]) ?? []) if (m.profile_id) ids.add(m.profile_id);
    return [...ids];
}

export async function runReceiptReviewAlerts(log?: Logger, ahora = Date.now()): Promise<{ avisos: number }> {
    if (!enHorarioDeAvisos(ahora)) return { avisos: 0 };

    const { data: filas, error } = await supabase
        .from('payments')
        .select('id, school_id, amount, amount_paid, concept, receipt_verdict, receipt_submitted_at, receipt_verdict_at, created_at')
        .eq('status', 'awaiting_approval')
        .not('receipt_url', 'is', null)
        .not('school_id', 'is', null)
        .limit(LIMITE);
    if (error) {
        if (esFaltaDeEsquema((error as any).code)) return sinMigracion(log, error.message);
        (log ?? console).error?.({ err: error.message }, '[receipt-alerts] no se pudo listar');
        return { avisos: 0 };
    }
    if (!filas || filas.length === 0) return { avisos: 0 };

    const porEscuela = new Map<string, ComprobantePorValidar[]>();
    for (const f of filas as any[]) {
        const c: ComprobantePorValidar = {
            id: f.id,
            school_id: f.school_id,
            amount: Number(f.amount) || 0,
            amount_paid: Number(f.amount_paid) || 0,
            concept: f.concept ?? null,
            receipt_verdict: f.receipt_verdict ?? null,
            enviado_en: f.receipt_submitted_at ?? f.receipt_verdict_at ?? f.created_at,
        };
        const l = porEscuela.get(c.school_id);
        if (l) l.push(c); else porEscuela.set(c.school_id, [c]);
    }
    const escuelas = [...porEscuela.keys()];

    // Escuela que aparece por primera vez: arranca con el cursor en «ahora», así
    // lo viejo no sale como «nuevo» (lo cubre el recordatorio). Si otro BFF la
    // creó primero, el upsert no pisa nada.
    const { data: existentes, error: errEstado } = await supabase
        .from('school_receipt_review_alerts')
        .select('school_id, new_cursor, last_new_alert_at, last_reminder_at, version')
        .in('school_id', escuelas);
    if (errEstado) {
        if (esFaltaDeEsquema((errEstado as any).code)) return sinMigracion(log, errEstado.message);
        (log ?? console).error?.({ err: errEstado.message }, '[receipt-alerts] no se pudo leer el estado');
        return { avisos: 0 };
    }
    const estados = new Map<string, EstadoAlertas>(((existentes as any[]) ?? []).map((e) => [e.school_id, e]));
    const faltan = escuelas.filter((s) => !estados.has(s));
    if (faltan.length > 0) {
        const nowIso = new Date(ahora).toISOString();
        await supabase.from('school_receipt_review_alerts')
            .upsert(faltan.map((school_id) => ({ school_id, new_cursor: nowIso })), { onConflict: 'school_id', ignoreDuplicates: true });
        const { data: creados } = await supabase
            .from('school_receipt_review_alerts')
            .select('school_id, new_cursor, last_new_alert_at, last_reminder_at, version')
            .in('school_id', faltan);
        for (const e of (creados as any[]) ?? []) estados.set(e.school_id, e);
    }

    let avisos = 0;
    for (const schoolId of escuelas) {
        const estado = estados.get(schoolId);
        if (!estado) continue;
        const plan = planDeAvisos(estado, porEscuela.get(schoolId)!, ahora);
        if (!plan.aviso) continue;

        // Reclamo: solo un BFF gana la versión.
        const { data: reclamado } = await supabase.from('school_receipt_review_alerts')
            .update({ ...plan.patch, version: estado.version + 1, updated_at: new Date(ahora).toISOString() })
            .eq('school_id', schoolId)
            .eq('version', estado.version)
            .select('school_id');
        if (!reclamado || reclamado.length === 0) continue;

        const ids = await destinatarios(schoolId);
        if (ids.length === 0) continue;
        const { error: errNotif } = await supabase.from('notifications').insert(ids.map((user_id) => ({
            user_id,
            school_id: schoolId,
            title: plan.aviso!.titulo,
            message: plan.aviso!.mensaje,
            type: 'payment',
            category: 'payment',
            link: LINK,
        })));
        if (errNotif) {
            (log ?? console).warn?.({ schoolId, err: errNotif.message }, '[receipt-alerts] no se pudo notificar');
            continue;
        }
        avisos++;
        (log ?? console).info?.({ schoolId, tipo: plan.aviso.tipo, destinatarios: ids.length }, '[receipt-alerts] aviso enviado');
        // Canal de plataforma (spec canal-whatsapp-plataforma): el mismo aviso al
        // WhatsApp personal de la dueña con opt-in. La versión reclamada es única
        // por aviso: es la clave de idempotencia. No hace nada con el flag apagado.
        const lista = porEscuela.get(schoolId)!;
        avisarComprobantesPorPlataforma({
            schoolId,
            version: estado.version + 1,
            titulo: plan.aviso.titulo,
            mensaje: plan.aviso.mensaje,
            total: lista.length,
            masAntiguo: lista.reduce<string | null>((m, c) => (!m || c.enviado_en < m ? c.enviado_en : m), null),
        }, ahora);
    }
    return { avisos };
}
