/**
 * referidos.job — trabajo diario de referidos (spec campanas-descuento-referidos §4.2 paso 3 y 5).
 *
 * Una vez al día (06:30 COT), UN lote por escuela con la campaña activa:
 *   1) `qualify_enrollment_referrals(school)` pasa 'pendiente' → 'ganado' los referidos que pagaron su
 *      primera mensualidad, fija el mes de aplicación (mes siguiente al pago o el primer mes libre),
 *      anula los de referidos que se retiraron sin pagar y vence los que llevan demasiado esperando.
 *      Toda la lectura es en lote dentro de la RPC (joins / ANY): jamás una consulta por fila.
 *   2) Avisa a quien refiere («¡Ganaste 50 % en tu mensualidad de diciembre por referir a X!») con UN
 *      insert en lote en `notifications` (service_role). Cada aviso lleva `data.clave` estable
 *      `referido-ganado:<id>` y se lee en UNA consulta para no repetir.
 *
 * Costo por corrida: 1 consulta de campañas activas + 1 RPC por escuela con campaña + 1 select de
 * claves ya avisadas + 1 insert. Las escuelas sin campaña activa (todas, salvo las que la prendan) no
 * cuestan nada.
 *
 * Idempotencia entre los 3 BFF (comparten base; aun así los crons solo corren en Render): la RPC toma un
 * advisory lock por escuela y solo califica filas todavía 'pendiente'; el aviso se deduplica por clave.
 *
 * REGISTRO (NO se hizo aquí; lo agrega quien integre, junto a los demás crons de bff/src/index.ts):
 *   import { iniciarReferidosCron } from './jobs/referidos.job';
 *   ...
 *   if (debenCorrerLosCrons()) { ...; iniciarReferidosCron(); }
 * Kill-switch de este proceso: DISABLE_REFERIDOS_CRON=true.
 */
import cron from 'node-cron';
import * as Sentry from '@sentry/node';
import { supabase } from '../config/supabase';
import { debenCorrerLosCrons } from './crons-solo-en-render';
import {
    avisoGanado, calificarReferidos, claveAvisoGanado, type GanadoDetalle,
} from '../services/referidos.service';

const TIPO = 'referral_won';
const LINK = '/my-payments';
const VENTANA_AVISOS_DIAS = 400;

export interface ResultadoReferidosJob {
    escuelas: number;
    ganados: number;
    anulados: number;
    vencidos: number;
    avisados: number;
    errores: number;
}

interface LogLike { info?: (...a: any[]) => void; warn?: (...a: any[]) => void; error?: (...a: any[]) => void }

export async function runReferidosJob(log: LogLike = console): Promise<ResultadoReferidosJob> {
    const res: ResultadoReferidosJob = { escuelas: 0, ganados: 0, anulados: 0, vencidos: 0, avisados: 0, errores: 0 };

    // 1 consulta: escuelas con campaña activa.
    const { data: campanas, error } = await supabase
        .from('school_discount_campaigns')
        .select('school_id')
        .eq('kind', 'referral')
        .eq('active', true);
    if (error) {
        // Migración aún no aplicada en este ambiente: nada que hacer.
        if (error.code === '42P01' || error.code === 'PGRST205') return res;
        throw new Error(`school_discount_campaigns: ${error.message}`);
    }
    const escuelas = [...new Set(((campanas ?? []) as Array<{ school_id: string }>).map((c) => c.school_id))];
    res.escuelas = escuelas.length;
    if (!escuelas.length) return res;

    // Un lote por escuela.
    const ganados: Array<GanadoDetalle & { school_id: string }> = [];
    for (const schoolId of escuelas) {
        try {
            const r = await calificarReferidos(schoolId);
            res.ganados += r.ganados;
            res.anulados += r.anulados;
            res.vencidos += r.vencidos;
            for (const d of r.detalle ?? []) ganados.push({ ...d, school_id: schoolId });
        } catch (err: any) {
            res.errores++;
            log.warn?.({ schoolId, err: err?.message }, '[referidos] no se pudo calificar la escuela');
        }
    }

    // Avisos en lote (solo a quien refiere y tiene cuenta).
    const conDestino = ganados.filter((g) => !!g.referrer_user_id);
    if (conDestino.length) {
        const yaAvisados = new Set<string>();
        const desde = new Date(Date.now() - VENTANA_AVISOS_DIAS * 86_400_000).toISOString();
        const { data: previos } = await supabase.from('notifications')
            .select('data')
            .in('school_id', escuelas).eq('type', TIPO).gte('created_at', desde);
        for (const n of (previos ?? []) as any[]) if (n?.data?.clave) yaAvisados.add(n.data.clave as string);

        const filas = conDestino
            .filter((g) => !yaAvisados.has(claveAvisoGanado(g.referral_id)))
            .map((g) => {
                const aviso = avisoGanado(g);
                return {
                    user_id: g.referrer_user_id,
                    school_id: g.school_id,
                    title: aviso.titulo,
                    message: aviso.mensaje,
                    type: TIPO,
                    category: 'payment',
                    link: LINK,
                    data: { clave: claveAvisoGanado(g.referral_id), referral_id: g.referral_id, apply_year: g.apply_year, apply_month: g.apply_month },
                };
            });
        if (filas.length) {
            const { error: errIns } = await supabase.from('notifications').insert(filas);
            if (errIns) {
                res.errores++;
                log.warn?.({ err: errIns.message }, '[referidos] no se pudieron guardar los avisos');
            } else {
                res.avisados = filas.length;
            }
        }
    }
    return res;
}

export function iniciarReferidosCron(): void {
    if (!debenCorrerLosCrons()) return;
    if (process.env.CRONS_ENABLED === 'false') return;
    if (process.env.DISABLE_REFERIDOS_CRON === 'true') {
        console.log('[CRON] Referidos APAGADO (DISABLE_REFERIDOS_CRON=true).');
        return;
    }
    // 06:30 COT: antes del cierre de mes diario y del estado de cuenta (8:00).
    cron.schedule('30 6 * * *', async () => {
        if (process.env.DISABLE_REFERIDOS_CRON === 'true') return;
        try {
            const r = await runReferidosJob();
            console.log(`[CRON] Referidos: escuelas=${r.escuelas} ganados=${r.ganados} anulados=${r.anulados} vencidos=${r.vencidos} avisados=${r.avisados} errores=${r.errores}`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en referidos:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });
    console.log('[CRON] Referidos registrado (06:30 COT; solo escuelas con campaña activa).');
}
