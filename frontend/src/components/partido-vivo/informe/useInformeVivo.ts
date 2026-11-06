import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { mapaMinutosVivo, type LiveReportData } from './informeModel';

const db = supabase as any;

/** school_settings.live_match_enabled (apagado por defecto; si la columna aún no existe → false). */
export function useLiveMatchEnabled(schoolId: string | null | undefined): boolean {
  const q = useQuery({
    queryKey: ['live-match-enabled', schoolId],
    enabled: !!schoolId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await db.from('school_settings').select('live_match_enabled').eq('school_id', schoolId).maybeSingle();
      if (error) return false;
      return data?.live_match_enabled === true;
    },
  });
  return q.data === true;
}

/** Datos del informe en vivo (match_live_report). null si el partido no se jugó en vivo (LIVE_NOT_STARTED) o hay error. */
export function useLiveReport(matchId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['live-report', matchId],
    enabled: enabled && !!matchId,
    queryFn: async (): Promise<LiveReportData | null> => {
      const { data, error } = await db.rpc('match_live_report', { p_match: matchId });
      if (error) return null;
      return (data ?? null) as LiveReportData | null;
    },
  });
}

/** Minutos del paso Evaluar: del informe en vivo cuando el flag está encendido y el partido tiene registro; si no, null. */
export function useMinutosVivo(matchId: string, schoolId: string): Map<string, number> | null {
  const on = useLiveMatchEnabled(schoolId);
  const q = useLiveReport(matchId, on);
  if (!on || !q.data) return null;
  return mapaMinutosVivo(q.data);
}
