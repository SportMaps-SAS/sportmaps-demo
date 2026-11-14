import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Radio, Trophy } from 'lucide-react';
import { formatBogota } from '@/lib/tournamentDisplay';
import type { TodayMatch } from './liveApi';

/** «Hoy juega tu hija Sofía», «Hoy juegas», «Hoy juegan Sofía y Tomás». */
export function quienJuega(who: TodayMatch['who']): string {
  if (who.length === 0) return 'Hoy hay partido';
  if (who.length === 1) {
    const w = who[0];
    if (w.relation === 'self') return 'Hoy juegas';
    if (w.relation === 'hija') return `Hoy juega tu hija ${w.first_name}`.trim();
    if (w.relation === 'hijo') return `Hoy juega tu hijo ${w.first_name}`.trim();
    return `Hoy juega ${w.first_name}`.trim();
  }
  const names = who.map((w) => (w.relation === 'self' ? 'tú' : w.first_name)).filter(Boolean);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}` : names[0];
  return `Hoy juegan ${list}`;
}

export function lineaPartido(m: TodayMatch): string {
  const vs = `${m.home_name ?? 'Por definir'} vs ${m.away_name ?? 'Por definir'}`;
  const hora = m.scheduled_at ? formatBogota(m.scheduled_at) : null;
  return [vs, m.court, m.status === 'live' ? 'En juego' : hora].filter(Boolean).join(' · ');
}

export const todayQueryKey = (userId: string | undefined) => ['tournament-live', 'today', userId ?? 'anon'];

/**
 * Tarjeta del Inicio V2 (acudiente y deportista): los partidos de HOY de los equipos de la familia.
 * No muestra nada si no hay partidos (ni mientras carga, ni si falla: no es información crítica).
 */
export function HoyJuegaCard({ userId }: { userId: string | undefined }) {
  const q = useQuery({
    queryKey: todayQueryKey(userId),
    // Import diferido: el Inicio no arrastra el cliente de torneos hasta que hace falta.
    queryFn: () => import('./liveApi').then((m) => m.liveApi.today()),
    enabled: !!userId,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const matches = (q.data?.matches ?? []).filter((m) => m.status !== 'played').slice(0, 3);
  if (matches.length === 0) return null;
  return (
    <section aria-label="Hoy hay partido" className="flex flex-col gap-2" data-testid="hoy-juega">
      {matches.map((m) => {
        const live = m.status === 'live';
        const href = m.slug ? `/torneo/${m.slug}/en-vivo` : null;
        const body = (
          <div className={`flex items-center gap-3 rounded-2xl border p-4 ${live ? 'border-primary bg-primary/5' : 'bg-card'}`}>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              {live ? <Radio className="h-5 w-5" aria-hidden /> : <Trophy className="h-5 w-5" aria-hidden />}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-base font-semibold leading-snug">{quienJuega(m.who)}</span>
              <span className="truncate text-sm text-muted-foreground">{lineaPartido(m)}</span>
              <span className="truncate text-xs text-muted-foreground">{m.event_title}</span>
            </div>
            {href && <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />}
          </div>
        );
        return href
          ? <Link key={m.match_id} to={href} className="rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${quienJuega(m.who)}: ${lineaPartido(m)}. Ver en vivo`}>{body}</Link>
          : <div key={m.match_id}>{body}</div>;
      })}
    </section>
  );
}

export default HoyJuegaCard;
