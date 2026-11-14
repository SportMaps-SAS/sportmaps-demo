// bff/src/services/notification.service.ts
//
// Despachador unificado (F1). Toma una fila del outbox `notification_deliveries`,
// resuelve preferencias del usuario y entrega por Web Push + FCM nativo,
// actualizando métricas y limpiando tokens muertos.
//
// CLAIM POR LEASE (no marcar 'sent' al reclamar):
//   El claim empuja next_attempt_at +2min y hace attempts++ (guard optimista por
//   `attempts` para no colisionar entre pg_net y el worker, o entre réplicas).
//   El estado FINAL solo se escribe tras el intento real. Si el proceso crashea
//   entre el claim y el envío, el lease expira (2min) y el worker retoma la fila
//   (attempts ya incrementado). Idempotente sin doble-envío.
//
// RETRY POR CANAL: si un canal ya tiene _sent > 0 (éxito previo, total o parcial)
// se SALTA en el reintento → no se duplica en fallos parciales.

import { supabase } from '../config/supabase';
import { sendToUser as sendNativePush } from './push.service';
import { sendWebPushToUser, type WebPushPayload } from './webpush.service';

const LEASE_MS = 2 * 60 * 1000;

// Categorías de seguridad/sistema: SIEMPRE se envían (ignoran todos los toggles).
const SECURITY_CATEGORIES = new Set(['system']);
// Categorías de marketing: además del toggle global de push, respetan el de marketing.
const MARKETING_CATEGORIES = new Set(['marketing']);

interface DeliveryRow {
    id: string;
    notification_id: string;
    user_id: string;
    status: string;
    attempts: number;
    max_attempts: number;
    next_attempt_at: string;
    web_sent: number;
    web_failed: number;
    native_sent: number;
    native_failed: number;
    revoked: number;
}

const CLAIMABLE = ['pending', 'failed'];

/** next_attempt_at de una fila que ya no se reintenta. La columna es
 *  timestamptz NOT NULL, así que no puede ir NULL: 'infinity' la saca para
 *  siempre del `lte(next_attempt_at, now)` del worker y del índice de drenaje.
 *  (new Date('infinity') es NaN → isClaimable la descarta también.) */
export const NEVER_RETRY = 'infinity';

/** Empuja el lease (+2min) y attempts++ con guard optimista. Devuelve la fila
 *  reclamada, o null si otro proceso la reclamó primero. */
async function leaseRow(row: DeliveryRow): Promise<DeliveryRow | null> {
    const lease = new Date(Date.now() + LEASE_MS).toISOString();
    const { data } = await supabase
        .from('notification_deliveries')
        .update({ attempts: row.attempts + 1, next_attempt_at: lease })
        .eq('id', row.id)
        .eq('attempts', row.attempts) // guard: nadie más incrementó en el medio
        .select('*')
        .maybeSingle();
    return (data as DeliveryRow) ?? null;
}

function isClaimable(row: DeliveryRow): boolean {
    return (
        CLAIMABLE.includes(row.status) &&
        row.attempts < row.max_attempts &&
        new Date(row.next_attempt_at).getTime() <= Date.now()
    );
}

/** Claim dirigido por notification_id (lo usa el endpoint que dispara pg_net). */
export async function claimByNotificationId(notificationId: string): Promise<DeliveryRow | null> {
    const { data: row } = await supabase
        .from('notification_deliveries')
        .select('*')
        .eq('notification_id', notificationId)
        .maybeSingle();
    if (!row || !isClaimable(row as DeliveryRow)) return null;
    return leaseRow(row as DeliveryRow);
}

/** Claim de una fila candidata ya leída (lo usa el worker del batch). */
export async function claimRow(row: DeliveryRow): Promise<DeliveryRow | null> {
    if (!isClaimable(row)) return null;
    return leaseRow(row);
}

/** Backoff exponencial acotado (min) según intentos ya realizados. */
function backoffIso(attempts: number): string {
    const ladder = [5, 30, 120, 360]; // 5m, 30m, 2h, 6h
    const mins = ladder[Math.min(attempts - 1, ladder.length - 1)] ?? 360;
    return new Date(Date.now() + mins * 60_000).toISOString();
}

/** ¿Se permite push a este usuario para esta categoría?
 *  - system/seguridad → SIEMPRE (ignora todos los toggles).
 *  - resto → respeta el toggle global `push_notifications`.
 *  - marketing → además respeta `marketing_emails`. */
async function resolvePushAllowed(userId: string, category: string | null): Promise<boolean> {
    if (category && SECURITY_CATEGORIES.has(category)) return true;

    const { data } = await supabase
        .from('profiles')
        .select('preferences')
        .eq('id', userId)
        .maybeSingle();

    const prefs = (data?.preferences ?? {}) as Record<string, unknown>;

    if (prefs.push_notifications === false) return false; // toggle global de push
    if (category && MARKETING_CATEGORIES.has(category) && prefs.marketing_emails === false) return false;
    return true;
}

interface NotificationRow {
    user_id: string;
    category: string | null;
    title: string;
    message: string;
    link: string | null;
    data: Record<string, unknown> | null;
}

function buildWebPayload(n: NotificationRow): WebPushPayload {
    return {
        title: n.title,
        body: n.message,
        url: n.link || '/',
        type: n.category || 'default',
        data: n.data || {},
    };
}

/** FCM `data` debe ser Record<string,string>. Convierte valores no-string. */
function buildNativeData(n: NotificationRow): Record<string, string> {
    const out: Record<string, string> = {
        type: String(n.category || 'default'),
        url: String(n.link || '/'),
    };
    const src = n.data && typeof n.data === 'object' ? n.data : {};
    for (const [k, v] of Object.entries(src)) {
        if (v == null) continue;
        out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
}

async function finalize(
    row: DeliveryRow,
    patch: {
        status: 'sent' | 'failed' | 'skipped';
        wSent?: number; wFail?: number;
        nSent?: number; nFail?: number;
        rev?: number; lastError?: string | null;
    },
): Promise<void> {
    const update: Record<string, unknown> = {
        status: patch.status,
        web_sent: row.web_sent + (patch.wSent ?? 0),
        web_failed: row.web_failed + (patch.wFail ?? 0),
        native_sent: row.native_sent + (patch.nSent ?? 0),
        native_failed: row.native_failed + (patch.nFail ?? 0),
        revoked: row.revoked + (patch.rev ?? 0),
        last_error: patch.lastError ?? null,
    };
    // Solo reprogramamos si va a reintentarse. 'sent'/'skipped' son terminales.
    // Un 'failed' que ya agotó intentos (row.attempts viene incrementado por el
    // lease) tampoco se reintenta: antes se le ponía backoff igual y esas filas
    // volvían a encabezar la cola para siempre (cola atascada desde 2026-07,
    // ver docs/migraciones-pendientes-2026-10-27/LEEME.md).
    if (patch.status === 'failed') {
        update.next_attempt_at = row.attempts >= row.max_attempts
            ? NEVER_RETRY
            : backoffIso(row.attempts);
    }
    await supabase.from('notification_deliveries').update(update).eq('id', row.id);
}

/**
 * Entrega una fila del outbox ya reclamada (con lease vigente). Contempla:
 *   - preferencias (skip → 'skipped')
 *   - retry por canal (salta canales con _sent previo > 0)
 *   - estado final: 'sent' si ambos canales quedan resueltos; si no, 'failed'
 *     con backoff (el worker reintentará hasta max_attempts).
 */
export async function dispatchDelivery(row: DeliveryRow): Promise<void> {
    const { data: n } = await supabase
        .from('notifications')
        .select('user_id, category, title, message, link, data')
        .eq('id', row.notification_id)
        .maybeSingle();

    if (!n) {
        await finalize(row, { status: 'skipped', lastError: 'notification_missing' });
        return;
    }
    const notif = n as NotificationRow;

    if (!(await resolvePushAllowed(notif.user_id, notif.category))) {
        await finalize(row, { status: 'skipped', lastError: 'prefs_opt_out' });
        return;
    }

    let wSent = 0, wFail = 0, nSent = 0, nFail = 0, rev = 0;
    const errors: string[] = [];

    // Web Push — solo si el canal no tuvo éxito previo.
    if (row.web_sent === 0) {
        const r = await sendWebPushToUser(notif.user_id, buildWebPayload(notif));
        wSent = r.sent; wFail = r.failed; rev += r.revoked;
        if (r.lastError) errors.push(r.lastError);
    }

    // Nativo FCM — solo si el canal no tuvo éxito previo.
    if (row.native_sent === 0) {
        const r = await sendNativePush(notif.user_id, {
            title: notif.title,
            body: notif.message,
            data: buildNativeData(notif),
        });
        nSent = r.sent; nFail = r.failed; rev += r.revoked;
        if (r.reason && r.failed > 0) errors.push(r.reason);
    }

    // Un canal queda "resuelto" si ya tenía éxito previo o no falló este intento.
    const webResolved = row.web_sent > 0 || wFail === 0;
    const nativeResolved = row.native_sent > 0 || nFail === 0;
    const status: 'sent' | 'failed' = webResolved && nativeResolved ? 'sent' : 'failed';

    await finalize(row, {
        status, wSent, wFail, nSent, nFail, rev,
        lastError: errors.length ? errors.join('; ') : null,
    });
}
