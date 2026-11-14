// bff/src/jobs/notifications-dispatch.job.ts
//
// Worker (red de seguridad) del despachador unificado. Drena el outbox
// `notification_deliveries`: filas pending/failed cuyo lease ya venció
// (next_attempt_at <= now) y que no agotaron intentos.
//
// Cubre: (a) fallos de pg_net / BFF caído, (b) reintentos con backoff,
// (c) CRASH entre claim y envío (el lease de 2min expira y aquí se retoma).
//
// try/catch POR FILA: una fila que explota no tumba el resto del lote.
// Corre cada minuto (node-cron) desde initMaintenanceJobs.
//
// COLA ATASCADA (2026-07 → 2026-10-27): el filtro attempts < max_attempts es
// columna-vs-columna y PostgREST no lo expresa, así que se aplicaba en memoria
// con un `continue`. Como finalize() además reprogramaba las 'failed' agotadas,
// 62 filas 5/5 de julio encabezaban SIEMPRE el lote de 50 (orden por
// next_attempt_at) y el worker nunca llegaba a nada nuevo. Ahora:
//   · finalize() deja las agotadas en next_attempt_at = 'infinity';
//   · si igual aparece una agotada (filas viejas, o crash entre el lease del
//     último intento y el finalize), el worker la ESTACIONA ('infinity', con
//     guard por attempts) y vuelve a leer, hasta MAX_ROUNDS lecturas por corrida.
// Sin RPC de claim nueva: con 'infinity' el propio lte() del query ya excluye
// las agotadas, y el índice (status, next_attempt_at) sigue sirviendo.

import { supabase } from '../config/supabase';
import { claimRow, dispatchDelivery, NEVER_RETRY } from '../services/notification.service';

const BATCH = 50;
const MAX_ROUNDS = 5;

export async function runNotificationDispatch(): Promise<{ claimed: number; failed: number; parked: number }> {
    // Gate de despliegue (idéntico al endpoint): apagado → no-op.
    if (process.env.NOTIF_DISPATCH_ENABLED !== 'true') return { claimed: 0, failed: 0, parked: 0 };

    let claimed = 0;
    let failed = 0;
    let parked = 0;

    for (let round = 0; round < MAX_ROUNDS; round++) {
        const nowIso = new Date().toISOString();
        const { data: candidates, error } = await supabase
            .from('notification_deliveries')
            .select('*')
            .in('status', ['pending', 'failed'])
            .lte('next_attempt_at', nowIso)
            .order('next_attempt_at', { ascending: true })
            .limit(BATCH);

        if (error) {
            // Antes este error se tragaba en silencio y el worker parecía "sin trabajo".
            console.error('[notif-dispatch] no se pudo leer la cola:', error.message || error);
            break;
        }
        if (!candidates || candidates.length === 0) break;

        let parkedThisRound = 0;
        for (const c of candidates as any[]) {
            if (c.attempts >= c.max_attempts) {
                // Agotada: se estaciona para que no vuelva a encabezar el lote.
                const { error: parkErr } = await supabase
                    .from('notification_deliveries')
                    .update({ next_attempt_at: NEVER_RETRY })
                    .eq('id', c.id)
                    .eq('attempts', c.attempts); // no pisar un claim concurrente
                if (parkErr) {
                    console.warn('[notif-dispatch] no se pudo estacionar fila agotada:', { id: c.id, err: parkErr.message });
                } else {
                    parkedThisRound++;
                }
                continue;
            }
            try {
                const leased = await claimRow(c); // lease optimista; null si otro lo tomó
                if (!leased) continue;
                claimed++;
                await dispatchDelivery(leased);
            } catch (err: any) {
                failed++;
                console.warn('[notif-dispatch] fila falló (se reintentará tras el lease):', {
                    id: c.id, err: err?.message || err,
                });
            }
        }
        parked += parkedThisRound;

        // Solo se vuelve a leer si este lote estaba tapado por agotadas: lo que
        // se reclamó ya no sale (lease al futuro) y el resto lo toma el próximo minuto.
        if (parkedThisRound === 0) break;
    }

    if (claimed > 0 || failed > 0 || parked > 0) {
        console.log(`[notif-dispatch] claimed=${claimed} failed=${failed} parked=${parked}`);
    }
    return { claimed, failed, parked };
}
