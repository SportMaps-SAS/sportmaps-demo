/**
 * acuerdos-de-pago-recordatorios.job — recordatorio el DÍA de cada cuota de un acuerdo de pago
 * (spec campanas-descuento-referidos-y-plazos-por-whatsapp §5).
 *
 * Mecanismo: un INSERT en `notifications` con service role encola solo el aviso in-app + push
 * (el despachador de notificaciones lo recoge). Destinatario = el propio pagador; `link` interno.
 *
 * Idempotencia entre los 3 BFF (comparten la base): se RECLAMAN las cuotas con un UPDATE
 * `reminded_at IS NULL → now()` que devuelve las filas ganadas; solo se avisa por las ganadas.
 * Si el INSERT falla, se devuelve el reclamo (reminded_at = NULL) para el siguiente intento.
 *
 * Disk IO: una consulta de escuelas con el módulo prendido y UNA por escuela por día
 * (cuotas de hoy, en lote); nada de una consulta por cuota. Un lote de notificaciones por escuela.
 *
 * Solo avisa cuotas PENDIENTES de acuerdos ACTIVOS que vencen hoy. Los textos no hablan de
 * mora, deuda ni atraso (regla de Monster´s Volley Club, válida para todas).
 *
 * Montaje (no editado aquí): en maintenance.job.ts, junto a runReceiptReviewAlerts, una vez al día
 * (p. ej. cada hora; la guarda de horario deja pasar solo 07:00–20:59 y el reclamo evita repetir).
 * El job que vence cuotas (RPC expire_agreements) y el que sincroniza abonos
 * (mark_agreement_items_from_payments) se llaman con `correrMantenimientoAcuerdos` (abajo).
 */

import type { Logger } from 'pino';
import { supabase } from '../config/supabase';
import { hoyBogota } from '../services/acuerdos-de-pago.service';

const LINK = '/my-payments';
const HORA_INICIO = 7;
const HORA_FIN = 20;
const MAX_POR_ESCUELA = 2000;

export interface CuotaDeHoy {
    id: string;
    agreement_id: string;
    school_id: string;
    payer_profile_id: string | null;
    seq: number;
    amount: number;
    total: number;     // cuotas del acuerdo
    due_date: string;
}

export interface NotificacionRow {
    user_id: string;
    school_id: string;
    title: string;
    message: string;
    type: 'payment';
    category: 'payment';
    link: string;
    data: { agreement_id: string; item_id: string; seq: number };
}

const cop = (n: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

export function horaColombia(ahora: number): number {
    return (new Date(ahora).getUTCHours() + 19) % 24;
}
export function enHorarioDeAvisos(ahora: number): boolean {
    const h = horaColombia(ahora);
    return h >= HORA_INICIO && h <= HORA_FIN;
}

/** Texto del recordatorio. Pura. Sin mora/deuda/atraso. */
export function textoRecordatorio(c: Pick<CuotaDeHoy, 'seq' | 'total' | 'amount'>): { title: string; message: string } {
    return {
        title: 'Hoy toca tu cuota del acuerdo de pago',
        message: `Hoy es la fecha de tu cuota ${c.seq} de ${c.total}, por ${cop(c.amount)}. Puedes pagarla desde Mis pagos o enviando tu comprobante.`,
    };
}

/**
 * De las cuotas reclamadas arma las notificaciones: solo las que vencen HOY, con pagador con cuenta,
 * una por cuota. Pura.
 */
export function planearRecordatorios(cuotas: CuotaDeHoy[], hoy: string): NotificacionRow[] {
    return cuotas
        .filter((c) => c.due_date === hoy && !!c.payer_profile_id)
        .map((c) => ({
            user_id: c.payer_profile_id as string,
            school_id: c.school_id,
            ...textoRecordatorio(c),
            type: 'payment' as const,
            category: 'payment' as const,
            link: LINK,
            data: { agreement_id: c.agreement_id, item_id: c.id, seq: c.seq },
        }));
}

/** Recordatorios de una escuela (un lote). Devuelve cuántos avisó. */
export async function recordarEscuela(schoolId: string, hoy: string, log?: Logger): Promise<number> {
    const { data, error } = await supabase.from('payment_agreement_items')
        .select('id, agreement_id, school_id, payer_profile_id, seq, amount, due_date, payment_agreements!inner(status, installments)')
        .eq('school_id', schoolId).eq('due_date', hoy).eq('status', 'pendiente').is('reminded_at', null)
        .eq('payment_agreements.status', 'activo')
        .limit(MAX_POR_ESCUELA);
    if (error) {
        (log ?? console).warn?.({ schoolId, err: error.message }, '[acuerdos-recordatorios] no se pudieron leer las cuotas');
        return 0;
    }
    const filas = ((data as any[]) ?? []).map((r): CuotaDeHoy => ({
        id: String(r.id), agreement_id: String(r.agreement_id), school_id: String(r.school_id),
        payer_profile_id: r.payer_profile_id ?? null, seq: Number(r.seq), amount: Number(r.amount),
        total: Number(r.payment_agreements?.installments ?? r.seq), due_date: String(r.due_date),
    }));
    if (filas.length === 0) return 0;

    // Reclamo: solo las que ESTE BFF logra marcar.
    const { data: ganadas, error: errReclamo } = await supabase.from('payment_agreement_items')
        .update({ reminded_at: new Date().toISOString() })
        .in('id', filas.map((f) => f.id)).is('reminded_at', null).select('id');
    if (errReclamo || !ganadas || ganadas.length === 0) return 0;
    const ids = new Set((ganadas as any[]).map((g) => String(g.id)));
    const mias = filas.filter((f) => ids.has(f.id));

    const rows = planearRecordatorios(mias, hoy);
    if (rows.length === 0) return 0;
    const { error: errNotif } = await supabase.from('notifications').insert(rows);
    if (errNotif) {
        (log ?? console).warn?.({ schoolId, err: errNotif.message }, '[acuerdos-recordatorios] no se pudo notificar; se devuelve el reclamo');
        await supabase.from('payment_agreement_items').update({ reminded_at: null }).in('id', mias.map((m) => m.id));
        return 0;
    }
    return rows.length;
}

export async function runAcuerdosRecordatorios(log?: Logger, ahora = Date.now()): Promise<{ avisos: number; escuelas: number }> {
    if (!enHorarioDeAvisos(ahora)) return { avisos: 0, escuelas: 0 };
    const hoy = hoyBogota(ahora);
    const { data, error } = await supabase.from('school_settings').select('school_id').eq('payment_agreements_enabled', true);
    if (error) {
        // 42703: columna inexistente = migración sin aplicar. No es un error del job.
        if (String(error.code) !== '42703') (log ?? console).warn?.({ err: error.message }, '[acuerdos-recordatorios] sin escuelas');
        return { avisos: 0, escuelas: 0 };
    }
    const escuelas = ((data as any[]) ?? []).map((r) => String(r.school_id));
    let avisos = 0;
    for (const schoolId of escuelas) avisos += await recordarEscuela(schoolId, hoy, log);
    if (avisos > 0) (log ?? console).info?.({ avisos, escuelas: escuelas.length }, '[acuerdos-recordatorios] avisos enviados');
    return { avisos, escuelas: escuelas.length };
}

/**
 * Mantenimiento diario de acuerdos (service role): sincroniza abonos y vence cuotas sin pago.
 * Una sola llamada global (expire_agreements sincroniza primero). Pensado para correr una vez al
 * día ANTES de apply_late_fees (que además sincroniza por su cuenta).
 */
export async function correrMantenimientoAcuerdos(log?: Logger): Promise<{ items_vencidos: number; acuerdos_incumplidos: number } | null> {
    const { data, error } = await supabase.rpc('expire_agreements', { p_school_id: null });
    if (error) {
        if (!['PGRST202', '42883'].includes(String(error.code))) {
            (log ?? console).warn?.({ err: error.message }, '[acuerdos] expire_agreements falló');
        }
        return null;
    }
    return { items_vencidos: Number(data?.items_vencidos ?? 0), acuerdos_incumplidos: Number(data?.acuerdos_incumplidos ?? 0) };
}
