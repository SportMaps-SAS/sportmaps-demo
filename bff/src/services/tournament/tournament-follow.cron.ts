/**
 * Recordatorio «Tu partido empieza en 15 min» — cada 5 min, ventana [+10, +20) min.
 * Cada partido cae en dos corridas; la marca `tournament_match_notices` evita el doble aviso.
 *   · Solo arranca en Render (`debenCorrerLosCrons`, lo decide index.ts).
 *   · DISABLE_TOURNAMENT_REMINDERS_CRON=true lo apaga sin desplegar (dev y stg lo deben tener).
 *   · Una consulta indexada por corrida (idx_tmatches_scheduled_pendientes); si no hay partidos, nada más.
 */
import cron from 'node-cron';
import { runStartingSoonReminders } from './tournament-follow.service';

export function iniciarRecordatoriosTorneoCron(): void {
  if (process.env.DISABLE_TOURNAMENT_REMINDERS_CRON === 'true') {
    console.log('[CRON] Recordatorios de torneo APAGADOS (DISABLE_TOURNAMENT_REMINDERS_CRON=true).');
    return;
  }
  let running = false;
  cron.schedule('*/5 * * * *', async () => {
    if (process.env.DISABLE_TOURNAMENT_REMINDERS_CRON === 'true' || running) return;
    running = true;
    try {
      const r = await runStartingSoonReminders();
      if (r.sent > 0) console.log(`[CRON] Recordatorios de torneo: ${r.matches} partidos, ${r.sent} avisos.`);
    } catch (e: any) {
      console.warn('[CRON] Recordatorios de torneo falló:', e?.message);
    } finally { running = false; }
  }, { timezone: 'America/Bogota' });
}
