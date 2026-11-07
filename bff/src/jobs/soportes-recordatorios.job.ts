/**
 * soportes-recordatorios.job — recuerda a las familias que deben soportes del deportista (spec
 * docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §6b, F6).
 *
 * Una vez al día (10:00 America/Bogota por defecto):
 *   1. UNA consulta: las escuelas con `require_athlete_documents = true` (hoy solo Monster).
 *   2. Por escuela, UN lote: `soportes_estado_interno(escuela)` (todos los deportistas de la escuela con lo que
 *      falta; sin N+1).
 *   3. `soportes_reclamar_avisos` aplica el tope EN LA BASE y en una sola sentencia (cada 4 días, máximo 6
 *      avisos por deportista; idempotente entre los 3 BFF que comparten base).
 *   4. Un solo INSERT en `public.notifications` por escuela con service role: el despachador de notificaciones
 *      lo convierte en push / in-app (y WhatsApp donde la escuela lo tenga). Una cuenta con varios hijos recibe
 *      UN aviso. Sin lenguaje de cobro ni de mora (regla de Monster).
 *
 * Solo llega a quien tiene CUENTA (acudiente del hijo o adulto). Las fichas sin cuenta (la mayoría de los
 * deportistas de Monster) no tienen a quién notificar aquí: las cubre el recordatorio por WhatsApp del bot (que
 * puede leer `soportes_estado_interno` y usar `soportes_reclamar_avisos` con el mismo tope) y el informe «Soportes
 * pendientes» de la administración. Por eso NO se reclama el aviso de quien no tiene cuenta: el cupo se gasta solo
 * cuando de verdad se manda algo.
 *
 * Solo arranca en Render (`debenCorrerLosCrons`) y respeta DISABLE_SOPORTES_CRON y CRONS_ENABLED=false.
 * Hora configurable: SOPORTES_CRON_HORA (0-23, def. 10).
 *
 * MONTAJE (no está en index.ts): `import { iniciarSoportesRecordatoriosCron } from './jobs/soportes-recordatorios.job';`
 * y llamarla donde se llaman las demás dentro del `if (debenCorrerLosCrons())`.
 */

import cron from 'node-cron';
import * as Sentry from '@sentry/node';
import { supabase } from '../config/supabase';
import { debenCorrerLosCrons } from './crons-solo-en-render';
import {
    agruparAvisos, AVISO_CADA_DIAS, AVISO_MAXIMO, estadoInterno, textoAviso, type FilaEstado,
} from '../services/soportes.service';

export interface ResultadoSoportes {
    escuelas: number;
    deportistasIncompletos: number;
    sinCuenta: number;
    reclamados: number;
    avisos: number;
    errores: number;
}

export interface OpcionesSoportes { dryRun?: boolean; cadaDias?: number; maximo?: number }

/** Avisos de UNA escuela. Separado para probarlo con la base simulada. */
export async function avisarEscuela(schoolId: string, opts: OpcionesSoportes = {}): Promise<Omit<ResultadoSoportes, 'escuelas' | 'errores'>> {
    const filas: FilaEstado[] = await estadoInterno(schoolId);
    const incompletos = filas.filter((f) => !f.complete && f.missing.length > 0);
    const conCuenta = incompletos.filter((f) => !!f.notify_profile_id);
    const base = { deportistasIncompletos: incompletos.length, sinCuenta: incompletos.length - conCuenta.length };
    if (conCuenta.length === 0) return { ...base, reclamados: 0, avisos: 0 };

    if (opts.dryRun) {
        return { ...base, reclamados: conCuenta.length, avisos: agruparAvisos(conCuenta).length };
    }

    const { data, error } = await supabase.rpc('soportes_reclamar_avisos', {
        p_school_id: schoolId,
        p_sujetos: conCuenta.map((f) => ({ subject_type: f.subject_type, subject_id: f.subject_id })),
        p_cada_dias: opts.cadaDias ?? AVISO_CADA_DIAS,
        p_maximo: opts.maximo ?? AVISO_MAXIMO,
    });
    if (error) throw new Error(`soportes_reclamar_avisos: ${error.code ?? ''} ${error.message}`);

    const reclamados = new Set(((data as any[]) ?? []).map((r) => `${r.subject_type}:${r.subject_id}`));
    const aMandar = conCuenta.filter((f) => reclamados.has(`${f.subject_type}:${f.subject_id}`));
    if (aMandar.length === 0) return { ...base, reclamados: 0, avisos: 0 };

    const avisos = agruparAvisos(aMandar);
    const { error: errIns } = await supabase.from('notifications').insert(avisos.map((a) => {
        const t = textoAviso(a);
        return {
            user_id: a.profileId,
            school_id: schoolId,
            type: 'soportes_pendientes',
            category: 'enrollment',
            title: t.titulo,
            message: t.mensaje,
            link: a.esHijo ? '/children' : '/dashboard',
            data: { soportes: a.deportistas.map((d) => ({ nombre: d.nombre, faltan: d.faltan })) },
        };
    }));
    if (errIns) throw new Error(`notifications: ${errIns.message}`);
    return { ...base, reclamados: aMandar.length, avisos: avisos.length };
}

export async function runSoportesRecordatorios(opts: OpcionesSoportes = {}): Promise<ResultadoSoportes> {
    const total: ResultadoSoportes = { escuelas: 0, deportistasIncompletos: 0, sinCuenta: 0, reclamados: 0, avisos: 0, errores: 0 };

    const { data, error } = await supabase.from('school_settings').select('school_id').eq('require_athlete_documents', true);
    if (error) {
        // Columna aún no migrada (42703): ninguna escuela lo tiene prendido. No es un fallo.
        if (error.code === '42703' || error.code === 'PGRST204') return total;
        throw new Error(`school_settings: ${error.message}`);
    }

    for (const s of (data ?? []) as { school_id: string }[]) {
        total.escuelas += 1;
        try {
            const r = await avisarEscuela(s.school_id, opts);
            total.deportistasIncompletos += r.deportistasIncompletos;
            total.sinCuenta += r.sinCuenta;
            total.reclamados += r.reclamados;
            total.avisos += r.avisos;
        } catch (err: any) {
            total.errores += 1;
            Sentry.captureException(err);
            console.error('[CRON] soportes — falló una escuela:', s.school_id, err?.message || err);
        }
    }
    return total;
}

export function expresionCron(env: NodeJS.ProcessEnv = process.env): string {
    const hora = Number(env.SOPORTES_CRON_HORA);
    const h = Number.isInteger(hora) && hora >= 0 && hora <= 23 ? hora : 10;
    return `0 ${h} * * *`;
}

export function iniciarSoportesRecordatoriosCron(): void {
    if (!debenCorrerLosCrons()) return;
    if (process.env.CRONS_ENABLED === 'false') return;
    if (process.env.DISABLE_SOPORTES_CRON === 'true') {
        console.log('[CRON] Recordatorios de soportes APAGADOS (DISABLE_SOPORTES_CRON=true).');
        return;
    }
    const expr = expresionCron();
    cron.schedule(expr, async () => {
        if (process.env.DISABLE_SOPORTES_CRON === 'true') return;
        try {
            const r = await runSoportesRecordatorios();
            console.log(`[CRON] Soportes: escuelas=${r.escuelas} incompletos=${r.deportistasIncompletos} sinCuenta=${r.sinCuenta} `
                + `reclamados=${r.reclamados} avisos=${r.avisos} errores=${r.errores}`);
        } catch (err: any) {
            Sentry.captureException(err);
            console.error('[CRON] Error en recordatorios de soportes:', err?.message || err);
        }
    }, { timezone: 'America/Bogota' });
    console.log(`[CRON] Recordatorios de soportes registrados (${expr}, America/Bogota; solo escuelas con el flag prendido).`);
}
